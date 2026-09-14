/**
 * HALCYON BAY — tidal coast at golden hour.
 *
 * ---------------------------------------------------------------------------
 * THE BRIGHTEST PLANET IN THE GAME, WHICH IS THE HARD PART.
 *
 * GDD 09: "Track environments sit in the mid-to-dark band so vehicles and VFX
 * always pop. If a track section washes out the racers, the track is wrong."
 * Cryostatic's header records how an ice planet nearly broke that rule at 0.87
 * albedo. A sunlit beach is the same trap with a 1.35 key over it, and the
 * grey-box lost four of the five chassis into the sand.
 *
 * The answer is the time of day. This is not noon, it is late afternoon: the sun
 * sits 7 degrees up and almost along the start straight, so the sand is RAKED
 * rather than lit flat. Everything the key touches is warm and bright;
 * everything it does not is a long blue shadow, and the shadows are most of the
 * frame. Dry sand peaks at 0.79 in sRGB and its shadow side sits at 0.28 -- the
 * racers are read against the shadow, not against the highlight.
 *
 * The KEY AND THE HAZE ARE COOLER THAN THE FIRST THREE DRAFTS, and that was
 * forced by measurement rather than taste. A 1.35 warm key graded onto a warm
 * haze desaturates everything under it: the sea was authored, the terrain
 * function returned the right teal when called directly, and the frame still
 * photographed as a desert three times running. Hue does not survive that much
 * warm light. The sun is 1.12 and the haze is a cool grey-green, so the warmth
 * now comes from the horizon band and the low sun itself -- which is where it
 * comes from at this hour anyway -- and the water is allowed to be water.
 *
 * The second lever is that the beach is NARROW. The sea comes up to the verge,
 * so sand is a band rather than a field, and most of the frame away from the
 * road is water -- which is a cool mid value and therefore a ground the warm
 * chassis read against cleanly. (The first draft tried to do this with a
 * near-black sea on photographic grounds; see the note at SEA for why that
 * rendered as a desert.)
 *
 * Beats and what each one gets:
 *   1  boardwalk start   pilings, slat shadows raking across the road
 *   2  the dunes         marram grass, fences, and the jump over the crest
 *   3  the tideline      wet sand, a mirror of the sky, spray off the surf
 *   4  the Pier          the loop: a ring of lamps around the pier head
 *   5  the Waterspout    two turns of corkscrew inside a standing column
 *   6  the head          the sun on the horizon and the birds going home
 */
import * as THREE from 'three'
import {
  bindSurfaceSpray, merge, mulberry32, part, xf,
  type FrameInfo, type Palette, type PropSpec, type SurfaceSprayTable,
  type TerrainPoint, type Theme, type ThemeContext,
} from './kit'

/* ------------------------------------------------------------- the values */

/** Dry sand in the key. The brightest ground in the game, and it is rationed. */
const SAND_LIT = 0xd8b184
/** Dry sand out of the key. This is the value most of the beach actually is. */
const SAND_SHADE = 0x6b5a55
/** Wet packed sand: darker than dry, and it mirrors the sky. */
const WET = 0x4a4a52
/**
 * Sea. A MID teal, and the header used to argue for near-black on the grounds
 * that water away from the glitter path is nearly black at golden hour. That is
 * true of a photograph and false of this frame: under a 1.35 warm key, graded
 * onto a 0xd8a888 haze, a 0x14212e sea renders as dark BROWN and the planet
 * photographed as a desert three times running. Hue does not survive being that
 * dark here. It holds a mid value so it reads as water, and the racers gain
 * contrast rather than lose it -- every chassis in the roster is warm.
 */
const SEA = 0x2aa2c4
const SEA_LIT = 0x9fdcea
/** Weathered boardwalk timber and dune fencing. */
const TIMBER = 0x5d4432
const TIMBER_LIT = 0x8a6b4e
/** Marram grass, bleached rather than green. */
const GRASS = 0x6d7350
/** Lamps on the pier. The only emissive on the circuit. */
const LAMP = 0xffca7a

/* ------------------------------------------------------------------ props */

/** Marram tussock: thin blades, the dune silhouette. */
function propGrass(pal: Palette, seg: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const rnd = mulberry32(0x9a55)
  for (let i = 0; i < 14; i++) {
    const h = 1.1 + rnd() * 2.4
    const a = rnd() * Math.PI * 2
    parts.push(part(
      new THREE.ConeGeometry(0.10, h, 3),
      rnd() < 0.3 ? SAND_SHADE : GRASS,
      xf(Math.cos(a) * rnd() * 1.5, h / 2, Math.sin(a) * rnd() * 1.5,
        rnd() * 3, (rnd() - 0.5) * 0.55, (rnd() - 0.5) * 0.55),
    ))
  }
  void pal; void seg
  return merge(parts)
}

/** Dune fencing: leaning slats, half-buried. The dunes' signature element. */
function propFence(pal: Palette, seg: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const rnd = mulberry32(0xfe0ce)
  for (let i = 0; i < 12; i++) {
    const h = 1.5 + rnd() * 0.9
    parts.push(part(
      new THREE.BoxGeometry(0.13, h, 0.05),
      i % 3 === 0 ? TIMBER_LIT : TIMBER,
      xf(i * 0.44 - 2.4, h / 2 - 0.3, (rnd() - 0.5) * 0.2, 0, 0, (rnd() - 0.5) * 0.24),
    ))
  }
  parts.push(part(new THREE.BoxGeometry(5.6, 0.08, 0.07), TIMBER, xf(0, 1.2, 0)))
  void pal; void seg
  return merge(parts)
}

/** Driftwood: bleached, low, scattered along the tideline. */
function propDriftwood(pal: Palette, seg: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const rnd = mulberry32(0xd21f7)
  for (let i = 0; i < 4; i++) {
    const L = 2.5 + rnd() * 5
    parts.push(part(
      new THREE.CylinderGeometry(0.22 + rnd() * 0.2, 0.3 + rnd() * 0.2, L, Math.max(4, seg >> 3)),
      i === 0 ? SAND_LIT : TIMBER_LIT,
      xf((rnd() - 0.5) * 3, 0.3, (rnd() - 0.5) * 3, rnd() * 3, 0, Math.PI / 2 + (rnd() - 0.5) * 0.3),
    ))
  }
  void pal
  return merge(parts)
}

/** Pier pilings: a cluster of barnacled posts with a cross-brace. */
function propPilings(pal: Palette, seg: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const rnd = mulberry32(0x9113)
  for (let i = 0; i < 4; i++) {
    const h = 7 + rnd() * 5
    parts.push(part(
      new THREE.CylinderGeometry(0.55, 0.68, h, Math.max(5, seg >> 2)),
      i % 2 ? TIMBER : TIMBER_LIT,
      xf((i % 2) * 3.4 - 1.7, h / 2, Math.floor(i / 2) * 3.4 - 1.7),
    ))
  }
  parts.push(part(new THREE.BoxGeometry(5.2, 0.4, 0.3), TIMBER, xf(0, 6.2, -1.7)))
  void pal
  return merge(parts)
}

/* -------------------------------------------------------------- landmarks */

function landmarks(ctx: ThemeContext): void {
  const { track, palette: pal, quality } = ctx
  bindSurfaceSpray(track, SPRAY)

  /* ---- THE LOOPS. Same problem the Lava Tube and the Cathedral had: a loop
   * with no boost strip through it has nothing lighting its far side, and a
   * headline set piece the player cannot see is not one. Here the answer is in
   * fiction for free -- these are seafront structures, and seafront structures
   * have lamps. A ring of them concentric with each loop, plus two warm fills
   * inside the bore.
   *
   * TWO of them now: this circuit is the LOOP track in the roster's division of
   * set pieces, so it carries the Pier and the Arch and no spiral at all. ---- */
  for (const name of ['pier', 'arch']) {
    const iLoop = ctx.tagSample(name)
    const iApex = ctx.tagSample(`${name}-apex`)
    if (iLoop < 0 || iApex < 0) continue
    const a = track.samples[iLoop], b = track.samples[iApex]
    const loopR = Math.max(8, (b.pos.y - a.pos.y) / 2)
    const cx = (a.pos.x + b.pos.x) / 2, cy = (a.pos.y + b.pos.y) / 2, cz = (a.pos.z + b.pos.z) / 2
    const tl = Math.hypot(a.tangent.x, a.tangent.z) || 1
    const fx = a.tangent.x / tl, fz = a.tangent.z / tl
    const R = loopR + ctx.corridor(a.width) + 3.0
    // Lamps as a ring of small spheres in one merged mesh: 18 lamps, one draw.
    const lamps: THREE.BufferGeometry[] = []
    const N = 18
    for (let i = 0; i < N; i++) {
      const th = (Math.PI * 2 * i) / N
      const ox = Math.sin(th) * R, oy = -Math.cos(th) * R
      lamps.push(part(new THREE.SphereGeometry(0.7, 6, 5), LAMP, xf(fx * ox, oy, fz * ox)))
    }
    const geo = merge(lamps)
    ctx.own(geo)
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: true })
    ctx.own(mat)
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.set(cx, cy, cz)
    ctx.add(mesh)
    if (quality.tier !== 'low') {
      for (const k of [-1, 1]) {
        const L = new THREE.PointLight(0xffc078, 1.9, loopR * 3.6, 1.8)
        L.position.set(cx + fx * k * loopR * 0.55, cy, cz + fz * k * loopR * 0.55)
        ctx.add(L)
      }
    }
    const ph = name === 'arch' ? 2.3 : 0
    ctx.onUpdate((f: FrameInfo) => {
      // Filament lamps on a sea breeze: a small, slow flicker, never a strobe.
      const g = 0.90 + 0.10 * Math.sin(f.time * 1.7 + ph) * Math.sin(f.time * 0.43 + ph)
      mat.color.setScalar(g)
    })
  }
  void pal
}

/* ---------------------------------------------------------------- terrain */

const _c = new THREE.Color()

/**
 * Sand, sea, and the line between them. `ridge` is height above the start line,
 * so it does the work of a tide chart: below it is water, above it is beach.
 */
function terrainColor(out: THREE.Color, p: TerrainPoint, pal: Palette): void {
  // Dry sand, raked by the key. `grit` stands in for the low sun catching the
  // windward face of every ripple -- which is what makes a beach read as sand
  // rather than as a brown plane.
  out.set(SAND_SHADE).lerp(_c.set(SAND_LIT), Math.pow(p.grit, 1.5) * 0.85)

  // THE WATERLINE IS KEYED OFF `edge`, NOT `ridge`, and the first version of
  // this file got that wrong in a way worth recording.
  //
  // `ridge` is height above the START LINE normalised over ~26m, so on a
  // circuit whose road climbs from 2m to 76m it is positive almost everywhere
  // -- the sea was authored below a threshold the terrain never reached, and
  // the planet rendered as a desert. Nor can the sea be a distant plane: at
  // fogDensity 0.0026 anything past ~1500m is already fog, so scenery that is
  // only visible on the horizon is not visible at all.
  //
  // So the road runs along a SPIT, and the water is a function of how far you
  // are from the ribbon. That is what puts blue in the frame at a distance the
  // fog still passes, and it is also true to the fiction: a tidal coast at low
  // water is a sand road with sea on both sides.
  //
  // AND IT SITS CLOSE. The first attempt put the waterline at 78-124m past the
  // ribbon, which is inside the fog's reach at this density -- the sea was
  // there and the frame could not see it, which is the same as it not being
  // there. At 20-44m it is on the verge, in clear air, and it is the first
  // thing in the frame that is not orange.
  //
  // THE THRESHOLDS WERE FOUND BY BISECT, not by reasoning about `edge`. Three
  // drafts authored the waterline at 20-124m past the ribbon and photographed
  // as a desert every time; painting SEA pure red for one build showed the
  // water WAS rendering, just far enough out that the haze had taken its hue.
  // The lesson is the general one: when a value is authored correctly and the
  // frame disagrees, find out which layer is lying before changing the value
  // again. It was the fog, and the fix is distance, not colour.
  const wet = Math.max(0, Math.min(1, (p.edge - 6) / 10))
  out.lerp(_c.set(WET), wet * 0.80)
  const sea = Math.max(0, Math.min(1, (p.edge - 12) / 16))
  if (sea > 0.001) {
    out.lerp(_c.set(SEA), sea)
    // The glitter path: where the macro band lifts a swell into the low sun.
    // The only bright water on the planet, and it is a few percent of it.
    out.lerp(_c.set(SEA_LIT), Math.max(0, p.macro - 0.62) * 2.0 * sea)
  }
  void pal
}

/* ----------------------------------------------------------------- spray */

const SPRAY: SurfaceSprayTable = {
  // Dry sand: a lot of it, light, and it hangs. The signature of the dunes.
  gravel: { bulk: 0xc0a078, glint: 0xf0dcb4, weight: 0.20, grit: 0.12, density: 2.2, gain: 0.72, spark: 0.06, sparkCol: 0xffd9a0 },
  // Wet packed sand and the boardwalk: a sheet of water and damp grit.
  tarmac: { bulk: 0x8a8a86, glint: 0xd8e0e4, weight: 0.34, grit: 0.20, density: 1.4, gain: 0.60, spark: 0.30, sparkCol: 0xffd9a0 },
  metal: { bulk: 0x7a7c80, glint: 0xd0d8dc, weight: 0.44, grit: 0.30, density: 1.0, gain: 0.54, spark: 0.60, sparkCol: 0xffd0a0 },
  oil: { bulk: 0x3c3a36, glint: 0x8a8276, weight: 0.30, grit: 0.14, density: 0.9, gain: 0.40, spark: 0.10, sparkCol: 0xffb45e },
  ice: { bulk: 0x8ea6b0, glint: 0xdcf0f6, weight: 0.50, grit: 0.36, density: 0.6, gain: 0.46, spark: 0.24, sparkCol: 0xcfe8ff },
  snow: { bulk: 0xb0b8b4, glint: 0xe8f0ee, weight: 0.22, grit: 0.16, density: 1.4, gain: 0.58, spark: 0.08, sparkCol: 0xcfe8ff },
  boost: { bulk: 0xb08a60, glint: 0xffd9a0, weight: 0.30, grit: 0.26, density: 1.3, gain: 0.66, spark: 0.48, sparkCol: 0xffe2b0 },
}

/* ----------------------------------------------------------------- theme */

export const HALCYON_THEME: Theme = {
  id: 'halcyon',

  props(pal, seg): PropSpec[] {
    return [
      {
        name: 'marram', geo: propGrass(pal, seg), count: 260,
        radius: 2.2, gap: 1.6, spread: 15, scale: [0.7, 1.6],
        cluster: { tag: 'dunes', span: 460, share: 0.46 },
      },
      {
        name: 'dune-fence', geo: propFence(pal, seg), count: 96,
        radius: 3.2, gap: 2.2, spread: 13, scale: [0.8, 1.3],
        cluster: { tag: 'dunes', span: 420, share: 0.52 },
      },
      {
        name: 'driftwood', geo: propDriftwood(pal, seg), count: 130,
        radius: 4.0, gap: 2.0, spread: 12, scale: [0.7, 1.5],
        cluster: { tag: 'tideline', span: 420, share: 0.44 },
      },
      {
        // Pilings are the ONE prop allowed out into the water -- that is what a
        // piling is. Everything else is pulled in tight so it stays on sand.
        name: 'pilings', geo: propPilings(pal, seg), count: 60,
        radius: 3.6, gap: 4.5, spread: 110, scale: [0.8, 1.8],
        cluster: { tag: 'pier', span: 300, share: 0.48 },
      },
    ]
  },

  landmarks,
  terrainColor,
  terrainMaterial: { roughness: 0.96, metalness: 0.02 },
  // Long. This is clean coastal air at golden hour and the whole appeal is
  // being able to see the headland; a short fade would throw away the view.
  terrainFade: [420, 1500],

  /** Sea spray and blown sand, lifting off the crests rather than falling. */
  motes: {
    count: 420, box: 80, size: [0.05, 0.18], pixel: 140, maxPixels: 4,
    alpha: 0.44, fall: -0.5, streak: 0.55,
    color: (_pal, fog) => new THREE.Color(0.95, 0.88, 0.78).lerp(fog, 0.34),
  },

  /** The sea breeze: sand streaming off the dune crests. */
  debris: {
    count: 620, box: 86, length: 6.4, width: 0.26, alpha: 0.30, fall: 0.9,
    color: (_pal, fog) => new THREE.Color(0.80, 0.70, 0.56).lerp(fog, 0.40),
  },

  sky: {
    band: 'strata',
    // The whole planet in one value. This is the band that makes it golden hour
    // rather than midday, and it is the strongest lever in the file.
    horizonColor: 0xff9a48,
    horizonSpan: [0.0, 0.26],
    horizonGain: 1.10,
    celestial: {
      bodies: [
        {
          // THE SUN, on the horizon, enormous and soft. `shade` near zero
          // because a star has no terminator; the limb carries the haze.
          dir: [0.86, 0.07, -0.50],
          sizeDeg: 4.2,
          color: 0xfff0cc,
          shade: 0.02,
          limb: 0.85,
        },
        {
          // A daytime moon, pale and low-contrast, opposite the sun. It is the
          // one thing in this sky that says "not Earth" without shouting.
          dir: [-0.50, 0.62, 0.60],
          sizeDeg: 2.4,
          color: 0xd8cfc4,
          shade: 0.72,
          mottle: 0.48,
          limb: 0.10,
        },
      ],
      ships: {
        // Seabirds going home. `ships` is silhouettes with running lights; with
        // the lights turned nearly off it is just silhouettes, which at 600m
        // against a bright sky is exactly what a bird is.
        dir: [0.52, 0.30, -0.74],
        spreadDeg: 30,
        sizeDeg: 1.1,
        color: 0x2a1f18,
        lightColor: 0xffcf9a,
        lightGain: 0.10,
        count: 9,
        driftDeg: 0.55,
      },
      gain: 0.80,
    },
  },

  /** Sea haze on the water, low and warm. Thin -- the air here is clean. */
  fogBanks: {
    count: 7, size: 128, alpha: 0.030, low: -6, high: 22,
    color: (_pal, fog) => fog.clone().lerp(new THREE.Color(1.0, 0.90, 0.76), 0.28),
  },

  /**
   * The sea breeze. `windFull` 10 matches the track's peak -- the cue has to
   * arrive and leave exactly where the force does. It is the mildest weather in
   * the game and it does NOT close the world down: this is the Easy circuit,
   * and taking a beginner's sightlines away is the opposite of the job.
   */
  weather: {
    windFull: 10.0,
    fogColor: 0xbfc4bc,
    fogDensity: 0.0052,
    sunScale: 0.86,
    moteGain: 1.6,
  },

  road: 'industrial',
  propMaterial: { roughness: 0.90, metalness: 0.03 },
  spray: SPRAY,
}
