/**
 * SpaceGen Racing — post-processing.
 *
 * Chain (medium / high):
 *   RenderPass -> UnrealBloomPass -> Composite
 *
 * The composite pass folds the GLARE BUDGET (below), radial speed blur, radial
 * chromatic aberration, radial speed lines, an EMP/impact static burst and the
 * vignette into ONE fullscreen pass, and finishes with tone mapping plus the
 * output colour space transform. That last part is deliberate: it removes the
 * need for a separate OutputPass, so the whole chain costs two fullscreen
 * passes plus bloom rather than three. On a phone that difference is real.
 *
 * TONE MAPPING OWNERSHIP. While a composer exists this module takes the
 * renderer's tone mapping over: `renderer.toneMapping` is forced to
 * NoToneMapping and ACES is applied exactly once, here, at the end of the
 * composite. Without that every lit material tone maps into the composer
 * buffer and the composite tone maps the result a second time, which both
 * washes the image out (linear 1.0 lands at 0.72 sRGB instead of 1.0) and,
 * far worse for this game, flattens the particle system's HDR headroom before
 * bloom ever sees it — a 4.0 white-hot drift spark and a 1.0 blue one arrive
 * at the bloom threshold nearly identical. Rendering the scene linear keeps
 * that headroom intact, so bloom scales with tier the way the VFX intend.
 * dispose() puts the renderer back exactly as it found it.
 *
 * ---------------------------------------------------------------------------
 * THE GLARE BUDGET
 * ---------------------------------------------------------------------------
 *
 * Bloom used to be a fixed additive: `scene + 0.98 * blur(highpass(scene))`,
 * with nothing bounding the result. Measured on Cryostatic's blizzard band at
 * 338 km/h under a tier-3 boost, that put 37% of the lower-centre of the frame
 * — the road, the racing line, the barriers and the player's own car — past
 * scene-linear 1.16, which this tone curve renders as 232/255 or whiter. The
 * car's own screen rectangle lost 95% of its luminance gradient: not "hard to
 * see", *gone*. Turning the bloom pass off removed 85% of that whiteout and
 * turning the particle system off removed 90%, so the failure was the product
 * of the two: the boost plume is additive and piles up past scene-linear 4,
 * the high-pass passes that through unbounded, and the blur then spreads it
 * across a third of the frame at strength 0.98.
 *
 * That is the same bug the drift VFX shipped once before — an effect whose
 * gain was applied on top of a quantity that had already climbed — and it gets
 * the same shape of fix. There, every filled channel divided its own tier's
 * luminance back out so escalation was carried by hue, radius, count and
 * rhythm. Here, the glare divides out the light that is ALREADY at the pixel:
 *
 *   1. CEILING. The glare a single pixel may receive is soft-capped at
 *      GLARE_CEIL of scene-linear light (Reinhard, so weak glows keep ~90% of
 *      their tuned strength and only the runaway ones are held back). A
 *      white-hot plume core can no longer donate an unbounded amount of light
 *      to its neighbours; past the knee, extra source brightness buys extra
 *      RADIUS and extra core, not extra spill.
 *
 *   2. HEADROOM. What survives the ceiling is then scaled by how much room the
 *      underlying pixel has left. A pixel already reading as white gets
 *      GLARE_FLOOR of it; a dark pixel gets all of it. Glare therefore lands
 *      where glare belongs — on the dark surroundings of a bright thing — and
 *      cannot erase a surface that was already carrying information.
 *
 * This is the adaptive-bloom idea done PER PIXEL, and it is strictly better
 * than the frame-average version: an average needs the frame's luminance read
 * back to the CPU (a full pipeline stall every frame, which the iPhone 12 /
 * 778G floor cannot afford) and would still have dimmed the glow on a dark
 * corner because a bright straight raised the average. The per-pixel form
 * costs one texture fetch and two dot products in a pass that was already
 * running, and it is scene-adaptive for free — which matters because a fixed
 * strength over Cryostatic's bright fog and Rustfall's dark rust was the shape
 * of the original problem.
 *
 * Note what is NOT clamped: the bright thing itself. A plume core at
 * scene-linear 4 still renders at 250/255. Boosting still whites out the
 * exhaust. It just stops whiting out the corner.
 *
 * `quality.postFx === false` keeps bloom and the glare budget, and disables
 * everything else (the composite pass compiles without FX_FULL, so the extra
 * taps do not exist in the shader at all). Tone mapping still happens here.
 *
 * `quality.tier === 'low'` builds no composer whatsoever, renders straight to
 * the screen and leaves the renderer's own tone mapping alone.
 *
 * ---------------------------------------------------------------------------
 * THE BOOST WARP
 * ---------------------------------------------------------------------------
 *
 * `uBoost` is a LEVEL: it is up for as long as the boost is, so anything keyed
 * to it is a state of the picture, not an event in it. `uWarp` is the other
 * kind — the chase camera's live vertigo impulse, a punch with a 0.26s
 * half-life, handed straight over rather than re-derived here. Everything the
 * warp drives is therefore over in about half a second whether the boost is or
 * not, which is the difference between a moment and a fog.
 *
 * It buys four things, all inside the pass that was already running and none
 * of them a new tap:
 *
 *   1. A SECOND LINE LAYER at a finer angular pitch and a different phase
 *      rate, so the streak count roughly doubles at the punch instead of the
 *      same lines simply getting brighter.
 *   2. LENGTH. Both layers drop their falloff exponent, so a 26-power dash
 *      becomes a 9-power streak — the single biggest part of reading as warp
 *      rather than as noise.
 *   3. REACH. The radial mask opens inward from 0.34 to 0.16, so the streaks
 *      come past the corners and into the frame instead of decorating its rim.
 *   4. THE TUNNEL. The vignette's inner radius closes and its strength rises,
 *      which is the "tunnel vision" half of the shot.
 *
 * (4) IS ALSO THE COMFORT MEASURE, and that is not a coincidence: occluding
 * the periphery is the standard mitigation for vection sickness, because the
 * periphery is where the sense of self-motion is read from. The warp darkens
 * exactly the part of the frame that would otherwise be doing the most to make
 * a susceptible player queasy.
 *
 * WHAT THE WARP DELIBERATELY DOES NOT TOUCH is the forward zoom at the top of
 * the shader. That term scales the sampling coordinate, which changes the
 * on-screen size of everything including the car, and the entire contract of
 * the dolly zoom driving `uWarp` is that the car does NOT change size. Adding
 * warp there would have the shader quietly undo the camera's work.
 */
import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import type { RenderQuality } from './api'

export interface PostFx {
  /**
   * @param dt        frame delta, seconds
   * @param boost     0..1, VfxSystem.boostIntensity -- a sustained LEVEL, held
   *                  for as long as the boost lasts
   * @param hit       0..1, VfxSystem.hitFlash
   * @param speed01   0..1, local racer speed over top speed
   * @param warp      0..1, ChaseCamera.dollyLevel -- the live vertigo IMPULSE,
   *                  a punch that decays over about half a second. Taken from
   *                  the camera rather than re-derived from the boost state so
   *                  the screen warp and the camera move cannot fall out of
   *                  step, and -- the part that matters -- so the reduced-motion
   *                  suppression that zeroes the camera's impulse zeroes this
   *                  too, through one code path instead of two. This game has
   *                  already shipped a reduced-motion toggle that reached the
   *                  camera and not the effects.
   * @param calm      true = the player's reduced-motion setting is ON.
   *
   *                  `warp` arrives already suppressed, so everything the punch
   *                  drives is handled. This flag exists for the ONE new term
   *                  the punch does not carry: the sustained streak escalation,
   *                  which keys off `boost` and would otherwise hand a
   *                  reduced-motion player longer and brighter radial streaks
   *                  for the whole of every boost -- a strong vection cue,
   *                  arriving through a channel the toggle never touched.
   *
   *                  It suppresses the ESCALATION ONLY. The speed blur, the
   *                  lines at their shipped length, the aberration and the
   *                  vignette all behave exactly as they did before this
   *                  parameter existed; those are governed by the player's
   *                  Speed-effects control, which reduced motion already starts
   *                  at "Minimal", and quietly switching them off here would be
   *                  a behaviour change nobody asked for.
   */
  render(
    dt: number, boost: number, hit: number, speed01: number,
    warp?: number, calm?: boolean,
  ): void
  /**
   * The live shockfronts to bend the picture around, already projected into
   * this pass's own 0..1 screen space. Call it every frame, including with an
   * empty list: slots past the end are zeroed, and a slot left holding last
   * frame's blast freezes a lens on screen after the explosion that made it
   * has gone.
   */
  setBlasts(list: readonly Blast[]): void
  /** Pass the same logical width/height you pass to renderer.setSize(). */
  resize(w: number, h: number): void
  /**
   * Player-facing intensity for the two things that make the frame hard to
   * read. Both are 0..1 and both default to 1 = the tuned look.
   *
   * @param glare   bloom and highlight spill. 0 must mean NO bloom pass energy
   *                at all, not a small amount: this is the setting a player
   *                reaches for when a boost at speed has erased the road.
   * @param screen  the full-screen composite effects -- speed blur, speed
   *                lines, chromatic aberration, impact tear, vignette, and the
   *                boost warp. Separate from glare because they fail
   *                differently: glare hides the track behind light, screen
   *                effects smear it. 0 means NONE OF IT, warp included: the
   *                warp term is multiplied by this before it reaches a single
   *                line, radius or blur tap, so "Speed effects: Off" cannot
   *                produce speed lines on a boost.
   *
   * Independent of `RenderQuality`, which is about what the DEVICE can afford.
   * A high-end machine can still want the glare turned down.
   */
  setIntensity(glare: number, screen: number): void
  dispose(): void
}

const _size = new THREE.Vector2()

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * The player's last chosen intensity, remembered across PostFx instances.
 *
 * The adaptive quality scaler rebuilds the world — and therefore this whole
 * chain — mid-race whenever the frame budget slips, and the settings UI has no
 * reason to expect that. Without this, a player who turned the glare down
 * because a boost blinded them gets it handed straight back at the next
 * quality step-down, in the middle of the race, which is exactly the moment
 * they cannot afford it. setIntensity() is the only writer.
 */
let lastGlare = 1
let lastScreen = 1

/**
 * Most scene-linear light the glare pass may add to one pixel, before the
 * headroom term takes its cut. This tone curve (ACES at exposure 1.05) puts
 * scene-linear 1.16 at 232/255 and 4.0 at 250/255, and the road surface under
 * the blizzard sits near 0.3. 0.42 is therefore a glow you cannot miss on a
 * dark pixel — 52/255 lifts to 190/255 — while leaving a mid-bright road at
 * 216/255, under the point where its own value structure stops resolving.
 */
const GLARE_CEIL = 0.42
/**
 * Base luminance over which the headroom term closes, scene-linear. 0.25 is
 * about 152/255 and 1.10 is about 231/255 — i.e. it starts holding back once a
 * pixel is genuinely bright and is fully closed by the time that pixel is
 * already reading as white on its own.
 */
const GLARE_KNEE_LO = 0.25
const GLARE_KNEE_HI = 1.10
/**
 * Fraction of the (already capped) glare that still lands on a pixel with no
 * headroom left. Not zero: a hard cut at the knee makes the boundary between
 * "glowing" and "not glowing" visible as a contour crawling over the road.
 */
const GLARE_FLOOR = 0.10

/**
 * Shaping on the warp impulse before anything reads it.
 *
 * The camera's dolly is a straight exponential with a 0.26s half-life, which is
 * the right envelope for a camera MOVE and slightly too eager for a picture
 * effect: the streaks vanish while the car is still being shoved. A fractional
 * power keeps the peak where it is and fattens the tail — 0.65 leaves 63% of
 * the effect at one half-life instead of 50% — without ever making it non-zero
 * where the impulse is zero, which is the property reduced motion depends on.
 */
const WARP_SHAPE = 0.65

/**
 * How many shockfronts can bend the picture at once.
 *
 * Four, because the frame it has to survive is a pile-up: an Alpha hit, the
 * two cars it wrecks, and somebody boosting out of the mess. Past that the
 * displacements start cancelling anyway, and each slot is an unconditional
 * branch in a per-pixel loop, so the cost is paid on every frame whether the
 * slot is live or not -- which is exactly why the shader tests `w <= 0` and
 * skips, rather than there being ten of them.
 */
const MAX_BLASTS = 4

/** One live shockfront, in the composite's own 0..1 UV space. */
export interface Blast {
  /** Screen position, 0..1 across the frame. */
  x: number
  y: number
  /** Radius as a fraction of frame WIDTH (the shader corrects for aspect). */
  radius: number
  /** 0..1, already faded. 0 means the slot is idle. */
  strength: number
}

const COMPOSITE_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const COMPOSITE_FRAG = `
uniform sampler2D tDiffuse;
uniform vec2  uRes;
uniform float uTime;
uniform float uSpeed;
uniform float uBoost;
uniform float uHit;
uniform float uExposure;
uniform float uScreen;
uniform float uWarp;
uniform float uCalm;

/**
 * BLAST REFRACTION.
 *
 * Up to BLASTS shockfronts, each packed as (screen x, screen y, radius,
 * strength) with x/y/radius in the 0..1 UV space of this pass. Strength is
 * already faded and already multiplied by the player's screen-effect setting
 * on the CPU side, so a zero here means "draw nothing" with no second rule to
 * remember.
 *
 * The scene's own explosion meshes draw a dark sphere with a chromatic rim,
 * which LOOKS like a lens and refracts nothing: the geometry cannot see the
 * pixels behind it. This can, because by the time the composite runs the
 * scene is a texture.
 */
uniform vec4 uBlast[BLASTS];

#ifdef GLARE
uniform sampler2D tGlare;
uniform float uGlare;
uniform float uGlareCeil;
uniform float uGlareKneeLo;
uniform float uGlareKneeHi;
uniform float uGlareFloor;
#endif

varying vec2 vUv;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// three.js ACESFilmicToneMapping, inlined so it is applied exactly once, here,
// with the renderer's own tone mapping switched off for the scene pass.
vec3 rrtOdtFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

vec3 acesFilmic(vec3 color) {
  const mat3 ACESIn = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777)
  );
  const mat3 ACESOut = mat3(
    vec3( 1.60475, -0.10208, -0.00327),
    vec3(-0.53108,  1.10813, -0.07276),
    vec3(-0.07367, -0.00605,  1.07602)
  );
  color *= uExposure / 0.6;
  color = ACESIn * color;
  color = rrtOdtFit(color);
  color = ACESOut * color;
  return clamp(color, 0.0, 1.0);
}

void main() {
  vec2 uv = vUv;
  vec3 col;

#ifdef FX_FULL
  vec2 c = uv - 0.5;

  // Boost punch: a touch of forward zoom.
  //
  // uWarp is NOT in here, on purpose. This scales the sampling coordinate,
  // which resizes everything in the frame including the car, and the whole
  // contract of the dolly zoom that drives uWarp is that the car holds its
  // on-screen size while the world stretches behind it. See the header.
  c *= 1.0 - uBoost * 0.024 * uScreen;
  uv = c + 0.5;

  /**
   * THE SHOCKFRONT LENS.
   *
   * Displacement peaks ON THE EDGE of the blast and falls to zero at both the
   * centre and the outside, which is what a real pressure front does and what
   * "a distorting field within the explosion edge" means: the middle of a
   * fireball is opaque fire, and the interesting optics are in the thin shell
   * where the density gradient is.
   *
   * sin(PI * t) gives exactly that with no branching -- 0 at t=0, 1 at the
   * half-radius, 0 at the rim -- and squaring it tightens the band into
   * something that reads as a shell rather than a general blur.
   *
   * The aspect correction is not cosmetic: without it the ring is an ellipse
   * on any non-square frame, and at 2.25:1 on a phone in landscape it looks
   * like a horizontal smear rather than a blast.
   */
  float aspect = max(uRes.x, 1.0) / max(uRes.y, 1.0);
  for (int i = 0; i < BLASTS; i++) {
    vec4 b = uBlast[i];
    if (b.w <= 0.0004 || b.z <= 0.0001) continue;
    vec2 d = uv - b.xy;
    d.x *= aspect;
    float dist = length(d);
    float t = dist / b.z;
    if (t >= 1.0) continue;
    float shell = sin(3.14159265 * t);
    shell *= shell;
    // Outward along the front. The 0.06 is the displacement at full strength
    // as a fraction of the blast radius, so a big blast bends more of the
    // picture than a small one by construction rather than by a second knob.
    vec2 dir = dist > 1e-5 ? d / dist : vec2(0.0);
    dir.x /= aspect;
    uv += dir * shell * b.w * b.z * 0.06;
  }
  c = uv - 0.5;

  // Impact tear: whole rows slip sideways on a hard hit.
  float tear = step(0.60, uHit) * (hash11(floor(uv.y * 96.0) + floor(uTime * 26.0)) - 0.5);
  uv.x += tear * uHit * 0.030 * uScreen;
  c = uv - 0.5;

  float r = length(c);
  vec2 rdir = c / max(r, 1e-4);

  // Speed-driven effects only exist ABOVE cruising pace. Keyed to raw speed
  // they smeared the whole frame permanently — the track, the vehicles and
  // every particle with it — because a racing line is spent near top speed.
  // This makes overspeed and boost read as events instead of as a permanent
  // fog over the game.
  float over = clamp((uSpeed - 0.72) * 3.6, 0.0, 1.0);
  float rush = clamp(over * 0.45 + uBoost * 0.95, 0.0, 1.15) * uScreen;

  // THE WARP IMPULSE, with the player's screen-effect intensity already spent
  // on it. Every use below reads THIS and never uWarp, so one multiply is the
  // whole of "Speed effects: Off means no warp".
  float warp = pow(clamp(uWarp, 0.0, 1.0), WARP_SHAPE) * uScreen;
  // How stylised the streaks get: the sustained boost carries most of it and
  // the punch takes it the rest of the way, so a boost is always streakier
  // than cruising and the moment it lands is streakier still.
  //
  // uScreen is spent on the boost half here as well as on the amplitude below,
  // so the player's control scales the SHAPE and not only the brightness -- at
  // "Minimal" the streaks are short again, rather than full-length and dim.
  // warp already carries it.
  //
  // uCalm is 0 under reduced motion and it is here and nowhere else. warp is
  // already zero for those players, so the punch needs no guard; the BOOST
  // half does, because uBoost is a channel the toggle has never reached and
  // this is the only new thing hanging off it. At 0 the streaks are exactly
  // the shipped ones -- the escalation goes away, nothing else does.
  float streak = clamp(uBoost * 0.55 * uScreen * uCalm + warp * 1.00, 0.0, 1.0);

  // Radial chromatic aberration, strongest at the edges and on impact.
  float ca = ((0.0008 + uBoost * 0.0038 + uHit * 0.0080) * uScreen + warp * 0.0052)
    * (0.15 + r * 1.7);
  vec2 caOff = rdir * ca;

  col.r = texture2D(tDiffuse, uv + caOff).r;
  col.g = texture2D(tDiffuse, uv).g;
  col.b = texture2D(tDiffuse, uv - caOff).b;

  // Radial speed blur. Edge-weighted, so the middle third of the frame — the
  // vehicle, the apex, the drift sparks — stays readable at any speed.
  // The warp's share raised from 0.55: the tunnel was reported as too weak,
  // and smear at the rim is the half of it that sells SPEED rather than
  // darkness. Edge-weighted below, so the middle third -- car, apex, sparks --
  // stays readable however hard this is driven.
  float blur = (rush * rush + warp * warp * 0.95) * 0.34;
  if (blur > 0.012) {
    float edge = smoothstep(0.10, 0.62, r);
    float wsum = 1.0;
    for (int i = 1; i < TAPS; i++) {
      float t = float(i) / float(TAPS - 1);
      vec2 suv = 0.5 + c * (1.0 - t * blur * edge * 0.155);
      float w = 1.0 - t * 0.55;
      col += texture2D(tDiffuse, suv).rgb * w;
      wsum += w;
    }
    col /= wsum;
  }
#else
  col = texture2D(tDiffuse, uv).rgb;
#endif

#ifdef GLARE
  // THE GLARE BUDGET. See the header. UnrealBloomPass has already blended its
  // (strength-scaled) result additively into tDiffuse in linear float, so the
  // scene without glare is recoverable exactly by subtracting the same texture
  // it added — one extra fetch, no extra pass, no readback. Where the speed
  // blur has smeared tDiffuse the subtraction is approximate, which is why the
  // difference is clamped at zero; that only happens in the outer ring under
  // heavy blur, where the vignette is eating the frame anyway.
  if (uGlare > 0.0) {
    // THE ALPHA MULTIPLY IS NOT DECORATIVE. three's AdditiveBlending for a
    // non-premultiplied material is glBlendFunc(SRC_ALPHA, ONE), and the
    // bloom's own alpha is the high-pass smoothstep carried through the blur
    // chain -- so what the pass actually added to tDiffuse is rgb * a, and
    // subtracting rgb alone over-subtracts, drives base to zero across the
    // brightest third of the frame and then re-adds a full ceiling's worth of
    // glare on top of nothing. Measured: that made the blizzard band BRIGHTER
    // than the bug it was fixing (49.0% vs 37.5% of the road past white).
    vec4 gtex = texture2D(tGlare, uv);
    vec3 glare = gtex.rgb * gtex.a;
    vec3 base = max(col - glare, 0.0);

    // 1. Ceiling: no single pixel may receive more than uGlareCeil, and weak
    //    glows are barely touched.
    glare *= uGlareCeil / (uGlareCeil + dot(glare, LUMA));

    // 2. Headroom: and less than that wherever the pixel is already bright.
    float head = 1.0 - smoothstep(uGlareKneeLo, uGlareKneeHi, dot(base, LUMA));

    col = base + glare * (uGlare * mix(uGlareFloor, 1.0, head));
  }
#endif

#ifdef FX_FULL
  // Radial speed lines streaming outward from the centre. Sparse (a quarter of
  // the sectors carry a line at cruise, all of them under full boost), thin,
  // and confined to the outer ring -- until a boost, which lengthens them,
  // brings them inward, brightens them and lays a second, finer layer over the
  // top. See THE BOOST WARP in the header for why each of those four and not
  // "more of the same, harder".
  if (rush > 0.03 || warp > 0.02) {
    float ang = atan(c.y, c.x);
    // Streaks, not dashes: 26 is a hard little tick and 9 is a line with a
    // length you can read a direction off. This one exponent is most of what
    // separates "there are lines on the screen" from "the world is warping".
    float falloff = mix(26.0, 9.0, streak);
    // ...and they come in off the rim as the punch lands, so the tunnel has
    // walls rather than a decorated border.
    float inner = mix(0.34, 0.16, streak);
    // The lines still need SOMETHING to ride on -- at a standstill under a
    // warp there is no rush at all -- so the punch supplies its own.
    float amp = clamp(max(rush, warp * 0.9), 0.0, 1.0);
    float sector = floor(ang * 34.0);
    float seed = hash11(sector + 11.0);
    float gate = step(hash11(sector + 71.0), 0.18 + 0.82 * amp);
    float ph = fract(r * 1.7 - uTime * (1.1 + 3.2 * amp) + seed * 9.0);
    float line = pow(max(0.0, 1.0 - abs(ph * 2.0 - 1.0)), falloff);
    float mask = smoothstep(inner, 0.92, r) * amp;
    vec3 lineCol = mix(vec3(0.72, 0.86, 1.0), vec3(1.0, 0.88, 0.58), clamp(uBoost, 0.0, 1.0));
    col += lineCol * line * gate * mask * (0.42 + 0.55 * streak);

    // THE SECOND LAYER. Costs two hashes, a fract and a pow -- no texture
    // fetch, no pass -- and it is what actually makes the count go up. A
    // deliberately non-multiple pitch (61 against 34) and a faster phase rate
    // so the two never beat against each other into a visible moire.
    if (streak > 0.02) {
      float s2 = floor(ang * 61.0);
      float sd2 = hash11(s2 + 5.0);
      float g2 = step(hash11(s2 + 29.0), 0.10 + 0.90 * streak);
      float p2 = fract(r * 2.6 - uTime * (2.2 + 5.4 * streak) + sd2 * 7.0);
      float l2 = pow(max(0.0, 1.0 - abs(p2 * 2.0 - 1.0)), mix(20.0, 7.0, streak));
      col += lineCol * l2 * g2 * smoothstep(inner * 0.8, 1.0, r) * streak * 0.46;
    }
  }

  // EMP / impact static. Deliberately restrained: the item that hit you is
  // identified by the colour of the burst in the world, and a full-screen
  // white-out erases exactly that.
  float hit = uHit * uScreen;
  if (hit > 0.01) {
    float st = hash21(uv * uRes * 0.4 + uTime * 137.0);
    col = mix(col, col * (0.66 + st * 0.72), hit * 0.32);
    col += vec3(0.07, 0.20, 0.38) * st * hit * 0.22;
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, vec3(lum) * vec3(0.80, 0.93, 1.16), hit * 0.16);
  }

  // Vignette, tightening under boost -- and CLOSING under a warp punch, which
  // is the tunnel-vision half of the shot. Both ends of the ramp move, so the
  // dark does not merely get darker at the rim, it walks inward.
  //
  // STRENGTHENED: inner 0.15 -> 0.24 and weight 0.30 -> 0.46. At a full punch
  // the dark now starts at 0.08 of the radius instead of 0.17 and takes the
  // rim to 54% brightness instead of 70%, which is the difference between a
  // darker edge and an actual tunnel. It is a grade, not a move, so it costs
  // nothing in motion comfort -- and it is the effect a player boosts FOR,
  // which is why it is dialled up in the same pass that dialled the camera
  // shove down.
  //
  // The rim is dimmed, never crushed: mix() bottoms out at 1 - weight, so even
  // at full warp the periphery keeps over half its light. The lesson from the
  // glare pass applies in reverse here -- a surface that still carries
  // information must keep carrying it.
  float vig = 1.0 - smoothstep(0.32 - 0.24 * warp, 1.08 - 0.24 * warp, r);
  col *= mix(1.0, vig, (0.34 + uBoost * 0.24) * uScreen + warp * 0.46);
#endif

  gl_FragColor = vec4(acesFilmic(max(col, 0.0)), 1.0);
  #include <colorspace_fragment>
}
`

class PostFxImpl implements PostFx {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene: THREE.Scene
  private readonly camera: THREE.Camera
  private readonly full: boolean
  private readonly bloomScale: number

  private composer: EffectComposer | null = null
  private renderPass: RenderPass | null = null
  private bloom: UnrealBloomPass | null = null
  private composite: ShaderPass | null = null
  private compositeMat: THREE.ShaderMaterial | null = null

  private time = 0
  private speedSmooth = 0
  private disposed = false

  /** Renderer tone mapping as we found it, restored on dispose. */
  private prevToneMapping: THREE.ToneMapping | null = null

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    quality: RenderQuality,
  ) {
    this.renderer = renderer
    this.scene = scene
    this.camera = camera
    this.full = quality.postFx
    this.bloomScale = quality.tier === 'high' ? 1.0 : 0.62

    if (quality.tier === 'low') return

    renderer.getSize(_size)
    const w = Math.max(1, _size.x)
    const h = Math.max(1, _size.y)

    // Take tone mapping off the renderer BEFORE anything compiles, so the
    // scene renders linear into the composer's half-float buffer and every
    // material's `#include <tonemapping_fragment>` becomes the no-op it was
    // always documented to be. The composite below applies ACES once.
    this.prevToneMapping = renderer.toneMapping
    renderer.toneMapping = THREE.NoToneMapping

    const composer = new EffectComposer(renderer)
    this.composer = composer

    this.renderPass = new RenderPass(scene, camera)
    composer.addPass(this.renderPass)

    // Bloom on emissives. Thresholds are in LINEAR light now, not in
    // post-tone-map display values. Track surfaces sit around 0.15 and lit
    // paint under 0.5, so 0.78 leaves a wide dead band before the particle
    // system's deliberate >1 colours, and the sky and the light strips — the
    // only scene geometry meant to glow — clear it on their own. That
    // headroom is what makes a tier-3 drift spark bloom harder than a tier-0
    // one instead of both clipping to the same white.
    //
    // Strength stays where it was tuned: with the glare budget in the
    // composite bounding the result, strength now only governs how weak glows
    // read, and raising the threshold instead was measured and rejected — at
    // threshold 2.5 the blizzard-band whiteout only fell from 37.8% to 34.9%,
    // because the energy is coming from the additive pile-up in the plume
    // core, which is far above any threshold worth setting.
    const strength = quality.tier === 'high' ? 0.98 : 0.82
    const radius = quality.tier === 'high' ? 0.68 : 0.56
    const threshold = quality.tier === 'high' ? 0.78 : 0.72
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), strength, radius, threshold)
    composer.addPass(this.bloom)

    // BLASTS is UNCONDITIONAL. The uniform array and the loop that reads it
    // sit outside the FX_FULL guard -- a shockfront bending the picture is the
    // substance of the effect, not a flourish on top of one -- so the define
    // has to exist on every path or the low tier fails to compile the whole pass and
    // loses its post-processing entirely.
    const defines: Record<string, string> = { GLARE: '', BLASTS: String(MAX_BLASTS) }
    if (this.full) {
      defines.FX_FULL = ''
      defines.TAPS = quality.tier === 'high' ? '6' : '4'
      // A define rather than a uniform: it never changes at runtime, and a
      // constant exponent is one the compiler can fold.
      defines.WARP_SHAPE = WARP_SHAPE.toFixed(3)
    }

    const mat = new THREE.ShaderMaterial({
      name: 'SpaceGenComposite',
      defines,
      uniforms: {
        tDiffuse: { value: null },
        // The bloom pass's own output, BEFORE it was blended into tDiffuse.
        // This is the texture UnrealBloomPass hands to its additive blend, so
        // reading it here is reading exactly what it added.
        tGlare: { value: this.bloom.renderTargetsHorizontal[0].texture },
        uRes: { value: new THREE.Vector2(w, h) },
        uTime: { value: 0 },
        uSpeed: { value: 0 },
        uBoost: { value: 0 },
        uHit: { value: 0 },
        uExposure: { value: renderer.toneMappingExposure },
        uGlare: { value: lastGlare },
        uScreen: { value: lastScreen },
        uWarp: { value: 0 },
        uCalm: { value: 1 },
        // Fixed-length: a GLSL array uniform cannot be resized, and a
        // re-compile mid-race to add a slot would hitch the frame.
        uBlast: {
          value: Array.from({ length: MAX_BLASTS }, () => new THREE.Vector4(0, 0, 0, 0)),
        },
        uGlareCeil: { value: GLARE_CEIL },
        uGlareKneeLo: { value: GLARE_KNEE_LO },
        uGlareKneeHi: { value: GLARE_KNEE_HI },
        uGlareFloor: { value: GLARE_FLOOR },
      },
      vertexShader: COMPOSITE_VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
    this.compositeMat = mat
    this.composite = new ShaderPass(mat)
    composer.addPass(this.composite)

    this.resize(w, h)
    // Re-apply whatever the player last chose, including the bloom pass being
    // switched off entirely at glare 0.
    this.setIntensity(lastGlare, lastScreen)
  }

  /**
   * Hand over the live shockfronts, already projected to screen space.
   *
   * Called every frame with however many there are, including none; slots past
   * `list.length` are zeroed rather than left holding the last frame's blast,
   * which would freeze a lens in the middle of the screen the moment the
   * explosion that made it expired.
   */
  setBlasts(list: readonly Blast[]): void {
    const mat = this.compositeMat
    if (mat === null) return
    const arr = mat.uniforms.uBlast.value as THREE.Vector4[]
    for (let i = 0; i < MAX_BLASTS; i++) {
      const b = i < list.length ? list[i] : null
      const v = arr[i]
      if (b === null) { v.set(0, 0, 0, 0); continue }
      v.set(
        b.x, b.y,
        b.radius < 0 ? 0 : b.radius,
        b.strength < 0 ? 0 : b.strength > 1 ? 1 : b.strength,
      )
    }
  }

  render(
    dt: number, boost: number, hit: number, speed01: number,
    warp = 0, calm = false,
  ): void {
    if (this.disposed) return
    const d = dt > 0.1 ? 0.1 : dt < 0 ? 0 : dt
    this.time += d

    // Speed drives blur and streaks, so a little smoothing keeps it from
    // strobing when the sim clamps or a collision spikes it.
    const k = 1 - Math.pow(0.02, d)
    const s = speed01 < 0 ? 0 : speed01 > 1 ? 1 : speed01
    this.speedSmooth += (s - this.speedSmooth) * k

    const composer = this.composer
    if (composer === null) {
      this.renderer.render(this.scene, this.camera)
      return
    }

    const mat = this.compositeMat
    if (mat !== null) {
      mat.uniforms.uTime.value = this.time
      mat.uniforms.uSpeed.value = this.speedSmooth
      mat.uniforms.uBoost.value = boost < 0 ? 0 : boost > 1 ? 1 : boost
      mat.uniforms.uHit.value = hit < 0 ? 0 : hit > 1 ? 1 : hit
      // NOT smoothed on this side. A CPU-side tail would keep running for its
      // own half-life after the source went to zero, which is a leak of exactly
      // the motion reduced motion exists to remove -- the caller's value is
      // already suppressed at source, so passing it straight through is what
      // makes "toggle on, effect gone, this frame" true. The tail is shaped in
      // the shader instead, by WARP_SHAPE, which is zero at zero.
      mat.uniforms.uWarp.value = warp < 0 ? 0 : warp > 1 ? 1 : warp
      mat.uniforms.uCalm.value = calm ? 0 : 1
      mat.uniforms.uExposure.value = this.renderer.toneMappingExposure
    }

    composer.render(d)
  }

  /**
   * Cheap enough to call every frame: four number writes and a boolean. No
   * shader recompile, no allocation, no render-target churn.
   *
   * Per tier:
   *   high / medium  glare scales the glare budget and, at 0, removes the
   *                  bloom pass from the chain outright; screen scales every
   *                  composite effect and, at 0, skips their taps as well.
   *   low            no composer exists, so there is nothing to scale — the
   *                  values are recorded and applied if the tier ever comes
   *                  back up. (`low` also has postFx false, so a Game running
   *                  it usually holds no PostFx at all.)
   */
  setIntensity(glare: number, screen: number): void {
    const g = clamp01(glare)
    const s = clamp01(screen)
    lastGlare = g
    lastScreen = s
    if (this.disposed) return

    // glare 0 means NO bloom energy: drop the pass from the chain rather than
    // multiplying its output by zero. EffectComposer skips a disabled pass
    // entirely, so this is also the cheapest the renderer ever gets — five
    // blur mip pairs and a composite that no longer run at all.
    if (this.bloom !== null) this.bloom.enabled = g > 0

    const mat = this.compositeMat
    if (mat === null) return
    // With the bloom pass disabled its render target still holds the last
    // frame it drew, so the shader must not subtract it back out; uGlare is
    // what tells it that, and it is the same uniform that scales the budget.
    mat.uniforms.uGlare.value = g
    mat.uniforms.uScreen.value = s
  }

  resize(w: number, h: number): void {
    if (this.disposed) return
    const width = Math.max(1, Math.floor(w))
    const height = Math.max(1, Math.floor(h))
    const composer = this.composer
    if (composer === null) return

    composer.setPixelRatio(this.renderer.getPixelRatio())
    composer.setSize(width, height)

    // composer.setSize() has just reset the bloom targets to full resolution.
    // Pull them back down on anything below the high tier.
    if (this.bloom !== null && this.bloomScale !== 1.0) {
      const pr = this.renderer.getPixelRatio()
      this.bloom.setSize(
        Math.max(1, Math.floor(width * pr * this.bloomScale)),
        Math.max(1, Math.floor(height * pr * this.bloomScale)),
      )
    }

    if (this.compositeMat !== null) {
      this.renderer.getDrawingBufferSize(_size)
      const res = this.compositeMat.uniforms.uRes.value as THREE.Vector2
      res.set(Math.max(1, _size.x), Math.max(1, _size.y))
      // setSize() resizes the bloom's targets in place, but re-point the
      // uniform anyway so a three release that swaps the target out cannot
      // leave the composite subtracting a dead texture.
      if (this.bloom !== null) {
        this.compositeMat.uniforms.tGlare.value = this.bloom.renderTargetsHorizontal[0].texture
      }
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.prevToneMapping !== null) {
      this.renderer.toneMapping = this.prevToneMapping
      this.prevToneMapping = null
    }
    if (this.bloom !== null) this.bloom.dispose()
    if (this.composite !== null) this.composite.dispose()
    if (this.renderPass !== null) this.renderPass.dispose()
    if (this.compositeMat !== null) this.compositeMat.dispose()
    if (this.composer !== null) this.composer.dispose()
    this.composer = null
    this.bloom = null
    this.composite = null
    this.renderPass = null
    this.compositeMat = null
  }
}

/**
 * Builds the post chain for the given quality tier.
 *
 *   low    -> no composer at all, renderer.render() straight through
 *   medium -> RenderPass + bloom (0.62x targets) + composite (glare + full FX)
 *   high   -> RenderPass + bloom (1.0x targets)  + composite (glare + full FX,
 *             6 taps)
 *
 * A tier with `postFx: false` keeps the bloom and the glare budget but compiles
 * the composite pass without FX_FULL, so it costs one cheap blit that also does
 * the tone mapping.
 *
 * Anything other than the low tier takes ownership of `renderer.toneMapping`
 * for as long as it lives; dispose() hands it back.
 */
export function createPostFx(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  quality: RenderQuality,
): PostFx {
  return new PostFxImpl(renderer, scene, camera, quality)
}
