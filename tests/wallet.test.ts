/**
 * AN ECONOMY IS ARITHMETIC PLUS A PROMISE, AND BOTH OF THEM FAIL SILENTLY.
 *
 * The arithmetic half is the same argument `score.test.ts` makes: a payout that
 * is 1.6x too generous, a balance that can go negative, a rank that fires one
 * credit late -- none of them look wrong to somebody watching a number go up.
 * They look wrong three weeks later, to a player who has bought everything, or
 * to one who cannot buy anything and does not know why.
 *
 * The promise half is new here and is the part worth writing tests for at all.
 * `src/content/avatars.ts` prints a sentence under a locked portrait telling the
 * player what to do about it. Every one of those sentences is a claim that the
 * game can OBSERVE the thing it is asking for -- and the cheapest possible bug
 * in this feature is a feat whose condition no code path can ever produce, which
 * is invisible forever because nobody unlocks it and nobody files a bug about a
 * portrait they never saw. So the feat tests below are driven from a real
 * headless race and a real Grand Circuit rather than from hand-made objects:
 * the point is not that the predicate returns true, it is that the numbers it
 * reads exist.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  AVATARS, AVATAR_BY_ID, AVATAR_DIR, DEFAULT_AVATAR_ID, FEATS,
  FEAT_CIRCUIT_ROUNDS, FEAT_SCORE, PRICES, RANKS, STARTER_IDS,
  artPending, artSizeFor, canBuy, catalogueFor, featsEarned, featsFromProfile, hasArt,
  ownsAvatar, placeholderPortrait, portraitFor, priceOf, ranksEarned, srcFor, wornAvatar,
  type ProfileLike, type RaceFeatEvidence,
} from '../src/content/avatars'
import {
  FINISH_CREDITS, MAX_PER_RACE, REF_SCORE, REPEAT_DAMP, REPEAT_WINDOW,
  SKILL_CREDITS, Wallet, bankRun, payout, repeatFactor, resetSharedWallet,
  type PayoutRun,
} from '../src/score/wallet'
import { COMBO_MAX, DRIFT_RATE, LAP_PLACE, TRACK_PLACE } from '../src/score/rules'
import { Scorer } from '../src/score/scorer'
import type { RaceState, RacerState } from '../src/sim/types'
import {
  CIRCUIT_GRID, CIRCUIT_ROUNDS, applyRound, champion, isComplete, newCircuit,
  standings, trackIdForRound, type CircuitState,
} from '../src/game/circuit'
import { Race } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { RUSTFALL } from '../src/content/tracks'
import { CHASSIS } from '../src/content/chassis'
import { PILOTS } from '../src/content/pilots'
import { resetAI } from '../src/sim/ai'
import { emptyInput } from '../src/sim/types'

const profile = (over: Partial<ProfileLike> = {}): ProfileLike => ({
  unlocked: [...STARTER_IDS], credits: 0, earned: 0, races: 0, wins: 0, ...over,
})

const run = (over: Partial<PayoutRun> = {}): PayoutRun => ({
  trackId: 'rustfall', score: REF_SCORE, raceTime: 170, ...over,
})

/**
 * The measurement the whole economy is derived from, kept here so that a later
 * coefficient change has to argue with it rather than with nobody.
 *
 * Per-circuit median score and median race time over 192 headless finishes --
 * eight circuits x three seeds x eight cars, the real sim, the real `Scorer`.
 * The full figures are in the header of `src/score/wallet.ts`.
 */
const MEASURED = [
  { id: 'rustfall', score: 425956, time: 162.6 },
  { id: 'emberfall', score: 423375, time: 268.0 },
  { id: 'hollowchoir', score: 347170, time: 191.7 },
  { id: 'cryostatic', score: 334957, time: 182.9 },
  { id: 'aetherion', score: 214152, time: 202.0 },
  { id: 'abyssal', score: 156315, time: 263.5 },
  { id: 'neonspire', score: 130434, time: 273.7 },
  { id: 'halcyon', score: 47778, time: 182.2 },
] as const

/** The highest and lowest single scores seen across those 192 finishes. */
const MEASURED_MAX = 848682
const MEASURED_MIN = 34810

// ---------------------------------------------------------------------------

describe('the payout curve at its ends', () => {
  it('pays nothing at all for a DNF, whatever it scored', () => {
    // The cheapest farm in a drift-scored game is one corner and a restart.
    // `raceTime` is main.ts's own DNF discriminator: it writes 0 for a car that
    // did not cross the line, however many points it banked on the way.
    expect(payout(run({ raceTime: 0, score: 900000 })).credits).toBe(0)
    expect(payout(run({ raceTime: -1, score: 900000 })).credits).toBe(0)
    expect(payout(run({ raceTime: NaN, score: 900000 })).credits).toBe(0)
  })

  it('pays the flat finish component for a finished race that scored zero', () => {
    expect(payout(run({ score: 0 })).credits).toBe(FINISH_CREDITS)
  })

  it('pays a median race almost exactly FINISH + SKILL', () => {
    // REF_SCORE is the measured median, so this is the calibration point: if it
    // stops being ~80 the prices in content/avatars.ts are no longer priced
    // against anything.
    expect(payout(run({ score: REF_SCORE })).credits).toBe(FINISH_CREDITS + SKILL_CREDITS)
  })

  it('compresses 500:1 in score into 22:1 in credits', () => {
    // The floor is a player who never drifts: three laps of placement at a
    // combo of 1, which is all the game can pay for driving without sliding.
    const floor = LAP_PLACE[LAP_PLACE.length - 1] * 3 + TRACK_PLACE[TRACK_PLACE.length - 1]
    expect(floor).toBe(1600)
    const low = payout(run({ score: floor })).credits
    const high = payout(run({ score: MEASURED_MAX })).credits
    expect(low).toBe(25)
    expect(high).toBe(131)
    expect(MEASURED_MAX / floor).toBeGreaterThan(500)
    expect(high / low).toBeLessThan(25)
  })

  it('never pays more than the per-race cap, however absurd the score', () => {
    const p = payout(run({ score: 1e12 }))
    expect(p.credits).toBe(MAX_PER_RACE)
    expect(p.capped).toBe(true)
    // And the cap does not bind on anything the game has actually produced.
    expect(payout(run({ score: MEASURED_MAX })).capped).toBe(false)
  })

  it('treats a nonsense score as zero rather than throwing', () => {
    // This is called from a results screen that has already decided to exist.
    for (const score of [NaN, -1, -1e9, Infinity]) {
      const p = payout(run({ score }))
      expect(Number.isFinite(p.credits)).toBe(true)
      expect(p.credits).toBeGreaterThanOrEqual(0)
    }
    expect(payout(run({ score: -5 })).credits).toBe(FINISH_CREDITS)
  })

  it('pays a whole number of credits', () => {
    for (const score of [0, 1600, 47778, 267436, MEASURED_MAX]) {
      expect(Number.isInteger(payout(run({ score })).credits)).toBe(true)
    }
  })

  it('lands the whole measured distribution in a band a designer can hold', () => {
    const paid = MEASURED.map((m) => payout(run({ score: m.score })).credits)
    expect(Math.min(...paid)).toBeGreaterThanOrEqual(40)
    expect(Math.max(...paid)).toBeLessThanOrEqual(120)
    // And the worst race ever measured still pays enough to be worth banking.
    expect(payout(run({ score: MEASURED_MIN })).credits).toBeGreaterThan(FINISH_CREDITS)
  })
})

describe('it is not a ratchet on replaying one circuit', () => {
  it('damps by how many of the last three finishes were here', () => {
    expect(repeatFactor('rustfall', [])).toBe(REPEAT_DAMP[0])
    expect(repeatFactor('rustfall', ['halcyon', 'neonspire', 'abyssal'])).toBe(REPEAT_DAMP[0])
    expect(repeatFactor('rustfall', ['rustfall'])).toBe(REPEAT_DAMP[1])
    expect(repeatFactor('rustfall', ['rustfall', 'rustfall'])).toBe(REPEAT_DAMP[2])
    expect(repeatFactor('rustfall', ['rustfall', 'rustfall', 'rustfall'])).toBe(REPEAT_DAMP[3])
  })

  it('looks no further back than the window, however long the history', () => {
    const long = ['halcyon', 'halcyon', 'halcyon', 'rustfall', 'rustfall', 'rustfall']
    expect(repeatFactor('rustfall', long)).toBe(REPEAT_DAMP[0])
    expect(long.length).toBeGreaterThan(REPEAT_WINDOW)
  })

  it('makes grinding the best-paying circuit WORSE than rotating the roster', () => {
    // The claim in the wallet header, pinned as arithmetic. Credits per minute,
    // from the measured per-circuit medians.
    const rate = (m: typeof MEASURED[number], damp: number): number =>
      (payout(run({ trackId: m.id, score: m.score })).credits * damp) / (m.time / 60)
    const rotating = MEASURED.map((m) => rate(m, 1))
    const best = Math.max(...rotating)
    const median = [...rotating].sort((a, b) => a - b)[Math.floor(rotating.length / 2)]
    const ground = best * REPEAT_DAMP[REPEAT_DAMP.length - 1]
    expect(ground).toBeLessThan(median)
    // Raw score per minute spans ten to one across the roster; the root has to
    // pull the credit rate inside three to one before the damping is even asked
    // to do anything, or no damping could close it.
    const rawSpread = Math.max(...MEASURED.map((m) => m.score / m.time))
      / Math.min(...MEASURED.map((m) => m.score / m.time))
    expect(rawSpread).toBeGreaterThan(8)
    expect(best / Math.min(...rotating)).toBeLessThan(3)
  })

  it('still pays a player who only ever drives one circuit', () => {
    // A brake, never a wall. Nothing is ever refused.
    const p = payout(run(), ['rustfall', 'rustfall', 'rustfall'])
    expect(p.credits).toBeGreaterThan(0)
    expect(p.repeat).toBe(REPEAT_DAMP[3])
  })
})

// ---------------------------------------------------------------------------

/** A localStorage that throws on every access, the way a partitioned one does. */
function hostileStorage(): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      get localStorage(): never { throw new DOMException('denied', 'SecurityError') },
    },
  })
}

/** A working one, in memory. */
function memoryStorage(seed: Record<string, string> = {}): Record<string, string> {
  const map: Record<string, string> = { ...seed }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (k: string): string | null => (k in map ? map[k] : null),
        setItem: (k: string, v: string): void => { map[k] = v },
        removeItem: (k: string): void => { delete map[k] },
      },
    },
  })
  return map
}

function noWindow(): void {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: undefined })
}

afterEach(() => {
  noWindow()
  resetSharedWallet()
})

describe('the balance', () => {
  it('cannot go negative, whatever it is asked to spend', () => {
    const w = new Wallet(false)
    w.bank(run({ score: REF_SCORE }))
    expect(w.balance).toBe(80)
    expect(w.spend(81)).toBe(false)
    expect(w.balance).toBe(80)
    expect(w.spend(80)).toBe(true)
    expect(w.balance).toBe(0)
    expect(w.spend(1)).toBe(false)
    expect(w.balance).toBe(0)
  })

  it('refuses a spend that is not a real cost', () => {
    const w = new Wallet(false)
    w.bank(run())
    const before = w.balance
    for (const bad of [0, -1, NaN, Infinity]) expect(w.spend(bad)).toBe(false)
    expect(w.balance).toBe(before)
  })

  it('keeps lifetime earnings when credits are spent', () => {
    // The rank ladder reads `earned`. Spending must never cost a rank -- a
    // player watching a rank portrait re-lock itself because they bought
    // something is the one outcome that cannot be explained to them.
    const w = new Wallet(false)
    w.bank(run({ score: REF_SCORE }))
    w.bank(run({ trackId: 'halcyon', score: REF_SCORE }))
    expect(w.lifetime).toBe(160)
    w.spend(150)
    expect(w.balance).toBe(10)
    expect(w.lifetime).toBe(160)
  })

  it('refuses to bank the same race twice', () => {
    // publishScore() runs once per race today. "Once" is a property of a call
    // site, not of bank().
    const w = new Wallet(false)
    const r = run({ at: 1_700_000_000_000 })
    expect(w.bank(r).credits).toBe(80)
    expect(w.bank(r).credits).toBe(0)
    expect(w.balance).toBe(80)
    // A different race on the same circuit is not the same race.
    expect(w.bank(run({ at: 1_700_000_000_001 })).credits).toBeGreaterThan(0)
  })

  it('takes the server\'s numbers without arguing', () => {
    const w = new Wallet(false)
    w.bank(run())
    w.adopt({ credits: 12, earned: 5000 })
    expect(w.balance).toBe(12)
    expect(w.lifetime).toBe(5000)
  })

  it('announces every change once', () => {
    const w = new Wallet(false)
    let seen = 0
    let last = w.snapshot()
    w.onChange = (s): void => { seen++; last = s }
    w.bank(run())
    w.spend(10)
    w.adopt({ credits: 3, earned: 3 })
    expect(seen).toBe(3)
    expect(last.credits).toBe(3)
  })

  it('offers each payout to the account layer for forwarding', () => {
    // The seam for AccountService.award(). The wallet never calls a network.
    const w = new Wallet(false)
    const banked: number[] = []
    w.onBank = (p): void => { banked.push(p.credits) }
    w.bank(run())
    w.bank(run({ trackId: 'halcyon', score: 0 }))
    expect(banked).toEqual([80, FINISH_CREDITS])
  })
})

describe('storage is a cache, and a hostile one is survivable', () => {
  it('works with no window at all, which is how the tests and the server run', () => {
    noWindow()
    const w = new Wallet()
    expect(w.balance).toBe(0)
    expect(w.bank(run()).credits).toBe(80)
    expect(w.balance).toBe(80)
  })

  it('degrades instead of crashing when localStorage throws', () => {
    // Partitioned and private contexts throw on the PROPERTY ACCESS, not on the
    // call -- which is why the guard is around the lookup and not around
    // getItem. A wallet that takes the game down in a private window is
    // infinitely worse than a wallet that forgets a balance.
    hostileStorage()
    expect(() => new Wallet()).not.toThrow()
    const w = new Wallet()
    expect(() => w.bank(run())).not.toThrow()
    expect(w.balance).toBe(80)
    expect(() => w.spend(10)).not.toThrow()
    expect(w.balance).toBe(70)
    expect(() => w.reset()).not.toThrow()
    expect(w.balance).toBe(0)
    // And the shared path, which is what records.ts calls.
    expect(() => bankRun(run())).not.toThrow()
  })

  it('persists a balance across instances when storage works', () => {
    memoryStorage()
    const a = new Wallet()
    a.bank(run({ at: 42 }))
    a.spend(30)
    const b = new Wallet()
    expect(b.balance).toBe(50)
    expect(b.lifetime).toBe(80)
    // Including the duplicate guard, so a reload mid-ceremony cannot pay twice.
    expect(b.bank(run({ at: 42 })).credits).toBe(0)
  })

  it('carries the recent-circuit ring across a reload', () => {
    memoryStorage()
    const a = new Wallet()
    a.bank(run({ trackId: 'rustfall', at: 1 }))
    a.bank(run({ trackId: 'rustfall', at: 2 }))
    const b = new Wallet()
    expect(b.recent.slice(0, 2)).toEqual(['rustfall', 'rustfall'])
    expect(b.bank(run({ trackId: 'rustfall', at: 3 })).repeat).toBe(REPEAT_DAMP[2])
  })

  it('treats a corrupt or hand-edited wallet as an empty one', () => {
    for (const raw of ['{', 'null', '[]', '{"v":99,"c":9999}', '{"v":1,"c":"lots"}']) {
      memoryStorage({ 'sg.wallet': raw })
      const w = new Wallet()
      expect(Number.isFinite(w.balance)).toBe(true)
      expect(w.balance).toBeGreaterThanOrEqual(0)
    }
    // A NaN balance is the real danger: it survives every comparison and makes
    // everything unaffordable forever, silently.
    memoryStorage({ 'sg.wallet': '{"v":1,"c":null,"e":null}' })
    expect(Number.isNaN(new Wallet().balance)).toBe(false)
  })
})

// ---------------------------------------------------------------------------

describe('the catalogue is well formed', () => {
  it('has a unique id for every avatar', () => {
    const ids = AVATARS.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(AVATAR_BY_ID.size).toBe(AVATARS.length)
  })

  it('puts every portrait at avatars/<id>-<size>.webp and nowhere else', () => {
    // Asserted rather than assumed because the failure is silent: one `avatar/`
    // among twenty-four `avatars/` is a 404 that renders as a blank circle.
    for (const a of AVATARS) {
      expect(a.src, a.id).toBe(`${AVATAR_DIR}${a.id}-512.webp`)
      expect(a.src, a.id).toBe(srcFor(a.id))
      expect(srcFor(a.id, 128), a.id).toBe(`${AVATAR_DIR}${a.id}-128.webp`)
      expect(a.id, a.id).toMatch(/^[a-z][a-z0-9]*$/)
    }
  })

  it('spreads twenty-four avatars across all four sources', () => {
    const by = (kind: string): number => AVATARS.filter((a) => a.source.kind === kind).length
    expect(AVATARS.length).toBe(24)
    expect(by('starter')).toBe(4)
    expect(by('shop')).toBe(10)
    expect(by('rank')).toBe(5)
    expect(by('feat')).toBe(5)
    // The shop is the bulk of it: credits need somewhere to go every session.
    expect(by('shop')).toBeGreaterThan(Math.max(by('starter'), by('rank'), by('feat')))
  })

  it('gives every avatar a real name and a usable accent', () => {
    for (const a of AVATARS) {
      expect(a.name.length, a.id).toBeGreaterThan(2)
      expect(a.name.trim().split(/\s+/).length, a.id).toBeLessThanOrEqual(3)
      expect(a.accent, a.id).toMatch(/^#[0-9a-f]{6}$/)
    }
    expect(new Set(AVATARS.map((a) => a.accent)).size).toBe(AVATARS.length)
  })

  it('prices the shop on the doubling ladder, and states it in races', () => {
    const typical = payout(run({ score: REF_SCORE })).credits
    expect(typical).toBe(80)
    const prices = AVATARS
      .map((a) => (a.source.kind === 'shop' ? a.source.price : 0))
      .filter((p) => p > 0)
    for (const p of prices) expect(Object.values(PRICES)).toContain(p)
    // Three races for the cheapest, fifty for the chase item.
    expect(PRICES.cheap / typical).toBeCloseTo(3.1, 1)
    expect(PRICES.chase / typical).toBe(50)
    // Every tier is twice the last, so the ladder reads the same in credits and
    // in evenings.
    const tiers = [PRICES.cheap, PRICES.low, PRICES.mid, PRICES.high, PRICES.chase]
    for (let i = 1; i < tiers.length; i++) expect(tiers[i]).toBe(tiers[i - 1] * 2)
  })

  it('keeps the whole shop inside a couple of hundred races', () => {
    const total = AVATARS.reduce(
      (n, a) => n + (a.source.kind === 'shop' ? a.source.price : 0), 0)
    expect(total).toBe(10250)
    expect(Math.round(total / 80)).toBeLessThan(200)
  })

  it('orders the picker starter, shop, rank, feat', () => {
    const order = ['starter', 'shop', 'rank', 'feat']
    const seen = AVATARS.map((a) => order.indexOf(a.source.kind))
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1])
    expect(seen[0]).toBe(0)
  })

  it('imports nothing that would stop the server or a test loading it', async () => {
    // The catalogue is read by the picker, by these tests and eventually by the
    // account endpoint. One `window.` in it costs the third reader.
    const fs = await import('node:fs')
    const raw = fs.readFileSync('src/content/avatars.ts', 'utf8')
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    expect(src).not.toMatch(/\b(document|window|navigator|localStorage|fetch)\s*[.[(]/)
    expect(src).not.toMatch(/from\s+''\.\.\/(game|ui|render)\//)
  })
})

describe('the art, and the stand-in for art that has not arrived', () => {
  it('draws the delivered portrait for every avatar that has one', () => {
    const drawn = AVATARS.filter((a) => hasArt(a.id))
    // Twenty-three landed together; if this drops, a file went missing from
    // public/avatars/ and the manifest noticed before a player did.
    expect(drawn.length).toBeGreaterThanOrEqual(23)
    for (const a of drawn) {
      expect(portraitFor(a), a.id).toBe(srcFor(a.id, 512))
      expect(portraitFor(a, 40), a.id).toBe(srcFor(a.id, 128))
    }
  })

  it('picks the smallest file that covers the pixels asked for', () => {
    expect(artSizeFor(1)).toBe(128)
    expect(artSizeFor(128)).toBe(128)
    expect(artSizeFor(129)).toBe(256)
    expect(artSizeFor(186)).toBe(256)    // a 62px tile on a 3x phone
    expect(artSizeFor(312)).toBe(512)    // the 104px profile portrait at 3x
    expect(artSizeFor(5000)).toBe(512)   // never asks for a size that is not there
  })

  it('draws the placeholder for an avatar whose art has not been delivered', () => {
    for (const a of AVATARS.filter((x) => !hasArt(x.id))) {
      expect(portraitFor(a), a.id).toBe(placeholderPortrait(a))
    }
  })

  it('will not sell a face that is not there, and says it is coming', () => {
    const rich = profile({ credits: 999999, earned: 999999 })
    for (const a of AVATARS) {
      if (!artPending(a.id)) continue
      expect(a.source.kind).toBe('shop')
      expect(canBuy(rich, a.id), a.id).toBe(false)
      const view = catalogueFor(rich).all.find((v) => v.def.id === a.id)
      expect(view?.status).toBe('locked')
      expect(view?.requirement).toContain('Arriving soon')
      // An owner keeps it: an unlock is not something a missing file takes.
      const owner = profile({ unlocked: [...STARTER_IDS, a.id] })
      expect(ownsAvatar(owner, a.id)).toBe(true)
      expect(wornAvatar(owner, a.id).id).toBe(a.id)
    }
    // Pending is a shop-only state: a starter, rank or feat face is earned, not
    // bought, so a missing file never stands between a player and it.
    for (const a of AVATARS) {
      if (a.source.kind !== 'shop') expect(artPending(a.id), a.id).toBe(false)
    }
  })

  it('draws a different placeholder mark for every avatar', () => {
    const marks = new Set(AVATARS.map((a) => placeholderPortrait(a)))
    expect(marks.size).toBe(AVATARS.length)
  })

  it('produces a placeholder a browser can put in a src attribute', () => {
    for (const a of AVATARS) {
      const uri = placeholderPortrait(a)
      expect(uri.startsWith('data:image/svg+xml;utf8,')).toBe(true)
      // A raw '#' would truncate the URI at the fragment and leave a blank img.
      expect(uri.indexOf('#')).toBe(-1)
      const svg = decodeURIComponent(uri.slice('data:image/svg+xml;utf8,'.length))
      expect(svg.startsWith('<svg')).toBe(true)
      expect(svg.endsWith('</svg>')).toBe(true)
      expect(svg).toContain('viewBox="0 0 64 64"')
      expect(svg).toContain(a.accent)
    }
  })

  it('is stable for a given avatar, so nothing flickers between renders', () => {
    for (const a of AVATARS) expect(portraitFor(a)).toBe(portraitFor(a))
  })

  it('escapes a name that would otherwise break the SVG', () => {
    const svg = placeholderPortrait({ id: 'x', name: 'A & <B>', accent: '#ffffff' })
    const decoded = decodeURIComponent(svg.slice('data:image/svg+xml;utf8,'.length))
    expect(decoded).toContain('A &amp; &lt;B&gt;')
  })
})

describe('who owns what', () => {
  it('gives every profile the starters, flag or no flag', () => {
    const naked: ProfileLike = { unlocked: [], credits: 0, earned: 0 }
    for (const id of STARTER_IDS) expect(ownsAvatar(naked, id)).toBe(true)
    expect(STARTER_IDS.length).toBe(4)
    expect(STARTER_IDS).toContain(DEFAULT_AVATAR_ID)
    // Nobody ever faces an empty picker.
    expect(catalogueFor(naked).owned.length).toBeGreaterThanOrEqual(4)
  })

  it('fires a rank unlock exactly at its threshold', () => {
    for (const a of AVATARS) {
      if (a.source.kind !== 'rank') continue
      const need = a.source.earned
      expect(ownsAvatar(profile({ earned: need - 1 }), a.id), a.id).toBe(false)
      expect(ownsAvatar(profile({ earned: need }), a.id), a.id).toBe(true)
      expect(ownsAvatar(profile({ earned: need + 1 }), a.id), a.id).toBe(true)
    }
  })

  it('reads lifetime earnings and never the spendable balance', () => {
    // A player who spends down to nothing keeps every rank they earned.
    const rich = profile({ credits: 0, earned: RANKS.apex })
    expect(ranksEarned(rich.earned)).toContain('apexrunner')
    expect(ownsAvatar(rich, 'apexrunner')).toBe(true)
  })

  it('grants the rank ladder in order as earnings climb', () => {
    const ladder = Object.values(RANKS).sort((a, b) => a - b)
    expect(ranksEarned(0)).toEqual([])
    for (let i = 0; i < ladder.length; i++) {
      expect(ranksEarned(ladder[i]).length).toBe(i + 1)
    }
    expect(ranksEarned(Number.MAX_SAFE_INTEGER).length).toBe(ladder.length)
  })

  it('refuses a purchase the balance does not cover, and says how short', () => {
    const p = profile({ credits: PRICES.mid - 1 })
    expect(canBuy(p, 'stormwright')).toBe(false)
    const view = catalogueFor(p).all.find((v) => v.def.id === 'stormwright')
    expect(view?.status).toBe('locked')
    expect(view?.shortBy).toBe(1)
    expect(view?.requirement).toContain('1,000 credits')
    // And the wallet refuses the same thing again on the way out, because a
    // check and a spend that are separate calls can always be separated.
    const w = new Wallet(false)
    w.adopt({ credits: PRICES.mid - 1, earned: PRICES.mid })
    expect(w.spend(priceOf('stormwright'))).toBe(false)
    expect(w.balance).toBe(PRICES.mid - 1)
  })

  it('allows the purchase once the credits are there, and only once', () => {
    const p = profile({ credits: PRICES.mid })
    expect(canBuy(p, 'stormwright')).toBe(true)
    const w = new Wallet(false)
    w.adopt({ credits: PRICES.mid, earned: PRICES.mid })
    expect(w.spend(priceOf('stormwright'))).toBe(true)
    expect(w.balance).toBe(0)
    // The profile the account service hands back then owns it, and the shop row
    // stops offering it.
    const after = profile({ credits: 0, earned: PRICES.mid, unlocked: [...STARTER_IDS, 'stormwright'] })
    expect(canBuy(after, 'stormwright')).toBe(false)
    expect(ownsAvatar(after, 'stormwright')).toBe(true)
  })

  it('will not sell something that is not for sale', () => {
    const rich = profile({ credits: 999999, earned: 999999 })
    for (const a of AVATARS) {
      if (a.source.kind === 'shop') continue
      expect(canBuy(rich, a.id), a.id).toBe(false)
      expect(priceOf(a.id), a.id).toBe(0)
    }
    expect(canBuy(rich, 'nosuchavatar')).toBe(false)
  })

  it('splits the catalogue into owned, buyable and locked with no gaps', () => {
    const p = profile({ credits: PRICES.low, earned: RANKS.pacer })
    const c = catalogueFor(p)
    expect(c.all.length).toBe(AVATARS.length)
    expect(c.owned.length + c.buyable.length + c.locked.length).toBe(AVATARS.length)
    for (const v of c.owned) expect(v.requirement).toBe('')
    for (const v of c.buyable) expect(v.requirement).not.toBe('')
    for (const v of c.locked) expect(v.requirement).not.toBe('')
    // A locked rank row can show how far off it is.
    const far = c.locked.find((v) => v.def.id === 'oldguard')
    expect(far?.progress).toBeGreaterThan(0)
    expect(far?.progress).toBeLessThan(1)
  })

  it('puts a player back in a starter when their choice is not theirs', () => {
    const p = profile()
    expect(wornAvatar(p, 'voidsmith').id).toBe(DEFAULT_AVATAR_ID)
    expect(wornAvatar(p, 'fromanolderbuild').id).toBe(DEFAULT_AVATAR_ID)
    expect(wornAvatar(p, STARTER_IDS[2]).id).toBe(STARTER_IDS[2])
  })
})

// ---------------------------------------------------------------------------
//
// THE FEATS, DRIVEN FROM THINGS THE GAME ACTUALLY PRODUCES.
//
// Each of these builds its evidence from the real sim, the real Scorer or the
// real circuit module rather than from a literal, because the claim being
// tested is not "the predicate works" -- it is "the number the predicate reads
// is a number this game can produce".

/** A racer shaped the way `Scorer` reads one. Mirrors tests/score.test.ts. */
function scorerRacer(): RacerState {
  return {
    id: 0, chassisId: 'solaire', pilotId: '', isLocal: true,
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 10 },
    driftSide: 1, driftTier: 3, driftTime: 0,
    position: 1, lap: 1, finished: false,
  } as unknown as RacerState
}

/** Hold a top-tier slide for `seconds` and return the real scorer's figures. */
function heldSlide(seconds: number): { score: number; bestCombo: number } {
  const s = new Scorer()
  const r = scorerRacer()
  let t = 0
  const step = 1 / 60
  s.frame({ racers: [], phase: 'racing', time: 0, frame: 0, totalLaps: 3 } as unknown as RaceState, r, [])
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    t += step
    r.driftTime += step
    s.frame(
      { racers: [], phase: 'racing', time: t, frame: i, totalLaps: 3 } as unknown as RaceState,
      r, [],
    )
  }
  return { score: s.score, bestCombo: s.bestCombo }
}

/** A finished Grand Circuit in which slot 0 wins every round. */
function wonCircuit(): CircuitState {
  let c = newCircuit('socket', 'solaire')
  for (let round = 0; round < CIRCUIT_ROUNDS; round++) {
    c = applyRound(c, {
      trackId: trackIdForRound(round),
      finishes: c.grid.map((e) => ({
        id: e.id, position: e.id + 1, finished: true, time: 170 + e.id,
      })),
    })
  }
  return c
}

/** The evidence a completed circuit offers, read the way the game would. */
function circuitEvidence(c: CircuitState): RaceFeatEvidence['circuit'] {
  const row = standings(c).find((r) => r.entrant.id === 0)
  const champ = champion(c)
  return {
    won: champ !== null && champ.entrant.id === 0,
    rounds: row?.rounds ?? 0,
    dnf: row?.dnf ?? 0,
  }
}

describe('every feat is reachable from data the game produces', () => {
  it('has a test and a sentence for every feat avatar, and no orphans', () => {
    const featIds = AVATARS.filter((a) => a.source.kind === 'feat').map((a) => a.id)
    expect(FEATS.map((f) => f.id).sort()).toEqual([...featIds].sort())
    for (const a of AVATARS) {
      if (a.source.kind !== 'feat') continue
      const spec = FEATS.find((f) => f.id === a.id)
      // The sentence under the portrait and the sentence the test carries are
      // the same string, not two strings that agree today.
      expect(a.source.how, a.id).toBe(spec?.how)
      expect(a.source.how.length, a.id).toBeGreaterThan(8)
      expect(a.source.how.endsWith('.'), a.id).toBe(true)
    }
  })

  it('agrees with circuit.ts about how many rounds a Grand Circuit has', () => {
    // FEAT_CIRCUIT_ROUNDS is copied rather than imported, because circuit.ts
    // touches localStorage and the catalogue must load on a server.
    expect(FEAT_CIRCUIT_ROUNDS).toBe(CIRCUIT_ROUNDS)
  })

  it('unlocks Flag Bearer from a real race the player won', () => {
    // A real eight-car race on the default circuit, scored by the real Scorer
    // off the real event stream -- the same wiring main.ts uses.
    resetAI()
    const track = new Track(RUSTFALL)
    const race = new Race(track, {
      seed: 1337,
      totalLaps: 3,
      racerCount: CIRCUIT_GRID,
      trackId: RUSTFALL.id,
      chassisIds: Array.from({ length: CIRCUIT_GRID }, (_, i) => CHASSIS[i % CHASSIS.length].id),
      pilotIds: Array.from({ length: CIRCUIT_GRID }, (_, i) => PILOTS[i % PILOTS.length].id),
      localRacerIndex: -1,
      aiSkill: Array.from({ length: CIRCUIT_GRID }, (_, i) => 2 + (i % 3)),
    })
    const idle = emptyInput()
    const scorers = race.state.racers.map(() => new Scorer())
    let frames = 0
    while (frames < 60 * 400 && race.state.phase !== 'finished') {
      for (const r of race.state.racers) if (!r.isAI) race.setInput(r.id, idle)
      race.step()
      frames++
      for (let i = 0; i < race.state.racers.length; i++) {
        const r = race.state.racers[i]
        scorers[i].frame(race.state, r, r.events)
      }
    }
    expect(race.state.phase).toBe('finished')

    const winnerIdx = race.state.racers.findIndex((r) => r.position === 1)
    const winner = race.state.racers[winnerIdx]
    const ev: RaceFeatEvidence = {
      finished: winner.finished,
      position: winner.position,
      score: scorers[winnerIdx].score,
      bestCombo: scorers[winnerIdx].bestCombo,
      circuit: null,
    }
    // Every field exists and is a real number, which is the actual claim.
    expect(ev.finished).toBe(true)
    expect(ev.position).toBe(1)
    expect(Number.isFinite(ev.score)).toBe(true)
    expect(ev.score).toBeGreaterThan(0)
    expect(ev.bestCombo).toBeGreaterThanOrEqual(1)
    expect(featsEarned(ev)).toContain('flagbearer')

    // And a car that finished second does not get it.
    const secondIdx = race.state.racers.findIndex((r) => r.position === 2)
    expect(featsEarned({ ...ev, position: race.state.racers[secondIdx].position }))
      .not.toContain('flagbearer')
  }, 60000)

  it('unlocks Singularity Hand at the combo ceiling the rules actually reach', () => {
    // Driven through the real Scorer: a held top-tier slide, which is the only
    // way the combo climbs. If COMBO_MAX became unreachable this goes red.
    const short = heldSlide(4)
    expect(short.bestCombo).toBeLessThan(COMBO_MAX)
    expect(featsEarned(evidence({ bestCombo: short.bestCombo }))).not.toContain('singularity')

    const long = heldSlide(30)
    expect(long.bestCombo).toBe(COMBO_MAX)
    expect(featsEarned(evidence({ bestCombo: long.bestCombo }))).toContain('singularity')
    // The sentence quotes the same ceiling the test uses.
    expect(AVATAR_BY_ID.get('singularity')?.source).toMatchObject({
      how: expect.stringContaining(String(COMBO_MAX)),
    })
  })

  it('unlocks Half Million at a score the real scorer can reach', () => {
    // 500,000 sits above the ninetieth percentile of 192 measured finishes
    // (452,682) and below the highest seen (848,682) -- hard, not exotic.
    expect(FEAT_SCORE).toBeGreaterThan(452682)
    expect(FEAT_SCORE).toBeLessThan(MEASURED_MAX)
    // And the rate that produces it exists: top tier at the combo ceiling.
    const perSecond = DRIFT_RATE[DRIFT_RATE.length - 1] * COMBO_MAX
    expect(heldSlide(90).score).toBeGreaterThan(FEAT_SCORE)
    expect(perSecond).toBeGreaterThan(0)
    expect(featsEarned(evidence({ score: FEAT_SCORE - 1 }))).not.toContain('halfmillion')
    expect(featsEarned(evidence({ score: FEAT_SCORE }))).toContain('halfmillion')
    // A DNF that scored it is still a DNF.
    expect(featsEarned(evidence({ score: FEAT_SCORE, finished: false })))
      .not.toContain('halfmillion')
  })

  it('unlocks Grand Champion and Iron Run from a real completed circuit', () => {
    const c = wonCircuit()
    expect(isComplete(c)).toBe(true)
    const ev = evidence({ circuit: circuitEvidence(c) })
    expect(ev.circuit?.won).toBe(true)
    expect(ev.circuit?.rounds).toBe(CIRCUIT_ROUNDS)
    expect(ev.circuit?.dnf).toBe(0)
    const got = featsEarned(ev)
    expect(got).toContain('laurel')
    expect(got).toContain('ironrun')
  })

  it('withholds Iron Run from a circuit the player did not see out', () => {
    // standings() counts a round the player retired from, so `rounds` alone
    // would pay for eight starts rather than eight finishes.
    let c = newCircuit('socket', 'solaire')
    for (let round = 0; round < CIRCUIT_ROUNDS; round++) {
      c = applyRound(c, {
        trackId: trackIdForRound(round),
        finishes: c.grid.map((e) => ({
          id: e.id,
          position: e.id + 1,
          finished: !(e.id === 0 && round === 3),
          time: e.id === 0 && round === 3 ? 0 : 170 + e.id,
        })),
      })
    }
    const ev = evidence({ circuit: circuitEvidence(c) })
    expect(ev.circuit?.rounds).toBe(CIRCUIT_ROUNDS)
    expect(ev.circuit?.dnf).toBe(1)
    expect(featsEarned(ev)).not.toContain('ironrun')
  })

  it('earns nothing at all from a race with no circuit and no result', () => {
    expect(featsEarned(evidence({ finished: false, position: 6, score: 0, bestCombo: 1 })))
      .toEqual([])
  })

  it('re-derives the feats a profile can prove on its own', () => {
    // Flags get lost: a failed write, a profile minted offline, a rebuilt
    // account. The ones the counters imply are re-granted on sight.
    expect(featsFromProfile({ races: 40, wins: 0 })).toEqual([])
    expect(featsFromProfile({ races: 40, wins: 1 })).toEqual(['flagbearer'])
    const p = profile({ wins: 3, unlocked: [...STARTER_IDS] })
    expect(ownsAvatar(p, 'flagbearer')).toBe(true)
    // The ones nothing remembers stay locked until the flag says otherwise.
    expect(ownsAvatar(p, 'singularity')).toBe(false)
    expect(ownsAvatar(profile({ unlocked: [...STARTER_IDS, 'singularity'] }), 'singularity'))
      .toBe(true)
  })
})

/** Feat evidence with sane defaults: a finished, unremarkable third place. */
function evidence(over: Partial<RaceFeatEvidence> = {}): RaceFeatEvidence {
  return { finished: true, position: 3, score: 120000, bestCombo: 4, circuit: null, ...over }
}
