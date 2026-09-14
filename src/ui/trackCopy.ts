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
    // HARD, and rated that way AFTER the reshape rather than before it. The
    // authored circuit really was the easy one -- two 32m hairpins that nobody
    // could take quickly and nobody could get wrong. Opening them to 64m turned
    // both into corners you commit to at nearly 50 m/s, and the two places this
    // track can actually end a race -- the unbarriered chasm and the flyover
    // descent -- are both reached faster than they used to be.
    difficulty: 'Hard',
    note:
      'Fast, open and unforgiving of a late lift. The long primary straight ' +
      'feeds a 200m sweep you carry speed through rather than a hairpin you ' +
      'stop for, and the same is true of the loop onto the home straight. ' +
      'Speed is the difficulty here: the chasm jump has no barriers on either ' +
      'side of its landing, the banked Tier-4 sweeper arrives with more of it ' +
      'than before, and the flyover drops you back onto the circuit at pace.',
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
    // EASY, which is a judgement about LEARNABILITY rather than about how much
    // is going on. Every hazard here is telegraphed and on a fixed beat -- the
    // spans run to a 3.2s cycle you can count, the doomed half flashes first,
    // the warp gate is where it always is -- so the lap rewards knowing it and
    // punishes very little else. Nothing on it depends on carrying speed you
    // might not have.
    difficulty: 'Easy',
    note:
      'A lap you learn rather than one you survive. Three spans of the ' +
      'causeway are light, not stone, and they cycle out ' +
      'and back on a shared 3.2-second beat that runs away down the deck at ' +
      'about 52 m/s: ride the wave or drop through it. Then the rotunda takes ' +
      '270 degrees of the lap up a vertical wall, where the updraft runs along ' +
      'the road\'s own lateral axis and the only way off is down. A warp gate ' +
      'throws you across the gap to the orrery, and the lower city -- plaza, ' +
      'descent and the Glyph Steps -- is buried in two thousand years of dust.',
  },
  hollowchoir: {
    world: 'Derelict Megastructure',
    hook: 'Rotating gravity, and a hull with a hole in it.',
    difficulty: 'Hard',
    note:
      'The drift track. Five corners in three kilometres, two direction ' +
      'changes in the whole lap, and every corner long enough to bank a ' +
      'Singularity. A third of it runs on the inside of a spinning habitat ' +
      'drum, corkscrewing a full turn from the deck to the ceiling and back, ' +
      'so down points outward the whole way round. The drum\'s hull is torn ' +
      'open across the middle of that: no air means no drag and a higher top ' +
      'speed, and it also means nothing to corner against, so the Breach is a ' +
      'gift on the straight and a bill at both ends of it. Hovercraft feel it ' +
      'worst -- the cushion they ride on is the thing that is missing.',
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
