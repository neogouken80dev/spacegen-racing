import * as THREE from 'three'

/** Blast-projection scratch. Module level so the render path never allocates. */
const _bp = new THREE.Vector3()
const _be = new THREE.Vector3()
const _bR = new THREE.Vector3()
const _bU = new THREE.Vector3()
const _bF = new THREE.Vector3()
/** Listener orientation scratch. Same reason as the blast vectors above. */
const _aFwd = new THREE.Vector3()
const _aUp = new THREE.Vector3()
import { Race } from '../sim/race'
import { Track } from '../sim/track'
import { resetAI } from '../sim/ai'
import { TRACKS_BY_ID, RUSTFALL } from '../content/tracks'
import { CHASSIS, CHASSIS_BY_ID, getDerived, getLocomotion } from '../content/chassis'
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
import { createHud, type Hud, type PodiumLine } from '../ui/hud'
import { createCheer, type Cheer, type CheerLevel } from '../ui/cheer'
import { createScoreHud, type ScoreHud } from '../ui/scoreHud'
import { CATALOGUE } from '../audio/catalogue'
import { Scorer } from '../score/scorer'
import { createScoreboard, BOARD_SIZE } from '../score/board'
import { createRecordStore, type RecordStore } from '../score/records'
import { createGlobalStore, type GlobalStore } from '../score/global'
import type { ScoreStore } from '../score/api'
import { createAudio, type AudioSystem } from '../audio'
import { createFrontEnd, type FrontEnd } from '../ui/frontend'
import { createSettingsPanel, type SettingsPanel } from '../ui/settings'
import { installCompactLayout, type CompactLayout } from '../ui/compact'
import { createInput, isTouchScheme, type InputManager } from './input'
import {
  applyRound, clearCircuit, CIRCUIT_GRID, CIRCUIT_ROUNDS, gridMismatch, isComplete,
  loadCircuit, newCircuit, resultFromRace, roundsDone, saveCircuit, standings,
  trackIdForRound, type CircuitState,
} from './circuit'
import {
  PODIUM_SKIP_GUARD, podiumCast, podiumDone, podiumSkip, type PodiumCast,
} from './podium'
import { createPodiumStage, pilotName, type PodiumStage } from '../render/podium'
import { ChaseCamera } from './camera'
import { themeFor } from '../render/themes'
import {
  ATTRACT_TRACK, attractPose, attractRacerCount, makeAttractPose, shotFor,
  spreadField, type AttractPose,
} from './attract'
import { clamp01 } from '../sim/math'
import type { VfxSystem, TrackVisual, EnvironmentVisual, CrosswindFrame } from '../render/api'

const DT = T.sim.dt
const RACER_COUNT = 8

/**
 * `ceremony` is the finish sequence: the local racer has crossed the line, the
 * sim is still stepping (the field is still coming in, and every finished car
 * is doing a victory lap under AI), and the camera has left the chase rig. It
 * is deliberately a phase of its own rather than a flag on `racing`, because
 * every branch that asks "is the player driving" has to answer no.
 *
 * `podium` is its younger sibling: the championship celebration, and it plays
 * ONCE PER CIRCUIT -- after round 8 has been scored and only then. It is in the
 * same family as `ceremony` (no input into the sim, a skip behind a guard, the
 * camera somewhere the chase rig is not) with one difference that matters: by
 * the time it starts there is no world left. The race is over, the track has
 * been torn down, and the scene holds the podium and nothing else.
 */
type Phase = 'menu' | 'attract' | 'racing' | 'ceremony' | 'podium' | 'paused' | 'results'

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
  /** Reused so the render path allocates nothing. See the projection below. */
  private readonly blastBuf: { x: number; y: number; radius: number; strength: number }[] = []
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
  private scoreHud: ScoreHud
  private readonly scorer = new Scorer()
  private readonly board: ScoreStore = createScoreboard()
  private readonly records: RecordStore = createRecordStore()
  private readonly global: GlobalStore = createGlobalStore()
  /** The finished run, held between the flag and the results screen. */
  private lastScore = 0
  private lastBestCombo = 1
  /** Set by onLocalFinish; consumed by the next scoring frame. See there. */
  private captureScoreNextFrame = false
  private readonly audio: AudioSystem = createAudio()
  /** Last countdown integer spoken, so a beep fires once per number. */
  private lastCount = -1
  /** True once the countdown has been seen, so the GO can fire when it ends. */
  private goArmed = false
  /** Last lap the music was told about, so the swap happens once. */
  private lastMusicLap = -1
  private frontEnd: FrontEnd
  private input: InputManager
  private readonly compact: CompactLayout
  private settings: SettingsPanel
  private tools: HTMLElement
  /** True when the settings overlay paused the race, so closing resumes it. */
  private pausedBySettings = false

  private phase: Phase = 'menu'
  /**
   * Seconds the attract shot has been running. Its own clock rather than the
   * sim's: the camera's push is a property of how long the player has been
   * looking at the title screen, not of how far through a race the AI field is.
   */
  private attractT = 0
  private readonly attractBuf: AttractPose = makeAttractPose()
  /** True while the document is hidden, so the title race stops burning a phone. */
  private docHidden = false
  private accumulator = 0
  /** Per-racer one-shot events accumulated across the sub-steps of one render
   *  frame. See the carry block in loop(). */
  private eventCarry: RacerEvent[][] = []
  /** Dense per-racer view of `r.events`, reused each frame. See the audio call. */
  private audioEvents: RacerEvent[][] = []
  private lastTime = 0
  private localId = 0
  private selection = { chassisId: 'solaire', pilotId: 'socket' }

  /**
   * THE GRAND CIRCUIT.
   *
   * `circuit` is the series, saved or in progress; `circuitActive` is whether
   * the player is IN it right now. The two are deliberately separate: a saved
   * circuit has to survive being ignored -- a player who comes back, races a
   * one-off on Zhen-9 and then presses Continue must find their standings
   * exactly where they left them, and a single race must not be able to score
   * a round. Every path that starts a race asks `circuitActive`, and the only
   * things that set it false are the title screen's Play and walking into the
   * track list. See game/circuit.ts for the series itself.
   */
  private circuit: CircuitState | null = null
  private circuitActive = false
  private raf = 0
  private reduceMotion = false
  /**
   * This frame's crosswind, refilled in place and handed to the environment.
   *
   * One long-lived object rather than a literal per frame: renderFrame runs at
   * display rate and this is the render loop's hot path, so allocating a Vec3
   * and a wrapper here is 120 objects a second for the garbage collector to
   * find during a race.
   */
  private readonly wind: CrosswindFrame = {
    push: 0, right: { x: 1, y: 0, z: 0 }, reduceMotion: false,
  }
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

  // --- championship podium --------------------------------------------------
  /** The celebration scene, or null whenever the phase is not `podium`. */
  private podiumStage: PodiumStage | null = null
  /** Seconds since the podium opened. Its own clock: the camera plan in
   *  game/podium.ts is written against it and there is no sim to ask. */
  private podT = 0
  private podSkipArmed = false
  /** Reused so the per-frame HUD push allocates nothing. */
  private readonly podCard = { lines: [] as PodiumLine[], you: '', tied: false, canSkip: false }

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
    // ONE BLOCK, NOT TWO.
    //
    // The score panel and the callout used to be independently positioned --
    // 13% and 33% -- and read as two unrelated captions that happened to fire
    // at the same time. They are describing ONE moment: the slide, what it is
    // worth, and how good it was. So they now share a flow container and stack
    // as a single unit, which is also what lets them share an entrance and a
    // colour instead of each having their own.
    //
    // Inside the HUD root so all three are shown, hidden and disposed with it,
    // and so the ceremony's `is-ceremony` rule still puts them away in one
    // selector.
    const moment = document.createElement('div')
    moment.className = 'sg-moment'
    this.hud.root.appendChild(moment)
    this.cheer = createCheer(moment)
    this.scoreHud = createScoreHud(moment, this.hud.root)
    this.hud.skipButton.addEventListener('click', (e) => {
      e.preventDefault()
      if (this.phase === 'ceremony') this.finishRace()
    })
    this.hud.podiumSkipButton.addEventListener('click', (e) => {
      e.preventDefault()
      if (this.phase === 'podium') this.endPodium()
    })
    this.hud.setReducedMotion(this.reduceMotion)
    this.frontEnd = createFrontEnd(container)
    this.input = createInput(canvas, container)
    // THE HUD LAYOUT FOLLOWS THE HANDS, NOT THE VIEWPORT. See ui/compact.ts:
    // a tablet is too wide for the phone breakpoints and still has thumbs on
    // the glass, so the compact instruments are driven from the live control
    // scheme as well as the window size.
    this.compact = installCompactLayout(() => isTouchScheme(this.input.scheme))
    this.input.onSchemeChange = () => this.compact.refresh()

    this.settings = createSettingsPanel(container, {
      input: this.input,
      getQuality: () => this.tier,
      getReducedMotion: () => this.reduceMotion,
    })
    this.settings.onQualityChange = (q) => this.setTier(q)
    this.settings.onReducedMotionChange = (on) => {
      this.reduceMotion = on
      // All four motion consumers from one value. The VFX system reads
      // `this.reduceMotion` on its own each frame; these three are pushed.
      // The HUD is on the list because the podium card's entrance is a DOM
      // animation and a media query cannot see the in-game toggle.
      this.cheer.setReducedMotion(on)
      this.scoreHud.setReducedMotion(on)
      this.hud.setReducedMotion(on)
    }
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
    // Live, mid-race. Every one of these is either a target the rig eases
    // toward or a damping rate, so the camera glides to the new pose instead
    // of cutting -- which is exactly what you want when the panel is open over
    // a paused race and the player is watching the frame change as they step.
    //
    // Nothing caches it here: `chase` is built once in this constructor and
    // only reset() per race, so the settings it is holding outlive every race
    // in the session, and the panel re-emits them on the next boot.
    this.settings.onCameraChange = (s) => { this.chase.applySettings(s) }
    this.settings.onVolumeChange = (v) => { this.audio.setVolumes(v) }
    this.settings.setVolumes(this.audio.volumes)

    this.settings.onClose = () => {
      this.tools.hidden = false
      if (this.pausedBySettings) { this.pausedBySettings = false; this.resume() }
    }

    this.tools = this.buildTools(container)

    // The saved circuit, read once at boot. A blocked or partitioned
    // localStorage returns null here and the game simply has no circuit to
    // resume -- see the storage note in game/circuit.ts.
    this.circuit = loadCircuit()
    this.publishCircuit()

    this.frontEnd.onStart = (sel) => {
      this.selection = { chassisId: sel.chassisId, pilotId: sel.pilotId }
      // A FINISHED SERIES HAS NO NEXT ROUND. Reachable by walking back into the
      // garage from the final results and pressing Start: without this the race
      // would run on the frozen grid and be scored by nothing, which is a mode
      // that looks like circuit mode and is not one.
      if (this.circuitActive && this.circuit && isComplete(this.circuit)) {
        this.circuitActive = false
        this.publishCircuit()
      }
      if (this.circuitActive && this.circuit) {
        // THE CIRCUIT PICKS THE TRACK, NOT THE PLAYER. The track screen is
        // skipped entirely in this mode, so `sel.trackId` is whatever was last
        // chosen for a single race and is not the round being started.
        //
        // And the grid is frozen on the way INTO round 1 rather than when the
        // circuit was created, so it is built around the car the player
        // actually pressed Start in -- they may have changed it in the garage
        // between pressing Grand Circuit and pressing Start.
        if (this.circuit.rounds.length === 0) {
          this.circuit = newCircuit(sel.pilotId, sel.chassisId)
          saveCircuit(this.circuit)
        }
        this.setTrack(trackIdForRound(roundsDone(this.circuit)))
      } else {
        this.setTrack(sel.trackId)
      }
      this.setTier(sel.quality)
      this.startRace()
    }
    // The gold button on the results screen. Inside a series it is the next
    // ROUND -- a different circuit -- so "rematch" would be the wrong promise;
    // frontend.ts relabels it and this is the other half of that.
    this.frontEnd.onRematch = () => {
      if (!this.circuitActive || !this.circuit) { this.startRace(); return }
      if (isComplete(this.circuit)) {
        // The series is over. Stay out of it, keep the standings, and let the
        // title screen offer a fresh one.
        this.circuitActive = false
        this.publishCircuit()
        this.frontEnd.show('title')
        return
      }
      this.setTrack(trackIdForRound(roundsDone(this.circuit)))
      this.startRace()
    }
    this.frontEnd.onRestart = () => this.startRace()
    this.frontEnd.onCircuitNew = () => {
      clearCircuit()
      this.circuit = newCircuit(this.frontEnd.selectedPilotId, this.frontEnd.selectedChassisId)
      this.circuitActive = true
      saveCircuit(this.circuit)
      this.publishCircuit()
      // Straight to the garage: the circuit owns the track list, so the only
      // decision left before round 1 is what to drive.
      this.frontEnd.show('garage')
    }
    this.frontEnd.onCircuitResume = () => {
      if (!this.circuit) { this.frontEnd.onCircuitNew(); return }
      this.circuitActive = true
      this.publishCircuit()
      this.frontEnd.show('garage')
    }
    this.frontEnd.onResume = () => this.resume()
    this.frontEnd.onQuit = () => this.toMenu()
    this.input.onPause = () => {
      if (this.settings.isOpen) { this.settings.close(); return }
      if (this.phase === 'racing') this.pause()
      else if (this.phase === 'paused') this.resume()
      // Escape / Start during the ceremony is the skip, not a pause menu.
      else if (this.phase === 'ceremony' && this.cerT >= T.ceremony.skipGuard) this.finishRace()
      // ...and the same during the podium, behind the same kind of guard.
      else if (this.phase === 'podium' && this.podT >= PODIUM_SKIP_GUARD) this.endPodium()
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

    /**
     * THE TITLE SCREEN OWNS A RACE, AND ONLY THE TITLE SCREEN.
     *
     * Two reasons it stops the moment any other screen comes up, and only one
     * of them is thrift:
     *
     *   The garage builds a SECOND WebGL context for its vehicle preview. A
     *   full race rendering underneath that is exactly the pair of contexts
     *   garagePreview.ts exists to prevent -- see its header.
     *
     *   Every other screen is opaque. Rendering a circuit nobody can see is a
     *   phone's battery spent on nothing.
     *
     * Coming back to the title builds a fresh race rather than resuming the old
     * one, which costs a track rebuild. That is the deliberate trade: the cost
     * lands on a rare back-navigation instead of on every frame of a screen the
     * player is going to leave, and a new grid each visit is the better attract
     * screen anyway.
     */
    this.frontEnd.onScreen = (screen) => {
      if (screen === 'title') this.startAttract()
      else this.stopAttract()
      // WALKING INTO THE TRACK LIST LEAVES THE CIRCUIT. It is the one screen
      // whose whole purpose is choosing a circuit yourself, so being on it and
      // being in a series are contradictory -- and a player who ends up there
      // mid-circuit and starts a race must not have it scored as a round. The
      // save is untouched, so Continue still works from the title.
      if (screen === 'track' && this.circuitActive) {
        this.circuitActive = false
        this.publishCircuit()
      }
      this.audio.menuMusic(screen === 'title' ? 'title'
        : screen === 'track' || screen === 'garage' ? 'garage' : null)
      // Start pulling the race bed while the player is still choosing. It is
      // 2.5-4MB; left until startRace() the fetch begins at the moment the
      // music should already be playing, and on a phone the first stretch of
      // the race runs in silence with the bed fading in over it.
      if (screen === 'track' || screen === 'garage') {
        this.audio.preloadTrack(this.nextTrackId())
      }
    }

    /**
     * THE GESTURE. Every browser starts an AudioContext suspended and will only
     * resume it inside a real user interaction -- that is the autoplay policy,
     * not a bug to route around. A pointerdown on the container is the widest
     * net that still counts: it catches the PLAY button, every menu card, and
     * the first touch of the driving pads.
     */
    const unlock = (): void => { this.audio.unlock() }
    container.addEventListener('pointerdown', unlock)
    container.addEventListener('keydown', unlock)

    // VO follows the TEXT callouts rather than re-deriving the moments. See the
    // note on Cheer.onLine: one set of editorial rules, two media.
    this.cheer.onLine = (kind) => { this.audio.callout(kind) }

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

  /**
   * The circuit the next race will actually run on.
   *
   * In circuit mode the player never sees the track list, so the front end's
   * remembered selection is the last SINGLE race's circuit and preloading its
   * music would fetch two to four megabytes of the wrong bed.
   */
  private nextTrackId(): string {
    if (this.circuitActive && this.circuit && !isComplete(this.circuit)) {
      return trackIdForRound(roundsDone(this.circuit))
    }
    return this.frontEnd.selectedTrackId
  }

  /** Push the circuit's state at every screen that shows part of it. */
  private publishCircuit(): void {
    this.frontEnd.setCircuit(this.circuit
      ? { state: this.circuit, localId: 0, active: this.circuitActive }
      : null)
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
  // THE TITLE SCREEN'S RACE
  //
  // Not a cutscene, not a video, not a pre-rendered plate: an actual race with
  // an actual field, on the same sim the player is about to drive. Everything
  // that makes the game look like itself -- the drift ribbons, the sparks, the
  // sky, the overtakes -- is already built and already tuned, so the honest
  // representation of this game is a frame of it, and the cheapest way to get
  // one is to run it.
  //
  // THREE THINGS THIS IS NOT ALLOWED TO DO
  //
  //   Cost a phone its first impression. The field scales with the tier the
  //   device already detected (see attractRacerCount): the sim is arithmetic
  //   and free, the vehicles are the draw calls, so the pack shrinks rather
  //   than the feature being gated off mobile.
  //
  //   Take the player's input. Every racer here is AI -- localRacerIndex is
  //   -1 -- and the loop does not call setInput at all in this phase, so a
  //   keypress on the title screen cannot nudge a car.
  //
  //   Keep running when nobody is looking. See the visibilitychange handler:
  //   a backgrounded tab stops stepping entirely rather than relying on the
  //   browser to throttle rAF generously.
  // -------------------------------------------------------------------------
  private startAttract(): void {
    if (this.phase === 'attract') return
    resetAI()
    this.setTrack(ATTRACT_TRACK)
    this.applyRenderScale()
    this.buildWorld()
    this.eventCarry.length = 0

    const n = attractRacerCount(this.tier)
    // A varied grid rather than the player's garage selection: this is a shop
    // window for the roster, so it should show as much of the roster as it has
    // slots for.
    const config: SimConfig = {
      seed: (Math.random() * 0xffffffff) >>> 0,
      totalLaps: 9,   // long enough that the title screen never runs out of race
      racerCount: n,
      trackId: this.track.def.id,
      chassisIds: Array.from({ length: n }, (_, i) => CHASSIS[i % CHASSIS.length].id),
      pilotIds: Array.from({ length: n }, (_, i) => PILOTS[i % PILOTS.length].id),
      localRacerIndex: -1,
      aiSkill: Array.from({ length: n }, (_, i) => 2 + (i % 3)),
    }

    this.race = new Race(this.track, config)
    // Deal the field around the lap before it steps. A grid starts bunched and
    // therefore leaves bunched, which from a fixed camera is one convoy and
    // then most of a lap of empty road -- the probe measured exactly that, zero
    // cars on screen from t+25s. See spreadField.
    //
    // Offset a third of a lap back from the camera so the first thing the
    // player sees is cars ARRIVING, not the backs of cars already leaving.
    spreadField(
      this.race.state.racers, this.track,
      shotFor(this.track.def.id).s - this.track.length / 3,
      {
        rideHeightOf: (id) => getLocomotion(id).rideHeight,
        topSpeedOf: (id) => getDerived(id).topSpeed,
      },
    )
    // Not a player, just an index the render path reads for topSpeed and wind.
    // Everything that would treat it as the player is gated on the phase.
    this.localId = 0
    this.spawnRacerVisuals()

    this.chase.gravity = this.track.hasGravity
    this.chase.endCinematic()
    this.accumulator = 0
    this.attractT = 0
    this.input.setPadsVisible(false)
    this.hud.root.style.display = 'none'
    this.tools.hidden = true
    this.phase = 'attract'
  }

  /**
   * The active circuit's theme.
   *
   * Exists for tools/probe-attract.mjs, which has to ask where the hero sky
   * body actually is in order to check the title camera is pointed at it. The
   * alternative was a second copy of that direction vector living in the probe,
   * which would be correct right up until somebody moved the black hole -- and
   * would then keep reporting a pass while the shot quietly pointed at nothing.
   * One accessor is cheaper than that class of bug.
   */
  get theme(): ReturnType<typeof themeFor> { return themeFor(this.track.def.id) }

  /** Tear the title race down. Idempotent: safe to call from any phase. */
  private stopAttract(): void {
    if (this.phase !== 'attract') return
    this.phase = 'menu'
    this.race = null
    this.teardownWorld()
  }

  // -------------------------------------------------------------------------
  private startRace(): void {
    // FIRST, AND NOT LATER. startRace() calls frontEnd.hide() further down,
    // which fires onScreen(null), which stops the attract race -- and at that
    // point `phase` is still 'attract', so stopAttract() would happily null the
    // race THIS call had just built and tear its world down under it. Ending
    // the title race up here leaves that callback a no-op.
    this.stopAttract()
    resetAI()
    this.applyRenderScale()
    this.buildWorld()
    // A rematch must not replay the last race's final-frame events.
    this.eventCarry.length = 0

    const chassisIds: string[] = []
    const pilotIds: string[] = []
    const aiSkill: number[] = []
    /**
     * THE FIELD, AND THE ONE THING CIRCUIT MODE COULD NOT REUSE.
     *
     * The single-race generator below derives the opponents' chassis from a
     * pool that EXCLUDES the player's car, so it answers differently for every
     * car the player might be driving. That is fine for a one-off race and
     * fatal for a series: a player who switches from a Solaire to a Bulwark
     * between rounds 3 and 4 would find the same seven pilot names sitting in
     * different cars, and the standings would still look perfectly consistent
     * while ranking a field that had been swapped out underneath them. That is
     * the single most likely way this feature ships looking finished and being
     * hollow, so in circuit mode the grid is read from the frozen one instead.
     *
     * Slot 0 always follows the player's current garage choice -- their car is
     * theirs to change, and circuit.ts's applyRound writes it back into the
     * grid so the standings show what they last drove. Slots 1-7 come from the
     * save, aiSkill included, so even a later change to the skill formula
     * cannot re-tune a series someone is halfway through.
     */
    const grid = this.circuitActive && this.circuit ? this.circuit.grid : null
    if (grid && grid.length === RACER_COUNT) {
      for (let i = 0; i < RACER_COUNT; i++) {
        if (i === 0) {
          chassisIds.push(this.selection.chassisId)
          pilotIds.push(this.selection.pilotId)
        } else {
          chassisIds.push(grid[i].chassisId)
          pilotIds.push(grid[i].pilotId)
        }
        aiSkill.push(grid[i].aiSkill)
      }
    } else {
      const pool = CHASSIS.filter((c) => c.id !== this.selection.chassisId)
      for (let i = 0; i < RACER_COUNT; i++) {
        if (i === 0) { chassisIds.push(this.selection.chassisId); pilotIds.push(this.selection.pilotId) }
        else {
          chassisIds.push(pool[(i - 1) % pool.length].id)
          pilotIds.push(PILOTS[i % PILOTS.length].id)
        }
        aiSkill.push(i === 0 ? 0 : 2 + (i % 3))
      }
    }

    const config: SimConfig = {
      seed: (Math.random() * 0xffffffff) >>> 0,
      totalLaps: T.race.totalLaps,
      racerCount: RACER_COUNT,
      trackId: this.track.def.id,
      chassisIds, pilotIds,
      localRacerIndex: 0,
      aiSkill,
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
    /**
     * WHICH ROUND THIS IS.
     *
     * Null outside circuit mode, which is the whole of "single-race mode is
     * unaffected": the HUD draws nothing at all when it is not told a round,
     * so a one-off race's countdown is byte-for-byte the one that shipped.
     *
     * `roundsDone` is the rounds ALREADY banked, so the round about to be
     * driven is that plus one -- the same arithmetic the garage head and the
     * Start button use, deliberately, because three places disagreeing about
     * what round it is would be worse than none of them saying.
     */
    this.hud.setRound(this.circuitActive && this.circuit && !isComplete(this.circuit)
      ? {
        round: roundsDone(this.circuit) + 1,
        total: CIRCUIT_ROUNDS,
        trackName: this.track.def.name,
      }
      : null)
    this.cheer.reset()
    this.cheer.setLevel(this.calloutLevel)
    this.scorer.reset()
    this.captureScoreNextFrame = false
    this.scoreHud.reset()
    this.lastScore = 0
    this.lastBestCombo = 1

    this.frontEnd.hide()
    this.hud.root.style.display = ''
    this.tools.hidden = false
    this.audio.endRace()
    this.lastCount = -1
    this.goArmed = false
    this.lastMusicLap = -1
    this.audio.music(this.track.def.id, false)
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
    this.closePodium()
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
    // ARMED HERE, TAKEN ONE SCORING FRAME LATER. Not the same thing.
    //
    // Capturing on this line was wrong, and wrong by the largest award in the
    // game. `onLocalFinish` runs on the sim's finish, BEFORE the render-side
    // scorer has consumed that frame's `local.events` -- and `trackPlace`, the
    // finishing bonus, is in that list. Measured on a real race: the scorer
    // read 76,590 and the results panel printed 75,740, exactly the 850 of an
    // eighth-place finish. First place was losing 6,000.
    //
    // The reason the capture is not simply deferred to the results screen is
    // unchanged and still right: the ceremony runs the remaining cars to the
    // flag and settleRace() can fast-forward the sim, so by the time the panel
    // appears the scorer may have seen a stretch of race the player did not
    // drive. So it is taken at the END of the next scorer.frame() instead --
    // late enough to include the flag, early enough to exclude the ceremony.
    this.captureScoreNextFrame = true
    // Victory or completion, by position. Here rather than off the `finish`
    // EVENT because this function is already the one place that runs exactly
    // once on the frame the local racer takes the flag -- driving it from the
    // event list would mean carrying a second "have I done this yet" flag that
    // has to be reset in all four of the places a race can start.
    this.audio.finishSting(this.race.state.racers[this.localId].position)
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
    this.tools.hidden = true
    this.hud.setFinish(null)
    this.hud.setRound(null)
    this.cheer.reset()
    this.chase.endCinematic()
    this.input.setPadsVisible(false)
    this.audio.endRace()
    this.audio.music(null, false)
    // THE ROUND IS SCORED BEFORE THE SCREEN IS BUILT, in that order, because
    // showResults() arms the auto-switch to the standings page and that page
    // has to exist and be filled by then. setCircuit is what creates it.
    //
    // WAS IT ALREADY OVER? Asked BEFORE the round is banked, because "the
    // circuit is complete" is true from round 8 onwards and the podium is the
    // moment it BECOMES true. Without this, walking back into a finished
    // circuit and somehow racing again would replay the celebration for a race
    // that scored nothing.
    const wasComplete = this.circuit !== null && isComplete(this.circuit)
    this.scoreCircuitRound()
    if (this.circuitActive && this.circuit && !wasComplete && isComplete(this.circuit)) {
      this.beginPodium()
      return
    }
    this.phase = 'results'
    this.hud.root.style.display = 'none'
    this.showResultsScreen()
  }

  /** Build and raise the results screen. Split out of finishRace because the
   *  podium sits between the two at the end of a circuit. */
  private showResultsScreen(): void {
    if (!this.race) return
    this.frontEnd.showResults(this.race.state, this.localId, {
      score: this.lastScore,
      bestCombo: this.lastBestCombo,
    }, this.track.def.id)
    void this.publishScore()
    this.frontEnd.show('results')
  }

  // -------------------------------------------------------------------------
  // THE CHAMPIONSHIP PODIUM
  //
  // Entered from finishRace() at the exact moment round 8 is banked, and from
  // nowhere else. Everything about it is a deliberate echo of the finish
  // ceremony, because a player should not have to learn a second set of rules
  // for the second celebration in ninety seconds: the same skip guard, the
  // same edge trigger, the same "a hidden tab is skipped, not paused".
  //
  // IT PLAYS WHETHER OR NOT THE PLAYER IS ON IT. The card names where they
  // finished either way. A celebration you are locked out of is how a series
  // says the last forty minutes were somebody else's; one that says "4th, 46
  // points" while three robots dance is how it says you were in it.
  // -------------------------------------------------------------------------

  private beginPodium(): void {
    if (!this.circuit) { this.phase = 'results'; this.showResultsScreen(); return }
    const cast = podiumCast(standings(this.circuit), 0)
    // A podium with nobody on it is not a scene. Unreachable with the shipped
    // eight-car grid -- standings() returns a row per entrant -- and cheaper to
    // rule out than to debug at the end of a forty-minute series.
    if (cast.steps.length === 0) { this.phase = 'results'; this.showResultsScreen(); return }

    this.phase = 'podium'
    this.podT = 0
    this.podSkipArmed = false
    // The race world goes first. The podium needs the renderer and the scene,
    // not the track: leaving a circuit's terrain, props and sky standing under
    // it would be the most expensive frame in the game for no pixels at all.
    this.teardownWorld()
    this.podiumStage = createPodiumStage(this.scene, cast, this.quality, this.reduceMotion)
    // A fresh post chain against the SAME camera object the stage writes to.
    // See the note in buildWorld: the composer is bound to `chase.camera`, so
    // there is exactly one camera in this game and everything points it.
    this.post = this.quality.postFx
      ? createPostFx(this.renderer, this.scene, this.chase.camera, this.quality)
      : null
    this.post?.setIntensity(this.vfxGlare, this.vfxScreen)

    // WORLD UP, EXPLICITLY. ChaseCamera writes `camera.up` from the racer's
    // own frame every race (see easeUp), so on a banked grid or a gravity
    // circuit the camera arrives here still rolled onto a road that no longer
    // exists -- and `lookAt` builds its basis from `up`, so the whole podium
    // would be photographed at an angle nobody chose.
    this.chase.camera.up.set(0, 1, 0)

    // THE PODIUM OWNS THE SCREEN. In the shipping path the front end is already
    // hidden -- we arrive straight from the ceremony -- but saying so here is
    // what makes the phase self-contained rather than dependent on where it was
    // entered from, and a results panel left standing over the celebration
    // would also swallow the skip button underneath it.
    this.frontEnd.hide()
    this.fillPodiumCard(cast)
    this.hud.root.style.display = ''
    this.hud.setPodium(this.podCard)
    // The score counter lives inside the HUD root and survives `is-ceremony`,
    // because during a finish shot the run's score is still the thing the
    // player wants. There is no run here at all.
    this.scoreHud.setVisible(false)
    this.tools.hidden = true
    this.input.setPadsVisible(false)
    // The title theme, because it is the game's own anthem and a championship
    // celebrated in silence is a worse bug than a missing sound effect.
    this.audio.menuMusic('title')
  }

  /** Fill the reused card object. Runs once per podium, not per frame. */
  private fillPodiumCard(cast: PodiumCast): void {
    const lines: PodiumLine[] = []
    for (const e of cast.steps) {
      lines.push({
        place: e.place,
        pilot: pilotName(e.pilotId),
        chassis: CHASSIS_BY_ID[e.chassisId]?.name ?? e.chassisId,
        points: e.points,
        isLocal: e.isLocal,
      })
    }
    this.podCard.lines = lines
    this.podCard.tied = cast.tied
    this.podCard.canSkip = false
    const place = cast.localPlace
    const pts = cast.localPoints + (cast.localPoints === 1 ? ' point' : ' points')
    this.podCard.you = place === 1
      ? `YOU ARE THE CHAMPION — ${pts}`
      : place > 0
        ? `YOU FINISHED ${ORDINAL[place] ?? place + 'th'} — ${pts}`
        : `${pts}`
  }

  /**
   * One frame of the podium: the clock, the skip and the auto-advance.
   *
   * The skip rule is game/podium.ts's, which is the finish ceremony's: a time
   * guard AND an edge trigger. A player arrives here straight off the last
   * corner of round 8 and may well still be holding the throttle -- a level
   * test alone would end the celebration 0.7 s in, which is the bug the
   * ceremony already fixed once.
   *
   * SAMPLED HERE, ONCE. During a race the sim loop calls sample() and the
   * ceremony reads what it left in `lastInput`; there is no sim running in
   * this phase, so a stale `lastInput` would be frozen at whatever was held
   * crossing the line and the edge trigger would never see a release. So the
   * podium does its own single call per frame, which is the contract sample()
   * needs either way.
   *
   * THE SAME FOUR CONTROLS THE CEREMONY WATCHES, and throttle is deliberately
   * not among them: with auto-accelerate on, throttle is held permanently, so
   * including it would mean the skip never arms for exactly the players least
   * able to do anything about it.
   */
  private stepPodium(dt: number): void {
    this.podT += dt
    const f = this.input.sample()
    const held = f.item || f.drift || f.brake > 0.5 || f.lift
    const r = podiumSkip(this.podT, held, this.podSkipArmed)
    this.podSkipArmed = r.armed
    const canSkip = this.podT >= PODIUM_SKIP_GUARD
    if (canSkip !== this.podCard.canSkip) {
      this.podCard.canSkip = canSkip
      this.hud.setPodium(this.podCard)
    }
    if (r.skip || podiumDone(this.podT)) this.endPodium()
  }

  /** Drop the podium without advancing anywhere. For teardown paths only. */
  private closePodium(): void {
    if (this.podiumStage) { this.podiumStage.dispose(); this.podiumStage = null }
    this.hud.setPodium(null)
  }

  /** Leave the podium for the results screen. Idempotent. */
  private endPodium(): void {
    if (this.phase !== 'podium') return
    this.phase = 'results'
    this.hud.setPodium(null)
    this.hud.root.style.display = 'none'
    if (this.podiumStage) { this.podiumStage.dispose(); this.podiumStage = null }
    if (this.post) { this.post.dispose(); this.post = null }
    this.audio.menuMusic(null)
    this.showResultsScreen()
  }

  /**
   * Bank the round that just finished into the circuit standings.
   *
   * A no-op outside circuit mode, which is the whole of "single-race mode is
   * unaffected": nothing on the single-race path reads or writes the circuit.
   *
   * THE GRID IS CHECKED, NOT ASSUMED. gridMismatch is the assertion this
   * feature lives and dies by, and checking it here -- in the shipping path,
   * on every round -- is worth more than checking it in a test, because the
   * failure it catches is a wiring failure and wiring is what tests fixture
   * away. It cannot refuse the round (the race happened; throwing the result
   * away would be the worse bug) so it reports and carries on.
   */
  private scoreCircuitRound(): void {
    if (!this.circuitActive || !this.circuit || !this.race) return
    if (isComplete(this.circuit)) return
    const racers = this.race.state.racers
    if (racers.length !== CIRCUIT_GRID) return
    const bad = gridMismatch(this.circuit.grid, racers)
    if (bad.length > 0) console.warn('circuit grid drifted:', bad.join('; '))
    const trackId = trackIdForRound(roundsDone(this.circuit))
    this.circuit = applyRound(this.circuit, resultFromRace(trackId, racers.map((r) => ({
      id: r.id,
      position: r.position,
      finished: r.finished,
      finishTime: r.finishTime,
      pilotId: r.pilotId,
      chassisId: r.chassisId,
    }))))
    saveCircuit(this.circuit)
    this.publishCircuit()
  }

  /**
   * Show the board for this track, and offer to record the run if it placed.
   *
   * NOTHING IS WRITTEN UNTIL THE PLAYER NAMES IT. `qualifies` only decides
   * whether the name row appears; the submit happens in the callback below. An
   * unnamed run is not silently filed under a default, because a board full of
   * PILOT / PILOT / PILOT is worse than a board with nine rows.
   *
   * Every call here is awaited rather than assumed instant: the store is async
   * on purpose so the server implementation can drop in without this function
   * changing, and a screen that only works when the answer is synchronous would
   * have to be rewritten on that day.
   */
  private async publishScore(): Promise<void> {
    const race = this.race
    if (!race) return
    const trackId = this.track.def.id
    const local = race.state.racers[this.localId]
    const score = this.lastScore
    try {
      // RECORDS FIRST, AND UNCONDITIONALLY. Unlike the board, a record is taken
      // from every race whether or not the player names anything -- a blistering
      // lap inside a scrappy run is exactly the thing worth remembering, and it
      // would never reach a score board because the run scored badly.
      //
      // The name is whatever they last saved, which may be nothing. The car is
      // the part that carries the meaning here.
      let savedName = ''
      try { savedName = window.localStorage.getItem('sg.name') || '' } catch { /* blocked */ }
      const broken = await this.records.submit({
        trackId,
        chassisId: local.chassisId,
        pilotId: local.pilotId,
        name: savedName,
        bestLap: local.bestLap,
        // A DNF has no race time, and zero would win "fastest race" forever.
        raceTime: local.finished ? local.finishTime : 0,
        score,
        bestCombo: this.lastBestCombo,
        at: Date.now(),
      })
      this.frontEnd.setRecords(await this.records.get(trackId), broken)

      const qualifies = await this.board.qualifies(trackId, score, BOARD_SIZE)
      const rows = await this.board.top(trackId, BOARD_SIZE)
      this.frontEnd.setBoard(rows, 0, qualifies)

      // THE GLOBAL BOARD IS READ, NOT POSTED TO, UNTIL THERE IS A NAME.
      //
      // A row on a public table with nobody's name on it is worse than no row,
      // and the player has not been asked yet at this point. So the page shows
      // the world's times now and this run joins them from the save handler
      // below. Deliberately not awaited into the screen's critical path: a slow
      // or absent endpoint must not delay the results appearing.
      this.frontEnd.setGlobal({ status: 'loading', rows: [], rank: 0 })
      void this.global.top(trackId).then((b) => this.frontEnd.setGlobal(b))
      this.frontEnd.onSaveScore = async (name: string): Promise<void> => {
        const rank = await this.board.submit({
          name,
          score,
          trackId,
          chassisId: local.chassisId,
          pilotId: local.pilotId,
          position: local.position,
          bestLap: local.bestLap,
          bestCombo: this.lastBestCombo,
          at: Date.now(),
        }, BOARD_SIZE)
        const after = await this.board.top(trackId, BOARD_SIZE)
        this.frontEnd.setBoard(after, rank, false)
        // Put the name on the records this race took. NOT by re-submitting the
        // run: an exact tie does not beat the standing record, so a second
        // submit of the same figures is a no-op and the name never lands.
        await this.records.rename(trackId, broken, name)
        this.frontEnd.setRecords(await this.records.get(trackId), broken)
        // And the world board, now the run has someone's name on it. A DNF has
        // no race time but may still own a fast lap, which is worth posting.
        this.frontEnd.setGlobal(await this.global.submit({
          trackId, name, chassisId: local.chassisId, pilotId: local.pilotId,
          lap: local.bestLap,
          raceTime: local.finished ? local.finishTime : 0,
          score, position: local.position,
        }))
      }
    } catch {
      // A board that cannot be read is not a reason to break the results
      // screen. The race still happened and the score is still on it.
      this.frontEnd.setBoard([], 0, false)
      this.frontEnd.setRecords({}, [])
      this.frontEnd.setGlobal({ status: 'offline', rows: [], rank: 0 })
    }
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

    // The title race steps like any other, with one extra condition: a hidden
    // tab stops entirely. rAF throttling in a background tab is a courtesy, not
    // a guarantee, and this is a loop that would otherwise run a full race sim
    // on a phone in someone's pocket.
    const simming = (this.phase === 'racing' || this.phase === 'ceremony'
      || (this.phase === 'attract' && !this.docHidden)) && this.race !== null
    if (this.phase === 'ceremony') this.cerT += rawDt
    if (this.phase === 'attract' && !this.docHidden) this.attractT += rawDt
    if (this.phase === 'podium') this.stepPodium(rawDt)

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
        // NOT IN ATTRACT. Every racer on the title screen is AI, and a player
        // mashing keys at the menu must not reach one of them. Skipping the
        // sample outright is the guard -- there is then no path from the
        // keyboard into the title race at all, rather than a flag that some
        // later edit could read the wrong way round.
        if (this.phase !== 'attract') {
          const frame: InputFrame = this.input.sample()
          this.lastInput.lookBack = frame.lookBack
          this.lastInput.item = frame.item
          this.lastInput.drift = frame.drift
          this.lastInput.brake = frame.brake
          this.lastInput.lift = frame.lift
          this.race.setInput(this.localId, frame)
        }
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
    // THE PODIUM DRAWS FIRST AND RETURNS. It has no racers and no track, so
    // every line below it would either skip or dereference something that is
    // not there -- and the interpolation block's guard (`renderRacers.length
    // === racers.length`) happens to be false here for the wrong reason, which
    // is exactly the kind of accidental correctness that breaks later.
    if (this.phase === 'podium' && this.podiumStage) {
      this.podiumStage.update(dt, this.podT, this.chase.camera)
      if (this.post) {
        this.blastBuf.length = 0
        this.post.setBlasts(this.blastBuf)
        // No boost, no hit, no speed, no warp: nothing here is a car. The
        // bloom is the whole point of running the chain at all -- it is what
        // turns a firework from a bright dot into a firework.
        this.post.render(dt, 0, 0, 0, 0, this.reduceMotion)
      } else {
        this.renderer.render(this.scene, this.chase.camera)
      }
      return
    }

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
      const topSpeed = getDerived(local.chassisId, local.pilotId).topSpeed
      const lookBack = this.lastInput.lookBack
      const localView = this.renderRacers[this.localId].view
      if (this.phase === 'attract') {
        // THE FIXED SHOT.
        //
        // Written straight onto the chase rig's own camera rather than onto a
        // second PerspectiveCamera, and that is load-bearing: the post chain is
        // built against `this.chase.camera` (see buildWorld), so a camera
        // swapped in here would render the scene through the old one and every
        // bloom pass would be composited from the wrong view.
        const pose = attractPose(
          shotFor(this.track.def.id), this.track, this.attractT, this.reduceMotion,
          this.attractBuf,
        )
        const cam = this.chase.camera
        cam.position.copy(pose.pos)
        cam.lookAt(pose.target)
        if (cam.fov !== pose.fov) { cam.fov = pose.fov; cam.updateProjectionMatrix() }
      } else if (this.phase === 'ceremony') {
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
        // One beep per integer. Driven off the same number the start lights
        // read, so the sound and the lamp can never disagree about the count.
        if (n !== this.lastCount) {
          this.lastCount = n
          if (n > 0 && n <= 3) this.audio.cue('countdown')
        }
        // Armed by ever having BEEN in the countdown, not by the counter still
        // reading above zero.
        this.goArmed = true
      } else if (this.goArmed) {
        // THE GO HAD NEVER PLAYED. NOT ONCE.
        //
        // This used to be `else if (this.lastCount > 0)`, and `lastCount`
        // cannot be above zero by the time it is tested: `n` is
        // `ceil(countdown - 0.6)`, so it reaches 0 about six tenths of a second
        // BEFORE the phase changes, while still inside the branch above, and
        // sets lastCount to 0 on the way past. By the time the phase actually
        // flips, the guard is already false.
        //
        // Measured over a full race: `countdown` fired three times and
        // `countdownGo` fired zero. It was silent with the synth too -- this is
        // not something the sound pack broke, it is something the sound pack
        // made audible by making everything else louder.
        this.goArmed = false
        this.lastCount = 0
        this.audio.cue('countdownGo')
      }

      /**
       * THE AUDIO FRAME.
       *
       * Handed `this.eventCarry` -- the SAME array the VFX read, accumulated
       * across every sub-step of this render frame. That is what stops audio
       * from losing events at 30fps, and it comes free: the carry already
       * existed because the art had the identical problem.
       *
       * The listener is the camera, not the car. During the finish ceremony the
       * camera has left the chase rig entirely and is orbiting, and a listener
       * pinned to the car would put the crowd of engines in the wrong place for
       * the one shot the player is actually watching.
       */
      const cam = this.chase.camera
      _aFwd.set(0, 0, -1).applyQuaternion(cam.quaternion)
      _aUp.set(0, 1, 0).applyQuaternion(cam.quaternion)
      // Read `r.events`, which is where the carry above was just written BACK
      // to and is the same list the VFX pass reads a few lines further down.
      // Handing over `this.eventCarry` instead was wrong twice over: it is
      // drained to zero length by the write-back before this line runs, so
      // audio heard nothing at all; and it is SPARSE, because its slots are
      // only created for racers that have had an event, so a hole for racer 0
      // reached the planner's `for (const ev of events[i])` as undefined and
      // threw every frame. Rebuilt into a reused array rather than mapped, so
      // this costs no allocation in the render loop.
      this.audioEvents.length = st.racers.length
      for (let i = 0; i < st.racers.length; i++) this.audioEvents[i] = st.racers[i].events
      this.audio.race(
        st, this.audioEvents, this.localId,
        cam.position, _aFwd, _aUp, st.time,
        this.phase === 'racing' || this.phase === 'ceremony',
      )

      // The final-lap bed. Keyed off the local racer's lap so the swap lands
      // when the PLAYER starts their last lap, not when the leader does.
      if (this.phase === 'racing') {
        const lap = st.racers[this.localId]?.lap ?? 0
        if (lap !== this.lastMusicLap) {
          this.lastMusicLap = lap
          this.audio.music(this.track.def.id, lap >= (st.totalLaps ?? 3))
        }
      }
      // ONE TOGGLE, EVERY CONSUMER. `reduceMotion` here is the player's own
      // choice (settings panel) initialised from the OS preference, and it
      // already reaches the chase shake below and the crosswind debris. The
      // VFX pass used to read `prefers-reduced-motion` for itself, so a player
      // who turned the toggle ON with the OS preference OFF got a calm camera
      // and the full strobing effect set. Pushed every frame because it is one
      // property write and there is then no path by which the two can differ.
      if (this.vfx) this.vfx.reduceMotion = this.reduceMotion
      this.vfx?.update(dt, st, this.chase.camera.position, this.localId)
      this.trackVis?.update(dt, st.time)
      // THE CROSSWIND, HANDED OVER RATHER THAN DERIVED.
      //
      // `windPush` is the acceleration the sim actually applied to this racer
      // this frame — after the per-class scale and after the friction-budget
      // cap — and `right` is the road's own banked, gravity-aware lateral. The
      // environment recomputes neither; see CrosswindFrame in render/api.ts.
      //
      // The LIVE racer, not `localView`: the interpolated render copy is
      // rebuilt from a JSON clone taken at spawn and lags a frame, and the
      // wind is a force the player is fighting right now.
      this.wind.push = local.windPush
      const wsmp = this.track.at(local.splineS)
      this.wind.right.x = wsmp.right.x
      this.wind.right.y = wsmp.right.y
      this.wind.right.z = wsmp.right.z
      this.wind.reduceMotion = this.reduceMotion
      this.envVis?.update(dt, st.time, this.chase.camera.position, this.wind)
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

      /**
       * SCORING.
       *
       * Fed from `local.events` -- the SAME list cheer.ts reads two lines above
       * and the VFX read below, which is the list main.ts wrote the accumulated
       * sub-step events back onto. Any other source loses events at low frame
       * rates, and a lost drift release here is not a missed sound, it is
       * missing points the player has no way to notice were dropped.
       *
       * The scorer takes its seconds from `st.time`, never from `dt`, so the
       * number is the same on every machine. See src/score/scorer.ts.
       *
       * Combo rungs are routed into cheer.ts rather than announced here, so the
       * praise, the voice line and the callout setting all stay in one place.
       */
      if (this.phase !== 'attract') {
        const sc = this.scorer.frame(st, local, local.events)
        for (const rung of sc.rungs) this.cheer.comboRung(rung)
        this.scoreHud.update(sc, dt)
        // AFTER frame(), so the finishing award is in. See onLocalFinish.
        if (this.captureScoreNextFrame) {
          this.captureScoreNextFrame = false
          this.lastScore = this.scorer.score
          this.lastBestCombo = this.scorer.bestCombo
          // And the counter stops here too, so the last number the player
          // watches is the number the results screen prints. It used to keep
          // chasing through the ceremony and land on a different total, which
          // reads as the game changing its mind about what the run was worth.
          this.scoreHud.settle(this.lastScore)
        }
      }
      this.scoreHud.setVisible(this.phase === 'racing' || this.phase === 'ceremony')
      // The attract screen has no HUD -- it is display:none -- so updating it
      // would be laying out a lap counter and a minimap nobody can see, every
      // frame, on the device least able to spare it.
      if (this.phase !== 'attract') this.hud.update(st, this.localId, this.track, this.fps)

      // Neither impulse belongs to the finish shot: a camera shake and a
      // vertigo punch are both answers to something the PLAYER did, and during
      // the ceremony the car is under AI. The same argument retires both from
      // the attract shot, twice over -- there is no player there at all, and
      // the whole premise of the shot is that the camera is locked off.
      const impulsive = this.phase !== 'ceremony' && this.phase !== 'attract'
      if (impulsive && this.vfx && this.vfx.hitFlash > 0.4 && !this.reduceMotion) {
        this.chase.addShake(this.vfx.hitFlash * T.camera.shakeHit)
      }
      // Vertigo shot on a cashed-in drift. Consumed here, not in the camera:
      // the VFX pass owns the sim-frame guard, so the impulse fires exactly
      // once per release however fast the display refreshes.
      if (this.vfx && this.vfx.dollyRequest > 0) {
        if (impulsive) this.chase.addDolly(this.vfx.dollyRequest)
        this.vfx.dollyRequest = 0
      }

      const speed01 = clamp01(Math.hypot(local.vel.x, local.vel.z) / Math.max(1, topSpeed))
      // THE WARP IS THE CAMERA'S OWN IMPULSE, not a second thing derived from
      // the boost state -- which is what makes reduced motion reach the screen
      // effect: the rig zeroes its impulses under the toggle, so there is no
      // second suppression to forget.
      //
      // `warpLevel`, NOT `dollyLevel`. They are raised by the same events and
      // are separate numbers: the dolly moves the camera and opens the lens,
      // the warp grades the picture. Tying the screen to the camera's value is
      // what made calming the boost for motion comfort silently take two
      // thirds of the tunnel vision with it.
      /**
       * THE BLAST LENSES, PROJECTED.
       *
       * The composite works in screen space and the explosions happen in the
       * world, so the bridge is here: one project() per live front, at most
       * four of them, into the 0..1 UV space the pass reads.
       *
       * A front BEHIND the camera projects to a mirrored point that is still
       * on screen, which would put a lens in the middle of the frame for an
       * explosion the player cannot see -- so those are dropped rather than
       * clamped. The radius is taken as a fraction of frame WIDTH, measured by
       * projecting a second point one radius to the camera's right: doing it
       * by similar triangles instead needs the FOV, the aspect and the
       * distance, and gets the vertical wrong on every non-16:9 screen.
       */
      if (this.post) {
        const blasts = this.blastBuf
        blasts.length = 0
        const cam = this.chase.camera
        const src = this.vfx?.blasts
        if (src && src.length > 0 && !this.reduceMotion) {
          cam.updateMatrixWorld(true)
          cam.matrixWorld.extractBasis(_bR, _bU, _bF)
          for (let i = 0; i < src.length; i++) {
            const b = src[i]
            _bp.set(b.x, b.y, b.z).project(cam)
            if (_bp.z > 1) continue
            _be.set(b.x, b.y, b.z).addScaledVector(_bR, b.radius).project(cam)
            const rad = Math.abs(_be.x - _bp.x) * 0.5
            if (!(rad > 0.001)) continue
            blasts.push({
              x: _bp.x * 0.5 + 0.5,
              y: _bp.y * 0.5 + 0.5,
              radius: rad,
              // The player's speed-effect dial owns this the way it owns the
              // warp: one multiply, here, so "Speed effects: Off" is one rule
              // and not a list of exceptions.
              strength: b.strength * this.vfxScreen,
            })
          }
        }
        this.post.setBlasts(blasts)
        this.post.render(
          dt, this.vfx?.boostIntensity ?? 0, this.vfx?.hitFlash ?? 0, speed01,
          this.chase.warpLevel, this.reduceMotion,
        )
      }
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
    // Same rule for the podium, and for the same reason: there is nothing to
    // pause, and coming back to the tab must not drop in mid-celebration.
    else if (document.hidden && this.phase === 'podium') this.endPodium()
    // The title race has no pause menu to raise, so it is gated on this flag
    // instead: the loop stops stepping and stops advancing the shot's clock,
    // and picks both up where they left off. Read here rather than calling
    // document.hidden per frame in the loop.
    this.docHidden = document.hidden
    // Eight live oscillators in a backgrounded tab is a battery complaint.
    this.audio.setHidden(document.hidden)
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
    this.audio.dispose()
    this.closePodium()
    this.teardownWorld()
    disposeVehicleCache()
    this.cheer.dispose()
    this.scoreHud.dispose()
    this.hud.dispose()
    this.settings.dispose()
    this.compact.dispose()
    this.tools.remove()
    this.frontEnd.dispose()
    this.input.dispose()
    this.renderer.dispose()
  }
}

// ---------------------------------------------------------------------------
const TMP = new THREE.Vector3()

/** Place words for the podium card. Eight entrants, so eight is the end. */
const ORDINAL: readonly string[] = [
  '', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th',
]

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
  // For tools/probe-audio.mjs, which needs to know how many recorded sounds it
  // should be waiting for before it can tell "not loaded yet" from "silent".
  ;(window as unknown as { __CATALOGUE__: typeof CATALOGUE }).__CATALOGUE__ = CATALOGUE
  return game
}
