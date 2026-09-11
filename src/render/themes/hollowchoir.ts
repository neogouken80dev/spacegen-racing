/**
 * THE HOLLOW CHOIR — derelict megastructure.
 *
 * GDD hook: "rotating gravity + vacuum section". The design behind that line is
 * in `claude/spacegen-racing-hollow-choir.md`; this file is the art pass, and
 * it has two jobs that are not decoration and one that is.
 *
 * ---------------------------------------------------------------------------
 * THE THREE MOTIFS. Every piece of geometry in this file is one of them.
 *
 *   1  THE PIPE. The name is the brief: a structure that looks as though it
 *      should be making a sound you cannot hear. Every mass on this planet
 *      that is not a frame is a CLUSTER OF CAPPED TUBES of different heights
 *      with a dark slot at the foot — a pipe organ, at every scale from a 9 m
 *      scattered stack to the 46 m masses flanking the drum's mouths. Read at
 *      distance it is a silhouette of parallel verticals of uneven height,
 *      which is a thing no other planet in this game has and which the eye
 *      reads as "made, tuned, and abandoned".
 *
 *   2  THE RIB. Everything structural is a naked frame: transverse rings and
 *      longitudinal ribs, with plate ON them rather than instead of them. That
 *      is what makes the Breach possible as an image — strip the plate off a
 *      ribbed hull and what is left is a ribcage with stars behind it, and the
 *      hull does not have to be re-modelled to be torn, it just loses its skin.
 *
 *   3  THE FAILING LAMP. `palette.accent` is amber and it is the ONLY warm
 *      colour on the planet. It appears exclusively as emergency lighting, it
 *      is always in a line (a strip, a helix, a ring of lamps), and a fixed
 *      share of every line is dead. Nothing here is lit for the player's
 *      benefit and nothing has been maintained.
 * ---------------------------------------------------------------------------
 *
 * THE TWO JOBS THAT ARE NOT DECORATION.
 *
 * A. SELL THE ROTATION. The player spends 863 m inside a 140 m bore, passing
 *    through fully inverted, and the horizon stops meaning anything the moment
 *    the road leaves the floor. Three cues, deliberately of three different
 *    kinds, because a still frame and a moving one need different things:
 *
 *      - THE HULL TURNS AND THE ROAD DOES NOT. This is canon, not licence: the
 *        track's own spin drag exists because "the drum is a rotating habitat
 *        and its air turns with the hull while the road does not". So the bore
 *        rotates about its axis at SPIN_RATE and the road is a fixed ribbon
 *        threaded through it. It costs ONE draw call — every vertex of the
 *        hull carries the pivot and axis it turns about and the vertex shader
 *        does a Rodrigues rotation, which is Aetherion's floating-keystone
 *        trick pointed at a single rigid body. This is the cue that works in
 *        motion and it is unambiguous: nothing else in the game moves like it.
 *      - TWO AMBER HELICES wind the full length of the bore at a pitch that is
 *        not the road's, so they cross the road visibly and at a slant. This
 *        is the cue that works in a STILL frame — a helix on a cylinder states
 *        a handedness and gives the eye a fix on where it is around the
 *        circumference. It is Aetherion's two teal helices, moved to a planet
 *        that needs them harder.
 *      - THE MOUTH RINGS DO NOT TURN. Relative motion is what makes rotation
 *        legible, so both drum mouths carry a heavy static bulkhead ring that
 *        the moving hull runs past. At the Nave you watch the drum start
 *        turning; at the Transept you watch it stop.
 *
 * B. MAKE THE VACUUM LEGIBLE. `TrackNode.vacuum` is a property of the road, so
 *    the art reads THE SAME NUMBER rather than a second authoring of where the
 *    air is — `vacAtZ()` below is built from `track.samples`, exactly as
 *    Aetherion's light-bridges evaluate the sim's own `bridgeSolid` predicate.
 *    Four things happen together across that boundary, on four different
 *    channels, so no single failure loses it:
 *
 *      1  THE PLATE IS GONE. Hull plating survives with probability
 *         `1 - vacuum(z)`, so the skin thins out through exactly the metres
 *         where the grip does and is completely absent through the metres where
 *         there is no air at all. What is left is the ribcage.
 *      2  THE LIGHT GOES COLD. Every amber line on the drum — both helices and
 *         every lamp ring — is gained by `1 - vacuum(z)`. The warm light dies
 *         at the boundary and the only light in the Breach is the raw star
 *         through the hull. Colour temperature is the fastest read there is.
 *      3  TWO LIT RINGS. The last frame before the tear at each end is a
 *         PRESSURE FRAME, twice the section of the others and carrying the last
 *         complete ring of working lamps. From the Ascent you see the lit bore
 *         end in a bright ring with the ribcage behind it, 200 m before you get
 *         there. That is the telegraph, and it is the same amount of warning
 *         Aetherion's phasing spans get.
 *      4  THE AIR GOES. `wind` on this track is authored to zero through the
 *         Breach and 24 across the sealed bays, so the WeatherStyle below —
 *         which is driven by wind and nothing else — puts haze, drifting dust
 *         and a denser fog exactly where there is air to hold them, and takes
 *         all three away in the Breach. The section with no atmosphere is the
 *         section rendered without one.
 *
 * THE VALUE PROBLEM. GDD 09 wants environments in the mid-to-dark band. A
 * derelict walks into the opposite trap from Cryostatic's snow: dark cars lost
 * in a dark hull. So the hull mass sits at 0.40-0.45 sRGB — well under the
 * palest chassis at 0.88 and well OVER the fog, which the track def authors at
 * 0x39424e on purpose so structure reads as silhouette against haze. Nothing in
 * this file is painted above `palette.a` except a raked top face and the amber,
 * and the amber is never a surface, only a line.
 *
 * Beats and what each one gets:
 *   Keel        430 m of plated gallery: transverse ribs every 30 m, wall
 *               panels between them, and a failing amber strip along both walls
 *   Antechoir   the debris field — shed regolith drifts and buried plate,
 *               thinning as the road turns into the near mouth
 *   Nave        the near mouth: a static bulkhead ring with the road cut
 *               through its floor, flanked by two 46 m organ masses
 *   Ascent      the lit bore: 17 longitudinal ribs, plated bays, pressure
 *               frames every 58 m, two amber helices, and the tear ahead
 *   the Breach  209 m of hull missing. Bare ribcage, no plate, no amber, stars
 *   Fall        the tear closing again, and the amber coming back
 *   Transept    the far mouth, its static ring, and two more organ masses
 *   Gantry      four heavy portal frames over the corner, with trolley beams
 *   Ribs        the open gallery: the same rib rhythm with the plate stripped,
 *               so the draught has something to run through
 *   Spine       a vertebral row of ribs stood along the outside of the corner
 *   Carousel    the collapsed cargo dock: a 78 m broken spindle at the exact
 *               centre of the 360, so the longest corner in the game is an
 *               orbit around a landmark rather than 669 m of nothing
 */
import * as THREE from 'three'
import type { Track, TrackSample } from '../../sim/track'
import {
  bindSurfaceSpray, merge, mulberry32, part, xf,
  type FrameInfo, type PropSpec, type SurfaceSprayTable,
  type TerrainPoint, type Theme, type ThemeContext,
} from './kit'

/* ------------------------------------------------------------- the values */
//
// Authored in sRGB and measured against the mid-to-dark rule. HULL is the mass
// of the wreck; HULL_LIT is `palette.a` and is only ever a face the cold key
// actually rakes. AMBER never appears on a lit surface at all — it is emissive
// linework and nothing else.

/** The body of every plate, wall and mass: oxidised grey-green steel. 0.40. */
const HULL = 0x5d6a68
/** A raked top face or chamfer. `palette.a`, and the palest FACE on the wreck. */
const HULL_LIT = 0x8f9a96
/** Plate in shade, and the inboard face of anything overhead. 0.25. */
const HULL_DARK = 0x36423f
/** Bare structural alloy: ribs, frames, gantries. Cooler than the plate. */
const ALLOY = 0x6d7a84
/** Alloy catching the key on an edge. Under `palette.b` (0xb9c2c8) on purpose. */
const ALLOY_HI = 0x99a5ad
/** The inside of anything: open bays, pipe mouths, the soffit of a frame. */
const VOID = 0x10161b
/** Two centuries of shed hull dust, drifted into every lee on the circuit. */
const REGOLITH = 0x6b6357
const REGOLITH_D = 0x413c34
/** Corrosion bleeding out of a seam. The only other warm note, and it is dull. */
const BLOOM = 0x6d5138
/** A dead lamp housing. What the amber looks like when it has failed. */
const LAMP_DEAD = 0x4a3d2c
/** Structure inside the tear. Paler than the rest, and it has to be: the
 *  only light out there is the sky, so a rib in the Breach reads as a
 *  silhouette or it does not read at all. */
const RIB_BARE = 0xa4b1bb

/**
 * HOW MUCH BRIGHTER THAN THE BLOOM THRESHOLD A WORKING LAMP IS.
 *
 * `postfx.ts` thresholds bloom at 0.78 of linear luminance. Amber (0xffa63a)
 * is 0.49 linear, so at gain 1.0 a lamp is a coloured rectangle and nothing
 * else; at 1.9 it is a light with a halo. Held there rather than higher
 * because there are several hundred of them and the drum is meant to be dim:
 * Cryostatic's cavern is the cautionary tale, where 2.6 fused every vein into
 * one sheet and the rock stopped reading as black.
 */
const LAMP_GAIN = 1.9
/** A lamp that is still lit but is going. Under the threshold: no halo. */
const LAMP_LOW = 0.62

/* ----------------------------------------------------------- drift spray */

/**
 * What the Hollow Choir throws at you when you slide on it.
 *
 * The whole table is the difference between the wreck's own metal and what has
 * settled on it. `metal` is the drum's deck: there is nothing loose on it, so
 * it throws almost no bulk and strikes a hard blue-white spark off bare plate.
 * `gravel` is the Antechoir's regolith — shed hull dust, two centuries of it,
 * banked into the lee of the near mouth — and it is the heaviest, densest,
 * warmest spray in the file with the strike almost gone, because a grounded
 * chassis in that stuff is not touching the wreck at all. That contrast is the
 * Antechoir's whole read and it is the same argument the track makes for
 * putting the only low-grip surface in the game's only debris field.
 */
const SPRAY: SurfaceSprayTable = {
  // The superstructure galleries: swept deck plate over structure.
  tarmac: {
    bulk: 0x6a7370, glint: 0xc8d6de, weight: 0.44, grit: 0.30,
    density: 0.70, gain: 0.44, spark: 0.66, sparkCol: 0xd8ecff,
  },
  // THE ANTECHOIR. Shed regolith: enormous, slow, warm, and it kills the
  // strike because there is no plate within reach of the contact patch.
  gravel: {
    bulk: 0x6f6553, glint: 0xbda877, weight: 0.70, grit: 0.42,
    density: 1.50, gain: 0.50, spark: 0.08, sparkCol: 0xffc27a,
  },
  // THE DRUM. Bare hull plate, scoured clean by two hundred years of a
  // circumferential draught: nothing to lift, and a hard cold strike.
  metal: {
    bulk: 0x5f6a70, glint: 0xe6f4ff, weight: 0.52, grit: 0.36,
    density: 0.36, gain: 0.38, spark: 0.98, sparkCol: 0xeaf6ff,
  },
  // Boost plate: deck grit lit by the only warm emissive on the planet.
  boost: {
    bulk: 0x6a7370, glint: 0xffc98a, weight: 0.36, grit: 0.30,
    density: 0.72, gain: 0.46, spark: 0.58, sparkCol: 0xffa63a,
  },
  // The three below are unauthored on this circuit. They exist so a future
  // flood, freeze or spill pass is a track edit rather than a code change, and
  // they are tinted to THIS wreck rather than copied off another planet.
  oil: {
    bulk: 0x191d22, glint: 0x6f8ba0, weight: 0.58, grit: 0.22,
    density: 0.86, gain: 0.24, spark: 0.05, sparkCol: 0xffa63a,
  },
  ice: {
    bulk: 0x8ea3ad, glint: 0xdcecf4, weight: 0.60, grit: 0.52,
    density: 0.70, gain: 0.40, spark: 0.14, sparkCol: 0xcfe8f0,
  },
  snow: {
    bulk: 0xa8b2b4, glint: 0xe4ecee, weight: 0.16, grit: 0.20,
    density: 1.25, gain: 0.44, spark: 0.00, sparkCol: 0xe4ecee,
  },
}

/* ---------------------------------------------------------------- the pipe */

/**
 * MOTIF 1 — a cluster of capped tubes: the planet in one object.
 *
 * `n` tubes on a rough line, each a different height and bore, each capped
 * with a chamfered head and each with a dark slot at the foot. The slot is the
 * whole trick and it costs two triangles: an organ pipe is a tube with a mouth
 * cut in it, and without the mouth this is a bundle of pipework. With it, a
 * silhouette of uneven parallel verticals reads as an instrument.
 *
 * Cylinders rather than boxes, at `seg` around, because the planet's other two
 * motifs are both rectilinear and a wreck built entirely of boxes reads as a
 * greybox. `seg` is 4 on the low tier, which is a square tube, which is fine:
 * what carries this prop is the RHYTHM of the heights, not the section.
 */
function pipeCluster(
  seed: number, n: number, seg: number,
  rBase: number, hBase: number, spread: number,
): THREE.BufferGeometry {
  const rnd = mulberry32(seed)
  const parts: THREE.BufferGeometry[] = []
  // A plinth, so the cluster stands on something rather than growing out of
  // the dirt, and so the sink in the scatter has something to bury.
  parts.push(part(
    new THREE.BoxGeometry(spread * 2.3, hBase * 0.10, spread * 1.5), HULL_DARK,
    xf(0, hBase * 0.05, 0, rnd() * 0.4),
  ))
  for (let i = 0; i < n; i++) {
    const t = (i / Math.max(1, n - 1)) * 2 - 1
    // Heights on a shallow arch with a random break, so a row of them is a
    // chord and not a ramp. Ranked pipes are what an organ looks like.
    const h = hBase * (0.42 + 0.58 * Math.sqrt(1 - t * t * 0.86)) * (0.78 + rnd() * 0.44)
    const r = rBase * (0.62 + rnd() * 0.62)
    const x = t * spread + (rnd() - 0.5) * rBase * 0.9
    const z = (rnd() - 0.5) * spread * 0.5
    parts.push(part(
      new THREE.CylinderGeometry(r * 0.94, r, h, seg, 1, true),
      i % 3 === 0 ? ALLOY : HULL,
      xf(x, hBase * 0.09 + h / 2, z, rnd() * 0.8),
    ))
    // The cap: a shallow chamfered head, the one face the key light rakes.
    // Open-ended, like the shaft — the underside is never seen and the top is
    // closed by the next ring in, so two rings of caps would be `seg * 2`
    // triangles a pipe spent on nothing. At six pipes and a hundred instances
    // that is eight thousand triangles of invisible lids.
    parts.push(part(
      new THREE.CylinderGeometry(r * 0.42, r * 1.12, r * 0.9, seg, 1, true),
      HULL_LIT,
      xf(x, hBase * 0.09 + h + r * 0.34, z, rnd() * 0.8),
    ))
    // THE MOUTH. A dark slot at the foot, and the whole reason a bundle of
    // tubes reads as an instrument. Two triangles, facing out.
    parts.push(part(
      new THREE.PlaneGeometry(r * 1.25, h * 0.15), VOID,
      xf(x, hBase * 0.09 + h * 0.17, z + r * 0.99),
    ))
  }
  return merge(parts)
}

/* ------------------------------------------------------------- hero props */

/** Prop 1 — the choir stack. Also stood at landmark scale; see `pipeStands`. */
function propChoirStack(seg: number): THREE.BufferGeometry {
  return pipeCluster(0xc4013, 6, seg <= 4 ? 4 : 6, 0.62, 9.5, 2.6)
}

/**
 * Prop 2 — a bare structural rib. MOTIF 2 at scatter scale.
 *
 * Half a frame, snapped: a leg, a haunch and a stub of crown reaching for a
 * partner that is not there. Stood in rows along the Spine and the Gantry by
 * `ribStands`, where the repetition turns a scattered prop into a colonnade.
 */
function propRib(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  // Foot and leg.
  parts.push(part(new THREE.BoxGeometry(3.4, 1.1, 2.8), HULL_DARK, xf(0, 0.55, 0)))
  parts.push(part(new THREE.BoxGeometry(1.5, 11.0, 1.9), ALLOY, xf(0, 6.2, 0)))
  // Web plates between the leg and the haunch: a rib is an I, not a stick.
  for (let i = 0; i < 2; i++) {
    parts.push(part(new THREE.BoxGeometry(2.7, 0.30, 1.5), ALLOY_HI, xf(0, 3.4 + i * 4.4, 0)))
  }
  // The haunch, curving over, and the snapped crown.
  const steps = 3
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * 1.05
    const r = 7.4
    parts.push(part(
      new THREE.BoxGeometry(1.4, 3.2, 1.8), i === steps - 1 ? ALLOY_HI : ALLOY,
      xf(Math.sin(a) * r, 11.4 + (1 - Math.cos(a)) * r * 0.72, 0, 0, 0, -a),
    ))
  }
  return merge(parts)
}

/**
 * Prop 3 — a torn hull plate, buckled and half standing.
 *
 * The plate that came off the ribs. Wide, thin, leaning, and read almost
 * entirely as silhouette: this is the prop that gives the debris field its
 * horizontal grain and it is deliberately the cheapest thing in the file.
 */
function propPlate(): THREE.BufferGeometry {
  const rnd = mulberry32(0x91a7e)
  const parts: THREE.BufferGeometry[] = []
  let x = -4.4, y = 0
  for (let i = 0; i < 4; i++) {
    const w = 3.0 + rnd() * 2.6
    const h = 2.4 + rnd() * 4.2
    // Each panel kinks a little further over than the last: sheet that has
    // folded rather than sheet that has been stacked.
    const tilt = -0.10 - i * 0.13 - rnd() * 0.10
    parts.push(part(
      new THREE.BoxGeometry(w, h, 0.36), i === 3 ? HULL_LIT : i === 1 ? BLOOM : HULL,
      xf(x + w / 2, y + h / 2 * Math.cos(tilt), (rnd() - 0.5) * 1.6, rnd() * 0.5, tilt),
    ))
    // A stiffener on the back of the odd panels, so the plate has a
    // direction. On every panel it is 48 triangles of edge-on rib nobody sees.
    if (i % 2 === 1) {
      parts.push(part(
        new THREE.BoxGeometry(0.30, h * 0.9, 0.9), HULL_DARK,
        xf(x + w / 2, y + h / 2, -0.5, 0, tilt),
      ))
    }
    x += w * 0.86
    y += rnd() * 0.5
  }
  return merge(parts)
}

/**
 * Prop 4 — collapsed truss. Low, wide, tangled: the pile a frame makes when it
 * comes down. Fills the middle distance, which on a wreck is otherwise a
 * choice between "empty" and "another vertical".
 */
function propTruss(): THREE.BufferGeometry {
  const rnd = mulberry32(0x7a05)
  const parts: THREE.BufferGeometry[] = []
  for (let i = 0; i < 6; i++) {
    const len = 5.5 + rnd() * 7.0
    parts.push(part(
      new THREE.BoxGeometry(len, 0.72, 0.72), i % 3 === 0 ? ALLOY_HI : ALLOY,
      xf((rnd() - 0.5) * 5.5, 0.5 + rnd() * 2.6, (rnd() - 0.5) * 4.5,
        rnd() * Math.PI, (rnd() - 0.5) * 0.6, (rnd() - 0.5) * 0.9),
    ))
  }
  // Two node blocks: where the chords were bolted together before it failed.
  for (let i = 0; i < 2; i++) {
    parts.push(part(new THREE.BoxGeometry(1.8, 1.5, 1.8), HULL_DARK,
      xf((rnd() - 0.5) * 4, 0.9 + rnd() * 1.4, (rnd() - 0.5) * 4, rnd() * 2)))
  }
  return merge(parts)
}

/**
 * Prop 5 — a regolith drift with plate buried in it.
 *
 * Two centuries of shed hull dust. Low, soft-shouldered and almost featureless
 * except for the corner of something under it, which is what stops a drift
 * reading as a rock: on a wreck, everything the dust covers is manufactured.
 */
function propDrift(): THREE.BufferGeometry {
  const rnd = mulberry32(0x2e601)
  const parts: THREE.BufferGeometry[] = []
  for (let i = 0; i < 3; i++) {
    const s = 4.2 - i * 0.9
    parts.push(part(
      new THREE.IcosahedronGeometry(s, 0), i === 0 ? REGOLITH_D : REGOLITH,
      xf((rnd() - 0.5) * 3.2, s * 0.34, (rnd() - 0.5) * 3.2,
        rnd() * 3.1, 0, 0, 1.5, 0.44, 1.25),
    ))
  }
  // The corner of a panel coming out of the drift, and a stub of pipe.
  parts.push(part(new THREE.BoxGeometry(4.6, 2.6, 0.34), HULL,
    xf(1.2, 1.0, -1.0, 0.7, 0, -0.42)))
  parts.push(part(new THREE.BoxGeometry(0.9, 3.4, 0.9), ALLOY,
    xf(-2.0, 0.9, 1.4, 0.4, 0, 1.15)))
  return merge(parts)
}

/**
 * Prop 6 — a mast. The tall, thin vertical the skyline needs, and the only
 * scattered prop with a lamp head on it.
 *
 * The head is `ALLOY_HI` and NOT emissive: an InstancedMesh shares one lit
 * material with every other prop on the planet, so a glowing head here would
 * mean a seventh draw call for six hundred lamps nobody is looking at. The
 * warm points of light in the distance are hand-placed on the glow mesh
 * instead, where they can be aimed at the beats that need them.
 */
function propMast(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  parts.push(part(new THREE.BoxGeometry(3.2, 1.0, 3.2), HULL_DARK, xf(0, 0.5, 0)))
  parts.push(part(new THREE.BoxGeometry(0.9, 17.5, 0.9), ALLOY, xf(0, 9.0, 0, 0.6)))
  // Three guy struts, which is what makes a stick read as a mast.
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2
    parts.push(part(new THREE.BoxGeometry(0.26, 6.4, 0.26), ALLOY,
      xf(Math.sin(a) * 1.5, 3.1, Math.cos(a) * 1.5, a, 0, -0.44)))
  }
  parts.push(part(new THREE.BoxGeometry(1.9, 0.9, 1.9), ALLOY_HI, xf(0, 18.1, 0, 0.6)))
  parts.push(part(new THREE.BoxGeometry(0.9, 1.5, 0.9), LAMP_DEAD, xf(0, 19.1, 0, 0.6)))
  return merge(parts)
}

/* --------------------------------------------------- the rotating hull shader */

/**
 * THE DRUM TURNS, IN ONE DRAW CALL.
 *
 * Every vertex of the hull carries the axis point it turns about and the axis
 * direction; the vertex shader does a Rodrigues rotation before anything else
 * touches the position. That is Aetherion's floating-keystone trick applied to
 * a single rigid body of eleven thousand triangles, and the reason to use it
 * here rather than simply putting the hull on a rotating Object3D is the
 * shadow of the alternative: a rotating parent means a live matrix update, a
 * bounding sphere that has to be recomputed or disabled, and an object the
 * environment's `matrixAutoUpdate = false` contract does not cover. A pure
 * vertex transform has none of those and the mesh stays immutable.
 *
 * Injected into a MeshStandardMaterial rather than written as a ShaderMaterial
 * so the hull still takes the light rig, the fog and the tone mapping for
 * free. Flat-shaded on purpose as well as for looks: three derives a flat
 * normal from the DEFORMED position in the fragment shader, so nothing here
 * has to rotate a normal.
 */
const SPIN_PARS = /* glsl */`
attribute vec3 aPivot;
attribute vec3 aAxis;
attribute float aRate;
uniform float uTime;
`
const SPIN_BODY = /* glsl */`
vec3 _rel = position - aPivot;
float _a = uTime * aRate;
float _c = cos(_a), _s = sin(_a);
_rel = _rel * _c + cross(aAxis, _rel) * _s + aAxis * dot(aAxis, _rel) * (1.0 - _c);
vec3 transformed = _rel + aPivot;
`

/**
 * HOW FAST, AND WHY NOT 1 g.
 *
 * A 70 m drum at one gravity turns at 0.374 rad/s, which puts the wall past
 * you at 26 m/s — half racing speed, across your entire field of view, while
 * you are also corkscrewing. That is not a rotation cue, it is a reason to
 * stop playing. This wreck has been spinning down for two hundred years and
 * turns at a quarter of a revolution a minute: a rib passes a fixed point
 * every 2.9 s, the wall drifts at 7.6 m/s, and the read is unmistakable in
 * peripheral vision without ever being the loudest thing in the frame.
 */
const SPIN_RATE = 0.09

/** Accumulator for the rotating mesh. */
interface SpinBuf {
  parts: THREE.BufferGeometry[]
  pivot: number[]; axis: number[]; rate: number[]
}
function spinBuffer(): SpinBuf { return { parts: [], pivot: [], axis: [], rate: [] } }

function addSpin(
  buf: SpinBuf, geo: THREE.BufferGeometry,
  p: [number, number, number], axis: [number, number, number], rate: number,
): void {
  const al = Math.hypot(axis[0], axis[1], axis[2]) || 1
  const n = geo.getAttribute('position').count
  for (let i = 0; i < n; i++) {
    buf.pivot.push(p[0], p[1], p[2])
    buf.axis.push(axis[0] / al, axis[1] / al, axis[2] / al)
    buf.rate.push(rate)
  }
  buf.parts.push(geo)
}

/* ------------------------------------------------------------- the glow mesh */

/**
 * EVERY WORKING LAMP ON THE PLANET, AS UNLIT GEOMETRY.
 *
 * Strips, helices and lamp rings are all quads on one of two meshes — one
 * static, one riding the rotating hull — drawn with a MeshBasicMaterial so
 * they are their own light and take no shading. The colour is written per
 * vertex ALREADY GAINED, because `part()` writes a colour through
 * `Color.setHex` and that clamps at 1.0, which would put every lamp on this
 * planet exactly at the bloom threshold and none of them over it.
 */
interface GlowBuf { p: number[]; c: number[]; i: number[] }
function glowBuffer(): GlowBuf { return { p: [], c: [], i: [] } }

const _glowCol = new THREE.Color()

/** One quad, wound a-b-c-d, at an explicit emissive level. */
function glowQuad(
  buf: GlowBuf,
  a: [number, number, number], b: [number, number, number],
  c: [number, number, number], d: [number, number, number],
  hex: number, gain: number,
): void {
  const base = buf.p.length / 3
  _glowCol.setHex(hex)
  for (const v of [a, b, c, d]) {
    buf.p.push(v[0], v[1], v[2])
    buf.c.push(_glowCol.r * gain, _glowCol.g * gain, _glowCol.b * gain)
  }
  buf.i.push(base, base + 1, base + 2, base, base + 2, base + 3)
  // Double-sided by winding rather than by material state: a lamp ring inside
  // a drum is seen from both sides of the drum, and `side: DoubleSide` on an
  // unlit material costs the same fragments plus a pipeline state change.
  buf.i.push(base, base + 2, base + 1, base, base + 3, base + 2)
}

function glowGeometry(buf: GlowBuf): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  const n = buf.p.length / 3
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf.p), 3))
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(buf.c), 3))
  g.setIndex(n > 65535
    ? new THREE.BufferAttribute(new Uint32Array(buf.i), 1)
    : new THREE.BufferAttribute(new Uint16Array(buf.i), 1))
  g.computeVertexNormals()
  g.computeBoundingSphere()
  return g
}

/* ------------------------------------------------------------ the drum fit */

/**
 * WHERE THE DRUM IS, MEASURED OFF THE RIBBON RATHER THAN COPIED FROM IT.
 *
 * The track file states the bore as `DRUM_R = 70` about an axis at
 * `(0, DRUM_YA)` along +Z. Writing those two numbers here again is exactly the
 * bug the environment's own header warns about — "a lateral is a function of
 * `sample.width` or it is a bug" — one radius edit away from a hull that
 * intersects the road it is meant to be behind. So the cylinder is FITTED.
 *
 * On the drum the sample normal is the inward radial, so `pos + normal * R` is
 * the axis point for every sample at the true radius. That is linear in the
 * three unknowns (R, cx, cy):
 *
 *     pos.x + normal.x * R - cx = 0
 *     pos.y + normal.y * R - cy = 0
 *
 * which is a 3x3 normal equation over every drum sample and is exact for a
 * cylinder. Which samples are on the drum is not guessed either: the track
 * authors `metal` on the drum and nowhere else, which is a statement about the
 * road rather than about its shape and cannot drift when a radius moves.
 */
interface DrumFit {
  r: number; cx: number; cy: number
  z0: number; z1: number
  /** vacuum against z, sorted, for `vacAtZ`. */
  zs: Float64Array; vac: Float64Array
}

function fitDrum(track: Track): DrumFit | null {
  const on: TrackSample[] = []
  for (const s of track.samples) if (s.surface === 'metal') on.push(s)
  if (on.length < 40) return null

  // Least squares over the three unknowns. The two `c` rows are trivially
  // solvable for `c` given `R`, which reduces the whole thing to one division
  // -- no elimination, and no chance of a transcription error in a 3x3 that
  // would put the drum's axis somewhere plausible but wrong.
  //
  //     A*R - Sx*cx - Sy*cy = -Q        (d/dR)
  //    -Sx*R + N*cx         =  Px       (d/dcx)
  //    -Sy*R        + N*cy  =  Py       (d/dcy)
  let A = 0, Sx = 0, Sy = 0, Px = 0, Py = 0, Q = 0
  for (const s of on) {
    const nx = s.normal.x, ny = s.normal.y
    A += nx * nx + ny * ny
    Sx += nx; Sy += ny
    Px += s.pos.x; Py += s.pos.y
    Q += nx * s.pos.x + ny * s.pos.y
  }
  const N = on.length
  const den = A - (Sx * Sx + Sy * Sy) / N
  if (Math.abs(den) < 1e-9) return null
  const r = ((Sx * Px + Sy * Py) / N - Q) / den
  const cx = (Px + Sx * r) / N
  const cy = (Py + Sy * r) / N
  if (!(r > 20 && r < 400)) return null

  let z0 = Infinity, z1 = -Infinity
  for (const s of on) { if (s.pos.z < z0) z0 = s.pos.z; if (s.pos.z > z1) z1 = s.pos.z }

  const sorted = on.slice().sort((p, q) => p.pos.z - q.pos.z)
  const zs = new Float64Array(sorted.length)
  const vac = new Float64Array(sorted.length)
  for (let i = 0; i < sorted.length; i++) { zs[i] = sorted[i].pos.z; vac[i] = sorted[i].vacuum }
  return { r, cx, cy, z0, z1, zs, vac }
}

/**
 * The authored vacuum at a station down the drum's axis.
 *
 * THIS IS THE ONE NUMBER THE WHOLE BREACH IS BUILT ON, and it is read off the
 * ribbon rather than re-authored: the hull's plating, both helices and every
 * lamp on the drum are gained by `1 - vacAtZ(z)`, so the skin thins, the light
 * dies and the air goes over exactly the metres where the grip does. Move the
 * envelope in `hollowchoir.ts` and the tear moves with it, with no edit here.
 *
 * The road's z is monotonic through the drum (the Breach still advances 39 m
 * down the bore while it wraps 186 degrees, which is the whole reason PSI_MAX
 * is 80 and not 90), so a sorted scan is a valid parameterisation and the
 * vacuum is single-valued in z.
 */
function vacAtZ(fit: DrumFit, z: number): number {
  const { zs, vac } = fit
  const n = zs.length
  if (z <= zs[0]) return vac[0]
  if (z >= zs[n - 1]) return vac[n - 1]
  let lo = 0, hi = n - 1
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    if (zs[mid] <= z) lo = mid; else hi = mid
  }
  const t = (z - zs[lo]) / Math.max(1e-6, zs[hi] - zs[lo])
  return vac[lo] + (vac[hi] - vac[lo]) * t
}

/* --------------------------------------------------------- the drum shell */

/**
 * WHERE THE HULL SITS RELATIVE TO THE ROAD, AND WHY NOTHING CAN REACH IT.
 *
 * The road is a straight chord tangent to the bore: `right` has no radial
 * component (it is `tangent x up` and `up` is the radial), so a point at
 * lateral `lat` sits at radius `sqrt(R^2 + (lat*cos psi)^2)` — at most 73.5 m
 * on this circuit, counting the forgiving edge and a racer's own half-width.
 * EVERY radius below is measured out from the fitted `R`, and the smallest of
 * them is `R + 10`, so the entire hull is outside the road's swept surface —
 * that is, BELOW it, because down on a spin-gravity drum is outward — at every
 * sample, by construction rather than by a clearance test.
 *
 * That is the same guarantee Aetherion's rotunda relies on, and for the same
 * reason: the ribbon fixture's `reach()` measures lateral in the banked frame
 * as `alongLat / |right_xz|`, which needs the plan projection of the frame to
 * be non-degenerate, and on a vertical wall the plan tangent and the plan
 * right are parallel. The fixture skips those samples. Construction does not.
 */
//
// The clearance is MEASURED, not assumed: the worst point on this circuit is
// 79.3 m from the fitted axis (both drum mouths, where the road is still
// settling onto the bore and the baked frame's `right` has picked up a radial
// component the ideal helix does not have), against 73.8 m anywhere in the
// bore proper. The innermost thing below sits at R + 14 = 84.1, so the tightest
// clearance on the planet is 4.8 m of air under a mouth and 10.3 m under the
// bore. Every one of these is an offset from the FITTED radius; none of them is
// a number of metres.
const R_HELIX = 14      // + R: the two spin lines, inboard of everything
const R_RIB_IN = 16     // + R: inner face of a longitudinal rib
const R_RIB_OUT = 22    // + R
const R_PLATE = 23.5    // + R: the skin, behind the ribs
const R_FRAME_IN = 25   // + R: transverse pressure frames
const R_FRAME_OUT = 38  // + R

/**
 * THE BORE IS A COMPLETE CYLINDER, AND THE DRIFT IS WHAT HIDES ITS FLOOR.
 *
 * The first cut of this file stopped the hull 58 degrees off the floor on the
 * argument that two centuries of shed dust have filled the bottom of the bore.
 * That is true, and it is also what the terrain shell already does: the ground
 * field sits at about y = 27 through the drum's plan footprint and the hull's
 * own floor is at y = 100 - (R + 16) = 14, so the bottom fourteen metres of the
 * cylinder are UNDER the terrain and were never drawn either way. What the cut
 * actually bought was a 26 m band of nothing between the drift and the hull's
 * lower edge -- daylight, in the one beat whose whole point is that you are
 * inside a sealed volume. So the cylinder is complete, the terrain buries it,
 * and it emerges from the drift at about |x| = 47 m exactly as a buried
 * cylinder should.
 *
 * The cost of that is real and is worth writing down: the prop scatter is a
 * PLAN-space clearance test, so a prop can stand in the bore where the hull is
 * only a few metres above the drift (|x| between 47 and 60 m), and a tall one
 * there will push through the hull's lower wall. It is a narrow band, most of
 * it is rejected by `clearOfTrack` anyway, and the failure mode is a piece of
 * wreckage sticking out of the drum's floor, which on a two-hundred-year-old
 * derelict nobody will read as a bug.
 */

/** Longitudinal ribs around the bore. 24 is 15 degrees apart. */
const N_RIB = 24

/**
 * Turn a hash into a coin. Deliberately a local integer hash rather than a
 * mulberry32 stream: the plate and rib decisions are indexed by (rib, bay)
 * rather than drawn in order, so a stream would make the tear's pattern depend
 * on the iteration order of two nested loops.
 */
function hash2(a: number, b: number, salt: number): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(salt, 2246822519)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177) | 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** World position on the bore at radius `r`, angle `phi`, station `z`. */
function bore(fit: DrumFit, r: number, phi: number, z: number): [number, number, number] {
  return [fit.cx + r * Math.sin(phi), fit.cy - r * Math.cos(phi), z]
}

/**
 * A box laid on the bore: local +Y points INWARD along the radial, local +Z
 * runs down the drum's axis, local +X is circumferential.
 *
 * Rotating +Y about world Z by `phi` gives `(-sin phi, cos phi, 0)`, which is
 * the inward radial at `phi` on this parameterisation — so the placement is
 * one Z rotation and no basis construction.
 */
function boreBox(
  fit: DrumFit, r: number, phi: number, z: number,
  circ: number, radial: number, along: number, col: number,
): THREE.BufferGeometry {
  return part(
    new THREE.BoxGeometry(circ, radial, along), col,
    xf(fit.cx + r * Math.sin(phi), fit.cy - r * Math.cos(phi), z, 0, 0, phi),
  )
}

/* ------------------------------------------------------- the ribbon frame */

const _bx = new THREE.Vector3()
const _by = new THREE.Vector3()
const _bz = new THREE.Vector3()
const _bp = new THREE.Vector3()

/**
 * A transform in the ROAD's own frame at sample `i`: +X is the banked lateral,
 * +Y the road's up, +Z forward along the track.
 *
 * Everything stood beside the road on this planet is placed through this, so
 * every lateral in the file is a function of `sample.width` and none of them
 * is a number of metres. That rule is the reason Rustfall survived having its
 * ribbon widened by 50%.
 */
function roadFrame(
  smp: TrackSample, lat: number, up: number, fwd: number,
  yaw = 0, roll = 0,
): THREE.Matrix4 {
  _bx.set(smp.right.x, smp.right.y, smp.right.z)
  _by.set(smp.normal.x, smp.normal.y, smp.normal.z)
  _bz.set(smp.tangent.x, smp.tangent.y, smp.tangent.z)
  _bp.set(
    smp.pos.x + _bx.x * lat + _by.x * up + _bz.x * fwd,
    smp.pos.y + _bx.y * lat + _by.y * up + _bz.y * fwd,
    smp.pos.z + _bx.z * lat + _by.z * up + _bz.z * fwd,
  )
  const m = new THREE.Matrix4().makeBasis(_bx, _by, _bz).setPosition(_bp)
  if (yaw !== 0 || roll !== 0) {
    m.multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0, yaw, roll)))
  }
  return m
}

/* ---------------------------------------------------------------- landmarks */

/** Sample index for an arc-length fraction of the lap. */
function idxAt(track: Track, s: number): number {
  const m = track.samples.length
  return ((Math.round((s / track.length) * m) % m) + m) % m
}

/**
 * DOES THIS POINT SIT IN THE ROAD, OR OVER IT, ANYWHERE ON THE LAP?
 *
 * The environment's own scatter re-checks every prop against the whole
 * centreline, in PLAN, because on a flat track plan distance is the whole
 * story. On this one it is not: the drum's road is a wall, so a hull plate
 * 14 m behind it is 14 m away in the direction that matters and zero metres
 * away in plan, and the lap crosses over itself twice more besides.
 *
 * So the check is done in each sample's OWN FRAME, which is the same
 * arithmetic `tests/track.test.ts` uses and the same three numbers: how far
 * along the track the point is (`fwd`), how far across the banked road
 * (`lat`), and how far above its surface (`up`). A point fouls the road when
 * it is beside a cross-section, inside the forgiving edge, and in the airspace
 * a car occupies. Everything else -- 14 m under the deck, 24 m over an arch,
 * 80 m out on the hull -- is free.
 *
 * Two things this buys that nothing else does. The drum's hull is CUT where
 * the road threads through it at each mouth, rather than the hull having to
 * stop short and leave the bore open-ended; and the Carousel's lamp masts
 * disappear for the ~90 m where the spiral passes under its own entry, which
 * is a piece of road 15 m below them that a plan test cannot see at all.
 */
function makeRoadTest(
  track: Track,
): (x: number, y: number, z: number, pad: number, skip?: number, span?: number) => boolean {
  const smps = track.samples
  const n = smps.length
  // The airspace band. Slightly wider than the fixture's [-0.15, 5.0] on both
  // ends, so nothing is ever placed exactly on the line the test measures.
  const UP_LO = -1.0, UP_HI = 6.5
  return (x, y, z, pad, skip = -1, span = 0) => {
    for (let i = 0; i < n; i++) {
      // A rib arch legitimately spans the road it stands over, so the station
      // it belongs to has to be excluded or nothing could ever arch anything.
      // Everything else on the lap still counts, which is the whole point: the
      // Keel's gallery passes 17 m under the Carousel, and a 24 m crown over
      // the Keel is a crown THROUGH the Carousel.
      if (skip >= 0) {
        const d = Math.abs(i - skip)
        if (Math.min(d, n - d) <= span) continue
      }
      const s = smps[i]
      const dx = x - s.pos.x, dy = y - s.pos.y, dz = z - s.pos.z
      const d2 = dx * dx + dy * dy + dz * dz
      // Cheap reject: nothing this far from a centreline point can be inside
      // that cross-section's road. Samples are 1.5 m apart, so a point beside
      // the ribbon is always within reach of at least one of them.
      const rr = s.width * 1.15 + pad + 8
      if (d2 > rr * rr) continue
      const fwd = dx * s.tangent.x + dy * s.tangent.y + dz * s.tangent.z
      if (fwd < -4.0 || fwd > 4.0) continue
      const lat = dx * s.right.x + dy * s.right.y + dz * s.right.z
      if (lat < -(s.width * 1.15 + pad) || lat > s.width * 1.15 + pad) continue
      const up = dx * s.normal.x + dy * s.normal.y + dz * s.normal.z
      if (up > UP_LO && up < UP_HI) return true
    }
    return false
  }
}

function landmarks(ctx: ThemeContext): void {
  const { track, quality, palette: pal } = ctx
  // Publish the track/spray pair for the VFX pass; see kit.ts.
  bindSurfaceSpray(track, SPRAY)
  const m = track.samples.length
  const res = track.length / m
  const low = quality.tier === 'low'

  /** Static lit structure. */
  const solid: THREE.BufferGeometry[] = []
  /** Static emissive: gallery strips, mouth lamps, mast heads. */
  const glow = glowBuffer()
  /** The rotating hull, and the amber that rides on it. */
  const spin = spinBuffer()
  const spinGlow = glowBuffer()

  const fit = fitDrum(track)
  /** True where a point would sit in the road or its airspace. See above. */
  const fouls = makeRoadTest(track)

  /* ===================================================================== */
  /* THE DRUM                                                              */
  /* ===================================================================== */

  if (fit) {
    const { r: R } = fit
    const axis: [number, number, number] = [0, 0, 1]
    const pivot: [number, number, number] = [fit.cx, fit.cy, 0]
    // The hull runs a little past the road at both ends, so the mouths are a
    // wall you drive through rather than an edge you drive off.
    const Z0 = fit.z0 - 30
    const Z1 = fit.z1 + 32
    // Bay length down the drum. 34 m at the top tier is 17 bays over the bore,
    // which is the pitch that makes the plating read as PLATING rather than as
    // one long tube, and it is also the granularity at which the tear can ramp.
    const BAY = low ? 52 : 34
    const nBay = Math.max(4, Math.round((Z1 - Z0) / BAY))
    const nRib = low ? 12 : N_RIB
    const dPhi = (Math.PI * 2) / nRib

    /* ---- longitudinal ribs, and the skin on them ----------------------- */
    //
    // MOTIF 2 at architectural scale, and the mechanic in one decision: a rib
    // survives with probability `1 - 0.66 * vacuum` and a plate with
    // probability `1 - 1.05 * vacuum`. So the sealed bore is a plated tube,
    // the ramp through the back of the Ascent sheds its skin bay by bay, and
    // the 61 m where the vacuum is FULL keeps a third of its ribs and NONE of
    // its plate at all. What is left there is a ribcage with the sky in it.
    //
    // Nothing on the hull is clearance-tested and nothing needs to be: the
    // innermost thing here is the rib's inner face at `R + 16`, and the road
    // never leaves `R + 9.3` even counting the forgiving edge and a racer's
    // own half-width. It is the two AMBER lines that had to be tested, because
    // those sit at `R + 14` and `R + 15.2` and the run-in outside the near
    // mouth climbs to `R + 13` on its way in.
    for (let k = 0; k < nRib; k++) {
      const phi = k * dPhi
      const master = k % 4 === 0
      for (let j = 0; j < nBay; j++) {
        const zc = Z0 + (j + 0.5) * BAY
        const v = vacAtZ(fit, zc)

        // A rib survives with probability `1 - 0.66 * vacuum`, so a third of
        // the ribcage is still standing at full vacuum. The first cut used
        // 0.92, which left 8% -- and 8% of a ribcage is not a ribcage, it is an
        // empty dark tube with a few sticks in it, which is exactly what the
        // first photographs of the Breach came back as. What survives inside
        // the tear is also painted a full stop paler: the only thing lighting
        // it is the sky, and a bone-coloured rib against a near-black sky is a
        // SILHOUETTE, which is the one read that survives having no key light.
        const inTear = v > 0.45
        if (hash2(k, j, 0x51b) > v * 0.66) {
          addSpin(spin, boreBox(
            fit, R + (R_RIB_IN + R_RIB_OUT) / 2, phi, zc,
            master ? 3.4 : 2.0, R_RIB_OUT - R_RIB_IN, BAY * (inTear ? 0.72 : 0.985),
            inTear ? RIB_BARE : master ? ALLOY_HI : ALLOY,
          ), pivot, axis, SPIN_RATE)
        }

        // The skin. One panel per bay, tinted off a hash so a plated wall is
        // not one flat value, and 11% of them replaced by an open bay: a dark
        // recess is the cheapest thing that says a hull has rooms in it.
        const hp = hash2(k, j, 0x9e2)
        if (hp > v * 1.05) {
          const bay = hash2(k, j, 0x33d) < 0.11
          const tone = hash2(k, j, 0x7c1)
          addSpin(spin, boreBox(
            fit, R + R_PLATE + (bay ? 2.6 : 0), phi + dPhi * 0.5, zc,
            2 * (R + R_PLATE) * Math.sin(dPhi * 0.5) * 0.99,
            bay ? 5.6 : 1.5, BAY * 0.97,
            bay ? VOID : tone < 0.18 ? BLOOM : tone < 0.55 ? HULL_DARK : HULL,
          ), pivot, axis, SPIN_RATE)
        } else if (!low && hash2(k, j, 0x1f7) < 0.42 && v < 0.995) {
          // A TORN LIP. Where the skin has gone but not everywhere, leave the
          // stub of a plate peeled outward off the rib. This is what keeps the
          // ramp from reading as a tidy grid of missing squares — the tear has
          // to have edges or it is a checkerboard.
          const lean = 0.55 + hash2(k, j, 0x2c8) * 0.5
          addSpin(spin, part(
            new THREE.BoxGeometry(
              2 * (R + R_PLATE) * Math.sin(dPhi * 0.5) * 0.55, 0.7, BAY * 0.5,
            ), HULL_DARK,
            xf(
              fit.cx + (R + R_PLATE + 2.2) * Math.sin(phi + dPhi * 0.28),
              fit.cy - (R + R_PLATE + 2.2) * Math.cos(phi + dPhi * 0.28),
              zc - BAY * 0.2, 0, lean, phi + dPhi * 0.28,
            ),
          ), pivot, axis, SPIN_RATE)
        }
      }
    }

    /* ---- pressure frames, and the two that are the vacuum boundary ------ */
    //
    // Transverse rings at `R + 20` inner radius: the road threads THROUGH
    // them, 17 m clear at the worst point on the circuit, which is the same
    // relationship a deck has with a bridge portal.
    //
    // THE TWO BOUNDARY FRAMES ARE THE TELEGRAPH. `vacAtZ` crosses 0.02 at each
    // end of the envelope; a frame is placed exactly there, at twice the
    // section of the others, carrying the last complete ring of working lamps.
    // Coming up the Ascent you see the lit bore end in a bright ring with the
    // ribcage behind it, from 200 m away, and there is nothing else it could
    // mean. Aetherion's phasing spans get about the same warning and needed it.
    const zVac: number[] = []
    for (let i = 1; i < fit.zs.length; i++) {
      const a = fit.vac[i - 1], b = fit.vac[i]
      if ((a < 0.02) !== (b < 0.02)) zVac.push(fit.zs[i])
    }
    const framePitch = low ? 92 : 58
    const frames: { z: number; heavy: boolean }[] = zVac.map((z) => ({ z, heavy: true }))
    for (let z = Z0 + 6; z < Z1; z += framePitch) {
      if (zVac.some((v) => Math.abs(v - z) < 26)) continue
      frames.push({ z, heavy: false })
    }
    for (const f of frames) {
      const v = vacAtZ(fit, f.z)
      const outR = R + (f.heavy ? R_FRAME_OUT + 6 : R_FRAME_OUT)
      const inR = R + R_FRAME_IN
      const nSeg = nRib
      for (let k = 0; k < nSeg; k++) {
        const phi = k * dPhi
          addSpin(spin, boreBox(
          fit, (inR + outR) / 2, phi + dPhi * 0.5, f.z,
          2 * ((inR + outR) / 2) * Math.sin(dPhi * 0.5) * 0.99,
          outR - inR, f.heavy ? 7.0 : 3.4,
          f.heavy ? ALLOY_HI : v > 0.45 ? RIB_BARE : ALLOY,
        ), pivot, axis, SPIN_RATE)
        // THE THRESHOLD COLLAR. On the two boundary frames only, and it is
        // the single most legible thing on the drum: a ring of alternating
        // pale and near-black blocks on the frame's inner face, which is what
        // the surround of an airlock looks like everywhere anyone has ever
        // built one. Paired with the lamp ring it says THRESHOLD in a language
        // that needs no explaining, and it says it from 200 m up the Ascent.
        if (f.heavy) {
          addSpin(spin, boreBox(
            fit, R + R_RIB_IN - 2.6, phi + dPhi * 0.5, f.z,
            2 * (R + R_RIB_IN) * Math.sin(dPhi * 0.5) * 0.92, 5.2, 6.4,
            k % 2 === 0 ? ALLOY_HI : VOID,
          ), pivot, axis, SPIN_RATE)
          // A SHEARED SPAR reaching out of the tear, on the tear side only.
          // Silhouette against the stars is the whole job: a hole in a hull is
          // read off its edges, and an edge with nothing bent out of it looks
          // like a door rather than damage.
          if (hash2(k, Math.round(f.z), 0x3a9) < 0.55) {
            const dir = vacAtZ(fit, f.z + 12) > vacAtZ(fit, f.z - 12) ? 1 : -1
            const lean = 0.5 + hash2(k, Math.round(f.z), 0x77) * 0.7
            addSpin(spin, part(
              new THREE.BoxGeometry(1.5, 1.5, 22), ALLOY,
              xf(
                fit.cx + (R + R_RIB_OUT) * Math.sin(phi + dPhi * 0.5),
                fit.cy - (R + R_RIB_OUT) * Math.cos(phi + dPhi * 0.5),
                f.z + dir * 12, 0, lean * dir, phi + dPhi * 0.5,
              ),
            ), pivot, axis, SPIN_RATE)
          }
        }
        // The lamp ring. Gained by `1 - vacuum`, so it is at full strength on
        // the boundary frames and dead on anything inside the tear.
        const lit = 1 - v
        if (lit > 0.05) {
          const dead = hash2(k, Math.round(f.z), 0x4c1) < 0.22
          const g = LAMP_GAIN * lit * (dead ? 0 : 1) + LAMP_LOW * lit * (dead ? 0.35 : 0)
          if (g > 0.02) {
            // INBOARD OF THE RIBS, not on the frame's own inner face. The
            // first cut put these at `inR - 0.4`, which is outside the skin at
            // `R + 23.5` -- so every lamp ring on the drum was visible from
            // OUTSIDE the hull and invisible from the road it was lighting.
            const rr = R + R_RIB_IN - 0.8
            const a0 = phi + dPhi * 0.5 - dPhi * 0.16
            const a1 = phi + dPhi * 0.5 + dPhi * 0.16
            const hz = f.heavy ? 2.2 : 1.3
            // The lamp sits 16 m inboard of the frame that carries it, so the
            // frame's own clearance says nothing about the lamp's.
            const lp = bore(fit, rr, phi + dPhi * 0.5, f.z)
            if (fouls(lp[0], lp[1], lp[2], 6)) continue
            glowQuad(spinGlow,
              bore(fit, rr, a0, f.z - hz), bore(fit, rr, a1, f.z - hz),
              bore(fit, rr, a1, f.z + hz), bore(fit, rr, a0, f.z + hz),
              pal.accent, g)
          }
        }
      }
    }

    /* ---- the two spin lines -------------------------------------------- */
    //
    // THE CUE THAT WORKS IN A STILL FRAME. Two amber lines helixing the bore at
    // one turn per 300 m — which is NOT the road's pitch, so they cross it at a
    // slant and keep crossing it, and the eye can read both a handedness and a
    // position around the circumference off a single frame. Dead through the
    // Breach for the same reason everything else is.
    if (!low) {
      const PITCH = 300
      const step = 5
      for (let h = 0; h < 2; h++) {
        const phi0 = h * Math.PI
        for (let z = Z0; z < Z1 - step; z += step) {
          const v = vacAtZ(fit, z + step * 0.5)
          const lit = 1 - v
          if (lit < 0.06) continue
          const flick = hash2(Math.round(z), h, 0x88b) < 0.13 ? 0.18 : 1
          const pa = phi0 + (z - Z0) * (Math.PI * 2 / PITCH)
          const pb = phi0 + (z + step - Z0) * (Math.PI * 2 / PITCH)
          const w = 0.9 / (R + R_HELIX)
          // Three points, not one: the segment is 5 m long and the road test's
          // along-track window is 4 m, so a midpoint-only check walks a lamp
          // straight over the run-in at the near mouth.
          let hit = false
          for (const f of [0, 0.5, 1]) {
            const hq = bore(fit, R + R_HELIX, pa + (pb - pa) * f, z + step * f)
            if (fouls(hq[0], hq[1], hq[2], 1.5)) { hit = true; break }
          }
          if (hit) continue
          glowQuad(spinGlow,
            bore(fit, R + R_HELIX, pa - w, z), bore(fit, R + R_HELIX, pa + w, z),
            bore(fit, R + R_HELIX, pb + w, z + step), bore(fit, R + R_HELIX, pb - w, z + step),
            pal.accent, LAMP_GAIN * lit * flick)
        }
      }
    }

    /* ---- the spokes that hang the road in the bore ---------------------- */
    //
    // WHY THE ROAD IS NOT LYING ON THE HULL. The bore's inner face is 16 m
    // outboard of the road, because that is what the measured clearance at the
    // mouths costs — so without these the ribbon is a ribbon floating in a
    // tube. Every 44 m a pair of struts runs from just outside the road's edge
    // radially OUTWARD to the plate, which is downhill on a spin-gravity drum
    // and is therefore the direction a strut would actually be in compression.
    //
    // Built in the ribbon's own frame at `corridor(width) + 2.5` and hanging
    // along -normal, so their entire length is behind the road at every sample
    // and no arrangement of widths can bring one into the airspace. They are
    // STATIC: they belong to the road, not to the hull, which is also the one
    // place a player can watch the two move against each other close up.
    {
      const first = idxAt(track, 0)
      const step = Math.max(1, Math.round(44 / res))
      for (let i = 0; i < m; i += step) {
        const smp = track.samples[(first + i) % m]
        if (smp.surface !== 'metal') continue
        const lat = ctx.corridor(smp.width) + 2.5
        // THE CHAIN. A lamp on the head of every spoke, gained by
        // `1 - vacuum` at that sample. This is the vacuum boundary stated at
        // EYE LEVEL on the road itself rather than 80 m away on the hull: a
        // rhythm of warm points running away from you down the bore, thinning
        // over the back of the Ascent and gone by the Breach. Nothing else in
        // the file puts the mechanic where the driver is already looking.
        const lit = 1 - smp.vacuum
        for (const sd of [-1, 1]) {
          const foot = new THREE.Vector3().applyMatrix4(roadFrame(smp, sd * lat, -15, 0))
          const top = new THREE.Vector3().applyMatrix4(roadFrame(smp, sd * lat, 6.6, 0))
          if (fouls(foot.x, foot.y, foot.z, 2) || fouls(top.x, top.y, top.z, 2)) continue
          solid.push(part(new THREE.BoxGeometry(1.6, 15, 1.6), ALLOY,
            roadFrame(smp, sd * lat, -7.6, 0)))
          solid.push(part(new THREE.BoxGeometry(0.9, 12, 0.9), ALLOY,
            roadFrame(smp, sd * (lat + 3.2), -8.4, 0, 0, sd * 0.26)))
          // The head stands 6.5 m up on a post, because a lamp at deck level
          // is a lamp behind the barrier: the first cut put these at 0.9 m and
          // not one of them was visible from the road they were lighting.
          solid.push(part(new THREE.BoxGeometry(0.7, 6.0, 0.7), ALLOY,
            roadFrame(smp, sd * lat, 3.4, 0)))
          solid.push(part(new THREE.BoxGeometry(1.8, 1.1, 1.7),
            lit > 0.25 ? ALLOY_HI : LAMP_DEAD,
            roadFrame(smp, sd * lat, 6.6, 0)))
          if (lit > 0.06) {
            // 1.6 x 0.6 rather than 2.4 x 1.1: this is a lamp in a housing,
            // and at the scale the first cut used it read as an illuminated
            // sign board every 30 m down the bore.
            const head = roadFrame(smp, sd * lat, 6.35, 0)
            const v = (dx: number, dy: number, dz: number): [number, number, number] => {
              const q = new THREE.Vector3(dx, dy, dz).applyMatrix4(head)
              return [q.x, q.y, q.z]
            }
            glowQuad(glow, v(-sd * 0.92, -0.05, -0.8), v(-sd * 0.92, -0.05, 0.8),
              v(-sd * 0.92, 0.55, 0.8), v(-sd * 0.92, 0.55, -0.8),
              pal.accent, LAMP_GAIN * 1.3 * lit)
          }
        }
      }
    }

    /* ---- the mouth rings, which do NOT turn ---------------------------- */
    //
    // Relative motion is what makes rotation legible, so both mouths carry a
    // heavy STATIC bulkhead that the moving hull runs past. The road is cut
    // through the floor of each: the ring spans everything except a 104-degree
    // gap at the bottom, which is where the road enters at phi ~ 0 and which
    // is also where the drift has buried the bore anyway.
    for (const mouth of [
      { z: fit.z0 - 12, out: 1 },
      { z: fit.z1 + 14, out: -1 },
    ]) {
      const inR = R + R_FRAME_IN + 2
      const outR = R + R_FRAME_OUT + 16
      for (let k = 0; k < nRib; k++) {
        const phi = k * dPhi
        const mp = bore(fit, (inR + outR) / 2, phi + dPhi * 0.5, mouth.z)
        const cp = bore(fit, inR + 2.5, phi + dPhi * 0.5, mouth.z + mouth.out * 9)
        if (fouls(mp[0], mp[1], mp[2], (outR - inR) * 0.5)
          || fouls(cp[0], cp[1], cp[2], 6)) continue
        solid.push(boreBox(
          fit, (inR + outR) / 2, phi + dPhi * 0.5, mouth.z,
          2 * ((inR + outR) / 2) * Math.sin(dPhi * 0.5) * 0.99,
          outR - inR, 9.0, k % 2 === 0 ? HULL : HULL_DARK,
        ))
        // A collar reaching back into the bore, so the mouth is a THICKNESS.
        solid.push(boreBox(
          fit, inR + 2.5, phi + dPhi * 0.5, mouth.z + mouth.out * 9,
          2 * inR * Math.sin(dPhi * 0.5) * 0.98, 6.0, 10.0, ALLOY,
        ))
        // Mouth lamps: the brightest warm line on the circuit, because this is
        // the one place a player is looking for an entrance.
        if (k % 2 === 0) {
          const rr = R + R_RIB_IN - 0.8
          const lp = bore(fit, rr, phi + dPhi * 0.5, mouth.z)
          if (fouls(lp[0], lp[1], lp[2], 6)) continue
          const a0 = phi + dPhi * 0.5 - dPhi * 0.2
          const a1 = phi + dPhi * 0.5 + dPhi * 0.2
          const g = hash2(k, Math.round(mouth.z), 0x611) < 0.18 ? 0 : LAMP_GAIN * 1.15
          if (g > 0) {
            glowQuad(glow,
              bore(fit, rr, a0, mouth.z - 3.6), bore(fit, rr, a1, mouth.z - 3.6),
              bore(fit, rr, a1, mouth.z + 3.6), bore(fit, rr, a0, mouth.z + 3.6),
              pal.accent, g)
          }
        }
      }
    }

    /* ---- the light rig inside the bore ---------------------------------- */
    //
    // THE BREACH IS THE BRIGHTEST PART OF THE DRUM, and that is the whole
    // lighting idea on this planet: the track def says the interior "is lit by
    // whatever comes through the Breach", so the tear is a light SOURCE and the
    // sealed bore is the dim part. That inverts the usual tunnel — dark inside,
    // bright outside — and it means the vacuum boundary is a lighting event
    // before it is anything else. Driving into it, the amber dies, the cold
    // comes up, and the ribcage lights from the middle of the bore.
    //
    // Two cold lights on the AXIS inside the tear, because that is where the
    // starlight crossing the drum actually is, and the axis is 70 m "up" from
    // the road at every angle around the bore — so the road is lit from
    // overhead wherever you are on the circumference, inverted included.
    if (!low) {
      const zA = fit.zs[0], zB = fit.zs[fit.zs.length - 1]
      const tear: number[] = []
      for (let z = zA; z <= zB; z += 4) if (vacAtZ(fit, z) > 0.9) tear.push(z)
      if (tear.length > 0) {
        for (const f of [0.3, 0.72]) {
          const z = tear[Math.round((tear.length - 1) * f)]
          const light = new THREE.PointLight(0xd6e6ff, 320, 240, 2)
          light.position.set(fit.cx, fit.cy, z)
          ctx.add(light)
        }
      }
    }
    // Two amber lamps at the mouths on the top tier only: enough to put a warm
    // rim on a car at the entrance and nothing more. Four point lights is the
    // ceiling this renderer's forward path can afford at 60 on the floor
    // device, and the two above are the ones that carry the beat.
    if (quality.tier === 'high') {
      for (const tag of ['nave', 'transept']) {
        const i = ctx.tagSample(tag)
        if (i < 0) continue
        const smp = track.samples[i]
        const light = new THREE.PointLight(pal.accent, 520, 150, 2)
        light.position.set(
          smp.pos.x + smp.normal.x * 16,
          smp.pos.y + smp.normal.y * 16,
          smp.pos.z + smp.normal.z * 16,
        )
        ctx.add(light)
      }
    }
  }

  /* ===================================================================== */
  /* THE GALLERIES — the Keel, the Ribs, and the Gantry's portals          */
  /* ===================================================================== */

  /**
   * One transverse rib over the road.
   *
   * THE CLEARANCE RULE, BY CONSTRUCTION. The legs stand at
   * `corridor(width) + 5` and run STRAIGHT UP to 11 m before the arch starts
   * leaning in, so every vertex inside the protected lateral is at least 11 m
   * over the road and the fixture's [-0.15, 5.0] airspace band is empty. That
   * is deliberately not "the arch happens to be tall enough": Rustfall's
   * conveyor gantry put its legs on the road at a hardcoded +/-19 m, and the
   * lesson written down was that a lateral is a function of `sample.width`.
   */
  function ribArch(
    smp: TrackSample, anchor: number, crown: number, section: number,
    portal: boolean, col: number, colTop: number,
  ): THREE.BufferGeometry[] {
    const L = ctx.corridor(smp.width) + 5
    const out: THREE.BufferGeometry[] = []
    const SPRING = 11
    // THE WHOLE ARCH IS CLEAR OF THE WHOLE LAP, its own station excepted.
    //
    // Testing only the feet was the first cut and it missed the case that
    // matters: the Keel's gallery runs 17 m UNDER the Carousel's entry, and a
    // 24 m crown standing over the Keel goes straight through the Carousel's
    // deck. Feet, leg heads and five points along the crown, every one of them
    // checked against every metre of ribbon except the 37 m of it this arch is
    // built over.
    for (const sd of [-1, 1]) {
      for (const [lx, ly] of [
        [sd * L, 0], [sd * L, SPRING],
        [sd * L * 0.86, crown * 0.62], [sd * L * 0.5, crown * 0.9], [0, crown],
      ]) {
        const f = new THREE.Vector3().applyMatrix4(roadFrame(smp, lx, ly, 0))
        if (fouls(f.x, f.y, f.z, section * 1.2, anchor, 25)) return out
      }
    }
    for (const sd of [-1, 1]) {
      // Leg: outside the corridor, springing down to well below the verge.
      // The extra 9 m under the road plane is not decoration: on a banked
      // section a point at `corridor + 5` sits several metres ABOVE the
      // terrain, so a leg that stops at the road's own plane stands in the
      // air. Burying it is cheaper and more robust than sampling the ground
      // field for something that ends up underground either way.
      out.push(part(new THREE.BoxGeometry(section, SPRING + 10, section * 0.85), col,
        roadFrame(smp, sd * L, (SPRING - 10) / 2, 0)))
      out.push(part(new THREE.BoxGeometry(section * 2.1, 1.6, section * 1.8), HULL_DARK,
        roadFrame(smp, sd * L, -4.0, 0)))
    }
    if (portal) {
      // A portal frame: a straight beam and a trolley hanging off it. The
      // Gantry's own name, and the shape a dock crane actually has.
      out.push(part(new THREE.BoxGeometry(L * 2 + section, section * 1.3, section * 1.5), colTop,
        roadFrame(smp, 0, crown, 0)))
      out.push(part(new THREE.BoxGeometry(L * 2, 0.5, 0.5), ALLOY_HI,
        roadFrame(smp, 0, crown - 1.6, 0)))
      out.push(part(new THREE.BoxGeometry(section * 2.2, 2.6, section * 2.0), HULL,
        roadFrame(smp, L * 0.34, crown - 3.0, 0)))
      // Knee braces. Without them the beam reads as a slab floating over the
      // road with its legs off the side of the frame, which is what the first
      // photographs of the Gantry came back as.
      for (const sd of [-1, 1]) {
        out.push(part(new THREE.BoxGeometry(9.5, section * 0.8, section * 0.7), colTop,
          roadFrame(smp, sd * (L - 3.4), crown - 3.4, 0, 0, sd * 0.78)))
      }
    } else {
      // A curved rib. Four facets a side: past that the arch stops reading as
      // low-poly and starts costing real triangles, and there are thirty of
      // these on the lap.
      const STEPS = 4
      for (const sd of [-1, 1]) {
        for (let i = 0; i < STEPS; i++) {
          const t0 = i / STEPS, t1 = (i + 1) / STEPS
          const p = (t: number): [number, number] => [
            sd * L * Math.cos(t * Math.PI / 2) ** 0.55,
            SPRING + (crown - SPRING) * Math.sin(t * Math.PI / 2) ** 0.9,
          ]
          const [x0, y0] = p(t0)
          const [x1, y1] = p(t1)
          const len = Math.hypot(x1 - x0, y1 - y0)
          const ang = Math.atan2(y1 - y0, x1 - x0)
          out.push(part(
            new THREE.BoxGeometry(len + section * 0.4, section, section * 0.85),
            i === STEPS - 1 ? colTop : col,
            roadFrame(smp, (x0 + x1) / 2, (y0 + y1) / 2, 0, 0, ang),
          ))
        }
      }
    }
    return out
  }

  /**
   * A gallery: ribs at a fixed pitch, optionally plated between them, with a
   * failing amber strip run along the wall head on both sides.
   *
   * The Keel is plated and the Ribs is not, and that is the whole difference
   * between them: the same rhythm, once as a corridor with walls and once as
   * a skeleton with the dark showing through. Both carry a draught, and a
   * draught wants a channel you can see.
   */
  function gallery(
    s0: number, s1: number, pitch: number, crown: number,
    plated: boolean, section: number,
  ): void {
    const step = Math.max(1, Math.round(pitch / res))
    const i0 = idxAt(track, s0)
    const n = Math.max(2, Math.round((s1 - s0) / pitch))
    for (let b = 0; b <= n; b++) {
      const i = (i0 + b * step) % m
      const smp = track.samples[i]
      solid.push(...ribArch(smp, i, crown, section, false, ALLOY, ALLOY_HI))

      if (b === n) continue
      const iN = (i0 + (b + 1) * step) % m
      const smpN = track.samples[iN]
      for (const sd of [-1, 1]) {
        const L = ctx.corridor(smp.width) + 5
        const LN = ctx.corridor(smpN.width) + 5
        // The wall. One quad a bay, 13 m high, 18% of them missing so the
        // gallery has holes in it and the dark behind it can be seen.
        // THE WHOLE PANEL, at both ends and up its full height.
        //
        // One point at mid-height was the first cut and it missed by six
        // metres: the Keel's gallery runs under the Carousel, and it was the
        // TOP corner of a 13.5 m wall -- and the strip light bolted to it --
        // that ended up level with a deck 11 m overhead while the point being
        // tested sat harmlessly below it. `fouls` pads the lateral but not the
        // height, on purpose, so a tall object has to be sampled up its own
        // height or the check means nothing.
        const wBlocked = ((): boolean => {
          for (const [sm, ix] of [[smp, i], [smpN, iN]] as const) {
            const LL = ctx.corridor((sm as TrackSample).width) + 6.6
            for (const up of [-2, 4, 9, 13.5]) {
              const q = new THREE.Vector3().applyMatrix4(roadFrame(sm as TrackSample, sd * LL, up, 0))
              if (fouls(q.x, q.y, q.z, 3, ix as number, 30)) return true
            }
          }
          return false
        })()
        if (wBlocked) continue
        const gone = hash2(b, sd, 0x2ab) < (plated ? 0.18 : 0.72)
        if (!gone) {
          const wall = new THREE.BufferGeometry()
          const a = roadFrame(smp, sd * (L + 1.6), -2.0, 0)
          const c = roadFrame(smpN, sd * (LN + 1.6), -2.0, 0)
          const pos: number[] = []
          const p0 = new THREE.Vector3(0, 0, 0).applyMatrix4(a)
          const p1 = new THREE.Vector3(0, 0, 0).applyMatrix4(c)
          const q0 = new THREE.Vector3(0, 13.5, 0).applyMatrix4(a)
          const q1 = new THREE.Vector3(0, 13.5, 0).applyMatrix4(c)
          pos.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, q1.x, q1.y, q1.z, q0.x, q0.y, q0.z)
          wall.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
          wall.setIndex([0, 1, 2, 0, 2, 3, 0, 2, 1, 0, 3, 2])
          wall.computeVertexNormals()
          solid.push(part(wall, hash2(b, sd, 0x51) < 0.3 ? HULL_DARK : HULL, new THREE.Matrix4()))
        }
        // THE STRIP. A continuous amber line at the wall head, with a fifth of
        // its bays dead. A line is what the eye reads speed off, and a line
        // with gaps in it is what the eye reads DERELICT off.
        const dead = hash2(b, sd, 0x77c) < 0.31
        if (!dead) {
          const a = roadFrame(smp, sd * (L + 0.6), 12.6, 0)
          const c = roadFrame(smpN, sd * (LN + 0.6), 12.6, 0)
          const v = (mtx: THREE.Matrix4, dy: number): [number, number, number] => {
            const p = new THREE.Vector3(0, dy, 0).applyMatrix4(mtx)
            return [p.x, p.y, p.z]
          }
          glowQuad(glow, v(a, 0), v(c, 0), v(c, 0.36), v(a, 0.36),
            pal.accent, LAMP_GAIN * (hash2(b, sd, 0x93) < 0.28 ? 0.42 : 1))
        }
      }
    }
  }

  /**
   * A RUN OF LAMP MASTS DOWN THE OUTSIDE OF A CORNER.
   *
   * The galleries get their light from a continuous strip on a wall; the open
   * corners have no wall, and out there the amber has to come from something
   * that stands up. Same rule as everything else on this planet: a mast at
   * `corridor(width) + gap`, a head above barrier height, and one in four dead.
   *
   * This is legibility before it is decoration. The Carousel is 669 m of
   * constant arc and the second-longest drift run in the game, and on a night
   * circuit with a near-black deck the only thing telling a driver where the
   * arc goes is a line of lights curving away. The barrier's own cap lamps do
   * half of that job; these do the other half, at a height the eye tracks.
   */
  function waysideLamps(s0: number, s1: number, pitch: number, side: number, gap: number): void {
    const step = Math.max(1, Math.round(pitch / res))
    const i0 = idxAt(track, s0)
    const n = Math.max(1, Math.round((s1 - s0) / pitch))
    for (let b = 0; b <= n; b++) {
      const smp = track.samples[(i0 + b * step) % m]
      const lat = ctx.corridor(smp.width) + gap
      // ON THE GROUND, AND STANDING UP IN WORLD TERMS.
      //
      // Not in the ribbon's frame: the Carousel banks 22 degrees, and a mast
      // hung off the banked plane at `corridor + 6` sits 10.6 m above the
      // centreline and three to ten metres above the terrain that is supposed
      // to be holding it up. A lamp post is vertical because gravity is, so
      // the LATERAL comes from the road's frame and the HEIGHT comes from the
      // ground field -- the same split every scattered prop already uses.
      const anchorPt = new THREE.Vector3().applyMatrix4(roadFrame(smp, side * lat, 0, 0))
      const bx = anchorPt.x, bz = anchorPt.z
      const by = ctx.ground(bx, bz).y
      const yaw = Math.atan2(smp.tangent.x, smp.tangent.z)
      // Toward the road, in plan.
      const inX = -Math.cos(yaw) * side, inZ = Math.sin(yaw) * side
      const H = Math.max(9, smp.pos.y - by + 9)
      // UP THE MAST AT A FIXED METRIC PITCH, NOT AT FRACTIONS OF ITS HEIGHT.
      //
      // This used to sample [0, 0.4H, 0.75H, H] and it shipped a lamp post
      // standing in the middle of the start/finish straight. The comment was
      // already right about the failure -- a post whose MIDDLE crosses a deck
      // -- and the fix was wrong in a way only arithmetic shows: the airspace
      // band `makeRoadTest` looks at is 7.5 m tall, and on a 29 m mast the gap
      // between the first two samples is 11.6 m. The mast that was reported
      // sat with its foot at y=26.7 and its next sample at y=38.3, while the
      // road it went through is at y=30.8 with the band running 29.8 to 37.3.
      // It straddled the band exactly, and every sample missed.
      //
      // A fraction-based pitch gets COARSER as the object gets taller, which
      // is precisely backwards: a taller mast crosses more airspace. 2 m is a
      // quarter of the band, so nothing can slip between two samples however
      // tall it grows.
      let blocked = false
      const rungs: [number, number][] = [[2.0, H + 0.4], [3.4, H + 0.4]]
      for (let dy = 0; dy <= H; dy += 2) rungs.push([0, dy])
      rungs.push([0, H])
      for (const [dh, dy] of rungs) {
        if (fouls(bx + inX * dh, by + dy, bz + inZ * dh, 2.4)) { blocked = true; break }
      }
      if (blocked) continue
      const dead = hash2(b, Math.round(s0), 0x5e1) < 0.24
      solid.push(part(new THREE.BoxGeometry(2.2, 1.6, 2.2), HULL_DARK, xf(bx, by + 0.4, bz, yaw)))
      solid.push(part(new THREE.BoxGeometry(0.9, H, 0.9), ALLOY, xf(bx, by + H / 2, bz, yaw)))
      // The head reaches back over the verge, which is what a mast head does
      // and which puts the lamp where it lights the road rather than the dirt.
      solid.push(part(new THREE.BoxGeometry(4.2, 0.9, 1.6), dead ? LAMP_DEAD : ALLOY_HI,
        xf(bx + inX * 1.9, by + H + 0.4, bz + inZ * 1.9, yaw + Math.PI / 2)))
      if (!dead) {
        const hx = bx + inX * 3.3, hy = by + H, hz = bz + inZ * 3.3
        glowQuad(glow,
          [hx - inZ, hy - 0.5, hz + inX], [hx + inZ, hy - 0.5, hz - inX],
          [hx + inZ, hy + 0.3, hz - inX], [hx - inZ, hy + 0.3, hz + inX],
          pal.accent, LAMP_GAIN * 1.15)
      }
    }
  }

  // Every corner on the superstructure turns LEFT, so `+1` is the outside —
  // the side a driver is looking across on the way in and running out to on
  // the way out, and the only side worth lighting.
  waysideLamps(2560, 3190, low ? 84 : 44, 1, 6)   // the Carousel
  waysideLamps(1800, 1990, low ? 90 : 46, 1, 7)   // the Gantry
  waysideLamps(430, 700, low ? 90 : 48, 1, 8)     // the Antechoir

  // The Keel: the primary straight, plated, and the first thing a player sees.
  gallery(20, 400, low ? 56 : 30, 24, true, 1.9)
  // The Ribs: the same rhythm with the plate stripped. The draught runs here.
  gallery(2020, 2330, low ? 60 : 32, 26, false, 1.7)

  // THE GANTRY: four portal frames over the corner that is named after them.
  {
    const i0 = ctx.tagSample('gantry')
    if (i0 >= 0) {
      for (let k = 0; k < 4; k++) {
        const i = (i0 + Math.round((k * 42) / res)) % m
        solid.push(...ribArch(track.samples[i], i, 17, 2.6, true, HULL, ALLOY_HI))
      }
    }
  }

  /* ===================================================================== */
  /* THE CAROUSEL — the collapsed cargo dock                               */
  /* ===================================================================== */
  //
  // 669 m of constant corner is the longest in the game, and the one thing a
  // driver cannot get from a corner that long is a sense of PROGRESS through
  // it. The spiral has an exact centre, so the centre gets an object: a 78 m
  // dock spindle, snapped near the top, with four radiating arms and one of
  // them dropped. Going round the Carousel is then an orbit around a landmark
  // that changes aspect the whole way, instead of 669 m of identical wall.
  //
  // The centroid is MEASURED off the samples rather than authored, and the
  // clearance is measured with it: the road's own inner radius about that
  // point is 96 m and the spindle reaches 64 m, so the object is 32 m clear
  // before `clearOfTrack` is consulted at all.
  {
    const i0 = ctx.tagSample('carousel')
    if (i0 >= 0) {
      let cx = 0, cz = 0, n = 0
      const span = Math.round(660 / res)
      for (let k = 0; k < span; k += 4) {
        const p = track.samples[(i0 + k) % m].pos
        cx += p.x; cz += p.z; n++
      }
      cx /= n; cz /= n
      let rMin = Infinity
      for (let k = 0; k < span; k += 4) {
        const p = track.samples[(i0 + k) % m].pos
        rMin = Math.min(rMin, Math.hypot(p.x - cx, p.z - cz))
      }
      const gy = ctx.ground(cx, cz).y
      // Only build it if the measured clearance actually exists. A spiral that
      // was re-authored tighter should lose its spindle, not put one on the
      // road.
      if (rMin > 78) {
        const rnd = mulberry32(0xca6058)
        // Base drum, then a tapering stack of truss boxes, leaning 5 degrees.
        solid.push(part(new THREE.CylinderGeometry(24, 27, 9, low ? 6 : 10), HULL_DARK,
          xf(cx, gy + 4, cz)))
        let y = gy + 9
        let w = 17
        for (let k = 0; k < 5; k++) {
          const h = 17 - k * 1.4
          solid.push(part(new THREE.BoxGeometry(w, h, w), k % 2 === 0 ? ALLOY : HULL,
            xf(cx + (y - gy) * 0.045, y + h / 2, cz, 0.3 * k, 0, 0.048)))
          // Ring collar at every joint: the spindle has to read as stacked.
          solid.push(part(new THREE.CylinderGeometry(w * 0.82, w * 0.82, 1.5, low ? 6 : 10), ALLOY_HI,
            xf(cx + (y - gy) * 0.045, y, cz, 0, 0, 0.048)))
          y += h
          w *= 0.83
        }
        // The break. Three shards leaning off the top, and nothing above them.
        for (let k = 0; k < 3; k++) {
          solid.push(part(new THREE.BoxGeometry(3.0, 9 + rnd() * 7, 2.4), ALLOY_HI,
            xf(cx + (rnd() - 0.5) * 7, y + 3, cz + (rnd() - 0.5) * 7,
              rnd() * 3, (rnd() - 0.5) * 0.8, (rnd() - 0.5) * 0.9)))
        }
        /**
         * FOUR DOCK ARMS AT 36 M UP, ONE OF THEM DROPPED ONTO THE DECK -- AND
         * WHICH ONE IS NOW MEASURED, NOT AUTHORED.
         *
         * Reported from play: "there is what seems to be a lampost object ...
         * near the end of the track ... placed in the middle of the track."
         * That was this. Arm 2 drooped at -0.62 rad from 36 m, so a 40 m arm
         * with a lamp on its tip came down to 12.8 m -- and landed on the
         * road, 12.5 m inside the edge and 4.7 m above the deck at s=3252 m.
         * From the seat, a fallen arm with a lit head reads as a lamp post
         * lying across the track, which is exactly what it was.
         *
         * THE CLEARANCE ARGUMENT ABOVE WAS TRUE AND MEASURED THE WRONG ROAD.
         * `rMin` is the closest the CAROUSEL's own 660 m comes to the
         * centroid, and it is a genuine 96 m. But the intrusion is at
         * s=3252 m, which is past the Carousel entirely -- the run-out to the
         * start line, road that was never in the measurement. A landmark with
         * a 64 m reach cannot be cleared against one beat of a lap that
         * crosses over itself twice.
         *
         * So the arm that falls is chosen by asking the road. `fouls` tests
         * every sample on the circuit, which is the whole point of it, and the
         * arm keeps its full droop only where the ground under it is clear.
         * The art intent survives -- one arm has come down -- and it can never
         * again come down on a racing line, including on a lap re-authored
         * later.
         */
        let fallen = -1
        for (let k = 0; k < 4 && fallen < 0; k++) {
          const a = (k / 4) * Math.PI * 2 + 0.4
          let clear = true
          // Walk the drooped arm from the hub to the tip. A single tip test
          // misses an arm whose MIDDLE crosses a deck, which is the same
          // mistake the wayside masts already had to fix.
          for (let f = 0; f <= 1.001 && clear; f += 0.1) {
            const rr = 24 + 40 * f
            if (fouls(cx + Math.sin(a) * rr, gy + 36 + Math.sin(-0.62) * 40 * f,
              cz + Math.cos(a) * rr, 4.0)) clear = false
          }
          if (clear) fallen = k
        }
        for (let k = 0; k < 4; k++) {
          const a = (k / 4) * Math.PI * 2 + 0.4
          // If no arm has clear ground the landmark simply keeps all four up,
          // which is a duller silhouette and never a hazard.
          const droop = k === fallen ? -0.62 : k === (fallen + 2) % 4 ? -0.08 : 0
          const len = 40
          solid.push(part(new THREE.BoxGeometry(len, 2.6, 3.2), ALLOY,
            xf(cx + Math.sin(a) * (24 + len / 2), gy + 36 + Math.sin(droop) * len * 0.5,
              cz + Math.cos(a) * (24 + len / 2), Math.PI / 2 - a, 0, droop)))
          solid.push(part(new THREE.BoxGeometry(7, 5, 7), HULL,
            xf(cx + Math.sin(a) * (24 + len), gy + 36 + Math.sin(droop) * len,
              cz + Math.cos(a) * (24 + len), Math.PI / 2 - a)))
          // A lamp on the tip of each arm. The Carousel is a night corner and
          // these are the only four fixed points in it.
          const t: [number, number, number] = [
            cx + Math.sin(a) * (24 + len),
            gy + 36 + Math.sin(droop) * len + 3.6,
            cz + Math.cos(a) * (24 + len),
          ]
          glowQuad(glow,
            [t[0] - 1.6, t[1] - 1.2, t[2] - 1.6], [t[0] + 1.6, t[1] - 1.2, t[2] - 1.6],
            [t[0] + 1.6, t[1] + 1.2, t[2] + 1.6], [t[0] - 1.6, t[1] + 1.2, t[2] + 1.6],
            pal.accent, k === 2 ? 0 : LAMP_GAIN * 1.2)
        }
      }
    }
  }

  /* ===================================================================== */
  /* THE MESHES                                                            */
  /* ===================================================================== */

  if (solid.length > 0) {
    const geo = merge(solid)
    const mesh = new THREE.Mesh(geo, ctx.propMaterial)
    mesh.name = 'landmark-structure'
    mesh.castShadow = quality.shadows
    mesh.receiveShadow = quality.shadows
    mesh.matrixAutoUpdate = false
    mesh.updateMatrix()
    ctx.add(mesh); ctx.own(geo)
  }

  const glowMat = new THREE.MeshBasicMaterial({
    vertexColors: true, fog: true, toneMapped: true, depthWrite: true,
  })
  ctx.own(glowMat)

  if (glow.p.length > 0) {
    const geo = glowGeometry(glow)
    const mesh = new THREE.Mesh(geo, glowMat)
    mesh.name = 'hollow-lamps'
    mesh.matrixAutoUpdate = false
    mesh.updateMatrix()
    ctx.add(mesh); ctx.own(geo)
  }

  const uTime = { value: 0 }

  if (spin.parts.length > 0) {
    const geo = merge(spin.parts)
    geo.setAttribute('aPivot', new THREE.BufferAttribute(new Float32Array(spin.pivot), 3))
    geo.setAttribute('aAxis', new THREE.BufferAttribute(new Float32Array(spin.axis), 3))
    geo.setAttribute('aRate', new THREE.BufferAttribute(new Float32Array(spin.rate), 1))
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.86, metalness: 0.22,
      flatShading: true, dithering: true,
    })
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uTime
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${SPIN_PARS}`)
        .replace('#include <begin_vertex>', SPIN_BODY)
    }
    mat.customProgramCacheKey = () => 'spacegen-hollowchoir-spin'
    const mesh = new THREE.Mesh(geo, mat)
    mesh.name = 'drum-hull'
    // The vertex shader turns the whole body about its own axis, and the body
    // is symmetric about that axis, so the baked bounding sphere is already
    // exact — no growth needed, unlike Aetherion's orbiting keystones.
    mesh.castShadow = false
    mesh.receiveShadow = quality.shadows
    mesh.matrixAutoUpdate = false
    mesh.updateMatrix()
    ctx.add(mesh); ctx.own(geo); ctx.own(mat)
  }

  if (spinGlow.p.length > 0) {
    const geo = glowGeometry(spinGlow)
    // The lamps ride the same rigid body as the plate they are bolted to, so
    // they carry the same three attributes and compile the same vertex body —
    // into a MeshBasicMaterial this time, because a lamp is its own light.
    const vn = geo.getAttribute('position').count
    const pv = new Float32Array(vn * 3)
    const ax = new Float32Array(vn * 3)
    for (let i = 0; i < vn; i++) {
      pv[i * 3] = fit ? fit.cx : 0
      pv[i * 3 + 1] = fit ? fit.cy : 0
      ax[i * 3 + 2] = 1
    }
    geo.setAttribute('aPivot', new THREE.BufferAttribute(pv, 3))
    geo.setAttribute('aAxis', new THREE.BufferAttribute(ax, 3))
    geo.setAttribute('aRate', new THREE.BufferAttribute(new Float32Array(vn).fill(SPIN_RATE), 1))
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: true, toneMapped: true })
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uTime
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${SPIN_PARS}`)
        .replace('#include <begin_vertex>', SPIN_BODY)
    }
    mat.customProgramCacheKey = () => 'spacegen-hollowchoir-spin-glow'
    const mesh = new THREE.Mesh(geo, mat)
    mesh.name = 'drum-lamps'
    mesh.matrixAutoUpdate = false
    mesh.updateMatrix()
    ctx.add(mesh); ctx.own(geo); ctx.own(mat)
  }

  ctx.onUpdate((f: FrameInfo) => { uTime.value = f.time })
}

/* ------------------------------------------------- hand-placed scatter props */

/**
 * THE ORGAN MASSES, ON THE SCATTER'S OWN MESH.
 *
 * `PropSpec.landmark` appends hand-placed instances to the spec's own
 * InstancedMesh, so four 46 m masses at the drum's mouths and a ranked row
 * down the Keel cost geometry and not one extra draw call — the same trick
 * that pays for Aetherion's 413 m colonnade. Every placement goes through
 * `corridor(width)` plus the prop's own scaled footprint and is re-checked
 * against the whole centreline, so no arrangement of widths can put one on
 * the road.
 */
function pipeStands(
  ctx: ThemeContext, push: (mtx: THREE.Matrix4, tint: THREE.Color) => void,
): void {
  const { track } = ctx
  const m = track.samples.length
  const res = track.length / m
  const rnd = mulberry32(0xc4015)
  const cold = new THREE.Color(0.88, 0.92, 0.98)
  const warm = new THREE.Color(1.0, 0.95, 0.86)
  const _e = new THREE.Euler()
  const _q = new THREE.Quaternion()
  const _p = new THREE.Vector3()
  const _s = new THREE.Vector3()

  /** Stand one mass beside sample `i`, if it clears everything. */
  const stand = (i: number, side: number, scale: number, gap: number): void => {
    const smp = track.samples[i % m]
    const tx = smp.tangent.x, tz = smp.tangent.z
    const tl = Math.hypot(tx, tz) || 1
    const rx = (tz / tl) * side, rz = (-tx / tl) * side
    // 2.6 is the cluster's own half-width at scale 1; the mass is placed by
    // its SHELL, so `gap` is a true edge clearance.
    const lat = ctx.corridor(smp.width) + 2.6 * scale + gap
    const x = smp.pos.x + rx * lat
    const z = smp.pos.z + rz * lat
    if (!ctx.clearOfTrack(x, z, 2.6 * scale)) return
    const g = ctx.ground(x, z)
    _e.set(0, Math.atan2(-rx, -rz) + (rnd() - 0.5) * 0.3, 0)
    _q.setFromEuler(_e)
    _p.set(x, g.y - 0.6 * scale, z)
    _s.set(scale, scale * (0.85 + rnd() * 0.4), scale)
    push(new THREE.Matrix4().compose(_p, _q, _s),
      rnd() < 0.4 ? warm.clone() : cold.clone().multiplyScalar(0.8 + rnd() * 0.35))
  }

  // The four masses flanking the drum's mouths. 4.8x the scattered scale is a
  // 46 m instrument, which is the largest single object on the circuit that is
  // not the drum itself, and it is the thing you drive at down the Antechoir.
  for (const tag of ['nave', 'transept']) {
    const i = ctx.tagSample(tag)
    if (i < 0) continue
    for (const side of [-1, 1]) {
      stand(i - Math.round(46 / res), side, 4.8, 16)
      stand(i + Math.round(30 / res), side, 3.1, 22)
    }
  }

  // A ranked row down the Keel, both sides, growing toward the braking zone.
  const iKeel = ctx.tagSample('keel')
  if (iKeel >= 0) {
    for (let k = 0; k < 11; k++) {
      const i = iKeel + Math.round((28 + k * 34) / res)
      const sc = 1.6 + k * 0.16
      for (const side of [-1, 1]) stand(i, side, sc, 10 + (k % 3) * 6)
    }
  }
  // And a stand of them in the lee of the Antechoir, where the dust is.
  const iAnte = ctx.tagSample('antechoir')
  if (iAnte >= 0) {
    for (let k = 0; k < 6; k++) {
      stand(iAnte + Math.round((60 + k * 40) / res), k % 2 === 0 ? -1 : 1, 2.2 + rnd() * 1.6, 14 + rnd() * 30)
    }
  }
}

/**
 * THE SPINE, AND THE OUTSIDE OF THE GANTRY, AS A ROW OF RIBS.
 *
 * The Spine is 98 m of Tier-2 corner named after a backbone; the read is a
 * vertebral row of frames stood along its outside, close enough together that
 * they strobe past. Same free ride as the organ masses: they append to the rib
 * prop's own InstancedMesh.
 */
function ribStands(
  ctx: ThemeContext, push: (mtx: THREE.Matrix4, tint: THREE.Color) => void,
): void {
  const { track } = ctx
  const m = track.samples.length
  const res = track.length / m
  const rnd = mulberry32(0x21b5)
  const _e = new THREE.Euler()
  const _q = new THREE.Quaternion()
  const _p = new THREE.Vector3()
  const _s = new THREE.Vector3()

  const stand = (i: number, side: number, scale: number, gap: number): void => {
    const smp = track.samples[((i % m) + m) % m]
    const tx = smp.tangent.x, tz = smp.tangent.z
    const tl = Math.hypot(tx, tz) || 1
    const rx = (tz / tl) * side, rz = (-tx / tl) * side
    const lat = ctx.corridor(smp.width) + 3.6 * scale + gap
    const x = smp.pos.x + rx * lat
    const z = smp.pos.z + rz * lat
    if (!ctx.clearOfTrack(x, z, 3.6 * scale)) return
    const g = ctx.ground(x, z)
    // Turned so the snapped crown reaches OVER the road: a rib that leans away
    // is a post, and a rib that leans in is architecture.
    _e.set((rnd() - 0.5) * 0.06, Math.atan2(-rx, -rz) + Math.PI / 2 * side, (rnd() - 0.5) * 0.05)
    _q.setFromEuler(_e)
    _p.set(x, g.y - 0.5 * scale, z)
    _s.set(scale, scale * (0.9 + rnd() * 0.25), scale)
    push(new THREE.Matrix4().compose(_p, _q, _s),
      new THREE.Color(0.86 + rnd() * 0.2, 0.9 + rnd() * 0.14, 0.94 + rnd() * 0.1))
  }

  const iSpine = ctx.tagSample('spine')
  if (iSpine >= 0) {
    for (let k = -3; k < 12; k++) stand(iSpine + Math.round((k * 17) / res), 1, 1.5 + rnd() * 0.5, 5)
  }
  const iGantry = ctx.tagSample('gantry')
  if (iGantry >= 0) {
    for (let k = 0; k < 9; k++) stand(iGantry + Math.round((k * 21) / res), 1, 1.3 + rnd() * 0.5, 8)
  }
  const iRibs = ctx.tagSample('ribs')
  if (iRibs >= 0) {
    for (let k = 0; k < 10; k++) {
      stand(iRibs + Math.round((k * 33) / res), k % 2 === 0 ? -1 : 1, 1.4 + rnd() * 0.7, 18 + rnd() * 26)
    }
  }
}

/* ---------------------------------------------------------------- terrain */

const _hull = new THREE.Color()
const _dust = new THREE.Color()
const _dark = new THREE.Color()
const _seam = new THREE.Color(0.055, 0.075, 0.085)
const _rake = new THREE.Color()

export const HOLLOWCHOIR_THEME: Theme = {
  id: 'hollowchoir',

  props(pal, seg) {
    void pal
    return [
      {
        name: 'choir-stack', geo: propChoirStack(seg), count: 68,
        // 2.6 m half-width of pipes at scale 1, plus the plinth's corner.
        radius: 3.4, gap: 4, spread: 150, scale: [0.7, 1.9],
        cluster: { tag: 'keel', span: 420, share: 0.30 },
        landmark: pipeStands,
      },
      {
        name: 'rib', geo: propRib(), count: 58,
        // The crown reaches 7.4 m off the leg: the plan half-diagonal is 4.2.
        radius: 4.2, gap: 3, spread: 165, scale: [0.8, 2.1],
        cluster: { tag: 'ribs', span: 340, share: 0.30 },
        landmark: ribStands,
      },
      {
        name: 'hull-plate', geo: propPlate(), count: 100,
        radius: 5.6, gap: 1.6, spread: 190, scale: [0.7, 1.9], sink: 0.25,
        cluster: { tag: 'antechoir', span: 300, share: 0.26 },
      },
      {
        name: 'truss-wreck', geo: propTruss(), count: 76,
        radius: 6.2, gap: 2.2, spread: 210, scale: [0.7, 1.8], sink: 0.5,
        cluster: { tag: 'carousel', span: 620, share: 0.34 },
      },
      {
        name: 'drift', geo: propDrift(), count: 96,
        radius: 6.4, gap: 1.0, spread: 130, scale: [0.8, 2.4], sink: 0.55,
        // Two centuries of shed hull dust, banked into the lee of the mouth.
        cluster: { tag: 'antechoir', span: 340, share: 0.42 },
      },
      {
        name: 'mast', geo: propMast(), count: 40,
        radius: 2.2, gap: 9, spread: 260, scale: [0.8, 2.2], sink: 0.2,
      },
    ] satisfies PropSpec[]
  },

  landmarks,

  /**
   * THE FLOOR IS NOT A PLANET. It is the outer hull of the same structure,
   * seen from on top of it, with two centuries of its own shed dust lying on
   * it — so the one thing this field must not read as is geology.
   *
   * The trick that does that is a PLATE GRID, computed from the world x and z
   * the terrain point already carries: a 34 x 26 m panel with a dark seam
   * around it and a per-panel value break. It costs two `fract`s and it turns
   * the low-poly shell from a landscape into decking, which is a distinction
   * the eye makes instantly and no amount of noise can fake.
   *
   * Over that, regolith: the macro band decides where the drift has covered
   * the plate, and it covers most of it. The verge is left as the DARKEST part
   * of the field — the road is a lit ribbon and it needs a dark edge to sit
   * inside rather than dissolving into the deck.
   */
  terrainColor(out, p: TerrainPoint, pal) {
    _hull.setHex(HULL)
    _dust.setHex(REGOLITH)
    _dark.setHex(REGOLITH_D)

    // Panel grid, offset per row so the joints stagger like real decking.
    const row = Math.floor(p.z / 26)
    const u = Math.abs(((p.x / 34 + row * 0.37) % 1 + 1) % 1 - 0.5)
    const v = Math.abs(((p.z / 26) % 1 + 1) % 1 - 0.5)
    const seam = Math.max(
      1 - Math.min(1, u / 0.028),
      1 - Math.min(1, v / 0.034),
    )
    // A per-panel value break: plate is replaced piecemeal, never uniformly.
    const panel = ((Math.imul(Math.floor(p.x / 34) | 0, 374761393)
      ^ Math.imul(row | 0, 668265263)) >>> 8) / 16777216

    out.copy(_hull).multiplyScalar(0.90 + 0.40 * panel)
    // Corrosion bleeding along the seams the drift has not covered.
    out.lerp(_seam, seam * 0.72)

    // The drift. Covers most of the field and all of the hollows.
    const dust = Math.min(1, Math.max(0, p.macro * 1.5 - 0.12))
    _dust.lerp(_dark, Math.max(0, 0.62 - p.mid) * 0.9)
    out.lerp(_dust, dust * 0.86)

    // Ridge highlight: the one place the cold key actually rakes the deck.
    out.lerp(_rake.setHex(pal.a), p.ridge * 0.14 * p.mid)

    // Verge darkest, field lighter, so the road has an edge to sit inside.
    // The floor of a whole level of the multiplier is 0.66 rather than 0.50:
    // this planet's key does no work on a flat deck (a 15-degree sun on an
    // up-facing surface is N.L = 0.26) and the verge went to black rather than
    // to dark, which is the failure Cryostatic's note about value warns about
    // from the other end.
    const near = Math.min(1, Math.max(0, p.edge) / 52)
    out.multiplyScalar(0.66 + 0.30 * near + 0.13 * p.grit + 0.12 * p.mid)
  },
  // Oxidised plate under dust: rough, and barely metal at all. A high
  // metalness here has nothing to reflect — there is no environment map in
  // this scene — and collapses the whole floor to a silhouette.
  terrainMaterial: { roughness: 0.93, metalness: 0.08 },
  // Grades onto the fog late: the wreck is meant to keep going past the point
  // where you can make out what it is.
  terrainFade: [120, 560],
  propMaterial: { roughness: 0.84, metalness: 0.24 },

  /**
   * Shed dust and paint flake, hanging rather than falling. `fall` is 0.35 and
   * not Cryostatic's 3.4: this is the inside of a structure that has been
   * still for two hundred years, and anything that fell has long since landed.
   * What is left in the air is what the draught keeps up, which is why the
   * count and the alpha both ride the wind through `WeatherStyle.moteGain` —
   * and why there is nothing in the air at all in the Breach.
   */
  motes: {
    count: 900, box: 120, size: [0.8, 3.0], pixel: 62, maxPixels: 11,
    alpha: 0.13, fall: 0.35, streak: 0.7,
    color: (_pal, fog) => new THREE.Color(0.80, 0.86, 0.94).lerp(fog, 0.42),
  },

  /**
   * WHAT THE DRAUGHT IS CARRYING.
   *
   * Two hundred years of shed hull: oxidised plate scale and paint flake off a
   * structure that has been corroding in its own escaping atmosphere. So the
   * colour is `pal.a` — the grey-green the whole wreck is painted in — warmed
   * a sixth of the way toward the amber emergency lighting, which is the only
   * light source down here that is still working and therefore the only thing
   * these flakes can be catching.
   *
   * Longer and slower-settling than the default. This is the inside of a
   * sealed drum, not an open plain: the draught runs circumferentially with
   * nowhere to go, so what it lifts stays up, and `fall` is 0.5 for the same
   * reason the motes' is 0.35.
   *
   * IT DISAPPEARS IN THE BREACH FOR FREE, and that is the point of driving the
   * layer off `windPush`. `wind` on this circuit is 22-26 in the galleries and
   * exactly zero through the tear, because a crosswind is air and there is
   * none out there — so the debris stops at the same metre the haze, the dust
   * and the fog do, without this file knowing where the Breach is.
   */
  debris: {
    count: 1000, box: 78, length: 5.0, width: 0.26, alpha: 0.50, fall: 0.5,
    color: (pal, fog) => new THREE.Color()
      .setHex(pal.a)
      .lerp(new THREE.Color().setHex(pal.accent), 0.16)
      .lerp(fog, 0.26),
  },

  /**
   * A STARFIELD, BECAUSE THE SKY HERE IS NOT AN ATMOSPHERE.
   *
   * `starHorizon` is low (0.10): the haze this wreck outgasses only reaches a
   * few degrees up, so the field survives almost to the horizon and the world
   * reads as a structure sitting in space rather than a landscape under a dark
   * sky. It is also what makes the Breach work — through the tear you are
   * looking at the same sky, and it has stars in it.
   */
  sky: {
    band: 'stars',
    // Near black, and held apart from `skyBottom` on purpose: the light rig
    // needs a bright sky colour to fill the drum and the DOME needs a dark one
    // or the Breach opens onto grey. See SkyStyle.domeLow.
    domeLow: 0x0a1018,
    starGain: 1.9,
    /**
     * WHAT THE WRECK IS FALLING INTO.
     *
     * The Hollow Choir is a derelict megastructure in vacuum and the one
     * question its silence asks is why it was abandoned. The answer is out
     * through the Breach: it is in a decaying orbit around a black hole.
     *
     * This is the track the lensing is FOR. The starfield here is the
     * brightest in the game (starGain 1.9, surviving almost to the horizon),
     * so bending it around the shadow moves something the player can actually
     * see move -- on a hazy planet the same code would distort nothing and
     * cost the same.
     *
     * Placed high and to one side rather than down the road: dead ahead it
     * would sit behind the racing line for a third of the lap and the shadow
     * is the one element here that genuinely eats contrast.
     */
    celestial: {
      gain: 1.0,
      hole: {
        dir: [0.66, 0.46, -0.60],
        sizeDeg: 3.2,
        lensing: 1.15,
        discInner: 0xffe6b0,
        discOuter: 0xff4d1f,
        discOut: 6.0,
        axis: [0.12, 0.86, 0.50],
        gain: 1.0,
      },
    },
    // Almost to the horizon. What little haze this wreck outgasses reaches a
    // couple of degrees up and no further, so the field survives right down to
    // the fog line -- which is what makes the tear read as an opening rather
    // than as one more dark surface.
    starHorizon: 0.035,
  },

  /**
   * Outgassing. Very few, very large, very faint: the wreck is still venting
   * two centuries on, and this is what that looks like from inside a car. The
   * band sits low so the banks lie along the deck rather than at eye level.
   */
  fogBanks: {
    count: 7, size: 112, alpha: 0.040, low: -14, high: 18,
    color: (_pal, fog) => fog.clone().lerp(new THREE.Color(0.62, 0.70, 0.78), 0.30),
  },

  /**
   * WHERE THERE IS AIR, AND WHERE THERE IS NOT.
   *
   * This is the fourth channel the vacuum boundary is carried on, and it is
   * the only one that is free: `wind` on this circuit is 22-26 in the two
   * galleries, 24 across the drum's sealed bays and EXACTLY ZERO through the
   * Breach, because a crosswind is air and there is none out there. The
   * weather system keys off nothing but wind, so authoring it this way puts
   * haze, drifting dust and a denser fog precisely where there is an
   * atmosphere to hold them and takes all three away where there is not.
   *
   * The numbers are deliberately mild. Cryostatic's blizzard closes the world
   * to 60 m because the blizzard IS a mechanic there; here the air is a
   * material, not a hazard, and the drum is 140 m across with the whole point
   * of being inside it being that you can see the road over your head. 0.0040
   * against the authored 0.0024 is about a stop of contrast on the far wall —
   * enough to feel the bore fill with dust and to feel it empty in the Breach.
   */
  weather: {
    windFull: 24,
    fogColor: 0x3b444f,
    fogDensity: 0.0034,
    sunScale: 0.88,
    // THE FILL IS HALVED WHERE THERE IS AIR. Inside a drum the key does no
    // work (N.L is near zero on the whole bore), so the hemisphere fill is
    // effectively the only light there is — which makes it the one channel
    // loud enough to carry the vacuum boundary as a felt change rather than a
    // noticed one. Air: dim, hazy, amber. No air: half a stop up, cold, and
    // the ribcage in silhouette. It is also the honest direction, because the
    // track def's own note says the drum is lit by what comes through the
    // Breach.
    hemiScale: 0.52,
    moteGain: 2.6,
  },

  road: 'industrial',
  spray: SPRAY,
}
