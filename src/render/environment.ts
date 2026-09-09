/**
 * ENVIRONMENT — the placement engine.
 *
 * Everything planet-specific lives in `render/themes/<track id>.ts` and reaches
 * this file through the `Theme` interface in `themes/kit.ts`; see
 * `themes/index.ts` for why the split is that way round. What is left here is
 * the machinery, and none of it knows what planet it is dressing:
 *
 *   1  gradient sky dome (ShaderMaterial; camera-locked in the vertex shader,
 *      so it needs no per-frame transform and can never be escaped or lag).
 *      The theme picks what is layered on the gradient: dust strata or aurora.
 *   1  low-poly terrain shell, graded out to the fog line. Its height field is
 *      built from the ribbon's own BANKED frame, so it stays under the road at
 *      every bank angle and joins it cleanly at the verge — see makeGround.
 *      The theme supplies the vertex colour, not the shape.
 *   6  hero props, InstancedMesh, scattered by a seeded walk over the samples
 *   n  theme landmarks (Rustfall: gantries, cargo ring, smelt pit.
 *      Cryostatic: the ice cavern, the tunnel, the blizzard poles, the crack)
 *   1  airborne motes (Points, camera-anchored, wrapped in the vertex shader):
 *      dust that hangs, or snow that falls and shears in a crosswind
 *   1  fog banks — the cheap fake volumetrics, when the theme asks for them
 *
 * THE HORIZON CONTRACT. The sky's colour at d.y == 0 is EXACTLY the fog colour
 * currently on the scene's FogExp2, and the terrain shell's albedo is graded
 * fully onto that colour before its rim. Distance fog therefore lands the
 * ground on precisely the colour the sky is already painting where the two
 * meet, and the world dissolves instead of ending on a hard line. On a track
 * with weather the fog colour MOVES — Cryostatic's blizzard band drags it two
 * stops brighter — so the sky's uniform is driven from the same value every
 * frame rather than being set once at build.
 *
 * NOTHING IN HERE, OR IN A THEME, CARRIES AN ABSOLUTE LATERAL. Every prop,
 * landmark and piece of set dressing is placed at `corridor(sample.width)` plus
 * its own clearance, where `corridor` is the forgiving edge read straight off
 * TUNING plus a racer radius. Rustfall's ribbon was widened by 50% and the only
 * things that broke were the four laterals that had been written as metres —
 * the gantry legs at a hardcoded +/-19 m ended up standing on the road — so the
 * rule is that a lateral is a function of `sample.width` or it is a bug.
 *
 * Prop scatter is a seeded mulberry32 walk over `track.samples`, always outside
 * that corridor plus the prop's own scaled radius, and re-checked against the
 * whole centreline so a prop placed beside one section can never land on
 * another section where the track loops back on itself.
 */
import * as THREE from 'three'
import { TUNING } from '../content/tuning'
import type { Track } from '../sim/track'
import type { EnvironmentVisual, RenderQuality, Vec3 } from './api'
import { crackProgress } from './hazardSignal'
import { themeFor } from './themes'
import {
  mulberry32,
  type FrameInfo, type Palette, type PropSpec, type TerrainPoint, type ThemeContext,
} from './themes/kit'

/* ------------------------------------------------------------------ config */

/** How far past the track bounding box the ground shell reaches. */
const GROUND_PAD = 620
/** Uniform cell size over the track, before geometric grading outward. */
const GROUND_CELL_HIGH = 11
const GROUND_CELL_LOW = 17
/** Sky dome radius. Rides with the camera and is pinned to the far plane in
 *  the vertex shader, so this only has to clear any plausible near plane. */
const SKY_R = 500
/** Distance the sun sits from its shadow focus. */
const SUN_DIST = 320
/** Half-extent of the single shadow cascade, metres. */
const SHADOW_EXT = 58
/** Ravine depth and lateral falloff under `open` track sections. */
const CHASM_D = 38
const CHASM_R = 52
/**
 * The forgiving edge, IMPORTED rather than copied.
 *
 * This used to be a hardcoded 1.06 with a comment saying it matched
 * TUNING.offTrack.edgeTolerance. It had not: tuning was raised to 1.10 for the
 * hover and flight classes, and the copy here stayed put, so every prop on the
 * track was placed against an edge 0.4% of a half-width inside the one the sim
 * actually forgives. Reading the number means the two can never drift again.
 */
const EDGE_TOLERANCE = TUNING.offTrack.edgeTolerance
/** Half-width of a racer. A car sitting on the forgiving edge occupies this
 *  much again beyond it, so it is part of the corridor set dressing must clear. */
const RACER_R = TUNING.collision.racerRadius
/**
 * Lateral half-width, in the ribbon's own banked frame, that NOTHING outside
 * the track mesh may enter.
 */
function corridor(width: number): number {
  return width * EDGE_TOLERANCE + RACER_R
}

/* ------------------------------------------------------------ scratch state */
// Module scope: update() must not allocate.

const _v = new THREE.Vector3()
const _sunDir = new THREE.Vector3()
const _euler = new THREE.Euler()
const _quat = new THREE.Quaternion()
const _scale = new THREE.Vector3()
const _pos = new THREE.Vector3()
const _col = new THREE.Color()

/* ------------------------------------------------------------------- noise */

function ihash(x: number, y: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177) | 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** Value noise in [0,1]. */
function vnoise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y)
  const xf = x - xi, yf = y - yi
  const u = xf * xf * (3 - 2 * xf)
  const v = yf * yf * (3 - 2 * yf)
  const a = ihash(xi, yi), b = ihash(xi + 1, yi)
  const c = ihash(xi, yi + 1), d = ihash(xi + 1, yi + 1)
  const ab = a + (b - a) * u
  const cd = c + (d - c) * u
  return ab + (cd - ab) * v
}

/* ------------------------------------------------------------ ground shell */

interface Coarse {
  x: number; y: number; z: number
  /** Half width in the BANKED frame, and the same width projected onto the
   *  ground plan. A 34-degree ribbon 11 m wide only covers 9.1 m of plan. */
  w: number; wPlan: number
  open: boolean
  /** Part of a fragile ice shelf. Used only to let a theme paint the pan. */
  fragile: boolean
  /** Vertical component of the banked `right` vector: the ribbon's cross
   *  slope. THE number this whole file used to ignore. */
  ry: number
  /** Unit horizontal `right`, plus the plan -> banked-lateral scale. */
  rx: number; rz: number; inv: number
  /** How far this section's ground plane sits under the ribbon. */
  tuck: number
  /** Lowest world Y anywhere on this cross-section. */
  lowY: number
  /**
   * HOW FAR THIS SECTION HAS ROLLED OFF LEVEL, 0..1.
   *
   * 0 up to about 57 degrees of cross-slope -- which is well past the 34 the
   * steepest shipped bank uses -- so every section of every flat track carries
   * exactly 0 and takes the untouched arithmetic below.
   *
   * Past that, the whole plan-lateral parameterisation this file is built on
   * stops existing: a vertical road projects to a LINE in plan, `wPlan` goes to
   * zero and `inv` (the plan -> banked-lateral scale, 1 / |right_xz|) goes to
   * infinity. Measured on the 270-degree wall-ride fixture, `tuck` -- which
   * carries a `cell / |right_xz|` term -- reached 2e16, and the terrain shell
   * under the wall dropped to minus twenty thousand trillion metres. Not a
   * slice through the road: no ground at all, and a bounding sphere that
   * swallows the scene.
   *
   * Where it bites, the section's ground plane stops being "the ribbon's own
   * tilted plane" and becomes "flat, under the LOWEST point the ribbon
   * reaches" -- which is the only statement that still means anything when the
   * road is a wall, and is conservative by construction.
   */
  rolled: number
  /** Height of the ground plateau this section belongs to, and how strongly
   *  the section reads as a viaduct standing over it (0..1). */
  base: number; via: number
}

interface GroundSample {
  y: number
  edge: number
  /** Plan distance to the nearest fragile section, or Infinity. */
  shelf: number
}

/**
 * Height field for the planet's floor.
 *
 * THE GROUND IS DERIVED FROM THE RIBBON'S OWN BANKED FRAME, NOT FROM THE
 * CENTRELINE HEIGHT. `Track.surfacePoint(s, lat)` is `pos + right * lat`, and
 * `right.y` is non-zero wherever the track banks, so the drivable surface at
 * the low edge of Rustfall's 34-degree cargo ring sits 6.1 m BELOW its own
 * centreline. Taking the centreline height and tucking a fixed 1.6 m under it
 * — which is what this did — put the ground 4.5 m above the road it was
 * supposed to be under, and the terrain sliced straight across the ribbon on
 * every banked corner on the track. Everything below works in `lat`, the
 * banked lateral coordinate, so the ground plane is parallel to the road it
 * sits beside no matter how hard the section banks.
 *
 * Three terms, in order:
 *
 *   DECK      a soft-min blend of every nearby section's own ground plane,
 *             `y + ry * clamp(lat, -w, w) - tuck`. Blending rather than
 *             picking the single nearest section removes the height crease
 *             that used to run down the medial axis between two sections.
 *   RELIEF    the shoulder falloff, terrain noise and rim sag. This is what
 *             keeps the plain from being a flat disc.
 *   CEILING   a hard clamp to `min` over every section of that same plane,
 *             released at CEIL_RELAX per metre outside the section's corridor.
 *             This is what makes "the ground is never above the road" true
 *             rather than hoped for, and unlike the fixed 34 m radius test it
 *             replaces, it is continuous — that test stepped by whole metres
 *             as a track sample crossed its radius, which is the hard straight
 *             edge that used to run across the verge.
 *
 * `tuck` carries a margin proportional to `|ry| * cell`: the terrain is a
 * rectilinear grid, so a cell straddling the ribbon's low edge chords across
 * the kink in `clamp(lat)` and lands above it by up to `ry * cellLat / 4`. The
 * margin is zero on flat track and only opens up where the bank is steep.
 */

/** Ground plane depth under the ribbon on flat track, metres. */
const VERGE_TUCK = 1.15
/** Share of the worst-case grid chord error added to `tuck` per section. */
const KINK_MARGIN = 0.34
/** Shoulder falloff: how far it runs and how far it drops. */
const SHOULDER_LEN = 26
const SHOULDER_FALL = 7.5
/** How fast the ceiling releases outside a section's guarded corridor, m/m. */
const CEIL_RELAX = 0.55
/** Plan distance past the corridor at which a ceiling can no longer bind. */
const CEIL_REACH = 90
/** Width of the soft-min window used to blend neighbouring ground planes. */
const BLEND_W = 15
/** Plan radius used to find the ground plateau a section stands on. */
const BASE_R = 155
/** Height over that plateau at which a section starts / finishes reading as a
 *  viaduct rather than as an embankment. */
const VIA_LO = 4.0
const VIA_HI = 9.5
/** How far under the plateau the ground runs beneath a viaduct. */
const VIA_DROP = 2.4

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1)))
  return t * t * (3 - 2 * t)
}

function makeGround(track: Track, cell: number): {
  coarse: Coarse[]
  sample(x: number, z: number): GroundSample
} {
  const res = track.length / track.samples.length
  const stride = Math.max(1, Math.round(4.5 / res))
  const coarse: Coarse[] = []
  for (let i = 0; i < track.samples.length; i += stride) {
    const s = track.samples[i]
    const ry = s.right.y
    // |right| is 1, so the horizontal part has length sqrt(1 - ry^2): that is
    // both the plan projection of the half width and the inverse of the
    // plan -> lateral scale.
    const hlRaw = Math.hypot(s.right.x, s.right.z)
    const hl = hlRaw || 1
    // See Coarse.rolled. Zero for every section of a track that authors no
    // up-vectors, and zero for a banked one too until the cross-slope passes
    // 57 degrees, so `1 - rolled` and the ternaries in sample() below leave
    // the flat arithmetic bit-for-bit identical.
    const rolled = track.hasGravity
      ? Math.min(1, Math.max(0, (0.55 - hlRaw) / 0.35))
      : 0
    // The plan -> lateral scale is 1 / |right_xz|, which is unbounded as the
    // road stands up. Floored, because past the floor `rolled` has already
    // taken the plane over and the scale no longer decides anything.
    const scale = hl < 0.2 ? 0.2 : hl
    coarse.push({
      x: s.pos.x, y: s.pos.y, z: s.pos.z,
      w: s.width, wPlan: s.width * hl, open: s.open, fragile: s.fragile,
      ry, rx: s.right.x / hl, rz: s.right.z / hl, inv: 1 / scale,
      // The kink margin corrects a grid chord across the ribbon's low EDGE.
      // A rolled section has no such edge in plan, and the term carries the
      // 1/|right_xz| blow-up, so it is faded out with the plane it belongs to.
      tuck: VERGE_TUCK + Math.abs(ry) * (cell / scale) * KINK_MARGIN * (1 - rolled),
      lowY: s.pos.y - Math.abs(ry) * s.width,
      rolled,
      base: 0, via: 0,
    })
  }
  const n = coarse.length

  // Which plateau does each section stand on? The lowest drivable point within
  // BASE_R of it. The flyover finds the sweeper it crosses 10 m below and
  // reads as a viaduct; the start straight finds only itself climbing 4 m over
  // 400 m and reads as ground, which is what keeps this from flattening the
  // whole track into a table.
  const rawBase = new Float64Array(n)
  const BASE_R2 = BASE_R * BASE_R
  for (let i = 0; i < n; i++) {
    let b = Infinity
    for (let j = 0; j < n; j++) {
      const dx = coarse[i].x - coarse[j].x, dz = coarse[i].z - coarse[j].z
      if (dx * dx + dz * dz < BASE_R2 && coarse[j].lowY < b) b = coarse[j].lowY
    }
    rawBase[i] = b
  }
  // Smoothed along the track so a viaduct ramps in over tens of metres instead
  // of stepping between adjacent coarse points.
  const SM = Math.max(2, Math.round(30 / (stride * res)))
  for (let i = 0; i < n; i++) {
    let acc = 0, via = 0, wsum = 0
    for (let d = -SM; d <= SM; d++) {
      const wgt = 1 - Math.abs(d) / (SM + 1)
      const j = ((i + d) % n + n) % n
      acc += rawBase[j] * wgt
      via += smoothstep(VIA_LO, VIA_HI, coarse[j].lowY - rawBase[j]) * wgt
      wsum += wgt
    }
    coarse[i].base = acc / wsum
    coarse[i].via = via / wsum
  }

  const out: GroundSample = { y: 0, edge: 0, shelf: Infinity }
  const CHASM_R2 = CHASM_R * CHASM_R
  // The corridor each section holds the ground down inside. One terrain cell
  // wider than the ribbon, so a grid edge that reaches into the corridor has
  // both its endpoints under the same plane and cannot chord over it.
  const guard = cell + 2
  // Per-coarse-point reach beyond which its ceiling can never be the binding
  // one, squared: it releases at CEIL_RELAX per metre, so at CEIL_REACH it is
  // ~50 m over the road, well above anything the relief can reach.
  const reach2 = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const r = coarse[i].wPlan + guard + CEIL_REACH
    reach2[i] = r * r
  }
  // Scratch: squared plan distance to every coarse point, filled by the first
  // pass and read by the second, so the second needs no distance work at all
  // for the sections it skips. Closure lifetime, so sample() never allocates.
  const dist2 = new Float64Array(n)

  function sample(x: number, z: number): GroundSample {
    let dmin2 = Infinity, bi = 0, ceil = Infinity, chasm2 = Infinity, shelf2 = Infinity

    for (let i = 0; i < n; i++) {
      const c = coarse[i]
      const dx = x - c.x, dz = z - c.z
      const d2 = dx * dx + dz * dz
      dist2[i] = d2
      if (d2 < dmin2) { dmin2 = d2; bi = i }
      if (c.open && d2 < chasm2) chasm2 = d2
      if (c.fragile && d2 < shelf2) shelf2 = d2

      // Ceiling. Inside the corridor this is exactly the ribbon's own plane,
      // which is affine in (x, z) — so a grid quad interpolates it exactly and
      // the discrete mesh inherits the guarantee, not just the samples.
      if (d2 < reach2[i]) {
        const lat = (dx * c.rx + dz * c.rz) * c.inv
        const lc = lat < -c.w ? -c.w : lat > c.w ? c.w : lat
        const outR = Math.sqrt(d2) - c.wPlan - guard
        const plane = c.y + c.ry * lc - c.tuck
        // Rolled: the ceiling is the bottom of the ribbon, not a point on a
        // plane the ribbon no longer defines.
        const held = c.rolled > 0
          ? plane + (c.lowY - VERGE_TUCK - plane) * c.rolled
          : plane
        const cy = held + (outR > 0 ? outR * CEIL_RELAX : 0)
        if (cy < ceil) ceil = cy
      }
    }
    const dmin = Math.sqrt(dmin2)
    const lim = dmin + BLEND_W
    const lim2 = lim * lim

    // Deck: soft-min blend of the ground planes of every section within
    // BLEND_W of the closest one.
    let acc = 0, viaAcc = 0, wsum = 0
    for (let i = 0; i < n; i++) {
      if (dist2[i] > lim2) continue
      const c = coarse[i]
      const d = Math.sqrt(dist2[i])
      const t = 1 - (d - dmin) / BLEND_W
      const wgt = t * t
      const lat = ((x - c.x) * c.rx + (z - c.z) * c.rz) * c.inv
      const lc = lat < -c.w ? -c.w : lat > c.w ? c.w : lat
      const flat = c.y + c.ry * lc - c.tuck
      const grade = c.rolled > 0
        ? flat + (c.lowY - VERGE_TUCK - flat) * c.rolled
        : flat
      // A viaduct does not drag the ground up with it: under one, the floor is
      // the plateau the piers stand on.
      acc += (grade + (c.base - VIA_DROP - grade) * c.via) * wgt
      viaAcc += c.via * wgt
      wsum += wgt
    }
    const cn = coarse[bi]
    const deck = wsum > 0 ? acc / wsum : cn.y - cn.tuck
    const viaW = wsum > 0 ? viaAcc / wsum : 0
    const edge = dmin - cn.wPlan

    // Verge, then a soft shoulder. Under a viaduct the shoulder is mostly
    // suppressed: there is no embankment to fall off.
    const shoulder = Math.min(1, Math.max(0, edge) / SHOULDER_LEN)
    let y = deck - shoulder * shoulder * SHOULDER_FALL * (1 - 0.85 * viaW)

    // Rolling relief further out. Past the fog wall it is damped back out and
    // the whole shell sags away, so the rim of the world sits well below the
    // eye line and can never draw a silhouette against the sky even if a track
    // def thins its fog.
    const far = Math.min(1, Math.max(0, edge - 26) / 240)
    const rim = Math.min(1, Math.max(0, edge - 380) / 460)
    const relief = 1 - rim * rim
    y += (vnoise(x * 0.0062, z * 0.0062) - 0.5) * 52 * far * relief
    y += (vnoise(x * 0.0215, z * 0.0215) - 0.5) * 11 * far * relief
    y += (vnoise(x * 0.075, z * 0.075) - 0.5) * 2.4 * Math.min(1, Math.max(0, edge) / 12) * relief
    y -= rim * rim * 115

    // The one hard rule: never above the road, anywhere, on any section.
    if (y > ceil) y = ceil

    // Ravine under the chasm jump.
    if (chasm2 < CHASM_R2) {
      const t = 1 - Math.sqrt(chasm2) / CHASM_R
      y -= CHASM_D * t * t * (3 - 2 * t)
    }

    out.y = y
    out.edge = edge
    out.shelf = shelf2 === Infinity ? Infinity : Math.sqrt(shelf2)
    return out
  }

  return { coarse, sample }
}

function buildTerrain(
  track: Track,
  ground: ReturnType<typeof makeGround>,
  quality: RenderQuality,
  cell: number,
  theme: ReturnType<typeof themeFor>,
): THREE.Mesh {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const s of track.samples) {
    if (s.pos.x < minX) minX = s.pos.x
    if (s.pos.x > maxX) maxX = s.pos.x
    if (s.pos.z < minZ) minZ = s.pos.z
    if (s.pos.z > maxZ) maxZ = s.pos.z
  }

  /** Uniform cells over the track, then geometrically expanding out to the pad. */
  const axis = (lo: number, hi: number): number[] => {
    const inLo = lo - 110, inHi = hi + 110
    const coords: number[] = []
    for (let v = inLo; v < inHi; v += cell) coords.push(v)
    coords.push(inHi)
    const outward: number[] = []
    let step = cell, total = 0
    while (total < GROUND_PAD) { step *= 1.34; total += step; outward.push(step) }
    const head: number[] = []
    let v = inLo
    for (const s of outward) { v -= s; head.push(v) }
    head.reverse()
    let w = inHi
    const tail: number[] = []
    for (const s of outward) { w += s; tail.push(w) }
    return head.concat(coords, tail)
  }

  const xs = axis(minX, maxX)
  const zs = axis(minZ, maxZ)
  const nx = xs.length, nz = zs.length

  const pos = new Float32Array(nx * nz * 3)
  const col = new Float32Array(nx * nz * 3)
  const cFog = new THREE.Color().setHex(track.def.fogColor)
  const y0 = track.samples[0].pos.y
  const [fadeIn, fadeOut] = theme.terrainFade
  const p: TerrainPoint = { x: 0, z: 0, y: 0, edge: 0, ridge: 0, grit: 0, mid: 0, macro: 0, shelf: Infinity }

  let k = 0
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++, k++) {
      const x = xs[i], z = zs[j]
      const g = ground.sample(x, z)
      pos[k * 3] = x
      pos[k * 3 + 1] = g.y
      pos[k * 3 + 2] = z

      // The macro band is what stops the mid-field reading as one flat sheet:
      // per-cell grit is below a pixel by 150 m, ~130 m patches are not.
      p.x = x; p.z = z; p.y = g.y; p.edge = g.edge; p.shelf = g.shelf
      p.grit = vnoise(x * 0.05, z * 0.05)
      p.macro = vnoise(x * 0.0078 + 31.7, z * 0.0078 - 12.3)
      p.mid = vnoise(x * 0.026 + 5.1, z * 0.026 + 9.4)
      p.ridge = Math.min(1, Math.max(0, (g.y - (y0 - 8)) / 26))
      theme.terrainColor(_col, p, track.def.palette as Palette)

      // Graded fully onto the fog colour, not 55% of the way. Distance fog is
      // already ~100% out here, but matching the albedo too means the shell
      // stops reading as a darker card laid over the sky in the band where fog
      // has not finished the job.
      const t = Math.min(1, Math.max(0, g.edge - fadeIn) / (fadeOut - fadeIn))
      _col.lerp(cFog, t * t * (3 - 2 * t))
      col[k * 3] = _col.r; col[k * 3 + 1] = _col.g; col[k * 3 + 2] = _col.b
    }
  }

  const idx: number[] = []
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1
      // Alternate the diagonal so the low-poly read is not a corduroy pattern.
      if (((i ^ j) & 1) === 0) idx.push(a, c, b, b, c, d)
      else idx.push(a, c, d, a, d, b)
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  geo.setIndex(nx * nz > 65535
    ? new THREE.BufferAttribute(new Uint32Array(idx), 1)
    : new THREE.BufferAttribute(new Uint16Array(idx), 1))
  geo.computeVertexNormals()
  geo.computeBoundingSphere()

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: theme.terrainMaterial.roughness,
    metalness: theme.terrainMaterial.metalness,
    flatShading: true,
    dithering: true,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.name = 'terrain'
  mesh.receiveShadow = quality.shadows
  mesh.matrixAutoUpdate = false
  mesh.updateMatrix()
  return mesh
}

/* --------------------------------------------------------------- placement */

/** Index of the sample nearest the first node carrying `tag`, or -1. */
function tagSample(track: Track, tag: string): number {
  const node = track.def.nodes.find((n) => n.tag === tag)
  if (!node) return -1
  let best = Infinity, bi = -1
  for (let i = 0; i < track.samples.length; i++) {
    const p = track.samples[i].pos
    const d = (p.x - node.p[0]) ** 2 + (p.y - node.p[1]) ** 2 + (p.z - node.p[2]) ** 2
    if (d < best) { best = d; bi = i }
  }
  return bi
}

/** Slack between a prop's own footprint and the protected corridor, metres. */
const PROP_MARGIN = 1.6

/**
 * True when (x,z) is far enough from every part of the centreline.
 *
 * Compared in PLAN against `c.w`, the banked half-width, not `c.wPlan`: on a
 * 34-degree section the banked half-width is 3.8 m more than the road's plan
 * footprint, and that surplus is exactly the head-room a prop standing on the
 * ground beside the high side needs, because the high edge of that road is
 * 9 m up in the air and anything tall out there can lean over it.
 */
function clearOfTrack(coarse: Coarse[], x: number, z: number, radius: number): boolean {
  for (let i = 0; i < coarse.length; i++) {
    const c = coarse[i]
    const dx = x - c.x, dz = z - c.z
    const need = corridor(c.w) + radius + PROP_MARGIN
    if (dx * dx + dz * dz < need * need) return false
  }
  return true
}

/* ------------------------------------------------------------------ shaders */

const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  // mat3() drops the translation, so the dome is centred on the camera by
  // construction — it cannot lag a frame behind it, and the camera can never
  // end up outside it. .xyww then pins every vertex to the far plane, so it is
  // also immune to a short camera far distance. Paired with depthTest false and
  // renderOrder -1000 there is no orientation that leaves a pixel uncovered.
  vec4 p = projectionMatrix * vec4(mat3(modelViewMatrix) * position, 1.0);
  gl_Position = p.xyww;
}
`

const SKY_FRAG = /* glsl */`
uniform vec3 uTop;
uniform vec3 uBot;
uniform vec3 uFog;
uniform vec3 uSunCol;
uniform vec3 uSunDir;
uniform float uTime;
uniform float uSunFade;
#ifdef SG_AURORA
uniform vec3 uAurLow;
uniform vec3 uAurHigh;
uniform float uAurGain;
#endif
#ifdef SG_STARS
uniform float uStarGain;
uniform float uStarHorizon;
#endif
varying vec3 vDir;

/** Interleaved gradient noise: fine, isotropic, and far less blotchy than a
 *  white-noise hash when used as dither. */
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

float h31(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p += dot(p, p.yzx + 19.19);
  return fract((p.x + p.y) * p.z);
}

/** Value noise on the direction sphere — no atan(), so no seam. */
float n3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = mix(mix(h31(i),                    h31(i + vec3(1.0, 0.0, 0.0)), f.x),
                mix(h31(i + vec3(0.0, 1.0, 0.0)), h31(i + vec3(1.0, 1.0, 0.0)), f.x), f.y);
  float b = mix(mix(h31(i + vec3(0.0, 0.0, 1.0)), h31(i + vec3(1.0, 0.0, 1.0)), f.x),
                mix(h31(i + vec3(0.0, 1.0, 1.0)), h31(i + vec3(1.0, 1.0, 1.0)), f.x), f.y);
  return mix(a, b, f.z);
}

void main() {
  vec3 d = normalize(vDir);
  float up = clamp(d.y, 0.0, 1.0);

  // THE HORIZON CONTRACT: at d.y == 0 the sky is EXACTLY the fog colour.
  // Distance fog has already washed the terrain shell to that same colour long
  // before the shell runs out, so the ground dissolves into the sky instead of
  // ending on a hard line. Everything else is layered on top of that anchor.
  vec3 c = mix(uFog, uBot, smoothstep(0.0, 0.19, up));
  c = mix(c, uTop, pow(clamp((up - 0.07) / 0.93, 0.0, 1.0), 0.72));

  // Below the eye line the sky stays pure fog, so looking down over a jump,
  // a chasm or the rim of the world can never reveal an uncovered band.
  c = mix(c, uFog, 1.0 - smoothstep(-0.07, 0.0, d.y));

  // One hard sun key: tight disc, tight bloom, wide scatter. uSunFade takes
  // it out inside a blizzard — the directional light already dims there, and a
  // sun disc still burning a hole in a whiteout is the tell that the weather
  // is a post effect rather than weather.
  float sd = max(dot(d, uSunDir), 0.0);
  c += uSunCol * pow(sd, 420.0) * 3.2 * uSunFade;
  c += uSunCol * pow(sd, 13.0) * 0.26 * uSunFade;
  c += uSunCol * pow(sd, 2.4) * 0.085 * (0.15 + 0.85 * uSunFade);

#ifdef SG_AURORA
  // AURORA. Curtains rather than a wash: 3D noise stretched hard on Y so the
  // field reads as sheets hanging from the zenith, raised to a high power so
  // most of the sky stays empty and the lit bands have edges. Two noise taps,
  // which is exactly what the dust strata it replaces cost — an aurora that
  // doubled the sky's fragment cost would be the most expensive thing in the
  // frame and it is meant to be the cheapest.
  float band = smoothstep(0.02, 0.42, d.y) * (1.0 - smoothstep(0.55, 1.0, d.y));
  vec3 aq = vec3(d.x * 3.1, d.y * 0.5, d.z * 3.1);
  float a1 = n3(aq * 1.6 + vec3(uTime * 0.011, uTime * 0.026, -uTime * 0.008));
  float a2 = n3(aq * 5.2 + vec3(-uTime * 0.03, 0.0, uTime * 0.017));
  float curt = pow(clamp(a1 * 1.75 - 0.56, 0.0, 1.0), 1.5) * (0.30 + 0.70 * a2);
  // Oxygen green low in the curtain, nitrogen violet-blue at the top: the
  // vertical hue shift is the thing that stops it reading as green fog.
  // Weighted low: the oxygen green is the note the brief asks for, and mixing
  // linearly in d.y put the violet over most of the visible sky.
  vec3 aur = mix(uAurLow, uAurHigh, clamp((d.y - 0.14) * 1.55, 0.0, 1.0));
  c += aur * curt * band * uAurGain;
#elif defined(SG_STARS)
  // A STARFIELD, FOR A SKY THAT IS NOT AN ATMOSPHERE.
  //
  // Cell-hashed on the direction's dominant-axis CUBE FACE, not on the noise
  // field the other two branches use: a star is a point, and a value-noise
  // blob raised to a high power is a smudge that swims as the camera turns.
  // Projecting onto the face gives an (almost) uniform grid over the sphere
  // with no atan(), no pole and no seam, and one hash per layer rather than
  // the eight a 3D value-noise tap costs — so this branch is CHEAPER than the
  // dust strata it replaces, which matters because the dome has no depth test
  // and therefore shades every pixel in the frame.
  //
  // Two layers: a sparse bright one and a dense faint one. The sub-cell
  // position comes out of the same hash, so a star is never on a lattice.
  vec3 ad = abs(d);
  vec3 fc = ad.x > ad.y && ad.x > ad.z ? d.zyx : (ad.y > ad.z ? d.xzy : d.xyz);
  vec2 uv = fc.xy / abs(fc.z);
  float face = floor(fc.z * 0.5 + 0.5) + (ad.x > ad.y && ad.x > ad.z ? 4.0 : (ad.y > ad.z ? 2.0 : 0.0));
  float star = 0.0;
  for (int L = 0; L < 2; L++) {
    float sc = L == 0 ? 58.0 : 148.0;
    vec2 g = uv * sc;
    vec2 gi = floor(g), gf = fract(g);
    float h1 = h31(vec3(gi, face + float(L) * 8.0));
    float h2 = h31(vec3(gi.yx * 1.37 + 4.1, face + float(L) * 8.0 + 31.0));
    // Most cells hold nothing. The threshold is the density control and it is
    // deliberately brutal: a sky with a star in every cell is a noise texture.
    float live = step(L == 0 ? 0.974 : 0.935, h2);
    vec2 sp = vec2(h1, fract(h1 * 91.7)) * 0.7 + 0.15;
    // A STAR IS A POINT, AND THE RADIUS IS IN CELLS. The first cut multiplied
    // the cell-space distance by the cell COUNT, which made every star as wide
    // as its own cell -- 58 of them across a 90-degree face, so the sky came
    // out as a grid of white squares the size of a window. 7% of a cell is
    // one to two pixels at any viewport this game ships on.
    float rad = length(gf - sp) / (L == 0 ? 0.072 : 0.052);
    star += live * (1.0 - smoothstep(0.0, 1.0, rad)) * (L == 0 ? 1.0 : 0.42) * (0.35 + 0.9 * h1);
  }
  // Into the haze at the horizon, and never over the sun's own scatter.
  c += vec3(0.86, 0.90, 1.0) * star * uStarGain
     * smoothstep(-0.02, uStarHorizon, d.y) * (1.0 - 0.85 * pow(sd, 3.0));
#else
  // Dust strata. 3D noise squashed on Y so it reads as drifting horizontal
  // bands rather than the fixed sine rings this used to draw, which were
  // indistinguishable from gradient banding.
  vec3 q = vec3(d.x, d.y * 4.2, d.z);
  float strata = n3(q * 2.4) * 0.62 + n3(q * 6.3) * 0.38;
  c *= 1.0 + 0.085 * (strata - 0.5) * (0.30 + 0.70 * (1.0 - up));
#endif

  // Dither. Multiplicative so it tracks the local brightness through ACES,
  // plus a small additive floor that survives the steep sRGB slope in the
  // darks. Without this the upper gradient posterises on an 8-bit output.
  float dth = ign(gl_FragCoord.xy) - 0.5;
  c = c * (1.0 + dth * 0.016) + dth * 0.0013;

  gl_FragColor = vec4(max(c, 0.0), 1.0);
  // No-ops when rendering into the composer's linear target; on the low tier,
  // which renders straight to the screen, they are what keeps the sky in the
  // same colour space as every lit surface around it.
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/**
 * Airborne motes. One system, two planets: `uFall` makes them snow instead of
 * dust, and `uWind` shears them into streaks and turns the density up inside a
 * blizzard band, so the particle layer arrives and leaves with the crosswind
 * rather than being switched on by a landmark.
 */
const MOTE_VERT = /* glsl */`
uniform vec3 uCam;
uniform float uTime;
uniform float uBox;
uniform float uPix;
uniform float uMax;
uniform float uFall;
uniform float uWind;
attribute float aSize;
attribute float aPhase;
varying float vFade;
varying float vPhase;
void main() {
  vec3 p = position;
  float w = 0.35 + 1.65 * uWind;
  p.y += sin(uTime * 0.33 + aPhase * 6.2831) * 1.8 - uTime * uFall * (0.5 + aPhase);
  p.x += sin(uTime * 0.19 + aPhase * 12.0) * 2.4 - uTime * uFall * uWind * 5.5 * (0.4 + aPhase);
  p.z += cos(uTime * 0.23 + aPhase * 9.0) * 2.4;
  // Wrap the cloud into a box that rides with the camera, so it parallaxes
  // properly instead of being glued to the view.
  vec3 d = mod(p - uCam + uBox * 0.5, uBox) - uBox * 0.5;
  vec4 mv = modelViewMatrix * vec4(uCam + d, 1.0);
  float dist = length(d);
  vFade = (1.0 - smoothstep(uBox * 0.26, uBox * 0.48, dist)) * (0.35 + 0.65 * aPhase);
  vPhase = aPhase;
  gl_PointSize = clamp(aSize * w * uPix / max(1.0, -mv.z), 1.0, uMax);
  gl_Position = projectionMatrix * mv;
}
`

const MOTE_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uAlpha;
uniform float uWind;
uniform float uStreak;
varying float vFade;
varying float vPhase;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  // Driving snow is not a dot. Rotate into the wind's screen direction and
  // THIN the sprite across it, so a flake at rest is round and a flake in a
  // 7 m/s crosswind is a 3:1 streak. Thinning rather than lengthening is the
  // whole trick: stretching q the other way pushes the shape past the point
  // quad, and the sprite comes back as a hard-edged white SQUARE, which is
  // exactly what the first pass shipped.
  float st = uStreak * uWind;
  const float CA = 0.906, SA = 0.423;   // ~25 degrees off horizontal
  q = vec2(q.x * CA + q.y * SA, -q.x * SA + q.y * CA);
  q.y *= mix(1.0, 3.6, st);
  float a = (1.0 - smoothstep(0.15, 0.5, length(q))) * vFade;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, min(0.85, a * uAlpha * (1.0 + 0.9 * uWind)));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/**
 * FOG BANKS — the cheap fake volumetrics.
 *
 * Nine sprites the size of a house, at eight per cent alpha, drifting with the
 * camera through the exponential fog. Real volumetrics is a raymarch through a
 * density field; this is what that looks like from inside a car at 70 m/s, for
 * one draw call and no depth work at all. The size clamp is the whole perf
 * story: a sprite is capped at 430 px, so worst-case overdraw is about one
 * screen no matter how close the camera gets to one.
 */
const BANK_VERT = /* glsl */`
uniform vec3 uCam;
uniform float uTime;
uniform float uBox;
uniform float uPix;
uniform float uLow;
uniform float uHigh;
attribute float aPhase;
varying float vFade;
varying float vPhase;
void main() {
  vec3 p = position;
  p.x += sin(uTime * 0.043 + aPhase * 6.2831) * 26.0;
  p.z += cos(uTime * 0.037 + aPhase * 5.13) * 26.0;
  // Wrapped in plan, but banded on the camera's own height: the track climbs
  // 44 m, so an absolute altitude band would be under the road at one end of
  // the lap and over the sky at the other.
  vec2 d = mod(p.xz - uCam.xz + uBox * 0.5, uBox) - uBox * 0.5;
  float y = uCam.y + mix(uLow, uHigh, fract(aPhase * 7.31));
  vec4 mv = modelViewMatrix * vec4(uCam.x + d.x, y, uCam.z + d.y, 1.0);
  float dist = length(vec3(d.x, y - uCam.y, d.y));
  // Fade out both very close (so a bank never fills the screen as you drive
  // into it) and at the box edge (so one never pops in).
  // Faded out hard up close. A bank is meant to be a volume you are inside,
  // and the moment one is near enough for its own sprite EDGE to be visible it
  // stops being fog and becomes a white disc sitting on the road.
  vFade = smoothstep(14.0, 55.0, dist) * (1.0 - smoothstep(uBox * 0.22, uBox * 0.46, dist));
  vPhase = aPhase;
  gl_PointSize = clamp(uPix / max(1.0, -mv.z), 1.0, 300.0);
  gl_Position = projectionMatrix * mv;
}
`

const BANK_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uAlpha;
uniform float uWind;
varying float vFade;
varying float vPhase;
void main() {
  vec2 q = (gl_PointCoord - 0.5) * vec2(1.0, 1.9);
  float r = length(q);
  // A very soft falloff with a squared shoulder: a hard-edged fog bank is a
  // disc, and there is no cheaper way to give one away.
  float a = 1.0 - smoothstep(0.10, 0.5, r);
  a *= a * vFade * uAlpha * (0.55 + 0.45 * vPhase) * (1.0 + 0.55 * uWind);
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/* ------------------------------------------------------------------ public */

export function buildEnvironment(
  track: Track,
  scene: THREE.Scene,
  quality: RenderQuality,
): EnvironmentVisual {
  const def = track.def
  const pal = def.palette as Palette
  const theme = themeFor(def.id)
  const group = new THREE.Group()
  group.name = 'environment'

  const geometries: THREE.BufferGeometry[] = []
  const materials: THREE.Material[] = []
  const lights: (THREE.PointLight | THREE.SpotLight)[] = []
  const hooks: ((f: FrameInfo) => void)[] = []
  const seg = quality.tier === 'low' ? 4 : quality.tier === 'medium' ? 6 : 8

  /* ---- atmosphere ----------------------------------------------------- */
  const prevFog = scene.fog
  const baseFog = new THREE.Color().setHex(def.fogColor)
  const ourFog = new THREE.FogExp2(def.fogColor, def.fogDensity)
  scene.fog = ourFog

  _sunDir.set(def.sunDirection[0], def.sunDirection[1], def.sunDirection[2]).normalize()

  // 48x24 rather than 32x16: the gradient is evaluated per fragment, but the
  // direction varying is interpolated across the chord of each face, so a
  // coarser dome makes the gradient rate visibly facet. Still only ~2.2k tris.
  const skyGeo = new THREE.SphereGeometry(SKY_R, 48, 24)
  const skyUniforms: Record<string, { value: unknown }> = {
    uTop: { value: new THREE.Color().setHex(def.skyTop) },
    // The dome's low colour, which a theme may hold apart from the
    // HemisphereLight's sky colour. See SkyStyle.domeLow.
    uBot: { value: new THREE.Color().setHex(theme.sky.domeLow ?? def.skyBottom) },
    // The sky's horizon anchor IS the scene fog colour, driven from the same
    // object every frame so weather can move both together.
    uFog: { value: ourFog.color },
    uSunCol: { value: new THREE.Color().setHex(def.sunColor) },
    uSunDir: { value: _sunDir.clone() },
    uTime: { value: 0 },
    uSunFade: { value: 1 },
  }
  if (theme.sky.band === 'aurora') {
    skyUniforms.uAurLow = { value: new THREE.Color().setHex(theme.sky.auroraLow ?? 0x3bffb0) }
    skyUniforms.uAurHigh = { value: new THREE.Color().setHex(theme.sky.auroraHigh ?? 0x3a76ff) }
    skyUniforms.uAurGain = { value: theme.sky.auroraGain ?? 0.5 }
  }
  if (theme.sky.band === 'stars') {
    skyUniforms.uStarGain = { value: theme.sky.starGain ?? 1.0 }
    skyUniforms.uStarHorizon = { value: theme.sky.starHorizon ?? 0.16 }
  }
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    defines: theme.sky.band === 'aurora' ? { SG_AURORA: '' }
      : theme.sky.band === 'stars' ? { SG_STARS: '' } : {},
    uniforms: skyUniforms as unknown as { [k: string]: THREE.IUniform },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
  })
  const sky = new THREE.Mesh(skyGeo, skyMat)
  sky.name = 'sky'
  sky.frustumCulled = false
  sky.renderOrder = -1000
  // The dome ignores translation in the vertex shader, so it must stay at the
  // origin with a fixed matrix; update() no longer touches it.
  sky.matrixAutoUpdate = false
  sky.updateMatrix()
  group.add(sky)
  geometries.push(skyGeo); materials.push(skyMat)

  /* ---- key light and fill --------------------------------------------- */
  const sun = new THREE.DirectionalLight(def.sunColor, def.sunIntensity)
  sun.position.copy(_sunDir).multiplyScalar(SUN_DIST)
  const sunTarget = new THREE.Object3D()
  sun.target = sunTarget
  group.add(sunTarget)
  if (quality.shadows) {
    sun.castShadow = true
    sun.shadow.mapSize.set(quality.tier === 'high' ? 2048 : 1024, quality.tier === 'high' ? 2048 : 1024)
    const sc = sun.shadow.camera
    sc.left = -SHADOW_EXT; sc.right = SHADOW_EXT
    sc.top = SHADOW_EXT; sc.bottom = -SHADOW_EXT
    sc.near = 1; sc.far = SUN_DIST * 2
    sc.updateProjectionMatrix()
    sun.shadow.bias = -0.0007
    sun.shadow.normalBias = 0.035
  }
  group.add(sun)

  const hemi = new THREE.HemisphereLight(def.skyBottom, def.ambientColor, def.ambientIntensity)
  hemi.position.set(0, 1, 0)
  group.add(hemi)
  const amb = new THREE.AmbientLight(def.ambientColor, def.ambientIntensity * 0.35)
  group.add(amb)

  /* ---- ground --------------------------------------------------------- */
  // The height field needs the terrain's cell size: the margin that keeps a
  // grid quad from chording over the ribbon's low edge scales with it.
  const groundCell = quality.tier === 'low' ? GROUND_CELL_LOW : GROUND_CELL_HIGH
  const ground = makeGround(track, groundCell)
  const terrain = buildTerrain(track, ground, quality, groundCell, theme)
  group.add(terrain)
  geometries.push(terrain.geometry); materials.push(terrain.material as THREE.Material)

  /* ---- hero props ------------------------------------------------------ */
  const propMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: theme.propMaterial.roughness,
    metalness: theme.propMaterial.metalness,
    flatShading: true,
    dithering: true,
  })
  materials.push(propMat)

  const m = track.samples.length

  /** The one surface a theme is allowed to touch. */
  const ctx: ThemeContext = {
    track, quality, palette: pal, seg,
    ground: (x, z) => ground.sample(x, z),
    corridor,
    clearOfTrack: (x, z, r) => clearOfTrack(ground.coarse, x, z, r),
    tagSample: (tag) => tagSample(track, tag),
    propMaterial: propMat,
    add: (o) => {
      group.add(o)
      if ((o as THREE.PointLight).isPointLight) lights.push(o as THREE.PointLight)
    },
    own: (x) => {
      if ((x as THREE.BufferGeometry).isBufferGeometry) geometries.push(x as THREE.BufferGeometry)
      else materials.push(x as THREE.Material)
    },
    onUpdate: (fn) => { hooks.push(fn) },
  }

  const specs: PropSpec[] = theme.props(pal, seg)
  const instanced: THREE.InstancedMesh[] = []
  // Seeded off the theme, so a track's scatter is reproducible and two tracks
  // never share a layout by accident.
  const rand = mulberry32(0x52755446 ^ (theme.id.charCodeAt(0) * 0x9e3779b1))

  for (const spec of specs) {
    const want = Math.max(1, Math.round(spec.count * quality.propDensity))
    const clusterIdx = spec.cluster ? tagSample(track, spec.cluster.tag) : -1
    const mats: THREE.Matrix4[] = []
    const cols: THREE.Color[] = []
    let guard = 0
    while (mats.length < want && guard < want * 40) {
      guard++
      let idx: number
      if (spec.cluster && clusterIdx >= 0 && rand() < spec.cluster.share) {
        const halfSpan = Math.round(spec.cluster.span / (track.length / m) / 2)
        idx = ((clusterIdx + Math.round((rand() * 2 - 1) * halfSpan)) % m + m) % m
      } else {
        idx = Math.floor(rand() * m) % m
      }
      const smp = track.samples[idx]
      const side = rand() < 0.5 ? -1 : 1

      // Place on the horizontal plane, not up the bank, so props sit on ground.
      const tx = smp.tangent.x, tz = smp.tangent.z
      const tl = Math.hypot(tx, tz) || 1
      const rx = (tz / tl) * side, rz = (-tx / tl) * side

      // The prop's SHELL is placed `gap` past the corridor, not its pivot: the
      // lateral carries the prop's own scaled radius. That makes `gap` mean the
      // same thing for a 2.6 m boulder and a 13 m crane arm — the distance from
      // the road you can actually see — and it stops the big props being placed
      // inside the corridor and then rejected, which is what used to decide
      // where they ended up.
      const scl = spec.scale[0] + rand() * (spec.scale[1] - spec.scale[0])
      const lateral = corridor(smp.width) + spec.radius * scl + spec.gap + rand() * spec.spread
      const x = smp.pos.x + rx * lateral
      const z = smp.pos.z + rz * lateral
      if (!clearOfTrack(ground.coarse, x, z, spec.radius * scl)) continue

      const g = ground.sample(x, z)
      _euler.set((rand() - 0.5) * 0.10, rand() * Math.PI * 2, (rand() - 0.5) * 0.10)
      _quat.setFromEuler(_euler)
      _pos.set(x, g.y - (spec.sink ?? 0.35) * scl, z)
      _scale.set(scl, scl * (0.9 + rand() * 0.3), scl)
      mats.push(new THREE.Matrix4().compose(_pos, _quat, _scale))

      const tint = 0.62 + rand() * 0.62
      cols.push(new THREE.Color(tint, tint * (0.94 + rand() * 0.12), tint * (0.88 + rand() * 0.2)))
    }

    // A theme may append hand-placed instances to a spec's own InstancedMesh,
    // so a landmark-scale prop costs geometry and not a draw call.
    if (spec.landmark) {
      spec.landmark(ctx, (mtx, col) => { mats.push(mtx); cols.push(col) })
    }

    const im = new THREE.InstancedMesh(spec.geo, propMat, mats.length)
    im.name = `prop-${spec.name}`
    for (let i = 0; i < mats.length; i++) {
      im.setMatrixAt(i, mats[i])
      im.setColorAt(i, cols[i])
    }
    im.instanceMatrix.needsUpdate = true
    if (im.instanceColor) im.instanceColor.needsUpdate = true
    im.instanceMatrix.setUsage(THREE.StaticDrawUsage)
    im.castShadow = quality.shadows
    im.receiveShadow = quality.shadows
    im.matrixAutoUpdate = false
    im.updateMatrix()
    im.computeBoundingSphere()
    group.add(im)
    instanced.push(im)
    geometries.push(spec.geo)
  }

  /* ---- theme landmarks -------------------------------------------------- */
  theme.landmarks(ctx)

  /* ---- airborne motes --------------------------------------------------- */
  const mo = theme.motes
  const moteCount = Math.max(120, Math.round(mo.count * quality.particleScale))
  const dpos = new Float32Array(moteCount * 3)
  const dsize = new Float32Array(moteCount)
  const dphase = new Float32Array(moteCount)
  const drand = mulberry32(0xd057)
  for (let i = 0; i < moteCount; i++) {
    dpos[i * 3] = drand() * mo.box
    dpos[i * 3 + 1] = drand() * mo.box
    dpos[i * 3 + 2] = drand() * mo.box
    dsize[i] = mo.size[0] + drand() * (mo.size[1] - mo.size[0])
    dphase[i] = drand()
  }
  const moteGeo = new THREE.BufferGeometry()
  moteGeo.setAttribute('position', new THREE.BufferAttribute(dpos, 3))
  moteGeo.setAttribute('aSize', new THREE.BufferAttribute(dsize, 1))
  moteGeo.setAttribute('aPhase', new THREE.BufferAttribute(dphase, 1))
  moteGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity)
  const moteMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    fog: false,
    uniforms: {
      uCam: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uBox: { value: mo.box },
      uPix: { value: mo.pixel },
      uMax: { value: mo.maxPixels },
      uFall: { value: mo.fall },
      uWind: { value: 0 },
      uStreak: { value: mo.streak },
      uAlpha: { value: mo.alpha },
      uColor: { value: mo.color(pal, baseFog) },
    },
    vertexShader: MOTE_VERT,
    fragmentShader: MOTE_FRAG,
  })
  const motes = new THREE.Points(moteGeo, moteMat)
  motes.name = 'motes'
  motes.frustumCulled = false
  motes.renderOrder = 5
  group.add(motes)
  geometries.push(moteGeo); materials.push(moteMat)

  /* ---- fog banks -------------------------------------------------------- */
  let bankWindU: { value: number } | null = null
  let bankTimeU: { value: number } | null = null
  let bankCamU: THREE.Vector3 | null = null
  const fb = theme.fogBanks
  if (fb && quality.tier !== 'low') {
    const n = Math.max(3, Math.round(fb.count * (quality.tier === 'high' ? 1 : 0.7)))
    const bpos = new Float32Array(n * 3)
    const bphase = new Float32Array(n)
    const brand = mulberry32(0xf06ba)
    const box = 220
    for (let i = 0; i < n; i++) {
      bpos[i * 3] = brand() * box
      bpos[i * 3 + 1] = 0
      bpos[i * 3 + 2] = brand() * box
      bphase[i] = brand()
    }
    const bgeo = new THREE.BufferGeometry()
    bgeo.setAttribute('position', new THREE.BufferAttribute(bpos, 3))
    bgeo.setAttribute('aPhase', new THREE.BufferAttribute(bphase, 1))
    bgeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity)
    const bmat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      fog: false,
      uniforms: {
        uCam: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        uBox: { value: box },
        uPix: { value: fb.size * 13 },
        uLow: { value: fb.low },
        uHigh: { value: fb.high },
        uAlpha: { value: fb.alpha },
        uWind: { value: 0 },
        uColor: { value: fb.color(pal, baseFog) },
      },
      vertexShader: BANK_VERT,
      fragmentShader: BANK_FRAG,
    })
    const banks = new THREE.Points(bgeo, bmat)
    banks.name = 'fog-banks'
    banks.frustumCulled = false
    // Behind the motes, in front of the world.
    banks.renderOrder = 4
    group.add(banks)
    geometries.push(bgeo); materials.push(bmat)
    bankWindU = bmat.uniforms.uWind as { value: number }
    bankTimeU = bmat.uniforms.uTime as { value: number }
    bankCamU = bmat.uniforms.uCam.value as THREE.Vector3
  }

  /* ---- weather ---------------------------------------------------------- */
  //
  // The authored `wind` on a TrackNode is a gameplay force. Here it is also the
  // ONLY driver of the visibility loss, so the whiteout arrives and leaves
  // exactly where the crosswind does and a designer retuning the band moves
  // both at once.
  //
  // Nearest-sample over a decimated copy rather than Track.project(): project
  // searches +/-60 m around a hint, and the one thing the camera does that a
  // racer does not is jump (a respawn, a rebuilt world, the grid camera on lap
  // one). 240 squared distances a frame is under a microsecond and cannot get
  // lost.
  const weather = theme.weather
  let windX: Float32Array | null = null
  let windY: Float32Array | null = null
  let windZ: Float32Array | null = null
  let windW: Float32Array | null = null
  if (weather) {
    const stride = Math.max(1, Math.round(m / 260))
    const n = Math.ceil(m / stride)
    windX = new Float32Array(n); windY = new Float32Array(n)
    windZ = new Float32Array(n); windW = new Float32Array(n)
    for (let i = 0, k = 0; i < m; i += stride, k++) {
      const s = track.samples[i]
      windX[k] = s.pos.x; windY[k] = s.pos.y; windZ[k] = s.pos.z
      windW[k] = Math.min(1, s.wind / weather.windFull)
    }
  }
  const blizFog = weather ? new THREE.Color().setHex(weather.fogColor) : baseFog
  // Defaulted rather than required, so the tracks that shipped before a theme
  // needed to ask keep the value this was hardcoded at.
  const hemiScale = weather?.hemiScale ?? 0.75
  const baseSun = def.sunIntensity
  const baseHemi = def.ambientIntensity

  const moteCamU = moteMat.uniforms.uCam.value as THREE.Vector3
  const moteTimeU = moteMat.uniforms.uTime as { value: number }
  const moteWindU = moteMat.uniforms.uWind as { value: number }
  const moteAlphaU = moteMat.uniforms.uAlpha as { value: number }
  const skyTimeU = skyUniforms.uTime as { value: number }
  const skySunU = skyUniforms.uSunFade as { value: number }
  const frame: FrameInfo = { dt: 0, time: 0, camX: 0, camY: 0, camZ: 0, wind: 0, crack: 0 }
  let windNow = 0

  /* ---- lifecycle -------------------------------------------------------- */

  return {
    group,

    update(dt: number, time: number, cameraPos: Vec3): void {
      // The sky dome is camera-locked in its vertex shader, so there is nothing
      // to move here — which also means it cannot be left stale by a frame that
      // renders without calling update().
      skyTimeU.value = time
      moteCamU.set(cameraPos.x, cameraPos.y, cameraPos.z)
      moteTimeU.value = time
      if (bankCamU) bankCamU.set(cameraPos.x, cameraPos.y, cameraPos.z)
      if (bankTimeU) bankTimeU.value = time

      /* -- local weather -- */
      if (weather && windX && windY && windZ && windW) {
        let best = Infinity, bw = 0
        for (let i = 0; i < windX.length; i++) {
          const dx = cameraPos.x - windX[i]
          const dy = cameraPos.y - windY[i]
          const dz = cameraPos.z - windZ[i]
          const d = dx * dx + dy * dy + dz * dz
          if (d < best) { best = d; bw = windW[i] }
        }
        // Eased rather than snapped: a camera crossing the medial axis between
        // two sections would otherwise step the fog by a visible amount.
        windNow += (bw - windNow) * Math.min(1, dt * 3.2)
        ourFog.density = def.fogDensity + (weather.fogDensity - def.fogDensity) * windNow
        ourFog.color.copy(baseFog).lerp(blizFog, windNow)
        sun.intensity = baseSun * (1 + (weather.sunScale - 1) * windNow)
        skySunU.value = 1 - 0.97 * windNow
        hemi.intensity = baseHemi * (1 + (hemiScale - 1) * windNow)
        moteWindU.value = windNow
        moteAlphaU.value = mo.alpha * (1 + (weather.moteGain - 1) * windNow)
        if (bankWindU) bankWindU.value = windNow
      }

      /* -- theme hooks -- */
      if (hooks.length > 0) {
        frame.dt = dt; frame.time = time
        frame.camX = cameraPos.x; frame.camY = cameraPos.y; frame.camZ = cameraPos.z
        frame.wind = windNow
        frame.crack = crackProgress()
        for (let i = 0; i < hooks.length; i++) hooks[i](frame)
      }

      // Single tight shadow cascade tracking the viewer.
      if (sun.castShadow) {
        sunTarget.position.set(cameraPos.x, cameraPos.y, cameraPos.z)
        sunTarget.updateMatrixWorld(true)
        _v.copy(_sunDir).multiplyScalar(SUN_DIST)
        sun.position.set(cameraPos.x + _v.x, cameraPos.y + _v.y, cameraPos.z + _v.z)
      }
    },

    dispose(): void {
      if (scene.fog === ourFog) scene.fog = prevFog
      for (const g of geometries) g.dispose()
      for (const mt of materials) mt.dispose()
      for (const im of instanced) im.dispose()
      for (const l of lights) l.dispose()
      sun.dispose()
      hemi.dispose()
      amb.dispose()
      if (sun.shadow.map) sun.shadow.map.dispose()
      group.clear()
      group.removeFromParent()
    },
  }
}
