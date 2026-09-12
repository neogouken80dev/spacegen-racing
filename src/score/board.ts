/**
 * SpaceGen Racing — the leaderboard store.
 * ---------------------------------------------------------------------------
 * Top ten per track, on this device.
 *
 * WHY THE INTERFACE EXISTS BEFORE THE SERVER DOES.
 *
 * This board is going online in a later pass, and the expensive half of that
 * change is never the storage -- it is every caller that assumed the answer was
 * available synchronously. So `ScoreStore` is async from day one and the UI is
 * already written against the slow case. Swapping in a server implementation
 * should be a new file and one line in createScoreboard().
 *
 * WHAT A LOCAL BOARD HONESTLY IS.
 *
 * It is one browser profile on one machine. Clearing site data wipes it, a
 * different browser has its own, and nothing here is shared with anyone. That
 * is stated plainly on the board screen rather than implied, because a player
 * who thinks they are on a global ladder and is not has been misled by us.
 *
 * It is also trivially editable by anyone who opens devtools, and that is FINE
 * for a local board -- the only person a local cheat deceives is the cheat. It
 * stops being fine the moment the board is shared, which is why the server pass
 * has to bring its own verification rather than trusting a posted number.
 */
import type { ScoreEntry, ScoreStore } from './api'

const PREFIX = 'sg.board.'
/** Bumped if the entry shape changes, so old rows are dropped, not misread. */
const VERSION = 1

interface Stored {
  v: number
  rows: ScoreEntry[]
}

/**
 * Best run first.
 *
 * Score decides it. The tiebreaks exist so that two identical scores are not
 * ordered by whichever was written last: a better finishing position wins,
 * then a faster best lap, then the OLDER run -- because a player who has
 * already earned a slot should not be pushed down it by repeating themselves.
 */
function compare(a: ScoreEntry, b: ScoreEntry): number {
  if (b.score !== a.score) return b.score - a.score
  if (a.position !== b.position) return a.position - b.position
  if (a.bestLap !== b.bestLap) return a.bestLap - b.bestLap
  return a.at - b.at
}

const num = (v: unknown, d: number): number =>
  typeof v === 'number' && isFinite(v) ? v : d

/**
 * Rebuild an entry from whatever was in storage.
 *
 * Everything here is untrusted: it may have been written by an older build, or
 * hand-edited, or corrupted by a half-finished write. A board that throws on
 * load takes the whole front end down with it, so anything unreadable becomes a
 * dropped row rather than an exception.
 */
function sanitise(raw: unknown): ScoreEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const score = num(r.score, -1)
  if (score < 0) return null
  const name = typeof r.name === 'string' ? r.name.slice(0, 12) : '---'
  return {
    name,
    score: Math.floor(score),
    trackId: typeof r.trackId === 'string' ? r.trackId : '',
    chassisId: typeof r.chassisId === 'string' ? r.chassisId : '',
    pilotId: typeof r.pilotId === 'string' ? r.pilotId : '',
    position: Math.max(1, Math.floor(num(r.position, 8))),
    bestLap: num(r.bestLap, 999),
    bestCombo: num(r.bestCombo, 1),
    at: num(r.at, 0),
  }
}

function read(trackId: string): ScoreEntry[] {
  try {
    const raw = window.localStorage.getItem(PREFIX + trackId)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Stored
    if (!parsed || parsed.v !== VERSION || !Array.isArray(parsed.rows)) return []
    const rows: ScoreEntry[] = []
    for (const row of parsed.rows) {
      const e = sanitise(row)
      if (e) rows.push(e)
    }
    return rows.sort(compare)
  } catch {
    // Private mode, blocked storage, or malformed JSON. An empty board is a
    // correct answer to all three; a thrown error is not.
    return []
  }
}

function write(trackId: string, rows: ScoreEntry[]): void {
  try {
    const payload: Stored = { v: VERSION, rows }
    window.localStorage.setItem(PREFIX + trackId, JSON.stringify(payload))
  } catch { /* quota or blocked storage -- the run is simply not recorded */ }
}

class LocalScoreStore implements ScoreStore {
  async top(trackId: string, limit: number): Promise<ScoreEntry[]> {
    return read(trackId).slice(0, limit)
  }

  async qualifies(trackId: string, score: number, limit: number): Promise<boolean> {
    if (score <= 0) return false
    const rows = read(trackId)
    if (rows.length < limit) return true
    return score > rows[limit - 1].score
  }

  async submit(entry: ScoreEntry, limit: number): Promise<number> {
    const rows = read(entry.trackId)
    rows.push(entry)
    rows.sort(compare)
    const kept = rows.slice(0, limit)
    write(entry.trackId, kept)
    const rank = kept.indexOf(entry)
    return rank < 0 ? 0 : rank + 1
  }

  async clear(trackId?: string): Promise<void> {
    try {
      if (trackId) { window.localStorage.removeItem(PREFIX + trackId); return }
      // Only this board's keys. Walking backwards because removeItem reindexes.
      for (let i = window.localStorage.length - 1; i >= 0; i--) {
        const k = window.localStorage.key(i)
        if (k && k.startsWith(PREFIX)) window.localStorage.removeItem(k)
      }
    } catch { /* blocked storage */ }
  }
}

export const BOARD_SIZE = 10

export function createScoreboard(): ScoreStore {
  return new LocalScoreStore()
}

/** Exported for tests: the ordering is the part worth pinning. */
export { compare as compareEntries, sanitise as sanitiseEntry }
