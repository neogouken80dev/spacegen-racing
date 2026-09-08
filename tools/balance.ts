/**
 * The balance gate (GDD Phase 2).
 *
 * Runs a large batch of headless all-AI races on Rustfall and reports the
 * numbers a designer actually needs: per-chassis win share, finish position and
 * best lap, lead retention, race churn, item pickup/fire/hit counts, the drift
 * tier distribution, lap-time spread and Alpha Missile effectiveness.
 *
 * Two hard assertions (with --assert):
 *   - every chassis lands inside a 12-30% win share
 *   - lead retention (leader at the final-lap marker wins) lands in 45-55%
 *
 * Confound control:
 *   - Chassis-to-grid assignment is reshuffled every race. The 8-entry lineup
 *     cycles so that across any block of 5 races each of the 5 chassis gets
 *     exactly 8 entries, and the Fisher-Yates shuffle spreads those entries
 *     evenly over the 8 grid slots. Per-slot win share is reported so the
 *     control can be verified rather than assumed.
 *   - AI skill bands are shuffled independently, so skill is uncorrelated with
 *     both chassis and grid slot.
 *   - Every race gets its own seed.
 *
 * Fan-out: `node:worker_threads`, one worker per core. Results do not depend on
 * the worker count -- every race's seed and lineup derive from its global index.
 *
 * Usage:  npm run balance -- --races=2000 --assert
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import * as os from 'node:os'
import * as fs from 'node:fs'
import { Race } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { TRACKS_BY_ID, RUSTFALL } from '../src/content/tracks'
import { CHASSIS, CHASSIS_BY_ID } from '../src/content/chassis'
import { PILOTS } from '../src/content/pilots'
import { resetAI } from '../src/sim/ai'
import { ITEM_ORDER } from '../src/content/items'
import { Rng } from '../src/sim/rng'
import { TUNING } from '../src/content/tuning'
import type { ItemId, SimConfig, RacerState } from '../src/sim/types'

// ---------------------------------------------------------------------------
// Gate thresholds. tests/balance.test.ts imports these.
// ---------------------------------------------------------------------------

export const GATE = {
  winShareMin: 0.12,
  winShareMax: 0.30,
  leadRetentionMin: 0.45,
  leadRetentionMax: 0.55,
  /** Below this share of drifts, Tier 3 (Singularity) is effectively unreachable. */
  tier3MinShare: 0.01,
  lapTargetMin: 55,
  lapTargetMax: 75,
  /**
   * Races allowed to hit the frame cap. Measured baseline is 0.55% (11 of
   * 2000): two racers wedge against an outer wall at ~1.03x half-width, which
   * is inside offTrack.edgeTolerance, so the off-track respawn watchdog never
   * fires and the pair never moves again -- the race never reaches 'finished'.
   * That is a sim bug (see the report), not a tuning one, so the bar is set to
   * catch a regression rather than to block on the known baseline.
   */
  maxDnfRate: 0.01,
} as const

export interface BalanceOptions {
  races: number
  laps: number
  racerCount: number
  seed: number
  /** Fixed AI skill for every racer, or null for the shipped mixed field. */
  fixedSkill: number | null
  maxFrames: number
  /**
   * Temporary TUNING overrides for a sweep, as dotted paths into the tuning
   * tree: { 'drift.arcBase': 1.6 }. Applied in runBatch so the worker threads
   * -- which import their own copy of the module -- get them too. This exists
   * so a balance sweep never has to edit tuning.ts between runs and risk
   * shipping a probe value; nothing in the game reads it.
   */
  tune?: Record<string, number>
  /** Track id to race on. Defaults to Rustfall. */
  trackId?: string
}

export const DEFAULT_OPTIONS: BalanceOptions = {
  races: 2000,
  laps: 3,
  racerCount: 8,
  seed: 0x5eed_1234,
  fixedSkill: null,
  maxFrames: 60 * 420,
}

const NC = CHASSIS.length
const NI = ITEM_ORDER.length
const ITEM_INDEX: Record<string, number> = Object.fromEntries(ITEM_ORDER.map((id, i) => [id, i]))
const CHASSIS_INDEX: Record<string, number> = Object.fromEntries(CHASSIS.map((c, i) => [c.id, i]))

/** Lap-time histogram: 1s buckets covering 20s..170s. */
const HIST_LO = 20
const HIST_N = 150

// ---------------------------------------------------------------------------
// Aggregate. Every field is additive so workers can merge trivially.
// ---------------------------------------------------------------------------

export interface Agg {
  races: number
  finishedRaces: number
  frames: number
  wallMs: number

  entries: number[]        // per chassis
  wins: number[]
  podiums: number[]
  posSum: number[]
  finishTimeSum: number[]
  finishTimeN: number[]
  bestLapSum: number[]
  bestLapN: number[]
  lapSum: number[]
  lapN: number[]
  respawns: number[]

  slotEntries: number[]    // per grid slot
  slotWins: number[]
  skillEntries: number[]   // per AI skill band
  skillWins: number[]

  leadRaces: number
  leadHeld: number

  overtakes: number        // 2 Hz sampled, position gains only
  overtakesRaw: number     // per-frame, position gains only

  boxTouches: number
  boxWasted: number
  pickups: number[]        // per ITEM_ORDER index
  fires: number[]
  hits: number[]

  driftEnds: number
  driftTiers: number[]     // [no tier, T0, T1, T2, T3]
  /** Same buckets, per chassis: index ci * 5 + tier. */
  driftTiersByChassis: number[]
  wallHits: number[]       // per chassis
  offTrackFrames: number[] // per chassis
  driveFrames: number[]    // per chassis, frames spent still racing
  boostFrames: number[]    // per chassis, frames with any boost active
  airFrames: number[]      // per chassis, frames not grounded

  alphaFires: number
  alphaHits: number
  alphaHitsOnLeader: number

  lapCount: number
  lapTimeSum: number
  lapTimeSumSq: number
  lapMin: number
  lapMax: number
  lapHist: number[]
}

function zeros(n: number): number[] { return new Array(n).fill(0) }

export function emptyAgg(): Agg {
  return {
    races: 0, finishedRaces: 0, frames: 0, wallMs: 0,
    entries: zeros(NC), wins: zeros(NC), podiums: zeros(NC), posSum: zeros(NC),
    finishTimeSum: zeros(NC), finishTimeN: zeros(NC),
    bestLapSum: zeros(NC), bestLapN: zeros(NC), lapSum: zeros(NC), lapN: zeros(NC),
    respawns: zeros(NC),
    slotEntries: zeros(8), slotWins: zeros(8), skillEntries: zeros(5), skillWins: zeros(5),
    leadRaces: 0, leadHeld: 0,
    overtakes: 0, overtakesRaw: 0,
    boxTouches: 0, boxWasted: 0,
    pickups: zeros(NI), fires: zeros(NI), hits: zeros(NI),
    driftEnds: 0, driftTiers: zeros(5),
    driftTiersByChassis: zeros(NC * 5), wallHits: zeros(NC), offTrackFrames: zeros(NC),
    driveFrames: zeros(NC), boostFrames: zeros(NC), airFrames: zeros(NC),
    alphaFires: 0, alphaHits: 0, alphaHitsOnLeader: 0,
    lapCount: 0, lapTimeSum: 0, lapTimeSumSq: 0,
    lapMin: Infinity, lapMax: 0, lapHist: zeros(HIST_N),
  }
}

export function mergeAgg(a: Agg, b: Agg): Agg {
  const out = a
  for (const k of Object.keys(b) as (keyof Agg)[]) {
    const bv = b[k]
    if (typeof bv === 'number') {
      if (k === 'lapMin') out.lapMin = Math.min(out.lapMin, bv)
      else if (k === 'lapMax') out.lapMax = Math.max(out.lapMax, bv)
      else (out[k] as number) = (out[k] as number) + bv
    } else if (Array.isArray(bv)) {
      const av = out[k] as number[]
      for (let i = 0; i < bv.length; i++) av[i] += bv[i]
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Per-race setup
// ---------------------------------------------------------------------------

/**
 * The 8 chassis entries for race `i`. Five fixed slots plus a rotating trio, so
 * across any block of 5 consecutive races every chassis gets exactly 8 entries.
 */
export function lineupForRace(i: number, racerCount: number): number[] {
  const out: number[] = []
  for (let k = 0; k < racerCount; k++) {
    out.push(k < NC ? k : (i + k - NC) % NC)
  }
  return out
}

function shuffle<T>(arr: T[], rng: Rng): T[] {
  for (let k = arr.length - 1; k > 0; k--) {
    const j = rng.int(k + 1)
    const t = arr[k]; arr[k] = arr[j]; arr[j] = t
  }
  return arr
}

function seedForRace(i: number, base: number): number {
  return (base + Math.imul(i + 1, 0x9e3779b1)) >>> 0
}

export function configForRace(i: number, o: BalanceOptions): SimConfig {
  const n = o.racerCount
  const seed = seedForRace(i, o.seed)
  const setupRng = new Rng((seed ^ 0x51ed270b) >>> 0)

  const lineup = shuffle(lineupForRace(i, n), setupRng)
  // Shipped mixed field: skills 2/3/4 in equal measure, shuffled across slots.
  const skills = o.fixedSkill === null
    ? shuffle(Array.from({ length: n }, (_, k) => 2 + (k % 3)), setupRng)
    : Array.from({ length: n }, () => o.fixedSkill as number)

  return {
    seed,
    totalLaps: o.laps,
    racerCount: n,
    trackId: o.trackId ?? 'rustfall',
    chassisIds: lineup.map((c) => CHASSIS[c].id),
    pilotIds: Array.from({ length: n }, (_, k) => PILOTS[k % PILOTS.length].id),
    localRacerIndex: -1,
    aiSkill: skills,
  }
}

// ---------------------------------------------------------------------------
// One instrumented race
// ---------------------------------------------------------------------------

function simulateRace(track: Track, index: number, o: BalanceOptions, agg: Agg): void {
  const cfg = configForRace(index, o)
  resetAI()
  const race = new Race(track, cfg)
  const s = race.state
  const rs = s.racers
  const n = rs.length

  const prevPos = new Array<number>(n).fill(0)
  const prevItem = new Array<ItemId | null>(n).fill(null)
  const prevSlot2 = new Array<ItemId | null>(n).fill(null)
  const prevRespawn = new Array<number>(n).fill(0)
  let sampledPos = rs.map((r) => r.position)

  let leaderAtMarker = -1
  let frames = 0

  while (frames < o.maxFrames && s.phase !== 'finished') {
    for (let k = 0; k < n; k++) {
      const r = rs[k]
      prevPos[k] = r.position
      prevItem[k] = r.item
      prevSlot2[k] = r.itemSlot2
      prevRespawn[k] = r.respawnTime
    }

    race.step()
    frames++

    for (let k = 0; k < n; k++) {
      const r = rs[k]
      const ci = CHASSIS_INDEX[r.chassisId]

      for (const e of r.events) {
        switch (e.t) {
          case 'pickup': {
            agg.boxTouches++
            let got: ItemId | null = null
            if (prevItem[k] === null && r.item !== null) got = r.item
            else if (prevSlot2[k] === null && r.itemSlot2 !== null) got = r.itemSlot2
            if (got) agg.pickups[ITEM_INDEX[got]]++
            else agg.boxWasted++
            break
          }
          case 'fire': {
            agg.fires[ITEM_INDEX[e.item]]++
            if (e.item === 'alphaMissile') agg.alphaFires++
            break
          }
          case 'hit': {
            agg.hits[ITEM_INDEX[e.item]]++
            if (e.item === 'alphaMissile') {
              agg.alphaHits++
              if (prevPos[k] === 1) agg.alphaHitsOnLeader++
            }
            break
          }
          case 'driftEnd': {
            const t = Math.max(0, Math.min(4, e.tier + 1))
            agg.driftEnds++
            agg.driftTiers[t]++
            agg.driftTiersByChassis[ci * 5 + t]++
            break
          }
          case 'wall': {
            agg.wallHits[ci]++
            break
          }
          default: break
        }
      }

      if (prevRespawn[k] <= 0 && r.respawnTime > 0) agg.respawns[ci]++
      if (!r.finished) {
        agg.driveFrames[ci]++
        if (r.offTrackTime > 0) agg.offTrackFrames[ci]++
        if (r.boostTime > 0) agg.boostFrames[ci]++
        if (!r.grounded) agg.airFrames[ci]++
      }
      if (r.position < prevPos[k]) agg.overtakesRaw++
    }

    if (leaderAtMarker < 0) {
      for (let k = 0; k < n; k++) {
        if (rs[k].position === 1) {
          if (rs[k].lap >= o.laps - 1) leaderAtMarker = rs[k].id
          break
        }
      }
    }

    if (frames % 30 === 0) {
      for (let k = 0; k < n; k++) {
        if (rs[k].position < sampledPos[k]) agg.overtakes++
        sampledPos[k] = rs[k].position
      }
    }
  }

  // --- Tally --------------------------------------------------------------
  agg.races++
  agg.frames += frames
  if (s.phase === 'finished') agg.finishedRaces++
  else process.stderr.write(`  race ${index} hit the ${o.maxFrames}-frame cap with ${s.racers.filter((r) => !r.finished).length} racer(s) still running\n`)

  for (let slot = 0; slot < n; slot++) {
    const r: RacerState = rs[slot]
    const ci = CHASSIS_INDEX[r.chassisId]
    const skill = Math.max(0, Math.min(4, Math.round(r.aiSkill)))
    agg.entries[ci]++
    agg.posSum[ci] += r.position
    agg.slotEntries[slot]++
    agg.skillEntries[skill]++
    if (r.position === 1) { agg.wins[ci]++; agg.slotWins[slot]++; agg.skillWins[skill]++ }
    if (r.position <= 3) agg.podiums[ci]++
    if (r.bestLap > 0) { agg.bestLapSum[ci] += r.bestLap; agg.bestLapN[ci]++ }
    if (r.finished) { agg.finishTimeSum[ci] += r.finishTime; agg.finishTimeN[ci]++ }
    for (const lt of r.lapTimes) {
      if (lt <= 0) continue
      agg.lapSum[ci] += lt; agg.lapN[ci]++
      agg.lapCount++
      agg.lapTimeSum += lt
      agg.lapTimeSumSq += lt * lt
      if (lt < agg.lapMin) agg.lapMin = lt
      if (lt > agg.lapMax) agg.lapMax = lt
      const b = Math.max(0, Math.min(HIST_N - 1, Math.floor(lt - HIST_LO)))
      agg.lapHist[b]++
    }
  }

  if (leaderAtMarker >= 0 && s.finishOrder.length > 0) {
    agg.leadRaces++
    if (s.finishOrder[0] === leaderAtMarker) agg.leadHeld++
  }
}

/** Serial in-process batch. Used by the regression test and by each worker. */
/**
 * Apply dotted-path numeric overrides for a sweep. Two namespaces:
 *   drift.arcBase=1.6            -> TUNING.drift.arcBase
 *   chassis.dray9.topSpeed=9     -> CHASSIS_BY_ID.dray9.stats.topSpeed
 * The chassis form must run before any race, because getDerived() memoises on
 * first use -- runBatch is the first thing a worker does, so that holds.
 */
function applyTune(tune: Record<string, number> | undefined): void {
  if (!tune) return
  for (const [path, value] of Object.entries(tune)) {
    const parts = path.split('.')
    if (parts[0] === 'chassis' && parts.length === 3) {
      const def = CHASSIS_BY_ID[parts[1]]
      if (def) (def.stats as any)[parts[2]] = value
      continue
    }
    let node: any = TUNING
    for (let i = 0; i < parts.length - 1; i++) node = node?.[parts[i]]
    if (node && typeof node === 'object') node[parts[parts.length - 1]] = value
  }
}

export function runBatch(from: number, to: number, o: BalanceOptions): Agg {
  applyTune(o.tune)
  const track = new Track((o.trackId && TRACKS_BY_ID[o.trackId]) || RUSTFALL)
  const agg = emptyAgg()
  const t0 = Date.now()
  for (let i = from; i < to; i++) simulateRace(track, i, o, agg)
  agg.wallMs = Date.now() - t0
  return agg
}

// ---------------------------------------------------------------------------
// Derived report
// ---------------------------------------------------------------------------

export interface ChassisRow {
  id: string
  name: string
  entries: number
  wins: number
  /** Fraction of races won. Sums to 1 across the roster. */
  winShare: number
  podiumRate: number
  avgFinish: number
  avgBestLap: number
  avgLap: number
  avgFinishTime: number
  respawnsPerRace: number
  wallHitsPerRace: number
  offTrackSecPerRace: number
  boostUptime: number
  airTimeShare: number
  /** Share of this chassis's drifts that reached each tier: [none, T0..T3]. */
  driftShare: number[]
}

export interface Report {
  options: BalanceOptions
  agg: Agg
  chassis: ChassisRow[]
  leadRetention: number
  lapMean: number
  lapSd: number
  lapP05: number
  lapP50: number
  lapP95: number
  overtakesPerRace: number
  overtakesPerRaceRaw: number
  driftShare: number[]      // [no tier, T0..T3] as fractions of all drifts
  driftReachedAtLeast: number[]
  alphaHitRate: number
  alphaLeaderRate: number   // hits that landed on the racer in P1
  alphaLeaderPerFire: number
  slotWinShare: number[]
  skillWinRate: number[]
}

function percentile(hist: number[], total: number, q: number): number {
  let acc = 0
  const want = total * q
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i]
    if (acc >= want) return HIST_LO + i + 0.5
  }
  return HIST_LO + hist.length
}

export function buildReport(agg: Agg, options: BalanceOptions): Report {
  const races = Math.max(1, agg.races)
  const chassis: ChassisRow[] = CHASSIS.map((c, i) => ({
    id: c.id,
    name: c.name,
    entries: agg.entries[i],
    wins: agg.wins[i],
    winShare: agg.wins[i] / races,
    podiumRate: agg.podiums[i] / Math.max(1, agg.entries[i]),
    avgFinish: agg.posSum[i] / Math.max(1, agg.entries[i]),
    avgBestLap: agg.bestLapSum[i] / Math.max(1, agg.bestLapN[i]),
    avgLap: agg.lapSum[i] / Math.max(1, agg.lapN[i]),
    avgFinishTime: agg.finishTimeSum[i] / Math.max(1, agg.finishTimeN[i]),
    respawnsPerRace: agg.respawns[i] / races,
    wallHitsPerRace: agg.wallHits[i] / races,
    offTrackSecPerRace: agg.offTrackFrames[i] / 60 / races,
    boostUptime: agg.boostFrames[i] / Math.max(1, agg.driveFrames[i]),
    airTimeShare: agg.airFrames[i] / Math.max(1, agg.driveFrames[i]),
    driftShare: (() => {
      const row = agg.driftTiersByChassis.slice(i * 5, i * 5 + 5)
      const tot = Math.max(1, row.reduce((x, y) => x + y, 0))
      return row.map((v) => v / tot)
    })(),
  }))

  const lapN = Math.max(1, agg.lapCount)
  const lapMean = agg.lapTimeSum / lapN
  const lapVar = Math.max(0, agg.lapTimeSumSq / lapN - lapMean * lapMean)

  const drifts = Math.max(1, agg.driftEnds)
  const driftShare = agg.driftTiers.map((v) => v / drifts)
  const reached: number[] = []
  for (let t = 0; t < 4; t++) {
    let acc = 0
    for (let u = t; u < 4; u++) acc += agg.driftTiers[u + 1]
    reached.push(acc / drifts)
  }

  return {
    options,
    agg,
    chassis,
    leadRetention: agg.leadHeld / Math.max(1, agg.leadRaces),
    lapMean,
    lapSd: Math.sqrt(lapVar),
    lapP05: percentile(agg.lapHist, agg.lapCount, 0.05),
    lapP50: percentile(agg.lapHist, agg.lapCount, 0.50),
    lapP95: percentile(agg.lapHist, agg.lapCount, 0.95),
    overtakesPerRace: agg.overtakes / races,
    overtakesPerRaceRaw: agg.overtakesRaw / races,
    driftShare,
    driftReachedAtLeast: reached,
    alphaHitRate: agg.alphaHits / Math.max(1, agg.alphaFires),
    alphaLeaderRate: agg.alphaHitsOnLeader / Math.max(1, agg.alphaHits),
    alphaLeaderPerFire: agg.alphaHitsOnLeader / Math.max(1, agg.alphaFires),
    slotWinShare: agg.slotWins.map((w) => w / races),
    skillWinRate: agg.skillWins.map((w, i) => w / Math.max(1, agg.skillEntries[i])),
  }
}

/** Gate failures, empty when the run passes. */
export function checkGate(r: Report): string[] {
  const fails: string[] = []
  for (const c of r.chassis) {
    if (c.winShare < GATE.winShareMin || c.winShare > GATE.winShareMax) {
      fails.push(
        `${c.id} win share ${pct(c.winShare)} outside ${pct(GATE.winShareMin)}-${pct(GATE.winShareMax)}`,
      )
    }
  }
  if (r.leadRetention < GATE.leadRetentionMin || r.leadRetention > GATE.leadRetentionMax) {
    fails.push(
      `lead retention ${pct(r.leadRetention)} outside ${pct(GATE.leadRetentionMin)}-${pct(GATE.leadRetentionMax)}`,
    )
  }
  // A stuck racer is a sim robustness bug, not a tuning one, so the gate
  // tolerates a trickle of them and reports the rate rather than hiding it.
  const dnf = r.agg.races - r.agg.finishedRaces
  if (dnf / Math.max(1, r.agg.races) > GATE.maxDnfRate) {
    fails.push(`${dnf} of ${r.agg.races} races (${pct(dnf / r.agg.races, 2)}) did not finish inside the frame cap`)
  }
  return fails
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const pct = (x: number, d = 1): string => `${(x * 100).toFixed(d)}%`
const pad = (s: string | number, w: number): string => String(s).padEnd(w)
const rpad = (s: string | number, w: number): string => String(s).padStart(w)

/** Wilson-ish 95% margin on a proportion, for reading the win-share table. */
function margin(p: number, n: number): number {
  return 1.96 * Math.sqrt(Math.max(1e-9, p * (1 - p)) / Math.max(1, n))
}

export function formatReport(r: Report): string {
  const L: string[] = []
  const a = r.agg
  const races = a.races
  const even = 1 / NC

  L.push('')
  L.push('='.repeat(78))
  // The track NAME, not a hard-coded 'Rustfall'. --track= has been selectable
  // since the multi-track pass and a mislabelled header is how a Cryostatic
  // number ends up quoted as a Rustfall one.
  const trackId = r.options.trackId ?? 'rustfall'
  const trackName = TRACKS_BY_ID[trackId]?.name ?? trackId
  L.push(`SPACEGEN BALANCE GATE  -  ${trackName}  -  ${races} races, ${r.options.laps} laps, ${r.options.racerCount} racers`)
  L.push(`seed base 0x${r.options.seed.toString(16)}   AI field: ${r.options.fixedSkill === null ? 'mixed 2/3/4 (shuffled)' : `fixed ${r.options.fixedSkill}`}`)
  L.push(`${a.frames} frames, ${(a.wallMs / 1000).toFixed(1)}s CPU, ${(a.frames / Math.max(1, a.wallMs / 1000)).toFixed(0)} sim fps`)
  L.push(`races that finished: ${a.finishedRaces}/${races}${a.finishedRaces < races ? `  (${races - a.finishedRaces} hit the ${r.options.maxFrames}-frame cap -- see the stderr list)` : ''}`)
  L.push('='.repeat(78))

  L.push('')
  L.push('PER-CHASSIS')
  L.push(`  ${pad('chassis', 10)}${rpad('entries', 8)}${rpad('wins', 6)}${rpad('win%', 8)}${rpad('+/-', 7)}${rpad('podium%', 9)}${rpad('avgPos', 8)}${rpad('bestLap', 9)}${rpad('avgLap', 8)}${rpad('resp/race', 10)}${rpad('boost%', 8)}${rpad('air%', 7)}${rpad('offTrk s', 9)}`)
  for (const c of r.chassis) {
    const m = margin(c.winShare, races)
    const flag = c.winShare < GATE.winShareMin || c.winShare > GATE.winShareMax ? '  <-- OUT OF BAND' : ''
    L.push(`  ${pad(c.id, 10)}${rpad(c.entries, 8)}${rpad(c.wins, 6)}${rpad(pct(c.winShare), 8)}${rpad('±' + pct(m), 7)}${rpad(pct(c.podiumRate), 9)}${rpad(c.avgFinish.toFixed(2), 8)}${rpad(c.avgBestLap.toFixed(2) + 's', 9)}${rpad(c.avgLap.toFixed(2) + 's', 8)}${rpad(c.respawnsPerRace.toFixed(2), 10)}${rpad(pct(c.boostUptime, 0), 8)}${rpad(pct(c.airTimeShare, 0), 7)}${rpad(c.offTrackSecPerRace.toFixed(1), 9)}${flag}`)
  }
  L.push(`  even share would be ${pct(even)};  band ${pct(GATE.winShareMin)}-${pct(GATE.winShareMax)}`)

  L.push('')
  L.push('LEAD RETENTION')
  const lr = r.leadRetention
  L.push(`  leader at the final-lap marker wins: ${pct(lr)}  (${a.leadHeld}/${a.leadRaces})  target ${pct(GATE.leadRetentionMin)}-${pct(GATE.leadRetentionMax)}  ±${pct(margin(lr, a.leadRaces))}`)
  L.push(`  ${lr > GATE.leadRetentionMax ? 'PROCESSION: the lead is too safe' : lr < GATE.leadRetentionMin ? 'RANDOM: leading means too little' : 'in band'}`)

  L.push('')
  L.push('CHURN')
  L.push(`  position changes per race: ${r.overtakesPerRace.toFixed(1)} (2 Hz sampled)   ${(r.overtakesPerRace / r.options.laps).toFixed(1)} per lap`)
  L.push(`  raw per-frame position gains: ${r.overtakesPerRaceRaw.toFixed(1)} per race (includes sub-second flutter)`)

  L.push('')
  L.push('LAP TIMES  (design target 55-75s)')
  L.push(`  mean ${r.lapMean.toFixed(2)}s   sd ${r.lapSd.toFixed(2)}s   min ${a.lapMin.toFixed(2)}s   max ${a.lapMax.toFixed(2)}s`)
  L.push(`  p05 ${r.lapP05.toFixed(1)}s   median ${r.lapP50.toFixed(1)}s   p95 ${r.lapP95.toFixed(1)}s   n=${a.lapCount}`)
  const inBand = r.lapMean >= GATE.lapTargetMin && r.lapMean <= GATE.lapTargetMax
  L.push(`  mean ${inBand ? 'inside' : 'OUTSIDE'} the 55-75s target`)

  L.push('')
  L.push('ITEMS')
  L.push(`  ${pad('item', 15)}${rpad('picked', 9)}${rpad('/race', 8)}${rpad('fired', 8)}${rpad('fire%', 8)}${rpad('hits', 8)}${rpad('hit/fire', 10)}`)
  for (let i = 0; i < NI; i++) {
    const id = ITEM_ORDER[i]
    const picked = a.pickups[i], fired = a.fires[i], hits = a.hits[i]
    const hitPerFire = fired > 0 ? (hits / fired).toFixed(2) : '-'
    L.push(`  ${pad(id, 15)}${rpad(picked, 9)}${rpad((picked / races).toFixed(2), 8)}${rpad(fired, 8)}${rpad(picked > 0 ? pct(fired / picked, 0) : '-', 8)}${rpad(hits, 8)}${rpad(hitPerFire, 10)}`)
  }
  L.push(`  item boxes touched ${(a.boxTouches / races).toFixed(1)}/race, of which ${pct(a.boxWasted / Math.max(1, a.boxTouches))} granted nothing (slot already full)`)

  L.push('')
  L.push('DRIFT TIERS  (highest tier reached per completed drift)')
  const tierNames = ['no tier', 'T0 Spark', 'T1 Flare', 'T2 Nova', 'T3 Singularity']
  for (let t = 0; t < 5; t++) {
    const bar = '#'.repeat(Math.round(r.driftShare[t] * 40))
    L.push(`  ${pad(tierNames[t], 16)}${rpad(a.driftTiers[t], 9)}${rpad(pct(r.driftShare[t]), 9)}  ${bar}`)
  }
  L.push(`  drifts per race ${(a.driftEnds / races).toFixed(1)}`)
  L.push('  by chassis (share of that chassis\'s drifts):')
  L.push(`    ${pad('chassis', 10)}${rpad('drifts', 9)}${rpad('none', 8)}${rpad('T0', 8)}${rpad('T1', 8)}${rpad('T2', 8)}${rpad('T3', 8)}`)
  for (let i = 0; i < NC; i++) {
    const row = a.driftTiersByChassis.slice(i * 5, i * 5 + 5)
    const tot = row.reduce((x, y) => x + y, 0)
    L.push(`    ${pad(CHASSIS[i].id, 10)}${rpad((tot / races).toFixed(0), 9)}${row.map((v) => rpad(pct(v / Math.max(1, tot)), 8)).join('')}`)
  }
  L.push(`  reached at least: T0 ${pct(r.driftReachedAtLeast[0])}  T1 ${pct(r.driftReachedAtLeast[1])}  T2 ${pct(r.driftReachedAtLeast[2])}  T3 ${pct(r.driftReachedAtLeast[3])}`)
  if (r.driftShare[4] < GATE.tier3MinShare) {
    L.push(`  WARNING: Tier 3 (Singularity) reached in ${pct(r.driftShare[4], 2)} of drifts, under the 1% floor`)
  }

  L.push('')
  L.push('ALPHA MISSILE')
  L.push(`  fired ${a.alphaFires} (${(a.alphaFires / races).toFixed(2)}/race)   hit ${a.alphaHits} (${pct(r.alphaHitRate)} of fires)`)
  L.push(`  of those hits, ${pct(r.alphaLeaderRate)} landed on the racer actually in P1`)
  L.push(`  net: ${pct(r.alphaLeaderPerFire)} of Alpha Missiles fired take out the leader`)

  L.push('')
  L.push('CONFOUND CONTROL')
  L.push(`  win share by grid slot: ${r.slotWinShare.map((x) => pct(x, 1)).join('  ')}`)
  L.push(`  entries per chassis: ${a.entries.join(' / ')} (should be near-equal)`)
  L.push(`  win rate by AI skill band: ${r.skillWinRate.map((x, i) => (a.skillEntries[i] ? `s${i}=${pct(x, 1)}` : '')).filter(Boolean).join('  ')}`)

  return L.join('\n')
}

// ---------------------------------------------------------------------------
// Worker fan-out
// ---------------------------------------------------------------------------

/**
 * Bootstrap for each worker. The worker is started with `eval: true` so this
 * CommonJS prelude can register tsx's ESM hooks in the new thread before
 * importing this TypeScript module; Node does not inherit loader hooks into
 * worker threads.
 */
const WORKER_BOOT = `
const { register } = require('tsx/esm/api')
register()
const { workerData } = require('node:worker_threads')
import(workerData.entry).catch((e) => { console.error(e); process.exit(1) })
`

interface WorkerJob {
  kind: 'spacegen-balance'
  entry: string
  from: number
  to: number
  options: BalanceOptions
}

function runWorker(job: WorkerJob): void {
  const agg = runBatch(job.from, job.to, job.options)
  parentPort?.postMessage(agg)
}

async function fanOut(o: BalanceOptions, workers: number): Promise<Agg> {
  if (workers <= 1) return runBatch(0, o.races, o)
  const entry = import.meta.url
  const bounds: [number, number][] = []
  for (let w = 0; w < workers; w++) {
    const from = Math.floor((w * o.races) / workers)
    const to = Math.floor(((w + 1) * o.races) / workers)
    if (to > from) bounds.push([from, to])
  }

  const total = emptyAgg()
  let done = 0
  const t0 = Date.now()
  await Promise.all(bounds.map(([from, to]) => new Promise<void>((resolve, reject) => {
    const job: WorkerJob = { kind: 'spacegen-balance', entry, from, to, options: o }
    const w = new Worker(WORKER_BOOT, { eval: true, workerData: job })
    w.on('message', (agg: Agg) => {
      mergeAgg(total, agg)
      done++
      const el = (Date.now() - t0) / 1000
      process.stderr.write(`  worker ${done}/${bounds.length} done  (${total.races}/${o.races} races, ${el.toFixed(0)}s)\n`)
    })
    w.on('error', reject)
    w.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))))
  })))
  return total
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function numArg(args: string[], name: string, fallback: number): number {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  if (!hit) return fallback
  const v = Number(hit.slice(name.length + 3))
  return Number.isFinite(v) ? v : fallback
}

/** --tune=drift.arcBase=1.6,drift.arcPerYaw=1.3 */
function parseTune(args: string[]): Record<string, number> | undefined {
  const hit = args.find((a) => a.startsWith('--tune='))
  if (!hit) return undefined
  const out: Record<string, number> = {}
  for (const pair of hit.slice(7).split(',')) {
    const eq = pair.lastIndexOf('=')
    if (eq < 1) continue
    const v = Number(pair.slice(eq + 1))
    if (Number.isFinite(v)) out[pair.slice(0, eq)] = v
  }
  return Object.keys(out).length ? out : undefined
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length
  const options: BalanceOptions = {
    ...DEFAULT_OPTIONS,
    races: Math.max(1, Math.round(numArg(args, 'races', DEFAULT_OPTIONS.races))),
    laps: Math.max(1, Math.round(numArg(args, 'laps', DEFAULT_OPTIONS.laps))),
    racerCount: Math.max(2, Math.round(numArg(args, 'racers', DEFAULT_OPTIONS.racerCount))),
    seed: numArg(args, 'seed', DEFAULT_OPTIONS.seed) >>> 0,
    fixedSkill: args.some((a) => a.startsWith('--skill=')) ? numArg(args, 'skill', 3) : null,
    tune: parseTune(args),
    trackId: (args.find((a) => a.startsWith('--track=')) ?? '--track=rustfall').slice(8),
  }
  if (options.tune) {
    process.stderr.write(`tuning overrides: ${JSON.stringify(options.tune)}\n`)
  }
  const workers = Math.max(1, Math.round(numArg(args, 'workers', Math.min(cores, 16))))

  process.stderr.write(`running ${options.races} races on ${workers} worker(s)...\n`)
  const t0 = Date.now()
  const agg = await fanOut(options, workers)
  const wall = Date.now() - t0

  const report = buildReport(agg, options)
  console.log(formatReport(report))
  console.log(`\nwall clock ${(wall / 1000).toFixed(1)}s on ${workers} worker(s)  (${(wall / Math.max(1, agg.races)).toFixed(0)} ms/race)`)

  const jsonPath = args.find((a) => a.startsWith('--json='))
  if (jsonPath) {
    fs.writeFileSync(jsonPath.slice(7), JSON.stringify(report, null, 2))
    console.log(`wrote ${jsonPath.slice(7)}`)
  }

  if (args.includes('--assert')) {
    const fails = checkGate(report)
    if (fails.length) {
      console.error('\nBALANCE GATE FAILED:')
      for (const f of fails) console.error('  - ' + f)
      process.exit(1)
    }
    console.log('\nBALANCE GATE PASSED')
  }
}

if (!isMainThread && workerData && (workerData as WorkerJob).kind === 'spacegen-balance') {
  runWorker(workerData as WorkerJob)
} else if (isMainThread && process.argv[1] && process.argv[1].endsWith('balance.ts')) {
  void main()
}
