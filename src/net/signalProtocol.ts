/**
 * SpaceGen Racing — THE SIGNALLING PROTOCOL, and all of the logic behind it.
 * ---------------------------------------------------------------------------
 * The introduction service. Two browsers that have never heard of each other
 * post letters here until they know enough to open a WebRTC data channel, and
 * then they stop. Nothing in a race ever comes back through this file.
 *
 * ===========================================================================
 * WHY THE LOGIC IS HERE AND NOT IN THE FUNCTION
 *
 * `netlify/functions/signal.mts` is forty lines of HTTP and a `getStore`. All
 * of the thinking -- what a valid join is, when a lobby has gone stale, how a
 * mailbox is drained, what a guest is allowed to overwrite -- is in this file,
 * behind a `SignalStore` interface that is three methods wide. That buys three
 * things, and the third is the one that mattered:
 *
 *   1. The rules are unit-testable against a Map, on fake timers, with no
 *      Netlify, no network and no deploy. See tests/signal.test.ts.
 *   2. The rules cannot drift from the client's idea of them, because the
 *      client imports the same constants out of the same file -- exactly the
 *      argument netlify.toml already makes for the leaderboard importing
 *      src/score/verify.ts rather than keeping a second copy of the bounds.
 *   3. THE PROBE CAN RUN THE REAL SERVER. tools/probe-netcode.mjs serves
 *      dist/ off a plain node http server and mounts this same handler over an
 *      in-memory store, so two Chromium contexts negotiate through the
 *      production code path rather than through a stub that agrees with them.
 *      A stub is the one thing that cannot fail the way the real endpoint
 *      fails, which makes it the one thing not worth testing against.
 *
 * ===========================================================================
 * STORAGE: ONE BLOB PER DIRECTED PAIR, AND WHY THAT IS NOT OVER-ENGINEERING
 *
 * The leaderboard rewrites one blob whole and accepts that two simultaneous
 * finishers can lose a row. That is the right trade for a row. It is the wrong
 * trade here: a lost ICE candidate is not a missing table entry, it is a player
 * who watches a spinner and never gets in, and the failure is invisible from
 * both ends.
 *
 * So the mailbox is keyed `mail/<lobby>/<from>.<to>` and has EXACTLY ONE
 * WRITER. Seven guests posting offers to one host touch seven different blobs
 * and cannot collide at all. Netlify Blobs gives no compare-and-swap, so the
 * only way to be safe against a lost write is to arrange for there to be no
 * second writer, and that is what this key does.
 *
 * The lobby record (`lobby/<id>`) still read-modify-writes, because membership
 * genuinely is shared state. It is written on join, leave and heartbeat --
 * events measured in seconds, not in frames -- and a lost heartbeat is healed
 * by the next one ten seconds later. A lost JOIN is the one that would hurt, so
 * `join` reads its own write back and retries once; see `commitMember`.
 *
 * The directory index (`dir`) is deliberately lossy and self-healing: every
 * heartbeat re-adds the id, so an index entry lost to a collision reappears
 * within `HEARTBEAT_MS` and the worst case is one lobby missing from one
 * refresh of one player's browser.
 */
import {
  LOBBY_MAX_PLAYERS, LOBBY_MIN_PLAYERS, NAME_RULES, REGIONS, SERIES_LENGTHS,
  type JoinError, type LobbyStatus, type LobbySummary, type RegionId,
  type SeriesLength, type SeriesPlan,
} from './types'

/** Where the function is mounted. Imported by the client so there is one path. */
export const SIGNAL_PATH = '/api/signal'

/**
 * How often a client re-announces itself while it is in a lobby.
 *
 * Ten seconds is not a liveness check -- the data channel does that, at 1Hz,
 * peer to peer. This is only what keeps the DIRECTORY row from going stale
 * while a room sits in the lobby screen for twenty minutes, so it is tuned for
 * the cost of the request rather than for the sharpness of the detection.
 */
export const HEARTBEAT_MS = 10_000

/**
 * A lobby nobody has touched for this long is gone.
 *
 * Four missed heartbeats. Generous on purpose: a host on a phone that locked
 * its screen for thirty seconds should come back to their lobby, and the cost
 * of being wrong in the other direction is a dead row in a browser list that
 * says "closed" when somebody tries it.
 */
export const LOBBY_TTL_MS = 45_000

/**
 * How long after the host was last heard from before another member of the
 * lobby may take the role.
 *
 * THIS ENDPOINT IS THE ONLY ARBITER THERE IS. Host migration is decided
 * locally -- every survivor runs the same rule over the same grid, because
 * they cannot talk to each other to negotiate (see types.ts) -- but the
 * DIRECTORY ROW is shared state that only this service owns, and a row still
 * advertising a host who is not there is a row that vanishes from the browser
 * at `LOBBY_TTL_MS` and takes the race's identity with it. So the new host
 * claims the row, and this number is what stops a claim being a theft.
 *
 * FOURTEEN SECONDS, against a racing host that heartbeats every four (see
 * `POLL_RACE_MS` in signal.ts). Three missed beats plus slack: long enough
 * that a host on a phone which locked its screen for a moment keeps its lobby,
 * short enough to land inside `MIGRATION_BUDGET_MS` with half of it to spare.
 *
 * A host that leaves CLEANLY does not wait for any of this: `bye` mid-race
 * sets `hostGone`, and a claim against that is allowed at once. The timer is
 * only for the case where nobody said anything -- a closed laptop, a crashed
 * tab, a train going into a tunnel -- which is also the case a timer is the
 * only available evidence for.
 */
export const HOST_CLAIM_AFTER_MS = 14_000

/** Longest a mailbox may grow before the oldest letters are dropped. */
export const MAX_BOX_MSGS = 96
/** Longest a single signalling body may be. An SDP offer is ~4KB. */
export const MAX_BODY_CHARS = 16_000
/** Most lobbies the directory will return. The browser shows far fewer. */
export const MAX_LOBBIES = 60

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

/**
 * One letter in a mailbox.
 *
 * `kind` is not inspected by the server, deliberately. The server's job is to
 * carry bytes between two peers who have not met; understanding WebRTC would
 * make it a component that has to be redeployed when the browser's SDP changes.
 * It is here so a poll can be read in a log, and so `bye` can be delivered
 * ahead of a connection rather than through it.
 */
export type SignalKind = 'offer' | 'answer' | 'ice' | 'bye'

export interface SignalMsg {
  /** Per-mailbox, monotonic. The reader passes the last one it saw as `since`. */
  seq: number
  kind: SignalKind
  /** Opaque to the server: a JSON-encoded SDP or ICE candidate. */
  body: string
}

/** A peer the server knows is in a lobby. Not a `LobbyMember`: the room's real
 *  state (ready, loadout) lives on the data channel, not here. */
export interface SignalPeer {
  id: string
  name: string
  /** When they last polled. Older than `LOBBY_TTL_MS` and they are forgotten. */
  seenAt: number
}

export interface LobbyRecord {
  id: string
  name: string
  hostId: string
  hostName: string
  region: RegionId
  maxPlayers: number
  private: boolean
  /** Null on a public lobby. Never returned to a non-member. */
  code: string | null
  series: SeriesPlan
  round: number
  status: LobbyStatus
  peers: SignalPeer[]
  createdAt: number
  seenAt: number
  /**
   * The host said goodbye and the room did NOT end with them.
   *
   * A HOST LEAVING USED TO BE THE END OF THE LOBBY, FULL STOP, and for a room
   * sitting on the lobby screen it still is. Mid-race it cannot be: the
   * survivors are all stopped at an identical known frame and are about to
   * elect one of their own, and a record that closed under them would take the
   * mailbox they are about to re-handshake through with it.
   *
   * So a `bye` from the host of a RACING lobby with other live members sets
   * this instead of closing, and it means exactly one thing to the endpoint:
   * a `host` claim is allowed immediately rather than after
   * `HOST_CLAIM_AFTER_MS`. It is cleared by the claim that succeeds.
   */
  hostGone?: boolean
}

export type SignalRequest =
  | { op: 'create'; peer: { id: string; name: string }; lobby: {
      name: string; region: string; maxPlayers: number; private: boolean
      series: { length: number; trackIds: string[]; laps: number }
    } }
  | { op: 'list'; region?: string; joinableOnly?: boolean; search?: string }
  | { op: 'join'; id: string; peer: { id: string; name: string }; code?: string }
  | { op: 'poll'; id: string; peer: string; since?: Record<string, number> }
  | { op: 'send'; id: string; from: string; to: string; msgs: { kind: string; body: string }[] }
  /** Host only: publish the row the directory shows. */
  | { op: 'update'; id: string; peer: string; status?: string; round?: number }
  /**
   * Take the host role. Refused unless the current host is demonstrably gone
   * -- see `HOST_CLAIM_AFTER_MS` and `LobbyRecord.hostGone`.
   */
  | { op: 'host'; id: string; peer: string; name?: string
      /**
       * Who the claimant believes has died.
       *
       * IT IS HOW THE ENDPOINT TELLS THE TWO REFUSALS APART, and they are
       * completely different answers. "The host you named is still being
       * heard from" means wait and try again; "the room already moved on to
       * somebody else" means stop and go and talk to them. Without it the
       * second case is indistinguishable from the first and a survivor whose
       * election lost spends the whole migration budget retrying against a
       * room that has had a host for twenty seconds.
       */
      was?: string }
  /**
   * ICE servers, minted. Answered by `netlify/functions/signal.mts` and NOT by
   * this file: it is the one operation that talks to a third party rather than
   * to the store, and the API token it needs must never leave the function.
   * `handleSignal` therefore answers it with a refusal, which is also exactly
   * the right answer for the probe's in-memory server -- no relay configured,
   * fall back to STUN, which is what a loopback wanted anyway.
   */
  | { op: 'ice' }
  | { op: 'bye'; id: string; peer: string }

export type SignalResponse =
  | { ok: true; op: 'create'; lobby: LobbyRecord }
  | { ok: true; op: 'list'; lobbies: LobbySummary[] }
  | { ok: true; op: 'join'; lobby: LobbyRecord }
  | { ok: true; op: 'poll'; lobby: LobbyRecord | null
      /** Sender id -> the letters they have for me, oldest first. */
      mail: Record<string, SignalMsg[]>
      /**
       * How long the HOST has been quiet, in milliseconds, on the SERVER's
       * clock.
       *
       * THE ONE FACT A GUEST CANNOT WORK OUT FOR ITSELF, and it decides which
       * of two completely different repairs to run. In a star a guest holds
       * exactly one link, so "the host died" and "my own connection died" look
       * IDENTICAL from where it is standing -- and the first cut of host
       * migration could not tell them apart, so a guest whose wifi blipped
       * promoted itself to host and raced on alone while the real room raced
       * on without it. Two races, both convinced they were the room.
       *
       * This endpoint can tell, because it hears from everybody. Sent as an
       * elapsed time rather than a timestamp so no client has to reason about
       * clock skew against a serverless function.
       */
      hostQuietMs: number }
  | { ok: true; op: 'send' | 'update' | 'bye' }
  /** The record AFTER the claim, so a loser learns who won without a second
   *  request. See `commitHost`. */
  | { ok: true; op: 'host'; lobby: LobbyRecord }
  | { ok: true; op: 'ice'; iceServers: unknown[] }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/**
 * Three methods, because that is all Netlify Blobs actually gives us.
 *
 * No compare-and-swap, no transactions, no atomic append. Every safety
 * property below is therefore built out of key layout rather than out of the
 * store, which is the only place it can be built.
 */
export interface SignalStore {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  del(key: string): Promise<void>
}

const dirKey = (): string => 'dir'
const lobbyKey = (id: string): string => `lobby/${id}`
const mailKey = (lobby: string, from: string, to: string): string =>
  `mail/${lobby}/${from}.${to}`

// ---------------------------------------------------------------------------
// Sanitising
// ---------------------------------------------------------------------------

/**
 * Everything below assumes the body is hostile, because it is a public POST.
 *
 * The rule is the leaderboard's: CLAMP RATHER THAN REJECT wherever a clamp has
 * an obvious right answer, so a client with an off-by-one does not lose a
 * lobby, and reject only where there is no honest default -- a missing id, a
 * region that does not exist, a series length that is not on the menu.
 */
const idOk = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 64 && /^[A-Za-z0-9_-]+$/.test(v)

function cleanName(v: unknown, fallback: string): string {
  const s = typeof v === 'string' ? v.trim().slice(0, NAME_RULES.max * 4) : ''
  // Strip control characters and collapse runs of whitespace. NOT NAME_RULES:
  // a lobby name is prose ("Vince's Friday night"), a player name is a claim.
  const t = s.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim()
  return t.length > 0 ? t.slice(0, 40) : fallback
}

const isRegion = (v: unknown): v is RegionId =>
  typeof v === 'string' && REGIONS.some((r) => r.id === v)

const isLength = (v: unknown): v is SeriesLength =>
  typeof v === 'number' && (SERIES_LENGTHS as readonly number[]).includes(v)

function cleanSeries(raw: unknown): SeriesPlan | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { length?: unknown; trackIds?: unknown; laps?: unknown }
  if (!isLength(r.length)) return null
  if (!Array.isArray(r.trackIds)) return null
  const ids: string[] = []
  for (const t of r.trackIds) {
    if (typeof t !== 'string' || t.length === 0 || t.length > 32) return null
    // No repeats: SeriesPlan documents the running order as distinct circuits,
    // and a duplicate would make `standings.finishes` ambiguous about which
    // round a result belongs to.
    if (ids.includes(t)) return null
    ids.push(t)
  }
  // EXACTLY `length` CIRCUITS. A short list would start a series that runs out
  // of tracks in the middle, which the lobby screen has no state for.
  if (ids.length !== r.length) return null
  const laps = typeof r.laps === 'number' && isFinite(r.laps)
    ? Math.max(1, Math.min(20, Math.round(r.laps)))
    : 3
  return { length: r.length, trackIds: ids, laps }
}

const isStatus = (v: unknown): v is LobbyStatus =>
  v === 'open' || v === 'full' || v === 'racing' || v === 'closed'

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** A stored record, or null if the key holds something this build cannot read. */
function asRecord(raw: unknown): LobbyRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<LobbyRecord>
  if (!idOk(r.id) || !idOk(r.hostId) || !isRegion(r.region)) return null
  const series = cleanSeries(r.series)
  if (!series) return null
  const peers: SignalPeer[] = []
  if (Array.isArray(r.peers)) {
    for (const p of r.peers) {
      if (!p || typeof p !== 'object') continue
      const q = p as Partial<SignalPeer>
      if (!idOk(q.id)) continue
      peers.push({
        id: q.id,
        name: cleanName(q.name, 'Racer'),
        seenAt: typeof q.seenAt === 'number' ? q.seenAt : 0,
      })
    }
  }
  return {
    id: r.id,
    name: cleanName(r.name, 'Lobby'),
    hostId: r.hostId,
    hostName: cleanName(r.hostName, 'Host'),
    region: r.region,
    maxPlayers: Math.max(LOBBY_MIN_PLAYERS,
      Math.min(LOBBY_MAX_PLAYERS, Math.round(Number(r.maxPlayers) || LOBBY_MAX_PLAYERS))),
    private: r.private === true,
    code: typeof r.code === 'string' ? r.code : null,
    series,
    round: Math.max(0, Math.round(Number(r.round) || 0)),
    status: isStatus(r.status) ? r.status : 'open',
    peers,
    createdAt: Number(r.createdAt) || 0,
    seenAt: Number(r.seenAt) || 0,
    hostGone: r.hostGone === true,
  }
}

/** When the host was last heard from, or 0 if the record has forgotten them
 *  entirely -- which is itself the strongest possible evidence they are gone. */
function hostSeenAt(rec: LobbyRecord): number {
  return rec.peers.find((p) => p.id === rec.hostId)?.seenAt ?? 0
}

/** Alive peers only. The caller has already decided `now`. */
function livePeers(rec: LobbyRecord, now: number): SignalPeer[] {
  return rec.peers.filter((p) => now - p.seenAt < LOBBY_TTL_MS)
}

/**
 * The record as a directory row.
 *
 * `pingMs` IS ALWAYS NULL HERE AND THAT IS NOT A PLACEHOLDER. types.ts is
 * explicit that ping is measured against the HOST by the browsing client, and
 * this endpoint is not the host -- a number invented here would be the round
 * trip to Netlify, which is a different machine on a different continent from
 * the person you are about to race. The client fills the field in when its own
 * probe lands, and renders "--" until then.
 */
function toSummary(rec: LobbyRecord, now: number): LobbySummary {
  const n = livePeers(rec, now).length
  return {
    id: rec.id,
    name: rec.name,
    hostId: rec.hostId,
    hostName: rec.hostName,
    region: rec.region,
    players: n,
    maxPlayers: rec.maxPlayers,
    private: rec.private,
    trackId: rec.series.trackIds[Math.min(rec.round, rec.series.length - 1)] ?? '',
    laps: rec.series.laps,
    seriesLength: rec.series.length,
    seriesRound: Math.min(rec.round + 1, rec.series.length),
    status: rec.status === 'open' && n >= rec.maxPlayers ? 'full' : rec.status,
    pingMs: null,
  }
}

/** Strip anything a non-member is not entitled to see. */
function publicRecord(rec: LobbyRecord): LobbyRecord {
  return { ...rec, code: null }
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

const err = (e: string): SignalResponse => ({ ok: false, error: e })

async function readLobby(store: SignalStore, id: string): Promise<LobbyRecord | null> {
  if (!idOk(id)) return null
  return asRecord(await store.get(lobbyKey(id)))
}

async function readDir(store: SignalStore): Promise<string[]> {
  const raw = await store.get(dirKey())
  if (!Array.isArray(raw)) return []
  return raw.filter(idOk).slice(0, MAX_LOBBIES * 2)
}

/**
 * Add an id to the lossy index.
 *
 * Read-modify-write with no lock, and we know it. A collision drops one id
 * from one write; the loser's next heartbeat calls this again and puts it
 * back, so the steady state is correct and only the first `HEARTBEAT_MS` after
 * a collision is wrong. Buying more than that would mean a second blob per
 * lobby and a list() that reads all of them.
 */
async function indexAdd(store: SignalStore, id: string,
  alive: (id: string) => Promise<boolean>): Promise<void> {
  const ids = await readDir(store)
  if (!ids.includes(id)) ids.unshift(id)
  // Opportunistic sweep while we are holding it anyway: the index is the only
  // place a dead lobby's id lives on, and nothing else will ever remove it.
  const keep: string[] = []
  for (const other of ids) {
    if (keep.length >= MAX_LOBBIES) break
    if (other === id || await alive(other)) keep.push(other)
  }
  await store.set(dirKey(), keep)
}

async function indexDrop(store: SignalStore, id: string): Promise<void> {
  const ids = await readDir(store)
  await store.set(dirKey(), ids.filter((x) => x !== id))
}

/**
 * Write a peer into the record and make sure it stuck.
 *
 * THE ONE PLACE A LOST WRITE IS NOT SURVIVABLE. Two guests joining in the same
 * second read the same record, each adds itself, and the second write wins --
 * so one of them is a member as far as they know and invisible as far as the
 * host knows, and they sit on a spinner for ever with nothing logged anywhere.
 *
 * Read-back-and-retry is not a lock and does not pretend to be: it collapses
 * the collision window from "the whole request" to "the gap between the write
 * and the read", which at Blobs latencies takes a two-guest collision from
 * routinely-observable to rare. The honest description is that this endpoint
 * is eventually consistent and the client is built to tolerate it -- a guest
 * whose join is lost re-posts it on its next poll, which is the real fix and
 * is why the client polls at all.
 */
async function commitMember(store: SignalStore, rec: LobbyRecord,
  peer: SignalPeer, now: number): Promise<LobbyRecord> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const fresh = attempt === 0 ? rec : (await readLobby(store, rec.id)) ?? rec
    const peers = livePeers(fresh, now).filter((p) => p.id !== peer.id)
    peers.push(peer)
    const next: LobbyRecord = { ...fresh, peers, seenAt: now }
    await store.set(lobbyKey(rec.id), next)
    const back = await readLobby(store, rec.id)
    if (back && back.peers.some((p) => p.id === peer.id)) return back
  }
  return rec
}

/**
 * Handle one signalling request.
 *
 * Pure but for the store and the clock, both injected, so every branch below
 * is reachable from a unit test in under a millisecond.
 */
export async function handleSignal(
  store: SignalStore,
  req: SignalRequest,
  now: number,
  newId: () => string,
): Promise<SignalResponse> {
  const alive = async (id: string): Promise<boolean> => {
    const r = await readLobby(store, id)
    return !!r && now - r.seenAt < LOBBY_TTL_MS
  }

  switch (req.op) {
    // -----------------------------------------------------------------------
    case 'create': {
      if (!req.peer || !idOk(req.peer.id)) return err('bad-peer')
      const series = cleanSeries(req.lobby?.series)
      if (!series) return err('bad-series')
      if (!isRegion(req.lobby.region)) return err('bad-region')
      const id = newId()
      const hostName = cleanName(req.peer.name, 'Host')
      const rec: LobbyRecord = {
        id,
        name: cleanName(req.lobby.name, `${hostName}'s lobby`),
        hostId: req.peer.id,
        hostName,
        region: req.lobby.region,
        maxPlayers: Math.max(LOBBY_MIN_PLAYERS,
          Math.min(LOBBY_MAX_PLAYERS, Math.round(Number(req.lobby.maxPlayers) || LOBBY_MAX_PLAYERS))),
        private: req.lobby.private === true,
        /**
         * A SECOND, INDEPENDENT DRAW -- not a slice of the lobby id.
         *
         * The first cut took the last six characters of `id`, which is exactly
         * the kind of thing that reads fine and is wrong: the id is PUBLIC (it
         * is on every row of the directory, because that is how you join), so
         * deriving the code from it means anybody who can list lobbies can
         * compute the code for every private one, and the private flag becomes
         * decoration. tests/signal.test.ts caught it by asserting that no
         * listed row contains the code as a substring.
         *
         * Server-minted rather than client-chosen for the usual reason: a
         * client-chosen code is a client-chosen collision, and the code is the
         * only thing guarding a private lobby.
         */
        code: req.lobby.private === true ? newId().slice(0, 6) : null,
        series,
        round: 0,
        status: 'open',
        peers: [{ id: req.peer.id, name: hostName, seenAt: now }],
        createdAt: now,
        seenAt: now,
      }
      await store.set(lobbyKey(id), rec)
      await indexAdd(store, id, alive)
      return { ok: true, op: 'create', lobby: rec }
    }

    // -----------------------------------------------------------------------
    case 'list': {
      const ids = await readDir(store)
      const out: LobbySummary[] = []
      const region = isRegion(req.region) ? req.region : null
      const search = typeof req.search === 'string'
        ? req.search.trim().toLowerCase().slice(0, 40) : ''
      for (const id of ids) {
        if (out.length >= MAX_LOBBIES) break
        const rec = await readLobby(store, id)
        if (!rec) continue
        if (now - rec.seenAt >= LOBBY_TTL_MS) continue
        const row = toSummary(rec, now)
        if (region && row.region !== region) continue
        if (req.joinableOnly && (row.status === 'full' || row.status === 'racing'
          || row.status === 'closed')) continue
        if (search && !(row.name.toLowerCase().includes(search)
          || row.hostName.toLowerCase().includes(search))) continue
        out.push(row)
      }
      return { ok: true, op: 'list', lobbies: out }
    }

    // -----------------------------------------------------------------------
    case 'join': {
      if (!req.peer || !idOk(req.peer.id)) return err('bad-peer')
      const rec = await readLobby(store, req.id)
      if (!rec || now - rec.seenAt >= LOBBY_TTL_MS) return err('notfound' satisfies JoinError)
      if (rec.status === 'closed') return err('notfound' satisfies JoinError)
      const live = livePeers(rec, now)
      // A rejoin is not a join. A player whose poll lapsed for a moment, or who
      // reloaded the tab, keeps their slot rather than being told the lobby is
      // full of themselves.
      const already = live.some((p) => p.id === req.peer.id)
      /**
       * A RACING LOBBY REFUSES STRANGERS AND NOT ITS OWN PLAYERS.
       *
       * The grid was fixed when the round started and a dropped slot is an AI
       * driving a car that still belongs to a person -- types.ts: "their slot
       * stays THEIRS for the round". So a member coming back through
       * `RaceTransport.rejoin` has to get past this line, and the first cut
       * did not let them: `rejoin()` re-posts its membership exactly as a join
       * does, and the endpoint answered `racing` and ended the rejoin before
       * any of the interesting machinery ran. The probe found it immediately.
       *
       * Somebody who was never in the room is still refused, which is what the
       * check was for.
       */
      if (rec.status === 'racing' && !already) return err('racing' satisfies JoinError)
      if (rec.private && (req.code ?? '').toUpperCase() !== rec.code) {
        return err('badcode' satisfies JoinError)
      }
      if (!already && live.length >= rec.maxPlayers) return err('full' satisfies JoinError)
      const next = await commitMember(store, rec,
        { id: req.peer.id, name: cleanName(req.peer.name, 'Racer'), seenAt: now }, now)
      return { ok: true, op: 'join', lobby: publicRecord(next) }
    }

    // -----------------------------------------------------------------------
    case 'poll': {
      if (!idOk(req.peer)) return err('bad-peer')
      const rec = await readLobby(store, req.id)
      if (!rec) return { ok: true, op: 'poll', lobby: null, mail: {}, hostQuietMs: 0 }
      // A poll IS the heartbeat. Separating them would double the request rate
      // for no information: a client that is polling is a client that is here.
      const me = rec.peers.find((p) => p.id === req.peer)
      if (me) {
        me.seenAt = now
        await store.set(lobbyKey(rec.id), { ...rec, seenAt: now })
      }
      const since = (req.since && typeof req.since === 'object') ? req.since : {}
      const mail: Record<string, SignalMsg[]> = {}
      // Read EVERY live peer's outbox for me, including peers who have not yet
      // appeared in a record this client has seen. The host learns about a new
      // guest from the guest's offer, not from the roster, so a roster that is
      // one poll stale must not hide the letter that would fix it.
      for (const p of livePeers(rec, now)) {
        if (p.id === req.peer) continue
        const raw = await store.get(mailKey(rec.id, p.id, req.peer))
        if (!raw || typeof raw !== 'object') continue
        const box = raw as { msgs?: unknown }
        if (!Array.isArray(box.msgs)) continue
        const from = Number((since as Record<string, unknown>)[p.id]) || 0
        const got: SignalMsg[] = []
        for (const m of box.msgs) {
          if (!m || typeof m !== 'object') continue
          const q = m as Partial<SignalMsg>
          if (typeof q.seq !== 'number' || q.seq <= from) continue
          if (typeof q.body !== 'string') continue
          got.push({ seq: q.seq, kind: (q.kind ?? 'ice') as SignalKind, body: q.body })
        }
        if (got.length > 0) mail[p.id] = got
      }
      return {
        ok: true,
        op: 'poll',
        lobby: publicRecord({ ...rec, peers: livePeers(rec, now) }),
        mail,
        hostQuietMs: Math.max(0, now - hostSeenAt(rec)),
      }
    }

    // -----------------------------------------------------------------------
    case 'send': {
      if (!idOk(req.from) || !idOk(req.to)) return err('bad-peer')
      if (!Array.isArray(req.msgs) || req.msgs.length === 0) return err('bad-msgs')
      const rec = await readLobby(store, req.id)
      if (!rec) return err('notfound')
      const key = mailKey(rec.id, req.from, req.to)
      const raw = await store.get(key)
      const prev = (raw && typeof raw === 'object' && Array.isArray((raw as { msgs?: unknown }).msgs))
        ? (raw as { seq?: number; msgs: SignalMsg[] })
        : { seq: 0, msgs: [] as SignalMsg[] }
      let seq = Number(prev.seq) || 0
      const msgs = prev.msgs.slice()
      for (const m of req.msgs.slice(0, 16)) {
        if (!m || typeof m.body !== 'string') continue
        if (m.body.length > MAX_BODY_CHARS) continue
        const kind = (m.kind === 'offer' || m.kind === 'answer' || m.kind === 'bye')
          ? m.kind : 'ice'
        msgs.push({ seq: ++seq, kind, body: m.body })
      }
      // SINGLE WRITER, so this is safe to rewrite whole. The cap is a ceiling
      // on a stuck client, not a queue policy: a peer that has gone away leaves
      // its outbox behind and a peer that never drains it would otherwise let
      // one blob grow without bound.
      await store.set(key, { seq, msgs: msgs.slice(-MAX_BOX_MSGS) })
      return { ok: true, op: 'send' }
    }

    // -----------------------------------------------------------------------
    case 'update': {
      const rec = await readLobby(store, req.id)
      if (!rec) return err('notfound')
      // HOST ONLY. The status a directory row shows is the host's statement
      // about their own lobby; a guest who could set it could hide a lobby
      // from the browser or mark somebody else's room as racing.
      if (!idOk(req.peer) || req.peer !== rec.hostId) return err('not-host')
      const next: LobbyRecord = {
        ...rec,
        status: isStatus(req.status) ? req.status : rec.status,
        round: typeof req.round === 'number' && isFinite(req.round)
          ? Math.max(0, Math.min(rec.series.length, Math.round(req.round)))
          : rec.round,
        peers: livePeers(rec, now),
        seenAt: now,
      }
      await store.set(lobbyKey(rec.id), next)
      await indexAdd(store, rec.id, alive)
      return { ok: true, op: 'update' }
    }

    // -----------------------------------------------------------------------
    /**
     * TAKE THE HOST ROLE, WHEN THE HOST IS DEMONSTRABLY NOT THERE.
     *
     * The survivors of a dead host elect one of their own without talking to
     * each other -- lowest surviving grid slot, run over a grid every client
     * holds a byte-identical copy of -- and that election is what makes the
     * RACE recover in seconds. This operation is about the other half: the
     * directory row, which is the only piece of a lobby that lives somewhere
     * neither the old host nor the new one controls.
     *
     * WITHOUT IT THE LOBBY DISAPPEARS FROM THE BROWSER MID-RACE. `update` is
     * host-only (a guest who could set the status could hide somebody else's
     * room), and `seenAt` is refreshed by whoever polls -- so a room whose
     * host has gone keeps being polled by seven people and is still struck
     * from the list at `LOBBY_TTL_MS`, because nothing can say "the race is
     * still going, and this is who to ask about it now".
     *
     * THE ENDPOINT ARBITRATES AND THE CLIENTS DO NOT. Two clients that somehow
     * reached different answers both claim; the read-back below means exactly
     * one wins, and the loser is handed the winner's record rather than an
     * error, so it learns who to dial from the same reply. That is the only
     * shared arbiter this architecture has and it costs one request.
     *
     * IT CANNOT BE A THEFT, which is the property that matters: a claim is
     * refused outright while the host is still being heard from. The only two
     * ways through are the host having said goodbye mid-race (`hostGone`) or
     * `HOST_CLAIM_AFTER_MS` of silence from it.
     */
    case 'host': {
      if (!idOk(req.peer)) return err('bad-peer')
      const rec = await readLobby(store, req.id)
      if (!rec) return err('notfound')
      if (rec.hostId === req.peer) return { ok: true, op: 'host', lobby: rec }
      // SOMEBODY ELSE ALREADY TOOK IT. Answered with the record rather than a
      // refusal: the claimant reads a `hostId` that is neither the host it
      // was replacing nor itself, and re-points at the winner from this one
      // reply instead of discovering it a poll later.
      if (req.was && rec.hostId !== req.was) {
        return { ok: true, op: 'host', lobby: publicRecord(rec) }
      }
      // A CLAIM FROM A STRANGER IS NOT A CLAIM. Only somebody the record
      // already knows as a live member may take the room, which is the same
      // membership test every other operation makes and the reason a passer-by
      // who can read the directory cannot walk off with a race.
      const live = livePeers(rec, now)
      if (!live.some((p) => p.id === req.peer)) return err('not-member')
      const quiet = now - hostSeenAt(rec)
      if (!rec.hostGone && quiet < HOST_CLAIM_AFTER_MS) return err('host-alive')
      const name = cleanName(req.name, live.find((p) => p.id === req.peer)?.name ?? 'Host')
      const next: LobbyRecord = {
        ...rec,
        hostId: req.peer,
        hostName: name,
        hostGone: false,
        // THE OLD HOST IS FORGOTTEN HERE AND NOT LEFT TO EXPIRE. Leaving them
        // in the peer list means the new host's `absorb` keeps trying to open
        // a connection to a tab that is not there, for a whole TTL, and the
        // room reads as "still connecting" for forty-five seconds of a race
        // that is already running.
        peers: live.filter((p) => p.id !== rec.hostId),
        seenAt: now,
      }
      await store.set(lobbyKey(rec.id), next)
      // Read back, exactly as `commitMember` does and for the same reason:
      // there is no compare-and-swap, so the only way to know whether this
      // claim is the one that stuck is to look.
      const back = await readLobby(store, rec.id)
      await indexAdd(store, rec.id, alive)
      return { ok: true, op: 'host', lobby: publicRecord(back ?? next) }
    }

    // -----------------------------------------------------------------------
    /**
     * Minted ICE servers. Not answered here -- see `SignalRequest`'s comment.
     *
     * A refusal is the CORRECT answer from this handler rather than a hole in
     * it: the only other caller is tools/probe-netcode.mjs, which mounts this
     * over a Map on a loopback where a relay would be a slower path to the
     * same place. The client treats it as "no relay configured" and falls back
     * to STUN, which is the shipped behaviour today.
     */
    case 'ice':
      return err('no-ice')

    // -----------------------------------------------------------------------
    case 'bye': {
      const rec = await readLobby(store, req.id)
      if (!rec) return { ok: true, op: 'bye' }
      if (rec.hostId === req.peer) {
        /**
         * A HOST WHO LEAVES MID-RACE HANDS THE ROOM ON RATHER THAN ENDING IT.
         *
         * types.ts used to call a host leaving the unavoidable cost of
         * peer-to-peer, and for a room sitting on the lobby screen it still
         * is -- there is nothing to save. A RACING room is the opposite case:
         * every survivor is stopped at an identical known frame, which is the
         * whole reason migration is possible at all, and a record that closed
         * under them would take away the mailbox they are about to
         * re-handshake through.
         *
         * So the row stays, marked, and the first survivor to claim it gets
         * it immediately. If there is nobody left to claim it, the second
         * branch below runs and the lobby closes exactly as it always did.
         */
        const others = livePeers(rec, now).filter((p) => p.id !== rec.hostId)
        if (rec.status === 'racing' && others.length > 0) {
          await store.set(lobbyKey(rec.id), {
            ...rec, hostGone: true, peers: others, seenAt: now,
          })
          return { ok: true, op: 'bye' }
        }
        // OTHERWISE THE HOST LEAVING ENDS THE LOBBY. Nobody is racing, so
        // there is nothing that could outlive them, and the endpoint has to
        // make that true rather than merely likely. Marked closed and left in
        // place for one TTL so a guest's next poll gets the reason rather
        // than a 404 -- "the host left" and "this lobby never existed" are
        // different sentences and the guest is entitled to the right one.
        await store.set(lobbyKey(rec.id), { ...rec, status: 'closed', seenAt: now })
        await indexDrop(store, rec.id)
        return { ok: true, op: 'bye' }
      }
      await store.set(lobbyKey(rec.id), {
        ...rec,
        peers: livePeers(rec, now).filter((p) => p.id !== req.peer),
        seenAt: now,
      })
      return { ok: true, op: 'bye' }
    }
  }
}
