/**
 * SpaceGen Racing — ONE-SHOT EVENTS, DELIVERED ONCE PER RENDER FRAME.
 * ---------------------------------------------------------------------------
 * `race.step()` clears every racer's `events` at the top of each step and
 * refills them with what that step produced. The render loop runs a variable
 * number of steps per frame -- none, one, or several -- and every consumer
 * (score, HUD, callouts, audio, effects) reads `r.events` once per frame. This
 * is what makes those two agree.
 *
 * SEVERAL STEPS IN ONE FRAME. Without help, the consumers would only ever see
 * the LAST step's events: delivery measured fps/60, so at 30fps half of all
 * drift releases produced no boost burst. `collect` banks every step's events
 * and `publish` writes the whole frame's worth back into `r.events` for the
 * render pass. Nothing in the sim reads `r.events` -- it is a pure output
 * channel -- so writing it back is invisible to the simulation and to the
 * determinism hash.
 *
 * NO STEPS IN ONE FRAME. This is the half that was missing. On a display
 * faster than the 60Hz sim, some frames run no step at all -- about half of
 * them at 120Hz -- and the old loop only wrote events back when a step had
 * run, so on those frames `r.events` still held the PREVIOUS step's events and
 * every consumer read them again. The scorer has no frame guard, so each award
 * was paid twice: the same Rustfall race scored 392,840 at 60Hz, 613,769 at
 * 120Hz and 702,337 at 144Hz, and because the payout is priced on score, a
 * fast monitor also minted credits. Guards had grown in the consumers that
 * noticed (cheer.ts, vfx.ts); the scorer never did. So the fix is here, at the
 * source: a frame that ran no step publishes no events, and no consumer can
 * read a step twice however it is written.
 *
 * Kept out of main.ts so tests/eventCarry.test.ts can drive the real delivery
 * code at any display rate against a real race, rather than a copy of it.
 */
import type { RacerEvent, RacerState } from '../sim/types'

export class EventCarry {
  private readonly banked: RacerEvent[][] = []

  /** After every `race.step()`: bank what that step produced. */
  collect(racers: readonly RacerState[]): void {
    for (let i = 0; i < racers.length; i++) {
      const ev = racers[i].events
      if (ev.length === 0) continue
      const b = this.banked[i] ?? (this.banked[i] = [])
      for (let e = 0; e < ev.length; e++) b.push(ev[e])
    }
  }

  /**
   * After the sub-step loop: leave in each racer's `events` exactly what this
   * frame's steps produced, and nothing at all when `steps` is zero.
   */
  publish(racers: readonly RacerState[], steps: number): void {
    for (let i = 0; i < racers.length; i++) {
      const ev = racers[i].events
      const b = this.banked[i]
      // A racer with nothing banked either ran no step or produced nothing in
      // the steps it ran; either way it has no events this frame. Clearing is
      // right in both cases: after a step, `events` is already that step's
      // (empty) list, and without one it is the previous frame's -- the stale
      // list this class exists to stop anyone reading.
      ev.length = 0
      if (steps === 0 || !b || b.length === 0) {
        if (b) b.length = 0
        continue
      }
      for (let e = 0; e < b.length; e++) ev.push(b[e])
      b.length = 0
    }
  }

  /** Drop anything banked, for a new race. */
  reset(): void {
    this.banked.length = 0
  }
}
