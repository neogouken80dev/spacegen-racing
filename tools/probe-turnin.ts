/**
 * WHICH DRIFT NUMBER IS VINCE ACTUALLY FEELING?
 *
 * Two things changed the drift in bae3e08 and either could be described as
 * "the turn-in change":
 *
 *   boostArcRelief    how much of the speed falloff a committed drift is
 *                     excused WHILE BOOSTING. Changes how hard the car rotates.
 *   reentryThreshold  how far the stick must travel to re-enter a drift for
 *                     0.45s after releasing one. Changes how easily it engages.
 *
 * Turning down the wrong one costs a whole build-and-push cycle, so measure
 * both instead of picking the one that sounds right. Crucially, reentry is
 * measured THROUGH THE REAL KEYBOARD STEERING RAMP -- the threshold is a
 * distance along a stick that takes time to travel, and the interesting
 * quantity is the time, not the distance.
 *
 *   npx tsx tools/probe-turnin.ts
 */
import { Race } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { TEST_PLAIN } from '../tests/fixtures/testTrack'
import { resetAI } from '../src/sim/ai'
import { emptyInput } from '../src/sim/types'
import { TUNING as T } from '../src/content/tuning'
import { rampAxis } from '../src/game/touchControls'
import type { SimConfig, InputFrame } from '../src/sim/types'

const DT = T.sim.dt
const mut = T as unknown as {
  drift: { boostArcRelief: number; reentryThreshold: number }
}

const cfg = (chassisId: string): SimConfig => ({
  seed: 5, totalLaps: 3, racerCount: 1, trackId: 'test-plain',
  chassisIds: [chassisId], pilotIds: [''],
  localRacerIndex: 0, aiSkill: [0],
})

function fresh(chassisId: string) {
  resetAI()
  const race = new Race(new Track(TEST_PLAIN), cfg(chassisId))
  const r = race.state.racers[0]
  while (race.state.phase === 'countdown') race.step()
  const warm = { ...emptyInput(), throttle: 1 }
  for (let f = 0; f < 900; f++) {
    race.setInput(0, warm)
    race.step()
    if (r.grounded && Math.hypot(r.vel.x, r.vel.z) > 55) break
  }
  return { race, r }
}

function run(race: ReturnType<typeof fresh>['race'], input: InputFrame, frames: number) {
  for (let f = 0; f < frames; f++) { race.setInput(0, input); race.step() }
}

/**
 * THE REAL CASE. Hold a drift, release it (which grants the boost), then drift
 * straight into the next corner -- which is what a player does every time, and
 * is exactly the window boostArcRelief governs.
 */
function chainedDrift(chassisId: string): { yaw: number; speed: number; boost: number } {
  const { race, r } = fresh(chassisId)
  // A committed left slide, long enough to bank a real tier.
  run(race, { ...emptyInput(), throttle: 1, steer: -1, drift: true }, Math.round(2.4 / DT))
  // Release: the boost fires here.
  run(race, { ...emptyInput(), throttle: 1 }, 3)
  const boostAtEntry = r.boostMag
  // Straight into the opposite drift, full lock, inside the boost window.
  const input = { ...emptyInput(), throttle: 1, steer: 1, drift: true }
  let sumYaw = 0
  let sumSpeed = 0
  let n = 0
  for (let f = 0; f < Math.round(0.8 / DT); f++) {
    race.setInput(0, input); race.step()
    if (r.driftSide !== 0 && r.boostTime > 0) {
      sumYaw += Math.abs(r.yawRate); sumSpeed += Math.hypot(r.vel.x, r.vel.z); n++
    }
  }
  return n === 0
    ? { yaw: 0, speed: 0, boost: boostAtEntry }
    : { yaw: sumYaw / n, speed: sumSpeed / n, boost: boostAtEntry }
}

/** The same slide with no boost at all: what a drift turn-in has always felt like. */
function coldDrift(chassisId: string): { yaw: number; speed: number } {
  const { race, r } = fresh(chassisId)
  const input = { ...emptyInput(), throttle: 1, steer: 1, drift: true }
  let sumYaw = 0, sumSpeed = 0, n = 0
  for (let f = 0; f < Math.round(3.2 / DT); f++) {
    race.setInput(0, input); race.step()
    if (r.driftSide !== 0 && r.boostTime <= 0 && f > 30) {
      sumYaw += Math.abs(r.yawRate); sumSpeed += Math.hypot(r.vel.x, r.vel.z); n++
    }
  }
  return { yaw: n ? sumYaw / n : 0, speed: n ? sumSpeed / n : 0 }
}

/**
 * How many frames from releasing a left drift to the right one engaging, with
 * the stick moving at the rate a KEY actually moves it.
 */
function reentryFrames(chassisId: string): number {
  const { race, r } = fresh(chassisId)
  let stick = 0
  // Ramp into a left drift and hold it.
  for (let f = 0; f < Math.round(2.4 / DT); f++) {
    stick = rampAxis(stick, -1, DT)
    race.setInput(0, { ...emptyInput(), throttle: 1, drift: true, steer: stick }); race.step()
  }
  // Release, and steer the other way. The drift button is NOT re-pressed while
  // the stick is still on the old side: pressing it there re-enters the SAME
  // drift, which is true at either threshold and so tells us nothing. A player
  // flipping sides presses again as the stick crosses, and THAT is where the
  // threshold decides how long the car ignores them.
  let frames = 0
  for (let f = 0; f < 90; f++) {
    stick = rampAxis(stick, 1, DT)
    const wantDrift = stick > 0
    race.setInput(0, { ...emptyInput(), throttle: 1, drift: wantDrift, steer: stick })
    race.step()
    frames++
    if (r.driftSide > 0) return frames
  }
  return -1
}

const CHASSIS = ['solaire', 'filament', 'bulwark', 'dray9', 'vector7']

console.log('=== boostArcRelief: yaw rate of a drift taken INSIDE the release boost ===')
console.log('(rad/s, averaged over the first 0.8s of the follow-up slide)\n')
const cold: Record<string, number> = {}
for (const c of CHASSIS) cold[c] = coldDrift(c).yaw
const relief = [0, 0.25, 0.45, 0.55, 0.65, 0.85]
console.log(['relief', ...CHASSIS].map((s) => s.padEnd(10)).join(''))
const rows: Record<number, Record<string, number>> = {}
for (const v of relief) {
  mut.drift.boostArcRelief = v
  rows[v] = {}
  const cells = [String(v).padEnd(10)]
  for (const c of CHASSIS) {
    const y = chainedDrift(c).yaw
    rows[v][c] = y
    cells.push(y.toFixed(3).padEnd(10))
  }
  console.log(cells.join(''))
}
mut.drift.boostArcRelief = 0.85

console.log('\ncold drift (no boost), same stick, for reference:')
console.log(['', ...CHASSIS].map((s) => s.padEnd(10)).join(''))
console.log(['cold'.padEnd(10), ...CHASSIS.map((c) => cold[c].toFixed(3).padEnd(10))].join(''))

console.log('\nboosted turn-in as a multiple of the OLD behaviour (relief 0):')
console.log(['relief', ...CHASSIS].map((s) => s.padEnd(10)).join(''))
for (const v of relief) {
  const cells = [String(v).padEnd(10)]
  for (const c of CHASSIS) {
    const base = rows[0][c]
    cells.push((base > 0 ? rows[v][c] / base : 0).toFixed(2).concat('x').padEnd(10))
  }
  console.log(cells.join(''))
}

console.log('\n=== reentryThreshold: frames from release to the opposite drift engaging ===')
console.log('(keyboard ramp: cross 0.055s, attack 0.120s)\n')
console.log(['thresh', ...CHASSIS].map((s) => s.padEnd(10)).join(''))
for (const v of [0.45, 0.7, 1.0]) {
  mut.drift.reentryThreshold = v
  const cells = [String(v).padEnd(10)]
  for (const c of CHASSIS) cells.push(String(reentryFrames(c)).padEnd(10))
  console.log(cells.join(''))
}
mut.drift.reentryThreshold = 0.45
