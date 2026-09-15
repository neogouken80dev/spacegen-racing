/**
 * ZHEN-9 — stacked metropolis, deep night, raining.
 *
 * ---------------------------------------------------------------------------
 * A CITY IS MADE OF EMISSIVE, AND EMISSIVE IS THE ONE THING THE RULE PROTECTS.
 *
 * GDD 09: if a track section washes out the racers, the track is wrong. Every
 * other planet risks that with ALBEDO -- Cryostatic's snow, Halcyon's sand --
 * and the fix is the same each time: choose a time of day where the light rakes
 * instead of floods. A neon city cannot be fixed that way, because its light is
 * not the sun's. It is thousands of small sources, they are all saturated, they
 * are all above the bloom threshold, and turning them down turns the city off.
 *
 * So the discipline here is SEPARATION IN DEPTH rather than in value. The neon
 * lives on the towers, which are 40 to 300 metres off the road, behind a fog at
 * 0.0062 -- so by the time it reaches the frame it has been graded most of the
 * way onto the fog colour and reads as a wash, not as a light. The road corridor
 * itself is almost unlit: wet deck at 0.11 albedo with a hard specular, lit by
 * a violet fill off the cloud deck. The racers are the brightest COMPACT things
 * in the frame at any depth, and their own headlights and boost are the only
 * saturated light within 30m of the camera.
 *
 * That is also why there is no sun. `sunDirection` points up at a cloud deck
 * lit from below by the city; the key is 0.62 and violet, and the ambient at
 * 1.05 is the highest in the game. A city at night is a fill-lit world.
 *
 * ---------------------------------------------------------------------------
 * THE RAIN IS THE READABILITY BUDGET, NOT DECORATION.
 *
 * This is the narrowest circuit in the game -- 12.5m half-width at the Squeeze,
 * walls on both sides, a 45m tightest corner. The player needs the edges of the
 * road more here than anywhere else. Wet deck gives a specular that traces
 * every light in the scene along the road surface, so the barrier line and the
 * corner exit are drawn by their own reflections. Dry, this track was legible
 * only from the barrier meshes; wet, the road tells you where it goes.
 *
 * Beats and what each one gets:
 *   1  maglev arterial   sign gantries, the strip's own chevrons
 *   2  the Holo Ring     the loop: an advertising hoop you drive through
 *   3  the Squeeze       two towers, 12.5m, and nothing to spare
 *   4  the Spire         two turns of corkscrew down a tower's service helix
 *   5  the upper deck    the skyline, the airships, and the rain coming down
 */
import * as THREE from 'three'
import {
  bindSurfaceSpray, loopHoop, merge, mulberry32, part, xf,
  type FrameInfo, type Palette, type PropSpec, type SurfaceSprayTable,
  type TerrainPoint, type Theme, type ThemeContext,
} from './kit'

/* ------------------------------------------------------------- the values */

/** Wet deck and tower concrete. The darkest road in the game. */
const DECK = 0x12111c
const CONCRETE = 0x1b1a2a
const CONCRETE_LIT = 0x2e2c46
/** Tower glass: near-black with a violet sheen. */
const GLASS = 0x151426
/** The neon. Saturated, and only ever placed at distance -- see the header. */
const NEON_PINK = 0xff3ea5
const NEON_CYAN = 0x35e8ff
const NEON_AMBER = 0xffa63a
const NEON_VIOLET = 0x8a5cff

/* ------------------------------------------------------------------ props */

/** A tower: stacked slabs with lit window bands. The city's whole silhouette. */
function propTower(pal: Palette, seg: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const rnd = mulberry32(0x7042)
  let y = 0
  const NEONS = [NEON_PINK, NEON_CYAN, NEON_AMBER, NEON_VIOLET]
  for (let i = 0; i < 6; i++) {
    const h = 14 + rnd() * 26
    const w = 9 - i * 0.9
    parts.push(part(new THREE.BoxGeometry(w, h, w), i % 2 ? CONCRETE : GLASS, xf(0, y + h / 2, 0)))
    // A window band. Thin, and it is the only emissive on the prop.
    if (rnd() < 0.75) {
      parts.push(part(
        new THREE.BoxGeometry(w * 1.02, 0.5 + rnd() * 0.8, w * 1.02),
        NEONS[(i + Math.floor(rnd() * 4)) % 4],
        xf(0, y + h * (0.3 + rnd() * 0.5), 0),
      ))
    }
    y += h
  }
  void pal; void seg
  return merge(parts)
}

/** A sign gantry: a mast with stacked hanboard panels, lit. */
function propSign(pal: Palette, seg: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const rnd = mulberry32(0x5164)
  parts.push(part(new THREE.CylinderGeometry(0.42, 0.55, 20, Math.max(5, seg >> 2)), CONCRETE, xf(0, 10, 0)))
  const NEONS = [NEON_PINK, NEON_CYAN, NEON_AMBER]
  for (let i = 0; i < 5; i++) {
    const w = 1.8 + rnd() * 3.2
    const h = 2.6 + rnd() * 3.4
    parts.push(part(
      new THREE.BoxGeometry(w, h, 0.26),
      NEONS[i % 3],
      xf((rnd() < 0.5 ? -1 : 1) * (w / 2 + 0.5), 4 + i * 3.4, 0, (rnd() - 0.5) * 0.5),
    ))
  }
  void pal
  return merge(parts)
}

/** Ducting and condenser plant: the low clutter that fills a street's verge. */
function propPlant(pal: Palette, seg: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const rnd = mulberry32(0x0d0c7)
  for (let i = 0; i < 6; i++) {
    const w = 1.2 + rnd() * 2.6
    const h = 1.0 + rnd() * 2.8
    parts.push(part(
      new THREE.BoxGeometry(w, h, w * (0.6 + rnd() * 0.8)),
      i % 3 === 0 ? CONCRETE_LIT : CONCRETE,
      xf((rnd() - 0.5) * 5, h / 2, (rnd() - 0.5) * 5, rnd() * 3),
    ))
  }
  parts.push(part(new THREE.CylinderGeometry(0.9, 0.9, 4.2, Math.max(6, seg >> 2)), CONCRETE_LIT, xf(1.8, 2.1, -1.4)))
  void pal
  return merge(parts)
}

/* -------------------------------------------------------------- landmarks */

function landmarks(ctx: ThemeContext): void {
  const { track, palette: pal, quality } = ctx
  bindSurfaceSpray(track, SPRAY)

  /* ---- THE HOLO RING. The loop, and the fourth time this pattern has earned
   * its keep: a vertical loop with no boost strip through it has nothing
   * lighting its far side, and a headline set piece the player cannot see is
   * not one. Here it is an advertising hoop, so the light has a reason to be
   * there, and it CYCLES hue -- the only colour-animated thing in the game, and
   * it is allowed because it is a hoarding. ---- */
  const HOOP_TUBE = 1.5
  // Radius and sweep are measured off the ribbon: see `loopHoop` in kit.ts.
  // The hand-written `loopR + corridor(width) + 3.4` built a 58.1 m circle
  // round a loop whose road only reaches 35.2 m in this plane, and the 23 m of
  // slack hung the hoop's lower arc through the feed road 6.88 m inside the
  // edge, 45 m before the loop's mouth. Measured: a 38.7 m hoop over 322
  // degrees, with the gap where the road drives in.
  const hoop = loopHoop(ctx, 'holoring', 'holoring-apex', { tube: HOOP_TUBE, clear: 2.0 })
  if (hoop) {
    const seg = Math.max(14, Math.round(ctx.seg * 2 * (hoop.sweep / (Math.PI * 2))))
    const geo = new THREE.TorusGeometry(hoop.radius, HOOP_TUBE, 6, seg, hoop.sweep)
    geo.rotateZ(hoop.from)
    ctx.own(geo)
    const mat = new THREE.MeshBasicMaterial({ color: NEON_PINK, fog: true })
    ctx.own(mat)
    const mesh = new THREE.Mesh(geo, mat)
    mesh.name = 'landmark-holoring'
    mesh.position.set(hoop.cx, hoop.cy, hoop.cz)
    mesh.rotation.y = hoop.rotY
    ctx.add(mesh)
    if (quality.tier !== 'low') {
      for (const k of [-1, 1]) {
        const L = new THREE.PointLight(0xff5ab4, 2.3, hoop.loopR * 3.4, 1.7)
        L.position.set(
          hoop.cx + hoop.fx * k * hoop.loopR * 0.55, hoop.cy,
          hoop.cz + hoop.fz * k * hoop.loopR * 0.55,
        )
        ctx.add(L)
      }
    }
    const _hsl = { h: 0, s: 0, l: 0 }
    ctx.onUpdate((f: FrameInfo) => {
      // A slow hue sweep through the neon range, never through green: the item
      // pickups own green and a hoarding that borrows it reads as a pickup.
      const h = 0.82 + 0.16 * Math.sin(f.time * 0.22)
      mat.color.setHSL(h % 1, 0.85, 0.58)
      void _hsl
    })
  }
  void pal
}

/* ---------------------------------------------------------------- terrain */

const _c = new THREE.Color()

/** Deck plate and the gaps between the city's levels. Dark, wet, violet. */
function terrainColor(out: THREE.Color, p: TerrainPoint, pal: Palette): void {
  out.set(DECK).lerp(_c.set(CONCRETE), p.grit * 0.6)
  out.lerp(_c.set(CONCRETE_LIT), Math.max(0, p.ridge) * 0.42 + p.mid * 0.16)
  // Standing water catches the city. Follows the LOW ground, and it is the one
  // place the terrain is allowed a saturated colour -- a reflection, well off
  // the road, where it cannot compete with a racer.
  const pool = Math.max(0, 1 - Math.abs(p.ridge + 0.05) * 6) * Math.max(0, p.macro - 0.5) * 2
  if (pool > 0.01) out.lerp(_c.set(NEON_VIOLET), Math.min(0.36, pool * 0.5))
  void pal
}

/* ----------------------------------------------------------------- spray */

const SPRAY: SurfaceSprayTable = {
  // Wet maglev deck: a sheet of water off the tyres and hard sparks off the
  // underbody. This is nearly the whole circuit.
  metal: { bulk: 0x6a6a86, glint: 0xc8d6ff, weight: 0.30, grit: 0.26, density: 1.7, gain: 0.62, spark: 0.80, sparkCol: 0xbfa8ff },
  tarmac: { bulk: 0x55556e, glint: 0xa8b4e0, weight: 0.36, grit: 0.22, density: 1.4, gain: 0.56, spark: 0.58, sparkCol: 0xbfa8ff },
  gravel: { bulk: 0x4a4858, glint: 0x8a8aa8, weight: 0.34, grit: 0.20, density: 1.3, gain: 0.52, spark: 0.20, sparkCol: 0xbfa8ff },
  oil: { bulk: 0x161520, glint: 0x6a5a90, weight: 0.28, grit: 0.14, density: 0.9, gain: 0.40, spark: 0.12, sparkCol: 0xff3ea5 },
  ice: { bulk: 0x5a6480, glint: 0xc8dcff, weight: 0.50, grit: 0.36, density: 0.6, gain: 0.46, spark: 0.28, sparkCol: 0xcfe0ff },
  snow: { bulk: 0x6e7490, glint: 0xc0c8e4, weight: 0.24, grit: 0.16, density: 1.3, gain: 0.54, spark: 0.10, sparkCol: 0xcfe0ff },
  boost: { bulk: 0x6a2a70, glint: 0xff8ad8, weight: 0.32, grit: 0.30, density: 1.4, gain: 0.68, spark: 0.70, sparkCol: 0xff9ade },
}

/* ----------------------------------------------------------------- theme */

export const NEONSPIRE_THEME: Theme = {
  id: 'neonspire',

  props(pal, seg): PropSpec[] {
    return [
      {
        name: 'tower', geo: propTower(pal, seg), count: 120,
        // Held well off the road: the neon has to be at depth to be legal
        // against the racers. `gap` is the largest of any prop in the game.
        radius: 7.0, gap: 14.0, spread: 240, scale: [0.9, 3.4],
      },
      {
        name: 'sign-gantry', geo: propSign(pal, seg), count: 110,
        radius: 4.2, gap: 3.2, spread: 60, scale: [0.8, 1.7],
        cluster: { tag: 'maglev', span: 420, share: 0.40 },
      },
      {
        name: 'street-plant', geo: propPlant(pal, seg), count: 200,
        radius: 4.4, gap: 2.0, spread: 44, scale: [0.75, 1.6],
        cluster: { tag: 'squeeze', span: 260, share: 0.32 },
      },
    ]
  },

  landmarks,
  terrainColor,
  terrainMaterial: { roughness: 0.42, metalness: 0.22 },
  // Short and hard. The fog IS the separation plan -- it is what turns a wall of
  // saturated neon at 200m into a wash the racers can be read against.
  terrainFade: [110, 400],

  /**
   * RAIN. `fall` is the highest in the game and `streak` is at maximum, which
   * together are the whole effect: a mote that falls fast and stretches along
   * its own motion is a raindrop, and one that does neither is dust. It is also
   * the readability budget -- see the header.
   */
  motes: {
    count: 880, box: 72, size: [0.04, 0.13], pixel: 120, maxPixels: 3,
    alpha: 0.40, fall: 16.0, streak: 1.0,
    color: (_pal, fog) => new THREE.Color(0.72, 0.76, 0.95).lerp(fog, 0.42),
  },

  /** The updraft between towers, carrying litter and torn hoarding film. */
  debris: {
    count: 560, box: 84, length: 5.6, width: 0.24, alpha: 0.26, fall: 1.4,
    color: (_pal, fog) => new THREE.Color(0.52, 0.46, 0.66).lerp(fog, 0.44),
  },

  sky: {
    // No stars: this is a city under a cloud deck and there is far too much
    // light below it. The strata ARE the cloud, lit from underneath.
    band: 'strata',
    // The city glow on the underside of the cloud. High gain and a wide span,
    // because this is not a sunset -- the light source is beneath the horizon
    // in every direction at once.
    horizonColor: 0xff4a9a,
    horizonSpan: [0.0, 0.44],
    horizonGain: 0.86,
    // The dome's low sky must stay dark even though the light rig's fill is
    // bright: a cloud deck that glows as hard as it lights would erase the
    // skyline silhouette, which is the only thing telling you this is a city.
    domeLow: 0x1a1030,
    celestial: {
      ships: {
        // AIRSHIPS holding station over the upper deck. `ships` is silhouettes
        // with running lights, which is exactly right here and needs no
        // reinterpretation at all -- the one track where the layer is used for
        // the thing it was named for.
        dir: [0.36, 0.30, -0.88],
        spreadDeg: 34,
        sizeDeg: 9,
        color: 0x0a0814,
        lightColor: 0xff5ab4,
        lightGain: 1.25,
        count: 5,
        driftDeg: 0.10,
      },
      gain: 0.92,
    },
  },

  /** Low cloud caught between the towers, lit pink from below. */
  fogBanks: {
    count: 11, size: 104, alpha: 0.058, low: -8, high: 34,
    color: (_pal, fog) => fog.clone().lerp(new THREE.Color(0.52, 0.24, 0.46), 0.40),
  },

  /**
   * The squall over the upper deck. `windFull` 11 matches the track's peak.
   * Modest on purpose: this circuit is already the hardest in the game on
   * geometry alone, and a visibility hazard on top of a 12.5m road is the kind
   * of stacking that makes a track unfair rather than difficult.
   */
  weather: {
    windFull: 11.0,
    fogColor: 0x2a1638,
    fogDensity: 0.0118,
    sunScale: 0.66,
    moteGain: 1.9,
  },

  road: 'industrial',
  propMaterial: { roughness: 0.52, metalness: 0.30 },
  spray: SPRAY,
}
