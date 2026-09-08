/**
 * Headless race runner. Two jobs:
 *  1. The determinism gate: a fixed seed plus a fixed input tape must always
 *     produce the same state hash.
 *  2. A smoke test that races actually complete rather than stalling.
 * Runs in plain Node with no browser, which is only possible because
 * src/sim has zero DOM or Three.js imports.
 */
import { Race } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { TRACKS_BY_ID, RUSTFALL } from '../src/content/tracks'

/** --track=cryostatic runs the gate on a different circuit. */
const trackArg = process.argv.find((a) => a.startsWith('--track='))
const TRACK_DEF = (trackArg && TRACKS_BY_ID[trackArg.slice(8)]) || RUSTFALL
import { CHASSIS } from '../src/content/chassis'
import { PILOTS } from '../src/content/pilots'
import { resetAI } from '../src/sim/ai'
import { emptyInput } from '../src/sim/types'
import type { SimConfig } from '../src/sim/types'

export function makeConfig(seed: number, racerCount = 8, laps = 3): SimConfig {
  return {
    seed,
    totalLaps: laps,
    racerCount,
    trackId: TRACK_DEF.id,
    chassisIds: Array.from({ length: racerCount }, (_, i) => CHASSIS[i % CHASSIS.length].id),
    pilotIds: Array.from({ length: racerCount }, (_, i) => PILOTS[i % PILOTS.length].id),
    localRacerIndex: -1, // all AI
    aiSkill: Array.from({ length: racerCount }, (_, i) => 2 + (i % 3)),
  }
}

export function runRace(seed: number, maxFrames = 60 * 400, racerCount = 8, laps = 3) {
  resetAI()
  const track = new Track(TRACK_DEF)
  const race = new Race(track, makeConfig(seed, racerCount, laps))
  const idle = emptyInput()
  let frames = 0
  while (frames < maxFrames && race.state.phase !== 'finished') {
    for (const r of race.state.racers) if (!r.isAI) race.setInput(r.id, idle)
    race.step()
    frames++
  }
  return { race, frames, track }
}

function main() {
  const args = process.argv.slice(2)
  const assert = args.includes('--assert')

  const track = new Track(TRACK_DEF)
  console.log(`track: ${TRACK_DEF.name}  length ${track.length.toFixed(1)}m  samples ${track.samples.length}`)

  // --- Determinism: 600 frames from a fixed seed, run twice ----------------
  const hashes: string[] = []
  for (let pass = 0; pass < 2; pass++) {
    resetAI()
    const t = new Track(TRACK_DEF)
    const race = new Race(t, makeConfig(1337))
    const idle = emptyInput()
    for (let f = 0; f < 600; f++) { race.setInput(0, idle); race.step() }
    hashes.push(race.hash())
  }
  const deterministic = hashes[0] === hashes[1]
  console.log(`determinism (600 frames): ${hashes[0]} vs ${hashes[1]}  ${deterministic ? 'STABLE' : 'DIVERGED'}`)

  // --- Smoke: a full race must complete ------------------------------------
  const t0 = Date.now()
  const { race, frames } = runRace(20260904)
  const ms = Date.now() - t0
  const finished = race.state.phase === 'finished'
  const results = race.results()
  console.log(`race completed: ${finished}  frames ${frames}  wall ${ms}ms  (${(frames / (ms / 1000)).toFixed(0)} sim fps)`)
  console.log('results:')
  for (const r of results) {
    console.log(`  P${r.position}  ${r.chassisId.padEnd(9)}  total ${r.time.toFixed(2)}s  best lap ${r.bestLap.toFixed(2)}s`)
  }

  const lapTimes = race.state.racers.flatMap((r) => r.lapTimes).filter((x) => x > 0)
  const avgLap = lapTimes.reduce((a, b) => a + b, 0) / Math.max(1, lapTimes.length)
  console.log(`average lap: ${avgLap.toFixed(2)}s  (GDD target 55-75s)`)

  if (assert) {
    const fails: string[] = []
    if (!deterministic) fails.push('determinism hash diverged across identical runs')
    if (!finished) fails.push(`race did not finish within ${frames} frames`)
    if (lapTimes.length === 0) fails.push('no laps were completed')
    if (track.length < 400) fails.push(`track length ${track.length.toFixed(0)}m is implausibly short`)
    if (fails.length) {
      console.error('\nGATE FAILED:')
      for (const f of fails) console.error('  - ' + f)
      process.exit(1)
    }
    console.log('\nGATE PASSED')
  }
}

if (process.argv[1] && process.argv[1].includes('headless')) main()
