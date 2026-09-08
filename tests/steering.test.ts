import { describe, it, expect } from 'vitest'
import { Race } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { RUSTFALL } from '../src/content/tracks/rustfall'
import { resetAI } from '../src/sim/ai'
import { emptyInput } from '../src/sim/types'
import type { SimConfig } from '../src/sim/types'

/**
 * Steering direction, asserted against the same basis the renderer uses.
 *
 * The chase camera looks along the vehicle's forward vector, so what the
 * player sees as "right" is `forward x up` — which is also how Track defines
 * its own `right`. A positive lateral offset therefore means the car moved to
 * the player's right. This caught a real inversion where the vehicle used +X
 * as right while the track and camera both used -X.
 */
const cfg = (): SimConfig => ({
  seed: 1, totalLaps: 3, racerCount: 1, trackId: 'rustfall',
  chassisIds: ['solaire'], pilotIds: ['pip'],
  localRacerIndex: 0, aiSkill: [0],
})

function driveWithSteer(steer: number, seconds: number) {
  resetAI()
  const track = new Track(RUSTFALL)
  const race = new Race(track, cfg())
  const r = race.state.racers[0]

  // Skip the countdown so the throttle is live.
  while (race.state.phase === 'countdown') race.step()

  const startLateral = r.lateral
  const input = emptyInput()
  input.throttle = 1
  input.steer = steer
  for (let f = 0; f < Math.round(seconds * 60); f++) {
    race.setInput(0, input)
    race.step()
  }
  return { lateralDelta: r.lateral - startLateral, racer: r, track }
}

describe('steering direction', () => {
  it('steering right (+1) moves the car to the player right', () => {
    const { lateralDelta } = driveWithSteer(1, 1.6)
    expect(lateralDelta).toBeGreaterThan(1.5)
  })

  it('steering left (-1) moves the car to the player left', () => {
    const { lateralDelta } = driveWithSteer(-1, 1.6)
    expect(lateralDelta).toBeLessThan(-1.5)
  })

  it('left and right are mirror images of each other', () => {
    const right = driveWithSteer(1, 1.2).lateralDelta
    const left = driveWithSteer(-1, 1.2).lateralDelta
    expect(Math.abs(right + left)).toBeLessThan(Math.abs(right) * 0.35)
  })

  it('no steering holds the racing line', () => {
    const { lateralDelta } = driveWithSteer(0, 1.6)
    expect(Math.abs(lateralDelta)).toBeLessThan(1.5)
  })

  it('the vehicle right basis matches the track right basis', () => {
    const track = new Track(RUSTFALL)
    for (const s of [0, 300, 900, 1500, 2100]) {
      const smp = track.at(s)
      const yaw = track.yawAt(s)
      // forward x up, the definition vehicle.ts and Track must agree on.
      const rx = -Math.cos(yaw)
      const rz = Math.sin(yaw)
      const dot = rx * smp.right.x + rz * smp.right.z
      expect(dot).toBeGreaterThan(0.9)
    }
  })
})
