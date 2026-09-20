import { TUNING as T } from './tuning'

/**
 * THE AI DIFFICULTY LADDER, AND THE ONE RULE THAT GOVERNS IT: NORMAL IS TODAY.
 *
 * Before this file the field was always `2 + (slot % 3)` -- skill bands 2, 3
 * and 4 of a five-band scale -- written out longhand in six places
 * (`main.ts` twice, `circuit.ts`, `net/mock.ts`, `net/live.ts`, and
 * `tools/headless.ts`). That is the game every lap time, every balance
 * measurement and the pinned determinism hash were taken against, so Normal
 * has to reproduce it to the last bit or the whole measured history of this
 * project stops meaning anything.
 *
 * "To the last bit" is not a figure of speech here and it is the reason the
 * legacy rows below are COMPUTED rather than typed. `1.4 - 2 * 0.12` is
 * 1.1599999999999999 in IEEE754, not 1.16; a table of hand-written literals
 * would have been one ULP out on three of the five rows, every AI input would
 * have differed in the last place, and `tests/bridges.test.ts` would have gone
 * red for a change that was meant to be a refactor. So rows 0-4 are the old
 * expressions, evaluated. `tests/difficulty.test.ts` re-derives them
 * independently and asserts `Object.is`.
 *
 *   easy    bands 0,0,1    re-cut; see LOW_BANDS
 *   normal  bands 2,3,4    exactly the game as it has always played
 *   hard    bands 5,6,7    new
 *   expert  bands 8,9,10   new
 *
 * WHY A BAND TABLE AT ALL, rather than extending the formulas. The formulas
 * were affine in `skill` and they do not extend: `mistakeChance * (5 - skill)`
 * goes NEGATIVE at band 6, which reads as "never makes a mistake" -- and an
 * opponent that literally cannot err is not a hard opponent, it is a wall. A
 * table lets the top of the ladder taper toward a floor instead of through it,
 * and it lets a band say something the formulas could not (see `caution`).
 */
export interface SkillBand {
  /** Fraction of the chassis top speed the AI is willing to ask for. */
  readonly speed: number
  /** Multiplies `T.ai.reactionTime`. Lower is quicker on the stick. */
  readonly reaction: number
  /** Multiplies `T.ai.mistakeChance`. Never zero -- see the header. */
  readonly mistake: number
  /** ADDS to `T.ai.driftCommitment`. It is a probability, so it saturates. */
  readonly drift: number
  /**
   * MULTIPLIES `T.ai.corneringCaution`, and this is the band table's reason
   * for existing.
   *
   * Caution is how close to the friction limit the AI corners, and it was
   * flat at 0.86 for every skill band -- so the only thing separating a good
   * AI from a bad one was a scale on top speed, which does nothing on a
   * circuit that is mostly corners. tuning.ts's own note on `skillSpeed`
   * says the two knobs were deliberately decoupled ("caution stays where the
   * racing wants it and this carries the pace"), and that was right when
   * every car shared one caution. It is exactly the wrong split once the
   * point is to make some cars BETTER: speed saturates at band 6, because a
   * ceiling above the car's own top speed is not a ceiling. Everything above
   * that is corner speed.
   *
   * EXACTLY 1 FOR BANDS 0-4, so multiplying is an identity and the legacy
   * rows cannot drift by a bit.
   */
  readonly caution: number
  /** Multiplies `T.ai.bridgeHorizon` -- how far ahead the span planner sees. */
  readonly bridge: number
  /** Probability of a PERFECT rocket start. Read by `Race.aiRocketStart`. */
  readonly rocket: number
}

/**
 * Bands 0 and 1: THE BOTTOM OF THE LADDER, AND THEY ARE NEW DESPITE THE INDEX.
 *
 * The shipped scale had five bands and used three. `2 + (slot % 3)` is the
 * only expression in the game that ever set an `aiSkill`, in all six places it
 * appears, and `standInSkill` for a dropped multiplayer peer returns the same
 * thing -- so bands 0 and 1 were reachable only as the placeholder value on a
 * HUMAN slot, which `stepAI` never reads because it is never called for a car
 * a person is driving. They were documented and dead. That makes them free to
 * re-cut, with no migration and no hash risk, and Easy needed them re-cut:
 *
 * WITH THE OLD ROWS, EASY WAS NOT EASY, and the probe said so before any of
 * this was written. Easy ran bands 0,1,2 against a reference driver at band 3
 * and moved it from P4.38 to P4.25 -- an eighth of a place, on a scale where
 * the step to Hard is worth two and a half. The reason is visible in the old
 * numbers: the top of an Easy field was band 2, which is the SLOWEST CAR IN A
 * NORMAL FIELD. "Easy" was the back of a Normal grid, and the back of a Normal
 * grid still races you.
 *
 * So two things changed together. Easy's spread narrowed to bands 0 and 1 only
 * (see `DifficultySpec.spread`), and these two rows moved down to where a
 * beginner can actually get past them. `caution` is the lever at both ends of
 * the ladder: 0.930 x 0.86 is 0.80 of the friction limit, a car that visibly
 * brakes early for a corner, exactly as band 10's 1.090 is a car that visibly
 * does not. Speed alone could not do this -- it never can on a lap that is
 * mostly corners, which is the whole argument in `SkillBand.caution`.
 *
 * `T.ai.skillSpeed[0]` and `[1]` (0.867, 0.897) are superseded by these rows
 * and no longer feed the ladder. Their comment in tuning.ts is left as the
 * historical record of a scale that shipped with its bottom two rungs unused.
 */
const LOW_BANDS: readonly SkillBand[] = [
  { speed: 0.835, reaction: 1.75, mistake: 8.0, drift: -0.100, caution: 0.930, bridge: 0.55, rocket: 0.07 },
  { speed: 0.880, reaction: 1.45, mistake: 5.5, drift: -0.020, caution: 0.965, bridge: 0.66, rocket: 0.14 },
]

/**
 * Bands 2-4, the three the game has always actually raced, rebuilt from the
 * expressions that produced them. Do not replace these with literals; see the
 * header.
 */
function legacyBand(k: number): SkillBand {
  return {
    speed: T.ai.skillSpeed[k],
    reaction: 1.4 - k * 0.12,
    mistake: 5 - k,
    drift: k * 0.05,
    caution: 1,
    bridge: T.ai.bridgeHorizonSkill[k],
    rocket: 0.12 + k * 0.06,
  }
}

/**
 * Bands 5-10, which are new and therefore free to be literals.
 *
 * READ THE COLUMNS, NOT THE ROWS. Each one tapers rather than continuing its
 * old slope, because every one of these quantities has a floor that means
 * something:
 *
 *   speed     reaches 1.000 at band 6 and stops. `ceiling = topSpeed * speed`,
 *             so anything above 1 is not a faster car, it is the absence of a
 *             limit. Bands 7-10 are not slower than each other, they are
 *             better at corners.
 *   reaction  0.44 of 0.11s is 48ms, about three frames. Below that the
 *             steering stops being a held value and starts being per-frame
 *             noise, which looks like a twitch rather than skill.
 *   mistake   0.10 of 0.020 is one line-kick per ~500 opportunities. Small,
 *             deliberately not zero: the top of the ladder should still be
 *             beatable by a player who drives a clean race.
 *   drift     saturates at 1.00 total (0.72 base + 0.28) -- always drift when
 *             the corner asks for one.
 *   caution   0.86 -> 0.937 of the friction limit. The margin at band 10 is
 *             6.3%, which is what is left to absorb a bump, a surface change
 *             or its own steering error. Measured rather than picked: see
 *             `claude/spacegen-racing-difficulty-and-achievements.md`.
 *   bridge    stays at the full horizon. The planner cannot usefully see past
 *             260m -- the throttle controller cannot deliver a speed change
 *             planned much further out than that -- so this is one dial the
 *             top of the ladder does not get to turn.
 *   rocket    0.78, not 1.00. An Expert field that ALL launches perfectly is
 *             a first corner the player can never win; at 0.78 roughly one
 *             car in five still merely gets a good start.
 */
const HIGH_BANDS: readonly SkillBand[] = [
  { speed: 0.990, reaction: 0.80, mistake: 0.75, drift: 0.230, caution: 1.015, bridge: 1, rocket: 0.44 },
  { speed: 1.000, reaction: 0.70, mistake: 0.55, drift: 0.250, caution: 1.030, bridge: 1, rocket: 0.52 },
  { speed: 1.000, reaction: 0.62, mistake: 0.40, drift: 0.260, caution: 1.045, bridge: 1, rocket: 0.60 },
  { speed: 1.000, reaction: 0.55, mistake: 0.28, drift: 0.270, caution: 1.060, bridge: 1, rocket: 0.66 },
  { speed: 1.000, reaction: 0.49, mistake: 0.18, drift: 0.275, caution: 1.075, bridge: 1, rocket: 0.72 },
  { speed: 1.000, reaction: 0.44, mistake: 0.10, drift: 0.280, caution: 1.090, bridge: 1, rocket: 0.78 },
]

/** Bands 0-10. Index with `bandFor`, never with a raw `aiSkill`. */
export const SKILL_BANDS: readonly SkillBand[] = [
  ...LOW_BANDS,
  legacyBand(2), legacyBand(3), legacyBand(4),
  ...HIGH_BANDS,
]

/**
 * A racer's `aiSkill` -> the band that governs it.
 *
 * `aiSkill` arrives from `SimConfig`, which on the multiplayer path arrives
 * from a packet a peer wrote, so it is untrusted: round it and clamp it here
 * and nowhere else. Out-of-range is not an error to throw on -- a guest on an
 * older build sending band 4 must still race.
 */
export function bandFor(aiSkill: number): SkillBand {
  // NaN FIRST, AND IT IS NOT DEFENSIVE PADDING. Both comparisons below are
  // false for NaN, so `Math.round(NaN)` fell straight through them and indexed
  // the array with NaN, which is `undefined` -- and the next line of stepAI
  // reads `band.speed` off it and throws, inside the fixed-step sim, mid-race.
  // `tests/difficulty.test.ts` found this on the first run; the clamp read
  // correctly and was wrong anyway.
  if (!Number.isFinite(aiSkill)) return SKILL_BANDS[DIFFICULTY_SPECS[DEFAULT_DIFFICULTY].base]
  const k = Math.round(aiSkill)
  return SKILL_BANDS[k < 0 ? 0 : k >= SKILL_BANDS.length ? SKILL_BANDS.length - 1 : k]
}

/**
 * The storage key for anything kept PER TRACK AND PER DIFFICULTY -- records,
 * score boards, and whatever comes after them.
 *
 * NORMAL RETURNS THE BARE TRACK ID, AND THAT IS THE WHOLE MIGRATION.
 *
 * Every record and every board row that exists today was set against the only
 * field the game had, which is exactly the Normal field. So a pre-difficulty
 * save IS a Normal save, and the honest thing to do with it is leave it where
 * it is rather than move it and call that a migration. Easy, Hard and Expert
 * open new namespaces beside it; nothing is rewritten, nothing is read twice,
 * and a player who never touches the setting never notices this function
 * exists. A scheme that suffixed all four would have had to walk localStorage
 * on boot and rename keys, which is a data migration that can half-finish, to
 * arrive at the same place.
 */
export function scopeFor(trackId: string, difficulty: Difficulty): string {
  return difficulty === DEFAULT_DIFFICULTY ? trackId : `${trackId}@${difficulty}`
}

export type Difficulty = 'easy' | 'normal' | 'hard' | 'expert'

export const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard', 'expert']

export const DEFAULT_DIFFICULTY: Difficulty = 'normal'

export interface DifficultySpec {
  readonly id: Difficulty
  readonly label: string
  /** One line for the picker. Says what the player will FEEL, not the bands. */
  readonly blurb: string
  /** Lowest band in the field. Offsets in `spread` are added to it. */
  readonly base: number
  /**
   * The three bands a field is built from, as offsets on `base`, chosen by
   * `slot % 3`.
   *
   * It is a spec field rather than a fixed `+0,+1,+2` because Easy needs to be
   * NARROWER than the others, not just lower. A three-band spread starting at
   * 0 put a band-2 car at the front of an Easy grid -- the slowest car in a
   * Normal field -- and a grid whose leader is a Normal car is a Normal race
   * for anyone contesting the lead. Easy is [0,0,1]; everything above it keeps
   * the [0,1,2] pecking order the game has always had.
   */
  readonly spread: readonly [number, number, number]
  /**
   * Multiplies credits earned. Flat 1.00 on Normal so the existing wallet
   * balance and every number measured against it stay comparable.
   */
  readonly payout: number
}

/**
 * THE LADDER ITSELF.
 *
 * `base + (slot % 3)` keeps the three-band spread the field has always had --
 * a pecking order rather than eight identical cars -- and Normal's base of 2
 * is what makes `2 + (slot % 3)` come back out the other side unchanged.
 *
 * Easy is the exception and `spread` is why -- it runs two bands, not three,
 * and neither of them appears in a Normal field. Hard starts at 5, one clear
 * of Normal's fastest, so stepping up is a step and not a blur.
 *
 * `difficultyOfGrid` reads this table backwards, so the ranges must not
 * overlap or a grid would answer to two names. They do not, and
 * `tests/difficulty.test.ts` checks it rather than trusting the arithmetic
 * above to stay true when someone retunes a base.
 *
 * PAYOUTS. Normal is 1.00 by definition. Easy pays 0.70 rather than 1.00
 * because otherwise it is the correct way to farm credits and the rest of the
 * ladder is decoration. Hard and Expert pay 1.35 and 1.80 -- enough that a
 * player who can hold Expert banks roughly two and a half times an Easy run
 * for the same three laps, which is the ratio the wallet's own unlock costs
 * were spaced against.
 */
export const DIFFICULTY_SPECS: Readonly<Record<Difficulty, DifficultySpec>> = {
  easy: {
    id: 'easy',
    label: 'Easy',
    blurb: 'The field brakes early and wanders. Room to learn a track.',
    base: 0,
    spread: [0, 0, 1],
    payout: 0.70,
  },
  normal: {
    id: 'normal',
    label: 'Normal',
    blurb: 'A clean race wins it. The pace the game is balanced around.',
    base: 2,
    spread: [0, 1, 2],
    payout: 1.00,
  },
  hard: {
    id: 'hard',
    label: 'Hard',
    blurb: 'They carry more speed through corners and rarely miss a start.',
    base: 5,
    spread: [0, 1, 2],
    payout: 1.35,
  },
  expert: {
    id: 'expert',
    label: 'Expert',
    blurb: 'Near the limit every corner. One mistake is the race.',
    base: 8,
    spread: [0, 1, 2],
    payout: 1.80,
  },
}

/**
 * The AI skill for one grid slot at one difficulty.
 *
 * `slot` is the grid index, so the same slot gets the same band every race at
 * a given difficulty -- the field has a stable pecking order rather than being
 * reshuffled, which is what makes "the blue one is quick" a thing a player can
 * learn.
 */
export function skillForSlot(difficulty: Difficulty, slot: number): number {
  const spec = DIFFICULTY_SPECS[difficulty]
  const n = slot < 0 ? 0 : Math.floor(slot)
  return spec.base + spec.spread[n % 3]
}

/** Untrusted string -> a difficulty. Storage, packets and query strings. */
export function asDifficulty(v: unknown): Difficulty {
  return v === 'easy' || v === 'normal' || v === 'hard' || v === 'expert'
    ? v
    : DEFAULT_DIFFICULTY
}

/**
 * Which difficulty a grid was built at, read back from the skills themselves.
 *
 * The multiplayer packet carries per-slot `aiSkill` and NOT a difficulty name,
 * on purpose: the skills are what the sim consumes, so a name in the packet
 * would be a second source of truth that a guest could disagree with and
 * desync on. The lobby still wants to SAY "Hard", so it asks the grid instead
 * of being told. Returns null for a field that matches no tier -- a hand-built
 * grid, or a guest on a build with a different ladder -- and callers show the
 * raw bands rather than a wrong word.
 */
export function difficultyOfGrid(skills: readonly number[]): Difficulty | null {
  const ai = skills.filter((s) => Number.isFinite(s))
  if (ai.length === 0) return null
  for (const id of DIFFICULTIES) {
    const spec = DIFFICULTY_SPECS[id]
    const lo = spec.base + Math.min(...spec.spread)
    const hi = spec.base + Math.max(...spec.spread)
    if (ai.every((s) => Math.round(s) >= lo && Math.round(s) <= hi)) return id
  }
  return null
}
