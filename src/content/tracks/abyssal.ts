import type { TrackDef, TrackNode } from '../../sim/track'
import { circuit, type Seg } from './circuit'

/**
 * MERIDIAN DEEP — Submerged Transit Tube.
 *
 * A maintenance arterial running along the floor of an abyssal trench, inside
 * a transparent pressure tube, with the ocean and everything living in it on
 * the other side of the glass.
 *
 * Difficulty: Hard. Elkarim and Ashkar are decided on surface; this one is
 * decided on GRIP FALLING AWAY UNDER YOU, which is a different and less
 * forgiving thing.
 *
 * ===========================================================================
 * 0. THIS PASS IS THE SKETCH PASS. WHAT IT KEPT AND WHAT IT REDREW.
 * ===========================================================================
 *
 * The circuit below still uses `circuit.ts` -- a straight, a braking zone, a
 * corner of a CHOSEN radius, an exit, repeat -- for the reasons the previous
 * rewrite recorded and which are still true (a harmonic ring has no braking
 * zones and no chosen radii; four circuits built that way measured a median
 * radius of 113-140m and played as "the overall oval or square-ish type design
 * does not offer a lot of variety"). What changed is the PLAN SHAPE, and it
 * changed because Vince supplied a two-panel before/after sketch
 * (`/home/claude/sketches/meridian-deep-sketch.png`): keep the zigzag on the
 * left flank, replace the flat run along the top with a big WAVE, add a
 * descent down the right, and drive a large S-CURVE through the bottom middle
 * where the old lap just swept round. "The revised plan wanders; the old one is
 * a kidney."
 *
 * Asked directly whether to shrink the drawing to protect the 55-75s lap band
 * or to build it at full size: "match the overall shape, and keep the longer
 * distance. i dont mind if its longer." The band in `tools/probe-newtrack.ts`
 * is now 55-105s and this lap spends a good part of the new room. See the
 * measured table at `CIRCUIT` below for exactly how much.
 *
 * ---------------------------------------------------------------------------
 * THE SKETCH, MEASURED, BECAUSE EYEBALLING IT WOULD HAVE BEEN WRONG TWICE.
 *
 * Both panels are drawn in the projection `tools/plot-track.ts` uses (which is
 * the minimap's: it negates u AND v, so a right-hand corner draws
 * counter-clockwise on the page -- the lap below is a net +360 RIGHT-hand lap
 * and it plots anticlockwise, same as the shipped one). Chamfer-fitting the
 * shipped circuit's own baked centreline onto the LEFT panel pins the drawing
 * at 2.157 m per sketch pixel, and lands the fit's origin within 0.3px of the
 * drawn start/finish bar -- so the calibration is not a guess, it is the
 * drawing telling you where its own start line is. The right panel is the left
 * panel translated by exactly +607px and nothing else, so both panels share one
 * coordinate frame and a feature can be looked up in either.
 *
 * At that scale:
 *
 *   left panel traced      3381m raw / 3214m smoothed   (shipped plan: 3151m)
 *   right panel traced     4093m raw / 3890m smoothed
 *
 * The +2% bias the left panel shows against a lap whose real length is known is
 * the skeleton staircase, so the right panel's TRUE length is about 3800m of
 * plan -- 21% more road than the shipped circuit, drawn inside the SAME
 * bounding box (both panels' road boxes are 534px wide and within three pixels
 * of the same height: 534x424 and 534x427). That
 * is the whole design brief in one sentence: same site, half again as much
 * wandering.
 *
 * WHAT THE DRAWING IS ACCURATE ABOUT, AND WHAT IT IS NOT. Segmenting the LEFT
 * panel and comparing each run against the shipped file's own authored numbers:
 * the drawn TURN ANGLES are right to a couple of degrees everywhere (drawn
 * +23.2 for the authored +24 of ESSES-IN, +58.5 for HAIRPIN-1's +58, +36.7 for
 * BLOOM-C's +40, -16.5 for COUNTER-2's -20), and the drawn RADII are inflated
 * about two-fold on anything short, because the 40m curvature window that reads
 * them cannot see inside a 25m arc. So this pass takes the angles from the
 * drawing and CHOOSES the radii, which is also what puts real hairpins and real
 * sweepers back in a picture whose every corner reads as "about 110m".
 *
 * WHICH THIRDS OF THE LAP ARE UNTOUCHED. Comparing the two traces directly,
 * the new line sits within 12m of the old one for s 0..462, s 1410..2760 and
 * s 3672..3875 of the drawn lap -- so roughly 2000m of the 3875m is the shipped
 * circuit, redrawn on top of itself, and the two inserts are the WAVE (+150m,
 * replacing the top run) and the S (+554m, replacing the bottom-middle sweep).
 * Every corner in those preserved spans below is carried over at its shipped
 * radius and degrees, marked `[kept]`, and the three straight-line features
 * that live in them -- the three biofilm blooms, the spiral, the Breach --
 * are in the same place on the map they were.
 *
 * THE ZIGZAG ON THE LEFT FLANK IS THE SPIRAL, AND THIS IS WORTH STATING
 * LOUDLY, because the brief calls it "the zigzag esses complex" and a reader
 * who goes looking for an esses complex in the old file will find a 3-piece
 * +24/-20/+18 wiggle at the TOP RIGHT and preserve the wrong thing. It is not
 * that. Measured on the shipped baked centreline, the box the zigzag occupies
 * (u -1020..-870, v -200..+150) is baked s 1708..2260, which is plan s
 * 1613..2013 -- the `cyclone`. Its helix swings sideways by the tube radius
 * and that is what draws as the reversals in plan. Preserving the zigzag
 * therefore means preserving the CORKSCREW at the same radius, the same axis
 * length and the same place, which is what `spiral` below does.
 *
 * ITS TURN COUNT IS THE ONE THING THIS PASS COULD NOT PRESERVE, and section 2A
 * prices that exactly: three turns drew four sharp reversals, two draws two
 * sharp ones and two shallow, inside an IDENTICAL plan box (u 933..1065,
 * v -120..244, measured both ways) at an identical +/-30m peak swing. It is
 * the same wander at half the frequency, and it is what made the set piece
 * enterable.
 *
 * ---------------------------------------------------------------------------
 * HOW THE SEGMENT LIST WAS SOLVED, AND WHY NOT BY HAND.
 *
 * `circuit()` shuts a lap with the minimum-norm correction across every
 * straight, and that correction is only invisible if the authored lap nearly
 * closes on its own. With 30 corners and 1126 degrees of total steering -- the
 * shipped circuit has 17 and 500 -- hand-guessing 31 straight lengths that both
 * close AND land on a drawing is not a thing a person does in an afternoon. So
 * the straights (and, in an earlier stage, the free corners' degrees) were
 * SOLVED: a Levenberg-Marquardt fit of the plan walk against the traced
 * drawing, with the preserved features pinned to the stations their world
 * positions project onto, a 48-point lap-fraction term to stop the fit
 * shrinking the lap inside the target, and the closure residual weighted hard
 * enough to be an equality in practice. It converges at gap 0.0000m and scale
 * 1.000, so `circuit()`'s own correction moves no straight by more than 0.31m
 * and the numbers below are, to a third of a metre, the numbers the builder
 * emits. Tightest straight after correction: 43.7m, 9% clear of the 40m floor.
 *
 * TWO THINGS THAT FIT PASS LEARNED THE HARD WAY.
 *
 * 1. LET THE RADII FLOAT AND THEY ALL COLLAPSE TO THE FLOOR. A free optimiser
 *    prefers a tighter radius every time, because the same heading change costs
 *    less arc and buys straight length elsewhere. Run unconstrained it returned
 *    45m and 55m corners all over a circuit whose whole complaint history is
 *    "the few turns are far too sharp". The radii below are therefore CHOSEN
 *    per corner, one per band, and only the degrees and lengths were fitted.
 *
 * 2. A FIT THAT ONLY MATCHES POSITIONS WANDERS OFF BY A HEADING. Fixing every
 *    corner's degrees at the drawing's own turn budget and solving straights
 *    alone left 150-190m of position error by three-quarters distance: the
 *    drawing carries about 20 degrees of net turning inside runs the segmenter
 *    calls "straight", and dropping it puts a heading error into the lap that
 *    no straight length can undo. Giving the non-preserved corners +/-8 degrees
 *    of freedom, with the 360-degree sum as a residual, took the chamfer from
 *    47m to 17m. The lap is a heading problem before it is a length problem.
 *
 * HOW CLOSE IS CLOSE ENOUGH, MEASURED RATHER THAN ASSERTED. The baked
 * centreline sits 27.2m (mean, symmetric chamfer) from the traced right panel,
 * p95 66m, worst 77m. That number means nothing on its own, so here is its
 * floor: the SHIPPED circuit against the LEFT panel -- a drawing of a lap that
 * already exists, by the same hand, at the same scale -- measures 27.4m, p95
 * 59m, worst 66m. This circuit therefore matches its panel about as well as
 * Vince's own drawing matches the circuit it was traced from, and any further
 * fitting would be fitting the pen.
 *
 * ===========================================================================
 * 1. THE BIOFILM IS THE TRACK. (Unchanged, and now four corners' worth.)
 * ===========================================================================
 *
 * `oil` is grip 0.30 -- lower than ice (0.45) and less than a third of tarmac.
 * Here it is a FEATURE of the route: the tube leaks, and where it leaks things
 * grow, so a bloom patch sits ON the racing line rather than off it.
 *
 * Every bloom is authored as TWO consecutive `corner` segments at the SAME
 * radius and SAME bank -- metal, then oil -- so the geometry is one continuous
 * arc and only the surface changes underfoot. That gives the patch a real ramp
 * rather than a step (`Track` snaps `surface` at the midpoint between nodes, so
 * at this file's 18m spacing the transition reads as a fade across one node
 * gap). An earlier draft used three pieces (metal/oil/metal) and it is why that
 * draft does not survive: three pieces at these degree budgets put at least one
 * arc under 20m, below what a corner needs to avoid the chord-ratio problem
 * documented at `CIRCUIT`.
 *
 * AND CRUCIALLY every bloom sits on a radius of 62-66m -- medium band, 47-49
 * m/s before the oil touches it. 0.30 grip is survivable at that speed and is
 * NOT survivable at the 76 m/s this circuit's sweepers run flat out. So a bloom
 * punishes a driver who carried fast-corner speed into a corner that only
 * wanted medium speed, and costs a tidy driver almost nothing.
 *
 * BLOOM-D IS NEW AND IT IS THE BRIEF'S "hazard where the S doubles back".
 * BLOOM-D is the corner where the lap stops running east along the bottom of
 * the map and turns 70 degrees north-west into the infield -- the literal
 * double-back, and the only corner in the whole S complex inside the 62-66m
 * window the paragraph above makes a hard requirement. Every other corner in
 * the S is 82m or wider (54 m/s and up), where 0.30 grip is a respawn rather
 * than a penalty. So the hazard goes where the physics allows it, not where the
 * drawing's apex happens to be, and a fourth dose of a mechanic the driver has
 * met three times by then is the right difficulty curve for the roster's Hard
 * circuit.
 *
 * ===========================================================================
 * 2. THE SPIRAL IS THE SET PIECE, AND IT IS ALSO THE SKETCH'S ZIGZAG.
 * ===========================================================================
 *
 * The four circuits divide the set pieces between them: Halcyon Bay takes the
 * loops, Zhen-9 one of each, and Meridian Deep is the SPIRAL track. NO LOOP
 * here, by design, so this file never emits a `cathedral` / `cathedral-apex`
 * tag pair; `themes/abyssal.ts`'s `landmarks()` looks for both and skips the
 * whole dome-lighting rig cleanly when either is missing, which is what we
 * want.
 *
 * A road inside a cylinder can climb its walls, and every node the corkscrew
 * authors an `up` off world-vertical for gets `stick` defaulted to 1 by
 * `Track`, so a car that gets light over a seam falls back toward the road it
 * left rather than into the glass.
 *
 * `circuit()`'s own plan/closure heading does not turn at all through a
 * cyclone -- it rides a straight axis and coils around it -- which is why the
 * spiral consumes none of the 360-degree budget. The BAKED road is a real 3-D
 * curve, but `Track.curvatureAt` measures curvature about the SURFACE NORMAL,
 * and a helix whose `up` points at its own axis is a GEODESIC of the cylinder:
 * in the plane the car is actually driving in, the barrel is straight. Measured
 * at 0.25m resolution over the middle 30% of the coil's road span, the barrel
 * reads 228-521m of radius -- looser than any authored corner on the lap, and
 * it read 204-434m at the three turns this file shipped with. Everything tight
 * about a cyclone happens at its MOUTHS, where the tube radius ramps in; that
 * is section 2A, and until this pass this file had it wrong.
 *
 * ONE ARITHMETIC TRAP THE SKETCH PASS HAD TO FIX. `circuit()` counts a cyclone
 * as `len` metres of lap distance (400 here), but the road it emits is a helix,
 * so its PLAN path is longer and its 3-D path longer still. Measured on THIS
 * build: `built.length` says 3856.5m of plan, the baked plan path is 3902.9m
 * and the baked road is 3967.9m, so the spiral is worth 46m of plan and 111m
 * of road that no straight in the segment list accounts for. Any fit that
 * compares `built.length` against a traced drawing has to add it back or the
 * lap comes out short exactly where it can least afford to. (At the three
 * turns this file shipped with, the same gaps were 92m and 183m -- the number
 * moves with `turns`, so it is measured here rather than quoted.)
 *
 * ===========================================================================
 * 2A. THE MOUTHS. VINCE SAID THE ENTRY WAS IMPOSSIBLE; HE WAS RIGHT, AND THIS
 *     FILE'S PREVIOUS HEADER TOLD YOU IT WAS FINE.
 * ===========================================================================
 *
 * The report was "the corkscrew's entry angle is quite impossible to enter into
 * smoothly". The paragraph this one replaces answered that complaint in advance
 * and answered it wrongly: it recorded 39.8-40m of curvature at the corkscrew,
 * against the 45m floor this circuit is held to, and dismissed it as "inside the
 * corkscrew, where nothing is authored... inherited, not a corner". Both halves
 * of that dismissal are false. It IS a corner -- it is the tightest reading on
 * the entire lap, tighter than both hairpins -- and it is not inherited, it is
 * a consequence of two numbers this file chose.
 *
 * WHAT IS ACTUALLY TIGHT, MEASURED. `curvatureAt(s, 20)` on a 0.25m sweep
 * (probe-newtrack's 1.5m grid misses this; the finer instrument is the only one
 * that sees it) over the shipped r=30 / turns=3 / len=400 corkscrew:
 *
 *      entry ramp   (outer 35%)   tightest 59.3m at s=1767
 *      barrel       (middle 30%)  tightest 203.6m -- a geodesic, see part 2
 *      exit ramp    (outer 35%)   tightest 39.8m at s=2191
 *
 * So the tight road is the two RAMPS -- the outer 35% of the axis at each end,
 * where `circuit.ts` smoothsteps the tube radius up from zero -- and the driver
 * meets the first of them 25m after leaving a 160m sweeper at 76 m/s with a
 * 44m straight in between. That is the "entry angle": the curvature goes from
 * nothing to a 59m corner inside 25m of road, with no braking zone in front of
 * it, and then does it again harder on the way out.
 *
 * `neonspire.ts` SOLVED THE SAME DEFECT AND ITS FORMULA DOES NOT TRANSFER. That
 * header records the mouth's baked radius as 0.0228 * len^2 / r to within 4%
 * across five (r, len) pairs, and fixed Zhen-9's 37m/41m mouths by trading
 * radius for length (r 26->22, len 196->240) to reach ~60m. Applied here that
 * formula predicts 0.0228 * 400^2 / 30 = 122m for a corkscrew that measures
 * 39.8m -- off by a factor of three. Extending it by `turns` (Zhen-9's cyclone
 * turns ONCE; this one turned three times) gets 40.5m against 39.8m, which
 * looks like a fit until you push it: sweeping len at r=30, turns=3 measures
 *
 *      len 400  39.8m      len 480  48.4m      len 560  62.5m
 *      len 440  44.2m      len 520  54.7m
 *
 * which is len^1.34, not len^2, so the extended formula over-predicts by 27% at
 * len=560. Sweeping RADIUS at turns=3 settles it: r=22 reads 39.6m, r=26 38.5m,
 * r=30 39.8m, r=36 43.5m. The mouth radius is essentially INDEPENDENT of the
 * tube radius here, which a cubic-mouth term proportional to r/len^2 cannot be.
 * Neonspire's formula is real and it is not what is binding on this circuit.
 *
 * WHAT IS BINDING IS ROLL RESOLUTION. `walk()` emits a cyclone at
 * `round(len / 13)` nodes -- 31 for a 400m axis, a constant this file cannot
 * change -- and spends `360 * turns` degrees of helix phase across them. At
 * turns=3 that is 34.8 degrees of roll PER NODE, and `Track` bakes a uniform
 * Catmull-Rom through them: the same under-resolution that makes a 2-node
 * corner read tighter than it is authored. Holding r=30 and sweeping the phase
 * rate, by either lever, collapses onto one curve:
 *
 *      turns/len  3/400 3/440 3/450 3/460 3/560 2/400 2/440 1/400
 *      deg/node    34.8  31.8  30.9  30.9  25.1  23.2  21.2  11.6
 *      mouth R     39.8  44.2  45.5  47.1  62.5  61.9  71.6  97.3
 *
 * Two levers, one curve. (3/450 and 3/460 share a node count and differ by
 * 1.6m, which is neonspire's cubic-mouth term still there underneath, an order
 * of magnitude smaller than the sampling term. 3/560 is measured at the site
 * scale `circuit()` needs to close it -- scale moves straights, not the coil,
 * so the reading stands.)
 *
 * THE FIX IS `turns` 3 -> 2, AND IT IS THE ONLY LEVER THAT IS FREE. The three
 * candidates, all measured on this lap:
 *
 *   len 400 -> 460, turns 3   mouths 67.8 / 47.1m. Keeps four plan reversals.
 *     Costs: 460 is the LAST length that closes at scale 1.000 -- 470 tips
 *     `circuit()` into a 1.04x uniform site inflation, which re-scales all 31
 *     straights and walks the lap off the drawing it was fitted to. Even at 460
 *     the tightest straight falls from 43.7m to 40.4m, 1% clear of the 40m
 *     floor where the header's whole solved-straights argument claims 9%. And
 *     47.1m is 2m of daylight over the floor. A hairline on three counts.
 *   r 30 -> anything, turns 3   does nothing. See the radius sweep above.
 *   turns 3 -> 2                mouths 59.3/39.8 -> 68.2/61.9m.
 *
 * Two turns costs NOTHING anywhere else, and that is not a hope, it is what
 * `walkEnd` does: it advances a cyclone by `s.len` along the heading and never
 * looks at `turns`, so the plan walk, the closure residual, the 31 solved
 * straight lengths (tightest still 43.69m), `scale` (1.000), `gap` (0.0000m)
 * and the node count (31, from `round(len/13)`) are all bit-identical. The plan
 * box is identical. The +/-30m peak swing is identical. What changes is the
 * number of reversals drawn inside that box (four sharp -> two sharp, two
 * shallow: peak laterals go 6, -24.6, 30, -29.9, 24.6, -6 to 11.9, -29.7,
 * 29.6, -11.8) and the length of the 3-D road, because a lazier helix is a
 * shorter one: the emitted coil measures 508m for its 400m axis instead of
 * 571m, and the lap bakes 3967.9m instead of 4033.8m.
 *
 * WHAT THE SET PIECE IS NOW. 61.9m at the tighter mouth is a medium-band corner
 * -- 49 m/s, a real lift, still the thing the AI slows for -- where 39.8m was a
 * hairpin the driver was given no warning about and no room for. Nothing on the
 * lap reads under 45m any more: the tightest radius on the circuit is
 * HAIRPIN-1's 47.5m, an authored corner, which is how it should have been all
 * along. The `<45m` slice of the curved-sample census goes 0.6% -> 0.0%.
 *
 * ===========================================================================
 * 3. THE BREACH, THE JUMP, AND THE TWO BOOST STRIPS.
 * ===========================================================================
 *
 * THE BREACH is unchanged: one span where the tube is cracked and the sea is
 * coming through, a flat 15 m/s^2 lateral current across a 160m sweeper, with
 * BOUNCE walls, never open ones. Ashkar paid for the other choice at 16.3
 * respawns a race -- a crosswind over unbarriered road is not difficulty, it is
 * a loading screen. The sweeper is taken flat out, so the current's job is not
 * to slow you, it is to push you toward a wall you are allowed to lean on.
 *
 * THE TRENCH JUMP MOVED 494m, AND THAT IS THE ONE PLACE THIS PASS SPENT ART
 * RATHER THAN GEOMETRY. On the shipped lap it runs along the top of the map at
 * (u -655..-842, v -511..-537). The drawing does not put a straight anywhere
 * near there any more: the new top run is the wave, and the wave's own longest
 * piece is 44m of road between two corners. The one straight in the whole
 * redrawn half long enough to carry a ramp, a gap and a landing is the DESCENT
 * off the top-right crest -- the drawing gives it 188m -- so the jump is there,
 * deck running (u -280, v -300) down to (u -381, v -235), falling 42m to 32m
 * across it. Measured mid-deck to mid-deck that is 494m from where it was.
 *
 * TWO ALTERNATIVES WERE PRICED AND REJECTED. Leaving the jump on the wave
 * (`boost-wave`, the crest straight) puts it within ~120m of its old ground,
 * but a 120m dead-straight deck plus its run-in and run-out is 208m of road
 * laid through the one crest the fit already struggles to push far enough
 * north -- it makes the worst-fitting 250m of the lap worse, to move a prop
 * scatter. Keeping the old 180m deck and 60m gap does not fit 188m of drawn
 * straight without bending the wave around it, so the deck is 120m with a 46m
 * gap: still a fall across a trench, three quarters the length.
 *
 * WHAT THAT COSTS THE THEME, SAID PLAINLY: `themes/abyssal.ts` scatters its
 * `wreck` prop field on the `trench-jump` tag with a 260m span, so the wrecks
 * follow the tag and nothing needs changing -- but the wreck field now lies on
 * the upper-right descent instead of along the top of the map. Nothing else in
 * the theme keys off it, and the jump still reads as "the trench crossing",
 * because the descent is where the trench is now.
 *
 * TWO BOOST STRIPS, AND THEY EARN THEIR PLACE ON A NUMBER RATHER THAN A FEELING.
 * `boost-wave` sits mid-wave between the swell and the second shelf; `boost-s`
 * sits on the climb out of BLOOM-D into the S. Both new sections are ~950m of
 * continuous cornering in which NO straight exceeds 44m, so without them there
 * is nowhere in either that a following car can use a tow, and a 4km lap with
 * no overtaking spot is a parade.
 *
 * MEASURED AGAIN ON THIS BUILD, by deleting both `boost: true` flags and
 * changing nothing else: respawns go 0.10/race -> 0.40/race over ten seeds
 * (0.3 -> 0.7 on probe-newtrack's three), and the mean lap goes 88.70s ->
 * 87.82s -- slightly QUICKER without them, which is the opposite of what the
 * shipped build measured and is not the point. A pad is `T.boost.padMag` 0.35
 * for 2.60s, and eight cars arriving at the wave's second shelf and the S's
 * first left-hander with that much more separation stop wedging each other into
 * the outside wall. Four times the respawn rate is what they buy, and 0.7 on
 * the probe's seeds is exactly the line this circuit is held to, so the strips
 * are load-bearing, not decoration. Widening the lap did not make them
 * redundant: it made the field faster into the same two pinch points.
 *
 * ===========================================================================
 * 4. ON DIRECTION, AND ON THE BANK SIGN.
 * ===========================================================================
 *
 * The lap is net +360 (right-hand), same as the shipped one, but it is nothing
 * like monotonic: eleven of the thirty corners turn LEFT, holding 383 of the
 * lap's 1126 degrees of steering, and they are not
 * decoration -- the wave is literally a right/left alternation (crest, shelf,
 * swell, shelf) and the top of the S is 208 degrees of continuous left-hander.
 * The previous pass had to manufacture four left-handers by splitting corners
 * net-neutrally, because its shape did not want any; this shape wants them, and
 * that is the difference between a lap that turns both ways and a lap that has
 * been made to.
 *
 * `TrackNode.bank`'s doc comment says "positive banks the left edge up". Built
 * and measured directly (a right-hand corner, bank +15, reading back
 * `sample.right` against the corner's own centre): positive bank raises the
 * OUTSIDE edge of a RIGHT-hand corner, i.e. the doc comment has the sign
 * backwards -- the same bug `rustfall.ts` found. The rule that is actually true
 * of the code: bank of the SAME SIGN as the corner's `deg` banks INTO the turn.
 * Every right-hander below is banked positive and every left-hander negative,
 * for exactly that reason.
 *
 * ===========================================================================
 * 5. THE TAG CONTRACT WAS BROKEN BEFORE THIS PASS. IT IS FIXED BELOW.
 * ===========================================================================
 *
 * `circuit()` records where a tagged SEGMENT starts -- `built.marks`, a plan
 * distance -- and never writes `TrackNode.tag`. `environment.ts`'s `tagSample`
 * reads `track.def.nodes.find(n => n.tag === tag)`. Those are two different
 * things, and the shipped file only ever did the first: measured on the
 * shipped build, `TRACKS_BY_ID['abyssal'].nodes.filter(n => n.tag)` returns
 * ZERO nodes. So `tagSample('bloom')` returned -1, the amber bloom beacons
 * never drew, and both prop clusters (`coral-bank` on `bloom`, `wreck` on
 * `trench-jump`) silently fell back to an even scatter. Nothing errored and
 * nothing looked obviously wrong, which is why it survived a pass.
 *
 * `emberfall.ts` bridges the gap by walking the emitted nodes and taking the
 * one whose cumulative distance is nearest the mark. That method is not good
 * enough HERE, for a reason the spiral creates and which is spelled out at
 * `nodeCount` below; this file counts NODES instead, exactly. Every tag
 * `themes/abyssal.ts` reads is placed on a real node at the bottom of this
 * file, and there is an assertion that throws if it is not.
 *
 * 6. WHAT THE PLAYER IS LOOKING AT -- unchanged from the shipped art pass:
 * everything outside the glass, light shafts from a surface 900m up, schools
 * turning in unison, and the leviathans holding station in the middle distance.
 * The tube is the only lit thing; the ocean is the dark. This file reshapes the
 * road and repairs the tag contract; it does not touch the theme.
 *
 * ===========================================================================
 * 7. THE WIDTH PASS. x2 EVERYWHERE THE TUBE ALLOWS IT.
 * ===========================================================================
 *
 * Vince, with the corkscrew report: "perhaps widening the track in general by
 * 100% would help, this will make the track width wider and allow the user to
 * enter into turns easier and better." Taken literally: every authored `w` on
 * this lap is doubled, and `defaults.w` with them. Widths never enter
 * `circuit()`'s closure walk -- `attr()` writes `n.w` and the position update
 * never reads it -- so this is exactly length-neutral. Plan, closure, straights
 * and baked length are untouched by it.
 *
 * WHERE THAT LANDS ON THE ROSTER, measured as mean FULL width (2 * w) over the
 * emitted nodes, so Vince can see it rather than take it on trust. A snapshot,
 * not a contract -- Zhen-9 was being widened by another pass on the same day:
 *
 *      Meridian Deep   38.5m -> 71.7m   min 38->42, max 51->102
 *      Zhen-9                   55.2m
 *      Ashkar                   48.6m
 *      Halcyon Bay              47.6m
 *      Elkarim                  45.1m
 *      Frosthelm                41.4m
 *      Centurion Prime          40.2m
 *      Namaresh                 38.9m
 *
 * Second-narrowest circuit to widest by 30% over the next one. That is what
 * 100% buys and it is what was asked for.
 *
 * ONE PLACE TOOK LESS THAN DOUBLE, AND IT IS NOT A JUDGEMENT CALL. The
 * CORKSCREW is a road inside a tube of radius 30m. Its road is a flat ribbon
 * lying against the inside of that tube, so its width is bounded by the barrel:
 * at the authored 38m it spans 63% of the 60m bore, and x2 would ask for a 76m
 * road inside a 60m hole -- a road wider than the thing it is supposed to be
 * inside. That alone caps it, and the RENDERER caps it lower and measurably:
 *
 *   `trackMesh.ts` decides the corkscrew is a viaduct (it is level enough at
 *   the mouths and 50m above the seabed) and hangs a cross-head `w * 1.9`
 *   across under each bay, a flat 1.35m below the CENTRELINE. On a deck that is
 *   ROLLING -- measured at the entry mouth, 1.81 deg/m here and 2.69 deg/m at
 *   three turns -- a point 0.95*w out to the side is `0.95 * w * dRoll` higher
 *   than the deck 3m back. That is Namaresh's bug from `buildViaductPiers`' own
 *   note, with roll standing in for bank, and it scales with w. Measured against `tools/probe-solidclear.ts`, holding
 *   everything else at x2:
 *
 *      w 19, 20, 21, 22   CLEAR
 *      w 23   0.64m of cross-head standing in its own road at s=1751m
 *      w 24   0.71m        w 25   0.79m        w 38   1.56m
 *
 *   Diagnosed rather than guessed, at w=25: the structure at
 *   (1041.1, 20.6, 244.6) belongs to the bay at s=1754 (via 0.52) and comes up
 *   1.68m through the deck at s=1751, 23.7m off its centre. Vince's standing
 *   instruction is "do not have any tracks that clip into the track", so this
 *   cannot ship; Zhen-9 hit the same class of failure an hour earlier and
 *   resolved it the same way -- widen the set piece less than the street.
 *
 *   So the corkscrew goes 19 -> 21 (38m -> 42m, x1.11): two metres inside a
 *   cliff that is measured, not estimated, and 70% of the bore instead of 63%.
 *
 * AND THE TWO STRAIGHTS EITHER SIDE OF IT ARE A FUNNEL, SO THEY ARE TAPERED.
 * A 76m road meeting a 42m tube mouth across one 22m node gap is 17m of wall
 * closing at 38 degrees to the direction of travel. The ENTRY straight is
 * therefore authored at w=30 (60m), which splits it into 8m and 9m steps at 18
 * and 22 degrees (measured off the emitted nodes) -- and reads as what it is, a
 * pressure tube's mouth narrowing to take the coil. The EXIT straight is given
 * the same 30 for symmetry and for the art, though it needs it less: a road
 * that OPENS in front of a car is not a wall it can hit. It costs nothing
 * geometric: straights carry no width into closure either.
 *
 * WHAT THE WIDENING DID TO THE RACING, over ten seeds rather than
 * probe-newtrack's three, because one respawn in three races is noise and was
 * read as a regression on the first look: respawns went 0.20/race (shipped) to
 * 0.10/race (this file). The lap got quicker -- mean 92.74s -> 88.70s -- because
 * a wider road is a straighter line through the same corners, and that is
 * comfortably inside the 55-105s band. 24/24 still finish.
 */

/**
 * THE LAP, CORNER BY CORNER. `[kept]` marks a corner carried over from the
 * shipped circuit at its own radius and degrees, because the sketch preserves
 * that stretch of the map. Corner speed is sqrt(1.07 * 34 * R) against a roster
 * top speed of 59-64 m/s.
 *
 *   corner           dir   r     deg   band      v(corner)  note
 *   BLOOM-A          R     64    44    medium    48.3  [kept] first biofilm
 *   TURN-IN          R     72    24    medium    51.2  [kept] onto the crest
 *   CREST            R     82    51    fast      54.6   the top-right crest
 *   [ trench jump: 120m deck, 28 m/s launch, 46m gap, 10m fall ]
 *   SHELF-1a         L    105   -31    fast      61.8   wave, first trough
 *   SHELF-1b         L     66   -59    medium    49.0
 *   SWELL-a          R    100    26    fast      60.3   wave, crest
 *   SWELL-b          R     68    44    medium    49.7
 *   [ boost-wave ]
 *   SHELF-2a         L    112   -20    sweeper   63.8   wave, second trough
 *   SHELF-2b         L     76   -36    medium    52.6
 *   FEATHER          L    150    -9    sweeper   73.9   the kink before the hook
 *   HOOK             R     86    37    fast      55.9   turn-in that tightens
 *   HAIRPIN-1        R     52    58    hairpin   43.5  [kept] into it
 *   BLOOM-B          R     66    42    medium    49.0  [kept] second biofilm
 *   FAST-2           R     95    20    fast      58.8  [kept]
 *   SPIRAL-FEED      R    160     9    sweeper   76.3   sets the corkscrew axis
 *   [ the spiral: r=30, 2 turns, 400m axis -- the sketch's zigzag.
 *     Mouths bake 68.2m and 61.9m; the barrel is a geodesic. See part 2A. ]
 *   BREACH           R    160    14    sweeper   76.3  [kept] crosswind, bounce
 *   COUNTER-2a       R     85    40    fast      55.6  [kept]
 *   COUNTER-2b       L     72   -20    medium    51.2  [kept]
 *   BLOOM-C          R     62    40    medium    47.5  [kept] third biofilm
 *   FAST-4           R     85    18    fast      55.6  [kept]
 *   S-ENTRY-a        R     88    44    fast      56.6   the S begins
 *   BLOOM-D          R     64    70    medium    48.3   fourth biofilm, on the
 *                                                       double-back
 *   [ boost-s ]
 *   S-DRIFT          L    170    -9    sweeper   78.6
 *   S-TOP-a          L    112   -48    sweeper   63.8   208 degrees of left
 *   S-TOP-b          L     82   -70    fast      54.6
 *   S-KNEE           L    130    -9    sweeper   68.8
 *   S-TOP-c          L     90   -72    fast      57.2
 *   S-EXIT-a         R     98    40    fast      59.7   back toward the line
 *   S-EXIT-b         R     76    68    medium    52.6
 *   HAIRPIN-2        R     54    54    hairpin   44.3  [kept*] last brake home
 *
 * THIRTY corners (thirty-four authored arcs -- the four blooms are two arcs
 * each and nothing else is split), against the shipped circuit's seventeen:
 *
 *   hairpin  45-58m    2   (52, 54)
 *   medium   58-80m   10   (62, 64, 64, 66, 66, 68, 72, 72, 76, 76)
 *   fast     80-110m  11   (82, 82, 85, 85, 86, 88, 90, 95, 98, 100, 105)
 *   sweeper 110-220m   7   (112, 112, 130, 150, 160, 160, 170)
 *
 * [kept*] HAIRPIN-2 IS THE ONE PRESERVED CORNER THIS PASS MOVED, from r=50 to
 * r=54, and it is a gate fix rather than a redesign. `Track` bakes a uniform
 * Catmull-Rom, so a corner reads tighter than it is authored when its arc buys
 * few nodes: at r=50 and 54 degrees the arc is 47.1m, which is three nodes at
 * this file's 18m spacing, and the baked centreline reads 44.3m -- under the
 * 45m floor this circuit is held to, and the same 44m the SHIPPED file has
 * always measured for the same corner. r=54 is 50.9m of arc, still three nodes,
 * and reads 48.1m. The 8% of radius bought 9% of read radius for nothing else:
 * the corner is in the same place, turns the same 54 degrees, and the closure
 * absorbed the extra 3.8m of arc without moving any straight by a third of a
 * metre. (Ashkar's header records the same effect at its Summit Hairpin, where
 * the node count flipped between r=56 and r=58 and moved the reading 21%.)
 *
 * Twenty-three right-hand arcs sum to +743 and eleven left-hand arcs to -383.
 * Net +360 -- `circuit()` throws unless the sum is a whole number of turns, and
 * this lap has no crossover, so one turn it is. Total STEERING is 1126 degrees
 * against the shipped circuit's 500, which is the measurement behind "the
 * revised plan wanders".
 */
const SEGS: Seg[] = [
  // ---- the start straight and the top-right, exactly where they were -------
  { t: 'straight', len: 198.5, tag: 'start', toY: 34, tunnel: true },

  // BLOOM-A. r=64m is the loosest of the four biofilm corners -- deliberately
  // the most forgiving introduction to "the surface changes under you". Split
  // metal/oil at a constant radius and bank, an even 22/22, which is what keeps
  // BOTH halves above the ~24m-arc floor a corner segment needs.
  { t: 'corner', r: 64, deg: 22, bank: 6, w: 40, tunnel: true, tag: 'bloom' },
  { t: 'corner', r: 64, deg: 22, bank: 6, w: 42, surface: 'oil', tunnel: true },

  { t: 'straight', len: 95, toY: 38, tunnel: true },
  // TURN-IN. The shipped circuit's old ESSES-IN, kept at r=72/+24: the drawing
  // preserves the lap to this point and then diverges inside the next corner.
  { t: 'corner', r: 72, deg: 24, bank: 6, tunnel: true },

  { t: 'straight', len: 44, toY: 42, tunnel: true },
  // THE CREST. Where the new lap leaves the old one. The shipped circuit went
  // -20 here (into its little esses); the drawing keeps turning right, over the
  // top-right crest and onto the descent. 51 degrees at r=82 is the fast band's
  // tight end -- a committed corner taken at 54.6 m/s, and the highest ground
  // on the lap at 42m.
  { t: 'corner', r: 82, deg: 51, bank: 7, tunnel: true, tag: 'crest' },

  { t: 'straight', len: 44, tunnel: true },
  // THE TRENCH JUMP, on the descent down the right -- see part 3 for why it
  // moved. `jump` is its own segment type: the first 18% of the deck is the
  // ramp (`ramp: 28`, auto-boosted), then 46m of unbarriered road over the gap
  // (`open` auto-set for that span), then the landing. toY drops the far side
  // 10m below the crest, so it is a fall across the trench and not a hop.
  { t: 'jump', len: 120, launch: 28, gap: 46, toY: 32, tag: 'trench-jump' },
  { t: 'straight', len: 44, toY: 28, tunnel: true },

  // ---- THE WAVE. 904m of alternating shelf and swell, from the crest's exit
  // to HAIRPIN-1's entry, replacing the shipped circuit's flat run along the
  // top. Each half of the wave is authored as a PAIR -- an opening arc in the
  // fast or sweeper band and a tightening one in the medium band -- rather than
  // as one long constant-radius bend, because a pair tracks the drawn arc
  // within a few metres where a single tighter arc replacing a 90-degree
  // R=116m drawn bend with an R=70m one cuts 19m inside it at the apex, and
  // because it doubles the corner count for free.
  { t: 'corner', r: 105, deg: -31, bank: -4, tunnel: true, tag: 'shelf' },
  { t: 'straight', len: 44, tunnel: true },
  { t: 'corner', r: 66, deg: -59, bank: -7, tunnel: true },

  { t: 'straight', len: 44, toY: 26, tunnel: true },
  { t: 'corner', r: 100, deg: 26, bank: 4, tunnel: true, tag: 'swell' },
  { t: 'straight', len: 44, tunnel: true },
  { t: 'corner', r: 68, deg: 44, bank: 7, tunnel: true },

  // BOOST-WAVE. Mid-wave, on the only piece of the section that points
  // anywhere for long enough to be a tow. See part 3.
  { t: 'straight', len: 44, boost: true, toY: 30, tunnel: true, tag: 'boost-wave' },

  { t: 'corner', r: 112, deg: -20, bank: -3, tunnel: true },
  { t: 'straight', len: 44, tunnel: true },
  { t: 'corner', r: 76, deg: -36, bank: -6, tunnel: true },

  { t: 'straight', len: 44, toY: 28, tunnel: true },
  // FEATHER. A 9-degree sweeper-band left, which is the drawing's own -8.4 in
  // the run up to the top-left hook. It is here rather than folded into its
  // neighbours because at r=150 its arc is 23.6m -- over twice `circuit.ts`'s
  // kink floor -- so it is a real corner the AI reads, and because a lap that
  // spends 900m alternating hard left and hard right needs one place where the
  // road only breathes.
  { t: 'corner', r: 150, deg: -9, bank: -2, tunnel: true },
  { t: 'straight', len: 44, tunnel: true },

  // THE HOOK INTO HAIRPIN-1. The drawing reads this whole corner as +114 where
  // the shipped circuit turns +58, and the extra is geometry rather than a
  // redraw: the wave arrives at the top-left climbing north-west, the shipped
  // lap arrived running due west, and both leave heading south down the left
  // flank. So a fast-band turn-in was added AHEAD of the shipped hairpin rather
  // than the hairpin being opened up. It is a double-apex that tightens, which
  // is a harder corner than either half and the right thing at the end of 900m
  // of wandering.
  //
  // WHAT IT COSTS: HAIRPIN-1 NO LONGER HAS ITS 170m BRAKING ZONE. The shipped
  // circuit fed it off the jump's landing runway; the drawing puts a corner
  // there instead. The hook is the braking zone now -- 57m of arc at 55.9 m/s
  // falling to the hairpin's 43.5 -- which is a corner-entry brake rather than
  // a straight-line one. Flagged rather than fixed: fixing it means opening the
  // top-left hook out until it stops being the shape Vince drew.
  { t: 'corner', r: 86, deg: 37, bank: 6, tunnel: true, tag: 'hook' },
  // HAIRPIN-1 [kept]. 52m -- 43.5 m/s. WIDER than the rest of the circuit
  // (50m against a 38m default) for the reason the brief calls out: a tight
  // radius arriving off a fast run needs room for a car that turns in a little
  // hot to still find the apex rather than the wall. Bank +11, the most
  // aggressive on the lap.
  { t: 'corner', r: 52, deg: 58, bank: 11, w: 50, tunnel: true, tag: 'hairpin-1' },

  // ---- the left flank: preserved, and the spiral inside it -----------------
  { t: 'straight', len: 55, toY: 24, tunnel: true },
  // BLOOM-B [kept]. 66m, same two-piece construction as BLOOM-A, split 21/21.
  { t: 'corner', r: 66, deg: 21, bank: 6, w: 40, tunnel: true, tag: 'bloom-b' },
  { t: 'corner', r: 66, deg: 21, bank: 6, w: 42, surface: 'oil', tunnel: true },

  { t: 'straight', len: 44, toY: 22, tunnel: true },
  { t: 'corner', r: 95, deg: 20, bank: 4, tunnel: true },

  { t: 'straight', len: 44, toY: 18, tunnel: true },
  // SPIRAL-FEED. A sweeper-band right that aims the corkscrew's axis. The
  // shipped circuit reached the spiral off a plain straight; the drawing has
  // ~10 degrees of turn in the approach, and putting it in a 160m corner rather
  // than bending the straight keeps the axis dead straight where it matters.
  { t: 'corner', r: 160, deg: 9, bank: 2, tunnel: true },
  // The tube mouth. w=30 (60m) rather than the doubled 38, so the road steps
  // 76 -> 60 -> 42 into the corkscrew instead of 76 -> 42 across one node gap.
  // Part 7 has the wall angles.
  { t: 'straight', len: 44, w: 30, toY: 14, tunnel: true },
  // THE SPIRAL. r=30, TWO full turns over a 400m axis, descending into the
  // deepest, darkest point of the lap at 10m. `turns: 2` is a whole number,
  // which is what keeps the entry and exit seams flush with the flat road on
  // either side -- at f=0 and f=1 the coil's `up` is exactly world +Y. It was
  // three, and three put 34.8 degrees of roll on every emitted node, which is
  // what made the mouths bake at 39.8m and what Vince hit as "impossible to
  // enter into smoothly"; two bakes them at 68.2m and 61.9m and changes no
  // other number in the file. See part 2A for the sweeps, and part 0 for what
  // it costs the plan zigzag.
  //
  // w=21 rather than the doubled 38: a 76m road does not fit inside a 60m
  // bore, and `trackMesh.ts`'s viaduct cross-head starts standing in this road
  // at w=23. Part 7 has the measurement.
  { t: 'cyclone', r: 30, turns: 2, len: 400, w: 21, toY: 10, tunnel: true, tag: 'spiral' },

  // THE BREACH [kept]. The tube is open here -- no `tunnel` on this straight or
  // the corner after it, which is the visual the art pass wants at exactly the
  // spot the sim also stops pretending the tube is sealed. 160m sweeper taken
  // flat out, 15 m/s^2 of lateral push, BOUNCE walls throughout and never
  // `open`. +3m of width over the default for a car that is being shoved.
  // The far mouth, tapered the same way: 42 -> 60 -> 82 out into the breach.
  { t: 'straight', len: 44, w: 30 },
  { t: 'corner', r: 160, deg: 14, bank: 2, w: 41, wind: 15, bounce: true, tag: 'breach' },

  { t: 'straight', len: 92.7, toY: 14, tunnel: true },
  // COUNTER-2 [kept]. A right/left pair, net +20, right after the breach lets
  // go -- fast into medium, so it bites a little harder on the way out.
  { t: 'corner', r: 85, deg: 40, bank: 4, tunnel: true },
  { t: 'straight', len: 44, tunnel: true },
  { t: 'corner', r: 72, deg: -20, bank: -6, tunnel: true },

  { t: 'straight', len: 80, toY: 18, tunnel: true },
  // BLOOM-C [kept]. 62m -- the tightest of the four biofilm radii, and third of
  // four: by this point a driver has met the mechanic twice, so the tightest
  // dose comes when they know what it is. Split 20/20, right at the arc floor.
  { t: 'corner', r: 62, deg: 20, bank: 6, w: 40, tunnel: true, tag: 'bloom-c' },
  { t: 'corner', r: 62, deg: 20, bank: 6, w: 42, surface: 'oil', tunnel: true },

  { t: 'straight', len: 55, toY: 22, tunnel: true },
  { t: 'corner', r: 85, deg: 18, bank: 4, tunnel: true },

  // ---- THE S. 953m of road through the bottom middle, against the 370m the
  // shipped lap spent sweeping round the same ground. The single biggest thing
  // the sketch adds, and about 60% of the lap's growth.
  { t: 'straight', len: 44, tunnel: true },
  // S-ENTRY-a. Fast band, the first half of the 114-degree turn that stops the
  // lap running east along the bottom.
  { t: 'corner', r: 88, deg: 44, bank: 5, tunnel: true, tag: 's-entry' },
  { t: 'straight', len: 44, tunnel: true },
  // BLOOM-D, the second half of the same turn and the brief's hazard at the
  // double-back. r=64 matches BLOOM-A exactly; split 35/35 metal then oil,
  // which at this radius is 39.1m of arc each -- the most comfortable margin
  // over the floor of any bloom on the lap, and 70 degrees of biofilm corner
  // against BLOOM-A's 44. See part 1 for why the hazard is here and not at the
  // S's apex.
  { t: 'corner', r: 64, deg: 35, bank: 7, w: 40, tunnel: true, tag: 'bloom-d' },
  { t: 'corner', r: 64, deg: 35, bank: 7, w: 42, surface: 'oil', tunnel: true },

  // BOOST-S. On the climb out of BLOOM-D, which is the one moment in the S
  // where the road points somewhere for longer than a corner. See part 3.
  { t: 'straight', len: 44, boost: true, toY: 28, tunnel: true, tag: 'boost-s' },

  // THE TOP OF THE S: 208 degrees of continuous left-hander in five arcs at
  // five different radii (170, 112, 82, 130, 90), with 44m of road between
  // them. Five rather than one because a single 208-degree arc is a hairpin
  // the drawing does not draw: measured off the traced right panel the loop is
  // 305m across, which is a ~150m effective radius, and the only way to be
  // that wide AND still have corners a driver can drift is to build the arc
  // out of sweepers and fast corners in alternation.
  { t: 'corner', r: 170, deg: -9, bank: -2, tunnel: true },
  { t: 'straight', len: 44, toY: 32, tunnel: true },
  { t: 'corner', r: 112, deg: -48, bank: -5, tunnel: true, tag: 's-top' },
  { t: 'straight', len: 44, tunnel: true },
  { t: 'corner', r: 82, deg: -70, bank: -7, tunnel: true },
  { t: 'straight', len: 44, toY: 34, tunnel: true },
  { t: 'corner', r: 130, deg: -9, bank: -3, tunnel: true },
  { t: 'straight', len: 44, tunnel: true },
  // S-TOP-c. 72 degrees at r=90 -- 113m of arc, the longest single corner on
  // the circuit, and the point where the road is running back the way it came.
  // The S is the only place on the lap where two distant stretches face each
  // other at all, and they do it with room to spare: see the self-clearance
  // line in the measured note at the bottom.
  { t: 'corner', r: 90, deg: -72, bank: -6, tunnel: true },

  { t: 'straight', len: 44, toY: 30, tunnel: true },
  // S-EXIT. The unwind back toward the start line, fast into medium.
  { t: 'corner', r: 98, deg: 40, bank: 5, tunnel: true, tag: 's-exit' },
  { t: 'straight', len: 44, tunnel: true },
  { t: 'corner', r: 76, deg: 68, bank: 7, tunnel: true },

  // 101m of braking zone into the last corner. The shipped circuit gave
  // HAIRPIN-2 206m; the drawing puts S-EXIT-b's exit about a hundred metres
  // from the corner and that is the number the shape allows. 101m from 52.6
  // m/s to 44.3 is a comfortable brake -- unlike HAIRPIN-1's hook above, this
  // one is not a compromise, because S-EXIT-b has already taken the speed out.
  { t: 'straight', len: 101.4, toY: 30, tunnel: true },
  // HAIRPIN-2. 54m -- 44.3 m/s, the last thing before the line. Carried over
  // from the shipped circuit at 50m and opened to 54 so it BAKES at 48.1m
  // rather than 44.3m; see [kept*] in the corner table for the node-count
  // reason. Widened and banked like HAIRPIN-1: the tightest radius gets the
  // most margin, not the least -- 102m of road at x2, the widest thing on the
  // roster and deliberately so.
  { t: 'corner', r: 54, deg: 54, bank: 11, w: 51, tunnel: true, tag: 'hairpin-2' },
]

/**
 * Closing this lap needs no site scaling (`scale` comes back 1.000) and
 * `circuit()`'s own minimum-norm correction moves no straight by more than a
 * tenth of a metre, because the straight lengths above are the SOLVED ones --
 * see "HOW THE SEGMENT LIST WAS SOLVED" in the header. Change one number and
 * the builder will quietly reshape the other thirty to compensate.
 *
 * SPACING IS 18m, NOT THE 24m THE API EXAMPLE SUGGESTS, and it is a measured
 * choice carried over from the shipped file. The chord-ratio gate reads the
 * straight-line distance between consecutive AUTHORED nodes; a `corner`
 * segment's node count is `max(1, ceil(deg/30), round(arc/spacing))`. At
 * spacing 18 every authored segment on this lap emits chords between 15.1m and
 * 26.7m -- a ratio of 1.77 before the spiral and the jump add their own, and
 * 2.08 (12.9-26.7m) once they do -- so there is real headroom under the gate.
 */
const CIRCUIT = circuit(SEGS, {
  spacing: 18,
  start: [0, 30, 0],
  heading: 0,
  defaults: { w: 38, surface: 'metal' },
  minStraight: 40,
})

const nodes: TrackNode[] = CIRCUIT.nodes

/**
 * WHERE EACH TAG GOES, AND WHY IT IS COUNTED IN NODES RATHER THAN METRES.
 *
 * `circuit()` records only a plan DISTANCE per tagged segment
 * (`built.marks`); `environment.ts`'s `tagSample` looks for a NODE carrying the
 * tag. See part 5 of the header for the bug that gap caused on the shipped
 * file. `emberfall.ts` bridges it by walking the nodes and taking the one whose
 * cumulative 3-D distance is nearest the mark.
 *
 * THAT METHOD IS WRONG ON THIS CIRCUIT, and the spiral is why. `walk()` adds
 * `len` to `dist` for a cyclone -- 400m -- but the road it emits is a helix. A
 * constant-radius one would run `len * sqrt(1 + (2*pi*r*turns/len)^2)` = 550m;
 * this one ramps its radius to zero over the outer 35% at each mouth, and the
 * emitted nodes measure 508m. Either way, plan distance and node distance run
 * at 1:1 for 3456m of this lap and at 1:1.27 for 400m of it, and no single
 * scale factor maps between them. Measured on the first build that tried it:
 * the `breach` tag landed 86m before the breach and every tag after it was
 * early by more.
 *
 * So the mapping is done in NODES, exactly. `walk()`'s step count per segment
 * is deterministic and stated below; summing it gives each tagged segment's
 * first node index with no distance arithmetic anywhere. The assertion that the
 * total matches `CIRCUIT.nodes.length` is what keeps this honest if
 * `circuit.ts` ever changes the rule.
 */
function nodeCount(seg: Seg, straightLen: number): number {
  const SPACING = 18
  if (seg.t === 'straight') return Math.max(1, Math.round(straightLen / SPACING))
  if (seg.t === 'jump') return Math.max(1, Math.round(seg.len / SPACING))
  if (seg.t === 'cyclone') return Math.max(1, Math.round(seg.len / 13))
  if (seg.t === 'loop') return Math.max(14, Math.round((2 * Math.PI * seg.r) / 18)) + 1
  const arc = Math.abs(seg.deg) * (Math.PI / 180) * seg.r
  return Math.max(1, Math.ceil(Math.abs(seg.deg) / 30), Math.round(arc / SPACING))
}
const tagNode: Record<string, number> = {}
{
  let idx = 0, si = 0
  for (const seg of SEGS) {
    if (seg.tag) tagNode[seg.tag] = idx
    idx += nodeCount(seg, seg.t === 'straight' ? CIRCUIT.straights[si++] : 0)
  }
  if (idx !== nodes.length) {
    throw new Error(
      `Meridian Deep: the node-count replica says ${idx} nodes and circuit() emitted ` +
      `${nodes.length}. walk()'s step rule changed -- fix nodeCount() above before trusting any tag.`,
    )
  }
}
for (const tag of Object.keys(tagNode)) nodes[tagNode[tag]].tag = tag
nodes[0].tag = 'start'

/**
 * THE TAGS `themes/abyssal.ts` ACTUALLY READS, asserted rather than assumed.
 * `bloom` drives the amber beacon run in `landmarks()` AND the `coral-bank`
 * prop cluster; `trench-jump` drives the `wreck` cluster. The theme's other
 * pair, `cathedral` / `cathedral-apex`, is deliberately absent -- this circuit
 * has no loop (part 2) and the theme skips the dome rig cleanly without them.
 */
for (const required of ['bloom', 'trench-jump']) {
  if (!nodes.some((n) => n.tag === required)) {
    throw new Error(`Meridian Deep: themes/abyssal.ts reads the '${required}' tag and no node carries it`)
  }
}

/**
 * Cumulative 3-D distance along the emitted nodes, used to turn a tag into the
 * LAP FRACTION `race.ts` wants: `itemBoxRows[].at` and `chargeRuns[].from/to`
 * are multiplied by `track.length`, the BAKED length, so a plan fraction
 * (`marks[tag] / CIRCUIT.length`, which is what the other circuit-built tracks
 * use) puts every pickup after the spiral about 4% of a lap early. The node
 * polyline measures 3963.1m against the baked spline's 3967.9m -- 0.12% short,
 * which is well inside a pickup row's own spread.
 */
const cum: number[] = [0]
for (let i = 1; i < nodes.length; i++) {
  const a = nodes[i - 1].p, b = nodes[i].p
  cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]))
}
const LAP = cum[cum.length - 1] + Math.hypot(
  nodes[0].p[0] - nodes[nodes.length - 1].p[0],
  nodes[0].p[1] - nodes[nodes.length - 1].p[1],
  nodes[0].p[2] - nodes[nodes.length - 1].p[2],
)

/** Lap fraction where a tagged segment starts, measured along the road. */
const frac = (tag: string) => cum[tagNode[tag]] / LAP

/**
 * MEASURED against this exact file. The `->` numbers are the shipped build
 * (turns=3, w x1) against this one (turns=2, w x2 outside the tube).
 *
 * `tools/probe-newtrack.ts --track=abyssal`
 *   plan length 3856.5m (unchanged), BAKED 4034m -> 3968m, 209 nodes,
 *     2689 -> 2645 samples, 1.500126 -> 1.500143 m/sample. Both sides of the
 *     baked-length cliff are above 1.5, so `curvatureAt`'s window holds the
 *     same sample count and no radius on the lap moved for that reason.
 *     `src/score/verify.ts`'s TRACK_LENGTH needs 3967.9 for `abyssal`; this
 *     file does not own that table and has not touched it.
 *   gap 0.0000m, scale 1.000 -- no site inflation, correction <= 0.31m
 *   chord 12.9-26.7m, ratio 2.07 -> 2.08                (gate: < 3.5, brief < 3.0)
 *   52% -> 51% of the lap reads as curved (|k| > 0.0045) (gate: >= 12%)
 *   curved-sample radius bands: <45m 0.6% -> 0.0%, hairpin 7.9% -> 5.6%,
 *     medium 19.1% -> 25.2%, fast 32.3% -> 36.2%, sweeper 39.1% -> 32.5%,
 *     >220m 1.0% -> 0.4%. Medium+fast -- the 58-110m band the brief calls the
 *     heart of a lap -- is 61.4% here against 51.4% shipped. Opening the
 *     corkscrew's mouths moved the whole set piece out of the sub-45 and
 *     sweeper slices and into the medium and fast ones.
 *   tightest read radius 40m -> 47m, median 94m (unchanged). The tightest
 *     thing on the lap is now an AUTHORED corner, HAIRPIN-1.
 *   24/24 racers finish, three fixed seeds x eight racers
 *   lap time: best 85.28 -> 81.12s, mean 92.74 -> 88.70s, worst
 *     102.82 -> 97.18s                                  (gate: mean 55-105s)
 *   0.0 -> 0.3 respawns/race on the probe's three seeds, 0.0% off-track.
 *     Over TEN seeds, which is the honest sample: 0.20 -> 0.10 respawns/race.
 *     The single event on seed 2029 is at s=3791m, in the S's exit, not at the
 *     corkscrew or at either taper.                     (gate: <= 3.0/race)
 *   elevation 10m to 72m -> 10m to 65m. The lap's high point is the top of the
 *     corkscrew, and at two turns the top-of-barrel moments fall at f=0.25 and
 *     0.75, where the radius ramp is only 80% in; at three they fell at f=0.5,
 *     with the tube at full radius. The coil tops out at 64.7m, not 70.7m.
 *
 * MOUTH CURVATURE, `curvatureAt(s, 20)` on a 0.25m sweep, which is the only
 *   instrument that sees this -- probe-newtrack's 1.5m grid reported the exit
 *   mouth as 40m and missed the entry ramp entirely:
 *      entry mouth   59.3m -> 68.2m    (s=1767)
 *      barrel       203.6m -> 228.4m  the geodesic middle (its outer 30% each
 *                                      way is ramp); zone max 434m -> 521m
 *      exit mouth    39.8m -> 61.9m    (s=2191 -> s=2211)
 *   Nothing on the lap now reads under 45m. Every corner this file authors
 *   bakes at 47.5m or wider: HAIRPIN-1 (r=52) reads 47.5, HAIRPIN-2 (r=54)
 *   reads 48.1, and the next tightest is 51.3.
 *
 * `tools/probe-selfclear.ts`  closest the road comes to itself: infinite ->
 *   21.7m, between s=1365m and s=1437m, 72m apart along the lap. That is the
 *   hook and HAIRPIN-1 doubling back past each other, and the number fell only
 *   because both ribbons are twice as wide; the floor is 2.0m, so it is still
 *   a ten-fold margin. The corkscrew is no longer the closest pair on the lap.
 * `tools/probe-solidclear.ts` CLEAR; no part of the lap comes within 8m (its
 *   own reporting floor) of another part's road, and the viaduct substructure
 *   is clear. It is NOT clear at a corkscrew wider than w=22 -- see part 7,
 *   which is the one place the x2 could not be applied.
 * `tools/probe-intrude.ts` 0 intruding pieces.
 * SELF-CLEARANCE MEASURED DIRECTLY on the baked ribbons in 3-space, by lap
 *   separation: 67.5m at 150m+ apart, 78.1m at 250m+ and at 400m+. The 78.1m
 *   pair is the wave against the top of the S (s=740 vs s=3398). There is no
 *   flyover, no crossover (`built.crossovers.length === 0`) and nothing on this
 *   lap within an order of magnitude of the 9m floor.
 *
 * TAG AUDIT, because widening a lap is exactly how a tag silently moves. Every
 *   one of the nineteen tags below is placed by `nodeCount()` accumulating
 *   `walk()`'s step rule over the segment list IN ORDER. Not one is derived
 *   from a width, from a narrowest- or widest-node search, or from a plan
 *   distance -- so neither the x2 nor the `turns` change can move one, and the
 *   node indices are bit-identical across this pass: 0, 11, 22, 28, 37, 48, 56,
 *   70, 73, 79, 90, 123, 140, 148, 154, 158, 163, 189, 206. The assertion above
 *   still binds if `circuit.ts` ever changes that rule, and `bloom` and
 *   `trench-jump` -- the two `themes/abyssal.ts` reads -- are still asserted
 *   present. What DOES move is each tag's lap FRACTION after the spiral, by
 *   about 1.5%, because the coil is 63m of road shorter; that is `frac()`
 *   tracking the road, which is the whole reason the pickups are derived from
 *   tags instead of written as constants.
 */
export const ABYSSAL: TrackDef = {
  id: 'abyssal',
  name: 'Meridian Deep',
  skyTop: 0x01060f,
  skyBottom: 0x063b55,
  fogColor: 0x042c41,
  fogDensity: 0.0072,
  sunColor: 0x9fd8ee,
  sunIntensity: 0.78,
  ambientColor: 0x0a3a52,
  ambientIntensity: 0.95,
  // The light comes from a surface 900m up and slightly behind: near-vertical,
  // which is what makes the shafts read as shafts.
  sunDirection: [0.14, 0.96, 0.24],
  palette: { a: 0x10323f, b: 0x1d6b7a, c: 0x37b0b4, accent: 0x54f0d0 },
  nodes,
  /**
   * Rows sit ON the driven line: `stepAI` has no item-seeking term, so a row
   * taken off the line is a row the AI never touches. Every position is derived
   * from a TAG through `frac()` rather than written as a constant, so a later
   * reshape moves the pickups with the road instead of leaving them behind --
   * which is exactly what the shipped file's hand-written fractions would have
   * done to this pass. The row at `frac('spiral') + 0.03` is deliberately
   * INSIDE the corkscrew: `surfacePoint` carries the roll and `race.ts` lifts
   * each box along the sample normal, so a rolled box sits 1.5m off the deck
   * the same as a flat one (Ashkar puts rows inside both its Cinder Loops on
   * the same reasoning).
   */
  itemBoxRows: [
    { at: (frac('start') + frac('bloom')) / 2, count: 5, spread: 4.2 },
    { at: frac('crest') + 0.01, count: 4, spread: 4.0 },
    { at: frac('swell') + 0.01, count: 5, spread: 4.2 },
    { at: frac('hairpin-1') + 0.02, count: 4, spread: 4.4 },
    { at: frac('spiral') + 0.03, count: 5, spread: 4.2 },
    { at: frac('bloom-c') - 0.01, count: 4, spread: 4.0 },
    { at: frac('s-top') + 0.015, count: 5, spread: 4.4 },
    { at: frac('s-exit') + 0.01, count: 4, spread: 4.0 },
  ],
  chargeRuns: [
    { from: frac('start') + 0.005, to: frac('bloom') - 0.005, count: 6, lateral: -5 },
    { from: frac('shelf') + 0.01, to: frac('swell') - 0.01, count: 6, lateral: 4 },
    { from: frac('boost-wave') + 0.004, to: frac('hook') - 0.01, count: 6, lateral: 0 },
    { from: frac('bloom-b') + 0.01, to: frac('spiral') - 0.005, count: 5, lateral: -4 },
    { from: frac('breach') + 0.005, to: frac('bloom-c') - 0.01, count: 6, lateral: 5 },
    { from: frac('s-entry') + 0.01, to: frac('s-top') - 0.01, count: 6, lateral: 0 },
    { from: frac('s-exit') + 0.005, to: frac('hairpin-2') - 0.008, count: 5, lateral: -5 },
  ],
  laps: 3,
}
