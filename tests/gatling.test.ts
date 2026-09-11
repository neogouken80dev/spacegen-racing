import { describe, it, expect } from 'vitest'
import { Race } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { TEST_PLAIN } from './fixtures/testTrack'
import { resetAI } from '../src/sim/ai'
import { emptyInput } from '../src/sim/types'
import { ITEM_PARAMS, ITEM_ORDER, ITEM_DISTRIBUTION } from '../src/content/items'
import type { SimConfig } from '../src/sim/types'

const P = ITEM_PARAMS.laserGatling

const cfg = (): SimConfig => ({
  seed: 11, totalLaps: 3, racerCount: 2, trackId: 'test-plain',
  chassisIds: ['solaire', 'solaire'], pilotIds: ['pip', 'pip'],
  localRacerIndex: 0, aiSkill: [0, 0],
})

/**
 * Shooter and victim placed ON the spline, the victim a fixed gap ahead.
 * `pin()` re-seats them every frame so the test measures the weapon rather
 * than the driving — the test track is a ring, so the world origin is off-track.
 */
function rig(gapMetres: number, lateral = 0) {
  resetAI()
  const track = new Track(TEST_PLAIN)
  const race = new Race(track, cfg())
  while (race.state.phase === 'countdown') race.step()
  const [shooter, victim] = race.state.racers

  const baseS = 400
  const pin = (): void => {
    const sp = track.surfacePoint(baseS, 0)
    shooter.pos.x = sp.x; shooter.pos.y = sp.y + 0.55; shooter.pos.z = sp.z
    shooter.yaw = track.yawAt(baseS)
    shooter.vel.x = 0; shooter.vel.y = 0; shooter.vel.z = 0
    shooter.splineS = baseS

    // Place the victim `gapMetres` straight ahead along the shooter's heading,
    // offset sideways by `lateral`, so the aiming cone is what is under test.
    const fx = Math.sin(shooter.yaw), fz = Math.cos(shooter.yaw)
    const rx = -Math.cos(shooter.yaw), rz = Math.sin(shooter.yaw)
    victim.pos.x = sp.x + fx * gapMetres + rx * lateral
    victim.pos.y = sp.y + 0.55
    victim.pos.z = sp.z + fz * gapMetres + rz * lateral
    victim.yaw = shooter.yaw
    victim.vel.x = 0; victim.vel.y = 0; victim.vel.z = 0
    victim.splineS = baseS + gapMetres
  }
  pin()
  return { race, shooter, victim, pin, track }
}

describe('Pulse Gatling', () => {
  it('accrues faster than it decays, so a break is actually reachable', () => {
    // The whole weapon hinges on this: accrual is fireRate * (1/fireRate) = 1.0/s.
    expect(P.breakAt / 1.0).toBeLessThan(P.fireTime)
  })

  it('breaks a target held in the sights for long enough', () => {
    const { race, shooter, victim, pin } = rig(30)
    shooter.item = 'laserGatling'
    shooter.itemCharges = 1
    shooter.rouletteTime = 0
    const fire = emptyInput(); fire.item = true
    const idle = emptyInput()

    let peak = 0
    for (let f = 0; f < 60 * 3; f++) {
      race.setInput(0, f === 0 ? fire : idle)
      race.setInput(1, idle)
      pin()
      race.step()
      peak = Math.max(peak, victim.beamCharge)
      if (victim.spinTime > 0) break
    }
    expect(peak).toBeGreaterThan(0.3)
    expect(victim.spinTime).toBeGreaterThan(0)
  })

  it('bleeds off when the beam stops, so breaking away is real counterplay', () => {
    const { race, shooter, victim, pin, track } = rig(30)
    shooter.item = 'laserGatling'; shooter.itemCharges = 1; shooter.rouletteTime = 0
    const fire = emptyInput(); fire.item = true
    const idle = emptyInput()
    /**
     * SIXTEEN FRAMES, not thirty-six.
     *
     * The window has to end with the victim PARTLY charged, because partial
     * charge is the thing that bleeds -- a broken racer's charge is reset by
     * the break itself and there is nothing left to measure.
     *
     * 36 frames was right when the gatling was hitscan at 14 rounds a second
     * and needed eleven connecting shots to break someone. It is a projectile
     * weapon now: 10 rounds a second, four hits to break, plus about an eighth
     * of a second of flight time at 30m. Over 36 frames that is a full break
     * and a reset to zero, which read as "no charge ever accumulated".
     * 16 frames lands two rounds, for half the bar.
     */
    for (let f = 0; f < 16; f++) {
      race.setInput(0, f === 0 ? fire : idle); race.setInput(1, idle)
      pin()
      race.step()
    }
    const charged = victim.beamCharge
    expect(charged, `partial charge after 16 frames: ${charged.toFixed(3)}`)
      .toBeGreaterThan(0.1)
    expect(charged, 'must not have broken already, or there is nothing to bleed')
      .toBeLessThan(ITEM_PARAMS.laserGatling.breakAt)
    // Break line of sight: put the victim far off the firing axis.
    for (let f = 0; f < 90; f++) {
      race.setInput(0, idle); race.setInput(1, idle)
      pin()
      const away = track.surfacePoint(400, 300)
      victim.pos.x = away.x; victim.pos.z = away.z
      race.step()
    }
    expect(victim.beamCharge).toBeLessThan(charged * 0.25)
  })

  it('misses a target outside the aiming cone', () => {
    // 30m ahead but 20m to the side is well beyond a 0.115 rad half-angle.
    const { race, shooter, victim, pin } = rig(30, 20)
    shooter.item = 'laserGatling'; shooter.itemCharges = 1; shooter.rouletteTime = 0
    const fire = emptyInput(); fire.item = true
    const idle = emptyInput()
    for (let f = 0; f < 120; f++) {
      race.setInput(0, f === 0 ? fire : idle); race.setInput(1, idle)
      pin()
      race.step()
    }
    expect(victim.beamCharge).toBe(0)
    expect(victim.spinTime).toBe(0)
  })

  it('is in the distribution table without breaking the 100 per column rule', () => {
    expect(ITEM_ORDER).toContain('laserGatling')
    for (let col = 0; col < 8; col++) {
      const total = ITEM_ORDER.reduce((a, id) => a + ITEM_DISTRIBUTION[id][col], 0)
      expect(total).toBe(100)
    }
    // Mid-pack weighted: strongest around 3rd-5th, never the leader's staple.
    const row = ITEM_DISTRIBUTION.laserGatling
    expect(row[0]).toBeLessThan(row[3])
    expect(Math.max(...row)).toBe(row[3])
  })
})
