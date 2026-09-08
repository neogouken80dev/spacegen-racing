/**
 * HAZARD SIGNAL — the sim's one-shot world events, made readable by the art.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS.
 *
 * `RaceState.iceCracked` is a global, one-way latch: once the leader reaches
 * `TUNING.hazard.crackLap`, every fragile shelf on the track gives way, loses
 * its walls and turns to bare ice. The player has to SEE that, and has to see
 * afterwards that the barrier is gone — which means the road material and the
 * environment both need to know.
 *
 * They cannot ask. The render contracts in `api.ts` are
 * `TrackVisual.update(dt, time)` and `EnvironmentVisual.update(dt, time,
 * cameraPos)`; only `EntityVisuals` and `VfxSystem` are handed the RaceState,
 * and `game/main.ts` — which is the one place that owns both — is art-locked
 * this sprint. Widening the two contracts would mean editing the call site.
 *
 * So the state is published instead, by the module that already has it and
 * whose whole job is mirroring sim state into the world (`entities.ts`), and
 * read by the two art modules that need it. One writer, no back-channel: the
 * render layer still never writes a byte into RaceState, and if the contracts
 * are ever widened this file deletes cleanly — the two consumers take the same
 * two numbers from an argument instead of from here.
 *
 * The ramps live here rather than in either consumer because the road material
 * and the crack ripple have to agree about when the collapse starts and how
 * long it takes. Two independently-timed ramps is how a barrier finishes
 * falling before the ice it fell through has finished breaking.
 * ---------------------------------------------------------------------------
 */

/** Seconds the barrier takes to go through the ice. */
const COLLAPSE_TIME = 1.25

interface Hazard {
  /** The latch itself, mirrored from RaceState. */
  cracked: boolean
  /** 0 before the crack, ramping to 1 across COLLAPSE_TIME. */
  crack: number
}

const state: Hazard = { cracked: false, crack: 0 }

/**
 * Publish this frame's hazard state. Called once per rendered frame from the
 * one render module that is handed RaceState.
 *
 * `dt` rather than absolute time on purpose: a paused race stops advancing the
 * collapse, and a rebuilt world (the adaptive quality scaler can rebuild
 * mid-race) picks it up wherever it left off rather than replaying it.
 */
export function publishHazard(iceCracked: boolean, dt: number): void {
  if (iceCracked && !state.cracked) { state.cracked = true; state.crack = 0 }
  if (!iceCracked && state.cracked) { state.cracked = false; state.crack = 0 }
  if (state.cracked && state.crack < 1) {
    state.crack = Math.min(1, state.crack + Math.max(0, dt) / COLLAPSE_TIME)
  }
}

/** Collapse progress, 0..1. Read by the road material and the environment. */
export function crackProgress(): number {
  return state.crack
}

/**
 * Drop the latch. Called when a world is torn down, so a rematch does not
 * start with the barrier already through the ice.
 */
export function resetHazard(): void {
  state.cracked = false
  state.crack = 0
}
