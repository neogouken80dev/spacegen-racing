/**
 * THE GRAND CIRCUIT — points, ordering, tie-breaks, the grid, and the save.
 *
 * Every one of these is pure arithmetic over small data, which is exactly the
 * kind of thing that is impossible to see in a screenshot and cheap to pin
 * here. The tie-break tests are the point of the file: equal points is common
 * with an eight-round series and a table this short, and an ordering that is
 * quietly wrong looks like a working feature for months.
 */
import { describe, it, expect } from 'vitest'
import {
  applyRound, buildGrid, champion, CIRCUIT_GRID, CIRCUIT_POINTS, CIRCUIT_ROUNDS,
  CIRCUIT_TRACK_IDS, deserialise, gridMismatch, isComplete, newCircuit, pointsFor,
  resultFromRace, roundsDone, serialise, standings, trackIdForRound,
  type CircuitState, type RoundFinish,
} from '../src/game/circuit'
import { TRACKS } from '../src/content/tracks'
import { CHASSIS } from '../src/content/chassis'
import { PILOTS } from '../src/content/pilots'

/** A round where `order` lists racer ids from 1st to 8th; all finish. */
function round(trackId: string, order: number[]): ReturnType<typeof resultFromRace> {
  return resultFromRace(trackId, order.map((id, i) => ({
    id, position: i + 1, finished: true, finishTime: 100 + i,
  })))
}

/** The same, but the ids in `dnf` did not finish. */
function roundWithDnf(
  trackId: string, order: number[], dnf: number[],
): ReturnType<typeof resultFromRace> {
  return resultFromRace(trackId, order.map((id, i) => ({
    id, position: i + 1, finished: !dnf.includes(id), finishTime: 100 + i,
  })))
}

function playFrom(seed: CircuitState, orders: number[][]): CircuitState {
  let s = seed
  for (let i = 0; i < orders.length; i++) s = applyRound(s, round(CIRCUIT_TRACK_IDS[i], orders[i]))
  return s
}

const fresh = (): CircuitState => newCircuit('socket', 'solaire', 'normal')

describe('the circuit itself', () => {
  it('runs every circuit on the roster exactly once', () => {
    expect(CIRCUIT_TRACK_IDS.length).toBe(TRACKS.length)
    expect([...CIRCUIT_TRACK_IDS].sort()).toEqual(TRACKS.map((t) => t.id).sort())
    expect(new Set(CIRCUIT_TRACK_IDS).size).toBe(CIRCUIT_TRACK_IDS.length)
  })

  it('opens on Elkarim, the circuit a player already knows', () => {
    expect(CIRCUIT_TRACK_IDS[0]).toBe('rustfall')
  })

  it('names a track for every round and clamps outside the series', () => {
    for (let i = 0; i < CIRCUIT_ROUNDS; i++) {
      expect(trackIdForRound(i)).toBe(CIRCUIT_TRACK_IDS[i])
    }
    expect(trackIdForRound(-1)).toBe(CIRCUIT_TRACK_IDS[0])
    expect(trackIdForRound(99)).toBe(CIRCUIT_TRACK_IDS[CIRCUIT_ROUNDS - 1])
  })
})

describe('the points table', () => {
  it('is 15-12-10-8-6-4-2-1', () => {
    expect([...CIRCUIT_POINTS]).toEqual([15, 12, 10, 8, 6, 4, 2, 1])
  })

  it('pays every finishing position from 1st to 8th', () => {
    for (let p = 1; p <= 8; p++) expect(pointsFor(p, true)).toBe(CIRCUIT_POINTS[p - 1])
  })

  it('pays nothing outside the scoring positions', () => {
    expect(pointsFor(0, true)).toBe(0)
    expect(pointsFor(9, true)).toBe(0)
    expect(pointsFor(-3, true)).toBe(0)
    expect(pointsFor(NaN, true)).toBe(0)
    expect(pointsFor(Infinity, true)).toBe(0)
  })

  it('pays a non-finisher nothing, whatever position the sim gave it', () => {
    // sim/race.ts ranks the still-running field behind the finishers, so a DNF
    // HAS a position. Paying on position alone would score a car that parked.
    for (let p = 1; p <= 8; p++) expect(pointsFor(p, false)).toBe(0)
  })

  it('makes two solid rounds beat one win, which is the shape of the table', () => {
    expect(CIRCUIT_POINTS[3] * 2).toBeGreaterThan(CIRCUIT_POINTS[0])
  })
})

describe('the grid', () => {
  it('is eight cars with the player in slot 0', () => {
    const g = buildGrid('socket', 'solaire', 'normal')
    expect(g.length).toBe(CIRCUIT_GRID)
    expect(g[0]).toMatchObject({ id: 0, pilotId: 'socket', chassisId: 'solaire' })
    expect(g.map((e) => e.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('gives the player no AI skill and every opponent some', () => {
    const g = buildGrid('socket', 'solaire', 'normal')
    expect(g[0].aiSkill).toBe(0)
    for (const e of g.slice(1)) expect(e.aiSkill).toBeGreaterThan(0)
  })

  /**
   * THE ONE THAT MATTERS. Five chassis and six pilots fill eight slots, so
   * something has to repeat -- and a repeated (pilot, chassis) PAIR is a
   * standings row nothing on screen can tell from another. Checked for all
   * thirty cars a player can turn up in rather than for the default, because
   * the collision rotation only fires for some of them.
   */
  it('never puts two identical cars on the grid, for any player choice', () => {
    for (const p of PILOTS) {
      for (const c of CHASSIS) {
        const g = buildGrid(p.id, c.id, 'normal')
        const pairs = g.map((e) => e.pilotId + '/' + e.chassisId)
        expect(new Set(pairs).size, `${p.id}/${c.id} -> ${pairs.join(', ')}`).toBe(CIRCUIT_GRID)
      }
    }
  })

  it('names only pilots and chassis that exist', () => {
    for (const p of PILOTS) {
      for (const c of CHASSIS) {
        for (const e of buildGrid(p.id, c.id, 'normal')) {
          expect(PILOTS.some((x) => x.id === e.pilotId)).toBe(true)
          expect(CHASSIS.some((x) => x.id === e.chassisId)).toBe(true)
        }
      }
    }
  })

  it('repeats a pilot at most once, so a name is at worst one of two', () => {
    for (const p of PILOTS) {
      for (const c of CHASSIS) {
        const counts = new Map<string, number>()
        for (const e of buildGrid(p.id, c.id, 'normal')) {
          counts.set(e.pilotId, (counts.get(e.pilotId) ?? 0) + 1)
        }
        for (const [, n] of counts) expect(n).toBeLessThanOrEqual(2)
      }
    }
  })

  it('is the same grid every time it is asked', () => {
    expect(buildGrid('socket', 'solaire', 'normal')).toEqual(buildGrid('socket', 'solaire', 'normal'))
  })

  it('reports a field whose opponents have drifted', () => {
    const g = buildGrid('socket', 'solaire', 'normal')
    const same = g.map((e) => ({ ...e }))
    expect(gridMismatch(g, same)).toEqual([])
    // The player's own car IS allowed to change between rounds.
    same[0].chassisId = 'bulwark'
    same[0].pilotId = 'koan'
    expect(gridMismatch(g, same)).toEqual([])
    // An opponent's is not. Pick a chassis slot 3 is definitely NOT in --
    // the first draft of this test set it to the one it already had and
    // measured a mutation that never happened.
    same[3].chassisId = CHASSIS.find((c) => c.id !== g[3].chassisId)!.id
    expect(gridMismatch(g, same).length).toBe(1)
    same[5].pilotId = PILOTS.find((p) => p.id !== g[5].pilotId)!.id
    expect(gridMismatch(g, same).length).toBe(2)
    same[6].aiSkill = 99
    expect(gridMismatch(g, same).length).toBe(3)
    expect(gridMismatch(g, same.slice(0, 7)).length).toBeGreaterThan(0)
  })
})

describe('applying a round', () => {
  it('is pure — the input state is untouched', () => {
    const a = fresh()
    const before = JSON.stringify(a)
    const b = applyRound(a, round(CIRCUIT_TRACK_IDS[0], [0, 1, 2, 3, 4, 5, 6, 7]))
    expect(JSON.stringify(a)).toBe(before)
    expect(b.rounds.length).toBe(1)
    expect(roundsDone(a)).toBe(0)
    expect(roundsDone(b)).toBe(1)
  })

  it('refreshes the player’s car and leaves the opponents alone', () => {
    const a = fresh()
    const opponentsBefore = a.grid.slice(1).map((e) => e.pilotId + '/' + e.chassisId)
    const r = resultFromRace(CIRCUIT_TRACK_IDS[0], a.grid.map((e, i) => ({
      id: e.id, position: i + 1, finished: true, finishTime: 100 + i,
      // The player walked through the garage and came back in something else;
      // an opponent claims to have done the same, which must be ignored.
      pilotId: e.id === 0 ? 'koan' : 'triage',
      chassisId: e.id === 0 ? 'bulwark' : 'vector7',
    })))
    const b = applyRound(a, r)
    expect(b.grid[0].pilotId).toBe('koan')
    expect(b.grid[0].chassisId).toBe('bulwark')
    expect(b.grid.slice(1).map((e) => e.pilotId + '/' + e.chassisId)).toEqual(opponentsBefore)
  })

  it('knows when the series is over', () => {
    let s = fresh()
    for (let i = 0; i < CIRCUIT_ROUNDS; i++) {
      expect(isComplete(s)).toBe(false)
      s = applyRound(s, round(CIRCUIT_TRACK_IDS[i], [0, 1, 2, 3, 4, 5, 6, 7]))
    }
    expect(isComplete(s)).toBe(true)
    expect(roundsDone(s)).toBe(CIRCUIT_ROUNDS)
  })

  it('reads a DNF off the race rather than inventing a time for it', () => {
    const r = roundWithDnf(CIRCUIT_TRACK_IDS[0], [0, 1, 2, 3, 4, 5, 6, 7], [2])
    const f = r.finishes.find((x) => x.id === 2) as RoundFinish
    expect(f.finished).toBe(false)
    expect(f.time).toBe(0)
  })
})

describe('standings', () => {
  it('total the points of every round', () => {
    // Slot 0 finishes 1st, 3rd, 2nd -> 15 + 10 + 12 = 37.
    const s = playFrom(fresh(), [
      [0, 1, 2, 3, 4, 5, 6, 7],
      [1, 2, 0, 3, 4, 5, 6, 7],
      [2, 0, 1, 3, 4, 5, 6, 7],
    ])
    const rows = standings(s)
    expect(rows.find((r) => r.entrant.id === 0)?.points).toBe(37)
    expect(rows.find((r) => r.entrant.id === 1)?.points).toBe(12 + 15 + 10)
    expect(rows.find((r) => r.entrant.id === 2)?.points).toBe(10 + 12 + 15)
  })

  it('has a row for every entrant from the first render, all on zero', () => {
    const rows = standings(fresh())
    expect(rows.length).toBe(CIRCUIT_GRID)
    for (const r of rows) {
      expect(r.points).toBe(0)
      expect(r.rounds).toBe(0)
      expect(r.counts.every((c) => c === 0)).toBe(true)
    }
    // Nothing raced, so the tie is total and every place is 1st.
    expect(rows.every((r) => r.place === 1)).toBe(true)
    // And the order is still total, so two renders agree.
    expect(rows.map((r) => r.entrant.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('order by points, best first', () => {
    const s = playFrom(fresh(), [[3, 1, 0, 2, 4, 5, 6, 7]])
    const rows = standings(s)
    expect(rows.map((r) => r.entrant.id).slice(0, 4)).toEqual([3, 1, 0, 2])
    expect(rows.map((r) => r.points)).toEqual([...CIRCUIT_POINTS])
    expect(rows.map((r) => r.place)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  /**
   * COUNTBACK, which is the tie-break the whole file exists for.
   *
   * Two rounds. Slot 0 takes a win and an eighth: 15 + 1 = 16. Slot 1 takes
   * two thirds... no: 10 + 6 = 16 from a third and a fifth. Equal points,
   * and slot 0 has the win, so slot 0 is ahead. Points alone cannot say that
   * and a "best single finish" rule only accidentally agrees.
   */
  it('break an equal-points tie on most wins', () => {
    const s = playFrom(fresh(), [
      [0, 2, 1, 3, 4, 5, 6, 7],   // 0: 1st (15)   1: 3rd (10)
      [2, 3, 4, 5, 1, 6, 7, 0],   // 0: 8th (1)    1: 5th (6)
    ])
    const rows = standings(s)
    const a = rows.findIndex((r) => r.entrant.id === 0)
    const b = rows.findIndex((r) => r.entrant.id === 1)
    expect(rows[a].points).toBe(16)
    expect(rows[b].points).toBe(16)
    expect(a).toBeLessThan(b)
    expect(rows[a].counts[0]).toBe(1)
    expect(rows[b].counts[0]).toBe(0)
    // Different countback is not a tie, so the places differ.
    expect(rows[a].place).toBeLessThan(rows[b].place)
  })

  /**
   * COUNTBACK PAST THE WINS COLUMN.
   *
   * Four rounds, arranged so the two entrants are level on points AND level on
   * wins, and only the second-place column separates them:
   *
   *   id 0   1st, 4th, 6th, 6th = 15 + 8 + 4 + 4 = 31   wins 1, 2nds 0
   *   id 1   2nd, 7th, 1st, 7th = 12 + 2 + 15 + 2 = 31  wins 1, 2nds 1
   *
   * so id 1 is ahead. Written out because the first version of this test was
   * hand-added wrong (25 against 31) and passed a green assertion on a
   * construction that was not testing anything.
   */
  it('walk down the countback when the wins are level', () => {
    const s = playFrom(fresh(), [
      [0, 1, 2, 3, 4, 5, 6, 7],   // 0: 1st   1: 2nd
      [2, 3, 4, 0, 5, 6, 1, 7],   // 0: 4th   1: 7th
      [1, 2, 3, 4, 5, 0, 6, 7],   // 0: 6th   1: 1st
      [2, 3, 4, 5, 6, 0, 1, 7],   // 0: 6th   1: 7th
    ])
    const rows = standings(s)
    const a = rows.find((r) => r.entrant.id === 0)!
    const b = rows.find((r) => r.entrant.id === 1)!
    expect(a.points).toBe(31)
    expect(b.points).toBe(31)
    expect(a.counts[0]).toBe(1)
    expect(b.counts[0]).toBe(1)
    expect(a.counts[1]).toBe(0)
    expect(b.counts[1]).toBe(1)
    expect(rows.indexOf(b)).toBeLessThan(rows.indexOf(a))
    expect(b.place).toBeLessThan(a.place)
  })

  it('fall back to the grid slot so the table never reshuffles', () => {
    // Identical finishes: both entrants scored the same positions, so the
    // countback is level all the way down. Without a total order the rows
    // would swap between two renders of the same data.
    const s = playFrom(fresh(), [
      [0, 1, 2, 3, 4, 5, 6, 7],
      [1, 0, 2, 3, 4, 5, 6, 7],
    ])
    const rows = standings(s)
    const a = rows.find((r) => r.entrant.id === 0)!
    const b = rows.find((r) => r.entrant.id === 1)!
    expect(a.points).toBe(b.points)
    expect(a.counts).toEqual(b.counts)
    expect(rows.indexOf(a)).toBeLessThan(rows.indexOf(b))
    // A genuine tie shows as a shared place, while the ARRAY order stays total.
    expect(a.place).toBe(b.place)
    expect(standings(s).map((r) => r.entrant.id)).toEqual(rows.map((r) => r.entrant.id))
  })

  it('is stable across repeated calls on the same state', () => {
    const s = playFrom(fresh(), [
      [0, 1, 2, 3, 4, 5, 6, 7],
      [7, 6, 5, 4, 3, 2, 1, 0],
      [3, 3, 3, 3, 3, 3, 3, 3].map((_, i) => i),
    ])
    const once = standings(s).map((r) => `${r.entrant.id}:${r.points}:${r.place}`)
    for (let i = 0; i < 5; i++) {
      expect(standings(s).map((r) => `${r.entrant.id}:${r.points}:${r.place}`)).toEqual(once)
    }
  })

  it('count a DNF as a DNF and not as an eighth place', () => {
    const s = applyRound(fresh(), roundWithDnf(CIRCUIT_TRACK_IDS[0],
      [1, 2, 3, 4, 5, 6, 7, 0], [0]))
    const me = standings(s).find((r) => r.entrant.id === 0)!
    expect(me.points).toBe(0)
    expect(me.dnf).toBe(1)
    expect(me.rounds).toBe(1)
    // The sim gave it position 8; it must not appear in the countback.
    expect(me.counts.every((c) => c === 0)).toBe(true)
  })

  /**
   * A RETIREMENT AND A LAST PLACE ARE NOT THE SAME THING.
   *
   * One round. Slot 7 is classified 7th but did not finish; slot 0 is
   * classified 8th and did. The finisher takes a point and an eighth-place
   * credit in the countback; the retirement takes neither, despite standing
   * higher in the sim's own ordering. Getting this backwards would make
   * stopping on lap 1 worth more than limping home.
   */
  it('does not let a DNF outscore a finish it finished behind', () => {
    const s = applyRound(fresh(), roundWithDnf(CIRCUIT_TRACK_IDS[0],
      [1, 2, 3, 4, 5, 6, 7, 0], [7]))
    const rows = standings(s)
    const finished8th = rows.find((r) => r.entrant.id === 0)!
    const retired7th = rows.find((r) => r.entrant.id === 7)!
    expect(finished8th.points).toBe(1)
    expect(finished8th.counts[7]).toBe(1)
    expect(finished8th.dnf).toBe(0)
    expect(retired7th.points).toBe(0)
    expect(retired7th.counts.every((c) => c === 0)).toBe(true)
    expect(retired7th.dnf).toBe(1)
    expect(rows.indexOf(finished8th)).toBeLessThan(rows.indexOf(retired7th))
  })
})

describe('the champion', () => {
  it('is nobody until the last round is raced', () => {
    let s = fresh()
    for (let i = 0; i < CIRCUIT_ROUNDS - 1; i++) {
      s = applyRound(s, round(CIRCUIT_TRACK_IDS[i], [0, 1, 2, 3, 4, 5, 6, 7]))
      expect(champion(s)).toBeNull()
    }
  })

  it('is the leader once it is', () => {
    let s = fresh()
    for (let i = 0; i < CIRCUIT_ROUNDS; i++) {
      s = applyRound(s, round(CIRCUIT_TRACK_IDS[i], [0, 1, 2, 3, 4, 5, 6, 7]))
    }
    expect(champion(s)?.entrant.id).toBe(0)
    expect(champion(s)?.points).toBe(CIRCUIT_ROUNDS * 15)
  })

  it('is nobody when the top of the table is genuinely tied', () => {
    // Eight rounds, slots 0 and 1 alternating 1st and 2nd: identical points
    // and identical countbacks, so there is no champion to name.
    let s = fresh()
    for (let i = 0; i < CIRCUIT_ROUNDS; i++) {
      const order = i % 2 === 0
        ? [0, 1, 2, 3, 4, 5, 6, 7]
        : [1, 0, 2, 3, 4, 5, 6, 7]
      s = applyRound(s, round(CIRCUIT_TRACK_IDS[i], order))
    }
    const rows = standings(s)
    expect(rows[0].points).toBe(rows[1].points)
    expect(rows[0].counts).toEqual(rows[1].counts)
    expect(champion(s)).toBeNull()
  })
})

describe('the save', () => {
  it('round-trips a circuit in progress', () => {
    const s = playFrom(fresh(), [
      [0, 1, 2, 3, 4, 5, 6, 7],
      [2, 0, 1, 3, 4, 5, 6, 7],
      [5, 4, 3, 2, 1, 0, 7, 6],
    ])
    const back = deserialise(serialise(s))
    expect(back).not.toBeNull()
    expect(back!.grid).toEqual(s.grid)
    expect(back!.rounds.length).toBe(3)
    // And the derived side survives, which is the thing a player would notice.
    expect(standings(back!).map((r) => `${r.entrant.id}:${r.points}:${r.place}`))
      .toEqual(standings(s).map((r) => `${r.entrant.id}:${r.points}:${r.place}`))
  })

  it('round-trips a finished circuit', () => {
    // Each round rotates the field by one, so every entrant scores every
    // position exactly once over the eight rounds and the table ends level.
    let s = fresh()
    for (let i = 0; i < CIRCUIT_ROUNDS; i++) {
      const order = Array.from({ length: CIRCUIT_GRID }, (_, k) => (k + i) % CIRCUIT_GRID)
      s = applyRound(s, round(CIRCUIT_TRACK_IDS[i], order))
    }
    const back = deserialise(serialise(s))
    expect(back).not.toBeNull()
    expect(isComplete(back!)).toBe(true)
    const total = CIRCUIT_POINTS.reduce((a, b) => a + b, 0)
    for (const r of standings(back!)) expect(r.points).toBe(total)
    // Everybody won once and nobody won the title.
    expect(champion(back!)).toBeNull()
  })

  it('refuses a save from a different format version', () => {
    const raw = JSON.parse(serialise(fresh())) as Record<string, unknown>
    raw.v = 99
    expect(deserialise(JSON.stringify(raw))).toBeNull()
  })

  /**
   * THE CONTENT CHECK, which is the part a version number gets wrong.
   *
   * A save can be perfectly well-formed and still describe a championship that
   * no longer exists -- the roster reordered, a ninth circuit added, a points
   * value changed. Resuming it would put the player in round 5 of a different
   * series with totals from a table that has moved, which is silently wrong
   * rather than broken.
   */
  it('refuses a save whose running order or points table has moved', () => {
    const raw = JSON.parse(serialise(fresh())) as Record<string, unknown>
    raw.sig = 'rustfall,halcyon|15,12,10,8,6,4,2,1'
    expect(deserialise(JSON.stringify(raw))).toBeNull()
    const raw2 = JSON.parse(serialise(fresh())) as Record<string, unknown>
    raw2.sig = CIRCUIT_TRACK_IDS.join(',') + '|20,15,10,8,6,4,2,1'
    expect(deserialise(JSON.stringify(raw2))).toBeNull()
  })

  it('refuses a save whose rounds are not on the circuit’s tracks', () => {
    const s = playFrom(fresh(), [[0, 1, 2, 3, 4, 5, 6, 7]])
    const raw = JSON.parse(serialise(s)) as { rounds: { trackId: string }[] }
    raw.rounds[0].trackId = 'neonspire'
    expect(deserialise(JSON.stringify(raw))).toBeNull()
  })

  it('refuses a grid naming content that does not exist', () => {
    const raw = JSON.parse(serialise(fresh())) as { grid: { chassisId: string; pilotId: string }[] }
    raw.grid[2].chassisId = 'hovercraft-9000'
    expect(deserialise(JSON.stringify(raw))).toBeNull()
    const raw2 = JSON.parse(serialise(fresh())) as { grid: { pilotId: string }[] }
    raw2.grid[4].pilotId = 'nobody'
    expect(deserialise(JSON.stringify(raw2))).toBeNull()
  })

  it('refuses a grid that is the wrong size or out of order', () => {
    const raw = JSON.parse(serialise(fresh())) as { grid: unknown[] }
    raw.grid.pop()
    expect(deserialise(JSON.stringify(raw))).toBeNull()
    const raw2 = JSON.parse(serialise(fresh())) as { grid: { id: number }[] }
    raw2.grid[3].id = 6
    expect(deserialise(JSON.stringify(raw2))).toBeNull()
  })

  it('refuses garbage without throwing', () => {
    for (const junk of ['', 'null', '{', '[]', '"hello"', '{"v":1}', 'undefined']) {
      expect(() => deserialise(junk)).not.toThrow()
      expect(deserialise(junk)).toBeNull()
    }
  })

  it('refuses more rounds than the circuit has', () => {
    let s = fresh()
    for (let i = 0; i < CIRCUIT_ROUNDS; i++) {
      s = applyRound(s, round(CIRCUIT_TRACK_IDS[i], [0, 1, 2, 3, 4, 5, 6, 7]))
    }
    const raw = JSON.parse(serialise(s)) as { rounds: unknown[] }
    raw.rounds.push(raw.rounds[0])
    expect(deserialise(JSON.stringify(raw))).toBeNull()
  })

  /**
   * RESUME IS THE WHOLE REASON THE SAVE EXISTS, so it is tested as the thing a
   * player does rather than as a serialiser: play three rounds, come back,
   * carry on, and the standings at the end have to be the standings you would
   * have had without ever leaving.
   */
  it('resumes into the same championship it left', () => {
    const orders = [
      [0, 1, 2, 3, 4, 5, 6, 7],
      [2, 0, 1, 3, 4, 5, 6, 7],
      [5, 4, 3, 2, 1, 0, 7, 6],
      [1, 2, 0, 4, 3, 6, 5, 7],
      [0, 3, 1, 2, 5, 4, 7, 6],
    ]
    const straight = playFrom(fresh(), orders)

    // The interrupted run: three rounds, saved, reloaded, two more.
    let part = playFrom(fresh(), orders.slice(0, 3))
    part = deserialise(serialise(part))!
    expect(roundsDone(part)).toBe(3)
    // And the next round it offers is round 4 of the circuit's own order.
    expect(trackIdForRound(roundsDone(part))).toBe(CIRCUIT_TRACK_IDS[3])
    for (let i = 3; i < orders.length; i++) {
      part = applyRound(part, round(CIRCUIT_TRACK_IDS[i], orders[i]))
    }

    expect(standings(part).map((r) => `${r.entrant.id}:${r.points}:${r.place}`))
      .toEqual(standings(straight).map((r) => `${r.entrant.id}:${r.points}:${r.place}`))
  })

  /**
   * AND THE GRID SURVIVES THE ROUND TRIP UNCHANGED, which is the claim the
   * standings rest on. A save that came back with different opponents would
   * produce a table that looks consistent and ranks a field that changed.
   */
  it('brings the same seven opponents back', () => {
    const s = playFrom(fresh(), [[0, 1, 2, 3, 4, 5, 6, 7], [1, 0, 2, 3, 4, 5, 6, 7]])
    const back = deserialise(serialise(s))!
    expect(gridMismatch(s.grid, back.grid)).toEqual([])
    expect(back.grid.slice(1)).toEqual(s.grid.slice(1))
  })
})
