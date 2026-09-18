/**
 * SpaceGen Racing — the shared pooled particle system.
 * ---------------------------------------------------------------------------
 * ONE instanced quad buffer, ONE draw call, ONE shader. The CPU writes 17
 * floats once, on spawn, and never touches that particle again; per frame it
 * bumps `uTime` and the camera position and nothing else. Every spark, puff,
 * ring, shockwave, shell, light-beam and bead in the game comes out of here.
 *
 * WHY THIS IS ITS OWN FILE.
 *
 * It was born inside render/vfx.ts and lived there for the whole of the race
 * VFX work, which was right while there was exactly one consumer. The podium
 * scene is the second: it needs confetti and fireworks, and those are the same
 * three kinds this shader already draws (K_BEAD for a shiny scrap of foil,
 * K_SPARK for a firework streak, K_SHELL for the burst front). The choice was
 * to copy ~200 lines of very carefully measured GLSL — the analytic drag
 * integral, the three near-fade windows, the four-term bead profile, all of
 * which carry measurements in their comments — or to move it once and import
 * it twice. Duplicated, the second copy would drift away from the first and
 * every measurement above would silently become a claim about the other file.
 *
 * NOTHING ABOUT THE PARTICLE BEHAVIOUR CHANGED IN THE MOVE. The shaders are
 * byte-identical, the attribute layout is identical, and `rnd` is injected
 * rather than captured so vfx.ts keeps drawing from exactly the stream it drew
 * from before (Math.random, in the same order) — a pool with its own generator
 * would have re-rolled every existing effect's noise and moved every probe
 * screenshot for no reason.
 */
import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Particle kinds. Must match the branch order in the shaders below.
// ---------------------------------------------------------------------------

/** soft round glow with a hot core */
export const K_SPRITE = 0
/** velocity-stretched streak */
export const K_SPARK = 1
/** camera-facing expanding annulus */
export const K_RING = 2
/** ground-aligned expanding annulus (lies in the plane normal to aAxis) */
export const K_GROUND = 3
/** bright annulus with a punched-out dark core */
export const K_SHELL = 4
/** soft low-contrast puff */
export const K_SMOKE = 5
/** aAxis-aligned light column */
export const K_BEAM = 6
/**
 * A SHINY GLOWING MARBLE: a filled round body with a rim and an off-centre
 * specular highlight, billboarded, and — the whole point — NOT stretched along
 * its velocity the way K_SPARK is. See the four-term profile in PARTICLE_FRAG.
 */
export const K_BEAD = 7

export const PARTICLE_VERT = `
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
  } else if (kind < 6.5) {       // beam
    a = sin(u * 3.14159265);
  } else {                       // bead
    // A marble does not fade the moment it is thrown. ^1.25 rather than the
    // spark's ^1.7 keeps the mean bead at 55% of its brightness across its
    // life instead of 37%, which is what lets one that lands and settles still
    // be worth looking at a second later. The sine is a slow TWINKLE, not a
    // flicker: half the spark's rate and a fifth of its depth, so it reads as
    // a highlight catching the light rather than as a strobe.
    a = smoothstep(0.0, 0.035, u) * pow(1.0 - u, 1.25)
      * (0.88 + 0.12 * sin(vSeed * 61.0 + age * 31.0));
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
  //
  // BEADS GET A THIRD WINDOW, and it was MEASURED, not assumed. An impact
  // bead is a FILLED disc up to 0.9 m across thrown backwards down the road,
  // and the chase camera is nine metres behind the car: solid angle goes as
  // (size/distance)^2, so the same bead that is 70 px tall where it is made is
  // 260 px tall at 2.5 m. Photographed at the default 1.1-4.2 window, a slam
  // put a dozen of those over the lens and the frame went flat magenta --
  // additive, so it tinted the sky and the horizon too.
  //
  // 2.4-8.5, which is very nearly the SMOKE window, and for the same reason
  // smoke has one: a bead is the only other kind that is both large and left
  // BEHIND the car, so it is the only other kind the camera genuinely flies
  // through rather than past. Every settled marble on the road passes within a
  // couple of metres of a lens that is nine metres behind the car. Measured at
  // 1.8-5.6 a slam photographed 0.82% of the frame and 3.52% of the ROAD BAND
  // blown a quarter-second in -- a boost's numbers, for an impact -- and
  // almost all of it came from four beads close enough to fill a sixth of the
  // frame each. At 2.4-8.5 the burst where it is MADE is untouched: the
  // contact point is eleven metres from the lens.
  float dcam = distance(wp, uCamPos);
  float near = (kind > 4.5 && kind < 5.5)
    ? smoothstep(2.6, 9.5, dcam)
    : (kind > 6.5)
      ? smoothstep(2.4, 8.5, dcam)
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
  } else if (kind > 5.5 && kind < 6.5) {
    // Light column along aAxis, billboarded around it. cross(aAxis, f) with
    // aAxis = +Y is exactly (f.z, 0, -f.x), the vector this replaces.
    vec3 f = uCamPos - wp;
    vec3 rw = normalize(cross(aAxis, f) + vec3(1e-5, 0.0, 0.0));
    vec3 wo = wp + rw * (position.x * size) + aAxis * (position.y * size * 9.0);
    mv = modelViewMatrix * vec4(wo, 1.0);
  } else if (kind > 0.5 && kind < 1.5) {
    // Spark: stretch along the screen-space velocity direction.
    //
    // THE SIGN OF pp IS LOAD-BEARING AND IT WAS WRONG FOR THE WHOLE LIFE OF
    // THIS SHADER. The quad is mapped position.x -> pp, position.y -> dir, so
    // the 2x2 that lays it out has columns (pp, dir) and its determinant is
    // what decides the triangle's winding. With pp = (-dir.y, dir.x):
    //
    //     det = pp.x*dir.y - pp.y*dir.x = -dir.y^2 - dir.x^2 = -1
    //
    // -- negative for EVERY spark at EVERY velocity, because dir is a unit
    // vector. So every spark quad wound backwards, and the material is
    // FrontSide, so the rasteriser threw all of them away. Not some of them
    // under some camera: all of them, always, since the kind was written.
    // Every drift spark, boost spark, wall-impact spark and weapon-hit spark
    // in the game was culled before it reached a pixel, and no probe caught
    // it because every spark gate in this repo counted spawns rather than
    // photons. tools/probe-kinds.mjs now counts photons.
    //
    // pp = (dir.y, -dir.x) puts the determinant at +1 and the quad draws.
    // side: DoubleSide on the material below makes the whole class of
    // mistake harmless for every kind, and this sign correct as well.
    mv = modelViewMatrix * vec4(wp, 1.0);
    vec3 vv = (modelViewMatrix * vec4(aVel * exp(-k * age), 0.0)).xyz;
    vec2 d = vv.xy;
    float dl = length(d);
    vec2 dir = (dl > 1e-4) ? d / dl : vec2(0.0, 1.0);
    vec2 pp = vec2(dir.y, -dir.x);
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

export const PARTICLE_FRAG = `
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
  } else if (vKind < 6.5) {      // beam
    float w = 1.0 - smoothstep(0.0, 1.0, abs(q.x));
    a = w * w * (1.0 - smoothstep(-0.3, 1.0, q.y)) * 0.85;
  } else {                       // bead: a shiny glowing marble
    // FOUR TERMS, AND THEY ARE FOUR DIFFERENT JOBS.
    //
    // body   a filled disc with an EDGE. This is the whole reason the kind
    //        exists: a gaussian puff has no silhouette, and a thing without a
    //        silhouette is not an object, it is a glow. 0.62 alpha, which at
    //        TUNING.sparks.lum puts the body just over the bloom threshold and
    //        a long way under the point ACES flattens every hue to white.
    // shade  a sphere, not a coin. Cheap Lambert-ish falloff toward the rim.
    // spec   THE SHINE, and the only part of a bead allowed to clip. It is
    //        about six pixels across at a realistic chase distance, so it can
    //        carry 2.25x the colour -- and 2.25x a SATURATED colour still
    //        blooms white, which is what "shiny" looks like -- without taking
    //        the hue of the other nine hundred pixels with it.
    // rim    a thin bright edge. This is what stops a bead 40 m away, where
    //        the specular is sub-pixel, from collapsing into a flat dot.
    // halo   a little light bleeding past the silhouette, so it GLOWS instead
    //        of merely being bright. Held to 0.09 and tight, and that number
    //        was MEASURED down from 0.20: this is the only term that covers
    //        the whole quad, so it is the only one whose cost scales with the
    //        square of the bead's screen size, and at 0.20 a slam's worth of
    //        near-camera beads laid a flat additive wash over the sky.
    float body = 1.0 - smoothstep(0.62, 0.96, d);
    float shade = 0.62 + 0.38 * (1.0 - d * d);
    vec2 hp = q - vec2(-0.30, 0.32);
    float spec = exp(-dot(hp, hp) * 30.0);
    float rim = exp(-(d - 0.80) * (d - 0.80) * 60.0) * 0.42;
    float halo = exp(-d * d * 3.4) * 0.13;
    a = body * (shade * 0.70 + rim) + spec * 1.55 + halo;
  }

  a *= vA;
  if (a < 0.004) discard;

  // Premultiplied additive: CustomBlending is ONE / ONE.
  gl_FragColor = vec4(vCol * a, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/**
 * The pool.
 *
 * A ring buffer of instance slots. `spawn` writes one slot and advances the
 * head; `flush` marks only the slots this frame touched as dirty, which is why
 * a 4000-particle buffer costs a few hundred floats of upload per frame rather
 * than 68KB.
 */
export class ParticlePool {
  /** Instance slots. */
  readonly count: number
  /** Most slots one frame may claim, so a single pile-up cannot wipe the ring. */
  readonly frameBudget: number
  readonly geometry: THREE.InstancedBufferGeometry
  readonly material: THREE.ShaderMaterial
  readonly mesh: THREE.Mesh

  /**
   * SECONDS INTO THE FUTURE THE NEXT spawn() IS BORN.
   *
   * The shader discards anything whose age is negative (`u < 0.0` takes the
   * same early-out as a dead particle), so a particle written now with a birth
   * stamp in the future is invisible until that moment and then plays normally.
   * That is the whole mechanism behind a bouncing spark and behind a firework
   * whose shell, flash and streamers are written in one call.
   *
   * THE COST, stated plainly: a delayed particle occupies its ring-buffer slot
   * from the moment it is written, not from the moment it appears.
   *
   * A current-value rather than an argument, because it would otherwise be one
   * more parameter on every one of eighty spawn sites. Reset by beginFrame so a
   * delay can never leak out of the emitter that set it.
   */
  delay = 0

  private axX = 0
  private axY = 1
  private axZ = 0

  private head = 0
  private spawnStart = 0
  private spawnCount = 0
  private time = 0

  /**
   * THE RAW INSTANCE BUFFERS, PUBLIC ON PURPOSE.
   *
   * Not an encapsulation slip: tools/probe-sparks.ts reads every one of them to
   * re-integrate a particle's ballistic arc on the CPU and check where it
   * actually lands, which is a thing no screenshot can answer and no private
   * field can be asked. They are documented as diagnostics and the game never
   * touches them from outside.
   *
   *   aPos   x,y,z        spawn position
   *   aVel   x,y,z        spawn velocity
   *   aCol   r,g,b        linear colour, pre-multiplied by its gain
   *   aMisc  birth, life, size0, growth
   *   aMisc2 gravity, drag, kind, seed
   *   aAxis  x,y,z        the particle's up (see PARTICLE_VERT)
   */
  readonly aPos: Float32Array
  readonly aVel: Float32Array
  readonly aCol: Float32Array
  readonly aMisc: Float32Array
  readonly aMisc2: Float32Array
  readonly aAxis: Float32Array
  private readonly attrPos: THREE.InstancedBufferAttribute
  private readonly attrVel: THREE.InstancedBufferAttribute
  private readonly attrCol: THREE.InstancedBufferAttribute
  private readonly attrMisc: THREE.InstancedBufferAttribute
  private readonly attrMisc2: THREE.InstancedBufferAttribute
  private readonly attrAxis: THREE.InstancedBufferAttribute
  private readonly rnd: () => number

  /**
   * @param count  instance slots
   * @param rnd    uniform [0,1). Injected so a caller can keep its own stream;
   *               vfx.ts passes Math.random, which is what it always used.
   */
  constructor(count: number, rnd: () => number = Math.random) {
    this.count = count
    this.frameBudget = Math.max(48, count >> 2)
    this.rnd = rnd

    this.aPos = new Float32Array(count * 3)
    this.aVel = new Float32Array(count * 3)
    this.aCol = new Float32Array(count * 3)
    this.aMisc = new Float32Array(count * 4)
    this.aMisc2 = new Float32Array(count * 4)
    // Seeded to world +Y, so a particle written by a path that never sets an
    // axis behaves exactly as it did before this attribute existed.
    this.aAxis = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) this.aAxis[i * 3 + 1] = 1

    const quad = new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ])
    const geo = new THREE.InstancedBufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(quad, 3))
    geo.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1))
    geo.instanceCount = count
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
    this.geometry = geo

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCamPos: { value: new THREE.Vector3() },
      },
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // EVERY QUAD IN THIS POOL IS A BILLBOARD, so back-face culling can only
      // ever subtract: a flat camera-facing quad is seen from one side, never
      // both, so culling rejects nothing it should keep -- unless a branch
      // happens to build its basis left-handed, in which case it silently
      // rejects EVERYTHING that kind ever emits. That is exactly what happened
      // to K_SPARK (see the note in the vertex shader). Three of the branches
      // above build their basis from cross products or from a velocity, and
      // none of them declare a handedness convention, so the next one is a
      // coin flip. DoubleSide takes the coin away at no cost.
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    })

    this.mesh = new THREE.Mesh(this.geometry, this.material)
    this.mesh.frustumCulled = false
    this.mesh.matrixAutoUpdate = false
    this.mesh.renderOrder = 20
  }

  /**
   * THE AXIS EVERY PARTICLE SPAWNED FROM NOW ON IS BORN WITH.
   *
   * World +Y for anything that belongs to the world; a racer's own up on a
   * gravity track, so a shockwave on a wall spreads across the wall. Three
   * things in the shader read it: the drag/gravity arc, the ground-aligned
   * annulus and the light column.
   */
  setAxis(x: number, y: number, z: number): void {
    this.axX = x; this.axY = y; this.axZ = z
  }

  /** How many slots are still claimable this frame. */
  get budgetLeft(): number {
    return this.frameBudget - this.spawnCount
  }

  /**
   * Particles written since the last beginFrame(). Diagnostics only, and the
   * probes depend on it: tools/probe-driftfx.mjs asks "are the emitters
   * actually running" by watching this climb, and with nothing to read it
   * reported -1, compared -1 against 0, and passed without measuring anything.
   */
  get spawnedThisFrame(): number {
    return this.spawnCount
  }

  /** Open a frame: set the clock and the camera, reset the per-frame budget. */
  beginFrame(time: number, cx: number, cy: number, cz: number): void {
    this.time = time
    this.spawnStart = this.head
    this.spawnCount = 0
    // A delayed birth must never leak out of the emitter that set it.
    this.delay = 0
    this.material.uniforms.uTime.value = time
    ;(this.material.uniforms.uCamPos.value as THREE.Vector3).set(cx, cy, cz)
  }

  spawn(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    r: number, g: number, b: number,
    life: number, size: number, growth: number,
    gravity: number, drag: number, kind: number,
  ): void {
    if (this.spawnCount >= this.frameBudget) return
    const i = this.head
    this.head = i + 1 >= this.count ? 0 : i + 1
    this.spawnCount++

    const i3 = i * 3
    const i4 = i * 4
    const p = this.aPos, v = this.aVel, c = this.aCol, m = this.aMisc, m2 = this.aMisc2
    p[i3] = x; p[i3 + 1] = y; p[i3 + 2] = z
    v[i3] = vx; v[i3 + 1] = vy; v[i3 + 2] = vz
    c[i3] = r; c[i3 + 1] = g; c[i3 + 2] = b
    m[i4] = this.time + this.delay; m[i4 + 1] = life; m[i4 + 2] = size; m[i4 + 3] = growth
    m2[i4] = gravity; m2[i4 + 1] = drag; m2[i4 + 2] = kind; m2[i4 + 3] = this.rnd()
    const a = this.aAxis
    a[i3] = this.axX; a[i3 + 1] = this.axY; a[i3 + 2] = this.axZ
  }

  /** Spherical burst helper. dirBias steers the cone; spread 1 = full sphere. */
  burst(
    x: number, y: number, z: number,
    dx: number, dy: number, dz: number,
    count: number, speed: number, spread: number,
    col: Float32Array, gain: number,
    life: number, size: number, kind: number,
    gravity: number, drag: number,
  ): void {
    const rnd = this.rnd
    const n = Math.min(count, this.frameBudget - this.spawnCount)
    for (let i = 0; i < n; i++) {
      const rx = rnd() * 2 - 1, ry = rnd() * 2 - 1, rz = rnd() * 2 - 1
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

  /**
   * Upload only what this frame wrote.
   *
   * The ring can wrap mid-frame, which is why there are three branches: one
   * range, two ranges, or the whole buffer when a frame claimed every slot.
   */
  flush(): void {
    if (this.spawnCount === 0) return
    const n = this.spawnCount
    const start = this.spawnStart
    const pool = this.count
    this.attrPos.clearUpdateRanges()
    this.attrVel.clearUpdateRanges()
    this.attrCol.clearUpdateRanges()
    this.attrMisc.clearUpdateRanges()
    this.attrMisc2.clearUpdateRanges()
    this.attrAxis.clearUpdateRanges()
    if (n >= pool) {
      this.attrPos.addUpdateRange(0, pool * 3)
      this.attrVel.addUpdateRange(0, pool * 3)
      this.attrCol.addUpdateRange(0, pool * 3)
      this.attrMisc.addUpdateRange(0, pool * 4)
      this.attrMisc2.addUpdateRange(0, pool * 4)
      this.attrAxis.addUpdateRange(0, pool * 3)
    } else if (start + n <= pool) {
      this.attrPos.addUpdateRange(start * 3, n * 3)
      this.attrVel.addUpdateRange(start * 3, n * 3)
      this.attrCol.addUpdateRange(start * 3, n * 3)
      this.attrMisc.addUpdateRange(start * 4, n * 4)
      this.attrMisc2.addUpdateRange(start * 4, n * 4)
      this.attrAxis.addUpdateRange(start * 3, n * 3)
    } else {
      const head = pool - start
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

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
  }
}
