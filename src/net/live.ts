/**
 * SpaceGen Racing — THE LIVE BACKEND. Lobbies over HTTP, rooms and races over
 * WebRTC.
 * ---------------------------------------------------------------------------
 * `LiveLobbyService` implements the `LobbyService` half of the contract and
 * `LiveRaceTransport` implements the other. Between them they are the only
 * things in the project that know a peer connection exists.
 *
 * ===========================================================================
 * WHERE EACH PIECE OF STATE LIVES, AND WHY THE SPLIT IS EXACTLY THERE
 *
 *   /api/signal   the DIRECTORY (who is hosting what) and the MAILBOX (SDP
 *                 and ICE). Polled. Low frequency by construction.
 *   data channel  the ROOM (who is in it, who is ready, what they are
 *                 driving), the START PACKET, and the race.
 *
 * The room is on the data channel and not on the endpoint because you are IN
 * it: you have a peer connection to everybody who matters, so change can be
 * pushed instead of asked for. types.ts says this in its `LobbyService`
 * comment -- "the directory is polled and the room is pushed" -- and the
 * reason it matters here is cost: a room pushed over the endpoint would be
 * eight clients polling once a second for twenty minutes while people pick
 * cars, which is more requests than everything else in the game put together.
 *
 * THE HOST OWNS THE ROOM. Guests send their own ready flag and loadout and
 * nothing else; the host merges them into one `LobbyRoom` and broadcasts it.
 * That is not a trust decision -- there is no trust in peer-to-peer -- it is
 * so that there is exactly one answer to "who is ready", which `start()` has
 * to be able to ask.
 *
 * ===========================================================================
 * THE TRANSPORT OUTLIVES THE ROUND
 *
 * `SeriesPlan` lets a lobby run 1, 3, 5 or 8 rounds. The peer connections are
 * a property of the ROOM and the frame counter is a property of the ROUND, so
 * the mesh is built once when you join and torn down once when you leave,
 * while `LiveRaceTransport` is created per round over the top of it. Every
 * race message carries its round number and anything from a stale round is
 * discarded -- which is the actual bug this guards: the last few input packets
 * of round 2 are still in flight while round 3 is priming its pipeline, and
 * without the stamp they would be accepted as round 3 frames and desync the
 * whole field on the first corner.
 *
 * The alternative -- tear the mesh down between rounds -- would make every
 * round after the first pay the full handshake again, including its chance of
 * failing, which turns a five-round series into five chances to lose a player
 * to NAT.
 */
import { CHASSIS } from '../content/chassis'
import { PILOTS } from '../content/pilots'
import { Rng } from '../sim/rng'
import { SignalClient, type CreateWire } from './signal'
import type { LobbyRecord } from './signalProtocol'
import {
  FAILURE_TEXT, StarMesh, type PeerFailure, type PeerState, type Shape,
} from './webrtc'
import {
  LOBBY_MAX_PLAYERS,
  type CreateLobbyOptions, type JoinError, type LobbyFilter, type LobbyMember,
  type LobbyRoom, type LobbyService, type LobbySummary, type MultiplayerSlot,
  type RaceStartPacket, type RaceTransport, type Result, type SeriesStanding,
} from './types'

/** Eight cars, as `LOBBY_MAX_PLAYERS` and the whole of `Race` insist. */
const GRID_SIZE = LOBBY_MAX_PLAYERS

/**
 * An unmeasured link's assumed round trip.
 *
 * The same 220ms the mock uses, and for the same reason: a peer whose ping has
 * not landed is not a peer with no latency, and an input delay derived from
 * zeroes would stall the race from frame one.
 */
export const UNKNOWN_PING_MS = 220

/**
 * Frames of input delay for a given worst-case path.
 *
 * Duplicated from net/mock.ts deliberately rather than imported: mock.ts is
 * the mock, and a live code path that imports from it is one refactor away
 * from shipping a mock. The formula is the same and both files should move
 * together if it ever changes -- half a round trip in frames, plus one for the
 * frame the sample is taken on, clamped to something a human can drive.
 */
export function inputDelayFor(worstPingMs: number | null): number {
  const ping = worstPingMs == null || !Number.isFinite(worstPingMs) || worstPingMs < 0
    ? UNKNOWN_PING_MS
    : worstPingMs
  const frames = Math.ceil((ping / 2) / (1000 / 60)) + 1
  return Math.max(2, Math.min(12, frames))
}

// ---------------------------------------------------------------------------
// Wire messages
// ---------------------------------------------------------------------------

type RoomWire = Omit<LobbyRoom, 'localId'>

type Wire =
  /** host -> guest. The room, minus the per-reader field. */
  | { t: 'room'; room: RoomWire }
  /** guest -> host. The only thing a guest gets to assert about itself. */
  | { t: 'me'; name: string; avatarId: string; ready: boolean; chassisId: string; pilotId: string }
  /** host -> guest, stamped per reader. */
  | { t: 'start'; packet: RaceStartPacket }
  | { t: 'kick' }
  | { t: 'closed'; reason: 'hostLeft' | 'kicked' | 'error' }
  /** Race traffic. `r` is the ROUND; see the header. */
  | { t: 'in'; r: number; f: number; p: number; id?: string }
  | { t: 'hash'; r: number; f: number; h: string; id?: string }
  | { t: 'drop'; r: number; id: string; f: number }
  | { t: 'desync'; r: number; f: number }

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

/**
 * One round's worth of race traffic over the room's star.
 *
 * THE HOST IS A RELAY AND NOT A SIMULATOR. It forwards a guest's input to the
 * other guests unchanged and immediately -- no aggregation, no waiting for the
 * frame to be complete. Aggregating would mean the fastest peer's input is
 * held until the slowest peer's arrives, which adds the worst link's latency
 * to every other link and is the exact cost a star is supposed to avoid.
 *
 * It does NOT re-simulate, re-order or validate. Lockstep's whole premise is
 * that every client computes the same race from the same inputs; a host that
 * "corrected" anything would be an authoritative server with none of the
 * protections of one.
 */
export class LiveRaceTransport implements RaceTransport {
  onInput: (playerId: string, frame: number, packed: number) => void = () => {}
  onHash: (playerId: string, frame: number, hash: string) => void = () => {}
  onDropped: (playerId: string) => void = () => {}
  /**
   * NOT IN `RaceTransport` YET, and it should be. See the report: a transport
   * that can detect a desync but cannot tell anybody is a detector with no
   * output, and the same goes for a stall. Declared here so the runner and the
   * UI have somewhere to attach; harmless to types.ts because extra members
   * are structurally compatible.
   */
  onDesync: (frame: number) => void = () => {}
  onRoundDrop: (playerId: string, frame: number) => void = () => {}

  private disposed = false

  constructor(
    private readonly mesh: StarMesh,
    /** Which round of the series this is. Stamped on every message. */
    readonly round: number,
    /** Peer id -> whether they are still in this round. */
    private readonly live: Set<string>,
  ) {}

  sendInput(frame: number, packed: number): void {
    if (this.disposed) return
    const msg: Wire = { t: 'in', r: this.round, f: frame, p: packed >>> 0 }
    if (this.mesh.isHost) {
      // The host addresses its own input, because a guest has no other way to
      // know whose it is: every message a guest receives arrives on the same
      // channel, from the host, whoever it started life with.
      this.mesh.broadcast({ ...msg, id: this.mesh.selfId })
    } else {
      this.mesh.send(this.mesh.hostId, msg)
    }
  }

  sendHash(frame: number, hash: string): void {
    if (this.disposed) return
    const msg: Wire = { t: 'hash', r: this.round, f: frame, h: hash }
    // GUESTS SEND, THE HOST JUDGES. The host does not broadcast its own hash:
    // it is the reference, and shipping it would invite eight clients to reach
    // eight independent verdicts about who diverged -- which is one more thing
    // to disagree about at exactly the moment disagreement is the problem.
    if (!this.mesh.isHost) this.mesh.send(this.mesh.hostId, msg)
  }

  /** Called by the service for every race message that arrives. */
  accept(from: string, msg: Wire): void {
    if (this.disposed) return
    switch (msg.t) {
      case 'in': {
        if (msg.r !== this.round) return
        const who = msg.id ?? from
        if (this.mesh.isHost) {
          // RELAY FIRST, THEN CONSUME. The other guests' copy of this input is
          // on the critical path and our own sim step is not: forwarding
          // before we hand it to the scheduler shaves one synchronous
          // handler's worth of work off every peer's latency.
          this.mesh.broadcast({ t: 'in', r: msg.r, f: msg.f, p: msg.p, id: from }, from)
        }
        if (this.live.has(who)) this.onInput(who, msg.f, msg.p >>> 0)
        return
      }
      case 'hash': {
        if (msg.r !== this.round || !this.mesh.isHost) return
        this.onHash(msg.id ?? from, msg.f, msg.h)
        return
      }
      case 'drop': {
        if (msg.r !== this.round) return
        this.live.delete(msg.id)
        this.onRoundDrop(msg.id, msg.f)
        return
      }
      case 'desync': {
        if (msg.r !== this.round) return
        this.onDesync(msg.f)
        return
      }
      default: return
    }
  }

  /** Host only: tell the room a slot is AI from `frame`. */
  announceDrop(playerId: string, frame: number): void {
    this.live.delete(playerId)
    this.mesh.broadcast({ t: 'drop', r: this.round, id: playerId, f: frame })
    this.onDropped(playerId)
  }

  /** Host only: tell the room the round is void. */
  announceDesync(frame: number): void {
    this.mesh.broadcast({ t: 'desync', r: this.round, f: frame })
  }

  /**
   * The worst round trip in the room.
   *
   * On the host this is the TWO-HOP worst (see `StarMesh.worstPathMs`), which
   * is the number the HUD's connection pip should be showing: it is what an
   * input actually costs in this room, not what the host's own link costs.
   */
  get worstPingMs(): number {
    return Math.round(this.mesh.worstPathMs(UNKNOWN_PING_MS))
  }

  dispose(): void { this.disposed = true }
}

// ---------------------------------------------------------------------------
// The lobby service
// ---------------------------------------------------------------------------

export interface LiveNetOptions {
  /**
   * The local account. Optional because `lobbyService()` is a synchronous
   * factory and `AccountService.load()` is not -- see `identity`. A probe that
   * already knows who it is passes these and skips the resolve entirely.
   */
  playerId?: string
  playerName?: string
  avatarId?: string
  /**
   * Resolved once, before the first request. The real build points this at
   * `accountService().load()`; nothing else in the service may assume an
   * account exists before `ensureIdentity` has run.
   */
  identity?: () => Promise<{ id: string; name: string; avatarId: string }>
  /** Where the signalling function is. Overridden by the probe. */
  endpoint?: string
  iceServers?: RTCIceServer[]
  /** Latency shaping, for the probe and for tests. Never set in a real build. */
  shape?: Shape | null
  fetchImpl?: typeof fetch
  makeConnection?: (cfg: RTCConfiguration) => RTCPeerConnection
  now?: () => number
  /** Overrides `CONNECT_TIMEOUT_MS`, for a probe that wants to watch a
   *  connection fail without waiting twelve seconds for it. */
  connectTimeoutMs?: number
  /** The garage selection, read at join time and when it changes. */
  loadout?: () => { chassisId: string; pilotId: string }
  /** Seed source for the race. Injected so a probe can pin it. */
  seed?: () => number
}

interface Member extends LobbyMember {
  joinedAt: number
}

export class LiveLobbyService implements LobbyService {
  onRoom: (room: LobbyRoom | null) => void = () => {}
  onStart: (packet: RaceStartPacket) => void = () => {}
  onClosed: (
    reason: 'hostLeft' | 'kicked' | 'unreachable' | 'error',
    detail?: string,
  ) => void = () => {}

  /**
   * A human-readable reason the last connection attempt failed, or null.
   *
   * NOT IN `LobbyService`, and it should be -- see the report. `onClosed` has
   * three enum values and none of them is "your network and theirs cannot see
   * each other", which is the single most likely way a real peer-to-peer join
   * fails. A player who gets `error` for that is told nothing they can act on.
   */
  lastFailure: string | null = null
  onFailure: (text: string) => void = () => {}

  private readonly opts: LiveNetOptions
  private readonly signal: SignalClient
  /** The resolve, kicked off once and awaited by every entry point. */
  private identity: Promise<void> | null = null
  private playerId: string
  private playerName: string
  private avatarId: string
  private readonly now: () => number
  private readonly rng: Rng

  /**
   * The room's peer connections, or null outside a room.
   *
   * READ-ONLY TO EVERYBODY ELSE. The HUD's connection pip, the room screen's
   * ping column and tools/probe-netcode.mjs all want to see per-peer state,
   * and there is no reason to copy it out into a parallel structure that can
   * go stale. Nothing outside this file calls anything on it that mutates.
   */
  mesh: StarMesh | null = null
  private record: LobbyRecord | null = null
  private members: Member[] = []
  private room: LobbyRoom | null = null
  private isHost = false
  private standings: SeriesStanding[] = []
  private round = 0
  /**
   * The round's transport, or null between rounds.
   *
   * NAMED `roundTransport` BECAUSE `transport` IS NOW A METHOD ON
   * `LobbyService`. This class asked for that in as many words ("NOT ON
   * `LobbyService`, and it needs to be -- see the report") and the contract
   * granted it; a private field and a public method cannot share a name, so
   * the field moved and `raceTransport()` stayed as an alias for the probe.
   */
  private roundTransport: LiveRaceTransport | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false

  constructor(opts: LiveNetOptions) {
    this.opts = opts
    this.now = opts.now ?? (() => Date.now())
    this.rng = new Rng((opts.seed?.() ?? Date.now()) >>> 0)
    this.playerId = opts.playerId ?? ''
    this.playerName = opts.playerName ?? 'Racer'
    this.avatarId = opts.avatarId ?? ''
    this.signal = new SignalClient({
      peerId: this.playerId,
      peerName: this.playerName,
      endpoint: opts.endpoint,
      fetchImpl: opts.fetchImpl,
    })
    this.signal.onMail = (from, msgs) => {
      for (const m of msgs) {
        if (m.kind === 'bye') { this.peerGone(from, 'bye'); continue }
        this.mesh?.accept(from, m.kind, m.body)
      }
    }
    this.signal.onLobby = (rec) => this.absorb(rec)
  }

  /**
   * Resolve the account, exactly once, before anything is addressed.
   *
   * Every letter this client posts is addressed FROM the account id, so a
   * request that went out before the profile landed would be signed by nobody
   * and the host would have no way to answer it. Idempotent and cached: the
   * second caller awaits the first caller's promise rather than loading twice.
   */
  private ensureIdentity(): Promise<void> {
    if (this.playerId) return Promise.resolve()
    if (!this.identity) {
      const load = this.opts.identity
      this.identity = load
        ? load().then((p) => {
          this.playerId = p.id
          this.playerName = p.name
          this.avatarId = p.avatarId
          this.signal.peerId = p.id
          this.signal.peerName = p.name
        }).catch(() => {
          // A profile that cannot be loaded is not a reason to have no id: the
          // account service already falls back to a device-local profile, and
          // a peer id only has to be unique within one lobby.
          this.playerId = `anon-${Math.floor(Math.random() * 1e9).toString(36)}`
          this.signal.peerId = this.playerId
        })
        : Promise.resolve()
    }
    return this.identity
  }

  // -------------------------------------------------------------------------
  // Directory
  // -------------------------------------------------------------------------

  /**
   * The lobby list.
   *
   * EVERY `pingMs` IS NULL AND THAT IS THE HONEST ANSWER, not a stub. types.ts
   * defines it as the round trip TO THE HOST, and there is no way to measure
   * that without opening a peer connection to them -- which for a list of
   * twenty rows would be twenty NAT traversals, twenty STUN exchanges and
   * twenty mailboxes, to draw a column. The room screen shows a real ping the
   * moment you are in one, which is when it starts to matter, and the browser
   * renders "--" until then exactly as the contract says it must.
   */
  async list(filter?: LobbyFilter): Promise<Result<readonly LobbySummary[]>> {
    await this.ensureIdentity()
    const rows = await this.signal.list({
      region: filter?.region,
      joinableOnly: filter?.joinableOnly,
      search: filter?.search,
    })
    if (!rows) return { ok: false, error: 'offline' }
    return { ok: true, value: rows }
  }

  async create(o: CreateLobbyOptions): Promise<Result<LobbyRoom>> {
    await this.ensureIdentity()
    const wire: CreateWire = {
      name: o.name,
      region: o.region,
      maxPlayers: o.maxPlayers,
      private: o.private,
      series: { length: o.series.length, trackIds: [...o.series.trackIds], laps: o.series.laps },
    }
    const res = await this.signal.create(wire)
    if (typeof res === 'string') return { ok: false, error: res }
    this.isHost = true
    this.enterRoom(res)
    return { ok: true, value: this.publish() }
  }

  async join(lobbyId: string, code?: string): Promise<Result<LobbyRoom, JoinError>> {
    await this.ensureIdentity()
    const res = await this.signal.join(lobbyId, code)
    if (typeof res === 'string') {
      const known: JoinError[] = ['notfound', 'full', 'racing', 'badcode', 'offline']
      return { ok: false, error: (known as string[]).includes(res) ? res as JoinError : 'offline' }
    }
    this.isHost = res.hostId === this.playerId
    this.enterRoom(res)
    // A GUEST OFFERS IMMEDIATELY, before the host has heard of them. The offer
    // is what tells the host somebody is there -- waiting for the roster to
    // come round would cost a whole poll interval on every single join.
    if (!this.isHost) this.mesh?.connect(res.hostId)
    return { ok: true, value: this.publish() }
  }

  current(): LobbyRoom | null { return this.room }

  // -------------------------------------------------------------------------
  // Room membership
  // -------------------------------------------------------------------------

  private enterRoom(rec: LobbyRecord): void {
    this.record = rec
    this.round = rec.round
    this.standings = []
    const lo = this.opts.loadout?.() ?? { chassisId: CHASSIS[0].id, pilotId: PILOTS[0].id }
    this.members = [{
      playerId: this.playerId,
      name: this.playerName,
      avatarId: this.avatarId,
      chassisId: lo.chassisId,
      pilotId: lo.pilotId,
      ready: false,
      isHost: this.isHost,
      pingMs: 0,
      connecting: false,
      joinedAt: this.now(),
    }]
    if (!this.isHost) {
      this.members.push({
        playerId: rec.hostId,
        name: rec.hostName,
        avatarId: '',
        chassisId: CHASSIS[0].id,
        pilotId: PILOTS[0].id,
        ready: false,
        isHost: true,
        pingMs: null,
        // TRUE UNTIL THE CHANNEL OPENS, which is the state `LobbyMember`
        // exists to describe and the reason `start()` can refuse. A room that
        // rendered the host as present the instant the HTTP join returned
        // would let a guest press Ready before there was any way to tell
        // anybody, and the ready would be silently lost.
        connecting: true,
        joinedAt: 0,
      })
    }
    this.mesh = new StarMesh({
      selfId: this.playerId,
      hostId: rec.hostId,
      iceServers: this.opts.iceServers,
      shape: this.opts.shape,
      makeConnection: this.opts.makeConnection,
      now: this.now,
      connectTimeoutMs: this.opts.connectTimeoutMs,
      signal: (to, kind, body) => this.signal.send(to, kind, body),
    })
    this.mesh.onMessage = (from, msg) => this.receive(from, msg as Wire)
    this.mesh.onPeerState = (peer, state, failure) => this.peerState(peer, state, failure)
    // The ping column and the input delay both read `PeerLink.pingMs`, which
    // updates on its own; this only re-renders so the number on screen moves.
    this.pingTimer = setInterval(() => { if (this.room) this.publish() }, 1000)
  }

  /** The roster from the endpoint. The host uses it to learn who to expect. */
  private absorb(rec: LobbyRecord | null): void {
    if (this.disposed || !this.record) return
    if (!rec) return
    if (rec.status === 'closed' && !this.isHost) { this.closed('hostLeft'); return }
    this.record = { ...rec, code: rec.code ?? this.record.code }
    let changed = false
    if (this.isHost) {
      for (const p of rec.peers) {
        if (p.id === this.playerId) continue
        // RE-OFFER RATHER THAN WAIT. The mailbox is best-effort and a lost
        // offer is a guest on a permanent spinner, so the host reaches out to
        // any peer it can see and has no link to. `StarMesh.connect` is
        // idempotent, so doing this on every poll costs nothing once a link
        // exists.
        if (!this.mesh?.get(p.id)) { this.mesh?.connect(p.id); changed = true }
        if (!this.members.some((m) => m.playerId === p.id)) {
          this.members.push({
            playerId: p.id, name: p.name, avatarId: '',
            chassisId: CHASSIS[0].id, pilotId: PILOTS[0].id,
            ready: false, isHost: false, pingMs: null, connecting: true,
            joinedAt: this.now(),
          })
          changed = true
        }
      }
      // Anybody the endpoint has forgotten AND we have no live link to is gone.
      const before = this.members.length
      this.members = this.members.filter((m) =>
        m.playerId === this.playerId
        || rec.peers.some((p) => p.id === m.playerId)
        || this.mesh?.get(m.playerId)?.state === 'open')
      if (this.members.length !== before) changed = true
    }
    /**
     * THE POLL RATE, WHICH IS WHERE A JOIN IS WON OR LOST.
     *
     * Fast while anything is mid-handshake, because that is somebody looking
     * at a spinner. Then, for a HOST whose lobby is open, the middle rate --
     * because an empty lobby is precisely the state in which a stranger is
     * about to knock, and a host that has dropped to the ten-second heartbeat
     * does not hear them for ten seconds. That was a real bug and it looked
     * exactly like a broken connection; see the header of net/signal.ts.
     * Everyone else drops to the heartbeat, because the room is on the data
     * channel and the endpoint has nothing left to say.
     */
    const pending = this.mesh
      ? this.mesh.peers.some((l) => l.state === 'connecting') || this.expecting()
      : false
    const listening = this.isHost && this.statusNow() === 'open'
    this.signal.rate = pending ? 'fast' : listening ? 'open' : 'idle'
    if (changed) this.pushRoom()
    this.publish()
  }

  /** True while the host is still waiting for a peer it knows about. */
  private expecting(): boolean {
    if (!this.isHost || !this.record) return false
    return this.record.peers.some((p) =>
      p.id !== this.playerId && this.mesh?.get(p.id)?.state !== 'open')
  }

  private peerState(peer: string, state: PeerState, failure: PeerFailure | null): void {
    const m = this.members.find((x) => x.playerId === peer)
    if (m) m.connecting = state !== 'open'
    if (state === 'open') {
      this.lastFailure = null
      if (!this.isHost) this.sendMe()
      else this.pushRoom()
    }
    if (state === 'failed') {
      const text = FAILURE_TEXT[failure ?? 'lost']
      this.lastFailure = text
      this.onFailure(text)
      // A GUEST WHOSE ONLY LINK FAILED IS NOT IN A LOBBY. Saying so beats
      // leaving them in a room whose other members will never appear -- which
      // is the spinner this whole enum exists to avoid.
      if (!this.isHost && peer === this.record?.hostId) {
        console.warn('net: could not reach the host —', text)
        this.closed('error')
        return
      }
      this.peerGone(peer, failure ?? 'lost')
    }
    this.publish()
  }

  private peerGone(peer: string, why: PeerFailure): void {
    if (this.roundTransport && this.isHost) {
      // Mid-race. The lockstep runner decides the FRAME; this only reports
      // that the wire is gone, which is what makes the runner's short deadline
      // apply instead of its long one.
      this.roundTransport.onDropped(peer)
    }
    this.mesh?.drop(peer, why)
    this.members = this.members.filter((m) => m.playerId !== peer)
    if (this.isHost) { this.pushRoom(); this.signal.update(this.statusNow()) }
    this.publish()
  }

  // -------------------------------------------------------------------------
  // Room state on the wire
  // -------------------------------------------------------------------------

  private receive(from: string, msg: Wire): void {
    if (this.disposed || !msg || typeof msg.t !== 'string') return
    switch (msg.t) {
      case 'room':
        if (this.isHost || from !== this.record?.hostId) return
        this.members = msg.room.members.map((m, i) => ({ ...m, joinedAt: i }))
        this.round = msg.room.round
        this.standings = [...msg.room.standings]
        this.publish()
        return
      case 'me': {
        if (!this.isHost) return
        const m = this.members.find((x) => x.playerId === from)
        if (!m) return
        m.name = msg.name || m.name
        m.avatarId = msg.avatarId || m.avatarId
        m.chassisId = msg.chassisId || m.chassisId
        m.pilotId = msg.pilotId || m.pilotId
        m.ready = msg.ready === true
        this.pushRoom()
        this.publish()
        return
      }
      case 'start':
        if (this.isHost || from !== this.record?.hostId) return
        this.beginRound(msg.packet)
        return
      case 'kick':
        if (from !== this.record?.hostId) return
        this.closed('kicked')
        return
      case 'closed':
        if (from !== this.record?.hostId) return
        this.closed(msg.reason)
        return
      default:
        // Race traffic. The transport owns the round stamp, so a packet from
        // a round that has ended is discarded there rather than here.
        this.roundTransport?.accept(from, msg)
    }
  }

  /** Guest -> host: the only thing a guest asserts about itself. */
  private sendMe(): void {
    if (this.isHost || !this.mesh || !this.record) return
    const me = this.members.find((m) => m.playerId === this.playerId)
    if (!me) return
    this.mesh.send(this.record.hostId, {
      t: 'me', name: me.name, avatarId: me.avatarId,
      ready: me.ready, chassisId: me.chassisId, pilotId: me.pilotId,
    } satisfies Wire)
  }

  /** Host -> everyone: the room as it actually is. */
  private pushRoom(): void {
    if (!this.isHost || !this.mesh || !this.record) return
    const room = this.roomBody()
    this.mesh.broadcast({ t: 'room', room } satisfies Wire)
  }

  /**
   * The room as the HOST sees it. Only the host calls this.
   *
   * PINGS ARE MEASURED HERE AND PUBLISHED TO EVERYBODY. A guest cannot measure
   * another guest -- there is no link between them in a star -- so a guest's
   * own opinion of the room's pings would be one real number and six
   * inventions. `LobbyMember.pingMs` is documented as the round trip TO THE
   * HOST, which is exactly and only the number the host has.
   *
   * THE HOST'S OWN ROW IS 0, not the local reader's, which is a distinction
   * the first cut got wrong: it zeroed whoever was reading, so on a guest the
   * guest's own latency vanished and the host's appeared as a real number --
   * precisely backwards, and it photographs perfectly.
   */
  private roomBody(): RoomWire {
    const rec = this.record
    const members: LobbyMember[] = this.members.map((m) => {
      const link = this.mesh?.get(m.playerId)
      return {
        playerId: m.playerId,
        name: m.name,
        avatarId: m.avatarId,
        chassisId: m.chassisId,
        pilotId: m.pilotId,
        ready: m.ready,
        isHost: m.isHost,
        pingMs: m.isHost ? 0 : link?.pingMs == null ? null : Math.round(link.pingMs),
        connecting: !m.isHost && link?.state !== 'open',
      }
    })
    return {
      id: rec?.id ?? '',
      name: rec?.name ?? '',
      region: rec?.region ?? 'na-west',
      private: rec?.private ?? false,
      joinCode: this.isHost ? rec?.code ?? null : null,
      series: rec?.series ?? { length: 1, trackIds: [], laps: 3 },
      round: this.round,
      standings: this.standings,
      maxPlayers: rec?.maxPlayers ?? GRID_SIZE,
      status: this.statusNow(),
      members,
    }
  }

  private statusNow(): LobbyRoom['status'] {
    if (this.roundTransport) return 'racing'
    const n = this.members.length
    return n >= (this.record?.maxPlayers ?? GRID_SIZE) ? 'full' : 'open'
  }

  /** Stamp the room for the local reader and hand it up. */
  private publish(): LobbyRoom {
    const body = this.isHost ? this.roomBody() : this.guestRoomBody()
    const room: LobbyRoom = { ...body, localId: this.playerId }
    this.room = room
    this.onRoom(room)
    return room
  }

  /**
   * The room as a GUEST sees it: exactly what the host last published, with
   * the two facts the guest knows better than the host does.
   *
   * IT DOES NOT RECOMPUTE THE PINGS, and that is the fix. Running the host's
   * builder on a guest wiped every published ping and replaced it with the
   * guest's own view -- which is one link (to the host) and nulls or, worse,
   * zeroes for everybody else. The whole reason the host publishes the column
   * is that nobody else can measure it.
   *
   * The two exceptions are live facts about THIS client: its own round trip to
   * the host, measured here and one push fresher than the host's copy, and
   * whether its own link to the host is up -- which the host, by definition,
   * cannot tell it once it is not.
   */
  private guestRoomBody(): RoomWire {
    const rec = this.record
    const host = this.mesh?.get(rec?.hostId ?? '')
    const hostUp = host?.state === 'open'
    const members: LobbyMember[] = this.members.map((m) => {
      if (m.playerId === this.playerId) {
        return { ...m, pingMs: host?.pingMs == null ? null : Math.round(host.pingMs),
          connecting: !hostUp }
      }
      if (m.isHost) return { ...m, pingMs: 0, connecting: !hostUp }
      return { ...m }
    })
    return {
      id: rec?.id ?? '',
      name: rec?.name ?? '',
      region: rec?.region ?? 'na-west',
      private: rec?.private ?? false,
      // A guest never has the code, and must not draw a blank where the host
      // draws one: `joinCode: null` is what the room screen renders as "ask
      // the host", and an empty string would render as a code of no digits.
      joinCode: null,
      series: rec?.series ?? { length: 1, trackIds: [], laps: 3 },
      round: this.round,
      standings: this.standings,
      maxPlayers: rec?.maxPlayers ?? GRID_SIZE,
      status: this.statusNow(),
      members,
    }
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  async setReady(ready: boolean): Promise<void> {
    const me = this.members.find((m) => m.playerId === this.playerId)
    if (!me) return
    // A READY FROM SOMEBODY STILL CONNECTING IS REFUSED, which types.ts warns
    // about by name: "a player who is still connecting cannot be ready". The
    // authoritative answer is the `onRoom` below, which overwrites whatever
    // the button drew optimistically.
    const linked = this.isHost || this.mesh?.get(this.record?.hostId ?? '')?.state === 'open'
    me.ready = ready && linked
    if (this.isHost) this.pushRoom(); else this.sendMe()
    this.publish()
  }

  async setLoadout(chassisId: string, pilotId: string): Promise<void> {
    const me = this.members.find((m) => m.playerId === this.playerId)
    if (!me) return
    me.chassisId = chassisId
    me.pilotId = pilotId
    if (this.isHost) this.pushRoom(); else this.sendMe()
    this.publish()
  }

  async setTrack(trackId: string, laps: number): Promise<Result<LobbyRoom>> {
    if (!this.isHost || !this.record) return { ok: false, error: 'nothost' }
    const ids = [...this.record.series.trackIds]
    ids[Math.min(this.round, ids.length - 1)] = trackId
    this.record = { ...this.record, series: { ...this.record.series, trackIds: ids, laps } }
    // EVERY READY IS CLEARED. A ready you gave for Elkarim is not a ready for
    // Zhen-9, which types.ts says in as many words.
    for (const m of this.members) m.ready = false
    this.pushRoom()
    return { ok: true, value: this.publish() }
  }

  async kick(playerId: string): Promise<void> {
    if (!this.isHost) return
    this.mesh?.send(playerId, { t: 'kick' } satisfies Wire)
    this.peerGone(playerId, 'bye')
  }

  async leave(): Promise<void> {
    if (this.isHost) {
      // THE HOST LEAVING ENDS THE ROOM and everybody is told before the wire
      // goes, because a guest who only finds out from a dead connection gets
      // 'error' and the wrong sentence.
      this.mesh?.broadcast({ t: 'closed', reason: 'hostLeft' } satisfies Wire)
    }
    await this.signal.bye()
    this.teardown()
    this.room = null
    this.onRoom(null)
  }

  private closed(reason: 'hostLeft' | 'kicked' | 'error'): void {
    this.teardown()
    this.room = null
    this.onClosed(reason)
    this.onRoom(null)
  }

  private teardown(): void {
    if (this.pingTimer !== null) { clearInterval(this.pingTimer); this.pingTimer = null }
    this.roundTransport?.dispose()
    this.roundTransport = null
    this.mesh?.dispose()
    this.mesh = null
    this.record = null
    this.members = []
  }

  // -------------------------------------------------------------------------
  // Starting
  // -------------------------------------------------------------------------

  async start(): Promise<Result<RaceStartPacket>> {
    if (!this.isHost || !this.record) return { ok: false, error: 'nothost' }
    if (this.members.length < 2) return { ok: false, error: 'alone' }
    // ASKED OF THE LINKS, NOT OF A CACHED FLAG. `Member.connecting` is set
    // from a state-change callback, and a callback that has not fired yet is
    // the one failure mode this check exists to catch -- a race started
    // against somebody whose channel is not open loses their inputs from
    // frame one and stalls the whole room on the grid.
    if (this.members.some((m) => !m.isHost && this.mesh?.get(m.playerId)?.state !== 'open')) {
      return { ok: false, error: 'connecting' }
    }
    if (this.members.some((m) => !m.ready && !m.isHost)) return { ok: false, error: 'unready' }

    const packet = this.buildPacket()
    // ONE BODY, STAMPED PER READER. `grid` is the same array object in every
    // copy, so two clients cannot drift apart through an edit here; only
    // `localPlayerId` differs, which types.ts is explicit is the only field
    // that may. The host's own copy names the host.
    for (const m of this.members) {
      if (m.playerId === this.playerId) continue
      this.mesh?.send(m.playerId, {
        t: 'start', packet: { ...packet, localPlayerId: m.playerId },
      } satisfies Wire)
    }
    this.signal.update('racing', this.round)
    this.beginRound(packet)
    return { ok: true, value: packet }
  }

  /**
   * The grid the host publishes.
   *
   * ORDER: humans first, host on pole, then AI behind -- the same convention
   * the mock uses, so the lobby screen and the race look the same whichever
   * backend is behind them.
   *
   * `inputDelay` COMES FROM THE TWO-HOP WORST PATH, not from the host's worst
   * link. In a star an input from the slowest guest reaches the second slowest
   * guest through the host and pays both legs, so a delay sized on one leg is
   * too small for every guest-to-guest pair in the room and the symptom is a
   * race that stalls constantly on links that look fine from the host's seat.
   * `StarMesh.worstPathMs` is the sum for exactly this reason.
   */
  private buildPacket(): RaceStartPacket {
    const grid: MultiplayerSlot[] = []
    const humans = [...this.members].sort((a, b) => {
      if (a.isHost !== b.isHost) return a.isHost ? -1 : 1
      return a.joinedAt - b.joinedAt
    })
    for (const m of humans) {
      if (grid.length >= GRID_SIZE) break
      grid.push({
        slot: grid.length,
        playerId: m.playerId,
        name: m.name,
        avatarId: m.avatarId || null,
        chassisId: m.chassisId,
        pilotId: m.pilotId,
        isHost: m.isHost,
        aiSkill: null,
      })
    }
    for (let i = 0; grid.length < GRID_SIZE; i++) {
      const slot = grid.length
      grid.push({
        slot,
        playerId: null,
        name: `${PILOTS[(i + 1) % PILOTS.length].name}`,
        avatarId: null,
        chassisId: CHASSIS[(i + 2) % CHASSIS.length].id,
        pilotId: PILOTS[(i + 1) % PILOTS.length].id,
        isHost: false,
        // PUBLISHED, NOT DERIVED, which types.ts spends a paragraph on: it is
        // an input to the physics exactly as the seed is, and a client that
        // invented its own would diverge from frame one.
        aiSkill: 2 + (slot % 3),
      })
    }
    const rec = this.record
    const worst = this.mesh?.worstPathMs(UNKNOWN_PING_MS) ?? UNKNOWN_PING_MS
    return {
      lobbyId: rec?.id ?? '',
      localPlayerId: this.playerId,
      trackId: rec?.series.trackIds[Math.min(this.round, (rec.series.length - 1))] ?? '',
      laps: rec?.series.laps ?? 3,
      round: this.round,
      seriesLength: rec?.series.length ?? 1,
      standings: this.standings,
      seed: (this.rng.next() * 0xffffffff) >>> 0,
      grid,
      inputDelay: inputDelayFor(worst),
    }
  }

  /**
   * Open a transport for this round and hand the packet up.
   *
   * THE MESH IS NOT TOUCHED. Everything peer-shaped -- the connections, the
   * ping history, the ICE state -- survives; only the round counter and the
   * frame numbering are new. See the header on why that distinction is the
   * whole reason a series is affordable.
   */
  private beginRound(packet: RaceStartPacket): void {
    if (!this.mesh) return
    this.roundTransport?.dispose()
    const live = new Set<string>()
    for (const s of packet.grid) if (s.playerId) live.add(s.playerId)
    this.roundTransport = new LiveRaceTransport(this.mesh, packet.round, live)
    this.onStart(packet)
  }

  /**
   * The transport for the round now running, or null between rounds.
   *
   * NOT ON `LobbyService`, and it needs to be -- see the report. Today the
   * only thing the front end receives when a race starts is the packet, and a
   * packet cannot carry inputs. `src/net/index.ts` re-exports this so a probe
   * and `game/main.ts` can both reach it.
   */
  raceTransport(): LiveRaceTransport | null { return this.roundTransport }

  /** The same thing under the name `LobbyService` gives it. */
  transport(): RaceTransport | null { return this.roundTransport }

  /**
   * The round is over (finished, abandoned or void). Back to the room.
   *
   * ASYNC TO MATCH THE CONTRACT, which returns a promise because a service
   * with a server behind it would have to go and tell it. Nothing here waits
   * on anything, so the promise is already resolved when it is handed back --
   * and the caller is documented not to await it anyway: the authoritative
   * answer is the `onRoom` that follows.
   *
   * AN EMPTY TABLE MEANS "NOTHING TO BANK", not "wipe it". A void round ends
   * with no result and must not erase the four rounds before it.
   */
  async endRound(standings: readonly SeriesStanding[] = []): Promise<void> {
    this.roundTransport?.dispose()
    this.roundTransport = null
    if (standings.length > 0) this.standings = [...standings]
    if (this.isHost && this.record) {
      this.round = Math.min(this.round + 1, this.record.series.length)
      for (const m of this.members) m.ready = false
      this.signal.update(this.statusNow(), this.round)
      this.pushRoom()
    }
    if (this.room) this.publish()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    void this.signal.bye()
    this.signal.dispose()
    this.teardown()
  }
}
