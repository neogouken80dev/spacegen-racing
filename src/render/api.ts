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

export interface EnvironmentVisual {
  group: THREE.Group
  update(dt: number, time: number, cameraPos: Vec3): void
  dispose(): void
}

export interface VfxSystem {
  group: THREE.Group
  /** Set from `Track.hasGravity`. Switches every per-racer effect from a
   *  compass-yaw + world-+Y basis to the racer's own (fwd, up) frame. */
  gravity: boolean
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
