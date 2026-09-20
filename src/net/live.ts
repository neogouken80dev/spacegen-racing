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
import {
  REJOIN_LEAD_FRAMES, type HandoverWire, type RepairPeer, type TapeRow,
} from './lockstep'
import { SignalClient, type CreateWire } from './signal'
import type { LobbyRecord } from './signalProtocol'
import {
  FAILURE_TEXT, StarMesh, resolveIce,
  type PeerFailure, type PeerState, type Shape,
} from './webrtc'
import {
  LOBBY_MAX_PLAYERS, MIGRATION_BUDGET_MS,
  type CreateLobbyOptions, type JoinError, type LinkStatus, type LobbyFilter,
  type LobbyMember, type LobbyRoom, type LobbyService, type LobbySummary,
  type MigrationState, type MultiplayerSlot, type RaceStartPacket,
  type RaceTransport, type Result, type SeriesStanding,
  type RoundResume,
} from './types'
import { DEFAULT_DIFFICULTY, skillForSlot } from '../content/difficulty'

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

/**
 * WHO BECOMES HOST WHEN THE HOST DIES.
 *
 * THE LOWEST SURVIVING GRID SLOT, AND IT HAS TO BE SOMETHING OF EXACTLY THIS
 * SHAPE. types.ts states the constraint: the survivors cannot negotiate,
 * because the thing that would have carried the negotiation is the thing that
 * died. So every client runs the same rule over the same data, alone, and
 * arrives at the same answer -- which means the rule may read ONLY things that
 * are byte-identical on every client.
 *
 * `grid` qualifies: it is one broadcast object, shared by reference inside the
 * start packet precisely so that no two clients can hold different copies of
 * it. "Best ping" does not qualify, and not only because it needs the
 * measurements that need the connections that do not exist yet -- it is also a
 * number every client would have a different opinion of.
 *
 * `live` IS THE ONE PIECE OF MUTABLE STATE IT READS, and that is a judgement
 * call worth spelling out. A slot the room has already handed to the AI cannot
 * host anything: it is gone. Excluding it is what stops a room that lost its
 * lowest-slot guest an hour ago from electing that ghost and failing the
 * migration outright, which would be the common case rather than the rare one.
 *
 * The price is a window of a few hundred milliseconds: a drop the dying host
 * announced to some clients and not others leaves them disagreeing about the
 * candidate set, and if that slot is the lowest one they split. The window is
 * narrow (a drop is announced once, on one frame), the event needs a second
 * failure inside it, and the outcome is a migration that times out and says so
 * rather than a race that silently forks. Against a failure mode that is
 * routine, that is the better trade -- but it IS a trade and it is the first
 * thing to revisit if migrations are ever seen to fail in the field.
 */
export function electHost(
  grid: readonly MultiplayerSlot[],
  deadHostId: string,
  live: ReadonlySet<string>,
): string | null {
  let best: MultiplayerSlot | null = null
  for (const s of grid) {
    if (!s.playerId || s.playerId === deadHostId) continue
    if (!live.has(s.playerId)) continue
    if (!best || s.slot < best.slot) best = s
  }
  return best?.playerId ?? null
}

/**
 * How many frames of the round go in one `tape` message.
 *
 * A data channel refuses a message much over 256 KB and Chromium's practical
 * ceiling is lower still. One frame is eight slots' worth of integers, about
 * 80 bytes of JSON once the array commas are counted, so 1,200 frames is
 * around 100 KB -- comfortably inside it, and twenty seconds of race per
 * message. A two-minute round is therefore six messages, which arrive in
 * order on an ordered channel and are reassembled by index.
 */
const TAPE_CHUNK_FRAMES = 1200

/**
 * What the player reads while the room is finding a new host.
 *
 * A ROLE AND A CLOCK. The role, because during a migration the thing we are
 * blocked on is not a person -- naming the last peer whose input was missing
 * is naming somebody who is fine. The clock, because
 * `MIGRATION_BUDGET_MS` is thirty seconds and a thirty-second wait with no
 * number on it reads as a hang; a player who thinks the game has hung closes
 * the tab, which in a small room turns one lost host into a migration with
 * nobody left to migrate to.
 */
function migrationLine(remainingMs: number): string {
  return `a new host — ${Math.max(0, Math.ceil(remainingMs / 1000))}s`
}

/**
 * How long the host has to have been quiet before a survivor acts on it.
 *
 * TWO AND A BIT MISSED HEARTBEATS at `POLL_RACE_MS` (4s), which is the fastest
 * a monotonically growing quiet time can be told apart from a beat that is
 * merely in flight. Deliberately SHORTER than the endpoint's own
 * `HOST_CLAIM_AFTER_MS`, and the two answer different questions: this one
 * decides whether the RACE repairs itself, which is urgent and reversible --
 * if we are wrong, a guest reconnects to a host that is still there and
 * nothing is lost but a handshake. The endpoint's decides who owns a
 * DIRECTORY ROW, which is not reversible and can afford to be careful.
 */
const HOST_SILENT_MS = 9_000

/** How often the endpoint is asked during that wait. Fast, because it is
 *  bounded by `MIGRATION_BUDGET_MS` and there is a player watching a clock. */
const CONFIRM_POLL_MS = 1200

/**
 * Slice a whole round's table into messages a data channel will actually take.
 *
 * BY FRAME RANGE AND NOT BY ROW, because one row of a two-minute round is
 * already 7,200 integers and splitting by slot would put the biggest thing in
 * one message. Every chunk carries the same frame window for every slot, so a
 * client that has chunks 0..k holds a complete, contiguous, replayable prefix
 * of the round -- which is what makes a half-delivered tape detectable rather
 * than merely wrong.
 */
export function chunkTape(rows: readonly TapeRow[], toFrame: number): TapeRow[][] {
  const n = Math.max(1, Math.ceil(Math.max(1, toFrame) / TAPE_CHUNK_FRAMES))
  const out: TapeRow[][] = []
  for (let i = 0; i < n; i++) {
    const lo = 1 + i * TAPE_CHUNK_FRAMES
    const hi = lo + TAPE_CHUNK_FRAMES - 1
    const part: TapeRow[] = []
    for (const r of rows) {
      const a = Math.max(lo, r.from)
      const b = Math.min(hi, r.from + r.packed.length - 1)
      if (b < a) continue
      part.push({ slot: r.slot, from: a, packed: r.packed.slice(a - r.from, b - r.from + 1) })
    }
    out.push(part)
  }
  return out
}

// ---------------------------------------------------------------------------
// Wire messages
// ---------------------------------------------------------------------------

type RoomWire = Omit<LobbyRoom, 'localId'>

type Wire =
  /**
   * host -> guest. The room, minus the per-reader field.
   *
   * `worst` IS THE TWO-HOP WORST PATH AND ONLY THE HOST CAN KNOW IT. A guest's
   * mesh holds one link, so `worstPathMs` on a guest is its own leg and
   * nothing else -- which is right for the guest's own ping column and wrong
   * for the HUD's connection pip, whose job is to say what an input costs in
   * this room. In a room with one relayed guest at 300ms and one direct guest
   * at 30ms, the direct guest's own view is 30 and the truth is 330.
   */
  | { t: 'room'; room: RoomWire; worst?: number }
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

  // -------------------------------------------------------------------------
  // Repair: host migration and rejoin. See `beginMigration`.
  // -------------------------------------------------------------------------
  /**
   * survivor -> new host, on the first open link after the old host died.
   *
   * `f` is the frame this client STEPPED, `rows` is every cell of the input
   * table it holds, `std` is its copy of the series standings and `sl` is its
   * grid slot. Everything the repair needs, in one message, because a repair
   * that takes two round trips through a mailbox takes two poll intervals.
   */
  | { t: 'mine'; r: number; f: number; sl: number
      rows: TapeRow[]; std: readonly SeriesStanding[] }
  /**
   * new host -> everyone: the agreed cut.
   *
   * `f` is the resume frame, `rows` is the UNION of every survivor's table,
   * `hand` is the agreed AI/person history for every slot (including the dead
   * host's, newly decided) and `std` is the standings the room agreed on.
   */
  | { t: 'resume'; r: number; f: number; rows: TapeRow[]
      hand: HandoverWire[]; std: readonly SeriesStanding[] }
  /** new host -> everyone: the role has moved, and to whom. Also sent to a
   *  guest that reconnects later, so it never has to guess. */
  | { t: 'host'; id: string; name: string }
  /** returning guest -> host: I am back, and I want my slot. */
  | { t: 'back'; r: number }
  /**
   * host -> returning guest: the round so far, in chunks.
   *
   * THE WHOLE ROUND AND NOT A DIFF, because the returning client may be a
   * fresh page: a reload loses the `Race` as well as the link, and a diff
   * against nothing is the whole thing anyway. `i`/`n` are the chunk index and
   * count -- a data channel message over about 256 KB is refused by Chromium,
   * and a two-minute round's table is bigger than that.
   */
  | { t: 'tape'; r: number; i: number; n: number; f: number
      rows: TapeRow[]; hand: HandoverWire[]; packet?: RaceStartPacket }
  /** host -> everyone: a slot is a PERSON again from this frame. The exact
   *  reverse of `drop`, and it carries a frame for exactly the same reason. */
  | { t: 'live'; r: number; id: string; f: number }
  /** host -> returning guest: no. `why` is a sentence, not a code. */
  | { t: 'noback'; r: number; why: string }

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
  /**
   * The room is repairing itself, progressing, or done (null).
   *
   * THE COUNTDOWN IS THE POINT. A thirty-second wait with no clock on it reads
   * as a hang, and a player who thinks the game has hung closes the tab --
   * which turns one lost host into two lost players and, in a small room, into
   * a migration that then has nobody to migrate to. `remainingMs` exists so
   * the screen can say how long it will keep trying.
   */
  onMigration: (state: MigrationState | null) => void = () => {}
  /** The host role moved. Fired on every client, the new host included. */
  onHostChange: (hostId: string) => void = () => {}
  /** A slot is a PERSON again from `frame`. The reverse of `onRoundDrop`, and
   *  the runner has to honour it on exactly the same terms. */
  onRoundLive: (playerId: string, frame: number) => void = () => {}
  /**
   * Everything a returning client needs to rebuild the round: the packet it
   * missed, the whole input table, and the agreed handover history.
   *
   * NOT IN `RaceTransport` YET AND IT NEEDS TO BE -- see the report. `rejoin()`
   * can re-open a link and can reserve a slot, and neither of those puts a
   * `Race` back on the screen. Something above this file has to rebuild the
   * race from the packet and then replay the tape into it, and this is the
   * only place that data exists.
   */
  onResync: (resume: RoundResume) => void = () => {}

  private disposed = false
  /** Set by the lobby service. `rejoin()` is a question about the ROOM -- it
   *  needs the signalling mailbox and a new peer connection -- and the
   *  transport owns neither. */
  rejoinWith: (() => Promise<Result<void>>) | null = null
  /** Up, migrating, rejoining or down. Written by the service, which is the
   *  only thing that knows. */
  status: LinkStatus = 'up'
  /**
   * The host's two-hop worst path, as the host published it.
   *
   * A guest cannot measure it (see the `room` wire message) and must not
   * invent it, so it holds the last number the host sent and falls back to its
   * own single leg before the first push arrives.
   */
  publishedWorstMs: number | null = null

  constructor(
    private mesh: StarMesh,
    /** Which round of the series this is. Stamped on every message. */
    readonly round: number,
    /** Peer id -> whether they are still in this round. */
    private readonly live: Set<string>,
  ) {}

  /**
   * The star has been rebuilt around a new hub.
   *
   * EVERY DIRECTIONAL DECISION IN THIS CLASS READS `mesh.isHost`, which is why
   * re-pointing one field is the whole of becoming a relay: `sendInput`
   * switches from addressing the host to broadcasting with its own id on,
   * `sendHash` stops sending and starts judging, and `accept` starts
   * forwarding. Keeping a separate `isHost` flag here would have been a second
   * copy of one fact, and the migration would have had two places to get it
   * right.
   */
  rehost(mesh: StarMesh): void { this.mesh = mesh }

  /**
   * The round's lockstep runner, once it exists.
   *
   * SET BY THE RUNNER ITSELF (see `RunnerTransport.attach`), not by the front
   * end. A repair needs the input table and the table lives in the runner;
   * making game/main.ts hand one to the other would have added a fifth wiring
   * line to a function that already has four, and a repair that quietly does
   * nothing because that line was forgotten is a repair that fails only when
   * nobody is watching.
   */
  peer: RepairPeer | null = null

  /**
   * Inputs that arrived while this client had no runner to give them to.
   *
   * A REJOIN REBUILDS THE RACE, so between the tape arriving and the new
   * runner existing there is a window -- a second or two, while a circuit is
   * swapped and eight vehicles are spawned -- in which the host is relaying
   * live inputs at 60Hz to nobody. Every one of those is a frame the returning
   * client will need and can never ask for again: the relay does not
   * retransmit and the tape has already been sent. Dropping them is a client
   * that reconnects, replays perfectly, and then stalls for ever on the first
   * frame after the snapshot.
   *
   * Capped, because a rejoin that never completes must not grow this without
   * bound. Two thousand frames is over half a minute of race, which is longer
   * than the whole migration budget allows anything to take.
   */
  private pending: { id: string; f: number; p: number }[] = []

  attach(peer: RepairPeer): void {
    this.peer = peer
    // Flushed AFTER the handlers the runner's own constructor installed, which
    // is why the runner introduces itself last.
    const queued = this.pending
    this.pending = []
    for (const m of queued) this.onInput(m.id, m.f, m.p)
  }

  /**
   * The relay keeps the round, and it is the relay because it is the host.
   *
   * Read by `LockstepRunner`'s constructor, which is what makes a rejoin work
   * without the front end having to know a rejoin exists. A guest answers
   * false: its archive would have exactly the holes its live table does, and a
   * tape with holes replays to a different frame from the one it claims.
   */
  get keepRound(): boolean { return this.mesh.isHost }

  /** Who the room considers still human in this round. Read by the election,
   *  which must not count a slot the room has already handed to the AI. */
  get liveIds(): ReadonlySet<string> { return this.live }

  /** Take a slot back after losing the link. The contract's own words. */
  rejoin(): Promise<Result<void>> {
    if (!this.rejoinWith) return Promise.resolve({ ok: false, error: 'noround' })
    return this.rejoinWith()
  }

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
        if (!this.live.has(who)) return
        if (this.status === 'rejoining') {
          // No runner to hand it to yet, or one that is about to be replaced.
          if (this.pending.length < 2000) this.pending.push({ id: who, f: msg.f, p: msg.p >>> 0 })
          return
        }
        this.onInput(who, msg.f, msg.p >>> 0)
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
      case 'live': {
        if (msg.r !== this.round) return
        this.live.add(msg.id)
        this.onRoundLive(msg.id, msg.f)
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

  /**
   * Host only: tell the room a slot is a PERSON again from `frame`.
   *
   * THE REVERSE OF A DROP AND SENT TO EVERYBODY, the returning player
   * included. Sending it only to the room would leave the one client that has
   * to start publishing inputs for that frame as the one client that does not
   * know which frame it is -- and the room would then stall for ever waiting
   * for an input nobody had asked for.
   */
  announceLive(playerId: string, frame: number): void {
    this.live.add(playerId)
    this.mesh.broadcast({ t: 'live', r: this.round, id: playerId, f: frame })
    this.onRoundLive(playerId, frame)
  }

  /** Host only: tell the room the round is void. */
  announceDesync(frame: number): void {
    this.mesh.broadcast({ t: 'desync', r: this.round, f: frame })
  }

  /** Repair traffic, addressed. The service builds these; the transport only
   *  stamps the round and puts them on the right wire. */
  post(to: string, msg: Wire): boolean { return this.mesh.send(to, msg) }
  shout(msg: Wire): number { return this.mesh.broadcast(msg) }

  /**
   * The worst round trip in the room.
   *
   * On the host this is the TWO-HOP worst (see `StarMesh.worstPathMs`), which
   * is the number the HUD's connection pip should be showing: it is what an
   * input actually costs in this room, not what the host's own link costs.
   */
  get worstPingMs(): number {
    const own = Math.round(this.mesh.worstPathMs(UNKNOWN_PING_MS))
    // A GUEST TAKES THE HOST'S NUMBER WHEN IT IS BIGGER, because a guest's own
    // is its single leg and the room's worst path is a sum of two. Taking the
    // larger rather than always the published one keeps the pip honest for a
    // guest whose own link has just got worse and whose host has not said so
    // yet -- the direction that matters, since an optimistic pip is the one
    // that makes a stalling race look unexplained.
    if (this.mesh.isHost || this.publishedWorstMs === null) return own
    return Math.max(own, Math.round(this.publishedWorstMs))
  }

  /** How many of this client's open links ICE put through a TURN relay. The
   *  number that is billed, which is not the number of relays offered. */
  get relayedLinks(): number { return this.mesh.relayCount }

  dispose(): void { this.disposed = true; this.pending = [] }
}

/**
 * Re-exported so callers of this module can name it without reaching past
 * the service. The type and the whole argument for it live in net/types.ts,
 * because a resume packet is a wire format and wire formats belong in the
 * contract -- not in whichever implementation happened to need one first.
 */
export type { RoundResume }


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

/** The repair in progress. One per dead host; never two at once. */
interface Migration {
  /** Who every survivor independently elected. */
  newHostId: string
  isLocal: boolean
  /** The host this is replacing, so a late letter from it can be ignored. */
  deadHostId: string
  startedAt: number
  /** Survivors the new host is waiting for, not counting itself. */
  expected: number
  /** Digests received, keyed by sender. New host only. */
  got: Map<string, { frame: number; rows: TapeRow[]; std: readonly SeriesStanding[] }>
  /** True once the cut has been published (or received). */
  settled: boolean
  /**
   * True once we KNOW the host is gone rather than merely unreachable.
   *
   * THE DISTINCTION THE STAR CANNOT MAKE ON ITS OWN. A guest holds one link,
   * so "the host died" and "my connection died" are the same observation --
   * and acting on the wrong one produces a guest that promotes itself to host
   * and races on alone while the real room races on without it. Two races,
   * both convinced they are the room, and the player in the smaller one
   * finishes a race nobody else was in.
   *
   * Two things can set it, and either is enough:
   *   - the ENDPOINT says so (`SignalClient.hostState`), which is
   *     authoritative because it hears from everybody;
   *   - ANOTHER SURVIVOR's digest arrives, because two clients independently
   *     losing the same host at the same moment is the host.
   *
   * The second is what keeps a three-player migration fast; the first is the
   * only evidence available in a two-player room, and it costs the endpoint's
   * staleness window.
   */
  confirmed: boolean
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

  /**
   * The packet the round now running started from, or null between rounds.
   *
   * KEPT BECAUSE MIGRATION AND REJOIN BOTH NEED IT AND NEITHER CAN ASK FOR IT.
   * The election reads `grid` -- the one object every client is guaranteed to
   * hold identically -- and a returning client needs the whole packet to
   * rebuild a race the room will agree with. The host that had it is exactly
   * the party that is not there any more, so every client keeps its own copy.
   */
  private roundPacket: RaceStartPacket | null = null
  /** The repair in progress, or null. */
  private migration: Migration | null = null
  private migrationTimer: ReturnType<typeof setInterval> | null = null
  /** ICE servers for this session, resolved once. See `webrtc.resolveIce`. */
  private ice: Promise<RTCIceServer[]> | null = null
  /** A rejoin in flight, so a second call does not open a second link. */
  private rejoining: Promise<Result<void>> | null = null
  /** Chunks of a `tape` arriving out of a returning client's own order. */
  private tapeParts: { rows: TapeRow[]; hand: HandoverWire[]
    packet: RaceStartPacket | null; frame: number; got: Set<number>; n: number } | null = null
  /** Set while this client believes it is racing, so a lost host is a
   *  migration rather than a closed room. */
  private get racing(): boolean { return this.roundTransport !== null }

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
  /**
   * The ICE servers this session dials with, resolved once.
   *
   * ASKED FOR BEFORE THE FIRST MESH AND NEVER AGAIN, because a relay
   * credential is minted with a TTL and asking per connection would be one
   * request per peer per round for an answer that does not change. `resolveIce`
   * caches across services as well, and it NEVER REJECTS -- a relay provider
   * having a bad afternoon falls through to STUN, which is exactly the build
   * that ships today.
   */
  private iceResolved: RTCIceServer[] | null = null

  private ensureIce(): Promise<RTCIceServer[]> {
    if (!this.ice) {
      this.ice = resolveIce({
        servers: this.opts.iceServers ?? null,
        fetchImpl: this.opts.fetchImpl,
        // The mailbox and the credential mint are the same endpoint, so a
        // probe that points one somewhere else points both.
        endpoint: this.opts.endpoint,
      }, this.now()).then((v) => { this.iceResolved = v; return v })
    }
    return this.ice
  }

  /** What the last resolve produced, for a mesh rebuilt mid-race with no time
   *  to await anything. Null before the first resolve, which the mesh reads as
   *  "use the defaults". */
  private get iceNow(): RTCIceServer[] | undefined {
    return this.iceResolved ?? this.opts.iceServers ?? undefined
  }

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
    await this.ensureIce()
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
    await this.ensureIce()
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
      iceServers: this.iceNow,
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
    this.pingTimer = setInterval(() => {
      // A DEAD WIRE THAT NEVER FIRED A STATE CHANGE. `PeerLink.dead` is
      // `SILENCE_MS` with not even a ping arriving, on a channel the browser
      // has not got round to calling failed -- which is what a laptop lid or a
      // train tunnel looks like, and which produces no callback at all. Mid
      // race that is a host to migrate away from; the one-second tick is the
      // only thing already looking.
      if (this.racing && !this.migration && !this.isHost
        && this.roundTransport?.status === 'up') {
        const host = this.mesh?.get(this.record?.hostId ?? '')
        if (host?.dead) this.beginMigration('the host went silent')
      }
      if (this.room) this.publish()
    }, 1000)
  }

  /** The roster from the endpoint. The host uses it to learn who to expect. */
  private absorb(rec: LobbyRecord | null): void {
    if (this.disposed || !this.record) return
    if (!rec) return
    /**
     * MID-RACE, A LOST HOST IS A MIGRATION AND NOT A CLOSED ROOM.
     *
     * Three things the directory can say arrive here and all three used to
     * mean the same thing -- the room is over:
     *
     *   status 'closed'   the host said goodbye and nobody was racing
     *   hostGone          the host said goodbye and somebody WAS racing, so
     *                     the endpoint kept the row for us to claim
     *   hostId changed    another survivor's claim landed before ours
     *
     * The second and third are new and exist only because of this feature.
     * The first still ends the room when there is no race on -- there is
     * nothing to save -- and starts a migration when there is, because the
     * survivors are all stopped at an identical known frame and that is the
     * one circumstance in which a peer-to-peer room can outlive its host.
     */
    if (rec.hostGone === true && this.racing) { this.beginMigration('the host said goodbye'); return }
    if (rec.status === 'closed' && !this.isHost) {
      if (this.racing) { this.beginMigration('the directory closed the room'); return }
      this.closed('hostLeft')
      return
    }
    if (rec.hostId !== this.record.hostId && rec.hostId !== this.playerId && this.racing
      // NEVER BACK TO THE ONE WE ARE REPLACING. The record keeps naming the
      // dead host until somebody's claim lands, so without this guard a
      // survivor that had already elected a replacement was walked straight
      // back to the tab it had just watched close -- and then, on the next
      // poll, forward again. The probe caught it as two `hostChange` events in
      // a row going opposite ways.
      && !(this.migration && rec.hostId === this.migration.deadHostId)) {
      // ANOTHER SURVIVOR WON THE CLAIM. The endpoint is the only arbiter this
      // architecture has, so its answer beats our own election -- and
      // re-pointing costs one mesh rebuild, which is what we were doing
      // anyway.
      this.adoptHost(rec)
      return
    }
    this.record = {
      ...rec,
      code: rec.code ?? this.record.code,
      // A repair keeps the host it elected until somebody's claim lands. The
      // directory goes on naming the dead one for `HOST_CLAIM_AFTER_MS`, and
      // taking that at face value walks a survivor back to a closed tab.
      ...(this.migration ? { hostId: this.record.hostId, hostName: this.record.hostName } : {}),
    }
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
    /**
     * AND A RACING HOST KEEPS BEATING, which this line used to undo.
     *
     * `beginRound` puts the host on `POLL_RACE_MS` so that `seenAt` is fresh
     * enough for a survivor to tell a dead host from a slow one -- and then
     * the very next poll came through here and dropped it back to the
     * ten-second heartbeat, because a racing lobby is not "listening". The
     * consequence was subtle and complete: a guest whose OWN link had failed
     * watched the host's quiet time climb to ten seconds, concluded the host
     * was dead, and elected itself. The probe caught it as a rejoin refused
     * with `host` -- the client had promoted itself out of the room it was
     * trying to get back into.
     */
    const relaying = this.isHost && this.racing
    this.signal.rate = pending ? 'fast' : relaying ? 'race' : listening ? 'open' : 'idle'
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
      const m = this.migration
      if (m && !m.isLocal && peer === m.newHostId) {
        // THE FIRST THING A SURVIVOR SAYS TO ITS NEW HOST. Not "hello" and
        // then a request for instructions: the digest is everything the
        // repair needs from this client, so the whole exchange is one message
        // each way rather than two round trips through a repair that is
        // already being measured against a budget.
        this.sendDigest()
        this.tickMigration()
        return
      }
      if (m && m.isLocal) {
        // Tell a survivor who it is talking to, in case its own election said
        // somebody else. It answers with a digest.
        this.mesh?.send(peer, { t: 'host', id: this.playerId, name: this.playerName } satisfies Wire)
        this.tickMigration()
      }
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
      /**
       * A REPAIR IN PROGRESS OWNS ITS OWN ENDING.
       *
       * `connectTimeoutMs` fires at twelve seconds on a link ICE may still be
       * about to bring up, and a migration is allowed thirty. Closing the room
       * here would end the race two thirds of the way through a budget that
       * was still running, with `error` and no sentence -- which the probe
       * caught: a failed migration reported "error" and an undefined detail
       * instead of the paragraph `failMigration` writes.
       */
      if (this.migration || this.roundTransport?.status === 'rejoining') {
        console.warn(`net: ${peer}'s link ${failure ?? 'died'} during a repair`)
        this.publish()
        return
      }
      if (!this.isHost && peer === this.record?.hostId) {
        // UNLESS THERE IS A RACE ON, in which case the room is exactly what
        // can be saved: every survivor is stopped at an identical known frame
        // and one of them is about to be the host. This is the commonest way
        // a migration starts -- a closed tab takes the channel down inside a
        // hundred milliseconds.
        if (this.racing) {
          this.beginMigration(`the link to the host ${failure ?? 'died'}`)
          return
        }
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
  // HOST MIGRATION
  //
  // The sequence, once, in order, because it is easier to check a list than to
  // reassemble one from six methods:
  //
  //   1. the host's link dies, or its record says it said goodbye
  //   2. every survivor PAUSES its runner (not a stall: see `pause`)
  //   3. every survivor elects the same new host from the grid -- alone
  //   4. the mesh is torn down and rebuilt around the new hub; guests offer
  //      through the same signalling mailbox they joined through
  //   5. the new host CLAIMS the directory row, so the lobby does not vanish
  //      from the browser mid-race
  //   6. each survivor sends the new host its digest: the frame it stepped,
  //      every cell of the input table it holds, and its copy of the standings
  //   7. the new host takes the cut -- resume frame, AI handovers, standings --
  //      and broadcasts the union
  //   8. everybody absorbs it, back-fills its own row into the hole the
  //      migration left, and un-pauses
  //
  // Step 7 is where all the reasoning is. See `takeTheCut`.
  // -------------------------------------------------------------------------

  /**
   * The host is gone. Start the clock.
   *
   * IDEMPOTENT AND CHEAP TO CALL, because it is reached from four places that
   * are all correct and none of which can see the others: the peer link
   * failing, the ping timer noticing a dead wire, the directory saying the
   * host said goodbye, and a `closed` message that arrived mid-race. A
   * migration that started twice would elect twice and rebuild the mesh under
   * its own half-open connections.
   */
  private beginMigration(reason: string): void {
    if (this.disposed || this.migration || !this.racing) return
    const packet = this.roundPacket
    const rec = this.record
    const transport = this.roundTransport
    if (!packet || !rec || !transport) return

    const deadHostId = rec.hostId
    const elected = electHost(packet.grid, deadHostId, transport.liveIds)
    if (!elected) {
      // NOBODY LEFT TO ELECT. Every other human slot has already been handed
      // to the AI, so this client is the only person in the race and there is
      // no room to migrate -- which is a different sentence from a failed
      // migration and gets one.
      this.failMigration('The host left and there is nobody else in the race.')
      return
    }
    const isLocal = elected === this.playerId
    console.warn(`net: host ${deadHostId} is gone (${reason}); `
      + `electing ${elected}${isLocal ? ' (us)' : ''}`)

    this.migration = {
      newHostId: elected,
      isLocal,
      deadHostId,
      startedAt: this.now(),
      // Every human slot except the dead host and ourselves, counted from the
      // GRID rather than from the room: the room's member list is maintained
      // by a host that is not there any more.
      expected: packet.grid.filter((s) => s.playerId
        && s.playerId !== deadHostId
        && s.playerId !== this.playerId
        && transport.liveIds.has(s.playerId)).length,
      got: new Map(),
      settled: false,
      confirmed: false,
    }
    transport.status = 'migrating'
    transport.peer?.hold(true, migrationLine(MIGRATION_BUDGET_MS))

    // THE MESH GOES FIRST. Every link this client holds went through the dead
    // hub, so there is nothing in it worth keeping, and `StarMesh` decides
    // host-ness from the id it was built with -- which is the id that has to
    // change.
    this.rebuildMesh(elected)
    this.record = { ...rec, hostId: elected, hostName: this.nameOf(elected) }
    this.isHost = isLocal
    // The role has moved as far as this client is concerned, whatever happens
    // next: `onHostChange` is about who to ask, not about who has answered.
    transport.rehost(this.mesh!)
    transport.onHostChange(elected)

    this.signal.rate = 'fast'
    if (isLocal) void this.claimRow(deadHostId)
    else this.mesh?.connect(elected)
    /**
     * ASK WHO ACTUALLY WENT AWAY, AND DIAL WHILE WE WAIT.
     *
     * Dialling costs nothing if we are wrong: an offer to a peer that is not
     * expecting one is a letter nobody reads. Taking the CUT while we are
     * wrong costs the race, so that waits for `confirmed`.
     */
    void this.confirmHostGone(this.migration)
    this.tickMigration()
    if (this.migrationTimer === null) {
      // FOUR TIMES A SECOND, which is about the countdown and nothing else:
      // a number on screen that jumps a whole second at a time reads as a
      // stutter, and one that never moves reads as a hang.
      this.migrationTimer = setInterval(() => this.tickMigration(), 250)
    }
  }

  /** Torn down and rebuilt around a new hub. The old links all went through
   *  the dead one, so there is nothing to preserve. */
  private rebuildMesh(hostId: string): void {
    const old = this.mesh
    this.mesh = new StarMesh({
      selfId: this.playerId,
      hostId,
      iceServers: this.iceNow,
      shape: this.opts.shape,
      makeConnection: this.opts.makeConnection,
      now: this.now,
      connectTimeoutMs: this.opts.connectTimeoutMs,
      signal: (to, kind, body) => this.signal.send(to, kind, body),
    })
    this.mesh.onMessage = (from, msg) => this.receive(from, msg as Wire)
    this.mesh.onPeerState = (peer, state, failure) => this.peerState(peer, state, failure)
    old?.dispose()
  }

  /**
   * Find out whether it was the host that went away or us.
   *
   * ASKED OF THE ENDPOINT, WHICH IS THE ONLY PARTY THAT HEARS FROM EVERYBODY.
   * Until it answers, the repair is held at the point just before it becomes
   * irreversible: the mesh has been rebuilt and the offers are out, so a
   * confirmed migration completes immediately, and a refuted one costs one
   * wasted handshake and nothing else.
   *
   * `unknown` IS EVIDENCE AND IT POINTS AT US. If we cannot reach a serverless
   * endpoint on the public internet, the thing that is broken is much more
   * likely to be our own connection than the host's -- so we keep asking
   * rather than promoting ourselves on the strength of not being able to see
   * anything. The migration budget is what bounds the asking.
   */
  private async confirmHostGone(m: Migration): Promise<void> {
    /**
     * WATCH THE QUIET TIME, DO NOT SAMPLE IT ONCE.
     *
     * The first cut asked "is the host's last heartbeat recent?" and abandoned
     * the migration when it was -- which is right for a guest whose own wifi
     * blipped and catastrophic one second after a host crashes, because a
     * crashed host's last heartbeat is recent too. The probe caught it
     * immediately: every survivor of a genuinely dead host decided its own
     * connection was at fault and tried to rejoin a tab that was gone.
     *
     * The discriminator is the DERIVATIVE. A racing host heartbeats every
     * `POLL_RACE_MS`, so a live one's quiet time drops back to near zero
     * within a beat; a dead one's only ever grows. So: sample, and conclude
     * "it was us" only when the number comes DOWN.
     */
    let prev = -1
    while (!this.disposed && this.migration === m && !m.confirmed) {
      const { state, quietMs } = await this.signal.hostState()
      if (this.migration !== m || m.confirmed) return
      if (state === 'gone') { m.confirmed = true; this.tickMigration(); return }
      if (state === 'closed') {
        this.failMigration('The lobby closed while the room was trying to '
          + 'find a new host. The race is over.')
        return
      }
      if (state === 'quiet') {
        // A HEARTBEAT LANDED AFTER WE STARTED WORRYING. The host is there and
        // we are the ones who cannot be reached.
        if (prev >= 0 && quietMs < prev) { this.abandonMigration(); return }
        // Two missed beats and still climbing is enough to act on, well ahead
        // of the endpoint's own claim window -- the claim is about the
        // directory row and can afford to be slow; the race cannot.
        if (quietMs >= HOST_SILENT_MS) { m.confirmed = true; this.tickMigration(); return }
        prev = quietMs
      }
      if (this.now() - m.startedAt >= MIGRATION_BUDGET_MS) return
      await new Promise((r) => setTimeout(r, CONFIRM_POLL_MS))
    }
  }

  /**
   * The host is fine. It was our own link.
   *
   * SO THIS IS A REJOIN AND NOT AN ELECTION, and the difference is everything:
   * the room is still racing under the host it started with, our slot is being
   * driven by the AI, and the repair is to go and get it back rather than to
   * declare ourselves in charge of a race we are not in.
   */
  private abandonMigration(): void {
    const m = this.migration
    if (!m) return
    console.warn('net: the host is still there — it was our own link; rejoining instead')
    if (this.migrationTimer !== null) {
      clearInterval(this.migrationTimer)
      this.migrationTimer = null
    }
    this.migration = null
    const t = this.roundTransport
    if (t) { t.status = 'rejoining'; t.onMigration(null) }
    this.isHost = false
    if (this.record) {
      this.record = { ...this.record, hostId: m.deadHostId, hostName: this.nameOf(m.deadHostId) }
    }
    t?.onHostChange(m.deadHostId)
    void this.doRejoin()
  }

  /**
   * The new host takes the directory row.
   *
   * RETRIED, because the endpoint will refuse it until the old host has been
   * quiet for `HOST_CLAIM_AFTER_MS` -- it has no way to tell a dead host from
   * a slow one, and refusing is the right answer to that ambiguity. THE RACE
   * DOES NOT WAIT FOR THIS: the survivors dialled the elected host directly in
   * `beginMigration` and are already repairing. What the claim buys is the
   * lobby not disappearing from the browser, and `LOBBY_TTL_MS` (45s) is
   * comfortably longer than the claim takes.
   */
  private async claimRow(was: string): Promise<void> {
    for (let attempt = 0; attempt < 12 && !this.disposed; attempt++) {
      const res = await this.signal.claimHost(this.playerName, was)
      if (res === 'ok') {
        this.signal.update('racing', this.round)
        return
      }
      if (res === 'lost') {
        // Somebody else's claim stuck. The endpoint is the only arbiter there
        // is, so its answer wins over our own election -- and `absorb` will
        // pick the winner's id up on the next poll and re-point the mesh.
        console.warn('net: another survivor claimed the room first')
        return
      }
      await new Promise((r) => setTimeout(r, 2500))
    }
  }

  /** A survivor's digest, on its first open link to the new host. */
  private sendDigest(): void {
    const m = this.migration
    const t = this.roundTransport
    if (!m || !t || m.isLocal) return
    const d = t.peer?.digest()
    if (!d) return
    t.post(m.newHostId, {
      t: 'mine', r: t.round, f: d.frame, sl: this.localSlot(),
      rows: d.rows, std: this.standings,
    })
  }

  /**
   * THE CUT. Everything the repair actually decides, in one place.
   *
   * ===========================================================================
   * THE RESUME FRAME
   *
   * R = the FURTHEST frame any survivor stepped. Not the nearest, and not an
   * average: nobody can un-step a frame, so the only frame the whole room can
   * be brought to is the one the leader is already at.
   *
   * Bringing the others up needs history, and the history is bounded. A client
   * that stepped R held every live slot's input for R; each of those was
   * published by its owner when that owner's own play head was at R - d - 1
   * (`targetFrame` is frame + 1 + d, and nobody publishes for a frame they
   * have not reached). So NO SURVIVOR IS MORE THAN d + 1 FRAMES BEHIND R, and
   * `inputDelayFor` clamps d at 12 -- thirteen frames, 217ms, worst case ever.
   * What is actually sent is the whole retained window (4d frames, what
   * `commit` keeps anyway), because the difference is a few hundred integers.
   *
   * ===========================================================================
   * INPUTS THE DEAD HOST RELAYED TO SOME AND NOT OTHERS
   *
   * This is the real hazard, and it is why every survivor sends its WHOLE
   * table rather than just its own row. The host was a relay: it could have
   * forwarded slot 5's input for frame 812 to one guest and died before
   * forwarding it to another. Those cells belong to a player who may also be
   * gone, so "let the owner republish" does not cover it.
   *
   * The union does. Any cell any survivor holds, every survivor ends up
   * holding -- and the union is WELL DEFINED because `(slot, frame)` is
   * immutable everywhere: `LockstepScheduler.receive` refuses to overwrite, so
   * two clients cannot hold different values for one cell and a merge can
   * never have to choose.
   *
   * ===========================================================================
   * THE AI HANDOVER FOR EVERY SLOT THAT DID NOT MAKE IT
   *
   * The dead host, and anybody who failed to reconnect, become AI from ONE
   * PAST THE HIGHEST FRAME THE UNION HOLDS FOR THEM -- which is exactly
   * `dropFrameFor`'s rule, applied to the merged table instead of to one
   * client's. It is safe for the same reason and for one more: the union holds
   * every live slot through R (the client that stepped R needed them all), so
   * the handover is never earlier than R + 1 and nobody has stepped past it.
   *
   * It also means the dead host's car finishes its corner on the host's own
   * last steering, which is the behaviour a drop already has.
   *
   * ===========================================================================
   * THE STANDINGS
   *
   * types.ts asks for these to be cross-checked rather than trusted from one
   * copy, and a series makes that worth doing: a wrong table is not a wrong
   * round, it is wrong rounds 3, 4 and 5 as well. Every guest has the table
   * via `onRoom`, so the new host takes the one the most survivors agree on
   * and says so when they do not.
   */
  private takeTheCut(): void {
    const m = this.migration
    const t = this.roundTransport
    if (!m || !t || m.settled || !m.isLocal) return
    const mine = t.peer?.digest()
    if (!mine) return
    m.settled = true

    let frame = mine.frame
    const rows: TapeRow[] = [...mine.rows]
    const tally = new Map<string, { n: number; std: readonly SeriesStanding[] }>()
    const count = (std: readonly SeriesStanding[]): void => {
      const key = JSON.stringify(std)
      const e = tally.get(key)
      if (e) e.n++
      else tally.set(key, { n: 1, std })
    }
    count(this.standings)
    for (const d of m.got.values()) {
      if (d.frame > frame) frame = d.frame
      rows.push(...d.rows)
      count(d.std)
    }

    let best: { n: number; std: readonly SeriesStanding[] } | null = null
    for (const e of tally.values()) if (!best || e.n > best.n) best = e
    if (tally.size > 1) {
      console.warn(`net: survivors disagree about the standings (${tally.size} versions); `
        + `taking the one ${best?.n} of ${m.got.size + 1} of us hold`)
    }
    if (best) this.standings = [...best.std]

    // Everyone who did not make it back is handed to the AI, from the highest
    // frame the UNION can speak for them. Announced as an ordinary drop, so a
    // client that hears only this and none of the rest still ends up with the
    // same toggle list as everybody else.
    const absent: string[] = []
    for (const s of this.roundPacket?.grid ?? []) {
      if (!s.playerId) continue
      if (s.playerId === this.playerId) continue
      if (s.playerId === m.deadHostId) { absent.push(s.playerId); continue }
      if (!t.liveIds.has(s.playerId)) continue
      if (!m.got.has(s.playerId)) absent.push(s.playerId)
    }
    // THE NEW HOST TAKES THE REFEREE'S CHAIR BEFORE IT PUBLISHES, not after.
    // `cut` hands absent slots to the AI, which is a decision only an
    // authority may make -- and the first thing this client does after
    // resuming is judge hashes and propose drops for a room that now has
    // nobody else to do either.
    t.peer?.becomeHost()
    const hand = t.peer?.cut(frame, rows, absent) ?? []

    t.shout({ t: 'resume', r: t.round, f: frame, rows, hand, std: this.standings })
    this.finishMigration(frame, absent)
  }

  /** Everybody, including the new host, once the cut is in. */
  private finishMigration(frame: number, absent: readonly string[]): void {
    const m = this.migration
    const t = this.roundTransport
    if (!m || !t) return
    if (this.migrationTimer !== null) {
      clearInterval(this.migrationTimer)
      this.migrationTimer = null
    }
    const took = this.now() - m.startedAt
    console.warn(`net: migrated to ${m.newHostId} in ${took}ms; resumed at frame ${frame}`
      + (absent.length > 0 ? `; ${absent.length} did not come back` : ''))
    this.migration = null
    t.status = 'up'
    t.onMigration(null)
    // THE ROOM'S OWN IDEA OF WHO THE HOST IS MOVES TOO. `LobbyMember.isHost`
    // is what the room screen draws the crown on and what `LobbyRoom` hands
    // the UI; leaving it on a player who has closed their tab means a room
    // with no host in it, which is what the probe photographed.
    this.members = this.members
      .filter((x) => x.playerId !== m.deadHostId)
      .map((x) => ({ ...x, isHost: x.playerId === m.newHostId }))
    // A GUEST'S MEMBER LIST IS WHATEVER THE OLD HOST LAST PUBLISHED, and the
    // old host never published the new one as a host. Without this a survivor
    // ends the repair in a room with nobody in the host's chair, which is what
    // `LobbyRoom.members` is read for -- the probe photographed a room whose
    // host was null while the race ran on perfectly well.
    if (!this.members.some((x) => x.playerId === m.newHostId)) {
      this.members.unshift({
        playerId: m.newHostId, name: this.nameOf(m.newHostId), avatarId: '',
        chassisId: CHASSIS[0].id, pilotId: PILOTS[0].id,
        ready: false, isHost: true, pingMs: 0, connecting: false,
        joinedAt: 0,
      })
    }
    if (this.isHost) { this.pushRoom(); this.signal.update('racing', this.round) }
    this.signal.rate = this.isHost ? 'race' : 'idle'
    this.publish()
  }

  /** The countdown, and the deadline. */
  private tickMigration(): void {
    const m = this.migration
    const t = this.roundTransport
    if (!m || !t) return
    const left = MIGRATION_BUDGET_MS - (this.now() - m.startedAt)
    const connected = m.isLocal ? m.got.size : (this.mesh?.open.length ?? 0)
    // The line on screen, refreshed every tick so the number moves. See
    // `LockstepRunner.beforeStep`'s note on why it goes through `waitingFor`.
    t.peer?.hold(true, migrationLine(left))
    t.onMigration({
      // Already recorded as deadHostId; the contract names it from the
      // screen's point of view, which is the host that LEFT.
      previousHostId: m.deadHostId,
      newHostId: m.newHostId,
      isLocal: m.isLocal,
      remainingMs: Math.max(0, left),
      connected,
      expected: m.isLocal ? m.expected : 1,
    })
    if (m.isLocal && m.confirmed && m.got.size >= m.expected) { this.takeTheCut(); return }
    if (left > 0) return
    if (!m.confirmed) {
      // THE BUDGET RAN OUT WITHOUT AN ANSWER, which means we could not reach
      // the host AND could not reach the endpoint. That is our own connection
      // and the player deserves to be told so rather than to be told the host
      // left, which we never established.
      this.failMigration('Lost contact with the room and could not reach the lobby '
        + 'service either, so there was no way to tell whether the host had gone or '
        + 'this connection had. The race went on without us.')
      return
    }

    /**
     * THE BUDGET IS UP, AND THE TWO SIDES OF IT ARE DIFFERENT SENTENCES.
     *
     * On the NEW HOST: whoever arrived is in the race, whoever did not is
     * handed to the AI. That is the same answer the ordinary drop policy gives
     * a peer whose wire is gone, and refusing to carry on would punish the
     * people who reconnected for the ones who could not.
     *
     * On a GUEST that could not reach the new host: our race is over, and it
     * is over for us alone -- everybody else is still racing. Saying "the
     * connection failed" would be true and useless; naming who we could not
     * reach is what tells the player whether to blame their wifi.
     */
    if (m.isLocal) {
      if (m.got.size === 0 && m.expected > 0) {
        this.failMigration('Nobody could reconnect after the host left. '
          + 'The race is over; the standings are as they were.')
        return
      }
      this.takeTheCut()
      return
    }
    this.failMigration(`Could not reach ${this.nameOf(m.newHostId)}, `
      + 'who took over when the host left. '
      + `Thirty seconds was the whole budget and the race went on without us.`)
  }

  /** The repair did not work. Say exactly what happened, then end the round. */
  private failMigration(detail: string): void {
    if (this.migrationTimer !== null) {
      clearInterval(this.migrationTimer)
      this.migrationTimer = null
    }
    this.migration = null
    const t = this.roundTransport
    if (t) { t.status = 'down'; t.onMigration(null) }
    console.warn('net: migration failed —', detail)
    this.lastFailure = detail
    this.onFailure(detail)
    // THE RACE HAS TO COME DOWN, NOT JUST THE ROOM. `onClosed` reaches the
    // lobby screen; it does not reach the `Race` that is still on the player's
    // monitor. The runner's verdict does -- game/main.ts checks it every
    // frame and already knows how to put a round away that finished without
    // us. Set BEFORE the teardown, so it is read before the transport goes.
    this.roundTransport?.peer?.leave()
    this.closed('hostLeft', detail)
  }

  /** A survivor applying the new host's cut. */
  private applyResume(msg: Extract<Wire, { t: 'resume' }>): void {
    const m = this.migration
    if (!m || m.settled) return
    m.settled = true
    if (msg.std.length > 0) this.standings = [...msg.std]
    this.roundTransport?.peer?.applyCut(msg.f, msg.rows, msg.hand)
    this.finishMigration(msg.f, [])
  }

  /**
   * Another survivor's claim beat ours. Point at them instead.
   *
   * THE ENDPOINT IS THE TIEBREAK, and it is the only one available. Every
   * survivor elects locally and alone, which is fast and is right almost
   * always; the narrow case where two of them disagree (a drop the dying host
   * announced to one and not the other, inside the last few hundred
   * milliseconds of its life) is settled here, by the one piece of state
   * neither of them owns.
   */
  private adoptHost(rec: LobbyRecord): void {
    const t = this.roundTransport
    this.record = { ...rec, code: rec.code ?? this.record?.code ?? null }
    this.isHost = rec.hostId === this.playerId
    if (this.migration) {
      this.migration.newHostId = rec.hostId
      this.migration.isLocal = this.isHost
      this.migration.settled = false
      this.migration.got.clear()
    }
    this.rebuildMesh(rec.hostId)
    t?.rehost(this.mesh!)
    t?.onHostChange(rec.hostId)
    if (!this.isHost) this.mesh?.connect(rec.hostId)
    this.publish()
  }

  /** The display name for a peer id, falling back to the id so a sentence
   *  never has a hole in it. */
  private nameOf(id: string): string {
    const m = this.members.find((x) => x.playerId === id)
    if (m) return m.name
    const s = this.roundPacket?.grid.find((g) => g.playerId === id)
    return s?.name ?? id
  }

  private localSlot(): number {
    return this.roundPacket?.grid.find((g) => g.playerId === this.playerId)?.slot ?? -1
  }

  // -------------------------------------------------------------------------
  // REJOIN
  // -------------------------------------------------------------------------

  /**
   * Take a slot back after losing the link.
   *
   * THE SYMMETRY WITH A DROP IS THE WHOLE DIFFICULTY and it has two halves.
   *
   * The FRAME half is the one types.ts names: a drop is agreed on a frame so
   * that every client makes the same number of `stepAI` draws, and a rejoin
   * has exactly the same requirement in reverse. It is handled by
   * `announceLive`, by `LockstepScheduler.applyRestore` -- which is
   * `applyDrop` with the parity the other way round, deliberately the same
   * mechanism -- and by `REJOIN_LEAD_FRAMES`, which puts the handover far
   * enough ahead that the returning player's own inputs can arrive before it.
   *
   * The STATE half is the one that costs: the returning client has to be at
   * the same frame as everybody else before it can be given the wheel. It is
   * caught up by REPLAYING the round's inputs, because this sim's state is not
   * serialisable and its inputs are -- see `LockstepRunner.replay`.
   *
   * THEIR SLOT IS THEIRS FOR THE ROUND. Nobody else can take it: the grid was
   * fixed when the round started and a dropped slot is an AI driving a car
   * that still belongs to a person. That is what makes this possible at all.
   */
  private async doRejoin(): Promise<Result<void>> {
    if (this.rejoining) return this.rejoining
    const rec = this.record
    const packet = this.roundPacket
    const t = this.roundTransport
    if (!rec || !packet || !t) return { ok: false, error: 'noround' }
    /**
     * A PLAYER PRESSING REJOIN IS TELLING US SOMETHING WE COULD NOT WORK OUT.
     *
     * A guest holds one link, so it cannot tell a dead host from its own dead
     * connection; that is what `confirmHostGone` spends seconds establishing.
     * The person sitting in front of it usually CAN tell -- their wifi icon
     * went away, or it did not -- and asking to rejoin is them saying it was
     * theirs. So an unconfirmed migration gives way to an explicit rejoin
     * rather than refusing it, which is what the probe caught it doing: a
     * player who pressed the button while the room was still deciding got
     * `host` back and nothing happened.
     *
     * A CONFIRMED migration does not give way. By then the host really is
     * gone and there is nothing to rejoin; the repair in progress is the only
     * thing that can help, and interrupting it would cost the room its
     * elected replacement.
     */
    if (this.migration && !this.migration.confirmed) {
      this.abandonMigration()
      return this.rejoining ?? Promise.resolve({ ok: true, value: undefined })
    }
    if (this.migration) return { ok: false, error: 'migrating' }
    if (this.isHost) return { ok: false, error: 'host' }
    /**
     * ALREADY BACK IN IS NOT AN ERROR AND IS NOT A SECOND REJOIN.
     *
     * The link coming back starts one of these on its own, and a player who
     * then presses the button gets here while the first is finishing. Running
     * it again rebuilds the race a second time and makes the host announce a
     * second restore frame -- which the scheduler refuses (the slot is already
     * a person), so the visible damage is only a wasted circuit load. The
     * probe still caught it, as a car that read as AI because the check landed
     * between two handovers.
     */
    if (t.status === 'up' && t.liveIds.has(this.playerId)) return { ok: true, value: undefined }

    const run = (async (): Promise<Result<void>> => {
      t.status = 'rejoining'
      t.peer?.hold(true, 'your connection')
      this.tapeParts = null
      // THE SAME RE-HANDSHAKE MIGRATION USES, which is the contract's own
      // description of it: re-post the membership so the mailbox will carry
      // letters again, then offer. A slot held for us means the endpoint's
      // `join` recognises a rejoin rather than answering `full`.
      const back = await this.signal.join(rec.id)
      if (typeof back === 'string') {
        t.status = 'down'
        return { ok: false, error: back }
      }
      this.record = { ...back, code: back.code ?? rec.code }
      this.isHost = back.hostId === this.playerId
      this.rebuildMesh(back.hostId)
      t.rehost(this.mesh!)
      this.signal.rate = 'fast'
      this.mesh?.connect(back.hostId)
      const ok = await this.waitFor(() =>
        this.mesh?.get(back.hostId)?.state === 'open', MIGRATION_BUDGET_MS)
      if (!ok) {
        // A REJOIN THAT FAILS IS A RACE THAT IS OVER FOR US, and it has to say
        // so. The room is fine and is still racing our slot under the AI;
        // what has ended is our part in it. Left silent, this is a player
        // watching a frozen race with a spinner on it for ever -- which is
        // the one outcome the whole `LinkStatus` enum exists to avoid.
        t.status = 'down'
        const detail = `Could not get back to ${this.nameOf(back.hostId)} in `
          + `${Math.round(MIGRATION_BUDGET_MS / 1000)} seconds. Your car finished the `
          + 'round under the AI from the frame you went quiet.'
        this.lastFailure = detail
        this.onFailure(detail)
        // `unreachable` is its own reason in the contract for exactly this:
        // "the commonest peer-to-peer failure", and folding it into `error`
        // tells the player nothing they can act on.
        if (!this.ended) {
          this.ended = true
          t.peer?.leave()
          this.teardown()
          this.room = null
          this.onClosed('unreachable', detail)
          this.onRoom(null)
        }
        return { ok: false, error: 'unreachable' }
      }
      t.post(back.hostId, { t: 'back', r: t.round })
      /**
       * RESOLVES WHEN WE ARE ACTUALLY BACK IN, NOT WHEN WE HAVE ASKED.
       *
       * The host answers with the round's tape in several messages and then
       * with the frame our slot becomes a person again. Returning `ok` at the
       * moment the request went out would make `rejoin()` mean "a letter was
       * posted", and a caller that then let the race run would be racing a
       * stale world -- which is what the probe caught: the link came back, the
       * inputs started flowing, and the client carried on from a frame the
       * room had left behind three hundred frames earlier.
       */
      const done = await this.waitFor(() => t.status === 'up', MIGRATION_BUDGET_MS)
      if (!done) {
        t.status = 'down'
        const why = 'Reconnected, but the round could not be handed back. '
          + 'Your car finished it under the AI.'
        this.lastFailure = why
        this.onFailure(why)
        return { ok: false, error: 'noround' }
      }
      return { ok: true, value: undefined }
    })().finally(() => { this.rejoining = null })

    this.rejoining = run
    return run
  }

  /** Host side: somebody wants their slot back. */
  private handleBack(from: string, round: number): void {
    const t = this.roundTransport
    const packet = this.roundPacket
    if (!t || !packet || !this.isHost) return
    if (round !== t.round) {
      t.post(from, { t: 'noback', r: round, why: 'That round has already ended.' })
      return
    }
    const slot = packet.grid.find((g) => g.playerId === from)
    if (!slot) {
      t.post(from, { t: 'noback', r: t.round, why: 'You were not on the grid for this round.' })
      return
    }
    const tape = t.peer?.fullTape()
    if (!tape) {
      /**
       * THE ONE REJOIN THAT CANNOT BE HONOURED, AND IT IS WORTH NAMING.
       *
       * A host only holds the whole round if it was the host when the round
       * STARTED. A host that arrived through a migration has the union it was
       * handed and everything since -- which is enough to keep racing and not
       * enough to replay somebody in from frame one. Refusing with a sentence
       * beats granting a rejoin that lands the returning client at a different
       * frame from the room while both believe otherwise.
       */
      t.post(from, {
        t: 'noback', r: t.round,
        why: 'The host changed during this round, so nobody is holding it from the '
          + 'start any more. You can rejoin from the next round.',
      })
      return
    }
    /**
     * CHUNKED, AND THE PACKET RIDES ON THE FIRST ONE.
     *
     * The channel is ordered and reliable, so chunk `i` cannot overtake chunk
     * `i - 1` and none of them can go missing. They are still indexed, because
     * a returning client that gets four of five messages and then loses the
     * link again must be able to tell that it has an incomplete round rather
     * than replaying a tape with a hole in it -- which would put it at a
     * different frame from the room while believing it was at the same one.
     */
    const chunks = chunkTape(tape.rows, tape.frame)
    const n = Math.max(1, chunks.length)
    for (let i = 0; i < n; i++) {
      t.post(from, {
        t: 'tape', r: t.round, i, n, f: tape.frame,
        rows: chunks[i] ?? [], hand: tape.hand,
        ...(i === 0 ? { packet: { ...packet, localPlayerId: from } } : {}),
      })
    }
    /**
     * THE FRAME THEIR SLOT BECOMES A PERSON AGAIN, chosen the moment the tape
     * goes out rather than when the returning client says it is ready.
     *
     * It has to be ahead of the room, by `inputDelay` for the pipeline plus
     * `REJOIN_LEAD_FRAMES` for the replay and the flight -- see that constant.
     * Choosing it HERE rather than waiting for an acknowledgement is what
     * makes it one round trip instead of two: the returning client already
     * knows, from this announcement, which frame it must publish from.
     */
    const at = tape.frame + packet.inputDelay + REJOIN_LEAD_FRAMES
    t.announceLive(from, at)
  }

  /** Returning side: a chunk of the round. */
  private takeTape(msg: Extract<Wire, { t: 'tape' }>): void {
    const t = this.roundTransport
    if (!t || msg.r !== t.round) return
    if (!this.tapeParts) {
      this.tapeParts = { rows: [], hand: msg.hand, packet: null, frame: msg.f, got: new Set(), n: msg.n }
    }
    const p = this.tapeParts
    if (p.got.has(msg.i)) return
    p.got.add(msg.i)
    p.rows.push(...msg.rows)
    p.frame = Math.max(p.frame, msg.f)
    if (msg.hand.length > 0) p.hand = msg.hand
    if (msg.packet) p.packet = msg.packet
    if (p.got.size < p.n || !p.packet) return

    const handovers = new Map<string, readonly number[]>()
    for (const h of p.hand) handovers.set(h.id, h.f)
    this.tapeParts = null
    t.status = 'up'
    t.onResync({ packet: p.packet, rows: p.rows, handovers, frame: p.frame })
  }

  /** Poll a predicate. There is no event for "a data channel opened" that is
   *  not already routed into `peerState`, and a promise per link would be a
   *  second lifetime to get wrong. */
  private async waitFor(fn: () => boolean, ms: number): Promise<boolean> {
    const until = this.now() + ms
    while (this.now() < until && !this.disposed) {
      if (fn()) return true
      await new Promise((r) => setTimeout(r, 100))
    }
    return fn()
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
        if (typeof msg.worst === 'number' && this.roundTransport) {
          this.roundTransport.publishedWorstMs = msg.worst
        }
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
        // A HOST THAT SAYS GOODBYE MID-RACE IS STILL A MIGRATION. `leave()`
        // broadcasts this before the wire goes precisely so a guest gets the
        // right sentence rather than `error`; during a round the right
        // sentence is "hold on, we are electing somebody".
        if (this.racing && msg.reason === 'hostLeft') {
          this.beginMigration('the host left the room')
          return
        }
        this.closed(msg.reason)
        return

      // --- repair ----------------------------------------------------------
      case 'mine': {
        const m = this.migration
        const t = this.roundTransport
        if (!m || !m.isLocal || !t || msg.r !== t.round) return
        m.got.set(from, { frame: msg.f, rows: msg.rows, std: msg.std })
        // INDEPENDENT CONFIRMATION. Another survivor reached the same
        // conclusion about the same host, alone, and came here to say so. Two
        // clients cannot both have had their own link fail in the same second
        // in a way that also elected the same replacement, so this is the
        // host -- and it is available a great deal faster than the endpoint's
        // staleness window.
        m.confirmed = true
        // A survivor that came back is a survivor: put them back in the room
        // list so the new host's push names them.
        if (!this.members.some((x) => x.playerId === from)) {
          this.members.push({
            playerId: from, name: this.nameOf(from), avatarId: '',
            chassisId: CHASSIS[0].id, pilotId: PILOTS[0].id,
            ready: false, isHost: false, pingMs: null, connecting: false,
            joinedAt: this.now(),
          })
        }
        this.tickMigration()
        return
      }
      case 'resume': {
        const t = this.roundTransport
        if (!t || msg.r !== t.round) return
        if (from !== this.migration?.newHostId && from !== this.record?.hostId) return
        this.applyResume(msg)
        return
      }
      case 'host': {
        // Informational: the sender is telling us the role moved. Acted on
        // only when it names somebody we are not already pointed at.
        if (this.record && msg.id !== this.record.hostId && msg.id !== this.playerId) {
          this.adoptHost({ ...this.record, hostId: msg.id, hostName: msg.name })
        }
        return
      }
      case 'back':
        this.handleBack(from, msg.r)
        return
      case 'tape':
        this.takeTape(msg)
        return
      case 'noback': {
        const t = this.roundTransport
        if (t) t.status = 'down'
        console.warn('net: rejoin refused —', msg.why)
        this.lastFailure = msg.why
        this.onFailure(msg.why)
        return
      }
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
    this.mesh.broadcast({
      t: 'room', room,
      // The number only the host can know. See the `room` wire message.
      worst: Math.round(this.mesh.worstPathMs(UNKNOWN_PING_MS)),
    } satisfies Wire)
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
      series: rec?.series ?? { length: 1, trackIds: [], laps: 3, difficulty: DEFAULT_DIFFICULTY },
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
      series: rec?.series ?? { length: 1, trackIds: [], laps: 3, difficulty: DEFAULT_DIFFICULTY },
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
      /**
       * THE HOST LEAVING ENDS THE ROOM -- UNLESS A ROUND IS RUNNING.
       *
       * Everybody is told before the wire goes either way, because a guest who
       * only finds out from a dead connection gets `error` and the wrong
       * sentence. What they do with it differs: on the lobby screen there is
       * nothing to save and the room closes, and mid-race every survivor is
       * stopped at an identical known frame, which is the one circumstance in
       * which this room can outlive its host. `receive`'s `closed` case makes
       * that choice; this end only has to say goodbye promptly, and `bye`
       * below tells the endpoint the same thing so the row is claimable at
       * once rather than after `HOST_CLAIM_AFTER_MS`.
       */
      this.mesh?.broadcast({ t: 'closed', reason: 'hostLeft' } satisfies Wire)
    }
    await this.signal.bye()
    this.teardown()
    this.room = null
    this.onRoom(null)
  }

  /** True once the room has ended for this client, so the reason it ended
   *  cannot be overwritten by the tidying-up that follows. */
  private ended = false

  private closed(reason: 'hostLeft' | 'kicked' | 'error', detail?: string): void {
    if (this.ended) return
    this.ended = true
    this.room = null
    this.onClosed(reason, detail)
    this.onRoom(null)
  }

  private teardown(): void {
    if (this.pingTimer !== null) { clearInterval(this.pingTimer); this.pingTimer = null }
    if (this.migrationTimer !== null) {
      clearInterval(this.migrationTimer)
      this.migrationTimer = null
    }
    this.migration = null
    this.roundPacket = null
    this.tapeParts = null
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
        // The HOST's difficulty, resolved to a band here and published as a
        // number. See SeriesPlan.difficulty for why the name does not ride
        // the start packet alongside it.
        aiSkill: skillForSlot(this.record?.series.difficulty ?? DEFAULT_DIFFICULTY, slot),
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
    // `rejoin()` is a question about the ROOM -- a new peer connection through
    // the signalling mailbox -- and the transport owns neither, so the answer
    // is installed here rather than reached for there.
    this.roundTransport.rejoinWith = () => this.doRejoin()
    this.roundPacket = packet
    // A HOST THAT LEAVES DURING A ROUND HANDS THE ROOM ON, so the directory
    // row has to be fresh enough for the endpoint to tell a dead host from a
    // slow one inside the migration budget. See `POLL_RACE_MS`.
    this.signal.rate = this.isHost ? 'race' : 'idle'
    this.onStart(packet)
  }

  /**
   * THE HOST KEEPS THE WHOLE ROUND'S INPUTS AND EVERYBODY ELSE KEEPS A WINDOW.
   *
   * Read by game/main.ts (and by the probe) when it builds the round's runner:
   * `keepRound: liveLobby()?.archiveRound ?? false`. It is true only on the
   * host, because the host is the only party that holds every slot's row by
   * construction -- a guest's archive would have exactly the holes its live
   * table does, and a tape with holes replays to a different frame from the
   * one it claims to.
   */
  get archiveRound(): boolean { return this.isHost }

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
    this.roundPacket = null
    if (this.migrationTimer !== null) {
      clearInterval(this.migrationTimer)
      this.migrationTimer = null
    }
    this.migration = null
    this.signal.rate = this.isHost ? 'open' : 'idle'
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
