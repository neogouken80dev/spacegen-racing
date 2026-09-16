/**
 * MERIDIAN DEEP — submerged transit tube.
 *
 * ---------------------------------------------------------------------------
 * THE ONLY LIT THING IS THE ROAD.
 *
 * Every other circuit in the game is an exterior with a sky doing most of the
 * lighting. This one is 900 metres down. The key is a near-vertical shaft of
 * filtered surface light at 0.78 intensity and the fill carries the rest, which
 * means the frame has exactly one bright region -- the tube -- and everything
 * outside the glass falls off into the fog within about 200m.
 *
 * That is a gift for the mid-to-dark rule (GDD 09: if a track section washes
 * out the racers, the track is wrong) and a trap for readability, because the
 * one surface the player MUST see is the darkest thing the road can be: `oil`
 * renders at 0x121110 with a slick specular, and the biofilm blooms are the
 * whole difficulty of this circuit. A hazard you cannot see is not difficulty.
 *
 * So the blooms are signposted three ways and only one of them is the road:
 * the slick sheen itself, a run of amber hazard beacons on the approach (built
 * in `landmarks` off the `bloom` tag), and the bioluminescent growth that is
 * the in-fiction reason the patch exists, banked up against the tube wall
 * either side of it. The beacons are the one that works at speed.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS OUTSIDE THE GLASS.
 *
 * TWO LAYERS, at two distances, and they are not the same thing.
 *
 * FAR: the celestial `ships` layer, which is specified as silhouettes with
 * running lights -- precisely what a large bioluminescent animal at range
 * looks like. Three of them, holding station 20 degrees up the water column,
 * costing no draw calls and unable to be driven past or clipped into. They
 * draw on the sky DOME, which is in front of the fog by construction, and that
 * is why they survive at a distance nothing else here does.
 *
 * NEAR: modelled whales, sharks and schools of fish, 35 to 190 m off the road,
 * inside the fog, crossing over the tube and under it and alongside it. See
 * `marineLife` below. This note used to argue against exactly that -- "a
 * modelled whale would need to be camera-locked, kept inside the far plane,
 * excluded from fog and sorted against the terrain shell, four ways to get a
 * seam" -- and the argument was right about the four hazards and wrong about
 * the conclusion. Each one is answered, with the measurement, in the block
 * above `LIFE_PERIOD`. The short version: they are anchored to beats rather
 * than to the camera; the far plane is 4000 m and the furthest of them is 190;
 * the fog is the effect rather than the obstacle, which is what fixes the
 * staging distance at 40-190 m instead of the 400 this note used to assume;
 * and opaque depth-writing geometry has no sorting problem to have a seam in.
 *
 * "An animal the player sees for two seconds at a time" was also right, and is
 * the point. Two seconds, six times a lap, of something enormous that does not
 * care that you are racing.
 *
 * Beats, what each one gets, and what is alive at it:
 *   1  shelf apron        tube ribs, service gantries, the light shafts
 *                         -- a whale over the tube, a school left, sharks right
 *   2  bloom A            beacons, coral banks, the first slick corner
 *                         -- a school low on the APPROACH, nothing at the apex
 *   3  the trench jump    a broken span, wreckage on the floor below
 *                         -- a whale passing UNDER the gap, sharks in the wreck
 *   4  the Cathedral      NOT CURRENTLY BUILT. `src/content/tracks/abyssal.ts`
 *                         authors no loop, so `loopHoop` returns null and the
 *                         dome and its ring cost nothing (see `landmarks`).
 *                         What is actually here is the long wave -- shelf,
 *                         swell, boost-wave, hook, hairpin -- and it gets a
 *                         travelling PAIR of whales and two sharks
 *   5  the Descent        two turns of corkscrew down the trench wall
 *                         -- a whale and a school on the OUTSIDE of the coil.
 *                         Staged overhead first and photographed as absent:
 *                         from inside a vertical cyclone the frame is its own
 *                         road and there is no lit water to read against
 *   6  the Breach         cracked glass, a current, and the murk coming in
 *                         -- fish streaming past at the corridor limit and one
 *                         large shark in the murk. Nothing crosses overhead
 *                         and there are no whales: at 0.0165 fog, anything far
 *                         enough away to fit in frame cannot be seen at all
 */
import * as THREE from 'three'
import {
  bindSurfaceSpray, loopHoop, merge, mulberry32, part, xf,
  type FrameInfo, type Palette, type PropSpec, type SurfaceSprayTable,
  type TerrainPoint, type Theme, type ThemeContext,
} from './kit'

/* ------------------------------------------------------------- the values */

/** Trench basalt. Everything outside the tube is some version of this. */
const ROCK = 0x0e1a22
const ROCK_LIT = 0x1b2f3a
/** Silt on the flats — the one place the floor goes light, and it is still 0.30. */
const SILT = 0x33454c
/** Tube structure: wet steel, cold and slightly blue. */
const STEEL = 0x223842
const STEEL_LIT = 0x39606e
/** The living colours. Bright, and used on almost nothing. */
const BIOLUME = 0x54f0d0
const CORAL = 0x2e8f96
const BEACON = 0xffb23c

/* ------------------------------------------------------------------ props */

/** A coral bank: stacked plates, the shallow-reef silhouette. */
function propCoral(pal: Palette, seg: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const rnd = mulberry32(0xc0a1)
  for (let i = 0; i < 8; i++) {
    const r = 1.4 + rnd() * 2.6
    const a = rnd() * Math.PI * 2
    const d = rnd() * 4
    parts.push(part(
      new THREE.CylinderGeometry(r, r * 0.55, 0.5 + rnd() * 0.7, Math.max(6, seg >> 2)),
      i % 4 === 0 ? CORAL : ROCK_LIT,
      xf(Math.cos(a) * d, 0.7 + i * 0.8, Math.sin(a) * d, rnd() * 3, (rnd() - 0.5) * 0.3, (rnd() - 0.5) * 0.3),
    ))
  }
  void pal
  return merge(parts)
}

/** Kelp — tall, thin, sways. The vertical element on an otherwise flat floor. */
function propKelp(pal: Palette, seg: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const rnd = mulberry32(0x4e19)
  for (let i = 0; i < 11; i++) {
    const h = 6 + rnd() * 16
    const a = rnd() * Math.PI * 2
    const d = rnd() * 3.6
    parts.push(part(
      new THREE.CylinderGeometry(0.16, 0.34, h, Math.max(4, seg >> 3)),
      rnd() < 0.22 ? CORAL : 0x1c3a2e,
      xf(Math.cos(a) * d, h / 2, Math.sin(a) * d, rnd() * 3, (rnd() - 0.5) * 0.22, (rnd() - 0.5) * 0.22),
    ))
  }
  void pal
  return merge(parts)
}

/** A rock outcrop, the trench's own geology. */
function propOutcrop(pal: Palette, seg: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const rnd = mulberry32(0x0c701)
  for (let i = 0; i < 5; i++) {
    const r = 2.2 + rnd() * 4.4
    const a = rnd() * Math.PI * 2
    parts.push(part(
      new THREE.DodecahedronGeometry(r, 0),
      i === 0 ? ROCK_LIT : ROCK,
      xf(Math.cos(a) * rnd() * 4, r * 0.55, Math.sin(a) * rnd() * 4, rnd() * 3, rnd() * 2, rnd() * 2,
        1, 0.62 + rnd() * 0.4, 1),
    ))
  }
  void pal; void seg
  return merge(parts)
}

/** Wrecked plant: a collapsed tube section with its ribs showing. */
function propWreck(pal: Palette, seg: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const s = Math.max(7, seg >> 1)
  parts.push(part(new THREE.CylinderGeometry(6.5, 6.5, 16, s, 1, true), STEEL, xf(0, 5, 0, 0, Math.PI / 2, 0.22)))
  for (let i = -1; i <= 1; i++) {
    parts.push(part(new THREE.TorusGeometry(6.7, 0.42, 4, s), STEEL_LIT, xf(i * 6, 5, 0, 0, 0, Math.PI / 2 + 0.22)))
  }
  void pal
  return merge(parts)
}

/* ------------------------------------------------------------ marine life */

/**
 * ===========================================================================
 * THINGS THAT ARE ALIVE OUT THERE -- AND THE FOUR REASONS THIS USED TO BE SKY.
 * ===========================================================================
 *
 * The note above used to close by listing four ways a modelled whale goes
 * wrong: it would have to be camera-locked, kept inside the far plane,
 * excluded from fog, and sorted against the terrain shell. Those are real
 * failure modes and they are the specification for this block. Each one was
 * measured rather than argued:
 *
 * 1. CAMERA-LOCKED -- not needed, and it was the wrong instinct. That
 *    objection belongs to an animal that must be visible from anywhere on the
 *    lap. These are placed at BEATS: every one is anchored to a named tag, on
 *    a closed path, and the player arrives at it once a lap. An animal that
 *    follows the camera is exactly the animal that CANNOT be driven past,
 *    which is the thing that was asked for.
 *
 * 2. THE FAR PLANE -- measured, never close. `game/camera.ts` builds the chase
 *    camera as `new THREE.PerspectiveCamera(fovRest, aspect, 0.35, 4000)`. The
 *    furthest thing placed below sits 190 m off the road. The far plane is
 *    twenty times anything here asks of it.
 *
 * 3. EXCLUDED FROM FOG -- the opposite. The fog is the effect, and trying to
 *    see THROUGH it is what made the old note reach for 400 m. FogExp2 at this
 *    track's 0.0072 leaves exp(-(d * density)^2) of an object:
 *
 *        100 m  0.60     200 m  0.13     300 m  0.009
 *        150 m  0.31     250 m  0.04     400 m  0.0002
 *
 *    A silhouette at 400 m is not dim, it is ABSENT -- and `ships` was never
 *    drawing at 400 m either, because `ships` draws on the DOME, which is in
 *    front of the fog by construction. So everything modelled here lives
 *    between 40 m and 190 m, inside the fog, on the same material every prop
 *    uses, and grades onto the fog colour exactly the way the kelp does. At
 *    the Breach, where `weather` takes the density to 0.0165, the same formula
 *    says 40 m -> 0.65 and 100 m -> 0.07, so the Breach's life is placed at
 *    35-55 m and nothing else. Different fog, different beat, different
 *    staging: that is the reason the Breach reads as a different scene.
 *
 * 4. SORTED AGAINST THE TERRAIN SHELL -- solved by refusing to be transparent.
 *    A seam against the shell is a sorting problem, and there is a sorting
 *    problem only when something will not write depth. These are opaque,
 *    depth-writing meshes on `ctx.propMaterial`; the depth buffer sorts them
 *    against the terrain for free, the same way it sorts the wrecks. It also
 *    means `tools/probe-intrude.ts` can SEE them, because that probe skips
 *    depthWrite:false as paint -- which is the property this feature most
 *    needed to keep, not to dodge.
 *
 * WHY THE `ships` LAYER STAYS. It is a different distance band and a different
 * surface. `ships` draws on the sky dome, outside the fog, at 20 degrees of
 * elevation and 13 degrees of size: three vast things a long way up the water
 * column that can never be approached. This is the near field, 35-190 m,
 * inside the fog, going past. Replacing the dome layer with this one would
 * trade a free background for nothing.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE IS EMISSIVE, AND NOTHING HERE IS LIT BY ITS OWN LIGHT.
 *
 * GDD 09 rather than taste: the road is the only bright region in frame and it
 * has to stay that way. Every body below is `ctx.propMaterial` -- the shared
 * flat-shaded MeshStandardMaterial the kelp and the wrecks use -- with a dark
 * albedo, so an animal can only ever be lit BY the scene and can never add to
 * it. The one place the frame has any light in it is the water column above
 * the eye line (`horizonColor` 0x2e93b4 at gain 0.70), and that is the canvas:
 * a dark body crossing that band reads at a glance, and the same body against
 * the black seabed below the eye line reads as nothing at all. So the staging
 * rule for the whole layer is ABOVE THE EYE LINE, 40-190 m out. It also means
 * the layer costs no material and no shader program: the instanced variant of
 * `propMaterial` is already compiled for the hero props.
 *
 * ---------------------------------------------------------------------------
 * THREE DRAW CALLS, TOTAL.
 *
 * One InstancedMesh per species, not per animal and not per school. A whale is
 * two instances (body + fluke) and a shark is two (body + caudal fin), which is
 * what lets the tail beat against the body with no skinning and no second draw
 * call; a school is however many fish it has, in the same batch as every other
 * school's.
 *
 * ---------------------------------------------------------------------------
 * EVERYTHING CLOSES ON ONE PERIOD, BECAUSE THAT IS WHAT MAKES IT PROVABLE.
 *
 * `tools/probe-intrude.ts` tests the rest pose. An animated animal can clear it
 * at t=0 and swim through the deck at t=31. `tools/probe-swim.ts` is the gate
 * that covers the motion, and it can only be a PROOF rather than a sample if
 * the motion is periodic -- so every rate below is an integer multiple of
 * LIFE_W, every path is closed, and nothing integrates state. Sweep
 * [0, LIFE_PERIOD) and you have swept all of time. Deliberately: a wind-driven
 * surge on the Breach school was written and then removed, because coupling to
 * `FrameInfo.wind` makes the position depend on the player and turns the proof
 * back into a sample.
 * ---------------------------------------------------------------------------
 */

/** One loop of the whole layer. Every rate below is an integer multiple. */
const LIFE_PERIOD = 240
const LIFE_W = (Math.PI * 2) / LIFE_PERIOD

/**
 * The road's airspace, as this layer has to respect it.
 *
 * MEASURED, not assumed: an 8-car AI race on this circuit (3 laps, 16,298 sim
 * steps) put the highest racer 16.40 m above the deck, at s=577 -- the trench
 * jump, which is the only place on the lap anything leaves the road. Off the
 * jump the ceiling is the flight chassis's own 6.5 m. `loopHoop` above uses
 * 6.5; `probe-intrude.ts` uses 5.0.
 *
 * `tools/probe-swim.ts` GATES at 20 m: the 16.40 plus 3.6 of margin. This is
 * the PLACEMENT number, and it is the gate plus five, so a crossing body is
 * put above the line the gate draws rather than on it. Two numbers on purpose
 * -- a placement rule that equals its own gate reports a pass at 0.00 m and
 * tells nobody how much room it actually had.
 *
 * FIVE AND NOT TWENTY, which is what this was on the first pass. Height is not
 * free here: the chase camera pitches 12 degrees down into a 62-degree vertical
 * FOV, so the top of frame is 19 degrees up, and a body H metres over the deck
 * is only in shot from more than (H - 5.8) / tan(19deg) metres away. At H = 55
 * that is 145 m, and 145 m of this water leaves 31% of what is at the end of
 * it. At H = 39 it is 96 m and 57%. Every metre of paranoia here is paid for
 * in contrast, so the margin is a margin and not a shrug.
 */
const LIFE_ROAD_CLEAR = 25
/** Seabed clearance, well off the road. The floor is noisy out there. */
const LIFE_FLOOR_CLEAR = 5
/** Plan distance past the road's edge at which the road stops being the floor. */
const LIFE_NEAR_ROAD = 34
/** Plan slack a flanking body keeps on top of `clearOfTrack`'s own margin. */
const LIFE_FLANK_PAD = 6
/** How many times a flanking path may be pulled in toward its anchor. */
const LIFE_SHRINK = 18
/** How many points of each closed path the build-time settle tests. */
const LIFE_SETTLE = 48
/**
 * A body's half-height and plan radius, as fractions of its length.
 *
 * NOT the bounding sphere, which for a 31 m whale is 15.5 m and would push the
 * crossing ones 15 m higher than they need to be for nothing. Measured off the
 * parts: the mass is 0.235 of the length tall, the dorsal ridge takes it to
 * 0.25, the path's own pitch adds 0.5*sin(6.6deg) = 0.06, the bank adds
 * 0.19*sin(13.5deg) = 0.04 and the fluke's swing about 0.05. 0.45 covers all
 * of it with room, and `probe-swim.ts` measures the real geometry anyway, so
 * an underestimate here shows up as a smaller clearance rather than as a lie.
 */
const LIFE_HALF_H = 0.45
const LIFE_PLAN_R = 0.5

/* Flesh, at the albedo that reads as a silhouette against the lit water and as
 * nothing at all against the road. Nothing here is brighter than SILT. */
const WHALE_SKIN = 0x1d2c35
const WHALE_FIN = 0x14202a
const SHARK_SKIN = 0x27373f
const SHARK_FIN = 0x1a262d
/** The one lighter body, because a school is read by its shimmer, not its shape. */
const FISH_SCALE = 0x3d666e

/* --------------------------------------------------------- animal bodies */

/**
 * Every body is built NOSE ALONG +Z, UP +Y, ONE METRE LONG, so an instance's
 * scale is the animal's length in metres and the swim code never has to know
 * which species it is driving.
 */

/** Whale: the mass, the stock, two pectorals and a low dorsal ridge. */
function geoWhale(seg: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const wS = Math.max(6, seg + 1), hS = Math.max(4, seg - 2)
  // Mass forward of centre and tapering back: a sphere scaled 0.92 in Z and
  // pushed +0.05 leaves the rear quarter for the stock, which is where the
  // fluke has to hinge without showing a gap.
  //
  // 0.20 BY 0.26, NOT 0.38 BY 0.47. The first pass built the body at the
  // proportions a sphere wants rather than the ones an animal has, and in the
  // shot at s=1000 the result was a rounded dark lump on the horizon that read
  // as a boulder. A 31 m fin whale is about 6 m across and 8 m deep, which is
  // 0.19 by 0.26 of its length; at 150 m in this fog the silhouette is all
  // there is, and the silhouette is the proportions.
  parts.push(part(new THREE.SphereGeometry(0.5, wS, hS), WHALE_SKIN,
    xf(0, 0, 0.05, 0, 0, 0, 0.20, 0.26, 0.92)))
  parts.push(part(new THREE.CylinderGeometry(0.055, 0.022, 0.30, Math.max(4, seg - 3)),
    WHALE_SKIN, xf(0, 0, -0.36, 0, Math.PI / 2, 0)))
  for (const side of [-1, 1]) {
    parts.push(part(new THREE.BoxGeometry(0.26, 0.020, 0.075), WHALE_FIN,
      xf(side * 0.13, -0.03, 0.10, side * 0.52, 0, side * 0.22)))
  }
  parts.push(part(new THREE.BoxGeometry(0.035, 0.040, 0.13), WHALE_FIN, xf(0, 0.14, -0.12)))
  return merge(parts)
}

/** Whale fluke, hinged at the origin. Horizontal, because a cetacean's is. */
function geoFluke(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  for (const side of [-1, 1]) {
    parts.push(part(new THREE.BoxGeometry(0.28, 0.020, 0.10), WHALE_FIN,
      xf(side * 0.13, 0, -0.03, side * 0.34, 0, side * 0.10)))
  }
  return merge(parts)
}

/** Shark: spindle, snout, dorsal, two pectorals and the peduncle. */
function geoShark(seg: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const wS = Math.max(6, seg), hS = Math.max(4, seg - 3)
  parts.push(part(new THREE.SphereGeometry(0.5, wS, hS), SHARK_SKIN,
    xf(0, 0, 0.02, 0, 0, 0, 0.16, 0.22, 0.84)))
  parts.push(part(new THREE.ConeGeometry(0.075, 0.24, 5), SHARK_SKIN,
    xf(0, -0.01, 0.44, 0, Math.PI / 2, 0, 1, 1, 0.80)))
  // Flattened three-sided cones for the fins: six triangles each and the right
  // silhouette from the side, which is the only angle a shark is read from.
  parts.push(part(new THREE.ConeGeometry(0.13, 0.22, 3), SHARK_FIN,
    xf(0, 0.11, -0.02, 0, -0.42, 0, 0.16, 1, 1)))
  for (const side of [-1, 1]) {
    parts.push(part(new THREE.ConeGeometry(0.14, 0.24, 3), SHARK_FIN,
      xf(side * 0.07, -0.04, 0.10, side * 0.50, 0, -side * 1.42, 0.18, 1, 1)))
  }
  parts.push(part(new THREE.CylinderGeometry(0.040, 0.022, 0.20, 4), SHARK_SKIN,
    xf(0, 0, -0.36, 0, Math.PI / 2, 0)))
  return merge(parts)
}

/** Shark caudal fin, hinged at the origin. Vertical, and asymmetric. */
function geoCaudal(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  parts.push(part(new THREE.BoxGeometry(0.018, 0.32, 0.12), SHARK_FIN, xf(0, 0.12, -0.07, 0, -0.44, 0)))
  parts.push(part(new THREE.BoxGeometry(0.018, 0.16, 0.09), SHARK_FIN, xf(0, -0.06, -0.05, 0, 0.30, 0)))
  return merge(parts)
}

/** One fish: twelve triangles, and eleven of them are the silhouette. */
function geoFish(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  parts.push(part(new THREE.ConeGeometry(0.17, 0.72, 3), FISH_SCALE,
    xf(0, 0, 0.14, 0, Math.PI / 2, 0, 0.55, 1, 1)))
  parts.push(part(new THREE.ConeGeometry(0.15, 0.26, 3), FISH_SCALE,
    xf(0, 0, -0.35, 0, -Math.PI / 2, 0, 0.30, 1, 1)))
  return merge(parts)
}

/* ------------------------------------------------------- where they live */

/**
 * ONE ROW PER ANIMAL, ANCHORED TO A TAG.
 *
 * Nothing below is a world coordinate. Every row names one of the nineteen
 * tags `src/content/tracks/abyssal.ts` authors, an along-lap offset from it in
 * metres and a lateral offset from the centreline -- so the art layer reads
 * content and the whole layer follows the road if the road moves again. (It
 * moved this morning: 3967.9 m, 42-102 m wide, and the corkscrew went from
 * three turns to two.)
 *
 * `up` is a STARTING height above the deck at the anchor, not a final one.
 * `settle()` below walks each closed path and lifts it until every point of it
 * clears whatever is underneath -- the road's airspace where the path passes
 * over the lap, the seabed where it does not. That is why a row can ask for a
 * whale at +14 m and get one at +14 m over open water and a rise over the road.
 *
 * WHAT EACH BEAT GETS, AND WHY IT IS NOT THE SAME ANIMAL EVERY TIME:
 *
 *   shelf apron   open water, and the first thing anyone sees of this planet:
 *                 one whale crossing high over the tube ahead, one school out
 *                 to the left at eye level, a pair of sharks holding off right.
 *   bloom A       a school low over the coral banks on the approach and
 *                 NOTHING at the apex. The slick corner is the difficulty of
 *                 this circuit; the beacons own that frame.
 *   trench jump   the one place the lap lets you look DOWN. A whale passes
 *                 under the broken span while you are in the air over it, and
 *                 two sharks work the wreck field beyond.
 *   the long wave the stretch between the jump and the Descent (see the beat
 *                 list at the top -- the Cathedral is not currently built). A
 *                 travelling PAIR of whales alongside the boost-wave straight,
 *                 sharks at the hook and the hairpin, schools either side.
 *   the Descent   a double VERTICAL cyclone whose deck climbs to 64.8 m and
 *                 falls to 14.6 m twice. Life over the top of it has to sit at
 *                 64.8 + 25 + 15 = 105 m and was photographed as absent at
 *                 s=1760, s=1850 and s=2100, so it went to the outside of the
 *                 coil instead: a whale and a school at 70 m from the cyclone's
 *                 axis, which is as close as the corridor allows.
 *   the Breach    the fog doubles here, so anything past 55 m does not exist.
 *                 Fish stream PAST you at the corridor limit, fast, with one
 *                 large shark in the murk. Nothing crosses overhead: see the
 *                 note on the Breach shark for the arithmetic that rules it
 *                 out. No whales either -- at this density a whale far enough
 *                 away to fit in frame cannot be seen at all.
 *   the run home  a whale over the top of the S, a school at bloom D, sharks
 *                 through the exit and the last hairpin.
 */

/**
 * 'cross' -- may pass over the lap in plan; settled by being LIFTED until it
 *            clears the deck under it. The whales over the tube.
 * 'flank' -- must clear the corridor in plan; settled by being pulled IN
 *            toward its anchor. Everything meant to be seen from the side.
 *
 * ---------------------------------------------------------------------------
 * THERE IS NO 'UNDER', AND THAT IS A PROPERTY OF THE ROAD, NOT OF THE ART.
 *
 * Vince asked for animals crossing over the tube, under it and alongside it.
 * This delivers two of the three. A third mode was written, a whale and then a
 * school were placed in it, and it was deleted after three measurements:
 *
 *  1. `makeGround` caps the terrain shell at the road's own plane EVERYWHERE
 *     -- "the one hard rule: never above the road, anywhere, on any section"
 *     -- so on 3,916 of this lap's 3,968 metres the seabed runs straight up
 *     under the deck and there is no space to put anything in at all.
 *  2. The exception is the trench jump, where `CHASM_D` cuts a 38 m ravine
 *     within `CHASM_R` = 52 m of the open span. But that ravine is a bowl
 *     centred on the CENTRELINE: by the time it emerges past the deck's own
 *     38 m half-width it is 1.4 m deep. There is nothing to look down into.
 *  3. And nothing to look down THROUGH. `circuit.ts` builds a jump's gap as
 *     "unbarriered road", not as a hole -- the deck is continuous and opaque
 *     across the whole span. So even the 19.1 m of window that does exist
 *     between the ravine floor and the underside of that deck cannot be seen
 *     from the road. The school placed in it was photographed at s=560 and is
 *     not in the photograph.
 *
 * (For the record, a whale would not have fitted in that window either: a 26 m
 * fin whale needs about 24 m once its pitch, bank and fluke swing are counted,
 * against 19.1 m of room.)
 */
type LifeMode = 'cross' | 'flank'

interface BeastSpec {
  tag: string
  /** Along-lap offset from the tag, metres. */
  ds: number
  /** Off the centreline, metres, along the sample's plan lateral. */
  lat: number
  /** Above the deck at the anchor, metres, BEFORE the settle. */
  up: number
  /** Path half-axes: across the road, along it, and vertical. */
  a: number; b: number; c: number
  /** Swing the across-axis off the road's lateral, degrees, in plan. */
  turn: number
  /** Whole cycles of the path per LIFE_PERIOD. Integer: see the note above. */
  k: number
  /** Start position in the cycle, turns. */
  ph: number
  /** Nose to tail, metres. */
  len: number
  /** How this body is allowed to sit relative to the road. See `settle`. */
  mode: LifeMode
}

/** Fin whales and a humpback, 24-33 m, at 3-7 m/s. */
const WHALES: BeastSpec[] = [
  // Shelf apron. Crossing the tube 130 m up the road from the line. The settle
  // puts it ~44 m over the deck, which from a chase camera 5.8 m up is 13
  // degrees of elevation at 120 m -- inside the 19 the frame reaches, and close
  // enough that the fog still leaves half of it.
  { tag: 'start', ds: 128, lat: 0, up: 40, a: 132, b: 44, c: 5, turn: 8, k: 1, ph: 0.62, len: 31, mode: 'cross' },
  // Trench jump, DOWN IN THE TRENCH rather than under the deck -- see the note
  // on the ravine in the report for this pass. Beside and below, so it crosses
  // the frame while the car is in the air over the gap and the camera's
  // 12-degree look-down is pointing at it.
  { tag: 'trench-jump', ds: 20, lat: 76, up: 10, a: 100, b: 14, c: 7, turn: 90, k: 2, ph: 0.30, len: 26, mode: 'flank' },
  // The long wave: a travelling pair off the boost-wave straight, same path,
  // same rate, a sixteenth of a turn apart, so they hold formation the way
  // animals that size actually move. `turn: 90` runs the long axis ALONG the
  // road, so they track you rather than crossing in front of you.
  { tag: 'boost-wave', ds: 40, lat: -78, up: 16, a: 150, b: 14, c: 9, turn: 90, k: 1, ph: 0.10, len: 29, mode: 'flank' },
  { tag: 'boost-wave', ds: 40, lat: -102, up: 26, a: 150, b: 14, c: 9, turn: 90, k: 1, ph: 0.16, len: 24, mode: 'flank' },
  // THE DESCENT, and the beat that had to be re-staged after it was
  // photographed. The corkscrew is a double vertical cyclone: r=30 in plan,
  // 21 m half-width, and its deck climbs to 64.8 m and falls to 14.6 m twice
  // over 400 m. From inside it the frame is almost entirely black road with a
  // slot of lit water on the outside of the coil, and the first version -- one
  // whale crossing above the whole thing -- was settled to 64.8 + 25 + 15 =
  // 104.6 m and is simply not in the shot at s=1760, s=1850 or s=2100.
  //
  // So the Descent gets the outside of its own coil instead. A flanking body
  // may come within corridor(21) + radius + margin = 38.6 m of the coil's
  // centreline, and the centreline is a 30 m circle, so 70 m from the cyclone's
  // axis is as close as anything is allowed and it is 45-65 m of slant range
  // from a car on the far side -- which is 50-65% transmittance, the best
  // numbers on this half of the lap. It sits at the coil's own mid height, so
  // you pass it twice going down.
  { tag: 'spiral', ds: 150, lat: 92, up: 6, a: 24, b: 78, c: 14, turn: 90, k: 2, ph: 0.44, len: 28, mode: 'flank' },
  // The run home: over the top of the S, seen on the long climb into it.
  { tag: 's-top', ds: -72, lat: 0, up: 40, a: 130, b: 46, c: 6, turn: -10, k: 1, ph: 0.86, len: 32, mode: 'cross' },
]

/**
 * 9-13 m, and the ones that have to read as an ANIMAL rather than a shape.
 *
 * TWICE the size the first pass used, and half the distance. Photographed at
 * s=40 with nine 6-8 m sharks at 100-150 m, the shot contained no visible
 * shark at all: at 150 m the fog leaves 31% of a body that is 2.8 degrees
 * across, which is 38 px of 20%-contrast smudge. The corridor is what sets the
 * floor on distance -- nothing may come within corridor + radius + margin of
 * the centreline -- so the only free variable left was size. At 70 m a 12 m
 * animal is 9.8 degrees and 130 px at 64% transmittance, and the tail beat and
 * the bank are legible on it.
 *
 * `turn` near 70-76 rather than 0 for the same reason: a circuit whose long
 * axis runs ACROSS the road spends most of its time at the far end of it, and
 * one whose long axis runs ALONG the road stays at the near lateral the whole
 * way round and tracks past you.
 */
const SHARKS: BeastSpec[] = [
  // Shelf apron, off the right, holding a tight circuit at eye level: the
  // banking is the tell, and a tight circuit banks.
  { tag: 'start', ds: 146, lat: 76, up: 12, a: 16, b: 30, c: 6, turn: 74, k: 6, ph: 0.00, len: 12.0, mode: 'flank' },
  { tag: 'start', ds: 172, lat: 92, up: 20, a: 16, b: 30, c: 6, turn: 74, k: 6, ph: 0.35, len: 9.6, mode: 'flank' },
  // The wreck field past the trench jump.
  { tag: 'trench-jump', ds: 88, lat: 78, up: 8, a: 18, b: 34, c: 8, turn: 76, k: 6, ph: 0.20, len: 12.6, mode: 'flank' },
  { tag: 'trench-jump', ds: 108, lat: 96, up: 16, a: 18, b: 34, c: 8, turn: 76, k: 6, ph: 0.62, len: 10.2, mode: 'flank' },
  // The long wave: the hook and the first hairpin.
  { tag: 'hook', ds: -44, lat: 82, up: 14, a: 18, b: 32, c: 7, turn: 72, k: 6, ph: 0.48, len: 12.2, mode: 'flank' },
  { tag: 'hairpin-1', ds: 44, lat: -88, up: 18, a: 18, b: 30, c: 9, turn: -66, k: 6, ph: 0.12, len: 10.6, mode: 'flank' },
  // THE BREACH, AND WHY NOTHING CROSSES HERE.
  //
  // This one was written as a crossing shark and measured as invisible. At
  // `weather.fogDensity` 0.0165 the transmittance is exp(-(d*0.0165)^2): 40 m
  // -> 0.65, 60 m -> 0.37, 80 m -> 0.19, 110 m -> 0.04. A crossing body has to
  // clear the deck by 25 m plus its own half-height, and at 28 m up it does not
  // enter a frame whose top edge is 19 degrees until it is 75 m away -- by
  // which point the murk has taken four fifths of it. The settle put it at
  // 43.5 m and 110 m, which is 4%: a shark nobody would ever report seeing.
  //
  // So the Breach is the beat where the life comes past you SIDEWAYS. The
  // corridor is 47 m here, so nothing may be closer than about 61 m in plan --
  // but 61 m at 18 m of height is 64 m of slant range and 33% transmittance,
  // which is the best number available anywhere at this beat, and it puts the
  // animal just above the eye line where the water column is still lit.
  { tag: 'breach', ds: 26, lat: 70, up: 19, a: 16, b: 30, c: 5, turn: 66, k: 8, ph: 0.55, len: 11.4, mode: 'flank' },
  // The run home.
  { tag: 's-exit', ds: 26, lat: -78, up: 13, a: 18, b: 32, c: 7, turn: -74, k: 6, ph: 0.72, len: 11.8, mode: 'flank' },
  { tag: 'hairpin-2', ds: -44, lat: 96, up: 17, a: 18, b: 30, c: 8, turn: 66, k: 6, ph: 0.28, len: 9.8, mode: 'flank' },
]

interface SchoolSpec {
  tag: string; ds: number; lat: number; up: number
  a: number; b: number; c: number; turn: number
  k: number; ph: number
  /** See `settle`. */
  mode: LifeMode
  /** Fish at propDensity 1.0. */
  n: number
  /**
   * Fish length range, metres.
   *
   * 0.9-1.8 rather than the 0.5-1.0 this started at, for the same reason the
   * sharks doubled: a 0.9 m body at 90 m is 0.4 degrees, which is five pixels,
   * and five pixels at 60% transmittance is nothing. A school reads as a MASS
   * with a direction, and the mass has to have pixels in it. These are deep
   * water fish and there is no scale reference outside the glass to argue with.
   */
  lo: number; hi: number
  /** Blob half-extents: along the school's own path, across it, and up. */
  ss: number; sr: number; su: number
  /**
   * How far back down its OWN PAST TRACK the tail of the school trails,
   * seconds. This is the whole of the flocking: a fish is not carried rigidly
   * with the school, it is placed where the school WAS `lag` seconds ago, so
   * the body of the school shears round its own turns instead of sliding
   * through them sideways. Costs one path evaluation per lag bucket per frame.
   */
  lag: number
  seed: number
}

const SCHOOLS: SchoolSpec[] = [
  // Shelf apron, out to the left and swimming ALONG with you (`turn: 74`), big
  // enough to be the first thing on this planet that moves.
  { tag: 'start', ds: 66, lat: -80, up: 15, a: 58, b: 18, c: 11, turn: 78, k: 4, ph: 0.20, mode: 'flank',
    n: 74, lo: 1.05, hi: 1.85, ss: 9, sr: 7.0, su: 4.4, lag: 2.6, seed: 0x5f15a1 },
  // Bloom A, on the APPROACH and low over the coral banks. Nothing at the apex.
  { tag: 'bloom', ds: -58, lat: -76, up: 11, a: 50, b: 18, c: 9, turn: -76, k: 5, ph: 0.55, mode: 'flank',
    n: 62, lo: 0.90, hi: 1.55, ss: 7.5, sr: 6.5, su: 3.8, lag: 2.2, seed: 0xb100 },
  // The long wave, either side: the swell and bloom B.
  { tag: 'swell', ds: 30, lat: 84, up: 20, a: 58, b: 18, c: 13, turn: 76, k: 4, ph: 0.72, mode: 'flank',
    n: 70, lo: 1.00, hi: 1.70, ss: 9, sr: 7.0, su: 4.6, lag: 2.8, seed: 0x5e11 },
  { tag: 'bloom-b', ds: -34, lat: 80, up: 15, a: 52, b: 18, c: 10, turn: -74, k: 5, ph: 0.34, mode: 'flank',
    n: 60, lo: 0.95, hi: 1.60, ss: 8, sr: 6.5, su: 4.0, lag: 2.4, seed: 0xb100b },
  // The Descent, wrapping the corkscrew from ABOVE, with a big vertical
  // amplitude so the school rises past you while you go down.
  { tag: 'spiral', ds: 250, lat: -86, up: 14, a: 22, b: 64, c: 20, turn: 90, k: 3, ph: 0.08, mode: 'flank',
    n: 82, lo: 0.95, hi: 1.65, ss: 9, sr: 7.0, su: 4.8, lag: 3.2, seed: 0x5914a1 },
  // The Breach: alongside, at the corridor limit, and FAST -- k=10 puts them at
  // 15 m/s, which at this size is not swimming, it is being carried. `turn: 24`
  // aims the long axis mostly ACROSS the road so they stream past you rather
  // than travel with you, which is the whole read of a current. See the note on
  // the Breach shark for why nothing here crosses overhead.
  { tag: 'breach', ds: 34, lat: 74, up: 16, a: 44, b: 20, c: 6, turn: 52, k: 10, ph: 0.40, mode: 'flank',
    n: 78, lo: 0.85, hi: 1.45, ss: 8, sr: 6.0, su: 3.6, lag: 1.5, seed: 0xb2eac4 },
  // The trench jump. This was written as a school passing UNDER the open span
  // and deleted after it was photographed and found to be behind an opaque
  // deck -- see the note on LifeMode. It is now what the span actually affords:
  // a school working the wreck field just off the drop-off lip, low, where the
  // camera's 12-degree look-down puts it in the bottom third of the frame while
  // the car is in the air.
  { tag: 'trench-jump', ds: 62, lat: -72, up: 6, a: 46, b: 22, c: 7, turn: 78, k: 5, ph: 0.18, mode: 'flank',
    n: 70, lo: 0.85, hi: 1.40, ss: 7.5, sr: 6.0, su: 3.4, lag: 1.8, seed: 0x9a9f15 },
  // The run home.
  { tag: 'bloom-d', ds: -30, lat: -82, up: 17, a: 54, b: 18, c: 12, turn: 74, k: 4, ph: 0.64, mode: 'flank',
    n: 66, lo: 0.95, hi: 1.60, ss: 8, sr: 6.5, su: 4.0, lag: 2.6, seed: 0xd100d },
]

/* ------------------------------------------------------------ the swimming */

/** A resolved closed path plus the instance slots that ride it. */
interface Swim {
  hx: number; hy: number; hz: number
  ux: number; uz: number; vx: number; vz: number
  a: number; b: number; c: number
  /** Radians per second. Always an integer multiple of LIFE_W. */
  w: number
  /** Radians. */
  ph: number
  len: number
  /** Bank gain: how hard the body rolls into its own lateral acceleration. */
  roll: number
  /** Tail beat, rad/s and radians. */
  beatW: number; beatAmp: number
  /** Instance slots: body, then appendage. */
  iBody: number; iTail: number
  /** True for a fluke (pitches); false for a caudal fin (yaws). */
  fluke: boolean
}

/* Scratch. The per-frame hook must not allocate. */
const _p = { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0, ax: 0, ay: 0, az: 0 }
const _f = {
  xx: 0, xy: 0, xz: 0, yx: 0, yy: 0, yz: 0, zx: 0, zy: 0, zz: 0,
  px: 0, py: 0, pz: 0,
}

/**
 * Position, velocity and acceleration on a closed path at time `t`.
 *
 * The path is an ellipse in plan with a vertical term at twice the rate, which
 * is the cheapest closed curve that is not a circle and not planar: it gives a
 * body a turn to bank into and a rise to pitch through, for six trig calls.
 */
function swimAt(s: Swim, t: number): void {
  const th = s.w * t + s.ph
  const ct = Math.cos(th), st = Math.sin(th)
  const c2 = Math.cos(2 * th), s2 = Math.sin(2 * th)
  const A = s.a, B = s.b, C = s.c, w = s.w
  _p.x = s.hx + s.ux * A * ct + s.vx * B * st
  _p.z = s.hz + s.uz * A * ct + s.vz * B * st
  _p.y = s.hy + C * s2
  _p.tx = w * (-s.ux * A * st + s.vx * B * ct)
  _p.tz = w * (-s.uz * A * st + s.vz * B * ct)
  _p.ty = w * 2 * C * c2
  const w2 = w * w
  _p.ax = w2 * (-s.ux * A * ct - s.vx * B * st)
  _p.az = w2 * (-s.uz * A * ct - s.vz * B * st)
  _p.ay = -w2 * 4 * C * s2
}

/**
 * Turn the last `swimAt` into an orthonormal frame with the body's nose on +Z.
 *
 * The roll is an exaggeration and is meant to be: on the whales' own paths the
 * true lateral acceleration is 0.35 m/s^2, which is a two-degree bank nobody
 * would ever see. `roll` multiplies it before the arctangent, so a whale leans
 * a readable amount into a turn it is genuinely making, and a shark on a
 * six-times-tighter circuit leans a lot more, which is the difference between
 * the two species the player actually reads.
 */
function frameHere(roll: number): void {
  // sqrt(x*x+...) rather than Math.hypot: hypot does overflow-safe scaling that
  // costs several times a bare square root in V8, and this runs 94 times a
  // frame on inputs that are tens of metres per second. Measured in the whole
  // layer's per-frame cost below.
  const L = Math.sqrt(_p.tx * _p.tx + _p.ty * _p.ty + _p.tz * _p.tz) || 1
  const fx = _p.tx / L, fy = _p.ty / L, fz = _p.tz / L
  // X = worldUp x forward, which for a body facing +Z with +Y up is its LEFT.
  const hl = Math.sqrt(fz * fz + fx * fx) || 1
  let xx = fz / hl, xy = 0, xz = -fx / hl
  // Y = forward x X.
  let yx = fy * xz - fz * xy
  let yy = fz * xx - fx * xz
  let yz = fx * xy - fy * xx
  if (roll !== 0) {
    // Negative, because +X is the body's left: a left turn has to drop the
    // left wing, and rolling +about+ the nose raises it.
    let bank = -roll * (_p.ax * xx + _p.ay * xy + _p.az * xz) / 9.81
    if (bank > 0.62) bank = 0.62; else if (bank < -0.62) bank = -0.62
    const cb = Math.cos(bank), sb = Math.sin(bank)
    const nx = xx * cb + yx * sb, ny = xy * cb + yy * sb, nz = xz * cb + yz * sb
    yx = -xx * sb + yx * cb; yy = -xy * sb + yy * cb; yz = -xz * sb + yz * cb
    xx = nx; xy = ny; xz = nz
  }
  _f.xx = xx; _f.xy = xy; _f.xz = xz
  _f.yx = yx; _f.yy = yy; _f.yz = yz
  _f.zx = fx; _f.zy = fy; _f.zz = fz
  _f.px = _p.x; _f.py = _p.y; _f.pz = _p.z
}

/** Write one instance straight into the buffer. Column-major, like Matrix4. */
function setInst(
  arr: Float32Array, i: number, s: number,
  xx: number, xy: number, xz: number,
  yx: number, yy: number, yz: number,
  zx: number, zy: number, zz: number,
  px: number, py: number, pz: number,
): void {
  const o = i * 16
  arr[o] = xx * s; arr[o + 1] = xy * s; arr[o + 2] = xz * s; arr[o + 3] = 0
  arr[o + 4] = yx * s; arr[o + 5] = yy * s; arr[o + 6] = yz * s; arr[o + 7] = 0
  arr[o + 8] = zx * s; arr[o + 9] = zy * s; arr[o + 10] = zz * s; arr[o + 11] = 0
  arr[o + 12] = px; arr[o + 13] = py; arr[o + 14] = pz; arr[o + 15] = 1
}

/** Lag buckets per school. See `SchoolSpec.lag`. */
const SCHOOL_BUCKETS = 8
/** Tail-beat rates, as whole cycles per LIFE_PERIOD. */
const WHALE_BEAT_K = 56
const SHARK_BEAT_K = 168
const FISH_FLICK_K = 520
const WHALE_BEAT = 0.38
const SHARK_BEAT = 0.46
const FISH_FLICK = 0.26
/** Where the tail hinges, as a fraction of body length back from the middle. */
const HINGE = 0.44

/**
 * A 512-entry sine table, for the per-fish flick and nothing else.
 *
 * MEASURED, on 4000 `env.update` calls per tier (`buildEnvironment` + a fixed
 * camera, no renderer). The first working version of this layer took
 * `env.update` from 4.1 us a frame to 66.0 us at the high tier, and the single
 * biggest line in that was one `Math.sin` per fish per frame. This table plus
 * the Taylor pair below took it to 36.8 us -- a 44% cut -- for a 0.7-degree
 * step in the yaw of a one-metre body a hundred metres away, which is under
 * one pixel. Per tier, before -> after the whole feature:
 *
 *     high    4.1 us -> 36.8 us      562 fish, 15 large bodies
 *     medium  4.1 us -> 33.1 us      426 fish
 *     low     2.5 us -> 24.7 us      229 fish
 *
 * On a 16.67 ms frame that is 0.2% here; a Snapdragon 778G runs this kind of
 * scalar loop about five times slower, so budget ~1%.
 *
 * It does NOT cost the periodicity proof `tools/probe-swim.ts` depends on: the
 * index is still a pure function of `time` and still closes on LIFE_PERIOD,
 * because the quantisation is of the phase, not an accumulation of it.
 */
const FLICK_N = 512
const FLICK_TABLE = new Float32Array(FLICK_N)
for (let i = 0; i < FLICK_N; i++) FLICK_TABLE[i] = Math.sin((i / FLICK_N) * Math.PI * 2)
const FLICK_SCALE = FLICK_N / (Math.PI * 2)

/**
 * Rotate the scratch frame about its own X (a fluke's pitch) or Y (a caudal
 * fin's yaw). Both appendages beat; which axis they beat about is the whole
 * difference between a cetacean and a fish, and it is one line each.
 */
function frameRollX(ang: number): void {
  const c = Math.cos(ang), s = Math.sin(ang)
  const yx = _f.yx * c + _f.zx * s, yy = _f.yy * c + _f.zy * s, yz = _f.yz * c + _f.zz * s
  _f.zx = -_f.yx * s + _f.zx * c; _f.zy = -_f.yy * s + _f.zy * c; _f.zz = -_f.yz * s + _f.zz * c
  _f.yx = yx; _f.yy = yy; _f.yz = yz
}
function frameRollY(ang: number): void {
  const c = Math.cos(ang), s = Math.sin(ang)
  const xx = _f.xx * c - _f.zx * s, xy = _f.xy * c - _f.zy * s, xz = _f.xz * c - _f.zz * s
  _f.zx = _f.xx * s + _f.zx * c; _f.zy = _f.xy * s + _f.zy * c; _f.zz = _f.xz * s + _f.zz * c
  _f.xx = xx; _f.xy = xy; _f.xz = xz
}

/**
 * `environment.ts` disposes every geometry and material a theme hands to
 * `ctx.own`, and an InstancedMesh holds a GPU buffer of its own -- its
 * `instanceMatrix` -- that geometry disposal does not reach. `ThemeContext`
 * has no hook for an arbitrary disposable and widening it would mean editing
 * kit.ts, which five other themes read. So the mesh's teardown rides on its
 * own geometry's: `BufferGeometry.dispose()` dispatches a 'dispose' event and
 * this is the one listener on it, which makes the pairing impossible to get
 * half-right later.
 */
function ownInstanced(
  ctx: ThemeContext, geo: THREE.BufferGeometry, mesh: THREE.InstancedMesh, name: string,
): void {
  ctx.own(geo)
  geo.addEventListener('dispose', () => { mesh.dispose() })
  mesh.name = name
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  // REQUIRED, not an optimisation the other way round. An InstancedMesh with no
  // explicit `boundingSphere` is frustum-tested against its GEOMETRY's sphere
  // under its own (identity) world matrix -- a one-metre ball at the origin --
  // so the entire batch vanishes the moment the world origin leaves frame.
  mesh.frustumCulled = false
  ctx.add(mesh)
}

/* ------------------------------------------------------------ the build */

function marineLife(ctx: ThemeContext): void {
  const { track, quality } = ctx
  const S = track.samples, m = S.length
  const perM = m / track.length
  const DEG = Math.PI / 180

  /**
   * The highest piece of ROAD anywhere under (x, z), or -Infinity if there is
   * none within `radius`.
   *
   * MEASURED FIX. The settle used to take this from `ctx.ground`, which is
   * capped at the road plane and looked like it answered the same question.
   * It does not, on a stacked road: `makeGround`'s ceiling is a MINIMUM over
   * every section in reach, so under the corkscrew -- two coils of deck
   * directly above one another -- it returns the LOWER coil. `probe-swim.ts`
   * then found the whale meant to cross over the Descent 0.31 m inside the
   * road at s=1881, having been settled against a deck ten metres below the
   * one it was actually over. One of the eight circuits has a cyclone and this
   * is the only theme placing anything above one, so nothing else had ever
   * asked the height field a question it answers wrongly.
   *
   * Strided at 4 samples (6 m) because the answer is a maximum over a
   * neighbourhood tens of metres wide and no coil is 6 m long.
   */
  const deckAbove = (x: number, z: number, radius: number): number => {
    let top = -Infinity
    for (let i = 0; i < m; i += 4) {
      const c = S[i]
      const dx = x - c.pos.x, dz = z - c.pos.z
      const need = ctx.corridor(c.width) + radius
      if (dx * dx + dz * dz < need * need && c.pos.y > top) top = c.pos.y
    }
    return top
  }

  /**
   * Put a closed path somewhere it is allowed to be. TWO MODES, because the
   * two things being asked for have different answers.
   *
   * A CROSSING body is allowed over the lap in plan -- that is the whole point
   * of it -- so the constraint is vertical and the fix is to lift the path
   * bodily until its lowest point clears the deck under it by LIFE_ROAD_CLEAR.
   * `ctx.ground` is the same height field the terrain shell is built from and
   * it is capped at the road's own plane everywhere, so ONE query answers both
   * halves: over the lap it returns the deck and `edge` goes negative, and out
   * in open water it returns the seabed, which past 26 m carries up to 26 m of
   * relief noise and sags another 115 m past the fog wall. A body placed at a
   * flat height off a tag would be inside a ridge somewhere on its circuit,
   * and nobody would ever find that from a screenshot.
   *
   * A FLANKING body is meant to be seen from the side, at eye level, going
   * past -- and lifting it forty metres to satisfy the same rule would throw
   * away the only thing it was for. So it is pulled IN toward its own anchor,
   * 10% at a time, until every point of it clears the corridor in plan.
   * `ctx.clearOfTrack` is the placement engine's own test, the one the hero
   * prop scatter is already filtered by. It terminates: shrink a path far
   * enough and it is its anchor, and the anchor is off the road by inspection.
   *
   * MEASURED, and this is why there are two modes rather than one rule. With
   * lift-only, `probe-swim.ts` put the shark at the hook 7.38 m inside the road
   * at s=1467 and the school at bloom B 11.49 m inside at s=1296. Both anchors
   * are ~100 m off their own tag, both looked completely reasonable in the
   * table, and both paths reached across this lap's own fold-back and touched a
   * DIFFERENT stretch of road four hundred metres away round the circuit. That
   * is not a thing anyone finds by reading a coordinate.
   *
   * Sampled at the path point and at four offsets a body-radius out, because
   * what is being kept clear is a volume and not a centreline.
   */
  const settle = (sw: Swim, halfH: number, radius: number, mode: LifeMode): void => {
    if (mode === 'flank') {
      for (let attempt = 0; attempt <= LIFE_SHRINK; attempt++) {
        let ok = true
        for (let i = 0; i < LIFE_SETTLE && ok; i++) {
          const th = (i / LIFE_SETTLE) * Math.PI * 2
          const ct = Math.cos(th), st = Math.sin(th)
          ok = ctx.clearOfTrack(
            sw.hx + sw.ux * sw.a * ct + sw.vx * sw.b * st,
            sw.hz + sw.uz * sw.a * ct + sw.vz * sw.b * st,
            radius + LIFE_FLANK_PAD)
        }
        if (ok) break
        sw.a *= 0.9; sw.b *= 0.9
      }
    }
    // Two bounds on `hy`, gathered over the whole closed path: how far it must
    // rise to clear everything under it, and (for a body swimming under the
    // road) how far it must stay below the deck over it.
    let floor = -Infinity
    for (let i = 0; i < LIFE_SETTLE; i++) {
      const th = (i / LIFE_SETTLE) * Math.PI * 2
      const ct = Math.cos(th), st = Math.sin(th)
      const bx = sw.hx + sw.ux * sw.a * ct + sw.vx * sw.b * st
      const bz = sw.hz + sw.uz * sw.a * ct + sw.vz * sw.b * st
      // `hy` is what is being solved for, so the path's own vertical term has
      // to come out of both bounds rather than into the sample.
      const dy = sw.c * Math.sin(2 * th)
      for (let k = 0; k < 5; k++) {
        const ex = k === 1 ? radius : k === 2 ? -radius : 0
        const ez = k === 3 ? radius : k === 4 ? -radius : 0
        const px = bx + sw.ux * ex + sw.vx * ez, pz = bz + sw.uz * ex + sw.vz * ez
        // The seabed, always. `ctx.ground` is exactly right for this: it is the
        // field the terrain shell is built from, so "above the ground" means
        // above the mesh the player can actually see.
        const g = ctx.ground(px, pz)
        // The seabed test uses 0.6 of the road half-height. `halfH` carries the
        // pitch, bank and fluke excursions because the ROAD gate is tight and
        // 20 m is a line a body may not cross; the seabed is a dark surface
        // 100 m away in fog that a fin may graze without anyone ever seeing it,
        // and spending the full figure there was lifting the eye-level sharks
        // from +11 m to +25 m for nothing.
        const lo = g.y + LIFE_FLOOR_CLEAR + halfH * 0.6 - dy
        if (lo > floor) floor = lo
        if (mode === 'flank') continue
        const deck = deckAbove(px, pz, radius + LIFE_NEAR_ROAD)
        if (deck === -Infinity) continue
        const road = deck + LIFE_ROAD_CLEAR + halfH - dy
        if (road > floor) floor = road
      }
    }
    if (sw.hy < floor) sw.hy = floor
  }

  const resolve = (
    sp: BeastSpec | SchoolSpec, len: number, halfH: number, radius: number,
    roll: number, beatK: number, beatAmp: number, fluke: boolean,
    iBody: number, iTail: number,
  ): Swim | null => {
    const i0 = ctx.tagSample(sp.tag)
    if (i0 < 0) return null
    const smp = S[(((i0 + Math.round(sp.ds * perM)) % m) + m) % m]
    const tl = Math.hypot(smp.tangent.x, smp.tangent.z) || 1
    const fx = smp.tangent.x / tl, fz = smp.tangent.z / tl
    const ox = smp.tangent.z / tl, oz = -smp.tangent.x / tl
    const tw = sp.turn * DEG, c = Math.cos(tw), s = Math.sin(tw)
    const ux = ox * c + fx * s, uz = oz * c + fz * s
    const sw: Swim = {
      hx: smp.pos.x + ox * sp.lat, hy: smp.pos.y + sp.up, hz: smp.pos.z + oz * sp.lat,
      ux, uz, vx: -uz, vz: ux,
      a: sp.a, b: sp.b, c: sp.c,
      w: sp.k * LIFE_W, ph: sp.ph * Math.PI * 2,
      len, roll, beatW: beatK * LIFE_W, beatAmp, iBody, iTail, fluke,
    }
    settle(sw, halfH, radius, sp.mode)
    return sw
  }

  /* ---- whales and sharks ------------------------------------------------ */

  const whales: Swim[] = []
  for (let i = 0; i < WHALES.length; i++) {
    const sp = WHALES[i]
    const sw = resolve(sp, sp.len, sp.len * LIFE_HALF_H, sp.len * LIFE_PLAN_R,
      7.0, WHALE_BEAT_K, WHALE_BEAT, true, whales.length, whales.length)
    if (sw) whales.push(sw)
  }
  const sharks: Swim[] = []
  for (let i = 0; i < SHARKS.length; i++) {
    const sp = SHARKS[i]
    const sw = resolve(sp, sp.len, sp.len * LIFE_HALF_H, sp.len * LIFE_PLAN_R,
      4.5, SHARK_BEAT_K, SHARK_BEAT, false, sharks.length, sharks.length)
    if (sw) sharks.push(sw)
  }

  /* ---- schools ---------------------------------------------------------- */

  interface Shoal { sw: Swim; first: number; count: number; lag: number; buf: Float32Array }
  const shoals: Shoal[] = []
  let fishN = 0
  for (const sp of SCHOOLS) {
    const n = Math.max(6, Math.round(sp.n * quality.propDensity))
    // A school's own extent is its blob, not one fish: the settle has to keep
    // the whole cloud clear, and `ss` is its reach along its own path.
    const sw = resolve(sp, 1, sp.su + sp.hi * 0.6, sp.sr + sp.ss + sp.hi * 0.5,
      5.5, 0, 0, false, -1, -1)
    if (!sw) continue
    shoals.push({
      sw, first: fishN, count: n, lag: sp.lag,
      buf: new Float32Array(SCHOOL_BUCKETS * 12),
    })
    fishN += n
  }
  const fBucket = new Uint8Array(fishN)
  const fDs = new Float32Array(fishN)
  const fDr = new Float32Array(fishN)
  const fDu = new Float32Array(fishN)
  const fLen = new Float32Array(fishN)
  const fPh = new Float32Array(fishN)
  for (let si = 0; si < shoals.length; si++) {
    const sp = SCHOOLS[si], sh = shoals[si]
    const rnd = mulberry32(sp.seed)
    for (let i = sh.first; i < sh.first + sh.count; i++) {
      // Biased forward: a school has a head and a tail, not a uniform smear.
      fBucket[i] = Math.min(SCHOOL_BUCKETS - 1, Math.floor(Math.pow(rnd(), 0.72) * SCHOOL_BUCKETS))
      fDs[i] = (rnd() * 2 - 1) * sp.ss
      fDr[i] = (rnd() * 2 - 1) * sp.sr
      fDu[i] = (rnd() * 2 - 1) * sp.su
      fLen[i] = sp.lo + rnd() * (sp.hi - sp.lo)
      fPh[i] = rnd() * Math.PI * 2
    }
  }

  /* ---- the five batches ------------------------------------------------- */

  if (whales.length === 0 && sharks.length === 0 && fishN === 0) return

  const seg = ctx.seg
  const whaleGeo = geoWhale(seg)
  const whaleMesh = new THREE.InstancedMesh(whaleGeo, ctx.propMaterial, Math.max(1, whales.length))
  // The whales and only the whales. The key light is a near-vertical shaft and
  // the shadow cascade is a 116 m box tracking the camera, so a 30 m animal
  // passing over the tube lays a shadow across the road that arrives BEFORE it
  // does -- the one moment on this circuit where something outside the glass
  // touches the inside of it. A shark at 7 m and a fish at 0.8 m put a smudge
  // and nothing at all into the same 2048 map for the same second pass, so
  // they do not cast.
  whaleMesh.castShadow = quality.shadows
  ownInstanced(ctx, whaleGeo, whaleMesh, 'life-whale')

  const flukeGeo = geoFluke()
  const flukeMesh = new THREE.InstancedMesh(flukeGeo, ctx.propMaterial, Math.max(1, whales.length))
  flukeMesh.castShadow = quality.shadows
  ownInstanced(ctx, flukeGeo, flukeMesh, 'life-whale-fluke')

  const sharkGeo = geoShark(seg)
  const sharkMesh = new THREE.InstancedMesh(sharkGeo, ctx.propMaterial, Math.max(1, sharks.length))
  ownInstanced(ctx, sharkGeo, sharkMesh, 'life-shark')

  const caudalGeo = geoCaudal()
  const caudalMesh = new THREE.InstancedMesh(caudalGeo, ctx.propMaterial, Math.max(1, sharks.length))
  ownInstanced(ctx, caudalGeo, caudalMesh, 'life-shark-fin')

  const fishGeo = geoFish()
  const fishMesh = new THREE.InstancedMesh(fishGeo, ctx.propMaterial, Math.max(1, fishN))
  ownInstanced(ctx, fishGeo, fishMesh, 'life-fish')

  const wArr = whaleMesh.instanceMatrix.array as Float32Array
  const flArr = flukeMesh.instanceMatrix.array as Float32Array
  const kArr = sharkMesh.instanceMatrix.array as Float32Array
  const cArr = caudalMesh.instanceMatrix.array as Float32Array
  const fArr = fishMesh.instanceMatrix.array as Float32Array
  // An unfilled slot in a `Math.max(1, n)` batch would draw a unit body at the
  // world origin. Nothing on this lap is at the origin except the start line.
  for (const a of [wArr, flArr, kArr, cArr, fArr]) a.fill(0)

  const beasts = (list: Swim[], bodyArr: Float32Array, tailArr: Float32Array, t: number): void => {
    for (let i = 0; i < list.length; i++) {
      const s = list[i]
      swimAt(s, t)
      frameHere(s.roll)
      const beat = Math.sin(s.beatW * t + s.ph)
      // The BODY takes a third of the beat, in antiphase. A rigid hull towing a
      // flapping tail reads as a model of an animal; the body answering the
      // tail is what reads as propulsion, and a third is as far as it can go
      // before a whale starts to porpoise.
      if (s.fluke) frameRollX(-0.30 * s.beatAmp * beat)
      else frameRollY(-0.30 * s.beatAmp * beat)
      setInst(bodyArr, s.iBody, s.len,
        _f.xx, _f.xy, _f.xz, _f.yx, _f.yy, _f.yz, _f.zx, _f.zy, _f.zz,
        _f.px, _f.py, _f.pz)
      // The hinge travels with the body it is attached to, so it is taken from
      // the frame AFTER the counter-roll, not from the path.
      const h = -HINGE * s.len
      const hx = _f.px + _f.zx * h, hy = _f.py + _f.zy * h, hz = _f.pz + _f.zz * h
      if (s.fluke) frameRollX(s.beatAmp * beat)
      else frameRollY(s.beatAmp * beat)
      setInst(tailArr, s.iTail, s.len,
        _f.xx, _f.xy, _f.xz, _f.yx, _f.yy, _f.yz, _f.zx, _f.zy, _f.zz,
        hx, hy, hz)
    }
  }

  const flickW = FISH_FLICK_K * LIFE_W
  const swim = (t: number): void => {
    beasts(whales, wArr, flArr, t)
    beasts(sharks, kArr, cArr, t)
    for (let si = 0; si < shoals.length; si++) {
      const sh = shoals[si], buf = sh.buf
      // THE SCHOOL, AS ITS OWN WAKE. Evaluate the path at eight points spread
      // back over `lag` seconds and keep the frame at each: a fish sits where
      // the school WAS, so the body of it shears round a turn instead of
      // sliding through it sideways, and the whole thing costs eight path
      // evaluations rather than one per fish.
      for (let j = 0; j < SCHOOL_BUCKETS; j++) {
        swimAt(sh.sw, t - sh.lag * (j / (SCHOOL_BUCKETS - 1)))
        frameHere(sh.sw.roll)
        const o = j * 12
        buf[o] = _f.px; buf[o + 1] = _f.py; buf[o + 2] = _f.pz
        buf[o + 3] = _f.xx; buf[o + 4] = _f.xy; buf[o + 5] = _f.xz
        buf[o + 6] = _f.yx; buf[o + 7] = _f.yy; buf[o + 8] = _f.yz
        buf[o + 9] = _f.zx; buf[o + 10] = _f.zy; buf[o + 11] = _f.zz
      }
      const end = sh.first + sh.count
      for (let i = sh.first; i < end; i++) {
        const o = fBucket[i] * 12
        const xx = buf[o + 3], xy = buf[o + 4], xz = buf[o + 5]
        const yx = buf[o + 6], yy = buf[o + 7], yz = buf[o + 8]
        const zx = buf[o + 9], zy = buf[o + 10], zz = buf[o + 11]
        const ds = fDs[i], dr = fDr[i], du = fDu[i]
        const a = FISH_FLICK * FLICK_TABLE[(((flickW * t + fPh[i]) * FLICK_SCALE) | 0) & (FLICK_N - 1)]
        // Taylor, not libm. `a` is bounded by FISH_FLICK = 0.26 rad by
        // construction, and over that range these two are exact to about 1e-9
        // -- far under the 0.7-degree quantisation the table above already
        // introduced -- for two multiplies each instead of two library calls.
        const a2 = a * a
        const s = a * (1 - a2 * (1 / 6) * (1 - a2 * 0.05))
        const c = 1 - a2 * 0.5 * (1 - a2 * (1 / 12))
        setInst(fArr, i, fLen[i],
          xx * c - zx * s, xy * c - zy * s, xz * c - zz * s,
          yx, yy, yz,
          xx * s + zx * c, xy * s + zy * c, xz * s + zz * c,
          buf[o] + zx * ds + xx * dr + yx * du,
          buf[o + 1] + zy * ds + xy * dr + yy * du,
          buf[o + 2] + zz * ds + xz * dr + yz * du)
      }
    }
    whaleMesh.instanceMatrix.needsUpdate = true
    flukeMesh.instanceMatrix.needsUpdate = true
    sharkMesh.instanceMatrix.needsUpdate = true
    caudalMesh.instanceMatrix.needsUpdate = true
    fishMesh.instanceMatrix.needsUpdate = true
  }

  // The rest pose has to be the real t=0 pose and not an empty batch, because
  // `tools/probe-intrude.ts` builds a world and scans it without ever calling
  // update: whatever is in these buffers when the build returns is what that
  // gate measures.
  swim(0)
  ctx.onUpdate((f: FrameInfo) => { swim(f.time) })
}

/* -------------------------------------------------------------- landmarks */

function landmarks(ctx: ThemeContext): void {
  const { track, palette: pal, quality } = ctx
  bindSurfaceSpray(track, SPRAY)
  const m = track.samples.length

  /* ---- BLOOM BEACONS. The readability fix, and the reason it is here rather
   * than in the road shader: `oil` is one global albedo shared with Elkarim,
   * and darkening or brightening it to suit this planet would move a circuit
   * that is balanced and art-locked. So the warning is LOCAL -- a run of amber
   * posts down the approach to each bloom, pulsing, on both verges.
   *
   * Amber and not the planet's own cyan: everything alive down here is cyan, so
   * a cyan warning is camouflage. This is the only warm colour on the circuit
   * and it means exactly one thing. ---- */
  const iBloom = ctx.tagSample('bloom')
  if (iBloom >= 0) {
    const geo = new THREE.CylinderGeometry(0.34, 0.44, 3.2, 5)
    ctx.own(geo)
    const mat = new THREE.MeshBasicMaterial({ color: BEACON, fog: true })
    ctx.own(mat)
    const perM = m / track.length
    const posts: THREE.Mesh[] = []
    for (let k = 0; k < 10; k++) {
      const idx = (iBloom - Math.round((70 - k * 9) * perM) + m) % m
      const smp = track.samples[idx]
      const tl = Math.hypot(smp.tangent.x, smp.tangent.z) || 1
      const ox = smp.tangent.z / tl, oz = -smp.tangent.x / tl
      const half = ctx.corridor(smp.width) + 1.4
      for (const side of [-1, 1]) {
        const x = smp.pos.x + ox * half * side, z = smp.pos.z + oz * half * side
        const mesh = new THREE.Mesh(geo, mat)
        mesh.position.set(x, smp.pos.y + 1.6, z)
        ctx.add(mesh)
        posts.push(mesh)
      }
    }
    // A travelling pulse down the run, so it reads as a WARNING rather than as
    // lighting. Scale only -- the material is shared, so colour cannot be
    // per-post without a second draw call.
    ctx.onUpdate((f: FrameInfo) => {
      for (let i = 0; i < posts.length; i++) {
        const phase = (f.time * 2.2 - i * 0.16) % 3
        const s = phase < 0.5 ? 1 + 0.55 * Math.sin(phase * Math.PI * 2) : 1
        posts[i].scale.set(s, 1, s)
      }
    })
  }

  /* ---- THE CATHEDRAL. Same problem the Lava Tube had and the same answer:
   * a vertical loop with no boost strip through it has nothing lighting its
   * apex, and a headline set piece the player cannot see is not one. A ring of
   * bioluminescent growth concentric with the loop, plus two cold fills inside
   * the bore. Geometry derived from the two tags -- the art layer reads
   * content, it does not import it. ---- */
  //
  // Meridian Deep authors no loop at the moment -- `src/content/tracks/abyssal.ts`
  // says so in as many words and asserts that it emits no `cathedral` pair -- so
  // `loopHoop` returns null and this beat costs nothing. It is written through
  // the shared derivation anyway: this call site used the same
  // `loopR + corridor(width) + K` line as the other three and cleared only
  // because there was no loop left for it to stand in. The day one comes back,
  // it comes back measured.
  const RING_TUBE = 0.9
  const hoop = loopHoop(ctx, 'cathedral', 'cathedral-apex', { tube: RING_TUBE, clear: 2.0 })
  if (hoop) {
    const seg = Math.max(12, Math.round(ctx.seg * 2 * (hoop.sweep / (Math.PI * 2))))
    const ringGeo = new THREE.TorusGeometry(hoop.radius, RING_TUBE, 5, seg, hoop.sweep)
    ringGeo.rotateZ(hoop.from)
    ctx.own(ringGeo)
    const ringMat = new THREE.MeshBasicMaterial({ color: BIOLUME, fog: true })
    ctx.own(ringMat)
    const ringMesh = new THREE.Mesh(ringGeo, ringMat)
    ringMesh.name = 'landmark-cathedral-ring'
    ringMesh.position.set(hoop.cx, hoop.cy, hoop.cz)
    ringMesh.rotation.y = hoop.rotY
    ctx.add(ringMesh)
    if (quality.tier !== 'low') {
      for (const k of [-1, 1]) {
        const L = new THREE.PointLight(0x49d8d0, 1.9, hoop.loopR * 3.2, 1.8)
        L.position.set(
          hoop.cx + hoop.fx * k * hoop.loopR * 0.55, hoop.cy,
          hoop.cz + hoop.fz * k * hoop.loopR * 0.55,
        )
        ctx.add(L)
      }
    }
    ctx.onUpdate((f: FrameInfo) => {
      const g = 0.74 + 0.26 * Math.sin(f.time * 0.55)
      ringMat.color.setHex(BIOLUME).multiplyScalar(g)
    })
  }

  /* ---- WHAT IS ALIVE OUT THERE. See the block above `WHALES`. ---- */
  marineLife(ctx)

  void pal
}

/* ---------------------------------------------------------------- terrain */

const _c = new THREE.Color()

/** The trench floor: basalt, silt where it is flat, and growth in the hollows. */
function terrainColor(out: THREE.Color, p: TerrainPoint, pal: Palette): void {
  out.set(ROCK).lerp(_c.set(ROCK_LIT), p.grit * 0.5)
  // Silt settles on the flats, so it follows the LOW ground rather than noise.
  const flat = Math.max(0, 1 - Math.abs(p.ridge) * 2.2)
  out.lerp(_c.set(SILT), flat * 0.55 * (0.4 + p.macro * 0.6))
  // Bioluminescent growth: rare, in the mid band, and only well off the road,
  // so it never competes with the beacons for the player's attention.
  const gate = Math.max(0, Math.min(1, (p.edge - 12) / 34))
  const glow = Math.max(0, p.mid - 0.74) * 3.4 * gate
  if (glow > 0.01) out.lerp(_c.set(BIOLUME), Math.min(0.55, glow))
  void pal
}

/* ----------------------------------------------------------------- spray */

const SPRAY: SurfaceSprayTable = {
  // Wet steel: a sheet of water rather than grit, and real sparks off the
  // underbody where it grounds out.
  metal: { bulk: 0x6f97a6, glint: 0xc4e6f0, weight: 0.30, grit: 0.22, density: 1.5, gain: 0.58, spark: 0.62, sparkCol: 0xa8e4ff },
  // THE BIOFILM. Heavy, and it comes off in sheets -- this is the visual
  // confirmation that you are on the slick, arriving at the moment the grip
  // does, which is the only cue that is honest about timing.
  oil: { bulk: 0x1d4238, glint: 0x54f0d0, weight: 0.22, grit: 0.30, density: 2.1, gain: 0.72, spark: 0.05, sparkCol: 0x54f0d0 },
  tarmac: { bulk: 0x486574, glint: 0x9fc6d4, weight: 0.42, grit: 0.24, density: 1.1, gain: 0.52, spark: 0.44, sparkCol: 0xa8e4ff },
  gravel: { bulk: 0x4a5a60, glint: 0x8ea6b0, weight: 0.34, grit: 0.20, density: 1.5, gain: 0.56, spark: 0.16, sparkCol: 0x9fd8ee },
  ice: { bulk: 0x4a6a78, glint: 0xc8ecf6, weight: 0.50, grit: 0.38, density: 0.6, gain: 0.46, spark: 0.26, sparkCol: 0xbfe8ff },
  snow: { bulk: 0x5e7680, glint: 0xbcd6e0, weight: 0.24, grit: 0.16, density: 1.3, gain: 0.54, spark: 0.08, sparkCol: 0xbfe8ff },
  boost: { bulk: 0x2a6a70, glint: 0x7cf0e0, weight: 0.34, grit: 0.30, density: 1.2, gain: 0.62, spark: 0.50, sparkCol: 0x9ff6e8 },
}

/* ----------------------------------------------------------------- theme */

export const ABYSSAL_THEME: Theme = {
  id: 'abyssal',

  props(pal, seg): PropSpec[] {
    return [
      {
        name: 'coral-bank', geo: propCoral(pal, seg), count: 150,
        radius: 5.2, gap: 2.6, spread: 78, scale: [0.8, 1.8],
        cluster: { tag: 'bloom', span: 300, share: 0.42 },
      },
      {
        name: 'kelp', geo: propKelp(pal, seg), count: 190,
        radius: 4.0, gap: 3.0, spread: 130, scale: [0.7, 1.9],
      },
      {
        name: 'outcrop', geo: propOutcrop(pal, seg), count: 130,
        radius: 6.4, gap: 3.4, spread: 165, scale: [0.75, 2.0],
      },
      {
        name: 'wreck', geo: propWreck(pal, seg), count: 24,
        radius: 9.0, gap: 6.0, spread: 120, scale: [0.85, 1.5],
        cluster: { tag: 'trench-jump', span: 260, share: 0.55 },
      },
    ]
  },

  landmarks,
  terrainColor,
  terrainMaterial: { roughness: 0.88, metalness: 0.10 },
  // Short. Turbid water is what makes a 30 m animal at 130 m read as a shape
  // rather than as a model kit, and a crisp far distance would undo that. It
  // is also the number the near life layer is staged against: everything in
  // `marineLife` sits inside this band on purpose, because past it the grade
  // onto the fog colour is complete and there is nothing left to see.
  terrainFade: [120, 420],

  /**
   * MARINE SNOW. It falls, slowly, and it is the single cheapest thing that
   * tells the player they are underwater -- more than the colour, which could
   * be night, and more than the fog, which could be smoke. Nothing else in the
   * game has particles that drift DOWN this slowly.
   */
  motes: {
    count: 620, box: 68, size: [0.05, 0.17], pixel: 130, maxPixels: 4,
    alpha: 0.52, fall: 1.1, streak: 0.0,
    color: (_pal, fog) => new THREE.Color(0.78, 0.92, 0.96).lerp(fog, 0.40),
  },

  /** The Breach current, made visible: silt and torn weed going past fast. */
  debris: {
    count: 700, box: 88, length: 8.2, width: 0.30, alpha: 0.30, fall: 0.4,
    color: (_pal, fog) => new THREE.Color(0.44, 0.62, 0.64).lerp(fog, 0.44),
  },

  sky: {
    // Water layers, not cloud: the strata band reads as thermoclines stacked
    // between here and a surface 900m up.
    band: 'strata',
    // The surface itself. Bright, narrow and directly overhead-ish, which is
    // what makes the light feel like it is coming from somewhere reachable.
    horizonColor: 0x2e93b4,
    horizonSpan: [0.30, 0.92],
    horizonGain: 0.70,
    celestial: {
      bodies: [{
        // The sun through 900m of water: a soft, cold, badly-defined disc. A
        // hard terminator would make it a moon, so `shade` is near zero and the
        // limb does the work.
        dir: [0.14, 0.96, 0.24],
        sizeDeg: 9,
        color: 0x9fd8ee,
        shade: 0.05,
        limb: 0.55,
        mottle: 0.38,
      }],
      ships: {
        // THE FAR LEVIATHANS. `ships` is silhouettes with running lights, which
        // is what a large bioluminescent animal at range actually looks like.
        // Three of them, holding station off to one side, drifting slowly
        // enough that you are never sure they moved.
        //
        // KEPT, now that there are modelled animals near the road, because it
        // is a different band and a different surface: this draws on the dome,
        // in front of the fog, at 13 degrees of size and 20 of elevation --
        // three things a long way up the water column that can never be
        // approached. `marineLife` is the near field, inside the fog, going
        // past. Deleting this to add that would trade a free background for
        // nothing, and the two never occupy the same part of the frame.
        dir: [-0.72, 0.34, 0.60],
        spreadDeg: 26,
        sizeDeg: 13,
        color: 0x071820,
        lightColor: 0x54f0d0,
        lightGain: 0.85,
        count: 3,
        driftDeg: 0.16,
      },
      gain: 0.78,
    },
  },

  /** Murk lying in the trench. Dense and close: this is water, not air. */
  fogBanks: {
    count: 10, size: 96, alpha: 0.062, low: -14, high: 22,
    color: (_pal, fog) => fog.clone().lerp(new THREE.Color(0.16, 0.40, 0.48), 0.42),
  },

  /**
   * The Breach. `windFull` is 15 to match the peak the track authors -- the cue
   * has to arrive and leave exactly where the force does. Silt closes the water
   * down hard; the tube's own lights are what survives it, which is why the
   * beacons are the readability plan and the ambient is not.
   */
  weather: {
    windFull: 15.0,
    fogColor: 0x0b3240,
    fogDensity: 0.0165,
    sunScale: 0.42,
    moteGain: 2.3,
  },

  road: 'industrial',
  propMaterial: { roughness: 0.84, metalness: 0.14 },
  spray: SPRAY,
}
