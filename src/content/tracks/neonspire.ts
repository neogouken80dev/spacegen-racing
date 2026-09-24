import type { TrackDef, TrackNode } from '../../sim/track'
import { circuit, type Seg } from './circuit'

/**
 * ZHEN-9 — Stacked Metropolis.
 *
 * ===========================================================================
 * REDESIGNED FROM A HARMONIC RING TO A NAMED CIRCUIT.
 * ===========================================================================
 *
 * The previous Zhen-9 -- like Meridian Deep, Halcyon Bay and Ashkar -- was a
 * sum of two or three harmonics: smooth everywhere, no straights, no braking
 * zones, and a radius that wandered wherever the coefficients pushed it. The
 * report that killed all four: "the overall oval or square-ish type design
 * does not offer a lot of variety in driving experience... the few turns are
 * far too sharp to allow smooth drifts and ends up causing the user to crash
 * into the walls." Zhen-9 measured a MEDIAN radius of 113m against a single
 * 46m minimum -- flat out for most of the lap, then one corner nothing could
 * hold. This file replaces that ring with `circuit()`: a named sequence of
 * straights and corners of CHOSEN radius, authored the way Long Beach or
 * Road Atlanta actually is, corner by corner.
 *
 * The physics that drove every radius below (grip 1.0, roster top speed
 * 59-64 m/s, corner speed = sqrt(1.07 * 34 * R)):
 *
 *   45-58m   38-44 m/s   62-74%   hairpin, heavy braking -- at most two
 *   58-80m   44-54 m/s   74-88%   the corner a driver actually DRIFTS
 *   80-110m  54-61 m/s   88-103%  fast corner, a lift and a commitment
 *  110-220m  flat out    >100%    sweeper -- still a corner to the AI's
 *                                 drift-hold gate (curvatureAt gate, R<222m)
 *
 * TWENTY corners land: 2 hairpin, 12 medium, 4 fast, 2 sweeper. Ninety per
 * cent of them sit in the 58-220m bands the old ring never visited, and the
 * TIGHTEST reading anywhere on the baked lap is 49m -- there is no longer a
 * single corner on this circuit that asks for less than 70% of top speed.
 *
 * ===========================================================================
 * THE SKETCH PASS: THE INFIELD VINCE DREW, AT THE SIZE HE DREW IT.
 * ===========================================================================
 *
 * The brief was a two-panel sketch (`/home/claude/sketches/zhen9-sketch.png`):
 * left panel the circuit as it shipped, right panel the SAME outer shape --
 * the notched Holo Ring zigzag across the top, the bump on the left, the long
 * bottom-left diagonal, the maglev start straight down the right -- with a
 * large "2"-shaped double-hook complex added through the centre and lower
 * right, taking over the long anonymous run that used to join the bottom of
 * the left-hand diagonal to Maglev C. "Make sure the maps are as designed.
 * Feel free to add track obstacles boost as necessary."
 *
 * Asked directly whether to shrink the drawing to fit the old 55-75s lap band
 * or draw it full size and accept a longer lap, Vince chose the drawing:
 * "match the overall shape, and keep the longer distance. i dont mind if its
 * longer." `tools/probe-newtrack.ts`'s band is now 55-105s. So the infield
 * below is the drawing's own size and the lap time it costs is REPORTED
 * rather than designed around: 3231m and 69.6s became 4323m and 93.1s.
 *
 * ---------------------------------------------------------------------------
 * THE SKETCH, MEASURED RATHER THAN EYEBALLED.
 *
 * Both panels are drawn in the projection `tools/plot-track.ts` uses (the
 * minimap's: start straight up the frame, screen-right = world -X), at the
 * same scale, 14 sketch pixels apart horizontally and not at all vertically.
 * Skeletonising each panel's road band and fitting the LEFT one against this
 * circuit's own baked centreline gives 1.998 m per sketch pixel at a mean
 * residual of 33.4m over a 3.2km lap -- which is the drawing's own line width,
 * so the left panel IS this circuit and the calibration is real.
 *
 * At that scale the right panel measures 4042m of PLAN road against the left
 * panel's 3073m: the infield is worth about +970m, a third again as much lap.
 * Every geometric number below was then read off the traced right-hand panel
 * the same way -- heading change between two points divided by the road length
 * between them, which is the same swept-angle measure `plot-track.ts` uses and
 * is stable against a marker stroke's wobble in a way a circle fit over a 70m
 * window is not (the two disagreed by 40% on the infield's first hook):
 *
 *   drawn feature                     swept    road    implied R   authored
 *   bottom run out of T12              0 deg    110m      --         101m
 *   turn-in up off the bottom run    +74.6      72m       55m     58m / +75
 *   opening radius after it          +42.7      96m      129m    130m / +43
 *   climbing run to the first hook     0       120m       --         137m
 *   first hook, left                 -96.6     144m       85m      70m / -92
 *   the "2"'s long diagonal            0       220m       --         216m
 *   top hook, left                  -176.5     290m       94m    66/40/66
 *   the "2"'s return diagonal          0       150m       --         149m
 *   bottom hook, right              +176.4     252m       82m    68/40/68
 *   exit onto Maglev C                 0       315m       --     73m + 238m
 *
 * The drawn angles sum to +25.1 degrees between T12's exit and Maglev C. The
 * corner they replace -- old T13, Summit Sweep -- was +26. That is not a
 * coincidence and it is the strongest evidence the trace is right: the sketch
 * preserves both ends of this stretch (T12's exit heading and the start/finish
 * line), so any honest reading of the infield HAS to come back to the same net
 * turn. The five drawn features are authored at +75 / +43 / -92 / -172 / +172,
 * which hits +26 exactly, so the lap still sums to +360 and `circuit()` closes
 * it without being asked to absorb a heading error in the straights.
 *
 * ---------------------------------------------------------------------------
 * THE TWO HOOKS ARE ROUNDED RECTANGLES, NOT HAIRPINS, AND THAT WAS MEASURED.
 *
 * Drawn at a marker's width, each hook of the "2" LOOKS like a squared-off
 * corner -- turn, run, turn -- rather than a circular U. Both readings were
 * fitted to the traced stroke and scored by mean two-way nearest-point
 * distance (the honest version of "does this curve lie on that curve"):
 *
 *                              single arc        corner-straight-corner
 *   top hook (290m, -176.5)    R=88, err 16.4m   R81/-56 + 30m + R57/-120,
 *                                                            err 11.8m
 *   bottom hook (252m, +176.4) R=69, err  9.3m   R67/+121 + 30m + R45/+55,
 *                                                            err 14.2m
 *
 * So the trace cannot separate them: both models sit inside 16m, which is
 * under half the road's own width, and each wins on one hook. The decision was
 * made on the picture and on the RACING instead, and both point the same way.
 * On the picture, the squared reading is visibly what the marker drew. On the
 * racing, a single 172-degree arc is 240-250m of UNBROKEN steering, and that
 * is what the field kept falling over -- see below. Each hook is therefore
 * authored as two 86-degree corners with a 40.5m straight between them, with
 * the radii chosen so the hook's FOOTPRINT matches the single arc it replaces
 * (2R + S against 2R: 66 and 68 against 84 and 80), which is what keeps the
 * plan from growing where the drawing says it should not.
 *
 * WHAT THAT COST AND WHAT IT BOUGHT, measured both ways round:
 *
 *   hooks as single arcs   shape 23.2m mean / 69m worst   0.3 respawns/race
 *   hooks split (shipped)  shape 25.3m mean / 90m worst   0.0 respawns/race
 *
 * ("shape" is the mean and worst nearest-point distance from the baked
 * centreline to the traced sketch, after nothing but the calibration above --
 * no re-fitting.) 2.1m of mean shape error is a fifteenth of the road's width
 * and invisible in plan; the hooks' squared character, which the split version
 * has and the single-arc version does not, is visible at a glance.
 *
 * WHAT WAS NOT TAKEN LITERALLY, AND WHY. Two more drawn radii came in under
 * the 45m floor this project keeps being reminded of ("challenging turns are
 * what we want, not impossible ones"). The turn-in off the bottom run traces
 * at 55m swept and 42m circle-fitted -- a marker elbow, not a surveyed radius
 * -- and is authored at 58m, the floor of the medium band. The first hook
 * traces at 85m over its full length and 59m over its tightest 160m; it is
 * authored at 70m, the middle of that range and of its band. Both moves are
 * under 16m on a 4.3km lap: a fifth of the sketch's own line width.
 *
 * ---------------------------------------------------------------------------
 * THE CLEARANCE RULE THE INFIELD HAD TO ANSWER FIRST.
 *
 * `probe-selfclear.ts` gates road SURFACES at 2.0m, but the built world puts a
 * 3m wall at each road edge, so two decks that pass the probe can still have
 * one rail stabbing through the other's driving surface. A tight infield
 * folded back on itself twice is exactly the layout that discovers this. The
 * rule held to here is the stricter one: no two parts of the lap within 9m in
 * 3-space unless they are deliberately side by side at one height with 4m+
 * between their edges, or bridged with 20m+ of vertical clearance.
 *
 * It was checked on the SKETCH before a line of this file was written, by
 * taking the traced right-hand panel and measuring every pair of points more
 * than 140m apart along the lap. The closest the DRAWING ever brings two
 * distant parts of itself is 98m, and inside the infield the worst pair is
 * 107m -- the "2"'s two diagonals sit 148m apart, its entry run 113m from the
 * bottom hook. So the drawing had no clearance problem to solve, and the built
 * lap inherits that. Measured on the built world by `probe-selfclear.ts`,
 * which expands every sample across its own rolled ribbon, the closest any two
 * parts of this lap more than 70m apart ever come is 8.3m -- and that worst
 * case is the Holo Ring's own entry against its own exit, which is the loop's
 * stagger doing its job. The rail is a separate question and a separate
 * instrument: `probe-solidclear.ts` stands the barrier, skirt and soffit the
 * mesh actually builds and asks whether any of it is in another deck's
 * airspace, and it clears the same pair by 4.50m. Nothing in the infield
 * needed a bridge, a `toY` step or a nudge off the drawn line.
 *
 * ---------------------------------------------------------------------------
 * AND THAT ONE PAIR IS WHERE THE 50% WIDTH PASS RAN OUT OF ROOM.
 *
 * That pair is the only place on the lap a width change could break, because
 * it is the only place two parts of the lap are held apart by a CONSTANT that
 * does not grow with them. `circuit()` writes it down in its own
 * comment -- "the loop leaves a FULL stagger across the road, which is also
 * the clearance between its entry and its exit" -- so 54m is fixed geometry
 * and every metre of road added to either side is a metre taken out of it.
 * Take both decks to x1.5 (25.5 and 27.75 half-width) and they want 53.25m of
 * that 54m plus the 0.67m each barrier reaches outboard of its own edge, and
 * `probe-solidclear.ts` duly reported the loop's rail 0.31m inside the exit
 * straight's airspace and a viaduct pier 0.33m inside it.
 *
 * THE VERTICAL FIX DOES NOT EXIST HERE, which is worth writing down because it
 * is the first thing anyone will reach for and it looks like it should work:
 * the two decks are only 4.0m apart in y where they touch, and
 * `probe-solidclear`'s own sabotage sweep puts the flip point at 4.55m (1.55m
 * of skirt plus 3.0m of barrier airspace), so it fails by about a third of a
 * metre. But a loop's two mouths are at the SAME height by construction --
 * `circuit()`'s loop branch ends with `y = y0` -- so the separation starts at
 * ZERO at the mouth and grows only as r*(1 - cos(s/r)). At r=34 it reaches
 * 4.55m after 17.8m of arc, by which point the road has gone 17.0m forward and
 * the exit straight has already ramped to full width one node in. To be clear
 * vertically before that, the mouth would have to rise 4.55m inside about 10m
 * of forward travel, which is r = 11 -- a third of the r >= 32 the builder
 * enforces, and a loop that tight reads to `curvatureAt` as a phantom hairpin.
 * No `toY` reaches this either, and that was measured rather than reasoned
 * about: a ramp is authored over a whole straight, so the 40.6m exit stub at
 * this file's own 7.4% grade ceiling is 0.9m down where the conflict starts
 * and 1.3m down where it ends. Built and run at the x1.5 widths it "passes" by
 * 0.06m -- the same kind of hairline Frosthelm once cleared this gate by, which
 * is to say not a pass -- and it still leaves 3.08m of headroom over its own
 * road, because tilting the EXIT stub does nothing for the mirrored pair on
 * the other side of the loop, where the descent comes down beside the APPROACH
 * stub at the same 54m. So the lever is LATERAL, and there are exactly two of
 * them: `stagger`, and the width of the road at the loop.
 *
 * STAGGER WAS TRIED FIRST AND IT RUNS OUT BEFORE IT IS ENOUGH. Swept at the
 * shipped x1.5 widths, each extra metre of stagger buys 0.67m of solid
 * clearance -- 54: -0.31 (fail), 55: 0.33, 56: 0.92, 57: 1.66, 58: 2.37 -- and
 * then it stops, because stagger is LAP GEOMETRY. It shifts everything after
 * the loop 54m sideways, so `circuit()` re-solves every straight around it,
 * and at 60 a straight lands under the builder's 40m floor and its silent
 * uniform auto-grow fires: 4323m becomes 4418m, over 20 more nodes. The usable
 * range therefore ends at 58, which is 2.37m of clearance and leaves the baked
 * lap 0.098m under the sample cliff below -- a hairline on both gates at once.
 * WIDTHS DO NOT ENTER THE CLOSURE WALK AT ALL: `circuit()` reads `w` only when
 * it writes a node, never when it walks the plan. So a width change at the
 * loop is exactly length-neutral, cannot move a radius, and cannot trip the
 * auto-grow. That is what ships -- see the Holo Ring's own segment below.
 *
 * ---------------------------------------------------------------------------
 * IDENTITY, UNCHANGED: HARD FROM GEOMETRY ALONE.
 *
 * Every other Hard circuit in the game is hard because of a substance --
 * Frosthelm's ice, Meridian Deep's biofilm, Centurion Prime's vacuum. Take the
 * substance away and they are wide, fast and forgiving. Zhen-9 has no hostile
 * surface anywhere: dry maglev deck, grip 1.0, `metal` end to end. It is the
 * hardest lap in the roster because the road is 22-33m half-width and walled
 * on both sides (`bounce: true` everywhere except the two set pieces), not
 * because anything is slippery. Every wall bounces rather than scrubs, which
 * is what makes a walled street circuit driveable at all: contact costs speed
 * and nothing else, so leaning on a barrier through a corner is a line a
 * driver CHOOSES rather than a drift-ending accident.
 *
 * THE OIL THE BRIEF OFFERED WAS TRIED AND MEASURED, NOT ASSUMED. A rain-slick
 * `oil` stretch is in character for a city at night and it was the obvious
 * thing to spend the infield's new ground on. Three placements were raced over
 * 128 races each against the same geometry without it (0.31 respawns/race,
 * 90.92s mean):
 *
 *   oil on the climbing run   92.20s  0.38 respawns/race
 *   oil on the Wharf run      92.47s  0.44
 *   oil on the infield exit   92.04s  0.13
 *
 * So it is not free anywhere: 1.1-1.5s of lap time, and on two of the three
 * placements MORE respawns, on the circuit whose whole stated identity is that
 * it is hard without a slippery surface. None of the three shipped. The
 * paragraph above still describes this track, and that is the point.
 *
 * THE MAGLEV IS THE COMPENSATION. Five `boost: true` runs -- the start
 * straight, the two halves of the Holo Ring's feed, the infield's return
 * diagonal and the run into the final corner -- carry more boost road than any
 * other circuit. That is what stops a narrow, technical lap from being merely
 * slow: the rhythm is real top speed alternating with hard braking, never both
 * at once.
 *
 * THE ONE PIECE OF BOOST THE SKETCH DOES NOT DRAW. The sketch's yellow is
 * unchanged between panels: Maglev A up the right side, the Holo Ring's two
 * feed stubs, Maglev C into the line. The infield is drawn plain. It is given
 * one 149m boost strip anyway -- Maglev D, the "2"'s return diagonal between
 * the two hooks -- and the justification is the brief's own sentence, "feel
 * free to add track obstacles boost as necessary", plus what that stretch is:
 * the shortest straight on the lap joining its two slowest corners, 149m in
 * which a car otherwise never leaves third. Without it the infield is four
 * consecutive sub-70m corners with nothing between them, which is the "no
 * variety" complaint in miniature. It is the only deviation from the drawing's
 * yellow, and removing it was measured too: 0.50 respawns/race against 0.31
 * and no lap time back, so it is not even paying for itself in difficulty.
 *
 * ===========================================================================
 * WHAT THREW THE FIELD OFF THE BOTTOM HOOK, AND WHAT ACTUALLY FIXED IT.
 * ===========================================================================
 *
 * The first geometry that closed raced 24/24 and inside the lap band on its
 * first try, and put EVERY respawn it had at one place: the second half of the
 * bottom hook, s=3780-3930, 4 to 6 of them across 128 test races. Hand-
 * reasoning about why has been wrong all through this project, so each racer's
 * last five seconds before its respawn armed were logged instead:
 *
 *   t-5.5s  splineS 3877  lat -0.85w  spd 29 m/s   offTrackTime 0.00
 *   t-4.0s  splineS 3886  lat -0.84w  spd 12 m/s   offTrackTime 0.00
 *   t-2.5s  splineS 3885  lat -0.86w  spd  0 m/s   offTrackTime 0.00
 *   t-0.5s  splineS 3884  lat -0.86w  spd  0 m/s   offTrackTime 0.00
 *
 * `offTrackTime` never leaves zero and the lateral never passes 0.86 of the
 * half-width, so this is NOT the off-track watchdog: it is `resolveStalls` in
 * race.ts, firing on a car that made under 5m of progress in 5 seconds. The
 * cars are WEDGED against the outside barrier at an edge ratio inside
 * `edgeTolerance` -- the exact case that function's own comment describes --
 * in the second half of a 240m unbroken corner that eight cars enter together.
 *
 * Three levers were then swept, each over 128 races:
 *
 *   half-width at the hook   20m: 0.75   22m: 0.25   24m: 0.31   26m: 0.25
 *   radius of the hook       78m: 0.50   80m: 0.31   82m: 0.13   84m: 0.19
 *   the boost strip before   on: 0.31    off: 0.50
 *
 * Width plateaus and radius is nearly flat -- four to six events in 128 races
 * is a rare-event count, and repeating the same configuration after a 3m
 * change to an elevation ramp 2km away moved it from 0.31 to 0.75, which is
 * the honest measure of how much of that table is noise. None of them is a
 * fix; they are all the same jam at slightly different odds.
 *
 * SPLITTING THE HOOK IS THE FIX, and it is structural rather than statistical:
 * two 86-degree corners with a 40.5m straight between them give a car
 * somewhere to unwind and the pack somewhere to string out, instead of 240m in
 * which every car is at full lock at once. 0 respawns across 160 races (20
 * seeds), against 4-6 for every single-arc variant tried. It is also the
 * reading of the sketch that the picture supports -- see the fit table above
 * -- so the driveable answer and the faithful one turned out to be the same
 * answer, which is not always how this goes.
 *
 * ===========================================================================
 * TWO INSTRUMENT-LEVEL FIXES THE SKETCH PASS ALSO PAID FOR.
 * ===========================================================================
 *
 * 1. NODE SPACING 24 -> 20, WHICH IS WORTH 5m OF TIGHTEST RADIUS FOR NOTHING.
 *    A corner is emitted at `max(1, ceil(deg/30), round(arc/spacing))` nodes
 *    and `Track` bakes a uniform Catmull-Rom through them, so a corner
 *    resolved with two nodes bakes TIGHTER than its authored radius while the
 *    same corner with three or four bakes true. Measured on this lap: at
 *    spacing 24 an authored 58m corner read 47m (81%) and the lap's tightest
 *    reading was 44.5m; at spacing 20 the same corner reads 55m (95%) and the
 *    tightest is 50.1m. Chord ratio improved with it, 2.18 to 1.85. The cost
 *    is 30 more nodes. This is why T4 and T10 could also be opened only 6m
 *    each (46 -> 52, 49 -> 55) and still clear the 45m floor with room: most
 *    of what looked like a radius problem was a sampling problem.
 *
 * 2. THE SPIRE'S MOUTHS WERE THE TIGHTEST THING ON THE OLD LAP -- 37m and
 *    41m, tighter than any authored corner and tighter than the 45m floor,
 *    and nothing had noticed because they are not corners. A `cyclone` ramps
 *    its tube radius in over the outer 35% of its axis with a smoothstep, so
 *    the lateral offset near the mouth goes as r*f^3 and the curvature there
 *    scales as r/len^2. Measured across five (r, len) pairs the mouth's baked
 *    radius is 0.0228 * len^2 / r to within 4%:
 *
 *      r=26 len=196   37.2m        r=18 len=196   48.8m
 *      r=20 len=196   41.6m        r=16 len=196   52.2m
 *      r=18 len=192   46.4m        r=22 len=240   off the leaderboard
 *
 *    r=22 over 240m puts it at ~60m, which is comfortably behind the tightest
 *    authored corner and is what ships. The Spire is 44m longer and 4m
 *    narrower than it was; it is still one turn (see below), still descends,
 *    and now reads to `curvatureAt` like the geodesic it is supposed to be.
 *
 * ---------------------------------------------------------------------------
 * WHY A CORNER'S POSITION IN THE LAP MATTERS AS MUCH AS ITS RADIUS.
 *
 * `circuit()` closes a lap by taking the minimum-norm correction across every
 * authored straight -- see its own header for why. That correction is not
 * free: a corner sequence has a "natural" shape, and a straight asked to be
 * far longer than its natural gap fights the correction, which pays for it by
 * shrinking straights elsewhere, sometimes past zero. The first draft of this
 * lap put the tight, 180m-plus-lead-in corners exactly where the *narrative*
 * wanted them and NOT where the corner sequence's natural shape had room, and
 * it failed to close (a straight solved at -31m even at 2.5x site scale). The
 * fix was not to lengthen straights -- the builder says as much in its own
 * error -- it was to swap which RADIUS sits at which point in the sequence:
 * corner 1 (opening the lap, fed by the start straight, whose natural gap is
 * generously large) trades its radius with corner 7 (fed by the loop's exit,
 * whose natural gap is a bare few metres). Every corner below still occupies
 * the SLOT the story assigned it.
 *
 * THE STRAIGHT LENGTHS BELOW ARE A SOLUTION, NOT A WISH-LIST. `circuit()`'s
 * closed lengths are the ORTHOGONAL PROJECTION of the authored lengths onto
 * the affine subspace {L : sum_i L_i * dir_i = -C}, which has a consequence
 * worth writing down: a vector that ALREADY satisfies closure is emitted
 * unchanged. So the numbers here are the solution of a small constrained
 * least-squares problem -- closest feasible vector to (the preserved half's
 * own previously-closed lengths, the infield's drawn lengths) subject to the
 * two closure equations, a 40.5m floor on every straight and a 180.5m floor on
 * the four mandatory brake zones -- and `circuit()` then moves no straight by
 * more than a few centimetres. The lap closes at scale 1.000: the builder's
 * silent auto-grow (12% was measured on an earlier pass, worth 150-600m of lap
 * for nothing) never runs. Every preserved straight holds its old closed
 * length to within 0.6m, so the sketch's "outer shape unchanged" is not an
 * aspiration here, it is arithmetic.
 *
 * A BUILDER QUIRK, WORKED AROUND HERE RATHER THAN IN circuit.ts. A `loop`
 * segment's last emitted node (f=1) is, by construction, the exact point the
 * next segment continues from. That means the node immediately after a loop
 * sits at IDENTICAL position to the loop's own last node: a zero-length chord,
 * which reads as an infinite chord ratio to anything that measures min/max.
 * `dedupeCoincidentNodes()` below removes the duplicate after `circuit()`
 * returns, the same way a caller would trim a degenerate polygon edge.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE EARLIER PASSES ESTABLISHED, AND WHICH OF IT STILL HOLDS.
 *
 *   1. A NARROW LAP IS THE SLOWEST WAY TO SPEND A METRE. Telemetry of speed
 *      against distance showed almost none of a straight here is spent at top
 *      speed -- it is spent decelerating into the next braking zone or
 *      rebuilding out of the last. Cutting straight length cuts directly into
 *      that transition, so it earns real seconds even with the corners fixed.
 *   2. EVERY RADIUS THAT CAN MOVE SHOULD MOVE TOWARD THE CHEAP END OF ITS
 *      BAND. Corner time is r*angle/cornerSpeed(r) and cornerSpeed grows with
 *      the SQUARE ROOT of r, so a wide corner costs more lap time per degree
 *      than a tight one -- worst of all a sweeper, whose speed is capped at
 *      top speed, so widening one buys nothing back at all. Measured here:
 *      pushing either sweeper from 110m to 160m bought 0.7s of extra arc at
 *      the same speed and nothing else. Both sweepers still sit on a floor.
 *   3. THE SPIRE RUNS ONE TURN, NOT TWO. With `turns: 2` over the same axis
 *      EVERY racer drove off the road inside the corkscrew on some lap -- 8
 *      respawns a race, 100% of them at that one tag. Widening the tube made
 *      it WORSE (r 26 -> 36: 8 -> 11.3 respawns), flipping `bounce` did
 *      nothing, and reverting every upstream approach-speed change did nothing
 *      (entry speed measured ~39 m/s in every configuration). Halving the roll
 *      rate fixed it completely, and the gentler corkscrew was FASTER too. Do
 *      not put the second turn back.
 *   4. THE HOLO RING IS 34m BECAUSE `circuit()` REQUIRES >=32m FOR A LOOP. At
 *      25m its crossing read to `curvatureAt` as a phantom 26m corner nobody
 *      authored. `stagger` is 54; with the builder's current 0 -> stagger
 *      crossing there is no entry/exit self-overlap left for this file to
 *      fight. WHAT DID NOT SURVIVE THE WIDTH PASS is the rule of thumb that
 *      54 was picked against -- at least the road's full width plus 14m, at
 *      most the builder's hard ceiling of 1.9*r. At x1.5 the road wants 65m
 *      and 1.9*r is 64.6m, so at r=34 that window is EMPTY: there is no legal
 *      stagger for a 51m-wide road through a 34m loop. Growing the loop
 *      reopens it (r=36 gives [65, 68.4]) at the price of 2*pi*Dr of baked
 *      length, a taller apex and a re-solved lap; narrowing the road at the
 *      loop closes it for nothing. The road narrows. See the clearance
 *      section above.
 *
 * ---------------------------------------------------------------------------
 * THE SQUEEZE, RELOCATED ONTO THE INFIELD'S LONG DIAGONAL -- AND THEN UNDONE
 * BY THE WIDTH PASS, WHICH IS RECORDED HERE RATHER THAN QUIETLY REVERSED.
 *
 * Three straights were authored to ramp the road from the standard 17.5m
 * half-width down to 14m and back -- 15.5 / 14 / 15.5 either side of the
 * pinch, so the change landed in three small steps over three node-to-node
 * spacings rather than one cliff. The width pass took the two pinch values to
 * x2.0 and everything else to x1.5, which INVERTED it: the run now reads
 * 26.25 -> 31 -> 28 -> 31 -> 26.25, so its "pinch" is 1.75m WIDER than the
 * street the run is supposed to be pinching, and the only things it is still
 * narrower than are its own 31m shoulders and the 30m and 33m corners that
 * bracket the run. It is a lay-by, not a squeeze. Whether the pinch comes back is a separate decision
 * and is not taken here; what IS taken here is that nothing in this file may
 * claim a pinch that is not in the node data, and the tagging block near the
 * bottom may not go looking for one. The paragraph below describes the GROUND
 * the feature occupies, which is unchanged, and the name it still carries.
 *
 * It used to sit on the anonymous run between old T13 and Maglev C,
 * which is precisely the ground the sketch's infield now occupies, so it moved
 * to the closest thing the new shape has to the same role: the "2"'s long
 * diagonal, 216m of straight road between the first hook (70m) and the top
 * hook (66m). That keeps the original rule intact -- it sits entirely on
 * straight road between two corners that need no braking-zone favour, because
 * a squeeze inside a corner is a wall placed in a blind spot, not a challenge
 * -- and it is the brief's own suggestion of "a pinch between towers" landing
 * on the fastest road the infield has. The theme reads `squeeze` as a prop
 * cluster (`street-plant`, span 260m), so it also drags the city's street
 * clutter into the infield, which would otherwise have been the one district
 * on the lap with no ground-level furniture at all.
 *
 * TWO TUNNELS. "Underpass #1" (Transit Cut) doubles as the brake zone into the
 * first hairpin; "Underpass #2" (Podium Undercroft) sits on the approach to
 * Riverside Kink. `tunnel: true` is art only -- the sim drives it exactly like
 * open road -- so both are free to also be the geometry doing the actual work
 * of closing the lap.
 *
 * ONE LOOP, ONE CYCLONE, NO JUMP. The Holo Ring and the Spire are this
 * circuit's set pieces, both geodesics the sim reads as dead straight -- the
 * only two places on a walled, twenty-corner lap the driver is allowed to stop
 * working. A jump has no place on a street circuit with buildings either side
 * of the road.
 *
 * ELEVATION. The deck climbs and drops between district tiers -- down into the
 * Transit Cut, up past the Holo Ring, down through the Spire's own descent,
 * down again into the infield undercroft, and back up to the finish. The
 * steepest authored ramp anywhere is 7.4%; the lap never drops below 23m,
 * comfortably clear of the 6m floor. (An earlier pass's claim of "under 9%
 * everywhere" was not true of one 40m straight, which was carrying a 6m climb
 * at 14.8%; the Spire now starts 3m lower and that ramp is 7.4% like the rest.)
 * The cyclone adds its own local rise on top of whatever the deck under it is
 * doing, and that always maths out to never dip below the descending baseline,
 * so the elevation floor is never at risk from the set piece.
 *
 * ---------------------------------------------------------------------------
 * WHERE IT LANDED, against the gates as they stand:
 *
 *   plan shape        reads as the sketch's right panel; 25.3m mean nearest-
 *                     point error to the traced drawing, on a 4.3km lap
 *   baked length      4322.8823m (was 3231m). Neither the width pass nor the
 *                     clearance fix moved it by a digit -- and it must not
 *                     move far: 2882 samples put `length / samples` on 1.5m
 *                     at 4323.0000m, and `Track.at()` floors, so crossing
 *                     that shifts every radius the AI reads by ~10% at once
 *                     (rustfall.ts records the measurement). 0.118m of room.
 *   mean lap          92.61s          band 55-105s
 *   finishers         24/24
 *   respawns          0.0/race (probe); 0 across 160 races at 20 seeds
 *   tightest radius   49m             floor 45m
 *   chord ratio       1.85            gate 3.5, brief 3.0
 *   corners           20 (was 14): 2 hairpin / 12 medium / 4 fast / 2 sweeper
 *   road half-width   22m through the Holo Ring, 24m on its two feed stubs,
 *                     26.25m of ordinary street, 27-31m on the maglev runs and
 *                     the infield diagonal, 30m at the tight corners, 33m at
 *                     the two infield hooks
 *   probe-selfclear   passes; closest ribbon-to-ribbon approach 8.3m
 *   probe-solidclear  CLEAR by 4.50m, and still clear with every width on the
 *                     circuit multiplied by a further 1.10 (fails at 1.15)
 */

/**
 * Metres between emitted nodes. 20, not 24 -- see the header: at 24 a
 * two-node corner baked 19% tighter than its authored radius and the lap's
 * tightest reading was under the 45m floor.
 */
const SPACING = 20
/** Deck elevation at the start/finish line, and where the lap returns to. */
const START_Y = 42
/**
 * Holo Ring radius -- referenced again below when locating its apex node.
 * `circuit()` REQUIRES >=32m for a loop (a 25m loop was reading as a phantom
 * 26m corner to `curvatureAt`). `stagger` is 54, inside the builder's hard
 * ceiling of 1.9*r = 64.6m but NO LONGER clear of the rule of thumb it was
 * chosen against (at least the road's full width plus 14m): a x1.5 road wants
 * 65m and there is no room left for it at this radius. The road through the
 * set piece is narrowed instead -- see the clearance section in the header.
 */
const LOOP_R = 34

/**
 * THE TWENTY CORNERS, IN LAP ORDER.
 *
 * Every corner's comment gives its band and, where it isn't obvious, why it
 * sits at that point in the sequence. `deg` signs: +right, -left. Angles sum
 * to exactly +360 -- `circuit()` throws otherwise, so treat that sum as load
 * -bearing if this list is ever edited. Straight lengths were SOLVED, not
 * authored by feel (see the header): they already satisfy closure, so the
 * numbers written here are the numbers the builder emits, to the centimetre.
 */
const SEGS: Seg[] = [
  // --- MAGLEV A. The opening sprint: boosted, and comfortably over corner 1's
  // mandatory 180m brake zone. See the header note on why the tight corner
  // lives HERE and not at its narrative "natural" position seven corners later.
  { t: 'straight', len: 195.62, tag: 'start', boost: true, w: 27.75 },

  // T1 GRID CORNER -- medium, 62m (77% of top speed). The radius the loop exit
  // corner would have carried in a naive authoring pass; it lives here instead
  // because this is where the lap has a 180m+ mandatory straight to brake on.
  // Widened to 30m: first-corner braking under a fresh field is the single
  // most contested moment of the lap.
  { t: 'corner', r: 62, deg: 46, bank: 8, w: 30, tag: 'T1-tight' },
  { t: 'straight', len: 40.92 },

  // T2 DOCKSIDE SWEEP -- medium, 60m (76%), opens the esses.
  { t: 'corner', r: 60, deg: 50, bank: 7, tag: 'T2' },
  { t: 'straight', len: 40.73 },

  // T3 COUNTER DOCK -- medium, 62m (77%), the esses' reversal.
  { t: 'corner', r: 62, deg: -44, bank: -7, tag: 'T3' },

  // Underpass #1, the Transit Cut -- also the 181m brake zone the hairpin
  // needs. Deck drops 12m through it, a gentle 6.6% grade.
  { t: 'straight', len: 180.92, tunnel: true, toY: 30, tag: 'tunnel1' },

  // T4 FOUNDERS HAIRPIN -- hairpin, 52m (71%, 111m of arc), baking to a 50m
  // reading. Authored at 46m through the first four passes and opened here: at
  // the old 24m spacing 46m baked to 41.6m, under the floor the whole 45m rule
  // is stated against. Six metres plus the spacing change (see the header)
  // buys the whole margin back. Widened to 30m, fed by a real brake zone.
  { t: 'corner', r: 52, deg: 122, bank: 11, w: 30, tag: 'T4-hairpin' },
  { t: 'straight', len: 58.83, toY: 33 },

  // T5 EXCHANGE KINK -- fast, 80m (88%), the floor of its band -- a lift
  // rather than a full brake, and the cheapest radius that still reads fast.
  { t: 'corner', r: 80, deg: -38, bank: -5, tag: 'T5' },
  { t: 'straight', len: 40.50 },

  // T6 LONG BANK SWEEP -- sweeper, 110m (103% -- flat out). A sweeper's speed
  // is capped at top speed regardless of radius, so it sits on its band's own
  // floor; still clearly the loosest corner before the Holo Ring.
  { t: 'corner', r: 110, deg: -22, bank: -3, tag: 'T6' },

  // --- MAGLEV B, part 1: the run up to the loop.
  //
  // THE SET PIECE IS THE ONE PLACE ON THIS LAP THE STREET DOES NOT GET 50%
  // WIDER, and the three `w` values here and below -- 24 / 22 / 24 -- are the
  // whole of it. Everything else took the width pass in full; the loop and its
  // two feed stubs took x1.3 instead (18.5 -> 24 and 17 -> 22, which keeps the
  // tube narrower than its stubs in exactly the proportion they were
  // authored). The reason is in the header's clearance section: the loop's
  // entry arc runs alongside its own exit straight at a stagger of 54m, that
  // 54m is a constant no width change moves, the two mouths are at the same
  // height by construction so no `toY` can separate them, and 25.5 + 27.75
  // plus the barriers' own 0.67m reach does not fit inside it. Measured: at
  // x1.5 `probe-solidclear` found the loop's rail 0.31m inside the exit road
  // and a pier 0.33m inside it; at x1.3 it reports 4.50m of clearance, the
  // ribbon gate goes 2.3m -> 8.3m, and the headroom over that road goes 3.06m
  // -> 19.70m, which takes it back over the flight class's 6.5m ceiling. It is
  // free: `w` never enters `circuit()`'s closure walk, so the baked lap is
  // 4322.8822887633m either side of this change and the radius census cannot
  // move. Both stubs stay `boost: true` and stay 40.61m long.
  { t: 'straight', len: 40.61, boost: true, w: 24, toY: 36 },

  // THE HOLO RING. A staggered vertical loop through an advertising hoop --
  // see circuit.ts's own note on why the crossing is lateral. Not boosted, not
  // `bounce`: the one set piece a driver gets to just enjoy. Its apex node is
  // located and tagged in the post-processing block below. Drawn in both
  // panels of the sketch; its plan geometry is untouched, and 22m is the only
  // thing about it this pass changed -- still 5m wider than the 17m tube this
  // circuit shipped and raced at 0 respawns, and see the note above for why it
  // is not 25.5m.
  { t: 'loop', r: LOOP_R, side: 1, stagger: 54, w: 22, bounce: false, tag: 'holoring' },

  // --- MAGLEV B, part 2: the loop's exit straight. This gap and the one above
  // share an identical heading (the loop is a geodesic and does not turn it),
  // so the closure math cannot tell them apart -- both stay short and are
  // simply a good boost burst rather than a long one.
  { t: 'straight', len: 40.61, boost: true, w: 24, tag: 'maglev' },

  // T7 RING EXIT -- fast, 80m (88%). Carries the radius T1 traded away: fed by
  // the loop's exit rather than a dedicated brake zone, which is fine, because
  // a fast corner never needed the 180m rule in the first place.
  { t: 'corner', r: 80, deg: -58, bank: -5, tag: 'T7' },
  { t: 'straight', len: 40.90, toY: 33 },

  // T8 TERRACE CURVE -- medium, 58m (75%), the floor of its band.
  { t: 'corner', r: 58, deg: 48, bank: 7, tag: 'T8' },
  { t: 'straight', len: 40.68, toY: 30 },

  // T9 PODIUM KINK -- fast, 80m (88%), the last corner before the lap's
  // longest uninterrupted straight.
  { t: 'corner', r: 80, deg: -36, bank: -5, tag: 'T9' },

  // Plain brake zone into the second hairpin -- no set piece stacked on it, on
  // purpose, after the first draft's lesson.
  { t: 'straight', len: 180.87, tag: 'lead-T10' },

  // T10 CHINATOWN HAIRPIN -- hairpin, 55m (73%, 104m of arc), baking to 53m.
  // The lap's other hairpin, opposite hand from Founders. Opened from 49m for
  // the same reason as T4: at the old spacing 49m baked to 43.0m. Widened to
  // 30m.
  { t: 'corner', r: 55, deg: 108, bank: 11, w: 30, tag: 'T10-hairpin' },

  // Underpass #2, the Podium Undercroft. Deck climbs 3m through it.
  { t: 'straight', len: 59.71, tunnel: true, toY: 33, tag: 'tunnel2' },

  // T11 RIVERSIDE KINK -- fast, 80m (88%), the floor of its band.
  { t: 'corner', r: 80, deg: 42, bank: 5, tag: 'T11' },

  // The short climb onto the Spire's platform. It used to carry 33 -> 39 over
  // the same 40.5m, a 14.8% ramp and the one place this file's "every grade
  // under 9%" claim was false; the Spire now starts 3m lower instead.
  { t: 'straight', len: 40.50, toY: 36 },

  // THE SPIRE. A one-turn corkscrew down a tower's service helix -- a
  // geodesic, read by the sim as dead straight, and this lap's other set
  // piece. `bounce: false` for the same reason as the loop. r and len moved
  // from 26/196 to 22/240 this pass because the MOUTHS, not the barrel, were
  // the tightest curvature on the whole lap (37m); see the header's
  // 0.0228*len^2/r measurement. Two turns over this axis is what an earlier
  // pass traced the Spire's respawns to -- one turn is clean, and faster.
  { t: 'cyclone', r: 22, turns: 1, len: 240, w: 27, bounce: false, toY: 23, tag: 'spire' },

  // Plain gap. The Spire's exit shares its heading with the infield's Wharf
  // run below, so between the two of them this is the one asked to carry most
  // of the closure correction: an anonymous straight is a far better place for
  // that length than a named one.
  { t: 'straight', len: 268.68, toY: 33 },

  // T12 SPIRE EXIT -- medium, 58m (75%), the floor of its band. The sketch's
  // own trace puts this corner at 60m swept AND 60m circle-fitted, so it is
  // one of the few radii the drawing and the shipped lap already agreed on.
  // Widened to 30m and fed by the gap above, which comfortably clears the 180m
  // a corner this tight needs.
  { t: 'corner', r: 58, deg: 60, bank: 9, w: 30, tag: 'T12-tight' },

  // ==================== THE INFIELD, AS DRAWN ====================
  //
  // WHARF RUN. The short bottom straight out of T12, before the road turns up
  // off the city's lowest deck into the infield. The sketch draws it at 110m,
  // which is well under the 180m this file gives a sub-70m corner -- and it
  // does not need one, because the corner at each END of it is the same speed:
  // T12 is 58m and T13 is 58m, so a car leaves one at ~44 m/s and arrives at
  // the other at ~44 m/s. A brake zone exists for a SPEED CHANGE and there
  // isn't one here. This is a double-apex rhythm, not a straight somebody
  // forgot to lengthen.
  { t: 'straight', len: 101.23, toY: 30, tag: 'wharf' },

  // T13 SUMP TURN-IN -- medium, 58m (75%), the floor of its band. The sketch's
  // hardest single stroke: the elbow where the road leaves the bottom run and
  // climbs into the infield. Traces at 55m swept / 42m circle-fitted -- see
  // the header on why 58m is what got authored. Widened to 30m.
  { t: 'corner', r: 58, deg: 75, bank: 9, w: 30, tag: 'T13-tight' },
  { t: 'straight', len: 53.72 },

  // T14 UNDERCROFT OPENING -- sweeper, 130m (flat out). The second half of the
  // drawn elbow, and the reason the elbow is driveable: the sketch opens the
  // radius sharply on exit, so T13 is a short hard stab of steering and this
  // is the long release out of it. Authored at the traced 129m.
  { t: 'corner', r: 130, deg: 43, bank: 4, tag: 'T14' },

  // The climbing run up the infield's western edge, on the drawn line. Drawn
  // at 120m; it is the straight the closure correction leans on hardest inside
  // the infield, and 137m is where it settled.
  { t: 'straight', len: 136.90, toY: 28, tag: 'undercroft' },

  // T15 GANTRY HOOK -- medium, 70m (81%), LEFT. The only one of the "2"'s
  // three changes of direction that is not a hook: the road turns away from
  // the outer lap and sets up the long diagonal. Traces between 59m and 85m
  // depending on the window -- 70m is the middle of that and of its band.
  // Widened to 30m.
  { t: 'corner', r: 70, deg: -92, bank: -9, w: 30, tag: 'T15' },

  // THE SQUEEZE, on the "2"'s long diagonal -- OR WHAT THE WIDTH PASS LEFT OF
  // IT. Authored 17.5 -> 15.5 -> 14 -> 15.5 -> 17.5, ramped across three
  // node-to-node spacings rather than stepped; the width pass doubled the two
  // pinch values and multiplied the street by 1.5, so it now reads
  // 26.25 -> 31 -> 28 -> 31 -> 26.25 and the pinch is a lay-by. The three
  // straights are left exactly as that pass set them -- restoring the pinch is
  // a design call, not a clearance one -- and what IS fixed this pass is the
  // tagging block near the bottom of the file, which used to find this stretch
  // by searching for the narrowest node on the lap and had silently started
  // finding the Holo Ring instead. All three share a heading, so the closure
  // correction cannot tell them apart and they were balanced to roughly equal
  // spans afterwards. See the header for why the feature moved here from the
  // old T13-to-Maglev-C run.
  //
  // THE PINCH IS BACK: 31 -> 28 -> 31 became 20 -> 17.5 -> 20, the authored
  // narrowing at the widened street's scale. As a lay-by it did nothing a
  // straight does not do; restored, it is the lap's one place where holding a
  // line against a car alongside is the whole question. A DESIGN fix, not a
  // safety one, and measured to cost nothing: over 200 seeds at Normal the
  // lap's respawns are 0.04 a race before and after and there are none in the
  // Squeeze either way (an earlier 30-seed read claiming 0.10 -> 0 was noise).
  // 17.5 m is still wider than the narrowest corner exits elsewhere on the
  // lap, so nothing here asks more of a car than the track already does.
  { t: 'straight', len: 68.47, w: 20, tag: 'squeeze' },
  { t: 'straight', len: 78.47, w: 17.5 },
  { t: 'straight', len: 68.47, w: 20, toY: 32 },

  // ---- THE HOLLOW LOOPBACK, the "2"'s top hook: 66m / 40.5m / 66m, -172
  // degrees in total. Two 86-degree corners rather than one 172-degree arc --
  // see the header for the fit that says the sketch drew it squared and the
  // 160-race measurement that says a single arc is what the field falls over.
  // 66m is chosen so 2R+S matches the 84m single arc's own footprint, which is
  // what keeps the hook inside the ground the drawing gives it. This is the
  // outermost point of the infield: 121m from Maglev C and 210m from the start
  // straight, both measured on the drawing before it was authored. Banked 10
  // degrees and widened to 33m -- eight cars are in here together, at 45 m/s,
  // for four seconds, which is longer than anywhere else on the lap. ----
  { t: 'corner', r: 66, deg: -86, bank: -10, w: 33, tag: 'T16-hairpin' },
  // The hook's middle straight, banked with the corners either side so the
  // road does not roll flat and back again across 40m.
  { t: 'straight', len: 40.50, bank: -10, w: 33, tag: 'hollow-mid' },
  { t: 'corner', r: 66, deg: -86, bank: -10, w: 33, tag: 'T16b' },

  // MAGLEV D, the infield strip. 149m of boost between the lap's two hooks --
  // the one piece of boost the sketch does not draw in yellow. See the header
  // for the justification and for what removing it measured.
  { t: 'straight', len: 149.17, boost: true, w: 27.75, toY: 30, tag: 'maglevD' },

  // ---- THE CISTERN HOOK, the "2"'s bottom hook: 68m / 40.5m / 68m, +172
  // degrees, mirroring the top hook in angle and opposite in hand, 2m wider in
  // radius so the pair reads as a matched pair rather than a repeat. Traces at
  // 82m swept over its whole length and 69m circle-fitted over its core. This
  // is the corner the respawn investigation in the header is about. ----
  { t: 'corner', r: 68, deg: 86, bank: 10, w: 33, tag: 'T17-hairpin' },
  { t: 'straight', len: 40.50, bank: 10, w: 33, tag: 'cistern-mid' },
  { t: 'corner', r: 68, deg: 86, bank: 10, w: 33, tag: 'T17b' },

  // The infield's exit, back onto the drawn line of the old bottom diagonal.
  { t: 'straight', len: 73.47, tag: 'cistern-exit' },

  // --- MAGLEV C. The last boost run, and the lead-in to the final corner --
  // boost hard, then brake hard, one more time before the line. The lap's one
  // deliberately LONG straight, well clear of T18's mandatory 180m.
  { t: 'straight', len: 238.47, boost: true, w: 27.75, toY: 42, tag: 'maglevC' },

  // T18 GRID RETURN -- medium, 58m (75%), the floor of its band, closing onto
  // the start/finish straight. The sketch traces it at 57m. Widened to 30m.
  { t: 'corner', r: 58, deg: 56, bank: 8, w: 30, tag: 'T18-tight' },
]

const built = circuit(SEGS, {
  spacing: SPACING,
  start: [0, START_Y, 0],
  heading: 0,
  defaults: { w: 26.25, surface: 'metal', bounce: true },
  minStraight: 40,
})

/**
 * Remove the one node the Holo Ring duplicates on its way out -- see the
 * header note. Anything else this coincident (there is nothing else in this
 * lap) would be removed the same way, which is why this walks the whole array
 * rather than special-casing the loop's index.
 */
function dedupeCoincidentNodes(nodes: TrackNode[]): TrackNode[] {
  const EPS = 0.05
  const out: TrackNode[] = [nodes[0]]
  for (let i = 1; i < nodes.length; i++) {
    const a = out[out.length - 1].p, b = nodes[i].p
    if (Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) > EPS) out.push(nodes[i])
  }
  const a = out[out.length - 1].p, b = out[0].p
  if (Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) <= EPS) out.pop()
  return out
}
const nodes = dedupeCoincidentNodes(built.nodes)

/** Cumulative 3-D distance along `nodes`, node 0 at 0. Used only to locate the
 *  node nearest an authored tag's `marks` distance -- see below. */
function cumulativeDistance(ns: TrackNode[]): number[] {
  const cum = [0]
  for (let i = 1; i < ns.length; i++) {
    const a = ns[i - 1].p, b = ns[i].p
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]))
  }
  return cum
}
const cum = cumulativeDistance(nodes)
function nodeNear(dist: number): number {
  let best = 0, bestGap = Infinity
  for (let i = 0; i < cum.length; i++) {
    const gap = Math.abs(cum[i] - dist)
    if (gap < bestGap) { bestGap = gap; best = i }
  }
  return best
}

/**
 * THE REQUIRED TAGS. `circuit()` only ever records where a tagged segment
 * STARTS (`built.marks`, a PLAN distance) -- it never writes `TrackNode.tag`
 * itself, so every tag the art theme reads has to be placed on an actual node
 * here. The theme's contract (`render/themes/neonspire.ts`) is exactly four
 * names: `holoring` and `holoring-apex` locate the advertising hoop, `maglev`
 * anchors the sign-gantry cluster and `squeeze` the street-plant cluster. All
 * four survive on real nodes -- which was NOT true between the width pass and
 * this one, when `squeeze` was overwriting `holoring` and the hoop stopped
 * being built; see the note under `squeeze` below. `squeeze` moved to
 * different GROUND when the infield was drawn -- see the header -- and after
 * the width pass it is no longer a pinch at all, which the prop cluster does
 * not care about: all it needs is a node on the infield's long diagonal.
 */
nodes[0].tag = 'start'
nodes[nodeNear(built.marks['maglev'])].tag = 'maglev'
const iHoloring = nodeNear(built.marks['holoring'])
nodes[iHoloring].tag = 'holoring'

/**
 * THE SQUEEZE'S TAG IS PLACED FROM ITS `marks` DISTANCE, LIKE EVERY OTHER TAG,
 * AND THE "NARROWEST NODE ON THE LAP" TRICK THAT USED TO PLACE IT IS GONE.
 *
 * That trick read: walk every node, take the one with the smallest `w`, call it
 * the Squeeze. It was correct exactly while the pinch was the narrowest road on
 * the circuit -- 14m against a 17m Holo Ring and a 17.5m street. The width pass
 * broke that premise and nothing noticed, because a search that always returns
 * SOMETHING cannot fail loudly:
 *
 *   as authored      pinch 14   Holo Ring 17     -> narrowest is the pinch
 *   after the widths  pinch 28   Holo Ring 25.5   -> narrowest is the loop
 *   as it ships now   pinch 28   Holo Ring 22     -> narrowest is the loop
 *
 * -- so the tag moved 2100m along the lap onto the loop's FIRST node, which is
 * the node tagged `holoring` on the line immediately above this comment. Being
 * an assignment rather than a merge it overwrote that tag; `loopHoop()` returns
 * null when its entry tag is missing; and the advertising hoop the whole set
 * piece is named after stopped being built. The street-plant cluster went with
 * it, scattering 260m of ground-level city furniture along a vertical loop.
 *
 * `nodeNear` drifts -- `built.marks` is a PLAN distance and `cum` is the
 * emitted 3-D distance, and the cyclone's helix plus every elevation ramp put
 * about 1% between them, which by the infield is most of a node spacing. That
 * is the cost of going back to it, and it was measured rather than assumed:
 * the tag lands on node 161 at s=3063m, two nodes early, on the tail of T15,
 * where the first straight of the run starts at s=3101m. For a 260m prop
 * cluster 38m is nothing, and all four of the tags the theme's contract names
 * are on real nodes again. Whether the pinch itself comes back is a separate
 * decision; if it does, this line needs no change.
 */
nodes[nodeNear(built.marks['squeeze'])].tag = 'squeeze'

/**
 * THE HOLO RING'S APEX. The loop emits `steps+1` nodes (see circuit.ts's own
 * `loop` branch); its highest point is somewhere in that run, not necessarily
 * its midpoint once banking and the stagger are accounted for, so this finds
 * the true maximum rather than assuming it.
 */
{
  const loopSteps = Math.max(14, Math.round((2 * Math.PI * LOOP_R) / 18))
  let apexI = iHoloring, apexY = -Infinity
  for (let d = 0; d <= loopSteps + 1 && iHoloring + d < nodes.length; d++) {
    const y = nodes[iHoloring + d].p[1]
    if (y > apexY) { apexY = y; apexI = iHoloring + d }
  }
  nodes[apexI].tag = 'holoring-apex'
}

/** Lap fraction where a tagged segment starts. */
const frac = (tag: string) => built.marks[tag] / built.length

export const NEONSPIRE: TrackDef = {
  id: 'neonspire',
  name: 'Zhen-9',
  skyTop: 0x080a1c,
  skyBottom: 0x2a1c4a,
  fogColor: 0x241a3e,
  fogDensity: 0.0062,
  sunColor: 0xc0a8ff,
  sunIntensity: 0.62,
  ambientColor: 0x2c2456,
  ambientIntensity: 1.05,
  // There is no sun. This is the glow off a cloud deck lit from below by the
  // city, so the key is high, weak and violet, and the fill carries the frame.
  sunDirection: [-0.28, 0.90, 0.33],
  palette: { a: 0x1a1830, b: 0x2f2a55, c: 0x6a4fd0, accent: 0xff3ea5 },
  nodes,
  itemBoxRows: [
    { at: (frac('start') + frac('T1-tight')) / 2, count: 4, spread: 3.8 },
    { at: (frac('holoring') + frac('maglev')) / 2, count: 5, spread: 4.0 },
    { at: (frac('tunnel2') + frac('T11')) / 2, count: 4, spread: 3.6 },
    { at: (frac('spire') + frac('T12-tight')) / 2, count: 4, spread: 3.8 },
    // The infield gets two rows of its own: one on the long diagonal into the
    // top hook, one on Maglev D between the hooks.
    { at: (frac('squeeze') + frac('T16-hairpin')) / 2, count: 4, spread: 3.4 },
    { at: (frac('maglevD') + frac('T17-hairpin')) / 2, count: 4, spread: 3.6 },
    { at: (frac('maglevC') + frac('T18-tight')) / 2, count: 4, spread: 3.6 },
  ],
  chargeRuns: [
    { from: frac('start') + 0.005, to: frac('T1-tight') - 0.01, count: 7, lateral: -4 },
    { from: frac('maglev') + 0.003, to: frac('T7') - 0.01, count: 5, lateral: 4 },
    { from: frac('lead-T10') + 0.005, to: frac('T10-hairpin') - 0.015, count: 6, lateral: 0 },
    { from: frac('undercroft') + 0.004, to: frac('T15') - 0.008, count: 5, lateral: -4 },
    { from: frac('maglevD') + 0.003, to: frac('T17-hairpin') - 0.008, count: 5, lateral: 4 },
    { from: frac('maglevC') + 0.003, to: frac('T18-tight') - 0.01, count: 7, lateral: 4 },
  ],
  laps: 3,
}
