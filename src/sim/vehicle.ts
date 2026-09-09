import {
  type Vec3, clamp, clamp01, lerp, angleDelta, damp, sign, v3,
  vrotAxis, vrotFromTo, vnormi,
} from './math'
import type { InputFrame, RacerState, ChassisDerived, LocomotionProfile } from './types'
import { TUNING as T } from '../content/tuning'
import { getDerived, getLocomotion, CHASSIS_BY_ID } from '../content/chassis'
import { Track, SURFACE_GRIP, bridgeSolid } from './track'

const DT = T.sim.dt

/** Absolute velocity ceiling, m/s. Pure safety net; see the clamp below. */
const SPEED_CEILING = 120

/** Scratch vectors, module-level so the step loop never allocates. */
const _fwd = v3()
const _right = v3()
const _up = v3(0, 1, 0)
const _upTarget = v3(0, 1, 0)
const _prevUp = v3(0, 1, 0)

/**
 * THE GRAVITY SWITCH.
 *
 * True while stepping a racer on a track that authors up-vectors. Everything
 * gravity-aware in this file is written so that with `_grav === false` it does
 * exactly the arithmetic it did before the system existed -- the extra terms
 * are all multiplied by a `.y` that is provably zero on a flat track, and the
 * few places that cannot be written that way branch on this flag.
 *
 * That is deliberate. Rustfall and Cryostatic are balanced, gated and shipped;
 * a general gravity model that shifts their lap times by a tenth would cost a
 * re-tune of two tracks to buy nothing, because neither of them leaves +Y.
 */
let _grav = false

/** Speed in the plane the car is driving in. */
function planarSpeed(v: Vec3): number {
  return _grav ? Math.hypot(v.x, v.y, v.z) : Math.hypot(v.x, v.z)
}

/** Component of `v` along a basis vector that lies in the driving plane. */
function planarDot(v: Vec3, b: Vec3): number {
  return _grav ? v.x * b.x + v.y * b.y + v.z * b.z : v.x * b.x + v.z * b.z
}

/**
 * Altitude anchor: the point on the road surface the car's height is measured
 * from, and `_up` is the axis it is measured along.
 *
 * On a flat track the anchor is (pos.x, surfaceY, pos.z) and the axis is +Y, so
 * every helper below collapses to the plain `pos.y - surfaceY` arithmetic this
 * file used before gravity existed. Each one branches explicitly rather than
 * relying on the algebra collapsing, because `a + (b - a)` is not `b` in
 * floating point and a track whose balance is already gated should not move by
 * an ulp per frame.
 */
const _anchor = v3()

function altOf(r: RacerState): number {
  if (!_grav) return r.pos.y - _anchor.y
  return (r.pos.x - _anchor.x) * _up.x + (r.pos.y - _anchor.y) * _up.y + (r.pos.z - _anchor.z) * _up.z
}
function addAlt(r: RacerState, d: number): void {
  if (!_grav) { r.pos.y += d; return }
  r.pos.x += _up.x * d; r.pos.y += _up.y * d; r.pos.z += _up.z * d
}
function setAlt(r: RacerState, a: number): void {
  if (!_grav) { r.pos.y = _anchor.y + a; return }
  addAlt(r, a - altOf(r))
}
function dampAlt(r: RacerState, targetAlt: number, halfLife: number): void {
  if (!_grav) { r.pos.y = damp(r.pos.y, _anchor.y + targetAlt, halfLife, DT); return }
  const a = altOf(r)
  addAlt(r, damp(a, targetAlt, halfLife, DT) - a)
}

/**
 * How far the nose is off the racing direction, radians, always positive.
 *
 * Flat, that is the yaw difference. On a gravity track yaw is a compass bearing
 * about world +Y and means nothing on a vertical wall, so the angle is taken
 * between the actual heading and the actual tangent.
 */
function headingError(r: RacerState, track: Track, s: number): number {
  if (!_grav) return Math.abs(angleDelta(r.yaw, track.yawAt(s)))
  const t = track.at(s).tangent
  return Math.acos(clamp(r.fwd.x * t.x + r.fwd.y * t.y + r.fwd.z * t.z, -1, 1))
}

/**
 * Signed angle from `from` to `to` measured in the plane perpendicular to
 * `up`, positive the same way a positive yawRate turns.
 *
 * Neither argument has to lie in the plane and neither has to be a unit
 * vector: atan2 of (the out-of-plane component of the cross product) against
 * (the dot) is exactly the in-plane angle, because both terms pick up the same
 * |from||to| scale factor and the out-of-plane parts of `from` and `to`
 * contribute nothing to the axis component of the cross product. That is what
 * lets the AI hand it a raw world-space offset -- which on a gravity track
 * carries the car's ride height along -up -- without projecting first.
 *
 * Exported so ai.ts can do its heading comparison in the racer's OWN surface
 * plane instead of about world +Y, which is meaningless on a vertical wall.
 */
export function signedAngleAround(from: Vec3, to: Vec3, up: Vec3): number {
  const d = from.x * to.x + from.y * to.y + from.z * to.z
  const cx = from.y * to.z - from.z * to.y
  const cy = from.z * to.x - from.x * to.z
  const cz = from.x * to.y - from.y * to.x
  return Math.atan2(cx * up.x + cy * up.y + cz * up.z, d)
}

/**
 * Signed angle from the racer's nose to `target`, measured about the racer's
 * own up. Positive is a rotation the same way a positive yawRate turns.
 *
 * On a flat track with a unit `target` this is exactly angleDelta(r.yaw,
 * atan2(target.x, target.z)), which is what makes it a drop-in for the AI's
 * yaw comparison.
 */
export function signedHeadingError(r: RacerState, target: Vec3): number {
  const d = clamp(r.fwd.x * target.x + r.fwd.y * target.y + r.fwd.z * target.z, -1, 1)
  const cx = r.fwd.y * target.z - r.fwd.z * target.y
  const cy = r.fwd.z * target.x - r.fwd.x * target.z
  const cz = r.fwd.x * target.y - r.fwd.y * target.x
  return Math.atan2(cx * r.up.x + cy * r.up.y + cz * r.up.z, d)
}

/** Rebuild `v` from two in-plane basis vectors and their components. */
function planarSet(v: Vec3, a: Vec3, sa: number, b: Vec3, sb: number): void {
  v.x = a.x * sa + b.x * sb
  v.z = a.z * sa + b.z * sb
  v.y = _grav ? a.y * sa + b.y * sb : 0
}

/**
 * World basis from a yaw angle.
 *
 * Yaw is defined so that forward = (sin y, 0, cos y), which matches
 * `Track.yawAt()` = atan2(tangent.x, tangent.z).
 *
 * Right is then `forward x up`, the same definition `Track` uses for its own
 * `right` basis, and the same direction the chase camera puts on screen-right.
 * At yaw 0 that is world -X, NOT +X.
 *
 *   d(forward)/d(yaw) = (cos y, 0, -sin y) = -right
 *
 * so rotating TOWARD right means DECREASING yaw. That is what STEER_SIGN
 * encodes. Getting this backwards inverts the steering: the car turns left
 * when the player steers right.
 */
function setBasis(r: RacerState): void {
  if (!_grav) {
    const sy = Math.sin(r.yaw), cy = Math.cos(r.yaw)
    _fwd.x = sy; _fwd.y = 0; _fwd.z = cy
    _right.x = -cy; _right.y = 0; _right.z = sy
    _up.x = 0; _up.y = 1; _up.z = 0
    return
  }
  // Gravity path: `r.up` and `r.fwd` are the state, and yaw is the mirror.
  // Re-orthogonalise the nose against the up every frame -- both are integrated
  // separately, and without this they drift apart into a sheared basis over a
  // long wall-ride.
  _up.x = r.up.x; _up.y = r.up.y; _up.z = r.up.z
  vnormi(_up)
  const d = r.fwd.x * _up.x + r.fwd.y * _up.y + r.fwd.z * _up.z
  _fwd.x = r.fwd.x - _up.x * d
  _fwd.y = r.fwd.y - _up.y * d
  _fwd.z = r.fwd.z - _up.z * d
  vnormi(_fwd)
  // right = forward x up, the same handedness the flat path uses: at yaw 0 with
  // up = +Y that is world -X, which is what STEER_SIGN is written against.
  _right.x = _fwd.y * _up.z - _fwd.z * _up.y
  _right.y = _fwd.z * _up.x - _fwd.x * _up.z
  _right.z = _fwd.x * _up.y - _fwd.y * _up.x
  vnormi(_right)
  r.fwd.x = _fwd.x; r.fwd.y = _fwd.y; r.fwd.z = _fwd.z
  r.up.x = _up.x; r.up.y = _up.y; r.up.z = _up.z
  r.yaw = Math.atan2(_fwd.x, _fwd.z)
}

/**
 * Swing a racer's frame onto a new up-vector.
 *
 * Applied every step on a gravity track: the surface under the car rolls, and
 * the nose and (when the wheels are down) the momentum have to roll with it.
 * Rotating the velocity is what makes a wall-ride work -- without it the car
 * arrives at the base of the wall with all its speed pointing along the old
 * flat plane and simply drives into the barrier.
 *
 * Airborne, the velocity is deliberately NOT rotated. A car in the air is a
 * projectile; only its attitude follows the road it is heading for.
 */
function reframe(r: RacerState, target: Vec3, rotateVelocity: boolean): void {
  _prevUp.x = r.up.x; _prevUp.y = r.up.y; _prevUp.z = r.up.z
  const dot = _prevUp.x * target.x + _prevUp.y * target.y + _prevUp.z * target.z
  if (dot > 0.9999999) return
  r.up.x = target.x; r.up.y = target.y; r.up.z = target.z
  vrotFromTo(r.fwd, _prevUp, target)
  if (rotateVelocity) vrotFromTo(r.vel, _prevUp, target)
}

/**
 * Steering right (+1) rotates toward `right`, which decreases yaw.
 *
 * Exported so ai.ts can INVERT the steering model rather than keep a second
 * copy of the convention. tests/steering.test.ts guards the behaviour; a
 * duplicated `-1` in the AI would not be guarded by anything.
 */
export const STEER_SIGN = -1

/**
 * THE FRICTION BUDGET: the largest lateral acceleration the tyres can apply,
 * m/s^2.
 *
 * Exported because ai.ts's corner-speed model must be THIS number and not a
 * second guess at it. `cornerLimit = sqrt(effGrip * 26 / k)` used to be a
 * belief the AI held alone -- the physics had no lateral limit at all -- and
 * keeping the two in separate files is how that happened. With one function
 * the AI's braking point is a property of the car, and T.ai.corneringCaution
 * becomes an honest safety margin instead of a fudge factor.
 */
export function lateralBudget(
  derived: ChassisDerived,
  loco: LocomotionProfile,
  surfaceGrip: number,
): number {
  return derived.gripCoeff * loco.gripMult * surfaceGrip * T.grip.lateralAccel
}

/**
 * The speed at which a corner of curvature `k` exactly spends `budget`.
 * v = sqrt(a / k), the standard result, and now literally the speed above
 * which stepVehicle starts letting the car slide.
 */
export function cornerSpeedAt(budget: number, k: number): number {
  return k > 1e-4 ? Math.sqrt(budget / k) : Infinity
}

/**
 * How much of the surface's grip a drift arc feels. Exactly 1 on a full-grip
 * surface, so nothing about the drift on tarmac or snow changes.
 * See T.drift.surfaceGripInfluence for why the arc carries this and the slide
 * angle does not.
 */
export function driftSurfaceFactor(surfaceGrip: number): number {
  return 1 + (surfaceGrip - 1) * T.drift.surfaceGripInfluence
}

/**
 * THE VACUUM, HALF ONE: the air is not slowing you down any more.
 *
 * Multiplier on top speed at vacuum `vac` (0..1). See T.vacuum.dragRemoved for
 * why this is a multiplier on the asymptote rather than a drag force removed:
 * `T.sim.airDrag` has never been read by anything, there is no drag term in
 * this file to switch off, and adding one would move three balanced circuits.
 *
 * At terminal velocity thrust balances drag and drag goes as v^2, so removing
 * a fraction f of the drag multiplies the terminal speed by 1/sqrt(1 - f).
 *
 * EXPORTED BECAUSE ai.ts MUST USE THIS FUNCTION AND NOT A SECOND GUESS AT IT,
 * the same contract `lateralBudget` already carries. An AI that did not know
 * the vacuum raises its ceiling would simply lift off the throttle in the one
 * place on the lap where the throttle is the whole answer.
 *
 * `vac <= 0` returns exactly 1, and `x * 1` is exact in IEEE754, so every
 * metre of every track that authors no vacuum is bit-identical.
 */
export function vacuumTopSpeedMult(vac: number): number {
  if (vac <= 0) return 1
  return 1 / Math.sqrt(1 - clamp01(vac) * T.vacuum.dragRemoved * T.sim.airDrag)
}

/**
 * THE VACUUM, HALF TWO: the medium you were pushing against to turn is gone.
 *
 * Multiplier on the lateral friction budget at vacuum `vac`, scaled by the
 * class's own `vacuumGripLoss` -- hover worst, grounded middle, flight least.
 * This is the SECOND multiplier on the budget, sitting alongside the surface
 * one: a corner in vacuum on a low-grip surface is charged for both, because
 * both are true.
 *
 * Exported for ai.ts for the same reason as above, and it matters more here:
 * the AI's whole corner-speed model is `sqrt(budget / k)`, so an AI blind to
 * this arrives at every vacuum corner above a limit that really has moved and
 * really does cost the corner.
 */
export function vacuumGripMult(vac: number, loco: LocomotionProfile): number {
  if (vac <= 0) return 1
  return 1 - clamp01(vac) * loco.vacuumGripLoss
}

/**
 * Stick position mapped to slide commitment: 0 = full counter-steer (wide,
 * shallow), 1 = full lock into the drift (tight, heavily crabbed). Everything
 * about the slide -- arc, crab and charge rate -- reads off this one number,
 * and the drift ENTRY frame has to compute it the same way every later frame
 * does or the entry disagrees with the frame after it.
 */
function inwardFromStick(steer: number, side: number): number {
  return clamp01((clamp(steer * side, -1, 1) + 1) * 0.5)
}

export interface VehicleContext {
  track: Track
  /** Effective top speed multiplier from Charge pickups etc. */
  raceTime: number
  /**
   * True once the leader has reached TUNING.hazard.crackLap. Passed in rather
   * than mutating Track, because Track is immutable and SHARED -- tools/
   * balance.ts builds it once and runs hundreds of races through it, so a
   * cracked shelf baked into the samples would leak from one race into every
   * race after it.
   */
  iceCracked: boolean
}

/**
 * Advance one racer by exactly one fixed step.
 * Pure: reads input and world, mutates only `r`.
 */
export function stepVehicle(
  r: RacerState,
  input: InputFrame,
  ctx: VehicleContext,
): void {
  const derived: ChassisDerived = getDerived(r.chassisId)
  const loco: LocomotionProfile = getLocomotion(r.chassisId)
  const track = ctx.track

  // Which physics this track wants. Set once per racer-step; every gravity-aware
  // helper in this file reads it.
  _grav = track.hasGravity

  // -------------------------------------------------------------------------
  // Status effects
  // -------------------------------------------------------------------------
  if (r.spinTime > 0) r.spinTime = Math.max(0, r.spinTime - DT)
  if (r.stunTime > 0) r.stunTime = Math.max(0, r.stunTime - DT)
  if (r.immuneTime > 0) r.immuneTime = Math.max(0, r.immuneTime - DT)
  if (r.invincibleTime > 0) r.invincibleTime = Math.max(0, r.invincibleTime - DT)
  if (r.slowTime > 0) { r.slowTime = Math.max(0, r.slowTime - DT); if (r.slowTime === 0) r.slowMag = 0 }
  if (r.boostTime > 0) {
    r.boostTime = Math.max(0, r.boostTime - DT)
    if (r.boostTime === 0) { r.boostMag = 0; r.boostSource = 'none' }
  }
  if (r.chainWindow > 0) {
    r.chainWindow = Math.max(0, r.chainWindow - DT)
    if (r.chainWindow === 0) r.chainStacks = 0
  }
  if (r.rouletteTime > 0) r.rouletteTime = Math.max(0, r.rouletteTime - DT)

  const disabled = r.spinTime > 0 || r.stunTime > 0 || r.respawnTime > 0
  const eff: InputFrame = disabled
    ? { steer: 0, throttle: 0, brake: 0, drift: false, item: false, itemBack: false, lift: false, lookBack: false }
    : input

  // -------------------------------------------------------------------------
  // Respawn
  // -------------------------------------------------------------------------
  if (r.respawnTime > 0) {
    // Relocation happens the moment a respawn starts, not at the end of it.
    // Holding the racer at the point of failure meant a car sat motionless
    // outside the barrier, on the terrain, for nearly two seconds — which is
    // exactly what "the vehicles are clipping outside the track walls" looks
    // like from the driver's seat.
    if (!r.respawnPlaced) {
      r.respawnPlaced = true
      const smp = track.at(r.splineS)
      const lat = clamp(r.lateral, -smp.width * 0.55, smp.width * 0.55)
      const p = track.surfacePoint(r.splineS, lat)
      r.pos.x = p.x + smp.normal.x * loco.rideHeight
      r.pos.y = p.y + smp.normal.y * loco.rideHeight
      r.pos.z = p.z + smp.normal.z * loco.rideHeight
      r.lateral = lat
      r.yaw = track.yawAt(r.splineS)
      // Respawn resets the whole frame, not just the compass. On a gravity
      // track a racer that fell off a wall-ride has to come back ON the wall,
      // upright relative to it and pointing along it.
      r.fwd.x = smp.tangent.x; r.fwd.y = smp.tangent.y; r.fwd.z = smp.tangent.z
      r.up.x = smp.normal.x; r.up.y = smp.normal.y; r.up.z = smp.normal.z
      r.vel.x = 0; r.vel.y = 0; r.vel.z = 0
      r.vertVel = 0
      r.ballisticTime = 0
      r.driftSide = 0; r.driftCharge = 0; r.driftTier = -1; r.driftInward = 0
      r.chainStacks = 0
      r.grounded = true
      r.altitude = loco.rideHeight
      r.offTrackTime = 0
    }
    r.respawnTime -= DT
    if (r.respawnTime <= 0) {
      r.respawnTime = 0
      r.respawnPlaced = false
      const sp = derived.topSpeed * T.offTrack.respawnSpeedFraction
      if (track.hasGravity) {
        r.vel.x = r.fwd.x * sp; r.vel.y = r.fwd.y * sp; r.vel.z = r.fwd.z * sp
      } else {
        r.vel.x = Math.sin(r.yaw) * sp
        r.vel.z = Math.cos(r.yaw) * sp
      }
    } else {
      return
    }
  }

  // -------------------------------------------------------------------------
  // Track frame
  // -------------------------------------------------------------------------
  const proj = track.project(r.pos, r.splineS)
  const smp = proj.sample

  // -------------------------------------------------------------------------
  // Gravity
  //
  // `r.up` is the direction the car calls up, and -up is where it falls. On a
  // flat track it is world +Y forever and this whole block is skipped. On a
  // gravity track it chases the road: pinned to the surface normal while the
  // wheels are down, and while airborne blended toward world +Y by however much
  // authority the designer left the surface (`stick`), so a ramp on level road
  // still throws you in an ordinary arc while a wall-ride keeps you on the wall.
  // -------------------------------------------------------------------------
  if (_grav) {
    if (r.grounded || r.respawnTime > 0) {
      _upTarget.x = smp.normal.x; _upTarget.y = smp.normal.y; _upTarget.z = smp.normal.z
      // Grounded, the frame snaps: the car IS on the surface, and a lagging up
      // means the wheels are visibly not on the road they are driving on.
      reframe(r, _upTarget, true)
    } else {
      const k = clamp01(smp.stick)
      _upTarget.x = smp.normal.x * k
      _upTarget.y = smp.normal.y * k + (1 - k)
      _upTarget.z = smp.normal.z * k
      vnormi(_upTarget)
      // Airborne the frame eases, so a jump reads as the car rotating to meet
      // the landing rather than snapping to it the instant it clears the lip.
      const f = 1 - Math.pow(2, -DT / T.gravity.airAlignHalfLife)
      _upTarget.x = r.up.x + (_upTarget.x - r.up.x) * f
      _upTarget.y = r.up.y + (_upTarget.y - r.up.y) * f
      _upTarget.z = r.up.z + (_upTarget.z - r.up.z) * f
      vnormi(_upTarget)
      reframe(r, _upTarget, false)
    }
  }

  const halfWidth = smp.width
  const edge = Math.abs(proj.lateral) / halfWidth
  const offTrack = edge > T.offTrack.edgeTolerance

  // Surface friction only bites classes that touch the ground.
  // A cracked shelf keeps its geometry and loses everything else: bare ice
  // under every class, and no walls to catch you.
  const cracked = smp.fragile && ctx.iceCracked
  const surfaceKind = cracked ? T.hazard.crackedSurface : smp.surface
  const surfaceGrip = lerp(1, SURFACE_GRIP[surfaceKind], loco.surfaceFrictionInfluence)

  // ---------------------------------------------------------------------------
  // The friction budget for this frame.
  //
  // One number, used three times: it caps how hard the tyres may pull the
  // momentum sideways (the lateral block), it caps what the engine may put down
  // through the friction ellipse (the longitudinal block), and ai.ts reads the
  // same function to work out how fast it can take the corner ahead. Before
  // this existed the three disagreed -- the physics had no limit, the AI had a
  // guess, and the drift had neither.
  //
  // Off the surface and (for the non-flight classes) in the air, the same
  // multipliers the old lateral-decay term carried: there is nothing under the
  // tyres to push against.
  // ---------------------------------------------------------------------------
  // HARD VACUUM. Gated on the track authoring any, so the three circuits that
  // shipped before it existed never read the field. See TrackNode.vacuum.
  const vac = track.hasVacuum ? smp.vacuum : 0

  let gripAccel = lateralBudget(derived, loco, surfaceGrip)
  if (vac > 0) gripAccel *= vacuumGripMult(vac, loco)
  if (offTrack) gripAccel *= T.offTrack.grip
  if (!r.grounded && loco.gapCross < 900) gripAccel *= 0.25

  // -------------------------------------------------------------------------
  // Speed targets
  // -------------------------------------------------------------------------
  const chargeBonus = 1 + Math.min(r.charges, T.boost.chargeMax) * T.boost.chargePer
  let topSpeed = derived.topSpeed * chargeBonus
  // The vacuum raises the ceiling before the penalties, so running wide in
  // vacuum still costs T.offTrack.speedMult of a bigger number rather than
  // being forgiven by it.
  if (vac > 0) topSpeed *= vacuumTopSpeedMult(vac)
  if (offTrack) topSpeed *= T.offTrack.speedMult
  if (r.slowTime > 0) topSpeed *= 1 - r.slowMag

  const boostedTop = topSpeed * (1 + r.boostMag)

  // Forward basis from the racer's heading and up.
  setBasis(r)

  const fwdSpeed = planarDot(r.vel, _fwd)
  const latSpeed = planarDot(r.vel, _right)

  // -------------------------------------------------------------------------
  // Longitudinal
  //
  // A drifting car travels at an ANGLE to its nose, so the throttle has to
  // control GROUND speed, not the forward component. Driving the forward
  // component instead is what made a slide free speed: at a 32-degree crab the
  // injected lateral is 0.62x the forward speed, so the car ended up moving
  // 18% faster than the throttle ever asked for, purely as a side effect of
  // pointing sideways. That inflated the HUD, fed the AI a speed it had to
  // brake for mid-corner, and handed a hidden 18% forward kick at release when
  // the momentum was rotated onto the nose. Outside a drift the two numbers
  // are identical, so nothing else in the model changes.
  // -------------------------------------------------------------------------
  //
  // It is now GROUND SPEED WHETHER OR NOT THE CAR IS DRIFTING. It had to
  // become unconditional the moment grip got teeth: outside a drift the
  // velocity is no longer rebuilt on the nose every frame, so a car that has
  // run wide really is travelling at an angle to where it points, and driving
  // the forward COMPONENT to the top speed would let a 30-degree slide carry
  // 15% more ground speed than the throttle ever asked for. That is the same
  // free-speed bug the drift shipped twice, arriving through a different door.
  // With no slip the two numbers are identical, so nothing on a straight moves.
  const groundSpeed = planarSpeed(r.vel)
  const longSpeed = groundSpeed * (fwdSpeed < 0 ? -1 : 1)

  let targetSpeed = 0
  if (eff.throttle > 0) targetSpeed = boostedTop * eff.throttle
  if (eff.brake > 0) {
    targetSpeed = longSpeed > 1 ? 0 : -boostedTop * 0.34 * eff.brake
  }

  const accelRate = (boostedTop / Math.max(0.3, derived.timeToTop)) * T.derive.accelCurveGain
  const gap = targetSpeed - longSpeed
  let dv: number
  if (r.grounded || loco.gapCross > 0) {
    // Front-loaded curve: strong at low speed, asymptotic near the top.
    const headroom = clamp01(Math.abs(gap) / Math.max(1, boostedTop))
    dv = sign(gap) * accelRate * headroom * DT
    if (eff.brake > 0 && longSpeed > 0) dv = -Math.min(longSpeed, accelRate * 1.5 * DT)
    if (eff.throttle === 0 && eff.brake === 0) dv = -Math.min(Math.abs(longSpeed), boostedTop * 0.45 * DT) * sign(longSpeed)
  } else {
    dv = gap * 0.12 * DT
  }

  // ---------------------------------------------------------------------------
  // TRACTION: the drive axle draws on the same friction budget as the corner.
  //
  // latUse is read from LAST frame's yaw rate, which is deliberate and not a
  // shortcut: the steering block that produces this frame's rate runs after
  // this one, and the rate is damped on a 0.075s half-life so the two differ by
  // well under a percent. Reordering the whole step to make it exact would buy
  // nothing and would put the drift state machine on the far side of the
  // steering, which is where the entry frame lives.
  //
  // ONLY DRIVE IS LIMITED. Braking is left alone on purpose: on a surface this
  // slick the brake is the player's way OUT of a slide, and a brake that fails
  // exactly when the car is sliding turns a mistake the player can answer into
  // one they cannot. Engine braking (throttle and brake both released) is not
  // limited either -- it is drag, not traction.
  // ---------------------------------------------------------------------------
  let spinExcess = 0
  if (eff.throttle > 0 && eff.brake === 0 && dv * longSpeed >= 0 && (r.grounded || loco.gapCross > 0)) {
    const latUse = clamp01(Math.abs(groundSpeed * r.yawRate) / Math.max(1e-3, gripAccel))
    const ellipse = Math.max(T.grip.tractionFloor, Math.sqrt(Math.max(0, 1 - latUse * latUse)))
    const tractionCap = gripAccel * T.grip.tractionRatio * ellipse
    const demand = Math.abs(dv) / DT
    if (demand > tractionCap) {
      // What the surface refuses is not deleted, it spins the wheels. The share
      // it refuses is what T.grip.powerOversteer turns into rotation.
      // Normalised against the FULL straight-line traction, not against the
      // pinched mid-corner cap. Dividing by the cap makes the term saturate the
      // moment the ellipse closes -- at the lateral limit the cap is a sixth of
      // its straight-line value, so any throttle at all reads as total
      // wheelspin -- and that put the AI 0.4 respawns a race worse for a
      // mechanic it was not even choosing to use. This asks the honest
      // question: how much of the car's whole traction is being thrown away?
      spinExcess = clamp01((demand - tractionCap) / Math.max(1, gripAccel * T.grip.tractionRatio))
      dv = sign(dv) * tractionCap * DT
    }
  }

  let newLong = longSpeed + dv
  if (Math.abs(newLong) > boostedTop * 1.35) newLong = sign(newLong) * boostedTop * 1.35

  // -------------------------------------------------------------------------
  // Drift state machine
  // -------------------------------------------------------------------------
  const speedFrac = clamp01(Math.abs(newLong) / Math.max(1, topSpeed))
  // COYOTE TIME ON THE DRIFT.
  //
  // The air test used to be bare `r.grounded`, and `gapCross > 0` is true for
  // hover and flight and false for all three grounded chassis. So a single
  // airborne frame -- a kerb, a crest, a bump coming off a kerb -- deleted a
  // grounded car's drift outright and could not touch a hover or flight one.
  // That is not a class trade-off, it is a tax nobody authored, and it showed
  // up in the numbers as a straight split by locomotion: across 600 races the
  // share of drifts reaching NO tier at all was Solaire 40.5%, Bulwark 41.6%,
  // Dray-9 42.4% against Filament 2.4% and Vector-7 2.1%. The two chassis
  // sitting on the 12% win-share floor were both grounded.
  //
  // A short grace window fixes it and is what an arcade racer should do anyway:
  // going light over a crest is not letting go of the handbrake. It is kept
  // under a real launch (a ramp gives ~2s of hang time) so a jump still ends
  // the drift and arms the trick instead.
  const airborneTooLong = !r.grounded && loco.gapCross <= 0 && r.airTime >= T.drift.airGrace
  const canDrift = Math.abs(newLong) > T.drift.minSpeedToDrift && !airborneTooLong

  // Set on the frame a drift is cashed in. The exit has to hand the lateral
  // block a body-frame DIRECTION rather than mutate r.vel, because the block
  // rebuilds r.vel from the forward/lateral pair and would throw the rotation
  // straight back out — which is exactly what releaseAlign used to do, making
  // it dead config: measured 17.6 degrees of crab still on the velocity one
  // frame after release with releaseAlign at 0.88.
  let releaseFwd = 0
  let releaseLat = 0
  let released = false
  let releaseKick = 0

  if (r.driftSide === 0) {
    if (eff.drift && canDrift && Math.abs(eff.steer) > T.steering.driftEnterThreshold) {
      r.driftSide = sign(eff.steer) as -1 | 1
      r.driftCharge = 0
      r.driftTier = -1
      // Seed the slide from the stick that STARTED it, not from full lock.
      // The entry frame snaps the yaw rate and the crab straight to whatever
      // this says, so hard-coding 1 gave a drift entered on a half-committed
      // stick one frame at full lock and then dropped it back: measured 2.48x
      // the sustained yaw rate and 1.39x the sustained slide angle at the 0.25
      // stick that just clears driftEnterThreshold, unwinding over the next 8
      // frames as a visible flick. Keyboard steering ramps 0 -> 1 over 0.12s
      // and pad/touch/tilt are analog, so a partial-stick entry is the normal
      // case. Before entrySnap this seed only set a damping target for one
      // frame and the overshoot was invisible; now it IS the entry.
      r.driftInward = inwardFromStick(eff.steer, sign(eff.steer))
      r.driftEntry = true
      r.driftTime = 0
      r.events.push({ t: 'driftStart' })
    }
  } else {
    // Counter-steering CONTROLS the slide, it does not end it. Only releasing
    // the drift button, dropping below the minimum speed, or a hard collision
    // exits. This is the Mario Kart behaviour: the stick chooses the line
    // inside the slide, and you decide when to cash it in.
    const exit = !eff.drift || !canDrift
    if (exit) {
      const tier = r.driftTier

      // Fire the boost along the NOSE, not along the crabbed momentum. During a
      // slide the car points into the corner while its velocity trails outside;
      // releasing has to convert that heading into travel or the boost shoots
      // off the racing line. Only the DIRECTION is rotated -- the ground speed
      // the longitudinal block just produced is carried through untouched, so
      // the redirect never adds or throws away speed.
      {
        const spd = Math.hypot(fwdSpeed, latSpeed)
        const k = T.drift.releaseAlign
        const bx = spd > 1e-3 ? fwdSpeed / spd : 1
        const bz = spd > 1e-3 ? latSpeed / spd : 0
        const mx = bx + (1 - bx) * k
        const mz = bz * (1 - k)
        const ml = Math.hypot(mx, mz) || 1
        releaseFwd = mx / ml
        releaseLat = mz / ml
        released = true
      }

      if (tier >= 0) {
        // Duration is proportional to how long the slide was actually held, on
        // top of the tier's base, so committing to a long drift pays more than
        // scraping into a tier and letting go immediately.
        const bonus = Math.min(T.drift.durationBonusCap, r.driftCharge * T.drift.durationPerSecond)
        applyBoost(r, T.drift.tierBoost[tier], T.drift.tierDuration[tier] + bonus, 'drift')
        // ...and an INSTANT kick along the nose on top of it. The sustained
        // boost only raises the ceiling, so on its own the payoff for a
        // perfectly held slide arrives over the following second and a half and
        // the moment of release feels like nothing happened. releaseFwd/
        // releaseLat above have already put the direction on the heading, so
        // adding to the ground speed here launches the car exactly where its
        // nose is pointing.
        //
        // The kick may not carry the car past the ceiling the boost it just
        // granted: it delivers that ceiling INSTANTLY instead of over the next
        // second and a half, and nothing more. Without this, tapping a Tier-0
        // drift every 0.72s parks the car 7.6 m/s above its own boosted top
        // speed indefinitely -- inside SPEED_CEILING, so nothing catches it,
        // but manufactured speed all the same, which this model has shipped
        // twice before.
        const cap = topSpeed * (1 + r.boostMag)
        const want = T.drift.releaseKick[Math.min(tier, T.drift.releaseKick.length - 1)]
        releaseKick = Math.max(0, Math.min(want, cap - Math.abs(newLong)))
        r.events.push({ t: 'boost', tier })
        if (tier >= 1) {
          r.chainWindow = T.drift.chainWindow
          r.chainStacks = Math.min(T.drift.chainMaxStacks, r.chainStacks + 1)
        } else {
          r.chainStacks = 0
        }
      } else {
        r.chainStacks = 0
      }
      r.events.push({ t: 'driftEnd', tier })
      r.driftSide = 0
      r.driftCharge = 0
      r.driftTier = -1
      r.driftInward = 0
    } else {
      // inward01: 0 = full counter-steer (wide, shallow), 1 = full lock into
      // the drift (tight, heavily crabbed). Everything about the slide reads
      // off this one number.
      const inward01 = inwardFromStick(eff.steer, r.driftSide)
      r.driftInward = inward01
      r.driftTime += DT
      const chainMult = 1 + r.chainStacks * T.drift.chainBonusPerStack
      const rate = derived.driftChargeMult * loco.driftChargeMult * chainMult
        * lerp(T.drift.chargeAtWide, 1.0, inward01)
      r.driftCharge += DT * rate * lerp(0.55, 1.0, speedFrac)
      let tier = -1
      for (let i = T.drift.tierTimes.length - 1; i >= 0; i--) {
        if (r.driftCharge >= T.drift.tierTimes[i]) { tier = i; break }
      }
      if (tier > r.driftTier) r.driftTier = tier
    }
  }

  // -------------------------------------------------------------------------
  // Steering / yaw
  // -------------------------------------------------------------------------
  const speedYawFalloff = 1 / (1 + Math.abs(newLong) / T.steering.yawSpeedFalloff)
  let targetYawRate: number

  // How far the slide is committed, after the stick curve. Both the arc and the
  // crab read this, so the two never disagree about which way the stick is.
  // Signed stick: -1 full counter-steer, 0 centred, +1 full lock into the drift.
  // stickCurve softens the middle of each half without moving either end.
  const stick = r.driftSide !== 0 ? r.driftInward * 2 - 1 : 0
  const shaped = Math.sign(stick) * Math.pow(Math.abs(stick), T.drift.stickCurve)

  if (r.driftSide !== 0) {
    // Full lock into the drift carves tight; full counter-steer runs it wide
    // and gently outward. Anything between is a continuously controllable line.
    //
    // The full-lock arc is built from the chassis's OWN steering authority, not
    // from one flat number for the roster: a flat arc gave Bulwark a 1.86x gain
    // over its own best steering lock and Filament only 1.18x, so for half the
    // roster the drift was barely a corner tool at all. arcBase keeps the
    // low-handling drift specialists carving hard in absolute terms.
    const tight = T.drift.arcBase + T.drift.arcPerYaw * derived.maxYawRate
    // The inward arc decays from full bite toward arcSustain as the slide is
    // held. A constant yaw rate is a constant-radius spiral, so an arc that
    // never eases keeps winding tighter relative to the road until the car is
    // aimed at the inside barrier -- the turn-in is fine, holding it is what
    // becomes uncontrollable. Counter-steer is NOT eased: the moment the drift
    // starts backing off is exactly when the player wants to open the line.
    const ease = T.drift.arcSustain
      + (1 - T.drift.arcSustain) * Math.exp(-r.driftTime / T.drift.arcEaseTime)
    // Three positions, not a ramp between two: full lock carves, the centre
    // HOLDS the slide at arcNeutral, full counter-steer opens the line. A
    // single lerp from arcCounter to full lock puts the arc's sign flip
    // wherever those two happen to cross, which lands on dead centre once
    // counter-steer is strong enough to be a real control.
    const hold = tight * ease * T.drift.arcNeutral
    // The surface scales the ARC and nothing else. A drift on ice still holds
    // the authored slide angle; it just cannot turn as tight while doing it.
    // See T.drift.surfaceGripInfluence -- and note this is exactly 1 on tarmac
    // and snow, so no measurement on a full-grip surface moves.
    const arc = (shaped >= 0
      ? lerp(hold, tight * ease, shaped)
      : lerp(hold, tight * T.drift.arcCounter, -shaped))
      * loco.driftArcMult * driftSurfaceFactor(surfaceGrip)
    targetYawRate = STEER_SIGN * r.driftSide * arc * speedYawFalloff
  } else {
    targetYawRate = STEER_SIGN * eff.steer * derived.maxYawRate * speedYawFalloff
    if (newLong < 0) targetYawRate *= -T.steering.reverseYawMult
    // UNDERSTEER: the front runs out before the stick does. Past
    // T.grip.slipBiteStart of slip the nose stops answering more lock, which is
    // what turning the wheel further and having nothing happen actually is.
    // Applied ONLY to the half of the stick that would deepen the slide --
    // `targetYawRate * latSpeed > 0` is "the commanded rotation is the same way
    // the car is already sliding" -- so unwinding and opposite lock keep every
    // bit of their authority. That asymmetry is what makes a slide catchable.
    if ((r.grounded || loco.gapCross > 0) && targetYawRate * latSpeed > 0) {
      const slipMag = Math.abs(Math.atan2(latSpeed, Math.max(1, Math.abs(fwdSpeed))))
      if (slipMag > T.grip.slipBiteStart) {
        const gone = clamp01((slipMag - T.grip.slipBiteStart)
          / Math.max(1e-6, T.grip.slipBiteFull - T.grip.slipBiteStart))
        targetYawRate *= lerp(1, T.grip.slipBiteFloor, gone)
      }
    }
    // POWER OVERSTEER. Torque the surface would not take spins the drive axle,
    // and an axle that is spinning is not making lateral force, so the tail
    // steps out. Added in the direction the car is ALREADY rotating -- there is
    // no tail-out without a corner to be thrown out of -- and carrying the same
    // speed falloff the stick does, which is what guarantees the driver can
    // always out-rotate it: full opposite lock is 1.0 against this 0.45,
    // through the identical falloff, at every speed.
    if (spinExcess > 0 && r.grounded && Math.abs(r.yawRate) > T.grip.oversteerMinYaw) {
      targetYawRate += sign(r.yawRate) * spinExcess * T.grip.powerOversteer
        * derived.maxYawRate * speedYawFalloff
    }
  }
  if (!r.grounded && loco.gapCross < 900) {
    targetYawRate *= r.airTime > 0.12 ? T.ramp.airControl : T.steering.airControl
  }
  if (r.spinTime > 0) {
    if (r.spinTime > T.items.spinAlignTime) {
      targetYawRate = T.items.spinRate // visible spin-out
    } else {
      // Tail of the spin: unwind into the racing direction instead of stopping
      // wherever the rotation happened to land. Recovering nose-first into
      // oncoming traffic is disorienting and costs far more than the hit did.
      const err = _grav
        ? signedHeadingError(r, smp.tangent)
        : angleDelta(r.yaw, track.yawAt(proj.s))
      targetYawRate = clamp(
        err / Math.max(DT, r.spinTime),
        -T.items.spinRate * 1.6, T.items.spinRate * 1.6,
      )
    }
  }

  // Drift entry snaps; everything else eases. Ramping the yaw in over the
  // normal steering half-life put a visible skate between pressing the button
  // and the car taking an angle.
  if (r.driftSide !== 0 && r.driftEntry) {
    r.yawRate = targetYawRate
  } else {
    const halfLife = r.driftSide !== 0 ? T.drift.yawHalfLife : T.steering.steerHalfLife
    r.yawRate = damp(r.yawRate, targetYawRate, halfLife, DT)
  }
  if (_grav) {
    // The nose turns about the car's OWN up, not world +Y. Halfway up a
    // wall-ride "left" is a rotation about a horizontal axis, and steering
    // about +Y there would pitch the car into the wall instead of turning it.
    vrotAxis(r.fwd, r.up, r.yawRate * DT)
    r.yaw = Math.atan2(r.fwd.x, r.fwd.z)
  } else {
    r.yaw += r.yawRate * DT
    if (r.yaw > Math.PI) r.yaw -= Math.PI * 2
    if (r.yaw < -Math.PI) r.yaw += Math.PI * 2
  }

  // Recompute basis after the yaw change so grip acts on the new heading.
  setBasis(r)

  // -------------------------------------------------------------------------
  // Lateral: grip outside a drift, an authored slide angle inside one
  // -------------------------------------------------------------------------
  let newFwd: number
  let newLat: number

  if (r.driftSide !== 0) {
    // The slide angle is AUTHORED, not the residue of a fight between grip and
    // an injected lateral. The old model lerped an injected target against the
    // grip decay every frame and settled at ~65% of slideTight, so the tuning
    // number did not mean the angle and a grippier chassis quietly drifted
    // shallower. Here the crab is eased from whatever the car is actually
    // doing to the commanded value, so slideTight IS the tangent of the slide
    // angle and entry, counter-steer and re-commit all read the same.
    // THE SLIDE ANGLE IS NOT A FUNCTION OF THE STICK. Counter-steering steers
    // the car outward; it does not stand the car up. Mapping the crab from the
    // stick meant a full counter-steer collapsed the slide from 32 degrees to
    // 10 and the car visibly bogged down mid-corner -- ground speed was
    // identical (measured 58.7 m/s either way, the same as driving straight),
    // but a car that stops being sideways stops reading as fast, and the whole
    // point of holding a drift is that it stays held. The stick now controls
    // one thing: which way the nose is rotating.
    const crabTarget = T.drift.slideTight * loco.driftArcMult
    const cur = clamp(
      -r.driftSide * latSpeed / Math.max(1, Math.abs(fwdSpeed)),
      -T.drift.crabCeiling, T.drift.crabCeiling,
    )
    // Work in ANGLES, not tangents, because the cap below is a rotation rate.
    const betaCur = Math.atan(cur)
    let beta = betaCur + (Math.atan(crabTarget) - betaCur)
      * (1 - Math.exp(-T.drift.slideResponse * DT))
    if (T.drift.slideYawLinked && beta > betaCur) {
      // ZERO KICK-OUT. betaCur was measured in LAST frame's body frame; the
      // nose has since rotated by yawRate * DT. So if the car keeps travelling
      // exactly where it was, this frame's slide angle is betaCur + that
      // rotation, and anything beyond it is the velocity being shoved outward
      // -- a lateral lurch off the line, which is what the tail kicking out
      // actually is. Capping the RISE here makes drift entry strictly a
      // rotation of the car about its own travel direction. The angle may
      // still CLOSE at full slideResponse: that is grip recovering under
      // counter-steer and it throws the car nowhere.
      beta = Math.min(beta, betaCur + Math.abs(r.yawRate) * DT)
    }
    const crab = Math.tan(beta)
    // newLong is GROUND speed, so split it across the crab instead of hanging
    // the lateral off the forward component. |v| stays exactly what the
    // throttle asked for however hard the car is sideways.
    const inv = 1 / Math.sqrt(1 + crab * crab)
    newFwd = newLong * inv
    newLat = -r.driftSide * Math.abs(newLong) * crab * inv
  } else if (released) {
    // Exit frame: direction rotated onto the nose, plus the tier's launch kick.
    const launched = newLong + (newLong >= 0 ? releaseKick : -releaseKick)
    newFwd = launched * releaseFwd
    newLat = Math.abs(launched) * releaseLat
  } else {
    // -----------------------------------------------------------------------
    // NOT SLIDING: the momentum is real, and the tyres have a budget.
    //
    // THE ONE LINE THAT MATTERS is that fwdNow/latNow are measured in the
    // POST-rotation basis. The old code measured them before the yaw update and
    // reassembled them after it, which is a rigid rotation of the velocity by
    // exactly the yaw change -- the nose dragged the whole momentum round with
    // it, no slip was ever generated, and `grip` decayed a residue that steady
    // cornering never produced. That is why SURFACE_GRIP and the grip stat had
    // no effect on cornering: there was nothing for them to act on.
    //
    // Measured in the new basis, turning the nose by dPsi opens a slip of
    // fwd * dPsi. The tyres pull it back with an acceleration that is linear in
    // the slip and SATURATES at the budget:
    //
    //     a = min(scrubRate * |slip|, gripAccel)
    //
    // Below saturation the car is planted -- the slip settles at yawRate /
    // scrubRate, 2-3 degrees at racing pace -- and the model behaves as it
    // always did. Above it, v * yawRate outruns what the surface can supply,
    // the slip grows every frame, and the car runs wide. That is understeer,
    // and it is the first time in this project that arriving too fast has cost
    // anything.
    // -----------------------------------------------------------------------
    const fwdNow = planarDot(r.vel, _fwd)
    const latNow = planarDot(r.vel, _right)
    const pull = Math.min(T.grip.scrubRate * Math.abs(latNow), gripAccel)
    newLat = latNow - sign(latNow) * Math.min(Math.abs(latNow), pull * DT)
    // The engine and brake act along the NOSE. dv is the change the
    // longitudinal controller asked of the GROUND speed; applying it to the
    // forward component is what makes a car that is pointing across its own
    // travel accelerate poorly, which is correct.
    newFwd = fwdNow + (newLong - longSpeed)
    // ...and the same ceiling the drift carries, for the same reason: the
    // ground speed may never exceed what the controller asked for merely
    // because the car is at an angle to it. Without this a sustained slide is a
    // slow pump -- the throttle tops up the forward component while the lateral
    // one is still there -- which is the third route this model has had to
    // manufacturing speed. It is a cap and never a boost: on a straight,
    // hypot(newFwd, 0) is exactly |newLong| and nothing happens.
    {
      const gs = Math.hypot(newFwd, newLat)
      const cap = Math.abs(newLong)
      if (gs > cap && gs > 1e-6) { const k = cap / gs; newFwd *= k; newLat *= k }
    }
  }

  planarSet(r.vel, _fwd, newFwd, _right, newLat)

  // -------------------------------------------------------------------------
  // Crosswind
  //
  // Applied AFTER the lateral block, not inside it, on purpose. Inside a drift
  // the lateral block AUTHORS the slide angle -- it rebuilds r.vel from the
  // commanded crab every frame -- so a force added before it would simply be
  // overwritten and the wind would do nothing to a drifting car, which is
  // precisely when a player most needs to feel it. Pushed in the track's own
  // lateral direction, so it stays a crosswind however the car is pointing.
  if (smp.wind !== 0) {
    const gust = 1
      + T.hazard.windGustDepth * Math.sin(ctx.raceTime * (Math.PI * 2 / T.hazard.windGustPeriod))
      + T.hazard.windRippleDepth * Math.sin(ctx.raceTime * (Math.PI * 2 / T.hazard.windRipplePeriod))
    // -----------------------------------------------------------------------
    // THE CAP, AND WHY IT HAD TO EXIST.
    //
    // Reported from play: "there are portions of the track where I try to
    // turn, but it pushes me to the right." Measured, and he was right twice
    // over.
    //
    // This push was an UNBOUNDED external acceleration. It is added here,
    // outside the friction budget, so nothing in the model ever asked whether
    // the tyres could resist it -- and on the two windy circuits they could
    // not. The Hollow Choir's Ribs author 26 m/s^2; the gust envelope
    // (windGustDepth 0.45 + windRippleDepth 0.18) multiplies the AUTHORED
    // number by 1.63, so what a player actually meets is 42.4, against a total
    // lateral budget of 36.5 for Solaire. At the Fall's turn-in, where the
    // vacuum has already taken 42% of the grip, it ran 176-308% of budget
    // depending on chassis. Above 100% there is no steering input that wins:
    // the car goes right because the arithmetic says so.
    //
    // The A/B says the same thing without any theory -- same driver, same lap,
    // wind on vs wind off, worst displacement +31.3 m on a 20 m half-width.
    // The wind alone moved the car 156% of the way to the barrier. Aetherion
    // 130%. Cryostatic, which authors 7, came in at 4% -- which is what this
    // mechanic is supposed to feel like and is the control that says the model
    // was never wrong, only the magnitude.
    //
    // WHY NO GATE CAUGHT IT. The balance harness measures win share, and
    // stepAI derives its corner speed from this same `gripAccel` -- so the AI
    // never tries to turn harder than it can and never reports that it failed
    // to. 22/26 were chosen because they moved Vector-7 from 27.2% of wins to
    // 17.0%: a BALANCE number, spent as a FEEL force. This is the exact hole
    // the Phase 1 human gate exists to cover, and it took one lap to find.
    //
    // THE FIX IS A CEILING, NOT SMALLER NUMBERS. Capping against `gripAccel`
    // -- which already folds in the surface, the vacuum, off-track and being
    // airborne -- means the wind is automatically gentle exactly where grip is
    // scarce, on every track, including ones not written yet. Lowering the
    // authored values would have fixed the Ribs and left the vacuum corner
    // broken, because there the budget collapses under a fixed wind.
    //
    // THE CLASS CONTRACT SURVIVES because the share scales with
    // `fieldForceMult`: grounded may lose 35% of its budget to the wind, hover
    // 52%, flight 63%. The flight tax is still nearly double the grounded one
    // -- that is what the wind is FOR -- but every class keeps enough budget
    // to steer with. `windGripCeiling` is the backstop that holds even if
    // someone raises the share or authors a new class.
    // -----------------------------------------------------------------------
    const share = Math.min(T.hazard.windGripShare * loco.fieldForceMult, T.hazard.windGripCeiling)
    const ceiling = gripAccel * share
    const want = smp.wind * T.hazard.windScale * gust * loco.fieldForceMult
    const accel = clamp(want, -ceiling, ceiling)
    const push = accel * DT
    r.vel.x += smp.right.x * push
    r.vel.z += smp.right.z * push
    if (_grav) r.vel.y += smp.right.y * push
    // Published for the art. The renderer must NEVER recompute this: the
    // ceiling depends on the chassis, the surface, the vacuum and whether the
    // car is airborne, and a second copy of that arithmetic in the render
    // layer is precisely how the AI's corner model drifted away from the
    // physics for the first eight passes of this project.
    r.windPush = accel
  } else {
    r.windPush = 0
  }

  // -------------------------------------------------------------------------
  // Vertical / lift
  // -------------------------------------------------------------------------
  const surfaceY = surfaceHeightAt(track, r.pos, proj.s, proj.lateral)
  if (_grav) {
    const base = track.surfacePoint(proj.s, proj.lateral)
    _anchor.x = base.x; _anchor.y = base.y; _anchor.z = base.z
  } else {
    _anchor.x = r.pos.x; _anchor.y = surfaceY; _anchor.z = r.pos.z
  }
  let targetAlt = loco.rideHeight

  // IS THERE ROAD UNDER THIS CAR AT ALL?
  //
  // The hard floor below must catch a car sinking into the deck and must NOT
  // catch one that is supposed to be falling: off the open side of Cryostatic's
  // lake or Aetherion's causeway, or through a light-bridge span that has cycled
  // out. So it applies only where there is decking -- inside the ribbon, on a
  // span that is currently solid -- and only for a penetration small enough to
  // be one frame's worth of fall. `groundSnapDistance` has been in tuning since
  // the first pass and had never been read by anything; this is what it is for.
  const overRoad = Math.abs(proj.lateral) <= smp.width * T.offTrack.edgeTolerance

  if (loco.liftCapacity > 0) {
    // ---------------------------------------------------------------------
    // THE VACUUM TAKES THE LIFT WITH THE AIR, and it is the same rule that
    // takes hover's cushion: no medium, no aerodynamic anything. A flight
    // chassis in hard vacuum is a very fast brick with attitude control.
    //
    // THIS IS THE BILL THE FLIGHT CLASS PAYS FOR THE REST OF THE MECHANIC, and
    // it is charged here rather than by softening `vacuumGripLoss`, because the
    // GDD contract is that flight GAINS MOST from a vacuum and softening the
    // grip term to fix a win share is how Aetherion's rotunda roll got broken
    // and had to be reverted. Flight still keeps the most cornering and gets
    // the same top-speed gift; what it gives up is the one thing only it has.
    //
    // Measured on The Hollow Choir at 200 races, `maxLift` clamped to zero for
    // the whole lap: Vector-7 28.7% -> 21.0% of wins, air share 34% -> 0%,
    // boost uptime 54% -> 48%. Lift is worth about eight points of win share on
    // this circuit and about a fifth of the road it is used on is the Breach,
    // so charging it there is worth roughly a point and a half -- a trim, not
    // the whole answer, and the header of hollowchoir.ts says so.
    //
    // At vacuum 0 this is `loco.maxLift` by construction (the branch is not
    // taken) and `eff.lift && r.lift > 0` exactly as before, so no track that
    // authors no vacuum can tell the difference.
    // ---------------------------------------------------------------------
    const liftCeiling = vac > 0
      ? loco.rideHeight + (loco.maxLift - loco.rideHeight) * (1 - vac)
      : loco.maxLift
    // Thrust into nothing is not spent: a chassis that cannot climb does not
    // burn its Lift budget trying. Charging for the attempt would be punishing
    // the same fact twice.
    r.liftActive = eff.lift && r.lift > 0 && liftCeiling > loco.rideHeight + 0.05
    if (r.liftActive) {
      r.lift = Math.max(0, r.lift - DT)
      targetAlt = liftCeiling
    } else {
      r.lift = Math.min(loco.liftCapacity, r.lift + loco.liftRegen * DT)
    }
  }

  const altNow = altOf(r)
  const wasAir = !r.grounded

  // ---------------------------------------------------------------------------
  // THE PHASING LIGHT-BRIDGE.
  //
  // A span whose deck is currently absent supports nothing: the road is not
  // there. `smp.bridge` is -1 on every sample of a track that authors no
  // `phase`, and bridgeSolid answers true for -1, so `deckGone` is provably
  // false for every metre of Rustfall and Cryostatic and neither of the two
  // branches below can be reached on them.
  //
  // NO CLASS IS EXEMPT, AND THAT WAS MEASURED RATHER THAN ASSUMED.
  //
  // The first cut let a flight chassis hold station over an absent span while
  // it was actively lifting, on the reasoning that passive hover is a height
  // held above a SURFACE (dampAlt drives the altitude toward rideHeight and
  // there has to be something to be a height above) while Lift is thrust, which
  // does not care. The design story was that flight buys spans out of a 4.0s
  // Lift budget.
  //
  // There is no budget. liftRegen is 0.625 s/s against a 4.0s capacity, so over
  // a 68s lap the flight class regenerates 42 seconds of Lift and can hold a
  // 39% duty cycle indefinitely; three one-second spans cost it nothing it will
  // miss. Measured over 300 races on Aetherion, the exemption was worth 5.3
  // points of win share to the only chassis that had it -- Vector-7 33.3% with
  // it against 28.0% in a run where the decks never went out at all -- and it
  // took lead retention to 42.3%, because the leader falling through a bridge
  // that a flight chassis flies over is a coin flip the leader always loses.
  //
  // So the deck supports nobody when it is not there. Any mechanic Lift can
  // answer becomes a flat flight exemption in this locomotion model, not a
  // trade, and that is a property of the model rather than of this track.
  const deckGone = !bridgeSolid(smp.bridge, ctx.raceTime)
  // Identical to the old `gapCross > 900 || (liftCapacity > 0 && liftActive)`
  // whenever deckGone is false, which is everywhere on a track with no bridges.
  //
  // The second half of the `&&` is the one that actually removed the exemption,
  // and it is not obvious. Blocking the hover branch only while the deck is out
  // let a flight chassis fall through a span and then get WINCHED BACK UP the
  // moment the deck cycled in again: its altitude branch is a spring toward
  // rideHeight and the spring is unsigned, so twelve metres below the road
  // reads to it exactly like twelve metres above. Grounded and hover cars kept
  // falling because their branch tests `altNow < T.gravity.fallThrough`. That
  // is why the first attempt at removing the exemption measured no change at
  // all: Vector-7 33.3% before, 33.7% after, on 0.28 respawns a race against
  // the field's 0.69-0.91.
  const hovering = (loco.gapCross > 900 || (loco.liftCapacity > 0 && r.liftActive))
    && !deckGone
    && !(_grav && altNow < T.gravity.fallThrough)

  if (r.ballisticTime > 0) {
    // Mid-launch: everyone is a projectile, whatever they normally ride on.
    r.ballisticTime = Math.max(0, r.ballisticTime - DT)
    r.vertVel += T.sim.gravity * DT
    addAlt(r, r.vertVel * DT)
    const alt = altOf(r)
    if (!deckGone && alt <= loco.rideHeight && r.vertVel <= 0) {
      setAlt(r, loco.rideHeight)
      r.vertVel = 0
      r.grounded = true
      r.ballisticTime = 0
      const alignErr = headingError(r, track, proj.s)
      // Thrust vectoring lets the flight class line a landing up that a
      // grounded chassis cannot, so it gets a wider clean-landing window. With
      // four ramps on the lap this is the flight class's main way of turning
      // air into speed, and it is what its identity is supposed to be good at.
      const tol = loco.cleanLandingTolerance > 0
        ? T.boost.trickLandTolerance * T.ramp.flightLandingBonus
        : T.boost.trickLandTolerance
      const clean = alignErr < tol
      if (clean && r.airTime > T.ramp.trickMinAir) {
        applyBoost(r, T.drift.tierBoost[0], T.drift.tierDuration[0], 'trick')
        r.events.push({ t: 'boost', tier: 0 })
      }
      r.events.push({ t: 'land', clean })
      r.airTime = 0
      r.trickArmed = false
    } else {
      r.grounded = false
      r.airTime += DT
    }
  } else if (hovering) {
    // Flight: driven toward the target altitude rather than by gravity.
    const wasHigh = altNow > loco.rideHeight * 2.2
    dampAlt(r, targetAlt, 0.22)
    r.vertVel = 0
    r.grounded = altNow < loco.rideHeight * 1.8
    // Descending back to hover height counts as a landing, so the flight class
    // can actually earn the Clean Landing boost the design gives it to offset
    // its weak drift charge. Without this, cleanLandingTolerance is dead config.
    if (wasHigh && !r.liftActive && altOf(r) <= loco.rideHeight * 2.2) {
      const alignErr = headingError(r, track, proj.s)
      const clean = alignErr < loco.cleanLandingTolerance
      if (clean) {
        applyBoost(r, T.drift.tierBoost[0], T.drift.tierDuration[0], 'trick')
        r.events.push({ t: 'boost', tier: 0 })
      }
      r.events.push({ t: 'land', clean })
    }
  } else if (deckGone) {
    // Nothing under the wheels. Not a jump and not a mistake -- the deck this
    // racer was standing on has cycled out from under it.
    r.vertVel += T.sim.gravity * DT
    addAlt(r, r.vertVel * DT)
    r.grounded = false
    r.airTime += DT
  } else if (altNow > loco.rideHeight + 0.22 || (_grav && altNow < T.gravity.fallThrough)) {
    r.vertVel += T.sim.gravity * DT
    addAlt(r, r.vertVel * DT)
    // THE DECK IS A HARD BARRIER. This branch integrated the fall with no floor
    // check at all, so one step could carry a car from above the road to well
    // below it: at 49 m/s -- what Aetherion's 35m descent is worth in free fall
    // -- that is 0.82m in a single frame, and the whole body is inside the road.
    // Nothing caught it, because the frame after, altitude is NEGATIVE and so no
    // longer greater than rideHeight, and the branch below is a 0.05s spring
    // that closes only ~21% of the gap per frame -- eight to ten frames of
    // driving along underneath the surface. Reported from play as "at high
    // speeds and drop sections the vehicle phases into the floor of the track".
    //
    // A landing is a landing whether the car came down to the road or the road
    // came up to the car, so this fires the same events the ballistic branch
    // does rather than silently teleporting the car back out.
    const under = loco.rideHeight - altOf(r)
    if (overRoad && !deckGone && under > 0 && under < T.sim.groundSnapDistance && r.vertVel <= 0) {
      setAlt(r, loco.rideHeight)
      r.vertVel = 0
      r.grounded = true
      const alignErr = headingError(r, track, proj.s)
      const clean = alignErr < (loco.cleanLandingTolerance || T.boost.trickLandTolerance)
      if (r.trickArmed && r.airTime > T.boost.trickMinAir && alignErr < T.boost.trickLandTolerance) {
        const tier = T.boost.trickTier
        applyBoost(r, T.drift.tierBoost[tier], T.drift.tierDuration[tier], 'trick')
        r.events.push({ t: 'boost', tier })
      }
      r.events.push({ t: 'land', clean })
      r.airTime = 0
      r.trickArmed = false
    } else {
      r.grounded = false
      r.airTime += DT
      if (eff.drift && r.airTime > 0.06) r.trickArmed = true
    }
  } else {
    // Snap to the surface with a soft spring so bumps read as suspension.
    dampAlt(r, targetAlt, 0.05)
    // ...but the spring may only ease the car DOWN onto the road, never leave it
    // sitting inside it. Anything that puts a racer under the deck -- a fall the
    // branch above has just floored, a racer-vs-racer shove, a surface that
    // steps up between two samples -- would otherwise take eight to ten frames
    // to ease back out, which is exactly long enough to see through the road.
    const under = loco.rideHeight - altOf(r)
    if (overRoad && !deckGone && under > 0 && under < T.sim.groundSnapDistance) setAlt(r, loco.rideHeight)
    r.vertVel = 0
    r.grounded = true
    if (wasAir) {
      const alignErr = headingError(r, track, proj.s)
      const clean = alignErr < (loco.cleanLandingTolerance || T.boost.trickLandTolerance)
      if (r.trickArmed && r.airTime > T.boost.trickMinAir && alignErr < T.boost.trickLandTolerance) {
        const tier = T.boost.trickTier
        applyBoost(r, T.drift.tierBoost[tier], T.drift.tierDuration[tier], 'trick')
        r.events.push({ t: 'boost', tier })
      } else if (loco.cleanLandingTolerance > 0 && clean && r.airTime > 0.30) {
        applyBoost(r, T.drift.tierBoost[0], T.drift.tierDuration[0], 'trick')
        r.events.push({ t: 'boost', tier: 0 })
      }
      r.events.push({ t: 'land', clean })
      r.airTime = 0
      r.trickArmed = false
    }
  }
  r.altitude = altOf(r)

  // -------------------------------------------------------------------------
  // Integrate horizontally
  //
  // `r.vel` lives in the plane the car drives in, which on a gravity track is
  // not the world XZ plane, so the up-axis component is real motion and has to
  // be integrated too. Flat, vel.y is identically zero.
  // -------------------------------------------------------------------------
  r.pos.x += r.vel.x * DT
  r.pos.z += r.vel.z * DT
  if (_grav) r.pos.y += r.vel.y * DT

  // -------------------------------------------------------------------------
  // Walls / edges
  // -------------------------------------------------------------------------
  const after = track.project(r.pos, proj.s)
  // Inset by the body half-width so the chassis stops at the barrier rather
  // than burying half of itself in it.
  // Inset by the body's real reach along the barrier normal, not by half its
  // width -- see orientedInset. The normal here is the sample's lateral axis;
  // its sign does not matter because the projection takes absolute values.
  const wr = after.sample.right
  const hw = Math.max(1, after.sample.width - orientedInset(r, wr.x, wr.y, wr.z))
  const overshoot = Math.abs(after.lateral) - hw

  const afterOpen = after.sample.open || (after.sample.fragile && ctx.iceCracked)
  if (overshoot > 0 && !afterOpen) {
    r.wallTime += DT
  } else {
    r.wallTime = 0
  }
  if (overshoot > 0 && !afterOpen) {
    const nrm = sign(after.lateral)
    if (_grav) {
      // Slide back in along the surface's own lateral axis. Rewriting x and z
      // from the centreline point would also drag the car down to deck height,
      // which on a wall-ride means teleporting it off the wall.
      const push = nrm * hw - after.lateral
      r.pos.x += after.sample.right.x * push
      r.pos.y += after.sample.right.y * push
      r.pos.z += after.sample.right.z * push
    } else {
      const corrected = track.surfacePoint(after.s, nrm * hw)
      r.pos.x = corrected.x
      r.pos.z = corrected.z
    }

    const wallNormalX = -after.sample.right.x * nrm
    const wallNormalY = -after.sample.right.y * nrm
    const wallNormalZ = -after.sample.right.z * nrm
    const into = _grav
      ? -(r.vel.x * wallNormalX + r.vel.y * wallNormalY + r.vel.z * wallNormalZ)
      : r.vel.x * -wallNormalX + r.vel.z * -wallNormalZ

    if (into > 0) {
      const spd = planarSpeed(r.vel)
      // HOW HARD DID THE CAR ACTUALLY ARRIVE?
      //
      // `into` is the velocity component along the wall normal, and in a drift
      // that is the SLIDE, not an impact: a crabbed car's velocity points 30
      // degrees off its nose by construction, so a car sliding round the outside
      // of a corner reads as arriving at the barrier at 30 m/s while its actual
      // lateral offset is barely moving. Charging the crash tax on `into` meant
      // brushing the outside wall mid-drift cost 61.4 -> 34.1 m/s IN ONE FRAME
      // and cancelled the drift, after which the car sat at high slip losing a
      // further 36 m/s^2 with the throttle pinned, all the way to a standstill.
      // That is the reported "during the drift my vehicle slows down while I am
      // still on the accelerator", and touching the outside of a corner is
      // exactly what a drift is FOR.
      //
      // Severity is now the rate the car is actually closing on the barrier
      // line, in the track's own frame -- which is zero for a car holding a line
      // round a corner and full impact speed for one driving into a wall.
      // `into` still governs the RESPONSE (that much velocity has to go, or the
      // car penetrates); it no longer governs the PRICE.
      const closing = Math.max(0, (Math.abs(after.lateral) - Math.abs(r.lateral)) / DT)
      const severity = Math.min(into, closing)
      const angle = Math.abs(Math.asin(clamp(severity / Math.max(1, spd), -1, 1)))
      if (after.sample.bounce) {
        // A bounce wall CONVERTS into-wall momentum into along-wall momentum.
        // It must never manufacture speed. Two ways to get that wrong, both of
        // which have shipped here:
        //   1. scaling the existing tangential speed -- a scrape then multiplies
        //      the whole velocity every frame of contact;
        //   2. adding a tangential push ON TOP of a full reflection -- the
        //      reflection already cancels the into component, so the push is
        //      free energy, and a racer holding a line into a bounce wall gains
        //      into * bounceWallForward every single frame. That pumped racers
        //      to the hard SPEED_CEILING (120 m/s against a ~108 m/s design
        //      maximum) on every bounce-wall section of Rustfall.
        // Redirect in the (tangent, normal) frame, then cap at the speed
        // carried in: a square-on hit can convert its whole into component to
        // tangential travel and no more, and a graze -- where into is small --
        // is left essentially untouched.
        const tan = after.sample.tangent
        const along = planarDot(r.vel, tan)
        const dir = along >= 0 ? 1 : -1
        const newAlong = along + into * T.collision.bounceWallForward * dir
        const outward = into * T.collision.bounceWallRestitution
        let bvx = tan.x * newAlong + wallNormalX * outward
        let bvz = tan.z * newAlong + wallNormalZ * outward
        let bvy = _grav ? tan.y * newAlong + wallNormalY * outward : 0
        const bsp = _grav ? Math.hypot(bvx, bvy, bvz) : Math.hypot(bvx, bvz)
        if (bsp > spd) { const k = spd / bsp; bvx *= k; bvz *= k; bvy *= k }
        r.vel.x = bvx
        r.vel.z = bvz
        if (_grav) r.vel.y = bvy
        r.events.push({ t: 'wall', force: severity * 0.5 })
      } else {
        // A barrier takes away the speed you drove INTO it. It does not reach
        // round and take the speed you were carrying ALONG it.
        //
        // The old form multiplied the WHOLE velocity by (1 - scrub) on every
        // contact frame, so a car carving into the outside wall mid-drift lost
        // 52.3 -> 13.5 m/s on the first frame and then bled exponentially to a
        // standstill -- on the track, throttle held, still trying to drive.
        // That is what "the drift slows me down to zero" was.
        //
        // Now: the normal component is absorbed and partly returned, the
        // along-wall component pays a bite PROPORTIONAL TO HOW HARD THE CAR
        // ACTUALLY WENT IN, and sustained scraping costs a per-second friction
        // rather than a per-frame fraction. A real crash still hurts -- into is
        // large, so the bite is large. A scrape costs a scrape.
        const tan = after.sample.tangent
        const along = planarDot(r.vel, tan)
        const scrub = angle < T.collision.grazeAngle
          ? T.collision.grazeScrub
          : angle > T.collision.hardAngle
            ? T.collision.hardScrub
            : lerp(T.collision.grazeScrub, T.collision.hardScrub,
                (angle - T.collision.grazeAngle) / (T.collision.hardAngle - T.collision.grazeAngle))
        // AN IMPACT IS PAID ONCE. `into` does not decay while a drifting car is
        // pinned against a barrier -- the arc keeps rotating the nose in and the
        // velocity is rebuilt from the nose every frame -- so a bite priced per
        // frame is charged sixty times a second for one collision. Measured on a
        // constant-radius ring with the throttle pinned and full lock held: a
        // car went 61.4 m/s to 13.3 m/s in ONE SECOND of contact, and to 7.0 on
        // ice. That is what "during the drift my vehicle slows down while I am
        // still on the accelerator" is, and it is the same class of bug as the
        // per-frame velocity scrub fixed in the ninth pass -- fixed there for
        // the along-wall component, and left here in the impact term.
        //
        // The bite now fades over the first fraction of a second of contact.
        // Hit a wall and you pay for it; lean on one and you pay the per-second
        // friction below, which is what a scrape costs.
        const contactFade = Math.max(0, 1 - r.wallTime / T.collision.impactFadeTime)
        const impactShare = clamp01(severity / T.collision.hardImpactSpeed) * contactFade
        const dir = along >= 0 ? 1 : -1
        // Convert part of the into-wall speed into travel ALONG the wall
        // instead of deleting it, then charge the impact against the total.
        const redirected = along + into * T.collision.wallRedirect * dir
        const newAlong = redirected
          * (1 - scrub * impactShare)
          * Math.max(0, 1 - T.collision.wallFriction * DT)
        const outward = into * T.collision.restitution
        let wvx = tan.x * newAlong + wallNormalX * outward
        let wvz = tan.z * newAlong + wallNormalZ * outward
        let wvy = _grav ? tan.y * newAlong + wallNormalY * outward : 0
        // Redirect, never pump -- the same cap bounce walls carry, for the same
        // reason: an additive tangential term is free energy without it.
        const wsp = _grav ? Math.hypot(wvx, wvy, wvz) : Math.hypot(wvx, wvz)
        if (wsp > spd) { const k = spd / wsp; wvx *= k; wvz *= k; wvy *= k }
        r.vel.x = wvx
        r.vel.z = wvz
        if (_grav) r.vel.y = wvy

        // Deflect: turn the nose along the barrier instead of letting the car
        // sit against it driving in. Aligned to the direction of TRAVEL, so it
        // never spins a reversing player round. See T.collision.wallDeflect.
        {
          const slow01 = 1 - clamp01(spd / T.collision.deflectFullSpeed)
          const rate = T.collision.wallDeflect * (0.2 + 0.8 * slow01) * impactShare
          const step = rate * DT
          if (_grav) {
            // Signed angle from the nose to the barrier direction, measured in
            // the surface plane -- the only plane in which "along the wall" is
            // a heading at all when the wall is on a wall.
            const bx = tan.x * dir, by = tan.y * dir, bz = tan.z * dir
            const dot = clamp(r.fwd.x * bx + r.fwd.y * by + r.fwd.z * bz, -1, 1)
            const cx = r.fwd.y * bz - r.fwd.z * by
            const cy = r.fwd.z * bx - r.fwd.x * bz
            const cz = r.fwd.x * by - r.fwd.y * bx
            const err = Math.atan2(cx * r.up.x + cy * r.up.y + cz * r.up.z, dot)
            vrotAxis(r.fwd, r.up, clamp(err, -step, step))
            r.yaw = Math.atan2(r.fwd.x, r.fwd.z)
          } else {
            const wallYaw = Math.atan2(tan.x * dir, tan.z * dir)
            const err = angleDelta(r.yaw, wallYaw)
            r.yaw += clamp(err, -step, step)
            if (r.yaw > Math.PI) r.yaw -= Math.PI * 2
            if (r.yaw < -Math.PI) r.yaw += Math.PI * 2
          }
        }
        if (severity > T.drift.collisionCancelSpeed) {
          r.driftSide = 0; r.driftCharge = 0; r.driftTier = -1; r.chainStacks = 0
        }
        r.events.push({ t: 'wall', force: severity })
      }
    }
  }

  // -------------------------------------------------------------------------
  // Hard velocity ceiling. A safety net, not a gameplay mechanic: the design
  // maximum is 68 m/s top speed x 1.52 max boost x 1.05 charges = ~108 m/s.
  // Anything above the ceiling is a bug, and clamping keeps it from cascading
  // into the collision and projection code as a NaN or a tunnelled racer.
  // -------------------------------------------------------------------------
  {
    const sp = planarSpeed(r.vel)
    if (sp > SPEED_CEILING) {
      const k = SPEED_CEILING / sp
      r.vel.x *= k; r.vel.z *= k
      if (_grav) r.vel.y *= k
    }
    if (!Number.isFinite(r.pos.x) || !Number.isFinite(r.pos.y) || !Number.isFinite(r.pos.z)) {
      r.respawnTime = T.offTrack.respawnDuration
      r.vel.x = 0; r.vel.y = 0; r.vel.z = 0
      const safe = track.surfacePoint(r.splineS, 0)
      r.pos.x = safe.x; r.pos.y = safe.y + 1; r.pos.z = safe.z
    }
  }

  // -------------------------------------------------------------------------
  // Booster ramps
  // -------------------------------------------------------------------------
  if (after.sample.ramp > 0 && r.grounded && Math.abs(after.lateral) < hw && r.rampCooldown <= 0) {
    const power = after.sample.ramp
    r.vertVel = power
    if (_grav) {
      r.pos.x += r.up.x * 0.35; r.pos.y += r.up.y * 0.35; r.pos.z += r.up.z * 0.35
    } else {
      r.pos.y += 0.35
    }
    r.grounded = false
    r.airTime = 0
    r.trickArmed = false
    r.rampCooldown = 0.6
    // Hover and flight chassis drive their altitude toward a target height; if
    // that keeps running through a launch it cancels the ramp entirely and they
    // never leave the deck. Force a ballistic arc for the length of the flight.
    r.ballisticTime = (2 * power) / Math.abs(T.sim.gravity) + 0.25
    applyBoost(r, T.ramp.launchBoost, T.ramp.launchBoostTime, 'pad')
    r.events.push({ t: 'ramp', power })
  }
  if (r.rampCooldown > 0) r.rampCooldown = Math.max(0, r.rampCooldown - DT)

  // -------------------------------------------------------------------------
  // Boost pads
  // -------------------------------------------------------------------------
  if (after.sample.boost && r.altitude < 3.0 && Math.abs(after.lateral) < hw) {
    applyBoost(r, T.boost.padMag, T.boost.padDuration, 'pad', true)
  }

  // -------------------------------------------------------------------------
  // Off-track and falling
  // -------------------------------------------------------------------------
  const finalProj = track.project(r.pos, after.s)
  const finalEdge = Math.abs(finalProj.lateral) / finalProj.sample.width
  // "Fell out of the world" is a distance BELOW THE ROAD, which on a flat track
  // is a world Y and on a gravity track is a depth along the local up. A
  // wall-ride sits at y = 40 and would never trip a world-Y test; a car that
  // slid off its underside needs to.
  // An OPEN span on a gravity track has nothing under it -- that is what `open`
  // means -- so a racer far enough below its deck is already gone, and waiting
  // for the generic 45m test would first carry it out from under the hole it
  // fell through. See T.hazard.voidFallDepth. Flat tracks keep the generic test
  // unchanged: Rustfall's chasm floor is real road a racer can drive along.
  const voidFall = _grav
    && finalProj.sample.open
    && finalProj.height < -T.hazard.voidFallDepth
  const fell = voidFall || (_grav
    ? finalProj.height < T.offTrack.fallY - 6
    : r.pos.y < T.offTrack.fallY)
  if (finalEdge > T.offTrack.edgeTolerance || fell) {
    r.offTrackTime += DT
    if (r.offTrackTime > T.offTrack.respawnAfter || fell) {
      r.respawnTime = T.offTrack.respawnDuration
      r.offTrackTime = 0
    }
  } else {
    r.offTrackTime = 0
  }

  // -------------------------------------------------------------------------
  // Wrong-way recovery
  // -------------------------------------------------------------------------
  // Last resort: a racer that has come to rest facing back down the track gets
  // eased around.
  //
  // It is gated on the CONTROLS being idle, not on speed alone. wrongWayRate is
  // 2.6 rad/s against a roster-maximum steering authority of 2.37 (Filament, at
  // a standstill, before the speed falloff), so once this block is armed it
  // out-rotates every chassis at every speed. Measured with a speed-only gate:
  //   - a player holding full lock could not hold ANY heading more than 100
  //     degrees off the racing line on any of the five chassis -- the block
  //     pinned all of them at wrongWayAngle;
  //   - a player who had spun round and was backing down the track was rotated
  //     81 degrees in the first 0.75s. A reverse always STARTS from a
  //     standstill, so "gated on speed so it can never fight a player who is
  //     deliberately reversing at pace" was never true: the reverse does not
  //     cross wrongWaySpeed until 2.0s, by which time the rotation is done.
  // Costs the AI nothing -- an 8-car Rustfall race records the same worst
  // heading error (1.142 rad) with this block on and off, because the spin
  // align in the steering section is what actually keeps the field pointing
  // the right way.
  const handsOff = Math.abs(eff.steer) < T.offTrack.wrongWayStickIdle && eff.brake <= 0
  if (handsOff && r.spinTime <= 0 && r.stunTime <= 0 && r.respawnTime <= 0 && r.driftSide === 0) {
    const speedNow = planarSpeed(r.vel)
    if (speedNow < T.offTrack.wrongWaySpeed) {
      const want = track.yawAt(finalProj.s)
      const err = _grav ? signedHeadingError(r, finalProj.sample.tangent) : angleDelta(r.yaw, want)
      if (Math.abs(err) > T.offTrack.wrongWayAngle) {
        const step = T.offTrack.wrongWayRate * DT
        if (_grav) {
          vrotAxis(r.fwd, r.up, clamp(err, -step, step))
          r.yaw = Math.atan2(r.fwd.x, r.fwd.z)
        } else {
          r.yaw += clamp(err, -step, step)
          if (r.yaw > Math.PI) r.yaw -= Math.PI * 2
          if (r.yaw < -Math.PI) r.yaw += Math.PI * 2
        }
      }
    }
  }

  r.driftEntry = false

  // -------------------------------------------------------------------------
  // Progress
  // -------------------------------------------------------------------------
  const ds = track.deltaS(r.splineS, finalProj.s)
  if (Math.abs(ds) < track.length * 0.25) {
    r.totalS += ds
  }
  r.splineS = finalProj.s
  r.lateral = finalProj.lateral
}

/**
 * The boost stacking rule: only the largest multiplicative bonus applies.
 * A weaker source extends the existing duration instead of compounding.
 */
export function applyBoost(
  r: RacerState,
  mag: number,
  duration: number,
  source: RacerState['boostSource'],
  /**
   * True for a SUSTAINED source -- a boost strip, which stepVehicle calls here
   * on every frame a wheel is on it.
   *
   * `weakerExtend` below is written for a DISCRETE grant: a weaker boost landing
   * on top of a stronger one still does something, it lengthens the one you
   * have. Applied 65 times as a car crosses a 50m strip, that same branch is a
   * pump. Measured before this flag existed: peak banked boostTime reached
   * 58s on Rustfall, 209s on Cryostatic -- against an authored padDuration of
   * 1.20s -- and racers held more than five seconds of boost for 57-78% of the
   * race. `padDuration` was dead config, and the drift-charge boost, which is
   * the whole skill expression of the game, was competing with a pad boost that
   * effectively never ran out.
   *
   * A sustained source now guarantees you have AT LEAST its magnitude for AT
   * LEAST its duration, and never stacks. Crossing a strip is worth `duration`,
   * not `duration` times the number of frames it took to cross.
   */
  continuous = false,
): void {
  if (continuous) {
    if (mag > r.boostMag) { r.boostMag = mag; r.boostSource = source }
    r.boostTime = Math.max(r.boostTime, duration)
    return
  }
  if (mag > r.boostMag) {
    r.boostMag = mag
    r.boostTime = Math.max(r.boostTime, duration)
    r.boostSource = source
  } else if (r.boostTime > 0) {
    r.boostTime += T.boost.weakerExtend
  } else {
    r.boostMag = mag
    r.boostTime = duration
    r.boostSource = source
  }
}

/** Surface height under a world point, following the banked track plane. */
export function surfaceHeightAt(track: Track, p: Vec3, hintS: number, lateral: number): number {
  const smp = track.at(hintS)
  const c = track.posAt(hintS)
  // Plane through the centreline point with the banked normal.
  const lat = clamp(lateral, -smp.width * 1.6, smp.width * 1.6)
  return c.y + smp.right.y * lat + (p.x * 0 /* keep p referenced for future terrain */)
}

/**
 * How far the racer's CENTRE must stay inside the wall so the BODY does not
 * poke through it. Clamping the centre to the wall line leaves half the car
 * sticking out, which is what reads on screen as clipping through the barrier.
 */
export function bodyInset(chassisId: string): number {
  const he = (CHASSIS_BY_ID[chassisId] ?? CHASSIS_BY_ID['solaire']).halfExtents
  return he.x + 0.12
}

/**
 * The same thing, but for a car that is not pointing straight down the road.
 *
 * `bodyInset` above answers with half the car's WIDTH, which is only the right
 * answer when the nose is aligned with the barrier. A car is a box, and a box
 * turned 32 degrees -- which is the drift's own sustained slide angle -- presents
 * a corner, not a flank: for the roster's half-extents that is 2.20m along the
 * wall normal against the 1.22m the flat inset allows. So the clamp held the
 * centre 1.22m off the barrier while the outside FRONT CORNER stood a metre
 * past it, on every drift, against every wall. Reported from play as vehicles
 * phasing through the railings, and it is the same geometry that made them
 * phase through the walls in the sixth pass -- measured there against props,
 * fixed there for props, and never applied to the car itself.
 *
 * Projecting the box onto the wall normal is exact and costs three dot products:
 * for half-extents (hx, hy, hz) and a unit normal n,
 *   extent = hx |right . n| + hy |up . n| + hz |fwd . n|
 * which reduces to `hx + 0.12` exactly when the nose is square to the barrier.
 */
export function orientedInset(r: RacerState, nx: number, ny: number, nz: number): number {
  const he = (CHASSIS_BY_ID[r.chassisId] ?? CHASSIS_BY_ID['solaire']).halfExtents
  const fx = r.fwd.x, fy = r.fwd.y, fz = r.fwd.z
  const ux = r.up.x, uy = r.up.y, uz = r.up.z
  // right = fwd x up, the same handedness the rest of this file uses.
  const rx = fy * uz - fz * uy
  const ry = fz * ux - fx * uz
  const rz = fx * uy - fy * ux
  return he.x * Math.abs(rx * nx + ry * ny + rz * nz)
    + he.y * Math.abs(ux * nx + uy * ny + uz * nz)
    + he.z * Math.abs(fx * nx + fy * ny + fz * nz)
    + 0.12
}

/**
 * Push a racer back inside the track walls. Must be re-applied by ANY code that
 * moves a racer after stepVehicle has run — racer-vs-racer collision resolution
 * in particular, which otherwise shoves cars straight through the barrier with
 * nothing to check them until the next frame.
 * Returns true if it had to correct.
 */
export function clampToTrack(r: RacerState, track: Track): boolean {
  if (r.respawnTime > 0) return false
  const proj = track.project(r.pos, r.splineS)
  if (proj.sample.open) return false
  const pr = proj.sample.right
  const hw = Math.max(1, proj.sample.width - orientedInset(r, pr.x, pr.y, pr.z))
  const over = Math.abs(proj.lateral) - hw
  if (over <= 0) return false

  const nrm = proj.lateral >= 0 ? 1 : -1
  if (track.hasGravity) {
    // Slide in along the surface's lateral axis so the racer keeps whatever
    // height it had. Snapping to the centreline point would drop a car that is
    // mid-wall-ride onto the deck below.
    const push = nrm * hw - proj.lateral
    r.pos.x += proj.sample.right.x * push
    r.pos.y += proj.sample.right.y * push
    r.pos.z += proj.sample.right.z * push
  } else {
    const corrected = track.surfacePoint(proj.s, nrm * hw)
    r.pos.x = corrected.x
    r.pos.z = corrected.z
  }
  r.lateral = nrm * hw

  // Kill any remaining velocity INTO the wall so the racer does not simply
  // push straight back out on the next frame.
  const wnX = -proj.sample.right.x * nrm
  const wnY = -proj.sample.right.y * nrm
  const wnZ = -proj.sample.right.z * nrm
  const into = track.hasGravity
    ? -(r.vel.x * wnX + r.vel.y * wnY + r.vel.z * wnZ)
    : r.vel.x * -wnX + r.vel.z * -wnZ
  if (into > 0) {
    r.vel.x += wnX * into
    r.vel.z += wnZ * into
    if (track.hasGravity) r.vel.y += wnY * into
  }
  return true
}

export function chassisHalfExtents(chassisId: string): Vec3 {
  return (CHASSIS_BY_ID[chassisId] ?? CHASSIS_BY_ID['solaire']).halfExtents
}
