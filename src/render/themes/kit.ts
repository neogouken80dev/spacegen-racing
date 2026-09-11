/**
 * THEME KIT — the vocabulary a planet's art is written in.
 *
 * `environment.ts` is a placement engine: a terrain height field derived from
 * the ribbon's banked frame, a seeded corridor-relative prop scatter, a sky
 * dome, a light rig and an atmospheric particle layer. None of that is
 * planet-specific. What IS planet-specific is the catalogue of things being
 * placed, how the ground is coloured, what is falling out of the sky and what
 * landmarks the beats get. A `Theme` is exactly that list and nothing else.
 *
 * Everything a theme is handed comes through `ThemeContext`, which is built
 * once per world build. A theme may not reach into the scene graph, the
 * renderer or the sim: it is given a group to add to, a material to share, the
 * ground field it must sit on, and the corridor it must stay out of.
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { SurfaceKind, Track } from '../../sim/track'
import type { RenderQuality } from '../api'

export interface Palette { a: number; b: number; c: number; accent: number }

/* ------------------------------------------------------------------ scratch */

const _col = new THREE.Color()
const _mat4 = new THREE.Matrix4()
const _quat = new THREE.Quaternion()
const _euler = new THREE.Euler()
const _scale = new THREE.Vector3()
const _pos = new THREE.Vector3()

/** Local seeded PRNG. Deliberately not imported from sim/rng — the art layer
 *  must never consume draws from the deterministic simulation stream. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Tag one geometry with a flat colour and bake a transform into it.
 *
 * Also normalises the index. `mergeGeometries` refuses a batch where some
 * geometries are indexed and some are not, and three's polyhedra
 * (Icosahedron, Tetrahedron, ...) are the only primitives it builds
 * non-indexed — so the moment a theme mixed an icosahedral boulder into a prop
 * made of boxes and cylinders, the merge threw. A trivial sequential index
 * costs one extra buffer and changes no vertex, where `mergeVertices` would
 * weld the polyhedron's faces together and quietly smooth-shade it.
 */
export function part(geo: THREE.BufferGeometry, hex: number, m: THREE.Matrix4): THREE.BufferGeometry {
  geo.deleteAttribute('uv')
  geo.applyMatrix4(m)
  if (!geo.getIndex()) {
    const vn = geo.getAttribute('position').count
    const seq = vn > 65535 ? new Uint32Array(vn) : new Uint16Array(vn)
    for (let i = 0; i < vn; i++) seq[i] = i
    geo.setIndex(new THREE.BufferAttribute(seq, 1))
  }
  const n = geo.getAttribute('position').count
  _col.setHex(hex)
  const c = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) { c[i * 3] = _col.r; c[i * 3 + 1] = _col.g; c[i * 3 + 2] = _col.b }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3))
  return geo
}

export function xf(
  x: number, y: number, z: number,
  ry = 0, rx = 0, rz = 0, sx = 1, sy = 1, sz = 1,
): THREE.Matrix4 {
  _euler.set(rx, ry, rz)
  _quat.setFromEuler(_euler)
  _pos.set(x, y, z)
  _scale.set(sx, sy, sz)
  return _mat4.compose(_pos, _quat, _scale).clone()
}

export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false)
  for (const p of parts) p.dispose()
  if (!g) throw new Error('theme: geometry merge failed')
  g.computeBoundingSphere()
  return g
}

/* -------------------------------------------------------------------- specs */

/**
 * One hero prop in the instanced scatter.
 *
 * `radius` is the planar footprint at scale 1 and is used BOTH for the
 * clearance test and to set the placement lateral, so `gap` is a true edge
 * clearance rather than a distance to the prop's pivot. Understate it and the
 * prop hangs over the road.
 */
export interface PropSpec {
  name: string
  geo: THREE.BufferGeometry
  /** Base count at propDensity 1.0. */
  count: number
  radius: number
  /** Clearance between the prop's own shell and the protected corridor. */
  gap: number
  /** Random lateral spread past `gap`. */
  spread: number
  scale: [number, number]
  /** Bias placement toward the neighbourhood of a tagged node. */
  cluster?: { tag: string; span: number; share: number }
  /** Sink into the ground, as a fraction of scale. Default 0.35. */
  sink?: number
  /**
   * Hand-placed instances appended to this spec's own InstancedMesh.
   *
   * A landmark-scale copy of a scattered prop — Rustfall's 48 m crane over the
   * oil section — needs a placement rule of its own, but it does not need a
   * draw call of its own. Push a matrix and a tint and it rides in the same
   * instanced batch as the other two hundred.
   */
  landmark?(ctx: ThemeContext, push: (m: THREE.Matrix4, tint: THREE.Color) => void): void
}

/** One point on the terrain shell, handed to `Theme.terrainColor`. */
export interface TerrainPoint {
  x: number; z: number; y: number
  /** Metres past the ribbon's plan edge. Negative under the road. */
  edge: number
  /** Height above the start line, normalised over ~26 m. */
  ridge: number
  /** Value noise in [0,1] at three scales: per-cell, ~40 m, ~130 m. */
  grit: number; mid: number; macro: number
  /**
   * Plan distance to the nearest fragile section of ribbon, or Infinity on a
   * track that has none. This is how Cryostatic paints the frozen lake as a
   * flat pan around the shelf that cracks, without the terrain having to know
   * what a lake is.
   */
  shelf: number
}

/** Per-frame state every theme hook is given. */
export interface FrameInfo {
  dt: number
  time: number
  camX: number; camY: number; camZ: number
  /** Local blizzard strength at the camera, 0..1. Always 0 with no wind. */
  wind: number
  /** Ice-shelf collapse, 0 before the crack, ramping to 1 over ~1.2 s. */
  crack: number
}

/** Everything a theme's `landmarks` hook may touch. */
export interface ThemeContext {
  track: Track
  quality: RenderQuality
  palette: Palette
  /** Round-geometry segment count for this tier. */
  seg: number
  /** Ground height field the terrain mesh was built from. */
  ground(x: number, z: number): { y: number; edge: number }
  /** Protected half-width nothing outside the track mesh may enter. */
  corridor(width: number): number
  /** True when (x,z) clears the whole centreline by `radius` plus margin. */
  clearOfTrack(x: number, z: number, radius: number): boolean
  /** Sample index nearest the first node carrying `tag`, or -1. */
  tagSample(tag: string): number
  /** Shared flat-shaded prop material: use it and pay no extra draw call. */
  propMaterial: THREE.MeshStandardMaterial
  /** Adds to the environment group and takes ownership of disposal. */
  add(o: THREE.Object3D): void
  /** Register a geometry or material for disposal at teardown. */
  own(x: THREE.BufferGeometry | THREE.Material): void
  /** Register a per-frame hook. Must not allocate. */
  onUpdate(fn: (f: FrameInfo) => void): void
}

/** Airborne particle layer: Rustfall's dust, Cryostatic's driving snow. */
export interface MoteStyle {
  /** Count at particleScale 1.0. */
  count: number
  /** Side of the camera-anchored volume, metres. */
  box: number
  size: [number, number]
  /**
   * Screen-size gain. A dust mote hanging in a sunbeam is allowed to be a
   * fat soft blob; a snowflake at arm's length is a few pixels, and at 220 it
   * came out as confetti.
   */
  pixel: number
  /** Largest on-screen size, pixels. */
  maxPixels: number
  /** Base alpha before the per-particle fade. */
  alpha: number
  /** Constant downward drift, m/s. Dust hangs; snow falls. */
  fall: number
  /** How hard the wind band stretches a flake into a streak. 0 disables. */
  streak: number
  /** Mote colour, given the track palette and fog colour. */
  color(pal: Palette, fog: THREE.Color): THREE.Color
}

/**
 * BLOWN DEBRIS — the crosswind, made visible.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS IN THE KIT AND NOT IN A THEME.
 *
 * `TrackNode.wind` was a strong lateral acceleration with NO art at all. From
 * play on The Hollow Choir: "there are portions of the track where I try to
 * turn, but it pushes me to the right", and "I didn't have any visual cues of
 * the crosswind to know what was going on." A force the player cannot see is
 * not weather, it is a bug — and three of the four shipped circuits author
 * wind, so the cue has to be a property of WIND rather than of a planet.
 *
 * So the placement engine owns the system (environment.ts, next to the motes
 * and the fog banks, which are the same kind of camera-anchored volume) and a
 * theme owns only the material identity below. A track that authors wind and
 * says nothing here gets `DEFAULT_DEBRIS` and is legible on day one.
 *
 * WHAT IT HAS TO READ, in this order:
 *
 *   1. DIRECTION. Every streak is a wedge lying along the track's own `right`
 *      axis, travelling toward the end that is wide. Two channels, one of
 *      which (the wedge) survives a still frame.
 *   2. STRENGTH. Density and drift speed both ride the ACTUAL applied push,
 *      so a stretch the tyres can absorb looks calmer than one they cannot.
 *
 * NON-EMISSIVE, ALWAYS. This layer fills a large share of the frame at full
 * strength, and this project has a documented history of additive VFX erasing
 * the road (see the glare budget in postfx.ts). It draws with NormalBlending
 * at low alpha and never approaches the bloom threshold, so the debris can
 * only tint the frame toward `color` — never brighten it.
 * ---------------------------------------------------------------------------
 */
export interface DebrisStyle {
  /** Instance budget at particleScale 1.0. This is ONE draw call. */
  count: number
  /** Side of the camera-anchored wrap volume, metres. */
  box: number
  /** Base streak length, metres, before the per-instance and strength gain. */
  length: number
  /** Streak width at the leading (wide) end, metres. */
  width: number
  /** Base alpha before the distance fade. Keep this LOW — see above. */
  alpha: number
  /** Constant settle, m/s. Grit falls; shed paint flake barely does. */
  fall: number
  /** Debris colour, given the track palette and the fog colour. */
  color(pal: Palette, fog: THREE.Color): THREE.Color
}

/**
 * What a windy track gets if its theme says nothing: pale grit, mid-sized,
 * faint. Deliberately neutral rather than pretty — a new planet blowing
 * generic dust is obviously unfinished, where no debris at all just looks like
 * the wind bug all over again.
 */
export const DEFAULT_DEBRIS: DebrisStyle = {
  count: 640, box: 86, length: 5.2, width: 0.26, alpha: 0.38, fall: 1.1,
  color: (_pal, fog) => new THREE.Color(0.72, 0.74, 0.78).lerp(fog, 0.45),
}

/** Sky dome extras layered on top of the shared gradient. */
/**
 * ===========================================================================
 * THE CELESTIAL LAYER — what is in the sky besides sky.
 * ===========================================================================
 *
 * Everything here is drawn IN THE DOME'S FRAGMENT SHADER, as a function of the
 * view direction, and that is the whole design:
 *
 *  - It costs no draw calls, no geometry and no depth work. The dome already
 *    shades every pixel in the frame; a moon is a few more instructions on
 *    pixels that were being shaded anyway.
 *  - It is at infinity by construction. Real geometry at a plausible distance
 *    has to be camera-locked, kept inside the far plane, excluded from fog and
 *    sorted against the terrain shell -- four ways to get a seam. A direction
 *    has none of those problems.
 *  - It cannot be driven past, clipped into, or left behind on a jump.
 *
 * The cost is that a subject has to be expressible as a function of direction.
 * A moon and a ring and an accretion disc are; a detailed hull is not, which is
 * why `ships` are silhouettes with running lights rather than models.
 *
 * EVERY FIELD IS OPTIONAL AND EACH ONE COMPILES A #define. A planet pays for
 * exactly what it declares and nothing for the rest -- the same rule the
 * `band` variants already follow.
 */

/** A lit sphere in the sky: a moon, or a gas giant. */
export interface SkyBody {
  /** Direction from the track to the body. Normalised on load; need not be. */
  dir: [number, number, number]
  /** Angular RADIUS in degrees. The moon from Earth is about 0.26. */
  sizeDeg: number
  color: number
  /**
   * How hard the terminator bites, 0..1. 0 is a flat disc (a light source,
   * or something so far away it reads as one); 1 is a hard day/night line.
   * The body is lit from the scene's own sun direction, so a moon cannot be
   * lit from a direction the track's own shadows disagree with.
   */
  shade?: number
  /** Latitude bands, for a gas giant. 0 or absent = a plain sphere. */
  bands?: number
  bandColor?: number
  /** Surface mottling — maria, cratering, storm cells. 0..1. */
  mottle?: number
  /** A thin bright limb where the atmosphere catches the light. 0..1. */
  limb?: number
  /**
   * A RING SYSTEM, in multiples of the body's own radius. Rings are drawn on
   * the first body that declares them and are the one piece of this that is
   * genuinely 3D: the ring plane passes IN FRONT of the body on one side and
   * BEHIND it on the other, which is the read that makes it a ring rather
   * than a halo.
   */
  ring?: {
    inner: number
    outer: number
    color: number
    /** 0..1. Rings are translucent; this is the thickest part. */
    opacity: number
    /** Ring-plane axis. Defaults to a tilt off the body's own direction. */
    axis?: [number, number, number]
  }
}

/** A debris belt: rubble strung around an axis, seen edge-on from the track. */
export interface SkyBelt {
  /** The axis the belt orbits about. */
  axis: [number, number, number]
  /** Angular radius of the belt from that axis, degrees from the equator. */
  tiltDeg: number
  /** How thick the band is, degrees. */
  widthDeg: number
  color: number
  /** 0..1. How many cells hold a rock. */
  density: number
  /** Degrees per second the belt rotates about its axis. Tiny. */
  driftDeg?: number
  gain?: number
}

/** Capital ships holding station. Silhouettes with running lights. */
export interface SkyShips {
  /** Direction to the middle of the formation. */
  dir: [number, number, number]
  /** How far the formation spreads, degrees. */
  spreadDeg: number
  /** Angular LENGTH of the largest hull, degrees. */
  sizeDeg: number
  /** Hull colour — these are silhouettes, so this is usually near-black. */
  color: number
  /** Running-light colour and strength. */
  lightColor?: number
  lightGain?: number
  /** How many hulls, 1..5. */
  count?: number
  /** Degrees per second of station-keeping drift. Tiny. */
  driftDeg?: number
}

/**
 * A BLACK HOLE, with the one feature that makes it unmistakable: it bends the
 * sky around itself.
 *
 * Implemented as a deflection applied to the view direction BEFORE anything
 * else samples it -- the gradient, the stars, the bodies, the belt. That
 * ordering is the whole effect: lensing that only distorts a local sprite is a
 * smudge, and lensing that moves the actual starfield is a black hole.
 */
export interface SkyHole {
  dir: [number, number, number]
  /** Angular radius of the shadow (the event horizon as drawn), degrees. */
  sizeDeg: number
  /** How far out the deflection reaches and how hard, 0..2. */
  lensing?: number
  /** Accretion disc colour, inner and outer. */
  discInner?: number
  discOuter?: number
  /** Disc extent in multiples of the shadow radius. */
  discOut?: number
  /** Disc plane axis. */
  axis?: [number, number, number]
  gain?: number
}

export interface Celestial {
  /** Up to two. More than that and a sky reads as a diagram of a solar system. */
  bodies?: SkyBody[]
  belt?: SkyBelt
  ships?: SkyShips
  hole?: SkyHole
  /** Master dimmer for the whole layer, so a track can pull it back at once. */
  gain?: number
}

export interface SkyStyle {
  /**
   * 'strata' = drifting dust bands. 'aurora' = animated polar curtains.
   * 'stars' = a fixed starfield, for a sky that is not an atmosphere.
   *
   * One branch is compiled into the dome by a #define, so a planet pays for
   * the band it uses and nothing at all for the other two.
   */
  band: 'strata' | 'aurora' | 'stars'
  /** Aurora curtain colours, low and high. */
  auroraLow?: number
  auroraHigh?: number
  /** Aurora brightness. */
  auroraGain?: number
  /**
   * THE DOME'S LOW-SKY COLOUR, when it must differ from `TrackDef.skyBottom`.
   *
   * `skyBottom` does double duty: it is the colour the dome grades to just
   * above the horizon AND it is the HemisphereLight's sky colour, which on
   * every shipped track is fine because a bright sky and a bright up-facing
   * fill are the same physical fact. On the Hollow Choir they are opposites.
   * That planet's fill has to carry the whole drum, because the key does no
   * work on the inside of a cylinder — but its sky is vacuum, and a vacuum
   * bright enough to light a drum is a sky you cannot see a star in, which
   * costs that track the one image the Breach is for. Set this and the dome
   * takes it while the light rig keeps `skyBottom`.
   *
   * Unset on every other planet, where the two are the same number.
   */
  domeLow?: number
  /**
   * Starfield brightness, and how far down the sky the field survives.
   *
   * `starHorizon` is the d.y at which stars have faded fully into the haze:
   * anything lit by a real atmosphere wants this high, and a vacuum with a
   * dust horizon wants it low. The field is FIXED — it does not drift, does
   * not twinkle, and costs two cell hashes per fragment.
   */
  starGain?: number
  starHorizon?: number
  /**
   * WHAT ELSE IS UP THERE. See the Celestial block above: moons, rings, belts,
   * capital ships, a black hole. Absent on a track that wants only weather.
   */
  celestial?: Celestial
}

/**
 * Cheap fake volumetrics: a handful of very large, very soft camera-anchored
 * sprites drifting through the fog. Pretending to be light scattering in a
 * participating medium costs one draw call and no depth work.
 */
export interface FogBankStyle {
  count: number
  /** Sprite size in metres. */
  size: number
  alpha: number
  /** Vertical band around the camera the banks live in, metres. */
  low: number; high: number
  color(pal: Palette, fog: THREE.Color): THREE.Color
}

/**
 * The blizzard band. `wind` on a TrackNode is a gameplay force; this is what
 * the same number does to the frame. Everything ramps with the authored value
 * so the visibility loss arrives and leaves exactly where the crosswind does.
 */
export interface WeatherStyle {
  /** Authored `wind` that counts as a full-strength band. */
  windFull: number
  /** Fog colour and density at full strength. */
  fogColor: number
  fogDensity: number
  /** Key light multiplier at full strength — a blizzard has no sun. */
  sunScale: number
  /**
   * Hemisphere fill multiplier at full strength. Defaults to 0.75, which is
   * what this was hardcoded at before any theme needed to ask.
   *
   * The Hollow Choir is why it is a field. On that circuit `wind` marks where
   * there is AIR — 24 across the drum's sealed bays, exactly zero through the
   * Breach — and the fill is the only light that does any work inside a drum,
   * because the key runs along the axis and N.L is near zero on the whole
   * bore. Dropping the fill where the air is therefore makes the vacuum
   * section the BRIGHTEST part of the drum, which is both what the track def
   * says ("the interior of the drum is lit by whatever comes through the
   * Breach") and the one channel loud enough to be felt rather than noticed.
   */
  hemiScale?: number
  /** Extra mote alpha and count multiplier at full strength. */
  moteGain: number
}

/**
 * Track-ribbon shading branch. `trackMesh.ts` compiles ONE of these into the
 * road material via a #define, so a themed road costs no extra shader work at
 * runtime and no extra program on a track that does not use it.
 */
export type RoadStyle = 'industrial' | 'glacial'

/* --------------------------------------------------------- surface spray */

/**
 * WHAT COMES OFF THIS SURFACE WHEN A CAR SLIDES ON IT.
 *
 * The drift spray in `vfx.ts` is one emitter with one shape; what makes it
 * snow on Cryostatic and rust grit on Rustfall is this table, and the table
 * belongs to the planet rather than to the effect. A `switch (surface)` inside
 * the VFX would put Cryostatic's art direction inside a file Cryostatic does
 * not own, and the third track would have to edit it.
 *
 * TWO RULES, both of which the VFX enforces rather than trusts:
 *
 *  - `bulk` and `glint` are HUES. Their luminance is normalised away and
 *    replaced by `gain` times a hard cap that sits under the bloom threshold,
 *    because the bulk channel is the one that fills pixels: a snow plume is
 *    dense by design, and a dense additive plume authored at a "snow white"
 *    albedo is the Cryostatic blizzard whiteout with a new name. What the
 *    player reads as brightness is DENSITY against a mid-dark road, which is
 *    also what it is in the world.
 *  - `spark` is only ever obeyed for a chassis that touches the ground. A
 *    hovercraft striking sparks off a surface it never reaches is wrong, so
 *    the locomotion class gates this field before the surface is consulted.
 */
export interface SurfaceSpray {
  /** Bulk of the thrown material, sRGB. Hue only — see above. */
  bulk: number
  /** The bright fraction: crystals, chips, grit catching the key light. */
  glint: number
  /** 0 = powder that hangs in the air, 1 = heavy chips that fly and drop. */
  weight: number
  /** Share of emissions that arrive as hard glints rather than soft bulk. */
  grit: number
  /** Bulk emission-rate multiplier. Ice barely powders; snow buries you. */
  density: number
  /** Bulk level, as a fraction of the VFX's shared luminance cap. */
  gain: number
  /** Struck-spark rate, 0..1, for a GROUNDED chassis only. */
  spark: number
  /** Colour of those sparks: hot alloy is not hot stone is not sheared ice. */
  sparkCol: number
}

export type SurfaceSprayTable = Record<SurfaceKind, SurfaceSpray>

/**
 * Neutral fallback: a grey surface with no personality. Used before any theme
 * has bound (a VFX system built without an environment) and for a SurfaceKind a
 * theme somehow failed to author.
 */
export const DEFAULT_SPRAY: SurfaceSpray = {
  bulk: 0x8a8a8a, glint: 0xd8d8d8, weight: 0.45, grit: 0.22,
  density: 1.0, gain: 0.55, spark: 0.35, sparkCol: 0xffc27a,
}

/**
 * THE ACTIVE WORLD, for effects that need to know what the car is standing on.
 *
 * `createVfx(scene, quality)` is handed no Track — the VFX pass reads RaceState
 * and RaceState carries no surface — so the spray would otherwise have nothing
 * to key off. Rather than widen an interface owned by `game/main.ts`, the theme
 * publishes the pair it is already holding: `Theme.landmarks(ctx)` receives the
 * live `ctx.track`, runs exactly once per world build, and runs BEFORE the VFX
 * system is constructed (`buildWorld()` builds the environment first). Binding
 * from there means the table and the track can never disagree about which
 * planet is loaded.
 *
 * Deliberately module state and not a parameter: there is exactly one world at
 * a time, the alternative is a Track reference threaded through four call
 * sites in files this pass does not own, and the failure mode of a stale bind
 * is "last track's dust colour for one frame", not a crash.
 */
let _sprayTrack: Track | null = null
let _sprayTable: SurfaceSprayTable | null = null

/** Called by a theme's `landmarks` hook. Idempotent; last build wins. */
export function bindSurfaceSpray(track: Track, table: SurfaceSprayTable): void {
  _sprayTrack = track
  _sprayTable = table
}

/**
 * The spray look at a distance along the centreline.
 *
 * `cracked` is `RaceState.iceCracked`: once the shelf gives way the sim treats
 * a fragile sample as bare ice (`vehicle.ts`, `smp.fragile && ctx.iceCracked`),
 * so the spray has to agree — the lake stops throwing powder and starts
 * throwing chips at the same instant the grip changes.
 */
export function surfaceSprayAt(splineS: number, cracked: boolean): SurfaceSpray {
  const track = _sprayTrack
  const table = _sprayTable
  if (track === null || table === null) return DEFAULT_SPRAY
  const smp = track.at(splineS)
  const kind = cracked && smp.fragile ? 'ice' : smp.surface
  return table[kind] ?? DEFAULT_SPRAY
}

export interface Theme {
  id: string
  /** Hero props for the instanced scatter, built against the track palette. */
  props(pal: Palette, seg: number): PropSpec[]
  /** Landmarks and per-frame hooks. Called once per world build. */
  landmarks(ctx: ThemeContext): void
  /** Vertex colour for the terrain shell, before the grade onto the fog. */
  terrainColor(out: THREE.Color, p: TerrainPoint, pal: Palette): void
  terrainMaterial: { roughness: number; metalness: number }
  /** Distance at which the terrain has fully graded onto the fog colour. */
  terrainFade: [number, number]
  motes: MoteStyle
  /**
   * Material identity for the crosswind debris. See DebrisStyle.
   *
   * OPTIONAL ON PURPOSE, with three states, because the cue is owned by the
   * mechanic and not by the planet: omit it and a windy track gets
   * DEFAULT_DEBRIS for free, author it to dress the wind in local material,
   * or set it to `null` to opt out entirely. A track that authors no `wind`
   * anywhere builds no debris system at all whatever this says, so Rustfall
   * pays nothing for it.
   */
  debris?: DebrisStyle | null
  sky: SkyStyle
  fogBanks: FogBankStyle | null
  weather: WeatherStyle | null
  road: RoadStyle
  /** Prop material finish. Junk is semi-metallic; ice is not metal at all. */
  propMaterial: { roughness: number; metalness: number }
  /** What a sliding car throws up, per surface. See SurfaceSpray. */
  spray: SurfaceSprayTable
}
