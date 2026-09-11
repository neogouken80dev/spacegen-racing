import { describe, it, expect } from 'vitest'
import { Race } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { TEST_PLAIN } from './fixtures/testTrack'
import { RUSTFALL } from '../src/content/tracks/rustfall'
import { resetAI } from '../src/sim/ai'
import { emptyInput } from '../src/sim/types'
import { TUNING as T } from '../src/content/tuning'
import { angleDelta } from '../src/sim/math'
import type { SimConfig } from '../src/sim/types'

const cfg = (): SimConfig => ({
  seed: 21, totalLaps: 3, racerCount: 1, trackId: 'test-plain',
  chassisIds: ['solaire'], pilotIds: [''], localRacerIndex: 0, aiSkill: [0],
})

function ready(track: Track) {
  resetAI()
  const race = new Race(track, cfg())
  const r = race.state.racers[0]
  while (race.state.phase === 'countdown') race.step()
  const warm = emptyInput(); warm.throttle = 1
  for (let f = 0; f < 900; f++) {
    race.setInput(0, warm); race.step()
    if (r.grounded && Math.hypot(r.vel.x, r.vel.z) > 45) break
  }
  return { race, r }
}

describe('spin recovery faces the racing direction', () => {
  it('finishes a spin-out pointing down the track, not back into traffic', () => {
    const track = new Track(TEST_PLAIN)
    for (const startYaw of [0, 1.4, -1.4, 3.0]) {
      const { race, r } = ready(track)
      // Spin the racer from a range of starting headings, including backwards.
      r.yaw = track.yawAt(r.splineS) + startYaw
      r.spinTime = 1.6
      const idle = emptyInput()
      for (let f = 0; f < 60 * 4; f++) {
        race.setInput(0, idle); race.step()
        if (r.spinTime <= 0) break
      }
      const err = Math.abs(angleDelta(r.yaw, track.yawAt(r.splineS)))
      expect(
        err,
        `after a spin starting ${startYaw.toFixed(1)} rad off, ended ${err.toFixed(2)} rad off`,
      ).toBeLessThan(0.45)
    }
  })

  it('never leaves a spun racer facing backwards', () => {
    const track = new Track(RUSTFALL)
    resetAI()
    const race = new Race(track, {
      seed: 4, totalLaps: 3, racerCount: 8, trackId: 'rustfall',
      chassisIds: ['solaire','filament','bulwark','dray9','vector7','solaire','filament','bulwark'],
      pilotIds: Array.from({ length: 8 }, () => ''),
      localRacerIndex: -1, aiSkill: Array.from({ length: 8 }, () => 3),
    })
    let worstBackwards = 0
    let f = 0
    while (f < 60 * 260 && race.state.phase !== 'finished') {
      race.step(); f++
      for (const r of race.state.racers) {
        if (r.finished || r.respawnTime > 0 || r.spinTime > 0) continue
        if (Math.hypot(r.vel.x, r.vel.z) < 4) continue
        const err = Math.abs(angleDelta(r.yaw, track.yawAt(r.splineS)))
        if (err > worstBackwards) worstBackwards = err
      }
    }
    // Under 120 degrees: a racer may be sideways recovering, never driving back
    // down the circuit under power.
    expect(worstBackwards).toBeLessThan(2.1)
  })

  it('turns a stationary backwards racer around on its own', () => {
    const track = new Track(TEST_PLAIN)
    const { race, r } = ready(track)
    r.vel.x = 0; r.vel.z = 0
    r.yaw = track.yawAt(r.splineS) + Math.PI
    const idle = emptyInput()
    for (let f = 0; f < 60 * 4; f++) { race.setInput(0, idle); race.step() }
    expect(Math.abs(angleDelta(r.yaw, track.yawAt(r.splineS)))).toBeLessThan(T.offTrack.wrongWayAngle)
  })
})

describe('drift entry is immediate', () => {
  // NOTE: this is about the NOSE only. The slide angle deliberately does NOT
  // arrive on frame one -- it builds as the nose rotates ahead of the momentum,
  // which is what removes the kick-out. tests/drift.test.ts owns that invariant
  // ("entry rotates the car, it never throws it sideways"); an earlier version
  // of this test asserted the opposite and had to go.
  it('bites on the entry frame, rather than over a third of a second', () => {
    const track = new Track(TEST_PLAIN)
    const { race, r } = ready(track)
    const drift = { ...emptyInput(), throttle: 1, steer: 1, drift: true }

    race.setInput(0, drift); race.step()   // entry frame
    const yawEntry = Math.abs(r.yawRate)

    for (let f = 0; f < 40; f++) { race.setInput(0, drift); race.step() }
    const yawSustained = Math.abs(r.yawRate)

    // Full arc on frame one. It is ABOVE the settled value, not merely at it,
    // because the arc eases off over the slide -- so this doubles as a check
    // that the ease starts from the full bite rather than ramping up to it.
    expect(yawEntry).toBeGreaterThan(yawSustained)
    expect(yawEntry / yawSustained).toBeLessThan(1.6)
  })

  it('turns in tighter than the previous tuning ever did', () => {
    const track = new Track(TEST_PLAIN)
    const { race, r } = ready(track)
    const drift = { ...emptyInput(), throttle: 1, steer: 1, drift: true }
    race.setInput(0, drift); race.step()
    const speed = Math.hypot(r.vel.x, r.vel.z)
    const radius = speed / Math.max(1e-3, Math.abs(r.yawRate))
    // Measured at TURN-IN, which is what "tighter" means to a driver entering a
    // corner. The sustained arc is a separate question and is deliberately
    // eased: holding the entry rate forever is a constant-radius spiral that
    // winds into the inside barrier.
    // The old arc (1.35 + 1.10*maxYaw) gave Solaire ~3.62 rad/s; the bite is
    // now ~4.27.
    const oldArc = (1.35 + 1.10 * (55 + 7 * 9) * (Math.PI / 180))
    const oldRadius = speed / (oldArc * (1 / (1 + speed / T.steering.yawSpeedFalloff)))
    expect(radius).toBeLessThan(oldRadius * 0.94)
  })
})

describe('wrong-way recovery is a rescue, not an override', () => {
  // T.offTrack.wrongWayRate is 2.6 rad/s against a roster-maximum steering
  // authority of 2.37 rad/s (Filament, and that is before the speed falloff),
  // so once the block is armed it out-rotates every chassis at every speed.
  // That is correct for a car nobody is driving and wrong for one somebody is.
  it('does not fight a player who is deliberately reversing', () => {
    const track = new Track(TEST_PLAIN)
    const { race, r } = ready(track)
    // Spun right round and backing down the track under power -- the normal way
    // out of a wall. A reverse always STARTS from a standstill, so gating the
    // block on speed alone leaves the first two seconds of every one of them
    // unprotected: measured 81 degrees of forced rotation before the reverse
    // even reached T.offTrack.wrongWaySpeed.
    r.vel.x = 0; r.vel.z = 0
    r.yaw = track.yawAt(r.splineS) + Math.PI
    const rev = { ...emptyInput(), brake: 1 }
    for (let f = 0; f < 60 * 3; f++) { race.setInput(0, rev); race.step() }
    expect(Math.abs(angleDelta(r.yaw, track.yawAt(r.splineS)))).toBeGreaterThan(Math.PI - 0.35)
  })

  it('lets a player steer where they want instead of dragging the nose back', () => {
    const track = new Track(TEST_PLAIN)
    const { race, r } = ready(track)
    r.vel.x = 0; r.vel.z = 0
    // 2.0 rad off, so the block is armed, and steering the way that takes the
    // car FURTHER off -- the one direction the recovery genuinely opposes.
    r.yaw = track.yawAt(r.splineS) + 2.0
    const y0 = r.yaw
    const held = { ...emptyInput(), steer: -1 }
    for (let f = 0; f < 30; f++) { race.setInput(0, held); race.step() }
    // Half a second of full lock has to rotate the car the way the PLAYER
    // asked. STEER_SIGN: steering left raises yaw, here at 2.06 rad/s against
    // the block's 2.6, so with the block armed the nose goes the OTHER way.
    expect(angleDelta(y0, r.yaw)).toBeGreaterThan(0.4)
  })
})
