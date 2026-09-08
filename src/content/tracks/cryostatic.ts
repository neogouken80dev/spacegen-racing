import type { TrackDef } from '../../sim/track'

/**
 * CRYOSTATIC — Ice Tundra Planet.
 *
 * GDD hook: TWO SURFACES, ONE RACING LINE. Polished ice runs at 0.45 grip,
 * packed snow at 1.0, and the optimal line is a grip-reading puzzle rather than
 * a geometry one. It inverts by locomotion class, because
 * `surfaceFrictionInfluence` is 1.0 for grounded and 0.0 for hover and flight:
 * the ice sweeper that forces Solaire, Bulwark and Dray-9 to brake is taken
 * flat by Filament and Vector-7.
 *
 * That alone would hand the race to hover and flight, so the GDD specifies two
 * counterweights and both are authored here:
 *
 *   1. The packed-snow switchbacks at beat 4. Full grip and Class C radii are
 *      worth most to the classes that can actually use grip.
 *   2. The CROSSWIND through the blizzard band, which pushes hover at 1.5x and
 *      flight at 1.8x the force applied to grounded (LocomotionProfile.
 *      fieldForceMult -- numbers that already existed in tuning and had never
 *      been read by anything). It sits on the primary straight, which is
 *      exactly where a flight chassis would otherwise be untouchable.
 *
 * The frozen lake is FRAGILE: once the leader starts lap 3 it cracks, loses its
 * walls and turns to bare ice for everyone. The line you learned on lap one is
 * not the line you finish on.
 *
 * Difficulty: Medium. The second track a player sees.
 *
 * ---------------------------------------------------------------------------
 * AUTHORED AS WAYPOINTS, NOT AS ARCS.
 *
 * A closed Catmull-Rom through a list of waypoints closes BY CONSTRUCTION. An
 * earlier cut of this file drove a cursor through arcs of stated radii, which
 * reads beautifully against a design grammar written in corner classes, and
 * then cannot close: position and heading are three constraints, and an
 * unconstrained solve for them returns a 303-degree corner joined by a straight
 * of minus 735 metres -- a real root, and not a racetrack. Rustfall never had
 * this problem because it is waypoints.
 *
 * So: place waypoints, then MEASURE the radii and adjust until the corner
 * classes match the GDD. tests/track.test.ts holds the invariants that matter
 * (no self-intersection, gradients inside the grammar), and the corner classes
 * are checked against tools/probe-cryo.ts output recorded in the build status.
 * ---------------------------------------------------------------------------
 */
export const CRYOSTATIC: TrackDef = {
  id: 'cryostatic',
  name: 'Cryostatic',
  // ART PASS: POLAR DUSK. See render/themes/cryostatic.ts for the argument.
  //
  // The authored grey-box values were a noon sky — a 0xa8cfe0 fog under a
  // 0x9fd4e8 horizon with a 1.7 key — and they broke GDD 09's standing rule
  // ("if a track section washes out the racers, the track is wrong"): a white
  // road under a white sky graded onto a white fog buried all five cars and
  // every VFX in the game. Everything below drops the whole frame into the
  // mid-to-dark band and buys the contrast back with a low, cold, raking key
  // against a deep blue fill, which is also simply what an ice planet looks
  // like at the hour anyone would choose to photograph it.
  skyTop: 0x050c1a,
  skyBottom: 0x437c9f,
  // The horizon anchor, and therefore the colour the whole mid-field grades
  // onto. Mid-DARK: distance now takes the world down into blue instead of up
  // into white, which is the single biggest value decision on this track.
  // The blizzard band lifts it to 0x7d95a6 and no further (themes/cryostatic).
  fogColor: 0x3b6076,
  fogDensity: 0.0058,
  sunColor: 0xe6f2ff,
  // 1.15, not 1.7. Snow at even a mid albedo will clip under a 1.7 key.
  sunIntensity: 1.15,
  // Deep blue fill, so shadows go BLUE rather than grey. This is what carries
  // the "cyan, white, deep blue" brief; the white is the sun and the fresnel.
  ambientColor: 0x1b3a5c,
  ambientIntensity: 0.78,
  // ~21 degrees of elevation. Long shadows, and a key that rakes across a
  // snow facet instead of flattening it.
  sunDirection: [0.46, 0.26, -0.50],
  // a: painted alloy on league hardware.  b: THE SODIUM CHANNEL — wall cap
  // lamps, kerb chevrons, edge hazard, blizzard poles. Warm amber on purpose:
  // it is the only warm hue on the planet, it is the exact inverse of
  // Rustfall's cyan accent on a warm track, and a cold marker light on a cold
  // track is a marker light nobody sees.  c: near-black basalt.
  // accent: bioluminescence, boost chevrons and the aurora, all one green.
  palette: { a: 0x35657f, b: 0xffc879, c: 0x0e1c2a, accent: 0x7bffcf },
  laps: 3,
  nodes: [
    // --- Beat 1: glacier ramp start, 230m descending -----------------------
    // Downhill start for an immediate speed sensation. 26m over 230m is 11.3%,
    // inside the grammar's 12% sustained ceiling.
    { p: [0, 44, 0], w: 22, surface: 'snow', tag: 'start' },
    { p: [0, 37, 80], w: 22, surface: 'snow' },
    { p: [0, 28, 160], w: 21, surface: 'snow' },
    // ICE, added in the friction-budget pass. This corner measures R=93m and on
    // snow its limit is 58.2 m/s against a 61.4 m/s top speed -- it bound by 5%,
    // which is to say it was a Class B corner nobody had to lift for. On ice the
    // limit is 39.0 m/s, and the first thing the track now teaches, 200m in and
    // at the bottom of the 11% glacier ramp, is that this planet has two
    // surfaces and you have to know which one you are on. It is deliberately
    // NOT fragile: this is the glacier foot, not the shelf, so it stays ice
    // after the lake gives way.
    { p: [8, 20, 232], w: 21, bank: 5, surface: 'ice', tag: 'glacier-foot' },

    // --- Beat 2: Class A sweeper across a frozen lake ----------------------
    // THE TIER 4 CORNER, and THE PATCH PUZZLE.
    //
    // Measured, this sweeper is 204m of mean radius, not the ~150m the beat
    // sheet claims. On full grip a 204m arc is flat out at this roster's top
    // speed, so the corner exists ONLY because it is ice -- which is the GDD
    // hook working exactly as written, and worth saying out loud.
    //
    // What was NOT working is where the ice sat. Uniform ice from lake-entry to
    // lake-exit put 275m of 0.45 grip on the lake, and only 129m of it (47%)
    // was on radius tight enough for the reduced budget to bite before top
    // speed did. The first 96m -- the entry, R>250m -- was paint.
    //
    // So the lake is now PATCHED rather than uniform: wind-scoured snow over
    // the flat entry, polished ice from the apex through the tightening exit
    // where the radius falls to 134m. Same lake, 96m less ice, 62m more of it
    // doing something. Measured across the whole lap: 488m of ice of which 342m
    // bound, against 549m of which 474m bind.
    //
    // Surfaces are FULL-WIDTH in this engine (TrackSample.surface is scalar, so
    // there is no lateral grip variation and no cross-the-road line choice).
    // The only grip-reading puzzle the model can express is a longitudinal one
    // -- which patch is which, and where you brake for it -- and that is what
    // this is.
    //
    // The snow band is still `fragile`, which is the best part: on lap 3 the
    // shelf cracks and T.hazard.crackedSurface turns the WHOLE lake to bare
    // ice, so the braking platform the field has been using for two laps
    // disappears. "The line you learned on lap one is not the line you finish
    // on" is now true of the grip and not only of the walls.
    { p: [60, 14, 300], w: 23, bank: 10, surface: 'snow', fragile: true, tag: 'lake-entry' },
    { p: [140, 9, 352], w: 23, bank: 12, surface: 'snow', fragile: true, tag: 'sweeper-T4' },
    { p: [232, 5, 368], w: 23, bank: 12, surface: 'ice', fragile: true },
    { p: [318, 3, 344], w: 23, bank: 11, surface: 'ice', fragile: true },
    { p: [378, 2, 288], w: 22, bank: 7, surface: 'ice', fragile: true, tag: 'lake-exit' },

    // --- Beat 3: bioluminescent ice cavern with bounce walls ---------------
    // The lighting showpiece. Narrowed to 16m because the narrowing is the
    // point; the grammar permits it where the narrowing is the mechanic.
    { p: [404, 3, 218], w: 19, surface: 'snow', tag: 'cavern' },
    { p: [406, 5, 152], w: 16, bounce: true, surface: 'ice' },
    { p: [382, 8, 96], w: 16, bounce: true, surface: 'ice' },
    { p: [338, 10, 58], w: 17, bounce: true, surface: 'snow', tag: 'cavern-exit' },

    // --- Beat 4: double Class C switchback up a moraine --------------------
    // Packed snow, full grip, 20m of climb. THE EQUALISER: the grounded
    // classes take back here what the lake cost them.
    { p: [282, 13, 44], w: 19, surface: 'snow', tag: 'moraine' },
    { p: [234, 17, 68], w: 18, bank: -14, surface: 'snow', tag: 'switchback-1' },
    { p: [226, 21, 118], w: 18, bank: -10, surface: 'snow' },
    { p: [266, 25, 154], w: 18, bank: 14, surface: 'snow', tag: 'switchback-2' },
    { p: [324, 28, 160], w: 19, bank: 10, surface: 'snow', tag: 'moraine-top' },

    // --- Beat 6: ice tunnel loop -------------------------------------------
    // Heavily banked so it reads as a tube rather than a corner. Breaks Seeker
    // Missile lock: the defensive play on this track.
    { p: [372, 30, 134], w: 18, bank: 26, surface: 'snow', tag: 'tunnel' },
    { p: [390, 32, 92], w: 18, bank: 34, surface: 'ice' },
    { p: [372, 33, 52], w: 18, bank: 34, surface: 'ice' },
    { p: [330, 33, 40], w: 18, bank: 24, surface: 'snow' },
    { p: [292, 32, 66], w: 19, bank: 8, surface: 'snow', tag: 'tunnel-exit' },

    // --- Beat 7: downhill chasm jump ---------------------------------------
    // Boost entry required per the grammar. Open on both sides of the gap so a
    // miss is a visible fail with a fast recovery below.
    { p: [250, 29, 98], w: 20, surface: 'snow' },
    { p: [204, 25, 126], w: 20, boost: true, ramp: 36, surface: 'snow', tag: 'ramp-chasm' },
    // y 26 -> 25, THE SMALLEST CHANGE THAT WORKS. The mid-gap node used to sit
    // HIGHER than the ramp it is launched from (25) and 7m above the landing
    // (19), which is a hump in the middle of a chasm: the Catmull-Rom through
    // 25 / 26 / 19 overshot into a 13.5% sustained grade over a 30m window --
    // the only place either track broke the grammar's 12% ceiling. Levelling it
    // with the ramp reads 25 / 25 / 19 and measures 11.6%.
    //
    // 23 was tried first and is the wrong answer even though it also measures
    // 11.6%: a 3m drop deepens the gap enough to change the jump, and the jump
    // is the flight class's section. Over 300 races it took Vector-7 from 14.7%
    // to 10.7% of wins, out of the 12-30% band, for a grade fix that 1m already
    // buys. The launch itself is untouched either way -- a ramp sets a vertical
    // velocity and the racer is ballistic from there -- so what moved was the
    // landing, and only the class that spends 29% of the lap in the air noticed.
    { p: [152, 25, 152], w: 18, open: true, surface: 'snow' },
    { p: [98, 19, 178], w: 20, open: true, surface: 'snow', tag: 'floe-landing' },

    // --- Approach to the blizzard band -------------------------------------
    { p: [40, 15, 202], w: 21, bank: 6, surface: 'snow' },
    { p: [-24, 13, 212], w: 21, bank: 9, surface: 'snow', wind: 1.5, tag: 'blizzard-in' },
    { p: [-84, 12, 198], w: 22, bank: 9, surface: 'snow', wind: 3.5 },
    { p: [-122, 11, 158], w: 23, bank: 5, surface: 'snow', wind: 5.5 },

    // --- Beat 8: blizzard band home straight, ~390m ------------------------
    // The primary straight, the slipstream lane and the Alpha Missile window.
    // The crosswind peaks mid-straight and eases at both ends, so the band is
    // something a player fights across rather than a constant lane offset they
    // trim out once and forget. The chevron boost chain lights the line
    // through the whiteout.
    { p: [-132, 11, 92], w: 24, surface: 'snow', wind: 7.0, tag: 'home-straight' },
    { p: [-132, 11, 14], w: 24, surface: 'snow', wind: 7.0, boost: true },
    { p: [-132, 12, -64], w: 24, surface: 'snow', wind: 6.5, boost: true },
    { p: [-132, 13, -142], w: 24, surface: 'snow', wind: 5.0, boost: true },
    // THE PRIMARY STRAIGHT IS 22m SHORT AND STAYS THAT WAY. GDD 05 asks for one
    // straight of 400m or more; this one measures 378m of road under 1/260 of
    // curvature (336m of it literally constant-x, nodes 31-35). Four separate
    // single- and two-node extensions were measured and every one of them made
    // it WORSE, because a Catmull-Rom bleeds the neighbouring corner's
    // curvature back into the straight from both ends: pushing this node out to
    // z=-244 gave 372m and tightened the esses from R=80m to R=67m; pulling
    // node 31 back to z=118 gave 381m; doing both gave 363m. Reaching 400m
    // means re-laying the whole blizzard band and the esses that follow it,
    // which is a bigger geometry change than a surface pass should make on a
    // gated, art-passed track. Recorded as a measured 94.5%-of-spec miss.
    { p: [-132, 15, -218], w: 23, surface: 'snow', wind: 3.0, tag: 'blizzard-out' },

    // --- Return leg: climb back to the glacier start -----------------------
    // 29m of climb over ~330m is 8.8%. Class B, and the last overtake window.
    { p: [-120, 19, -284], w: 22, bank: -10, surface: 'snow', tag: 'esses' },
    { p: [-84, 25, -330], w: 22, bank: -14, surface: 'snow' },
    { p: [-30, 31, -344], w: 22, bank: -14, surface: 'snow' },
    { p: [22, 36, -322], w: 22, bank: -12, surface: 'snow' },
    { p: [50, 40, -272], w: 22, bank: -8, surface: 'snow' },
    { p: [46, 43, -206], w: 22, bank: 6, surface: 'snow' },
    { p: [22, 44, -128], w: 22, bank: 6, surface: 'snow', tag: 'home' },
    { p: [4, 44, -62], w: 22, surface: 'snow' },
  ],
  // ITEM BOX ROWS: MEASURED, A FIX BUILT, AND THE FIX DELIBERATELY NOT SHIPPED.
  //
  // The checklist asks for rows placed off the optimal line. Measured against
  // the line the front three actually drive (tools/probe-line.ts, front-3
  // telemetry over 12 races), every row on both tracks was ON it: the nearest
  // box sat 0.4-2.4m from the driven line, i.e. free.
  //
  // A fix exists and was built and measured. Rows move to the corners where the
  // driven line is displaced, and `spread` narrows so the row's span fits
  // inside that displacement -- {0.16, 0.37, 0.56, 0.70, 0.94} here and
  // {0.19, 0.50, 0.72, 0.925} on Rustfall, with spreads floored at 2.4m
  // because that is the box mesh's own width. It works: 4 of 5 rows on each
  // track go from free to costing a 2.3-6.9m deviation.
  //
  // IT WAS REVERTED, and the reason is worth more than the fix. `stepAI` has no
  // item-seeking term at all -- an AI racer's target lateral is
  // `(apexBias + lineBias) * halfWidth` and nothing else -- so it never deviates
  // for a box. Taking the rows off the line therefore does not make the AI work
  // for its items, it simply stops it collecting them: item boxes touched fell
  // from 64.5 to 29.2 per race on Cryostatic, a 55% collapse of the whole item
  // economy, and the balance gate went with it (Vector-7 9.0%, out of the
  // 12-30% band, against 16.3% before).
  //
  // So this line of the checklist cannot be satisfied from the track files. It
  // needs one of: an item-seeking bias in src/sim/ai.ts, so that a deviation is
  // a decision the AI makes rather than an item it never sees; or a `lateral`
  // field on `itemBoxRows` in src/sim/track.ts -- which `chargeRuns` already
  // has -- so a row can be offset rather than only narrowed. Both are outside
  // the track content. Recorded as an open failure rather than papered over.
  itemBoxRows: [
    { at: 0.08, count: 5, spread: 4.4 },
    { at: 0.24, count: 5, spread: 4.2 },
    { at: 0.42, count: 5, spread: 4.4 },
    { at: 0.60, count: 4, spread: 4.0 },
    { at: 0.79, count: 5, spread: 4.2 },
  ],
  chargeRuns: [
    { from: 0.02, to: 0.07, count: 6, lateral: -5 },
    { from: 0.14, to: 0.19, count: 6, lateral: 6 },
    { from: 0.31, to: 0.38, count: 8, lateral: 0 },
    { from: 0.50, to: 0.56, count: 6, lateral: -5 },
    { from: 0.68, to: 0.74, count: 7, lateral: 5 },
    { from: 0.86, to: 0.94, count: 8, lateral: 0 },
  ],
}
