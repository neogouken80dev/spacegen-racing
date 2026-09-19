/**
 * SpaceGen Racing — THE WIRE. Peer connections, and the shape of the room.
 * ---------------------------------------------------------------------------
 *
 * ===========================================================================
 * TOPOLOGY: A STAR THROUGH THE HOST. THE ARGUMENT, IN FULL.
 *
 * Eight peers full-mesh is 28 connections; a star is 7. That difference is the
 * headline and it is NOT the reason.
 *
 * The reason is that DETERMINISTIC LOCKSTEP HAS NO PARTIAL-FAILURE STATE. To
 * step frame N I need every racer's input for frame N. If A cannot reach B,
 * then A cannot step, and neither can B -- even though both of them can reach
 * the other six perfectly. One failed edge out of 28 takes the whole race
 * down, and it takes it down in a way that has no sentence attached: "you are
 * connected to five of seven people" is not a thing a player can act on and not
 * a thing the race can degrade into. A mesh gives you 28 chances to produce
 * that state.
 *
 * In a star, connectivity is BINARY PER PLAYER. You reached the host or you did
 * not. If you did not, you are not in the race and we can say so in one
 * sentence, and the other seven race without you. That is a failure mode with a
 * UI and a recovery; the mesh's is neither.
 *
 * The secondary reasons all point the same way:
 *
 *   FAILURE PROBABILITY. NAT traversal failure is not independent per edge, it
 *   is mostly a property of one endpoint -- a peer behind a symmetric NAT fails
 *   against nearly everybody. Call that p per player, somewhere between 0.1
 *   and 0.2 without a TURN relay. A star needs 7 successes and loses one
 *   player per failure. A mesh needs all 28 and loses THE RACE per failure:
 *   at p = 0.15 per player, the chance that all eight players can reach all
 *   seven others is (0.85)^8 ~= 27%. Three lobbies in four would never start.
 *
 *   DROP CONSENSUS. When a peer goes quiet, every client must substitute AI for
 *   them ON THE SAME FRAME or they have diverged -- the desync detector would
 *   fire on the mechanism meant to prevent one. That needs a single authority.
 *   In a star there is one by construction: all traffic passes through the
 *   host, so the host is the only party that knows, and its announcement is
 *   the decision (see `lockstep.ts`, `dropFrameFor`). In a mesh it needs a
 *   voting protocol between seven parties who disagree about the facts.
 *
 *   MESSAGE VOLUME. Mesh at 60Hz with 8 players: every peer sends 7 and
 *   receives 7 per frame -- 3,360 datagrams/second across the room, 840 of
 *   them touching the slowest phone in it. Star: a guest sends 1 and receives
 *   up to 7; the host sends up to 42 and receives 7. The load moves onto the
 *   one machine that volunteered for it.
 *
 * WHAT IT COSTS, SAID PLAINLY.
 *
 *   1. GUEST-TO-GUEST LATENCY IS TWO HOPS. A's input reaches B via the host,
 *      so the worst path in the room is max over pairs of (ping(A,H)+ping(H,B))
 *      rather than max over pairs of ping(A,B). That inflates the lockstep
 *      input delay -- `inputDelayFor` reads the worst ping, and the host must
 *      publish the two-hop worst rather than the one-hop worst or the delay it
 *      buys is too small and the race stalls. See `worstPathMs`.
 *
 *      It does NOT create a host advantage in responsiveness: every client
 *      applies the SAME `inputDelay` to its own input, including the host, so
 *      the stick feels identical in every seat. Lockstep is fair by
 *      construction; what the host gets is robustness, not reaction time.
 *
 *   2. THE HOST LEAVING ENDS THE RACE. types.ts already calls this the
 *      unavoidable cost of peer-to-peer and accepts it. A star makes it
 *      unavoidable in one more way -- the host is also the relay -- so there
 *      is no host migration here and no pretence of one.
 *
 *   3. THE HOST'S UPLOAD. Up to 42 small messages per frame. At ~40 bytes each
 *      that is ~100 KB/s up, which is fine on any desktop connection and is
 *      the thing to measure before shipping an eight-player lobby on mobile
 *      data. Two players, which is what the probe runs, is ~3 KB/s.
 *
 * ===========================================================================
 * WHO OFFERS
 *
 * THE GUEST OFFERS AND THE HOST ANSWERS. Always, with no negotiation about who
 * is polite. Perfect negotiation exists to solve simultaneous offers between
 * two equal peers; a star has no equal peers, so the cheaper answer is to name
 * the roles up front and never have a collision to resolve.
 */
import { Rng } from '../sim/rng'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * STUN only. There is no TURN relay in this project and pretending otherwise
 * would be worse than not having one -- see `PeerFailure` for what the player
 * is told instead.
 *
 * Two servers rather than one because a single unreachable STUN host turns
 * every connection on a restrictive network into a `CONNECT_TIMEOUT_MS` wait
 * instead of a fast local-candidate success, and they cost nothing.
 */
export const DEFAULT_ICE: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
]

/**
 * How long a connection may take before we call it dead.
 *
 * TWELVE SECONDS, and the number is a compromise between two real timings.
 * ICE gathering with a reachable STUN server finishes in well under a second
 * on a desktop, but a phone on a bad mobile network can take three to four --
 * and connectivity checks then retry with backoff, so a connection that WILL
 * succeed can legitimately take eight. Below that and we would be hanging up
 * on people who were about to get in.
 *
 * Above it there is nothing to wait for: `iceConnectionState` normally reaches
 * `failed` on its own well inside this, and this timer exists only for the
 * case where it never reaches anything at all -- which happens, and is the
 * exact case that produces a permanent spinner if nobody counts.
 */
export const CONNECT_TIMEOUT_MS = 12_000

/** Round trip probe rate. Also the liveness heartbeat: see `silentFor`. */
export const PING_MS = 1000

/**
 * A link with no traffic at all for this long is presumed dead.
 *
 * Two missed pings plus slack. This is deliberately MUCH shorter than
 * `lockstep.ts`'s stall tolerance, because the two answer different questions:
 * this one is "is the wire up", and the answer being no is grounds to drop a
 * peer immediately rather than to keep waiting for data that is not coming.
 *
 * IT IS MEASURED IN TIME THIS PAGE WAS AWAKE FOR -- see `ping`. Silence during
 * a spell when our own main thread was blocked says nothing about the peer.
 */
export const SILENCE_MS = 2500

/**
 * How late the 1Hz ping timer has to be before we conclude that WE were the
 * thing that stopped, rather than the peer.
 *
 * FOUND BY tools/probe-netcode.mjs, and it is the kind of bug that only shows
 * up against a real browser. Starting a race compiles shaders, builds a track
 * mesh and spawns eight vehicles, and under a software rasteriser that blocked
 * the main thread for seconds at a time. No messages are processed while it is
 * blocked, so every peer's `lastRecvAt` goes stale, every link reports `dead`
 * on the first frame after the hitch, and the host ejects the entire room
 * before the lights go out -- for a hitch that was ITS OWN.
 *
 * A phone loading a circuit will do the same thing. So the ping timer doubles
 * as a liveness check on the page itself: if it comes back more than this late,
 * the silence it would have measured is forgiven and the count starts again.
 */
const BLOCKED_MS = PING_MS * 2.5

export type PeerState = 'new' | 'connecting' | 'open' | 'failed' | 'closed'

/**
 * Why a link did not come up. Each one is a different sentence to the player,
 * which is the only reason it is an enum.
 */
export type PeerFailure =
  /** ICE completed its checks and none of them worked: no path exists between
   *  these two networks without a relay. This is THE NAT case. */
  | 'nat'
  /** Nothing completed at all inside `CONNECT_TIMEOUT_MS`. Usually a signalling
   *  problem (letters not arriving) rather than a traversal one. */
  | 'timeout'
  /** The link was up and went away. Not a traversal failure. */
  | 'lost'
  /** The peer said goodbye. Not a failure at all; carried here so the caller
   *  has one channel to read. */
  | 'bye'

/** What the player is told. Written here, next to the detection, because a
 *  detection with no sentence attached is how spinners happen. */
export const FAILURE_TEXT: Record<PeerFailure, string> = {
  nat: 'Could not open a direct connection — your network and theirs both '
    + 'refuse one. This happens to roughly one connection in six and there is '
    + 'no relay to fall back on. A different network (a phone hotspot usually '
    + 'works) is the fix.',
  timeout: 'Gave up waiting for a connection. The lobby service may be '
    + 'unreachable, or the other player may have closed their tab.',
  lost: 'The connection dropped.',
  bye: 'They left.',
}

/**
 * Network shaping, for the tests and the probe.
 *
 * TWO CONTEXTS IN ONE CHROMIUM SHARE A MACHINE, A LOOPBACK AND A NAT. They
 * connect over host candidates in single-digit milliseconds with no loss, and
 * they will do that on any developer's machine and in CI for ever. So the
 * numbers a probe measures for a real race are meaningless unless something
 * puts the distance back, and this is that something.
 *
 * LOSS IS MODELLED AS DELAY, NOT AS DROPPING. The data channel is reliable and
 * ordered, so a lost packet is not a missing input -- SCTP retransmits it, and
 * everything queued behind it waits. Head-of-line blocking is what lockstep
 * actually feels from a lossy link, and a shaper that dropped messages would
 * be simulating a transport this game does not use and hiding the one it does.
 */
export interface Shape {
  /** One-way delay added to every message, milliseconds. */
  delayMs: number
  /** Uniform jitter added on top, 0..jitterMs. Applied so that delivery stays
   *  ORDERED: a jittered message never overtakes one sent before it. */
  jitterMs: number
  /** Probability a message needs a retransmit. Costs `2 * delayMs` and blocks
   *  everything behind it, exactly as SCTP would. */
  lossRate: number
  /** Seeded, so a shaped run is reproducible. */
  seed?: number
}

// ---------------------------------------------------------------------------
// One link
// ---------------------------------------------------------------------------

export interface PeerLinkOptions {
  /** The peer at the other end. */
  peerId: string
  /** True on the side that creates the data channel and the offer. */
  offering: boolean
  iceServers?: RTCIceServer[]
  /** Post a signalling letter to this peer. */
  signal: (kind: 'offer' | 'answer' | 'ice', body: string) => void
  shape?: Shape | null
  /** Injected for tests; the probe uses the browser's own. */
  makeConnection?: (cfg: RTCConfiguration) => RTCPeerConnection
  now?: () => number
  /** Overrides `CONNECT_TIMEOUT_MS`. A probe that wants to WATCH a connection
   *  fail cannot afford to wait twelve seconds for every one it tries. */
  connectTimeoutMs?: number
}

/**
 * One RTCPeerConnection, one ordered reliable data channel, and the bookkeeping
 * that turns `iceConnectionState` into something a player can be told.
 */
export class PeerLink {
  readonly peerId: string
  private readonly pc: RTCPeerConnection
  private ch: RTCDataChannel | null = null
  private readonly post: PeerLinkOptions['signal']
  private readonly now: () => number
  private readonly shape: Shape | null
  private readonly rng: Rng

  state: PeerState = 'new'
  failure: PeerFailure | null = null
  /** Smoothed round trip, or null until the first pong lands. */
  pingMs: number | null = null
  /** Wall clock of the last byte received from this peer, of any kind. */
  lastRecvAt = 0
  /** Wall clock of the last ping timer tick, for the blocked-page check. */
  private lastTickAt = 0
  /** Wall clock when this link started negotiating, for the connect timing. */
  readonly startedAt: number
  /** Wall clock when the channel opened. Null while it has not. */
  openedAt: number | null = null

  onMessage: (msg: unknown) => void = () => {}
  onStateChange: (state: PeerState, failure: PeerFailure | null) => void = () => {}

  /** Remote description not yet applied, so ICE candidates must queue. */
  private pendingIce: RTCIceCandidateInit[] = []
  private haveRemote = false
  private timers: ReturnType<typeof setTimeout>[] = []
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private pingN = 0
  private pingSentAt = new Map<number, number>()
  /** Shaper: the wall-clock time the previously shaped message is released at,
   *  so ordering survives jitter. */
  private shapeCursor = 0
  private disposed = false

  constructor(opts: PeerLinkOptions) {
    this.peerId = opts.peerId
    this.post = opts.signal
    this.now = opts.now ?? (() => Date.now())
    this.shape = opts.shape ?? null
    this.rng = new Rng(opts.shape?.seed ?? 0x5eed)
    this.startedAt = this.now()

    const cfg: RTCConfiguration = { iceServers: opts.iceServers ?? DEFAULT_ICE }
    this.pc = opts.makeConnection
      ? opts.makeConnection(cfg)
      : new RTCPeerConnection(cfg)

    this.pc.onicecandidate = (e) => {
      // A null candidate is end-of-gathering. Not forwarded: the peer learns
      // the same thing from its own checks finishing, and posting it costs a
      // signalling round trip that changes nothing.
      if (e.candidate) this.post('ice', JSON.stringify(e.candidate.toJSON()))
    }
    this.pc.oniceconnectionstatechange = () => this.readIceState()
    this.pc.onconnectionstatechange = () => this.readIceState()

    if (opts.offering) {
      /**
       * ORDERED AND RELIABLE, AND THAT IS NOT THE OBVIOUS CHOICE.
       *
       * Most action-game netcode wants `ordered: false, maxRetransmits: 0`:
       * a stale position update is worthless, so dropping it beats delaying
       * the next one. LOCKSTEP IS THE OPPOSITE. An input for frame 1200 is not
       * stale at frame 1260 -- it is REQUIRED, because frame 1200 cannot be
       * stepped without it and nothing after it can either. A dropped input is
       * not a hiccup, it is a race that never continues.
       *
       * So we take SCTP's retransmission, and we accept head-of-line blocking
       * as the price. That price is exactly what `Shape` models, and what
       * `lockstep.ts`'s stall policy is written against.
       */
      this.ch = this.pc.createDataChannel('race', { ordered: true })
      this.bindChannel(this.ch)
      void this.makeOffer()
    } else {
      this.pc.ondatachannel = (e) => { this.ch = e.channel; this.bindChannel(e.channel) }
    }

    this.set('connecting')
    this.timers.push(setTimeout(() => {
      if (this.state === 'connecting') this.fail('timeout')
    }, opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS))
  }

  // -------------------------------------------------------------------------

  private set(state: PeerState, failure: PeerFailure | null = null): void {
    if (this.state === state && this.failure === failure) return
    if (this.state === 'failed' || this.state === 'closed') return
    this.state = state
    this.failure = failure
    this.onStateChange(state, failure)
  }

  private fail(why: PeerFailure): void {
    if (this.state === 'failed' || this.state === 'closed') return
    this.state = 'failed'
    this.failure = why
    this.onStateChange('failed', why)
  }

  /**
   * Translate the browser's state machine into ours.
   *
   * `failed` ON `iceConnectionState` IS THE NAT ANSWER. It means the agent
   * finished its connectivity checks over every candidate pair it had and none
   * of them worked -- which is precisely "no path exists between these two
   * networks without a relay". Distinguishing that from `timeout` matters
   * because they are different sentences: one is "your networks cannot see
   * each other", the other is "something upstream never answered", and telling
   * a player the wrong one sends them to fix the wrong thing.
   *
   * `disconnected` IS NOT FAILURE. It is the browser saying it has stopped
   * hearing from the peer, and it recovers on its own routinely -- a wifi roam,
   * a few seconds of a bad cell. Treating it as a drop would eject players for
   * a blip. It is left to `SILENCE_MS` and the lockstep stall policy, which
   * are counting real data rather than a hint.
   */
  private readIceState(): void {
    const ice = this.pc.iceConnectionState
    const conn = this.pc.connectionState
    if (ice === 'failed' || conn === 'failed') {
      this.fail(this.openedAt === null ? 'nat' : 'lost')
      return
    }
    if (conn === 'closed') { this.fail(this.openedAt === null ? 'timeout' : 'lost'); return }
  }

  private bindChannel(ch: RTCDataChannel): void {
    ch.onopen = () => {
      this.openedAt = this.now()
      this.lastRecvAt = this.openedAt
      this.lastTickAt = this.openedAt
      this.set('open')
      this.pingTimer = setInterval(() => this.ping(), PING_MS)
      this.ping()
    }
    ch.onclose = () => { if (this.state === 'open') this.fail('lost') }
    ch.onerror = () => { if (this.state !== 'open') this.fail('nat') }
    ch.onmessage = (e) => this.deliver(e.data)
  }

  private async makeOffer(): Promise<void> {
    try {
      const offer = await this.pc.createOffer()
      await this.pc.setLocalDescription(offer)
      this.post('offer', JSON.stringify(this.pc.localDescription))
    } catch (e) {
      console.warn('webrtc: offer failed', e)
      this.fail('timeout')
    }
  }

  /** A letter arrived for this link. */
  async accept(kind: 'offer' | 'answer' | 'ice', body: string): Promise<void> {
    if (this.disposed) return
    try {
      const parsed = JSON.parse(body) as RTCSessionDescriptionInit & RTCIceCandidateInit
      if (kind === 'offer') {
        await this.pc.setRemoteDescription(parsed)
        this.haveRemote = true
        await this.drainIce()
        const answer = await this.pc.createAnswer()
        await this.pc.setLocalDescription(answer)
        this.post('answer', JSON.stringify(this.pc.localDescription))
        return
      }
      if (kind === 'answer') {
        // A duplicate answer is normal: the mailbox is at-least-once and a
        // client that re-posted its offer gets two. Applying one in the wrong
        // state throws and would look like a connection failure.
        if (this.pc.signalingState !== 'have-local-offer') return
        await this.pc.setRemoteDescription(parsed)
        this.haveRemote = true
        await this.drainIce()
        return
      }
      // ICE. CANDIDATES ROUTINELY ARRIVE BEFORE THE DESCRIPTION THEY BELONG TO
      // -- the peer trickles them the instant it has them, and our poll may
      // hand us the burst in one batch with the offer. addIceCandidate throws
      // in that state, so they queue.
      if (!this.haveRemote) { this.pendingIce.push(parsed); return }
      await this.pc.addIceCandidate(parsed)
    } catch (e) {
      // Not fatal. One bad candidate out of eight is normal and the connection
      // succeeds on another pair; failing the link here would throw away a
      // connection that was about to work.
      console.warn('webrtc: signalling message rejected', kind, e)
    }
  }

  private async drainIce(): Promise<void> {
    const q = this.pendingIce.splice(0)
    for (const c of q) {
      try { await this.pc.addIceCandidate(c) } catch { /* see accept() */ }
    }
  }

  // -------------------------------------------------------------------------
  // Traffic
  // -------------------------------------------------------------------------

  send(msg: unknown): boolean {
    if (this.state !== 'open' || !this.ch || this.ch.readyState !== 'open') return false
    try { this.ch.send(JSON.stringify(msg)); return true } catch { return false }
  }

  /**
   * Inbound, through the shaper.
   *
   * Unshaped this is a straight call. Shaped, the message is held until
   * `releaseAt`, which is computed to be monotonically non-decreasing across
   * messages so that ORDER IS PRESERVED even when jitter would have reordered
   * them -- because the real channel is ordered and a shaper that reordered
   * would be testing lockstep against a transport it will never see.
   */
  private deliver(raw: unknown): void {
    // The wire delivered something; that is a fact about liveness and it is
    // recorded before any shaping, which is a fiction about distance.
    this.lastRecvAt = this.now()
    let msg: unknown
    try { msg = JSON.parse(String(raw)) } catch { return }

    if (!this.shape) { this.consume(msg); return }
    const s = this.shape
    let wait = s.delayMs + this.rng.next() * s.jitterMs
    if (s.lossRate > 0 && this.rng.next() < s.lossRate) wait += 2 * s.delayMs
    const at = Math.max(this.now() + wait, this.shapeCursor)
    this.shapeCursor = at
    const timer = setTimeout(() => {
      if (!this.disposed) this.consume(msg)
    }, Math.max(0, at - this.now()))
    this.timers.push(timer)
  }

  /**
   * A message, at the far end of whatever distance is being simulated.
   *
   * PING AND PONG GO THROUGH THE SHAPER TOO, and that was not true in the
   * first cut. Handling them before the delay meant the measured round trip
   * was the real loopback one -- 1ms -- while every input arrived 45ms late,
   * so `inputDelayFor` sized the pipeline for a LAN and the race then stalled
   * on more than half of all ticks. A shaper that does not shape the
   * measurement is not shaping anything: it just makes the netcode wrong about
   * the link in exactly the way a real bad link never does.
   *
   * They are also never shown to the owner. They are a property of the link,
   * and a caller that had to filter them out of its message stream would be
   * one `if` away from stepping a frame on a heartbeat.
   */
  private consume(msg: unknown): void {
    const t = (msg as { t?: string } | null)?.t
    if (t === 'ping') { this.send({ t: 'pong', n: (msg as { n: number }).n }); return }
    if (t === 'pong') {
      const sent = this.pingSentAt.get((msg as { n: number }).n)
      if (sent !== undefined) {
        this.pingSentAt.delete((msg as { n: number }).n)
        const rtt = this.now() - sent
        // Exponential smoothing at 0.3. A single 400ms spike on an otherwise
        // 30ms link must not talk the host into a 13-frame input delay for the
        // rest of the race, and a raw last-sample ping would do exactly that.
        this.pingMs = this.pingMs === null ? rtt : this.pingMs * 0.7 + rtt * 0.3
      }
      return
    }
    this.onMessage(msg)
  }

  private ping(): void {
    const now = this.now()
    // WERE WE THE ONES WHO STOPPED? A timer that is this late means the main
    // thread was blocked, so nothing arrived from anybody and the silence
    // proves nothing about this peer. Forgive it and start counting again.
    if (this.lastTickAt > 0 && now - this.lastTickAt > BLOCKED_MS) {
      this.lastRecvAt = now
      // The outstanding pings went out before the block and their round trips
      // would now measure the block rather than the network.
      this.pingSentAt.clear()
    }
    this.lastTickAt = now
    const n = ++this.pingN
    this.pingSentAt.set(n, now)
    // Bound the map: a peer that stopped answering must not leak one entry a
    // second for the rest of the race.
    if (this.pingSentAt.size > 8) {
      const oldest = this.pingSentAt.keys().next().value
      if (oldest !== undefined) this.pingSentAt.delete(oldest)
    }
    this.send({ t: 'ping', n })
  }

  /**
   * True when this page's own main thread has been blocked recently enough
   * that it cannot draw any conclusion about anybody.
   *
   * The ping timer is the witness: it is supposed to run at 1Hz, so if it has
   * not run for `BLOCKED_MS` then no message from any peer could have been
   * processed either, and every link would look silent. See the note on
   * `BLOCKED_MS`.
   */
  private get blocked(): boolean {
    return this.lastTickAt > 0 && this.now() - this.lastTickAt > BLOCKED_MS
  }

  /** Milliseconds since anything at all arrived. Liveness, not latency. */
  silentFor(): number {
    if (this.lastRecvAt === 0 || this.blocked) return 0
    return this.now() - this.lastRecvAt
  }

  /**
   * True when the wire itself is gone, as opposed to merely slow.
   *
   * SILENCE ON ITS OWN IS NOT EVIDENCE, and that is the whole shape of this
   * function. A peer whose main thread is blocked -- swapping a circuit,
   * building a track mesh, compiling shaders -- sends nothing at all for
   * several seconds while being completely healthy, and the probe caught this
   * every run: the host declared a guest dead 2,514ms into its load screen,
   * with a measured round trip of 2ms.
   *
   * So `dead` means the BROWSER agrees something is wrong:
   *
   *   `failed` / `closed`   the channel or the ICE agent gave up. Definite,
   *                         and it is what a closed tab produces within a
   *                         hundred milliseconds -- which is why the fast path
   *                         loses nothing by being strict here.
   *   ICE not connected     the agent has stopped hearing from the peer too.
   *                         Corroboration, and only THEN does silence count.
   *
   * Anything else -- a quiet peer on a connection the browser still considers
   * up -- is ambiguous, and ambiguity belongs to `lockstep.ts`'s stall
   * deadline, which counts in time this page was awake for and gives a peer
   * who has never spoken a much longer grace than one who has gone quiet.
   * Splitting it this way is what lets the fast path stay fast.
   *
   * CHECKED AT THE INSTANT IT IS ASKED, not only when the ping timer gets
   * round to it. Forgiving the silence inside `ping()` alone left a
   * one-second window in which every peer still read as dead, and the probe
   * hit that too.
   */
  get dead(): boolean {
    if (this.state === 'failed' || this.state === 'closed') return true
    if (this.state !== 'open') return false
    const ice = this.pc.iceConnectionState
    if (ice === 'connected' || ice === 'completed' || ice === 'checking') return false
    return this.silentFor() > SILENCE_MS
  }

  /** Milliseconds from construction to the channel opening, or null. */
  get connectMs(): number | null {
    return this.openedAt === null ? null : this.openedAt - this.startedAt
  }

  close(why: PeerFailure = 'bye'): void {
    if (this.disposed) return
    this.disposed = true
    if (this.state !== 'failed') { this.state = 'closed'; this.failure = why }
    for (const t of this.timers) clearTimeout(t)
    this.timers.length = 0
    if (this.pingTimer !== null) clearInterval(this.pingTimer)
    try { this.ch?.close() } catch { /* already gone */ }
    try { this.pc.close() } catch { /* already gone */ }
    this.onStateChange(this.state, this.failure)
  }
}

// ---------------------------------------------------------------------------
// The room
// ---------------------------------------------------------------------------

export interface StarMeshOptions {
  selfId: string
  /** The host's peer id. Equal to `selfId` on the host. */
  hostId: string
  iceServers?: RTCIceServer[]
  shape?: Shape | null
  signal: (to: string, kind: 'offer' | 'answer' | 'ice', body: string) => void
  makeConnection?: (cfg: RTCConfiguration) => RTCPeerConnection
  now?: () => number
  connectTimeoutMs?: number
}

/**
 * Every link this client holds. One on a guest, up to seven on the host.
 *
 * The mesh does not know what a race is. It carries addressed JSON and reports
 * who is up; `live.ts` puts a lobby on it and `lockstep.ts` puts a race on it.
 * That separation is what lets the transport survive BETWEEN ROUNDS of a
 * series -- the peers are a property of the room, the frame counter is a
 * property of the round, and tearing the first down to reset the second would
 * make every round after the first pay the whole handshake again.
 */
export class StarMesh {
  readonly selfId: string
  readonly hostId: string
  readonly isHost: boolean
  private readonly opts: StarMeshOptions
  private readonly links = new Map<string, PeerLink>()
  private readonly now: () => number
  private disposed = false

  /** A message arrived from a peer, already unwrapped. */
  onMessage: (from: string, msg: unknown) => void = () => {}
  onPeerState: (peerId: string, state: PeerState, failure: PeerFailure | null) => void = () => {}

  constructor(opts: StarMeshOptions) {
    this.opts = opts
    this.selfId = opts.selfId
    this.hostId = opts.hostId
    this.isHost = opts.selfId === opts.hostId
    this.now = opts.now ?? (() => Date.now())
  }

  /**
   * Start connecting to a peer, or return the link that is already trying.
   *
   * IDEMPOTENT, BECAUSE THE MAILBOX IS AT-LEAST-ONCE. A guest whose offer was
   * re-posted makes the host call this twice, and a second RTCPeerConnection to
   * the same person is two half-open connections and a coin toss over which one
   * carries the race.
   */
  connect(peerId: string): PeerLink | null {
    if (this.disposed || peerId === this.selfId) return null
    const have = this.links.get(peerId)
    if (have && have.state !== 'failed' && have.state !== 'closed') return have
    // A host only ever answers; a guest only ever connects to the host.
    if (!this.isHost && peerId !== this.hostId) return null
    const link = new PeerLink({
      peerId,
      offering: !this.isHost,
      iceServers: this.opts.iceServers,
      shape: this.opts.shape,
      makeConnection: this.opts.makeConnection,
      now: this.now,
      connectTimeoutMs: this.opts.connectTimeoutMs,
      signal: (kind, body) => this.opts.signal(peerId, kind, body),
    })
    link.onMessage = (msg) => this.onMessage(peerId, msg)
    link.onStateChange = (s, f) => this.onPeerState(peerId, s, f)
    this.links.set(peerId, link)
    return link
  }

  /** Route an inbound signalling letter, opening a link for it if needed. */
  accept(from: string, kind: 'offer' | 'answer' | 'ice', body: string): void {
    if (this.disposed) return
    const have = this.links.get(from)
    const usable = have && have.state !== 'failed' && have.state !== 'closed' ? have : null
    // Only an OFFER may create a link on this side. An answer or a candidate
    // for a link we do not have is a letter from a previous attempt; opening a
    // connection for it would produce a peer with no offer to answer.
    const link = usable ?? (kind === 'offer' && this.isHost ? this.connect(from) : null)
    if (!link) return
    void link.accept(kind, body)
  }

  get(peerId: string): PeerLink | undefined { return this.links.get(peerId) }
  get peers(): readonly PeerLink[] { return [...this.links.values()] }

  /** Everyone whose channel is open right now. */
  get open(): readonly PeerLink[] {
    return this.peers.filter((l) => l.state === 'open')
  }

  send(to: string, msg: unknown): boolean {
    return this.links.get(to)?.send(msg) ?? false
  }

  /** To every open link. Returns how many actually took it. */
  broadcast(msg: unknown, except?: string): number {
    let n = 0
    for (const l of this.links.values()) {
      if (l.peerId === except) continue
      if (l.send(msg)) n++
    }
    return n
  }

  /**
   * The worst path any input has to travel, in milliseconds.
   *
   * ON THE HOST THIS IS A SUM AND NOT A MAXIMUM, which is the whole reason this
   * function exists rather than a `Math.max` at the call site. The host's own
   * link to the slowest guest is not the worst path in a star: a packet from
   * the slowest guest to the SECOND slowest guest goes through the host, so it
   * pays both legs. Publishing the one-hop worst would buy an input delay that
   * is right for the host and too small for everybody else, and the symptom
   * would be a race that stalls constantly for reasons the host cannot see.
   *
   * Unmeasured links count as `unknownMs` rather than being skipped, for the
   * same reason mock.ts's `inputDelayFor` does it: a peer whose ping has not
   * landed yet is not a peer with no latency.
   */
  worstPathMs(unknownMs = 220): number {
    const pings = this.peers
      .filter((l) => l.state === 'open')
      .map((l) => l.pingMs ?? unknownMs)
      .sort((a, b) => b - a)
    if (pings.length === 0) return 0
    if (!this.isHost) {
      // A guest can only see the host. Its own two-hop worst is its leg plus
      // the host's worst other leg, which it does not know -- so the host
      // publishes the number and this is only a floor.
      return pings[0]
    }
    return pings.length === 1 ? pings[0] : pings[0] + pings[1]
  }

  drop(peerId: string, why: PeerFailure = 'bye'): void {
    this.links.get(peerId)?.close(why)
    this.links.delete(peerId)
  }

  dispose(): void {
    this.disposed = true
    for (const l of this.links.values()) l.close('bye')
    this.links.clear()
  }
}
