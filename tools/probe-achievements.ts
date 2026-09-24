/**
 * DOES EVERY ACHIEVEMENT SIGNAL ACTUALLY FIRE, AND HOW OFTEN?
 *
 *   npx tsx tools/probe-achievements.ts                  signals, Normal field
 *   npx tsx tools/probe-achievements.ts --diff=expert    ...at another difficulty
 *   npx tsx tools/probe-achievements.ts --laps           the Lap Record targets
 *   npx tsx tools/probe-achievements.ts --singularity    tier 3 where the AI never goes
 *
 * THIS PROJECT HAS A HISTORY OF INSTRUMENTS THAT MEASURED SOMETHING NEXT TO THE
 * THING THEY CLAIMED, so this one measures through the real thing: every car
 * in a real headless race gets its own `RaceTracker` (src/score/tracker.ts),
 * fed one call per sim step exactly as game/main.ts feeds the player's, and
 * the facts it produces go through the real `raceClaims` / `raceCounters`
 * (src/content/achievements.ts). A signal that never fires here is a badge no
 * player can earn, and the run says so and exits non-zero.
 *
 * The AI is not a player. What these numbers are is the shape of a race --
 * how many knockouts an item distribution produces, how much air a circuit
 * has, how often the field churns -- which is what a threshold has to be
 * judged against. Where the AI cannot show a badge is reachable (it never
 * holds a drift to SINGULARITY on three circuits), `--singularity` drives a car
 * that does, rather than leaving the question to a player to discover.
 */
import { Race } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { TRACKS, type TRACKS_BY_ID } from '../src/content/tracks'
import { CHASSIS } from '../src/content/chassis'
import { PILOTS } from '../src/content/pilots'
import { resetAI, stepAI } from '../src/sim/ai'
import { Rng } from '../src/sim/rng'
import { skillForSlot, type Difficulty } from '../src/content/difficulty'
import { Scorer } from '../src/score/scorer'
import { RaceTracker } from '../src/score/tracker'
import {
  ACH_CIRCUITS, LAP_TARGETS, raceClaims, type RaceFacts,
} from '../src/content/achievements'
import type { SimConfig } from '../src/sim/types'

type TrackDef = (typeof TRACKS_BY_ID)[string]

const arg = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const flag = (k: string): boolean => process.argv.includes(`--${k}`)

const N = 8
const LAPS = 3

/**
 * The seeded field the Lap Record targets were measured on. Kept here, and
 * imported by tests/achievements.test.ts, so the test replays the SAME race
 * the table in content/achievements.ts quotes rather than a lookalike.
 */
export function fieldConfig(def: TrackDef, diff: Difficulty, seed: number, laps = LAPS): SimConfig {
  return {
    seed: seed * 104729 + 7,
    totalLaps: laps,
    racerCount: N,
    trackId: def.id,
    // Rotated by seed so every chassis sits in every band over the run.
    chassisIds: Array.from({ length: N }, (_, i) => CHASSIS[(i + seed) % CHASSIS.length].id),
    pilotIds: Array.from({ length: N }, (_, i) => PILOTS[(i + seed) % PILOTS.length].id),
    localRacerIndex: -1,
    aiSkill: Array.from({ length: N }, (_, i) => skillForSlot(diff, i)),
  }
}

/** Run one race with a tracker on every car. Returns each car's facts. */
function trackedRace(def: TrackDef, diff: Difficulty, seed: number): RaceFacts[] {
  resetAI()
  const race = new Race(new Track(def), fieldConfig(def, diff, seed))
  const st = race.state
  const trackers = st.racers.map((r) => { const t = new RaceTracker(); t.begin(r.id, def.id); return t })
  const scorers = st.racers.map(() => new Scorer())
  let frames = 0
  while (frames < 60 * 420 && st.phase !== 'finished') {
    race.step()
    frames++
    for (const t of trackers) t.step(st)
    for (let i = 0; i < N; i++) scorers[i].frame(st, st.racers[i], st.racers[i].events)
  }
  return trackers.map((t, i) => t.facts(st, {
    difficulty: diff, multiplayer: false,
    score: scorers[i].score, bestCombo: scorers[i].bestCombo, circuit: null, sweep: false,
  }))
}

const q = (a: number[], p: number): number => {
  const c = a.slice().sort((x, y) => x - y)
  return c.length ? c[Math.min(c.length - 1, Math.floor(c.length * p))] : 0
}
const mean = (a: number[]): number => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length)

// ---------------------------------------------------------------------------
// --signals (default)
// ---------------------------------------------------------------------------

function signals(): void {
  const diff = arg('diff', 'normal') as Difficulty
  const seeds = Number(arg('seeds', '3'))
  const all: RaceFacts[] = []
  const claimCount = new Map<string, number>()
  for (const def of TRACKS) {
    for (let s = 1; s <= seeds; s++) {
      for (const f of trackedRace(def, diff, s)) {
        all.push(f)
        for (const id of raceClaims(f)) {
          const key = id.includes(':') && !id.startsWith('mark:') && !id.startsWith('frontrunner')
            ? id.split(':')[0] : id.startsWith('mark:win') ? 'mark:win' : id
          claimCount.set(key, (claimCount.get(key) ?? 0) + 1)
        }
      }
    }
  }
  const n = all.length
  console.log(`${diff} field: ${n} racer-races, ${TRACKS.length} circuits x ${seeds} seeds, every car tracked\n`)
  const row = (label: string, xs: number[]): void => {
    console.log(`  ${label.padEnd(24)} mean ${mean(xs).toFixed(2).padStart(7)}   p50 ${q(xs, 0.5).toFixed(1).padStart(6)}` +
      `   p90 ${q(xs, 0.9).toFixed(1).padStart(6)}   max ${Math.max(...xs).toFixed(1).padStart(6)}`)
  }
  console.log('PER-RACE COUNTS (what the thresholds are judged against)')
  row('SINGULARITY releases', all.map((f) => f.singularity))
  row('knockouts', all.map((f) => f.knockouts))
  row('weapon hits landed', all.map((f) => f.weaponHits))
  row('weapon hits taken', all.map((f) => f.hitsTaken))
  row('clean laps', all.map((f) => f.cleanLaps))
  row('airtime (s)', all.map((f) => f.airtimeMs / 1000))
  row('score', all.map((f) => f.score))
  row('best combo', all.map((f) => f.bestCombo))
  const pct = (k: number): string => `${k} (${((100 * k) / n).toFixed(1)}%)`
  console.log(`  perfect launches        ${pct(all.filter((f) => f.perfectLaunch).length)}`)
  console.log(`  ran last (settled)      ${pct(all.filter((f) => f.ranLast).length)}`)
  console.log(`  led at end of lap 1     ${pct(all.filter((f) => f.lap1Position === 1).length)}`)
  console.log(`  finished                ${pct(all.filter((f) => f.finished).length)}`)

  const wins = all.filter((f) => f.finished && f.position === 1)
  console.log(`\nWINNERS (${wins.length})`)
  console.log(`  margin p50 ${q(wins.map((f) => f.winMargin), 0.5).toFixed(3)}s, under 0.1s: ${wins.filter((f) => f.winMargin < 0.1).length}`)
  console.log(`  ran last first: ${wins.filter((f) => f.ranLast).length}; untouched: ${wins.filter((f) => f.hitsTaken === 0).length}; ` +
    `wall-free: ${wins.filter((f) => !f.dirtyRace).length}`)

  console.log('\nPER CIRCUIT')
  for (const c of ACH_CIRCUITS) {
    const fs = all.filter((f) => f.trackId === c.id)
    console.log(`  ${c.name.padEnd(16)} SINGULARITY/race ${mean(fs.map((f) => f.singularity)).toFixed(2).padStart(5)}` +
      `   clean laps ${String(fs.reduce((s, f) => s + f.cleanLaps, 0)).padStart(3)}/${fs.length * LAPS}` +
      `   airtime ${mean(fs.map((f) => f.airtimeMs / 1000)).toFixed(1).padStart(5)}s` +
      `   best lap ${Math.min(...fs.flatMap((f) => f.lapTimes)).toFixed(2)} (target ${LAP_TARGETS[c.id].toFixed(1)})`)
  }

  console.log('\nCLAIMS RAISED (racer-races whose facts earn each badge)')
  for (const [k, v] of [...claimCount].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${pct(v)}`)

  // Every signal a badge rests on has to have been SEEN, or it is a badge
  // nobody can earn and nobody will ever report.
  const seen: [string, boolean][] = [
    ['SINGULARITY release', all.some((f) => f.singularity > 0)],
    ['knockout', all.some((f) => f.knockouts > 0)],
    ['weapon hit landed', all.some((f) => f.weaponHits > 0)],
    ['weapon hit taken', all.some((f) => f.hitsTaken > 0)],
    ['clean lap', all.some((f) => f.cleanLaps > 0)],
    ['perfect launch', all.some((f) => f.perfectLaunch)],
    ['lap-1 position', all.some((f) => f.lap1Position > 0)],
    ['ran last', all.some((f) => f.ranLast)],
    ['airtime', all.some((f) => f.airtimeMs > 0)],
    ['win margin', wins.some((f) => Number.isFinite(f.winMargin))],
  ]
  const dead = seen.filter(([, ok]) => !ok).map(([k]) => k)
  console.log(dead.length ? `\nSIGNALS THAT NEVER FIRED: ${dead.join(', ')}` : '\nevery signal fired')
  if (dead.length) process.exitCode = 1
}

// ---------------------------------------------------------------------------
// --laps: the Lap Record targets
// ---------------------------------------------------------------------------

function laps(): void {
  const seeds = Number(arg('seeds', '8'))
  console.log(`Expert field, ${seeds} races per circuit; target = fastest lap rounded UP to 0.1s\n`)
  for (const def of TRACKS) {
    let best = Infinity
    let bestSeed = 0
    let bestSlot = -1
    const raceBests: number[] = []
    const expert: number[] = []
    for (let s = 1; s <= seeds; s++) {
      resetAI()
      const race = new Race(new Track(def), fieldConfig(def, 'expert', s))
      let f = 0
      while (f < 60 * 420 && race.state.phase !== 'finished') { race.step(); f++ }
      let rb = Infinity
      for (const r of race.state.racers) {
        if (r.bestLap <= 0) continue
        expert.push(r.bestLap)
        rb = Math.min(rb, r.bestLap)
        if (r.bestLap < best) { best = r.bestLap; bestSeed = s; bestSlot = r.id }
      }
      raceBests.push(rb)
    }
    const normal: number[] = []
    for (let s = 1; s <= seeds; s++) {
      resetAI()
      const race = new Race(new Track(def), fieldConfig(def, 'normal', s))
      let f = 0
      while (f < 60 * 420 && race.state.phase !== 'finished') { race.step(); f++ }
      for (const r of race.state.racers) if (r.bestLap > 0) normal.push(r.bestLap)
    }
    const target = Math.ceil(best * 10) / 10
    const shipped = LAP_TARGETS[def.id]
    console.log(`  ${def.id.padEnd(12)} fastest ${best.toFixed(3)} (seed ${bestSeed}, slot ${bestSlot})  target ${target.toFixed(1)}` +
      `${shipped !== target ? `  <-- SHIPPED ${shipped}` : ''}   race-best p50 ${q(raceBests, 0.5).toFixed(2)}` +
      `   expert under ${expert.filter((x) => x < target).length}/${expert.length}` +
      `   normal fastest ${Math.min(...normal).toFixed(2)}, under ${normal.filter((x) => x < target).length}/${normal.length}`)
  }
}

// ---------------------------------------------------------------------------
// --singularity: can a player reach tier 3 where the AI never does?
// ---------------------------------------------------------------------------

/**
 * The AI never releases a drift at SINGULARITY on Meridian Deep, Halcyon Bay or
 * Zhen-9 -- its drift lines counter-steer wide through their corners, which
 * charges at `chargeAtWide`, and it lets go at NOVA. So the AI cannot answer
 * whether Drift King is earnable there. This drives a car that can: the AI's
 * own steering and throttle, but once a slide begins it holds the button, full
 * lock INTO the slide (the fastest charge), until the tier reaches 3, and
 * releases -- through the real tracker, which then has to count it.
 *
 * THREE TIMES, THEN IT RACES. Holding every slide to tier 3 costs so much
 * line that the car never finishes (measured: 37-48 releases and still out at
 * the frame cap), which proves the tier and not the badge. Three held slides
 * and then the AI's own driving is the race a player would actually run for
 * Drift King -- and it has to reach the flag.
 */
function singularity(): void {
  const ids = arg('tracks', 'abyssal,halcyon,neonspire').split(',')
  for (const id of ids) {
    const def = TRACKS.find((t) => t.id === id)
    if (!def) continue
    resetAI()
    const cfg = fieldConfig(def, 'normal', 1)
    cfg.localRacerIndex = 0
    const race = new Race(new Track(def), cfg)
    const st = race.state
    const me = st.racers[0]
    const rng = new Rng(4242)
    const tracker = new RaceTracker()
    tracker.begin(0, def.id)
    let holding = false
    let frames = 0
    let longest = 0
    let forced = 0
    while (frames < 60 * 420 && !me.finished) {
      const inp = stepAI(me, st, race.track, rng)
      if (me.driftSide !== 0 && forced < 3) holding = true
      if (holding) {
        if (me.driftTier >= 3 || me.driftSide === 0) {
          if (me.driftTier >= 3) forced++
          inp.drift = false
          holding = false
        } else {
          inp.drift = true
          inp.steer = me.driftSide
        }
      }
      race.setInput(0, inp)
      race.step()
      longest = Math.max(longest, me.driftTime)
      tracker.step(st)
      frames++
    }
    const f = tracker.facts(st, {
      difficulty: 'normal', multiplayer: false, score: 0, bestCombo: 1, circuit: null, sweep: false,
    })
    console.log(`  ${def.name.padEnd(14)} SINGULARITY releases ${f.singularity}  (longest slide ${longest.toFixed(2)}s, ` +
      `finished ${me.finished} P${me.position})  -> Drift King ${f.singularity >= 3 ? 'REACHABLE' : 'not shown'}`)
    if (f.singularity < 3) process.exitCode = 1
  }
}

if (process.argv[1] && process.argv[1].includes('probe-achievements')) {
  if (flag('laps')) laps()
  else if (flag('singularity')) singularity()
  else signals()
}
