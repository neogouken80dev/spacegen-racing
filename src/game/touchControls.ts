/**
 * touchControls.ts — on-screen touch controls for SpaceGen Racing.
 *
 * Three player-selectable schemes, all of which keep Drift, Brake and Item as
 * chunky thumb-reachable buttons on the right edge:
 *
 *   'tilt'    device-orientation steering (default on phones)
 *   'stick'   floating virtual stick on the left half, origin set on touchdown
 *   'buttons' discrete left/right arrow pads plus explicit throttle/brake pads
 *
 * BRAKE IS NEVER TAKEN AWAY. Auto-accelerate is the default on a phone and it
 * means "you do not have to hold the gas", not "you cannot slow down", so the
 * Brake pad is on screen in every scheme and in both throttle modes. Gas is the
 * only conditional pad: with auto on it would do nothing the game is not
 * already doing for the player.
 *
 * Latency contract: every pointer event writes plain scalar fields
 * synchronously inside the handler. `sample()` only reads those fields, so a
 * touch is visible to the simulation on the very next sim step. Nothing here
 * routes through a framework, a rAF hop or a re-render.
 *
 * Layout contract with the HUD: `root` is a full-screen pointer-events:none
 * overlay. Only the actual control surfaces set pointer-events:auto, and the
 * controls live in the lower band so the HUD keeps its four corners.
 */
import type { InputFrame } from '../sim/types'
import { TUNING } from '../content/tuning'
import { clamp, damp, DEG, RAD } from '../sim/math'

export type TouchScheme = 'tilt' | 'stick' | 'buttons'

export interface TouchControls {
  root: HTMLElement
  sample(out: InputFrame): void
  setScheme(s: 'tilt' | 'stick' | 'buttons'): void
  setVisible(v: boolean): void
  dispose(): void

  // --- extensions used by the InputManager -------------------------------
  /** Only changes pad visibility; the manager owns the throttle override. */
  setAutoAccelerate(on: boolean): void
  setOneHanded(on: boolean, side?: 'left' | 'right'): void
  /** Show the Lift pad (flight chassis only). */
  setLiftEnabled(on: boolean): void
  setTiltInvert(on: boolean): void
  /** The player's steering preferences. Clamped to the two ranges below. */
  setStickTune(tune: StickTune): void
  /** Capture the current holding angle as neutral. */
  calibrateTilt(): void
  /**
   * iOS 13+ needs DeviceOrientationEvent.requestPermission() called from
   * inside a user gesture. Pass `true` when we are inside one.
   */
  requestTiltPermission(fromGesture: boolean): void
  readonly tiltActive: boolean
  /** Fired when tilt is denied or missing so the host can fall back to stick. */
  onTiltUnavailable: (() => void) | null
  /** Fired on the first touch of any control surface. */
  onTouchActivity: (() => void) | null
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** The sim advances by this much per `sample()` call. Keeps ramps deterministic. */
const DT = TUNING.sim.dt

/**
 * Digital -> analog steering ramp, shared by the keyboard and by the touch
 * arrow pads. A key or a pad is a switch; the vehicle needs a wheel.
 *
 *   attack  0 -> full lock in 0.120s
 *   release full lock -> 0 in 0.070s   (releases faster than it engages so a
 *                                       drift arc can be trimmed, not sawed)
 *   cross   sign flip in 0.055s        (direction changes stay crisp)
 */
export const STEER_RAMP = {
  attackTime: 0.120,
  releaseTime: 0.070,
  crossTime: 0.055,
} as const

const ATTACK_RATE = 1 / STEER_RAMP.attackTime
const RELEASE_RATE = 1 / STEER_RAMP.releaseTime
const CROSS_RATE = 1 / STEER_RAMP.crossTime

/** Move `current` toward `target` at the rate the transition calls for. */
export function rampAxis(current: number, target: number, dt: number): number {
  if (current === target) return target
  let rate: number
  if (target === 0) {
    rate = RELEASE_RATE
  } else if (current !== 0 && ((current < 0) !== (target < 0))) {
    rate = CROSS_RATE
  } else if (Math.abs(target) < Math.abs(current)) {
    rate = RELEASE_RATE
  } else {
    rate = ATTACK_RATE
  }
  const step = rate * dt
  const d = target - current
  if (d > step) return current + step
  if (d < -step) return current - step
  return target
}

/**
 * Deadzone rescale with a soft shoulder. Blending smoothstep with linear gives
 * a gentle ramp out of the deadzone (no jolt as the stick leaves centre) while
 * keeping enough low-end slope for fine corrections and a true 1.0 at the rim.
 */
export function axisCurve(raw: number, deadzone: number): number {
  const a = raw < 0 ? -raw : raw
  if (a <= deadzone) return 0
  let n = (a - deadzone) / (1 - deadzone)
  if (n > 1) n = 1
  const s = n * n * (3 - 2 * n)
  const out = 0.6 * s + 0.4 * n
  return raw < 0 ? -out : out
}

/**
 * Floating stick travel, CSS px, from origin to full lock.
 *
 * History, because this is the second report of the same feel:
 *
 *   70  A GAMEPAD'S THROW ON A SURFACE THAT HAS NONE. A thumbstick has a rim
 *       you can feel and a spring that tells you how far you have pushed it; a
 *       finger on glass has neither, so the only feedback about how much lock
 *       is on is the car's response -- and 70px put most of the useful range
 *       beyond where a thumb reaches from a resting grip.
 *   50  The first answer to "the mobile controls feel slow to respond". It
 *       halved the travel and straightened the curve, and it was a real gain
 *       (x2.0-2.4 at 20-25px). It was reported as STILL sluggish.
 *   38  This pass. 50 was not wrong, it was measured against the wrong
 *       question: "can a thumb reach full lock" (yes, it always could) rather
 *       than "where does ORDINARY CORNERING sit in the travel".
 *
 * THE MEASUREMENT THAT PICKED 38. `tools/probe-stick.ts` chains the corner
 * radius of every curved 10m of three circuits to the speed the sim actually
 * carries there, through the vehicle's own speed falloff, to the lock that
 * corner demands -- then back through this curve to px of thumb. At 50px:
 *
 *   median curved bin   0.28-0.43 lock   19px   38% of travel
 *   p90                 0.57-0.64        31px   63%
 *   tightest corners    0.81-0.88        43px   86%
 *
 * So the pad's whole working range was its OUTER HALF, and holding a tight
 * corner meant parking the thumb at 86% of travel for the length of the
 * corner -- the one part of the range where a thumb with no rim has the least
 * control and has to work hardest to stay put. That is what "sluggish when
 * trying to make turns" is: not a slow response and not a missing full lock,
 * but a gear ratio that puts every corner at the end of the stroke.
 *
 * 38 IS DERIVED, NOT PICKED. `.sgtc-base` is a 150px well and `.sgtc-knob` a
 * 68px knob, so the knob's edge meets the rim at 75 - 34 = 41px of centre
 * travel. At 50 the drawn well was a LIE -- the player hit the visible rim at
 * about 0.80 of lock and the last fifth lived past it, which reads exactly
 * like a stick that has run out. The well is now sized from this constant
 * (see CSS) so full lock and the rim are the same place and cannot drift
 * apart again.
 */
export const STICK_RADIUS = 29
/**
 * THE DOMAIN THE RESPONSE CURVE IS AUTHORED AGAINST, AND IT IS NOT THE RIM.
 *
 * `stickCurve` was fitted against a 38px travel, and every number in its own
 * comment -- the 2.0x at 5px, the 1.5x at 25px, the measured table -- is a
 * statement about THAT domain. Moving the rim to 29 does not move the curve:
 * 29px is simply the place on the 38px curve where the lock reaches 0.80, and
 * the well is drawn there so the player can see it.
 *
 * REFITTING THE CURVE INTO 29 AND SCALING THE RESULT BY 0.80 IS A DIFFERENT
 * FUNCTION, and I shipped that by mistake for one edit. f is quadratic, so
 * squeezing its domain by 0.7632 and shrinking its range by 0.80 do not
 * cancel: measured, the refit was up to 0.0329 of lock off at 9.1px, about
 * +15% of what the pad gave a player there. Keeping the span separate from
 * the rim is what makes "the comfortable range did not move" true rather than
 * merely claimed, and `tests/steering.test.ts` re-derives the old mapping from
 * this constant and holds the difference at exactly zero -- not close, the
 * same double, because it is the same arithmetic on the same domain.
 */
export const STICK_CURVE_SPAN = 38
/**
 * THE REST SHOULDER, IN PIXELS, BECAUSE THAT IS WHAT IT IS.
 *
 * This was 0.08 of the radius, and it stayed correct exactly as long as the
 * radius did not move. Then the radius moved -- 38 to 29 -- and the shoulder
 * silently went to 2.32px, with the Pad size dial able to take it to 1.62px.
 * The old constant's own comment forbade that in so many words: "a thumb's
 * jitter while it sits on the glass is a distance, not a fraction". A fraction
 * of something that can change is a distance waiting to be wrong, so it is
 * now the distance it was always meant to be, and `throw` divides out of it in
 * `restFraction` so a bigger pad does not buy a twitchier one.
 *
 * 3.04 is 0.08 x 38, which is what 0.06 x 50 was before that: the number has
 * not moved since the stick was first tuned, only the units it is kept in.
 */
const STICK_REST_PX = 3.04
/**
 * The blend weight `stickCurve` adds `gain` to. See that function for what it
 * means; it lives up here because STICK_RIM_LOCK below asks the curve for the
 * rim during module init, and a `const` declared further down is in its
 * temporal dead zone at that moment. `tsc` does not see it -- the call is
 * indirect -- so the first thing that happened when I put it beside the
 * function was a ReferenceError at import. Order is load-bearing here.
 */
const CURVE_BASE = 0.35
/**
 * THE RIM IS NOT FULL LOCK ANY MORE, AND THAT IS THE POINT OF THIS PASS.
 *
 * Vince, on a tablet: the pad slid along under his thumb once he passed the
 * edge, and what he wanted instead was a fixed anchor with the region BEYOND
 * the edge steering harder -- "really exaggerate their turning based on the
 * aggressiveness of the steering".
 *
 * That needs somewhere for the extra to live, so the well now covers 0 to 0.80
 * of lock and the last fifth lives in the overtravel band past the rim.
 *
 * THE COMFORTABLE RANGE DID NOT MOVE. 29 is not a shortening: it is where 0.80
 * of lock ALREADY WAS at 38. Solving the curve for 0.80 gives n = 0.732, so
 * a = 0.08 + 0.732*0.92 = 0.753, so 28.6px. Every thumb distance inside the
 * well returns exactly the lock it returned before this change -- the rim
 * simply moved inward to meet the number, and the well is drawn from the
 * constant so the two cannot drift.
 *
 * WHAT THE PLAYER GAINS IS RESOLUTION AT THE LIMIT. 0.80 to 1.00 used to be
 * 29-38px: nine pixels for the whole top fifth of the lock, which is why
 * holding a tight corner meant parking a thumb in the twitchiest part of the
 * stroke. It is now 18px -- twice the travel for the same fifth -- so 0.85,
 * 0.90 and 0.95 are distinguishable places a thumb can sit rather than three
 * pixels of the same one.
 *
 * You cannot have a long overtravel band AND a steeper one than the rim: the
 * remaining lock is fixed, so distance and slope trade directly. This spends
 * it on distance, because control of the last fifth is what a corner actually
 * needs, and the "aggression" the player feels is the felt EDGE -- the knob
 * pinning, the well straining -- rather than a sudden surge.
 *
 * DERIVED, NOT WRITTEN DOWN, and it is 0.8095 rather than 0.8000. STICK_RADIUS
 * is the rounding of 28.6031 to a whole pixel, and a hand-typed 0.80 here
 * would have been a second opinion about where the rim is -- the kind that
 * drifts from the first one and is only found when a player says the pad feels
 * wrong. Asking the curve is free and cannot drift.
 *
 * IT IS THE RIM AT gain 1, and gain reshapes the approach, so the rim sits
 * between about 0.71 and 0.89 of lock across the dial. Anything that needs the
 * rim AT A GIVEN TUNE must call `stickSteerFrom(STICK_RADIUS * tune.throw,
 * tune)`; this constant answers for the default and for the drawn well.
 */
export const STICK_RIM_LOCK =
  stickCurve(STICK_RADIUS / STICK_CURVE_SPAN, STICK_REST_PX / STICK_CURVE_SPAN, 1)
/**
 * Pixels past the rim that reach full lock. See STICK_RIM_LOCK for the trade.
 *
 * Past this the steering simply holds at 1.0: there is nothing above full lock
 * and pretending otherwise would be a control that lies. The visuals keep
 * responding for a little longer so a player leaning hard still gets an answer
 * from the screen.
 */
export const STICK_OVERTRAVEL = 18

/** Knob radius in CSS px. The well is drawn from this plus STICK_RADIUS. */
export const STICK_KNOB_R = 34

/**
 * THE TOUCH STICK'S OWN RESPONSE, and deliberately not `axisCurve`.
 *
 * `axisCurve` blends 60% smoothstep with 40% linear, which is right for a
 * GAMEPAD: a physical stick self-centres, drifts, and is held under tension, so
 * a soft shoulder out of the deadzone stops a resting thumb steering the car.
 * Applied to a touch surface it is a tax -- a finger is exactly where the
 * player put it.
 *
 * WAS 88% LINEAR + 12% SMOOTHSTEP, and smoothstep is SLOW-EARLY: it takes
 * slope away from the start of the travel and gives it to the end. That is the
 * right shape for a self-centring stick and the wrong one here, because the
 * measurement above says the corners live in the first two thirds and full
 * lock is the rare case (1-2% of a lap's open-steering frames).
 *
 * So the blend is flipped to FAST-EARLY: 65% linear + 35% of `1-(1-n)^2`,
 * which is `1.35n - 0.35n^2`. Exactly 1.0 at the rim, monotonic, and slope
 * 1.35 rather than 0.88 leaving the deadzone. Not an expo curve (`n^g`), which
 * has infinite slope at zero and would make a thumb that is merely resting
 * askew into a steering input.
 *
 * NOT TAKEN FURTHER. At 40% weight and 36px the low end reaches 2.0-2.3x the
 * shipped gain, and the roster's drift-charged boost economy is tuned around
 * the current steering; a twitchy car is a worse outcome than a slightly slow
 * one. This lands at 1.5-1.8x through the band a corner actually uses.
 *
 * Measured, displacement in px -> steer, the 50px build against this one:
 *    5px  0.038 -> 0.075  (x2.0)    25px  0.466 -> 0.707  (x1.5)
 *   10px  0.138 -> 0.254  (x1.8)    30px  0.579 -> 0.828  (x1.4)
 *   15px  0.223 -> 0.383  (x1.7)    38px  0.799 -> 1.000  (full lock at 38)
 *   20px  0.354 -> 0.573  (x1.6)    50px  1.000 -> 1.000
 *
 * `gain` IS THE PLAYER'S DIAL, AND IT RESHAPES THE CURVE RATHER THAN SCALING
 * ITS OUTPUT. The blend weight above is the whole of the curve's character, so
 * the dial simply moves it: `c = CURVE_BASE + gain`, and the response is
 * `c*n + (1-c)*n^2`, which is the shipped `1.35n - 0.35n^2` at gain 1.
 *
 * WHY NOT SCALE THE OUTPUT, which is the obvious thing and is what this
 * function did for one edit: `out * gain` clamps, so a gain below 1 does not
 * make the car calmer, it makes the car UNABLE TO TURN AS HARD. Measured
 * against the roster, gain 0.6 put 12.9% of the curved steering bins out of
 * reach and the tightest corner on the calendar needs 0.92 of lock -- a player
 * who nudged a slider labelled "sensitivity" would have been quietly handed a
 * car that cannot make a corner, and would have had no way to know. A
 * SENSITIVITY DIAL MUST NOT BE A HANDICAP.
 *
 * So this form is chosen for one property above all: it is EXACTLY 1.0 at n=1
 * for every c, because `c + (1-c)` is 1. Full lock stays reachable at every
 * setting, at the same place on the glass; what the dial buys is how soon the
 * lock arrives on the way there. It is monotonic for c in [0, 2] (the slope
 * `c + 2(1-c)n` is linear in n, so the two ends decide it) and has finite
 * slope at the origin, which is the trap `n^g` expo falls into and which this
 * comment already rejects above: a thumb merely resting askew must not steer.
 *
 * Measured, lock at the same thumb distance, across the dial (throw 1):
 *          gain 0.50   gain 1.00   gain 1.40
 *    9px    0.149       0.220       0.277
 *   15px    0.308       0.421       0.511
 *   22px    0.505       0.629       0.728
 *   29px    0.714       0.809       0.886   <- the rim, at every setting
 *   47px    1.000       1.000       1.000   <- full lock, at every setting
 */
export function stickCurve(raw: number, deadzone: number, gain = 1): number {
  const a = raw < 0 ? -raw : raw
  if (a <= deadzone) return 0
  let n = (a - deadzone) / (1 - deadzone)
  if (n > 1) n = 1
  const c = CURVE_BASE + gain
  const out = c * n + (1 - c) * n * n
  return raw < 0 ? -out : out
}

/**
 * Thumb displacement along the steering axis, CSS px -> steer.
 *
 * Exists so the mapping a player actually feels is one call that a test and a
 * probe can both reach. It used to be spelled out inside the pointermove
 * handler, which meant the only way to measure it was to drive a browser.
 */
export function stickSteerFrom(dx: number, tune: StickTune = DEFAULT_STICK_TUNE): number {
  const a = dx < 0 ? -dx : dx
  const sign = dx < 0 ? -1 : 1
  const rim = STICK_RADIUS * tune.throw
  if (a <= rim) {
    // INSIDE THE WELL THE MAPPING IS THE SHIPPED ONE, UNTOUCHED. The curve's
    // domain is still STICK_CURVE_SPAN, not the rim -- refitting it into the
    // shorter radius and scaling the output by 0.80 is a DIFFERENT function,
    // because f is quadratic and compressing its domain does not cancel
    // scaling its range. Measured, that refit moved the lock by up to 0.033
    // at 9px, about 15% of what the pad gave there. Relabelling the rim is
    // what "the comfortable range did not move" actually requires, and the
    // test holds this branch bit-identical to the old one at gain 1.
    return sign * stickCurve(a / (STICK_CURVE_SPAN * tune.throw), restFraction(tune), tune.gain)
  }
  // Past it: linear to full lock, then flat. Linear on purpose -- this is the
  // band a player modulates by feel with no rim to brace against, and a curve
  // here would make the same push mean different things at different depths.
  const over = (a - rim) / (STICK_OVERTRAVEL * tune.throw)
  const rimLock = stickCurve(STICK_RADIUS / STICK_CURVE_SPAN, restFraction(tune), tune.gain)
  return sign * (rimLock + (1 - rimLock) * (over > 1 ? 1 : over))
}

/**
 * The rest shoulder as a fraction of the curve's domain, held ABSOLUTE in px.
 *
 * STICK_DEADZONE used to be 0.08 of the radius, and this pass shortening the
 * radius silently took the shoulder from 3.04px to 2.32px -- and the Pad size
 * dial would have taken it to 1.62px. The constant's own comment forbids
 * exactly that: "a thumb's jitter while it sits on the glass is a distance,
 * not a fraction". So it is now a distance, and `throw` divides out of it so a
 * bigger pad does not buy a twitchier one.
 */
function restFraction(tune: StickTune): number {
  return STICK_REST_PX / (STICK_CURVE_SPAN * tune.throw)
}

/**
 * How far past the rim the thumb is, 0 at the rim and 1 at full lock.
 *
 * Drives the strain on the drawn control and nothing else. The last pass
 * rejected a 50px travel in a 150px well because "the drawn well was a LIE" --
 * the player reached the visible rim before the lock ran out and it read as a
 * stick that had given up. That objection is exactly as valid now, and the
 * answer is not to put the rim back at full lock but to make the overtravel
 * VISIBLE: the knob pins to the rim and the well tightens, so the edge is a
 * place the control is still working rather than the end of it.
 *
 * IT DOES NOT TAKE `gain` AND DOES NOT NEED TO, which was only true after the
 * gain law changed. While gain scaled the output it also clamped, so above
 * 1.25 the steering was already pinned eight pixels into a band this still
 * animated over all eighteen -- the well straining while the car had stopped
 * answering, which is the drawn-well lie the pass above exists to kill. Gain
 * reshapes the curve now and full lock is at the same place for every setting,
 * so the strain and the steering start and finish together by construction.
 * The check in `tests/steering.test.ts` sweeps the whole dial grid for it.
 */
export function stickOvertravel(dx: number, tune: StickTune = DEFAULT_STICK_TUNE): number {
  const a = dx < 0 ? -dx : dx
  const rim = STICK_RADIUS * tune.throw
  if (a <= rim) return 0
  const over = (a - rim) / (STICK_OVERTRAVEL * tune.throw)
  return over > 1 ? 1 : over
}

/**
 * The player's own steering preferences.
 *
 * `gain` scales the lock a given thumb distance returns; `throw` scales the
 * distances themselves. They are deliberately separate: a big-handed player on
 * a tablet wants a longer stroke at the same sensitivity, and a player who
 * finds the car lazy wants more lock from the same stroke. One slider doing
 * both would move whichever the player was not thinking about.
 */
export interface StickTune {
  gain: number
  throw: number
}

export const DEFAULT_STICK_TUNE: StickTune = { gain: 1, throw: 1 }
/**
 * Slider bounds. Generous at both ends -- a preference nobody can reach is not
 * a preference -- but never far enough to make the pad lie.
 *
 * GAIN IS BOUNDED BY MONOTONICITY, NOT BY TASTE. `c = 0.35 + gain` and the
 * curve's slope is `c + 2(1-c)n`, so it stops rising somewhere inside the
 * travel once c passes 2, i.e. gain 1.65: past that, pushing further would
 * return LESS lock. 1.40 leaves c at 1.75 and a slope of 0.25 arriving at the
 * rim -- still a place a thumb can feel it is moving. The low end is bounded
 * the same way from below (c > 0 at gain -0.35) and is set by feel instead:
 * 0.50 is where the early travel stops being distinguishable from linear.
 *
 * THE OLD MIN OF 0.60 WAS NOT A PREFERENCE FLOOR, it was the point where the
 * car could still just about make the calendar's hardest corner, because gain
 * used to scale and clamp the output. It reshapes the curve now, so no setting
 * can cost the player lock, and the bound has no business being a balance
 * number any more.
 */
export const STICK_GAIN_RANGE = { min: 0.5, max: 1.4 } as const
export const STICK_THROW_RANGE = { min: 0.7, max: 1.8 } as const

/** Exported so callers holding a tune from storage clamp it the same way the
 *  control does, rather than each keeping a two-line copy that can drift. */
export function clampRange(v: number, r: { min: number; max: number }): number {
  if (!Number.isFinite(v)) return 1
  return v < r.min ? r.min : v > r.max ? r.max : v
}

/**
 * THE ANCHOR NO LONGER MOVES, AND `stickOrigin` IS GONE.
 *
 * It used to drag the well along once the thumb passed full travel, which is
 * what let a long swipe keep steering instead of running out of stroke. Vince
 * reported it from a tablet as the bug it is: "when i reach beyond the bounds
 * of the steering joypad, the joypad starts to move along with my finger. This
 * should not be the behavior."
 *
 * He is right, and the reason is worth keeping. A control that re-zeroes under
 * your thumb has no fixed reference: the same finger position means a
 * different steering angle depending on how you got there, so a player cannot
 * build muscle memory for "this much thumb is this much turn". Dragging also
 * quietly removed the END of the stroke, which is why the previous pass could
 * write that the pad "always reached full lock... a long swipe never runs out"
 * -- there was no limit to run out of, and therefore nowhere for an overtravel
 * band to exist.
 *
 * So the anchor is now set once on pointerdown and held for the whole gesture,
 * the thumb is free to travel anywhere on the glass (pointer capture keeps the
 * events coming after it leaves the zone), and lifting hides the pad. The next
 * touch anchors wherever it lands -- which is what the control already did,
 * and the half of the report that needed no change.
 */

/** Tilt steering, degrees of roll. */
const TILT_DEADZONE_DEG = 4
const TILT_FULL_DEG = 28
/** Smoothing half-life on the tilt signal — kills hand tremor, costs ~1 frame. */
const TILT_HALF_LIFE = 0.045
/** If the sensor never speaks within this long, treat tilt as unavailable. */
const TILT_PROBE_MS = 1500

// Control kinds. Plain numbers so the pointer map stays cheap.
const K_DRIFT = 1
const K_ITEM = 2
const K_BACK = 3
const K_GAS = 4
const K_BRAKE = 5
const K_LIFT = 6
const K_LOOK = 7
const K_ARROWS = 8
const K_STICK = 9
const K_CAL = 10
const K_HINT = 11
const K_COUNT = 12

interface DoeStatic {
  requestPermission?: () => Promise<string>
}

function doeStatic(): DoeStatic | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { DeviceOrientationEvent?: DoeStatic }).DeviceOrientationEvent
}

/** CSS rotation of the page content relative to the device's natural axes. */
function screenAngleDeg(): number {
  if (typeof window === 'undefined') return 0
  const so = typeof screen !== 'undefined' ? screen.orientation : undefined
  if (so && typeof so.angle === 'number') return so.angle
  const legacy = (window as unknown as { orientation?: number }).orientation
  return typeof legacy === 'number' ? legacy : 0
}

/**
 * Signed steering roll in degrees, positive = "right edge down" = steer right.
 *
 * DeviceOrientationEvent angles are always in the device's fixed frame, never
 * the screen's, so the axis that carries a left/right roll depends on how the
 * page is rotated. Rather than pick one axis, project world-up into device
 * coordinates and take its component along the *screen's* right vector:
 *
 *   up_device      = (-sin g * cos b,  sin b,  cos g * cos b)
 *   screenRight    = ( cos t, -sin t, 0)          t = screen orientation angle
 *
 * This reduces to gamma in portrait and to beta in landscape, which is what
 * the hardware actually reports, and it stays continuous across rotations.
 */
export function tiltRollDeg(betaDeg: number, gammaDeg: number, screenDeg: number): number {
  const b = betaDeg * DEG
  const g = gammaDeg * DEG
  const t = screenDeg * DEG
  const ux = -Math.sin(g) * Math.cos(b)
  const uy = Math.sin(b)
  const s = Math.cos(t) * ux - Math.sin(t) * uy
  return Math.asin(clamp(-s, -1, 1)) * RAD
}

// ---------------------------------------------------------------------------
// Styling — bold kart-racer HUD: chunky, semi-transparent, glowing.
// ---------------------------------------------------------------------------

const STYLE_ID = 'sgtc-style'

const CSS = `
.sgtc{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:5;
  touch-action:none;-webkit-user-select:none;user-select:none;
  -webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;
  font-family:ui-sans-serif,system-ui,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --pl:max(16px,env(safe-area-inset-left,0px));
  --pr:max(16px,env(safe-area-inset-right,0px));
  --pb:max(18px,env(safe-area-inset-bottom,0px));
  --cy:126 240 255;--mg:255 94 200;--am:255 198 94;--gn:125 255 155;--rd:255 110 110}
.sgtc *{box-sizing:border-box;margin:0}
.sgtc.off{display:none!important}

.sgtc-btn{--a:var(--cy);position:relative;pointer-events:auto;touch-action:none;
  display:flex;align-items:center;justify-content:center;text-align:center;
  line-height:1.05;padding:2px;border-radius:999px;
  border:2px solid rgb(var(--a) / .55);
  background:radial-gradient(circle at 50% 32%,rgb(var(--a) / .30),rgb(var(--a) / .06) 62%,rgba(6,12,26,.46) 100%);
  box-shadow:0 0 20px rgb(var(--a) / .26),inset 0 0 24px rgb(var(--a) / .16),0 6px 18px rgba(0,0,0,.36);
  color:rgb(var(--a));font-weight:800;font-size:12px;letter-spacing:.10em;
  text-shadow:0 0 10px rgb(var(--a) / .8);
  -webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);
  transition:transform .07s ease-out,box-shadow .09s ease-out,background .09s ease-out,border-color .09s ease-out;
  will-change:transform}
.sgtc-btn.on{transform:scale(.92);border-color:rgb(var(--a) / .98);
  background:radial-gradient(circle at 50% 32%,rgb(var(--a) / .62),rgb(var(--a) / .22) 62%,rgba(6,12,26,.5) 100%);
  box-shadow:0 0 36px rgb(var(--a) / .55),inset 0 0 30px rgb(var(--a) / .34),0 2px 10px rgba(0,0,0,.4)}

.sgtc-right{position:absolute;right:var(--pr);bottom:var(--pb);pointer-events:none;
  display:flex;flex-direction:column-reverse;align-items:flex-end;gap:12px}
.sgtc-row{display:flex;flex-direction:row-reverse;align-items:flex-end;gap:12px;pointer-events:none}
.sgtc-left{position:absolute;left:var(--pl);bottom:var(--pb);display:flex;gap:14px;pointer-events:none}

.sgtc-drift{width:86px;height:86px;font-size:13px;--a:var(--mg)}
.sgtc-item{width:76px;height:76px;--a:var(--cy)}
.sgtc-gas{width:74px;height:74px;--a:var(--gn)}
.sgtc-brake{width:72px;height:72px;--a:var(--rd)}
.sgtc-back{width:52px;height:52px;font-size:10px;--a:var(--cy)}
.sgtc-look{width:52px;height:52px;font-size:10px;--a:var(--am)}
.sgtc-lift{width:52px;height:52px;font-size:10px;--a:var(--am)}
.sgtc-arrow{width:82px;height:82px;font-size:26px;letter-spacing:0;--a:var(--cy)}
.sgtc-cal{width:60px;height:60px;font-size:9px;--a:var(--am);
  position:absolute;left:var(--pl);bottom:var(--pb)}

/* BRAKE has no visibility rule at all -- it is always on screen. The auto
   throttle in input.ts already stands down the moment brake passes 0.15, so the
   pad has always worked in auto mode; it simply was not drawn, which left the
   default phone setup with no way to slow down on purpose. GAS is the one pad
   that is conditional, because with auto on it is a no-op. */
.sgtc-gas{display:none}
.sgtc[data-accel="manual"] .sgtc-gas,
.sgtc[data-scheme="buttons"] .sgtc-gas{display:flex}
.sgtc-lift{display:none}
.sgtc[data-lift="on"] .sgtc-lift{display:flex}
.sgtc-left{display:none}
.sgtc[data-scheme="buttons"] .sgtc-left{display:flex}
.sgtc-cal{display:none}
.sgtc[data-scheme="tilt"][data-tilt="on"] .sgtc-cal{display:flex}

.sgtc-zone{position:absolute;left:0;bottom:0;width:52%;height:64%;
  pointer-events:auto;touch-action:none;display:none}
.sgtc[data-scheme="stick"] .sgtc-zone{display:block}
.sgtc[data-scheme="tilt"][data-tilt="off"] .sgtc-zone{display:block}
.sgtc-base,.sgtc-knob{position:absolute;left:0;top:0;border-radius:50%;
  pointer-events:none;opacity:0;transition:opacity .13s ease-out}
/* THE WELL IS SIZED FROM THE TRAVEL, never typed in. The knob's edge has to
   meet the rim at exactly full lock, or the drawn control lies about how much
   lock is left: at 50px of travel in a 150px well the player reached the
   visible rim at about 0.80 and the last fifth of the lock lived outside it,
   which reads as a stick that has run out of range. */
.sgtc-base{width:${2 * (STICK_RADIUS + STICK_KNOB_R)}px;height:${2 * (STICK_RADIUS + STICK_KNOB_R)}px;
  margin:${-(STICK_RADIUS + STICK_KNOB_R)}px 0 0 ${-(STICK_RADIUS + STICK_KNOB_R)}px;
  border:2px solid rgb(var(--cy) / .32);
  background:radial-gradient(circle,rgba(10,26,48,.36),rgba(10,26,48,.04) 72%);
  box-shadow:inset 0 0 30px rgb(var(--cy) / .18)}
.sgtc-knob{width:${2 * STICK_KNOB_R}px;height:${2 * STICK_KNOB_R}px;
  margin:${-STICK_KNOB_R}px 0 0 ${-STICK_KNOB_R}px;
  border:2px solid rgb(var(--cy) / .85);
  background:radial-gradient(circle at 50% 34%,rgb(var(--cy) / .55),rgba(10,26,48,.55));
  box-shadow:0 0 26px rgb(var(--cy) / .5)}
.sgtc-zone.live .sgtc-base,.sgtc-zone.live .sgtc-knob{opacity:1}
/* THE STRAIN. \`--over\` runs 0 at the rim to 1 at full lock, written by the
   pointermove handler. The knob has pinned by now, so this is the only thing
   left telling the player that leaning harder is still doing something -- and
   the previous pass's objection (a drawn rim that is not the end of the lock
   reads as a stick that has run out) is answered here rather than by putting
   the rim back at full lock.

   It brightens and tightens rather than growing: a well that GREW would
   suggest more travel is available, which is the opposite of true. Transitions
   are off because this tracks a finger, and the reduced-motion block below
   already removes the opacity fade for the same reason. */
.sgtc-base.over{
  border-color:rgb(var(--cy) / calc(.32 + .55 * var(--over,0)));
  box-shadow:inset 0 0 calc(30px - 14px * var(--over,0)) rgb(var(--cy) / calc(.18 + .5 * var(--over,0))),
             0 0 calc(10px * var(--over,0)) rgb(var(--cy) / calc(.4 * var(--over,0)));
  transition:none}

/* --- bottom-left teaching stack ---------------------------------------------
   The steering zone is the lower LEFT of the screen, so the thing that explains
   it belongs in that corner rather than floating over the racing line. Two
   pieces, stacked, bottom-aligned:

     .sgtc-pad   a watermark of the thumb zone. It is deliberately drawn as an
                 unfilled outline at low opacity and is pointer-events:none, so
                 it reads as a diagram of where the thumb goes rather than as a
                 button to press -- and, more importantly, so a thumb landing on
                 it goes straight through to the live steering zone underneath.

     .sgtc-hint  the tilt notice, which IS a button (it is the user gesture iOS
                 needs before it will hand over the orientation sensor).

   WHAT THE WATERMARK SAYS. The left zone is a floating stick that reads its
   HORIZONTAL travel only (see bindStick: dx steers, dy moves the knob and
   nothing else). There is no throttle or brake on this axis in any of the three
   schemes. So the graphic is a left/right axis and nothing else, and the
   sub-label names where forward and slowing down actually come from. Both
   variants of that line end in "BRAKE >", because the brake pad is on the
   opposite edge in both throttle modes; only the gas half changes. */
.sgtc-lh{position:absolute;left:var(--pl);bottom:var(--pb);display:none;
  flex-direction:column;align-items:flex-start;gap:8px;pointer-events:none;
  max-width:min(52vw,300px)}
.sgtc[data-scheme="stick"] .sgtc-lh,
.sgtc[data-scheme="tilt"][data-tilt="off"] .sgtc-lh{display:flex}

/* CONTRAST WITHOUT A PANEL. A flat opacity on the whole block reads beautifully
   on Rustfall's night road and disappears completely on Cryostatic's lit snow
   or a blown-out white frame -- and a CSS drop-shadow filter cannot save it,
   because the shadow is derived from the source alpha and fades with it. So the
   dimming is per-stroke, at full alpha, over a soft radial scrim that has no
   edge and no border: on a dark surface it is invisible, on a bright one it is
   the only reason the diagram survives. It stays a watermark either way. */
.sgtc-pad{display:flex;flex-direction:column;align-items:flex-start;gap:2px;
  color:rgb(var(--cy))}
.sgtc-pad__svg{display:block;width:var(--padsz,86px);height:var(--padsz,86px);
  background:radial-gradient(closest-side,rgba(4,9,18,.46),rgba(4,9,18,0) 84%)}
.sgtc-pad__ring{fill:none;stroke:currentColor;stroke-width:2.5;opacity:.36;
  stroke-dasharray:7 9;stroke-linecap:round}
.sgtc-pad__axis{fill:none;stroke:currentColor;stroke-width:2.5;opacity:.32;
  stroke-linecap:round}
.sgtc-pad__arrow{fill:none;stroke:currentColor;stroke-width:5;opacity:.62;
  stroke-linecap:round;stroke-linejoin:round}
.sgtc-pad__knob{fill:rgba(6,14,28,.5);stroke:currentColor;stroke-width:2.5;
  opacity:.55}
.sgtc-pad__lbl{font-size:9px;font-weight:800;letter-spacing:.20em;
  color:rgb(var(--cy) / .72);
  text-shadow:0 1px 2px rgba(0,0,0,.95),0 0 9px rgba(0,0,0,.9)}
.sgtc-pad__sub{font-size:8px;font-weight:700;letter-spacing:.14em;
  color:rgb(var(--cy) / .56);display:none;white-space:nowrap;
  text-shadow:0 1px 2px rgba(0,0,0,.95),0 0 9px rgba(0,0,0,.9)}
/* The arrow means "the pads are over there", so it has to follow them: the
   one-handed LEFT layout puts the action cluster on the left and moves this
   whole block to the right, and an arrow still pointing right would be sending
   the player to the empty corner. */
.sgtc-pad__arw{display:inline-block}
.sgtc.oh.ohl .sgtc-pad__arw{transform:scaleX(-1)}
.sgtc[data-accel="auto"] .sgtc-pad__auto{display:block}
.sgtc[data-accel="manual"] .sgtc-pad__man{display:block}

.sgtc-hint{display:flex;align-items:center;min-height:44px;
  padding:9px 14px;border-radius:14px;pointer-events:auto;touch-action:none;
  border:2px solid rgb(var(--am) / .5);background:rgba(8,16,32,.5);
  color:rgb(var(--am));font-size:11px;font-weight:800;letter-spacing:.08em;
  line-height:1.25;
  text-shadow:0 0 10px rgb(var(--am) / .7);box-shadow:0 0 22px rgb(var(--am) / .22);
  -webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}
.sgtc[data-scheme="stick"] .sgtc-hint{display:none}

.sgtc-tiltbar{position:absolute;left:50%;bottom:calc(var(--pb) + 4px);
  transform:translateX(-50%);width:184px;height:6px;border-radius:3px;display:none;
  background:rgba(8,16,32,.5);box-shadow:inset 0 0 0 1px rgb(var(--cy) / .28)}
.sgtc[data-scheme="tilt"][data-tilt="on"] .sgtc-tiltbar{display:block}
.sgtc-tiltmark{position:absolute;left:50%;top:50%;width:20px;height:20px;
  margin:-10px 0 0 -10px;border-radius:50%;background:rgb(var(--cy) / .85);
  box-shadow:0 0 16px rgb(var(--cy) / .8);will-change:transform}

.sgtc.oh .sgtc-zone{left:auto;right:0;width:62%;height:74%}
.sgtc.oh.ohl .sgtc-zone{left:0;right:auto}
.sgtc.oh .sgtc-left{left:auto;right:var(--pr);bottom:calc(var(--pb) + 268px)}
.sgtc.oh.ohl .sgtc-left{right:auto;left:var(--pl)}
.sgtc.oh.ohl .sgtc-right{right:auto;left:var(--pl);align-items:flex-start}
.sgtc.oh.ohl .sgtc-row{flex-direction:row}
.sgtc.oh.ohl .sgtc-cal{left:auto;right:var(--pr)}
/* One-handed LEFT puts the action cluster in this corner, so the whole
   teaching stack moves out of its way -- same swap the notice alone used to
   make, now applied to the block that contains it. */
.sgtc.oh.ohl .sgtc-lh{left:auto;right:var(--pl);align-items:flex-end}

@media (max-height:430px){
  .sgtc-drift{width:74px;height:74px}
  .sgtc-item{width:66px;height:66px}
  .sgtc-gas{width:64px;height:64px}
  .sgtc-brake{width:62px;height:62px}
  .sgtc-back,.sgtc-look,.sgtc-lift{width:48px;height:48px;font-size:9px}
  .sgtc-arrow{width:72px;height:72px}
  .sgtc-right{gap:10px}
  .sgtc-row{gap:10px}
  .sgtc.oh .sgtc-left{bottom:calc(var(--pb) + 232px)}
  /* A landscape phone is ~390-430px tall and the teaching stack is the tallest
     thing in the corner. Shrink the diagram, not the notice. */
  .sgtc-lh{gap:5px;max-width:min(40vw,244px)}
  .sgtc-pad{--padsz:62px;gap:0}
  .sgtc-pad__lbl{font-size:8px;letter-spacing:.16em}
  /* Shorter padding, NOT a shorter button. This used to also say
     min-height:0, which took the one button in this corner -- the tap iOS
     needs before it will hand over the tilt sensor -- down to ~31px on every
     landscape phone. 44px is the floor for anything a thumb has to hit; the
     padding shrinks, the target does not. */
  .sgtc-hint{min-height:44px;padding:7px 12px;font-size:11px}
}
/* Portrait: the action cluster is a tall stack up the right edge and the HUD's
   instrument strip has to lift clear of it, so the teaching block cannot also
   be a tall column in the opposite corner. Lay it out as a row instead -- same
   two pieces, half the height. */
@media (orientation:portrait){
  /* PORTRAIT PUTS THE HUD'S INSTRUMENT BAND AT ROW 2's HEIGHT. styles.css lifts
     the band by 116px -- one pad plus this layer's bottom inset -- which clears
     the BOTTOM row of pads and nothing above it, so the inner column of row 2
     lands on the band's right end and covers the boost count. That was already
     true of the Brake pad when it lived in row 2; it is the Gas pad's slot now.
     Row 1 is the corner the thumb rests in and must not move, so the clearance
     goes between the rows instead: in column-reverse a margin under row 2 opens
     the gap above row 1 and carries row 3 with it. Only when Gas is actually on
     screen -- with auto throttle on, row 2 is one Item pad well clear of the
     band's right edge and there is nothing to move out of the way. */
  .sgtc[data-accel="manual"] .sgtc-row:nth-child(2),
  .sgtc[data-scheme="buttons"] .sgtc-row:nth-child(2){margin-bottom:48px}
  .sgtc-lh{flex-direction:row;align-items:flex-end;gap:10px;
    max-width:min(64vw,320px)}
  .sgtc-pad{--padsz:62px}
  .sgtc-pad__lbl{font-size:8px;letter-spacing:.14em}
  /* As above: a tighter button, never a target under 44px. */
  .sgtc-hint{min-height:44px;padding:8px 12px;font-size:11px}
}

@media (prefers-reduced-motion:reduce){
  .sgtc-btn{transition:none}
  .sgtc-base,.sgtc-knob{transition:none}
}
`

function injectStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return
  const s = doc.createElement('style')
  s.id = STYLE_ID
  s.textContent = CSS
  doc.head.appendChild(s)
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface Bound { t: EventTarget; k: string; f: EventListener; c: boolean }

class TouchControlsImpl implements TouchControls {
  readonly root: HTMLElement

  onTiltUnavailable: (() => void) | null = null
  onTouchActivity: (() => void) | null = null

  // --- raw control state, written synchronously by pointer handlers -------
  private dDrift = false
  private dItem = false
  private dBack = false
  private dGas = false
  private dBrake = false
  private dLift = false
  private dLook = false
  private dArrowL = false
  private dArrowR = false

  private padSteer = 0
  private stickSteer = 0
  /** 0 at the rim, 1 at full lock. Drives the drawn strain only. */
  private stickOver = 0
  /**
   * The player's steering preferences, from settings.
   *
   * Held rather than read per move: a pointermove handler runs at the touch
   * sample rate and has no business reaching into storage. `setStickTune` is
   * the only writer.
   */
  private tune: StickTune = { ...DEFAULT_STICK_TUNE }
  private tiltTarget = 0
  private tiltSteer = 0

  private scheme: TouchScheme = 'tilt'
  private autoAccel = true
  private oneHanded = false
  private tiltInvert = false
  private tiltCenter = 0
  private tiltNeedsCentre = true
  private tiltOn = false
  private tiltState: 'idle' | 'asking' | 'waiting' | 'active' | 'off' = 'idle'
  private tiltProbe = 0
  private lastMarkPx = -9999

  // --- pointer bookkeeping ------------------------------------------------
  private readonly pointers = new Map<number, number>()
  private readonly counts = new Int8Array(K_COUNT)
  private stickId = -1
  private stickOx = 0
  private stickOy = 0
  private zoneLeft = 0
  private zoneTop = 0
  private arrowId = -1
  private arrowSplit = 0
  private arrowLo = 0
  private arrowHi = 0

  private readonly bounds: Bound[] = []
  private readonly kindEls: (HTMLElement | null)[] = new Array<HTMLElement | null>(K_COUNT).fill(null)
  private disposed = false

  // --- elements -----------------------------------------------------------
  private readonly zone: HTMLElement
  private readonly base: HTMLElement
  private readonly knob: HTMLElement
  private readonly arrowL: HTMLElement
  private readonly arrowR: HTMLElement
  private readonly tiltMark: HTMLElement
  private readonly btnEls: HTMLElement[] = []

  constructor(container: HTMLElement) {
    const doc = container.ownerDocument
    injectStyle(doc)

    const root = doc.createElement('div')
    root.className = 'sgtc off'
    root.dataset.scheme = 'tilt'
    root.dataset.tilt = 'off'
    root.dataset.accel = 'auto'
    root.dataset.lift = 'off'
    this.root = root

    // Steering surface (floating stick) — left half of the lower band.
    this.zone = mk(doc, 'div', 'sgtc-zone', root)
    this.base = mk(doc, 'div', 'sgtc-base', this.zone)
    this.knob = mk(doc, 'div', 'sgtc-knob', this.zone)

    // Right-edge action cluster. Row order is bottom-up; each row is laid out
    // right-to-left so the first child sits in the outer lower corner.
    //
    // TWO COLUMNS, TWO JOBS. The outer column is the corner the thumb rests in:
    // DRIFT, then ITEM above it, then BACK. The column inboard of it is the
    // pedals: BRAKE, then GAS directly above it. That gives the arrangement the
    // controls actually need:
    //
    //   * BRAKE sits immediately inboard of DRIFT, the shortest move on the
    //     cluster, because braking mid-slide (and ITEM + BRAKE, which fires an
    //     item backwards) are things you do WHILE drifting.
    //   * GAS and BRAKE share a column and are never wanted at the same time,
    //     so one digit works them like pedals and never has to leave DRIFT to
    //     find the throttle.
    //   * Nothing moves when the player turns auto-accelerate off. GAS appears
    //     in the empty slot above BRAKE; DRIFT, BRAKE and ITEM keep the exact
    //     positions they had, so muscle memory survives the switch.
    //
    // In the one-handed LEFT layout the rows flip to `row` (see .oh.ohl) and
    // the whole thing mirrors: BRAKE ends up immediately inboard of DRIFT on
    // that side too, which is the same relationship, not a different one.
    const right = mk(doc, 'div', 'sgtc-right', root)
    const row1 = mk(doc, 'div', 'sgtc-row', right)
    const row2 = mk(doc, 'div', 'sgtc-row', right)
    const row3 = mk(doc, 'div', 'sgtc-row', right)
    this.mkBtn(doc, 'sgtc-drift', 'DRIFT', row1, K_DRIFT)
    this.mkBtn(doc, 'sgtc-brake', 'BRAKE', row1, K_BRAKE)
    this.mkBtn(doc, 'sgtc-item', 'ITEM', row2, K_ITEM)
    this.mkBtn(doc, 'sgtc-gas', 'GAS', row2, K_GAS)
    this.mkBtn(doc, 'sgtc-back', 'BACK', row3, K_BACK)
    this.mkBtn(doc, 'sgtc-look', 'LOOK', row3, K_LOOK)
    this.mkBtn(doc, 'sgtc-lift', 'LIFT', row3, K_LIFT)

    // Discrete steering pads, bottom-left, 'buttons' scheme only.
    const left = mk(doc, 'div', 'sgtc-left', root)
    this.arrowL = this.mkBtn(doc, 'sgtc-arrow', '◀', left, 0)
    this.arrowR = this.mkBtn(doc, 'sgtc-arrow', '▶', left, 0)
    this.bindArrows(left)

    // Tilt affordances.
    this.mkBtn(doc, 'sgtc-cal', 'RE-CENTRE', root, K_CAL)

    // Bottom-left teaching stack: thumb-zone watermark over the tilt notice.
    // Built once, never touched again -- everything that varies (which scheme,
    // auto or manual throttle) is already a data-attribute on the root, so CSS
    // does the switching and no code runs per frame.
    const lh = mk(doc, 'div', 'sgtc-lh', root)
    const pad = mk(doc, 'div', 'sgtc-pad', lh)
    mkSvg(doc, PAD_SVG, pad)
    mk(doc, 'div', 'sgtc-pad__lbl', pad).textContent = 'SLIDE TO STEER'
    mkSub(doc, pad, 'sgtc-pad__auto', 'GAS: AUTO / BRAKE ')
    mkSub(doc, pad, 'sgtc-pad__man', 'GAS / BRAKE ')
    const hint = mk(doc, 'div', 'sgtc-hint', lh)
    hint.textContent = 'TAP TO ENABLE TILT STEERING'
    hint.setAttribute('role', 'button')
    this.bindMomentary(hint, K_HINT)
    const bar = mk(doc, 'div', 'sgtc-tiltbar', root)
    this.tiltMark = mk(doc, 'div', 'sgtc-tiltmark', bar)

    this.bindStick()

    // Kill scroll, pull-to-refresh, double-tap zoom and long-press menus.
    this.on(root, 'contextmenu', preventer, { passive: false })
    this.on(root, 'dblclick', preventer, { passive: false })
    this.on(root, 'selectstart', preventer, { passive: false })
    this.on(root, 'touchstart', this.onTouchRaw, { passive: false })
    this.on(root, 'touchmove', this.onTouchRaw, { passive: false })

    const win = doc.defaultView
    if (win) {
      this.on(win, 'pointerup', this.onGlobalUp)
      this.on(win, 'pointercancel', this.onGlobalUp)
      this.on(win, 'lostpointercapture', this.onGlobalUp)
      this.on(win, 'blur', this.onBlur)
      this.on(win, 'resize', this.onGeomChange)
      this.on(win, 'orientationchange', this.onGeomChange)
    }

    container.appendChild(root)
  }

  // -------------------------------------------------------------------------
  // Construction helpers
  // -------------------------------------------------------------------------

  private on(t: EventTarget, k: string, f: EventListener, opts?: AddEventListenerOptions): void {
    t.addEventListener(k, f, opts)
    this.bounds.push({ t, k, f, c: opts?.capture === true })
  }

  private mkBtn(doc: Document, cls: string, label: string, parent: HTMLElement, kind: number): HTMLElement {
    const b = mk(doc, 'div', 'sgtc-btn ' + cls, parent)
    b.textContent = label
    b.setAttribute('role', 'button')
    b.setAttribute('aria-label', label)
    this.btnEls.push(b)
    if (kind === K_CAL || kind === K_HINT) this.bindMomentary(b, kind)
    else if (kind > 0) this.bindHold(b, kind)
    return b
  }

  /** Held button: down sets the flag, up/cancel clears it. Multitouch safe. */
  private bindHold(b: HTMLElement, kind: number): void {
    this.kindEls[kind] = b
    const down = (ev: Event): void => {
      const e = ev as PointerEvent
      e.preventDefault()
      if (this.pointers.has(e.pointerId)) return
      this.pointers.set(e.pointerId, kind)
      try { b.setPointerCapture(e.pointerId) } catch { /* capture is best effort */ }
      if (++this.counts[kind] === 1) {
        b.classList.add('on')
        this.setKind(kind, true)
      }
      this.activity()
    }
    const up = (ev: Event): void => {
      const e = ev as PointerEvent
      e.preventDefault()
      if (this.pointers.get(e.pointerId) !== kind) return
      this.pointers.delete(e.pointerId)
      try { b.releasePointerCapture(e.pointerId) } catch { /* already gone */ }
      if (--this.counts[kind] <= 0) {
        this.counts[kind] = 0
        b.classList.remove('on')
        this.setKind(kind, false)
      }
    }
    this.on(b, 'pointerdown', down, { passive: false })
    this.on(b, 'pointerup', up, { passive: false })
    this.on(b, 'pointercancel', up, { passive: false })
  }

  /** Momentary button: fires once on press, no held state. */
  private bindMomentary(b: HTMLElement, kind: number): void {
    const down = (ev: Event): void => {
      const e = ev as PointerEvent
      e.preventDefault()
      b.classList.add('on')
      this.setKind(kind, true)
      this.activity()
      const clear = (): void => { b.classList.remove('on') }
      window.setTimeout(clear, 110)
    }
    this.on(b, 'pointerdown', down, { passive: false })
  }

  /**
   * The two arrow pads share one capture on their container so a thumb can
   * slide from one to the other without lifting.
   */
  private bindArrows(host: HTMLElement): void {
    const apply = (x: number): void => {
      const l = x < this.arrowSplit && x >= this.arrowLo - 30
      const r = x >= this.arrowSplit && x <= this.arrowHi + 30
      if (l !== this.dArrowL) { this.dArrowL = l; this.arrowL.classList.toggle('on', l) }
      if (r !== this.dArrowR) { this.dArrowR = r; this.arrowR.classList.toggle('on', r) }
    }
    const down = (ev: Event): void => {
      const e = ev as PointerEvent
      e.preventDefault()
      if (this.arrowId >= 0) return
      const a = this.arrowL.getBoundingClientRect()
      const b = this.arrowR.getBoundingClientRect()
      this.arrowLo = Math.min(a.left, b.left)
      this.arrowHi = Math.max(a.right, b.right)
      this.arrowSplit = (a.right + b.left) * 0.5
      this.arrowId = e.pointerId
      this.pointers.set(e.pointerId, K_ARROWS)
      try { host.setPointerCapture(e.pointerId) } catch { /* best effort */ }
      apply(e.clientX)
      this.activity()
    }
    const move = (ev: Event): void => {
      const e = ev as PointerEvent
      if (e.pointerId !== this.arrowId) return
      e.preventDefault()
      apply(e.clientX)
    }
    const up = (ev: Event): void => {
      const e = ev as PointerEvent
      if (e.pointerId !== this.arrowId) return
      e.preventDefault()
      this.arrowId = -1
      this.pointers.delete(e.pointerId)
      try { host.releasePointerCapture(e.pointerId) } catch { /* already gone */ }
      this.clearArrows()
    }
    this.on(host, 'pointerdown', down, { passive: false })
    this.on(host, 'pointermove', move, { passive: false })
    this.on(host, 'pointerup', up, { passive: false })
    this.on(host, 'pointercancel', up, { passive: false })
  }

  /** Floating stick: the origin is wherever the thumb lands, not a fixed spot. */
  private bindStick(): void {
    const z = this.zone
    const down = (ev: Event): void => {
      const e = ev as PointerEvent
      e.preventDefault()
      if (this.stickId >= 0) return
      const r = z.getBoundingClientRect()
      this.zoneLeft = r.left
      this.zoneTop = r.top
      this.stickId = e.pointerId
      this.stickOx = e.clientX
      this.stickOy = e.clientY
      this.pointers.set(e.pointerId, K_STICK)
      try { z.setPointerCapture(e.pointerId) } catch { /* best effort */ }
      z.classList.add('live')
      const lx = e.clientX - this.zoneLeft
      const ly = e.clientY - this.zoneTop
      this.base.style.transform = 'translate3d(' + lx + 'px,' + ly + 'px,0)'
      this.knob.style.transform = 'translate3d(' + lx + 'px,' + ly + 'px,0)'
      this.stickSteer = 0
      this.stickOver = 0
      this.base.style.setProperty('--over', '0')
      this.base.classList.remove('over')
      this.applyTuneToWell()
      this.activity()
    }
    const move = (ev: Event): void => {
      const e = ev as PointerEvent
      if (e.pointerId !== this.stickId) return
      e.preventDefault()
      // The anchor is fixed for the life of the gesture -- see the note above
      // where stickOrigin used to be. dx steers; dy only carries the knob,
      // which is what the `.sgtc-pad` watermark has always claimed it did.
      const dx = e.clientX - this.stickOx
      const dy = e.clientY - this.stickOy
      this.stickSteer = stickSteerFrom(dx, this.tune)
      /*
       * THE KNOB PINS AT THE RIM, and the well reports the strain.
       *
       * Letting the knob follow the thumb out to arm's length would put the
       * drawn control somewhere the player is not looking and break the one
       * thing the well is for: showing where the edge is. Pinning it keeps the
       * edge where the thumb last felt it.
       *
       * But a knob that simply stops reads as a control that has stopped
       * working, which is the objection the previous pass raised against a rim
       * that was not full lock -- and it was right. So overtravel is drawn
       * rather than swallowed: the well tightens and brightens with how hard
       * the player is leaning, so the edge stays legibly alive.
       */
      const radius = STICK_RADIUS * this.tune.throw
      const len = Math.hypot(dx, dy)
      const k = len > radius ? radius / len : 1
      const kx = this.stickOx + dx * k - this.zoneLeft
      const ky = this.stickOy + dy * k - this.zoneTop
      this.knob.style.transform = 'translate3d(' + kx + 'px,' + ky + 'px,0)'
      const over = stickOvertravel(dx, this.tune)
      if (over !== this.stickOver) {
        this.stickOver = over
        this.base.style.setProperty('--over', String(over))
        this.base.classList.toggle('over', over > 0)
      }
    }
    const up = (ev: Event): void => {
      const e = ev as PointerEvent
      if (e.pointerId !== this.stickId) return
      e.preventDefault()
      this.stickId = -1
      this.pointers.delete(e.pointerId)
      try { z.releasePointerCapture(e.pointerId) } catch { /* already gone */ }
      z.classList.remove('live')
      this.stickSteer = 0
      this.stickOver = 0
      this.base.classList.remove('over')
    }
    this.on(z, 'pointerdown', down, { passive: false })
    this.on(z, 'pointermove', move, { passive: false })
    this.on(z, 'pointerup', up, { passive: false })
    this.on(z, 'pointercancel', up, { passive: false })
  }

  // -------------------------------------------------------------------------
  // State plumbing
  // -------------------------------------------------------------------------

  /**
   * Apply the player's steering preferences. Safe to call at any time.
   *
   * The well is resized from `throw` rather than being a fixed sprite, for the
   * same reason the constant sized it in the first place: a drawn rim that
   * does not sit where the control's rim sits is a control that lies about
   * itself, and this pass has just made the rim mean something specific.
   */
  setStickTune(tune: StickTune): void {
    this.tune = {
      gain: clampRange(tune.gain, STICK_GAIN_RANGE),
      throw: clampRange(tune.throw, STICK_THROW_RANGE),
    }
    this.applyTuneToWell()
  }

  private applyTuneToWell(): void {
    const r = (STICK_RADIUS + STICK_KNOB_R) * this.tune.throw
    this.base.style.width = 2 * r + 'px'
    this.base.style.height = 2 * r + 'px'
    this.base.style.margin = -r + 'px 0 0 ' + -r + 'px'
    const k = STICK_KNOB_R * this.tune.throw
    this.knob.style.width = 2 * k + 'px'
    this.knob.style.height = 2 * k + 'px'
    this.knob.style.margin = -k + 'px 0 0 ' + -k + 'px'
  }

  private setKind(kind: number, on: boolean): void {
    switch (kind) {
      case K_DRIFT: this.dDrift = on; break
      case K_ITEM: this.dItem = on; break
      case K_BACK: this.dBack = on; break
      case K_GAS: this.dGas = on; break
      case K_BRAKE: this.dBrake = on; break
      case K_LIFT: this.dLift = on; break
      case K_LOOK: this.dLook = on; break
      case K_CAL: if (on) this.calibrateTilt(); break
      case K_HINT: if (on) this.requestTiltPermission(true); break
      default: break
    }
  }

  private activity(): void {
    const cb = this.onTouchActivity
    if (cb) cb()
  }

  private clearArrows(): void {
    if (this.dArrowL) { this.dArrowL = false; this.arrowL.classList.remove('on') }
    if (this.dArrowR) { this.dArrowR = false; this.arrowR.classList.remove('on') }
  }

  private clearAll(): void {
    this.pointers.clear()
    this.counts.fill(0)
    for (let i = 0; i < this.btnEls.length; i++) this.btnEls[i].classList.remove('on')
    this.dDrift = false; this.dItem = false; this.dBack = false
    this.dGas = false; this.dBrake = false; this.dLift = false; this.dLook = false
    this.dArrowL = false; this.dArrowR = false
    this.padSteer = 0
    this.stickSteer = 0
    this.stickId = -1
    this.arrowId = -1
    this.zone.classList.remove('live')
  }

  private onTouchRaw = (e: Event): void => {
    // Anything that reaches the overlay started on a control surface: stop the
    // browser from scrolling, rubber-banding or zooming the page mid-race.
    if (e.cancelable) e.preventDefault()
  }

  private onGlobalUp = (ev: Event): void => {
    const e = ev as PointerEvent
    const kind = this.pointers.get(e.pointerId)
    if (kind === undefined) return
    this.pointers.delete(e.pointerId)
    if (kind === K_STICK) {
      this.stickId = -1
      this.zone.classList.remove('live')
      this.stickSteer = 0
    } else if (kind === K_ARROWS) {
      this.arrowId = -1
      this.clearArrows()
    } else if (kind > 0 && kind < K_COUNT) {
      if (--this.counts[kind] <= 0) {
        this.counts[kind] = 0
        this.setKind(kind, false)
        const el = this.kindEls[kind]
        if (el) el.classList.remove('on')
      }
    }
  }

  private onBlur = (): void => { this.clearAll() }

  private onGeomChange = (): void => {
    this.clearAll()
    this.tiltNeedsCentre = true
  }

  // -------------------------------------------------------------------------
  // Tilt steering
  // -------------------------------------------------------------------------

  private permOk = false
  private orientAttached = false
  private lastRawDeg = 0

  get tiltActive(): boolean { return this.tiltOn }

  requestTiltPermission(fromGesture: boolean): void {
    if (this.disposed || this.tiltOn || this.tiltState === 'asking') return
    const d = doeStatic()
    if (!d) { this.tiltFailed(); return }
    if (this.permOk) { this.attachOrient(); return }
    if (typeof d.requestPermission === 'function') {
      // iOS 13+: this MUST run inside a user gesture, so if we are not in one
      // we stay idle and let the on-screen hint (a real tap) drive it.
      if (!fromGesture) { this.tiltState = 'idle'; return }
      this.tiltState = 'asking'
      d.requestPermission().then((res: string): void => {
        if (this.disposed) return
        if (res === 'granted') { this.permOk = true; this.attachOrient() } else { this.tiltFailed() }
      }).catch((): void => {
        // Usually "requires a user gesture" — stay idle so a tap can retry.
        if (!this.disposed) this.tiltState = 'idle'
      })
      return
    }
    this.permOk = true
    this.attachOrient()
  }

  private attachOrient(): void {
    if (this.orientAttached) return
    const win = this.root.ownerDocument.defaultView
    if (!win) { this.tiltFailed(); return }
    this.orientAttached = true
    this.tiltState = 'waiting'
    this.tiltNeedsCentre = true
    win.addEventListener('deviceorientation', this.onOrient)
    // Some browsers expose the API on hardware that never reports. Give the
    // sensor a moment, then fall back rather than leaving the player stranded.
    this.tiltProbe = win.setTimeout((): void => {
      if (!this.disposed && this.tiltState === 'waiting') this.tiltFailed()
    }, TILT_PROBE_MS)
  }

  private detachOrient(): void {
    if (!this.orientAttached) return
    this.orientAttached = false
    const win = this.root.ownerDocument.defaultView
    if (win) {
      win.removeEventListener('deviceorientation', this.onOrient)
      if (this.tiltProbe) { win.clearTimeout(this.tiltProbe); this.tiltProbe = 0 }
    }
    this.tiltOn = false
    this.tiltSteer = 0
    this.tiltTarget = 0
    this.root.dataset.tilt = 'off'
    if (this.tiltState === 'waiting' || this.tiltState === 'active') this.tiltState = 'idle'
  }

  private tiltFailed(): void {
    this.detachOrient()
    this.tiltState = 'off'
    const cb = this.onTiltUnavailable
    if (cb) cb()
  }

  private onOrient = (ev: Event): void => {
    const e = ev as DeviceOrientationEvent
    if (e.beta === null && e.gamma === null) return
    if (this.tiltProbe) {
      const win = this.root.ownerDocument.defaultView
      if (win) win.clearTimeout(this.tiltProbe)
      this.tiltProbe = 0
    }
    if (!this.tiltOn) {
      this.tiltOn = true
      this.tiltState = 'active'
      this.root.dataset.tilt = 'on'
    }
    const raw = tiltRollDeg(e.beta ?? 0, e.gamma ?? 0, screenAngleDeg())
    this.lastRawDeg = raw
    if (this.tiltNeedsCentre) { this.tiltNeedsCentre = false; this.tiltCenter = raw }
    let a = raw - this.tiltCenter
    if (this.tiltInvert) a = -a
    const t = axisCurve(a / TILT_FULL_DEG, TILT_DEADZONE_DEG / TILT_FULL_DEG)
    this.tiltTarget = t
    // Cheap, event-rate-only indicator update. Never touched from sample().
    const px = Math.round(t * 82)
    if (px !== this.lastMarkPx) {
      this.lastMarkPx = px
      this.tiltMark.style.transform = 'translateX(' + px + 'px)'
    }
  }

  calibrateTilt(): void {
    this.tiltNeedsCentre = true
    this.tiltCenter = this.lastRawDeg
    this.tiltTarget = 0
    this.tiltSteer = 0
  }

  setTiltInvert(on: boolean): void { this.tiltInvert = on }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  /** Allocation-free: reads scalars written by the pointer/sensor handlers. */
  sample(out: InputFrame): void {
    let steer = 0
    const s = this.scheme
    if (s === 'tilt') {
      if (this.tiltOn) {
        this.tiltSteer = damp(this.tiltSteer, this.tiltTarget, TILT_HALF_LIFE, DT)
        steer = this.tiltSteer
      } else {
        // Tilt not granted yet: the floating stick stays live so the player is
        // never left without steering.
        steer = this.stickSteer
      }
    } else if (s === 'stick') {
      steer = this.stickSteer
    } else {
      const target = (this.dArrowL ? -1 : 0) + (this.dArrowR ? 1 : 0)
      this.padSteer = rampAxis(this.padSteer, target, DT)
      steer = this.padSteer
    }
    out.steer = steer
    out.throttle = this.dGas ? 1 : 0
    out.brake = this.dBrake ? 1 : 0
    out.drift = this.dDrift
    out.item = this.dItem || this.dBack
    out.itemBack = this.dBack || (this.dItem && this.dBrake)
    out.lift = this.dLift
    out.lookBack = this.dLook
  }

  setScheme(s: 'tilt' | 'stick' | 'buttons'): void {
    if (this.scheme !== s) {
      this.scheme = s
      this.root.dataset.scheme = s
      this.clearAll()
    }
    // Idempotent on purpose: the host may (re)select 'tilt' while the field
    // already reads 'tilt', and that must still arm the sensor.
    if (s === 'tilt') this.requestTiltPermission(false)
    else this.detachOrient()
  }

  setVisible(v: boolean): void {
    this.root.classList.toggle('off', !v)
    if (!v) this.clearAll()
  }

  setAutoAccelerate(on: boolean): void {
    this.autoAccel = on
    this.root.dataset.accel = on ? 'auto' : 'manual'
  }

  setOneHanded(on: boolean, side?: 'left' | 'right'): void {
    this.oneHanded = on
    this.root.classList.toggle('oh', on)
    this.root.classList.toggle('ohl', on && side === 'left')
  }

  setLiftEnabled(on: boolean): void { this.root.dataset.lift = on ? 'on' : 'off' }

  /** Exposed for a settings UI that wants to reflect current state. */
  get state(): { scheme: TouchScheme; autoAccel: boolean; oneHanded: boolean } {
    return { scheme: this.scheme, autoAccel: this.autoAccel, oneHanded: this.oneHanded }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.detachOrient()
    for (let i = 0; i < this.bounds.length; i++) {
      const b = this.bounds[i]
      b.t.removeEventListener(b.k, b.f, b.c)
    }
    this.bounds.length = 0
    this.pointers.clear()
    this.onTiltUnavailable = null
    this.onTouchActivity = null
    if (this.root.parentNode) this.root.parentNode.removeChild(this.root)
  }
}

/**
 * The thumb-zone watermark.
 *
 * A dashed stick base, a knob, and ONE axis: left/right. That is the whole of
 * what the left zone does -- `bindStick` steers on `dx` and throws `dy` away --
 * so the diagram has no vertical arm to imply otherwise.
 */
const PAD_SVG =
  '<svg class="sgtc-pad__svg" viewBox="0 0 120 120" aria-hidden="true" focusable="false">' +
  '<circle class="sgtc-pad__ring" cx="60" cy="60" r="46"/>' +
  '<line class="sgtc-pad__axis" x1="30" y1="60" x2="90" y2="60"/>' +
  '<path class="sgtc-pad__arrow" d="M33 47 L21 60 L33 73"/>' +
  '<path class="sgtc-pad__arrow" d="M87 47 L99 60 L87 73"/>' +
  '<circle class="sgtc-pad__knob" cx="60" cy="60" r="14"/>' +
  '</svg>'

/** Construction-time only: parse authored markup into a live SVG element. */
function mkSvg(doc: Document, markup: string, parent: HTMLElement): SVGSVGElement {
  const host = doc.createElement('div')
  host.innerHTML = markup
  const el = host.firstElementChild as SVGSVGElement
  parent.appendChild(el)
  return el
}

/**
 * One line of the watermark's sub-label, with the "over there" arrow as its own
 * element so the one-handed LEFT layout can mirror it (see .sgtc-pad__arw).
 */
function mkSub(doc: Document, parent: HTMLElement, cls: string, text: string): HTMLElement {
  const row = mk(doc, 'div', 'sgtc-pad__sub ' + cls, parent)
  row.textContent = text
  mk(doc, 'span', 'sgtc-pad__arw', row).textContent = '▶'
  return row
}

function mk(doc: Document, tag: string, cls: string, parent: HTMLElement | null): HTMLElement {
  const e = doc.createElement(tag)
  e.className = cls
  if (parent) parent.appendChild(e)
  return e
}

function preventer(e: Event): void {
  if (e.cancelable) e.preventDefault()
}

export function createTouchControls(container: HTMLElement): TouchControls {
  return new TouchControlsImpl(container)
}
