/**
 * DRIFT / BOOST / AIR AUTOPSY.
 *
 * Answers three questions the balance gate can only pose:
 *   1. WHERE on the lap does a drift start, how long does it live, and WHY did
 *      it end? (button released by the AI's own curvature gate / airborne /
 *      too slow / collision-cancelled)
 *   2. WHERE does boost uptime come from, broken down by boostSource?
 *   3. WHERE is each class airborne?
 *
 * Nothing here touches the sim: every classification is reconstructed from
 * per-frame state snapshots taken either side of race.step(), using the same
 * expressions stepAI and stepVehicle use.
 *
 *   npx tsx tools/probe-drift.ts --track=aetherion --races=8
 */
import { Race } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { TRACKS_BY_ID } from '../src/content/tracks'
import { CHASSIS, getLocomotion } from '../src/content/chassis'
import { PILOTS } from '../src/content/pilots'
import { resetAI } from '../src/sim/ai'
import { emptyInput } from '../src/sim/types'
import { TUNING as T } from '../src/content/tuning'
import type { SimConfig } from '../src/sim/types'

const argv = process.argv.slice(2)
const arg = (k: string, d: string): string => argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const TRACK_DEF = TRACKS_BY_ID[arg('track', 'aetherion')]
const RACES = parseInt(arg('races', '8'), 10)
const BUCKETS = parseInt(arg('buckets', '40'), 10)

const CI: Record<string, number> = {}
CHASSIS.forEach((c, i) => { CI[c.id] = i })
const NC = CHASSIS.length
const SOURCES = ['none', 'drift', 'pad', 'item', 'slipstream', 'trick', 'start'] as const
const LOCO: Record<string, number> = { grounded: 0, hover: 1, flight: 2 }
const LOCONAME = ['grounded', 'hover', 'flight']

function cfg(seed: number): SimConfig {
  const n = 8
  return {
    seed, totalLaps: 3, racerCount: n, trackId: TRACK_DEF.id,
    chassisIds: Array.from({ length: n }, (_, i) => CHASSIS[i % NC].id),
    pilotIds: Array.from({ length: n }, (_, i) => PILOTS[i % PILOTS.length].id),
    localRacerIndex: -1,
    aiSkill: Array.from({ length: n }, (_, i) => 2 + (i % 3)),
  }
}

const track = new Track(TRACK_DEF)
const L = track.length
const bkt = (s: number) => Math.min(BUCKETS - 1, Math.floor((((s % L) + L) % L) / L * BUCKETS))

const zeros = (n: number) => new Array(n).fill(0)
const entryByBucket = zeros(BUCKETS)
const shortEndByBucket = zeros(BUCKETS)   // drifts that died in < 0.12s, keyed on ENTRY bucket
const tieredEndByBucket = zeros(BUCKETS)
const durSumByBucket = zeros(BUCKETS)
const driftFramesByBucket = zeros(BUCKETS)
const frameByBucket = zeros(BUCKETS)
const airByBucketClass = [0, 1, 2].map(() => zeros(BUCKETS))
const frameByBucketClass = [0, 1, 2].map(() => zeros(BUCKETS))
const boostFramesBySource = zeros(SOURCES.length)
const boostFramesBySourceChassis = CHASSIS.map(() => zeros(SOURCES.length))
const boostBySourceBucket = SOURCES.map(() => zeros(BUCKETS))
const driveFrames = zeros(NC)
const airFrames = zeros(NC)
const durHist = zeros(30)
const durLong = { n: 0, sum: 0 }
const REASONS = ['aiGate', 'airborne', 'tooSlow', 'collision'] as const
const reasonCount = zeros(REASONS.length)
const reasonShort = zeros(REASONS.length)             // only for drifts < 0.12s
const reasonByBucket = REASONS.map(() => zeros(BUCKETS))
const tierCount = zeros(5)
const airByBucketChassis = CHASSIS.map(() => zeros(BUCKETS))
const framesByBucketChassis = CHASSIS.map(() => zeros(BUCKETS))
const lapTimes: number[] = []
const chargeSumByBucket = zeros(BUCKETS)
const chargeMaxByBucket = zeros(BUCKETS)
const chargeNByBucket = zeros(BUCKETS)
const t3ByBucket = zeros(BUCKETS)
const chargeHist = zeros(24)
const chgByChassis = CHASSIS.map(() => ({ n: 0, sum: 0, t3: 0, t2: 0 }))
const kHist = zeros(20)
const exitSHist = zeros(BUCKETS)
const shortExitSHist = zeros(BUCKETS)

for (let race = 0; race < RACES; race++) {
  resetAI()
  const t = new Track(TRACK_DEF)
  const r = new Race(t, cfg(9000 + race * 977))
  const idle = emptyInput()
  const rs = r.state.racers
  const n = rs.length
  const wasDrift = zeros(n)
  const startS = zeros(n)
  const startT = zeros(n)
  const preS = zeros(n)
  const preGround: boolean[] = new Array(n).fill(true)
  const preSpeed = zeros(n)
  const peakCharge = zeros(n)
  const latch = zeros(n)
  let f = 0
  while (f < 60 * 400 && r.state.phase !== 'finished') {
    for (let k = 0; k < n; k++) {
      preS[k] = rs[k].splineS
      preGround[k] = rs[k].grounded
      preSpeed[k] = Math.hypot(rs[k].vel.x, rs[k].vel.y, rs[k].vel.z)
      if (!rs[k].isAI) r.setInput(rs[k].id, idle)
    }
    r.step()
    f++
    for (let k = 0; k < n; k++) {
      const x = rs[k]
      if (x.finished) continue
      const ci = CI[x.chassisId]
      const lc = LOCO[(CHASSIS[ci] as any).locomotion]
      const b = bkt(x.splineS)
      frameByBucket[b]++
      frameByBucketClass[lc][b]++
      framesByBucketChassis[ci][b]++
      driveFrames[ci]++
      if (!x.grounded) { airFrames[ci]++; airByBucketClass[lc][b]++; airByBucketChassis[ci][b]++ }
      if (x.boostTime > 0) {
        const si = Math.max(0, SOURCES.indexOf(x.boostSource as any))
        boostFramesBySource[si]++
        boostFramesBySourceChassis[ci][si]++
        boostBySourceBucket[si][b]++
      }
      if (x.driftSide !== 0) driftFramesByBucket[b]++
      if (x.driftCharge > peakCharge[k]) peakCharge[k] = x.driftCharge
      if (latch[k] > 0 && !(wasDrift[k] === 0 && x.driftSide !== 0)) latch[k] = Math.max(0, latch[k] - 1 / 60)
      if (wasDrift[k] === 0 && x.driftSide !== 0) {
        entryByBucket[b]++
        startS[k] = x.splineS
        startT[k] = f / 60
        peakCharge[k] = 0
        latch[k] = T.ai.driftMinHold
      } else if (wasDrift[k] !== 0 && x.driftSide === 0) {
        const sb = bkt(startS[k])
        const dur = f / 60 - startT[k]
        durSumByBucket[sb] += dur
        durHist[Math.min(durHist.length - 1, Math.floor(dur / 0.05))]++
        if (dur >= 1.2) { durLong.n++; durLong.sum += dur }
        // Reconstruct why. Order matches the tests in stepAI/stepVehicle.
        const loco = getLocomotion(x.chassisId)
        const aiHeld = latch[k] > 0 || Math.abs(t.curvatureAt(preS[k], 20)) > 0.0045
        chargeSumByBucket[sb] += peakCharge[k]
        chargeNByBucket[sb]++
        if (peakCharge[k] > chargeMaxByBucket[sb]) chargeMaxByBucket[sb] = peakCharge[k]
        if (peakCharge[k] >= T.drift.tierTimes[3]) t3ByBucket[sb]++
        chargeHist[Math.min(chargeHist.length - 1, Math.floor(peakCharge[k] / 0.5))]++
        const cc = chgByChassis[ci]
        cc.n++; cc.sum += peakCharge[k]
        if (peakCharge[k] >= T.drift.tierTimes[3]) cc.t3++
        else if (peakCharge[k] >= T.drift.tierTimes[2]) cc.t2++
        const canDrift = preSpeed[k] > T.drift.minSpeedToDrift && (preGround[k] || loco.gapCross > 0)
        let ri: number
        if (!aiHeld) ri = 0
        else if (!preGround[k] && loco.gapCross === 0) ri = 1
        else if (!canDrift) ri = 2
        else ri = 3
        reasonCount[ri]++
        reasonByBucket[ri][sb]++
        if (ri === 0) {
          const kv = Math.abs(t.curvatureAt(preS[k], 20))
          kHist[Math.min(kHist.length - 1, Math.floor(kv / 0.0005))]++
          exitSHist[bkt(preS[k])]++
          if (dur < 0.12) shortExitSHist[bkt(preS[k])]++
        }
        if (dur < 0.12) { shortEndByBucket[sb]++; reasonShort[ri]++ }
      }
      wasDrift[k] = x.driftSide
      for (const e of x.events) {
        if (e.t === 'driftEnd') {
          const tier = (e as any).tier as number
          tierCount[Math.max(0, Math.min(4, tier + 1))]++
          if (tier >= 0) tieredEndByBucket[bkt(startS[k])]++
        }
      }
    }
  }
  for (const x of rs) for (const lt of x.lapTimes) if (lt > 0) lapTimes.push(lt)
}

// --- static curvature read --------------------------------------------------
const N = 1600
let thrashM = 0, driftableM = 0, holdOnlyM = 0
const stepM = L / N
const thrashByBucket = zeros(BUCKETS)
for (let i = 0; i < N; i++) {
  const s = (i / N) * L
  const e = Math.abs(track.curvatureAt(s + 6, 30)) > 0.0075
  const h = Math.abs(track.curvatureAt(s, 20)) > 0.0045
  if (e && !h) { thrashM += stepM; thrashByBucket[bkt(s)] += stepM }
  if (e && h) driftableM += stepM
  if (!e && h) holdOnlyM += stepM
}

// --- tag positions ----------------------------------------------------------
const tagAt: { s: number; tag: string }[] = []
for (const nd of TRACK_DEF.nodes) {
  if (!nd.tag) continue
  let best = 0, bd = Infinity
  for (let k = 0; k < track.samples.length; k++) {
    const p = track.samples[k].pos
    const d = (p.x - nd.p[0]) ** 2 + (p.y - nd.p[1]) ** 2 + (p.z - nd.p[2]) ** 2
    if (d < bd) { bd = d; best = k }
  }
  tagAt.push({ s: (best / track.samples.length) * L, tag: nd.tag })
}

const pct = (x: number, d = 1) => (x * 100).toFixed(d) + '%'
const bar = (v: number, max: number, w = 12) => '#'.repeat(Math.round((v / Math.max(1e-9, max)) * w))
const totalEnds = reasonCount.reduce((a, b) => a + b, 0)
const allDrive = driveFrames.reduce((a, b) => a + b, 0)

console.log(`\n=== ${TRACK_DEF.name}  ${L.toFixed(0)}m  ${RACES} races  lapMean ${(lapTimes.reduce((a, b) => a + b, 0) / Math.max(1, lapTimes.length)).toFixed(2)}s ===\n`)
console.log('STATIC curvature gate (enter |k(s+6,30)|>0.0075, hold |k(s,20)|>0.0045):')
console.log(`  enter&hold (drift can live) ${driftableM.toFixed(0)}m  ${pct(driftableM / L)}`)
console.log(`  enter&!hold (THRASH ZONE)   ${thrashM.toFixed(0)}m  ${pct(thrashM / L)}`)
console.log(`  !enter&hold (holdable only) ${holdOnlyM.toFixed(0)}m  ${pct(holdOnlyM / L)}`)

console.log(`\nDRIFT ENDS ${totalEnds}  (${(totalEnds / RACES).toFixed(1)} per race)  EXIT REASON:`)
for (let i = 0; i < REASONS.length; i++) {
  console.log(`  ${REASONS[i].padEnd(10)} ${String(reasonCount[i]).padStart(7)} ${pct(reasonCount[i] / Math.max(1, totalEnds)).padStart(7)}   of which <0.12s: ${String(reasonShort[i]).padStart(7)} ${pct(reasonShort[i] / Math.max(1, reasonCount[i])).padStart(7)}`)
}

console.log('\n|k(s,20)| AT aiGate EXIT (0.0005 bins; gate is 0.0045 = bin 9):')
{
  const m3 = Math.max(...kHist)
  for (let i = 0; i < kHist.length; i++) if (kHist[i]) console.log(`  ${(i * 0.0005).toFixed(4)}-${((i + 1) * 0.0005).toFixed(4)} ${String(kHist[i]).padStart(6)} ${pct(kHist[i] / Math.max(1, reasonCount[0])).padStart(7)} ${bar(kHist[i], m3, 40)}`)
}
console.log('\nPER-BUCKET:')
console.log('  bkt   s0    entries  short  tiered meanDur driftSh  thrashM  aiGate airbrn slow coll  tags')
const maxEntry = Math.max(...entryByBucket)
for (let b = 0; b < BUCKETS; b++) {
  const s0 = (b / BUCKETS) * L, s1 = ((b + 1) / BUCKETS) * L
  const tags = tagAt.filter((x) => x.s >= s0 && x.s < s1).map((x) => x.tag).join(',')
  const ends = REASONS.reduce((a, _, i) => a + reasonByBucket[i][b], 0)
  const md = ends ? durSumByBucket[b] / ends : 0
  const ds = frameByBucket[b] ? driftFramesByBucket[b] / frameByBucket[b] : 0
  console.log(`  ${String(b).padStart(3)} ${s0.toFixed(0).padStart(5)} ${String(entryByBucket[b]).padStart(8)} ${String(shortEndByBucket[b]).padStart(6)} ${String(tieredEndByBucket[b]).padStart(7)} ${md.toFixed(2).padStart(7)} ${pct(ds, 0).padStart(7)} ${thrashByBucket[b].toFixed(0).padStart(8)}  ${String(reasonByBucket[0][b]).padStart(6)} ${String(reasonByBucket[1][b]).padStart(6)} ${String(reasonByBucket[2][b]).padStart(4)} ${String(reasonByBucket[3][b]).padStart(4)}  ${tags} ${bar(entryByBucket[b], maxEntry)}`)
}

console.log('\nPEAK DRIFT CHARGE BY ENTRY BUCKET (tier gates 0.65 / 1.50 / 2.60 / 4.20):')
console.log('  bkt   s0     drifts  meanChg  maxChg   T3   T3%   tags')
for (let b = 0; b < BUCKETS; b++) {
  if (chargeNByBucket[b] < 3) continue
  const s0 = (b / BUCKETS) * L, s1 = ((b + 1) / BUCKETS) * L
  const tags = tagAt.filter((x) => x.s >= s0 && x.s < s1).map((x) => x.tag).join(',')
  console.log(`  ${String(b).padStart(3)} ${s0.toFixed(0).padStart(6)} ${String(chargeNByBucket[b]).padStart(7)} ${(chargeSumByBucket[b] / chargeNByBucket[b]).toFixed(2).padStart(8)} ${chargeMaxByBucket[b].toFixed(2).padStart(7)} ${String(t3ByBucket[b]).padStart(5)} ${pct(t3ByBucket[b] / chargeNByBucket[b], 0).padStart(5)}   ${tags}`)
}
console.log('\nPEAK CHARGE BY CHASSIS:')
for (let c = 0; c < NC; c++) {
  const q = chgByChassis[c]
  console.log(`  ${CHASSIS[c].id.padEnd(10)} drifts ${String(q.n).padStart(6)}  meanChg ${(q.sum / Math.max(1, q.n)).toFixed(2)}  T2 ${pct(q.t2 / Math.max(1, q.n))}  T3 ${pct(q.t3 / Math.max(1, q.n))}`)
}
console.log('\nPEAK CHARGE HISTOGRAM (0.5 bins):')
{
  const mx2 = Math.max(...chargeHist)
  for (let i = 0; i < chargeHist.length; i++) if (chargeHist[i]) console.log(`  ${(i * 0.5).toFixed(1)}-${((i + 1) * 0.5).toFixed(1)} ${String(chargeHist[i]).padStart(7)} ${pct(chargeHist[i] / Math.max(1, totalEnds)).padStart(7)} ${bar(chargeHist[i], mx2, 40)}`)
}
console.log('\nDRIFT DURATION HISTOGRAM (0.05s bins):')
const mx = Math.max(...durHist)
for (let i = 0; i < durHist.length; i++) {
  if (durHist.slice(i).every((x) => x === 0)) break
  console.log(`  ${(i * 0.05).toFixed(2)}s ${String(durHist[i]).padStart(7)} ${pct(durHist[i] / Math.max(1, totalEnds)).padStart(7)} ${bar(durHist[i], mx, 40)}`)
}
console.log(`  >=1.45s ${String(durLong.n).padStart(7)}  meanDurLong ${(durLong.sum / Math.max(1, durLong.n)).toFixed(2)}s`)
const tt = tierCount.reduce((a, b) => a + b, 0)
console.log(`  tiers: none ${pct(tierCount[0] / tt)}  T0 ${pct(tierCount[1] / tt)}  T1 ${pct(tierCount[2] / tt)}  T2 ${pct(tierCount[3] / tt)}  T3 ${pct(tierCount[4] / tt)}`)

console.log('\nBOOST SOURCE (share of drive frames, whole field):')
for (let i = 0; i < SOURCES.length; i++) if (boostFramesBySource[i]) console.log(`  ${SOURCES[i].padEnd(11)} ${pct(boostFramesBySource[i] / allDrive).padStart(7)}`)
console.log(`  ANY         ${pct(boostFramesBySource.reduce((a, b) => a + b, 0) / allDrive).padStart(7)}`)
console.log('\nBOOST SOURCE PER CHASSIS:')
console.log('  chassis     ' + SOURCES.map((s) => s.padStart(9)).join('') + '      ANY')
for (let c = 0; c < NC; c++) {
  const row = boostFramesBySourceChassis[c]
  console.log('  ' + CHASSIS[c].id.padEnd(12) + row.map((v) => pct(v / driveFrames[c]).padStart(9)).join('') + pct(row.reduce((a, b) => a + b, 0) / driveFrames[c]).padStart(9))
}
console.log('\nPAD BOOST BY BUCKET (frames):')
{
  const padRow = boostBySourceBucket[SOURCES.indexOf('pad')]
  const m2 = Math.max(...padRow)
  for (let b = 0; b < BUCKETS; b++) if (padRow[b] > m2 * 0.05) {
    const tags = tagAt.filter((x) => x.s >= (b / BUCKETS) * L && x.s < ((b + 1) / BUCKETS) * L).map((x) => x.tag).join(',')
    console.log(`  ${String(b).padStart(3)} ${((b / BUCKETS) * L).toFixed(0).padStart(5)} ${String(padRow[b]).padStart(7)} ${pct(padRow[b] / Math.max(1, frameByBucket[b]), 0).padStart(6)} of frames  ${tags} ${bar(padRow[b], m2, 30)}`)
  }
}

console.log('\nAIR SHARE PER CHASSIS: ' + CHASSIS.map((c, i) => `${c.id} ${pct(airFrames[i] / driveFrames[i])}`).join('  '))
console.log('AIR BY BUCKET (share of that class frames in bucket: #>99% +>50% :>15% .>2%):')
for (let lc = 0; lc < 3; lc++) {
  const cells = Array.from({ length: BUCKETS }, (_, b) => {
    const sh = airByBucketClass[lc][b] / Math.max(1, frameByBucketClass[lc][b])
    return sh > 0.99 ? '#' : sh > 0.5 ? '+' : sh > 0.15 ? ':' : sh > 0.02 ? '.' : ' '
  })
  console.log(`  ${LOCONAME[lc].padEnd(9)} |${cells.join('')}|`)
}
console.log('  bucket    |' + Array.from({ length: BUCKETS }, (_, b) => String(b % 10)).join('') + '|')
console.log('\nVECTOR-7 AIR BY BUCKET (share of its own frames there):')
{
  const ci = CI['vector7']
  for (let b = 0; b < BUCKETS; b++) {
    const sh = airByBucketChassis[ci][b] / Math.max(1, framesByBucketChassis[ci][b])
    if (sh > 0.02) {
      const tags = tagAt.filter((x) => x.s >= (b / BUCKETS) * L && x.s < ((b + 1) / BUCKETS) * L).map((x) => x.tag).join(',')
      console.log(`  ${String(b).padStart(3)} ${((b / BUCKETS) * L).toFixed(0).padStart(5)} ${pct(sh, 0).padStart(5)}  ${tags} ${bar(sh, 1, 30)}`)
    }
  }
}
