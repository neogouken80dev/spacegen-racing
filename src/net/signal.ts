/**
 * SpaceGen Racing — the signalling client.
 * ---------------------------------------------------------------------------
 * The browser half of `/api/signal`. One POST per call, one poll loop, and a
 * batching queue so a burst of ICE candidates is one request rather than six.
 *
 * ===========================================================================
 * THE POLL RATE IS THREE RATES, AND THE MIDDLE ONE IS THE ONE THAT COSTS
 *
 * Signalling over polled HTTP is only defensible because it is low frequency
 * (types.ts says so in its opening paragraphs). But "low frequency" is not one
 * number, and the first version of this file got it wrong in a way that took a
 * probe to find:
 *
 *   fast   (`POLL_FAST_MS`, 0.9s)  any peer is mid-handshake. Every extra
 *          500ms here is 500ms of somebody looking at a spinner.
 *   open   (`POLL_OPEN_MS`, 3s)    the HOST, with a lobby that is open and not
 *          full. Nothing is pending -- but a guest may be knocking RIGHT NOW,
 *          and the host learns about them only by asking.
 *   idle   (`HEARTBEAT_MS`, 10s)   everything else: a guest whose link is up,
 *          a host whose lobby is full or racing. The endpoint has nothing left
 *          to say and this is only keeping the directory row warm.
 *
 * WHAT WENT WRONG WITHOUT THE MIDDLE ONE. A host with an empty lobby has
 * nothing pending, so it fell straight to the 10-second heartbeat -- and a
 * guest's offer then sat in the mailbox for up to ten seconds before the host
 * even knew somebody had joined. Both sides were working perfectly and the
 * join took eleven seconds. tools/probe-netcode.mjs found it by timing out on
 * a connection that was, in fact, about to happen.
 *
 * WHAT THE MIDDLE ONE COSTS, because it is the one number here that scales
 * with something. 3s is 20 requests a minute PER OPEN LOBBY, for as long as it
 * sits open. That is linear in open lobbies × time and in nothing else --
 * players in a lobby cost nothing extra, and races cost nothing at all. If
 * that ever becomes the bill, the fix is a push channel (SSE) for this one
 * case and not a slower poll, because a slower poll is a slower join.
 *
 * ===========================================================================
 * FAILURE IS NORMAL AND IS NOT AN ERROR
 *
 * A poll that fails is a poll that failed. It does not close the lobby, does
 * not surface a banner and does not stop the loop -- the peers may already be
 * connected, in which case the endpoint being down is invisible and should
 * stay invisible. What a run of failures does do is back off (so a dead
 * endpoint is not hammered) and, past `OFFLINE_AFTER`, tell the owner, because
 * at that point a guest who has NOT yet connected really is stuck and deserves
 * to be told which half is broken.
 */
import {
  HEARTBEAT_MS, SIGNAL_PATH,
  type LobbyRecord, type SignalKind, type SignalMsg, type SignalRequest,
  type SignalResponse,
} from './signalProtocol'
import type { LobbySummary } from './types'

/** While anybody is still negotiating. Below this the endpoint cost stops
 *  being negligible and the handshake is not meaningfully faster. */
export const POLL_FAST_MS = 900
/** The host's rate while its lobby is open and empty. See the header. */
export const POLL_OPEN_MS = 3000
/** Consecutive poll failures before the owner is told the service is down. */
export const OFFLINE_AFTER = 3
/** Backoff ceiling. A dead endpoint is retried at this, for ever, quietly. */
export const POLL_MAX_MS = 15_000

export interface SignalClientOptions {
  /** The local player's account id. Every letter is addressed from this. */
  peerId: string
  peerName: string
  /** Overridable so the probe and the tests can point at their own server. */
  endpoint?: string
  /** Injected so tests do not need a global. */
  fetchImpl?: typeof fetch
}

/** What `create` needs. Mirrors `CreateLobbyOptions` minus the parts the
 *  endpoint does not need to know, and flattened so it is JSON by inspection. */
export interface CreateWire {
  name: string
  region: string
  maxPlayers: number
  private: boolean
  series: { length: number; trackIds: string[]; laps: number }
}

type Timer = ReturnType<typeof setTimeout>

export class SignalClient {
  /**
   * Mutable, because the account is resolved asynchronously and the service
   * that owns this client is constructed synchronously. `net/index.ts` hands
   * back a `LobbyService` from a plain function call while the profile is
   * still loading; the alternative is an async factory that every call site in
   * ui/lobby.ts would have to learn about. Written exactly once, before the
   * first request leaves.
   */
  peerId: string
  peerName: string
  private readonly endpoint: string
  private readonly fetchImpl: typeof fetch

  /** The lobby this client is polling, or null when it is only browsing. */
  private lobbyId: string | null = null
  /** Highest seq drained per sender, so a poll never re-delivers a letter. */
  private since: Record<string, number> = {}
  /** Outbound letters, addressed, waiting for the next flush. */
  private outbox = new Map<string, { kind: SignalKind; body: string }[]>()
  private flushTimer: Timer | null = null
  private pollTimer: Timer | null = null
  private failures = 0
  private disposed = false
  /** Set by the owner every time it learns something. See the header. */
  rate: 'fast' | 'open' | 'idle' = 'fast'

  onMail: (from: string, msgs: readonly SignalMsg[]) => void = () => {}
  onLobby: (lobby: LobbyRecord | null) => void = () => {}
  /** True once `OFFLINE_AFTER` polls in a row have failed; false on the first
   *  that succeeds. The room screen renders this, the race does not care. */
  onOffline: (offline: boolean) => void = () => {}

  private offline = false

  constructor(opts: SignalClientOptions) {
    this.peerId = opts.peerId
    this.peerName = opts.peerName
    this.endpoint = opts.endpoint ?? SIGNAL_PATH
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a))
  }

  // -------------------------------------------------------------------------
  // The one request
  // -------------------------------------------------------------------------

  /**
   * POST a request and get the typed answer, or a `{ ok: false }` we made up.
   *
   * A NETWORK FAILURE AND A REJECTION COME BACK THE SAME SHAPE, on purpose.
   * Every caller already has to handle `{ ok: false, error }` -- `full`,
   * `badcode`, `racing` are real answers -- so making a fetch rejection a
   * thrown exception would give each of them a second failure channel to
   * forget about. `offline` is a `JoinError` for exactly this reason.
   */
  private async post(req: SignalRequest): Promise<SignalResponse> {
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
      })
      // A 429 is a real answer with a real reason; a 500 is not, but the client
      // treats both as "not now" and the caller decides whether that is fatal.
      const body = await res.json().catch(() => null) as SignalResponse | null
      if (!body || typeof body !== 'object') return { ok: false, error: 'offline' }
      return body
    } catch {
      return { ok: false, error: 'offline' }
    }
  }

  // -------------------------------------------------------------------------
  // Directory
  // -------------------------------------------------------------------------

  async list(filter?: { region?: string; joinableOnly?: boolean; search?: string })
    : Promise<LobbySummary[] | null> {
    const req: SignalRequest = { op: 'list' }
    if (filter?.region && filter.region !== 'any') req.region = filter.region
    if (filter?.joinableOnly) req.joinableOnly = true
    if (filter?.search) req.search = filter.search
    const res = await this.post(req)
    if (!res.ok || res.op !== 'list') return null
    return res.lobbies
  }

  async create(lobby: CreateWire): Promise<LobbyRecord | string> {
    const res = await this.post({
      op: 'create', peer: { id: this.peerId, name: this.peerName }, lobby,
    })
    if (!res.ok) return res.error
    if (res.op !== 'create') return 'server'
    this.attach(res.lobby.id)
    return res.lobby
  }

  async join(id: string, code?: string): Promise<LobbyRecord | string> {
    const res = await this.post({
      op: 'join', id, peer: { id: this.peerId, name: this.peerName }, code,
    })
    if (!res.ok) return res.error
    if (res.op !== 'join') return 'server'
    this.attach(id)
    return res.lobby
  }

  /** Host only: publish the row the directory shows. Fire and forget. */
  update(status?: string, round?: number): void {
    if (!this.lobbyId) return
    void this.post({ op: 'update', id: this.lobbyId, peer: this.peerId, status, round })
  }

  /**
   * Leave, and MEAN IT BEFORE THE TAB GOES.
   *
   * Returns the promise so a caller with time can await it, but the common
   * caller is a pagehide handler with no time at all -- so the request is also
   * fired through `sendBeacon` where that exists, which is the only transport
   * a browser guarantees to finish after the document is gone. Without it a
   * host who closes their tab leaves a lobby that looks open for a whole
   * `LOBBY_TTL_MS`, and every guest who tries it in that window gets a room
   * with nobody in it.
   */
  bye(): Promise<void> {
    const id = this.lobbyId
    this.detach()
    if (!id) return Promise.resolve()
    const req: SignalRequest = { op: 'bye', id, peer: this.peerId }
    try {
      const nav = (globalThis as { navigator?: { sendBeacon?: (u: string, d: string) => boolean } }).navigator
      if (nav?.sendBeacon) {
        nav.sendBeacon(this.endpoint, JSON.stringify(req))
        return Promise.resolve()
      }
    } catch { /* no navigator, or a beacon that refused */ }
    return this.post(req).then(() => {})
  }

  // -------------------------------------------------------------------------
  // Mail
  // -------------------------------------------------------------------------

  /**
   * Queue a letter. Flushed on a microtask-ish timer, batched per recipient.
   *
   * ICE CANDIDATES ARRIVE IN A BURST -- a browser typically emits four to eight
   * within a few milliseconds of `setLocalDescription` -- so posting each one
   * is six requests where one will do, and six chances to trip the rate limit
   * on a join. `FLUSH_MS` is 40, which is below anything a human notices and
   * above the width of that burst.
   */
  send(to: string, kind: SignalKind, body: string): void {
    if (this.disposed || !this.lobbyId) return
    const q = this.outbox.get(to) ?? []
    q.push({ kind, body })
    this.outbox.set(to, q)
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => { this.flushTimer = null; void this.flush() }, 40)
    }
  }

  private async flush(): Promise<void> {
    const id = this.lobbyId
    if (!id) { this.outbox.clear(); return }
    const batches = [...this.outbox.entries()]
    this.outbox.clear()
    await Promise.all(batches.map(([to, msgs]) =>
      this.post({ op: 'send', id, from: this.peerId, to, msgs })))
  }

  // -------------------------------------------------------------------------
  // The poll loop
  // -------------------------------------------------------------------------

  private attach(lobbyId: string): void {
    this.lobbyId = lobbyId
    this.since = {}
    this.failures = 0
    this.rate = 'fast'
    this.schedule(0)
  }

  private detach(): void {
    this.lobbyId = null
    if (this.pollTimer !== null) { clearTimeout(this.pollTimer); this.pollTimer = null }
  }

  private schedule(ms: number): void {
    if (this.disposed || !this.lobbyId) return
    if (this.pollTimer !== null) clearTimeout(this.pollTimer)
    this.pollTimer = setTimeout(() => { void this.poll() }, ms)
  }

  private async poll(): Promise<void> {
    const id = this.lobbyId
    if (!id) return
    const res = await this.post({ op: 'poll', id, peer: this.peerId, since: this.since })
    if (this.disposed || this.lobbyId !== id) return

    if (!res.ok || res.op !== 'poll') {
      this.failures++
      if (this.failures >= OFFLINE_AFTER && !this.offline) {
        this.offline = true
        this.onOffline(true)
      }
      // Exponential, capped. A handshake that is failing because the endpoint
      // is down is not helped by asking faster, and the peers may already be
      // connected and not need it at all.
      this.schedule(Math.min(POLL_MAX_MS, POLL_FAST_MS * 2 ** Math.min(6, this.failures)))
      return
    }

    this.failures = 0
    if (this.offline) { this.offline = false; this.onOffline(false) }

    for (const [from, msgs] of Object.entries(res.mail)) {
      if (msgs.length === 0) continue
      // Record the high-water mark BEFORE delivering. A handler that throws
      // must not make the same letter arrive again on the next poll and open a
      // second peer connection to the same person.
      let top = this.since[from] ?? 0
      for (const m of msgs) if (m.seq > top) top = m.seq
      this.since[from] = top
      try { this.onMail(from, msgs) } catch (e) { console.warn('signal: mail handler threw', e) }
    }
    try { this.onLobby(res.lobby) } catch (e) { console.warn('signal: lobby handler threw', e) }

    this.schedule(this.rate === 'fast' ? POLL_FAST_MS
      : this.rate === 'open' ? POLL_OPEN_MS : HEARTBEAT_MS)
  }

  /** Time since the last successful poll, for a caller that wants to say so. */
  get failing(): boolean { return this.failures >= OFFLINE_AFTER }

  dispose(): void {
    this.disposed = true
    this.detach()
    if (this.flushTimer !== null) { clearTimeout(this.flushTimer); this.flushTimer = null }
    this.outbox.clear()
  }
}
