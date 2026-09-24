/**
 * THE ACHIEVEMENTS: catalogue, tracker, store and the race-side glue.
 *
 * Four layers, tested at the level each one can be wrong at:
 *
 *   CATALOGUE  content/achievements.ts -- the counts the brief fixes (30 badges,
 *              118 achievements), ids that are unique and real, art for every
 *              badge, circuits and chassis that are the game's own, a module
 *              the account server can load, and Lap Record targets that the
 *              race which set them still beats.
 *   TRACKER    score/tracker.ts -- driven from REAL headless races, never from
 *              hand-made facts: the SINGULARITY count agrees with the scorer's
 *              own tier-3 drift-release awards, every weapon hit is credited to
 *              the car that landed it, nothing is counted after the flag, and
 *              the facts are identical at 60, 120 and 144 Hz.
 *   STORE      score/progress.ts -- union and max from any order, garbage in
 *              storage, preview vs commit, the profile-derived tiers, the sync.
 *   GLUE       game/achievementRun.ts -- chips once, banks once, never creates
 *              an account to sync with; and the circuit and series evidence.
 *
 * The account server's half (`achieve`) is in tests/account.test.ts, with the
 * rest of the server.
 */
import { describe, it, expect } from 'vitest'
import {
  ACH_CIRCUITS, ACHIEVEMENTS, ACHIEVEMENT_BY_ID, BADGES, BADGE_BY_ID, COUNTERS,
  COUNTER_CEILING, DRIFT_KING_RELEASES, FEAT_OF, GLOBAL_BADGES, LAP_TARGETS, MARKS,
  MARK_IRONRUN, STAND_IN_IDS, TRACK_BADGES, asSnapshot, badgeArtFor, badgeSrc, badgeView,
  completion, deriveUnlocks, emptyFacts, emptySnapshot, featsFromUnlocks, hasBadgeArt,
  isClaimable, mergeSnapshots, newsOf, raceClaims, raceCounters, standInBadge, tierId,
  trackAchId, winMark, withDerived,
  type AchievementSnapshot, type RaceFacts,
} from '../src/content/achievements'
import { BADGE_ART } from '../src/content/artManifest'
import { FEATS, FEAT_SCORE } from '../src/content/avatars'
import { CHASSIS } from '../src/content/chassis'
import { TRACKS, TRACKS_BY_ID } from '../src/content/tracks'
import { TUNING as T } from '../src/content/tuning'
import { COMBO_MAX, DRIFT_RELEASE } from '../src/score/rules'
import { Scorer } from '../src/score/scorer'
import { RaceTracker, type RaceContext } from '../src/score/tracker'
import {
  AchievementStore, SYNC_MIN_GAP_MS, type ProgressAccount, type ProgressStorage,
} from '../src/score/progress'
import { ACH_MIN_GAP_MS } from '../src/net/account'
import type { AchievementSync, Result } from '../src/net/types'
import { AchievementRun, circuitEvidence, seriesSweep } from '../src/game/achievementRun'
import {
  CIRCUIT_ROUNDS, applyRound, newCircuit, resultFromRace, trackIdForRound, type CircuitState,
} from '../src/game/circuit'
import { EventCarry } from '../src/game/eventCarry'
import { Race } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { resetAI } from '../src/sim/ai'
import type { RaceState } from '../src/sim/types'
import { fieldConfig } from '../tools/probe-achievements'

const CTX: RaceContext = {
  difficulty: 'normal', multiplayer: false, score: 0, bestCombo: 1, circuit: null, sweep: false,
}

// ===========================================================================
// CATALOGUE
// ===========================================================================

describe('the catalogue', () => {
  it('has thirty badges and a hundred and eighteen achievements, every id unique', () => {
    expect(BADGES).toHaveLength(30)
    expect(ACHIEVEMENTS).toHaveLength(118)
    expect(TRACK_BADGES).toHaveLength(8)
    expect(GLOBAL_BADGES).toHaveLength(22)
    const ids = ACHIEVEMENTS.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(BADGES.map((b) => b.id)).size).toBe(30)
    // No achievement id collides with a mark, and every achievement names a
    // badge that exists.
    for (const m of MARKS) expect(ACHIEVEMENT_BY_ID.has(m)).toBe(false)
    for (const a of ACHIEVEMENTS) expect(BADGE_BY_ID.has(a.badge), a.id).toBe(true)
  })

  it('splits them 64 on the circuits and 54 across the global badges', () => {
    const onTrack = ACHIEVEMENTS.filter((a) => a.trackId !== null)
    expect(onTrack).toHaveLength(64)
    expect(ACHIEVEMENTS.length - onTrack.length).toBe(54)
    for (const b of TRACK_BADGES) {
      for (const c of ACH_CIRCUITS) {
        expect(ACHIEVEMENT_BY_ID.has(trackAchId(b.id, c.id)), `${b.id} on ${c.id}`).toBe(true)
      }
    }
  })

  it('names the circuits the game has, in the order it has them', () => {
    // Copied rather than imported (the account server must not load track
    // geometry), so this is the line that keeps the copy honest.
    expect(ACH_CIRCUITS.map((c) => c.id)).toEqual(TRACKS.map((t) => t.id))
    expect(ACH_CIRCUITS.map((c) => c.name)).toEqual(TRACKS.map((t) => t.name))
    for (const c of ACH_CIRCUITS) {
      expect(c.glow, c.id).toMatch(/^#[0-9a-f]{6}$/)
      expect(c.ground, c.id).toMatch(/^#[0-9a-f]{6}$/)
      expect(c.glow, c.id).not.toBe(c.ground)
    }
    expect(Object.keys(LAP_TARGETS).sort()).toEqual(TRACKS.map((t) => t.id).sort())
  })

  it('marks a win in every chassis the game has, and only those', () => {
    const wins = MARKS.filter((m) => m !== MARK_IRONRUN)
    expect(wins.sort()).toEqual(CHASSIS.map((c) => winMark(c.id)).sort())
  })

  it('has art for every badge: the delivered file, or a stand-in until it lands', () => {
    for (const b of BADGES) {
      const drawn = hasBadgeArt(b.id)
      expect(drawn || STAND_IN_IDS.includes(b.id), b.id).toBe(true)
      if (drawn) {
        expect(BADGE_ART).toContain(b.id)
        expect(badgeArtFor(b.id, 40)).toBe(badgeSrc(b.id, 128))
        expect(badgeArtFor(b.id, 64 * 3)).toBe(badgeSrc(b.id, 256))
        expect(badgeArtFor(b.id, 132 * 3)).toBe(badgeSrc(b.id, 512))
      } else {
        // A clean emblem as a data URI, so a file dropped in later replaces it
        // with no code change -- the placeholderPortrait arrangement.
        const src = badgeArtFor(b.id, 64)
        expect(src.startsWith('data:image/svg+xml;utf8,'), b.id).toBe(true)
        expect(decodeURIComponent(src)).toContain('<svg')
      }
    }
    // The eight the brief says are still missing, exactly.
    expect([...STAND_IN_IDS].sort()).toEqual([
      'airtime', 'clean-sweep', 'collector', 'combo-king', 'high-roller',
      'online-victor', 'photo-finish', 'tycoon',
    ])
    expect(BADGE_ART).toHaveLength(22)
    // And a stand-in is never a broken image even for an id nobody drew.
    expect(standInBadge('nope').startsWith('data:image/svg+xml')).toBe(true)
  })

  it('says SINGULARITY wherever Legendary Drifts and Drift King are described', () => {
    const legend = BADGE_BY_ID.get('legendary-drifts')
    expect(legend?.how).toMatch(/SINGULARITY, the top tier/)
    for (let t = 1; t <= 4; t++) {
      expect(ACHIEVEMENT_BY_ID.get(tierId('legendary-drifts', t))?.how).toMatch(/SINGULARITY/)
    }
    // Complete, the sentence still says what the number is OF.
    const done = badgeView(legend!, { unlocked: [], counters: { singularity: 5000 } })
    expect(done.complete).toBe(true)
    expect(done.how).toMatch(/SINGULARITY/)
    expect(ACHIEVEMENT_BY_ID.get(trackAchId('track-driftking', 'rustfall'))?.how)
      .toMatch(new RegExp(`${DRIFT_KING_RELEASES} .*SINGULARITY`))
  })

  it('ties the five feat portraits to the achievements the brief names', () => {
    expect(FEAT_OF).toEqual({
      'wins:1': 'flagbearer', 'combo-king': 'singularity', 'high-roller': 'halfmillion',
      'grand-champion': 'laurel', 'mark:ironrun': 'ironrun',
    })
    // Every feat avatars.ts defines is reachable from one of them.
    expect(Object.values(FEAT_OF).sort()).toEqual(FEATS.map((f) => f.id).sort())
    expect(featsFromUnlocks(['combo-king', 'track-victory:rustfall', 'mark:ironrun']).sort())
      .toEqual(['ironrun', 'singularity'])
  })

  it('lets a client claim evidence and marks, never a tier or a derived badge', () => {
    expect(isClaimable('track-cleanlap:rustfall')).toBe(true)
    expect(isClaimable('frontrunner:expert')).toBe(true)
    expect(isClaimable('combo-king')).toBe(true)
    expect(isClaimable('mark:win:solaire')).toBe(true)
    expect(isClaimable('knockouts:3')).toBe(false)
    expect(isClaimable('tycoon:1')).toBe(false)
    expect(isClaimable('world-tour')).toBe(false)
    expect(isClaimable('mark:nonsense')).toBe(false)
  })

  it('says a burst of tiers of one badge as its highest', () => {
    expect(newsOf(['finishes:1', 'tycoon:1', 'tycoon:2', 'collector:1', 'nope']))
      .toEqual(['finishes:1', 'tycoon:2', 'collector:1'])
    expect(newsOf(['track-victory:rustfall', 'track-victory:halcyon']))
      .toEqual(['track-victory:rustfall', 'track-victory:halcyon'])
  })

  it('is pure: nothing a server or a test could not load', async () => {
    const fs = await import('node:fs')
    for (const file of ['src/content/achievements.ts', 'src/score/tracker.ts']) {
      const raw = fs.readFileSync(file, 'utf8')
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])
      for (const spec of imports) {
        expect(spec, `${file} imports ${spec}`).not.toMatch(/\/(game|ui|render|net|audio)\//)
        expect(spec, `${file} imports ${spec}`).not.toMatch(/\/tracks|sim\/track/)
      }
      const bare = code.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/`(?:[^`\\]|\\.)*`/g, '``')
      expect(bare, file).not.toMatch(/\b(document|window|navigator|localStorage|fetch)\s*[.[(]/)
    }
  })
})

// ===========================================================================
// LAP RECORD TARGETS
// ===========================================================================

/**
 * The race that set each target, replayed. If a track is rebuilt this fails,
 * and the fix is to re-measure (`npx tsx tools/probe-achievements.ts --laps`)
 * and copy the new table into content/achievements.ts -- never to edit a
 * target by hand until the test passes.
 */
const RECORD_SEEDS: Record<string, number> = {
  rustfall: 7, cryostatic: 8, aetherion: 2, hollowchoir: 1,
  emberfall: 1, abyssal: 1, halcyon: 1, neonspire: 1,
}

function fastestLap(trackId: string, diff: 'expert' | 'normal', seed: number): number {
  resetAI()
  const def = TRACKS_BY_ID[trackId]
  const race = new Race(new Track(def), fieldConfig(def, diff, seed))
  let f = 0
  while (f < 60 * 420 && race.state.phase !== 'finished') { race.step(); f++ }
  let best = Infinity
  for (const r of race.state.racers) if (r.bestLap > 0) best = Math.min(best, r.bestLap)
  return best
}

describe('the Lap Record targets', () => {
  it('are beaten by the Expert lap that set them, and by no more than a tenth', () => {
    for (const c of ACH_CIRCUITS) {
      const lap = fastestLap(c.id, 'expert', RECORD_SEEDS[c.id])
      const target = LAP_TARGETS[c.id]
      expect(lap, `${c.name}: the record lap no longer beats ${target}; re-measure`).toBeLessThan(target)
      expect(target - lap, `${c.name}: ${target} is more than a tenth above ${lap}`).toBeLessThanOrEqual(0.1 + 1e-9)
    }
  }, 240_000)

  it('are out of reach of a Normal field, so the badge means something', () => {
    for (const c of ACH_CIRCUITS) {
      const lap = fastestLap(c.id, 'normal', 1)
      expect(lap, `${c.name}: a Normal field lapped ${lap} under ${LAP_TARGETS[c.id]}`)
        .toBeGreaterThan(LAP_TARGETS[c.id])
    }
  }, 240_000)
})

// ===========================================================================
// THE TRACKER, FROM REAL RACES
// ===========================================================================

interface Observed {
  st: RaceState
  facts: RaceFacts[]
  /** Facts at the 90-second mark, before anyone can have finished. */
  early: RaceFacts[]
  /** Scorer's tier-3 driftRelease awards per racer, over the same 90 s. */
  scorerSingularity: number[]
  /** Raw `hit` events naming each racer as attacker, over the same 90 s. */
  rawHits: number[]
  /** Each racer's facts at the step it finished, for the "nothing after" test. */
  atFlag: (RaceFacts | null)[]
}

let observed: Observed | null = null

/**
 * One real Normal race on Elkarim with a tracker and a scorer on every car,
 * stepped the way main.ts steps it -- the victory lap included, because that
 * is the pass whose events the tracker must NOT count.
 */
function observe(): Observed {
  if (observed) return observed
  resetAI()
  const def = TRACKS_BY_ID.rustfall
  const race = new Race(new Track(def), fieldConfig(def, 'normal', 1))
  const st = race.state
  const n = st.racers.length
  const trackers = st.racers.map((r) => { const t = new RaceTracker(); t.begin(r.id, def.id); return t })
  const scorers = st.racers.map(() => new Scorer())
  const scorerSingularity = new Array<number>(n).fill(0)
  const rawHits = new Array<number>(n).fill(0)
  const atFlag: (RaceFacts | null)[] = new Array(n).fill(null)
  let early: RaceFacts[] = []
  let frames = 0
  while (frames < 60 * 420 && st.phase !== 'finished') {
    // THE WINDOW CLOSES BETWEEN STEPS, so the trackers' facts and the raw
    // tallies below cover exactly the same steps. Nobody finishes a three-lap
    // race in 90 s, which is what makes the comparison exact rather than
    // "close": no flag, so no liveness edge for either side to disagree on.
    if (early.length === 0 && st.time >= 90) {
      expect(st.finishOrder.length).toBe(0)
      early = trackers.map((t) => t.facts(st, CTX))
    }
    const inWindow = early.length === 0
    race.step()
    if (st.finishOrder.length > 0) race.stepCeremony()
    frames++
    for (const t of trackers) t.step(st)
    for (let i = 0; i < n; i++) {
      const r = st.racers[i]
      const out = scorers[i].frame(st, r, r.events)
      if (inWindow) {
        for (const a of out.awards) if (a.kind === 'driftRelease' && a.base === DRIFT_RELEASE[3]) scorerSingularity[i]++
        for (const e of r.events) if (e.t === 'hit' && e.by >= 0 && e.by !== r.id) rawHits[e.by]++
      }
      if (r.finished && atFlag[i] === null) atFlag[i] = trackers[i].facts(st, CTX)
    }
  }
  const facts = trackers.map((t, i) => t.facts(st, {
    ...CTX, score: scorers[i].score, bestCombo: scorers[i].bestCombo,
  }))
  observed = { st, facts, early, scorerSingularity, rawHits, atFlag }
  return observed
}

describe('the tracker, from a real race', () => {
  it('counts exactly the SINGULARITY releases the scorer paid SINGULARITY money for', () => {
    const o = observe()
    const tracked = o.early.map((f) => f.singularity)
    // The premise: there were some. A field that released none would make
    // this pass for the wrong reason.
    expect(o.scorerSingularity.reduce((s, x) => s + x, 0)).toBeGreaterThan(0)
    expect(tracked).toEqual(o.scorerSingularity)
  }, 120_000)

  it('credits every weapon hit to the car that landed it', () => {
    const o = observe()
    expect(o.rawHits.reduce((s, x) => s + x, 0)).toBeGreaterThan(0)
    expect(o.early.map((f) => f.weaponHits)).toEqual(o.rawHits)
    // A knockout is a hit that was not a gravity well's slow: never more.
    for (const f of o.early) expect(f.knockouts).toBeLessThanOrEqual(f.weaponHits)
  }, 120_000)

  it('sees every lap, a position, and a margin only for the winner', () => {
    const o = observe()
    for (let i = 0; i < o.facts.length; i++) {
      const f = o.facts[i]
      const r = o.st.racers[i]
      expect(f.finished).toBe(r.finished)
      expect(f.position).toBe(r.position)
      expect(f.lapTimes).toEqual(r.lapTimes)
      if (r.finished) {
        expect(f.lapsSeen).toBe(o.st.totalLaps)
        expect(f.lap1Position).toBeGreaterThan(0)
      }
      if (r.position === 1 && r.finished) {
        const p2 = o.st.racers.find((x) => x.position === 2)!
        expect(f.winMargin).toBeCloseTo(p2.finishTime - r.finishTime, 9)
        expect(f.winMargin).toBeGreaterThan(0)
      } else {
        expect(f.winMargin).toBe(Number.POSITIVE_INFINITY)
      }
      expect(f.cleanLaps).toBeLessThanOrEqual(f.lapsSeen)
      expect(f.airtimeMs).toBeGreaterThanOrEqual(0)
    }
    // Airtime is a real signal on Elkarim, not a zero everywhere.
    expect(o.facts.some((f) => f.airtimeMs > 0)).toBe(true)
  }, 120_000)

  it('counts nothing after a racer\'s own flag: the victory lap is not theirs', () => {
    const o = observe()
    let checked = 0
    for (let i = 0; i < o.facts.length; i++) {
      const at = o.atFlag[i]
      if (!at) continue
      checked++
      const f = o.facts[i]
      for (const k of ['singularity', 'knockouts', 'weaponHits', 'hitsTaken', 'cleanLaps', 'lapsSeen', 'airtimeMs'] as const) {
        expect(f[k], `racer ${i} ${k}`).toBe(at[k])
      }
      expect(f.dirtyRace).toBe(at.dirtyRace)
      expect(f.ranLast).toBe(at.ranLast)
    }
    expect(checked).toBeGreaterThan(0)
  }, 120_000)

  it('keeps every per-race count inside the ceiling the server bounds a post by', () => {
    const o = observe()
    for (const f of o.facts) {
      const c = raceCounters(f)
      for (const k of COUNTERS) expect(c[k] ?? 0, k).toBeLessThanOrEqual(COUNTER_CEILING[k])
    }
  }, 120_000)
})

/** One race's first `seconds`, rendered at `hz` through main.ts's loop. */
function renderAt(hz: number, seconds: number): { facts: string; idle: number; frames: number } {
  resetAI()
  const def = TRACKS_BY_ID.rustfall
  const race = new Race(new Track(def), fieldConfig(def, 'normal', 2))
  const st = race.state
  const carry = new EventCarry()
  const trackers = st.racers.map((r) => { const t = new RaceTracker(); t.begin(r.id, def.id); return t })
  const DT = T.sim.dt
  const MAX = T.sim.maxSubSteps
  let acc = 0
  let idle = 0
  let frames = 0
  while (st.time < seconds) {
    acc += 1 / hz
    let steps = 0
    while (acc >= DT && steps < MAX) {
      race.step()
      if (st.finishOrder.length > 0) race.stepCeremony()
      carry.collect(st.racers)
      // THE HOOK UNDER TEST, where main.ts has it: after collect, per step.
      for (const t of trackers) t.step(st)
      acc -= DT
      steps++
    }
    carry.publish(st.racers, steps)
    if (steps === MAX) acc = 0
    if (steps === 0) idle++
    frames++
  }
  return { facts: JSON.stringify(trackers.map((t) => t.facts(st, CTX))), idle, frames }
}

describe('display-rate independence', () => {
  it('reads the same race identically at 60, 120 and 144 Hz', () => {
    const a = renderAt(60, 70)
    const b = renderAt(120, 70)
    const c = renderAt(144, 70)
    // The premise, as tests/eventCarry.test.ts states it: the fast screens
    // really did render frames that ran no step.
    expect(a.idle).toBe(0)
    expect(b.idle).toBeGreaterThan(b.frames * 0.4)
    expect(c.idle).toBeGreaterThan(c.frames * 0.5)
    expect(b.facts).toBe(a.facts)
    expect(c.facts).toBe(a.facts)
    // And something was actually read.
    expect(a.facts).toMatch(/"lapsSeen":1/)
  }, 120_000)
})

// ===========================================================================
// CLAIMS AND COUNTERS
// ===========================================================================

const won = (over: Partial<RaceFacts> = {}): RaceFacts => ({
  ...emptyFacts('rustfall', 'solaire'),
  finished: true, position: 1, laps: 3, lapsSeen: 3, winMargin: 1.2,
  lapTimes: [52.1, 49.3, 49.0], ...over,
})

describe('what a race claims', () => {
  it('withholds every result-gated claim from a race that did not finish', () => {
    const quit = won({ finished: false })
    const claims = raceClaims(quit)
    for (const id of claims) {
      expect(id).not.toMatch(/track-victory|frontrunner|track-summit|comeback|photo|untouchable|iron-will|mark:win/)
    }
    expect(raceCounters(quit).wins).toBe(0)
    expect(raceCounters(quit).finishes).toBe(0)
  })

  it('counts what happened in a quit, and claims what needs no result', () => {
    const quit = won({ finished: false, singularity: 4, knockouts: 3, cleanLaps: 1, bestCombo: COMBO_MAX })
    const claims = raceClaims(quit)
    expect(claims).toContain('track-driftking:rustfall')
    expect(claims).toContain('track-wrecking:rustfall')
    expect(claims).toContain('track-cleanlap:rustfall')
    expect(claims).toContain('combo-king')
    expect(raceCounters(quit).singularity).toBe(4)
  })

  it('grants the win family for a win, on the difficulty it was run at', () => {
    const claims = raceClaims(won({ difficulty: 'expert', chassisId: 'bulwark' }))
    expect(claims).toContain('track-victory:rustfall')
    expect(claims).toContain('track-summit:rustfall')
    expect(claims).toContain('frontrunner:expert')
    expect(claims).toContain(winMark('bulwark'))
    expect(claims).toContain('untouchable')
    expect(raceClaims(won({ difficulty: 'easy' }))).toContain('frontrunner:easy')
    expect(raceClaims(won({ difficulty: 'easy' }))).not.toContain('track-summit:rustfall')
  })

  it('needs every lap clean and a win for a Perfect Race, and no resync', () => {
    expect(raceClaims(won({ cleanLaps: 3 }))).toContain('track-perfect:rustfall')
    expect(raceClaims(won({ cleanLaps: 2 }))).not.toContain('track-perfect:rustfall')
    expect(raceClaims(won({ cleanLaps: 3, dirtyRace: true }))).not.toContain('track-perfect:rustfall')
    expect(raceClaims(won({ cleanLaps: 3, partial: true }))).not.toContain('track-perfect:rustfall')
  })

  it('withholds what an absence proves when part of the race was replayed unseen', () => {
    const partial = won({ cleanLaps: 1, hitsTaken: 0, partial: true, perfectLaunch: true, lap1Position: 1 })
    const claims = raceClaims(partial)
    expect(claims).not.toContain('track-cleanlap:rustfall')
    expect(claims).not.toContain('untouchable')
    expect(claims).not.toContain('track-holeshot:rustfall')
    // Positive evidence still counts.
    expect(claims).toContain('track-victory:rustfall')
  })

  it('beats a Lap Record strictly under the target, on any lap', () => {
    const t = LAP_TARGETS.rustfall
    expect(raceClaims(won({ finished: false, lapTimes: [60, t - 0.01] }))).toContain('track-laprecord:rustfall')
    expect(raceClaims(won({ lapTimes: [t, t + 1] }))).not.toContain('track-laprecord:rustfall')
  })

  it('reads Comeback, Photo Finish and Iron Will off the facts the brief names', () => {
    expect(raceClaims(won({ ranLast: true }))).toContain('comeback')
    expect(raceClaims(won({ winMargin: 0.08 }))).toContain('photo-finish')
    expect(raceClaims(won({ winMargin: 0.1 }))).not.toContain('photo-finish')
    expect(raceClaims(won({ position: 6, hitsTaken: 5 }))).toContain('iron-will')
    expect(raceClaims(won({ position: 6, hitsTaken: 4 }))).not.toContain('iron-will')
  })

  it('grants the evidence feats through avatars.ts\'s own predicates', () => {
    expect(raceClaims(won({ bestCombo: COMBO_MAX }))).toContain('combo-king')
    expect(raceClaims(won({ score: FEAT_SCORE }))).toContain('high-roller')
    expect(raceClaims(won({ finished: false, score: FEAT_SCORE }))).not.toContain('high-roller')
    const champ = won({ circuit: { won: true, rounds: 8, dnf: 0 } })
    expect(raceClaims(champ)).toContain('grand-champion')
    expect(raceClaims(champ)).toContain(MARK_IRONRUN)
    const dnf = won({ circuit: { won: false, rounds: 8, dnf: 1 } })
    expect(raceClaims(dnf)).not.toContain(MARK_IRONRUN)
    expect(raceClaims(dnf)).not.toContain('grand-champion')
    expect(raceClaims(won({ sweep: true }))).toContain('clean-sweep')
  })

  it('counts a multiplayer win only with another person on the grid', () => {
    expect(raceCounters(won({ multiplayer: true })).online).toBe(1)
    expect(raceCounters(won({ multiplayer: false })).online).toBe(0)
  })
})

describe('what the numbers imply', () => {
  it('derives tiers from counters, and the three set-of-others singles', () => {
    const s: AchievementSnapshot = {
      unlocked: [
        ...ACH_CIRCUITS.map((c) => trackAchId('track-victory', c.id)),
        ...CHASSIS.map((c) => winMark(c.id)),
      ],
      counters: { knockouts: 120, airtime: 61_000 },
    }
    const d = deriveUnlocks(s)
    expect(d).toContain('knockouts:1')
    expect(d).toContain('knockouts:2')
    expect(d).not.toContain('knockouts:3')
    // Airtime is stored in ms and promised in seconds.
    expect(d).toContain('airtime:1')
    expect(deriveUnlocks({ unlocked: [], counters: { airtime: 59_999 } })).not.toContain('airtime:1')
    expect(d).toContain('world-tour')
    expect(d).toContain('full-garage')
    expect(d).not.toContain('perfectionist')
  })

  it('reads Tycoon off lifetime credits and Collector off portraits owned', () => {
    const p = { unlocked: [], earned: 62_000, credits: 10, races: 47, wins: 12 }
    const d = withDerived(emptySnapshot(), p).unlocked
    expect(d).toContain('tycoon:2')
    expect(d).not.toContain('tycoon:3')
    // The account's own wins and races are floors under the counters.
    expect(d).toContain('wins:2')
    expect(d).toContain('finishes:1')
    expect(d.some((id) => id.startsWith('collector:'))).toBe(true)
  })

  it('counts completion for the wall and for one circuit', () => {
    const s = { unlocked: ['track-victory:rustfall', 'track-cleanlap:rustfall', 'comeback'], counters: {} }
    expect(completion(s)).toEqual({ earned: 3, total: 118 })
    expect(completion(s, 'rustfall')).toEqual({ earned: 2, total: 8 })
    expect(completion(s, 'halcyon')).toEqual({ earned: 0, total: 8 })
  })
})

// ===========================================================================
// THE STORE
// ===========================================================================

function memStorage(seed?: string): ProgressStorage & { map: Map<string, string> } {
  const map = new Map<string, string>()
  if (seed !== undefined) map.set('sg.achievements', seed)
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v) } }
}

describe('the store', () => {
  it('merges by union and max, in either order, and never goes down', () => {
    const a = { unlocked: ['comeback', 'track-victory:rustfall'], counters: { knockouts: 40, wins: 3 } }
    const b = { unlocked: ['track-victory:rustfall', 'iron-will'], counters: { knockouts: 12, hits: 70 } }
    const ab = mergeSnapshots(a, b)
    const ba = mergeSnapshots(b, a)
    expect([...ab.unlocked].sort()).toEqual([...ba.unlocked].sort())
    expect(ab.counters).toEqual(ba.counters)
    expect(ab.counters).toEqual({ knockouts: 40, wins: 3, hits: 70 })
    // Idempotent: merging the result again changes nothing.
    expect(mergeSnapshots(ab, b)).toEqual(ab)
  })

  it('survives any garbage in storage, keeping what it can read', () => {
    for (const junk of ['{', 'null', '42', '"x"', '[]', '{"v":1,"u":"no","c":7}', '{"v":99,"u":["comeback"]}']) {
      const s = new AchievementStore(memStorage(junk))
      expect(s.snapshot.unlocked, junk).toEqual([])
    }
    const mixed = JSON.stringify({
      v: 1, d: true,
      u: ['comeback', 'retired-badge', 42, 'comeback', 'mark:win:solaire'],
      c: { knockouts: 12.7, hits: -5, airtime: 'lots', nonsense: 9, wins: 1e99 },
    })
    const s = new AchievementStore(memStorage(mixed))
    expect(s.snapshot.unlocked).toEqual(['comeback', 'mark:win:solaire'])
    expect(s.counter('knockouts')).toBe(12)
    expect(s.counter('hits')).toBe(0)
    expect(s.counter('airtime')).toBe(0)
    expect(s.counter('wins')).toBeLessThanOrEqual(1_000_000_000)
    expect(s.unsynced).toBe(true)
    // And an asSnapshot on a hostile object says how much it dropped.
    expect(asSnapshot({ unlocked: ['comeback', 'x', 'y'], counters: {} }).dropped).toBe(2)
  })

  it('never throws when storage itself throws', () => {
    const hostile: ProgressStorage = {
      getItem: () => { throw new Error('SecurityError') },
      setItem: () => { throw new Error('QuotaExceededError') },
    }
    const s = new AchievementStore(hostile)
    expect(s.commitRace(won())).toContain('track-victory:rustfall')
  })

  it('previews without banking, and banks a race exactly once per commit', () => {
    const storage = memStorage()
    const s = new AchievementStore(storage)
    const f = won({ singularity: 3 })
    const preview = s.preview(f)
    expect(preview).toContain('track-driftking:rustfall')
    expect(s.has('track-driftking:rustfall')).toBe(false)
    expect(s.counter('singularity')).toBe(0)
    const banked = s.commitRace(f)
    expect(banked).toEqual(preview)
    expect(s.counter('singularity')).toBe(3)
    // Survives a reload.
    const again = new AchievementStore(storage)
    expect(again.has('track-driftking:rustfall')).toBe(true)
    expect(again.counter('singularity')).toBe(3)
    // A second race adds to the counter and unlocks nothing new.
    expect(s.commitRace(won({ singularity: 3 }))).not.toContain('track-driftking:rustfall')
    expect(s.counter('singularity')).toBe(6)
  })

  it('reports marks as progress, never as news', () => {
    const s = new AchievementStore(null)
    const ids = s.commitRace(won({ chassisId: 'bulwark' }))
    expect(ids.some((id) => id.startsWith('mark:'))).toBe(false)
    expect(s.has(winMark('bulwark'))).toBe(true)
  })

  it('announces what a profile implies, once', () => {
    const s = new AchievementStore(null)
    const heard: string[][] = []
    s.onUnlock = (ids) => heard.push(ids)
    // 12,000 lifetime credits crosses Tycoon bronze; seven portraits owned is
    // one short of Collector bronze, so nothing else arrives with it.
    s.observeProfile({ unlocked: [], earned: 12_000, credits: 0, races: 3, wins: 0 })
    expect(heard).toEqual([['tycoon:1']])
    s.observeProfile({ unlocked: [], earned: 12_000, credits: 0, races: 3, wins: 0 })
    expect(heard).toHaveLength(1)
  })

  it('merges another device\'s wall and announces what it brought', () => {
    const s = new AchievementStore(null)
    s.commitRace(won())
    const heard: string[][] = []
    s.onUnlock = (ids) => heard.push(ids)
    const fresh = s.merge({ unlocked: ['comeback', 'track-victory:rustfall'], counters: { knockouts: 25 } })
    expect(fresh).toEqual(expect.arrayContaining(['comeback', 'knockouts:1']))
    expect(heard).toHaveLength(1)
    expect(s.has('track-victory:rustfall')).toBe(true)
  })

  it('paces its sync the way the server paces it, and keeps a race banked mid-flight dirty', async () => {
    expect(SYNC_MIN_GAP_MS).toBe(ACH_MIN_GAP_MS)
    const s = new AchievementStore(null)
    s.commitRace(won())
    let calls = 0
    let release: () => void = () => {}
    const account: ProgressAccount = {
      syncAchievements: async (progress): Promise<Result<AchievementSync>> => {
        calls++
        await new Promise<void>((r) => { release = r })
        return {
          ok: true,
          value: {
            profile: { id: 'a', name: 'Probe', avatarId: 'x', unlocked: [], credits: 0, earned: 0, races: 1, wins: 1 },
            progress,
          },
        }
      },
    }
    const t0 = 1_000_000
    const first = s.syncWith(account, t0)
    // A race lands while the post is in flight.
    s.commitRace(won({ trackId: 'halcyon' }))
    release()
    const r1 = await first
    expect(r1.ok).toBe(true)
    expect(s.unsynced).toBe(true)
    // Inside the gap: held, not sent.
    expect((await s.syncWith(account, t0 + 1_000)).reason).toBe('pace')
    expect(calls).toBe(1)
    expect(s.syncWaitMs(t0 + 1_000)).toBe(SYNC_MIN_GAP_MS - 1_000)
    const second = s.syncWith(account, t0 + SYNC_MIN_GAP_MS)
    release()
    expect((await second).ok).toBe(true)
    expect(calls).toBe(2)
    expect(s.unsynced).toBe(false)
  })

  it('stays dirty through a failed sync, which is what the next attempt reads', async () => {
    const s = new AchievementStore(null)
    s.commitRace(won())
    const r = await s.syncWith({ syncAchievements: async () => ({ ok: false, error: 'offline' }) })
    expect(r).toEqual({ ok: false, reason: 'offline', unlocked: [] })
    expect(s.unsynced).toBe(true)
  })
})

// ===========================================================================
// THE GLUE
// ===========================================================================

describe('the race-side glue', () => {
  it('chips a mid-race unlock once, banks it at the flag, and toasts only the rest', () => {
    const store = new AchievementStore(null)
    const chips: string[][] = []
    const toasts: string[][] = []
    const run = new AchievementRun({
      store, account: () => null,
      news: { chip: (ids) => chips.push([...ids]), show: (ids) => toasts.push([...ids]) },
    })
    // A real race, the player's car driven by the AI (as the probes do it),
    // hooked exactly where main.ts hooks it.
    resetAI()
    const def = TRACKS_BY_ID.rustfall
    const cfg = fieldConfig(def, 'normal', 1)
    cfg.localRacerIndex = 0
    const race = new Race(new Track(def), cfg)
    const st = race.state
    st.racers[0].isAI = true
    run.begin(0, def.id)
    // Crossing a lifetime threshold mid-race is what the chip is for: seed the
    // store one perfect launch short of Rocket Start bronze and one second of
    // air short of Airtime bronze. Either crossing must raise a chip, once.
    store.merge({ unlocked: [], counters: { launches: 9, airtime: 59_000 } })
    let frames = 0
    while (frames < 60 * 420 && !st.racers[0].finished) {
      race.step()
      frames++
      run.step(st)
      run.frame(st, 1, () => CTX)
    }
    expect(st.racers[0].finished).toBe(true)
    // Each chip is announced once, however many frames the preview ran on.
    const chipped = chips.flat()
    expect(new Set(chipped).size).toBe(chipped.length)
    expect(chipped.length).toBeGreaterThan(0)
    const ids = run.commit(st, CTX)
    expect(run.tracking).toBe(false)
    // What the chip said mid-race is still on the strip -- the record -- ...
    for (const id of chipped) expect(ids, id).toContain(id)
    // ...but the toast only says what the chip did not.
    run.announce(ids)
    for (const id of toasts.flat()) expect(chipped).not.toContain(id)
    // A second commit of the same race banks nothing.
    expect(run.commit(st, CTX)).toEqual([])
  }, 120_000)

  it('never creates an account to sync with, and syncs when one exists', async () => {
    const store = new AchievementStore(null)
    let asked = 0
    const none = new AchievementRun({ store, account: () => { asked++; return null } })
    none.sync()
    expect(asked).toBe(1)
    store.commitRace(won())
    let posted = 0
    const timers: { fn: () => void; ms: number }[] = []
    const some = new AchievementRun({
      store,
      account: () => ({
        syncAchievements: async () => { posted++; return { ok: false, error: 'pace' } },
      }),
      setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
      clearTimer: () => {},
    })
    some.sync()
    await new Promise((r) => setTimeout(r, 0))
    expect(posted).toBe(1)
    // A server 'pace' (the store's own gap did not trip: it only records
    // SUCCESSFUL syncs) is retried once the gap has passed, not dropped.
    expect(timers).toHaveLength(1)
    expect(timers[0].ms).toBeGreaterThan(0)
  })

  it('reads a Grand Circuit\'s outcome off its own table', () => {
    let c: CircuitState = newCircuit('socket', 'solaire')
    for (let round = 0; round < CIRCUIT_ROUNDS; round++) {
      c = applyRound(c, resultFromRace(trackIdForRound(round), c.grid.map((e) => ({
        id: e.id, position: e.id + 1, finished: true, finishTime: 100 + e.id,
      }))))
    }
    expect(circuitEvidence(c)).toEqual({ circuit: { won: true, rounds: 8, dnf: 0 }, sweep: true })
    // Second place in every round: no title, no sweep, still Iron Run's rounds.
    const e1 = circuitEvidence(c, 1)
    expect(e1?.circuit.won).toBe(false)
    expect(e1?.sweep).toBe(false)
    expect(circuitEvidence(newCircuit('socket', 'solaire'))).toBeNull()
  })

  it('calls a lobby series a sweep only on its last round, three rounds or longer', () => {
    const me = (finishes: number[]) => [{
      playerId: 'p1', name: 'Me', avatarId: null, points: 45, finishes, isLocal: true,
    }]
    expect(seriesSweep(me([1, 1, 1]), 2, 3)).toBe(true)
    expect(seriesSweep(me([1, 1, 2]), 2, 3)).toBe(false)
    expect(seriesSweep(me([1, 1]), 1, 3)).toBe(false)
    expect(seriesSweep(me([1]), 0, 1)).toBe(false)
    expect(seriesSweep(me([1, 0, 1]), 2, 3)).toBe(false)
  })
})
