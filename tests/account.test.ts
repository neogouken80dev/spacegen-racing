/**
 * THE ACCOUNT ENDPOINT, TESTED WITHOUT DEPLOYING IT.
 *
 * `netlify/functions/account.mts` is an HTTP shell over `handleAccount`, which
 * takes its storage, its clock, its id source and its hash as arguments. So
 * everything the endpoint actually DECIDES -- who owns a name, who may wear an
 * avatar, what a race may pay, how fast awards may arrive -- runs here against
 * a `Map`, with the clock passed in by hand, in under a millisecond, with no
 * Netlify and no network.
 *
 * ===========================================================================
 * THE CONCURRENT-CLAIM TEST IS THE ONE THAT MATTERS
 *
 * A lost row on a top-ten board is a row. A lost name claim is two players who
 * both believe they are Vince, in a game whose nameplates, lobby rows and
 * results tables all assume they are not -- and it is permanent.
 *
 * So the store below is built to FORCE the collision rather than to hope for
 * one. `barrier()` parks every caller until a set number of them have arrived,
 * which puts two claims provably inside each other's window rather than
 * relying on await counts lining up. Then the same case is run twice:
 *
 *   - against `create` as a real conditional write (check and set with nothing
 *     awaited in between, which is what Blobs' `onlyIfNew` gives us), and
 *     exactly one claim wins;
 *   - against `create` as the naive read-then-write, and BOTH claims win.
 *
 * The second half is not padding. A test that only asserts the good outcome
 * cannot tell a correct implementation from one where the barrier happened not
 * to bite, and the whole scheme rests on this one property -- so the test has
 * to demonstrate that it would notice.
 *
 * WHAT IS NOT COVERED HERE, and cannot be: everything in
 * `netlify/functions/account.mts`. The IP rate limiter, the Blobs adapter and
 * the JSON shell have never run -- the sandbox cannot reach any Netlify host.
 * The per-ACCOUNT pace limiter is in `handleAccount` and is covered below; the
 * per-IP one is not, and the function's header says so in the same words.
 */
import { describe, it, expect } from 'vitest'
import {
  ALPHABET, AWARD_MIN_GAP_MS, AWARD_PER_HOUR, AWARD_WINDOW_MS,
  ID_CHARS, SECRET_CHARS,
  handleAccount, nameKey, toProfile,
  type AccountRecord, type AccountRequest, type AccountResponse, type AccountStore,
} from '../src/net/account'
import { LiveAccountService, type StorageLike } from '../src/net/account'
import { AVATARS, DEFAULT_AVATAR_ID, PRICES, RANKS, STARTER_IDS } from '../src/content/avatars'
import { MAX_PER_RACE, REF_SCORE, Wallet } from '../src/score/wallet'
import { bankAward } from '../src/game/main'
import type { PlayerProfile } from '../src/net/types'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface MemStore extends AccountStore {
  map: Map<string, string>
  /** Park the next `n` store calls until all `n` have arrived. */
  arm(n: number): void
  /** How many writes were refused by a condition. */
  refused: number
}

interface MemOptions {
  /**
   * Implement `create` as the read-then-write this design exists to avoid.
   *
   * FOR ONE TEST, which proves the concurrency test has teeth. See the header.
   */
  naiveCreate?: boolean
  /** Which op the barrier parks on. Defaults to `create`. */
  gateOn?: 'create' | 'replace'
}

/**
 * A store that behaves like Blobs: JSON in, JSON out, ETags on every write.
 *
 * Values are round-tripped through JSON on the way in so a test cannot
 * accidentally rely on object identity that a real store would not preserve --
 * which is exactly the kind of thing that passes locally and fails deployed.
 * tests/signal.test.ts's `memStore` makes the same choice for the same reason.
 */
function memStore(opts: MemOptions = {}): MemStore {
  const map = new Map<string, string>()
  const tags = new Map<string, string>()
  const gateOn = opts.gateOn ?? 'create'
  let seq = 0
  let refused = 0

  let waiting = 0
  let need = 0
  let release: (() => void) | null = null
  let gate: Promise<void> | null = null

  /**
   * Park until `need` callers have arrived, then let all of them go at once.
   *
   * Deterministic where a count of microtask turns would not be: two requests
   * only collide if they are both inside the window at the same moment, and
   * "both arrived" is the only way to state that without depending on how many
   * awaits each one happened to perform on the way in.
   */
  const barrier = async (): Promise<void> => {
    if (need <= 0) return
    waiting++
    if (!gate) gate = new Promise<void>((r) => { release = r })
    const mine = gate
    if (waiting >= need) {
      const go = release
      waiting = 0
      need = 0
      gate = null
      release = null
      go?.()
    }
    await mine
  }

  const tagFor = (key: string): string => {
    const t = `e${++seq}`
    tags.set(key, t)
    return t
  }

  return {
    map,
    get refused(): number { return refused },
    arm(n: number): void { need = n; waiting = 0; gate = null; release = null },

    get: async (key) => {
      const v = map.get(key)
      if (v === undefined) return null
      return { value: JSON.parse(v) as unknown, etag: tags.get(key) ?? null }
    },

    create: async (key, value) => {
      if (opts.naiveCreate) {
        // THE BUG, WRITTEN OUT. Read, then yield, then write -- which is every
        // read-modify-write against a store with no conditional put.
        const has = map.has(key)
        if (gateOn === 'create') await barrier()
        if (has) { refused++; return false }
        map.set(key, JSON.stringify(value))
        tagFor(key)
        return true
      }
      // THE REAL THING. `onlyIfNew` is decided inside the store, so the check
      // and the write cannot be separated by anything -- which is why there is
      // no await between these two lines and why moving one in would be the
      // regression this file exists to catch.
      if (gateOn === 'create') await barrier()
      if (map.has(key)) { refused++; return false }
      map.set(key, JSON.stringify(value))
      tagFor(key)
      return true
    },

    replace: async (key, value, etag) => {
      if (gateOn === 'replace') await barrier()
      if (etag !== null && tags.get(key) !== etag) { refused++; return false }
      map.set(key, JSON.stringify(value))
      tagFor(key)
      return true
    },

    del: async (key) => { map.delete(key); tags.delete(key) },
  }
}

/**
 * Tokens that look like the real ones.
 *
 * `idOk` pins the LENGTH as well as the alphabet -- every id this server issues
 * is exactly `ID_CHARS` long -- so a counter with a prefix would be rejected by
 * the code under test rather than exercising it.
 */
let tokens = 0
const newToken = (len: number): string => {
  let x = (++tokens * 2654435761) >>> 0
  let out = ''
  for (let i = 0; i < len; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0
    out += ALPHABET[(x >>> 16) % ALPHABET.length]
  }
  return out
}

/**
 * A stand-in for SHA-256: deterministic, instant, and hex-64 so `asRecord`'s
 * shape check accepts it.
 *
 * NOT A HASH AND NOT PRETENDING TO BE. What the tests need from it is that the
 * same secret maps to the same digest and a different one does not; the real
 * `sha256Hex` is one call into `crypto.subtle` and has nothing in it worth
 * testing that WebCrypto does not already guarantee.
 */
const fakeHash = async (s: string): Promise<string> => {
  let a = 0x811c9dc5
  let out = ''
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < s.length; j++) {
      a = Math.imul(a ^ s.charCodeAt(j) ^ i, 0x01000193) >>> 0
    }
    out += a.toString(16).padStart(8, '0')
  }
  return out
}

function harness(opts: MemOptions = {}) {
  const store = memStore(opts)
  let clock = 1_700_000_000_000
  let rolls = 0
  // Deterministic, so a test that wants a generated name to collide knows which
  // name will be tried.
  const rand = (): number => { rolls = (rolls * 1103515245 + 12345) >>> 0; return (rolls >>> 8) / 0x1000000 }
  const call = (req: AccountRequest): Promise<AccountResponse> =>
    handleAccount(store, req, clock, newToken, fakeHash, rand)
  return {
    store,
    call,
    advance: (ms: number) => { clock += ms },
    now: () => clock,
  }
}

/** Mint an account and hand back its credential. */
async function mint(h: ReturnType<typeof harness>, name?: string) {
  const res = await h.call({ op: 'mint', name })
  if (!res.ok || res.op !== 'mint') throw new Error(`mint failed: ${JSON.stringify(res)}`)
  return { id: res.id, secret: res.secret, profile: res.profile }
}

const errorOf = (res: AccountResponse): string => (res.ok ? '' : res.error)
const profileOf = (res: AccountResponse): PlayerProfile => {
  if (!res.ok) throw new Error(`expected a profile, got ${res.error}`)
  return res.profile
}

/** Read a record straight out of the store, the way nothing in production may. */
function record(store: MemStore, id: string): AccountRecord {
  const raw = store.map.get(`acct/${id}`)
  if (!raw) throw new Error(`no record for ${id}`)
  return JSON.parse(raw) as AccountRecord
}

// ---------------------------------------------------------------------------
// Minting
// ---------------------------------------------------------------------------

describe('minting', () => {
  it('issues an id and a secret of the pinned shapes', async () => {
    const h = harness()
    const { id, secret } = await mint(h)
    expect(id).toHaveLength(ID_CHARS)
    expect(secret).toHaveLength(SECRET_CHARS)
    expect(id).toMatch(/^[A-Z2-9]+$/)
    expect(secret).toMatch(/^[A-Z2-9]+$/)
    // The id has to survive net/index.ts's live peer id, which the signalling
    // endpoint filters through `[A-Za-z0-9_-]`. A character outside that set
    // would present as a join that fails with `bad-peer` for a reason nobody
    // would look for in this file.
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('never stores the secret, only a digest of it', async () => {
    const h = harness()
    const { id, secret } = await mint(h)
    const blob = h.store.map.get(`acct/${id}`) ?? ''
    expect(blob).not.toContain(secret)
    expect(record(h.store, id).secretHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('gives a new player the starters, one cheap portrait and nothing else', async () => {
    const h = harness()
    const { profile } = await mint(h)
    expect(profile.credits).toBe(PRICES.cheap)
    expect(profile.earned).toBe(0)
    expect(profile.races).toBe(0)
    expect(profile.avatarId).toBe(DEFAULT_AVATAR_ID)
    expect([...profile.unlocked].sort()).toEqual([...STARTER_IDS].sort())
  })

  it('claims the name it was asked for, and claims it for real', async () => {
    const h = harness()
    const { id, profile } = await mint(h, 'Vince')
    expect(profile.name).toBe('Vince')
    expect(h.store.map.has(nameKey('Vince'))).toBe(true)
    expect(JSON.parse(h.store.map.get(nameKey('Vince')) ?? '{}')).toMatchObject({ id })
  })

  it('falls back to a generated name when the wanted one is taken', async () => {
    const h = harness()
    await mint(h, 'Vince')
    const second = await mint(h, 'Vince')
    expect(second.profile.name).not.toBe('Vince')
    // Generated or not, it is CLAIMED. An account whose name is not in the
    // index is an account whose name somebody else can take.
    expect(h.store.map.has(nameKey(second.profile.name))).toBe(true)
  })

  it('falls back to a name built from the id when every generated one collides',
    async () => {
      const h = harness()
      const { id } = await mint(h)
      // Squat every `Racer NNNN` this run's `rand` will produce, plus the one
      // the player asked for, so only the id-derived fallback is left.
      for (let n = 1000; n < 10000; n++) {
        h.store.map.set(nameKey(`Racer ${n}`), JSON.stringify({ id, at: 1 }))
      }
      h.store.map.set(nameKey('Wanted'), JSON.stringify({ id: 'OTHER', at: 1 }))
      const res = await h.call({ op: 'mint', name: 'Wanted' })
      const p = profileOf(res)
      expect(p.name).toMatch(/^Racer [A-Z2-9]{6}$/)
      expect(p.name.length).toBeLessThanOrEqual(12)
    })

  /**
   * An 80-bit id collision will not happen. If it ever did, the loser of the
   * race would silently INHERIT the winner's account -- so `mint` writes the
   * record with `create` rather than with a plain write, and a refused write
   * has to give the name back rather than reserving it for an account that was
   * never made.
   *
   * Forced here with a token source that always answers the same thing, which
   * is the only way to reach this branch at all.
   */
  it('gives the name back when the account record cannot be created', async () => {
    const store = memStore()
    const fixed = (len: number) => 'K'.repeat(len)
    const first = await handleAccount(
      store, { op: 'mint', name: 'Vince' }, 1, fixed, fakeHash)
    expect(first.ok).toBe(true)

    const second = await handleAccount(
      store, { op: 'mint', name: 'Kestrel' }, 2, fixed, fakeHash)
    expect(errorOf(second)).toBe('busy')
    // The name it grabbed on the way in was released, so nobody is holding a
    // name for an account that does not exist.
    expect(store.map.has(nameKey('Kestrel'))).toBe(false)
    expect(store.map.has(nameKey('Vince'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

describe('name claiming', () => {
  it('rejects a name nobody could hold, without touching the store', async () => {
    const h = harness()
    const me = await mint(h)
    const before = h.store.map.size
    expect(errorOf(await h.call({ op: 'name', ...me, name: 'ab' }))).toBe('short')
    expect(errorOf(await h.call({ op: 'name', ...me, name: 'x'.repeat(13) }))).toBe('long')
    expect(errorOf(await h.call({ op: 'name', ...me, name: '-nope' }))).toBe('charset')
    expect(errorOf(await h.call({ op: 'name', ...me, name: 'a__b' }))).toBe('charset')
    expect(h.store.map.size).toBe(before)
  })

  it('refuses a name a different account already holds', async () => {
    const h = harness()
    const a = await mint(h, 'Vince')
    const b = await mint(h, 'Someone')
    expect(errorOf(await h.call({ op: 'name', id: b.id, secret: b.secret, name: 'Vince' })))
      .toBe('taken')
    // And the loser's own name is untouched: a refused rename must not cost
    // them the name they already had.
    expect(record(h.store, b.id).name).toBe('Someone')
    expect(record(h.store, a.id).name).toBe('Vince')
  })

  it('claims case-insensitively', async () => {
    const h = harness()
    await mint(h, 'Vince')
    const b = await mint(h, 'Someone')
    expect(errorOf(await h.call({ op: 'name', id: b.id, secret: b.secret, name: 'vInCe' })))
      .toBe('taken')
  })

  it('lets the holder change the CASE of their own name for free', async () => {
    const h = harness()
    const me = await mint(h, 'vince')
    const p = profileOf(await h.call({ op: 'name', ...me, name: 'VINCE' }))
    expect(p.name).toBe('VINCE')
    // One key, before and after: `Vince` and `vince` are the same claim.
    expect(h.store.map.has(nameKey('VINCE'))).toBe(true)
    expect([...h.store.map.keys()].filter((k) => k.startsWith('name/'))).toHaveLength(1)
  })

  it('is idempotent when the same account re-claims its own name', async () => {
    const h = harness()
    const me = await mint(h, 'Vince')
    const p = profileOf(await h.call({ op: 'name', ...me, name: 'Vince' }))
    expect(p.name).toBe('Vince')
  })

  it('frees the old name only AFTER the new one is committed', async () => {
    const h = harness()
    const me = await mint(h, 'Vince')
    const other = await mint(h, 'Someone')
    const p = profileOf(await h.call({ op: 'name', ...me, name: 'Kestrel' }))
    expect(p.name).toBe('Kestrel')
    expect(h.store.map.has(nameKey('Vince'))).toBe(false)
    expect(h.store.map.has(nameKey('Kestrel'))).toBe(true)
    // Somebody else can now have the name that was given up. The whole point of
    // releasing it is that it goes back into circulation.
    const q = profileOf(await h.call({
      op: 'name', id: other.id, secret: other.secret, name: 'Vince',
    }))
    expect(q.name).toBe('Vince')
  })

  it('does not strand the new name when the record cannot be committed', async () => {
    // `replace` refuses for ever, so the CAS exhausts its tries. The claim was
    // already taken by then, and the failure path has to give it back -- a
    // rename that fails must not reserve a name for nobody.
    const store = memStore()
    const real = store.replace
    store.replace = async () => false
    const res = await handleAccount(
      store,
      { op: 'mint', name: 'Vince' },
      1, newToken, fakeHash,
    )
    // Minting uses `create`, not `replace`, so it still works.
    if (!res.ok || res.op !== 'mint') throw new Error('mint failed')
    const out = await handleAccount(
      store,
      { op: 'name', id: res.id, secret: res.secret, name: 'Kestrel' },
      2, newToken, fakeHash,
    )
    expect(errorOf(out)).toBe('busy')
    expect(store.map.has(nameKey('Kestrel'))).toBe(false)
    expect(store.map.has(nameKey('Vince'))).toBe(true)
    store.replace = real
  })
})

// ---------------------------------------------------------------------------
// THE ONE THAT MATTERS
// ---------------------------------------------------------------------------

describe('two simultaneous claims on one name', () => {
  /**
   * Both requests are parked inside the claim window and released together.
   *
   * With a conditional `create` this is safe by construction: the check and the
   * write are one indivisible step inside the store, so whichever request is
   * scheduled second finds the key occupied.
   */
  it('gives the name to exactly one of them', async () => {
    const h = harness()
    const a = await mint(h, 'AlphaOne')
    const b = await mint(h, 'BetaTwo')

    // Both claims park on the first `create` they reach, which is the name
    // claim, and neither proceeds until both have arrived.
    h.store.arm(2)
    const [ra, rb] = await Promise.all([
      h.call({ op: 'name', id: a.id, secret: a.secret, name: 'Vince' }),
      h.call({ op: 'name', id: b.id, secret: b.secret, name: 'Vince' }),
    ])

    const winners = [ra, rb].filter((r) => r.ok)
    const losers = [ra, rb].filter((r) => !r.ok)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(errorOf(losers[0])).toBe('taken')

    // And the store agrees with the answers that were handed out. A response
    // saying "yours" over a record that says otherwise would be the same bug
    // one layer down.
    const claim = JSON.parse(h.store.map.get(nameKey('Vince')) ?? '{}') as { id: string }
    const winner = profileOf(winners[0])
    expect(claim.id).toBe(winner.id)
    expect(record(h.store, winner.id).name).toBe('Vince')
    const loserId = winner.id === a.id ? b.id : a.id
    expect(record(h.store, loserId).name).not.toBe('Vince')
  })

  it('and eight simultaneous claims still produce exactly one winner', async () => {
    const h = harness()
    const accounts = []
    for (let i = 0; i < 8; i++) accounts.push(await mint(h))
    h.store.arm(8)
    const results = await Promise.all(accounts.map((acc) =>
      h.call({ op: 'name', id: acc.id, secret: acc.secret, name: 'Vince' })))
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.filter((r) => !r.ok).every((r) => errorOf(r) === 'taken')).toBe(true)
  })

  /**
   * THE TEETH.
   *
   * The same case against a store whose `create` is the read-then-write this
   * design exists to avoid. If this passed -- if both claims failed to collide
   * even with the naive store -- then the test above would be proving nothing,
   * because the barrier would not be putting the two requests inside each
   * other's window at all.
   *
   * So this asserts the BUG, on purpose. The day somebody replaces `onlyIfNew`
   * with a plain write, the test above goes red and this one stays green, and
   * the pair of them says exactly what happened.
   */
  it('BOTH win against a read-then-write store, which is why the above is not luck',
    async () => {
      const h = harness({ naiveCreate: true })
      const a = await mint(h, 'AlphaOne')
      const b = await mint(h, 'BetaTwo')
      h.store.arm(2)
      const [ra, rb] = await Promise.all([
        h.call({ op: 'name', id: a.id, secret: a.secret, name: 'Vince' }),
        h.call({ op: 'name', id: b.id, secret: b.secret, name: 'Vince' }),
      ])
      expect([ra, rb].filter((r) => r.ok)).toHaveLength(2)
      // Two accounts, one name. This is the outcome the real store prevents.
      expect(record(h.store, a.id).name).toBe('Vince')
      expect(record(h.store, b.id).name).toBe('Vince')
    })
})

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe('authentication', () => {
  it('refuses a wrong secret on every authenticated op', async () => {
    const h = harness()
    const me = await mint(h, 'Vince')
    const wrong = 'A'.repeat(SECRET_CHARS)
    expect(wrong).not.toBe(me.secret)
    const ops: AccountRequest[] = [
      { op: 'load', id: me.id, secret: wrong },
      { op: 'name', id: me.id, secret: wrong, name: 'Kestrel' },
      { op: 'avatar', id: me.id, secret: wrong, avatarId: DEFAULT_AVATAR_ID },
      { op: 'buy', id: me.id, secret: wrong, avatarId: shopAvatar().id },
      { op: 'award', id: me.id, secret: wrong, credits: 50, won: true },
    ]
    for (const op of ops) expect(errorOf(await h.call(op))).toBe('badsecret')
    // Nothing moved. A rejected call must not be a half-applied one -- and the
    // `name` op in particular must not have claimed anything on the way to
    // being refused.
    expect(record(h.store, me.id).name).toBe('Vince')
    expect(record(h.store, me.id).credits).toBe(PRICES.cheap)
    expect(h.store.map.has(nameKey('Kestrel'))).toBe(false)
  })

  it('refuses a malformed secret without reading the account', async () => {
    const h = harness()
    const me = await mint(h)
    expect(errorOf(await h.call({ op: 'load', id: me.id, secret: 'short' })))
      .toBe('badsecret')
  })

  it('reports an id it never issued as nosuch, not as a bad secret', async () => {
    const h = harness()
    // A well-formed id for an account that does not exist -- a wiped store, or
    // a device carrying something the mock minted. The client mints afresh on
    // this, and must not confuse it with a corrupted secret, which is a bug.
    const ghost = newToken(ID_CHARS)
    expect(errorOf(await h.call({ op: 'load', id: ghost, secret: newToken(SECRET_CHARS) })))
      .toBe('nosuch')
  })

  it('round-trips a real profile on load', async () => {
    const h = harness()
    const me = await mint(h, 'Vince')
    h.advance(60_000)
    const p = profileOf(await h.call({ op: 'load', id: me.id, secret: me.secret }))
    expect(p).toEqual(me.profile)
    // `seenAt` moves, which is the only thing a load writes.
    expect(record(h.store, me.id).seenAt).toBe(h.now())
  })
})

// ---------------------------------------------------------------------------
// Buying and wearing
// ---------------------------------------------------------------------------

function shopAvatar(minPrice = 0) {
  const a = AVATARS.find((x) => x.source.kind === 'shop'
    && x.source.price >= minPrice)
  if (!a || a.source.kind !== 'shop') throw new Error('no shop avatar in the catalogue')
  return { id: a.id, price: a.source.price }
}

describe('purchases', () => {
  it('refuses what the balance does not cover, and changes nothing', async () => {
    const h = harness()
    const me = await mint(h)
    const dear = shopAvatar(PRICES.chase)
    expect(dear.price).toBeGreaterThan(PRICES.cheap)
    expect(errorOf(await h.call({ op: 'buy', ...me, avatarId: dear.id }))).toBe('credits')
    const rec = record(h.store, me.id)
    expect(rec.credits).toBe(PRICES.cheap)
    expect(rec.owned).toEqual([])
  })

  it('debits the server balance, not the one the client thinks it has', async () => {
    const h = harness()
    const me = await mint(h)
    const cheap = shopAvatar()
    expect(cheap.price).toBeLessThanOrEqual(PRICES.cheap)
    const p = profileOf(await h.call({ op: 'buy', ...me, avatarId: cheap.id }))
    expect(p.credits).toBe(PRICES.cheap - cheap.price)
    expect(p.unlocked).toContain(cheap.id)
    // Bought it, wear it.
    expect(p.avatarId).toBe(cheap.id)
  })

  it('refuses to sell the same portrait twice', async () => {
    const h = harness()
    const me = await mint(h)
    const cheap = shopAvatar()
    await h.call({ op: 'buy', ...me, avatarId: cheap.id })
    expect(errorOf(await h.call({ op: 'buy', ...me, avatarId: cheap.id }))).toBe('owned')
    expect(record(h.store, me.id).credits).toBe(PRICES.cheap - cheap.price)
  })

  it('refuses to sell a rank or a feat at any price', async () => {
    const h = harness()
    const me = await mint(h)
    const rank = AVATARS.find((a) => a.source.kind === 'rank')
    const feat = AVATARS.find((a) => a.source.kind === 'feat')
    expect(errorOf(await h.call({ op: 'buy', ...me, avatarId: rank!.id }))).toBe('notforsale')
    expect(errorOf(await h.call({ op: 'buy', ...me, avatarId: feat!.id }))).toBe('notforsale')
  })

  it('refuses an avatar this build has never heard of', async () => {
    const h = harness()
    const me = await mint(h)
    expect(errorOf(await h.call({ op: 'buy', ...me, avatarId: 'nonesuch' }))).toBe('unknown')
    expect(errorOf(await h.call({ op: 'avatar', ...me, avatarId: 'nonesuch' }))).toBe('unknown')
  })

  it('refuses to WEAR something that has not been earned', async () => {
    const h = harness()
    const me = await mint(h)
    const rank = AVATARS.find((a) => a.source.kind === 'rank')!
    expect(errorOf(await h.call({ op: 'avatar', ...me, avatarId: rank.id }))).toBe('locked')
  })

  it('cannot be raced into spending the same credits twice', async () => {
    // Two buys on one account, both parked on their `replace` and released
    // together. Without the compare-and-swap the second write would land on a
    // record read before the first debit and the player would get two portraits
    // for one price.
    const h = harness({ gateOn: 'replace' })
    const me = await mint(h)
    const cheap = shopAvatar()
    const other = AVATARS.find((a) => a.source.kind === 'shop' && a.id !== cheap.id)!
    h.store.arm(2)
    const results = await Promise.all([
      h.call({ op: 'buy', ...me, avatarId: cheap.id }),
      h.call({ op: 'buy', ...me, avatarId: other.id }),
    ])
    const rec = record(h.store, me.id)
    // Whatever the outcomes, the books balance: the balance fell by exactly the
    // price of what is actually owned.
    let spent = 0
    for (const id of rec.owned) {
      const a = AVATARS.find((x) => x.id === id)!
      if (a.source.kind === 'shop') spent += a.source.price
    }
    expect(rec.credits).toBe(PRICES.cheap - spent)
    expect(rec.credits).toBeGreaterThanOrEqual(0)
    expect(results.filter((r) => r.ok).length).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// Awards
// ---------------------------------------------------------------------------

describe('awards', () => {
  it('banks a race and moves every counter the profile screen shows', async () => {
    const h = harness()
    const me = await mint(h)
    const p = profileOf(await h.call({ op: 'award', ...me, credits: 82, won: true }))
    expect(p.credits).toBe(PRICES.cheap + 82)
    expect(p.earned).toBe(82)
    expect(p.races).toBe(1)
    expect(p.wins).toBe(1)
    // The win implies a feat, DERIVED from the counter rather than posted.
    expect(p.unlocked).toContain('flagbearer')
  })

  it('records what it paid, for the day somebody looks', async () => {
    const h = harness()
    const me = await mint(h)
    await h.call({ op: 'award', ...me, credits: 82, won: false })
    const rec = record(h.store, me.id)
    expect(rec.awards).toHaveLength(1)
    expect(rec.awards[0]).toMatchObject({ at: h.now(), paid: 82 })
  })

  it('clamps one race to MAX_PER_RACE and counts the clamp', async () => {
    const h = harness()
    const me = await mint(h)
    const p = profileOf(await h.call({ op: 'award', ...me, credits: 1e9, won: false }))
    expect(p.credits).toBe(PRICES.cheap + MAX_PER_RACE)
    expect(p.earned).toBe(MAX_PER_RACE)
    expect(record(h.store, me.id).clamped).toBe(1)
  })

  it('refuses a negative or non-numeric payout', async () => {
    const h = harness()
    const me = await mint(h)
    expect(errorOf(await h.call({ op: 'award', ...me, credits: -5, won: false })))
      .toBe('invalid')
    expect(errorOf(await h.call({
      op: 'award', ...me, credits: Number.NaN, won: false,
    }))).toBe('invalid')
    expect(record(h.store, me.id).credits).toBe(PRICES.cheap)
  })

  it('derives rank unlocks from lifetime earnings and accepts none from the client',
    async () => {
      const h = harness()
      const me = await mint(h)
      // Earn past the first rank threshold, a paced race at a time.
      let p = me.profile
      const need = Math.ceil(RANKS.pacer / MAX_PER_RACE)
      for (let i = 0; i < need; i++) {
        h.advance(AWARD_MIN_GAP_MS + 1)
        if (i > 0 && i % AWARD_PER_HOUR === 0) h.advance(AWARD_WINDOW_MS)
        p = profileOf(await h.call({ op: 'award', ...me, credits: MAX_PER_RACE, won: false }))
      }
      expect(p.earned).toBeGreaterThanOrEqual(RANKS.pacer)
      expect(p.unlocked).toContain('pacer')
      // And it is DERIVED, not stored: nothing put it in `owned`.
      expect(record(h.store, me.id).owned).not.toContain('pacer')
    })

  it('never lets spending cost a rank', async () => {
    const h = harness()
    const me = await mint(h)
    const cheap = shopAvatar()
    await h.call({ op: 'award', ...me, credits: MAX_PER_RACE, won: false })
    const before = record(h.store, me.id).earned
    await h.call({ op: 'buy', ...me, avatarId: cheap.id })
    expect(record(h.store, me.id).earned).toBe(before)
    expect(record(h.store, me.id).credits).toBeLessThan(before + PRICES.cheap)
  })
})

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
//
// THE PER-IP BUCKET IS NOT HERE AND CANNOT BE. It lives in
// netlify/functions/account.mts, needs `getStore`, and has never run. What IS
// testable -- and is the more useful of the two, because it cannot be evaded by
// changing address -- is the per-account pace limiter in `handleAccount`.

describe('the pace limiter', () => {
  it('refuses a second award inside the gap', async () => {
    const h = harness()
    const me = await mint(h)
    await h.call({ op: 'award', ...me, credits: 80, won: false })
    h.advance(AWARD_MIN_GAP_MS - 1)
    expect(errorOf(await h.call({ op: 'award', ...me, credits: 80, won: false })))
      .toBe('pace')
    // Nothing was paid for the refused one.
    expect(record(h.store, me.id).credits).toBe(PRICES.cheap + 80)
  })

  it('counts every refusal on the record, which is the point of refusing', async () => {
    const h = harness()
    const me = await mint(h)
    await h.call({ op: 'award', ...me, credits: 80, won: false })
    for (let i = 0; i < 5; i++) {
      await h.call({ op: 'award', ...me, credits: 80, won: false })
    }
    expect(record(h.store, me.id).refused).toBe(5)
  })

  it('lets a real race through once the gap has passed', async () => {
    const h = harness()
    const me = await mint(h)
    await h.call({ op: 'award', ...me, credits: 80, won: false })
    h.advance(AWARD_MIN_GAP_MS + 1)
    const p = profileOf(await h.call({ op: 'award', ...me, credits: 80, won: false }))
    expect(p.races).toBe(2)
  })

  it('caps an hour at AWARD_PER_HOUR however patiently they are spaced', async () => {
    const h = harness()
    const me = await mint(h)
    let accepted = 0
    // Respect the gap exactly, for twice as long as the cap allows.
    for (let i = 0; i < AWARD_PER_HOUR * 2; i++) {
      h.advance(AWARD_MIN_GAP_MS + 1)
      if ((await h.call({ op: 'award', ...me, credits: MAX_PER_RACE, won: false })).ok) {
        accepted++
      }
    }
    expect(accepted).toBe(AWARD_PER_HOUR)
    // THE CEILING, stated as the number it actually is: this is the most a
    // forger can extract in an hour, against a 10,250-credit shop.
    expect(record(h.store, me.id).earned).toBe(AWARD_PER_HOUR * MAX_PER_RACE)
  })

  it('opens up again once the window has rolled off', async () => {
    const h = harness()
    const me = await mint(h)
    for (let i = 0; i < AWARD_PER_HOUR; i++) {
      h.advance(AWARD_MIN_GAP_MS + 1)
      await h.call({ op: 'award', ...me, credits: 10, won: false })
    }
    expect(errorOf(await h.call({ op: 'award', ...me, credits: 10, won: false })))
      .toBe('pace')
    h.advance(AWARD_WINDOW_MS + 1)
    expect((await h.call({ op: 'award', ...me, credits: 10, won: false })).ok).toBe(true)
  })

  it('does not lock a player out for ever when the clock goes backwards', async () => {
    const h = harness()
    const me = await mint(h)
    // A record written by a function whose clock was ahead of this one's. A gap
    // computed from it would be negative, and a naive `now - at < GAP` would be
    // true for ever.
    const rec = record(h.store, me.id)
    rec.awards = [{ at: h.now() + AWARD_WINDOW_MS * 10, paid: 80 }]
    h.store.map.set(`acct/${me.id}`, JSON.stringify(rec))
    expect((await h.call({ op: 'award', ...me, credits: 80, won: false })).ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

describe('reading a hostile record', () => {
  it('re-derives an unlock a lost write would have dropped', async () => {
    const h = harness()
    const me = await mint(h)
    const rec = record(h.store, me.id)
    rec.earned = RANKS.old
    rec.owned = []
    h.store.map.set(`acct/${me.id}`, JSON.stringify(rec))
    const p = profileOf(await h.call({ op: 'load', id: me.id, secret: me.secret }))
    // Every rank the lifetime total clears, flag or no flag.
    expect(p.unlocked).toContain('oldguard')
    expect(p.unlocked).toContain('pacer')
  })

  it('drops a retired avatar id rather than the whole account', async () => {
    const h = harness()
    const me = await mint(h)
    const rec = record(h.store, me.id)
    rec.owned = ['a-portrait-that-was-retired']
    h.store.map.set(`acct/${me.id}`, JSON.stringify(rec))
    const p = profileOf(await h.call({ op: 'load', id: me.id, secret: me.secret }))
    expect(p.unlocked).not.toContain('a-portrait-that-was-retired')
    expect(p.name).toBe(me.profile.name)
  })

  /**
   * THE STARTING GRANT IS NOT EARNINGS, and this test exists because the first
   * cut of `asRecord` assumed the opposite.
   *
   * It clamped `earned` up to `credits` on the theory that a lost write must
   * never demote a ranked player -- which sounds right and is not, because a
   * brand new account is HANDED `PRICES.cheap` credits it has not raced for.
   * The clamp turned that gift into 250 credits of progress up the rank ladder
   * before the player had finished a lap.
   */
  it('does not count the starting grant as anything the player earned', async () => {
    const h = harness()
    const me = await mint(h)
    expect(me.profile.credits).toBe(PRICES.cheap)
    expect(me.profile.earned).toBe(0)
    // And it survives a round trip through the store, which is where the clamp
    // lived: a reload must not quietly promote a player who has raced nothing.
    const p = profileOf(await h.call({ op: 'load', id: me.id, secret: me.secret }))
    expect(p.earned).toBe(0)
    expect(p.credits).toBe(PRICES.cheap)
  })

  it('takes a hand-edited earned figure at face value rather than inflating it',
    async () => {
      const h = harness()
      const me = await mint(h)
      const rec = record(h.store, me.id)
      rec.credits = 5000
      rec.earned = 0
      h.store.map.set(`acct/${me.id}`, JSON.stringify(rec))
      const p = profileOf(await h.call({ op: 'load', id: me.id, secret: me.secret }))
      expect(p.credits).toBe(5000)
      expect(p.earned).toBe(0)
      // And no rank came with the balance, which is the behaviour the clamp
      // would have got wrong: ranks are earned, not bought.
      expect(p.unlocked).not.toContain('pacer')
    })

  it('refuses a record whose name no longer satisfies the rules', async () => {
    const h = harness()
    const me = await mint(h)
    const rec = record(h.store, me.id)
    rec.name = '!!'
    h.store.map.set(`acct/${me.id}`, JSON.stringify(rec))
    // Unreadable is `nosuch`, which sends the client to mint a fresh account
    // rather than handing a screen a profile it cannot render.
    expect(errorOf(await h.call({ op: 'load', id: me.id, secret: me.secret })))
      .toBe('nosuch')
  })

  it('materialises a profile that always wears something it owns', async () => {
    const h = harness()
    const me = await mint(h)
    const rec = record(h.store, me.id)
    rec.avatarId = 'oldguard'
    h.store.map.set(`acct/${me.id}`, JSON.stringify(rec))
    const p = toProfile(record(h.store, me.id))
    expect(p.unlocked).toContain(p.avatarId)
    expect(p.avatarId).toBe(DEFAULT_AVATAR_ID)
  })
})

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/** A Map behind the `StorageLike` the service wants. */
function fakeStorage(
  opts: { blocked?: boolean; swallow?: boolean; full?: () => boolean } = {},
): StorageLike {
  const map = new Map<string, string>()
  return {
    getItem: (k) => {
      if (opts.blocked) throw new Error('SecurityError')
      return map.get(k) ?? null
    },
    setItem: (k, v) => {
      if (opts.blocked) throw new Error('QuotaExceededError')
      // `full` is the storage that fills up part-way through: reads keep
      // working and writes stop. Everything already written is still there.
      if (opts.full?.()) throw new Error('QuotaExceededError')
      // `swallow` is the nastier browser: setItem SUCCEEDS and the value is not
      // there afterwards. It is why `storageWorks` reads back rather than
      // trusting that the write did not throw.
      if (!opts.swallow) map.set(k, v)
    },
    removeItem: (k) => { map.delete(k) },
  }
}

/** A fetch that runs `handleAccount` over a memory store, so the client is
 *  tested against the real protocol rather than against a stub that agrees
 *  with it. tests/signal.test.ts makes the same argument for the probe. */
function fakeFetch(h: ReturnType<typeof harness>, fail = { now: false }): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    if (fail.now) throw new Error('network')
    const body = JSON.parse(String(init?.body ?? '{}')) as AccountRequest
    const res = await h.call(body)
    return { json: async () => res } as Response
  }) as unknown as typeof fetch
}

describe('LiveAccountService', () => {
  it('mints on first launch and remembers the credential', async () => {
    const h = harness()
    const storage = fakeStorage()
    const svc = new LiveAccountService({
      fetchImpl: fakeFetch(h), storage, randomName: () => 'Racer 4242',
    })
    const p = await svc.load()
    expect(svc.offline).toBe(false)
    expect(svc.ephemeral).toBe(false)
    expect(p.name).toBe('Racer 4242')

    // A second service on the same device loads the same account rather than
    // minting a second one.
    const again = new LiveAccountService({ fetchImpl: fakeFetch(h), storage })
    const q = await again.load()
    expect(q.id).toBe(p.id)
    expect([...h.store.map.keys()].filter((k) => k.startsWith('acct/'))).toHaveLength(1)
  })

  it('is OFFLINE but not ephemeral when the server cannot be reached', async () => {
    const h = harness()
    const storage = fakeStorage()
    const fail = { now: true }
    const svc = new LiveAccountService({
      fetchImpl: fakeFetch(h, fail), storage, randomName: () => 'Racer 4242',
    })
    const p = await svc.load()
    // A COMPLETE, USABLE PROFILE. types.ts: a player on a train still gets
    // their name over their car.
    expect(p.name).toBe('Racer 4242')
    expect(p.unlocked.length).toBeGreaterThan(0)
    expect(svc.offline).toBe(true)
    expect(svc.ephemeral).toBe(false)
    // What they cannot do is claim or spend.
    expect(await svc.setName('Vince')).toEqual({ ok: false, error: 'offline' })
    expect((await svc.buyAvatar(shopAvatar().id)).ok).toBe(false)
    // Nothing was minted server-side.
    expect([...h.store.map.keys()].filter((k) => k.startsWith('acct/'))).toHaveLength(0)
  })

  it('keeps the provisional name across a reload, then claims it when the server returns',
    async () => {
      const h = harness()
      const storage = fakeStorage()
      const fail = { now: true }
      const first = new LiveAccountService({
        fetchImpl: fakeFetch(h, fail), storage, randomName: () => 'Racer 4242',
      })
      await first.load()

      // The train comes out of the tunnel; the page is reloaded.
      fail.now = false
      const second = new LiveAccountService({ fetchImpl: fakeFetch(h, fail), storage })
      const p = await second.load()
      expect(second.offline).toBe(false)
      expect(p.name).toBe('Racer 4242')
      expect(h.store.map.has(nameKey('Racer 4242'))).toBe(true)
    })

  it('is EPHEMERAL but not offline when the browser is blocking storage', async () => {
    const h = harness()
    const svc = new LiveAccountService({
      fetchImpl: fakeFetch(h), storage: fakeStorage({ blocked: true }),
      randomName: () => 'Racer 4242',
    })
    const p = await svc.load()
    // THE PAIR THAT MATTERS, and the contract spends a paragraph on it: the
    // server is fine and this browser is not. Two different sentences.
    expect(svc.ephemeral).toBe(true)
    expect(svc.offline).toBe(false)
    expect(p.name).toBe('Racer 4242')
    // AND NOTHING WAS MINTED. A private window that minted would claim a name
    // it can never log back in to, for ever. See `storageWorks`.
    expect([...h.store.map.keys()].filter((k) => k.startsWith('acct/'))).toHaveLength(0)
    expect([...h.store.map.keys()].filter((k) => k.startsWith('name/'))).toHaveLength(0)
  })

  /**
   * A device whose storage FILLS UP after the credential is written is not
   * ephemeral, and an earlier cut of this said it was.
   *
   * `ephemeral` means "this profile disappears when you close the tab". What
   * decides that is whether the SECRET is on the device, not whether the most
   * recent cache write landed -- and a full quota still reads back everything
   * written before it filled. The account survives a reload perfectly; only the
   * cached profile snapshot goes stale, and that is re-fetched on load anyway.
   */
  it('is not ephemeral when storage fills up after the credential was written',
    async () => {
      const h = harness()
      let full = false
      const storage = fakeStorage({ full: () => full })
      const svc = new LiveAccountService({
        fetchImpl: fakeFetch(h), storage, randomName: () => 'Racer 4242',
      })
      await svc.load()
      expect(svc.ephemeral).toBe(false)

      full = true
      await svc.award(80, { won: false })
      // The cache write failed and the account is still perfectly reachable.
      expect(svc.ephemeral).toBe(false)

      // And it really does survive: a fresh service on the same storage reads
      // the credential back and loads the same account.
      const again = new LiveAccountService({ fetchImpl: fakeFetch(h), storage })
      const p = await again.load()
      expect(again.ephemeral).toBe(false)
      expect(p.name).toBe('Racer 4242')
      expect(p.credits).toBe(PRICES.cheap + 80)
    })

  it('detects a browser that accepts a write and then discards it', async () => {
    const h = harness()
    const svc = new LiveAccountService({
      fetchImpl: fakeFetch(h), storage: fakeStorage({ swallow: true }),
      randomName: () => 'Racer 4242',
    })
    await svc.load()
    expect(svc.ephemeral).toBe(true)
    expect([...h.store.map.keys()].filter((k) => k.startsWith('acct/'))).toHaveLength(0)
  })

  it('returns a real NameError rather than falling into the offline banner', async () => {
    const h = harness()
    await mint(h, 'Vince')
    const svc = new LiveAccountService({
      fetchImpl: fakeFetch(h), storage: fakeStorage(), randomName: () => 'Racer 4242',
    })
    await svc.load()
    expect(await svc.setName('Vince')).toEqual({ ok: false, error: 'taken' })
    expect(await svc.setName('ab')).toEqual({ ok: false, error: 'short' })
    // A REFUSAL IS NOT A DISCONNECTION. The server answered, so the service must
    // not now be reporting itself offline.
    expect(svc.offline).toBe(false)
  })

  it('mints afresh when the device carries a credential the server never issued',
    async () => {
      const h = harness()
      const storage = fakeStorage()
      // What a device that has been running the mock looks like: an id in the
      // mock's shape, under the live key.
      storage.setItem('sg.acct', JSON.stringify({
        v: 1, id: 'acct-3', secret: 'sec-1', profile: { name: 'Kestrel' },
      }))
      const svc = new LiveAccountService({ fetchImpl: fakeFetch(h), storage })
      const p = await svc.load()
      expect(svc.offline).toBe(false)
      // The name came across, which is the whole reason the cached profile is
      // consulted on a failed load.
      expect(p.name).toBe('Kestrel')
      expect(p.id).not.toBe('acct-3')
    })

  it('adopts the server profile after an award and never its own arithmetic', async () => {
    const h = harness()
    const svc = new LiveAccountService({
      fetchImpl: fakeFetch(h), storage: fakeStorage(), randomName: () => 'Racer 4242',
    })
    await svc.load()
    let seen: PlayerProfile | null = null
    svc.onChange = (p) => { seen = p }
    const res = await svc.award(1e9, { won: true })
    expect(res.ok).toBe(true)
    if (res.ok) {
      // The server clamped it. The client's number is a proposal.
      expect(res.value.credits).toBe(PRICES.cheap + MAX_PER_RACE)
      expect(seen).toEqual(res.value)
    }
  })

  it('reports pace refusals as a real error rather than as offline', async () => {
    const h = harness()
    const svc = new LiveAccountService({
      fetchImpl: fakeFetch(h), storage: fakeStorage(), randomName: () => 'Racer 4242',
    })
    await svc.load()
    await svc.award(80, { won: false })
    const res = await svc.award(80, { won: false })
    expect(res).toEqual({ ok: false, error: 'pace' })
    expect(svc.offline).toBe(false)
  })

  it('does not leave a disposed service writing to a screen that has gone', async () => {
    const h = harness()
    const svc = new LiveAccountService({
      fetchImpl: fakeFetch(h), storage: fakeStorage(), randomName: () => 'Racer 4242',
    })
    await svc.load()
    let calls = 0
    svc.onChange = () => { calls++ }
    svc.dispose()
    await svc.award(80, { won: false })
    expect(calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The wallet and the account, which are one number in two places
// ---------------------------------------------------------------------------
//
// `score/wallet.ts` works out what a race was worth and keeps the balance
// locally; `handleAccount` holds the real one and CLAMPS it. Between them sits
// `bankAward` in game/main.ts, wired to `Wallet.onBank` at boot, and the whole
// of its job is the last line: take the server's answer instead of the one
// this client proposed.
//
// NONE OF IT SHOWS IN A SCREENSHOT. A shop displaying 450 credits looks exactly
// like a shop displaying 200 right up until the player tries to spend them, and
// at that point it looks like the game taking their money. This is the only
// place the two numbers are ever compared.

describe('a payout, from the finish line to the balance the shop spends', () => {
  const liveService = (h: ReturnType<typeof harness>): LiveAccountService =>
    new LiveAccountService({
      fetchImpl: fakeFetch(h), storage: fakeStorage(), randomName: () => 'Racer 4242',
    })

  /** The wiring game/main.ts installs at boot, in the shape it installs it. */
  const wire = (svc: LiveAccountService, wallet: Wallet): { settled: () => Promise<void> } => {
    let posted: Promise<unknown> = Promise.resolve()
    wallet.onBank = (paid) => { posted = bankAward(svc, wallet, paid.credits, false) }
    return { settled: async () => { await posted } }
  }

  it('leaves the local wallet holding exactly what the server holds', async () => {
    const h = harness()
    const svc = liveService(h)
    const me = await svc.load()
    const wallet = new Wallet(false)
    const w = wire(svc, wallet)

    const paid = wallet.bank({ trackId: 'rustfall', score: REF_SCORE, raceTime: 190, at: 1 })
    expect(paid.credits).toBeGreaterThan(0)
    // Before the round trip the wallet believes its own arithmetic, which knows
    // nothing about the portrait credits a new account is minted with.
    expect(wallet.balance).toBe(paid.credits)
    await w.settled()

    const server = record(h.store, me.id)
    // THE SPENDABLE NUMBER IS THE SERVER'S, EXACTLY. This is the assertion the
    // shop depends on: every price check on this client is now made against a
    // balance the server will agree to debit.
    expect(wallet.balance).toBe(server.credits)
    // AND IT WENT UP, not down: the server knew about a starting balance this
    // client had never heard of. `adopt` is "no merge, no max, no argument" in
    // both directions, which is what makes it safe to be blunt.
    expect(wallet.balance).toBe(PRICES.cheap + paid.credits)
    // LIFETIME IS NOT AN EXACT COPY, AND THAT IS THE WALLET'S OWN RULE RATHER
    // THAN A DISAGREEMENT. `adopt` floors `earned` at `credits` because a
    // lifetime below a balance is nonsense in a store that only ever adds to
    // it -- and a minted account holds `PRICES.cheap` it never earned. Nothing
    // reads this number for anything that matters: rank unlocks are derived
    // SERVER-side from the server's `earned`, and the profile screen draws the
    // profile, not this.
    expect(wallet.lifetime).toBeGreaterThanOrEqual(server.earned)
  })

  it('takes the CLAMPED number when the client proposes more than a race can pay',
    async () => {
      const h = harness()
      const svc = liveService(h)
      const me = await svc.load()
      const wallet = new Wallet(false)

      // Not reachable through `payout()`, which caps at the same constant --
      // this is the forged or re-tuned client the clamp exists for, and the
      // question is what the LOCAL balance says afterwards.
      const asked = MAX_PER_RACE * 7
      const got = await bankAward(svc, wallet, asked, false)

      expect(got?.credits).toBe(PRICES.cheap + MAX_PER_RACE)
      expect(wallet.balance).toBe(record(h.store, me.id).credits)
      // The proposal is nowhere on this client any more, which is the property
      // that stops a shop offering something the server will refuse to sell.
      expect(wallet.balance).toBeLessThan(asked)
      expect(record(h.store, me.id).earned).toBe(MAX_PER_RACE)
      expect(record(h.store, me.id).clamped).toBe(1)
    })

  it('keeps the local credits and adopts nothing when the post is refused',
    async () => {
      const h = harness()
      const svc = liveService(h)
      await svc.load()
      const wallet = new Wallet(false)
      const w = wire(svc, wallet)

      wallet.bank({ trackId: 'rustfall', score: REF_SCORE, raceTime: 190, at: 1 })
      await w.settled()
      const afterFirst = wallet.balance

      // A second race inside `AWARD_MIN_GAP_MS`. The server refuses it for
      // pace, and the wallet must be left alone rather than zeroed or doubled:
      // the credits were earned, they are simply not banked yet.
      const second = wallet.bank({ trackId: 'zhen9', score: REF_SCORE, raceTime: 190, at: 2 })
      expect(second.credits).toBeGreaterThan(0)
      await w.settled()
      expect(wallet.balance).toBe(afterFirst + second.credits)
    })

  it('posts nothing at all for a payout of zero', async () => {
    // `AWARD_MIN_GAP_MS` is derived from the fact that `onBank` only fires on a
    // positive payout (see its comment), so a zero-credit post would spend the
    // account's next thirty seconds of quota on nothing.
    const h = harness()
    const svc = liveService(h)
    const me = await svc.load()
    const wallet = new Wallet(false)
    expect(await bankAward(svc, wallet, 0, false)).toBeNull()
    expect(await bankAward(svc, wallet, Number.NaN, false)).toBeNull()
    expect(record(h.store, me.id).awards).toHaveLength(0)
  })
})
