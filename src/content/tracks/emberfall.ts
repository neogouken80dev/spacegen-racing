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
 * Eighteen corners land: 1 hairpin, 9 medium, 6 fast, 2 sweeper -- fifteen of
 * the eighteen inside the 58-110m band the old ring rarely visited, with the
 * lap's one full stop (caldera-hook, r=55) fed by the 150m start straight.
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
 * THE ASH BEDS ARE NOT THE TRACK ANY MORE, and that is what this pass spent.
 * 152m of gravel straight plus two gravel corners is 234m, 7% of the lap,
 * against the 769m and 25% the thirteen-corner shape carried. Gravel is still
 * where the AI's corner model and a drifting player's diverge furthest, which
 * is where overtakes come from; there is simply a quarter as much of it, and
 * the reason is in THE SKETCH PASS.
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
 * arithmetically, unusable for a 55-75s lap. The fix was not a bigger scale;
 * it was a heading sequence that actually spreads around the circle instead
 * of idling near one direction for five corners in a row.
 *
 * THE LENGTHS BELOW ARE NOT A WISH-LIST, THEY ARE A SOLUTION. Every earlier
 * pass on this file authored straights it liked and let the builder correct
 * them, and every earlier pass paid for it: a wish-list whose residual is
 * large enough pushes one straight under the floor, and `circuit()`'s answer
 * to that is to GROW THE WHOLE SITE (scale 1.12, 1.27, 1.87 were all measured
 * here while searching), which adds 150-600m of lap for nothing. So the
 * straights below were solved instead -- closest feasible vector to the shape
 * this pass wanted, subject to the two closure equations, a 42m floor on
 * every straight, and a THIRD equality pinning the total lap length. The lap
 * therefore closes at scale 1.000 and `circuit()`'s own correction moves no
 * straight by more than 0.3m, so the numbers in the segment list are, to a
 * third of a metre, the numbers the builder emits. Tightest straight: 41.7m,
 * 4% clear of the 40m floor.
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
 * THE SKETCH PASS: WHAT REPLACED THE GRAVEL DIAGONAL, AND WHAT DID NOT FIT.
 * ===========================================================================
 *
 * The brief was a two-panel sketch (.design/ashkar-reference.png): keep the
 * bottom serpentine and the whole right-hand arc up to the start/finish
 * straight, and replace the long gravel diagonal down the upper left with
 * (a) a big hairpin at the top left, (b) a large sweeping S through the
 * infield, and (c) a large circular right-hand LOOPER on the left whose road
 * crosses back over itself. "More turns and a large right hand looper."
 *
 * The pass before this one read the same brief and APPENDED its new content
 * (three "esses" and a 360-degree Skyloop) onto the lap's last straight while
 * leaving the gravel diagonal intact. That measured 3862m and a mean lap of
 * 82.17s against a 55-75s band, and its esses were 6-11m kinks that
 * `circuit.ts`'s new guard now refuses outright. Everything that pass added
 * is gone, and so are the four gravel corners (ash-curve, ash-bend, ash-jink,
 * ash-exit) the pass before IT ran down the upper left, because the sketch
 * does not append -- it REPLACES.
 *
 * THE SKETCH, MEASURED. Both panels of the reference are drawn in the minimap
 * projection `tools/plot-track.ts` uses, at the same scale, and the left
 * panel lands on the 13-corner circuit's own plot to within a few pixels;
 * calibrating on the bounding box gives 1.50 m per sketch pixel. At that
 * scale the sketch's looper is a circle of radius ~118m, its infield S is a
 * ~600m-deep out-and-back, and its top-left hairpin is a true 180. Skeleton-
 * tracing the right-hand panel measures the drawn lap at ~4300-4600m of road,
 * and building the sketch's own proportions literally closed at 4513m.
 * So the sketch AS DRAWN cannot be built at the 3300-3500m this pass was
 * given; the question was only which parts to compress and by how much.
 *
 * THE ANSWER, AS AN LP. Once the corners are chosen the headings are fixed,
 * so closure is two linear equations in the straight lengths and the shortest
 * lap a topology admits is a linear program. Minimising total lap length over
 * per-straight floors chosen to keep the preserved half recognisable -- 150m
 * on the start straight (the lap's one full-stop braking zone), 120m on the
 * ash beds, 85-100m on the two right-arc straights, 42-45m everywhere else:
 *
 *   preserved chain + a bare 360 looper, no S, no hairpin   r=55  3397m baked
 *                                                           r=70  3491m
 *                                                           r=80  3554m
 *   + the sketch's true 180 hairpin and 180 infield U       r=55  3738m
 *                                                           r=70  3842m
 *   the sketch's own proportions, built literally                 4513m
 *
 * Read the first block against the 3300-3500m ceiling: a full-size looper on
 * its own nearly spends the whole budget. The second block is the cost of the
 * sketch's depth, and it is close to linear -- the same LP walked from a flat
 * 0-degree S to the sketch's 180 measured 3343m to 3681m of lap, about 1.9m
 * for every degree the hairpin/infield PAIR deepens.
 *
 * The reason is not the corners, it is the ground: the two Cinder Loops
 * consume 465m of lap distance and the Corkscrew's helix another 105m over
 * its own axis, and none of those 570m move the road one metre closer to
 * anywhere. That is exactly the room the sketch's S and hairpin want. All
 * five set pieces SURVIVE here -- nothing was dropped -- and the price is
 * paid in the two places the sketch is least specific about: the hairpin
 * turns 110 degrees rather than 180, and the infield S is a compressed
 * 110/-110 rather than a 600m excursion.
 *
 * WHAT THE LOOPER IS. 441 degrees of right-hander at r=60 on ONE circle,
 * split into two corners (185 + 256) only so the elevation can ramp in two
 * stages; same radius and same sign means the second continues the first's
 * circle exactly. 441 rather than 360 is the whole trick: a lap's corners
 * must sum to a whole number of turns, this lap's other corners sum to +279,
 * and 441 is what closes it at +720. Geometrically the extra 81 degrees is
 * what MAKES the crossing -- the road leaves the circle 81 degrees further
 * round than it joined, so the exit leg runs across the feed leg exactly as
 * the sketch draws it, instead of leaving tangentially on the same line.
 * Tried and rejected: 360 in the looper with the 81 as separate corners
 * before it (feed and exit come out PARALLEL, the loop returns onto its own
 * entry, and `circuit()` reported a 2.2m clearance over 60m of shared
 * ground); and a mixed-radius split, 185@56 + 256@64, which is 11m more arc
 * for the same 441 degrees and which -- measured on exactly the segment list
 * below, changing nothing but those two radii -- opens a THIRD crossing that
 * the assertion at the bottom of this file catches.
 *
 * WHY THE LOOPER IS 30m WIDE, WHICH IS MARGIN AND NOT A FIX. On an earlier
 * solution of this same topology the looper at the authored 24m measured 1.3
 * respawns a race, and logging each racer's spline position at the moment it
 * respawned put every one of them between s=1479 and s=1578 -- the back half
 * of the 256-degree arc, nowhere near any set piece. A 268m corner held at
 * one radius is the longest sustained load on the lap and eight cars arrive
 * at it together; at 24m they wedged each other into the outside wall until
 * the stall watchdog fired. 28m and 30m both measured 0.0 there, and banking
 * it harder instead was NOT the fix (bank 14 at w=28 went back to 0.7).
 *
 * BE HONEST ABOUT WHAT THAT MEANS FOR THE LAP THAT ACTUALLY SHIPPED: on the
 * straights below, 24m ALSO measures 0.0 respawns (72.37s mean against 30m's
 * 72.43s). So the extra six metres buy nothing this harness can see today.
 * They stay because the failure they answer was real, cost nothing in lap
 * length -- width is not geometry, the closure never sees it -- and the
 * straights that make it reappear are a metre of solver noise away: the same
 * topology solved at ashbeds 111m instead of 110m measures 0.3 respawns.
 *
 * WHAT THE SKETCH GOT THAT THE NUMBERS DID NOT COST. The looper sits where
 * the sketch puts it -- projecting the built circle back into the reference's
 * own pixel frame, its centre lands 31m from the drawn circle's centre -- the
 * ash beds still run along the top out of the fissure, the road still turns
 * down off them into the infield and sweeps back west to the looper, and the
 * looper still crosses its own road twice on the way out.
 *
 * What it does not have is the sketch's SIZE. The looper is r=60 against the
 * drawn r=118, half the diameter; the hairpin turns 110 degrees where the
 * sketch turns 180, so the lap never reaches the top-left corner of the map
 * the drawing fills; and the infield excursion is ~120m deep where the sketch
 * draws ~600m. Those three are the same 1100m of lap length, spent once.
 *
 * THE HANDEDNESS, SINCE SOMEBODY WILL COMPARE THE PICTURES. The minimap
 * projection negates u (see plot-track.ts's own header), so a right-hand
 * corner draws counter-clockwise on the map. The sketch's looper is drawn
 * clockwise, which in the sim is a LEFT-hand 360 -- and a left-hand looper on
 * a right-hand lap is a figure-eight, total turning zero, which `circuit()`
 * rejects (turns must be 1 or 2) and which no closed racing lap can be. The
 * brief's own words are "a large right hand looper" and `circuit.ts`'s header
 * calls Ashkar's looper "a full 360 of right-hander", so the looper is built
 * right-handed and hangs off the far side of its feed road from the drawing.
 * Everything else about its size, position and crossing follows the sketch.
 *
 * WHAT THE SHIPPED LAP MEASURES, so the next pass can tell what it moved.
 * `tools/probe-newtrack.ts --track=emberfall`: 3408.6m, 161 nodes, chord
 * 12.7-31.3m (ratio 2.46), 53% of the lap read as curved, tightest corner
 * 46m and median 97m, elevation 12-124m, 24/24 racers finished across three
 * seeds, laps 65.58 / 72.43 / 80.43s best/mean/worst, 0.0 respawns a race,
 * 0.2% of racer-frames off-track. `tools/probe-selfclear.ts`: closest the
 * road comes to another part of itself is 6.1m, between s=1347 and s=1779 --
 * the looper's own two decks, 432m apart along the lap, against the 2.0m a
 * car needs.
 *
 * THE ONE READING UNDER 45m IS NOT A CORNER, AND IT IS INHERITED. Sampling
 * `curvatureAt(s, 20)` every 0.25m rather than on probe-newtrack's 1.5m grid
 * finds 43.3m at s=3080 -- inside the CORKSCREW, on its descending exit
 * mouth, on 30m-wide metal at a -0.42 grade, where the helix's radius ramp
 * un-rolls the ribbon. Nothing is authored there. The thirteen-corner Ashkar
 * that shipped before any of this measures the same thing at 44.3m, and it is
 * the reason both circuits report a "tightest" a little under their own
 * smallest corner. Every corner this file actually authors bakes at 46.9m or
 * wider.
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
 * THE EIGHTEEN CORNERS, in lap order. Each radius is picked from the band
 * table above; each `bank` carries the SAME SIGN as `deg` (positive = right)
 * -- `circuit()` does not infer one from the other, and every corner on every
 * shipped `circuit()` track keeps this pairing, so a mismatched sign here
 * would be the one corner on the planet that banks away from the turn.
 */
const CORNERS: (Seg & { t: 'corner' })[] = [
  // C1 -- CALDERA HOOK. Hairpin band, and the reason the start straight is
  // 150m: a hairpin fed by anything shorter is a corner the AI arrives at
  // still on the throttle. Widened (26 against the 21m base) for the same
  // reason the old file widened its own tightest bend -- a driver who needs
  // an alternate line through a full stop should have room to take it.
  { t: 'corner', r: 55, deg: 45, bank: 10, w: 26, tag: 'caldera-hook' },
  // C2 -- BASALT SWEEP. Medium band, turns the opening run onto the fissure.
  { t: 'corner', r: 65, deg: 35, bank: 8, tag: 'basalt-sweep' },
  // C3-C4 -- THE ASH BEDS' OWN CORNERS. The gravel is a quarter of what it
  // was (see THE SKETCH PASS), so it gets two corners rather than four: a
  // sweeper-band kink that keeps the top of the lap from being one dead
  // straight, and a fast-band right that starts the turn-in to the hairpin.
  // ash-bend is deliberately the lap's second sweeper -- 18 degrees at 120m
  // is 37.7m of arc, three times `circuit.ts`'s kink floor, and it is the
  // only place on the lap a driver carries full speed through a direction
  // change on 0.70 grip.
  { t: 'corner', r: 120, deg: 18, bank: 4, surface: 'gravel', w: 25, tag: 'ash-bend' },
  { t: 'corner', r: 80, deg: 32, bank: 7, surface: 'gravel', w: 25, tag: 'ash-curve' },
  // C5 -- SUMMIT HAIRPIN. The sketch's top-left hairpin, at the angle the
  // length budget allows: 110 degrees of turn-in shared with ash-bend and
  // ash-curve, of which this corner takes 60. Off the gravel, on basalt, so
  // the braking zone is honest.
  //
  // r=58 IS NOT A ROUNDING OF 56, IT IS THE NODE COUNT. `walk()` emits
  // max(ceil(deg/30), round(arc/spacing)) nodes, so a 60-degree corner needs
  // 60m of arc -- radius 57.3 -- before it gets a THIRD node instead of two,
  // and two nodes through a uniform Catmull-Rom cut the corner. Measured on
  // the baked centreline at 0.25m resolution: r=56 (58.6m of arc, 2 nodes)
  // reads 43.7m, tighter than the 45m floor this circuit is held to and
  // tighter than anything authored; r=58 (60.7m of arc, 3 nodes) reads 53.0m.
  // The 4% of radius bought 21% of read radius, which is the node and not the
  // geometry. probe-newtrack's own 1.5m sample grid does not see this: it
  // steps over the dip and reports 46m either way.
  { t: 'corner', r: 58, deg: 60, bank: 10, w: 26, tag: 'summit-hairpin' },
  // C6-C7 -- THE INFIELD S. The other half of the sketch's sweeping S: 110
  // degrees back the other way, split medium/medium so the second half
  // tightens into the run west toward the looper. This pair and the hairpin
  // pair are what the old four gravel corners used to be.
  { t: 'corner', r: 72, deg: -58, bank: -8, w: 24, tag: 'infield-1' },
  { t: 'corner', r: 60, deg: -52, bank: -8, w: 24, tag: 'infield-2' },
  // C8-C9 -- SCARP JINK / SCARP HOOK. A cancelling fast-band pair on the run
  // down to the looper: net zero turning, 54m of arc between them, and the
  // cheapest two corners on the lap because a 16-degree corner's chord is
  // within half a metre of its arc -- they buy corner count and rhythm for
  // almost no lap length at all. They are NOT a chicane: the closure puts
  // 132m of straight between them (the longest run in the new section), so
  // they read as a left kink, a breath, and a right kink back onto the
  // looper's line. They exist because "more turns" was the brief's first ask
  // and because the road from the infield to the looper is otherwise 220m of
  // nothing.
  { t: 'corner', r: 100, deg: -16, bank: -6, w: 23, tag: 'scarp-jink' },
  { t: 'corner', r: 95, deg: 16, bank: 6, w: 23, tag: 'scarp-hook' },
  // C10-C11 -- THE LOOPER. 441 degrees of right-hander on one r=60 circle,
  // split 185/256 so the deck can climb in two stages (see the header). The
  // widest road on the circuit at 30m, for the reason logged under WHAT
  // THREW THE FIELD OFF THE LOOPER.
  { t: 'corner', r: 60, deg: 185, bank: 9, w: 30, tag: 'looper' },
  { t: 'corner', r: 60, deg: 256, bank: 9, w: 30, tag: 'looper-out' },
  // C12 -- TUBE BEND. The only corner inside the Lava Tube tunnel: fast band,
  // so the tunnel reads as a held commitment through the rock rather than a
  // second braking zone stacked on top of the looper's exit.
  { t: 'corner', r: 100, deg: 45, bank: 7, surface: 'metal', w: 20, tag: 'tube-bend' },
  // C13-C14 -- EMBER SWEEP / EMBER HOOK. Medium band, between the tunnel's
  // first Cinder Loop and the second -- the technical heart of the lap the
  // band table calls for, on ordinary basalt with nothing else going on.
  { t: 'corner', r: 76, deg: 45, bank: 8, tag: 'ember-sweep' },
  { t: 'corner', r: 62, deg: 38, bank: 8, tag: 'ember-hook' },
  // C15 -- RIDGE JINK. A short fast left between the second loop and the
  // Corkscrew that keeps the run of right-handers from the tunnel to the
  // final sweeper from reading as one uninterrupted curl.
  { t: 'corner', r: 90, deg: -20, bank: -5, tag: 'ridge-jink' },
  // C16-C17 -- RIDGE BEND / FLOW HOOK. Fast then medium, unwinding out of the
  // Corkscrew's exit straight toward the rim.
  { t: 'corner', r: 105, deg: 33, bank: 6, tag: 'ridge-bend' },
  { t: 'corner', r: 60, deg: 30, bank: 8, tag: 'flow-hook' },
  // C18 -- RIM SWEEPER. r=170m: flat out, closes the final straight back onto
  // the start.
  { t: 'corner', r: 170, deg: 28, bank: 4, tag: 'rim-sweeper' },
]
{
  const sum = CORNERS.reduce((a, c) => a + c.deg, 0)
  // 720, not 360: one ordinary lap PLUS one full turn spent in the looper.
  // `circuit()` accepts turns in {1, 2}; 2 is what produces (and requires)
  // the self-crossing the looper needs to read as a flyover rather than a
  // second flat loop.
  if (Math.abs(sum) !== 720) throw new Error(`Ashkar: corner angles sum to ${sum}, not 720`)
}

/**
 * THE FULL SEGMENT LIST. Unlike every earlier pass on this file, these
 * straight lengths are the SOLVED ones, not a wish-list -- see THE LENGTHS
 * BELOW ARE NOT A WISH-LIST in the header. The lap closes at scale 1.000 with
 * a correction of under 0.2m on any straight, so what is written here is what
 * `circuit()` emits; change one number and the builder will quietly reshape
 * the other twenty to compensate.
 *
 * `toY` only appears where the elevation actually changes; every segment
 * between keeps the last value, so the profile reads top to bottom as: climb
 * off the grid, launch the fissure, plateau on the ash beds at 46m, fall all
 * the way down the infield to the looper's feed road at 12m -- the lap's
 * floor and the deck every crossing passes over -- climb 42m round the looper
 * to 54m, then dive into the tunnel at 34-26m and let the two Cinder Loops
 * and the Corkscrew carry the profile back up to the grid's 30m.
 */
const segs: Seg[] = [
  { t: 'straight', len: 150, tag: 'start', w: 26 },
  CORNERS[0],
  { t: 'straight', len: 42 },
  CORNERS[1],
  { t: 'straight', len: 42 },
  // THE FISSURE. A launch across an open crack in the shield, not a corner --
  // `ramp`/`boost` on the first 18% and `open` road over the gap are set by
  // `circuit()`'s own `jump` branch.
  { t: 'jump', len: 110, launch: 26, gap: 45, tag: 'fissure', w: 24, toY: 36 },
  // THE ASH BEDS. Tagged at its own first node; `ashbeds` is read directly by
  // themes/emberfall.ts to place the gravel dressing (with a 420m cluster
  // span and the gravel is now 234m, so the dressing overruns onto basalt at
  // both ends -- the theme is another worker's file and the tag contract is
  // on the NAME, not the length, so this is worth flagging to them rather
  // than lengthening the gravel to suit a prop scatter).
  { t: 'straight', len: 110, tag: 'ashbeds', surface: 'gravel', w: 25, toY: 42 },
  CORNERS[2],
  { t: 'straight', len: 42, surface: 'gravel', w: 25, toY: 46 },
  CORNERS[3],
  CORNERS[4],
  // THE INFIELD S. The diagonal down off the summit and the sweep back west.
  { t: 'straight', len: 42, tag: 'diag', w: 24, toY: 40 },
  CORNERS[5],
  { ...CORNERS[6], toY: 34 },
  { t: 'straight', len: 43, tag: 'return', w: 24, toY: 16 },
  CORNERS[7],
  // The longest run in the new section, and the closure chose it: the two
  // scarp corners face 16 degrees either side of the heading everything else
  // here uses, so this is the only straight that can supply displacement in
  // that direction. It is why the scarp pair reads as two kinks rather than a
  // chicane -- see C8-C9.
  { t: 'straight', len: 132, toY: 14 },
  CORNERS[8],
  // THE LOOPER'S FEED ROAD, and the lap's lowest ground at 12m. Everything
  // the looper passes over passes over THIS, so its height is not decoration:
  // drop it and both crossings lose their clearance together.
  { t: 'straight', len: 42, tag: 'feed', w: 26, toY: 12 },
  { ...CORNERS[9], toY: 24 },
  // The looper's own bridge-deck straight, at the corners' 30m width. It is
  // 42m of road inside a 504m corner; its only job is to let the climb ramp
  // in two stages rather than one.
  { t: 'straight', len: 42, w: 30, toY: 28 },
  { ...CORNERS[10], toY: 54 },
  { t: 'straight', len: 42, toY: 50 },
  // THE LAVA TUBE. An enclosed run of basalt tunnel -- `tunnel: true` is art
  // metadata only (the sim has no tunnel concept). It no longer dives to
  // 16-22m the way it did when the ash beds fed it from a plateau: the looper
  // now hands it the road at 50m and the tunnel is the descent, 50 -> 34 ->
  // 26m. Authored at 62, not 42 like its neighbours: `walk()`'s own
  // `steps = round(len/spacing)` rounds anything under 60m down to 2 samples,
  // one f=0..0.5 chord and one f=0.5..1.0-into-the-corner chord, each roughly
  // HALF the closed length. That was this circuit's worst joint on an earlier
  // pass (a 35.0m chord straight into tube-bend, ratio 3.57); 62m buys the
  // third sample and an ordinary ~21m chord.
  { t: 'straight', len: 62, surface: 'metal', tunnel: true, w: 20, toY: 34 },
  { ...CORNERS[11], tunnel: true },
  { t: 'straight', len: 42, surface: 'metal', tunnel: true, w: 20, toY: 26 },
  // CINDER LOOP ONE. Consumes no plan distance; its exit duplicate is fixed
  // by the post-processing below. r=34 (not a smaller, tighter loop) because
  // `circuit.ts` now refuses anything under 32m -- see the header's item 2
  // for why a tight loop cannot carry a wide stagger gently.
  { t: 'loop', r: 34, side: 1, stagger: 54, surface: 'metal', w: 18, tag: 'loop1' },
  { t: 'straight', len: 42, toY: 30 },
  CORNERS[12],
  { t: 'straight', len: 42, toY: 34 },
  CORNERS[13],
  { t: 'straight', len: 42, w: 19, toY: 36 },
  // CINDER LOOP TWO. Larger and opposite-handed to the first (r=40 against
  // 34, side=-1 against +1), so the two loops read as a pair rather than a
  // repeat -- and comfortably inside the legal stagger band (52-76 at this
  // radius).
  { t: 'loop', r: 40, side: -1, stagger: 58, surface: 'metal', w: 19, tag: 'loop2' },
  { t: 'straight', len: 42, toY: 38 },
  CORNERS[14],
  { t: 'straight', len: 42, toY: 40 },
  // THE CORKSCREW. A single turn around a 42m bore -- see item 3 in the
  // header for why `turns: 1` and not 2.
  { t: 'cyclone', r: 42, turns: 1, len: 280, surface: 'metal', w: 30, tag: 'corkscrew' },
  { t: 'straight', len: 42, toY: 34 },
  CORNERS[15],
  { t: 'straight', len: 42, toY: 31 },
  CORNERS[16],
  { t: 'straight', len: 42, toY: 30 },
  CORNERS[17],
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
  // hoped-for number -- the shipped lap clears it at 29.1m and 22.1m.
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
 * node. On one circle of radius 60 that lands diametrically opposite the
 * entry, but nothing here depends on that: change the split or the radii and
 * the search still returns the right node.
 */
const iLooper = nodeNear(built.marks['looper'])
nodes[iLooper].tag = 'looper'
{
  // The looper's far end, derived from the two corners rather than restated:
  // `looper-out` starts where the first arc and the bridge deck end, and its
  // own arc closes the circle.
  const arcEnd = built.marks['looper-out'] +
    (Math.abs(CORNERS[10].deg) * CORNERS[10].r * Math.PI) / 180
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
 * late, high part of the arc passes over the early, low part of the same
 * arc. An earlier pass asserted exactly one crossing here because its Skyloop
 * was a 360 split across a bridge straight; that assertion is now wrong, and
 * asserting the count this lap actually has is worth more than asserting a
 * number that happens to be smaller.
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
    // THE INFIELD S, mid-block -- the same treatment as the lap's other
    // technical, default-width corners.
    { at: (frac('infield-1') + frac('infield-2')) / 2, count: 4, spread: 3.8 },
    // THE LOOPER. Just past its entry, the same "+offset single point"
    // pattern as the two Cinder Loops -- widest spread on the lap for the
    // widest (30m) road.
    { at: frac('looper') + 0.02, count: 5, spread: 4.8 },
    { at: frac('loop1') + 0.015, count: 4, spread: 4.0 },
    { at: frac('loop2') + 0.02, count: 5, spread: 4.2 },
    { at: (frac('ridge-bend') + frac('flow-hook')) / 2, count: 4, spread: 3.8 },
  ],
  chargeRuns: [
    { from: frac('start') + 0.005, to: frac('caldera-hook') - 0.015, count: 6, lateral: -5 },
    { from: frac('ashbeds') + 0.005, to: frac('ash-bend') - 0.005, count: 5, lateral: 5 },
    // The run down to the looper: the scarp pair's own cancelling jink, which
    // is the one place on this half of the lap a line choice is free.
    { from: frac('return') + 0.01, to: frac('scarp-hook') - 0.005, count: 5, lateral: 0 },
    // Inside the looper, entry arc to exit arc.
    { from: frac('looper') + 0.03, to: frac('looper-out') - 0.01, count: 5, lateral: 0 },
    { from: frac('loop2') + 0.015, to: frac('ridge-jink') - 0.015, count: 6, lateral: -5 },
    { from: frac('ridge-bend') + 0.01, to: frac('flow-hook') - 0.005, count: 3, lateral: 0 },
  ],
  laps: 3,
}
