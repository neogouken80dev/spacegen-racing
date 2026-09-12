/**
 * SpaceGen Racing — scoring types.
 * ---------------------------------------------------------------------------
 * Same split as src/audio: the RULES are pure arithmetic over sim events and
 * the PRESENTATION is somewhere else entirely. That is not tidiness. A scoring
 * system's only real failure modes are arithmetic -- a drift that pays twice, a
 * combo that runs away, a number that depends on frame rate -- and none of them
 * can be observed in a browser running at 1-5fps under SwiftShader. Pure, they
 * are unit tests that run in milliseconds and fail with the actual number.
 *
 * THE SCORE IS NOT PART OF THE SIMULATION.
 *
 * It is computed render-side, for the local racer only, from `r.events` and the
 * sim CLOCK. Nothing here writes to RacerState and nothing here is read by the
 * physics, so the determinism hash is untouched and a scoring bug can never
 * desync a race. When multiplayer arrives the authority for score moves with
 * the authority for everything else; until then this is the honest shape.
 *
 * IT ALSO MUST NOT DEPEND ON FRAME RATE.
 *
 * "Maintaining a drift" pays per SECOND, and the only second that exists here
 * is `state.time` -- the fixed-step sim clock. Accruing against a render delta
 * instead would pay a 144Hz player the same as a 30Hz one only by accident, and
 * would pay a stuttering one differently again. Every rate in this module is
 * multiplied by a sim-time delta, and tests/score.test.ts drives the same input
 * at three frame rates and asserts the totals are identical.
 */

/** Everything that can add to the score. */
export type ScoreEventKind =
  /** Entered a slide. A small, immediate acknowledgement. */
  | 'driftStart'
  /** Held a slide. Paid per sim-second, and the rate climbs with the tier. */
  | 'driftHold'
  /** Cashed a slide in for a boost. The big one, scaled by tier. */
  | 'driftRelease'
  /** Linked a new slide inside the chain buffer after a release. */
  | 'chain'
  /** Drove into another car hard enough to move it, and meant it. */
  | 'knock'
  /** Crossed the line to complete a lap, paid by position at that moment. */
  | 'lapPlace'
  /** Finished the race, paid by final position. */
  | 'trackPlace'

/** One award, already multiplied, ready to show. */
export interface ScoreAward {
  kind: ScoreEventKind
  /** Points actually added, after the combo multiplier. */
  points: number
  /** Points before the multiplier, so the HUD can show "400 x3". */
  base: number
  /** The combo in force when this landed. */
  combo: number
  /**
   * A short label for the popup. Deliberately NOT the praise line -- praise is
   * cheer.ts's job and has its own gates. This is the receipt.
   */
  label: string
}

/** The live scoring state, read by the HUD every frame. */
export interface ScoreState {
  /** The real running total. */
  total: number
  /** Current combo multiplier, 1.0 at rest. */
  combo: number
  /**
   * How much of the current combo rung has been earned, 0..1. Drives a meter
   * so the player can see the next rung coming rather than being surprised.
   */
  comboProgress: number
  /** Chain depth: consecutive slides linked inside the buffer. */
  chain: number
  /** Seconds left to link the next slide, or 0. */
  chainLeft: number
  /** True while a slide is being paid for, so the HUD can go loud. */
  drifting: boolean
  /** Points per second the drift is currently paying, after the combo. */
  driftRate: number
  /**
   * Points banked by the slide CURRENTLY being held -- entry, every second of
   * hold, and any chain bonus that started it -- reset when a new slide begins.
   *
   * This is the number the HUD's second line shows while sideways, and it is a
   * different thing from the running total: the total is too large and moving
   * too fast to read mid-corner, whereas "this slide is worth 343 so far" is
   * exactly the figure that decides whether to hold it one beat longer.
   */
  driftBanked: number
  /** Tier of the slide being held, -1 while charging. Drives its label. */
  driftTier: number
  /** Awards that landed this frame. */
  awards: ScoreAward[]
  /** Combo rungs crossed this frame, highest last. Drives the callouts. */
  rungs: number[]
}

/** One finished run, as stored. */
export interface ScoreEntry {
  name: string
  score: number
  trackId: string
  chassisId: string
  pilotId: string
  /** Final race position, 1..N. */
  position: number
  /** Best lap in seconds, for a tiebreak that rewards driving. */
  bestLap: number
  /** Highest combo reached during the run. */
  bestCombo: number
  /** Epoch ms. Only used to break exact ties in favour of the older run. */
  at: number
}

/**
 * Where finished runs live.
 *
 * An interface rather than direct localStorage calls because the leaderboard is
 * explicitly going server-side in a later pass. Everything above this line --
 * the board screen, the results sequence, the qualifying check -- talks to
 * THIS, so that change is one new implementation and a different line in
 * createScoreboard(), not a hunt through the UI.
 *
 * Every method is async for the same reason: a local store can answer
 * immediately, and a network one cannot, and the callers have to already be
 * shaped for the slow case or they will all need rewriting on the day.
 */
export interface ScoreStore {
  /** The top `limit` runs for a track, best first. */
  top(trackId: string, limit: number): Promise<ScoreEntry[]>
  /** Would this score make the board? Lets the UI ask before prompting. */
  qualifies(trackId: string, score: number, limit: number): Promise<boolean>
  /** Record a run. Returns its 1-based rank, or 0 if it did not make the cut. */
  submit(entry: ScoreEntry, limit: number): Promise<number>
  /** Wipe one track's board, or all of them. */
  clear(trackId?: string): Promise<void>
}
