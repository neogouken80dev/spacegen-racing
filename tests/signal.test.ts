/**
 * THE SIGNALLING ENDPOINT, TESTED WITHOUT DEPLOYING IT.
 *
 * `netlify/functions/signal.mts` is an HTTP shell over `handleSignal`, which
 * takes its storage and its clock as arguments. So everything the endpoint
 * actually DECIDES -- who may join, what a stale lobby is, who may set a
 * status, how a mailbox is drained -- runs here against a `Map` with the clock
 * passed in by hand, in under a millisecond, with no Netlify and no network.
 *
 * THE MAILBOX TESTS ARE THE ONES THAT MATTER. A lost ICE candidate is not a
 * missing row in a table; it is a player who watches a spinner and never gets
 * in, and neither end can see why. The whole reason the mail key is
 * `mail/<lobby>/<from>.<to>` is that it gives every blob exactly one writer, so
 * seven guests posting offers to one host cannot clobber each other -- which is
 * a property of the KEY LAYOUT and therefore something a test can pin.
 */
import { describe, it, expect } from 'vitest'
import {
  HEARTBEAT_MS, LOBBY_TTL_MS, MAX_BODY_CHARS,
  handleSignal, type SignalRequest, type SignalResponse, type SignalStore,
} from '../src/net/signalProtocol'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * A store that behaves like Blobs: JSON in, JSON out, no transactions.
 *
 * Values are round-tripped through JSON on the way in so a test cannot
 * accidentally rely on object identity that a real store would not preserve --
 * which is exactly the kind of thing that passes locally and fails deployed.
 */
function memStore(): SignalStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    get: async (k) => {
      const v = map.get(k)
      return v === undefined ? null : JSON.parse(v) as unknown
    },
    set: async (k, v) => { map.set(k, JSON.stringify(v)) },
    del: async (k) => { map.delete(k) },
  }
}

/**
 * Ids that look like the real ones.
 *
 * NOT a counter with a shared prefix, and that is load-bearing: one test below
 * asserts that a listed lobby id does not CONTAIN the private join code, and
 * with `LOBBY001`/`LOBBY002` every id shares six characters with every other
 * one and the assertion can never fail. The production `newId` is twelve
 * characters of crypto randomness; this is the same shape, seeded.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
let ids = 0
const nextId = (): string => {
  let x = (++ids * 2654435761) >>> 0
  let out = ''
  for (let i = 0; i < 12; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0
    out += ALPHABET[(x >>> 16) % ALPHABET.length]
  }
  return out
}

const SERIES = { length: 3, trackIds: ['rustfall', 'cryostatic', 'aetherion'], laps: 3 }

function harness() {
  const store = memStore()
  let clock = 1_000_000
  const call = (req: SignalRequest): Promise<SignalResponse> =>
    handleSignal(store, req, clock, nextId)
  return {
    store,
    call,
    advance: (ms: number) => { clock += ms },
    now: () => clock,
  }
}

const ok = <T extends SignalResponse>(r: SignalResponse): T => {
  expect(r.ok, `expected ok, got ${JSON.stringify(r)}`).toBe(true)
  return r as T
}

const host = { id: 'p-host', name: 'Vince' }
const guest = { id: 'p-guest', name: 'Ada' }

async function openLobby(h: ReturnType<typeof harness>, priv = false) {
  const res = ok<Extract<SignalResponse, { op: 'create' }>>(await h.call({
    op: 'create', peer: host,
    lobby: { name: 'Friday night', region: 'eu-west', maxPlayers: 8, private: priv, series: SERIES },
  }))
  return res.lobby
}

// ---------------------------------------------------------------------------

describe('the directory', () => {
  it('lists a lobby that was just created, with the host named by id', () => {
    return (async () => {
      const h = harness()
      const lb = await openLobby(h)
      const list = ok<Extract<SignalResponse, { op: 'list' }>>(await h.call({ op: 'list' }))
      expect(list.lobbies).toHaveLength(1)
      const row = list.lobbies[0]
      expect(row.id).toBe(lb.id)
      // `hostId` is what a browser row is matched against to mark it as YOUR
      // OWN lobby; `hostName` cannot do that job because names are display
      // strings and ids are not.
      expect(row.hostId).toBe(host.id)
      expect(row.hostName).toBe('Vince')
      expect(row.players).toBe(1)
      expect(row.seriesLength).toBe(3)
      expect(row.seriesRound).toBe(1)
      expect(row.trackId).toBe('rustfall')
    })()
  })

  it('never invents a ping', async () => {
    // types.ts defines pingMs as the round trip TO THE HOST. This endpoint is
    // not the host, so any number it produced would be the round trip to
    // Netlify -- a different machine on a different continent from the person
    // you are about to race. Null is the honest answer and the browser is
    // built to render it.
    const h = harness()
    await openLobby(h)
    const list = ok<Extract<SignalResponse, { op: 'list' }>>(await h.call({ op: 'list' }))
    expect(list.lobbies[0].pingMs).toBeNull()
  })

  it('forgets a lobby nobody has touched for a TTL', async () => {
    const h = harness()
    await openLobby(h)
    h.advance(LOBBY_TTL_MS - 1)
    expect(ok<Extract<SignalResponse, { op: 'list' }>>(await h.call({ op: 'list' })).lobbies)
      .toHaveLength(1)
    h.advance(2)
    expect(ok<Extract<SignalResponse, { op: 'list' }>>(await h.call({ op: 'list' })).lobbies)
      .toHaveLength(0)
  })

  it('keeps a lobby alive on nothing but its heartbeat', async () => {
    const h = harness()
    const lb = await openLobby(h)
    for (let i = 0; i < 10; i++) {
      h.advance(HEARTBEAT_MS)
      await h.call({ op: 'poll', id: lb.id, peer: host.id })
    }
    expect(ok<Extract<SignalResponse, { op: 'list' }>>(await h.call({ op: 'list' })).lobbies)
      .toHaveLength(1)
  })

  it('filters by region, joinability and text', async () => {
    const h = harness()
    await openLobby(h)
    const other = ok<Extract<SignalResponse, { op: 'create' }>>(await h.call({
      op: 'create', peer: { id: 'p-2', name: 'Bex' },
      lobby: { name: 'Sunday sprint', region: 'apac', maxPlayers: 2, private: false, series: SERIES },
    })).lobby
    const rows = (r: SignalResponse): string[] =>
      ok<Extract<SignalResponse, { op: 'list' }>>(r).lobbies.map((l) => l.id)
    expect(rows(await h.call({ op: 'list', region: 'apac' }))).toEqual([other.id])
    expect(rows(await h.call({ op: 'list', search: 'friday' }))).toHaveLength(1)
    expect(rows(await h.call({ op: 'list', search: 'bex' }))).toEqual([other.id])
    // A full lobby is still LISTED by default -- types.ts is explicit that a
    // lobby vanishing under the cursor reads as a bug -- and only hidden when
    // the caller asks for joinable rows.
    await h.call({ op: 'join', id: other.id, peer: guest })
    expect(rows(await h.call({ op: 'list' }))).toHaveLength(2)
    const joinable = rows(await h.call({ op: 'list', joinableOnly: true }))
    expect(joinable).not.toContain(other.id)
    expect(joinable).toHaveLength(1)
  })
})

describe('joining', () => {
  it('refuses with the reason the join screen renders', async () => {
    const h = harness()
    expect(await h.call({ op: 'join', id: 'NOPE', peer: guest }))
      .toMatchObject({ ok: false, error: 'notfound' })

    const small = ok<Extract<SignalResponse, { op: 'create' }>>(await h.call({
      op: 'create', peer: host,
      lobby: { name: 'Two only', region: 'eu-west', maxPlayers: 2, private: false, series: SERIES },
    })).lobby
    ok(await h.call({ op: 'join', id: small.id, peer: guest }))
    expect(await h.call({ op: 'join', id: small.id, peer: { id: 'p-3', name: 'Cy' } }))
      .toMatchObject({ ok: false, error: 'full' })

    await h.call({ op: 'update', id: small.id, peer: host.id, status: 'racing' })
    expect(await h.call({ op: 'join', id: small.id, peer: { id: 'p-4', name: 'Di' } }))
      .toMatchObject({ ok: false, error: 'racing' })
  })

  it('needs the code for a private lobby, and never leaks it', async () => {
    const h = harness()
    const lb = await openLobby(h, true)
    expect(lb.code).toBeTruthy()
    /**
     * A private lobby is LISTED -- a friend who was given the code still has to
     * find the row -- but the row must not carry the code, and it must not
     * CONTAIN it either. The first cut of the endpoint derived the code from
     * the last six characters of the lobby id, which is public on every row,
     * so every private lobby's code was computable by anyone who could list.
     * That is what this assertion is for; a `toBeUndefined` on the field would
     * have passed.
     */
    const list = ok<Extract<SignalResponse, { op: 'list' }>>(await h.call({ op: 'list' }))
    expect(list.lobbies[0].private).toBe(true)
    expect(JSON.stringify(list.lobbies)).not.toContain(lb.code)

    expect(await h.call({ op: 'join', id: lb.id, peer: guest }))
      .toMatchObject({ ok: false, error: 'badcode' })
    expect(await h.call({ op: 'join', id: lb.id, peer: guest, code: 'ZZZZZZ' }))
      .toMatchObject({ ok: false, error: 'badcode' })
    const joined = ok<Extract<SignalResponse, { op: 'join' }>>(
      await h.call({ op: 'join', id: lb.id, peer: guest, code: (lb.code ?? '').toLowerCase() }))
    // Case-insensitive, because the code is read aloud and typed by hand.
    expect(joined.lobby.peers.map((p) => p.id).sort()).toEqual([guest.id, host.id].sort())
    // And even a MEMBER does not get the code back from the endpoint; the host
    // is the only one who has it and the only one who can pass it on.
    expect(joined.lobby.code).toBeNull()
  })

  it('treats a rejoin as a rejoin and not as a second person', async () => {
    // A guest whose poll lapsed, or who reloaded the tab, keeps their slot
    // rather than being told the lobby is full of themselves.
    const h = harness()
    const lb = ok<Extract<SignalResponse, { op: 'create' }>>(await h.call({
      op: 'create', peer: host,
      lobby: { name: 'Two only', region: 'eu-west', maxPlayers: 2, private: false, series: SERIES },
    })).lobby
    ok(await h.call({ op: 'join', id: lb.id, peer: guest }))
    const again = ok<Extract<SignalResponse, { op: 'join' }>>(
      await h.call({ op: 'join', id: lb.id, peer: guest }))
    expect(again.lobby.peers).toHaveLength(2)
  })

  it('refuses a series that is not a series', async () => {
    const h = harness()
    const bad = (series: unknown): Promise<SignalResponse> => h.call({
      op: 'create', peer: host,
      lobby: {
        name: 'x', region: 'eu-west', maxPlayers: 8, private: false,
        series: series as { length: number; trackIds: string[]; laps: number },
      },
    })
    // Not one of the four lengths on the menu.
    expect(await bad({ length: 4, trackIds: ['a', 'b', 'c', 'd'], laps: 3 }))
      .toMatchObject({ ok: false, error: 'bad-series' })
    // Fewer circuits than rounds: a series that runs out of tracks halfway is
    // a state the lobby screen has nothing to render.
    expect(await bad({ length: 3, trackIds: ['a', 'b'], laps: 3 }))
      .toMatchObject({ ok: false, error: 'bad-series' })
    // A repeat makes `standings.finishes` ambiguous about which round a result
    // belongs to.
    expect(await bad({ length: 3, trackIds: ['a', 'b', 'a'], laps: 3 }))
      .toMatchObject({ ok: false, error: 'bad-series' })
  })
})

describe('the mailbox', () => {
  const letters = async (h: ReturnType<typeof harness>, id: string, peer: string,
    since: Record<string, number> = {}) =>
    ok<Extract<SignalResponse, { op: 'poll' }>>(await h.call({ op: 'poll', id, peer, since })).mail

  it('carries an offer from a guest to a host and back again', async () => {
    const h = harness()
    const lb = await openLobby(h)
    ok(await h.call({ op: 'join', id: lb.id, peer: guest }))
    ok(await h.call({
      op: 'send', id: lb.id, from: guest.id, to: host.id,
      msgs: [{ kind: 'offer', body: '{"sdp":"v=0"}' }, { kind: 'ice', body: '{"c":1}' }],
    }))
    const mail = await letters(h, lb.id, host.id)
    expect(mail[guest.id].map((m) => m.kind)).toEqual(['offer', 'ice'])
    expect(mail[guest.id][0].seq).toBe(1)
    expect(mail[guest.id][1].seq).toBe(2)
    // The host's own inbox from itself is never included.
    expect(mail[host.id]).toBeUndefined()
  })

  it('does not hand the same letter over twice', async () => {
    const h = harness()
    const lb = await openLobby(h)
    ok(await h.call({ op: 'join', id: lb.id, peer: guest }))
    ok(await h.call({
      op: 'send', id: lb.id, from: guest.id, to: host.id,
      msgs: [{ kind: 'offer', body: 'a' }],
    }))
    const first = await letters(h, lb.id, host.id)
    const top = first[guest.id][0].seq
    expect(await letters(h, lb.id, host.id, { [guest.id]: top })).toEqual({})
    ok(await h.call({
      op: 'send', id: lb.id, from: guest.id, to: host.id,
      msgs: [{ kind: 'ice', body: 'b' }],
    }))
    const second = await letters(h, lb.id, host.id, { [guest.id]: top })
    expect(second[guest.id].map((m) => m.body)).toEqual(['b'])
  })

  it('gives every directed pair its own blob, so nothing is clobbered', async () => {
    // THE PROPERTY THE KEY LAYOUT EXISTS FOR. Seven guests all posting an
    // offer to one host is the busiest moment this endpoint ever has, and with
    // a shared inbox blob a read-modify-write would drop all but the last --
    // producing six players on a permanent spinner and nothing in any log.
    const h = harness()
    const lb = await openLobby(h)
    const guests = Array.from({ length: 7 }, (_, i) => ({ id: `g${i}`, name: `G${i}` }))
    for (const g of guests) ok(await h.call({ op: 'join', id: lb.id, peer: g }))
    for (const g of guests) {
      ok(await h.call({
        op: 'send', id: lb.id, from: g.id, to: host.id,
        msgs: [{ kind: 'offer', body: `offer-from-${g.id}` }],
      }))
    }
    const mail = await letters(h, lb.id, host.id)
    expect(Object.keys(mail).sort()).toEqual(guests.map((g) => g.id).sort())
    for (const g of guests) expect(mail[g.id][0].body).toBe(`offer-from-${g.id}`)
    // And it really is one blob per pair rather than one big one.
    const keys = [...h.store.map.keys()].filter((k) => k.startsWith(`mail/${lb.id}/`))
    expect(keys).toHaveLength(7)
  })

  it('throws away a body too large to be an SDP', async () => {
    const h = harness()
    const lb = await openLobby(h)
    ok(await h.call({ op: 'join', id: lb.id, peer: guest }))
    ok(await h.call({
      op: 'send', id: lb.id, from: guest.id, to: host.id,
      msgs: [{ kind: 'offer', body: 'x'.repeat(MAX_BODY_CHARS + 1) }],
    }))
    expect(await letters(h, lb.id, host.id)).toEqual({})
  })

  it('stops delivering from a peer the lobby has forgotten', async () => {
    const h = harness()
    const lb = await openLobby(h)
    ok(await h.call({ op: 'join', id: lb.id, peer: guest }))
    ok(await h.call({
      op: 'send', id: lb.id, from: guest.id, to: host.id,
      msgs: [{ kind: 'offer', body: 'a' }],
    }))
    h.advance(LOBBY_TTL_MS + 1)
    // The host keeps the lobby alive by polling; the guest, who has not, is
    // gone, and their stale offer must not open a peer connection to nobody.
    expect(await letters(h, lb.id, host.id)).toEqual({})
  })
})

describe('who may say what', () => {
  it('lets only the host publish the directory row', async () => {
    // A guest who could set the status could hide a lobby from the browser, or
    // mark somebody else's room as racing so nobody could join it.
    const h = harness()
    const lb = await openLobby(h)
    ok(await h.call({ op: 'join', id: lb.id, peer: guest }))
    expect(await h.call({ op: 'update', id: lb.id, peer: guest.id, status: 'racing' }))
      .toMatchObject({ ok: false, error: 'not-host' })
    ok(await h.call({ op: 'update', id: lb.id, peer: host.id, status: 'racing' }))
    const list = ok<Extract<SignalResponse, { op: 'list' }>>(await h.call({ op: 'list' }))
    expect(list.lobbies[0].status).toBe('racing')
  })

  it('closes the lobby when the host says goodbye, and says WHY', async () => {
    const h = harness()
    const lb = await openLobby(h)
    ok(await h.call({ op: 'join', id: lb.id, peer: guest }))
    ok(await h.call({ op: 'bye', id: lb.id, peer: host.id }))
    // Dropped from the directory immediately...
    expect(ok<Extract<SignalResponse, { op: 'list' }>>(await h.call({ op: 'list' })).lobbies)
      .toHaveLength(0)
    // ...but left in place so the guest's next poll gets the reason. "The host
    // left" and "this lobby never existed" are different sentences and the
    // guest is entitled to the right one.
    const poll = ok<Extract<SignalResponse, { op: 'poll' }>>(
      await h.call({ op: 'poll', id: lb.id, peer: guest.id }))
    expect(poll.lobby?.status).toBe('closed')
  })

  it('only removes the one who left when a guest says goodbye', async () => {
    const h = harness()
    const lb = await openLobby(h)
    ok(await h.call({ op: 'join', id: lb.id, peer: guest }))
    ok(await h.call({ op: 'bye', id: lb.id, peer: guest.id }))
    const poll = ok<Extract<SignalResponse, { op: 'poll' }>>(
      await h.call({ op: 'poll', id: lb.id, peer: host.id }))
    expect(poll.lobby?.status).toBe('open')
    expect(poll.lobby?.peers.map((p) => p.id)).toEqual([host.id])
  })
})
