/**
 * ENTITY ART — every in-world object that is not a vehicle and not the track.
 *
 *   item boxes · charge pickups · projectiles · deployed fields · start gate
 *
 * The sim owns truth. This module mirrors the sim's entity lists onto pooled
 * meshes and never writes a single byte back into RaceState.
 *
 * Rules this file obeys:
 *   - Everything is pre-allocated in createEntityVisuals(). update() creates no
 *     geometry, no material, no mesh, and allocates nothing at all.
 *   - Pooled instances share one geometry and one material. Unused pool entries
 *     are collapsed to a zero-scale matrix (instanced) or .visible = false.
 *   - No image textures. Procedural GLSL, vertex colours and geometry only.
 *   - Additive blending with depthWrite:false for every glow.
 *   - Budget: 16 draw calls, ~8.7k triangles at high quality.
 */

import * as THREE from 'three'
import type { EntityVisuals, RenderQuality } from './api'
import type { RaceState } from '../sim/types'
import type { Track, TrackSample } from '../sim/track'
import { ITEMS, ITEM_PARAMS } from '../content/items'
import { publishHazard, resetHazard } from './hazardSignal'

// ---------------------------------------------------------------------------
// Pool sizes
// ---------------------------------------------------------------------------

const RAIL_POOL = 8
const SEEKER_POOL = 8
const ALPHA_POOL = 4
const PROJ_POOL = RAIL_POOL + SEEKER_POOL + ALPHA_POOL // 20 ribbons

const KIND_RAIL = 0
const KIND_SEEKER = 1
const KIND_ALPHA = 2
const PROJ_BASE = [0, RAIL_POOL, RAIL_POOL + SEEKER_POOL]
const PROJ_SIZE = [RAIL_POOL, SEEKER_POOL, ALPHA_POOL]

const MINE_POOL = 10
const WELL_POOL = 6
const RING_POOL = MINE_POOL + WELL_POOL

const GATE_COUNT = 3
const LAMPS_PER_GATE = 3
const GATE_LAMPS = GATE_COUNT * LAMPS_PER_GATE
const GATE_SPACING = 15 // metres along the spline between gantries
const GO_FADE = 1.5     // seconds the green GO lamps take to die away

/** Seconds a killed projectile's trail lingers while it fades out. */
const TRAIL_LINGER = 0.28
/** Metres the head must travel before a new trail segment is pushed. */
const TRAIL_STEP = 0.35

const BOX_SIZE = 2.4
const COLLECT_TIME = 0.22
const POP_TIME = 0.34
const CHARGE_COLLECT = 0.16
const CHARGE_POP = 0.30

// Animation modes for a pickup slot.
const MODE_IDLE = 0
const MODE_COLLECT = 1
const MODE_HIDDEN = 2
const MODE_POP = 3

// Palette
const C_BOX_SHELL = 0x6ff0ff
const C_BOX_GLYPH = 0xfff4b0
const C_BOX_AURA = 0x7fe9ff
const C_CHARGE = 0x5cffb0
const C_GATE_FRAME = 0x2b3038
const C_GATE_TRIM = 0x555f6b
const C_LAMP_RED = 0xff2f1e
const C_LAMP_GREEN = 0x35ff86

// ---------------------------------------------------------------------------
// Module-scope scratch. Nothing in update() may allocate.
// ---------------------------------------------------------------------------

const _m = new THREE.Matrix4()
const _m2 = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _e = new THREE.Euler()
const _pos = new THREE.Vector3()
const _scl = new THREE.Vector3()
const _va = new THREE.Vector3()
const _vb = new THREE.Vector3()
const _vc = new THREE.Vector3()
const _fwd = new THREE.Vector3(0, 0, 1)
const _zero = new THREE.Matrix4().makeScale(0, 0, 0)
const _col = new THREE.Color()
const _rgb = new Float32Array(3)

function writeColor(hex: number, out: Float32Array, at: number): void {
  _col.setHex(hex, THREE.SRGBColorSpace)
  out[at] = _col.r
  out[at + 1] = _col.g
  out[at + 2] = _col.b
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)

/** Overshooting ease used by the item-box respawn pop. */
function easeOutBack(t: number): number {
  const c1 = 1.9
  const p = t - 1
  return 1 + (c1 + 1) * p * p * p + c1 * p * p
}

// ---------------------------------------------------------------------------
// Geometry merging. Keeps a multi-part prop to one draw call, colour baked in.
// ---------------------------------------------------------------------------

interface GeoPart {
  geo: THREE.BufferGeometry
  color: number
  /** How self-lit this part is, 0..1. Lands in aColor.a. */
  emissive?: number
  /** Local transform applied before merging. */
  xform?: THREE.Matrix4
}

/**
 * Merge parts into one indexed BufferGeometry carrying position, normal and a
 * vec4 aColor (rgb tint + emissive amount). Source geometries are disposed.
 */
function mergeParts(parts: GeoPart[]): THREE.BufferGeometry {
  let vTotal = 0
  let iTotal = 0
  for (let i = 0; i < parts.length; i++) {
    const g = parts[i].geo
    if (!g.attributes.normal) g.computeVertexNormals()
    vTotal += g.attributes.position.count
    iTotal += g.index ? g.index.count : g.attributes.position.count
  }

  const pos = new Float32Array(vTotal * 3)
  const nrm = new Float32Array(vTotal * 3)
  const col = new Float32Array(vTotal * 4)
  const idx = new Uint16Array(iTotal)

  let vo = 0
  let io = 0
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const g = part.geo
    if (part.xform) g.applyMatrix4(part.xform)

    const gp = g.attributes.position as THREE.BufferAttribute
    const gn = g.attributes.normal as THREE.BufferAttribute
    const n = gp.count
    writeColor(part.color, _rgb, 0)
    const r = _rgb[0]
    const gcol = _rgb[1]
    const b = _rgb[2]
    const em = part.emissive ?? 0

    for (let k = 0; k < n; k++) {
      const o3 = (vo + k) * 3
      pos[o3] = gp.getX(k)
      pos[o3 + 1] = gp.getY(k)
      pos[o3 + 2] = gp.getZ(k)
      nrm[o3] = gn.getX(k)
      nrm[o3 + 1] = gn.getY(k)
      nrm[o3 + 2] = gn.getZ(k)
      const o4 = (vo + k) * 4
      col[o4] = r
      col[o4 + 1] = gcol
      col[o4 + 2] = b
      col[o4 + 3] = em
    }

    const gi = g.index
    if (gi) {
      for (let k = 0; k < gi.count; k++) idx[io + k] = vo + gi.getX(k)
      io += gi.count
    } else {
      for (let k = 0; k < n; k++) idx[io + k] = vo + k
      io += n
    }
    vo += n
    g.dispose()
  }

  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  out.setAttribute('aColor', new THREE.BufferAttribute(col, 4))
  out.setIndex(new THREE.BufferAttribute(idx, 1))
  out.computeBoundingSphere()
  return out
}

/** Build a local transform without leaking scratch state. */
function xf(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Matrix4 {
  const m = new THREE.Matrix4()
  m.makeRotationFromEuler(new THREE.Euler(rx, ry, rz))
  m.setPosition(x, y, z)
  return m
}

// ---------------------------------------------------------------------------
// Shared GLSL
// ---------------------------------------------------------------------------

const GLSL_SDF = /* glsl */ `
  float sdSeg(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h);
  }
  // Circular arc centred on +Y with half-aperture ap.
  float sdArcSym(vec2 p, float ra, float ap) {
    vec2 sc = vec2(sin(ap), cos(ap));
    p.x = abs(p.x);
    return (sc.y * p.x > sc.x * p.y) ? length(p - sc * ra) : abs(length(p) - ra);
  }
  // Procedural question mark in unit UV space. Returns a signed distance.
  float qmark(vec2 uv) {
    float d = sdArcSym(uv - vec2(0.5, 0.615), 0.165, 1.92);
    d = min(d, sdSeg(uv, vec2(0.655, 0.559), vec2(0.585, 0.468)));
    d = min(d, sdSeg(uv, vec2(0.585, 0.468), vec2(0.500, 0.408)));
    d = min(d, sdSeg(uv, vec2(0.500, 0.408), vec2(0.500, 0.318)));
    d = min(d, length(uv - vec2(0.5, 0.218)) - 0.026);
    return d;
  }
`

/** Screen-aligned instanced billboard. PlaneGeometry(1,1) in, quad out. */
const GLOW_VERT = /* glsl */ `
  attribute vec4 iGlow;   // x size, y min angular size, z alpha, w style
  attribute vec3 iTint;
  varying vec2 vP;
  varying float vStyle;
  varying float vAlpha;
  varying vec3 vTint;
  void main() {
    vec3 centre = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    float d = distance(cameraPosition, centre);
    float sz = max(iGlow.x, d * iGlow.y);
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec3 wp = centre + (position.x * right + position.y * up) * sz;
    vP = position.xy * 2.0;
    vStyle = iGlow.w;
    vAlpha = iGlow.z;
    vTint = iTint;
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`

const GLOW_FRAG = /* glsl */ `
  uniform float uTime;
  varying vec2 vP;
  varying float vStyle;
  varying float vAlpha;
  varying vec3 vTint;
  void main() {
    float r = length(vP);
    float k = max(0.0, 1.0 - r);
    float a = pow(k, 2.6) * 0.5 + pow(k, 7.0) * 1.05;
    vec3 c = mix(vTint, vec3(1.0), pow(k, 8.0) * 0.85);
    if (vStyle > 0.5) {
      // Alpha-missile warning aura: an expanding shock ring plus a hard
      // klaxon ring that never lets you lose track of where it is.
      float t = fract(uTime * 1.55);
      float rr = mix(0.20, 1.02, t);
      float shock = exp(-pow((r - rr) * 8.0, 2.0)) * (1.0 - t) * 1.6;
      float klaxon = exp(-pow((r - 0.70) * 13.0, 2.0)) * (0.35 + 0.65 * abs(sin(uTime * 6.5)));
      a += shock + klaxon * 0.9;
      c = mix(c, vec3(1.0, 0.25, 0.2), 0.35);
    }
    a *= vAlpha * smoothstep(1.06, 0.88, r);
    gl_FragColor = vec4(c * a, a);
  }
`

// ---------------------------------------------------------------------------

export interface EntityVisualsWithGate extends EntityVisuals {
  /** 3 / 2 / 1 illuminate successive gates. 0 = GO: all green, then fade. */
  setStartLights(n: number): void
}

/**
 * Build the entity art layer for a track.
 * Returns EntityVisuals widened with the start-gate control.
 */
export function createEntityVisuals(track: Track, quality: RenderQuality): EntityVisualsWithGate {
  return new EntityArt(track, quality)
}

// ---------------------------------------------------------------------------

class EntityArt implements EntityVisualsWithGate {
  readonly group = new THREE.Group()

  private readonly track: Track
  private readonly time = { value: 0 }

  // --- shared resources -----------------------------------------------------
  private readonly geos: THREE.BufferGeometry[] = []
  private readonly mats: THREE.Material[] = []

  // --- item boxes -----------------------------------------------------------
  private boxMesh!: THREE.InstancedMesh
  private boxAura!: THREE.InstancedMesh
  private boxAttr!: THREE.InstancedBufferAttribute // iBox: phase, flash, seed
  private auraAttr!: THREE.InstancedBufferAttribute
  private boxCount = 0
  private boxMode!: Uint8Array
  private boxT!: Float32Array

  // --- charge pickups -------------------------------------------------------
  private chargeMesh!: THREE.InstancedMesh
  private chargeGlow!: THREE.InstancedMesh
  private chargeAttr!: THREE.InstancedBufferAttribute
  private chargeGlowAttr!: THREE.InstancedBufferAttribute
  private chargeCount = 0
  private chargeMode!: Uint8Array
  private chargeT!: Float32Array

  // --- projectiles ----------------------------------------------------------
  private bodyMesh: THREE.InstancedMesh[] = []
  private bodyAttr: THREE.InstancedBufferAttribute[] = []
  private projGlow!: THREE.InstancedMesh
  private projGlowAttr!: THREE.InstancedBufferAttribute
  /** Sim projectile id occupying each pool slot, -1 when free. */
  private projId = new Int32Array(PROJ_POOL).fill(-1)
  private projSeen = new Uint8Array(PROJ_POOL)
  private projDying = new Float32Array(PROJ_POOL)
  private projFade = new Float32Array(PROJ_POOL)
  private projFilled = new Int32Array(PROJ_POOL)
  /** A ribbon at fade 0 is already collapsed; don't rewrite it every frame. */
  private trailIdle = new Uint8Array(PROJ_POOL)

  // --- trails ---------------------------------------------------------------
  private trailSeg: number
  private trailPosAttr!: THREE.BufferAttribute
  private trailDirAttr!: THREE.BufferAttribute
  private trailFadeAttr!: THREE.BufferAttribute
  /** Ring-free history of spine points, world space: [slot][seg][xyz]. */
  private spine!: Float32Array

  // --- fields ---------------------------------------------------------------
  private mineMesh!: THREE.InstancedMesh
  private mineAttr!: THREE.InstancedBufferAttribute
  private wellMesh!: THREE.InstancedMesh
  private wellAttr!: THREE.InstancedBufferAttribute
  private ringMesh!: THREE.InstancedMesh
  private ringAttr!: THREE.InstancedBufferAttribute
  private mineId = new Int32Array(MINE_POOL).fill(-1)
  private wellId = new Int32Array(WELL_POOL).fill(-1)
  private mineSeen = new Uint8Array(MINE_POOL)
  private wellSeen = new Uint8Array(WELL_POOL)
  /** Surface anchor for each field slot's ground ring: pos(3) + quat(4). */
  private mineAnchor = new Float32Array(MINE_POOL * 7)
  private wellAnchor = new Float32Array(WELL_POOL * 7)

  private uWellPos: THREE.Vector4[] = []
  private uWellFade: number[] = []

  // --- start gate -----------------------------------------------------------
  private lampAttr!: THREE.InstancedBufferAttribute
  private lampTint!: THREE.InstancedBufferAttribute
  private lampGlow!: THREE.InstancedMesh
  private lampGlowAttr!: THREE.InstancedBufferAttribute
  private lampGlowTint!: THREE.InstancedBufferAttribute
  private gateLit = new Float32Array(GATE_COUNT)
  private gateTarget = new Float32Array(GATE_COUNT)
  private lampRed = new Float32Array(3)
  private lampGreen = new Float32Array(3)
  private lampWasGreen = false
  private lightsExplicit = false
  private lightsN = 3
  private goT = 0

  constructor(track: Track, quality: RenderQuality) {
    this.track = track
    this.group.name = 'entities'
    this.group.matrixAutoUpdate = false

    this.trailSeg = quality.tier === 'low' ? 12 : quality.tier === 'medium' ? 18 : 22
    writeColor(C_LAMP_RED, this.lampRed, 0)
    writeColor(C_LAMP_GREEN, this.lampGreen, 0)

    this.buildItemBoxes(track)
    this.buildCharges(track, quality)
    this.buildProjectiles()
    this.buildTrails()
    this.buildFields(quality)
    this.buildStartGate(track)
  }

  // =========================================================================
  // BUILD
  // =========================================================================

  private keep<T extends THREE.BufferGeometry>(g: T): T {
    this.geos.push(g)
    return g
  }

  private keepMat<T extends THREE.Material>(m: T): T {
    this.mats.push(m)
    return m
  }

  /** Glow billboards: one shared material, one InstancedMesh per consumer. */
  private glowMaterial: THREE.ShaderMaterial | null = null

  private makeGlow(count: number, renderOrder: number): THREE.InstancedMesh {
    if (!this.glowMaterial) {
      this.glowMaterial = this.keepMat(new THREE.ShaderMaterial({
        uniforms: { uTime: this.time },
        vertexShader: GLOW_VERT,
        fragmentShader: GLOW_FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }))
    }
    const geo = this.keep(new THREE.PlaneGeometry(1, 1))
    geo.setAttribute('iGlow', new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('iTint', new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3))
    const mesh = new THREE.InstancedMesh(geo, this.glowMaterial, count)
    mesh.frustumCulled = false
    mesh.renderOrder = renderOrder
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.group.add(mesh)
    return mesh
  }

  // --- item boxes -----------------------------------------------------------

  private buildItemBoxes(track: Track): void {
    let n = 0
    for (let i = 0; i < track.def.itemBoxRows.length; i++) n += track.def.itemBoxRows[i].count
    n = Math.max(1, n)
    this.boxCount = n

    const geo = this.keep(new THREE.BoxGeometry(BOX_SIZE, BOX_SIZE, BOX_SIZE))
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4)
    attr.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('iBox', attr)
    this.boxAttr = attr

    const mat = this.keepMat(new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.time,
        uShell: { value: new THREE.Color(C_BOX_SHELL) },
        uGlyph: { value: new THREE.Color(C_BOX_GLYPH) },
      },
      vertexShader: /* glsl */ `
        attribute vec4 iBox;
        varying vec2 vUv;
        varying vec3 vN;
        varying vec3 vW;
        varying vec4 vBox;
        void main() {
          vUv = uv;
          vBox = iBox;
          vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vW = wp.xyz;
          vN = mat3(modelMatrix) * (mat3(instanceMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uShell;
        uniform vec3 uGlyph;
        varying vec2 vUv;
        varying vec3 vN;
        varying vec3 vW;
        varying vec4 vBox;
        ${GLSL_SDF}
        void main() {
          vec3 N = normalize(vN);
          vec3 V = normalize(cameraPosition - vW);
          float fres = 1.0 - abs(dot(N, V));

          // Holographic frame around every face.
          vec2 e = abs(vUv - 0.5) * 2.0;
          float edge = max(e.x, e.y);
          float frame = smoothstep(0.83, 0.92, edge) * (1.0 - smoothstep(0.975, 1.0, edge));

          // Interference scanlines drifting up the face.
          float scan = 0.5 + 0.5 * sin(vUv.y * 40.0 - uTime * 6.0 + vBox.x * 3.0);

          // Procedural question mark.
          float d = qmark(vUv);
          float w = fwidth(d) + 0.0035;
          float glyph = 1.0 - smoothstep(0.038 - w, 0.038 + w, d);
          float bleed = exp(-max(d, 0.0) * 22.0) * 0.6;

          // The glyph writes itself on with a sweep, then breathes.
          float sweep = smoothstep(0.0, 0.35, fract(uTime * 0.5 + vBox.z) * 1.6 - vUv.y * 0.5);
          float pulse = 0.74 + 0.26 * sin(uTime * 3.2 + vBox.x);

          vec3 c = uShell * (fres * fres * 1.35 + 0.10 + frame * 1.7 + scan * 0.07);
          c += uGlyph * (glyph * (1.2 + 0.7 * pulse) + bleed) * (0.35 + 0.65 * sweep);
          c += vec3(1.0) * vBox.y * 2.6;

          float a = clamp(fres * 0.5 + frame * 0.85 + glyph * 0.95 + bleed * 0.5 + 0.04 + vBox.y, 0.0, 1.0);
          gl_FragColor = vec4(c * pulse, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }))

    const mesh = new THREE.InstancedMesh(geo, mat, n)
    mesh.frustumCulled = false
    mesh.renderOrder = 3
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.boxMesh = mesh
    this.group.add(mesh)

    this.boxAura = this.makeGlow(n, 7)
    this.auraAttr = this.boxAura.geometry.getAttribute('iGlow') as THREE.InstancedBufferAttribute
    const tint = this.boxAura.geometry.getAttribute('iTint') as THREE.InstancedBufferAttribute
    const ta = tint.array as Float32Array
    for (let i = 0; i < n; i++) writeColor(C_BOX_AURA, ta, i * 3)
    tint.needsUpdate = true

    const pa = attr.array as Float32Array
    for (let i = 0; i < n; i++) {
      pa[i * 4] = i * 2.399      // phase
      pa[i * 4 + 1] = 0          // collect flash
      pa[i * 4 + 2] = (i * 0.371) % 1 // seed
      pa[i * 4 + 3] = 0
    }
    attr.needsUpdate = true

    this.boxMode = new Uint8Array(n)
    this.boxT = new Float32Array(n)
  }

  // --- charge pickups -------------------------------------------------------

  private buildCharges(track: Track, quality: RenderQuality): void {
    let n = 0
    for (let i = 0; i < track.def.chargeRuns.length; i++) n += track.def.chargeRuns[i].count
    n = Math.max(1, n)
    this.chargeCount = n

    const shard = new THREE.OctahedronGeometry(0.42, 0)
    shard.scale(1, 1.45, 1)
    const geo = this.keep(shard)
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2)
    attr.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('iChg', attr)
    this.chargeAttr = attr

    const mat = this.keepMat(new THREE.ShaderMaterial({
      uniforms: { uTime: this.time, uColor: { value: new THREE.Color(C_CHARGE) } },
      vertexShader: /* glsl */ `
        attribute vec2 iChg;   // x phase, y brightness
        varying vec3 vN;
        varying vec3 vW;
        varying vec2 vChg;
        void main() {
          vChg = iChg;
          vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vW = wp.xyz;
          vN = mat3(modelMatrix) * (mat3(instanceMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uColor;
        varying vec3 vN;
        varying vec3 vW;
        varying vec2 vChg;
        void main() {
          vec3 N = normalize(vN);
          vec3 V = normalize(cameraPosition - vW);
          float f = 1.0 - abs(dot(N, V));
          float lam = 0.35 + 0.65 * max(0.0, dot(N, normalize(vec3(0.35, 0.85, 0.30))));
          float pulse = 0.78 + 0.22 * sin(uTime * 5.5 + vChg.x);
          vec3 c = mix(uColor, vec3(1.0), f * f * 0.8);
          c *= (lam * 0.55 + f * 1.35 + 0.35) * pulse * vChg.y;
          gl_FragColor = vec4(c, 1.0);
        }
      `,
    }))

    const mesh = new THREE.InstancedMesh(geo, mat, n)
    mesh.frustumCulled = false
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.chargeMesh = mesh
    this.group.add(mesh)

    this.chargeGlow = this.makeGlow(n, 7)
    this.chargeGlowAttr = this.chargeGlow.geometry.getAttribute('iGlow') as THREE.InstancedBufferAttribute
    const tint = this.chargeGlow.geometry.getAttribute('iTint') as THREE.InstancedBufferAttribute
    const ta = tint.array as Float32Array
    for (let i = 0; i < n; i++) writeColor(C_CHARGE, ta, i * 3)
    tint.needsUpdate = true
    if (quality.tier === 'low') this.chargeGlow.visible = false

    const pa = attr.array as Float32Array
    for (let i = 0; i < n; i++) {
      pa[i * 2] = i * 1.117
      pa[i * 2 + 1] = 1
    }
    attr.needsUpdate = true

    this.chargeMode = new Uint8Array(n)
    this.chargeT = new Float32Array(n)
  }

  // --- projectiles ----------------------------------------------------------

  private buildProjectiles(): void {
    const mat = this.keepMat(new THREE.ShaderMaterial({
      uniforms: { uTime: this.time },
      vertexShader: /* glsl */ `
        attribute vec4 aColor;
        attribute vec4 iProj;   // x phase, y menace, z fade, w unused
        attribute vec3 iTint;
        varying vec4 vCol;
        varying vec3 vN;
        varying vec3 vW;
        varying vec4 vP;
        varying vec3 vTint;
        void main() {
          vCol = aColor; vP = iProj; vTint = iTint;
          vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vW = wp.xyz;
          vN = mat3(modelMatrix) * (mat3(instanceMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying vec4 vCol;
        varying vec3 vN;
        varying vec3 vW;
        varying vec4 vP;
        varying vec3 vTint;
        void main() {
          vec3 N = normalize(vN);
          vec3 V = normalize(cameraPosition - vW);
          float f = 1.0 - abs(dot(N, V));
          float lam = 0.28 + 0.72 * max(0.0, dot(N, normalize(vec3(0.35, 0.85, 0.25))));
          float pulse = 0.5 + 0.5 * sin(uTime * 9.5 + vP.x);
          vec3 c = vCol.rgb * vTint * lam;
          c += vTint * vCol.a * (0.85 + vP.y * pulse * 2.0);
          c += vec3(1.0) * pow(f, 3.0) * (0.30 + vP.y * 0.7);
          gl_FragColor = vec4(c * vP.z, 1.0);
        }
      `,
    }))

    const build = (kind: number, geo: THREE.BufferGeometry, tint: number, menace: number): void => {
      const n = PROJ_SIZE[kind]
      this.keep(geo)
      const attr = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4)
      attr.setUsage(THREE.DynamicDrawUsage)
      geo.setAttribute('iProj', attr)
      const tattr = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3)
      const ta = tattr.array as Float32Array
      for (let i = 0; i < n; i++) writeColor(tint, ta, i * 3)
      geo.setAttribute('iTint', tattr)
      const pa = attr.array as Float32Array
      for (let i = 0; i < n; i++) {
        pa[i * 4] = i * 1.77
        pa[i * 4 + 1] = menace
        pa[i * 4 + 2] = 1
      }
      const mesh = new THREE.InstancedMesh(geo, mat, n)
      mesh.frustumCulled = false
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      for (let i = 0; i < n; i++) mesh.setMatrixAt(i, _zero)
      this.group.add(mesh)
      this.bodyMesh[kind] = mesh
      this.bodyAttr[kind] = attr
    }

    build(KIND_RAIL, railGeometry(), ITEMS.railMissile.color, 0.18)
    build(KIND_SEEKER, seekerGeometry(), ITEMS.seekerMissile.color, 0.30)
    build(KIND_ALPHA, alphaGeometry(), ITEMS.alphaMissile.color, 1.0)

    this.projGlow = this.makeGlow(PROJ_POOL, 8)
    this.projGlowAttr = this.projGlow.geometry.getAttribute('iGlow') as THREE.InstancedBufferAttribute
    const tint = this.projGlow.geometry.getAttribute('iTint') as THREE.InstancedBufferAttribute
    const ta = tint.array as Float32Array
    for (let s = 0; s < PROJ_POOL; s++) {
      const k = slotKind(s)
      writeColor(k === KIND_RAIL ? ITEMS.railMissile.color
        : k === KIND_SEEKER ? ITEMS.seekerMissile.color
          : ITEMS.alphaMissile.color, ta, s * 3)
    }
    tint.needsUpdate = true
    for (let s = 0; s < PROJ_POOL; s++) this.projGlow.setMatrixAt(s, _zero)
  }

  // --- trails ---------------------------------------------------------------

  private buildTrails(): void {
    const S = this.trailSeg
    const verts = PROJ_POOL * S * 2
    const tris = PROJ_POOL * (S - 1) * 2

    const position = new Float32Array(verts * 3)
    const aDir = new Float32Array(verts * 3)
    const aSide = new Float32Array(verts)
    const aPS = new Float32Array(verts * 2)   // param, shape
    const aWidth = new Float32Array(verts)
    const aFade = new Float32Array(verts)
    const aTint = new Float32Array(verts * 3)
    const index = new Uint16Array(tris * 3)

    let io = 0
    for (let s = 0; s < PROJ_POOL; s++) {
      const kind = slotKind(s)
      // Rail: thin, hard-edged, near-linear. Seeker: medium, softer.
      // Alpha: wide, soft, and it stays wide all the way down the tail.
      const base = kind === KIND_RAIL ? 0.20 : kind === KIND_SEEKER ? 0.34 : 0.95
      const taper = kind === KIND_RAIL ? 1.0 : kind === KIND_SEEKER ? 0.80 : 0.50
      const shape = kind === KIND_RAIL ? 6.0 : kind === KIND_SEEKER ? 2.6 : 1.35
      const tint = kind === KIND_RAIL ? ITEMS.railMissile.color
        : kind === KIND_SEEKER ? ITEMS.seekerMissile.color
          : ITEMS.alphaMissile.color

      for (let i = 0; i < S; i++) {
        const p = i / (S - 1)
        const w = base * Math.pow(1 - p * taper, kind === KIND_RAIL ? 0.7 : 1.0)
        for (let j = 0; j < 2; j++) {
          const v = (s * S + i) * 2 + j
          aSide[v] = j === 0 ? -1 : 1
          aPS[v * 2] = p
          aPS[v * 2 + 1] = shape
          aWidth[v] = w
          aFade[v] = 0
          writeColor(tint, aTint, v * 3)
        }
      }
      for (let i = 0; i < S - 1; i++) {
        const a = (s * S + i) * 2
        const b = a + 2
        index[io++] = a; index[io++] = a + 1; index[io++] = b + 1
        index[io++] = a; index[io++] = b + 1; index[io++] = b
      }
    }

    const geo = this.keep(new THREE.BufferGeometry())
    this.trailPosAttr = new THREE.BufferAttribute(position, 3).setUsage(THREE.DynamicDrawUsage) as THREE.BufferAttribute
    this.trailDirAttr = new THREE.BufferAttribute(aDir, 3).setUsage(THREE.DynamicDrawUsage) as THREE.BufferAttribute
    this.trailFadeAttr = new THREE.BufferAttribute(aFade, 1).setUsage(THREE.DynamicDrawUsage) as THREE.BufferAttribute
    geo.setAttribute('position', this.trailPosAttr)
    geo.setAttribute('aDir', this.trailDirAttr)
    geo.setAttribute('aFade', this.trailFadeAttr)
    geo.setAttribute('aSide', new THREE.BufferAttribute(aSide, 1))
    geo.setAttribute('aPS', new THREE.BufferAttribute(aPS, 2))
    geo.setAttribute('aWidth', new THREE.BufferAttribute(aWidth, 1))
    geo.setAttribute('aTint', new THREE.BufferAttribute(aTint, 3))
    geo.setIndex(new THREE.BufferAttribute(index, 1))

    const mat = this.keepMat(new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: /* glsl */ `
        attribute vec3 aDir;
        attribute float aSide;
        attribute vec2 aPS;
        attribute float aWidth;
        attribute float aFade;
        attribute vec3 aTint;
        varying float vParam;
        varying float vShape;
        varying float vFade;
        varying float vSide;
        varying vec3 vTint;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vec3 dirW = mat3(modelMatrix) * aDir;
          float dl = length(dirW);
          vec3 toCam = normalize(cameraPosition - wp.xyz);
          vec3 sideV = cross(dirW, toCam);
          float sl = length(sideV);
          // A zero-length segment collapses the ribbon instead of splaying it.
          float ok = step(1e-5, dl) * step(1e-5, sl);
          sideV = ok > 0.5 ? sideV / max(sl, 1e-5) : vec3(0.0);
          wp.xyz += sideV * (aSide * aWidth * aFade);
          vParam = aPS.x; vShape = aPS.y; vFade = aFade; vSide = aSide; vTint = aTint;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vParam;
        varying float vShape;
        varying float vFade;
        varying float vSide;
        varying vec3 vTint;
        void main() {
          float core = pow(max(0.0, 1.0 - abs(vSide)), vShape);
          float len = 1.0 - vParam;
          float a = (0.18 + 0.82 * core) * len * len * vFade;
          vec3 c = mix(vTint, vec3(1.0), core * 0.75);
          gl_FragColor = vec4(c * a, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }))

    const mesh = new THREE.Mesh(geo, mat)
    mesh.frustumCulled = false
    mesh.renderOrder = 6
    this.group.add(mesh)
    this.spine = new Float32Array(PROJ_POOL * S * 3)
  }

  // --- fields ---------------------------------------------------------------

  private buildFields(quality: RenderQuality): void {
    // ---- Void Mine body: dense core inside a faceted containment shell.
    const mineGeo = this.keep(mergeParts([
      { geo: new THREE.IcosahedronGeometry(0.55, 0), color: 0xffffff, emissive: 1.0 },
      { geo: new THREE.OctahedronGeometry(1.15, 0), color: 0x8b52d8, emissive: 0.15 },
    ]))
    const mineAttr = new THREE.InstancedBufferAttribute(new Float32Array(MINE_POOL * 4), 4)
    mineAttr.setUsage(THREE.DynamicDrawUsage)
    mineGeo.setAttribute('iMine', mineAttr)
    this.mineAttr = mineAttr

    const mineMat = this.keepMat(new THREE.ShaderMaterial({
      uniforms: { uTime: this.time, uColor: { value: new THREE.Color(ITEMS.voidMine.color) } },
      vertexShader: /* glsl */ `
        attribute vec4 aColor;
        attribute vec4 iMine;   // x armed 0..1, y fade, z phase, w unused
        varying vec4 vCol;
        varying vec3 vN;
        varying vec3 vW;
        varying vec4 vM;
        void main() {
          vCol = aColor; vM = iMine;
          vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vW = wp.xyz;
          vN = mat3(modelMatrix) * (mat3(instanceMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uColor;
        varying vec4 vCol;
        varying vec3 vN;
        varying vec3 vW;
        varying vec4 vM;
        void main() {
          vec3 N = normalize(vN);
          vec3 V = normalize(cameraPosition - vW);
          float f = 1.0 - abs(dot(N, V));
          float armed = vM.x;
          float lam = 0.30 + 0.70 * max(0.0, dot(N, normalize(vec3(0.35, 0.85, 0.25))));
          // Inert: dead grey, no heartbeat. Armed: violet core, hard pulse.
          float beat = 0.55 + 0.45 * sin(uTime * 5.0 + vM.z);
          vec3 live = uColor * (0.85 + beat * 1.9);
          vec3 dead = vec3(0.16, 0.15, 0.19);
          vec3 core = mix(dead, live, armed);
          vec3 c = vCol.rgb * lam * mix(0.35, 1.0, armed);
          c += core * vCol.a;
          c += mix(vec3(0.35), uColor, armed) * pow(f, 2.5) * (0.4 + armed * 1.2);
          float a = mix(0.55, 0.95, vCol.a) * vM.y;
          a = min(1.0, a + vCol.a);
          gl_FragColor = vec4(c, a * vM.y);
        }
      `,
      transparent: true,
      depthWrite: true,
      side: THREE.DoubleSide,
    }))
    const mineMesh = new THREE.InstancedMesh(mineGeo, mineMat, MINE_POOL)
    mineMesh.frustumCulled = false
    mineMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    for (let i = 0; i < MINE_POOL; i++) mineMesh.setMatrixAt(i, _zero)
    this.mineMesh = mineMesh
    this.group.add(mineMesh)

    // ---- Ground rings, shared by armed mines and gravity wells.
    const ring = new THREE.RingGeometry(0.87, 1.0, 64, 1)
    ring.rotateX(-Math.PI / 2)
    const ringGeo = this.keep(ring)
    const ringAttr = new THREE.InstancedBufferAttribute(new Float32Array(RING_POOL * 4), 4)
    ringAttr.setUsage(THREE.DynamicDrawUsage)
    ringGeo.setAttribute('iRing', ringAttr)
    this.ringAttr = ringAttr
    const ringTint = new THREE.InstancedBufferAttribute(new Float32Array(RING_POOL * 3), 3)
    const rta = ringTint.array as Float32Array
    for (let i = 0; i < RING_POOL; i++) {
      writeColor(i < MINE_POOL ? ITEMS.voidMine.color : ITEMS.gravityWell.color, rta, i * 3)
    }
    ringGeo.setAttribute('iRingTint', ringTint)

    const ringMat = this.keepMat(new THREE.ShaderMaterial({
      uniforms: { uTime: this.time },
      vertexShader: /* glsl */ `
        attribute vec4 iRing;      // x fade, y phase, z speed, w style
        attribute vec3 iRingTint;
        varying vec2 vLocal;
        varying vec4 vR;
        varying vec3 vTint;
        void main() {
          // RingGeometry carries planar UVs, so the band is derived from the
          // untransformed local radius instead.
          vLocal = position.xz;
          vR = iRing; vTint = iRingTint;
          vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        #define RING_INNER 0.87
        #define RING_OUTER 1.0
        uniform float uTime;
        varying vec2 vLocal;
        varying vec4 vR;
        varying vec3 vTint;
        void main() {
          float r = length(vLocal);
          float t = clamp((r - RING_INNER) / (RING_OUTER - RING_INNER), 0.0, 1.0);
          // Brightest at the OUTER rim, falling off inward: the lit line the
          // player reads sits exactly on the radius that will punish them.
          float edge = pow(t, 2.0) * 0.55 + pow(t, 12.0) * 0.9;
          float pulse = 0.55 + 0.45 * sin(uTime * vR.z + vR.y);
          // Ticks around the circumference so the danger radius reads as a
          // measured boundary rather than a soft haze. 48 divides the full
          // turn exactly, so the atan seam leaves no visible join.
          float ang = atan(vLocal.y, vLocal.x);
          float ticks = 0.55 + 0.45 * step(0.5, fract(ang * (48.0 / 6.28318530718) - uTime * 0.15));
          float a = edge * (0.5 + 0.9 * pulse) * ticks * vR.x;
          vec3 c = mix(vTint, vec3(1.0), edge * 0.55);
          gl_FragColor = vec4(c * a * 1.6, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }))
    const ringMesh = new THREE.InstancedMesh(ringGeo, ringMat, RING_POOL)
    ringMesh.frustumCulled = false
    ringMesh.renderOrder = 4
    ringMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    for (let i = 0; i < RING_POOL; i++) ringMesh.setMatrixAt(i, _zero)
    this.ringMesh = ringMesh
    this.group.add(ringMesh)

    // ---- Gravity Well distortion sphere.
    const wellGeo = this.keep(new THREE.SphereGeometry(1, 20, 12))
    const wellAttr = new THREE.InstancedBufferAttribute(new Float32Array(WELL_POOL * 4), 4)
    wellAttr.setUsage(THREE.DynamicDrawUsage)
    wellGeo.setAttribute('iWell', wellAttr)
    this.wellAttr = wellAttr

    const wellMat = this.keepMat(new THREE.ShaderMaterial({
      uniforms: { uTime: this.time, uColor: { value: new THREE.Color(ITEMS.gravityWell.color) } },
      vertexShader: /* glsl */ `
        attribute vec4 iWell;   // x fade, y phase, z unused, w unused
        varying vec3 vL;
        varying vec3 vN;
        varying vec3 vW;
        varying vec4 vI;
        void main() {
          vL = position; vI = iWell;
          vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vW = wp.xyz;
          vN = mat3(modelMatrix) * (mat3(instanceMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uColor;
        varying vec3 vL;
        varying vec3 vN;
        varying vec3 vW;
        varying vec4 vI;
        void main() {
          vec3 N = normalize(vN);
          vec3 V = normalize(cameraPosition - vW);
          float f = 1.0 - abs(dot(N, V));
          vec3 n = normalize(vL);

          float ang = atan(n.z, n.x);
          float lat = asin(clamp(n.y, -1.0, 1.0));
          float t = uTime + vI.y;

          // Spiral shells falling inward.
          float sw = sin(ang * 5.0 + lat * 6.0 - t * 2.4);
          float bands = pow(max(0.0, sw), 3.0);
          // Latitude rings give the sphere honest volume from any angle.
          float rings = pow(max(0.0, sin(lat * 14.0 - t * 3.0)), 8.0);
          // Rim is the legibility workhorse: you always see the boundary.
          float rim = pow(f, 2.2);
          // Chromatic split at grazing angles fakes refraction with no texture.
          vec3 disp = vec3(pow(f, 2.0), pow(f, 2.6), pow(f, 3.4));

          vec3 c = uColor * (bands * 0.45 + rings * 0.55 + 0.05);
          c += mix(uColor, vec3(0.55, 0.75, 1.0), 0.5) * rim * 1.35;
          c += disp * 0.35;
          float a = clamp(bands * 0.22 + rings * 0.3 + rim * 0.75 + 0.045, 0.0, 1.0) * vI.x;
          gl_FragColor = vec4(c * a, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }))
    const wellMesh = new THREE.InstancedMesh(wellGeo, wellMat, WELL_POOL)
    wellMesh.frustumCulled = false
    wellMesh.renderOrder = 5
    wellMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    for (let i = 0; i < WELL_POOL; i++) wellMesh.setMatrixAt(i, _zero)
    this.wellMesh = wellMesh
    this.group.add(wellMesh)

    // ---- Inward-swirling particles, animated entirely on the GPU.
    const per = Math.max(6, Math.round(40 * quality.particleScale))
    const total = per * WELL_POOL
    const swirlGeo = this.keep(new THREE.PlaneGeometry(1, 1))
    const swirl = new THREE.InstancedBufferAttribute(new Float32Array(total * 2), 2)
    const sa = swirl.array as Float32Array
    for (let w = 0; w < WELL_POOL; w++) {
      for (let k = 0; k < per; k++) {
        const i = w * per + k
        sa[i * 2] = (k * 0.6180339887 + w * 0.2371) % 1
        sa[i * 2 + 1] = w
      }
    }
    swirlGeo.setAttribute('iSwirl', swirl)

    for (let i = 0; i < WELL_POOL; i++) {
      this.uWellPos.push(new THREE.Vector4(0, -9999, 0, 1))
      this.uWellFade.push(0)
    }

    const swirlMat = this.keepMat(new THREE.ShaderMaterial({
      defines: { WELLS: WELL_POOL },
      uniforms: {
        uTime: this.time,
        uWellPos: { value: this.uWellPos },
        uWellFade: { value: this.uWellFade },
        uColor: { value: new THREE.Color(ITEMS.gravityWell.color) },
      },
      vertexShader: /* glsl */ `
        attribute vec2 iSwirl;   // x seed, y well index
        uniform float uTime;
        uniform vec4 uWellPos[WELLS];
        uniform float uWellFade[WELLS];
        varying vec2 vP;
        varying float vA;
        void main() {
          vec4 well = vec4(0.0, -9999.0, 0.0, 1.0);
          float fade = 0.0;
          for (int i = 0; i < WELLS; i++) {
            if (i == int(iSwirl.y + 0.5)) { well = uWellPos[i]; fade = uWellFade[i]; }
          }
          float seed = iSwirl.x;
          float j = fract(seed * 91.37);
          // u marches 1 -> 0: every particle spirals inward and is recycled.
          float u = fract(seed * 3.71 - uTime * 0.16 - j * 0.5);
          float rad = (0.10 + 0.90 * u) * well.w;
          float ang = seed * 43.7 + j * 6.28 + uTime * (1.4 + 0.8 * j) + (1.0 - u) * 5.0;
          float hy = (j - 0.5) * 1.35 * well.w * u;
          vec3 centre = well.xyz + vec3(cos(ang) * rad, hy, sin(ang) * rad);

          float sz = (0.16 + 0.34 * u) * max(1.0, well.w * 0.16);
          vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 up    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          vec3 wp = centre + (position.x * right + position.y * up) * sz;

          vP = position.xy * 2.0;
          vA = fade * smoothstep(0.0, 0.18, u) * (0.35 + 0.65 * (1.0 - u));
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying vec2 vP;
        varying float vA;
        void main() {
          float k = max(0.0, 1.0 - length(vP));
          float a = pow(k, 2.5) * vA;
          gl_FragColor = vec4(mix(uColor, vec3(1.0), pow(k, 6.0)) * a * 1.4, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }))
    const swirlMesh = new THREE.InstancedMesh(swirlGeo, swirlMat, total)
    swirlMesh.frustumCulled = false
    swirlMesh.renderOrder = 6
    // Instance transforms are unused: every particle is placed in the shader.
    swirlMesh.instanceMatrix.needsUpdate = true
    this.group.add(swirlMesh)
  }

  // --- start gate -----------------------------------------------------------

  private buildStartGate(track: Track): void {
    const parts: GeoPart[] = []
    const lampPos = new Float32Array(GATE_LAMPS * 3)
    const lampQuat = new Float32Array(GATE_LAMPS * 4)
    const accent = track.def.palette.c

    for (let g = 0; g < GATE_COUNT; g++) {
      const s = g * GATE_SPACING
      const smp: TrackSample = track.at(s)
      const c = track.posAt(s)
      _va.set(smp.right.x, smp.right.y, smp.right.z)
      _vb.set(smp.normal.x, smp.normal.y, smp.normal.z)
      _vc.set(smp.tangent.x, smp.tangent.y, smp.tangent.z)
      const basis = new THREE.Matrix4().makeBasis(_va, _vb, _vc)
      basis.setPosition(c.x, c.y, c.z)

      const hw = smp.width + 1.8
      const h = 7.4
      const local: GeoPart[] = [
        { geo: new THREE.BoxGeometry(0.8, h, 0.8), color: C_GATE_FRAME, xform: xf(-hw, h / 2, 0) },
        { geo: new THREE.BoxGeometry(0.8, h, 0.8), color: C_GATE_FRAME, xform: xf(hw, h / 2, 0) },
        { geo: new THREE.BoxGeometry(2 * hw + 0.8, 0.75, 1.0), color: C_GATE_FRAME, xform: xf(0, h - 0.3, 0) },
        { geo: new THREE.BoxGeometry(2 * hw, 0.18, 0.6), color: accent, emissive: 0.55, xform: xf(0, h - 0.78, 0.22) },
        { geo: new THREE.BoxGeometry(1.9, 0.5, 1.9), color: C_GATE_TRIM, xform: xf(-hw, 0.25, 0) },
        { geo: new THREE.BoxGeometry(1.9, 0.5, 1.9), color: C_GATE_TRIM, xform: xf(hw, 0.25, 0) },
      ]
      for (let i = 0; i < local.length; i++) {
        local[i].geo.applyMatrix4(local[i].xform as THREE.Matrix4)
        local[i].geo.applyMatrix4(basis)
        local[i].xform = undefined
        parts.push(local[i])
      }

      // Lamp anchors, in the gate's local frame then pushed to world.
      const lampX = [-hw * 0.58, 0, hw * 0.58]
      for (let k = 0; k < LAMPS_PER_GATE; k++) {
        const i = g * LAMPS_PER_GATE + k
        _pos.set(lampX[k], h - 1.35, 0.05).applyMatrix4(basis)
        lampPos[i * 3] = _pos.x
        lampPos[i * 3 + 1] = _pos.y
        lampPos[i * 3 + 2] = _pos.z
        _q.setFromRotationMatrix(basis)
        lampQuat[i * 4] = _q.x
        lampQuat[i * 4 + 1] = _q.y
        lampQuat[i * 4 + 2] = _q.z
        lampQuat[i * 4 + 3] = _q.w
      }
    }

    const frameGeo = this.keep(mergeParts(parts))
    const frameMat = this.keepMat(new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: /* glsl */ `
        attribute vec4 aColor;
        varying vec4 vCol;
        varying vec3 vN;
        void main() {
          vCol = aColor;
          vN = mat3(modelMatrix) * normal;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec4 vCol;
        varying vec3 vN;
        void main() {
          vec3 N = normalize(vN);
          float lam = 0.30 + 0.70 * max(0.0, dot(N, normalize(vec3(0.35, 0.85, 0.25))));
          float sky = 0.18 * (0.5 + 0.5 * N.y);
          vec3 c = vCol.rgb * (lam + sky) + vCol.rgb * vCol.a * 2.2;
          gl_FragColor = vec4(c, 1.0);
        }
      `,
    }))
    const frame = new THREE.Mesh(frameGeo, frameMat)
    frame.frustumCulled = false
    this.group.add(frame)

    // Lamps.
    const lampGeo = this.keep(new THREE.BoxGeometry(2.2, 0.62, 0.42))
    const lampAttr = new THREE.InstancedBufferAttribute(new Float32Array(GATE_LAMPS), 1)
    lampAttr.setUsage(THREE.DynamicDrawUsage)
    lampGeo.setAttribute('iLamp', lampAttr)
    this.lampAttr = lampAttr
    const lampTint = new THREE.InstancedBufferAttribute(new Float32Array(GATE_LAMPS * 3), 3)
    lampTint.setUsage(THREE.DynamicDrawUsage)
    lampGeo.setAttribute('iLampTint', lampTint)
    this.lampTint = lampTint

    const lampMat = this.keepMat(new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: /* glsl */ `
        attribute float iLamp;
        attribute vec3 iLampTint;
        varying vec3 vN;
        varying float vI;
        varying vec3 vTint;
        void main() {
          vI = iLamp; vTint = iLampTint;
          vN = mat3(modelMatrix) * (mat3(instanceMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vN;
        varying float vI;
        varying vec3 vTint;
        void main() {
          vec3 N = normalize(vN);
          float lam = 0.30 + 0.70 * max(0.0, dot(N, normalize(vec3(0.35, 0.85, 0.25))));
          vec3 off = vec3(0.05, 0.045, 0.05) * lam;
          vec3 c = off + vTint * vI * 3.2;
          gl_FragColor = vec4(c, 1.0);
        }
      `,
    }))
    const lampMesh = new THREE.InstancedMesh(lampGeo, lampMat, GATE_LAMPS)
    lampMesh.frustumCulled = false
    lampMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
    this.group.add(lampMesh)

    this.lampGlow = this.makeGlow(GATE_LAMPS, 7)
    this.lampGlowAttr = this.lampGlow.geometry.getAttribute('iGlow') as THREE.InstancedBufferAttribute
    this.lampGlowTint = this.lampGlow.geometry.getAttribute('iTint') as THREE.InstancedBufferAttribute

    // Seed both tint buffers red so the countdown state is correct before the
    // first update, and a race that starts already green still repaints.
    const lta = lampTint.array as Float32Array
    const gta = this.lampGlowTint.array as Float32Array
    for (let i = 0; i < GATE_LAMPS; i++) {
      writeColor(C_LAMP_RED, lta, i * 3)
      writeColor(C_LAMP_RED, gta, i * 3)
    }

    _scl.set(1, 1, 1)
    for (let i = 0; i < GATE_LAMPS; i++) {
      _pos.set(lampPos[i * 3], lampPos[i * 3 + 1], lampPos[i * 3 + 2])
      _q.set(lampQuat[i * 4], lampQuat[i * 4 + 1], lampQuat[i * 4 + 2], lampQuat[i * 4 + 3])
      _m.compose(_pos, _q, _scl)
      lampMesh.setMatrixAt(i, _m)
      _m2.makeTranslation(_pos.x, _pos.y, _pos.z)
      this.lampGlow.setMatrixAt(i, _m2)
    }
    lampMesh.instanceMatrix.needsUpdate = true
    this.lampGlow.instanceMatrix.needsUpdate = true
  }

  // =========================================================================
  // START LIGHTS
  // =========================================================================

  setStartLights(n: number): void {
    const v = n < 0 ? 0 : n > 3 ? 3 : Math.round(n)
    if (v === 0 && (this.lightsN !== 0 || !this.lightsExplicit)) this.goT = GO_FADE
    this.lightsN = v
    this.lightsExplicit = true
  }

  private updateLights(dt: number, state: RaceState): void {
    if (!this.lightsExplicit) {
      // Fallback so the gantry is never wrong when nobody drives it.
      let n = 0
      if (state.phase === 'countdown') {
        n = Math.ceil(state.countdown)
        n = n < 0 ? 0 : n > 3 ? 3 : n
      }
      if (n === 0 && this.lightsN !== 0) this.goT = GO_FADE
      this.lightsN = n
    }

    const green = this.lightsN === 0
    if (green) this.goT = Math.max(0, this.goT - dt)
    const lit = green ? GATE_COUNT : GATE_COUNT + 1 - this.lightsN
    const goLevel = green ? this.goT / GO_FADE : 1

    const la = this.lampAttr.array as Float32Array
    const lt = this.lampTint.array as Float32Array
    const ga = this.lampGlowAttr.array as Float32Array
    const gt = this.lampGlowTint.array as Float32Array
    const k = 1 - Math.pow(0.001, dt) // ~critically snappy ramp

    const hue = green ? this.lampGreen : this.lampRed
    const hueChanged = green !== this.lampWasGreen
    this.lampWasGreen = green

    for (let g = 0; g < GATE_COUNT; g++) {
      this.gateTarget[g] = g < lit ? goLevel : 0
      this.gateLit[g] += (this.gateTarget[g] - this.gateLit[g]) * k
      const v = this.gateLit[g]
      for (let j = 0; j < LAMPS_PER_GATE; j++) {
        const i = g * LAMPS_PER_GATE + j
        la[i] = v
        if (hueChanged) {
          lt[i * 3] = hue[0]; lt[i * 3 + 1] = hue[1]; lt[i * 3 + 2] = hue[2]
          gt[i * 3] = hue[0]; gt[i * 3 + 1] = hue[1]; gt[i * 3 + 2] = hue[2]
        }
        ga[i * 4] = 2.6 + v * 1.4
        ga[i * 4 + 1] = 0.012
        ga[i * 4 + 2] = v * 1.15
        ga[i * 4 + 3] = 0
      }
    }
    this.lampAttr.needsUpdate = true
    this.lampGlowAttr.needsUpdate = true
    if (hueChanged) {
      this.lampTint.needsUpdate = true
      this.lampGlowTint.needsUpdate = true
    }
  }

  // =========================================================================
  // UPDATE
  // =========================================================================

  update(dt: number, state: RaceState, time: number): void {
    this.time.value = time
    // This module and the VFX pass are the only two render modules handed
    // RaceState, and the road material and the environment both need the ice
    // shelf's latch. Publish it; see render/hazardSignal.ts for why here.
    publishHazard(state.iceCracked, dt)
    this.updateBoxes(dt, state, time)
    this.updateCharges(dt, state, time)
    this.updateProjectiles(dt, state)
    this.updateFields(state)
    this.updateLights(dt, state)
  }

  // --- item boxes -----------------------------------------------------------

  private updateBoxes(dt: number, state: RaceState, time: number): void {
    const boxes = state.itemBoxes
    const n = Math.min(this.boxCount, boxes.length)
    const attr = this.boxAttr.array as Float32Array
    const aura = this.auraAttr.array as Float32Array

    for (let i = 0; i < n; i++) {
      const b = boxes[i]
      let mode = this.boxMode[i]

      // Drive the state machine off .active. The sim owns the truth.
      if (!b.active && (mode === MODE_IDLE || mode === MODE_POP)) {
        mode = MODE_COLLECT
        this.boxT[i] = 0
      } else if (b.active && (mode === MODE_HIDDEN || mode === MODE_COLLECT)) {
        mode = MODE_POP
        this.boxT[i] = 0
      }

      let scale = 1
      let flash = 0
      if (mode === MODE_COLLECT) {
        this.boxT[i] += dt
        const t = clamp01(this.boxT[i] / COLLECT_TIME)
        scale = (1 - t) * (1 + 0.55 * Math.sin(t * Math.PI))
        flash = (1 - t) * (1 - t) * 1.4
        if (t >= 1) { mode = MODE_HIDDEN; scale = 0; flash = 0 }
      } else if (mode === MODE_POP) {
        this.boxT[i] += dt
        const t = clamp01(this.boxT[i] / POP_TIME)
        scale = easeOutBack(t)
        flash = (1 - t) * 0.5
        if (t >= 1) { mode = MODE_IDLE; scale = 1 }
      } else if (mode === MODE_HIDDEN) {
        scale = 0
      } else {
        scale = 1
      }
      this.boxMode[i] = mode

      const phase = attr[i * 4]
      attr[i * 4 + 1] = flash

      if (scale <= 0.001) {
        this.boxMesh.setMatrixAt(i, _zero)
        this.boxAura.setMatrixAt(i, _zero)
        aura[i * 4 + 2] = 0
        continue
      }

      // Bobbed along the box's OWN up -- the surface normal the sim placed it
      // on, world +Y everywhere on a flat track. Along world +Y a box on a
      // wall-ride swings a quarter-metre in and out of the ribbon instead of
      // hovering over it.
      const bob = Math.sin(time * 1.15 + phase) * 0.22
      _pos.set(b.pos.x + b.up.x * bob, b.pos.y + b.up.y * bob, b.pos.z + b.up.z * bob)
      _e.set(time * 0.62 + phase, time * 0.41 + phase * 1.7, 0)
      _q.setFromEuler(_e)
      _scl.set(scale, scale, scale)
      _m.compose(_pos, _q, _scl)
      this.boxMesh.setMatrixAt(i, _m)

      _m2.makeTranslation(_pos.x, _pos.y, _pos.z)
      this.boxAura.setMatrixAt(i, _m2)
      // Minimum angular size keeps a box readable from the far side of a lap.
      aura[i * 4] = 4.6 * scale
      aura[i * 4 + 1] = 0.020
      aura[i * 4 + 2] = (0.55 + 0.25 * Math.sin(time * 3.2 + phase)) * scale + flash * 0.6
      aura[i * 4 + 3] = 0
    }

    for (let i = n; i < this.boxCount; i++) {
      this.boxMesh.setMatrixAt(i, _zero)
      this.boxAura.setMatrixAt(i, _zero)
    }

    this.boxMesh.instanceMatrix.needsUpdate = true
    this.boxAura.instanceMatrix.needsUpdate = true
    this.boxAttr.needsUpdate = true
    this.auraAttr.needsUpdate = true
  }

  // --- charge pickups -------------------------------------------------------

  private updateCharges(dt: number, state: RaceState, time: number): void {
    const cps = state.chargePickups
    const n = Math.min(this.chargeCount, cps.length)
    const attr = this.chargeAttr.array as Float32Array
    const glow = this.chargeGlowAttr.array as Float32Array

    for (let i = 0; i < n; i++) {
      const c = cps[i]
      let mode = this.chargeMode[i]
      if (!c.active && (mode === MODE_IDLE || mode === MODE_POP)) {
        mode = MODE_COLLECT
        this.chargeT[i] = 0
      } else if (c.active && (mode === MODE_HIDDEN || mode === MODE_COLLECT)) {
        mode = MODE_POP
        this.chargeT[i] = 0
      }

      let scale = 1
      let bright = 1
      if (mode === MODE_COLLECT) {
        this.chargeT[i] += dt
        const t = clamp01(this.chargeT[i] / CHARGE_COLLECT)
        scale = (1 - t) * (1 + 0.8 * t)
        bright = 1 + t * 3
        if (t >= 1) { mode = MODE_HIDDEN; scale = 0 }
      } else if (mode === MODE_POP) {
        this.chargeT[i] += dt
        const t = clamp01(this.chargeT[i] / CHARGE_POP)
        scale = easeOutBack(t)
        if (t >= 1) { mode = MODE_IDLE; scale = 1 }
      } else if (mode === MODE_HIDDEN) {
        scale = 0
      }
      this.chargeMode[i] = mode
      attr[i * 2 + 1] = bright

      if (scale <= 0.001) {
        this.chargeMesh.setMatrixAt(i, _zero)
        this.chargeGlow.setMatrixAt(i, _zero)
        glow[i * 4 + 2] = 0
        continue
      }

      const phase = attr[i * 2]
      const bob = Math.sin(time * 1.9 + phase) * 0.15
      _pos.set(c.pos.x + c.up.x * bob, c.pos.y + c.up.y * bob, c.pos.z + c.up.z * bob)
      _e.set(0.35, time * 2.7 + phase, 0.18)
      _q.setFromEuler(_e)
      _scl.set(scale, scale, scale)
      _m.compose(_pos, _q, _scl)
      this.chargeMesh.setMatrixAt(i, _m)

      _m2.makeTranslation(_pos.x, _pos.y, _pos.z)
      this.chargeGlow.setMatrixAt(i, _m2)
      glow[i * 4] = 1.5 * scale
      glow[i * 4 + 1] = 0.008
      glow[i * 4 + 2] = 0.55 * scale * bright
      glow[i * 4 + 3] = 0
    }

    for (let i = n; i < this.chargeCount; i++) {
      this.chargeMesh.setMatrixAt(i, _zero)
      this.chargeGlow.setMatrixAt(i, _zero)
    }

    this.chargeMesh.instanceMatrix.needsUpdate = true
    this.chargeGlow.instanceMatrix.needsUpdate = true
    this.chargeAttr.needsUpdate = true
    this.chargeGlowAttr.needsUpdate = true
  }

  // --- projectiles ----------------------------------------------------------

  private updateProjectiles(dt: number, state: RaceState): void {
    for (let s = 0; s < PROJ_POOL; s++) this.projSeen[s] = 0

    const list = state.projectiles
    const glow = this.projGlowAttr.array as Float32Array

    // 1. Bind live sim projectiles to pool slots and drive their visuals.
    for (let i = 0; i < list.length; i++) {
      const p = list[i]
      if (!p.alive) continue
      const kind = p.kind === 'rail' ? KIND_RAIL : p.kind === 'seeker' ? KIND_SEEKER : KIND_ALPHA
      const base = PROJ_BASE[kind]
      const size = PROJ_SIZE[kind]

      let slot = -1
      for (let k = 0; k < size; k++) {
        if (this.projId[base + k] === p.id) { slot = base + k; break }
      }
      if (slot < 0) {
        for (let k = 0; k < size; k++) {
          if (this.projId[base + k] < 0) { slot = base + k; break }
        }
      }
      if (slot < 0) {
        // Pool is full: recycle the slot whose projectile is already dying.
        let bestT = -1
        for (let k = 0; k < size; k++) {
          if (this.projDying[base + k] > bestT) { bestT = this.projDying[base + k]; slot = base + k }
        }
        if (slot < 0) continue
      }

      if (this.projId[slot] !== p.id) {
        this.projId[slot] = p.id
        this.projFilled[slot] = 0
        this.primeSpine(slot, p.pos.x, p.pos.y, p.pos.z)
      }
      this.projSeen[slot] = 1
      this.projDying[slot] = 0
      this.projFade[slot] = 1

      // Orient along velocity. Alpha rides the spline, so its velocity is
      // synthesised by the sim and still points where it is going.
      const vx = p.vel.x, vy = p.vel.y, vz = p.vel.z
      const vl = Math.sqrt(vx * vx + vy * vy + vz * vz)
      if (vl > 1e-4) {
        _va.set(vx / vl, vy / vl, vz / vl)
        _q.setFromUnitVectors(_fwd, _va)
      } else {
        _q.identity()
      }
      _pos.set(p.pos.x, p.pos.y, p.pos.z)
      _scl.set(1, 1, 1)
      _m.compose(_pos, _q, _scl)
      this.bodyMesh[kind].setMatrixAt(slot - base, _m)

      const battr = this.bodyAttr[kind].array as Float32Array
      battr[(slot - base) * 4 + 2] = 1

      _m2.makeTranslation(p.pos.x, p.pos.y, p.pos.z)
      this.projGlow.setMatrixAt(slot, _m2)
      if (kind === KIND_ALPHA) {
        glow[slot * 4] = 7.5
        glow[slot * 4 + 1] = 0.034   // never smaller than ~2 degrees of screen
        glow[slot * 4 + 2] = 1.15
        glow[slot * 4 + 3] = 1       // warning-aura style
      } else if (kind === KIND_SEEKER) {
        glow[slot * 4] = 2.3
        glow[slot * 4 + 1] = 0.011
        glow[slot * 4 + 2] = 0.8
        glow[slot * 4 + 3] = 0
      } else {
        glow[slot * 4] = 1.6
        glow[slot * 4 + 1] = 0.008
        glow[slot * 4 + 2] = 0.75
        glow[slot * 4 + 3] = 0
      }

      this.pushSpine(slot, p.pos.x, p.pos.y, p.pos.z)
    }

    // 2. Retire slots the sim no longer lists; their trails linger and fade.
    for (let s = 0; s < PROJ_POOL; s++) {
      if (this.projSeen[s] === 1) continue
      if (this.projId[s] < 0 && this.projFade[s] <= 0) continue

      const kind = slotKind(s)
      const base = PROJ_BASE[kind]
      this.projDying[s] += dt
      this.projFade[s] = Math.max(0, 1 - this.projDying[s] / TRAIL_LINGER)
      this.bodyMesh[kind].setMatrixAt(s - base, _zero)
      glow[s * 4 + 2] = 0
      this.projGlow.setMatrixAt(s, _zero)
      if (this.projFade[s] <= 0) {
        this.projId[s] = -1
        this.projFilled[s] = 0
      }
    }

    this.writeTrails()

    for (let k = 0; k < 3; k++) {
      this.bodyMesh[k].instanceMatrix.needsUpdate = true
      this.bodyAttr[k].needsUpdate = true
    }
    this.projGlow.instanceMatrix.needsUpdate = true
    this.projGlowAttr.needsUpdate = true
  }

  /** Collapse a slot's whole spine onto a spawn point. */
  private primeSpine(slot: number, x: number, y: number, z: number): void {
    const S = this.trailSeg
    const base = slot * S * 3
    for (let i = 0; i < S; i++) {
      this.spine[base + i * 3] = x
      this.spine[base + i * 3 + 1] = y
      this.spine[base + i * 3 + 2] = z
    }
  }

  /**
   * Distance-gated history push, so trail length is metres of flight rather
   * than a count of render frames.
   */
  private pushSpine(slot: number, x: number, y: number, z: number): void {
    const S = this.trailSeg
    const base = slot * S * 3
    const dx = x - this.spine[base]
    const dy = y - this.spine[base + 1]
    const dz = z - this.spine[base + 2]
    if (dx * dx + dy * dy + dz * dz > TRAIL_STEP * TRAIL_STEP) {
      this.spine.copyWithin(base + 3, base, base + (S - 1) * 3)
      if (this.projFilled[slot] < S) this.projFilled[slot]++
    }
    this.spine[base] = x
    this.spine[base + 1] = y
    this.spine[base + 2] = z
  }

  /** Push the spine buffers out to the ribbon vertex attributes. */
  private writeTrails(): void {
    const S = this.trailSeg
    const pos = this.trailPosAttr.array as Float32Array
    const dir = this.trailDirAttr.array as Float32Array
    const fade = this.trailFadeAttr.array as Float32Array
    let dirty = false

    for (let s = 0; s < PROJ_POOL; s++) {
      const f = this.projFade[s]
      const sb = s * S * 3
      const vb = s * S * 2
      const filled = this.projFilled[s]

      // A faded-out ribbon has zero width everywhere, so its triangles are
      // already degenerate. Zero the fade once, then leave it alone: the
      // common frame has no missiles in flight at all.
      if (f <= 0) {
        if (this.trailIdle[s] === 1) continue
        this.trailIdle[s] = 1
        for (let v = vb; v < vb + S * 2; v++) fade[v] = 0
        dirty = true
        continue
      }
      this.trailIdle[s] = 0
      dirty = true

      for (let i = 0; i < S; i++) {
        const si = sb + i * 3
        const x = this.spine[si]
        const y = this.spine[si + 1]
        const z = this.spine[si + 2]

        const ia = i > 0 ? i - 1 : 0
        const ib = i < S - 1 ? i + 1 : S - 1
        const ax = this.spine[sb + ia * 3]
        const ay = this.spine[sb + ia * 3 + 1]
        const az = this.spine[sb + ia * 3 + 2]
        const bx = this.spine[sb + ib * 3]
        const by = this.spine[sb + ib * 3 + 1]
        const bz = this.spine[sb + ib * 3 + 2]

        // Segments beyond what the projectile has actually flown stay dark and
        // collapsed, so a fresh missile does not flash a full-length ribbon.
        const a = i < filled ? f : 0

        for (let j = 0; j < 2; j++) {
          const v = (vb + i * 2 + j) * 3
          pos[v] = x; pos[v + 1] = y; pos[v + 2] = z
          dir[v] = bx - ax; dir[v + 1] = by - ay; dir[v + 2] = bz - az
          fade[vb + i * 2 + j] = a
        }
      }
    }

    if (dirty) {
      this.trailPosAttr.needsUpdate = true
      this.trailDirAttr.needsUpdate = true
      this.trailFadeAttr.needsUpdate = true
    }
  }

  // --- fields ---------------------------------------------------------------

  private updateFields(state: RaceState): void {
    for (let i = 0; i < MINE_POOL; i++) this.mineSeen[i] = 0
    for (let i = 0; i < WELL_POOL; i++) this.wellSeen[i] = 0

    const mineAttr = this.mineAttr.array as Float32Array
    const wellAttr = this.wellAttr.array as Float32Array
    const ringAttr = this.ringAttr.array as Float32Array
    const list = state.fields
    const trigger = ITEM_PARAMS.voidMine.triggerRadius

    for (let i = 0; i < list.length; i++) {
      const f = list[i]
      if (!f.alive) continue

      if (f.kind === 'mine') {
        let slot = -1
        for (let k = 0; k < MINE_POOL; k++) if (this.mineId[k] === f.id) { slot = k; break }
        if (slot < 0) for (let k = 0; k < MINE_POOL; k++) if (this.mineId[k] < 0) { slot = k; break }
        if (slot < 0) continue
        if (this.mineId[slot] !== f.id) {
          this.mineId[slot] = f.id
          this.anchor(f.pos.x, f.pos.y, f.pos.z, this.mineAnchor, slot)
        }
        this.mineSeen[slot] = 1

        const armed = f.armDelay > 0 ? 0 : 1
        const fade = clamp01(f.life)
        const spin = this.time.value * (armed > 0 ? 0.85 : 0.12)

        _pos.set(f.pos.x, f.pos.y, f.pos.z)
        _e.set(spin * 0.4, spin, spin * 0.25)
        _q.setFromEuler(_e)
        const pulse = armed > 0 ? 1 + 0.06 * Math.sin(this.time.value * 5 + slot) : 1
        _scl.set(pulse, pulse, pulse)
        _m.compose(_pos, _q, _scl)
        this.mineMesh.setMatrixAt(slot, _m)
        mineAttr[slot * 4] = armed
        mineAttr[slot * 4 + 1] = fade
        mineAttr[slot * 4 + 2] = slot * 1.7

        // The proximity ring is the contract with the player: it sits at
        // exactly the radius that will spin them out, and only once armed.
        this.placeRing(slot, this.mineAnchor, slot, trigger, armed * fade, 7.0, ringAttr)
      } else {
        let slot = -1
        for (let k = 0; k < WELL_POOL; k++) if (this.wellId[k] === f.id) { slot = k; break }
        if (slot < 0) for (let k = 0; k < WELL_POOL; k++) if (this.wellId[k] < 0) { slot = k; break }
        if (slot < 0) continue
        if (this.wellId[slot] !== f.id) {
          this.wellId[slot] = f.id
          this.anchor(f.pos.x, f.pos.y, f.pos.z, this.wellAnchor, slot)
        }
        this.wellSeen[slot] = 1

        const fade = clamp01(f.life)
        _pos.set(f.pos.x, f.pos.y, f.pos.z)
        _q.identity()
        // Scale is exactly f.radius: the visible rim is the real field edge.
        _scl.set(f.radius, f.radius, f.radius)
        _m.compose(_pos, _q, _scl)
        this.wellMesh.setMatrixAt(slot, _m)
        wellAttr[slot * 4] = fade
        wellAttr[slot * 4 + 1] = slot * 2.3

        const uw = this.uWellPos[slot]
        uw.set(f.pos.x, f.pos.y, f.pos.z, f.radius)
        this.uWellFade[slot] = fade

        this.placeRing(MINE_POOL + slot, this.wellAnchor, slot, f.radius, fade, 3.4, ringAttr)
      }
    }

    for (let k = 0; k < MINE_POOL; k++) {
      if (this.mineSeen[k] === 1) continue
      if (this.mineId[k] >= 0) this.mineId[k] = -1
      this.mineMesh.setMatrixAt(k, _zero)
      this.ringMesh.setMatrixAt(k, _zero)
      ringAttr[k * 4] = 0
    }
    for (let k = 0; k < WELL_POOL; k++) {
      if (this.wellSeen[k] === 1) continue
      if (this.wellId[k] >= 0) this.wellId[k] = -1
      this.wellMesh.setMatrixAt(k, _zero)
      this.ringMesh.setMatrixAt(MINE_POOL + k, _zero)
      ringAttr[(MINE_POOL + k) * 4] = 0
      this.uWellFade[k] = 0
      this.uWellPos[k].set(0, -9999, 0, 1)
    }

    this.mineMesh.instanceMatrix.needsUpdate = true
    this.wellMesh.instanceMatrix.needsUpdate = true
    this.ringMesh.instanceMatrix.needsUpdate = true
    this.mineAttr.needsUpdate = true
    this.wellAttr.needsUpdate = true
    this.ringAttr.needsUpdate = true
  }

  private placeRing(
    ringSlot: number, anchors: Float32Array, aSlot: number,
    radius: number, fade: number, speed: number, attr: Float32Array,
  ): void {
    if (fade <= 0.001) {
      this.ringMesh.setMatrixAt(ringSlot, _zero)
      attr[ringSlot * 4] = 0
      return
    }
    const o = aSlot * 7
    _pos.set(anchors[o], anchors[o + 1], anchors[o + 2])
    _q.set(anchors[o + 3], anchors[o + 4], anchors[o + 5], anchors[o + 6])
    _scl.set(radius, 1, radius)
    _m.compose(_pos, _q, _scl)
    this.ringMesh.setMatrixAt(ringSlot, _m)
    attr[ringSlot * 4] = fade
    attr[ringSlot * 4 + 1] = ringSlot * 1.3
    attr[ringSlot * 4 + 2] = speed
    attr[ringSlot * 4 + 3] = 0
  }

  /**
   * Lay a field's ground ring on the actual track surface, banking included.
   * Runs once per field spawn, never per frame.
   */
  private anchor(x: number, y: number, z: number, out: Float32Array, slot: number): void {
    const smp = this.track.samples
    const n = smp.length
    const stride = 8
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < n; i += stride) {
      const p = smp[i].pos
      const dx = x - p.x, dy = y - p.y, dz = z - p.z
      const d = dx * dx + dy * dy + dz * dz
      if (d < bestD) { bestD = d; best = i }
    }
    let refined = best
    bestD = Infinity
    for (let k = -stride; k <= stride; k++) {
      const i = ((best + k) % n + n) % n
      const p = smp[i].pos
      const dx = x - p.x, dy = y - p.y, dz = z - p.z
      const d = dx * dx + dy * dy + dz * dz
      if (d < bestD) { bestD = d; refined = i }
    }

    const s = smp[refined]
    const lateral = (x - s.pos.x) * s.right.x + (y - s.pos.y) * s.right.y + (z - s.pos.z) * s.right.z
    const o = slot * 7
    out[o] = s.pos.x + s.right.x * lateral + s.normal.x * 0.14
    out[o + 1] = s.pos.y + s.right.y * lateral + s.normal.y * 0.14
    out[o + 2] = s.pos.z + s.right.z * lateral + s.normal.z * 0.14

    _va.set(s.right.x, s.right.y, s.right.z)
    _vb.set(s.normal.x, s.normal.y, s.normal.z)
    _vc.set(s.tangent.x, s.tangent.y, s.tangent.z)
    _m2.makeBasis(_va, _vb, _vc)
    _q.setFromRotationMatrix(_m2)
    out[o + 3] = _q.x
    out[o + 4] = _q.y
    out[o + 5] = _q.z
    out[o + 6] = _q.w
  }

  // =========================================================================

  dispose(): void {
    // A rematch must not begin with the shelf already through the ice.
    resetHazard()
    for (let i = 0; i < this.geos.length; i++) this.geos[i].dispose()
    for (let i = 0; i < this.mats.length; i++) this.mats[i].dispose()
    this.geos.length = 0
    this.mats.length = 0
    this.group.clear()
  }
}

function slotKind(slot: number): number {
  if (slot < PROJ_BASE[KIND_SEEKER]) return KIND_RAIL
  if (slot < PROJ_BASE[KIND_ALPHA]) return KIND_SEEKER
  return KIND_ALPHA
}

// ---------------------------------------------------------------------------
// Projectile geometry. +Z is forward; the pool orients each instance along
// its velocity.
// ---------------------------------------------------------------------------

/** Rail Missile: a thin hard-edged dart that reads as pure aimed speed. */
function railGeometry(): THREE.BufferGeometry {
  const HP = Math.PI / 2
  return mergeParts([
    { geo: new THREE.ConeGeometry(0.17, 1.5, 6), color: 0xfff6cf, emissive: 0.55, xform: xf(0, 0, 0.55, HP) },
    { geo: new THREE.CylinderGeometry(0.09, 0.17, 0.85, 6, 1, true), color: 0x9a7a16, emissive: 0.1, xform: xf(0, 0, -0.62, HP) },
    { geo: new THREE.BoxGeometry(0.03, 0.34, 0.5), color: 0xffe98a, emissive: 0.3, xform: xf(0, 0, -0.7, HP) },
    { geo: new THREE.BoxGeometry(0.34, 0.03, 0.5), color: 0xffe98a, emissive: 0.3, xform: xf(0, 0, -0.7, HP) },
    { geo: new THREE.CylinderGeometry(0.11, 0.11, 0.16, 6), color: 0xffffff, emissive: 1.0, xform: xf(0, 0, -1.04, HP) },
  ])
}

/** Seeker Missile: stubby, finned, obviously a guided weapon. */
function seekerGeometry(): THREE.BufferGeometry {
  const HP = Math.PI / 2
  const parts: GeoPart[] = [
    { geo: new THREE.ConeGeometry(0.33, 0.72, 8), color: 0xffd0a0, emissive: 0.35, xform: xf(0, 0, 0.9, HP) },
    { geo: new THREE.CylinderGeometry(0.33, 0.30, 1.25, 8, 1, true), color: 0xc0662a, emissive: 0.06, xform: xf(0, 0, -0.08, HP) },
    { geo: new THREE.CylinderGeometry(0.34, 0.34, 0.14, 8), color: 0xffb060, emissive: 0.9, xform: xf(0, 0, 0.42, HP) },
    { geo: new THREE.CylinderGeometry(0.26, 0.30, 0.34, 8, 1, true), color: 0x6b3a18, emissive: 0.05, xform: xf(0, 0, -0.86, HP) },
    { geo: new THREE.ConeGeometry(0.22, 0.5, 8), color: 0xffffff, emissive: 1.0, xform: xf(0, 0, -1.18, -HP) },
  ]
  // Four canted fins.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2
    const m = new THREE.Matrix4().makeRotationZ(a)
    const t = new THREE.Matrix4().makeTranslation(0, 0.44, -0.62)
    m.multiply(t)
    parts.push({ geo: new THREE.BoxGeometry(0.05, 0.46, 0.52), color: 0xffa14a, emissive: 0.2, xform: m })
  }
  return mergeParts(parts)
}

/** Alpha Missile: the one that hunts first place. Big, red, and unfriendly. */
function alphaGeometry(): THREE.BufferGeometry {
  const HP = Math.PI / 2
  const parts: GeoPart[] = [
    { geo: new THREE.ConeGeometry(0.62, 1.6, 10), color: 0xff9aa8, emissive: 0.5, xform: xf(0, 0, 1.5, HP) },
    { geo: new THREE.CylinderGeometry(0.62, 0.58, 1.9, 10, 1, true), color: 0x9c1026, emissive: 0.05, xform: xf(0, 0, -0.25, HP) },
    // Exposed reactor band: the pulsing heart of the thing.
    { geo: new THREE.CylinderGeometry(0.67, 0.67, 0.36, 10, 1, true), color: 0xffffff, emissive: 1.0, xform: xf(0, 0, 0.5, HP) },
    { geo: new THREE.CylinderGeometry(0.67, 0.67, 0.26, 10, 1, true), color: 0xffffff, emissive: 1.0, xform: xf(0, 0, -0.55, HP) },
    { geo: new THREE.CylinderGeometry(0.5, 0.78, 0.55, 10, 1, true), color: 0x5e0a16, emissive: 0.05, xform: xf(0, 0, -1.45, HP) },
    { geo: new THREE.ConeGeometry(0.46, 0.9, 10), color: 0xffffff, emissive: 1.0, xform: xf(0, 0, -1.95, -HP) },
  ]
  // Four heavy canards plus four rear stabilisers, staggered 45 degrees.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2
    const m = new THREE.Matrix4().makeRotationZ(a)
    m.multiply(new THREE.Matrix4().makeTranslation(0, 0.82, 0.55))
    parts.push({ geo: new THREE.BoxGeometry(0.09, 0.5, 0.9), color: 0xff3350, emissive: 0.35, xform: m })
    const m2 = new THREE.Matrix4().makeRotationZ(a + Math.PI / 4)
    m2.multiply(new THREE.Matrix4().makeTranslation(0, 0.95, -1.1))
    parts.push({ geo: new THREE.BoxGeometry(0.11, 0.78, 0.8), color: 0xd11f38, emissive: 0.25, xform: m2 })
  }
  return mergeParts(parts)
}
