/**
 * src/render/vehicles.ts — procedural vehicle + pilot art.
 * ---------------------------------------------------------------------------
 * Owns every chassis mesh in the game. No external model files, no image
 * textures: silhouette comes from geometry, detail comes from emissive.
 *
 * ART RULES ENFORCED HERE
 *  - Every vehicle must be identifiable by silhouette alone at 40px.
 *  - Flat / gradient base colours only. All "detail" is geometry or emissive.
 *  - Every body carries a cheap fresnel RIM LIGHT so it separates from any
 *    background. Injected into MeshStandardMaterial via onBeforeCompile so we
 *    keep real scene lighting + shadows and still get the stylised edge.
 *    rimPower is deliberately high (3.6): at 2.4 the fresnel washed every
 *    near-horizontal panel pale from the shallow chase angle, which is most of
 *    why an earlier build read as a stack of flat grey planes.
 *
 * THE ONLY ANGLE THAT MATTERS
 *  The chase camera sits 9m behind, 3.6m up, looking 13m ahead at 62-86 deg
 *  FOV -- about 22 degrees above the deck, from directly astern. A player
 *  stares at the BACK of their own vehicle for an entire race, so every
 *  chassis here is composed rear-first and side-second:
 *    - a defined nose, a cabin/canopy that sits LOWER than the shoulders
 *      flanking it, and visible wheels or thrusters;
 *    - a rear face with real content: lamp clusters, machined exhaust cans,
 *      a wing or tail group, and panel breakup;
 *    - no wide primary-coloured horizontal plate is ever the highest thing on
 *      the vehicle, because that is what reads as furniture.
 *  Thruster hardware is STATIC body geometry (addExhaustCan); only the flame
 *  is instanced, so boost can stretch fire without stretching machinery.
 *
 * THE PILOT
 *  0.8m sphere against a 2.3m-wide car: it has to read as a head. Every seat
 *  is a tub the ball drops into up to its equator, so only the top half clears
 *  the bodywork. The face material draws TWO panels from one buffer -- the
 *  face proper, and a rear repeater tilted up at the chase camera -- so the
 *  expression system is visible from the angle the game is actually played
 *  from. Both sit above the equator or the cockpit rim eats them.
 *
 * COORDINATE CONVENTION
 *  The sim uses forward = (sin yaw, 0, cos yaw), right = (cos yaw, 0, -sin yaw).
 *  So models are authored NOSE-TOWARD +Z, +X to the right, +Y up, and the root
 *  group's rotation.y can be set straight from r.yaw.
 *  Model origin == r.pos, which the sim places rideHeight above the surface,
 *  so the ground plane in model space sits at y = -rideHeight.
 *
 * DRAW CALLS / TRIANGLES (LOD0, per vehicle, all <= 6 calls and <= 14k tris)
 *  solaire  5 calls, ~3.7k : body | wheels x4 | flames x2 | shell | face
 *  filament 6 calls, ~3.3k : body | repulsors x2 | ribbons | flames x4 | shell | face
 *  bulwark  6 calls, ~4.5k : body | cleats x32 | turret | flames x2 | shell | face
 *  dray9    6 calls, ~5.1k : body | wheels x6 | pods x3 | flames x2 | shell | face
 *  vector7  6 calls, ~4.1k : body | wings x4 | flames x4 | canopy | shell | face
 *  LOD1 = same rig, coarser geometry. LOD2 = 4 calls. LOD3 = 1 call.
 *
 * SHARING
 *  All BufferGeometry is built once per (chassis, detail) and cached in module
 *  scope, so eight racers share one set of buffers. Only the Group hierarchy
 *  and the four small per-instance materials (which hold the per-vehicle
 *  animation uniforms: boost gain, invincibility pulse, rim strength) are
 *  unique. update() allocates nothing.
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { ChassisDef, RacerState } from '../sim/types'
import type { RenderQuality, VehicleVisual } from './api'
import { CHASSIS, CHASSIS_BY_ID, getDerived } from '../content/chassis'
import { PILOTS, PILOTS_BY_ID } from '../content/pilots'
import type { PilotDef } from '../content/pilots'
import { TUNING } from '../content/tuning'

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** LOD switch distances in metres. LOD0 < 25 <= LOD1 < 70 <= LOD2 < 180 <= LOD3. */
export const LOD_DISTANCES: readonly [number, number, number] = [25, 70, 180]

/** Canonical rig node names. A swapped-in GLB that uses these names animates
 *  exactly like the procedural mesh — see setVehicleModelLoader. */
export const RIG_NODES = {
  body: 'sg_body',
  wheels: 'sg_wheels',
  cleats: 'sg_cleats',
  nozzles: 'sg_nozzles',
  wings: 'sg_wings',
  pods: 'sg_pods',
  turret: 'sg_turret',
  aux: 'sg_aux',
  pilot: 'sg_pilot',
  face: 'sg_face',
} as const

/**
 * The concrete object createVehicleVisual returns. It IS a VehicleVisual; the
 * extra members are opt-in and the scene layer can ignore them entirely.
 */
export interface VehicleVisualEx extends VehicleVisual {
  /** This vehicle's live animation uniforms. An authored model can reuse these
   *  materials to inherit boost gain, rim light and invincibility pulse. */
  readonly materials: VehicleMaterials
  /** The authored model currently standing in for the procedural rig, if any. */
  readonly model: THREE.Object3D | null
  /** When true (default) update() writes r.pos / r.yaw onto `group`. Set false
   *  if the scene layer wants to own placement (interpolation, prediction). */
  autoPlace: boolean
  /**
   * Set true on a track that authors up-vectors (`Track.hasGravity`), which
   * switches the body from a compass-yaw rotation to a full (fwd, up) basis so
   * a car on a wall is rolled onto the wall.
   *
   * It has to be told, rather than sniffing `r.up`: on a FLAT track the sim
   * never writes `r.fwd`/`r.up` after the grid is laid out, so both are frozen
   * at the start line's tangent and normal and are stale by the first corner.
   * That is deliberate on the sim side -- see the gravity switch in vehicle.ts
   * -- and it means the renderer must not read them unless gravity is live.
   */
  gravity: boolean
  /** Currently selected LOD index, 0..3. Read-only in practice. */
  readonly lodIndex: number
  /** Swap the procedural rig for a loaded model at any time (async GLB path).
   *  Pass null to restore the procedural rig. See setVehicleModelLoader. */
  attachModel(obj: THREE.Object3D | null): void
}

/** Signature of a future GLTF loader hook. See setVehicleModelLoader. */
export type VehicleModelLoader = (
  chassisId: string,
  def: ChassisDef,
  quality: RenderQuality,
) => THREE.Object3D | null

// ---------------------------------------------------------------------------
// Small maths / scratch. Nothing below allocates inside update().
// ---------------------------------------------------------------------------

const _m4 = new THREE.Matrix4()
const _m4b = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _e = new THREE.Euler()
const _v = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _s = new THREE.Vector3()
/** Scratch basis for the gravity-track body orientation. See update(). */
const _bx = new THREE.Vector3()
const _by = new THREE.Vector3()
const _bz = new THREE.Vector3()
const _basis = new THREE.Matrix4()

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
/** Frame-rate independent exponential approach. */
const approach = (cur: number, target: number, halfLife: number, dt: number): number =>
  cur + (target - cur) * (1 - Math.pow(2, -dt / Math.max(1e-4, halfLife)))

/** Compose into the shared scratch matrix. Callers must consume it immediately. */
function place(
  x = 0, y = 0, z = 0,
  rx = 0, ry = 0, rz = 0,
  sx = 1, sy = 1, sz = 1,
): THREE.Matrix4 {
  _e.set(rx, ry, rz, 'ZYX')
  _q.setFromEuler(_e)
  _v.set(x, y, z)
  _s.set(sx, sy, sz)
  return _m4.compose(_v, _q, _s)
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

interface SgUniforms {
  uEmisGain: { value: number }
  uRimColor: { value: THREE.Color }
  uRimPower: { value: number }
  uRimStrength: { value: number }
  uPulseColor: { value: THREE.Color }
  uPulse: { value: number }
}

/** MeshStandardMaterial + per-vertex emissive mask + fresnel rim. */
export interface SgBodyMaterial extends THREE.MeshStandardMaterial {
  sg: SgUniforms
}

interface BodyMatOpts {
  roughness?: number
  metalness?: number
  flatShading?: boolean
  transparent?: boolean
  opacity?: number
  side?: THREE.Side
  rim?: number
  rimPower?: number
  rimColor?: number
}

const VERT_HEAD = /* glsl */ `
attribute float aEmis;
varying float vEmis;
`
const FRAG_HEAD = /* glsl */ `
varying float vEmis;
uniform float uEmisGain;
uniform vec3  uRimColor;
uniform float uRimPower;
uniform float uRimStrength;
uniform vec3  uPulseColor;
uniform float uPulse;
`

function makeBodyMaterial(o: BodyMatOpts): SgBodyMaterial {
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: o.roughness ?? 0.48,
    metalness: o.metalness ?? 0.22,
    flatShading: o.flatShading ?? false,
    transparent: o.transparent ?? false,
    opacity: o.opacity ?? 1,
    side: o.side ?? THREE.FrontSide,
    depthWrite: o.transparent ? false : true,
  }) as SgBodyMaterial

  m.sg = {
    uEmisGain: { value: 1 },
    uRimColor: { value: new THREE.Color(o.rimColor ?? 0xbfe4ff) },
    uRimPower: { value: o.rimPower ?? 2.6 },
    uRimStrength: { value: o.rim ?? 0.55 },
    uPulseColor: { value: new THREE.Color(0xffffff) },
    uPulse: { value: 0 },
  }

  m.onBeforeCompile = (shader) => {
    shader.uniforms.uEmisGain = m.sg.uEmisGain
    shader.uniforms.uRimColor = m.sg.uRimColor
    shader.uniforms.uRimPower = m.sg.uRimPower
    shader.uniforms.uRimStrength = m.sg.uRimStrength
    shader.uniforms.uPulseColor = m.sg.uPulseColor
    shader.uniforms.uPulse = m.sg.uPulse

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_HEAD)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vEmis = aEmis;')

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_HEAD)
      // vColor exists because every body geometry sets a colour attribute.
      // Emissive parts re-use their own vertex colour as the glow colour.
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n  totalEmissiveRadiance += vColor * vEmis * uEmisGain;',
      )
      // Rim + invincibility pulse are added to outgoingLight so they still go
      // through tone mapping and the output colour-space conversion.
      .replace(
        '#include <opaque_fragment>',
        [
          '  float sgRim = 1.0 - clamp( dot( normalize( normal ), normalize( vViewPosition ) ), 0.0, 1.0 );',
          '  sgRim = pow( sgRim, uRimPower );',
          '  outgoingLight += uRimColor * sgRim * uRimStrength + uPulseColor * uPulse;',
          '#include <opaque_fragment>',
        ].join('\n'),
      )
  }
  // Constant key: every material made here injects identical source, so the
  // eight racers share one compiled program.
  m.customProgramCacheKey = () => 'sgBody'
  return m
}

/** Additive emissive material for light ribbons / trails. */
export interface SgGlowMaterial extends THREE.ShaderMaterial {
  sg: { uGain: { value: number }; uColor: { value: THREE.Color } }
}

function makeGlowMaterial(color: number): SgGlowMaterial {
  const m = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uGain: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUvG;
      void main() {
        vUvG = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uGain;
      varying vec2 vUvG;
      void main() {
        // v runs 1 at the emitter to 0 at the tail; x fades the edges.
        float taper = vUvG.y * vUvG.y;
        float edge = 1.0 - abs( vUvG.x * 2.0 - 1.0 );
        float a = taper * smoothstep( 0.0, 0.45, edge );
        if ( a < 0.004 ) discard;
        gl_FragColor = vec4( uColor * uGain * a, a );
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  }) as SgGlowMaterial
  m.sg = { uGain: m.uniforms.uGain as { value: number }, uColor: m.uniforms.uColor as { value: THREE.Color } }
  return m
}

/** The pilot's single emissive face panel. One shader carries all expression. */
export interface SgFaceMaterial extends THREE.ShaderMaterial {
  sg: {
    uTime: { value: number }
    uBlink: { value: number }
    uEmote: { value: number }
    uGlitch: { value: number }
    uGain: { value: number }
  }
}

function makeFaceMaterial(faceColor: number, glitch: number): SgFaceMaterial {
  const m = new THREE.ShaderMaterial({
    uniforms: {
      uFace: { value: new THREE.Color(faceColor) },
      uTime: { value: 0 },
      uBlink: { value: 0 },
      uEmote: { value: 0 },
      uGlitch: { value: glitch },
      uGain: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUvF;
      void main() {
        vUvF = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3  uFace;
      uniform float uTime;
      uniform float uBlink;
      uniform float uEmote;
      uniform float uGlitch;
      uniform float uGain;
      varying vec2 vUvF;

      float rrect( vec2 p, vec2 b, float r ) {
        vec2 d = abs( p ) - b + r;
        return length( max( d, 0.0 ) ) + min( max( d.x, d.y ), 0.0 ) - r;
      }
      float hash11( float n ) { return fract( sin( n * 12.9898 ) * 43758.5453 ); }

      void main() {
        vec2 p = vUvF * 2.0 - 1.0;

        // NULL-style corruption: quantised horizontal tearing.
        float gStep = floor( uTime * 9.0 );
        float g = uGlitch * step( 0.62, hash11( gStep ) );
        p.x += g * ( hash11( gStep + floor( p.y * 6.0 ) ) - 0.5 ) * 0.5;

        // Visor plate: the rounded-rect that reads as "a face" at 40 pixels.
        float plate = smoothstep( 0.03, -0.03, rrect( p, vec2( 0.88, 0.62 ), 0.44 ) );

        // Eyes. uBlink squashes them; uEmote raises and narrows them.
        float lid = clamp( uBlink, 0.0, 1.0 );
        vec2 e = vec2( abs( p.x ) - 0.40, p.y - 0.18 - uEmote * 0.06 );
        float eh = mix( 0.30, 0.025, lid ) * mix( 1.0, 0.68, max( uEmote, 0.0 ) );
        float eyes = smoothstep( 0.035, -0.012, rrect( e, vec2( 0.175, eh ), 0.10 ) );

        // Mouth: one bar whose curve is the whole expression range.
        float curve = uEmote * 0.24;
        vec2 mth = vec2( p.x, p.y + 0.44 + curve * ( 1.0 - p.x * p.x * 1.35 ) );
        float mouth = smoothstep( 0.035, -0.012, rrect( mth, vec2( 0.30, 0.05 ), 0.05 ) );

        float mask = max( eyes, mouth );
        float a = plate * 0.42 + mask;
        if ( a < 0.01 ) discard;
        vec3 col = uFace * ( plate * 0.16 + mask * 1.45 ) * uGain;
        gl_FragColor = vec4( col, a );
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }) as SgFaceMaterial
  m.sg = {
    uTime: m.uniforms.uTime as { value: number },
    uBlink: m.uniforms.uBlink as { value: number },
    uEmote: m.uniforms.uEmote as { value: number },
    uGlitch: m.uniforms.uGlitch as { value: number },
    uGain: m.uniforms.uGain as { value: number },
  }
  return m
}

// ---------------------------------------------------------------------------
// Geometry kit. Everything is indexed so mergeGeometries can fuse it, and
// every part carries a flat vertex colour plus an emissive mask (aEmis).
// ---------------------------------------------------------------------------

/** Vertex-level shaping applied to a box. Cheap way to get real silhouettes. */
interface BoxShape {
  /** Width scale at the nose (+Z) / tail (-Z). */
  frontX?: number
  backX?: number
  /** Top-height scale at the nose / tail. Bottom face stays flat. */
  frontY?: number
  backY?: number
  /** Width scale applied to the top face only (cabin taper / tumblehome). */
  topX?: number
  /** Y offset added proportionally to z/halfDepth (a wedge rake). */
  shear?: number
  /** Span shaping for wings. ts runs 0 at the -X face (root) to 1 at +X (tip).
   *  spanZ scales the chord, spanY the thickness, spanSweep pushes the tip
   *  toward +Z (forward sweep) — build centred, then translate +halfWidth. */
  spanZ?: [number, number]
  spanY?: [number, number]
  spanSweep?: number
}

function shapedBox(w: number, h: number, d: number, s?: BoxShape): THREE.BufferGeometry {
  const g: THREE.BufferGeometry = new THREE.BoxGeometry(w, h, d)
  if (!s) return g
  const pos = g.getAttribute('position') as THREE.BufferAttribute
  const hw = w * 0.5 || 1
  const hd = d * 0.5 || 1
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i)
    let y = pos.getY(i)
    let z = pos.getZ(i)
    const tz = (z / hd + 1) * 0.5           // 0 at tail .. 1 at nose
    const ts = (x / hw + 1) * 0.5           // 0 at -X root .. 1 at +X tip
    x *= lerp(s.backX ?? 1, s.frontX ?? 1, tz)
    if (y > 0) {
      y *= lerp(s.backY ?? 1, s.frontY ?? 1, tz)
      x *= s.topX ?? 1
    }
    if (s.spanZ) z *= lerp(s.spanZ[0], s.spanZ[1], ts)
    if (s.spanY) y *= lerp(s.spanY[0], s.spanY[1], ts)
    if (s.spanSweep) z += s.spanSweep * ts
    if (s.shear) y += s.shear * (z / hd)
    pos.setXYZ(i, x, y, z)
  }
  pos.needsUpdate = true
  g.computeVertexNormals()
  return g
}

const cyl = (rt: number, rb: number, h: number, seg: number, open = false): THREE.BufferGeometry =>
  new THREE.CylinderGeometry(rt, rb, h, seg, 1, open)

const sph = (r: number, ws: number, hs: number): THREE.BufferGeometry =>
  new THREE.SphereGeometry(r, ws, hs)

/** A flat panel bent onto a sphere of the given radius, facing +Z. Used for
 *  the pilot's face plate: 12 triangles that still hug the head. */
function spherePanel(radius: number, w: number, h: number, seg: number): THREE.BufferGeometry {
  const g: THREE.BufferGeometry = new THREE.PlaneGeometry(w, h, seg, Math.max(1, seg - 1))
  const pos = g.getAttribute('position') as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const r2 = radius * radius - x * x - y * y
    pos.setZ(i, Math.sqrt(Math.max(r2, radius * radius * 0.16)) * 1.022)
  }
  pos.needsUpdate = true
  g.computeVertexNormals()
  return g
}

/** Accumulates transformed, coloured sub-parts and fuses them into one buffer. */
class Parts {
  private list: THREE.BufferGeometry[] = []

  add(geo: THREE.BufferGeometry, color: THREE.Color, emis: number, m?: THREE.Matrix4): this {
    if (m) geo.applyMatrix4(m)
    geo.deleteAttribute('uv')
    geo.deleteAttribute('uv1')
    const n = (geo.getAttribute('position') as THREE.BufferAttribute).count
    const col = new Float32Array(n * 3)
    const em = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      col[i * 3] = color.r
      col[i * 3 + 1] = color.g
      col[i * 3 + 2] = color.b
      em[i] = emis
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
    geo.setAttribute('aEmis', new THREE.BufferAttribute(em, 1))
    this.list.push(geo)
    return this
  }

  /** Convenience: shaped box at a pose. */
  box(
    color: THREE.Color, emis: number,
    w: number, h: number, d: number,
    x = 0, y = 0, z = 0,
    rx = 0, ry = 0, rz = 0,
    s?: BoxShape,
  ): this {
    return this.add(shapedBox(w, h, d, s), color, emis, place(x, y, z, rx, ry, rz))
  }

  /** Mirrored pair about X. */
  boxPair(
    color: THREE.Color, emis: number,
    w: number, h: number, d: number,
    x: number, y: number, z: number,
    rx = 0, ry = 0, rz = 0,
    s?: BoxShape,
  ): this {
    this.box(color, emis, w, h, d, x, y, z, rx, ry, rz, s)
    this.box(color, emis, w, h, d, -x, y, z, rx, -ry, -rz, s)
    return this
  }

  merge(): THREE.BufferGeometry {
    let g: THREE.BufferGeometry | null
    if (this.list.length === 1) {
      g = this.list[0]
    } else {
      g = mergeGeometries(this.list, false)
      for (const s of this.list) s.dispose()
    }
    this.list.length = 0
    if (!g) throw new Error('vehicles: geometry merge failed (mismatched attributes)')
    g.computeBoundingSphere()
    return g
  }
}

// ---------------------------------------------------------------------------
// Rig description produced by the chassis builders
// ---------------------------------------------------------------------------

interface Slot {
  x: number
  y: number
  z: number
  rx?: number
  ry?: number
  rz?: number
  /** Uniform scale of this instance. */
  s?: number
  /** Wheels: rolling radius, and whether it takes steering input. */
  radius?: number
  steer?: boolean
  /** Wings: +1 right, -1 left (left is placed by adding PI to rz, which keeps
   *  winding order intact so the shared FrontSide material still works). */
  mirror?: number
  /** Pods / cleats: animation phase offset. */
  phase?: number
}

/** Stadium-shaped tread loop the cleat instances travel around. */
interface TreadPath {
  halfLen: number
  radius: number
  y: number
  sideX: number
  perimeter: number
}

interface LodBuild {
  body: THREE.BufferGeometry
  wheels?: { geo: THREE.BufferGeometry; slots: Slot[] }
  cleats?: { geo: THREE.BufferGeometry; path: TreadPath; perSide: number }
  nozzles?: { geo: THREE.BufferGeometry; slots: Slot[]; gimbal: boolean }
  wings?: { geo: THREE.BufferGeometry; slots: Slot[] }
  pods?: { geo: THREE.BufferGeometry; slots: Slot[] }
  turret?: { geo: THREE.BufferGeometry; x: number; y: number; z: number }
  aux?: { geo: THREE.BufferGeometry; kind: 'canopy' | 'ribbon' }
  pilot?: { seat: Slot; radius: number; shell?: THREE.BufferGeometry; face?: THREE.BufferGeometry }
}

/** Per-detail tuning knobs shared by all builders. */
interface Det {
  d: 0 | 1 | 2 | 3
  /** Radial segments for wheels / nozzles / turret cylinders. */
  seg: number
  /** Pilot sphere segments. */
  ball: [number, number]
  /** Torus segments for the accessory ring. */
  ring: [number, number]
  /** Tread cleats per side. */
  cleats: number
}

const DETAIL: Det[] = [
  { d: 0, seg: 22, ball: [26, 17], ring: [7, 18], cleats: 16 },
  { d: 1, seg: 10, ball: [14, 9],  ring: [4, 10], cleats: 9 },
  { d: 2, seg: 7,  ball: [10, 6],  ring: [3, 6],  cleats: 5 },
  { d: 3, seg: 5,  ball: [6, 4],   ring: [3, 4],  cleats: 0 },
]

// ---------------------------------------------------------------------------
// Pilot: a ~0.8m sphere robot with one emissive face panel and an accessory
// ring. The panel carries every expression; the ring carries the identity.
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2

interface RingSpec { r: number; tube: number; arc: number; rx: number; rz: number; y: number }

const PILOT_RINGS: Record<string, RingSpec[]> = {
  // Rookie: eager, tilted halo worn like a cap.
  pip: [{ r: 0.30, tube: 0.042, arc: TAU, rx: 1.15, rz: 0.22, y: 0.24 }],
  // Overclocked: an equatorial band knocked off axis by the vibration.
  volt: [{ r: 0.44, tube: 0.036, arc: TAU, rx: 0.10, rz: 0.38, y: 0.02 }],
  // Navigation intelligence: a perfect, level halo.
  meridian: [{ r: 0.33, tube: 0.026, arc: TAU, rx: 0, rz: 0, y: 0.40 }],
  // Scavenger: a broken ring, welded on crooked.
  slag: [{ r: 0.41, tube: 0.055, arc: TAU * 0.62, rx: 0.30, rz: 0.55, y: 0.10 }],
  // Caretaker: a wide, thin, serene halo.
  halo9: [{ r: 0.54, tube: 0.020, arc: TAU, rx: 0, rz: 0, y: 0.46 }],
  // Derelict: two crossed containment rings.
  null: [
    { r: 0.44, tube: 0.028, arc: TAU, rx: 0, rz: 0.95, y: 0.04 },
    { r: 0.44, tube: 0.028, arc: TAU, rx: 0, rz: -0.95, y: 0.04 },
  ],
}

function pilotDef(pilotId: string): PilotDef {
  return PILOTS_BY_ID[pilotId] ?? PILOTS[0]
}

/** Adds the pilot's shell + ring geometry into `P`. Face is built separately.
 *  Every chassis seats this at its cockpit rim, so only the top half of the
 *  0.8m sphere is ever above the bodywork: against a 2.3m-wide car it has to
 *  read as a HEAD, not a torso. */
function addPilotShell(P: Parts, p: PilotDef, r: number, det: Det, ox = 0, oy = 0, oz = 0): void {
  const shell = new THREE.Color(p.shell)
  const accent = new THREE.Color(p.accent)
  P.add(sph(r, det.ball[0], det.ball[1]), shell, 0, place(ox, oy, oz))
  if (det.d <= 2) {
    // Mount peg: sells "this thing is bolted into a vehicle", not floating.
    P.add(cyl(r * 0.36, r * 0.44, r * 0.42, Math.max(5, det.seg >> 1)), accent, 0,
      place(ox, oy - r * 0.92, oz))
  }
  if (det.d <= 1) {
    for (const ring of PILOT_RINGS[p.id] ?? PILOT_RINGS.pip) {
      const g = new THREE.TorusGeometry(ring.r, ring.tube, det.ring[0], det.ring[1], ring.arc)
      // Torus is authored in the XY plane; lay it flat, then apply the tilt.
      g.applyMatrix4(place(0, 0, 0, Math.PI * 0.5, 0, 0))
      P.add(g, accent, 0.45, place(ox, oy + ring.y, oz, ring.rx, 0, ring.rz))
    }
    // Ear pods and a stub antenna: identity that survives being looked at from
    // directly behind, which is where the chase camera lives all race.
    P.boxPair(accent, 0.75, r * 0.17, r * 0.34, r * 0.30, ox + r * 0.90, oy + r * 0.30, oz)
    P.box(accent, 0.55, r * 0.09, r * 0.36, r * 0.46, ox, oy + r * 1.00, oz - r * 0.30, -0.30)
  }
}

/** The pilot's emissive panels. FRONT is the face proper; REAR is its repeater
 *  — same shader, same buffer, same draw call — tilted up 14 degrees so it
 *  aims straight at a chase camera sitting ~22 degrees above the deck. Without
 *  it the player stares at a blank dome for the entire race. */
function pilotFaceGeo(r: number, det: Det): THREE.BufferGeometry {
  const seg = det.d <= 1 ? 3 : 2
  // Both panels ride ABOVE the equator. The pilot is buried to its waist in a
  // cockpit, so a panel centred on the equator is a panel nobody ever sees.
  const front = spherePanel(r, r * 1.18, r * 0.84, seg)
  front.applyMatrix4(place(0, 0, 0, -0.30, 0, 0))
  const back = spherePanel(r, r * 1.12, r * 0.80, seg)
  back.applyMatrix4(place(0, 0, 0, -0.58, Math.PI, 0))
  const m = mergeGeometries([front, back], false)
  front.dispose()
  back.dispose()
  if (!m) throw new Error('vehicles: pilot face merge failed')
  return m
}

/** LOD3 face: four triangles of pure emissive, front and rear, so the pilot
 *  still reads from both ends of the field. */
function addPilotFaceFlat(P: Parts, p: PilotDef, r: number, ox: number, oy: number, oz: number): void {
  const face = new THREE.Color(p.face)
  P.add(new THREE.PlaneGeometry(r * 1.05, r * 0.72), face, 1, place(ox, oy, oz + r * 0.97))
  P.add(new THREE.PlaneGeometry(r * 0.94, r * 0.62), face, 1,
    place(ox, oy + r * 0.44, oz - r * 0.86, -0.55, Math.PI, 0))
}

// ---------------------------------------------------------------------------
// Shared sub-assemblies
// ---------------------------------------------------------------------------

function wheelGeo(
  radius: number, width: number, det: Det,
  tyre: THREE.Color, rim: THREE.Color, glow: THREE.Color,
): THREE.BufferGeometry {
  const P = new Parts()
  const seg = det.seg
  P.add(cyl(radius, radius, width, seg), tyre, 0, place(0, 0, 0, 0, 0, Math.PI * 0.5))
  P.add(cyl(radius * 0.56, radius * 0.56, width * 1.06, Math.max(5, seg - 4)), rim, 0,
    place(0, 0, 0, 0, 0, Math.PI * 0.5))
  if (det.d <= 1) {
    // Crossed hub spokes read as rotation even at speed.
    P.box(glow, 1, width * 1.1, radius * 1.5, radius * 0.13, 0, 0, 0)
    P.box(glow, 1, width * 1.1, radius * 0.13, radius * 1.5, 0, 0, 0)
  }
  return P.merge()
}

/**
 * The thruster FLAME only, mouth at z = 0 and plume running to -Z, so the
 * instance Z-scale stretches fire without distorting hardware.
 *
 * The nozzle CAN is static body geometry (addExhaustCan) instead. That split
 * matters: previously the whole assembly was instanced and stretched, so at
 * rest every vehicle wore a set of fat pale cones that read as traffic cones
 * bolted to the tail. Now the tail carries real machined hardware and the fire
 * is a small ember that grows into a jet on boost.
 */
function nozzleGeo(r: number, det: Det, glow: THREE.Color, plumeLen = 0.30): THREE.BufferGeometry {
  const P = new Parts()
  const seg = Math.max(6, det.seg - 6)
  // Hot core disc sitting in the mouth: the exhaust reads as lit even at idle.
  P.add(cyl(r * 0.62, r * 0.62, 0.02, seg), glow, 1, place(0, 0, -0.02, Math.PI * 0.5, 0, 0))
  if (det.d <= 2) {
    // Deliberately stubby. Instance Z-scale runs this out to a jet on boost;
    // at rest it has to stay an ember, or every vehicle wears traffic cones.
    P.add(cyl(r * 0.56, r * 0.20, plumeLen, seg, true), glow, 1,
      place(0, 0, -0.03 - plumeLen * 0.5, Math.PI * 0.5, 0, 0))
  }
  return P.merge()
}

/**
 * Physical exhaust hardware welded into a body buffer: a flared shroud, a dark
 * throat and a lit rim, mouth at z pointing aft. Costs no extra draw call and
 * gives the most-viewed surface in the game something machined to look at.
 */
function addExhaustCan(
  P: Parts, det: Det, shell: THREE.Color, dark: THREE.Color, glow: THREE.Color,
  r: number, x: number, y: number, z: number, len = 0.34,
): void {
  const seg = Math.max(6, det.seg - 4)
  P.add(cyl(r * 1.16, r * 0.92, len, seg, true), shell, 0,
    place(x, y, z + len * 0.5, Math.PI * 0.5, 0, 0))
  P.add(cyl(r * 0.84, r * 0.70, len * 0.86, seg, true), dark, 0,
    place(x, y, z + len * 0.55, Math.PI * 0.5, 0, 0))
  if (det.d <= 1) {
    P.add(new THREE.TorusGeometry(r * 1.03, r * 0.09, 3, Math.max(6, det.ring[1])), glow, 0.6,
      place(x, y, z))
  }
}

function treadPath(halfLen: number, radius: number, y: number, sideX: number): TreadPath {
  return { halfLen, radius, y, sideX, perimeter: 4 * halfLen + Math.PI * 2 * radius }
}

/** Maps u in [0,1) onto the stadium loop. Writes into `out` and returns the
 *  cleat's rotation about X. Allocation-free. */
function treadPoint(path: TreadPath, u: number, out: THREE.Vector3): number {
  const L = path.halfLen
  const R = path.radius
  const straight = 2 * L
  const arc = Math.PI * R
  let s = (u - Math.floor(u)) * path.perimeter
  if (s < straight) {                       // top run, tail -> nose
    out.set(0, R, -L + s)
    return 0
  }
  s -= straight
  if (s < arc) {                            // nose sprocket
    const t = s / R
    out.set(0, R * Math.cos(t), L + R * Math.sin(t))
    return t
  }
  s -= arc
  if (s < straight) {                       // bottom run, nose -> tail
    out.set(0, -R, L - s)
    return Math.PI
  }
  s -= straight
  const t = Math.PI + s / R                 // tail sprocket
  out.set(0, R * Math.cos(t), -L + R * Math.sin(t))
  return t
}

// ---------------------------------------------------------------------------
// Chassis builders
// ---------------------------------------------------------------------------

interface Pal {
  prim: THREE.Color
  sec: THREE.Color
  emis: THREE.Color
  dark: THREE.Color
  light: THREE.Color
}

function palette(def: ChassisDef): Pal {
  const prim = new THREE.Color(def.colorPrimary)
  const sec = new THREE.Color(def.colorSecondary)
  return {
    prim,
    sec,
    emis: new THREE.Color(def.colorEmissive),
    dark: sec.clone().multiplyScalar(0.55),
    light: prim.clone().lerp(new THREE.Color(0xffffff), 0.32),
  }
}

type Builder = (def: ChassisDef, p: PilotDef, det: Det) => LodBuild

/** LOD3 stand-in wheels: a box per contact patch, merged into the body. */
function bakeWheelBoxes(P: Parts, c: THREE.Color, slots: Slot[], r: number, w: number): void {
  for (const s of slots) {
    const k = s.s ?? 1
    P.box(c, 0, w * k, r * 2 * k, r * 1.9 * k, s.x, s.y, s.z)
  }
}

// --- 1. Solaire GT -- grounded sports coupe --------------------------------
// Authored REAR FIRST. The chase camera sits 9m back and 3.6m up, looking down
// on the deck at roughly 22 degrees, and that is the only angle most players
// ever see. Reading down the frame from there:
//    pilot dome, sunk to its equator between two raised shoulders
//    a dark swan-neck wing floating clear of the bodywork on lit endplates
//    two red haunches flanking a glowing engine bay
//    a full-width tail-light bar over twin machined exhaust cans
//    a finned diffuser
//    four exposed wheels, the rears wider and standing outboard of the body
// From the side: splitter, low pointed nose, long bonnet, raked screen,
// cab-rearward cockpit, short high-hipped deck.
//
// The rule that keeps it from reading as furniture: no primary-coloured
// horizontal plate is ever the highest thing on the car. Every wide surface is
// either dark, broken by a glow line, or has something taller beside it.

const SOLAIRE_WHEELS: Slot[] = [
  { x: 1.00, y: -0.136, z: 1.56, radius: 0.414, steer: true, s: 0.90 },
  { x: -1.00, y: -0.136, z: 1.56, radius: 0.414, steer: true, s: 0.90 },
  { x: 1.10, y: -0.090, z: -1.42, radius: 0.460 },
  { x: -1.10, y: -0.090, z: -1.42, radius: 0.460 },
]

const SOLAIRE_NOZZLES: Slot[] = [
  { x: 0.32, y: -0.16, z: -2.30 },
  { x: -0.32, y: -0.16, z: -2.30 },
]

const buildSolaire: Builder = (def, p, det) => {
  const c = palette(def)
  const P = new Parts()
  const seat: Slot = { x: 0, y: 0.58, z: -0.30 }

  if (det.d === 3) {
    // 40px stand-in: wedge, shoulders, haunches, floating wing, light bar.
    P.box(c.sec, 0, 1.80, 0.22, 4.30, 0, -0.42, 0.02, 0, 0, 0, { frontX: 0.62 })
    P.box(c.prim, 0, 1.90, 0.46, 4.00, 0, -0.18, 0.12, 0, 0, 0,
      { frontX: 0.50, frontY: 0.45, backX: 0.92 })
    P.box(c.prim, 0, 1.54, 0.24, 1.70, 0, 0.10, 1.16, 0, 0, 0, { frontX: 0.64, frontY: 0.50 })
    P.boxPair(c.prim, 0, 0.52, 0.52, 1.66, 0.82, 0.16, -1.34, 0, 0, 0, { topX: 0.88 })
    P.boxPair(c.prim, 0, 0.40, 0.56, 1.42, 0.68, 0.34, -0.24, 0, 0, 0, { topX: 0.86 })
    P.box(c.sec, 0, 1.24, 0.34, 1.34, 0, 0.28, -1.42)
    P.box(c.emis, 1, 1.00, 0.07, 0.92, 0, 0.47, -1.40)
    P.box(c.sec, 0, 1.76, 0.60, 0.20, 0, 0.02, -2.16)
    P.box(c.emis, 1, 1.58, 0.12, 0.09, 0, 0.30, -2.27)
    P.box(c.sec, 0, 1.86, 0.09, 0.42, 0, 1.00, -2.06)
    P.boxPair(c.prim, 0, 0.09, 0.46, 0.62, 0.93, 0.92, -2.06)
    bakeWheelBoxes(P, c.dark, SOLAIRE_WHEELS, 0.46, 0.40)
    addPilotShell(P, p, 0.40, det, seat.x, seat.y, seat.z)
    addPilotFaceFlat(P, p, 0.40, seat.x, seat.y, seat.z)
    return { body: P.merge() }
  }

  // ---- floor pan, skirts, underglow ---------------------------------------
  P.box(c.sec, 0, 1.82, 0.18, 4.34, 0, -0.44, 0.02, 0, 0, 0, { frontX: 0.60, backX: 0.94 })
  P.boxPair(c.sec, 0, 0.13, 0.30, 1.90, 0.80, -0.36, 0.06)
  P.boxPair(c.emis, 1, 0.08, 0.05, 1.72, 0.80, -0.50, 0.06)

  // ---- lower hull ---------------------------------------------------------
  P.box(c.prim, 0, 1.92, 0.46, 4.08, 0, -0.20, 0.10, 0, 0, 0,
    { frontX: 0.54, frontY: 0.50, backX: 0.92, topX: 0.96 })

  // ---- nose: pointed and low, splitter under it ---------------------------
  P.box(c.prim, 0, 1.34, 0.32, 1.52, 0, -0.13, 1.62, 0, 0, 0,
    { frontX: 0.44, frontY: 0.36, shear: -0.09 })
  P.box(c.sec, 0, 1.50, 0.07, 0.56, 0, -0.43, 2.12, 0, 0, 0, { frontX: 0.78 })
  P.box(c.dark, 0, 0.92, 0.15, 0.26, 0, -0.26, 2.18)
  P.boxPair(c.emis, 1, 0.30, 0.10, 0.12, 0.46, -0.06, 2.22)

  // ---- bonnet + front fenders ---------------------------------------------
  P.box(c.prim, 0, 1.64, 0.26, 1.90, 0, 0.02, 1.08, 0, 0, 0,
    { frontX: 0.58, frontY: 0.42, topX: 0.92 })
  P.boxPair(c.prim, 0, 0.50, 0.46, 1.36, 0.86, -0.02, 1.54, 0, 0, 0,
    { frontY: 0.70, backY: 0.78, topX: 0.82 })
  P.boxPair(c.dark, 0, 0.46, 0.08, 1.10, 0.86, 0.22, 1.56)

  // ---- raked screen, then the shoulders the cockpit sits down between -----
  P.box(c.dark, 0, 1.18, 0.46, 0.12, 0, 0.30, 0.52, -0.62)
  P.boxPair(c.prim, 0, 0.40, 0.56, 1.46, 0.68, 0.34, -0.24, 0, 0, 0,
    { frontY: 0.66, backY: 0.94, topX: 0.84 })
  P.boxPair(c.emis, 1, 0.07, 0.06, 1.10, 0.87, 0.46, -0.24)

  // ---- cockpit tub: the 0.8m pilot drops in to its equator ----------------
  P.box(c.sec, 0, 1.16, 0.46, 1.26, seat.x, 0.35, seat.z, 0, 0, 0, { topX: 0.92 })
  P.box(c.dark, 0, 0.96, 0.10, 1.02, seat.x, 0.56, seat.z)
  P.add(new THREE.TorusGeometry(0.52, 0.055, det.ring[0], det.ring[1] + 2), c.sec, 0.25,
    place(seat.x, 0.58, seat.z, Math.PI * 0.5, 0, 0))
  // Twin roll fins frame the head without covering its rear panel.
  P.boxPair(c.sec, 0, 0.15, 0.46, 0.34, 0.40, 0.44, -0.90)
  P.boxPair(c.emis, 1, 0.06, 0.30, 0.09, 0.48, 0.48, -0.90)

  // ---- engine bay: the bright thing the chase camera looks down into ------
  P.box(c.sec, 0, 1.02, 0.30, 1.50, 0, 0.20, -1.42, 0, 0, 0, { backY: 0.86 })
  for (let i = 0; i < 2; i++) P.box(c.emis, 0.6, 0.54, 0.05, 0.15, 0, 0.36, -1.14 - i * 0.44)
  P.boxPair(c.emis, 0.5, 0.06, 0.05, 1.10, 0.48, 0.35, -1.42)

  // ---- rear hips: the classic sports-car rear is two crowns and a valley --
  P.boxPair(c.prim, 0, 0.62, 0.74, 1.82, 0.76, 0.24, -1.30, 0, 0, 0,
    { frontY: 0.64, backY: 0.82, topX: 0.72 })
  P.boxPair(c.sec, 0, 0.46, 0.08, 1.34, 0.78, 0.58, -1.36)
  P.boxPair(c.emis, 0.7, 0.06, 0.05, 1.06, 0.98, 0.48, -1.36)
  P.boxPair(c.sec, 0, 0.30, 0.30, 0.16, 0.86, 0.34, -0.44)

  // ---- rear face: the most-viewed surface in the game ---------------------
  P.box(c.sec, 0, 1.74, 0.58, 0.22, 0, -0.02, -2.14, 0, 0, 0, { topX: 0.92 })
  P.box(c.emis, 0.85, 1.02, 0.06, 0.08, 0, 0.22, -2.27)
  P.boxPair(c.emis, 1, 0.16, 0.34, 0.10, 0.70, 0.00, -2.28)
  P.box(c.dark, 0, 0.94, 0.34, 0.10, 0, -0.02, -2.28)
  for (const sx of [1, -1]) {
    addExhaustCan(P, det, c.sec, c.dark, c.emis, 0.145, sx * 0.32, -0.16, -2.26, 0.30)
  }
  P.box(c.dark, 0, 1.50, 0.12, 0.52, 0, -0.41, -2.06, 0.26)
  for (const fx of [-0.76, -0.54, 0, 0.54, 0.76]) {
    P.box(c.dark, 0, 0.07, 0.20, 0.50, fx, -0.36, -2.06)
  }

  // ---- swan-neck wing: thin dark blade, raked endplates, daylight under ---
  P.boxPair(c.sec, 0, 0.09, 0.58, 0.22, 0.46, 0.84, -1.88)
  P.box(c.sec, 0, 1.62, 0.07, 0.34, 0, 1.14, -2.04, -0.19)
  P.box(c.emis, 0.8, 1.26, 0.04, 0.08, 0, 1.10, -2.16)
  P.boxPair(c.prim, 0, 0.08, 0.44, 0.56, 0.81, 1.06, -2.04, 0, 0, 0,
    { frontY: 1.0, backY: 0.50 })
  P.boxPair(c.emis, 1, 0.10, 0.05, 0.28, 0.81, 1.25, -1.92)

  if (det.d === 0) {
    // Brake ducts, mirror stalks, nose canards, bonnet louvres, side pipes.
    P.boxPair(c.dark, 0, 0.12, 0.28, 0.22, 0.86, -0.12, 1.28)
    P.boxPair(c.dark, 0, 0.12, 0.28, 0.22, 0.86, -0.10, -1.10)
    P.boxPair(c.sec, 0, 0.28, 0.05, 0.06, 0.90, 0.30, 0.86)
    P.boxPair(c.sec, 0, 0.08, 0.15, 0.13, 1.06, 0.32, 0.86)
    P.boxPair(c.prim, 0, 0.44, 0.05, 0.32, 0.84, -0.20, 1.94, 0, 0, 0.16, { frontX: 0.50 })
    for (let i = 0; i < 3; i++) P.box(c.dark, 0, 0.62, 0.05, 0.09, 0, 0.17, 1.44 + i * 0.22)
    P.boxPair(c.dark, 0, 0.09, 0.09, 1.90, 0.30, 0.11, -0.20)
    P.boxPair(c.sec, 0, 0.30, 0.10, 0.42, 0.62, -0.30, -1.94)
  }

  if (det.d === 2) addPilotShell(P, p, 0.40, det, seat.x, seat.y, seat.z)

  return {
    body: P.merge(),
    wheels: { geo: wheelGeo(0.46, 0.40, det, c.dark, c.light, c.emis), slots: SOLAIRE_WHEELS },
    nozzles: {
      geo: nozzleGeo(0.145, det, c.emis, 0.30), slots: SOLAIRE_NOZZLES, gimbal: false,
    },
    pilot: {
      seat, radius: 0.40,
      ...(det.d <= 1 ? { shell: pilotShellGeo(p, 0.40, det) } : {}),
      face: pilotFaceGeo(0.40, det),
    },
  }
}

// --- 2. Filament -- hover interceptor --------------------------------------
// Read: a flat blade hull with the pilot sunk into its spine between raised
// shoulders, a FAN OF OVERLAPPING SWEPT PLATES standing off the back with lit
// wedges burning between the layers, and a cluster of four cans on stand-off
// mounts. Short and wide now, not a needle: at 4.1m it was the longest thing
// in the roster and read as a receding stick from the chase camera, which is
// the one angle that matters.
//
// The fan is the silhouette. Each plate is wider, higher and swept further
// back than the one in front of it, and each has an emissive sliver tucked
// under its leading edge -- so from astern the back of the car is a stack of
// bright slots rather than one flat transom. It is also what the chassis is
// recognised by at 40px, which is why it is the widest and tallest group on
// the vehicle.

/**
 * HALF AGAIN AS BIG, AND THE PILOT IS NOT.
 *
 * Every structural number below is authored at the old scale and multiplied by
 * this on the way out. The pilot ball is NOT: it stays at the roster's 0.40,
 * because it is a character and the same pilot has to be the same size in
 * whichever chassis it is sitting in.
 *
 * That combination is the point rather than a compromise. The roster's own art
 * rule is "a 0.8m sphere against a 2.3m-wide car"; the Filament was 1.36m wide
 * and wore the ball like a bobble-head. At 1.5x it is 2.04m across and the
 * pilot finally sits IN it at the proportion every other chassis has.
 */
const FILAMENT_SCALE = 1.5

/** [span, y, z, roll, chord] per plate, innermost first. Roll is the dihedral
 *  that opens the fan; the forward sweep and the tip taper live in FAN_SHAPE,
 *  because they have to be baked into the span rather than applied as a
 *  rotation -- see the placement loop. */
const FILAMENT_FAN: readonly (readonly [number, number, number, number, number])[] = [
  [0.74, 0.10, -0.60, -0.04, 1.06],
  [0.88, 0.03, -0.70, -0.13, 0.96],
  [1.00, -0.04, -0.80, -0.24, 0.86],
  [1.06, -0.11, -0.90, -0.35, 0.74],
  [1.04, -0.18, -1.00, -0.47, 0.62],
]

/** Every plate is a feather: full chord and thickness at the root, half the
 *  chord and thickness at the tip, and the tip thrown FORWARD and DOWN.
 *
 *  Anhedral and forward sweep, not dihedral and aft sweep. The fan drapes
 *  around the flanks like a folded wing rather than trailing off the tail, so
 *  the widest, lowest part of the silhouette sits beside the cockpit instead
 *  of behind the engines -- which also stops the group from hiding inside its
 *  own exhaust plumes on boost.
 *
 *  The sweep is spanSweep and NOT a rotation about Y, and that is the whole
 *  reason this group works. Sweeping by rotation means the left plate needs
 *  the opposite rotation, which boxPair supplies -- but boxPair cannot mirror
 *  the SPAN SHAPING, because that is baked into the vertices along +X. So the
 *  first version had five wide rectangles with a taper running the wrong way
 *  across them, and the fan read as a cargo rack. Baking the sweep into the
 *  span means the left plate is the same buffer rolled through PI, which
 *  mirrors the plan view without touching the winding -- the same trick
 *  Vector-7's wings use. */
const FILAMENT_FAN_SHAPE: BoxShape = { spanZ: [1, 0.46], spanY: [1, 0.6] }

/** Repulsors, moved inboard and forward with the shorter hull. */
const FILAMENT_PODS_UNIT: readonly (readonly [number, number, number])[] = [
  [0, -0.30, 0.74],
  [0, -0.26, -0.74],
]
const FILAMENT_PODS: Slot[] = FILAMENT_PODS_UNIT.map(([x, y, z]) => ({
  x: x * FILAMENT_SCALE, y: y * FILAMENT_SCALE, z: z * FILAMENT_SCALE,
}))

/** Four cans: an inboard pair standing off the spine on pylons, an outboard
 *  pair slung low at the hull corners. Mouths point aft. */
const FILAMENT_CANS: readonly (readonly [number, number, number, number])[] = [
  // [x, y, z, radius]
  [0.26, 0.46, -1.20, 0.145],
  [-0.26, 0.46, -1.20, 0.145],
  [0.50, 0.00, -1.30, 0.115],
  [-0.50, 0.00, -1.30, 0.115],
].map((v) => v.map((n) => n * FILAMENT_SCALE) as [number, number, number, number])

const buildFilament: Builder = (def, p, det) => {
  const c = palette(def)
  const P = new Parts()
  const S = FILAMENT_SCALE
  const seat: Slot = { x: 0, y: 0.30 * S, z: -0.16 * S }

  /**
   * Scaled box and scaled mirrored pair. Dimensions AND position both take the
   * factor, and so do the two BoxShape fields that carry a length rather than
   * a ratio: `shear` is an absolute Y offset and `spanSweep` an absolute Z one,
   * so leaving them alone would flatten the rake and straighten the fan the
   * moment the scale moved. The taper ratios (frontX, spanZ, topX...) are
   * proportions and must NOT be touched.
   */
  const sc = (h?: BoxShape): BoxShape | undefined => h && {
    ...h,
    ...(h.shear === undefined ? {} : { shear: h.shear * S }),
    ...(h.spanSweep === undefined ? {} : { spanSweep: h.spanSweep * S }),
  }
  const sb = (col: THREE.Color, e: number, w: number, hh: number, d: number,
              x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, h?: BoxShape): void => {
    P.box(col, e, w * S, hh * S, d * S, x * S, y * S, z * S, rx, ry, rz, sc(h))
  }
  const sp = (col: THREE.Color, e: number, w: number, hh: number, d: number,
              x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, h?: BoxShape): void => {
    P.boxPair(col, e, w * S, hh * S, d * S, x * S, y * S, z * S, rx, ry, rz, sc(h))
  }

  if (det.d === 3) {
    // One merged silhouette: keel, deck, nose, the outermost fan plate (the
    // only one that survives at this size) and the can cluster as one box.
    sb(c.sec, 0, 1.22, 0.26, 3.20, 0, -0.06, 0.26, 0, 0, 0,
      { frontX: 0.08, frontY: 0.32, backX: 0.74 })
    sb(c.prim, 0, 1.06, 0.20, 2.30, 0, 0.12, -0.02, 0, 0, 0, { frontX: 0.18, frontY: 0.46 })
    sb(c.emis, 1, 0.12, 0.06, 2.20, 0, 0.16, 0.42)
    for (const r of [-0.34, Math.PI + 0.34]) {
      sb(c.prim, 0, 0.90, 0.07, 0.78, Math.cos(r) * 0.45, Math.sin(r) * 0.45, -0.82,
        0, 0, r, { spanZ: [1, 0.42], spanSweep: 0.40 })
    }
    sb(c.sec, 0, 1.10, 0.46, 0.46, 0, 0.24, -1.06)
    sb(c.emis, 1, 0.96, 0.09, 0.08, 0, 0.30, -1.26)
    for (const s of FILAMENT_PODS) {
      P.add(cyl(0.28 * S, 0.38 * S, 0.24 * S, 5), c.emis, 0.8, place(s.x, s.y, s.z))
    }
    addPilotShell(P, p, 0.40, det, seat.x, seat.y, seat.z)
    addPilotFaceFlat(P, p, 0.40, seat.x, seat.y, seat.z)
    return { body: P.merge() }
  }

  // ---- the keel: one flat blade, nose DOWN and tail UP ---------------------
  // The rake is the whole profile. A flat hull with a level dorsal line reads
  // as a plank; raking it so the nose drops and the tail rises puts the mass
  // under the engine stack and leaves the front half a thin edge, which is
  // what makes the thing look like it is leaning into the corner even parked.
  //
  // frontX 0.11 rather than 0 on purpose. A box tapered to a true zero-width
  // edge has degenerate triangles along the whole nose seam, and they shade as
  // a black crease from the shallow chase angle.
  sb(c.sec, 0, 1.34, 0.26, 3.72, 0, -0.11, 0.30, 0, 0, 0,
    { frontX: 0.11, frontY: 0.10, backX: 0.86, shear: -0.16 })

  // ---- dorsal deck: the surface the cockpit is sunk into -------------------
  sb(c.prim, 0, 1.20, 0.26, 2.64, 0, 0.02, -0.22, 0, 0, 0,
    { frontX: 0.10, frontY: 0.22, backX: 0.90, topX: 0.90, shear: -0.10 })
  // Chine strakes: the hard edge where deck meets keel, which is what makes a
  // flat hull read as a blade rather than a slab.
  sp(c.dark, 0, 0.13, 0.06, 2.30, 0.60, -0.12, -0.18, 0, 0, 0,
    { frontX: 0.24, backX: 0.92, shear: -0.09 })

  // ---- nose ---------------------------------------------------------------
  // THE KEEL IS THE NOSE. There used to be a separate nose plank slung under
  // the keel, and between it, the keel and the deck the profile carried three
  // parallel horizontal strata -- which is what made the car read as a stack
  // of slabs instead of one blade. What is left here is skin ON the keel, not
  // another layer beside it.
  sb(c.prim, 0, 0.96, 0.09, 2.30, 0, -0.19, 0.96, 0, 0, 0,
    { frontX: 0.12, frontY: 0.30, backX: 0.96, shear: -0.10 })
  sb(c.emis, 1, 0.09, 0.04, 2.70, 0, -0.09, 0.56, 0, 0, 0, { frontX: 0.26, shear: -0.10 })
  sp(c.sec, 0, 0.12, 0.05, 1.20, 0.34, -0.20, 0.82, 0, -0.09, 0, { frontX: 0.22 })

  // ---- cockpit: a tub sunk BETWEEN raised shoulders ------------------------
  // The tub, the shoulders and the coaming all scale with the hull; the COLLAR
  // RING does not. It hugs the ball at its equator, and a ring scaled off a
  // pilot that did not scale is a hoop floating around a head.
  sb(c.dark, 0, 0.60, 0.26, 0.82, 0, 0.14, -0.16)
  P.add(new THREE.TorusGeometry(0.43, 0.05 * S, det.ring[0], det.ring[1] + 3), c.prim, 0.35,
    place(seat.x, 0.31 * S, seat.z, Math.PI * 0.5, 0, 0))
  sp(c.prim, 0, 0.30, 0.36, 1.16, 0.56, 0.16, 0.10, 0, 0, -0.20,
    { frontY: 0.42, backY: 0.96, topX: 0.66, shear: -0.06 })
  sp(c.emis, 1, 0.05, 0.14, 0.80, 0.70, 0.24, 0.06, 0, 0, -0.20)
  // Coaming ahead of the head, low enough to leave the face plate clear.
  sb(c.sec, 0, 0.58, 0.13, 0.28, 0, 0.22, 0.40, -0.34, 0, 0, { frontY: 0.45 })

  // ---- THE FAN ------------------------------------------------------------
  // Each plate is placed twice: once at its own roll, once at PI minus it.
  // shapedBox centres a plate on its span, so the centre is pushed out along
  // the rolled span axis to land the root on the hull.
  const plate = (col: THREE.Color, emis: number, span: number, thick: number,
                 y: number, z: number, rz: number, chord: number, sweep: number): void => {
    const half = span * 0.5
    for (const r of [rz, Math.PI - rz]) {
      sb(col, emis, span, thick, chord,
        Math.cos(r) * half, y + Math.sin(r) * half, z, 0, 0, r,
        { ...FILAMENT_FAN_SHAPE, spanSweep: sweep })
    }
  }

  // FIVE PLATES, SHALLOW. An interleaved second row at steeper angle was
  // tried and cut: with ten plates radiating the group stopped being a stack
  // and became a starburst -- a porcupine from astern, which is a different
  // animal from the one the reference is. The read comes from plates lying
  // ALMOST FLAT and overlapping, so the anhedral only has to open far enough
  // that each one clears the one above it. 2 to 27 degrees does that.
  for (const [span, y, z, rz, chord] of FILAMENT_FAN) {
    plate(c.prim, 0, span, 0.06, y, z, rz, chord, 0.46 * (chord / 1.06))
  }
  // The glow burning between the layers, tucked under each plate's root, where
  // the plate above it casts the shadow that makes it read as a slot.
  for (const [span, y, z, rz, chord] of FILAMENT_FAN) {
    plate(c.emis, 1, span * 0.62, 0.03, y + 0.05, z - chord * 0.16, rz, chord * 0.30, 0.14)
  }

  // Centre spine, and a lit blade down its ridge.
  // STARTS BEHIND THE HEAD, NOT BESIDE IT. The chase camera sits about 22
  // degrees above the deck directly astern, and the pilot's rear face panel --
  // the one carrying the expression system from the angle the game is actually
  // played at -- sights back along that line. Anything standing in the cone
  // from the head to the camera deletes it.
  sb(c.sec, 0, 0.24, 0.56, 0.92, 0, 0.20, -0.90, 0, 0, 0, { frontY: 0.22, backY: 0.94 })
  sb(c.emis, 1, 0.07, 0.32, 0.10, 0, 0.46, -1.28)

  // ---- can cluster --------------------------------------------------------
  // Pylons before cans, so the cans read as bolted to something.
  sp(c.sec, 0, 0.14, 0.30, 0.28, 0.26, 0.30, -1.12)
  sp(c.dark, 0, 0.17, 0.14, 0.24, 0.50, 0.00, -1.14)
  for (const [x, y, z, r] of FILAMENT_CANS) {
    addExhaustCan(P, det, c.sec, c.dark, c.emis, r, x, y, z, 0.40 * S)
  }

  // ---- pod pylons ---------------------------------------------------------
  for (const s of FILAMENT_PODS) {
    P.box(c.sec, 0, 0.18 * S, 0.28 * S, 0.26 * S, s.x, s.y + 0.24 * S, s.z)
  }

  if (det.d === 0) {
    // Panel breakup on the deck, vents in the chines, tail lamps.
    for (let i = 0; i < 3; i++) sb(c.dark, 0, 0.42, 0.04, 0.09, 0, -i * 0.04, 0.92 + i * 0.30)
    sp(c.dark, 0, 0.07, 0.14, 0.34, 0.52, -0.16, 0.56, 0, -0.12, 0)
    sp(c.sec, 0, 0.09, 0.14, 0.30, 0.44, -0.08, -0.44)
    sp(c.emis, 1, 0.06, 0.05, 0.20, 0.20, -0.08, -1.44)
    sp(c.dark, 0, 0.08, 0.07, 0.14, 0.38, 0.26, -0.18)
  }

  if (det.d === 2) addPilotShell(P, p, 0.40, det, seat.x, seat.y, seat.z)

  // Repulsor pods stand in for wheels: they spin and pulse instead of rolling.
  const pod = new Parts()
  pod.add(cyl(0.28 * S, 0.38 * S, 0.24 * S, det.seg), c.sec, 0, place(0, 0, 0))
  pod.add(cyl(0.32 * S, 0.32 * S, 0.07 * S, det.seg), c.emis, 1, place(0, -0.15 * S, 0))
  if (det.d <= 1) pod.box(c.emis, 1, 0.64 * S, 0.05 * S, 0.08 * S, 0, 0.02 * S, 0)

  const out: LodBuild = {
    body: P.merge(),
    wheels: { geo: pod.merge(), slots: FILAMENT_PODS },
    nozzles: {
      geo: nozzleGeo(0.16 * S, det, c.emis, 0.34 * S),
      slots: FILAMENT_CANS.map(([x, y, z]) => ({ x, y, z: z - 0.02 * S })),
      gimbal: false,
    },
    pilot: {
      seat, radius: 0.40,
      ...(det.d <= 1 ? { shell: pilotShellGeo(p, 0.40, det) } : {}),
      face: pilotFaceGeo(0.40, det),
    },
  }
  if (det.d <= 1) out.aux = { geo: ribbonGeo(), kind: 'ribbon' }
  return out
}

/** Twin trailing light ribbons. Keeps its UVs: the glow shader fades on uv.y. */
function ribbonGeo(): THREE.BufferGeometry {
  const list: THREE.BufferGeometry[] = []
  for (const sx of [1, -1]) {
    const g: THREE.BufferGeometry = new THREE.PlaneGeometry(0.22 * FILAMENT_SCALE, 2.40 * FILAMENT_SCALE, 1, 6)
    // +Y (uv.y = 1) becomes +Z so the bright end sits at the emitter.
    const S = FILAMENT_SCALE
    g.applyMatrix4(place(sx * 0.44 * S, 0.22 * S, -1.86 * S, Math.PI * 0.5 + 0.13, sx * -0.10, 0))
    list.push(g)
  }
  const m = mergeGeometries(list, false)
  for (const g of list) g.dispose()
  if (!m) throw new Error('vehicles: ribbon merge failed')
  return m
}

/** Standalone pilot shell buffer (sphere + mount + accessory ring). */
function pilotShellGeo(p: PilotDef, r: number, det: Det): THREE.BufferGeometry {
  const P = new Parts()
  addPilotShell(P, p, r, det, 0, 0, 0)
  return P.merge()
}

// --- 3. Bulwark MK-IV -- grounded assault tank -----------------------------
// Read: two slab treads, heavy angled shoulders, and a stubby turret looking
// BACKWARD down the road you just came from. The rear is a proper engine deck:
// louvred grille, twin stack cans, corner lamp clusters, tow hooks.

const BULWARK_TREAD = treadPath(1.52, 0.46, -0.13, 1.16)

const buildBulwark: Builder = (def, p, det) => {
  const c = palette(def)
  const P = new Parts()
  // Dropped into the hatch so only the top of the dome clears the shoulders.
  const seat: Slot = { x: 0, y: 0.98, z: 0.86 }

  if (det.d === 3) {
    P.boxPair(c.dark, 0, 0.64, 0.86, 3.90, 1.16, -0.13, 0, 0, 0, 0, { frontX: 0.85, backX: 0.85 })
    P.box(c.prim, 0, 2.46, 0.74, 4.10, 0, 0.44, 0.05, 0, 0, 0, { frontX: 0.76, frontY: 0.68, topX: 0.86 })
    P.boxPair(c.prim, 0, 0.90, 0.80, 1.85, 1.02, 0.66, 0.80, 0, 0, 0, { frontX: 0.6, frontY: 0.52 })
    P.box(c.sec, 0, 2.30, 0.50, 1.05, 0, 0.34, 2.10, -0.40)
    P.box(c.prim, 0, 1.10, 0.55, 1.05, 0, 1.00, -0.70)
    P.box(c.sec, 0, 0.28, 0.26, 1.45, 0, 1.02, -1.90)
    P.box(c.sec, 0, 2.24, 0.78, 0.22, 0, 0.42, -2.16)
    P.box(c.emis, 1, 1.70, 0.16, 0.10, 0, 0.62, -2.28)
    P.boxPair(c.emis, 1, 0.30, 0.26, 0.11, 0.86, 0.24, -2.28)
    addPilotShell(P, p, 0.40, det, seat.x, seat.y, seat.z)
    addPilotFaceFlat(P, p, 0.40, seat.x, seat.y, seat.z)
    return { body: P.merge() }
  }

  // ---- tread slabs, sprockets, road wheels --------------------------------
  P.boxPair(c.dark, 0, 0.64, 0.86, 3.05, 1.16, -0.13, 0)
  for (const sx of [1, -1]) {
    for (const sz of [1, -1]) {
      P.add(cyl(0.44, 0.44, 0.66, det.seg), c.dark, 0,
        place(sx * 1.16, -0.13, sz * 1.52, 0, 0, Math.PI * 0.5))
    }
    if (det.d <= 1) {
      for (let i = -1; i <= 1; i++) {
        P.add(cyl(0.27, 0.27, 0.68, Math.max(5, det.seg - 4)), c.sec, 0,
          place(sx * 1.16, -0.20, i * 0.95, 0, 0, Math.PI * 0.5))
      }
    }
  }
  P.boxPair(c.sec, 0, 0.14, 0.46, 3.70, 1.52, 0.18, 0)

  // ---- hull + heavy shoulders ---------------------------------------------
  P.box(c.prim, 0, 2.46, 0.74, 4.10, 0, 0.44, 0.05, 0, 0, 0,
    { frontX: 0.76, frontY: 0.68, topX: 0.86 })
  P.boxPair(c.prim, 0, 0.90, 0.84, 1.85, 1.02, 0.66, 0.80, 0, 0, 0,
    { frontX: 0.60, frontY: 0.52, topX: 0.72 })
  P.boxPair(c.emis, 1, 0.10, 0.15, 1.20, 1.45, 0.76, 0.80)

  // ---- sloped glacis plate ------------------------------------------------
  P.box(c.sec, 0, 2.30, 0.55, 1.05, 0, 0.34, 2.10, -0.40, 0, 0, { frontY: 0.45 })
  P.box(c.emis, 1, 1.70, 0.10, 0.10, 0, 0.63, 2.32, -0.40)

  // ---- commander's hatch: the dome sits IN it, not on it -----------------
  P.box(c.sec, 0, 1.12, 0.34, 1.02, seat.x, 0.86, seat.z, 0, 0, 0, { topX: 0.92 })
  P.add(new THREE.TorusGeometry(0.50, 0.085, det.ring[0], det.ring[1] + 2), c.sec, 0.15,
    place(seat.x, 0.99, seat.z, Math.PI * 0.5, 0, 0))
  P.boxPair(c.dark, 0, 0.18, 0.34, 0.30, 0.52, 0.92, 0.36)

  // ---- rear engine deck: louvres, stacks, lamp clusters -------------------
  P.box(c.sec, 0, 2.18, 0.24, 1.20, 0, 0.86, -1.55, 0, 0, 0, { topX: 0.94 })
  for (let i = 0; i < 4; i++) P.box(c.emis, 1, 1.80, 0.05, 0.13, 0, 0.99, -1.10 - i * 0.30)
  P.box(c.sec, 0, 2.24, 0.80, 0.22, 0, 0.42, -2.16)
  P.box(c.emis, 1, 1.66, 0.14, 0.09, 0, 0.62, -2.28)
  P.boxPair(c.emis, 1, 0.28, 0.26, 0.10, 0.86, 0.22, -2.28)
  P.boxPair(c.dark, 0, 0.34, 0.34, 0.14, 0.40, 0.20, -2.29)
  for (const sx of [1, -1]) {
    addExhaustCan(P, det, c.sec, c.dark, c.emis, 0.21, sx * 0.80, 0.92, -1.96, 0.34)
  }

  if (det.d === 0) {
    P.boxPair(c.sec, 0, 0.22, 0.20, 0.90, 0.80, 0.86, 1.60)
    P.boxPair(c.dark, 0, 0.50, 0.14, 0.60, 1.02, 1.10, 0.80)
    for (let i = 0; i < 4; i++) {
      P.boxPair(c.dark, 0, 0.10, 0.10, 0.12, 1.44, 1.00, 1.45 - i * 0.44)
    }
    P.boxPair(c.dark, 0, 0.16, 0.16, 0.34, 0.62, 0.16, 2.32)
    P.boxPair(c.dark, 0, 0.16, 0.16, 0.30, 0.62, 0.14, -2.30)
    P.boxPair(c.sec, 0, 0.44, 0.26, 0.70, 1.02, 0.96, -1.30)
    P.box(c.sec, 0, 0.10, 0.62, 0.10, -0.62, 1.14, -0.30)
    P.add(cyl(0.16, 0.16, 0.07, det.seg), c.emis, 1, place(-0.62, 1.48, -0.30, 0.5, 0, 0))
    P.boxPair(c.sec, 0, 0.70, 0.12, 0.50, 1.16, 0.34, 1.60)
    P.boxPair(c.sec, 0, 0.70, 0.12, 0.50, 1.16, 0.34, -1.60)
  }

  if (det.d === 2) addPilotShell(P, p, 0.40, det, seat.x, seat.y, seat.z)

  // Turret authored with the barrel down +Z; the rig spins it to face rearward.
  const T = new Parts()
  T.add(cyl(0.62, 0.72, 0.38, det.seg), c.prim, 0, place(0, 0.19, 0))
  T.add(cyl(0.46, 0.56, 0.30, det.seg), c.prim, 0, place(0, 0.48, 0))
  T.box(c.sec, 0, 0.46, 0.42, 0.42, 0, 0.32, 0.52)
  T.box(c.sec, 0, 0.26, 0.24, 1.35, 0, 0.32, 0.98)
  T.add(cyl(0.19, 0.19, 0.34, det.seg, true), c.emis, 1, place(0, 0.32, 1.66, Math.PI * 0.5, 0, 0))
  T.box(c.sec, 0, 0.76, 0.24, 0.56, 0, 0.56, -0.36)
  if (det.d === 0) {
    T.box(c.emis, 1, 0.38, 0.07, 0.09, 0, 0.66, -0.10)
    T.boxPair(c.dark, 0, 0.10, 0.22, 0.26, 0.52, 0.26, -0.10)
  }

  // Tread cleats: the whole motion read of the vehicle lives here.
  const CL = new Parts()
  CL.box(c.dark, 0, 0.66, 0.075, 0.19, 0, 0, 0)
  if (det.d === 0) CL.box(c.emis, 1, 0.20, 0.05, 0.09, 0, 0.05, 0)

  return {
    body: P.merge(),
    cleats: { geo: CL.merge(), path: BULWARK_TREAD, perSide: det.cleats },
    turret: { geo: T.merge(), x: 0, y: 0.86, z: -0.62 },
    nozzles: {
      geo: nozzleGeo(0.21, det, c.emis, 0.30),
      slots: [{ x: 0.80, y: 0.92, z: -1.98 }, { x: -0.80, y: 0.92, z: -1.98 }],
      gimbal: false,
    },
    pilot: {
      seat, radius: 0.40,
      ...(det.d <= 1 ? { shell: pilotShellGeo(p, 0.40, det) } : {}),
      face: pilotFaceGeo(0.40, det),
    },
  }
}

// --- 4. Dray-9 -- grounded cab-over hauler ---------------------------------
// Read: a tall flat-nosed cab, two chimney stacks taller than the roof, a long
// magnetic cargo spine, and a rooftop cupola so the pilot is still visible over
// the load from the chase camera -- in the cab he was invisible for the whole
// race. The tail is a freight tail: gate, corner lamp stacks, step bumper.

const DRAY_WHEELS: Slot[] = [
  { x: 1.24, y: 0.01, z: 2.05, radius: 0.56, steer: true },
  { x: -1.24, y: 0.01, z: 2.05, radius: 0.56, steer: true },
  { x: 1.24, y: 0.01, z: -1.25, radius: 0.56 },
  { x: -1.24, y: 0.01, z: -1.25, radius: 0.56 },
  { x: 1.24, y: 0.01, z: -2.35, radius: 0.56 },
  { x: -1.24, y: 0.01, z: -2.35, radius: 0.56 },
]

const DRAY_PODS: Slot[] = [
  { x: 0, y: 1.05, z: 0.10, phase: 0 },
  { x: 0, y: 1.05, z: -1.10, phase: 2.1 },
  { x: 0, y: 1.05, z: -2.30, phase: 4.2 },
]

const buildDray9: Builder = (def, p, det) => {
  const c = palette(def)
  const P = new Parts()
  const seat: Slot = { x: 0, y: 1.70, z: 1.86 }

  if (det.d === 3) {
    P.boxPair(c.dark, 0, 0.28, 0.30, 5.90, 0.86, -0.24, -0.10)
    P.box(c.prim, 0, 2.55, 1.55, 1.85, 0, 0.62, 2.05, 0, 0, 0, { frontY: 0.94, topX: 0.9 })
    P.box(c.emis, 1, 2.05, 0.12, 0.14, 0, 1.46, 2.72)
    P.box(c.prim, 0, 1.10, 0.40, 1.00, 0, 1.52, 1.86)
    for (const sx of [1, -1]) {
      P.add(cyl(0.28, 0.32, 2.05, 5), c.sec, 0, place(sx * 1.20, 1.08, 1.30))
    }
    P.box(c.sec, 0, 0.60, 0.46, 3.70, 0, 0.28, -1.00)
    for (const s of DRAY_PODS) P.box(c.prim, 0, 2.00, 0.78, 1.00, s.x, s.y, s.z)
    bakeWheelBoxes(P, c.dark, DRAY_WHEELS, 0.56, 0.40)
    P.box(c.sec, 0, 2.36, 0.90, 0.22, 0, 0.40, -2.98)
    P.box(c.emis, 1, 1.70, 0.16, 0.10, 0, 0.52, -3.08)
    P.boxPair(c.emis, 1, 0.26, 0.44, 0.11, 1.02, 0.36, -3.08)
    addPilotShell(P, p, 0.40, det, seat.x, seat.y, seat.z)
    addPilotFaceFlat(P, p, 0.40, seat.x, seat.y, seat.z)
    return { body: P.merge() }
  }

  // ---- ladder chassis -----------------------------------------------------
  P.boxPair(c.dark, 0, 0.28, 0.30, 5.90, 0.86, -0.24, -0.10)
  P.box(c.dark, 0, 2.00, 0.18, 3.60, 0, 0.06, -1.00)

  // ---- cab-over: an open frame so the pilot reads through the front -------
  P.box(c.prim, 0, 2.55, 0.28, 1.90, 0, 1.28, 2.05, 0, 0, 0, { topX: 0.90 })
  P.box(c.sec, 0, 2.45, 0.24, 1.90, 0, -0.06, 2.05)
  P.boxPair(c.prim, 0, 0.32, 1.22, 1.90, 1.11, 0.62, 2.05, 0, 0, 0, { frontY: 0.90 })
  P.box(c.sec, 0, 2.42, 1.22, 0.24, 0, 0.62, 1.22)
  P.boxPair(c.prim, 0, 0.22, 1.05, 0.24, 1.02, 0.68, 2.88)
  P.box(c.sec, 0, 0.16, 1.05, 0.20, 0, 0.68, 2.92)

  // ---- roof cupola: pilot sunk to the equator, visible over the load ------
  P.box(c.prim, 0, 1.16, 0.46, 1.06, seat.x, 1.50, seat.z, 0, 0, 0, { topX: 0.88 })
  P.box(c.dark, 0, 0.98, 0.10, 0.88, seat.x, 1.68, seat.z)
  P.add(new THREE.TorusGeometry(0.50, 0.07, det.ring[0], det.ring[1] + 2), c.sec, 0.20,
    place(seat.x, 1.70, seat.z, Math.PI * 0.5, 0, 0))
  P.boxPair(c.sec, 0, 0.13, 0.40, 0.28, 0.42, 1.60, 1.42)
  P.boxPair(c.emis, 1, 0.06, 0.26, 0.08, 0.49, 1.64, 1.42)

  // ---- roof visor + light bar: the truck's face --------------------------
  P.box(c.sec, 0, 2.38, 0.20, 0.34, 0, 1.50, 2.58)
  P.box(c.emis, 1, 2.05, 0.10, 0.13, 0, 1.50, 2.74)
  P.box(c.prim, 0, 2.70, 0.42, 0.44, 0, -0.22, 2.96)
  P.boxPair(c.emis, 1, 0.44, 0.15, 0.15, 0.95, -0.18, 3.16)

  // ---- enormous exhaust stacks -------------------------------------------
  for (const sx of [1, -1]) {
    P.add(cyl(0.28, 0.32, 2.05, det.seg), c.sec, 0, place(sx * 1.20, 1.08, 1.30))
    if (det.d <= 1) {
      P.add(new THREE.TorusGeometry(0.31, 0.055, det.ring[0], det.ring[1]), c.emis, 1,
        place(sx * 1.20, 1.80, 1.30, Math.PI * 0.5, 0, 0))
      P.add(new THREE.TorusGeometry(0.31, 0.055, det.ring[0], det.ring[1]), c.emis, 1,
        place(sx * 1.20, 1.48, 1.30, Math.PI * 0.5, 0, 0))
    }
    P.add(cyl(0.36, 0.30, 0.26, det.seg, true), c.dark, 0, place(sx * 1.20, 2.08, 1.30))
    P.box(c.dark, 0, 0.34, 0.95, 0.36, sx * 1.20, 0.58, 1.30)
  }

  // ---- magnetic cargo spine ----------------------------------------------
  P.box(c.sec, 0, 0.60, 0.46, 3.70, 0, 0.28, -1.00)
  P.boxPair(c.emis, 1, 0.11, 0.09, 3.45, 0.92, 0.54, -1.00)
  if (det.d <= 1) {
    for (let i = 0; i < 5; i++) P.box(c.sec, 0, 2.00, 0.14, 0.17, 0, 0.50, 0.35 - i * 0.72)
  }

  // ---- fenders + freight tail --------------------------------------------
  P.boxPair(c.sec, 0, 0.52, 0.17, 2.20, 1.24, 0.62, -1.80)
  P.boxPair(c.sec, 0, 0.52, 0.17, 1.15, 1.24, 0.62, 2.05)
  P.box(c.sec, 0, 2.36, 0.92, 0.22, 0, 0.40, -2.96, 0, 0, 0, { topX: 0.96 })
  P.box(c.emis, 1, 1.66, 0.14, 0.09, 0, 0.52, -3.08)
  P.boxPair(c.emis, 1, 0.24, 0.42, 0.10, 1.02, 0.36, -3.08)
  P.box(c.dark, 0, 1.30, 0.30, 0.12, 0, 0.02, -3.08)
  P.box(c.dark, 0, 2.20, 0.26, 0.30, 0, -0.30, -3.06)
  P.boxPair(c.sec, 0, 0.24, 0.36, 0.24, 0.80, -0.14, -3.10)

  if (det.d === 0) {
    P.boxPair(c.dark, 0, 0.42, 0.05, 0.06, 1.42, 1.02, 2.86)
    P.boxPair(c.sec, 0, 0.10, 0.42, 0.16, 1.66, 0.92, 2.86)
    P.boxPair(c.dark, 0, 0.42, 0.07, 0.40, 1.32, -0.34, 2.10)
    P.boxPair(c.dark, 0, 0.42, 0.07, 0.40, 1.32, -0.62, 2.10)
    for (let i = 0; i < 4; i++) P.box(c.dark, 0, 2.40, 0.06, 0.10, 0, -0.10 - i * 0.09, 3.16)
    P.boxPair(c.dark, 0, 0.50, 0.46, 0.06, 1.24, -0.10, -2.86)
    for (let i = 0; i < 4; i++) {
      P.box(c.dark, 0, 1.80, 0.06, 0.07, 0, 0.16, -0.20 - i * 0.80, 0, 0, i % 2 ? 0.28 : -0.28)
    }
    P.boxPair(c.dark, 0, 0.10, 1.10, 0.46, 1.50, 1.15, 1.30)
    for (let i = 0; i < 3; i++) P.box(c.emis, 1, 0.10, 0.10, 0.09, -0.30 + i * 0.30, 0.72, -3.08)
  }

  if (det.d === 2) addPilotShell(P, p, 0.40, det, seat.x, seat.y, seat.z)

  const POD = new Parts()
  POD.box(c.prim, 0, 2.00, 0.78, 1.00, 0, 0, 0, 0, 0, 0, { topX: 0.86 })
  POD.box(c.emis, 1, 1.62, 0.09, 0.82, 0, -0.44, 0)
  // Dark cap + corner lamps: three pods have to read as three, not as a ramp.
  POD.box(c.sec, 0, 1.78, 0.10, 1.06, 0, 0.36, 0)
  POD.boxPair(c.emis, 1, 0.10, 0.10, 0.10, 0.86, 0.30, -0.46)
  if (det.d <= 1) POD.boxPair(c.sec, 0, 0.13, 0.30, 0.86, 0.94, -0.10, 0)

  return {
    body: P.merge(),
    wheels: { geo: wheelGeo(0.56, 0.40, det, c.dark, c.sec, c.emis), slots: DRAY_WHEELS },
    pods: { geo: POD.merge(), slots: DRAY_PODS },
    nozzles: {
      geo: nozzleGeo(0.24, det, c.emis, 0.24),
      // Boost blasts straight up out of the stacks.
      slots: [
        { x: 1.20, y: 2.18, z: 1.30, rx: Math.PI * 0.5 },
        { x: -1.20, y: 2.18, z: 1.30, rx: Math.PI * 0.5 },
      ],
      gimbal: false,
    },
    pilot: {
      seat, radius: 0.40,
      ...(det.d <= 1 ? { shell: pilotShellGeo(p, 0.40, det) } : {}),
      face: pilotFaceGeo(0.40, det),
    },
  }
}

// --- 5. Vector-7 -- flight strike fighter ----------------------------------
// Read: a dart with four FORWARD-SWEPT wings making an X from the front, a
// glass bubble over the pilot, and four gimballing nozzles.
//
// The old build fell apart at range because every element was a separate thin
// bar: four wings, two fins, four floating cones, nothing joining them. Three
// things fix that and none of them cost a draw call:
//   - a wing CENTRE-SECTION fairing all four roots are buried in, so the wings
//     grow out of a body instead of hovering beside one,
//   - one engine NACELLE block carrying all four exhaust cans, so the tail is
//     a mass rather than a cluster,
//   - a TAILPLANE bridging the two vertical stabilisers, which closes the
//     silhouette into a single readable shape from directly behind.
//
// The left wings are placed by adding PI to the root roll rather than by a
// negative scale: that mirrors the plan-view without flipping the winding, so
// all four share one geometry, one FrontSide material and one draw call.

const V7_WINGS: Slot[] = [
  { x: 0.52, y: 0.28, z: -0.34, rz: 0.26, s: 1.00, mirror: 1 },
  { x: -0.52, y: 0.28, z: -0.34, rz: Math.PI - 0.26, s: 1.00, mirror: -1 },
  { x: 0.46, y: -0.34, z: -0.34, rz: -0.32, s: 0.76, mirror: 1 },
  { x: -0.46, y: -0.34, z: -0.34, rz: Math.PI + 0.32, s: 0.76, mirror: -1 },
]

const V7_NOZZLES: Slot[] = [
  { x: 0.48, y: 0.26, z: -2.54 },
  { x: -0.48, y: 0.26, z: -2.54 },
  { x: 0.48, y: -0.26, z: -2.54 },
  { x: -0.48, y: -0.26, z: -2.54 },
]

const buildVector7: Builder = (def, p, det) => {
  const c = palette(def)
  const P = new Parts()
  const seat: Slot = { x: 0, y: 0.30, z: 1.15 }

  const wingShape: BoxShape = { spanZ: [1, 0.46], spanY: [1, 0.55], spanSweep: 0.95 }

  if (det.d === 3) {
    P.box(c.prim, 0, 0.92, 0.68, 4.60, 0, 0, 0.05, 0, 0, 0,
      { frontX: 0.32, frontY: 0.40, topX: 0.88 })
    P.box(c.prim, 0, 1.50, 0.84, 1.90, 0, -0.02, -0.30, 0, 0, 0, { frontX: 0.72, topX: 0.86 })
    for (const s of V7_WINGS) {
      const sc = s.s ?? 1
      const rz = s.rz ?? 0
      // shapedBox centres the wing on its span, so push the centre out along
      // the rotated span axis to land the root on the hardpoint.
      const half = 0.775 * sc
      P.box(
        c.prim, 0, 1.55 * sc, 0.16, 1.30 * sc,
        s.x + Math.cos(rz) * half, s.y + Math.sin(rz) * half, s.z,
        0, 0, rz,
        { spanZ: [1, 0.46], spanY: [1, 0.55], spanSweep: 0.95 * sc },
      )
    }
    P.box(c.prim, 0, 1.44, 0.90, 1.16, 0, 0, -1.98)
    P.box(c.dark, 0, 1.30, 0.84, 0.16, 0, 0, -2.50)
    P.box(c.emis, 1, 0.16, 0.14, 2.10, 0, 0.40, -0.70)
    P.box(c.prim, 0, 1.38, 0.08, 0.54, 0, 1.02, -2.10)
    P.boxPair(c.prim, 0, 0.10, 0.96, 0.78, 0.52, 0.66, -2.02, 0, 0, -0.22)
    P.box(c.emis, 1, 1.14, 0.10, 0.10, 0, 1.00, -2.32)
    for (const s of V7_NOZZLES) P.box(c.sec, 0, 0.36, 0.36, 0.40, s.x, s.y, s.z + 0.28)
    addPilotShell(P, p, 0.40, det, seat.x, seat.y, seat.z)
    addPilotFaceFlat(P, p, 0.40, seat.x, seat.y, seat.z)
    return { body: P.merge() }
  }

  // ---- fuselage spindle ---------------------------------------------------
  P.box(c.prim, 0, 0.92, 0.70, 4.60, 0, 0, 0.05, 0, 0, 0,
    { frontX: 0.30, frontY: 0.38, backX: 0.86, backY: 0.94, topX: 0.88 })
  P.add(cyl(0.03, 0.20, 0.80, det.seg), c.sec, 0, place(0, 0.02, 2.72, Math.PI * 0.5, 0, 0))
  P.box(c.prim, 0, 0.42, 0.34, 1.10, 0, 0.04, 2.10, 0, 0, 0, { frontX: 0.42, frontY: 0.44 })
  P.boxPair(c.emis, 1, 0.09, 0.08, 0.14, 0.16, 0.04, 2.56)

  // ---- dorsal ridge, lit spine, ventral strake ---------------------------
  P.box(c.sec, 0, 0.30, 0.26, 2.40, 0, 0.38, -0.70, 0, 0, 0, { frontY: 0.50 })
  P.box(c.emis, 1, 0.15, 0.11, 2.20, 0, 0.45, -0.70)
  P.box(c.sec, 0, 0.34, 0.28, 2.60, 0, -0.38, -0.30, 0, 0, 0, { frontY: 0.60 })

  // ---- wing centre section: all four roots bury into this ----------------
  P.box(c.prim, 0, 1.50, 0.86, 1.94, 0, -0.02, -0.30, 0, 0, 0,
    { frontX: 0.70, frontY: 0.82, backX: 0.92, topX: 0.86 })
  P.boxPair(c.sec, 0, 0.10, 0.20, 1.54, 0.72, -0.22, -0.34)
  P.boxPair(c.emis, 1, 0.08, 0.07, 1.30, 0.76, 0.20, -0.34)

  // ---- engine nacelle: one light mass with a dark, lit rear face ---------
  P.box(c.prim, 0, 1.46, 0.94, 1.18, 0, 0, -1.96, 0, 0, 0, { frontX: 0.94, topX: 0.92 })
  P.boxPair(c.sec, 0, 0.09, 0.18, 0.94, 0.73, 0.12, -1.98)
  P.boxPair(c.sec, 0, 0.09, 0.18, 0.94, 0.73, -0.20, -1.98)
  P.box(c.dark, 0, 1.32, 0.86, 0.16, 0, 0, -2.50, 0, 0, 0, { topX: 0.94 })
  P.boxPair(c.emis, 1, 0.09, 0.07, 0.86, 0.70, 0.36, -1.96)
  for (const s of V7_NOZZLES) {
    addExhaustCan(P, det, c.sec, c.dark, c.emis, 0.20, s.x, s.y, -2.52, 0.30)
  }
  P.box(c.sec, 0, 1.10, 0.10, 0.10, 0, 0, -2.55)
  P.box(c.sec, 0, 0.10, 0.72, 0.10, 0, 0, -2.55)

  // ---- tail: two canted fins BRIDGED by a tailplane ----------------------
  P.boxPair(c.prim, 0, 0.10, 0.98, 0.78, 0.52, 0.66, -2.02, 0, 0, -0.22, { frontY: 0.52 })
  P.boxPair(c.emis, 1, 0.07, 0.15, 0.64, 0.60, 1.06, -2.04, 0, 0, -0.22)
  P.boxPair(c.sec, 0, 0.05, 0.60, 0.66, 0.57, 0.76, -2.02, 0, 0, -0.22)
  P.box(c.prim, 0, 1.38, 0.08, 0.54, 0, 1.02, -2.10)
  P.boxPair(c.emis, 1, 0.14, 0.06, 0.34, 0.60, 1.05, -2.16)
  P.box(c.emis, 1, 1.14, 0.05, 0.09, 0, 1.00, -2.34)

  // ---- canards + cockpit tub ---------------------------------------------
  P.boxPair(c.prim, 0, 0.70, 0.07, 0.60, 0.52, 0.06, 1.72, 0, 0, 0.16, { frontX: 0.45 })
  P.box(c.sec, 0, 0.92, 0.46, 1.18, seat.x, 0.08, seat.z, 0, 0, 0, { topX: 0.90 })
  P.box(c.dark, 0, 0.76, 0.09, 0.96, seat.x, 0.29, seat.z)
  P.add(new THREE.TorusGeometry(0.53, 0.055, det.ring[0], det.ring[1] + 2), c.sec, 0.30,
    place(seat.x, 0.30, seat.z, Math.PI * 0.5, 0, 0))

  if (det.d === 0) {
    P.box(c.sec, 0, 0.62, 0.22, 0.72, 0, -0.46, 1.35, 0.25)
    P.boxPair(c.dark, 0, 0.28, 0.26, 0.36, 0.52, 0.02, 0.42, 0, 0, 0, { frontX: 0.60 })
    P.boxPair(c.prim, 0, 0.32, 0.18, 0.94, 0.36, 0.22, 0.42, 0, 0, 0, { frontY: 0.50 })
    P.boxPair(c.sec, 0, 0.05, 0.05, 0.44, 0.22, 0.18, 2.30)
    P.boxPair(c.dark, 0, 0.09, 0.09, 0.70, 0.66, -0.34, -1.30)
    P.boxPair(c.emis, 1, 0.10, 0.09, 0.09, 0.70, 0.42, -2.50)
  }

  if (det.d === 2) addPilotShell(P, p, 0.40, det, seat.x, seat.y, seat.z)

  // One wing, root at local x = 0, tip toward +X and swept FORWARD.
  const W = new Parts()
  W.box(c.prim, 0, 1.55, 0.17, 1.32, 0.775, 0, 0, 0, 0, 0, wingShape)
  W.box(c.emis, 1, 0.22, 0.11, 0.28, 1.52, 0, 0.98)
  if (det.d <= 1) W.box(c.sec, 0, 0.42, 0.12, 0.86, 0.34, 0, -0.10)
  if (det.d === 0) {
    W.box(c.dark, 0, 0.05, 0.17, 0.62, 0.92, 0, 0.32)
    W.box(c.dark, 0, 0.05, 0.17, 0.48, 1.24, 0, 0.64)
  }

  const out: LodBuild = {
    body: P.merge(),
    wings: { geo: W.merge(), slots: V7_WINGS },
    nozzles: { geo: nozzleGeo(0.20, det, c.emis, 0.42), slots: V7_NOZZLES, gimbal: true },
    pilot: {
      seat, radius: 0.40,
      ...(det.d <= 1 ? { shell: pilotShellGeo(p, 0.40, det) } : {}),
      face: pilotFaceGeo(0.40, det),
    },
  }
  if (det.d <= 1) {
    const C = new Parts()
    C.add(
      new THREE.SphereGeometry(0.56, det.ball[0] - 4, det.ball[1] - 3, 0, TAU, 0, Math.PI * 0.60),
      c.light, 0.05, place(seat.x, 0.24, seat.z),
    )
    out.aux = { geo: C.merge(), kind: 'canopy' }
  }
  return out
}

const BUILDERS: Record<string, Builder> = {
  solaire: buildSolaire,
  filament: buildFilament,
  bulwark: buildBulwark,
  dray9: buildDray9,
  vector7: buildVector7,
}

// ---------------------------------------------------------------------------
// Geometry cache. Eight racers share one set of buffers.
// ---------------------------------------------------------------------------

const buildCache = new Map<string, LodBuild>()

/** At LOD2 the purely-decorative movers fold into the static body so the
 *  silhouette survives while the draw calls drop. */
function foldStatics(b: LodBuild, d: number): void {
  if (d < 2) return
  const list: THREE.BufferGeometry[] = [b.body]
  if (b.turret) {
    b.turret.geo.applyMatrix4(place(b.turret.x, b.turret.y, b.turret.z, 0, Math.PI, 0))
    list.push(b.turret.geo)
    delete b.turret
  }
  if (b.pods) {
    for (const s of b.pods.slots) {
      const g = b.pods.geo.clone()
      g.applyMatrix4(place(s.x, s.y, s.z))
      list.push(g)
    }
    b.pods.geo.dispose()
    delete b.pods
  }
  if (b.aux) {
    b.aux.geo.dispose()
    delete b.aux
  }
  if (list.length > 1) {
    const merged = mergeGeometries(list, false)
    for (const g of list) g.dispose()
    if (!merged) throw new Error('vehicles: LOD fold failed')
    merged.computeBoundingSphere()
    b.body = merged
  }
}

function getBuild(chassisId: string, pilotId: string, d: 0 | 1 | 2 | 3): LodBuild {
  // The pilot only changes the buffers once it is merged into the body (d >= 2).
  const key = `${chassisId}|${d}|${d >= 2 ? pilotId : '-'}`
  let b = buildCache.get(key)
  if (!b) {
    const def = CHASSIS_BY_ID[chassisId] ?? CHASSIS[0]
    const build = BUILDERS[def.id] ?? buildSolaire
    b = build(def, pilotDef(pilotId), DETAIL[d])
    foldStatics(b, d)
    buildCache.set(key, b)
  }
  return b
}

// ---------------------------------------------------------------------------
// GLB swap slot
// ---------------------------------------------------------------------------

let modelLoader: VehicleModelLoader | null = null

/**
 * Install a loader that can replace the procedural mesh with an authored model.
 *
 * Contract
 *  - Called once per vehicle at creation time, and only when the chassis def
 *    carries `modelUrl`. Procedural remains the default path.
 *  - Return an Object3D to swap immediately, or null to decline (the usual case
 *    for an async GLTFLoader). For the async path, keep the VehicleVisualEx and
 *    call `visual.attachModel(obj)` when the file lands; pass null to revert.
 *  - The returned object is parented under the same animated node as the
 *    procedural LOD, so body roll / pitch / squat / bob / spin-out / boost all
 *    keep working with no extra wiring.
 *  - Sub-rig animation binds BY NODE NAME (see RIG_NODES). Name a node
 *    'sg_turret' and it tracks rearward; name an InstancedMesh 'sg_wheels' and
 *    it takes the wheel slots. Anything unnamed simply does not animate.
 *  - `visual.materials` exposes this vehicle's live uniforms (boost gain, rim,
 *    invincibility pulse) so an authored model can share them and inherit every
 *    lighting behaviour the procedural path has.
 */
export function setVehicleModelLoader(fn: VehicleModelLoader | null): void {
  modelLoader = fn
}

// ---------------------------------------------------------------------------
// Runtime rig
// ---------------------------------------------------------------------------

export interface VehicleMaterials {
  body: SgBodyMaterial
  thrust: SgBodyMaterial
  face: SgFaceMaterial
  canopy: SgBodyMaterial | null
  ribbon: SgGlowMaterial | null
}

interface Rig {
  root: THREE.Group
  wheels: THREE.InstancedMesh | null
  wheelSlots: Slot[]
  cleats: THREE.InstancedMesh | null
  cleatPath: TreadPath | null
  cleatPerSide: number
  nozzles: THREE.InstancedMesh | null
  nozzleSlots: Slot[]
  nozzleGimbal: boolean
  wings: THREE.InstancedMesh | null
  wingSlots: Slot[]
  pods: THREE.InstancedMesh | null
  podSlots: Slot[]
  turret: THREE.Object3D | null
  aux: THREE.Object3D | null
  pilot: THREE.Object3D | null
  face: THREE.Object3D | null
  seat: Slot
}

const EMPTY_SLOTS: Slot[] = []

function emptyRig(root: THREE.Group): Rig {
  return {
    root,
    wheels: null, wheelSlots: EMPTY_SLOTS,
    cleats: null, cleatPath: null, cleatPerSide: 0,
    nozzles: null, nozzleSlots: EMPTY_SLOTS, nozzleGimbal: false,
    wings: null, wingSlots: EMPTY_SLOTS,
    pods: null, podSlots: EMPTY_SLOTS,
    turret: null, aux: null, pilot: null, face: null,
    seat: { x: 0, y: 0, z: 0 },
  }
}

function inst(
  geo: THREE.BufferGeometry, mat: THREE.Material, count: number, name: string,
): THREE.InstancedMesh {
  const m = new THREE.InstancedMesh(geo, mat, count)
  m.name = name
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  m.frustumCulled = false
  return m
}

/** Seeds instance matrices from their rest slots so a vehicle looks correct on
 *  the very first rendered frame, before update() has run once. */
function seedSlots(mesh: THREE.InstancedMesh, slots: Slot[]): void {
  for (let i = 0; i < slots.length && i < mesh.count; i++) {
    const s = slots[i]
    _e.set(s.rx ?? 0, s.ry ?? 0, s.rz ?? 0, 'ZYX')
    _q.setFromEuler(_e)
    _v.set(s.x, s.y, s.z)
    const sc = s.s ?? 1
    _s.set(sc, sc, sc)
    mesh.setMatrixAt(i, _m4b.compose(_v, _q, _s))
  }
  mesh.instanceMatrix.needsUpdate = true
}

function seedCleats(mesh: THREE.InstancedMesh, path: TreadPath, perSide: number): void {
  _s.set(1, 1, 1)
  for (let i = 0; i < perSide * 2 && i < mesh.count; i++) {
    const side = i < perSide ? 1 : -1
    const k = i < perSide ? i : i - perSide
    const ang = treadPoint(path, k / perSide, _v2)
    _e.set(ang, 0, 0, 'XYZ')
    _q.setFromEuler(_e)
    _v.set(side * path.sideX, path.y + _v2.y, _v2.z)
    mesh.setMatrixAt(i, _m4b.compose(_v, _q, _s))
  }
  mesh.instanceMatrix.needsUpdate = true
}

function buildRig(b: LodBuild, mats: VehicleMaterials, q: RenderQuality, shadow: boolean): Rig {
  const root = new THREE.Group()
  const rig = emptyRig(root)

  const body = new THREE.Mesh(b.body, mats.body)
  body.name = RIG_NODES.body
  body.castShadow = shadow
  body.receiveShadow = shadow
  root.add(body)

  if (b.wheels) {
    rig.wheels = inst(b.wheels.geo, mats.body, b.wheels.slots.length, RIG_NODES.wheels)
    rig.wheels.castShadow = shadow
    rig.wheelSlots = b.wheels.slots
    seedSlots(rig.wheels, b.wheels.slots)
    root.add(rig.wheels)
  }
  if (b.cleats && b.cleats.perSide > 0) {
    rig.cleats = inst(b.cleats.geo, mats.body, b.cleats.perSide * 2, RIG_NODES.cleats)
    rig.cleatPath = b.cleats.path
    rig.cleatPerSide = b.cleats.perSide
    seedCleats(rig.cleats, b.cleats.path, b.cleats.perSide)
    root.add(rig.cleats)
  }
  if (b.nozzles) {
    rig.nozzles = inst(b.nozzles.geo, mats.thrust, b.nozzles.slots.length, RIG_NODES.nozzles)
    rig.nozzleSlots = b.nozzles.slots
    rig.nozzleGimbal = b.nozzles.gimbal
    seedSlots(rig.nozzles, b.nozzles.slots)
    root.add(rig.nozzles)
  }
  if (b.wings) {
    rig.wings = inst(b.wings.geo, mats.body, b.wings.slots.length, RIG_NODES.wings)
    rig.wings.castShadow = shadow
    rig.wingSlots = b.wings.slots
    seedSlots(rig.wings, b.wings.slots)
    root.add(rig.wings)
  }
  if (b.pods) {
    rig.pods = inst(b.pods.geo, mats.body, b.pods.slots.length, RIG_NODES.pods)
    rig.pods.castShadow = shadow
    rig.podSlots = b.pods.slots
    seedSlots(rig.pods, b.pods.slots)
    root.add(rig.pods)
  }
  if (b.turret) {
    const t = new THREE.Mesh(b.turret.geo, mats.body)
    t.name = RIG_NODES.turret
    t.position.set(b.turret.x, b.turret.y, b.turret.z)
    t.rotation.y = Math.PI
    t.castShadow = shadow
    rig.turret = t
    root.add(t)
  }
  if (b.aux && q.tier !== 'low') {
    const m = b.aux.kind === 'canopy' ? mats.canopy : mats.ribbon
    if (m) {
      const a = new THREE.Mesh(b.aux.geo, m)
      a.name = RIG_NODES.aux
      a.renderOrder = 3
      rig.aux = a
      root.add(a)
    }
  }
  if (b.pilot) {
    rig.seat = b.pilot.seat
    const holder = new THREE.Group()
    holder.name = RIG_NODES.pilot
    holder.position.set(b.pilot.seat.x, b.pilot.seat.y, b.pilot.seat.z)
    if (b.pilot.shell) {
      const sm = new THREE.Mesh(b.pilot.shell, mats.body)
      sm.castShadow = shadow
      holder.add(sm)
    }
    if (b.pilot.face) {
      const f = new THREE.Mesh(b.pilot.face, mats.face)
      f.name = RIG_NODES.face
      f.renderOrder = 4
      rig.face = f
      holder.add(f)
    }
    rig.pilot = holder
    root.add(holder)
  }
  return rig
}

/** Binds an authored model's named nodes onto the same animation channels. */
function bindModelRig(obj: THREE.Object3D, ref: LodBuild): Rig {
  const root = new THREE.Group()
  root.add(obj)
  const rig = emptyRig(root)
  const find = (n: string): THREE.Object3D | null => obj.getObjectByName(n) ?? null
  const instOf = (n: string): THREE.InstancedMesh | null => {
    const o = find(n)
    return o && (o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh) : null
  }
  rig.wheels = instOf(RIG_NODES.wheels)
  rig.wheelSlots = ref.wheels?.slots ?? EMPTY_SLOTS
  rig.cleats = instOf(RIG_NODES.cleats)
  rig.cleatPath = ref.cleats?.path ?? null
  rig.cleatPerSide = ref.cleats?.perSide ?? 0
  rig.nozzles = instOf(RIG_NODES.nozzles)
  rig.nozzleSlots = ref.nozzles?.slots ?? EMPTY_SLOTS
  rig.nozzleGimbal = ref.nozzles?.gimbal ?? false
  rig.wings = instOf(RIG_NODES.wings)
  rig.wingSlots = ref.wings?.slots ?? EMPTY_SLOTS
  rig.pods = instOf(RIG_NODES.pods)
  rig.podSlots = ref.pods?.slots ?? EMPTY_SLOTS
  rig.turret = find(RIG_NODES.turret)
  rig.aux = find(RIG_NODES.aux)
  rig.pilot = find(RIG_NODES.pilot)
  rig.face = find(RIG_NODES.face)
  rig.seat = ref.pilot?.seat ?? { x: 0, y: 0, z: 0 }
  return rig
}

// ---------------------------------------------------------------------------
// The visual
// ---------------------------------------------------------------------------

interface Temper { blink: number; jitter: number; emote: number; glitch: number }

/**
 * Body lean in a drift.
 *
 * DRIFT_LEAN is the roll, in radians, of a grounded chassis at full lock: 24
 * degrees, and 33/37 for hover and flight once rollScale is applied. It is the
 * loudest piece of body language the car has, so it earns the size — a drift
 * that turns 1.5-1.9x sharper than steering has to LOOK like it is doing
 * something steering does not. Verified in a real browser: at the shipped
 * value the bank reads clearly against the horizon, because the camera banks
 * the OTHER way (see camera.driftRoll) and the two do not cancel.
 *
 * DRIFT_LEAN_FLOOR is what survives at full counter-steer. The lean used to
 * key off driftSide alone, so a counter-steered slide leaned exactly as hard
 * as a fully committed one and the player could not see which end of the stick
 * they were holding. Scaling it by driftInward makes the car visibly stand
 * back up as the line is opened out.
 */
const DRIFT_LEAN = 0.42
const DRIFT_LEAN_FLOOR = 0.34
/** Roll contributed by raw yaw rate, radians at the chassis's own yaw limit. */
const YAW_LEAN = 0.105

const TEMPER: Record<PilotDef['temperament'], Temper> = {
  eager: { blink: 2.2, jitter: 0.020, emote: 0.38, glitch: 0 },
  jittery: { blink: 1.0, jitter: 0.085, emote: 0.18, glitch: 0 },
  cold: { blink: 0, jitter: 0.000, emote: 0.00, glitch: 0 },
  gruff: { blink: 4.6, jitter: 0.030, emote: -0.42, glitch: 0 },
  serene: { blink: 5.6, jitter: 0.008, emote: 0.22, glitch: 0 },
  glitched: { blink: 0.7, jitter: 0.060, emote: -0.10, glitch: 1 },
}

class VehicleVisualImpl implements VehicleVisualEx {
  readonly group = new THREE.Group()
  readonly materials: VehicleMaterials
  autoPlace = true
  gravity = false
  lodIndex = 0

  private readonly tilt = new THREE.Group()
  private readonly lod = new THREE.LOD()
  private readonly rigs: Rig[] = []
  private readonly refBuild: LodBuild
  private modelRig: Rig | null = null
  private modelObj: THREE.Object3D | null = null

  private readonly loco: ChassisDef['locomotion']
  private readonly maxYaw: number
  private readonly rollScale: number
  private readonly lodBias: number
  private readonly particleScale: number
  private readonly temper: Temper
  private readonly phase: number

  // Animation state. Everything here is a plain number: update() allocates 0.
  private time = 0
  private roll = 0
  private pitch = 0
  private squat = 0
  private bob = 0
  private drift = 0
  private inward = 0
  private accelSm = 0
  private prevSpeed = 0
  private rollDist = 0
  private steerAng = 0
  private treadPhase = 0
  private turretYaw = Math.PI
  private boost = 0
  private pulse = 0
  private wingFlex = 0
  private nozYaw = 0
  private nozPitch = 0
  private blinkTimer = 1
  private blinkAnim = 0
  private emote = 0
  private extraYaw = 0

  constructor(def: ChassisDef, pilot: PilotDef, quality: RenderQuality) {
    this.loco = def.locomotion
    this.maxYaw = Math.max(0.35, getDerived(def.id).maxYawRate)
    this.rollScale = def.locomotion === 'hover' ? 1.35 : def.locomotion === 'flight' ? 1.55 : 1.0
    this.lodBias = quality.tier === 'low' ? 0.6 : quality.tier === 'medium' ? 0.85 : 1
    this.particleScale = quality.particleScale
    this.temper = TEMPER[pilot.temperament]
    this.phase = ((def.id.length * 7 + pilot.id.length * 13) % 17) * 0.37

    const c = palette(def)
    const rim = c.emis.clone().lerp(new THREE.Color(0xffffff), 0.45)
    this.materials = {
      // Low metalness on purpose: there is no environment map in this scene,
      // so metal has nothing to reflect and only loses saturation.
      // rimPower is high so the fresnel stays a SILHOUETTE edge. At 2.4 it
      // washed every near-horizontal panel pale from the shallow chase angle,
      // which is most of why the old build read as flat grey planes.
      body: makeBodyMaterial({
        roughness: 0.52, metalness: 0.10,
        rim: 0.55, rimPower: 3.6, rimColor: rim.getHex(),
      }),
      thrust: makeBodyMaterial({
        roughness: 0.35, metalness: 0.06,
        rim: 0.28, rimPower: 3.0, rimColor: rim.getHex(),
      }),
      face: makeFaceMaterial(pilot.face, this.temper.glitch),
      canopy: def.locomotion === 'flight'
        ? makeBodyMaterial({
          roughness: 0.06, metalness: 0.0, transparent: true, opacity: 0.30,
          rim: 1.5, rimPower: 1.7, rimColor: rim.getHex(),
        })
        : null,
      ribbon: def.locomotion === 'hover' ? makeGlowMaterial(def.colorEmissive) : null,
    }
    this.materials.body.sg.uPulseColor.value.copy(rim)
    this.materials.thrust.sg.uPulseColor.value.copy(rim)

    this.refBuild = getBuild(def.id, pilot.id, 0)
    this.lod.autoUpdate = false
    for (let d = 0 as 0 | 1 | 2 | 3; d < 4; d = (d + 1) as 0 | 1 | 2 | 3) {
      const build = getBuild(def.id, pilot.id, d)
      const rig = buildRig(build, this.materials, quality, quality.shadows && d <= 1)
      rig.root.visible = d === 0
      this.rigs.push(rig)
      this.lod.addLevel(rig.root, d === 0 ? 0 : LOD_DISTANCES[d - 1] * this.lodBias)
    }
    this.tilt.add(this.lod)
    this.group.add(this.tilt)
    this.group.name = `vehicle:${def.id}`
  }

  attachModel(obj: THREE.Object3D | null): void {
    if (this.modelRig) {
      this.tilt.remove(this.modelRig.root)
      this.modelRig.root.clear()
      this.modelRig = null
      this.modelObj = null
    }
    if (obj) {
      this.modelRig = bindModelRig(obj, this.refBuild)
      this.modelObj = obj
      this.tilt.add(this.modelRig.root)
      this.lod.visible = false
    } else {
      this.lod.visible = true
    }
  }

  /** The authored model currently in use, if any. */
  get model(): THREE.Object3D | null { return this.modelObj }

  update(r: RacerState, dtRaw: number, cameraDistance: number): void {
    const dt = dtRaw > 0.05 ? 0.05 : dtRaw > 0 ? dtRaw : 0
    this.time += dt
    const t = this.time

    // ---- LOD -------------------------------------------------------------
    const b = this.lodBias
    const idx = cameraDistance < LOD_DISTANCES[0] * b ? 0
      : cameraDistance < LOD_DISTANCES[1] * b ? 1
        : cameraDistance < LOD_DISTANCES[2] * b ? 2 : 3
    if (idx !== this.lodIndex) {
      this.lodIndex = idx
      for (let i = 0; i < this.rigs.length; i++) this.rigs[i].root.visible = i === idx
    }
    const rig = this.modelRig ?? this.rigs[idx]

    // ---- Placement -------------------------------------------------------
    //
    // Flat, the body is a single rotation about world +Y and nothing else is
    // needed. On a gravity track the car has an attitude that a compass bearing
    // cannot express -- halfway up a wall it is rolled 90 degrees and its yaw
    // is a number about an axis running through its own door -- so the body is
    // built from the sim's actual frame.
    //
    // THE BASIS. Models are authored nose-toward +Z with +Y up, and with
    // `rotation.y = yaw` local +X lands on world (cos yaw, 0, -sin yaw), which
    // is the NEGATIVE of the sim's `right` (right = fwd x up). So the columns
    // are (up x fwd, up, fwd), which reduces to exactly that triple when up is
    // +Y, and which is right-handed because (up x fwd) x up = fwd.
    //
    // Everything cosmetic -- drift lean, pitch, squat, bob, the spin-out
    // wobble -- lives on `this.tilt`, a CHILD of this group, so it composes on
    // top of the surface frame rather than fighting it. A car leaning into a
    // drift on a vertical wall leans about the wall's normal, which is what a
    // driver would feel.
    if (this.autoPlace) {
      this.group.position.set(r.pos.x, r.pos.y, r.pos.z)
      if (this.gravity) {
        _by.set(r.up.x, r.up.y, r.up.z).normalize()
        // Gram-Schmidt the nose against the up rather than trusting r.fwd to be
        // exactly perpendicular to it. The sim re-orthogonalises them every
        // step, but this also runs on the INTERPOLATED view state, where two
        // separately damped unit vectors are neither orthogonal nor unit.
        _bz.set(r.fwd.x, r.fwd.y, r.fwd.z)
        _bz.addScaledVector(_by, -_bz.dot(_by))
        if (_bz.lengthSq() < 1e-8) {
          // Nose parallel to up: unreachable from the sim, but an authored
          // model or a mid-air interpolation artefact must not produce NaN.
          // Cross with whichever world axis `up` is least aligned with.
          _bz.set(Math.abs(_by.x) < 0.9 ? 1 : 0, Math.abs(_by.x) < 0.9 ? 0 : 1, 0).cross(_by)
        }
        _bz.normalize()
        _bx.copy(_by).cross(_bz) // up x fwd, unit because up _|_ fwd and both unit
        _basis.makeBasis(_bx, _by, _bz)
        this.group.quaternion.setFromRotationMatrix(_basis)
      } else {
        this.group.rotation.set(0, r.yaw, 0)
      }
    }

    // ---- Derived signals -------------------------------------------------
    const sy = Math.sin(r.yaw)
    const cy = Math.cos(r.yaw)
    // Forward speed for the wheel-roll rate and the load-transfer pitch. On a
    // gravity track the nose is r.fwd; the compass yaw would have the wheels
    // spinning backwards on a wall.
    const fwdSpeed = this.gravity
      ? r.vel.x * r.fwd.x + r.vel.y * r.fwd.y + r.vel.z * r.fwd.z
      : r.vel.x * sy + r.vel.z * cy
    const speed = Math.sqrt(r.vel.x * r.vel.x + r.vel.y * r.vel.y + r.vel.z * r.vel.z)
    const accel = dt > 0 ? (speed - this.prevSpeed) / dt : 0
    this.prevSpeed = speed
    this.accelSm = approach(this.accelSm, clamp(accel / 16, -1, 1), 0.10, dt)
    // Negated so it agrees in sign with driftSide: steering right gives a
    // positive driftSide but a negative yawRate (see STEER_SIGN in
    // vehicle.ts). Without this the two lean terms cancel each other.
    const yawN = clamp(-r.yawRate / this.maxYaw, -1, 1)
    const drive = clamp(speed / 62, 0, 1)
    const spinF = r.spinTime > 0 ? Math.min(1, r.spinTime * 1.6) : 0

    this.drift = approach(this.drift, r.driftSide, 0.09, dt)
    this.inward = approach(this.inward, r.driftSide !== 0 ? clamp(r.driftInward, 0, 1) : 0, 0.10, dt)
    const boostActive = r.boostTime > 0 ? 1 : 0
    const boostT = boostActive * clamp(r.boostMag / 0.48, 0, 1.5)
    this.boost = approach(this.boost, boostT, boostT > this.boost ? 0.035 : 0.14, dt)
    const boost = this.boost

    // ---- Body attitude ---------------------------------------------------
    // Bank INTO the corner: a right-hand turn drops the RIGHT flank, the way a
    // rider leans a bike, not the way a road car rolls onto its outside tyres.
    //
    // The sign is load-bearing and it used to be backwards. The model's nose
    // is +Z and the sim's right basis is forward x up, which is local -X, so
    // local +X is the vehicle's LEFT and a POSITIVE roll about Z raises the
    // left flank — i.e. drops the right. driftSide is +1 for a right-hand
    // drift and yawN is positive there too, so both terms are added, not
    // negated. The old negation leaned the car out of every corner it took.
    const lean = this.drift * (DRIFT_LEAN_FLOOR + (1 - DRIFT_LEAN_FLOOR) * this.inward)
    const rollT = (lean * DRIFT_LEAN + yawN * YAW_LEAN) * this.rollScale
    // Longitudinal load transfer: throttle squats the tail and lifts the nose,
    // braking dives. See the NOTE at the bottom of this file.
    let pitchT = this.accelSm * 0.085 + boost * 0.045
    if (this.loco === 'flight' && r.liftActive) pitchT += 0.17
    if (this.loco === 'flight') pitchT -= clamp(r.vertVel * 0.012, -0.12, 0.12)

    this.roll = approach(this.roll, rollT, 0.085, dt)
    this.pitch = approach(this.pitch, pitchT, 0.095, dt)
    this.squat = approach(this.squat, -clamp(this.accelSm, 0, 1) * 0.055, 0.12, dt)

    let bobT = 0
    if (this.loco === 'hover') bobT = Math.sin(t * 2.15 + this.phase) * 0.065
    else if (this.loco === 'flight') {
      bobT = Math.sin(t * 1.35 + this.phase) * 0.075 + Math.sin(t * 3.1) * 0.02
    }
    this.bob = approach(this.bob, bobT, 0.05, dt)

    let roll = this.roll
    let pitch = this.pitch
    if (spinF > 0) {
      // Reeling: the whole craft loses the plot for a moment.
      roll += Math.sin(t * 17.5) * 0.46 * spinF
      pitch += Math.cos(t * 11.3) * 0.20 * spinF
      this.extraYaw = Math.sin(t * 23.0) * 0.22 * spinF
    } else {
      this.extraYaw = approach(this.extraYaw, 0, 0.14, dt)
    }

    this.tilt.rotation.set(pitch, this.extraYaw, roll)
    this.tilt.position.y = this.bob + this.squat

    // ---- Materials -------------------------------------------------------
    const inv = r.invincibleTime > 0 ? 1 : 0
    const pulseT = inv * (0.30 + 0.30 * Math.sin(t * 15.5))
    this.pulse = approach(this.pulse, pulseT, 0.035, dt)
    const bm = this.materials.body.sg
    bm.uEmisGain.value = 1 + boost * 1.7 + drive * 0.22
    bm.uPulse.value = this.pulse
    bm.uRimStrength.value = 0.55 + boost * 0.55 + this.pulse * 0.8
    const tm = this.materials.thrust.sg
    tm.uEmisGain.value = 0.85 + boost * 8.5 + drive * 1.35
    tm.uPulse.value = this.pulse * 0.6
    if (this.materials.canopy) {
      this.materials.canopy.sg.uPulse.value = this.pulse * 0.5
      this.materials.canopy.sg.uRimStrength.value = 1.5 + boost * 0.9
    }
    if (this.materials.ribbon) {
      this.materials.ribbon.sg.uGain.value = 0.35 + drive * 0.85 + boost * 3.6
    }

    // ---- Wheels / repulsors ---------------------------------------------
    this.rollDist += fwdSpeed * dt
    this.steerAng = approach(this.steerAng, yawN * 0.42, 0.055, dt)
    if (rig.wheels) {
      const grounded = this.loco === 'grounded'
      const slots = rig.wheelSlots
      const n = Math.min(slots.length, rig.wheels.count)
      for (let i = 0; i < n; i++) {
        const s = slots[i]
        if (grounded) {
          _e.set(this.rollDist / (s.radius ?? 0.45), s.steer ? this.steerAng : 0, 0, 'YXZ')
          // Keep the contact patch on the road while the body rolls and pitches.
          _v.set(s.x, s.y - s.x * roll - s.z * pitch, s.z)
        } else {
          // Hover repulsors: spin about their own axis and pump with speed.
          _e.set(0, this.rollDist * 1.6, Math.sin(t * 6 + i) * 0.05, 'YXZ')
          _v.set(s.x, s.y + Math.sin(t * 3.4 + i * 2.1) * 0.035, s.z)
        }
        _q.setFromEuler(_e)
        // Slot scale lets one wheel buffer serve a staggered front/rear set.
        const sc = s.s ?? 1
        _s.set(sc, sc, sc)
        if (!grounded) {
          const p = sc * (1 + boost * 0.18 + Math.sin(t * 9 + i) * 0.02)
          _s.set(p, sc * (1 + boost * 0.30), p)
        }
        rig.wheels.setMatrixAt(i, _m4b.compose(_v, _q, _s))
      }
      rig.wheels.instanceMatrix.needsUpdate = true
    }

    // ---- Tank treads -----------------------------------------------------
    if (rig.cleats && rig.cleatPath) {
      const path = rig.cleatPath
      this.treadPhase += (fwdSpeed / path.perimeter) * dt
      if (this.treadPhase > 1 || this.treadPhase < -1) this.treadPhase -= Math.floor(this.treadPhase)
      const per = rig.cleatPerSide
      const n = Math.min(per * 2, rig.cleats.count)
      _s.set(1, 1, 1)
      for (let i = 0; i < n; i++) {
        const side = i < per ? 1 : -1
        const k = i < per ? i : i - per
        const ang = treadPoint(path, this.treadPhase + k / per, _v2)
        _e.set(ang, 0, 0, 'XYZ')
        _q.setFromEuler(_e)
        _v.set(side * path.sideX, path.y + _v2.y, _v2.z)
        rig.cleats.setMatrixAt(i, _m4b.compose(_v, _q, _s))
      }
      rig.cleats.instanceMatrix.needsUpdate = true
    }

    // ---- Thrusters -------------------------------------------------------
    if (rig.nozzles) {
      if (rig.nozzleGimbal) {
        this.nozYaw = approach(this.nozYaw, -yawN * 0.40, 0.06, dt)
        this.nozPitch = approach(
          this.nozPitch, -pitch * 1.3 + (r.liftActive ? 0.22 : 0), 0.07, dt,
        )
      }
      const stretch = 1 + boost * 2.2 * this.particleScale + drive * 0.25
      const fat = 1 + boost * 0.20
      const slots = rig.nozzleSlots
      const n = Math.min(slots.length, rig.nozzles.count)
      for (let i = 0; i < n; i++) {
        const s = slots[i]
        _e.set(
          (s.rx ?? 0) + this.nozPitch,
          (s.ry ?? 0) + this.nozYaw,
          s.rz ?? 0,
          'ZYX',
        )
        _q.setFromEuler(_e)
        _v.set(s.x, s.y, s.z)
        _s.set(fat, fat, stretch * (0.92 + 0.16 * Math.sin(t * 34 + i * 1.7)))
        rig.nozzles.setMatrixAt(i, _m4b.compose(_v, _q, _s))
      }
      rig.nozzles.instanceMatrix.needsUpdate = true
    }

    // ---- Wings -----------------------------------------------------------
    if (rig.wings) {
      this.wingFlex = approach(
        this.wingFlex, clamp(-yawN * 0.55 + this.accelSm * 0.20, -1, 1), 0.13, dt,
      )
      const slots = rig.wingSlots
      const n = Math.min(slots.length, rig.wings.count)
      for (let i = 0; i < n; i++) {
        const s = slots[i]
        const m = s.mirror ?? 1
        const flex = (this.wingFlex * 0.20 + Math.sin(t * 3.3 + i) * 0.014 + boost * 0.05) * m
        _e.set(s.rx ?? 0, s.ry ?? 0, (s.rz ?? 0) + flex, 'ZYX')
        _q.setFromEuler(_e)
        _v.set(s.x, s.y, s.z)
        const sc = s.s ?? 1
        _s.set(sc, sc, sc)
        rig.wings.setMatrixAt(i, _m4b.compose(_v, _q, _s))
      }
      rig.wings.instanceMatrix.needsUpdate = true
    }

    // ---- Magnetic cargo --------------------------------------------------
    if (rig.pods) {
      const slots = rig.podSlots
      const n = Math.min(slots.length, rig.pods.count)
      _s.set(1, 1, 1)
      for (let i = 0; i < n; i++) {
        const s = slots[i]
        const ph = s.phase ?? 0
        _e.set(
          Math.sin(t * 1.7 + ph) * 0.022 - this.accelSm * 0.03,
          Math.sin(t * 1.1 + ph) * 0.028,
          Math.sin(t * 2.3 + ph) * 0.020 - roll * 0.35,
          'ZYX',
        )
        _q.setFromEuler(_e)
        _v.set(
          s.x + Math.sin(t * 1.9 + ph) * 0.02,
          s.y + Math.sin(t * 2.4 + ph) * 0.045,
          s.z - this.accelSm * 0.07,
        )
        rig.pods.setMatrixAt(i, _m4b.compose(_v, _q, _s))
      }
      rig.pods.instanceMatrix.needsUpdate = true
    }

    // ---- Turret: always looking at whoever is behind you ------------------
    if (rig.turret) {
      this.turretYaw = approach(this.turretYaw, Math.PI - yawN * 0.60 + this.drift * 0.18, 0.20, dt)
      rig.turret.rotation.set(-0.05 - pitch * 0.55, this.turretYaw, 0)
    }

    // ---- Light ribbons ---------------------------------------------------
    if (rig.aux) {
      const st = 1 + boost * 0.85 + drive * 0.40
      if (this.materials.ribbon) rig.aux.scale.set(1 + boost * 0.15, 1, st)
    }

    // ---- Pilot -----------------------------------------------------------
    if (rig.pilot) {
      const seat = rig.seat
      const j = this.temper.jitter
      rig.pilot.position.set(
        seat.x - yawN * 0.035 + (j > 0 ? Math.sin(t * 41) * j * 0.35 : 0),
        seat.y + Math.sin(t * 1.75 + this.phase) * 0.018 + boost * 0.012
          + (j > 0 ? Math.sin(t * 37 + 1.3) * j * 0.35 : 0),
        seat.z - this.accelSm * 0.02,
      )
      // Leans further into the turn than the chassis does. This is a LOCAL
      // rotation inside the already-rolled body, so both terms have to carry
      // the same sign as `roll` or the pilot fights the chassis instead of
      // exaggerating it.
      rig.pilot.rotation.set(-this.accelSm * 0.11 + spinF * Math.sin(t * 19) * 0.3,
        yawN * 0.16, roll * 0.45 + yawN * 0.10 * this.rollScale)
    }

    if (rig.face) {
      const fm = this.materials.face.sg
      fm.uTime.value = t
      if (this.temper.blink > 0) {
        this.blinkTimer -= dt
        if (this.blinkTimer <= 0) {
          // Deterministic jitter: keeps the render layer replay-stable.
          this.blinkTimer = this.temper.blink
            * (1.05 + Math.sin(t * 12.9898 + this.phase) * 0.45)
          this.blinkAnim = 1
        }
        if (this.blinkAnim > 0) this.blinkAnim = Math.max(0, this.blinkAnim - dt * 7.5)
        fm.uBlink.value = Math.sin(Math.PI * this.blinkAnim)
      }
      const emoteT = clamp(
        this.temper.emote + boost * 0.55 - spinF * 1.3 - (r.stunTime > 0 ? 0.7 : 0)
        - Math.abs(yawN) * 0.15,
        -1, 1,
      )
      this.emote = approach(this.emote, emoteT, 0.13, dt)
      fm.uEmote.value = this.emote
      fm.uGain.value = 1 + boost * 0.9 + this.pulse * 1.6
    }
  }

  dispose(): void {
    this.attachModel(null)
    this.group.remove(this.tilt)
    for (const rig of this.rigs) {
      rig.root.traverse((o) => {
        const im = o as THREE.InstancedMesh
        if (im.isInstancedMesh) im.dispose()
      })
      rig.root.clear()
    }
    this.rigs.length = 0
    this.lod.levels.length = 0
    this.tilt.clear()
    // Geometry is shared and stays in the module cache; only the per-instance
    // materials belong to this vehicle.
    this.materials.body.dispose()
    this.materials.thrust.dispose()
    this.materials.face.dispose()
    this.materials.canopy?.dispose()
    this.materials.ribbon?.dispose()
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build one racer's visual. Geometry comes from the shared module cache, so
 * calling this eight times costs eight Groups and eight small material sets,
 * not eight copies of the meshes.
 */
export function createVehicleVisual(
  chassisId: string,
  pilotId: string,
  quality: RenderQuality,
): VehicleVisualEx {
  const def = CHASSIS_BY_ID[chassisId] ?? CHASSIS[0]
  const pilot = pilotDef(pilotId)
  const v = new VehicleVisualImpl(def, pilot, quality)
  if (def.modelUrl && modelLoader) {
    const obj = modelLoader(def.id, def, quality)
    if (obj) v.attachModel(obj)
  }
  return v
}

/** Free every shared geometry. Call on scene teardown, after the individual
 *  VehicleVisuals have been disposed. */
export function disposeVehicleCache(): void {
  for (const b of buildCache.values()) {
    b.body.dispose()
    b.wheels?.geo.dispose()
    b.cleats?.geo.dispose()
    b.nozzles?.geo.dispose()
    b.wings?.geo.dispose()
    b.pods?.geo.dispose()
    b.turret?.geo.dispose()
    b.aux?.geo.dispose()
    b.pilot?.shell?.dispose()
    b.pilot?.face?.dispose()
  }
  buildCache.clear()
}

/** Number of distinct geometry buffers currently cached. Diagnostics only. */
export function vehicleCacheSize(): number {
  return buildCache.size
}

// ---------------------------------------------------------------------------
// NOTE on the pitch spec
// ---------------------------------------------------------------------------
// The brief asked for "squat under acceleration, nose-up under braking". Those
// two cannot share one sign, so the two halves are split:
//   - "squat" is the whole body dropping on throttle (this.squat, applied to
//     tilt.position.y), which is what a car visually does under power.
//   - the PITCH channel uses the readable arcade convention: throttle lifts the
//     nose (rear squat), braking dives it. Flip the sign of `pitchT` if the
//     design team wants the literal reading instead.

// Keep the TUNING import meaningful: the ground plane a chassis is authored
// against is exactly its locomotion ride height.
export function chassisGroundY(chassisId: string): number {
  const def = CHASSIS_BY_ID[chassisId] ?? CHASSIS[0]
  return -TUNING.locomotion[def.locomotion].rideHeight
}
