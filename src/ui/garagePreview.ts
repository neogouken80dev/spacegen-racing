/**
 * SpaceGen Racing — the garage's live vehicle preview.
 * ---------------------------------------------------------------------------
 * The middle column of the garage used to be six stat bars and a note. This
 * puts the actual car — with the actual pilot sitting in it — above them, and
 * turns it slowly so a player picking a chassis is looking at the thing they
 * are picking rather than at a number between 1 and 10.
 *
 * WHY THIS FILE IS SHAPED LIKE THIS
 *
 * There are three separable jobs here and they are kept separable on purpose:
 *
 *   Turntable   — where the car is pointing. Pure numbers: an auto-rotate
 *                 rate, a drag, an idle timer, and the reduced-motion rule.
 *                 No DOM, no WebGL, no three.js.
 *   PreviewCore — when a GPU context is allowed to exist and what is in it.
 *                 Talks to a PreviewStage it is handed, so the whole lifecycle
 *                 is exercisable without a graphics driver.
 *   ThreeStage  — the only part that knows what a WebGLRenderer is.
 *
 * That split is not architecture for its own sake: the two rules this feature
 * has to obey — "no second context during a race" and "no auto-rotation under
 * prefers-reduced-motion" — are both invisible in a screenshot and both cheap
 * to get wrong later. Split like this they are unit-testable, and
 * tests/garagePreview.test.ts tests them.
 *
 * THE SECOND CONTEXT
 *
 * The game already owns a WebGL context for the whole session. A second one on
 * an iPhone 12 is affordable while nothing else is happening and is not
 * affordable at 60fps with eight cars on screen, so the preview's context is
 * built when the garage is shown and destroyed — renderer.dispose() AND
 * forceContextLoss(), with the canvas thrown away — when it is not. A leaked
 * context per garage visit would kill a phone after a few races, so the loop
 * that would keep one alive is stopped from exactly one place: PreviewCore.
 *
 * IF WEBGL IS NOT AVAILABLE
 *
 * The stage factory returns null rather than throwing, the core latches
 * `failed`, and the widget hides its own root. The garage then lays out
 * exactly as it did before this file existed. There is no error state to look
 * at, because a player who cannot have a preview should not be told about it
 * in the middle of picking a car.
 */
import * as THREE from 'three'
import { CHASSIS, CHASSIS_BY_ID } from '../content/chassis'
import { PILOTS } from '../content/pilots'
import { QUALITY_PRESETS, type QualityTier, type RenderQuality } from '../render/api'
import { chassisGroundY, createVehicleVisual, type VehicleVisualEx } from '../render/vehicles'
import type { RacerState } from '../sim/types'

// ---------------------------------------------------------------------------
// Turntable
// ---------------------------------------------------------------------------

/** Auto-rotation rate, radians/second. 12 deg/s: a full turn every 30s. */
export const AUTO_RATE = (12 * Math.PI) / 180
/**
 * The angle the car rests at: a three-quarter front, nose swung toward the
 * viewer's left, which shows the silhouette AND the pilot's face panel. It is
 * the opening frame for everyone, and under prefers-reduced-motion it is the
 * only frame — see Turntable.autoBlend.
 */
export const REST_YAW = -0.62
/** Seconds a released drag is held before the turntable takes over again. */
export const RESUME_DELAY = 2.6
/** Seconds the auto-rotation fades back in over, so it never restarts as a jerk. */
export const RESUME_EASE = 1.2
/**
 * Turns per drag across the full width of the preview box. Expressed against
 * the box rather than in pixels so the gesture feels the same on a 520px
 * desktop panel and a 340px phone one.
 */
export const DRAG_TURNS_PER_WIDTH = 0.75

const TAU = Math.PI * 2

function wrapAngle(a: number): number {
  let x = a % TAU
  if (x > Math.PI) x -= TAU
  else if (x < -Math.PI) x += TAU
  return x
}

/**
 * Where the car is pointing, and nothing else.
 *
 * Slow turntable, drag takes over, the drag holds where it was released, then
 * the turntable eases back in. Under prefers-reduced-motion the turntable
 * contributes nothing at all and the drag still works: a player who has asked
 * the OS for less movement has not asked to be prevented from looking at the
 * other side of the car.
 */
export class Turntable {
  yaw = REST_YAW
  reducedMotion: boolean
  private dragging = false
  /** Seconds since the last drag release. Starts "long ago" so the first
   *  frame of the first visit is already turning. */
  private idle = RESUME_DELAY + RESUME_EASE

  constructor(reducedMotion: boolean) {
    this.reducedMotion = reducedMotion
  }

  /** 0..1 — how much of the auto rate is being applied this instant. */
  get autoBlend(): number {
    if (this.reducedMotion || this.dragging) return 0
    const t = (this.idle - RESUME_DELAY) / RESUME_EASE
    return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t)
  }

  get isDragging(): boolean {
    return this.dragging
  }

  step(dt: number): void {
    if (this.dragging || dt <= 0) return
    this.idle += dt
    const blend = this.autoBlend
    if (blend > 0) this.yaw = wrapAngle(this.yaw + AUTO_RATE * blend * dt)
  }

  grab(): void {
    this.dragging = true
  }

  /** dx in CSS pixels, width the box those pixels were measured across. */
  dragBy(dx: number, width: number): void {
    if (!this.dragging) return
    this.yaw = wrapAngle(this.yaw + (dx / Math.max(1, width)) * TAU * DRAG_TURNS_PER_WIDTH)
  }

  release(): void {
    if (!this.dragging) return
    this.dragging = false
    this.idle = 0
  }

  /** Park at an exact yaw and hold it. Resets the idle timer to zero, which
   *  is what the auto-spin measures from, so the car does not creep off the
   *  angle between being set and being photographed. */
  park(yaw: number): void {
    this.dragging = false
    this.yaw = wrapAngle(yaw)
    this.idle = 0
  }
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/** Everything the core needs from a renderer, and nothing more. */
export interface PreviewStage {
  /** Build or rebuild the car with this pilot in it. */
  setVehicle(chassisId: string, pilotId: string, tier: QualityTier): void
  /** Advance the idle animation by dt and draw the car at this yaw. */
  render(dt: number, yaw: number): void
  /** The host box changed size. */
  resize(): void
  /** The OS preference changed under us. Optional: only a stage that draws
   *  something flicker-prone has anything to do about it. */
  setReducedMotion?(on: boolean): void
  /** Draw cost, for the probe and for anyone auditing the second context. */
  stats?(): PreviewStats
  dispose(): void
}

/** What the second context is actually costing, measured rather than argued. */
export interface PreviewStats {
  /** LOD level in use, 0 (best) to 3. A phone should not be on 0. */
  lod: number
  /** Draw calls and triangles in the last frame. */
  calls: number
  tris: number
  /** Rolling mean of the time render() spends, in milliseconds. */
  ms: number
  /** Drawing-buffer size, which is what the cost is really a function of. */
  bw: number
  bh: number
}

/**
 * When a GPU context may exist, and what is in it.
 *
 * `live` is the whole safety property this class exists for: it is true only
 * between a show() and the hide() that follows it, and every path that could
 * leave it true — a race starting, the front end being disposed, WebGL
 * failing — goes through setVisible(false) or dispose().
 */
export class PreviewCore {
  private stage: PreviewStage | null = null
  private chassisId: string
  private pilotId: string
  private tier: QualityTier
  private visible = false
  private pageHidden = false
  /** Selection changed since the stage was last told about it. */
  private dirty = true
  /** WebGL could not be had. Latched: never retried, never surfaced. */
  failed = false
  /** Frames actually drawn. Diagnostics, and what tools/probe-garage.mjs
   *  waits on instead of the wall clock. */
  frames = 0

  readonly turntable: Turntable

  constructor(
    private readonly makeStage: () => PreviewStage | null,
    opts: { chassisId: string; pilotId: string; tier: QualityTier; reducedMotion: boolean },
  ) {
    this.chassisId = opts.chassisId
    this.pilotId = opts.pilotId
    this.tier = opts.tier
    this.turntable = new Turntable(opts.reducedMotion)
  }

  /** True while a GPU context is allocated to this preview. */
  get live(): boolean {
    return this.stage !== null
  }

  /** True while the animation loop should be running. */
  get running(): boolean {
    return this.visible && !this.pageHidden && !this.failed && this.stage !== null
  }

  get selection(): { chassisId: string; pilotId: string; tier: QualityTier } {
    return { chassisId: this.chassisId, pilotId: this.pilotId, tier: this.tier }
  }

  setSelection(chassisId: string, pilotId: string): void {
    if (chassisId === this.chassisId && pilotId === this.pilotId) return
    this.chassisId = chassisId
    this.pilotId = pilotId
    this.dirty = true
    this.push()
  }

  setQuality(tier: QualityTier): void {
    if (tier === this.tier) return
    this.tier = tier
    this.dirty = true
    this.push()
  }

  setReducedMotion(on: boolean): void {
    this.turntable.reducedMotion = on
    if (this.stage && this.stage.setReducedMotion) this.stage.setReducedMotion(on)
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return
    this.visible = visible
    if (!visible) {
      this.teardown()
      return
    }
    if (this.failed) return
    const stage = this.makeStage()
    if (!stage) {
      this.failed = true
      return
    }
    this.stage = stage
    this.dirty = true
    this.push()
  }

  /** Tab backgrounded. Pauses the loop; deliberately does NOT free the
   *  context — a hidden tab is not a race, and rebuilding on every alt-tab
   *  would cost more than it saves. */
  setPageHidden(hidden: boolean): void {
    this.pageHidden = hidden
  }

  /** The context went away underneath us (driver reset, tab eviction). */
  contextLost(): void {
    this.teardown()
    this.failed = true
  }

  tick(dt: number): void {
    const stage = this.stage
    if (!stage || !this.running) return
    this.turntable.step(dt)
    if (this.dirty) {
      stage.setVehicle(this.chassisId, this.pilotId, this.tier)
      this.dirty = false
    }
    stage.render(dt, this.turntable.yaw)
    this.frames++
  }

  resize(): void {
    this.stage?.resize()
  }

  stats(): PreviewStats | null {
    return this.stage?.stats ? this.stage.stats() : null
  }

  dispose(): void {
    this.visible = false
    this.teardown()
  }

  private teardown(): void {
    if (!this.stage) return
    this.stage.dispose()
    this.stage = null
    this.dirty = true
  }

  /** Push a changed selection at a stage that already exists. */
  private push(): void {
    if (!this.stage || !this.dirty) return
    this.stage.setVehicle(this.chassisId, this.pilotId, this.tier)
    this.dirty = false
  }
}

// ---------------------------------------------------------------------------
// A stationary racer
// ---------------------------------------------------------------------------

/**
 * The minimum honest RacerState a VehicleVisual will accept.
 *
 * Every field is written, none are cast away, and every one of them is what a
 * car sitting still in a garage would actually hold: no velocity, no drift, no
 * boost, no items, on the ground at its own ride height. The visual's idle
 * animation set — the pilot's blink, jitter, emote and NULL's glitch — is
 * driven purely by the time it accumulates, so a zeroed racer is exactly what
 * makes those visible. This is the only place in the game they can be seen.
 */
export function stationaryRacer(chassisId: string, pilotId: string): RacerState {
  const ride = -chassisGroundY(chassisId)
  return {
    id: 0,
    chassisId,
    pilotId,
    isAI: false,
    isLocal: true,
    aiSkill: 0,
    pos: { x: 0, y: ride, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: REST_YAW,
    yawRate: 0,
    fwd: { x: Math.sin(REST_YAW), y: 0, z: Math.cos(REST_YAW) },
    up: { x: 0, y: 1, z: 0 },
    altitude: ride,
    vertVel: 0,
    grounded: true,
    wallTime: 0, windPush: 0,
    driftSide: 0,
    driftCharge: 0,
    driftTier: -1,
    driftInward: 0,
    driftEntry: false,
    driftTime: 0,
    chainStacks: 0,
    chainWindow: 0,
    boostTime: 0,
    boostMag: 0,
    boostSource: 'none',
    lift: 0,
    liftActive: false,
    airTime: 0,
    trickArmed: false,
    rampCooldown: 0,
    ballisticTime: 0,
    item: null,
    itemCharges: 0,
    itemSlot2: null,
    rouletteTime: 0,
    gatlingTime: 0,
    gatlingCooldown: 0,
    beamCharge: 0,
    beamGrace: 0,
    spinTime: 0,
    stunTime: 0,
    immuneTime: 0,
    invincibleTime: 0,
    slowTime: 0,
    slowMag: 0,
    massMult: 1,
    lap: 0,
    checkpoint: 0,
    splineS: 0,
    totalS: 0,
    lateral: 0,
    position: 1,
    finished: false,
    finishTime: 0,
    lapTimes: [],
    bestLap: 0,
    charges: 0,
    offTrackTime: 0,
    respawnTime: 0,
    respawnPlaced: true,
    lastHitBy: null,
    events: [],
  }
}

// ---------------------------------------------------------------------------
// The three.js stage
// ---------------------------------------------------------------------------

/** Vertical field of view. A long lens: it flatters a car and it keeps the
 *  perspective from bending a 3.15m-long chassis at the near corner. */
const FOV = 28
/** Camera elevation above the car's centre. Enough to read the deck without
 *  turning the shot into a plan view. */
const ELEV = (15 * Math.PI) / 180
/** Slack around the framed extent, so nothing clips the panel edge. */
const FRAME_MARGIN = 1.08
/** How far the pilot's ball stands above the deck. See vehicles.ts: a 0.8m
 *  sphere dropped into the seat tub up to its equator. */
const PILOT_CLEAR = 0.46
/**
 * The preview height, in DEVICE pixels, that the vehicle LOD distances were
 * authored against.
 *
 * The LOD in render/vehicles.ts switches on metres, but what it is really
 * approximating is "how many pixels of screen is this car covering". A phone's
 * preview is a quarter of the desktop one's pixel count, so handing the LOD
 * the raw camera distance would give a phone the same 3.7k-triangle LOD0 the
 * desktop gets. Scaling the distance by the pixel shortfall is the honest
 * translation, and it is what drops a phone to LOD1 without a device check.
 */
const LOD_REF_PX = 420

const _target = new THREE.Vector3()

class ThreeStage implements PreviewStage {
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 200)
  private readonly renderer: THREE.WebGLRenderer
  private readonly host: HTMLElement
  private readonly maxPixelRatio: number
  /** Buffer scale from the quality tier. The low tier renders at 3/4 and lets
   *  the browser scale it up, exactly as the race does. */
  private renderScale = 1
  /** Mirrors the turntable's flag; only used to silence NULL's face strobe. */
  private reduced = false
  private visual: VehicleVisualEx | null = null
  private racer: RacerState | null = null
  private chassisId = CHASSIS[0].id
  private camDist = 12
  private ms = 0
  private readonly owned: { dispose(): void }[] = []
  private readonly shadow: THREE.Mesh
  private readonly dais: THREE.Mesh
  private readonly onLost: (e: Event) => void

  constructor(
    renderer: THREE.WebGLRenderer,
    host: HTMLElement,
    coarse: boolean,
    lost: () => void,
  ) {
    this.renderer = renderer
    this.host = host
    // A menu does not need the discrete GPU or a 2x buffer. Both caps are the
    // "smaller and cheaper on a phone" half of the design decision; the other
    // half is the CSS box.
    this.maxPixelRatio = coarse ? 1.5 : 2

    renderer.setClearColor(0x000000, 0)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    // A touch under the race's 1.05. The panel behind the car is a dark
    // instrument face, and the thing worth reading in the shot is the pilot's
    // emissive face panel against a white shell: at the race's exposure the
    // shell blows out and takes the expression with it.
    renderer.toneMappingExposure = 0.98
    renderer.shadowMap.enabled = false

    // A context can be taken away by the driver or by the browser reclaiming
    // one under memory pressure. Removed in dispose() BEFORE forceContextLoss,
    // so the loss we cause ourselves is never mistaken for one we suffered.
    this.onLost = (e: Event): void => {
      e.preventDefault()
      lost()
    }
    renderer.domElement.addEventListener('webglcontextlost', this.onLost, false)

    // --- light rig -------------------------------------------------------
    // Three lamps, laid out like a product shot rather than like a planet: a
    // cool key from the front-left, a hot cyan kicker from behind to peel the
    // silhouette off the panel (the same job the body material's fresnel does
    // in the race), and a hemisphere fill so the underside is not a hole.
    const key = new THREE.DirectionalLight(0xf2f8ff, 2.5)
    key.position.set(-3.2, 4.0, 4.4)
    this.scene.add(key)
    const kick = new THREE.DirectionalLight(0x5fd8ff, 2.2)
    kick.position.set(3.6, 1.8, -4.2)
    this.scene.add(kick)
    const warm = new THREE.DirectionalLight(0xffb765, 0.9)
    warm.position.set(4.2, 0.6, 2.2)
    this.scene.add(warm)
    this.scene.add(new THREE.HemisphereLight(0x6f9fd8, 0x0a1220, 1.15))

    // --- dais ------------------------------------------------------------
    // A contact shadow and one thin ring. The ring is doing the same job the
    // front end's CSS grid horizon does: it says the car is standing on
    // something without drawing a floor that would fight the panel.
    const shadowTex = makeContactShadow()
    const shadowMat = new THREE.MeshBasicMaterial({
      map: shadowTex, transparent: true, depthWrite: false, opacity: 0.62,
      color: 0x000000, toneMapped: false,
    })
    const shadowGeo = new THREE.PlaneGeometry(1, 1)
    this.shadow = new THREE.Mesh(shadowGeo, shadowMat)
    this.shadow.rotation.x = -Math.PI / 2
    this.shadow.position.y = 0.012
    this.scene.add(this.shadow)
    this.owned.push(shadowTex, shadowMat, shadowGeo)

    const ringGeo = new THREE.RingGeometry(0.962, 1, 96)
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x22d3ff, transparent: true, opacity: 0.28,
      side: THREE.DoubleSide, depthWrite: false, toneMapped: false,
    })
    this.dais = new THREE.Mesh(ringGeo, ringMat)
    this.dais.rotation.x = -Math.PI / 2
    this.dais.position.y = 0.004
    this.scene.add(this.dais)
    this.owned.push(ringGeo, ringMat)

    this.resize()
  }

  setReducedMotion(on: boolean): void {
    this.reduced = on
    if (this.visual) this.visual.materials.face.sg.uGlitch.value = on ? 0 : 1
  }

  setRenderScale(s: number): void {
    if (s === this.renderScale) return
    this.renderScale = s
    this.resize()
  }

  setVehicle(chassisId: string, pilotId: string, tier: QualityTier): void {
    if (this.visual) {
      this.scene.remove(this.visual.group)
      this.visual.dispose()
      this.visual = null
    }
    const def = CHASSIS_BY_ID[chassisId] ?? CHASSIS[0]
    const pilot = PILOTS.find((p) => p.id === pilotId) ?? PILOTS[0]
    // Shadows off unconditionally: one shadow map for one car in a menu buys
    // nothing the baked contact shadow is not already selling, and it is the
    // single most expensive thing a second context could be asked to do on a
    // phone.
    const quality: RenderQuality = { ...QUALITY_PRESETS[tier], shadows: false }
    // The tier picks the buffer scale too, not just the model. LOW rendering a
    // full-resolution buffer would be the quality control answering half the
    // question a player asked it.
    this.setRenderScale(quality.renderScale)
    const v = createVehicleVisual(def.id, pilot.id, quality)
    v.gravity = false
    this.visual = v
    this.chassisId = def.id
    this.racer = stationaryRacer(def.id, pilot.id)
    // A garage is not a racetrack: whatever the OS thinks about motion, a face
    // panel that strobes nine times a second is a flicker, and the rest of this
    // codebase turns flicker off under reduced motion rather than turning the
    // content off. NULL keeps its corrupted colours and loses the strobe.
    if (this.reduced) v.materials.face.sg.uGlitch.value = 0
    this.scene.add(v.group)

    const h = def.halfExtents
    this.shadow.scale.set(h.x * 4.6, h.z * 3.4, 1)
    // A CIRCLE, not an ellipse traced round the car. The car turns and the
    // dais does not, so a footprint-shaped ring would swing in and out of the
    // silhouette once a revolution; a circle at the sweep radius reads as the
    // thing the car is standing on from every angle.
    const dais = Math.hypot(h.x, h.z) * 0.86
    this.dais.scale.set(dais, dais, 1)
    this.frameCamera()
  }

  render(dt: number, yaw: number): void {
    const v = this.visual
    const r = this.racer
    if (!v || !r) return
    r.yaw = yaw
    r.fwd.x = Math.sin(yaw)
    r.fwd.z = Math.cos(yaw)
    // The LOD wants a distance; what it is really asking is how much screen
    // this car is covering. See LOD_REF_PX.
    const px = Math.max(1, this.renderer.domElement.height)
    const t0 = now()
    v.update(r, dt, this.camDist * (LOD_REF_PX / px))
    this.renderer.render(this.scene, this.camera)
    // Cheap EMA. The number is only ever read by a probe, but it is the only
    // honest answer to "what does the second context cost".
    this.ms += (now() - t0 - this.ms) * 0.08
  }

  stats(): PreviewStats {
    const info = this.renderer.info.render
    const el = this.renderer.domElement
    return {
      lod: this.visual ? this.visual.lodIndex : -1,
      calls: info.calls,
      tris: info.triangles,
      ms: this.ms,
      bw: el.width,
      bh: el.height,
    }
  }

  resize(): void {
    const w = Math.max(1, Math.round(this.host.clientWidth))
    const h = Math.max(1, Math.round(this.host.clientHeight))
    const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1
    this.renderer.setPixelRatio(Math.min(dpr, this.maxPixelRatio) * this.renderScale)
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.frameCamera()
  }

  dispose(): void {
    // Before anything else: a loss we cause is not a loss we report.
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onLost, false)
    if (this.visual) {
      this.scene.remove(this.visual.group)
      this.visual.dispose()
      this.visual = null
    }
    for (const o of this.owned) o.dispose()
    this.owned.length = 0
    this.scene.clear()
    this.renderer.dispose()
    // The one line that actually hands the context back. dispose() alone frees
    // three.js's own objects and leaves the GL context attached to the canvas,
    // which is precisely the leak this whole lifecycle exists to avoid.
    this.renderer.forceContextLoss()
    const el = this.renderer.domElement
    if (el.parentNode) el.parentNode.removeChild(el)
  }

  /**
   * Frame the car by its own dimensions, so the 2.37m Star Hopper and the 3.15m
   * Dray-9 both fill the same box.
   *
   * The two axes are solved SEPARATELY and the looser one wins, which matters
   * more than it sounds. A single bounding sphere is dominated by the length --
   * 2.35m of half-length against 0.55m of half-height on a Solaire -- so
   * framing a wide, short box against that sphere pushed the camera twice as
   * far back as the picture needed and left the car sitting small in the middle
   * of its own panel. Horizontally the car really is a sphere, because the
   * turntable sweeps it through one; vertically it is 1.6m of car and nothing
   * else, and on a landscape phone that is the axis that binds.
   */
  private frameCamera(): void {
    const def = CHASSIS_BY_ID[this.chassisId] ?? CHASSIS[0]
    const h = def.halfExtents
    const ride = -chassisGroundY(def.id)
    // Ground to roof. The body spans +/- halfExtents.y about an origin sitting
    // at ride height, so the wheels are at 0; PILOT_CLEAR is the ball that
    // stands proud of the deck (0.8m sphere, seated to its equator).
    const top = ride + h.y + PILOT_CLEAR
    // Aim a little below the midpoint: the interesting half of a car is the
    // bodywork, not the air over it.
    const targetY = top * 0.42
    const rxz = Math.hypot(h.x, h.z)
    const vHalf = (FOV * Math.PI) / 360
    const hHalf = Math.atan(Math.tan(vHalf) * this.camera.aspect)
    // Solved at the NEAR edge of the sweep circle, not at its centre. On a
    // landscape phone the preview is 3:1 and the horizontal solve puts the
    // camera close enough that the car's near corner falls OUT of the vertical
    // frustum -- the wheels were being sliced off the bottom of the box while
    // every number said the car fitted. `dist - rxz` is the depth the nearest
    // part of the car actually sits at, and both axes are solved there.
    const distH = rxz + rxz / Math.tan(hHalf)
    const distV = rxz + (top - targetY) / Math.tan(vHalf)
    const dist = Math.max(distH, distV) * FRAME_MARGIN
    this.camDist = dist
    this.camera.position.set(0, targetY + dist * Math.sin(ELEV), dist * Math.cos(ELEV))
    this.camera.lookAt(_target.set(0, targetY, 0))
  }
}

/** A soft round blob, drawn once into a 128px canvas. Cheaper than a shadow
 *  map by every measure that matters here, and it never shimmers. */
function makeContactShadow(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 128
  c.height = 128
  const g = c.getContext('2d')
  if (g) {
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64)
    grad.addColorStop(0, 'rgba(0,0,0,1)')
    grad.addColorStop(0.45, 'rgba(0,0,0,0.72)')
    grad.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = grad
    g.fillRect(0, 0, 128, 128)
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

// ---------------------------------------------------------------------------
// The widget
// ---------------------------------------------------------------------------

export interface GaragePreview {
  root: HTMLElement
  setSelection(chassisId: string, pilotId: string): void
  setQuality(tier: QualityTier): void
  /** The garage is the screen on show. Builds the context. */
  show(): void
  /** It is not. Frees the context. */
  hide(): void
  dispose(): void
}

export interface GaragePreviewOpts {
  chassisId: string
  pilotId: string
  tier: QualityTier
  /** Injectable for tests and for a host that already knows. */
  makeStage?: (host: HTMLElement) => PreviewStage | null
  reducedMotion?: boolean
}

class GaragePreviewImpl implements GaragePreview {
  readonly root: HTMLElement
  private readonly core: PreviewCore
  private readonly hint: HTMLElement
  private raf = 0
  private last = 0
  private dragId = -1
  private dragX = 0
  private ro: ResizeObserver | null = null
  private readonly onVisibility: () => void
  private readonly onWindowResize: () => void
  private readonly motionQuery: MediaQueryList | null
  private readonly onMotion: (() => void) | null

  constructor(host: HTMLElement, opts: GaragePreviewOpts) {
    const root = document.createElement('div')
    root.className = 'sg-prev'
    // Decorative, and deliberately so: everything this box says -- which
    // chassis, which pilot, what either of them is -- is already text in the
    // panel directly underneath it. Announcing a canvas as well would make a
    // screen reader read the same selection twice and give it nothing it could
    // act on, and the preview is not a control.
    root.setAttribute('aria-hidden', 'true')
    this.root = root
    host.appendChild(root)

    this.hint = document.createElement('div')
    this.hint.className = 'sg-prev__hint'
    this.hint.textContent = 'drag to turn'
    root.appendChild(this.hint)

    const mq = typeof matchMedia === 'function'
      ? matchMedia('(prefers-reduced-motion: reduce)') : null
    this.motionQuery = mq
    const reduced = opts.reducedMotion ?? (mq ? mq.matches : false)

    const make = opts.makeStage
      ?? ((h: HTMLElement): PreviewStage | null => defaultStage(
        h, this.core.selection.tier, this.core.turntable.reducedMotion,
        () => { this.core.contextLost(); this.sync() },
      ))
    this.core = new PreviewCore(() => make(root), {
      chassisId: opts.chassisId,
      pilotId: opts.pilotId,
      tier: opts.tier,
      reducedMotion: reduced,
    })

    // A live preference change is rare and cheap to honour: the turntable just
    // stops or starts contributing on the next frame.
    if (mq && typeof mq.addEventListener === 'function') {
      this.onMotion = (): void => this.core.setReducedMotion(mq.matches)
      mq.addEventListener('change', this.onMotion)
    } else {
      this.onMotion = null
    }

    // --- gestures --------------------------------------------------------
    // The preview sits between two scrolling lists, so the drag has to be
    // unambiguous: `touch-action: none` on this box only (see styles.css) means
    // the browser never claims a swipe that starts here, and pointer capture
    // means one that leaves the box still steers it. Nothing is bound at the
    // document level, so a swipe that starts on a LIST is never seen here at
    // all and scrolls the list exactly as it did before.
    root.addEventListener('pointerdown', this.onDown, { passive: false })
    root.addEventListener('pointermove', this.onMove, { passive: false })
    root.addEventListener('pointerup', this.onUp, { passive: false })
    root.addEventListener('pointercancel', this.onUp, { passive: false })

    this.onVisibility = (): void => {
      this.core.setPageHidden(document.hidden === true)
      this.sync()
    }
    document.addEventListener('visibilitychange', this.onVisibility)

    this.onWindowResize = (): void => this.core.resize()
    window.addEventListener('resize', this.onWindowResize)
    if (typeof ResizeObserver === 'function') {
      this.ro = new ResizeObserver(() => this.core.resize())
      this.ro.observe(root)
    }

    if (typeof window !== 'undefined') {
      ;(window as unknown as { __GARAGE_PREVIEW__: unknown }).__GARAGE_PREVIEW__ = {
        debug: (): unknown => ({
          frames: this.core.frames,
          yaw: this.core.turntable.yaw,
          auto: this.core.turntable.autoBlend,
          dragging: this.core.turntable.isDragging,
          live: this.core.live,
          running: this.core.running,
          failed: this.core.failed,
          ...this.core.selection,
          ...(this.core.stats() ?? {}),
        }),
        /** Park the turntable at an exact yaw and stop it drifting off it.
         *  Art probes need a REPEATABLE angle: driving the preview by
         *  synthesised drags, which is the only other way in, lands within a
         *  few degrees of where it was aimed and the auto-spin then walks it
         *  further between the set and the screenshot. Two photographs of the
         *  same chassis taken a pass apart have to be comparable or the
         *  iteration is guesswork. */
        setYaw: (y: number): void => { this.core.turntable.park(y) },
      }
    }
  }

  setSelection(chassisId: string, pilotId: string): void {
    this.core.setSelection(chassisId, pilotId)
  }

  setQuality(tier: QualityTier): void {
    this.core.setQuality(tier)
  }

  show(): void {
    this.core.setPageHidden(document.hidden === true)
    this.core.setVisible(true)
    this.sync()
  }

  hide(): void {
    this.core.setVisible(false)
    this.sync()
  }

  dispose(): void {
    this.core.dispose()
    this.sync()
    this.root.removeEventListener('pointerdown', this.onDown)
    this.root.removeEventListener('pointermove', this.onMove)
    this.root.removeEventListener('pointerup', this.onUp)
    this.root.removeEventListener('pointercancel', this.onUp)
    document.removeEventListener('visibilitychange', this.onVisibility)
    window.removeEventListener('resize', this.onWindowResize)
    if (this.motionQuery && this.onMotion
      && typeof this.motionQuery.removeEventListener === 'function') {
      this.motionQuery.removeEventListener('change', this.onMotion)
    }
    this.ro?.disconnect()
    this.ro = null
    if (typeof window !== 'undefined') {
      const w = window as unknown as { __GARAGE_PREVIEW__?: unknown }
      if (w.__GARAGE_PREVIEW__) delete w.__GARAGE_PREVIEW__
    }
    if (this.root.parentNode) this.root.parentNode.removeChild(this.root)
  }

  // -------------------------------------------------------------------------

  private sync(): void {
    const want = this.core.running
    if (want && this.raf === 0) {
      this.last = now()
      this.raf = requestAnimationFrame(this.frame)
    } else if (!want && this.raf !== 0) {
      cancelAnimationFrame(this.raf)
      this.raf = 0
    }
    // WebGL never came up. Fold the box away and let the column lay out the
    // way it did before this feature existed.
    this.root.hidden = this.core.failed
  }

  private readonly frame = (t: number): void => {
    if (!this.core.running) {
      this.raf = 0
      return
    }
    this.raf = requestAnimationFrame(this.frame)
    // Clamped for the same reason the sim clamps: a tab that was backgrounded
    // for a minute must not hand the idle animation a minute of dt.
    const dt = Math.min(0.05, Math.max(0, (t - this.last) / 1000))
    this.last = t
    this.core.tick(dt)
  }

  private readonly onDown = (ev: Event): void => {
    const e = ev as PointerEvent
    if (this.dragId >= 0 || e.isPrimary === false) return
    e.preventDefault()
    this.dragId = e.pointerId
    this.dragX = e.clientX
    this.core.turntable.grab()
    this.root.classList.add('is-drag')
    this.hint.classList.add('is-gone')
    try {
      this.root.setPointerCapture(e.pointerId)
    } catch {
      /* capture is best effort; the move handler still works without it */
    }
  }

  private readonly onMove = (ev: Event): void => {
    const e = ev as PointerEvent
    if (e.pointerId !== this.dragId) return
    e.preventDefault()
    this.core.turntable.dragBy(e.clientX - this.dragX, this.root.clientWidth)
    this.dragX = e.clientX
  }

  private readonly onUp = (ev: Event): void => {
    const e = ev as PointerEvent
    if (e.pointerId !== this.dragId) return
    this.dragId = -1
    this.core.turntable.release()
    this.root.classList.remove('is-drag')
    try {
      this.root.releasePointerCapture(e.pointerId)
    } catch {
      /* already gone */
    }
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/**
 * The real stage. Returns null — never throws — when a context cannot be had,
 * which is the whole of the WebGL fallback story: the core latches `failed`,
 * the widget hides itself, and the garage is the garage it always was.
 */
function defaultStage(
  host: HTMLElement, tier: QualityTier, reduced: boolean, lost: () => void,
): PreviewStage | null {
  const canvas = document.createElement('canvas')
  canvas.className = 'sg-prev__canvas'
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
  const attrs: WebGLContextAttributes = {
    alpha: true,
    antialias: !coarse,
    depth: true,
    stencil: false,
    // A menu has no business waking the discrete GPU.
    powerPreference: 'low-power',
    failIfMajorPerformanceCaveat: false,
  }
  // The context is asked for HERE rather than left to WebGLRenderer, for one
  // reason: a browser that will not give a second context makes the renderer's
  // constructor log a console error and then throw. Catching the throw is easy;
  // the console error is not catchable at all, and "WebGL is unavailable on
  // this machine" is a state the game is designed to survive silently, not a
  // fault to report to the player through devtools. Asking first means the
  // failure path is a null and nothing else.
  let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null
  try {
    gl = canvas.getContext('webgl2', attrs) as WebGL2RenderingContext | null
    if (!gl) gl = canvas.getContext('webgl', attrs) as WebGLRenderingContext | null
  } catch {
    gl = null
  }
  if (!gl) return null
  let renderer: THREE.WebGLRenderer
  try {
    renderer = new THREE.WebGLRenderer({ canvas, context: gl, ...attrs })
  } catch {
    return null
  }
  host.insertBefore(canvas, host.firstChild)
  const stage = new ThreeStage(renderer, host, coarse, lost)
  stage.setReducedMotion(reduced)
  stage.setRenderScale(QUALITY_PRESETS[tier].renderScale)
  return stage
}

export function createGaragePreview(
  host: HTMLElement, opts: GaragePreviewOpts,
): GaragePreview {
  return new GaragePreviewImpl(host, opts)
}
