/**
 * Track ribbon geometry.
 *
 * Everything here is generated straight from `track.samples`, using the SAME
 * banked frame the sim uses (`sample.pos + sample.right * lateral`, i.e.
 * `Track.surfacePoint`). The visual ribbon therefore ends exactly where
 * `|lateral| === sample.width`, which is the physics edge. Do not "improve"
 * the ribbon by widening or smoothing it independently of the samples: any
 * drift between this file and `Track.surfacePoint` is a gameplay bug, not an
 * art bug.
 *
 * Content:
 *   - road ribbon, split into ~120 m chunks so Three can frustum-cull it
 *   - surface shading (tarmac / metal / oil / ice / snow / gravel), crossfaded
 *     over ~12 m rather than switching per-sample
 *   - boost chevrons that scroll forward, drawn in the fragment shader on the
 *     road itself so there is no coplanar overlay to z-fight
 *   - 3 m edge walls, leaning inward. The barrier is where a driver reads
 *     speed from, so it is built as a rhythm of hard-edged features at fixed
 *     arc intervals — 2.4 m structural bays, 0.6 m corrugation, a chevron kerb
 *     at the foot and discrete sodium lamps every 7.2 m on the cap — rather
 *     than a continuous strip light, which smears into one flat band and tells
 *     peripheral vision nothing. `bounce` segments add a travelling pulse ON
 *     TOP of that structure instead of replacing it.
 *   - booster ramp decks: a raised wedge built from the same cross-section, so
 *     it inherits track width and banking exactly, plus approach chevrons, a
 *     launch gantry, side rails, struts and a landing-zone marker downrange
 *   - drop-off lips with hazard striping on `open` segments (no wall there)
 *   - viaduct piers and a soffit wherever the track climbs onto a flyover, so
 *     an elevated deck reads as a bridge over the junkyard floor instead of a
 *     ribbon floating over it (one merged mesh, one draw call, every tier)
 *   - a subtle dashed centre-line hint and a chequered start/finish band at s=0
 *   - a start gantry whose emission lives on a per-vertex attribute, so the
 *     lamps glow and the structure does not
 *
 * TWO PLANETS, ONE MESH, TWO PROGRAMS. The road's material has an INDUSTRIAL
 * and a GLACIAL branch, picked by a #define off the track's theme
 * (`themes/index.ts`), so a track pays for its own branch and nothing for the
 * other one and the two never share a compiled shader. Glacial adds packed
 * snow, a fresnel-driven fake subsurface for ice, an ice barrier, the cavern's
 * bioluminescent bounce walls, and the chevron CHAIN that lights the line
 * through the blizzard — which is a different object from Rustfall's boost pad
 * and needed different numbers to read as one.
 *
 * THE FRAGILE ICE SHELF. Where the sim can take a barrier away mid-race
 * (`RaceState.iceCracked`, mirrored through `render/hazardSignal.ts`), the
 * ribbon carries BOTH a barrier and a drop-off edge, and the vertex shader
 * sinks whichever one is not currently true — the wall through the ice, the
 * lip up out of it, travelling along the shelf rather than switching. No extra
 * draw call, no rebuilt mesh, and no vertex attribute: the shelf is identified
 * by arc length against a uniform, which the road already has.
 *
 * Everything above is faded out with view distance (`lodF` / `lodM`, derived
 * from gl_FragCoord.w) so sub-metre detail cannot alias into moire at 70 m/s.
 *
 * No image textures. All detail is vertex colour + procedural GLSL injected
 * into MeshStandardMaterial via onBeforeCompile, which is what buys us correct
 * shadow receive, fog and tone mapping on the road for free.
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { TUNING } from '../content/tuning'
import type { SurfaceKind, Track, TrackSample } from '../sim/track'
import type { RenderQuality, TrackVisual } from './api'
import { crackProgress } from './hazardSignal'
import { themeFor } from './themes'

/* ------------------------------------------------------------------ config */

/** Target chunk length in metres. Each chunk is one draw call. */
const CHUNK_LEN = 120
/** Wall height above the (banked) road surface, metres. */
const WALL_H = 3.0
/** How far the top of the wall leans in over the track. */
const WALL_LEAN = 0.42
/** Width of the flat cap on top of the wall. */
const WALL_CAP = 0.55
/**
 * How far BELOW the road edge the wall's outer skirt reaches.
 *
 * The barrier has no geometry on its outer side below the skirt — the inner
 * face is single sided and faces the track — so wherever the skirt stops above
 * the ground you can see straight through the wall from off-track. The ground
 * beside the ribbon is tucked under the road edge (`VERGE_TUCK` in
 * environment.ts) and that tuck deepens in proportion to `|right.y|`, i.e.
 * with the bank, so the skirt has to follow the same rule or the gap opens up
 * on exactly the banked corners where it is most visible. The bank term is
 * sized against the deepest tuck the low tier's coarse terrain grid asks for.
 */
const WALL_FOOT = 1.55
const WALL_FOOT_BANK = 7.4
/**
 * Skirt depth on a viaduct, where there is no verge to reach down to.
 *
 * Everything above is about meeting the GROUND, and under a flyover there is
 * none: environment.ts drops the terrain to the plateau below and the soffit
 * closes the deck instead. So the edge only has to be as deep as a deck plate
 * looks, and the bank term — which exists to chase a tuck that deepens with
 * cross-slope — is dead weight there.
 *
 * It is not free depth. Rustfall's flyover passes over the sweeper it crosses
 * with 18 m between the two centrelines, and once both were widened to 19.5 m a
 * side the deck came to overhang the sweeper's banked outer edge, which had
 * itself climbed 1.5 m. At a ground skirt's 2.35 m the underside of the deck
 * cleared that edge by 1.85 m — under the roof of a grounded racer, never mind
 * a hover. A 0.9 m viaduct edge gives 3.3 m, and reads as a bridge plate rather
 * than as a slab.
 */
const VIA_FOOT = 0.9
/** Drop-off lip on open sections: outward flange, then the fall. */
const LIP_OUT = 1.1
const LIP_DROP = 3.4
/** Half-width of the surface crossfade window, in samples (~1.5 m each). */
const BLEND_HALF = 4
/** Half-width of the boost-strip crossfade window, in samples. */
const BOOST_HALF = 3

/* ------------------------------------------------------------- ramp decks */
/**
 * A booster ramp is baked by the sim as a discrete 18 m run of samples with a
 * non-zero `ramp`. The visual deck covers exactly those samples plus an
 * approach apron upstream of them, and is built from the SAME cross-section as
 * the ribbon (`sample.pos + sample.right * lateral`, offset along
 * `sample.normal`), so it inherits width and banking for free and can never
 * drift away from the road it is sitting on.
 *
 * The sim launches the car the instant it touches the first ramp sample, so
 * the wedge is a READ, not a collider: nothing here is allowed to lift a car,
 * block one, or disagree with `Track.project()`. It stays under two metres and
 * the ribbon underneath it is left exactly where the physics thinks it is.
 */
/** Lateral inset of the deck from the physics edge, metres. Without it the
 *  deck's side skirt would be coplanar with the wall's inner face. */
const RAMP_INSET = 0.35
/** Thickness of the flat approach apron, metres. */
const RAMP_APRON_H = 0.07
/** Lip height above the road at the lowest / highest authored power, metres.
 *  Deliberately small — the sim does the launching, this only has to be read. */
const RAMP_LIFT_LO = 1.20
const RAMP_LIFT_HI = 2.00
/** Approach apron length at the lowest / highest power, metres. */
const RAMP_APRON_LO = 7.5
const RAMP_APRON_HI = 13.5
/** Authored ramp power mapped onto 0..1 for art scaling. Rustfall spans 24-34;
 *  the window is wider so a future 20 or 38 still lands inside it. */
const RAMP_POW_LO = 20
const RAMP_POW_HI = 38
/**
 * Nominal ground speed over a ramp, m/s. Only used to place the landing
 * marker. NOT a guess: 500 racer-laps of the headless sim put the median
 * launch-to-landing distance at 73 m (power 24), 96 (28), 110 (32) and 101
 * (34), and 52 is the single constant that fits all four inside 14 m. The
 * obvious 65-70 "a racer is doing 60-70 m/s" overshoots every one of them by
 * 30-45 m, because nothing thrusts while airborne and the AI arrives at the
 * chasm and descent ramps off a corner at barely 45.
 */
const RAMP_SPEED = 52
/** Arc length of the landing-zone plate, metres. Wide on purpose: the marker
 *  is only accurate to about 14 m, so it should read as a zone, not a spot. */
const LAND_LEN = 12.0
/** Rail / strut spacing along a deck, metres. */
const RAIL_STEP = 3.2

/** Vertex kinds consumed by the fragment shader. */
const KIND_ROAD = 0
const KIND_WALL = 1
const KIND_BOUNCE = 2
const KIND_LIP = 3
const KIND_RAMP = 4
/**
 * A fragile shelf carries BOTH a barrier and a drop-off edge, and the crack
 * swaps which one you can see. The sim does exactly the same thing — after
 * `iceCracked` a fragile sample is treated as `open`, so a car really can go
 * over that edge — and the two have to agree or the barrier a player sees is
 * not the barrier the car hits.
 *
 * These are the same wall and lip geometry as KIND_WALL / KIND_LIP; the
 * separate kind is what lets the vertex shader sink one and raise the other.
 */
const KIND_FWALL = 5
const KIND_FLIP = 6

/** `part` channel (aMix.z) inside KIND_RAMP. */
const PART_DECK = 0
const PART_SKIRT = 1
const PART_LIPFACE = 2
const PART_LAND = 3

/**
 * Base albedo per surface, authored in sRGB and converted on read.
 *
 * `ice` and `snow` were 0xa8d8e8 and 0xdfe9ee — a 0.85 and a 0.90 — which is
 * what snow looks like in a photograph taken at noon with the exposure pinned
 * to the sky. Under this game's key they rendered as paper, and GDD 09's rule
 * ("if a track section washes out the racers, the track is wrong") is not a
 * suggestion: the palest chassis in the field is 0.88 and simply vanished.
 *
 * They are now a mid blue-grey and a DARK saturated blue. Ice being dark is
 * not a compromise: real ice is dark, and everything bright about it — the
 * sheen, the rim, the depth glow — is a fresnel term, which is exactly what
 * the glacial branch of the shader below spends its budget on.
 */
const SURFACE_HEX: Record<SurfaceKind, number> = {
  tarmac: 0x33302d,
  metal: 0x5a6470,
  oil: 0x121110,
  ice: 0x2e5f79,
  snow: 0x8397a7,
  gravel: 0x6d5c46,
  // 'boost' is a flag in practice; treat the underlying surface as tarmac.
  boost: 0x33302d,
}

/**
 * Which shader effect each surface drives.
 *
 * The `slick` channel is also what the glacial branch reads to tell ice from
 * snow, so the gap between them has to be wide enough to survive the 12 m
 * crossfade between two surfaces: 0.45 against 1.0 leaves a clean threshold at
 * 0.5-0.9 with a transition band you can see rather than a hard seam.
 */
const SURFACE_MIX: Record<SurfaceKind, [number, number, number]> = {
  //        metal, oil,  slick
  tarmac: [0.0, 0.0, 0.0],
  metal: [1.0, 0.0, 0.0],
  oil: [0.2, 1.0, 0.0],
  ice: [0.0, 0.0, 1.0],
  snow: [0.0, 0.0, 0.45],
  gravel: [0.0, 0.0, 0.25],
  boost: [0.3, 0.0, 0.0],
}

/* ------------------------------------------------------------ scratch state */
// Module scope so update() never allocates.

const _col = new THREE.Color()

/* ---------------------------------------------------------------- geometry */

/** Accumulates one chunk's interleaved vertex data. Build-time only. */
class ChunkBuilder {
  private readonly pos: number[] = []
  private readonly nrm: number[] = []
  private readonly col: number[] = []
  private readonly trk: number[] = []
  private readonly mix: number[] = []
  private readonly idx: number[] = []

  /**
   * @param s     arc length along the lap, metres (unwrapped, so the final
   *              row of the final chunk reads `track.length`, not 0)
   * @param uM    lateral offset in metres (road) — unused elsewhere
   * @param uN    road: lateral/width in [-1,1]. Wall/lip: height fraction 0..1.
   * @param kind  KIND_* constant
   */
  vert(
    px: number, py: number, pz: number,
    nx: number, ny: number, nz: number,
    r: number, g: number, b: number,
    s: number, uM: number, uN: number, kind: number,
    metal: number, oil: number, slick: number, boost: number,
  ): number {
    const i = this.pos.length / 3
    this.pos.push(px, py, pz)
    this.nrm.push(nx, ny, nz)
    this.col.push(r, g, b)
    this.trk.push(s, uM, uN, kind)
    this.mix.push(metal, oil, slick, boost)
    return i
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d)
  }

  get empty(): boolean {
    return this.idx.length === 0
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3))
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nrm), 3))
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3))
    g.setAttribute('aTrack', new THREE.BufferAttribute(new Float32Array(this.trk), 4))
    g.setAttribute('aMix', new THREE.BufferAttribute(new Float32Array(this.mix), 4))
    g.setIndex(this.pos.length / 3 > 65535
      ? new THREE.BufferAttribute(new Uint32Array(this.idx), 1)
      : new THREE.BufferAttribute(new Uint16Array(this.idx), 1))
    g.computeBoundingSphere()
    g.computeBoundingBox()
    return g
  }
}

/** Per-sample surface data, crossfaded so transitions read as a blend. */
interface Blended {
  r: number; g: number; b: number
  metal: number; oil: number; slick: number
  boost: number
}

function blendSurfaces(track: Track): Blended[] {
  const m = track.samples.length
  const out: Blended[] = new Array(m)

  // Raw per-sample values first.
  const rawR = new Float32Array(m), rawG = new Float32Array(m), rawB = new Float32Array(m)
  const rawM = new Float32Array(m), rawO = new Float32Array(m), rawS = new Float32Array(m)
  const rawBo = new Float32Array(m)
  for (let i = 0; i < m; i++) {
    const smp = track.samples[i]
    _col.setHex(SURFACE_HEX[smp.surface] ?? SURFACE_HEX.tarmac)
    rawR[i] = _col.r; rawG[i] = _col.g; rawB[i] = _col.b
    const mix = SURFACE_MIX[smp.surface] ?? SURFACE_MIX.tarmac
    rawM[i] = mix[0]; rawO[i] = mix[1]; rawS[i] = mix[2]
    rawBo[i] = smp.boost ? 1 : 0
  }

  // Triangular-kernel convolution, wrapping at the loop seam.
  for (let i = 0; i < m; i++) {
    let r = 0, g = 0, b = 0, mt = 0, oi = 0, sl = 0, wsum = 0
    for (let d = -BLEND_HALF; d <= BLEND_HALF; d++) {
      const w = 1 - Math.abs(d) / (BLEND_HALF + 1)
      const j = ((i + d) % m + m) % m
      r += rawR[j] * w; g += rawG[j] * w; b += rawB[j] * w
      mt += rawM[j] * w; oi += rawO[j] * w; sl += rawS[j] * w
      wsum += w
    }
    let bo = 0, bw = 0
    for (let d = -BOOST_HALF; d <= BOOST_HALF; d++) {
      const w = 1 - Math.abs(d) / (BOOST_HALF + 1)
      const j = ((i + d) % m + m) % m
      bo += rawBo[j] * w
      bw += w
    }
    out[i] = {
      r: r / wsum, g: g / wsum, b: b / wsum,
      metal: mt / wsum, oil: oi / wsum, slick: sl / wsum,
      boost: Math.min(1, (bo / bw) * 1.25),
    }
  }
  return out
}

/** Smoothstep on an already-normalised t. */
function smooth01(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t
  return x * x * (3 - 2 * x)
}

/** Cheap deterministic hash for per-vertex wear variation. */
function hash2(a: number, b: number): number {
  let h = (a * 374761393 + b * 668265263) | 0
  h = (h ^ (h >>> 13)) | 0
  h = Math.imul(h, 1274126177) | 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/* ---------------------------------------------------------------- material */

/**
 * Shared by both stages: the fragile-shelf test.
 *
 * `uFrag` is (start arc, span) in metres for the track's one fragile ice
 * shelf, and `uCrack` is (collapse 0..1, flash envelope 0..1). Testing arc
 * length against a range costs nothing and needs no extra vertex attribute on
 * the other ninety per cent of the track — and the wrap is free, because the
 * distance is taken modulo the lap.
 *
 * The collapse RUNS along the shelf rather than the whole 363 m dropping at
 * once. That is the difference between ice giving way and a barrier being
 * switched off: a player watching from the entry sees the fracture travel away
 * from them down the lake, and a player mid-corner sees it arrive.
 */
const SHELF_GLSL = /* glsl */`
uniform float uLen;
uniform vec2  uFrag;
uniform vec2  uCrack;

/** -1 outside the shelf; inside, how far along it this point sits, 0..1. */
float sgShelf(float s) {
  if (uFrag.y <= 0.0) return -1.0;
  float d = mod(s - uFrag.x + uLen, uLen);
  return d <= uFrag.y ? d / uFrag.y : -1.0;
}

/** Local collapse strength, 0..1. Zero everywhere until the leader's lap 3. */
float sgCollapse(float s) {
  float t = sgShelf(s);
  if (t < 0.0) return 0.0;
  return clamp((uCrack.x * 1.62 - t) * 2.6, 0.0, 1.0);
}
`

const COMMON_FRAG = /* glsl */`
uniform float uTime;
uniform vec3  uAccent;
uniform vec3  uSodium;
varying vec4 vTrack;
varying vec4 vMix;

float sgHash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float sgNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = sgHash21(i), b = sgHash21(i + vec2(1.0, 0.0));
  float c = sgHash21(i + vec2(0.0, 1.0)), d = sgHash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float sgFbm(vec2 p) {
  return 0.58 * sgNoise(p) + 0.28 * sgNoise(p * 2.13) + 0.14 * sgNoise(p * 4.31);
}
`

const PATTERN_FRAG = /* glsl */`
float _rough = 0.92;
float _metal = 0.0;
vec3  _emit  = vec3(0.0);
{
  float kind  = vTrack.w;
  // The fragile shelf's barrier and its broken edge shade exactly as the
  // permanent ones do; only the vertex stage tells them apart.
  if (kind > 4.5) kind = kind < 5.5 ? 1.0 : 3.0;
  float sArc  = vTrack.x;
  float uM    = vTrack.y;
  float uN    = vTrack.z;
  float wMet  = vMix.x;
  float wOil  = vMix.y;
  float wSlk  = vMix.z;
  float wBst  = vMix.w;

  float grain = sgHash21(vec2(floor(sArc * 2.6), floor(uM * 2.6)));

  // Detail LOD. gl_FragCoord.w is 1/w_clip under a perspective camera, so this
  // is the view distance for free — no extra varying. Fine detail is faded out
  // with distance instead of being left to alias into a shimmering moire, which
  // at 70 m/s is the single ugliest artefact a procedural road can produce.
  float dist = 1.0 / max(gl_FragCoord.w, 1e-5);
  float lodF = 1.0 - smoothstep(26.0, 85.0, dist);    // sub-metre features
  float lodM = 1.0 - smoothstep(70.0, 260.0, dist);   // 2-8 m features

  if (kind < 0.5) {
    /* -------------------------------------------------- drivable surface */
    diffuseColor.rgb *= 1.0 + (0.24 * grain - 0.12) * lodF;
    diffuseColor.rgb *= 0.90 + 0.20 * sgFbm(vec2(sArc * 0.07, uM * 0.11));

#ifndef SG_GLACIAL
    // Metal decking: panel seams on a 4.2 x 2.6 m grid, plus bolt heads.
    float pu = abs(fract(uM / 2.6) - 0.5);
    float pv = abs(fract(sArc / 4.2) - 0.5);
    float seam = clamp((1.0 - smoothstep(0.010, 0.032, pu)) + (1.0 - smoothstep(0.008, 0.026, pv)), 0.0, 1.0) * wMet * lodM;
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.42, seam);
    float rv = length(fract(vec2(uM / 2.6, sArc / 4.2)) - 0.5);
    float bolt = (1.0 - smoothstep(0.052, 0.086, rv)) * wMet * lodF;
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.85, bolt * 0.55);
    _metal = mix(_metal, 0.70, wMet);
    _rough = mix(_rough, 0.44 - 0.16 * bolt, wMet);

    // Oil: near-black glossy patches with a faint thin-film sheen.
    float slickN = sgFbm(vec2(sArc * 0.085, uM * 0.14));
    float oilM = wOil * smoothstep(0.32, 0.72, slickN);
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.22, oilM);
    _rough = mix(_rough, 0.05, oilM);
    _emit += uAccent * oilM * 0.045 * (0.5 + 0.5 * sin(slickN * 24.0 + uM * 0.7));

    // Gravel and anything else that is merely slippery.
    _rough = mix(_rough, 0.14, wSlk * 0.65);
    diffuseColor.rgb *= 1.0 + wSlk * 0.10 * grain;
#else
    /* -------------------------------------- GLACIAL: packed snow and ice */
    //
    // THE CHEAP FAKE SUBSURFACE. One dot product and one pow, off the normal
    // and view vector three has already computed for the lighting pass. There
    // is no thickness map, no second pass and no blur: what sells ice is not
    // scattering, it is the SPLIT between looking through it and looking at
    // it, and a fresnel term is that split.
    vec3 gN = normalize(vNormal);
    vec3 gV = normalize(vViewPosition);
    // A tight exponent keeps the sheen on the last few degrees of grazing.
    // At 3.4 the whole mid-distance road turned into sheen and the ice went
    // pale exactly where it needed to stay a dark surface for cars to sit on.
    float fres = pow(1.0 - clamp(dot(gN, gV), 0.0, 1.0), 4.6);

    float ice = smoothstep(0.52, 0.92, wSlk);

    // Packed snow: drift ripples running ACROSS the road, because the wind on
    // this planet comes off the moraine and not down the straight. Plus a
    // sparse crystal sparkle, which is the only high-frequency detail here and
    // is faded out with lodF so it cannot boil at 70 m/s.
    float dune = sgFbm(vec2(sArc * 0.045, uM * 0.20));
    diffuseColor.rgb *= 0.80 + 0.40 * dune;
    // Sparse on purpose: at one cell in four hundred this is a glint you
    // notice, and at one in two hundred it is dirt on the lens.
    float spk = step(0.9975, sgHash21(floor(vec2(sArc * 7.0, uM * 7.0)) + 0.5)) * lodF;
    _emit += vec3(0.62, 0.78, 0.95) * spk * (1.0 - ice) * 0.30 * (0.3 + 0.7 * fres);
    _rough = mix(_rough, 0.88, (1.0 - ice) * 0.7);

    // GLACIER ICE. Face on you are looking THROUGH the sheet, so the colour is
    // the near-black water under it and the trapped-bubble cloud in it; at a
    // grazing angle you are looking AT it and it turns into a cold sheen. A
    // dark albedo plus that rim is what reads as ice; a pale albedo reads as
    // paper, which is what the grey-box did.
    float cloud = sgFbm(vec2(sArc * 0.09, uM * 0.13));
    float strat = sgNoise(vec2(sArc * 0.021, uM * 0.05));
    // Dark, but not black. Inside the ice tunnel there is no key light at all
    // and the face-on term is all you get, so the floor of this value has to
    // leave a surface for a car to sit on rather than a hole.
    vec3 deep = vec3(0.032, 0.084, 0.126) * (0.58 + 1.20 * cloud);
    vec3 iceCol = mix(deep, vec3(0.30, 0.47, 0.57), fres * 0.95);
    // Old fissures frozen into the sheet: visible into the depth, invisible on
    // the sheen, which is exactly how a flaw under a reflective surface works.
    float fis = 1.0 - smoothstep(0.0, 0.055, abs(strat - 0.5));
    iceCol = mix(iceCol, iceCol * 0.34, fis * (1.0 - fres) * 0.8);
    diffuseColor.rgb = mix(diffuseColor.rgb, iceCol, ice);
    _rough = mix(_rough, 0.055 + 0.20 * cloud, ice);
    // The depth glow — light that went in and came back out. Small on purpose:
    // this is the term that turns into a light box if you let it.
    _emit += vec3(0.05, 0.17, 0.24) * ice * (1.0 - fres) * cloud * 0.5;

    /* ---- THE SHELF GIVING WAY ---------------------------------------- */
    // The sim swaps a cracked shelf to bare ice for everyone, so the road has
    // to actually change rather than be decorated. What a player sees: a web
    // of fracture racing away down the lake, lit while it runs, and a bare ice
    // sweeper left behind it where there was packed snow on lap one.
    float col = sgCollapse(sArc);
    if (col > 0.0) {
      diffuseColor.rgb = mix(diffuseColor.rgb, iceCol, col * (1.0 - ice) * 0.92);
      _rough = mix(_rough, 0.07, col * 0.85);
      // Two crossed ridged-noise fields: a plausible shatter for two fbm taps.
      float f1 = 1.0 - smoothstep(0.0, 0.030, abs(sgFbm(vec2(sArc * 0.16, uM * 0.16)) - 0.5));
      float f2 = 1.0 - smoothstep(0.0, 0.022, abs(sgFbm(vec2(uM * 0.21 + 9.0, sArc * 0.055)) - 0.5));
      float web = clamp(f1 + f2 * 0.8, 0.0, 1.0) * lodM;
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.006, 0.014, 0.022), web * col * 0.9);
      // Bright at the FRONT of the fracture only, so the light travels with
      // the break instead of the whole shelf glowing and then stopping.
      float front = col * (1.0 - col) * 4.0;
      _emit += vec3(0.50, 0.88, 1.0) * web * (0.05 * col + 2.1 * front * uCrack.y);
    }
#endif

    // Racing-line hint: dashed, low contrast, deliberately not a rail.
    float cl = (1.0 - smoothstep(0.15, 0.27, abs(uM))) * step(0.42, fract(sArc / 6.0));
    diffuseColor.rgb += cl * 0.05;

    // Edge hazard striping so the physics boundary is legible at speed.
    float edge = smoothstep(0.88, 0.985, abs(uN));
    float haz  = step(0.5, fract((sArc + uM) * 0.55));
    diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.03), uSodium, haz), edge * 0.5);
    _emit += uSodium * edge * haz * 0.09;

#ifndef SG_GLACIAL
    // Boost strip: chevrons pointing (and scrolling) forward along +s.
    // Phase is shifted by the NORMALISED lateral coordinate, so the V keeps its
    // shape as the ribbon narrows. 4 m pitch scrolling at 16 m/s: fast enough
    // to read as thrust, slow enough not to strobe at 60 Hz.
    float lane  = 1.0 - smoothstep(0.66, 0.94, abs(uN));
    float bmask = wBst * lane;
    float cp    = fract(sArc * 0.25 + abs(uN) * 0.32 - uTime * 4.0);
    // ~0.6 m of bright arrow in a 4 m pitch, with a shallow forward point.
    // Wider or hotter than this and a 30 m pad becomes one sheet of light with
    // no readable rhythm — which is the opposite of what a boost strip is for.
    float chev  = smoothstep(0.70, 0.85, cp) * (1.0 - smoothstep(0.89, 0.985, cp));
    // Pad edges: one bar where the strip starts and stops, so a boost pad reads
    // as a discrete object rather than a smear of glow.
    float capEdge = (1.0 - smoothstep(0.12, 0.42, abs(wBst - 0.5))) * lane;
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.022, 0.030, 0.036), bmask * 0.85);
    diffuseColor.rgb += uAccent * bmask * chev * 0.12;
    _emit += uAccent * bmask * (0.05 + 1.10 * chev);
    _emit += uAccent * capEdge * 0.70;
    _rough = mix(_rough, 0.20, bmask);
#else
    /* ---- THE CHEVRON CHAIN THROUGH THE WHITEOUT --------------------- */
    //
    // Rustfall's boost strip is a 30 m PAD on a 39 m road: a lane-wide sheet of
    // arrows you cross. Cryostatic's is a 230 m CHAIN on a 48 m road, in the
    // one place on the track where you cannot see the barriers, and it is the
    // only thing telling a driver where the line is. Reusing the pad's numbers
    // there produced exactly what you would expect — 57 arrows at 1.1 emissive
    // across a 48 m road, bloomed into one continuous white floor with the
    // racers invisible on top of it.
    //
    // So the chain is narrower, longer-pitched and dimmer than the pad, and the
    // pad is left alone because Rustfall is art-locked:
    //
    //   lane   the middle ~55% of the road, not its full width. THIS is what
    //          makes it read as a line to follow rather than as lit ground.
    //   13 m   pitch. About 18 arrows over the straight, which is countable at
    //          70 m/s, where a 4 m pitch is a texture.
    //   10.5 m of forward sweep across the half-width: a 24-degree V that
    //          survives a glance. It must stay under the pitch or the phase
    //          wraps laterally and the arrow comes back as a herringbone —
    //          which is the whole reason the pitch had to grow with it.
    //   0.52   peak emission. The fog it is seen through is doing half the
    //          work, and the racers have to stay brighter than the road.
    //   rail   two dim lines at the lane edge. In a whiteout the information a
    //          driver loses first is which way is sideways.
    float lane  = 1.0 - smoothstep(0.26, 0.56, abs(uN));
    float bmask = wBst * lane;
    float cp    = fract((sArc - abs(uN) * 10.5) / 13.0 - uTime * 0.85);
    float chev  = smoothstep(0.74, 0.88, cp) * (1.0 - smoothstep(0.90, 0.985, cp));
    // Two dim rails at the lane's edges, so the chain has WIDTH as well as a
    // centre: in a whiteout the thing a driver needs is which way is sideways.
    float rail = (1.0 - smoothstep(0.030, 0.085, abs(abs(uN) - 0.46))) * wBst;
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.020, 0.034, 0.042), bmask * 0.80);
    diffuseColor.rgb += uAccent * bmask * chev * 0.10;
    _emit += uAccent * bmask * (0.025 + 0.52 * chev);
    _emit += uAccent * rail * 0.16;
    _rough = mix(_rough, 0.20, bmask);
#endif

    // Start / finish: chequered band plus a hard accent line exactly at s = 0.
    float sd = min(sArc, uLen - sArc);
    float band = 1.0 - smoothstep(1.55, 1.85, sd);
    float cheq = mod(floor(sArc / 0.9) + floor(uM / 1.15), 2.0);
    diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.84), vec3(0.04), cheq), band);
    _emit += vec3(0.9, 0.92, 1.0) * band * (1.0 - cheq) * 0.28;
    _emit += uAccent * (1.0 - smoothstep(0.10, 0.30, sd)) * 1.4;
    _rough = mix(_rough, 0.55, band);

  } else if (kind < 2.5) {
    /* --------------------------------------------------------- edge wall */
    // A racer reads speed off the wall more than off the road, so the wall is
    // built as a rhythm of hard-edged features at fixed arc intervals: a 2.4 m
    // structural bay, a 0.6 m corrugation inside it, discrete cap lamps every
    // 7.2 m and a chevron kerb at the base. Peripheral vision integrates all
    // four frequencies into a strong sense of travel.
    float h = clamp(uN, 0.0, 1.0);

    float bay  = fract(sArc / 2.4);
    float bayC = abs(bay - 0.5) * 2.0;                  // 0 mid-bay, 1 at a post
    float post = smoothstep(0.74, 0.95, bayC) * lodM;   // stiffening post
    float seam = (1.0 - smoothstep(0.0, 0.09, bayC)) * lodM;  // recessed joint
    float corr = (abs(fract(sArc / 0.6) - 0.5) * 2.0 - 0.5) * lodF + 0.5;

    // Value structure: dark at the foot, posts catching the key, seams in
    // shadow, corrugation rippling across the lot.
    float shade = 0.58 + 0.58 * h;
    shade *= 0.82 + 0.30 * corr;
    shade *= mix(1.0, 1.55, post);
    shade *= mix(1.0, 0.46, seam);
    shade *= 1.0 + (0.28 * grain - 0.14) * lodF;
    diffuseColor.rgb *= shade;

#ifndef SG_GLACIAL
    // Rust bleeding down from the cap: vertical, so it shears sideways at
    // speed and gives the corrugation something to beat against.
    float streak = smoothstep(0.52, 0.90, sgFbm(vec2(sArc * 1.15, 4.0))) * lodM;
    diffuseColor.rgb = mix(diffuseColor.rgb,
      diffuseColor.rgb * vec3(1.75, 0.78, 0.42), streak * (0.35 + 0.5 * h) * 0.75);

    _rough = 0.80 - 0.22 * post;
    // Low metalness on purpose: there is no environment map in this scene, so
    // a metallic barrier has nothing to reflect and collapses to a silhouette.
    _metal = 0.14 + 0.16 * post;
#else
    // Cast-ice barrier. The RHYTHM above is untouched — bays, corrugation, cap
    // lamps and a kerb at the same arc pitches — because that rhythm is how a
    // driver reads speed off a wall, and it is a racing thing rather than a
    // Rustfall thing. Only the material changes: dark blue-green blocks with a
    // fresnel rim, so the barrier is a SILHOUETTE with a lit edge rather than
    // a bright band competing with the cars in front of it.
    vec3 wN = normalize(vNormal);
    vec3 wV = normalize(vViewPosition);
    float wf = pow(1.0 - clamp(dot(wN, wV), 0.0, 1.0), 2.4);
    diffuseColor.rgb = mix(diffuseColor.rgb,
      vec3(0.052, 0.126, 0.168) * (0.72 + 0.85 * corr), 0.88);
    diffuseColor.rgb += vec3(0.13, 0.26, 0.32) * wf * (0.20 + 0.80 * h);
    // Rime frosting where the wind piles snow against the barrier's foot.
    float rime = smoothstep(0.62, 0.95, sgFbm(vec2(sArc * 0.55, 2.0))) * lodM;
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.30, 0.36, 0.41),
      rime * (1.0 - smoothstep(0.05, 0.55, h)) * 0.65);
    _rough = 0.34 - 0.14 * post;
    _metal = 0.0;
#endif

    // Chevron kerb along the foot of the wall: the highest-contrast feature on
    // the whole barrier and the one that carries the speed read.
    float kerb = 1.0 - smoothstep(0.15, 0.24, h);
    float chev = smoothstep(0.42, 0.50, fract(sArc * 0.40 + h * 1.30));
    diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.018), uSodium * 0.80, chev), kerb * 0.92);
    _emit += uSodium * kerb * chev * 0.12;

    // Cap: discrete sodium lamps, not a continuous strip. A continuous rail
    // smears into one flat band and tells you nothing about how fast you are
    // going; lamps tick past and tell you everything.
    float cap  = smoothstep(0.86, 0.995, h);
    float lamp = 1.0 - smoothstep(0.040, 0.095, abs(fract(sArc / 7.2) - 0.5));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.055, 0.048, 0.042), cap * 0.75);
    diffuseColor.rgb += uSodium * cap * lamp * 0.28;
    _emit += uSodium * cap * lamp * 1.25;
    _emit += uSodium * cap * 0.040;   // faint rail so the line still reads far off
    _rough = mix(_rough, 0.55, cap);

    if (kind > 1.5) {
#ifndef SG_GLACIAL
      // Bounce wall: a travelling accent pulse laid OVER the same structure.
      // Narrow bars on the bay pitch, not a 50%-duty flood — a corridor of
      // solid light is blinding, hides the barrier it is painted on, and gives
      // the driver nothing to judge closing speed against.
      float wave = smoothstep(0.45, 1.0, fract(sArc * 0.045 - uTime * 0.45));
      float bar  = smoothstep(0.78, 0.97, abs(fract(sArc / 2.4 - uTime * 0.55) - 0.5) * 2.0);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.020, 0.045, 0.062), 0.45);
      diffuseColor.rgb += uAccent * bar * 0.12;
      _emit += uAccent * bar * (0.18 + 1.10 * wave) * (0.22 + 0.78 * smoothstep(0.04, 0.60, h));
      _metal = 0.34;
      _rough = 0.42;
#else
      // BIOLUMINESCENT ICE — beat 3, the lighting showpiece.
      //
      // The cavern's bounce walls are the light source in there: near-black
      // rock overhead, and the only illumination coming out of veins in the
      // ice you are bouncing off. Organic, so the veins are ridged noise
      // rather than the industrial bar pattern, and they breathe on a slow
      // period instead of scrolling — a cave does not travel.
      //
      // Held under 2.2 total. Past that the bloom fuses the veins into one
      // sheet, the rock stops reading as black, and the whole point of putting
      // emissive ice against near-black rock is lost.
      float vein = 1.0 - smoothstep(0.0, 0.052, abs(sgFbm(vec2(sArc * 0.19, h * 1.9)) - 0.5));
      float pulse = 0.5 + 0.5 * sin(uTime * 0.85 + sArc * 0.05);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.016, 0.070, 0.092), 0.62);
      diffuseColor.rgb += uAccent * vein * 0.10;
      _emit += uAccent * vein * (0.20 + 0.62 * pulse) * (0.20 + 0.80 * smoothstep(0.02, 0.55, h));
      // A dim wash off the whole block, so the wall still reads as ice with
      // light inside it where there happens to be no vein.
      _emit += uAccent * 0.045 * (0.25 + 0.75 * h);
      _metal = 0.0;
      _rough = 0.22;
#endif
    }

  } else if (kind < 3.5) {
    /* ------------------------------------------------- open-section lip */
    float h = clamp(uN, 0.0, 1.0);
#ifndef SG_GLACIAL
    diffuseColor.rgb = mix(diffuseColor.rgb * 0.75, vec3(0.015), h);
    float haz = step(0.5, fract(sArc * 0.55 + h * 1.4));
    float top = 1.0 - smoothstep(0.0, 0.32, h);
    diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.02), uSodium, haz), top * 0.9);
    _emit += uSodium * top * haz * (0.85 + 0.45 * sin(uTime * 3.0));
    _rough = 0.85;
#else
    // A torn shelf edge, and the same treatment on the chasm's open sections:
    // the underside of a sheet that has snapped. Dark and wet-looking, lit
    // only along the fracture at the top, so from the road you see a bright
    // broken lip with NOTHING under it — which is precisely the information
    // the sim is now enforcing, because a cracked shelf is drivable-off.
    diffuseColor.rgb = mix(vec3(0.058, 0.120, 0.155), vec3(0.006, 0.016, 0.026), h);
    float top = 1.0 - smoothstep(0.0, 0.26, h);
    float jag = smoothstep(0.35, 0.85, abs(fract(sArc * 0.36 + h) - 0.5) * 2.0);
    _emit += vec3(0.46, 0.80, 0.96) * top * (0.20 + 0.30 * jag);
    // One hazard tick in the sodium amber, so the edge still reads as a
    // hazard at 60 m in fog and not just as pretty ice.
    _emit += uSodium * top * step(0.55, fract(sArc * 0.30)) * 0.38;
    _rough = 0.24;
#endif

  } else {
    /* ------------------------------------------------- booster ramp deck */
    // For KIND_RAMP the aMix channels are reused: there is no surface blend on
    // a bolted-on steel deck, and the deck needs its own coordinate frame.
    //   x = metres from the deck's leading edge   z = part id
    //   y = normalised launch power 0..1          w = total deck length, metres
    // Anchoring the pattern to the DECK rather than to world arc length is the
    // whole trick: chevrons then start and stop exactly with the plate instead
    // of sliding off its ends by whatever (sArc mod pitch) happens to be.
    float dS   = vMix.x;
    float pw   = vMix.y;
    float part = vMix.z;
    float dL   = max(vMix.w, 1.0);
    float u    = clamp(dS / dL, 0.0, 1.0);

    // Everything hot scales off this, so a 34-power ramp is visibly angrier
    // than a 24 without a single hard-coded case. The ceiling is deliberately
    // near the wall lamps' 1.25: past that the bloom fuses every chevron into
    // one continuous sheet and the deck stops having a rhythm to read.
    float hot = 0.42 + 0.95 * pw;
    // ...and shifts toward white as it gets hotter, which reads as temperature
    // rather than as "same light, turned up".
    vec3 chevCol = mix(uAccent, vec3(0.80, 0.95, 1.0), pw * 0.45);

    if (part < 0.5) {
      /* ---- deck plate: rolled steel, bolted down, hazard-flanked -------- */
      diffuseColor.rgb = vec3(0.072, 0.068, 0.064) * (0.82 + 0.36 * grain);
      float pu = abs(fract(uM / 2.2) - 0.5);
      float pv = abs(fract(dS / 1.4) - 0.5);
      float seam = clamp((1.0 - smoothstep(0.012, 0.040, pu))
                       + (1.0 - smoothstep(0.010, 0.034, pv)), 0.0, 1.0) * lodM;
      diffuseColor.rgb *= mix(1.0, 0.46, seam);
      float rv = length(fract(vec2(uM / 2.2, dS / 1.4)) - 0.5);
      float bolt = (1.0 - smoothstep(0.055, 0.092, rv)) * lodF;
      diffuseColor.rgb *= 1.0 + 0.85 * bolt;
      _metal = 0.60;
      _rough = 0.44 - 0.16 * bolt;

      // Hazard hatching down both flanks. The middle third stays clean so the
      // chevrons own the racing line instead of fighting a striped floor.
      float flank = smoothstep(0.62, 0.90, abs(uN));
      float haz = step(0.5, fract(dS * 0.60 + abs(uM) * 0.60));
      diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.020), uSodium, haz), flank * 0.80);
      _emit += uSodium * flank * haz * 0.16;

      // Launch chevrons: big forward-pointing arrows, scrolling at ~11 m/s.
      //
      // Three numbers decide whether these read as arrows or as a cattle grid.
      //   5.6  metres the deck EDGE sits behind the centre line. This is what
      //        makes the V a V. It is applied through the NORMALISED lateral,
      //        so the arrow keeps its angle as the ribbon narrows. 5.6 m
      //        across an 11 m lane is 26 degrees, which survives a 60 m/s
      //        glance; the first pass used 3.6 and read as transverse bars.
      //   7.5  the pitch, in metres. It must exceed the sweep or the phase
      //        wraps laterally and the arrow returns as a herringbone. It also
      //        happens to fit about four arrows on a deck, which is a rhythm.
      //   aw   the lit band, held near 1 m of deck inside that 7.5 m pitch.
      //        Wider than this at this emission and bloom fuses the four
      //        arrows into one lit box, which is exactly what the first pass
      //        did before the band was narrowed and the emission halved.
      float lane = 1.0 - smoothstep(0.62, 0.92, abs(uN));
      float cp = fract((dS - abs(uN) * 5.6) / 7.5 - uTime * 1.45);
      float aw = 0.10 + 0.055 * pw;          // arrow gets fatter with power
      float chev = smoothstep(0.88 - aw, 0.88, cp) * (1.0 - smoothstep(0.895, 0.955, cp));
      float grow = 0.30 + 0.70 * smoothstep(0.02, 0.70, u);
      diffuseColor.rgb += chevCol * lane * chev * grow * 0.16;
      _emit += chevCol * lane * chev * grow * hot * 1.05;

      // The launch edge: one hard bar of light across the last 0.6 m, which is
      // the single pixel row a driver actually aims at.
      float lip = 1.0 - smoothstep(0.0, 0.60 / dL, 1.0 - u);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.020), lip * 0.8);
      _emit += chevCol * lip * hot * 1.00;
      // Dimmer sodium bar at the toe so the deck reads as a discrete object
      // rather than as the road quietly going bright.
      float toe = 1.0 - smoothstep(0.0, 0.55 / dL, u);
      _emit += uSodium * toe * 0.55;
      _rough = mix(_rough, 0.24, max(lip, toe));

    } else if (part < 1.5) {
      /* ---- side skirt: the wedge seen from the flank ------------------- */
      float h = clamp(uN, 0.0, 1.0);
      diffuseColor.rgb = vec3(0.078, 0.064, 0.052) * (0.78 + 0.44 * grain);
      float stripe = step(0.5, fract(dS * 0.42 + h * 0.85));
      diffuseColor.rgb = mix(diffuseColor.rgb,
        mix(vec3(0.026, 0.022, 0.019), uSodium * 0.85, stripe), 0.82);
      _emit += uSodium * stripe * 0.11 * smoothstep(0.10, 0.85, h);
      _metal = 0.22;
      _rough = 0.74;

    } else if (part < 2.5) {
      /* ---- back face of the lip: the drop you have already left -------- */
      float h = clamp(uN, 0.0, 1.0);
      diffuseColor.rgb = vec3(0.030, 0.028, 0.027) * (0.70 + 0.60 * grain);
      _emit += chevCol * smoothstep(0.70, 1.0, h) * hot * 0.85;
      _metal = 0.40;
      _rough = 0.55;

    } else {
      /* ---- landing zone ------------------------------------------------ */
      // Where a mid-pack racer actually comes down. Deliberately quiet: two
      // thin transverse bars and hatching that fades out of the middle, so the
      // gap reads as designed without painting a wall across the racing line.
      float bar = clamp((1.0 - smoothstep(0.0, 0.11, u))
                      + (1.0 - smoothstep(0.0, 0.11, 1.0 - u)), 0.0, 1.0);
      float hatch = step(0.5, fract(dS * 0.34 + uM * 0.34)) * smoothstep(0.20, 0.78, abs(uN));
      diffuseColor.rgb = vec3(0.034, 0.031, 0.028);
      diffuseColor.rgb = mix(diffuseColor.rgb, uSodium * 0.42, hatch * 0.85);
      _emit += uSodium * hatch * 0.20;
      _emit += chevCol * bar * (0.52 + 0.22 * sin(uTime * 2.0)) * (0.55 + 0.75 * pw);
      _metal = 0.20;
      _rough = 0.62;
    }
  }
}
`

interface SurfaceUniforms {
  uTime: { value: number }
  uLen: { value: number }
  uAccent: { value: THREE.Color }
  uSodium: { value: THREE.Color }
  /** (start arc, span) metres of the track's fragile ice shelf. */
  uFrag: { value: THREE.Vector2 }
  /** (collapse 0..1, flash envelope 0..1). */
  uCrack: { value: THREE.Vector2 }
}

/**
 * The arc range of the track's fragile ice shelf, as (start, span) in metres.
 *
 * ONE contiguous run is supported, which is what a shelf is: Cryostatic's lake
 * is a single 363 m stretch of `fragile: true` nodes. A track with two separate
 * shelves would need a second uniform pair and a second test in the shader —
 * cheap, but not worth carrying until a track asks for it. So this returns the
 * LONGEST run rather than the first, and a second one would simply never
 * collapse, which is a visible bug rather than a silent wrong answer.
 */
function fragileRange(track: Track): [number, number] {
  const m = track.samples.length
  const res = track.length / m
  // Start the walk on a non-fragile sample, so a run cannot be split at the
  // loop seam and counted as two.
  let i = 0
  while (i < m && track.samples[i].fragile) i++
  if (i >= m) return [0, track.length]
  let bestStart = 0, bestLen = 0
  for (let n = 0; n < m; ) {
    const a = (i + n) % m
    if (!track.samples[a].fragile) { n++; continue }
    let len = 0
    while (len < m && track.samples[(i + n + len) % m].fragile) len++
    if (len > bestLen) { bestLen = len; bestStart = a }
    n += len
  }
  return [(bestStart / m) * track.length, bestLen * res]
}

function makeSurfaceMaterial(track: Track): {
  mat: THREE.MeshStandardMaterial
  uniforms: SurfaceUniforms
} {
  const pal = track.def.palette
  const glacial = themeFor(track.def.id).road === 'glacial'
  const [fragStart, fragSpan] = fragileRange(track)
  const uniforms: SurfaceUniforms = {
    uTime: { value: 0 },
    uLen: { value: track.length },
    uAccent: { value: new THREE.Color().setHex(pal.accent) },
    uSodium: { value: new THREE.Color().setHex(pal.b) },
    uFrag: { value: new THREE.Vector2(fragStart, fragSpan) },
    uCrack: { value: new THREE.Vector2(0, 0) },
  }

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.9,
    metalness: 0.0,
    emissive: 0x000000,
    dithering: true,
  })

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime
    shader.uniforms.uLen = uniforms.uLen
    shader.uniforms.uAccent = uniforms.uAccent
    shader.uniforms.uSodium = uniforms.uSodium
    shader.uniforms.uFrag = uniforms.uFrag
    shader.uniforms.uCrack = uniforms.uCrack
    // One #define picks the planet's material branch, so a track pays for the
    // branch it uses and nothing for the one it does not — there is no runtime
    // test per fragment, and the two never share a compiled program.
    if (glacial) shader.defines = { ...(shader.defines ?? {}), SG_GLACIAL: '' }

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        attribute vec4 aTrack;
        attribute vec4 aMix;
        varying vec4 vTrack;
        varying vec4 vMix;
        ${SHELF_GLSL}
      `)
      .replace('#include <begin_vertex>', /* glsl */`
        #include <begin_vertex>
        vTrack = aTrack;
        vMix = aMix;
        // THE BARRIER GOES THROUGH THE ICE.
        //
        // A fragile shelf carries both a wall and a drop-off edge; which one
        // you can see is a vertex displacement, not a second draw call or a
        // rebuilt mesh. The wall's cap falls twice as far as its foot, so the
        // barrier folds forward as it sinks rather than telescoping straight
        // down, and both are driven off sgCollapse() — which travels along the
        // shelf, so the fracture is something you watch run away from you.
        if (aTrack.w > 4.5) {
          float sgC = sgCollapse(aTrack.x);
          if (aTrack.w < 5.5) transformed.y -= sgC * (3.4 + 7.6 * clamp(aTrack.z, 0.0, 1.0));
          else                transformed.y -= (1.0 - sgC) * 15.0;
        }
      `)

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${SHELF_GLSL}\n${COMMON_FRAG}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${PATTERN_FRAG}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(_rough, 0.03, 1.0);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = clamp(_metal, 0.0, 1.0);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += _emit;')
  }
  // Two planets, two programs. Sharing one cache key across both would hand
  // the second track the first one's compiled shader and dress it wrong.
  mat.customProgramCacheKey = () => `spacegen-track-surface-${glacial ? 'glacial' : 'industrial'}`

  return { mat, uniforms }
}

/* --------------------------------------------------------------- hardware */

/**
 * Every piece of built steel on the track — the start gate and the ramp
 * gantries — shares this one material, so the two merged meshes share a shader
 * compile and a `uPulse`. Emission rides on a per-vertex `aGlow` attribute
 * rather than on the material, so exactly the lamp blocks glow and the pylons
 * and headers stay unlit steel. (Putting `emissive` on the material lights
 * every triangle in a merged mesh, which is what once turned the start gate
 * into a cyan billboard.) `aGlow` is a magnitude, not a flag: a hotter ramp
 * writes a bigger number into the same attribute.
 */
interface Hardware {
  mat: THREE.MeshStandardMaterial
  /** Drives the accent light bars only — never the structure. */
  pulse: { value: number }
}

function makeHardwareMaterial(): Hardware {
  const pulse = { value: 0.9 }
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.62, metalness: 0.16, dithering: true,
  })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uPulse = pulse
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGlow;\nvarying float vGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uPulse;\nvarying float vGlow;')
      .replace(
        '#include <emissivemap_fragment>',
        // Each lit element glows in its OWN albedo, so the accent studs read
        // cyan and the sodium centre lamp reads gold from the same attribute.
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vGlow * uPulse;',
      )
  }
  mat.customProgramCacheKey = () => 'spacegen-track-hardware'
  return { mat, pulse }
}

/* ------------------------------------------------------------ placement */

const _mBasis = new THREE.Matrix4()
const _vX = new THREE.Vector3()
const _vY = new THREE.Vector3()
const _vZ = new THREE.Vector3()

/**
 * Drop one box into the merge list, oriented by a track sample's own frame:
 * local +x is LEFT (-right), +y is the banked surface normal, +z is forward
 * along the tangent. That ordering is deliberately left-handed-corrected —
 * `normal = right x tangent`, so the basis (right, normal, tangent) has a
 * negative determinant and would mirror every box it touched.
 *
 * `pitch` rotates about +x (nose up/down relative to the road), `roll` about
 * +z (lean sideways). Both are applied to the geometry before the basis, so a
 * strut leans in the track's frame, not the world's — which is the only way a
 * gantry stays upright through Rustfall's 34-degree banked ring.
 */
function placePart(
  parts: THREE.BufferGeometry[], geo: THREE.BufferGeometry, smp: TrackSample,
  lat: number, up: number, along: number,
  hex: number, glow = 0, pitch = 0, roll = 0,
): void {
  geo.deleteAttribute('uv')
  if (pitch !== 0) geo.rotateX(pitch)
  if (roll !== 0) geo.rotateZ(roll)
  const n = geo.getAttribute('position').count
  _col.setHex(hex)
  const c = new Float32Array(n * 3)
  const g = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    c[i * 3] = _col.r; c[i * 3 + 1] = _col.g; c[i * 3 + 2] = _col.b
    g[i] = glow
  }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3))
  geo.setAttribute('aGlow', new THREE.BufferAttribute(g, 1))
  _vX.set(-smp.right.x, -smp.right.y, -smp.right.z)
  _vY.set(smp.normal.x, smp.normal.y, smp.normal.z)
  _vZ.set(smp.tangent.x, smp.tangent.y, smp.tangent.z)
  _mBasis.makeBasis(_vX, _vY, _vZ)
  _mBasis.setPosition(
    smp.pos.x + smp.right.x * lat + smp.normal.x * up + smp.tangent.x * along,
    smp.pos.y + smp.right.y * lat + smp.normal.y * up + smp.tangent.y * along,
    smp.pos.z + smp.right.z * lat + smp.normal.z * up + smp.tangent.z * along,
  )
  geo.applyMatrix4(_mBasis)
  parts.push(geo)
}

/* ------------------------------------------------------------ start gantry */

/**
 * The gate that straddles the line at s = 0.
 *
 * This is the single most camera-filling object in the game: the race starts
 * with it directly overhead, so anything wrong with it becomes a slab of colour
 * across the top of the frame. It is therefore built as DARK STRUCTURE with a
 * few narrow emissive bars, riding the shared `Hardware` material so exactly
 * those bars glow and the pylons and header stay unlit steel. Still one draw
 * call.
 */
function buildStartGate(track: Track, hw: Hardware): THREE.Mesh {
  const smp = track.samples[0]
  const pal = track.def.palette
  const w = smp.width + 1.4
  const parts: THREE.BufferGeometry[] = []

  const push = (
    geo: THREE.BufferGeometry, lat: number, up: number, along: number,
    hex: number, glow = 0,
  ) => placePart(parts, geo, smp, lat, up, along, hex, glow)

  const STEEL = 0x5c564d
  const DARK = 0x35312b
  // The grid camera sits 15 m back and 4 m up, so the header is unavoidably in
  // frame at the start — as it is in every racing game. What matters is that it
  // reads as a lit steel structure with depth, not as an opaque band. Hence:
  // high header, shallow girder, slim open pylons, low metalness (there is no
  // environment map in this scene, so a metallic surface has nothing to
  // reflect and renders as a silhouette).
  const HEAD = 12.4

  for (const side of [-1, 1]) {
    // Pylon: a boxed lattice rather than one slab, so it reads as structure.
    push(new THREE.BoxGeometry(0.95, HEAD, 0.95), side * w, HEAD / 2, 0, STEEL)
    push(new THREE.BoxGeometry(0.26, HEAD - 0.8, 1.15), side * (w + 0.52), HEAD / 2, 0, DARK)
    push(new THREE.BoxGeometry(0.26, HEAD - 0.8, 1.15), side * (w - 0.52), HEAD / 2, 0, DARK)
    // Diagonal braces.
    push(new THREE.BoxGeometry(0.20, 6.2, 0.20), side * (w + 0.48), 3.4, 0.58, pal.a)
    push(new THREE.BoxGeometry(0.20, 6.2, 0.20), side * (w + 0.48), 8.9, -0.58, pal.a)
    // Rusted concrete footing.
    push(new THREE.BoxGeometry(2.8, 1.0, 2.8), side * w, 0.46, 0, pal.a)
    push(new THREE.BoxGeometry(2.2, 0.3, 2.2), side * w, 1.05, 0, STEEL)
    // Emissive elements on the pylon: four short marker studs, not a strip, so
    // the pylon still reads as a structure with lights on it.
    for (let i = 0; i < 5; i++) {
      push(new THREE.BoxGeometry(0.10, 0.55, 0.26), side * (w - 0.58), 2.6 + i * 1.9, 0, pal.accent, 1)
    }
  }

  // Header: a deep box girder with a service walkway, all dark.
  push(new THREE.BoxGeometry(w * 2 + 1.0, 0.80, 1.05), 0, HEAD - 0.1, 0, STEEL)
  push(new THREE.BoxGeometry(w * 2 + 0.3, 0.22, 1.40), 0, HEAD + 0.45, 0, DARK)
  push(new THREE.BoxGeometry(w * 2 - 1.2, 0.34, 0.34), 0, HEAD - 0.85, 0, pal.c)
  // Hanger rods down to the timing beam.
  for (let i = -3; i <= 3; i++) {
    push(new THREE.BoxGeometry(0.10, 0.80, 0.10), (i / 3.2) * w, HEAD - 1.05, -0.52, STEEL)
  }
  // Timing beam: seven discrete lamp blocks rather than one continuous bar.
  for (let i = -3; i <= 3; i++) {
    push(new THREE.BoxGeometry(1.05, 0.22, 0.14), (i / 3.2) * w, HEAD - 1.48, -0.56,
      i === 0 ? pal.b : pal.accent, 1)
  }

  const mesh = new THREE.Mesh(mergeAll(parts), hw.mat)
  mesh.name = 'start-gate'
  return mesh
}

/** mergeGeometries without importing the whole addon barrel at call sites. */
function mergeAll(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false)
  for (const p of parts) p.dispose()
  if (!merged) throw new Error('trackMesh: geometry merge failed')
  merged.computeBoundingSphere()
  return merged
}

/* ------------------------------------------------------------ ramp decks */

interface RampDeck {
  /** Authored launch velocity, m/s. */
  power: number
  /** Power normalised to 0..1. EVERYTHING the art scales, scales off this. */
  p01: number
  /** Lip height above the road, metres. */
  lift: number
  /** Approach apron length, metres (snapped to whole samples). */
  apron: number
  /** Total visual deck length, metres (apron + the sim's ramp run). */
  deckLen: number
  /** First sample of the visual deck — the leading edge of the apron. */
  iStart: number
  /** First sample the sim launches from. */
  iLaunch: number
  /** Last sample of the deck: the launch lip. */
  iLip: number
  /** First sample of the landing plate, and its middle. */
  iLand: number
  iLandMid: number
  /** Landing plate length, metres (snapped to whole samples). */
  landLen: number
}

interface RampIndex {
  decks: RampDeck[]
  /** Per sample: index into `decks`, or -1. */
  deckOf: Int32Array
  /** Per sample: metres from the deck's leading edge. */
  deckS: Float32Array
  /** Per sample: deck height above the road surface, metres. */
  deckH: Float32Array
  /** Per sample: index into `decks` for a landing plate, or -1. */
  landOf: Int32Array
  /** Per sample: metres from the landing plate's leading edge. */
  landS: Float32Array
}

/**
 * Height of the deck above the road at `dS` metres along it.
 *
 * Two shapes in one: a flat approach apron, then a concave kicker. The kicker
 * matters — a linear wedge that gains 2 m over 18 m is a 6-degree slope and
 * reads as a bump in the road, whereas holding the rise back and spending most
 * of it in the last third ends on about 13 degrees and reads as a launcher,
 * for the same (deliberately small) lip height.
 *
 * The apron tapers on over exactly ONE sample, so the leading edge meets the
 * ribbon at the ribbon's own vertices: nothing is left coplanar for the depth
 * buffer to argue about, and there is no step to trip the eye.
 */
function rampHeight(dS: number, d: RampDeck, res: number): number {
  if (dS <= 0) return 0
  if (dS < d.apron) return RAMP_APRON_H * Math.min(1, dS / res)
  const t = Math.min(1, (dS - d.apron) / Math.max(1e-3, d.deckLen - d.apron))
  return RAMP_APRON_H + (d.lift - RAMP_APRON_H) * (0.25 * t + 0.75 * Math.pow(t, 2.4))
}

/**
 * How far downrange a mid-pack racer actually comes down, solved against the
 * track's own elevation instead of assuming it lands at launch height.
 * Rustfall's descent ramp launches 5.7 m above where it lands and flies half
 * again as far as the flat-ground formula predicts; putting the marker where
 * the flat formula says would be worse than not marking it at all.
 */
function landingDistance(track: Track, launchS: number, launchY: number, power: number): number {
  const g = Math.abs(TUNING.sim.gravity)
  const y0 = launchY + 0.35        // the sim lifts the car by this on launch
  let t = (2 * power) / g
  for (let k = 0; k < 6; k++) {
    const y1 = track.at(launchS + RAMP_SPEED * t).pos.y
    t = (power + Math.sqrt(Math.max(0, power * power + 2 * g * (y0 - y1)))) / g
  }
  return RAMP_SPEED * t
}

/** Find every baked ramp run and precompute its deck, per sample. */
function resolveRamps(track: Track): RampIndex {
  const samples = track.samples
  const m = samples.length
  const res = track.length / m
  const decks: RampDeck[] = []
  const deckOf = new Int32Array(m).fill(-1)
  const deckS = new Float32Array(m)
  const deckH = new Float32Array(m)
  const landOf = new Int32Array(m).fill(-1)
  const landS = new Float32Array(m)
  const claimed = new Uint8Array(m)

  for (let i = 0; i < m; i++) {
    const power = samples[i].ramp
    if (power <= 0 || claimed[i]) continue

    // Walk to both ends of this run. The sim bakes a discrete ~18 m deck, so
    // this is a dozen steps, but it wraps at the loop seam for free.
    let a = i
    while (samples[(a - 1 + m) % m].ramp === power && (a - 1 + m) % m !== i) a = (a - 1 + m) % m
    let b = i
    while (samples[(b + 1) % m].ramp === power && (b + 1) % m !== a) b = (b + 1) % m
    for (let k = a; ; k = (k + 1) % m) { claimed[k] = 1; if (k === b) break }

    const p01 = Math.max(0, Math.min(1, (power - RAMP_POW_LO) / (RAMP_POW_HI - RAMP_POW_LO)))
    const apronN = Math.max(2, Math.round((RAMP_APRON_LO + (RAMP_APRON_HI - RAMP_APRON_LO) * p01) / res))
    const rampN = (b - a + m) % m
    const landN = Math.max(2, Math.round(LAND_LEN / res))
    const d: RampDeck = {
      power, p01,
      lift: RAMP_LIFT_LO + (RAMP_LIFT_HI - RAMP_LIFT_LO) * p01,
      apron: apronN * res,
      deckLen: (apronN + rampN) * res,
      iStart: (a - apronN + m) % m,
      iLaunch: a,
      iLip: b,
      iLand: 0, iLandMid: 0, landLen: landN * res,
    }
    const launchS = (a / m) * track.length
    const dist = landingDistance(track, launchS, samples[a].pos.y, power)
    d.iLand = track.indexAt(launchS + dist - d.landLen * 0.5)
    d.iLandMid = track.indexAt(launchS + dist)

    const id = decks.length
    decks.push(d)
    for (let k = 0; k <= apronN + rampN; k++) {
      const idx = (d.iStart + k) % m
      deckOf[idx] = id
      deckS[idx] = k * res
      deckH[idx] = rampHeight(k * res, d, res)
    }
    for (let k = 0; k <= landN; k++) {
      const idx = (d.iLand + k) % m
      // Never paint a landing zone over another ramp's plate.
      if (deckOf[idx] >= 0) continue
      landOf[idx] = id
      landS[idx] = k * res
    }
  }
  return { decks, deckOf, deckS, deckH, landOf, landS }
}

/**
 * One segment of raised deck: the plate itself plus the side skirt that closes
 * the wedge down onto the road.
 *
 * The cross-section is the ribbon's own — `pos + right * lateral`, lifted along
 * `normal` — inset by RAMP_INSET so the skirt does not end up coplanar with
 * the wall's leaning inner face. Width and banking therefore come for free and
 * cannot drift from `Track.surfacePoint`.
 */
function emitRampDeck(
  b: ChunkBuilder, sa: TrackSample, sb: TrackSample,
  arcA: number, arcB: number, lat: number,
  ri: RampIndex, ia: number, ib: number,
): void {
  const d = ri.decks[ri.deckOf[ia]]
  const hA = ri.deckH[ia], hB = ri.deckH[ib]
  const sA = ri.deckS[ia], sB = ri.deckS[ib]
  const wA = sa.width - RAMP_INSET, wB = sb.width - RAMP_INSET
  const pw = d.p01, len = d.deckLen

  // The plate's true normal tilts back with the slope. Cheap, and worth it:
  // at the lip the deck is 13 degrees off the road, and lighting it as if it
  // were flat road is exactly what makes a wedge look painted on.
  const slope = (hB - hA) / Math.max(1e-3, sB - sA)
  const inv = 1 / Math.hypot(1, slope)
  const dnx = (sa.normal.x - sa.tangent.x * slope) * inv
  const dny = (sa.normal.y - sa.tangent.y * slope) * inv
  const dnz = (sa.normal.z - sa.tangent.z * slope) * inv

  const rowA: number[] = [], rowB: number[] = []
  for (let j = 0; j <= lat; j++) {
    const t = (j / lat) * 2 - 1
    const wear = 0.88 + 0.24 * hash2(ia, j)
    const uA = t * wA, uB = t * wB
    rowA.push(b.vert(
      sa.pos.x + sa.right.x * uA + sa.normal.x * hA,
      sa.pos.y + sa.right.y * uA + sa.normal.y * hA,
      sa.pos.z + sa.right.z * uA + sa.normal.z * hA,
      dnx, dny, dnz,
      0.06 * wear, 0.058 * wear, 0.056 * wear,
      arcA, uA, t, KIND_RAMP,
      sA, pw, PART_DECK, len,
    ))
    rowB.push(b.vert(
      sb.pos.x + sb.right.x * uB + sb.normal.x * hB,
      sb.pos.y + sb.right.y * uB + sb.normal.y * hB,
      sb.pos.z + sb.right.z * uB + sb.normal.z * hB,
      dnx, dny, dnz,
      0.06 * wear, 0.058 * wear, 0.056 * wear,
      arcB, uB, t, KIND_RAMP,
      sB, pw, PART_DECK, len,
    ))
  }
  for (let j = 0; j < lat; j++) b.quad(rowA[j], rowA[j + 1], rowB[j + 1], rowB[j])

  // Side skirts. Zero-height at the very first segment (the taper), which
  // collapses to a degenerate quad and costs nothing.
  for (const side of [-1, 1]) {
    const nx = sa.right.x * side, ny = sa.right.y * side, nz = sa.right.z * side
    const axb = sa.pos.x + sa.right.x * side * wA
    const ayb = sa.pos.y + sa.right.y * side * wA
    const azb = sa.pos.z + sa.right.z * side * wA
    const bxb = sb.pos.x + sb.right.x * side * wB
    const byb = sb.pos.y + sb.right.y * side * wB
    const bzb = sb.pos.z + sb.right.z * side * wB
    const v0 = b.vert(axb, ayb, azb, nx, ny, nz, 0.09, 0.075, 0.062, arcA, side * wA, 0, KIND_RAMP, sA, pw, PART_SKIRT, len)
    const v1 = b.vert(axb + sa.normal.x * hA, ayb + sa.normal.y * hA, azb + sa.normal.z * hA,
      nx, ny, nz, 0.09, 0.075, 0.062, arcA, side * wA, 1, KIND_RAMP, sA, pw, PART_SKIRT, len)
    const v2 = b.vert(bxb + sb.normal.x * hB, byb + sb.normal.y * hB, bzb + sb.normal.z * hB,
      nx, ny, nz, 0.09, 0.075, 0.062, arcB, side * wB, 1, KIND_RAMP, sB, pw, PART_SKIRT, len)
    const v3 = b.vert(bxb, byb, bzb, nx, ny, nz, 0.09, 0.075, 0.062, arcB, side * wB, 0, KIND_RAMP, sB, pw, PART_SKIRT, len)
    // Outward-facing: the skirt is the outside of the wedge.
    if (side > 0) b.quad(v0, v3, v2, v1)
    else b.quad(v0, v1, v2, v3)
  }
}

/** The vertical drop behind the launch lip, closing the wedge. */
function emitRampLipFace(
  b: ChunkBuilder, sa: TrackSample, arcA: number, lat: number,
  ri: RampIndex, ia: number,
): void {
  const d = ri.decks[ri.deckOf[ia]]
  const h = ri.deckH[ia]
  const w = sa.width - RAMP_INSET
  const nx = sa.tangent.x, ny = sa.tangent.y, nz = sa.tangent.z
  const bot: number[] = [], top: number[] = []
  for (let j = 0; j <= lat; j++) {
    const t = (j / lat) * 2 - 1
    const u = t * w
    const px = sa.pos.x + sa.right.x * u
    const py = sa.pos.y + sa.right.y * u
    const pz = sa.pos.z + sa.right.z * u
    bot.push(b.vert(px, py, pz, nx, ny, nz, 0.05, 0.048, 0.046,
      arcA, u, 0, KIND_RAMP, ri.deckS[ia], d.p01, PART_LIPFACE, d.deckLen))
    top.push(b.vert(px + sa.normal.x * h, py + sa.normal.y * h, pz + sa.normal.z * h,
      nx, ny, nz, 0.05, 0.048, 0.046,
      arcA, u, 1, KIND_RAMP, ri.deckS[ia], d.p01, PART_LIPFACE, d.deckLen))
  }
  for (let j = 0; j < lat; j++) b.quad(bot[j], top[j], top[j + 1], bot[j + 1])
}

/**
 * The landing-zone plate: a thin painted deck downrange, tapered into the road
 * at both ends so it has no floating edge. Quiet on purpose — it answers "is
 * there anything on the far side of this gap", not "look at me".
 */
function emitLandingPlate(
  b: ChunkBuilder, sa: TrackSample, sb: TrackSample,
  arcA: number, arcB: number, lat: number,
  ri: RampIndex, ia: number, ib: number, res: number,
): void {
  const d = ri.decks[ri.landOf[ia]]
  const sA = ri.landS[ia], sB = ri.landS[ib]
  const hA = RAMP_APRON_H * Math.min(1, sA / res, (d.landLen - sA) / res)
  const hB = RAMP_APRON_H * Math.min(1, sB / res, (d.landLen - sB) / res)
  const rowA: number[] = [], rowB: number[] = []
  for (let j = 0; j <= lat; j++) {
    const t = (j / lat) * 2 - 1
    const uA = t * sa.width, uB = t * sb.width
    rowA.push(b.vert(
      sa.pos.x + sa.right.x * uA + sa.normal.x * hA,
      sa.pos.y + sa.right.y * uA + sa.normal.y * hA,
      sa.pos.z + sa.right.z * uA + sa.normal.z * hA,
      sa.normal.x, sa.normal.y, sa.normal.z, 0.05, 0.048, 0.045,
      arcA, uA, t, KIND_RAMP, sA, d.p01, PART_LAND, d.landLen,
    ))
    rowB.push(b.vert(
      sb.pos.x + sb.right.x * uB + sb.normal.x * hB,
      sb.pos.y + sb.right.y * uB + sb.normal.y * hB,
      sb.pos.z + sb.right.z * uB + sb.normal.z * hB,
      sb.normal.x, sb.normal.y, sb.normal.z, 0.05, 0.048, 0.045,
      arcB, uB, t, KIND_RAMP, sB, d.p01, PART_LAND, d.landLen,
    ))
  }
  for (let j = 0; j < lat; j++) b.quad(rowA[j], rowA[j + 1], rowB[j + 1], rowB[j])
}

/**
 * The launch hardware: gantry, deck rails, lip towers and landing beacons for
 * EVERY ramp on the track, merged into one mesh and one draw call. Four ramps
 * cost what one costs.
 *
 * Everything is placed in the sample's own frame, so it banks with the road —
 * the descent ramp sits on 7.6 degrees of negative bank and a world-up gantry
 * there would visibly lean off its own footings.
 *
 * Two placement rules earn their keep:
 *   - Anything outboard clears the wall. The barrier's inner face LEANS IN
 *     (WALL_LEAN) and caps at WALL_CAP, so `width + 1.45` is the first lateral
 *     that is genuinely outside it at every height.
 *   - Nothing spans the track above the lip. A car leaves the deck at 24-34 m/s
 *     of vertical and a slow entry is 15 m up by the time it passes the lip, so
 *     the arch goes over the deck's MOUTH, where the car is provably still on
 *     the ground, and the lip gets two open towers instead of a header.
 */
function buildRampStructure(
  track: Track, ri: RampIndex, quality: RenderQuality, hw: Hardware,
): THREE.Mesh | null {
  // The low tier keeps the wedge and its chevrons and drops all of this.
  if (quality.tier === 'low' || ri.decks.length === 0) return null

  const samples = track.samples
  const m = samples.length
  const res = track.length / m
  const pal = track.def.palette
  const parts: THREE.BufferGeometry[] = []
  const at = (i: number): TrackSample => samples[((i % m) + m) % m]
  const box = (w: number, h: number, dp: number) => new THREE.BoxGeometry(w, h, dp)

  const STEEL = 0x5c564d
  const DARK = 0x35312b

  for (const d of ri.decks) {
    const p = d.p01
    const start = at(d.iStart)
    const lip = at(d.iLip)

    /* ---- launch gantry over the mouth of the deck --------------------- */
    const gw = start.width + 1.45
    const gh = 10.5 + 3.4 * p
    for (const side of [-1, 1]) {
      placePart(parts, box(0.80, gh, 0.80), start, side * gw, gh / 2, -1.8, STEEL)
      placePart(parts, box(0.22, gh - 1.2, 1.00), start, side * (gw + 0.42), gh / 2, -1.8, DARK)
      placePart(parts, box(0.22, gh - 1.2, 1.00), start, side * (gw - 0.42), gh / 2, -1.8, DARK)
      placePart(parts, box(2.5, 0.9, 2.5), start, side * gw, 0.42, -1.8, pal.a)
      // Knee brace leaning in under the header.
      placePart(parts, box(0.18, 5.4, 0.18), start, side * (gw - 0.85), 3.7, -1.8, pal.a, 0, 0, -side * 0.30)
      for (let k = 0; k < 4; k++) {
        placePart(parts, box(0.10, 0.50, 0.24), start, side * (gw - 0.46), 2.6 + k * 2.0, -1.8,
          pal.accent, 0.50 + 0.95 * p)
      }
    }
    placePart(parts, box(gw * 2 + 0.9, 0.72, 0.95), start, 0, gh, -1.8, STEEL)
    placePart(parts, box(gw * 2 + 0.3, 0.20, 1.25), start, 0, gh + 0.40, -1.8, DARK)
    placePart(parts, box(Math.max(2, gw * 2 - 2.6), 1.35, 0.14), start, 0, gh - 1.05, -2.15, DARK)
    // Lamp bar: discrete blocks, not a strip. Both the count and the glow
    // magnitude ride on power, so a 34 gantry is wider awake than a 24.
    const lamps = 5 + 2 * Math.round(2 * p)
    for (let k = 0; k < lamps; k++) {
      const f = (k / (lamps - 1)) * 2 - 1
      placePart(parts, box(0.80, 0.20, 0.14), start, f * (gw - 1.0), gh - 1.86, -2.22,
        pal.accent, 0.55 + 1.25 * p)
    }

    /* ---- side rails along the deck ------------------------------------ */
    const railN = Math.max(3, Math.floor(d.deckLen / RAIL_STEP))
    const railLen = d.deckLen / railN
    const lampEvery = quality.propDensity >= 0.9 ? 2 : 3
    for (let k = 0; k < railN; k++) {
      const s0 = (k + 0.5) * railLen
      const smp = at(d.iStart + Math.round(s0 / res))
      const h0 = rampHeight(s0 - railLen * 0.5, d, res)
      const h1 = rampHeight(s0 + railLen * 0.5, d, res)
      const hm = (h0 + h1) * 0.5
      const pitch = -Math.atan2(h1 - h0, railLen)
      const lx = smp.width - RAMP_INSET + 0.20
      for (const side of [-1, 1]) {
        placePart(parts, box(0.16, 0.38, railLen + 0.45), smp, side * lx, hm + 0.68, 0, pal.b, 0, pitch)
        placePart(parts, box(0.14, 0.62, 0.18), smp, side * lx, hm + 0.31, 0, DARK)
        if (k % lampEvery === 1) {
          placePart(parts, box(0.11, 0.16, 0.34), smp, side * (lx - 0.13), hm + 0.90, 0,
            pal.accent, 0.45 + 0.85 * p)
        }
      }
    }

    /* ---- towers framing the lip --------------------------------------- */
    const tw = lip.width + 1.45
    const th = 6.2 + 3.6 * p
    for (const side of [-1, 1]) {
      // Chunky on purpose. The bottom three metres are behind the barrier, so
      // a slim tower is a stick with a light on it by the time you can see it.
      placePart(parts, box(1.00, th, 1.20), lip, side * tw, th / 2, 0, STEEL, 0, 0, side * 0.10)
      placePart(parts, box(0.30, th - 1.6, 1.55), lip, side * (tw + 0.56), th / 2, 0, DARK, 0, 0, side * 0.10)
      placePart(parts, box(2.2, 0.9, 2.2), lip, side * tw, 0.42, 0, pal.a)
      placePart(parts, box(1.25, 0.34, 1.25), lip, side * tw, 3.35, 0, DARK)
      placePart(parts, box(0.20, th * 0.66, 0.28), lip, side * (tw - 0.58), th * 0.50, -0.64,
        pal.accent, 0.42 + 0.70 * p)
      // Board angled back up the track, so it faces the driver on approach.
      placePart(parts, box(2.6, 1.15, 0.18), lip, side * (tw - 0.75), th + 0.62, -0.62, pal.b, 0.30, 0.32)
      placePart(parts, box(1.30, 0.30, 0.22), lip, side * (tw - 0.75), th + 0.62, -0.83,
        pal.accent, 0.70 + 1.20 * p, 0.32)
    }

    /* ---- landing beacons ---------------------------------------------- */
    // On a walled section they stand on the wall cap; on an `open` one there is
    // no wall, so they sit on the drop-off flange instead.
    const land = at(d.iLandMid)
    const openEdge = land.open
    const bx = openEdge ? land.width + LIP_OUT * 0.55 : land.width + WALL_CAP * 0.5
    const by = openEdge ? -0.24 : WALL_H
    for (const side of [-1, 1]) {
      placePart(parts, box(0.34, 2.6, 0.34), land, side * bx, by + 1.30, 0, DARK)
      placePart(parts, box(0.62, 0.60, 0.62), land, side * bx, by + 2.92, 0, pal.accent, 0.65 + 0.95 * p)
      placePart(parts, box(1.9, 0.70, 0.16), land, side * (bx - 0.52), by + 1.95, -0.34, pal.b, 0.40)
    }
  }

  const mesh = new THREE.Mesh(mergeAll(parts), hw.mat)
  mesh.name = 'ramp-hardware'
  return mesh
}

/* ----------------------------------------------------------- viaduct piers */

/**
 * Where the track climbs onto a flyover it stops being a road on the ground
 * and becomes a bridge, and `environment.ts` treats it as one: it leaves the
 * terrain on the plateau below instead of dragging an embankment up with the
 * deck (which is what used to make the flyover read as a plane slicing past a
 * road rather than as ground far beneath it). Without something holding the
 * ribbon up, that leaves it floating.
 *
 * A run is a viaduct when the lowest point of its cross-section stands
 * `VIA_LO`+ above the lowest drivable point anywhere within `VIA_BASE_R` of
 * it. environment.ts applies the SAME test to decide where to drop the
 * ground — the two must agree, or piers appear where there is no drop or the
 * ground drops away with nothing under the deck. They share the numbers by
 * copy rather than by import so neither art module has to know the other
 * exists; if you change one, change both.
 *
 * `open` sections are excluded: those are the chasm, where the point is that
 * there is nothing underneath.
 */
const VIA_BASE_R = 155
const VIA_LO = 4.0
const VIA_HI = 9.5
/** Bay spacing along a viaduct, metres. */
const PIER_STEP = 26

/** Fractions of a bay to try, in order, when the authored spot is unusable. */
const BAY_NUDGES = [0, 0.18, -0.18, 0.34, -0.34, 0.5, -0.5]
/** Lateral offset of a pier leg as a fraction of the deck's half-width. */
const PIER_LEG_F = 0.46
/** Half-thickness of a pier leg plus its outer fin, metres. */
const PIER_LEG_R = 1.1
/** Samples either side of a pier that count as its own deck rather than as
 *  something it could land on. 60 samples is ~90 m of track. */
const PIER_SELF_SPAN = 60

/**
 * True when both legs of a pier at `idx` stand clear of every OTHER part of the
 * ribbon, measured in plan against that part's own forgiving edge.
 *
 * Everything here is a function of `sample.width` on both sides — the leg's own
 * offset and the corridor it has to miss — so a pier can never be re-broken by
 * a width change on either the deck or the road underneath it.
 */
function legsClearOtherTrack(samples: TrackSample[], idx: number, m: number): boolean {
  const smp = samples[idx]
  const hl = Math.hypot(smp.right.x, smp.right.z) || 1
  const ox = smp.right.x / hl, oz = smp.right.z / hl
  const legLat = smp.width * PIER_LEG_F
  for (const side of [-1, 1]) {
    const lx = smp.pos.x + ox * side * legLat
    const lz = smp.pos.z + oz * side * legLat
    for (let j = 0; j < m; j++) {
      const d = Math.abs(((j - idx + m + m / 2) % m) - m / 2)
      if (d < PIER_SELF_SPAN) continue
      const o = samples[j]
      const ohl = Math.hypot(o.right.x, o.right.z) || 1
      const need = o.width * ohl * TUNING.offTrack.edgeTolerance
        + TUNING.collision.racerRadius + PIER_LEG_R
      const dx = lx - o.pos.x, dz = lz - o.pos.z
      if (dx * dx + dz * dz < need * need) return false
    }
  }
  return true
}

const _pierM = new THREE.Matrix4()
const _pierQ = new THREE.Quaternion()
const _pierE = new THREE.Euler()
const _pierP = new THREE.Vector3()
const _pierS = new THREE.Vector3(1, 1, 1)

/** Give a geometry the flat colour and glow magnitude the Hardware material
 *  reads, and strip the uv the merge does not want. */
function tagGeo(geo: THREE.BufferGeometry, hex: number, glow: number): THREE.BufferGeometry {
  geo.deleteAttribute('uv')
  const n = geo.getAttribute('position').count
  _col.setHex(hex)
  const c = new Float32Array(n * 3)
  const g = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    c[i * 3] = _col.r; c[i * 3 + 1] = _col.g; c[i * 3 + 2] = _col.b
    g[i] = glow
  }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3))
  geo.setAttribute('aGlow', new THREE.BufferAttribute(g, 1))
  return geo
}

/** Drop one world-axis box (yawed only) into the merge list. Piers stand
 *  upright even where the deck they carry is banked over. */
function placeUpright(
  parts: THREE.BufferGeometry[], geo: THREE.BufferGeometry,
  x: number, y: number, z: number, yaw: number, hex: number, glow = 0,
): void {
  tagGeo(geo, hex, glow)
  _pierE.set(0, yaw, 0)
  _pierQ.setFromEuler(_pierE)
  _pierP.set(x, y, z)
  geo.applyMatrix4(_pierM.compose(_pierP, _pierQ, _pierS))
  parts.push(geo)
}

/**
 * The soffit: a downward-facing plate closing the box between the two wall
 * skirts over one viaduct run.
 *
 * The road ribbon is single sided — its back faces are culled, which is right
 * everywhere it sits on the ground and wrong the moment you can stand under
 * it. Without this you look up at the flyover from the junkyard floor and see
 * the sky straight through the deck. The plate meets the skirts exactly where
 * `emitWall` puts their feet, so the deck closes into a box rather than a
 * sandwich with a slot down each side.
 */
function emitSoffit(
  track: Track, i0: number, count: number, via: Float64Array,
): THREE.BufferGeometry {
  const samples = track.samples
  const m = samples.length
  const rows = count + 1
  const pos = new Float32Array(rows * 2 * 3)
  const nrm = new Float32Array(rows * 2 * 3)
  const idx: number[] = []
  for (let r = 0; r < rows; r++) {
    const si = (i0 + r) % m
    const smp = samples[si]
    const foot = wallFoot(smp, via[si])
    const out = smp.width + WALL_CAP + 0.12
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? -1 : 1
      const k = (r * 2 + s) * 3
      pos[k] = smp.pos.x + smp.right.x * side * out - smp.normal.x * foot
      pos[k + 1] = smp.pos.y + smp.right.y * side * out - smp.normal.y * foot
      pos[k + 2] = smp.pos.z + smp.right.z * side * out - smp.normal.z * foot
      nrm[k] = -smp.normal.x; nrm[k + 1] = -smp.normal.y; nrm[k + 2] = -smp.normal.z
    }
    if (r > 0) {
      const a = (r - 1) * 2, b = a + 1, c = r * 2, d = c + 1
      // Wound so the visible face is the one pointing DOWN.
      idx.push(a, c, b, b, c, d)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  geo.setIndex(idx)
  return geo
}

/**
 * Per-sample viaduct weight and the height of the plateau each section stands
 * on. Computed ONCE and shared by the piers, the soffit and the wall skirt:
 * the three have to agree about where the ground stops being under the road,
 * because between them they decide how thick the deck's edge is.
 */
function viaductWeights(track: Track): { via: Float64Array; base: Float64Array } {
  const samples = track.samples
  const m = samples.length
  const res = track.length / m
  /**
   * A VIADUCT IS A LEVEL ROAD STANDING ON THE GROUND ON LEGS, and on a gravity
   * track neither half of that survives a wall-ride: the ribbon hangs a full
   * half-width DOWN the wall, so `lowY` there is `width` metres below the
   * centreline. That drags the plateau minimum down for everything within
   * VIA_BASE_R, and the perfectly ordinary level road on either side of the
   * wall reads as a bridge deck twenty metres in the air -- growing a soffit,
   * a wall skirt sized for a viaduct, and a row of piers trying to reach a
   * floor that is not there.
   *
   * So on a gravity track a sample that is not roughly level is excluded from
   * BOTH roles: it is not a viaduct candidate, and it is not ground for anyone
   * else's plateau. 0.7 is about 45 degrees off level.
   *
   * Gated on hasGravity rather than applied unconditionally because Rustfall's
   * banked flyover is exactly the case this must not touch.
   */
  const levelOnly = track.hasGravity
  const LEVEL = 0.7
  const lowY = new Float64Array(m)
  for (let i = 0; i < m; i++) {
    lowY[i] = samples[i].pos.y - Math.abs(samples[i].right.y) * samples[i].width
  }
  // Coarse both ways: the plateau test only needs metre accuracy and it is
  // O(n^2) otherwise.
  const stride = Math.max(1, Math.round(6 / res))
  const R2 = VIA_BASE_R * VIA_BASE_R
  const base = new Float64Array(m)
  const via = new Float64Array(m)
  for (let i = 0; i < m; i += stride) {
    let b = Infinity
    for (let j = 0; j < m; j += stride) {
      if (levelOnly && samples[j].normal.y < LEVEL) continue
      const dx = samples[i].pos.x - samples[j].pos.x
      const dz = samples[i].pos.z - samples[j].pos.z
      if (dx * dx + dz * dz < R2 && lowY[j] < b) b = lowY[j]
    }
    for (let k = i; k < Math.min(m, i + stride); k++) base[k] = b
  }
  for (let i = 0; i < m; i++) {
    if (samples[i].open) continue
    if (levelOnly && samples[i].normal.y < LEVEL) continue
    // A neighbourhood with no level sample in it has no plateau to measure
    // against; `base` is +Infinity there and the subtraction is -Infinity,
    // which clamps to 0 anyway, but say so rather than relying on it.
    if (!Number.isFinite(base[i])) continue
    const t = Math.max(0, Math.min(1, (lowY[i] - base[i] - VIA_LO) / (VIA_HI - VIA_LO)))
    via[i] = t * t * (3 - 2 * t)
  }
  return { via, base }
}

function buildViaductPiers(
  track: Track, hw: Hardware, via: Float64Array, base: Float64Array,
): THREE.Mesh | null {
  const samples = track.samples
  const m = samples.length
  const res = track.length / m
  const pal = track.def.palette
  const STEEL = 0x5c564d
  const DARK = 0x35312b

  const parts: THREE.BufferGeometry[] = []
  const step = Math.max(2, Math.round(PIER_STEP / res))

  // Walk contiguous runs. The soffit spans the whole run so the deck closes
  // even where it is only part way up; piers only stand where the drop is
  // worth a bay.
  let i = 0
  // Start the walk at a sample that is on the ground, so a run cannot be split
  // across the loop seam.
  while (i < m && via[i] > 0) i++
  const start = i % m
  for (let n = 0; n < m; ) {
    const a = (start + n) % m
    if (via[a] <= 0.04) { n++; continue }
    let len = 0
    while (len < m && via[(start + n + len) % m] > 0.04) len++
    parts.push(tagGeo(emitSoffit(track, a, len, via), pal.c, 0))

    for (let k = Math.floor(step / 2); k < len; k += step) {
      // A viaduct is a viaduct because it is over something, and on Rustfall the
      // something is the sweeper the flyover crosses. Piers stand `width * 0.46`
      // off the deck's centreline and go all the way to the floor, so a bay that
      // lands on the crossing plants two 1.15 m legs in the middle of a road
      // 10 m below. That was survivable while the legs were 6 m apart and the
      // sweeper was 26 m wide; at 9 m and 39 m it is not.
      //
      // Slide the bay along the run until both legs clear every other part of
      // the track, and drop it if nothing inside half a bay works. The soffit
      // spans the whole run either way, so a missing pier leaves a gap in the
      // rhythm, never a hole in the deck.
      let idx = -1
      for (const nudge of BAY_NUDGES) {
        const cand = (a + k + Math.round(nudge * step) + m) % m
        if (via[cand] < 0.35) continue
        if (legsClearOtherTrack(samples, cand, m)) { idx = cand; break }
      }
      if (idx < 0) continue
      const smp = samples[idx]
      const yaw = Math.atan2(smp.tangent.x, smp.tangent.z)
      // Horizontal outward axis: the legs straddle the deck in PLAN, so they
      // stay vertical under a banked deck instead of splaying with it.
      const hl = Math.hypot(smp.right.x, smp.right.z) || 1
      const ox = smp.right.x / hl, oz = smp.right.z / hl
      const legLat = smp.width * PIER_LEG_F
      // Foot goes below the graded ground so a pier never floats on a rise.
      const footY = base[idx] - 2.6

      // Cross-head, banked with the ribbon it carries and tucked up under the
      // soffit so no daylight shows between the two.
      placePart(parts, new THREE.BoxGeometry(smp.width * 1.9, 1.05, 2.4), smp, 0, -1.35, 0, STEEL)
      placePart(parts, new THREE.BoxGeometry(smp.width * 1.7, 0.30, 1.2), smp, 0, -2.05, 0, DARK)

      let braceY = 0
      for (const side of [-1, 1]) {
        const lx = smp.pos.x + ox * side * legLat
        const lz = smp.pos.z + oz * side * legLat
        // THE LEG STOPS UNDER THE CROSS-HEAD AT ITS OWN LATERAL, NOT UNDER THE
        // CENTRELINE. The legs are upright while the deck they carry is banked,
        // so the underside above a leg is `right.y * legLat` off the centreline
        // height — down on the low side, up on the high one. Taking the
        // centreline and dropping a flat 1.35 m worked while legLat was under
        // 6 m; the 50% width pass took it to 9 m, which on the flyover's
        // 10-degree bank is 1.55 m of drop, and the low leg came up through its
        // own deck by 0.2 m. This is the same mistake the terrain height field
        // used to make, in the same frame, for the same reason.
        const headY = smp.pos.y + smp.right.y * side * legLat + smp.normal.y * -1.35
        const h = Math.max(2, headY - footY)
        placeUpright(parts, new THREE.BoxGeometry(1.15, h, 1.15), lx, footY + h / 2, lz, yaw, pal.c)
        placeUpright(parts, new THREE.BoxGeometry(0.30, h - 1.2, 1.55), lx + ox * side * 0.66,
          footY + h / 2, lz + oz * side * 0.66, yaw, DARK)
        placeUpright(parts, new THREE.BoxGeometry(3.0, 1.1, 3.0), lx, footY + 0.55, lz, yaw, pal.a)
        // One marker lamp per leg so the bridge reads from below at dusk.
        placeUpright(parts, new THREE.BoxGeometry(0.22, 0.34, 0.22), lx + ox * side * 0.70,
          footY + h - 1.9, lz + oz * side * 0.70, yaw, pal.accent, 0.55)
        braceY = Math.min(braceY || Infinity, footY + (headY - footY) * 0.34)
      }
      // Cross brace between the legs, a third of the way up the SHORTER leg.
      // Local +x is already the lateral axis once the yaw is applied.
      placeUpright(parts, new THREE.BoxGeometry(legLat * 2, 0.55, 0.55),
        smp.pos.x, braceY, smp.pos.z, yaw, pal.a)
    }
    n += len
  }

  if (parts.length === 0) return null
  const mesh = new THREE.Mesh(mergeAll(parts), hw.mat)
  mesh.name = 'viaduct-piers'
  return mesh
}

/* ------------------------------------------------------------------ public */

export function buildTrackVisual(track: Track, quality: RenderQuality): TrackVisual {
  const group = new THREE.Group()
  group.name = 'track'

  const samples = track.samples
  const m = samples.length
  const resolution = track.length / m
  const lat = quality.tier === 'low' ? 4 : 6

  const blend = blendSurfaces(track)
  const ramps = resolveRamps(track)
  // Shared between the wall skirt, the soffit and the piers: all three have to
  // agree about which sections are standing over open air.
  const { via: viaW, base: viaBase } = viaductWeights(track)
  const { mat, uniforms } = makeSurfaceMaterial(track)
  const hw = makeHardwareMaterial()

  const step = Math.max(8, Math.round(CHUNK_LEN / resolution))
  const chunkCount = Math.ceil(m / step)
  const meshes: THREE.Mesh[] = []
  const geometries: THREE.BufferGeometry[] = []

  for (let c = 0; c < chunkCount; c++) {
    const i0 = c * step
    const i1 = Math.min(m, (c + 1) * step)
    const b = new ChunkBuilder()

    /* ---- road ribbon --------------------------------------------------- */
    // One row of (lat + 1) verts per sample, rows i0..i1 inclusive so chunks
    // share a seam. The final chunk's last row wraps to sample 0 but keeps
    // s = track.length so the shader's arc coordinate stays monotonic.
    const rows: number[][] = []
    for (let r = i0; r <= i1; r++) {
      const idx = r % m
      const smp = samples[idx]
      const bl = blend[idx]
      const s = (r / m) * track.length
      const row: number[] = []
      for (let j = 0; j <= lat; j++) {
        const t = (j / lat) * 2 - 1
        const uM = t * smp.width
        // Exactly Track.surfacePoint(s, uM).
        const px = smp.pos.x + smp.right.x * uM
        const py = smp.pos.y + smp.right.y * uM
        const pz = smp.pos.z + smp.right.z * uM
        const wear = 0.88 + 0.24 * hash2(idx, j)
        row.push(b.vert(
          px, py, pz,
          smp.normal.x, smp.normal.y, smp.normal.z,
          bl.r * wear, bl.g * wear, bl.b * wear,
          s, uM, t, KIND_ROAD,
          bl.metal, bl.oil, bl.slick, bl.boost,
        ))
      }
      rows.push(row)
    }
    // Winding: `normal = right x tangent`, so a quad wound
    // (s0,u0) -> (s0,u1) -> (s1,u1) -> (s1,u0) has its geometric normal along
    // +normal. Reverse this and the whole road is backface-culled.
    for (let r = 0; r < rows.length - 1; r++) {
      const a = rows[r], d = rows[r + 1]
      for (let j = 0; j < lat; j++) b.quad(a[j], a[j + 1], d[j + 1], d[j])
    }

    /* ---- walls and drop-off lips --------------------------------------- */
    for (let r = i0; r < i1; r++) {
      const ia = r % m, ib = (r + 1) % m
      const sa = samples[ia], sb = samples[ib]
      const open = sa.open || sb.open
      const bounce = sa.bounce || sb.bounce
      const arcA = (r / m) * track.length
      const arcB = ((r + 1) / m) * track.length

      // A FRAGILE SHELF CARRIES BOTH EDGES.
      //
      // The sim treats a cracked fragile sample as `open` — a car really can
      // go over that edge — so the section has to own a barrier AND a drop-off
      // lip, and the vertex shader sinks whichever one is not currently true.
      // Building only the barrier and hiding it would leave a cracked shelf
      // with a hard invisible boundary at the road edge and nothing to read;
      // building only the lip would put a hole in the world for two laps.
      //
      // It costs about 8% more wall vertices across the whole track, because
      // the shelf is 363 m of 2,892, and it costs no draw call at all: both go
      // into the chunk geometry they were always going into.
      const fragile = sa.fragile || sb.fragile
      for (const side of [-1, 1]) {
        if (open) {
          emitLip(b, sa, sb, arcA, arcB, side, ia)
        } else {
          emitWall(b, sa, sb, arcA, arcB, side,
            fragile ? KIND_FWALL : bounce ? KIND_BOUNCE : KIND_WALL, ia,
            viaW[ia], viaW[ib])
          if (fragile) emitLip(b, sa, sb, arcA, arcB, side, ia, KIND_FLIP)
        }
      }

      /* ---- booster ramp deck ------------------------------------------ */
      // Ramp decks and landing plates go into the SAME chunk geometry as the
      // road they sit on. They cost no extra draw call, they frustum-cull with
      // their chunk, and a deck that straddles a chunk seam simply splits at
      // the seam like the ribbon does.
      const deckId = ramps.deckOf[ia]
      if (deckId >= 0) {
        if (ramps.deckOf[ib] === deckId) emitRampDeck(b, sa, sb, arcA, arcB, lat, ramps, ia, ib)
        else emitRampLipFace(b, sa, arcA, lat, ramps, ia)
      }
      const landId = ramps.landOf[ia]
      if (landId >= 0 && ramps.landOf[ib] === landId) {
        emitLandingPlate(b, sa, sb, arcA, arcB, lat, ramps, ia, ib, resolution)
      }
    }

    if (b.empty) continue
    const geo = b.build()
    geometries.push(geo)
    const mesh = new THREE.Mesh(geo, mat)
    mesh.name = `track-chunk-${c}`
    mesh.frustumCulled = true
    mesh.receiveShadow = quality.shadows
    mesh.castShadow = false
    mesh.matrixAutoUpdate = false
    mesh.updateMatrix()
    group.add(mesh)
    meshes.push(mesh)
  }

  const gate = buildStartGate(track, hw)
  gate.castShadow = quality.shadows
  gate.receiveShadow = quality.shadows
  gate.matrixAutoUpdate = false
  gate.updateMatrix()
  group.add(gate)

  // One mesh, one draw call, every ramp on the track. Merging costs the
  // frustum cull (the bounds span the lap), but the whole thing is a few
  // thousand triangles of dark steel, and four separate meshes would put four
  // draw calls on the mobile budget for hardware that is usually off screen.
  const rampHw = buildRampStructure(track, ramps, quality, hw)
  if (rampHw) {
    rampHw.castShadow = quality.shadows
    rampHw.receiveShadow = quality.shadows
    rampHw.matrixAutoUpdate = false
    rampHw.updateMatrix()
    group.add(rampHw)
  }

  // One draw call for every pier on the track, at every tier: a flyover with
  // nothing holding it up is a worse artefact on a phone than on a desktop,
  // not a better one.
  const piers = buildViaductPiers(track, hw, viaW, viaBase)
  if (piers) {
    piers.castShadow = quality.shadows
    piers.receiveShadow = quality.shadows
    piers.matrixAutoUpdate = false
    piers.updateMatrix()
    group.add(piers)
  }

  return {
    group,
    update(_dt: number, time: number): void {
      uniforms.uTime.value = time
      // Pulses the lamp blocks only. The structure never lights up.
      hw.pulse.value = 0.72 + 0.34 * Math.sin(time * 2.4)

      // The ice shelf. `crackProgress` is the sim's one-way latch, ramped;
      // the second channel is a flash envelope that is up only while the
      // fracture is running, so what survives the moment is the damage and
      // not a permanently glowing road.
      const c = crackProgress()
      const flash = Math.min(1, c * 20) * (1 - smooth01((c - 0.80) / 0.20))
      uniforms.uCrack.value.set(c, flash)
    },
    dispose(): void {
      for (const g of geometries) g.dispose()
      gate.geometry.dispose()
      if (rampHw) rampHw.geometry.dispose()
      if (piers) piers.geometry.dispose()
      hw.mat.dispose()
      mat.dispose()
      group.clear()
      group.removeFromParent()
    },
  }
}

/* ---------------------------------------------------------------- builders */

/**
 * One wall segment: inner face leaning inward, a flat cap, and a short outer
 * skirt so the wall still reads as solid when seen from off-track.
 */
/**
 * How far below the road edge the barrier's outer skirt reaches.
 *
 * On the ground it has to clear the graded verge, which is tucked under the
 * road in proportion to the cross-slope — hence the bank term. On a viaduct
 * there is no verge, so it lerps to a structural plate depth. The soffit reads
 * the SAME function, which is what keeps the deck a closed box: if these two
 * ever disagree you get a slot down each side of the bridge.
 */
function wallFoot(smp: Track['samples'][number], via: number): number {
  const onGround = WALL_FOOT + Math.abs(smp.right.y) * WALL_FOOT_BANK
  return onGround + (VIA_FOOT - onGround) * via
}

function emitWall(
  b: ChunkBuilder,
  sa: Track['samples'][number], sb: Track['samples'][number],
  arcA: number, arcB: number,
  side: number, kind: number, seed: number,
  viaA: number, viaB: number,
): void {
  // Base / top / cap / skirt for both ends of the segment.
  const pts: number[][] = []
  for (const [smp, via] of [[sa, viaA], [sb, viaB]] as const) {
    const ex = smp.pos.x + smp.right.x * side * smp.width
    const ey = smp.pos.y + smp.right.y * side * smp.width
    const ez = smp.pos.z + smp.right.z * side * smp.width
    const rx = smp.right.x * side, ry = smp.right.y * side, rz = smp.right.z * side
    const nx = smp.normal.x, ny = smp.normal.y, nz = smp.normal.z
    // The outer skirt runs from the cap all the way down past the graded
    // verge, so the barrier is solid from both sides at every bank angle.
    const foot = wallFoot(smp, via)
    pts.push([
      ex, ey, ez,                                                                       // base
      ex - rx * WALL_LEAN + nx * WALL_H, ey - ry * WALL_LEAN + ny * WALL_H, ez - rz * WALL_LEAN + nz * WALL_H, // top inner
      ex + rx * WALL_CAP + nx * WALL_H, ey + ry * WALL_CAP + ny * WALL_H, ez + rz * WALL_CAP + nz * WALL_H,    // cap outer
      ex + rx * (WALL_CAP + 0.12) - nx * foot,                                          // skirt bottom
      ey + ry * (WALL_CAP + 0.12) - ny * foot,
      ez + rz * (WALL_CAP + 0.12) - nz * foot,
    ])
  }

  // Lifted off near-black: the barrier now carries most of its detail as
  // procedural value contrast in the fragment shader, and that needs a mid
  // albedo to modulate. Per-segment tint keeps long walls from reading as one
  // extruded object.
  const tint = 0.80 + 0.34 * hash2(seed, side + 7)
  const rust = hash2(seed >> 3, side + 19)
  const r = 0.185 * tint * (0.90 + 0.26 * rust)
  const g = 0.158 * tint * (0.96 + 0.06 * rust)
  const bl = 0.140 * tint * (1.04 - 0.14 * rust)

  // Faces: [pointIndexLow, pointIndexHigh, heightLow, heightHigh, normalSign]
  const faces: [number, number, number, number, number][] = [
    [0, 1, 0.0, 1.0, -1],   // inner face, normal points toward the track
    [1, 2, 1.0, 1.0, 0],    // cap, normal points up
    // Outer skirt, normal points away. Its foot now runs well below the road
    // edge, and the height coordinate is stretched over it so that the whole
    // BURIED part sits under the kerb band's 0.24 threshold: the outside of
    // the barrier reads as corrugated steel down to the ground, and the loud
    // chevron kerb stays on the inner face where the driver needs it. Without
    // the stretch a 4.5 m skirt paints half the outside of every wall on the
    // circuit in hazard stripes, which from across the infield turns the
    // flyover into one solid yellow band.
    [2, 3, 1.0, 0.30, 1],
  ]

  for (const [lo, hi, hLo, hHi, ns] of faces) {
    // Flat normal from the quad edges.
    const ax = pts[0][lo * 3], ay = pts[0][lo * 3 + 1], az = pts[0][lo * 3 + 2]
    const bx = pts[0][hi * 3], by = pts[0][hi * 3 + 1], bz = pts[0][hi * 3 + 2]
    const cx = pts[1][lo * 3], cy = pts[1][lo * 3 + 1], cz = pts[1][lo * 3 + 2]
    let ux = bx - ax, uy = by - ay, uz = bz - az
    let vx = cx - ax, vy = cy - ay, vz = cz - az
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const nl = Math.hypot(nx, ny, nz) || 1
    nx /= nl; ny /= nl; nz /= nl
    // Orient: inner faces toward -side*right, outer away, cap up-ish.
    const refx = ns === 0 ? sa.normal.x : sa.right.x * side * ns
    const refy = ns === 0 ? sa.normal.y : sa.right.y * side * ns
    const refz = ns === 0 ? sa.normal.z : sa.right.z * side * ns
    if (nx * refx + ny * refy + nz * refz < 0) { nx = -nx; ny = -ny; nz = -nz }

    const v0 = b.vert(ax, ay, az, nx, ny, nz, r, g, bl, arcA, side * sa.width, hLo, kind, 0, 0, 0, 0)
    const v1 = b.vert(bx, by, bz, nx, ny, nz, r, g, bl, arcA, side * sa.width, hHi, kind, 0, 0, 0, 0)
    const v2 = b.vert(
      pts[1][hi * 3], pts[1][hi * 3 + 1], pts[1][hi * 3 + 2],
      nx, ny, nz, r, g, bl, arcB, side * sb.width, hHi, kind, 0, 0, 0, 0,
    )
    const v3 = b.vert(cx, cy, cz, nx, ny, nz, r, g, bl, arcB, side * sb.width, hLo, kind, 0, 0, 0, 0)
    // Wind so the computed normal is the front face.
    if (side > 0) b.quad(v0, v1, v2, v3)
    else b.quad(v0, v3, v2, v1)
  }
}

/**
 * Open sections get no wall. Instead the edge grows a flange and a short fall,
 * hazard-striped, so "there is nothing holding you here" reads before you
 * arrive rather than after.
 */
function emitLip(
  b: ChunkBuilder,
  sa: Track['samples'][number], sb: Track['samples'][number],
  arcA: number, arcB: number,
  side: number, seed: number, kind: number = KIND_LIP,
): void {
  const pts: number[][] = []
  for (const smp of [sa, sb]) {
    const ex = smp.pos.x + smp.right.x * side * smp.width
    const ey = smp.pos.y + smp.right.y * side * smp.width
    const ez = smp.pos.z + smp.right.z * side * smp.width
    const rx = smp.right.x * side, ry = smp.right.y * side, rz = smp.right.z * side
    const nx = smp.normal.x, ny = smp.normal.y, nz = smp.normal.z
    pts.push([
      ex, ey, ez,
      ex + rx * LIP_OUT - nx * 0.30, ey + ry * LIP_OUT - ny * 0.30, ez + rz * LIP_OUT - nz * 0.30,
      ex + rx * (LIP_OUT + 0.35) - nx * LIP_DROP,
      ey + ry * (LIP_OUT + 0.35) - ny * LIP_DROP,
      ez + rz * (LIP_OUT + 0.35) - nz * LIP_DROP,
    ])
  }

  const tint = 0.85 + 0.25 * hash2(seed, side + 31)
  const r = 0.09 * tint, g = 0.075 * tint, bl = 0.065 * tint
  const faces: [number, number, number, number][] = [[0, 1, 0.0, 0.30], [1, 2, 0.30, 1.0]]

  for (const [lo, hi, hLo, hHi] of faces) {
    const ax = pts[0][lo * 3], ay = pts[0][lo * 3 + 1], az = pts[0][lo * 3 + 2]
    const bx = pts[0][hi * 3], by = pts[0][hi * 3 + 1], bz = pts[0][hi * 3 + 2]
    const cx = pts[1][lo * 3], cy = pts[1][lo * 3 + 1], cz = pts[1][lo * 3 + 2]
    const ux = bx - ax, uy = by - ay, uz = bz - az
    const vx = cx - ax, vy = cy - ay, vz = cz - az
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const nl = Math.hypot(nx, ny, nz) || 1
    nx /= nl; ny /= nl; nz /= nl
    if (nx * sa.normal.x + ny * sa.normal.y + nz * sa.normal.z < 0) { nx = -nx; ny = -ny; nz = -nz }

    const v0 = b.vert(ax, ay, az, nx, ny, nz, r, g, bl, arcA, side * sa.width, hLo, kind, 0, 0, 0, 0)
    const v1 = b.vert(bx, by, bz, nx, ny, nz, r, g, bl, arcA, side * sa.width, hHi, kind, 0, 0, 0, 0)
    const v2 = b.vert(
      pts[1][hi * 3], pts[1][hi * 3 + 1], pts[1][hi * 3 + 2],
      nx, ny, nz, r, g, bl, arcB, side * sb.width, hHi, kind, 0, 0, 0, 0,
    )
    const v3 = b.vert(cx, cy, cz, nx, ny, nz, r, g, bl, arcB, side * sb.width, hLo, kind, 0, 0, 0, 0)
    if (side > 0) b.quad(v0, v1, v2, v3)
    else b.quad(v0, v3, v2, v1)
  }
}
