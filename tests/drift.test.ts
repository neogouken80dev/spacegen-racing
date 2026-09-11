import { describe, it, expect } from 'vitest'
import { Race } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { TEST_PLAIN } from './fixtures/testTrack'
import { resetAI } from '../src/sim/ai'
import { emptyInput } from '../src/sim/types'
import { TUNING as T } from '../src/content/tuning'
import { CHASSIS, getDerived, getLocomotion } from '../src/content/chassis'
import type { SimConfig, InputFrame } from '../src/sim/types'

const cfg = (chassisId = 'solaire'): SimConfig => ({
  seed: 5, totalLaps: 3, racerCount: 1, trackId: 'test-plain',
  chassisIds: [chassisId], pilotIds: [''],
  localRacerIndex: 0, aiSkill: [0],
})

interface Sample {
  tier: number
  charge: number
  boostTime: number
  boostMag: number
  /** Heading, radians. */
  yaw: number
  yawRate: number
  /** Direction of TRAVEL, radians. Not the same thing as `yaw` in a slide. */
  velYaw: number
  speed: number
  x: number
  z: number
  side: number
  inward: number
}

/** Drive with a fixed input for `seconds`, returning the racer afterwards. */
function drive(
  steps: { seconds: number; input: Partial<InputFrame> }[],
  chassisId = 'solaire',
) {
  resetAI()
  const race = new Race(new Track(TEST_PLAIN), cfg(chassisId))
  const r = race.state.racers[0]
  while (race.state.phase === 'countdown') race.step()

  // Warm up to a drift-capable speed on the open plain.
  const warm = emptyInput(); warm.throttle = 1
  for (let f = 0; f < 900; f++) {
    race.setInput(0, warm)
    race.step()
    if (r.grounded && Math.hypot(r.vel.x, r.vel.z) > 45) break
  }

  const log: Sample[] = []
  for (const step of steps) {
    const input = { ...emptyInput(), throttle: 1, ...step.input }
    for (let f = 0; f < Math.round(step.seconds * 60); f++) {
      race.setInput(0, input)
      race.step()
      log.push({
        tier: r.driftTier, charge: r.driftCharge, boostTime: r.boostTime, boostMag: r.boostMag,
        yaw: r.yaw, yawRate: r.yawRate, velYaw: Math.atan2(r.vel.x, r.vel.z),
        speed: Math.hypot(r.vel.x, r.vel.z), x: r.pos.x, z: r.pos.z,
        side: r.driftSide, inward: r.driftInward,
      })
    }
  }
  return { r, race, log }
}

/** Shortest signed difference between two headings. */
function delta(a: number, b: number): number {
  let d = b - a
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return d
}

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length)
const tail = (l: Sample[], frames = 30) => l.slice(-frames)

/**
 * Mean |yaw rate| once the response has settled. Comparing instantaneous yaw
 * rate would measure the steering half-life, not the model.
 */
const sustainedYaw = (l: Sample[]) => mean(tail(l).map((s) => Math.abs(s.yawRate)))

/**
 * Radius of the path the car is actually travelling: speed over the turn rate
 * of the VELOCITY vector. This, not the yaw rate, is what "turns sharper"
 * means to a driver -- a car can rotate fast and still run wide.
 */
function pathRadius(l: Sample[]): number {
  const t = tail(l)
  let rate = 0
  for (let i = 1; i < t.length; i++) rate += Math.abs(delta(t[i - 1].velYaw, t[i].velYaw)) / T.sim.dt
  return mean(t.map((s) => s.speed)) / Math.max(1e-6, rate / (t.length - 1))
}

/** Angle between where the car POINTS and where it is GOING, in degrees. */
const crabDeg = (s: Sample) => Math.abs(delta(s.yaw, s.velYaw)) * 180 / Math.PI

/** The drift arc the tuning asks for at full lock, before speed falloff. */
function fullLockArc(chassisId: string): number {
  return (T.drift.arcBase + T.drift.arcPerYaw * getDerived(chassisId).maxYawRate)
    * getLocomotion(chassisId).driftArcMult
}

describe('drift: counter-steering controls the slide', () => {
  it('does not exit the drift when the player counter-steers hard', () => {
    // Enter a right drift, then hold full opposite lock. In the old model this
    // ended the drift; it must now just run the slide wide.
    const { r } = drive([
      { seconds: 0.5, input: { steer: 1, drift: true } },
      { seconds: 1.2, input: { steer: -1, drift: true } },
    ])
    expect(r.driftSide).toBe(1)
    expect(r.driftCharge).toBeGreaterThan(1.0)
  })

  it('full lock carves tighter than full counter-steer', () => {
    const tight = drive([{ seconds: 1.4, input: { steer: 1, drift: true } }])
    const wide = drive([
      { seconds: 0.25, input: { steer: 1, drift: true } },
      { seconds: 1.15, input: { steer: -1, drift: true } },
    ])
    const tightYaw = Math.abs(tight.r.yawRate)
    const wideYaw = Math.abs(wide.r.yawRate)
    expect(tightYaw).toBeGreaterThan(wideYaw * 1.6)
  })

  it('still charges while counter-steering, just more slowly', () => {
    const tight = drive([{ seconds: 1.5, input: { steer: 1, drift: true } }])
    const wide = drive([
      { seconds: 0.25, input: { steer: 1, drift: true } },
      { seconds: 1.25, input: { steer: -1, drift: true } },
    ])
    expect(wide.r.driftCharge).toBeGreaterThan(0.6)
    expect(wide.r.driftCharge).toBeLessThan(tight.r.driftCharge)
  })

  it('only releasing the drift button fires the boost', () => {
    const { r } = drive([
      { seconds: 1.8, input: { steer: 1, drift: true } },
      { seconds: 0.1, input: { steer: 0, drift: false } },
    ])
    expect(r.driftSide).toBe(0)
    expect(r.boostTime).toBeGreaterThan(0)
    expect(r.boostMag).toBeGreaterThan(0)
  })
})

describe('drift: boost scales with how long it was held', () => {
  it('reaches progressively higher tiers the longer it is held', () => {
    const seen: number[] = []
    for (const hold of [0.8, 1.7, 2.8, 4.4]) {
      const { r } = drive([
        { seconds: hold, input: { steer: 1, drift: true } },
        { seconds: 0.05, input: { steer: 0, drift: false } },
      ])
      seen.push(r.boostMag)
    }
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1])
    expect(seen[0]).toBeCloseTo(T.drift.tierBoost[0], 2)
    expect(seen[3]).toBeCloseTo(T.drift.tierBoost[3], 2)
  })

  it('gives a longer boost for a longer drift, even inside the same tier', () => {
    // Both of these land in tier 1; the longer hold must still pay more.
    const short = drive([
      { seconds: 1.6, input: { steer: 1, drift: true } },
      { seconds: 0.05, input: { steer: 0, drift: false } },
    ])
    const long = drive([
      { seconds: 2.4, input: { steer: 1, drift: true } },
      { seconds: 0.05, input: { steer: 0, drift: false } },
    ])
    expect(short.r.boostMag).toBeCloseTo(long.r.boostMag, 2)
    expect(long.r.boostTime).toBeGreaterThan(short.r.boostTime + 0.15)
  })

  it('caps the proportional bonus so a marathon drift is not infinite boost', () => {
    const { r } = drive([
      { seconds: 9, input: { steer: 1, drift: true } },
      { seconds: 0.05, input: { steer: 0, drift: false } },
    ])
    const maxDuration = T.drift.tierDuration[3] + T.drift.durationBonusCap
    expect(r.boostTime).toBeLessThanOrEqual(maxDuration + 0.02)
  })
})

// ---------------------------------------------------------------------------
// The five properties a Mario-Kart drift has to have. These are measurements
// on the open plain in tests/fixtures/testTrack.ts, so they test the driving
// model rather than Rustfall's geometry.
// ---------------------------------------------------------------------------

describe('drift property 1: a drift turns SHARPER than plain steering', () => {
  // The original bug: arcTight was a single flat 1.42 rad/s while the roster's
  // maxYawRate runs 1.59-2.37, so drifting actively turned WORSE than steering.
  // A flat 2.95 fixed it for the low-handling half of the roster only --
  // Filament still gained just 1.18x. The arc is built from the chassis's own
  // yaw authority now, so the guarantee holds for all five.
  for (const c of CHASSIS) {
    it(`${c.id}: full lock out-turns full steering lock`, () => {
      const steer = drive([{ seconds: 2.0, input: { steer: 1 } }], c.id)
      const drift = drive([{ seconds: 2.0, input: { steer: 1, drift: true } }], c.id)

      const steerYaw = sustainedYaw(steer.log)
      const driftYaw = sustainedYaw(drift.log)
      expect(driftYaw).toBeGreaterThan(steerYaw * 1.35)

      // And it must turn sharper in the way a driver would notice: a tighter
      // circle, not just a faster-spinning body.
      expect(pathRadius(drift.log)).toBeLessThan(pathRadius(steer.log) * 0.75)

      // The slide is a real slide, not a fast corner: the car points well away
      // from where it is going.
      //
      // THE STEERING BASELINE USED TO BE ASSERTED AT UNDER 6 DEGREES, AND IS
      // NOW 3-11. That is the friction-budget pass and not a regression: full
      // steering lock at ~50 m/s demands 37-56 m/s^2 of lateral acceleration
      // against a dry-tarmac budget of 34-39, so a car held at full lock is now
      // AT its limit and genuinely slipping. It is understeer -- the front has
      // run out and the nose is only partly answering -- and it is the whole
      // point of the change. What has to stay true is the SEPARATION: a drift
      // is a commanded slide two to three times the size of anything plain
      // steering produces, and it is still what "sideways" means here.
      const steerCrab = mean(tail(steer.log).map(crabDeg))
      const driftCrab = mean(tail(drift.log).map(crabDeg))
      expect(driftCrab).toBeGreaterThan(20)
      expect(steerCrab, `plain steering slipped ${steerCrab.toFixed(1)} deg`).toBeLessThan(14)
      expect(driftCrab).toBeGreaterThan(steerCrab * 2)
    })
  }
})

describe('drift property 2: counter-steering opens the line outward', () => {
  for (const c of CHASSIS) {
    it(`${c.id}: full counter-steer runs wider, and never drops the drift`, () => {
      const entry: { seconds: number; input: Partial<InputFrame> }[] =
        [{ seconds: 0.4, input: { steer: 1, drift: true } }]
      const lock = drive([...entry, { seconds: 1.6, input: { steer: 1, drift: true } }], c.id)
      const wide = drive([...entry, { seconds: 1.6, input: { steer: -1, drift: true } }], c.id)

      // Displacement toward the corner, measured in the frame the car was in
      // when the two runs diverged. Right drift, so +lateral is INTO the corner.
      const i0 = Math.round(0.4 * 60) - 1
      const y0 = lock.log[i0].yaw
      const rx = -Math.cos(y0), rz = Math.sin(y0)
      const into = (l: Sample[]) =>
        (l[l.length - 1].x - l[i0].x) * rx + (l[l.length - 1].z - l[i0].z) * rz

      expect(into(lock.log) - into(wide.log)).toBeGreaterThan(60)

      // The counter-steered car must turn OUTWARD, not merely turn in more
      // slowly. arcCounter used to be -0.085, which put the counter-steered arc
      // within a whisker of dead straight -- the old form of this assertion
      // ("radius at least 3x the lock radius") was really measuring that
      // near-straightness, and it fails once counter-steer is strong enough to
      // trace a real outward curve. What matters is the SIGN: a right drift
      // (driftSide 1, STEER_SIGN -1) turns the nose down in yaw, so a positive
      // sustained yaw rate under counter-steer means the nose is swinging away
      // from the corner and dragging the line out with it.
      const counterYaw = mean(tail(wide.log, 30).map((s) => s.yawRate))
      const lockYaw = mean(tail(lock.log, 30).map((s) => s.yawRate))
      expect(lockYaw).toBeLessThan(0)
      expect(counterYaw).toBeGreaterThan(0)
      // Real authority: at least a third of the drift's own rotation rate, the
      // other way. And never MORE than it, or flicking the stick becomes a
      // faster way round a corner than committing to the slide.
      expect(counterYaw / -lockYaw).toBeGreaterThan(0.33)
      expect(counterYaw / -lockYaw).toBeLessThan(1)

      // Counter-steering CONTROLS the slide; it must never end it.
      expect(wide.r.driftSide).toBe(1)
      for (let i = i0; i < wide.log.length; i++) expect(wide.log[i].side).toBe(1)
      // ...and the car is still visibly sideways while it happens.
      expect(mean(tail(wide.log).map(crabDeg))).toBeGreaterThan(8)
    })
  }
})

describe('drift property 3: release fires along the nose', () => {
  for (const c of CHASSIS) {
    it(`${c.id}: the boost leaves along the heading, at no cost in speed`, () => {
      const { log } = drive([
        { seconds: 2.0, input: { steer: 1, drift: true } },
        { seconds: 0.25, input: { steer: 0, drift: false } },
      ], c.id)
      const iRel = Math.round(2.0 * 60) - 1
      const before = log[iRel]
      const after = log[iRel + 1]

      // Sliding hard right up to the moment of release...
      expect(crabDeg(before)).toBeGreaterThan(20)
      // ...and pointed where it is going one frame later. releaseAlign used to
      // rotate r.vel inside the state machine, which the lateral block then
      // rebuilt from the stale forward/lateral pair -- 17.6 degrees of crab
      // survived the redirect and the constant was dead config.
      expect(crabDeg(after)).toBeLessThan(8)
      expect(crabDeg(log[log.length - 1])).toBeLessThan(4)

      // The redirect turns the momentum and adds EXACTLY the tier's launch
      // kick -- no more. The kick is deliberate (a sustained boost alone makes
      // the moment of release feel like nothing happened, because it only
      // raises the ceiling); inventing anything beyond it would be the drift
      // manufacturing speed again, which this model has done twice before.
      const tier = Math.min(before.tier, T.drift.releaseKick.length - 1)
      const kick = tier >= 0 ? T.drift.releaseKick[tier] : 0
      expect(tier, 'the rig must actually bank a tier').toBeGreaterThanOrEqual(0)
      const gained = after.speed - before.speed
      expect(gained, `gained ${gained.toFixed(2)} m/s against a tier-${tier} kick of ${kick}`)
        .toBeGreaterThan(kick - 0.6)
      expect(gained).toBeLessThan(kick + 0.6)
      expect(after.boostMag).toBeGreaterThan(0)
    })
  }
})

describe('drift property 4: the car does not spin', () => {
  for (const c of CHASSIS) {
    it(`${c.id}: five seconds at full lock stays a drift, not a spin-out`, () => {
      const { r, log } = drive([{ seconds: 5.0, input: { steer: 1, drift: true } }], c.id)

      let rot = 0
      for (let i = 1; i < log.length; i++) rot += Math.abs(delta(log[i - 1].yaw, log[i].yaw))
      // A five-second donut is fine; four rotations in five seconds is not.
      expect(rot).toBeLessThan(Math.PI * 2 * 4)

      // The yaw rate can never exceed the arc the tuning asked for, whatever
      // the speed -- the falloff only ever scales it down.
      const peak = Math.max(...log.map((s) => Math.abs(s.yawRate)))
      expect(peak).toBeLessThanOrEqual(fullLockArc(c.id) * 1.02)

      // And it is still a racing car at the end of it.
      expect(log[log.length - 1].speed).toBeGreaterThan(getDerived(c.id).topSpeed * 0.6)
      for (const s of log) {
        expect(Number.isFinite(s.speed)).toBe(true)
        expect(Number.isFinite(s.yaw)).toBe(true)
      }
      expect(Number.isFinite(r.pos.x) && Number.isFinite(r.pos.y) && Number.isFinite(r.pos.z)).toBe(true)
    })
  }
})

describe('drift property 5: controllable across the whole roster', () => {
  for (const c of CHASSIS) {
    it(`${c.id}: holds a three-second drift and banks at least Tier 2`, () => {
      const { r, log } = drive([{ seconds: 3.0, input: { steer: 1, drift: true } }], c.id)
      expect(r.driftSide).toBe(1)
      expect(r.driftTier).toBeGreaterThanOrEqual(2)

      // No runaway: the yaw rate settles instead of climbing all the way.
      const early = mean(log.slice(60, 90).map((s) => Math.abs(s.yawRate)))
      const late = mean(tail(log).map((s) => Math.abs(s.yawRate)))
      expect(late).toBeLessThan(early * 1.25)
    })
  }
})

describe('drift: the stick is a continuous control, not a switch', () => {
  it('the stick sweeps the ARC continuously and leaves the slide angle alone', () => {
    const arcs: number[] = []
    const crabs: number[] = []
    for (const steer of [-1, -0.5, 0, 0.5, 1]) {
      const { log } = drive([
        { seconds: 0.4, input: { steer: 1, drift: true } },
        { seconds: 1.6, input: { steer, drift: true } },
      ])
      arcs.push(mean(tail(log).map((s) => -s.yawRate)))   // right drift: yaw falls
      crabs.push(mean(tail(log).map(crabDeg)))
    }
    // The arc is what the stick controls, and it does so continuously.
    for (let i = 1; i < arcs.length; i++) {
      expect(arcs[i]).toBeGreaterThan(arcs[i - 1])
    }
    // Full counter-steer rotates the nose AWAY from the corner, which is what
    // actually moves the car outward rather than merely turning in less.
    expect(arcs[0]).toBeLessThan(0)

    // THE SLIDE ANGLE IS NOT ON THE STICK. It used to run from slideWide to
    // slideTight, so full counter-steer stood the car up from 32 degrees to 10
    // and the car read as bogging down mid-corner even though ground speed was
    // identical. Counter-steering steers the car out; it does not end the
    // slide, and it does not shrink it either.
    for (const c of crabs) {
      expect(Math.tan(c * Math.PI / 180)).toBeCloseTo(T.drift.slideTight, 2)
    }
  })
})

describe('drift: the entry frame commits to the stick it was given', () => {
  // The entry frame snaps the YAW RATE straight to its target (T.drift.
  // entrySnap), so whatever `driftInward` is seeded with on that frame IS the
  // bite the player feels. Seeding it at full lock regardless of the stick made
  // every partial-stick entry flick to full lock for one frame and then fall
  // back: measured 2.48x the sustained yaw rate at the 0.25 stick that just
  // clears the entry threshold. Keyboard steering ramps 0 -> 1 over 0.12s and
  // the pad is analog, so a partial-stick entry is the normal case.
  it('enters at the commanded lock, not at full lock', () => {
    const half = drive([{ seconds: 0.2, input: { steer: 0.5, drift: true } }])
    const full = drive([{ seconds: 0.2, input: { steer: 1.0, drift: true } }])
    expect(Math.abs(half.log[0].yawRate)).toBeLessThan(Math.abs(full.log[0].yawRate) * 0.95)
  })

  it('settles at the half-stick slide angle without ever overshooting it', () => {
    // The slide angle is no longer snapped -- see the kick-out suite below --
    // so it BUILDS. What must still hold is that it builds toward the angle the
    // stick asked for and never past it: an overshoot here is the full-lock
    // flick coming back.
    const { log } = drive([{ seconds: 1.2, input: { steer: 0.5, drift: true } }])
    const settled = mean(tail(log).map(crabDeg))
    const peak = Math.max(...log.map(crabDeg))
    expect(peak / settled).toBeLessThan(1.05)
    // And it does get there, rather than stalling short.
    expect(mean(tail(log, 10).map(crabDeg)) / settled).toBeGreaterThan(0.95)
  })
})

// ---------------------------------------------------------------------------
// Zero kick-out. The slide angle and the yaw rate are the same motion seen from
// two frames: if the nose rotates by dPsi and the car keeps travelling exactly
// where it was, the slide angle grows by exactly dPsi. Growing it faster means
// the VELOCITY is being pushed outward, and that push is the kick -- the car
// steps sideways off the line at the moment of the button press. Capping the
// rise at |yawRate| (T.drift.slideYawLinked) makes drift entry strictly a
// rotation of the car about its own travel direction.
// ---------------------------------------------------------------------------

describe('drift: entry rotates the car, it never throws it sideways', () => {
  for (const c of CHASSIS) {
    it(`${c.id}: the travel direction never swings away from the corner`, () => {
      const { log } = drive([{ seconds: 1.5, input: { steer: 1, drift: true } }], c.id)
      // Right drift: STEER_SIGN is -1, so the yaw DEcreases and the direction of
      // travel must follow it down. Any frame where the travel direction steps
      // the other way is the car being kicked outward.
      let worstOutward = 0
      for (let i = 1; i < log.length; i++) {
        worstOutward = Math.max(worstOutward, delta(log[i - 1].velYaw, log[i].velYaw))
      }
      expect(
        worstOutward * 180 / Math.PI,
        `travel direction swung ${(worstOutward * 180 / Math.PI).toFixed(3)} deg outward`,
      ).toBeLessThan(0.02)
    })
  }

  it('the slide angle opens no faster than the nose is turning', () => {
    // The invariant stated directly, frame by frame, rather than through its
    // consequence. Snapping the crab to 32 degrees in one frame -- which is what
    // shipped before -- violates this on frame 1 by an order of magnitude.
    const { log } = drive([{ seconds: 1.5, input: { steer: 1, drift: true } }])
    for (let i = 1; i < log.length; i++) {
      const opened = crabDeg(log[i]) - crabDeg(log[i - 1])
      const noseTurn = Math.abs(log[i].yawRate) * T.sim.dt * 180 / Math.PI
      expect(opened, `frame ${i}: slide opened ${opened.toFixed(3)} deg vs nose ${noseTurn.toFixed(3)}`)
        .toBeLessThan(noseTurn + 0.02)
    }
  })

  it('still reaches the full slide angle, just by rotating into it', () => {
    const { log } = drive([{ seconds: 1.5, input: { steer: 1, drift: true } }])
    expect(mean(tail(log).map(crabDeg))).toBeGreaterThan(28)
    // The nose bites on frame 1 even though the angle has not developed yet --
    // that is the difference between this and the lag that was fixed earlier.
    const settledYaw = sustainedYaw(log)
    expect(Math.abs(log[0].yawRate)).toBeGreaterThan(settledYaw)
  })
})

// ---------------------------------------------------------------------------
// The arc eases off as the slide is held. A constant yaw rate is a
// constant-radius spiral: an arc that never eases keeps winding tighter
// relative to the road until the car is aimed at the inside barrier.
// ---------------------------------------------------------------------------

describe('drift: a held slide eases off instead of winding tighter', () => {
  for (const c of CHASSIS) {
    it(`${c.id}: the arc decays toward arcSustain and then holds`, () => {
      const { log } = drive([{ seconds: 3.0, input: { steer: 1, drift: true } }], c.id)
      const at = (t: number) => Math.abs(log[Math.round(t * 60)].yawRate)
      const bite = at(0.02)
      expect(at(2.0)).toBeLessThan(bite * 0.85)   // it really does ease
      expect(at(2.0)).toBeGreaterThan(bite * 0.65) // but not into nothing
      // Monotone: no second wind, no oscillation.
      expect(at(1.0)).toBeLessThan(at(0.3))
      expect(at(2.5)).toBeLessThan(at(1.0) + 1e-6)
    })
  }

  it('counter-steer authority is NOT eased away with it', () => {
    // The moment the drift starts backing off is exactly when a player wants to
    // open the line, so only the inward half of the stick decays.
    const EARLY = 0.35, LATE = 2.5
    const early = drive([
      { seconds: EARLY, input: { steer: 1, drift: true } },
      { seconds: 0.5, input: { steer: -1, drift: true } },
    ])
    const late = drive([
      { seconds: LATE, input: { steer: 1, drift: true } },
      { seconds: 0.5, input: { steer: -1, drift: true } },
    ])
    // Compare counter-steer to the LOCK arc in the same run, not to the other
    // run: three seconds of sliding sheds speed, and speedYawFalloff would drag
    // the raw number down by about 10% for reasons that have nothing to do with
    // the ease. If counter-steer were decaying too, this ratio would be flat;
    // because only the inward half eases, it grows.
    const counterYaw = (l: Sample[]) => mean(tail(l, 15).map((s) => s.yawRate))
    const lockYaw = (l: Sample[], atFrame: number) =>
      Math.abs(mean(l.slice(Math.max(0, atFrame - 10), atFrame).map((s) => s.yawRate)))
    const earlyRatio = counterYaw(early.log) / lockYaw(early.log, Math.round(EARLY * 60))
    const lateRatio = counterYaw(late.log) / lockYaw(late.log, Math.round(LATE * 60))
    expect(lateRatio).toBeGreaterThan(earlyRatio)
  })
})
