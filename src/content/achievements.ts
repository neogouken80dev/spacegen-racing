/**
 * SpaceGen Racing — THE ACHIEVEMENT CATALOGUE.
 * ---------------------------------------------------------------------------
 * Thirty badges, 118 achievements, and the arithmetic that decides which of
 * them a race, a profile or an account has earned. Pure data and pure
 * functions: no DOM, no fetch, no storage, no imports from `src/game`,
 * `src/ui` or `src/render`.
 *
 * THE SAME PURITY RULE avatars.ts states, FOR THE SAME THREE READERS. The
 * achievement screens in the browser, the unit tests in Node, and the account
 * endpoint -- which has to decide whether a posted id is real, how far a
 * posted counter may move, and which feat portrait a synced achievement
 * grants -- all import this one module, so the three cannot disagree about
 * what an id means. tests/achievements.test.ts holds the file to it the way
 * tests/wallet.test.ts holds avatars.ts.
 *
 * The spec is §5-§6 of the badge art brief
 * (claude/spacegen-racing-avatar-and-badge-art-brief.md). Where this file
 * decides something the brief left open, the decision is written down beside
 * the code that makes it -- see DEFINITIONS below, which is the list a
 * player-facing sentence has to stay true to.
 *
 * ===========================================================================
 * WHAT A BADGE IS, AND WHAT AN ACHIEVEMENT IS
 *
 * A BADGE is one piece of art and one idea: "Clean Lap", "Knockouts". An
 * ACHIEVEMENT is one thing a player can have earned: "Clean Lap on Elkarim",
 * "Knockouts, silver". The art brief's arithmetic is exactly this split:
 *
 *   8 track badges   x 8 circuits                          64
 *   9 tiered badges  x 4 tiers (bronze/silver/gold/prism)   36
 *   Front Runner     x 4 difficulties                       4
 *   Collector        x 3 tiers (it tops out at gold)        3
 *   11 single badges                                       11
 *                                                          ---
 *                                                          118
 *
 * The game draws the frame; the art is one image per badge. So the frame is
 * data here (`frameFor`, the colour tables) and the image is looked up by the
 * badge's id through the manifest, exactly as a portrait is.
 *
 * ===========================================================================
 * FOUR WAYS AN ACHIEVEMENT IS DECIDED, AND WHY THE SERVER CARES WHICH
 *
 *   evidence  one race proved it: a clean lap, a win on Expert, a x16 combo.
 *             Only the client that drove the race saw it, so it is CLAIMED --
 *             see net/account.ts for exactly how little the server can check.
 *   counter   a lifetime tally crossed a threshold. The server holds its own
 *             copy of every counter, bounds how far a post may move it, and
 *             DERIVES the tier from that copy rather than accepting the claim.
 *   profile   read off numbers the account already owns: lifetime `earned`
 *             (Tycoon), portraits owned (Collector), and `wins`/`races` as a
 *             floor under the two race counters. Derived, never claimed.
 *   derived   a set of other achievements: World Tour is the eight Victory
 *             badges, Perfectionist the eight Perfect Races, Full Garage the
 *             five per-chassis win marks. Derived, never claimed.
 *
 * That split is the whole trust model in one line: the only ids a forger can
 * add by lying are evidence ids and marks, and those are bounded per post.
 * Everything else is a function of numbers the server itself bounded.
 *
 * ===========================================================================
 * MARKS: PROGRESS THAT IS NOT AN ACHIEVEMENT
 *
 * Two facts have to survive between races, and across devices, without being
 * shown to anybody as a badge of their own:
 *
 *   mark:win:<chassisId>   won a race in this car. Full Garage is all five.
 *   mark:ironrun           finished all eight rounds of a Grand Circuit, which
 *                          is the Iron Run portrait's condition and is not one
 *                          of the 118 (the brief ties Iron Run to the circuit
 *                          itself, not to a badge).
 *
 * They live in the same union-merged set as the achievements, under a prefix
 * nothing else uses, so one merge rule and one validator cover both.
 */
import { COMBO_MAX } from '../score/rules'
import { ART_SIZES, BADGE_ART, type ArtSize } from './artManifest'
import {
  AVATARS, FEAT_SCORE, artSizeFor, featsEarned, ownsAvatar,
  type CircuitEvidence, type ProfileLike,
} from './avatars'
import { CHASSIS } from './chassis'
import { DIFFICULTIES, DIFFICULTY_SPECS, type Difficulty } from './difficulty'

// ---------------------------------------------------------------------------
// Categories and frame colours
// ---------------------------------------------------------------------------

/**
 * The five categories. The glow in each badge's art is its category colour,
 * so the wall reads by type at a glance -- see §5 of the brief.
 */
export type BadgeCategory = 'racing' | 'skill' | 'combat' | 'mastery' | 'career'

export const CATEGORIES: readonly BadgeCategory[] = ['racing', 'skill', 'combat', 'mastery', 'career']

export const CATEGORY_LABEL: Readonly<Record<BadgeCategory, string>> = {
  racing: 'Racing',
  skill: 'Skill',
  combat: 'Combat',
  mastery: 'Mastery',
  career: 'Career',
}

/** From the brief's table. The stand-in emblems below are drawn in these. */
export const CATEGORY_COLOR: Readonly<Record<BadgeCategory, string>> = {
  racing: '#ffd23f',
  skill: '#22d3ff',
  combat: '#ff2f7a',
  mastery: '#b44dff',
  career: '#2fe36b',
}

/** The metal tiers. Index 0 is tier 1. */
export const TIER_NAMES = ['bronze', 'silver', 'gold', 'prism'] as const
export type TierName = typeof TIER_NAMES[number]

export const TIER_LABEL: Readonly<Record<TierName, string>> = {
  bronze: 'Bronze', silver: 'Silver', gold: 'Gold', prism: 'Prism',
}

/**
 * Solid tier rings. PRISM IS NOT A COLOUR, it is `PRISM_STOPS` swept round
 * the ring -- the game's own drift-tier colours (styles.css --sg-t0..t3), so
 * the top tier of everything reads like a max-tier drift. The UI animates the
 * sweep and holds it still under reduced motion.
 */
export const TIER_COLOR: Readonly<Record<Exclude<TierName, 'prism'>, string>> = {
  bronze: '#cd7f32',
  silver: '#c7d0d9',
  gold: '#ffd23f',
}

export const PRISM_STOPS: readonly string[] = ['#3d8bff', '#b44dff', '#ffd23f', '#ffffff']

/** Front Runner's ring is the colour of the difficulty it was won on. */
export const DIFFICULTY_COLOR: Readonly<Record<Difficulty, string>> = {
  easy: '#2fe36b',
  normal: '#22d3ff',
  hard: '#ff8b2f',
  expert: '#b44dff',
}

// ---------------------------------------------------------------------------
// Circuits
// ---------------------------------------------------------------------------

/**
 * THE EIGHT CIRCUITS, COPIED RATHER THAN IMPORTED, and held to the real list
 * by a test.
 *
 * The obvious import is `TRACKS` from ./tracks, and it is the wrong one for
 * this module: the account endpoint loads this file to validate ids, and
 * ./tracks is several thousand lines of spline data that BUILDS geometry at
 * import time (`circuit(segs)` runs on load). src/score/verify.ts refuses
 * exactly this for the leaderboard function and copies four numbers instead;
 * this copies eight ids, eight names and sixteen colours for the same reason.
 * tests/achievements.test.ts asserts the ids, their order and their display
 * names against TRACKS, so a new circuit or a rename is a red test rather than
 * a badge wall with a hole in it.
 *
 * ORDER IS THE TRACK SCREEN'S ORDER, so the circuit picker on the Tracks page
 * reads the same way the circuit list the player already knows does.
 *
 * TWO TONES PER RING, from §6 of the brief: the circuit's signature glow and
 * its ground colour. Several circuits glow in near-identical teals, so the
 * ground is what tells Elkarim's ring from Meridian Deep's at a glance.
 */
export interface AchievementCircuit {
  id: string
  name: string
  glow: string
  ground: string
}

export const ACH_CIRCUITS: readonly AchievementCircuit[] = [
  { id: 'rustfall', name: 'Elkarim', glow: '#35e0ff', ground: '#a8481f' },
  { id: 'cryostatic', name: 'Frosthelm', glow: '#7bffcf', ground: '#437c9f' },
  { id: 'aetherion', name: 'Namaresh', glow: '#35f0d8', ground: '#e8b44a' },
  { id: 'hollowchoir', name: 'Centurion Prime', glow: '#ffa63a', ground: '#8f9a96' },
  { id: 'emberfall', name: 'Ashkar', glow: '#ff6a18', ground: '#1c1614' },
  { id: 'abyssal', name: 'Meridian Deep', glow: '#54f0d0', ground: '#063b55' },
  { id: 'halcyon', name: 'Halcyon Bay', glow: '#ffb45e', ground: '#2aa2c4' },
  { id: 'neonspire', name: 'Zhen-9', glow: '#ff3ea5', ground: '#35e8ff' },
]

export const ACH_CIRCUIT_BY_ID: ReadonlyMap<string, AchievementCircuit> =
  new Map(ACH_CIRCUITS.map((c) => [c.id, c]))

/**
 * THE LAP RECORD TARGETS, AND THE MEASUREMENT THEY ARE.
 *
 * Vince's rule: the fastest lap the EXPERT field sets over several seeded
 * headless races, rounded to a tenth. Measured with
 * `npx tsx tools/probe-achievements.ts --laps`: eight races per circuit, an
 * all-Expert eight-car field (`skillForSlot('expert', i)`), chassis and pilots
 * rotated by seed so every car sits in every band, three laps, every racer's
 * `bestLap`. The target is that minimum ROUNDED UP to the tenth, which is what
 * makes it provably beatable: the lap that set it is under it.
 *
 *              expert fastest (seed, slot)  target   expert race-best p50   normal fastest
 *   Elkarim         47.783     (4, 5)       47.8          48.55                50.17
 *   Frosthelm       52.117     (8, 7)       52.2          53.70                55.43
 *   Namaresh        59.683     (2, 4)       59.7          60.47                61.62
 *   Centurion P.    54.100     (1, 2)       54.2          55.47                57.30
 *   Ashkar          78.017     (1, 5)       78.1          79.85                82.32
 *   Meridian Deep   75.367     (1, 5)       75.4          76.88                80.58
 *   Halcyon Bay     52.683     (7, 2)       52.7          52.83                55.60
 *   Zhen-9          81.317     (5, 7)       81.4          83.08                86.07
 *
 * Centurion Prime's record is a whole tenth (3,246 steps of 1/60 s), and since
 * a beat is STRICTLY under, its target is the next tenth up rather than the lap
 * itself -- the same "the record lap is under its own target" rule as the rest.
 * Re-measured 2026-09-24 against this tree; every figure above reproduced.
 *
 * NOT TRIVIAL, AND THAT IS THE OTHER HALF OF THE MEASUREMENT: of 64 Expert
 * best laps per circuit, exactly one beat its target (the one that set it),
 * and of 64 NORMAL best laps, none did -- the Normal field's single fastest
 * lap is 1.9 to 5.2 seconds off. It is a lap a very good race produces, not a
 * lap an ordinary one stumbles into. tests/achievements.test.ts replays the
 * record-setting race for each circuit and fails if its lap no longer beats
 * the target -- which is what a track rebuild would do, and then this table
 * is re-measured rather than edited by hand.
 *
 * "Beat" is strictly under. A lap is a lap in any race on the circuit: lap 1
 * carries the 3.6-second countdown in its time (sim/race.ts starts the clock
 * at the lights), so in practice the record falls on lap 2 or later.
 */
export const LAP_TARGETS: Readonly<Record<string, number>> = {
  rustfall: 47.8,
  cryostatic: 52.2,
  aetherion: 59.7,
  hollowchoir: 54.2,
  emberfall: 78.1,
  abyssal: 75.4,
  halcyon: 52.7,
  neonspire: 81.4,
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

/**
 * The lifetime tallies. Each one only ever goes up; two copies merge by MAX.
 *
 * `airtime` is held in WHOLE MILLISECONDS, not seconds: a race adds a few
 * seconds and a fraction, and a counter stored in seconds would either round
 * that fraction away every race (the badge would quietly run slow) or carry a
 * float through a max-merge, where 12.300000000000001 and 12.3 are different
 * numbers. Integers merge exactly.
 */
export const COUNTERS = [
  'singularity', 'knockouts', 'wins', 'finishes', 'launches', 'hits', 'airtime', 'online',
] as const
export type CounterId = typeof COUNTERS[number]

export type Counters = Partial<Record<CounterId, number>>

/**
 * THE MOST ONE RACE CAN ADD TO EACH COUNTER, which is what the server bounds
 * a post by (net/account.ts, `ACH_*`).
 *
 * Measured, then given room: across 192 headless racer-races on all eight
 * circuits the maxima were 14 SINGULARITY releases, 24 knockouts, 26 weapon
 * hits landed and 45.5 s of airtime in a three-lap race. The ceilings are two
 * to three times that, because a lobby race can run ten laps and a ceiling an
 * honest race can reach is a ceiling that refuses honest players. The four
 * one-a-race counters are exactly one: a race is won once, finished once,
 * launched once, and is one multiplayer win at most.
 */
export const COUNTER_CEILING: Readonly<Record<CounterId, number>> = {
  singularity: 40,
  knockouts: 60,
  wins: 1,
  finishes: 1,
  launches: 1,
  hits: 80,
  airtime: 120_000,
  online: 1,
}

/** Above any honest lifetime by orders of magnitude; a sanity clamp on reads. */
export const COUNTER_MAX = 1_000_000_000

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

/**
 * How a badge frames itself and how many achievements it holds:
 *
 *   track       eight, one per circuit, ringed in that circuit's two tones.
 *   tiered      one per threshold, ringed in the highest METAL reached.
 *   difficulty  Front Runner: one per difficulty, ringed in its colour.
 *   single      one, ringed in the badge's category colour.
 */
export type BadgeKind = 'track' | 'tiered' | 'difficulty' | 'single'

export interface BadgeDef {
  /** Also the art id: public/badges/<id>-<size>.webp. */
  id: string
  name: string
  category: BadgeCategory
  kind: BadgeKind
  /** One line, the player's words. Tier and circuit detail is added per achievement. */
  how: string
  /** Ascending thresholds for a tiered badge; empty otherwise. */
  tiers: readonly number[]
  /** The counter a tiered badge reads, or null. */
  counter: CounterId | null
  /** Where the count comes from for a tiered badge the PROFILE drives. */
  source: 'counter' | 'earned' | 'owned' | null
  /** Written on the progress line: "37 / 100 drifts". */
  unit: string
  /** The brief's G/T number, for anyone reading the brief beside this file. */
  ref: string
}

const commas = (n: number): string =>
  Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')

const track = (
  id: string, name: string, category: BadgeCategory, how: string, ref: string,
): BadgeDef => ({ id, name, category, kind: 'track', how, tiers: [], counter: null, source: null, unit: '', ref })

const single = (
  id: string, name: string, category: BadgeCategory, how: string, ref: string,
): BadgeDef => ({ id, name, category, kind: 'single', how, tiers: [], counter: null, source: null, unit: '', ref })

const tiered = (
  id: string, name: string, category: BadgeCategory, how: string, ref: string,
  tiers: readonly number[], counter: CounterId | null, source: BadgeDef['source'], unit: string,
): BadgeDef => ({ id, name, category, kind: 'tiered', how, tiers, counter, source, unit, ref })

/**
 * THE THIRTY, in the brief's order (T1-T8, then G1-G22).
 *
 * THE SENTENCES ARE THE CONTRACT. Every `how` is a claim that the game can
 * observe what it asks for, and DEFINITIONS below is where each observation is
 * pinned to a real event. Two were settled with Vince before this file:
 *
 *   Front Runner counts a win in ANY race at that difficulty -- a single race,
 *   a circuit round or a lobby race -- not only the Grand Circuit.
 *
 *   Legendary Drifts keeps its name and counts drifts RELEASED at
 *   SINGULARITY, the HUD's top tier, and says so, because "LEGENDARY" is
 *   already on screen as the name of the x16 combo and a badge naming a tier
 *   the player never sees called that would be a riddle.
 */
export const BADGES: readonly BadgeDef[] = [
  // --- track badges: one image, eight circuits ------------------------------
  track('track-cleanlap', 'Clean Lap', 'skill',
    'Complete a lap without touching a wall.', 'T1'),
  track('track-perfect', 'Perfect Race', 'mastery',
    'Win without touching a wall all race.', 'T2'),
  track('track-wrecking', 'Wrecking Crew', 'combat',
    'Spin out or knock out 3 rivals in one race.', 'T3'),
  track('track-victory', 'Victory', 'racing',
    'Win a race.', 'T4'),
  track('track-laprecord', 'Lap Record', 'racing',
    "Beat the circuit's target lap time.", 'T5'),
  track('track-driftking', 'Drift King', 'skill',
    'Release 3 drifts at SINGULARITY in one race.', 'T6'),
  track('track-holeshot', 'Hole Shot', 'skill',
    'Get a perfect rocket start and lead at the end of lap 1.', 'T7'),
  track('track-summit', 'Summit', 'mastery',
    'Win on Expert.', 'T8'),

  // --- global badges -------------------------------------------------------
  {
    id: 'frontrunner', name: 'Front Runner', category: 'racing', kind: 'difficulty',
    how: 'Win a race on every difficulty.', tiers: [], counter: null, source: null,
    unit: '', ref: 'G1',
  },
  tiered('legendary-drifts', 'Legendary Drifts', 'skill',
    'Release a drift at SINGULARITY, the top tier.', 'G2',
    [20, 100, 500, 1000], 'singularity', 'counter', 'drifts'),
  tiered('knockouts', 'Knockouts', 'combat',
    'Spin out or knock out rivals with your weapons.', 'G3',
    [20, 100, 500, 1000], 'knockouts', 'counter', 'rivals'),
  tiered('wins', 'Race Wins', 'racing',
    'Win races.', 'G4',
    [1, 10, 50, 250], 'wins', 'counter', 'wins'),
  tiered('finishes', 'Races Finished', 'racing',
    'Finish races.', 'G5',
    [10, 50, 250, 1000], 'finishes', 'counter', 'races'),
  single('grand-champion', 'Grand Champion', 'mastery',
    'Win the Grand Circuit.', 'G6'),
  single('world-tour', 'World Tour', 'mastery',
    'Win on all 8 circuits.', 'G7'),
  single('perfectionist', 'Perfectionist', 'mastery',
    'Earn Perfect Race on all 8 circuits.', 'G8'),
  tiered('rocket-start', 'Rocket Start', 'skill',
    'Launch perfectly from the grid.', 'G9',
    [10, 50, 250, 1000], 'launches', 'counter', 'launches'),
  tiered('sharpshooter', 'Sharpshooter', 'combat',
    'Land weapon hits on rivals.', 'G10',
    [50, 250, 1000, 5000], 'hits', 'counter', 'hits'),
  single('untouchable', 'Untouchable', 'combat',
    'Win without being hit by a single weapon.', 'G11'),
  single('comeback', 'Comeback', 'racing',
    'Win a race after running last.', 'G12'),
  single('photo-finish', 'Photo Finish', 'racing',
    'Win by less than 0.1 seconds.', 'G13'),
  // Built from COMBO_MAX, like the Singularity Hand feat's own sentence, so a
  // re-tune of the ceiling moves the words and the test together.
  single('combo-king', 'Combo King', 'skill',
    `Reach a ×${COMBO_MAX} combo.`, 'G14'),
  single('high-roller', 'High Roller', 'career',
    `Score ${commas(FEAT_SCORE)} points in one race.`, 'G15'),
  tiered('tycoon', 'Tycoon', 'career',
    'Earn credits by racing.', 'G16',
    [10000, 50000, 100000, 250000], null, 'earned', 'credits'),
  /**
   * COLLECTOR'S TOP TIER CANNOT BE EARNED TODAY, and nothing here pretends
   * otherwise. Owning all 24 portraits includes Neon Count (`neonsaint`),
   * which is a SHOP portrait whose art has not been delivered -- and
   * avatars.ts will not sell a face that is not there (`artPending`). So gold
   * waits on one file in public/avatars/. It is not hacked round: a badge that
   * quietly counted to 23 would be a badge that lies about the roster, and the
   * day the art lands the tier opens with no code change.
   */
  tiered('collector', 'Collector', 'career',
    'Own avatars.', 'G17',
    [8, 16, 24], null, 'owned', 'avatars'),
  tiered('airtime', 'Airtime', 'skill',
    'Spend time in the air.', 'G18',
    [60, 300, 1000, 5000], 'airtime', 'counter', 'seconds'),
  single('clean-sweep', 'Clean Sweep', 'mastery',
    'Win every round of a series.', 'G19'),
  tiered('online-victor', 'Online Victor', 'racing',
    'Win multiplayer races.', 'G20',
    [1, 10, 50, 250], 'online', 'counter', 'wins'),
  single('iron-will', 'Iron Will', 'combat',
    'Finish a race after being hit 5 or more times.', 'G21'),
  single('full-garage', 'Full Garage', 'racing',
    'Win a race in every chassis.', 'G22'),
]

export const BADGE_BY_ID: ReadonlyMap<string, BadgeDef> = new Map(BADGES.map((b) => [b.id, b]))

export const TRACK_BADGES: readonly BadgeDef[] = BADGES.filter((b) => b.kind === 'track')
export const GLOBAL_BADGES: readonly BadgeDef[] = BADGES.filter((b) => b.kind !== 'track')

// ---------------------------------------------------------------------------
// Achievements
// ---------------------------------------------------------------------------

export type AchievementBasis = 'evidence' | 'counter' | 'profile' | 'derived'

export interface AchievementDef {
  /** `<badge>:<circuit>`, `<badge>:<tier>`, `frontrunner:<difficulty>`, or the badge id. */
  id: string
  badge: string
  /** Shown on the tile and the toast: the badge name plus what distinguishes it. */
  name: string
  /** The one-line requirement, with the circuit's target or the tier's number in it. */
  how: string
  /** 1-based for a tiered badge; 0 for everything else. */
  tier: number
  threshold: number
  trackId: string | null
  difficulty: Difficulty | null
  basis: AchievementBasis
}

/** Tiered and profile-read achievement ids, e.g. `knockouts:2`. */
export const tierId = (badge: string, tier: number): string => `${badge}:${tier}`
/** Track achievement ids, e.g. `track-cleanlap:rustfall`. */
export const trackAchId = (badge: string, trackId: string): string => `${badge}:${trackId}`

/** The tiered badges whose tier the PROFILE decides rather than a counter. */
const PROFILE_TIERED = new Set(['tycoon', 'collector'])

function buildAchievements(): AchievementDef[] {
  const out: AchievementDef[] = []
  for (const b of BADGES) {
    if (b.kind === 'track') {
      for (const c of ACH_CIRCUITS) {
        const how = b.id === 'track-laprecord'
          ? `Lap ${c.name} in under ${LAP_TARGETS[c.id].toFixed(1)}\u00a0s.`
          : b.how
        out.push({
          id: trackAchId(b.id, c.id), badge: b.id, name: `${b.name} · ${c.name}`,
          how, tier: 0, threshold: 0, trackId: c.id, difficulty: null, basis: 'evidence',
        })
      }
    } else if (b.kind === 'difficulty') {
      for (const d of DIFFICULTIES) {
        const label = DIFFICULTY_SPECS[d].label
        out.push({
          id: `${b.id}:${d}`, badge: b.id, name: `${b.name} · ${label}`,
          how: `Win a race on ${label}.`, tier: 0, threshold: 0, trackId: null,
          difficulty: d, basis: 'evidence',
        })
      }
    } else if (b.kind === 'tiered') {
      b.tiers.forEach((n, i) => {
        out.push({
          id: tierId(b.id, i + 1), badge: b.id,
          name: `${b.name} · ${TIER_LABEL[TIER_NAMES[i]]}`,
          how: tierSentence(b, n), tier: i + 1, threshold: n, trackId: null, difficulty: null,
          basis: PROFILE_TIERED.has(b.id) ? 'profile' : 'counter',
        })
      })
    } else {
      out.push({
        id: b.id, badge: b.id, name: b.name, how: b.how, tier: 0, threshold: 0,
        trackId: null, difficulty: null,
        basis: DERIVED_SINGLES.has(b.id) ? 'derived' : 'evidence',
      })
    }
  }
  return out
}

/** Singles that are a function of other achievements or marks. */
const DERIVED_SINGLES = new Set(['world-tour', 'perfectionist', 'full-garage'])

/** "Release 100 drifts at SINGULARITY, the top tier." -- one per tier. */
function tierSentence(b: BadgeDef, n: number): string {
  const one = n === 1
  switch (b.id) {
    case 'legendary-drifts': return `Release ${commas(n)} drifts at SINGULARITY, the top tier.`
    case 'knockouts': return `Spin out or knock out ${commas(n)} rivals with your weapons.`
    case 'wins': return one ? 'Win a race.' : `Win ${commas(n)} races.`
    case 'finishes': return `Finish ${commas(n)} races.`
    case 'rocket-start': return `Make ${commas(n)} perfect launches.`
    case 'sharpshooter': return `Land ${commas(n)} weapon hits on rivals.`
    case 'tycoon': return `Earn ${commas(n)} credits in total.`
    case 'collector': return `Own ${commas(n)} avatars.`
    case 'airtime': return `Spend ${commas(n)} seconds in the air.`
    case 'online-victor': return one ? 'Win a multiplayer race.' : `Win ${commas(n)} multiplayer races.`
    default: return b.how
  }
}

/**
 * What a tiered badge says once its top tier is done. Not the count on its own:
 * "1,000 drifts" drops the one word Legendary Drifts is about, so each badge
 * says what the number is OF, in the same words as its tiers.
 */
function doneSentence(b: BadgeDef, top: number): string {
  switch (b.id) {
    case 'legendary-drifts': return `Every tier earned — ${commas(top)}+ drifts released at SINGULARITY.`
    case 'knockouts': return `Every tier earned — ${commas(top)}+ rivals spun out or knocked out.`
    case 'airtime': return `Every tier earned — ${commas(top)}+ seconds in the air.`
    case 'online-victor': return `Every tier earned — ${commas(top)}+ multiplayer wins.`
    default: return `Every tier earned — ${commas(top)}+ ${b.unit}.`
  }
}

/** All 118, in badge order, then circuit / difficulty / tier order. */
export const ACHIEVEMENTS: readonly AchievementDef[] = buildAchievements()

export const ACHIEVEMENT_BY_ID: ReadonlyMap<string, AchievementDef> =
  new Map(ACHIEVEMENTS.map((a) => [a.id, a]))

/**
 * Unlock ids AS NEWS: where one burst crossed several tiers of one badge -- a
 * profile arriving with 62,000 lifetime credits crosses Tycoon bronze and
 * silver in the same moment -- only the highest is said. The store keeps every
 * tier; this is what a toast or the results strip reads out, and "Tycoon ·
 * Bronze, Tycoon · Silver" is one piece of news told twice, the lesser first.
 * Unknown ids are dropped; order is first appearance.
 */
export function newsOf(ids: readonly string[]): string[] {
  const best = new Map<string, AchievementDef>()
  const order: string[] = []
  for (const id of ids) {
    const a = ACHIEVEMENT_BY_ID.get(id)
    if (!a) continue
    const key = a.tier > 0 ? a.badge : a.id
    const had = best.get(key)
    if (!had) { best.set(key, a); order.push(key) } else if (a.tier > had.tier) best.set(key, a)
  }
  return order.map((k) => (best.get(k) as AchievementDef).id)
}

/** Achievements of one badge, in order. */
export function achievementsOf(badgeId: string): AchievementDef[] {
  return ACHIEVEMENTS.filter((a) => a.badge === badgeId)
}

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------

export const MARK_PREFIX = 'mark:'
export const MARK_IRONRUN = 'mark:ironrun'
export const winMark = (chassisId: string): string => `mark:win:${chassisId}`

/**
 * Every mark the catalogue knows. Built from CHASSIS -- imported, not copied,
 * because content/chassis.ts is small and pure and the account endpoint
 * already loads its one dependency (tuning.ts, through wallet.ts).
 */
export const MARKS: readonly string[] = [MARK_IRONRUN, ...CHASSIS.map((c) => winMark(c.id))]

const KNOWN_IDS: ReadonlySet<string> = new Set([...ACHIEVEMENTS.map((a) => a.id), ...MARKS])

/** An achievement id or a mark this build knows. Everything else is dropped. */
export function isKnownId(id: unknown): id is string {
  return typeof id === 'string' && KNOWN_IDS.has(id)
}

export function isMark(id: string): boolean {
  return id.startsWith(MARK_PREFIX)
}

/**
 * The ids a CLIENT may claim: evidence achievements and marks.
 *
 * Counter, profile and derived ids are not in this set, and the server drops
 * them from a post rather than taking a client's word for a threshold it can
 * compute from its own bounded counter. See net/account.ts.
 */
export function isClaimable(id: string): boolean {
  if (isMark(id)) return KNOWN_IDS.has(id)
  return ACHIEVEMENT_BY_ID.get(id)?.basis === 'evidence'
}

// ---------------------------------------------------------------------------
// The feat portraits
// ---------------------------------------------------------------------------

/**
 * THE FIVE PORTRAITS THE BRIEF TIES TO ACHIEVEMENTS, and the fix for the three
 * that were never granted.
 *
 * avatars.ts defines the five feats and `featsEarned`, and until this pass
 * nothing called it: the game threw away the combo, the score and the circuit
 * standing at the flag, and `award` was never told any of them -- so Singularity
 * Hand, Half Million and Grand Champion were portraits nobody could own, and
 * Iron Run with them. Flag Bearer alone worked, because `wins >= 1` is a counter.
 *
 * Now each feat hangs off something that SYNCS:
 *
 *   Flag Bearer       Race Wins, bronze (one win)      -- and still `wins >= 1`
 *   Singularity Hand  Combo King
 *   Half Million      High Roller
 *   Grand Champion    Grand Champion
 *   Iron Run          mark:ironrun (all eight rounds finished)
 *
 * and the account DERIVES the portrait from the synced id (`featsFromUnlocks`,
 * called in net/account.ts `toProfile` and in the mock). The three evidence
 * achievements are decided by avatars.ts's own predicates -- `raceClaims`
 * below calls `featsEarned` -- so the sentence under the portrait and the test
 * that grants the badge cannot drift apart.
 */
export const FEAT_OF: Readonly<Record<string, string>> = {
  [tierId('wins', 1)]: 'flagbearer',
  'combo-king': 'singularity',
  'high-roller': 'halfmillion',
  'grand-champion': 'laurel',
  [MARK_IRONRUN]: 'ironrun',
}

/** Feat portrait ids implied by a set of unlocked achievement ids and marks. */
export function featsFromUnlocks(unlocked: Iterable<string>): string[] {
  const out = new Set<string>()
  for (const id of unlocked) {
    const feat = FEAT_OF[id]
    if (feat) out.add(feat)
  }
  return [...out]
}

// ---------------------------------------------------------------------------
// DEFINITIONS -- what the game counts, pinned to the events that count it
// ---------------------------------------------------------------------------

/**
 * EVERYTHING ONE RACE CAN PROVE, collected per SIM STEP by
 * src/score/tracker.ts and finished at the flag by game/main.ts.
 *
 * The definitions, which every sentence above has to stay true to:
 *
 *   CLEAN LAP        a lap with no `wall` event on the player's car and no
 *                    respawn begun during it. Any contact counts, the zero-force
 *                    lean of a drift against the outside wall included:
 *                    "without touching a wall" is the sentence. Measured: the
 *                    AI laps cleanly on only three circuits, because its drift
 *                    lines lean on walls by design; no spot on any circuit is
 *                    touched on every lap (hottest: 59-81% of laps), so the
 *                    other five are a skill wall rather than a forced contact.
 *   PERFECT RACE     a win in which every lap was clean.
 *   WEAPON HIT       a `hit` event: a weapon took effect -- a spin, an EMP
 *                    stun, or a gravity well's slow. A `ward` absorb ("BLOCKED")
 *                    and a `guard` ("PLATING HELD", which eats a crash, not a
 *                    weapon) are not hits. A gatling round that only chips
 *                    speed raises no `hit`; the round that breaks the target
 *                    does, so a burst counts once, as the game's own hit
 *                    marker does.
 *   KNOCKOUT         a weapon hit YOU landed (`hit.by` is you) that spun a
 *                    rival out or put their systems down -- missiles, a mine,
 *                    the gatling's lethal round, the Overdrive ram, an EMP stun.
 *                    That is the HUD's own "SPUN OUT" / "SYSTEMS DOWN" slot:
 *                    the car is not theirs for a moment. A gravity well's slow
 *                    is a hit but not a knockout -- the car is still being
 *                    driven -- and neither is the scorer's KNOCK award, which
 *                    pays for a shunt (a bump closing at 6 m/s or more) that
 *                    knocks nobody out. The gatling's `beamHit.lethal` and the
 *                    lethal round's `hit` are the same moment; `hit` is used
 *                    because a lethal round the target's ward absorbs is a
 *                    `ward`, not a knockout, and only the target's list knows.
 *   SINGULARITY      a `driftEnd` at tier 3 while the race is live for the
 *   RELEASE          player -- the same event and the same liveness the
 *                    scorer's `driftRelease` award uses, so the badge counts
 *                    exactly the releases the score paid SINGULARITY money for.
 *   PERFECT LAUNCH   `launch` with grade `perfect`, once a race at most.
 *   RUNNING LAST     last place held for at least RAN_LAST_HOLD seconds, at
 *                    any time from RAN_LAST_AFTER seconds after the green light.
 *                    Grid order does not count -- a lobby can put you on the
 *                    back row -- and neither does the first corner's scramble,
 *                    nor a one-frame swap in a pack. See the constants.
 *   AIRTIME          the sim's own air clock: time `RacerState.airTime` spends
 *                    counting up, which it does off ramps, crests and drops. A
 *                    flight chassis hovering on Lift is not airborne to the sim
 *                    and is not here either -- otherwise Vector-7 would own the
 *                    badge by holding a button.
 *   MULTIPLAYER WIN  a win in a lobby race with at least one other person on
 *                    the grid. Under the default `mock` net profile those
 *                    people are the mock's simulated players; see the report.
 *
 * Counters count what happened, including in a race the player quits.
 * Evidence achievements that need a result need a finish, and nothing counts
 * after the player's own flag: the victory lap is driven by the AI.
 */
export interface RaceFacts {
  trackId: string
  chassisId: string
  /** The difficulty the field was actually run at (main.ts `raceDifficulty`). */
  difficulty: Difficulty
  /** SimConfig.totalLaps: a lobby race may run 1 to 10. */
  laps: number
  /** A lobby race with at least one other person on the grid. */
  multiplayer: boolean
  /** Crossed the line. A quit is false. */
  finished: boolean
  /** Final position, 1-based. */
  position: number
  /** P2's finish time minus ours, when we won and P2 finished. Infinity otherwise. */
  winMargin: number
  /** The sim's own lap times for the player's car, in order. */
  lapTimes: readonly number[]
  /** Laps the tracker saw complete, and how many of those were clean. */
  lapsSeen: number
  cleanLaps: number
  /** Any wall contact or respawn while racing. */
  dirtyRace: boolean
  singularity: number
  knockouts: number
  weaponHits: number
  hitsTaken: number
  perfectLaunch: boolean
  /** Position when lap 1 completed; 0 if it never did. */
  lap1Position: number
  ranLast: boolean
  airtimeMs: number
  /** Scorer.score and Scorer.bestCombo for the run. */
  score: number
  bestCombo: number
  /**
   * The tracker did not see every step of this race -- a multiplayer rejoin
   * replays the round outside the render loop. Anything proved by an ABSENCE
   * (no wall, no hit) is withheld, because a missed step could have held the
   * contact. Counters and positive evidence still count: missing a step can
   * only make them smaller.
   */
  partial: boolean
  /** Set only on the race that completed a Grand Circuit. */
  circuit: CircuitEvidence | null
  /** This race completed a series of 3+ rounds and every round was won. */
  sweep: boolean
}

/** Seconds after the green light before last place counts. See RUNNING LAST. */
export const RAN_LAST_AFTER = 10
/** Seconds last place has to be held. See RUNNING LAST. */
export const RAN_LAST_HOLD = 1.5

/** Photo Finish: a winning margin strictly under this, seconds. */
export const PHOTO_FINISH = 0.1

/** Iron Will: weapon hits taken, at least. */
export const IRON_WILL_HITS = 5

/** Wrecking Crew: knockouts in one race, at least. */
export const WRECKING_KNOCKOUTS = 3

/** Drift King: SINGULARITY releases in one race, at least. */
export const DRIFT_KING_RELEASES = 3

/** A series has to be at least this long for Clean Sweep. A single race is
 *  "a series of one" to the lobby (net/types.ts), and winning one race is
 *  Victory, not a sweep. Three is the shortest real series the lobby offers. */
export const SWEEP_MIN_ROUNDS = 3

/** A fresh facts object, for the tracker's reset and for tests. */
export function emptyFacts(trackId = '', chassisId = ''): RaceFacts {
  return {
    trackId, chassisId, difficulty: 'normal', laps: 3, multiplayer: false,
    finished: false, position: 0, winMargin: Number.POSITIVE_INFINITY, lapTimes: [],
    lapsSeen: 0, cleanLaps: 0, dirtyRace: false, singularity: 0, knockouts: 0,
    weaponHits: 0, hitsTaken: 0, perfectLaunch: false, lap1Position: 0, ranLast: false,
    airtimeMs: 0, score: 0, bestCombo: 1, partial: false, circuit: null, sweep: false,
  }
}

/**
 * The evidence achievements and marks one race proves. Possibly ones already
 * owned: "already had it" is the store's question, not this one's.
 *
 * Called at the flag with the whole race, at a quit with what there was, and
 * mid-race by the HUD chip with `finished: false` -- which is exactly the
 * right partial answer, because everything that needs a result says so here.
 */
export function raceClaims(f: RaceFacts): string[] {
  const out: string[] = []
  const t = ACH_CIRCUIT_BY_ID.has(f.trackId) ? f.trackId : null
  const won = f.finished && f.position === 1
  const onTrack = (badge: string): void => { if (t) out.push(trackAchId(badge, t)) }

  // --- track badges ---------------------------------------------------------
  if (f.cleanLaps > 0 && !f.partial) onTrack('track-cleanlap')
  if (won && !f.partial && !f.dirtyRace && f.lapsSeen >= f.laps && f.cleanLaps >= f.laps) {
    onTrack('track-perfect')
  }
  if (f.knockouts >= WRECKING_KNOCKOUTS) onTrack('track-wrecking')
  if (won) onTrack('track-victory')
  const target = t ? LAP_TARGETS[t] : undefined
  if (target !== undefined && f.lapTimes.some((x) => x > 0 && x < target)) onTrack('track-laprecord')
  if (f.singularity >= DRIFT_KING_RELEASES) onTrack('track-driftking')
  // Lap 1's position is read at the moment the lap closed; `partial` withholds
  // it because a rejoin replays lap 1 unseen and the moment is not ours.
  if (f.perfectLaunch && f.lap1Position === 1 && !f.partial) onTrack('track-holeshot')
  if (won && f.difficulty === 'expert') onTrack('track-summit')

  // --- global evidence ------------------------------------------------------
  if (won) out.push(`frontrunner:${f.difficulty}`)
  if (won && f.hitsTaken === 0 && !f.partial) out.push('untouchable')
  if (won && f.ranLast) out.push('comeback')
  if (won && f.winMargin < PHOTO_FINISH) out.push('photo-finish')
  if (f.finished && f.hitsTaken >= IRON_WILL_HITS) out.push('iron-will')
  if (f.sweep) out.push('clean-sweep')

  /**
   * THE FEATS DECIDE THEIR OWN BADGES. avatars.ts's predicates, not a copy of
   * them: Combo King is `bestCombo >= COMBO_MAX`, High Roller is a finish at
   * FEAT_SCORE, Grand Champion is `circuit.won`, and Iron Run is eight rounds
   * with no DNF -- whatever those say today, and whatever they say after a
   * re-tune.
   */
  const feats = featsEarned({
    finished: f.finished, position: f.position, score: f.score,
    bestCombo: f.bestCombo, circuit: f.circuit,
  })
  if (feats.includes('singularity')) out.push('combo-king')
  if (feats.includes('halfmillion')) out.push('high-roller')
  if (feats.includes('laurel')) out.push('grand-champion')
  if (feats.includes('ironrun')) out.push(MARK_IRONRUN)

  // --- marks ------------------------------------------------------------------
  if (won && CHASSIS.some((c) => c.id === f.chassisId)) out.push(winMark(f.chassisId))
  return out
}

/** What one race adds to each lifetime counter. */
export function raceCounters(f: RaceFacts): Counters {
  const won = f.finished && f.position === 1
  return {
    singularity: Math.max(0, Math.floor(f.singularity)),
    knockouts: Math.max(0, Math.floor(f.knockouts)),
    wins: won ? 1 : 0,
    finishes: f.finished ? 1 : 0,
    launches: f.perfectLaunch ? 1 : 0,
    hits: Math.max(0, Math.floor(f.weaponHits)),
    airtime: Math.max(0, Math.floor(f.airtimeMs)),
    online: won && f.multiplayer ? 1 : 0,
  }
}

// ---------------------------------------------------------------------------
// Snapshots, and the one merge rule
// ---------------------------------------------------------------------------

/**
 * Everything a player has earned, as it travels: to localStorage, over the
 * wire, into the account record. `unlocked` holds achievement ids AND marks.
 */
export interface AchievementSnapshot {
  unlocked: string[]
  counters: Counters
}

export function emptySnapshot(): AchievementSnapshot {
  return { unlocked: [], counters: {} }
}

const cnt = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  return Math.max(0, Math.min(COUNTER_MAX, Math.floor(v)))
}

/**
 * A snapshot from anywhere untrusted -- storage, a POST body, an old build.
 *
 * GARBAGE IS DROPPED ITEM BY ITEM, NOT WHOLESALE. An id this build does not
 * know (a retired badge, a typo, an attack) is left out and the rest is kept;
 * a counter that is not a finite number reads as zero and the rest are kept.
 * The same call content/avatars.ts makes about a retired portrait: losing one
 * entry is a smaller harm than losing a player's whole wall.
 *
 * `dropped` counts the ids that were refused, for the server's forensics.
 */
export function asSnapshot(raw: unknown): { snap: AchievementSnapshot; dropped: number } {
  const snap = emptySnapshot()
  let dropped = 0
  if (!raw || typeof raw !== 'object') return { snap, dropped }
  const r = raw as Record<string, unknown>
  if (Array.isArray(r.unlocked)) {
    const seen = new Set<string>()
    for (const id of r.unlocked) {
      if (isKnownId(id)) {
        if (!seen.has(id)) { seen.add(id); snap.unlocked.push(id) }
      } else {
        dropped++
      }
    }
  }
  if (r.counters && typeof r.counters === 'object') {
    const c = r.counters as Record<string, unknown>
    for (const k of COUNTERS) {
      const v = cnt(c[k])
      if (v > 0) snap.counters[k] = v
    }
  }
  return { snap, dropped }
}

/**
 * THE MERGE RULE, the only one, used by the device store, the mock and the
 * server: unlocks are a UNION and counters take the MAX.
 *
 * Neither can make anything go down, which is the property that makes a merge
 * safe to run in any order, any number of times, from any number of devices:
 * union and max are commutative, associative and idempotent. An achievement is
 * never taken away and a lifetime tally never runs backwards -- including when
 * a device comes back online holding a stale copy.
 */
export function mergeSnapshots(a: AchievementSnapshot, b: AchievementSnapshot): AchievementSnapshot {
  const unlocked = [...a.unlocked]
  const have = new Set(unlocked)
  for (const id of b.unlocked) if (!have.has(id)) { have.add(id); unlocked.push(id) }
  const counters: Counters = {}
  for (const k of COUNTERS) {
    const v = Math.max(cnt(a.counters[k]), cnt(b.counters[k]))
    if (v > 0) counters[k] = v
  }
  return { unlocked, counters }
}

/** Add one race's counters to a snapshot. */
export function addCounters(s: AchievementSnapshot, add: Counters): AchievementSnapshot {
  const counters: Counters = { ...s.counters }
  for (const k of COUNTERS) {
    const v = cnt(s.counters[k]) + cnt(add[k])
    if (v > 0) counters[k] = Math.min(COUNTER_MAX, v)
  }
  return { unlocked: [...s.unlocked], counters }
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * A count the PROFILE supplies: lifetime credits, portraits owned, and the
 * account's own `wins` and `races` as a floor under the two race counters.
 *
 * The floor is what gives an existing player their history. Race Wins and
 * Races Finished were not tracked before this pass, but the account has been
 * counting wins and finished races since the first award, so a player with
 * thirty wins opens the wall on Race Wins silver rather than on nothing.
 */
export type ProfileCounts = Pick<ProfileLike, 'unlocked' | 'earned'> & Partial<Pick<ProfileLike, 'credits' | 'races' | 'wins'>>

/** How many portraits this profile owns, derived ones included. */
export function ownedAvatarCount(p: ProfileCounts): number {
  const like: ProfileLike = {
    unlocked: p.unlocked, credits: p.credits ?? 0, earned: p.earned,
    races: p.races, wins: p.wins,
  }
  let n = 0
  for (const a of AVATARS) if (ownsAvatar(like, a.id)) n++
  return n
}

/**
 * The number a tiered badge is measured against, IN THE UNITS ITS TIERS ARE
 * WRITTEN IN: its counter, the profile, or the larger of the two where both
 * speak.
 *
 * Airtime is the one whose storage and whose tiers differ -- milliseconds held
 * (see COUNTERS), seconds promised -- and converting here, once, is what stops
 * a 60-second badge unlocking at 60 milliseconds in one caller and not another.
 */
export function badgeValue(b: BadgeDef, s: AchievementSnapshot, p?: ProfileCounts | null): number {
  if (b.source === 'earned') return p ? Math.max(0, Math.floor(p.earned)) : 0
  if (b.source === 'owned') return p ? ownedAvatarCount(p) : 0
  if (!b.counter) return 0
  const own = cnt(s.counters[b.counter])
  if (b.counter === 'airtime') return Math.floor(own / 1000)
  if (b.id === 'wins' && p && typeof p.wins === 'number') return Math.max(own, p.wins)
  if (b.id === 'finishes' && p && typeof p.races === 'number') return Math.max(own, p.races)
  return own
}

/**
 * Every achievement the snapshot and profile IMPLY: counter tiers, profile
 * tiers, and the three set-of-others singles.
 *
 * Pure and total -- recomputed rather than trusted, by the device and by the
 * server alike, so a lost write can never un-earn one (the same argument
 * avatars.ts makes for ranks: a derived unlock is a fact about numbers the
 * record already carries).
 */
export function deriveUnlocks(s: AchievementSnapshot, p?: ProfileCounts | null): string[] {
  const out: string[] = []
  const have = new Set(s.unlocked)
  for (const b of BADGES) {
    if (b.kind !== 'tiered') continue
    const v = badgeValue(b, s, p)
    b.tiers.forEach((n, i) => { if (v >= n) out.push(tierId(b.id, i + 1)) })
  }
  const allOf = (badge: string): boolean =>
    ACH_CIRCUITS.every((c) => have.has(trackAchId(badge, c.id)))
  if (allOf('track-victory')) out.push('world-tour')
  if (allOf('track-perfect')) out.push('perfectionist')
  if (CHASSIS.every((c) => have.has(winMark(c.id)))) out.push('full-garage')
  return out
}

/**
 * The snapshot with everything it implies folded in.
 *
 * Iterated to a fixed point rather than run once. Nothing derived today feeds
 * another derivation, but the loop is two lines and it makes the order of
 * BADGES irrelevant to the answer -- the day a derived badge reads another
 * derived badge, this is already right.
 */
export function withDerived(s: AchievementSnapshot, p?: ProfileCounts | null): AchievementSnapshot {
  const unlocked = [...s.unlocked]
  const have = new Set(unlocked)
  for (let pass = 0; pass < 4; pass++) {
    let added = false
    for (const id of deriveUnlocks({ unlocked, counters: s.counters }, p)) {
      if (!have.has(id)) { have.add(id); unlocked.push(id); added = true }
    }
    if (!added) break
  }
  return { unlocked, counters: s.counters }
}

// ---------------------------------------------------------------------------
// What a badge looks like right now
// ---------------------------------------------------------------------------

/** The ring the game draws. `none` is a locked badge's neutral ring. */
export type FrameKind =
  | { kind: 'none' }
  | { kind: 'track'; glow: string; ground: string }
  | { kind: 'tier'; tier: TierName }
  | { kind: 'difficulty'; won: readonly Difficulty[] }
  | { kind: 'single'; color: string }

export interface BadgeView {
  badge: BadgeDef
  /** At least one of its achievements is earned (on this circuit, for a track badge). */
  earned: boolean
  frame: FrameKind
  /** Highest tier reached for a tiered badge, 0 for none; unused otherwise. */
  tier: number
  /** The corner word: BRONZE, EARNED, LOCKED, 2 / 4 ... */
  tag: string
  /** The sentence under the name: the next thing to do, or what was done. */
  how: string
  /** "37 / 100 drifts", or empty where there is no partial credit to show. */
  progressText: string
  /** 0..1 toward the next tier (or the only one). 1 when complete. */
  progress: number
  /** Everything is earned: top tier, every difficulty, or the single itself. */
  complete: boolean
}

/**
 * The view of one badge, for one circuit when it is a track badge.
 *
 * Composed here rather than in the UI, as `catalogueFor` is in avatars.ts, so
 * the main-menu wall, the in-race panel, the results strip and the toast
 * cannot each phrase the same state differently.
 */
export function badgeView(
  b: BadgeDef, s: AchievementSnapshot, p?: ProfileCounts | null, trackId?: string | null,
): BadgeView {
  const have = new Set(s.unlocked)
  if (b.kind === 'track') {
    const c = ACH_CIRCUIT_BY_ID.get(trackId ?? '') ?? ACH_CIRCUITS[0]
    const a = ACHIEVEMENT_BY_ID.get(trackAchId(b.id, c.id))
    const earned = have.has(trackAchId(b.id, c.id))
    return {
      badge: b, earned,
      frame: earned ? { kind: 'track', glow: c.glow, ground: c.ground } : { kind: 'none' },
      tier: 0, tag: earned ? 'EARNED' : 'LOCKED', how: a?.how ?? b.how,
      progressText: '', progress: earned ? 1 : 0, complete: earned,
    }
  }
  if (b.kind === 'difficulty') {
    const won = DIFFICULTIES.filter((d) => have.has(`${b.id}:${d}`))
    const next = DIFFICULTIES.find((d) => !won.includes(d))
    return {
      badge: b, earned: won.length > 0,
      frame: won.length > 0 ? { kind: 'difficulty', won } : { kind: 'none' },
      tier: 0,
      tag: won.length === DIFFICULTIES.length ? 'COMPLETE' : `${won.length} / ${DIFFICULTIES.length}`,
      how: next ? `Win a race on ${DIFFICULTY_SPECS[next].label}.` : 'Won on every difficulty.',
      progressText: `${won.length} / ${DIFFICULTIES.length} difficulties`,
      progress: won.length / DIFFICULTIES.length,
      complete: won.length === DIFFICULTIES.length,
    }
  }
  if (b.kind === 'tiered') {
    let tier = 0
    for (let i = 0; i < b.tiers.length; i++) if (have.has(tierId(b.id, i + 1))) tier = i + 1
    const value = badgeValue(b, s, p)
    // The derived tier can be ahead of the stored one for a moment -- a
    // profile that has just arrived -- so the frame follows whichever is
    // higher. It can never be behind: unlocks are not taken away.
    for (let i = 0; i < b.tiers.length; i++) if (value >= b.tiers[i]) tier = Math.max(tier, i + 1)
    const complete = tier >= b.tiers.length
    const top = b.tiers[b.tiers.length - 1]
    const next = complete ? top : b.tiers[tier]
    const name = tier > 0 ? TIER_NAMES[tier - 1] : null
    return {
      badge: b, earned: tier > 0,
      frame: name ? { kind: 'tier', tier: name } : { kind: 'none' },
      tier,
      tag: name ? TIER_LABEL[name].toUpperCase() : 'LOCKED',
      how: complete ? doneSentence(b, top) : tierSentence(b, next),
      // A finished badge shows the count on its own: "1,204 drifts" reads as a
      // tally, where "1,204 / 1,000" reads as a bar that has overflowed.
      progressText: complete
        ? `${commas(value)} ${b.unit}`
        : `${commas(Math.min(value, next))} / ${commas(next)} ${b.unit}`,
      progress: complete ? 1 : Math.max(0, Math.min(1, value / next)),
      complete,
    }
  }
  const earned = have.has(b.id)
  return {
    badge: b, earned,
    frame: earned ? { kind: 'single', color: CATEGORY_COLOR[b.category] } : { kind: 'none' },
    tier: 0, tag: earned ? 'EARNED' : 'LOCKED', how: b.how,
    progressText: singleProgress(b, have),
    progress: earned ? 1 : singleFraction(b, have),
    complete: earned,
  }
}

/** Partial credit exists for the three set-of-others singles, and only them. */
function singleProgress(b: BadgeDef, have: ReadonlySet<string>): string {
  if (b.id === 'world-tour' || b.id === 'perfectionist') {
    const badge = b.id === 'world-tour' ? 'track-victory' : 'track-perfect'
    const n = ACH_CIRCUITS.filter((c) => have.has(trackAchId(badge, c.id))).length
    return `${n} / ${ACH_CIRCUITS.length} circuits`
  }
  if (b.id === 'full-garage') {
    const n = CHASSIS.filter((c) => have.has(winMark(c.id))).length
    return `${n} / ${CHASSIS.length} chassis`
  }
  return ''
}

function singleFraction(b: BadgeDef, have: ReadonlySet<string>): number {
  if (b.id === 'world-tour' || b.id === 'perfectionist') {
    const badge = b.id === 'world-tour' ? 'track-victory' : 'track-perfect'
    return ACH_CIRCUITS.filter((c) => have.has(trackAchId(badge, c.id))).length / ACH_CIRCUITS.length
  }
  if (b.id === 'full-garage') {
    return CHASSIS.filter((c) => have.has(winMark(c.id))).length / CHASSIS.length
  }
  return 0
}

/** The frame an achievement earns on its own -- for a toast or the results strip. */
export function frameOfAchievement(a: AchievementDef): FrameKind {
  const b = BADGE_BY_ID.get(a.badge)
  if (!b) return { kind: 'none' }
  if (b.kind === 'track') {
    const c = ACH_CIRCUIT_BY_ID.get(a.trackId ?? '')
    return c ? { kind: 'track', glow: c.glow, ground: c.ground } : { kind: 'none' }
  }
  if (b.kind === 'tiered') return { kind: 'tier', tier: TIER_NAMES[Math.max(0, a.tier - 1)] }
  if (b.kind === 'difficulty') return { kind: 'difficulty', won: a.difficulty ? [a.difficulty] : [] }
  return { kind: 'single', color: CATEGORY_COLOR[b.category] }
}

/** Earned of total, for the whole wall or one circuit's eight. */
export function completion(s: AchievementSnapshot, trackId?: string): { earned: number; total: number } {
  const have = new Set(s.unlocked)
  const list = trackId ? ACHIEVEMENTS.filter((a) => a.trackId === trackId) : ACHIEVEMENTS
  let earned = 0
  for (const a of list) if (have.has(a.id)) earned++
  return { earned, total: list.length }
}

// ---------------------------------------------------------------------------
// The art
// ---------------------------------------------------------------------------

/** Published directory for the badge art, relative to the site root. */
export const BADGE_DIR = 'badges/'

const HAS_BADGE_ART: ReadonlySet<string> = new Set(BADGE_ART)

export function hasBadgeArt(id: string): boolean {
  return HAS_BADGE_ART.has(id)
}

const LARGEST: ArtSize = ART_SIZES[ART_SIZES.length - 1]

/** The ONE place a badge file path is built. See `srcFor` in avatars.ts. */
export function badgeSrc(id: string, size: ArtSize = LARGEST): string {
  return BADGE_DIR + id + '-' + size + '.webp'
}

/**
 * What to draw for a badge at `px` DEVICE pixels -- CSS size times the pixel
 * ratio, exactly as `portraitFor` takes it -- so a 56px tile on a 3x phone
 * gets the 256 and the detail card gets the 512 without either paying for the
 * other. A badge with no file yet gets its stand-in, and a file dropped in
 * later through tools/import-art.mjs replaces it everywhere with no code
 * change, because this is the only function anybody calls.
 */
export function badgeArtFor(id: string, px: number = LARGEST): string {
  return hasBadgeArt(id) ? badgeSrc(id, artSizeFor(px)) : standInBadge(id)
}

/**
 * THE EIGHT GLYPHS FOR THE BADGES WHOSE ART HAS NOT ARRIVED.
 *
 * A CLEAN emblem, deliberately unlike `placeholderPortrait`, which is built to
 * look unfinished (dashed ring, hatching) so nobody mistakes it for a face.
 * A badge is a symbol rather than a painting, and a flat symbol in the right
 * colour is what the finished art will read as at 48px anyway -- so the wall
 * can be judged today and the eight will not look broken in a screenshot.
 * What it is NOT is painted: no rim light, no metal. The finished art will be
 * obviously richer, which is the tell.
 *
 * Drawn on the brief's own ground (#0a0f1e with a glow in the category colour)
 * inside the central 70%, with NO ring -- the game draws that, exactly as it
 * does round the real art. Coordinates are a 100-unit square.
 */
const GLYPHS: Readonly<Record<string, (c: string) => string>> = {
  // A shutter closing over a chequered line, with the flash.
  'photo-finish': (c) =>
    '<rect x="18" y="46" width="64" height="10" fill="#0a0f1e"/>' +
    [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
      `<rect x="${18 + i * 8}" y="${i % 2 ? 51 : 46}" width="8" height="5" fill="${c}"/>`).join('') +
    `<circle cx="50" cy="51" r="25" fill="none" stroke="${c}" stroke-width="5"/>` +
    [0, 60, 120, 180, 240, 300].map((a) =>
      `<path d="M50 51 L50 28" stroke="${c}" stroke-width="3" transform="rotate(${a + 20} 50 51)"/>`).join('') +
    `<circle cx="50" cy="51" r="7" fill="#0a0f1e" stroke="${c}" stroke-width="3"/>` +
    '<path d="M74 24 L77 30 L83 33 L77 36 L74 42 L71 36 L65 33 L71 30Z" fill="#ffffff"/>',
  // A crown built from lightning.
  'combo-king': (c) =>
    `<path d="M24 66 L20 34 L36 48 L50 24 L64 48 L80 34 L76 66Z" fill="${c}" fill-opacity="0.9"/>` +
    '<path d="M24 66 L76 66 L74 74 L26 74Z" fill="#ffffff" fill-opacity="0.85"/>' +
    '<path d="M52 36 L44 52 L51 52 L46 64 L58 46 L51 46 L56 36Z" fill="#0a0f1e"/>' +
    `<circle cx="20" cy="33" r="4" fill="${c}"/><circle cx="50" cy="23" r="4" fill="#ffffff"/>` +
    `<circle cx="80" cy="33" r="4" fill="${c}"/>`,
  // A stack of hexagonal credit chips, the top one lit.
  'high-roller': (c) =>
    [70, 58, 46].map((y, i) =>
      `<path d="M28 ${y} L39 ${y - 8} L61 ${y - 8} L72 ${y} L61 ${y + 8} L39 ${y + 8}Z" ` +
      `fill="${i === 2 ? c : '#0a0f1e'}" stroke="${c}" stroke-width="3"/>`).join('') +
    '<path d="M38 46 L44 42 L56 42 L62 46 L56 50 L44 50Z" fill="#ffffff" fill-opacity="0.8"/>' +
    `<path d="M50 20 L50 30 M36 24 L40 32 M64 24 L60 32" stroke="${c}" stroke-width="3" stroke-linecap="round"/>`,
  // A vault door ajar, light spilling out of the gap.
  'tycoon': (c) =>
    '<path d="M50 20 L84 34 L84 68 L50 82Z" fill="#ffffff" fill-opacity="0.18"/>' +
    `<circle cx="44" cy="51" r="28" fill="#0a0f1e" stroke="${c}" stroke-width="5"/>` +
    `<circle cx="44" cy="51" r="9" fill="${c}"/>` +
    [0, 72, 144, 216, 288].map((a) =>
      `<path d="M44 51 L44 31" stroke="${c}" stroke-width="4" stroke-linecap="round" transform="rotate(${a} 44 51)"/>`).join('') +
    [0, 90, 180, 270].map((a) =>
      `<circle cx="44" cy="27" r="2.5" fill="#ffffff" transform="rotate(${a + 45} 44 51)"/>`).join(''),
  // Three masks fanned like a display case.
  'collector': (c) =>
    [-26, 0, 26].map((a, i) =>
      `<g transform="rotate(${a} 50 78)"><path d="M36 26 Q50 18 64 26 L64 48 Q50 64 36 48Z" ` +
      `fill="${i === 1 ? c : '#0a0f1e'}" stroke="${c}" stroke-width="3"/>` +
      `<path d="M41 36 L47 36 M53 36 L59 36" stroke="${i === 1 ? '#0a0f1e' : '#ffffff'}" ` +
      'stroke-width="3" stroke-linecap="round"/></g>').join(''),
  // A car at the top of its arc, over the lip of a ramp.
  'airtime': (c) =>
    `<path d="M16 76 L40 76 L40 64Z" fill="${c}" fill-opacity="0.55"/>` +
    `<path d="M40 64 Q58 20 84 60" fill="none" stroke="${c}" stroke-width="3" stroke-dasharray="4 5"/>` +
    `<g transform="rotate(-8 58 36)"><path d="M44 38 L50 30 L66 30 L72 38 L72 44 L44 44Z" fill="${c}"/>` +
    '<path d="M52 32 L64 32 L67 37 L50 37Z" fill="#0a0f1e"/>' +
    '<circle cx="50" cy="45" r="4" fill="#ffffff"/><circle cx="66" cy="45" r="4" fill="#ffffff"/></g>' +
    `<path d="M22 32 L36 32 M18 40 L32 40" stroke="${c}" stroke-width="3" stroke-linecap="round"/>`,
  // Three identical trophies on one plinth.
  'clean-sweep': (c) =>
    [30, 50, 70].map((x) =>
      `<path d="M${x - 8} 34 L${x + 8} 34 L${x + 6} 48 Q${x} 54 ${x - 6} 48Z" fill="${c}"/>` +
      `<path d="M${x - 2} 53 L${x + 2} 53 L${x + 3} 62 L${x - 3} 62Z" fill="${c}"/>` +
      `<path d="M${x - 5} 38 L${x - 1} 38" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>`).join('') +
    '<rect x="18" y="62" width="64" height="8" rx="2" fill="#ffffff" fill-opacity="0.85"/>' +
    `<rect x="22" y="70" width="56" height="6" fill="${c}" fill-opacity="0.6"/>`,
  // Two planets on one orbit, a crown between them, signal rings.
  'online-victor': (c) =>
    `<ellipse cx="50" cy="56" rx="34" ry="12" fill="none" stroke="${c}" stroke-width="3"/>` +
    `<circle cx="20" cy="56" r="9" fill="${c}"/><circle cx="80" cy="56" r="9" fill="#ffffff" fill-opacity="0.9"/>` +
    `<path d="M38 44 L36 28 L44 35 L50 24 L56 35 L64 28 L62 44Z" fill="${c}"/>` +
    `<path d="M26 22 Q20 28 26 34 M74 22 Q80 28 74 34" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round"/>` +
    `<path d="M18 16 Q8 28 18 40 M82 16 Q92 28 82 40" fill="none" stroke="${c}" stroke-opacity="0.55" stroke-width="3" stroke-linecap="round"/>`,
}

/** Badge ids with a hand-drawn stand-in. Asserted against BADGE_ART by a test. */
export const STAND_IN_IDS: readonly string[] = Object.keys(GLYPHS)

/**
 * The stand-in for a badge with no file, as an inline SVG data URI.
 *
 * SVG, and a data URI, for exactly the reasons `placeholderPortrait` gives:
 * no canvas (this module runs on a server and in tests) and no second path
 * convention for a consumer to know about. A badge with neither art nor a
 * glyph -- which the test forbids -- gets a plain category disc rather than a
 * broken image.
 */
export function standInBadge(id: string): string {
  const b = BADGE_BY_ID.get(id)
  const c = b ? CATEGORY_COLOR[b.category] : '#7d90b0'
  const glyph = GLYPHS[id]?.(c) ?? `<circle cx="50" cy="50" r="18" fill="${c}"/>`
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100" ' +
    'role="img" aria-label="' + xml(b ? b.name : id) + '">' +
    '<defs><radialGradient id="g" cx="50%" cy="50%" r="50%">' +
    `<stop offset="0" stop-color="${c}" stop-opacity="0.34"/>` +
    `<stop offset="0.62" stop-color="${c}" stop-opacity="0.08"/>` +
    '<stop offset="1" stop-color="#0a0f1e" stop-opacity="0"/></radialGradient></defs>' +
    '<rect width="100" height="100" fill="#0a0f1e"/>' +
    '<rect width="100" height="100" fill="url(#g)"/>' +
    glyph +
    '</svg>'
  // encodeURIComponent, not base64, for the reason avatars.ts gives: `#` in a
  // colour would otherwise end the URI at a fragment.
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg)
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
