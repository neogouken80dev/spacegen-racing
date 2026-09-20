/**
 * REACHING THE PLAYERS NAT BLOCKS, AND NOT BREAKING THE ONES IT DOES NOT.
 * ---------------------------------------------------------------------------
 * Between a tenth and a fifth of connections cannot traverse NAT. types.ts
 * says so, `FAILURE_TEXT.nat` is the sentence those players currently get, and
 * a relay is the only thing that changes the answer for them.
 *
 * THE RISK IN ADDING ONE IS NOT THAT IT FAILS TO WORK. It is that it breaks
 * the eighty-five percent for whom everything already works -- a credential
 * endpoint that 500s, a body in a shape `RTCPeerConnection` throws on, a
 * provider having a bad afternoon. Every test below is about that: the
 * fallback is `DEFAULT_ICE`, always, and `DEFAULT_ICE` is exactly what ships
 * today.
 *
 * The second half is the number the relay changes. A relayed guest's round
 * trip is bigger, `inputDelayFor` reads the worst path in the room, and the
 * host publishes it once for everybody -- so a room with one relayed player
 * and six direct ones has to compute a delay that is right for the pair that
 * pays for BOTH legs, not for the host's own link.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  DEFAULT_ICE, cleanIceServers, forgetIce, hasTurn, resolveIce, worstPathOf,
} from '../src/net/webrtc'
import { inputDelayFor, UNKNOWN_PING_MS } from '../src/net/live'

afterEach(() => { forgetIce() })

/** Cloudflare's answer, verbatim from their documented response shape. */
const CLOUDFLARE = [
  { urls: ['stun:stun.cloudflare.com:3478'] },
  {
    urls: [
      'turn:turn.cloudflare.com:3478?transport=udp',
      'turn:turn.cloudflare.com:3478?transport=tcp',
      'turn:turn.cloudflare.com:80?transport=tcp',
      'turns:turn.cloudflare.com:5349?transport=tcp',
      'turns:turn.cloudflare.com:443?transport=tcp',
    ],
    username: 'g-minted-username',
    credential: 'g-minted-credential',
  },
]

function reply(body: unknown, status = 200): typeof fetch {
  return (async () => ({
    ok: status < 400,
    status,
    json: async () => body,
  })) as unknown as typeof fetch
}

// ---------------------------------------------------------------------------

describe('where the ICE servers come from', () => {
  it('takes explicit servers over everything, which is what the probe needs', async () => {
    // AN EMPTY ARRAY IS A REAL INSTRUCTION AND NOT AN ABSENT ONE. Two contexts
    // on one loopback reach each other on host candidates alone, and pointing
    // them at a STUN server the sandbox cannot reach adds the whole gathering
    // timeout to every connection -- so tools/probe-netcode.mjs passes `[]`
    // and means it.
    expect(await resolveIce({ servers: [] })).toEqual([])
    const mine = [{ urls: 'stun:example.test:3478' }]
    expect(await resolveIce({ servers: mine })).toEqual(mine)
  })

  it('asks the endpoint and uses what it mints', async () => {
    const got = await resolveIce({
      endpoint: '/api/signal',
      fetchImpl: reply({ ok: true, op: 'ice', iceServers: CLOUDFLARE }),
    })
    expect(hasTurn(got)).toBe(true)
    const turn = got.find((s) => hasTurn([s]))
    expect(turn?.username).toBe('g-minted-username')
    expect(turn?.credential).toBe('g-minted-credential')
  })

  it('falls back to STUN when nothing is configured', async () => {
    // TODAY'S BEHAVIOUR, WHICH MUST NOT REGRESS. The endpoint answers
    // `no-ice` when the environment variables are not set, which is the state
    // of every deploy until Vince sets them.
    const got = await resolveIce({
      endpoint: '/api/signal',
      fetchImpl: reply({ ok: false, error: 'no-ice' }),
    })
    expect(got).toEqual(DEFAULT_ICE)
    expect(hasTurn(got)).toBe(false)
  })

  it('falls back to STUN when the endpoint is down, and does not reject', async () => {
    // A relay provider having a bad afternoon costs the ~15% who need one. A
    // rejection here would cost everybody, because nothing above this can
    // start a lobby without an answer.
    const thrower = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect(await resolveIce({ endpoint: '/api/signal', fetchImpl: thrower }))
      .toEqual(DEFAULT_ICE)
    forgetIce()
    expect(await resolveIce({ endpoint: '/api/signal', fetchImpl: reply(null, 500) }))
      .toEqual(DEFAULT_ICE)
  })

  it('falls back to STUN when the answer is the wrong shape', async () => {
    // A MALFORMED ENTRY THROWS INSIDE THE RTCPeerConnection CONSTRUCTOR, which
    // would take the whole lobby down rather than one relay.
    for (const junk of [{ iceServers: 'nope' }, { iceServers: [{}] },
      { iceServers: [{ urls: 'http://not-a-stun-url' }] }, {}]) {
      forgetIce()
      expect(await resolveIce({ endpoint: '/api/signal', fetchImpl: reply(junk) }))
        .toEqual(DEFAULT_ICE)
    }
  })

  it('does not ask at all when the endpoint is turned off', async () => {
    let asked = 0
    const counting = (async () => { asked++; return { ok: true, json: async () => ({}) } }) as unknown as typeof fetch
    expect(await resolveIce({ endpoint: null, fetchImpl: counting })).toEqual(DEFAULT_ICE)
    expect(asked).toBe(0)
  })

  it('asks once and reuses the answer', async () => {
    // A credential is minted with a TTL; asking per peer connection would be
    // one request per player per round for an answer that does not change.
    let asked = 0
    const counting = (async () => {
      asked++
      return { ok: true, status: 200, json: async () => ({ ok: true, iceServers: CLOUDFLARE }) }
    }) as unknown as typeof fetch
    await resolveIce({ endpoint: '/api/signal', fetchImpl: counting }, 1_000_000)
    await resolveIce({ endpoint: '/api/signal', fetchImpl: counting }, 1_000_100)
    expect(asked).toBe(1)
    // ...and asks again once the cache is older than the window, so a
    // credential cannot expire under a lobby that has been open an hour.
    await resolveIce({ endpoint: '/api/signal', fetchImpl: counting }, 1_000_000 + 21 * 60_000)
    expect(asked).toBe(2)
  })
})

describe('what counts as a usable ICE server', () => {
  it('keeps only the schemes a browser understands', () => {
    const got = cleanIceServers([
      { urls: 'stun:a.test:3478' },
      { urls: ['turn:b.test:3478', 'https://c.test'] },
      { urls: 123 },
      'not an object',
      null,
    ])
    expect(got).toEqual([
      { urls: ['stun:a.test:3478'] },
      { urls: ['turn:b.test:3478'] },
    ])
  })

  it('carries credentials through, and only as strings', () => {
    const got = cleanIceServers([
      { urls: 'turn:a.test', username: 'u', credential: 'c' },
      { urls: 'turn:b.test', username: 5, credential: {} },
    ])
    expect(got?.[0]).toEqual({ urls: ['turn:a.test'], username: 'u', credential: 'c' })
    expect(got?.[1]).toEqual({ urls: ['turn:b.test'] })
  })

  it('answers null when nothing usable is left, so the caller falls back', () => {
    expect(cleanIceServers([])).toBeNull()
    expect(cleanIceServers([{ urls: [] }])).toBeNull()
    expect(cleanIceServers('nope')).toBeNull()
  })

  it('knows a relay from a STUN server, which is the only thing that changes '
    + 'the answer for a player behind a symmetric NAT', () => {
    expect(hasTurn(DEFAULT_ICE)).toBe(false)
    expect(hasTurn(cleanIceServers(CLOUDFLARE) ?? [])).toBe(true)
    expect(hasTurn([{ urls: ['turns:a.test:443?transport=tcp'] }])).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// What a relay does to the input delay
// ---------------------------------------------------------------------------

describe('the input delay, when some guests are relayed and some are not', () => {
  it('sums the two worst legs on the host, relayed or not', () => {
    /**
     * A RELAYED GUEST NEEDS NO SPECIAL CASE, AND THAT IS THE ASSERTION.
     *
     * The extra hop is already inside `pingMs` -- the ping travels the same
     * path the inputs do -- so a room with one relayed guest at 300ms and two
     * direct ones at 30ms produces 330, which is exactly what an input from
     * the relayed player costs on its way to a direct one. Adding a penalty on
     * top would count the hop twice; skipping relayed links would count it
     * none, and the symptom of the second is a race that stalls constantly for
     * reasons the host cannot see.
     */
    expect(worstPathOf([30, 300, 30], true)).toBe(330)
    expect(worstPathOf([30, 30, 30], true)).toBe(60)
    // Order must not matter: the sort is over legs, not over arrival.
    expect(worstPathOf([300, 30, 30], true)).toBe(330)
    expect(worstPathOf([30, 30, 300], true)).toBe(330)
  })

  it('does not sum a room with one guest, because there is no second leg', () => {
    expect(worstPathOf([300], true)).toBe(300)
    expect(worstPathOf([], true)).toBe(0)
  })

  it('counts an unmeasured leg as slow rather than as free', () => {
    // A peer whose ping has not landed is not a peer with no latency, and a
    // delay derived from zeroes stalls the race from frame one.
    expect(worstPathOf([null, 30], true, UNKNOWN_PING_MS)).toBe(UNKNOWN_PING_MS + 30)
    expect(worstPathOf([null, null], true, UNKNOWN_PING_MS)).toBe(UNKNOWN_PING_MS * 2)
  })

  it('gives a guest its own leg only, which is a floor and is documented as one', () => {
    // A guest holds one link. Its own opinion of the room's worst path would
    // be one real number and six inventions, so the host publishes the real
    // one and the guest takes the larger of the two.
    expect(worstPathOf([300, 30], false)).toBe(300)
  })

  it('buys more frames of delay for a relayed room, up to the clamp', () => {
    const direct = inputDelayFor(worstPathOf([30, 30], true))
    const relayed = inputDelayFor(worstPathOf([30, 300], true))
    expect(relayed).toBeGreaterThan(direct)
    // AND THE CLAMP IS A REAL CEILING. Twelve frames covers a 400ms worst
    // path; past that the room does not get a bigger buffer, it gets a race
    // that stalls. That is the right failure -- 200ms of input delay is
    // already at the edge of drivable -- but it is why a relay is a fallback
    // and not a default.
    expect(inputDelayFor(400)).toBe(12)
    expect(inputDelayFor(2000)).toBe(12)
    expect(relayed).toBeLessThanOrEqual(12)
  })
})
