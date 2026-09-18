/**
 * SpaceGen Racing — THE PODIUM, as numbers.
 * ---------------------------------------------------------------------------
 * Who stands where, where the camera is at every instant, and when the skip
 * arms. Everything in this file is pure arithmetic over plain objects: no DOM,
 * no WebGL, no three.js, no Track. render/podium.ts builds the scene from it
 * and game/main.ts owns the phase.
 *
 * That split is the same one ui/garagePreview.ts makes and it is made for the
 * same reason. A photograph proves the podium draws; it cannot prove that the
 * right three drivers are on it after a countback, that a five-car field does
 * not index past its own array, that the camera actually CUTS between beats
 * rather than sliding continuously, or that a reduced-motion player is not
 * being flown around. Those four are invisible in a screenshot, cheap to get
 * wrong later, and all of them are pinned in tests/podium.test.ts.
 *
 * ===========================================================================
 * THE SHOT LIST, AND WHY IT IS CUTS RATHER THAN ONE ORBIT
 *
 * The brief asked for "several panning across them from different angles to
 * give more energy". One continuous orbit is the cheap reading of that and it
 * is the wrong one: a constant sweep around a static subject is a turntable,
 * and this codebase has already learned that once — see the orbitSwell / crane
 * / push-in notes on the finish ceremony, all three of which exist because a
 * constant angular rate reads as mechanical no matter how fast it goes.
 *
 * So this is CUT, not orbit. Five beats, each a slow deliberate move with a
 * hard cut between them:
 *
 *   1  REVEAL     low and wide, craning up and pushing in. The podium arrives.
 *   2  CHAMPION   an arc across the winner's face at their own eye line.
 *   3  CARS       opens on all three chassis parked under all three place
 *                 numbers, then pushes in on the champion's own. This is the
 *                 beat that answers "what did they drive", which is a thing
 *                 Vince asked for explicitly, and it is the lowest beat in the
 *                 list because that is where three chassis stop being three
 *                 coloured roofs.
 *   4  WIDE       high three-quarter, drifting back, fireworks behind them.
 *   5  HOLD       a slow last push onto the champion, and it stays there.
 *
 * A cut costs nothing, carries no vestibular load, and resets the eye — which
 * is exactly what makes the SLOW moves inside each beat read as energetic.
 * Five moves in seventeen seconds is a highlight reel; one move in seventeen
 * seconds is a screensaver, whatever its speed.
 *
 * UNDER REDUCED MOTION EVERY BEAT IS STILL. The cuts stay, the moves go: a cut
 * is an edit, not optical flow, and it is continuous camera translation that
 * the setting exists to remove. The player still gets five angles on the same
 * celebration and still gets told, in text that does not move, who won.
 */
import type { StandingRow } from './circuit'

// ---------------------------------------------------------------------------
// Who is on the steps
// ---------------------------------------------------------------------------

/** One driver on one step. */
export interface PodiumEntry {
  /**
   * The step: 1 is the tall middle one. This is a POSITION IN THE SCENE and is
   * not necessarily `place` — see `tied` below.
   */
  step: 1 | 2 | 3
  /** The place the standings actually award, which a tie makes shared. */
  place: number
  entrantId: number
  pilotId: string
  chassisId: string
  points: number
  wins: number
  isLocal: boolean
}

export interface PodiumCast {
  /** Up to three entries, tallest step first. Fewer on a short field. */
  steps: PodiumEntry[]
  /** The local entrant's own place, 0 if they are not in the standings. */
  localPlace: number
  localPoints: number
  localOnPodium: boolean
  /**
   * The top two are level on points AND on every rung of the countback, so the
   * standings share a place between them and nothing in the data can separate
   * them. Somebody still has to stand on the top step — the array order is a
   * total order, so the scene is stable — but the card must say so out loud
   * rather than quietly crowning whoever sorted first.
   */
  tied: boolean
}

const STEP_OF = [1, 2, 3] as const

/**
 * Build the cast from a finished championship table.
 *
 * TAKES THE ARRAY ORDER, NOT `place`. `standings()` guarantees a TOTAL order
 * (points, then countback, then grid slot) while letting `place` be shared by
 * a genuine tie, and a scene needs exactly one driver per step. So the steps
 * follow the array and the card prints `place`, which is the only arrangement
 * where the picture is stable and the text is true.
 *
 * Defensive about a short field on purpose. Eight cars is the shipped grid and
 * `standings()` returns one row per entrant, so three rows is guaranteed
 * today; a podium that throws on a two-car table is a crash in the one moment
 * of the game a player has spent forty minutes earning.
 */
export function podiumCast(rows: readonly StandingRow[], localId: number): PodiumCast {
  const steps: PodiumEntry[] = []
  for (let i = 0; i < rows.length && i < 3; i++) {
    const r = rows[i]
    steps.push({
      step: STEP_OF[i],
      place: r.place,
      entrantId: r.entrant.id,
      pilotId: r.entrant.pilotId,
      chassisId: r.entrant.chassisId,
      points: r.points,
      wins: r.counts[0] ?? 0,
      isLocal: r.entrant.id === localId,
    })
  }
  const me = rows.find((r) => r.entrant.id === localId) ?? null
  return {
    steps,
    localPlace: me ? me.place : 0,
    localPoints: me ? me.points : 0,
    localOnPodium: steps.some((s) => s.isLocal),
    tied: rows.length >= 2 && rows[0].place === rows[1].place,
  }
}

// ---------------------------------------------------------------------------
// The stage, in metres
// ---------------------------------------------------------------------------
//
// Podium-local space: origin at the front-centre of the block on the ground,
// +Z toward the audience, +Y up. The whole scene is authored here and placed
// at the world origin, because there is no track under it to place it against.

/** Half-width of one step, metres. */
export const STEP_HALF_W = 1.7
/**
 * Centre X of each step, indexed by `PodiumEntry.step - 1`.
 *
 * 4.9 RATHER THAN 4.0, AND THE NUMBER IS THE CARS' NOT THE STEPS'. A car is
 * parked in front of each step at CAR_YAW, and a yawed car is a great deal
 * wider than its own track. Measured off the shipped LOD0 buffers at the yaw
 * each step actually uses, the three that stand on the probe's podium span
 * 4.74 m (Vector-7 on step 1), 3.96 m (Solaire on step 2) and 5.93 m (Bulwark
 * on step 3) ACROSS X. The old comment here claimed 4.0 m lanes left "~1.4 m
 * of air" around a 2.6 m Bulwark -- which is its width at ZERO yaw, a number
 * no beat has ever seen. At 4.0 the 1st and 2nd cars overlapped by 0.4 m and
 * the 1st and 3rd by 1.0 m, and that is the mass the CARS beat photographed as.
 *
 * At 4.9 the 1st and 2nd cars clear each other by 0.4 m of air. The 1st and
 * 3rd still overlap by ~0.4 m, and no sane width fixes that: the widest pair
 * the roster can produce (a Filament beside a Dray-9) wants 7.2 m lanes and a
 * 17.8 m podium, which stops reading as a podium at all. The rest of the
 * separation is bought in DEPTH instead -- see the stagger in CAR_Z -- which
 * costs no width and works for every pair rather than for the measured three.
 */
export const STEP_X: readonly number[] = [0, -4.9, 4.9]
/**
 * Top surface Y of each step.
 *
 * MEASURED AGAINST THE CARS, NOT AGAINST A REAL PODIUM. The first staging used
 * a human-scale 1.6/1.1/0.8 m ladder and it photographed as no podium at all:
 * the three chassis are 1.4-1.6 m tall and parked in front, so they occluded
 * every step and the shot was three cars with three heads floating over them.
 * At 3.00/2.25/1.75 the winner's step face clears the roof of the car parked
 * in front of it from every beat in the shot list, which is the whole point of a
 * podium -- you can see who is on top of it.
 */
export const STEP_Y: readonly number[] = [3.00, 2.25, 1.75]
/** Depth of a step, metres: front face at z = 0, back at z = -STEP_D. */
export const STEP_D = 2.8
/**
 * Where a winner's car is parked: at the FRONT of the base of their own step,
 * nose swung toward the viewer's left. Indexed by `PodiumEntry.step - 1`.
 *
 * 5.8 m of Z clears the deepest chassis (the Dray-9 is a little over four
 * metres long) from the step face it is parked against.
 *
 * AND IT SETS HOW MUCH OF THE STEP FACE IS VISIBLE, which is the other reason
 * it moved. A 1.5 m car parked close occludes the face up to about y = 0.65
 * from the low beats; pushed forward to 5.8 m the same sightline clears at
 * y = 0.35, which is what puts all three place numbers fully in the picture
 * instead of two and a half of them.
 *
 * THE TWO OUTER CARS SIT 0.9 m PROUD OF THE CHAMPION'S, and that is a staging
 * trick rather than a tidy-up. Three cars on one Z are three silhouettes at
 * one scale with no parallax between them, so wherever their turned bodies
 * overlap they merge — which is what the CARS beat photographed. Half a car's
 * length of stagger gives every overlapping pair a near one and a far one: the
 * near car is larger, lands lower in a frame shot from above the roofline, and
 * moves faster across a tracking pan. It reads as depth instead of as a wall,
 * and it costs nothing in width. Kept small (0.9 rather than 1.8) because the
 * HOLD beat closes to 16 m and an outer car a metre nearer the lens there is
 * already half a frame wide.
 */
export const CAR_Z: readonly number[] = [5.8, 6.7, 6.7]
/**
 * Car heading, radians about +Y, nose authored toward +Z.
 *
 * -0.62 is REST_YAW from ui/garagePreview.ts, verbatim: the three-quarter
 * front that the garage already decided is the angle a chassis reads best
 * from, showing the silhouette AND the pilot's face panel at once. Reusing the
 * number rather than picking a new one means a car looks the same on the
 * podium as it did in the garage the player chose it in.
 *
 * The two outer cars toe a few degrees toward the middle so the row converges
 * on the champion instead of reading as a car park.
 */
export const CAR_YAW: readonly number[] = [-0.62, -0.42, -0.82]
// ---------------------------------------------------------------------------
// WHERE A PILOT FIGURE STANDS: on the step's top surface, STEP_Y[i], exactly.
//
// There is no lift term any more and there must not be one again. The figure's
// group is originated at THE SOLES OF ITS FEET -- y = 0 in figure space is the
// bottom of the figure -- so a holder placed at the step top puts it on the
// step, and that is the whole rule. render/podium.ts asserts the contract
// rather than trusting it: it measures the built figure and publishes the gap
// as `PodiumStats.soleGap`, which tools/probe-podium.mjs fails on.
//
// WHAT WAS HERE BEFORE, so nobody re-derives it. `PILOT_LIFT = 1.05` existed
// because the figure used to be a ball originated at its own centre: the
// scaled ball was ~1.04 m in radius with a mount peg ~0.96 m below, and 1.05
// was the number that "all but touched" the step. In the photographs it did
// not -- the figures visibly hovered, because a hand-fitted offset against an
// origin nobody owns is a guess, and the hop then added 1.6 m of air on top of
// the guess. A contract costs one measurement and cannot drift.
// ---------------------------------------------------------------------------

/**
 * Pilot figures are drawn at this multiple of their in-car size.
 *
 * A pilot is a 0.8 m ball, which is a head on a 2.3 m car and is nothing at
 * all standing on a podium ten metres from the lens. 2.6x makes it a 2.1 m
 * figure — a person's height, which is the scale the eye reads a podium at.
 * Nothing is remodelled for this: it is the same shell, the same head, the
 * same single emissive face panel, scaled.
 */
export const PILOT_SCALE = 2.6

/**
 * How high the champion's FACE is expected to sit above the podium floor.
 *
 * The two beats that frame a person rather than a scene -- CHAMPION and HOLD --
 * are aimed at this, and it is a CONTRACT WITH A MEASUREMENT BEHIND IT rather
 * than a constant the beats were hand-fitted to. render/podium.ts finds the
 * `sg_face` panel inside the built figure, reads its height above the soles,
 * and hands the real number to podiumFrameAt(); the shot list then slides its
 * face-aimed targets by the difference. That is why a pilot figure can grow
 * legs, or a head, without anybody re-authoring a camera move: the only thing
 * the shot list actually asserts is "this beat is aimed at their face", and
 * where the face is is the figure's business.
 *
 * The authored value is STEP_Y[0] plus 2.30 m of pilot, which is the eye line
 * of a ~3 m figure standing on the tall step. Tests pin the default; the probe
 * prints the measured one beside it.
 */
export const PODIUM_FACE_Y = STEP_Y[0] + 2.30

// ---------------------------------------------------------------------------
// The camera
// ---------------------------------------------------------------------------

export interface PodiumPose {
  x: number; y: number; z: number
  tx: number; ty: number; tz: number
  fov: number
}

export interface PodiumShot {
  label: 'reveal' | 'champion' | 'cars' | 'wide' | 'hold'
  /** Seconds this beat holds the screen. */
  hold: number
  from: PodiumPose
  to: PodiumPose
  /**
   * This beat is aimed at the champion's FACE, not at a point in the set.
   *
   * Its `ty` is authored against PODIUM_FACE_Y, and podiumFrameAt() slides it
   * by however far the real figure's face turns out to be from that. A beat
   * without the flag is aimed at the SET -- the block, the row of cars -- and
   * must not move when the cast changes shape.
   */
  face?: true
}

const pose = (
  x: number, y: number, z: number, tx: number, ty: number, tz: number, fov: number,
): PodiumPose => ({ x, y, z, tx, ty, tz, fov })

/**
 * THE SHOT LIST. See the header for why it is cut rather than orbited.
 *
 * Every beat is stated as a FROM and a TO in podium-local metres, so the whole
 * camera plan is readable as a list of framings rather than as a pile of
 * trigonometry — and so reduced motion is one line (`to = from`) instead of a
 * suppression term inside five separate expressions.
 */
const SHOTS: readonly PodiumShot[] = [
  // 1. REVEAL. Opens low, in among the cars, and CRANES OVER them onto the
  //    podium: the move itself is the reveal, because the thing being revealed
  //    starts out hidden behind the thing the shot opens on. Ends with all
  //    three steps, all three cars and the sky above them in frame.
  //
  //    THE CARD IS WHY THIS BEAT IS NOT AIMED HIGHER. Halfway through the crane
  //    the champion's head crosses the top third of the frame, and no aim fixes
  //    that: the subject tops out 7-8 m up while the lens is still 1-2 m up, so
  //    holding it below the card would mean aiming at y = 5 from y = 1 and
  //    throwing away the ground, the cars and the reveal itself. The card moved
  //    to a rail instead -- see the .sg-pod rail in ui/styles.css.
  {
    label: 'reveal', hold: 3.4,
    from: pose(0, 0.90, 15.8, 0, 1.20, 2.4, 44),
    to: pose(0, 7.10, 19.6, 0, 3.00, 0.0, 50),
  },
  // 2. CHAMPION. Level with the winner's own face and arcing right across it.
  //    The target barely moves, so it reads as a camera walking around a person
  //    rather than as a whip pan.
  //
  //    EIGHTEEN METRES OF STANDOFF, and the number has moved twice. At seven
  //    the head filled two thirds of the frame and neither their step nor
  //    their car was in the shot -- a portrait of a sphere. Eleven fixed that
  //    for a 2 m figure; the figure is now 3.7 m tall with legs, and at eleven
  //    it was back to filling 60% of the frame with the podium out of shot.
  //    At eighteen it is about 28% of the frame height, which is the "about a
  //    third" this beat has always been aiming at, with the medal face and the
  //    nose of their car under them.
  //
  //    `face: true`, so `ty` here is "their eye line" rather than "5.3 m". The
  //    figure is another file's and it has just grown legs; this beat should
  //    follow it rather than be re-measured against it every time. The
  //    standoff is the part that cannot follow automatically -- how big a
  //    subject should be in frame is a composition, not a measurement -- so it
  //    is the one number a much taller figure still costs. See PODIUM_FACE_Y.
  {
    label: 'champion', hold: 3.2, face: true,
    from: pose(-9.8, 5.30, 14.8, 0, PODIUM_FACE_Y, -1.0, 40),
    to: pose(8.8, 5.00, 14.0, 0, PODIUM_FACE_Y - 0.10, -1.0, 40),
  },
  // 3. CARS. The beat that answers "what did they drive", and the one Vince
  //    asked for by name: each winner's chassis parked at the foot of their own
  //    numbered step.
  //
  //    IT PULLS OUT, IT DOES NOT TRACK PAST. The shipped version was a pure
  //    lateral dolly at 2.1 m, and photographed it failed at the only job it
  //    has: from bumper height the podium is entirely above the frame, so the
  //    shot was three cars on a dark floor with nothing to attach them to. The
  //    place numbers glow on the step faces two to three metres up -- they are
  //    the association, and a camera below the rooflines cannot see them.
  //
  //    A tracking pan cannot fix that by rising, either. The row plus the cars'
  //    turned bodies is 15 m across, and holding 15 m in frame fixes the
  //    standoff at ~9.6 m from the car plane; any lateral throw on top of that
  //    swings an outer car out of frame. So the move is along the LENS AXIS
  //    instead: open on all three cars sitting under all three numbers, then
  //    push in and down onto the champion's own chassis.
  //
  //    IT OPENS ON THE ANSWER RATHER THAN ARRIVING AT IT, and that is reduced
  //    motion's doing. A still beat holds its FROM pose for its whole length
  //    (see podiumFrameAt), so whatever this beat opens on is the only frame a
  //    calm player ever sees of it. Authored the other way round -- tight, then
  //    pulling out to the wide -- it photographed beautifully at full energy
  //    and gave a reduced-motion player three seconds of one cropped car.
  //    Establish, then emphasise: it is the better shot anyway.
  //
  //    Still the lowest beat in the list (3.1 -> 3.9 m). It has to be: from
  //    above, three chassis are three coloured roofs, and the silhouettes only
  //    separate near the rooflines. It sits just high enough that the sightline
  //    to each step face clears the car parked in front of it -- 2.5 degrees of
  //    air on the tightest pair (the Bulwark's roof against the 3rd-place
  //    number), which is ~45 px on a 810-line frame.
  {
    label: 'cars', hold: 3.0,
    from: pose(-1.6, 3.95, 18.8, -0.6, 2.20, 6.6, 48),
    to: pose(1.2, 3.10, 13.2, 0.8, 1.80, 6.9, 48),
  },
  // 4. WIDE. Off the shoulder and drifting back, which opens the sky above the
  //    podium -- that is where the fireworks are, and a shot that does not
  //    include the sky cannot show them bursting.
  {
    label: 'wide', hold: 3.6,
    from: pose(11.8, 7.40, 13.4, 0, 3.15, 0.4, 50),
    to: pose(6.6, 6.30, 18.6, 0, 2.95, 0.4, 50),
  },
  // 5. HOLD. Straight on, closing slowly. The last thing on screen is the
  //    champion, their car, and their name on the card.
  //
  //    AIMED AT THE SET, NOT AT THE FACE, unlike beat 2. This is the frame a
  //    player reads the final table against, so it wants the whole object --
  //    three steps, three cars, three figures -- and a face-aimed version put
  //    the aim a metre higher and gave the bottom half of the frame to floor.
  //    The figures have 6 m of headroom above the aim here, which is where the
  //    hop and any future growth in the figure have to fit.
  //
  //    16.4 m at the close rather than 15.6: the outer cars moved 0.9 m toward
  //    the lens (see CAR_Z) and at 15.6 the near one was half the frame wide.
  {
    label: 'hold', hold: 3.8,
    from: pose(0, 5.60, 20.8, 0, 3.20, 0.2, 44),
    to: pose(0, 5.05, 16.4, 0, 3.30, -0.2, 41),
  },
]

export const PODIUM_SHOTS: readonly PodiumShot[] = SHOTS

/** Total runtime of the shot list, seconds. */
export const PODIUM_DURATION = SHOTS.reduce((a, s) => a + s.hold, 0)

/**
 * Input is ignored for this long after the podium opens.
 *
 * The same 0.7 s the finish ceremony uses, for the same reason and with the
 * same edge-trigger beside it: a player arrives here off the results of round
 * 8 and may still be holding something.
 */
export const PODIUM_SKIP_GUARD = 0.7

/** Smootherstep. Zero velocity at both ends, so a beat neither starts nor
 *  stops with a jerk — which is the whole difference between a move and a
 *  slide. */
function ease(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t
  return x * x * x * (x * (x * 6 - 15) + 10)
}

export interface PodiumFrame {
  /** Index into PODIUM_SHOTS. */
  shot: number
  label: PodiumShot['label']
  /** 0..1 through this beat. */
  u: number
  pose: PodiumPose
}

/**
 * Where the camera is at `t` seconds into the podium.
 *
 * Past the end of the list it holds the final pose rather than wrapping: the
 * phase auto-advances at PODIUM_DURATION, but a dropped frame, a backgrounded
 * tab or a probe holding the scene open must not send the camera back to shot
 * one, which would read as a loop nobody asked for.
 *
 * `out` is filled in place so the render loop allocates nothing.
 */
export function podiumFrameAt(
  t: number, reduceMotion: boolean, out: PodiumFrame, faceY = PODIUM_FACE_Y,
): PodiumFrame {
  let rest = t > 0 ? t : 0
  let i = 0
  while (i < SHOTS.length - 1 && rest >= SHOTS[i].hold) {
    rest -= SHOTS[i].hold
    i++
  }
  const s = SHOTS[i]
  const u = s.hold > 0 ? Math.min(1, rest / s.hold) : 1
  // STILL, NOT SLOWED. Under reduced motion each beat is its own opening
  // framing held for its whole length; the cuts between beats survive because
  // a cut is an edit rather than optical flow.
  const k = reduceMotion ? 0 : ease(u)
  const a = s.from, b = s.to
  // A FACE-AIMED BEAT FOLLOWS THE FIGURE, LENS AND ALL. The authored `ty` is an
  // eye line measured against PODIUM_FACE_Y, so the whole beat slides by
  // however far the built figure's face actually is from that -- see
  // PODIUM_FACE_Y. The CAMERA slides with it, not just the aim: beat 2 is
  // authored level with the face, and lifting only the target would turn a
  // level arc into a look-up or a look-down the moment the figure changed
  // height. Zero for every other beat, which are aimed at the set and must not
  // move when the cast does.
  const lift = s.face ? faceY - PODIUM_FACE_Y : 0
  out.shot = i
  out.label = s.label
  out.u = u
  out.pose.x = a.x + (b.x - a.x) * k
  out.pose.y = a.y + (b.y - a.y) * k + lift
  out.pose.z = a.z + (b.z - a.z) * k
  out.pose.tx = a.tx + (b.tx - a.tx) * k
  out.pose.ty = a.ty + (b.ty - a.ty) * k + lift
  out.pose.tz = a.tz + (b.tz - a.tz) * k
  out.pose.fov = a.fov + (b.fov - a.fov) * k
  return out
}

/** A frame object to hand to podiumFrameAt(), so nothing allocates per frame. */
export function makePodiumFrame(): PodiumFrame {
  return { shot: 0, label: 'reveal', u: 0, pose: pose(0, 0, 0, 0, 0, 0, 50) }
}

// ---------------------------------------------------------------------------
// Where the sky actually is
// ---------------------------------------------------------------------------
//
// THE FIREWORKS USED TO BE AIMED AT A BAND OF WORLD SPACE, AND MOST OF THEM
// WENT OFF OUTSIDE THE PICTURE.
//
// One band -- y 8..16, z -26..-8 -- was fitted to one beat and then had to
// serve five, which it cannot, because the five beats do not agree about where
// up is. The WIDE beat is 7 m up with the lens tilted down four degrees and
// has most of that band in shot; the CARS beat is 3 m up looking down ten
// degrees at a row of bumpers and has NONE of it, so that beat got no
// fireworks at all; CHAMPION is a 40-degree lens at 14 m, where the top of
// frame is about y = 11 and half the band bursts above it. Counted off the
// five photographs, the pyro read as a burst in one of them.
//
// So the aiming is done in the CAMERA'S OWN FRAME instead: pick a point on the
// screen, pick a distance, and solve for the world position. Then the shells
// are in frame by construction on every beat, at every aspect ratio, including
// the ones a phone invents at runtime -- render/podium.ts builds the lens from
// the camera it has just finished positioning, after the portrait fov/pull
// compensation, so what is solved against is the real frustum and not the
// 16:9 one the beats were authored in.
//
// It is all plain arithmetic on plain numbers, which is the point: it is the
// half of "do the fireworks land in shot" that a screenshot cannot answer
// twice in a row and a test can answer for every beat at once.

/** A camera reduced to what aiming something into its frame needs. */
export interface PodiumLens {
  /** Eye. */
  x: number; y: number; z: number
  /** Unit forward. */
  fx: number; fy: number; fz: number
  /** Tangent of HALF the vertical field of view. */
  tanV: number
  /** Viewport width / height. */
  aspect: number
  /** Eye-to-subject distance, so "behind the subject" is expressible. */
  reach: number
}

/** A lens built from an authored pose, for tests and for anything without a
 *  real camera to ask. `aspect` defaults to the one the beats are composed for. */
export function podiumLensOf(
  p: PodiumPose, aspect = 16 / 9, out?: PodiumLens,
): PodiumLens {
  const dx = p.tx - p.x, dy = p.ty - p.y, dz = p.tz - p.z
  const d = Math.max(1e-4, Math.hypot(dx, dy, dz))
  const o = out ?? ({} as PodiumLens)
  o.x = p.x; o.y = p.y; o.z = p.z
  o.fx = dx / d; o.fy = dy / d; o.fz = dz / d
  o.tanV = Math.tan((p.fov * Math.PI) / 360)
  o.aspect = aspect
  o.reach = d
  return o
}

/**
 * Screen coordinates of a world point, as seen by `l`.
 *
 * `sx`/`sy` are NDC: -1..1 across the frame, +y up, and `depth` is metres along
 * the view axis (negative behind the lens). The inverse of podiumSkyPoint, and
 * it exists so a test can assert that what the aiming produced is actually in
 * frame rather than merely believing the algebra.
 */
export interface PodiumScreen { sx: number; sy: number; depth: number }

export function podiumProject(
  l: PodiumLens, x: number, y: number, z: number, out: PodiumScreen,
): PodiumScreen {
  // The lens's own basis. `up` is world +Y, exactly as render/podium.ts forces
  // camera.up to be (see the note in Game.beginPodium), so `right` is always
  // horizontal and a purely lateral offset never changes a point's height.
  const cp = Math.max(1e-3, Math.hypot(l.fx, l.fz))
  const rx = -l.fz / cp, rz = l.fx / cp
  const ux = -l.fx * l.fy / cp, uy = cp, uz = -l.fz * l.fy / cp
  const dx = x - l.x, dy = y - l.y, dz = z - l.z
  const depth = dx * l.fx + dy * l.fy + dz * l.fz
  const h = dx * rx + dz * rz
  const v = dx * ux + dy * uy + dz * uz
  const k = depth > 1e-4 ? depth : 1e-4
  out.depth = depth
  out.sx = h / (k * l.tanV * l.aspect)
  out.sy = v / (k * l.tanV)
  return out
}

/** Where one shell goes, and what it should look like when it gets there. */
export interface PodiumBurst {
  /** Burst point, world metres. */
  x: number; y: number; z: number
  /** Metres from the lens, which is what sets how big to draw it. */
  dist: number
  /** Where it will be on screen, for the tests and the probe. */
  sx: number; sy: number
  /** How far it climbs before it bursts. Zero when there is no room to rise. */
  rise: number
}

/** Fraction of a half-frame the shells keep clear of the centre, so they burst
 *  BESIDE the podium rather than over the face the beat is framing. */
const SKY_SX_IN = 0.30
/** ...and how far out they may go. Inside 1.0 with room for the burst's own
 *  radius, or half of every shell is cropped by the frame edge. */
const SKY_SX_OUT = 0.86
/** The screen band the burst itself lands in: the upper half, never the very
 *  top edge (a burst whose top half is cropped reads as a glow, not a burst). */
const SKY_SY_LO = 0.16
const SKY_SY_OUT = 0.80
/** The ray from the lens to the burst must climb at least this much per metre,
 *  or a beat that tilts down puts its "sky" underground. */
const SKY_CLIMB = 0.12
/** No burst lower than this, so nothing goes off behind the block at head
 *  height, and none higher, so a level beat does not throw them into orbit. */
const SKY_FLOOR = 6.0
const SKY_CEIL = 30.0
/**
 * How far past the subject a shell may sit, as a range added to the beat's own
 * eye-to-subject distance.
 *
 * NEVER NEARER THAN THE SUBJECT, never much further. The near end is level
 * with the subject rather than in front of it -- a burst between the lens and
 * the champion washes the champion out, and the lateral lobes (SKY_SX_IN) keep
 * even a level one off to the side. The far end is eleven metres because the
 * depth is what the eye reads as "behind the podium": push it to thirty and
 * the burst is a small bright thing on the horizon whatever its angular size,
 * because the confetti falling between the lens and it says how far away it is.
 */
const SKY_BEHIND_NEAR = 0.0
const SKY_BEHIND_FAR = 11.0
/** ...and an absolute floor, for the one beat whose subject is 6 m away. */
const SKY_MIN_DIST = 12.0
/** How far a shell climbs before it bursts, at most. Below that it is whatever
 *  room there is between the burst point and SKY_FLOOR. */
const SKY_RISE = 7.0

/**
 * Aim one shell, from three dice in [0, 1).
 *
 * Deterministic in its inputs on purpose: the caller owns the generator (see
 * the seeded `rnd` in render/podium.ts, which exists so two probe runs
 * photograph the same sky), and a test can sweep the dice on a grid.
 */
export function podiumSkyPoint(
  l: PodiumLens, a: number, b: number, c: number, out: PodiumBurst,
): PodiumBurst {
  const cp = Math.max(1e-3, Math.hypot(l.fx, l.fz))
  const rx = -l.fz / cp, rz = l.fx / cp
  const ux = -l.fx * l.fy / cp, uy = cp, uz = -l.fz * l.fy / cp

  // 1. ACROSS THE FRAME, in two lobes. A uniform sx would put a third of the
  //    shells behind the subject's own head, which is both a worse picture and
  //    the one place bloom actively hurts.
  const side = c < 0.5 ? -1 : 1
  const cc = c < 0.5 ? c * 2 : c * 2 - 1
  const sx = side * (SKY_SX_IN + (SKY_SX_OUT - SKY_SX_IN) * cc)

  // 2. UP THE FRAME, but never below the height at which the view ray stops
  //    climbing -- on a beat that looks down, the bottom of the frame is the
  //    floor and there is no sky in it at any distance.
  const climb = (SKY_CLIMB - l.fy) / (l.tanV * cp)
  let syLo = SKY_SY_LO > climb ? SKY_SY_LO : climb
  if (syLo > SKY_SY_OUT) syLo = SKY_SY_OUT
  const sy = syLo + (SKY_SY_OUT - syLo) * a
  const dirY = l.fy + sy * l.tanV * cp

  // 3. HOW FAR, clamped into the sky slab. Distance is the free variable once
  //    the screen position is chosen, so the height limits are spent here --
  //    which is what keeps a downward-tilted beat's shells close and a level
  //    beat's shells far, instead of forcing one compromise on both.
  let dist = l.reach + SKY_BEHIND_NEAR + (SKY_BEHIND_FAR - SKY_BEHIND_NEAR) * b
  if (dirY > 1e-3) {
    const dFloor = (SKY_FLOOR - l.y) / dirY
    const dCeil = (SKY_CEIL - l.y) / dirY
    if (dist < dFloor) dist = dFloor
    if (dist > dCeil) dist = dCeil > dFloor ? dCeil : dFloor
  }
  if (dist < SKY_MIN_DIST) dist = SKY_MIN_DIST

  const h = sx * dist * l.tanV * l.aspect
  const v = sy * dist * l.tanV
  out.x = l.x + l.fx * dist + rx * h + ux * v
  out.y = l.y + l.fy * dist + uy * v
  out.z = l.z + l.fz * dist + rz * h + uz * v
  out.dist = dist
  out.sx = sx
  out.sy = sy
  // 4. AND HOW FAR IT CLIMBS TO GET THERE. A shell that is simply switched on
  //    already-burst is a puff; one that rises out of the bottom of the frame
  //    trailing sparks and THEN opens is a firework. All that is needed here is
  //    the room: everything below SKY_FLOOR belongs to the podium.
  const room = out.y - SKY_FLOOR
  out.rise = room > SKY_RISE ? SKY_RISE : room > 0 ? room : 0
  return out
}

// ---------------------------------------------------------------------------
// Leaving
// ---------------------------------------------------------------------------

/**
 * The skip rule, lifted from the finish ceremony because a player should not
 * have to learn a second one.
 *
 * TIME GUARD **AND** EDGE TRIGGER. A guard alone is not enough: a control still
 * held from the results screen would count as a skip the instant the guard
 * expired and the celebration would vanish 0.7 s in. The control has to have
 * been RELEASED once since the podium opened before it can arm.
 *
 * `armed` is the caller's latch; this returns the new latch and whether to go.
 */
export function podiumSkip(
  t: number, held: boolean, armed: boolean,
): { armed: boolean; skip: boolean } {
  const nowArmed = armed || !held
  return { armed: nowArmed, skip: held && nowArmed && t >= PODIUM_SKIP_GUARD }
}

/** True once the shot list has played out and the results screen is due. */
export function podiumDone(t: number): boolean {
  return t >= PODIUM_DURATION
}
