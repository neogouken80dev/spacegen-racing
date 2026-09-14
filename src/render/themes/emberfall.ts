/**
 * ASHKAR — volcanic shield planet.
 *
 * ---------------------------------------------------------------------------
 * THE VALUE PROBLEM ON A PLANET MADE OF LIGHT.
 *
 * GDD 09: "Track environments sit in the mid-to-dark band so vehicles and VFX
 * always pop. If a track section washes out the racers, the track is wrong."
 * Cryostatic's header records how an ice planet breaks that rule by being
 * bright. A lava planet breaks it the other way and worse, because lava is
 * EMISSIVE: it is not merely pale, it survives the bloom threshold and blooms,
 * and the first grey-box had glowing ground over a third of the frame with the
 * racers reduced to silhouettes crossing it.
 *
 * The answer is that this planet is almost entirely COLD. It is basalt, ash and
 * obsidian -- albedos from 0.06 to 0.34, darker on average than any other
 * circuit in the game -- and the lava is a THIN, RARE, BRIGHT line threaded
 * through it: fissures a couple of metres wide, the glow inside a vent, the
 * underside of the ash cloud. Emissive area is the budget, not emissive
 * brightness, and the budget is small.
 *
 * That inversion is also what makes the planet read as a volcano rather than as
 * an orange room. A lava field photographs as black rock with cracks of light
 * in it; the light is shocking precisely because there is so little of it.
 *
 * Concretely: every albedo below sits between 0x14 and 0x6e on its brightest
 * channel. The palest chassis in the game (Filament, 0xdfe6ee) is 0.88. The
 * three things allowed to be bright are the fissure lines, the sky's horizon
 * band, and the ember motes.
 *
 * ---------------------------------------------------------------------------
 * THE HERO SKY.
 *
 * The planet the shield is a moon OF -- a banded gas giant with a ring system,
 * sitting low and enormous on the horizon behind the caldera. It is the reason
 * the sky is lit at all on the night side of the track, it gives the horizon
 * band something to be, and it is drawn in the dome's fragment shader for zero
 * draw calls and zero depth work (see the Celestial block in kit.ts).
 *
 * Beats and what each one gets:
 *   1  start / basalt apron   flow ridges, cooled pillow lava, vent gantries
 *   2  the fissure jump       a lit crack under the ramp, spatter cones beyond
 *   3  the ash beds           dune fields, standing dead spires, drifting ash
 *   4  the Lava Tube          the loop: a basalt tube with a molten seam
 *   5  the Corkscrew          a lava tube bored through the shield, lit inside
 *   6  the caldera rim        the updraft: ash streamers and the gas giant
 */
import * as THREE from 'three'
import {
  bindSurfaceSpray, merge, mulberry32, part, xf,
  type FrameInfo, type Palette, type PropSpec, type SurfaceSprayTable,
  type TerrainPoint, type Theme, type ThemeContext,
} from './kit'

/* ------------------------------------------------------------- the values */

/** Cold basalt. The darkest ground in the game, and most of the frame. */
const BASALT = 0x1c1614
const BASALT_LIT = 0x342825
/** Weathered scoria — the red-brown that says "oxidised" without saying "hot". */
const SCORIA = 0x5c3320
/** Ash. A mid warm grey; the only genuinely light ground, and it is still 0.34. */
const ASH = 0x574b45
const ASH_LO = 0x392f2b
/** Obsidian: near-black with a hard specular. Used for edges, never for fields. */
const OBSIDIAN = 0x14101a
/** The three bright things. */
const LAVA = 0xff5a10
const LAVA_CORE = 0xffa848
const EMBER = 0xff8a3c

/* ------------------------------------------------------------------ props */

/** A basalt column cluster: hexagonal jointing, the signature of a cooled flow. */
function propColumns(pal: Palette, seg: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const rnd = mulberry32(0x10ba51)
  for (let i = 0; i < 7; i++) {
    const h = 5 + rnd() * 13
    const r = 1.0 + rnd() * 0.8
    const a = rnd() * Math.PI * 2
    const d = rnd() * 3.4
    parts.push(part(
      new THREE.CylinderGeometry(r * 0.92, r, h, 6, 1),
      i % 3 === 0 ? BASALT_LIT : BASALT,
      xf(Math.cos(a) * d, h / 2, Math.sin(a) * d, rnd() * Math.PI, (rnd() - 0.5) * 0.10, 0),
    ))
  }
  void pal; void seg
  return merge(parts)
}

/** A spatter cone: a squat vent with a lit throat. */
function propVent(pal: Palette, seg: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  parts.push(part(new THREE.ConeGeometry(4.6, 6.2, Math.max(7, seg >> 1), 1, true), SCORIA, xf(0, 3.1, 0)))
  parts.push(part(new THREE.ConeGeometry(3.1, 4.0, Math.max(6, seg >> 2), 1, true), BASALT, xf(0, 4.6, 0)))
  // The throat. Small, and the only emissive geometry in the scatter.
  parts.push(part(new THREE.CylinderGeometry(1.5, 1.9, 0.5, Math.max(6, seg >> 2)), LAVA, xf(0, 6.0, 0)))
  void pal
  return merge(parts)
}

/** A standing spire — a lava plug left when the cone around it eroded away. */
function propSpire(pal: Palette, seg: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const rnd = mulberry32(0x5915e)
  let y = 0
  for (let i = 0; i < 5; i++) {
    const h = 4.5 + rnd() * 5
    const r = 2.6 - i * 0.42
    parts.push(part(
      new THREE.CylinderGeometry(r * 0.8, r, h, Math.max(5, seg >> 2), 1),
      i > 2 ? OBSIDIAN : BASALT,
      xf((rnd() - 0.5) * 1.1, y + h / 2, (rnd() - 0.5) * 1.1, rnd() * 2, (rnd() - 0.5) * 0.06, 0),
    ))
    y += h * 0.92
  }
  void pal
  return merge(parts)
}

/** Obsidian shards: low, sharp, catches the key. Breaks up the ash flats. */
function propShards(pal: Palette, seg: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const rnd = mulberry32(0x0b51d1)
  for (let i = 0; i < 9; i++) {
    const h = 1.6 + rnd() * 4.4
    const a = rnd() * Math.PI * 2
    const d = rnd() * 5
    parts.push(part(
      new THREE.ConeGeometry(0.5 + rnd() * 0.8, h, 4, 1),
      rnd() < 0.3 ? SCORIA : OBSIDIAN,
      xf(Math.cos(a) * d, h / 2, Math.sin(a) * d, rnd() * 3, (rnd() - 0.5) * 0.5, (rnd() - 0.5) * 0.5),
    ))
  }
  void pal; void seg
  return merge(parts)
}

/** A collapsed lava tube: a broken basalt arch you can see daylight through. */
function propArch(pal: Palette, seg: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const R = 11, T = 2.4
  const s = Math.max(7, seg >> 1)
  // Two thirds of a torus, cut so it reads as fallen-in rather than built.
  parts.push(part(new THREE.TorusGeometry(R, T, 5, s, Math.PI * 1.15), BASALT, xf(0, 0, 0, 0, 0, -0.18)))
  parts.push(part(new THREE.CylinderGeometry(T * 1.2, T * 1.5, 5, 6), BASALT_LIT, xf(-R, 2, 0)))
  void pal
  return merge(parts)
}

/* -------------------------------------------------------------- landmarks */

function landmarks(ctx: ThemeContext): void {
  const { track, palette: pal, quality } = ctx
  bindSurfaceSpray(track, SPRAY)
  const m = track.samples.length

  /* ---- THE CALDERA. The landmark the whole planet is named for: a cinder
   * cone on the skyline, venting, placed off the outside of the ash beds where
   * it sits in frame through the longest corner on the lap.
   *
   * It is ONE merged mesh at a fixed spot rather than an instanced prop,
   * because its whole job is to be in a particular place relative to a
   * particular corner. A cone that wanders is scenery; a cone you can brake
   * against is a landmark. ---- */
  const iAsh = ctx.tagSample('ashbeds')
  if (iAsh >= 0) {
    const smp = track.samples[iAsh]
    const tl = Math.hypot(smp.tangent.x, smp.tangent.z) || 1
    const ox = smp.tangent.z / tl, oz = -smp.tangent.x / tl
    const D = 420
    const cx = smp.pos.x + ox * D, cz = smp.pos.z + oz * D
    const g = ctx.ground(cx, cz)
    const parts: THREE.BufferGeometry[] = []
    const s = Math.max(9, ctx.seg)
    parts.push(part(new THREE.ConeGeometry(210, 190, s, 2, true), BASALT, xf(0, 95, 0)))
    parts.push(part(new THREE.ConeGeometry(96, 70, s, 1, true), SCORIA, xf(0, 205, 0)))
    // The vent: a shallow bowl of light, small against a 190m cone.
    parts.push(part(new THREE.CylinderGeometry(54, 42, 6, s), LAVA, xf(0, 228, 0)))
    // A smaller, hotter disc inside the vent. Two emissive values read as depth
    // where one reads as a painted circle.
    parts.push(part(new THREE.CylinderGeometry(26, 20, 4, s), LAVA_CORE, xf(0, 231, 0)))
    const geo = merge(parts)
    ctx.own(geo)
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.94, metalness: 0.04 })
    ctx.own(mat)
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.set(cx, g.y - 12, cz)
    mesh.frustumCulled = true
    ctx.add(mesh)

    /* ---- The eruption plume. Six big soft sprites stacked over the vent,
     * drifting with the wind. This is the same trick as Cryostatic's fog banks
     * -- one draw call pretending to be a participating medium -- but anchored
     * to the world rather than to the camera, because a plume that follows you
     * is not a landmark. ---- */
    const tex = plumeTexture()
    ctx.own(tex as unknown as THREE.Material)
    const pm = new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false,
      color: new THREE.Color(0x6a5a55), opacity: 0.40, fog: true,
    })
    ctx.own(pm)
    const plume = new THREE.Group()
    const puffs: THREE.Sprite[] = []
    for (let i = 0; i < 7; i++) {
      const sp = new THREE.Sprite(pm)
      const t = i / 6
      sp.position.set(0, 250 + t * 420, 0)
      const sc = 190 + t * 520
      sp.scale.set(sc, sc, 1)
      plume.add(sp)
      puffs.push(sp)
    }
    plume.position.set(cx, g.y - 12, cz)
    ctx.add(plume)
    // Rise and recycle. No allocation, and the phase is per-sprite so the
    // column churns instead of pulsing as one object.
    ctx.onUpdate((f: FrameInfo) => {
      for (let i = 0; i < puffs.length; i++) {
        const sp = puffs[i]
        let y = sp.position.y + f.dt * 11
        if (y > 700) y = 250
        sp.position.y = y
        const t = (y - 250) / 450
        const sc = 190 + t * 520
        sp.scale.set(sc, sc, 1)
        sp.position.x = Math.sin(f.time * 0.11 + i) * (24 + t * 130)
      }
    })
  }

  /* ---- THE MOLTEN SEAM, and why the loop needs one at all.
   *
   * Photographed at the apex, the Lava Tube came out very nearly black. The
   * corkscrew did not, and the difference is instructive: the corkscrew carries
   * a boost strip through its middle, and the emissive chevrons light the whole
   * bore from the inside. The loop has no strip -- it must not, because a
   * geodesic set piece that also hands out speed is a gift with no bill -- so
   * it had nothing lighting it at all. A headline set piece the player cannot
   * see is not a set piece.
   *
   * So the tube gets a seam of its own: a ring of molten rock concentric with
   * the loop and just outside the corridor, plus two warm point lights inside
   * the bore. The ring is emissive and does no lighting work by itself (that is
   * what the bloom pass sees); the two lights are what actually puts the road
   * surface back in the frame. Geometry derived from the two tags rather than
   * from the track's own constants -- the art layer reads content, never
   * imports it. ---- */
  const iTube = ctx.tagSample('lavatube')
  const iApex = ctx.tagSample('lavatube-apex')
  if (iTube >= 0 && iApex >= 0) {
    const a = track.samples[iTube], b = track.samples[iApex]
    const loopR = Math.max(8, (b.pos.y - a.pos.y) / 2)
    const cx = (a.pos.x + b.pos.x) / 2, cy = (a.pos.y + b.pos.y) / 2, cz = (a.pos.z + b.pos.z) / 2
    const tl = Math.hypot(a.tangent.x, a.tangent.z) || 1
    const fx = a.tangent.x / tl, fz = a.tangent.z / tl
    const seg = Math.max(16, ctx.seg * 2)
    const ringGeo = new THREE.TorusGeometry(loopR + ctx.corridor(a.width) + 3.5, 1.1, 5, seg)
    ctx.own(ringGeo)
    const ringMat = new THREE.MeshBasicMaterial({ color: LAVA, fog: true })
    ctx.own(ringMat)
    const ring = new THREE.Mesh(ringGeo, ringMat)
    ring.position.set(cx, cy, cz)
    // The torus lies in its own XY plane; stand it up and swing it to face
    // along the road, so it is concentric with the loop rather than crossing it.
    ring.rotation.y = Math.atan2(fx, fz) + Math.PI / 2
    ctx.add(ring)

    if (quality.tier !== 'low') {
      for (const k of [-1, 1]) {
        const L = new THREE.PointLight(0xff7a2a, 2.1, loopR * 3.4, 1.7)
        L.position.set(cx + fx * k * loopR * 0.55, cy, cz + fz * k * loopR * 0.55)
        ctx.add(L)
      }
    }
    // A slow breath on the seam, so the tube is alive rather than a lit prop.
    ctx.onUpdate((f: FrameInfo) => {
      const g = 0.82 + 0.18 * Math.sin(f.time * 0.9)
      ringMat.color.setHex(LAVA).multiplyScalar(g)
    })
  }

  void pal; void m
}

/** A soft radial blob, built once. The plume and nothing else uses it. */
function plumeTexture(): THREE.Texture {
  const N = 64
  const data = new Uint8Array(N * N * 4)
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = (x + 0.5) / N - 0.5, dy = (y + 0.5) / N - 0.5
      const d = Math.min(1, Math.hypot(dx, dy) * 2)
      const a = Math.pow(1 - d, 2.4)
      const i = (y * N + x) * 4
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255
      data[i + 3] = Math.round(a * 255)
    }
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat)
  t.needsUpdate = true
  return t
}

/* ---------------------------------------------------------------- terrain */

const _c = new THREE.Color()

/**
 * The ground. Basalt everywhere, ash where the macro noise says a bed has
 * drifted, and a THIN fissure line where two noise bands cross -- that last one
 * is the entire emissive budget of the terrain and it covers about 2% of it.
 */
function terrainColor(out: THREE.Color, p: TerrainPoint, pal: Palette): void {
  // Base: basalt, lifted toward scoria on the high ridges where the key rakes.
  out.set(BASALT).lerp(_c.set(BASALT_LIT), p.grit * 0.55)
  out.lerp(_c.set(SCORIA), Math.max(0, p.ridge) * 0.38 + p.mid * 0.12)
  // Ash beds: broad, soft, and only in the macro band, so they read as fields
  // rather than as noise.
  const ashiness = Math.max(0, p.macro - 0.52) * 2.1
  out.lerp(_c.set(ASH).lerp(_c.set(ASH_LO), p.grit * 0.6), Math.min(0.85, ashiness))
  // THE FISSURES. A narrow ridge in one noise band intersected with another,
  // so they form lines rather than patches, and only away from the road.
  const seam = 1 - Math.min(1, Math.abs(p.mid - 0.5) * 14)
  const gate = Math.max(0, Math.min(1, (p.edge - 6) / 26))
  const heat = seam * gate * Math.max(0, p.macro - 0.34)
  if (heat > 0.01) out.lerp(_c.set(LAVA), Math.min(0.92, heat * 1.5))
  void pal
}

/* ----------------------------------------------------------------- spray */

const SPRAY: SurfaceSprayTable = {
  // Basalt apron. Dark grit, and real sparks: this is rock over a metal
  // underbody at 60 m/s.
  tarmac: { bulk: 0x4a3c36, glint: 0x9a7a62, weight: 0.62, grit: 0.30, density: 1.0, gain: 0.50, spark: 0.55, sparkCol: 0xffb060 },
  // The ash beds. Powder that hangs -- the signature of the whole track.
  gravel: { bulk: 0x6b5c54, glint: 0xa89486, weight: 0.18, grit: 0.14, density: 1.9, gain: 0.68, spark: 0.14, sparkCol: 0xff9a4a },
  // The lava tubes are glassy basalt: little comes off, and what does is hot.
  metal: { bulk: 0x2a2228, glint: 0xff9a50, weight: 0.70, grit: 0.46, density: 0.55, gain: 0.44, spark: 0.86, sparkCol: 0xffd08a },
  oil: { bulk: 0x201a18, glint: 0x5a4a42, weight: 0.30, grit: 0.10, density: 0.8, gain: 0.34, spark: 0.10, sparkCol: 0xff7a30 },
  // Authored for completeness; this planet has no ice or snow anywhere.
  ice: { bulk: 0x4a4650, glint: 0xbfc6d2, weight: 0.55, grit: 0.40, density: 0.5, gain: 0.42, spark: 0.30, sparkCol: 0xffc27a },
  snow: { bulk: 0x6a6058, glint: 0xc0b4a6, weight: 0.22, grit: 0.16, density: 1.4, gain: 0.55, spark: 0.10, sparkCol: 0xffc27a },
  boost: { bulk: 0x5a4038, glint: 0xffa860, weight: 0.40, grit: 0.34, density: 1.1, gain: 0.60, spark: 0.62, sparkCol: 0xffcc90 },
}

/* ----------------------------------------------------------------- theme */

export const EMBERFALL_THEME: Theme = {
  id: 'emberfall',

  props(pal, seg): PropSpec[] {
    return [
      {
        name: 'basalt-columns', geo: propColumns(pal, seg), count: 165,
        radius: 4.2, gap: 2.4, spread: 90, scale: [0.8, 1.7],
        cluster: { tag: 'start', span: 420, share: 0.30 },
      },
      {
        name: 'spatter-vent', geo: propVent(pal, seg), count: 74,
        radius: 5.0, gap: 4.0, spread: 130, scale: [0.7, 1.8],
        // Vents gather where the road is torn open: the fissure jump.
        cluster: { tag: 'fissure', span: 240, share: 0.44 },
      },
      {
        name: 'lava-spire', geo: propSpire(pal, seg), count: 96,
        radius: 3.2, gap: 3.0, spread: 175, scale: [0.75, 2.1],
        cluster: { tag: 'ashbeds', span: 420, share: 0.34 },
      },
      {
        name: 'obsidian-shards', geo: propShards(pal, seg), count: 210,
        radius: 5.4, gap: 1.8, spread: 70, scale: [0.7, 1.5],
      },
      {
        name: 'collapsed-tube', geo: propArch(pal, seg), count: 26,
        radius: 13, gap: 6.5, spread: 150, scale: [0.85, 1.6],
        cluster: { tag: 'lavatube', span: 300, share: 0.50 },
      },
    ]
  },

  landmarks,
  terrainColor,
  terrainMaterial: { roughness: 0.95, metalness: 0.05 },
  // Graded onto the fog early: this is a dusty, smoky atmosphere and a crisp
  // horizon would make the terrain shell's edge visible.
  terrainFade: [180, 620],

  /**
   * EMBERS, and they RISE. `fall` is a constant downward drift, so a negative
   * value is the whole effect -- the air over a shield volcano is going up, and
   * a planet whose particles fall reads as snow no matter what colour it is.
   * They are allowed to be bright because they are tiny and there are few of
   * them: this is one of the three things on Ashkar permitted past the bloom
   * threshold.
   */
  motes: {
    count: 520, box: 76, size: [0.06, 0.22], pixel: 150, maxPixels: 5,
    alpha: 0.85, fall: -2.4, streak: 0.35,
    color: (_pal, fog) => new THREE.Color(EMBER).lerp(fog, 0.18),
  },

  /** Blown ash, not grit: long, soft, dark, and it only tints the frame down. */
  debris: {
    count: 720, box: 92, length: 7.4, width: 0.34, alpha: 0.34, fall: 0.6,
    color: (_pal, fog) => new THREE.Color(0.36, 0.30, 0.27).lerp(fog, 0.42),
  },

  sky: {
    // Ash strata, not stars: there is far too much in this atmosphere to see
    // through it, and the bands double as the plume's context.
    band: 'strata',
    // The horizon is the brightest thing in the sky and it is doing the work of
    // a sunset that never finishes -- this is the glow off the lava fields
    // beyond the rim, not a sun.
    horizonColor: 0xff6a20,
    horizonSpan: [0.02, 0.34],
    horizonGain: 0.92,
    celestial: {
      bodies: [
        {
          // THE PARENT WORLD. Ashkar is a moon; this is what it orbits, and at
          // 16 degrees of angular radius it is roughly sixty times the size of
          // Earth's moon -- which is the point, and is also why it sits LOW
          // and mostly below the horizon line rather than overhead, where it
          // would dominate every frame the camera pitches up in.
          dir: [-0.62, 0.09, -0.78],
          sizeDeg: 16,
          color: 0xb8794a,
          bands: 7,
          bandColor: 0x7a4526,
          shade: 0.55,
          limb: 0.34,
          mottle: 0.22,
          ring: {
            inner: 1.35, outer: 2.15, color: 0xc9a184, opacity: 0.42,
            axis: [0.19, 0.93, 0.31],
          },
        },
      ],
      // Pulled back hard. The gas giant is enormous and the frame still has to
      // belong to the racers; this is the dimmer that keeps it a backdrop.
      gain: 0.62,
    },
  },

  /** Smoke lying in the basins, not cloud. Warm, because here that is true. */
  fogBanks: {
    count: 9, size: 112, alpha: 0.048, low: -10, high: 30,
    color: (_pal, fog) => fog.clone().lerp(new THREE.Color(0.42, 0.30, 0.25), 0.40),
  },

  /**
   * The ash storm over the caldera rim. `windFull` is 13 because that is the
   * peak the track authors (see BEATS.updraft in content/tracks/emberfall.ts)
   * -- the cue has to arrive and leave exactly where the force does, or it is
   * decoration rather than weather.
   *
   * The fog goes DARK, not pale. Cryostatic's blizzard closes the world to a
   * mid grey the racers silhouette against; ash does the same job by going the
   * other way, and the emissive chevrons are what survives it.
   */
  weather: {
    windFull: 13.0,
    fogColor: 0x3a1d12,
    fogDensity: 0.0138,
    sunScale: 0.40,
    moteGain: 2.1,
  },

  road: 'industrial',
  propMaterial: { roughness: 0.93, metalness: 0.08 },
  spray: SPRAY,
}
