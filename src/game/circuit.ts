/**
 * SpaceGen Racing — THE GRAND CIRCUIT.
 * ---------------------------------------------------------------------------
 * One series, eight rounds, every circuit on the roster exactly once. Points
 * by finishing position, and the driver with the most of them at the end is the
 * champion. Nothing here touches the simulation: this module decides WHO races,
 * WHERE, and WHAT IT WAS WORTH, and hands the answer to main.ts and the results
 * screen. It is deliberately pure apart from the three storage functions at the
 * bottom, because every interesting failure in a points series is an ordering
 * failure and those are cheap to test and impossible to see in a screenshot.
 *
 * ===========================================================================
 * WHY THIS ORDER, AND NOT THE ROSTER ORDER.
 *
 *   1  Elkarim          rustfall     Hard    the familiar one
 *   2  Halcyon Bay      halcyon      Easy    the ramp starts here
 *   3  Namaresh         aetherion    Easy    hazards you can learn
 *   4  Frosthelm        cryostatic   Medium  the first grip puzzle
 *   5  Ashkar           emberfall    Medium  one corner that can end a race
 *   6  Meridian Deep    abyssal      Hard    hard, but the widest road there is
 *   7  Centurion Prime  hollowchoir  Hard    down stops pointing down
 *   8  Zhen-9           neonspire    Hard    "the hardest lap in the game"
 *
 * ELKARIM OPENS DESPITE BEING RATED HARD. It is the circuit a player has
 * already driven: TRACKS[0], the remembered default in the track screen, the
 * one the smoke test and every probe drives. Round 1 on ground the player knows
 * measures the FIELD rather than the MAP -- it tells them where they stand
 * against these seven opponents before the series starts asking them to learn
 * anything. Opening on an unseen circuit makes round 1 a reading test.
 *
 * AFTER THAT IT IS A RAMP, and it restarts from the bottom rather than
 * continuing up from Hard. Halcyon Bay exists for exactly this job -- its own
 * copy says "a new driver needs a second opinion about what a corner feels
 * like" -- and a 15-point round that a mistake does not end is the right place
 * for a series to actually begin. Namaresh then adds hazards that are timed and
 * telegraphed (a 3.2s beat you can count) while grip is still generous, so the
 * player learns "the road is not always there" before anything is slippery.
 *
 * THE TWO MEDIUMS ARE THE TURN. Frosthelm is the first circuit where the
 * surface argues back (ice at 0.45 against snow at 1.0, and a lake that cracks
 * on lap 3); Ashkar is mostly spectacle with one corner -- the 441-degree
 * looper -- that can genuinely end a race.
 *
 * THE HARD BLOCK IS ORDERED BY HOW MUCH ROOM IT GIVES YOU. Meridian Deep is
 * Hard because of biofilm at 0.30 grip, but it is also the widest road on the
 * roster, so a tidy driver pays almost nothing. Centurion Prime takes away the
 * direction of down. Zhen-9 has no hostile surface at all and is the hardest
 * lap in the game on cornering alone, which makes it the right place for the
 * last 15 points -- a title still open going into round 8 is decided by driving
 * rather than by which planet was kinder.
 *
 * ===========================================================================
 * THE GRID IS FROZEN AT CIRCUIT CREATION. THIS IS THE WHOLE FEATURE.
 *
 * Standings only mean something if the seven cars they rank are the same seven
 * cars every round. main.ts's single-race grid generator CANNOT be reused here:
 * it derives the opponents' chassis from a pool that excludes whatever the
 * player is driving, so a player who changes car between rounds gets a
 * different set of opponents -- with the same pilot names on different cars,
 * which is worse than obviously different, because the standings still LOOK
 * consistent. So the grid is built once, stored, and replayed.
 *
 * FIVE CHASSIS AND SIX PILOTS FILL EIGHT SLOTS, so something has to repeat and
 * the only question is what. A repeated PILOT NAME would make a standings row
 * ambiguous -- "VANGUARD is 4 points ahead" cannot be read if there are two of
 * them -- so the roster below repeats a pilot at most once and guarantees every
 * (pilot, chassis) PAIR is unique, which is what the rows actually display.
 * tests/circuit.test.ts proves that exhaustively for all thirty cars a player
 * can turn up in, including the collision rotation below.
 */
import { CHASSIS } from '../content/chassis'
import { PILOTS } from '../content/pilots'

/**
 * Points by finishing position, 1st through 8th. Settled with Vince; not a
 * tuning value to be nudged.
 *
 * The shape matters more than the numbers: 15-12-10-8-6-4-2-1 puts a 3-point
 * gap at the front and a 1-point gap at the back, so the podium is where a
 * series is won and a bad round is survivable. A win is worth more than two
 * fourths (15 > 16 is false -- deliberately: two solid rounds DO beat one win,
 * which is what stops the series being decided by round 1).
 */
export const CIRCUIT_POINTS: readonly number[] = [15, 12, 10, 8, 6, 4, 2, 1]

/** Track ids in running order. See the header for the argument. */
export const CIRCUIT_TRACK_IDS: readonly string[] = [
  'rustfall',     // Elkarim         — Hard   — the familiar one
  'halcyon',      // Halcyon Bay     — Easy
  'aetherion',    // Namaresh        — Easy
  'cryostatic',   // Frosthelm       — Medium
  'emberfall',    // Ashkar          — Medium
  'abyssal',      // Meridian Deep   — Hard
  'hollowchoir',  // Centurion Prime — Hard
  'neonspire',    // Zhen-9          — Hard   — the finale
]

export const CIRCUIT_ROUNDS = CIRCUIT_TRACK_IDS.length

/** Grid size. Matches RACER_COUNT in game/main.ts; asserted in the tests. */
export const CIRCUIT_GRID = 8

/**
 * The seven opponents, in grid order behind the player.
 *
 * Fixed data rather than a generator, because the generator is precisely what
 * cannot be trusted to give the same answer twice. Chosen for spread: all five
 * chassis appear, every locomotion class is represented, and the one repeated
 * pilot (ZEPHYR) is repeated on two different cars.
 */
const OPPONENTS: readonly { pilotId: string; chassisId: string }[] = [
  { pilotId: 'vanguard', chassisId: 'vector7' },
  { pilotId: 'aegis', chassisId: 'bulwark' },
  { pilotId: 'zephyr', chassisId: 'filament' },
  { pilotId: 'triage', chassisId: 'dray9' },
  { pilotId: 'koan', chassisId: 'solaire' },
  { pilotId: 'socket', chassisId: 'bulwark' },
  { pilotId: 'zephyr', chassisId: 'dray9' },
]

/**
 * AI skill per grid slot.
 *
 * The same expression main.ts uses for a single race (`2 + (i % 3)` behind a
 * player at 0), reproduced rather than imported so a circuit's pace is
 * identical to a one-off race on the same circuit. Captured INTO the stored
 * grid so a later change to either formula cannot re-tune a series a player is
 * halfway through -- the saved circuit keeps the skills it was built with.
 */
function skillFor(slot: number): number {
  return slot === 0 ? 0 : 2 + (slot % 3)
}

export interface CircuitEntrant {
  /** Grid slot, and this entrant's racer id in every round. 0 is the player. */
  id: number
  pilotId: string
  chassisId: string
  aiSkill: number
}

/** One entrant's outcome in one round. */
export interface RoundFinish {
  id: number
  /**
   * Finishing position as the sim reported it, 1-based.
   *
   * A non-finisher HAS one -- sim/race.ts ranks the still-running field behind
   * the finishers by distance -- which is exactly why `finished` is stored
   * beside it and why points are not a function of position alone.
   */
  position: number
  finished: boolean
  /** Race time for a finisher; 0 for a DNF, which has no race time. */
  time: number
  /** Only read for the local slot. See applyRound. */
  pilotId?: string
  chassisId?: string
}

export interface RoundResult {
  trackId: string
  finishes: RoundFinish[]
}

/**
 * A circuit in progress.
 *
 * POINTS ARE NOT STORED. They are derived from `rounds` by standings() every
 * time, so there is exactly one source of truth and a saved circuit cannot come
 * back with a total that disagrees with the rounds that produced it. Rounds
 * completed is `rounds.length` for the same reason.
 */
export interface CircuitState {
  grid: CircuitEntrant[]
  rounds: RoundResult[]
}

/** One row of the championship table, already placed and already broken out. */
export interface StandingRow {
  entrant: CircuitEntrant
  points: number
  /** 1-based place in the standings. Shared by a genuine tie; see below. */
  place: number
  /** Finishes by position: counts[0] is wins, counts[7] is eighths. */
  counts: number[]
  /** Rounds entered and not finished. */
  dnf: number
  /** Rounds this entrant has a result for. */
  rounds: number
}

// ---------------------------------------------------------------------------
// Points
// ---------------------------------------------------------------------------

/**
 * What a finishing position was worth.
 *
 * A DNF SCORES ZERO, and that is a decision rather than an omission. The sim
 * gives a non-finisher a position anyway (it ranks the running field behind the
 * finishers), so paying out on position alone would hand 2 points to a car that
 * parked on lap 1 ahead of a car that parked on the grid -- and, worse, would
 * pay a player who quit the round the same as one who limped home. Zero makes
 * "get it home" the first thing a points series asks of you.
 */
export function pointsFor(position: number, finished: boolean): number {
  if (!finished) return 0
  if (!Number.isFinite(position)) return 0
  const i = Math.round(position) - 1
  return i >= 0 && i < CIRCUIT_POINTS.length ? CIRCUIT_POINTS[i] : 0
}

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

/**
 * A NAME APPEARS AT MOST TWICE ON THE GRID.
 *
 * Six pilots into eight slots means two names are shared however it is done,
 * and two is the floor. Three is not, and three is what the fixed roster gives
 * when the player happens to pick the pilot it already doubles: "ZEPHYR is four
 * points ahead" stops being a sentence once there are three ZEPHYRs, and the
 * chassis column only rescues it if the player reads two columns instead of
 * one. So a slot whose roster pilot is already twice-used takes the LEAST-USED
 * pilot instead, ties broken by roster order so the answer is deterministic.
 *
 * It fires for exactly one player choice in six and changes exactly one
 * opponent when it does -- and it fires before the circuit is frozen, never
 * during it, so no series ever sees its field move.
 */
const MAX_PER_PILOT = 2

/**
 * Build the eight-car grid for a new circuit.
 *
 * The player takes slot 0 with whatever they are driving. The seven opponents
 * come from OPPONENTS, with two adjustments, both aimed at the same thing --
 * that no two rows of the standings are indistinguishable:
 *
 *   - a pilot who would appear three times is swapped for the least-used one
 *     (see MAX_PER_PILOT above);
 *   - an opponent whose (pilot, chassis) pair exactly matches the player's
 *     rotates to the first chassis that pair is free in. Without it, picking
 *     AEGIS in a Bulwark puts an identical twin on the grid.
 *
 * Deterministic in its inputs, so the same player choice always produces the
 * same field -- and it is called once per circuit anyway, the result stored.
 */
export function buildGrid(localPilotId: string, localChassisId: string): CircuitEntrant[] {
  const grid: CircuitEntrant[] = [{
    id: 0, pilotId: localPilotId, chassisId: localChassisId, aiSkill: skillFor(0),
  }]
  const taken = new Set<string>([localPilotId + '/' + localChassisId])
  const uses = new Map<string, number>([[localPilotId, 1]])
  const used = (id: string): number => uses.get(id) ?? 0
  for (let i = 0; i < OPPONENTS.length; i++) {
    const o = OPPONENTS[i]
    let pilotId = o.pilotId
    if (used(pilotId) >= MAX_PER_PILOT) {
      // The least-used pilot, first by roster order. There is always one under
      // the cap: 6 pilots x 2 is 12 seats and only 8 are being filled.
      let best = pilotId
      for (const p of PILOTS) if (used(p.id) < used(best)) best = p.id
      pilotId = best
    }
    let chassisId = o.chassisId
    if (taken.has(pilotId + '/' + chassisId)) {
      // Walk the roster for a chassis this pilot is not already on the grid in.
      for (const c of CHASSIS) {
        if (!taken.has(pilotId + '/' + c.id)) { chassisId = c.id; break }
      }
    }
    taken.add(pilotId + '/' + chassisId)
    uses.set(pilotId, used(pilotId) + 1)
    grid.push({ id: i + 1, pilotId, chassisId, aiSkill: skillFor(i + 1) })
  }
  return grid
}

/** A fresh circuit with nothing raced. */
export function newCircuit(localPilotId: string, localChassisId: string): CircuitState {
  return { grid: buildGrid(localPilotId, localChassisId), rounds: [] }
}

/** Which circuit round `n` (0-based) is run on. */
export function trackIdForRound(n: number): string {
  return CIRCUIT_TRACK_IDS[Math.max(0, Math.min(CIRCUIT_ROUNDS - 1, n))]
}

/** Rounds completed. */
export function roundsDone(s: CircuitState): number {
  return Math.min(s.rounds.length, CIRCUIT_ROUNDS)
}

/** True once every round has been raced. */
export function isComplete(s: CircuitState): boolean {
  return roundsDone(s) >= CIRCUIT_ROUNDS
}

/**
 * Do these racers still match the frozen grid?
 *
 * Exported because it is the assertion the probe drives: two rounds of a real
 * circuit, and the seven opponent tuples have to come back byte-identical. A
 * mismatch is the failure this whole module exists to prevent, so it is worth
 * being able to ask the question from outside.
 */
export function gridMismatch(
  grid: readonly CircuitEntrant[],
  racers: readonly { id: number; pilotId: string; chassisId: string; aiSkill: number }[],
): string[] {
  const bad: string[] = []
  if (racers.length !== grid.length) {
    bad.push(`grid is ${grid.length} cars, race has ${racers.length}`)
  }
  for (const e of grid) {
    const r = racers.find((x) => x.id === e.id)
    if (!r) { bad.push(`slot ${e.id} is missing from the race`); continue }
    // Slot 0 is the player and their car is theirs to change between rounds.
    if (e.id === 0) continue
    if (r.pilotId !== e.pilotId) bad.push(`slot ${e.id} pilot ${r.pilotId} != ${e.pilotId}`)
    if (r.chassisId !== e.chassisId) bad.push(`slot ${e.id} chassis ${r.chassisId} != ${e.chassisId}`)
    if (r.aiSkill !== e.aiSkill) bad.push(`slot ${e.id} skill ${r.aiSkill} != ${e.aiSkill}`)
  }
  return bad
}

// ---------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------

/**
 * Turn a finished race into a round result.
 *
 * Takes the minimum it needs rather than a RaceState, so the whole of this
 * module stays testable without building a simulation.
 */
export function resultFromRace(
  trackId: string,
  racers: readonly {
    id: number; position: number; finished: boolean; finishTime: number
    pilotId?: string; chassisId?: string
  }[],
): RoundResult {
  return {
    trackId,
    finishes: racers.map((r) => ({
      id: r.id,
      position: r.position,
      finished: r.finished,
      time: r.finished ? r.finishTime : 0,
      pilotId: r.pilotId,
      chassisId: r.chassisId,
    })),
  }
}

/**
 * Apply a round. Pure: returns a new state rather than mutating, the same way
 * score/records.ts applyRun does, so "what did this round change" is a
 * comparison of two values.
 *
 * THE PLAYER'S OWN CAR IS REFRESHED AND THE OPPONENTS' ARE NOT. A player may
 * walk through the garage between rounds and turn up in something else; the
 * standings should show what they actually drove last. An opponent arriving in
 * a different car is not a feature to absorb, it is the bug this module is
 * built to prevent, so nothing here quietly writes it into the grid -- it stays
 * visible, and gridMismatch() is what asks about it.
 */
export function applyRound(s: CircuitState, r: RoundResult): CircuitState {
  const grid = s.grid.map((e) => {
    if (e.id !== 0) return e
    const f = r.finishes.find((x) => x.id === 0)
    if (!f || !f.pilotId || !f.chassisId) return e
    return { ...e, pilotId: f.pilotId, chassisId: f.chassisId }
  })
  return { grid, rounds: [...s.rounds, r] }
}

// ---------------------------------------------------------------------------
// Standings
// ---------------------------------------------------------------------------

/**
 * The championship table, best first.
 *
 * ORDERING, AND THE TIE-BREAK THAT IS EASY TO GET QUIETLY WRONG:
 *
 *   1. points, descending.
 *   2. COUNTBACK: most wins, then most seconds, then most thirds, and so on to
 *      eighth. This is the motorsport convention and it is not optional --
 *      equal points is common with a table this short, and {15,1} and {10,6}
 *      and {8,8} all sum to 16. Countback separates all three; a tie-break on
 *      "best single finish" separates only the first two, and one on total race
 *      time rewards the driver who happened to draw the faster circuits.
 *   3. grid slot, ascending. A LAST RESORT THAT MUST EXIST: two entrants can
 *      hold identical multisets of finishing positions (both scored 8+8), and
 *      without a total order the table reshuffles between two renders of the
 *      same data, which reads as a bug and is one.
 *
 * DNFs DO NOT COUNT BACK. A non-finisher has a sim position, and letting it
 * into `counts` would mean a car that stopped on lap 1 "finished 6th" for
 * tie-break purposes. They are totalled separately in `dnf`.
 *
 * `place` is shared by a genuine tie -- two entrants on the same points with
 * the same countback are both, truthfully, equal -- while the ARRAY order stays
 * total, so the rows never move.
 */
export function standings(s: CircuitState): StandingRow[] {
  const rows: StandingRow[] = s.grid.map((entrant) => ({
    entrant, points: 0, place: 0, counts: new Array(CIRCUIT_POINTS.length).fill(0),
    dnf: 0, rounds: 0,
  }))
  const byId = new Map<number, StandingRow>(rows.map((r) => [r.entrant.id, r]))
  for (const round of s.rounds) {
    for (const f of round.finishes) {
      const row = byId.get(f.id)
      if (!row) continue
      row.rounds++
      row.points += pointsFor(f.position, f.finished)
      if (!f.finished) { row.dnf++; continue }
      const i = Math.round(f.position) - 1
      if (i >= 0 && i < row.counts.length) row.counts[i]++
    }
  }
  rows.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points
    for (let i = 0; i < a.counts.length; i++) {
      if (b.counts[i] !== a.counts[i]) return b.counts[i] - a.counts[i]
    }
    return a.entrant.id - b.entrant.id
  })
  // Equal points AND equal countback is a real tie and is shown as one.
  for (let i = 0; i < rows.length; i++) {
    const prev = i > 0 ? rows[i - 1] : null
    const tied = prev !== null
      && prev.points === rows[i].points
      && prev.counts.every((c, k) => c === rows[i].counts[k])
    rows[i].place = tied && prev ? prev.place : i + 1
  }
  return rows
}

/** Wins the champion outright, or null while the table is still tied at the top. */
export function champion(s: CircuitState): StandingRow | null {
  if (!isComplete(s)) return null
  const rows = standings(s)
  if (rows.length < 2) return rows[0] ?? null
  return rows[1].place === 1 ? null : rows[0]
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
//
// EVERY ACCESS IS WRAPPED. localStorage does not merely return null in a
// partitioned or private context, it THROWS on the property access itself, and
// inside some embedded webviews it throws on read and write both -- see the
// same note in ui/settings.ts and game/input.ts. A circuit that takes the game
// down in a private window is worse than a circuit that does not save.

const LS_KEY = 'sg.circuit'

/**
 * Format version, bumped when the SHAPE of the stored object changes.
 *
 *   1  grid + rounds; points derived.
 */
const VERSION = 1

/**
 * And a CONTENT signature, which is the part a version number gets wrong.
 *
 * The shape can be perfectly valid while the series it describes no longer
 * exists: add a ninth circuit, reorder the eight, or change a points value, and
 * a half-finished save resumes into a DIFFERENT championship -- round 5 of 8
 * pointing at a track that is now round 6, standings totalled on a table that
 * has moved. The save is silently wrong rather than broken, which is the worst
 * of the three outcomes.
 *
 * So the running order and the points table are hashed into the save and
 * checked on the way back in. A mismatch discards it, which costs a player one
 * unfinished circuit on the build that changed the roster and cannot mislead
 * anybody. Cheaper and more honest than remembering to bump VERSION by hand
 * every time content moves -- and content moves far more often than shape.
 */
function signature(): string {
  return CIRCUIT_TRACK_IDS.join(',') + '|' + CIRCUIT_POINTS.join(',')
}

const num = (v: unknown, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : d

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * Rebuild a grid from storage, or null if it is not a grid.
 *
 * Everything here is untrusted: an older build, a hand-edited value, a
 * half-finished write, a quota error mid-JSON. Ids, pilots and chassis are all
 * checked against the live content rather than taken on faith, because a grid
 * naming a chassis that no longer exists would reach `new Race()` and throw
 * there instead of here.
 */
function readGrid(raw: unknown): CircuitEntrant[] | null {
  if (!Array.isArray(raw) || raw.length !== CIRCUIT_GRID) return null
  const out: CircuitEntrant[] = []
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i] as Record<string, unknown>
    if (!e || typeof e !== 'object') return null
    const id = num(e.id, -1)
    const pilotId = str(e.pilotId)
    const chassisId = str(e.chassisId)
    if (id !== i) return null
    if (!PILOTS.some((p) => p.id === pilotId)) return null
    if (!CHASSIS.some((c) => c.id === chassisId)) return null
    out.push({ id, pilotId, chassisId, aiSkill: num(e.aiSkill, skillFor(i)) })
  }
  return out
}

function readRounds(raw: unknown): RoundResult[] | null {
  if (!Array.isArray(raw)) return null
  if (raw.length > CIRCUIT_ROUNDS) return null
  const out: RoundResult[] = []
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] as Record<string, unknown>
    if (!r || typeof r !== 'object') return null
    // The round order is the circuit's order. A save whose round 3 is not on
    // the circuit's third track is not this championship.
    if (str(r.trackId) !== CIRCUIT_TRACK_IDS[i]) return null
    const fin = r.finishes
    if (!Array.isArray(fin) || fin.length !== CIRCUIT_GRID) return null
    const finishes: RoundFinish[] = []
    for (const f of fin as Record<string, unknown>[]) {
      if (!f || typeof f !== 'object') return null
      const id = num(f.id, -1)
      if (id < 0 || id >= CIRCUIT_GRID) return null
      finishes.push({
        id,
        position: num(f.position, 0),
        finished: f.finished === true,
        time: num(f.time, 0),
        pilotId: str(f.pilotId) || undefined,
        chassisId: str(f.chassisId) || undefined,
      })
    }
    out.push({ trackId: CIRCUIT_TRACK_IDS[i], finishes })
  }
  return out
}

/** The saved circuit, or null if there is none, it is unreadable, or it is stale. */
export function loadCircuit(): CircuitState | null {
  let raw: string | null = null
  try { raw = window.localStorage.getItem(LS_KEY) } catch { return null }
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as Record<string, unknown>
    if (!p || typeof p !== 'object') return null
    if (num(p.v, -1) !== VERSION) return null
    if (str(p.sig) !== signature()) return null
    const grid = readGrid(p.grid)
    const rounds = readRounds(p.rounds)
    if (!grid || !rounds) return null
    return { grid, rounds }
  } catch {
    return null
  }
}

export function saveCircuit(s: CircuitState): void {
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify({
      v: VERSION, sig: signature(), grid: s.grid, rounds: s.rounds,
    }))
  } catch {
    /* quota, private mode, partitioned storage — the circuit still plays out,
       it just will not be there next time. Never fatal. */
  }
}

export function clearCircuit(): void {
  try { window.localStorage.removeItem(LS_KEY) } catch { /* blocked */ }
}

/** Exported for tests: the pure round-trip without touching storage. */
export function serialise(s: CircuitState): string {
  return JSON.stringify({ v: VERSION, sig: signature(), grid: s.grid, rounds: s.rounds })
}

/** Exported for tests: the parse half of the round-trip. */
export function deserialise(raw: string): CircuitState | null {
  try {
    const p = JSON.parse(raw) as Record<string, unknown>
    if (!p || typeof p !== 'object') return null
    if (num(p.v, -1) !== VERSION) return null
    if (str(p.sig) !== signature()) return null
    const grid = readGrid(p.grid)
    const rounds = readRounds(p.rounds)
    if (!grid || !rounds) return null
    return { grid, rounds }
  } catch {
    return null
  }
}

export { VERSION as CIRCUIT_SAVE_VERSION, signature as circuitSignature }
