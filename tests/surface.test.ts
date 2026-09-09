import { describe, it, expect, afterEach } from 'vitest'
import { Track, SURFACE_GRIP, type TrackDef, type SurfaceKind } from '../src/sim/track'
import { CRYOSTATIC } from '../src/content/tracks'
import { stepVehicle, lateralBudget, cornerSpeedAt, type VehicleContext } from '../src/sim/vehicle'
import { stepAI, resetAI } from '../src/sim/ai'
import { Race } from '../src/sim/race'
import { Rng } from '../src/sim/rng'
import { TUNING as T } from '../src/content/tuning'
import { CHASSIS, getDerived, getLocomotion } from '../src/content/chassis'
import { clamp, angleDelta } from '../src/sim/math'
import type { RacerState, InputFrame, SimConfig } from '../src/sim/types'

/**
 * WHERE SURFACE GRIP IS PRICED.
 *
 * THIS FILE USED TO ASSERT THE OPPOSITE. Until the friction-budget pass,
 * TUNING.surfaceGrip read like a physics constant and was not one: stepVehicle
 * measured the velocity in the PRE-rotation basis and rebuilt it in the
 * POST-rotation one, so the nose dragged the whole momentum round with it and
 * `grip` only decayed a lateral residue that steady cornering never generated.
 * The measurement this file existed to pin was that a Solaire driven flat
 * through Cryostatic's ice sweeper at ice grip 1.00, 0.45 and 0.15 traced the
 * SAME line to under a millimetre, in the same 8.63s, with 0.00 degrees of
 * slip -- and that the only thing that made ice cost anything was the AI's
 * corner-speed model, gated on T.ai.surfaceCaution.
 *
 * The old file said, in as many words: "If someone gives grip real physical
 * teeth -- a lateral acceleration budget, a surface term on the drift crab, a
 * grip term on braking -- test (1) fails, and that failure is the signal to
 * re-calibrate T.ai.surfaceCaution rather than to relax the assertion." That is
 * what happened. What is asserted here now is the other side of it:
 *
 *   1. the physics is NOT indifferent to the surface -- the line, the slip
 *      angle and the time through the sweeper all move with SURFACE_GRIP;
 *   2. cornering is bounded by lateralBudget(), for every chassis on every
 *      surface, which is what makes ice a limit rather than a mood;
 *   3. a slide is CATCHABLE -- opposite lock keeps full authority at any slip
 *      angle and pulls the car back;
 *   4. the AI's cornerLimit is that same budget, so T.ai.surfaceCaution is now
 *      a belief about a real number rather than the only thing holding ice up.
 */

const DT = T.sim.dt
const ICE_GRIP = SURFACE_GRIP.ice
const SNOW_GRIP = SURFACE_GRIP.snow

afterEach(() => {
  SURFACE_GRIP.ice = ICE_GRIP
  SURFACE_GRIP.snow = SNOW_GRIP
  ;(T.ai as { surfaceCaution: number }).surfaceCaution = 1.0
})

function spawn(track: Track, chassisId: string, s: number, speed: number): RacerState {
  const loco = getLocomotion(chassisId)
  const smp = track.at(s)
  const p = track.surfacePoint(s, 0)
  const yaw = track.yawAt(s)
  return {
    id: 0, chassisId, pilotId: 'pip', isAI: false, isLocal: false, aiSkill: 4,
    pos: { x: p.x, y: p.y + smp.normal.y * loco.rideHeight, z: p.z },
    vel: { x: Math.sin(yaw) * speed, y: 0, z: Math.cos(yaw) * speed },
    yaw, yawRate: 0, altitude: loco.rideHeight, vertVel: 0, grounded: true, wallTime: 0, windPush: 0,
    fwd: { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) }, up: { x: 0, y: 1, z: 0 },
    driftSide: 0, driftCharge: 0, driftTier: -1, driftInward: 1, driftEntry: false, driftTime: 0,
    chainStacks: 0, chainWindow: 0, boostTime: 0, boostMag: 0, boostSource: 'none',
    lift: loco.liftCapacity, liftActive: false, airTime: 0, trickArmed: false,
    rampCooldown: 0, ballisticTime: 0,
    item: null, itemCharges: 0, itemSlot2: null, rouletteTime: 0,
    gatlingTime: 0, gatlingCooldown: 0, beamCharge: 0, beamGrace: 0,
    spinTime: 0, stunTime: 0, immuneTime: 0, invincibleTime: 0,
    slowTime: 0, slowMag: 0, massMult: 1,
    lap: 0, checkpoint: 0, splineS: s, totalS: 0, lateral: 0, position: 1,
    finished: false, finishTime: 0, lapTimes: [], bestLap: 0, charges: 0,
    offTrackTime: 0, respawnTime: 0, respawnPlaced: false, lastHitBy: null, events: [],
  } as RacerState
}

/**
 * Cryostatic's Tier-4 ice sweeper, taken FLAT OUT with no brake at all, on a
 * nose-pursuit line. This is the corner the AI slows for; the sweeper is about
 * 195 m of radius, which a Solaire holds to 84 m/s on snow (i.e. flat out) and
 * only 57 m/s on ice, against a 61.4 m/s top speed.
 */
function flatOutThroughTheSweeper(chassisId: string) {
  const track = new Track(CRYOSTATIC)
  const derived = getDerived(chassisId)
  const r = spawn(track, chassisId, 260, derived.topSpeed)
  const ctx: VehicleContext = { track, raceTime: 0, iceCracked: false }
  const path: number[] = []
  let maxEdge = 0
  let maxSlip = 0
  let minSpeed = Infinity
  let offFrames = 0
  let travelled = 0
  let frames = 0
  while (travelled < 500 && frames < 4000) {
    const speed = Math.hypot(r.vel.x, r.vel.z)
    const look = T.ai.lookaheadBase + speed * T.ai.lookaheadPerSpeed
    const tgt = track.surfacePoint(r.splineS + look, 0)
    const wantYaw = Math.atan2(tgt.x - r.pos.x, tgt.z - r.pos.z)
    const input: InputFrame = {
      steer: clamp(-angleDelta(r.yaw, wantYaw) / Math.max(0.25, derived.maxYawRate * 0.55), -1, 1),
      throttle: 1, brake: 0, drift: false, item: false, itemBack: false, lift: false, lookBack: false,
    }
    const prevS = r.splineS
    stepVehicle(r, input, ctx)
    ctx.raceTime += DT
    let ds = r.splineS - prevS
    if (ds < -track.length / 2) ds += track.length
    if (ds > track.length / 2) ds -= track.length
    travelled += ds
    frames++
    path.push(r.pos.x, r.pos.z)
    const smp = track.at(r.splineS)
    maxEdge = Math.max(maxEdge, Math.abs(r.lateral) / smp.width)
    if (Math.abs(r.lateral) / smp.width > T.offTrack.edgeTolerance) offFrames++
    minSpeed = Math.min(minSpeed, Math.hypot(r.vel.x, r.vel.z))
    maxSlip = Math.max(maxSlip, Math.abs(angleDelta(r.yaw, Math.atan2(r.vel.x, r.vel.z))))
  }
  return { path, maxEdge, maxSlip, minSpeed, offFrames, seconds: frames * DT }
}

describe('surface grip in the physics', () => {
  /**
   * The load-bearing measurement of the whole ice-track balance question, and
   * the one this file used to assert did NOT exist.
   */
  it('changes the line, the slip angle and the time through Cryostatic\'s ice sweeper', () => {
    const runs = [1.0, 0.45, 0.15].map((g) => {
      SURFACE_GRIP.ice = g
      return flatOutThroughTheSweeper('solaire')
    })
    const [dry, authored, glass] = runs

    // The trajectories DIVERGE. They used to agree to under a millimetre across
    // a 6.7x span of grip; a metre is now a low bar for a 200 m corner.
    const worst = (a: number[], b: number[]) => {
      let d = 0
      for (let i = 0; i < Math.min(a.length, b.length); i++) d = Math.max(d, Math.abs(a[i] - b[i]))
      return d
    }
    expect(worst(authored.path, dry.path)).toBeGreaterThan(1)
    expect(worst(glass.path, dry.path)).toBeGreaterThan(worst(authored.path, dry.path))

    // Slip angle, road used and time through all get worse as the surface does,
    // monotonically. On dry grip the car is planted -- under a degree of slip --
    // and on glass it is sliding.
    expect(dry.maxSlip * 180 / Math.PI).toBeLessThan(2)
    expect(authored.maxSlip).toBeGreaterThan(dry.maxSlip * 3)
    expect(glass.maxSlip).toBeGreaterThan(authored.maxSlip)
    expect(authored.maxEdge).toBeGreaterThan(dry.maxEdge)
    expect(glass.maxEdge).toBeGreaterThan(authored.maxEdge)
    expect(authored.seconds).toBeGreaterThan(dry.seconds)
    expect(glass.seconds).toBeGreaterThan(authored.seconds)
    // The slowest point of the corner falls too: scrubbing off slip costs speed.
    expect(authored.minSpeed).toBeLessThan(dry.minSpeed)
  })

  it('costs a grounded chassis road and time on ice, whichever chassis it is', () => {
    for (const id of ['solaire', 'bulwark', 'dray9']) {
      SURFACE_GRIP.ice = 1.0
      const dry = flatOutThroughTheSweeper(id)
      SURFACE_GRIP.ice = 0.15
      const glass = flatOutThroughTheSweeper(id)
      expect(glass.seconds, id).toBeGreaterThan(dry.seconds)
      expect(glass.maxSlip, id).toBeGreaterThan(dry.maxSlip)
      expect(glass.maxEdge, id).toBeGreaterThan(dry.maxEdge)
    }
  })
})

/**
 * A wide constant-radius ring of a single surface, wide enough that a car can
 * slide right off the line without ever touching a barrier.
 */
function ring(surface: SurfaceKind, radius: number, width = 60): TrackDef {
  const N = 48
  return {
    id: `ring-${surface}`, name: `ring-${surface}`,
    skyTop: 0, skyBottom: 0, fogColor: 0, fogDensity: 0,
    sunColor: 0, sunIntensity: 1, ambientColor: 0, ambientIntensity: 1,
    sunDirection: [0, 1, 0], palette: { a: 0, b: 0, c: 0, accent: 0 },
    laps: 3, itemBoxRows: [], chargeRuns: [],
    nodes: Array.from({ length: N }, (_, i) => {
      const a = (i / N) * Math.PI * 2
      return { p: [Math.sin(a) * radius, 0, Math.cos(a) * radius] as [number, number, number], w: width, surface }
    }),
  }
}

/** Hold a fixed stick on a huge flat plain and report the settled state. */
function held(chassisId: string, surface: SurfaceKind, steer: number, throttle: number, seconds: number) {
  const track = new Track(ring(surface, 4000, 900))
  const r = spawn(track, chassisId, 100, getDerived(chassisId).topSpeed)
  const ctx: VehicleContext = { track, raceTime: 0, iceCracked: false }
  const input: InputFrame = {
    steer, throttle, brake: 0, drift: false, item: false, itemBack: false, lift: false, lookBack: false,
  }
  const N = Math.round(seconds * 60)
  let slip = 0, speed = 0, yawRate = 0, peakLatAccel = 0
  let prevVx = r.vel.x, prevVz = r.vel.z
  for (let f = 0; f < N; f++) {
    stepVehicle(r, input, ctx)
    ctx.raceTime += DT
    // Lateral acceleration = the component of dv/dt across the direction of
    // travel. This is the quantity the budget bounds.
    const sp = Math.hypot(r.vel.x, r.vel.z)
    if (sp > 1 && f > 6) {
      const tx = r.vel.x / sp, tz = r.vel.z / sp
      const ax = (r.vel.x - prevVx) / DT, az = (r.vel.z - prevVz) / DT
      peakLatAccel = Math.max(peakLatAccel, Math.abs(ax * -tz + az * tx))
    }
    prevVx = r.vel.x; prevVz = r.vel.z
    if (f >= N - 30) {
      slip += Math.abs(angleDelta(r.yaw, Math.atan2(r.vel.x, r.vel.z))) * 180 / Math.PI
      speed += sp
      yawRate += Math.abs(r.yawRate)
    }
  }
  return { slip: slip / 30, speed: speed / 30, yawRate: yawRate / 30, peakLatAccel }
}

describe('the friction budget bounds what a corner can do', () => {
  it('never turns the velocity harder than lateralBudget, on any chassis or surface', () => {
    for (const c of CHASSIS) {
      const derived = getDerived(c.id)
      const loco = getLocomotion(c.id)
      for (const s of ['tarmac', 'ice'] as SurfaceKind[]) {
        const budget = lateralBudget(derived, loco, SURFACE_GRIP[s])
        const x = held(c.id, s, 1, 1, 5)
        // 8% of headroom for the one-frame transient at the moment the stick
        // goes on, before any slip has developed to scrub.
        expect(
          x.peakLatAccel,
          `${c.id} on ${s}: pulled ${x.peakLatAccel.toFixed(1)} m/s^2 against a budget of ${budget.toFixed(1)}`,
        ).toBeLessThan(budget * 1.08)
        // ...and the settled corner really is at the limit rather than miles
        // inside it, or this assertion would be measuring nothing.
        expect(x.speed * x.yawRate).toBeGreaterThan(budget * 0.55)
      }
    }
  })

  it('is planted below the limit and slides above it', () => {
    // A quarter of a turn of lock at racing speed is nowhere near the budget:
    // the car tracks it with a slip angle a driver would not notice. Full lock
    // is past it, and the car slides.
    const gentle = held('solaire', 'tarmac', 0.25, 1, 4)
    const hard = held('solaire', 'tarmac', 1, 1, 4)
    expect(gentle.slip).toBeLessThan(1.5)
    expect(hard.slip).toBeGreaterThan(6)
    // The same full lock on ice is a much bigger slide, because the budget it
    // is exceeding is 45% of the size.
    const ice = held('solaire', 'ice', 1, 1, 4)
    expect(ice.slip).toBeGreaterThan(hard.slip * 1.6)
  })

  it('lets the throttle choose between understeer and oversteer', () => {
    // Same corner, same lock, same surface, measured over the same window while
    // the two runs are still at comparable speed: off the throttle the front
    // washes wide and the car rotates only as much as the grip allows; on the
    // throttle the drive axle asks for more than the ellipse has left, spins,
    // and the tail brings the nose round FURTHER than the stick asked for.
    //
    // The comparison has to be speed-matched or it measures the wrong thing:
    // the lifted car sheds speed, and T.steering.yawSpeedFalloff hands a slow
    // car more yaw rate for the same stick, which flatters exactly the run that
    // is supposed to be rotating less.
    const corner = new Track(ring('ice', 120, 400))
    const probe = (throttle: number) => {
      const r = spawn(corner, 'solaire', corner.length * 0.25, 26)
      const ctx: VehicleContext = { track: corner, raceTime: 0, iceCracked: false }
      let peakYaw = 0, peakSlip = 0, speed = 0
      for (let f = 0; f < 45; f++) {
        stepVehicle(r, {
          steer: 0.6, throttle, brake: 0, drift: false,
          item: false, itemBack: false, lift: false, lookBack: false,
        }, ctx)
        ctx.raceTime += DT
        peakYaw = Math.max(peakYaw, Math.abs(r.yawRate))
        peakSlip = Math.max(peakSlip, Math.abs(angleDelta(r.yaw, Math.atan2(r.vel.x, r.vel.z))))
        speed = Math.hypot(r.vel.x, r.vel.z)
      }
      return { peakYaw, peakSlip: peakSlip * 180 / Math.PI, speed }
    }
    const lifted = probe(0.3)
    const powered = probe(1)
    // The powered car is the FASTER of the two, so the falloff is working
    // against it, and it still rotates harder.
    expect(powered.speed).toBeGreaterThan(lifted.speed)
    expect(powered.peakYaw).toBeGreaterThan(lifted.peakYaw * 1.15)
    expect(powered.peakSlip).toBeGreaterThan(lifted.peakSlip * 1.8)
  })

  it('never lets a slide out-run the throttle -- 20s of sawing on ice', () => {
    // The third door this model has had to manufacturing speed (after the
    // drift's sqrt(1 + crab^2) and the bounce walls): with the longitudinal
    // controller driving the FORWARD component, a car at 30 degrees of slip
    // would carry 15% more ground speed than the throttle ever asked for.
    for (const c of CHASSIS) {
      const track = new Track(ring('ice', 4000, 900))
      const derived = getDerived(c.id)
      const r = spawn(track, c.id, 100, derived.topSpeed)
      const ctx: VehicleContext = { track, raceTime: 0, iceCracked: false }
      let peak = 0
      for (let f = 0; f < 60 * 20; f++) {
        const steer = Math.sin(f / 22) > 0 ? 1 : -1
        stepVehicle(r, {
          steer, throttle: 1, brake: 0, drift: false,
          item: false, itemBack: false, lift: false, lookBack: false,
        }, ctx)
        ctx.raceTime += DT
        peak = Math.max(peak, Math.hypot(r.vel.x, r.vel.z))
      }
      expect(peak, `${c.id} reached ${peak.toFixed(2)} m/s`).toBeLessThanOrEqual(derived.topSpeed + 0.01)
    }
  })
})

describe('losing grip is catchable', () => {
  it('gives opposite lock its full authority at any slip angle', () => {
    // The asymmetry that makes a slide recoverable: T.grip.slipBiteStart takes
    // the nose away from the half of the stick that DEEPENS a slide, and never
    // from the half that recovers it.
    const track = new Track(ring('ice', 150, 400))
    const r = spawn(track, 'solaire', track.length * 0.25, 52)
    const ctx: VehicleContext = { track, raceTime: 0, iceCracked: false }
    const drive = (steer: number, frames: number) => {
      for (let f = 0; f < frames; f++) {
        stepVehicle(r, {
          steer, throttle: 1, brake: 0, drift: false,
          item: false, itemBack: false, lift: false, lookBack: false,
        }, ctx)
        ctx.raceTime += DT
      }
      return angleDelta(r.yaw, Math.atan2(r.vel.x, r.vel.z)) * 180 / Math.PI
    }
    const slid = drive(1, 90)
    expect(Math.abs(slid), 'the rig must actually break traction').toBeGreaterThan(10)
    // Half a second of opposite lock has to bring the nose back through the
    // direction of travel -- not merely stop the slide growing.
    const caught = drive(-1, 30)
    expect(Math.abs(caught)).toBeLessThan(Math.abs(slid) * 0.6)
    expect(Number.isFinite(r.pos.x) && Number.isFinite(r.pos.z)).toBe(true)
  })
})

/** One AI frame on a uniform ring at a fixed speed. */
function aiOnRing(surface: SurfaceKind, radius: number, speed: number, chassisId = 'solaire'): InputFrame {
  const track = new Track(ring(surface, radius))
  const cfg: SimConfig = {
    seed: 7, totalLaps: 3, racerCount: 1, trackId: track.def.id,
    chassisIds: [chassisId], pilotIds: ['pip'], localRacerIndex: -1, aiSkill: [4],
  }
  resetAI()
  const race = new Race(track, cfg)
  const r = race.state.racers[0]
  const s = track.length * 0.25
  const p = track.surfacePoint(s, 0)
  r.pos.x = p.x; r.pos.y = p.y + getLocomotion(chassisId).rideHeight; r.pos.z = p.z
  r.splineS = s
  r.yaw = track.yawAt(s)
  r.vel.x = Math.sin(r.yaw) * speed
  r.vel.z = Math.cos(r.yaw) * speed
  return stepAI(r, race.state, track, new Rng(11))
}

describe('T.ai.surfaceCaution', () => {
  const R = 180
  const V = 58

  it('is what makes the AI brake for ice, and 0 makes it drive the ice like snow', () => {
    // A 180 m corner is flat out on snow for Solaire: no brake, full throttle.
    const snow = aiOnRing('snow', R, V)
    expect(snow.brake).toBe(0)
    expect(snow.throttle).toBe(1)

    // The same corner on ice, with the shipped caution, is a braking zone --
    // and now it is a braking zone because the car genuinely cannot hold it.
    ;(T.ai as { surfaceCaution: number }).surfaceCaution = 1.0
    const iceCautious = aiOnRing('ice', R, V)
    expect(iceCautious.brake).toBeGreaterThan(0)
    expect(iceCautious.throttle).toBe(0)

    // With the surface term switched off the AI drives the ice exactly as it
    // drives the snow. That used to be the CORRECT reading of the physics; it
    // is now simply the AI refusing to look at the surface.
    ;(T.ai as { surfaceCaution: number }).surfaceCaution = 0
    const iceBlind = aiOnRing('ice', R, V)
    expect(iceBlind.brake).toBe(snow.brake)
    expect(iceBlind.throttle).toBe(snow.throttle)
  })

  it('scales the surface term rather than switching it, so it can be swept', () => {
    const brakingOnset = (surface: SurfaceKind, caution: number): number => {
      ;(T.ai as { surfaceCaution: number }).surfaceCaution = caution
      for (let v = 25; v <= 90; v += 0.25) {
        if (aiOnRing(surface, 150, v).brake > 0) return v
      }
      return Infinity
    }
    const onSnow = brakingOnset('snow', 1.0)
    const blind = brakingOnset('ice', 0)
    const half = brakingOnset('ice', 0.5)
    const full = brakingOnset('ice', 1.0)

    expect(blind).toBeCloseTo(onSnow, 5)     // caution 0 => ice reads as snow
    expect(half).toBeLessThan(blind)
    expect(full).toBeLessThan(half)
    // The shipped setting throws away about a third of the corner speed.
    expect(full / onSnow).toBeLessThan(0.72)
  })

  it('is inert on a surface at full grip, so it cannot move Rustfall', () => {
    for (const caution of [0, 0.5, 1.0]) {
      ;(T.ai as { surfaceCaution: number }).surfaceCaution = caution
      const f = aiOnRing('tarmac', 250, 55)
      expect(f.throttle).toBe(1)
      expect(f.brake).toBe(0)
    }
  })
})

describe('the AI brakes for the same limit the tyres have', () => {
  /**
   * cornerLimit used to be sqrt(effGrip * 26 / k) against a physics engine with
   * no lateral limit at all -- the 26 was a number the AI believed and nothing
   * else in the project could see. It is now the same function stepVehicle
   * uses, so T.ai.corneringCaution is a genuine margin: at c the AI spends c^2
   * of the lateral budget.
   */
  it('asks for a speed the car can actually hold, with corneringCaution in hand', () => {
    for (const c of CHASSIS) {
      const derived = getDerived(c.id)
      const loco = getLocomotion(c.id)
      for (const s of ['tarmac', 'ice'] as SurfaceKind[]) {
        const budget = lateralBudget(derived, loco, SURFACE_GRIP[s])
        const k = 1 / 150
        const limit = cornerSpeedAt(budget, k)
        const asked = limit * T.ai.corneringCaution
        // What the AI actually spends, as a share of the budget.
        const spend = (asked * asked * k) / budget
        expect(spend).toBeCloseTo(T.ai.corneringCaution ** 2, 6)
        expect(spend).toBeLessThan(0.75)
      }
    }
  })

  /**
   * Why cutting Cryostatic's ice from 39% of the lap to 17% moved nothing: the
   * corner limit is sqrt(budget / k), so ice on a straight (k -> 0) is free and
   * ice in a corner is taxed as L * (1/v_ice - 1/v_snow), which grows as the
   * corner tightens. Ice is priced by curvature, not by length -- and now that
   * the limit is real, that is true of the player as well as the AI.
   */
  it('costs nothing on a straight and progressively more as the corner tightens', () => {
    const derived = getDerived('solaire')
    const loco = getLocomotion('solaire')
    const cap = derived.topSpeed * T.ai.skillSpeed[4]
    const cost = (radius: number): number => {
      const k = 1 / radius
      const vSnow = Math.min(cap, cornerSpeedAt(lateralBudget(derived, loco, 1), k) * T.ai.corneringCaution)
      const vIce = Math.min(cap, cornerSpeedAt(lateralBudget(derived, loco, SURFACE_GRIP.ice), k) * T.ai.corneringCaution)
      return 1 / vIce - 1 / vSnow      // seconds lost per metre of ice
    }
    expect(cost(4000)).toBe(0)
    const sweeper = cost(200)
    const cavern = cost(150)
    const tunnel = cost(60)
    expect(sweeper).toBeGreaterThan(0)
    expect(cavern).toBeGreaterThan(sweeper)
    expect(tunnel).toBeGreaterThan(cavern * 1.5)
  })
})
