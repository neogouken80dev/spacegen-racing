/**
 * THE SCORE IS ARITHMETIC, AND ARITHMETIC IS WHERE ITS BUGS ARE.
 *
 * None of these can be checked by playing. A combo that pays 1.6x too much, a
 * drift that scores twice, a knock that pays the car that got hit -- all of
 * them look exactly like a working scoring system to a human watching a number
 * go up, which is the whole problem with scoring systems. Pure, they fail with
 * the actual number.
 *
 * The headline is the frame-rate test. Every rate in rules.ts is per second,
 * and the single easiest way to get this wrong is to accrue against the
 * RENDERER's delta -- which would quietly pay a 144Hz player differently from a
 * 30Hz one for identical driving, and pay a stuttering player differently
 * again. It would also never be noticed, because nobody has two machines and
 * one scripted lap.
 *
 * ---------------------------------------------------------------------------
 * THE RIG EXISTS BECAUSE THE FIXTURE KEPT BEING THE BUG.
 *
 * Three separate failures in this file were the harness, not the scorer:
 *
 *   - it never primed the clock, so the unpaid first frame was 1/15s at 15fps
 *     and 1/60s at 60fps and the two rates were asked to score different spans;
 *   - it scheduled events with `t >= at && t - step < at`, which floating point
 *     makes true on the FOLLOWING frame too, so events fired twice -- a
 *     different one at each rate, showing up as an 8000-point gap that looked
 *     exactly like a scorer bug;
 *   - it never advanced `r.driftTime`, the sim's own drift clock, which the
 *     scorer reads to get exact slide seconds.
 *
 * So the rig owns the racer, the clock and the scorer together and advances
 * them the way race.ts does: one place to be wrong, instead of forty.
 */
import { describe, it, expect } from 'vitest'
import type { RaceState, RacerEvent, RacerState } from '../src/sim/types'
import { Scorer } from '../src/score/scorer'
import type { ScoreState } from '../src/score/api'
import {
  CHAIN_WINDOW, COMBO_BREAK_FORCE, COMBO_MAX, DRIFT_RATE, DRIFT_RELEASE,
  DRIFT_START, KNOCK_MIN_FORCE, LAP_PLACE, TRACK_PLACE, rungOf,
} from '../src/score/rules'
import { compareEntries, sanitiseEntry } from '../src/score/board'
import type { ScoreEntry } from '../src/score/api'

function racer(over: Partial<RacerState> = {}): RacerState {
  return {
    id: 0, chassisId: 'solaire', pilotId: '', isLocal: true,
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 10 },
    driftSide: 0, driftTier: -1, driftTime: 0,
    position: 1, lap: 1, finished: false,
    ...over,
  } as unknown as RacerState
}

function state(time: number, phase = 'racing'): RaceState {
  return { racers: [], phase, time, frame: 0, totalLaps: 3 } as unknown as RaceState
}

/** Racer + sim clock + scorer, advanced together the way the real loop does. */
class Rig {
  readonly s = new Scorer()
  readonly r: RacerState
  phase = 'racing'
  private t = 0

  constructor(over: Partial<RacerState> = {}) {
    this.r = racer(over)
    // Prime: the scorer has no prior observation on its first call, so that
    // frame is worth zero seconds. Correct, but it has to happen at the same
    // point for every frame rate or the comparison measures the harness.
    this.s.frame(state(0, this.phase), this.r, [])
  }

  /**
   * One render frame of `dt` sim-seconds. Events delivered here also drive the
   * racer's drift state, exactly as the sim does -- a driftStart IS the frame
   * the slide begins, and `driftTime` restarts with it.
   */
  step(dt: number, evs: readonly RacerEvent[] = []): ScoreState {
    for (const ev of evs) {
      if (ev.t === 'driftStart') { this.r.driftSide = 1; this.r.driftTier = 3; this.r.driftTime = 0 }
      if (ev.t === 'driftEnd') { this.r.driftSide = 0; this.r.driftTier = -1 }
    }
    this.t += dt
    if (this.r.driftSide !== 0) this.r.driftTime += dt
    return this.s.frame(state(this.t, this.phase), this.r, evs)
  }

  /** Hold the current state for `seconds`, rendering at `fps`. */
  hold(seconds: number, fps = 60): ScoreState {
    let out = this.step(0)
    const n = Math.round(seconds * fps)
    for (let i = 0; i < n; i++) out = this.step(1 / fps)
    return out
  }

  /** Begin a slide at a tier without an event, for the rate tests. */
  slide(tier: number): void {
    this.r.driftSide = 1
    this.r.driftTier = tier
    this.r.driftTime = 0
  }

  get score(): number { return this.s.score }
}

describe('the score does not depend on frame rate', () => {
  it('pays a four-second Singularity slide the same at 15, 30 and 60fps', () => {
    const totals = [15, 30, 60].map((fps) => {
      const rig = new Rig()
      rig.slide(3)
      rig.hold(4, fps)
      return rig.score
    })
    // Within a point: the arithmetic is exact, but the running total is floored
    // for display and a sum of floats can land either side of a boundary. A
    // frame-rate DEPENDENCE looks like hundreds of points -- it was 208 before
    // the combo integration was fixed -- never one.
    expect(Math.abs(totals[0] - totals[1])).toBeLessThanOrEqual(1)
    expect(Math.abs(totals[1] - totals[2])).toBeLessThanOrEqual(1)
    expect(totals[0]).toBeGreaterThan(DRIFT_RATE[4] * 4)
  })

  it('pays a whole scripted run the same at 15 and 60fps', () => {
    const build = (fps: number) => {
      const rig = new Rig()
      const step = 1 / fps
      const evs: [number, RacerEvent[]][] = [
        [0.5, [{ t: 'driftStart' }]],
        [3.0, [{ t: 'driftEnd', tier: 3 }]],
        [3.4, [{ t: 'driftStart' }]],
        [5.0, [{ t: 'driftEnd', tier: 2 }]],
        [6.0, [{ t: 'lap', lap: 2, time: 55 }]],
      ]
      const fired = new Set<number>()
      let t = 0
      for (let f = 1; f <= Math.round(7 * fps); f++) {
        t = f * step
        const due: RacerEvent[] = []
        for (const [at, list] of evs) {
          // Fire once, on the first frame at or past the time. The obvious
          // window test fires twice under floating point; see the header.
          if (t >= at && !fired.has(at)) { fired.add(at); due.push(...list) }
        }
        rig.step(step, due)
      }
      return rig.score
    }
    // Not exact: a 15fps client genuinely sees the driftStart event up to a
    // frame later than a 60fps one, so its slide really is a fraction shorter.
    // That is the renderer's sampling of a sim event, not the scorer's
    // arithmetic, and it is bounded by one frame of drift -- about 0.8% here.
    // Before `driftTime` was used it was 337 points; the remainder is the
    // event's arrival, which nothing on this side can recover.
    const lo = build(15)
    const hi = build(60)
    expect(Math.abs(lo - hi) / hi).toBeLessThan(0.01)
  })

  it('refuses to pay for a single enormous time jump', () => {
    // A backgrounded tab, or a race resuming after a pause. Paying 40 seconds
    // of drift in one frame is how a leaderboard gets a score nobody drove.
    const rig = new Rig()
    rig.slide(3)
    rig.step(1)
    rig.step(40)
    expect(rig.score).toBeLessThan(DRIFT_RATE[4] * 2)
  })

  it('does not run the clock backwards when a race restarts', () => {
    const rig = new Rig()
    rig.slide(2)
    rig.hold(3)
    const before = rig.score
    rig.step(-9)
    expect(rig.score).toBeGreaterThanOrEqual(before)
  })
})

describe('the drift is paid three times over', () => {
  it('pays entering, holding and cashing in as separate awards', () => {
    const rig = new Rig()
    const a = rig.step(0.1, [{ t: 'driftStart' }])
    expect(a.awards.map((x) => x.kind)).toContain('driftStart')

    const held = rig.hold(1)
    expect(held.driftRate).toBeGreaterThan(0)

    const cash = rig.step(1 / 60, [{ t: 'driftEnd', tier: 2 }])
    const rel = cash.awards.find((x) => x.kind === 'driftRelease')
    expect(rel).toBeDefined()
    expect(rel!.base).toBe(DRIFT_RELEASE[2])
  })

  it('pays a higher tier more per second than a lower one', () => {
    const at = (tier: number) => {
      const rig = new Rig()
      rig.slide(tier)
      rig.hold(2)
      return rig.score
    }
    expect(at(3)).toBeGreaterThan(at(1))
    expect(at(1)).toBeGreaterThan(at(-1))
  })

  it('banks nothing for cashing in a tier that was never reached', () => {
    const rig = new Rig()
    expect(rig.step(0.1, [{ t: 'driftEnd', tier: -1 }]).awards.length).toBe(0)
  })
})

describe('the combo', () => {
  it('multiplies placement, not just drifting', () => {
    // The whole reason placement is multiplied: otherwise the optimal play is
    // to stop drifting before the line and bank a safe result.
    const rig = new Rig()
    rig.slide(3)
    const after = rig.hold(8)
    expect(after.combo).toBeGreaterThan(2)
    const out = rig.step(1 / 60, [{ t: 'finish', position: 1 }])
    const fin = out.awards.find((x) => x.kind === 'trackPlace')!
    expect(fin.base).toBe(TRACK_PLACE[0])
    expect(fin.points).toBeGreaterThan(TRACK_PLACE[0] * 2)
  })

  it('is reset by a real crash', () => {
    const rig = new Rig()
    rig.slide(3)
    expect(rig.hold(6).combo).toBeGreaterThan(2)
    const after = rig.step(1 / 60, [
      { t: 'wall', force: COMBO_BREAK_FORCE + 2, px: 0, py: 0, pz: 0, nx: 1, ny: 0, nz: 0 },
    ])
    expect(after.combo).toBe(1)
  })

  it('survives leaning on a barrier through a corner', () => {
    // `wall.force` is the closing rate on the barrier line, and a car holding a
    // drift against the outside of a corner reads near zero on it BY DESIGN.
    // If a lean broke the combo, the fastest line would also be the one that
    // destroys your score.
    const rig = new Rig()
    rig.slide(3)
    let out = rig.step(0)
    for (let f = 0; f < 360; f++) {
      out = rig.step(1 / 60, [
        { t: 'wall', force: 0.4, px: 0, py: 0, pz: 0, nx: 1, ny: 0, nz: 0 },
      ])
    }
    expect(out.combo).toBeGreaterThan(2)
  })

  it('never exceeds its cap, however long the slide', () => {
    const rig = new Rig()
    rig.slide(3)
    expect(rig.hold(120).combo).toBeLessThanOrEqual(COMBO_MAX)
  })

  it('holds through a short straight, then bleeds away', () => {
    const rig = new Rig()
    rig.slide(3)
    const peak = rig.hold(6).combo

    rig.r.driftSide = 0
    rig.r.driftTier = -1
    // A second and a half of straight: inside the grace, nothing is lost.
    expect(rig.hold(1.5).combo).toBeCloseTo(peak, 1)
    // Ten more seconds of nothing: gone.
    expect(rig.hold(12).combo).toBe(1)
  })

  it('reports each rung exactly once as it is crossed', () => {
    const rig = new Rig()
    rig.slide(3)
    const seen: number[] = []
    for (let f = 0; f < 60 * 40; f++) seen.push(...rig.step(1 / 60).rungs)
    expect(seen).toEqual([...new Set(seen)])
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
    expect(rungOf(COMBO_MAX)).toBe(seen[seen.length - 1])
  })
})

describe('chaining', () => {
  it('links a slide begun inside the buffer', () => {
    const rig = new Rig()
    rig.step(1 / 60, [{ t: 'driftEnd', tier: 2 }])
    const out = rig.step(CHAIN_WINDOW * 0.5, [{ t: 'driftStart' }])
    expect(out.awards.map((x) => x.kind)).toContain('chain')
    expect(out.chain).toBe(1)
  })

  it('does not link one begun after the buffer has closed', () => {
    const rig = new Rig()
    rig.step(1 / 60, [{ t: 'driftEnd', tier: 2 }])
    rig.hold(CHAIN_WINDOW + 0.3)
    const out = rig.step(1 / 60, [{ t: 'driftStart' }])
    expect(out.awards.map((x) => x.kind)).not.toContain('chain')
    expect(out.chain).toBe(0)
  })

  it('pays more for each successive link', () => {
    const rig = new Rig()
    const got: number[] = []
    for (let i = 0; i < 3; i++) {
      rig.step(0.2, [{ t: 'driftEnd', tier: 2 }])
      const out = rig.step(0.2, [{ t: 'driftStart' }])
      got.push(out.awards.find((x) => x.kind === 'chain')!.base)
    }
    expect(got[1]).toBeGreaterThan(got[0])
    expect(got[2]).toBeGreaterThan(got[1])
  })
})

describe('knocking other cars', () => {
  const bump = (force: number, nz: number): RacerEvent => ({
    t: 'bump', force, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz,
  })

  it('pays the car that did the knocking', () => {
    // Travelling +z, normal points +z: we drove into them.
    const rig = new Rig({ vel: { x: 0, y: 0, z: 30 } })
    const out = rig.step(1 / 60, [bump(KNOCK_MIN_FORCE + 4, 1)])
    expect(out.awards.map((x) => x.kind)).toContain('knock')
  })

  it('does NOT pay the car that got knocked', () => {
    // Identical force -- `bump` is fired on both cars with the same number, so
    // without the normal test, being rammed would score as well as ramming.
    const rig = new Rig({ vel: { x: 0, y: 0, z: 30 } })
    const out = rig.step(1 / 60, [bump(KNOCK_MIN_FORCE + 4, -1)])
    expect(out.awards.map((x) => x.kind)).not.toContain('knock')
  })

  it('ignores the constant nudging of a tight pack', () => {
    const rig = new Rig({ vel: { x: 0, y: 0, z: 30 } })
    expect(rig.step(1 / 60, [bump(KNOCK_MIN_FORCE - 1, 1)]).awards.length).toBe(0)
  })

  it('pays once for grinding a car along a wall, not sixty times a second', () => {
    const rig = new Rig({ vel: { x: 0, y: 0, z: 30 } })
    let knocks = 0
    for (let f = 0; f < 30; f++) {
      knocks += rig.step(1 / 60, [bump(KNOCK_MIN_FORCE + 4, 1)])
        .awards.filter((x) => x.kind === 'knock').length
    }
    expect(knocks).toBe(1)
  })
})

describe('placement', () => {
  it('pays a lap by the position held at the line', () => {
    const rig = new Rig({ position: 3 })
    const out = rig.step(1 / 60, [{ t: 'lap', lap: 2, time: 55 }])
    expect(out.awards.find((x) => x.kind === 'lapPlace')!.base).toBe(LAP_PLACE[2])
  })

  it('pays the finish once, however many times the event arrives', () => {
    const rig = new Rig()
    const first = rig.step(1 / 60, [{ t: 'finish', position: 1 }])
    const second = rig.step(1 / 60, [{ t: 'finish', position: 1 }])
    expect(first.awards.filter((x) => x.kind === 'trackPlace').length).toBe(1)
    expect(second.awards.length).toBe(0)
  })

  it('scores nothing before the lights go out', () => {
    const rig = new Rig()
    rig.phase = 'countdown'
    rig.slide(3)
    for (let f = 0; f < 120; f++) rig.step(1 / 60, [{ t: 'driftStart' }])
    expect(rig.score).toBe(0)
  })

  it('stops scoring after the flag', () => {
    const rig = new Rig()
    rig.step(1 / 60, [{ t: 'finish', position: 2 }])
    const after = rig.score
    rig.slide(3)
    for (let f = 0; f < 300; f++) rig.step(1 / 60, [{ t: 'driftStart' }])
    expect(rig.score).toBe(after)
  })
})

describe('the board', () => {
  const entry = (over: Partial<ScoreEntry>): ScoreEntry => ({
    name: 'VIN', score: 1000, trackId: 'rustfall', chassisId: 'solaire',
    pilotId: 'socket', position: 1, bestLap: 55, bestCombo: 4, at: 100, ...over,
  })

  it('orders by score, then by the driving', () => {
    const rows = [
      entry({ score: 900 }),
      entry({ score: 1000, position: 3, bestLap: 50 }),
      entry({ score: 1000, position: 1, bestLap: 56 }),
    ].sort(compareEntries)
    expect(rows[0].position).toBe(1)
    expect(rows[1].position).toBe(3)
    expect(rows[2].score).toBe(900)
  })

  it('keeps the older run when two are identical', () => {
    const rows = [entry({ at: 500 }), entry({ at: 100 })].sort(compareEntries)
    expect(rows[0].at).toBe(100)
  })

  it('drops a corrupt row instead of throwing', () => {
    expect(sanitiseEntry(null)).toBeNull()
    expect(sanitiseEntry({ score: 'lots' })).toBeNull()
    expect(sanitiseEntry('nonsense')).toBeNull()
  })

  it('repairs a half-written row rather than losing the board', () => {
    const e = sanitiseEntry({ score: 500 })
    expect(e).not.toBeNull()
    expect(e!.name).toBe('---')
    expect(e!.position).toBeGreaterThan(0)
  })

  it('truncates a name long enough to break the layout', () => {
    expect(sanitiseEntry({ score: 1, name: 'X'.repeat(80) })!.name.length).toBe(12)
  })
})

describe('the table itself', () => {
  it('pays a better finish more than a worse one, all the way down', () => {
    for (let i = 1; i < TRACK_PLACE.length; i++) {
      expect(TRACK_PLACE[i]).toBeLessThan(TRACK_PLACE[i - 1])
      expect(LAP_PLACE[i]).toBeLessThan(LAP_PLACE[i - 1])
    }
  })

  it('makes a held slide worth more than spamming the button', () => {
    // Ten taps against one four-second Singularity. If tapping won, the whole
    // feature would teach the wrong thing.
    const taps = 10 * (DRIFT_START + DRIFT_RELEASE[0])
    const rig = new Rig()
    rig.slide(3)
    rig.hold(4)
    const held = rig.score + DRIFT_START + DRIFT_RELEASE[3]
    expect(held).toBeGreaterThan(taps)
  })
})
