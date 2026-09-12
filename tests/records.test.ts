/**
 * RECORDS ARE COMPARISONS, AND HALF OF THEM RUN THE OTHER WAY.
 *
 * Two of the four are "lower is better" and two are "higher is better". A
 * comparison that gets one of them backwards produces a record that can only
 * get WORSE over time -- and that looks exactly like a working feature until
 * somebody drives a good lap and it refuses to update. It is also invisible on
 * a fresh install, because the first run of every kind sets the record whatever
 * the direction is.
 */
import { describe, it, expect } from 'vitest'
import {
  applyRun, beats, RECORD_LOWER_IS_BETTER, RECORD_ORDER, sanitiseRecord, valueFor,
  type RecordEntry, type RunRecord, type TrackRecords,
} from '../src/score/records'

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  trackId: 'rustfall', chassisId: 'solaire', pilotId: 'socket', name: 'VIN',
  bestLap: 55, raceTime: 170, score: 10000, bestCombo: 4, at: 1000, ...over,
})

const entry = (value: number, over: Partial<RecordEntry> = {}): RecordEntry => ({
  value, chassisId: 'bulwark', pilotId: 'aegis', name: 'OLD', at: 10, ...over,
})

describe('which way each record runs', () => {
  it('treats a lower time as better and a higher score as better', () => {
    expect(beats('fastestLap', 50, entry(55))).toBe(true)
    expect(beats('fastestLap', 60, entry(55))).toBe(false)
    expect(beats('fastestRace', 160, entry(170))).toBe(true)
    expect(beats('fastestRace', 180, entry(170))).toBe(false)
    expect(beats('highestScore', 20000, entry(10000))).toBe(true)
    expect(beats('highestScore', 5000, entry(10000))).toBe(false)
    expect(beats('bestCombo', 8, entry(4))).toBe(true)
    expect(beats('bestCombo', 2, entry(4))).toBe(false)
  })

  it('has a direction declared for every record in the order', () => {
    // A record on screen with no entry here would compare as "higher is better"
    // by accident, which is right half the time.
    for (const { id } of RECORD_ORDER) {
      expect(RECORD_LOWER_IS_BETTER[id], `${id} has no direction`).toBeTypeOf('boolean')
    }
  })

  it('fills an empty slot with anything, since there is nothing to defend', () => {
    for (const { id } of RECORD_ORDER) expect(beats(id, 42, undefined)).toBe(true)
  })

  it('keeps the first holder on an exact tie', () => {
    for (const { id } of RECORD_ORDER) expect(beats(id, 55, entry(55))).toBe(false)
  })

  it('refuses a figure that is not a real result', () => {
    // A DNF has no race time and an unfinished lap has no lap time. Zero would
    // win every "lower is better" record forever.
    for (const { id } of RECORD_ORDER) {
      expect(beats(id, 0, entry(55))).toBe(false)
      expect(beats(id, -1, entry(55))).toBe(false)
      expect(beats(id, NaN, entry(55))).toBe(false)
      expect(beats(id, Infinity, undefined)).toBe(false)
    }
  })
})

describe('applying a run', () => {
  it('records the vehicle and pilot, not just the number', () => {
    const { next } = applyRun({}, run({ chassisId: 'vector7', pilotId: 'zephyr' }))
    expect(next.fastestLap!.chassisId).toBe('vector7')
    expect(next.fastestLap!.pilotId).toBe('zephyr')
  })

  it('breaks only the records it actually beat', () => {
    const prev: TrackRecords = {
      fastestLap: entry(50), fastestRace: entry(160),
      highestScore: entry(99999), bestCombo: entry(2),
    }
    // Slower lap and race, worse score, better combo.
    const { broken } = applyRun(prev, run({ bestLap: 55, raceTime: 170, score: 10, bestCombo: 9 }))
    expect(broken).toEqual(['bestCombo'])
  })

  it('leaves the untouched records exactly as they were', () => {
    const prev: TrackRecords = { fastestLap: entry(50, { chassisId: 'dray9' }) }
    const { next } = applyRun(prev, run({ bestLap: 55 }))
    expect(next.fastestLap).toBe(prev.fastestLap)
    expect(next.fastestLap!.chassisId).toBe('dray9')
  })

  it('does not mutate what it was given', () => {
    const prev: TrackRecords = { fastestLap: entry(99) }
    const before = JSON.stringify(prev)
    applyRun(prev, run({ bestLap: 40 }))
    expect(JSON.stringify(prev)).toBe(before)
  })

  it('can take every record at once on a first race', () => {
    const { broken } = applyRun({}, run())
    expect(broken).toEqual(RECORD_ORDER.map((r) => r.id))
  })

  it('reports broken records in the order the screen shows them', () => {
    const { broken } = applyRun({}, run())
    const order = RECORD_ORDER.map((r) => r.id)
    expect(broken).toEqual(order.filter((id) => broken.includes(id)))
  })

  it('never awards a record for a DNF race time', () => {
    // raceTime 0 is "did not finish" -- the lap may still stand.
    const { next, broken } = applyRun({}, run({ raceTime: 0 }))
    expect(next.fastestRace).toBeUndefined()
    expect(broken).not.toContain('fastestRace')
    expect(broken).toContain('fastestLap')
  })
})

describe('reading storage back', () => {
  it('drops a corrupt record instead of throwing', () => {
    expect(sanitiseRecord(null)).toBeNull()
    expect(sanitiseRecord({ value: 'fast' })).toBeNull()
    expect(sanitiseRecord({ value: 0 })).toBeNull()
    expect(sanitiseRecord('nonsense')).toBeNull()
  })

  it('repairs a record written by an older build', () => {
    const e = sanitiseRecord({ value: 51.2 })
    expect(e).not.toBeNull()
    expect(e!.chassisId).toBe('')
    expect(e!.name).toBe('')
  })
})

describe('naming a record after the fact', () => {
  /**
   * THE BUG THIS EXISTS TO PIN.
   *
   * Records are filed the moment the flag drops, before the player has been
   * asked for a name. The obvious way to fill that name in later is to submit
   * the same run again once they have typed one -- and it does not work,
   * because an exact tie does not beat the standing record, so the second
   * submit changes nothing and the name is silently never stored.
   */
  it('cannot be done by re-submitting the same run', () => {
    const first = applyRun({}, run({ name: '' }))
    const second = applyRun(first.next, run({ name: 'VIN' }))
    expect(second.broken).toEqual([])
    expect(second.next.fastestLap!.name).toBe('')
  })

  it('and so a better run is still required to change the holder', () => {
    const first = applyRun({}, run({ bestLap: 50, chassisId: 'solaire' }))
    const second = applyRun(first.next, run({ bestLap: 49, chassisId: 'bulwark' }))
    expect(second.broken).toContain('fastestLap')
    expect(second.next.fastestLap!.chassisId).toBe('bulwark')
  })
})

describe('valueFor', () => {
  it('reads the right figure off the run for each record', () => {
    const r = run({ bestLap: 1, raceTime: 2, score: 3, bestCombo: 4 })
    expect(valueFor('fastestLap', r)).toBe(1)
    expect(valueFor('fastestRace', r)).toBe(2)
    expect(valueFor('highestScore', r)).toBe(3)
    expect(valueFor('bestCombo', r)).toBe(4)
  })
})
