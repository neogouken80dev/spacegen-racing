import type { TrackDef, TrackNode } from '../../sim/track'

/**
 * AETHERION PRIME — Ancient-Futurist City.
 *
 * GDD hook: THE CITY IS THE MECHANIC. Rustfall rearranges itself and Cryostatic
 * changes its grip; Aetherion changes whether the road is there at all. Three
 * spans of the causeway phase HALF their deck out on a shared 3.2-second beat --
 * always the same half, always flashing first, so the causeway is a lane you
 * commit to rather than a second you have to hit -- and a rotunda turns 270
 * degrees of the lap through a vertical wall where the only thing holding a car
 * on the road is the road's own idea of down.
 *
 * Difficulty: Hard. The technical track, and the third a player sees.
 *
 * ---------------------------------------------------------------------------
 * AUTHORED AS WAYPOINTS, NOT AS ARCS -- with one deliberate exception.
 *
 * Cryostatic's header records why: a closed Catmull-Rom through waypoints
 * closes BY CONSTRUCTION, and an unconstrained solve for a chain of arcs of
 * stated radii does not (that solve returned a 303-degree corner joined by a
 * MINUS 735 metre straight -- a real root of the closure equations, and not a
 * racetrack). Every metre of this lap is hand-placed waypoints for the same
 * reason, and the corner classes below are MEASURED off the baked ribbon by
 * tools/probe-track.ts rather than claimed.
 *
 * The exception is the rotunda, and it is not the same thing. `drum()` below
 * does not SOLVE for anything: the drum's centre, radius, entry angle and
 * sweep are all given, and it emits the nodes that lie on that known circle.
 * It exists because the roll of an `up`-vector around a cylinder is nineteen
 * pairs of sines and cosines that have to agree with the nineteen positions
 * they sit on, to a tolerance the bake enforces by throwing. Hand-typing them
 * would be worse in every way -- less readable, less checkable, and wrong.
 * Nothing about the closure depends on it: the drum is entered and left at
 * fixed points, and the waypoints either side meet those points.
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * THE DRIFT-RUN SPECTRUM IS THE THING THIS TRACK IS AUTHORED AGAINST, and the
 * first cut of it was the reason the 600-race gate failed. Read this before
 * moving a waypoint.
 *
 * stepAI opens a drift only where |curvatureAt(s+6, 30)| > 0.0075 (R < ~133m)
 * and holds it only while |curvatureAt(s, 20)| > 0.0045 (R < ~222m). So the
 * longest drift this lap can physically support is the longest CONTIGUOUS run
 * of arc over the hold threshold that also contains one point over the entry
 * threshold, and the charge it banks is that run divided by the speed it is
 * taken at. tools/probe-holdruns.ts prints the spectrum; it is the number that
 * decides the tier histogram, and therefore the whole class balance, because
 * the drift boost is the only thing a low-top-speed chassis has.
 *
 * The first cut had TWENTY-ONE enterable runs, median 17m, of which fourteen
 * could not reach Tier 1 and none could reach Tier 3. Measured, that was 659
 * drifts a race with 70.6% of them banking no tier at all, and the shipped
 * tracks run 4 (Cryostatic) and 7 (Rustfall) enterable runs with two Tier-3s
 * each. It now runs ELEVEN, with two Tier-3 runs (330m and 264m), three Tier-2
 * and three Tier-1: 328 drifts a race, 44.6% of them no-tier, 3.4% Tier 3.
 *
 * Three authoring rules came out of that and all three are load-bearing:
 *
 *   1. UNEVEN WAYPOINT SPACING IS A CURVATURE RIPPLE, and a ripple across the
 *      0.0045 hold gate is a drift-entry machine gun. A 32m segment meeting the
 *      rotunda's 14.1m drum nodes swung |k| over a 20m window between R=41m and
 *      R=641m six times in 60m. Taper the spacing (36 -> 21 -> 17 -> 14) into
 *      anything finely sampled.
 *   2. CURVATURE THAT GRAZES 0.0045 IS WORSE THAN CURVATURE THAT CROSSES IT.
 *      The last corner's turn-in used to crawl along R=215-230m for twelve
 *      metres; the AI re-rolls drift entry every frame it is not drifting, so
 *      that measured 1,015 entries a race in one bucket, 31% of every drift on
 *      the lap, all dead inside a tenth of a second. Cross the gate, do not
 *      ride it.
 *   3. A LINK BETWEEN TWO CORNERS SHOULD BE UNDER the ENTRY gate (R > 133m) or
 *      long enough to charge. The 27-degree right between the Glyph Steps and
 *      the last corner was 21 of those degrees at one node -- R=41m, 29m of
 *      arc, 308 wasted entries a race. Spread over its whole 83m it is R=156m
 *      and the AI leaves it alone.
 * ---------------------------------------------------------------------------
 *
 * THE CLASS BALANCE CONTRACT, and which section collects from whom. The
 * numbers are measured (tools/balance.ts, 600 races); the shape is:
 *
 *   grounded  pays at the CAUSEWAY and the WARP GATE. Both are air, and air is
 *             where the grounded profile has nothing: gapCross 0, maxLift 0, a
 *             lateral budget cut to 0.25 the moment the wheels leave the deck,
 *             and -- the one that costs most here -- canDrift is false while
 *             airborne, so any bump cancels a grounded chassis's drift and
 *             cancels neither hover's nor flight's.
 *   hover     pays at the CAUSEWAY, and pays MORE than grounded for the same
 *             road: identical air exposure, no Lift, and a crosswind at
 *             fieldForceMult 1.5 across 16m of half-width with no barriers.
 *
 *   HALF-SPAN PHASING REPRICED THE CAUSEWAY AND THE NUMBERS ABOVE ARE NOT WHAT
 *   THEY WERE. Falls per span entry, measured over 24 races
 *   (tools/probe-bridges.ts):
 *
 *                   whole span        half span
 *       grounded       0.29             0.02
 *       hover          0.47             0.03
 *       flight         0.33             0.05
 *
 *   The causeway is no longer where anyone's respawns come from -- 0.47-0.69 a
 *   race across the field became 0.02-0.27 -- and what it collects now is the
 *   crosswind pushing a racer off its lane and over the seam, which is a
 *   graded cost with a lane change as the answer rather than a cliff with
 *   nothing as the answer. The class ORDER is unchanged (flight feels the wind
 *   most and clips the seam most, at 9.7% of its span frames against grounded's
 *   0.7%) which is what keeps the contract below honest; only the magnitude
 *   moved, and it moved down.
 *   flight    pays in the PLAZA and the ROTUNDA, and the plaza is now the
 *             bigger half. The crosswind there peaks at 23.2 m/s^2 of authored
 *             field, which is 41.8 for flight against a ~36 m/s^2 lateral
 *             budget: on a walled 26m road that is a graded time cost rather
 *             than a fall, which is exactly why it is the right place to spend
 *             it. THE CAUSEWAY WIND IS A CLIFF AND THE PLAZA WIND IS A RAMP:
 *             measured, taking the causeway peak from 16.4 to 18.9 moved
 *             Vector-7 from 23.5% of wins to 11.5% and Bulwark from 12.5% to
 *             19.0%, because an open deck converts field force straight into
 *             respawns. Tune the plaza; leave the causeway alone. That is still
 *             true, and it is why the surviving half is authored UPWIND: it
 *             makes the wind push a racer toward the seam rather than off the
 *             deck. Authored the other way round -- surviving half downwind --
 *             the same three spans took flight from 0.33 falls per entry to
 *             0.46, i.e. worse than the whole-span version they replaced.
 *
 * The honest caveat, and it is a property of the locomotion model rather than
 * of this track: hover is grounded plus a field-force tax and minus nothing, so
 * no section can punish hover without punishing grounded at least as hard. What
 * the causeway can do -- and does -- is make hover pay strictly more than
 * grounded on the same metres.
 *
 * THE LAP AS BUILT (measured, tools/probe-track.ts; 3213m, 91 nodes):
 *   1 Colonnade        405m straight                        primary straight
 *   2 Gatehouse         99m  R 98/53     44.0 m/s           Class B/C
 *     Causeway         456m deck, 3 spans of 51/49/49m      wave 52.6 m/s
 *                      each drops its RIGHT half; lane left
 *   3 Rotunda          270m of 54m drum, 58-degree wall     R 64/46 + 68/48, 41.2 m/s
 *   4 Warp gate        114m gap off a power-38 ramp
 *   5 Orrery           205m  R 64/42, 79/58, 83/42          39.1-45.9 m/s
 *   6 Keystone Plaza   259m over dust, R 107/52 then 179/126
 *   7 Plaza-out sweep  366m of dust, R 159/95, 132 degrees  49.3 m/s   TIER 4
 *     The Descent      369m falling straight, 27m of drop
 *   8 Glyph Steps      227m  R 113/78 then 76/53            53.5 / 44.1 m/s
 *     Last corner      130m  R 56/39 on a 52m arc, dust     28.4 m/s
 */

/**
 * One node of the anti-gravity rotunda.
 *
 * The road lies on the INSIDE of a vertical drum of radius `R` centred on
 * (cx, cz). `theta` is the position around that drum, in degrees, measured so
 * that p = centre + R * (sin, cos) -- the same convention the rest of this file
 * uses for a plan bearing. `roll` is how far the road has rotated up onto the
 * wall: 0 is a flat floor, 90 is a vertical wall with the car's own up pointing
 * horizontally at the drum's axis.
 *
 * The up-vector is world +Y swung by `roll` toward the INWARD radial. Both of
 * those are perpendicular to the tangent of a horizontal circle, so the whole
 * family is legal for every roll -- which is the property that lets the roll be
 * authored as a smooth ramp instead of a jump the bake would reject.
 */
function drumNode(
  cx: number, cz: number, R: number,
  theta: number, roll: number, y: number, w: number, wind: number, tag?: string,
): TrackNode {
  const t = (theta * Math.PI) / 180
  const r = (roll * Math.PI) / 180
  const st = Math.sin(t), ct = Math.cos(t)
  return {
    p: [cx + R * st, y, cz + R * ct],
    w,
    surface: 'tarmac',
    wind,
    // Outward radial is (st, 0, ct); inward is its negation. At roll 0 this is
    // world +Y exactly, so the drum's mouth is ordinary road.
    up: [-st * Math.sin(r), Math.cos(r), -ct * Math.sin(r)],
    tag,
  }
}

/**
 * The rotunda, as one expression.
 *
 * 270 degrees of a 54m drum in 15-degree steps: nineteen nodes, 14.1m of arc
 * each, because the bake refuses more than 120 degrees of up-vector between
 * neighbours and because a roll authored across four nodes reads as a hinge
 * rather than a bank.
 *
 * THE WALL STOPS AT 58 DEGREES, AND THAT NUMBER IS THE WHOLE BEAT.
 *
 * A horizontal circle on a cylinder is a geodesic: its curvature vector points
 * along the surface normal, so at a full 90 degrees of roll the road is turning
 * through a 54m circle while the car's own plane says it is going straight.
 * Track.curvatureAt measures about the surface normal on a gravity track, which
 * is exactly what the normal-relative read was written for -- and at roll 90 it
 * reported a radius of 9,200m. The consequence nobody priced: the AI's drift
 * HOLD gate is |k| > 0.0045, so the wall was not merely free of braking, it was
 * un-driftable, and it cut the rotunda into two short mouth corners with 117m
 * of dead road between them. Measured: two runs worth Tier 0 and Tier 1, 301
 * drift entries a race in the entry bucket, 180 of them dead inside 0.12s.
 *
 * The geodesic curvature at roll r is cos(r)/R exactly. At R=54 that clears the
 * hold gate (0.0045) for every roll under 76 degrees, so rolling to 74 instead
 * of 90 already made the ENTIRE 270-degree drum one continuous drift-hold run.
 * 74 was WRONG ALL THE SAME, and the reason is worth the paragraph.
 *
 * At roll 74 the wall reads |k| = 0.0051, i.e. R = 196m, and cornerSpeedAt of
 * that is 86 m/s against a 63.6 m/s roster maximum -- so the wall was holdable
 * but FLAT OUT, 198 metres of road where the only thing that decides who is
 * quicker is top speed. That is the one axis Bulwark is last on (topSpeed 6
 * against Dray-9's 8), and 198m of flat-out costs it 0.23s a lap against Dray-9
 * for nothing it can answer. Measured over 600 races, snapping the roll on
 * FASTER (a 0.16 ramp, more of the drum at full roll and therefore flat out)
 * took Bulwark from 11.3% of wins to 7.0%; the direction that works is the
 * other one.
 *
 * At 58 degrees the wall reads |k| = 0.0098 -- R = 102m, a Class B corner that
 * prices at 52.6 m/s and BINDS on every chassis in the roster. The drum is now
 * two measured corners of 138m and 132m at R 64/46 and 68/48, its drift run is
 * worth charge 5.23 instead of 4.65, and the whole 198m has moved out of the
 * top-speed bucket into the grip-and-drift bucket. Measured at 600 races that
 * is Bulwark 11.3% -> 12.7% and the lap's Tier-3 share 4.5% -> 5.1%, at a cost
 * of 0.03s of lap time.
 *
 * It also stops the flight class lifting on the wall. stepAI lifts whenever
 * |curveNear| < 0.003; at roll 74 the wall read 0.0051 and Vector-7 spent 64%
 * of the drum airborne, which is where a third of its trick-landing boost came
 * from. At 58 the wall is curved enough that the lift heuristic never fires.
 *
 * What 58 costs is honesty about the fantasy: this is a steep bank, not a
 * ceiling. The car is still held on it by the road's own idea of down -- the
 * up-vector is 58 degrees off world +Y and `stick` is 1 across the whole drum,
 * so a racer that gets airborne here still falls back toward the wall rather
 * than into the sky -- but nobody will call it vertical.
 *
 * The roll ramps on over the first 42% of the sweep, holds at ROT_ROLL for the middle
 * 16%, and unrolls over the last 42%. Those fractions are a BALANCE number, not
 * a taste: 22/52/26 went to 32/36/32 (39m of the lap moved out of the flat-out
 * bucket), and 32/36/32 to 42/16/42 to lengthen the two mouths before the roll
 * cap made the split moot.
 *
 * What is still hardest is the mouth. At roll 0 the same circle is an ordinary
 * corner, and the drum measures R=47m and R=49m at its two apexes -- 41.3 and
 * 42.4 m/s for the roster median, the hardest braking on the lap outside the
 * final corner. You brake for the way in, the middle costs nothing at all, and
 * then you have to be pointing somewhere on the way out.
 */
// 74, not 58. This is the track's headline beat and a 58-degree bank is not a
// wall-ride; it was dropped to 58 to claw Bulwark off the win-share floor when
// the real cause was elsewhere. The drift coyote window (see `canDrift` in
// vehicle.ts) fixed that at the source -- a single airborne frame used to
// delete a grounded chassis's drift and could not touch a hover or flight one --
// so the roll can go back to what the beat is for.
//
// The measurement that motivated 58 is still true and worth keeping in view:
// geodesic curvature on a drum is cos(roll)/R, so at 74 degrees on R=54 the
// wall reads |k| = 0.0051 (R=196m, 86 m/s) against a roster maximum of 63.6 --
// nothing binds, and 198m of the lap is decided purely on top speed. That makes
// the rotunda a SET PIECE rather than a corner, which is a legitimate thing for
// a beat to be, and the corner work is done at the two mouths (R=47 and R=49,
// the hardest braking on the lap outside the last corner).
const ROT_ROLL = 74
const ROT_CX = 479.3
const ROT_CZ = 659.0
const ROT_R = 54
const ROT_TH0 = -28
const ROT_SWEEP = 270
const ROT_Y0 = 36
const ROT_CLIMB = 18
function rotunda(): TrackNode[] {
  const out: TrackNode[] = []
  const STEPS = 18
  for (let i = 0; i <= STEPS; i++) {
    const u = i / STEPS
    const theta = ROT_TH0 + ROT_SWEEP * u
    const roll = u <= 0.42 ? ROT_ROLL * (u / 0.42)
      : u <= 0.58 ? ROT_ROLL
      : ROT_ROLL * (1 - (u - 0.58) / 0.42)
    // The updraft. Zero at both mouths so the wall does not switch on at a
    // sample boundary, peaking where the road is fully vertical.
    const windEnv = Math.min(1, Math.max(0, Math.min(u / 0.20, (1 - u) / 0.24)))
    const w = 18 - 1 * Math.sin(Math.PI * u)
    const tag = i === 0 ? 'rotunda' : i === 9 ? 'rotunda-wall' : i === STEPS ? 'rotunda-out' : undefined
    out.push(drumNode(ROT_CX, ROT_CZ, ROT_R, theta, roll,
      ROT_Y0 + ROT_CLIMB * u, Math.round(w * 10) / 10, Math.round(19 * windEnv * 10) / 10, tag))
  }
  return out
}

/**
 * `up` for a road that is rolled `roll` degrees INTO a turn while still lying
 * on level ground -- the orrery's twist.
 *
 * `bearing` is the local heading in degrees clockwise from +Z, and positive
 * `roll` tilts the up-vector toward the driver's LEFT, which is the sense of a
 * left-hand corner banking correctly (outside edge high). Left at bearing b is
 * (-cos b, 0, sin b).
 *
 * WHY `up` AND NOT `bank`, given they look identical on screen. `bank` rotates
 * the road's frame and leaves gravity pointing at the world floor; `up` moves
 * gravity with the road. On a corner with no jumps the visible difference is
 * small, and the invisible one is the whole reason this beat exists: an
 * up-rolled road defaults `stick` to 1, so a racer that gets airborne here --
 * over a kerb, off another car -- falls back toward the road it left instead of
 * being dropped out of the twist. The city is anti-gravity architecture
 * throughout; the rotunda is the extreme case and this is the everyday one.
 */
function roll(bearing: number, deg: number): [number, number, number] {
  const b = (bearing * Math.PI) / 180
  const r = (deg * Math.PI) / 180
  return [-Math.cos(b) * Math.sin(r), Math.cos(r), Math.sin(b) * Math.sin(r)]
}

export const AETHERION: TrackDef = {
  id: 'aetherion',
  name: 'Namaresh',
  // GREY-BOX PALETTE, authored honestly and not art-passed. Gold, teal and
  // violet on white stone, at a low sun: a warm key raking across pale stone,
  // a violet fill so the shadow side of every column goes cool rather than
  // grey, and a teal accent that owns every emissive on the planet -- the
  // light-bridges, the glyphs, the boost chevrons and the rotunda ribs.
  //
  // Cryostatic's note applies here and was heeded: white stone under a white
  // sky graded onto a white fog buries the cars. So the sky is deep violet at
  // the zenith, the fog is a mid violet-grey well under the stone's own value,
  // and the density is low because this is a city with long sightlines and the
  // point of it is that you can see the next tier of it above you.
  skyTop: 0x1a1030,
  skyBottom: 0xc9a86a,
  fogColor: 0x6a5b7a,
  // ART PASS: 0.0034 -> 0.0027. "High clean air with long sightlines" is the
  // brief and the density was the thing stopping it -- at 0.0034 the far half
  // of the colonnade, the upper city and the whole of the causeway's drop were
  // already 80% fog. Thinning it is also what lets the terrain's own distance
  // grade (themes/aetherion.ts, terrainFade) do the work instead.
  fogDensity: 0.0027,
  sunColor: 0xffe6b0,
  sunIntensity: 1.35,
  ambientColor: 0x4a3b6b,
  ambientIntensity: 0.82,
  // ~25 degrees of elevation, raking ACROSS the colonnade so the flutes on the
  // columns read as flutes.
  //
  // ART PASS, and the one number on this def the pass moved. The grey-box
  // value was [-0.52, 0.44, 0.73], which put the sun straight down the home
  // straight: every column on the primary straight came out as a flat violet
  // silhouette against its own light source, which is the opposite of what
  // the comment on this line asked for. A helical flute is read by a GRAZING
  // light travelling across the shaft -- that is why the order exists -- so
  // the azimuth is now nearly perpendicular to the colonnade. The right-hand
  // row is lit, the left-hand row is in shade with a rim, and the shadows lie
  // across the road rather than pointing down it.
  sunDirection: [-0.86, 0.42, 0.29],
  // a: white stone, the road and the city.  b: gold -- capitals, keystone
  // edges, kerb chevrons, the rotunda ribs.  c: deep violet shadow stone.
  // accent: teal, and it is the ONLY emissive on the planet: a light-bridge
  // that is solid and a glyph that is lit are the same colour on purpose,
  // because the whole track is asking the player to read light as structure.
  palette: { a: 0xd8d2c4, b: 0xe8b44a, c: 0x2a2140, accent: 0x35f0d8 },
  laps: 3,
  nodes: [
    // === Beat 1: THE COLONNADE, start/finish ================================
    // THE PRIMARY STRAIGHT, and the only one the grammar allows. 410m of
    // collinear nodes from the line plus the 30m run-up to it, MEASURING 428m
    // of road under 1/260 of curvature: a Catmull-Rom bleeds the neighbouring
    // corner's curvature back into a straight from both ends, and Cryostatic's
    // note records four separate attempts to extend a straight that all made it
    // shorter. Over-author it and let the bleed eat the surplus.
    { p: [0, 10, 0], w: 24, surface: 'tarmac', tag: 'start' },
    { p: [0, 10.6, 105], w: 24, surface: 'tarmac' },
    { p: [0, 11.6, 210], w: 24, surface: 'tarmac' },
    { p: [0, 13, 310], w: 23, surface: 'tarmac' },
    { p: [0, 15, 410], w: 22, surface: 'tarmac', tag: 'colonnade-end' },

    // === Beat 2 approach: THE GATEHOUSE =====================================
    // The braking zone at the end of the primary straight, and a real one: 69m
    // of Class B right at R=99m mean, 61m at the apex, priced at 47.3 m/s
    // against a field arriving at 60+, while climbing 8m of the 17m up to the
    // causeway.
    //
    // It was a 130m-radius Class A for four balance passes, taken flat, and
    // that is what made the first third of this lap ONE 927m run at top speed:
    // 29% of the circuit in a single throttle-pinned block, on the track whose
    // brief is that it is the technical one. The corner now exits ON the
    // causeway's own bearing -- its last node sits 55m back along that line --
    // rather than arriving at it askew, which is what stopped the Catmull-Rom
    // re-straightening it.
    { p: [10, 16, 448], w: 21, surface: 'tarmac', bank: 8, tag: 'gatehouse' },
    { p: [34, 18, 474], w: 19, surface: 'tarmac', bank: 18 },
    { p: [66, 20.5, 496], w: 19, surface: 'tarmac', bank: 18 },
    { p: [101.4, 23, 519.2], w: 20, surface: 'tarmac', bank: 10 },

    // === Beat 2: THE CAUSEWAY OF PHASING LIGHT-BRIDGES =====================
    // 340m of straight elevated deck on a 62-degree bearing, of which three
    // spans -- measured at 51m, 50m and 49m -- are light rather than stone.
    // Each span carries its own OFFSET within the one shared 3.2s beat, and the
    // offsets are 0.00 / 0.49 / 0.98: a WAVE that runs away down the causeway
    // at 82m per 1.568s = 52.3 m/s. Measured, the field crosses at 51-54 m/s,
    // which is the planner riding the wave rather than surviving it.
    //
    // That number is the whole design. It sits under every chassis's top speed
    // (59.2-63.6) and above the speed any corner on the approach forces, so
    // "ride the wave" is a thing a driver does with the throttle and never with
    // the brakes, and the AI's planner (T.ai.bridgeHorizon) solves it as a
    // single cruise speed for the whole causeway rather than three panics.
    //
    // ---------------------------------------------------------------------
    // A SPAN DROPS HALF ITS DECK, NOT ALL OF IT, AND ALWAYS THE SAME HALF.
    //
    // The whole-deck version asked one question -- did you arrive on the beat
    // -- and the answer was set by the corner before, the missile that hit you
    // and the car you were following. The field fell 0.48-0.70 times a race to
    // it and the balance harness read the section as noise. It was a dice roll
    // priced as difficulty.
    //
    // Now the RIGHT half of every span gives way and the left half never does,
    // so there is always a line through and the line is the same line on every
    // lap of every race. Mistiming the wave is no longer fatal; it is fatal
    // only if you also failed to commit to the surviving lane. The beat became
    // the forgiveness window and the lane became the skill.
    //
    // WHY ALL THREE SPANS NAME THE SAME HALF, when the sim is perfectly happy
    // to alternate them. A racer who is off the beat drifts only ~0.09 of a
    // cycle across the whole 215m of causeway (du/ds = 1/(P*v), and the spread
    // between the wave speed and anything a car can actually hold here is a few
    // m/s), so it meets the absent window at ALL THREE spans, not one. The 32m
    // between spans is 0.61s at causeway speed, which against a ~36 m/s^2
    // lateral budget is about 3.4m of shift -- against the 8m it takes to get
    // from one side of the seam to the other with body clearance. An
    // alternating causeway is a slalom that is undrivable exactly when it
    // matters, i.e. by the racer the surviving lane exists to save. Three spans
    // one way is a lane you commit to on the approach and HOLD, which is the
    // shape the section wanted.
    //
    // WHY THE RIGHT HALF AND NOT THE LEFT, which is a wind question and was
    // measured both ways rather than argued. The crosswind here is positive,
    // i.e. it pushes toward `right`, and the header's measurement is that this
    // wind is a CLIFF not a ramp: taking its peak from 16.4 to 18.9 moved
    // Vector-7 from 23.5% of wins to 11.5%.
    //
    // Dropping the right half puts the surviving lane UPWIND. Every racer is
    // then blown from its lane toward the SEAM, and past the seam is a hole
    // that is only there 26% of the time. Dropping the left half puts the lane
    // downwind, and every racer is blown from its lane toward the open right
    // EDGE, which is there 100% of the time. Measured over 24 races, falls per
    // span entry:
    //
    //           whole span   drop LEFT (lane downwind)   drop RIGHT (lane upwind)
    //   ground     0.29              0.06                        0.02
    //   hover      0.47              0.29                        0.03
    //   flight     0.33              0.46                        0.05
    //
    // Dropping the left half makes the section WORSE for flight than the
    // whole-span version it replaced, because it takes away the upwind half of
    // the road that a car at fieldForceMult 1.8 was using as its margin. Upwind
    // it is the wind that gets forgiven, not the wind that gets charged twice.
    // ---------------------------------------------------------------------
    //
    // The spans are separated by plain nodes, which is required and not
    // cosmetic: TrackNode.phase is AND'd across a segment, so two phasing spans
    // that met at a shared node would merge into one long span.
    //
    // No barriers, 16m of half-width, and a crosswind that peaks between the
    // second and third span. The wind is what makes this the hover tax: the
    // air exposure a grounded chassis has, at 1.5x the field force, on a deck
    // with nothing at either edge.
    { p: [150, 27, 545], w: 19, surface: 'tarmac', wind: 4.7, tag: 'causeway' },
    { p: [176.5, 27.8, 559.1], w: 17, surface: 'tarmac', wind: 9.4, open: true },
    { p: [187.1, 28.1, 564.7], w: 16, surface: 'tarmac', wind: 10.9, open: true, phase: 0.0, drops: 'right', tag: 'bridge-1' },
    { p: [231.2, 29.4, 588.2], w: 16, surface: 'tarmac', wind: 13.3, open: true, phase: 0.0, drops: 'right' },
    { p: [244.5, 29.8, 595.2], w: 17, surface: 'tarmac', wind: 14, open: true },
    { p: [259.5, 30.3, 603.2], w: 16, surface: 'tarmac', wind: 14.8, open: true, phase: 0.49, drops: 'right', tag: 'bridge-2' },
    { p: [303.6, 31.6, 626.7], w: 16, surface: 'tarmac', wind: 16.4, open: true, phase: 0.49, drops: 'right' },
    { p: [316.9, 32, 633.7], w: 17, surface: 'tarmac', wind: 16.4, open: true },
    { p: [331.9, 32.5, 641.7], w: 16, surface: 'tarmac', wind: 15.6, open: true, phase: 0.98, drops: 'right', tag: 'bridge-3' },
    { p: [376, 33.8, 665.2], w: 16, surface: 'tarmac', wind: 12.5, open: true, phase: 0.98, drops: 'right' },
    // THE LAST 90m OF DECK LIE ON THE DRUM'S OWN ENTRY TANGENT, AND THE SPACING
    // TAPERS INTO IT. Both halves of that are load-bearing and both were wrong.
    //
    // The previous cut put a node 4.5m north of the causeway line and then met a
    // drum whose entry point sat 9m south of it -- an S the header described as
    // "a Class A corner at R=123m [that] costs nobody anything". Measured off the
    // ribbon it was a Class C at Rmin 39m priced at 37.9 m/s, i.e. the second
    // hardest braking zone on the lap, sitting where the beat sheet claimed a
    // straight. The drum centre now sits at the z that puts its entry tangent
    // exactly on this line (see ROT_CZ), so the road does not turn into the
    // rotunda at all: the rotunda is where the road stops being flat, which is
    // what the comment below already claimed.
    //
    // The taper is the other half. A Catmull-Rom is uniformly parameterised, so
    // a 32m segment meeting the drum's 14.1m ones bulges: measured, |k| over a
    // 20m window swung between R=41m and R=641m six times in the 60m either side
    // of the mouth, which is nine crossings of the AI's own drift-hold gate and
    // the reason 482 drifts a race were started and lost here. 36 -> 21 -> 17 ->
    // 14.1 holds the ribbon to the line it was drawn on.
    { p: [408, 34.7, 682.2], w: 18, surface: 'tarmac', wind: 6.8, open: true },
    { p: [426.5, 35.2, 692.1], w: 18, surface: 'tarmac', wind: 3.4 },
    { p: [441.5, 35.7, 700], w: 18, surface: 'tarmac', wind: 1.3 },

    // === Beat 3: THE ANTI-GRAVITY ROTUNDA ==================================
    // See rotunda() above. The causeway line is TANGENT to the drum at the
    // entry node, which is why there is no linking corner: the road does not
    // turn into the rotunda, the rotunda is where the road stops being flat.
    ...rotunda(),

    // === Beat 4: THE WARP GATE =============================================
    // The rotunda exits heading NNW, 54m up and 20m directly above the causeway
    // it arrived on -- the one place on the lap where the city's tiers are
    // legible from the road.
    // The exit tangent, tapered out of the drum the same way the entry tapers in.
    // The drum leaves at (431.6, 633.6) on a bearing of 332; the old flyover node
    // sat 20 degrees off that and produced the same ripple the entry did.
    { p: [424.6, 54.3, 646.9], w: 18, surface: 'tarmac' },
    { p: [414.7, 54.7, 664.3], w: 19, surface: 'tarmac', tag: 'keystone-flyover' },
    { p: [402.1, 55.1, 687], w: 20, surface: 'tarmac' },
    // THE GATE IS A RAMP, AND IT DID NOT NEED A NEW FIELD. What a warp gate has
    // to do is throw a car across a gap and telegraph itself; `ramp` sets a
    // launch velocity and `boost` lights the approach, and a second launch
    // field would be a second copy of T.ramp with its own tuning to drift out
    // of sync. Power 38 gives 2.38s of hang to a landing 5.5m lower, which is
    // 124m at 52 m/s against a 116m gap -- 7% of margin at the slowest speed
    // anything reaches here, and more for everyone else.
    //
    // THE GAP IS FICTION, AND THAT IS WORTH SAYING OUT LOUD. This engine has no
    // representation of a hole in the deck except TrackNode.phase, so a racer
    // that fails to launch simply drives down the trench floor these three
    // `open` nodes describe -- exactly as it does at Rustfall's chasm and
    // Cryostatic's. Putting a permanently phased-out span under the gate was
    // considered and rejected: one new fall hazard done properly is worth more
    // than two done nervously, and a jump that respawns you on a miss is a far
    // harsher beat than either shipped track carries.
    { p: [388.5, 55.5, 713.8], w: 20, surface: 'tarmac', boost: true, ramp: 38, tag: 'warp-gate' },
    { p: [373, 54, 748.5], w: 18, surface: 'tarmac', open: true },
    { p: [359.4, 52, 784], w: 18, surface: 'tarmac', open: true },
    { p: [347.1, 50, 820], w: 22, surface: 'tarmac', open: true, tag: 'warp-landing' },

    // === Beat 5: THE ORRERY ================================================
    // A 170-degree climbing left spiral around the floating armillary, measured
    // as three corners of R=64/42m, 79/58m and 83/42m (39.1-45.9 m/s), rolled up
    // to 38 degrees INTO the turn with `up` rather than `bank`. Rising and
    // twisting, and the tightening is what makes it a corner you can get wrong:
    // the entry rewards patience and the exit is the last place on the lap wide
    // enough to pass before the plaza. It is one 205m drift-hold run at charge
    // 3.81 -- a Tier 2 alone, and a Tier 3 for anything chaining out of it.
    //
    // The boost pad is on the EXIT and not on the straight after it. That is a
    // measured placement, not a flourish: stepAI lifts the flight class whenever
    // the local radius exceeds ~333m and the car is above 70% of top speed, and
    // a lifted chassis sits at 5m where the pad test (altitude < 3.0) cannot see
    // it. Every pad on this track therefore sits inside a corner.
    //
    // THERE ARE ONLY THREE PADS NOW, AND THAT WAS WORTH SEVENTEEN POINTS OF
    // BOOST UPTIME. The first cut had six, and the fourth of them -- a 49m strip
    // on the gatehouse exit, the longest on the lap -- was on its own the
    // difference between 80-85% boost uptime and 69-73%, which is where the two
    // shipped tracks sit. The reason it is worth that much is applyBoost: a pad
    // re-applies EVERY FRAME the car is on the strip, and each re-application
    // takes the weakerExtend branch, so a strip grants ~0.38s of boost per frame
    // rather than padDuration once. See the report; it is a sim defect this
    // track merely spends less on than the first cut did.
    { p: [335.6, 48.5, 849.9], w: 20, surface: 'tarmac', up: roll(339, 10), tag: 'orrery' },
    { p: [324, 50.5, 880], w: 19, surface: 'tarmac', up: roll(332, 26) },
    { p: [294, 53, 904], w: 18, surface: 'tarmac', up: roll(309, 36) },
    { p: [260, 55, 908], w: 18, surface: 'tarmac', up: roll(282, 38) },
    { p: [228, 56.8, 896], w: 18, surface: 'tarmac', up: roll(254, 38) },
    { p: [202, 58, 876], w: 18, surface: 'tarmac', up: roll(230, 32) },
    { p: [186, 58.8, 850], w: 19, surface: 'tarmac', up: roll(208, 22), boost: true, tag: 'orrery-out' },
    { p: [182, 59, 822], w: 20, surface: 'tarmac', up: roll(190, 8) },

    // === Beat 6: KEYSTONE PLAZA ============================================
    // The city square, the widest road on the lap at 26m of half-width, and the
    // only place on the planet the city has lost: two thousand years of drifted
    // dust lies across the square and nobody has swept it.
    //
    // THE DUST IS WHAT MAKES THE PLAZA A CORNER. The sweeper measures R=179m
    // mean and 126m at its tightest, which on clean stone prices out at 68.0
    // m/s -- above the roster maximum, i.e. a straight with a lattice of
    // tetrahedral keystones over it. On gravel it is 56.9 m/s. That is the same
    // argument Cryostatic makes about its lake ("the corner exists ONLY because
    // it is ice") and it is the only argument that justifies a low-grip surface
    // on a track whose hook is not surfaces. The dust now runs 699m -- 22% of
    // the lap, 85% of it inside a corner -- because it also follows the terraces
    // down (see the sweeper below), and it costs 1.53s/lap of cornering.
    //
    // THE CROSSWIND LIVES HERE, AND THAT IS DELIBERATE. 23.2 m/s^2 of authored
    // field is 34.8 for hover and 41.8 for flight against a ~36 m/s^2 lateral
    // budget, which sounds lethal and is not: this is 26m of WALLED road, so the
    // field spends itself as scrub and lost line rather than as respawns. It is
    // the graded half of the class tax; the causeway is the cliff half.
    //
    // THIS NUMBER IS SPENT. It is the obvious lever for Bulwark -- grounded is
    // fieldForceMult 1.0, so a crosswind is the one tax that skips the chassis
    // sitting on the floor -- and it was measured to exhaustion at 600 races
    // rather than argued about. Raising it to 29.0 and then 34.8:
    //
    //   seed          bulwark %          lead retention %
    //   (base)     9.8 / 11.7 / 11.7   47.0 / 50.3 / 51.7      wind 23.2
    //   +25%         11.2 / -- / --      52.5 / -- / --        wind 29.0
    //   +50%      12.0 / 13.3 / 12.0   55.0 / 52.7 / 53.3      wind 34.8
    //   0x5eed1234   10.8 -> 11.5        55.5 -> 57.0          +25% -> +50%
    //
    // It buys about a point of Bulwark for about two points of retention, and
    // the balance harness's own default seed has no retention headroom to spend:
    // it fails the 55% ceiling before Bulwark reaches the 12% floor. A crosswind
    // taxes the WHOLE field, so it compresses the pack, and a compressed pack is
    // a pack the leader does not escape. The next pass that wants grounded share
    // has to find it somewhere that does not also slow everyone down.
    // Wide and heavily banked is still the point: it is the one place a slower
    // chassis can use a slipstream, and it carries the item row at 0.58.
    { p: [166, 58.6, 790], w: 22, surface: 'gravel', wind: 8, bank: 8, tag: 'plaza' },
    { p: [134, 57.8, 758], w: 24, surface: 'gravel', wind: 15.8, bank: 16 },
    { p: [94, 57.2, 736], w: 25, surface: 'gravel', wind: 23.2, bank: 24 },
    { p: [44, 56.6, 728], w: 26, surface: 'gravel', wind: 23.2, bank: 26 },
    { p: [-4, 56, 732], w: 26, surface: 'gravel', wind: 21.1, bank: 26 },
    { p: [-50, 55, 748], w: 25, surface: 'gravel', wind: 15.8, bank: 22 },
    { p: [-94, 53.8, 762], w: 24, surface: 'gravel', wind: 9.5, bank: 14, tag: 'plaza-out' },

    // === Beat 7: THE TERRACE SWEEP AND THE DESCENT =========================
    // 366m of dust turning 132 degrees left off the plaza and down the western
    // terraces, then 369m of falling straight. This is the track's TIER-4
    // CORNER and its only Singularity that does not need a chain: R=100 for the
    // first 25 degrees so the AI's drift ENTRY gate (R < 133m) fires, opening to
    // R=180 for the remaining 107 so it can be held all the way -- 330m of
    // continuous drift-hold arc at charge 5.60 against the 4.20 Tier 3 costs.
    //
    // WHY IT OPENS RATHER THAN TIGHTENS. Charge per DEGREE of turn grows with
    // radius (0.017/deg at R=40, 0.057/deg at R=200) because a wider corner is
    // taken faster only as the square root while it is longer in proportion to
    // R; turn angle, not arc length, is the scarce resource on a lap that only
    // has 900 degrees of it. But charge per METRE moves the other way, and the
    // ENTRY gate needs one point under R=133m or the AI never opens the drift at
    // all. Tight-then-open gets both. It is also why this sits on the dust: the
    // gravel takes ~16% off the speed and hands it straight back as charge.
    //
    // WHAT THIS REPLACED, and it is worth writing down because the old comment
    // was measurably wrong. The descent used to be eight waypoints weaving
    // +/-10m of lateral, described here as holding "a 210-320m radius". Measured
    // over the 20m window the AI actually reads, it held R=87-120m at its wiggle
    // peaks -- five separate Class-B kinks that probe-track's corner census
    // never reported because none of them turned the 22 degrees it needs to call
    // something a corner. Each one opened a drift the next one killed: five junk
    // entries a lap on the section the beat sheet called a straight.
    //
    // A version of this beat with a real weave (R=44-61 esses, three braking
    // events) was built and measured and is still the wrong track: it cost 1.8s
    // a lap and handed the difference to the highest-handling chassis in the
    // roster (Filament 25.0% -> 35.3% of wins over 300 races). One long corner
    // that binds at -20% is not that: nobody brakes for it, and what it sells is
    // drift charge rather than a handling test.
    { p: [-137.1, 52.6, 766.1], w: 24, surface: 'gravel', wind: 6.3, bank: 4 },
    { p: [-181.1, 51.4, 755], w: 23, surface: 'gravel', wind: 3.1, bank: -6 },
    { p: [-221, 50.2, 733.1], w: 23, surface: 'gravel', bank: -10 },
    { p: [-254, 48.9, 702], w: 22, surface: 'gravel', bank: -12 },
    { p: [-278.3, 47.7, 663.6], w: 22, surface: 'gravel', bank: -12 },
    { p: [-292.1, 46.5, 620.3], w: 22, surface: 'gravel', bank: -11 },
    { p: [-294.7, 45.2, 574.9], w: 21, surface: 'gravel', bank: -9 },
    { p: [-285.9, 44, 530.4], w: 21, surface: 'gravel', bank: -5, tag: 'descent' },
    { p: [-263.9, 37.1, 464.7], w: 21, surface: 'tarmac' },
    { p: [-241.9, 30.2, 399.1], w: 21, surface: 'tarmac' },
    { p: [-220, 23.4, 333.5], w: 21, surface: 'tarmac' },
    { p: [-198, 16.5, 268], w: 21, surface: 'tarmac', tag: 'descent-out' },

    // === Beat 8: THE GLYPH STEPS ===========================================
    // The tight technical sequence, and the equaliser. Narrow white stone with
    // calligraphic light glyphs cut into the terrace faces, and no gimmicks at
    // all -- no wind, no bridges, no gravity tricks -- because after the
    // rotunda and the causeway the hardest thing this track can still ask for
    // is an ordinary corner taken properly. Right-left-left-right down a
    // stepped terrace at R=110/61, 88/49, 64/41 and 89/53 (47.1 down to 38.8
    // m/s) into the final Class C onto the colonnade.
    //
    // TWO CORNERS AND NOT EIGHT. The first cut of this section had eight, and
    // eight braking events in 430m is a handling test rather than a driving
    // one: it took Filament (handling 9) to 35.3% of wins and Dray-9 (handling
    // 4) to 5.0%, against a 12-30% band. Merging them into four longer corners
    // at the same radii cost nothing in cornering; merging those four into two
    // (see below) is what finally made them chargeable, because four corners in
    // 430m is five sign changes and a drift cannot survive a sign change.
    // TWO CORNERS, NOT FOUR, AND BOTH LAID OUT AS ARCS. The four-corner cut
    // measured as five separate drift-hold runs of 24 / 64 / 29 / 113 / 38m,
    // because a Catmull-Rom through waypoints that turn at 14 degrees per 66m
    // and then 31 degrees per 61m holds R=262 and then R=113: the AI's hold gate
    // (R < 222m) drops out in the middle of what the beat sheet called one
    // corner, and it re-enters on the far side with the charge reset. These are
    // one R=110 right through 45 degrees and one R=72.5 left through 100, each
    // spread evenly over its own arc, which is the same fix the last corner
    // already carries and for the same reason.
    { p: [-175.4, 15.1, 198.6], w: 18, surface: 'tarmac', bank: 0, tag: 'glyph-steps' },
    { p: [-170.2, 14.5, 170.1], w: 18, surface: 'tarmac', bank: 6 },
    { p: [-172.5, 13.9, 141.2], w: 18, surface: 'tarmac', bank: 10 },
    { p: [-182.3, 13.4, 114], w: 18, surface: 'tarmac', bank: 11 },
    { p: [-200, 12.6, 80], w: 18, surface: 'tarmac', bank: 11 },
    { p: [-208.2, 12.3, 49.8], w: 18, surface: 'tarmac', bank: -6 },
    { p: [-202.7, 12, 19], w: 18, surface: 'tarmac', bank: -12 },
    { p: [-184.8, 11.7, -6.7], w: 18, surface: 'tarmac', bank: -14 },
    { p: [-157.8, 11.4, -22.4], w: 18, surface: 'tarmac', bank: -12 },
    // THE LINK, AND IT IS DELIBERATELY TOO GENTLE TO DRIFT. The road has to turn
    // 27 degrees right between the Glyph Steps' long left and the last corner's
    // long left, and the first cut spent that turn in 21 degrees at one node --
    // R=41m at its apex, 29m of chargeable arc, and 308 drift entries a race in
    // one bucket that banked nothing. Spread evenly over the whole 83m link it
    // is R=156: still inside the hold gate, but OUTSIDE the R<133m the entry
    // gate needs, so the AI does not open a drift it cannot finish. The one node
    // also tapers the spacing 31 -> 46 -> 37 -> 31 into the last corner's arc,
    // which is what stopped |k(s,20)| crawling along the 0.0045 hold gate for
    // twelve metres at the turn-in -- the same Catmull-Rom failure as the
    // rotunda mouth, and the same fix.
    { p: [-134.9, 11.2, -31.8], w: 19, surface: 'tarmac', bank: -4 },
    { p: [-113.8, 11, -44.7], w: 19, surface: 'tarmac', bank: 0 },
    // THE LAST CORNER, laid out as an actual arc and not as four waypoints that
    // happen to curve. The hand-placed version pinched to a 19m radius at its
    // apex -- under the grammar's own 20m Class C floor, and priced at 26 m/s
    // against a field arriving at 55 -- because a Catmull-Rom concentrates
    // curvature wherever the waypoint spacing tightens, and the spacing here
    // tightened right at the apex. These five nodes are 33.75 degrees apart on
    // a 52m circle centred at (-52, -30), which spreads the curvature evenly
    // and holds the measured radius near the one it was drawn at. Same fix
    // Rustfall's final corner needed, for the same reason.
    // THE DUST REACHES THE LAST CORNER, AND IT IS THERE FOR BULWARK.
    //
    // The lap has ~1810m where the AI's corner limit sits above the roster's
    // 63.6 m/s maximum -- 56% of it, against Rustfall's 46% -- and on road like
    // that the only thing separating two chassis is topSpeed. Bulwark is last
    // on that axis (6 against Dray-9's 8), which is 0.001169 s/m, and
    // tools/probe-sector.ts bins where it actually goes: at matched AI skill
    // Bulwark loses 0.32s a lap to the field mean, +0.31s of it across the
    // colonnade and the gatehouse alone and +0.16s more on the descent
    // straight. It GAINS 0.27s back over the causeway and the bridges. The
    // deficit is not cornering and it is not the drift; it is the straights.
    //
    // You cannot delete the primary straight, so the answer is to arrive on it
    // already boosted. Tier 3 is +52% of top speed for 3.0s plus up to 2.4s of
    // duration bonus -- more than enough to cover 400m -- and the last corner is
    // the last thing before the line. On clean stone its drift run banks 3.02 of
    // charge and the best any chassis actually reached was 3.74 against the 4.20
    // Tier-3 gate: close, and worth nothing. Dust takes the corner from 37.5 to
    // 28.4 m/s, and charge per metre is 0.55/v + 0.45/topSpeed, so the slower
    // corner banks 3.35 -- which crosses 4.20 only once it is multiplied by a
    // driftChargeMult of 1.30. That is Bulwark's, and nobody else's: Solaire is
    // 1.12, Dray-9 and Filament 1.06, Vector-7 1.06 after its locomotion
    // penalty. The Singularity onto the home straight is the drift king's, by
    // arithmetic rather than by favour.
    //
    // Measured at 600 races: Bulwark 10.7% -> 13.3% of wins, the lap's Tier-3
    // share 7.2%, lead retention 49.5%, and 0.57s on the lap mean.
    { p: [-88.8, 10.7, -66.8], w: 20, surface: 'gravel', bank: -6, tag: 'last-corner' },
    { p: [-62.1, 10.5, -81], w: 20, surface: 'gravel', bank: -12 },
    { p: [-32.1, 10.25, -78], w: 20, surface: 'gravel', bank: -12 },
    { p: [-8.8, 10.05, -58.9], w: 21, surface: 'gravel', bank: -8, boost: true },
    { p: [0, 10, -30], w: 22, surface: 'tarmac', bank: -3 },
  ],
  // ITEM BOX ROWS. The same measured failure Rustfall and Cryostatic record
  // applies here and is not re-litigated: `stepAI` has no item-seeking term, so
  // a row taken off the driven line is not a row the AI works for, it is a row
  // the AI never touches. Rows sit on the line, spreads stay at or above the
  // 2.4m box mesh, and the fix belongs in src/sim/ai.ts.
  itemBoxRows: [
    { at: 0.07, count: 5, spread: 4.4 },
    { at: 0.23, count: 4, spread: 4.0 },
    { at: 0.40, count: 5, spread: 4.2 },
    { at: 0.58, count: 5, spread: 4.4 },
    { at: 0.78, count: 5, spread: 4.2 },
  ],
  chargeRuns: [
    { from: 0.02, to: 0.07, count: 6, lateral: -5 },
    { from: 0.16, to: 0.21, count: 6, lateral: 5 },
    { from: 0.33, to: 0.39, count: 8, lateral: 0 },
    { from: 0.51, to: 0.57, count: 6, lateral: -5 },
    { from: 0.69, to: 0.75, count: 7, lateral: 5 },
    { from: 0.87, to: 0.94, count: 8, lateral: 0 },
  ],
}
