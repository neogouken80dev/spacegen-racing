/**
 * THE BOUNDS THE GLOBAL BOARD WILL BE JUDGED BY.
 *
 * This is the only part of the leaderboard that can be tested from here -- the
 * Netlify function itself needs a deployment and a Blobs store -- so it gets
 * tested properly. Everything the endpoint decides about whether a run is real
 * goes through `rejectRun`.
 *
 * The floor matters most. It is derived from SPEED_CEILING, a hard clamp in
 * vehicle.ts, so it is a PROVABLE minimum rather than a fitted one: a car
 * cannot average a speed the sim will not let it reach. A fitted floor would
 * quietly start rejecting honest laps the day the roster gets faster.
 */
import { describe, it, expect } from 'vitest'
import {
  cleanName, minLapSeconds, rejectRun, MAX_LAP_SECONDS, MAX_SCORE_PER_SECOND,
  SPEED_CEILING, TRACK_LENGTH, type GlobalRun,
} from '../src/score/verify'
import { TRACKS } from '../src/content/tracks/index'
import { Track } from '../src/sim/track'

const run = (over: Partial<GlobalRun> = {}): GlobalRun => ({
  trackId: 'rustfall', name: 'VINCE', chassisId: 'solaire', pilotId: 'socket',
  lap: 49.08, raceTime: 165.3, score: 120000, position: 1, ...over,
})

describe('the lap floor is derived from the sim, not guessed', () => {
  it('matches every shipped track, to the metre', () => {
    // If a track is re-authored and this table is not updated, the floor for
    // that circuit is wrong -- too low and it lets nonsense in, too high and it
    // rejects real laps. Neither is visible without this test.
    for (const def of TRACKS) {
      const real = new Track(def).length
      const claimed = TRACK_LENGTH[def.id]
      expect(claimed, `${def.id} is missing from TRACK_LENGTH`).toBeDefined()
      expect(Math.abs(real - claimed), `${def.id}: ${real} vs ${claimed}`).toBeLessThan(1)
    }
  })

  it('is the length divided by a speed the sim will never allow', () => {
    for (const id of Object.keys(TRACK_LENGTH)) {
      expect(minLapSeconds(id)).toBeCloseTo(TRACK_LENGTH[id] / SPEED_CEILING, 5)
    }
  })

  it('sits comfortably under a real competitive lap', () => {
    // Measured bests are around 49s on Rustfall; the floor is ~20.7s. A floor
    // that crowds the real figure is a floor that will reject an honest run.
    expect(minLapSeconds('rustfall')).toBeLessThan(30)
    expect(minLapSeconds('rustfall')).toBeGreaterThan(15)
  })
})

describe('what gets refused', () => {
  it('accepts a real-looking run', () => {
    expect(rejectRun(run())).toBeNull()
  })

  it('refuses a lap nothing could drive', () => {
    expect(rejectRun(run({ lap: 0.4 }))).toBe('lap-impossible')
    expect(rejectRun(run({ lap: minLapSeconds('rustfall') - 0.01 }))).toBe('lap-impossible')
    expect(rejectRun(run({ lap: 0 }))).toBe('lap-impossible')
    expect(rejectRun(run({ lap: -5 }))).toBe('lap-impossible')
    expect(rejectRun(run({ lap: NaN }))).toBe('lap-impossible')
  })

  it('accepts a lap exactly on the floor', () => {
    // The bound is a physical limit, so the limit itself is legal. An
    // off-by-one here would reject the only perfect run anyone ever drove.
    expect(rejectRun(run({ lap: minLapSeconds('rustfall'), raceTime: 200 }))).toBeNull()
  })

  it('refuses a tab left open overnight', () => {
    expect(rejectRun(run({ lap: MAX_LAP_SECONDS + 1, raceTime: 5000 }))).toBe('lap-absurd')
  })

  it('refuses a race shorter than its own fastest lap', () => {
    expect(rejectRun(run({ lap: 90, raceTime: 60 }))).toBe('race-before-lap')
  })

  it('allows a DNF, which has no race time but may own a fast lap', () => {
    expect(rejectRun(run({ raceTime: 0 }))).toBeNull()
  })

  it('refuses a score the rules table cannot produce', () => {
    const r = run({ raceTime: 100 })
    expect(rejectRun({ ...r, score: 100 * MAX_SCORE_PER_SECOND * 4 })).toBe('score-impossible')
    expect(rejectRun({ ...r, score: -1 })).toBe('score-impossible')
  })

  it('allows a maximal but possible score', () => {
    const r = run({ raceTime: 100 })
    expect(rejectRun({ ...r, score: 100 * MAX_SCORE_PER_SECOND })).toBeNull()
  })

  it('refuses an unknown track', () => {
    expect(rejectRun(run({ trackId: 'not-a-track' }))).toBe('unknown-track')
    expect(rejectRun(run({ trackId: '' }))).toBe('unknown-track')
  })

  it('refuses a nameless or oversized entry', () => {
    expect(rejectRun(run({ name: '' }))).toBe('bad-name')
    expect(rejectRun(run({ name: '   ' }))).toBe('bad-name')
    expect(rejectRun(run({ name: 'X'.repeat(13) }))).toBe('bad-name')
  })

  it('refuses an impossible finishing position', () => {
    expect(rejectRun(run({ position: 0 }))).toBe('bad-position')
    expect(rejectRun(run({ position: 99 }))).toBe('bad-position')
    expect(rejectRun(run({ position: 1.5 }))).toBe('bad-position')
  })
})

describe('names are shown to strangers', () => {
  it('keeps letters, digits, space and dash', () => {
    expect(cleanName('Vince-7 GT')).toBe('VINCE-7 GT')
  })

  it('drops anything that could reshape a row', () => {
    // Right-to-left overrides, zero-width joiners and combining marks can all
    // rearrange or overflow the line they are rendered in, and this string is
    // rendered on every other player's screen.
    expect(cleanName('VIN‮ce')).toBe('VINCE')
    expect(cleanName('A‍b')).toBe('AB')
    expect(cleanName('é́́́')).toBe('E')
    expect(cleanName('<script>')).toBe('SCRIPT')
  })

  it('caps the length and collapses runs of space', () => {
    expect(cleanName('X'.repeat(40)).length).toBe(12)
    expect(cleanName('  a    b  ')).toBe('A B')
  })

  it('survives nonsense input without throwing', () => {
    expect(cleanName('')).toBe('')
    expect(cleanName(undefined as unknown as string)).toBe('')
  })
})
