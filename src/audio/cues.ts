/**
 * SpaceGen Racing — the menu cue line.
 * ---------------------------------------------------------------------------
 * uiMove, uiSelect, uiBack and uiStart were cut, levelled, catalogued and
 * preloaded on every unlock -- four files downloaded by every player -- and
 * never once played, because nothing in the front end could reach the
 * AudioSystem. The Game owns that, builds the front end, and never handed it a
 * handle; the front end knows only that buttons were pressed.
 *
 * Threading a callback through the constructor would work and would also be
 * one more thing the Game has to remember to wire. This is narrower: the
 * AudioSystem registers itself here when it is built and unregisters when it
 * is torn down, and anything that wants a menu cue calls `cue()`. With no
 * system registered -- node tests, a device with no Web Audio -- a cue is a
 * no-op, which is the audio module's whole failure contract anyway.
 *
 * ONLY FLAT, UNPLANNED ONE-SHOTS COME THIS WAY. Anything that happens in a race
 * goes through the planner, which owns every repeat floor and the rule that the
 * player's own sounds are never crowded out; a menu has none of those
 * problems, which is why it can take the short road.
 */
import type { SoundId } from './api'

type Sink = (id: SoundId) => void

let sink: Sink | null = null

/** Called by the AudioSystem when it is built. */
export function setCueSink(fn: Sink): void {
  sink = fn
}

/** Called on dispose. Only clears the line if it is still `fn`'s. */
export function clearCueSink(fn: Sink): void {
  if (sink === fn) sink = null
}

/** Play a flat one-shot now, if there is anything to play it on. */
export function cue(id: SoundId): void {
  if (sink) sink(id)
}
