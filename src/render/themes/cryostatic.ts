/**
 * CRYOSTATIC — ice tundra planet.
 *
 * GDD 09: "cyan, white, deep blue with aurora greens overhead. Volumetric fog
 * is the hero effect. Ice uses a cheap fake-subsurface shader — a fresnel-driven
 * depth tint, not real SSS."
 *
 * ---------------------------------------------------------------------------
 * THE VALUE PROBLEM, AND HOW THIS FILE ANSWERS IT.
 *
 * GDD 09 also says: "Track environments sit in the mid-to-dark band so vehicles
 * and VFX always pop. If a track section washes out the racers, the track is
 * wrong." An ice planet is the obvious way to break that rule, and the
 * grey-boxed version did: snow at 0.87 albedo under a 1.7 key, graded at
 * distance onto a 0xa8cfe0 fog, with the boost chevrons emitting 1.1 on top of
 * it. Five racers and every VFX in the game vanished into it.
 *
 * The answer is NOT to make the snow grey. It is that this is a POLAR DUSK.
 * The sun sits 20 degrees up and cold-white; the fill is deep blue; snow is
 * therefore a mid blue-grey that only goes bright where the key rakes a facet,
 * and ice is a DARK material with a bright rim. White is reserved for three
 * things — the sun's own scatter, the fresnel edge on ice, and the blizzard —
 * so when the frame does go white it means something.
 *
 * Concretely, every albedo in this file sits between 0.09 and 0.58 in sRGB.
 * The palest chassis in the game (Filament, 0xdfe6ee) is 0.88. That gap is the
 * whole job, and it is the first thing a screenshot has to be checked against.
 * ---------------------------------------------------------------------------
 *
 * Beats and what each one gets:
 *   1  glacier ramp start   seracs and wind-carved fins framing the descent
 *   2  frozen lake sweeper  the fragile shelf: a flat ice pan, a barrier that
 *                           falls THROUGH it on lap 3, and a broken drop-off
 *                           edge afterwards (the geometry lives in trackMesh)
 *   3  bioluminescent cave  near-black rock tube, emissive ice veins, two cold
 *                           point lights. The lighting showpiece.
 *   4  moraine switchbacks  rock erratics and rubble
 *   6  ice tunnel loop      a banked ice tube, fully enclosing
 *   7  chasm jump           glacier fins on the skyline, cryo vents below
 *   8  blizzard band        marker poles, driving snow, and a fog that closes
 *                           to ~60 m so the chevron chain is the only line
 */
import * as THREE from 'three'
import {
  bindSurfaceSpray, merge, mulberry32, part, xf,
  type FrameInfo, type Palette, type PropSpec, type SurfaceSprayTable,
  type TerrainPoint, type Theme, type ThemeContext,
} from './kit'

/* ------------------------------------------------------------- the values */
//
// Authored in sRGB, converted on read, and every one measured against the
// mid-to-dark rule. ROCK is the darkest thing on the planet; SNOW_HI is the
// brightest, and it only appears on an edge the key is raking.

/** Near-black basalt under the ice. The cavern is built out of this. */
const ROCK = 0x18222d
const ROCK_LIT = 0x2c3a48
/** Packed snow in the open — a MID blue-grey, not white. */
const SNOW = 0x93a8b8
/** Wind-polished crest. The only pale value in the prop catalogue. */
const SNOW_HI = 0xbccddb
/** Snow that has fallen into shade. */
const SNOW_SHADE = 0x5d7286
/** Glacier ice: dark and saturated. Brightness comes from the fresnel rim. */
const ICE = 0x3d7794
const ICE_DEEP = 0x1d4560
/** Weathered alloy on anything the racing league bolted down. */
const ALLOY = 0x475767

/* ----------------------------------------------------------- drift spray */

/**
 * What Cryostatic throws at you when you slide on it.
 *
 * THIS PLANET IS THE PLUME PLANET, and it is the exact case the value rule at
 * the top of this file exists for. A drifting car on packed snow buries itself
 * in powder: the spray is the densest in the game (`density` 1.5) and it hangs
 * (`weight` 0.10, so it drifts upward and stalls instead of dropping), which is
 * what sells the surface. What it is NOT is bright. `gain` is a fraction of a
 * cap the VFX holds below the bloom threshold, so a hundred overlapping puffs
 * read as a dense volume against a mid-dark road rather than as the blizzard
 * whiteout this planet already had to be talked out of once. The only white
 * here is the glint — individual crystals catching the low key — and a crystal
 * is two pixels.
 *
 * There is no metal and no tarmac on the lap, so a grounded chassis strikes
 * almost nothing: `spark` is 0 on snow and a small, cold, short-lived 0.16 on
 * ice, where a hard edge shearing a frozen sheet can honestly throw something.
 * The tier ladder therefore reads here through the plume and the chip shower,
 * and on Rustfall through the sparks. Same code, opposite planet.
 */
const SPRAY: SurfaceSprayTable = {
  // Packed snow: the signature. Enormous, soft, hangs in the air behind you.
  snow: {
    bulk: 0xbccddb, glint: 0xeaf6ff, weight: 0.10, grit: 0.24,
    density: 1.50, gain: 0.62, spark: 0.00, sparkCol: 0xeaf6ff,
  },
  // Glacier ice does not powder, it SHATTERS. Little bulk, mostly hard chips
  // that fly flat and skitter, and a cold shear at the contact patch. This is
  // also what the frozen lake turns into on lap 3, the instant the shelf goes.
  ice: {
    bulk: 0x9fc6da, glint: 0xd7f2ff, weight: 0.66, grit: 0.60,
    density: 0.68, gain: 0.52, spark: 0.16, sparkCol: 0xbfe8ff,
  },
  // Moraine rubble, if a future pass ever exposes it: dark wet rock.
  gravel: {
    bulk: 0x3d4d5c, glint: 0x93a8b8, weight: 0.95, grit: 0.62,
    density: 1.10, gain: 0.44, spark: 0.12, sparkCol: 0xd8e6f0,
  },
  // League steel. The one place on this planet that strikes properly, and it
  // strikes COLD -- white-blue, not the sodium orange of the junkyard.
  metal: {
    bulk: 0x475767, glint: 0xcfe4f2, weight: 0.52, grit: 0.32,
    density: 0.46, gain: 0.46, spark: 0.90, sparkCol: 0xdff0ff,
  },
  // Frozen apron. Grit under a layer of rime.
  tarmac: {
    bulk: 0x5a6a78, glint: 0xb8cfdd, weight: 0.38, grit: 0.26,
    density: 0.90, gain: 0.50, spark: 0.42, sparkCol: 0xd8e6f0,
  },
  // Slush over the pan: dark, heavy, and it kills the strike.
  oil: {
    bulk: 0x1d2b38, glint: 0x6f8fa8, weight: 0.62, grit: 0.24,
    density: 0.85, gain: 0.32, spark: 0.05, sparkCol: 0x9fc6da,
  },
  // Boost plate under the blizzard: snow off the strip, lit by the accent.
  boost: {
    bulk: 0xa8c2d4, glint: 0x7bffcf, weight: 0.16, grit: 0.30,
    density: 1.35, gain: 0.56, spark: 0.00, sparkCol: 0x7bffcf,
  },
}

/* ------------------------------------------------------------- hero props */

/**
 * Hero prop 1 — glacial erratic. A boulder the ice carried and dropped, with
 * a wind-packed snow cap. The low clutter element: hundreds of them, small,
 * dark, and the main thing keeping the snowfield from reading as a bedsheet.
 */
function propErratic(p: Palette, seg: number): THREE.BufferGeometry {
  void p; void seg
  const rnd = mulberry32(0x1ce0)
  const parts: THREE.BufferGeometry[] = []
  for (let i = 0; i < 3; i++) {
    const s = 1.35 - i * 0.34
    parts.push(part(
      new THREE.IcosahedronGeometry(s, 0),
      i === 0 ? ROCK : ROCK_LIT,
      xf((rnd() - 0.5) * 1.5, s * 0.72, (rnd() - 0.5) * 1.5,
        rnd() * 3.1, rnd() * 0.6, rnd() * 0.6, 1.25, 0.82, 1.05),
    ))
  }
  // The drift on the lee side, and a cap the key light catches.
  parts.push(part(new THREE.IcosahedronGeometry(1.55, 0), SNOW_SHADE,
    xf(0.55, 0.18, 0.35, 0.9, 0, 0, 1.5, 0.30, 1.35)))
  parts.push(part(new THREE.IcosahedronGeometry(0.85, 0), SNOW_HI,
    xf(-0.15, 1.62, -0.1, 2.2, 0, 0, 1.15, 0.36, 1.0)))
  return merge(parts)
}

/**
 * Hero prop 2 — serac. A block of the glacier that has fractured and tilted.
 * Stacked leaning slabs, ice below and snow-packed above, 6-9 m tall: this is
 * the mid-height silhouette that gives the snowfield a horizon line.
 */
function propSerac(p: Palette, seg: number): THREE.BufferGeometry {
  void p; void seg
  const rnd = mulberry32(0x5e4ac)
  const parts: THREE.BufferGeometry[] = []
  let y = 0
  let w = 3.5
  for (let i = 0; i < 4; i++) {
    const h = 1.7 + rnd() * 1.5
    parts.push(part(
      new THREE.BoxGeometry(w, h, w * (0.72 + rnd() * 0.4)),
      i === 0 ? ICE_DEEP : i === 3 ? SNOW_SHADE : ICE,
      xf((rnd() - 0.5) * 0.9, y + h / 2, (rnd() - 0.5) * 0.9,
        rnd() * 1.4, (rnd() - 0.5) * 0.18, (rnd() - 0.5) * 0.24),
    ))
    y += h * 0.88
    w *= 0.83
  }
  // Snow cornice on the windward face. Thin, bright, and the only pale plane.
  parts.push(part(new THREE.BoxGeometry(w * 1.9, 0.34, w * 1.5), SNOW_HI,
    xf(0.25, y + 0.1, 0, 0.5, 0, 0.09)))
  return merge(parts)
}

/**
 * Hero prop 3 — pressure ridge. Where two sheets met and buckled: a line of
 * thin plates levered out of the ground. Low, wide and directional, so a
 * scatter of them gives the plain a grain instead of a texture.
 */
function propRidge(p: Palette, seg: number): THREE.BufferGeometry {
  void p; void seg
  const rnd = mulberry32(0x21d6e)
  const parts: THREE.BufferGeometry[] = []
  for (let i = 0; i < 6; i++) {
    const t = (i / 5) * 2 - 1
    const h = 2.4 + (1 - Math.abs(t)) * 2.2 + rnd() * 0.7
    parts.push(part(
      new THREE.BoxGeometry(0.42, h, 2.4 + rnd() * 1.4),
      i % 2 === 0 ? ICE : ICE_DEEP,
      xf(t * 3.6 + (rnd() - 0.5) * 0.5, h * 0.38, (rnd() - 0.5) * 1.1,
        (rnd() - 0.5) * 0.5, 0, (0.34 + rnd() * 0.28) * (t < 0 ? 1 : -1)),
    ))
  }
  parts.push(part(new THREE.BoxGeometry(9.0, 0.5, 3.6), SNOW_SHADE, xf(0, 0.12, 0, 0.05)))
  return merge(parts)
}

/**
 * Hero prop 4 — frozen hull. A ship that came down here long before the
 * circuit did, half swallowed by the drift. The universe's one continuity
 * prop: the same shredded hull section that litters Rustfall, under snow.
 */
function propFrozenHull(p: Palette, seg: number): THREE.BufferGeometry {
  const parts = [
    part(
      new THREE.CylinderGeometry(5.6, 6.0, 13, seg + 4, 1, true, 0.55, 2.2),
      ROCK_LIT, xf(0, 3.1, 0, 0, Math.PI / 2, 0.16),
    ),
  ]
  for (let i = 0; i < 3; i++) {
    parts.push(part(
      new THREE.TorusGeometry(5.5, 0.28, 4, seg + 2, 2.0),
      ALLOY, xf(-4.4 + i * 4.4, 3.1, 0, Math.PI / 2, 0, 2.1),
    ))
  }
  // Buried nose and a torn plate still standing proud of the drift.
  parts.push(part(new THREE.BoxGeometry(2.0, 3.0, 0.45), ALLOY, xf(6.6, 1.9, 1.3, 0.3, 0, 0.4)))
  parts.push(part(new THREE.BoxGeometry(1.4, 2.2, 0.4), p.a, xf(-6.8, 1.5, -1.0, -0.4, 0, -0.3)))
  // The drift that has climbed over it. Wide and flat so it reads as burial.
  parts.push(part(new THREE.IcosahedronGeometry(6.6, 1), SNOW_SHADE,
    xf(0.4, -2.6, 0.2, 0.6, 0, 0, 1.5, 0.62, 1.15)))
  parts.push(part(new THREE.IcosahedronGeometry(3.2, 0), SNOW_HI,
    xf(-2.6, 1.5, 1.4, 1.1, 0, 0, 1.6, 0.34, 1.2)))
  return merge(parts)
}

/**
 * Hero prop 5 — cryo vent. Where the planet's heat still reaches the surface:
 * a rime cone with a lit throat. Small, but it is the only warm-adjacent light
 * out on the plain, so a handful of them do a lot of work at night.
 */
function propVent(p: Palette, seg: number): THREE.BufferGeometry {
  return merge([
    part(new THREE.CylinderGeometry(1.35, 3.9, 5.4, seg + 3, 1, true), ROCK, xf(0, 2.7, 0)),
    part(new THREE.CylinderGeometry(1.5, 1.9, 0.9, seg + 3, 1, true), SNOW_SHADE, xf(0, 5.3, 0)),
    // The throat. Emissive comes from the accent-tinted albedo plus bloom, not
    // from a light: fourteen point lights is not a budget, it is a bug.
    part(new THREE.CylinderGeometry(1.15, 1.15, 0.35, seg + 3, 1, false), p.accent, xf(0, 5.15, 0)),
    part(new THREE.CylinderGeometry(3.4, 4.4, 1.1, seg + 3, 1, false), SNOW_SHADE, xf(0, 0.5, 0)),
    // Rime plume, frozen mid-drift.
    part(new THREE.CylinderGeometry(2.4, 1.0, 6.0, seg + 2, 1, true), SNOW_HI,
      xf(0.6, 8.6, 0.2, 0, 0.12, 0.16)),
  ])
}

/**
 * Hero prop 6 — glacier fin. A blade of ice the katabatic wind has carved to
 * a knife edge, 20-40 m of it. The skyline element: tall, thin, and edge-lit
 * by a low sun, which is exactly what a wind-carved fin does in life.
 */
function propFin(p: Palette, seg: number): THREE.BufferGeometry {
  void p; void seg
  return merge([
    part(new THREE.BoxGeometry(2.6, 19, 8.5), ICE_DEEP, xf(0, 9.5, 0, 0, 0, 0.055)),
    part(new THREE.BoxGeometry(1.5, 8.5, 6.2), ICE, xf(-0.5, 21.5, 0.4, 0, 0, 0.13)),
    part(new THREE.BoxGeometry(0.7, 4.2, 3.6), SNOW_HI, xf(-1.2, 26.5, 0.6, 0, 0, 0.21)),
    // Skirt of calved blocks at the foot, so it does not read as a plank stuck
    // in the ground.
    part(new THREE.BoxGeometry(6.4, 2.6, 9.5), ICE_DEEP, xf(0.3, 1.3, 0, 0.25, 0, 0.04)),
    part(new THREE.BoxGeometry(8.6, 1.1, 11.0), SNOW_SHADE, xf(0, 0.35, 0, 0.4)),
  ])
}

/* --------------------------------------------------------- tube landmarks */

interface TubeOpts {
  /** Roll the arch with the ribbon's bank. A cave does not roll; a tube does. */
  banked: boolean
  /** Clearance between the arch springing and the protected corridor. */
  pad: number
  /** Crown height above the road, metres. Must clear the 5 m airspace band
   *  the environment fit test guards, with room for a racer under it. */
  crown: number
  /**
   * Height of the VERTICAL side wall before the arch starts to curve in.
   *
   * A pure semi-ellipse springing at `corridor + pad` is already inside the
   * corridor by the time it is four metres up — `hw * cos(th)` at a height of
   * 4 m on a 13.5 m crown is 0.95 of the half width, and 5% of a 23 m corridor
   * is more than the pad. The environment fit test caught exactly that, 0.16 m
   * into the road's airspace at the cavern mouth. So the section is a straight
   * wall to `spring` and an arch above it, which is also what a bored tunnel
   * actually looks like.
   */
  spring: number
  /** Shell thickness, metres. */
  thick: number
  /**
   * How far the side walls reach BELOW their springing, metres.
   *
   * A cavern is bored into rock and its walls run into the ground. A tunnel
   * 23 m up in the air over the cavern is a tube on a viaduct, and reaching
   * "down to the ground" from there means reaching down through somebody
   * else's road — which is precisely what the fit test measured, 10.5 m inside
   * the cavern's road at s=821 m. The banked case is worse than it looks: at 34
   * degrees the springing is already 15 m below the centreline before the foot
   * adds anything.
   */
  footDrop: number
  inner: number
  outer: number
  /** Sample stride: rings are cheap, but not free. */
  stride: number
  /** Emissive vein strips down the inner face: count and colour. */
  veins: number
  veinColor: number
  veinGain: number
}

/**
 * Sweep an arch shell over a run of the ribbon: a closed solid with an inner
 * face you drive through, an outer face you see from the plain, and an annular
 * cap at each mouth so the two never show a gap.
 *
 * Both the cavern and the ice tunnel are this function. They differ only in
 * whether the arch rolls with the bank, what it is made of, and how hard the
 * veins glow — which is the whole argument for a theme kit rather than two
 * hand-built landmarks.
 *
 * The springing points sit at `corridor(width) + pad`, so the shell follows the
 * ribbon at whatever width it is authored to and can never stand on the road.
 */
function buildTube(
  ctx: ThemeContext, iFrom: number, iTo: number, o: TubeOpts,
): { shell: THREE.BufferGeometry; veins: THREE.BufferGeometry | null } {
  const { track } = ctx
  const m = track.samples.length
  const span = ((iTo - iFrom) % m + m) % m
  const rings = Math.max(3, Math.floor(span / o.stride))
  const K = ctx.quality.tier === 'low' ? 7 : 10

  const pos: number[] = []
  const col: number[] = []
  const idx: number[] = []
  const vCol = new THREE.Color()
  const cInner = new THREE.Color().setHex(o.inner)
  const cOuter = new THREE.Color().setHex(o.outer)

  // Two shells: j in [0..K] inner, then [0..K] outer, per ring.
  const perRing = (K + 1) * 2
  for (let r = 0; r <= rings; r++) {
    const si = (iFrom + Math.round((r / rings) * span)) % m
    const smp = track.samples[si]
    const half = ctx.corridor(smp.width) + o.pad
    // Lateral and up axes. Banked rides the ribbon's own frame; unbanked keeps
    // the arch vertical over a rolling road, which is what a cave does.
    let ax = smp.right.x, ay = smp.right.y, az = smp.right.z
    let ux = smp.normal.x, uy = smp.normal.y, uz = smp.normal.z
    if (!o.banked) {
      const hl = Math.hypot(smp.right.x, smp.right.z) || 1
      ax = smp.right.x / hl; ay = 0; az = smp.right.z / hl
      ux = 0; uy = 1; uz = 0
    }
    // Foot of the wall: down to the graded ground, but never past footDrop.
    const gL = ctx.ground(smp.pos.x + ax * half, smp.pos.z + az * half).y
    const gR = ctx.ground(smp.pos.x - ax * half, smp.pos.z - az * half).y
    const drop = Math.min(o.footDrop, Math.max(1.2, smp.pos.y - Math.min(gL, gR) + 1.2))

    for (let s = 0; s < 2; s++) {
      const hw = half + (s === 1 ? o.thick : 0)
      const hh = o.crown + (s === 1 ? o.thick : 0)
      const sp = o.spring + (s === 1 ? o.thick : 0)
      for (let j = 0; j <= K; j++) {
        // j = 0 and j = K are the two feet, buried. Everything between is the
        // arch, springing from the top of the vertical side wall.
        const foot = j === 0 || j === K
        const th = (Math.min(K - 1, Math.max(1, j)) - 1) / (K - 2) * Math.PI
        const lx = Math.cos(th) * hw
        const ly = foot ? -drop : sp + Math.sin(th) * (hh - sp)
        pos.push(
          smp.pos.x + ax * lx + ux * ly,
          smp.pos.y + ay * lx + uy * ly,
          smp.pos.z + az * lx + uz * ly,
        )
        // Value falls off toward the crown: a cave roof is the darkest thing
        // in frame and that is what makes the ice read as light. The per-facet
        // jitter is what stops a swept shell reading as one smooth dark mass —
        // the material is flat-shaded, but a tube's facets all face nearly the
        // same way, so the lighting alone gives them almost no separation.
        const jit = 0.80 + 0.40 * ((Math.sin(r * 12.9898 + j * 78.233) * 43758.5453) % 1 + 1) % 1
        vCol.copy(s === 0 ? cInner : cOuter)
          .multiplyScalar((s === 0 ? 0.55 + 0.45 * (1 - Math.sin(th)) : 1) * jit)
        col.push(vCol.r, vCol.g, vCol.b)
      }
    }
  }

  for (let r = 0; r < rings; r++) {
    const a0 = r * perRing, b0 = (r + 1) * perRing
    for (let j = 0; j < K; j++) {
      // Inner face, wound so the visible side faces the road.
      idx.push(a0 + j, b0 + j, a0 + j + 1, a0 + j + 1, b0 + j, b0 + j + 1)
      // Outer face, wound the other way.
      const ao = a0 + K + 1, bo = b0 + K + 1
      idx.push(ao + j, ao + j + 1, bo + j, ao + j + 1, bo + j + 1, bo + j)
    }
  }
  // Mouth caps: the annulus between the two shells at each end.
  for (const [base, flip] of [[0, false], [rings * perRing, true]] as const) {
    for (let j = 0; j < K; j++) {
      const i0 = base + j, i1 = base + j + 1
      const o0 = base + K + 1 + j, o1 = base + K + 1 + j + 1
      if (flip) idx.push(i0, i1, o0, i1, o1, o0)
      else idx.push(i0, o0, i1, i1, o0, o1)
    }
  }

  const shell = new THREE.BufferGeometry()
  shell.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  shell.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3))
  shell.setIndex(pos.length / 3 > 65535
    ? new THREE.BufferAttribute(new Uint32Array(idx), 1)
    : new THREE.BufferAttribute(new Uint16Array(idx), 1))
  shell.computeVertexNormals()
  shell.computeBoundingSphere()

  /* ---- emissive ice veins running the length of the inner face ---------- */
  //
  // Unlit MeshBasicMaterial geometry, colour scaled past 1.0 so bloom picks it
  // up. Lighting an emissive strip costs a full standard-material shade for a
  // surface whose whole point is that it ignores the light rig.
  let veins: THREE.BufferGeometry | null = null
  if (o.veins > 0) {
    const vp: number[] = []
    const vc: number[] = []
    const vi: number[] = []
    const rnd = mulberry32(0x1cef10 ^ iFrom)
    const base = new THREE.Color().setHex(o.veinColor)
    for (let v = 0; v < o.veins; v++) {
      // Each vein wanders slowly around the arch as it runs down the tube.
      // Kept off the last 15% at each springing: a vein running down a wall a
      // racer can hit is a light with a car in it.
      const th0 = 0.15 + rnd() * 0.70
      const wob = 0.10 + rnd() * 0.16
      const ph = rnd() * 9
      // Half-angle of the strip, in radians. A vein is a CRACK with light in
      // it: at 0.06 they came out as 2 m painted ribbons across the ceiling,
      // wide enough that bloom fused them and the rock stopped reading black.
      const wide = 0.006 + rnd() * 0.013
      const start = vp.length / 3
      for (let r = 0; r <= rings; r++) {
        const si = (iFrom + Math.round((r / rings) * span)) % m
        const smp = track.samples[si]
        const half = ctx.corridor(smp.width) + o.pad
        let ax = smp.right.x, ay = smp.right.y, az = smp.right.z
        let ux = smp.normal.x, uy = smp.normal.y, uz = smp.normal.z
        if (!o.banked) {
          const hl = Math.hypot(smp.right.x, smp.right.z) || 1
          ax = smp.right.x / hl; ay = 0; az = smp.right.z / hl
          ux = 0; uy = 1; uz = 0
        }
        const th = Math.PI * (th0 + Math.sin(r * 0.22 + ph) * wob)
        // Pull just inside the shell so the strip cannot z-fight the rock, and
        // ride the same straight-wall-plus-arch section the shell uses.
        const hw = half - 0.10, hh = o.crown - 0.10, sp = o.spring - 0.10
        // Veins gutter out toward the mouths rather than stopping dead.
        const t = r / rings
        const fade = Math.min(1, Math.min(t, 1 - t) * 5.5)
        for (let e = -1; e <= 1; e += 2) {
          const thw = th + e * wide
          const lx = Math.cos(thw) * hw, ly = sp + Math.sin(thw) * (hh - sp)
          vp.push(
            smp.pos.x + ax * lx + ux * ly,
            smp.pos.y + ay * lx + uy * ly,
            smp.pos.z + az * lx + uz * ly,
          )
          // Brightness varies hard ALONG the vein — a crack with light in it is
        // bright where it is deep and dark where it pinches out, and a strip of
        // constant emission reads as a neon tube stuck to the ceiling.
        const g = o.veinGain * fade
          * (0.30 + 0.70 * Math.max(0, Math.sin(r * 0.9 + ph))
             * (0.55 + 0.45 * Math.sin(r * 0.31 + ph * 2.1)))
          vc.push(base.r * g, base.g * g, base.b * g)
        }
      }
      for (let r = 0; r < rings; r++) {
        const a = start + r * 2
        vi.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
      }
    }
    veins = new THREE.BufferGeometry()
    veins.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vp), 3))
    veins.setAttribute('color', new THREE.BufferAttribute(new Float32Array(vc), 3))
    veins.setIndex(new THREE.BufferAttribute(new Uint16Array(vi), 1))
    veins.computeBoundingSphere()
  }

  return { shell, veins }
}

/* -------------------------------------------------------- the crack ripple */

const CRACK_VERT = /* glsl */`
#include <fog_pars_vertex>
varying vec2 vUvp;
void main() {
  vUvp = (uv - 0.5) * 2.0;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`

const CRACK_FRAG = /* glsl */`
#include <fog_pars_fragment>
uniform vec3 uColor;
uniform float uProgress;
uniform float uFlash;
varying vec2 vUvp;

void main() {
  float r = length(vUvp);
  if (r > 1.0) discard;
  // A ring travelling outward on the ramp, plus a second one behind it.
  float lead = 1.0 - smoothstep(0.0, 0.16, abs(r - uProgress));
  float tail = 1.0 - smoothstep(0.0, 0.34, abs(r - uProgress * 0.62));
  // Radial fracture spokes, so the shelf breaks rather than glowing.
  float ang = atan(vUvp.y, vUvp.x);
  float spoke = pow(abs(sin(ang * 9.0 + sin(ang * 4.0) * 1.7)), 12.0);
  float a = (lead * (0.55 + 0.45 * spoke) + tail * 0.30 * spoke) * uFlash;
  a *= 1.0 - smoothstep(0.72, 1.0, r);
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor * (0.6 + 1.6 * a), a);
  // Additive, so fog has to REMOVE light rather than mix toward the fog
  // colour: three's fog_fragment would make the far side of the disc glow
  // brighter in a whiteout, which is the opposite of what fog does.
  #ifdef USE_FOG
    float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    gl_FragColor.rgb *= 1.0 - fogF;
    gl_FragColor.a *= 1.0 - fogF;
  #endif
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/* --------------------------------------------------------------- landmarks */

function landmarks(ctx: ThemeContext): void {
  const { track, quality, palette: pal } = ctx
  // Publish the track/spray pair for the VFX pass; see kit.ts.
  bindSurfaceSpray(track, SPRAY)
  const m = track.samples.length

  const iCavern = ctx.tagSample('cavern')
  const iCavernOut = ctx.tagSample('cavern-exit')
  const iTunnel = ctx.tagSample('tunnel')
  const iTunnelOut = ctx.tagSample('tunnel-exit')

  const veinMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: true, toneMapped: true })
  let veinUsed = false
  ctx.own(veinMat)

  /* ---- beat 3: the bioluminescent ice cavern --------------------------- */
  //
  // The showpiece. Near-black rock, a crown low enough to feel like rock over
  // your head, and the only light inside coming off the ice itself. The bounce
  // walls in here are shaded as glowing ice by the road material (see the
  // glacial branch in trackMesh.ts), so the cavern reads as one lit object
  // rather than a dark tube with a bright floor.
  if (iCavern >= 0 && iCavernOut >= 0) {
    const t = buildTube(ctx, iCavern, iCavernOut, {
      // Crown and thickness are held down by the ICE TUNNEL, which crosses 23 m
      // overhead near the cavern's exit and whose banked road hangs its low
      // edge to y=26. A 13.5 m crown on a 5.5 m shell put the cavern's roof
      // through it. 11 m of headroom is still a cavern.
      banked: false, pad: 1.6, crown: 11.0, spring: 5.8, thick: 2.4, footDrop: 8,
      inner: ROCK, outer: ROCK_LIT,
      // The low tier gets half the rings and a third of the veins. A cave is
      // carried by its VALUE — near-black rock, a few bright cracks — and none
      // of that needs ring density; it needs the phone to hold 60.
      stride: quality.tier === 'low' ? 11 : 5,
      veins: quality.tier === 'low' ? 5 : 16,
      // 0.85, not 2.6. A vein is a light SOURCE in a dark cave, which means it
      // has to be the brightest thing in frame — and "brightest in frame" in a
      // near-black cave is nowhere near "past the bloom threshold". At 2.6 the
      // bloom fused every vein into one sheet, the rock stopped reading as
      // black, and the racers went with it.
      veinColor: pal.accent, veinGain: 0.85,
    })
    const cave = new THREE.Mesh(t.shell, ctx.propMaterial)
    cave.name = 'landmark-cavern'
    cave.receiveShadow = quality.shadows
    cave.matrixAutoUpdate = false
    cave.updateMatrix()
    ctx.add(cave); ctx.own(t.shell)
    if (t.veins) {
      const v = new THREE.Mesh(t.veins, veinMat)
      v.name = 'cavern-veins'
      v.matrixAutoUpdate = false
      v.updateMatrix()
      ctx.add(v); ctx.own(t.veins)
      veinUsed = true
    }
    // Two cold point lights, a third and two thirds of the way in, so a racer
    // is actually LIT by the cave instead of driving through a painting of one.
    if (quality.tier !== 'low') {
      const span = ((iCavernOut - iCavern) % m + m) % m
      for (const f of [0.33, 0.72]) {
        const smp = track.samples[(iCavern + Math.round(span * f)) % m]
        // Enough to put a cold rim on a car and a pool on the road, and not
        // one lumen more: this is a fill for the emissive walls, not a lamp.
        const light = new THREE.PointLight(pal.accent, 260, 95, 2)
        light.position.set(smp.pos.x, smp.pos.y + 7.5, smp.pos.z)
        ctx.add(light)
      }
    }
  }

  /* ---- beat 6: the ice tunnel loop ------------------------------------- */
  //
  // Banked, because the tunnel IS the corner: the GDD asks for a tube rather
  // than a bend, and rolling the arch with the 34-degree ribbon is what turns
  // one into the other. Ice rather than rock, and dimmer veins, so it does not
  // compete with the cavern three beats earlier.
  if (iTunnel >= 0 && iTunnelOut >= 0) {
    const t = buildTube(ctx, iTunnel, iTunnelOut, {
      banked: true, pad: 1.2, crown: 11.0, spring: 5.8, thick: 2.4, footDrop: 1.5,
      // Ice, and a full stop lighter than the cavern's rock. The cavern is a
      // hole in a mountain and is allowed to be black; a tube of ice with a
      // sky outside it is not, and at ICE_DEEP it read as a formless void with
      // a barrier floating in it.
      inner: ICE, outer: SNOW_SHADE,
      stride: quality.tier === 'low' ? 9 : 4,
      veins: quality.tier === 'low' ? 4 : 14,
      veinColor: 0x8fe4ff, veinGain: 0.80,
    })
    const tube = new THREE.Mesh(t.shell, ctx.propMaterial)
    tube.name = 'landmark-ice-tunnel'
    tube.receiveShadow = quality.shadows
    tube.matrixAutoUpdate = false
    tube.updateMatrix()
    ctx.add(tube); ctx.own(t.shell)
    if (t.veins) {
      const v = new THREE.Mesh(t.veins, veinMat)
      v.name = 'tunnel-veins'
      v.matrixAutoUpdate = false
      v.updateMatrix()
      ctx.add(v); ctx.own(t.veins)
      veinUsed = true
    }
  }
  if (!veinUsed) veinMat.dispose()

  /* ---- beat 8: blizzard marker poles ----------------------------------- */
  //
  // What you actually navigate a whiteout by. The chevron chain on the road
  // gives the line; the poles give the EDGES, which is the information a
  // driver loses first when the fog closes to 60 m. Spaced at 26 m so that at
  // racing speed there are always two in sight and they tick past fast enough
  // to carry speed — the same job Rustfall's wall lamps do, moved off a
  // barrier you can no longer see.
  //
  // They stand on every sample carrying wind, so the run arrives and leaves
  // with the crosswind rather than with an authored start and end.
  {
    const poleParts: THREE.BufferGeometry[] = []
    const res = track.length / m
    const step = Math.max(2, Math.round(26 / res))
    for (let i = 0; i < m; i += step) {
      const smp = track.samples[i]
      if (smp.wind <= 0.5 || smp.open) continue
      const w = Math.min(1, smp.wind / 5.5)
      const hl = Math.hypot(smp.tangent.x, smp.tangent.z) || 1
      const ox = smp.tangent.z / hl, oz = -smp.tangent.x / hl
      const lat = ctx.corridor(smp.width) + 2.4
      for (const side of [-1, 1]) {
        const px = smp.pos.x + ox * side * lat
        const pz = smp.pos.z + oz * side * lat
        const gy = ctx.ground(px, pz).y
        const h = 6.2
        const yaw = Math.atan2(smp.tangent.x, smp.tangent.z)
        poleParts.push(part(new THREE.BoxGeometry(0.26, h, 0.26), ALLOY,
          xf(px, gy + h / 2, pz, yaw)))
        // Reflective sleeve, then the lamp head. Both ride the wind strength,
        // so the chain literally brightens into the band.
        poleParts.push(part(new THREE.BoxGeometry(0.36, 0.9, 0.36), pal.b,
          xf(px, gy + h - 1.5, pz, yaw)))
        poleParts.push(part(new THREE.BoxGeometry(0.55, 0.42, 0.34),
          w > 0.55 ? pal.b : ALLOY, xf(px, gy + h + 0.3, pz, yaw)))
        poleParts.push(part(new THREE.BoxGeometry(0.9, 0.22, 0.24), pal.accent,
          xf(px, gy + h - 0.55, pz, yaw, 0, 0)))
      }
    }
    if (poleParts.length > 0) {
      const geo = merge(poleParts)
      const poles = new THREE.Mesh(geo, ctx.propMaterial)
      poles.name = 'landmark-blizzard-poles'
      poles.castShadow = quality.shadows
      poles.matrixAutoUpdate = false
      poles.updateMatrix()
      ctx.add(poles); ctx.own(geo)
    }
  }

  /* ---- beat 2: the shelf giving way ------------------------------------ */
  //
  // The barrier falling and the road turning to bare ice are geometry, and
  // they live in trackMesh.ts where the barrier is. What lives HERE is the
  // moment: a fracture ripple that runs out across the pan from under the
  // leader, so the event has a centre and a direction and is not just a
  // property of the road quietly changing while you look at it.
  //
  // One additive disc, drawn only while `crack` is ramping, and culled to
  // nothing the rest of the race.
  {
    let iA = -1, iB = -1
    for (let i = 0; i < m; i++) {
      if (!track.samples[i].fragile) continue
      if (iA < 0) iA = i
      iB = i
    }
    if (iA >= 0) {
      const mid = track.samples[(iA + Math.round((iB - iA) * 0.5)) % m]
      const R = 190
      const geo = new THREE.CircleGeometry(R, 40)
      geo.rotateX(-Math.PI / 2)
      const mat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, fog: true,
        blending: THREE.AdditiveBlending,
        // A ShaderMaterial declaring `fog: true` must carry the fog uniforms
        // itself; three's fog refresh writes straight into them and throws on
        // a material that asked for fog and did not supply them.
        uniforms: {
          ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
          uColor: { value: new THREE.Color(0.62, 0.92, 1.0) },
          uProgress: { value: 0 },
          uFlash: { value: 0 },
        },
        vertexShader: CRACK_VERT,
        fragmentShader: CRACK_FRAG,
      })
      const ripple = new THREE.Mesh(geo, mat)
      ripple.name = 'crack-ripple'
      // Just clear of the ice so it never z-fights the pan it is painted on.
      ripple.position.set(mid.pos.x, mid.pos.y - 0.55, mid.pos.z)
      ripple.matrixAutoUpdate = false
      ripple.updateMatrix()
      ripple.renderOrder = 4
      ripple.visible = false
      ctx.add(ripple); ctx.own(geo); ctx.own(mat)

      const uProg = mat.uniforms.uProgress as { value: number }
      const uFlash = mat.uniforms.uFlash as { value: number }
      ctx.onUpdate((f: FrameInfo) => {
        // `crack` ramps 0 -> 1 over the collapse. The ripple leads it and dies
        // well before the ramp finishes, so what is left afterwards is the
        // changed road, not a permanent decal.
        const on = f.crack > 0.001 && f.crack < 0.92
        ripple.visible = on
        if (!on) return
        uProg.value = Math.min(1.05, f.crack * 1.35)
        uFlash.value = Math.min(1, f.crack * 6) * (1 - Math.max(0, (f.crack - 0.45) / 0.47))
      })
    }
  }
}

/* ------------------------------------------------------------------ theme */

const _rock = new THREE.Color()
const _snow = new THREE.Color()
const _ice = new THREE.Color()
const _crest = new THREE.Color(0.74, 0.83, 0.90)
const _pan = new THREE.Color()

export const CRYOSTATIC_THEME: Theme = {
  id: 'cryostatic',

  props(pal, seg) {
    return [
      {
        name: 'erratic', geo: propErratic(pal, seg), count: 190,
        radius: 2.3, gap: 1.8, spread: 70, scale: [0.7, 1.9],
        // The moraine is, by definition, the pile of rock the glacier dropped.
        cluster: { tag: 'switchback-1', span: 260, share: 0.40 },
      },
      {
        name: 'serac', geo: propSerac(pal, seg), count: 120,
        radius: 2.9, gap: 3.2, spread: 145, scale: [0.8, 1.9],
        // Seracs frame the descent off the glacier, which is the first thing
        // a player sees on this track.
        cluster: { tag: 'start', span: 300, share: 0.30 },
      },
      {
        name: 'pressure-ridge', geo: propRidge(pal, seg), count: 92,
        // 9 m of plates on a 3.6 m pad: the plan half-diagonal is 4.8.
        radius: 4.9, gap: 2.4, spread: 130, scale: [0.8, 1.6],
        // Buckled sheet is what a frozen lake's margin actually looks like.
        cluster: { tag: 'lake-entry', span: 420, share: 0.36 },
      },
      {
        name: 'frozen-hull', geo: propFrozenHull(pal, seg), count: 26,
        // 13 m barrel, the drift over it, and the plate off the nose: 9.9 x 8.
        radius: 9.9, gap: 6, spread: 240, scale: [0.9, 2.0],
      },
      {
        name: 'cryo-vent', geo: propVent(pal, seg), count: 20,
        // 4.4 m base cone; the plume leans 0.6 m off centre at the top.
        radius: 5.0, gap: 9, spread: 200, scale: [0.9, 1.9],
        cluster: { tag: 'floe-landing', span: 260, share: 0.34 },
      },
      {
        name: 'glacier-fin', geo: propFin(pal, seg), count: 22,
        // 11 m of calved skirt in plan, and 30 m of blade over it.
        radius: 7.2, gap: 22, spread: 300, scale: [0.9, 2.3],
        // Fins on the skyline over the chasm: something to fly at.
        cluster: { tag: 'ramp-chasm', span: 300, share: 0.42 },
      },
    ] satisfies PropSpec[]
  },

  landmarks,

  /**
   * The tundra floor.
   *
   * Snow that has been walked on all week, not snow in a brochure: a mid
   * blue-grey base, dark rock showing through wherever the macro noise digs a
   * hollow, and a colder, brighter crust only on the ridges the key light
   * actually reaches. The near-track band is deliberately the DARKEST part of
   * the field — the verge is in the barrier's shadow — which gives the road a
   * value edge to sit inside instead of dissolving into the plain.
   */
  terrainColor(out, p: TerrainPoint, _pal) {
    void _pal
    _rock.setHex(ROCK); _snow.setHex(SNOW); _ice.setHex(ICE_DEEP)
    // Rock through the hollows; snow over everything else.
    out.copy(_rock).lerp(_snow, 0.30 + 0.70 * Math.min(1, p.macro * 1.25))
    // Wind-scoured ice on the exposed crests.
    out.lerp(_ice, Math.max(0, p.mid - 0.62) * 0.75)
    // The crest highlight. Small, and the only place the floor goes pale.
    out.lerp(_crest, p.ridge * 0.22 * p.mid)
    // Verge darkest, plain lighter: the road gets a value edge to sit inside
    // rather than dissolving into the plain.
    const near = Math.min(1, Math.max(0, p.edge) / 46)
    out.multiplyScalar(0.52 + 0.34 * near + 0.14 * p.grit + 0.16 * p.mid)

    // THE FROZEN LAKE. Everywhere within ~150 m of the fragile shelf the
    // relief noise is overridden by a flat, dark, faintly-mottled pan, so the
    // sweeper reads as a sheet of ice on standing water rather than as more
    // snowfield. The terrain does not know what a lake is; it knows how far it
    // is from the part of the ribbon that can give way, which is the same
    // thing and needs no second authoring pass.
    if (p.shelf < 210) {
      const t = 1 - Math.min(1, Math.max(0, (p.shelf - 60) / 150))
      _pan.setHex(ICE_DEEP).multiplyScalar(0.72 + 0.5 * p.grit + 0.34 * Math.max(0, p.mid - 0.55))
      out.lerp(_pan, t * t * 0.86)
    }
  },
  // Snow is not shiny and ice is not metal. The sheen on this planet comes
  // from the road shader's fresnel, where it can be controlled.
  terrainMaterial: { roughness: 0.94, metalness: 0.0 },
  // Grades onto the fog earlier than Rustfall: the air here is thick, and the
  // sooner the floor joins the fog the more the fog reads as a volume.
  terrainFade: [80, 460],
  propMaterial: { roughness: 0.82, metalness: 0.04 },

  /**
   * Driving snow. Falls, drifts, and shears into streaks inside the blizzard
   * band — the same particle system doing three jobs off one wind number.
   */
  motes: {
    count: 1500, box: 130, size: [1.1, 4.4], pixel: 74, maxPixels: 15,
    alpha: 0.26, fall: 3.4, streak: 1,
    color: (_pal, fog) => new THREE.Color(0.90, 0.95, 1.0).lerp(fog, 0.44),
  },

  /**
   * SPINDRIFT, AND DELIBERATELY NOT A SECOND SNOW SYSTEM.
   *
   * This planet already has driving snow: `motes` above falls at 3.4 m/s and
   * shears into streaks inside the blizzard band. What it does NOT do is say
   * which way. The mote shader rotates its sprites to a fixed ~25 degrees in
   * SCREEN space and thins them across it — a beautiful blizzard, and a
   * blizzard that looks identical whether the air is pushing you left or
   * right. So this layer is not more snow, it is the other phenomenon: loose
   * surface snow picked up off the pack and driven ACROSS the road.
   *
   * Sparse, long and very faint, because the frame here is already the
   * fullest of the four circuits and Cryostatic's crosswind is the mildest on
   * the roster (7 m/s^2 authored, measured at 4% of a half-width of
   * displacement over a lap, against Aetherion's 130%). It should read as a
   * texture on the storm, not as a second storm.
   */
  debris: {
    count: 340, box: 76, length: 6.4, width: 0.20, alpha: 0.26, fall: 0.5,
    color: (_pal, fog) => new THREE.Color(0.93, 0.96, 1.0).lerp(fog, 0.5),
  },

  sky: {
    band: 'aurora',
    auroraLow: 0x36ffa2,
    auroraHigh: 0x3f6bff,
    auroraGain: 0.75,
    // A cold band at the skyline, under the aurora rather than competing with
    // it: the aurora owns the sky from 0.02 up, so this sits below it and
    // reads as light scattering off the ice pan rather than as more curtain.
    horizonColor: 0x7fc6ff,
    horizonSpan: [0.035, 0.22],
    horizonGain: 0.42,
    /**
     * A SHATTERED MOON, AND THE REASON THE AURORA IS THERE.
     *
     * The moon broke and its debris is still coming down -- which is a
     * one-image explanation for a planet that is frozen, magnetically
     * hammered, and lit by curtains. It sits HIGH and opposite the aurora's
     * brightest band so the two do not fight: the aurora owns the low sky
     * between d.y 0.02 and 0.55, and the moon is above it.
     *
     * Cold and heavily mottled, with the terminator soft -- this far out the
     * key is weak and a hard day/night line would read as a cue ball.
     */
    celestial: {
      gain: 0.85,
      bodies: [{
        // BRIGHTER than the sky rather than the same value as it. Against an
        // aurora and a haze this pale, a realistic dirty-grey moon is a
        // smudge; the contrast has to come from somewhere and up is the only
        // direction left.
        // Down onto the skyline and much bigger: the moon that broke is the
        // reason this planet is the way it is, and it was sitting 44 degrees
        // up where a driver never looks.
        // ANTI-SOLAR, and on this track that is worth more than composition:
        // the moon used to sit 20 degrees off the key, inside its glare and
        // lit from behind, and rendered as a ghost you had to be told was
        // there. Opposite the key it is 95% lit -- a full moon over a
        // blizzard, which is the one thing bright enough to survive this
        // planet's fog.
        dir: [-0.675, 0.075, 0.734],
        sizeDeg: 17,
        // Pulled DOWN off white. At 0xf4f9ff the bloom pass ate the mottling
        // and the moon rendered as a blank disc; a moon that is merely much
        // brighter than the fog still reads as the brightest thing on this
        // planet, and keeps its maria.
        color: 0xdde9f6,
        mottle: 0.72,
        shade: 0.82,
        limb: 0.20,
      }],
      belt: {
        // The debris still lies in the plane the moon broke in, so the belt
        // runs through the body rather than around the planet -- and with the
        // moon on the skyline the belt now rises out of it, which is the whole
        // picture: the thing that shattered, and the trail still coming down.
        /**
         * SOLVED, not eyeballed: the band is the set of directions whose dot
         * with this axis equals sin(tiltDeg), so "runs through the moon"
         * means dot(axis, moonDir) == sin(3 deg) and nothing else. The old
         * axis gave -0.096 against a half-width of 0.042 -- the belt missed
         * the body by eight degrees and the frame showed a moon with no
         * debris anywhere near it.
         */
        axis: [0.622, 0.513, 0.591],
        tiltDeg: 3,
        // Wider, denser and brighter than the first pass. The belt is drawn
        // ADDITIVELY, so against a sky this pale it has to be substantial to
        // register at all -- at 2.4 degrees and 0.30 density it was a handful
        // of specks above the moon and nothing a player would notice.
        widthDeg: 3.6,
        color: 0xdce9f7,
        density: 0.55,
        driftDeg: 0.30,
        gain: 1.35,
      },
    },
  },

  /**
   * The hero effect, done for one draw call: eight enormous, almost invisible
   * sprites drifting with the camera through the exponential fog. Real
   * volumetrics would be a raymarch; this is what a raymarch looks like from
   * inside a car doing 70 m/s, and it costs a tenth of a millisecond.
   */
  fogBanks: {
    count: 9, size: 105, alpha: 0.052, low: -8, high: 26,
    // A shade off the fog itself, and NOT tinted with the sodium channel:
    // b is warm amber on this planet and a warm fog bank on an ice world
    // reads as a bug in the tone mapper.
    color: (_pal, fog) => fog.clone().lerp(new THREE.Color(0.80, 0.88, 0.95), 0.34),
  },

  /**
   * The blizzard. Density is the whole mechanic: at 0.0165 the world closes to
   * about 60 m, which is roughly one second of warning at racing speed, and
   * the boost chevrons — which are emissive and therefore fogged like anything
   * else — swim up out of it one at a time. The fog COLOUR only goes to a mid
   * value, never to white: a whiteout the racers silhouette against is drama,
   * and a whiteout they dissolve into is a bug.
   */
  weather: {
    windFull: 7.0,
    fogColor: 0x7d95a6,
    fogDensity: 0.0165,
    sunScale: 0.34,
    moteGain: 1.7,
  },

  road: 'glacial',
  spray: SPRAY,
}
