/**
 * achievementRun.ts — the achievements' half of a race, held by game/main.ts.
 * ---------------------------------------------------------------------------
 * main.ts is the one file that knows a race's whole life -- when it starts,
 * each sim step, the flag, the quit, the resync, the circuit that just ended --
 * and it is also the file every other feature has already made long. So the
 * achievement work lives HERE and main.ts calls it from a handful of one-line
 * hooks, each commented where it sits:
 *
 *   startRace      bank the race being abandoned, if any, then `begin`
 *   sub-step loop  `step`, beside eventCarry.collect -- once per sim step
 *   render frame   `frame`, the mid-race preview behind the HUD chip
 *   resync         `partial`: part of the round was replayed out of sight
 *   finishRace     `commit` with the flag's context, then the results strip
 *   toMenu         `commit` a quit
 *   attract/void   `end`: a race nobody is credited for
 *
 * Nothing in here touches the sim. The tracker READS a RaceState after the
 * step, so the determinism gate cannot see this file exist.
 *
 * ===========================================================================
 * SYNC, AND WHEN IT DOES NOT HAPPEN
 *
 * Progress is banked on the device first (score/progress.ts), then posted to
 * the account whenever there is one to post to. "There is one" means an
 * account service that something ELSE has already created: the profile
 * screen, the lobby, the achievements screen, or the race payout's `award`
 * (see main.ts `forwardAward`). This file never creates one itself, for the
 * reason net/index.ts gives for being lazy at all -- creating the service
 * starts the mock world's clock, and a player who only ever presses PLAY must
 * not pay for a multiplayer world because they quit a race. An account that
 * exists but has not loaded answers `notloaded`/`offline`; the store stays
 * dirty and the next profile load (main.ts `onProfileChange`) carries every
 * race banked in the meantime, because the post is the whole snapshot.
 */
import {
  SWEEP_MIN_ROUNDS, type ProfileCounts,
} from '../content/achievements'
import type { CircuitEvidence } from '../content/avatars'
import type { SeriesStanding } from '../net/types'
import {
  sharedAchievements, type AchievementStore, type ProgressAccount,
} from '../score/progress'
import { RaceTracker, type RaceContext } from '../score/tracker'
import type { RaceState } from '../sim/types'
import { CIRCUIT_ROUNDS, champion, isComplete, standings, type CircuitState } from './circuit'

/** What the run needs from the toasts. Structural, so a test can fake it. */
export interface UnlockNews {
  show(ids: readonly string[]): void
  chip(ids: readonly string[]): void
}

export interface AchievementRunDeps {
  /** Defaults to the process-wide store. */
  store?: AchievementStore
  /**
   * The account to sync with, or null when none exists yet. NEVER creates one:
   * see the header. main.ts passes net/index.ts's `existingAccountService`.
   */
  account: () => ProgressAccount | null
  news?: UnlockNews | null
  /** Timers, injectable so a test does not wait thirty real seconds. */
  setTimer?: (fn: () => void, ms: number) => number
  clearTimer?: (id: number) => void
}

/**
 * A little over the store's own gap, so a retry never arrives a millisecond
 * early and spends itself on a 'pace' answer.
 */
const RETRY_SLACK_MS = 500

export class AchievementRun {
  readonly tracker = new RaceTracker()
  readonly store: AchievementStore
  private readonly deps: AchievementRunDeps
  /** `tracker.changed` and the best combo the last preview ran against. */
  private seen = -1
  private combo = 0
  /** Achievement ids already announced by the chip this race. */
  private readonly chipped = new Set<string>()
  private retry = 0

  constructor(deps: AchievementRunDeps) {
    this.deps = deps
    this.store = deps.store ?? sharedAchievements()
  }

  /** A race is being tracked and has not been banked yet. */
  get tracking(): boolean { return this.tracker.watching }

  /** Start watching a new race. The chip's memory starts over with it. */
  begin(localId: number, trackId: string): void {
    this.tracker.begin(localId, trackId)
    this.seen = this.tracker.changed
    this.combo = 0
    this.chipped.clear()
  }

  /** One sim step. See score/tracker.ts for why it is steps and not frames. */
  step(st: RaceState): void {
    this.tracker.step(st)
  }

  /** Part of this race was stepped out of sight (a multiplayer resync). */
  partial(): void {
    this.tracker.markPartial()
  }

  /** Stop watching WITHOUT banking: the attract loop, a voided round. */
  end(): void {
    this.tracker.end()
  }

  /**
   * THE MID-RACE CHIP. Called once per rendered frame while the player is
   * racing; does real work only when the tracker has moved (a lap closed, a
   * release, a hit landed, a second of air) or the best combo climbed -- a
   * handful of times a race, never per frame.
   *
   * `context` is a thunk because building it asks main.ts for the race's
   * difficulty, which walks the grid: cheap, but not a thing to do sixty
   * times a second for nothing.
   */
  frame(st: RaceState, bestCombo: number, context: () => RaceContext): void {
    if (!this.tracker.watching) return
    if (this.tracker.changed === this.seen && bestCombo === this.combo) return
    this.seen = this.tracker.changed
    this.combo = bestCombo
    const ids = this.store.preview(this.tracker.facts(st, context()))
      .filter((id) => !this.chipped.has(id))
    if (ids.length === 0) return
    for (const id of ids) this.chipped.add(id)
    this.deps.news?.chip(ids)
  }

  /**
   * Bank the race -- at the flag, or at a quit -- and start a sync. Returns
   * the achievement ids it newly unlocked, in catalogue order, for the
   * results strip. A second call for the same race is a no-op: banking ends
   * the watch.
   */
  commit(st: RaceState, ctx: RaceContext): string[] {
    if (!this.tracker.watching) return []
    const facts = this.tracker.facts(st, ctx)
    this.tracker.end()
    const ids = this.store.commitRace(facts)
    this.sync()
    return ids
  }

  /**
   * The toast for a banked race: everything it unlocked that the chip has not
   * already said. The results strip lists all of them regardless -- it is the
   * record; this is the news, and news is only news once.
   */
  announce(ids: readonly string[]): void {
    const fresh = ids.filter((id) => !this.chipped.has(id))
    if (fresh.length > 0) this.deps.news?.show(fresh)
  }

  /** A profile arrived from the account: Tycoon, Collector, the win floor. */
  observeProfile(p: ProfileCounts): void {
    this.store.observeProfile(p)
    // A profile is also the moment an account first becomes reachable, and
    // the store may be holding races banked before it was.
    if (this.store.unsynced) this.sync()
  }

  /**
   * Post the snapshot if there is an account; retry on pace. Fire and forget:
   * nothing waits on it, and a failure costs nothing but a later retry.
   */
  sync(): void {
    if (this.retry) return
    const account = this.deps.account()
    if (!account) return
    void this.store.syncWith(account).then((r) => {
      const again = (!r.ok && r.reason === 'pace') || (r.ok && this.store.unsynced)
      if (again) this.later(this.store.syncWaitMs() + RETRY_SLACK_MS)
    })
  }

  private later(ms: number): void {
    if (this.retry) return
    const set = this.deps.setTimer ?? ((fn: () => void, t: number): number => window.setTimeout(fn, t))
    this.retry = set(() => {
      this.retry = 0
      this.sync()
    }, ms)
  }

  dispose(): void {
    if (!this.retry) return
    const clear = this.deps.clearTimer ?? ((id: number): void => window.clearTimeout(id))
    clear(this.retry)
    this.retry = 0
  }
}

// ---------------------------------------------------------------------------
// The evidence only the host has
// ---------------------------------------------------------------------------

/**
 * What a COMPLETED Grand Circuit proves for the player (grid slot 0), or null
 * when the circuit is not complete. Called on the round that completes it.
 *
 *   won     `champion()` returned the player OUTRIGHT -- a tie at the top is
 *           not a championship, which is circuit.ts's own rule for the podium.
 *   sweep   every one of the eight rounds finished first. Read off the
 *           standings row's countback (`counts[0]` is wins), which already
 *           excludes a DNF from counting as a place.
 */
export function circuitEvidence(
  c: CircuitState, localId = 0,
): { circuit: CircuitEvidence; sweep: boolean } | null {
  if (!isComplete(c)) return null
  const row = standings(c).find((r) => r.entrant.id === localId)
  if (!row) return null
  const champ = champion(c)
  return {
    circuit: { won: champ !== null && champ.entrant.id === localId, rounds: row.rounds, dnf: row.dnf },
    sweep: row.counts[0] >= CIRCUIT_ROUNDS,
  }
}

/**
 * Did the lobby series that just ended go to the player in every round?
 *
 * Only on its LAST round and only for a series of SWEEP_MIN_ROUNDS or more: a
 * one-race "series" won is a Victory, not a sweep. `finishes` records 0 for a
 * DNF or a missed round (net/types.ts SeriesStanding), so "every entry is 1"
 * is exactly "won every round".
 */
export function seriesSweep(
  table: readonly SeriesStanding[], round: number, seriesLength: number,
): boolean {
  if (seriesLength < SWEEP_MIN_ROUNDS || round < seriesLength - 1) return false
  const me = table.find((r) => r.isLocal)
  if (!me || me.finishes.length < seriesLength) return false
  return me.finishes.every((p) => p === 1)
}
