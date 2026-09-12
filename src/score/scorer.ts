/**
 * SpaceGen Racing — the scoring engine.
 * ---------------------------------------------------------------------------
 * Pure. No DOM, no Web Audio, no sim mutation. Give it the race state, the
 * local racer's events for this render frame, and it returns what the score is
 * now and what just happened to it.
 *
 * TIME COMES FROM THE SIM, NOT THE RENDERER.
 *
 * Every rate in rules.ts is per SECOND, and the only clock that may supply that
 * second is `state.time`. The renderer's delta is the wrong number twice over:
 * it varies with the machine, and it keeps running while the sim is paused mid
 * sub-step. Taking the difference in sim time between calls means a 144Hz
 * player, a 30Hz player and a player whose tab stuttered all score identically
 * for identical driving -- which tests/score.test.ts asserts by driving the
 * same scripted run at three frame rates.
 *
 * EVENTS ARE READ FROM `r.events` AFTER THE SUB-STEP WRITE-BACK.
 *
 * main.ts accumulates events across every sub-step of a render frame and writes
 * them back onto `r.events`. Reading anywhere else loses events at low frame
 * rates -- which is exactly the bug the audio system shipped with. Score is
 * worse than audio here: a lost drift release is not a missed sound, it is
 * missing points, and the player would have no way of knowing.
 */
import type { RaceState, RacerState, RacerEvent } from '../sim/types'
import type { ScoreAward, ScoreState } from './api'
import {
  AWARD_LABEL, byIndex, CHAIN_BONUS, CHAIN_MAX, CHAIN_WINDOW,
  COMBO_BREAK_FORCE, COMBO_DECAY, COMBO_GRACE, COMBO_MAX, COMBO_PER_CHAIN,
  COMBO_RATE, DRIFT_RATE, DRIFT_RELEASE, DRIFT_START, KNOCK_BASE,
  KNOCK_COOLDOWN, KNOCK_MAX, KNOCK_MIN_FORCE, KNOCK_PER_FORCE, LAP_PLACE,
  rungOf, rungProgress, TRACK_PLACE,
} from './rules'

/** Largest sim-time step this will pay for in one call. */
const MAX_STEP = 0.5

export class Scorer {
  private total = 0
  private combo = 1
  private chain = 0
  private chainLeft = 0
  /** Seconds since the last slide ended, for the combo grace. */
  private idle = 0
  private lastTime = -1
  /** Last seen `r.driftTime`, so slide seconds come from the sim, not sampling. */
  private lastDrift = 0
  private knockCooldown = 0
  private driftRate = 0
  private best = 1
  private finished = false

  get score(): number { return Math.floor(this.total) }
  get bestCombo(): number { return this.best }

  reset(): void {
    this.total = 0
    this.combo = 1
    this.chain = 0
    this.chainLeft = 0
    this.idle = 0
    this.lastTime = -1
    this.lastDrift = 0
    this.knockCooldown = 0
    this.driftRate = 0
    this.best = 1
    this.finished = false
  }

  /**
   * One render frame. `events` is the local racer's list for this frame.
   */
  frame(state: RaceState, local: RacerState, events: readonly RacerEvent[]): ScoreState {
    const awards: ScoreAward[] = []
    const rungs: number[] = []
    const rungBefore = rungOf(this.combo)

    // --- sim-time delta -----------------------------------------------------
    // A race that restarts runs the clock backwards; a race that was paused for
    // a long time produces a huge jump. Neither should pay out, so both clamp.
    const now = state.time
    let dt = this.lastTime < 0 ? 0 : now - this.lastTime
    this.lastTime = now
    if (!(dt > 0)) dt = 0
    if (dt > MAX_STEP) dt = MAX_STEP

    // Scoring is live only while the race is. The ceremony has its own copy and
    // the victory lap is AI-driven, so paying for it would be paying the
    // computer -- the same argument cheer.ts makes for staying quiet there.
    const live = state.phase === 'racing' && !this.finished

    if (this.knockCooldown > 0) this.knockCooldown = Math.max(0, this.knockCooldown - dt)
    if (this.chainLeft > 0) {
      this.chainLeft = Math.max(0, this.chainLeft - dt)
      if (this.chainLeft === 0) this.chain = 0
    }

    // --- events -------------------------------------------------------------
    /** Set by a crash this frame, so the combo cannot regrow in the same step. */
    let broke = false
    for (const ev of events) {
      switch (ev.t) {
        case 'driftStart': {
          if (!live) break
          // A slide begun inside the chain buffer is a LINK, and pays for it.
          if (this.chainLeft > 0 && this.chain < CHAIN_MAX) {
            this.chain++
            this.award(awards, 'chain', byIndex(CHAIN_BONUS, this.chain - 1))
            this.combo = Math.min(COMBO_MAX, this.combo + COMBO_PER_CHAIN)
          }
          this.award(awards, 'driftStart', DRIFT_START)
          break
        }
        case 'driftEnd': {
          if (!live) break
          // Tier -1 banked nothing, so it cashes nothing and breaks the chain:
          // a tap is not a link. Only a real slide opens the buffer.
          if (ev.tier >= 0) {
            this.award(awards, 'driftRelease', byIndex(DRIFT_RELEASE, ev.tier))
            this.chainLeft = CHAIN_WINDOW
          } else {
            this.chainLeft = 0
            this.chain = 0
          }
          break
        }
        case 'bump': {
          if (!live || this.knockCooldown > 0) break
          if (ev.force < KNOCK_MIN_FORCE) break
          // `n` points from this racer toward the other, so a positive dot with
          // our own velocity is us driving INTO them. Without this the victim
          // of a shunt is paid the same as the car that threw it -- the event
          // is fired on both cars with an identical force.
          const into = local.vel.x * ev.nx + local.vel.y * ev.ny + local.vel.z * ev.nz
          if (into <= 0) break
          const pts = Math.min(
            KNOCK_MAX,
            KNOCK_BASE + (ev.force - KNOCK_MIN_FORCE) * KNOCK_PER_FORCE,
          )
          this.award(awards, 'knock', pts)
          this.knockCooldown = KNOCK_COOLDOWN
          break
        }
        case 'wall': {
          // Only a real impact breaks the combo. `force` is the closing rate on
          // the barrier line, which a car holding a drift against the outside
          // of a corner reads near zero on -- so leaning keeps the run and
          // crashing ends it, which is the intended risk.
          if (live && ev.force >= COMBO_BREAK_FORCE) {
            this.combo = 1
            this.chain = 0
            this.chainLeft = 0
            broke = true
          }
          break
        }
        case 'lap': {
          if (!live) break
          this.award(awards, 'lapPlace', byIndex(LAP_PLACE, local.position - 1))
          break
        }
        case 'finish': {
          // Paid even though `live` is about to go false -- this IS the last
          // scoring moment of the run, and it is the biggest.
          if (this.finished) break
          this.award(awards, 'trackPlace', byIndex(TRACK_PLACE, ev.position - 1))
          this.finished = true
          break
        }
        default: break
      }
    }

    // --- the slide, paid by the second --------------------------------------
    //
    // THE COMBO IS CHANGING WHILE IT IS BEING PAID, AND THAT IS THE WHOLE
    // DIFFICULTY. Points accrue at `rate * combo`, and `combo` itself grows
    // over the same step, so paying with the combo as it stood at the START of
    // the step under-pays by half a step's growth -- every step. That error is
    // proportional to dt, which means a 15fps player and a 60fps player score
    // DIFFERENTLY for identical driving. Measured before this was fixed:
    // 10142 against 10350 over a four-second Singularity slide.
    //
    // The combo grows linearly within a step, so the trapezoid rule -- pay for
    // the AVERAGE of the combo at each end -- is not an approximation here, it
    // is exact, and the frame rate drops out of the arithmetic entirely.
    //
    // THE DRIFT SECONDS COME FROM THE SIM'S OWN CLOCK, NOT FROM SAMPLING.
    //
    // `r.driftTime` is incremented by the fixed step inside the drift branch,
    // so the change in it between two render frames is EXACTLY how much sim
    // time was spent sliding -- including the part of a frame before a slide
    // began or after it ended. Multiplying the render delta by "were we
    // drifting when I looked" instead quantises every drift to the frame
    // boundary, which is worth 337 points a race at 15fps against 60. Small,
    // but it is a real advantage to a faster machine and there is no reason to
    // carry it when the sim already counted the time properly.
    const sliding = live && local.driftSide !== 0
    const tierIdx = Math.max(0, Math.min(DRIFT_RATE.length - 1, local.driftTier + 1))
    // A drift that ended and a new one that began inside the same render frame
    // resets the clock, so a fall is "this much of the new slide", not negative.
    const dTime = local.driftTime >= this.lastDrift
      ? local.driftTime - this.lastDrift
      : local.driftTime
    this.lastDrift = local.driftTime
    const slid = sliding ? Math.min(dt, Math.max(0, dTime)) : 0
    if (sliding && slid > 0) {
      this.idle = 0
      const growth = COMBO_RATE[tierIdx]
      const c0 = this.combo
      let c1 = c0
      let avg = c0
      if (broke) {
        // A crash landed this frame. It reset the combo, and it does not get to
        // start climbing again in the same breath -- otherwise a car that was
        // still nominally sliding when it hit the wall claws back part of the
        // penalty instantly, and the reset stops meaning anything.
        avg = c0
      } else if (growth > 0 && c0 + growth * slid > COMBO_MAX) {
        // The ceiling is reached partway through the step. Split it there so
        // the clamp cannot make the answer depend on where the frame landed.
        const w = (COMBO_MAX - c0) / (growth * slid)
        avg = (c0 + COMBO_MAX) * 0.5 * w + COMBO_MAX * (1 - w)
        c1 = COMBO_MAX
      } else {
        c1 = Math.min(COMBO_MAX, c0 + growth * slid)
        avg = (c0 + c1) * 0.5
      }
      this.total += DRIFT_RATE[tierIdx] * avg * slid
      this.combo = c1
      // The DISPLAYED rate is the live one, not the averaged one: the player is
      // watching what the next second is worth, not what the last frame paid.
      this.driftRate = DRIFT_RATE[tierIdx] * c1
    } else {
      this.driftRate = 0
      // Grace, then bleed. A straight between two corners is not a mistake.
      // Only the part of this step that falls PAST the grace may decay, or a
      // coarse frame that straddles the boundary bleeds more than a fine one.
      const before = this.idle
      this.idle += dt
      if (this.idle > COMBO_GRACE && this.combo > 1) {
        const past = Math.min(dt, this.idle - Math.max(COMBO_GRACE, before))
        this.combo = Math.max(1, this.combo - COMBO_DECAY * past)
      }
    }
    if (this.combo > this.best) this.best = this.combo

    const rungAfter = rungOf(this.combo)
    for (let r = rungBefore + 1; r <= rungAfter; r++) rungs.push(r)

    return {
      total: Math.floor(this.total),
      combo: this.combo,
      comboProgress: rungProgress(this.combo),
      chain: this.chain,
      chainLeft: this.chainLeft,
      drifting: sliding,
      driftRate: this.driftRate,
      awards,
      rungs,
    }
  }

  private award(out: ScoreAward[], kind: ScoreAward['kind'], base: number): void {
    const points = base * this.combo
    this.total += points
    out.push({
      kind,
      base,
      combo: this.combo,
      points: Math.round(points),
      label: AWARD_LABEL[kind] ?? kind.toUpperCase(),
    })
  }
}
