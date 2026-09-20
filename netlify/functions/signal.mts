/**
 * SpaceGen Racing — the WebRTC signalling endpoint.
 * ---------------------------------------------------------------------------
 *   POST /api/signal   { op: 'create' | 'list' | 'join' | 'poll' | 'send'
 *                            | 'update' | 'bye', ... }  ->  { ok, ... }
 *
 * An introduction service and nothing else. It carries offers, answers and ICE
 * candidates between two browsers that have not met, and it keeps a directory
 * of lobbies so the browser screen has something to list. Once a data channel
 * is open the peers stop talking to it entirely -- the race itself never comes
 * through here, which is the only reason polled HTTP is an acceptable
 * transport for any of it.
 *
 * WHY THERE IS ALMOST NOTHING IN THIS FILE.
 *
 * Every rule -- what a valid join is, when a lobby has gone stale, who may set
 * a status, how a mailbox is drained -- is in `src/net/signalProtocol.ts`,
 * behind a three-method `SignalStore`. This file is the Netlify Blobs adapter
 * and the rate limiter and that is all. The reason is the one netlify.toml
 * already gives for the leaderboard importing src/score/verify.ts: logic that
 * only exists inside a deployed function is logic that can only be tested by
 * deploying. Here it also lets tools/probe-netcode.mjs mount the SAME handler
 * over a Map and put two real browsers through the real protocol locally.
 *
 * COST, BECAUSE A POLLED ENDPOINT IS A BILL.
 *
 * A client polls at 1Hz only while it is negotiating -- a handful of seconds --
 * and then at HEARTBEAT_MS (10s) for as long as it sits in a lobby. Eight
 * players in a room is therefore 0.8 requests/second while connecting and
 * 0.8/10s afterwards. A browsing player costs one `list` every 4 seconds while
 * the browser screen is actually on screen. That is the entire load, and it is
 * flat in the number of races because gameplay is not on it.
 */
import type { Context } from '@netlify/functions'
import { getStore } from '@netlify/blobs'
import {
  handleSignal, type SignalRequest, type SignalStore,
} from '../../src/net/signalProtocol'

/**
 * Requests allowed per IP per window.
 *
 * MUCH HIGHER THAN THE LEADERBOARD'S TEN, and it has to be: a player joining a
 * room legitimately makes one join, then a poll a second for the few seconds
 * the handshake takes, then a send per ICE candidate. Sixty in a minute is a
 * normal join with room to spare and still stops a script opening lobbies in a
 * loop. The limiter exists to bound cost, not to police a game.
 *
 * NOTE THAT THIS SHARES A BUCKET WITH NOTHING. The leaderboard has its own
 * store and its own window; a player who has just posted a lap must not find
 * they cannot join a lobby.
 */
const RATE_LIMIT = 60
const RATE_WINDOW_MS = 60_000

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      // NEVER CACHED, at any layer. A poll whose answer is fifteen seconds old
      // is a peer who never hears the answer to their offer, and a `list` served
      // from a CDN edge is a directory that lies about who is still there.
      'cache-control': 'no-store',
    },
  })

/** The Blobs adapter. One store, three methods, no cleverness. */
const blobStore = (): SignalStore => {
  const store = getStore('spacegen-signal')
  return {
    get: (key) => store.get(key, { type: 'json' }) as Promise<unknown>,
    // `setJSON` resolves with a WriteResult the protocol has no use for -- it
    // has no compare-and-swap to check it against -- so it is dropped here
    // rather than widening `SignalStore` with a field nothing reads.
    set: async (key, value) => { await store.setJSON(key, value) },
    del: (key) => store.delete(key),
  }
}

/** Fixed window, as in the leaderboard, and for the same reason: at this size
 *  the boundary case is irrelevant and a sliding window costs a second write. */
async function rateLimited(ip: string): Promise<boolean> {
  if (!ip) return false
  const store = getStore('spacegen-ratelimit')
  const now = Date.now()
  const key = `sig-${ip}`
  const cur = await store.get(key, { type: 'json' }) as { n: number; t: number } | null
  if (!cur || typeof cur.t !== 'number' || now - cur.t > RATE_WINDOW_MS) {
    await store.setJSON(key, { n: 1, t: now })
    return false
  }
  if (cur.n >= RATE_LIMIT) return true
  await store.setJSON(key, { n: cur.n + 1, t: now > cur.t ? cur.t : now })
  return false
}

/**
 * A lobby id.
 *
 * Twelve characters of base32-ish alphabet, from crypto randomness. It is also
 * the private lobby's join code (the last six, upper-cased), so it has to be
 * unguessable and it has to be read aloud over voice chat without a "was that
 * an oh or a zero" -- hence no `O`, `0`, `I` or `1`.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function newId(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length]
  return out
}

/**
 * ICE SERVERS, MINTED. The one operation that is answered here and not in
 * src/net/signalProtocol.ts.
 * ---------------------------------------------------------------------------
 * Everything else in this endpoint is a pure function of the store, which is
 * why it lives in a file a unit test can drive over a Map. This is not: it
 * calls a third party, and it calls it with a credential that must never reach
 * a browser. `TURN_KEY_API_TOKEN` can spend Vince's account; `TURN_KEY_ID` is
 * harmless on its own but there is no reason to publish it either. So the
 * browser asks this endpoint, and this endpoint asks Cloudflare.
 *
 * WHAT IT COSTS, verified rather than inherited (September 2026):
 * Cloudflare Realtime bills TURN at $0.05 per GB of egress from their edge to
 * the TURN client, with a free tier of 1,000 GB per month shared with their
 * SFU. Their STUN service at stun.cloudflare.com is free and unlimited, which
 * is why `DEFAULT_ICE` already points at it.
 *
 * TO TURN IT ON: create a TURN key in the Cloudflare dashboard (Realtime ->
 * TURN), then set two environment variables on the Netlify site and redeploy.
 *
 *     TURN_KEY_ID=<the key id>
 *     TURN_KEY_API_TOKEN=<the token>
 *
 * TO TURN IT OFF: remove them. With neither set this returns a refusal, the
 * client falls back to `DEFAULT_ICE`, and the game behaves exactly as the
 * build that shipped before any of this existed -- which is the property that
 * made it safe to add at all.
 */
const TURN_TTL_S = 7200

async function mintIce(): Promise<Response | null> {
  const id = process.env.TURN_KEY_ID
  const token = process.env.TURN_KEY_API_TOKEN
  if (!id || !token) return null
  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(id)}`
      + '/credentials/generate-ice-servers',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ttl: TURN_TTL_S }),
      },
    )
    if (!res.ok) {
      // NAMED IN THE LOG AND ANONYMOUS IN THE REPLY. A player does not need to
      // know that a billing account is suspended; the person reading the
      // function log does, and the client's own fallback already handles it.
      console.error('signal: turn credentials refused', res.status)
      return null
    }
    const body = await res.json().catch(() => null) as { iceServers?: unknown } | null
    // Cloudflare answers with `{ iceServers: [...] }` OR, in some older
    // responses, one server object. Both are normalised to an array here so
    // the browser's `cleanIceServers` only has one shape to accept.
    const raw = body?.iceServers
    const servers = Array.isArray(raw) ? raw : raw ? [raw] : []
    if (servers.length === 0) return null
    return json({ ok: true, op: 'ice', iceServers: servers })
  } catch (e) {
    console.error('signal: turn mint failed', e)
    return null
  }
}

export default async (req: Request, ctx: Context): Promise<Response> => {
  try {
    if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405)

    const body = await req.json().catch(() => null) as SignalRequest | null
    if (!body || typeof body !== 'object' || typeof body.op !== 'string') {
      return json({ ok: false, error: 'bad-body' }, 400)
    }

    const ip = ctx.ip || req.headers.get('x-nf-client-connection-ip') || ''
    if (await rateLimited(ip)) return json({ ok: false, error: 'rate-limited' }, 429)

    if (body.op === 'ice') {
      const minted = await mintIce()
      // A refusal is a normal answer with a reason in it, exactly as every
      // other rejection here is: the client reads `ok: false` and uses STUN.
      return minted ?? json({ ok: false, error: 'no-ice' })
    }

    const res = await handleSignal(blobStore(), body, Date.now(), newId)
    // A rejected request is still a WELL-FORMED answer with a reason in it, so
    // it goes back as 200 with `ok: false`. The client switches on `error` --
    // `notfound`, `full`, `racing`, `badcode` are `JoinError` values the join
    // screen renders as sentences -- and an HTTP status would force it to
    // parse two different failure channels for the same five outcomes.
    return json(res)
  } catch (e) {
    // Never leak an internal message to a game client, exactly as the
    // leaderboard does not. A client that gets `server` shows "the lobby
    // service is unavailable" and keeps the front end up.
    console.error('signal', e)
    return json({ ok: false, error: 'server' }, 500)
  }
}

export const config = { path: '/api/signal' }
