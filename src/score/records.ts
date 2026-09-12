/**
 * SpaceGen Racing — track records.
 * ---------------------------------------------------------------------------
 * Four bests per circuit, and WHICH CAR SET THEM.
 *
 * RECORDS ARE NOT THE LEADERBOARD, and keeping them apart is the whole design.
 * The board in board.ts ranks whole RUNS by score, holds ten of them, and only
 * accepts one the player has chosen to name. A record is a single best NUMBER,
 * there is exactly one of each, and it is taken from every race automatically.
 *
 * That difference matters in play. A blistering lap inside a scrappy race would
 * never reach a score board -- the run scored badly -- and it is exactly the
 * thing a driver wants remembered. Tying the two together would mean the only
 * laps the game recalls are the ones that happened during a good race, which is
 * the wrong relationship between them.
 *
 * THE VEHICLE IS PART OF THE RECORD, not a decoration on it. "Fastest lap here
 * is 49.08" is trivia; "fastest lap here is 49.08 in a Bulwark" is a claim a
 * player can argue with and go try to beat, and it is the question the roster
 * exists to pose. Pilot rides along for the same reason now that pilots carry
 * stats.
 */
import type { ScoreStore } from './api'

/** The four things worth remembering per circuit. */
export type RecordId = 'fastestLap' | 'fastestRace' | 'highestScore' | 'bestCombo'

/** Fixed order, and the labels the screen shows. Adding a fifth is one entry. */
export const RECORD_ORDER: readonly { id: RecordId; label: string }[] = [
  { id: 'fastestLap', label: 'Fastest Lap' },
  { id: 'fastestRace', label: 'Fastest Race' },
  { id: 'highestScore', label: 'Highest Score' },
  { id: 'bestCombo', label: 'Best Combo' },
]

/**
 * Which direction is better.
 *
 * Stated as data rather than as an `if` in the comparison, because the two time
 * records and the two score records disagree and a hand-written comparison that
 * gets one of them backwards produces a record that can only get WORSE -- which
 * looks like a working feature until someone drives a good lap.
 */
export const RECORD_LOWER_IS_BETTER: Record<RecordId, boolean> = {
  fastestLap: true,
  fastestRace: true,
  highestScore: false,
  bestCombo: false,
}

export interface RecordEntry {
  /** Seconds for the time records, points for score, a multiplier for combo. */
  value: number
  chassisId: string
  pilotId: string
  /** Whatever name the player last saved. May be empty -- the car is the point. */
  name: string
  /** Epoch ms. Used only to keep the FIRST holder on an exact tie. */
  at: number
}

export type TrackRecords = Partial<Record<RecordId, RecordEntry>>

/** One race's candidate figures, offered to every record at once. */
export interface RunRecord {
  trackId: string
  chassisId: string
  pilotId: string
  name: string
  bestLap: number
  raceTime: number
  score: number
  bestCombo: number
  at: number
}

/**
 * Is `next` a better `id` than `prev`?
 *
 * A null previous record is always beaten -- an empty slot is not a record to
 * defend. An exact tie is NOT beaten, so the first driver to reach a figure
 * keeps it; a later identical run has not done anything better.
 */
export function beats(id: RecordId, next: number, prev: RecordEntry | undefined): boolean {
  if (!isFinite(next) || next <= 0) return false
  if (!prev) return true
  return RECORD_LOWER_IS_BETTER[id] ? next < prev.value : next > prev.value
}

/** The figure a run offers for each record. */
export function valueFor(id: RecordId, run: RunRecord): number {
  switch (id) {
    case 'fastestLap': return run.bestLap
    case 'fastestRace': return run.raceTime
    case 'highestScore': return run.score
    case 'bestCombo': return run.bestCombo
  }
}

/**
 * Apply a run to a set of records, returning the new set and what it broke.
 *
 * Pure: it takes the old records and gives back new ones rather than mutating,
 * so the "what did this race achieve" question is answered by comparing two
 * values instead of by watching for side effects.
 */
export function applyRun(
  prev: TrackRecords, run: RunRecord,
): { next: TrackRecords; broken: RecordId[] } {
  const next: TrackRecords = { ...prev }
  const broken: RecordId[] = []
  for (const { id } of RECORD_ORDER) {
    const v = valueFor(id, run)
    if (!beats(id, v, prev[id])) continue
    next[id] = {
      value: v, chassisId: run.chassisId, pilotId: run.pilotId,
      name: run.name, at: run.at,
    }
    broken.push(id)
  }
  return { next, broken }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const PREFIX = 'sg.records.'
const VERSION = 1

const num = (v: unknown, d: number): number =>
  typeof v === 'number' && isFinite(v) ? v : d

/**
 * Rebuild one record from storage. Everything here is untrusted -- an older
 * build, a hand-edited value, a half-finished write -- and a screen that throws
 * while reading a record is a worse outcome than a record that is missing.
 */
function sanitise(raw: unknown): RecordEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const value = num(r.value, -1)
  if (value <= 0) return null
  return {
    value,
    chassisId: typeof r.chassisId === 'string' ? r.chassisId : '',
    pilotId: typeof r.pilotId === 'string' ? r.pilotId : '',
    name: typeof r.name === 'string' ? r.name.slice(0, 12) : '',
    at: num(r.at, 0),
  }
}

/**
 * The same shape as ScoreStore and for the same reason: this is going server
 * side with the leaderboard, and the callers have to already be written for an
 * answer that does not arrive immediately.
 */
export interface RecordStore {
  get(trackId: string): Promise<TrackRecords>
  /** Apply a run. Returns which records it broke, in RECORD_ORDER. */
  submit(run: RunRecord): Promise<RecordId[]>
  /**
   * Put a name on records already taken by this race.
   *
   * Needed because records are filed the moment the flag drops, before the
   * player has been asked for a name -- and re-submitting the same run once
   * they have typed one does NOT work: an exact tie does not beat the standing
   * record, so the second submit is a no-op and the name never lands. That is
   * a real bug I wrote and then found by reading my own comment back, which is
   * why this exists as its own operation rather than a clever reuse of submit.
   */
  rename(trackId: string, ids: readonly RecordId[], name: string): Promise<void>
  clear(trackId?: string): Promise<void>
}

class LocalRecordStore implements RecordStore {
  async get(trackId: string): Promise<TrackRecords> {
    try {
      const raw = window.localStorage.getItem(PREFIX + trackId)
      if (!raw) return {}
      const parsed = JSON.parse(raw) as { v: number; r: Record<string, unknown> }
      if (!parsed || parsed.v !== VERSION || !parsed.r) return {}
      const out: TrackRecords = {}
      for (const { id } of RECORD_ORDER) {
        const e = sanitise(parsed.r[id])
        if (e) out[id] = e
      }
      return out
    } catch {
      return {}
    }
  }

  async submit(run: RunRecord): Promise<RecordId[]> {
    const prev = await this.get(run.trackId)
    const { next, broken } = applyRun(prev, run)
    if (broken.length === 0) return []
    try {
      window.localStorage.setItem(PREFIX + run.trackId, JSON.stringify({ v: VERSION, r: next }))
    } catch { /* quota or blocked storage -- the race still happened */ }
    return broken
  }

  async rename(trackId: string, ids: readonly RecordId[], name: string): Promise<void> {
    if (ids.length === 0) return
    const cur = await this.get(trackId)
    let touched = false
    for (const id of ids) {
      const e = cur[id]
      if (!e || e.name === name) continue
      cur[id] = { ...e, name }
      touched = true
    }
    if (!touched) return
    try {
      window.localStorage.setItem(PREFIX + trackId, JSON.stringify({ v: VERSION, r: cur }))
    } catch { /* blocked storage */ }
  }

  async clear(trackId?: string): Promise<void> {
    try {
      if (trackId) { window.localStorage.removeItem(PREFIX + trackId); return }
      for (let i = window.localStorage.length - 1; i >= 0; i--) {
        const k = window.localStorage.key(i)
        if (k && k.startsWith(PREFIX)) window.localStorage.removeItem(k)
      }
    } catch { /* blocked storage */ }
  }
}

export function createRecordStore(): RecordStore {
  return new LocalRecordStore()
}

/** Exported for tests. */
export { sanitise as sanitiseRecord }
/** Kept so a future caller can see both stores are meant to move together. */
export type { ScoreStore }
