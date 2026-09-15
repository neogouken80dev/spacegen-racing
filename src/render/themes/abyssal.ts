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
 * The leviathans are drawn by the celestial `ships` layer, and that is not a
 * hack: `ships` is specified as silhouettes with running lights, which is
 * precisely what a large bioluminescent animal at 400m in turbid water looks
 * like. They cost no draw calls, cannot be driven past or clipped into, and
 * hold station with a slow drift. A modelled whale would need to be
 * camera-locked, kept inside the far plane, excluded from fog and sorted
 * against the terrain shell -- four ways to get a seam, for an animal the
 * player sees for two seconds at a time.
 *
 * Beats and what each one gets:
 *   1  shelf apron        tube ribs, service gantries, the light shafts
 *   2  bloom A            beacons, coral banks, the first slick corner
 *   3  the trench jump    a broken span, wreckage on the floor below
 *   4  the Cathedral      the loop: a dome, lit from its own ring
 *   5  the Descent        two turns of corkscrew down the trench wall
 *   6  the Breach         cracked glass, a current, and the murk coming in
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
  // Short. Turbid water is the whole reason the leviathans read as silhouettes
  // rather than as models, and a crisp far distance would undo that.
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
        // THE LEVIATHANS. `ships` is silhouettes with running lights, which is
        // what a large bioluminescent animal at range actually looks like. Three
        // of them, holding station off to one side, drifting slowly enough that
        // you are never sure they moved.
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
