import { describe, it, expect } from 'vitest'
import { ChaseCamera } from '../src/game/camera'
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
  chassisIds: [chassisId], pilotIds: ['pip'],
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
    expect(fired, 'a pad boost must fire the shot').toBeGreaterThan(0.4)

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
    expect(cam.dollyLevel, 'after the cooldown it fires again').toBeGreaterThan(0.4)
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
    expect(s.maxPullIn, `max pull-in ${s.maxPullIn.toFixed(2)}m`).toBeGreaterThan(1.5)
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
