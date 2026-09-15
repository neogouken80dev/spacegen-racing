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
  emberfall: {
    world: 'Volcanic Shield',
    // REWRITTEN AFTER THE SKETCH PASS, because both halves of the old hook had
    // stopped being true. "A third of the lap is ash" is now 229m of gravel out
    // of 4481.6m -- 5% -- since the infield the sketch added took that ground.
    // And "neither set piece is a corner" was the whole point of the old copy:
    // the looper the same pass added is 441 degrees of ordinary plan-view
    // corner, so it is a set piece that IS a corner, and the one that can end
    // a race.
    hook: 'Two loops, a corkscrew, and a road that flies over itself.',
    difficulty: 'Medium',
    note:
      'The maximalist one: two vertical loops, a corkscrew, a launch across ' +
      'an open fissure and a tunnel bored through the basalt, all inside ' +
      'four and a half kilometres. Most of that cannot decide the race -- a ' +
      'loop and a corkscrew are geodesics, so the road curves, the surface ' +
      'curves with it, and the sim reads them dead straight. Hold the ' +
      'throttle and enjoy them. The one set piece that can is the looper: a ' +
      'large right-hander that keeps turning for 441 degrees and climbs back ' +
      'over the road it arrived on, an ordinary corner the whole way round, ' +
      'so you brake for it, drift it, and can fall off it. Then the ash beds ' +
      'and the rim, where loose gravel and an updraft both push you at a ' +
      'barrier you are allowed to lean on.',
  },
  abyssal: {
    world: 'Submerged Transit Tube',
    hook: 'The tube leaks, and where it leaks things grow.',
    difficulty: 'Hard',
    // The plan sentence was rewritten after the sketch pass. "Two very long
    // flanks, the fastest shape on the roster" described the kidney this
    // circuit used to be; Vince's redraw put a wave across the top and an S
    // through the bottom and took the lap to 4033.8m. Four blooms now, not
    // three -- BLOOM-D came in with the S.
    note:
      'Nine hundred metres down, inside the glass, with the trench on the ' +
      'other side of it. The plan wanders, and is meant to: a long wave ' +
      'across the top, a descent down the right flank, a big S driven ' +
      'through the bottom, and two hairpins holding the ends of four ' +
      'kilometres together. Four corners run over biofilm -- grip 0.30, ' +
      'lower than ice -- and every bloom sits where the corner already ' +
      'wanted you slow, so it costs a tidy driver almost nothing and takes ' +
      'everything off one who arrived hot. Watch the amber posts; ' +
      'everything alive down here is cyan, so amber means one thing. ' +
      'This is the SPIRAL circuit: one three-turn descent through the tube and ' +
      'no loop anywhere. Then the Breach, where the sea comes in sideways and ' +
      'the wall is the thing you lean on.',
  },
  halcyon: {
    world: 'Tidal Coast',
    hook: 'The fast one. Nothing here is trying to kill you.',
    difficulty: 'Easy',
    note:
      'The roster had one Easy circuit and a new driver needs a second ' +
      'opinion about what a corner feels like. Easy here is not fewer ' +
      'corners: the lap runs three lobes with no long straight anywhere, ' +
      'which is what a coast road does around headlands. It is width -- ' +
      '21-28m of road against 14-21 on Zhen-9 -- so a bad entry costs time ' +
      'instead of the lap. No ice, no biofilm, no oil; nothing drops below ' +
      'dry gravel. Where the barriers stop it is because the beach carries ' +
      'on. This is the LOOP circuit: the Pier and the Arch, both pure ' +
      'spectacle, neither able to spit you off.',
  },
  neonspire: {
    world: 'Stacked Metropolis',
    hook: 'Dry deck, grip 1.0, and the hardest lap in the game.',
    // THE SHAPE SENTENCE WAS FOUR CIRCUITS OUT OF DATE. "A squared-off block:
    // four flat sides and four real corners, 14-21m of road" described neither
    // the circuit this file rebuilt from the sketch (twenty corners, 4322.9m,
    // 14-22m) nor the fourteen-corner one before it, which is the version the
    // line was already stale for when it was written. Re-read off the built
    // lap this time, not off the last thing anyone remembered about it.
    difficulty: 'Hard',
    note:
      'Every other Hard circuit is hard because of a substance -- ice, ' +
      'biofilm, vacuum. Take it away and they are wide and forgiving. This ' +
      'one has no hostile surface at all. Twenty corners over 4.3km of ' +
      'walled street, 14-22m of road, and an infield that folds a double ' +
      'hairpin through the middle of the city -- two hooks that each turn ' +
      'you the whole way back on yourself, down a diagonal where the Squeeze ' +
      'pinches the street to 14m. It only works because contact no longer ' +
      'ends a drift -- leaning on a barrier through a corner this tight is a ' +
      'line you can choose now. Three maglev runs are the compensation, so ' +
      'the lap alternates real top speed with hard braking and never gives ' +
      'you both. One loop and one spiral: the Holo Ring and the Spire, the ' +
      'only two places on the lap you stop working.',
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
