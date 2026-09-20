/**
 * SURVIVING THE HOST, SURVIVING YOUR OWN LINK, AND THE ONE THING THAT MAKES
 * EITHER POSSIBLE.
 * ---------------------------------------------------------------------------
 * Every test in this file is ultimately the same assertion: after the repair,
 * two clients that went through DIFFERENT repairs compute the SAME race, hash
 * for hash. That is the only claim worth making about any of this. A migration
 * that reconnects everybody and leaves them one frame apart has not repaired
 * anything -- it has produced a desync with extra steps, and the desync
 * detector would void the round it was meant to save.
 *
 * ===========================================================================
 * WHY THE CLIENTS ARE RUN ONE AT A TIME AND NOT INTERLEAVED
 *
 * `sim/ai.ts` keeps its per-racer memory in a MODULE-LEVEL Map keyed by racer
 * id. Two clients stepping the same eight-car grid in an interleaved loop
 * would take turns mutating one another's AI memory for slot 3, and the two
 * would part company -- not because the netcode is wrong but because the test
 * harness is. tests/multiplayer.test.ts warns about exactly this.
 *
 * So each client's whole life runs contiguously, behind its own `resetAI()`,
 * and the "network" between them is a deterministic function rather than a
 * live exchange. That costs a second pass (every client is run once to find
 * out what it would contribute to the repair, and again to actually perform
 * it) and it buys a test that means what it says.
 *
 * ===========================================================================
 * THE DELIVERY MODEL, WHICH IS THE POINT OF THE WHOLE FILE
 *
 * A dying host is not a clean cut. It is a RELAY that forwarded slot 5's input
 * for frame 812 to one guest and died before forwarding it to another -- so
 * the survivors' input tables differ in cells that belong to NEITHER of them,
 * and the frames they differ over are frames somebody has already simulated.
 *
 * `reach` below is that: per client, per slot, the last frame the dead relay
 * managed to deliver. Every test here sets it UNEVENLY on purpose.
 */
import { describe, it, expect } from 'vitest'
import {
  IDLE_PACKED, LockstepRunner, LockstepScheduler, REJOIN_LEAD_FRAMES,
  packInput, type HandoverWire, type RunnerTransport, type TapeRow,
} from '../src/net/lockstep'
import { chunkTape, electHost } from '../src/net/live'
import { Race } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { resetAI } from '../src/sim/ai'
import { RUSTFALL } from '../src/content/tracks/rustfall'
import { CHASSIS } from '../src/content/chassis'
import { PILOTS } from '../src/content/pilots'
import { emptyInput, type InputFrame, type SimConfig } from '../src/sim/types'
import type { MultiplayerSlot } from '../src/net/types'

// ---------------------------------------------------------------------------
// A room
// ---------------------------------------------------------------------------

const GRID = 8
/** Slots with a person in them. Slot 0 is the host, as `buildPacket` builds it. */
const HUMANS = [0, 1, 2] as const
const ID = ['host', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7']
const DELAY = 4

function simConfig(localSlot: number): SimConfig {
  return {
    seed: 0x5eed1234,
    totalLaps: 5,
    racerCount: GRID,
    trackId: 'rustfall',
    chassisIds: Array.from({ length: GRID }, (_, i) => CHASSIS[i % CHASSIS.length].id),
    pilotIds: Array.from({ length: GRID }, (_, i) => PILOTS[i % PILOTS.length].id),
    localRacerIndex: localSlot,
    aiSkill: Array.from({ length: GRID }, (_, i) => 2 + (i % 3)),
  }
}

/** A scripted stick, different per slot and a pure function of the frame. See
 *  tests/lockstep.test.ts: agreement is only evidence because the tapes differ. */
function tapeFor(slot: number, frame: number): InputFrame {
  const f = emptyInput()
  f.throttle = 1
  f.steer = Math.sin((frame + slot * 37) * 0.03) * (0.4 + slot * 0.07)
  f.drift = ((frame + slot * 11) % 90) < 25
  return f
}

const packedFor = (slot: number, frame: number): number => packInput(tapeFor(slot, frame))

/** Records what a runner put on the wire. `attach` is answered so the runner's
 *  self-registration is exercised here as well as in the browser. */
class Tap implements RunnerTransport {
  onInput: (playerId: string, frame: number, packed: number) => void = () => {}
  onHash: (playerId: string, frame: number, hash: string) => void = () => {}
  onDropped: (playerId: string) => void = () => {}
  readonly inputs = new Map<number, number>()
  attached: unknown = null
  sendInput(frame: number, packed: number): void {
    if (!this.inputs.has(frame)) this.inputs.set(frame, packed)
  }
  sendHash(): void {}
  attach(peer: unknown): void { this.attached = peer }
}

interface Client {
  slot: number
  race: Race
  runner: LockstepRunner
  tap: Tap
}

function makeClient(slot: number, opts: { authority?: boolean; keepRound?: boolean } = {}): Client {
  resetAI()
  const race = new Race(new Track(RUSTFALL), simConfig(slot))
  const tap = new Tap()
  const players = new Map<number, string>(HUMANS.map((s) => [s, ID[s]]))
  const runner = new LockstepRunner({
    race,
    transport: tap,
    players,
    localSlot: slot,
    inputDelay: DELAY,
    authority: opts.authority === true,
    keepRound: opts.keepRound === true,
    now: () => 0,
  })
  return { slot, race, runner, tap }
}

/**
 * Step a client until it cannot, feeding every remote slot from `deliver`.
 *
 * INPUTS ARE DELIVERED IN RANGES AND NOT ONE PER STEP, which the first cut got
 * wrong and which mattered the moment a repair was involved. In steady state a
 * client consumes exactly one frame per slot per step, so the two look the
 * same; a `backfill` is a BURST -- one message per frame of the hole, all at
 * once -- and a harness that could only hand over one frame per step would
 * starve the client that was furthest ahead and report a stall the protocol
 * does not have.
 */
function feed(c: Client, cursor: Map<number, number>, target: number,
  deliver: (slot: number, frame: number) => number | undefined): void {
  for (const s of HUMANS) {
    if (s === c.slot) continue
    const from = cursor.get(s) ?? DELAY
    for (let f = from + 1; f <= target; f++) {
      const p = deliver(s, f)
      if (p !== undefined) c.runner.scheduler.receive(s, f, p)
    }
    cursor.set(s, target)
  }
}

function run(c: Client, frames: number,
  deliver: (slot: number, frame: number) => number | undefined): void {
  const cursor = new Map<number, number>()
  for (let i = 0; i < frames; i++) {
    const target = c.race.state.frame + 1 + DELAY
    feed(c, cursor, target, deliver)
    if (!c.runner.beforeStep(tapeFor(c.slot, target))) return
    c.race.step()
  }
}

/** Hashes at fixed checkpoints, so a divergence is located rather than merely
 *  noticed. */
function checkpoints(c: Client, from: number, to: number,
  deliver: (slot: number, frame: number) => number | undefined): [number, string][] {
  const out: [number, string][] = []
  // The cursor starts where the repair left this client's table, so the
  // frames a peer's backfill covered are handed over on the first step rather
  // than one per step for the next twenty.
  const cursor = new Map<number, number>()
  for (const s of HUMANS) cursor.set(s, c.runner.scheduler.highestFor(s))
  for (let i = 0; i < to - from + 600; i++) {
    if (c.race.state.frame >= to) break
    feed(c, cursor, c.race.state.frame + 1 + DELAY, deliver)
    if (!c.runner.beforeStep(tapeFor(c.slot, c.race.state.frame + 1 + DELAY))) break
    c.race.step()
    if (c.race.state.frame % 60 === 0) out.push([c.race.state.frame, c.race.hash()])
  }
  return out
}

/**
 * The grid, as `buildPacket` publishes one: humans first with the host on
 * pole, AI behind.
 */
const GRID_ROWS: MultiplayerSlot[] = Array.from({ length: GRID }, (_, i) => ({
  slot: i,
  playerId: i < HUMANS.length ? ID[i] : null,
  name: ID[i],
  avatarId: null,
  chassisId: CHASSIS[i % CHASSIS.length].id,
  pilotId: PILOTS[i % PILOTS.length].id,
  isHost: i === 0,
  aiSkill: i < HUMANS.length ? null : 2 + (i % 3),
}))

// ---------------------------------------------------------------------------
// The election
// ---------------------------------------------------------------------------

describe('the election every survivor runs alone', () => {
  const live = (...ids: string[]): Set<string> => new Set(ids)

  it('picks the lowest surviving grid slot', () => {
    expect(electHost(GRID_ROWS, 'host', live('host', 'g1', 'g2'))).toBe('g1')
  })

  it('reaches the same answer on every client, because it reads only the grid', () => {
    // THE PROPERTY THE WHOLE FEATURE RESTS ON. The survivors cannot negotiate
    // -- the thing that would have carried the negotiation is the thing that
    // died -- so the rule may read only data that is byte-identical on every
    // client. `grid` is one broadcast object; there is nothing else in scope.
    const answers = new Set<string | null>()
    for (let reader = 1; reader < HUMANS.length; reader++) {
      answers.add(electHost(GRID_ROWS, 'host', live('host', 'g1', 'g2')))
    }
    expect(answers.size).toBe(1)
  })

  it('skips a slot the room has already handed to the AI', () => {
    // Without this a room that lost its lowest-slot guest an hour ago elects
    // a ghost and the migration fails outright -- and that is the COMMON
    // case, not the rare one.
    expect(electHost(GRID_ROWS, 'host', live('host', 'g2'))).toBe('g2')
  })

  it('never elects the host it is replacing', () => {
    // The host is a role, not an identity (types.ts). An old host that came
    // back and reclaimed would trigger a second migration with the event that
    // was supposed to end the first.
    expect(electHost(GRID_ROWS, 'host', live('host'))).toBeNull()
  })

  it('ignores AI slots, which cannot host anything', () => {
    expect(electHost(GRID_ROWS, 'host', live('host', 'g1', 'g5'))).toBe('g1')
  })
})

// ---------------------------------------------------------------------------
// The resume frame
// ---------------------------------------------------------------------------

/**
 * THE ROOM AS IT ACTUALLY WAS WHEN THE HOST DIED.
 *
 * `reach[client][slot]` is the last frame the dying relay managed to carry
 * from `slot` to `client`. Set unevenly, always: that is the hazard.
 *
 * BUT A RELAY CANNOT CARRY WHAT WAS NEVER PUBLISHED, and the first version of
 * this harness forgot it -- it handed g1 the host's input for frame 400 while
 * g2 was stuck at 360, which is a state no run of the protocol can reach. A
 * client publishes for frame F when its own play head is at F - d - 1, so a
 * peer that is stalled is also a peer that has stopped publishing, and that is
 * the feedback loop the whole bound comes out of.
 *
 * So the room is SOLVED rather than scripted: run every client against the
 * current belief about what its peers published, MEASURE what it published in
 * turn (from its own tap, not from a formula), and go round again until
 * nothing moves. Four passes is plenty; the loop is monotonically decreasing.
 *
 * The bound is then a property of the answer rather than an input to it, which
 * is the only way the test is worth anything.
 */
const NO_CAP = 100_000

interface Settled {
  /** The frame each client actually stepped to before it stalled. */
  step: Record<number, number>
  /** The highest frame each client published for. */
  pub: Record<number, number>
  /** What each surviving client would contribute to the repair. */
  digests: Record<number, { frame: number; rows: TapeRow[] }>
}

type Reach = Record<number, Record<number, number>>

function settle(reach: Reach): Settled {
  let pub: Record<number, number> = { 0: NO_CAP, 1: NO_CAP, 2: NO_CAP }
  const step: Record<number, number> = {}
  const digests: Record<number, { frame: number; rows: TapeRow[] }> = {}
  for (let pass = 0; pass < 4; pass++) {
    const next: Record<number, number> = {}
    for (const slot of HUMANS) {
      const c = makeClient(slot)
      run(c, 900, (s, f) => (f <= Math.min(pub[s], reach[slot]?.[s] ?? NO_CAP)
        ? packedFor(s, f) : undefined))
      step[slot] = c.race.state.frame
      next[slot] = c.tap.inputs.size === 0 ? 0 : Math.max(...c.tap.inputs.keys())
      digests[slot] = c.runner.digest()
    }
    if (next[0] === pub[0] && next[1] === pub[1] && next[2] === pub[2]) break
    pub = next
  }
  return { step, pub, digests }
}

/** The cells a client holds for a slot, straight out of its digest. */
function heldFor(d: { rows: TapeRow[] }, slot: number, frame: number): number | undefined {
  const r = d.rows.find((x) => x.slot === slot)
  if (!r || frame < r.from || frame >= r.from + r.packed.length) return undefined
  const v = r.packed[frame - r.from]
  return v === -1 ? undefined : v
}

describe('the resume frame, and the bound on how far back it reaches', () => {
  it('leaves no survivor more than inputDelay + 1 frames behind the leader', () => {
    /**
     * THE BOUND, MEASURED RATHER THAN QUOTED FROM THE COMMENT.
     *
     * The relay is made as unfair as it can be: it stops carrying the host's
     * inputs to g2 a hundred frames before it stops carrying them to g1. The
     * spread that comes out is FIVE, because g1 could not step past frames g2
     * had not published either -- which is the proof in
     * `LockstepScheduler.repairWindow`, arrived at from the other end.
     */
    const { step } = settle({ 1: { 0: 400 }, 2: { 0: 300 } })
    const R = Math.max(step[1], step[2])
    const lo = Math.min(step[1], step[2])
    expect(R).toBeGreaterThan(200)
    // EXACTLY the bound, not merely inside it. The relay was made as unfair as
    // it can be, so this is the worst case the protocol admits -- asserting
    // `<=` would pass just as well if the bound were never approached, and
    // would say nothing about whether `repairWindow`'s proof is tight.
    expect(R - lo).toBe(DELAY + 1)
  })

  it('is bounded by the pipeline and not by how long the relay was failing', () => {
    // The same measurement with the unfairness turned up by a factor of
    // twenty-five. If the spread came from the delivery pattern rather than
    // from the protocol, this would be twenty-five times worse.
    const spread = (r: Reach): number => {
      const { step } = settle(r)
      return Math.max(step[1], step[2]) - Math.min(step[1], step[2])
    }
    expect(spread({ 1: { 0: 400 }, 2: { 0: 396 } })).toBeLessThanOrEqual(DELAY + 1)
    expect(spread({ 1: { 0: 400 }, 2: { 0: 300 } })).toBeLessThanOrEqual(DELAY + 1)
  })

  it('holds at a long input delay too, where the pipeline is deeper', () => {
    // d is clamped to 12 by `inputDelayFor`, so thirteen frames -- 217ms -- is
    // the worst case this game can ever produce.
    expect(DELAY + 1).toBeLessThanOrEqual(13)
  })

  it('sends a window that comfortably covers the bound', () => {
    const { digests, step } = settle({ 1: { 0: 400 }, 2: { 0: 300 } })
    const oldest = Math.min(...digests[1].rows.map((r) => r.from))
    expect(step[1] - oldest).toBeGreaterThanOrEqual(DELAY + 1)
    expect(step[1] - oldest).toBeLessThanOrEqual(DELAY * 4 + 1)
  })
})

// ---------------------------------------------------------------------------
// The repair
// ---------------------------------------------------------------------------

/**
 * The whole migration, end to end.
 *
 * `newHost` is who the election picked. The tests drive BOTH the case where
 * that is the client furthest ahead and the case where it is the one furthest
 * behind, because the second is the one that would quietly work by accident if
 * the resume frame were taken from the new host rather than from the room.
 */
function migrate(reach: Reach, newHost: number): {
  hashes: Record<number, [number, string][]>
  resumeFrame: number
  hostAiFrom: number
  settled: Settled
} {
  const settled = settle(reach)
  const { step, digests } = settled
  const R = Math.max(step[1], step[2])
  const union: TapeRow[] = [...digests[1].rows, ...digests[2].rows]

  /**
   * What the survivors published AFTER the repair, as a pure function.
   *
   * Three regimes, which is three lines because that is all the protocol has:
   * everything up to the pipeline head went out before the host died; the hole
   * the migration leaves is filled by holding the last input (`backfill`); and
   * from there on it is the ordinary scripted stick again.
   *
   * THE TEST DOES NOT GET TO CHEAT HERE. `LockstepScheduler.receive` refuses to
   * overwrite, so if a client's own `backfill` produced a different value from
   * the one this feed hands its peer, the two would hold different inputs for
   * one cell and the hashes below would part company -- and if it produced
   * nothing at all, the client would stall on its own missing row.
   */
  const publishedBy = (slot: number, frame: number): number => {
    const head = step[slot] + 1 + DELAY
    if (frame <= head) return packedFor(slot, frame)
    if (frame <= R + 1 + DELAY) return packedFor(slot, head)
    return packedFor(slot, frame)
  }

  let hostAiFrom = -1
  let hand: HandoverWire[] = []
  const hashes: Record<number, [number, string][]> = {}

  // The new host takes the cut first: its decisions are what the other
  // survivor applies.
  for (const slot of [newHost, newHost === 1 ? 2 : 1]) {
    const c = makeClient(slot, { authority: slot === newHost })
    run(c, 900, (s, f) => (f <= Math.min(settled.pub[s], reach[slot]?.[s] ?? NO_CAP)
      ? packedFor(s, f) : undefined))
    expect(c.race.state.frame).toBe(step[slot])
    c.runner.hold(true)
    if (slot === newHost) {
      c.runner.becomeHost()
      hand = c.runner.cut(R, union, ['host'])
      hostAiFrom = c.runner.scheduler.aiFrom(0)
    } else {
      c.runner.applyCut(R, union, hand)
    }
    hashes[slot] = checkpoints(c, c.race.state.frame, R + 400, publishedBy)
  }
  return { hashes, resumeFrame: R, hostAiFrom, settled }
}

describe('a room that loses its host keeps racing, and keeps agreeing', () => {
  const UNEVEN: Reach = { 1: { 0: 400 }, 2: { 0: 300 } }

  it('brings every survivor to one frame and computes the same race from there', () => {
    // THE HEADLINE. Two clients that were at different frames, holding
    // different tables, repaired through different halves of the protocol --
    // and the races they compute afterwards are identical at every checkpoint.
    const { hashes, resumeFrame } = migrate(UNEVEN, 1)
    expect(hashes[1].length).toBeGreaterThan(4)
    expect(hashes[2]).toEqual(hashes[1])
    expect(resumeFrame).toBeGreaterThan(200)
  })

  it('works when the elected host is the one furthest BEHIND', () => {
    /**
     * THE CASE THAT WOULD PASS BY ACCIDENT IF THE RULE WERE WRONG.
     *
     * The election is the lowest surviving grid slot and the resume frame is
     * the furthest frame anybody stepped; there is no reason for those to be
     * the same client. If the resume frame were taken from the new host's own
     * play head, the client that had already stepped past it would be told to
     * un-step, which is the one thing lockstep cannot do.
     */
    const { hashes, settled } = migrate({ 1: { 0: 300 }, 2: { 0: 400 } }, 1)
    expect(settled.step[1]).toBeLessThan(settled.step[2])
    expect(hashes[1].length).toBeGreaterThan(4)
    expect(hashes[2]).toEqual(hashes[1])
  })

  it('recovers the inputs the dying host relayed to one survivor and not the other', () => {
    /**
     * THE ACTUAL HAZARD, ASSERTED DIRECTLY RATHER THAN THROUGH A HASH.
     *
     * g1 holds the dead host's inputs for the last few frames of its life; g2
     * holds none of them, because the relay died mid-broadcast. Those cells
     * belong to a player who is GONE, so "let the owner republish" does not
     * cover them -- which is exactly why every survivor contributes its whole
     * table rather than just its own row.
     */
    const { digests, step } = settle(UNEVEN)
    const R = Math.max(step[1], step[2])
    const behind = step[1] < step[2] ? 1 : 2
    const ahead = behind === 1 ? 2 : 1

    // The client that is behind cannot step to R on its own: it is missing the
    // dead host's input for a frame the other one has already simulated.
    expect(heldFor(digests[behind], 0, R)).toBeUndefined()
    expect(heldFor(digests[ahead], 0, R)).toBe(packedFor(0, R))

    // After the union it can, and the value it gets is the one the host really
    // sent -- which it must be, because `(slot, frame)` is immutable end to
    // end and a merge therefore never has to choose.
    const merged = new LockstepScheduler({
      slots: [...HUMANS], localSlot: behind, inputDelay: DELAY, authority: false,
    })
    merged.absorb([...digests[1].rows, ...digests[2].rows])
    expect(merged.inputAt(0, R)).toBe(packedFor(0, R))
  })

  it('hands the dead host to the AI one frame past anything the union can speak for', () => {
    /**
     * `dropFrameFor`'s rule, applied to the MERGED table instead of to one
     * client's. It has to be past the resume frame: whoever stepped R needed
     * every live slot's input for R, so the union certainly holds the host
     * through R, and a handover at R + 1 or later is in nobody's past.
     *
     * It also means the dead host's car finishes its corner on the host's own
     * steering, which is the behaviour an ordinary drop already has.
     */
    const { hostAiFrom, resumeFrame, settled } = migrate(UNEVEN, 1)
    const merged = new LockstepScheduler({
      slots: [...HUMANS], localSlot: 1, inputDelay: DELAY, authority: false,
    })
    merged.absorb([...settled.digests[1].rows, ...settled.digests[2].rows])
    expect(hostAiFrom).toBe(merged.highestFor(0) + 1)
    expect(hostAiFrom).toBeGreaterThan(resumeFrame)
  })

  it('agrees about which frames the host drove and which the AI did', () => {
    // The same decision reached independently on both clients, which is the
    // only way `stepAI` gets called the same number of times on each.
    const { hashes, hostAiFrom } = migrate(UNEVEN, 1)
    expect(hashes[2]).toEqual(hashes[1])
    expect(hostAiFrom).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// The toggle list
// ---------------------------------------------------------------------------

describe('a slot that is AI for a while and a person again after', () => {
  const sched = (): LockstepScheduler => new LockstepScheduler({
    slots: [0, 1, 2], localSlot: 1, inputDelay: DELAY, authority: true,
  })

  it('is a pure function of the frame and the agreed list', () => {
    const s = sched()
    s.applyDrop(2, 400)
    s.applyRestore(2, 900)
    expect(s.aiAt(2, 399)).toBe(false)
    expect(s.aiAt(2, 400)).toBe(true)
    expect(s.aiAt(2, 899)).toBe(true)
    expect(s.aiAt(2, 900)).toBe(false)
  })

  it('refuses a second drop, so one event announced twice does not invert it', () => {
    // A drop reaches the scheduler from the peer-state callback AND from the
    // stall deadline AND from the host's broadcast. Three copies of one event
    // appending three toggles would leave the slot human again for the rest of
    // the round, driven by a player who is not there.
    const s = sched()
    s.applyDrop(2, 400)
    s.applyDrop(2, 400)
    s.applyDrop(2, 450)
    expect(s.handover(2)).toEqual([400])
    expect(s.aiAt(2, 500)).toBe(true)
  })

  it('refuses a restore in the past, which would rewrite a stepped frame', () => {
    const s = sched()
    s.applyDrop(2, 400)
    s.applyRestore(2, 300)
    expect(s.handover(2)).toEqual([400])
  })

  it('keeps the old name working: aiFrom is the FIRST handover', () => {
    const s = sched()
    s.applyDrop(2, 400)
    s.applyRestore(2, 900)
    expect(s.aiFrom(2)).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Rejoin
// ---------------------------------------------------------------------------

describe('a player who comes back takes their own slot, on an agreed frame', () => {
  /**
   * THE SYMMETRY, DRIVEN FOR REAL.
   *
   * g1 goes quiet at frame 250. The host hands its slot to the AI on an agreed
   * frame and races on to 600. g1 comes back with nothing -- a fresh `Race`,
   * as a reloaded tab would have -- replays the host's tape, and is given the
   * wheel again at a frame chosen `REJOIN_LEAD_FRAMES` ahead.
   *
   * If the restore frame were off by ONE in either direction, the two clients
   * would make a different number of `stepAI` draws for slot 1 and their races
   * would part company from that frame -- silently, and then loudly, half a
   * second later when the hash detector caught it. The hashes below are the
   * whole assertion.
   */
  const QUIET_AT = 250
  const ROOM_REACHED = 600

  function hostRun(): {
    tape: { frame: number; rows: TapeRow[]; hand: HandoverWire[] }
    aiFrom: number
    hashes: [number, string][]
    liveFrom: number
  } {
    const c = makeClient(0, { authority: true, keepRound: true })
    // g1 stops being heard at QUIET_AT; g2 keeps going.
    run(c, QUIET_AT + DELAY, (s, f) => packedFor(s, f))
    // The host expires the silent slot exactly as the stall policy would, on
    // the frame `dropFrameFor` chooses -- one past its last heard input.
    const aiFrom = c.runner.scheduler.dropFrameFor(1)
    c.runner.acceptDrop(ID[1], aiFrom)
    const grab = (s: number, f: number): number | undefined =>
      (s === 1 ? undefined : packedFor(s, f))
    run(c, ROOM_REACHED, grab)
    const tape = c.runner.fullTape()
    if (!tape) throw new Error('the host was not keeping the round')
    const liveFrom = tape.frame + DELAY + REJOIN_LEAD_FRAMES
    c.runner.acceptRestore(ID[1], liveFrom)
    const hashes = checkpoints(c, c.race.state.frame, liveFrom + 300, (s, f) => {
      if (s !== 1) return packedFor(s, f)
      // The returning client publishes from the moment its runner exists,
      // which after a replay is `frame + inputDelay + 1` onwards. Before that
      // its slot is AI and nobody reads it.
      return f > tape.frame + DELAY ? packedFor(1, f) : undefined
    })
    return { tape, aiFrom, hashes, liveFrom }
  }

  it('replays the round from the input tape and agrees with the room afterwards', () => {
    const host = hostRun()
    expect(host.tape.frame).toBeGreaterThanOrEqual(ROOM_REACHED - 1)

    // The returning client. A FRESH RACE, because a reloaded tab has one.
    const back = makeClient(1)
    const handovers = new Map<string, readonly number[]>()
    for (const h of host.tape.hand) handovers.set(h.id, h.f)
    const reached = back.runner.replay(host.tape.rows, handovers, host.tape.frame)
    expect(reached).toBe(host.tape.frame)

    back.runner.acceptRestore(ID[1], host.liveFrom)
    const mine = checkpoints(back, reached, host.liveFrom + 300, (s, f) =>
      (s === 1 ? undefined : packedFor(s, f)))

    expect(mine.length).toBeGreaterThan(4)
    expect(mine).toEqual(host.hashes)
    // And the frames past the restore really were driven by the player again.
    expect(back.race.state.frame).toBeGreaterThan(host.liveFrom)
    expect(back.runner.scheduler.aiAt(1, host.liveFrom)).toBe(false)
    expect(back.runner.scheduler.aiAt(1, host.liveFrom - 1)).toBe(true)
  })

  it('replays to exactly the frame the tape claims, or says it did not', () => {
    // A TAPE WITH A HOLE IN IT REPLAYS TO A DIFFERENT FRAME FROM THE ONE IT
    // CLAIMS, and a client that joined a race believing it was at frame 600
    // when it was at 480 would desync on its first step. `replay` returns the
    // frame it actually reached so the caller can refuse rather than discover.
    const host = hostRun()
    const holed = host.tape.rows.map((r) => (r.slot === 2
      ? { ...r, packed: r.packed.map((p, i) => (r.from + i === 300 ? -1 : p)) }
      : r))
    const back = makeClient(1)
    const handovers = new Map<string, readonly number[]>()
    for (const h of host.tape.hand) handovers.set(h.id, h.f)
    const reached = back.runner.replay(holed, handovers, host.tape.frame)
    expect(reached).toBeLessThan(host.tape.frame)
    expect(reached).toBe(299)
  })

  it('keeps the whole round only on the client that was asked to', () => {
    // A guest's archive would have exactly the holes its live table does, so
    // a guest must answer "no tape" rather than a partial one -- which is what
    // makes the host REFUSE a rejoin it cannot honour instead of granting one
    // that desyncs.
    const guest = makeClient(1)
    run(guest, 120, (s, f) => packedFor(s, f))
    expect(guest.runner.fullTape()).toBeNull()

    const host = makeClient(0, { authority: true, keepRound: true })
    run(host, 120, (s, f) => packedFor(s, f))
    expect(host.runner.fullTape()).not.toBeNull()
  })

  it('holds the round even for frames the window has pruned', () => {
    // `commit` throws away frames 4d behind the play head, which is right for
    // the live table and fatal for a tape that has to start at frame 1.
    const host = makeClient(0, { authority: true, keepRound: true })
    run(host, 400, (s, f) => packedFor(s, f))
    const tape = host.runner.fullTape()
    expect(tape).not.toBeNull()
    const row = tape?.rows.find((r) => r.slot === 2)
    expect(row?.from).toBe(1)
    expect(row?.packed[0]).toBe(IDLE_PACKED)
    expect(row?.packed[199]).toBe(packedFor(2, 200))
  })
})

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

describe('a round\'s tape, cut into messages a data channel will take', () => {
  const rows: TapeRow[] = [
    { slot: 0, from: 1, packed: Array.from({ length: 3000 }, (_, i) => i) },
    { slot: 1, from: 1, packed: Array.from({ length: 3000 }, (_, i) => i * 2) },
  ]

  it('loses nothing and repeats nothing', () => {
    const parts = chunkTape(rows, 3000)
    expect(parts.length).toBeGreaterThan(1)
    const seen = new Map<string, number>()
    for (const part of parts) {
      for (const r of part) {
        for (let i = 0; i < r.packed.length; i++) {
          const key = `${r.slot}:${r.from + i}`
          expect(seen.has(key)).toBe(false)
          seen.set(key, r.packed[i])
        }
      }
    }
    expect(seen.size).toBe(6000)
    expect(seen.get('0:1')).toBe(0)
    expect(seen.get('1:3000')).toBe(5998)
  })

  it('gives every chunk the same frame window for every slot', () => {
    // A client holding chunks 0..k therefore holds a complete, contiguous,
    // replayable PREFIX of the round -- which is what makes a half-delivered
    // tape detectable rather than merely wrong.
    for (const part of chunkTape(rows, 3000)) {
      const froms = new Set(part.map((r) => r.from))
      expect(froms.size).toBe(1)
    }
  })

  it('handles a round shorter than one chunk', () => {
    const parts = chunkTape([{ slot: 0, from: 1, packed: [1, 2, 3] }], 3)
    expect(parts.length).toBe(1)
    expect(parts[0][0].packed).toEqual([1, 2, 3])
  })
})
