/**
 * SpaceGen Racing — THE PODIUM STAGE.
 * ---------------------------------------------------------------------------
 * Three steps, the three championship cars parked at the foot of them, the
 * three pilots up on top having the best day of their lives, and as much
 * confetti and fireworks as the frame budget will carry. Built into the game's
 * OWN scene and drawn through the game's OWN renderer and camera.
 *
 * NO SECOND CONTEXT. ui/garagePreview.ts allocates one because it has to — the
 * garage is a DOM screen over a live game. This does not: the podium plays
 * after the last race of a circuit, the race world has just been torn down,
 * and the renderer, the scene and the chase rig's camera are all sitting there
 * empty. Building a second WebGLRenderer here would be the exact thing that
 * file's header exists to forbid, for no gain at all.
 *
 * Using `chase.camera` rather than a camera of our own is also not a shortcut:
 * the post chain is built against that camera object (see Game.buildWorld and
 * the same note on the attract shot), so a camera swapped in here would render
 * the bloom from a different view than the scene.
 *
 * ===========================================================================
 * THE COST, MEASURED RATHER THAN HOPED FOR
 *
 * The device floor is an iPhone 12 at 60fps, and three animated robots, three
 * vehicles, fireworks and heavy confetti is a frame that deserves suspicion.
 * So it was measured rather than argued about. tools/probe-podium.mjs takes the
 * renderer's OWN counters for the scene pass, on a real frame, and takes the
 * same counters for a racing frame of round 8 in the same run on the same
 * machine:
 *
 *   tier    podium              racing              podium frame / racing frame
 *   low     24 calls  13,968    66 calls   83,060    126 ms  /  574 ms
 *   medium  25 calls  19,162    67 calls  122,422   1316 ms  / 3483 ms
 *   high    25 calls  20,362    67 calls  138,862    819 ms  / 1907 ms
 *
 * (Milliseconds are SwiftShader, which is thirty times slower than the floor
 * device -- the ratio is the number that travels, not the absolute, and the
 * absolutes wander by a factor of two between runs on a shared machine.)
 *
 * Just over a third of the draw calls and a sixth of the triangles of the race
 * that earned it, at every tier. That is the only acceptable answer: a player
 * does not want their reward to be the moment their phone gives up.
 *
 * Where it goes: ground 1, sky 1, block 2, cars 15 (five LOD0 meshes each, and
 * the seat is empty so the pilot's two are not drawn), pilots 5, particles 1.
 * The figures got a body between one pass and the next -- three extra draw
 * calls and ~2,500 triangles -- and the whole celebration still costs a third
 * of a racing frame, so nothing needed cutting to pay for it.
 *
 * The quality tier is honoured rather than ignored. Low drops the shadow pass,
 * the two coloured rim lights and 55% of the particle pool, and builds the
 * pilots at LOD1.
 */
import * as THREE from 'three'
import { QUALITY_PRESETS, type RenderQuality } from './api'
import { K_BEAD, K_RING, K_SHELL, K_SPARK, K_SPRITE, ParticlePool } from './particles'
import {
  RIG_NODES, chassisGroundY, createPilotFigure, createVehicleVisual,
  type PilotFigure, type VehicleVisualEx,
} from './vehicles'
import { PILOTS_BY_ID } from '../content/pilots'
import {
  CAR_YAW, CAR_Z, PILOT_SCALE, PODIUM_FACE_Y, STEP_D, STEP_HALF_W, STEP_X,
  STEP_Y, makePodiumFrame, podiumFrameAt, podiumSkyPoint,
  type PodiumBurst, type PodiumCast, type PodiumFrame, type PodiumLens,
} from '../game/podium'
import type { RacerState } from '../sim/types'

// ---------------------------------------------------------------------------
// A private, seeded generator
// ---------------------------------------------------------------------------
//
// NOT Math.random, and not the sim's. Two runs of tools/probe-podium.mjs must
// photograph the same confetti, or a screenshot diff is a diff of the dice
// rather than of the code. Same argument, and the same xorshift32, that
// render/vfx.ts makes for its spark stream.

let _seed = 0x1f123bb5
function rnd(): number {
  let x = _seed
  x ^= x << 13; x >>>= 0
  x ^= x >>> 17
  x ^= x << 5; x >>>= 0
  _seed = x
  return x / 4294967296
}
const rnd2 = (): number => rnd() * 2 - 1

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

const _c = new THREE.Color()

/** sRGB hex to a linear RGB triple at a stated gain. */
function rgb(hex: number, gain: number): Float32Array {
  _c.setHex(hex, THREE.SRGBColorSpace)
  return new Float32Array([_c.r * gain, _c.g * gain, _c.b * gain])
}

/** Step face colours: the three medals, which is the whole read at a glance. */
const MEDAL = [0xffd23f, 0xd8e4ef, 0xd08a4a]
/** How far over 1.0 the medal furniture is driven, so it clears bloom. */
const STRIP_GAIN = 2.3

/**
 * Confetti hues.
 *
 * Deliberately a SHORT list of saturated colours rather than a free hue per
 * scrap. render/vfx.ts measured that one already: a free hue per bead averages
 * out to grey once there are hundreds of them in flight, because the eye
 * integrates a full spectrum back to white. Five colours stay five colours.
 */
const CONFETTI = [
  rgb(0xffd23f, 1.45), // gold
  rgb(0x22d3ff, 1.35), // cyan
  rgb(0xff4d94, 1.35), // magenta
  rgb(0x2fe36b, 1.30), // green
  rgb(0xfff6e0, 1.25), // warm white
]

/** Firework shell colours. Brighter: these are meant to clip and bloom. */
const FIREWORK = [
  rgb(0xffd23f, 2.6),
  rgb(0x7ab8ff, 2.4),
  rgb(0xff6bd0, 2.4),
  rgb(0x9cffc4, 2.3),
  rgb(0xffffff, 2.2),
]

const WHITE = rgb(0xffffff, 3.0)

/** The aspect every beat in game/podium.ts is composed for. */
const REF_ASPECT = 16 / 9
/**
 * How far the lens may be opened before the rest of the correction is bought
 * by moving the camera instead. 66 degrees vertical.
 *
 * The split does not change how much of the world is in frame -- once the
 * horizontal extent is pinned and the aspect is fixed, the vertical extent
 * follows -- it only trades perspective for distance. 66 keeps the outer cars
 * out of the part of the lens that stretches them.
 */
const FOV_CAP = 66
/**
 * Half the width the scene actually needs, metres.
 *
 * The podium is 13.2 m across (two outer steps at 4.9 plus their 1.7
 * half-width), so 6.9 frames all of it with a little air. This is a CAP on how
 * much width the compensation asks for, and it is the number that makes a
 * portrait phone usable: asking for the full 16:9 frame width (23 m at the
 * hold beat) is asking for a 51 m tall frame on a 0.45 aspect, and the
 * photograph of that is a correct, beautifully framed podium the size of a
 * postage stamp in the middle of an enormous empty sky. Asking only for the
 * width the subject needs puts the podium across 92% of a phone's width.
 */
const SUBJECT_HALF_W = 6.9

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const _m = new THREE.Matrix4()

/**
 * A box at a position, NON-INDEXED.
 *
 * The expansion is not an optimisation, it is a correctness fix that cost a
 * photograph. `merged()` below has to de-index before it can concatenate, so
 * a BoxGeometry's 24 vertices become 36 -- and the medal colours were being
 * built from the INDEXED counts, which walked the colour array out of step
 * with the geometry after the first box. The place numbers came out grey and
 * the medal bars came out in each other's colours. Expanding here means one
 * vertex count for everything downstream.
 */
function box(
  w: number, h: number, d: number, x: number, y: number, z: number,
): THREE.BufferGeometry {
  const src = new THREE.BoxGeometry(w, h, d)
  const g = src.toNonIndexed()
  src.dispose()
  g.applyMatrix4(_m.makeTranslation(x, y, z))
  g.deleteAttribute('uv')
  return g
}

/**
 * Seven-segment digits, as boxes.
 *
 * A flat 1 / 2 / 3 on each step face. It is three numbers and it is the
 * difference between "a podium" and "THE podium, and he came second": the
 * height ladder alone is ambiguous from the two low camera beats, and the
 * medal colours are a convention not everybody reads. The whole set is a dozen
 * boxes merged into the strip mesh, so it costs no extra draw call.
 */
const SEG: Record<number, readonly number[]> = {
  //      top, tl, tr, mid, bl, br, bottom
  2: [1, 0, 1, 1, 1, 0, 1],
  3: [1, 0, 1, 1, 0, 1, 1],
}

function digit(n: number, cx: number, cy: number, cz: number, s: number): THREE.BufferGeometry[] {
  const t = s * 0.22 // stroke
  const out: THREE.BufferGeometry[] = []
  const add = (w: number, h: number, dx: number, dy: number): void => {
    out.push(box(w, h, t, cx + dx, cy + dy, cz))
  }
  // A ONE IS DRAWN, NOT SEGMENTED. Seven-segment puts a 1 on the RIGHT-hand
  // pair of strokes, which next to a centred 2 and 3 reads as a misaligned
  // bar rather than as a number -- and it is the champion's own digit, so it
  // is the one that has to be unambiguous. Centre stroke, serif flag, foot.
  if (n === 1) {
    add(t, s * 1.62, 0, 0)
    add(s * 0.34, t, -s * 0.16, s * 0.70)
    add(s * 0.66, t, 0, -s * 0.81)
    return out
  }
  const on = SEG[n] ?? SEG[2]
  if (on[0]) add(s * 0.9, t, 0, s * 0.72)
  if (on[1]) add(t, s * 0.72, -s * 0.45, s * 0.36)
  if (on[2]) add(t, s * 0.72, s * 0.45, s * 0.36)
  if (on[3]) add(s * 0.9, t, 0, 0)
  if (on[4]) add(t, s * 0.72, -s * 0.45, -s * 0.36)
  if (on[5]) add(t, s * 0.72, s * 0.45, -s * 0.36)
  if (on[6]) add(s * 0.9, t, 0, -s * 0.72)
  return out
}

function merged(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (list.length === 1) return list[0]
  const parts: THREE.BufferGeometry[] = list
  // Manual concat rather than BufferGeometryUtils: every part here is a
  // non-indexed box with the same attribute set (see box()), so a merge is an
  // array append and pulling in the utils module for it is not worth it.
  let verts = 0
  for (const p of parts) {
    verts += (p.getAttribute('position') as THREE.BufferAttribute).count
  }
  const pos = new Float32Array(verts * 3)
  const nrm = new Float32Array(verts * 3)
  let o = 0
  for (const p of parts) {
    const a = p.getAttribute('position') as THREE.BufferAttribute
    const b = p.getAttribute('normal') as THREE.BufferAttribute
    pos.set(a.array as Float32Array, o * 3)
    nrm.set(b.array as Float32Array, o * 3)
    o += a.count
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  out.computeBoundingSphere()
  for (const g of list) g.dispose()
  return out
}

const SKY_VERT = `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`

/**
 * A night, and a glow behind the podium.
 *
 * Two terms and no texture: a vertical gradient for the sky, and a warm bloom
 * centred low and behind the block so the silhouettes have something to
 * separate from. A flat clear colour was tried first and the three chassis
 * read as cut-outs floating in nothing.
 */
const SKY_FRAG = `
uniform vec3 uTop;
uniform vec3 uBottom;
uniform vec3 uGlow;
varying vec3 vDir;
void main() {
  vec3 d = normalize( vDir );
  float h = clamp( d.y * 0.5 + 0.5, 0.0, 1.0 );
  vec3 col = mix( uBottom, uTop, pow( h, 0.85 ) );
  float lift = pow( max( 0.0, 1.0 - length( d.xy * vec2( 0.85, 1.7 ) - vec2( 0.0, 0.16 ) ) ), 2.4 );
  col += uGlow * lift * step( 0.0, -d.z ) * 0.9;
  col += uGlow * lift * 0.35;
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

export interface PodiumStats {
  drawCalls: number
  triangles: number
  /** Particle pool slots allocated. */
  particles: number
  cars: number
  pilots: number
  /**
   * THE PILOT-FIGURE CONTRACT, MEASURED.
   *
   * `soleGap` is how far the built figure's lowest point sits from its own
   * origin, in podium metres. The contract in game/podium.ts is that a figure
   * is originated at the soles of its feet, so this is 0 and the figure stands
   * on the step; anything else means it hovers or sinks, and the placement is
   * deliberately NOT fudged to hide it. tools/probe-podium.mjs fails on it.
   *
   * `faceY` is where the `sg_face` panel actually is above the soles, which is
   * what the face-aimed beats are aimed at (see PODIUM_FACE_Y), and `headY` is
   * the top of the figure at the apex of its hop -- the number the card
   * clearance gate is measured against.
   */
  soleGap: number
  faceY: number
  headY: number
}

export interface PodiumStage {
  readonly group: THREE.Group
  /** The beat the camera is on, for the probe and for the HUD's own timing. */
  readonly frame: PodiumFrame
  readonly stats: PodiumStats
  /**
   * The top of the champion's head at the APEX OF THEIR HOP, world metres.
   *
   * Published because it is the only thing that can answer "is the standings
   * card parked on the winner's face" -- see the card-clearance gate in
   * tools/probe-podium.mjs, which projects this through the live camera. The
   * scene knows how tall the figure is and where it stands; the DOM does not,
   * and the number is measured off the built figure rather than assumed (see
   * PodiumStats.headY), so a taller pilot moves the gate with it.
   */
  readonly champHead: THREE.Vector3
  /**
   * One frame. `t` is seconds since the podium opened, which is the clock the
   * camera plan is written against; `dt` drives the animation.
   */
  update(dt: number, t: number, camera: THREE.PerspectiveCamera): void
  dispose(): void
}

/**
 * A still racer state.
 *
 * VehicleVisual.update takes a RacerState because in the game there always is
 * one. Here there is not, so this is a parked car: no speed, no drift, no
 * boost, wheels still, body level. ui/garagePreview.ts does exactly the same
 * thing for the same reason.
 */
function parked(chassisId: string, pilotId: string, yaw: number): RacerState {
  return {
    id: 0, chassisId, pilotId, isAI: true, isLocal: false, aiSkill: 0,
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 },
    fwd: { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) }, up: { x: 0, y: 1, z: 0 },
    yaw, yawRate: 0, vertVel: 0, altitude: 0, grounded: true,
    driftSide: 0, driftCharge: 0, driftTier: 0, driftInward: 0, chainStacks: 0,
    boostTime: 0, boostMag: 0, boostSource: 'none',
    lift: 0, liftActive: false, airTime: 0,
    spinTime: 0, stunTime: 0, invincibleTime: 0, immuneTime: 0,
    slowTime: 0, respawnTime: 0, offTrackTime: 0,
    item: null, itemCharges: 0, charges: 0,
    lap: 0, position: 1, splineS: 0, totalS: 0, lateral: 0,
    finished: true, finishTime: 0, bestLap: 0, lapTimes: [],
    windPush: 0, events: [],
  } as unknown as RacerState
}

class PodiumStageImpl implements PodiumStage {
  readonly group = new THREE.Group()
  readonly frame = makePodiumFrame()
  readonly stats: PodiumStats

  private readonly cars: VehicleVisualEx[] = []
  private readonly carStates: RacerState[] = []
  private readonly pilots: PilotFigure[] = []
  private readonly pool: ParticlePool
  private readonly disposables: { dispose(): void }[] = []
  private readonly reduced: boolean
  private readonly qScale: number

  private time = 0
  /** Fractional confetti carry, so a low rate is not lost to rounding. */
  private confettiCarry = 0
  /** The pre-roll below has not run yet. */
  private primed = false
  /** Seconds until the next firework shell. */
  private nextShell = 0.12
  /** Reused scratch, so the per-frame path allocates nothing. */
  private readonly lens: PodiumLens = {
    x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: -1, tanV: 0.4, aspect: 16 / 9, reach: 10,
  }
  private readonly burst: PodiumBurst = {
    x: 0, y: 0, z: 0, dist: 0, sx: 0, sy: 0, rise: 0,
  }
  /** Where the face-aimed beats aim: the figure's own face, measured. */
  private faceY = PODIUM_FACE_Y
  /** Top of the champion at the top of their hop, world metres. */
  private headTop = 0
  readonly champHead = new THREE.Vector3()

  constructor(
    scene: THREE.Scene, cast: PodiumCast, quality: RenderQuality, reduceMotion: boolean,
  ) {
    this.reduced = reduceMotion
    this.qScale = quality.particleScale
    this.group.name = 'podium'
    const shadows = quality.shadows

    // ---- ground -------------------------------------------------------
    // 200 m rather than 60: at 60 the disc's own edge was the horizon line in
    // every wide beat, a hard black-to-blue seam four metres behind the
    // podium. At 200 the seam lands where a horizon belongs.
    const groundGeo = new THREE.CircleGeometry(200, 56)
    groundGeo.rotateX(-Math.PI / 2)
    const groundMat = new THREE.MeshStandardMaterial({
      // Not black. The first pass used 0x0d1220 and the bottom third of every
      // frame was dead pixels; this takes enough of the two kicker lights to
      // put the podium ON something.
      color: 0x1a2440, roughness: 0.68, metalness: 0.10,
    })
    const ground = new THREE.Mesh(groundGeo, groundMat)
    ground.receiveShadow = shadows
    this.group.add(ground)
    this.disposables.push(groundGeo, groundMat)

    // ---- sky ----------------------------------------------------------
    const skyGeo = new THREE.SphereGeometry(620, 24, 16)
    const skyMat = new THREE.ShaderMaterial({
      uniforms: {
        uTop: { value: new THREE.Color(0x05070f) },
        uBottom: { value: new THREE.Color(0x12162c) },
        uGlow: { value: new THREE.Color(0x2b3f7a) },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
    })
    const sky = new THREE.Mesh(skyGeo, skyMat)
    sky.frustumCulled = false
    sky.renderOrder = -1
    this.group.add(sky)
    this.disposables.push(skyGeo, skyMat)

    // ---- the block ----------------------------------------------------
    const blocks: THREE.BufferGeometry[] = []
    const strips: THREE.BufferGeometry[] = []
    // A plinth under all three so the steps read as one object rather than as
    // three crates that happen to be adjacent. DERIVED from the outer step
    // rather than from "three steps plus a bit": at 4.0 m lanes the two
    // spellings happened to agree to within 10 cm, so widening the lanes left
    // the steps hanging 50 cm over the ends of their own base.
    const halfSpan = Math.max(STEP_X[1], STEP_X[2], -STEP_X[1], -STEP_X[2]) + STEP_HALF_W
    blocks.push(box(halfSpan * 2 + 0.7, 0.24, STEP_D + 0.5, 0, 0.12, -STEP_D / 2))
    for (let i = 0; i < 3; i++) {
      const h = STEP_Y[i]
      blocks.push(box(STEP_HALF_W * 2, h, STEP_D, STEP_X[i], h / 2, -STEP_D / 2))
      // A lip at the top, which is what gives a step an edge to catch the key
      // light on. Without it a box at this scale reads as a flat card.
      blocks.push(box(STEP_HALF_W * 2 + 0.18, 0.09, STEP_D + 0.18, STEP_X[i], h + 0.045, -STEP_D / 2))
    }
    const blockGeo = merged(blocks)
    const blockMat = new THREE.MeshStandardMaterial({
      color: 0x1b2540, roughness: 0.55, metalness: 0.25,
    })
    const blockMesh = new THREE.Mesh(blockGeo, blockMat)
    blockMesh.castShadow = shadows
    blockMesh.receiveShadow = shadows
    this.group.add(blockMesh)
    this.disposables.push(blockGeo, blockMat)

    // ---- medal strips and place numbers -------------------------------
    // One emissive mesh per medal colour: three draw calls would be three
    // materials, so instead the three faces share one additive material and
    // the colour comes from geometry groups. Simpler still: one mesh per
    // colour is only three meshes and they are eleven boxes each, so the
    // honest cheap answer is one merged mesh with vertex colours.
    const stripCols: number[] = []
    for (let i = 0; i < 3; i++) {
      const h = STEP_Y[i]
      // PROUD OF THE FACE, not flush with it. A step is a box spanning
      // z = -STEP_D..0, so a plate at z = 0 is coplanar with its front and
      // z-fights; at -0.001 it is INSIDE the box and invisible, which is what
      // the first staging shipped and why no photograph had a 1, 2 or 3 in it.
      const face = 0.035
      // EVERYTHING SITS HIGH ON THE FACE, and that is the measurement rather
      // than the taste. A car is parked 5.2 m in front of this face and is
      // 1.4-1.6 m tall, so from the two low beats the sightline over its roof
      // meets the step at about y = 0.8: anything painted below that is
      // painted behind a car. The first pass put the number at h * 0.44, which
      // is 1.14 m on the champion's own step, and no photograph of the podium
      // had a 1 in it.
      const parts: THREE.BufferGeometry[] = [
        // The light bar, tucked just under the lip.
        box(STEP_HALF_W * 2 - 0.44, 0.09, 0.06, STEP_X[i], h - 0.16, face),
        // NO CORNER STRIPS. They were tried, to give a grey box an edge, and
        // they closed a rectangle around the number: photographed, the
        // champion's "1" read as a picture frame with a mark in it. The lip
        // and the key light give the block its edge; the face carries one
        // glowing thing and it is the place.
        // Clear of the bar rather than tucked under it: at h - 0.66 the top
        // stroke of a 2 merged with the bar above it into one shape and the
        // number stopped being legible.
        ...digit(i + 1, STEP_X[i], h - 0.78, face, 0.64),
      ]
      for (const p of parts) {
        const n = (p.getAttribute('position') as THREE.BufferAttribute).count
        for (let k = 0; k < n; k++) stripCols.push(MEDAL[i])
      }
      strips.push(...parts)
    }
    const stripGeo = merged(strips)
    {
      const n = (stripGeo.getAttribute('position') as THREE.BufferAttribute).count
      const col = new Float32Array(n * 3)
      for (let i = 0; i < n; i++) {
        _c.setHex(stripCols[i] ?? 0xffffff, THREE.SRGBColorSpace)
        col[i * 3] = _c.r * STRIP_GAIN
        col[i * 3 + 1] = _c.g * STRIP_GAIN
        col[i * 3 + 2] = _c.b * STRIP_GAIN
      }
      stripGeo.setAttribute('color', new THREE.BufferAttribute(col, 3))
    }
    // OVER 1.0 ON PURPOSE. `toneMapped: false` writes the colour straight to
    // the buffer, so at a gain of 1 these are merely light grey/gold shapes
    // that the composite's bloom threshold never sees. At 2.3 they are the
    // brightest thing on the block and they glow, which is what makes a 1 read
    // as a number rather than as a panel line.
    const stripMat = new THREE.MeshBasicMaterial({
      vertexColors: true, toneMapped: false,
    })
    const stripMesh = new THREE.Mesh(stripGeo, stripMat)
    this.group.add(stripMesh)
    this.disposables.push(stripGeo, stripMat)

    // ---- the cars and the pilots --------------------------------------
    for (const e of cast.steps) {
      const i = e.step - 1
      const car = createVehicleVisual(e.chassisId, e.pilotId, quality)
      // THE SEAT IS EMPTY, because the driver is standing on the step three
      // metres behind it. Without this the same head is on screen twice.
      car.setPilotVisible(false)
      car.autoPlace = false
      car.group.position.set(STEP_X[i], -chassisGroundY(e.chassisId), CAR_Z[i])
      car.group.rotation.set(0, CAR_YAW[i], 0)
      this.group.add(car.group)
      this.cars.push(car)
      this.carStates.push(parked(e.chassisId, e.pilotId, CAR_YAW[i]))

      const fig = createPilotFigure(e.pilotId, quality, i)
      fig.energy = reduceMotion ? 0 : 1
      // The winner is the most pleased with themselves, which is a two-line
      // way of saying the top step should read differently from the bottom.
      fig.joy = e.step === 1 ? 1 : e.step === 2 ? 0.82 : 0.72
      const holder = new THREE.Group()
      // ON THE STEP. Not "on the step plus a hand-fitted lift" -- a figure is
      // originated at the soles of its feet, so the step's top surface IS the
      // placement. See the contract note beside PILOT_SCALE in game/podium.ts,
      // and `soleGap` below, which measures whether it is being honoured
      // instead of papering over it.
      holder.position.set(STEP_X[i], STEP_Y[i], -STEP_D * 0.45)
      holder.scale.setScalar(PILOT_SCALE)
      holder.add(fig.group)
      this.group.add(holder)
      this.pilots.push(fig)
    }

    // ---- lights -------------------------------------------------------
    const key = new THREE.DirectionalLight(0xfff0d8, 2.60)
    key.position.set(7, 14, 11)
    if (shadows) {
      key.castShadow = true
      key.shadow.mapSize.set(quality.tier === 'high' ? 1024 : 512, quality.tier === 'high' ? 1024 : 512)
      const sc = key.shadow.camera
      sc.left = -14; sc.right = 14; sc.top = 14; sc.bottom = -8
      sc.near = 1; sc.far = 46
      sc.updateProjectionMatrix()
      key.shadow.bias = -0.0008
      key.shadow.normalBias = 0.03
    }
    this.group.add(key)
    // FILL WAS TOO STRONG AT 1.20/0.45 and photographed flat: the podium read
    // as light grey card and the emissive furniture stopped standing out from
    // it. Dropped until the steps have a lit face and a shaded one, which is
    // also what lets the glowing place numbers be the brightest thing on the
    // block.
    this.group.add(new THREE.HemisphereLight(0x2b3c68, 0x0f1424, 0.80))
    this.group.add(new THREE.AmbientLight(0x3d4c74, 0.28))
    if (quality.tier !== 'low') {
      // Two coloured kickers from the wings. They are what puts an edge on the
      // dark side of a chassis, which the fresnel rim in vehicles.ts can only
      // do where there is something for it to catch.
      // Further out and softer than the first pass (26 at x = 7.5), which
      // blew the near flank of whichever chassis was closest to white on the
      // low beats. Nine metres out is past the outer cars, so both kickers
      // rake ACROSS the row instead of sitting on top of one car.
      const warm = new THREE.PointLight(0xffc36b, 20, 30, 2)
      warm.position.set(-9.5, 4.2, 8.5)
      const cool = new THREE.PointLight(0x5ad2ff, 18, 30, 2)
      cool.position.set(9.5, 4.2, 8.5)
      this.group.add(warm)
      this.group.add(cool)
    }

    // ---- particles ----------------------------------------------------
    // Sized off the same tier scale the race uses, so a phone that dropped to
    // `low` mid-race does not get handed a 4000-slot pool at the finale.
    const slots = Math.max(700, Math.round(3000 * quality.particleScale))
    this.pool = new ParticlePool(slots, rnd)
    this.group.add(this.pool.mesh)

    scene.add(this.group)

    // COUNTS WHAT WOULD BE DRAWN, not what was built. Every vehicle carries
    // four LOD rigs and only one of them is visible, so a plain traverse
    // reports roughly three times the real figure -- which is exactly the kind
    // of number that gets quoted in a report and is wrong. The probe prints
    // the renderer's own counters beside these as the check.
    let tris = 0
    let calls = 0
    this.group.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh || !m.geometry) return
      let vis = m.visible
      for (let p = m.parent; vis && p; p = p.parent) vis = p.visible
      if (!vis) return
      calls++
      const g = m.geometry
      const idx = g.getIndex()
      const pos = g.getAttribute('position') as THREE.BufferAttribute | undefined
      const verts = idx ? idx.count : (pos ? pos.count : 0)
      const inst = (g as THREE.InstancedBufferGeometry).instanceCount
      tris += Math.floor(verts / 3) * (inst && inst > 0 && inst < 1e6 ? inst : 1)
    })

    // ---- the figure, MEASURED rather than assumed -----------------------
    //
    // Two numbers come out of the built pilot and both of them are somebody
    // else's to change: where its feet are (the placement contract) and where
    // its face is (what the CHAMPION beat is aimed at). Reading them off the
    // object means the podium follows a figure that grows legs instead of
    // being re-measured against it by hand -- which is the failure PILOT_LIFT
    // was, a number fitted once to an origin nobody owned.
    //
    // Measured in WORLD metres, through the holder that has just been placed,
    // so what comes out is directly comparable with STEP_Y and with the shot
    // list -- no second copy of the scale arithmetic to get out of step.
    let soleGap = 0
    let faceY = PODIUM_FACE_Y
    let headY = STEP_Y[0]
    const champ = this.pilots.length ? this.pilots[0].group : null
    if (champ) {
      this.group.updateMatrixWorld(true)
      const bb = new THREE.Box3().setFromObject(champ)
      soleGap = bb.min.y - STEP_Y[0]
      headY = bb.max.y
      // The face panel is a named node in the rig (RIG_NODES.face), so this is
      // the actual thing the beat wants to be level with rather than a guess
      // at some fraction of the figure's height. The fallback is only for a
      // figure built without one, which no shipped LOD is.
      let facePanel: THREE.Object3D | null = null
      champ.traverse((o) => { if (o.name === RIG_NODES.face) facePanel = o })
      if (facePanel) {
        const fb = new THREE.Box3().setFromObject(facePanel)
        faceY = (fb.min.y + fb.max.y) * 0.5
      } else {
        faceY = STEP_Y[0] + (bb.max.y - STEP_Y[0]) * 0.78
      }
    }
    this.faceY = faceY
    // PLUS THE HOP. The figure leaves the step: PilotFigure's jump is a 4x(1-x)
    // arc scaled by 0.62 in figure units, so at PILOT_SCALE the top of the
    // champion's head is this much higher than the top of the standing figure
    // for a fifth of every hop cycle. The card-clearance gate has to be
    // measured against the apex, not against the rest pose -- the shipped
    // photograph that put the card on the champion's head was taken mid-hop.
    this.headTop = headY + (reduceMotion ? 0 : 0.62 * PILOT_SCALE)
    this.champHead.set(STEP_X[0], this.headTop, -STEP_D * 0.45)

    this.stats = {
      drawCalls: calls,
      triangles: tris,
      particles: slots,
      cars: this.cars.length,
      pilots: this.pilots.length,
      soleGap: +soleGap.toFixed(4),
      faceY: +faceY.toFixed(3),
      headY: +this.headTop.toFixed(3),
    }
  }

  update(dt: number, t: number, camera: THREE.PerspectiveCamera): void {
    const step = dt > 0.1 ? 0.1 : dt > 0 ? dt : 0
    this.time += step

    // ---- camera -------------------------------------------------------
    //
    // THE SHOT LIST IS WRITTEN FOR 16:9 AND THE PHONE IS NOT 16:9.
    //
    // A PerspectiveCamera's `fov` is VERTICAL, so a portrait viewport keeps the
    // vertical framing and throws the horizontal away: at 412x915 the same
    // 42-degree shot that frames an eleven-metre podium on a desktop frames
    // three and a half metres of it, and the phone photograph was one gold ball
    // and nothing else. Every beat here is composed ACROSS -- three steps, three
    // cars, a row eleven metres wide -- so width is the axis that has to be
    // preserved and height is the one that may give.
    //
    // Two stages, because one is not enough. Opening the lens to hold the width
    // reaches 113 degrees on a portrait phone, which is a fisheye; so the fov
    // opens to a hard cap and whatever width is still missing is bought by
    // PUSHING THE CAMERA BACK along its own view vector. The result is the same
    // horizontal extent on every aspect, with no beat re-authored per device.
    const f = podiumFrameAt(t, this.reduced, this.frame, this.faceY)
    const p = f.pose
    const dist = Math.max(0.5, Math.hypot(p.x - p.tx, p.y - p.ty, p.z - p.tz))
    const halfH = Math.tan((p.fov * Math.PI) / 360)
    const asp = camera.aspect > 0.05 ? camera.aspect : REF_ASPECT
    // What this beat frames on a 16:9 screen, in metres, and what it actually
    // needs. Never ask for more than the subject: see SUBJECT_HALF_W.
    const needW = Math.min(halfH * REF_ASPECT * dist, SUBJECT_HALF_W)
    const haveW = halfH * asp * dist
    let fov = p.fov
    let pull = 1
    let useHalfHFinal = halfH
    if (haveW < needW) {
      const needHalfH = needW / (asp * dist)
      const capHalfH = Math.tan((FOV_CAP * Math.PI) / 360)
      const useHalfH = needHalfH > capHalfH ? capHalfH : needHalfH
      pull = needHalfH / useHalfH
      fov = (Math.atan(useHalfH) * 360) / Math.PI
      useHalfHFinal = useHalfH
    }
    camera.position.set(
      p.tx + (p.x - p.tx) * pull,
      p.ty + (p.y - p.ty) * pull,
      p.tz + (p.z - p.tz) * pull,
    )
    /**
     * AND THE CARD IS PART OF THE COMPOSITION.
     *
     * The podium card takes the top of the frame on every layout, and on a
     * landscape phone -- 412 px tall -- it takes the top THIRD. Measured off a
     * 915x412 photograph at the end of the reveal: the champion's head was
     * behind the standings panel. The subject is centred on the camera's aim,
     * so raising the AIM drops the subject, and a shift of a seventh of the
     * frame height puts it in the middle of the band the card leaves rather
     * than the middle of the frame.
     *
     * Keyed off aspect because that is what the scene can see: past 2.0 is a
     * phone on its side, under 1.0 is a phone upright (where the card is a
     * smaller share of a much taller frame, so the bias is smaller). A desktop
     * sits between the two and needs neither.
     */
    const bias = asp > 2.0 ? 0.17 : asp < 1.0 ? 0.09 : 0
    const aimY = p.ty + bias * useHalfHFinal * dist * pull
    camera.lookAt(p.tx, aimY, p.tz)
    if (Math.abs(camera.fov - fov) > 1e-4) {
      camera.fov = fov
      camera.updateProjectionMatrix()
    }

    // ---- the lens the fireworks are aimed through ---------------------
    //
    // BUILT FROM THE CAMERA THAT WAS JUST POSITIONED, not from the authored
    // pose. Everything above -- the portrait fov opening, the pull-back, the
    // card bias -- changes which part of the world is on screen, so a shell
    // solved against the 16:9 pose would be back to being in frame on a
    // desktop and nowhere on a phone. This is the real frustum.
    {
      const l = this.lens
      l.x = camera.position.x; l.y = camera.position.y; l.z = camera.position.z
      const dx = p.tx - l.x, dy = aimY - l.y, dz = p.tz - l.z
      const dd = Math.max(1e-4, Math.hypot(dx, dy, dz))
      l.fx = dx / dd; l.fy = dy / dd; l.fz = dz / dd
      l.tanV = Math.tan((camera.fov * Math.PI) / 360)
      l.aspect = asp
      l.reach = dd
    }

    // ---- cast ---------------------------------------------------------
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i]
      const d = camera.position.distanceTo(c.group.position)
      c.update(this.carStates[i], step, d)
    }
    for (const p of this.pilots) p.update(step)

    // ---- particles ----------------------------------------------------
    this.pool.beginFrame(
      this.time, camera.position.x, camera.position.y, camera.position.z,
    )
    // CONFETTI PRIMES FIRST, and the order is a budget decision rather than a
    // taste one: the pool lets one frame claim a quarter of its slots (750 at
    // `high`, 337 at `low`) and the two pre-rolls together are the only frame
    // that comes near it -- 210 scraps and one shell is ~490. Fireworks first
    // would have spent the budget before the confetti was written and the
    // opening frame would have had an empty sky, which is the exact bug
    // primeConfetti exists to fix.
    if (!this.primed) { this.primed = true; this.primeConfetti(); this.primeFireworks() }
    // FIREWORKS FIRST. A salvo is the only thing here that can claim a large
    // share of one frame's pool budget, and confetti is a steady two or three
    // scraps a frame that can be written out of whatever is left. The other
    // order meant the confetti emitter had to guess how much to reserve, which
    // is what the old `budgetLeft - 130` was.
    this.emitFireworks(step)
    this.emitConfetti(step)
    this.pool.flush()
  }

  /**
   * THE SKY ALREADY HAS CONFETTI IN IT ON FRAME ONE.
   *
   * Confetti is dropped from thirteen metres up and takes about three seconds
   * to reach the podium, so a scene that starts emitting at t = 0 spends its
   * entire opening beat with a clean empty sky -- and the opening beat is the
   * reveal, the one frame most likely to be the screenshot somebody sees.
   *
   * The fix is free because the shader already supports it: `delay` stamps a
   * birth time, and a NEGATIVE delay stamps one in the PAST, so a particle
   * written now can be born four seconds ago and arrive already halfway down.
   * No second code path, no catch-up integration, no first-frame spike.
   */
  private primeConfetti(): void {
    const n = Math.round((this.reduced ? 60 : 210) * this.qScale)
    for (let i = 0; i < n; i++) {
      this.pool.delay = -rnd() * (this.reduced ? 6.5 : 4.6)
      this.dropConfetti()
    }
    this.pool.delay = 0
  }

  /**
   * CONFETTI, heavily.
   *
   * Dropped from a box well above and slightly in front of the block, so it is
   * falling THROUGH the shot rather than appearing in it. Beads rather than
   * sprites: K_BEAD is a filled disc with a silhouette and an off-centre
   * specular, which is what makes a scrap of foil read as an object catching
   * the light; a sprite at this size is a smudge. The near-fade window on
   * beads (2.4-8.5 m, measured in the shader) is doing real work here too --
   * the camera flies through the fall on beats 3 and 5.
   *
   * Low gravity and heavy drag on purpose: a real scrap of foil has almost no
   * terminal velocity, and confetti that falls like gravel reads as debris.
   */
  private emitConfetti(dt: number): void {
    // 130/s at high. Steady state at a 6.2 s life is ~810 alive, a quarter of
    // a 3000-slot pool; the fireworks hold about 1,830 of the rest. Down from
    // 150: with the fireworks finally reading, 150 scraps a second put enough
    // similar-sized dots across the sky that a burst had to compete with them
    // for the eye. The confetti is still "heavy" -- eight hundred of them.
    const rate = (this.reduced ? 38 : 130) * this.qScale
    this.confettiCarry += rate * dt
    let n = Math.floor(this.confettiCarry)
    this.confettiCarry -= n
    const left = this.pool.budgetLeft
    if (n > left) n = left > 0 ? left : 0
    for (let i = 0; i < n; i++) this.dropConfetti()
  }

  /** One scrap. Split out so the pre-roll above can write the same thing with
   *  a birth in the past. */
  private dropConfetti(): void {
    const c = CONFETTI[(rnd() * CONFETTI.length) | 0]
    // THE BOX IS BIGGER THAN THE PODIUM AND REACHES PAST THE CAMERA.
    // Measured from the first staging: a 26 m x 16 m box centred on the block
    // put the fall entirely BEHIND the lens on the two beats that sit out at
    // z = 12-17, so the photographs had a clean empty foreground. 44 m across
    // and from z = -12 to +22 puts confetti between the camera and the podium
    // on every beat, which is what makes it read as falling THROUGH the scene
    // rather than as a texture behind it.
    const x = rnd2() * 22
    const z = -12 + rnd() * 34
    this.pool.spawn(
      x, 13 + rnd() * 5, z,
      rnd2() * 1.6, -1.1 - rnd() * 0.9, rnd2() * 1.2,
      c[0], c[1], c[2],
      // Slower and longer under reduced motion, so the same picture has the
      // same amount of colour in it with less of the frame moving.
      this.reduced ? 8.5 : 6.2,
      // 0.24-0.44 m. The first pass used 0.085-0.14 and photographed as dust:
      // a scrap ten metres out was three pixels on a 1440-wide frame.
      0.24 + rnd() * 0.20, 0,
      this.reduced ? -0.9 : -2.1, 0.55, K_BEAD,
    )
  }

  /**
   * FIREWORKS, AIMED THROUGH THE LENS.
   *
   * ===========================================================================
   * WHAT WAS WRONG WITH THE FIRST VERSION, because the fix is the diagnosis.
   *
   * It burst shells in a fixed slab of world space -- y 8..16, x +/-26,
   * z -26..-8 -- and photographed on all five beats it put a burst in shot
   * exactly once. Three separate failures, and they are worth naming because
   * each one is a different kind of mistake:
   *
   *   1. OUT OF FRAME. A slab fitted to one camera cannot serve five. The CARS
   *      beat looks DOWN at a row of bumpers and had none of the slab in shot,
   *      so it got no fireworks at all; CHAMPION's 40-degree lens tops out
   *      around y = 11 at that range, so half the slab burst above the picture.
   *      Fixed by solving for the burst position IN THE CAMERA'S OWN FRAME --
   *      pick a screen position and a distance, solve for the world point (see
   *      podiumSkyPoint in game/podium.ts). In frame by construction, on every
   *      beat and every aspect ratio.
   *
   *   2. TOO BIG TO BE A FIREWORK. The stars went out at 17 m/s against a drag
   *      of 1.1 for 1.7 s, which is ELEVEN METRES of travel: a 22 m ball of 88
   *      particles, seen from 30 m, is a sphere wider than the frame with one
   *      particle every ten square metres in it. That is not a burst, it is a
   *      scattering of dots -- which is exactly what the photographs show, and
   *      why the only bit of pyro anyone could see was the K_SHELL front (a
   *      4.7 m ring: the one part of a shell whose size was sane, and the "one
   *      faint white ring" in the notes). Now ~4 m of travel with 150 stars in
   *      it, and the sizes scale with the distance the shell was placed at, so
   *      a burst subtends the same angle on every beat. See `k` below.
   *
   *   3. NO EVENT. Every shell appeared already-burst. A firework is a rising
   *      light, a pause, and then the burst; without the rise there is nothing
   *      for the burst to be the payoff of. The pool has `delay` for exactly
   *      this and the old code already used it for the crackle, so the whole
   *      rise is free: write the comet, its trail, the burst and the crackle in
   *      one call at four different birth times, and the CPU never comes back.
   *
   * ===========================================================================
   * WHAT ONE SHELL COSTS: 278 slots at `high`, all written in a single frame
   * and spread over ~2 s of playback (a delayed particle holds its slot from
   * the moment it is written, not from the moment it appears -- see
   * ParticlePool.delay). At the 4.3 shells a second this fires, that is about
   * 1,830 slots held against confetti's 810, in a pool of 3,000. A salvo is the
   * busiest frame at 556 writes against a 750-slot frame budget, and the tiers
   * scale together: `low` is 256 against 337.
   */
  private emitFireworks(dt: number): void {
    this.nextShell -= dt
    if (this.nextShell > 0) return
    // Under reduced motion one soft bloom every 2.4 s with no streaks at all --
    // a firework is a strobe, and a strobe is the single most literal thing the
    // setting exists to remove.
    this.nextShell = this.reduced ? 2.4 : 0.22 + rnd() * 0.18
    this.shell()
    // A SALVO, sometimes. Evenly spaced shells read as a metronome; two
    // together and then a gap reads as a display. The second one is forced to
    // the other side of the frame (podiumSkyPoint's `c` dice picks the side),
    // so a salvo is two bursts framing the podium rather than two in a heap.
    if (!this.reduced && rnd() < 0.34) this.shell()
  }

  /**
   * One shell, from the lens outwards.
   *
   * `at0` shifts every birth in it, which is what lets primeFireworks() write
   * shells that were launched BEFORE the podium opened. Every delay below is
   * relative to it rather than absolute, so the four beats of a shell -- rise,
   * burst, report -- cannot come apart.
   */
  private shell(at0 = 0): void {
    const b = podiumSkyPoint(this.lens, rnd(), rnd(), rnd(), this.burst)
    const col = FIREWORK[(rnd() * FIREWORK.length) | 0]
    const q = this.qScale

    if (this.reduced) {
      // A bloom that grows and fades, and nothing that flickers. Still framed
      // through the lens -- a calm player should get fireworks in the picture,
      // not fireworks somewhere off the top of it.
      this.pool.delay = at0
      this.pool.spawn(
        b.x, b.y, b.z, 0, 0, 0, col[0], col[1], col[2], 2.6, 2.2, 2.6, 0, 0, K_SPRITE,
      )
      this.pool.delay = 0
      return
    }

    // ---- 1. THE RISE ---------------------------------------------------
    //
    // The shell is a comet with a trail, launched `rise` metres below the burst
    // point and timed to arrive. Everything about it is solved rather than
    // dialled: the launch speed is whatever reaches the burst point in RISE_T
    // under RISE_G, so changing the height or the timing cannot desynchronise
    // the rise from the burst it belongs to.
    const RISE_T = 0.55
    const RISE_G = -5.0
    const rise = b.rise
    const lx = b.x, ly = b.y - rise, lz = b.z
    const vy = rise / RISE_T - 0.5 * RISE_G * RISE_T
    // A little lateral drift so a volley is not a set of parallel vertical
    // lines, and so the burst is not dead above its own launch point.
    const vx = rnd2() * 0.9, vz = rnd2() * 0.9
    this.pool.delay = at0
    if (rise > 0.5) {
      // The comet head: hot white core under the shell's own colour, so it
      // reads as burning rather than as a coloured dot.
      this.pool.spawn(
        lx, ly, lz, vx, vy, vz, col[0] * 0.8, col[1] * 0.8, col[2] * 0.8,
        RISE_T, 0.85, -0.25, RISE_G, 0, K_SPRITE,
      )
      this.pool.spawn(
        lx, ly, lz, vx, vy, vz, WHITE[0], WHITE[1], WHITE[2],
        RISE_T, 0.42, -0.2, RISE_G, 0, K_SPRITE,
      )
      // ...and the trail. Written NOW at the positions the comet will occupy,
      // each with its birth stamped for the moment the comet gets there. Nine
      // motes is enough to read as a continuous streak at these distances; the
      // point of the trail is the line it draws, not its own detail.
      const n = Math.max(4, Math.round(9 * q))
      for (let i = 1; i <= n; i++) {
        const ta = (i / (n + 1)) * RISE_T
        this.pool.delay = at0 + ta
        this.pool.spawn(
          lx + vx * ta, ly + vy * ta + 0.5 * RISE_G * ta * ta, lz + vz * ta,
          rnd2() * 1.1, -0.8 - rnd() * 1.2, rnd2() * 1.1,
          col[0] * 0.55, col[1] * 0.55, col[2] * 0.55,
          0.34 + rnd() * 0.22, 0.26, -0.10, -2.0, 0.9, K_SPRITE,
        )
      }
    }

    // ---- 2. THE BURST --------------------------------------------------
    //
    // EVERY BURST IS THE SAME SIZE ON SCREEN, whatever beat it belongs to.
    //
    // That is what `k` is. A shell fired for the CARS beat sits 12 m from the
    // lens and one fired for HOLD sits 30, and a fixed world-space burst is
    // either a wall of light at the near end or a smudge at the far end -- the
    // shipped version was tuned at one distance and photographed at five.
    // Scaling the stars' speed and size with the distance the placement chose
    // makes the burst a constant ANGLE instead: roughly a third of the frame
    // across, with stars about 10 px wide, everywhere.
    const k = b.dist / 24
    const at = at0 + (rise > 0.5 ? RISE_T : 0)
    this.pool.delay = at
    // The flash. SMALL. A K_SPRITE is a gaussian over its whole quad, so a big
    // one is a big soft disc of white and nothing else -- at size 3.2 it was a
    // 190 px blob sitting exactly where the burst's structure should be, and
    // it is most of what "one diffuse yellow glow" in the notes was.
    this.pool.spawn(
      b.x, b.y, b.z, 0, 0, 0, WHITE[0], WHITE[1], WHITE[2],
      0.16, 1.6 * k, 4.0 * k, 0, 0, K_SPRITE,
    )
    // The break. A K_SHELL's lit band runs from 0.16 to 0.5 of its quad, which
    // is a THICK annulus rather than a hoop, so it only works small and brief:
    // this is the flash of the shell opening, not a shockwave. It was the only
    // part of the old burst anybody could see, and being the only visible part
    // is what made it read as a lens artifact rather than as a firework.
    this.pool.spawn(
      b.x, b.y, b.z, 0, 0, 0, col[0], col[1], col[2],
      0.30, 0.5 * k, 26.0 * k, 0, 0, K_SHELL,
    )
    // The FRONT: a thin expanding hoop that reaches the stars' own radius as
    // they do. K_RING's lit band sits at 0.38 of its quad and is narrow, which
    // is what the K_SHELL above is not -- the two together are a hard break
    // followed by a ring opening out through the stars.
    this.pool.spawn(
      b.x, b.y, b.z, 0, 0, 0, col[0], col[1], col[2],
      0.45, 0.5 * k, 22.0 * k, 0, 0, K_RING,
    )
    // The stars. 150 of them, and the count is not decoration: what makes a
    // ball of additive points read as a firework is the fraction of its own
    // disc they cover, and BOTH failures were that fraction. The shipped
    // version put 88 stars over an eleven-metre radius -- about 4%, which
    // photographed as "scattered coloured dots". An over-correction put 104
    // over 4.3 m, which is dense enough to saturate: additive sprites at that
    // coverage clip to white, the post chain blooms the clipped patch, and the
    // photograph is one soft glow with a ring round it -- structurally a lens
    // flare. ~15% over a 4 m ball is an object made of points.
    //
    // ONE HUE PER SHELL is the other half of not reading as confetti. The
    // confetti is five colours mixed; a burst is one colour with a white core,
    // which is what separates a firework from a handful of falling scraps at
    // the same pixel size.
    this.pool.burst(
      b.x, b.y, b.z, 0, 0, 0,
      Math.round(150 * q), 15.5 * k, 1.0,
      col, 1.00, 1.15, 0.32 * k, K_SPRITE, -3.0 * k, 3.1,
    )
    // An inner, slower core, in white. A single shell of stars is a hollow
    // sphere and photographs with a hole in the middle of it.
    this.pool.burst(
      b.x, b.y, b.z, 0, 0, 0,
      Math.round(44 * q), 6.0 * k, 1.0,
      WHITE, 0.60, 0.85, 0.26 * k, K_SPRITE, -2.6 * k, 3.4,
    )
    // THE STREAK LAYER, and it is deliberately the SMALL half of the burst.
    //
    // K_SPARK draws a velocity-stretched dash, which is what a firework star
    // really looks like, and the sprite layers above are what gives the burst
    // its volume. The split is a composition choice, not a workaround.
    //
    // IT USED TO BE A WORKAROUND. While this scene was being built, K_SPARK
    // rendered nothing at all -- not under the probe, not anywhere -- because
    // the spark branch of the vertex shader laid its quad out with a
    // left-handed basis, so every spark wound backwards and a FrontSide
    // material culled all of them. The layer below was sized as "the part a
    // real GPU adds", on the assumption the probe was lying. The probe was
    // not lying; the shader was broken, for every spark in the game. See the
    // note in render/particles.ts, and tools/probe-kinds.mjs, which now
    // photographs every kind so no kind can be invisible again.
    //
    // Thirty-six is now a number chosen because that is how many streaks this
    // burst wants, and it can be retuned against a photograph like anything
    // else here.
    this.pool.burst(
      b.x, b.y, b.z, 0, 0, 0,
      Math.round(36 * q), 26.0 * k, 1.0,
      col, 1.0, 0.90, 0.34 * k, K_SPARK, -3.0 * k, 3.4,
    )
    // ---- 3. THE REPORT -------------------------------------------------
    // The crackle, a third of a second later. A single burst has no report,
    // and this is the beat that makes it a firework rather than a puff.
    this.pool.delay = at + 0.30
    this.pool.burst(
      b.x, b.y - 0.25 * k, b.z, 0, -0.25, 0,
      Math.round(34 * q), 11.0 * k, 1.0,
      WHITE, 0.90, 0.60, 0.22 * k, K_SPRITE, -7.0 * k, 3.0,
    )
    this.pool.delay = 0
  }

  /**
   * THE FIRST BEAT ALREADY HAS FIREWORKS IN IT.
   *
   * Same argument as primeConfetti, and the same free mechanism: a shell is
   * 2 s from launch to the end of its crackle, so a display that starts at
   * t = 0 spends the first second of its opening beat building up to itself --
   * and the opening beat is the reveal, the frame most likely to be the one
   * somebody screenshots. One shell back-dated by a second, plus a second one
   * armed for the very next frame, means the sky is already mid-display on
   * frame one: one burst open and one on the way.
   *
   * ONE, NOT TWO, AND THE NUMBER IS THE FRAME BUDGET. The pool lets a frame
   * claim a quarter of its slots and the pre-rolls share that frame: at the
   * `low` tier that is 337 slots against 95 scraps of confetti and 128 per
   * shell, so a second primed shell would have been written into a budget that
   * had already run out and silently half-appeared. Arming `nextShell` instead
   * costs one frame -- a sixtieth of a second, against a 17-second scene.
   */
  private primeFireworks(): void {
    if (this.reduced) { this.shell(-0.9); return }
    this.shell(-1.15)
    this.nextShell = 0.06
  }

  dispose(): void {
    for (const c of this.cars) {
      this.group.remove(c.group)
      c.dispose()
    }
    this.cars.length = 0
    for (const p of this.pilots) p.dispose()
    this.pilots.length = 0
    this.pool.dispose()
    for (const d of this.disposables) d.dispose()
    this.disposables.length = 0
    this.group.clear()
    this.group.parent?.remove(this.group)
  }
}

/**
 * Build the podium and parent it to `scene`.
 *
 * `quality` is the tier the game is already running at, not a fresh detection:
 * a phone that stepped down to `low` during round 8 has told us what it can
 * afford and the celebration is not the place to stop listening.
 */
export function createPodiumStage(
  scene: THREE.Scene,
  cast: PodiumCast,
  quality: RenderQuality = QUALITY_PRESETS.high,
  reduceMotion = false,
): PodiumStage {
  return new PodiumStageImpl(scene, cast, quality, reduceMotion)
}

/** Reset the confetti generator. Exported so a probe can photograph the same
 *  frame twice; the game never calls it. */
export function resetPodiumSeed(): void {
  _seed = 0x1f123bb5
}

/** Pilot display name for the card, resolved here so callers do not each
 *  reach into the roster. */
export function pilotName(pilotId: string): string {
  return PILOTS_BY_ID[pilotId]?.name ?? pilotId.toUpperCase()
}
