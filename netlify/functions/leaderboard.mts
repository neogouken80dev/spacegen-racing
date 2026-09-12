/**
 * SpaceGen Racing — the global leaderboard endpoint.
 * ---------------------------------------------------------------------------
 *   GET  /api/leaderboard?track=<id>   -> { rows: [...] }
 *   POST /api/leaderboard              -> { rank, rows } | { error }
 *
 * Ranked by BEST LAP, fastest first -- the brief asked for best times, and a
 * time is the figure that means the same thing to every player regardless of
 * how long they raced or how they scored.
 *
 * WHAT THIS BOARD IS WORTH.
 *
 * Runs are posted by a web page. `rejectRun` throws out anything the sim could
 * not physically have produced and the IP bucket throws out a flood, but a
 * determined forger can read the bounds out of the bundle and post a lap just
 * inside them. Nothing here can tell that from a real one. The board is
 * therefore labelled UNVERIFIED where players see it, and the honest fix --
 * re-simulating a submitted input trace -- is a pass of its own.
 *
 * STORAGE IS ONE BLOB PER TRACK, REWRITTEN WHOLE.
 *
 * Ten rows of a few dozen bytes. A read-modify-write of that is cheaper than
 * any cleverer structure, and the whole board fits in one request. Two players
 * finishing in the same instant can lose one of the two writes; at this size
 * that is a row, not a corruption, and buying a lock for it would cost more
 * than the data is worth.
 */
import type { Context } from '@netlify/functions'
import { getStore } from '@netlify/blobs'
import { cleanName, rejectRun, type GlobalRun } from '../../src/score/verify'

const BOARD_SIZE = 10
/** Submissions allowed per IP per window. A race takes minutes; this is slack. */
const RATE_LIMIT = 10
const RATE_WINDOW_MS = 60_000

interface Row {
  name: string
  lap: number
  raceTime: number
  score: number
  chassisId: string
  pilotId: string
  position: number
  at: number
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      // The board is public and read-only over GET; a short cache keeps a busy
      // results screen from hitting the store on every tab click.
      'cache-control': status === 200 ? 'public, max-age=15' : 'no-store',
    },
  })

/** Fastest lap first; an exact tie keeps whoever got there first. */
function compare(a: Row, b: Row): number {
  if (a.lap !== b.lap) return a.lap - b.lap
  return a.at - b.at
}

function sanitise(raw: unknown): Row | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) ? v : -1)
  const lap = num(r.lap)
  if (lap <= 0) return null
  return {
    name: cleanName(typeof r.name === 'string' ? r.name : ''),
    lap,
    raceTime: Math.max(0, num(r.raceTime)),
    score: Math.max(0, num(r.score)),
    chassisId: typeof r.chassisId === 'string' ? r.chassisId.slice(0, 24) : '',
    pilotId: typeof r.pilotId === 'string' ? r.pilotId.slice(0, 24) : '',
    position: Math.max(1, Math.round(num(r.position))),
    at: Math.max(0, num(r.at)),
  }
}

async function readBoard(track: string): Promise<Row[]> {
  const store = getStore('spacegen-leaderboard')
  const raw = await store.get(track, { type: 'json' }) as unknown
  if (!Array.isArray(raw)) return []
  const rows: Row[] = []
  for (const r of raw) {
    const row = sanitise(r)
    if (row) rows.push(row)
  }
  return rows.sort(compare).slice(0, BOARD_SIZE)
}

/**
 * Has this address posted too often?
 *
 * A fixed window rather than a sliding one: it is a handful of writes either
 * way and the failure mode of a fixed window -- twice the limit across a
 * boundary -- is irrelevant at ten per minute.
 */
async function rateLimited(ip: string): Promise<boolean> {
  if (!ip) return false
  const store = getStore('spacegen-ratelimit')
  const now = Date.now()
  const key = `ip-${ip}`
  const cur = await store.get(key, { type: 'json' }) as { n: number; t: number } | null
  if (!cur || typeof cur.t !== 'number' || now - cur.t > RATE_WINDOW_MS) {
    await store.setJSON(key, { n: 1, t: now })
    return false
  }
  if (cur.n >= RATE_LIMIT) return true
  await store.setJSON(key, { n: cur.n + 1, t: cur.t })
  return false
}

export default async (req: Request, ctx: Context): Promise<Response> => {
  try {
    if (req.method === 'GET') {
      const track = new URL(req.url).searchParams.get('track') || ''
      if (!track) return json({ error: 'no-track' }, 400)
      return json({ rows: await readBoard(track) })
    }

    if (req.method !== 'POST') return json({ error: 'method' }, 405)

    const body = await req.json().catch(() => null) as Partial<GlobalRun> | null
    if (!body) return json({ error: 'bad-body' }, 400)

    const run: GlobalRun = {
      trackId: String(body.trackId ?? ''),
      name: cleanName(String(body.name ?? '')),
      chassisId: String(body.chassisId ?? ''),
      pilotId: String(body.pilotId ?? ''),
      lap: Number(body.lap),
      raceTime: Number(body.raceTime),
      score: Number(body.score),
      position: Number(body.position),
    }

    // Bounds BEFORE the rate-limit write: a malformed post should not cost a
    // slot in someone's bucket, and validation is the cheaper of the two.
    const why = rejectRun(run)
    if (why) return json({ error: why }, 422)

    const ip = ctx.ip || req.headers.get('x-nf-client-connection-ip') || ''
    if (await rateLimited(ip)) return json({ error: 'rate-limited' }, 429)

    const rows = await readBoard(run.trackId)
    const row: Row = {
      name: run.name, lap: run.lap, raceTime: run.raceTime, score: run.score,
      chassisId: run.chassisId, pilotId: run.pilotId, position: run.position,
      at: Date.now(),
    }
    rows.push(row)
    rows.sort(compare)
    const kept = rows.slice(0, BOARD_SIZE)
    const rank = kept.indexOf(row)

    // Only write when the board actually changed. A slow lap from a busy track
    // is the common case and it should cost a read, not a read and a write.
    if (rank >= 0) {
      await getStore('spacegen-leaderboard').setJSON(run.trackId, kept)
    }
    return json({ rank: rank < 0 ? 0 : rank + 1, rows: kept })
  } catch (e) {
    // Never leak an internal message to a game client. The board going quiet is
    // a handled state on the other end; a stack trace is not.
    console.error('leaderboard', e)
    return json({ error: 'server' }, 500)
  }
}

export const config = { path: '/api/leaderboard' }
