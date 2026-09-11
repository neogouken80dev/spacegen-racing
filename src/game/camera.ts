import * as THREE from 'three'
import type { RacerState } from '../sim/types'
import type { Track } from '../sim/track'
import { TUNING as T } from '../content/tuning'
import { angleDelta, clamp, clamp01, damp } from '../sim/math'
import { signedAngleAround } from '../sim/vehicle'

const C = T.camera
const CER = T.ceremony
const DEG = Math.PI / 180

/**
 * ===========================================================================
 * THE PLAYER'S CAMERA, as six numbers they own.
 *
 * Everything in TUNING.camera is an AUTHORED default -- what the rig does for
 * someone who never opens the menu. These six are the same rig with the dials
 * brought out to the front panel, because "further back" and "less of that"
 * are things only the person holding the controller can settle.
 *
 * They are per-INSTANCE, not global. The tuning table is read once, at
 * construction, to seed them; after that every read in this file goes through
 * `this.rig`. That is what lets a probe replay one lap through six different
 * camera configurations in the same process, and what stops a settings change
 * leaking into the garage turntable or the finish shot.
 * ===========================================================================
 */
export interface CameraSettings {
  /** Metres behind the car, along the ground. */
  distance: number
  /** Metres above it, along the camera's own up. */
  height: number
  /**
   * THE ANGLE OF THE CAMERA ON THE CAR, in degrees below the view axis.
   *
   * With the screen anchor running, where the camera POINTS is solved rather
   * than authored: the aim is whatever puts the car on its mark. So the
   * honest way to expose "angle" is to move the mark, and state it as the
   * angle it actually is -- how far below the centre of the frame the car
   * sits. Small angle: the camera looks nearly straight at the car and the
   * road ahead fills the frame. Large: it looks down over the car's roof.
   *
   * Measured against `fovRest` rather than the live FOV on purpose, so the
   * car's mark does not walk up the screen when the lens opens under boost.
   */
  angle: number
  /** Multiplier on impact shake amplitude. 0 removes it entirely. */
  shake: number
  /**
   * HOW LOOSELY THE RIG FOLLOWS, 0 welded to 1 fully trailing.
   *
   * One dial over three constants -- the corner trail, the position damping
   * and the yaw damping -- because they are not independently meaningful: a
   * rig with a tight trail and loose yaw does not read as "half way", it
   * reads as broken. The map is piecewise through 0.30, which reproduces the
   * authored feel EXACTLY, so a player who never touches this gets the rig
   * that was signed off, and moving it is a departure in a known direction.
   */
  tracking: number
  /**
   * Multiplier on the vertigo shot -- the FOV punch, the camera pull-in and
   * the composite's warp, which all ride the same impulse. 0 is a rig that
   * never moves on a boost.
   */
  boost: number
}

/** The resolved constants a settings object stands for. */
interface Rig {
  distance: number
  height: number
  anchorY: number
  trailDamp: number
  posHalfLife: number
  yawHalfLife: number
  shake: number
  boost: number
}

/**
 * The angle the AUTHORED anchor works out to, so the default of the exposed
 * control is the shipped frame rather than a number chosen to look tidy.
 * anchorY 0.812 against a 62-degree lens is 20.6 degrees below the axis.
 */
export function anchorYToAngle(anchorY: number): number {
  return Math.atan((anchorY - 0.5) * 2 * Math.tan(C.fovRest * 0.5 * DEG)) / DEG
}
export function angleToAnchorY(angleDeg: number): number {
  return 0.5 + 0.5 * Math.tan(angleDeg * DEG) / Math.tan(C.fovRest * 0.5 * DEG)
}

/**
 * ON THE GRID, DELIBERATELY.
 *
 * Every default below is reachable by stepping: the control moves in whole
 * units of CAMERA_LIMITS[k][2] from the minimum, and each of these sits on one
 * of those stops. A default that is NOT on the grid is a trap -- nudge it once
 * and you can never get back to the frame the game shipped with.
 *
 * The angle is the only one that needed rounding for this. The authored
 * anchorY of 0.812 works out to 20.55 degrees below the axis; the control
 * offers 20.5. On the 944px reference frame the difference moves the car by
 * 0.7 of a pixel, which is an order of magnitude finer than the bounding box
 * the 0.812 was measured from in the first place.
 */
export const DEFAULT_CAMERA_SETTINGS: Readonly<CameraSettings> = Object.freeze({
  distance: C.distance,
  height: C.height,
  angle: Math.round(anchorYToAngle(C.anchorY) * 2) / 2,
  shake: 1,
  tracking: 0.30,
  boost: 1,
})

/** The bounds the UI offers and any stored value is clamped into. */
export const CAMERA_LIMITS: Readonly<Record<keyof CameraSettings, [number, number, number]>> =
  Object.freeze({
    // [min, max, step]
    distance: [6, 18, 0.5],
    height: [1.2, 9, 0.2],
    // THE ANGLE CEILING IS NOT A TASTE JUDGEMENT, IT IS THE FRAME EDGE.
    // The mark is measured against fovRest (62 deg vertical), so an angle of
    // 31 puts the car exactly on the bottom edge and anything past it puts the
    // car OFF SCREEN -- the solve dutifully aims at a point nobody can see.
    // 28 leaves the car at 94% of the way down, which is as low as is drivable.
    angle: [7, 28, 0.5],
    shake: [0, 2, 0.1],
    tracking: [0, 1, 0.05],
    boost: [0, 1.5, 0.1],
  })

const clampSetting = (k: keyof CameraSettings, v: number): number => {
  const [lo, hi] = CAMERA_LIMITS[k]
  return !Number.isFinite(v) ? DEFAULT_CAMERA_SETTINGS[k] : clamp(v, lo, hi)
}

/** Clamp and fill an untrusted (stored, or hand-edited) settings object. */
export function normaliseCameraSettings(s: Partial<CameraSettings> | null | undefined): CameraSettings {
  const out = { ...DEFAULT_CAMERA_SETTINGS } as CameraSettings
  if (!s) return out
  for (const k of Object.keys(out) as (keyof CameraSettings)[]) {
    const v = s[k]
    if (typeof v === 'number') out[k] = clampSetting(k, v)
  }
  return out
}

/**
 * Settings -> the constants the rig runs on.
 *
 * The tracking map is the only interesting part. It is a LERP THROUGH THE
 * AUTHORED POINT rather than a straight line from welded to loose: at 0.30 it
 * returns exactly `trailDamp 0.72, posHalfLife 0.12, yawHalfLife 0.20`, which
 * is what shipped. A straight line would have put the default somewhere
 * between two invented endpoints and quietly changed the game for every player
 * who never opens the menu.
 */
/**
 * THE LOOSE END OF THE TRACKING DIAL, and why it is not "no damping at all".
 *
 * The obvious endpoint is trailDamp 0 with long half-lives -- the rig before
 * the corner trail was ever reined in. Measured on a clean 120m-radius corner
 * at 60 m/s (tools/_circ.ts), that endpoint is not merely floaty, it is
 * BROKEN: the camera swings past the car's own nose and the reported swing
 * folds back through 180 degrees, so the dial stops being monotonic -- 1.00
 * read calmer than 0.75.
 *
 * These three are the loosest endpoint that stays monotonic over the whole
 * range. Steady-state swing off dead astern, same corner:
 *
 *   tracking  0.00   2.04 deg     (welded)
 *             0.15   5.03
 *             0.30   7.91         <- the authored feel, exactly
 *             0.50  10.24
 *             0.75  12.72
 *             1.00  13.95
 *
 * and the lens now agrees with the rig to within 0.2 deg at every stop, which
 * it did not before the anchor learned to re-seed -- see apply().
 */
/** Newton passes in the screen-anchor solve. See apply() for the measurements. */
const ANCHOR_PASSES = 4

const LOOSE_TRAIL = 0.20
const LOOSE_POS = 0.30
const LOOSE_YAW = 0.42

function resolveRig(s: CameraSettings): Rig {
  const t = clamp01(s.tracking)
  const MID = 0.30
  // welded <- authored -> loose, on each of the three constants
  const lerp3 = (weld: number, auth: number, loose: number): number => (
    t <= MID
      ? weld + (auth - weld) * (t / MID)
      : auth + (loose - auth) * ((t - MID) / (1 - MID))
  )
  return {
    distance: s.distance,
    height: s.height,
    anchorY: angleToAnchorY(s.angle),
    // 1 is rigidly behind the car; 0 is the full corner swing.
    trailDamp: lerp3(1, C.trailDamp, LOOSE_TRAIL),
    posHalfLife: lerp3(0.035, C.posHalfLife, LOOSE_POS),
    yawHalfLife: lerp3(0.055, C.yawHalfLife, LOOSE_YAW),
    shake: s.shake,
    boost: s.boost,
  }
}

/**
 * Chase camera. FOV is the primary speed-sensation lever and costs nothing,
 * so it does most of the work here: 62 degrees at rest widening to 86 under
 * full boost, plus positional lag so the vehicle leads the frame in corners.
 */
export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera
  private pos = new THREE.Vector3()
  private look = new THREE.Vector3()
  private yaw = 0
  private aspect: number = C.refAspect
  private fov: number = C.fovRest
  private roll = 0
  private driftYaw = 0
  private shake = 0
  /** The player's six numbers, and the constants they resolve to. */
  private settingsValue: CameraSettings = { ...DEFAULT_CAMERA_SETTINGS }
  private rig: Rig = resolveRig(DEFAULT_CAMERA_SETTINGS)
  private shakeSeed = Math.random() * 1000
  /** Drift-release dolly-zoom impulse, 0-1, decaying. */
  private dolly = 0
  /**
   * `boostMag` as of last frame, so a boost can be picked up from its RISE.
   * See TUNING.camera.boostDollyGain: most boost sources never push an event
   * the camera could read, but every one of them steps this value up.
   */
  private prevBoostMag = 0
  /** Seconds left of the refractory period between boost vertigo punches. */
  private boostDollyLock = 0
  /**
   * The FOV the rig would be running with NO vertigo shot -- the speed and
   * boost terms alone, damped exactly as `fov` is. The dolly compensation is
   * measured against this, never against `fovRest`: the shot's job is to stop
   * the car changing size because of the SHOT, not to undo the speed and boost
   * FOV as well. Referencing fovRest made the pull-in try to cancel all of it,
   * which then had to unwind, and the car swelled for two seconds after the
   * punch was over.
   */
  private fovBase: number = C.fovRest

  private readonly _desired = new THREE.Vector3()
  private readonly _target = new THREE.Vector3()
  /** Screen-anchor scratch: the solved aim point and the camera's own basis. */
  private readonly _aim = new THREE.Vector3()
  private readonly _bR = new THREE.Vector3()
  private readonly _bU = new THREE.Vector3()
  private readonly _bF = new THREE.Vector3()
  private readonly _ndc = new THREE.Vector3()
  /**
   * THE CAMERA'S OWN UP, damped toward the car's.
   *
   * On a flat track this is world +Y forever and every line below that reads it
   * is doing exactly what `(0, 1, 0)` did before. On a gravity track it is what
   * turns a wall-ride into the CAR climbing rather than the WORLD falling over:
   * the rig's height offset, its "never sink below the vehicle" floor and the
   * lens's own up-vector are all taken along this axis instead of along +Y.
   *
   * It LAGS the car on purpose -- see TUNING.gravity.cameraUpHalfLife.
   */
  private readonly _up = new THREE.Vector3(0, 1, 0)
  private readonly _upWant = new THREE.Vector3(0, 1, 0)
  /** Rig heading and aim, in the plane perpendicular to `_up`. Gravity only;
   *  the flat path keeps using the scalar `yaw` and its sin/cos. */
  private readonly _fwd = new THREE.Vector3(0, 0, 1)
  private readonly _aimFwd = new THREE.Vector3(0, 0, 1)
  private readonly _tmp = new THREE.Vector3()
  /** The car's position this frame. Written once at the top of update() so the
   *  gravity placement never has to re-pack it out of the RacerState. */
  private readonly _car = new THREE.Vector3()
  /**
   * True on a track that authors up-vectors. Set by the scene layer from
   * `Track.hasGravity`; the rig cannot sniff it from the racer, because on a
   * flat track the sim leaves `r.up` frozen at the grid's surface normal.
   */
  gravity = false
  /** The car, this frame. The dolly pulls the camera in along the ray to it. */
  private readonly _anchor = new THREE.Vector3()

  // --- cinematic (finish) rig ----------------------------------------------
  /** Seconds since beginCinematic(). Negative means the rig is not running. */
  private cineT = -1
  /** World azimuth of the camera as seen FROM the car, radians. */
  private cineAz = 0
  /** Camera offset from the car at the instant the chase rig handed over. */
  private readonly _handoffPos = new THREE.Vector3()
  private readonly _handoffLook = new THREE.Vector3()
  private handoffFov: number = C.fovRest
  private readonly _cinePos = new THREE.Vector3()
  private readonly _cineLook = new THREE.Vector3()
  /**
   * THE ORBIT'S OWN PLANE, on a gravity track: the car's up, its nose, and the
   * right that completes them. Rebuilt each frame from the racer, because the
   * car is still DRIVING under AI and the plane it is driving in keeps rolling
   * underneath the shot.
   */
  private readonly _cineU = new THREE.Vector3(0, 1, 0)
  private readonly _cineF = new THREE.Vector3(0, 0, 1)
  private readonly _cineR = new THREE.Vector3(1, 0, 0)

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(C.fovRest, aspect, 0.35, 4000)
    this.aspect = aspect
    this.camera.fov = this.framedFov(C.fovRest)
    this.camera.updateProjectionMatrix()
  }

  /** Snap directly behind the racer with no easing. Used on race start. */
  reset(r: RacerState): void {
    this.yaw = r.yaw
    this.fov = C.fovRest
    this.fovBase = C.fovRest
    this.roll = 0
    this.driftYaw = 0
    this.shake = 0
    this.dolly = 0
    // The grid is a boost the camera must not react to: a rocket start is
    // resolved during the countdown, and a reset that left this at 0 would see
    // the whole of `boostMag` arrive as a rise on the first frame of the race.
    this.prevBoostMag = r.boostMag
    this.boostDollyLock = 0
    this.cineT = -1
    this._anchor.set(r.pos.x, r.pos.y, r.pos.z)
    // A reset has no history to ease from, so the frame SNAPS: the grid is
    // wherever it is, including on a bank or a wall, and easing in from world
    // +Y would open the race with a second of the horizon righting itself.
    if (this.gravity) {
      this._up.set(r.up.x, r.up.y, r.up.z).normalize()
      this.orient(r)
      this.pos.copy(this._fwd).multiplyScalar(-this.rig.distance)
        .addScaledVector(this._up, this.rig.height).add(this._anchor)
      this.look.copy(this._fwd).multiplyScalar(C.lookAhead)
        .addScaledVector(this._up, 1.6).add(this._anchor)
      this.apply()
      return
    }
    this._up.set(0, 1, 0)
    const fx = Math.sin(r.yaw), fz = Math.cos(r.yaw)
    this.pos.set(
      r.pos.x - fx * this.rig.distance,
      r.pos.y + this.rig.height,
      r.pos.z - fz * this.rig.distance,
    )
    this.look.set(r.pos.x + fx * C.lookAhead, r.pos.y + 1.6, r.pos.z + fz * C.lookAhead)
    this.apply()
  }

  /**
   * THE RIG'S HEADING, on a gravity track.
   *
   * The flat path carries the heading as a scalar compass yaw and trails it
   * with `damp`. That cannot survive a wall: two rigs a quarter-turn apart
   * around a corkscrew can share a compass bearing, and the plane the bearing
   * is measured in is not the plane the camera needs to orbit in.
   *
   * So the heading becomes a VECTOR, damped in world space and then projected
   * back into the plane perpendicular to `_up`. Damping in world space is the
   * point and not an implementation detail: it is what makes the camera lag
   * through a corner. Damping the angle RELATIVE to the nose instead would
   * weld the rig to the car and lose the trail entirely.
   *
   * `dt < 0` snaps instead of easing, for reset().
   */
  private orient(r: RacerState, dt = -1, lookBack = false): void {
    // Aim = the nose, swung toward the direction of travel while crabbed.
    this._aimFwd.set(r.fwd.x, r.fwd.y, r.fwd.z)
    this._aimFwd.addScaledVector(this._up, -this._aimFwd.dot(this._up))
    if (this._aimFwd.lengthSq() < 1e-8) {
      // Nose parallel to the camera's up: only reachable mid-roll with a very
      // laggy rig. Any in-plane direction beats a NaN, and a NaN here blanks
      // the frame -- so cross with whichever world axis `_up` is least aligned
      // with, which can never itself be degenerate.
      this._aimFwd.set(Math.abs(this._up.x) < 0.9 ? 1 : 0, Math.abs(this._up.x) < 0.9 ? 0 : 1, 0)
        .cross(this._up)
    }
    this._aimFwd.normalize()
    if (this.driftYaw !== 0) this._aimFwd.applyAxisAngle(this._up, this.driftYaw)

    this._tmp.copy(this._aimFwd)
    if (lookBack) this._tmp.applyAxisAngle(this._up, C.lookBackYaw)
    if (dt < 0) { this._fwd.copy(this._tmp); return }

    // lookBackYaw is exactly PI, so the look-back target is the exact antipode
    // of where the rig is standing and the lerp between them is the zero
    // vector. Nudge it off the axis: both ways round are equally long, this
    // just picks one.
    if (this._fwd.dot(this._tmp) < -0.9999) this._tmp.applyAxisAngle(this._up, 1e-3)
    this._fwd.lerp(this._tmp, 1 - Math.pow(2, -dt / this.rig.yawHalfLife))
    this._fwd.addScaledVector(this._up, -this._fwd.dot(this._up))
    if (this._fwd.lengthSq() < 1e-8) this._fwd.copy(this._tmp)
    this._fwd.normalize()
  }

  /**
   * Ease `_up` toward a unit target with a true ANGULAR half-life.
   *
   * The obvious spelling -- lerp the two vectors, then re-normalise -- is a
   * chord where this wants an arc, and the two only agree for small angles.
   * Entering a wall-ride is not a small angle: over a 100-degree roll the chord
   * version closed 43% of the turn in one half-life instead of 50%, and the
   * error grows with the roll, so the constant in TUNING would have meant
   * something different for every wall on every track. Rotating about the
   * shared perpendicular by a fraction of the actual angle makes
   * `cameraUpHalfLife` mean exactly what it says at any angle.
   */
  private easeUp(dt: number, tx: number, ty: number, tz: number): void {
    this._upWant.set(tx, ty, tz).normalize()
    const d = clamp(this._up.dot(this._upWant), -1, 1)
    if (d > 0.9999999) { this._up.copy(this._upWant); return }
    const f = 1 - Math.pow(2, -dt / T.gravity.cameraUpHalfLife)
    this._tmp.copy(this._up).cross(this._upWant)
    if (this._tmp.lengthSq() < 1e-12) {
      // Exactly opposed: every perpendicular is a shortest path, so take one.
      this._tmp.set(this._up.y, this._up.z, this._up.x).cross(this._up)
      if (this._tmp.lengthSq() < 1e-12) this._tmp.set(1, 0, 0)
    }
    this._tmp.normalize()
    this._up.applyAxisAngle(this._tmp, Math.acos(d) * f).normalize()
  }

  /** The player's camera settings. Assigning re-resolves the rig immediately. */
  get settings(): Readonly<CameraSettings> { return this.settingsValue }

  /**
   * Apply a settings change. Takes effect on the NEXT frame rather than
   * snapping: every constant it touches is either a target the rig eases
   * toward (distance, height) or a damping rate, so a player dragging the
   * distance while parked in the pause menu sees the camera glide out rather
   * than cut. The one exception is the anchor, which is solved fresh each
   * frame and therefore does move at once -- correctly, because the car's
   * mark is a position and not a velocity.
   */
  applySettings(s: Partial<CameraSettings>): void {
    this.settingsValue = normaliseCameraSettings({ ...this.settingsValue, ...s })
    this.rig = resolveRig(this.settingsValue)
  }

  addShake(amount: number): void {
    // Scaled here rather than at the call site so every source -- impacts now,
    // anything added later -- goes through the player's dial exactly once.
    this.shake = Math.min(1.4, this.shake + amount * this.rig.shake)
  }

  /**
   * Fire the vertigo shot. `amount` is 0-1; the strongest impulse wins rather
   * than accumulating, so chaining drifts cannot ratchet the frame open.
   *
   * THE PLAYER'S BOOST DIAL IS APPLIED HERE AND ONLY HERE. Three separate
   * things ride `this.dolly` -- the FOV punch (via `C.dollyFov * this.dolly`
   * in update), the camera pull-in (apply), and the composite's warp (which
   * reads `dollyLevel`) -- so scaling the impulse at the single point it
   * enters the rig scales all three, in step, with no chance of one of them
   * being missed. That is the same reason reduced motion zeroes this value
   * rather than suppressing three effects.
   */
  addDolly(amount: number): void {
    this.dolly = Math.max(this.dolly, clamp01(amount * this.rig.boost))
  }

  /**
   * The live vertigo impulse, 0-1, for anything that wants to punch in time
   * with the shot -- currently the composite pass's warp (render/postfx.ts).
   *
   * Read from HERE rather than re-derived from the boost state on the other
   * side, so the screen effect and the camera move cannot drift apart, and so
   * the reduced-motion suppression in update() covers both. The last time a
   * toggle reached the camera and not the effect it shipped.
   */
  get dollyLevel(): number { return this.dolly }

  update(r: RacerState, dt: number, topSpeed: number, lookBack: boolean, reduceMotion: boolean): void {
    const speed = this.gravity
      ? Math.hypot(r.vel.x, r.vel.y, r.vel.z)
      : Math.hypot(r.vel.x, r.vel.z)
    const speed01 = clamp01(speed / Math.max(1, topSpeed))

    // THE CAMERA'S UP follows the car's, damped. Flat, `r.up` is never written
    // after the grid and this whole block is skipped, leaving `_up` at the
    // world +Y it was constructed with.
    if (this.gravity) this.easeUp(dt, r.up.x, r.up.y, r.up.z)

    // While the car is crabbed, swing off the nose toward the direction of
    // travel. Sitting square behind the nose is what made a 32-degree slide
    // read as driving straight with the world sliding underneath it.
    //
    // BOTH the camera position and the look target take this offset. Applying
    // it to the position alone orbits the camera without turning it, which
    // shoves the car into the corner of the frame -- measured at 1280px wide,
    // the car sat 210px left of centre and clipped the bottom edge. Rotating
    // the whole rig keeps the car centred and lets the BODY be the thing that
    // is visibly crossed up.
    // The crab angle: how far the direction of travel leads the nose. Measured
    // about the CAR's up on a gravity track -- a compass comparison reports a
    // slide that is not there for a car on a wall, and misses the one that is.
    const wantDriftYaw = r.driftSide !== 0 && !lookBack && speed > 1
      ? (this.gravity
        ? signedAngleAround(r.fwd, r.vel, r.up)
        : angleDelta(r.yaw, Math.atan2(r.vel.x, r.vel.z))) * C.driftFollowVelocity
      : 0
    this.driftYaw = damp(this.driftYaw, wantDriftYaw, this.rig.yawHalfLife, dt)
    const aimYaw = r.yaw + this.driftYaw

    // Yaw trails the vehicle so corners read as rotation rather than a snap.
    let targetYaw = aimYaw + (lookBack ? C.lookBackYaw : 0)
    // Unwrap so the camera never spins the long way around.
    while (targetYaw - this.yaw > Math.PI) targetYaw -= Math.PI * 2
    while (targetYaw - this.yaw < -Math.PI) targetYaw += Math.PI * 2
    this.yaw = damp(this.yaw, targetYaw, this.rig.yawHalfLife, dt)

    // FOV, and the dolly impulse, BEFORE the camera is placed. The pull-in in
    // apply() needs both FOVs for this frame, and the impulse has to be
    // decayed -- or zeroed for reduced motion -- before anything reads it.
    const boost01 = clamp01(r.boostMag / 0.52)
    const speedFov = C.fovRest + (C.fovBoost - C.fovRest) * clamp01(speed01 * 0.55 + boost01 * 0.75)

    // THE VERTIGO SHOT, ON A BOOST. `boostMag` is a step function -- set on
    // the grant, held, zeroed when the timer expires -- so a rise in it is a
    // new boost, and that is the one signal every source shares. A strip calls
    // applyBoost on all 65 frames you are on it and only the first raises the
    // value, so this cannot ratchet; a display running at 144Hz sees the rise
    // on exactly one frame, so it cannot multi-fire either.
    //
    // Drift releases are EXCLUDED and keep their own path: main.ts fires those
    // off the VFX pass's sim-frame-guarded `dollyRequest` with the tuned
    // per-tier ladder, and picking them up here as well would hand a Tier-0
    // release the flat boost impulse instead of the 0.30 it is meant to get.
    //
    // The tracker is updated whether or not the shot fires -- reduced motion,
    // the cooldown and the speed gate must not leave a stale value that turns
    // into a phantom rise the next time one of them opens.
    const boostRise = r.boostMag - this.prevBoostMag
    this.prevBoostMag = r.boostMag
    if (this.boostDollyLock > 0) this.boostDollyLock = Math.max(0, this.boostDollyLock - dt)
    if (
      boostRise > C.boostDollyMinRise
      && r.boostSource !== 'drift'
      && this.boostDollyLock === 0
      && speed01 > C.boostDollyMinSpeed
    ) {
      this.addDolly(clamp01(boostRise / C.boostDollyFullRise) * C.boostDollyGain)
      this.boostDollyLock = C.boostDollyCooldown
    }
    // Reduced-motion users get the speed FOV they would have had and no
    // vertigo at all, because a rig that moves and zooms in opposite
    // directions is exactly the thing that setting exists to switch off.
    // Zeroing it AFTER the camera has been placed leaves one frame of pull-in
    // -- measured at 0.18m of camera travel -- which is precisely the motion
    // the setting is there to remove.
    //
    // THIS LINE IS ALSO WHY THE BOOST IMPULSE ABOVE IS RAISED ABOVE IT rather
    // than below: whatever that block put into `this.dolly` is wiped here,
    // before the placement, the pull-in in apply() or the composite's warp can
    // read a single frame of it. The same ordering bug -- a block that moved
    // the camera running BEFORE the suppression -- has shipped once already.
    this.dolly = reduceMotion ? 0 : this.dolly * Math.pow(2, -dt / C.dollyHalfLife)
    if (this.dolly < 0.002) this.dolly = 0
    this.fovBase = damp(this.fovBase, speedFov, C.fovHalfLife, dt)
    this.fov = damp(this.fov, speedFov + C.dollyFov * this.dolly, C.fovHalfLife, dt)

    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw)
    // The rig's TARGET offset. Both speed gains ship at 0 -- see
    // TUNING.camera.distanceSpeedGain -- so this is a constant 9.0m back and
    // 3.6m up, and they are here rather than deleted so the old widening can
    // be dialled back in without re-deriving it.
    //
    // The dolly does NOT belong here: this is the distance the rig is AIMING
    // for, and even with the lock below it is not the distance the camera is
    // at on the frame the shot fires -- see apply().
    const dist = this.rig.distance * (1 + speed01 * C.distanceSpeedGain)
    const height = this.rig.height * (1 + speed01 * C.heightSpeedGain)

    // Same rig, same numbers, taken along the racer's frame rather than along
    // the world axes: back along the heading, up along `_up`.
    this._car.set(r.pos.x, r.pos.y, r.pos.z)
    if (this.gravity) {
      this.orient(r, dt, lookBack)
      this._desired.copy(this._fwd).multiplyScalar(-dist)
        .addScaledVector(this._up, height).add(this._car)
    } else {
      this._desired.set(r.pos.x - fx * dist, r.pos.y + height, r.pos.z - fz * dist)
    }
    const f = Math.pow(2, -dt / this.rig.posHalfLife)
    this.pos.lerp(this._desired, 1 - f)

    // ---- THE DISTANCE LOCK -------------------------------------------------
    //
    // The damping above is what makes a corner read as rotation: the camera
    // swings wide and catches up, and the car leads the frame. But a lerp
    // toward a moving target lags in EVERY direction, not just the one that
    // buys the trail, and the radial part of that lag is pure speed
    // dependence -- 13.2m of extra distance at 76 m/s against a 9m rig, more
    // under acceleration, less on the brakes. That is the "the camera keeps
    // changing distance" the shot is being asked to stop doing.
    //
    // So the DIRECTION the damping produced is kept and only its LENGTH is
    // corrected, worked in the rig's own frame: the component along the
    // camera's up (the height, which on a gravity track is the only direction
    // "up" means anything in) and the component perpendicular to it (the
    // ground distance). Locking the ground distance and leaving the height
    // damped is deliberate -- see TUNING.camera.heightLock.
    //
    // This runs BEFORE the floor below, not after, so the clamp still has the
    // last word on where the camera ends up.
    if (C.distanceLock > 0 || C.heightLock > 0) {
      this._tmp.copy(this.pos).sub(this._car)
      const h = this._tmp.dot(this._up)
      // `_tmp` becomes the ground-plane part: what the damping has made of
      // "behind", including the corner swing this is here to preserve.
      this._tmp.addScaledVector(this._up, -h)
      const gnd = this._tmp.length()
      const wantH = h + (height - h) * C.heightLock
      // Degenerate only if the camera is exactly above the car, which the
      // floor and the 9m rig make unreachable; fall back to the rig's own
      // heading rather than dividing by zero.
      if (gnd > 1e-4) {
        this._tmp.multiplyScalar(1 + (dist / gnd - 1) * C.distanceLock)
        // THE CORNER TRAIL, ON A DIAL.
        //
        // The lock above keeps the LENGTH honest and deliberately preserves
        // the DIRECTION the damping produced -- the camera swinging wide and
        // catching up. That trail is what "the camera shifts during turns"
        // is: the rig is behind where the car WAS, so the world slews across
        // the frame every time the road bends.
        //
        // Blending that direction back toward straight-behind is the only
        // honest way to reduce it, because the swing IS the lag. At 1 the
        // camera is rigidly behind the car and corners read as the world
        // rotating about a fixed axis; at 0 it is the full trail this
        // replaced. It is a look, not a correctness knob.
        if (this.rig.trailDamp > 0) {
          if (this.gravity) {
            this._target.copy(this._fwd).multiplyScalar(-dist)
          } else {
            this._target.set(-fx * dist, 0, -fz * dist)
          }
          // The ideal is already ground-plane by construction on a flat track;
          // on a gravity track strip the up component so both sides of the
          // lerp live in the same plane the length was solved in.
          this._target.addScaledVector(this._up, -this._target.dot(this._up))
          this._tmp.lerp(this._target, this.rig.trailDamp)
          // The lerp shortens the chord between two equal-length vectors, so
          // re-normalise to the distance the lock just solved for.
          const L = this._tmp.length()
          if (L > 1e-4) this._tmp.multiplyScalar(dist / L)
        }
      } else if (this.gravity) {
        this._tmp.copy(this._fwd).multiplyScalar(-dist)
      } else {
        this._tmp.set(-fx * dist, 0, -fz * dist)
      }
      this.pos.copy(this._car).addScaledVector(this._up, wantH).add(this._tmp)
    }

    // Never let the camera sink below the vehicle -- along the camera's own up,
    // which on a wall-ride is the only direction "below" means anything in.
    if (this.gravity) {
      const h = this._tmp.copy(this.pos).sub(this._car).dot(this._up)
      if (h < 0.9) this.pos.addScaledVector(this._up, 0.9 - h)
    } else {
      const minY = r.pos.y + 0.9
      if (this.pos.y < minY) this.pos.y = minY
    }

    if (this.gravity) {
      this._target.copy(this._aimFwd).multiplyScalar(C.lookAhead)
        .addScaledVector(this._up, 1.6).add(this._car)
    } else {
      this._target.set(
        r.pos.x + Math.sin(aimYaw) * C.lookAhead,
        r.pos.y + 1.6,
        r.pos.z + Math.cos(aimYaw) * C.lookAhead,
      )
    }
    this.look.lerp(this._target, 1 - Math.pow(2, -dt / (this.rig.posHalfLife * 1.4)))

    this._anchor.set(r.pos.x, r.pos.y, r.pos.z)

    // Roll into drift. Both terms must push the same way: steering right gives
    // +driftSide and a negative yawRate, so the yaw term is added rather than
    // subtracted. The drift term is scaled by how far the stick is committed,
    // so opening the line out on counter-steer levels the frame back off.
    const lean = r.driftSide * (C.driftLeanFloor
      + (1 - C.driftLeanFloor) * clamp01(r.driftInward))
    const targetRoll = reduceMotion ? 0 : -lean * C.driftRoll + r.yawRate * C.driftRollYaw
    this.roll = damp(this.roll, targetRoll, 0.14, dt)

    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 2.6)
    this.apply(reduceMotion)
  }

  // ==========================================================================
  // THE FINISH SHOT
  //
  // A separate rig, not a mode bolted onto the chase path. The chase camera's
  // job is to make the road readable at 90 m/s: it leads the car, trails its
  // yaw, banks into slides and opens the FOV with speed. Every one of those is
  // wrong for a shot whose subject is the CAR and whose job is to let the
  // player look at the thing they just drove and the world they drove it
  // through. Sharing the code would mean fighting all five of them.
  //
  // What it does: hands over from wherever the chase rig actually was, then
  // walks slowly around the car at a fixed radius, looking at it, with a
  // narrower lens. The car keeps DRIVING under AI (Race.stepCeremony), so this
  // is a tracking shot rather than a turntable — the world still streams past.
  // ==========================================================================

  /**
   * Take over from the chase rig. Captures the CURRENT camera offset from the
   * car so the handover has no cut in it; call it on the frame the racer
   * crosses the line, with the camera still holding its last chase pose.
   */
  beginCinematic(r: RacerState): void {
    this.cineT = 0
    this._handoffPos.set(
      this.camera.position.x - r.pos.x,
      this.camera.position.y - r.pos.y,
      this.camera.position.z - r.pos.z,
    )
    this._handoffLook.set(
      this.look.x - r.pos.x,
      this.look.y - r.pos.y,
      this.look.z - r.pos.z,
    )
    this.handoffFov = this.camera.fov
    // Start where the chase rig was standing — behind the car — offset by
    // `orbitStart` so the first second is already a three-quarter view.
    //
    // On a gravity track `cineAz` changes meaning: it stops being a world
    // compass bearing and becomes an angle measured FROM THE NOSE, about the
    // car's own up. A compass bearing cannot express "behind the car" for a
    // car halfway up a wall, and a world-Y orbit around it walks a level
    // circle through the road on one side and out over the void on the other.
    this.cineAz = this.gravity
      ? Math.PI + CER.orbitStart * DEG
      : r.yaw + Math.PI + CER.orbitStart * DEG
  }

  /** True while the finish shot owns the camera. */
  get cinematic(): boolean { return this.cineT >= 0 }

  endCinematic(): void { this.cineT = -1 }

  /**
   * One frame of the finish shot.
   *
   * `track` is what keeps it out of the scenery. Two clamps, both worked in
   * TRACK space rather than world space, because "above the ground" on a
   * banked, climbing circuit is not a constant:
   *
   *  1. LATERAL. The camera is projected onto the centreline and its offset
   *     clamped to a fraction of the local half-width, so it can never swing
   *     out through a barrier or over the void at an open section. Because the
   *     orbit radius (10.5m) is wider than most of the track, this bites for a
   *     good part of every revolution — so instead of squashing the orbit into
   *     an ellipse and calling it done, the clamped distance is paid back as
   *     HEIGHT. The shot rises at its wide points like a crane, which is a
   *     better picture than the one it replaces.
   *  2. VERTICAL. `surfaceHeightAt` is the same banked-plane solve the vehicle
   *     uses, evaluated at the camera's own (s, lateral). The camera is held
   *     `groundClearance` above it, and above the car, whichever is higher.
   *
   * Reduced motion gets no orbit at all: the azimuth stays pinned astern and
   * the rig simply follows the car. A slow continuous rotation of the whole
   * world is precisely the thing that setting exists to switch off.
   */
  updateCinematic(r: RacerState, dt: number, track: Track, reduceMotion: boolean): void {
    if (this.cineT < 0) this.beginCinematic(r)
    this.cineT += dt
    const t = this.cineT

    // Ease the orbit in over the same window as the handover, so the swing
    // starts from rest instead of snapping to full rate on frame one.
    const blend = clamp01(t / Math.max(0.01, CER.blendIn))
    const k = blend * blend * (3 - 2 * blend)

    if (reduceMotion) {
      // Follow the nose. `angleDelta` keeps this from unwrapping the long way
      // when the car crosses the +/-pi seam mid-corner. On a gravity track the
      // azimuth is ALREADY relative to the nose, so following it is a constant.
      const want = this.gravity
        ? Math.PI + CER.orbitStart * DEG
        : r.yaw + Math.PI + CER.orbitStart * DEG
      this.cineAz += angleDelta(this.cineAz, want) * (1 - Math.pow(2, -dt / 0.28))
    } else {
      this.cineAz += CER.orbitRate * DEG * k * dt
    }

    // A breath on radius and height. Tiny, and off under reduced motion.
    const breath = reduceMotion ? 0
      : Math.sin((t / CER.breathePeriod) * Math.PI * 2) * CER.breatheAmp
    const radius = CER.orbitRadius + breath
    const height = CER.orbitHeight + breath * 0.45

    // -------------------------------------------------------------------------
    // THE ORBIT, in the car's own plane.
    //
    // The flat path below is untouched, deliberately: Rustfall and Cryostatic
    // are what tests/ceremony.test.ts measures, and one of those measurements
    // is a BOUND on how far the bearing travels under reduced motion, which
    // already sits close enough to its limit that a shot re-derived through a
    // second code path would be a coin flip. So the gravity rig is a branch,
    // not a generalisation of the arithmetic.
    //
    // Both clamps survive the move because both were already stated in TRACK
    // space: `project` returns a lateral and a HEIGHT measured along the
    // sample's own normal, so "stay over the road" and "stay off the deck"
    // mean exactly what they meant before -- they were simply being converted
    // back into world Y at the end, which is the step that fails on a wall.
    // -------------------------------------------------------------------------
    if (this.gravity) {
      this._cineU.set(r.up.x, r.up.y, r.up.z).normalize()
      this._cineF.set(r.fwd.x, r.fwd.y, r.fwd.z)
      this._cineF.addScaledVector(this._cineU, -this._cineF.dot(this._cineU))
      if (this._cineF.lengthSq() < 1e-8) {
        this._cineF.set(Math.abs(this._cineU.x) < 0.9 ? 1 : 0, Math.abs(this._cineU.x) < 0.9 ? 0 : 1, 0)
          .cross(this._cineU)
      }
      this._cineF.normalize()
      this._cineR.copy(this._cineF).cross(this._cineU).normalize()

      // u(az) = fwd * cos(az) - right * sin(az). At az = 0 that is the nose and
      // at az = PI dead astern, which is the same convention the flat path's
      // (sin, cos) pair carries about world +Y -- so `orbitStart` and
      // `orbitRate` mean the same thing on both paths.
      const ca = Math.cos(this.cineAz), sa = Math.sin(this.cineAz)
      this._tmp.copy(this._cineF).multiplyScalar(ca).addScaledVector(this._cineR, -sa)
      this._cinePos.set(r.pos.x, r.pos.y, r.pos.z)
        .addScaledVector(this._tmp, radius)
        .addScaledVector(this._cineU, height)

      const proj = track.project(this._cinePos, r.splineS)
      const hw = Math.max(2, proj.sample.width * CER.lateralMargin)
      const lat = clamp(proj.lateral, -hw, hw)
      const pushed = Math.abs(proj.lateral) - Math.abs(lat)
      // Height ABOVE THE ROAD, not above the world. The crane-lift that pays
      // back a lateral clamp climbs off the deck the car is on.
      let h = proj.height + (pushed > 0 ? pushed * CER.climbPerMetre : 0)
      if (h < CER.groundClearance) h = CER.groundClearance
      // ...and never below the car, measured the same way.
      if (h < r.altitude + 1.1) h = r.altitude + 1.1
      const sp = track.surfacePoint(proj.s, lat)
      const n = proj.sample.normal
      this._cinePos.set(sp.x + n.x * h, sp.y + n.y * h, sp.z + n.z * h)
      this._cineLook.set(
        r.pos.x + this._cineU.x * CER.lookHeight,
        r.pos.y + this._cineU.y * CER.lookHeight,
        r.pos.z + this._cineU.z * CER.lookHeight,
      )

      // --- hand over, in the road's frame ------------------------------------
      if (blend < 1) {
        const gx = this._cinePos.x, gy = this._cinePos.y, gz = this._cinePos.z
        this._cinePos.set(
          r.pos.x + this._handoffPos.x + (gx - r.pos.x - this._handoffPos.x) * k,
          r.pos.y + this._handoffPos.y + (gy - r.pos.y - this._handoffPos.y) * k,
          r.pos.z + this._handoffPos.z + (gz - r.pos.z - this._handoffPos.z) * k,
        )
        this._cineLook.set(
          r.pos.x + this._handoffLook.x + (this._cineLook.x - r.pos.x - this._handoffLook.x) * k,
          r.pos.y + this._handoffLook.y + (this._cineLook.y - r.pos.y - this._handoffLook.y) * k,
          r.pos.z + this._handoffLook.z + (this._cineLook.z - r.pos.z - this._handoffLook.z) * k,
        )
        // The blend can dip under the deck even when both ends are clear of it.
        // Re-apply the clearance, measured along the road's normal.
        const d = (this._cinePos.x - sp.x) * n.x
          + (this._cinePos.y - sp.y) * n.y
          + (this._cinePos.z - sp.z) * n.z
        if (d < CER.groundClearance) {
          this._cinePos.addScaledVector(
            this._tmp.set(n.x, n.y, n.z), CER.groundClearance - d,
          )
        }
      }

      this.pos.copy(this._cinePos)
      this.look.copy(this._cineLook)
      this.fov = this.handoffFov + (CER.fov - this.handoffFov) * k
      this.fovBase = this.fov
      // THE HORIZON STAYS WHERE THE CAR PUT IT. The flat rig levels the frame
      // to world +Y, which is right when the shot is a level orbit at a fixed
      // world height. Here it is neither: a car that crosses the line mid
      // wall-ride is photographed from its own plane, and righting the lens to
      // +Y would spin the whole world a quarter turn under a stationary
      // subject over the same second the orbit is easing in.
      this.easeUp(dt, r.up.x, r.up.y, r.up.z)
      this.roll = damp(this.roll, 0, 0.18, dt)
      this.dolly = 0
      this.shake = 0
      this.yaw = Math.atan2(this._cineLook.x - this.pos.x, this._cineLook.z - this.pos.z)
      this.driftYaw = 0
      this.apply(reduceMotion)
      return
    }

    const ox = Math.sin(this.cineAz) * radius
    const oz = Math.cos(this.cineAz) * radius
    let cx = r.pos.x + ox
    let cz = r.pos.z + oz
    let cy = r.pos.y + height

    // --- clamp 1: stay over the road -----------------------------------------
    const proj = track.project({ x: cx, y: cy, z: cz }, r.splineS)
    const hw = Math.max(2, proj.sample.width * CER.lateralMargin)
    const lat = clamp(proj.lateral, -hw, hw)
    const pushed = Math.abs(proj.lateral) - Math.abs(lat)
    const sp = track.surfacePoint(proj.s, lat)
    cx = sp.x
    cz = sp.z
    if (pushed > 0) cy += pushed * CER.climbPerMetre

    // --- clamp 2: stay off the deck ------------------------------------------
    const floor = sp.y + CER.groundClearance
    if (cy < floor) cy = floor
    if (cy < r.pos.y + 1.1) cy = r.pos.y + 1.1

    this._cinePos.set(cx, cy, cz)
    this._cineLook.set(r.pos.x, r.pos.y + CER.lookHeight, r.pos.z)

    // --- hand over ------------------------------------------------------------
    // Blend the OFFSET FROM THE CAR, never a world position: the car is still
    // doing racing speed under AI, so a lerp toward a fixed world point is a
    // rubber band that snaps as the car drives out from under it.
    if (blend < 1) {
      this._cinePos.set(
        r.pos.x + this._handoffPos.x + (cx - r.pos.x - this._handoffPos.x) * k,
        r.pos.y + this._handoffPos.y + (cy - r.pos.y - this._handoffPos.y) * k,
        r.pos.z + this._handoffPos.z + (cz - r.pos.z - this._handoffPos.z) * k,
      )
      this._cineLook.set(
        r.pos.x + this._handoffLook.x + (this._cineLook.x - r.pos.x - this._handoffLook.x) * k,
        r.pos.y + this._handoffLook.y + (this._cineLook.y - r.pos.y - this._handoffLook.y) * k,
        r.pos.z + this._handoffLook.z + (this._cineLook.z - r.pos.z - this._handoffLook.z) * k,
      )
      // The blended position can dip under the deck even when both ends are
      // clear of it, on a crest. Re-apply the floor to whatever came out.
      if (this._cinePos.y < floor) this._cinePos.y = floor
    }

    this.pos.copy(this._cinePos)
    this.look.copy(this._cineLook)
    this.fov = this.handoffFov + (CER.fov - this.handoffFov) * k
    this.fovBase = this.fov
    // Level the frame and stop everything the chase rig was doing to it. This
    // is the FLAT path only -- the gravity branch above returns before here and
    // holds the car's own up instead -- so `_up` has never left world +Y and
    // there is nothing to right.
    this.roll = damp(this.roll, 0, 0.18, dt)
    this.dolly = 0
    this.shake = 0
    this.yaw = Math.atan2(this._cineLook.x - this.pos.x, this._cineLook.z - this.pos.z)
    this.driftYaw = 0
    this.apply(reduceMotion)
  }

  private apply(reduceMotion = false): void {
    const cam = this.camera
    cam.position.copy(this.pos)

    // THE VERTIGO SHOT. Pull the camera IN along its own view ray by exactly
    // as much as the widened FOV would otherwise have shrunk the car, so the
    // subject holds its size while the background stretches away behind it.
    // On-screen size goes as 1 / (dist * tan(fov/2)), so holding it fixed
    // means scaling the distance by tan(fovBase/2) / tan(fov/2).
    //
    // It acts on where the camera ACTUALLY is, not on the target distance the
    // rig was aiming for, and it is applied here rather than folded into that
    // target. Those are the same thing only when the car is stationary: at
    // 76 m/s the position damping leaves the camera ~20m back from a car whose
    // target distance is 10.3m, so a ratio applied to the target moved the
    // camera by half of what the FOV asked for -- the car shrank to 0.90x
    // instead of holding, which is the zoom-out this effect exists to avoid.
    // Scaling the target also left the pull-in latched on until the impulse
    // hit its cut-off two seconds later, long after the FOV had come back
    // down, so the car then swelled to 1.14x and the desired distance snapped
    // 3m outward when the dolly finally cleared.
    //
    // `this.pos` is deliberately left un-dollied so this can never compound
    // frame over frame, and so the ratio returns to exactly 1 as the impulse
    // decays.
    if (this.dolly > 0) {
      // Against the FRAMED fields, not the authored ones: on-screen size is a
      // function of what is actually rendered, so off refAspect the authored
      // pair would compensate for a widening that never happened.
      const half = (a: number): number => Math.tan(a * 0.5 * Math.PI / 180)
      const keepSize = half(this.framedFov(this.fovBase))
        / Math.max(1e-4, half(this.framedFov(this.fov)))
      cam.position.sub(this._anchor)
        .multiplyScalar(1 + (keepSize - 1) * C.dollyPull)
        .add(this._anchor)
      // The ray points down at the car, so pulling along it also drops the
      // camera. Re-apply the floor the update pass put on this.pos -- along
      // `_up`, matching the floor in update().
      if (this.gravity) {
        const h = this._tmp.copy(cam.position).sub(this._anchor).dot(this._up)
        if (h < 0.9) cam.position.addScaledVector(this._up, 0.9 - h)
      } else {
        const minY = this._anchor.y + 0.9
        if (cam.position.y < minY) cam.position.y = minY
      }
    }

    if (this.shake > 0 && !reduceMotion) {
      const t = performance.now() * 0.001 + this.shakeSeed
      const s = this.shake * this.shake * 0.55
      cam.position.x += Math.sin(t * 47.3) * s
      cam.position.y += Math.sin(t * 39.1 + 1.7) * s
      cam.position.z += Math.sin(t * 53.7 + 3.1) * s
    }
    // The FOV has to settle BEFORE the anchor below, because the anchor solves
    // against the real projection matrix and a stale FOV would aim at the
    // frame from two milliseconds ago.
    const wantFov = this.framedFov(this.fov)
    if (Math.abs(cam.fov - wantFov) > 0.01) {
      cam.fov = wantFov
      cam.updateProjectionMatrix()
    }

    // `_up` is world +Y on every flat track, so this is the `set(0, 1, 0)` it
    // replaces.
    cam.up.copy(this._up)

    /**
     * THE SCREEN ANCHOR: the car lands on the same pixel, whatever the world
     * is doing.
     *
     * Everything above decides where the CAMERA goes. This decides where the
     * CAR ENDS UP IN THE FRAME, which is the thing a player actually sees and
     * the thing three separate reports were about: the view shifting left and
     * right through corners, the car wandering off its mark, and a loop or a
     * jump putting the car and the road somewhere unplayable.
     *
     * They are one bug. A rig that only places the camera lets the car's
     * screen position fall out of the geometry -- so it moves whenever the
     * geometry does, and a loop rotates the geometry through 360 degrees.
     * Solving for the aim instead makes the car's position an INPUT.
     *
     * WHY IT SOLVES RATHER THAN COMPUTES. Perspective maps tan(angle) linearly
     * to NDC, so a closed form exists for a pure pitch. It stops being closed
     * the moment roll is in play -- and roll is exactly when this matters,
     * because the car sits 62% of the way DOWN the frame, and rotating the
     * view about the screen centre sweeps an off-centre subject sideways. That
     * is a real part of the reported left-right shift and no aim offset
     * computed before the roll can cancel it.
     *
     * So: aim, roll, project the car, measure the error in NDC, correct the
     * aim by it, repeat. Each pass is not belt and braces -- the previous
     * correction changes the basis the next one is measured in.
     *
     * HOW MANY PASSES, measured rather than picked (tools/_it.ts, a 120m
     * corner at 60 m/s, worst NDC error over 8 seconds):
     *
     *            authored rig   angle 28 (the frame edge)
     *   2 passes    0.00573            0.02694
     *   3 passes    0.00117            0.01101
     *   4 passes    0.00024            0.00462
     *   5 passes    0.00005            0.00193
     *
     * Convergence is geometric at about 5x a pass -- which it only became once
     * the lever arm below was fixed; before that it was ~2x and four passes
     * would have bought almost nothing. 4 puts every setting in the range
     * under half a percent of frame height, about 4px on a 944-high frame, and
     * costs one lookAt and one project per frame against a full scene render.
     */
    if (C.anchorStrength > 0) {
      const tx = C.anchorX * 2 - 1
      const ty = 1 - this.rig.anchorY * 2
      this._aim.copy(this.look)
      let reseeded = false
      for (let i = 0; i < ANCHOR_PASSES; i++) {
        cam.up.copy(this._up)
        cam.lookAt(this._aim)
        if (!reduceMotion) cam.rotateZ(this.roll)
        cam.updateMatrixWorld(true)
        this._ndc.copy(this._anchor).project(cam)
        // BEHIND THE CAMERA. `project` mirrors the point through the origin,
        // so the correction below would drive the aim the wrong way.
        //
        // The seed for the solve is `this.look`, which is heavily damped, and
        // on a long corner with a loose tracking setting it can lag far enough
        // that the first aim points away from the car entirely. The original
        // spelling BROKE out of the loop here, leaving the aim at that lagged
        // value -- a camera pointing backwards, which measured as a 165-degree
        // error between the lens and the nose while the rig POSITION was a
        // perfectly healthy 12 degrees off astern.
        //
        // Looking straight at the car cannot be behind the camera, so that is
        // the seed to fall back to; the solve then converges from dead centre.
        // Once only, so a genuinely degenerate frame still terminates.
        if (this._ndc.z > 1) {
          if (reseeded) break
          reseeded = true
          this._aim.copy(this._anchor)
          continue
        }
        // THE LEVER ARM IS THE AIM'S, NOT THE CAR'S.
        //
        // The NDC error converts to an ANGLE the camera has to turn through:
        // (ndc - target) * tanY is that angle in tan units. Turning the camera
        // by it means moving the aim point sideways by angle * (how far the
        // AIM is from the camera) -- and the aim sits on the look-ahead point,
        // ~13m beyond the car, so it is roughly twice as far away as the car
        // is.
        //
        // This used to use the distance to the CAR for that lever arm, which
        // under-rotates by exactly the ratio of the two distances: about half.
        // The solve still converged, but geometrically at ~0.5 per pass rather
        // than in one step, so two passes left an eighth of the initial error
        // instead of nothing. At the authored rig that residual was small
        // enough to pass; at 6m, or at a 27-degree angle, the car sat up to
        // 0.071 of a frame off its mark -- 67 pixels on a 944-high frame, and
        // visibly drifting through every corner.
        //
        // Guarded because the aim can momentarily coincide with the camera on
        // a re-seed; the car's distance is the right fallback there, being the
        // only other length in the problem.
        const dAim = cam.position.distanceTo(this._aim)
        const lever = dAim > 0.05 ? dAim : cam.position.distanceTo(this._anchor)
        const tanY = Math.tan(cam.fov * 0.5 * Math.PI / 180)
        cam.matrixWorld.extractBasis(this._bR, this._bU, this._bF)
        // Car too far right -> look further right -> the car moves left.
        this._aim.addScaledVector(
          this._bR, (this._ndc.x - tx) * tanY * cam.aspect * lever * C.anchorStrength,
        )
        this._aim.addScaledVector(
          this._bU, (this._ndc.y - ty) * tanY * lever * C.anchorStrength,
        )
      }
    } else {
      this._aim.copy(this.look)
    }

    cam.up.copy(this._up)
    cam.lookAt(this._aim)
    if (!reduceMotion) cam.rotateZ(this.roll)
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect
    this.aspect = aspect
    // The framed vertical FOV depends on the aspect, so a resize has to
    // re-derive it rather than wait for the next frame that happens to move
    // the FOV past the 0.01-degree threshold in apply().
    this.camera.fov = this.framedFov(this.fov)
    this.camera.updateProjectionMatrix()
  }

  /**
   * Convert an AUTHORED vertical FOV into the one to actually render with at
   * this aspect. See TUNING.camera.refAspect for why.
   *
   * Holds the horizontal field at its value on a `refAspect` screen:
   *   hRef = 2 atan(tan(v/2) * refAspect)
   *   v'   = 2 atan(tan(hRef/2) / aspect)
   * which is the identity when aspect === refAspect, so the signed-off desktop
   * frame is untouched. Clamped so a very wide screen cannot squeeze the
   * vertical away entirely, and never widened past the authored value -- a
   * narrow or portrait screen keeps the authored vertical and simply sees less
   * to the sides, which is the ordinary and correct behaviour there.
   */
  private framedFov(authored: number): number {
    const a = this.aspect
    if (!(a > 0) || Math.abs(a - C.refAspect) < 1e-6) return authored
    const halfV = authored * 0.5 * Math.PI / 180
    const halfH = Math.atan(Math.tan(halfV) * C.refAspect)
    const framed = 2 * Math.atan(Math.tan(halfH) / a) * 180 / Math.PI
    return clamp(framed, authored * C.minVerticalScale, authored)
  }
}
