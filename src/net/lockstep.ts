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

/**
 * How far AHEAD of the announcing frame a returning player's slot becomes a
 * person again.
 *
 * THE MIRROR IMAGE OF `dropFrameFor`, AND IT HAS TO BE ONE. A drop is safe on
 * `lastHeard + 1` because nobody can have stepped past it. A RESTORE has the
 * opposite hazard: the returning client has to publish inputs for the frame it
 * becomes human on, and it cannot publish for a frame the room has already
 * stepped. So the handover has to be far enough AHEAD that its publication can
 * get there first -- `inputDelay` frames for the pipeline, plus this for the
 * announcement's own flight time and for the replay the returning client is
 * still finishing when the number is chosen.
 *
 * Sixty frames is a second. Generous, and the generosity is free: the slot is
 * driven by the AI for that second exactly as it was for the ten before it, so
 * nothing stalls and nobody waits. Being a frame too EARLY, by contrast, is a
 * room that stalls for ever on an input that can never be published, which is
 * the deadlock `dropFrameFor`'s comment describes from the other direction.
 */
export const REJOIN_LEAD_FRAMES = 60

/**
 * One row of the input tape, on the wire.
 *
 * DENSE AND FRAME-INDEXED rather than a list of pairs, because the thing it
 * carries is a contiguous run: `packed[i]` is the input for frame `from + i`.
 * A hole is `-1`, which cannot collide with a real value (`packInput` returns
 * 27 unsigned bits) and which the reader skips rather than storing.
 *
 * Holes are normal and are not damage: a client's retained window starts
 * part-way through a peer's row, and a peer who was AI for a stretch published
 * nothing at all for it.
 */
export interface TapeRow {
  slot: number
  from: number
  packed: readonly number[]
}

/** A hole. Outside the range of `packInput`, which is unsigned and 27 bits. */
const NO_INPUT = -1

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
  /**
   * Keep every frame of the round rather than a window behind the play head.
   *
   * WHAT A REJOIN COSTS, AND WHY IT IS A FLAG RATHER THAN THE DEFAULT. A
   * player who comes back cannot be caught up with a position snapshot: this
   * sim's state is a `Race` with its own rng, eight `aiRng`s and a stall
   * watchdog, none of which is serialisable, and inventing a serialisation
   * would be inventing a second definition of the race. What CAN be sent is
   * the thing the protocol already carries -- the inputs -- and a client that
   * has the inputs from frame 1 can rebuild the state by replaying them,
   * because that is the property the whole file rests on.
   *
   * So somebody has to keep them. The host does, because the host is the only
   * party who has every slot's row by construction. The cost is one number per
   * networked human per frame: a four-player, two-minute round is 7,200 frames
   * x 4 rows = 28,800 numbers, which as a dense `number[]` per slot is about
   * 230 KB. Guests keep the ordinary window and pay nothing.
   */
  keepRound?: boolean
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
  /** Not readonly: host migration moves the role, and the scheduler's copy is
   *  what actually returns the `expire` list. See `LockstepRunner.setAuthority`. */
  authority: boolean

  /** slot -> frame -> packed input. */
  private readonly tape = new Map<number, Map<number, number>>()
  /**
   * slot -> the frames at which that slot TOGGLES between person and AI.
   *
   * A LIST RATHER THAN ONE NUMBER, BECAUSE A REJOIN IS A SECOND TOGGLE. The
   * first cut held `ai: Map<slot, frame>` -- the frame a slot becomes AI, or
   * Infinity -- which says everything a drop needs and cannot say the other
   * half of `RaceTransport.rejoin`: that the same slot is a PERSON again from
   * a later frame. Two numbers would then have been two special cases, and a
   * player who blips twice would have had nowhere to put the third.
   *
   * So: an ascending list, and parity decides. `[]` is a person throughout,
   * `[400]` is AI from 400, `[400, 900]` is AI for frames 400..899 and a
   * person again from 900. `aiAt` counts the toggles at or below a frame and
   * asks whether that count is odd -- which is a pure function of the frame
   * and the agreed list, so every client flips on the same frame without
   * anybody storing a boolean that could be written at a different moment.
   */
  private readonly spans = new Map<number, number[]>()
  /** slot -> highest frame we hold an input for. */
  private readonly high = new Map<number, number>()
  /**
   * slot -> every input of the round, densely, when `keepRound` is on.
   *
   * SEPARATE FROM `tape`, so the hot path is untouched: `ready`, `missing` and
   * `inputAt` all read the pruned Map exactly as they did, and this is a
   * write-only array the rejoin path reads. Indexed by frame, `NO_INPUT` for a
   * frame nobody published (a slot that was AI, or a gap before we joined).
   */
  private readonly archive = new Map<number, number[]>()
  private readonly keepRound: boolean
  /** The frame we are currently stalled on, and since when. */
  private stallFrame = -1
  private stallSince = 0
  /** Frames below this have been stepped and can be forgotten. */
  private floor = 0
  /**
   * Frames up to here are treated as "everybody is still arriving".
   *
   * STARTS AT `SETTLE_FRAMES` AND IS PUSHED FORWARD BY A REPAIR. The argument
   * for the long deadline at the start of a race is that nobody has published
   * anything yet and a client may still be building a circuit; after a host
   * migration it is the same argument with different nouns. Every survivor has
   * just torn down its peer connections, re-handshaked through a polled
   * mailbox, merged an input table and back-filled its own row, and the peer
   * that took a second longer over it is a peer that was working, not one that
   * has gone.
   *
   * The probe caught the alternative: a new host finished its own repair,
   * resumed, and five seconds later declared the other survivor dead -- for
   * being slow at exactly the thing the new host had just made it do.
   */
  private settleTo = SETTLE_FRAMES

  constructor(opts: SchedulerOptions) {
    this.inputDelay = Math.max(1, Math.round(opts.inputDelay))
    this.localSlot = opts.localSlot
    this.slots = [...opts.slots]
    this.authority = opts.authority
    this.keepRound = opts.keepRound === true
    for (const s of this.slots) {
      const row = new Map<number, number>()
      // PRIME THE PIPELINE. Frames 1..d were never asked for -- the first
      // sample any client takes is published for frame 1 + d -- so without
      // this every race would stall on frame 1 for ever, waiting for inputs
      // that by construction do not exist.
      for (let f = 1; f <= this.inputDelay; f++) row.set(f, IDLE_PACKED)
      this.tape.set(s, row)
      this.spans.set(s, [])
      this.high.set(s, this.inputDelay)
      if (this.keepRound) {
        const arch: number[] = []
        for (let f = 1; f <= this.inputDelay; f++) arch[f] = IDLE_PACKED
        this.archive.set(s, arch)
      }
    }
  }

  /** The frame a sample taken now should be published for. */
  targetFrame(currentFrame: number): number {
    return currentFrame + this.inputDelay
  }

  /** Record an input, local or remote. Late and duplicate frames are ignored. */
  receive(slot: number, frame: number, packed: number): void {
    const row = this.tape.get(slot)
    if (!row) return
    const arch = this.archive.get(slot)
    // THE ARCHIVE TAKES A FRAME THE WINDOW HAS ALREADY FORGOTTEN, which the
    // window must still refuse. A duplicate arriving after `commit` has pruned
    // its frame is exactly the case the pruning window exists to recognise;
    // but the rejoin tape has to be complete, and a frame missing from it is a
    // frame the returning client cannot replay.
    if (arch && frame >= 1 && arch[frame] === undefined) arch[frame] = packed >>> 0
    if (frame <= this.floor) return
    // A REPEAT NEVER OVERWRITES. The mailbox and the relay are both
    // at-least-once, and an input that changed value between two deliveries of
    // the same frame would be a desync with no other symptom.
    if (row.has(frame)) return
    row.set(frame, packed >>> 0)
    const h = this.high.get(slot) ?? 0
    if (frame > h) this.high.set(slot, frame)
  }

  /**
   * Every input this client holds for `slot`, from `from` up to its highest.
   *
   * THE UNIT OF REPAIR. Migration and rejoin both come down to "get the
   * missing cells of the table to the client that is missing them", and this
   * is the table in the one shape that is safe to merge: `(slot, frame)` is
   * immutable everywhere -- `receive` refuses to overwrite -- so two clients
   * can never hold different values for one cell, and a union of rows from
   * several clients is therefore well defined no matter who sends what.
   */
  row(slot: number, from = 1): TapeRow | null {
    const arch = this.archive.get(slot)
    const map = this.tape.get(slot)
    if (!arch && !map) return null
    const top = this.high.get(slot) ?? 0
    const start = Math.max(1, Math.round(from))
    if (top < start) return { slot, from: start, packed: [] }
    const packed: number[] = []
    for (let f = start; f <= top; f++) {
      const v = arch ? arch[f] : map?.get(f)
      packed.push(v === undefined ? NO_INPUT : v)
    }
    return { slot, from: start, packed }
  }

  /**
   * Every slot's row, from the oldest frame this client can still speak for.
   *
   * THE WHOLE WINDOW AND EVERY SLOT, not just our own row, and that is the
   * answer to the one hazard host migration actually has. The dead host was a
   * RELAY: it could have forwarded slot 5's input for frame 812 to one guest
   * and died before forwarding it to another, so the survivors' tables differ
   * in cells that belong to neither of them. Each of them contributing only
   * its own row would leave exactly those cells missing for ever, and the
   * frame they are missing from is a frame somebody has already stepped.
   *
   * Contributing the WHOLE window makes the union complete by construction:
   * any cell any survivor holds, every survivor ends up holding. It is also
   * nearly free -- see `snapshot`'s caller for the measured size.
   */
  snapshot(from: number): TapeRow[] {
    const out: TapeRow[] = []
    for (const s of this.slots) {
      const r = this.row(s, from)
      if (r && r.packed.length > 0) out.push(r)
    }
    return out
  }

  /** Merge rows from a peer. Cells we already hold win, which is to say they
   *  are identical, which is to say it does not matter -- see `row`. */
  absorb(rows: readonly TapeRow[]): void {
    for (const r of rows) {
      if (!this.tape.has(r.slot)) continue
      for (let i = 0; i < r.packed.length; i++) {
        const v = r.packed[i]
        if (v === NO_INPUT || v === undefined) continue
        this.receive(r.slot, r.from + i, v)
      }
    }
  }

  /** The oldest frame this client can still speak for. Below it the window has
   *  been pruned and the archive, if there is one, starts at 1. */
  get retainedFrom(): number {
    return this.archive.size > 0 ? 1 : this.floor + 1
  }

  /** Highest frame we hold an input for, for one slot. */
  highestFor(slot: number): number { return this.high.get(slot) ?? 0 }

  /** Treat everything up to `frame` as "still arriving". Monotonic, so a
   *  second repair cannot shorten the grace a first one bought. */
  settleThrough(frame: number): void {
    if (frame > this.settleTo) this.settleTo = Math.round(frame)
  }

  /** Highest frame we hold any input for, over every slot. */
  get horizon(): number {
    let top = 0
    for (const v of this.high.values()) if (v > top) top = v
    return top
  }

  /** The frame from which a slot FIRST became AI, or Infinity if never. Kept
   *  as the name the drop tests and the probe already read. */
  aiFrom(slot: number): number {
    const t = this.spans.get(slot)
    return t && t.length > 0 ? t[0] : Infinity
  }

  /**
   * Is this slot driven by the AI on this frame?
   *
   * A PURE FUNCTION OF THE FRAME AND THE AGREED TOGGLE LIST, which is the only
   * reason a rejoin can be made safe at all. `syncAI` calls it every step, so
   * `isAI` is re-derived rather than written when a message lands -- the bug
   * that comment describes (two clients flipping one frame apart, making a
   * different number of `aiRng` draws, diverging silently) is exactly as fatal
   * coming back as it is going away.
   */
  aiAt(slot: number, frame: number): boolean {
    const t = this.spans.get(slot)
    if (!t || t.length === 0) return false
    let n = 0
    for (const f of t) { if (frame >= f) n++; else break }
    return (n & 1) === 1
  }

  /** The toggle list for a slot, so a host can republish the agreed history to
   *  a client that was not there when it was decided. */
  handover(slot: number): readonly number[] { return this.spans.get(slot) ?? [] }

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
    if (this.toggle(slot, frame, true)) {
      const at = Math.max(1, Math.round(frame))
      if (this.stallFrame >= at) { this.stallFrame = -1; this.stallSince = 0 }
    }
  }

  /**
   * Give a slot back to its player from `frame` onwards. The reverse of a drop
   * and, deliberately, the SAME mechanism.
   *
   * THE SYMMETRY IS THE WHOLE REQUIREMENT. A drop is agreed on a frame so that
   * every client makes the same number of `stepAI` draws; a restore has
   * exactly the same requirement in the other direction, because a client that
   * gives the wheel back one frame early makes one FEWER draw than everybody
   * else and its AI stream parts company from theirs at that point. There is
   * no asymmetry to exploit: this is `applyDrop` with the parity the other way
   * round.
   *
   * The frame comes from the host and is far enough ahead that the returning
   * player's own inputs can arrive first -- see `REJOIN_LEAD_FRAMES`.
   */
  applyRestore(slot: number, frame: number): void {
    this.toggle(slot, frame, false)
  }

  /**
   * Append a toggle, if it is both the right KIND and in the future of the
   * last one.
   *
   * MONOTONIC AND IDEMPOTENT, for the reason `applyDrop` was before: the
   * mailbox, the relay and the peer-state callback can all deliver the same
   * news twice, and two toggles for one event would invert the parity for the
   * rest of the round -- a slot that silently stopped being AI because its
   * drop arrived twice.
   */
  private toggle(slot: number, frame: number, toAI: boolean): boolean {
    const t = this.spans.get(slot)
    if (!t) return false
    const at = Math.max(1, Math.round(frame))
    const isAI = (t.length & 1) === 1
    if (isAI === toAI) return false
    if (t.length > 0 && at <= t[t.length - 1]) return false
    t.push(at)
    return true
  }

  /** Replace a slot's agreed toggle history wholesale. Migration only: a new
   *  host republishes the list so a client that missed an announcement while
   *  the old host was dying ends the repair holding the same one. */
  setHandover(slot: number, frames: readonly number[]): void {
    const t = this.spans.get(slot)
    if (!t) return
    const next = [...frames].map((f) => Math.max(1, Math.round(f))).sort((a, b) => a - b)
    // Ascending and strictly increasing, or the parity walk is meaningless.
    const clean: number[] = []
    for (const f of next) if (clean.length === 0 || f > clean[clean.length - 1]) clean.push(f)
    t.length = 0
    t.push(...clean)
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
      if (this.aiAt(s, frame)) continue
      if (this.tape.get(s)?.has(frame)) continue
      out.push(s)
    }
    return out
  }

  ready(frame: number): boolean {
    for (const s of this.slots) {
      if (this.aiAt(s, frame)) continue
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
    const settling = frame <= this.settleTo
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

  /**
   * THE WINDOW A MIGRATION HAS TO REPUBLISH, AND WHY IT IS BOUNDED.
   *
   * When the host dies every survivor is stopped at a frame it could step, and
   * those frames DIFFER -- each got as far as the inputs the dead relay had
   * managed to hand it. The new host has to bring the room to one frame, which
   * means republishing history, and the question is how far back.
   *
   * THE BOUND IS `inputDelay + 1` FRAMES, and the proof is three lines.
   * Let R be the furthest frame any survivor stepped, and let j be any other
   * survivor. Whoever stepped R held EVERY live slot's input for R, j's
   * included. j published its input for frame R when its own play head was at
   * frame R - d - 1 (`targetFrame` is `frame + 1 + d`). A client cannot
   * publish for a frame it has not reached, so j had stepped at least
   * R - d - 1. Therefore no survivor is more than d + 1 frames behind R, and
   * `d` is clamped to 12 by `inputDelayFor` -- so the worst case is thirteen
   * frames, 217 milliseconds of race.
   *
   * What is actually SENT is this: the whole retained window, `4d` frames,
   * because that is what `commit` has kept anyway and the difference between
   * 13 numbers and 49 numbers per slot is not worth a second code path. At
   * eight slots and d = 12 that is under 400 integers, about 3 KB of JSON --
   * one packet, once, per survivor.
   *
   * It also answers the hazard that a bound alone does not: an input the dead
   * host relayed to some clients and not others is in SOMEBODY's window, so
   * the union of everybody's windows has it. See `snapshot`.
   */
  get repairWindow(): number { return this.inputDelay * 4 }
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
  /**
   * The runner introduces itself, if the transport wants to know.
   *
   * WHY THE RUNNER REGISTERS RATHER THAN BEING HANDED OVER. A host migration
   * is run by `net/live.ts` -- it owns the signalling mailbox and the peer
   * connections -- and every decision it makes needs the input table, which
   * lives in here. The obvious wiring is a line in game/main.ts handing one to
   * the other, next to the four callbacks it already wires; but a repair that
   * silently does nothing because somebody forgot that line is a repair that
   * fails in exactly the situation nobody is watching.
   *
   * The runner already HAS the transport -- it is a constructor argument --
   * so it can do the introduction itself, once, and the wiring cannot be
   * forgotten. Optional, because `Tap` in the unit tests is a twenty-line fake
   * and should stay one.
   */
  attach?: (peer: RepairPeer) => void
  /**
   * True when this client should keep the WHOLE round's inputs rather than a
   * window behind the play head, so a player who comes back can be replayed
   * into the present.
   *
   * ASKED OF THE TRANSPORT RATHER THAN PASSED IN, for the same reason `attach`
   * is answered there: the transport is the thing that knows whether this
   * client is the relay, and the relay is the only party that holds every
   * slot's row by construction. Making the front end pass it would mean a
   * rejoin that quietly cannot be honoured because a flag was missed in a
   * function five files away.
   */
  readonly keepRound?: boolean
}

/** The agreed AI/person history for one player, as a repair moves it around. */
export interface HandoverWire { id: string; f: number[] }

/**
 * What a repair needs from the runner, and nothing else.
 *
 * DECLARED AS AN INTERFACE SO THE DEPENDENCY POINTS ONE WAY. `net/live.ts`
 * already imports from this file; if it also had to name `LockstepRunner` the
 * two would be circular, and more to the point the repair does not care what a
 * `Race` is. Everything below is arithmetic over the input table plus one
 * `pause`.
 */
export interface RepairPeer {
  /** The frame this client has actually STEPPED. Not the horizon: see
   *  `LockstepRunner.digest`. */
  readonly frame: number
  /**
   * Stop, without the stop looking like a stall.
   *
   * `line` is what the player is told WHILE held, and it is a second argument
   * rather than a second method because the two always move together: a hold
   * with nothing to say is the frozen race with no explanation that the whole
   * stall policy exists to prevent.
   */
  hold(on: boolean, line?: string): void
  /** How far we got and every cell of the table we hold. */
  digest(): { frame: number; rows: TapeRow[] }
  /** HOST SIDE of the cut: absorb the union, hand every absent slot to the AI
   *  from the union's own last word about it, and report what was decided. */
  cut(frame: number, rows: readonly TapeRow[], absent: readonly string[]): HandoverWire[]
  /** GUEST SIDE of the cut: absorb the union and the decisions. */
  applyCut(frame: number, rows: readonly TapeRow[], hand: readonly HandoverWire[]): void
  /** Take over refereeing. */
  becomeHost(): void
  /**
   * The round is over for THIS client and carried on without it.
   *
   * THE VERDICT IS `ejected` AND NOT A NEW ONE, deliberately. A repair that
   * runs out of budget leaves this client in exactly the state that word
   * already describes -- "the room decided we were gone and carried on
   * without us" -- and game/main.ts already knows what to do with it: bank
   * nothing, say so, put the race away and go back to the room. Inventing a
   * fifth `RunnerVerdict` would mean a state the front end has never heard of,
   * and the probe photographed what that looks like: a race that had formally
   * ended still on screen, frozen, under a banner counting down to zero.
   */
  leave(): void
  /** The whole round, for a client that is coming back to it. Null when this
   *  client was not keeping one -- which is every client but the host. */
  fullTape(): { frame: number; rows: TapeRow[]; hand: HandoverWire[] } | null
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
  /**
   * Keep the whole round's input tape rather than a window behind the play
   * head, so a player who comes back can be replayed into the present.
   *
   * THE HOST SETS IT AND NOBODY ELSE NEEDS TO. The host is the relay, so it is
   * the only party that holds every slot's row by construction -- a guest's
   * archive would have the same holes its live table does. See
   * `SchedulerOptions.keepRound` for what it costs.
   */
  keepRound?: boolean
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
    this.authorityNow = opts.authority
    this.now = opts.now ?? (() => Date.now())
    this.health = opts.health ?? (() => 'up')
    for (const [slot, id] of opts.players) this.slotOf.set(id, slot)

    this.scheduler = new LockstepScheduler({
      slots: [...opts.players.keys()],
      localSlot: opts.localSlot,
      inputDelay: opts.inputDelay,
      authority: opts.authority,
      // Explicit when a caller says so (the unit tests do); otherwise the
      // transport decides, because the transport knows who the relay is.
      keepRound: opts.keepRound ?? opts.transport.keepRound === true,
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
      if (this.authorityNow) this.expire([slot])
    }
    // THE INTRODUCTION. See `RunnerTransport.attach`: a repair is run by
    // net/live.ts and needs the table that lives in here, and the runner is
    // the one party that certainly holds a reference to the transport.
    this.transport.attach?.(this)
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
    /**
     * HELD, AND NOT MERELY STALLED. During a host migration or a rejoin this
     * client must not step, must not publish and -- the part that matters --
     * must not advance the stall clock. A 30-second budget run through the
     * ordinary stall path would pass `STALL_DROP_MS` five times over, and the
     * new host's first act on arriving would be to declare the entire room
     * dead for having been silent while it was being repaired.
     *
     * Returning before `tickAwake` is what makes that true: the interval is
     * never observed, so it is never banked, exactly as `MAX_AWAKE_TICK_MS`
     * discards an interval during which our own main thread was asleep.
     */
    if (this.paused) {
      this.verdict = 'waiting'
      /**
       * NOTHING TO WAIT FOR BY NAME DURING A REPAIR.
       *
       * A stall names the peer whose input is missing, which is the right
       * answer for an ordinary stall and the wrong one here: during a
       * migration the last missing input belongs to a player who is perfectly
       * fine, while the one who has actually gone is not mentioned at all.
       *
       * This used to supply its own line so the wait had a subject and a
       * clock. It no longer needs to: `RaceTransport.onMigration` carries the
       * whole `MigrationState` and `hud.netSentence` renders it properly,
       * naming who LEFT, who is taking over, and the seconds remaining. The
       * hold's own line is now write-only and the paused state says only that
       * it is paused.
       */
      this.waitingFor = []
      this.waitingToLoad = false
      return false
    }
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
      if (this.scheduler.aiAt(slot, next)) continue
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
      if (id && this.authorityNow) this.opts.announceDrop?.(slot, id, frame)
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
    if (this.authorityNow) this.opts.announceDesync?.(frame, slots)
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
      const ai = this.scheduler.aiAt(slot, frame)
      if (r.isAI !== ai) r.isAI = ai
    }
  }

  /** Slots currently driven by AI because their player went away. */
  get droppedSlots(): readonly number[] {
    return [...this.dropped].filter((s) => this.scheduler.aiAt(s, this.race.state.frame + 1))
  }

  /** Slots that have been dropped at some point this round, whether or not
   *  their player has since come back. A rejoin does not un-drop the history. */
  get everDropped(): readonly number[] { return [...this.dropped] }

  // -------------------------------------------------------------------------
  // Host migration and rejoin
  // -------------------------------------------------------------------------

  /**
   * HOLD EVERYTHING, WITHOUT THE HOLD LOOKING LIKE A STALL.
   *
   * The race is already stopped when this is called -- lockstep stopped it the
   * instant the host's inputs stopped arriving -- so pausing costs nothing.
   * What it BUYS is that the stall clock stops too. Without that, a migration
   * inside a 30-second budget would run straight past `STALL_DROP_MS`, and the
   * first thing the new host would do on arriving is declare everybody dead
   * for having been silent during the repair it was performing.
   *
   * `lastCall` is cleared as well as the flag, so the first frame after the
   * pause contributes nothing to the awake clock either. That is the same
   * reasoning `MAX_AWAKE_TICK_MS` is built on: an interval we did not observe
   * says nothing about anybody.
   */
  private paused = false

  /**
   * `_line` is accepted and ignored. Callers in live.ts pass a sentence
   * because they used to be the only thing that could put one on screen;
   * `RaceTransport.onMigration` is that route now and the HUD renders it far
   * better. The parameter stays rather than churning four call sites for a
   * value nobody reads.
   */
  pause(_line = ''): void {
    if (this.paused) return
    this.paused = true
    this.lastCall = 0
  }

  resume(): void {
    this.waitingFor = []
    if (!this.paused) return
    this.paused = false
    this.lastCall = 0
  }

  get held(): boolean { return this.paused }

  /**
   * Become the host mid-round.
   *
   * `authority` decides who may PROPOSE a drop and who JUDGES a hash, and
   * exactly one client must do each. It was readonly and set from the packet,
   * which is right for a round that keeps the host it started with; a
   * migration is the one event that moves the role, and it moves every part of
   * it at once (types.ts: "everything the old host was authoritative for moves
   * with it").
   *
   * The scheduler's copy moves too -- its `update` is what actually returns
   * the `expire` list -- so both are written here rather than one being
   * inferred from the other later.
   */
  private authorityNow: boolean

  setAuthority(on: boolean): void {
    this.authorityNow = on
    ;(this.scheduler as { authority: boolean }).authority = on
  }

  get isAuthority(): boolean { return this.authorityNow }

  /**
   * What this client can contribute to a repair: how far it got, and every
   * cell of the table it holds.
   *
   * THE FRAME IS `race.state.frame` AND NOT THE SCHEDULER'S HORIZON. The
   * horizon is how far anybody has PUBLISHED, which runs `inputDelay` ahead of
   * the play head and is not a frame anyone has simulated. What the repair has
   * to agree on is a frame every client can be brought TO, and only a stepped
   * frame is one of those.
   */
  digest(): { frame: number; rows: TapeRow[] } {
    const from = Math.max(1, this.race.state.frame - this.scheduler.repairWindow)
    return { frame: this.race.state.frame, rows: this.scheduler.snapshot(from) }
  }

  /** Merge a repair's rows. See `LockstepScheduler.absorb` for why a union of
   *  several clients' tables is well defined. */
  absorb(rows: readonly TapeRow[]): void { this.scheduler.absorb(rows) }

  /**
   * Publish our own row for every frame between what we last published and
   * what the resumed room will need.
   *
   * THE HOLE MIGRATION LEAVES, which is not obvious and deadlocks the race if
   * it is missed. A client stopped at frame f has published its own input up
   * to f + 1 + d and no further -- it publishes one frame per step and it
   * stopped stepping. If the room resumes at R > f, then every OTHER client
   * needs our input for frames R + 1 .. R + 1 + d, and we never published
   * frames f + 2 + d .. R + 1 + d at all. Nobody can supply them but us, and
   * `beforeStep` will only ever publish ONE frame per call -- so the room
   * would stall on a client that is running perfectly.
   *
   * Filling them with the last input we published is the honest answer and the
   * same one `dropFrameFor` gives for the other direction: the car carries on
   * doing what it was doing. It is at most `d + 1` frames -- see
   * `repairWindow` for why -- so at 60Hz the returning car holds its line for
   * a fifth of a second.
   */
  backfill(toFrame: number): void {
    const target = Math.round(toFrame) + 1 + this.scheduler.inputDelay
    if (target <= this.published) return
    const hold = this.scheduler.inputAt(this.localSlot, this.published) ?? IDLE_PACKED
    for (let f = this.published + 1; f <= target; f++) {
      this.scheduler.receive(this.localSlot, f, hold)
      this.transport.sendInput(f, hold)
    }
    this.published = target
  }

  /** A slot's agreed AI/person history, replaced wholesale by a new host. */
  setHandover(playerId: string, frames: readonly number[]): void {
    const slot = this.slotOf.get(playerId)
    if (slot === undefined) return
    this.scheduler.setHandover(slot, frames)
    if (frames.length > 0) this.dropped.add(slot)
  }

  /**
   * A guest applying the host's verdict that a slot is a PERSON again.
   *
   * The mirror of `acceptDrop`, and it needs none of that function's caution
   * about a frame already stepped: a restore is chosen `REJOIN_LEAD_FRAMES`
   * ahead of the announcing frame precisely so that it is in everybody's
   * future, including the returning client's own.
   */
  acceptRestore(playerId: string, frame: number): void {
    const slot = this.slotOf.get(playerId)
    if (slot === undefined) return
    if (frame <= this.race.state.frame) {
      // Announced too late to be honoured here. Refusing is the only safe
      // answer -- we would be un-AI-ing a frame we have already simulated --
      // and the host's `REJOIN_LEAD_FRAMES` exists so this cannot happen.
      console.warn(`lockstep: restore of ${playerId} at frame ${frame} arrived after `
        + `frame ${this.race.state.frame}; ignoring rather than rewriting history`)
      return
    }
    this.scheduler.applyRestore(slot, frame)
  }

  /**
   * Rebuild this client's race from the input tape, up to `toFrame`.
   *
   * WHY A REJOIN IS A REPLAY AND NOT A SNAPSHOT. The state of this race is a
   * `Race` -- its own rng, one `aiRng` per car, a stall watchdog, a
   * rocket-start latch -- and none of it is serialisable without inventing a
   * second definition of the race that would then have to be kept in step with
   * the first. What IS serialisable is what the protocol already carries. A
   * client holding the inputs from frame 1 can reproduce the state by running
   * them, because that is the property `tests/bridges.test.ts` pins and the
   * property every other line in this file depends on.
   *
   * The cost is one pass of the sim over the frames that were missed, with no
   * rendering and nothing on the wire: measured at well over ten thousand
   * frames a second, so a thirty-second absence replays in under a fifth of a
   * second. The cost of the ALTERNATIVE is the thing to weigh it against --
   * there is no alternative.
   *
   * Returns the frame actually reached, which is `toFrame` when the tape was
   * complete and less when it was not. A short replay is not a disaster and
   * must not be treated as one: the caller compares and refuses the rejoin
   * rather than joining a race it is behind in.
   */
  /** `RepairPeer`. The frame actually stepped, which is the only frame a
   *  repair may agree on. */
  get frame(): number { return this.race.state.frame }

  hold(on: boolean, line = ''): void { if (on) this.pause(line); else this.resume() }

  becomeHost(): void { this.setAuthority(true) }

  leave(): void {
    if (this.verdict === 'desync') return
    this.verdict = 'ejected'
    this.paused = false
  }

  /** Every player's agreed toggle list, for a repair to republish. */
  handovers(): HandoverWire[] {
    const out: HandoverWire[] = []
    for (const [slot, id] of this.players) {
      const f = this.scheduler.handover(slot)
      if (f.length > 0) out.push({ id, f: [...f] })
    }
    return out
  }

  /**
   * THE HOST SIDE OF A MIGRATION'S CUT.
   *
   * Absorb the union first, THEN decide who is gone, and that order is the
   * whole correctness argument. `highestFor` after the merge is the highest
   * frame ANY survivor could speak for that slot; one past it is therefore a
   * frame no client can have stepped, which is `dropFrameFor`'s safety
   * property applied to a merged table rather than to one client's. Deciding
   * before the merge would use this client's own last word, and this client
   * may be the one the dead relay served worst.
   */
  cut(frame: number, rows: readonly TapeRow[], absent: readonly string[]): HandoverWire[] {
    this.scheduler.settleThrough(frame + SETTLE_FRAMES)
    this.scheduler.absorb(rows)
    for (const id of absent) {
      const slot = this.slotOf.get(id)
      if (slot === undefined) continue
      const at = this.scheduler.highestFor(slot) + 1
      this.dropped.add(slot)
      this.scheduler.applyDrop(slot, at)
    }
    const hand = this.handovers()
    this.backfill(frame)
    this.resume()
    return hand
  }

  /** The guest side of the same cut. The decisions arrive rather than being
   *  made, which is the point of there being exactly one host. */
  applyCut(frame: number, rows: readonly TapeRow[], hand: readonly HandoverWire[]): void {
    this.scheduler.settleThrough(frame + SETTLE_FRAMES)
    this.scheduler.absorb(rows)
    for (const h of hand) this.setHandover(h.id, h.f)
    this.backfill(frame)
    this.resume()
  }

  /**
   * The whole round so far, for a client that is coming back to it.
   *
   * NULL UNLESS THIS RUNNER WAS KEEPING ONE. Only the host sets `keepRound`,
   * because only the host holds every slot's row by construction -- a guest's
   * archive would have the same holes its live table does, and a tape with
   * holes replays to a different frame from the one it claims. Returning null
   * rather than a partial tape is what makes the host refuse a rejoin it
   * cannot honour instead of granting one that desyncs.
   */
  fullTape(): { frame: number; rows: TapeRow[]; hand: HandoverWire[] } | null {
    if (this.scheduler.retainedFrom !== 1) return null
    return {
      frame: this.race.state.frame,
      rows: this.scheduler.snapshot(1),
      hand: this.handovers(),
    }
  }

  replay(rows: readonly TapeRow[], handovers: ReadonlyMap<string, readonly number[]>,
    toFrame: number): number {
    this.scheduler.settleThrough(toFrame + SETTLE_FRAMES)
    for (const [id, frames] of handovers) this.setHandover(id, frames)
    this.scheduler.absorb(rows)
    const stop = Math.round(toFrame)
    while (this.race.state.frame < stop) {
      const next = this.race.state.frame + 1
      if (!this.scheduler.ready(next)) break
      this.syncAI(next)
      for (const slot of this.players.keys()) {
        if (this.scheduler.aiAt(slot, next)) continue
        const packed = this.scheduler.inputAt(slot, next)
        if (packed === undefined) continue
        this.race.setInput(slot, unpackInput(packed, this.frameFor(slot)))
      }
      this.race.step()
      // NOT `commit`. The replay is the one place that must keep everything:
      // this client is about to hand its own digest to a future repair, and a
      // window pruned during the catch-up is a window it cannot speak for.
    }
    // The publish cursor has to be told where the race actually is, or the
    // first `beforeStep` after a replay publishes for a frame the room passed
    // long ago and then waits `toFrame` frames to catch up to itself.
    this.published = Math.max(this.published, this.race.state.frame + this.scheduler.inputDelay)
    this.hashed = this.race.state.frame
    // CAUGHT UP IS THE DEFINITION OF UN-HELD. A client is paused from the
    // moment it loses its link until it is back at the room's frame, and this
    // is that moment -- leaving it paused here would reconnect a player to a
    // race they then watch somebody else run.
    this.paused = false
    this.lastCall = 0
    return this.race.state.frame
  }
}
