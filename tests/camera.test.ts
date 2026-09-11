import * as THREE from 'three'
import { describe, it, expect } from 'vitest'
import {
  ChaseCamera, CAMERA_LIMITS, DEFAULT_CAMERA_SETTINGS, anchorYToAngle,
  angleToAnchorY, normaliseCameraSettings, type CameraSettings,
} from '../src/game/camera'
import { Race } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { TEST_PLAIN } from './fixtures/testTrack'
import { resetAI } from '../src/sim/ai'
import { emptyInput } from '../src/sim/types'
import { TUNING as T } from '../src/content/tuning'
import { getDerived, CHASSIS } from '../src/content/chassis'
import type { SimConfig, InputFrame, RacerState } from '../src/sim/types'

const C = T.camera
const RDT = 1 / 60

const cfg = (chassisId: string): SimConfig => ({
  seed: 5, totalLaps: 3, racerCount: 1, trackId: 'test-plain',
  chassisIds: [chassisId], pilotIds: [''],
  localRacerIndex: 0, aiSkill: [0],
})

/**
 * Apparent on-screen size of the car, in arbitrary units.
 *
 * A perspective camera images a fixed-size object at `1 / (d * tan(fov/2))` of
 * the frame height, where d is the ACTUAL distance from the camera to the
 * object -- not the distance the rig was aiming for. On a chase camera those
 * two are very different numbers at racing speed, because the position damping
 * leaves the camera trailing a car that is moving 1.3 m per frame.
 */
function apparentSize(cam: ChaseCamera, r: RacerState): number {
  const p = cam.camera.position
  const d = Math.hypot(p.x - r.pos.x, p.y - r.pos.y, p.z - r.pos.z)
  return 1 / (Math.max(0.1, d) * Math.tan(cam.camera.fov * 0.5 * Math.PI / 180))
}

/**
 * Bank a drift tier on the flat ring, release it, and run two chase cameras
 * over the identical sequence of racer states: one that fires the vertigo shot
 * and one that does not. Returns the per-frame apparent-size ratio between
 * them, from the release frame onward.
 */
function releaseSequence(chassisId: string, opts: { reduceMotion?: boolean; hold?: number } = {}) {
  resetAI()
  const race = new Race(new Track(TEST_PLAIN), cfg(chassisId))
  const r = race.state.racers[0]
  while (race.state.phase === 'countdown') race.step()

  const top = getDerived(chassisId).topSpeed
  const warm = emptyInput(); warm.throttle = 1
  for (let f = 0; f < 900; f++) {
    race.setInput(0, warm); race.step()
    if (r.grounded && Math.hypot(r.vel.x, r.vel.z) > 45) break
  }

  const withShot = new ChaseCamera(16 / 9)
  const control = new ChaseCamera(16 / 9)
  withShot.reset(r); control.reset(r)
  const rm = opts.reduceMotion ?? false
  const tick = (): void => {
    withShot.update(r, RDT, top, false, rm)
    control.update(r, RDT, top, false, rm)
  }

  // Hold the slide, snaking so the ring's surface is never left.
  const hold = opts.hold ?? 5.0
  let side: 1 | -1 = 1
  for (let f = 0; f < Math.round(hold * 60); f++) {
    const inp: InputFrame = { ...emptyInput(), throttle: 1, steer: side, drift: true }
    race.setInput(0, inp); race.step(); tick()
    if (f % 60 === 17) side = -1
    if (f % 60 === 59) side = 1
  }
  const tier = r.driftTier

  // Release. The impulse lands the way main.ts delivers it: raised by the VFX
  // pass after the camera has already updated this frame, so it takes effect
  // from the next one.
  const sizeBefore = apparentSize(withShot, r)
  const idle: InputFrame = { ...emptyInput(), throttle: 1 }
  race.setInput(0, idle); race.step(); tick()
  withShot.addDolly(C.dollyPerTier[Math.min(Math.max(tier, 0), C.dollyPerTier.length - 1)])

  const ratios: number[] = []
  const pullIn: number[] = []
  let peakFovGap = 0
  const dist = (cam: ChaseCamera): number => Math.hypot(
    cam.camera.position.x - r.pos.x, cam.camera.position.y - r.pos.y, cam.camera.position.z - r.pos.z)
  for (let f = 0; f < Math.round(2.5 * 60); f++) {
    race.setInput(0, idle); race.step(); tick()
    ratios.push(apparentSize(withShot, r) / apparentSize(control, r))
    pullIn.push(dist(control) - dist(withShot))
    peakFovGap = Math.max(peakFovGap, withShot.camera.fov - control.camera.fov)
  }
  return {
    tier, ratios, pullIn, peakFovGap, sizeBefore, withShot, control,
    maxPullIn: Math.max(...pullIn),
  }
}

/**
 * Drive the flat ring through a speed RANGE -- accelerate to top speed, lift,
 * brake, accelerate again -- and hand every frame to a chase camera. The
 * distance lock is a claim about a camera chasing a car whose speed keeps
 * changing, so a constant-speed sample would prove nothing.
 */
function speedSweep(chassisId: string, frames = 60 * 26) {
  resetAI()
  const race = new Race(new Track(TEST_PLAIN), cfg(chassisId))
  const r = race.state.racers[0]
  while (race.state.phase === 'countdown') race.step()
  const top = getDerived(chassisId).topSpeed
  const cam = new ChaseCamera(16 / 9)
  cam.reset(r)

  const out: { ground: number; dist: number; speed: number; dolly: number }[] = []
  for (let f = 0; f < frames; f++) {
    const phase = Math.floor(f / (60 * 3.2)) % 4
    const inp: InputFrame = {
      ...emptyInput(),
      throttle: phase === 2 ? 0 : 1,
      brake: phase === 3 ? 1 : 0,
      steer: phase === 1 ? 0.5 : 0,
    }
    race.setInput(0, inp)
    race.step()
    cam.update(r, RDT, top, false, false)
    const p = cam.camera.position
    out.push({
      // The lock pins the component PERPENDICULAR to the camera's up, which on
      // this flat ring is the XZ plane.
      ground: Math.hypot(p.x - r.pos.x, p.z - r.pos.z),
      dist: Math.hypot(p.x - r.pos.x, p.y - r.pos.y, p.z - r.pos.z),
      speed: Math.hypot(r.vel.x, r.vel.z),
      dolly: cam.dollyLevel,
    })
  }
  return out
}

describe('the rig holds a set distance from the car', () => {
  // The complaint this answers: "the camera keeps changing distance". Two
  // things were doing it and only one was visible in the source -- a 14% target
  // term worth 1.26m, and the position damping, worth v * posHalfLife / ln 2,
  // which is 13.2m at 76 m/s. The lock corrects the LENGTH of the damped offset
  // and leaves its DIRECTION alone, so the corner trail survives.
  for (const c of CHASSIS) {
    it(`${c.id}: the ground distance does not move with speed`, () => {
      const rows = speedSweep(c.id).filter((x) => x.dolly === 0)
      expect(rows.length, 'the sweep must produce un-dollied frames').toBeGreaterThan(600)
      const speeds = rows.map((x) => x.speed)
      expect(Math.max(...speeds) - Math.min(...speeds),
        'the sweep must actually change speed, or it proves nothing')
        .toBeGreaterThan(20)
      for (const x of rows) {
        expect(Math.abs(x.ground - C.distance),
          `ground distance ${x.ground.toFixed(3)}m at ${x.speed.toFixed(1)} m/s`)
          .toBeLessThan(1e-6)
      }
    })
  }

  it('...and turning the lock off puts the old rubber band straight back', () => {
    const rows = speedSweep('solaire').filter((x) => x.dolly === 0)
    const lock = C.distanceLock
    const gain = C.distanceSpeedGain
    try {
      // Cast: TUNING is a const object, and this reaches past that on purpose --
      // the point of the test is that the behaviour is a TUNABLE and not a
      // deletion, so the dial has to be provably still connected.
      const w = C as unknown as { distanceLock: number; distanceSpeedGain: number }
      w.distanceLock = 0
      w.distanceSpeedGain = 0.14
      const loose = speedSweep('solaire').filter((x) => x.dolly === 0)
      const spread = (a: typeof rows) =>
        Math.max(...a.map((x) => x.ground)) - Math.min(...a.map((x) => x.ground))
      expect(spread(loose), 'unlocked, the distance must vary with speed again')
        .toBeGreaterThan(4)
      expect(spread(rows), 'locked, it must not').toBeLessThan(1e-5)
    } finally {
      const w = C as unknown as { distanceLock: number; distanceSpeedGain: number }
      w.distanceLock = lock
      w.distanceSpeedGain = gain
    }
  })
})

describe('the vertigo shot fires on a boost, not only on a drift release', () => {
  /**
   * A racer at a stated speed with a stated boost, built the way the existing
   * one-shot test builds one. `boostMag` is a STEP function in the sim -- set on
   * the grant, held, zeroed when the timer expires -- which is why the camera
   * can pick a boost up from its rise without a new event.
   */
  const fake = (speed: number): RacerState => ({
    pos: { x: 0, y: 1, z: 0 }, vel: { x: 0, y: 0, z: speed }, yaw: 0, yawRate: 0,
    driftSide: 0, driftInward: 0, boostMag: 0, boostSource: 'none',
  } as unknown as RacerState)

  it('a pad boost fires it; the same boost held on does not fire it again', () => {
    const cam = new ChaseCamera(16 / 9)
    const r = fake(60)
    cam.reset(r)
    cam.update(r, RDT, 60, false, false)
    expect(cam.dollyLevel).toBe(0)

    r.boostMag = T.boost.padMag
    r.boostSource = 'pad'
    cam.update(r, RDT, 60, false, false)
    const fired = cam.dollyLevel
    // DERIVED, NOT A LITERAL. This used to assert `> 0.4`, which was a number
    // that happened to sit under a boostDollyGain of 0.55; turning the gain
    // down to 0.30 for motion comfort broke a test that was never about 0.4.
    // What the rig actually promises is that a grant of `padMag` fires an
    // impulse scaled by how big that rise is against `boostDollyFullRise`, so
    // that is what gets asserted -- and it now survives any retune of either.
    //
    // The one frame of decay is not slop, it is the read: update() raises the
    // impulse and then decays it before returning, so `dollyLevel` on the
    // firing frame is already one step down the curve. Leaving it out put the
    // expectation 4.5% high and would have been "fixed" by loosening the
    // tolerance until the test stopped meaning anything.
    const want = Math.min(1, T.boost.padMag / C.boostDollyFullRise)
      * C.boostDollyGain * DEFAULT_CAMERA_SETTINGS.boost
      * Math.pow(2, -RDT / C.dollyHalfLife)
    expect(fired, 'a pad boost must fire the shot the tuning asks for')
      .toBeCloseTo(want, 4)
    // ...and it must be a real punch rather than a token one, whatever the
    // tuning says.
    expect(fired, 'a pad boost must fire a punch, not a twitch')
      .toBeGreaterThan(C.boostDollyGain * 0.5)

    // A strip calls applyBoost on every frame a wheel is on it. Only the first
    // raises boostMag, so only the first may punch -- otherwise crossing a
    // 50m strip is 65 vertigo shots.
    for (let i = 0; i < 40; i++) cam.update(r, RDT, 60, false, false)
    expect(cam.dollyLevel, 'a held boost must not re-fire').toBeLessThan(fired)
  })

  it('a second grant inside the cooldown does not punch again', () => {
    const cam = new ChaseCamera(16 / 9)
    const r = fake(60)
    cam.reset(r)
    r.boostMag = T.boost.padMag; r.boostSource = 'pad'
    cam.update(r, RDT, 60, false, false)
    // Hand over a second, BIGGER grant well inside the refractory period. The
    // impulse must keep decaying rather than jump: three punches in a second
    // is the shape of effect that makes people ill. See
    // TUNING.camera.boostDollyCooldown.
    for (let i = 0; i < 40; i++) cam.update(r, RDT, 60, false, false)
    const decayed = cam.dollyLevel
    r.boostMag = 0.9; r.boostSource = 'item'
    cam.update(r, RDT, 60, false, false)
    expect(cam.dollyLevel, 'inside the cooldown, no second punch')
      .toBeLessThan(decayed)

    // ...and once it has expired, the next grant does punch. `boostMag` has to
    // fall first: a rise is a rise from wherever it currently is, which is how
    // a sustained strip is prevented from re-firing.
    for (let i = 0; i < Math.round(C.boostDollyCooldown * 60) + 4; i++) {
      cam.update(r, RDT, 60, false, false)
    }
    const quiet = cam.dollyLevel
    r.boostMag = 0
    cam.update(r, RDT, 60, false, false)
    r.boostMag = 0.9
    cam.update(r, RDT, 60, false, false)
    expect(cam.dollyLevel, 'after the cooldown it fires again')
      .toBeGreaterThan(C.boostDollyGain * 0.5)
    expect(quiet, 'and it had genuinely gone quiet first').toBeLessThan(0.02)
  })

  it('a stationary car gets no shot, so the rocket start does not warp', () => {
    const cam = new ChaseCamera(16 / 9)
    const r = fake(0.4)
    cam.reset(r)
    r.boostMag = T.drift.tierBoost[T.boost.rocketStartTier]
    r.boostSource = 'start'
    cam.update(r, RDT, 60, false, false)
    expect(cam.dollyLevel, 'no background to stretch, no shot').toBe(0)
  })

  it('reduced motion suppresses it before a single frame of it is placed', () => {
    const calm = new ChaseCamera(16 / 9)
    const plain = new ChaseCamera(16 / 9)
    const r = fake(60)
    calm.reset(r); plain.reset(r)
    calm.update(r, RDT, 60, false, true); plain.update(r, RDT, 60, false, true)
    r.boostMag = T.boost.padMag
    r.boostSource = 'pad'
    // Not "small". Zero, on the frame the boost lands and on every frame after,
    // in the impulse AND in what the composite pass is handed. The distance
    // block used to run before the suppression and leaked a frame of movement.
    for (let f = 0; f < 90; f++) {
      calm.update(r, RDT, 60, false, true)
      expect(calm.dollyLevel, `frame ${f}`).toBe(0)
      plain.update(r, RDT, 60, false, true)
      expect(calm.camera.position.distanceTo(plain.camera.position)).toBeLessThan(1e-9)
      expect(calm.camera.fov).toBeCloseTo(plain.camera.fov, 9)
    }
  })

  it('a drift release is left to its own tuned ladder, not flattened by this', () => {
    // main.ts fires drift releases off the VFX pass's sim-frame-guarded
    // dollyRequest with dollyPerTier; if the rise detector also claimed them, a
    // Tier-0 release would punch with the flat boost impulse instead of 0.30.
    const cam = new ChaseCamera(16 / 9)
    const r = fake(60)
    cam.reset(r)
    cam.update(r, RDT, 60, false, false)
    r.boostMag = T.drift.tierBoost[3]
    r.boostSource = 'drift'
    cam.update(r, RDT, 60, false, false)
    expect(cam.dollyLevel, 'the rise detector must ignore drift-sourced boosts').toBe(0)
  })
})

describe('vertigo shot: the CAR stays put while the world stretches', () => {
  // A plain FOV spike is a zoom: the car shrinks with everything else, which
  // reads as the camera backing off at the exact moment the car is supposed to
  // be fired down the road. The whole point of the dolly is that the FOV and
  // the camera distance move in OPPOSITE directions so the subject holds its
  // size. That is only true if the compensation acts on the distance the
  // camera actually is from the car -- at 76 m/s the position damping leaves
  // it ~10 m further back than the distance the rig was aiming for, so
  // compensating the target distance instead moves the camera by a fraction of
  // what the FOV is asking for and the shot inverts into a zoom-out.
  for (const c of CHASSIS) {
    it(`${c.id}: the car never shrinks against a no-dolly control`, () => {
      const { tier, ratios } = releaseSequence(c.id)
      expect(tier, 'the rig must bank a tier to fire the shot').toBeGreaterThanOrEqual(0)
      const min = Math.min(...ratios)
      const max = Math.max(...ratios)
      // Same size, within the slack `dollyPull` deliberately leaves: at 0.85
      // of a textbook vertigo the residual is (tan ratio)^0.15, about 3.5% at
      // the peak of a Tier-3 impulse. Nothing else may move the subject.
      //
      // Compensating the rig's TARGET distance instead of its real one gives
      // 0.90 here and, worse, 1.14 for the two seconds afterwards as the
      // latched pull-in unwinds -- a shrink followed by a swell, which is a
      // wobble, not a vertigo shot.
      expect(min, `car shrank to ${min.toFixed(3)}x the no-dolly size`).toBeGreaterThan(0.94)
      expect(max, `car grew to ${max.toFixed(3)}x the no-dolly size`).toBeLessThan(1.005)
    })
  }

  it('still opens the frame up, and still moves the camera', () => {
    const s = releaseSequence('solaire')
    expect(s.tier).toBeGreaterThanOrEqual(0)
    // A shot that holds the subject by not doing anything is not a shot. The
    // FOV must genuinely spike past the control...
    expect(s.peakFovGap, `peak FOV gap ${s.peakFovGap.toFixed(1)} deg`).toBeGreaterThan(8)
    // ...and the camera must genuinely come in to pay for it.
    //
    // As a FRACTION OF THE RIG, not a fixed 1.5m. The pull-in is whatever
    // distance cancels the lens punch, so it scales with both `dollyFov` and
    // `distance`; the previous literal silently encoded a 30-degree punch on a
    // 9m rig and failed the moment either moved. A tenth of the rig distance
    // is the floor for "you can see it happen" -- it currently clears that
    // with room, and it would still catch the pull-in being removed, which is
    // the regression this test exists for.
    const floor = C.distance * 0.10
    expect(
      s.maxPullIn,
      `max pull-in ${s.maxPullIn.toFixed(2)}m, floor ${floor.toFixed(2)}m`,
    ).toBeGreaterThan(floor)
  })

  it('the pull-in unwinds with the impulse instead of latching on', () => {
    const s = releaseSequence('solaire')
    // This is a punch, not a state. The pull-in has to track the impulse down,
    // so by 2s it must be a rounding error against its own peak. Scaling the
    // rig's target distance instead held the camera 3.3m in for the whole
    // 2.3s the impulse took to reach its 0.002 cut-off -- 97% of peak at 2s --
    // and then snapped the target 3m back out in a single frame.
    const late = Math.max(...s.pullIn.slice(Math.round(2.0 * 60)))
    expect(late / s.maxPullIn,
      `pull-in still ${(100 * late / s.maxPullIn).toFixed(0)}% of its ${s.maxPullIn.toFixed(2)}m peak at 2s`)
      .toBeLessThan(0.10)
  })

  it('reduced motion suppresses the shot entirely, position included', () => {
    const plain = releaseSequence('solaire', { reduceMotion: true })
    // Not one frame of the camera may move differently from the control.
    for (let i = 0; i < plain.ratios.length; i++) {
      expect(Math.abs(plain.ratios[i] - 1), `frame ${i} ratio ${plain.ratios[i]}`).toBeLessThan(1e-9)
    }
  })

  it('the impulse is one-shot: the strongest wins, it never accumulates', () => {
    const cam = new ChaseCamera(16 / 9)
    const r = {
      pos: { x: 0, y: 1, z: 0 }, vel: { x: 0, y: 0, z: 40 }, yaw: 0, yawRate: 0,
      driftSide: 0, driftInward: 0, boostMag: 0,
    } as unknown as RacerState
    cam.reset(r)
    cam.update(r, RDT, 60, false, false)
    const one = cam.camera.fov
    for (let i = 0; i < 8; i++) cam.addDolly(1)
    cam.update(r, RDT, 60, false, false)
    const many = cam.camera.fov
    cam.reset(r)
    cam.update(r, RDT, 60, false, false)
    cam.addDolly(1)
    cam.update(r, RDT, 60, false, false)
    expect(many).toBeCloseTo(cam.camera.fov, 6)
    expect(many).toBeGreaterThan(one)
  })
})


// ===========================================================================
// THE PLAYER'S CAMERA CONTROLS
//
// Six numbers the player owns. The tests that matter here are not "does the
// slider move" -- they are the three ways a settings system silently ruins a
// game: a default that does not reproduce what shipped, a default that cannot
// be got back to, and a setting somewhere in range that produces a frame you
// cannot drive in.
// ===========================================================================

describe('camera settings: the defaults ARE the authored rig', () => {
  it('the rig geometry defaults track the tuning table', () => {
    // Distance, height and angle are DERIVED from TUNING, so the table stays
    // the single source of truth for the shipped frame. The four effect dials
    // are not -- they are a set of choices made by eye with the live control,
    // which is the only way a camera can be judged, so they are stated
    // outright rather than dressed up as derived.
    expect(DEFAULT_CAMERA_SETTINGS.distance).toBe(C.distance)
    expect(DEFAULT_CAMERA_SETTINGS.height).toBe(C.height)
    expect(DEFAULT_CAMERA_SETTINGS.shake).toBe(1)
    // The angle is the authored anchor, rounded onto the control's grid. The
    // rounding is allowed; drifting off the anchor is not.
    // The rounding onto the grid is worth 0.0009 of frame height, which is
    // 0.8 of a pixel on the 944-high reference frame the 0.812 was measured
    // from. Stated as a bound rather than a decimal place so the cost is
    // visible in the test rather than hidden in a tolerance argument.
    expect(Math.abs(angleToAnchorY(DEFAULT_CAMERA_SETTINGS.angle) - C.anchorY))
      .toBeLessThan(0.002)
    // The invariant is that the default IS the authored angle put on the
    // grid -- not that the two are within some tolerance of each other.
    expect(Math.round(anchorYToAngle(C.anchorY) * 2) / 2)
      .toBe(DEFAULT_CAMERA_SETTINGS.angle)
  })

  it('tracking 0.30 still reproduces the authored damping exactly', () => {
    // The dial maps one number onto four constants through a piecewise lerp
    // anchored on the authored point. The DEFAULT has since moved off that
    // point deliberately, but the point itself must keep meaning what it
    // meant: it is the rig that was signed off, and "anchored" has to mean
    // EXACTLY, not nearly.
    const cam = new ChaseCamera(16 / 9)
    cam.applySettings({ tracking: 0.30 })
    const rig = (cam as unknown as { rig: Record<string, number> }).rig
    expect(rig.trailDamp).toBeCloseTo(C.trailDamp, 12)
    expect(rig.posHalfLife).toBeCloseTo(C.posHalfLife, 12)
    expect(rig.yawHalfLife).toBeCloseTo(C.yawHalfLife, 12)
    // ...and the car is still WELDED there. The buffer only opens above it.
    expect(rig.anchorSlack).toBe(0)
  })

  it('the buffer opens only above the authored point, and is bounded', () => {
    const slackAt = (t: number): number => {
      const cam = new ChaseCamera(16 / 9)
      cam.applySettings({ tracking: t })
      return (cam as unknown as { rig: Record<string, number> }).rig.anchorSlack
    }
    expect(slackAt(0)).toBe(0)
    expect(slackAt(0.30)).toBe(0)
    expect(slackAt(1)).toBeCloseTo(C.anchorSlack, 12)
    expect(slackAt(0.65)).toBeGreaterThan(0)
    expect(slackAt(0.65)).toBeLessThan(C.anchorSlack)
  })

  it('every default sits on the step grid, so it can be got back to', () => {
    // A default that is not reachable by stepping is a trap: nudge it once and
    // the shipped frame is gone for good. This is exactly how the angle
    // default was caught at 20.55 against a grid of whole degrees.
    for (const key of Object.keys(CAMERA_LIMITS) as (keyof CameraSettings)[]) {
      const [lo, hi, step] = CAMERA_LIMITS[key]
      const v = DEFAULT_CAMERA_SETTINGS[key]
      expect(v, `${key} default below its minimum`).toBeGreaterThanOrEqual(lo)
      expect(v, `${key} default above its maximum`).toBeLessThanOrEqual(hi)
      const n = (v - lo) / step
      expect(
        Math.abs(n - Math.round(n)),
        `${key} default ${v} is off its ${step} grid from ${lo}`,
      ).toBeLessThan(1e-9)
    }
  })
})

describe('camera settings: junk in cannot produce a broken frame', () => {
  it('clamps, fills and ignores rubbish', () => {
    const s = normaliseCameraSettings({
      distance: 1e9, height: -40, angle: Number.NaN,
      shake: 'loud', tracking: undefined, boost: Number.POSITIVE_INFINITY,
    } as unknown as Partial<CameraSettings>)
    expect(s.distance).toBe(CAMERA_LIMITS.distance[1])
    expect(s.height).toBe(CAMERA_LIMITS.height[0])
    // NaN, a string and undefined all fall back rather than propagating: a
    // NaN reaching the rig blanks the frame, and it would arrive from a
    // hand-edited localStorage blob, not from the UI.
    expect(s.angle).toBe(DEFAULT_CAMERA_SETTINGS.angle)
    expect(s.shake).toBe(DEFAULT_CAMERA_SETTINGS.shake)
    expect(s.tracking).toBe(DEFAULT_CAMERA_SETTINGS.tracking)
    // Infinity is JUNK, not "very large": it falls back to the default rather
    // than clamping to the maximum, because a stored Infinity means the blob
    // is corrupt and guessing that the player wanted the loudest possible
    // setting is the wrong guess to make.
    expect(s.boost).toBe(DEFAULT_CAMERA_SETTINGS.boost)
    expect(s.tunnel).toBe(DEFAULT_CAMERA_SETTINGS.tunnel)
    expect(normaliseCameraSettings(null)).toEqual({ ...DEFAULT_CAMERA_SETTINGS })
  })
})

describe('camera settings: the dials do what they say', () => {
  const fake = (speed: number): RacerState => ({
    pos: { x: 0, y: 1, z: 0 }, vel: { x: 0, y: 0, z: speed }, yaw: 0, yawRate: 0,
    driftSide: 0, driftInward: 0, boostMag: 0, boostSource: 'none',
    fwd: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 },
  } as unknown as RacerState)

  it('the boost dial scales the shot, and 0 switches it off entirely', () => {
    const level = (dial: number): number => {
      const cam = new ChaseCamera(16 / 9)
      cam.applySettings({ boost: dial })
      const r = fake(60)
      cam.reset(r)
      cam.update(r, RDT, 60, false, false)
      r.boostMag = T.boost.padMag
      r.boostSource = 'pad'
      cam.update(r, RDT, 60, false, false)
      return cam.dollyLevel
    }
    const full = level(1)
    expect(full).toBeGreaterThan(0)
    expect(level(0.5), 'half the dial, half the punch').toBeCloseTo(full * 0.5, 6)
    // Off must mean OFF: the same value feeds the camera pull-in, the FOV
    // punch and the composite's warp, so a player who turns this down to stop
    // feeling ill must not be left with two thirds of the effect.
    expect(level(0), 'a zeroed dial fires nothing at all').toBe(0)
  })

  /**
   * THE SEPARATION, PINNED.
   *
   * These two used to be one number, and the consequence was invisible until
   * someone drove it: cutting the camera shove for motion comfort took two
   * thirds of the tunnel vision with it, and no setting could bring it back.
   * The failure mode if they are ever re-coupled is exactly that -- a quiet
   * loss of an effect while the thing you were tuning looks fine -- so it is
   * worth a test that would catch it on the next pass rather than the next
   * playtest.
   */
  it('the camera dial moves the camera and leaves the screen alone', () => {
    const fire = (set: Partial<CameraSettings>): { dolly: number; warp: number } => {
      const cam = new ChaseCamera(16 / 9)
      cam.applySettings(set)
      const r = fake(60)
      cam.reset(r)
      cam.update(r, RDT, 60, false, false)
      r.boostMag = T.boost.padMag
      r.boostSource = 'pad'
      cam.update(r, RDT, 60, false, false)
      return { dolly: cam.dollyLevel, warp: cam.warpLevel }
    }
    const base = fire({ boost: 1, tunnel: 1 })
    const loudCam = fire({ boost: 2, tunnel: 1 })
    const quietCam = fire({ boost: 0, tunnel: 1 })

    expect(loudCam.dolly, 'the camera dial must move the camera')
      .toBeCloseTo(base.dolly * 2, 6)
    expect(loudCam.warp, 'and must NOT touch the screen warp')
      .toBeCloseTo(base.warp, 12)
    // The case the whole split exists for: calming the camera completely must
    // leave the tunnel vision entirely intact.
    expect(quietCam.dolly, 'camera dial at 0 means the camera does not move').toBe(0)
    expect(quietCam.warp, 'camera dial at 0 must NOT remove the tunnel')
      .toBeCloseTo(base.warp, 12)
  })

  it('the tunnel dial grades the screen and leaves the camera alone', () => {
    const fire = (set: Partial<CameraSettings>): { dolly: number; warp: number } => {
      const cam = new ChaseCamera(16 / 9)
      cam.applySettings(set)
      const r = fake(60)
      cam.reset(r)
      cam.update(r, RDT, 60, false, false)
      r.boostMag = T.boost.padMag
      r.boostSource = 'pad'
      cam.update(r, RDT, 60, false, false)
      return { dolly: cam.dollyLevel, warp: cam.warpLevel }
    }
    // Kept under the clamp on both sides so the ratio is measurable at all.
    const base = fire({ boost: 1, tunnel: 0.4 })
    const loud = fire({ boost: 1, tunnel: 0.8 })
    const off = fire({ boost: 1, tunnel: 0 })

    expect(loud.warp, 'the tunnel dial must grade the screen')
      .toBeCloseTo(base.warp * 2, 6)
    expect(loud.dolly, 'and must NOT move the camera').toBeCloseTo(base.dolly, 12)
    expect(off.warp, 'tunnel at 0 means no warp at all').toBe(0)
    expect(off.dolly, 'tunnel at 0 must NOT calm the camera')
      .toBeCloseTo(base.dolly, 12)
  })

  it('reduced motion still zeroes BOTH halves, not just the one it knew about', () => {
    const cam = new ChaseCamera(16 / 9)
    const r = fake(60)
    cam.reset(r)
    cam.update(r, RDT, 60, false, true)
    r.boostMag = T.boost.padMag
    r.boostSource = 'pad'
    cam.update(r, RDT, 60, false, true)
    expect(cam.dollyLevel).toBe(0)
    // The new channel is the one a reduced-motion suppression is easiest to
    // forget, because it was added after the suppression was written.
    expect(cam.warpLevel).toBe(0)
  })

  it('the shake dial scales the knock, and 0 switches it off', () => {
    const peak = (dial: number): number => {
      const cam = new ChaseCamera(16 / 9)
      cam.applySettings({ shake: dial })
      const r = fake(40)
      cam.reset(r)
      cam.addShake(0.8)
      const before = cam.camera.position.clone()
      cam.update(r, RDT, 40, false, false)
      return cam.camera.position.distanceTo(before)
    }
    expect(peak(0), 'shake off means the camera does not move for a hit').toBeLessThan(1e-9)
    expect(peak(2)).toBeGreaterThan(peak(1))
  })

  it('a bigger distance really does put the camera further back', () => {
    const at = (d: number): number => {
      const cam = new ChaseCamera(16 / 9)
      cam.applySettings({ distance: d })
      const r = fake(0)
      cam.reset(r)
      return Math.hypot(
        cam.camera.position.x - r.pos.x,
        cam.camera.position.z - r.pos.z,
      )
    }
    expect(at(7)).toBeCloseTo(7, 4)
    expect(at(10.5)).toBeCloseTo(10.5, 4)
    expect(at(16)).toBeCloseTo(16, 4)
  })
})

describe('the car holds its mark at every setting', () => {
  /**
   * THE REGRESSION THIS EXISTS FOR.
   *
   * The screen anchor seeds its solve from `this.look`, which is heavily
   * damped. At the loose end of the tracking dial that seed can lag far enough
   * behind a long corner that the first aim points AWAY from the car -- the
   * car then projects behind the camera, and the original code broke out of
   * the solve and left the aim at that lagged value. Measured on a 120m corner
   * at 60 m/s: the rig position was a healthy 12 degrees off dead astern while
   * the LENS was 165 degrees out. A camera pointing backwards.
   *
   * It was unreachable before the tracking dial existed, which is why the
   * original code called it unreachable. Adding a control that reaches it is
   * exactly the kind of change that turns a documented impossibility into a
   * shipped bug, so every stop on the dial is driven round a real corner here.
   */
  const corner = (set: Partial<CameraSettings>): { worst: number; offMark: number } => {
    const cam = new ChaseCamera(16 / 9)
    cam.applySettings(set)
    const R = 120, V = 60
    const frame = (t: number): RacerState => {
      const a = V * t / R
      return {
        pos: { x: Math.cos(a) * R, y: 0, z: Math.sin(a) * R },
        vel: { x: -Math.sin(a) * V, y: 0, z: Math.cos(a) * V },
        fwd: { x: -Math.sin(a), y: 0, z: Math.cos(a) },
        up: { x: 0, y: 1, z: 0 },
        yaw: Math.atan2(-Math.sin(a), Math.cos(a)),
        yawRate: -V / R, driftSide: 0, driftInward: 1, boostMag: 0,
        boostSource: 'none',
      } as unknown as RacerState
    }
    cam.reset(frame(0))
    let worst = 0, offMark = 0
    const want = { x: C.anchorX * 2 - 1, y: 1 - angleToAnchorY(
      set.angle ?? DEFAULT_CAMERA_SETTINGS.angle,
    ) * 2 }
    for (let i = 1; i < 60 * 8; i++) {
      const f = frame(i * RDT)
      cam.update(f, RDT, 76, false, false)
      if (i < 60) continue
      cam.camera.updateMatrixWorld(true)
      // Where the car actually lands, in NDC.
      const v = new THREE.Vector3(f.pos.x, f.pos.y, f.pos.z).project(cam.camera)
      offMark = Math.max(offMark, Math.hypot(v.x - want.x, v.y - want.y))
      // And is it even in front of the lens?
      worst = Math.max(worst, v.z > 1 ? 1 : 0)
    }
    return { worst, offMark }
  }

  /**
   * THE CONTRACT CHANGED, ON PURPOSE, AND IT IS STILL A CONTRACT.
   *
   * It used to be "the car is welded to its mark at every setting". That made
   * the tracking dial unfeelable: the anchor rotated the camera by exactly as
   * much as the rig had swung, cancelling the whole visible signature of the
   * trail, so 15 degrees of rig movement changed the picture by under 5px.
   *
   * It is now: welded at or below the authored tracking point, and above it
   * free to float inside a BOUNDED buffer that the dial sets. The guarantee
   * that mattered -- a loop or a jump can never put the car somewhere
   * unplayable -- survives, because the bound is a few percent of the frame
   * and the anchor still catches everything past it.
   */
  for (const tracking of [0, 0.15, 0.30]) {
    it(`tracking ${tracking}: at or below the authored point, the car is welded`, () => {
      const { worst, offMark } = corner({ tracking })
      expect(worst, 'the car must never end up behind the camera').toBe(0)
      // Half a percent of frame height -- about 4px on a 944-high frame --
      // which is what the four-pass solve delivers. Before the lever-arm fix
      // this was 0.071 at tracking 0.5, and before the re-seed fix the loose
      // settings put the car off-screen entirely.
      expect(offMark, `car ${offMark.toFixed(4)} off its mark in NDC`).toBeLessThan(0.005)
    })
  }

  for (const tracking of [0.5, 0.75, 1]) {
    it(`tracking ${tracking}: the car floats, but never past the buffer`, () => {
      const cam = new ChaseCamera(16 / 9)
      cam.applySettings({ tracking })
      const slack = (cam as unknown as { rig: Record<string, number> }).rig.anchorSlack
      const { worst, offMark } = corner({ tracking })
      expect(worst, 'the car must never end up behind the camera').toBe(0)
      // It MOVES -- that is the whole point of the dial, and the thing that
      // was missing.
      expect(offMark, 'a buffered setting must actually let the car drift')
        .toBeGreaterThan(0.01)
      // ...and it is bounded by the buffer plus the solver's own residual.
      expect(
        offMark,
        `car ${offMark.toFixed(4)} off its mark against a ${slack.toFixed(3)} buffer`,
      ).toBeLessThan(slack + 0.005)
    })
  }

  it('the buffer is monotonic: more tracking, more float', () => {
    const at = (t: number): number => corner({ tracking: t }).offMark
    const a = at(0.3), b = at(0.6), c = at(1)
    expect(b).toBeGreaterThan(a)
    expect(c).toBeGreaterThan(b)
  })

  // Angle and distance are tested with the buffer CLOSED, so that what is
  // being measured is the solve itself rather than the slack the tracking dial
  // deliberately introduces. The buffer is covered by its own cases above.
  for (const angle of [CAMERA_LIMITS.angle[0], 14, 24, CAMERA_LIMITS.angle[1]]) {
    it(`angle ${angle} deg: the mark moves, and the car goes to it`, () => {
      const { worst, offMark } = corner({ angle, tracking: 0.30 })
      expect(worst).toBe(0)
      expect(offMark, `car ${offMark.toFixed(4)} off its mark in NDC`).toBeLessThan(0.005)
    })
  }

  for (const distance of [CAMERA_LIMITS.distance[0], CAMERA_LIMITS.distance[1]]) {
    it(`distance ${distance}m: the car still lands on its mark`, () => {
      const { worst, offMark } = corner({ distance, tracking: 0.30 })
      expect(worst).toBe(0)
      expect(offMark, `car ${offMark.toFixed(4)} off its mark in NDC`).toBeLessThan(0.005)
    })
  }
})
