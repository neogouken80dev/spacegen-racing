import * as THREE from 'three'
import { Race } from '../sim/race'
import { Track } from '../sim/track'
import { resetAI } from '../sim/ai'
import { TRACKS_BY_ID, RUSTFALL } from '../content/tracks'
import { CHASSIS, CHASSIS_BY_ID, getDerived } from '../content/chassis'
import { PILOTS } from '../content/pilots'
import { TUNING as T } from '../content/tuning'
import type { RacerState, RacerEvent, SimConfig, InputFrame } from '../sim/types'
import { QUALITY_PRESETS, type QualityTier, type RenderQuality } from '../render/api'
import { createVehicleVisual, disposeVehicleCache, type VehicleVisualEx } from '../render/vehicles'
import { buildTrackVisual } from '../render/trackMesh'
import { buildEnvironment } from '../render/environment'
import { createEntityVisuals, type EntityVisualsWithGate } from '../render/entities'
import { createVfx } from '../render/vfx'
import { createPostFx, type PostFx } from '../render/postfx'
import { createHud, type Hud } from '../ui/hud'
import { createCheer, type Cheer, type CheerLevel } from '../ui/cheer'
import { createFrontEnd, type FrontEnd } from '../ui/frontend'
import { createSettingsPanel, type SettingsPanel } from '../ui/settings'
import { createInput, type InputManager } from './input'
import { ChaseCamera } from './camera'
import { clamp01 } from '../sim/math'
import type { VfxSystem, TrackVisual, EnvironmentVisual } from '../render/api'

const DT = T.sim.dt
const RACER_COUNT = 8

/**
 * `ceremony` is the finish sequence: the local racer has crossed the line, the
 * sim is still stepping (the field is still coming in, and every finished car
 * is doing a victory lap under AI), and the camera has left the chase rig. It
 * is deliberately a phase of its own rather than a flag on `racing`, because
 * every branch that asks "is the player driving" has to answer no.
 */
type Phase = 'menu' | 'racing' | 'ceremony' | 'paused' | 'results'

interface RenderRacer {
  visual: VehicleVisualEx
  /** Interpolated copy handed to the visual so 120Hz displays stay smooth. */
  view: RacerState
  prevX: number; prevY: number; prevZ: number; prevYaw: number
  /**
   * The racer's own frame at the previous sim step, for interpolation on a
   * gravity track. Six numbers rather than two Vec3s so the render loop
   * allocates nothing, exactly as prevX/Y/Z do.
   *
   * Untouched on a flat track: the sim leaves `fwd`/`up` frozen at the grid
   * there and the visual is told not to read them (VehicleVisualEx.gravity).
   */
  prevFX: number; prevFY: number; prevFZ: number
  prevUX: number; prevUY: number; prevUZ: number
}

export class Game {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private chase: ChaseCamera
  private quality: RenderQuality
  private tier: QualityTier = 'high'

  private track: Track
  private race: Race | null = null
  private renderRacers: RenderRacer[] = []

  private trackVis: TrackVisual | null = null
  private envVis: EnvironmentVisual | null = null
  private entityVis: EntityVisualsWithGate | null = null
  private vfx: VfxSystem | null = null
  private post: PostFx | null = null

  private hud: Hud
  private cheer: Cheer
  private frontEnd: FrontEnd
  private input: InputManager
  private settings: SettingsPanel
  private tools: HTMLElement
  /** True when the settings overlay paused the race, so closing resumes it. */
  private pausedBySettings = false

  private phase: Phase = 'menu'
  private accumulator = 0
  /** Per-racer one-shot events accumulated across the sub-steps of one render
   *  frame. See the carry block in loop(). */
  private eventCarry: RacerEvent[][] = []
  private lastTime = 0
  private localId = 0
  private selection = { chassisId: 'solaire', pilotId: 'pip' }
  private raf = 0
  private reduceMotion = false
  /**
   * The player's visual-intensity choice, 0..1 each. Held here rather than
   * only inside PostFx because the adaptive scaler destroys and rebuilds the
   * post chain mid-race: buildWorld() re-applies these to whatever it just
   * built, so a step-down cannot hand back the glare a player turned off.
   */
  private vfxGlare = 1
  private vfxScreen = 1
  /** Held here for the same reason: a rematch rebuilds nothing, but reset()
   *  wipes the cheer system's state and the level has to survive it. */
  private calloutLevel: CheerLevel = 'full'

  // --- finish ceremony ------------------------------------------------------
  /** Seconds since the local racer crossed the line. */
  private cerT = 0
  /** Seconds since the LAST car crossed, or -1 while the field is still out. */
  private cerFieldT = -1
  /** A skip control has been released at least once since the ceremony began. */
  private skipArmed = false

  // Adaptive quality
  private resizeObs: ResizeObserver | null = null
  private frameTimes: number[] = []
  private frameIdx = 0
  private qualityCooldown = 0
  private fps = 60
  /** Substep cap. Mutable so headless test harnesses can let the fixed-step
   *  accumulator catch up when the renderer is running at software speed. */
  maxSubSteps: number = T.sim.maxSubSteps
  /** Mirror of the last sampled input. sample() is stateful, so the render
   *  path must never call it a second time in the same frame. */
  private lastInput = { lookBack: false, item: false, drift: false, brake: 0, lift: false }

  private readonly container: HTMLElement

  constructor(container: HTMLElement) {
    this.container = container
    this.reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

    const canvas = document.createElement('canvas')
    canvas.id = 'sg-canvas'
    container.appendChild(canvas)

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, powerPreference: 'high-performance', stencil: false,
    })
    this.renderer.setClearColor(0x000000, 1)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05

    this.tier = detectTier()
    this.quality = { ...QUALITY_PRESETS[this.tier] }

    this.track = new Track(RUSTFALL)
    this.chase = new ChaseCamera(container.clientWidth / Math.max(1, container.clientHeight))

    this.hud = createHud(container)
    this.hud.root.style.display = 'none'
    // Inside the HUD root so it is shown, hidden and disposed with it, and so
    // the ceremony's `is-ceremony` rule can put it away in one selector.
    this.cheer = createCheer(this.hud.root)
    this.hud.skipButton.addEventListener('click', (e) => {
      e.preventDefault()
      if (this.phase === 'ceremony') this.finishRace()
    })
    this.frontEnd = createFrontEnd(container)
    this.input = createInput(canvas, container)

    this.settings = createSettingsPanel(container, {
      input: this.input,
      getQuality: () => this.tier,
      getReducedMotion: () => this.reduceMotion,
    })
    this.settings.onQualityChange = (q) => this.setTier(q)
    this.settings.onReducedMotionChange = (on) => { this.reduceMotion = on }
    this.settings.onVfxIntensityChange = (glare, screen) => {
      this.vfxGlare = glare
      this.vfxScreen = screen
      // Live, mid-race, mid-frame: PostFx.setIntensity is four number writes
      // and a boolean, so there is nothing to defer to a restart.
      this.post?.setIntensity(glare, screen)
    }
    this.settings.onCalloutChange = (level) => {
      this.calloutLevel = level
      this.cheer.setLevel(level)
    }
    this.settings.onClose = () => {
      this.tools.hidden = false
      if (this.pausedBySettings) { this.pausedBySettings = false; this.resume() }
    }

    this.tools = this.buildTools(container)

    this.frontEnd.onStart = (sel) => {
      this.selection = { chassisId: sel.chassisId, pilotId: sel.pilotId }
      this.setTrack(sel.trackId)
      this.setTier(sel.quality)
      this.startRace()
    }
    this.frontEnd.onRematch = () => this.startRace()
    this.frontEnd.onRestart = () => this.startRace()
    this.frontEnd.onResume = () => this.resume()
    this.frontEnd.onQuit = () => this.toMenu()
    this.input.onPause = () => {
      if (this.settings.isOpen) { this.settings.close(); return }
      if (this.phase === 'racing') this.pause()
      else if (this.phase === 'paused') this.resume()
      // Escape / Start during the ceremony is the skip, not a pause menu.
      else if (this.phase === 'ceremony' && this.cerT >= T.ceremony.skipGuard) this.finishRace()
    }

    window.addEventListener('resize', this.onResize)
    window.addEventListener('orientationchange', this.onResize)
    // The visual viewport moves independently of the layout viewport when a
    // mobile URL bar slides away; the window does not always hear about it.
    window.visualViewport?.addEventListener('resize', this.onResize)
    // And the element itself, which is the thing that actually has to match:
    // a ResizeObserver fires AFTER layout, so it reports the size the page
    // settled on rather than one it was passing through.
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => this.syncSize())
      this.resizeObs.observe(this.container)
    }
    document.addEventListener('visibilitychange', this.onVisibility)

    this.onResize()
    this.tools.hidden = true
    this.frontEnd.show('title')
    this.lastTime = performance.now()
    this.raf = requestAnimationFrame(this.loop)
  }

  /**
   * The in-race tool bar: a settings gear and a pause button. The pause button
   * matters most on touch, where there is no Escape key and the game would
   * otherwise be unpausable.
   */
  private buildTools(container: HTMLElement): HTMLElement {
    const bar = document.createElement('div')
    bar.className = 'sg-tools'

    const mk = (label: string, svg: string, onTap: () => void): HTMLButtonElement => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'sg-tools__btn'
      b.setAttribute('aria-label', label)
      b.title = label
      b.innerHTML = svg
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation() })
      b.addEventListener('click', (e) => { e.preventDefault(); onTap() })
      return b
    }

    const gear = mk('Settings and controls',
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/>' +
      '<path d="M12 2.6v2.2M12 19.2v2.2M4.35 4.35l1.55 1.55M18.1 18.1l1.55 1.55' +
      'M2.6 12h2.2M19.2 12h2.2M4.35 19.65l1.55-1.55M18.1 5.9l1.55-1.55"/></svg>',
      () => this.openSettings())

    const pause = mk('Pause',
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5v14M15 5v14"/></svg>',
      () => {
        if (this.phase === 'racing') this.pause()
        else if (this.phase === 'paused') this.resume()
      })

    bar.appendChild(gear)
    bar.appendChild(pause)
    container.appendChild(bar)
    return bar
  }

  /** Opening settings mid-race pauses it; closing resumes. */
  openSettings(tab: 'settings' | 'controls' = 'settings'): void {
    if (this.phase === 'racing') { this.pausedBySettings = true; this.pauseSilent() }
    this.tools.hidden = true
    this.settings.open(tab)
  }

  // -------------------------------------------------------------------------
  /**
   * Swap the circuit. Everything downstream is keyed off the Track instance --
   * buildWorld() re-reads it, the HUD rebakes its minimap when the identity
   * changes, and startRace() copies `track.def.id` into SimConfig.trackId --
   * so replacing it here is the whole change. An id with no track behind it
   * falls back to Rustfall rather than throwing a menu selection into the sim.
   */
  private setTrack(id: string): void {
    if (id === this.track.def.id) return
    this.track = new Track(TRACKS_BY_ID[id] ?? RUSTFALL)
  }

  private setTier(tier: QualityTier): void {
    if (tier === this.tier && this.trackVis) return
    this.tier = tier
    this.quality = { ...QUALITY_PRESETS[tier] }
    this.applyRenderScale()
    if (this.trackVis) this.buildWorld()
  }

  private applyRenderScale(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, this.tier === 'high' ? 2 : 1.5)
    this.renderer.setPixelRatio(dpr * this.quality.renderScale)
    this.renderer.shadowMap.enabled = this.quality.shadows
    if (this.quality.shadows) this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
  }

  private buildWorld(): void {
    this.teardownWorld()
    this.trackVis = buildTrackVisual(this.track, this.quality)
    this.scene.add(this.trackVis.group)
    this.envVis = buildEnvironment(this.track, this.scene, this.quality)
    if (!this.envVis.group.parent) this.scene.add(this.envVis.group)
    this.entityVis = createEntityVisuals(this.track, this.quality)
    this.scene.add(this.entityVis.group)
    this.vfx = createVfx(this.scene, this.quality)
    // Effects are placed in the racer's own frame on a gravity track, so drift
    // sparks land on the wall the car is riding rather than on the ground below
    this.vfx.gravity = this.track.hasGravity
    if (!this.vfx.group.parent) this.scene.add(this.vfx.group)
    this.post = this.quality.postFx
      ? createPostFx(this.renderer, this.scene, this.chase.camera, this.quality)
      : null
    // A freshly built chain starts at the tuned look. Put the player's choice
    // back on it before it draws a frame: this runs on every adaptive quality
    // step-down, which is precisely the moment a player who turned the glare
    // down cannot afford to have it handed back.
    this.post?.setIntensity(this.vfxGlare, this.vfxScreen)
    // The adaptive scaler can rebuild the world mid-race. teardownWorld also
    // drops the vehicle visuals, so they must be respawned or renderFrame
    // dereferences an empty array on the very next frame.
    if (this.race) this.spawnRacerVisuals()
  }

  private spawnRacerVisuals(): void {
    if (!this.race) return
    for (const rr of this.renderRacers) { this.scene.remove(rr.visual.group); rr.visual.dispose() }
    this.renderRacers = []
    for (const r of this.race.state.racers) {
      const visual = createVehicleVisual(r.chassisId, r.pilotId, this.quality)
      // On a gravity track the body is oriented from the sim's (fwd, up) frame
      // instead of the compass yaw, so a car on a wall is rolled onto the wall.
      visual.gravity = this.track.hasGravity
      this.scene.add(visual.group)
      this.renderRacers.push({
        visual,
        view: JSON.parse(JSON.stringify(r)) as RacerState,
        prevX: r.pos.x, prevY: r.pos.y, prevZ: r.pos.z, prevYaw: r.yaw,
        prevFX: r.fwd.x, prevFY: r.fwd.y, prevFZ: r.fwd.z,
        prevUX: r.up.x, prevUY: r.up.y, prevUZ: r.up.z,
      })
    }
  }

  private teardownWorld(): void {
    for (const rr of this.renderRacers) { this.scene.remove(rr.visual.group); rr.visual.dispose() }
    this.renderRacers = []
    if (this.trackVis) { this.scene.remove(this.trackVis.group); this.trackVis.dispose(); this.trackVis = null }
    if (this.envVis) { this.scene.remove(this.envVis.group); this.envVis.dispose(); this.envVis = null }
    if (this.entityVis) { this.scene.remove(this.entityVis.group); this.entityVis.dispose(); this.entityVis = null }
    if (this.vfx) { this.scene.remove(this.vfx.group); this.vfx.dispose(); this.vfx = null }
    if (this.post) { this.post.dispose(); this.post = null }
  }

  // -------------------------------------------------------------------------
  private startRace(): void {
    resetAI()
    this.applyRenderScale()
    this.buildWorld()
    // A rematch must not replay the last race's final-frame events.
    this.eventCarry.length = 0

    const chassisIds: string[] = []
    const pilotIds: string[] = []
    const pool = CHASSIS.filter((c) => c.id !== this.selection.chassisId)
    for (let i = 0; i < RACER_COUNT; i++) {
      if (i === 0) { chassisIds.push(this.selection.chassisId); pilotIds.push(this.selection.pilotId) }
      else {
        chassisIds.push(pool[(i - 1) % pool.length].id)
        pilotIds.push(PILOTS[i % PILOTS.length].id)
      }
    }

    const config: SimConfig = {
      seed: (Math.random() * 0xffffffff) >>> 0,
      totalLaps: T.race.totalLaps,
      racerCount: RACER_COUNT,
      trackId: this.track.def.id,
      chassisIds, pilotIds,
      localRacerIndex: 0,
      aiSkill: Array.from({ length: RACER_COUNT }, (_, i) => (i === 0 ? 0 : 2 + (i % 3))),
    }

    this.race = new Race(this.track, config)
    this.localId = 0
    this.spawnRacerVisuals()

    const local = this.race.state.racers[this.localId]
    this.input.setLiftEnabled(CHASSIS_BY_ID[local.chassisId].locomotion === 'flight')
    this.input.setPadsVisible(true)
    // Tell the rig which frame it is working in BEFORE the reset, so a race
    // that starts on a bank or a wall opens already framed rather than easing
    // the horizon straight over the first second.
    this.chase.gravity = this.track.hasGravity
    this.chase.reset(local)
    this.chase.endCinematic()
    this.accumulator = 0
    this.cerT = 0
    this.cerFieldT = -1
    this.hud.setFinish(null)
    this.cheer.reset()
    this.cheer.setLevel(this.calloutLevel)

    this.frontEnd.hide()
    this.hud.root.style.display = ''
    this.tools.hidden = false
    this.phase = 'racing'
  }

  private pause(): void {
    if (this.phase !== 'racing') return
    this.phase = 'paused'
    this.frontEnd.show('paused')
  }

  /**
   * Stop the simulation without raising the pause menu. Used when the settings
   * overlay opens mid-race: stacking the pause screen behind a modal leaves two
   * competing panels on screen.
   */
  private pauseSilent(): void {
    if (this.phase !== 'racing') return
    this.phase = 'paused'
  }

  private resume(): void {
    if (this.phase !== 'paused') return
    this.frontEnd.hide()
    this.phase = 'racing'
    this.lastTime = performance.now()
  }

  private toMenu(): void {
    this.phase = 'menu'
    this.race = null
    this.teardownWorld()
    this.tools.hidden = true
    this.hud.setFinish(null)
    this.cheer.reset()
    this.hud.root.style.display = 'none'
    this.input.setPadsVisible(false)
    this.frontEnd.show('garage')
  }

  // -------------------------------------------------------------------------
  // THE FINISH
  //
  // Three steps, and the whole design is in which of them the SIM is allowed
  // to notice:
  //
  //   beginCeremony   the local racer crossed the line. The camera leaves the
  //                   chase rig, the driving HUD goes away and the touch pads
  //                   come off screen. The sim carries on exactly as it was —
  //                   the field is still racing for real positions.
  //   stepCeremony    every FINISHED car, the player's included, is driven by
  //                   the same stepAI the field uses, through a pass that only
  //                   this loop calls. See Race.stepCeremony for the proof
  //                   that it cannot touch a result.
  //   settleRace      the ceremony is over but the field is not in. Run the
  //                   sim flat out to the flag so the results table is the
  //                   real one rather than a guess, then show it.
  // -------------------------------------------------------------------------

  private beginCeremony(): void {
    if (!this.race || this.phase !== 'racing') return
    this.phase = 'ceremony'
    this.cerT = 0
    this.cerFieldT = this.race.state.phase === 'finished' ? 0 : -1
    this.skipArmed = false
    // Hand over from the pose the chase rig is holding RIGHT NOW, before the
    // next render moves it, so there is no cut.
    // The interpolated view when there is one, so the handover starts from the
    // pose the player is actually looking at; the sim racer if the adaptive
    // scaler happens to be between teardown and respawn.
    const rr = this.renderRacers[this.localId]
    this.chase.beginCinematic(rr ? rr.view : this.race.state.racers[this.localId])
    this.input.setPadsVisible(false)
    this.tools.hidden = true
    this.cheer.reset()
    this.syncFinishCard()
  }

  /** Reused: this runs every frame of the ceremony and must not allocate. */
  private readonly finishCard = { position: 0, time: 0, stillRacing: 0, canSkip: false }

  private syncFinishCard(): void {
    if (!this.race) return
    const st = this.race.state
    const local = st.racers[this.localId]
    let out = 0
    for (const r of st.racers) if (!r.finished) out++
    const c = this.finishCard
    c.position = local.position
    c.time = local.finished ? local.finishTime : st.time
    c.stillRacing = out
    c.canSkip = this.cerT >= T.ceremony.skipGuard
    this.hud.setFinish(c)
  }

  /**
   * Is the shot done? `minDuration` guarantees it always gets to land, even
   * for a player who finishes last and ends the race on the same frame.
   * `maxDuration` guarantees a runaway winner is not held hostage by the tail
   * of someone else's race.
   */
  private ceremonyDone(): boolean {
    const C = T.ceremony
    if (this.cerT < C.minDuration) return false
    if (this.cerT >= C.maxDuration) return true
    return this.cerFieldT >= 0 && this.cerFieldT >= C.holdAfterField
  }

  /**
   * Run the remaining racers to the flag at full speed. The alternative —
   * fabricating placings for whoever is still out — would print a results
   * table that never happened, and the sim is cheap enough that there is no
   * reason to: a step is a few microseconds and there are at most a couple of
   * thousand of them left.
   */
  private settleRace(): void {
    const race = this.race
    if (!race) return
    const idle: InputFrame = { steer: 0, throttle: 0, brake: 0, drift: false, item: false, itemBack: false, lift: false, lookBack: false }
    let steps = 0
    while (race.state.phase !== 'finished' && steps < T.ceremony.settleMaxSteps) {
      race.setInput(this.localId, idle)
      race.step()
      steps++
    }
  }

  private finishRace(): void {
    if (!this.race) return
    // Whatever brought us here — the shot ending, a skip, or the last car
    // crossing — the table has to be complete before it is drawn.
    this.settleRace()
    this.phase = 'results'
    this.tools.hidden = true
    this.hud.setFinish(null)
    this.cheer.reset()
    this.hud.root.style.display = 'none'
    this.chase.endCinematic()
    this.input.setPadsVisible(false)
    this.frontEnd.showResults(this.race.state, this.localId)
    this.frontEnd.show('results')
  }

  // -------------------------------------------------------------------------
  private readonly loop = (now: number): void => {
    this.raf = requestAnimationFrame(this.loop)
    // Before anything is drawn. See the note on syncSize: the shape of the
    // picture is an invariant we check, not an event we hope arrives.
    this.syncSize()
    const rawDt = Math.min(0.25, (now - this.lastTime) / 1000)
    this.lastTime = now
    if (rawDt <= 0) return

    this.trackFrame(rawDt)

    const simming = (this.phase === 'racing' || this.phase === 'ceremony') && this.race !== null
    if (this.phase === 'ceremony') this.cerT += rawDt

    if (simming && this.race) {
      this.accumulator += rawDt
      let steps = 0
      const racers = this.race.state.racers
      while (this.accumulator >= DT && steps < this.maxSubSteps) {
        for (const rr of this.renderRacers) {
          const r = this.race.state.racers[this.renderRacers.indexOf(rr)]
          rr.prevX = r.pos.x; rr.prevY = r.pos.y; rr.prevZ = r.pos.z; rr.prevYaw = r.yaw
          if (this.track.hasGravity) {
            rr.prevFX = r.fwd.x; rr.prevFY = r.fwd.y; rr.prevFZ = r.fwd.z
            rr.prevUX = r.up.x; rr.prevUY = r.up.y; rr.prevUZ = r.up.z
          }
        }
        const frame: InputFrame = this.input.sample()
        this.lastInput.lookBack = frame.lookBack
        this.lastInput.item = frame.item
        this.lastInput.drift = frame.drift
        this.lastInput.brake = frame.brake
        this.lastInput.lift = frame.lift
        this.race.setInput(this.localId, frame)
        this.race.step()
        // The victory lap. A separate pass, deliberately: the headless
        // determinism gate and the balance harness call step() and nothing
        // else, so nothing they measure can move because of this. It also has
        // to run while state.phase is 'finished' -- step() early-returns then,
        // so without this the whole field would freeze the moment the last car
        // crossed, which is the bug this work exists to remove.
        if (this.race.state.finishOrder.length > 0) this.race.stepCeremony()
        // Carry one-shot events across every sub-step of this render frame.
        // race.step() clears r.events at the top of each step, so whenever more
        // than one step runs per frame the renderer only ever saw the LAST
        // one's events: measured delivery was fps/60, meaning at 30fps HALF of
        // all drift releases produced no boost burst and no vertigo shot, and
        // at 15fps three quarters of them. Nothing in the sim reads r.events --
        // it is a pure output channel -- so the accumulated list is written
        // straight back below for the render pass to consume as usual.
        for (let i = 0; i < racers.length; i++) {
          const ev = racers[i].events
          if (ev.length === 0) continue
          const carry = this.eventCarry[i] ?? (this.eventCarry[i] = [])
          for (let e = 0; e < ev.length; e++) carry.push(ev[e])
        }
        this.accumulator -= DT
        steps++
      }
      if (steps > 0) {
        for (let i = 0; i < racers.length; i++) {
          const carry = this.eventCarry[i]
          if (!carry || carry.length === 0) continue
          const ev = racers[i].events
          ev.length = 0
          for (let e = 0; e < carry.length; e++) ev.push(carry[e])
          carry.length = 0
        }
      }
      if (steps === this.maxSubSteps) this.accumulator = 0

      // --- ceremony state machine -----------------------------------------
      const st = this.race.state
      if (this.phase === 'racing' && st.racers[this.localId].finished) {
        this.beginCeremony()
      }
      if (this.phase === 'ceremony') {
        if (st.phase === 'finished' && this.cerFieldT < 0) this.cerFieldT = 0
        else if (this.cerFieldT >= 0) this.cerFieldT += rawDt
        this.syncFinishCard()
        // Skipping. The pointer path is the Results button; this is the
        // keyboard, gamepad and touch-pad path, gated behind `skipGuard` so
        // the accelerate key still held across the line is not a skip. Reading
        // the frame the sim already sampled keeps sample() called exactly once
        // per step, which is the contract it needs.
        //
        // EDGE-TRIGGERED, not level-triggered. A time guard alone is not
        // enough: a player who crosses the line still holding Drift would have
        // that same unreleased press count as a skip the instant the guard
        // expired, and the shot they asked for would vanish 0.7s in. The
        // control has to be RELEASED once before it can arm.
        const f = this.lastInput
        const held = f.item || f.drift || f.brake > 0.5 || f.lift
        if (!held) this.skipArmed = true
        const skip = held && this.skipArmed && this.cerT >= T.ceremony.skipGuard
        if (this.ceremonyDone() || skip) this.finishRace()
      } else if (this.phase === 'racing' && st.phase === 'finished') {
        // Belt and braces: the local racer is in every finish order, so this
        // should be unreachable. If it ever is not, do not freeze on the line.
        this.finishRace()
      }
    }

    this.renderFrame(rawDt)
  }

  private trackFrame(dt: number): void {
    const ms = dt * 1000
    if (this.frameTimes.length < 90) this.frameTimes.push(ms)
    else { this.frameTimes[this.frameIdx] = ms; this.frameIdx = (this.frameIdx + 1) % 90 }
    this.fps = 1000 / Math.max(0.5, avg(this.frameTimes))

    // Adaptive quality: step down if we cannot hold the frame, never step the
    // simulation rate, which would change the handling model.
    this.qualityCooldown -= dt
    if (this.qualityCooldown <= 0 && this.frameTimes.length >= 90 && this.phase === 'racing') {
      const p95 = percentile(this.frameTimes, 0.95)
      if (p95 > 24 && this.tier !== 'low') {
        this.setTier(this.tier === 'high' ? 'medium' : 'low')
        this.qualityCooldown = 6
        this.frameTimes.length = 0
      }
    }
  }

  private renderFrame(dt: number): void {
    const alpha = this.race ? clamp01(this.accumulator / DT) : 1

    if (this.race && this.renderRacers.length === this.race.state.racers.length) {
      const st = this.race.state
      for (let i = 0; i < this.renderRacers.length; i++) {
        const rr = this.renderRacers[i]
        const r = st.racers[i]
        const v = rr.view
        // Cheap structural copy: only the fields the visual reads.
        copyView(v, r)
        v.pos.x = rr.prevX + (r.pos.x - rr.prevX) * alpha
        v.pos.y = rr.prevY + (r.pos.y - rr.prevY) * alpha
        v.pos.z = rr.prevZ + (r.pos.z - rr.prevZ) * alpha
        v.yaw = lerpAngle(rr.prevYaw, r.yaw, alpha)
        if (this.track.hasGravity) {
          // Plain lerp, not a slerp. One sim step of wall-ride roll is a few
          // degrees, where the two differ by well under a tenth of a degree,
          // and the visual re-orthogonalises and re-normalises the pair before
          // building its basis -- so the only thing a slerp would buy here is
          // an acos and two sins per racer per frame.
          v.fwd.x = rr.prevFX + (r.fwd.x - rr.prevFX) * alpha
          v.fwd.y = rr.prevFY + (r.fwd.y - rr.prevFY) * alpha
          v.fwd.z = rr.prevFZ + (r.fwd.z - rr.prevFZ) * alpha
          v.up.x = rr.prevUX + (r.up.x - rr.prevUX) * alpha
          v.up.y = rr.prevUY + (r.up.y - rr.prevUY) * alpha
          v.up.z = rr.prevUZ + (r.up.z - rr.prevUZ) * alpha
        }
        const camDist = this.chase.camera.position.distanceTo(
          TMP.set(v.pos.x, v.pos.y, v.pos.z),
        )
        rr.visual.update(v, dt, camDist)
      }

      const local = st.racers[this.localId]
      const topSpeed = getDerived(local.chassisId).topSpeed
      const lookBack = this.lastInput.lookBack
      const localView = this.renderRacers[this.localId].view
      if (this.phase === 'ceremony') {
        // The finish shot. It needs the track because "above the ground" on a
        // banked, climbing circuit is not a constant -- see camera.ts.
        this.chase.updateCinematic(localView, dt, this.track, this.reduceMotion)
      } else {
        this.chase.update(localView, dt, topSpeed, lookBack, this.reduceMotion)
      }

      this.entityVis?.update(dt, st, st.time)
      if (st.phase === 'countdown') {
        const n = Math.ceil(st.countdown - 0.6)
        this.entityVis?.setStartLights(Math.max(0, Math.min(3, n)))
      }
      this.vfx?.update(dt, st, this.chase.camera.position, this.localId)
      this.trackVis?.update(dt, st.time)
      this.envVis?.update(dt, st.time, this.chase.camera.position)
      // Callouts BEFORE the HUD, so the HUD knows whether this frame's drift
      // release has already been announced up in the sky band and can stand
      // its own centre-screen flash down. Driven from here rather than from
      // inside the HUD because it reads the LIVE racer, not the interpolated
      // view: `events` is a one-shot channel and the interpolated copy does
      // not carry it.
      // Only while the player is actually driving. Paused, in the ceremony or
      // on the results screen there is nothing to praise, and no sim step is
      // running to refresh what it would read.
      if (this.phase === 'racing') this.cheer.update(st, local, dt)
      this.hud.setDriftReleaseTaken(this.phase === 'racing' && this.cheer.tookDriftRelease)
      this.hud.update(st, this.localId, this.track, this.fps)

      // Neither impulse belongs to the finish shot: a camera shake and a
      // vertigo punch are both answers to something the PLAYER did, and during
      // the ceremony the car is under AI.
      if (this.phase !== 'ceremony' && this.vfx && this.vfx.hitFlash > 0.4 && !this.reduceMotion) {
        this.chase.addShake(this.vfx.hitFlash * 0.5)
      }
      // Vertigo shot on a cashed-in drift. Consumed here, not in the camera:
      // the VFX pass owns the sim-frame guard, so the impulse fires exactly
      // once per release however fast the display refreshes.
      if (this.vfx && this.vfx.dollyRequest > 0) {
        if (this.phase !== 'ceremony') this.chase.addDolly(this.vfx.dollyRequest)
        this.vfx.dollyRequest = 0
      }

      const speed01 = clamp01(Math.hypot(local.vel.x, local.vel.z) / Math.max(1, topSpeed))
      if (this.post) this.post.render(dt, this.vfx?.boostIntensity ?? 0, this.vfx?.hitFlash ?? 0, speed01)
      else this.renderer.render(this.scene, this.chase.camera)
    } else {
      this.renderer.render(this.scene, this.chase.camera)
    }
  }

  // -------------------------------------------------------------------------
  /**
   * KEEPING THE PICTURE THE RIGHT SHAPE.
   *
   * A perspective camera whose `aspect` matches the surface it renders to
   * cannot distort anything -- so every stretched frame is a frame where those
   * two disagreed, and the ONLY way they disagree is if the surface changed
   * and nothing told the camera.
   *
   * This used to be subscribed to `window.resize` alone, and on a phone that is
   * not enough. Rotating to landscape fires resize while the layout viewport is
   * still mid-transition, so the handler samples a size the page is about to
   * stop having; the URL bar sliding away resizes the visual viewport without
   * necessarily firing it again; and an element can change size for reasons the
   * window never hears about at all. Whatever the camera latched onto in that
   * moment then persists for the rest of the session, and the whole image is
   * scaled by the ratio between the two -- a portrait aspect held on a
   * landscape canvas stretches everything horizontally by nearly five times.
   * Reported from play, twice, as the car looking flattened.
   *
   * So the size is no longer something we are TOLD about. `syncSize` below is
   * called every frame and reconciles the three numbers that must agree; the
   * listeners are kept only so the correction lands on the same frame as the
   * change rather than the one after it.
   */
  private readonly onResize = (): void => { this.syncSize() }

  /** Last size actually pushed to the renderer, so the per-frame check is a
   *  pair of float compares and not a stream of redundant GL calls. */
  private sizedW = -1
  private sizedH = -1

  /**
   * Reconcile canvas size, renderer size and camera aspect. Cheap enough to run
   * unconditionally: two reads and two compares when nothing has moved, which
   * is every frame but the handful where something has.
   */
  private syncSize(): void {
    const w = this.container.clientWidth || window.innerWidth
    const h = this.container.clientHeight || window.innerHeight
    if (w <= 0 || h <= 0) return
    if (w === this.sizedW && h === this.sizedH) return
    this.sizedW = w
    this.sizedH = h
    this.renderer.setSize(w, h, false)
    this.applyRenderScale()
    this.chase.resize(w / h)
    this.post?.resize(w, h)
  }

  private readonly onVisibility = (): void => {
    // A backgrounded tab during the ceremony is not paused -- there is nothing
    // to pause, the player is not driving -- it is simply skipped to results,
    // so returning to the tab does not drop into a cinematic mid-shot.
    if (document.hidden && this.phase === 'racing') this.pause()
    else if (document.hidden && this.phase === 'ceremony') this.finishRace()
    this.lastTime = performance.now()
  }

  dispose(): void {
    cancelAnimationFrame(this.raf)
    window.removeEventListener('resize', this.onResize)
    window.removeEventListener('orientationchange', this.onResize)
    window.visualViewport?.removeEventListener('resize', this.onResize)
    this.resizeObs?.disconnect()
    this.resizeObs = null
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.teardownWorld()
    disposeVehicleCache()
    this.cheer.dispose()
    this.hud.dispose()
    this.settings.dispose()
    this.tools.remove()
    this.frontEnd.dispose()
    this.input.dispose()
    this.renderer.dispose()
  }
}

// ---------------------------------------------------------------------------
const TMP = new THREE.Vector3()

function copyView(v: RacerState, r: RacerState): void {
  v.id = r.id; v.chassisId = r.chassisId; v.pilotId = r.pilotId
  v.vel.x = r.vel.x; v.vel.y = r.vel.y; v.vel.z = r.vel.z
  v.yawRate = r.yawRate; v.altitude = r.altitude; v.grounded = r.grounded
  v.driftSide = r.driftSide; v.driftCharge = r.driftCharge; v.driftTier = r.driftTier
  v.chainStacks = r.chainStacks
  v.boostTime = r.boostTime; v.boostMag = r.boostMag; v.boostSource = r.boostSource
  v.lift = r.lift; v.liftActive = r.liftActive; v.airTime = r.airTime
  v.spinTime = r.spinTime; v.stunTime = r.stunTime
  v.invincibleTime = r.invincibleTime; v.immuneTime = r.immuneTime
  v.slowTime = r.slowTime; v.respawnTime = r.respawnTime
  v.item = r.item; v.itemCharges = r.itemCharges
  v.lap = r.lap; v.position = r.position; v.charges = r.charges
  v.finished = r.finished; v.splineS = r.splineS; v.lateral = r.lateral
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return a + d * t
}

function avg(a: number[]): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]
  return s / Math.max(1, a.length)
}

function percentile(a: number[], p: number): number {
  const c = a.slice().sort((x, y) => x - y)
  return c[Math.min(c.length - 1, Math.floor(c.length * p))]
}

/** Cheap device-class guess used only as a starting point; the adaptive
 *  scaler corrects it within a few seconds of real frame data. */
function detectTier(): QualityTier {
  const nav = navigator as Navigator & { deviceMemory?: number; hardwareConcurrency?: number }
  const coarse = matchMedia('(pointer: coarse)').matches
  const mem = nav.deviceMemory ?? 4
  const cores = nav.hardwareConcurrency ?? 4
  if (coarse && (mem <= 4 || cores <= 4)) return 'low'
  if (coarse) return 'medium'
  if (mem <= 4 || cores <= 4) return 'medium'
  return 'high'
}

export function boot(): Game {
  const container = document.getElementById('app') ?? document.body
  const game = new Game(container as HTMLElement)
  // Dismiss the boot overlay from here rather than from an inline script in
  // index.html: single-file bundling strips those, which would leave the
  // overlay permanently covering the game.
  const bootEl = document.getElementById('sg-boot')
  if (bootEl) {
    bootEl.classList.add('gone')
    setTimeout(() => bootEl.remove(), 600)
  }
  ;(window as unknown as { __GAME__: Game }).__GAME__ = game
  ;(window as unknown as { __TUNING__: typeof T }).__TUNING__ = T
  return game
}
