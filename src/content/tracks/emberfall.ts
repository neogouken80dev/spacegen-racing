import type { TrackDef, TrackNode } from '../../sim/track'
import { circuit, type Seg } from './circuit'

/**
 * ASHKAR — Volcanic Shield.
 *
 * ===========================================================================
 * REDESIGNED FROM A HARMONIC RING TO A NAMED CIRCUIT.
 * ===========================================================================
 *
 * The previous Ashkar -- like Meridian Deep, Halcyon Bay and Zhen-9 -- was a
 * sum of two or three harmonics: smooth everywhere, no straights, no braking
 * zones, and a radius that wandered wherever the coefficients pushed it. The
 * report that killed all four: "the overall oval or square-ish type design
 * does not offer a lot of variety in driving experience... the few turns are
 * far too sharp to allow smooth drifts and ends up causing the user to crash
 * into the walls." This file replaces that ring with `circuit()`: a named
 * sequence of straights and corners of CHOSEN radius, authored corner by
 * corner the way a real shield-volcano road would be surveyed -- around the
 * rim, down into a tube, back up over a spire.
 *
 * The physics that drove every radius below (grip 1.0 on tarmac and metal,
 * 0.70 on the ash beds, corner speed = sqrt(1.07 * 34 * R)):
 *
 *   45-58m   43-47 m/s   hairpin, heavy braking -- at most one or two
 *   58-80m   47-53 m/s   the corner a driver actually DRIFTS
 *   80-110m  53-62 m/s   fast corner, a lift and a commitment
 *  110-220m  flat out    sweeper -- still a corner to the AI's drift-hold
 *                        gate (curvatureAt gate, R<222m)
 *
 * Twenty-one corners land: 2 hairpin, 5 medium, 12 fast, 2 sweeper. The two
 * full stops are caldera-hook (r=55, off the 235m start straight) and
 * summit-hairpin (r=58, the apex of the top-left 180) -- the only two corners
 * on the lap under 60m, and so the only two that ask for under 46 m/s.
 *
 * ---------------------------------------------------------------------------
 * THE FEATURE MIX IS DIFFERENT FROM THE OTHER THREE REDESIGNS ON PURPOSE.
 *
 * Zhen-9 got a street circuit's corner density. Ashkar gets the maximalist
 * set-piece list, because a volcanic shield is the one planet in the roster
 * built entirely from held terrain: TWO vertical loops, ONE corkscrew, ONE
 * launch across an open fissure, ONE enclosed tunnel bored through the
 * basalt, and -- since the pass documented under THE SKETCH PASS below -- one
 * plan-view LOOPER whose road climbs back over its own feed road.
 * `Track.curvatureAt` reads a vertical loop's and a corkscrew's curvature
 * about the surface normal, which for both is identically the axis they
 * spiral around -- geodesic curvature zero, DEAD STRAIGHT to the AI (see
 * `tools/probe-loop.ts` on the old ring: 0.0000 across 120m either side of a
 * loop apex, against the 0.0045 drift-hold gate). Nothing brakes for them and
 * nothing drifts in them, which is why they sit where the lap can afford to
 * be flat out. The looper is the opposite: it is 441 degrees of ORDINARY
 * plan-view corner, so the AI brakes for it, drifts it, and can fall off it
 * (it did -- see WHAT THREW THE FIELD OFF THE LOOPER below).
 *
 * THE ASH BEDS ARE NOT THE TRACK ANY MORE, and that is what the sketch pass
 * spent. 152m of gravel straight plus two gravel corners is 228m, 5% of the
 * lap, against the 769m and 25% the thirteen-corner shape carried. Gravel is
 * still where the AI's corner model and a drifting player's diverge furthest,
 * which is where overtakes come from; there is simply a fifth as much of it.
 *
 * ---------------------------------------------------------------------------
 * WHY A CORNER'S POSITION IN THE LAP MATTERS AS MUCH AS ITS RADIUS.
 *
 * `circuit()` closes a lap with the minimum-norm correction across every
 * authored straight -- see its own header. That correction is not free: a
 * corner sequence has a "natural" shape, and a straight asked to be far
 * longer than its natural gap fights the correction, which pays for it by
 * shrinking OTHER straights, sometimes past zero. The first full topology
 * tried here put four gravel corners in a slowly-turning run (all four
 * within 20-55 degrees of the same heading) and needed a uniform scale of
 * 235x site size before every straight cleared the 40m floor -- workable
 * arithmetically, unusable for a lap anyone finishes. The fix was not a
 * bigger scale; it was a heading sequence that actually spreads around the
 * circle instead of idling near one direction for five corners in a row.
 *
 * THE LENGTHS BELOW ARE NOT A WISH-LIST, THEY ARE A SOLUTION. Every earlier
 * pass on this file authored straights it liked and let the builder correct
 * them, and every earlier pass paid for it: a wish-list whose residual is
 * large enough pushes one straight under the floor, and `circuit()`'s answer
 * to that is to GROW THE WHOLE SITE (scale 1.12, 1.27, 1.87 were all measured
 * here while searching), which adds 150-600m of lap for nothing. So the
 * straights below were solved instead -- see THE SCALE PASS for the objective
 * that solved them, which is no longer "closest to a wish-list" but "closest
 * to the drawing". The lap closes at scale 1.000 and `circuit()`'s own
 * correction moves no straight by more than 0.1m, so the numbers in the
 * segment list are, to a tenth of a metre, the numbers the builder emits.
 * Tightest straight: 42.0m, 5% clear of the 40m floor.
 *
 * ---------------------------------------------------------------------------
 * TWO THINGS `circuit()`'s `loop` SEGMENT DOES NOT DO FOR YOU.
 *
 * 1. ITS OWN CLOSING NODE IS A DUPLICATE. `loop` samples f=0..1 INCLUSIVE, so
 *    its last node lands exactly on the segment's true endpoint -- which is
 *    also exactly where the next segment's own f=0 node is computed from.
 *    Measured: a 0.0m chord at both loop exits, `chordMax/chordMin=Infinity`.
 *    `dedupeCoincidentNodes` below removes the duplicate; it walks the whole
 *    array rather than special-casing the loops' indices because the SAME
 *    seam exists once more where the lap closes (last node onto the first).
 *
 * 2. A TIGHT LOOP CANNOT CARRY A WIDE STAGGER GENTLY -- AND FOR A WHILE THIS
 *    FILE'S OWN LOOPS DIDN'T. The first pass ran both Cinder Loops small
 *    (r=22, r=30) against `circuit.ts`'s OLD crossing formula, -stag/2 to
 *    +stag/2, which shared the lateral debt between the loop's two mouths but
 *    put a genuine half-stagger SIDEWAYS STEP right at the entry: the road
 *    arrived on the racing line at lateral zero and the loop's first node was
 *    already stag/2 to one side of it. Measured: a 39.9m chord into the mouth
 *    against a ~26m neighbour -- a ratio over 11 from that join alone. This
 *    file used to carry its own `easeLoopEntry` post-processing pass to walk
 *    the approach nodes sideways with a hand-tuned smoothstep (blend=230m)
 *    and paper over it.
 *
 *    That function is GONE, not because the bug it fixed stopped existing,
 *    but because `circuit.ts` fixed it upstream instead: the crossing now
 *    runs 0 -> stagger, so the loop begins exactly where the road already is
 *    and a smoothstep holds the derivative at zero at BOTH mouths -- there is
 *    no kink left for a track file to ease around, and re-applying the old
 *    easing here would slide the approach toward a -stag/2 offset that no
 *    longer exists, manufacturing the exact kink it used to fix.
 *
 *    What the mouth fix EXPOSED rather than caused: a small-radius loop still
 *    cannot move a wide stagger across its own short arc length without the
 *    crossing itself reading as a corner nobody authored -- the sideways
 *    travel has to happen within 2*pi*r, and the smaller r is, the steeper
 *    that ask. Measured across the ring-authored circuits after the mouth
 *    fix landed: r=22 and r=30 loops BOTH still produced a phantom 15m
 *    "corner", r=25 produced 26m, r=36 produced none. `circuit()` now throws
 *    rather than ship that silently -- radius >= 32m, stagger <= 1.9 x
 *    radius -- so both Cinder Loops here grew: r=34 (was 22, stagger 54) and
 *    r=40 (was 30, stagger 58), taller and more dramatic (68m and 80m of
 *    apex swing against the old 44m and 60m) rather than a compromise.
 *
 * ---------------------------------------------------------------------------
 * 3. WHAT THE CORKSCREW'S OWN CLIMB DID TO THE FIELD.
 *
 * `curvatureAt` reads a corkscrew as straight (see above), so nothing brakes
 * for it -- which said nothing about whether the field could physically
 * CLIMB it. The first version ran `r: 42, turns: 2, len: 280`, a helix whose
 * own steepest slope (arctan(2*PI*r*turns/len)) is 62.1 degrees. Racing it
 * with `tools/probe-newtrack.ts`'s own harness measured 6.0 respawns a
 * race -- the shipped circuits run 0.0-0.7 -- and logging each racer's own
 * position at the moment of respawn put every one of them within 6 metres of
 * the same distance along the lap: partway up the climb a racer's altitude
 * goes negative, ground contact never returns, and the stall watchdog
 * (race.ts's `resolveStalls`) eventually respawns it.
 * `turns` only has to be a whole number to leave the corkscrew upright --
 * `th` at f=1 is `2*PI*turns`, a full circle for ANY integer, one included --
 * so two turns bought nothing the number needed. One turn at the same r and
 * len cuts the slope to 43.3 degrees and raced clean: 0.0 respawns across
 * three seeds. The lesson generalises past this one set piece: `curvatureAt`
 * being blind to a segment is not the same claim as a chassis being able to
 * climb it, and the race harness is the only thing that actually checks the
 * second one.
 *
 * ===========================================================================
 * THE SKETCH PASS: WHAT REPLACED THE GRAVEL DIAGONAL.
 * ===========================================================================
 *
 * The brief was a two-panel sketch (`/home/claude/sketches/ashkar-sketch.png`,
 * previously `.design/ashkar-reference.png`): keep the bottom serpentine and
 * the whole right-hand arc up to the start/finish straight, and replace the
 * long gravel diagonal down the upper left with (a) a big hairpin at the top
 * left, (b) a large sweeping S through the infield, and (c) a large circular
 * right-hand LOOPER on the left whose road crosses back over itself. "More
 * turns and a large right hand looper."
 *
 * The pass before that one read the same brief and APPENDED its new content
 * (three "esses" and a 360-degree Skyloop) onto the lap's last straight while
 * leaving the gravel diagonal intact. That measured 3862m and a mean lap of
 * 82.17s, and its esses were 6-11m kinks that `circuit.ts`'s new guard now
 * refuses outright. Everything that pass added is gone, and so are the four
 * gravel corners (ash-curve, ash-bend, ash-jink, ash-exit) the pass before IT
 * ran down the upper left, because the sketch does not append -- it REPLACES.
 *
 * ===========================================================================
 * THE SCALE PASS: THE DRAWING AT ITS OWN SIZE.
 * ===========================================================================
 *
 * The sketch pass built all of that DELIBERATELY SHRUNK, and said so in this
 * header: the drawing calibrates to ~4300-4600m with a looper of r~118 and a
 * ~600m infield S, and it shipped at r=60 with a 110-degree hairpin and a
 * ~120m excursion, to hold a 55-75s lap band. On 2026-09-15 Vince reversed
 * that trade himself. Asked directly whether to keep the shrunk version or
 * rebuild at the sketch's true proportions he chose rebuild, and on the
 * general question said "match the overall shape, and keep the longer
 * distance. i dont mind if its longer". `tools/probe-newtrack.ts`'s band is
 * now 55-105s and carries that quotation next to the constant. So the trade
 * below is the opposite of the one the sketch pass made, and everything else
 * that pass learned still stands.
 *
 * THE SKETCH, RE-MEASURED FROM SCRATCH. Both panels are drawn in the minimap
 * projection `tools/plot-track.ts` uses; their road masks have the SAME
 * bounding box to the pixel (646 x 442 px), so the two panels are registered
 * and the calibration transfers. Rather than calibrate on a bounding box,
 * this pass fitted a similarity transform from the SHIPPED track's baked
 * samples to the skeleton of the part of the drawing that does not change
 * (the bottom serpentine and the right-hand arc are identical in both
 * panels): 0.68443 px/m, i.e. 1.4611 m per sketch pixel, with the preserved
 * half of the shipped lap sitting 0.6px to 8.7px from the drawing across
 * every 100m block from s=1600m to s=3400m. The 1.50 the sketch pass quoted
 * was right to 2.6%.
 *
 * At that scale, skeletonising the right panel and walking it as an ordered
 * centreline from the start line measures the drawing as:
 *
 *   start -> top right          304m   the right-edge straight
 *   the top run (ash beds)      467m   essentially straight, h 82 -> 86
 *   THE HAIRPIN                 312m   its core; the full +180, shoulders
 *                                      included, spans 422m of road
 *   the S's upper stroke        381m   h ~261, into the infield
 *   the S's U-TURN              226m   -180 deg back to the west
 *   the S's lower stroke        458m   h ~80, the looper's feed road
 *   THE LOOPER                  circle fit r = 69.2px = 101m
 *
 * -- 2741m of traced road from the start line to the looper's exit. The
 * shrunk version's looper finished at s=1670m by its own corner census, so
 * the drawing wants a thousand metres more over the same ground. The rest of
 * the lap is the preserved back half, which makes the drawing a ~4400-4500m
 * circuit -- what the sketch pass's own LP said, and what it declined to
 * build.
 *
 * WHAT THE SCALE COST, MEASURED RATHER THAN ESTIMATED. The baked lap went
 * 3408.6m -> 4481.6m, +1073m, and the mean lap 72.43s -> 91.46s. Every metre
 * of it is in the four features the sketch pass compressed: the looper is r=100
 * against r=60 (+308m of arc at 441 degrees), the hairpin turns a true 180
 * against 110, the infield excursion is a real out-and-back against a 120m
 * kink, and the two strokes of the S are 216m and 270m of straight instead of
 * 42m and 132m.
 *
 * NOTHING WAS SPENT TO PAY FOR IT. The brief named the lever -- the two
 * Cinder Loops are 465m of lap and the Corkscrew's helix another 105m over
 * its own axis, 570m that costs lap time without covering ground -- and the
 * lever was not needed: the rebuilt lap measures inside the band with all
 * five set pieces intact. It is worth writing down WHY, because the intuition
 * says a lap a third longer must be a third slower. It is not, because the
 * ground the scale bought is FAST ground: the looper went from r=60 (47 m/s,
 * a corner you drift) to r=100 (61 m/s, a corner you hold), and the S's two
 * strokes are top-speed straights where the shrunk version had 42m of
 * shuffle. Mean speed went UP, from 47.06 m/s to 49.00 m/s. If a future pass does
 * need the lever, Cinder Loop One (r=34, 214m) is the cheapest thing on the
 * lap to lose: the second loop is larger, opposite-handed and the one the
 * theme scatters vents around (`cluster: { tag: 'loop2' }`).
 *
 * ---------------------------------------------------------------------------
 * HOW THE SHAPE WAS SOLVED, AND WHY IT IS NOT A WISH-LIST EITHER.
 *
 * Once the corners are chosen the straight headings are fixed and closure is
 * two linear equations in the straight lengths, so there is a 19-dimensional
 * family of laps with this corner list. The sketch pass picked its member of
 * that family by minimising total length. This pass picked its member by
 * minimising the CHAMFER DISTANCE from the walked centreline to the drawing's
 * own skeleton, mapped into sim metres through the calibration above --
 * subject to exact closure, a 42m floor on every straight, a 235m ceiling on
 * the start straight and a 170m ceiling on the ash beds (without those two
 * the solver buys fidelity in the infield by pushing the top-right corner
 * clean out of the drawn box), and a third equality pinning the total. The
 * fidelity/length curve it traces is shallow and worth recording, because it
 * is the number a future pass would trade against:
 *
 *   total straights   plan length   chamfer rms   looper centre offset
 *        1400             4098m          44.7m             81m
 *        1500             4198           43.8              70
 *        1660             4358           37.3              65     <- taken
 *        1800             4498           37.0              48
 *
 * 1660 was taken: below it the drawing starts to be squeezed, and above it
 * the rms is flat -- 1800 buys 17m of looper placement for 140m of lap and
 * about 3s, which is there for a future pass that wants it and was not worth
 * spending here.
 *
 * ---------------------------------------------------------------------------
 * THE ONE THING THE DRAWING ASKS FOR THAT CANNOT BE BUILT.
 *
 * The minimap projection maps world (x,z) to (-x,-z), which is a rotation and
 * NOT a mirror, so handedness survives it: a right-hand corner in the sim
 * draws counter-clockwise on the map. Traced, the drawn lap runs
 * counter-clockwise (right-handed, +720 as this file's corners sum) and the
 * drawn looper runs CLOCKWISE -- a LEFT-hand 360 hung off a right-hand lap,
 * total turning zero, a figure-eight, which `circuit()` rejects (turns must
 * be 1 or 2) and which no closed racing lap can be. The brief's own words are
 * "a large right hand looper", so the looper is built right-handed, as the
 * sketch pass built it.
 *
 * AT r=60 THAT COST 31m OF CENTRE OFFSET. AT THE DRAWING'S OWN r IT COSTS
 * MORE, AND THE REASON IS GEOMETRY RATHER THAN EFFORT. The circle's centre
 * sits one radius to the sim-RIGHT of the entry heading, which on the map is
 * one radius to the screen-LEFT; the drawn circle sits one radius the other
 * way off the same west-bound feed road. Flip the handedness and the two
 * centres are 2r apart. At r=60 a 120m offset still leaves the built circle
 * INSIDE the drawn one, which is how the sketch pass measured 31m. At r=100
 * there is no such hiding place, and the only ways to close the gap are to
 * move the feed road 100m north -- which is the S's own lower stroke, so it
 * costs the S its depth -- or to enter the looper heading EAST, which is the
 * only heading that puts a right-hand circle above its feed and which the
 * drawing does not have anywhere near the looper.
 *
 * So it was solved as an explicit trade instead, by adding the centre offset
 * to the chamfer objective at a weight and sweeping the weight:
 *
 *   weight    chamfer rms    looper centre offset
 *    0.00        30.8m            121m
 *    0.10        35.1              74
 *    0.18        36.5              67
 *    0.22        37.3              65     <- taken
 *    0.28        41.9              53
 *    0.35        42.7              51
 *
 * 0.22 was taken: 65.3m, under two thirds of a radius, for 6.5m of rms
 * against the unweighted solve. Past that the whole lap starts sliding to
 * chase one circle -- 0.35 buys another 14m of placement for another 5.4m of
 * rms, and it is the top-right corner that pays.
 *
 * WHAT THE LOOPER IS. 441 degrees of right-hander at r=100 on ONE circle,
 * split into two corners (185 + 256) so the elevation can ramp in two stages;
 * same radius, same sign and NO STRAIGHT BETWEEN THEM, so the second corner
 * continues the first's circle exactly. The sketch pass put a 42m "bridge
 * deck" straight between the two halves for the same two-stage climb; at r=60
 * that was a fifth of a radius and invisible, at r=100 it is a flat spot that
 * turns the circle into a stadium -- least-squares a circle onto the walked
 * looper with the straight in and it reads r=110.3 against an authored 100;
 * with it out, r=100.0 with a 0.02m residual. Two corners carry
 * two `toY` values perfectly well, so the straight is gone and the looper is
 * a true circle again.
 *
 * 441 rather than 360 is the whole trick: a lap's corners must sum to a whole
 * number of turns, this lap's other corners sum to +279, and 441 is what
 * closes it at +720. Geometrically the extra 81 degrees is what MAKES the
 * crossing -- the road leaves the circle 81 degrees further round than it
 * joined, so the exit leg runs across the feed leg exactly as the sketch
 * draws it, instead of leaving tangentially on the same line. Tried and
 * rejected by the sketch pass: 360 in the looper with the 81 as separate
 * corners before it (feed and exit come out PARALLEL, the loop returns onto
 * its own entry, and `circuit()` reported a 2.2m clearance over 60m of shared
 * ground); and a mixed-radius split, 185@56 + 256@64, which is 11m more arc
 * for the same 441 degrees and which opened a THIRD crossing.
 *
 * ---------------------------------------------------------------------------
 * THE CLEARANCE RULE GOT STRICTER, AND THE SHRUNK LAP DID NOT PASS IT.
 *
 * `tools/probe-selfclear.ts` gates road SURFACES at 2.0m and passed the
 * shipped Ashkar at 6.1m. A screenshot then showed a guardrail passing
 * through the road near the flyover, which is not a contradiction: trackMesh
 * stands a 3m wall at each road edge, so a 6.1m surface gap can still have
 * one deck's rail inside the other's driving surface. The rule this pass was
 * held to is 9m in 3-space between any two parts of the lap, unless they are
 * deliberately side by side at the same height with 4m+ between their edges,
 * or separated by a real bridge with 20m+ of vertical clearance.
 *
 * WHERE THE SHIPPED LAP FAILED IT: s=1347m against s=1779m, 6.1m of surface
 * gap with only 11.2m between the two centrelines -- the looper's climbing
 * arc passing under the tunnel's descent, both banked, one 30m wide and the
 * other 20m. Eleven metres between two banked decks is not a bridge, it is a
 * near miss.
 *
 * WHAT FIXES IT HERE IS THE ELEVATION PROFILE, NOT A NUDGE. The rule sorts
 * every close approach into one of two boxes, so the profile was authored to
 * put each of this lap's approaches firmly in one:
 *
 *   - THE LOOPER'S OWN TWO DECKS. A 441-degree corner covers 81 degrees of
 *     its circle TWICE -- 141m of arc at r=100 where the two passes are
 *     exactly coincident in plan, which no lateral nudge can ever open up.
 *     That has to be a bridge, so the climb is placed to make it one: the
 *     feed road is the lap's floor at 12m, the first arc climbs to 26m and
 *     the second to 46m. Measured on the baked lap every 5m along the shared
 *     arc, the late pass runs 27.6m to 27.9m above the early one for its
 *     whole 141m, at a plan offset of 0.5m -- a flat, deliberate bridge
 *     rather than a gap that happens to open somewhere.
 *   - THE EXIT LEG OVER THE FEED LEG, which is the sketch's own X. The baked
 *     lap has exactly two plan self-crossings and both are the looper's:
 *     s=1968m (y 12.0) under s=2598m (y 39.7), 27.6m of daylight, and
 *     s=2046m (y 15.2) under s=2673m (y 43.0), 27.8m. `circuit()`'s own
 *     `minClearance` of 20 passes on both.
 *   - THE LOOPER'S EXIT ROAD OVER THE LOOPER'S FEED ARC. This is the one the
 *     sketch pass got wrong and it is the reason the tunnel no longer
 *     descends -- see the segment list.
 *   - EVERYTHING ELSE IS SEPARATED IN PLAN, and the numbers are in WHAT THE
 *     REBUILT LAP MEASURES below.
 *
 * The 20m floor is also why the looper climbs 34m rather than the 42m the
 * shrunk version used: more would be spent on a gap that is already a
 * bridge, and 46m is already a tall pylon for `themes/emberfall.ts` to stand
 * under the span.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE REBUILT LAP MEASURES, so the next pass can tell what it moved.
 *
 * `tools/probe-newtrack.ts --track=emberfall`: 4482m (4481.6m baked), 205
 * nodes, chord 12.7-31.3m (ratio 2.46), 51% of the lap read as curved,
 * tightest corner 46m and median 105m, elevation 12-124m, 24/24 racers
 * finished across three seeds, laps 83.43 / 91.46 / 100.15s
 * best/mean/worst, 0.0 respawns a race, 0.1% of racer-frames off-track.
 * Widened to nine seeds and 72 racers, in case 0.0 was luck: 72/72 finished,
 * 83.43 / 91.37 / 100.15s, 0.11 respawns a race (one, in seventy-two).
 *
 * `tools/probe-selfclear.ts`: closest the road comes to another part of
 * itself is 16.9m, between s=2205m and s=2850m -- the looper's climbing arc
 * under the tunnel that bridges it -- against the 2.0m a car needs.
 *
 * Against the stricter 9m rule, measuring rail tops as well as surfaces, the
 * five closest approaches on the lap are 12.8m (Cinder Loop One's own barrel
 * against itself, 50m apart in plan), 14.0m (that same looper/tunnel bridge,
 * 22.9m of vertical), 14.5m, 16.3m and 17.5m. Nothing on the lap is inside
 * 9m, so no approach has to lean on either exemption.
 *
 * `tools/probe-solidclear.ts` -- the gate that landed during this pass and
 * measures the BUILT solid rather than the ribbon -- reports CLEAR: 9.98m
 * between the nearest solid and another part's road, and 17.13m of headroom
 * at the lowest place the track builds over its own road (s=2840m carrying
 * over s=2202m, which is the looper/tunnel bridge again).
 *
 * THE ART CONTRACT, MEASURED. All eleven tags `themes/emberfall.ts` reads sit
 * on real nodes: start, fissure, ashbeds, loop1, loop1-apex, loop2,
 * loop2-apex, underpass, overpass, looper, looper-apex. `overpass` is at
 * y=43.9m over an `underpass` at y=15.2m -- 28.7m of rise against the theme's
 * own SPAN_CLEAR of 6.0 -- and they are 19.8m apart in plan, inside the lower
 * deck's 30m half-width, which is the test `buildFlyover` actually runs.
 * Replicating `trackMesh.viaductWeights`, `via` is 1.000 everywhere from 60m
 * before `overpass` to 140m after it, so the soffit never drops away from the
 * span's edge beams.
 *
 * FIDELITY, MEASURED THE WAY THE SKETCH PASS MEASURED IT. Projecting the
 * built lap back into the drawing's own pixel frame through the calibration
 * above: chamfer rms 35.3m (24.2 sketch px), median 25.4m. Letting the
 * similarity transform re-fit on the whole lap instead of staying pinned to
 * the shipped lap's preserved half gives 30.4m rms at 1.4550 m/px -- 0.4%
 * off the calibrated scale, which is the check that the calibration is real.
 *
 * ONE TRAP IN THAT MEASUREMENT, WRITTEN DOWN BECAUSE IT COST AN HOUR.
 * `plot-track.ts` and the in-game minimap both rotate the lap by
 * `atan2(-t0.x, t0.z)` of the BAKED first tangent, and that tangent is a
 * Catmull-Rom average over neighbours that includes the last node of
 * rim-sweeper's arc. It is 0.0 degrees on the shipped lap and 2.40 degrees on
 * this one, purely because the node spacing changed -- and 2.4 degrees at a
 * 700m radius is 29m, which is half the looper offset being reported. Every
 * fidelity number here is measured with the projection PINNED at
 * (u,v) = (-x,-z) for both laps, not at whatever the baked tangent says.
 *
 * Feature by feature: the built looper is a circle of r=100.0m (least-squares
 * residual 0.02m, which is what removing the bridge deck bought) against the
 * drawn 101.1m, with its centre 65.3m from the drawn centre. The hairpin
 * turns 180 degrees, heading 80 -> 260, against the drawing's 84 -> 261. The
 * infield excursion is 468m deep against the drawing's 546m. The lap's plan
 * bounding box is 867 x 645m against the drawing's 944 x 646m -- the same
 * height to 0.2%, 8% narrower.
 *
 * THE ONE READING UNDER 45m IS NOT A CORNER, AND IT IS INHERITED. Sampling
 * `curvatureAt(s, 20)` every 0.25m rather than on probe-newtrack's 1.5m grid
 * finds 43.3m at s=4151m, inside the CORKSCREW, on its exit mouth, on 30m-wide
 * metal at a -0.42 grade, where the helix's radius ramp un-rolls the ribbon.
 * Nothing is authored there. The thirteen-corner Ashkar that shipped before
 * any of this measures the same thing at 44.3m, and it is the reason every
 * version of this circuit reports a "tightest" a little under its own
 * smallest corner. The only two other readings under 48m on the whole lap are
 * 47.5m at s=246m (caldera-hook, the tightest thing anybody authored) and
 * 46.3m at s=3805m, which is the Corkscrew's other mouth. Every corner this
 * file actually authors bakes at 47.5m or wider.
 *
 * ---------------------------------------------------------------------------
 * IDENTITY, UNCHANGED.
 *
 * Difficulty: Medium. Nothing on Ashkar deletes a lap -- the ash beds cost a
 * tenth of a second at a time, not a respawn. Basalt tarmac carries the rim;
 * the two Cinder Loops and the tunnel that joins them run `metal`, the same
 * surface as the Corkscrew, because all four are the same bored volcanic
 * rock. No `fragile`: a collapsing lava crust is the obvious gimmick and it
 * is not available honestly -- `fragile` turns a surface into
 * `T.hazard.crackedSurface`, which is a GLOBAL, and on this planet that
 * global is ice. Shipping a lava shelf that visibly cracks into ice to reuse
 * a mechanic would be a lie in the one place the player is looking.
 *
 * WHAT IS GONE: the caldera-rim crosswind. It was never part of the required
 * feature list for this pass (two loops, one corkscrew, one fissure, one
 * tunnel), and the ring it rode on is gone with the ring. The lap's character
 * now comes from the ash beds' width and bank plus the loops', corkscrew's
 * and looper's own elevation swing (12m to 124m over the lap), which is more
 * of the track doing the work than a wind band ever was.
 * ---------------------------------------------------------------------------
 */

/**
 * THE TWENTY-ONE CORNERS, in lap order. Each radius is picked from the band
 * table above; each `bank` carries the SAME SIGN as `deg` (positive = right)
 * -- `circuit()` does not infer one from the other, and every corner on every
 * shipped `circuit()` track keeps this pairing, so a mismatched sign here
 * would be the one corner on the planet that banks away from the turn.
 *
 * Indexed by NAME below rather than by position, because the sketch pass's
 * own tag code indexed `CORNERS[9]` and `CORNERS[10]` for the looper and this
 * pass inserted four corners ahead of them.
 */
const CORNERS: (Seg & { t: 'corner' })[] = [
  // C1 -- CALDERA HOOK. Hairpin band, and the reason the start straight is
  // 235m: a hairpin fed by anything shorter is a corner the AI arrives at
  // still on the throttle. Widened (26 against the 21m base) for the same
  // reason the old file widened its own tightest bend -- a driver who needs
  // an alternate line through a full stop should have room to take it.
  { t: 'corner', r: 55, deg: 45, bank: 10, w: 26, tag: 'caldera-hook' },
  // C2 -- BASALT SWEEP. Medium band, turns the opening run onto the fissure.
  { t: 'corner', r: 65, deg: 35, bank: 8, tag: 'basalt-sweep' },
  // C3 -- ASH BEND. The ash beds' own corner and the only one left on them.
  // Deliberately the lap's widest-radius gravel: 18 degrees at 120m is 37.7m
  // of arc, three times `circuit.ts`'s kink floor, and it is the only place
  // on the lap a driver carries full speed through a direction change on 0.70
  // grip. It is also the first 18 degrees of the hairpin below -- the drawing
  // puts a slight bend exactly here and then runs dead straight to the top
  // left corner, and the heading trace bears that out (h 82.4 at s=417m,
  // 86.2 at s=763m).
  { t: 'corner', r: 120, deg: 18, bank: 4, surface: 'gravel', w: 25, tag: 'ash-bend' },
  // ---------------------------------------------------------------------
  // C4-C7 -- THE SUMMIT HAIRPIN. The sketch's top-left 180, at 180 degrees
  // rather than the 110 the sketch pass could afford, and built as a compound
  // so it is a hairpin rather than a sweeper: an open turn-in off the gravel,
  // a genuine hairpin-band apex, an open exit onto the infield diagonal.
  // ash-bend's 18 plus these 162 is the 180 the drawing turns between the ash
  // beds' heading and the infield's.
  //
  // r=58 AT THE APEX IS NOT A ROUNDING, IT IS THE NODE COUNT. `walk()` emits
  // max(ceil(deg/30), round(arc/spacing)) nodes, and two nodes through a
  // uniform Catmull-Rom cut the corner. Measured on the baked centreline at
  // 0.25m resolution by the sketch pass: r=56 over 60 degrees (58.6m of arc,
  // 2 nodes) reads 43.7m, tighter than the 45m floor this circuit is held to;
  // r=58 (60.7m of arc, 3 nodes) reads 53.0m. 66 degrees at r=58 is 66.8m of
  // arc and 3 nodes, which is the same side of that cliff.
  { t: 'corner', r: 85, deg: 26, bank: 7, surface: 'gravel', w: 25, tag: 'ash-curve' },
  { t: 'corner', r: 105, deg: 36, bank: 7, w: 24, tag: 'summit-in' },
  { t: 'corner', r: 58, deg: 66, bank: 11, w: 26, tag: 'summit-hairpin' },
  { t: 'corner', r: 105, deg: 34, bank: 7, w: 24, tag: 'summit-out' },
  // ---------------------------------------------------------------------
  // C8-C10 -- THE INFIELD U. The other half of the sketch's sweeping S: 180
  // degrees back the other way at the far end of the infield, the same
  // open/tight/open compound as the hairpin so the two read as a matched
  // pair rather than one 180 and one shuffle. This is the deepest point of
  // the lap's excursion east and the slowest corner in the new half.
  { t: 'corner', r: 110, deg: -42, bank: -7, w: 24, tag: 'infield-in' },
  { t: 'corner', r: 70, deg: -96, bank: -9, w: 26, tag: 'infield-apex' },
  { t: 'corner', r: 110, deg: -42, bank: -7, w: 24, tag: 'infield-out' },
  // C11-C12 -- SCARP JINK / SCARP HOOK. A cancelling fast-band pair on the
  // run down to the looper: net zero turning, 54m of arc between them, and
  // the cheapest two corners on the lap because a 16-degree corner's chord is
  // within half a metre of its arc -- they buy corner count and rhythm for
  // almost no lap length at all. They are NOT a chicane: the closure puts
  // 269.7m of straight between them, the longest run on the circuit, so they
  // read as a left kink, a long boosted breath, and a right kink back onto
  // the looper's line. They exist because "more turns" was the brief's first
  // ask and because the drawing's lower stroke is otherwise 458m of nothing.
  { t: 'corner', r: 100, deg: -16, bank: -6, w: 23, tag: 'scarp-jink' },
  { t: 'corner', r: 95, deg: 16, bank: 6, w: 23, tag: 'scarp-hook' },
  // C13-C14 -- THE LOOPER. 441 degrees of right-hander on one r=100 circle,
  // split 185/256 with nothing between them so the deck can climb in two
  // stages without the circle becoming a stadium (see the header). The widest
  // road on the circuit at 30m, for the reason logged under WHAT THREW THE
  // FIELD OFF THE LOOPER.
  { t: 'corner', r: 100, deg: 185, bank: 8, w: 30, tag: 'looper' },
  { t: 'corner', r: 100, deg: 256, bank: 8, w: 30, tag: 'looper-out' },
  // C15 -- TUBE BEND. The only corner inside the Lava Tube tunnel: fast band,
  // so the tunnel reads as a held commitment through the rock rather than a
  // second braking zone stacked on top of the looper's exit.
  { t: 'corner', r: 100, deg: 45, bank: 7, surface: 'metal', w: 20, tag: 'tube-bend' },
  // C16-C17 -- EMBER SWEEP / EMBER HOOK. Medium band, between the tunnel's
  // first Cinder Loop and the second -- the technical heart of the lap the
  // band table calls for, on ordinary basalt with nothing else going on.
  { t: 'corner', r: 76, deg: 45, bank: 8, tag: 'ember-sweep' },
  { t: 'corner', r: 62, deg: 38, bank: 8, tag: 'ember-hook' },
  // C18 -- RIDGE JINK. A short fast left between the second loop and the
  // Corkscrew that keeps the run of right-handers from the tunnel to the
  // final sweeper from reading as one uninterrupted curl.
  { t: 'corner', r: 90, deg: -20, bank: -5, tag: 'ridge-jink' },
  // C19-C20 -- RIDGE BEND / FLOW HOOK. Fast then medium, unwinding out of the
  // Corkscrew's exit straight toward the rim.
  { t: 'corner', r: 105, deg: 33, bank: 6, tag: 'ridge-bend' },
  { t: 'corner', r: 60, deg: 30, bank: 8, tag: 'flow-hook' },
  // C21 -- RIM SWEEPER. r=170m: flat out, closes the final straight back onto
  // the start.
  { t: 'corner', r: 170, deg: 28, bank: 4, tag: 'rim-sweeper' },
]
/** Corners by tag. Positional indices into `CORNERS` were a latent bug: this
 *  pass inserted four corners ahead of the looper and the tag code below used
 *  to read `CORNERS[9]` and `CORNERS[10]`. */
const K: Record<string, Seg & { t: 'corner' }> = Object.fromEntries(
  CORNERS.map((c) => [c.tag as string, c]),
)
{
  const sum = CORNERS.reduce((a, c) => a + c.deg, 0)
  // 720, not 360: one ordinary lap PLUS one full turn spent in the looper.
  // `circuit()` accepts turns in {1, 2}; 2 is what produces (and requires)
  // the self-crossing the looper needs to read as a flyover rather than a
  // second flat loop.
  if (Math.abs(sum) !== 720) throw new Error(`Ashkar: corner angles sum to ${sum}, not 720`)
}

/**
 * THE FULL SEGMENT LIST. These straight lengths are the SOLVED ones, not a
 * wish-list -- see HOW THE SHAPE WAS SOLVED in the header. The lap closes at
 * scale 1.000 with a correction of under 0.1m on any straight, so what is
 * written here is what `circuit()` emits; change one number and the builder
 * will quietly reshape the other twenty to compensate.
 *
 * `toY` only appears where the elevation actually changes; every segment
 * between keeps the last value, so the profile reads top to bottom as: climb
 * off the grid, launch the fissure, plateau on the ash beds at 46m, fall all
 * the way down the S to the looper's feed road at 12m -- the lap's floor and
 * the deck every crossing passes over -- climb 34m round the looper to 46m,
 * then dive into the tunnel at 32-26m and let the two Cinder Loops and the
 * Corkscrew carry the profile back up to the grid's 30m.
 */
const segs: Seg[] = [
  { t: 'straight', len: 235.0, tag: 'start', w: 26 },
  K['caldera-hook'],
  { t: 'straight', len: 131.3 },
  K['basalt-sweep'],
  { t: 'straight', len: 42.0 },
  // THE FISSURE. A launch across an open crack in the shield, not a corner --
  // `ramp`/`boost` on the first 18% and `open` road over the gap are set by
  // `circuit()`'s own `jump` branch.
  { t: 'jump', len: 110, launch: 26, gap: 45, tag: 'fissure', w: 24, toY: 36 },
  // THE ASH BEDS. Tagged at its own first node; `ashbeds` is read directly by
  // themes/emberfall.ts to place the gravel dressing (with a 420m cluster
  // span and the gravel is 228m, so the dressing overruns onto basalt at both
  // ends -- the theme is another worker's file and the tag contract is on the
  // NAME, not the length, so this is worth flagging to them rather than
  // lengthening the gravel to suit a prop scatter).
  { t: 'straight', len: 110.0, tag: 'ashbeds', surface: 'gravel', w: 25, toY: 42 },
  K['ash-bend'],
  { t: 'straight', len: 42.0, surface: 'gravel', w: 25, toY: 46 },
  K['ash-curve'],
  // THE HAIRPIN'S BRAKING ZONE. Off the gravel, on basalt, so the heaviest
  // braking on the lap after turn one is done on a surface that answers.
  { t: 'straight', len: 42.0, tag: 'brake', w: 24 },
  K['summit-in'],
  { ...K['summit-hairpin'], toY: 44 },
  K['summit-out'],
  // THE INFIELD DIAGONAL -- the S's upper stroke, 216m running east-south-east
  // off the summit and down into the bowl. The drawing's own is 381m of road
  // including the hairpin's exit shoulder and the U's entry shoulder, which
  // is what this plus those two arcs comes to.
  { t: 'straight', len: 216.4, tag: 'diag', w: 24, toY: 34 },
  K['infield-in'],
  { ...K['infield-apex'], toY: 26 },
  K['infield-out'],
  { t: 'straight', len: 42.0, tag: 'return', w: 24, toY: 20 },
  K['scarp-jink'],
  // THE LONGEST STRAIGHT ON THE CIRCUIT, and the S's lower stroke: 270m of
  // dead-flat basalt running west-north-west to the looper.
  //
  // IT IS BOOSTED, AND THAT IS A DESIGN DECISION RATHER THAN A LAP-TIME ONE.
  // Vince's note on this pass was "feel free to add track obstacles boost as
  // necessary". What the scale bought here is 270m where the shrunk lap had
  // 132m, and 270m of straight with a cancelling kink at each end is the one
  // stretch of the new half with nothing to do in it. A boost strip makes it
  // the lap's top-speed run instead -- the approach to the looper is then the
  // fastest road on the circuit arriving at its longest sustained corner,
  // which is the rhythm the band table wants and the reason the looper is
  // 30m wide.
  //
  // MEASURED BOTH WAYS, because a boost strip is easy to justify and easy to
  // be wrong about. It is worth almost nothing on the mean -- 91.46s with,
  // 91.51s without -- and the reason is that the AI was already flat out here
  // and the strip mostly raises a speed that the looper then has to scrub.
  // What it does buy is the tail: the worst lap of the three-seed field goes
  // 103.25s -> 100.15s and respawns go 0.7 a race -> 0.0. The strip stays for
  // the tail, not for the mean, and if a future pass wants the 270m for
  // something else it is not defending a lap-time number.
  { t: 'straight', len: 269.7, boost: true, w: 23, toY: 15 },
  K['scarp-hook'],
  // THE LOOPER'S FEED ROAD, and the lap's lowest ground at 12m. Everything
  // the looper passes over passes over THIS, so its height is not decoration:
  // drop it and both crossings lose their clearance together.
  { t: 'straight', len: 42.0, tag: 'feed', w: 26, toY: 12 },
  // THE LOOPER. Two corners, one circle, no straight between them -- see the
  // header for why the sketch pass's 42m bridge deck is gone. The two `toY`
  // are what make the second pass over the shared 141m of arc a bridge over
  // the first rather than a near miss.
  { ...K['looper'], toY: 26 },
  { ...K['looper-out'], toY: 46 },
  // THE LOOPER'S EXIT RUNS BACK OVER THE LOOPER'S OWN FEED ARC, and for 135m
  // it is directly above it -- measured, the plan gap between the two
  // centrelines is 0.5m where the exit leaves the circle and does not clear
  // 64m until s=2875. That is not a fault, it is what a 441-degree corner
  // does; but it means this straight and the tunnel after it are a BRIDGE
  // over the looper, and have to be held up like one. So neither descends:
  // the road leaves the looper at 46m and is still at 45m at the tunnel's
  // far mouth. Measured every 15m along the overlap, that holds 21.8m to
  // 27.8m over an arc climbing 18.1 -> 22.2m underneath, and by s=2875m the
  // two are 64.8m apart in plan, which clears the rule on plan alone. The
  // shipped shrunk lap let exactly this pair fall to 6.1m of surface gap on
  // 11.2m of centre separation; this file's own first draft descended here
  // the same way and measured 2.1m between the two decks' rails. The descent
  // is the BEND, not the tunnel.
  { t: 'straight', len: 45.7, w: 26 },
  // THE LAVA TUBE. An enclosed run of basalt tunnel -- `tunnel: true` is art
  // metadata only (the sim has no tunnel concept). Authored at 63, not 42
  // like its neighbours: `walk()`'s own `steps = round(len/spacing)` rounds
  // anything under 60m down to 2 samples, one f=0..0.5 chord and one
  // f=0.5..1.0-into-the-corner chord, each roughly HALF the closed length.
  // That was this circuit's worst joint on an earlier pass (a 35.0m chord
  // straight into tube-bend, ratio 3.57); 63m buys the third sample and an
  // ordinary ~21m chord.
  { t: 'straight', len: 63.0, surface: 'metal', tunnel: true, w: 20, toY: 45 },
  { ...K['tube-bend'], tunnel: true, toY: 34 },
  { t: 'straight', len: 43.0, surface: 'metal', tunnel: true, w: 20, toY: 26 },
  // CINDER LOOP ONE. Consumes no plan distance; its exit duplicate is fixed
  // by the post-processing below. r=34 (not a smaller, tighter loop) because
  // `circuit.ts` now refuses anything under 32m -- see the header's item 2
  // for why a tight loop cannot carry a wide stagger gently. If a future pass
  // ever needs the 570m of set-piece lever back, this is the one to spend.
  { t: 'loop', r: 34, side: 1, stagger: 54, surface: 'metal', w: 18, tag: 'loop1' },
  { t: 'straight', len: 42.0, toY: 30 },
  K['ember-sweep'],
  { t: 'straight', len: 42.0, toY: 34 },
  K['ember-hook'],
  { t: 'straight', len: 42.0, w: 19, toY: 36 },
  // CINDER LOOP TWO. Larger and opposite-handed to the first (r=40 against
  // 34, side=-1 against +1), so the two loops read as a pair rather than a
  // repeat -- and comfortably inside the legal stagger band (52-76 at this
  // radius).
  { t: 'loop', r: 40, side: -1, stagger: 58, surface: 'metal', w: 19, tag: 'loop2' },
  { t: 'straight', len: 42.0, toY: 38 },
  K['ridge-jink'],
  { t: 'straight', len: 42.0, toY: 40 },
  // THE CORKSCREW. A single turn around a 42m bore -- see item 3 in the
  // header for why `turns: 1` and not 2.
  { t: 'cyclone', r: 42, turns: 1, len: 280, surface: 'metal', w: 30, tag: 'corkscrew' },
  { t: 'straight', len: 42.0, toY: 34 },
  K['ridge-bend'],
  { t: 'straight', len: 42.0, toY: 31 },
  K['flow-hook'],
  { t: 'straight', len: 42.0, toY: 30 },
  K['rim-sweeper'],
]

const OPTS = {
  spacing: 24,
  start: [0, 30, 0] as [number, number, number],
  heading: 0,
  defaults: { w: 21, surface: 'tarmac' as const },
  minStraight: 40,
  // Explicit rather than relying on circuit()'s own default (9): the looper's
  // crossings are the span art's only anchor, and 20 asserts "comfortable
  // daylight, not a bare pass" as a build-time guarantee rather than a
  // hoped-for number. The clearance rule this pass was held to is stricter
  // still in 3-space (see the header) and the elevation profile, not this
  // number, is what satisfies it.
  minClearance: 20,
}
const built = circuit(segs, OPTS)

/**
 * DEDUPE THE LOOPS' OWN CLOSING NODE. See the header's item 1: `loop` samples
 * f=0..1 inclusive, so its last node coincides exactly with the next
 * segment's first. This walks the whole array (not just the two loops)
 * because the same seam recurs once more where the lap closes.
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

/** Cumulative 3-D distance along `nodes`, node 0 at 0. Used only to locate
 *  the node nearest an authored tag's `marks` distance -- see below. */
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
 * STARTS (`built.marks`, a plan distance) -- it never writes `TrackNode.tag`
 * itself, so every tag the art theme reads (`environment.ts`'s `tagSample`,
 * `themes/emberfall.ts`'s prop clusters, Cinder Loop rings and flyover span)
 * has to be placed on an actual node here.
 */
nodes[0].tag = 'start'
nodes[nodeNear(built.marks['fissure'])].tag = 'fissure'
nodes[nodeNear(built.marks['ashbeds'])].tag = 'ashbeds'
const iLoop1 = nodeNear(built.marks['loop1'])
nodes[iLoop1].tag = 'loop1'
const iLoop2 = nodeNear(built.marks['loop2'])
nodes[iLoop2].tag = 'loop2'

/**
 * EACH LOOP'S APEX. The loop emits `steps+1` nodes (see circuit.ts's own
 * `loop` branch); its highest point is somewhere in that run, not
 * necessarily its midpoint once the stagger is accounted for, so this finds
 * the true maximum rather than assuming it.
 */
function tagApex(loopStart: number, r: number, name: string): void {
  const steps = Math.max(14, Math.round((2 * Math.PI * r) / 18))
  let apexI = loopStart, apexY = -Infinity
  for (let d = 0; d <= steps + 1 && loopStart + d < nodes.length; d++) {
    const y = nodes[loopStart + d].p[1]
    if (y > apexY) { apexY = y; apexI = loopStart + d }
  }
  nodes[apexI].tag = name
}
tagApex(iLoop1, 34, 'loop1-apex')
tagApex(iLoop2, 40, 'loop2-apex')

/**
 * THE LOOPER'S OWN TWO TAGS, which `themes/emberfall.ts`'s `buildFlyover`
 * reads and which it SILENTLY no-ops without -- so they are load-bearing, not
 * labels.
 *
 * `looper` is the node where the looper's turning begins, which is also the
 * road the span is a bridge over: the theme searches a 240m window either
 * side of it for the lower deck. `looper-apex` bounds how far the span may
 * walk, and the theme's own comment defines it as the looper's outermost
 * point -- so it is FOUND, by taking the node in the looper's own arc that is
 * furthest in plan from the entry, rather than assumed to be the halfway
 * node. On one circle of radius 100 that lands diametrically opposite the
 * entry, but nothing here depends on that: change the split or the radii and
 * the search still returns the right node.
 */
const iLooper = nodeNear(built.marks['looper'])
nodes[iLooper].tag = 'looper'
{
  // The looper's far end, derived from the two corners rather than restated:
  // `looper-out` starts where the first arc ends, and its own arc closes the
  // circle.
  const arcEnd = built.marks['looper-out'] +
    (Math.abs(K['looper-out'].deg) * K['looper-out'].r * Math.PI) / 180
  let apexI = iLooper, apexD = -Infinity
  for (let i = iLooper; i < nodes.length && cum[i] <= arcEnd; i++) {
    const d = Math.hypot(nodes[i].p[0] - nodes[iLooper].p[0], nodes[i].p[2] - nodes[iLooper].p[2])
    if (d > apexD) { apexD = d; apexI = i }
  }
  nodes[apexI].tag = 'looper-apex'
}

/**
 * WHERE THE ROAD CROSSES ITS OWN ROAD. `circuit()` finds every plan-view
 * self-intersection and reports each as `{under, over, clearance, at}` --
 * `under`/`over` sorted by ELEVATION, not by which the lap reaches first.
 *
 * THERE ARE TWO, NOT ONE, and that is the looper working rather than a fault.
 * A 441-degree corner leaves its circle 81 degrees further round than it
 * joined, so the exit leg crosses the feed leg (the sketch's own X) AND the
 * late, high part of the arc meets the early, low part of the same arc where
 * that shared 81 degrees begins and ends. An earlier pass asserted exactly
 * one crossing here because its Skyloop was a 360 split across a bridge
 * straight; that assertion is now wrong, and asserting the count this lap
 * actually has is worth more than asserting a number that happens to be
 * smaller.
 *
 * The span art keys off ONE of them, so the tags go on the one with the most
 * daylight -- which is also the one the sketch draws, the looper's own high
 * arc riding over the road that fed it.
 */
if (built.crossovers.length !== 2) {
  throw new Error(`Ashkar: expected two self-crossings (the looper's), found ${built.crossovers.length}`)
}
const span = [...built.crossovers].sort((a, b) => b.clearance - a.clearance)[0]
nodes[nodeNear(span.under)].tag = 'underpass'
nodes[nodeNear(span.over)].tag = 'overpass'

/** Lap fraction where a tagged segment starts. */
const frac = (tag: string) => built.marks[tag] / built.length

export const EMBERFALL: TrackDef = {
  id: 'emberfall',
  name: 'Ashkar',
  skyTop: 0x1a0806,
  skyBottom: 0x6b1f12,
  fogColor: 0x53200f,
  fogDensity: 0.0052,
  sunColor: 0xffb27a,
  sunIntensity: 1.05,
  ambientColor: 0x6a2412,
  ambientIntensity: 0.85,
  sunDirection: [-0.35, 0.55, -0.75],
  palette: { a: 0x2b211f, b: 0x6e3a24, c: 0xa8502a, accent: 0xff6a18 },
  nodes,
  // Rows sit ON the driven line and at or above the 2.4m box mesh, for the
  // reason the other redesigned circuits all record: `stepAI` has no
  // item-seeking term, so a row taken off the line is a row the AI never
  // touches.
  itemBoxRows: [
    { at: (frac('start') + frac('caldera-hook')) / 2, count: 5, spread: 4.2 },
    { at: (frac('ashbeds') + frac('ash-bend')) / 2, count: 5, spread: 4.4 },
    // THE SUMMIT HAIRPIN, mid-block: the lap's new slow corner and its widest
    // basalt, so the row is worth taking a line for.
    { at: (frac('summit-in') + frac('summit-hairpin')) / 2, count: 4, spread: 4.0 },
    // THE INFIELD U's apex, the far point of the S.
    { at: frac('infield-apex') + 0.004, count: 4, spread: 4.2 },
    // THE LOOPER. Just past its entry, the same "+offset single point"
    // pattern as the two Cinder Loops -- widest spread on the lap for the
    // widest (30m) road.
    { at: frac('looper') + 0.015, count: 5, spread: 4.8 },
    { at: frac('loop1') + 0.012, count: 4, spread: 4.0 },
    { at: frac('loop2') + 0.015, count: 5, spread: 4.2 },
    { at: (frac('ridge-bend') + frac('flow-hook')) / 2, count: 4, spread: 3.8 },
  ],
  chargeRuns: [
    { from: frac('start') + 0.004, to: frac('caldera-hook') - 0.012, count: 6, lateral: -5 },
    { from: frac('ashbeds') + 0.004, to: frac('ash-bend') - 0.004, count: 5, lateral: 5 },
    // The infield diagonal: 216m off the summit, the one place on the upper
    // half of the new section where a line choice is free.
    { from: frac('diag') + 0.006, to: frac('infield-in') - 0.006, count: 5, lateral: 5 },
    // The boosted run to the looper, between the two scarp kinks.
    { from: frac('scarp-jink') + 0.008, to: frac('scarp-hook') - 0.004, count: 6, lateral: 0 },
    // Inside the looper, entry arc to exit arc.
    { from: frac('looper') + 0.02, to: frac('looper-out') - 0.008, count: 5, lateral: 0 },
    { from: frac('loop2') + 0.012, to: frac('ridge-jink') - 0.012, count: 6, lateral: -5 },
    { from: frac('ridge-bend') + 0.008, to: frac('flow-hook') - 0.004, count: 3, lateral: 0 },
  ],
  laps: 3,
}
