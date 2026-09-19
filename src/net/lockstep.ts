/**
 * SpaceGen Racing — DETERMINISTIC LOCKSTEP: the scheduler and the three
 * policies that decide what a broken race does.
 * ---------------------------------------------------------------------------
 *
 * Clients exchange INPUTS, not positions. `tests/bridges.test.ts` pins a hash
 * of a whole race and it reproduces byte for byte, which is the property this
 * whole file is built on: given one seed, one grid and one input tape, every
 * client's `Race` produces identical frames. Nothing here sends a car's
 * position, and nothing here would know what to do with one.
 *
 * ===========================================================================
 * THE SHAPE OF A FRAME
 *
 *   before stepping frame F:
 *     1. sample the local stick, PACK it, publish it for frame F + inputDelay
 *     2. if every live racer's input for F is in hand, apply them and step
 *     3. otherwise WAIT -- and that wait is the subject of most of this file
 *
 * Frames 1..inputDelay have no published input from anybody (nobody had been
 * asked yet), so they are primed to neutral for every slot. That is the
 * lockstep pipeline filling: the first `inputDelay` frames of every race are
 * the countdown, during which nobody is driving anyway.
 *
 * ===========================================================================
 * THE LOCAL PLAYER STEPS THE QUANTISED INPUT, NOT THEIR OWN
 *
 * `packInput` throws away precision -- 10 bits of steer, 6 of throttle. Every
 * remote client necessarily steps the unpacked value, so if the LOCAL client
 * stepped its raw float instead, the two would differ by up to 1/511 of lock
 * on frame one and the race would have diverged before the lights went out.
 *
 * It is a two-line bug that produces a symptom ("we desync immediately, on
 * every race, on every track") indistinguishable from a broken protocol, so it
 * is worth the paragraph: `LockstepRunner.beforeStep` feeds the local slot
 * `unpackInput(packInput(frame))` and never `frame`.
 */
import type { InputFrame } from '../sim/types'
import { emptyInput } from '../sim/types'
import type { Race } from '../sim/race'

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

/**
 * One frame of stick, in 27 bits.
 *
 *   bits  0..9   steer     10 bits, SIGNED AND CENTRED
 *   bits 10..15  throttle   6 bits
 *   bits 16..21  brake      6 bits
 *   bit  22      drift
 *   bit  23      item
 *   bit  24      itemBack
 *   bit  25      lift
 *   bit  26      lookBack
 *
 * STEER IS ENCODED AROUND A CENTRE OF 511 RATHER THAN BY SCALING 0..1023, and
 * that is not a style choice. The obvious encoding, `round((s+1)/2*1023)`,
 * maps a dead-centre stick to 511.5 -- so it rounds to 512 and comes back as
 * +0.00098. Every car in the field would then carry a permanent fractional
 * right-hand steering input, which over a two-minute race is a car that walks
 * into the outside barrier on every straight. Centring makes 0 encode to
 * exactly 0, and +-1 encode to exactly +-1, which are the three values that
 * actually have to survive the round trip.
 *
 * WHY 27 BITS AND NOT A BYTE STRING. `RaceTransport.sendInput` takes a
 * `number`, which is the contract in types.ts, and 27 bits is inside the range
 * JavaScript's bitwise operators work in (31). Tighter packing is available
 * and would save perhaps eight bytes a frame per peer; that is a change to
 * make with a measurement in hand, not a guess.
 */
const STEER_MAX = 511
const AXIS_MAX = 63

export function packInput(f: InputFrame): number {
  const steer = Math.max(-STEER_MAX, Math.min(STEER_MAX, Math.round(f.steer * STEER_MAX))) + STEER_MAX
  const throttle = Math.max(0, Math.min(AXIS_MAX, Math.round(f.throttle * AXIS_MAX)))
  const brake = Math.max(0, Math.min(AXIS_MAX, Math.round(f.brake * AXIS_MAX)))
  return (steer & 0x3ff)
    | (throttle << 10)
    | (brake << 16)
    | (f.drift ? 1 << 22 : 0)
    | (f.item ? 1 << 23 : 0)
    | (f.itemBack ? 1 << 24 : 0)
    | (f.lift ? 1 << 25 : 0)
    | (f.lookBack ? 1 << 26 : 0)
}

export function unpackInput(p: number, into?: InputFrame): InputFrame {
  const f = into ?? emptyInput()
  f.steer = ((p & 0x3ff) - STEER_MAX) / STEER_MAX
  f.throttle = ((p >> 10) & 0x3f) / AXIS_MAX
  f.brake = ((p >> 16) & 0x3f) / AXIS_MAX
  f.drift = (p & (1 << 22)) !== 0
  f.item = (p & (1 << 23)) !== 0
  f.itemBack = (p & (1 << 24)) !== 0
  f.lift = (p & (1 << 25)) !== 0
  f.lookBack = (p & (1 << 26)) !== 0
  return f
}

/** Hands off the wheel. What a primed frame holds, and what a car coasts on. */
export const IDLE_PACKED = packInput(emptyInput())

// ---------------------------------------------------------------------------
// The policies
// ---------------------------------------------------------------------------

/**
 * THE STALL POLICY. Lockstep means everybody waits for the slowest, so the
 * only real question is how long and what the player is looking at.
 *
 * `inputDelay` ALREADY ABSORBS THE FIRST CHUNK FOR FREE. At d frames of delay
 * the pipeline holds d * 16.7ms of slack before a late input costs anything at
 * all -- 67ms at d=4, 200ms at d=12. So a stall that reaches this file is
 * already a hiccup the delay could not cover, which is why the announce
 * threshold can be short without flashing on ordinary jitter.
 *
 * ANNOUNCE AT 300ms. Below that a stall is indistinguishable from a dropped
 * render frame, and a banner that appears and vanishes inside a fifth of a
 * second is worse than the stall it describes: it reads as the UI being
 * broken rather than the network. 300ms is also about two retransmit round
 * trips on a bad-but-working link, so the common recoverable case never shows
 * a banner at all. What the player sees is the frozen race PLUS a named
 * reason -- "Waiting for Ada" -- because a race that silently freezes is the
 * one outcome with no explanation available to the person looking at it.
 *
 * DROP A HEALTHY-LOOKING LINK AT 5000ms. Long, deliberately. The data channel
 * is reliable and ordered, so a peer whose link is merely slow is still
 * DELIVERING -- their backlog is in flight and they will catch up by stepping
 * faster than real time. Ejecting them at two seconds would throw away races
 * that were about to resume. Five seconds is the point at which the other
 * seven players have stopped believing it will.
 *
 * DROP A DEAD LINK IMMEDIATELY. `PeerLink.dead` is the wire being gone --
 * `iceConnectionState: failed`, a closed channel, or `SILENCE_MS` with not
 * even a ping arriving. There is nothing to wait for and waiting only costs
 * the other seven. This is the split that matters: the 5000ms number is for
 * uncertainty, and when there is no uncertainty it does not apply.
 */
export const STALL_ANNOUNCE_MS = 300
export const STALL_DROP_MS = 5000

/**
 * THE STALL CLOCK COUNTS TIME THIS PAGE WAS AWAKE FOR, NOT WALL CLOCK, and
 * this constant is how the difference is measured.
 *
 * `beforeStep` is called every render frame, stalled or not, so the gap
 * between two calls is normally about 16ms and never more than a few tens. A
 * gap longer than this means OUR OWN main thread stopped -- a track being
 * built, shaders compiling, a long GC, a backgrounded tab -- and during it no
 * peer's input could have been processed no matter how healthy their link was.
 *
 * Counting that against the peer is how a host ejects a room for its own
 * hitch. tools/probe-netcode.mjs did exactly that, every run, because starting
 * a race under a software rasteriser blocks the main thread for seconds: the
 * five-second drop deadline expired during the load screen and the guest was
 * declared gone before the lights went out.
 *
 * A GAP LONGER THAN THIS IS DISCARDED ENTIRELY, not clamped to it. Clamping
 * was the first cut and it was still wrong: a page that freezes for three
 * seconds, runs one frame, freezes again and so on banks a quarter of a second
 * of "awake" time per freeze, so twenty freezes add up to the five-second drop
 * deadline and the host ejects a peer for its OWN load screen. Throwing the
 * whole interval away is the honest reading -- we have no idea what happened
 * during it, including whether the peer's inputs were sitting in a queue we
 * never got round to draining.
 *
 * 250ms is comfortably longer than any real frame and comfortably shorter than
 * any real hitch. The cost is that a page genuinely running below 4fps has a
 * stall clock that barely advances at all, which errs entirely toward
 * patience -- the right direction, and in any case a page at 4fps has worse
 * problems than the netcode.
 */
export const MAX_AWAKE_TICK_MS = 250

/**
 * How long a peer who has not yet sent ANYTHING is given.
 *
 * A SEPARATE, MUCH LONGER DEADLINE, AND IT IS NOT GENEROSITY. The host presses
 * Start and begins stepping immediately; every guest then has to swap the
 * circuit, build a track mesh, spawn eight vehicles and compile shaders before
 * it can publish its first input. On a phone loading Aetherion for the first
 * time that is comfortably more than five seconds, and under the ordinary
 * stall deadline the host ejects the entire room before the lights go out --
 * which tools/probe-netcode.mjs did, on every run, to a guest that was
 * perfectly healthy and merely loading.
 *
 * The two cases are genuinely different and deserve different words on screen:
 * "waiting for Ada" is a network hiccup mid-race, and "waiting for Ada to
 * load" is a player who has not arrived yet. `StallReport.loading` carries the
 * distinction so the UI can make it.
 *
 * Twenty seconds. Long enough for a cold load of the heaviest circuit on a
 * mid-range phone; short enough that a player who alt-tabbed away during the
 * loading screen does not hold seven people indefinitely. A dead WIRE is still
 * dropped immediately -- `PeerLink.dead` is a fact and this deadline is only
 * for uncertainty.
 */
export const LOAD_GRACE_MS = 20_000

/**
 * How many frames into a race still count as "everybody is still arriving".
 *
 * 240 frames is four seconds: the three-second countdown plus a moment. The
 * measurement that produced it: a guest publishes its first few inputs the
 * instant its runner exists, and THEN blocks for five seconds finishing the
 * first render of a circuit it has just loaded. That peer has spoken, so the
 * "never heard from" test above does not catch it, and the five-second
 * mid-race deadline ejected it -- a guest that was healthy, connected at 4ms,
 * and simply not finished loading. The probe reproduced it on every run.
 *
 * The justification for being patient here rather than everywhere: during the
 * countdown NOBODY IS DRIVING. Waiting costs the other seven players nothing
 * they can perceive, because there is nothing to perceive yet. Four seconds
 * later the race is live, a stall is a frozen car on a corner, and the tight
 * deadline is the right one.
 */
export const SETTLE_FRAMES = 240

/**
 * How often the state hash goes on the wire.
 *
 * EVERY 30 FRAMES, which is twice a second. The cost is absurd -- eight hex
 * characters, so under 100 bytes a second for a whole eight-player room -- and
 * the benefit is the detection latency. A divergence starts as two cars a
 * millimetre apart and becomes visible to the player in a second or two, when
 * one client shows an overtake the other does not. Detecting at 500ms means
 * the race is stopped before anybody has seen a lie; detecting every two
 * seconds means somebody has.
 *
 * `sendHash`/`onHash` are already in `RaceTransport`, so this costs nothing to
 * build and there is no reason to be stingy with it.
 */
export const HASH_EVERY = 30

/** How many local hashes to keep, so a peer's late hash can still be judged. */
const HASH_HISTORY = 40

// ---------------------------------------------------------------------------
// The scheduler
// ---------------------------------------------------------------------------

export interface StallReport {
  /** Slots whose input for the frame in question has not arrived. */
  waiting: readonly number[]
  /** How long we have been waiting on THIS frame. 0 when not stalled. */
  sinceMs: number
  /** True once `STALL_ANNOUNCE_MS` has passed: show the player a reason. */
  announce: boolean
  /** Slots the HOST should now declare dropped. Always empty on a guest. */
  expire: readonly number[]
  /** Of `waiting`, the ones who have never sent anything: still loading, not
   *  lagging. A different sentence on screen and a different deadline. */
  loading: readonly number[]
}

/** What the mesh thinks of a slot's wire, injected so the scheduler is pure. */
export type SlotHealth = (slot: number) => 'up' | 'down'

export interface SchedulerOptions {
  /** Grid slots driven by a human over the wire, INCLUDING the local one. */
  slots: readonly number[]
  localSlot: number
  /** Frames of delay, from `RaceStartPacket.inputDelay`. */
  inputDelay: number
  /** True on the host: only the host proposes drops. */
  authority: boolean
}

/**
 * The input tape, one row per networked slot, and the clock that decides when
 * a missing cell has been missing too long.
 *
 * PURE BUT FOR AN INJECTED `now`. Everything in here -- priming, readiness,
 * the stall timer, the drop proposal, the AI handover frame -- is arithmetic
 * over a small table, and tests/lockstep.test.ts drives all of it on fake
 * timers with no browser, no peer connection and no race.
 */
export class LockstepScheduler {
  readonly inputDelay: number
  readonly localSlot: number
  readonly slots: readonly number[]
  readonly authority: boolean

  /** slot -> frame -> packed input. */
  private readonly tape = new Map<number, Map<number, number>>()
  /** slot -> the frame from which this slot is driven by AI. Infinity = live. */
  private readonly ai = new Map<number, number>()
  /** slot -> highest frame we hold an input for. */
  private readonly high = new Map<number, number>()
  /** The frame we are currently stalled on, and since when. */
  private stallFrame = -1
  private stallSince = 0
  /** Frames below this have been stepped and can be forgotten. */
  private floor = 0

  constructor(opts: SchedulerOptions) {
    this.inputDelay = Math.max(1, Math.round(opts.inputDelay))
    this.localSlot = opts.localSlot
    this.slots = [...opts.slots]
    this.authority = opts.authority
    for (const s of this.slots) {
      const row = new Map<number, number>()
      // PRIME THE PIPELINE. Frames 1..d were never asked for -- the first
      // sample any client takes is published for frame 1 + d -- so without
      // this every race would stall on frame 1 for ever, waiting for inputs
      // that by construction do not exist.
      for (let f = 1; f <= this.inputDelay; f++) row.set(f, IDLE_PACKED)
      this.tape.set(s, row)
      this.ai.set(s, Infinity)
      this.high.set(s, this.inputDelay)
    }
  }

  /** The frame a sample taken now should be published for. */
  targetFrame(currentFrame: number): number {
    return currentFrame + this.inputDelay
  }

  /** Record an input, local or remote. Late and duplicate frames are ignored. */
  receive(slot: number, frame: number, packed: number): void {
    const row = this.tape.get(slot)
    if (!row || frame <= this.floor) return
    // A REPEAT NEVER OVERWRITES. The mailbox and the relay are both
    // at-least-once, and an input that changed value between two deliveries of
    // the same frame would be a desync with no other symptom.
    if (row.has(frame)) return
    row.set(frame, packed >>> 0)
    const h = this.high.get(slot) ?? 0
    if (frame > h) this.high.set(slot, frame)
  }

  /** Highest frame we hold any input for, over every slot. */
  get horizon(): number {
    let top = 0
    for (const v of this.high.values()) if (v > top) top = v
    return top
  }

  /** The frame from which a slot is AI, or Infinity while it is still a person. */
  aiFrom(slot: number): number { return this.ai.get(slot) ?? Infinity }

  /**
   * Hand a slot to the AI from `frame` onwards.
   *
   * THE FRAME IS THE POINT. Every client must substitute AI on the SAME frame
   * or they have diverged -- and the whole purpose of dropping a peer is to
   * keep the race running, so a drop that causes a desync is worse than the
   * silence it was fixing. That is why this takes a frame rather than a
   * timestamp and why only the host chooses it (see `dropFrameFor`).
   */
  applyDrop(slot: number, frame: number): void {
    const at = Math.max(1, Math.round(frame))
    const cur = this.ai.get(slot)
    if (cur !== undefined && at >= cur) return
    this.ai.set(slot, at)
    if (this.stallFrame >= at) { this.stallFrame = -1; this.stallSince = 0 }
  }

  /**
   * The frame from which a peer who has gone quiet becomes AI, chosen by the
   * host.
   *
   * ONE PLUS THE LAST FRAME *THAT PEER* WAS HEARD FOR -- not one plus the
   * horizon over everybody, which is what the first cut did and which
   * deadlocked every race the probe ran.
   *
   * THE BUG, because it is instructive. The global horizon includes the
   * HOST'S OWN published frames, which run `inputDelay` ahead of the frame
   * being stepped. So a peer last heard at frame 276 was declared AI from 280,
   * and frames 277, 278 and 279 were then in a hole: before the handover, so
   * the AI does not cover them, and after the last input, so nothing else
   * does. Every client waited for an input that would never arrive, for ever.
   * It looked exactly like a dead link and it was the drop mechanism itself.
   *
   * THE PROOF THAT THIS ONE IS SAFE is short enough to write down. A client
   * can only have STEPPED a frame it held every slot's input for. The host is
   * the relay, so no client holds an input for this peer that the host has not
   * seen. Therefore no client has stepped past this peer's last heard frame,
   * therefore one past it is in nobody's past, and every client can honour the
   * same announcement.
   *
   * It is also why no "hold the last input" fill rule is needed: there is no
   * gap left to fill. The departing peer's real inputs are used right up to the
   * last one they managed to send -- their car keeps driving on their own
   * steering for the `inputDelay` frames already in the pipe -- and the AI
   * picks up from the very next frame. A player whose wifi dies mid-corner
   * finishes the corner.
   */
  dropFrameFor(slot: number): number {
    return (this.high.get(slot) ?? this.inputDelay) + 1
  }

  /** Slots with no input for `frame` and no AI handover covering it. */
  missing(frame: number): number[] {
    const out: number[] = []
    for (const s of this.slots) {
      if (frame >= this.aiFrom(s)) continue
      if (this.tape.get(s)?.has(frame)) continue
      out.push(s)
    }
    return out
  }

  ready(frame: number): boolean {
    for (const s of this.slots) {
      if (frame >= this.aiFrom(s)) continue
      if (!this.tape.get(s)?.has(frame)) return false
    }
    return true
  }

  inputAt(slot: number, frame: number): number | undefined {
    return this.tape.get(slot)?.get(frame)
  }

  /**
   * Advance the stall clock for `frame` and say what should happen.
   *
   * Called every render frame, stalled or not, because the transition OUT of a
   * stall has to clear the banner and the transition in has to start a clock,
   * and a function only called while stalled cannot see either edge.
   */
  update(now: number, frame: number, health: SlotHealth): StallReport {
    const waiting = this.missing(frame)
    if (waiting.length === 0) {
      this.stallFrame = -1
      this.stallSince = 0
      return { waiting, sinceMs: 0, announce: false, expire: [], loading: [] }
    }
    if (this.stallFrame !== frame) { this.stallFrame = frame; this.stallSince = now }
    const sinceMs = now - this.stallSince

    /**
     * STILL ARRIVING, in either of the two ways that happen.
     *
     * Never heard from at all (`high` starts at `inputDelay` from the priming,
     * so anything above that is a real input they actually sent), or the race
     * has not got going yet -- see `SETTLE_FRAMES`. Both mean "they are
     * loading", both get the long deadline, and both get a different sentence
     * on screen from a peer who has dropped out mid-corner.
     */
    const settling = frame <= SETTLE_FRAMES
    const loading = waiting.filter((s) => settling || (this.high.get(s) ?? 0) <= this.inputDelay)

    const expire: number[] = []
    if (this.authority) {
      for (const s of waiting) {
        // THREE DEADLINES, AND THE SHORT ONE IS THE IMPORTANT ONE. A dead wire
        // is a fact and gets no grace at all; a live wire that has gone quiet
        // mid-race is a guess and gets five seconds; a peer who has not said
        // anything yet is loading a circuit and gets twenty. Collapsing any
        // two of them means either standing still for a tab that is
        // demonstrably closed, or ejecting somebody who was about to arrive.
        const deadline = loading.includes(s) ? LOAD_GRACE_MS : STALL_DROP_MS
        if (health(s) === 'down' || sinceMs >= deadline) expire.push(s)
      }
    }
    return { waiting, sinceMs, announce: sinceMs >= STALL_ANNOUNCE_MS, expire, loading }
  }

  /**
   * Frame `frame` has been stepped. Forget what can be forgotten.
   *
   * The window kept behind the play head is `inputDelay * 4` frames, which is
   * nothing (a few hundred numbers) and exists only so a late duplicate of a
   * frame we have already stepped is recognised as a duplicate rather than
   * re-inserted as a new input for a frame that will never be stepped again.
   */
  commit(frame: number): void {
    const keep = frame - this.inputDelay * 4
    if (keep <= this.floor) return
    this.floor = keep
    for (const row of this.tape.values()) {
      for (const f of row.keys()) if (f < keep) row.delete(f)
    }
  }
}

// ---------------------------------------------------------------------------
// The desync detector
// ---------------------------------------------------------------------------

/**
 * THE DESYNC POLICY: DETECT FROM THE HASH, HALT THE ROUND, KEEP THE SERIES.
 *
 * The argument, because both halts and continues have real cases.
 *
 * THERE IS NO SUCH THING AS A SMALL DESYNC IN A DETERMINISTIC SIM. Divergence
 * is not a rendering artefact that decays; it is amplified. A 1e-4 difference
 * in one car's yaw becomes a different line into the corner, becomes a
 * collision on one client and not the other, becomes a different finishing
 * order within seconds. So "continue, it is probably minor" is not available:
 * the thing that diverges IS the result.
 *
 * CONTINUING THEREFORE MEANS SCORING A RACE WHOSE RESULT IS A LIE, and with
 * `SeriesPlan` that lie is durable -- a five-round championship whose round 2
 * diverged carries corrupt standings into rounds 3, 4 and 5, and every player
 * sees a different table. That is strictly worse than stopping.
 *
 * HALTING THE WHOLE LOBBY is the other overreaction. The peers are fine, the
 * connections are fine, and throwing eight people back to the title screen for
 * one bad round costs the rest of the evening.
 *
 * So: the ROUND ends the moment divergence is seen, it is VOID (nobody scores,
 * `finishes` records the round as unplayed exactly as it does for a player who
 * missed it), everybody is told the same sentence, and the lobby goes back to
 * the room screen with the series intact. The players lose two minutes; the
 * standings stay true.
 *
 * THE HOST IS THE REFEREE, and not because the host is more likely to be
 * right. Somebody has to be, and eight clients independently deciding who
 * diverged is itself a thing they can disagree about. The host compares every
 * peer's hash against its own and broadcasts one verdict.
 */
export class DesyncWatch {
  /** frame -> our own hash. A short ring; see HASH_HISTORY. */
  private readonly mine = new Map<number, string>()
  /** frame -> slot -> their hash, for hashes that arrived before ours. */
  private readonly theirs = new Map<number, Map<number, string>>()
  private readonly order: number[] = []

  /** Slots whose hash has ever disagreed with ours, and at which frame. */
  readonly diverged = new Map<number, number>()

  recordLocal(frame: number, hash: string): readonly number[] {
    this.mine.set(frame, hash)
    this.order.push(frame)
    while (this.order.length > HASH_HISTORY) {
      const old = this.order.shift()
      if (old !== undefined) { this.mine.delete(old); this.theirs.delete(old) }
    }
    const pending = this.theirs.get(frame)
    if (!pending) return []
    const bad: number[] = []
    for (const [slot, h] of pending) if (h !== hash) bad.push(slot)
    this.theirs.delete(frame)
    for (const s of bad) if (!this.diverged.has(s)) this.diverged.set(s, frame)
    return bad
  }

  /**
   * A peer's hash. Returns the slots that have just been proved divergent.
   *
   * A HASH FOR A FRAME WE HAVE NOT REACHED IS NOT A DISAGREEMENT. With
   * `inputDelay` frames of slack a peer is routinely a few frames ahead, so
   * their hash for frame 900 can arrive before we have stepped 900. It is
   * parked and judged when we get there, rather than being counted as a
   * mismatch -- which is the difference between a detector and a false-alarm
   * generator.
   *
   * A hash for a frame that has already fallen out of the ring is DISCARDED
   * rather than treated as suspicious. A peer that far behind is a stall, and
   * the stall policy already owns that case.
   */
  recordPeer(slot: number, frame: number, hash: string): readonly number[] {
    const ours = this.mine.get(frame)
    if (ours === undefined) {
      if (this.order.length > 0 && frame < this.order[0]) return []
      const row = this.theirs.get(frame) ?? new Map<number, string>()
      row.set(slot, hash)
      this.theirs.set(frame, row)
      return []
    }
    if (ours === hash) return []
    if (!this.diverged.has(slot)) this.diverged.set(slot, frame)
    return [slot]
  }

  /** Our own hash at a frame, for the log line that names both. */
  localAt(frame: number): string | undefined { return this.mine.get(frame) }
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/**
 * What the transport has to be able to do for the runner. A structural subset
 * of `RaceTransport`, declared here so the runner can be tested against a
 * twenty-line fake rather than against a peer connection.
 */
export interface RunnerTransport {
  sendInput(frame: number, packed: number): void
  sendHash(frame: number, hash: string): void
  onInput: (playerId: string, frame: number, packed: number) => void
  onHash: (playerId: string, frame: number, hash: string) => void
  onDropped: (playerId: string) => void
}

export type RunnerVerdict =
  /** Stepping normally. */
  | 'racing'
  /** Holding, waiting for somebody. `waitingFor` names them. */
  | 'waiting'
  /** The round is over because the clients disagree. Nothing more is stepped. */
  | 'desync'
  /**
   * THE ROOM DROPPED US, from a frame we had already stepped.
   *
   * A dropped peer is normally one whose link is gone, so they never hear the
   * announcement and it does not matter what they would have done with it. The
   * case this exists for is the other one: the host decided we were gone, we
   * disagreed, and our connection came back. We have already simulated frames
   * that everybody else ran under AI, so our race and theirs are different
   * races and nothing can reconcile them.
   *
   * It is deliberately NOT 'desync', because it is a different sentence: a
   * desync means the round is void for everybody, and this means the round
   * carried on perfectly well without us. The room is fine; we are out of it.
   */
  | 'ejected'

export interface RunnerOptions {
  race: Race
  transport: RunnerTransport
  /** Grid slot -> player id, for every networked HUMAN slot including local. */
  players: ReadonlyMap<number, string>
  localSlot: number
  inputDelay: number
  /** True on the host. Only the host proposes drops and judges hashes. */
  authority: boolean
  /** Is this slot's wire up? Supplied by the mesh. */
  health?: SlotHealth
  now?: () => number
  /** Host only: announce a drop to the room. Called once per dropped slot. */
  announceDrop?: (slot: number, playerId: string, fromFrame: number) => void
  /** Host only: announce that the round is void. */
  announceDesync?: (frame: number, slots: readonly number[]) => void
}

/**
 * Binds a `Race` to a transport and decides, every frame, whether it may step.
 *
 * WHY THIS IS NOT INSIDE game/main.ts. The render loop already owns the
 * accumulator, the sub-step cap, the interpolation snapshot and the event
 * carry; adding a network state machine to it would put four unrelated
 * concerns in one while-loop and make none of them testable. The integration
 * is ONE LINE -- see `beforeStep` -- and everything it decides is exercised
 * here on fake timers with no browser.
 *
 * AI SUBSTITUTION GOES THROUGH `RacerState.isAI` AND NOTHING ELSE, which is
 * the mechanism `startMultiplayer` already uses for a slot nobody is sitting
 * in: sim/race.ts calls `stepAI` for exactly the racers with `isAI` true, at
 * the `aiSkill` the packet published (or `standInSkill` derived). So a mid-race
 * drop is not a second mechanism, it is the SAME one, flipped later:
 *
 *   constructor  -- networked human slots get `isAI = false`, so the sim reads
 *                   their transported input instead of driving them
 *   on a drop    -- that slot gets `isAI = true` again on an agreed frame, and
 *                   `stepAI` takes the wheel at the skill it was always going
 *                   to drive at
 *
 * `isLocal` is untouched. It is what the HUD, the camera and the nameplates
 * resolve the player by, and it must stay true for exactly one car.
 */
export class LockstepRunner {
  readonly scheduler: LockstepScheduler
  readonly desync = new DesyncWatch()
  verdict: RunnerVerdict = 'racing'
  /** Player names or ids we are currently blocked on. Read by the HUD. */
  waitingFor: readonly string[] = []
  /** True when everybody we are waiting on has never sent anything: they are
   *  still loading the circuit, which is a different sentence on screen. */
  waitingToLoad = false
  /** Frame the divergence was found at, once `verdict` is 'desync'. */
  desyncFrame = -1

  private readonly race: Race
  private readonly transport: RunnerTransport
  private readonly players: ReadonlyMap<number, string>
  private readonly slotOf = new Map<string, number>()
  private readonly localSlot: number
  private readonly authority: boolean
  private readonly health: SlotHealth
  private readonly now: () => number
  private readonly opts: RunnerOptions
  /** Reused so a 60Hz loop allocates no InputFrame. */
  private readonly scratch: InputFrame[] = []
  /** Highest frame we have published a local input for. */
  private published = 0
  /** Highest frame we have hashed. */
  private hashed = 0
  private readonly dropped = new Set<number>()
  /** Milliseconds this page has been awake for. See `MAX_AWAKE_TICK_MS`. */
  private awake = 0
  private lastCall = 0

  constructor(opts: RunnerOptions) {
    this.opts = opts
    this.race = opts.race
    this.transport = opts.transport
    this.players = opts.players
    this.localSlot = opts.localSlot
    this.authority = opts.authority
    this.now = opts.now ?? (() => Date.now())
    this.health = opts.health ?? (() => 'up')
    for (const [slot, id] of opts.players) this.slotOf.set(id, slot)

    this.scheduler = new LockstepScheduler({
      slots: [...opts.players.keys()],
      localSlot: opts.localSlot,
      inputDelay: opts.inputDelay,
      authority: opts.authority,
    })

    // THE HANDOVER, SET UP ONCE. Every networked human stops being an AI car
    // on this client; every other slot stays exactly the AI it already was.
    // From here `isAI` is re-derived every frame from the agreed handover
    // frame and nothing else -- see `syncAI`.
    for (const slot of opts.players.keys()) {
      const r = this.race.state.racers[slot]
      if (!r) continue
      r.isAI = false
      // `Race.step` reads `this.inputs[id]` unconditionally for a non-AI racer,
      // so every networked slot must hold SOMETHING from frame zero. Neutral,
      // because the countdown has not started and nobody is driving yet.
      this.race.setInput(slot, unpackInput(IDLE_PACKED, this.frameFor(slot)))
    }

    this.transport.onInput = (playerId, frame, packed) => {
      const slot = this.slotOf.get(playerId)
      if (slot === undefined) return
      this.scheduler.receive(slot, frame, packed)
    }
    this.transport.onHash = (playerId, frame, hash) => {
      const slot = this.slotOf.get(playerId)
      if (slot === undefined) return
      const bad = this.desync.recordPeer(slot, frame, hash)
      if (bad.length > 0) this.declareDesync(frame, bad)
    }
    this.transport.onDropped = (playerId) => {
      const slot = this.slotOf.get(playerId)
      if (slot === undefined) return
      // A transport-level drop on a GUEST is only a hint that the wire is gone;
      // the frame still has to come from the host, because the frame is what
      // everybody has to agree on. On the host it is the trigger to decide.
      if (this.authority) this.expire([slot])
    }
  }

  private frameFor(slot: number): InputFrame {
    return this.scratch[slot] ?? (this.scratch[slot] = emptyInput())
  }

  /** Advance the awake clock. See `MAX_AWAKE_TICK_MS` for why it is not
   *  simply `Date.now()`. */
  private tickAwake(): number {
    const now = this.now()
    if (this.lastCall !== 0) {
      const dt = now - this.lastCall
      if (dt <= MAX_AWAKE_TICK_MS) this.awake += dt
    }
    this.lastCall = now
    return this.awake
  }

  /**
   * THE ONE CALL game/main.ts MAKES, inside its fixed-step loop, in place of
   * `race.setInput(localId, frame)`.
   *
   *   if (this.net) { if (!this.net.beforeStep(frame)) break }
   *   else this.race.setInput(this.localId, frame)
   *
   * Returns false when the sim must NOT be stepped this tick. The caller
   * breaks out of its sub-step loop and draws the frame it already has, which
   * is what a lockstep stall looks like: the race stands still and the UI
   * keeps running.
   */
  beforeStep(local: InputFrame): boolean {
    if (this.verdict === 'desync' || this.verdict === 'ejected') return false
    const clock = this.tickAwake()

    const done = this.race.state.frame
    const next = done + 1

    // --- publish -----------------------------------------------------------
    // Once per frame, for a frame `inputDelay` ahead. Republishing would be
    // harmless (the scheduler ignores repeats) but would double the wire rate.
    const target = this.scheduler.targetFrame(next)
    if (target > this.published) {
      const packed = packInput(local)
      this.published = target
      this.scheduler.receive(this.localSlot, target, packed)
      this.transport.sendInput(target, packed)
    }

    // --- hash the frame we just finished ------------------------------------
    if (done > this.hashed && done % HASH_EVERY === 0) {
      this.hashed = done
      const h = this.race.hash()
      const bad = this.desync.recordLocal(done, h)
      this.transport.sendHash(done, h)
      if (bad.length > 0) { this.declareDesync(done, bad); return false }
    }

    // --- may we step? -------------------------------------------------------
    const report = this.scheduler.update(clock, next, this.health)
    if (report.expire.length > 0) this.expire(report.expire)

    if (!this.scheduler.ready(next)) {
      this.verdict = 'waiting'
      this.waitingFor = report.announce
        ? report.waiting.map((s) => this.players.get(s) ?? `slot ${s}`)
        : []
      this.waitingToLoad = report.loading.length > 0 && report.loading.length === report.waiting.length
      return false
    }
    this.verdict = 'racing'
    this.waitingFor = []
    this.waitingToLoad = false

    // --- apply --------------------------------------------------------------
    this.syncAI(next)
    for (const slot of this.players.keys()) {
      if (next >= this.scheduler.aiFrom(slot)) continue
      const packed = this.scheduler.inputAt(slot, next)
      if (packed === undefined) continue
      // THE LOCAL SLOT GOES THROUGH THE SAME PATH. Quantised on the way out,
      // unquantised here, so this client steps the identical value every other
      // client will. See the note at the top of the file.
      this.race.setInput(slot, unpackInput(packed, this.frameFor(slot)))
    }
    this.scheduler.commit(next)
    return true
  }

  /**
   * Hand slots to the AI, and -- on the host -- tell the room which frame.
   *
   * Idempotent per slot: a peer whose link fails and whose inputs then time
   * out arrives here twice, and announcing two different frames for one player
   * is exactly the disagreement this is supposed to prevent.
   */
  private expire(slots: readonly number[]): void {
    for (const slot of slots) {
      if (this.dropped.has(slot)) continue
      // PER SLOT, because the answer is a property of the peer that went away
      // and not of the room. See `dropFrameFor`.
      const frame = this.scheduler.dropFrameFor(slot)
      this.dropped.add(slot)
      // `isAI` is NOT written here: it is derived from this frame by `syncAI`
      // on the step that actually reaches it, so every client flips on the
      // same frame rather than on the frame their copy of the news arrived.
      this.scheduler.applyDrop(slot, frame)
      const id = this.players.get(slot)
      if (id && this.authority) this.opts.announceDrop?.(slot, id, frame)
    }
  }

  /** A guest applying the host's verdict. */
  acceptDrop(playerId: string, frame: number): void {
    const slot = this.slotOf.get(playerId)
    if (slot === undefined || this.dropped.has(slot)) return
    /**
     * BEING TOLD *WE* WERE DROPPED, FROM A FRAME WE HAVE ALREADY PASSED.
     *
     * The host picks the handover frame from the last input it heard from the
     * departing peer, which no OTHER client can have stepped past -- that is
     * the safety argument in `dropFrameFor`. It does not hold for the dropped
     * peer itself, which by construction has its own inputs for `inputDelay`
     * frames beyond anything the host received, and may well have stepped
     * them. Applying the handover here would rewrite frames we have already
     * simulated; ignoring it would leave us racing a field nobody else has.
     * Neither is a race, so we say so. See `RunnerVerdict.ejected`.
     */
    if (slot === this.localSlot && frame <= this.race.state.frame) {
      console.warn(`lockstep: dropped from frame ${frame}, which this client has `
        + `already stepped (now ${this.race.state.frame}); leaving the round`)
      this.verdict = 'ejected'
      return
    }
    this.dropped.add(slot)
    this.scheduler.applyDrop(slot, frame)
  }

  /** A guest applying the host's desync verdict. */
  acceptDesync(frame: number): void {
    this.verdict = 'desync'
    this.desyncFrame = frame
  }

  private declareDesync(frame: number, slots: readonly number[]): void {
    if (this.verdict === 'desync') return
    this.verdict = 'desync'
    this.desyncFrame = frame
    const names = slots.map((s) => this.players.get(s) ?? `slot ${s}`)
    console.warn(`lockstep: desync at frame ${frame}; ours ${this.desync.localAt(frame)}`
      + `, disagreeing: ${names.join(', ')}`)
    if (this.authority) this.opts.announceDesync?.(frame, slots)
  }

  /**
   * `isAI` is a pure function of the frame about to run and the agreed
   * handover frames. Recomputed every step rather than written when the
   * announcement lands.
   *
   * THE BUG THIS EXISTS FOR, found by the probe against two real browsers.
   * Setting `r.isAI = true` the moment the drop message arrived meant the flip
   * happened at a DIFFERENT FRAME on every client -- whenever their copy of
   * the message got there. `Race.step` calls `stepAI` for exactly the racers
   * with `isAI`, and `stepAI` draws from that racer's `aiRng`; so two clients
   * that flipped one frame apart made a different NUMBER of draws and their
   * AI streams parted company from that point on. During the countdown it is
   * worse still: `aiRocketStart` draws from the SHARED race rng, so one extra
   * call shifts every subsequent random decision in the whole race.
   *
   * The two clients then diverged perfectly quietly, and the desync detector
   * caught it half a second later -- the machinery meant to keep a race alive
   * producing the exact failure it exists to prevent.
   */
  private syncAI(frame: number): void {
    for (const slot of this.players.keys()) {
      const r = this.race.state.racers[slot]
      if (!r) continue
      const ai = frame >= this.scheduler.aiFrom(slot)
      if (r.isAI !== ai) r.isAI = ai
    }
  }

  /** Slots currently driven by AI because their player went away. */
  get droppedSlots(): readonly number[] { return [...this.dropped] }
}
