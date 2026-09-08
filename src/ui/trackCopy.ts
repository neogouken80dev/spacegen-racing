/**
 * TRACK COPY — the words and the difficulty rating for each circuit.
 *
 * ---------------------------------------------------------------------------
 * WHY A UI-SIDE REGISTRY, AND NOT FIELDS ON TrackDef.
 *
 * The obvious shape is `hook`, `world` and `difficulty` on TrackDef, right next
 * to `name`. It was rejected for the same reason `render/themes/index.ts`
 * rejected a `theme` id there, and consistency with that call is worth as much
 * as the call itself:
 *
 *   - TrackDef lives in `src/sim/track.ts`, and `tests/sim.test.ts` holds a
 *     purity check that the sim knows nothing about presentation. A one-line
 *     marketing hook is presentation by definition — the sim can never read it,
 *     yet every headless balance sweep and every unit fixture that builds a
 *     TrackDef would have to author one.
 *   - Difficulty is not a sim quantity either. It is an editorial judgement
 *     about a human learning curve ("the first track a new player sees"), not
 *     something derivable from grip numbers or corner radii, and it belongs
 *     with the screen that has to justify itself to a player.
 *   - The direction of the dependency matters. Content is upstream; the front
 *     end is downstream and looks content up. `TRACK_COPY[def.id]` keeps that
 *     arrow pointing the way `themeFor(trackId)` already points it.
 *
 * `name` stays on TrackDef because the sim-adjacent tools (headless runner,
 * balance report) print it; nothing here duplicates it.
 *
 * A track with no entry still renders — it falls back to its TrackDef name with
 * an empty hook and an unrated difficulty, which looks obviously unfinished on
 * screen rather than crashing the menu. That is deliberate: a new track should
 * be visibly missing its copy, not silently shipped without any.
 * ---------------------------------------------------------------------------
 */

export type Difficulty = 'Easy' | 'Medium' | 'Hard'

/** 1..3, drives the pip meter on the card and in the detail panel. */
export const DIFFICULTY_RANK: Record<Difficulty, number> = {
  Easy: 1,
  Medium: 2,
  Hard: 3,
}

export interface TrackCopy {
  /** The planet, as the GDD names it. Sits under the track name. */
  world: string
  /** The GDD's one-line hook. Quoted verbatim on screen. */
  hook: string
  difficulty: Difficulty
  /** Two or three sentences: what the lap actually asks of the player. */
  note: string
}

export const TRACK_COPY: Record<string, TrackCopy> = {
  rustfall: {
    world: 'Junkyard Planet',
    hook: 'The track physically rearranges itself.',
    difficulty: 'Easy',
    note:
      'The first track a new player sees: wide, forgiving and legible. A long ' +
      'primary straight into a Class C hairpin, an oil-slick crane drop, a ' +
      'banked Tier-4 sweeper, the chasm jump, then a bounce corridor that ' +
      'gives back everything you throw at it and the esses home.',
  },
  cryostatic: {
    world: 'Ice Tundra Planet',
    hook: 'Two surfaces, one racing line.',
    difficulty: 'Medium',
    note:
      'Polished ice runs at 0.45 grip against packed snow at 1.0, so the fast ' +
      'line is a grip-reading puzzle rather than a geometry one. A crosswind ' +
      'through the blizzard band shoves hover and flight hardest, and the ' +
      'frozen lake is fragile: on lap 3 it cracks, drops its walls and turns ' +
      'to bare ice for everyone.',
  },
  aetherion: {
    world: 'Ancient-Futurist City',
    hook: 'The road is not always there.',
    difficulty: 'Hard',
    note:
      'Three spans of the causeway are light, not stone, and they cycle out ' +
      'and back on a shared 3.2-second beat that runs away down the deck at ' +
      'about 52 m/s: ride the wave or drop through it. Then the rotunda takes ' +
      '270 degrees of the lap up a vertical wall, where the updraft runs along ' +
      'the road\'s own lateral axis and the only way off is down. A warp gate ' +
      'throws you across the gap to the orrery, and the lower city -- plaza, ' +
      'descent and the Glyph Steps -- is buried in two thousand years of dust.',
  },
}

const UNRATED: TrackCopy = {
  world: '',
  hook: '',
  difficulty: 'Medium',
  note: 'No circuit briefing written for this track yet.',
}

export function copyFor(trackId: string): TrackCopy {
  return TRACK_COPY[trackId] ?? UNRATED
}
