/**
 * Render-layer contracts. Every render module implements one of these.
 * The render layer READS sim state and never writes it.
 */
import type * as THREE from 'three'
import type { RacerState, RaceState } from '../sim/types'
import type { Track } from '../sim/track'
import type { Vec3 } from '../sim/math'

export interface VehicleVisual {
  group: THREE.Group
  /** Called once per rendered frame with the racer's current sim state. */
  update(r: RacerState, dt: number, cameraDistance: number): void
  dispose(): void
}

export interface TrackVisual {
  group: THREE.Group
  update(dt: number, time: number): void
  dispose(): void
}

/**
 * THE CROSSWIND, AS THE LOCAL RACER ACTUALLY FELT IT THIS FRAME.
 *
 * Handed to the environment so the blown-debris layer can show the player
 * which way the air is shoving them and how hard. Both numbers are READ from
 * the sim and neither is derived in the render layer:
 *
 *   - `push` is `RacerState.windPush`, which the sim publishes AFTER scaling
 *     by the chassis's `fieldForceMult` and AFTER capping against the friction
 *     budget. The render layer must never recompute it from `TrackSample.wind`
 *     — the cap folds in the chassis, the surface, the vacuum and whether the
 *     car is airborne, and a second copy of that arithmetic here is exactly
 *     how the AI's corner model drifted away from the physics for eight
 *     passes of this project.
 *   - `right` is `TrackSample.right`, the authoritative lateral direction.
 *     NOT world +X, and not `forward x up` recomputed on this side: `right` is
 *     banked and gravity-aware, and at yaw 0 it is world MINUS X.
 */
export interface CrosswindFrame {
  /** Signed m/s^2 along `right`. Positive pushes the car toward `right`. */
  push: number
  /** Unit lateral direction of the road under the local racer. */
  right: Vec3
  /** The player asked for less movement. Calms the layer; never hides it. */
  reduceMotion: boolean
}

export interface EnvironmentVisual {
  group: THREE.Group
  /**
   * `wind` is optional so a caller that has no race — the headless cost probe
   * and the terrain fixtures in tests/ — can still drive the world. Omitted,
   * the debris layer eases to nothing rather than freezing mid-gust.
   */
  update(dt: number, time: number, cameraPos: Vec3, wind?: CrosswindFrame): void
  dispose(): void
}

export interface VfxSystem {
  group: THREE.Group
  /** Set from `Track.hasGravity`. Switches every per-racer effect from a
   *  compass-yaw + world-+Y basis to the racer's own (fwd, up) frame. */
  gravity: boolean
  /**
   * THE PLAYER'S REDUCED-MOTION CHOICE, not the OS's.
   *
   * `null` means "nobody has told me", and the VFX system falls back to
   * reading `prefers-reduced-motion` itself -- which is what every caller
   * that has no settings panel (the probes, the tests) gets.
   *
   * It exists because the in-game toggle is NOT the media query: a player may
   * turn reduced motion on with the OS preference off, and that choice already
   * reaches the chase camera (`Game.reduceMotion`) and the crosswind debris
   * (`CrosswindFrame.reduceMotion`) and used to stop dead at the VFX pass. One
   * toggle, three consumers, and the one that throws the most pixels was the
   * one not listening.
   */
  reduceMotion: boolean | null
  /** Per-frame update. Reads race state to spawn effects from racer events. */
  update(dt: number, state: RaceState, cameraPos: Vec3, localId: number): void
  /** Screen-space intensity 0..1 the renderer maps to bloom / shake / blur. */
  readonly boostIntensity: number
  readonly hitFlash: number
  /**
   * One-shot dolly-zoom request for the chase camera, 0-1, raised when the
   * local racer cashes in a drift. The caller consumes it and sets it back to
   * 0. Writable on purpose: the VFX pass owns the sim-frame guard, so this is
   * how a one-shot crosses from sim-rate events to a render-rate consumer
   * without firing several times on a high-refresh display.
   */
  dollyRequest: number
  /**
   * Live shockfronts in WORLD space, for the composite's screen-space lens.
   *
   * The scene's own explosion meshes draw a dark sphere with a chromatic rim.
   * That reads as a lens and refracts nothing -- geometry cannot see the
   * pixels behind it. The composite can, because by the time it runs the scene
   * is a texture, so the same fronts are published here and bent there.
   *
   * Reused array: read it, do not retain it.
   */
  readonly blasts: readonly {
    x: number; y: number; z: number; radius: number; strength: number
  }[]
  dispose(): void
}

export interface EntityVisuals {
  group: THREE.Group
  update(dt: number, state: RaceState, time: number): void
  dispose(): void
}

export type QualityTier = 'low' | 'medium' | 'high'

export interface RenderQuality {
  tier: QualityTier
  shadows: boolean
  particleScale: number
  propDensity: number
  renderScale: number
  postFx: boolean
}

export const QUALITY_PRESETS: Record<QualityTier, RenderQuality> = {
  low:    { tier: 'low',    shadows: false, particleScale: 0.45, propDensity: 0.4, renderScale: 0.75, postFx: false },
  medium: { tier: 'medium', shadows: true,  particleScale: 0.8,  propDensity: 0.75, renderScale: 1.0,  postFx: true },
  high:   { tier: 'high',   shadows: true,  particleScale: 1.0,  propDensity: 1.0, renderScale: 1.0,  postFx: true },
}

export type { Track, RacerState, RaceState, Vec3 }
