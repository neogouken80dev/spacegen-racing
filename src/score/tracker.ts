/**
 * SpaceGen Racing — WHAT ONE RACE PROVED, COLLECTED ONE SIM STEP AT A TIME.
 * ---------------------------------------------------------------------------
 * The achievements need facts the game never kept: who hit whom, whether a
 * lap touched a wall, how long the car was in the air, whether the player was
 * ever running last. This reads them off the race as it runs and hands the
 * finished set to content/achievements.ts, which decides what they earn.
 *
 * Pure, like the Scorer: no DOM, no storage, no sim mutation. It READS a
 * `RaceState` and nothing else, so a real headless race can drive it in a
 * test exactly as game/main.ts does -- which is how tests/achievements.test.ts
 * proves each signal fires rather than trusting that it would.
 *
 * ===========================================================================
 * ONCE PER SIM STEP, NOT PER RENDER FRAME, AND WHY THAT IS THE WHOLE DESIGN
 *
 * main.ts calls `step()` inside its fixed-step loop, beside
 * `eventCarry.collect()`, right after `race.step()` and the victory-lap pass.
 * So the tracker sees every step exactly once at any display rate -- none on a
 * 144 Hz frame that ran no step, five on a 30 Hz frame that ran five. That is
 * the property the scorer had to be fixed for (game/eventCarry.ts: a fast
 * monitor scored every award twice), and here it is structural rather than
 * guarded: there is no frame to double-count, because frames never reach this
 * file. tests/achievements.test.ts drives one race at 60, 120 and 144 Hz and
 * asserts identical facts.
 *
 * It is also why this reads `r.events` straight after the step, before the
 * carry has touched them: at that moment each list holds exactly one step's
 * events, in the order the sim pushed them -- stepVehicle's (drift releases,
 * wall contacts) before resolveLaps' (lap, finish), and the victory-lap
 * pass's AFTER `finish`. The order is load-bearing; see `step`.
 *
 * ===========================================================================
 * THE DEFINITIONS LIVE IN content/achievements.ts (`RaceFacts`), in one list,
 * so the sentences on the badges and the events that count them are argued in
 * one place. This file is their implementation and says nothing new.
 */
import {
  RAN_LAST_AFTER, RAN_LAST_HOLD, emptyFacts, type RaceFacts,
} from '../content/achievements'
import type { CircuitEvidence } from '../content/avatars'
import type { Difficulty } from '../content/difficulty'
import type { RacePhase, RaceState } from '../sim/types'

/** What the host knows about a race that the sim does not. */
export interface RaceContext {
  difficulty: Difficulty
  multiplayer: boolean
  /** Scorer.score and Scorer.bestCombo, as captured at the flag. */
  score: number
  bestCombo: number
  circuit: CircuitEvidence | null
  sweep: boolean
}

export class RaceTracker {
  private active = false
  private localId = -1
  private trackId = ''
  /** The race's phase after the PREVIOUS step, which is its phase as this
   *  step began. See `live`. */
  private prevPhase: RacePhase = 'countdown'
  private prevTime = 0
  /** The player's `finish` event has been read. Nothing counts after it. */
  private done = false
  private lapDirty = false
  private wasRespawning = false
  private prevAir = 0
  private greenAt = -1
  private lastHeld = 0
  /** Airtime in seconds, as a float; floored to milliseconds on the way out. */
  private air = 0
  private readonly f: RaceFacts = emptyFacts()
  private stepsSeen = 0
  /** The next step follows a stretch this tracker did not see. See markPartial. */
  private rebase = false

  /**
   * Bumped whenever something a mid-race unlock could read has moved: a clean
   * lap, a SINGULARITY release, a knockout, a weapon hit, lap 1 closing, a
   * whole second of airtime. The host compares it to the value it last acted
   * on, so the (cheap, but not free) mid-race preview runs a handful of times
   * a race rather than every frame.
   */
  changed = 0

  /** Start watching a race. The previous one, if any, is forgotten. */
  begin(localId: number, trackId: string): void {
    this.active = localId >= 0
    this.localId = localId
    this.trackId = trackId
    this.prevPhase = 'countdown'
    this.prevTime = 0
    this.done = false
    this.lapDirty = false
    this.wasRespawning = false
    this.prevAir = 0
    this.greenAt = -1
    this.lastHeld = 0
    this.air = 0
    this.stepsSeen = 0
    this.rebase = false
    Object.assign(this.f, emptyFacts(trackId))
    this.changed++
  }

  /** Stop watching. `step` is then a no-op, which is what the attract loop wants. */
  end(): void {
    this.active = false
  }

  get watching(): boolean { return this.active }

  /** Steps observed since `begin`. */
  get steps(): number { return this.stepsSeen }

  /**
   * Some steps of this race were stepped where the tracker could not see them.
   *
   * A multiplayer rejoin rebuilds the round and replays its tape synchronously
   * (game/main.ts `resync`), outside the render loop and so outside `step`. The
   * replayed stretch is simply unseen: every tally here can only have been
   * UNDER-counted by it, which is safe, but anything proved by an absence --
   * no wall touched, no weapon taken -- could be a contact that happened in the
   * dark. RaceFacts.partial withholds exactly those.
   *
   * The step after it is a REBASE, not a delta: the car's air clock, its
   * respawn flag and the race clock all jumped across the replay, and reading
   * the jump as one step's change would credit seconds of airtime or of
   * running last that happened out of sight.
   */
  markPartial(): void {
    if (!this.active) return
    this.f.partial = true
    this.rebase = true
    this.changed++
  }

  /**
   * One sim step. Call after `race.step()` (and `stepCeremony()`), once.
   *
   * LIVENESS IS DECIDED BY HOW THE STEP BEGAN. The race was racing and the
   * player had not taken the flag -- which is the scorer's `live` read from
   * the other side of the step, and the reason a lap that closes and finishes
   * the race in one step still counts: its `lap` event arrives with
   * `finished` already true, and asking after the fact would throw away the
   * last lap of every race. Within the step, the player's own list is read in
   * the order the sim wrote it and abandoned at `finish`, because the victory
   * lap's events (the AI driving the player's car round again) are appended
   * after it by `stepCeremony` and are not the player's.
   */
  step(st: RaceState): void {
    if (!this.active) return
    const me = st.racers[this.localId]
    if (!me) return
    this.stepsSeen++
    if (this.rebase) {
      this.rebase = false
      this.prevTime = st.time
      this.prevAir = me.airTime
      this.wasRespawning = me.respawnTime > 0
      this.lastHeld = 0
    }
    const dt = this.prevTime > 0 ? Math.max(0, st.time - this.prevTime) : 0
    const live = this.prevPhase === 'racing' && !this.done
    const f = this.f

    for (const e of me.events) {
      if (this.done) break
      switch (e.t) {
        case 'launch':
          // Graded during the countdown, so before the race is "live". It is
          // resolved once per racer by the sim; the guard is belt and braces.
          if (e.grade === 'perfect' && !f.perfectLaunch) { f.perfectLaunch = true; this.changed++ }
          break
        case 'wall':
          if (live) { this.lapDirty = true; f.dirtyRace = true }
          break
        case 'hit':
          if (live) { f.hitsTaken++; this.changed++ }
          break
        case 'driftEnd':
          if (live && e.tier === 3) { f.singularity++; this.changed++ }
          break
        case 'lap':
          if (!live) break
          f.lapsSeen++
          if (!this.lapDirty) f.cleanLaps++
          this.lapDirty = false
          // Read AFTER resolveLaps and updatePositions, which both ran inside
          // this step: the position the player held as the lap closed.
          if (e.lap === 1) f.lap1Position = me.position
          this.changed++
          break
        case 'finish':
          this.done = true
          break
        default:
          break
      }
    }

    if (live) {
      // WHO HIT WHOM. Every rival's list, for a `hit` naming the player --
      // which is only possible because sim/types.ts now carries `by`.
      for (const r of st.racers) {
        if (r.id === me.id) continue
        for (const e of r.events) {
          if (e.t !== 'hit' || e.by !== me.id) continue
          f.weaponHits++
          if (e.item !== 'gravityWell') f.knockouts++
          this.changed++
        }
      }

      // A respawn dirties the lap it happens on, whatever the walls did.
      const respawning = me.respawnTime > 0
      if (respawning && !this.wasRespawning) { this.lapDirty = true; f.dirtyRace = true }

      // The sim's own air clock: the time `airTime` spent counting UP. It only
      // counts in the ballistic, falling and deck-gone branches of
      // sim/vehicle.ts, and resets on landing, so a positive step is exactly
      // one step of what the sim itself calls being in the air.
      if (me.airTime > this.prevAir) {
        const before = Math.floor(this.air)
        this.air += me.airTime - this.prevAir
        if (Math.floor(this.air) !== before) this.changed++
      }

      // RUNNING LAST: held, and only once the start has settled.
      if (this.greenAt >= 0 && st.time - this.greenAt >= RAN_LAST_AFTER
        && me.position >= st.racers.length) {
        this.lastHeld += dt
        if (this.lastHeld >= RAN_LAST_HOLD && !f.ranLast) { f.ranLast = true; this.changed++ }
      } else {
        this.lastHeld = 0
      }
    }
    this.wasRespawning = me.respawnTime > 0
    this.prevAir = me.airTime

    if (this.greenAt < 0 && st.phase === 'racing') this.greenAt = st.time
    this.prevPhase = st.phase
    this.prevTime = st.time
  }

  /**
   * Everything the race proved, finished with what only the final state and
   * the host know. Safe to call mid-race: the HUD's preview does, with
   * `finished` then false and every result-gated claim therefore withheld.
   */
  facts(st: RaceState, ctx: RaceContext): RaceFacts {
    const me = st.racers[this.localId]
    const out: RaceFacts = { ...this.f, lapTimes: [], airtimeMs: Math.floor(this.air * 1000) }
    out.trackId = this.trackId
    out.difficulty = ctx.difficulty
    out.multiplayer = ctx.multiplayer
    out.score = ctx.score
    out.bestCombo = ctx.bestCombo
    out.circuit = ctx.circuit
    out.sweep = ctx.sweep
    out.laps = st.totalLaps
    if (!me) return out
    out.chassisId = me.chassisId
    out.finished = me.finished
    out.position = me.position
    // The sim's own lap times, not the tracker's: a lap time is state the sim
    // keeps, so it is right even for a race the tracker only partly saw.
    out.lapTimes = me.lapTimes.slice()
    out.winMargin = Number.POSITIVE_INFINITY
    if (me.finished && me.position === 1) {
      // The ceremony settles the field to the flag before this is read (see
      // main.ts `settleRace`), so P2 has a finish time unless the settle hit
      // its step cap -- in which case there is no margin to speak of.
      for (const r of st.racers) {
        if (r.position === 2 && r.finished) out.winMargin = r.finishTime - me.finishTime
      }
    }
    return out
  }
}
