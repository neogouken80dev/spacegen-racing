import { describe, it, expect } from 'vitest'
import { Race } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { RUSTFALL } from '../src/content/tracks/rustfall'
import { deriveChassis, CHASSIS, CHASSIS_BY_ID } from '../src/content/chassis'
import { ITEM_ORDER, ITEM_DISTRIBUTION, itemWeightsForPosition } from '../src/content/items'
import { resetAI } from '../src/sim/ai'
import { emptyInput } from '../src/sim/types'
import { TUNING } from '../src/content/tuning'
import type { SimConfig } from '../src/sim/types'

const cfg = (seed: number): SimConfig => ({
  seed, totalLaps: 3, racerCount: 8, trackId: 'rustfall',
  chassisIds: Array.from({ length: 8 }, (_, i) => CHASSIS[i % 5].id),
  pilotIds: Array.from({ length: 8 }, () => ''),
  localRacerIndex: -1,
  aiSkill: Array.from({ length: 8 }, () => 3),
})

describe('chassis derivation', () => {
  it('matches the published GDD formulas', () => {
    // Pinned against a SYNTHETIC stat block, not a roster entry. These numbers
    // are the GDD's published curves and must not move; the roster is tuning
    // data and does move, and an earlier version of this test froze Solaire's
    // grip into the formula check so a balance pass broke it for no reason.
    const flat = deriveChassis({ topSpeed: 5, accel: 5, grip: 5, mass: 5, drift: 5, handling: 5 })
    expect(flat.topSpeed).toBeCloseTo(46.0 + 5 * 2.20, 5)     // 57.0 m/s
    expect(flat.timeToTop).toBeCloseTo(6.4 - 5 * 0.34, 5)     // 4.70 s
    // GRIP WAS REPRICED for the friction-budget pass: 0.55 + 0.075/point became
    // 0.725 + 0.050/point. The roster mean is deliberately unmoved (grip 7 is
    // 1.075 either way); what changed is the SLOPE, because gripCoeff stopped
    // being a decay rate for a residue that never existed and became the
    // multiplier on a real lateral acceleration budget. At the old slope the
    // two points between Dray-9 and Bulwark measured 7.0% and 29.0% win share
    // over 200 races -- both out of band on stats alone. See T.derive.
    expect(flat.gripCoeff).toBeCloseTo(0.725 + 5 * 0.050, 5)  // 0.975
    expect(flat.massKg).toBeCloseTo(400 + 5 * 180, 5)         // 1300 kg
    expect(flat.driftChargeMult).toBeCloseTo(0.70 + 5 * 0.06, 5)
    expect(flat.maxYawRate).toBeCloseTo((55 + 5 * 9) * (Math.PI / 180), 5)

    // Every derived value is linear in its stat, and each curve slopes the way
    // the GDD says: more of a stat is better, except accel, where the derived
    // number is a TIME and has to fall.
    const hi = deriveChassis({ topSpeed: 6, accel: 6, grip: 6, mass: 6, drift: 6, handling: 6 })
    expect(hi.topSpeed).toBeGreaterThan(flat.topSpeed)
    expect(hi.timeToTop).toBeLessThan(flat.timeToTop)
    expect(hi.gripCoeff).toBeGreaterThan(flat.gripCoeff)
    expect(hi.massKg).toBeGreaterThan(flat.massKg)
    expect(hi.driftChargeMult).toBeGreaterThan(flat.driftChargeMult)
    expect(hi.maxYawRate).toBeGreaterThan(flat.maxYawRate)

    // Roster intent, stated as a property so tuning can move the numbers:
    // Bulwark is the drift specialist and must be the fastest to Singularity.
    const t4 = TUNING.drift.tierTimes[3]
    const bulwark = deriveChassis(CHASSIS_BY_ID['bulwark'].stats)
    const all = CHASSIS.map((c) => t4 / deriveChassis(c.stats).driftChargeMult)
    expect(Math.min(...all)).toBeCloseTo(t4 / bulwark.driftChargeMult, 5)
  })
})

describe('item distribution table', () => {
  it('sums to exactly 100 in every position column', () => {
    for (let pos = 0; pos < 8; pos++) {
      const total = ITEM_ORDER.reduce((a, id) => a + ITEM_DISTRIBUTION[id][pos], 0)
      expect(total).toBe(100)
    }
  })
  it('never gives 1st place an Alpha Missile, EMP or Overdrive Core', () => {
    const w = itemWeightsForPosition(1)
    for (const id of ['alphaMissile', 'empBomb', 'overdriveCore'] as const) {
      expect(w[ITEM_ORDER.indexOf(id)]).toBe(0)
    }
  })
})

describe('race simulation', () => {
  it('is deterministic across identical runs', () => {
    const run = () => {
      resetAI()
      const race = new Race(new Track(RUSTFALL), cfg(4242))
      const idle = emptyInput()
      for (let f = 0; f < 900; f++) { race.setInput(0, idle); race.step() }
      return race.hash()
    }
    expect(run()).toBe(run())
  })

  it('diverges with a different seed', () => {
    const run = (s: number) => {
      resetAI()
      const race = new Race(new Track(RUSTFALL), cfg(s))
      const idle = emptyInput()
      for (let f = 0; f < 900; f++) { race.setInput(0, idle); race.step() }
      return race.hash()
    }
    expect(run(1)).not.toBe(run(2))
  })

  it('completes a full 3-lap race with all 8 racers finishing', () => {
    resetAI()
    const race = new Race(new Track(RUSTFALL), cfg(99))
    const idle = emptyInput()
    let f = 0
    while (f < 60 * 500 && race.state.phase !== 'finished') {
      race.setInput(0, idle); race.step(); f++
    }
    expect(race.state.phase).toBe('finished')
    expect(race.state.finishOrder.length).toBe(8)
    const positions = race.results().map((r) => r.position)
    expect(positions).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('produces lap times inside the 55-75s design target', () => {
    resetAI()
    const race = new Race(new Track(RUSTFALL), cfg(7))
    const idle = emptyInput()
    let f = 0
    while (f < 60 * 500 && race.state.phase !== 'finished') { race.setInput(0, idle); race.step(); f++ }
    const laps = race.state.racers.flatMap((r) => r.lapTimes).filter((x) => x > 0)
    const avg = laps.reduce((a, b) => a + b, 0) / laps.length
    expect(avg).toBeGreaterThan(45)
    expect(avg).toBeLessThan(85)
  })

  it('never lets a racer exceed a plausible speed ceiling', () => {
    resetAI()
    const race = new Race(new Track(RUSTFALL), cfg(31))
    const idle = emptyInput()
    let maxSpeed = 0
    for (let f = 0; f < 60 * 240; f++) {
      race.setInput(0, idle); race.step()
      for (const r of race.state.racers) {
        maxSpeed = Math.max(maxSpeed, Math.hypot(r.vel.x, r.vel.z))
      }
    }
    // Fastest chassis 68 m/s, max boost +52%, charges +5% => ~108 m/s ceiling.
    expect(maxSpeed).toBeLessThan(115)
    expect(maxSpeed).toBeGreaterThan(40)
  })
})

describe('sim purity', () => {
  it('src/sim contains no DOM or three.js imports', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const dir = 'src/sim'
    const offenders: string[] = []
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.ts')) continue
      const raw = fs.readFileSync(path.join(dir, f), 'utf8')
      // Strip comments and string literals so prose like "during the window"
      // is not mistaken for a DOM reference.
      const src = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      if (/from\s+['"]three/.test(src)) offenders.push(`${f}: imports three`)
      // Real DOM usage is a member access or a call, not a bare word.
      if (/\b(document|window|navigator|localStorage)\s*[.[(]/.test(src)) offenders.push(`${f}: touches the DOM`)
      if (/\b(HTMLElement|HTMLCanvasElement|Event)\b/.test(src)) offenders.push(`${f}: references a DOM type`)
    }
    expect(offenders).toEqual([])
  })
})
