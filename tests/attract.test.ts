/**
 * THE TITLE SHOT'S RULES, WHICH ARE ALL INVISIBLE IN A SCREENSHOT.
 *
 * A wrong attract camera does not throw and does not draw a black frame -- it
 * draws a perfectly pleasant picture of the wrong thing, and the only reviewer
 * is whoever happens to look at the title screen that week. Everything here is
 * a property that a screenshot cannot confirm and a regression would not
 * announce:
 *
 *   - the push STOPS under prefers-reduced-motion, and stops at the composed
 *     frame rather than at an end of its travel;
 *   - the camera is above the road it is standing on, not inside it;
 *   - the shot is anchored to the spline, so it survives the circuit moving;
 *   - the field is dealt around the whole lap rather than bunched, which is
 *     the difference between a title screen with cars on it and one showing an
 *     empty straight (the first probe run measured zero cars from t+25s, which
 *     is what this locks down);
 *   - the pack shrinks on weak hardware instead of the feature being gated off.
 */
import { describe, it, expect } from 'vitest'
import { Track } from '../src/sim/track'
import { TRACKS_BY_ID } from '../src/content/tracks'
import { getLocomotion, getDerived, CHASSIS } from '../src/content/chassis'
import {
  ATTRACT_SHOTS, ATTRACT_TRACK, attractPose, attractRacerCount,
  makeAttractPose, pushPhase, shotFor, spreadField, type RacerStateLike,
} from '../src/game/attract'

const track = new Track(TRACKS_BY_ID[ATTRACT_TRACK])
const shot = shotFor(ATTRACT_TRACK)

describe('the attract camera', () => {
  it('holds still under prefers-reduced-motion', () => {
    const a = attractPose(shot, track, 0, true, makeAttractPose())
    const p0 = a.pos.clone()
    // Two times that would otherwise be at opposite ends of the push.
    for (const t of [shot.pushPeriod * 0.25, shot.pushPeriod * 0.75, 1e4]) {
      const b = attractPose(shot, track, t, true, makeAttractPose())
      expect(
        b.pos.distanceTo(p0),
        `reduced motion must pin the camera, but t=${t} moved it `
        + `${b.pos.distanceTo(p0).toFixed(4)}m`,
      ).toBeLessThan(1e-9)
    }
  })

  /**
   * Not merely "it stops", but "it stops HERE". Pinning the push at an end of
   * its travel would hold a composition nobody framed; the midpoint is the one
   * the shot was designed around.
   */
  it('pins reduced motion to the middle of the travel, not to an end', () => {
    expect(pushPhase(0, 96, true)).toBe(0.5)
    expect(pushPhase(48, 96, true)).toBe(0.5)
    // And the moving version really does reach both ends, so the pin is a
    // choice between them rather than the only value the function returns.
    expect(pushPhase(0, 96, false)).toBeCloseTo(0, 6)
    expect(pushPhase(48, 96, false)).toBeCloseTo(1, 6)
  })

  it('moves, but only just, when motion is allowed', () => {
    const buf = makeAttractPose()
    const a = attractPose(shot, track, 0, false, buf).pos.clone()
    const b = attractPose(shot, track, shot.pushPeriod * 0.5, false, buf).pos.clone()
    const travel = a.distanceTo(b)
    // The whole point is a move you do not notice as a move. Generous bounds:
    // the failure this guards is somebody typing 75 instead of 7.5.
    expect(travel, 'the push should be metres, not tens of metres').toBeLessThan(20)
    expect(travel, 'the push should not be zero when motion is allowed')
      .toBeGreaterThan(0.5)
  })

  it('stands above the road rather than inside it', () => {
    for (const [id, s] of Object.entries(ATTRACT_SHOTS)) {
      const t = new Track(TRACKS_BY_ID[id])
      const pose = attractPose(s, t, 0, false, makeAttractPose())
      const surf = t.surfacePoint(s.s, s.lateral)
      const n = t.at(s.s).normal
      const above = (pose.pos.x - surf.x) * n.x
        + (pose.pos.y - surf.y) * n.y + (pose.pos.z - surf.z) * n.z
      expect(above, `${id}: camera sits ${above.toFixed(2)}m above its own road`)
        .toBeGreaterThan(1.0)
    }
  })

  /**
   * THE ANCHOR IS AN ARC LENGTH, AND THAT HAS TO STAY TRUE.
   *
   * If someone later "simplifies" the shot into world coordinates, this is the
   * test that notices: move along the spline and the camera must move with the
   * road, by roughly the distance asked for.
   */
  it('rides the spline instead of sitting at a fixed world point', () => {
    const near = attractPose(shot, track, 0, true, makeAttractPose()).pos.clone()
    const moved = attractPose(
      { ...shot, s: shot.s + 50 }, track, 0, true, makeAttractPose(),
    ).pos.clone()
    const d = near.distanceTo(moved)
    expect(d, 'a 50m move along the spline should move the camera about 50m')
      .toBeGreaterThan(35)
    expect(d).toBeLessThan(65)
  })

  it('looks somewhere other than at its own feet', () => {
    const pose = attractPose(shot, track, 0, true, makeAttractPose())
    expect(pose.target.distanceTo(pose.pos)).toBeGreaterThan(100)
    // The aim is near level: a title camera pitched into the sky or the deck
    // is the failure that a lone `pitch` typo produces.
    const dy = (pose.target.y - pose.pos.y) / pose.target.distanceTo(pose.pos)
    expect(Math.abs(dy), 'the shot should be roughly level').toBeLessThan(0.35)
  })
})

describe('the attract field', () => {
  const deps = {
    rideHeightOf: (id: string) => getLocomotion(id).rideHeight,
    topSpeedOf: (id: string) => getDerived(id).topSpeed,
  }

  const makeField = (n: number): RacerStateLike[] =>
    Array.from({ length: n }, (_, i) => ({
      chassisId: CHASSIS[i % CHASSIS.length].id,
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      fwd: { x: 0, y: 0, z: 1 },
      up: { x: 0, y: 1, z: 0 },
      yaw: 0,
      splineS: 0,
      lateral: 0,
    }))

  /**
   * The regression the probe found. A bunched field leaves together and the
   * fixed camera then watches an empty road for most of a lap, which is not a
   * thing anybody notices until they sit and watch the title screen for a
   * minute -- so it is measured here instead.
   */
  it('deals the field around the whole lap, not onto the grid', () => {
    for (const n of [4, 6, 8]) {
      const field = makeField(n)
      spreadField(field, track, 0, deps)
      const ss = field.map((r) => r.splineS).sort((a, b) => a - b)
      const gaps = ss.map((s, i) => (i === 0 ? s + track.length - ss[ss.length - 1] : s - ss[i - 1]))
      const want = track.length / n
      for (const g of gaps) {
        expect(g, `${n} cars should sit ~${want.toFixed(0)}m apart, saw ${g.toFixed(0)}m`)
          .toBeGreaterThan(want * 0.8)
      }
    }
  })

  it('starts them rolling, not from rest', () => {
    const field = makeField(6)
    spreadField(field, track, 0, deps)
    for (const r of field) {
      const v = Math.hypot(r.vel.x, r.vel.y, r.vel.z)
      expect(v, `${r.chassisId} was dealt at ${v.toFixed(1)}m/s`).toBeGreaterThan(10)
      // Pointed the way it is moving, which is what makes a standing car look
      // like a racing one on the very first frame.
      const dot = (r.vel.x * r.fwd.x + r.vel.y * r.fwd.y + r.vel.z * r.fwd.z) / v
      expect(dot).toBeGreaterThan(0.98)
    }
  })

  it('puts every car on the road it was dealt to', () => {
    const field = makeField(8)
    spreadField(field, track, 0, deps)
    for (const r of field) {
      const smp = track.at(r.splineS)
      expect(Math.abs(r.lateral), `${r.chassisId} was dealt ${r.lateral.toFixed(1)}m `
        + `off centre on a ${smp.width.toFixed(1)}m road`).toBeLessThan(smp.width / 2)
    }
  })

  it('shrinks the pack on weak hardware rather than dropping the feature', () => {
    expect(attractRacerCount('high')).toBe(8)
    expect(attractRacerCount('medium')).toBeLessThan(attractRacerCount('high'))
    expect(attractRacerCount('low')).toBeLessThan(attractRacerCount('medium'))
    // Still a race, though. One car is a driving demo, not an attract screen.
    expect(attractRacerCount('low')).toBeGreaterThanOrEqual(3)
  })

  it('has a shot for every shipped track, so changing the attract track is safe', () => {
    for (const id of Object.keys(TRACKS_BY_ID)) {
      expect(ATTRACT_SHOTS[id], `no attract shot for ${id}`).toBeDefined()
    }
  })
})
