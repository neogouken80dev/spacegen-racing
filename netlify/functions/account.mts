/**
 * SpaceGen Racing — the account endpoint.
 * ---------------------------------------------------------------------------
 *   POST /api/account   { op: 'mint' | 'load' | 'name' | 'avatar' | 'buy'
 *                             | 'award', ... }  ->  { ok, ... }
 *
 * WHY THERE IS ALMOST NOTHING IN THIS FILE.
 *
 * Every rule -- what a valid name is, who owns which avatar, what a race may
 * pay, how fast awards may arrive -- is in `src/net/account.ts`, behind a
 * four-method `AccountStore`. This file is the Netlify Blobs adapter and the
 * rate limiter and that is all. The reason is the one netlify.toml already
 * gives for the leaderboard importing src/score/verify.ts and signal.mts gives
 * for importing signalProtocol.ts: logic that only exists inside a deployed
 * function is logic that can only be tested by deploying.
 *
 * ===========================================================================
 * EVERY LINE BELOW IS UNTESTED AND WILL STAY UNTESTED, AND THAT IS THE DEAL
 *
 * The sandbox this was written in cannot reach any Netlify host -- the egress
 * proxy refuses api.netlify.com, the site and everything else (see
 * `claude/spacegen-racing-deployment.md`) -- so nothing here has ever run
 * against a real blob store. `tests/account.test.ts` covers `handleAccount`
 * exhaustively against a Map and covers NOTHING in this file.
 *
 * So this file is kept small enough to read and be sure of, and the one thing
 * in it that carries real weight is `blobStore`. Specifically:
 *
 *   `create` MUST map to `onlyIfNew` and `replace` MUST map to `onlyIfMatch`,
 *   and both must return the SDK's `modified` flag unchanged.
 *
 * If either of those silently became an unconditional write, every test would
 * still pass and two players could be called Vince. There is no way to catch
 * that from a unit test, so it is written here instead: THIS MAPPING IS THE
 * ASSUMPTION THE WHOLE NAME SCHEME RESTS ON, and the first thing to check
 * against a real deploy is that a second `create` on an existing key comes back
 * with `modified: false` rather than overwriting.
 *
 * ===========================================================================
 * COST
 *
 * One request on launch, one per name change, one per avatar change or
 * purchase, and one per finished race. A player costs perhaps five requests an
 * hour, which is an order of magnitude below the signalling endpoint and two
 * below the lobby directory. Nothing here polls.
 */
import type { Context } from '@netlify/functions'
import { getStore } from '@netlify/blobs'
import {
  ALPHABET, handleAccount, type AccountRequest, type AccountStore,
} from '../../src/net/account'

/**
 * Authenticated requests allowed per IP per window.
 *
 * Between the leaderboard's ten and the signalling endpoint's sixty. A player
 * legitimately makes one load on launch and then a handful of writes across a
 * session; thirty in a minute is a person clicking around the avatar picker as
 * fast as they can and still stops a script hammering one account.
 *
 * ITS OWN BUCKET, sharing with nothing. signal.mts makes the same point: a
 * player who has just posted a lap must not find they cannot load their
 * profile, and a player browsing lobbies must not find they cannot buy a hat.
 */
const RATE_LIMIT = 30
const RATE_WINDOW_MS = 60_000

/**
 * Mints allowed per IP per hour, in a bucket of their own.
 *
 * MINTING IS THE ONLY UNAUTHENTICATED OP -- it is the call that issues the
 * credential, so it cannot ask for one -- which makes it the only way to create
 * state here without already having some. Left open it is free account creation,
 * and since every account claims a name on creation, free account creation is
 * free NAME SQUATTING, which is the expensive one: an account is a blob and a
 * name is gone for ever.
 *
 * TWENTY AN HOUR IS A COMPROMISE AND SHOULD BE REVISITED WITH REAL DATA. Tighter
 * would be better against a squatter and worse against reality: carrier-grade
 * NAT and school networks put a lot of genuine first launches behind one
 * address, and a player who cannot create an account at all is a far worse
 * failure than a few junk ones. It fails visibly -- `rate-limited` reaches the
 * client, which reports offline and offers Try again -- rather than silently,
 * which is the property that makes a wrong guess here recoverable.
 */
const MINT_LIMIT = 20
const MINT_WINDOW_MS = 3_600_000

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      // NEVER CACHED, at any layer. A profile served from a CDN edge is a
      // balance that is wrong immediately after every purchase, and a `mint`
      // served from a cache would hand two devices one account.
      'cache-control': 'no-store',
    },
  })

/**
 * The Blobs adapter. Four methods, and two of them are the whole design.
 *
 * `onlyIfNew` and `onlyIfMatch` are conditional writes: the store reports
 * `modified: false` rather than overwriting, which is create-if-absent and
 * compare-and-swap respectively. src/net/account.ts's `AccountStore` comment
 * explains why the interface exposes those two rather than a `set` with
 * options; this is the mapping that has to be right for any of it to hold.
 */
const blobStore = (): AccountStore => {
  const store = getStore('spacegen-accounts')
  return {
    get: async (key) => {
      const got = await store.getWithMetadata(key, { type: 'json' })
      if (!got) return null
      // `etag` is declared optional by the SDK. A missing one degrades
      // `replace` to an unconditional write, which is documented at the
      // interface; it is not silently treated as a match.
      return { value: got.data as unknown, etag: got.etag ?? null }
    },
    create: async (key, value) => {
      const res = await store.setJSON(key, value, { onlyIfNew: true })
      return res.modified === true
    },
    replace: async (key, value, etag) => {
      // A null tag means the store could not tell us what it holds, so there is
      // nothing to compare against and the choice is between writing blind and
      // failing every write. Writing blind is the right one: it is the
      // leaderboard's trade (a lost update rather than a lost service) and it
      // only ever applies to the account record, never to a name claim --
      // `create` takes no tag and cannot degrade.
      const res = etag === null
        ? await store.setJSON(key, value)
        : await store.setJSON(key, value, { onlyIfMatch: etag })
      return res.modified === true
    },
    del: (key) => store.delete(key),
  }
}

/** Fixed window, as in the leaderboard and the signalling endpoint, and for the
 *  same reason: at this size the boundary case is irrelevant and a sliding
 *  window costs a second write. */
async function rateLimited(
  prefix: string, ip: string, limit: number, windowMs: number,
): Promise<boolean> {
  if (!ip) return false
  const store = getStore('spacegen-ratelimit')
  const now = Date.now()
  const key = `${prefix}-${ip}`
  const cur = await store.get(key, { type: 'json' }) as { n: number; t: number } | null
  if (!cur || typeof cur.t !== 'number' || now - cur.t > windowMs) {
    await store.setJSON(key, { n: 1, t: now })
    return false
  }
  if (cur.n >= limit) return true
  await store.setJSON(key, { n: cur.n + 1, t: now > cur.t ? cur.t : now })
  return false
}

/**
 * An id or a secret, from crypto randomness.
 *
 * `% ALPHABET.length` over a 32-symbol alphabet and 256-valued bytes is exactly
 * eight draws per symbol with no remainder, so there is no modulo bias to argue
 * about -- which is worth stating, because the same expression over a 26- or
 * 36-symbol alphabet WOULD be biased and this is the kind of line that gets
 * copied.
 */
function newToken(len: number): string {
  const bytes = new Uint8Array(len)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length]
  return out
}

export default async (req: Request, ctx: Context): Promise<Response> => {
  try {
    if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405)

    const body = await req.json().catch(() => null) as AccountRequest | null
    if (!body || typeof body !== 'object' || typeof body.op !== 'string') {
      return json({ ok: false, error: 'bad-body' }, 400)
    }

    const ip = ctx.ip || req.headers.get('x-nf-client-connection-ip') || ''
    // The mint bucket is checked IN ADDITION to the ordinary one, not instead of
    // it: a mint is still a request and still costs the same work, so it counts
    // against both. Ordinary first, because it is the cheaper refusal.
    if (await rateLimited('acct', ip, RATE_LIMIT, RATE_WINDOW_MS)) {
      return json({ ok: false, error: 'rate-limited' }, 429)
    }
    if (body.op === 'mint'
      && await rateLimited('acctmint', ip, MINT_LIMIT, MINT_WINDOW_MS)) {
      return json({ ok: false, error: 'rate-limited' }, 429)
    }

    const res = await handleAccount(blobStore(), body, Date.now(), newToken)
    // A rejected request is still a WELL-FORMED answer with a reason in it, so
    // it goes back as 200 with `ok: false`, exactly as the signalling endpoint
    // does. The client switches on `error` -- `taken`, `credits`, `locked` and
    // the rest are values the profile screen renders as sentences -- and an HTTP
    // status would force it to parse two failure channels for one outcome.
    return json(res)
  } catch (e) {
    // Never leak an internal message to a game client, exactly as the
    // leaderboard and the signalling endpoint do not. A client that gets
    // `server` reports offline and keeps the front end up.
    console.error('account', e)
    return json({ ok: false, error: 'server' }, 500)
  }
}

export const config = { path: '/api/account' }
