/**
 * SpaceGen Racing — VFX.
 *
 * Design rules this file obeys:
 *  - ONE pooled particle system. A single draw call renders every spark, puff,
 *    ring, shockwave, shell and light-beam in the game. The pool is a fixed set
 *    of instanced quads; nothing is ever allocated at runtime.
 *  - Particles are fully shader-driven from a spawn-time seed. The CPU writes
 *    17 floats once, on spawn, and then never touches that particle again. Per
 *    frame the CPU only bumps a `uTime` uniform.
 *  - Zero allocation in update(). All scratch is module scope, all per-racer
 *    state is pre-allocated, no array/object literals, no map/filter/forEach.
 *
 * Everything else (trail ribbons, gravity wells, EMP spheres, item-box
 * holograms, charge shards, boost distortion shells) is a fixed pool of meshes
 * built once in the constructor, or lazily once on the first frame where the
 * track-dependent counts become known.
 */
import * as THREE from 'three'
import type { RenderQuality, VfxSystem } from './api'
import type { ItemId, RaceState, RacerState } from '../sim/types'
import type { Vec3 } from '../sim/math'
import { TUNING } from '../content/tuning'
import { ITEMS, ITEM_PARAMS } from '../content/items'
import { CHASSIS_BY_ID, getLocomotion } from '../content/chassis'
import { surfaceSprayAt, type SurfaceSpray } from './themes'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Particle kinds. Must match the branch order in the shaders below. */
const K_SPRITE = 0 // soft round glow with a hot core
const K_SPARK = 1 // velocity-stretched streak
const K_RING = 2 // camera-facing expanding annulus
const K_GROUND = 3 // ground-aligned expanding annulus
const K_SHELL = 4 // bright annulus with a punched-out dark core
const K_SMOKE = 5 // soft low-contrast puff
const K_BEAM = 6 // world-Y aligned light column

const MAX_RACERS = 12
/**
 * Ribbons per racer: the chassis trail plus the TWO drift arc lines.
 *
 * All three live in one geometry and one draw call. The drift pair is anchored
 * at the rear corners of the silhouette and records WORLD positions, so what
 * they paint is the path the car actually carved: a hard slide leaves two
 * curves through the corner and a shallow one leaves two nearly-straight
 * lines, without anything having to be told which it was.
 */
const RIB_PER_RACER = 3
const RIB_MAIN = 0
const RIB_LEFT = 1
const RIB_RIGHT = 2
const DEFER_MAX = 32
const MAX_WELLS = 4
const MAX_EMP = 3
const MAX_DISTORT = 3

/** Deferred burst kinds. */
const D_VOID_BURST = 0
const D_ALPHA_RING = 1
const D_EMP_PULSE = 2
/** Second shock front of a drift tier-up, ~90ms behind the first. */
const D_DRIFT_SHOCK = 3
/** The stored drift charge leaving the thrusters after the collapse. */
const D_DRIFT_BLOW = 4
/** The ramp's column of light, one frame behind the ground shock. */
const D_RAMP_KICK = 5

const TAU = Math.PI * 2

/** Base pool per tier, then scaled by quality.particleScale and clamped. */
const POOL_BASE: Record<string, number> = { low: 800, medium: 1800, high: 4000 }

// ---------------------------------------------------------------------------
// Colour helpers. Hex literals in content/ are authored in sRGB; the render
// path works in linear, so everything is converted once at module load.
// ---------------------------------------------------------------------------

const _hexColor = new THREE.Color()

function writeHex(out: Float32Array, off: number, hex: number, gain: number): void {
  _hexColor.setHex(hex, THREE.SRGBColorSpace)
  out[off] = _hexColor.r * gain
  out[off + 1] = _hexColor.g * gain
  out[off + 2] = _hexColor.b * gain
}

function makeRgb(hex: number, gain: number): Float32Array {
  const a = new Float32Array(3)
  writeHex(a, 0, hex, gain)
  return a
}

/**
 * Drift tier colours. Values above 1.0 are deliberate — they are the HDR
 * headroom the bloom threshold keys off, which is what makes a tier-3 spark
 * read as white-hot instead of merely white.
 *
 * Two ladders run in parallel here, because a player has to learn this from
 * peripheral vision while looking at the corner:
 *   HUE:       ice cyan -> magenta -> gold -> white (maximum hue separation;
 *              a pure blue reads as "dark" and a violet as "nearly magenta")
 *   LUMINANCE: 1.13 -> 1.31 -> 1.90 -> 3.18  (a 2.8x climb, before the
 *              per-tier spawn gain adds another 1.9x on top)
 * The old palette put tiers 0-2 UNDER the bloom threshold entirely, so the
 * first three quarters of the charge were invisible in a real frame and only
 * the tier-3 white read at all.
 */
const DRIFT_RGB = new Float32Array([
  0.30, 1.30, 2.40, // 0 ice cyan
  2.45, 0.50, 2.55, // 1 magenta
  3.15, 1.60, 0.28, // 2 gold
  3.35, 3.15, 2.90, // 3 white-hot
])
/** Per-tier spark size. The scale step is half the tier read: 2.4x from the
 *  first tier to the last, which is legible without looking straight at it. */
const DRIFT_SIZE = new Float32Array([0.130, 0.185, 0.245, 0.315])

/**
 * Sustained-body gain, per tier. Derived from DRIFT_RGB, not authored.
 *
 * THE RULE THIS ENFORCES: the drift effect must never obscure the vehicle or
 * the road ahead. Escalation is carried by hue, by spark-fan geometry, by the
 * thruster rhythm and by the transitions — never by raw luminance stacked in
 * front of the camera.
 *
 * DRIFT_RGB deliberately climbs 1.17 -> 3.17 in luminance so a tier-3 SPARK
 * reads as white-hot, and sparks are thin enough to earn it. Applied to the
 * sustained BODY channels — wheel glow, core, underglow, heartbeat, gather
 * ring — that same 2.7x multiplied against a doubling particle count and a
 * tripling quad area, for a 17x climb in filled screen energy between tier 0
 * and tier 3. That is what put two white suns over the rear of the car for as
 * long as the slide lasted. Every channel that fills pixels now divides its
 * tier's luminance back out, so the sustained body stays roughly flat and only
 * count and hue move with the ladder.
 */
const DRIFT_BODY_GAIN = new Float32Array(4)
{
  const lum = (i: number): number =>
    0.2126 * DRIFT_RGB[i * 3] + 0.7152 * DRIFT_RGB[i * 3 + 1] + 0.0722 * DRIFT_RGB[i * 3 + 2]
  const base = lum(0)
  for (let i = 0; i < 4; i++) DRIFT_BODY_GAIN[i] = base / lum(i)
}

/**
 * Largest quad size a bounded shockwave may reach. The ring shader draws its
 * annulus at 0.38 of the quad, so 9.5 is a ~3.6m radius: one car length, which
 * reads as a shockwave AT the vehicle. Growth is per second, so a tier-3 ring
 * at growth 45 over a 0.48s life used to reach quad size 22 — an 8.4m radius,
 * which from the chase camera is a band of light across the whole sky that
 * hides the corner the player is turning into.
 */
const SHOCK_MAX = 9.5
/** Ground-aligned fronts lie flat on the road, so they may run wider. */
const SHOCK_MAX_GROUND = 17.0
/** Pre-tier friction smoke: neutral, so "tier -1 = no colour" still reads. */
const SMOKE_RGB = new Float32Array([0.20, 0.21, 0.24])
const DUST_RGB = new Float32Array([0.26, 0.22, 0.17])
const WHITE_RGB = new Float32Array([1.4, 1.4, 1.4])

// ---------------------------------------------------------------------------
// DRIFT SIGNATURE: trails, surface spray, struck sparks.
//
// Three channels, one rule, and the rule is the reason the file reads the way
// it does. The tier ladder escalates through SHAPE, MOTION, DENSITY and HUE —
// ribbon width and length, spray cone and volume, spark length and rhythm,
// the DRIFT_RGB hues — and through none of them by getting brighter. Two
// separate bugs in this codebase were the same bug: a gain applied on top of a
// quantity that had already climbed. So the sustained channels here are
// luminance-NORMALISED by construction:
//
//   * the ribbons divide DRIFT_BODY_GAIN back out, exactly as the wheel glow
//     and the underglow do, so tier 3's white-hot ribbon carries the same
//     light as tier 0's cyan one and only its width, length, hue and pulse
//     have moved;
//   * the spray's colour is HUE ONLY. The theme's hex is normalised to a fixed
//     luminance and scaled by the theme's `gain`, so a "snow white" authored in
//     good faith cannot become the Cryostatic whiteout however dense the plume
//     gets. Density is free; luminance is not. That is the whole trick that
//     lets the plume be as big as the brief asks for.
//
// Only the two THIN channels — glints and struck sparks — are allowed real HDR
// headroom, and for the reason the spark fan already documents: a stretched
// streak a few pixels wide can carry scene-linear 2.5 and cost the frame
// nothing, where the same value in a filled quad is a hole in the image.
// ---------------------------------------------------------------------------

/**
 * Scene-linear luminance of the BULK spray, before the theme's `gain`.
 *
 * A soft puff peaks at about 44% of its colour once the K_SMOKE alpha curve
 * has had it, so 0.46 puts ONE puff at ~0.2 and a dozen overlapping ones at
 * roughly 0.9 in the very core of the plume. The bloom threshold is 0.78 on
 * high, which means the core of a big slide just clears it and its edges do
 * not — the plume gets a rim of glow where it is thickest and stays a solid
 * readable volume everywhere else.
 *
 * MEASURED, not guessed. At the first value tried (0.26) a tier-3 slide on
 * Cryostatic's blizzard straight produced a plume that was invisible in the
 * frame: the fog there sits near 0.15-0.25 scene-linear on its own, and a
 * puff adding 0.07 to it is a 25% local lift that the tone curve compresses to
 * nothing. Density could not fix that — a hundred invisible puffs are still
 * invisible — so the level had to move, and the room to move it came from the
 * glare probe: a held tier-3 drift measured 0.86% of the frame blown against
 * 3.28% for the road under a plain full boost.
 */
const SPRAY_LUM = 0.40
/** Crystals and chips catching the key. Thin, so they may clear the threshold. */
const GLINT_LUM = 1.30
/** Struck sparks. The hottest thing the surface channels produce. */
const SCRAPE_LUM = 2.30
/** Displaced air off a hover skirt or a flight frame: pale, and barely there. */
const AIR_LUM = 0.42

/** Ribbon half-width at the head, per tier, metres. A 2.4x climb. */
const RIB_W = new Float32Array([0.088, 0.126, 0.168, 0.212])
/** Samples of the ribbon that carry alpha, per tier, out of trailN. */
const RIB_LEN = new Float32Array([0.34, 0.54, 0.76, 1.00])

const ITEM_RGB = {} as Record<ItemId, Float32Array>
for (const key in ITEMS) {
  const id = key as ItemId
  ITEM_RGB[id] = makeRgb(ITEMS[id].color, 1.0)
}

const PROJ_RGB: Record<string, Float32Array> = {
  rail: makeRgb(0xffd23f, 1.35),
  seeker: makeRgb(0xff8b2f, 1.25),
  alpha: makeRgb(0xff2f5e, 1.45),
}

const WELL_RGB = makeRgb(0x8f6bff, 1.0)
const MINE_RGB = makeRgb(0xb44dff, 1.0)
const EMP_RGB = makeRgb(0x5ad2ff, 1.0)
const CHARGE_RGB = makeRgb(0xffe066, 1.0)
const BOX_A_RGB = makeRgb(0x5ad2ff, 1.0)
const BOX_B_RGB = makeRgb(0xff5ad2, 1.0)
const PAD_RGB = makeRgb(0x9ce8ff, 1.2)
const NITRO_RGB = makeRgb(0x2fe36b, 1.2)
const SLIP_RGB = makeRgb(0xbfeaff, 0.7)

/**
 * Pulse Gatling. The item colour at gain 1.0 sits UNDER the bloom threshold,
 * and a hitscan tracer that does not bloom is a grey pencil line at 130m. Two
 * ladders again: BEAM_RGB is the round, BEAM_HOT is what the victim's overload
 * shell climbs toward as beamCharge approaches breakAt, so "about to break"
 * reads as a colour shift from green to white long before the hit lands.
 */
const BEAM_RGB = makeRgb(0x35ff9e, 2.10)
const BEAM_HOT = makeRgb(0xdaffef, 3.05)
/** Booster ramp: same family as the boost pads that feed it. */
const RAMP_RGB = makeRgb(0x9ce8ff, 1.55)

// ---------------------------------------------------------------------------
// Module-scope scratch. Nothing below allocates during update().
// ---------------------------------------------------------------------------

const _c = new THREE.Color()
const _rgb = new Float32Array(3)
const _rgb2 = new Float32Array(3)
/** Owned by the drift / weapon / ramp helpers only, so they can hold a colour
 *  across a call that clobbers _rgb or _rgb2. */
const _dcol = new Float32Array(3)
const _dcol2 = new Float32Array(3)
/** The surface palette for the racer being drawn, resolved once per frame. */
const _spBulk = new Float32Array(3)
const _spGlint = new Float32Array(3)
const _spSpark = new Float32Array(3)

/**
 * Write a hex as a HUE at an exact scene-linear luminance.
 *
 * This is what makes the theme tables safe. An art file authors "snow is
 * 0xbccddb" — a 0.55 albedo — and if that arrived in the particle system as
 * written, a dense additive plume of it would be the blizzard whiteout again.
 * Normalising the luminance away and re-imposing it here means the theme
 * chooses the COLOUR and this file chooses the LIGHT, which is the only
 * division that survives someone later authoring a brighter planet.
 */
function writeHue(out: Float32Array, hex: number, lum: number): void {
  _hexColor.setHex(hex, THREE.SRGBColorSpace)
  const l = 0.2126 * _hexColor.r + 0.7152 * _hexColor.g + 0.0722 * _hexColor.b
  const k = l > 1e-4 ? lum / l : 0
  out[0] = _hexColor.r * k
  out[1] = _hexColor.g * k
  out[2] = _hexColor.b * k
}

/**
 * Displaced air: what a machine that never touches the ground throws instead
 * of grit. Pale, cold, and deliberately dimmer than any surface spray — this
 * is condensation and entrained haze, not material.
 */
const AIR_RGB = new Float32Array(3)
writeHue(AIR_RGB, 0xdfe9ff, AIR_LUM)

/**
 * Per-racer basis for the current updateRacer() call. Written once at the top
 * of updateRacer and read by every helper below it, so those helpers take a
 * handful of arguments instead of fourteen. Single-threaded, never escapes a
 * frame, allocates nothing — the same trick the particle scratch above uses.
 */
let _bPx = 0, _bPy = 0, _bPz = 0
/**
 * THE CONTACT POINT under the chassis: the racer's origin dropped by its
 * clamped altitude ALONG ITS OWN UP.
 *
 * It used to be a bare Y, because "down" was world -Y and the x/z of the
 * contact point were just the racer's own. On a wall-ride neither holds: the
 * road is beside the car, not beneath it, and a spark shed toward -Y leaves
 * the surface it is supposed to be scraping. `_bGy` keeps its name and its
 * meaning; it gains an x and a z.
 */
let _bGx = 0, _bGy = 0, _bGz = 0
/** Clamped altitude: how far the chassis origin floats over the contact point. */
let _bDrop = 0
/**
 * The racer's frame, in full. `_bUp` is world +Y and the Y components of
 * forward and right are zero on every flat track, which is what makes the
 * body-frame helpers below reduce to the plain XZ arithmetic they replace.
 */
let _bFwdX = 0, _bFwdY = 0, _bFwdZ = 0
let _bRgtX = 0, _bRgtY = 0, _bRgtZ = 0
let _bUpX = 0, _bUpY = 1, _bUpZ = 0
let _bHx = 1.1, _bHy = 0.6, _bHz = 2.3
/** quality.particleScale * lod for this racer. */
let _bQ = 1
let _bLocal = false
/** r.driftSide: +1 is a right-hand drift, and +driftSide is its INSIDE. */
let _bSide = 0
/**
 * THE AXIS EVERY PARTICLE SPAWNED FROM NOW ON IS BORN WITH.
 *
 * Written straight into the `aAxis` attribute by spawn(), and read in the
 * shader by three things that used to be hardcoded to world +Y: the gravity
 * arc, the ground-aligned annulus and the light column. Set to the racer's own
 * up for the whole of updateRacer, and reset to world +Y for everything that
 * belongs to the world rather than to a car.
 *
 * A module-level current-value rather than an argument for the same reason the
 * rest of the basis above is: it would otherwise be three more parameters on
 * every one of eighty spawn sites.
 */
let _axX = 0, _axY = 1, _axZ = 0
/** World up, for the flat branch of anything that reads a racer's own frame. */
const UP_Y = { x: 0, y: 1, z: 0 }
const setAxis = (x: number, y: number, z: number): void => { _axX = x; _axY = y; _axZ = z }

/**
 * BODY-FRAME EMITTERS. `f` metres forward, `s` metres toward the racer's right,
 * `u` metres along its up.
 *
 * `g*` is anchored on the contact point under the car (sparks, spray, scrape,
 * dust, decals -- anything that belongs to the ROAD); `p*` on the chassis
 * origin (anything that belongs to the CAR); `d*` is a pure direction, for
 * particle velocities.
 *
 * On a flat track `_bUp` is (0,1,0), the forward and right Y components are 0,
 * and the contact point shares the racer's x and z -- so `gX(a, b, 0)` is
 * literally `px + fwdX*a + rgtX*b` and `gY(0, 0, c)` is literally `gy + c`,
 * which is the arithmetic every one of these call sites used to do inline.
 */
const gX = (f: number, s: number, u: number): number => _bGx + _bFwdX * f + _bRgtX * s + _bUpX * u
const gY = (f: number, s: number, u: number): number => _bGy + _bFwdY * f + _bRgtY * s + _bUpY * u
const gZ = (f: number, s: number, u: number): number => _bGz + _bFwdZ * f + _bRgtZ * s + _bUpZ * u
const pX = (f: number, s: number, u: number): number => _bPx + _bFwdX * f + _bRgtX * s + _bUpX * u
const pY = (f: number, s: number, u: number): number => _bPy + _bFwdY * f + _bRgtY * s + _bUpY * u
const pZ = (f: number, s: number, u: number): number => _bPz + _bFwdZ * f + _bRgtZ * s + _bUpZ * u
const dX = (f: number, s: number, u: number): number => _bFwdX * f + _bRgtX * s + _bUpX * u
const dY = (f: number, s: number, u: number): number => _bFwdY * f + _bRgtY * s + _bUpY * u
const dZ = (f: number, s: number, u: number): number => _bFwdZ * f + _bRgtZ * s + _bUpZ * u

/**
 * Style for the ribbon currently being written, set by the caller of
 * writeRibbon(). Same trick as the basis above: nine numbers that would
 * otherwise be nine more parameters on a function called three times per racer
 * per frame. Colour rides in _rgb2, which updateTrail already owns.
 */
let _rbA = 0        // alpha at the head
let _rbW = 0        // half-width at the head, metres
let _rbShown = 1e9  // samples that carry any alpha at all
let _rbPulse = 0    // depth of the travelling pulse; 0 = perfectly steady
let _rbFreq = 0.45  // pulse cycles per sample along the ribbon
let _rbSpeed = 0    // pulse travel, radians per second
let _rbPhase = 0    // per-ribbon phase, so the pair can be braided

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)
const rnd = Math.random

/** Symmetric random in [-1, 1]. */
const rnd2 = (): number => Math.random() * 2 - 1

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const PARTICLE_VERT = `
uniform float uTime;
uniform vec3  uCamPos;

attribute vec3 aPos;
attribute vec3 aVel;
attribute vec3 aCol;
attribute vec4 aMisc;   // birth, life, size0, growth
attribute vec4 aMisc2;  // gravity, drag, kind, seed
/**
 * THE PARTICLE'S UP.
 *
 * World +Y for everything on a flat track, and for anything that genuinely
 * belongs to the world rather than to the road. On a gravity track it carries
 * the surface normal of the road the effect was born on, and three things read
 * it: the drag/gravity arc, the ground-aligned annulus, and the light column.
 * Every one of those used to be a literal .y in this shader, which is why a
 * ramp launch on a wall-ride threw a vertical searchlight into the sky while
 * the car went sideways.
 *
 * With aAxis = (0,1,0) every expression below reduces to EXACTLY the world-Y
 * arithmetic it replaces -- the cross products are written in the order that
 * makes that true, not merely true up to a mirror.
 */
attribute vec3 aAxis;

varying vec3  vCol;
varying float vA;
varying float vKind;
varying vec2  vQ;
varying float vSeed;

void main() {
  float birth = aMisc.x;
  float life  = aMisc.y;
  float age   = uTime - birth;
  float u     = (life > 0.0) ? age / life : 2.0;

  vKind = aMisc2.z;
  vSeed = aMisc2.w;
  vQ    = position.xy;
  vCol  = aCol;
  vA    = 0.0;

  if (u < 0.0 || u >= 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  // Analytic exponential drag plus a gravity term. No CPU integration.
  float k = aMisc2.y;
  float integ = (k > 0.001) ? (1.0 - exp(-k * age)) / k : age;
  vec3 wp = aPos + aVel * integ;
  wp += aAxis * (0.5 * aMisc2.x * age * age);

  float size = aMisc.z + aMisc.w * age;
  float kind = vKind;
  float a;

  if (kind < 0.5) {              // sprite
    a = smoothstep(0.0, 0.06, u) * pow(1.0 - u, 1.6);
    size *= 0.55 + 0.45 * smoothstep(0.0, 0.20, u);
  } else if (kind < 1.5) {       // spark
    // ^1.7 rather than ^2.2: at 2.2 the mean particle spends its life at 31%
    // brightness, which is why a stream of 50 drift sparks registered as a
    // faint haze instead of a spray.
    a = pow(1.0 - u, 1.7) * (0.74 + 0.26 * sin(vSeed * 97.0 + age * 63.0));
  } else if (kind < 3.5) {       // rings
    a = pow(1.0 - u, 1.7);
  } else if (kind < 4.5) {       // shell
    a = pow(1.0 - u, 1.3) * smoothstep(0.0, 0.05, u);
  } else if (kind < 5.5) {       // smoke
    a = sin(u * 3.14159265) * 0.8;
  } else {                       // beam
    a = sin(u * 3.14159265);
  }

  // Far fade, and a NEAR fade. The chase camera sits nine metres directly
  // behind the exhaust, so everything the vehicle throws backwards — plume,
  // drift sparks, wall sparks, dust — flies straight at the lens and, a metre
  // out, one quad covers a third of the screen. Dissolving them before they
  // arrive is what keeps the vehicle visible during a boost.
  //
  // SMOKE GETS ITS OWN, MUCH WIDER WINDOW. It is the only kind that is both
  // large (a metre across by the end of its life) and slow (drag-stalled, so
  // it hangs where it was made), which means it is the only kind the camera
  // genuinely flies THROUGH rather than past: at 60 m/s everything the wheels
  // leave on the road reaches the lens about a sixth of a second later, at
  // which age a puff is at its brightest and widest. Measured, this was a soft
  // white disc a third of the frame across passing on the outside of every
  // corner. Fading from 9.5 m instead of 4.2 m dissolves the plume as the
  // camera arrives while leaving it at full strength where it is made — the
  // spray at the wheels is 9 m out, so it loses nothing at all.
  float dcam = distance(wp, uCamPos);
  float near = (kind > 4.5 && kind < 5.5)
    ? smoothstep(2.6, 9.5, dcam)
    : smoothstep(1.1, 4.2, dcam);
  vA = a * near * (1.0 - smoothstep(230.0, 420.0, dcam));

  vec4 mv;
  if (kind > 2.5 && kind < 3.5) {
    // Surface-aligned quad: it lies in the plane perpendicular to aAxis, so a
    // shockwave on a wall spreads ACROSS the wall instead of standing on its
    // edge in world XZ. With aAxis = +Y, gt is exactly +X and gb exactly +Z,
    // which is the vec3(x, 0, z) offset this replaces.
    vec3 gt = (abs(aAxis.z) > 0.999)
      ? normalize(cross(aAxis, vec3(1.0, 0.0, 0.0)))
      : normalize(cross(aAxis, vec3(0.0, 0.0, 1.0)));
    vec3 gb = cross(gt, aAxis);
    vec3 wo = wp + gt * (position.x * size) + gb * (position.y * size);
    mv = modelViewMatrix * vec4(wo, 1.0);
  } else if (kind > 5.5) {
    // Light column along aAxis, billboarded around it. cross(aAxis, f) with
    // aAxis = +Y is exactly (f.z, 0, -f.x), the vector this replaces.
    vec3 f = uCamPos - wp;
    vec3 rw = normalize(cross(aAxis, f) + vec3(1e-5, 0.0, 0.0));
    vec3 wo = wp + rw * (position.x * size) + aAxis * (position.y * size * 9.0);
    mv = modelViewMatrix * vec4(wo, 1.0);
  } else if (kind > 0.5 && kind < 1.5) {
    // Spark: stretch along the screen-space velocity direction.
    mv = modelViewMatrix * vec4(wp, 1.0);
    vec3 vv = (modelViewMatrix * vec4(aVel * exp(-k * age), 0.0)).xyz;
    vec2 d = vv.xy;
    float dl = length(d);
    vec2 dir = (dl > 1e-4) ? d / dl : vec2(0.0, 1.0);
    vec2 pp = vec2(-dir.y, dir.x);
    float st = 1.0 + min(dl * 0.085, 6.0);
    mv.xy += dir * (position.y * size * st) + pp * (position.x * size * 0.72);
  } else {
    mv = modelViewMatrix * vec4(wp, 1.0);
    float rot = vSeed * 6.2831853 + age * (vSeed - 0.5) * 3.0;
    float cs = cos(rot), sn = sin(rot);
    vec2 q = vec2(position.x * cs - position.y * sn, position.x * sn + position.y * cs);
    mv.xy += q * size;
  }

  gl_Position = projectionMatrix * mv;
}
`

const PARTICLE_FRAG = `
varying vec3  vCol;
varying float vA;
varying float vKind;
varying vec2  vQ;
varying float vSeed;

void main() {
  vec2 q = vQ * 2.0;
  float d = length(q);
  float a;

  if (vKind < 0.5) {             // sprite: wide glow + hot core
    a = exp(-d * d * 3.0) * 0.70 + exp(-d * d * 20.0) * 0.90;
  } else if (vKind < 1.5) {      // spark: coloured body, white-hot centre
    float s = 1.0 - smoothstep(0.16, 1.0, d);
    a = s * s * 1.10 + exp(-d * d * 14.0) * 0.80;
  } else if (vKind < 3.5) {      // ring
    a = (1.0 - smoothstep(0.0, 0.20, abs(d - 0.76))) * 1.10;
    // Tight inner fill only. At 0.09 over a wide gaussian, a shockwave ring
    // grown to forty metres painted a flat wash across the entire frame.
    a += exp(-d * d * 6.0) * 0.035;
  } else if (vKind < 4.5) {      // shell: bright annulus, punched dark core
    a = 1.0 - smoothstep(0.0, 0.34, abs(d - 0.66));
    a *= 1.0 - 0.90 * exp(-d * d * 7.0);
    a += exp(-d * d * 1.4) * 0.05;
  } else if (vKind < 5.5) {      // smoke
    a = exp(-d * d * 2.0) * 0.55;
  } else {                       // beam
    float w = 1.0 - smoothstep(0.0, 1.0, abs(q.x));
    a = w * w * (1.0 - smoothstep(-0.3, 1.0, q.y)) * 0.85;
  }

  a *= vA;
  if (a < 0.004) discard;

  // Premultiplied additive: CustomBlending is ONE / ONE.
  gl_FragColor = vec4(vCol * a, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

const HOLO_VERT = `
uniform float uTime;
uniform float uSize;
uniform float uSpin;
uniform float uBob;

attribute vec3  iPos;
attribute float iPhase;
attribute float iScale;

varying vec2  vUv;
varying vec3  vN;
varying vec3  vView;
varying float vPhase;
varying float vScale;

void main() {
  vUv = uv;
  vPhase = iPhase;
  vScale = iScale;
  vN = normal;
  vView = vec3(0.0, 0.0, 1.0);

  if (iScale < 0.005) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  float t = uTime * uSpin + iPhase * 6.2831853;
  float c1 = cos(t), s1 = sin(t);
  float t2 = uTime * uSpin * 0.61 + iPhase * 3.7;
  float c2 = cos(t2), s2 = sin(t2);

  vec3 p = position * (uSize * iScale);
  vec3 n = normal;

  p = vec3(p.x * c1 + p.z * s1, p.y, -p.x * s1 + p.z * c1);
  n = vec3(n.x * c1 + n.z * s1, n.y, -n.x * s1 + n.z * c1);
  p = vec3(p.x, p.y * c2 - p.z * s2, p.y * s2 + p.z * c2);
  n = vec3(n.x, n.y * c2 - n.z * s2, n.y * s2 + n.z * c2);

  vec3 wp = iPos + p + vec3(0.0, sin(uTime * 1.7 + iPhase * 6.0) * uBob, 0.0);
  vN = n;

  vec4 mv = modelViewMatrix * vec4(wp, 1.0);
  vView = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`

const BOX_FRAG = `
uniform float uTime;
uniform vec3  uColorA;
uniform vec3  uColorB;

varying vec2  vUv;
varying vec3  vN;
varying vec3  vView;
varying float vPhase;
varying float vScale;

float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

// A "?" assembled from seven segments and a dot.
float question(vec2 p) {
  float d = sdSeg(p, vec2(-0.170, 0.150), vec2(-0.120, 0.300));
  d = min(d, sdSeg(p, vec2(-0.120, 0.300), vec2( 0.000, 0.345)));
  d = min(d, sdSeg(p, vec2( 0.000, 0.345), vec2( 0.120, 0.300)));
  d = min(d, sdSeg(p, vec2( 0.120, 0.300), vec2( 0.165, 0.170)));
  d = min(d, sdSeg(p, vec2( 0.165, 0.170), vec2( 0.075, 0.055)));
  d = min(d, sdSeg(p, vec2( 0.075, 0.055), vec2( 0.020,-0.045)));
  d = min(d, sdSeg(p, vec2( 0.020,-0.045), vec2( 0.020,-0.130)));
  d = min(d, length(p - vec2(0.020, -0.255)) - 0.028);
  return d;
}

void main() {
  vec2 p = vUv - 0.5;
  float glyph = 1.0 - smoothstep(0.0, 0.022, question(p) - 0.030);

  vec2 e = abs(vUv - 0.5) * 2.0;
  float frame = smoothstep(0.84, 0.99, max(e.x, e.y));
  float scan = 0.5 + 0.5 * sin((vUv.y + uTime * 0.55 + vPhase) * 34.0);
  float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vView))), 2.0);
  float pulse = 0.82 + 0.18 * sin(uTime * 4.0 + vPhase * 6.0);

  float a = (frame * 0.85 + glyph * 1.05 + fres * 0.30 + scan * 0.05) * vScale * pulse;
  if (a < 0.004) discard;

  vec3 col = mix(uColorA, uColorB, clamp(glyph * 0.85 + fres * 0.35, 0.0, 1.0));
  col *= 1.0 + glyph * 1.4;

  gl_FragColor = vec4(col * a, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

const SHARD_FRAG = `
uniform float uTime;
uniform vec3  uColorA;
uniform vec3  uColorB;

varying vec2  vUv;
varying vec3  vN;
varying vec3  vView;
varying float vPhase;
varying float vScale;

void main() {
  float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vView))), 1.6);
  float pulse = 0.7 + 0.3 * sin(uTime * 6.0 + vPhase * 6.2831853);
  float a = (0.35 + fres * 1.1) * vScale * pulse;
  if (a < 0.004) discard;
  vec3 col = mix(uColorA, uColorB, fres) * (1.0 + fres * 1.8);
  // vUv participates so the attribute is not stripped by the compiler.
  col *= 0.96 + 0.04 * vUv.x;
  gl_FragColor = vec4(col * a, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

const FIELD_VERT = `
uniform float uRadius;
varying vec3 vN;
varying vec3 vP;
varying vec3 vView;
void main() {
  vN = normal;
  vP = position;
  vec4 mv = modelViewMatrix * vec4(position * uRadius, 1.0);
  vView = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`

const WELL_SHELL_FRAG = `
uniform float uTime;
uniform float uOpacity;
uniform vec3  uColor;
varying vec3 vN;
varying vec3 vP;
varying vec3 vView;
void main() {
  vec3 n = normalize(vN);
  float fres = pow(1.0 - abs(dot(n, normalize(vView))), 2.2);
  float phi = atan(vP.z, vP.x);
  float th  = acos(clamp(vP.y, -1.0, 1.0));
  float sw  = sin(phi * 4.0 + th * 5.0 - uTime * 2.6);
  float bands = 0.5 + 0.5 * sin(th * 16.0 - uTime * 6.0 + sw * 1.7);
  float rings = pow(bands, 3.0);
  float a = (fres * 0.80 + rings * 0.34) * uOpacity;
  if (a < 0.004) discard;
  vec3 col = uColor * (0.55 + rings * 1.9 + fres * 1.5);
  gl_FragColor = vec4(col * a, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

const WELL_CORE_FRAG = `
uniform float uTime;
uniform float uOpacity;
uniform vec3  uColor;
varying vec3 vN;
varying vec3 vP;
varying vec3 vView;
void main() {
  vec3 n = normalize(vN);
  float fres = pow(1.0 - abs(dot(n, normalize(vView))), 3.0);
  float swirl = 0.5 + 0.5 * sin(atan(vP.z, vP.x) * 3.0 + uTime * 5.0);
  vec3 col = mix(vec3(0.006, 0.0, 0.018), uColor * 2.4, fres);
  col += uColor * swirl * fres * 0.6;
  float a = (0.72 + 0.28 * fres) * uOpacity;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

const DISTORT_FRAG = `
uniform float uTime;
uniform float uOpacity;
uniform vec3  uColor;
varying vec3 vN;
varying vec3 vP;
varying vec3 vView;
void main() {
  vec3 n = normalize(vN);
  float fres = pow(1.0 - abs(dot(n, normalize(vView))), 2.4);
  float rim = smoothstep(0.30, 1.0, fres);
  float warp = 0.5 + 0.5 * sin(vP.y * 22.0 + uTime * 14.0);
  // Dark body with a hard chromatic edge: reads as a lensed rim.
  vec3 col = mix(vec3(0.008, 0.0, 0.020), uColor, smoothstep(0.80, 1.0, fres));
  col += vec3(0.25, 0.05, 0.45) * warp * rim * 0.4;
  float a = rim * uOpacity;
  if (a < 0.003) discard;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

const TRAIL_VERT = `
attribute float aAlpha;
attribute vec3  aTrailCol;
varying vec3  vCol;
varying float vA;
void main() {
  vCol = aTrailCol;
  vA = aAlpha;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const TRAIL_FRAG = `
varying vec3  vCol;
varying float vA;
void main() {
  if (vA < 0.004) discard;
  gl_FragColor = vec4(vCol * vA, vA);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

// ---------------------------------------------------------------------------
// Per-racer persistent state. Allocated once, never re-created.
// ---------------------------------------------------------------------------

class RacerFx {
  prevTier = -2
  prevDriftSide = 0
  prevRespawn = 0
  prevBoostTime = 0
  driftAcc = 0
  pulseAcc = 0
  dustAcc = 0
  plumeAcc = 0
  hoverAcc = 0
  invAcc = 0
  spinAcc = 0
  trailAcc = 0
  trailHead = 0
  trailReady = false

  // --- drift charge-up -------------------------------------------------
  /** Inward-spiralling gathering motes. */
  gatherAcc = 0
  /** Cadence of the collapsing gather ring. */
  gatherRing = 0
  /** The core glow riding the convergence point. */
  coreAcc = 0
  /** Ground pool under the chassis. */
  underAcc = 0
  /** Continuous thruster exhaust. */
  thrustAcc = 0
  /** Periodic hard thruster pulse — the machine straining to hold the charge. */
  strainAcc = 0
  /**
   * Seconds remaining in the tier-transition wash. While this is above zero
   * EVERY drift channel (sparks, motes, underglow, core, thrusters, trail) is
   * driven toward white and overdriven in gain, then settles into the new
   * tier's hue. That settle is what makes a tier read as a transition rather
   * than as a palette swap nobody notices mid-corner.
   */
  tierFlash = 0
  /** Tier that fired the wash, so its magnitude escalates with the ladder. */
  tierFlashT = 0

  // --- drift signature: spray, sparks, arc ribbons ----------------------
  /** Bulk surface material torn off the contact patches. */
  sprayAcc = 0
  /** Ground-hugging wash disc under the sliding wheels. */
  washAcc = 0
  /** The same, for a hover skirt's downwash. Separate so the two cannot halve
   *  each other's cadence on a low-flying frame that runs both. */
  airWashAcc = 0
  /** Continuous struck sparks (grounded chassis only). */
  scrapeAcc = 0
  /** Cadence of the hard spark STRIKE — the rhythm on top of the stream. */
  scrapeBeat = 0
  /** Alternating contact patch for that strike, so it walks side to side. */
  scrapeSide = 1
  /** Vortices off a hover skirt / flight frame. */
  vortexAcc = 0
  /**
   * Ribbon envelope, 0..1. Fast attack, slow release: the arc lines have to be
   * up within a frame or two of the slide starting, and must stream away and
   * fade after it ends rather than being deleted mid-air on the release frame.
   */
  ribEnv = 0
  /** True while the pair holds geometry, so an idle racer costs nothing. */
  ribOn = false
  /** Drift state sampled in updateRacer, read by updateTrail a call later. */
  ribTier = -1
  ribCharge = 0
  ribInward = 0
  /**
   * Ring buffer of the two rear-corner world positions, newest at trailHead —
   * the same index the chassis trail uses, so all three ribbons of a racer are
   * always describing the same instant. Always written, drifting or not: a
   * ribbon that lit up on a stale history would snap a curve across the track
   * from wherever the last slide ended.
   */
  rib: Float32Array

  // --- pulse gatling ---------------------------------------------------
  /** Barrel angle, advanced one detent per shot. Drives the rotary flash. */
  gatSpin = 0
  /** Previous gatlingTime, for spin-up / spin-down one-shots. */
  prevGatling = 0
  /** Muzzle idle-glow cadence while the budget is running. */
  gatIdle = 0
  /** Victim overload emitters. */
  beamAcc = 0
  beamRing = 0
  /** Previous beamCharge, so a falling charge can read as cooling off. */
  prevBeam = 0

  // --- booster ramp ----------------------------------------------------
  /** 1 while airborne off a ramp; cleared on landing. */
  rampAir = 0
  /** 0..1 normalised launch power, held for the afterburn. */
  rampPower = 0
  rampAcc = 0
  rampBead = 0
  /** Ring buffer of world positions, newest at trailHead. */
  trail: Float32Array

  constructor(samples: number) {
    this.trail = new Float32Array(samples * 3)
    this.rib = new Float32Array(samples * 6)
  }
}

// ---------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------

class Vfx implements VfxSystem {
  readonly group = new THREE.Group()
  boostIntensity = 0
  hitFlash = 0
  /**
   * True on a track that authors up-vectors (`Track.hasGravity`). Set by the
   * scene layer; the system cannot read it off a racer, because on a flat track
   * the sim leaves `r.fwd`/`r.up` frozen at the grid.
   */
  gravity = false
  /**
   * One-shot dolly-zoom request for the chase camera, 0-1, set when the LOCAL
   * racer cashes in a drift. Consumed and cleared by the caller. It lives here
   * rather than being read off r.events by the camera because events are
   * cleared per SIM step and the camera runs per RENDER frame -- the same
   * mismatch that made every VFX one-shot fire 2-4 times on a 144Hz display.
   */
  dollyRequest = 0

  private readonly qScale: number
  private readonly lowTier: boolean
  /**
   * How much of the HDR headroom the surface channels may use.
   *
   * The `low` tier builds no composer at all: no bloom, and therefore no glare
   * budget bounding what bloom does. Values over about 1.0 buy nothing there —
   * there is no high-pass to feed, so they simply clip — while still piling up
   * additively into white. Measured on Cryostatic at low, a held tier-3 slide
   * clipped 3.9% of the frame against 0.66% for the same slide on high, and
   * the tier is most of that on its own: a plain mid-boost with no drift at all
   * measures 0.74% at low against 0.01% at high. Handing the cheapest device
   * the same headroom the expensive one has is the one place in this file where
   * "the same numbers everywhere" is the wrong answer.
   */
  private readonly hdr: number
  private readonly scene: THREE.Scene
  private time = 0
  private disposed = false

  /**
   * The OS reduced-motion preference, live.
   *
   * Held as the MediaQueryList rather than a boolean because `.matches` is a
   * property read and the preference can change while the game is running,
   * and read once per update() rather than per racer. Everything that
   * FLICKERS is gated on this — the ribbons' travelling pulse and the spark
   * strike's cadence — while density, colour and the shapes themselves are
   * not: reduced motion asks for no strobing, not for no effect.
   */
  private readonly motionQ: MediaQueryList | null =
    typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
  private reduced = false

  // --- particle pool ---------------------------------------------------
  private readonly pool: number
  private readonly frameBudget: number
  private head = 0
  private spawnStart = 0
  private spawnCount = 0
  /**
   * The sim frame whose events have already been consumed.
   *
   * A racer's `events` array is cleared at the top of Race.step() and read
   * here, so it is only safe to process ONCE per sim step. The render loop
   * does not run in lockstep with the sim: on any display faster than 60Hz the
   * fixed-timestep accumulator runs zero sim steps on some frames, and while
   * the game is paused it runs none at all. Both cases hand us the same array
   * again, and every one-shot in it — a tier-up shockwave, a boost, an impact
   * — fires a second time. On a 120Hz panel that silently doubled every burst
   * in the game.
   */
  private prevSimFrame = -1
  private readonly aPos: Float32Array
  private readonly aVel: Float32Array
  private readonly aCol: Float32Array
  private readonly aMisc: Float32Array
  private readonly aMisc2: Float32Array
  private readonly aAxis: Float32Array
  private readonly attrPos: THREE.InstancedBufferAttribute
  private readonly attrVel: THREE.InstancedBufferAttribute
  private readonly attrCol: THREE.InstancedBufferAttribute
  private readonly attrMisc: THREE.InstancedBufferAttribute
  private readonly attrMisc2: THREE.InstancedBufferAttribute
  private readonly attrAxis: THREE.InstancedBufferAttribute
  private readonly pGeo: THREE.InstancedBufferGeometry
  private readonly pMat: THREE.ShaderMaterial
  private readonly pMesh: THREE.Mesh

  // --- trails ----------------------------------------------------------
  private readonly trailN: number
  /** MAX_RACERS * RIB_PER_RACER. Ribbon slot = racer * RIB_PER_RACER + which. */
  private readonly ribbons: number
  private readonly trailGeo: THREE.BufferGeometry
  private readonly trailMat: THREE.ShaderMaterial
  private readonly trailMesh: THREE.Mesh
  private readonly trailPos: Float32Array
  private readonly trailAlpha: Float32Array
  private readonly trailCol: Float32Array
  private readonly attrTrailPos: THREE.BufferAttribute
  private readonly attrTrailAlpha: THREE.BufferAttribute
  private readonly attrTrailCol: THREE.BufferAttribute

  // --- racer state -----------------------------------------------------
  private readonly rfx: RacerFx[] = []

  // --- deferred bursts -------------------------------------------------
  private readonly defTime = new Float64Array(DEFER_MAX)
  private readonly defPos = new Float32Array(DEFER_MAX * 3)
  /** Unit direction, for deferred bursts that have to be aimed. */
  private readonly defDir = new Float32Array(DEFER_MAX * 3)
  /** The surface axis in force when the burst was queued: a deferred ground
   *  front or light column has to land on the deck the car actually left. */
  private readonly defAxis = new Float32Array(DEFER_MAX * 3)
  private readonly defCol = new Float32Array(DEFER_MAX * 3)
  private readonly defKind = new Int32Array(DEFER_MAX)
  private readonly defScale = new Float32Array(DEFER_MAX)
  private readonly defOn = new Uint8Array(DEFER_MAX)

  // --- gravity wells ---------------------------------------------------
  private readonly wellGroup: THREE.Group[] = []
  private readonly wellShellMat: THREE.ShaderMaterial[] = []
  private readonly wellCoreMat: THREE.ShaderMaterial[] = []
  private readonly wellFieldId = new Int32Array(MAX_WELLS)
  private readonly wellSpiral = new Float32Array(MAX_WELLS)
  private readonly wellGeoShell: THREE.SphereGeometry
  private readonly wellGeoCore: THREE.SphereGeometry

  // --- EMP wireframe spheres -------------------------------------------
  private readonly empMesh: THREE.LineSegments[] = []
  private readonly empMat: THREE.LineBasicMaterial[] = []
  private readonly empAge = new Float32Array(MAX_EMP)
  private readonly empLife = new Float32Array(MAX_EMP)
  private readonly empGeo: THREE.WireframeGeometry

  // --- boost distortion shells -----------------------------------------
  private readonly distMesh: THREE.Mesh[] = []
  private readonly distMat: THREE.ShaderMaterial[] = []
  private readonly distAge = new Float32Array(MAX_DISTORT)
  private readonly distLife = new Float32Array(MAX_DISTORT)
  private readonly distGeo: THREE.SphereGeometry

  // --- lights ----------------------------------------------------------
  private readonly lights: THREE.PointLight[] = []
  private readonly lightTtl: Float32Array
  private readonly lightPow: Float32Array

  // --- item boxes / charge pickups (lazy: counts come from the track) ---
  private boxReady = false
  private boxCount = 0
  private boxMesh: THREE.Mesh | null = null
  private boxGeo: THREE.InstancedBufferGeometry | null = null
  private boxMat: THREE.ShaderMaterial | null = null
  private boxScale: Float32Array | null = null
  private attrBoxScale: THREE.InstancedBufferAttribute | null = null
  private boxWasActive: Uint8Array | null = null

  private shardReady = false
  private shardCount = 0
  private shardMesh: THREE.Mesh | null = null
  private shardGeo: THREE.InstancedBufferGeometry | null = null
  private shardMat: THREE.ShaderMaterial | null = null
  private shardScale: Float32Array | null = null
  private attrShardScale: THREE.InstancedBufferAttribute | null = null
  private shardWasActive: Uint8Array | null = null

  constructor(scene: THREE.Scene, quality: RenderQuality) {
    this.scene = scene
    this.qScale = quality.particleScale
    this.lowTier = quality.tier === 'low'
    this.hdr = quality.tier === 'low' ? 0.72 : 1
    this.group.name = 'vfx'
    this.group.matrixAutoUpdate = false
    this.group.frustumCulled = false

    const base = POOL_BASE[quality.tier] ?? 1800
    this.pool = Math.max(600, Math.min(8000, Math.round(base * quality.particleScale)))
    this.frameBudget = Math.max(48, this.pool >> 2)

    // ---- particle pool ------------------------------------------------
    this.aPos = new Float32Array(this.pool * 3)
    this.aVel = new Float32Array(this.pool * 3)
    this.aCol = new Float32Array(this.pool * 3)
    this.aMisc = new Float32Array(this.pool * 4)
    this.aMisc2 = new Float32Array(this.pool * 4)
    // Seeded to world +Y, so a particle written by a path that never sets an
    // axis behaves exactly as it did before this attribute existed.
    this.aAxis = new Float32Array(this.pool * 3)
    for (let i = 0; i < this.pool; i++) this.aAxis[i * 3 + 1] = 1

    const quad = new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ])
    const geo = new THREE.InstancedBufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(quad, 3))
    geo.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1))
    geo.instanceCount = this.pool
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)

    this.attrPos = new THREE.InstancedBufferAttribute(this.aPos, 3)
    this.attrVel = new THREE.InstancedBufferAttribute(this.aVel, 3)
    this.attrCol = new THREE.InstancedBufferAttribute(this.aCol, 3)
    this.attrMisc = new THREE.InstancedBufferAttribute(this.aMisc, 4)
    this.attrMisc2 = new THREE.InstancedBufferAttribute(this.aMisc2, 4)
    this.attrAxis = new THREE.InstancedBufferAttribute(this.aAxis, 3)
    this.attrPos.setUsage(THREE.DynamicDrawUsage)
    this.attrVel.setUsage(THREE.DynamicDrawUsage)
    this.attrCol.setUsage(THREE.DynamicDrawUsage)
    this.attrMisc.setUsage(THREE.DynamicDrawUsage)
    this.attrMisc2.setUsage(THREE.DynamicDrawUsage)
    this.attrAxis.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('aPos', this.attrPos)
    geo.setAttribute('aVel', this.attrVel)
    geo.setAttribute('aCol', this.attrCol)
    geo.setAttribute('aMisc', this.attrMisc)
    geo.setAttribute('aMisc2', this.attrMisc2)
    geo.setAttribute('aAxis', this.attrAxis)
    this.pGeo = geo

    this.pMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCamPos: { value: new THREE.Vector3() },
      },
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    })

    this.pMesh = new THREE.Mesh(this.pGeo, this.pMat)
    this.pMesh.frustumCulled = false
    this.pMesh.matrixAutoUpdate = false
    this.pMesh.renderOrder = 20
    this.group.add(this.pMesh)

    // ---- trail ribbons -------------------------------------------------
    // THREE ribbons per racer now, not one, and all of them still one draw
    // call: 36 strips of (trailN - 1) segments in a single indexed geometry.
    // On high that is 3,024 triangles standing by, against a 68k frame — and
    // an inactive drift ribbon is COLLAPSED to a point rather than left in
    // place at alpha 0, so eight idle racers cost rasterisation of nothing
    // instead of thirty-six full-screen strips of discarded fragments.
    this.trailN = quality.tier === 'high' ? 22 : quality.tier === 'medium' ? 16 : 10
    this.ribbons = MAX_RACERS * RIB_PER_RACER
    const verts = this.ribbons * this.trailN * 3
    this.trailPos = new Float32Array(verts * 3)
    this.trailAlpha = new Float32Array(verts)
    this.trailCol = new Float32Array(verts * 3)
    const segs = this.trailN - 1
    const idx = new Uint16Array(this.ribbons * segs * 12)
    let w = 0
    for (let m = 0; m < this.ribbons; m++) {
      const b = m * this.trailN * 3
      for (let i = 0; i < segs; i++) {
        const a0 = b + i * 3
        const b0 = b + (i + 1) * 3
        idx[w++] = a0; idx[w++] = a0 + 1; idx[w++] = b0 + 1
        idx[w++] = a0; idx[w++] = b0 + 1; idx[w++] = b0
        idx[w++] = a0 + 1; idx[w++] = a0 + 2; idx[w++] = b0 + 2
        idx[w++] = a0 + 1; idx[w++] = b0 + 2; idx[w++] = b0 + 1
      }
    }
    this.attrTrailPos = new THREE.BufferAttribute(this.trailPos, 3)
    this.attrTrailAlpha = new THREE.BufferAttribute(this.trailAlpha, 1)
    this.attrTrailCol = new THREE.BufferAttribute(this.trailCol, 3)
    this.attrTrailPos.setUsage(THREE.DynamicDrawUsage)
    this.attrTrailAlpha.setUsage(THREE.DynamicDrawUsage)
    this.attrTrailCol.setUsage(THREE.DynamicDrawUsage)
    this.trailGeo = new THREE.BufferGeometry()
    this.trailGeo.setAttribute('position', this.attrTrailPos)
    this.trailGeo.setAttribute('aAlpha', this.attrTrailAlpha)
    this.trailGeo.setAttribute('aTrailCol', this.attrTrailCol)
    this.trailGeo.setIndex(new THREE.BufferAttribute(idx, 1))
    this.trailGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)
    this.trailMat = new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: TRAIL_VERT,
      fragmentShader: TRAIL_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    })
    this.trailMesh = new THREE.Mesh(this.trailGeo, this.trailMat)
    this.trailMesh.frustumCulled = false
    this.trailMesh.matrixAutoUpdate = false
    this.trailMesh.renderOrder = 19
    this.group.add(this.trailMesh)

    for (let i = 0; i < MAX_RACERS; i++) this.rfx.push(new RacerFx(this.trailN))

    // ---- gravity wells --------------------------------------------------
    const wellSegs = quality.tier === 'low' ? 12 : quality.tier === 'medium' ? 20 : 28
    this.wellGeoShell = new THREE.SphereGeometry(1, wellSegs, wellSegs >> 1)
    this.wellGeoCore = new THREE.SphereGeometry(1, 14, 10)
    for (let i = 0; i < MAX_WELLS; i++) {
      const shellMat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uOpacity: { value: 0 },
          uRadius: { value: 1 },
          uColor: { value: new THREE.Color(WELL_RGB[0], WELL_RGB[1], WELL_RGB[2]) },
        },
        vertexShader: FIELD_VERT,
        fragmentShader: WELL_SHELL_FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneFactor,
      })
      const coreMat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uOpacity: { value: 0 },
          uRadius: { value: 1 },
          uColor: { value: new THREE.Color(WELL_RGB[0], WELL_RGB[1], WELL_RGB[2]) },
        },
        vertexShader: FIELD_VERT,
        fragmentShader: WELL_CORE_FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.FrontSide,
      })
      const g = new THREE.Group()
      const shell = new THREE.Mesh(this.wellGeoShell, shellMat)
      const core = new THREE.Mesh(this.wellGeoCore, coreMat)
      shell.frustumCulled = false
      core.frustumCulled = false
      shell.renderOrder = 16
      core.renderOrder = 15
      g.add(core)
      g.add(shell)
      g.visible = false
      this.group.add(g)
      this.wellGroup.push(g)
      this.wellShellMat.push(shellMat)
      this.wellCoreMat.push(coreMat)
      this.wellFieldId[i] = -1
    }

    // ---- EMP wireframe spheres ------------------------------------------
    const ico = new THREE.IcosahedronGeometry(1, quality.tier === 'low' ? 1 : 2)
    this.empGeo = new THREE.WireframeGeometry(ico)
    ico.dispose()
    for (let i = 0; i < MAX_EMP; i++) {
      const m = new THREE.LineBasicMaterial({
        color: new THREE.Color(EMP_RGB[0], EMP_RGB[1], EMP_RGB[2]),
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
      const ls = new THREE.LineSegments(this.empGeo, m)
      ls.frustumCulled = false
      ls.visible = false
      ls.renderOrder = 18
      this.group.add(ls)
      this.empMesh.push(ls)
      this.empMat.push(m)
    }

    // ---- boost distortion shells ----------------------------------------
    this.distGeo = new THREE.SphereGeometry(1, 18, 12)
    for (let i = 0; i < MAX_DISTORT; i++) {
      const m = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uOpacity: { value: 0 },
          uRadius: { value: 1 },
          uColor: { value: new THREE.Color(1.0, 0.95, 1.0) },
        },
        vertexShader: FIELD_VERT,
        fragmentShader: DISTORT_FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.BackSide,
      })
      const mesh = new THREE.Mesh(this.distGeo, m)
      mesh.frustumCulled = false
      mesh.visible = false
      mesh.renderOrder = 17
      this.group.add(mesh)
      this.distMesh.push(mesh)
      this.distMat.push(m)
    }

    // ---- transient lights -------------------------------------------------
    const nLights = quality.tier === 'high' ? 3 : quality.tier === 'medium' ? 1 : 0
    this.lightTtl = new Float32Array(Math.max(1, nLights))
    this.lightPow = new Float32Array(Math.max(1, nLights))
    for (let i = 0; i < nLights; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 46, 2)
      l.castShadow = false
      this.group.add(l)
      this.lights.push(l)
    }

    scene.add(this.group)
  }

  // -------------------------------------------------------------------------
  // Particle emission. The only place the pool is written.
  // -------------------------------------------------------------------------

  private spawn(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    r: number, g: number, b: number,
    life: number, size: number, growth: number,
    gravity: number, drag: number, kind: number,
  ): void {
    if (this.spawnCount >= this.frameBudget) return
    const i = this.head
    this.head = i + 1 >= this.pool ? 0 : i + 1
    this.spawnCount++

    const i3 = i * 3
    const i4 = i * 4
    const p = this.aPos, v = this.aVel, c = this.aCol, m = this.aMisc, m2 = this.aMisc2
    p[i3] = x; p[i3 + 1] = y; p[i3 + 2] = z
    v[i3] = vx; v[i3 + 1] = vy; v[i3 + 2] = vz
    c[i3] = r; c[i3 + 1] = g; c[i3 + 2] = b
    m[i4] = this.time; m[i4 + 1] = life; m[i4 + 2] = size; m[i4 + 3] = growth
    m2[i4] = gravity; m2[i4 + 1] = drag; m2[i4 + 2] = kind; m2[i4 + 3] = rnd()
    const a = this.aAxis
    a[i3] = _axX; a[i3 + 1] = _axY; a[i3 + 2] = _axZ
  }

  /** Spherical burst helper. dirBias steers the cone; spread 1 = full sphere. */
  private burst(
    x: number, y: number, z: number,
    dx: number, dy: number, dz: number,
    count: number, speed: number, spread: number,
    col: Float32Array, gain: number,
    life: number, size: number, kind: number,
    gravity: number, drag: number,
  ): void {
    const n = Math.min(count, this.frameBudget - this.spawnCount)
    for (let i = 0; i < n; i++) {
      const rx = rnd2(), ry = rnd2(), rz = rnd2()
      const s = speed * (0.45 + rnd() * 0.75)
      const vx = (dx + rx * spread) * s
      const vy = (dy + ry * spread) * s
      const vz = (dz + rz * spread) * s
      this.spawn(
        x + rx * 0.25, y + ry * 0.25, z + rz * 0.25,
        vx, vy, vz,
        col[0] * gain, col[1] * gain, col[2] * gain,
        life * (0.7 + rnd() * 0.6), size * (0.7 + rnd() * 0.7), 0,
        gravity, drag, kind,
      )
    }
  }

  private ring(
    x: number, y: number, z: number,
    col: Float32Array, gain: number,
    life: number, size: number, growth: number, ground: boolean,
  ): void {
    this.spawn(
      x, y, z, 0, 0, 0,
      col[0] * gain, col[1] * gain, col[2] * gain,
      life, size, growth, 0, 0, ground ? K_GROUND : K_RING,
    )
  }

  /**
   * A shockwave front specified by where it ENDS rather than by how fast it
   * grows, with the final radius clamped. Growth is per second and lives were
   * being tuned independently, so `growth * life` silently produced rings far
   * larger than anything anyone chose; stating the destination makes that
   * impossible and gives one place to enforce the bound.
   */
  private shockRing(
    x: number, y: number, z: number,
    col: Float32Array, gain: number, life: number,
    size0: number, finalSize: number, ground: boolean,
  ): void {
    const cap = ground ? SHOCK_MAX_GROUND : SHOCK_MAX
    const end = finalSize > cap ? cap : finalSize
    const growth = end > size0 ? (end - size0) / Math.max(0.01, life) : 0
    this.spawn(
      x, y, z, 0, 0, 0,
      col[0] * gain, col[1] * gain, col[2] * gain,
      life, size0, growth, 0, 0, ground ? K_GROUND : K_RING,
    )
  }

  /** As shockRing, but the shell kind: a bright annulus with a punched-out
   *  dark core, so the vehicle silhouettes THROUGH it instead of behind it. */
  private shockShell(
    x: number, y: number, z: number,
    col: Float32Array, gain: number, life: number,
    size0: number, finalSize: number,
  ): void {
    const end = finalSize > SHOCK_MAX ? SHOCK_MAX : finalSize
    const growth = end > size0 ? (end - size0) / Math.max(0.01, life) : 0
    this.spawn(
      x, y, z, 0, 0, 0,
      col[0] * gain, col[1] * gain, col[2] * gain,
      life, size0, growth, 0, 0, K_SHELL,
    )
  }

  private flash(
    x: number, y: number, z: number,
    col: Float32Array, gain: number, life: number, size: number,
  ): void {
    this.spawn(
      x, y, z, 0, 0, 0,
      col[0] * gain, col[1] * gain, col[2] * gain,
      life, size, -size * 0.35, 0, 0, K_SPRITE,
    )
  }

  private claimLight(x: number, y: number, z: number, col: Float32Array, power: number, ttl: number): void {
    const n = this.lights.length
    if (n === 0) return
    let best = 0
    let bestScore = Infinity
    for (let i = 0; i < n; i++) {
      const score = this.lightTtl[i] * this.lightPow[i]
      if (score < bestScore) { bestScore = score; best = i }
    }
    if (this.lightTtl[best] > 0 && this.lightPow[best] > power * 1.4) return
    const l = this.lights[best]
    l.position.set(x, y, z)
    l.color.setRGB(
      Math.min(1, col[0]), Math.min(1, col[1]), Math.min(1, col[2]),
      THREE.LinearSRGBColorSpace,
    )
    this.lightTtl[best] = ttl
    this.lightPow[best] = power
  }

  private defer(
    delay: number, x: number, y: number, z: number,
    col: Float32Array, kind: number, scale: number,
    dx = 0, dy = 0, dz = 0,
  ): void {
    for (let i = 0; i < DEFER_MAX; i++) {
      if (this.defOn[i]) continue
      this.defOn[i] = 1
      this.defTime[i] = this.time + delay
      const i3 = i * 3
      this.defPos[i3] = x; this.defPos[i3 + 1] = y; this.defPos[i3 + 2] = z
      this.defDir[i3] = dx; this.defDir[i3 + 1] = dy; this.defDir[i3 + 2] = dz
      this.defAxis[i3] = _axX; this.defAxis[i3 + 1] = _axY; this.defAxis[i3 + 2] = _axZ
      this.defCol[i3] = col[0]; this.defCol[i3 + 1] = col[1]; this.defCol[i3 + 2] = col[2]
      this.defKind[i] = kind
      this.defScale[i] = scale
      return
    }
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(dt: number, state: RaceState, cameraPos: Vec3, localId: number): void {
    if (this.disposed) return
    if (dt > 0.1) dt = 0.1
    this.time += dt

    this.spawnStart = this.head
    this.spawnCount = 0
    this.reduced = this.motionQ !== null && this.motionQ.matches

    // Screen-space intensities decay exponentially.
    this.boostIntensity *= Math.pow(0.02, dt)
    this.hitFlash *= Math.pow(0.004, dt)

    const cx = cameraPos.x, cy = cameraPos.y, cz = cameraPos.z
    this.pMat.uniforms.uTime.value = this.time
    const camUni = this.pMat.uniforms.uCamPos.value as THREE.Vector3
    camUni.set(cx, cy, cz)

    // Only consume each sim step's events once; see prevSimFrame. Continuous
    // emitters keep running either way, so a paused or high-refresh frame
    // still animates — it just does not re-fire one-shots.
    const stepped = state.frame !== this.prevSimFrame
    this.prevSimFrame = state.frame

    const racers = state.racers
    const n = Math.min(racers.length, MAX_RACERS)

    // Resolve the local racer by id, falling back to index.
    let local: RacerState | null = null
    for (let i = 0; i < n; i++) {
      if (racers[i].id === localId) { local = racers[i]; break }
    }
    if (local === null && localId >= 0 && localId < n) local = racers[localId]

    for (let i = 0; i < n; i++) {
      const r = racers[i]
      const fx = this.rfx[i]
      const dx = r.pos.x - cx, dy = r.pos.y - cy, dz = r.pos.z - cz
      const d2 = dx * dx + dy * dy + dz * dz
      const isLocal = r === local
      let lod = isLocal ? 1 : d2 < 900 ? 1 : d2 < 6400 ? 0.6 : d2 < 40000 ? 0.28 : 0
      if (r.finished && !isLocal) lod *= 0.5
      this.updateRacer(dt, state, r, fx, lod, isLocal, stepped)
      this.updateTrail(dt, r, fx, i, lod, cx, cy, cz)
    }
    // Ribbons for unused racer slots stay collapsed. All three of them: the
    // chassis trail and both arc lines.
    for (let i = n * RIB_PER_RACER; i < this.ribbons; i++) this.clearRibbon(i)

    // Everything past the racer loop belongs to the WORLD, not to a car, so it
    // is born world-up again. Missiles, wells and item boxes carry their own
    // orientation in their meshes; their particles are ambient.
    setAxis(0, 1, 0)
    this.updateProjectiles(dt, state, cx, cy, cz)
    this.updateFields(dt, state)
    this.updateEntities(dt, state)
    this.updateDeferred()
    setAxis(0, 1, 0)
    this.updateShells(dt)
    this.updateLights(dt)
    this.flush()
  }

  // -------------------------------------------------------------------------
  // Racer: events + continuous state
  // -------------------------------------------------------------------------

  private updateRacer(
    dt: number, state: RaceState, r: RacerState, fx: RacerFx,
    lod: number, isLocal: boolean, stepped: boolean,
  ): void {
    const chassis = CHASSIS_BY_ID[r.chassisId]
    const hx = chassis ? chassis.halfExtents.x : 1.1
    const hz = chassis ? chassis.halfExtents.z : 2.3
    const hy = chassis ? chassis.halfExtents.y : 0.6
    const loco = chassis ? chassis.locomotion : 'grounded'

    // The racer's frame. Flat, it is a compass yaw and world +Y, exactly as it
    // was. On a gravity track it is the sim's own (fwd, up) -- a car on a wall
    // has an attitude no bearing can express, and every effect below is placed
    // relative to it.
    let fwdX = Math.sin(r.yaw), fwdY = 0, fwdZ = Math.cos(r.yaw)
    // right = forward x up, matching Track, the sim and the chase camera.
    let rgtX = -Math.cos(r.yaw), rgtY = 0, rgtZ = Math.sin(r.yaw)
    let upX = 0, upY = 1, upZ = 0
    if (this.gravity) {
      upX = r.up.x; upY = r.up.y; upZ = r.up.z
      fwdX = r.fwd.x; fwdY = r.fwd.y; fwdZ = r.fwd.z
      rgtX = fwdY * upZ - fwdZ * upY
      rgtY = fwdZ * upX - fwdX * upZ
      rgtZ = fwdX * upY - fwdY * upX
      const rl = Math.hypot(rgtX, rgtY, rgtZ) || 1
      rgtX /= rl; rgtY /= rl; rgtZ /= rl
    }
    const px = r.pos.x, py = r.pos.y, pz = r.pos.z
    const speed = this.gravity
      ? Math.sqrt(r.vel.x * r.vel.x + r.vel.y * r.vel.y + r.vel.z * r.vel.z)
      : Math.sqrt(r.vel.x * r.vel.x + r.vel.z * r.vel.z)
    const q = this.qScale * lod

    // GROUND PLANE. r.pos.y is the chassis ORIGIN, floating `altitude` above
    // the surface (0.55m for a grounded car, 1.5m for a flyer) — it is not the
    // road. Every skimming effect that used py directly was being born inside
    // the vehicle's own mesh and thrown away by the depth test, which is why
    // three quarters of the drift stream never reached the screen: only the
    // few sparks that cleared the silhouette sideways ever drew. Clamped so a
    // lifted flight chassis sheds sparks off its own hull instead of off the
    // road several metres below it.
    const dropMax = hy * 1.6 + 0.35
    const drop = r.altitude < 0 ? 0 : r.altitude > dropMax ? dropMax : r.altitude
    // Dropped along the racer's own up, so the contact point lands ON the wall
    // the car is riding rather than on the ground far below it.
    const gy = py - upY * drop

    // Publish the basis for the helpers below. Everything they need about
    // "where is this vehicle and how big is it" lives here for the rest of
    // this call, so none of them take a fourteen-argument signature.
    _bPx = px; _bPy = py; _bPz = pz; _bDrop = drop
    _bGx = px - upX * drop; _bGy = gy; _bGz = pz - upZ * drop
    _bFwdX = fwdX; _bFwdY = fwdY; _bFwdZ = fwdZ
    _bRgtX = rgtX; _bRgtY = rgtY; _bRgtZ = rgtZ
    _bUpX = upX; _bUpY = upY; _bUpZ = upZ
    setAxis(upX, upY, upZ)
    _bHx = hx; _bHy = hy; _bHz = hz
    _bQ = q; _bLocal = isLocal; _bSide = r.driftSide

    if (fx.tierFlash > 0) fx.tierFlash -= dt

    // ---- events -------------------------------------------------------
    const ev = r.events
    let sawBoostEvent = false
    for (let e = 0; stepped && e < ev.length; e++) {
      const it = ev[e]
      switch (it.t) {
        case 'boost':
          sawBoostEvent = true
          this.boostBurst(r, fx, it.tier, hz, hy, q, isLocal)
          if (isLocal && r.boostSource === 'drift' && it.tier >= 0) {
            const dl = TUNING.camera.dollyPerTier
            this.dollyRequest = Math.max(
              this.dollyRequest, dl[Math.min(it.tier, dl.length - 1)],
            )
          }
          break
        case 'driftStart':
          this.ring(gX(0, 0, 0.06), gY(0, 0, 0.06), gZ(0, 0, 0.06), SMOKE_RGB, 6.0, 0.30, 1.2, 5.0, true)
          fx.gatherAcc = 0; fx.gatherRing = 0; fx.coreAcc = 0
          fx.underAcc = 0; fx.thrustAcc = 0; fx.strainAcc = 0
          break
        case 'driftEnd': {
          if (it.tier >= 0) {
            const ti = Math.min(3, it.tier) * 3
            _rgb[0] = DRIFT_RGB[ti]; _rgb[1] = DRIFT_RGB[ti + 1]; _rgb[2] = DRIFT_RGB[ti + 2]
            this.burst(pX(0, 0, 0.3), pY(0, 0, 0.3), pZ(0, 0, 0.3), _bUpX * 0.25, _bUpY * 0.25, _bUpZ * 0.25, Math.round(12 * q), 7, 0.9, _rgb, 0.7, 0.30, 0.16, K_SPARK, -12, 2.2)
          }
          // The last of the surface, let go of as the wheels hook back up. One
          // puff, off the outside of the arc the car has just left. This rides
          // inside the `stepped` guard with every other one-shot in this
          // switch, so it fires once per drift however fast the display runs.
          if (r.grounded && speed > 6) {
            const sp = surfaceSprayAt(r.splineS, state.iceCracked)
            writeHue(_spBulk, sp.bulk, SPRAY_LUM * sp.gain)
            const out = -(fx.prevDriftSide || 1)
            const oF = -hz * 0.9, oS = out * hx
            this.burst(
              gX(oF, oS, 0.12), gY(oF, oS, 0.12), gZ(oF, oS, 0.12),
              dX(-0.6, out * 0.5, 0.55), dY(-0.6, out * 0.5, 0.55), dZ(-0.6, out * 0.5, 0.55),
              Math.round(9 * q * sp.density), 4.5, 0.85, _spBulk, 1.0,
              0.55, 0.30, K_SMOKE, 0.5 - sp.weight * 4.0, 1.9,
            )
          }
          break
        }
        case 'hit':
          this.impact(it.item, hy, q, isLocal)
          break
        case 'fire':
          this.muzzle(it.item, hz, hy, q)
          if (it.item === 'laserGatling') this.gatlingSpinUp(fx)
          break
        case 'beamFire': {
          // The sim pushes beamHit immediately after the beamFire of the same
          // shot, and only when that shot connected. Peeking one event ahead
          // is what lets a hitscan tracer stop at the target instead of
          // punching through it, without the renderer re-running the trace.
          const nxt = e + 1 < ev.length ? ev[e + 1] : null
          const tgt = nxt !== null && nxt.t === 'beamHit'
            ? this.racerById(state, nxt.targetId)
            : null
          this.gatlingShot(fx, tgt)
          break
        }
        case 'beamHit': {
          const tgt = this.racerById(state, it.targetId)
          if (tgt !== null) this.gatlingImpact(tgt, it.lethal)
          break
        }
        case 'ramp':
          this.rampLaunch(fx, it.power)
          break
        case 'pickup':
          {
            const u = hy + 0.4
            this.burst(pX(0, 0, u), pY(0, 0, u), pZ(0, 0, u), _bUpX * 0.4, _bUpY * 0.4, _bUpZ * 0.4, Math.round(14 * q), 6.5, 1.0, BOX_A_RGB, 1.6, 0.40, 0.16, K_SPARK, -8, 2.6)
            this.flash(pX(0, 0, u), pY(0, 0, u), pZ(0, 0, u), BOX_B_RGB, 2.2, 0.22, 2.0)
            this.ring(pX(0, 0, u), pY(0, 0, u), pZ(0, 0, u), BOX_A_RGB, 1.8, 0.34, 0.6, 7.0, false)
          }
          break
        case 'charge':
          {
            const u = hy + 0.3
            this.burst(pX(0, 0, u), pY(0, 0, u), pZ(0, 0, u), _bUpX * 0.5, _bUpY * 0.5, _bUpZ * 0.5, Math.round(10 * q), 4.5, 1.0, CHARGE_RGB, 1.8, 0.45, 0.11, K_SPARK, -6, 2.0)
            this.flash(pX(0, 0, u), pY(0, 0, u), pZ(0, 0, u), CHARGE_RGB, 2.0, 0.20, 1.4)
          }
          break
        case 'land':
          this.landing(it.clean, speed, q)
          // The ramp flight is over; the existing landing dust above is the
          // whole of the landing treatment, per the brief.
          fx.rampAir = 0
          break
        case 'wall':
          this.wallSparks(r, it.force, hx, hy, q, isLocal)
          break
        case 'lap':
          this.ring(pX(0, 0, 0.6), pY(0, 0, 0.6), pZ(0, 0, 0.6), WHITE_RGB, 1.0, 0.55, 1.6, 11.0, false)
          this.burst(pX(0, 0, 0.6), pY(0, 0, 0.6), pZ(0, 0, 0.6), _bUpX * 0.7, _bUpY * 0.7, _bUpZ * 0.7, Math.round(18 * q), 8, 1.0, WHITE_RGB, 0.8, 0.7, 0.13, K_SPARK, -9, 1.6)
          break
        case 'finish': {
          const cc = chassis ? chassis.colorEmissive : 0xffffff
          writeHex(_rgb2, 0, cc, 1.6)
          this.ring(pX(0, 0, 0.8), pY(0, 0, 0.8), pZ(0, 0, 0.8), WHITE_RGB, 1.0, 0.9, 2.0, 12.0, false)
          this.burst(pX(0, 0, 1.0), pY(0, 0, 1.0), pZ(0, 0, 1.0), _bUpX * 0.8, _bUpY * 0.8, _bUpZ * 0.8, Math.round(48 * q), 12, 1.0, _rgb2, 0.9, 1.5, 0.15, K_SPARK, -10, 1.1)
          this.burst(pX(0, 0, 1.0), pY(0, 0, 1.0), pZ(0, 0, 1.0), _bUpX * 0.5, _bUpY * 0.5, _bUpZ * 0.5, Math.round(20 * q), 6, 1.0, WHITE_RGB, 0.6, 1.9, 0.28, K_SPRITE, -4, 1.4)
          break
        }
      }
    }

    // ---- 1. DRIFT: GATHER -> TIER -> RELEASE ---------------------------
    if (r.driftSide !== 0) {
      const tier = r.driftTier
      const tt = TUNING.drift.tierTimes
      let lo: number, hi: number
      if (tier < 0) { lo = 0; hi = tt[0] }
      else if (tier >= 3) { lo = tt[3]; hi = tt[3] + 1.6 }
      else { lo = tt[tier]; hi = tt[tier + 1] }
      // r.driftCharge is measured in CHARGE seconds, not wall seconds: the sim
      // accrues it at derived.driftChargeMult * loco.driftChargeMult * chain *
      // lerp(chargeAtWide, 1, driftInward). Reading it against tierTimes — and
      // never against a timer of our own — is the whole reason this bar stays
      // honest on a slow-charging hover chassis and while counter-steering.
      const charge01 = clamp01((r.driftCharge - lo) / Math.max(0.01, hi - lo))
      // 0 = full counter-steer (wide, shallow), 1 = full lock (tight, crabbed).
      const inward = clamp01(r.driftInward)
      const tc = tier < 0 ? 0 : Math.min(3, tier)

      // ---- TIER-UP: a real event, escalating every time ----------------
      if (tier > fx.prevTier && tier >= 0) this.driftTierUp(fx, tier)

      // Resolve the palette for this frame ONCE. Every drift channel below
      // reads _dcol, which is how the tier colour step lands across the whole
      // effect set — sparks, motes, core, underglow, thrusters and the trail
      // ribbon — in the same frame instead of channel by channel.
      const flash01 = this.driftColor(fx, tier, _dcol)
      // Two washes, not one. Sparks and motes are thin, so they take the
      // larger transition overdrive and that is where the colour step reads.
      // The BODY channels below fill pixels in front of the camera, so they
      // get a much smaller one — a wash big enough to see, not big enough to
      // hide the car at the exact moment the player most needs the apex.
      //
      // The spark wash SHRINKS as the tier climbs, which looks backwards until
      // you remember what a wash is for: it exists to make a colour CHANGE
      // visible, and the extra luminance needed for that is inversely related
      // to how bright the destination colour already is. Tier 0 washes from a
      // 1.17-luminance cyan and needs the punch; tier 3 washes into a
      // 3.17-luminance white and needs almost none. Scaling it up with the
      // tier instead is what stacked 2.75x on top of an already 1.9x gain and
      // a 3.2x base colour, for ~17 linear per spark across ninety sparks.
      const sparkWash = 1 + flash01 * (0.35 + 0.45 * DRIFT_BODY_GAIN[tc])
      const bodyWash = 1 + flash01 * 0.30
      // The sustained-body budget: flat across the ladder by construction.
      const body = DRIFT_BODY_GAIN[tc] * bodyWash

      // ---- GATHERING ENERGY -------------------------------------------
      // The charge has to be visible BEFORE it pays out, or the tier landing
      // is the first the player hears of it. Motes spiral in from a radius
      // that tightens from ~3.6m to ~1.2m across a band, on a rate that
      // roughly triples, converging on a point under the rear axle.
      this.driftGather(dt, fx, tier, tc, charge01, inward, sparkWash, body)

      // ---- THRUSTER STRAIN --------------------------------------------
      this.driftThrusters(dt, fx, tier, tc, charge01, sparkWash)

      // ---- THE SURFACE -------------------------------------------------
      // What the car is standing on, from the theme that owns this planet.
      // The lookup is one array index off r.splineS; the palette resolve is
      // three hue normalisations. Both are per racer per frame and neither
      // allocates, which is what lets eight cars each be sliding on a
      // different surface at once.
      const surf = surfaceSprayAt(r.splineS, state.iceCracked)
      writeHue(_spBulk, surf.bulk, SPRAY_LUM * surf.gain * this.hdr)
      writeHue(_spGlint, surf.glint, GLINT_LUM * this.hdr)
      writeHue(_spSpark, surf.sparkCol, SCRAPE_LUM * this.hdr)
      // Ribbon state for updateTrail, which runs for this racer immediately
      // after this call and needs the drift terms this block resolved.
      fx.ribTier = tier
      fx.ribCharge = charge01
      fx.ribInward = inward

      // A grounded chassis tears at the surface and strikes off it. A hover
      // skirt and a flight frame never touch it, so they get the other half of
      // the same physics: displaced air, and whatever their downwash can lift.
      // rideHeight is what separates the two — 0.55 m of suspension travel
      // against a metre of repulsor gap — and `grounded` is what keeps a
      // grounded car that is mid-jump from throwing sparks off thin air.
      // (surfaceFrictionInfluence would be the other half of this test, but the
      // Cryostatic balance pass set it to 1.0 for every class as a holding
      // position, so today it separates nothing. See TUNING.locomotion.)
      const ride = getLocomotion(r.chassisId).rideHeight
      if (loco === 'grounded' && ride < 0.8) {
        if (r.grounded) {
          this.driftSpray(dt, fx, tc, charge01, inward, speed, surf, 1)
          this.driftScrape(dt, fx, tc, charge01, inward, surf)
        }
      } else {
        // Entrainment falls off with the gap: a hovercraft skimming the snow
        // lifts a lot of it, the same frame two metres higher lifts none.
        const gap = r.altitude - ride
        const entrain = clamp01(1 - (gap < 0 ? 0 : gap) / 2.4)
        this.driftAir(dt, fx, tc, charge01, inward, surf, entrain, loco === 'flight' ? 1 : 0)
        if (entrain > 0.05) {
          this.driftSpray(dt, fx, tc, charge01, inward, speed, surf, entrain * 0.75)
        }
      }

      // ---- UNDERGLOW + CHARGE HEARTBEAT --------------------------------
      // The pool is the continuous body of colour under the chassis; the
      // heartbeat is a ring on a cadence that accelerates from roughly every
      // 0.6s at the bottom of a band to every 0.14s at the top. Together they
      // turn "how close am I" into a rhythm readable in peripheral vision.
      fx.underAcc += dt * 13 * q
      if (fx.underAcc >= 1) {
        fx.underAcc = 0
        const ug = tier < 0 ? 0.20 * bodyWash : (0.26 + charge01 * 0.50) * body
        this.ring(gX(0, 0, 0.04), gY(0, 0, 0.04), gZ(0, 0, 0.04), _dcol, ug, 0.17, hx * (1.45 + charge01 * 0.55), 1.4, true)
      }
      fx.pulseAcc += dt * (1.7 + charge01 * 5.6)
      if (fx.pulseAcc >= 1) {
        fx.pulseAcc = 0
        const hg = tier < 0 ? 2.6 * bodyWash : (0.42 + charge01 * 0.40) * body
        this.shockRing(gX(0, 0, 0.05), gY(0, 0, 0.05), gZ(0, 0, 0.05), _dcol, hg, 0.34, 0.5, 4.0 + charge01 * 3.0 + tc * 1.0, true)
      }

      // ---- SPARK FAN ---------------------------------------------------
      // Continuous stream from both rear corners, weighted to the inside.
      // driftSide === +1 is a right-hand drift, and with right = forward x up
      // the inside of that arc is the +right side, so inside = +driftSide.
      //
      // driftInward is the player's live control of the slide, so it is the
      // loudest term here. At full lock the fan is thrown wide, fast and high;
      // at full counter-steer it collapses into a shallow trickle that mostly
      // trails the car. This spray is the only continuous feedback that
      // counter-steering is doing anything, and it has to read without the HUD.
      const inside = r.driftSide
      const fan = 0.30 + inward * 1.60     // lateral throw
      const rise = 1.4 + inward * 2.6      // vertical throw
      const jit = 0.4 + inward * 2.4       // angular scatter
      const rate = (tier < 0 ? 34 : 92 + tier * 62)
        * (0.55 + charge01 * 0.75) * (0.55 + inward * 0.70) * q
      fx.driftAcc += dt * rate
      let guard = 0
      while (fx.driftAcc >= 1 && guard < 34) {
        fx.driftAcc -= 1
        guard++
        // 70% inside corner, 30% outside.
        const side = rnd() < 0.7 ? inside : -inside
        // Anchored on the CONTACT POINT, in the car's own frame. `px` with a
        // `gy` was a half-converted mix: the height came off the deck, the
        // x and z came off the chassis origin, and on a wall those are metres
        // apart.
        const eF = -(hz * 0.94), eS = side * hx * 1.16
        const ex = gX(eF, eS, 0.12)
        const ey = gY(eF, eS, 0.12)
        const ez = gZ(eF, eS, 0.12)
        if (tier < 0) {
          // No colour yet: friction smoke only, and even that thins out when
          // the player counter-steers, so "wide slide = calm" holds from the
          // very first moment of the drift.
          this.spawn(
            ex, ey, ez,
            dX(-2.0, 0, 0.5 + rnd() * (0.5 + inward * 0.8)) + rnd2() * (0.6 + inward * 1.1),
            dY(-2.0, 0, 0.5 + rnd() * (0.5 + inward * 0.8)),
            dZ(-2.0, 0, 0.5 + rnd() * (0.5 + inward * 0.8)) + rnd2() * (0.6 + inward * 1.1),
            SMOKE_RGB[0], SMOKE_RGB[1], SMOKE_RGB[2],
            0.42 + rnd() * 0.25, 0.30, 0.55, 0.4, 1.6, K_SMOKE,
          )
        } else {
          // Tuned so the spark BODY stays under the point where ACES flattens
          // every channel to white — a spark bright enough to clip in all
          // three loses the tier colour entirely and the ladder with it. The
          // core still clips, which is what makes it read as white-hot, and
          // bloom carries the hue outward from there.
          // The tier term is small on purpose. DRIFT_RGB already carries a
          // 2.7x luminance ladder, so a large tier term here double-counts it;
          // at 0.28 a tier-3 spark ran at 6.1 linear before any wash, and
          // ninety of them in a two-metre ball is a two-metre ball of light.
          // The tier still reads through hue, through the 2.4x size step and
          // through the 3x count step.
          // Partial, not full, normalisation: the fan IS the primary tier read
          // and keeps most of the ladder, but ninety sparks at 7 linear in a
          // two-metre ball still bloom into a halo over the chassis, so a
          // little of the tier's own luminance comes back out.
          const gain = (1.00 + charge01 * 0.70 + tier * 0.12) * sparkWash
            * (0.55 + 0.45 * DRIFT_BODY_GAIN[tc])
          const sp = (5 + tier * 3 + charge01 * 4) * (0.55 + inward * 0.75)
          // Sparks are thrown UP and OUT, not just back: at 60 m/s a stream
          // that hugs the ground behind the chassis is occluded by the
          // chassis. Rising sparks clear the roofline and read in the mirror
          // strip of the frame where the player's attention already is.
          this.spawn(
            ex, ey, ez,
            _bUpX * (rise + rnd() * (2.2 + tier * 1.4) * (0.55 + inward * 0.75))
              + rgtX * side * (2.2 + rnd() * sp * 0.5) * fan - fwdX * (2.2 + rnd() * sp) + rnd2() * jit,
            _bUpY * (rise + rnd() * (2.2 + tier * 1.4) * (0.55 + inward * 0.75))
              + rgtY * side * (2.2 + rnd() * sp * 0.5) * fan - fwdY * (2.2 + rnd() * sp),
            _bUpZ * (rise + rnd() * (2.2 + tier * 1.4) * (0.55 + inward * 0.75))
              + rgtZ * side * (2.2 + rnd() * sp * 0.5) * fan - fwdZ * (2.2 + rnd() * sp) + rnd2() * jit,
            _dcol[0] * gain, _dcol[1] * gain, _dcol[2] * gain,
            0.22 + rnd() * 0.24, DRIFT_SIZE[tc], 0, -14, 2.4, K_SPARK,
          )
          // WHEEL GLOW. A soft ember riding the contact patch, present at
          // every tier and growing with it. Thin stretched sparks alone carry
          // almost no screen coverage, so without this the lower tiers read as
          // a faint haze; this is the body of the effect and the sparks are
          // the texture on top of it. Tier 3 promotes it to a shell, whose
          // punched-out dark core is the shape that says "maximum".
          // Rate-normalised against the spark rate so the glow count stays
          // bounded (5 alive at tier 0, 11 at tier 3) instead of scaling with
          // the stream and burning the rear of the frame out at tier 3.
          if (rnd() * rate < 24 + tier * 6) {
            // WHEEL GLOW — the single largest sustained shape, and so the one
            // held hardest to the no-occlusion rule. Three separate things
            // used to climb here at once: the count (2.2x), the tier colour's
            // luminance (2.7x) and the quad area (3x), for a 17x climb in
            // filled screen energy that ended as two white suns over the rear
            // of the car. The count still climbs — that IS the tier read — but
            // the luminance is normalised back out by DRIFT_BODY_GAIN and the
            // area climb is flattened. From tier 2 it also becomes a SHELL,
            // whose punched-out dark core lets the chassis silhouette straight
            // through the brightest part of the effect.
            const wg = (0.60 + charge01 * 0.35) * body
            this.spawn(
              ex + _bUpX * 0.04, ey + _bUpY * 0.04, ez + _bUpZ * 0.04,
              dX(-1.2, 0, 1.1 + tier * 0.2), dY(-1.2, 0, 1.1 + tier * 0.2), dZ(-1.2, 0, 1.1 + tier * 0.2),
              _dcol[0] * wg, _dcol[1] * wg, _dcol[2] * wg,
              0.26 + tier * 0.02, 0.19 + tier * 0.022, 0.85 + tier * 0.05,
              0, 1.3, tier >= 2 ? K_SHELL : K_SPRITE,
            )
          }
          if (tier >= 2 && rnd() < 0.12) {
            this.spawn(
              ex, ey, ez, dX(-1.0, 0, 0.9), dY(-1.0, 0, 0.9), dZ(-1.0, 0, 0.9),
              _dcol[0] * 0.16, _dcol[1] * 0.16, _dcol[2] * 0.16,
              0.40, 0.34, 0.7, 0.3, 1.5, K_SMOKE,
            )
          }
        }
      }
      fx.prevTier = tier
    } else {
      fx.prevTier = -2
      fx.driftAcc = 0
      fx.pulseAcc = 0
      fx.gatherAcc = 0
      fx.gatherRing = 0
      fx.coreAcc = 0
      fx.underAcc = 0
      fx.thrustAcc = 0
      fx.strainAcc = 0
      fx.sprayAcc = 0
      fx.washAcc = 0
      fx.airWashAcc = 0
      fx.scrapeAcc = 0
      fx.scrapeBeat = 0
      fx.vortexAcc = 0
      // ribTier is NOT cleared: the ribbons are still fading out along the arc
      // the slide just carved, and they have to fade in the colour they were.
    }
    fx.prevDriftSide = r.driftSide

    // ---- 1b. PULSE GATLING: shooter idle + victim overload -------------
    this.gatlingState(dt, r, fx)

    // ---- 1c. RAMP AFTERBURN --------------------------------------------
    // The flag is cleared by grounding (or a respawn), never by airTime: the
    // sim's ramp block runs AFTER its airborne block in the same step, so on
    // the launch frame the racer is already ungrounded but airTime is still 0.
    // Testing airTime here would kill every flight on the frame it began.
    if (fx.rampAir > 0) {
      if (r.grounded || r.respawnTime > 0) fx.rampAir = 0
      else if (r.airTime > 0) this.rampAfterburn(dt, fx, r)
    }

    // ---- 2. BOOST plume (continuous, any source) -----------------------
    if (r.boostTime > 0 && r.boostMag > 0) {
      const b01 = clamp01(r.boostMag / 0.55)
      this.boostColorOf(r, _rgb)
      // Off the tail, a fifth of a body-height up: the CAR's tail and the
      // CAR's up. The plume is the single largest continuous shape in the
      // game, and on a wall-ride it used to fire out of the vehicle's flank.
      const eF = -hz * 1.12, eU = hy * 0.20
      const ex = pX(eF, 0, eU), ey = pY(eF, 0, eU), ez = pZ(eF, 0, eU)
      // The plume is deliberately SHORT and heavily damped. Emitted straight
      // back at 10-32 m/s with light drag it used to reach the chase camera,
      // where a single 0.5m sprite spans a third of the screen; a boost
      // erased the player's own vehicle behind a white column. Slower, denser
      // drag keeps the cone stalled within a metre or so of the exhaust, and
      // the shader's near-camera fade catches whatever escapes.
      fx.plumeAcc += dt * (95 + b01 * 110) * q
      let guard = 0
      while (fx.plumeAcc >= 1 && guard < 26) {
        fx.plumeAcc -= 1
        guard++
        // Scatter across the exhaust FACE: the (right, up) plane of the car.
        const js = rnd2() * hx * 0.55
        const ju = rnd2() * hx * 0.55
        const jx = _bRgtX * js + _bUpX * ju
        const jy = _bRgtY * js + _bUpY * ju
        const jz = _bRgtZ * js + _bUpZ * ju
        // The drift palette's tier-3 white sits at luminance 3.2; at the old
        // gain the plume ran at 3.3 and simply erased the vehicle it was
        // supposed to be attached to. Biased slightly downward as well, so it
        // washes the road behind the car instead of the car itself.
        const gain = 0.20 + b01 * 0.30
        const back = -(4.5 + rnd() * 8 * b01)
        const drift = -0.2 + rnd() * 0.9
        this.spawn(
          ex + jx, ey + jy, ez + jz,
          dX(back, 0, drift) + rnd2() * 2.2,
          dY(back, 0, drift),
          dZ(back, 0, drift) + rnd2() * 2.2,
          _rgb[0] * gain, _rgb[1] * gain, _rgb[2] * gain,
          0.15 + rnd() * 0.14, 0.115 + b01 * 0.10, 0.62, 0.6, 6.5, K_SPRITE,
        )
        if (rnd() < 0.34) {
          const cb = -(9 + rnd() * 15)
          const cu = 0.8 + rnd() * 2.0
          this.spawn(
            ex + jx, ey + jy, ez + jz,
            dX(cb, 0, cu) + rnd2() * 3.0, dY(cb, 0, cu), dZ(cb, 0, cu) + rnd2() * 3.0,
            _rgb[0] * 0.45, _rgb[1] * 0.45, _rgb[2] * 0.45,
            0.20, 0.085, 0, -8, 3.2, K_SPARK,
          )
        }
      }
      if (isLocal) this.boostIntensity = Math.max(this.boostIntensity, 0.30 + b01 * 0.55)
      if (isLocal && this.lights.length >= 3) {
        const l = this.lights[0]
        l.position.set(ex + _bUpX * 0.4, ey + _bUpY * 0.4, ez + _bUpZ * 0.4)
        l.color.setRGB(Math.min(1, _rgb[0]), Math.min(1, _rgb[1]), Math.min(1, _rgb[2]), THREE.LinearSRGBColorSpace)
        this.lightTtl[0] = Math.max(this.lightTtl[0], 0.05)
        this.lightPow[0] = 2.0 + b01 * 5.0
      }
      // Boosts that the sim does not announce (nitro, pads, overdrive) still
      // get a shockwave the first frame they appear.
      if (fx.prevBoostTime <= 0 && !sawBoostEvent) {
        this.ring(gX(0, 0, 0.06), gY(0, 0, 0.06), gZ(0, 0, 0.06), _rgb, 0.50, 0.34, 1.0, 22, true)
        this.burst(ex, ey, ez, dX(-1, 0, 0.2), dY(-1, 0, 0.2), dZ(-1, 0, 0.2), Math.round(18 * q), 16, 0.7, _rgb, 0.42, 0.34, 0.14, K_SPARK, -8, 2.0)
      }
    } else {
      fx.plumeAcc = 0
    }
    fx.prevBoostTime = r.boostTime

    // ---- 10. SURFACE CONTACT -------------------------------------------
    if (r.grounded && speed > 4) {
      const offTrack = r.offTrackTime > 0
      const dustRate = (offTrack ? 46 : 12) * clamp01(speed / 40) * q
      fx.dustAcc += dt * dustRate
      let guard = 0
      while (fx.dustAcc >= 1 && guard < 10) {
        fx.dustAcc -= 1
        guard++
        const dS = rnd2() * hx * 1.1, dF = -hz * 0.95
        const dBack = -(1.5 + rnd() * 3)
        const dRise = 0.7 + rnd() * 1.3
        const col = offTrack ? DUST_RGB : SMOKE_RGB
        const gain = offTrack ? 1.5 : 1.0
        this.spawn(
          gX(dF, dS, 0.08), gY(dF, dS, 0.08), gZ(dF, dS, 0.08),
          dX(dBack, 0, dRise) + rnd2() * 1.4, dY(dBack, 0, dRise), dZ(dBack, 0, dRise) + rnd2() * 1.4,
          col[0] * gain, col[1] * gain, col[2] * gain,
          0.55 + rnd() * 0.4, 0.30, 0.75, 0.5, 1.5, K_SMOKE,
        )
      }
    }
    // Hover / flight ground-effect ripple.
    if (loco !== 'grounded' && r.altitude < 3.2 && speed > 2) {
      fx.hoverAcc += dt * 9 * q
      if (fx.hoverAcc >= 1) {
        fx.hoverAcc = 0
        const cc = chassis ? chassis.colorEmissive : 0x88ccff
        writeHex(_rgb2, 0, cc, 0.55)
        const hd = 0.04 - r.altitude
        this.ring(
          pX(0, 0, hd), pY(0, 0, hd), pZ(0, 0, hd),
          _rgb2, 1.0, 0.46, hx * 1.4, 5.5, true,
        )
      }
    }

    // ---- 11. INVINCIBILITY ----------------------------------------------
    if (r.invincibleTime > 0) {
      fx.invAcc += dt * 70 * q
      let guard = 0
      while (fx.invAcc >= 1 && guard < 14) {
        fx.invAcc -= 1
        guard++
        const a = rnd() * TAU
        const rad = hx * 1.5 + rnd() * 0.5
        // Saturated and spread across the wheel per particle, so the aura
        // reads as a moving rainbow rather than a single tinted white cloud.
        _c.setHSL((this.time * 0.7 + rnd()) % 1, 1.0, 0.55, THREE.SRGBColorSpace)
        // The aura orbits the CAR's waist, in its own (right, forward) plane.
        const ca2 = Math.cos(a) * rad, sa2 = Math.sin(a) * rad
        const au = rnd() * (hy * 2.4)
        const vu = 1.2 + rnd() * 1.6
        this.spawn(
          pX(sa2, ca2, au), pY(sa2, ca2, au), pZ(sa2, ca2, au),
          dX(Math.sin(a) * 1.2, Math.cos(a) * 1.2, vu),
          dY(Math.sin(a) * 1.2, Math.cos(a) * 1.2, vu),
          dZ(Math.sin(a) * 1.2, Math.cos(a) * 1.2, vu),
          _c.r * 2.6, _c.g * 2.6, _c.b * 2.6,
          0.42, 0.155, 0, -1.2, 1.4, K_SPARK,
        )
      }
      // Afterimage: a stationary ghost shell dropped at the old position.
      fx.spinAcc += dt
      if (fx.spinAcc >= 0.07) {
        fx.spinAcc = 0
        _c.setHSL((this.time * 0.9) % 1, 1.0, 0.55, THREE.SRGBColorSpace)
        this.spawn(
          pX(0, 0, hy * 0.6), pY(0, 0, hy * 0.6), pZ(0, 0, hy * 0.6), 0, 0, 0,
          _c.r * 0.85, _c.g * 0.85, _c.b * 0.85,
          0.34, hz * 1.15, 0.5, 0, 0, K_SHELL,
        )
      }
    } else if (r.spinTime > 0) {
      // Spun out: smoke and stray sparks.
      fx.spinAcc += dt * 26 * q
      let guard = 0
      while (fx.spinAcc >= 1 && guard < 10) {
        fx.spinAcc -= 1
        guard++
        const su = hy + rnd() * 0.5
        const sv = 1.4 + rnd() * 1.6
        this.spawn(
          pX(0, 0, su) + rnd2() * hx, pY(0, 0, su), pZ(0, 0, su) + rnd2() * hx,
          _bUpX * sv + rnd2() * 2.0, _bUpY * sv, _bUpZ * sv + rnd2() * 2.0,
          SMOKE_RGB[0] * 1.4, SMOKE_RGB[1] * 1.4, SMOKE_RGB[2] * 1.4,
          0.7, 0.34, 0.9, 0.7, 1.3, K_SMOKE,
        )
      }
    } else {
      fx.spinAcc = 0
      fx.invAcc = 0
    }

    // Slowed by a gravity well: violet drag wisps.
    if (r.slowTime > 0 && rnd() < 0.5 * lod) {
      const wu = hy * 0.5
      this.spawn(
        gX(0, 0, wu) + rnd2() * hx * 1.3, gY(0, 0, wu), gZ(0, 0, wu) + rnd2() * hx * 1.3,
        dX(-3.0, 0, 0.6) + rnd2(), dY(-3.0, 0, 0.6), dZ(-3.0, 0, 0.6) + rnd2(),
        WELL_RGB[0] * 1.2, WELL_RGB[1] * 1.2, WELL_RGB[2] * 1.2,
        0.5, 0.26, 0.6, 0.2, 1.6, K_SMOKE,
      )
    }

    // ---- 12. RESPAWN ----------------------------------------------------
    if (r.respawnTime > 0 && fx.prevRespawn <= 0) {
      // Dissolve out.
      const cc = chassis ? chassis.colorEmissive : 0x9fd8ff
      writeHex(_rgb2, 0, cc, 1.4)
      this.burst(pX(0, 0, hy), pY(0, 0, hy), pZ(0, 0, hy), _bUpX * 0.6, _bUpY * 0.6, _bUpZ * 0.6, Math.round(38 * q), 5, 1.0, _rgb2, 1.0, 0.75, 0.13, K_SPARK, 2.0, 0.9)
      this.burst(pX(0, 0, hy), pY(0, 0, hy), pZ(0, 0, hy), _bUpX * 0.4, _bUpY * 0.4, _bUpZ * 0.4, Math.round(16 * q), 2.5, 1.0, _rgb2, 0.7, 0.9, 0.5, K_SMOKE, 0.8, 1.2)
      this.spawn(_bGx, _bGy, _bGz, 0, 0, 0, _rgb2[0], _rgb2[1], _rgb2[2], 0.55, 1.1, -0.6, 0, 0, K_BEAM)
      this.ring(gX(0, 0, 0.05), gY(0, 0, 0.05), gZ(0, 0, 0.05), _rgb2, 1.4, 0.5, 1.0, 9, true)
    } else if (r.respawnTime <= 0 && fx.prevRespawn > 0) {
      // Beam in.
      this.spawn(_bGx, _bGy, _bGz, 0, 0, 0, 1.4, 1.7, 2.0, 0.75, 1.5, -0.9, 0, 0, K_BEAM)
      this.ring(gX(0, 0, 0.05), gY(0, 0, 0.05), gZ(0, 0, 0.05), WHITE_RGB, 1.5, 0.55, 0.6, 14, true)
      this.flash(pX(0, 0, hy), pY(0, 0, hy), pZ(0, 0, hy), WHITE_RGB, 2.2, 0.30, 2.4)
      for (let i = 0; i < Math.round(26 * q); i++) {
        const a = rnd() * TAU
        const rr = 2.5 + rnd() * 3.0
        this.spawn(
          pX(Math.sin(a) * rr, Math.cos(a) * rr, 5 + rnd() * 6),
          pY(Math.sin(a) * rr, Math.cos(a) * rr, 5 + rnd() * 6),
          pZ(Math.sin(a) * rr, Math.cos(a) * rr, 5 + rnd() * 6),
          -Math.cos(a) * rr * 1.6, -9 - rnd() * 6, -Math.sin(a) * rr * 1.6,
          1.1, 1.5, 2.0, 0.55, 0.12, 0, 0, 0.6, K_SPARK,
        )
      }
      this.claimLight(pX(0, 0, 1.5), pY(0, 0, 1.5), pZ(0, 0, 1.5), PAD_RGB, 4.0, 0.35)
    }
    fx.prevRespawn = r.respawnTime
  }

  /**
   * Linear scan for a racer id. The field is at most MAX_RACERS and a beamHit
   * arrives at most fireRate times a second per shooter, so an id->index map
   * would be state to keep in sync for nothing.
   */
  private racerById(state: RaceState, id: number): RacerState | null {
    const list = state.racers
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i]
    return null
  }

  // -------------------------------------------------------------------------
  // 1. Drift: gathering energy, tier transitions, thruster strain, release
  // -------------------------------------------------------------------------

  /**
   * Resolves the drift palette for this frame into `out`, and returns the
   * tier-transition wash as 0..1.
   *
   * That wash is the whole mechanism behind "the colour changes with each
   * phase". On a tier-up every channel is driven toward white and overdriven
   * in gain, then decays into the NEW tier's hue over about a third of a
   * second. A straight palette swap between two frames is invisible mid-corner
   * — the player is looking at the apex, not at their own rear axle. A white
   * flash that RESOLVES into a different colour is not.
   */
  private driftColor(fx: RacerFx, tier: number, out: Float32Array): number {
    if (tier < 0) {
      // Pre-tier is deliberately colourless: "no tier yet" has to read as the
      // absence of the ladder, not as a fifth colour on it.
      out[0] = SMOKE_RGB[0] * 1.5; out[1] = SMOKE_RGB[1] * 1.5; out[2] = SMOKE_RGB[2] * 1.5
    } else {
      const ti = Math.min(3, tier) * 3
      out[0] = DRIFT_RGB[ti]; out[1] = DRIFT_RGB[ti + 1]; out[2] = DRIFT_RGB[ti + 2]
    }
    if (fx.tierFlash <= 0) return 0
    const f = clamp01(fx.tierFlash * 3.4)
    const w = f * f * (0.34 + fx.tierFlashT * 0.16)
    const iw = 1 - w
    out[0] = out[0] * iw + WHITE_RGB[0] * w * 2.2
    out[1] = out[1] * iw + WHITE_RGB[1] * w * 2.2
    out[2] = out[2] * iw + WHITE_RGB[2] * w * 2.2
    return f
  }

  /**
   * A tier landing. Five channels fire at once and EVERY one of them scales
   * with the tier index, so tier 3 is unmistakably a bigger event than tier 0
   * rather than the same event in a different colour:
   *   1. a hard flash          - two, one at the rear, one over the roofline
   *   2. an expanding shock    - shell + camera ring + ground ring + a SECOND
   *                              front deferred ~90ms behind the first
   *   3. a spark ejection      - full sphere, count and speed both climb
   *   4. a thruster cough      - both nozzles, escalating
   *   5. a colour wash         - white, resolving into the new tier hue
   */
  private driftTierUp(fx: RacerFx, tier: number): void {
    const t = Math.min(3, tier)
    fx.tierFlash = 0.20 + t * 0.045
    fx.tierFlashT = t

    // Base tier colour, deliberately NOT washed: this burst is the moment the
    // new hue arrives, so it must not be flattened by its own transition.
    const ti = t * 3
    _dcol2[0] = DRIFT_RGB[ti]; _dcol2[1] = DRIFT_RGB[ti + 1]; _dcol2[2] = DRIFT_RGB[ti + 2]

    const q = _bQ
    const hx = _bHx, hy = _bHy, hz = _bHz
    // Every point below is placed in the RACER'S frame -- `f` metres forward,
    // `s` to its right, `u` along its up -- so a tier landed on a wall throws
    // its sparks off the wall. Flat, `gX(a, 0, b)` is the `px - fwdX * a` /
    // `gy + b` arithmetic this replaced, term for term.
    const rF = -hz * 1.02 // rear axle, forward-metres from the origin

    // 1. FLASH. Small and hot, at the REAR where the charge lives — never a
    //    filled disc scaled up with the tier. A K_SPRITE is a solid gaussian,
    //    so at the old 3.15m it was simply a white card laid over the vehicle:
    //    a tier-3 transition erased the car, the road and the horizon for a
    //    third of a second. The tier reads through the annular shapes below
    //    and through the spark count, both of which the car silhouettes
    //    against, so the flash only has to say "now".
    // Every front below is normalised by DRIFT_BODY_GAIN for the same reason
    // the sustained body is: at a flat gain the tier-3 fronts came out at
    // luminance 3.0-5.6 against tier 0's 1.0, purely because DRIFT_RGB's white
    // is three times brighter than its cyan. Tier 0's transition measures
    // clean; tier 3's was the whiteout. The escalation is in the RADII below
    // (2.7x), in the spark count (3x), in the extra third front and in the
    // distortion shell — none of which fill the middle of the frame.
    const front = DRIFT_BODY_GAIN[t]
    this.flash(gX(rF, 0, 0.42), gY(rF, 0, 0.42), gZ(rF, 0, 0.42),
      _dcol2, (0.85 + t * 0.30) * front, 0.11 + t * 0.02, 0.50 + t * 0.18)

    // 2. SHOCK. All three fronts are annular — a punched-core shell plus two
    //    rings — and all three are bounded by shockRing/shockShell, so the
    //    escalation is in RADIUS and in how many fronts arrive, not in how
    //    much of the frame is filled. The second front is deferred ~90ms so
    //    the transition occupies time rather than a single frame.
    this.shockShell(pX(0, 0, 0.30), pY(0, 0, 0.30), pZ(0, 0, 0.30),
      _dcol2, 0.95 * front, 0.26 + t * 0.06, 0.85 + t * 0.35, 3.4 + t * 1.7)
    this.shockRing(pX(0, 0, 0.25), pY(0, 0, 0.25), pZ(0, 0, 0.25),
      _dcol2, (0.85 + t * 0.16) * front, 0.26 + t * 0.05, 0.7, 3.0 + t * 1.6, false)
    this.shockRing(gX(0, 0, 0.06), gY(0, 0, 0.06), gZ(0, 0, 0.06),
      _dcol2, (0.70 + t * 0.14) * front, 0.32 + t * 0.04, 0.9, 5.5 + t * 3.2, true)
    this.defer(0.085 + t * 0.012, pX(0, 0, 0.28), pY(0, 0, 0.28), pZ(0, 0, 0.28),
      _dcol2, D_DRIFT_SHOCK, t)

    // 3. EJECTION. A full sphere, not a cone: at the instant of a tier the
    //    energy is not going anywhere in particular yet.
    // The COUNT escalates hard — that is the tier read — while the per-spark
    // gain is normalised against the tier's own luminance, so sixty-six
    // tier-3 sparks are sixty-six sparks rather than a solid ball.
    this.burst(
      gX(rF, 0, 0.22), gY(rF, 0, 0.22), gZ(rF, 0, 0.22),
      dX(-0.4, 0, 0.45), dY(-0.4, 0, 0.45), dZ(-0.4, 0, 0.45),
      Math.round((14 + (t + 1) * 13) * q), 11 + t * 5, 1.0,
      _dcol2, 0.90 * (0.45 + 0.55 * DRIFT_BODY_GAIN[t]),
      0.36 + t * 0.05, DRIFT_SIZE[t] * 1.30, K_SPARK, -14, 2.4,
    )

    // 4. THRUSTER COUGH
    const nF = -hz * 1.06
    const off = hx * 0.52
    const nU = hy * 0.55
    for (let s = -1; s <= 1; s += 2) {
      const ex = gX(nF, off * s, nU), ey = gY(nF, off * s, nU), ez = gZ(nF, off * s, nU)
      const cough = 0.45 + 0.55 * DRIFT_BODY_GAIN[t]
      this.flash(ex, ey, ez, _dcol2, (0.85 + t * 0.28) * cough, 0.12, 0.30 + t * 0.10)
      this.burst(
        ex, ey, ez, dX(-1, 0, 0.12), dY(-1, 0, 0.12), dZ(-1, 0, 0.12),
        Math.round((5 + t * 5) * q), 13 + t * 7, 0.30,
        _dcol2, (0.70 + t * 0.22) * cough, 0.20, 0.085 + t * 0.02, K_SPARK, -6, 3.0,
      )
    }

    // A point light 0.6m from the chassis at power 6.8 drove the vehicle's own
    // material far past the bloom threshold, so the car became its own corona.
    // Moved to the rear axle and cut about five-fold in peak intensity.
    if (t >= 1) {
      this.claimLight(gX(rF, 0, 0.5), gY(rF, 0, 0.5), gZ(rF, 0, 0.5),
        _dcol2, 0.8 + t * 0.5, 0.13 + t * 0.02)
    }
    if (t >= 3) {
      // Maximum is the only tier that bends space, and the distortion shell is
      // the right tool precisely because it DARKENS: a dark body with a hard
      // chromatic rim reads as maximum without adding a single lumen in front
      // of the car. The companion shell is annular for the same reason.
      const sF = hz * 1.5
      this.spawnDistortion(pX(0, 0, hy), pY(0, 0, hy), pZ(0, 0, hy), 1.6, 7.0, 0.34)
      this.shockShell(pX(sF, 0, hy), pY(sF, 0, hy), pZ(sF, 0, hy), WHITE_RGB, 0.55, 0.30, 0.9, 2.6)
      this.defer(0.20, pX(0, 0, 0.28), pY(0, 0, 0.28), pZ(0, 0, 0.28), WHITE_RGB, D_DRIFT_SHOCK, 3)
    }
    // Also feeds the composite's zoom, chromatic aberration and vignette, all
    // of which compound the whiteout, so it is cut alongside the particles.
    if (_bLocal) this.boostIntensity = Math.max(this.boostIntensity, 0.14 + t * 0.09)
  }

  /**
   * Gathering energy. Motes spiral inward onto a convergence point under the
   * rear axle from a radius that TIGHTENS as the next tier approaches — about
   * 3.6m at the bottom of a band down to 1.2m at the top — on a rate that
   * roughly triples over the same span, under a collapsing ring and a core
   * glow that runs away quadratically in the last quarter.
   *
   * The point of all of it is that a tier should be felt coming, not just
   * announced on arrival. A constant-radius swirl reads as ambience; one that
   * visibly closes reads as something being wound up.
   */
  private driftGather(
    dt: number, fx: RacerFx, tier: number, tc: number,
    charge01: number, inward: number, sparkWash: number, body: number,
  ): void {
    const q = _bQ
    if (q <= 0) return
    // Convergence point: under the rear axle, in the racer's own frame.
    const cF = -_bHz * 0.62, cU = _bHy * 0.60
    const cx = gX(cF, 0, cU), cy = gY(cF, 0, cU), cz = gZ(cF, 0, cU)
    const gr = (3.6 - charge01 * 2.4) * (1 + tc * 0.10)

    // ---- motes --------------------------------------------------------
    const rate = (tier < 0 ? 9 : 20 + tc * 15)
      * (0.30 + charge01 * 1.55) * (0.70 + inward * 0.45) * q
    fx.gatherAcc += dt * rate
    let guard = 0
    while (fx.gatherAcc >= 1 && guard < 26) {
      fx.gatherAcc -= 1
      guard++
      const a = rnd() * TAU
      const ca = Math.cos(a), sa = Math.sin(a)
      const rr = gr * (0.80 + rnd() * 0.45)
      // The swirl is a ring in the SURFACE plane with a little scatter along
      // the surface normal, which is what it always was -- it was just spelled
      // in world XZ and world +Y, and on a wall that ring stands on its edge
      // and cuts through the road. `a` is uniformly random, so on a flat track
      // this is the same circle drawn from a different zero.
      const oF = ca * rr, oS = sa * rr, oU = rnd2() * (0.45 + tc * 0.16) + 0.18
      const sx = cx + dX(oF, oS, oU)
      const sy = cy + dY(oF, oS, oU)
      const sz = cz + dZ(oF, oS, oU)
      const life = 0.14 + rnd() * 0.15
      const inv = 1 / life
      // Straight-line convergence plus a tangential sweep. Gravity and drag
      // are both zero, so the shader's analytic path is exact and every mote
      // lands on the convergence point at the instant it dies; the tangential
      // term is what bends that path into a spiral instead of a spoke.
      const spin = (0.32 + charge01 * 0.42) * (0.55 + inward * 0.80)
      // Motes are thin streaks, so they keep the full ladder and the full wash.
      const g = (0.50 + charge01 * 1.30) * sparkWash
      // Straight-in convergence plus the same 90-degree tangential sweep,
      // both now expressed in the surface plane.
      const tF = -oS * spin, tS = oF * spin
      this.spawn(
        sx, sy, sz,
        (cx - sx) * inv + dX(tF, tS, 0),
        (cy - sy) * inv + dY(tF, tS, 0),
        (cz - sz) * inv + dZ(tF, tS, 0),
        _dcol[0] * g, _dcol[1] * g, _dcol[2] * g,
        life, 0.075 + tc * 0.018, 0, 0, 0, K_SPARK,
      )
    }

    // ---- collapsing ring ----------------------------------------------
    fx.gatherRing += dt * (1.0 + charge01 * 5.0)
    if (fx.gatherRing >= 1) {
      fx.gatherRing = 0
      const rl = 0.26 + charge01 * 0.10
      const r0 = Math.min(SHOCK_MAX, gr * 1.15)
      const g = (0.30 + charge01 * 0.70) * body
      this.spawn(
        cx, cy, cz, 0, 0, 0,
        _dcol[0] * g, _dcol[1] * g, _dcol[2] * g,
        rl, r0, -(r0 * 0.94) / rl, 0, 0, K_RING,
      )
    }

    // ---- rising core ---------------------------------------------------
    fx.coreAcc += dt * (10 + charge01 * 16) * q
    let cguard = 0
    while (fx.coreAcc >= 1 && cguard < 12) {
      fx.coreAcc -= 1
      cguard++
      // Quadratic in charge01: the last quarter of a band is where the player
      // decides whether to hold, so that is where the glow runs away. It runs
      // away in ANTICIPATION, within the tier — never across tiers, which is
      // what DRIFT_BODY_GAIN takes back out. Shell from tier 2 so the brightest
      // sustained shape has a hole in it.
      const g = (0.26 + charge01 * charge01 * 1.20) * body
      const rU = 0.5 + charge01 * 0.7
      this.spawn(
        cx, cy, cz, dX(-0.7, 0, rU), dY(-0.7, 0, rU), dZ(-0.7, 0, rU),
        _dcol[0] * g, _dcol[1] * g, _dcol[2] * g,
        0.16 + charge01 * 0.10, 0.20 + charge01 * 0.24 + tc * 0.030, -0.22,
        0, 2.2, tier >= 2 ? K_SHELL : K_SPRITE,
      )
    }
  }

  /**
   * Thruster strain. A continuous exhaust that thickens with the tier, plus a
   * rhythmic hard pulse out of both nozzles whose cadence runs from about one
   * a second at the bottom of a band to five a second at the top. Rhythm is
   * what makes this survive peripheral vision at 60 m/s — a continuous glow of
   * the same total brightness reads as nothing at all.
   */
  private driftThrusters(
    dt: number, fx: RacerFx, tier: number, tc: number,
    charge01: number, sparkWash: number,
  ): void {
    const q = _bQ
    if (q <= 0) return
    // Nozzle line, in the racer's own frame.
    const nF = -_bHz * 1.04, nU = _bHy * 0.55
    const off = _bHx * 0.52

    // Heavily damped, for exactly the reason the boost plume is: emitted at
    // 8 m/s into a chase camera nine metres back, an undamped cone reaches the
    // lens and erases the vehicle it is supposed to be attached to.
    fx.thrustAcc += dt * (tier < 0 ? 11 : 28 + tc * 26) * (0.45 + charge01 * 1.05) * q
    let guard = 0
    while (fx.thrustAcc >= 1 && guard < 22) {
      fx.thrustAcc -= 1
      guard++
      const s = rnd() < 0.5 ? 1 : -1
      const ex = gX(nF, off * s, nU), ey = gY(nF, off * s, nU), ez = gZ(nF, off * s, nU)
      const g = (0.14 + charge01 * 0.20 + tc * 0.12) * sparkWash
      const sp = 3.5 + rnd() * (4.5 + tc * 3.5)
      const eU = -0.1 + rnd() * 0.7
      this.spawn(
        ex + rnd2() * 0.10, ey + rnd2() * 0.10, ez + rnd2() * 0.10,
        dX(-sp, 0, eU) + rnd2() * 1.1, dY(-sp, 0, eU), dZ(-sp, 0, eU) + rnd2() * 1.1,
        _dcol[0] * g, _dcol[1] * g, _dcol[2] * g,
        0.11 + rnd() * 0.11, 0.085 + tc * 0.028, 0.50, 0.5, 6.0, K_SPRITE,
      )
    }

    if (tier < 0) { fx.strainAcc = 0; return }
    fx.strainAcc += dt * (0.7 + charge01 * 3.4 + tc * 0.55)
    if (fx.strainAcc < 1) return
    fx.strainAcc = 0
    for (let s = -1; s <= 1; s += 2) {
      const ex = gX(nF, off * s, nU), ey = gY(nF, off * s, nU), ez = gZ(nF, off * s, nU)
      this.flash(ex, ey, ez, _dcol, (0.45 + tc * 0.28) * sparkWash, 0.10, 0.26 + tc * 0.15)
      this.burst(
        ex, ey, ez, dX(-1, 0, 0.10), dY(-1, 0, 0.10), dZ(-1, 0, 0.10),
        Math.round((3 + tc * 4) * q), 9 + tc * 5, 0.32,
        _dcol, (0.50 + tc * 0.22) * sparkWash, 0.16, 0.070 + tc * 0.02, K_SPARK, -5, 3.2,
      )
    }
  }

  /**
   * SURFACE SPRAY — the planet coming off the contact patch.
   *
   * One emitter, and everything that makes it snow on Cryostatic and rust grit
   * on Rustfall comes out of the theme's SurfaceSpray: the hue, how much of it
   * there is, whether it hangs in the air or falls out of it, and what fraction
   * of it arrives as hard glinting chips rather than soft bulk. Powder gets
   * positive gravity and heavy drag, so it stalls behind the car and hangs;
   * chips get negative gravity and light drag, so they fly flat and drop. That
   * single pair of numbers is most of the difference between snow and gravel.
   *
   * ESCALATION: rate roughly doubles across the ladder, the throw widens with
   * `inward` and with the tier, and the puffs grow. The COLOUR does not move at
   * all — it is the surface's, not the charge's, and the charge already owns
   * the sparks, the ribbons, the underglow and the thrusters. A tier-3 slide on
   * snow is a bigger cloud of the same snow, which is what a bigger slide on
   * snow actually looks like.
   *
   * `strength` is 1 for a wheel on the ground and the entrainment factor for a
   * skirt hovering over it.
   */
  private driftSpray(
    dt: number, fx: RacerFx, tc: number,
    charge01: number, inward: number, speed: number,
    sp: SurfaceSpray, strength: number,
  ): void {
    const q = _bQ
    if (q <= 0 || strength <= 0.001) return
    // Nothing is torn off a surface by a car that is barely moving, and a
    // stationary spray plume is the tell of an effect keyed to a flag rather
    // than to the world.
    const spd = clamp01((speed - 3) / 22)
    if (spd <= 0.01) return

    const hx = _bHx, hz = _bHz
    const inside = _bSide
    const out = -inside

    const rate = (40 + tc * 34) * (0.45 + charge01 * 0.85) * (0.5 + inward * 0.95)
      * sp.density * spd * strength * q
    // A plume is a thing of a certain SIZE, not of a certain age. Fixed lives
    // made it 14 m long in a slow hairpin and 55 m long on the straight, which
    // is both wrong and the reason the tail of it ended up inside the camera;
    // solving for distance instead keeps it about twenty metres of road behind
    // the car whatever the speed, and the clamp keeps a crawling car from
    // emitting puffs that live for four seconds.
    const lifeK = 20 / (speed < 14 ? 14 : speed)
    fx.sprayAcc += dt * rate
    let guard = 0
    while (fx.sprayAcc >= 1 && guard < 26) {
      fx.sprayAcc -= 1
      guard++
      // 62% off the OUTSIDE wheel, and thrown further outward still. The drift
      // block throws its spark fan to the INSIDE of the arc, so the two streams
      // separate instead of stacking: one wide plume with a hot edge, rather
      // than one muddy ball with everything inside it.
      const side = rnd() < 0.62 ? out : inside
      // Contact patch, in the racer's frame: behind the axle line, out at the
      // wheel, a hand's width off the ROAD -- which on a wall-ride is sideways
      // in world terms, and used to be a stubborn 9cm along world +Y.
      const eF = -hz * 0.90, eS = side * hx * 1.10, eU = 0.09
      const ex = gX(eF, eS, eU), ey = gY(eF, eS, eU), ez = gZ(eF, eS, eU)
      const back = 2.2 + rnd() * (3.4 + inward * 5.4 + tc * 0.8)
      const lat = 0.9 + rnd() * (2.3 + inward * 3.9 + tc * 0.5)
      const up = (0.8 + rnd() * (1.4 + inward * 2.0 + tc * 0.55)) * (1 - sp.weight * 0.45)
      // Thrown back down the road and out of the corner, both in-plane, with
      // the lift along the surface normal.
      const vx = dX(-back, out * lat, 0) + rnd2() * 1.0
      const vy = dY(-back, out * lat, 0)
      const vz = dZ(-back, out * lat, 0) + rnd2() * 1.0

      if (rnd() < sp.grit * (0.65 + charge01 * 0.35)) {
        // A crystal, a stone chip, a fleck of grit. Thin and short-lived, so
        // it is allowed the HDR headroom the bulk is not, and it is the only
        // part of the spray that ever sparkles.
        const g = 0.55 + charge01 * 0.45
        const gu = up * 1.5 + 0.55
        this.spawn(
          ex, ey, ez,
          vx * 1.25 + _bUpX * gu, vy * 1.25 + _bUpY * gu, vz * 1.25 + _bUpZ * gu,
          _spGlint[0] * g, _spGlint[1] * g, _spGlint[2] * g,
          0.20 + rnd() * 0.22, 0.060 + tc * 0.011, 0,
          -4 - sp.weight * 13, 1.9, K_SPARK,
        )
      } else {
        // SIZE AND LIFE ARE BOUNDED BY THE CHASE CAMERA, not by taste. The
        // camera sits nine metres behind the car at 60 m/s, so everything the
        // wheels leave on the road sweeps through the lens about a sixth of a
        // second later, at which age a puff is at its brightest. At a 1.5 m
        // final size that measured as a white disc a third of the frame across
        // passing on the outside of every corner; at 1.0 m, with the smoke
        // kind's own 2.6-9.5 m fade dissolving it as the camera arrives, it is
        // the translucent veil driving through your own spray should be.
        this.spawn(
          ex + rnd2() * 0.16, ey, ez + rnd2() * 0.16,
          vx + _bUpX * up, vy + _bUpY * up, vz + _bUpZ * up,
          _spBulk[0], _spBulk[1], _spBulk[2],
          (0.34 + rnd() * 0.36) * (lifeK > 1.7 ? 1.7 : lifeK < 0.42 ? 0.42 : lifeK),
          0.20 + rnd() * 0.16 + tc * 0.030,
          0.60 + sp.weight * 0.40 + tc * 0.06,
          0.7 - sp.weight * 7.6, 2.3 - sp.weight * 1.1, K_SMOKE,
        )
      }
    }

    // The sheet at the contact patch: a flat disc opening on the road under the
    // sliding wheel, which is what attaches the plume to the ground instead of
    // leaving it floating behind the car. Lying flat, it never stands between
    // the camera and the corner ahead; it is bounded anyway, for the reason
    // given at the call below. Not on the low tier: it is a garnish, and low is
    // where the frame budget is real.
    if (this.lowTier) return
    fx.washAcc += dt * (3.5 + tc * 2.6 + charge01 * 2.0)
    if (fx.washAcc >= 1) {
      fx.washAcc = 0
      const wF = -hz * 0.86, wS = out * hx, wU = 0.03
      // Held small and short deliberately. A ground ring is the one shape that
      // can grow without ever standing between the camera and the corner --
      // but only until it reaches the camera, and at 60 m/s a disc dropped on
      // the road arrives about a seventh of a second later. Attribution on a
      // held tier-3 slide put 80% of that frame's clipped pixels in the
      // particle pool and 5% in the ribbons, so the big near-camera shapes are
      // where the budget actually goes, and this is one of them.
      this.ring(
        gX(wF, wS, wU), gY(wF, wS, wU), gZ(wF, wS, wU), _spBulk, 0.70 * strength, 0.17,
        hx * (0.55 + charge01 * 0.30), 2.2 + tc * 0.8, true,
      )
    }
  }

  /**
   * STRUCK SPARKS — a grounded chassis dragging its floor across the planet.
   *
   * Only ever called for a chassis that is on the ground and only ever as loud
   * as the surface allows: bolted steel plate strikes at full rate, tarmac at
   * a bit over half, an oil slick at almost nothing (which is the one place on
   * Rustfall where a player can watch the sparks stop), and snow at zero. The
   * colour is the SURFACE'S, not the charge's — hot alloy on the junkyard,
   * cold blue-white off sheared ice — because the tier already owns four other
   * channels and "what am I scraping" is worth a channel of its own.
   *
   * ESCALATION: three times the count from tier 0 to tier 3, and each spark is
   * thrown harder, which the vertex shader turns into a longer streak. Per
   * spark the gain is FLAT across the ladder: sparks are thin enough to run at
   * scene-linear 2.3 without costing the frame anything, but only while there
   * is one of them per pixel rather than six.
   */
  private driftScrape(
    dt: number, fx: RacerFx, tc: number,
    charge01: number, inward: number, sp: SurfaceSpray,
  ): void {
    const q = _bQ
    if (q <= 0 || sp.spark <= 0.001) return
    const hx = _bHx, hz = _bHz
    const inside = _bSide
    // Floor-pan height above the ROAD, along the surface normal. A scrape is
    // by definition a thing that happens at the contact patch, so on a wall it
    // has to sit 7cm off the wall, not 7cm above the world.
    const eU = 0.07
    const eF = -hz * 0.92

    const rate = (7 + tc * 15) * (0.40 + charge01 * 1.00) * (0.50 + inward * 1.00)
      * sp.spark * q
    fx.scrapeAcc += dt * rate
    let guard = 0
    while (fx.scrapeAcc >= 1 && guard < 20) {
      fx.scrapeAcc -= 1
      guard++
      const side = rnd() < 0.62 ? inside : -inside
      const eS = side * hx * 1.02
      const ex = gX(eF, eS, eU), ey = gY(eF, eS, eU), ez = gZ(eF, eS, eU)
      const v = 8 + rnd() * (9 + tc * 8)
      const lat = 1.4 + rnd() * (2.8 + inward * 4.8)
      const su = 1.5 + rnd() * (2.1 + tc * 1.1)
      const g = 0.62 + charge01 * 0.40
      this.spawn(
        ex, ey, ez,
        dX(-v, side * lat, su) + rnd2() * 1.6,
        dY(-v, side * lat, su),
        dZ(-v, side * lat, su) + rnd2() * 1.6,
        _spSpark[0] * g, _spSpark[1] * g, _spSpark[2] * g,
        0.28 + rnd() * 0.30, 0.150 + tc * 0.035, 0, -20, 1.35, K_SPARK,
      )
    }

    // THE STRIKE. A rhythm on top of the stream, walking from one contact
    // patch to the other: the floor pan catching, letting go, and catching
    // again. Rhythm is what survives peripheral vision — a stream of the same
    // total energy reads as a texture and nothing else — and the cadence
    // climbing with the tier is a second way to feel the ladder without
    // looking at it. Under reduced motion the beat is stretched and thinned
    // rather than removed: slower, still there, no flicker.
    const beatScale = this.reduced ? 0.45 : 1
    fx.scrapeBeat += dt * (1.3 + tc * 0.75 + charge01 * 1.1) * beatScale
    if (fx.scrapeBeat < 1) return
    fx.scrapeBeat = 0
    fx.scrapeSide = -fx.scrapeSide
    const side = fx.scrapeSide * (inside === 0 ? 1 : inside)
    const bS = side * hx * 1.02
    const ex = gX(eF, bS, eU), ey = gY(eF, bS, eU), ez = gZ(eF, bS, eU)
    const n = Math.round((3 + tc * 3) * q * (this.reduced ? 0.5 : 1))
    this.burst(
      ex, ey, ez, dX(-0.7, 0, 0.30), dY(-0.7, 0, 0.30), dZ(-0.7, 0, 0.30),
      n, 15 + tc * 7, 0.55, _spSpark, 0.72,
      0.34 + tc * 0.04, 0.170 + tc * 0.035, K_SPARK, -22, 1.4,
    )
    // The point of contact itself. A K_SPRITE is a solid gaussian, so this one
    // is held tiny and dim on purpose and only its RADIUS moves with the tier;
    // the last time a drift transition scaled a filled flash with the ladder it
    // erased the car, the road and the horizon for a third of a second.
    this.flash(ex, ey, ez, _spSpark, 0.24, 0.08, 0.150 + tc * 0.055)
  }

  /**
   * DISPLACED AIR — the hover and flight answer to a spark shower.
   *
   * A repulsor skirt a metre off the deck and a flight frame at five never
   * touch the surface, so neither of them may strike anything off it. What
   * they do instead is move a great deal of air: two counter-rotating vortices
   * shed off the rear corners, spiralling and stretching back along the slide.
   * Particles are seeded ON the helix with a tangential velocity — the same
   * trick the drift gather uses to draw a spiral out of a shader that can only
   * integrate a straight line — and the two cores spin in opposite senses, so
   * the pair reads as a wake rather than as two identical puffs.
   *
   * The planet still gets a say. `entrain` is how much of the surface the
   * downwash can lift at the current gap, so a hovercraft skimming Cryostatic
   * drags a rope of snow up into its own vortex and the same machine two
   * metres higher shows bare vapour. That is the surface read for a class that
   * never touches the surface, and it is why this is not simply "no effect".
   */
  private driftAir(
    dt: number, fx: RacerFx, tc: number,
    charge01: number, inward: number,
    sp: SurfaceSpray, entrain: number, lift: number,
  ): void {
    const q = _bQ
    if (q <= 0) return
    const hx = _bHx, hy = _bHy, hz = _bHz
    // Under the hull for a skirt, at the trailing edge for a flight frame --
    // measured along the surface normal, so a hovercraft on a wall sheds its
    // vortices off the wall rather than straight down into it.
    const aU = _bDrop * (0.40 + lift * 0.28) + hy * 0.18

    const rate = (16 + tc * 15) * (0.5 + charge01 * 0.85) * (0.6 + inward * 0.7) * q
    fx.vortexAcc += dt * rate
    let guard = 0
    while (fx.vortexAcc >= 1 && guard < 22) {
      fx.vortexAcc -= 1
      guard++
      const side = rnd() < 0.5 ? 1 : -1
      const cF = -hz * 0.86, cS = side * hx * 0.94
      const cx = gX(cF, cS, aU), cy = gY(cF, cS, aU), cz = gZ(cF, cS, aU)
      const a = rnd() * TAU
      const ca = Math.cos(a), sa = Math.sin(a)
      // Scaled by the chassis, not absolute. Filament's collision box is 0.68 m
      // half-width against Vector-7's 1.85, so a fixed 0.8 m vortex core wraps
      // the bike entirely and merely trails the flight frame — the same effect
      // reading as two different amounts of machine.
      const beam = 0.45 + hx * 0.45
      const rr = (0.20 + rnd() * (0.34 + 0.22 * tc)) * (beam > 1.25 ? 1.25 : beam)
      // Seed on the ring, in the plane spanned by `right` and the SURFACE
      // NORMAL. It was `right` and world up, which are the same plane on level
      // road and perpendicular ones on a wall -- there the vortex core lay flat
      // in the road instead of standing across the wake.
      const sx = cx + dX(0, ca * rr, sa * rr)
      const sy = cy + dY(0, ca * rr, sa * rr)
      const sz = cz + dZ(0, ca * rr, sa * rr)
      // Tangent of that circle, times a spin that reverses with the side.
      const spin = (2.6 + tc * 1.15) * -side
      const back = 3.0 + rnd() * (3.5 + inward * 3.0)
      const vU = ca * spin + 0.35 + lift * 0.4
      const vx = dX(-back, -sa * spin, vU)
      const vy = dY(-back, -sa * spin, vU)
      const vz = dZ(-back, -sa * spin, vU)

      if (rnd() < entrain * 0.62) {
        // Surface material caught in the core and carried up the helix.
        this.spawn(
          sx, sy, sz, vx, vy, vz,
          _spBulk[0], _spBulk[1], _spBulk[2],
          0.38 + rnd() * 0.34, 0.17 + rnd() * 0.13 + tc * 0.024,
          0.62 + tc * 0.06, 0.5 - sp.weight * 5.0, 2.1, K_SMOKE,
        )
      } else {
        // Bare vapour. Thin, fast, and nearly colourless, so the ribbons and
        // the charge stay the only saturated things on the vehicle.
        const g = 0.55 + charge01 * 0.40
        this.spawn(
          sx, sy, sz, vx * 1.15, vy, vz * 1.15,
          AIR_RGB[0] * g, AIR_RGB[1] * g, AIR_RGB[2] * g,
          0.22 + rnd() * 0.20, 0.070 + tc * 0.012, 0, 0, 2.6, K_SPARK,
        )
      }
    }

    // Ground effect: the downwash pressing a ring into whatever is underneath.
    // Only while there IS something underneath — a flight frame at altitude
    // gets nothing, which is the correct amount of dust to raise from 5 m up.
    if (this.lowTier || entrain <= 0.05) return
    fx.airWashAcc += dt * (3.0 + tc * 2.2 + charge01 * 1.8)
    if (fx.airWashAcc >= 1) {
      fx.airWashAcc = 0
      this.ring(
        gX(-hz * 0.5, 0, 0.03), gY(-hz * 0.5, 0, 0.03), gZ(-hz * 0.5, 0, 0.03),
        _spBulk, 1.5 * entrain, 0.34, hx * (1.1 + charge01 * 0.4),
        5.0 + tc * 2.0, true,
      )
    }
  }

  /**
   * Release. Everything the slide gathered is pulled INTO the thrusters over
   * about 90ms and then leaves as the boost plume. The collapse is what makes
   * the boost feel like spending something rather than like a free gift, and
   * it is the visual bookend to the gather: same convergence point, same
   * colour, opposite direction, four times the speed.
   *
   * `col` is the tier colour the caller has already resolved.
   */
  private driftRelease(tier: number, col: Float32Array): void {
    const t = Math.max(0, Math.min(3, tier))
    const q = _bQ
    // Same convergence point as the gather, and for the same reason it is in
    // the racer's frame: the bookend has to land where the wind-up did.
    const cF = -_bHz * 0.62, cU = _bHy * 0.60
    const cx = gX(cF, 0, cU), cy = gY(cF, 0, cU), cz = gZ(cF, 0, cU)

    const n = Math.min(Math.round((14 + t * 12) * q), this.frameBudget - this.spawnCount)
    for (let i = 0; i < n; i++) {
      const a = rnd() * TAU
      const rr = (1.8 + t * 0.8) * (0.7 + rnd() * 0.6)
      const oF = Math.cos(a) * rr, oS = Math.sin(a) * rr, oU = rnd2() * 0.5
      const sx = cx + dX(oF, oS, oU)
      const sy = cy + dY(oF, oS, oU)
      const sz = cz + dZ(oF, oS, oU)
      const life = 0.075 + rnd() * 0.045
      const inv = 1 / life
      this.spawn(
        sx, sy, sz, (cx - sx) * inv, (cy - sy) * inv, (cz - sz) * inv,
        col[0] * 1.5, col[1] * 1.5, col[2] * 1.5,
        life, 0.10 + t * 0.02, 0, 0, 0, K_SPARK,
      )
    }
    // One last ring slamming shut on the thrusters.
    const rl = 0.11
    const r0 = 2.4 + t * 0.9
    this.spawn(
      cx, cy, cz, 0, 0, 0,
      col[0] * 1.2, col[1] * 1.2, col[2] * 1.2,
      rl, r0, -(r0 * 0.95) / rl, 0, 0, K_RING,
    )
    // ...and out of the exhaust one collapse later, aimed down the pipe.
    const bF = cF - _bHz * 0.45
    this.defer(
      0.10, gX(bF, 0, cU), gY(bF, 0, cU), gZ(bF, 0, cU),
      col, D_DRIFT_BLOW, t, dX(-1, 0, 0.10), dY(-1, 0, 0.10), dZ(-1, 0, 0.10),
    )
  }

  // -------------------------------------------------------------------------
  // 2. Pulse Gatling
  // -------------------------------------------------------------------------

  /** Barrels coming up to speed, once, when the budget is handed out. */
  private gatlingSpinUp(fx: RacerFx): void {
    // The whole gatling family used to be written in the 2D basis: a muzzle
    // `_bPy + hy` above the origin and a barrel face in world XZ. On a car
    // rolled onto a wall that puts the muzzle a metre out into the void beside
    // the ribbon and lays the barrel face flat against the sky.
    const mF = _bHz * 0.95, mU = _bHy * 0.58
    const mx = pX(mF, 0, mU)
    const my = pY(mF, 0, mU)
    const mz = pZ(mF, 0, mU)
    fx.gatSpin = 0
    this.flash(mx, my, mz, BEAM_RGB, 1.30, 0.22, 1.5)
    this.ring(mx, my, mz, BEAM_RGB, 1.10, 0.30, 0.30, 9, false)
    const n = Math.min(Math.round(16 * _bQ), this.frameBudget - this.spawnCount)
    for (let i = 0; i < n; i++) {
      // A ring of motes on the barrel FACE — the (right, up) plane — swept in
      // toward the muzzle, so the spin-up reads as a weapon and not as another
      // generic pickup sparkle.
      const a = (i / n) * TAU
      const ca = Math.cos(a), sa = Math.sin(a)
      // The barrel FACE is the (right, up) plane of the car, not of the world.
      const sx = mx + _bRgtX * ca * 1.5 + _bUpX * sa * 1.5
      const sy = my + _bRgtY * ca * 1.5 + _bUpY * sa * 1.5
      const sz = mz + _bRgtZ * ca * 1.5 + _bUpZ * sa * 1.5
      const life = 0.22
      const inv = 1 / life
      this.spawn(
        sx, sy, sz, (mx - sx) * inv, (my - sy) * inv, (mz - sz) * inv,
        BEAM_RGB[0], BEAM_RGB[1], BEAM_RGB[2], life, 0.085, 0, 0, 0, K_SPARK,
      )
    }
  }

  /**
   * One round. Muzzle, recoil ejecta and the tracer.
   *
   * `target` is the racer this shot connected with, resolved by the caller
   * from the beamHit that the sim pushes immediately after the beamFire of the
   * same shot, or null for a miss.
   */
  private gatlingShot(fx: RacerFx, target: RacerState | null): void {
    const q = _bQ
    const P = ITEM_PARAMS.laserGatling
    const mU = _bHy * 0.58
    const mx = pX(_bHz, 0, mU)
    const my = pY(_bHz, 0, mU)
    const mz = pZ(_bHz, 0, mU)

    // ---- rotary muzzle flash ------------------------------------------
    // One detent per shot around the barrel axis. At 14 rounds a second and
    // 2.4 radians a detent the flash walks the muzzle face fast enough to read
    // as a spinning barrel instead of as a light switching on and off.
    fx.gatSpin += 2.399
    if (fx.gatSpin > TAU) fx.gatSpin -= TAU
    const ca = Math.cos(fx.gatSpin), sa = Math.sin(fx.gatSpin)
    const bo = _bHx * 0.34
    this.flash(
      mx + _bRgtX * ca * bo + _bUpX * sa * bo,
      my + _bRgtY * ca * bo + _bUpY * sa * bo,
      mz + _bRgtZ * ca * bo + _bUpZ * sa * bo,
      BEAM_RGB, 1.05, 0.055, 0.60,
    )
    this.flash(mx, my, mz, BEAM_RGB, 0.55, 0.045, 0.34)

    // ---- recoil --------------------------------------------------------
    // The chassis mesh belongs to vehicles.ts, so the shudder is read off the
    // ejecta rather than off the vehicle: hot spent energy thrown DOWN and
    // BACK out of the breech every round, plus a blowback jet from the muzzle
    // vents. At 14Hz that jitter is the recoil.
    const bF = -_bHz * 0.28, bU = -_bHy * 0.30
    this.burst(
      mx + dX(bF, 0, bU), my + dY(bF, 0, bU), mz + dZ(bF, 0, bU),
      dX(-0.6, 0, -0.55), dY(-0.6, 0, -0.55), dZ(-0.6, 0, -0.55),
      Math.round(3 * q) + 1, 7, 0.65, BEAM_RGB, 0.70, 0.24, 0.065, K_SPARK, -16, 2.6,
    )
    for (let s = -1; s <= 1; s += 2) {
      this.spawn(
        mx + _bRgtX * bo * s, my + _bRgtY * bo * s, mz + _bRgtZ * bo * s,
        dX(-1.5, s * 5.5, 0.6), dY(-1.5, s * 5.5, 0.6), dZ(-1.5, s * 5.5, 0.6),
        BEAM_RGB[0] * 0.30, BEAM_RGB[1] * 0.30, BEAM_RGB[2] * 0.30,
        0.10, 0.11, 0.9, 0, 7.0, K_SPRITE,
      )
    }

    // ---- tracer --------------------------------------------------------
    // Hitscan: the round is already there. So this is a short-lived streak
    // along the ray, not a projectile with a flight time. Every term is
    // jittered per shot — length, segment count, gain, lateral wander — so a
    // three-second burst reads as forty-two rounds rather than as one static
    // line drawn forty-two times.
    let ex: number, ey: number, ez: number
    if (target !== null) {
      // Lifted along the TARGET's up, not the shooter's and not the world's:
      // two cars on opposite walls of a corkscrew disagree about which way is
      // up, and the tracer has to end on the car it actually hit.
      const tu = this.gravity ? target.up : UP_Y
      ex = target.pos.x + tu.x * 0.35
      ey = target.pos.y + tu.y * 0.35
      ez = target.pos.z + tu.z * 0.35
    } else {
      const reach = P.range * (0.45 + rnd() * 0.55)
      const spread = Math.tan(P.cone) * reach * rnd2() * 0.8
      const rise = rnd2() * 0.6
      ex = mx + dX(reach, spread, rise)
      ey = my + dY(reach, spread, rise)
      ez = mz + dZ(reach, spread, rise)
    }
    let dx = ex - mx, dy = ey - my, dz = ez - mz
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (len < 1e-3) return
    dx /= len; dy /= len; dz /= len

    // One dash every ~7m, capped so a 130m miss cannot eat the frame budget.
    const segs = Math.max(2, Math.min(Math.round(len / 7), Math.round(14 * q) + 2))
    const step = len / segs
    const jitter = 0.05 + rnd() * 0.10
    const gain = 1.5 + rnd() * 0.9
    for (let i = 0; i < segs; i++) {
      const d = (i + rnd() * 0.7) * step
      // Wander perpendicular to the RAY, in the car's own (right, up) plane.
      const js = rnd2() * jitter, ju = rnd2() * jitter
      this.spawn(
        mx + dx * d + dX(0, js, ju),
        my + dy * d + dY(0, js, ju),
        mz + dz * d + dZ(0, js, ju),
        dx * 120, dy * 120, dz * 120,
        BEAM_RGB[0] * gain, BEAM_RGB[1] * gain, BEAM_RGB[2] * gain,
        0.045 + rnd() * 0.035, 0.055 + rnd() * 0.030, 0, 0, 0, K_SPARK,
      )
    }

    // Weapon-hot screen tension for the shooter. Deliberately tiny: this is
    // driven at 14Hz and boostIntensity also drives the composite's forward
    // zoom, so anything larger strobes the entire frame for three seconds.
    if (_bLocal) this.boostIntensity = Math.max(this.boostIntensity, 0.11)
  }

  /**
   * A round connecting, drawn ON THE TARGET. Called from inside the SHOOTER's
   * event loop, so the module basis still describes the shooter — which is
   * exactly what is wanted for spraying the impact back down the line of fire.
   */
  private gatlingImpact(t: RacerState, lethal: boolean): void {
    const chassis = CHASSIS_BY_ID[t.chassisId]
    const hy = chassis ? chassis.halfExtents.y : 0.6
    const hz = chassis ? chassis.halfExtents.z : 2.3
    // The VICTIM's up, not the shooter's: this is the one helper in the family
    // that draws on a car other than the one updateRacer is describing, and on
    // a corkscrew the two cars do not share an up. The spawn axis moves with
    // it, so the ground front lands on the victim's deck, and is put back
    // before returning -- the caller is mid-way through the shooter's frame.
    const tu = this.gravity ? t.up : UP_Y
    setAxis(tu.x, tu.y, tu.z)
    const px = t.pos.x + tu.x * hy * 0.8
    const py = t.pos.y + tu.y * hy * 0.8
    const pz = t.pos.z + tu.z * hy * 0.8
    const q = this.qScale
    // Sprayed back down the SHOOTER's line of fire, lifted along the victim's
    // own up: two frames, and each term belongs to the one it came from.
    const bx = -_bFwdX + tu.x * 0.35
    const by = -_bFwdY + tu.y * 0.35
    const bz = -_bFwdZ + tu.z * 0.35

    if (!lethal) {
      this.burst(px, py, pz, bx, by, bz, Math.round(5 * q) + 2, 11, 0.75, BEAM_RGB, 0.85, 0.20, 0.075, K_SPARK, -13, 2.4)
      this.flash(px, py, pz, BEAM_RGB, 0.85, 0.075, 0.55)
      // Hit marker: a small hard ring that snaps open and dies inside an
      // eighth of a second, so the shooter can tell a connecting burst from a
      // missing one at a hundred metres without any HUD.
      this.ring(px, py, pz, BEAM_HOT, 0.90, 0.11, 0.30, 9, false)
      setAxis(_bUpX, _bUpY, _bUpZ)
      return
    }

    // THE BREAKING SHOT. An order of magnitude more of everything: this is the
    // payoff for three seconds of tracking, and the moment the victim loses a
    // position. The sim also pushes a plain `hit` on the victim, which layers
    // the item-coloured impact underneath this.
    const drop = t.altitude < 0 ? 0 : Math.min(t.altitude, hy * 1.6 + 0.35)
    this.flash(px, py, pz, BEAM_HOT, 1.35, 0.30, 1.9)
    this.spawn(
      px, py, pz, 0, 0, 0,
      BEAM_HOT[0] * 0.55, BEAM_HOT[1] * 0.55, BEAM_HOT[2] * 0.55,
      0.46, hz * 0.9, 7.5, 0, 0, K_SHELL,
    )
    this.ring(px, py, pz, BEAM_RGB, 1.05, 0.44, 0.8, 26, false)
    // The ground front sits on the deck UNDER the victim: its origin dropped
    // by its own altitude along its own up, which on a wall is sideways.
    const gd = 0.06 - drop
    this.ring(
      t.pos.x + tu.x * gd, t.pos.y + tu.y * gd, t.pos.z + tu.z * gd,
      BEAM_RGB, 0.85, 0.55, 1.0, 22, true,
    )
    this.burst(px, py, pz, tu.x * 0.25, tu.y * 0.25, tu.z * 0.25, Math.round(56 * q), 26, 1.0, BEAM_RGB, 1.10, 0.55, 0.15, K_SPARK, -12, 1.3)
    this.burst(px, py, pz, tu.x * 0.35, tu.y * 0.35, tu.z * 0.35, Math.round(18 * q), 5, 1.0, SMOKE_RGB, 1.5, 1.1, 0.9, K_SMOKE, 1.2, 1.0)
    this.claimLight(px, py, pz, BEAM_RGB, 9, 0.34)
    setAxis(_bUpX, _bUpY, _bUpZ)
  }

  /**
   * Continuous gatling state for one racer: the shooter's running barrels, and
   * — much more importantly — the VICTIM's overload build-up.
   *
   * beamCharge climbs by 1/fireRate per connecting round and bleeds off at
   * `decay` per second the instant the beam leaves. That asymmetry is the
   * entire counterplay, so the read has to (a) be legible from across the
   * track and (b) visibly COOL when line of sight breaks. Without (b) the
   * player has no way to learn that breaking line of sight worked.
   */
  private gatlingState(dt: number, r: RacerState, fx: RacerFx): void {
    const q = _bQ
    const P = ITEM_PARAMS.laserGatling
    const mU = _bHy * 0.58
    const mx = pX(_bHz, 0, mU)
    const my = pY(_bHz, 0, mU)
    const mz = pZ(_bHz, 0, mU)

    if (r.gatlingTime > 0) {
      fx.gatIdle += dt * 26 * q
      let g = 0
      while (fx.gatIdle >= 1 && g < 8) {
        fx.gatIdle -= 1
        g++
        const vu = 0.5 + rnd() * 0.6
        this.spawn(
          mx + rnd2() * 0.14, my + rnd2() * 0.14, mz + rnd2() * 0.14,
          -_bFwdX * 0.8 + _bUpX * vu + rnd2() * 0.8,
          -_bFwdY * 0.8 + _bUpY * vu,
          -_bFwdZ * 0.8 + _bUpZ * vu + rnd2() * 0.8,
          BEAM_RGB[0] * 0.30, BEAM_RGB[1] * 0.30, BEAM_RGB[2] * 0.30,
          0.22, 0.12, 0.55, 0.3, 3.0, K_SPRITE,
        )
      }
    } else if (fx.prevGatling > 0) {
      // Spin-down: the barrels vent whatever is left.
      this.burst(mx, my, mz, _bUpX * 0.5, _bUpY * 0.5, _bUpZ * 0.5, Math.round(10 * q), 4, 1.0, SMOKE_RGB, 1.6, 0.75, 0.30, K_SMOKE, 0.9, 1.4)
      this.flash(mx, my, mz, BEAM_RGB, 0.60, 0.16, 0.7)
      fx.gatIdle = 0
    }
    fx.prevGatling = r.gatlingTime

    const bc = r.beamCharge
    if (bc <= 0.001) {
      fx.beamAcc = 0
      fx.beamRing = 0
      fx.prevBeam = 0
      return
    }
    const bc01 = clamp01(bc / P.breakAt)
    const cooling = bc < fx.prevBeam - 1e-6
    fx.prevBeam = bc

    // Green at the start, white-hot at the threshold. The hue shift is what
    // carries at distance; the particle count is what carries up close.
    const mixw = bc01 * bc01
    _dcol2[0] = BEAM_RGB[0] + (BEAM_HOT[0] - BEAM_RGB[0]) * mixw
    _dcol2[1] = BEAM_RGB[1] + (BEAM_HOT[1] - BEAM_RGB[1]) * mixw
    _dcol2[2] = BEAM_RGB[2] + (BEAM_HOT[2] - BEAM_RGB[2]) * mixw
    const cool = cooling ? 0.35 : 1.0

    // 1. OVERLOAD SHELL. A punched-core annulus wrapped around the chassis on
    //    a heartbeat that runs from twice a second to nine times. It is a
    //    SILHOUETTE, not a spray, which is why it still reads at fifty metres
    //    with three other racers in front of it.
    fx.beamRing += dt * (2.0 + bc01 * 7.5) * cool
    if (fx.beamRing >= 1) {
      fx.beamRing = 0
      const g = (0.30 + bc01 * 0.85) * cool
      this.spawn(
        pX(0, 0, _bHy * 0.5), pY(0, 0, _bHy * 0.5), pZ(0, 0, _bHy * 0.5), 0, 0, 0,
        _dcol2[0] * g, _dcol2[1] * g, _dcol2[2] * g,
        0.20 + bc01 * 0.10, _bHz * (0.95 + bc01 * 0.35), 1.4 + bc01 * 3.0,
        0, 0, K_SHELL,
      )
    }

    // 2. CRACKLING ARCS skittering over the hull. Quadratic in the charge, so
    //    at the threshold the machine looks like it is coming apart.
    fx.beamAcc += dt * (7 + bc01 * bc01 * 62) * q * cool
    let guard = 0
    while (fx.beamAcc >= 1 && guard < 18) {
      fx.beamAcc -= 1
      guard++
      const a = rnd() * TAU
      const ca = Math.cos(a), sa = Math.sin(a)
      const rr = _bHx * (1.0 + rnd() * 0.5)
      // Arcs skitter over the HULL, so they are seeded in the hull's own
      // frame: around its right axis, along its length, off its own up.
      const aF = -rnd2() * _bHz * 0.8
      const aU = rnd2() * _bHy * 1.3
      const sx = pX(aF, ca * rr, aU)
      const sy = pY(aF, ca * rr, aU)
      const sz = pZ(aF, ca * rr, aU)
      const g = 0.9 + bc01 * 1.0
      this.spawn(
        sx, sy, sz,
        -_bRgtX * sa * 5.0 + _bUpX * sa * 3.0 + rnd2() * 1.5,
        -_bRgtY * sa * 5.0 + _bUpY * sa * 3.0 + rnd2() * 1.5,
        -_bRgtZ * sa * 5.0 + _bUpZ * sa * 3.0 + rnd2() * 1.5,
        _dcol2[0] * g, _dcol2[1] * g, _dcol2[2] * g,
        0.06 + rnd() * 0.09, 0.055 + bc01 * 0.045, 0, 0, 1.2, K_SPARK,
      )
    }

    // 3. THE LAST QUARTER. Past 75% the overload gets its own light and a hard
    //    strobing core — the "break line of sight NOW" window has to not look
    //    like more of the same ramp.
    if (bc01 > 0.75 && !cooling) {
      if (rnd() < 14 * dt) {
        this.flash(
          pX(0, 0, _bHy * 0.6), pY(0, 0, _bHy * 0.6), pZ(0, 0, _bHy * 0.6),
          BEAM_HOT, 0.55 + bc01 * 0.6, 0.09, 0.5 + bc01 * 0.6,
        )
      }
      this.claimLight(pX(0, 0, _bHy), pY(0, 0, _bHy), pZ(0, 0, _bHy), BEAM_HOT, 1.4 + bc01 * 2.0, 0.10)
    }
    // The local victim gets it on the screen too — static and a cool cast via
    // the composite — capped under 0.4 so it never crosses main.ts's
    // camera-shake threshold. A permanent shake while being tracked would be
    // unplayable, and being unable to steer is not counterplay.
    if (_bLocal) this.hitFlash = Math.max(this.hitFlash, bc01 * 0.38 * cool)
  }

  // -------------------------------------------------------------------------
  // 3. Booster ramp
  // -------------------------------------------------------------------------

  /** The launch. `power` is the sim's vertical impulse, 24..34 in track data. */
  private rampLaunch(fx: RacerFx, power: number): void {
    const p01 = clamp01((power - 24) / 10)
    fx.rampAir = 1
    fx.rampPower = p01
    fx.rampAcc = 0
    fx.rampBead = 0

    const q = _bQ
    const px = _bGx, py = _bGy, pz = _bGz

    // 1. GROUND SHOCK at the launch point, with a second front deferred so the
    //    kick occupies time rather than a single frame. Anchored on the CONTACT
    //    POINT, so the shock lands on the deck the car is leaving whichever way
    //    that deck faces.
    this.shockRing(gX(0, 0, 0.05), gY(0, 0, 0.05), gZ(0, 0, 0.05),
      RAMP_RGB, 1.10 + p01 * 0.45, 0.42 + p01 * 0.12, 1.2, 10 + p01 * 6, true)
    this.shockRing(gX(0, 0, 0.08), gY(0, 0, 0.08), gZ(0, 0, 0.08),
      WHITE_RGB, 0.60 + p01 * 0.25, 0.28, 0.6, 5.0 + p01 * 3.0, true)
    this.defer(0.09, px, py, pz, RAMP_RGB, D_RAMP_KICK, p01)

    // 2. A BURST OF LIGHT ALONG THE ROAD'S OWN UP. K_BEAM is a column drawn
    //    along the particle's `aAxis`, which updateRacer has already set to
    //    the racer's up -- precisely the shape of "the deck just threw you off
    //    it", whichever way that deck faces. Plus a fountain under the same
    //    axis that arcs back onto the road and keeps marking the lip for as
    //    long as the vehicle is in the air.
    const bg = 1.1 + p01 * 0.5
    this.spawn(
      px, py, pz, 0, 0, 0,
      RAMP_RGB[0] * bg, RAMP_RGB[1] * bg, RAMP_RGB[2] * bg,
      0.42 + p01 * 0.14, 1.1 + p01 * 0.8, -1.0, 0, 0, K_BEAM,
    )
    // Same no-occlusion rule as the drift tier-up: the column and the ground
    // fronts carry the scale, the flash only marks the instant. At the old
    // 2.3m a max-power launch put a filled white disc over the lip just as the
    // player needed to see where they were being thrown.
    const fU = 1.6 + p01 * 1.2
    this.flash(gX(0, 0, fU), gY(0, 0, fU), gZ(0, 0, fU),
      WHITE_RGB, 0.80 + p01 * 0.45, 0.20, 0.60 + p01 * 0.35)
    this.burst(
      gX(0, 0, 0.25), gY(0, 0, 0.25), gZ(0, 0, 0.25), _bUpX, _bUpY, _bUpZ,
      Math.round((16 + p01 * 22) * q), 12 + p01 * 12, 0.42,
      RAMP_RGB, 1.05, 0.70 + p01 * 0.35, 0.13, K_SPARK, -16, 0.5,
    )

    // 3. THRUSTER FLARE: both nozzles fire down and back off the lip.
    const nF = -_bHz * 1.02
    const off = _bHx * 0.52
    const nU = _bHy * 0.6
    for (let s = -1; s <= 1; s += 2) {
      const ex = gX(nF, off * s, nU), ey = gY(nF, off * s, nU), ez = gZ(nF, off * s, nU)
      this.flash(ex, ey, ez, RAMP_RGB, 1.0 + p01 * 0.5, 0.14, 0.5 + p01 * 0.4)
      this.burst(
        ex, ey, ez, dX(-0.5, 0, -0.75), dY(-0.5, 0, -0.75), dZ(-0.5, 0, -0.75),
        Math.round((7 + p01 * 8) * q), 13 + p01 * 9, 0.40,
        RAMP_RGB, 0.75, 0.24, 0.11, K_SPARK, -8, 2.6,
      )
    }

    this.claimLight(gX(0, 0, 1.5), gY(0, 0, 1.5), gZ(0, 0, 1.5), RAMP_RGB, 4 + p01 * 5, 0.26)
    if (_bLocal) this.boostIntensity = Math.max(this.boostIntensity, 0.34 + p01 * 0.30)
  }

  /** The flight. Afterburn out of the tail plus beads marking the arc. */
  private rampAfterburn(dt: number, fx: RacerFx, r: RacerState): void {
    const q = _bQ
    if (q <= 0) return
    const p01 = fx.rampPower
    const eF = -_bHz * 1.06, eU = _bHy * 0.30
    const ex = pX(eF, 0, eU), ey = pY(eF, 0, eU), ez = pZ(eF, 0, eU)

    fx.rampAcc += dt * (40 + p01 * 55) * q
    let guard = 0
    while (fx.rampAcc >= 1 && guard < 16) {
      fx.rampAcc -= 1
      guard++
      const g = 0.26 + p01 * 0.24
      this.spawn(
        ex + rnd2() * _bHx * 0.5, ey + rnd2() * 0.16, ez + rnd2() * _bHx * 0.5,
        dX(-(4 + rnd() * 7), 0, -0.3 + rnd() * 0.8) + rnd2() * 1.8,
        dY(-(4 + rnd() * 7), 0, -0.3 + rnd() * 0.8),
        dZ(-(4 + rnd() * 7), 0, -0.3 + rnd() * 0.8) + rnd2() * 1.8,
        RAMP_RGB[0] * g, RAMP_RGB[1] * g, RAMP_RGB[2] * g,
        0.16 + rnd() * 0.12, 0.11 + p01 * 0.06, 0.55, 0.3, 6.0, K_SPRITE,
      )
      if (rnd() < 0.30) {
        this.spawn(
          ex, ey, ez,
          dX(-(9 + rnd() * 13), 0, 0.6 + rnd() * 1.6) + rnd2() * 2.5,
          dY(-(9 + rnd() * 13), 0, 0.6 + rnd() * 1.6),
          dZ(-(9 + rnd() * 13), 0, 0.6 + rnd() * 1.6) + rnd2() * 2.5,
          RAMP_RGB[0] * 0.55, RAMP_RGB[1] * 0.55, RAMP_RGB[2] * 0.55,
          0.20, 0.080, 0, -6, 3.0, K_SPARK,
        )
      }
    }

    // BEADS. The tail plume is damped to death within a metre of the exhaust
    // by design, so it cannot draw an arc. These do: a ring dropped on the
    // flight path several times a second and left behind in world space, which
    // is a dotted contrail still legible from the far side of the track.
    fx.rampBead += dt * (7 + p01 * 5)
    if (fx.rampBead >= 1) {
      fx.rampBead = 0
      this.ring(_bPx, _bPy, _bPz, RAMP_RGB, 0.55 + p01 * 0.35, 0.55, 0.35, 2.2, false)
      this.flash(_bPx, _bPy, _bPz, RAMP_RGB, 0.30 + p01 * 0.25, 0.45, 0.35)
    }
    // Past the trick threshold the arc goes white-hot — the cue that a clean
    // landing is about to pay a boost.
    if (r.airTime > TUNING.ramp.trickMinAir && rnd() < 6 * dt) {
      this.flash(pX(0, 0, _bHy), pY(0, 0, _bHy), pZ(0, 0, _bHy), WHITE_RGB, 0.55, 0.18, 0.6)
    }
  }

  /** Picks the plume colour for whatever is currently boosting this racer. */
  private boostColorOf(r: RacerState, out: Float32Array): void {
    let src: Float32Array
    switch (r.boostSource) {
      case 'pad': src = PAD_RGB; break
      case 'slipstream': src = SLIP_RGB; break
      case 'item': src = r.invincibleTime > 0 ? ITEM_RGB.overdriveCore : NITRO_RGB; break
      case 'start': src = WHITE_RGB; break
      default: {
        // Drift / trick: infer the tier from the magnitude so the plume keeps
        // the colour of the tier that produced it.
        const tb = TUNING.drift.tierBoost
        let tier = 0
        for (let i = 3; i >= 0; i--) {
          if (r.boostMag >= tb[i] - 0.02) { tier = i; break }
        }
        const ti = tier * 3
        out[0] = DRIFT_RGB[ti]; out[1] = DRIFT_RGB[ti + 1]; out[2] = DRIFT_RGB[ti + 2]
        return
      }
    }
    out[0] = src[0]; out[1] = src[1]; out[2] = src[2]
  }

  /** Boost activation: plume kick + ring shockwave, escalating hard by tier. */
  private boostBurst(
    r: RacerState, fx: RacerFx, tierRaw: number,
    hz: number, hy: number, q: number, isLocal: boolean,
  ): void {
    const tier = Math.max(0, Math.min(3, tierRaw))
    const ti = tier * 3
    _rgb[0] = DRIFT_RGB[ti]; _rgb[1] = DRIFT_RGB[ti + 1]; _rgb[2] = DRIFT_RGB[ti + 2]
    // The whole plume in the car's own frame. The exhaust is a metre behind
    // the NOSE and a third of a metre off the DECK, and on a wall-ride neither
    // of those is a world axis -- the plume used to fire out of the side of
    // the car and the ground fronts used to stand on their edge.
    const eF = -hz * 1.08
    const ex = gX(eF, 0, 0.35), ey = gY(eF, 0, 0.35), ez = gZ(eF, 0, 0.35)

    // A drift boost has a gathered ring to spend, so it opens with the
    // collapse. A trick boost pushes the same event without ever having
    // gathered anything, and a pad or nitro never reaches this function at
    // all — hence the source test rather than a blanket call.
    if (r.boostSource === 'drift') this.driftRelease(tier, _rgb)
    // Firing the boost ends the drift, so the tier wash has nothing left to
    // recolour; drop it rather than letting it bleed onto the plume.
    fx.tierFlash = 0

    // Same no-occlusion budget as the tier-up. Cashing a tier-3 drift in used
    // to blow out a third of the centre of the frame — worse than the tier-up
    // did — from one 3.6m filled flash plus two rings whose growth*life
    // reached a quad size of 36 (a 13.7m radius drawn across the sky). The
    // fronts are bounded and annular, the flash is small, and the gains are
    // normalised so tier 3 is not four times brighter than tier 0 purely
    // because its colour is.
    const front = DRIFT_BODY_GAIN[tier]
    this.shockRing(pX(0, 0, 0.35), pY(0, 0, 0.35), pZ(0, 0, 0.35), _rgb, (0.48 + tier * 0.14) * front, 0.34 + tier * 0.06, 0.9, 4.0 + tier * 1.8, false)
    this.shockRing(gX(0, 0, 0.06), gY(0, 0, 0.06), gZ(0, 0, 0.06), _rgb, (0.36 + tier * 0.12) * front, 0.42 + tier * 0.06, 1.2, 7.0 + tier * 3.3, true)
    this.flash(pX(0, 0, hy), pY(0, 0, hy), pZ(0, 0, hy), _rgb, (0.55 + tier * 0.22) * front, 0.20 + tier * 0.05, 0.55 + tier * 0.22)
    this.burst(
      ex, ey, ez, dX(-1, 0, 0.25), dY(-1, 0, 0.25), dZ(-1, 0, 0.25),
      Math.round((16 + tier * 24) * q), 16 + tier * 12, 0.55,
      _rgb, 0.42, 0.36 + tier * 0.08, 0.14 + tier * 0.04, K_SPARK, -6, 1.8,
    )
    // Soft body behind the exhaust. These are filled sprites reaching ~0.9m
    // each, thirty of them, a metre from a camera that sits nine metres back —
    // so they are held to the same budget: fewer pixels, more sparks.
    this.burst(
      ex, ey, ez, dX(-1, 0, 0.3), dY(-1, 0, 0.3), dZ(-1, 0, 0.3),
      Math.round((6 + tier * 8) * q), 7 + tier * 5, 0.8,
      _rgb, 0.17 * front, 0.55, 0.38 + tier * 0.07, K_SPRITE, 0.4, 2.4,
    )

    if (tier >= 2) this.claimLight(pX(0, 0, 0.8), pY(0, 0, 0.8), pZ(0, 0, 0.8), _rgb, 3.0 + tier * 2, 0.28)

    if (tier >= 3) {
      // Singularity. White-hot core, dark lensed rim, brief space distortion.
      // Placed AHEAD of the vehicle: a flash centred on the car is, from a
      // chase camera nine metres behind it, a white card over the one thing
      // the player is steering. Ahead, the car silhouettes against it and the
      // road stays readable.
      const sF = hz * 1.6
      const sx = pX(sF, 0, hy), sy = pY(sF, 0, hy), sz = pZ(sF, 0, hy)
      const bx = pX(0, 0, hy), by = pY(0, 0, hy), bz = pZ(0, 0, hy)
      this.flash(sx, sy, sz, WHITE_RGB, 0.70, 0.24, 0.85)
      this.shockShell(sx, sy, sz, WHITE_RGB, 0.78, 0.42, 1.6, 5.2)
      this.shockShell(sx, sy, sz, WHITE_RGB, 0.60, 0.62, 2.6, 8.4)
      this.shockRing(gX(0, 0, 0.08), gY(0, 0, 0.08), gZ(0, 0, 0.08), WHITE_RGB, 0.90, 0.62, 1.4, 13.0, true)
      this.spawnDistortion(bx, by, bz, 2.2, 12.0, 0.55)
      this.burst(bx, by, bz, _bUpX * 0.1, _bUpY * 0.1, _bUpZ * 0.1, Math.round(40 * q), 26, 1.0, WHITE_RGB, 0.55, 0.42, 0.15, K_SPARK, -10, 1.4)
      if (isLocal) this.boostIntensity = 1.0
    } else if (isLocal) {
      this.boostIntensity = Math.max(this.boostIntensity, 0.45 + tier * 0.18)
    }
  }

  /**
   * Per-item impact signature.
   *
   * Every one of these can land on the LOCAL racer, which is nine metres from
   * the camera and dead centre of frame — so a flash sized for a spectacular
   * third-person explosion is, from the receiving end, a full-screen white
   * card. That is how the alpha missile and the EMP ended up looking
   * identical: both erased the frame, and the colour that identifies the item
   * was the first thing to go. Sizes and screen-shake are dialled to keep the
   * coloured core readable against the world instead.
   */
  private impact(
    item: ItemId, hy: number, q: number, isLocal: boolean,
  ): void {
    // Roof height along the CAR's up, and every cone bias along it too. `hy`
    // above the origin in world +Y is inside the road on a wall, and the
    // racer's frame is already published by updateRacer, so the fwd/right
    // parameters this used to take were a second, flattened copy of it.
    const px = pX(0, 0, hy), py = pY(0, 0, hy), pz = pZ(0, 0, hy)
    const col = ITEM_RGB[item]

    switch (item) {
      case 'railMissile': {
        // Sharp yellow spark cone, thrown forward along the shot's travel.
        this.flash(px, py, pz, col, 1.4, 0.16, 1.1)
        this.burst(px, py, pz, dX(1, 0, 0.18), dY(1, 0, 0.18), dZ(1, 0, 0.18), Math.round(50 * q), 34, 0.32, col, 1.10, 0.30, 0.13, K_SPARK, -14, 1.6)
        this.burst(px, py, pz, dX(1, 0, 0.1), dY(1, 0, 0.1), dZ(1, 0, 0.1), Math.round(10 * q), 12, 0.9, col, 0.60, 0.5, 0.20, K_SPRITE, -2, 2.4)
        this.ring(px, py, pz, col, 1.1, 0.26, 0.5, 22, false)
        this.claimLight(px, py, pz, col, 5, 0.18)
        if (isLocal) this.hitFlash = Math.max(this.hitFlash, 0.34)
        break
      }
      case 'seekerMissile': {
        // Orange explosion: fireball plus fast debris.
        this.flash(px, py, pz, col, 1.5, 0.30, 1.6)
        this.burst(px, py, pz, _bUpX * 0.25, _bUpY * 0.25, _bUpZ * 0.25, Math.round(16 * q), 7, 1.0, col, 0.75, 0.62, 0.62, K_SPRITE, 1.6, 1.5)
        this.burst(px, py, pz, _bUpX * 0.2, _bUpY * 0.2, _bUpZ * 0.2, Math.round(44 * q), 22, 1.0, col, 1.15, 0.42, 0.14, K_SPARK, -12, 1.5)
        this.burst(px, py, pz, _bUpX * 0.4, _bUpY * 0.4, _bUpZ * 0.4, Math.round(16 * q), 4, 1.0, SMOKE_RGB, 1.4, 1.1, 0.9, K_SMOKE, 1.2, 1.0)
        this.ring(px, py, pz, col, 1.15, 0.42, 0.7, 26, false)
        this.claimLight(px, py, pz, col, 7, 0.3)
        if (isLocal) this.hitFlash = Math.max(this.hitFlash, 0.42)
        break
      }
      case 'alphaMissile': {
        // Big red shockwave with a lingering second ring.
        this.flash(px, py, pz, col, 1.7, 0.42, 2.0)
        this.spawn(px, py, pz, 0, 0, 0, 1.5, 0.38, 0.55, 0.55, 2.0, 8.0, 0, 0, K_SHELL)
        this.ring(px, py, pz, col, 1.25, 0.55, 1.0, 34, false)
        this.ring(pX(0, 0, 0.06), pY(0, 0, 0.06), pZ(0, 0, 0.06), col, 1.05, 0.75, 1.2, 30, true)
        this.burst(px, py, pz, _bUpX * 0.25, _bUpY * 0.25, _bUpZ * 0.25, Math.round(78 * q), 34, 1.0, col, 1.20, 0.65, 0.18, K_SPARK, -14, 1.1)
        this.burst(px, py, pz, _bUpX * 0.35, _bUpY * 0.35, _bUpZ * 0.35, Math.round(30 * q), 6, 1.0, SMOKE_RGB, 1.6, 1.5, 1.2, K_SMOKE, 1.4, 0.9)
        this.spawnDistortion(px, py, pz, 3.0, 11.0, 0.42)
        this.defer(0.22, px, py, pz, col, D_ALPHA_RING, 1.0)
        this.defer(0.48, px, py, pz, col, D_ALPHA_RING, 1.6)
        this.claimLight(px, py, pz, col, 12, 0.45)
        if (isLocal) this.hitFlash = 0.55
        break
      }
      case 'voidMine': {
        // Implosion first, then the burst.
        this.implode(px, py, pz, col, Math.round(34 * q), 0.30)
        this.spawn(px, py, pz, 0, 0, 0, col[0] * 2.0, col[1] * 2.0, col[2] * 2.0, 0.32, 3.0, -7.0, 0, 0, K_RING)
        this.defer(0.30, px, py, pz, col, D_VOID_BURST, q)
        if (isLocal) this.hitFlash = Math.max(this.hitFlash, 0.48)
        break
      }
      case 'empBomb': {
        // Blue wireframe sphere plus a full-screen static spike.
        this.spawnEmp(px, py, pz, 34, 0.85)
        this.flash(px, py, pz, EMP_RGB, 1.4, 0.32, 1.8)
        this.burst(px, py, pz, _bUpX * 0.2, _bUpY * 0.2, _bUpZ * 0.2, Math.round(46 * q), 16, 1.0, EMP_RGB, 1.20, 0.55, 0.14, K_SPARK, -4, 1.4)
        this.defer(0.16, px, py, pz, EMP_RGB, D_EMP_PULSE, 1.0)
        this.claimLight(px, py, pz, EMP_RGB, 9, 0.4)
        if (isLocal) this.hitFlash = 0.58
        break
      }
      case 'overdriveCore': {
        // Contact damage: golden flash.
        this.flash(px, py, pz, col, 1.7, 0.34, 2.1)
        this.ring(px, py, pz, col, 1.2, 0.42, 0.8, 32, false)
        this.burst(px, py, pz, _bUpX * 0.3, _bUpY * 0.3, _bUpZ * 0.3, Math.round(50 * q), 24, 1.0, col, 1.2, 0.5, 0.16, K_SPARK, -10, 1.4)
        this.claimLight(px, py, pz, col, 10, 0.35)
        if (isLocal) this.hitFlash = Math.max(this.hitFlash, 0.5)
        break
      }
      case 'gravityWell': {
        this.implode(px, py, pz, WELL_RGB, Math.round(18 * q), 0.45)
        this.ring(px, py, pz, WELL_RGB, 1.8, 0.5, 2.2, -3.0, false)
        if (isLocal) this.hitFlash = Math.max(this.hitFlash, 0.28)
        break
      }
      default: {
        this.flash(px, py, pz, col, 1.3, 0.24, 1.5)
        this.burst(px, py, pz, _bUpX * 0.25, _bUpY * 0.25, _bUpZ * 0.25, Math.round(24 * q), 14, 1.0, col, 1.0, 0.4, 0.14, K_SPARK, -10, 1.6)
        if (isLocal) this.hitFlash = Math.max(this.hitFlash, 0.34)
      }
    }
  }

  /** Particles seeded on a shell, travelling inward — the implosion phase. */
  private implode(x: number, y: number, z: number, col: Float32Array, count: number, life: number): void {
    const n = Math.min(count, this.frameBudget - this.spawnCount)
    const inv = 1 / life
    for (let i = 0; i < n; i++) {
      let ux = rnd2(), uy = rnd2(), uz = rnd2()
      const l = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1
      ux /= l; uy /= l; uz /= l
      const rad = 3.2 + rnd() * 2.4
      // A shell squashed to 0.6 ALONG THE SURFACE AXIS, so an implosion on a
      // wall is a disc lying on the wall rather than one standing on it.
      // Squashing along world +Y is exactly `u * rad - up * (u . up) * rad *
      // 0.4` with up = +Y, so the flat shape is unchanged to the bit.
      const d = (ux * _axX + uy * _axY + uz * _axZ) * rad * 0.4
      const ox = ux * rad - _axX * d
      const oy = uy * rad - _axY * d
      const oz = uz * rad - _axZ * d
      this.spawn(
        x + ox, y + oy, z + oz,
        -ox * inv, -oy * inv, -oz * inv,
        col[0] * 1.7, col[1] * 1.7, col[2] * 1.7,
        life, 0.11, 0, 0, 0, K_SPARK,
      )
    }
  }

  /** Launch signature for each weapon. */
  private muzzle(
    item: ItemId, hz: number, hy: number, q: number,
  ): void {
    const col = ITEM_RGB[item]
    // Off the nose, at chest height on the CAR. Both in its own frame: a
    // launch signature written in world XZ fires out of the flank of a car
    // that is rolled onto a wall.
    const mU = hy * 0.8
    const mx = pX(hz * 0.9, 0, mU)
    const my = pY(hz * 0.9, 0, mU)
    const mz = pZ(hz * 0.9, 0, mU)
    const dx = pX(-hz, 0, mU), dy = pY(-hz, 0, mU), dz = pZ(-hz, 0, mU)

    switch (item) {
      case 'railMissile':
        this.burst(mx, my, mz, dX(1, 0, 0.06), dY(1, 0, 0.06), dZ(1, 0, 0.06), Math.round(20 * q), 30, 0.20, col, 1.4, 0.20, 0.11, K_SPARK, -6, 1.2)
        this.flash(mx, my, mz, col, 1.8, 0.12, 1.3)
        this.ring(mx, my, mz, col, 1.1, 0.20, 0.3, 20, false)
        break
      case 'seekerMissile':
      case 'alphaMissile':
        this.burst(mx, my, mz, dX(1, 0, 0.1), dY(1, 0, 0.1), dZ(1, 0, 0.1), Math.round(18 * q), 16, 0.5, col, 1.5, 0.34, 0.16, K_SPRITE, 0.6, 2.0)
        this.burst(mx, my, mz, dX(-1, 0, 0.2), dY(-1, 0, 0.2), dZ(-1, 0, 0.2), Math.round(14 * q), 9, 0.8, SMOKE_RGB, 1.6, 0.8, 0.5, K_SMOKE, 1.0, 1.2)
        this.flash(mx, my, mz, col, 1.8, 0.16, 1.7)
        break
      case 'empBomb':
        this.flash(mx, my, mz, EMP_RGB, 1.5, 0.2, 1.9)
        this.ring(mx, my, mz, EMP_RGB, 1.2, 0.3, 0.6, 24, false)
        break
      case 'voidMine':
      case 'gravityWell':
        this.flash(dx, dy, dz, col, 2.0, 0.22, 1.6)
        this.burst(dx, dy, dz, dX(-1, 0, 0.2), dY(-1, 0, 0.2), dZ(-1, 0, 0.2), Math.round(10 * q), 6, 0.9, col, 1.2, 0.4, 0.14, K_SPARK, -6, 1.6)
        break
      default:
        this.flash(mx, my, mz, col, 2.0, 0.14, 1.2)
        this.burst(mx, my, mz, dX(1, 0, 0.15), dY(1, 0, 0.15), dZ(1, 0, 0.15), Math.round(12 * q), 12, 0.7, col, 1.3, 0.26, 0.12, K_SPARK, -6, 1.6)
    }
  }

  private landing(clean: boolean, speed: number, q: number): void {
    const heft = clean ? 0.6 : 1.0
    const cnt = Math.round((14 + speed * 0.45) * heft * q)
    // ANCHORED ON THE CONTACT POINT and laid out in the road's plane: the dust
    // ring is a circle on the DECK, sprayed outward across it and lifted off
    // it. Written in world XZ, a landing on a wall throws its dust through the
    // wall and drops it to whatever ground happens to be below.
    this.ring(gX(0, 0, 0.05), gY(0, 0, 0.05), gZ(0, 0, 0.05), SMOKE_RGB, clean ? 4.5 : 7.0, 0.42, 1.0, clean ? 12 : 20, true)
    for (let i = 0; i < cnt; i++) {
      const a = rnd() * TAU
      const sp = (3 + rnd() * 7) * heft
      const cf = Math.cos(a), sf = Math.sin(a)
      const rise = 0.8 + rnd() * 1.4
      this.spawn(
        gX(sf * 0.6, cf * 0.6, 0.08), gY(sf * 0.6, cf * 0.6, 0.08), gZ(sf * 0.6, cf * 0.6, 0.08),
        dX(sf * sp, cf * sp, rise), dY(sf * sp, cf * sp, rise), dZ(sf * sp, cf * sp, rise),
        DUST_RGB[0] * 2.3, DUST_RGB[1] * 2.3, DUST_RGB[2] * 2.3,
        0.6 + rnd() * 0.4, 0.42, 0.9, 0.4, 1.8, K_SMOKE,
      )
    }
    if (clean) {
      // A clean landing pays a trick boost, so it has to read as a reward and
      // not as dust. The flash sits ABOVE the roofline: at chassis height a
      // 1.9m sprite is entirely inside the vehicle's own silhouette and the
      // depth test eats all of it, which is why this used to land invisibly.
      this.flash(gX(0, 0, 1.7), gY(0, 0, 1.7), gZ(0, 0, 1.7), PAD_RGB, 2.2, 0.30, 1.7)
      this.ring(gX(0, 0, 1.5), gY(0, 0, 1.5), gZ(0, 0, 1.5), PAD_RGB, 1.5, 0.40, 0.5, 14, false)
      this.ring(gX(0, 0, 0.06), gY(0, 0, 0.06), gZ(0, 0, 0.06), PAD_RGB, 1.3, 0.46, 0.7, 15, true)
      for (let i = 0; i < Math.round(16 * q); i++) {
        const a = rnd() * TAU
        const sp = 5 + rnd() * 7
        const cf = Math.cos(a), sf = Math.sin(a)
        const rise = 4.5 + rnd() * 4.0
        this.spawn(
          gX(sf * 0.7, cf * 0.7, 0.15), gY(sf * 0.7, cf * 0.7, 0.15), gZ(sf * 0.7, cf * 0.7, 0.15),
          dX(sf * sp, cf * sp, rise), dY(sf * sp, cf * sp, rise), dZ(sf * sp, cf * sp, rise),
          PAD_RGB[0] * 1.5, PAD_RGB[1] * 1.5, PAD_RGB[2] * 1.5,
          0.34, 0.13, 0, -12, 2.0, K_SPARK,
        )
      }
    }
  }

  private wallSparks(
    r: RacerState, force: number, hx: number, hy: number, q: number, isLocal: boolean,
  ): void {
    const f = clamp01(force / 22)
    const side = r.lateral >= 0 ? 1 : -1
    // The barrier stands perpendicular to the ROAD, so the contact point is
    // out along the car's right and up off its own deck, and the sparks fly
    // back off the wall in that same frame.
    const so = side * hx * 1.14
    const sx = gX(0, so, hy * 0.5), sy = gY(0, so, hy * 0.5), sz = gZ(0, so, hy * 0.5)
    const cnt = Math.round((6 + f * 46) * q)
    for (let i = 0; i < cnt; i++) {
      const sp = 5 + rnd() * (10 + f * 34)
      const jit = rnd2() * 0.25
      const back = -(2 + rnd() * 10)
      const out = -side * sp * (0.5 + rnd() * 0.7)
      const rise = 1.5 + rnd() * (2 + f * 5)
      this.spawn(
        sx + _bUpX * jit, sy + _bUpY * jit, sz + _bUpZ * jit,
        dX(back, out, rise) + rnd2() * 2,
        dY(back, out, rise),
        dZ(back, out, rise) + rnd2() * 2,
        2.0, 1.35, 0.35,
        0.24 + rnd() * 0.3, 0.07 + f * 0.03, 0, -18, 2.2, K_SPARK,
      )
    }
    if (f > 0.25) {
      this.flash(sx, sy, sz, WHITE_RGB, 1.6 + f * 2.0, 0.14, 0.8 + f * 1.4)
      this.ring(sx, sy, sz, WHITE_RGB, 1.2, 0.20, 0.4, 12 + f * 20, false)
      if (f > 0.5) this.claimLight(sx, sy, sz, WHITE_RGB, 2 + f * 4, 0.16)
    }
    if (isLocal) this.hitFlash = Math.max(this.hitFlash, f * 0.5)
  }

  // -------------------------------------------------------------------------
  // 7. Projectile trails
  // -------------------------------------------------------------------------

  private updateProjectiles(dt: number, state: RaceState, cx: number, cy: number, cz: number): void {
    const list = state.projectiles
    let bestIdx = -1
    let bestD2 = Infinity
    for (let i = 0; i < list.length; i++) {
      const p = list[i]
      if (!p.alive) continue
      const dx = p.pos.x - cx, dy = p.pos.y - cy, dz = p.pos.z - cz
      const d2 = dx * dx + dy * dy + dz * dz
      if (d2 > 62500) continue
      if (d2 < bestD2) { bestD2 = d2; bestIdx = i }
      const lod = d2 < 2500 ? 1 : d2 < 14400 ? 0.6 : 0.3
      const q = this.qScale * lod
      const col = PROJ_RGB[p.kind] ?? WHITE_RGB
      const sx = p.pos.x, sy = p.pos.y, sz = p.pos.z
      let vl = Math.sqrt(p.vel.x * p.vel.x + p.vel.y * p.vel.y + p.vel.z * p.vel.z)
      if (vl < 1e-4) vl = 1
      const ux = p.vel.x / vl, uy = p.vel.y / vl, uz = p.vel.z / vl

      // Head glow. Always present so the projectile reads even without a body.
      this.spawn(sx, sy, sz, 0, 0, 0, col[0] * 2.4, col[1] * 2.4, col[2] * 2.4, 0.07, p.kind === 'alpha' ? 1.6 : 1.15, 0, 0, 0, K_SPRITE)

      if (p.kind === 'rail') {
        const cnt = Math.max(1, Math.round(3 * q))
        for (let k = 0; k < cnt; k++) {
          const t = (k / cnt) * dt
          this.spawn(
            sx - ux * vl * t + rnd2() * 0.12, sy - uy * vl * t + rnd2() * 0.12, sz - uz * vl * t + rnd2() * 0.12,
            -ux * 5 + rnd2() * 2.5, rnd2() * 2, -uz * 5 + rnd2() * 2.5,
            col[0] * 1.6, col[1] * 1.6, col[2] * 1.6,
            0.20, 0.085, 0, -3, 2.4, K_SPARK,
          )
        }
      } else if (p.kind === 'seeker') {
        const cnt = Math.max(1, Math.round(4 * q))
        for (let k = 0; k < cnt; k++) {
          const t = (k / cnt) * dt
          this.spawn(
            sx - ux * vl * t, sy - uy * vl * t, sz - uz * vl * t,
            -ux * 3 + rnd2() * 1.6, 0.7 + rnd() * 1.0, -uz * 3 + rnd2() * 1.6,
            col[0] * 1.3, col[1] * 1.3, col[2] * 1.3,
            0.30, 0.20, 0.9, 0.3, 2.2, K_SPRITE,
          )
        }
        if (rnd() < 0.5 * q) {
          this.spawn(sx, sy, sz, rnd2(), 0.7, rnd2(), SMOKE_RGB[0] * 1.4, SMOKE_RGB[1] * 1.4, SMOKE_RGB[2] * 1.4, 0.85, 0.28, 1.1, 0.5, 1.2, K_SMOKE)
        }
      } else {
        // alpha: a heavy, crackling, unmistakably threatening plume
        const cnt = Math.max(2, Math.round(6 * q))
        for (let k = 0; k < cnt; k++) {
          const t = (k / cnt) * dt
          this.spawn(
            sx - ux * vl * t + rnd2() * 0.3, sy - uy * vl * t + rnd2() * 0.3, sz - uz * vl * t + rnd2() * 0.3,
            -ux * 6 + rnd2() * 3, 0.6 + rnd() * 1.6, -uz * 6 + rnd2() * 3,
            col[0] * 1.5, col[1] * 1.5, col[2] * 1.5,
            0.38, 0.28, 1.2, 0.4, 2.0, K_SPRITE,
          )
        }
        if (rnd() < 0.35) {
          this.spawn(sx, sy, sz, 0, 0, 0, col[0] * 2.0, col[1] * 2.0, col[2] * 2.0, 0.30, 0.6, 9.0, 0, 0, K_RING)
        }
        this.spawn(sx, sy, sz, -ux * 12, rnd2() * 4, -uz * 12, 2.0, 0.5, 0.8, 0.22, 0.12, 0, -6, 2.0, K_SPARK)
      }
    }

    // A dedicated light follows the nearest live projectile on high tier.
    if (this.lights.length >= 3) {
      const l = this.lights[2]
      if (bestIdx >= 0) {
        const p = list[bestIdx]
        const col = PROJ_RGB[p.kind] ?? WHITE_RGB
        l.position.set(p.pos.x, p.pos.y, p.pos.z)
        l.color.setRGB(Math.min(1, col[0]), Math.min(1, col[1]), Math.min(1, col[2]), THREE.LinearSRGBColorSpace)
        this.lightTtl[2] = Math.max(this.lightTtl[2], 0.05)
        this.lightPow[2] = p.kind === 'alpha' ? 7 : 4
      }
    }
  }

  // -------------------------------------------------------------------------
  // 6. Gravity wells and deployed mines
  // -------------------------------------------------------------------------

  private updateFields(dt: number, state: RaceState): void {
    const fields = state.fields

    // Bind live wells to pool slots.
    for (let s = 0; s < MAX_WELLS; s++) {
      const id = this.wellFieldId[s]
      if (id < 0) continue
      let stillAlive = false
      for (let i = 0; i < fields.length; i++) {
        const f = fields[i]
        if (f.id === id && f.alive && f.kind === 'well') { stillAlive = true; break }
      }
      if (!stillAlive) {
        this.wellFieldId[s] = -1
        this.wellGroup[s].visible = false
      }
    }

    for (let i = 0; i < fields.length; i++) {
      const f = fields[i]
      if (!f.alive) continue

      if (f.kind === 'well') {
        let slot = -1
        for (let s = 0; s < MAX_WELLS; s++) if (this.wellFieldId[s] === f.id) { slot = s; break }
        if (slot < 0) {
          for (let s = 0; s < MAX_WELLS; s++) if (this.wellFieldId[s] < 0) { slot = s; break }
          if (slot >= 0) {
            this.wellFieldId[slot] = f.id
            this.wellSpiral[slot] = 0
            this.wellGroup[slot].visible = true
            // Deployment pop.
            setAxis(f.up.x, f.up.y, f.up.z)
            this.ring(
              f.pos.x + f.up.x * 0.1, f.pos.y + f.up.y * 0.1, f.pos.z + f.up.z * 0.1,
              WELL_RGB, 2.2, 0.6, 1.0, f.radius * 2.2, true,
            )
            setAxis(0, 1, 0)
            this.flash(f.pos.x, f.pos.y + 1.0, f.pos.z, WELL_RGB, 3.0, 0.4, 3.0)
          }
        }
        if (slot >= 0) {
          const g = this.wellGroup[slot]
          g.position.set(f.pos.x, f.pos.y + f.radius * 0.35, f.pos.z)
          g.updateMatrix()
          g.updateMatrixWorld(true)
          const fade = clamp01(f.life * 0.5) * clamp01(1 - (f.absorbed ? 0.4 : 0))
          const sm = this.wellShellMat[slot]
          const cm = this.wellCoreMat[slot]
          sm.uniforms.uTime.value = this.time
          sm.uniforms.uRadius.value = f.radius
          sm.uniforms.uOpacity.value = 0.85 * fade
          cm.uniforms.uTime.value = this.time
          cm.uniforms.uRadius.value = f.radius * 0.26
          cm.uniforms.uOpacity.value = 0.92 * fade

          // Swirling inward particles: the reason players can read the radius.
          this.wellSpiral[slot] += dt * 34 * this.qScale
          let guard = 0
          while (this.wellSpiral[slot] >= 1 && guard < 16) {
            this.wellSpiral[slot] -= 1
            guard++
            const a = rnd() * TAU
            const rr = f.radius * (0.85 + rnd() * 0.35)
            const ex = f.pos.x + Math.cos(a) * rr
            const ez = f.pos.z + Math.sin(a) * rr
            const ey = f.pos.y + rnd() * f.radius * 0.9
            // Tangential + inward: a visible spiral.
            const tanX = -Math.sin(a), tanZ = Math.cos(a)
            const life = 0.85
            this.spawn(
              ex, ey, ez,
              (-Math.cos(a) * rr / life) + tanX * rr * 0.9,
              (f.pos.y + f.radius * 0.35 - ey) / life,
              (-Math.sin(a) * rr / life) + tanZ * rr * 0.9,
              WELL_RGB[0] * 2.0, WELL_RGB[1] * 2.0, WELL_RGB[2] * 2.0,
              life, 0.13, -0.05, 0, 0.5, K_SPARK,
            )
          }
          if (rnd() < 2.2 * dt) {
            setAxis(f.up.x, f.up.y, f.up.z)
            this.ring(
              f.pos.x + f.up.x * 0.06, f.pos.y + f.up.y * 0.06, f.pos.z + f.up.z * 0.06,
              WELL_RGB, 1.6, 0.9, f.radius * 1.25, -f.radius * 1.1, true,
            )
            setAxis(0, 1, 0)
          }
        }
      } else {
        // Deployed void mine: pulsing orb, brighter once armed.
        const armed = f.armDelay <= 0
        const pulse = 0.55 + 0.45 * Math.sin(this.time * (armed ? 9 : 3.5) + f.id)
        if (rnd() < (armed ? 14 : 6) * dt * this.qScale) {
          this.spawn(
            f.pos.x + rnd2() * 0.4, f.pos.y + 0.35 + rnd2() * 0.25, f.pos.z + rnd2() * 0.4,
            rnd2() * 0.6, 0.4 + rnd() * 0.5, rnd2() * 0.6,
            MINE_RGB[0] * (1.2 + pulse), MINE_RGB[1] * (1.2 + pulse), MINE_RGB[2] * (1.2 + pulse),
            0.45, 0.18, 0, 0, 1.2, K_SPRITE,
          )
        }
        if (rnd() < (armed ? 2.6 : 1.0) * dt) {
          this.ring(f.pos.x, f.pos.y + 0.06, f.pos.z, MINE_RGB, armed ? 2.0 : 1.0, 0.55, 0.5, f.radius * 1.6, true)
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 8/9. Item boxes and charge pickups
  // -------------------------------------------------------------------------

  private updateEntities(dt: number, state: RaceState): void {
    const boxes = state.itemBoxes
    if (boxes.length > 0 && (!this.boxReady || boxes.length > this.boxCount)) {
      this.buildBoxes(boxes.length)
      const pos = new Float32Array(this.boxCount * 3)
      const phase = new Float32Array(this.boxCount)
      for (let i = 0; i < this.boxCount; i++) {
        const b = boxes[i]
        pos[i * 3] = b ? b.pos.x : 0
        pos[i * 3 + 1] = (b ? b.pos.y : 0) + 1.35
        pos[i * 3 + 2] = b ? b.pos.z : 0
        phase[i] = Math.random()
      }
      const g = this.boxGeo
      if (g) {
        g.setAttribute('iPos', new THREE.InstancedBufferAttribute(pos, 3))
        g.setAttribute('iPhase', new THREE.InstancedBufferAttribute(phase, 1))
      }
    }
    if (this.boxReady && this.boxMat && this.boxScale && this.attrBoxScale && this.boxWasActive) {
      this.boxMat.uniforms.uTime.value = this.time
      const sArr = this.boxScale
      const was = this.boxWasActive
      const k = 1 - Math.pow(0.0001, dt)
      const cnt = Math.min(this.boxCount, boxes.length)
      for (let i = 0; i < cnt; i++) {
        const b = boxes[i]
        const on = b.active ? 1 : 0
        if (was[i] === 1 && on === 0) {
          // Pop burst at the box itself.
          {
            // The box's own up: the axis the sim floated it along, so the pop
            // throws its sparks off the box and not through the road it sits on.
            const bu = b.up
            const bx = b.pos.x + bu.x * 1.35, by = b.pos.y + bu.y * 1.35, bz = b.pos.z + bu.z * 1.35
            this.burst(bx, by, bz, bu.x * 0.25, bu.y * 0.25, bu.z * 0.25, Math.round(22 * this.qScale), 9, 1.0, BOX_A_RGB, 1.8, 0.5, 0.14, K_SPARK, -6, 2.0)
            this.burst(bx, by, bz, bu.x * 0.2, bu.y * 0.2, bu.z * 0.2, Math.round(8 * this.qScale), 4, 1.0, BOX_B_RGB, 1.4, 0.6, 0.3, K_SPRITE, -2, 2.4)
          }
          this.ring(b.pos.x + b.up.x * 1.35, b.pos.y + b.up.y * 1.35, b.pos.z + b.up.z * 1.35, BOX_A_RGB, 2.2, 0.4, 0.5, 16, false)
          this.flash(b.pos.x, b.pos.y + 1.35, b.pos.z, WHITE_RGB, 2.0, 0.2, 2.2)
        } else if (was[i] === 0 && on === 1) {
          this.ring(b.pos.x + b.up.x * 1.35, b.pos.y + b.up.y * 1.35, b.pos.z + b.up.z * 1.35, BOX_A_RGB, 1.4, 0.35, 1.4, -2.5, false)
        }
        was[i] = on
        sArr[i] += (on - sArr[i]) * k
        if (sArr[i] < 0.002) sArr[i] = 0
      }
      this.attrBoxScale.needsUpdate = true
    }

    const shards = state.chargePickups
    if (shards.length > 0 && (!this.shardReady || shards.length > this.shardCount)) {
      this.buildShards(shards.length)
      const pos = new Float32Array(this.shardCount * 3)
      const phase = new Float32Array(this.shardCount)
      for (let i = 0; i < this.shardCount; i++) {
        const s = shards[i]
        pos[i * 3] = s ? s.pos.x : 0
        pos[i * 3 + 1] = (s ? s.pos.y : 0) + 1.0
        pos[i * 3 + 2] = s ? s.pos.z : 0
        phase[i] = Math.random()
      }
      const g = this.shardGeo
      if (g) {
        g.setAttribute('iPos', new THREE.InstancedBufferAttribute(pos, 3))
        g.setAttribute('iPhase', new THREE.InstancedBufferAttribute(phase, 1))
      }
    }
    if (this.shardReady && this.shardMat && this.shardScale && this.attrShardScale && this.shardWasActive) {
      this.shardMat.uniforms.uTime.value = this.time
      const sArr = this.shardScale
      const was = this.shardWasActive
      const k = 1 - Math.pow(0.0001, dt)
      const cnt = Math.min(this.shardCount, shards.length)
      for (let i = 0; i < cnt; i++) {
        const s = shards[i]
        const on = s.active ? 1 : 0
        if (was[i] === 1 && on === 0) {
          this.burst(
            s.pos.x + s.up.x, s.pos.y + s.up.y, s.pos.z + s.up.z,
            s.up.x * 0.4, s.up.y * 0.4, s.up.z * 0.4,
            Math.round(12 * this.qScale), 6, 1.0, CHARGE_RGB, 2.0, 0.5, 0.1, K_SPARK, -5, 2.2,
          )
          this.flash(s.pos.x, s.pos.y + 1.0, s.pos.z, CHARGE_RGB, 2.4, 0.22, 1.6)
        }
        was[i] = on
        sArr[i] += (on - sArr[i]) * k
        if (sArr[i] < 0.002) sArr[i] = 0
      }
      this.attrShardScale.needsUpdate = true
    }
  }

  private buildBoxes(count: number): void {
    this.destroyBoxes()
    this.boxCount = count
    const src = new THREE.BoxGeometry(1, 1, 1)
    const g = new THREE.InstancedBufferGeometry()
    g.index = src.index
    g.setAttribute('position', src.attributes.position)
    g.setAttribute('normal', src.attributes.normal)
    g.setAttribute('uv', src.attributes.uv)
    g.instanceCount = count
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)
    this.boxScale = new Float32Array(count)
    this.attrBoxScale = new THREE.InstancedBufferAttribute(this.boxScale, 1)
    this.attrBoxScale.setUsage(THREE.DynamicDrawUsage)
    g.setAttribute('iScale', this.attrBoxScale)
    this.boxWasActive = new Uint8Array(count)
    this.boxMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSize: { value: 1.7 },
        uSpin: { value: 1.05 },
        uBob: { value: 0.22 },
        uColorA: { value: new THREE.Color(BOX_A_RGB[0], BOX_A_RGB[1], BOX_A_RGB[2]) },
        uColorB: { value: new THREE.Color(BOX_B_RGB[0], BOX_B_RGB[1], BOX_B_RGB[2]) },
      },
      vertexShader: HOLO_VERT,
      fragmentShader: BOX_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    })
    const mesh = new THREE.Mesh(g, this.boxMat)
    mesh.frustumCulled = false
    mesh.matrixAutoUpdate = false
    mesh.renderOrder = 14
    this.group.add(mesh)
    this.boxMesh = mesh
    this.boxGeo = g
    this.boxReady = true
  }

  private buildShards(count: number): void {
    this.destroyShards()
    this.shardCount = count
    const src = new THREE.OctahedronGeometry(0.5, 0)
    const g = new THREE.InstancedBufferGeometry()
    g.index = src.index
    g.setAttribute('position', src.attributes.position)
    g.setAttribute('normal', src.attributes.normal)
    g.setAttribute('uv', src.attributes.uv)
    g.instanceCount = count
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)
    this.shardScale = new Float32Array(count)
    this.attrShardScale = new THREE.InstancedBufferAttribute(this.shardScale, 1)
    this.attrShardScale.setUsage(THREE.DynamicDrawUsage)
    g.setAttribute('iScale', this.attrShardScale)
    this.shardWasActive = new Uint8Array(count)
    this.shardMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSize: { value: 1.2 },
        uSpin: { value: 2.4 },
        uBob: { value: 0.16 },
        uColorA: { value: new THREE.Color(CHARGE_RGB[0] * 0.5, CHARGE_RGB[1] * 0.5, CHARGE_RGB[2] * 0.5) },
        uColorB: { value: new THREE.Color(CHARGE_RGB[0] * 1.6, CHARGE_RGB[1] * 1.6, CHARGE_RGB[2] * 1.6) },
      },
      vertexShader: HOLO_VERT,
      fragmentShader: SHARD_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    })
    const mesh = new THREE.Mesh(g, this.shardMat)
    mesh.frustumCulled = false
    mesh.matrixAutoUpdate = false
    mesh.renderOrder = 14
    this.group.add(mesh)
    this.shardMesh = mesh
    this.shardGeo = g
    this.shardReady = true
  }

  // -------------------------------------------------------------------------
  // Deferred bursts, shells, lights
  // -------------------------------------------------------------------------

  private updateDeferred(): void {
    for (let i = 0; i < DEFER_MAX; i++) {
      if (!this.defOn[i]) continue
      if (this.time < this.defTime[i]) continue
      this.defOn[i] = 0
      const i3 = i * 3
      const x = this.defPos[i3], y = this.defPos[i3 + 1], z = this.defPos[i3 + 2]
      setAxis(this.defAxis[i3], this.defAxis[i3 + 1], this.defAxis[i3 + 2])
      _rgb2[0] = this.defCol[i3]; _rgb2[1] = this.defCol[i3 + 1]; _rgb2[2] = this.defCol[i3 + 2]
      const s = this.defScale[i]
      switch (this.defKind[i]) {
        case D_VOID_BURST:
          this.flash(x, y, z, _rgb2, 1.6, 0.30, 2.0)
          this.spawn(x, y, z, 0, 0, 0, _rgb2[0] * 1.3, _rgb2[1] * 1.3, _rgb2[2] * 1.3, 0.44, 0.9, 9.0, 0, 0, K_SHELL)
          this.ring(x, y, z, _rgb2, 1.0, 0.45, 0.6, 26, false)
          this.burst(x, y, z, _axX * 0.2, _axY * 0.2, _axZ * 0.2, Math.round(48 * s), 26, 1.0, _rgb2, 1.15, 0.5, 0.14, K_SPARK, -12, 1.3)
          this.claimLight(x, y, z, _rgb2, 8, 0.3)
          break
        case D_ALPHA_RING:
          // Growth and gain are both cut hard here. A shockwave grown to forty
          // metres is, from inside it, a flat wall of light across the whole
          // frame for half a second after the hit — the player is blind long
          // after the moment has passed.
          this.ring(x, y, z, _rgb2, 0.60 / s, 0.7 * s, 1.2 * s, 10 * s, false)
          this.ring(x + _axX * 0.05, y + _axY * 0.05, z + _axZ * 0.05, _rgb2, 0.45 / s, 0.8 * s, 1.4 * s, 9 * s, true)
          break
        case D_EMP_PULSE:
          this.spawnEmp(x, y, z, 52, 0.7)
          this.ring(x, y, z, _rgb2, 0.85, 0.6, 1.0, 32, false)
          break
        case D_DRIFT_SHOCK:
          // Second front of a tier-up, ~90ms behind the first. `s` is the tier.
          // Bounded like the first: unbounded growth here was reaching a quad
          // size of 29 at tier 3, a 11m radius drawn straight across the sky.
          {
            const f = DRIFT_BODY_GAIN[s | 0]
            this.shockRing(x, y, z, _rgb2, (0.60 + s * 0.12) * f, 0.30 + s * 0.04, 0.9 + s * 0.4, 4.0 + s * 1.8, false)
            this.shockShell(x, y, z, _rgb2, 0.70 * f, 0.24 + s * 0.04, 1.1 + s * 0.4, 4.5 + s * 1.6)
          }
          break
        case D_DRIFT_BLOW: {
          // The gathered charge leaving the exhaust. `s` is the tier, and the
          // deferred direction is the exhaust axis at the moment of release,
          // so the blowout stays aimed even though the vehicle has turned.
          const dx = this.defDir[i3], dy = this.defDir[i3 + 1], dz = this.defDir[i3 + 2]
          const qs = this.qScale
          const f = DRIFT_BODY_GAIN[s | 0]
          this.flash(x, y, z, _rgb2, (0.70 + s * 0.25) * f, 0.16 + s * 0.03, 0.45 + s * 0.20)
          this.shockRing(x, y, z, _rgb2, (0.55 + s * 0.16) * f, 0.30 + s * 0.05, 0.6, 3.6 + s * 1.6, false)
          this.burst(
            x, y, z, dx, dy, dz, Math.round((14 + s * 16) * qs), 20 + s * 14, 0.30,
            _rgb2, 0.55 + s * 0.14, 0.30 + s * 0.06, 0.13 + s * 0.035, K_SPARK, -6, 2.0,
          )
          this.burst(
            x, y, z, dx, dy, dz, Math.round((6 + s * 7) * qs), 9 + s * 6, 0.55,
            _rgb2, 0.26, 0.46, 0.26 + s * 0.09, K_SPRITE, 0.4, 3.0,
          )
          break
        }
        case D_RAMP_KICK:
          // `s` is normalised launch power. A second column and ground front,
          // so the launch lands as a beat rather than as one frame of light.
          this.spawn(
            x, y, z, 0, 0, 0, _rgb2[0], _rgb2[1], _rgb2[2],
            0.36 + s * 0.16, 1.0 + s * 0.9, -0.9, 0, 0, K_BEAM,
          )
          // The second ground front rides the SAME deck the first one did:
          // the stored axis, not world +Y.
          this.shockRing(
            x + _axX * 0.05, y + _axY * 0.05, z + _axZ * 0.05,
            _rgb2, 0.70 + s * 0.30, 0.46 + s * 0.10, 1.1, 9 + s * 6, true,
          )
          break
      }
    }
  }

  private spawnEmp(x: number, y: number, z: number, radius: number, life: number): void {
    let slot = 0
    let worst = -1
    for (let i = 0; i < MAX_EMP; i++) {
      if (this.empLife[i] <= 0) { slot = i; worst = -1; break }
      const rem = 1 - this.empAge[i] / this.empLife[i]
      if (rem > worst) { worst = rem; slot = i }
    }
    this.empAge[slot] = 0
    this.empLife[slot] = life
    const m = this.empMesh[slot]
    m.position.set(x, y, z)
    m.scale.setScalar(0.4)
    m.visible = true
    m.updateMatrix()
    m.updateMatrixWorld(true)
    this.empMat[slot].opacity = 1
    // Radius is folded into the scale ramp applied in updateShells().
    this.empMesh[slot].userData.radius = radius
  }

  private spawnDistortion(x: number, y: number, z: number, r0: number, growth: number, life: number): void {
    let slot = 0
    let worst = -1
    for (let i = 0; i < MAX_DISTORT; i++) {
      if (this.distLife[i] <= 0) { slot = i; worst = -1; break }
      const rem = 1 - this.distAge[i] / this.distLife[i]
      if (rem > worst) { worst = rem; slot = i }
    }
    this.distAge[slot] = 0
    this.distLife[slot] = life
    const m = this.distMesh[slot]
    m.position.set(x, y, z)
    m.visible = true
    m.updateMatrix()
    m.updateMatrixWorld(true)
    this.distMat[slot].uniforms.uRadius.value = r0
    this.distMat[slot].uniforms.uOpacity.value = 1
    m.userData.r0 = r0
    m.userData.growth = growth
  }

  private updateShells(dt: number): void {
    for (let i = 0; i < MAX_EMP; i++) {
      if (this.empLife[i] <= 0) continue
      this.empAge[i] += dt
      const u = this.empAge[i] / this.empLife[i]
      if (u >= 1) {
        this.empLife[i] = 0
        this.empMesh[i].visible = false
        this.empMat[i].opacity = 0
        continue
      }
      const radius = (this.empMesh[i].userData.radius as number) ?? 30
      const s = radius * (0.08 + u * 0.98)
      this.empMesh[i].scale.setScalar(s)
      this.empMesh[i].updateMatrix()
      this.empMesh[i].updateMatrixWorld(true)
      this.empMat[i].opacity = (1 - u) * (1 - u) * 0.95
    }

    for (let i = 0; i < MAX_DISTORT; i++) {
      if (this.distLife[i] <= 0) continue
      this.distAge[i] += dt
      const u = this.distAge[i] / this.distLife[i]
      if (u >= 1) {
        this.distLife[i] = 0
        this.distMesh[i].visible = false
        continue
      }
      const r0 = (this.distMesh[i].userData.r0 as number) ?? 2
      const gr = (this.distMesh[i].userData.growth as number) ?? 10
      this.distMat[i].uniforms.uTime.value = this.time
      this.distMat[i].uniforms.uRadius.value = r0 + gr * this.distAge[i]
      this.distMat[i].uniforms.uOpacity.value = (1 - u) * (1 - u)
    }
  }

  private updateLights(dt: number): void {
    for (let i = 0; i < this.lights.length; i++) {
      if (this.lightTtl[i] > 0) {
        this.lightTtl[i] -= dt
        if (this.lightTtl[i] <= 0) {
          this.lightTtl[i] = 0
          this.lightPow[i] = 0
          this.lights[i].intensity = 0
        } else {
          this.lights[i].intensity = this.lightPow[i] * this.lightTtl[i] * 60
        }
      } else if (this.lights[i].intensity !== 0) {
        this.lights[i].intensity = 0
      }
    }
  }

  // -------------------------------------------------------------------------
  // Trail ribbons
  //
  // Three per racer, one geometry, one draw call: the chassis trail off the
  // exhaust, and the PAIR of drift arc lines anchored at the rear corners of
  // the silhouette. The pair is the piece that makes a slide legible from
  // outside the car — to a spectator, to a replay, and to the player in the
  // corner of their eye — because it is the only channel that records where the
  // vehicle HAS BEEN rather than where it is. Sampling world positions at the
  // corners and playing them back is what makes a hard drift paint two curves
  // through the corner and a shallow one paint two nearly-straight lines,
  // without anything ever having to measure the slide angle.
  // -------------------------------------------------------------------------

  /** Zero a ribbon slot's alpha, leaving its geometry where it is. */
  private clearRibbon(slot: number): void {
    const n = this.trailN * 3
    const base = slot * n
    let any = false
    for (let i = 0; i < n; i++) {
      if (this.trailAlpha[base + i] !== 0) { this.trailAlpha[base + i] = 0; any = true }
    }
    if (any) this.attrTrailAlpha.needsUpdate = true
  }

  /**
   * Collapse a ribbon slot onto a point.
   *
   * Alpha 0 stops a ribbon being SEEN; it does not stop it being rasterised.
   * The strip is still a few dozen screen-sized triangles whose fragments all
   * reach the shader and get discarded, and with eight cars there are sixteen
   * idle drift ribbons at every moment. Collapsing to a point makes every
   * triangle degenerate, which the rasteriser throws away for free — so the
   * pair costs nothing at all except while a car is actually sliding.
   */
  private collapseRibbon(slot: number, x: number, y: number, z: number): void {
    const n = this.trailN * 3
    const base = slot * n
    const P = this.trailPos, A = this.trailAlpha
    for (let i = 0; i < n; i++) {
      const v = (base + i) * 3
      P[v] = x; P[v + 1] = y; P[v + 2] = z
      A[base + i] = 0
    }
    this.attrTrailPos.needsUpdate = true
    this.attrTrailAlpha.needsUpdate = true
  }

  /**
   * Lay one ribbon out of a position history.
   *
   * `hist` is a ring buffer of world positions with `off` floats of other
   * ribbons' history in front of it and the newest sample at `head`. Style
   * comes from the _rb* scratch and colour from _rgb2, which is the same trick
   * the per-racer basis uses: nine numbers that would otherwise be nine more
   * parameters on a call made three times per racer per frame.
   */
  private writeRibbon(
    slot: number, hist: Float32Array, off: number, head: number,
    cx: number, cy: number, cz: number, fwdX: number, fwdZ: number,
  ): void {
    const N = this.trailN
    const P = this.trailPos, A = this.trailAlpha, C = this.trailCol
    const vbase = slot * N * 3
    const t0 = this.time
    for (let j = 0; j < N; j++) {
      const idx = (head - j + N * 2) % N
      const i3 = off + idx * 3
      const px = hist[i3], py = hist[i3 + 1], pz = hist[i3 + 2]
      // Tangent from the neighbouring samples.
      const prev = off + ((idx - 1 + N) % N) * 3
      const next = off + ((idx + 1) % N) * 3
      let dx = hist[next] - hist[prev]
      let dy = hist[next + 1] - hist[prev + 1]
      let dz = hist[next + 2] - hist[prev + 2]
      let dl = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (dl < 1e-5) { dx = fwdX; dy = 0; dz = fwdZ; dl = 1 }
      dx /= dl; dy /= dl; dz /= dl
      // Side = normalize(cross(tangent, toCamera)) so the ribbon always faces us.
      const vx = cx - px, vy = cy - py, vz = cz - pz
      let sx = dy * vz - dz * vy
      let sy = dz * vx - dx * vz
      let sz = dx * vy - dy * vx
      let sl = Math.sqrt(sx * sx + sy * sy + sz * sz)
      if (sl < 1e-5) { sx = 1; sy = 0; sz = 0; sl = 1 }
      sx /= sl; sy /= sl; sz /= sl

      // NEAR-CAMERA FADE, the same idea the particle shader uses and for the
      // same reason -- except a ribbon needs it MORE, not less. A ribbon is
      // twenty-five metres of geometry laid along the exact path the car has
      // just driven, the chase camera sits nine metres back on that path, and
      // the strip is built to face the camera at every sample: so the camera
      // does not merely pass the ribbon, it passes THROUGH it, and the sample
      // it is standing on degenerates into a metre-wide sheet across the lens.
      // Measured on a held tier-3 slide, that was a soft white disc a fifth of
      // the frame across sitting on the road on the outside of every corner,
      // plus a band of it over the sky where the tail had already gone by. The
      // head of the ribbon is 9 m out, so nothing anyone is looking at loses
      // anything at all.
      const dcam = Math.sqrt(vx * vx + vy * vy + vz * vz)
      const nf = dcam <= 2.4 ? 0 : dcam >= 8.0 ? 1 : (dcam - 2.4) * 0.1786
      const t = j / (N - 1)
      const taper = (1 - t) * (1 - t)
      const w = _rbW * (0.35 + taper * 0.9)
      let a = _rbA * Math.pow(1 - t, 1.4) * nf * nf
      // LENGTH is a tier read: the arc is painted further back the harder the
      // charge, which costs no brightness at all and is visible in a mirror.
      if (j >= _rbShown) a = 0
      else if (j > _rbShown - 3) a *= (_rbShown - j) * 0.3333
      // ...and MOTION is another: a pulse running down the ribbon, faster and
      // deeper with the tier. Held at zero under reduced motion.
      if (_rbPulse > 0) a *= 1 + _rbPulse * Math.sin(j * _rbFreq - t0 * _rbSpeed + _rbPhase)

      const v0 = (vbase + j * 3) * 3
      P[v0] = px - sx * w; P[v0 + 1] = py - sy * w; P[v0 + 2] = pz - sz * w
      P[v0 + 3] = px; P[v0 + 4] = py; P[v0 + 5] = pz
      P[v0 + 6] = px + sx * w; P[v0 + 7] = py + sy * w; P[v0 + 8] = pz + sz * w

      const a0 = vbase + j * 3
      A[a0] = 0; A[a0 + 1] = a; A[a0 + 2] = 0
      for (let k = 0; k < 3; k++) {
        const c0 = (a0 + k) * 3
        C[c0] = _rgb2[0]; C[c0 + 1] = _rgb2[1]; C[c0 + 2] = _rgb2[2]
      }
    }
    this.attrTrailPos.needsUpdate = true
    this.attrTrailAlpha.needsUpdate = true
    this.attrTrailCol.needsUpdate = true
  }

  private updateTrail(
    dt: number, r: RacerState, fx: RacerFx, slot: number,
    lod: number, cx: number, cy: number, cz: number,
  ): void {
    const N = this.trailN
    const chassis = CHASSIS_BY_ID[r.chassisId]
    const hx = chassis ? chassis.halfExtents.x : 1.1
    const hz = chassis ? chassis.halfExtents.z : 2.3
    const hy = chassis ? chassis.halfExtents.y : 0.6
    // The racer's frame, same rule as updateRacer: a compass yaw and world +Y
    // on a flat track, the sim's own (fwd, up) on a gravity one. The two arc
    // ribbons STRADDLE the car, so on a wall a world-+Y basis stands them on
    // end and draws one vertical line where there should be a pair.
    let fwdX = Math.sin(r.yaw), fwdY = 0, fwdZ = Math.cos(r.yaw)
    let rgtX = -Math.cos(r.yaw), rgtY = 0, rgtZ = Math.sin(r.yaw)
    let upX = 0, upY = 1, upZ = 0
    if (this.gravity) {
      upX = r.up.x; upY = r.up.y; upZ = r.up.z
      fwdX = r.fwd.x; fwdY = r.fwd.y; fwdZ = r.fwd.z
      rgtX = fwdY * upZ - fwdZ * upY
      rgtY = fwdZ * upX - fwdX * upZ
      rgtZ = fwdX * upY - fwdY * upX
      const rl = Math.hypot(rgtX, rgtY, rgtZ) || 1
      rgtX /= rl; rgtY /= rl; rgtZ /= rl
    }
    const tF = -hz * 1.02, tU = hy * 0.35
    const tx = r.pos.x + fwdX * tF + upX * tU
    const ty = r.pos.y + fwdY * tF + upY * tU
    const tz = r.pos.z + fwdZ * tF + upZ * tU
    const rib0 = slot * RIB_PER_RACER

    // THE TWO ANCHORS. Rear corners of the silhouette, at the height the class
    // actually rides at: a grounded car sheds them from the rear hubs, a hover
    // skirt from the pod line a little higher, a flight frame from mid-hull.
    // Widened to a floor of 0.82 m because Filament's collision box is 0.68 m
    // wide — two ribbons 1.4 m apart on a bike read as one fat one, and the
    // pair only says anything if it is legible AS a pair.
    const dropMax = hy * 1.6 + 0.35
    const drop = r.altitude < 0 ? 0 : r.altitude > dropMax ? dropMax : r.altitude
    const ax = hx * 1.05 < 0.82 ? 0.82 : hx * 1.05
    // Anchor point: behind the axle line, part way down toward the road.
    // `drop` is taken along the racer's up for the same reason the contact
    // point is -- on a wall, "down toward the road" is sideways.
    const bF = -hz * 0.90, bU = hy * 0.30 - drop * 0.45
    const bx = r.pos.x + fwdX * bF + upX * bU
    const ay = r.pos.y + fwdY * bF + upY * bU
    const bz = r.pos.z + fwdZ * bF + upZ * bU

    if (!fx.trailReady) {
      for (let i = 0; i < N; i++) {
        fx.trail[i * 3] = tx; fx.trail[i * 3 + 1] = ty; fx.trail[i * 3 + 2] = tz
        for (let s = 0; s < 2; s++) {
          const sgn = s === 0 ? -1 : 1
          const o = s * N * 3 + i * 3
          fx.rib[o] = bx + rgtX * ax * sgn
          fx.rib[o + 1] = ay + rgtY * ax * sgn
          fx.rib[o + 2] = bz + rgtZ * ax * sgn
        }
      }
      fx.trailHead = 0
      fx.trailReady = true
    }

    // Push a new sample at a fixed rate; the head always tracks the vehicle.
    fx.trailAcc += dt
    if (fx.trailAcc >= 0.025) {
      fx.trailAcc = 0
      fx.trailHead = (fx.trailHead + 1) % N
    }
    const h3 = fx.trailHead * 3
    fx.trail[h3] = tx
    fx.trail[h3 + 1] = ty
    fx.trail[h3 + 2] = tz
    // The corner history runs whether or not the car is drifting. A pair that
    // only recorded while sliding would, on the first frame of the next drift,
    // snap a curve across the track from wherever the last one ended.
    fx.rib[h3] = bx - rgtX * ax
    fx.rib[h3 + 1] = ay - rgtY * ax
    fx.rib[h3 + 2] = bz - rgtZ * ax
    fx.rib[N * 3 + h3] = bx + rgtX * ax
    fx.rib[N * 3 + h3 + 1] = ay + rgtY * ax
    fx.rib[N * 3 + h3 + 2] = bz + rgtZ * ax

    // The arc pair's envelope: up within about an eighth of a second, and a
    // third of a second to stream away and go out. Instant removal on the
    // release frame reads as a bug, and the release is exactly the frame the
    // player is looking at the car.
    const drifting = r.driftSide !== 0
    const kEnv = drifting ? 1 - Math.pow(0.0002, dt) : 1 - Math.pow(0.04, dt)
    fx.ribEnv += ((drifting ? 1 : 0) - fx.ribEnv) * kEnv

    if (lod <= 0 || r.respawnTime > 0) {
      this.clearRibbon(rib0)
      if (fx.ribOn) {
        this.collapseRibbon(rib0 + RIB_LEFT, r.pos.x, r.pos.y, r.pos.z)
        this.collapseRibbon(rib0 + RIB_RIGHT, r.pos.x, r.pos.y, r.pos.z)
        fx.ribOn = false
      }
      fx.ribEnv = 0
      return
    }

    const b01 = r.boostTime > 0 ? clamp01(r.boostMag / 0.55) : 0
    const inv = r.invincibleTime > 0
    const speed01 = clamp01(Math.sqrt(this.gravity
      ? r.vel.x * r.vel.x + r.vel.y * r.vel.y + r.vel.z * r.vel.z
      : r.vel.x * r.vel.x + r.vel.z * r.vel.z) / 60)
    // The ribbon is the one drift channel that is ALWAYS on screen behind the
    // vehicle, so if it does not step with the tier the "whole effect set
    // changes colour" read is broken by the most visible element in it.
    const dTier = r.driftSide !== 0 && r.driftTier >= 0 ? Math.min(3, r.driftTier) : -1
    const d01 = dTier < 0 ? 0 : (dTier + 1) / 4
    const baseA = (0.07 + speed01 * 0.10 + b01 * 0.95 + d01 * 0.45 + (inv ? 0.35 : 0)) * lod
    const halfW = 0.26 + b01 * 0.80 + d01 * 0.34 + (inv ? 0.30 : 0)

    // Colour: chassis emissive, driven white-hot by strong boosts.
    if (inv) {
      _c.setHSL((this.time * 0.9) % 1, 1.0, 0.6, THREE.SRGBColorSpace)
      _rgb2[0] = _c.r * 2.0; _rgb2[1] = _c.g * 2.0; _rgb2[2] = _c.b * 2.0
    } else if (dTier >= 0 && b01 <= 0.05) {
      // driftColor carries the tier-up wash, so the ribbon flashes white and
      // resolves into the new hue in step with the sparks and the underglow.
      this.driftColor(fx, dTier, _rgb2)
      // A ribbon is a FILLED shape, so it obeys the rule the wheel glow and the
      // underglow obey: DRIFT_BODY_GAIN divides the tier's own luminance back
      // out, and the ladder is carried by the arc pair, the width and the hue.
      // Before this the tier-3 ribbon ran at scene-linear 1.7 — over the bloom
      // threshold, along its whole length, for as long as the slide lasted —
      // purely because DRIFT_RGB's white is three times brighter than its cyan.
      const k = (0.30 + d01 * 0.16) * DRIFT_BODY_GAIN[dTier]
      _rgb2[0] *= k; _rgb2[1] *= k; _rgb2[2] *= k
    } else if (b01 > 0.05) {
      this.boostColorOf(r, _rgb2)
      const w = b01 * b01
      const k = 0.42 + w * 0.42
      _rgb2[0] = _rgb2[0] * k + w * 0.5
      _rgb2[1] = _rgb2[1] * k + w * 0.5
      _rgb2[2] = _rgb2[2] * k + w * 0.5
    } else {
      writeHex(_rgb2, 0, chassis ? chassis.colorEmissive : 0x88aaff, 0.9)
    }

    _rbA = baseA
    _rbW = halfW
    _rbShown = 1e9
    _rbPulse = 0
    _rbPhase = 0
    this.writeRibbon(rib0 + RIB_MAIN, fx.trail, 0, fx.trailHead, cx, cy, cz, fwdX, fwdZ)

    // ---- the arc pair --------------------------------------------------
    if (fx.ribEnv <= 0.004) {
      if (fx.ribOn) {
        this.collapseRibbon(rib0 + RIB_LEFT, bx - rgtX * ax, ay, bz - rgtZ * ax)
        this.collapseRibbon(rib0 + RIB_RIGHT, bx + rgtX * ax, ay, bz + rgtZ * ax)
        fx.ribOn = false
      }
      return
    }
    fx.ribOn = true

    const rt = fx.ribTier
    const tc = rt < 0 ? 0 : rt > 3 ? 3 : rt
    const pre = rt < 0
    const ch = fx.ribCharge
    const iw = fx.ribInward

    if (pre) {
      // Before the first tier there is no charge to draw, so the pair is a
      // pair of scuff marks: short, narrow and colourless. "No tier yet" has
      // to read as the ABSENCE of the ladder rather than as a fifth rung on it,
      // and the arrival of tier 0 has to be worth seeing.
      _rgb2[0] = SMOKE_RGB[0] * 1.1; _rgb2[1] = SMOKE_RGB[1] * 1.1; _rgb2[2] = SMOKE_RGB[2] * 1.1
    } else {
      const ti = tc * 3
      _rgb2[0] = DRIFT_RGB[ti]; _rgb2[1] = DRIFT_RGB[ti + 1]; _rgb2[2] = DRIFT_RGB[ti + 2]
      // The tier-up wash, at a third of the one driftColor hands the sparks.
      // A spark is a two-pixel streak and a wash on it is a flash; this is a
      // filled shape twenty-five metres long, and the same wash laid two white
      // beams down the middle of the road for a third of a second. The
      // transition still reads on the pair — it arrives on every channel in
      // the same frame, which is the whole point of the wash — it just no
      // longer takes the corner with it.
      const f = clamp01(fx.tierFlash * 3.4)
      const w = f * f * 0.30
      const iw = 1 - w
      _rgb2[0] = _rgb2[0] * iw + WHITE_RGB[0] * w * 1.35
      _rgb2[1] = _rgb2[1] * iw + WHITE_RGB[1] * w * 1.35
      _rgb2[2] = _rgb2[2] * iw + WHITE_RGB[2] * w * 1.35
      const k = DRIFT_BODY_GAIN[tc]
      _rgb2[0] *= k; _rgb2[1] *= k; _rgb2[2] *= k
    }

    _rbW = (pre ? 0.052 : RIB_W[tc] + 0.030 * ch) * (0.78 + 0.42 * iw)
    _rbA = (pre ? 0.15 : 0.34 + 0.16 * ch) * fx.ribEnv * lod
    _rbShown = (pre ? 0.26 : RIB_LEN[tc] * (0.84 + 0.16 * ch)) * N
    _rbPulse = pre || this.reduced ? 0 : 0.14 + 0.06 * tc
    _rbFreq = 0.42 + 0.10 * tc
    _rbSpeed = 5.5 + 2.4 * tc
    _rbPhase = 0
    this.writeRibbon(rib0 + RIB_LEFT, fx.rib, 0, fx.trailHead, cx, cy, cz, fwdX, fwdZ)
    // THE BRAID. From tier 2 the two ribbons' pulses run in antiphase, so the
    // pair visibly alternates instead of flashing together — a shape the eye
    // reads as "these are two things" at a glance, and one more rung of the
    // ladder that costs no light whatsoever.
    _rbPhase = !pre && tc >= 2 && !this.reduced ? Math.PI : 0
    this.writeRibbon(rib0 + RIB_RIGHT, fx.rib, N * 3, fx.trailHead, cx, cy, cz, fwdX, fwdZ)
  }
  // -------------------------------------------------------------------------
  // Upload only the slice of the pool written this frame.
  // -------------------------------------------------------------------------

  private flush(): void {
    if (this.spawnCount === 0) return
    const n = this.spawnCount
    const start = this.spawnStart
    this.attrPos.clearUpdateRanges()
    this.attrVel.clearUpdateRanges()
    this.attrCol.clearUpdateRanges()
    this.attrMisc.clearUpdateRanges()
    this.attrMisc2.clearUpdateRanges()
    this.attrAxis.clearUpdateRanges()
    if (n >= this.pool) {
      this.attrPos.addUpdateRange(0, this.pool * 3)
      this.attrVel.addUpdateRange(0, this.pool * 3)
      this.attrCol.addUpdateRange(0, this.pool * 3)
      this.attrMisc.addUpdateRange(0, this.pool * 4)
      this.attrMisc2.addUpdateRange(0, this.pool * 4)
      this.attrAxis.addUpdateRange(0, this.pool * 3)
    } else if (start + n <= this.pool) {
      this.attrPos.addUpdateRange(start * 3, n * 3)
      this.attrVel.addUpdateRange(start * 3, n * 3)
      this.attrCol.addUpdateRange(start * 3, n * 3)
      this.attrMisc.addUpdateRange(start * 4, n * 4)
      this.attrMisc2.addUpdateRange(start * 4, n * 4)
      this.attrAxis.addUpdateRange(start * 3, n * 3)
    } else {
      const head = this.pool - start
      const tail = n - head
      this.attrPos.addUpdateRange(start * 3, head * 3); this.attrPos.addUpdateRange(0, tail * 3)
      this.attrVel.addUpdateRange(start * 3, head * 3); this.attrVel.addUpdateRange(0, tail * 3)
      this.attrCol.addUpdateRange(start * 3, head * 3); this.attrCol.addUpdateRange(0, tail * 3)
      this.attrMisc.addUpdateRange(start * 4, head * 4); this.attrMisc.addUpdateRange(0, tail * 4)
      this.attrMisc2.addUpdateRange(start * 4, head * 4); this.attrMisc2.addUpdateRange(0, tail * 4)
      this.attrAxis.addUpdateRange(start * 3, head * 3); this.attrAxis.addUpdateRange(0, tail * 3)
    }
    this.attrPos.needsUpdate = true
    this.attrVel.needsUpdate = true
    this.attrCol.needsUpdate = true
    this.attrMisc.needsUpdate = true
    this.attrMisc2.needsUpdate = true
    this.attrAxis.needsUpdate = true
  }

  // -------------------------------------------------------------------------

  private destroyBoxes(): void {
    if (this.boxMesh) this.group.remove(this.boxMesh)
    if (this.boxGeo) this.boxGeo.dispose()
    if (this.boxMat) this.boxMat.dispose()
    this.boxMesh = null
    this.boxGeo = null
    this.boxMat = null
    this.boxScale = null
    this.attrBoxScale = null
    this.boxWasActive = null
    this.boxReady = false
  }

  private destroyShards(): void {
    if (this.shardMesh) this.group.remove(this.shardMesh)
    if (this.shardGeo) this.shardGeo.dispose()
    if (this.shardMat) this.shardMat.dispose()
    this.shardMesh = null
    this.shardGeo = null
    this.shardMat = null
    this.shardScale = null
    this.attrShardScale = null
    this.shardWasActive = null
    this.shardReady = false
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.destroyBoxes()
    this.destroyShards()
    this.pGeo.dispose()
    this.pMat.dispose()
    this.trailGeo.dispose()
    this.trailMat.dispose()
    this.wellGeoShell.dispose()
    this.wellGeoCore.dispose()
    this.empGeo.dispose()
    this.distGeo.dispose()
    for (let i = 0; i < this.wellShellMat.length; i++) this.wellShellMat[i].dispose()
    for (let i = 0; i < this.wellCoreMat.length; i++) this.wellCoreMat[i].dispose()
    for (let i = 0; i < this.empMat.length; i++) this.empMat[i].dispose()
    for (let i = 0; i < this.distMat.length; i++) this.distMat[i].dispose()
    this.group.clear()
    this.scene.remove(this.group)
  }
}

// ---------------------------------------------------------------------------

/**
 * Builds the VFX system and parents it to `scene`.
 *
 * Particle pool = clamp(POOL_BASE[tier] * quality.particleScale, 600, 8000):
 *   high   4000 * 1.00 = 4000
 *   medium 1800 * 0.80 = 1440
 *   low     800 * 0.45 =  600 (clamped up from 360)
 */
export function createVfx(scene: THREE.Scene, quality: RenderQuality): VfxSystem {
  return new Vfx(scene, quality)
}
