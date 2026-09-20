/**
 * THE LOBBY RACE — everything a photograph of one cannot tell you.
 *
 * A screenshot of a multiplayer race shows eight cars, name plates and a HUD.
 * It cannot show that the eight cars are the ones the HOST published rather
 * than the eight this client would have invented; that the player's own slot
 * came from the packet rather than from pole position; that the car answering
 * the stick is the player's and not slot 0's; or that a championship somebody
 * is halfway through is still exactly where they left it afterwards. Every one
 * of those is quiet when it breaks, and every one of them is arithmetic over a
 * small object, so every one of them is here.
 *
 * WHY `multiplayerSimConfig` IS EXPORTED AT ALL. It is the single place a
 * `RaceStartPacket` becomes a `SimConfig`, it is pure, and the alternative --
 * inlining it in `startRace` -- would put the most breakable decision in the
 * feature behind a WebGL context and a DOM. Same argument as `plateRoster` in
 * render/nameplates.ts and the whole of game/circuit.ts.
 *
 * THE DETERMINISM BLOCK IS THE POINT OF THE FILE. The entire netcode plan is
 * "one seed and an ordered grid is the whole handshake", and that is a claim
 * about this function's output, not about the transport that does not exist
 * yet. If it is going to stop being true it should stop here, loudly, rather
 * than be discovered as a desync in a race somebody was enjoying.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { multiplayerSimConfig, standInSkill } from '../src/game/main'
import { Race } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { resetAI } from '../src/sim/ai'
import { RUSTFALL } from '../src/content/tracks/rustfall'
import { CHASSIS } from '../src/content/chassis'
import { PILOTS } from '../src/content/pilots'
import { emptyInput, type InputFrame, type SimConfig } from '../src/sim/types'
import { TUNING as T } from '../src/content/tuning'
import {
  CIRCUIT_GRID, gridMismatch, loadCircuit, newCircuit, saveCircuit,
} from '../src/game/circuit'
import type { MultiplayerSlot, RaceStartPacket } from '../src/net/types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GRID = 8
/** Where the local player sits in every fixture below, and deliberately not 0.
 *  See the header on the non-zero-slot block. */
const LOCAL_SLOT = 5
const LOCAL_ID = 'p-local'

/**
 * A plausible eight-car lobby grid: three people and five bots, with the local
 * player NEITHER the host NOR on pole. That shape is chosen so a slot-0
 * assumption anywhere fails loudly: the host is slot 0, the reader is slot 5,
 * and the two are different cars with different chassis.
 */
function grid(overrides: Partial<MultiplayerSlot>[] = []): MultiplayerSlot[] {
  const humans: Record<number, string> = { 0: 'p-host', 2: 'p-other', [LOCAL_SLOT]: LOCAL_ID }
  return Array.from({ length: GRID }, (_, i): MultiplayerSlot => ({
    slot: i,
    playerId: humans[i] ?? null,
    name: humans[i] ? `PLAYER-${i}` : `DRONE-${i}`,
    avatarId: humans[i] ? 'cadet' : null,
    // Walked backwards through the roster so no slot holds the chassis the
    // single-race generator would have put there, and so slot 0 and slot 5 are
    // never the same car.
    chassisId: CHASSIS[(CHASSIS.length - 1 - (i % CHASSIS.length))].id,
    pilotId: PILOTS[(i * 3) % PILOTS.length].id,
    isHost: i === 0,
    aiSkill: humans[i] ? null : 1 + (i % 4),
    ...overrides[i],
  }))
}

function packet(over: Partial<RaceStartPacket> = {}): RaceStartPacket {
  return {
    lobbyId: 'lb-1',
    localPlayerId: LOCAL_ID,
    trackId: 'rustfall',
    laps: T.race.totalLaps,
    // A SINGLE RACE, WHICH IS A SERIES OF ONE. The default packet says so
    // explicitly rather than leaving the three fields off, because that is
    // what the contract means by one code path: the one-off case is the
    // series case with `length: 1`, and a fixture that skipped the fields
    // would be testing a packet the wire cannot produce.
    round: 0,
    seriesLength: 1,
    standings: [],
    seed: 0x5eed1234,
    grid: grid(),
    inputDelay: 4,
    ...over,
  }
}

/** The config, asserted non-null. Every test that uses this is about what the
 *  config SAYS, so a null here is a failure of the test's premise. */
function config(p: RaceStartPacket = packet()): SimConfig {
  const c = multiplayerSimConfig(p, p.trackId)
  expect(c, 'the fixture packet must resolve').not.toBeNull()
  return c as SimConfig
}

function race(c: SimConfig): Race {
  // The AI keeps per-racer memory in module state; two races that are supposed
  // to be identical must not inherit one another's.
  resetAI()
  return new Race(new Track(RUSTFALL), c)
}

/** Full throttle and a hard left, which is a tape no AI ever produces and no
 *  car survives without changing where it is. */
function tape(): InputFrame {
  const f = emptyInput()
  f.throttle = 1
  f.steer = -1
  return f
}

/** Step a race, optionally feeding a tape into one slot every frame. */
function drive(r: Race, steps: number, into: number | null, frame: InputFrame | null): void {
  for (let i = 0; i < steps; i++) {
    if (into !== null && frame !== null) r.setInput(into, frame)
    r.step()
  }
}

/**
 * Build a race from a packet, drive the local slot, and return the hash at a
 * spread of frames.
 *
 * ONE RACE AT A TIME, AND THAT IS NOT A STYLE CHOICE. `sim/ai.ts` keeps its
 * per-racer memory -- reaction timer, line bias, mistake timer -- in MODULE
 * state keyed by racer id, and `resetAI()` clears the lot. So two `Race`s
 * stepped alternately in one process share one AI brain per slot and diverge
 * from each other within a few hundred frames, which is a property of that
 * module and not of anything this file is testing. Written first the other way
 * round, it failed exactly like a determinism bug. (It is also worth knowing
 * before anyone builds a rollback netcode on a second shadow sim.)
 *
 * The checkpoints matter as much as the final hash: two races that diverge and
 * then happen to agree at the end is a coincidence, and the whole value of a
 * hash here is catching the divergence at the frame it happens.
 */
function run(p: RaceStartPacket, steps = 1200): string[] {
  const r = race(config(p))
  const t = tape()
  const out: string[] = []
  for (let i = 0; i < steps; i++) {
    r.setInput(LOCAL_SLOT, t)
    r.step()
    if (i % 200 === 0) out.push(r.hash())
  }
  out.push(r.hash())
  return out
}

// ---------------------------------------------------------------------------
// The grid is the packet's, not this client's
// ---------------------------------------------------------------------------

describe('the field comes from the packet', () => {
  it('puts every slot in the sim exactly where the packet put it', () => {
    const p = packet()
    const r = race(config(p))
    for (let i = 0; i < GRID; i++) {
      const slot = p.grid[i]
      expect(r.state.racers[i].id, `slot ${i} id`).toBe(slot.slot)
      expect(r.state.racers[i].chassisId, `slot ${i} chassis`).toBe(slot.chassisId)
      expect(r.state.racers[i].pilotId, `slot ${i} pilot`).toBe(slot.pilotId)
    }
  })

  it('reads a grid that arrives out of slot order by its slot, not its index', () => {
    // A packet is a broadcast off a wire. Nothing in the contract promises the
    // array is sorted, and three separate things downstream index cars BY SLOT
    // -- nameplates.ts does `racers[spec.slot]`, circuit scoring matches `r.id`,
    // and the config arrays here are positional. Trusting the array order
    // instead would swap two cars' identities and look perfectly fine.
    const ordered = grid()
    const shuffled = [...ordered].reverse()
    const c = config(packet({ grid: shuffled }))
    expect(c.chassisIds).toEqual(ordered.map((s) => s.chassisId))
    expect(c.pilotIds).toEqual(ordered.map((s) => s.pilotId))
    expect(c.localRacerIndex).toBe(LOCAL_SLOT)
  })

  it('ignores the garage entirely, including for the local player', () => {
    // THE FAILURE THIS EXISTS FOR. Circuit mode deliberately overwrites slot 0
    // with the player's current garage selection, which is right for a series
    // and catastrophic for a broadcast: it would put this client's car on the
    // HOST's grid slot while the player drove slot 5, on this client only.
    //
    // There is no garage to reach from a pure function, so the assertion is the
    // equivalent: nothing in the resolved config is absent from the packet.
    const p = packet()
    const c = config(p)
    for (let i = 0; i < GRID; i++) {
      expect(c.chassisIds[i]).toBe(p.grid[i].chassisId)
      expect(c.pilotIds[i]).toBe(p.grid[i].pilotId)
    }
    expect(c.seed).toBe(p.seed)
    expect(c.totalLaps).toBe(p.laps)
    expect(c.trackId).toBe(p.trackId)
  })

  it('runs the lobby lap count rather than the single-race one', () => {
    for (const laps of [1, 3, 5, 7, 10]) {
      expect(config(packet({ laps })).totalLaps).toBe(laps)
    }
  })

  it('publishes an AI skill for every slot, derived only where the packet has none', () => {
    const p = packet()
    const c = config(p)
    for (let i = 0; i < GRID; i++) {
      expect(c.aiSkill[i], `slot ${i} skill`)
        .toBe(p.grid[i].aiSkill ?? standInSkill(i))
    }
    // The stand-in is the same expression a single race and a circuit round use,
    // so a car filling a human's slot drives at a pace that already exists in
    // the game rather than one invented for multiplayer.
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((slot) => standInSkill(slot))).toEqual([2, 3, 4, 2, 3, 4, 2, 3])
  })
})

// ---------------------------------------------------------------------------
// The local player is not slot 0
// ---------------------------------------------------------------------------

describe('a local player who is not on pole', () => {
  it('takes their slot from the packet, not from the grid order', () => {
    expect(config().localRacerIndex).toBe(LOCAL_SLOT)
  })

  it('is the only racer the sim calls local', () => {
    const r = race(config())
    for (const car of r.state.racers) {
      expect(car.isLocal, `slot ${car.id} isLocal`).toBe(car.id === LOCAL_SLOT)
      expect(car.isAI, `slot ${car.id} isAI`).toBe(car.id !== LOCAL_SLOT)
    }
  })

  it('is genuinely the car taking input, and slot 0 is not', () => {
    /**
     * THE TEST THAT MATTERS, AND WHY IT IS WRITTEN THIS WAY.
     *
     * "The player is slot 5" is a claim about which car answers the stick, and
     * a flag on a struct is not that claim. So the same tape is fed into slot 5
     * of one race and into slot 0 of an identical one, and both are compared
     * against a race that was given no input at all:
     *
     *   into slot 5 -> must DIVERGE. That is the player driving.
     *   into slot 0 -> must be IDENTICAL. Slot 0 is AI here, and `Race.step`
     *                  overwrites an AI racer's input from `stepAI` every
     *                  frame, so a caller writing to the wrong slot changes
     *                  nothing -- which is exactly how a slot-0 assumption
     *                  would present in play: a car that does not steer.
     *
     * `Race.hash()` rather than a position compare, because the claim is about
     * the whole simulation and the hash is what the determinism gate already
     * uses.
     */
    const STEPS = 900 // past the countdown and into several seconds of racing
    const idle = race(config())
    drive(idle, STEPS, null, null)

    const player = race(config())
    drive(player, STEPS, LOCAL_SLOT, tape())

    const wrong = race(config())
    drive(wrong, STEPS, 0, tape())

    expect(player.hash(), 'input into slot 5 must change the race').not.toBe(idle.hash())
    expect(wrong.hash(), 'input into slot 0 must change nothing').toBe(idle.hash())
    // And the car that moved is the right one: the AI holds the racing line,
    // so a hard left for several seconds shows up as lateral offset.
    expect(Math.abs(player.state.racers[LOCAL_SLOT].lateral))
      .toBeGreaterThan(Math.abs(idle.state.racers[LOCAL_SLOT].lateral) + 0.5)
  })

  it('places the local player anywhere on the grid, not just at the two ends', () => {
    for (let slot = 0; slot < GRID; slot++) {
      const g = grid()
      // Move the reader's id onto `slot`, leaving everybody else alone.
      for (const s of g) if (s.playerId === LOCAL_ID) s.playerId = 'p-was-local'
      g[slot] = { ...g[slot], playerId: LOCAL_ID }
      const c = multiplayerSimConfig(packet({ grid: g }), 'rustfall')
      expect(c?.localRacerIndex, `reader on slot ${slot}`).toBe(slot)
    }
  })
})

// ---------------------------------------------------------------------------
// Determinism: the property the whole architecture rests on
// ---------------------------------------------------------------------------

describe('one packet, one race', () => {
  it('produces the same hash from two independent builds of the same packet', () => {
    /**
     * "ONE SEED AND AN ORDERED GRID IS THE WHOLE HANDSHAKE" -- net/types.ts.
     *
     * Two `Race`s built from the same packet and fed the same tape must agree
     * frame for frame. This is the claim every future line of netcode is
     * written against: it is what makes a start packet a handshake instead of a
     * negotiation, and it is what lets a client detect a desync from a hash
     * instead of from cars visibly disagreeing.
     *
     * Defended HERE because it is defensible here -- both halves are in this
     * process, with no transport to blame. The day it breaks it will be because
     * something crept into the config that the packet does not describe, and
     * this is the test that says so.
     */
    const p = packet()
    expect(run(p)).toEqual(run(p))
  })

  it('is a property of the packet, not of the harness', () => {
    // The equality above proves nothing if `hash()` is constant or if the tape
    // never reaches the sim. Change only the seed -- the one field the handshake
    // exists to agree on -- and the answer must move.
    expect(run(packet({ seed: 0x5eed1234 }))).not.toEqual(run(packet({ seed: 0x5eed1235 })))
  })

  it('hands every reader of one broadcast the identical config but their own slot', () => {
    // The only field of a start packet that may differ between readers is
    // `localPlayerId` -- see the note on it. So the only field of the resolved
    // config that may differ is `localRacerIndex`. If anything else does, two
    // clients are simulating two different races and the hash above is a
    // property of one machine rather than of the packet.
    const shared = grid()
    const host = config(packet({ grid: shared, localPlayerId: 'p-host' }))
    const me = config(packet({ grid: shared, localPlayerId: LOCAL_ID }))
    expect(host.localRacerIndex).toBe(0)
    expect(me.localRacerIndex).toBe(LOCAL_SLOT)
    expect({ ...host, localRacerIndex: 0 }).toEqual({ ...me, localRacerIndex: 0 })
    // aiSkill included, explicitly: it feeds stepAI inside the deterministic
    // sim, so a per-reader value there is a desync from frame one. It is the
    // reason the packet publishes the field at all.
    expect(host.aiSkill).toEqual(me.aiSkill)
  })

  it('normalises the seed so two clients cannot disagree about it', () => {
    expect(config(packet({ seed: -1 })).seed).toBe(0xffffffff)
    expect(config(packet({ seed: 2 ** 32 + 7 })).seed).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// Refusal
// ---------------------------------------------------------------------------

describe('a packet that cannot describe this client’s race is refused', () => {
  // Every one of these has two available fallbacks and both are worse than
  // refusing: slot 0 puts the player in somebody else's car for a whole race,
  // and -1 starts a race with no player in it. Both photograph perfectly.

  it('refuses a grid that is not eight cars', () => {
    expect(multiplayerSimConfig(packet({ grid: grid().slice(0, 6) }), 'rustfall')).toBeNull()
    expect(multiplayerSimConfig(packet({ grid: [...grid(), grid()[0]] }), 'rustfall')).toBeNull()
  })

  it('refuses a grid the reader is not on', () => {
    expect(multiplayerSimConfig(packet({ localPlayerId: 'p-nobody' }), 'rustfall')).toBeNull()
  })

  it('refuses a grid the reader is on twice', () => {
    const g = grid()
    g[1] = { ...g[1], playerId: LOCAL_ID }
    expect(multiplayerSimConfig(packet({ grid: g }), 'rustfall')).toBeNull()
  })

  it('refuses a duplicated or out-of-range slot number', () => {
    const dup = grid()
    dup[3] = { ...dup[3], slot: 4 }
    expect(multiplayerSimConfig(packet({ grid: dup }), 'rustfall')).toBeNull()

    const oob = grid()
    oob[3] = { ...oob[3], slot: 9 }
    expect(multiplayerSimConfig(packet({ grid: oob }), 'rustfall')).toBeNull()

    const frac = grid()
    frac[3] = { ...frac[3], slot: 3.5 }
    expect(multiplayerSimConfig(packet({ grid: frac }), 'rustfall')).toBeNull()
  })

  it('does not mistake an AI slot for the reader', () => {
    // `playerId` is null on an AI slot. A null-vs-null match would hand the
    // player whichever bot came first, which is the subtlest version of this
    // whole bug: the race starts, the HUD works, and the car is not theirs.
    const g = grid().map((s) => ({ ...s, playerId: null }))
    expect(multiplayerSimConfig(
      { ...packet(), grid: g, localPlayerId: null as unknown as string }, 'rustfall',
    )).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Multiplayer is not circuit mode
// ---------------------------------------------------------------------------

describe('a lobby race and a saved Grand Circuit', () => {
  const store = new Map<string, string>()
  const realWindow = (globalThis as { window?: unknown }).window

  function installStorage(): void {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        localStorage: {
          getItem: (k: string) => store.get(k) ?? null,
          setItem: (k: string, v: string) => { store.set(k, v) },
          removeItem: (k: string) => { store.delete(k) },
        },
      },
    })
  }

  afterEach(() => {
    store.clear()
    Object.defineProperty(globalThis, 'window', {
      configurable: true, writable: true, value: realWindow,
    })
  })

  it('leaves the save byte-identical across a whole lobby race', () => {
    installStorage()
    const saved = newCircuit('socket', 'solaire')
    saveCircuit(saved)
    const before = store.get('sg.circuit')
    expect(before, 'the fixture must actually have saved').toBeTruthy()

    // A COMPLETE lobby race -- all eight cars to the flag, not a few hundred
    // frames of one. A round is banked at the FINISH, so a test that stopped
    // short would be checking the one part of a race that was never going to
    // write anything.
    const r = race(config())
    const t = emptyInput()
    t.throttle = 1
    let steps = 0
    for (; steps < 45000 && r.state.phase !== 'finished'; steps++) {
      r.setInput(LOCAL_SLOT, t)
      r.step()
    }
    expect(r.state.phase, 'the fixture race must have finished').toBe('finished')
    expect(r.state.finishOrder.length).toBe(GRID)

    expect(store.get('sg.circuit')).toBe(before)
    expect(loadCircuit()).toEqual(saved)
  })

  it('would be caught by the shipped grid assertion if it were ever scored', () => {
    /**
     * THE SAFETY NET, TESTED RATHER THAN ASSUMED.
     *
     * `Game.scoreCircuitRound` is gated on `circuitActive`, which the lobby
     * path clears -- but a gate is one edit away from being wrong, and the
     * consequence of it being wrong is eight strangers banked into somebody's
     * championship standings with no way to tell afterwards. `gridMismatch` is
     * the assertion that already runs on every scored round, in the shipping
     * path. This pins that it actually fires on a lobby field, so the second
     * line of defence is real and not decorative.
     */
    installStorage()
    const saved = newCircuit('socket', 'solaire')
    const r = race(config())
    expect(r.state.racers.length).toBe(CIRCUIT_GRID)
    const bad = gridMismatch(saved.grid, r.state.racers)
    expect(bad.length, 'a lobby grid must not pass as a circuit grid').toBeGreaterThan(0)
  })
})
