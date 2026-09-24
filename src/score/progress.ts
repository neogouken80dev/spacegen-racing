/**
 * SpaceGen Racing — ACHIEVEMENT PROGRESS ON THIS DEVICE, AND ITS SYNC.
 * ---------------------------------------------------------------------------
 * Where earned achievements and the lifetime counters live between races:
 * localStorage first, so the wall works offline and on the first launch, and
 * the account second, so it follows the player to another device.
 *
 * Structurally the wallet's sibling (score/wallet.ts) and deliberately NOT its
 * twin, because the two are opposite kinds of number:
 *
 *   The WALLET is a cache of something the server owns. A disagreement is
 *   settled by replacement -- `adopt()`, "no merge, no max, no argument" --
 *   because a balance can legitimately go DOWN (spending) and a client that
 *   merged would put spent credits back.
 *
 *   PROGRESS cannot go down. An achievement is never taken away and a lifetime
 *   tally never runs backwards, so a disagreement is settled by MERGING:
 *   unlocks are a union and counters take the max (content/achievements.ts
 *   `mergeSnapshots`, the one rule the device, the mock and the server share).
 *   That is also why this store can sync its WHOLE snapshot every time rather
 *   than posting deltas: a post that is refused, dropped or clamped loses
 *   nothing, because the next post carries everything again. Contrast
 *   `award`, which is a delta and is dropped rather than queued.
 *
 * EVERY STORAGE ACCESS IS WRAPPED, INCLUDING THE PROPERTY LOOKUP, for the
 * reason wallet.ts, circuit.ts, settings.ts and input.ts all give: in a
 * partitioned or private context `window.localStorage` throws on the access
 * itself. A store that takes the results screen down in a private window is
 * infinitely worse than one that forgets.
 */
import {
  ACHIEVEMENTS, COUNTERS, addCounters, asSnapshot, emptySnapshot, isMark, mergeSnapshots,
  raceClaims, raceCounters, withDerived,
  type AchievementSnapshot, type CounterId, type ProfileCounts, type RaceFacts,
} from '../content/achievements'
import type { AchievementSync, Result } from '../net/types'

/** The two-method slice of Storage this needs; see net/account.ts StorageLike. */
export interface ProgressStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const LS_KEY = 'sg.achievements'

/**
 * Format version. Bumped when the SHAPE changes, which drops an old store
 * rather than misreading it -- but read below for what "drop" means here.
 *
 *   1  unlocked ids + counters + whether the account has seen the latest.
 */
const VERSION = 1

interface Stored {
  v: number
  u: string[]
  c: Partial<Record<CounterId, number>>
  /** True when something here has not reached the account yet. */
  d: boolean
}

/**
 * Shortest gap between two syncs from this device, milliseconds.
 *
 * THE SERVER'S OWN PACE, MIRRORED so an honest client never trips it.
 * net/account.ts refuses an achievement post inside ACH_MIN_GAP_MS of the last
 * one and counts the refusal on the record as forensics -- and a player who
 * quits two races in twenty seconds is not somebody to look at. So the client
 * holds its post instead and sends it when the gap has passed; nothing is lost
 * by waiting, because the post is the whole snapshot.
 *
 * Copied rather than imported for the reason net/account.ts gives about
 * mock.ts: the client half must not import the server half. The test pins the
 * two equal.
 */
export const SYNC_MIN_GAP_MS = 30_000

/** The account call this store syncs through. Structural, so a test can fake it. */
export interface ProgressAccount {
  syncAchievements(progress: AchievementSnapshot): Promise<Result<AchievementSync>>
}

export class AchievementStore {
  private snap: AchievementSnapshot = emptySnapshot()
  private profile: ProfileCounts | null = null
  private dirty = false
  private lastSyncAt = -Infinity
  private syncing = false
  private readonly storage: ProgressStorage | null

  /** Fired on every change, from any cause. */
  onChange: (s: AchievementSnapshot) => void = () => {}
  /**
   * Fired with achievement ids newly unlocked by anything other than a race
   * commit -- a profile that crossed Tycoon, a sync that brought another
   * device's unlocks home. A race commit RETURNS its unlocks instead, because
   * the results screen wants them as a list at a known moment, not as a toast
   * at an unknown one. Marks are never reported: they are progress, not news.
   */
  onUnlock: (ids: string[]) => void = () => {}

  /**
   * @param storage `undefined` for the device's localStorage, `null` for none
   *        (what a blocked context degrades to and what a test passes).
   */
  constructor(storage?: ProgressStorage | null) {
    this.storage = storage === undefined ? deviceStorage() : storage
    this.load()
  }

  /** A copy. Callers may keep it; nothing they do to it reaches the store. */
  get snapshot(): AchievementSnapshot {
    return { unlocked: [...this.snap.unlocked], counters: { ...this.snap.counters } }
  }

  /** The profile last observed, for the screens that draw Tycoon and Collector. */
  get knownProfile(): ProfileCounts | null { return this.profile }

  has(id: string): boolean {
    return this.snap.unlocked.includes(id)
  }

  counter(k: CounterId): number {
    return this.snap.counters[k] ?? 0
  }

  /** Something here has not reached the account yet. */
  get unsynced(): boolean { return this.dirty }

  /**
   * Bank one race -- finished or quit. Returns the achievement ids it newly
   * unlocked, in catalogue order (marks are banked and not reported).
   *
   * Counters add what happened; claims are content/achievements.ts's
   * `raceClaims`, which withholds everything that needs a result from a race
   * that has none. Then everything the new totals imply is derived.
   */
  commitRace(f: RaceFacts): string[] {
    const next = this.applyRace(this.snap, f)
    return this.replace(next, true)
  }

  /**
   * What banking this race RIGHT NOW would newly unlock, without banking it.
   *
   * The HUD's mid-race chip: a clean lap on lap 2 is already a Clean Lap, a
   * third SINGULARITY release is already Drift King, and a tier crossed on the
   * lifetime counter is already crossed. The race is committed once, at the
   * flag or the quit, and this is the same arithmetic run early.
   */
  preview(f: RaceFacts): string[] {
    return newAchievements(this.snap, this.applyRace(this.snap, f))
  }

  /**
   * Fold in a snapshot from elsewhere -- the account's. Untrusted, so it goes
   * through the catalogue's sanitiser. Returns the ids newly unlocked, which
   * are also announced through `onUnlock`.
   */
  merge(remote: unknown): string[] {
    const { snap } = asSnapshot(remote)
    const next = withDerived(mergeSnapshots(this.snap, snap), this.profile)
    const fresh = this.replace(next, false)
    if (fresh.length > 0) this.onUnlock(fresh)
    return fresh
  }

  /**
   * A profile arrived: re-derive what it implies (Tycoon from lifetime
   * credits, Collector from portraits owned, and the account's own wins and
   * races as a floor under Race Wins and Races Finished). Returns, and
   * announces, whatever that newly unlocked.
   */
  observeProfile(p: ProfileCounts): string[] {
    this.profile = {
      unlocked: [...p.unlocked], earned: p.earned, credits: p.credits,
      races: p.races, wins: p.wins,
    }
    const next = withDerived(this.snap, this.profile)
    const fresh = this.replace(next, true)
    if (fresh.length > 0) this.onUnlock(fresh)
    return fresh
  }

  /**
   * Send everything to the account and merge back whatever it holds.
   *
   * SELF-PACED, see SYNC_MIN_GAP_MS: inside the gap this does nothing and says
   * so ('pace'); the caller retries later and loses nothing. A failure of any
   * kind leaves the store dirty, which is the flag the next attempt reads.
   */
  async syncWith(account: ProgressAccount, now: number = Date.now()):
    Promise<{ ok: boolean; reason: string; unlocked: string[] }> {
    if (this.syncing) return { ok: false, reason: 'busy', unlocked: [] }
    if (now - this.lastSyncAt < SYNC_MIN_GAP_MS) return { ok: false, reason: 'pace', unlocked: [] }
    this.syncing = true
    const sent = this.snapshot
    let res: Result<AchievementSync>
    try {
      res = await account.syncAchievements(sent)
    } catch {
      res = { ok: false, error: 'offline' }
    } finally {
      this.syncing = false
    }
    if (!res.ok) return { ok: false, reason: res.error, unlocked: [] }
    this.lastSyncAt = now
    // Clean only if nothing was banked while the post was in flight: a race
    // committed during the round trip is not in `sent`, and marking it synced
    // would strand it until some later change dirtied the store again.
    const stillCurrent = sameSnapshot(sent, this.snap)
    this.observeProfileQuiet(res.value.profile)
    const unlocked = this.merge(res.value.progress)
    if (stillCurrent) this.dirty = false
    this.save()
    return { ok: true, reason: '', unlocked }
  }

  /** Milliseconds until a sync would be allowed, 0 if it would be now. */
  syncWaitMs(now: number = Date.now()): number {
    return Math.max(0, SYNC_MIN_GAP_MS - (now - this.lastSyncAt))
  }

  /** Wipe it. For tests, and for the settings screen's reset if one arrives. */
  reset(): void {
    this.snap = emptySnapshot()
    this.profile = null
    this.dirty = false
    this.lastSyncAt = -Infinity
    this.save()
    this.onChange(this.snapshot)
  }

  // -------------------------------------------------------------------------

  private applyRace(from: AchievementSnapshot, f: RaceFacts): AchievementSnapshot {
    const counted = addCounters(from, raceCounters(f))
    const claimed = mergeSnapshots(counted, { unlocked: raceClaims(f), counters: {} })
    return withDerived(claimed, this.profile)
  }

  /** The profile half of a sync, without announcing: the merge that follows does. */
  private observeProfileQuiet(p: ProfileCounts): void {
    this.profile = {
      unlocked: [...p.unlocked], earned: p.earned, credits: p.credits,
      races: p.races, wins: p.wins,
    }
  }

  /** Swap in a new snapshot; returns the achievement ids it added. */
  private replace(next: AchievementSnapshot, dirties: boolean): string[] {
    const fresh = newAchievements(this.snap, next)
    const moved = fresh.length > 0 || next.unlocked.length !== this.snap.unlocked.length
      || COUNTERS.some((k) => (next.counters[k] ?? 0) !== (this.snap.counters[k] ?? 0))
    this.snap = next
    if (moved) {
      if (dirties) this.dirty = true
      this.save()
      this.onChange(this.snapshot)
    }
    return fresh
  }

  private load(): void {
    const raw = readRaw(this.storage)
    if (!raw) return
    try {
      const p = JSON.parse(raw) as Partial<Stored> | null
      if (!p || typeof p !== 'object' || p.v !== VERSION) return
      // THE SAME SANITISER THE SERVER USES. A hand-edited or half-written
      // store is read id by id: a retired badge or a counter that is not a
      // number is dropped, and everything else survives.
      this.snap = asSnapshot({ unlocked: p.u, counters: p.c }).snap
      this.dirty = p.d === true
    } catch {
      // Malformed JSON. Starting empty is a correct answer -- and not a lossy
      // one for an account holder, whose server copy comes back on the next
      // sync. A thrown constructor is not a correct answer: it takes the
      // front end down with it.
    }
  }

  private save(): void {
    const s: Stored = { v: VERSION, u: this.snap.unlocked, c: this.snap.counters, d: this.dirty }
    writeRaw(this.storage, JSON.stringify(s))
  }
}

/** Achievement ids (not marks) in `next` and not in `prev`, in catalogue order. */
function newAchievements(prev: AchievementSnapshot, next: AchievementSnapshot): string[] {
  const had = new Set(prev.unlocked)
  const now = new Set(next.unlocked)
  const out: string[] = []
  for (const a of ACHIEVEMENTS) if (now.has(a.id) && !had.has(a.id)) out.push(a.id)
  return out
}

function sameSnapshot(a: AchievementSnapshot, b: AchievementSnapshot): boolean {
  if (a.unlocked.length !== b.unlocked.length) return false
  const set = new Set(a.unlocked)
  if (!b.unlocked.every((id) => set.has(id))) return false
  return COUNTERS.every((k) => (a.counters[k] ?? 0) === (b.counters[k] ?? 0))
}

/** Ids a set of unlocks holds that are marks. For the probe and the tests. */
export function marksIn(s: AchievementSnapshot): string[] {
  return s.unlocked.filter(isMark)
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function deviceStorage(): ProgressStorage | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage ?? null
  } catch {
    return null
  }
}

function readRaw(s: ProgressStorage | null): string | null {
  if (!s) return null
  try {
    return s.getItem(LS_KEY)
  } catch {
    return null
  }
}

function writeRaw(s: ProgressStorage | null, value: string): void {
  if (!s) return
  try {
    s.setItem(LS_KEY, value)
  } catch {
    /* quota, private mode, partitioned storage. Never fatal. */
  }
}

// ---------------------------------------------------------------------------
// The process-wide store
// ---------------------------------------------------------------------------

let shared: AchievementStore | null = null

/**
 * THE STORE, one per page, created lazily so importing this module touches no
 * storage -- the same reason `sharedWallet` is lazy. The race path, the
 * achievements screen and the in-race panel all read this one; two instances
 * would each hold half the truth and overwrite each other's saves.
 */
export function sharedAchievements(): AchievementStore {
  if (!shared) shared = new AchievementStore()
  return shared
}

/** For tests: drop the process store so cases do not leak into each other. */
export function resetSharedAchievements(): void {
  shared = null
}

/** The storage key, for a probe that wants to seed or wipe it. */
export const ACHIEVEMENTS_KEY = LS_KEY
