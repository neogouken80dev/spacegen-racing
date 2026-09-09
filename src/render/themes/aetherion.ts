/**
 * AETHERION PRIME — ancient-futurist city.
 *
 * GDD hook: gold, teal and violet on white stone, under a warm low sun in high
 * clean air. A civilisation that has been here a very long time and has better
 * technology than you.
 *
 * ---------------------------------------------------------------------------
 * THREE MOTIFS, AND EVERY PIECE OF GEOMETRY IN THIS FILE IS ONE OF THEM.
 *
 *   1  THE SPIRAL FLUTE. Every shaft on the planet is a fluted column whose
 *      flutes wind as they rise. The flute is not a texture and it is not a
 *      normal map: the cross-section is a star polygon and each ring of it is
 *      ROTATED a few degrees past the one below, so the ridge is a helix in
 *      the actual silhouette. At twelve polygons around and four rings tall —
 *      96 triangles, which is what lets there be a hundred and fifty of them —
 *      that still reads at 200 m, because what a raking sun does to it is a
 *      spiral of lit facets, which is exactly what it does to a real fluted
 *      column and is the reason the order was invented. The track def's own
 *      sun azimuth was turned across the colonnade by this pass for the same
 *      reason: down it, the flute has nothing to catch.
 *
 *   2  THE FLOATING KEYSTONE. Every arch on this planet has a GAP where its
 *      keystone should be, and a tetrahedron hanging in the gap, turning. The
 *      arch is doing its job; the block that makes an arch an arch is simply
 *      not touching it. Scattered arches carry a static one (an instanced
 *      prop cannot animate per instance); the six hero gateways carry a live
 *      one on the shared `floaters` mesh, which rotates every keystone,
 *      armillary ring and plaza tetrahedron on the planet in ONE vertex shader
 *      and ONE draw call.
 *
 *   3  THE CALLIGRAPHIC GLYPH. Emissive linework on stone, and it is SCRIPT.
 *      `writeGlyph()` below is a broad-nib pen: the ribbon's width is the sine of
 *      the angle between the stroke's direction and a fixed nib angle, so a
 *      stroke that runs across the nib is fat and one that runs along it is a
 *      hairline, and every curve swells and thins the way a written one does.
 *      A grid of glowing rectangles was the thing to avoid and this is the
 *      cheapest honest way not to be one.
 * ---------------------------------------------------------------------------
 *
 * THE VALUE PROBLEM. GDD 09: "track environments sit in the mid-to-dark band
 * so vehicles and VFX always pop." A white-stone city is the same trap
 * Cryostatic's snow was, and the authored palette walks straight into it —
 * `palette.a` is 0xd8d2c4 — 0.84 sRGB luma, against a palest chassis
 * (Filament, 0xdfe6ee) at 0.90 — so it is never used on a face at all. The
 * mass of the city is `STONE` at 0.56, its shadow side is a VIOLET at 0.32
 * rather than a grey, and its deepest soffit is 0.17. `palette.b` is the one
 * value allowed near the top of the band, at 0.72, and only on edges, collars
 * and corbels: gold is a hue the eye reads as metal rather than as a bright
 * surface, which is exactly why it can carry the accents on a stone planet
 * without competing with a car. Nothing else in this file passes 0.66, and
 * the brightest thing in any frame is the teal.
 *
 * Beats and what each one gets:
 *   1  colonnade         413 m of spiral-fluted columns, both sides, plus the
 *                        scattered ones that carry the motif round the lap
 *   2  gatehouse         a monumental gate with a turning keystone in its crown
 *      causeway          an arched stone soffit under the solid deck, twelve
 *                        pylons, and THE LIGHT-BRIDGES: an emissive lattice
 *                        under each phasing span that reads the same predicate
 *                        the sim reads, plus a fracture-then-void skin on the
 *                        road itself so "this span is about to go" is legible
 *                        from the far end of the causeway
 *   3  rotunda           the drum: a swept masonry shell behind the road that
 *                        grows into a 54 m cylinder exactly as the road rolls
 *                        up onto the wall, gold corbels, script on the wall,
 *                        two warm lamps on its axis, and two teal light-lines
 *                        that spiral the whole 270 degrees with the road
 *   4  warp gate         a bigger gate over the launch with a broken ring
 *                        turning in its opening and a keystone in the crown
 *   5  orrery            the floating armillary: four inclined rings and a
 *                        core, turning over the middle of the spiral
 *   6  Keystone Plaza    a lattice of tetrahedra 18 and 30 m over the dust, in
 *                        two counter-turning layers, inside a peristyle
 *   7  the descent       three gateways at 120 m intervals down the fastest
 *                        road on the lap, stepped retaining terraces on the
 *                        cut side and a revetment on the fill side
 *   8  Glyph Steps       terrace faces carrying the big calligraphic glyphs
 *   -  everywhere        the upper city: the spire prop hand-placed on a ring
 *                        220-420 m out at two to three times its scattered
 *                        scale, so no frame runs out of city
 */
import * as THREE from 'three'
import { TUNING } from '../../content/tuning'
import { bridgeSolid, type TrackSample } from '../../sim/track'
import {
  bindSurfaceSpray, merge, mulberry32, part, xf,
  type FrameInfo, type Palette, type PropSpec, type SurfaceSprayTable,
  type TerrainPoint, type Theme, type ThemeContext,
} from './kit'

/* ------------------------------------------------------------- the values */
//
// Authored in sRGB and measured against the mid-to-dark rule above. STONE is
// the body of the city; STONE_LIT is the only pale face and it is only ever a
// top surface the low sun actually rakes.

/** The body of every wall, shaft and pier. Warm pale stone, kept at 0.59. */
const STONE = 0x968d79
/** A sunward top face or chamfer. The palest FACE on the planet. */
const STONE_LIT = 0xb3a88d
/** Stone in shade. Violet rather than grey, because the fill light is. */
const STONE_DUSK = 0x554d63
/** Soffits, undercrofts, the inside of an arch. The darkest architecture. */
const STONE_DEEP = 0x2e2740
/** Two thousand years of drift, lying in the joints and over the plain. */
const DUST = 0x8a7f6a
/** Gold, as a mass: capitals, ribs, copings. Under palette.b on purpose. */
const GOLD = 0xb98c33
/** Gold as a catch-light edge only, a few centimetres wide. = palette.b. */
const GOLD_HI = 0xe8b44a

/* ----------------------------------------------------------- drift spray */

/**
 * What Aetherion throws at you when you slide on it.
 *
 * THIS PLANET IS THE DUST PLANET, and the whole table is the difference
 * between two thousand years of drift and the stone under it. On the swept
 * stone of the colonnade a grounded chassis strikes a hard pale spark and
 * lifts almost nothing — the city is clean, and `density` 0.62 says so. In
 * Keystone Plaza, which is the one place the city has lost, `gravel` is the
 * heaviest, densest, warmest spray in the file and the spark nearly stops:
 * you are no longer on stone, you are on what has settled on it. That
 * contrast is the plaza's whole read, and it is the same argument the track
 * makes for putting a low-grip surface there at all.
 *
 * Hues are the authored palette: bone for the stone, gold for anything the
 * low sun catches, teal for the one emissive on the planet.
 */
const SPRAY: SurfaceSprayTable = {
  // Swept stone. Little to lift, and a bright hard strike off a dressed face.
  tarmac: {
    bulk: 0x8d8574, glint: 0xf0dcae, weight: 0.40, grit: 0.30,
    density: 0.62, gain: 0.44, spark: 0.72, sparkCol: 0xffe6b0,
  },
  // KEYSTONE PLAZA. Ancient dust: enormous, slow, warm, and it kills the
  // strike, because there is no stone within reach of the contact patch.
  gravel: {
    bulk: 0x7b6a4e, glint: 0xd8b463, weight: 0.72, grit: 0.44,
    density: 1.45, gain: 0.52, spark: 0.10, sparkCol: 0xffc27a,
  },
  // The causeway's deck plates and the gate hardware.
  metal: {
    bulk: 0x6a6458, glint: 0xffeec4, weight: 0.52, grit: 0.34,
    density: 0.44, gain: 0.40, spark: 0.95, sparkCol: 0xfff2d0,
  },
  // Boost plate: stone grit lit by the only emissive on the planet.
  boost: {
    bulk: 0x8d8574, glint: 0x7bffe6, weight: 0.34, grit: 0.30,
    density: 0.68, gain: 0.46, spark: 0.60, sparkCol: 0x7bffe6,
  },
  // Aetherion authors none of the three below. They exist so a future night,
  // flood or winter pass on this circuit is a track edit rather than a code
  // change, and they are tinted to THIS planet rather than copied off another.
  oil: {
    bulk: 0x241f2e, glint: 0x8f7ad0, weight: 0.58, grit: 0.24,
    density: 0.85, gain: 0.26, spark: 0.06, sparkCol: 0xffc27a,
  },
  ice: {
    bulk: 0x9aa8ad, glint: 0xdff0f2, weight: 0.60, grit: 0.52,
    density: 0.70, gain: 0.40, spark: 0.14, sparkCol: 0xcfe8f0,
  },
  snow: {
    bulk: 0xb4b4a8, glint: 0xeff0e8, weight: 0.14, grit: 0.20,
    density: 1.30, gain: 0.46, spark: 0.00, sparkCol: 0xeff0e8,
  },
}

/* --------------------------------------------------------- the spiral flute */

/**
 * A spiral-fluted shaft, as raw geometry.
 *
 * The cross-section is a star polygon: `radial` vertices alternating between
 * `r * (1 + FLUTE)` on a ridge and `r * (1 - FLUTE)` in a groove, which gives
 * `radial / 2` flutes. Each ring is rotated `TWIST / rings` further round than
 * the one below it, so a ridge traces a helix up the shaft.
 *
 * Nothing here is a texture and nothing is a normal map. The twist is in the
 * silhouette, which is the only place it survives being 200 m away on a phone,
 * and the flat-shaded facets between two rings are what turn a raking sun into
 * a spiral of highlights. Open at both ends: a plinth closes the bottom and a
 * capital closes the top, so the caps would never be seen.
 */
const FLUTE = 0.115
const TWIST = 1.31   // ~75 degrees over the shaft

function flutedShaft(
  y0: number, y1: number, rBot: number, rTop: number,
  radial: number, rings: number, col: number, colTop: number,
): THREE.BufferGeometry {
  const pos = new Float32Array((rings + 1) * radial * 3)
  const cols = new Float32Array((rings + 1) * radial * 3)
  const c0 = new THREE.Color().setHex(col)
  const c1 = new THREE.Color().setHex(colTop)
  const cc = new THREE.Color()
  let k = 0
  for (let r = 0; r <= rings; r++) {
    const u = r / rings
    // Entasis: a real shaft is not a cone, it swells slightly low down.
    const rad = rBot + (rTop - rBot) * u + (rBot - rTop) * 0.18 * Math.sin(Math.PI * u)
    const y = y0 + (y1 - y0) * u
    const spin = TWIST * u
    cc.copy(c0).lerp(c1, u)
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2 + spin
      const rj = rad * (1 + (j % 2 === 0 ? FLUTE : -FLUTE))
      pos[k * 3] = Math.cos(a) * rj
      pos[k * 3 + 1] = y
      pos[k * 3 + 2] = Math.sin(a) * rj
      cols[k * 3] = cc.r; cols[k * 3 + 1] = cc.g; cols[k * 3 + 2] = cc.b
      k++
    }
  }
  const idx: number[] = []
  for (let r = 0; r < rings; r++) {
    for (let j = 0; j < radial; j++) {
      const a0 = r * radial + j
      const a1 = r * radial + ((j + 1) % radial)
      const b0 = a0 + radial
      const b1 = a1 + radial
      idx.push(a0, b0, a1, a1, b0, b1)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3))
  g.setIndex(new THREE.BufferAttribute(new Uint16Array(idx), 1))
  // `part()` leaves every other piece of a prop carrying position, normal and
  // colour, and `mergeGeometries` refuses a batch whose attribute sets differ.
  // A shaft built by hand has to supply the normal itself.
  g.computeVertexNormals()
  return g
}

/* ------------------------------------------------------------- hero props */

/**
 * Radial and ring counts for a shaft at this tier.
 *
 * Six flutes and four rings at the top tier, which is 96 triangles a shaft.
 * That is not a corner cut: a hundred and forty columns is what a colonnade
 * IS, so the per-column budget is the thing that decides whether the planet
 * can have one. Four rings puts 19 degrees of twist between facets, which
 * reads as a hand-cut spiral rather than as a smooth one -- on a planet whose
 * masonry is two thousand years old that is the right kind of wrong.
 */
function shaftLod(seg: number): [number, number] {
  return seg <= 4 ? [8, 3] : seg <= 6 ? [10, 4] : [12, 4]
}

/**
 * Hero prop 1 — THE SPIRAL-FLUTED COLUMN. The planet in one object, and the
 * only prop that also gets hand-placed: the colonnade, the plaza peristyle and
 * the ring around the rotunda all ride this spec's own InstancedMesh through
 * `columnLandmarks` below, so 14 m of monument costs no draw call at all.
 *
 * 14.4 m at scale 1, scattered at 0.75-1.5 and stood in a colonnade at 1.15.
 */
function propColumn(p: Palette, seg: number): THREE.BufferGeometry {
  void p
  const [radial, rings] = shaftLod(seg)
  // DORIC PROPORTIONS, and they are load-bearing rather than pedantic. The
  // first cut was a slender shaft under a 3.1 m abacus — 1.7 times the shaft's
  // own diameter — and 130 of them down a straight came out as a row of
  // mushrooms. A stocky shaft with a capital barely wider than it is reads as
  // a column at 200 m, which slender-with-a-hat does not.
  return merge([
    // Plinth. Square, because a square base under a round shaft is what makes
    // the round read as round.
    part(new THREE.BoxGeometry(3.4, 1.1, 3.4), STONE_DUSK, xf(0, 0.55, 0)),
    flutedShaft(1.1, 12.6, 1.38, 1.12, radial, rings, STONE, STONE_LIT),
    // Echinus: the flared gold collar under the abacus. The one piece of gold
    // that is a mass rather than an edge, and it is what the eye tracks down a
    // colonnade at speed.
    part(new THREE.CylinderGeometry(1.62, 1.18, 0.75, radial, 1, true), GOLD,
      xf(0, 12.95, 0)),
    // The abacus takes the SHAFT's value, not the pale one. A horizontal face
    // that size already gathers most of the hemisphere fill, so painting it
    // pale as well turned every capital into a bright bar floating on a dark
    // stalk -- a colonnade of tables.
    part(new THREE.BoxGeometry(3.3, 0.62, 3.3), STONE, xf(0, 13.64, 0)),
  ])
}

/**
 * Hero prop 2 — ARCH WITH A FLOATING KEYSTONE. Motif 2 at clutter scale: the
 * arch is closed except at the crown, and the block that would close it hangs
 * above the gap not touching anything. A scattered instance cannot turn (one
 * geometry, one matrix per instance), so these are the still ones and the six
 * hero gateways carry the moving ones.
 */
function propArch(p: Palette, seg: number): THREE.BufferGeometry {
  void p; void seg
  const parts: THREE.BufferGeometry[] = [
    part(new THREE.BoxGeometry(2.4, 7.2, 2.8), STONE, xf(-5.4, 3.6, 0)),
    part(new THREE.BoxGeometry(2.4, 7.2, 2.8), STONE, xf(5.4, 3.6, 0)),
    part(new THREE.BoxGeometry(3.0, 0.7, 3.2), GOLD, xf(-5.4, 7.55, 0)),
    part(new THREE.BoxGeometry(3.0, 0.7, 3.2), GOLD, xf(5.4, 7.55, 0)),
  ]
  // Voussoirs over a 5.4 m half-span, springing at 7.9 m. The middle one is
  // MISSING: that hole is the whole point of the prop.
  const N = 9
  for (let i = 0; i < N; i++) {
    if (i === (N - 1) / 2) continue
    const th = (i / (N - 1)) * Math.PI
    const cx = Math.cos(th) * 5.4
    const cy = 7.9 + Math.sin(th) * 3.6
    parts.push(part(new THREE.BoxGeometry(1.5, 1.5, 2.6),
      i % 2 === 0 ? STONE : STONE_DUSK, xf(cx, cy, 0, 0, 0, -th + Math.PI / 2)))
  }
  // The keystone, hanging in the gap.
  parts.push(part(new THREE.TetrahedronGeometry(1.35, 0), STONE_LIT, xf(0, 12.6, 0, 0.6, 0.4)))
  parts.push(part(new THREE.TetrahedronGeometry(0.72, 0), GOLD_HI, xf(0, 12.6, 0, 0.6 + 1.0, 0.4)))
  return merge(parts)
}

/**
 * Hero prop 3 — GLYPH STELE. A dressed slab with a line of script cut into
 * both faces and lit from inside it. The scattered carrier of motif 3, so the
 * calligraphy is a property of the whole planet and not just of beat 8.
 */
function propStele(p: Palette, seg: number): THREE.BufferGeometry {
  void seg
  const parts: THREE.BufferGeometry[] = [
    part(new THREE.BoxGeometry(2.6, 1.3, 5.4), STONE_DUSK, xf(0, 0.65, 0)),
    part(new THREE.BoxGeometry(1.15, 11.4, 4.0), STONE, xf(0, 7.0, 0)),
    part(new THREE.BoxGeometry(1.6, 0.5, 4.6), GOLD, xf(0, 12.95, 0)),
  ]
  // Two faces of script. Emissive comes from an accent-tinted albedo plus
  // bloom, exactly as Cryostatic's vent throat does: a point light per stele
  // is not a budget, it is a bug.
  // ONE glyph per face, and a big one. Three small ones cost three times the
  // triangles of the whole rest of the prop and, at the 30 m a scattered stele
  // actually stands from the road, read as a smudge rather than as writing.
  for (const side of [-1, 1]) {
    const g = glyphBuffer()
    // Page axes in the prop's local space, ordered so `du x dv` is the face's
    // own outward normal: +X on the right-hand face, -X on the left.
    writeGlyph(g, GLYPHS[side < 0 ? 1 : 4],
      [0.58 * side, 2.0, 1.65 * side], [0, 0, -3.3 * side], [0, 9.0, 0], 0.10, 1.0)
    parts.push(glyphGeometry(g, p.accent, 1.0))
  }
  return merge(parts)
}

/**
 * Hero prop 4 — UNTETHERED KEYSTONES. Four tetrahedra hanging over nothing at
 * all, at four heights, gold-cored. They stand on no plinth and there is no
 * mast: the reason they are up there is that this city decided they should be.
 */
function propKeystones(p: Palette, seg: number): THREE.BufferGeometry {
  void p; void seg
  const rnd = mulberry32(0xae7e0)
  const parts: THREE.BufferGeometry[] = []
  for (let i = 0; i < 3; i++) {
    // Big enough to read as masonry against a bright sky. The first cut was a
    // 2.4 m block and thirty clusters of them came out as a flock of birds.
    const s = 4.6 - i * 0.9
    const y = 11 + i * 7.5
    const x = (rnd() - 0.5) * 5.5, z = (rnd() - 0.5) * 5.5
    parts.push(part(new THREE.TetrahedronGeometry(s, 0), i % 2 === 0 ? STONE_LIT : STONE,
      xf(x, y, z, rnd() * 3.1, rnd() * 1.2, rnd() * 1.2)))
    parts.push(part(new THREE.TetrahedronGeometry(s * 0.52, 0), GOLD_HI,
      xf(x, y, z, rnd() * 3.1, rnd() * 1.2, rnd() * 1.2)))
  }
  return merge(parts)
}

/**
 * Hero prop 5 — TERRACE. The low clutter element, and the thing that keeps the
 * city floor from reading as a bedsheet: a run of dressed courses with a gold
 * coping, a fallen column drum beside it, and the dust that has banked against
 * the up-wind face.
 */
function propTerrace(p: Palette, seg: number): THREE.BufferGeometry {
  void p
  const [radial] = shaftLod(seg)
  const rnd = mulberry32(0x7e44a)
  const parts: THREE.BufferGeometry[] = []
  let y = 0
  let w = 9.4
  // NINE METRES, not three. The barrier stands 3 m over a road whose verge is
  // only about 1.5 m below it, so anything under about 6 m tall at the
  // clearance line is a prop nobody will ever see. The first cut of this one
  // was a 3.5 m bench: eleven thousand triangles, all of them behind a wall.
  for (let i = 0; i < 3; i++) {
    const h = 3.6 - i * 0.7
    parts.push(part(new THREE.BoxGeometry(w, h, 4.0 + rnd() * 1.4),
      i === 0 ? STONE_DUSK : STONE, xf((rnd() - 0.5) * 0.8, y + h / 2, (rnd() - 0.5) * 0.7)))
    y += h
    w *= 0.88
  }
  parts.push(part(new THREE.BoxGeometry(w * 1.06, 0.22, 3.2), GOLD, xf(0, y + 0.1, 0)))
  // A fallen drum, on its side. The one piece of ruin on a planet that is
  // otherwise conspicuously intact, and the cheapest curve in the catalogue:
  // six sides, because at 150 instances every face is 150 faces.
  parts.push(part(new THREE.CylinderGeometry(1.2, 1.2, 2.6, Math.min(6, radial), 1, false),
    STONE_DUSK, xf(-5.4, 1.2, 2.8, 0.4, 0, Math.PI / 2)))
  return merge(parts)
}

/**
 * Hero prop 6 — CITY SPIRE. The skyline element, and the answer to the track's
 * own note that the point of the causeway is that you can see the next tier of
 * the city above you. A stepped tower with a fluted drum on top and a keystone
 * over that; 42 m at scale 1 and up to 71 m scattered.
 */
function propSpire(p: Palette, seg: number): THREE.BufferGeometry {
  void p
  const [radial, rings] = shaftLod(seg)
  const parts: THREE.BufferGeometry[] = []
  let y = 0
  let w = 11.5
  for (let i = 0; i < 4; i++) {
    const h = 6.5 - i * 0.9
    parts.push(part(new THREE.BoxGeometry(w, h, w * 0.94),
      i % 2 === 0 ? STONE : STONE_DUSK, xf(0, y + h / 2, 0, i * 0.16)))
    y += h
    w *= 0.82
  }
  parts.push(part(new THREE.BoxGeometry(w * 1.35, 0.5, w * 1.35), GOLD, xf(0, y + 0.25, 0)))
  parts.push(flutedShaft(y + 0.5, y + 17.5, w * 0.44, w * 0.30, radial, Math.max(2, rings - 1),
    STONE, STONE_LIT))
  parts.push(part(new THREE.CylinderGeometry(w * 0.42, w * 0.30, 0.9, radial, 1, true),
    GOLD, xf(0, y + 17.9, 0)))
  parts.push(part(new THREE.TetrahedronGeometry(2.6, 0), STONE_LIT, xf(0, y + 23.5, 0, 0.7, 0.5)))
  return merge(parts)
}

/* ------------------------------------------------------- the calligraphy */

/** Accumulator for glyph ribbons: raw positions, raw colours, raw indices. */
interface GlyphBuf { p: number[]; c: number[]; i: number[] }
function glyphBuffer(): GlyphBuf { return { p: [], c: [], i: [] } }

/**
 * A glyph is a set of strokes; a stroke is a set of control points on a unit
 * page, run through a Catmull-Rom. Curves and hooks only — nothing here closes
 * into a box, because a box is a circuit trace and this is meant to be writing.
 */
type Stroke = [number, number][]
const GLYPHS: Stroke[][] = [
  [
    [[0.08, 0.80], [0.34, 0.96], [0.66, 0.82], [0.60, 0.50]],
    [[0.60, 0.50], [0.34, 0.30], [0.62, 0.08]],
    [[0.86, 0.72], [0.92, 0.36], [0.74, 0.14]],
  ],
  [
    [[0.10, 0.14], [0.22, 0.62], [0.50, 0.90], [0.80, 0.66]],
    [[0.80, 0.66], [0.88, 0.34], [0.58, 0.20]],
    [[0.30, 0.44], [0.62, 0.48]],
  ],
  [
    [[0.12, 0.92], [0.30, 0.52], [0.20, 0.14]],
    [[0.20, 0.14], [0.56, 0.20], [0.78, 0.52], [0.92, 0.90]],
    [[0.44, 0.72], [0.68, 0.62]],
  ],
  [
    [[0.16, 0.20], [0.46, 0.36], [0.52, 0.86]],
    [[0.52, 0.86], [0.78, 0.94], [0.90, 0.60], [0.66, 0.44]],
    [[0.18, 0.62], [0.38, 0.58]],
  ],
  [
    [[0.10, 0.52], [0.38, 0.92], [0.72, 0.86], [0.86, 0.52]],
    [[0.86, 0.52], [0.70, 0.16], [0.30, 0.10]],
    [[0.48, 0.66], [0.50, 0.34]],
  ],
  [
    [[0.14, 0.10], [0.26, 0.56], [0.56, 0.88]],
    [[0.56, 0.88], [0.88, 0.72], [0.70, 0.36], [0.36, 0.30]],
    [[0.74, 0.16], [0.92, 0.24]],
  ],
]

/** Catmull-Rom through a control polyline, clamped at the ends. */
function crAt(pts: Stroke, t: number): [number, number] {
  const n = pts.length
  if (n === 2) {
    return [pts[0][0] + (pts[1][0] - pts[0][0]) * t, pts[0][1] + (pts[1][1] - pts[0][1]) * t]
  }
  const f = t * (n - 1)
  const i = Math.min(n - 2, Math.floor(f))
  const u = f - i
  const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n - 1, i + 2)]
  const c = (a: number, b: number, cc: number, d: number): number =>
    0.5 * ((2 * b) + (-a + cc) * u + (2 * a - 5 * b + 4 * cc - d) * u * u
      + (-a + 3 * b - 3 * cc + d) * u * u * u)
  return [c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1])]
}

/** Broad-nib angle, on the page. A stroke running along it is a hairline. */
const NIB = [Math.cos(1.05), Math.sin(1.05)] as const
/** Samples per stroke. Five quads a stroke is enough for a curve to read. */
const PEN_STEPS = 6

/**
 * Write one glyph into `buf`, mapped onto a face: `o` is the page's origin
 * corner and `du`, `dv` are its two axes as vectors, in world space or in a
 * prop's local space.
 *
 * `du x dv` IS THE DIRECTION THE SCRIPT LOOKS, and both things that matter
 * follow from it: the ribbon is lifted 6 cm along it so it can never z-fight
 * the stone it is written on, and the quads come out wound so that face is
 * the front one. (The stroke ribbon's own winding works out to exactly
 * `du x dv` — the tangent and the ribbon normal are a page basis rotated 90
 * degrees, and a rotation does not change the sign of a cross product.) A
 * caller who wants the other side of the same slab passes du negated.
 *
 * Three vertices across the ribbon, not two: the outer pair carry a fraction
 * of the core's brightness, which is what gives a stroke a soft edge without
 * a texture and stops the bloom fusing a whole glyph into a blob.
 */
function writeGlyph(
  buf: GlyphBuf, glyph: Stroke[],
  o: [number, number, number], du: [number, number, number], dv: [number, number, number],
  width: number, gain: number,
): void {
  const nx = du[1] * dv[2] - du[2] * dv[1]
  const ny = du[2] * dv[0] - du[0] * dv[2]
  const nz = du[0] * dv[1] - du[1] * dv[0]
  const nl = Math.hypot(nx, ny, nz) || 1
  const LIFT = 0.06
  const ox = o[0] + (nx / nl) * LIFT
  const oy = o[1] + (ny / nl) * LIFT
  const oz = o[2] + (nz / nl) * LIFT

  for (const strokePts of glyph) {
    const start = buf.p.length / 3
    for (let s = 0; s < PEN_STEPS; s++) {
      const t = s / (PEN_STEPS - 1)
      const [px, py] = crAt(strokePts, t)
      const [ax, ay] = crAt(strokePts, Math.min(1, t + 0.06))
      const [bx, by] = crAt(strokePts, Math.max(0, t - 0.06))
      let tx = ax - bx, ty = ay - by
      const tl = Math.hypot(tx, ty) || 1
      tx /= tl; ty /= tl
      // THE PEN. Width is the sine of the angle between the stroke direction
      // and the nib, so a stroke across the nib is fat and one along it is a
      // hairline. Plus a taper so a stroke starts and ends on a point.
      const cross = Math.abs(tx * NIB[1] - ty * NIB[0])
      const taper = Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, t))), 0.35)
      const w = width * (0.18 + 0.92 * cross) * (0.30 + 0.70 * taper)
      // Ribbon normal on the page.
      const rx = -ty * w, ry = tx * w
      for (let e = -1; e <= 1; e++) {
        const qx = px + rx * e, qy = py + ry * e
        buf.p.push(
          ox + du[0] * qx + dv[0] * qy,
          oy + du[1] * qx + dv[1] * qy,
          oz + du[2] * qx + dv[2] * qy,
        )
        const b = (e === 0 ? 1.0 : 0.30) * gain * (0.55 + 0.45 * taper)
        buf.c.push(b, b, b)
      }
    }
    for (let s = 0; s < PEN_STEPS - 1; s++) {
      const a = start + s * 3
      const b = a + 3
      buf.i.push(a, b, a + 1, a + 1, b, b + 1)
      buf.i.push(a + 1, b + 1, a + 2, a + 2, b + 1, b + 2)
    }
  }
}

/**
 * Turn an accumulated glyph buffer into geometry, tinted with the accent and
 * scaled by `gain`. Above 1.0 the colour is past the bloom threshold, which is
 * what makes light-in-stone read as light rather than as teal paint.
 */
function glyphGeometry(buf: GlyphBuf, hex: number, gain: number): THREE.BufferGeometry {
  const base = new THREE.Color().setHex(hex)
  const n = buf.p.length / 3
  const col = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const b = buf.c[i * 3] * gain
    col[i * 3] = base.r * b; col[i * 3 + 1] = base.g * b; col[i * 3 + 2] = base.b * b
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf.p), 3))
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  g.setIndex(n > 65535
    ? new THREE.BufferAttribute(new Uint32Array(buf.i), 1)
    : new THREE.BufferAttribute(new Uint16Array(buf.i), 1))
  // Needed only where a glyph is merged into a lit prop (the stele), but
  // supplied always: `mergeGeometries` refuses a batch whose attribute sets
  // differ, and that is not a failure worth rediscovering per call site.
  g.computeVertexNormals()
  g.computeBoundingSphere()
  return g
}

/* ------------------------------------------------------- the ribbon frame */

const _bx = new THREE.Vector3()
const _by = new THREE.Vector3()
const _bz = new THREE.Vector3()

/**
 * A local transform expressed in the ROAD's own frame: +X is the banked
 * lateral, +Y is the road's up, +Z is BACKWARD along the track.
 *
 * Backward rather than forward because `(right, normal, tangent)` is a
 * left-handed triple — `normal` is defined as `right x tangent` — and feeding
 * a left-handed basis to `makeBasis` mirrors the geometry and inverts every
 * face. Negating one axis fixes the handedness; the same trick Rustfall's
 * cargo ring uses, and the reason its local +Z points down the track.
 */
function onRoad(smp: TrackSample, local: THREE.Matrix4): THREE.Matrix4 {
  _bx.set(smp.right.x, smp.right.y, smp.right.z)
  _by.set(smp.normal.x, smp.normal.y, smp.normal.z)
  _bz.set(-smp.tangent.x, -smp.tangent.y, -smp.tangent.z)
  const m = new THREE.Matrix4().makeBasis(_bx, _by, _bz)
  m.setPosition(smp.pos.x, smp.pos.y, smp.pos.z)
  return m.multiply(local)
}

/** A direction in the road's own frame, rotated into world space. */
function roadDir(smp: TrackSample, x: number, y: number, z: number): [number, number, number] {
  return [
    smp.right.x * x + smp.normal.x * y - smp.tangent.x * z,
    smp.right.y * x + smp.normal.y * y - smp.tangent.y * z,
    smp.right.z * x + smp.normal.z * y - smp.tangent.z * z,
  ]
}

/** A point in the road's own frame, in world space. */
function roadPos(smp: TrackSample, x: number, y: number, z: number): [number, number, number] {
  const d = roadDir(smp, x, y, z)
  return [smp.pos.x + d[0], smp.pos.y + d[1], smp.pos.z + d[2]]
}

/**
 * The first lateral at or outside `want` where a `2 * along` metre wall of
 * half-thickness `radius`, laid along the tangent, clears the whole
 * centreline. -1 if there is none within `reach`.
 *
 * TESTED AT BOTH ENDS AS WELL AS THE MIDDLE, which is not fussiness. A terrace
 * course is a 25 m box laid tangent to a corner; on a 60 m radius its ends
 * swing 1.3 m inboard of its own centre, and the fit test duly found one 0.68 m
 * inside the forgiving edge in the Glyph Steps. A single-point clearance test
 * is only honest about a prop that is round.
 *
 * A landmark authored at a fixed lateral is also a landmark that silently
 * vanishes the moment a corner comes within its own width of another part of
 * the lap. Walking outward keeps the piece, moves it as little as the geometry
 * allows, and gives up honestly if the yard is genuinely too narrow.
 */
function clearLateral(
  ctx: ThemeContext, smp: TrackSample, side: number,
  want: number, radius: number, along = 0, reach = 26,
): number {
  const tl = Math.hypot(smp.tangent.x, smp.tangent.z) || 1
  const rx = (smp.tangent.z / tl) * side, rz = (-smp.tangent.x / tl) * side
  const tx = smp.tangent.x / tl, tz = smp.tangent.z / tl
  for (let d = 0; d <= reach; d += 1.5) {
    const lat = want + d
    let ok = true
    for (const f of [-along, 0, along]) {
      if (!ctx.clearOfTrack(smp.pos.x + rx * lat + tx * f, smp.pos.z + rz * lat + tz * f, radius)) {
        ok = false
        break
      }
    }
    if (ok) return lat
  }
  return -1
}

/** Unit horizontal right for a sample, for anything that stands on GROUND. */
function planRight(smp: TrackSample): [number, number] {
  const tl = Math.hypot(smp.tangent.x, smp.tangent.z) || 1
  return [smp.tangent.z / tl, -smp.tangent.x / tl]
}

/* ------------------------------------------------------------ the sweep */

/** One point of a swept cross-section, in the road's own (lateral, up) frame. */
interface SectionPoint { lat: number; up: number; col: number }

/**
 * Sweep a closed cross-section along a run of the ribbon.
 *
 * This is the one piece of machinery three landmarks share: the causeway's
 * arched soffit, the rotunda's masonry drum and the plaza dais are the same
 * function with different profiles. It works entirely in the ribbon's own
 * banked frame — `lat` is the banked lateral and `up` is along the road's
 * normal — so a section authored at `corridor(width) + pad` follows the road
 * at whatever width it is authored to, and on the rotunda's vertical wall
 * "lateral" correctly means UP THE WALL without a single special case.
 *
 * PROFILE POINTS MUST BE LISTED COUNTER-CLOCKWISE in the (lat, up) plane. The
 * winding is not decorative: `normal` is `right x tangent`, so a profile edge
 * running in -lat produces a face pointing along +normal, and one listed the
 * other way round gives a shell you can only see from inside.
 */
function sweepRibbon(
  ctx: ThemeContext, iFrom: number, iTo: number, stride: number,
  section: (smp: TrackSample, u: number) => SectionPoint[],
): THREE.BufferGeometry {
  const { track } = ctx
  const m = track.samples.length
  const span = ((iTo - iFrom) % m + m) % m
  const rings = Math.max(2, Math.floor(span / stride))
  const pos: number[] = []
  const col: number[] = []
  const idx: number[] = []
  const c = new THREE.Color()
  let P = 0

  for (let r = 0; r <= rings; r++) {
    const u = r / rings
    const smp = track.samples[(iFrom + Math.round(u * span)) % m]
    const sec = section(smp, u)
    P = sec.length
    for (let j = 0; j < P; j++) {
      const sp = sec[j]
      pos.push(
        smp.pos.x + smp.right.x * sp.lat + smp.normal.x * sp.up,
        smp.pos.y + smp.right.y * sp.lat + smp.normal.y * sp.up,
        smp.pos.z + smp.right.z * sp.lat + smp.normal.z * sp.up,
      )
      // PER-FACET JITTER, and the drum does not read without it. A swept shell
      // is flat-shaded, but every facet of a 54 m cylinder faces within six
      // degrees of its neighbour, so the light rig gives them essentially no
      // separation and 90 m of masonry came back as one smooth brown field. A
      // deterministic value break per ring turns the same triangles into
      // courses of blocks. Cryostatic's cavern needed the identical trick.
      const jit = 0.72 + 0.52 * ((((Math.sin(r * 12.9898 + j * 78.233) * 43758.5453) % 1) + 1) % 1)
      c.setHex(sp.col).multiplyScalar(jit)
      col.push(c.r, c.g, c.b)
    }
  }
  for (let r = 0; r < rings; r++) {
    const a0 = r * P, b0 = (r + 1) * P
    for (let j = 0; j < P; j++) {
      const j1 = (j + 1) % P
      idx.push(a0 + j, b0 + j, a0 + j1, a0 + j1, b0 + j, b0 + j1)
    }
  }
  // Mouth caps, fanned from the first profile point. The start cap's outward
  // normal is -tangent, which a CCW fan gives directly; the end cap is the
  // same fan wound the other way.
  const last = rings * P
  for (let j = 1; j < P - 1; j++) {
    idx.push(0, j, j + 1)
    idx.push(last, last + j + 1, last + j)
  }

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3))
  g.setIndex(pos.length / 3 > 65535
    ? new THREE.BufferAttribute(new Uint32Array(idx), 1)
    : new THREE.BufferAttribute(new Uint16Array(idx), 1))
  g.computeVertexNormals()
  g.computeBoundingSphere()
  return g
}

/* ----------------------------------------------------- the floating shader */

/**
 * EVERY UNTETHERED THING ON THE PLANET, IN ONE DRAW CALL.
 *
 * The gatehouse keystone, the warp gate's keystone and its broken ring, the
 * orrery's four armillary rings and their core, and the two counter-turning
 * layers of Keystone Plaza are all the same mesh. Each vertex carries the
 * pivot it turns about, the axis it turns on and its rate, and the vertex
 * shader does a Rodrigues rotation before anything else touches the position.
 *
 * The alternative is eleven meshes with eleven matrices updated per frame, and
 * eleven draw calls for objects that are collectively two thousand triangles.
 * Injected into a MeshStandardMaterial rather than written as a ShaderMaterial
 * so the stone still takes the light rig, the fog and the tone mapping for
 * free — the same reason trackMesh.ts shades the road the way it does.
 *
 * Flat-shaded on purpose as well as for looks: three derives a flat normal
 * from the DEFORMED position in the fragment shader, so a deformation applied
 * only to the position stays consistent and no normal has to be rotated here.
 */
const FLOAT_PARS = /* glsl */`
attribute vec3 aPivot;
attribute vec3 aAxis;
attribute vec2 aSpin;   // x: rad/s, y: bob phase
uniform float uTime;
`
const FLOAT_BODY = /* glsl */`
vec3 _rel = position - aPivot;
float _a = uTime * aSpin.x;
float _c = cos(_a), _s = sin(_a);
_rel = _rel * _c + cross(aAxis, _rel) * _s + aAxis * dot(aAxis, _rel) * (1.0 - _c);
vec3 transformed = _rel + aPivot
  + vec3(0.0, sin(uTime * 0.31 + aSpin.y) * 0.85, 0.0);
`

/** Accumulator for the floaters mesh. */
interface FloatBuf {
  parts: THREE.BufferGeometry[]
  pivot: number[]; axis: number[]; spin: number[]
}
function floatBuffer(): FloatBuf { return { parts: [], pivot: [], axis: [], spin: [] } }

/** Add one geometry to the floaters mesh, turning about `p` at `rate` rad/s. */
function addFloat(
  buf: FloatBuf, geo: THREE.BufferGeometry,
  p: [number, number, number], axis: [number, number, number], rate: number, bob: number,
): void {
  const al = Math.hypot(axis[0], axis[1], axis[2]) || 1
  const n = geo.getAttribute('position').count
  for (let i = 0; i < n; i++) {
    buf.pivot.push(p[0], p[1], p[2])
    buf.axis.push(axis[0] / al, axis[1] / al, axis[2] / al)
    buf.spin.push(rate, bob)
  }
  buf.parts.push(geo)
}

/* -------------------------------------------------------- the light-bridges */

/**
 * THE CAUSEWAY, AND THE ONE THING THE ART HAS TO SAY ABOUT IT.
 *
 * The sim's contract is `bridgeSolid(phase, raceTime)` in `sim/track.ts`: a
 * span is deck while `fract(t / bridgePeriod + phase) < bridgeDuty` and is
 * nothing at all the rest of the cycle. It takes no racer, no RNG and no
 * accumulated state, which is what makes two clients agree — and it is also
 * what lets the art read it without a back-channel, because the shader below
 * evaluates THE SAME PREDICATE from THE SAME TUNING CONSTANTS against the race
 * time the environment is already handed. `Track.bridges` supplies the spans;
 * `bridgeSolid` itself is called on the CPU once a frame, purely to cull the
 * void skin when every span is up.
 *
 * ---------------------------------------------------------------------------
 * A SPAN NOW DROPS ONE HALF OF ITS DECK, AND THE ART'S JOB CHANGED WITH IT.
 *
 * The old message was "this span is going", and every channel said it the same
 * way because there was only one thing to say. Now the deck under one half goes
 * and the deck under the other half never does, so the message is "THIS SIDE is
 * going" and a warning that does not name a side is worse than no warning: it
 * tells a driver to act without telling them which way.
 *
 * So every element that carries the state is split at the centreline and given
 * its OWN phase attribute -- the span's beat on the half that drops, and -1
 * (permanent) on the half that stays. The shader arithmetic is untouched; it is
 * the same `fract(t / period + phase) < duty` the sim's `bridgeSolid` runs,
 * evaluated once per half instead of once per span. The surviving half feeds it
 * -1 and gets `solid = 1` forever, which is exactly what the physics does with
 * the same number, so the two cannot disagree about a wheel.
 *
 * And a FLASH goes in front of the existing two warning stages, because those
 * two were tuned to say "going" and this one has to say "this side". A stutter
 * and a craze are textures; a half of the road strobing against a half that is
 * not is a SHAPE, and shape is what survives 50 m of fog and a 1.4 s glance.
 * ---------------------------------------------------------------------------
 *
 * Four states, and all four have to be readable from the far end of a 340 m
 * causeway at 52 m/s:
 *
 *   SOLID     the lattice under the deck is lit and steady, and the pylon
 *             lamps at both ends of the span are on. Both halves look the same,
 *             because both halves are road.
 *   FLASH     from T.hazard.bridgeFlashLead (0.30 of a cycle, 0.96 s, 50 m) the
 *             half that is going washes teal and PULSES, at a rate that ramps
 *             from about 4 Hz to 11 Hz as the window runs out, with a hard
 *             bright seam down the centreline separating it from the half that
 *             is staying. This is the lane call and it is the only stage that
 *             makes one.
 *   WARNING   the two stages that were already here, now restricted to the half
 *             that is going. From 0.28 of a cycle out the lattice UNDER THAT
 *             HALF stutters and a bright band runs the length of it. From 0.22
 *             out that half's deck crazes: a web of teal fracture that starts
 *             at both ends of the span, runs inward and meets in the middle,
 *             cubed in time so it is barely there at first and unmistakable by
 *             the end. The crazing is the texture under the flash's shape.
 *   GONE      that half's lattice is not drawn, its pylon lamps are out, and
 *             its deck skin goes to the violet of the drop under it -- against
 *             the other half, still lit, still road, still the line through.
 *
 * The one thing this cannot do is take the ROAD RIBBON away: the ribbon is
 * `trackMesh.ts`, one merged chunk mesh with no per-span control, and a theme
 * may not reach into it. The void skin is the honest workaround -- an opaque
 * decal a hand's width above the deck, drawn only while the span is absent --
 * and it is a decal rather than a hole.
 */
const BRIDGE_PARS = /* glsl */`
uniform float uTime;
uniform float uPeriod;
uniform float uDuty;
attribute float aPhase;
attribute float aU;
varying float vLive;
varying float vU;
varying float vWarn;

void sgBridge() {
  // aPhase < 0 is the half that never goes -- the sim's own convention for
  // permanent deck, fed here so the surviving half's structure is lit steadily
  // and forever without a second code path.
  if (aPhase < 0.0) {
    vLive = 1.0;
    vWarn = 0.0;
    vU = aU;
    return;
  }
  float u = fract(uTime / uPeriod + aPhase);
  float solid = step(u, uDuty);
  // Materialise: a hard snap in over the first 4% of the solid window.
  float on = smoothstep(0.0, 0.035, u);
  // Warning stage one: the last 0.28 of the solid window, ramping. The deck's
  // own crazing (VOID_FRAG) starts a little later, at 0.22, so the structure
  // gives away that it is going before the surface does.
  vWarn = solid * smoothstep(uDuty - 0.28, uDuty - 0.02, u);
  vLive = solid * on;
  vU = aU;
}
`

const BRIDGE_VERT = /* glsl */`
#include <fog_pars_vertex>
${BRIDGE_PARS}
void main() {
  sgBridge();
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`

const BRIDGE_FRAG = /* glsl */`
#include <fog_pars_fragment>
uniform vec3 uColor;
uniform float uTime;
varying float vLive;
varying float vU;
varying float vWarn;

void main() {
  if (vLive < 0.01) discard;
  // Steady light along the span, with a slow travelling swell so a solid
  // bridge is alive rather than a painted stripe.
  float base = 0.42 + 0.20 * sin(vU * 9.0 - uTime * 1.7);
  // WARNING. A bright band runs the length of the span and the whole lattice
  // stutters faster as the cycle runs out -- the stutter is the part that
  // reads in peripheral vision, which is where a driver's edges live.
  float band = exp(-pow((fract(vU - uTime * 0.9) - 0.5) * 4.0, 2.0));
  float flick = 0.5 + 0.5 * sin(uTime * (9.0 + 34.0 * vWarn) + vU * 3.0);
  float a = base * mix(1.0, 0.28 + 0.72 * flick, vWarn) + band * vWarn * 1.1;
  vec3 c = uColor * a * (1.0 + 1.6 * vWarn);
  float alpha = clamp(a * (0.42 + 0.58 * vWarn), 0.0, 1.0) * vLive;
  gl_FragColor = vec4(c, alpha);
  // Additive under fog has to LOSE light rather than mix toward the fog
  // colour, or a span at the far end of the causeway glows brighter for being
  // further away.
  #ifdef USE_FOG
    float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    gl_FragColor.rgb *= 1.0 - fogF;
    gl_FragColor.a *= 1.0 - fogF;
  #endif
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

const VOID_VERT = /* glsl */`
#include <fog_pars_vertex>
uniform float uTime;
uniform float uPeriod;
uniform float uDuty;
uniform float uFlashLead;
attribute float aPhase;
attribute float aOther;
attribute vec2 aUv;
varying float vGone;
varying float vCraze;
varying float vFlash;
varying float vPulse;
varying float vMine;
varying vec2 vQ;
void main() {
  vQ = aUv;
  // BOTH HALVES COMPUTE THE SPAN'S STATE; only one of them paints it.
  //
  // Each half-quad carries its own phase and its partner's, and exactly one of
  // the pair is >= 0 -- the half that drops. max() picks that one out without a
  // branch, so the surviving half knows precisely when its neighbour is going
  // and can draw its side of the seam. vMine is which of the two this is.
  float pDrop = max(aPhase, aOther);
  vMine = step(0.0, aPhase);
  float u = fract(uTime / uPeriod + pDrop);
  // Gone: the whole window the sim says there is no deck, faded in fast.
  vGone = (1.0 - step(u, uDuty)) * smoothstep(uDuty, uDuty + 0.03, u);
  // Crazing: the last 0.22 of the SOLID window -- 0.70 s, about 37 m at the
  // speed the wave is tuned for. Cubed rather than smoothstepped, so it is
  // barely there for the first half of that and unmistakable by the end: a
  // tell that arrives fully formed is a jump-scare, not a warning.
  float cz = clamp((u - (uDuty - 0.22)) / 0.22, 0.0, 1.0);
  vCraze = step(u, uDuty) * cz * cz * cz;
  // THE FLASH, and the one stage that names a side. Ramped hard rather than
  // cubed: the craze is a texture that should creep in, this is a signal that
  // should be at full strength almost as soon as it starts, because a lane call
  // that fades up is a lane call you notice too late to take.
  float fz = clamp((u - (uDuty - uFlashLead)) / uFlashLead, 0.0, 1.0);
  vFlash = step(u, uDuty) * smoothstep(0.0, 0.12, fz);
  // How far through the flash window this half is, 0 -> 1. The blink is driven
  // from THIS and not from uTime -- see VOID_FRAG.
  vPulse = fz;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`

const VOID_FRAG = /* glsl */`
#include <fog_pars_fragment>
uniform vec3 uColor;
uniform vec3 uVoid;
uniform float uTime;
varying float vGone;
varying float vCraze;
varying float vFlash;
varying float vPulse;
varying float vMine;
varying vec2 vQ;

float h21(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.7);
  return fract(p.x * p.y);
}

void main() {
  // vQ.y runs 0 at the SEAM to 1 at the outer edge, per half-quad. The seam
  // line is therefore the same strip of pixels on both halves and lands exactly
  // on the centreline where the physics puts it -- see onDroppingHalf().
  float seam = 1.0 - smoothstep(0.0, 0.05, vQ.y);
  // The seam is drawn on BOTH halves whenever the dropping one has anything to
  // say, which is why the surviving half's quad is in this mesh at all. A line
  // with one lit side is an edge; a line with a lit side and a dark side is a
  // boundary, and a boundary is what a driver needs to place a car against.
  float seamLit = max(max(vFlash, vCraze), vGone);
  if (vMine < 0.5) {
    // The surviving half: nothing but its side of the seam, and that only while
    // the other half is saying something.
    float a = seam * seamLit * 0.85;
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColor * 2.2 * a, a);
    #ifdef USE_FOG
      #include <fog_fragment>
    #endif
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    return;
  }
  if (vGone < 0.004 && vCraze < 0.004 && vFlash < 0.004) discard;
  // A web of fracture, cellular rather than gridded: distance to the second
  // nearest of a jittered point set is a crack, and a crack is what stone
  // about to stop existing does.
  vec2 g = vQ * vec2(7.0, 3.0);
  vec2 i = floor(g), f = fract(g);
  float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 p = o + vec2(h21(i + o), h21(i + o + 17.3)) - f;
      float d = dot(p, p);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  }
  float crack = 1.0 - smoothstep(0.0, 0.045, sqrt(d2) - sqrt(d1));
  // The crazing starts at both ENDS of the span, where the light deck meets
  // the stone, and runs inward to meet in the middle -- so which way the span
  // is going is legible as well as that it is going.
  float ends = abs(vQ.x - 0.5) * 2.0;
  float grow = smoothstep(1.02 - vCraze * 1.25, 0.98 - vCraze * 1.25, ends);
  float craze = crack * grow * vCraze;

  // THE FLASH. A wash over the WHOLE half, so what reads at distance is the
  // silhouette of one side of the road rather than a detail on it.
  //
  // THREE BLINKS, NOT A STROBE, AND THEY ARE COUNTED IN THE BEAT rather than in
  // seconds: the phase is a function of how far through the flash window the
  // half is, so this blinks exactly three times before it goes, every time, on
  // every span, at any frame rate. A free-running strobe at 4-11 Hz says "alarm"
  // and nothing else; three accelerating blinks say WHEN, and a driver can
  // learn to leave on the third the way they learn to leave on the last light
  // of a countdown. It is also the only version that survives being read on a
  // machine that is dropping frames, because it does not depend on wall time.
  //
  // Squared so each blink spends more of itself dark than lit: a 50% duty
  // signal reads as a brightness, a peaky one reads as an event.
  float ph = 6.2831853 * 3.0 * pow(vPulse, 1.6);
  float pulse = 0.5 - 0.5 * cos(ph);
  pulse *= pulse;
  // Brightest at the seam and falling off outward: the seam is where the
  // decision is, and it puts the strongest edge of the signal exactly on the
  // line the car has to stay the other side of.
  float toSeam = 1.0 - smoothstep(0.0, 0.75, vQ.y);
  float flash = vFlash * pulse * (0.45 + 0.55 * toSeam);

  // WARNING is a bright fracture in a deck that is still there; GONE is a
  // dark hole with the broken edges still faintly lit. The first cut had them
  // the other way round -- the absent span was the brightest thing on the
  // causeway, because a 2.6x accent through the bloom filled the whole
  // footprint with halo and the void underneath never showed at all.
  vec3 c = mix(uVoid, uColor * 1.9, clamp(craze, 0.0, 1.0));
  // The flash LIGHTS the road; it does not replace it. Its alpha stays under a
  // half so the tarmac reads through the tint, which is what keeps FLASH and
  // GONE different things to look at -- the first cut washed the half to solid
  // accent and measured 108 of green against GONE's 109, i.e. "about to go" and
  // "gone" were the same photograph.
  c = mix(c, uColor * 1.35, clamp(flash * 0.8, 0.0, 1.0));
  c = mix(c, uVoid + uColor * crack * 0.24, vGone);
  // The seam line sits on top of every state including GONE, where it is the
  // lit edge of the hole and the thing that says the road resumes here.
  c = mix(c, uColor * 2.6, seam * seamLit);
  float a = clamp(vGone + craze * 0.85 + flash * 0.40, 0.0, 1.0);
  a = max(a, seam * seamLit * 0.9);
  gl_FragColor = vec4(c, a);
  #ifdef USE_FOG
    #include <fog_fragment>
  #endif
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/* --------------------------------------------------------------- landmarks */

/** Clearance between anything this theme builds and the protected corridor. */
const PAD = 1.2

/**
 * A monumental gate straddling the road, with a floating keystone in a crown
 * that is deliberately not closed.
 *
 * Nothing here is an absolute lateral: the jambs stand at `corridor(width)`
 * plus their own half-thickness, the voussoirs spring from the jambs' inner
 * faces, and the crown rides the span — so the gate keeps the proportion it
 * was drawn with at 16 m of half-width or at 26. The arch's lowest stone sits
 * at `spring` metres over the road, which is what keeps the whole thing out of
 * the 5 m airspace band the environment fit test guards.
 */
function buildGate(
  ctx: ThemeContext, smp: TrackSample, stone: THREE.BufferGeometry[], floats: FloatBuf,
  o: { jamb: number; height: number; spring: number; crown: number; keystone: number; ring: boolean },
): void {
  const half = ctx.corridor(smp.width) + PAD
  const jx = half + o.jamb / 2
  const [prx, prz] = planRight(smp)
  // Feet reach to the graded verge under the deeper of the two jambs.
  let drop = 2.0
  for (const side of [-1, 1]) {
    const g = ctx.ground(smp.pos.x + prx * side * jx, smp.pos.z + prz * side * jx)
    drop = Math.max(drop, smp.pos.y - g.y + 1.0)
  }
  const H = o.height + drop
  for (const side of [-1, 1]) {
    const x = side * jx
    stone.push(part(new THREE.BoxGeometry(o.jamb, H, o.jamb * 1.5), STONE,
      onRoad(smp, xf(x, H / 2 - drop, 0))))
    stone.push(part(new THREE.BoxGeometry(o.jamb * 1.25, 1.5, o.jamb * 1.8), STONE_DUSK,
      onRoad(smp, xf(x, -drop + 0.75, 0))))
    // Impost band and cornice, both gold: the two horizontals that give a
    // 26 m pier a scale you can read at speed.
    stone.push(part(new THREE.BoxGeometry(o.jamb * 1.18, 0.85, o.jamb * 1.7), GOLD,
      onRoad(smp, xf(x, o.spring, 0))))
    stone.push(part(new THREE.BoxGeometry(o.jamb * 1.3, 1.1, o.jamb * 1.85), STONE_LIT,
      onRoad(smp, xf(x, o.height - 1.4, 0))))
    stone.push(part(new THREE.BoxGeometry(o.jamb * 1.05, 0.22, o.jamb * 1.5), GOLD_HI,
      onRoad(smp, xf(x, o.height - 0.7, 0))))
  }
  // Voussoirs. Odd count with the middle one MISSING; the keystone hangs in
  // the hole it leaves.
  const N = 11
  const rise = o.crown - o.spring
  for (let i = 0; i < N; i++) {
    if (i === (N - 1) / 2) continue
    const th = (i / (N - 1)) * Math.PI
    const cx = Math.cos(th) * half
    const cy = o.spring + Math.sin(th) * rise
    stone.push(part(new THREE.BoxGeometry(half * 0.30, half * 0.24, o.jamb * 1.5),
      i % 2 === 0 ? STONE : STONE_DUSK,
      onRoad(smp, xf(cx, cy, 0, 0, 0, -th + Math.PI / 2))))
  }
  // Architrave over the whole opening.
  stone.push(part(new THREE.BoxGeometry(half * 2 + o.jamb * 2.6, 2.2, o.jamb * 1.9), STONE_DUSK,
    onRoad(smp, xf(0, o.height + 1.1, 0))))
  stone.push(part(new THREE.BoxGeometry(half * 2 + o.jamb * 1.6, 0.5, o.jamb * 2.1), GOLD,
    onRoad(smp, xf(0, o.height + 2.4, 0))))

  // The keystone itself, on the floaters mesh so it turns.
  const kp = new THREE.Vector3(0, o.crown + o.keystone * 0.9, 0).applyMatrix4(onRoad(smp, xf(0, 0, 0)))
  const kAxis: [number, number, number] = [0.24, 1, 0.14]
  addFloat(floats,
    part(new THREE.TetrahedronGeometry(o.keystone, 0), STONE_LIT,
      xf(kp.x, kp.y, kp.z, 0.5, 0.35)),
    [kp.x, kp.y, kp.z], kAxis, 0.22, kp.x * 0.1)
  addFloat(floats,
    part(new THREE.TetrahedronGeometry(o.keystone * 0.55, 0), GOLD_HI,
      xf(kp.x, kp.y, kp.z, 1.9, 0.35)),
    [kp.x, kp.y, kp.z], kAxis, -0.34, kp.x * 0.1)

  /**
   * A broken ring turning in the opening: the warp gate only.
   *
   * SIZED SO ITS BOTTOM IS NOT ON THE ROAD. A ring concentric with the
   * opening has to be either wider than the corridor (which no gate is) or
   * high enough that its lowest arc clears the airspace band -- the first cut
   * was a 19.6 m ring on the road's own centreline and its bottom swept the
   * tarmac at 0.4 m, which the environment fit test reported as 11.7 m inside
   * the forgiving edge. It now hangs in the upper half of the opening, between
   * the springing and the architrave, which is also where a keystone's
   * companion belongs.
   */
  if (o.ring) {
    const R = Math.min(half * 0.42, (o.height - o.spring) * 0.52)
    const cy = o.spring + R + 5.0
    const rp = new THREE.Vector3(0, cy, -half * 0.55).applyMatrix4(onRoad(smp, xf(0, 0, 0)))
    for (let i = 0; i < 7; i++) {
      const a0 = (i / 7) * Math.PI * 2 + 0.12
      const seg = new THREE.TorusGeometry(R, R * 0.085, 4, 7, (Math.PI * 2) / 7 - 0.30)
      const mtx = onRoad(smp, xf(0, cy, -half * 0.55, 0, 0, a0))
      addFloat(floats, part(seg, i % 2 === 0 ? STONE_LIT : GOLD, mtx),
        [rp.x, rp.y, rp.z], [smp.tangent.x, smp.tangent.y, smp.tangent.z], 0.11, 2.0)
    }
  }
}

/* ------------------------------------------------------------------ build */

function landmarks(ctx: ThemeContext): void {
  const { track, quality, palette: pal } = ctx
  // Publish the track/spray pair for the VFX pass; see kit.ts.
  bindSurfaceSpray(track, SPRAY)
  const m = track.samples.length
  const res = track.length / m
  const iOf = (s: number): number => ((Math.round(s / res) % m) + m) % m

  const stone: THREE.BufferGeometry[] = []
  const glyphs = glyphBuffer()
  /** Emissive geometry built directly rather than through the pen. */
  const glyphExtra: THREE.BufferGeometry[] = []
  const floats = floatBuffer()
  const rnd = mulberry32(0xae7401)

  const iGate = ctx.tagSample('gatehouse')
  const iCauseway = ctx.tagSample('causeway')
  const iRot = ctx.tagSample('rotunda')
  const iRotOut = ctx.tagSample('rotunda-out')
  const iWarp = ctx.tagSample('warp-gate')
  const iOrrery = ctx.tagSample('orrery')
  const iOrreryOut = ctx.tagSample('orrery-out')
  const iPlaza = ctx.tagSample('plaza')
  const iPlazaOut = ctx.tagSample('plaza-out')
  const iDescent = ctx.tagSample('descent')
  const iDescentOut = ctx.tagSample('descent-out')
  const iSteps = ctx.tagSample('glyph-steps')
  const iLast = ctx.tagSample('last-corner')

  /* ---- beat 2: the gatehouse ------------------------------------------- */
  //
  // The braking zone at the end of the primary straight, and the first hero
  // arch a player drives through. 30 m of pier either side of a 22 m crown,
  // with the keystone turning in the gap.
  if (iGate >= 0) {
    buildGate(ctx, track.samples[(iGate + 12) % m], stone, floats,
      { jamb: 7.0, height: 27, spring: 12.5, crown: 21.5, keystone: 3.1, ring: false })
    // Script down the INNER face of each pier — the face that looks at the
    // road, so `du x dv` has to point back across the opening.
    const smp = track.samples[(iGate + 12) % m]
    const half = ctx.corridor(smp.width) + PAD
    for (const side of [-1, 1]) {
      writeGlyph(glyphs, GLYPHS[side < 0 ? 0 : 3],
        roadPos(smp, side * half, 13.6, -4.6 * side),
        roadDir(smp, 0, 0, 9.2 * side), roadDir(smp, 0, 9.2, 0),
        0.055, 1.30)
    }
  }

  /* ---- beat 2: the causeway -------------------------------------------- */
  //
  // 340 m of elevated deck over 45 m of air, of which three spans are light.
  // The stone parts get an arched soffit so the deck reads as architecture
  // rather than as a ribbon in the sky; the light parts get the lattice, the
  // pylon lamps and the deck skin.
  const bridges = track.bridges
  if (iCauseway >= 0 && bridges.length > 0) {
    // Solid runs: the open deck minus the phasing spans.
    let iA = -1, iB = -1
    for (let i = 0; i < m; i++) {
      if (!track.samples[i].open) continue
      // The causeway's own open run, not the warp gate's.
      const d = ((i - iCauseway) % m + m) % m
      if (d > 260) continue
      if (iA < 0) iA = i
      iB = i
    }
    const cuts: [number, number][] = []
    let cursor = iA
    for (const b of bridges) {
      const s0 = iOf(b.s0), s1 = iOf(b.s1)
      if (cursor < s0) cuts.push([cursor, s0])
      cursor = s1
    }
    if (cursor < iB) cuts.push([cursor, iB])

    for (const [a, b] of cuts) {
      if (b - a < 6) continue
      stone.push(sweepRibbon(ctx, a, b, 9, (smp) => {
        const L = ctx.corridor(smp.width) + PAD
        return [
          { lat: -L, up: -3.4, col: STONE_DUSK },
          { lat: -L * 0.97, up: -7.2, col: STONE_DEEP },
          { lat: -L * 0.54, up: -10.2, col: STONE_DEEP },
          { lat: 0, up: -11.4, col: STONE_DEEP },
          { lat: L * 0.54, up: -10.2, col: STONE_DEEP },
          { lat: L * 0.97, up: -7.2, col: STONE_DEEP },
          { lat: L, up: -3.4, col: STONE_DUSK },
        ]
      }))
    }

    /* -- pylons and the light-bridges ---------------------------------- */
    const latt = { p: [] as number[], c: [] as number[], i: [] as number[], ph: [] as number[], u: [] as number[] }
    const skin = {
      p: [] as number[], i: [] as number[], ph: [] as number[], other: [] as number[], uv: [] as number[],
    }
    const tealCol = new THREE.Color().setHex(pal.accent)

    for (const b of bridges) {
      const s0 = iOf(b.s0), s1 = iOf(b.s1)
      // A rib every ~4 m: close enough that the frame reads as a structure at
      // 52 m/s rather than as four bars.
      const nSeg = Math.max(6, Math.round((s1 - s0) * res / 4))

      /* Pylons at both ends. Stone, with a lamp head that belongs to the
       * lattice mesh so it reads the span's own state. */
      for (const end of [s0, s1]) {
        const smp = track.samples[end % m]
        const half = ctx.corridor(smp.width) + PAD
        for (const side of [-1, 1]) {
          const x = side * (half + 2.2)
          stone.push(part(new THREE.BoxGeometry(4.2, 15.5, 5.0), STONE,
            onRoad(smp, xf(x, 6.2, 0))))
          stone.push(part(new THREE.BoxGeometry(5.4, 1.4, 6.2), STONE_LIT,
            onRoad(smp, xf(x, 14.3, 0))))
          stone.push(part(new THREE.BoxGeometry(4.6, 0.35, 5.4), GOLD_HI,
            onRoad(smp, xf(x, 15.1, 0))))
          // The pier below the deck, tapering into the trench.
          stone.push(part(new THREE.CylinderGeometry(2.4, 1.1, 16, 6, 1, true), STONE_DUSK,
            onRoad(smp, xf(x, -9.5, 0))))
        }
      }

      /* The lattice: transverse ribs under the deck edges plus two rails,
       * all outside the corridor, all carrying this span's own phase. */
      // THE HALF A PIECE OF STRUCTURE BELONGS TO decides the phase it carries:
      // the span's beat if it hangs under the half that drops, -1 (permanent,
      // the sim's own convention) if it hangs under the half that stays. Every
      // caller below passes the lateral its geometry sits at.
      const phaseAtLat = (lat: number): number =>
        (b.side < 0 ? lat < 0 : lat >= 0) ? b.phase : -1
      const pushQuad = (
        q: typeof latt,
        a: THREE.Vector3, bb: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3,
        u: number, bright: number, phase: number,
      ): void => {
        const base = q.p.length / 3
        for (const v of [a, bb, c, d]) {
          q.p.push(v.x, v.y, v.z)
          q.c.push(tealCol.r * bright, tealCol.g * bright, tealCol.b * bright)
          q.ph.push(phase)
          q.u.push(u)
        }
        q.i.push(base, base + 1, base + 2, base, base + 2, base + 3)
      }
      const at = (smp: TrackSample, lat: number, up: number): THREE.Vector3 => new THREE.Vector3(
        smp.pos.x + smp.right.x * lat + smp.normal.x * up,
        smp.pos.y + smp.right.y * lat + smp.normal.y * up,
        smp.pos.z + smp.right.z * lat + smp.normal.z * up,
      )
      // A RIB IS A BAR, NOT A FLOOR. The first cut hung a 1.6 m deep slab
      // right across the deck every 7 m; additively blended at full gain that
      // is not a lattice, it is a lit ceiling, and from the deck above it the
      // whole causeway glowed. What reads as a bridge made of light is a
      // SPARSE frame: thin bars on a close pitch, dim, with two bright rails
      // at the edges carrying the actual line.
      const RIB = 0.55
      for (let k = 0; k < nSeg; k++) {
        const u = k / nSeg
        const smp = track.samples[(s0 + Math.round(u * (s1 - s0))) % m]
        const L = ctx.corridor(smp.width) + PAD
        const smpR = track.samples[(s0 + Math.round(u * (s1 - s0)) + Math.max(1, Math.round(RIB / res))) % m]
        const LR = ctx.corridor(smpR.width) + PAD
        // THE MIDDLE RIB IS SPLIT AT THE CENTRELINE. It used to run [-0.40,
        // 0.40] straight across the seam, which is one piece of geometry that
        // would have to be both halves at once; a bar that keeps burning under
        // a deck that has gone is the art telling a driver there is road there.
        for (const seg of [[-1, -0.40], [-0.40, 0], [0, 0.40], [0.40, 1]] as const) {
          const y0 = -1.4 - (1 - Math.abs(seg[0])) * 2.6
          const y1 = -1.4 - (1 - Math.abs(seg[1])) * 2.6
          pushQuad(latt,
            at(smp, L * seg[0], y0), at(smp, L * seg[1], y1),
            at(smpR, LR * seg[1], y1), at(smpR, LR * seg[0], y0), u, 0.26,
            phaseAtLat((seg[0] + seg[1]) / 2))
        }
        // Rails: two continuous strips just outside each deck edge. These are
        // the bright element and the one a driver actually steers by.
        const smpN = track.samples[(s0 + Math.round(((k + 1) / nSeg) * (s1 - s0))) % m]
        const LN = ctx.corridor(smpN.width) + PAD
        for (const side of [-1, 1]) {
          pushQuad(latt,
            at(smp, side * L, -0.30), at(smp, side * (L + 0.9), -0.85),
            at(smpN, side * (LN + 0.9), -0.85), at(smpN, side * LN, -0.30),
            u, 0.85, phaseAtLat(side))
        }
      }
      // Pylon lamp heads: four per span end, on the lattice mesh.
      for (const [end, u] of [[s0, 0], [s1, 1]] as const) {
        const smp = track.samples[end % m]
        const half = ctx.corridor(smp.width) + PAD
        for (const side of [-1, 1]) {
          const x = side * (half + 2.2)
          const c0 = at(smp, x - 2.0, 15.4), c1 = at(smp, x + 2.0, 15.4)
          const t = new THREE.Vector3(smp.tangent.x, smp.tangent.y, smp.tangent.z).multiplyScalar(2.6)
          // THE LONGEST-RANGE SIGNAL ON THE CAUSEWAY. Four lamp heads a span,
          // two a side, at 15 m over the deck and clear of the fog band the
          // road itself sits in: from the gatehouse the pylons are the first
          // thing that says which side of the causeway is about to go, before
          // any of it is close enough to read as a surface.
          pushQuad(latt,
            c0.clone().sub(t), c1.clone().sub(t), c1.clone().add(t), c0.clone().add(t),
            u, 2.1, phaseAtLat(side))
        }
      }

      /* The deck skin. A hand's width over the road, drawn only while the
       * span is crazing, flashing or gone.
       *
       * TWO QUADS PER STEP, SPLIT AT THE CENTRELINE, because the two halves
       * have different things to say and a single quad spanning both can only
       * say one of them. Each carries its own phase and its partner's (aOther),
       * which is what lets the surviving half draw its side of the seam without
       * a second mesh or a second material.
       *
       * `aUv.y` runs 0 AT THE SEAM to 1 at the outer edge on both halves, so
       * the shader's seam test is one expression and the fracture pattern grows
       * outward from the split rather than across it. */
      for (let k = 0; k < nSeg; k++) {
        const u0 = k / nSeg, u1 = (k + 1) / nSeg
        const a = track.samples[(s0 + Math.round(u0 * (s1 - s0))) % m]
        const bs = track.samples[(s0 + Math.round(u1 * (s1 - s0))) % m]
        const la = a.width, lb = bs.width
        for (const side of [-1, 1]) {
          const mine = (b.side < 0 ? side < 0 : side > 0) ? b.phase : -1
          const other = (b.side < 0 ? side < 0 : side > 0) ? -1 : b.phase
          const base = skin.p.length / 3
          // Wound so the outward normal matches the whole-width quad this
          // replaced: seam-near edge first on the near section, outer edge
          // first on the far one.
          const corners: [TrackSample, number, number, number][] = [
            [a, 0, u0, 0], [a, side * la, u0, 1], [bs, side * lb, u1, 1], [bs, 0, u1, 0],
          ]
          for (const [smp, lat, uu, vv] of corners) {
            skin.p.push(
              smp.pos.x + smp.right.x * lat + smp.normal.x * 0.14,
              smp.pos.y + smp.right.y * lat + smp.normal.y * 0.14,
              smp.pos.z + smp.right.z * lat + smp.normal.z * 0.14,
            )
            skin.ph.push(mine)
            skin.other.push(other)
            skin.uv.push(uu, vv)
          }
          // WINDING. The corner list runs seam -> outer edge -> outer edge ->
          // seam, which traces one way round on the right half and the mirror
          // of it on the left. The material is FrontSide, as the whole-width
          // quad this replaced was, so the left half has to be wound the other
          // way or it is back-facing and simply never drawn -- which costs the
          // surviving half's side of the seam line, i.e. exactly the boundary
          // the mechanic is about.
          if (side > 0) skin.i.push(base, base + 1, base + 2, base, base + 2, base + 3)
          else skin.i.push(base, base + 2, base + 1, base, base + 3, base + 2)
        }
      }
    }

    /* -- the lattice mesh -- */
    if (latt.p.length > 0) {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(latt.p), 3))
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(latt.c), 3))
      g.setAttribute('aPhase', new THREE.BufferAttribute(new Float32Array(latt.ph), 1))
      g.setAttribute('aU', new THREE.BufferAttribute(new Float32Array(latt.u), 1))
      g.setIndex(new THREE.BufferAttribute(new Uint16Array(latt.i), 1))
      g.computeBoundingSphere()
      const mat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, fog: true, side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        uniforms: {
          ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
          uColor: { value: new THREE.Color().setHex(pal.accent) },
          uTime: { value: 0 },
          uPeriod: { value: TUNING.hazard.bridgePeriod },
          uDuty: { value: TUNING.hazard.bridgeDuty },
        },
        vertexShader: BRIDGE_VERT,
        fragmentShader: BRIDGE_FRAG,
      })
      const mesh = new THREE.Mesh(g, mat)
      mesh.name = 'light-bridge'
      mesh.matrixAutoUpdate = false
      mesh.updateMatrix()
      mesh.renderOrder = 3
      ctx.add(mesh); ctx.own(g); ctx.own(mat)
      const uT = mat.uniforms.uTime as { value: number }
      ctx.onUpdate((f: FrameInfo) => { uT.value = f.time })
    }

    /* -- the deck skin -- */
    if (skin.p.length > 0) {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(skin.p), 3))
      g.setAttribute('aPhase', new THREE.BufferAttribute(new Float32Array(skin.ph), 1))
      g.setAttribute('aOther', new THREE.BufferAttribute(new Float32Array(skin.other), 1))
      g.setAttribute('aUv', new THREE.BufferAttribute(new Float32Array(skin.uv), 2))
      g.setIndex(new THREE.BufferAttribute(new Uint16Array(skin.i), 1))
      g.computeBoundingSphere()
      const mat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, fog: true,
        uniforms: {
          ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
          uColor: { value: new THREE.Color().setHex(pal.accent) },
          uVoid: { value: new THREE.Color(0.013, 0.010, 0.024) },
          uTime: { value: 0 },
          uPeriod: { value: TUNING.hazard.bridgePeriod },
          uDuty: { value: TUNING.hazard.bridgeDuty },
          uFlashLead: { value: TUNING.hazard.bridgeFlashLead },
        },
        vertexShader: VOID_VERT,
        fragmentShader: VOID_FRAG,
      })
      const mesh = new THREE.Mesh(g, mat)
      // Named so the environment fit test can tell a decal ON the road from a
      // prop that has wandered onto it. This one is on the road on purpose:
      // it is what a deck that has stopped existing looks like.
      mesh.name = 'bridge-void-decal'
      mesh.matrixAutoUpdate = false
      mesh.updateMatrix()
      mesh.renderOrder = 4
      ctx.add(mesh); ctx.own(g); ctx.own(mat)
      const uT = mat.uniforms.uTime as { value: number }
      const phases = bridges.map((b) => b.phase)
      ctx.onUpdate((f: FrameInfo) => {
        uT.value = f.time
        // The one CPU-side read of the sim's own predicate: when every span is
        // up there is nothing for this mesh to draw, so do not draw it. The
        // flash and crazing windows are both inside `bridgeSolid`'s solid half,
        // so look ahead by the wider of the two -- the flash, which now leads.
        const lead = TUNING.hazard.bridgePeriod
          * Math.max(0.28, TUNING.hazard.bridgeFlashLead)
        mesh.visible = phases.some((p) =>
          !bridgeSolid(p, f.time) || !bridgeSolid(p, f.time + lead))
      })
    }
  }

  /* ---- beat 3: the anti-gravity rotunda --------------------------------- */
  //
  // A 54 m drum whose inside the road climbs 270 degrees of. The shell is
  // swept in the RIBBON's own frame, so "lateral" is across the road at the
  // mouths and UP THE WALL in the middle without a single special case, and
  // the wings grow with the roll: at the mouths the section is a plinth under
  // an ordinary road, and by the time the road is vertical the same section
  // has become 90 m of drum wall standing behind you.
  //
  // Behind, not around. The shell hangs along -normal, which is straight DOWN
  // at a mouth and radially OUTWARD on the wall, so it can never enter the
  // corridor no matter how far the wings reach.
  if (iRot >= 0 && iRotOut >= 0) {
    const WING = 23
    const stride = quality.tier === 'low' ? 8 : 4
    /** How far a section has rolled off level: 0 at a mouth, 1 on the wall. */
    const rollOf = (smp: TrackSample): number => 1 - Math.min(1, Math.abs(smp.normal.y))
    const wingAt = (smp: TrackSample): number =>
      ctx.corridor(smp.width) + PAD + WING * rollOf(smp) * rollOf(smp)

    const drumParts: THREE.BufferGeometry[] = [
      sweepRibbon(ctx, iRot, iRotOut, stride, (smp) => {
        const W = wingAt(smp)
        // The drum's inner face is the DARK value on this planet, for the
        // reason Cryostatic's cavern roof is: two warm lamps on the axis are
        // the only light in here, and a light source only reads as one against
        // something darker than it. At STONE the whole drum came back as a
        // flat mid-brown field with a lit barrier on it.
        return [
          { lat: -W, up: -0.45, col: STONE_DUSK },
          { lat: -W, up: -6.0, col: STONE_DEEP },
          { lat: W, up: -6.0, col: STONE_DEEP },
          { lat: W, up: -0.45, col: STONE_DUSK },
        ]
      }),
    ]
    // Two stringcourses, one either side, immediately outside the corridor: a
    // raised band running the whole 270 degrees. On the wall these are the
    // horizontal courses the drum is laid in, and they are the thing that
    // stops 90 m of masonry reading as one flat sheet with a road on it.
    for (const side of [-1, 1]) {
      drumParts.push(sweepRibbon(ctx, iRot, iRotOut, stride, (smp) => {
        const L = ctx.corridor(smp.width) + PAD
        const a = side * (L + 0.8), b = side * (L + 8.5)
        const lo = Math.min(a, b), hi = Math.max(a, b)
        return [
          { lat: lo, up: -0.30, col: STONE_LIT },
          { lat: lo, up: -2.6, col: STONE_DUSK },
          { lat: hi, up: -2.6, col: STONE_DUSK },
          { lat: hi, up: -0.30, col: STONE_LIT },
        ]
      }))
    }
    const drum = merge(drumParts)
    const drumMesh = new THREE.Mesh(drum, ctx.propMaterial)
    drumMesh.name = 'landmark-rotunda'
    drumMesh.receiveShadow = quality.shadows
    drumMesh.matrixAutoUpdate = false
    drumMesh.updateMatrix()
    ctx.add(drumMesh); ctx.own(drum)

    // THE HELIX. A continuous teal line along the outer edge of each
    // stringcourse, running the whole 270 degrees. It is the single most
    // useful object in the beat: the road's own spiral, drawn on the wall you
    // are driving on, so at the moment the horizon stops meaning anything
    // there is still one line in frame that says which way is along.
    {
      const helix = glyphBuffer()
      const sweepN = ((iRotOut - iRot) % m + m) % m
      const hStep = Math.max(2, Math.round(4 / res))
      for (const [side, out] of [[-1, 8.3], [1, 8.3], [-1, 29.0], [1, 29.0]] as const) {
        let prev: [number, number, number][] | null = null
        for (let d = 0; d <= sweepN; d += hStep) {
          const smp = track.samples[(iRot + d) % m]
          const L = ctx.corridor(smp.width) + PAD
          // The upper line only exists where the drum has grown a wall to
          // carry it; at a mouth it would be a light hanging in mid-air.
          if (out > 20 && 1 - Math.min(1, Math.abs(smp.normal.y)) < 0.45) { prev = null; continue }
          const cur: [number, number, number][] = [
            roadPos(smp, side * (L + out), -0.22, 0),
            roadPos(smp, side * (L + out + 0.7), -0.22, 0),
          ]
          if (prev) {
            const base = helix.p.length / 3
            for (const v of [prev[0], prev[1], cur[1], cur[0]]) helix.p.push(v[0], v[1], v[2])
            const g = 0.9 + 0.35 * Math.sin(d * 0.09)
            for (let k = 0; k < 4; k++) helix.c.push(g, g, g)
            helix.i.push(base, base + 1, base + 2, base, base + 2, base + 3)
          }
          prev = cur
        }
      }
      // Rides the same unlit material as the script; merged into it below.
      glyphExtra.push(glyphGeometry(helix, pal.accent, 1.0))
    }

    // THE DRUM HAS NO SUN IN IT. The key rakes in at 26 degrees and the road
    // is on the inside of a cylinder, so for the whole of the middle third the
    // only light on the wall is the hemisphere fill -- which is how the first
    // cut of this beat came out as a black hole with a lit barrier in it. Two
    // warm lamps on the drum's own axis, at a third and two thirds of the
    // sweep, put a rim on the racers and a falloff on the masonry. Two, not
    // six: every point light is a term every lit fragment in the scene pays.
    if (quality.tier !== 'low') {
      const sweep = ((iRotOut - iRot) % m + m) % m
      for (const f of [0.34, 0.70]) {
        const smp = track.samples[(iRot + Math.round(sweep * f)) % m]
        const light = new THREE.PointLight(0xffdda6, 620, 150, 2)
        light.position.set(
          smp.pos.x + smp.normal.x * 34,
          smp.pos.y + smp.normal.y * 34,
          smp.pos.z + smp.normal.z * 34,
        )
        ctx.add(light)
      }
    }

    // Gold ribs across the drum, outside the corridor on both sides. On the
    // wall these are the horizontal courses the drum is built in; at the
    // mouths they are the kerb the plinth stops at.
    const span = ((iRotOut - iRot) % m + m) % m
    const ribStep = Math.max(6, Math.round(9 / res))
    for (let d = ribStep; d < span; d += ribStep) {
      const smp = track.samples[(iRot + d) % m]
      const L = ctx.corridor(smp.width) + PAD
      const W = wingAt(smp)
      const roll = rollOf(smp)
      for (const side of [-1, 1]) {
        // Springs at L + 0.8 rather than at L. A rib is a BOX laid tangent to
        // a 54 m circle, so its two ends swing about 6 cm inboard of its
        // centre's lateral -- which the fit test caught as 2 cm inside the
        // forgiving edge at the drum's mouth. The extra 0.8 m is that, plus
        // the box's own half-height leaning with the bank.
        //
        // It stops at 14 m rather than running the full height of the drum, so
        // there is clear wall outboard of it for the script. A rib that covers
        // everything is a rib nothing else can share the wall with.
        const lo = L + 0.8
        const hi = Math.min(W, L + 14)
        if (hi - lo < 2) continue
        stone.push(part(new THREE.BoxGeometry(hi - lo, 1.5, 4.4), GOLD_HI,
          onRoad(smp, xf(side * (lo + hi) / 2, 0.05, 0))))
      }
      // Script on the drum's face, every second rib, OUTBOARD of the
      // stringcourse -- the first cut wrote it at the same lateral and the
      // same depth as the course's own top ledge, so every glyph on the drum
      // was lying face-up on a shelf, coplanar with it.
      if ((d / ribStep) % 2 === 1 && roll > 0.25) {
        for (const side of [-1, 1]) {
          writeGlyph(glyphs, GLYPHS[(d / ribStep) % GLYPHS.length],
            roadPos(smp, side * (L + 16.5), -0.36, -6.0),
            roadDir(smp, 0, 0, 12.0 * side), roadDir(smp, side * 11.0, 0, 0),
            0.06, 1.35)
        }
      }
    }
  }

  /* ---- beat 4: the warp gate ------------------------------------------- */
  //
  // The launch. Bigger than the gatehouse, and it carries the broken ring the
  // beat is named for: seven arc segments turning about the road's own axis,
  // with a keystone above them and nothing at all holding either up.
  if (iWarp >= 0) {
    buildGate(ctx, track.samples[iWarp], stone, floats,
      { jamb: 8.0, height: 30, spring: 13.5, crown: 24, keystone: 3.8, ring: true })
  }

  /* ---- beat 5: the orrery ---------------------------------------------- */
  //
  // The floating armillary the spiral is built around: four rings on four
  // inclinations turning at four rates about a common core, 40 m over the
  // middle of the corner so it is in frame for the whole of it.
  if (iOrrery >= 0 && iOrreryOut >= 0) {
    const span = ((iOrreryOut - iOrrery) % m + m) % m
    let cx = 0, cz = 0, cy = -Infinity, n = 0
    for (let d = 0; d <= span; d += 8) {
      const s = track.samples[(iOrrery + d) % m]
      cx += s.pos.x; cz += s.pos.z; cy = Math.max(cy, s.pos.y); n++
    }
    cx /= n; cz /= n
    // 22 m over the highest point of the corner, not 42. The armillary sits
    // INSIDE a 170-degree spiral whose road is 45-60 m from its own centre, so
    // at 42 m up it was 40 degrees above a camera that looks along the road:
    // the one object the beat is named for, permanently above the frame.
    const p: [number, number, number] = [cx, cy + 22, cz]
    const R = 34
    const incl: [number, number, number][] = [
      [0.06, 1, 0.03], [0.85, 0.5, 0.1], [0.2, 0.6, 0.86], [0.62, 0.2, -0.72],
    ]
    const rates = [0.075, -0.055, 0.042, -0.088]
    for (let i = 0; i < 4; i++) {
      const rr = R * (1 - i * 0.17)
      const torus = new THREE.TorusGeometry(rr, 1.15 + i * 0.20, 4, quality.tier === 'low' ? 14 : 22)
      // Stand the ring up on its own inclination, then hand the shader the
      // same axis to turn it about.
      const ax = incl[i]
      const q = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(ax[0], ax[1], ax[2]).normalize())
      const mtx = new THREE.Matrix4().compose(
        new THREE.Vector3(p[0], p[1], p[2]), q, new THREE.Vector3(1, 1, 1))
      addFloat(floats, part(torus, i % 2 === 0 ? STONE_LIT : GOLD, mtx), p, ax, rates[i], i * 1.7)
    }
    // The core: a keystone inside its own rings.
    addFloat(floats, part(new THREE.TetrahedronGeometry(5.4, 0), STONE, xf(p[0], p[1], p[2], 0.4, 0.3)),
      p, [0.1, 1, 0.2], 0.13, 0.4)
    addFloat(floats, part(new THREE.TetrahedronGeometry(3.2, 0), GOLD_HI, xf(p[0], p[1], p[2], 2.1, 0.3)),
      p, [0.1, 1, 0.2], -0.21, 0.4)
  }

  /* ---- beat 6: Keystone Plaza ------------------------------------------ */
  //
  // "A lattice of tetrahedral keystones over it", per the track's own note.
  // Two counter-turning layers 26 and 40 m up, laid on a loose grid that
  // follows the sweeper, so from the dust the plaza has a ceiling made of
  // blocks that are not resting on anything.
  if (iPlaza >= 0 && iPlazaOut >= 0) {
    const span = ((iPlazaOut - iPlaza) % m + m) % m
    const step = Math.max(8, Math.round((quality.tier === 'low' ? 40 : 21) / res))
    let k = 0
    for (let d = 0; d < span; d += step, k++) {
      const smp = track.samples[(iPlaza + d) % m]
      for (let lane = -1; lane <= 1; lane++) {
        const lat = lane * (ctx.corridor(smp.width) * 0.62)
        const layer = (k + lane + 3) % 2
        const s = 3.4 + rnd() * 2.6
        // 18 and 30 m ABOVE THE ROAD SURFACE, measured along the road's own
        // normal at that lateral rather than as a world height over the
        // centreline. The plaza banks to 26 degrees, so the outer edge of a
        // 26 m half-width is 8 m above the centreline: heights taken off the
        // centreline put the low layer 2 m over the tarmac at the plaza's
        // outside, which is exactly what the fit test measured.
        const [x, y, z] = roadPos(smp, lat, (layer === 0 ? 18 : 30) + rnd() * 4 + s, 0)
        const p: [number, number, number] = [x, y, z]
        const ax: [number, number, number] = [0.2 + rnd() * 0.3, 1, -0.2 + rnd() * 0.4]
        const rate = (layer === 0 ? 1 : -1) * (0.10 + rnd() * 0.09)
        addFloat(floats, part(new THREE.TetrahedronGeometry(s, 0),
          layer === 0 ? STONE_LIT : STONE, xf(x, y, z, rnd() * 3.1, rnd() * 0.8)), p, ax, rate, k * 0.9)
        addFloat(floats, part(new THREE.TetrahedronGeometry(s * 0.5, 0), GOLD_HI,
          xf(x, y, z, rnd() * 3.1, rnd() * 0.8)), p, ax, -rate * 1.6, k * 0.9)
      }
    }
  }

  /* ---- beat 7: the gateways down the descent ---------------------------- */
  //
  // 470 m of falling road is the fastest thing on the lap and, dressed only in
  // terraces, the emptiest frame on the planet. Three gateways at 120 m
  // intervals put the arch motif on the beat that most needs a rhythm: at
  // 60 m/s one goes past every two seconds, which is the read the descent
  // wants and the one a straight cannot give itself.
  if (iDescent >= 0 && iDescentOut >= 0) {
    const span = ((iDescentOut - iDescent) % m + m) % m
    for (const f of [0.18, 0.48, 0.78]) {
      buildGate(ctx, track.samples[(iDescent + Math.round(span * f)) % m], stone, floats,
        { jamb: 5.5, height: 21, spring: 10.5, crown: 17.5, keystone: 2.4, ring: false })
    }
  }

  /* ---- beats 7 and 8: the terraces ------------------------------------- */
  //
  // The descent falls 35 m down the western terraces and the Glyph Steps drop
  // through four corners below it, so both beats are the same object: a
  // stepped retaining wall standing outside the corridor with script cut into
  // the faces that look at the road.
  //
  // WHICH SIDE IS THE CUT SIDE is not authored anywhere and does not need to
  // be: a retaining wall belongs where the ground is HIGHER, so both verges
  // are sampled and the higher one wins. That is also why this survives a
  // change to the road's line -- it re-reads the hill it is holding up.
  const terraceRuns: [number, number, boolean][] = []
  if (iDescent >= 0 && iDescentOut >= 0) terraceRuns.push([iDescent, iDescentOut, false])
  if (iSteps >= 0 && iLast >= 0) terraceRuns.push([iSteps, iLast, true])
  for (const [ia, ib, glyphed] of terraceRuns) {
    const span = ((ib - ia) % m + m) % m
    const step = Math.max(10, Math.round(27 / res))
    let station = 0
    for (let d = 0; d < span; d += step, station++) {
      const smp = track.samples[(ia + d) % m]
      const [prx, prz] = planRight(smp)
      const half = ctx.corridor(smp.width) + PAD
      // The cut side: whichever verge stands higher.
      let side = 1, bestUp = -Infinity
      for (const s of [-1, 1]) {
        const g = ctx.ground(smp.pos.x + prx * s * (half + 9), smp.pos.z + prz * s * (half + 9))
        if (g.y > bestUp) { bestUp = g.y; side = s }
      }
      // Both verges get a terrace: the cut side gets the deep one and the fill
      // side a lower revetment, which is what a road cut into a hillside
      // actually has and what keeps the descent from being 470 m of nothing.
      const sides = [side, -side]
      for (const sd of sides) {
        // The first course stands 3 m outside the corridor and is 3.6 m thick,
        // so the clearance test is handed the half-thickness that actually
        // faces the road, and the lateral walks outward until it clears rather
        // than dropping the station. Testing the whole three-course terrace as
        // one 5.5 m disc — which is what the first cut did — rejected every
        // station on the descent.
        const blockLen = step * res * 0.62
        const lat = clearLateral(ctx, smp, sd, half + 3.0, 1.9, blockLen / 2)
        if (lat < 0) continue
        const bx = smp.pos.x + prx * sd * lat
        const bz = smp.pos.z + prz * sd * lat
        const gy = ctx.ground(bx, bz).y
        const yaw = Math.atan2(smp.tangent.x, smp.tangent.z)
        // Three courses stepping away from the road on the cut side, one on
        // the fill side.
        for (let c = 0; c < (sd === side ? 3 : 1); c++) {
          const off = c * 3.4
          // Same rule as the scattered terrace: the first course has to clear
          // the barrier from the road or the whole beat is behind a wall.
          const h = 8.0 + c * 3.6
          const px = bx + prx * sd * off, pz = bz + prz * sd * off
          stone.push(part(new THREE.BoxGeometry(3.6, h, blockLen),
            c === 0 ? STONE : c === 1 ? STONE_DUSK : STONE_DEEP,
            xf(px, gy - 1.2 + h / 2, pz, yaw)))
          stone.push(part(new THREE.BoxGeometry(4.1, 0.3, blockLen + 0.4), GOLD,
            xf(px, gy - 1.2 + h + 0.15, pz, yaw)))
        }
        // THE GLYPH STEPS. Script on the face that looks at the road, 5 m of
        // it, at the one place on the lap with no gimmick to compete with.
        if (glyphed && station % 2 === 0) {
          const fx = bx - prx * sd * 1.85, fz = bz - prz * sd * 1.85
          // Run the page along the track in the direction that makes
          // `du x dv` point back at the road from whichever side this is.
          const a = blockLen * 0.78 * sd
          const tx = Math.sin(yaw), tz = Math.cos(yaw)
          writeGlyph(glyphs, GLYPHS[(station + (sd > 0 ? 0 : 3)) % GLYPHS.length],
            [fx - tx * a / 2, gy - 0.6, fz - tz * a / 2],
            [tx * a, 0, tz * a], [0, 4.6, 0], 0.07, 1.25)
        }
      }
    }
  }

  /* ---- the merged meshes ----------------------------------------------- */

  if (stone.length > 0) {
    const geo = merge(stone)
    const mesh = new THREE.Mesh(geo, ctx.propMaterial)
    mesh.name = 'landmark-city'
    mesh.castShadow = quality.shadows
    mesh.receiveShadow = quality.shadows
    mesh.matrixAutoUpdate = false
    mesh.updateMatrix()
    ctx.add(mesh); ctx.own(geo)
  }

  if (glyphs.p.length > 0 || glyphExtra.length > 0) {
    const geo = merge([glyphGeometry(glyphs, pal.accent, 1.0), ...glyphExtra])
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true, fog: true, toneMapped: true,
      side: THREE.DoubleSide, transparent: true, depthWrite: false,
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.name = 'glyph-script'
    mesh.matrixAutoUpdate = false
    mesh.updateMatrix()
    mesh.renderOrder = 2
    ctx.add(mesh); ctx.own(geo); ctx.own(mat)
  }

  if (floats.parts.length > 0) {
    const geo = merge(floats.parts)
    geo.setAttribute('aPivot', new THREE.BufferAttribute(new Float32Array(floats.pivot), 3))
    geo.setAttribute('aAxis', new THREE.BufferAttribute(new Float32Array(floats.axis), 3))
    geo.setAttribute('aSpin', new THREE.BufferAttribute(new Float32Array(floats.spin), 2))
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.78,
      metalness: 0.16,
      flatShading: true,
      dithering: true,
    })
    const uTime = { value: 0 }
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uTime
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${FLOAT_PARS}`)
        .replace('#include <begin_vertex>', FLOAT_BODY)
    }
    mat.customProgramCacheKey = () => 'spacegen-aetherion-floaters'
    const mesh = new THREE.Mesh(geo, mat)
    mesh.name = 'floating-keystones'
    // The vertex shader moves every vertex, so the baked bounding sphere is a
    // lie by up to the largest orbit radius. Grown rather than disabled, so
    // the mesh is still culled when the whole city is behind you.
    geo.computeBoundingSphere()
    if (geo.boundingSphere) geo.boundingSphere.radius += 60
    mesh.matrixAutoUpdate = false
    mesh.updateMatrix()
    ctx.add(mesh); ctx.own(geo); ctx.own(mat)
    ctx.onUpdate((f: FrameInfo) => { uTime.value = f.time })
  }
}

/**
 * THE COLONNADE, AND EVERY OTHER STOOD COLUMN, ON THE SCATTER'S OWN MESH.
 *
 * `PropSpec.landmark` appends hand-placed instances to the spec's own
 * InstancedMesh, so 413 m of colonnade, a peristyle round the rotunda and a
 * ring of columns across Keystone Plaza cost geometry and not one extra draw
 * call. Everything is placed at `corridor(sample.width)` plus the column's own
 * footprint and re-checked against the whole centreline, so no arrangement of
 * widths can put a column on the road.
 */
function columnLandmarks(
  ctx: ThemeContext, push: (mtx: THREE.Matrix4, tint: THREE.Color) => void,
): void {
  const { track, quality } = ctx
  const m = track.samples.length
  const res = track.length / m
  const rnd = mulberry32(0xc01044)
  const warm = new THREE.Color(1.0, 0.97, 0.90)
  const cool = new THREE.Color(0.86, 0.84, 0.92)
  const _e = new THREE.Euler()
  const _q = new THREE.Quaternion()

  /**
   * Stand one column, if it clears everything.
   *
   * `clearOfTrack` wants `corridor + radius + 1.6`, so the lateral a caller
   * asks for has to carry the column's own scaled footprint on top of the
   * corridor or every single one is silently rejected -- which is exactly what
   * the first cut of this file did to all 64 columns of the colonnade.
   */
  const stand = (x: number, z: number, scale: number, yaw: number, tint: THREE.Color): void => {
    if (!ctx.clearOfTrack(x, z, 2.4 * scale)) return
    const g = ctx.ground(x, z)
    _e.set(0, yaw, 0)
    _q.setFromEuler(_e)
    push(new THREE.Matrix4().compose(
      new THREE.Vector3(x, g.y - 0.5 * scale, z), _q,
      new THREE.Vector3(scale, scale, scale)), tint)
  }

  /** A row of columns down both verges of a run of the ribbon. */
  const colonnade = (iFrom: number, iTo: number, every: number, scale: number, out: number): void => {
    const span = ((iTo - iFrom) % m + m) % m
    const step = Math.max(4, Math.round(every / res))
    for (let d = 0; d <= span; d += step) {
      const smp = track.samples[(iFrom + d) % m]
      const [prx, prz] = planRight(smp)
      const lat = ctx.corridor(smp.width) + 2.4 * scale + out
      const yaw = Math.atan2(smp.tangent.x, smp.tangent.z)
      for (const side of [-1, 1]) {
        stand(smp.pos.x + prx * side * lat, smp.pos.z + prz * side * lat,
          scale, yaw + side * 0.4, rnd() < 0.5 ? warm : cool)
      }
    }
  }

  // Beat 1. The home straight, and the reason the track's brief calls it the
  // colonnade: 413 m of them, close enough to tick past at 60 m/s.
  const iStart = ctx.tagSample('start')
  const iEnd = ctx.tagSample('colonnade-end')
  if (iStart >= 0 && iEnd >= 0) {
    colonnade(iStart, iEnd, quality.tier === 'low' ? 30 : 16, 1.22, 2.6)
  }
  // Beat 6. A peristyle across the plaza: the city square, walled in columns.
  const iPlaza = ctx.tagSample('plaza')
  const iPlazaOut = ctx.tagSample('plaza-out')
  if (iPlaza >= 0 && iPlazaOut >= 0) {
    colonnade(iPlaza, iPlazaOut, quality.tier === 'low' ? 52 : 28, 1.45, 5.0)
  }
  // Beat 5. Round the outside of the orrery spiral, so the corner the
  // armillary hangs over has a wall to turn against.
  const iOrr = ctx.tagSample('orrery')
  const iOrrOut = ctx.tagSample('orrery-out')
  if (iOrr >= 0 && iOrrOut >= 0) {
    colonnade(iOrr, iOrrOut, quality.tier === 'low' ? 48 : 26, 1.3, 4.0)
  }
  // Beat 7. Widely spaced down the descent, which is the fastest road on the
  // lap: at 32 m and 60 m/s a column goes by twice a second, which is a speed
  // read rather than a colonnade, and that is what a descent wants.
  const iDesc = ctx.tagSample('descent')
  const iDescOut = ctx.tagSample('descent-out')
  if (iDesc >= 0 && iDescOut >= 0) {
    colonnade(iDesc, iDescOut, quality.tier === 'low' ? 58 : 32, 1.3, 4.0)
  }
  // NO PERISTYLE ROUND THE ROTUNDA. It was built, measured and cut: 26 columns
  // for 3.7k triangles that are invisible from inside the drum (you are on the
  // wall, looking at the wall) and two pixels tall from the causeway. The drum
  // has to carry itself, and it does it with the stringcourses and the ribs.
}

/**
 * THE UPPER CITY, ON THE SPIRE'S OWN MESH.
 *
 * The scatter reaches about 90 m off the road, and past that every frame on
 * this planet ran out of city and finished on bare ground under a gold sky —
 * which is the one thing a track whose brief is "you can see the next tier of
 * it above you" cannot do. So the tallest prop in the catalogue is also
 * hand-placed on a ring 220-420 m out, at two to three and a half times its
 * scattered scale: 100-150 m towers, standing where the terrain has already
 * graded most of the way onto the fog, so they arrive as violet silhouettes
 * rather than as objects. One `PropSpec.landmark` callback, no draw call, and
 * every frame gets a built horizon.
 *
 * The ring is walked from the ribbon rather than laid on a circle, so it
 * follows the shape of the lap instead of ignoring it, and every tower is
 * clearance-tested like anything else.
 */
function spireLandmarks(
  ctx: ThemeContext, push: (mtx: THREE.Matrix4, tint: THREE.Color) => void,
): void {
  const { track, quality } = ctx
  const m = track.samples.length
  const res = track.length / m
  const rnd = mulberry32(0x5c19e5)
  const _e = new THREE.Euler()
  const _q = new THREE.Quaternion()
  const step = Math.max(10, Math.round((quality.tier === 'low' ? 190 : 108) / res))
  for (let i = 0; i < m; i += step) {
    const smp = track.samples[i]
    const [prx, prz] = planRight(smp)
    const side = rnd() < 0.5 ? -1 : 1
    const scale = 2.2 + rnd() * 1.5
    const lat = 220 + rnd() * 200
    const x = smp.pos.x + prx * side * lat
    const z = smp.pos.z + prz * side * lat
    if (!ctx.clearOfTrack(x, z, 8.2 * scale)) continue
    const g = ctx.ground(x, z)
    _e.set(0, rnd() * Math.PI * 2, 0)
    _q.setFromEuler(_e)
    push(new THREE.Matrix4().compose(
      new THREE.Vector3(x, g.y - 1.5 * scale, z), _q,
      new THREE.Vector3(scale, scale * (0.85 + rnd() * 0.5), scale)),
      new THREE.Color(0.92, 0.90, 0.96))
  }
}

/* ------------------------------------------------------------------ theme */

const _deep = new THREE.Color()
const _dust = new THREE.Color()
const _gold = new THREE.Color()

export const AETHERION_THEME: Theme = {
  id: 'aetherion',

  props(pal, seg) {
    return [
      {
        name: 'column', geo: propColumn(pal, seg), count: 24,
        // 3.4 m plinth: the plan half-diagonal is 2.40.
        radius: 2.4, gap: 1.8, spread: 46, scale: [0.75, 1.5],
        cluster: { tag: 'glyph-steps', span: 380, share: 0.28 },
        landmark: columnLandmarks,
      },
      {
        name: 'terrace', geo: propTerrace(pal, seg), count: 165,
        // 9.4 m of courses on a 5.4 m bed, plus the fallen drum at x = -5.4.
        radius: 6.2, gap: 1.0, spread: 42, scale: [0.7, 1.5],
        cluster: { tag: 'descent', span: 460, share: 0.34 },
      },
      {
        name: 'stele', geo: propStele(pal, seg), count: 44,
        radius: 3.1, gap: 2.0, spread: 50, scale: [0.8, 1.5],
        cluster: { tag: 'plaza', span: 380, share: 0.30 },
      },
      {
        name: 'arch', geo: propArch(pal, seg), count: 26,
        // 12.4 m between the outer pier faces, 2.8 m deep: half-diagonal 6.5.
        radius: 6.5, gap: 2.5, spread: 62, scale: [0.85, 1.8],
        cluster: { tag: 'orrery', span: 320, share: 0.32 },
      },
      {
        name: 'keystone', geo: propKeystones(pal, seg), count: 12,
        // Nothing touches the ground, but the cluster is 5.5 m across in plan
        // and hangs to 40 m, so it is declared as what it could lean over.
        radius: 5.5, gap: 7.0, spread: 90, scale: [1.1, 2.3], sink: 0,
        cluster: { tag: 'causeway', span: 420, share: 0.34 },
      },
      {
        name: 'spire', geo: propSpire(pal, seg), count: 22,
        // 11.5 m base and a 42 m tower over it, so it stands well back.
        radius: 8.2, gap: 18, spread: 210, scale: [0.85, 1.8],
        cluster: { tag: 'keystone-flyover', span: 420, share: 0.36 },
        landmark: spireLandmarks,
      },
    ] satisfies PropSpec[]
  },

  landmarks,

  /**
   * The city floor.
   *
   * Not desert and not rock: a paved plain that two thousand years of drift
   * has mostly buried. A deep violet substructure shows through wherever the
   * macro noise digs, pale dust lies over everything else, and the low sun
   * puts gold only on the crests it actually reaches.
   *
   * The paving courses are the thing that makes it a CITY floor. They are
   * authored at 104 m and 12 m wide, not at a human 4 m: the terrain grid is
   * 11 m at the high tier and 17 at the low, so anything finer would alias
   * into a shimmer at 70 m/s rather than read as a joint. They fade out past
   * 260 m of edge, where a course would be one pixel wide anyway.
   *
   * The near-track band is the DARKEST part of the field, as on both other
   * planets: the verge is in the barrier's shadow, and that value edge is what
   * the road sits inside instead of dissolving into the plain.
   */
  terrainColor(out, p: TerrainPoint, pal) {
    _deep.setHex(0x2b2438); _dust.setHex(DUST); _gold.setHex(pal.b)
    out.copy(_deep).lerp(_dust, 0.16 + 0.74 * Math.min(1, p.macro * 1.2))
    out.lerp(_gold, p.ridge * 0.20 * p.mid)
    // Paving courses.
    const fx = Math.abs((((p.x / 76) % 1) + 1.5) % 1 - 0.5)
    const fz = Math.abs((((p.z / 76) % 1) + 1.5) % 1 - 0.5)
    const seam = Math.max(0, 1 - Math.min(fx, fz) * 13)
      * (1 - Math.min(1, Math.max(0, p.edge - 150) / 190))
    out.multiplyScalar(1 - 0.36 * seam)
    const near = Math.min(1, Math.max(0, p.edge) / 52)
    out.multiplyScalar(0.44 + 0.34 * near + 0.15 * p.grit + 0.17 * p.mid)
  },
  terrainMaterial: { roughness: 0.93, metalness: 0.0 },
  // Grades onto the fog much later than either other planet: the whole point
  // of this city is the sightline, and the density is a third of Rustfall's.
  terrainFade: [150, 640],
  propMaterial: { roughness: 0.84, metalness: 0.10 },

  /**
   * Ancient dust hanging in a shaft of low sun. It falls, but barely — this
   * is air nobody has disturbed, and a mote that settles in a second reads as
   * weather rather than as age.
   */
  motes: {
    // Capped at 16 px rather than 22. A dust mote is a mote; at 22 the nearest
    // few filled a quarter of a degree each and the air came back as confetti.
    count: 900, box: 165, size: [1.0, 3.4], pixel: 112, maxPixels: 16,
    alpha: 0.26, fall: 0.35, streak: 0,
    color: (pal, fog) => new THREE.Color().setHex(pal.b).lerp(fog, 0.52),
  },

  /**
   * THE ONLY WIND ART ON THIS PLANET, which is why it is not shy.
   *
   * `weather` below is null on purpose — driving the fog, the key light and
   * the sun disc off the crosswind would have faded the city's sightlines in
   * and out once a lap — so the causeway's 16.4 m/s^2 had literally nothing
   * drawing it. This is that, and it costs the sightline nothing: it is a
   * near-field layer that never touches the fog.
   *
   * Bone-pale grit off the limestone terraces, `pal.a`, half-graded onto the
   * fog. A bigger box than the other two planets for the same reason the
   * motes have one: the air here is clear for 640 m and a volume that ends 40
   * m out reads as a bubble around the car.
   *
   * The causeway is where this earns its place. Three phasing half-spans, no
   * barriers, 16 m of half-width, a crosswind that peaks between the second
   * and third span — and the surviving lane is the UPWIND one, so the whole
   * section is a question about which way the air is going. It was being
   * asked with no picture at all.
   */
  debris: {
    count: 1200, box: 82, length: 5.6, width: 0.26, alpha: 0.50, fall: 0.9,
    // A MID VALUE, and that is a contrast decision rather than a colour one.
    // Grit off the terraces wants to be `pal.a` — the bone limestone the whole
    // city is cut from — but `pal.a` is 0.83 luminance and so is this
    // planet's sky, so the first pass drew pale streaks on a pale sky and they
    // were invisible above the skyline while reading fine over the road. Half
    // the way to `pal.c`, the deep violet in the shadows, lands at about 0.48:
    // dark enough to silhouette against the sky, light enough to show against
    // the deck. Only a quarter of the way onto the fog, because the air here
    // is clear for 640 m and grading it out early takes the far field away.
    color: (pal, fog) => new THREE.Color()
      .setHex(pal.a)
      .lerp(new THREE.Color().setHex(pal.c), 0.5)
      .lerp(fog, 0.25),
  },

  sky: { band: 'strata' },

  /**
   * Haze lying in the terraces, and ONLY there: the band is entirely below the
   * camera, so on the ground the banks are behind the floor and invisible, and
   * from the causeway and the rotunda — the two places you are 45 m up looking
   * down at the city — they fill the drop. One draw call for the only piece of
   * aerial perspective on a planet whose fog is deliberately thin.
   */
  fogBanks: {
    count: 8, size: 130, alpha: 0.030, low: -52, high: -6,
    color: (pal, fog) => fog.clone().lerp(new THREE.Color().setHex(pal.b), 0.28),
  },

  /**
   * No weather. The track authors real crosswind on the causeway, the plaza
   * and the rotunda, and every one of those is a place the brief asks you to
   * be able to SEE — the next tier of the city above you, the drop under the
   * deck, the far side of the drum. The shared weather path drives fog
   * density, the key light and the sun disc off the same number, so dressing
   * this planet's wind would have faded the sun in and out once a lap. The
   * wind is a gameplay force here and stays one.
   */
  weather: null,

  road: 'industrial',
  spray: SPRAY,
}
