/**
 * SpaceGen Racing — what a submitted run is allowed to claim.
 * ---------------------------------------------------------------------------
 * Shared by the browser and by the Netlify function, on purpose: the client
 * checks so an impossible run is never sent, and the SERVER checks because the
 * client is a web page and anyone can post whatever they like to the endpoint.
 * Only the server's copy is load-bearing.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT.
 *
 * It is a plausibility filter. It rejects figures the game could not physically
 * produce, which stops casual nonsense -- a lap of 0.4 seconds, a score with an
 * extra digit, a submission spraying a hundred entries a minute.
 *
 * It is NOT proof a run happened. A determined forger can read these bounds off
 * the bundle and post something just inside them, and nothing here can tell
 * that from a real lap. Anything stronger needs the run's input trace
 * re-simulated server side, which is a pass of its own. Until then the board
 * says "unverified" on screen rather than implying a trust it has not earned.
 *
 * THE BOUNDS ARE DERIVED, NOT PICKED.
 *
 * The minimum lap comes from SPEED_CEILING, a hard clamp in vehicle.ts that no
 * car can exceed under any combination of boost, slipstream and downhill: a lap
 * cannot take less than the track's own length divided by a speed the sim will
 * not allow. That makes the floor provable rather than fitted, and it stays
 * correct if the roster gets faster.
 */

/** vehicle.ts's hard clamp, m/s. Nothing in the sim may exceed it, ever. */
export const SPEED_CEILING = 120

/**
 * Track centreline lengths in metres, measured from the built Track.
 *
 * Duplicated here rather than imported because the Netlify function must not
 * pull in the whole track geometry -- these four numbers against several
 * thousand lines of spline and mesh definition. tests/verify.test.ts asserts
 * they still match the real tracks, so the copy cannot drift silently.
 */
export const TRACK_LENGTH: Record<string, number> = {
  rustfall: 2479.6,
  cryostatic: 2892.0,
  aetherion: 3212.5,
  hollowchoir: 3255.2,
}

/** Nobody drives a lap in under this. Derived, see the header. */
export function minLapSeconds(trackId: string): number {
  const len = TRACK_LENGTH[trackId]
  if (!len) return 0
  return len / SPEED_CEILING
}

/** Beyond this a "lap" is a browser tab left open, not a result. */
export const MAX_LAP_SECONDS = 900
export const MAX_RACE_SECONDS = 3600

/**
 * The fastest the score can possibly climb: the top drift rate times the combo
 * ceiling. rules.ts DRIFT_RATE tops out at 800/s and COMBO_MAX is 16.
 */
export const MAX_SCORE_PER_SECOND = 800 * 16

/**
 * Headroom for everything that is not the per-second drift accrual -- entry and
 * release bonuses, chains, knocks, lap and finish placement, all multiplied.
 * Deliberately generous: this filter exists to catch a score with an extra
 * digit, not to referee a good run.
 */
export const SCORE_HEADROOM = 500_000

export interface GlobalRun {
  trackId: string
  name: string
  chassisId: string
  pilotId: string
  /** Best lap, seconds. The figure the global board ranks on. */
  lap: number
  /** Total race time, seconds. 0 for a DNF. */
  raceTime: number
  score: number
  position: number
}

export type Rejection =
  | 'unknown-track' | 'bad-name' | 'lap-impossible' | 'lap-absurd'
  | 'race-absurd' | 'race-before-lap' | 'score-impossible' | 'bad-position'

/**
 * Why this run cannot be accepted, or null if it is plausible.
 *
 * Returns the REASON rather than a boolean so the server can log which bound
 * fired. A filter that only says "no" gives you no way to find out it is
 * rejecting honest runs.
 */
export function rejectRun(run: GlobalRun): Rejection | null {
  const len = TRACK_LENGTH[run.trackId]
  if (!len) return 'unknown-track'

  const name = (run.name || '').trim()
  if (name.length < 1 || name.length > 12) return 'bad-name'

  if (!isFinite(run.lap) || run.lap < minLapSeconds(run.trackId)) return 'lap-impossible'
  if (run.lap > MAX_LAP_SECONDS) return 'lap-absurd'

  if (!isFinite(run.raceTime) || run.raceTime < 0) return 'race-absurd'
  if (run.raceTime > MAX_RACE_SECONDS) return 'race-absurd'
  // A race cannot be shorter than its own fastest lap. Catches a swapped pair.
  if (run.raceTime > 0 && run.raceTime < run.lap - 0.01) return 'race-before-lap'

  if (!isFinite(run.score) || run.score < 0) return 'score-impossible'
  const seconds = run.raceTime > 0 ? run.raceTime : run.lap
  if (run.score > seconds * MAX_SCORE_PER_SECOND + SCORE_HEADROOM) return 'score-impossible'

  if (!Number.isInteger(run.position) || run.position < 1 || run.position > 16) {
    return 'bad-position'
  }
  return null
}

/**
 * A name safe to render for every other player on the board.
 *
 * Uppercase A-Z, digits, space, dash. Everything else is dropped rather than
 * escaped: this string is shown to strangers, and the smallest character set
 * that still lets someone write their name is the one with no surprises in it
 * -- no right-to-left overrides, no zero-width joiners, no combining marks
 * stacked into a column of glyphs over the row below.
 */
export function cleanName(raw: string): string {
  return (raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9 \-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12)
}
