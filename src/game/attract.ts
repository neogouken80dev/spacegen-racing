/**
 * SpaceGen Racing — the attract camera.
 * ---------------------------------------------------------------------------
 * The title screen is a real race, running the real sim, seen from a camera
 * the chase rig would never put there. No local player, no HUD, no input: the
 * field drives itself and the player watches it while deciding whether to
 * press PLAY.
 *
 * WHY THIS IS A SEPARATE FILE, AND WHY MOST OF IT IS PURE
 *
 * Everything below the THREE import is arithmetic on a track sample. That is
 * deliberate, and it is the same split garagePreview.ts makes: the two rules
 * this feature has to obey -- "the push stops under prefers-reduced-motion"
 * and "the shot is anchored to the spline, not to world coordinates" -- are
 * both invisible in a screenshot and both cheap to break later. Pure, they are
 * unit-testable without a graphics driver, and tests/attract.test.ts tests
 * them.
 *
 * ANCHORED TO THE SPLINE, NOT TO A WORLD POSITION
 *
 * A camera stored as (x, y, z) is correct until somebody moves a corner, and
 * then it is silently pointing at empty vacuum with no test that fails. Stored
 * as an arc length plus a lateral and a height, the shot rides the track: edit
 * the circuit and the camera edits with it. It also means the shot is legible
 * -- `s: 3244, lateral: -10.5` says "left edge, just before the line", which
 * is a sentence about the circuit rather than three magic numbers.
 *
 * HOW THE HOLLOW CHOIR SHOT WAS CHOSEN
 *
 * Not by eye. tools/find-attract-shot.ts ranks every two metres of the lap on
 * two measurable things -- how close the road's heading is to the hero body's
 * azimuth (so the black hole is in frame) and how far you can see down the
 * road before it turns away (so cars stay on screen instead of flicking past)
 * -- and then runs an all-AI race to histogram where the field actually
 * drives, so the camera can stand in a lane the race demonstrably does not
 * use. On Hollow Choir that came out as:
 *
 *   lateral = -10.5 the quiet side. The field's own laterals cluster at -2 and
 *                   +2 (52% of racer-frames between them) and it runs wide to
 *                   +8..+20 often enough to matter, but the left edge carries
 *                   0.3%. The whole race therefore passes to the camera's
 *                   right rather than through the lens.
 *   s = 2572        the one stretch that points STRAIGHT at the hole: 0.0
 *                   degrees off its azimuth.
 *
 * AND THE ANCHOR WAS WRONG THE FIRST TIME, WHICH IS THE USEFUL PART.
 *
 * The ranking initially chose s=3244 -- a 318m sightline, only 16 degrees off
 * axis, the best combined score. The frustum test agreed: the hole projected
 * inside the view 100% of the time. Then the screenshot showed a start/finish
 * gantry filling exactly that part of the picture.
 *
 * In-frustum is not visible, and no projection test can tell the difference:
 * it knows where things are and nothing about what stands in front of them.
 * s=2572 trades most of the sightline away (56m) for a line of sight that is
 * actually clear, which is only a trade once you can see both numbers. The
 * short sightline stopped mattering once the field was spread around the lap
 * -- see spreadField -- because cars then arrive continuously instead of once
 * per lap in a convoy.
 *
 * The splash-screen stills that preceded all this were framed by pure guessing,
 * and one of them put the camera inside a barrier.
 */
import * as THREE from 'three'
import type { Track } from '../sim/track'
import type { QualityTier } from '../render/api'

/**
 * A fixed camera on a circuit, in the track's own frame.
 *
 * Everything is relative to the spline, so the shot survives an edit to the
 * circuit it is pointed at. See the file header.
 */
export interface AttractShot {
  /** Arc length of the camera's anchor along the lap, metres. */
  s: number
  /**
   * Offset from the centreline, metres. Signed the way `TrackSample.right` is.
   * Pick this from measured occupancy, not from the road's half-width: the
   * road tells you where the tarmac ends, not where eight AI drivers go.
   */
  lateral: number
  /** Height above the road surface, metres. Knee-high reads fastest. */
  height: number
  /** Yaw off the road's own heading, radians. 0 looks straight down the road. */
  yaw: number
  /** Pitch from level, radians. Positive looks up. */
  pitch: number
  /** Vertical field of view, degrees. */
  fov: number
  /**
   * How far the camera creeps over one cycle, metres. Small on purpose: this
   * exists so the screen does not read as a frozen bug in the gaps between
   * cars, not to be noticed as a move.
   */
  push: number
  /** Seconds for one full out-and-back push. */
  pushPeriod: number
}

/**
 * THE SHOTS.
 *
 * Only Hollow Choir is framed against measurement so far; the others carry a
 * sane default so that changing the attract track is a one-word edit rather
 * than a feature request. Re-run tools/find-attract-shot.ts against any track
 * to replace one of these with a measured number.
 */
export const ATTRACT_SHOTS: Record<string, AttractShot> = {
  hollowchoir: {
    s: 2572,
    lateral: -10.5,
    height: 3.0,
    yaw: 0,
    pitch: 0.040,
    fov: 58,
    push: 7.5,
    pushPeriod: 96,
  },
  rustfall: {
    s: 120, lateral: -9.5, height: 2.3, yaw: 0, pitch: 0.045,
    fov: 58, push: 7, pushPeriod: 96,
  },
  cryostatic: {
    s: 120, lateral: -9.5, height: 2.3, yaw: 0, pitch: 0.045,
    fov: 58, push: 7, pushPeriod: 96,
  },
  aetherion: {
    s: 120, lateral: -9.5, height: 2.3, yaw: 0, pitch: 0.045,
    fov: 58, push: 7, pushPeriod: 96,
  },
}

/** The circuit the title screen runs, unless something overrides it. */
export const ATTRACT_TRACK = 'hollowchoir'

/**
 * HOW BIG A FIELD THE TITLE SCREEN IS ALLOWED.
 *
 * The sim is arithmetic and barely registers; eight vehicles' worth of draw
 * calls is what costs, and it costs at exactly the moment a player is forming
 * their first impression on whatever phone they happen to own. So the field
 * scales with the tier the device already detected, rather than the title
 * screen being gated off mobile entirely -- a smaller pack still reads as a
 * race, and a still image does not.
 */
export function attractRacerCount(tier: QualityTier): number {
  return tier === 'high' ? 8 : tier === 'medium' ? 6 : 4
}

/** Where the camera is and what it looks at, this instant. */
export interface AttractPose {
  pos: THREE.Vector3
  target: THREE.Vector3
  fov: number
}

/**
 * The push, 0..1, as a cosine so the turnaround is not a visible stop.
 *
 * Under reduced motion this is pinned at the midpoint rather than at 0: the
 * shot is composed around where the camera spends most of its time, so a
 * player who asked for no motion should get that composition held still, not
 * the end of the travel.
 */
export function pushPhase(t: number, period: number, reduceMotion: boolean): number {
  if (reduceMotion || period <= 0) return 0.5
  return 0.5 - 0.5 * Math.cos((t / period) * Math.PI * 2)
}

const _f = new THREE.Vector3()
const _r = new THREE.Vector3()
const _u = new THREE.Vector3()
const _q = new THREE.Quaternion()

/**
 * Resolve a shot into a camera pose at time `t`.
 *
 * Built from the track sample's own (tangent, normal, right) basis rather than
 * from a compass yaw. That is not tidiness: it is the one construction that is
 * correct on a gravity track, where "up" is the road's normal and a yaw angle
 * about world Y means nothing. It also sidesteps the handedness question that
 * has cost this codebase real time -- there is no sign to get wrong when the
 * basis is handed to you.
 *
 * Allocation-free: the vectors are module-level scratch and the returned pose
 * borrows them, so the caller must consume it before calling again. The render
 * loop calls this once a frame and copies straight into the camera.
 */
export function attractPose(
  shot: AttractShot,
  track: Track,
  t: number,
  reduceMotion: boolean,
  out: AttractPose,
): AttractPose {
  const phase = pushPhase(t, shot.pushPeriod, reduceMotion)
  // Creep ALONG the road rather than toward the subject. A dolly straight down
  // the barrel changes the composition as it moves; sliding along the spline
  // keeps the same shot and just breathes.
  const s = shot.s + (phase - 0.5) * shot.push

  const smp = track.at(s)
  const base = track.surfacePoint(s, shot.lateral)
  _u.set(smp.normal.x, smp.normal.y, smp.normal.z).normalize()
  out.pos.set(base.x, base.y, base.z).addScaledVector(_u, shot.height)

  // Look down the road, then yaw about the road's up and pitch about its right.
  _f.set(smp.tangent.x, smp.tangent.y, smp.tangent.z).normalize()
  _r.set(smp.right.x, smp.right.y, smp.right.z).normalize()
  if (shot.yaw !== 0) {
    _q.setFromAxisAngle(_u, shot.yaw)
    _f.applyQuaternion(_q)
    _r.applyQuaternion(_q)
  }
  if (shot.pitch !== 0) {
    _q.setFromAxisAngle(_r, shot.pitch)
    _f.applyQuaternion(_q)
  }

  // A target far enough away that the look direction is what matters and the
  // distance does not. 400m is past the end of the measured sightline.
  out.target.copy(out.pos).addScaledVector(_f, 400)
  out.fov = shot.fov
  return out
}

/** A pose object to hand to attractPose(), so the render loop allocates none. */
export function makeAttractPose(): AttractPose {
  return { pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: 58 }
}

/** The shot for a track, falling back to a usable default rather than throwing. */
export function shotFor(trackId: string): AttractShot {
  return ATTRACT_SHOTS[trackId] ?? ATTRACT_SHOTS[ATTRACT_TRACK]
}


// ---------------------------------------------------------------------------
// SPREADING THE FIELD
//
// The first probe run caught this and nothing else would have: the shot looked
// right, the hole was framed at ndc (0.30, 0.07), six cars were on screen --
// and then at t+25s there were zero, because a race starts with its whole grid
// bunched at the line, and a grid that starts together leaves together. From a
// fixed camera that is one convoy followed by most of a lap of empty road.
//
// A real race wants that start. The title screen wants the opposite: a car
// arriving every few seconds, forever. So the attract field is dealt around
// the whole lap before the first frame -- evenly spaced, already at speed --
// which turns "eight cars once a minute" into "a car every lap-time/n".
//
// This edits sim state directly, which is only defensible because of where it
// runs: once, on a race nobody is scored in, before it has stepped. It is not
// reachable from startRace().
// ---------------------------------------------------------------------------

/** Ride height lookup, injected so this module does not reach into content. */
export interface SpreadDeps {
  rideHeightOf: (chassisId: string) => number
  topSpeedOf: (chassisId: string) => number
}

/**
 * Deal `racers` evenly around the lap, facing down the road and already
 * rolling. Mirrors the placement maths the grid itself uses in race.ts -- the
 * surface point, the lift along the NORMAL rather than world up, and the
 * spline yaw -- so a gravity track is placed correctly rather than only a flat
 * one.
 *
 * `startS` seeds the phase so the pack is not dealt straight onto the camera.
 */
export function spreadField(
  racers: RacerStateLike[],
  track: Track,
  startS: number,
  deps: SpreadDeps,
): void {
  const n = racers.length
  if (n === 0) return
  const gap = track.length / n
  for (let i = 0; i < n; i++) {
    const r = racers[i]
    // Alternate sides of the centreline so the field reads as a race rather
    // than a queue, and stagger slightly so two cars never overlap exactly.
    const lateral = (i % 2 === 0 ? -1 : 1) * (2.2 + (i % 3) * 0.9)
    const s = ((startS + i * gap) % track.length + track.length) % track.length
    const smp = track.at(s)
    const p = track.surfacePoint(s, lateral)
    const ride = deps.rideHeightOf(r.chassisId)

    r.pos.x = p.x + smp.normal.x * ride
    r.pos.y = p.y + smp.normal.y * ride
    r.pos.z = p.z + smp.normal.z * ride
    r.yaw = track.yawAt(s)
    r.fwd.x = smp.tangent.x; r.fwd.y = smp.tangent.y; r.fwd.z = smp.tangent.z
    r.up.x = smp.normal.x; r.up.y = smp.normal.y; r.up.z = smp.normal.z
    r.splineS = s
    r.lateral = lateral

    // Already at speed. A field dealt from rest spends the first ten seconds
    // accelerating in a line, which looks like a standing start -- the one
    // thing the shot was spread out to avoid.
    const v = deps.topSpeedOf(r.chassisId) * 0.82
    r.vel.x = smp.tangent.x * v
    r.vel.y = smp.tangent.y * v
    r.vel.z = smp.tangent.z * v
  }
}

/** The slice of RacerState spreadField writes. Structural, so the sim's own
 *  type satisfies it without this module importing it. */
export interface RacerStateLike {
  chassisId: string
  pos: { x: number; y: number; z: number }
  vel: { x: number; y: number; z: number }
  fwd: { x: number; y: number; z: number }
  up: { x: number; y: number; z: number }
  yaw: number
  splineS: number
  lateral: number
}
