/**
 * SpaceGen Racing — A SERIES, AS ARITHMETIC.
 * ---------------------------------------------------------------------------
 * `SeriesStanding` is in the contract and nothing in the contract knows how to
 * fill one in. This is the missing half: how a finished round becomes a new
 * table, how that table is ordered, and how it reaches the podium that already
 * exists. Everything here is a pure function over plain objects -- no DOM, no
 * service, no race -- for the same reason game/circuit.ts is: every interesting
 * failure in a points series is an ORDERING failure, and orderings are cheap to
 * test and impossible to see in a screenshot.
 *
 * ===========================================================================
 * IT REUSES game/circuit.ts RATHER THAN AGREEING WITH IT
 *
 * Single-player's Grand Circuit already settled the points table (15-12-10-8-6-
 * 4-2-1), the countback tie-break, the place-sharing rule and the total order
 * that keeps rows from swapping between two renders of the same data. All four
 * are subtle, all four are already pinned by tests/circuit.test.ts, and a
 * second copy that "matches" would be a second copy that drifts -- the exact
 * failure game/circuit.ts's own header describes about grid generation.
 *
 * So `orderSeries` does not re-implement any of it. It projects the series
 * table into the shape `circuit.standings()` already consumes -- one entrant
 * per row, one `RoundResult` per round -- runs it, and reads the answer back.
 * The projection is the only new code, and it is eight lines.
 *
 * WHAT COULD NOT BE REUSED, AND WHY, SAID OUT LOUD:
 *
 *   `buildGrid` / `OPPONENTS`  A lobby's field is people. The seven fixed
 *                              opponents exist to keep a SOLO championship's
 *                              field from moving; here the field is whoever
 *                              joined, and the packet is the grid.
 *   `CIRCUIT_TRACK_IDS`        Eight circuits in one fixed order. A series is
 *                              1, 3, 5 or 8 of them, chosen at lobby creation.
 *   `loadCircuit` / `save`     types.ts is explicit that an online series
 *                              cannot be saved and resumed: the room has no
 *                              server to outlive the host.
 *   `CircuitState` itself      It keys everything on a grid SLOT (0-7) and
 *                              carries pilot and chassis per entrant. A series
 *                              row is keyed on a PLAYER, who keeps their slot
 *                              but whose car is theirs to change. So the
 *                              projection is built per call and thrown away.
 *
 * ===========================================================================
 * IT LIVES IN game/ AND NOT IN net/, WHICH IS WHY net/mock.ts DOES NOT USE IT
 *
 * net/mock.ts's own header states the rule: `net/` must not depend on `game/`
 * -- which is why it keeps its own copy of the grid size rather than importing
 * `CIRCUIT_GRID`. This module depends on game/circuit.ts by design, so it has
 * to sit on this side of that line, and the mock therefore cannot call it.
 *
 * That turns out to cost nothing, because the mock does not need it: it BANKS
 * a table handed to `endRound` and never computes one, exactly as net/live.ts
 * does. The only consumer that has the information to total a round is the
 * client that just raced it, and that client is game/main.ts.
 *
 * ===========================================================================
 * THE KEY IS `playerId`, FALLING BACK TO `name`
 *
 * `SeriesStanding` has no slot field, and it needs a stable identity across
 * rounds -- otherwise round 2 cannot find round 1's row and everybody starts
 * again on zero. A human has `playerId`. An AI slot has `playerId: null` by
 * contract (the same null `MultiplayerSlot` uses), so AI rows are keyed on
 * their roster name, which net/mock.ts and net/live.ts both mint uniquely per
 * grid position.
 *
 * AI CARS ARE IN THE TABLE, and that is deliberate rather than an accident of
 * the null being allowed. Points are awarded by finishing position out of
 * eight; a table that listed only the humans would show a champion on 15 points
 * who came third, and a two-human lobby's standings would be a two-row table
 * describing an eight-car race. The player who was beaten by a robot should
 * keep having been beaten by it -- which is the same argument types.ts makes
 * about not deleting a driver who left.
 */
import {
  CIRCUIT_POINTS, pointsFor, standings as circuitStandings,
  type CircuitEntrant, type CircuitState, type RoundResult, type StandingRow,
} from './circuit'
import { podiumCast, type PodiumCast } from './podium'
import type { MultiplayerSlot, SeriesLength, SeriesStanding } from '../net/types'

/**
 * The points table, re-exported rather than restated.
 *
 * A caller that wants to print "15 points for a win" reads it from here and
 * gets game/circuit.ts's array, so the two can never disagree about what a
 * round was worth. `pointsFor` goes with it because the DNF rule -- a
 * non-finisher scores zero however the sim ranked them -- is part of the table
 * and not a separate decision.
 */
export { CIRCUIT_POINTS as SERIES_POINTS, pointsFor as seriesPointsFor }

/** The stable identity of one line of the table. See the header. */
export function seriesKey(s: { playerId: string | null; name: string }): string {
  return s.playerId ?? 'ai:' + s.name
}

/** One driver's outcome in the round that has just finished. */
export interface SeriesFinish {
  playerId: string | null
  name: string
  avatarId: string | null
  /** As the sim reported it, 1-based. */
  position: number
  /** False for a DNF, which scores nothing however it was ranked. */
  finished: boolean
  isLocal: boolean
}

/**
 * Fold a finished round into the table.
 *
 * `roundIndex` is 0-based and is what makes a mid-series departure work: a
 * driver's `finishes` array is padded out to that index with zeroes before this
 * round's result is pushed, so somebody who missed rounds 1 and 2 arrives in
 * round 3 with `[0, 0, 4]` rather than with `[4]` pretending it was their
 * opener. A driver who is in the table and NOT on this round's grid gets a 0
 * pushed for it -- which is the contract's rule, written out:
 *
 *   "Their slot keeps racing under AI, and they keep scoring -- zero for the
 *    rounds they miss... They are NOT removed from the standings: a table that
 *    silently drops a driver rewrites the history of the rounds already raced."
 *
 * A DRIVER WHO LEFT KEEPS THEIR NAME AND THEIR AVATAR, taken from the row they
 * already have. The AI now driving their slot publishes `avatarId: null` and a
 * roster name, and adopting either would quietly replace a person in the
 * standings with a robot halfway down the table -- the history of round 1 says
 * a person beat you, and it should keep saying so.
 *
 * Pure: returns a new array, the way circuit.ts's `applyRound` does, so "what
 * did this round change" is a comparison of two values.
 */
export function applySeriesRound(
  prev: readonly SeriesStanding[],
  round: readonly SeriesFinish[],
  roundIndex: number,
): SeriesStanding[] {
  const out: SeriesStanding[] = prev.map((s) => ({
    ...s,
    finishes: padTo([...s.finishes], roundIndex),
  }))
  const byKey = new Map<string, SeriesStanding>()
  for (const s of out) byKey.set(seriesKey(s), s)

  for (const f of round) {
    const key = seriesKey(f)
    const have = byKey.get(key)
    const pos = f.finished && Number.isFinite(f.position) ? Math.round(f.position) : 0
    if (have) {
      // The row already exists, so the NAME on it is the one the earlier rounds
      // were raced under. Only `isLocal` is refreshed: it is a fact about the
      // reader, not about the driver, and a table handed between clients has to
      // be able to say "this one is you" for whoever is holding it.
      ;(have.finishes as number[]).push(pos)
      have.isLocal = f.isLocal
      continue
    }
    const row: SeriesStanding = {
      playerId: f.playerId,
      name: f.name,
      avatarId: f.avatarId,
      points: 0,
      finishes: [...new Array<number>(roundIndex).fill(0), pos],
      isLocal: f.isLocal,
    }
    out.push(row)
    byKey.set(key, row)
  }

  // Everybody who was in the table and not on this grid: a zero for the round
  // they missed, so every row is the same length and round 4 is column 4 on
  // every line of the table.
  for (const s of out) if (s.finishes.length <= roundIndex) (s.finishes as number[]).push(0)

  return orderSeries(out)
}

function padTo(finishes: number[], roundIndex: number): number[] {
  while (finishes.length < roundIndex) finishes.push(0)
  return finishes
}

/**
 * Sort the table and total it, by handing the whole question to
 * game/circuit.ts's `standings()`.
 *
 * THE PROJECTION IS THE ONLY NEW CODE. Each row becomes an entrant whose id is
 * its index in the input array, each column of `finishes` becomes a
 * `RoundResult`, and a 0 becomes a non-finisher -- which is exactly the value
 * `pointsFor` pays nothing for. Points, countback, shared places and the total
 * order all come back from the function that single player already ships.
 *
 * `points` is then written onto the returned rows rather than being carried in:
 * one source of truth for what a round was worth, the same argument
 * `CircuitState` makes for not storing points at all.
 */
export function orderSeries(rows: readonly SeriesStanding[]): SeriesStanding[] {
  const ranked = seriesRanking(rows)
  return ranked.map((r) => ({
    ...rows[r.entrant.id],
    points: r.points,
  }))
}

/**
 * The same ranking, as game/circuit.ts's own row type.
 *
 * Exported because the podium takes `StandingRow[]` and there is no reason to
 * convert twice. `entrant.id` is the INDEX INTO `rows`, which is how a caller
 * gets back from a placed row to the driver it describes.
 */
export function seriesRanking(rows: readonly SeriesStanding[]): StandingRow[] {
  let played = 0
  for (const r of rows) played = Math.max(played, r.finishes.length)

  const grid: CircuitEntrant[] = rows.map((_row, i) => ({
    id: i,
    // The podium builds a car and a figure from these, so a caller that wants a
    // scene fills them in afterwards from the round's grid -- see
    // `seriesPodiumCast`. Blank here because a standings TABLE does not need
    // them and inventing a chassis would be a lie in the one place the podium
    // then shows it.
    pilotId: '',
    chassisId: '',
    aiSkill: 0,
  }))
  const rounds: RoundResult[] = []
  for (let n = 0; n < played; n++) {
    rounds.push({
      trackId: '',
      finishes: rows.map((row, i) => {
        const pos = row.finishes[n] ?? 0
        return { id: i, position: pos, finished: pos > 0, time: 0 }
      }),
    })
  }
  // A preview built for the standings screenshot, not a real championship.
  // Normal because nothing here is raced.
  const state: CircuitState = { grid, rounds, difficulty: 'normal' }
  return circuitStandings(state)
}

/**
 * The cast for the end-of-series podium.
 *
 * `grid` is the LAST round's grid, and it is here because the podium is a
 * SCENE: it parks three cars under three step numbers and stands three figures
 * on them, so it needs a chassis and a pilot per driver and `SeriesStanding`
 * carries neither. Joining on the series key rather than on the slot, because a
 * driver who sat out the final round still has a row in the table and has to
 * get SOMETHING to stand in -- the first chassis on the grid, rather than an
 * empty step or a crash at the end of a five-round series.
 *
 * `localKey` is the local player's series key, so `PodiumCast.localPlace` names
 * the reader wherever they finished -- including off the podium, which
 * game/podium.ts's header is explicit about wanting.
 */
export function seriesPodiumCast(
  rows: readonly SeriesStanding[],
  grid: readonly MultiplayerSlot[],
  localKey: string,
): PodiumCast {
  const cars = new Map<string, { pilotId: string; chassisId: string }>()
  for (const s of grid) {
    cars.set(seriesKey({ playerId: s.playerId, name: s.name }), {
      pilotId: s.pilotId, chassisId: s.chassisId,
    })
  }
  const fallback = grid[0]
    ? { pilotId: grid[0].pilotId, chassisId: grid[0].chassisId }
    : { pilotId: '', chassisId: '' }

  const ranked = seriesRanking(rows)
  let localId = -1
  const placed = ranked.map((r) => {
    const row = rows[r.entrant.id]
    const key = seriesKey(row)
    if (key === localKey) localId = r.entrant.id
    const car = cars.get(key) ?? fallback
    return { ...r, entrant: { ...r.entrant, pilotId: car.pilotId, chassisId: car.chassisId } }
  })
  return podiumCast(placed, localId)
}

/**
 * The driver names, in podium order, so the card can print a PERSON rather than
 * a pilot.
 *
 * game/podium.ts's `PodiumEntry` carries a `pilotId` because single player's
 * drivers ARE pilots; in a lobby they are people with claimed names, and
 * `render/podium.ts` never renders a name -- it builds a car and a figure and
 * leaves the words to the HUD card. So the card's `pilot` line comes from here
 * and the 3D scene is untouched.
 */
export function seriesPodiumNames(
  rows: readonly SeriesStanding[],
  cast: PodiumCast,
): string[] {
  return cast.steps.map((s) => rows[s.entrantId]?.name ?? '—')
}

/**
 * What the local player's line of the table says, or null if they have no line.
 *
 * `place` is the SHARED one -- two drivers level on points and on countback are
 * both, truthfully, equal -- which is the same distinction `StandingRow` makes
 * and the reason this returns it rather than an array index.
 */
export function localSeriesLine(
  rows: readonly SeriesStanding[],
): { place: number; points: number; row: SeriesStanding } | null {
  const ranked = seriesRanking(rows)
  for (const r of ranked) {
    const row = rows[r.entrant.id]
    if (row.isLocal) return { place: r.place, points: r.points, row }
  }
  return null
}

// ---------------------------------------------------------------------------
// The running order
// ---------------------------------------------------------------------------

/**
 * Pick the circuits for a series of `length`, starting from `first`.
 *
 * FIXED WHEN THE LOBBY IS CREATED, which the contract asks for and gives three
 * reasons for; this is just the picker. It follows the Grand Circuit's running
 * order for everything after the opener, because that order is already argued
 * at length in game/circuit.ts's header (round 1 on ground the player knows,
 * then a difficulty ramp) and a second, different answer to "what order should
 * circuits come in" would be a second thing to defend.
 *
 * THE HOST'S CHOSEN CIRCUIT OPENS, wherever it sits in that order. The create
 * screen lets a host pick round 1 and it would be strange to then not run it
 * first -- and a host who picks Zhen-9 for a three-round series has said
 * something about the series they want.
 *
 * NO REPEATS, which the contract requires: the order is walked once and the
 * opener is skipped when it comes round again. A series longer than the roster
 * is impossible by construction (8 circuits, max length 8).
 */
export function seriesTracks(
  first: string,
  length: SeriesLength,
  order: readonly string[],
): string[] {
  const out: string[] = []
  if (order.includes(first)) out.push(first)
  for (const id of order) {
    if (out.length >= length) break
    if (id === first) continue
    out.push(id)
  }
  // A roster shorter than the series asked for would leave a round with no
  // circuit, which is a race that cannot start rather than a short series. The
  // order repeats from the top instead; unreachable with the shipped eight.
  for (let i = 0; out.length < length && order.length > 0; i++) out.push(order[i % order.length])
  return out.slice(0, length)
}
