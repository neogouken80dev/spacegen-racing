import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { Track } from '../src/sim/track'
import { Race } from '../src/sim/race'
import { resetAI } from '../src/sim/ai'
import { signedAngleAround } from '../src/sim/vehicle'
import { angleDelta, clamp } from '../src/sim/math'
import { emptyInput } from '../src/sim/types'
import type { SimConfig, RacerState } from '../src/sim/types'
import { CHASSIS } from '../src/content/chassis'
import { PILOTS } from '../src/content/pilots'
import { TUNING as T } from '../src/content/tuning'
import { createVehicleVisual } from '../src/render/vehicles'
import { createVfx } from '../src/render/vfx'
import { buildEnvironment } from '../src/render/environment'
import { QUALITY_PRESETS } from '../src/render/api'
import { ChaseCamera } from '../src/game/camera'
import { TEST_PLAIN, TEST_WALLRIDE, TEST_LOOP } from './fixtures/testTrack'
import { RUSTFALL, CRYOSTATIC } from '../src/content/tracks'

/**
 * ARBITRARY GRAVITY, from the outside.
 *
 * Two halves, and both matter equally:
 *
 *  1. THE WALL WORKS. A field of AI completes a circuit whose road rolls
 *     through 270 degrees, the car is drawn rolled onto the road it is on, and
 *     the camera rolls with it instead of the horizon flipping.
 *
 *  2. THE FLAT CASE DID NOT MOVE. Every one of those paths is gated on
 *     `Track.hasGravity`, and Rustfall and Cryostatic are balanced, gated and
 *     shipped. A test that only proved the wall worked would be half a test:
 *     the expensive failure here is a tenth of a second on a shipped lap time,
 *     not a car falling off a wall nobody has authored yet.
 */

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const FIELD = 8
const cfg = (trackId: string, n = FIELD, laps = 3, seed = 20260908): SimConfig => ({
  seed,
  totalLaps: laps,
  racerCount: n,
  trackId,
  chassisIds: Array.from({ length: n }, (_, i) => CHASSIS[i % CHASSIS.length].id),
  pilotIds: Array.from({ length: n }, (_, i) => PILOTS[i % PILOTS.length].id),
  localRacerIndex: -1,
  aiSkill: Array.from({ length: n }, (_, i) => 2 + (i % 3)),
})

/** Run a whole AI race and report what happened to the field on the way round. */
function raceStats(def: typeof TEST_WALLRIDE, maxFrames = 60 * 500) {
  resetAI()
  const track = new Track(def)
  const race = new Race(track, cfg(def.id))
  const idle = emptyInput()
  let frames = 0
  let respawns = 0
  let offTrackFrames = 0
  let invertedFrames = 0
  let worstFrameError = 0
  const wasRespawning = new Array<boolean>(FIELD).fill(false)

  while (frames < maxFrames && race.state.phase !== 'finished') {
    for (const r of race.state.racers) if (!r.isAI) race.setInput(r.id, idle)
    race.step()
    frames++
    for (const r of race.state.racers) {
      if (r.finished) continue
      const respawning = r.respawnTime > 0
      if (respawning && !wasRespawning[r.id]) respawns++
      wasRespawning[r.id] = respawning
      if (respawning) continue
      const proj = track.project(r.pos, r.splineS)
      if (Math.abs(proj.lateral) / proj.sample.width > 1) offTrackFrames++
      if (r.up.y < 0) invertedFrames++
      if (r.grounded) {
        const n = proj.sample.normal
        const d = r.up.x * n.x + r.up.y * n.y + r.up.z * n.z
        worstFrameError = Math.max(worstFrameError, 1 - d)
      }
    }
  }

  const laps = race.state.racers.flatMap((r) => r.lapTimes).filter((x) => x > 0)
  return {
    track,
    finished: race.state.phase === 'finished',
    frames,
    respawns,
    offTrackFrames,
    invertedFrames,
    worstFrameError,
    lapCount: laps.length,
    avgLap: laps.reduce((a, b) => a + b, 0) / Math.max(1, laps.length),
  }
}

/** Step a wall-ride race until some racer's up is at least `deg` off world +Y. */
function racerOnTheWall(deg: number): { r: RacerState; track: Track } {
  resetAI()
  const track = new Track(TEST_WALLRIDE)
  const race = new Race(track, cfg(TEST_WALLRIDE.id, 4))
  const idle = emptyInput()
  const want = Math.cos(deg * Math.PI / 180)
  for (let f = 0; f < 60 * 200; f++) {
    for (const r of race.state.racers) if (!r.isAI) race.setInput(r.id, idle)
    race.step()
    for (const r of race.state.racers) {
      if (r.respawnTime <= 0 && r.grounded && r.up.y < want) return { r, track }
    }
  }
  throw new Error(`no racer reached ${deg} degrees of roll`)
}

/** The world direction the model's local axis `v` ends up pointing. */
function axisOf(group: THREE.Object3D, v: THREE.Vector3): THREE.Vector3 {
  return v.clone().applyQuaternion(group.quaternion)
}

// ---------------------------------------------------------------------------
describe('the track frame', () => {
  it('the wall-ride fixture really does roll all the way onto its back', () => {
    const t = new Track(TEST_WALLRIDE)
    expect(t.hasGravity).toBe(true)
    let minY = 1
    for (const s of t.samples) minY = Math.min(minY, s.normal.y)
    // 270 degrees of roll passes clean through the ceiling on the way.
    expect(minY).toBeLessThan(-0.99)
  })

  it('the flat fixtures still declare no gravity at all', () => {
    expect(new Track(TEST_PLAIN).hasGravity).toBe(false)
    expect(new Track(RUSTFALL).hasGravity).toBe(false)
  })

  /**
   * THE ONE THAT CATCHES THE BRAKING BUG.
   *
   * At the top of a vertical loop the road is not turning left or right at all
   * -- it is pitching -- but its tangent is nearly straight up, so the XZ
   * projection the old reading used has almost nothing left of it and reports
   * whatever the rounding leaves behind. Measured at the sample where the
   * tangent is most vertical, the world-+Y formula returns 0.26 rad/m: a corner
   * of under four metres' radius, which `cornerSpeedAt` prices at about 11 m/s.
   */
  it('curvature at the top of a loop is measured in the plane the car drives in', () => {
    const t = new Track(TEST_LOOP)
    expect(t.hasGravity).toBe(true)

    // The most vertical sample on the circuit.
    let top = 0
    for (let k = 0; k < t.samples.length; k++) {
      if (Math.abs(t.samples[k].tangent.y) > Math.abs(t.samples[top].tangent.y)) top = k
    }
    const s = (top / t.samples.length) * t.length
    expect(Math.abs(t.samples[top].tangent.y)).toBeGreaterThan(0.99)

    // What the old world-+Y reading would say here.
    const a = t.at(s).tangent, b = t.at(s + 12).tangent
    const worldY = Math.atan2(
      a.z * b.x - a.x * b.z,
      clamp(a.x * b.x + a.z * b.z, -1, 1),
    ) / 12
    expect(Math.abs(worldY)).toBeGreaterThan(0.05)

    // The loop is a pitch, not a yaw: in the surface plane there is no turn.
    expect(Math.abs(t.curvatureAt(s, 12))).toBeLessThan(0.002)

    // ...and that is not because the reading is dead. The banked-flat approach
    // to the loop has no lateral curve either, but the RETURN LEG's corners do.
    let anyCorner = 0
    for (let k = 0; k < t.samples.length; k += 4) {
      anyCorner = Math.max(anyCorner, Math.abs(t.curvatureAt((k / t.samples.length) * t.length, 12)))
    }
    expect(anyCorner).toBeGreaterThan(0.01)
  })

  it('a flat track still reads exactly the world-+Y curvature it always did', () => {
    const t = new Track(RUSTFALL)
    for (let k = 0; k < t.samples.length; k += 7) {
      const s = (k / t.samples.length) * t.length
      const a = t.at(s).tangent, b = t.at(s + 12).tangent
      const legacy = Math.atan2(
        a.z * b.x - a.x * b.z,
        clamp(a.x * b.x + a.z * b.z, -1, 1),
      ) / 12
      // Not toBeCloseTo: the flat branch must be the SAME arithmetic, so this
      // is an exact-equality check on every sample of a shipped circuit.
      expect(t.curvatureAt(s, 12)).toBe(legacy)
    }
  })
})

// ---------------------------------------------------------------------------
describe('the AI', () => {
  /**
   * The heading comparison the whole gate rests on. `signedAngleAround` is what
   * replaces `angleDelta(r.yaw, wantYaw)` on a gravity track, and it is only
   * safe to gate that swap if the two agree when the up-vector is +Y.
   */
  it('the in-plane heading error reduces to the compass one about world +Y', () => {
    const up = { x: 0, y: 1, z: 0 }
    for (let i = 0; i < 64; i++) {
      const yaw = (i / 64) * Math.PI * 2 - Math.PI
      const want = ((i * 37) % 64 / 64) * Math.PI * 2 - Math.PI
      const fwd = { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) }
      // Deliberately not a unit target, and deliberately carrying a component
      // along `up`: that is what the AI actually hands it -- a raw offset to an
      // aim point on the road, from a car floating above the road.
      const L = 3 + i
      const target = { x: Math.sin(want) * L, y: -0.55, z: Math.cos(want) * L }
      expect(signedAngleAround(fwd, target, up)).toBeCloseTo(angleDelta(yaw, want), 12)
    }
  })

  it('a full field drives the 270-degree wall-ride without falling off it', () => {
    const st = raceStats(TEST_WALLRIDE)
    expect(st.finished).toBe(true)
    expect(st.lapCount).toBe(FIELD * 3)
    // The bar the old AI could not clear: it took 120 respawns to get round.
    expect(st.respawns).toBe(0)
    expect(st.offTrackFrames).toBe(0)
    // ...and it took 94.7s a lap doing it, against ~36 with the frame handled.
    expect(st.avgLap).toBeLessThan(50)
    expect(st.avgLap).toBeGreaterThan(20)
  })

  it('the field genuinely spends time upside down, or the race above proves nothing', () => {
    const st = raceStats(TEST_WALLRIDE)
    expect(st.invertedFrames).toBeGreaterThan(1000)
  })

  it('a grounded racer keeps its frame welded to the surface under it', () => {
    const st = raceStats(TEST_WALLRIDE)
    // 1 - dot, so this is "never more than about 12 degrees out".
    expect(st.worstFrameError).toBeLessThan(0.025)
  })

  /**
   * THE SHIPPED-TRACK GATE, in the test suite rather than only in the headless
   * tool. Every gravity branch in ai.ts, track.ts and vehicle.ts is switched on
   * `hasGravity`; this is the assertion that the switch is actually off.
   */
  it('leaves Rustfall exactly where it was, to the centisecond', () => {
    resetAI()
    const track = new Track(RUSTFALL)
    // The seed tools/headless.ts races, so the number below is the number that
    // tool prints and the two gates cannot drift apart.
    const race = new Race(track, cfg(RUSTFALL.id, 8, 3, 20260904))
    const idle = emptyInput()
    let frames = 0
    while (frames < 60 * 400 && race.state.phase !== 'finished') {
      for (const r of race.state.racers) if (!r.isAI) race.setInput(r.id, idle)
      race.step()
      frames++
    }
    expect(race.state.phase).toBe('finished')
    const laps = race.state.racers.flatMap((r) => r.lapTimes).filter((x) => x > 0)
    const avg = laps.reduce((a, b) => a + b, 0) / laps.length
    // A PINNED BASELINE. Its job is to shout when a change to the gravity path
    // moves a flat, shipped, gated track -- which it did, correctly, when the
    // boost economy was fixed. It moves only for a deliberate global sim change
    // that is recorded here.
    // History:
    //   55.99s  the pre-gravity build.
    //   56.36s  drift coyote window: a grounded chassis no longer loses its
    //           drift to a single airborne frame, so far more drift boost is
    //           banked over a lap.
    //   56.85s  the barrier pass -- hard deck floor, orientation-aware barrier
    //           inset (the usable road is genuinely narrower in a slide now),
    //           and impacts priced on closing rate. See tests/barriers.test.ts.
    //   57.78s  the slick pass: low-grip surfaces moved out of the corners and
    //           onto the approaches, and braking became grip-sensitive above
    //           T.grip.brakeFloor. Rustfall's tarmac is untouched by the brake
    //           change (the scale is exactly 1.0 at full grip); this 0.04s is
    //           its oil and gravel changing places.
    //   57.47s  locomotion.flight.gripMult 1.01 -> 0.98, the re-trim the
    //           crosswind cap forced. Rustfall has no wind, so this is the
    //           flight class alone: reverting gripMult reproduces the previous
    //           hash byte for byte with the cap still in place.
    //   58.29s  boost-pad pump fix + AI drift-commitment latch. Slower because
    //           the pads no longer bank an unbounded boost; see the note on
    //           TUNING.boost.padDuration.
    //   56.36s  the drift coyote window (T.drift.airGrace) and driftMinHold
    //           0.45 -> 0.70. FASTER because a grounded chassis no longer loses
    //           its whole drift charge to one airborne frame over a kerb: the
    //           share of drifts reaching no tier at all falls from ~59% to ~9%,
    //           so the field cashes in far more drift boost per lap. This value
    //           was measured, not predicted -- the pin above was left behind by
    //           the change that introduced it and this test was already failing
    //           before Aetherion's dust pass touched anything.
    //   57.06s  the Void Mine moved to the REAR of the car. It used to lob 20m
    //           forward by default, which seeded the racing line ahead of the
    //           thrower -- and the AI drove into it. Dropping it behind takes
    //           those hits out of the lap, which is where the 0.72s comes from;
    //           the mine is otherwise unchanged. See src/sim/race.ts.
    //   56.27s  the Filament's collision box shrank with its hull -- the
    //           chassis was redesigned from a 4.1m needle to a 3.2m blade, and
    //           halfExtents went 0.62/2.05 -> 0.54/1.58 to match it. z feeds
    //           orientedInset(), so a CRABBED Filament now presents a smaller
    //           corner to a barrier and can hold a drift closer to it. x was
    //           left alone deliberately: it is bodyInset() exactly, and it
    //           sets the clamp for every square-on contact in the game.
    //           Verified as the cause by A/B -- restoring the old box restores
    //           57.06 byte for byte. Balance is unmoved: across four seeds of
    //           600 races on Rustfall every chassis stays inside 12-30%
    //           (vector7 10.2/14.2/14.3/14.3, mean 13.3%) and the lap mean
    //           moves 56.70s -> 56.71s.
    //   57.56s  the Star Hopper (ex-Filament) model scaled 1.5x and its box
    //           with it: halfExtents 0.68/0.54/1.58 -> 1.02/0.81/2.37. SLOWER,
    //           and by the largest step in this ledger, because this is the
    //           one that moved x: bodyInset() is `x + 0.12`, so the square-on
    //           wall clamp went 0.80m -> 1.14m and a third of a metre of
    //           usable road came off every barrier for that chassis.
    //           THE COST IS NOT PAID BY THE CHASSIS THAT CHANGED. Across four
    //           seeds of 600 races the Star Hopper itself holds at 19.8% mean,
    //           but Vector-7 falls 14.3% -> 10.7% and sits under the 12% floor
    //           on every seed (11.0/10.2/10.7/10.7). The reading is traffic:
    //           Vector-7 is the widest chassis in the roster and the one that
    //           spends a quarter of the lap airborne, so it has the least room
    //           to give when another car's footprint grows. Flagged for a
    //           roster decision rather than silently compensated -- see
    //           claude/spacegen-racing-filament-redesign.md.
    //   56.70s  the hovering branch got the floor it never had, and hover's
    //           rideHeight went 1.00 -> 1.15. FASTER, and mostly for one
    //           reason: Vector-7 is the flight class, `hovering` is its
    //           permanent branch (gapCross 999), and that branch was the only
    //           arm of the altitude chain with no clamp -- so it had been
    //           driving through the deck and losing time in it. Measured over
    //           18 races on three tracks, its bodywork was inside the road on
    //           2669-3499 frames per track, as deep as 2.38m. After the floor:
    //           zero, on every track.
    //           `groundSnapDistance` was also re-based 2.4 -> 1.85 when the
    //           comparison it feeds moved from "below the ride height" to
    //           "below the road"; that part is deliberately a no-op for the
    //           grounded class (0.55 + 1.85 == 2.4) and measured as changing
    //           no sub-deck frame on any track. It is a coherence fix, not the
    //           one that mattered.
    //   56.63s  the Pulse Gatling became a projectile weapon. It used to pick
    //           a target inside a cone and apply the hit in the same frame --
    //           a shot that could not miss. Rounds now fly at 240 m/s and can
    //           be led, dodged or simply fired at nothing, so the AI's bursts
    //           no longer chip every car in front of them and the field is
    //           marginally quicker. Fire rate also dropped 14 -> 10.
    //   55.91s  pilots gained stats and a drift keeps its arc under boost.
    //           The AI got FASTER by 0.72s a lap, and that direction is the
    //           point rather than a side effect: the boost relief exists
    //           because a drift taken during a boost barely rotated, and the AI
    //           drifts through roughly half its corners. A change meant to make
    //           boosted cornering work that left lap times untouched would have
    //           been a change that did nothing.
    //   56.85s  boostArcRelief pulled back 0.85 -> 0.45. SLOWER by 0.94s, which
    //           is more than the 0.72s the relief bought in the first place,
    //           and that asymmetry is worth reading rather than averaging away.
    //           The AI drifts through roughly half its corners and 42-54% of
    //           those drift frames are inside a boost (tools/probe-aiarc.ts),
    //           so it lives in this term more than a player does -- but its own
    //           `driftStick` inversion in ai.ts does NOT undo the relief, only
    //           the bare speed falloff. It therefore asks for a cold-drift arc
    //           and gets a boosted one, by a mean factor of 1.23-1.33x. Moving
    //           the relief moves the size of a mismatch the AI cannot see, so
    //           its lap time answers non-monotonically and this line should not
    //           be read as "the field got 0.94s worse at driving".
    //           The inversion fix is deliberately NOT in this commit: it is a
    //           second change to the same mechanic, and bundling it would make
    //           the feel change unattributable. Balance was re-run and holds.
    expect(avg).toBeCloseTo(56.85, 2)
  })
})

// ---------------------------------------------------------------------------
describe('the car on screen', () => {
  const FWD = new THREE.Vector3(0, 0, 1)
  const UP = new THREE.Vector3(0, 1, 0)

  it('is the same single yaw rotation it always was on a flat track', () => {
    const v = createVehicleVisual('solaire', '', QUALITY_PRESETS.high)
    const r = JSON.parse(JSON.stringify(new Race(new Track(TEST_PLAIN), cfg(TEST_PLAIN.id, 1)).state.racers[0])) as RacerState
    r.yaw = 0.9
    // Deliberately poison the frame the gravity path would read. A flat track
    // never updates these, so a renderer that reads them without being told to
    // is reading the start line's tangent an hour into the race.
    r.fwd = { x: 1, y: 0, z: 0 }
    r.up = { x: 0, y: 0, z: 1 }
    v.update(r, 1 / 60, 10)
    expect(v.group.rotation.x).toBe(0)
    expect(v.group.rotation.z).toBe(0)
    expect(v.group.rotation.y).toBeCloseTo(0.9, 12)
    expect(axisOf(v.group, FWD).z).toBeCloseTo(Math.cos(0.9), 10)
    v.dispose()
  })

  it('is rolled onto the wall it is driving on', () => {
    const { r } = racerOnTheWall(70)
    const v = createVehicleVisual(r.chassisId, r.pilotId, QUALITY_PRESETS.high)
    v.gravity = true
    v.update(r, 1 / 60, 10)

    // The model is authored +Y up and nose-toward +Z, so those two local axes
    // must land on the racer's own up and nose.
    const up = axisOf(v.group, UP)
    expect(up.x).toBeCloseTo(r.up.x, 5)
    expect(up.y).toBeCloseTo(r.up.y, 5)
    expect(up.z).toBeCloseTo(r.up.z, 5)
    const nose = axisOf(v.group, FWD)
    expect(nose.dot(new THREE.Vector3(r.fwd.x, r.fwd.y, r.fwd.z))).toBeGreaterThan(0.999)

    // And the roll is real: a car on a wall is not a car with a yaw.
    expect(Math.abs(up.y)).toBeLessThan(Math.cos(70 * Math.PI / 180) + 1e-6)
    v.dispose()
  })

  it('keeps the basis orthonormal even when handed an interpolated frame', () => {
    const { r } = racerOnTheWall(70)
    const v = createVehicleVisual(r.chassisId, r.pilotId, QUALITY_PRESETS.high)
    v.gravity = true
    // What main.ts's per-frame lerp produces: two separately damped vectors
    // that are neither unit length nor perpendicular to each other.
    r.fwd = { x: r.fwd.x * 0.97 + 0.06, y: r.fwd.y * 0.97, z: r.fwd.z * 0.97 - 0.04 }
    r.up = { x: r.up.x * 1.04, y: r.up.y * 1.04 + 0.05, z: r.up.z * 1.04 }
    v.update(r, 1 / 60, 10)
    const q = v.group.quaternion
    expect(q.length()).toBeCloseTo(1, 6)
    const x = axisOf(v.group, new THREE.Vector3(1, 0, 0))
    const y = axisOf(v.group, UP)
    const z = axisOf(v.group, FWD)
    expect(x.length()).toBeCloseTo(1, 6)
    expect(x.dot(y)).toBeCloseTo(0, 6)
    expect(y.dot(z)).toBeCloseTo(0, 6)
    // Right-handed, or the car is mirrored.
    expect(x.clone().cross(y).dot(z)).toBeCloseTo(1, 6)
    v.dispose()
  })

  it('composes the cosmetic drift lean on top of the surface frame, not instead of it', () => {
    const { r } = racerOnTheWall(70)
    const v = createVehicleVisual(r.chassisId, r.pilotId, QUALITY_PRESETS.high)
    v.gravity = true
    r.driftSide = 1
    r.driftInward = 1
    r.yawRate = -1.0
    // Let the lean build up; it is damped, so one frame shows nothing.
    for (let i = 0; i < 90; i++) v.update(r, 1 / 60, 10)
    // The ROOT still carries the surface frame exactly...
    const up = axisOf(v.group, UP)
    expect(up.x).toBeCloseTo(r.up.x, 5)
    expect(up.y).toBeCloseTo(r.up.y, 5)
    // ...and the lean is somewhere below it, on the child that owns attitude.
    const body = v.group.getObjectByName('') ?? v.group.children[0]
    expect(body).toBeTruthy()
    let leaned = false
    v.group.traverse((o) => {
      if (o !== v.group && Math.abs(o.rotation.z) > 0.05) leaned = true
    })
    expect(leaned).toBe(true)
    v.dispose()
  })
})

// ---------------------------------------------------------------------------
describe('the chase camera', () => {
  const RDT = 1 / 60

  function flatRacer(): RacerState {
    const race = new Race(new Track(TEST_PLAIN), cfg(TEST_PLAIN.id, 1))
    return race.state.racers[0]
  }

  it('keeps a world-+Y up on a flat track, whatever the racer frame says', () => {
    const cam = new ChaseCamera(16 / 9)
    const r = flatRacer()
    r.fwd = { x: 1, y: 0, z: 0 }
    r.up = { x: 0, y: 0, z: 1 } // poison, as above
    cam.reset(r)
    for (let i = 0; i < 120; i++) cam.update(r, RDT, 60, false, false)
    expect(cam.camera.up.x).toBe(0)
    expect(cam.camera.up.y).toBe(1)
    expect(cam.camera.up.z).toBe(0)
  })

  it('rolls onto the wall with the car rather than snapping to it', () => {
    const { r } = racerOnTheWall(80)
    const cam = new ChaseCamera(16 / 9)
    cam.gravity = true
    // Start the rig level, as it would be on the approach to the wall.
    const level = JSON.parse(JSON.stringify(r)) as RacerState
    level.up = { x: 0, y: 1, z: 0 }
    cam.reset(level)
    expect(cam.camera.up.y).toBeCloseTo(1, 6)

    // Now hold the car on the wall and watch the rig follow.
    const half = T.gravity.cameraUpHalfLife
    for (let i = 0; i < Math.round(half / RDT); i++) cam.update(r, RDT, 60, false, false)
    const afterOneHalfLife = cam.camera.up.y

    // One half-life closes half the ANGLE -- which is what the tuning constant
    // claims, and what a chord lerp would quietly get wrong by 7 points over a
    // roll this size. Measured on the angle, not on a component: `up.y` is a
    // cosine of it and halving the cosine is not halving the turn.
    const total = Math.acos(clamp(r.up.y, -1, 1))
    const closed = Math.acos(clamp(afterOneHalfLife, -1, 1)) / total
    expect(total).toBeGreaterThan(1.2) // the car really is past 70 degrees
    expect(closed).toBeGreaterThan(0.42)
    expect(closed).toBeLessThan(0.58)

    // And given long enough it arrives.
    for (let i = 0; i < 600; i++) cam.update(r, RDT, 60, false, false)
    expect(cam.camera.up.x).toBeCloseTo(r.up.x, 2)
    expect(cam.camera.up.y).toBeCloseTo(r.up.y, 2)
    expect(cam.camera.up.z).toBeCloseTo(r.up.z, 2)
  })

  it('stands above the car along the CAR\'s up, not along world +Y', () => {
    const { r } = racerOnTheWall(80)
    const cam = new ChaseCamera(16 / 9)
    cam.gravity = true
    cam.reset(r)
    for (let i = 0; i < 240; i++) cam.update(r, RDT, 60, false, false)

    const off = cam.camera.position.clone().sub(new THREE.Vector3(r.pos.x, r.pos.y, r.pos.z))
    const alongCarUp = off.dot(new THREE.Vector3(r.up.x, r.up.y, r.up.z))
    expect(alongCarUp).toBeGreaterThan(0.9)
    // The rig is behind the nose, not beside it.
    const behind = off.dot(new THREE.Vector3(r.fwd.x, r.fwd.y, r.fwd.z))
    expect(behind).toBeLessThan(-2)
  })

  it('snaps rather than eases on reset, so a race never opens with the horizon righting itself', () => {
    const { r } = racerOnTheWall(80)
    const cam = new ChaseCamera(16 / 9)
    cam.gravity = true
    cam.reset(r)
    expect(cam.camera.up.x).toBeCloseTo(r.up.x, 5)
    expect(cam.camera.up.y).toBeCloseTo(r.up.y, 5)
    expect(cam.camera.up.z).toBeCloseTo(r.up.z, 5)
  })
})

// ---------------------------------------------------------------------------
// PICKUPS AND COMBAT ON A ROLLED ROAD
//
// The gravity pass left the ENTITIES behind. Every one of these is the same
// mistake in a different file -- a thing that belongs to the road placed or
// aimed along world +Y -- and every one of them is invisible on a flat track,
// which is why they survived a pass that got the car, the camera and the AI
// right.
// ---------------------------------------------------------------------------

/** A wall-ride with a row of item boxes and a charge run ON the rolled part. */
const WALL_PICKUPS: typeof TEST_WALLRIDE = {
  ...TEST_WALLRIDE,
  id: 'test-wallride-pickups',
  // 0.46 of a lap lands inside nodes 19-26, where the road is held at a full
  // 270 degrees of roll: vertical, with `up` pointing at the ring's centre.
  itemBoxRows: [{ at: 0.46, count: 3, spread: 6 }],
  chargeRuns: [{ from: 0.44, to: 0.48, count: 4, lateral: 4 }],
}

/**
 * The middle of TEST_WALLRIDE's HELD section: the stretch where the roll sits
 * at a full 270 degrees, the road is vertical and `up` points at the ring's
 * centre. Found by the geometry rather than by a node index, so it survives
 * the fixture being re-authored.
 *
 * The most-rolled sample is NOT what is wanted here -- that is the ceiling,
 * halfway through the roll-on, where `up` is world -Y and every world-+Y
 * formula in the game still happens to work up to a sign.
 */
function heldWall(track: Track): { idx: number; s: number } {
  const run: number[] = []
  for (let k = 0; k < track.samples.length; k++) {
    const p = track.samples[k].pos
    const l = Math.hypot(p.x, p.z) || 1
    const n = track.samples[k].normal
    // `normal` pointing straight back down the radius: the held 270.
    if ((n.x * p.x + n.z * p.z) / l < -0.999) run.push(k)
  }
  if (run.length === 0) throw new Error('fixture has no held wall section')
  const idx = run[run.length >> 1]
  return { idx, s: (idx / track.samples.length) * track.length }
}

/** As `cfg`, but racer 0 is the LOCAL racer, so a test can hand it inputs.
 *  With every racer AI, `Race.step` overwrites `setInput` on the same frame. */
const cfgLocal = (trackId: string, n = 2): SimConfig => ({
  ...cfg(trackId, n),
  localRacerIndex: 0,
})

describe('pickups float above the ROAD, not along world +Y', () => {
  it('every box and charge on a wall-ride sits its authored height off the deck', () => {
    const track = new Track(WALL_PICKUPS)
    const race = new Race(track, cfg(WALL_PICKUPS.id, 2))
    expect(race.state.itemBoxes.length).toBe(3)
    expect(race.state.chargePickups.length).toBe(4)

    // The row really is on the vertical part, or this test proves nothing.
    const rowSample = track.at(race.state.itemBoxes[0].splineS)
    expect(Math.abs(rowSample.normal.y)).toBeLessThan(0.1)

    for (const b of race.state.itemBoxes) {
      const proj = track.project(b.pos, b.splineS)
      // THE ASSERTION THE OLD CODE FAILS. `height` is measured along the
      // road's own normal: with the lift taken along world +Y, and the road's
      // normal horizontal here, the box has NO height over the road at all --
      // it is simply displaced 1.5 m sideways along the ribbon instead.
      expect(proj.height).toBeCloseTo(1.5, 2)
      expect(proj.lateral).toBeCloseTo(b.lateral, 2)
      // ...and the published axis is the road's normal, which is what the
      // renderer bobs the box along.
      expect(b.up.x).toBeCloseTo(rowSample.normal.x, 2)
      expect(b.up.y).toBeCloseTo(rowSample.normal.y, 2)
    }
    for (const c of race.state.chargePickups) {
      const proj = track.project(c.pos, 0.46 * track.length)
      expect(proj.height).toBeCloseTo(1.1, 2)
      expect(proj.lateral).toBeCloseTo(4, 2)
    }
  })

  it('leaves a flat track\'s pickups on exactly the world +Y they always used', () => {
    const track = new Track(RUSTFALL)
    const race = new Race(track, cfg(RUSTFALL.id, 2))
    expect(race.state.itemBoxes.length).toBeGreaterThan(0)
    for (const b of race.state.itemBoxes) {
      const p = track.surfacePoint(b.splineS, b.lateral)
      // Not toBeCloseTo: the flat branch must be the SAME arithmetic.
      expect(b.pos.x).toBe(p.x)
      expect(b.pos.y).toBe(p.y + 1.5)
      expect(b.pos.z).toBe(p.z)
      expect(b.up).toEqual({ x: 0, y: 1, z: 0 })
    }
    for (const c of race.state.chargePickups) {
      expect(c.up).toEqual({ x: 0, y: 1, z: 0 })
    }
  })
})

// ---------------------------------------------------------------------------

/**
 * Shooter and victim pinned to the most-rolled sample of a wall-ride, the
 * victim a fixed gap ahead on the same line. Same shape as the rig in
 * tests/gatling.test.ts, in the racer's own surface frame instead of in XZ.
 */
function wallRig(def: typeof TEST_WALLRIDE, gap: number, lateral: number) {
  resetAI()
  const track = new Track(def)
  const race = new Race(track, cfgLocal(def.id))
  while (race.state.phase === 'countdown') race.step()
  const [shooter, victim] = race.state.racers
  const { s: baseS } = heldWall(track)

  const seat = (r: RacerState, s: number, lat: number): void => {
    const smp = track.at(s)
    const p = track.surfacePoint(s, lat)
    r.pos.x = p.x + smp.normal.x * 0.55
    r.pos.y = p.y + smp.normal.y * 0.55
    r.pos.z = p.z + smp.normal.z * 0.55
    r.fwd = { x: smp.tangent.x, y: smp.tangent.y, z: smp.tangent.z }
    r.up = { x: smp.normal.x, y: smp.normal.y, z: smp.normal.z }
    r.yaw = Math.atan2(smp.tangent.x, smp.tangent.z)
    r.vel.x = 0; r.vel.y = 0; r.vel.z = 0
    r.splineS = s
    r.lateral = lat
    r.grounded = true
    r.altitude = 0.55
  }
  const pin = (): void => {
    seat(shooter, baseS, lateral)
    seat(victim, baseS + gap, lateral)
  }
  pin()
  return { race, track, shooter, victim, pin, baseS }
}

describe('projectiles follow the surface', () => {
  const idle = emptyInput()

  it('the wall-ride rig really does pin the pair to a vertical road', () => {
    const { track, shooter, baseS } = wallRig(TEST_WALLRIDE, 30, 8)
    expect(Math.abs(track.at(baseS).normal.y)).toBeLessThan(0.05)
    // The car is EIGHT METRES up the wall, so anything that snaps a projectile
    // to the centreline's world height misses it by eight metres.
    expect(Math.abs(shooter.pos.y)).toBeGreaterThan(7)
  })

  it('a rail missile fired up a wall stays on the road and connects', () => {
    const { race, shooter, victim, pin } = wallRig(TEST_WALLRIDE, 30, 8)
    shooter.item = 'railMissile'
    shooter.itemCharges = 1
    shooter.rouletteTime = 0
    const fire = emptyInput(); fire.item = true

    for (let f = 0; f < 60; f++) {
      race.setInput(0, f === 0 ? fire : idle)
      race.setInput(1, idle)
      pin()
      race.step()
      if (victim.lastHitBy !== null) break
    }
    expect(victim.lastHitBy).toBe('railMissile')
    expect(victim.spinTime).toBeGreaterThan(0)
  })

  it('a rail missile holds its height over the road all the way down the wall', () => {
    const { race, track, shooter, pin } = wallRig(TEST_WALLRIDE, 400, 8)
    shooter.item = 'railMissile'
    shooter.itemCharges = 1
    shooter.rouletteTime = 0
    const fire = emptyInput(); fire.item = true

    let worstHeight = 0
    let worstLateral = 0
    let samples = 0
    for (let f = 0; f < 60; f++) {
      race.setInput(0, f === 0 ? fire : idle)
      race.setInput(1, idle)
      pin()
      race.step()
      const p = race.state.projectiles.find((q) => q.alive && q.kind === 'rail')
      if (!p) continue
      samples++
      const proj = track.project(p.pos, p.splineS)
      worstHeight = Math.max(worstHeight, Math.abs(proj.height - 1.2))
      worstLateral = Math.max(worstLateral, Math.abs(proj.lateral - 8))
      // ...and the velocity stays in the road's plane.
      const n = proj.sample.normal
      const out = Math.abs(p.vel.x * n.x + p.vel.y * n.y + p.vel.z * n.z)
      expect(out).toBeLessThan(1.0)
    }
    expect(samples).toBeGreaterThan(20)
    expect(worstHeight).toBeLessThan(0.1)
    // A shot fired straight down a constant-radius ring drifts outward: it
    // travels in a straight line while the road curves. Bounded, not zero.
    expect(worstLateral).toBeLessThan(6)
  })

  it('a seeker steers onto a target that is above it on the wall', () => {
    // The victim is 14 m further up the wall than the shooter, which about
    // world +Y is a PITCH and about the road normal is a plain sideways turn.
    const { race, shooter, victim, pin, track, baseS } = wallRig(TEST_WALLRIDE, 45, -6)
    const seatVictim = (): void => {
      const s = baseS + 45
      const smp = track.at(s)
      const p = track.surfacePoint(s, 8)
      victim.pos.x = p.x + smp.normal.x * 0.55
      victim.pos.y = p.y + smp.normal.y * 0.55
      victim.pos.z = p.z + smp.normal.z * 0.55
      victim.vel.x = 0; victim.vel.y = 0; victim.vel.z = 0
      victim.splineS = s
      victim.lateral = 8
      victim.totalS = shooter.totalS + 45
    }
    shooter.item = 'seekerMissile'
    shooter.itemCharges = 1
    shooter.rouletteTime = 0
    shooter.totalS = 300
    const fire = emptyInput(); fire.item = true

    for (let f = 0; f < 90; f++) {
      race.setInput(0, f === 0 ? fire : idle)
      race.setInput(1, idle)
      pin()
      seatVictim()
      race.step()
      if (victim.lastHitBy !== null) break
    }
    expect(victim.lastHitBy).toBe('seekerMissile')
  })

  it('an alpha missile rides the road rather than punching through it', () => {
    const track = new Track(TEST_WALLRIDE)
    const race = new Race(track, cfgLocal(TEST_WALLRIDE.id))
    while (race.state.phase === 'countdown') race.step()
    const { s: baseS } = heldWall(track)
    const [shooter, leader] = race.state.racers
    shooter.item = 'alphaMissile'
    shooter.itemCharges = 1
    shooter.rouletteTime = 0
    // The leader has to be somewhere the Alpha is not, or it detonates on the
    // grid before it has flown a metre: both cars start side by side and the
    // missile spawns three metres off the shooter's nose.
    const parkLeader = (): void => {
      const s = baseS + 600
      const smp = track.at(s)
      const p = track.surfacePoint(s, 6)
      leader.pos.x = p.x + smp.normal.x * 0.55
      leader.pos.y = p.y + smp.normal.y * 0.55
      leader.pos.z = p.z + smp.normal.z * 0.55
      leader.splineS = s
      leader.lateral = 6
      leader.totalS = 100000
    }
    parkLeader()

    const fire = emptyInput(); fire.item = true
    race.setInput(0, fire)
    race.setInput(1, idle)
    race.step()
    const alpha = race.state.projectiles.find((p) => p.kind === 'alpha')
    expect(alpha).toBeTruthy()
    if (!alpha) return

    // Walk it round to the vertical section by hand and measure it there.
    alpha.splineS = baseS
    alpha.life = 10
    let worst = 0
    let seen = 0
    for (let f = 0; f < 40; f++) {
      race.setInput(0, idle); race.setInput(1, idle)
      parkLeader()
      race.step()
      if (!alpha.alive) break
      const proj = track.project(alpha.pos, alpha.splineS)
      if (Math.abs(proj.sample.normal.y) > 0.2) continue
      seen++
      worst = Math.max(worst, Math.abs(proj.height - 2.0))
    }
    expect(seen).toBeGreaterThan(10)
    expect(worst).toBeLessThan(0.1)
  })

  it('a void mine dropped on a wall lands ON the wall', () => {
    const { race, track, shooter, pin } = wallRig(TEST_WALLRIDE, 30, 5)
    shooter.item = 'voidMine'
    shooter.itemCharges = 1
    shooter.rouletteTime = 0
    const fire = emptyInput(); fire.item = true
    race.setInput(0, fire); race.setInput(1, idle)
    pin()
    race.step()
    const mine = race.state.fields.find((f) => f.kind === 'mine')
    expect(mine).toBeTruthy()
    if (!mine) return
    const proj = track.project(mine.pos, shooter.splineS)
    // Dropped 6 m BEHIND (see the note in race.ts -- both throws are rearward
    // now), sitting at the racer's own ride height above the deck. Along +Y it
    // would be a metre out into the void beside the ribbon, which is the whole
    // point of re-seating it onto the road: the wall-ride's deck is vertical.
    expect(proj.height).toBeCloseTo(0.55, 2)
    expect(Math.abs(proj.lateral)).toBeLessThan(track.at(proj.s).width)
  })

  /**
   * THE GATLING, ON A ROAD THAT GOES STRAIGHT UP.
   *
   * Measured on TEST_LOOP rather than on the wall-ride, and the reason is the
   * whole point of the bug: TEST_WALLRIDE's centreline never leaves y = 0, so
   * two cars a gap apart on it are a gap apart in world XZ too and the old
   * compass cone happens to give the right answer. On the descending side of a
   * loop the road runs vertically -- eight metres of road is eight metres of
   * world Y and four CENTIMETRES of world XZ -- and the old reading fails
   * twice over: `dy > 6` rejects a car that is directly ahead, and what is
   * left of the XZ distance is under the two-metre minimum range.
   */
  function loopRig(gap: number) {
    resetAI()
    const track = new Track(TEST_LOOP)
    const race = new Race(track, cfgLocal(TEST_LOOP.id))
    while (race.state.phase === 'countdown') race.step()
    const [shooter, victim] = race.state.racers

    // The sample where the road is closest to vertical.
    let top = 0
    for (let k = 0; k < track.samples.length; k++) {
      if (Math.abs(track.samples[k].tangent.y) > Math.abs(track.samples[top].tangent.y)) top = k
    }
    const mid = (top / track.samples.length) * track.length

    const seat = (r: RacerState, s: number, lift: number): void => {
      const smp = track.at(s)
      const p = track.surfacePoint(s, 0)
      const h = 0.55 + lift
      r.pos.x = p.x + smp.normal.x * h
      r.pos.y = p.y + smp.normal.y * h
      r.pos.z = p.z + smp.normal.z * h
      r.fwd = { x: smp.tangent.x, y: smp.tangent.y, z: smp.tangent.z }
      r.up = { x: smp.normal.x, y: smp.normal.y, z: smp.normal.z }
      r.yaw = Math.atan2(smp.tangent.x, smp.tangent.z)
      r.vel.x = 0; r.vel.y = 0; r.vel.z = 0
      r.splineS = s
      r.lateral = 0
      r.grounded = true
      r.altitude = h
    }
    const pin = (lift: number): void => {
      seat(shooter, mid - gap / 2, 0)
      seat(victim, mid + gap / 2, lift)
    }
    pin(0)
    return { race, track, shooter, victim, pin, mid }
  }

  /** Arm the gatling and hold the trigger for `frames`, returning peak charge. */
  function trackFor(
    rig: ReturnType<typeof loopRig>, frames: number, lift: number,
  ): number {
    const { race, shooter, victim, pin } = rig
    shooter.item = 'laserGatling'
    shooter.itemCharges = 1
    shooter.rouletteTime = 0
    const fire = emptyInput(); fire.item = true
    let peak = 0
    for (let f = 0; f < frames; f++) {
      race.setInput(0, f === 0 ? fire : idle)
      race.setInput(1, idle)
      pin(lift)
      race.step()
      peak = Math.max(peak, victim.beamCharge)
      if (victim.spinTime > 0) break
    }
    return peak
  }

  it('the loop rig really does stand the pair on a vertical road', () => {
    const { track, shooter, victim, mid } = loopRig(8)
    expect(Math.abs(track.at(mid).tangent.y)).toBeGreaterThan(0.99)
    // Eight metres of ROAD between them, and four centimetres of world XZ.
    expect(Math.abs(victim.pos.y - shooter.pos.y)).toBeGreaterThan(6)
    expect(Math.hypot(victim.pos.x - shooter.pos.x, victim.pos.z - shooter.pos.z))
      .toBeLessThan(2)
  })

  it('the gatling hits a car directly ahead on a vertical road, and only then', () => {
    // HIT: the victim is on the same deck, straight down the barrel.
    expect(trackFor(loopRig(8), 60 * 3, 0)).toBeGreaterThan(0.3)

    // MISS: the same car, lifted twelve metres OFF that deck. This is the case
    // the out-of-plane gate exists for -- a car on another level of a stacked
    // circuit -- and it has to survive the move from world +Y to the road's
    // own normal, or "aim in the surface plane" becomes "hit everyone".
    const away = loopRig(8)
    expect(trackFor(away, 120, 12)).toBe(0)
    expect(away.victim.spinTime).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// THE PARTICLE SYSTEM'S OWN UP
//
// K_BEAM is a light column and K_GROUND a surface-hugging annulus, and both
// were baked to world +Y inside the particle shader -- so a ramp launch on a
// wall-ride threw a vertical searchlight into the sky while the car went
// sideways, and every shockwave stood on its edge. The fix is a per-particle
// axis attribute, which is measurable from the buffer without a GPU.
// ---------------------------------------------------------------------------
describe('the particle system carries a surface axis', () => {
  /** Every particle written by one update(), as {axis, kind}. */
  function shoot(gravity: boolean, up: { x: number; y: number; z: number }) {
    const scene = new THREE.Scene()
    const vfx = createVfx(scene, QUALITY_PRESETS.high)
    vfx.gravity = gravity

    const race = new Race(new Track(TEST_PLAIN), cfg(TEST_PLAIN.id, 1))
    while (race.state.phase === 'countdown') race.step()
    const r = race.state.racers[0]
    r.up = { ...up }
    // Nose perpendicular to that up, so the frame is well formed.
    r.fwd = Math.abs(up.y) > 0.5 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 }
    r.grounded = true
    r.altitude = 0.55
    r.events = [{ t: 'ramp', power: 32 }]

    const before = vfx.group.children.length
    expect(before).toBeGreaterThan(0)
    vfx.update(1 / 60, race.state, { x: 0, y: 0, z: 200 }, 0)

    const mesh = vfx.group.children.find(
      (c) => (c as THREE.Mesh).geometry?.getAttribute('aAxis') !== undefined,
    ) as THREE.Mesh
    expect(mesh).toBeTruthy()
    const geo = mesh.geometry as THREE.InstancedBufferGeometry
    const ax = geo.getAttribute('aAxis').array as Float32Array
    const kd = geo.getAttribute('aMisc2').array as Float32Array
    const born = geo.getAttribute('aMisc').array as Float32Array
    const out: { x: number; y: number; z: number; kind: number }[] = []
    for (let i = 0; i < kd.length / 4; i++) {
      // birth 0 means the slot was never written this run.
      if (born[i * 4] === 0) continue
      out.push({ x: ax[i * 3], y: ax[i * 3 + 1], z: ax[i * 3 + 2], kind: kd[i * 4 + 2] })
    }
    vfx.dispose()
    return out
  }

  it('a ramp launch on a wall builds its light column along the wall', () => {
    const wall = { x: 1, y: 0, z: 0 }
    const rows = shoot(true, wall)
    const beams = rows.filter((p) => p.kind === 6)
    const grounds = rows.filter((p) => p.kind === 3)
    // A ramp launch emits exactly one column and two ground fronts.
    expect(beams.length).toBeGreaterThan(0)
    expect(grounds.length).toBeGreaterThan(0)
    for (const b of [...beams, ...grounds]) {
      expect(b.x).toBeCloseTo(wall.x, 5)
      expect(b.y).toBeCloseTo(wall.y, 5)
      expect(b.z).toBeCloseTo(wall.z, 5)
    }
  })

  it('...and leaves every particle on a flat track pointing at world +Y', () => {
    const rows = shoot(false, { x: 1, y: 0, z: 0 })
    expect(rows.length).toBeGreaterThan(0)
    for (const b of rows) {
      // Not toBeCloseTo: with the gravity flag off nothing may touch the axis,
      // even when the racer state is carrying a poisoned up-vector.
      expect(b.x).toBe(0)
      expect(b.y).toBe(1)
      expect(b.z).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------
describe('the finish shot photographs the car in its own plane', () => {
  const RDT = 1 / 60

  /**
   * Hold a racer on the wall and run the finish rig on it. The car is not
   * stepped: this measures the SHOT's geometry, not the victory lap's.
   */
  function shootOnTheWall(reduceMotion: boolean) {
    const { r, track } = racerOnTheWall(80)
    const cam = new ChaseCamera(16 / 9)
    cam.gravity = true
    cam.reset(r)
    for (let f = 0; f < 30; f++) cam.update(r, RDT, 60, false, reduceMotion)
    cam.beginCinematic(r)

    const car = new THREE.Vector3(r.pos.x, r.pos.y, r.pos.z)
    const up = new THREE.Vector3(r.up.x, r.up.y, r.up.z)
    const rows: { alongUp: number; radius: number; height: number; edge: number; az: number; step: number }[] = []
    const prev = cam.camera.position.clone()
    for (let f = 0; f < Math.round(T.ceremony.maxDuration * 60); f++) {
      cam.updateCinematic(r, RDT, track, reduceMotion)
      const p = cam.camera.position
      const off = p.clone().sub(car)
      const alongUp = off.dot(up)
      const inPlane = off.clone().addScaledVector(up, -alongUp)
      const proj = track.project(p, r.splineS)
      rows.push({
        alongUp,
        radius: inPlane.length(),
        height: proj.height,
        edge: Math.abs(proj.lateral) / Math.max(1, proj.sample.width),
        // Bearing of the camera around the car IN THE CAR'S OWN PLANE.
        az: Math.atan2(inPlane.dot(new THREE.Vector3(r.fwd.x, r.fwd.y, r.fwd.z)), inPlane.dot(
          new THREE.Vector3(r.fwd.x, r.fwd.y, r.fwd.z).cross(up),
        )),
        step: p.distanceTo(prev),
      })
      prev.copy(p)
    }
    return { rows, cam, r, track }
  }

  it('orbits in the plane the car is driving in, never through the wall', () => {
    const { rows } = shootOnTheWall(false)
    // Skip the handover: it starts from wherever the chase rig was standing.
    const settled = rows.slice(Math.round(T.ceremony.blendIn * 60) + 6)
    expect(settled.length).toBeGreaterThan(200)
    for (const row of settled) {
      // ABOVE the car along the CAR's up, for the whole revolution. A level
      // orbit around a car on a vertical wall spends half of every turn
      // BEHIND the road it is meant to be looking at.
      expect(row.alongUp).toBeGreaterThan(1.0)
      // ...and the orbit radius is the orbit radius, not a projection of it.
      expect(row.radius).toBeGreaterThan(T.ceremony.orbitRadius * 0.45)
      // Both track clamps still hold, in the road's own frame.
      expect(row.height).toBeGreaterThan(T.ceremony.groundClearance * 0.6)
      expect(row.edge).toBeLessThan(0.95)
    }
  })

  it('walks a real orbit around the car rather than following its nose', () => {
    const { rows } = shootOnTheWall(false)
    let travel = 0
    for (let i = 1; i < rows.length; i++) {
      let d = rows[i].az - rows[i - 1].az
      while (d > Math.PI) d -= Math.PI * 2
      while (d < -Math.PI) d += Math.PI * 2
      travel += d
    }
    const wanted = T.ceremony.orbitRate * (Math.PI / 180) * T.ceremony.maxDuration
    // The car is stationary here, so the whole of this is the camera walking.
    expect(Math.abs(travel)).toBeGreaterThan(wanted * 0.7)
  })

  it('keeps the horizon on the car rather than righting it to world +Y', () => {
    const { cam, r } = shootOnTheWall(false)
    // The old shot eased the lens back to world +Y over the blend window,
    // which spins the whole world a quarter turn under a stationary subject.
    expect(cam.camera.up.x).toBeCloseTo(r.up.x, 2)
    expect(cam.camera.up.y).toBeCloseTo(r.up.y, 2)
    expect(cam.camera.up.z).toBeCloseTo(r.up.z, 2)
    expect(Math.abs(r.up.y)).toBeLessThan(0.2)
  })

  it('moves smoothly on the wall -- no cut, no snap', () => {
    const { rows } = shootOnTheWall(false)
    expect(Math.max(...rows.map((x) => x.step))).toBeLessThan(4)
  })

  it('reduced motion still gets a legal shot on the wall', () => {
    const { rows } = shootOnTheWall(true)
    const settled = rows.slice(Math.round(T.ceremony.blendIn * 60) + 6)
    for (const row of settled) {
      expect(row.height).toBeGreaterThan(T.ceremony.groundClearance * 0.6)
      expect(row.alongUp).toBeGreaterThan(1.0)
    }
    // ...and it does not walk: the car is stationary, so any travel is orbit.
    let travel = 0
    for (let i = 1; i < rows.length; i++) {
      let d = rows[i].az - rows[i - 1].az
      while (d > Math.PI) d -= Math.PI * 2
      while (d < -Math.PI) d += Math.PI * 2
      travel += d
    }
    const wanted = T.ceremony.orbitRate * (Math.PI / 180) * T.ceremony.maxDuration
    expect(Math.abs(travel)).toBeLessThan(wanted * 0.5)
  })
})

// ---------------------------------------------------------------------------
// THE GROUND UNDER A ROAD THAT STANDS UP
//
// environment.ts derives its terrain shell from the ribbon's own banked frame,
// parameterised by the PLAN projection of that frame. A vertical road projects
// to a line: `|right_xz|` goes to zero, the plan -> lateral scale (its
// reciprocal) goes to infinity, and the `cell / |right_xz|` term inside `tuck`
// takes the ground plane with it.
// ---------------------------------------------------------------------------
describe('the terrain shell survives a road that stands up', () => {
  function build(def: typeof TEST_WALLRIDE, forceGravity = false) {
    const track = new Track(def)
    if (forceGravity) Object.defineProperty(track, 'hasGravity', { value: true })
    const scene = new THREE.Scene()
    const env = buildEnvironment(track, scene, QUALITY_PRESETS.high)
    const mesh = env.group.getObjectByName('terrain') as THREE.Mesh
    const pos = (mesh.geometry.getAttribute('position').array as Float32Array).slice()
    env.dispose()
    return { track, pos }
  }

  it('puts every vertex at a finite, plausible height on a 270-degree wall-ride', () => {
    const { pos } = build(TEST_WALLRIDE)
    let worstLow = Infinity, worstHigh = -Infinity
    for (let i = 1; i < pos.length; i += 3) {
      expect(Number.isFinite(pos[i])).toBe(true)
      if (pos[i] < worstLow) worstLow = pos[i]
      if (pos[i] > worstHigh) worstHigh = pos[i]
    }
    // Measured on the unfixed build: -2.04e16 metres. The rim of the world
    // sags to about -120 by design, so anything past a few hundred is the
    // 1 / |right_xz| blow-up and not scenery.
    expect(worstLow).toBeGreaterThan(-400)
    expect(worstHigh).toBeLessThan(400)
  })

  it('the same, on a full vertical loop', () => {
    const { pos } = build(TEST_LOOP)
    for (let i = 1; i < pos.length; i += 3) {
      expect(Number.isFinite(pos[i])).toBe(true)
      expect(Math.abs(pos[i])).toBeLessThan(400)
    }
  })

  it('never lets the ground rise through the road on a wall-ride', () => {
    const { track, pos } = build(TEST_WALLRIDE)
    // Index the grid by plan cell so this is not a 600 x 9000 scan.
    const nearest = (x: number, z: number): number => {
      let bd = Infinity, by = 0
      for (let i = 0; i < pos.length; i += 3) {
        const d = (pos[i] - x) ** 2 + (pos[i + 2] - z) ** 2
        if (d < bd) { bd = d; by = pos[i + 1] }
      }
      return by
    }
    const S = track.samples
    let worst = -Infinity
    const step = Math.max(1, Math.round(S.length / 40))
    for (let k = 0; k < S.length; k += step) {
      const s = S[k]
      for (const lat of [-s.width * 0.85, 0, s.width * 0.85]) {
        const rx = s.pos.x + s.right.x * lat
        const ry = s.pos.y + s.right.y * lat
        const rz = s.pos.z + s.right.z * lat
        worst = Math.max(worst, nearest(rx, rz) - ry)
      }
    }
    // The grid is 11 m to a cell, so the nearest vertex to a road point can be
    // several metres away laterally; a small positive reading is the sampling,
    // not the shell. Anything past a couple of metres is the road being eaten.
    expect(worst).toBeLessThan(2)
  })

  it('leaves a shipped track\'s terrain untouched, flag or no flag', () => {
    // The gravity branch is gated on the section's own cross-slope, not on the
    // track: at Rustfall's steepest bank (34 degrees) it is exactly inert. So
    // building the SAME track with `hasGravity` forced on must produce a
    // byte-identical vertex buffer -- which is a stronger statement than "the
    // flag is off", and the one that actually protects the shipped frame.
    for (const def of [RUSTFALL, CRYOSTATIC]) {
      const plain = build(def)
      const forced = build(def, true)
      expect(forced.pos.length).toBe(plain.pos.length)
      for (let i = 0; i < plain.pos.length; i++) {
        // Exact equality, deliberately.
        if (forced.pos[i] !== plain.pos[i]) {
          throw new Error(`${def.id}: terrain vertex float ${i} moved ${plain.pos[i]} -> ${forced.pos[i]}`)
        }
      }
    }
  })
})
