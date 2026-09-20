/**
 * THE DIFFICULTY LADDER, AND ABOVE ALL: NORMAL IS STILL TODAY'S GAME.
 *
 * Every lap time in the design docs, every balance measurement, the pinned
 * determinism hash in `bridges.test.ts` and four passes of drift tuning were
 * all taken against a field built by `2 + (slot % 3)` running a five-band
 * skill scale. Adding Easy, Hard and Expert is only safe if Normal comes back
 * out of the refactor as the same arithmetic on the same doubles -- otherwise
 * the ladder is not four difficulties, it is a retune of the game wearing a
 * settings row, and the measured history stops applying.
 *
 * So the first two blocks below are the load-bearing ones. They rebuild the
 * old expressions here, independently of `content/difficulty.ts`, and demand
 * `Object.is` -- not `toBeCloseTo`, because `1.4 - 2 * 0.12` is
 * 1.1599999999999999 and a table of typed literals would have been one ULP
 * out on three rows in a way no tolerance would have caught and every hash
 * would have.
 */
import { describe, it, expect } from 'vitest'
import {
  SKILL_BANDS, bandFor, skillForSlot, asDifficulty, difficultyOfGrid, scopeFor,
  DIFFICULTIES, DIFFICULTY_SPECS, DEFAULT_DIFFICULTY, type Difficulty,
} from '../src/content/difficulty'
import { payout } from '../src/score/wallet'
import { TUNING as T } from '../src/content/tuning'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = (p: string): string => readFileSync(resolve(__dirname, '..', p), 'utf8')

/**
 * Source with its comments removed.
 *
 * The grep below wants to know whether any CODE still builds a grid by hand,
 * and the honest record of why it no longer does is a comment that quotes the
 * old expression verbatim -- which a naive grep reads as the thing it is
 * looking for. A test that cannot tell prose from code makes the
 * documentation the failure, and the cheapest way to pass it is to delete the
 * explanation. Crude on purpose: it does not understand a `//` inside a
 * string literal, and nothing in these five files has one.
 */
const CODE = (p: string): string =>
  SRC(p).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(?<!:)\/\/[^\n]*/g, ' ')

/** The bands the shipped game raced, and the only ones the hash depends on. */
const RACED = [2, 3, 4] as const

describe('Normal is the game that shipped, to the bit', () => {
  it('rebuilds bands 2-4 from the expressions ai.ts used to spell out', () => {
    // Written out again here, deliberately duplicated, because a test that
    // imports the thing it is checking cannot fail. These five lines are the
    // originals from ai.ts:217/299/307/391, race.ts:430 and the old
    // bridgeHorizonSkill lookup.
    for (const k of RACED) {
      const b = SKILL_BANDS[k]
      expect(Object.is(b.speed, T.ai.skillSpeed[k])).toBe(true)
      expect(Object.is(b.reaction, 1.4 - k * 0.12)).toBe(true)
      expect(Object.is(b.mistake, 5 - k)).toBe(true)
      expect(Object.is(b.drift, k * 0.05)).toBe(true)
      expect(Object.is(b.bridge, T.ai.bridgeHorizonSkill[k])).toBe(true)
      expect(Object.is(b.rocket, 0.12 + k * 0.06)).toBe(true)
    }
  })

  it('leaves cornering caution at exactly 1 on those bands, so the multiply is an identity', () => {
    // THE WHOLE REASON caution IS A MULTIPLIER AND NOT AN ABSOLUTE. ai.ts now
    // reads `cornerSpeedAt(...) * T.ai.corneringCaution * band.caution`, and
    // `x * 1` is x exactly in IEEE754 for every finite x. An absolute 0.86 in
    // the table would have been the same NUMBER and a different EXPRESSION,
    // which is the kind of distinction that only shows up as a moved hash.
    for (const k of RACED) {
      expect(SKILL_BANDS[k].caution).toBe(1)
      for (const v of [0.86, 41.37, 1e-8, 123456.789]) expect(v * SKILL_BANDS[k].caution).toBe(v)
    }
  })

  it('builds a Normal grid as 2 + (slot % 3), for every slot', () => {
    for (let slot = 0; slot < 64; slot++) {
      expect(skillForSlot('normal', slot)).toBe(2 + (slot % 3))
    }
  })

  it('no longer leaves the old expressions lying around in ai.ts to drift from', () => {
    // A refactor that leaves the original behind has two sources of truth and
    // the second one is the one nobody updates.
    const ai = CODE('src/sim/ai.ts')
    expect(ai).not.toContain('1.4 - skill')
    expect(ai).not.toContain('(5 - skill)')
    expect(ai).not.toContain('skill * 0.05')
    expect(ai).not.toContain('T.ai.skillSpeed[')
    expect(ai).not.toContain('bridgeHorizonSkill[')
    expect(ai).toContain('bandFor(r.aiSkill)')
    // And the rocket start, which lived in race.ts.
    expect(CODE('src/sim/race.ts')).toContain('bandFor(r.aiSkill).rocket')
    expect(CODE('src/sim/race.ts')).not.toContain('0.12 + skill * 0.06')
  })
})

describe('the ladder is a ladder', () => {
  it('never goes backwards in any column', () => {
    // Not "each band is faster" -- each band is at least as CAPABLE, column by
    // column, where capable means the direction that helps. speed and drift
    // and caution and rocket go up; reaction and mistake go down. A row that
    // broke one of these would be a difficulty step that made one thing worse,
    // which is how a ladder ends up non-monotonic in a way the probe then has
    // to discover by racing forty times.
    for (let k = 1; k < SKILL_BANDS.length; k++) {
      const lo = SKILL_BANDS[k - 1]
      const hi = SKILL_BANDS[k]
      expect(hi.speed).toBeGreaterThanOrEqual(lo.speed)
      expect(hi.drift).toBeGreaterThanOrEqual(lo.drift)
      expect(hi.caution).toBeGreaterThanOrEqual(lo.caution)
      expect(hi.rocket).toBeGreaterThan(lo.rocket)
      expect(hi.bridge).toBeGreaterThanOrEqual(lo.bridge)
      expect(hi.reaction).toBeLessThan(lo.reaction)
      expect(hi.mistake).toBeLessThan(lo.mistake)
    }
  })

  it('keeps the top band beatable and the bottom band driving', () => {
    const top = SKILL_BANDS[SKILL_BANDS.length - 1]
    // An opponent that cannot err is a wall, not a difficulty.
    expect(top.mistake).toBeGreaterThan(0)
    // An Expert grid that ALL launches perfectly is a first corner nobody wins.
    expect(top.rocket).toBeLessThan(0.85)
    // 0.44 x 0.11s is 48ms, about three frames. Below that a held steering
    // value stops being held and starts being per-frame noise.
    expect(top.reaction * T.ai.reactionTime).toBeGreaterThan(0.04)
    // And the margin to the friction limit is what absorbs a bump.
    expect(top.caution * T.ai.corneringCaution).toBeLessThan(0.95)

    const bot = SKILL_BANDS[0]
    expect(bot.speed).toBeGreaterThan(0.75)
    expect(bot.caution * T.ai.corneringCaution).toBeGreaterThan(0.75)
  })

  it('gives every difficulty a band range, and no two the same range', () => {
    // difficultyOfGrid reads the table backwards, so overlapping ranges would
    // make a grid answer to two names and the lobby show whichever came first.
    const seen = new Map<number, Difficulty>()
    for (const d of DIFFICULTIES) {
      // Deduped WITHIN a difficulty on purpose: Easy runs bands 0,0,1, so a
      // repeat inside one tier is the spread doing its job. What must never
      // happen is a band appearing in two different tiers.
      for (const b of new Set([0, 1, 2].map((s) => skillForSlot(d, s)))) {
        expect(b).toBeGreaterThanOrEqual(0)
        expect(b).toBeLessThan(SKILL_BANDS.length)
        const prior = seen.get(b)
        expect(prior, `band ${b} is in both ${prior} and ${d}`).toBeUndefined()
        seen.set(b, d)
      }
    }
    // And every band the table defines is reachable from some difficulty --
    // a row nobody can race is a row nobody has measured.
    expect(seen.size).toBe(SKILL_BANDS.length)
  })

  it('pays more for the harder ones, and Normal is the unit', () => {
    expect(DIFFICULTY_SPECS.normal.payout).toBe(1)
    expect(DIFFICULTY_SPECS.easy.payout).toBeLessThan(1)
    for (let i = 1; i < DIFFICULTIES.length; i++) {
      expect(DIFFICULTY_SPECS[DIFFICULTIES[i]].payout)
        .toBeGreaterThan(DIFFICULTY_SPECS[DIFFICULTIES[i - 1]].payout)
    }
  })
})

describe('everything that arrives from outside is untrusted', () => {
  it('clamps a band index rather than returning undefined', () => {
    // aiSkill rides a packet a peer wrote and a save file a player can edit.
    // Out of range is not an error to throw on: a guest on an older build
    // sending a band this one does not have must still race.
    expect(bandFor(-99)).toBe(SKILL_BANDS[0])
    expect(bandFor(999)).toBe(SKILL_BANDS[SKILL_BANDS.length - 1])
    expect(bandFor(2.4)).toBe(SKILL_BANDS[2])
    expect(bandFor(2.6)).toBe(SKILL_BANDS[3])
    // NaN reaches both comparisons as false, so the clamp let it through and
    // `SKILL_BANDS[NaN]` is undefined -- a throw inside the fixed-step sim.
    expect(bandFor(NaN)).toBeDefined()
    expect(bandFor(Infinity)).toBeDefined()
    expect(bandFor(-Infinity)).toBeDefined()
  })

  it('falls back to Normal for anything that is not a difficulty', () => {
    for (const d of DIFFICULTIES) expect(asDifficulty(d)).toBe(d)
    for (const junk of [null, undefined, '', 'NORMAL', 'insane', 3, {}, []]) {
      expect(asDifficulty(junk)).toBe(DEFAULT_DIFFICULTY)
    }
  })

  it('reads a difficulty back off a grid, and refuses to guess', () => {
    // The packet carries skills, not a name, so the lobby asks the grid what
    // it is. A grid that matches no tier must answer null rather than the
    // nearest thing -- showing "Hard" for a field that is not Hard is worse
    // than showing the bands.
    for (const d of DIFFICULTIES) {
      const grid = Array.from({ length: 7 }, (_, i) => skillForSlot(d, i + 1))
      expect(difficultyOfGrid(grid)).toBe(d)
    }
    expect(difficultyOfGrid([2, 9])).toBe(null)
    expect(difficultyOfGrid([])).toBe(null)
    // A single-car grid still answers, because one band is enough to place it.
    expect(difficultyOfGrid([9])).toBe('expert')
  })
})

describe('the ladder is spelled the same way everywhere', () => {
  it('has no hand-written 2 + (slot % 3) left in the game layers', () => {
    // Six copies of this expression is how Normal and the multiplayer
    // stand-in drifted apart the LAST time someone touched AI pace -- the
    // comment on standInSkill says so in as many words. One function now.
    for (const f of [
      'src/game/main.ts', 'src/game/circuit.ts', 'src/net/mock.ts', 'src/net/live.ts',
      'tools/headless.ts',
    ]) {
      const src = CODE(f)
      expect(src, `${f} still builds a grid by hand`).not.toMatch(/2 \+ \((slot|i|grid\.length) % 3\)/)
    }
  })
})

describe('records and payouts follow the difficulty, without a migration', () => {
  it('leaves Normal on the bare track id, which is what makes old saves survive', () => {
    // THE WHOLE MIGRATION STRATEGY IN ONE ASSERTION. Every record and board
    // row that exists today was set against the only field the game had, so it
    // IS a Normal row, and the right thing to do with it is leave it where it
    // is. A scheme that suffixed all four tiers would have needed a boot-time
    // walk of localStorage renaming keys -- a data migration that can
    // half-finish, to arrive at the same place.
    for (const t of ['rustfall', 'cryostatic', 'emberfall']) {
      expect(scopeFor(t, 'normal')).toBe(t)
      expect(scopeFor(t, 'easy')).not.toBe(t)
      expect(scopeFor(t, 'hard')).not.toBe(t)
      expect(scopeFor(t, 'expert')).not.toBe(t)
    }
  })

  it('gives every track and tier its own board, with no collisions', () => {
    const keys = new Set<string>()
    for (const t of ['rustfall', 'cryostatic', 'aetherion', 'emberfall', 'a@b']) {
      for (const d of DIFFICULTIES) {
        const k = scopeFor(t, d)
        expect(keys.has(k), `${t}/${d} collides on ${k}`).toBe(false)
        keys.add(k)
      }
    }
    expect(keys.size).toBe(5 * DIFFICULTIES.length)
  })

  it('pays Easy less and Expert more, for the same race', () => {
    const base = { trackId: 'rustfall', score: 120_000, raceTime: 170 }
    const plain = payout(base)
    // An absent difficulty is Normal, which is what every PayoutRun built
    // before this feature existed means.
    expect(plain.difficulty).toBe(1)
    expect(payout({ ...base, difficulty: 'normal' }).credits).toBe(plain.credits)
    expect(payout({ ...base, difficulty: 'easy' }).credits).toBeLessThan(plain.credits)
    expect(payout({ ...base, difficulty: 'expert' }).credits).toBeGreaterThan(plain.credits)
    for (let i = 1; i < DIFFICULTIES.length; i++) {
      const lo = payout({ ...base, difficulty: DIFFICULTIES[i - 1] }).credits
      const hi = payout({ ...base, difficulty: DIFFICULTIES[i] }).credits
      expect(hi).toBeGreaterThan(lo)
    }
  })

  it('applies the cap AFTER the multiplier, so the ceiling is one number', () => {
    // A score far past the cap on every tier. If difficulty multiplied the
    // CAPPED value instead, Expert would bank 1.8x the ceiling and the cap
    // would silently be four different numbers.
    const huge = { trackId: 'rustfall', score: 50_000_000, raceTime: 170 }
    const all = DIFFICULTIES.map((d) => payout({ ...huge, difficulty: d }))
    for (const p of all) expect(p.capped).toBe(true)
    expect(new Set(all.map((p) => p.credits)).size).toBe(1)
  })

  it('refuses to pay for a DNF at any difficulty', () => {
    // raceTime 0 is main.ts's DNF convention, and Expert's 1.8x must not turn
    // not finishing into a payday.
    for (const d of DIFFICULTIES) {
      expect(payout({ trackId: 'rustfall', score: 999_999, raceTime: 0, difficulty: d }).credits)
        .toBe(0)
    }
  })
})
