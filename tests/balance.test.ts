import { describe, it, expect, beforeAll } from 'vitest'
import {
  runBatch, buildReport, configForRace, lineupForRace, mergeAgg, emptyAgg,
  DEFAULT_OPTIONS, GATE, type Agg, type Report, type BalanceOptions,
} from '../tools/balance'
import { CHASSIS } from '../src/content/chassis'
import { ITEM_ORDER, ITEM_DISTRIBUTION } from '../src/content/items'

/**
 * The per-commit guard on the balance gate.
 *
 * `npm run balance -- --races=2000 --assert` is the real gate and takes tens of
 * minutes. This runs a small sample with deliberately generous bounds: it is
 * here to catch a tuning edit that puts a chassis on the floor or turns the
 * race into a procession, not to certify a 1% shift. A failure here means run
 * the full gate; a pass here does not mean the full gate passes.
 *
 * Sample size is 200 races -- 40 complete lineup blocks, so every chassis gets
 * exactly 320 entries and grid slot cannot confound the result. That is roughly
 * 4 minutes single-threaded, which is the price of a signal that is not noise.
 */
const RACES = 200

const OPTIONS: BalanceOptions = { ...DEFAULT_OPTIONS, races: RACES }

/** Wider than the shipping gate: at n=200 a true 20% share reads +/-5.5%. */
const LOOSE = {
  winShareMin: 0.08,
  winShareMax: 0.35,
  leadRetentionMin: 0.33,
  leadRetentionMax: 0.67,
  lapMeanMin: 50,
  lapMeanMax: 82,
} as const

describe('balance harness', () => {
  it('gives every chassis an equal number of entries across a block of 5 races', () => {
    const counts = new Array<number>(CHASSIS.length).fill(0)
    for (let i = 0; i < 5; i++) for (const c of lineupForRace(i, 8)) counts[c]++
    expect(counts).toEqual(new Array(CHASSIS.length).fill(8))
  })

  it('spreads every chassis over every grid slot and uses a fresh seed per race', () => {
    const slotCounts = CHASSIS.map(() => new Array<number>(8).fill(0))
    const seeds = new Set<number>()
    for (let i = 0; i < 400; i++) {
      const cfg = configForRace(i, OPTIONS)
      seeds.add(cfg.seed)
      cfg.chassisIds.forEach((id, slot) => {
        slotCounts[CHASSIS.findIndex((c) => c.id === id)][slot]++
      })
    }
    expect(seeds.size).toBe(400)
    // 400 races * 8 entries / 5 chassis / 8 slots = 80 expected per cell.
    for (const row of slotCounts) {
      for (const cell of row) {
        expect(cell).toBeGreaterThan(45)
        expect(cell).toBeLessThan(120)
      }
    }
  })

  it('merges worker aggregates additively', () => {
    const a = runBatch(0, 1, OPTIONS)
    const b = runBatch(1, 2, OPTIONS)
    const races = a.races + b.races
    const wins = a.wins.reduce((x, y) => x + y, 0) + b.wins.reduce((x, y) => x + y, 0)
    const merged = mergeAgg(mergeAgg(emptyAgg(), a), b)
    expect(merged.races).toBe(races)
    expect(merged.wins.reduce((x, y) => x + y, 0)).toBe(wins)
    expect(merged.lapMin).toBe(Math.min(a.lapMin, b.lapMin))
  })
})

describe('item distribution invariants', () => {
  it('keeps every position column summing to exactly 100', () => {
    for (let col = 0; col < 8; col++) {
      expect(ITEM_ORDER.reduce((a, id) => a + ITEM_DISTRIBUTION[id][col], 0)).toBe(100)
    }
  })

  it('never hands 1st place an Alpha Missile, EMP or Overdrive Core', () => {
    for (const id of ['alphaMissile', 'empBomb', 'overdriveCore'] as const) {
      expect(ITEM_DISTRIBUTION[id][0]).toBe(0)
    }
  })

  it('keeps catch-up items monotonically more likely further back', () => {
    for (const id of ['nitroTriple', 'alphaMissile'] as const) {
      const row = ITEM_DISTRIBUTION[id]
      for (let col = 1; col < 8; col++) expect(row[col]).toBeGreaterThanOrEqual(row[col - 1])
    }
  })
})

describe('chassis design identity', () => {
  const stat = (id: string, k: 'topSpeed' | 'accel' | 'grip' | 'mass' | 'drift' | 'handling') =>
    CHASSIS.find((c) => c.id === id)!.stats[k]
  const others = (id: string) => CHASSIS.filter((c) => c.id !== id)

  it('keeps every stat an integer in 1-10', () => {
    for (const c of CHASSIS) {
      for (const [k, v] of Object.entries(c.stats)) {
        expect(Number.isInteger(v), `${c.id}.${k} = ${v}`).toBe(true)
        expect(v, `${c.id}.${k}`).toBeGreaterThanOrEqual(1)
        expect(v, `${c.id}.${k}`).toBeLessThanOrEqual(10)
      }
    }
  })

  it('keeps Bulwark the best drifter and the slowest', () => {
    expect(Math.max(...others('bulwark').map((c) => c.stats.drift))).toBeLessThan(stat('bulwark', 'drift'))
    expect(Math.min(...others('bulwark').map((c) => c.stats.topSpeed))).toBeGreaterThan(stat('bulwark', 'topSpeed'))
  })

  it('keeps Dray-9 the fastest and the worst accelerating', () => {
    expect(Math.max(...others('dray9').map((c) => c.stats.topSpeed))).toBeLessThan(stat('dray9', 'topSpeed'))
    expect(Math.min(...others('dray9').map((c) => c.stats.accel))).toBeGreaterThan(stat('dray9', 'accel'))
  })

  it('keeps Filament the best accelerating, best handling and lightest', () => {
    expect(Math.max(...others('filament').map((c) => c.stats.accel))).toBeLessThan(stat('filament', 'accel'))
    expect(Math.max(...others('filament').map((c) => c.stats.handling))).toBeLessThan(stat('filament', 'handling'))
    expect(Math.min(...others('filament').map((c) => c.stats.mass))).toBeGreaterThan(stat('filament', 'mass'))
  })

  it('keeps Vector-7 the only flight chassis and Solaire the neutral pick', () => {
    expect(CHASSIS.filter((c) => c.locomotion === 'flight').map((c) => c.id)).toEqual(['vector7'])
    // "The honest one: no weaknesses, no spikes." Assert that property rather
    // than a literal row of 7s, so tuning can move Solaire without the test
    // becoming a copy of the data it is supposed to be checking.
    const keys = ['topSpeed', 'accel', 'grip', 'drift', 'handling'] as const
    const s = CHASSIS.find((c) => c.id === 'solaire')!.stats
    for (const k of keys) {
      const all = CHASSIS.map((c) => c.stats[k])
      expect(s[k], `Solaire must not hold the roster minimum in ${k}`).toBeGreaterThan(Math.min(...all))
      expect(s[k], `Solaire must not hold the roster maximum in ${k}`).toBeLessThan(Math.max(...all))
    }
    // And it must stay genuinely even: no stat more than 2 off its own mean.
    const vals = keys.map((k) => s[k])
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length
    for (const v of vals) expect(Math.abs(v - mean)).toBeLessThanOrEqual(2)
  })
})

describe(`balance gate regression (${RACES} races)`, () => {
  let agg: Agg
  let report: Report

  beforeAll(() => {
    agg = runBatch(0, RACES, OPTIONS)
    report = buildReport(agg, OPTIONS)
  }, 900_000)

  // About 1 race in 500 ends with a racer wedged somewhere it cannot recover
  // from and still running when the frame cap hits. That is a sim robustness
  // bug, not a tuning one, so this guards the RATE rather than demanding zero
  // -- if a tuning edit starts stranding racers, this is what catches it.
  it('does not strand racers above the tolerated rate', () => {
    const dnf = RACES - agg.finishedRaces
    expect(dnf / RACES, `${dnf}/${RACES} races hit the frame cap`).toBeLessThanOrEqual(GATE.maxDnfRate * 2)
  })

  it('keeps no chassis on the floor or running away with it', () => {
    const out = report.chassis
      .filter((c) => c.winShare < LOOSE.winShareMin || c.winShare > LOOSE.winShareMax)
      .map((c) => `${c.id} ${(c.winShare * 100).toFixed(1)}%`)
    expect(out, `bounds ${LOOSE.winShareMin}-${LOOSE.winShareMax}; run the full gate`).toEqual([])
  })

  it('keeps average finishing position within a position of the field mean', () => {
    for (const c of report.chassis) {
      expect(c.avgFinish, c.id).toBeGreaterThan(3.4)
      expect(c.avgFinish, c.id).toBeLessThan(5.6)
    }
  })

  it('is neither a procession nor a coin flip', () => {
    expect(report.leadRetention).toBeGreaterThan(LOOSE.leadRetentionMin)
    expect(report.leadRetention).toBeLessThan(LOOSE.leadRetentionMax)
  })

  it('holds lap times near the 55-75s design target', () => {
    expect(report.lapMean).toBeGreaterThan(LOOSE.lapMeanMin)
    expect(report.lapMean).toBeLessThan(LOOSE.lapMeanMax)
  })

  it('keeps Tier 3 Singularity drifts reachable on Rustfall', () => {
    expect(report.driftShare[4]).toBeGreaterThan(GATE.tier3MinShare)
  })

  it('keeps the race churning rather than settling on lap 1', () => {
    expect(report.overtakesPerRace).toBeGreaterThan(20)
  })

  it('keeps the Alpha Missile a leader-killer rather than a stray firework', () => {
    expect(agg.alphaFires).toBeGreaterThan(RACES * 0.5)
    expect(report.alphaLeaderPerFire).toBeGreaterThan(0.35)
  })
})
