/**
 * THE MOCK BACKEND, TESTED FOR THE THINGS A SCREENSHOT CANNOT SHOW.
 *
 * A probe can photograph a lobby browser. What it cannot do is prove that the
 * list would have CHANGED if it had waited, that Start refuses a room where
 * somebody is still connecting, that a host leaving takes the room away from
 * everybody else, or that a private window does not take the game down. Those
 * are the properties the mock exists to give the UI, so they are the ones
 * pinned here.
 *
 * EVERYTHING RUNS ON FAKE TIMERS. The mock is built out of latency and a clock
 * -- that is the whole point of it -- so a test that waited on real time would
 * take minutes and would still be a coin toss. `vi.useFakeTimers()` also fakes
 * `Date.now`, which is what `world.now()` reads, so the world's sense of time
 * and the test's advance are the same clock.
 *
 * AND EVERYTHING IS SEEDED. Every random decision in mock.ts draws from one
 * `Rng`, so a fixed seed plus a fixed sequence of calls is a fixed world. Where
 * a test cares about a state machine rather than about timing it also passes
 * `latencyScale: 0` and `failureRate: 0`, which turns the network into a
 * next-tick function and leaves only the logic under test.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  GRID_SIZE, TICK_MS, UNKNOWN_PING_MS,
  checkNameShape, createMockAccountService, createMockLobbyService, createMockWorld,
  inputDelayFor,
  type MockWorld, type StorageLike,
} from '../src/net/mock'
import {
  LOBBY_MAX_PLAYERS, LOBBY_MIN_PLAYERS, SERIES_LENGTHS,
  type LobbyRoom, type LobbySummary, type RaceStartPacket,
  type SeriesLength, type SeriesPlan, type SeriesStanding,
} from '../src/net/types'
import {
  AVATARS, DEFAULT_AVATAR_ID, PRICES, RANKS, STARTER_IDS, canBuy, ownsAvatar, priceOf,
} from '../src/content/avatars'
import { DEFAULT_PROFILE, accountService, lobbyService, netProfile, resetNetServices } from '../src/net/index'
import { CHASSIS } from '../src/content/chassis'
import { PILOTS } from '../src/content/pilots'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Worlds and services created by a test, torn down after it. */
const junk: { dispose(): void }[] = []

function track<T extends { dispose(): void }>(thing: T): T {
  junk.push(thing)
  return thing
}

afterEach(() => {
  for (const t of junk.splice(0)) t.dispose()
  vi.useRealTimers()
})

/**
 * A single race, in the shape a lobby is now created in.
 *
 * `create` used to take `trackId` and `laps`; it takes a `SeriesPlan`, and a
 * one-off is a plan of length 1. Every test below that only wanted "a lobby on
 * Rustfall" says so through this, which is also the thing it is asserting --
 * that a single race goes down the series path and comes out looking like a
 * single race.
 */
function single(trackId: string, laps = 3): SeriesPlan {
  return { length: 1, trackIds: [trackId], laps, difficulty: 'normal' }
}

/** A world with its clock stopped, so a test ticks it by hand. */
function stillWorld(seed: number): MockWorld {
  vi.useFakeTimers()
  return track(createMockWorld({ seed, autoTick: false }))
}

/** Let a pending call land. The default covers the slowest simulated response. */
async function settle<T>(p: Promise<T>, ms = 1500): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms)
  return p
}

/** Beat the world's heart n times, moving the clock with it. */
async function beat(world: MockWorld, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await vi.advanceTimersByTimeAsync(TICK_MS)
    world.tick()
  }
}

function memStorage(): StorageLike {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v) },
    removeItem: (k) => { map.delete(k) },
  }
}

/** A storage that throws on everything, like a partitioned iframe's. */
function hostileStorage(): StorageLike {
  return {
    getItem() { throw new Error('SecurityError: storage is blocked') },
    setItem() { throw new Error('SecurityError: storage is blocked') },
    removeItem() { throw new Error('SecurityError: storage is blocked') },
  }
}

const unwrap = <T,>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`)
  return r.value
}

// ---------------------------------------------------------------------------

describe('the mock behaves like a network, not like a function call', () => {
  it('resolves nothing synchronously', async () => {
    const world = stillWorld(11)
    const svc = track(createMockLobbyService({ world }))
    let landed = false
    const p = svc.list().then((r) => { landed = true; return r })
    // Not on this turn of the loop, and not on the next one either.
    await vi.advanceTimersByTimeAsync(0)
    expect(landed).toBe(false)
    // The floor of the fast mode is 110ms, so 100 is still too early.
    await vi.advanceTimersByTimeAsync(100)
    expect(landed).toBe(false)
    expect(unwrap(await settle(p)).length).toBeGreaterThan(0)
  })

  it('lets a later request beat an earlier one home', async () => {
    // THE REASON THE LATENCY IS BIMODAL. If every response took the same time,
    // responses would arrive in issue order for ever and the single commonest
    // lobby-browser bug -- refresh N+1 rendered, then refresh N lands and
    // overwrites it with stale rows -- could not be reproduced at all.
    const world = stillWorld(23)
    const svc = track(createMockLobbyService({ world, failureRate: 0 }))
    const order: number[] = []
    const calls: Promise<unknown>[] = []
    for (let i = 0; i < 24; i++) {
      calls.push(svc.list().then((r) => { order.push(i); return r }))
    }
    await vi.advanceTimersByTimeAsync(4000)
    await Promise.all(calls)
    expect(order).toHaveLength(24)
    const inIssueOrder = order.every((v, i) => v === i)
    expect(inIssueOrder).toBe(false)
  })

  it('fails often enough that the error path is reachable', async () => {
    const world = stillWorld(7)
    const svc = track(createMockLobbyService({ world, failureRate: 0.5 }))
    const results = []
    for (let i = 0; i < 40; i++) results.push(settle(svc.list(), 2000))
    const seen = await Promise.all(results)
    expect(seen.some((r) => !r.ok)).toBe(true)
    expect(seen.some((r) => r.ok)).toBe(true)
    // And a failure carries a reason rather than an empty list, which a UI
    // would otherwise render as "no lobbies" -- the wrong screen entirely.
    for (const r of seen) if (!r.ok) expect(r.error.length).toBeGreaterThan(0)
  })

  it('settles calls that were in flight when the screen was torn down', async () => {
    // A promise that never resolves is a leak with a UI awaiting it, and in a
    // test it is a timeout with no message attached.
    const world = stillWorld(31)
    const svc = createMockLobbyService({ world })
    const p = svc.list()
    svc.dispose()
    const r = await p
    expect(r.ok).toBe(false)
  })
})

describe('the directory is alive', () => {
  const fingerprint = (rows: readonly LobbySummary[]): string =>
    [...rows].map((r) => `${r.id}:${r.players}/${r.maxPlayers}:${r.status}`).sort().join('|')

  it('changes under a player who is just browsing', async () => {
    const world = stillWorld(101)
    const svc = track(createMockLobbyService({ world, failureRate: 0, latencyScale: 0 }))
    const first = fingerprint(unwrap(await settle(svc.list(), 10)))

    // Thirty seconds of browsing is ~19 ticks at TICK_MS.
    let changes = 0
    let prev = first
    for (let i = 0; i < 19; i++) {
      await beat(world, 1)
      const now = fingerprint(unwrap(await settle(svc.list(), 10)))
      if (now !== prev) changes++
      prev = now
    }
    expect(prev).not.toBe(first)
    // Not one lucky change at the end: the list keeps moving.
    expect(changes).toBeGreaterThan(3)
  })

  it('opens, fills, races, and closes lobbies over a longer sit', async () => {
    const world = stillWorld(202)
    const svc = track(createMockLobbyService({ world, failureRate: 0, latencyScale: 0 }))
    const statuses = new Set<string>()
    let appeared = 0
    let vanished = 0
    let known = new Set<string>()

    // Three minutes of fake time. A mocked race lasts 40-90s, so this is long
    // enough for the whole open -> full -> racing -> open cycle to come round.
    for (let i = 0; i < 112; i++) {
      await beat(world, 1)
      const rows = unwrap(await settle(svc.list(), 10))
      const ids = new Set(rows.map((r) => r.id))
      for (const r of rows) statuses.add(r.status)
      for (const id of ids) if (!known.has(id)) appeared++
      for (const id of known) if (!ids.has(id)) vanished++
      known = ids
    }

    expect(statuses.has('open')).toBe(true)
    expect(statuses.has('full')).toBe(true)
    expect(statuses.has('racing')).toBe(true)
    expect(statuses.has('closed')).toBe(true)
    expect(appeared).toBeGreaterThan(0)
    expect(vanished).toBeGreaterThan(0)
    // The directory does not run away or collapse while all that happens.
    const finalRows = unwrap(await settle(svc.list(), 10))
    expect(finalRows.length).toBeGreaterThanOrEqual(8)
    expect(finalRows.length).toBeLessThanOrEqual(20)
  })

  it('keeps a closed lobby listed for a beat, then drops it', async () => {
    const world = stillWorld(303)
    const svc = track(createMockLobbyService({ world, failureRate: 0, latencyScale: 0 }))
    const victim = [...world.lobbies.values()][0]
    world.closeLobby(victim, 'hostLeft')

    // Still listed, and listed AS closed -- a row that vanishes under the
    // cursor reads as a bug, which is the whole reason the state exists.
    const shown = unwrap(await settle(svc.list(), 10))
    expect(shown.find((r) => r.id === victim.id)?.status).toBe('closed')

    await beat(world, 6)
    const later = unwrap(await settle(svc.list(), 10))
    expect(later.some((r) => r.id === victim.id)).toBe(false)
  })

  it('filters by region, by joinability and by text', async () => {
    const world = stillWorld(404)
    const svc = track(createMockLobbyService({ world, failureRate: 0, latencyScale: 0 }))
    const all = unwrap(await settle(svc.list(), 10))

    const region = all[0].region
    const byRegion = unwrap(await settle(svc.list({ region }), 10))
    expect(byRegion.length).toBeGreaterThan(0)
    expect(byRegion.every((r) => r.region === region)).toBe(true)
    expect(unwrap(await settle(svc.list({ region: 'any' }), 10)).length).toBe(all.length)

    const joinable = unwrap(await settle(svc.list({ joinableOnly: true }), 10))
    expect(joinable.every((r) => r.status === 'open')).toBe(true)

    const host = all[0].hostName
    const byName = unwrap(await settle(svc.list({ search: host.toLowerCase() }), 10))
    expect(byName.some((r) => r.hostName === host)).toBe(true)
    expect(unwrap(await settle(svc.list({ search: 'zzzznotathing' }), 10))).toHaveLength(0)
  })
})

describe('ping arrives late, and sometimes never', () => {
  it('starts every row unknown', async () => {
    const world = stillWorld(505)
    const svc = track(createMockLobbyService({ world, failureRate: 0, latencyScale: 0 }))
    const first = unwrap(await settle(svc.list(), 10))
    // Not zero, not a guess from the region: null. The probe has not been sent
    // yet, let alone answered.
    expect(first.every((r) => r.pingMs === null)).toBe(true)
  })

  it('fills rows in raggedly rather than all at once', async () => {
    const world = stillWorld(606)
    const svc = track(createMockLobbyService({ world, failureRate: 0, latencyScale: 0 }))
    await settle(svc.list(), 10)

    // Probes are scheduled 350-2600ms out, so partway through that window some
    // rows know their ping and some do not. That intermediate state is one a
    // sorted list has to survive, so it has to exist.
    await vi.advanceTimersByTimeAsync(1200)
    const mid = unwrap(await settle(svc.list(), 10))
    expect(mid.some((r) => r.pingMs !== null)).toBe(true)
    expect(mid.some((r) => r.pingMs === null)).toBe(true)

    await vi.advanceTimersByTimeAsync(4000)
    const late = unwrap(await settle(svc.list(), 10))
    for (const r of late) {
      if (r.pingMs !== null) expect(r.pingMs).toBeGreaterThan(0)
    }
    expect(late.filter((r) => r.pingMs !== null).length)
      .toBeGreaterThan(mid.filter((r) => r.pingMs !== null).length)
  })

  it('leaves the unreachable hosts unknown for ever', async () => {
    const world = stillWorld(707)
    const svc = track(createMockLobbyService({ world, failureRate: 0, latencyScale: 0 }))
    const never = [...world.lobbies.values()].filter((lb) => lb.probe.never)
    // ~1 in 6 of the directory, matching the NAT-traversal share types.ts cites.
    expect(never.length).toBeGreaterThan(0)
    await settle(svc.list(), 10)
    await vi.advanceTimersByTimeAsync(60_000)
    const rows = unwrap(await settle(svc.list(), 10))
    for (const lb of never) {
      const row = rows.find((r) => r.id === lb.id)
      if (row) expect(row.pingMs).toBeNull()
    }
  })
})

describe('a room with other people in it', () => {
  it('has members who ready up, swap cars, drop and leave', async () => {
    // Asserted across the whole directory rather than one room, because each
    // kind of change is a per-tick probability and one room over twenty ticks
    // is not enough samples to pin all four without being a coin toss.
    const world = stillWorld(808)
    type Snap = Record<string, { ready: boolean; connecting: boolean; car: string }>
    const snap = (): Record<string, Snap> => {
      const out: Record<string, Snap> = {}
      for (const lb of world.lobbies.values()) {
        const members: Snap = {}
        for (const m of lb.members) {
          members[m.playerId] = {
            ready: m.ready,
            connecting: m.connecting,
            car: `${m.chassisId}/${m.pilotId}`,
          }
        }
        out[lb.id] = members
      }
      return out
    }

    const seen = { readied: 0, connected: 0, dropped: 0, swapped: 0, joined: 0, left: 0 }
    let prev = snap()
    for (let i = 0; i < 40; i++) {
      await beat(world, 1)
      const now = snap()
      for (const [lobbyId, members] of Object.entries(prev)) {
        const after = now[lobbyId]
        if (!after) continue
        for (const [id, was] of Object.entries(members)) {
          const is = after[id]
          if (!is) { seen.left++; continue }
          if (!was.ready && is.ready) seen.readied++
          if (was.connecting && !is.connecting) seen.connected++
          if (!was.connecting && is.connecting) seen.dropped++
          if (was.car !== is.car) seen.swapped++
        }
        for (const id of Object.keys(after)) if (!(id in members)) seen.joined++
      }
      prev = now
    }

    expect(seen.readied).toBeGreaterThan(0)
    expect(seen.connected).toBeGreaterThan(0)
    expect(seen.dropped).toBeGreaterThan(0)
    expect(seen.swapped).toBeGreaterThan(0)
    expect(seen.joined).toBeGreaterThan(0)
    expect(seen.left).toBeGreaterThan(0)
  })

  it('pushes the room to the player sitting in it', async () => {
    const world = stillWorld(909)
    const svc = track(createMockLobbyService({ world, failureRate: 0, latencyScale: 0 }))
    const open = [...world.lobbies.values()]
      .find((lb) => lb.status === 'open' && !lb.private && lb.members.length < lb.maxPlayers)
    expect(open).toBeDefined()

    const pushes: (LobbyRoom | null)[] = []
    svc.onRoom = (room) => pushes.push(room)
    const room = unwrap(await settle(svc.join(open!.id), 10))
    expect(room.members.some((m) => m.playerId === room.localId)).toBe(true)

    await beat(world, 8)
    // The room screen is not a still life: it was told about the world moving
    // without having asked for anything.
    expect(pushes.length).toBeGreaterThan(2)
  })

  it('connects the local player a moment after they join, not instantly', async () => {
    const world = stillWorld(1001)
    const svc = track(createMockLobbyService({ world, failureRate: 0 }))
    const open = [...world.lobbies.values()]
      .find((lb) => lb.status === 'open' && !lb.private && lb.members.length < lb.maxPlayers)!
    const room = unwrap(await settle(svc.join(open.id)))
    // The room you are handed by join() has you in it and still connecting:
    // your peer link is not up the instant the directory says you are seated.
    const mine = room.members.find((m) => m.playerId === room.localId)!
    expect(mine.connecting).toBe(true)
    expect(mine.pingMs).toBeNull()

    // Simulated ICE is 600-2200ms, so it is certainly done by here.
    await vi.advanceTimersByTimeAsync(3000)
    const row = () => world.lobbies.get(open.id)!.members
      .find((m) => m.playerId === room.localId)!
    expect(row().connecting).toBe(false)

    // And Ready does not take while the link is coming up -- which is the
    // "button that lies" case: the UI may show it pressed while the request is
    // in flight, and the push that follows is what is true. Forced rather than
    // raced, so the assertion is about the rule and not about the clock.
    row().connecting = true
    await settle(svc.setReady(true))
    expect(row().ready).toBe(false)
    row().connecting = false
    await settle(svc.setReady(true))
    expect(row().ready).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Two seats, one world
// ---------------------------------------------------------------------------

/**
 * A host and a guest in the same room.
 *
 * Two services sharing one world, the second given an explicit identity. This
 * is the only way to test what a peer-to-peer lobby is actually FOR: that what
 * one player does shows up for the other.
 */
async function pair(seed: number): Promise<{
  world: MockWorld
  host: ReturnType<typeof createMockLobbyService>
  guest: ReturnType<typeof createMockLobbyService>
  room: LobbyRoom
  guestRoom: LobbyRoom
  guestEvents: { closed: string[]; rooms: (LobbyRoom | null)[]; starts: RaceStartPacket[] }
  hostEvents: { closed: string[]; rooms: (LobbyRoom | null)[]; starts: RaceStartPacket[] }
}> {
  const world = stillWorld(seed)
  const opts = { world, failureRate: 0, latencyScale: 0 }
  const host = track(createMockLobbyService(opts))
  const guest = track(createMockLobbyService({
    ...opts,
    identity: { id: 'p-guest', name: 'Guestley', avatarId: DEFAULT_AVATAR_ID },
  }))
  const hostEvents = { closed: [] as string[], rooms: [] as (LobbyRoom | null)[], starts: [] as RaceStartPacket[] }
  const guestEvents = { closed: [] as string[], rooms: [] as (LobbyRoom | null)[], starts: [] as RaceStartPacket[] }
  host.onClosed = (r) => hostEvents.closed.push(r)
  host.onRoom = (r) => hostEvents.rooms.push(r)
  host.onStart = (p) => hostEvents.starts.push(p)
  guest.onClosed = (r) => guestEvents.closed.push(r)
  guest.onRoom = (r) => guestEvents.rooms.push(r)
  guest.onStart = (p) => guestEvents.starts.push(p)

  const room = unwrap(await settle(host.create({
    name: 'Test lobby', region: 'eu-west', maxPlayers: 8,
    private: false, series: single('rustfall'),
  }), 10))
  const guestRoom = unwrap(await settle(guest.join(room.id), 10))
  // Let the guest's simulated ICE finish, so the room is startable.
  await vi.advanceTimersByTimeAsync(10)
  return { world, host, guest, room, guestRoom, hostEvents, guestEvents }
}

describe('host semantics', () => {
  it('makes the creator the host, and only the host', async () => {
    const { room, guestRoom } = await pair(1111)
    expect(room.members.find((m) => m.playerId === room.localId)?.isHost).toBe(true)
    expect(guestRoom.members.find((m) => m.playerId === guestRoom.localId)?.isHost).toBe(false)
    expect(room.members.filter((m) => m.isHost)).toHaveLength(1)
  })

  it('refuses to start a room where anyone is unready', async () => {
    const { host, guest, world, room } = await pair(1212)
    const bad = await settle(host.start(), 10)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toBe('notready')

    // Host ready, guest still not: still refused. The host pressing Start is
    // not a statement that the host is ready.
    await settle(host.setReady(true), 10)
    expect((await settle(host.start(), 10)).ok).toBe(false)

    await settle(guest.setReady(true), 10)
    const everyone = world.lobbies.get(room.id)!.members
    expect(everyone.every((m) => m.ready && !m.connecting)).toBe(true)
    expect((await settle(host.start(), 10)).ok).toBe(true)
  })

  it('refuses to start for anybody who is not the host', async () => {
    const { host, guest } = await pair(1313)
    await settle(host.setReady(true), 10)
    await settle(guest.setReady(true), 10)
    const r = await settle(guest.start(), 10)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('nothost')
  })

  it('closes the room for everybody else when the host leaves', async () => {
    const { host, guest, world, room, guestEvents } = await pair(1414)
    await settle(host.leave(), 10)

    expect(guestEvents.closed).toContain('hostLeft')
    // Reason first, then the null room: a UI that tears down on onRoom(null)
    // must still have been told why.
    expect(guestEvents.rooms.at(-1)).toBeNull()
    expect(world.lobbies.get(room.id)?.status).toBe('closed')
    // And the guest is really out: they cannot ready up in a room that is gone.
    await settle(guest.setReady(true), 10)
    expect(world.lobbies.get(room.id)?.members ?? []).toHaveLength(0)
  })

  it('does not close the room when a guest leaves', async () => {
    const { guest, world, room, hostEvents } = await pair(1515)
    await settle(guest.leave(), 10)
    expect(world.lobbies.get(room.id)?.status).toBe('open')
    expect(world.lobbies.get(room.id)?.members).toHaveLength(1)
    expect(hostEvents.closed).toHaveLength(0)
    expect(hostEvents.rooms.at(-1)?.members).toHaveLength(1)
  })

  it('tells a kicked player why, and only them', async () => {
    const { host, world, room, guestRoom, guestEvents, hostEvents } = await pair(1616)
    await settle(host.kick(guestRoom.localId), 10)
    expect(guestEvents.closed).toEqual(['kicked'])
    expect(guestEvents.rooms.at(-1)).toBeNull()
    expect(hostEvents.closed).toHaveLength(0)
    expect(world.lobbies.get(room.id)?.members).toHaveLength(1)
  })

  it('clears every ready flag when the host changes the track', async () => {
    const { host, guest, world, room } = await pair(1717)
    await settle(host.setReady(true), 10)
    await settle(guest.setReady(true), 10)
    expect(world.lobbies.get(room.id)!.members.every((m) => m.ready)).toBe(true)

    const changed = unwrap(await settle(host.setTrack('neonspire', 5), 10))
    expect(changed.series.trackIds[changed.round]).toBe('neonspire')
    expect(changed.series.laps).toBe(5)
    // A ready you gave for one track is not a ready for another -- the host's
    // own included.
    expect(changed.members.every((m) => !m.ready)).toBe(true)
  })

  it('answers current() from what it already knows, with no round trip', async () => {
    // THE REMOUNT CASE. A screen that was torn down and rebuilt -- a phone
    // rotated, a trip to the garage and back -- missed every onRoom that fired
    // while it did not exist. current() is how it finds the room it is still
    // in, and it is synchronous because the answer is in memory: handing a
    // remounting screen a spinner for a value it already owns would be the
    // wrong trade.
    const { host, guest, room, world } = await pair(1010)
    expect(host.current()?.id).toBe(room.id)
    expect(host.current()?.localId).toBe(room.localId)
    expect(guest.current()?.localId).toBe('p-guest')
    // It is the room as THIS reader sees it, not as the host does: the join
    // code is the host's to pass on.
    expect(host.current()?.members).toHaveLength(2)
    expect(guest.current()?.joinCode).toBeNull()

    // A snapshot, like every push: a fresh object each time, so a UI may hold
    // the last one and diff against the next.
    expect(host.current()).not.toBe(host.current())
    expect(host.current()).toEqual(host.current())

    // It tracks the world without being asked.
    await settle(guest.setReady(true), 10)
    expect(host.current()!.members.find((m) => m.playerId === 'p-guest')!.ready).toBe(true)

    // And it is null the moment there is no room -- before any push arrives,
    // because the push is not what makes it true.
    await settle(guest.leave(), 10)
    expect(guest.current()).toBeNull()
    await settle(host.leave(), 10)
    expect(host.current()).toBeNull()
    expect(world.lobbies.get(room.id)?.status).toBe('closed')
  })

  it('reports current() as null for a player who never joined anything', async () => {
    const world = stillWorld(1011)
    const svc = track(createMockLobbyService({ world, failureRate: 0, latencyScale: 0 }))
    expect(svc.current()).toBeNull()
    // And after a room closes under them, without waiting for the push.
    const open = [...world.lobbies.values()]
      .find((lb) => lb.status === 'open' && !lb.private && lb.members.length < lb.maxPlayers)!
    await settle(svc.join(open.id), 10)
    expect(svc.current()?.id).toBe(open.id)
    world.closeLobby(open, 'hostLeft')
    expect(svc.current()).toBeNull()
  })

  it('clamps a lobby to the size the grid can actually start', async () => {
    const world = stillWorld(1012)
    const svc = track(createMockLobbyService({ world, failureRate: 0, latencyScale: 0 }))
    const huge = unwrap(await settle(svc.create({
      name: 'Everybody', region: 'apac', maxPlayers: 99,
      private: false, series: single('rustfall'),
    }), 10))
    // A lobby of ten would silently drop two people at the start line, because
    // buildPacket stops filling at GRID_SIZE.
    expect(huge.maxPlayers).toBe(LOBBY_MAX_PLAYERS)
    expect(GRID_SIZE).toBeGreaterThanOrEqual(LOBBY_MAX_PLAYERS)

    const tiny = unwrap(await settle(svc.create({
      name: 'Just me', region: 'apac', maxPlayers: 0,
      private: false, series: single('rustfall'),
    }), 10))
    expect(tiny.maxPlayers).toBe(LOBBY_MIN_PLAYERS)
  })

  it('names the host by id as well as by name on every row', async () => {
    const world = stillWorld(1013)
    const svc = track(createMockLobbyService({ world, failureRate: 0, latencyScale: 0 }))
    const mine = unwrap(await settle(svc.create({
      name: 'Mine', region: 'sa', maxPlayers: 4,
      private: false, series: single('rustfall'),
    }), 10))
    const rows = unwrap(await settle(svc.list(), 10))
    const row = rows.find((r) => r.id === mine.id)!
    // Which is how a browser marks YOUR lobby without comparing display names,
    // two of which can legitimately be the same string in different rooms.
    expect(row.hostId).toBe(mine.localId)
    for (const r of rows) {
      expect(r.hostId.length).toBeGreaterThan(0)
      expect(r.players).toBeGreaterThan(0)
    }
    expect(rows.filter((r) => r.hostId === mine.localId)).toHaveLength(1)
  })

  it('shows the join code to the host and to nobody else', async () => {
    const world = stillWorld(1818)
    const opts = { world, failureRate: 0, latencyScale: 0 }
    const host = track(createMockLobbyService(opts))
    const guest = track(createMockLobbyService({
      ...opts, identity: { id: 'p-g2', name: 'Guestley', avatarId: DEFAULT_AVATAR_ID },
    }))
    const room = unwrap(await settle(host.create({
      name: 'Friends only', region: 'na-west', maxPlayers: 4,
      private: true, series: single('cryostatic'),
    }), 10))
    expect(room.joinCode).toMatch(/^[A-Z0-9]{4}$/)

    const wrong = await settle(guest.join(room.id, 'ZZZZ'), 10)
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.error).toBe('badcode')

    const right = unwrap(await settle(guest.join(room.id, room.joinCode!.toLowerCase()), 10))
    // The guest used the code; they do not get to re-share the room.
    expect(right.joinCode).toBeNull()
  })

  it('reports why a join failed', async () => {
    const world = stillWorld(1919)
    const svc = track(createMockLobbyService({ world, failureRate: 0, latencyScale: 0 }))
    const missing = await settle(svc.join('lb-nope'), 10)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error).toBe('notfound')

    // A closed lobby is `notfound` rather than a fourth error: from the
    // joiner's side the difference is not actionable.
    const dead = [...world.lobbies.values()][0]
    world.closeLobby(dead, 'hostLeft')
    const gone = await settle(svc.join(dead.id), 10)
    expect(gone.ok).toBe(false)
    if (!gone.ok) expect(gone.error).toBe('notfound')

    const racing = [...world.lobbies.values()].find((lb) => lb.status === 'open')!
    racing.status = 'racing'
    const mid = await settle(svc.join(racing.id), 10)
    expect(mid.ok).toBe(false)
    if (!mid.ok) expect(mid.error).toBe('racing')

    const full = [...world.lobbies.values()].find((lb) => lb.status === 'open')!
    while (full.members.length < full.maxPlayers) {
      full.members.push({ ...full.members[0], playerId: world.nextId('p-'), isHost: false })
    }
    const r = await settle(svc.join(full.id), 10)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('full')
  })
})

describe('the race start packet', () => {
  it('fills the grid to eight with AI and marks the local slot', async () => {
    const { host, guest, hostEvents, guestEvents, room } = await pair(2020)
    await settle(host.setReady(true), 10)
    await settle(guest.setReady(true), 10)
    const packet = unwrap(await settle(host.start(), 10))

    expect(packet.lobbyId).toBe(room.id)
    expect(packet.trackId).toBe('rustfall')
    expect(packet.laps).toBe(3)
    expect(Number.isInteger(packet.seed)).toBe(true)
    expect(packet.seed).toBeGreaterThanOrEqual(0)

    expect(packet.grid).toHaveLength(GRID_SIZE)
    expect(packet.grid.map((s) => s.slot)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])

    // Two humans at the front, host on pole, then six AI.
    const humans = packet.grid.filter((s) => s.playerId !== null)
    expect(humans).toHaveLength(2)
    expect(packet.grid.slice(0, 2).every((s) => s.playerId !== null)).toBe(true)
    expect(packet.grid[0].isHost).toBe(true)
    expect(packet.grid.filter((s) => s.isHost)).toHaveLength(1)

    const ai = packet.grid.filter((s) => s.playerId === null)
    expect(ai).toHaveLength(6)
    const chassisIds = new Set(CHASSIS.map((c) => c.id))
    const pilotIds = new Set(PILOTS.map((p) => p.id))
    for (const slot of ai) {
      // An AI car draws no avatar on its nameplate.
      expect(slot.avatarId).toBeNull()
      expect(slot.isHost).toBe(false)
      expect(chassisIds.has(slot.chassisId)).toBe(true)
      expect(pilotIds.has(slot.pilotId)).toBe(true)
      expect(slot.name.length).toBeGreaterThan(0)
      // PUBLISHED, and equal to the expression a single race and a circuit
      // round use. If every client invented this instead, the AI would drive
      // differently on each and the race would desync from frame one.
      expect(slot.aiSkill).toBe(2 + (slot.slot % 3))
    }
    // A human's skill is their own business.
    for (const slot of humans) expect(slot.aiSkill).toBeNull()
    // Every nameplate on the grid is distinct, or the field is unreadable at
    // the speed a nameplate is actually read at.
    expect(new Set(packet.grid.map((s) => s.name)).size).toBe(GRID_SIZE)

    // ONE BROADCAST. Everything in the packet is the same for both readers
    // except who the reader is, and each finds its own slot by matching
    // `localPlayerId` against the grid.
    const hostPacket = hostEvents.starts.at(-1)!
    const guestPacket = guestEvents.starts.at(-1)!
    expect(hostPacket.localPlayerId).toBe(room.localId)
    expect(guestPacket.localPlayerId).toBe('p-guest')
    expect(hostPacket.seed).toBe(guestPacket.seed)
    expect(hostPacket.inputDelay).toBe(guestPacket.inputDelay)
    expect(hostPacket.trackId).toBe(guestPacket.trackId)
    expect(hostPacket.laps).toBe(guestPacket.laps)
    // The grid is not merely equal, it is the same array: built once and
    // shared, so two readers cannot be handed two builds that agree today and
    // diverge after a change here.
    expect(hostPacket.grid).toBe(guestPacket.grid)
    // And each reader really can find itself.
    expect(hostPacket.grid.find((s) => s.playerId === hostPacket.localPlayerId)).toBeDefined()
    expect(guestPacket.grid.find((s) => s.playerId === guestPacket.localPlayerId)).toBeDefined()
    // The packet start() returned to the host is the same broadcast, stamped
    // for the caller.
    expect(packet.localPlayerId).toBe(room.localId)
    expect(packet.grid).toBe(hostPacket.grid)
  })

  it('reaches every client, host included', async () => {
    const { host, guest, hostEvents, guestEvents } = await pair(2121)
    await settle(host.setReady(true), 10)
    await settle(guest.setReady(true), 10)
    await settle(host.start(), 10)
    expect(hostEvents.starts).toHaveLength(1)
    expect(guestEvents.starts).toHaveLength(1)
    // And the room went racing before the packet, so no countdown is drawn
    // over a room that still says it is open.
    expect(hostEvents.rooms.at(-1)?.status).toBe('racing')
  })

  it('derives the input delay from the worst ping in the room', async () => {
    // The arithmetic, pinned: ceil((ping / 2) / 16.67) + 1, clamped to 2..12.
    expect(inputDelayFor(0)).toBe(2)
    expect(inputDelayFor(30)).toBe(2)
    expect(inputDelayFor(80)).toBe(4)
    expect(inputDelayFor(160)).toBe(6)
    expect(inputDelayFor(300)).toBe(10)
    // The ceiling: past 200ms of delay the car is detached from the stick and
    // more delay does not rescue the race.
    expect(inputDelayFor(2000)).toBe(12)
    // The floor: never zero, even on a LAN. One late packet would stall
    // everybody, and 33ms of lag is cheaper than a stutter.
    expect(inputDelayFor(1)).toBe(2)
    // An unmeasured peer is treated as bad rather than as perfect: guessing
    // low is the error that produces a visibly broken race.
    expect(inputDelayFor(null)).toBe(inputDelayFor(UNKNOWN_PING_MS))
    expect(inputDelayFor(null)).toBeGreaterThan(inputDelayFor(30))
    expect(inputDelayFor(Number.NaN)).toBe(inputDelayFor(UNKNOWN_PING_MS))

    // And the packet really uses it.
    const { host, guest, world, room } = await pair(2222)
    const members = world.lobbies.get(room.id)!.members
    for (const m of members) m.pingMs = m.isHost ? 0 : 150
    await settle(host.setReady(true), 10)
    await settle(guest.setReady(true), 10)
    const packet = unwrap(await settle(host.start(), 10))
    expect(packet.inputDelay).toBe(inputDelayFor(150))
  })
})

describe('names', () => {
  it('rejects a name in each way NAME_RULES can reject one', () => {
    expect(checkNameShape('ab')).toBe('short')
    expect(checkNameShape('')).toBe('short')
    expect(checkNameShape('thirteenchars')).toBe('long')
    expect(checkNameShape('bad!char')).toBe('charset')
    expect(checkNameShape(' leading')).toBe('charset')
    expect(checkNameShape('trailing-')).toBe('charset')
    expect(checkNameShape('double--dash')).toBe('charset')
    // And accepts the ones the rules deliberately allow, which is the half
    // that a too-strict pattern would break silently.
    expect(checkNameShape('Kestrel')).toBeNull()
    expect(checkNameShape('nova_kid')).toBeNull()
    expect(checkNameShape('Bit Rot')).toBeNull()
    expect(checkNameShape('Halcyon.9')).toBeNull()
    expect(checkNameShape('abc')).toBeNull()
    expect(checkNameShape('twelvechars!'.slice(0, 11) + 'x')).toBeNull()
  })

  it('returns every NameError from setName', async () => {
    const world = stillWorld(2323)
    const acct = track(createMockAccountService({
      world, failureRate: 0, latencyScale: 0, storage: null,
    }))
    await settle(acct.load(), 10)

    const reject = async (name: string): Promise<string> => {
      const r = await settle(acct.setName(name), 10)
      expect(r.ok).toBe(false)
      return r.ok ? '' : r.error
    }
    expect(await reject('no')).toBe('short')
    expect(await reject('fourteenchars!')).toBe('long')
    expect(await reject('nope!')).toBe('charset')

    // 'taken' needs somebody to have taken it, so somebody does: a second
    // account on the same world, which is the mock's stand-in for a unique
    // index on the name column.
    const other = track(createMockAccountService({
      world, failureRate: 0, latencyScale: 0, storage: null,
    }))
    await settle(other.load(), 10)
    expect(unwrap(await settle(other.setName('Firstcome'), 10)).name).toBe('Firstcome')
    expect(await reject('Firstcome')).toBe('taken')
    // Case-insensitively: two players called Nova and nova in one race is a
    // nameplate bug wearing a uniqueness constraint.
    expect(await reject('FIRSTCOME')).toBe('taken')

    // And the happy path still works, and is idempotent for your own name.
    const mine = unwrap(await settle(acct.setName('Secondly'), 10))
    expect(mine.name).toBe('Secondly')
    expect(unwrap(await settle(acct.setName('Secondly'), 10)).name).toBe('Secondly')
    // Releasing a name you held puts it back in circulation.
    expect(unwrap(await settle(acct.setName('Thirdly'), 10)).name).toBe('Thirdly')
    expect(unwrap(await settle(other.setName('Secondly'), 10)).name).toBe('Secondly')
  })

  it('returns offline rather than pretending to claim a name', async () => {
    const world = stillWorld(2424)
    const acct = track(createMockAccountService({
      world, offline: true, failureRate: 0, latencyScale: 0, storage: null,
    }))
    const profile = await settle(acct.load(), 10)
    // A player on a train still gets a name over their car.
    expect(acct.offline).toBe(true)
    expect(profile.name.length).toBeGreaterThan(0)
    const r = await settle(acct.setName('Trainbound'), 10)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('offline')
  })

  it('tells the world who the local player is, so the room agrees with the profile', async () => {
    const world = stillWorld(2525)
    const acct = track(createMockAccountService({
      world, failureRate: 0, latencyScale: 0, storage: null,
    }))
    const lobby = track(createMockLobbyService({ world, failureRate: 0, latencyScale: 0 }))
    await settle(acct.load(), 10)
    unwrap(await settle(acct.setName('Vinceroy'), 10))
    const room = unwrap(await settle(lobby.create({
      name: '', region: 'oce', maxPlayers: 8, private: false, series: single('halcyon'),
    }), 10))
    const mine = room.members.find((m) => m.playerId === room.localId)!
    expect(mine.name).toBe('Vinceroy')
    // An unnamed lobby is named after its host rather than left blank.
    expect(room.name).toContain('Vinceroy')
  })
})

describe('the profile', () => {
  it('survives a reload', async () => {
    const store = memStorage()
    const first = stillWorld(2626)
    const a = track(createMockAccountService({
      world: first, failureRate: 0, latencyScale: 0, storage: store,
    }))
    const born = await settle(a.load(), 10)
    const named = unwrap(await settle(a.setName('Reloaded'), 10))
    unwrap(await settle(a.award(1200, { won: true }), 10))

    // A NEW WORLD, deliberately: the point is that the device remembered, not
    // that an in-memory table happened to still be there.
    const second = stillWorld(9999)
    const b = track(createMockAccountService({
      world: second, failureRate: 0, latencyScale: 0, storage: store,
    }))
    const back = await settle(b.load(), 10)
    expect(back.id).toBe(born.id)
    expect(back.name).toBe(named.name)
    expect(back.credits).toBe(1200 + born.credits)
    expect(back.earned).toBe(1200)
    expect(back.races).toBe(1)
    expect(back.wins).toBe(1)
    expect(b.ephemeral).toBe(false)
  })

  it('degrades to an in-memory profile when storage throws', async () => {
    const world = stillWorld(2727)
    const acct = track(createMockAccountService({
      world, failureRate: 0, latencyScale: 0, storage: hostileStorage(),
    }))
    // The load does not reject and does not throw; that is the whole assertion.
    const p = await settle(acct.load(), 10)
    expect(p.id.length).toBeGreaterThan(0)
    expect(checkNameShape(p.name)).toBeNull()
    expect(acct.ephemeral).toBe(true)
    // And the session still works: the profile is simply not kept.
    expect(unwrap(await settle(acct.setName('Ephemeral'), 10)).name).toBe('Ephemeral')
    expect(acct.ephemeral).toBe(true)
  })

  it('survives a localStorage that throws on the property access itself', async () => {
    // The real failure mode in a partitioned iframe: not a null, not a throwing
    // getItem, but a throw on `globalThis.localStorage`. If deviceStorage() did
    // not guard the LOOKUP, this would take the game down before the first
    // frame.
    const world = stillWorld(2828)
    const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('SecurityError: access denied') },
    })
    try {
      const acct = track(createMockAccountService({ world, failureRate: 0, latencyScale: 0 }))
      const p = await settle(acct.load(), 10)
      expect(p.id.length).toBeGreaterThan(0)
      expect(acct.ephemeral).toBe(true)
    } finally {
      if (had) Object.defineProperty(globalThis, 'localStorage', had)
      else delete (globalThis as { localStorage?: unknown }).localStorage
    }
  })

  it('mints a starter profile that can afford exactly one cheap portrait', async () => {
    const world = stillWorld(2929)
    const acct = track(createMockAccountService({
      world, failureRate: 0, latencyScale: 0, storage: null,
    }))
    const p = await settle(acct.load(), 10)
    // The starters from content/avatars.ts, and nothing else. `PlayerProfile`
    // documents `unlocked` as always containing them.
    expect([...p.unlocked].sort()).toEqual([...STARTER_IDS].sort())
    expect(p.avatarId).toBe(DEFAULT_AVATAR_ID)
    expect(STARTER_IDS).toContain(p.avatarId)
    expect(p.races).toBe(0)

    // One cheap portrait is affordable, and the tier above it is not: a new
    // player can find out what buying does without clearing a shelf.
    const cheap = AVATARS.filter((a) => priceOf(a.id) === PRICES.cheap)
    const low = AVATARS.filter((a) => priceOf(a.id) === PRICES.low)
    expect(cheap.length).toBeGreaterThan(0)
    expect(canBuy(p, cheap[0].id)).toBe(true)
    expect(canBuy(p, low[0].id)).toBe(false)

    const after = unwrap(await settle(acct.buyAvatar(cheap[0].id), 10))
    expect(canBuy(after, cheap[1].id)).toBe(false)
  })

  it('spends credits rather than going negative, and refuses what is not for sale', async () => {
    const world = stillWorld(3030)
    const acct = track(createMockAccountService({
      world, failureRate: 0, latencyScale: 0, storage: null,
    }))
    const p = await settle(acct.load(), 10)
    const cheap = AVATARS.find((a) => priceOf(a.id) === PRICES.cheap)!
    const dear = AVATARS.find((a) => priceOf(a.id) === PRICES.chase)!

    const bought = unwrap(await settle(acct.buyAvatar(cheap.id), 10))
    expect(bought.credits).toBe(p.credits - PRICES.cheap)
    expect(bought.unlocked).toContain(cheap.id)
    // Bought it, wear it.
    expect(bought.avatarId).toBe(cheap.id)

    const again = await settle(acct.buyAvatar(cheap.id), 10)
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error).toBe('owned')

    const broke = await settle(acct.buyAvatar(dear.id), 10)
    expect(broke.ok).toBe(false)
    if (!broke.ok) expect(broke.error).toBe('credits')

    // A rank and a feat are not for sale at any price. Saying that is more
    // useful than saying the price is missing.
    const rank = AVATARS.find((a) => a.source.kind === 'rank')!
    const feat = AVATARS.find((a) => a.source.kind === 'feat')!
    for (const a of [rank, feat]) {
      const nope = await settle(acct.buyAvatar(a.id), 10)
      expect(nope.ok).toBe(false)
      if (!nope.ok) expect(nope.error).toBe('notforsale')
      const locked = await settle(acct.setAvatar(a.id), 10)
      expect(locked.ok).toBe(false)
      if (!locked.ok) expect(locked.error).toBe('locked')
    }
    const unknown = await settle(acct.buyAvatar('no-such-face'), 10)
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error).toBe('unknown')
  })

  it('banks a race and unlocks by rank on the server side', async () => {
    const world = stillWorld(3131)
    const acct = track(createMockAccountService({
      world, failureRate: 0, latencyScale: 0, storage: null,
    }))
    await settle(acct.load(), 10)
    const changes: number[] = []
    acct.onChange = (p) => changes.push(p.earned)

    // The first rung of the rank ladder in content/avatars.ts.
    const rank = AVATARS.find((a) =>
      a.source.kind === 'rank' && a.source.earned === RANKS.pacer)!

    const after = unwrap(await settle(acct.award(RANKS.pacer, { won: false }), 10))
    expect(after.earned).toBe(RANKS.pacer)
    expect(after.races).toBe(1)
    expect(after.wins).toBe(0)
    // The unlock is the server's decision, not a claim the client made -- and
    // it is derivable from `earned`, so it holds even if the flag were lost.
    expect(after.unlocked).toContain(rank.id)
    expect(ownsAvatar(after, rank.id)).toBe(true)
    expect(changes.at(-1)).toBe(RANKS.pacer)

    // A WIN ALSO PAYS A FEAT, because avatars.ts implies `flagbearer` from the
    // lifetime win counter. The mock grants exactly the feats the numbers it
    // was handed can be checked to imply, and no others: nothing here knows
    // about a combo or a circuit, so those stay locked.
    const won = unwrap(await settle(acct.award(10, { won: true }), 10))
    expect(won.wins).toBe(1)
    expect(won.unlocked).toContain('flagbearer')
    expect(won.unlocked).not.toContain('singularity')

    const bad = await settle(acct.award(-50, { won: false }), 10)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toBe('invalid')
    const nan = await settle(acct.award(Number.NaN, { won: true }), 10)
    expect(nan.ok).toBe(false)
  })
})

describe('the one place the app gets its services from', () => {
  afterEach(() => { resetNetServices() })

  it('defaults to the mock and hands out one of each', () => {
    // No `?net=` and no VITE_NET here, so this is the source-level default --
    // and it is `mock` because that is the only implementation that exists.
    expect(netProfile()).toBe(DEFAULT_PROFILE)
    expect(DEFAULT_PROFILE).toBe('mock')

    vi.useFakeTimers()
    const a = accountService()
    const b = accountService()
    // Singletons, or two screens would be two different players.
    expect(a).toBe(b)
    const l = lobbyService()
    expect(lobbyService()).toBe(l)
    // Both halves see the same world, which is what makes the name on the
    // profile screen the name on the row in the room.
    expect(typeof a.load).toBe('function')
  })

  it('forgets everything on reset, clock included', async () => {
    vi.useFakeTimers()
    const first = lobbyService()
    resetNetServices()
    const second = lobbyService()
    expect(second).not.toBe(first)
    // The old service is disposed, so its in-flight calls settle rather than
    // hanging and its world's interval is gone.
    const orphan = first.list()
    await vi.advanceTimersByTimeAsync(2000)
    expect((await orphan).ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// A SERIES
// ---------------------------------------------------------------------------
//
// The properties a screenshot of a standings table cannot check: that round 2
// is a different circuit from round 1, that a driver who walked out in round 2
// is still on the table with a zero beside their name, that the points are the
// ones game/circuit.ts awards and not a second table that happens to look like
// it, and -- the one that matters most -- that a lobby of length 1 behaves
// EXACTLY as a single race did before any of this existed.

/** Host and guest in a room running a series of `length`. */
async function series(seed: number, length: SeriesLength, trackIds: string[]) {
  const world = stillWorld(seed)
  const opts = { world, failureRate: 0, latencyScale: 0 }
  const host = track(createMockLobbyService(opts))
  const guest = track(createMockLobbyService({
    ...opts,
    identity: { id: 'p-guest', name: 'Guestley', avatarId: DEFAULT_AVATAR_ID },
  }))
  const rooms: (LobbyRoom | null)[] = []
  const starts: RaceStartPacket[] = []
  host.onRoom = (r) => rooms.push(r)
  host.onStart = (p) => starts.push(p)
  const room = unwrap(await settle(host.create({
    name: 'Series', region: 'eu-west', maxPlayers: 8, private: false,
    series: { length, trackIds, laps: 3, difficulty: 'normal' },
  }), 10))
  unwrap(await settle(guest.join(room.id), 10))
  await vi.advanceTimersByTimeAsync(10)
  return { world, host, guest, room, rooms, starts }
}

/** Race a round: everybody readies, the host starts, the host banks a table. */
async function raceRound(
  host: ReturnType<typeof createMockLobbyService>,
  guest: ReturnType<typeof createMockLobbyService>,
  table: SeriesStanding[],
): Promise<RaceStartPacket> {
  await settle(host.setReady(true), 10)
  await settle(guest.setReady(true), 10)
  const packet = unwrap(await settle(host.start(), 10))
  await settle(host.endRound(table), 10)
  return packet
}

describe('a series runs its rounds', () => {
  it('advances round by round, on a different circuit each time', async () => {
    const ids = ['rustfall', 'halcyon', 'aetherion']
    const { host, guest } = await series(3131, 3, ids)

    const seen: string[] = []
    for (let n = 0; n < 3; n++) {
      const room = host.current()!
      expect(room.round, `round counter before round ${n + 1}`).toBe(n)
      const packet = await raceRound(host, guest, [])
      expect(packet.round).toBe(n)
      expect(packet.seriesLength).toBe(3)
      seen.push(packet.trackId)
    }
    expect(seen).toEqual(ids)
    // The series is over and stops there rather than walking off the end of
    // the running order.
    const done = host.current()!
    expect(done.round).toBe(3)
    expect(done.series.length).toBe(3)
  })

  it('reopens the room between rounds with everybody unready', async () => {
    const { host, guest } = await series(3232, 3, ['rustfall', 'halcyon', 'aetherion'])
    await raceRound(host, guest, [])
    const room = host.current()!
    // A ready you gave for Elkarim is not a ready for Halcyon Bay -- the same
    // rule setTrack applies, arriving between rounds.
    expect(room.members.every((m) => !m.ready)).toBe(true)
    expect(room.status).not.toBe('racing')
  })

  it('carries the table into the next round’s packet', async () => {
    const { host, guest } = await series(3333, 3, ['rustfall', 'halcyon', 'aetherion'])
    const table: SeriesStanding[] = [
      { playerId: 'p-guest', name: 'Guestley', avatarId: null, points: 15, finishes: [1], isLocal: false },
    ]
    await raceRound(host, guest, table)
    // Round 2's packet carries what round 1 scored. Every client folds its
    // round into the SAME table, which is the only way eight clients stay on
    // one series.
    const next = await raceRound(host, guest, table)
    expect(next.round).toBe(1)
    expect(next.standings).toHaveLength(1)
    expect(next.standings[0].points).toBe(15)
  })

  it('will not put the same circuit in two rounds', async () => {
    const { host } = await series(3434, 3, ['rustfall', 'halcyon', 'aetherion'])
    // Round 1 to a circuit already sitting in round 3 is refused: "no repeats"
    // is a promise about `trackIds`, and setTrack edits one round.
    const clash = await settle(host.setTrack('aetherion', 3), 10)
    expect(clash.ok).toBe(false)
    // Somewhere else entirely is fine, and only round 1 moves.
    const ok = unwrap(await settle(host.setTrack('neonspire', 3), 10))
    expect(ok.series.trackIds).toEqual(['neonspire', 'halcyon', 'aetherion'])
  })

  it('says which round it is on every directory row', async () => {
    const { host, guest, world } = await series(3535, 5,
      ['rustfall', 'halcyon', 'aetherion', 'cryostatic', 'emberfall'])
    const localId = host.current()!.localId
    const mine = async (): Promise<LobbySummary> =>
      unwrap(await settle(host.list(), 10)).find((r) => r.hostId === localId)!

    const before = await mine()
    expect(before.seriesLength).toBe(5)
    expect(before.seriesRound).toBe(1)
    expect(before.trackId).toBe('rustfall')

    await raceRound(host, guest, [])
    const after = await mine()
    expect(after.seriesRound).toBe(2)
    // And the circuit a row advertises is the one COMING, not the one raced.
    expect(after.trackId).toBe('halcyon')
    expect(world.lobbies.size).toBeGreaterThan(0)
  })
})

describe('a lobby of length 1 is a single race and nothing else', () => {
  it('advertises no round counter and ends after one race', async () => {
    const { host, guest } = await series(4141, 1, ['rustfall'])
    const row = unwrap(await settle(host.list(), 10))
      .find((r) => r.hostId === host.current()!.localId)!
    // The two fields a browser row reads to decide whether to say anything at
    // all. A length of 1 is the signal to say nothing.
    expect(row.seriesLength).toBe(1)
    expect(row.seriesRound).toBe(1)

    const packet = await raceRound(host, guest, [])
    // Byte for byte the packet a single race produced before series existed,
    // plus the three fields that say it is one round of one.
    expect(packet.round).toBe(0)
    expect(packet.seriesLength).toBe(1)
    expect(packet.standings).toEqual([])
    expect(packet.trackId).toBe('rustfall')
    expect(packet.laps).toBe(3)

    const after = host.current()!
    expect(after.round).toBe(1)
    expect(after.series.length).toBe(1)
    // Nothing to show: no round was scored into a table, because nobody
    // handed one over.
    expect(after.standings).toEqual([])
  })

  it('fills a short or malformed plan rather than starting a round with no circuit', async () => {
    const world = stillWorld(4242)
    const svc = track(createMockLobbyService({ world, failureRate: 0, latencyScale: 0 }))
    const room = unwrap(await settle(svc.create({
      name: 'Sloppy', region: 'oce', maxPlayers: 4, private: false,
      // Three rounds asked for, one circuit named, and a duplicate and an id
      // this build does not have thrown in.
      series: { length: 3, trackIds: ['neonspire', 'neonspire', 'not-a-track'], laps: 3, difficulty: 'normal' },
    }), 10))
    expect(room.series.length).toBe(3)
    expect(room.series.trackIds).toHaveLength(3)
    expect(new Set(room.series.trackIds).size).toBe(3)
    expect(room.series.trackIds[0]).toBe('neonspire')
  })

  it('only ever offers the four lengths the contract names', async () => {
    const world = stillWorld(4343)
    const svc = track(createMockLobbyService({ world, failureRate: 0, latencyScale: 0 }))
    // A length nobody should be able to ask for falls back to a single race
    // rather than to a series that never ends.
    const room = unwrap(await settle(svc.create({
      name: 'Seven', region: 'oce', maxPlayers: 4, private: false,
      series: { length: 7 as SeriesLength, trackIds: ['rustfall'], laps: 3, difficulty: 'normal' },
    }), 10))
    expect(SERIES_LENGTHS).toContain(room.series.length)
    expect(room.series.length).toBe(1)
  })
})
