/**
 * SpaceGen Racing — what everything is worth.
 * ---------------------------------------------------------------------------
 * One table, in one file, so the economy can be argued about in one place. Kept
 * out of tuning.ts on purpose: tuning.ts is the SIMULATION's constants and
 * every number in it can move a determinism hash or a balance gate. Nothing
 * here can move either, and mixing the two invites someone to treat a scoring
 * tweak as a physics change.
 *
 * THE SHAPE OF THE ECONOMY
 *
 * The brief was that the number should climb furiously while drifting, because
 * that is what makes a player hold the slide one more beat. So the drift is
 * paid THREE times over -- entering, holding, and cashing in -- and the combo
 * multiplies all three. A committed Singularity run is worth two orders of
 * magnitude more than tapping the button, and that ratio is the design.
 *
 * Everything else is priced against a single reference: A GOOD LAP. Placement
 * pays real points so a racer who wins gets a real score, but it can never be
 * the whole score, or the leaderboard becomes a second copy of the results
 * table and the drifting is decoration.
 */

/** Points for entering a slide at all. Small: the intent, not the achievement. */
export const DRIFT_START = 40

/**
 * Points per SIM second of held slide, by drift tier (-1 = charging, 0..3 are
 * Spark / Flare / Nova / Singularity).
 *
 * The steps are deliberately steep. Tier 3 pays 6.7x tier -1, so the counter
 * visibly accelerates as each rung is banked -- the rate change IS the feedback
 * that the rung landed, arriving at the same moment as the ring and the sound.
 * A flat rate would make a long slide feel like a long wait.
 */
export const DRIFT_RATE = [120, 200, 340, 560, 800] as const

/** Cashing a slide in, by tier. -1 banks nothing: a tap is not a drift. */
export const DRIFT_RELEASE = [250, 600, 1200, 2200] as const

/**
 * Linking a slide inside the chain buffer, by chain depth (1st link, 2nd, ...).
 * Capped by CHAIN_MAX so a player cannot farm an endless chain on a skidpad.
 */
export const CHAIN_BONUS = [400, 700, 1100, 1600, 2200] as const

/**
 * Seconds after cashing a slide in during which the next slide counts as
 * LINKED. Vince asked for one second and one second is right: the sim's own
 * chainWindow is 0.40s and exists to gate a physics bonus, which is a tighter
 * job than "did the player mean these as one sequence".
 *
 * Kept as a separate number from T.drift.chainWindow rather than reusing it,
 * because they answer different questions and tying them together means a
 * physics tune silently re-prices the leaderboard.
 */
export const CHAIN_WINDOW = 1.0
export const CHAIN_MAX = CHAIN_BONUS.length

/**
 * KNOCKING OTHER CARS.
 *
 * `bump` is fired on BOTH cars in a collision with the same force, so the event
 * alone cannot say who hit whom -- and paying both would reward being rammed.
 * The discriminator is the normal: `n` points from this racer toward the other,
 * so a positive dot with our own velocity means WE were driving into THEM.
 *
 * `force` is closing speed along that normal in m/s. The floor keeps the
 * constant nudging of a tight pack from paying anything; only a real shunt
 * scores.
 */
export const KNOCK_MIN_FORCE = 6.0
export const KNOCK_BASE = 250
export const KNOCK_PER_FORCE = 40
export const KNOCK_MAX = 1200
/** One knock per this many seconds, so grinding a car down a wall pays once. */
export const KNOCK_COOLDOWN = 0.6

/** Completing a lap, by position at that moment (index 0 = P1). */
export const LAP_PLACE = [1000, 820, 680, 560, 460, 380, 310, 250] as const

/** Finishing, by final position. The single biggest award in the game. */
export const TRACK_PLACE = [6000, 4400, 3300, 2500, 1900, 1450, 1100, 850] as const

// ---------------------------------------------------------------------------
// The combo multiplier
// ---------------------------------------------------------------------------

/**
 * THE COMBO MULTIPLIES EVERYTHING, INCLUDING PLACEMENT.
 *
 * That was a deliberate choice and it is the one that makes the system hang
 * together: if placement paid flat, the optimal play would be to stop drifting
 * near the finish and bank a safe result. Multiplying it means the last corner
 * is worth taking sideways, which is the behaviour the whole feature exists to
 * encourage.
 */

/** Combo rungs. Crossing one fires a callout; the value IS the multiplier. */
export const COMBO_RUNGS = [2, 3, 5, 8, 12, 16] as const
export const COMBO_MAX = COMBO_RUNGS[COMBO_RUNGS.length - 1]

/**
 * Combo gained per sim-second of held slide, by tier. Reaching x16 from cold
 * takes roughly 19s of Singularity-grade drifting, or rather more realistically
 * a chain of good slides -- because links pay a lump on top.
 */
export const COMBO_RATE = [0.25, 0.40, 0.60, 0.85, 1.15] as const

/** Combo added outright for each link in a chain. */
export const COMBO_PER_CHAIN = 0.75

/**
 * GRACE, THEN DECAY. The combo does not fall off the instant a slide ends --
 * a straight between two corners is not a mistake and should not be punished.
 * It holds for `COMBO_GRACE` seconds and then bleeds away, so a run survives
 * the straights but not idleness.
 */
export const COMBO_GRACE = 2.2
export const COMBO_DECAY = 1.35

/**
 * A hard crash resets the combo to 1. This is the only real risk in the system
 * and it is what makes a long run tense rather than inevitable.
 *
 * The threshold is well above a scrape: `wall.force` is the closing rate on the
 * barrier line, and a car holding a drift against the outside of a corner reads
 * near zero on it by design (see the RacerEvent doc). So leaning on a wall
 * through a corner keeps the combo; hitting one loses it.
 */
export const COMBO_BREAK_FORCE = 11.0

/** The label shown on each award popup. The receipt, not the praise. */
export const AWARD_LABEL: Record<string, string> = {
  driftStart: 'DRIFT',
  driftHold: 'HELD',
  driftRelease: 'RELEASE',
  chain: 'CHAIN',
  knock: 'KNOCK',
  lapPlace: 'LAP',
  trackPlace: 'FINISH',
}

/** Clamp an index into a table that may be shorter than the field. */
export function byIndex(table: readonly number[], i: number): number {
  if (!isFinite(i)) return table[table.length - 1]
  const k = Math.max(0, Math.min(table.length - 1, Math.floor(i)))
  return table[k]
}

/** Which combo rung a multiplier has reached. -1 below the first rung. */
export function rungOf(combo: number): number {
  let r = -1
  for (let i = 0; i < COMBO_RUNGS.length; i++) if (combo >= COMBO_RUNGS[i]) r = i
  return r
}

/** How far between the current rung and the next, 0..1. */
export function rungProgress(combo: number): number {
  const r = rungOf(combo)
  const lo = r < 0 ? 1 : COMBO_RUNGS[r]
  if (r >= COMBO_RUNGS.length - 1) return 1
  const hi = COMBO_RUNGS[r + 1]
  return Math.max(0, Math.min(1, (combo - lo) / (hi - lo)))
}
