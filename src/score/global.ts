/**
 * SpaceGen Racing — the global leaderboard, client side.
 * ---------------------------------------------------------------------------
 * Talks to the Netlify function in netlify/functions/leaderboard.mts.
 *
 * OFFLINE IS A FIRST-CLASS STATE, NOT AN ERROR PATH.
 *
 * The endpoint is not there when the site is served from `vite dev`, when the
 * function has not been deployed, when Blobs is not enabled on the site, or
 * when the player has no connection. All four look identical from here and all
 * four are ordinary: the tab says the board is unreachable and the rest of the
 * results screen carries on. Nothing about a race should depend on a server
 * being up.
 *
 * SUBMISSION IS BEST-EFFORT AND NEVER BLOCKS ANYTHING.
 *
 * A run is already recorded locally by the time this is called. If the post
 * fails the player keeps their local record and their local board place, and
 * loses only a row on a public table -- so it is worth one attempt and no
 * retries, no queue, and no spinner in front of the Rematch button.
 */
import { rejectRun, type GlobalRun } from './verify'

const ENDPOINT = '/api/leaderboard'
/** A results screen must not sit waiting on a slow network. */
const TIMEOUT_MS = 6000

export interface GlobalRow {
  name: string
  lap: number
  raceTime: number
  score: number
  chassisId: string
  pilotId: string
  position: number
  at: number
}

export type GlobalStatus = 'idle' | 'loading' | 'ok' | 'offline'

export interface GlobalBoard {
  status: GlobalStatus
  rows: GlobalRow[]
  /** 1-based placing of the run just submitted, or 0. */
  rank: number
}

export interface GlobalStore {
  top(trackId: string): Promise<GlobalBoard>
  /** Post a run. Resolves to the board as it stands after, or an offline board. */
  submit(run: GlobalRun): Promise<GlobalBoard>
}

const OFFLINE: GlobalBoard = { status: 'offline', rows: [], rank: 0 }

async function call(path: string, init?: RequestInit): Promise<unknown | null> {
  // AbortController rather than Promise.race: race leaves the fetch running and
  // a results screen the player has already left behind keeps a socket open.
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(path, { ...init, signal: ac.signal })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function rowsOf(payload: unknown): GlobalRow[] {
  if (!payload || typeof payload !== 'object') return []
  const raw = (payload as { rows?: unknown }).rows
  if (!Array.isArray(raw)) return []
  const out: GlobalRow[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const lap = typeof o.lap === 'number' && isFinite(o.lap) ? o.lap : -1
    if (lap <= 0) continue
    out.push({
      // Every string here was typed by a stranger and is about to be rendered.
      // The server cleans it on the way in; this cleans it again on the way
      // out, because a row written before a server-side rule existed is still
      // in the store.
      name: String(o.name ?? '').slice(0, 12),
      lap,
      raceTime: typeof o.raceTime === 'number' ? o.raceTime : 0,
      score: typeof o.score === 'number' ? o.score : 0,
      chassisId: String(o.chassisId ?? '').slice(0, 24),
      pilotId: String(o.pilotId ?? '').slice(0, 24),
      position: typeof o.position === 'number' ? o.position : 0,
      at: typeof o.at === 'number' ? o.at : 0,
    })
  }
  return out
}

class NetlifyGlobalStore implements GlobalStore {
  async top(trackId: string): Promise<GlobalBoard> {
    const payload = await call(`${ENDPOINT}?track=${encodeURIComponent(trackId)}`)
    if (!payload) return OFFLINE
    return { status: 'ok', rows: rowsOf(payload), rank: 0 }
  }

  async submit(run: GlobalRun): Promise<GlobalBoard> {
    // Checked here as well as on the server. Not for security -- this copy runs
    // on the attacker's own machine -- but so an honest client never posts a
    // DNF or a zero lap and never spends a rate-limit slot on a run that was
    // always going to be refused.
    if (rejectRun(run)) return OFFLINE
    const payload = await call(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(run),
    })
    if (!payload) return OFFLINE
    const rank = (payload as { rank?: unknown }).rank
    return {
      status: 'ok',
      rows: rowsOf(payload),
      rank: typeof rank === 'number' && rank > 0 ? rank : 0,
    }
  }
}

export function createGlobalStore(): GlobalStore {
  return new NetlifyGlobalStore()
}
