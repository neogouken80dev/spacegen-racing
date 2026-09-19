/**
 * DETERMINISTIC LOCKSTEP, TESTED AS PURE LOGIC.
 *
 * Everything here runs with no browser, no peer connection and no timers but
 * the injected ones. The wire is proved separately, by tools/probe-netcode.mjs,
 * which opens two real Chromium contexts and a real RTCPeerConnection between
 * them; what a probe CANNOT do is stand a race still for five seconds, kill a
 * link at a chosen frame, or hand two clients deliberately different input
 * tapes and check they still agree to the byte. Those are the properties that
 * decide whether the netcode is right, so they are the ones pinned here.
 *
 * ONE RACE AT A TIME, AND THAT IS NOT A CONVENIENCE.
 *
 * `sim/ai.ts` keeps its per-racer memory in MODULE state keyed by racer id, so
 * two `Race` objects stepped alternately in one process share one AI brain per
 * slot and read each other's writes. tests/multiplayer.test.ts found that the
 * hard way and says so at length. So every "do two clients agree" test below
 * runs client A to completion, calls `resetAI()`, then runs client B to
 * completion against A's recorded tape -- which is exactly what lockstep is
 * anyway (one tape, two machines) and is the only shape that is honest in this
 * process.
 *
 * THE INPUT TAPES ARE FUNCTIONS OF THE FRAME NUMBER and never of the race
 * state, which is what makes running the two clients sequentially legitimate:
 * neither client's input depends on the other's car, so there is no
 * circularity to unwind.
 */
import { describe, it, expect } from 'vitest'
import {
  DesyncWatch, HASH_EVERY, IDLE_PACKED, LockstepRunner, LockstepScheduler,
  LOAD_GRACE_MS, SETTLE_FRAMES, STALL_ANNOUNCE_MS, STALL_DROP_MS,
  packInput, unpackInput,
  type RunnerTransport, type SlotHealth,
} from '../src/net/lockstep'
import { Race } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { resetAI } from '../src/sim/ai'
import { RUSTFALL } from '../src/content/tracks/rustfall'
import { CHASSIS } from '../src/content/chassis'
import { PILOTS } from '../src/content/pilots'
import { emptyInput, type InputFrame, type SimConfig } from '../src/sim/types'
import { LiveRaceTransport } from '../src/net/live'
import type { StarMesh } from '../src/net/webrtc'

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

describe('a frame of stick, in 27 bits', () => {
  it('round-trips a dead-centre stick to exactly zero', () => {
    // THE BUG THIS EXISTS FOR. The obvious encoding, round((s+1)/2*1023),
    // sends neutral to 511.5 and brings it back as +0.00098 -- a permanent
    // fractional right-hand steering input on every car in the field, which
    // over a two-minute race walks into the outside barrier on every straight.
    const f = emptyInput()
    expect(unpackInput(packInput(f)).steer).toBe(0)
  })

  it('round-trips full lock and full throttle exactly', () => {
    const f = emptyInput()
    f.steer = -1; f.throttle = 1; f.brake = 1
    const back = unpackInput(packInput(f))
    expect(back.steer).toBe(-1)
    expect(back.throttle).toBe(1)
    expect(back.brake).toBe(1)
    f.steer = 1
    expect(unpackInput(packInput(f)).steer).toBe(1)
  })

  it('carries every button', () => {
    const f = emptyInput()
    f.drift = true; f.item = true; f.itemBack = true; f.lift = true; f.lookBack = true
    const back = unpackInput(packInput(f))
    expect(back).toMatchObject({
      drift: true, item: true, itemBack: true, lift: true, lookBack: true,
    })
    expect(unpackInput(packInput(emptyInput()))).toMatchObject({
      drift: false, item: false, itemBack: false, lift: false, lookBack: false,
    })
  })

  it('is idempotent, so a packed value never drifts on a second trip', () => {
    // A client packs, a peer unpacks, and if a re-pack of that produced a
    // different number nothing downstream could ever be compared.
    for (const s of [-1, -0.7331, -1 / 3, 0, 0.1, 1 / 3, 0.9999, 1]) {
      const f = emptyInput()
      f.steer = s; f.throttle = 0.37; f.brake = 0.02
      const once = packInput(f)
      expect(packInput(unpackInput(once))).toBe(once)
    }
  })

  it('fits in the range JavaScript bitwise operators work in', () => {
    const f = emptyInput()
    f.steer = 1; f.throttle = 1; f.brake = 1
    f.drift = f.item = f.itemBack = f.lift = f.lookBack = true
    const p = packInput(f)
    expect(p).toBeLessThan(2 ** 27)
    expect(p | 0).toBe(p)
  })
})

// ---------------------------------------------------------------------------
// The scheduler
// ---------------------------------------------------------------------------

const SLOTS = [0, 1, 2]
const healthy: SlotHealth = () => 'up'

function sched(delay = 4, authority = true): LockstepScheduler {
  return new LockstepScheduler({ slots: SLOTS, localSlot: 0, inputDelay: delay, authority })
}

describe('the pipeline primes itself', () => {
  it('is ready for the first inputDelay frames with nothing on the wire', () => {
    // Without this the very first frame of every race would stall for ever,
    // waiting on inputs nobody was ever asked for: the first sample any client
    // takes is published for frame 1 + inputDelay.
    const s = sched(4)
    for (let f = 1; f <= 4; f++) expect(s.ready(f)).toBe(true)
    expect(s.ready(5)).toBe(false)
  })

  it('primes with neutral, not with whatever was last seen', () => {
    const s = sched(3)
    for (let f = 1; f <= 3; f++) expect(s.inputAt(1, f)).toBe(IDLE_PACKED)
  })
})

describe('readiness', () => {
  it('names exactly who is missing', () => {
    const s = sched(2)
    s.receive(0, 3, 111)
    s.receive(2, 3, 222)
    expect(s.ready(3)).toBe(false)
    expect(s.missing(3)).toEqual([1])
    s.receive(1, 3, 333)
    expect(s.ready(3)).toBe(true)
    expect(s.missing(3)).toEqual([])
  })

  it('ignores a repeat rather than overwriting it', () => {
    // The mailbox and the host's relay are both at-least-once. An input that
    // changed value between two deliveries of the same frame would be a desync
    // with no other symptom at all.
    const s = sched(2)
    s.receive(1, 9, 4242)
    s.receive(1, 9, 7)
    expect(s.inputAt(1, 9)).toBe(4242)
  })

  it('forgets nothing it still needs when it prunes', () => {
    const s = sched(4)
    for (const slot of SLOTS) for (let f = 5; f <= 200; f++) s.receive(slot, f, f)
    s.commit(200)
    expect(s.ready(200)).toBe(true)
    // Behind the play head by more than the window, and gone -- which is the
    // point: a late duplicate must be recognised as late, not re-inserted.
    expect(s.inputAt(1, 10)).toBeUndefined()
  })
})

describe('the stall policy', () => {
  it('says nothing for the first 300ms, then names the player', () => {
    const s = sched(2)
    s.receive(0, 3, 1); s.receive(2, 3, 1)
    expect(s.update(1000, 3, healthy).announce).toBe(false)
    expect(s.update(1000 + STALL_ANNOUNCE_MS - 1, 3, healthy).announce).toBe(false)
    const r = s.update(1000 + STALL_ANNOUNCE_MS, 3, healthy)
    expect(r.announce).toBe(true)
    expect(r.waiting).toEqual([1])
  })

  it('clears the clock the moment the input lands', () => {
    const s = sched(2)
    s.receive(0, 3, 1); s.receive(2, 3, 1)
    s.update(1000, 3, healthy)
    s.update(1000 + 2000, 3, healthy)
    s.receive(1, 3, 1)
    const r = s.update(1000 + 2001, 3, healthy)
    expect(r.sinceMs).toBe(0)
    expect(r.announce).toBe(false)
  })

  /** A frame late enough that the race is properly under way. */
  const LIVE = SETTLE_FRAMES + 10

  it('waits five seconds for a link that is still alive', () => {
    const s = sched(2)
    // Slot 1 has been heard from before, so this is a peer who has GONE quiet
    // rather than one who has not arrived -- a different deadline entirely.
    s.receive(1, LIVE - 1, 1)
    s.receive(0, LIVE, 1); s.receive(2, LIVE, 1)
    s.update(0, LIVE, healthy)
    expect(s.update(STALL_DROP_MS - 1, LIVE, healthy).expire).toEqual([])
    expect(s.update(STALL_DROP_MS, LIVE, healthy).expire).toEqual([1])
  })

  it('is patient for the whole countdown, even with a peer who has spoken', () => {
    // THE OTHER HALF OF THE LOADING CASE, and the one that is easy to miss: a
    // guest publishes its first inputs the instant its runner exists and THEN
    // blocks for five seconds finishing the first render of the circuit. It
    // has spoken, so "never heard from" does not catch it -- and during the
    // countdown nobody is driving, so waiting costs nothing.
    const s = sched(2)
    s.receive(1, 10, 1)
    s.receive(0, 11, 1); s.receive(2, 11, 1)
    s.update(0, 11, healthy)
    const late = s.update(STALL_DROP_MS + 1, 11, healthy)
    expect(late.expire).toEqual([])
    expect(late.loading).toEqual([1])
  })

  it('gives a peer who has not sent anything yet twenty seconds, not five', () => {
    // THE CASE THAT BROKE EVERY PROBE RUN. The host presses Start and steps
    // immediately; a guest still swapping the circuit, building a track mesh
    // and compiling shaders cannot publish an input for several seconds, and
    // under the mid-race deadline it was ejected before the lights went out.
    const s = sched(2)
    s.receive(0, 3, 1); s.receive(2, 3, 1)
    s.update(0, 3, healthy)
    const mid = s.update(STALL_DROP_MS + 1, 3, healthy)
    expect(mid.expire).toEqual([])
    expect(mid.loading).toEqual([1])
    expect(s.update(LOAD_GRACE_MS, 3, healthy).expire).toEqual([1])
  })

  it('still drops a peer who is loading if their wire is demonstrably gone', () => {
    // The long deadline is for uncertainty. A closed tab is not uncertain.
    const s = sched(2)
    s.receive(0, 3, 1); s.receive(2, 3, 1)
    const dead: SlotHealth = (slot) => (slot === 1 ? 'down' : 'up')
    expect(s.update(0, 3, dead).expire).toEqual([1])
  })

  it('does not wait at all for a link that is gone', () => {
    // THE SPLIT THAT MATTERS. Five seconds is the price of uncertainty; a wire
    // that has demonstrably failed is not uncertain, and making six other
    // players stand still for it buys nothing.
    const s = sched(2)
    s.receive(0, 3, 1); s.receive(2, 3, 1)
    const dead: SlotHealth = (slot) => (slot === 1 ? 'down' : 'up')
    expect(s.update(0, 3, dead).expire).toEqual([1])
  })

  it('never proposes a drop on a client that is not the host', () => {
    // Eight clients each deciding who to eject is eight chances to eject
    // different people on different frames, which is a desync produced by the
    // machinery meant to prevent one.
    const guest = sched(2, false)
    guest.receive(0, 3, 1); guest.receive(2, 3, 1)
    const dead: SlotHealth = () => 'down'
    guest.update(0, 3, dead)
    const late = guest.update(STALL_DROP_MS * 2, 3, dead)
    expect(late.expire).toEqual([])
    // It still SAYS so, which is the half a guest is entitled to: the banner is
    // local, the decision is not.
    expect(late.announce).toBe(true)
  })
})

describe('the drop frame is one every client can still honour', () => {
  it('is one past the last frame THAT PEER was heard for, not the room\'s', () => {
    // THE BUG THIS PINS, found by tools/probe-netcode.mjs and not by any unit
    // test that existed at the time. Using the horizon over EVERYBODY includes
    // the host's own published frames, which run `inputDelay` ahead of the one
    // being stepped -- so a peer last heard at 37 was declared AI from 41, and
    // 38, 39 and 40 were left in a hole that nothing could ever fill. Every
    // race deadlocked, and it looked exactly like a dead link.
    const s = sched(4)
    s.receive(0, 40, 1)
    s.receive(2, 37, 1)
    expect(s.horizon).toBe(40)
    expect(s.dropFrameFor(2)).toBe(38)
    expect(s.dropFrameFor(0)).toBe(41)
  })

  it('leaves no frame uncovered between the last input and the handover', () => {
    const s = sched(4)
    for (let f = 5; f <= 30; f++) { s.receive(0, f, 1); s.receive(2, f, 3) }
    for (let f = 5; f <= 20; f++) s.receive(1, f, 2)
    s.applyDrop(1, s.dropFrameFor(1))
    // Every frame from the first to well past the handover is answerable.
    for (let f = 1; f <= 30; f++) expect(s.missing(f)).not.toContain(1)
  })

  it('leaves the departing car driving on its own last inputs', () => {
    // A player whose wifi dies mid-corner finishes the corner: their real
    // inputs are already in the pipeline and are used, and only the frames
    // after the announcement are AI. That is what makes a drop invisible for
    // the `inputDelay` frames either side of it.
    const s = sched(4)
    for (let f = 5; f <= 20; f++) { s.receive(0, f, 1); s.receive(1, f, 2); s.receive(2, f, 3) }
    for (let f = 21; f <= 24; f++) { s.receive(0, f, 1); s.receive(2, f, 3) }
    // Slot 1 stopped at 20, so the AI starts at 21 -- NOT at the room's
    // horizon of 25, which would leave 21..24 with no input from anybody.
    const at = s.dropFrameFor(1)
    expect(at).toBe(21)
    s.applyDrop(1, at)
    // Frames 20 and below are covered by their own real inputs...
    expect(s.missing(20)).toEqual([])
    // ...and from 21 the AI has the wheel and slot 1 is never waited on again.
    expect(s.missing(21)).not.toContain(1)
    expect(s.missing(24)).not.toContain(1)
    expect(s.missing(9999)).not.toContain(1)
  })

  it('never moves a drop later once it has been agreed', () => {
    const s = sched(4)
    s.applyDrop(1, 100)
    s.applyDrop(1, 400)
    expect(s.aiFrom(1)).toBe(100)
  })

  it('makes two clients agree from one announcement', () => {
    const host = sched(4, true)
    const guest = sched(4, false)
    host.applyDrop(2, 77)
    guest.applyDrop(2, 77)
    for (const f of [76, 77, 78, 500]) {
      expect(host.ready(f) === guest.ready(f)).toBe(true)
      expect(host.aiFrom(2)).toBe(guest.aiFrom(2))
    }
  })
})

// ---------------------------------------------------------------------------
// The desync detector
// ---------------------------------------------------------------------------

describe('the desync detector', () => {
  it('says nothing while the clients agree', () => {
    const w = new DesyncWatch()
    w.recordLocal(30, 'aaaa1111')
    expect(w.recordPeer(1, 30, 'aaaa1111')).toEqual([])
    expect(w.diverged.size).toBe(0)
  })

  it('parks a hash for a frame we have not reached, and judges it later', () => {
    // With inputDelay frames of slack a peer is routinely a few frames ahead.
    // Counting that as a mismatch would make the detector a false-alarm
    // generator and the first thing anyone did would be to turn it off.
    const w = new DesyncWatch()
    expect(w.recordPeer(1, 60, 'bbbb2222')).toEqual([])
    expect(w.diverged.size).toBe(0)
    expect(w.recordLocal(60, 'cccc3333')).toEqual([1])
    expect(w.diverged.get(1)).toBe(60)
  })

  it('agrees with a peer who was ahead', () => {
    const w = new DesyncWatch()
    w.recordPeer(1, 60, 'dddd4444')
    expect(w.recordLocal(60, 'dddd4444')).toEqual([])
  })

  it('records the frame divergence started, not the frame it was noticed', () => {
    const w = new DesyncWatch()
    w.recordLocal(30, 'a')
    w.recordPeer(1, 30, 'b')
    w.recordLocal(60, 'c')
    w.recordPeer(1, 60, 'd')
    expect(w.diverged.get(1)).toBe(30)
  })

  it('discards a hash so old the ring has dropped it rather than crying wolf', () => {
    const w = new DesyncWatch()
    for (let f = 1; f <= 200; f++) w.recordLocal(f, `h${f}`)
    expect(w.recordPeer(1, 1, 'anything')).toEqual([])
    expect(w.diverged.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The runner, against a real Race
// ---------------------------------------------------------------------------

const GRID = 8
const IDS = Array.from({ length: GRID }, (_, i) => `p${i}`)

/**
 * An eight-car grid with NO AI AT ALL.
 *
 * Every slot is a networked human, so `stepAI` is never called and the module
 * state tests/multiplayer.test.ts warns about is never touched. That keeps the
 * agreement tests measuring the netcode rather than measuring `sim/ai.ts`.
 */
function simConfig(localSlot: number): SimConfig {
  return {
    seed: 0x5eed1234,
    totalLaps: 3,
    racerCount: GRID,
    trackId: 'rustfall',
    chassisIds: Array.from({ length: GRID }, (_, i) => CHASSIS[i % CHASSIS.length].id),
    pilotIds: Array.from({ length: GRID }, (_, i) => PILOTS[i % PILOTS.length].id),
    localRacerIndex: localSlot,
    aiSkill: Array.from({ length: GRID }, (_, i) => 2 + (i % 3)),
  }
}

/**
 * A scripted stick, different per slot and a pure function of the frame.
 *
 * DIFFERENT PER SLOT IS THE WHOLE POINT of the agreement tests: if inputs were
 * not really being exchanged, each client would be driving seven cars from
 * assumptions rather than from data, and the hashes would part company inside
 * a second. Agreement is only evidence because the tapes disagree.
 */
function tapeFor(slot: number, frame: number): InputFrame {
  const f = emptyInput()
  f.throttle = 1
  f.steer = Math.sin((frame + slot * 37) * 0.03) * (0.4 + slot * 0.07)
  f.drift = ((frame + slot * 11) % 90) < 25
  return f
}

/** Records what a runner put on the wire, and lets a test put things back. */
class Tap implements RunnerTransport {
  onInput: (playerId: string, frame: number, packed: number) => void = () => {}
  onHash: (playerId: string, frame: number, hash: string) => void = () => {}
  onDropped: (playerId: string) => void = () => {}
  readonly inputs: { frame: number; packed: number }[] = []
  readonly hashes: { frame: number; hash: string }[] = []
  sendInput(frame: number, packed: number): void { this.inputs.push({ frame, packed }) }
  sendHash(frame: number, hash: string): void { this.hashes.push({ frame, hash }) }
}

interface RunOptions {
  /** Frames to run. */
  steps: number
  inputDelay?: number
  /** Slots this client is told nothing about from this frame on. */
  silentFrom?: { slot: number; frame: number }
  /** The agreed AI handover frame, applied by every client identically. */
  dropAt?: { slot: number; frame: number }
  /** Slots that are networked humans. Everything else is AI. */
  human?: readonly number[]
}

/**
 * Run one client to completion and return its hash checkpoints.
 *
 * Peers' inputs are injected exactly where the wire would put them -- at the
 * top of frame F, for frame F + inputDelay -- so the scheduler, the priming
 * and the publish offset are all exercised for real.
 */
function runClient(localSlot: number, o: RunOptions): {
  hashes: string[]
  runner: LockstepRunner
  tap: Tap
} {
  resetAI()
  const human = o.human ?? IDS.map((_, i) => i)
  const delay = o.inputDelay ?? 4
  const race = new Race(new Track(RUSTFALL), simConfig(localSlot))
  const tap = new Tap()
  const players = new Map<number, string>(human.map((s) => [s, IDS[s]]))
  const runner = new LockstepRunner({
    race, transport: tap, players, localSlot, inputDelay: delay, authority: false,
    now: () => 0,
  })
  const hashes: string[] = []
  for (let i = 0; i < o.steps; i++) {
    const target = race.state.frame + 1 + delay
    for (const slot of human) {
      if (slot === localSlot) continue
      if (o.silentFrom && slot === o.silentFrom.slot && target >= o.silentFrom.frame) continue
      tap.onInput(IDS[slot], target, packInput(tapeFor(slot, target)))
    }
    if (o.dropAt && race.state.frame + 1 === o.dropAt.frame) {
      runner.acceptDrop(IDS[o.dropAt.slot], o.dropAt.frame)
    }
    if (!runner.beforeStep(tapeFor(localSlot, race.state.frame + 1 + delay))) break
    race.step()
    if (race.state.frame % 60 === 0) hashes.push(race.hash())
  }
  hashes.push(race.hash())
  return { hashes, runner, tap }
}

describe('two clients, one tape', () => {
  it('produce byte-identical races from the same packet and different sticks', () => {
    // THE CLAIM THE WHOLE FEATURE RESTS ON. Eight cars, eight different input
    // tapes, two clients sitting in different seats, and a determinism hash
    // that has to match at every checkpoint -- not only at the end, because
    // two races that diverge and then coincidentally agree once is worth
    // nothing and the value of a hash is catching the frame it happened.
    const a = runClient(0, { steps: 600 })
    const b = runClient(5, { steps: 600 })
    expect(a.hashes.length).toBeGreaterThan(8)
    expect(b.hashes).toEqual(a.hashes)
  })

  it('agree at a long input delay as well as a short one', () => {
    const a = runClient(0, { steps: 300, inputDelay: 12 })
    const b = runClient(7, { steps: 300, inputDelay: 12 })
    expect(b.hashes).toEqual(a.hashes)
  })

  it('steps the local player on the QUANTISED stick, not on their own float', () => {
    // The regression this file's header is about, asserted where it actually
    // happens rather than through a hash: every REMOTE client necessarily
    // steps the unpacked value, so a local client that handed the sim its own
    // float would be stepping a different number from everybody else on frame
    // one -- and the symptom would be "we desync immediately, on every race",
    // which looks exactly like a broken protocol.
    resetAI()
    const race = new Race(new Track(RUSTFALL), simConfig(0))
    const seen: InputFrame[] = []
    const real = race.setInput.bind(race)
    race.setInput = (id: number, f: InputFrame): void => {
      if (id === 0) seen.push({ ...f })
      real(id, f)
    }
    const tap = new Tap()
    const runner = new LockstepRunner({
      race, transport: tap, players: new Map(IDS.map((id, i) => [i, id])),
      localSlot: 0, inputDelay: 4, authority: false, now: () => 0,
    })
    const stick = emptyInput()
    stick.throttle = 1
    // A value that does NOT survive 10 bits: 1/3 quantises to 170/511.
    stick.steer = 1 / 3
    for (let i = 0; i < 6; i++) {
      const target = race.state.frame + 1 + 4
      for (let slot = 1; slot < GRID; slot++) tap.onInput(IDS[slot], target, IDLE_PACKED)
      runner.beforeStep(stick)
      race.step()
    }
    const applied = seen[seen.length - 1]
    expect(applied.steer).not.toBe(1 / 3)
    expect(applied.steer).toBe(unpackInput(packInput(stick)).steer)
  })
})

describe('a peer who goes away mid-race', () => {
  it('keeps the sim running and hands their car to the AI on an agreed frame', () => {
    // The requirement in two halves: the race must NOT stop, and the two
    // clients must still agree afterwards -- which they only can if the AI
    // takes the wheel on the same frame in both.
    const drop = { slot: 3, frame: 200 }
    const silent = { slot: 3, frame: 200 }
    const a = runClient(0, { steps: 500, dropAt: drop, silentFrom: silent })
    const b = runClient(6, { steps: 500, dropAt: drop, silentFrom: silent })
    // It ran to the end rather than stalling at 200.
    expect(a.hashes.length).toBeGreaterThan(7)
    expect(b.hashes).toEqual(a.hashes)
    expect(a.runner.verdict).toBe('racing')
  })

  it('drives that car with `isAI`, which is the mechanism already there', () => {
    const a = runClient(0, {
      steps: 260, dropAt: { slot: 3, frame: 200 }, silentFrom: { slot: 3, frame: 200 },
    })
    expect(a.runner.droppedSlots).toEqual([3])
  })

  it('stalls, rather than inventing inputs, when nobody has agreed a frame', () => {
    // A client that guessed would be a client that had silently left the race
    // everybody else is in. Waiting is the correct behaviour and the reason
    // the stall policy exists at all.
    const a = runClient(0, { steps: 500, silentFrom: { slot: 3, frame: 200 } })
    expect(a.runner.verdict).toBe('waiting')
    // 200 is the frame the input was for; with inputDelay 4 the race gets to
    // step up to 199 and then holds.
    expect(a.hashes.length).toBeLessThan(5)
  })
})

describe('the hash goes out on its own', () => {
  it('publishes twice a second and no more often', () => {
    const a = runClient(0, { steps: 300 })
    // Frames 30, 60 .. 270. The hash for a frame goes out on the step AFTER
    // it, because it is a hash OF that frame -- so 300 itself is not sent by a
    // run that stops at 300.
    expect(a.tap.hashes.map((h) => h.frame))
      .toEqual(Array.from({ length: 9 }, (_, i) => (i + 1) * HASH_EVERY))
  })

  it('stops the round the moment a peer disagrees', () => {
    const a = runClient(0, { steps: 300 })
    expect(a.runner.verdict).toBe('racing')
    // A peer insisting on a different hash for a frame we have already passed.
    const seen = a.tap.hashes[2]
    a.tap.onHash(IDS[4], seen.frame, 'deadbeef')
    expect(a.runner.verdict).toBe('desync')
    expect(a.runner.desyncFrame).toBe(seen.frame)
    // And nothing more is stepped, which is the policy: a round whose result
    // is already a lie must not be scored into a series.
    expect(a.runner.beforeStep(emptyInput())).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The transport outlives the round
// ---------------------------------------------------------------------------

/**
 * `SeriesPlan` lets a lobby run 1, 3, 5 or 8 rounds, and the peer connections
 * are a property of the ROOM while the frame counter is a property of the
 * ROUND. So `LiveRaceTransport` is rebuilt per round over a mesh that is not,
 * and every race message carries its round number.
 *
 * THE BUG THIS GUARDS is specific and would be very hard to find in the field:
 * the last inputs of round 2 are still in flight while round 3 is priming its
 * pipeline, and an unstamped packet would be accepted as a round 3 frame. It
 * would land as a desync on the first corner of every round after the first,
 * on some clients and not others, depending on timing.
 */
class FakeMesh {
  readonly selfId = 'me'
  readonly hostId: string
  readonly isHost: boolean
  readonly sent: { to: string; msg: unknown }[] = []
  constructor(isHost: boolean) {
    this.isHost = isHost
    this.hostId = isHost ? 'me' : 'host'
  }
  send(to: string, msg: unknown): boolean { this.sent.push({ to, msg }); return true }
  broadcast(msg: unknown, except?: string): number {
    this.sent.push({ to: except ? `all-but-${except}` : 'all', msg })
    return 1
  }
  worstPathMs(): number { return 0 }
}

const transportFor = (isHost: boolean, round: number) => {
  const mesh = new FakeMesh(isHost)
  const live = new Set(['host', 'guest'])
  const t = new LiveRaceTransport(mesh as unknown as StarMesh, round, live)
  return { mesh, t }
}

describe('a transport that outlives the round', () => {
  it('stamps the round on everything it sends', () => {
    const { mesh, t } = transportFor(false, 3)
    t.sendInput(120, 4242)
    t.sendHash(120, 'abcd1234')
    expect(mesh.sent.map((s) => (s.msg as { r: number }).r)).toEqual([3, 3])
  })

  it('discards a packet from the round that just ended', () => {
    const { t } = transportFor(true, 3)
    const got: number[] = []
    t.onInput = (_id, f) => got.push(f)
    t.accept('guest', { t: 'in', r: 2, f: 900, p: 1 })
    t.accept('guest', { t: 'in', r: 3, f: 5, p: 1 })
    t.accept('guest', { t: 'in', r: 4, f: 5, p: 1 })
    expect(got).toEqual([5])
  })

  it('relays a guest input to the other guests, addressed, and not back', () => {
    // A guest has no way to know whose input it is receiving: everything
    // arrives on the one channel it has, from the host, whoever it started
    // life with. So the host stamps the sender on the way through.
    const { mesh, t } = transportFor(true, 1)
    t.accept('guest', { t: 'in', r: 1, f: 42, p: 7 })
    expect(mesh.sent).toHaveLength(1)
    expect(mesh.sent[0].to).toBe('all-but-guest')
    expect(mesh.sent[0].msg).toMatchObject({ t: 'in', r: 1, f: 42, p: 7, id: 'guest' })
  })

  it('ignores a peer who has already been dropped from this round', () => {
    const { t } = transportFor(true, 1)
    const got: number[] = []
    t.onInput = (_id, f) => got.push(f)
    t.accept('guest', { t: 'in', r: 1, f: 10, p: 1 })
    t.announceDrop('guest', 11)
    t.accept('guest', { t: 'in', r: 1, f: 12, p: 1 })
    expect(got).toEqual([10])
  })

  it('only the host judges hashes', () => {
    // A guest that compared hashes would be an eighth independent opinion
    // about who diverged, which is one more thing to disagree about at
    // exactly the moment disagreement is the problem.
    const guest = transportFor(false, 1)
    let judged = 0
    guest.t.onHash = () => { judged++ }
    guest.t.accept('host', { t: 'hash', r: 1, f: 30, h: 'aaaa' })
    expect(judged).toBe(0)
    const host = transportFor(true, 1)
    host.t.onHash = () => { judged++ }
    host.t.accept('guest', { t: 'hash', r: 1, f: 30, h: 'aaaa' })
    expect(judged).toBe(1)
  })
})
