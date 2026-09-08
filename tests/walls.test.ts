import { describe, it, expect } from 'vitest'
import { Race } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { TEST_BOUNCE_RING } from './fixtures/testTrack'
import { RUSTFALL } from '../src/content/tracks/rustfall'
import { deriveChassis, CHASSIS_BY_ID } from '../src/content/chassis'
import { resetAI } from '../src/sim/ai'
import { emptyInput } from '../src/sim/types'
import type { SimConfig } from '../src/sim/types'

const CHASSIS_ID = 'dray9'

const solo = (): SimConfig => ({
  seed: 9, totalLaps: 9, racerCount: 1, trackId: 'test-bounce',
  chassisIds: [CHASSIS_ID], pilotIds: ['pip'], localRacerIndex: 0, aiSkill: [0],
})

/**
 * Drive a lone racer down the narrow bounce corridor with the stick held over,
 * so it scrapes the barrier continuously instead of touching it once. The
 * corridor carries no item boxes and no charge runs, so the ONLY thing that can
 * put the car above its own top speed is the wall response.
 */
function scrape(steer: number, frames: number) {
  resetAI()
  const race = new Race(new Track(TEST_BOUNCE_RING), solo())
  const r = race.state.racers[0]
  while (race.state.phase === 'countdown') race.step()
  const input = emptyInput()
  input.throttle = 1
  input.steer = steer
  let peak = 0
  let contact = 0
  for (let f = 0; f < frames; f++) {
    race.setInput(0, input); race.step()
    if (r.events.some((e) => e.t === 'wall')) contact++
    peak = Math.max(peak, Math.hypot(r.vel.x, r.vel.z))
  }
  return { peak, contact, r }
}

describe('bounce walls redirect momentum, they do not create it', () => {
  const top = deriveChassis(CHASSIS_BY_ID[CHASSIS_ID].stats).topSpeed

  it('cannot be pumped by holding a line into the wall', () => {
    // Shallow angles, and both signs. Shallow is where a per-contact gain does
    // the most damage -- the car keeps almost all its along-wall speed and adds
    // to it every frame -- and the old additive push reached 1.17x top speed
    // here on throttle alone. The sign matters because the push is taken off
    // the along-wall direction, so a sign slip would show on one side only.
    for (const steer of [0.08, -0.08]) {
      const { peak, contact } = scrape(steer, 60 * 30)
      expect(contact, `frames of wall contact at steer ${steer}`).toBeGreaterThan(200)
      // No items, no charges, no boost pads on this rig: top speed is the roof.
      expect(peak, `peak ${peak.toFixed(1)} vs top speed ${top.toFixed(1)} at steer ${steer}`)
        .toBeLessThanOrEqual(top + 0.5)
    }
  })

  it('stays lively — a single hit keeps its speed instead of scrubbing it off', () => {
    // One contact, measured across the frame it happens on. A normal barrier
    // scrubs 5-40% depending on the angle; a bounce wall converts the into-wall
    // component into travel along the wall and should give almost all of it
    // back. This is the half of the invariant the pump fix must not break.
    resetAI()
    const race = new Race(new Track(TEST_BOUNCE_RING), solo())
    const r = race.state.racers[0]
    while (race.state.phase === 'countdown') race.step()
    const run = emptyInput(); run.throttle = 1
    for (let f = 0; f < 60 * 12; f++) { race.setInput(0, run); race.step() }
    // Aim into the barrier. Throttle stays on -- at top speed the accelerator
    // adds almost nothing per frame (the headroom term has collapsed), while
    // coasting sheds 0.5 m/s every frame and would swamp the measurement.
    r.yaw += 0.45
    let before = 0, after = 0
    for (let f = 0; f < 60 * 3; f++) {
      before = Math.hypot(r.vel.x, r.vel.z)
      race.setInput(0, run); race.step()
      if (r.events.some((e) => e.t === 'wall')) {
        after = Math.hypot(r.vel.x, r.vel.z)
        break
      }
    }
    expect(before, 'expected a wall hit at speed').toBeGreaterThan(20)
    expect(after / before, `kept ${(after / before * 100).toFixed(1)}% of entry speed`)
      .toBeGreaterThan(0.9)
    // Upper bound lives in the pump test above; here the only concern is that
    // the fix did not turn a bounce wall into a brake.
    expect(after / before).toBeLessThan(1.02)
  })

  it('holds a full field under the design speed maximum on Rustfall', () => {
    resetAI()
    const race = new Race(new Track(RUSTFALL), {
      seed: 31, totalLaps: 3, racerCount: 8, trackId: 'rustfall',
      chassisIds: ['solaire','filament','bulwark','dray9','vector7','solaire','filament','bulwark'],
      pilotIds: Array.from({ length: 8 }, () => 'pip'),
      localRacerIndex: -1, aiSkill: Array.from({ length: 8 }, () => 3),
    })
    const idle = emptyInput()
    let max = 0
    let wallOverspeed = 0
    for (let f = 0; f < 60 * 200; f++) {
      race.setInput(0, idle); race.step()
      for (const r of race.state.racers) {
        const sp = Math.hypot(r.vel.x, r.vel.z)
        max = Math.max(max, sp)
        if (sp > 108 && r.events.some((e) => e.t === 'wall')) wallOverspeed++
      }
    }
    // 68 m/s top x 1.52 boost x 1.05 charges = ~108 m/s by design.
    expect(max).toBeLessThan(108)
    expect(wallOverspeed, 'overspeed frames attributable to a wall').toBe(0)
  })
})
