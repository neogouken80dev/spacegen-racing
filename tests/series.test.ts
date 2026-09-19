/**
 * A SERIES, AS ARITHMETIC.
 *
 * game/series.ts is the half of a multi-round lobby that has no pixels in it:
 * how a finished round becomes a new table, what a place is worth, who is
 * ahead, and what happens to somebody who walks out in round 2. Every one of
 * those is invisible in a screenshot of a standings panel -- the panel renders
 * whatever it is handed and renders it beautifully -- and every one of them is
 * a single arithmetic mistake away from a series that looks right and ranks
 * the wrong person.
 *
 * THE POINT OF MOST OF THIS FILE IS TO CHECK THAT NOTHING WAS REIMPLEMENTED.
 * The points table, the countback and the tie-break belong to game/circuit.ts
 * and are already tested there; what is new is the PROJECTION that hands a
 * series table to them. So the assertions below deliberately compare against
 * `CIRCUIT_POINTS` and against `circuit.standings()` itself rather than
 * against numbers typed into this file, because a copy that agreed today and
 * drifted later is the exact failure mode the reuse exists to prevent.
 */
import { describe, it, expect } from 'vitest'
import {
  applySeriesRound, localSeriesLine, orderSeries, seriesKey, seriesPodiumCast,
  seriesPodiumNames, seriesRanking, seriesTracks, SERIES_POINTS, seriesPointsFor,
  type SeriesFinish,
} from '../src/game/series'
import { CIRCUIT_POINTS, CIRCUIT_TRACK_IDS, pointsFor } from '../src/game/circuit'
import { SERIES_LENGTHS, type MultiplayerSlot, type SeriesStanding } from '../src/net/types'
import { netSentence, type NetStatus } from '../src/ui/hud'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** One driver's line in a round, in the order they finished. */
function round(order: readonly (string | null)[], local = order[0]): SeriesFinish[] {
  return order.map((name, i) => ({
    playerId: name === null ? null : 'p-' + name,
    name: name ?? `DRONE-${i}`,
    avatarId: name === null ? null : 'cadet',
    position: i + 1,
    finished: true,
    isLocal: name !== null && name === local,
  }))
}

const byName = (t: readonly SeriesStanding[], name: string): SeriesStanding =>
  t.find((r) => r.name === name)!

// ---------------------------------------------------------------------------

describe('the points are game/circuit.ts’s points', () => {
  it('re-exports the table rather than restating it', () => {
    // Identity, not equality. A copy that happened to hold the same eight
    // numbers would pass a deep-equal check and would still be a second table
    // to remember to change.
    expect(SERIES_POINTS).toBe(CIRCUIT_POINTS)
    expect(seriesPointsFor).toBe(pointsFor)
  })

  it('pays a round exactly what the ladder says', () => {
    const table = applySeriesRound([], round(['ada', 'ben', 'cyd']), 0)
    expect(byName(table, 'ada').points).toBe(CIRCUIT_POINTS[0])
    expect(byName(table, 'ben').points).toBe(CIRCUIT_POINTS[1])
    expect(byName(table, 'cyd').points).toBe(CIRCUIT_POINTS[2])
  })

  it('pays a DNF nothing, whatever position the sim gave it', () => {
    // sim/race.ts ranks the still-running field behind the finishers, so a car
    // that parked on lap 1 has a position. Paying out on position alone would
    // hand it points ahead of a car that parked on the grid.
    const one = round(['ada', 'ben'])
    one[0].finished = false
    const table = applySeriesRound([], one, 0)
    expect(byName(table, 'ada').points).toBe(0)
    expect(byName(table, 'ada').finishes).toEqual([0])
    expect(byName(table, 'ben').points).toBe(CIRCUIT_POINTS[1])
  })
})

describe('the table accumulates round by round', () => {
  it('totals two rounds and keeps a cell per round per driver', () => {
    let table = applySeriesRound([], round(['ada', 'ben', 'cyd']), 0)
    table = applySeriesRound(table, round(['cyd', 'ada', 'ben']), 1)
    expect(byName(table, 'ada').finishes).toEqual([1, 2])
    expect(byName(table, 'ben').finishes).toEqual([2, 3])
    expect(byName(table, 'cyd').finishes).toEqual([3, 1])
    expect(byName(table, 'ada').points).toBe(CIRCUIT_POINTS[0] + CIRCUIT_POINTS[1])
    expect(byName(table, 'cyd').points).toBe(CIRCUIT_POINTS[2] + CIRCUIT_POINTS[0])
  })

  it('returns a new array and leaves the one it was given alone', () => {
    const first = applySeriesRound([], round(['ada', 'ben']), 0)
    const snapshot = JSON.stringify(first)
    applySeriesRound(first, round(['ben', 'ada']), 1)
    expect(JSON.stringify(first)).toBe(snapshot)
  })

  it('orders by points, then by countback, then stably', () => {
    // {15,1} and {10,6} and {8,8} all sum to 16, which is the case a
    // "best single finish" tie-break gets wrong and a countback does not.
    // 1st..8th are CIRCUIT_POINTS[0..7] = 15 12 10 8 6 4 2 1.
    const at = (name: string, position: number): SeriesFinish => ({
      playerId: 'p-' + name, name, avatarId: 'cadet', position, finished: true, isLocal: false,
    })
    // Round 1: win 1st (15), ten 3rd (10), eight 4th (8).
    let t = applySeriesRound([], [at('win', 1), at('ten', 3), at('eight', 4)], 0)
    // Round 2: win 8th (1), ten 5th (6), eight 4th (8).
    t = applySeriesRound(t, [at('eight', 4), at('ten', 5), at('win', 8)], 1)
    expect(byName(t, 'win').points).toBe(16)
    expect(byName(t, 'ten').points).toBe(16)
    expect(byName(t, 'eight').points).toBe(16)
    const ranked = seriesRanking(t)
    const order = ranked.map((r) => t[r.entrant.id].name).filter((n) => !n.startsWith('filler'))
    // Countback separates all three: one win beats one second beats one third.
    expect(order.slice(0, 3)).toEqual(['win', 'ten', 'eight'])
  })

  it('renders the same rows in the same order twice', () => {
    // A table that reshuffles between two renders of the same data reads as a
    // bug and is one. circuit.ts's third tie-break exists for exactly this and
    // the projection has to preserve it.
    const t = applySeriesRound([], round(['ada', 'ben', 'cyd', 'dee']), 0)
    const a = seriesRanking(t).map((r) => r.entrant.id)
    const b = seriesRanking(t).map((r) => r.entrant.id)
    expect(a).toEqual(b)
    expect(orderSeries(t).map((r) => r.name)).toEqual(orderSeries(t).map((r) => r.name))
  })
})

describe('somebody leaves mid-series', () => {
  /**
   * THE CONTRACT'S RULE, IN ONE TEST.
   *
   * "Their slot keeps racing under AI, and they keep scoring -- zero for the
   * rounds they miss... They are NOT removed from the standings: a table that
   * silently drops a driver rewrites the history of the rounds already raced,
   * and the player who beat them in round 1 should keep having beaten them."
   */
  it('keeps the leaver on the table, with a zero for the round they missed', () => {
    let t = applySeriesRound([], round(['ada', 'ben', 'cyd']), 0)
    // Round 2: Ben is gone and is not on the grid at all.
    t = applySeriesRound(t, round(['ada', 'cyd']), 1)

    const ben = byName(t, 'ben')
    expect(ben, 'the leaver was dropped from the table').toBeTruthy()
    expect(ben.finishes).toEqual([2, 0])
    // Round 1's twelve points are still theirs. Nothing was taken away.
    expect(ben.points).toBe(CIRCUIT_POINTS[1])
    // And every row is the same length, so round 2 is column 2 on every line.
    expect(t.every((r) => r.finishes.length === 2)).toBe(true)
  })

  it('keeps the person’s name and avatar when the AI takes their slot', () => {
    let t = applySeriesRound([], round(['ada', 'ben']), 0)
    // The slot raced -- under AI, which publishes a roster name and no avatar
    // -- and the result belongs to the person whose slot it is.
    t = applySeriesRound(t, [
      { playerId: 'p-ada', name: 'ada', avatarId: 'cadet', position: 2, finished: true, isLocal: true },
      { playerId: 'p-ben', name: 'VANGUARD', avatarId: null, position: 1, finished: true, isLocal: false },
    ], 1)
    const ben = byName(t, 'ben')
    // The row still says a person was there, because in round 1 one was.
    expect(ben.name).toBe('ben')
    expect(ben.avatarId).toBe('cadet')
    expect(ben.finishes).toEqual([2, 1])
    expect(ben.points).toBe(CIRCUIT_POINTS[1] + CIRCUIT_POINTS[0])
  })

  it('lets them come back and score normally from that round on', () => {
    let t = applySeriesRound([], round(['ada', 'ben']), 0)
    t = applySeriesRound(t, round(['ada']), 1)
    t = applySeriesRound(t, round(['ben', 'ada']), 2)
    expect(byName(t, 'ben').finishes).toEqual([2, 0, 1])
    expect(byName(t, 'ben').points).toBe(CIRCUIT_POINTS[1] + CIRCUIT_POINTS[0])
  })

  it('joins a driver who arrives late with zeroes behind them', () => {
    let t = applySeriesRound([], round(['ada']), 0)
    t = applySeriesRound(t, round(['ada', 'new']), 1)
    // Not [1] pretending round 2 was their opener.
    expect(byName(t, 'new').finishes).toEqual([0, 2])
  })

  it('keys AI slots on their name, so eight of them are eight rows', () => {
    const drones = round([null, null, null])
    const t = applySeriesRound([], drones, 0)
    expect(t).toHaveLength(3)
    expect(new Set(t.map(seriesKey)).size).toBe(3)
  })
})

describe('the local player’s own line', () => {
  it('finds them wherever they are, with the place the table shares', () => {
    const t = applySeriesRound([], round(['ada', 'ben', 'cyd'], 'cyd'), 0)
    const me = localSeriesLine(t)
    expect(me).toBeTruthy()
    expect(me!.row.name).toBe('cyd')
    expect(me!.place).toBe(3)
    expect(me!.points).toBe(CIRCUIT_POINTS[2])
  })

  it('is null when nobody in the table is the reader', () => {
    const t = applySeriesRound([], round(['ada', 'ben'], 'nobody'), 0)
    expect(localSeriesLine(t)).toBeNull()
  })
})

describe('the podium at the end of a series', () => {
  const grid = (names: readonly string[]): MultiplayerSlot[] =>
    names.map((n, i) => ({
      slot: i,
      playerId: 'p-' + n,
      name: n,
      avatarId: 'cadet',
      chassisId: ['solaire', 'vector7', 'bulwark', 'dray9'][i % 4],
      pilotId: ['socket', 'vanguard', 'aegis', 'koan'][i % 4],
      isHost: i === 0,
      aiSkill: null,
    }))

  it('puts the top three on the steps with the cars they drove', () => {
    let t = applySeriesRound([], round(['ada', 'ben', 'cyd', 'dee'], 'cyd'), 0)
    t = applySeriesRound(t, round(['ada', 'ben', 'cyd', 'dee'], 'cyd'), 1)
    const g = grid(['ada', 'ben', 'cyd', 'dee'])
    const cast = seriesPodiumCast(t, g, seriesKey({ playerId: 'p-cyd', name: 'cyd' }))

    expect(cast.steps).toHaveLength(3)
    expect(cast.steps.map((s) => s.step)).toEqual([1, 2, 3])
    // render/podium.ts builds a real car and a real figure from these, so a
    // blank chassis is a podium with nothing parked on it.
    expect(cast.steps.every((s) => s.chassisId.length > 0)).toBe(true)
    expect(cast.steps[0].chassisId).toBe('solaire')
    expect(seriesPodiumNames(t, cast)).toEqual(['ada', 'ben', 'cyd'])
  })

  it('names where the local player finished even when they are not on it', () => {
    // game/podium.ts is explicit that the celebration plays whether or not the
    // player is on it: "one that says 4th, 46 points while three robots dance
    // is how it says you were in it."
    const t = applySeriesRound([], round(['ada', 'ben', 'cyd', 'dee'], 'dee'), 0)
    const cast = seriesPodiumCast(t, grid(['ada', 'ben', 'cyd', 'dee']),
      seriesKey({ playerId: 'p-dee', name: 'dee' }))
    expect(cast.localOnPodium).toBe(false)
    expect(cast.localPlace).toBe(4)
    expect(cast.localPoints).toBe(CIRCUIT_POINTS[3])
  })

  it('gives a driver who missed the final round something to stand on', () => {
    // They are still in the table -- that is the rule -- so they can still be
    // on the podium, and the scene needs a chassis for them. A crash at the
    // end of a five-round series is the worst possible moment for one.
    let t = applySeriesRound([], round(['ada', 'ben', 'cyd']), 0)
    t = applySeriesRound(t, round(['cyd']), 1)
    const cast = seriesPodiumCast(t, grid(['cyd']), seriesKey({ playerId: 'p-cyd', name: 'cyd' }))
    expect(cast.steps).toHaveLength(3)
    expect(cast.steps.every((s) => s.chassisId.length > 0)).toBe(true)
  })

  it('does not throw on a two-driver table', () => {
    const t = applySeriesRound([], round(['ada', 'ben']), 0)
    const cast = seriesPodiumCast(t, grid(['ada', 'ben']), 'p-ada')
    expect(cast.steps).toHaveLength(2)
  })
})

describe('the running order', () => {
  it('opens on the circuit the host picked and never repeats', () => {
    for (const length of SERIES_LENGTHS) {
      for (const first of CIRCUIT_TRACK_IDS) {
        const ids = seriesTracks(first, length, CIRCUIT_TRACK_IDS)
        expect(ids, `${first} x${length}`).toHaveLength(length)
        expect(ids[0]).toBe(first)
        expect(new Set(ids).size, `${first} x${length} repeats a circuit`).toBe(length)
        for (const id of ids) expect(CIRCUIT_TRACK_IDS).toContain(id)
      }
    }
  })

  it('follows the Grand Circuit’s order after the opener', () => {
    // The order is already argued at length in game/circuit.ts's header; a
    // second, different answer to "what order should circuits come in" would
    // be a second thing to defend.
    const ids = seriesTracks(CIRCUIT_TRACK_IDS[0], 5, CIRCUIT_TRACK_IDS)
    expect(ids).toEqual(CIRCUIT_TRACK_IDS.slice(0, 5))
  })

  it('is length 1 and exactly the chosen circuit for a single race', () => {
    expect(seriesTracks('neonspire', 1, CIRCUIT_TRACK_IDS)).toEqual(['neonspire'])
  })

  it('still answers when the opener is not on the roster', () => {
    // Not reachable from the UI, which only offers the shipped circuits, and
    // a round with no circuit is a race that cannot start rather than a short
    // series.
    const ids = seriesTracks('not-a-track', 3, CIRCUIT_TRACK_IDS)
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// WHAT A FROZEN RACE SAYS
// ---------------------------------------------------------------------------
//
// A lockstep stall is a race that stops dead with everything else on screen
// still running, which is indistinguishable from the game having crashed --
// the whole reason net/lockstep.ts has a stall policy. The HUD's one line is
// the explanation, and its grammar is the part a screenshot cannot check: a
// photograph shows one of these six branches and says nothing about the rest.

describe('the sentence a stalled race puts on screen', () => {
  const st = (over: Partial<NetStatus> = {}): NetStatus => ({
    verdict: 'waiting', waitingFor: [], loading: false, ...over,
  })

  it('says nothing at all while the race is running', () => {
    expect(netSentence(st({ verdict: 'racing' }))).toBe('')
  })

  it('says nothing for a stall too short to have been announced', () => {
    // The runner only fills `waitingFor` once STALL_ANNOUNCE_MS has passed.
    // Below that a banner is worse than the stall it describes: it reads as
    // the UI being broken rather than the network.
    expect(netSentence(st({ waitingFor: [] }))).toBe('')
  })

  it('names one peer', () => {
    expect(netSentence(st({ waitingFor: ['Ada'] }))).toBe('WAITING FOR ADA')
  })

  it('says something different when they have not arrived yet', () => {
    // "Waiting for Ada" is a hiccup mid-race on a five-second deadline.
    // "Waiting for Ada to load" is a player who has not finished building the
    // circuit, on a twenty-second one. Two situations, two sentences.
    expect(netSentence(st({ waitingFor: ['Ada'], loading: true })))
      .toBe('WAITING FOR ADA TO LOAD')
  })

  it('spells out two and counts three', () => {
    expect(netSentence(st({ waitingFor: ['Ada', 'Ben'] })))
      .toBe('WAITING FOR ADA AND BEN')
    expect(netSentence(st({ waitingFor: ['Ada', 'Ben', 'Cyd'] })))
      .toBe('WAITING FOR 3 PLAYERS')
    expect(netSentence(st({ waitingFor: ['Ada', 'Ben', 'Cyd'], loading: true })))
      .toBe('WAITING FOR 3 PLAYERS TO LOAD')
  })

  it('tells a void round and an ejection apart', () => {
    // A desync voids the round for EVERYBODY; an ejection means the round
    // carried on perfectly well without you. Same screen, opposite meanings,
    // so they must not share a sentence.
    const void_ = netSentence(st({ verdict: 'desync' }))
    const out = netSentence(st({ verdict: 'ejected' }))
    expect(void_.length).toBeGreaterThan(0)
    expect(out.length).toBeGreaterThan(0)
    expect(void_).not.toBe(out)
  })
})
