import { describe, it, expect } from 'vitest'
import { Track } from '../src/sim/track'
import { RUSTFALL } from '../src/content/tracks/rustfall'
import { TUNING as T } from '../src/content/tuning'
import { CHASSIS, deriveChassis } from '../src/content/chassis'

/**
 * A booster ramp is only as good as where it puts you down. These assert that
 * every ramp has a landing zone the spline actually reaches, for the whole
 * speed range of the roster — eyeballing a ramp in the editor is exactly how
 * you ship one that drops the fastest chassis into a wall.
 */
const track = new Track(RUSTFALL)
const G = Math.abs(T.sim.gravity)

interface Ramp { s: number; power: number; airtime: number }

const ramps: Ramp[] = []
{
  const m = track.samples.length
  let last = -999
  for (let i = 0; i < m; i++) {
    const smp = track.samples[i]
    if (smp.ramp > 0) {
      const s = (i / m) * track.length
      // One authored ramp node bakes into a run of samples, so group generously:
      // this must count ramps, not samples.
      if (s - last > 90) { ramps.push({ s, power: smp.ramp, airtime: (2 * smp.ramp) / G }); last = s }
    }
  }
}

describe('booster ramps', () => {
  it('exist on the track', () => {
    expect(ramps.length).toBeGreaterThanOrEqual(3)
  })

  it('give between 1.2s and 2.6s of airtime', () => {
    for (const r of ramps) {
      expect(r.airtime).toBeGreaterThan(1.2)
      expect(r.airtime).toBeLessThan(2.6)
    }
  })

  it('can be flown back onto the racing line with the air control available', () => {
    // The kart is not a cannonball: air control gives roughly 65 deg/s. What
    // matters is whether the heading change the track demands during the flight
    // is inside that budget, with margin, for a player who is actually steering.
    const problems: string[] = []
    for (const r of ramps) {
      for (const c of CHASSIS) {
        const maxYaw = deriveChassis(c.stats).maxYawRate * T.ramp.airControl
        const speed = deriveChassis(c.stats).topSpeed * (1 + T.drift.tierBoost[3])
        const dist = speed * r.airtime
        const a = track.at(r.s).tangent
        const b = track.at(r.s + dist).tangent
        const cross = a.z * b.x - a.x * b.z
        const dot = Math.max(-1, Math.min(1, a.x * b.x + a.z * b.z))
        const need = Math.abs(Math.atan2(cross, dot)) / r.airtime
        // 60% of the available rate, so it is comfortable rather than perfect.
        if (need > maxYaw * 0.6) {
          problems.push(
            `ramp at s=${r.s.toFixed(0)}m: ${c.id} needs ${(need * 57.3).toFixed(0)} deg/s ` +
            `over a ${dist.toFixed(0)}m flight, only ${(maxYaw * 57.3).toFixed(0)} deg/s available`,
          )
        }
      }
    }
    expect(problems.slice(0, 6)).toEqual([])
  })

  it('never launches into a corner tight enough to be unlandable', () => {
    const bad: string[] = []
    for (const r of ramps) {
      const slow = 40 * r.airtime
      for (let d = 20; d < slow; d += 10) {
        const k = Math.abs(track.curvatureAt(r.s + d, 20))
        if (k > 0.016) bad.push(`ramp at s=${r.s.toFixed(0)}m flies into curvature ${k.toFixed(4)} at +${d}m`)
      }
    }
    expect(bad.slice(0, 4)).toEqual([])
  })

  it('spreads the ramps around the lap rather than bunching them', () => {
    const gaps: number[] = []
    for (let i = 0; i < ramps.length; i++) {
      const next = ramps[(i + 1) % ramps.length]
      let g = next.s - ramps[i].s
      if (g < 0) g += track.length
      gaps.push(g)
    }
    for (const g of gaps) expect(g).toBeGreaterThan(track.length * 0.12)
  })
})

describe('ramps launch every locomotion class', () => {
  it('gets a hover and a flight chassis airborne, not just grounded ones', async () => {
    const { Race } = await import('../src/sim/race')
    const { resetAI } = await import('../src/sim/ai')
    const { emptyInput } = await import('../src/sim/types')

    // Find the main-straight ramp so the run-up is long and flat.
    const m = track.samples.length
    let rampS = 0
    for (let i = 0; i < m; i++) if (track.samples[i].ramp > 0) { rampS = (i / m) * track.length; break }

    for (const chassisId of ['solaire', 'filament', 'vector7']) {
      resetAI()
      const race = new Race(track, {
        seed: 3, totalLaps: 3, racerCount: 1, trackId: 'rustfall',
        chassisIds: [chassisId], pilotIds: ['pip'], localRacerIndex: 0, aiSkill: [0],
      })
      const r = race.state.racers[0]
      while (race.state.phase === 'countdown') race.step()

      // Line up 90m before the ramp at speed, pointing down the track.
      const startS = rampS - 90
      const sp = track.surfacePoint(startS, 0)
      r.pos.x = sp.x; r.pos.y = sp.y + 1; r.pos.z = sp.z
      r.yaw = track.yawAt(startS); r.splineS = startS
      const v = 55
      r.vel.x = Math.sin(r.yaw) * v; r.vel.z = Math.cos(r.yaw) * v

      const go = emptyInput(); go.throttle = 1
      let peakAlt = 0
      let launched = false
      for (let f = 0; f < 60 * 6; f++) {
        race.setInput(0, go)
        race.step()
        if (r.events.some((e) => e.t === 'ramp')) launched = true
        if (launched) peakAlt = Math.max(peakAlt, r.altitude)
        if (launched && r.grounded && peakAlt > 1) break
      }
      expect(launched, `${chassisId} never triggered the ramp`).toBe(true)
      expect(peakAlt, `${chassisId} barely left the ground (${peakAlt.toFixed(1)}m)`).toBeGreaterThan(6)
    }
  })
})
