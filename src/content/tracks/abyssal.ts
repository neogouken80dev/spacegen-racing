import type { TrackDef } from '../../sim/track'
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
 * ---------------------------------------------------------------------------
 * 0. THIS IS A REWRITE, NOT A RETUNE, AND HERE IS WHY.
 *
 * The previous Meridian Deep was drawn from a k1+k2 harmonic ring, same as
 * Emberfall, Halcyon Bay and Ashkar (now Zhen-9) -- one long ellipse with a
 * second harmonic to taper the ends into something that read, on paper, as
 * "two hairpin ends and two very long flanks." Player feedback on the whole
 * family of four was blunt: "the overall oval or square-ish type design does
 * not offer a lot of variety... the few turns are far too sharp to allow
 * smooth drifts." Measured, that track had a median radius of 113-140m (flat
 * out) and a single 45m corner sprung on the driver with no warning. That is
 * not a difficulty problem, it is a STRUCTURE problem -- a sum of harmonics has
 * no braking zones and no chosen radii, it has whatever the coefficients imply
 * -- and no amount of re-tuning grip or width fixes a structural problem.
 *
 * So this is authored on `circuit.ts` instead: a straight, a braking zone, a
 * corner of a CHOSEN radius, an exit, repeat. Corner speed at this grip model
 * (`T.grip.lateralAccel` 34, roster gripCoeff ~1.07) is sqrt(1.07*34*R)
 * against a roster top speed of 59-64 m/s:
 *
 *      50m   42.7 m/s   67% of top     hairpin, heavy braking
 *      65m   48.6 m/s   77%            medium -- the corner you actually drift
 *      90m   57.2 m/s   90%            fast -- a lift and a commitment
 *     150m   73.9 m/s  >100%           sweeper, flat out, still reads as a
 *                                      corner to the AI (gate R<222m)
 *
 * Twelve corners below, radii from 50m to 160m, most of them in the 58-110m
 * band that is the heart of a lap: two hairpins, three medium biofilm corners
 * (part 1), one esses complex and three standalone counter-curves (part 4 --
 * this is the pass that gave the lap real directional variety), a set-piece
 * spiral, and the breach. Every one of them is a chosen number with a reason
 * next to it, not a Fourier coefficient.
 *
 * ---------------------------------------------------------------------------
 * 1. THE BIOFILM IS THE TRACK.
 *
 * `oil` is grip 0.30 -- lower than ice (0.45) and less than a third of tarmac
 * (0.95, this track's own default). Elkarim has a little of it and it is a
 * hazard you avoid. Here it is a FEATURE of the route: the tube leaks, and
 * where it leaks things grow, so a bloom patch sits on the racing line through
 * three of the lap's corners rather than off it.
 *
 * Every bloom corner is authored as TWO consecutive `corner` segments at the
 * SAME radius and the SAME bank -- metal, then oil -- so the geometry is one
 * continuous arc and only the surface changes underfoot. That gives the
 * patch a real ramp rather than a step (Track.ts snaps `surface` at the
 * midpoint between nodes, so at this file's 18m spacing the transition reads
 * as a fade across one node gap, not a wall you hit mid-corner) without
 * needing a second interpolated field. An earlier draft used three pieces
 * (metal/oil/metal, a ramp out as well as in) and it is why that draft does
 * not survive: three pieces at these degree budgets put at least one arc
 * under 20m, which is well below what a corner segment needs to avoid the
 * chord-ratio problem documented at `CIRCUIT` below. Two pieces is what a
 * ~40-44 degree corner can afford; the fade-out on exit still happens, it
 * just happens at the boundary with the next segment instead of inside this
 * one.
 *
 * AND CRUCIALLY every one of the three blooms sits on a corner radius of
 * 62-66m -- medium band, already 47-49 m/s before the oil touches it, well
 * under the 58-70m ceiling this circuit was briefed to hit. 0.30 grip is
 * survivable at that speed and is not survivable at the 76+ m/s this
 * circuit's sweepers and counter-curve entries run flat out. So a bloom
 * PUNISHES a driver who carried hairpin speed or fast-corner speed into a
 * corner that only wanted medium speed, and COSTS A TIDY DRIVER ALMOST
 * NOTHING -- the same asymmetry Elkarim measured for its own oil at 0.108s a
 * lap when it sat somewhere with no corner slow enough to bind it. Here it is
 * placed exactly where it binds.
 *
 * 2. THE SPIRAL IS THE SET PIECE, AND IT IS ALONE.
 *
 * The four circuits now divide the set pieces between them rather than each
 * carrying one of everything: Halcyon Bay takes the loops, Zhen-9 one of each,
 * and Meridian Deep is the SPIRAL track -- one continuous three-turn corkscrew
 * and nothing else set-piece-shaped. NO LOOP on this circuit, by design, so
 * this file never emits a `cathedral` / `cathedral-apex` tag pair; the theme's
 * `landmarks()` looks for both and skips the whole dome-lighting rig cleanly
 * when either is missing, which is exactly what we want here.
 *
 * A road inside a cylinder can climb its walls, and every node the corkscrew
 * authors an `up` off world-vertical for gets `stick` defaulted to 1 by
 * Track.ts, so a car that gets light over a seam falls back toward the road it
 * left rather than into the glass.
 *
 * TWO DIFFERENT THINGS ARE BOTH TRUE OF A HELIX HERE, AND ONLY ONE OF THEM IS
 * "dead straight." `circuit()`'s own plan/closure heading does not turn at
 * all through a cyclone segment -- it rides a straight axis and coils around
 * it, which is why the spiral consumes none of the +/-360 degree budget in
 * part 4 and needs no `deg` accounting. But the BAKED road is a real 3-D
 * curve, and `Track.curvatureAt` -- what the AI's braking logic actually
 * reads -- measures curvature about the surface normal precisely so a road
 * that climbs is not misjudged as flat (see its own comment on the gravity
 * branch). Measured on this build, the spiral reads as a sustained ~40-45m
 * radius at its tightest, matching the textbook helix-curvature formula
 * R/(R^2+(pitch/2*pi)^2) for r=30m and a ~133m pitch almost exactly. That is
 * tighter than either hairpin.
 *
 * This is not a bug and it was not fought: it is why the AI is measured
 * taking the spiral carefully rather than flat out (see the lap-time note by
 * `CIRCUIT` below), which is the correct thing for a three-turn corkscrew to
 * do and exactly how a driver would read it on sight -- nobody needs a HUD
 * warning to know a corkscrew is not a straight.
 *
 * `turns: 3` is still a whole number for the reason the builder's rule
 * states. At f=0 and f=1 the coil's own `up` vector is exactly world +Y (the
 * ramp factor takes the effective radius to zero at both mouths, and
 * sin(2*pi*turns) is exactly zero for an integer `turns`), so the corkscrew's
 * entry and exit seams match the flat road on either side with no discontinuity
 * to throw a light car off-line. A fractional `turns` would leave that seam
 * open and hand back "the road exits inverted."
 *
 * 3. THE BREACH.
 *
 * One span where the tube is cracked and the sea is coming through: a lateral
 * current (`wind`, a flat 15 m/s^2 across the one corner it authors on) against
 * BOUNCE walls, never open ones. Ashkar paid for the other choice at 16.3
 * respawns a race -- a crosswind over unbarriered road is not difficulty, it
 * is a loading screen. The breach sits on a 160m sweeper, which this
 * circuit's cars take flat out (76.3 m/s corner-speed ceiling against a
 * 59-64 m/s top speed -- the corner itself asks nothing of you), so the
 * current's job is not to slow you down, it is to push you toward a wall you
 * are now allowed to lean on. Since contact no longer ends a drift, that is a
 * corner you can commit to rather than one you survive.
 *
 * 4. ON DIRECTION: A MONOTONIC LAP PASSED EVERY GATE AND WAS STILL WRONG.
 *
 * The first working draft of this circuit turned right on all twelve corners,
 * angles summing to exactly +360. It passed every gate cleanly -- gap 0.000m,
 * scale 1.00, chord ratio 3.09, 0.0 respawns/race, mean lap 69.73s -- and it
 * was still a mistake, because plotted against the other seven circuits a lap
 * that only ever turns one way reads as a large simple polygon rather than a
 * racetrack. That is the exact "does not offer a lot of variety" complaint
 * that started this whole rewrite, reproduced one level up.
 *
 * Getting genuine left-handers back in without breaking closure took two
 * attempts, and the difference between them is worth recording precisely,
 * because the failure mode is easy to misdiagnose as "mixing directions is
 * unsafe" when the real cause is narrower than that.
 *
 * ATTEMPT ONE, WHICH FAILED: pick four corners, inflate their right-hand
 * angles to make room, and drop a left into each (four rights at 54/48/48/46
 * degrees instead of the monotonic draft's 22/16/20/12, four lefts at
 * 20-24). Angles still summed to +360. It still failed closure, at every
 * site scale tried, with one particular straight going from 32m to -28m as
 * the uniform straight-length guess grew from 80 to 160 -- worse with a
 * BIGGER site, the opposite of what scaling is supposed to do. Diagnosed by
 * hand: the four inflated rights bunched SEVEN of the lap's sixteen straight
 * headings into one 80-degree arc of the compass (182 to 262 degrees)
 * instead of spreading them the way the monotonic draft's smaller, more
 * numerous turns had. With most of the lap's straight-line length aimed the
 * same general way, even the UNCORRECTED shape (before `circuit()`'s own
 * closure math touches it) missed closing by hundreds of metres, so the
 * minimum-norm correction it computed was itself enormous -- and that
 * correction scales with the site's overall size, landing hardest on
 * whichever single straight's own heading happened to be most nearly
 * opposite to it. Growing the site made the correction grow to match,
 * which is why the failing straight got WORSE, not better, as the uniform
 * length guess increased. Mixing left and right was never the problem;
 * clustering the straight headings by using a few large compensating turns
 * was.
 *
 * ATTEMPT TWO, WHICH WORKED: leave the monotonic draft's PROVEN checkpoint
 * headings -- the cumulative heading right after each of its twelve corners
 * -- completely alone, and get every new left by splitting a single flexible
 * corner into a small right/left/right (or right/left) group whose net
 * degree total EXACTLY matches the corner it replaces. FAST-1's old +22
 * becomes an esses of +24/-20/+18 (net +22, unchanged). SWEEPER-1's old +16
 * becomes a counter-curve of +36/-20 (net +16, unchanged). Same trick at the
 * old FAST-3 and SWEEPER-3. Because every checkpoint heading downstream of
 * every split is bit-for-bit what it was in a sequence already proven to
 * close at gap 0.000m with zero correction, the correction this design needs
 * is ALSO essentially zero, independent of which way the new sub-corners
 * turn -- confirmed empirically (gap 0.0000m, scale 1.000, across a sweep of
 * site sizes) before a single line of this went near the real file.
 *
 * That trick is free with respect to CLOSURE, but not with respect to
 * LENGTH: reversing direction by L degrees and then un-reversing it costs
 * 2*L degrees of extra steering somewhere, converted to metres of extra arc
 * at whatever radius it happens at, plus a short connecting straight (held
 * at the 40m floor plus a working margin) for every new reversal. Four
 * 20-degree reversals bolted straight onto the monotonic file's original
 * straight lengths measured out at +705m of plan length -- 24% over the
 * 2976.6m the monotonic draft closed at, which was not going to hold inside
 * the 55-75s lap-time band this circuit is tuned for. Paid for instead by
 * trimming every straight that is NOT a hairpin's braking zone by roughly a
 * fifth (the 170m and 195m braking straights ahead of HAIRPIN-1 and
 * HAIRPIN-2 are the one exception -- the brief's 150m floor for a braking
 * zone was never up for negotiation), which lands the whole lap back within
 * about 6% of the monotonic draft's own length rather than a quarter over
 * it. See the measured numbers at `CIRCUIT` below.
 *
 * The result: FOUR genuine left-handers, all -20 degrees (the low end of
 * "rarely breaks closure," chosen deliberately for a uniform, easy-to-verify
 * budget rather than four different numbers) -- one esses complex
 * (right/left/right, all in the medium band, the corners a driver actually
 * drifts) plus three standalone counter-curves, each a right immediately
 * followed by a left at a slightly smaller radius. Every one of the six
 * "keep as authored" pieces from the original pass -- both hairpins with
 * their braking zones, all three biofilm corners, the spiral, the jump, the
 * breach -- is untouched by any of this; only the four flexible corners
 * between them were ever in play.
 *
 * 5. THE BANK SIGN, WHICH THE FIELD TYPE'S OWN COMMENT GETS BACKWARDS.
 *
 * TrackNode.bank's doc comment says "positive banks the left edge up." Built
 * and measured directly (a right-hand corner, bank +15, reading back
 * `sample.right` against the corner's own centre): positive bank raises the
 * OUTSIDE edge of a RIGHT-hand corner, i.e. the doc comment has the sign
 * backwards, the same bug rustfall.ts found and fixed by hand for its own
 * corners. The rule that is actually true of the code: bank the SAME SIGN as
 * the corner's `deg` banks INTO the turn (outside edge up, the physically
 * correct direction); the opposite sign is adverse camber. Every right-hand
 * corner below is banked positive and every left-hand one negative, for
 * exactly that reason -- 2 to 11 degrees depending on how much the corner
 * needs the extra grip to hold, on both sides of zero.
 *
 * 6. WHAT THE PLAYER IS LOOKING AT.
 *
 * Unchanged from the shipped art pass: everything outside the glass, light
 * shafts from a surface 900m up, schools turning in unison, and the
 * leviathans holding station in the middle distance (themes/abyssal.ts draws
 * them through the celestial `ships` layer -- silhouettes with running
 * lights, exactly what a bioluminescent animal at range IS). The tube is the
 * only lit thing; the ocean is the dark. This file only reshapes the road; it
 * does not touch the theme.
 */

/**
 * THE LAP, CORNER BY CORNER.
 *
 *   corner            dir   r      deg   band      v(corner)   note
 *   BLOOM-A           R     64m    22    medium    48.2 m/s    first biofilm
 *   BLOOM-A (oil)     R     64m    22    medium    48.2 m/s
 *   ESSES-IN          R     72m    24    medium    51.2 m/s    esses piece 1
 *   ESSES             L     68m    20    medium    49.7 m/s    esses piece 2
 *   ESSES-OUT         R     72m    18    medium    51.2 m/s    esses piece 3
 *   COUNTER-1 IN      R     100m   36    fast      60.3 m/s    replaces SWEEPER-1
 *   COUNTER-1         L     90m    20    fast      57.2 m/s
 *   [ trench jump: 180m deck, 29 m/s launch, 60m gap ]
 *   HAIRPIN-1         R     52m    58    hairpin   43.5 m/s    heaviest brake
 *   BLOOM-B           R     66m    21    medium    49.0 m/s    second biofilm
 *   BLOOM-B (oil)     R     66m    21    medium    49.0 m/s
 *   FAST-2            R     95m    20    fast      58.8 m/s    run to the spiral
 *   [ the spiral: r=30, 3 turns, 400m axis, a geodesic -- see part 2 ]
 *   BREACH            R    160m    14    sweeper   76.3 (flat) crosswind, bounce walls
 *   COUNTER-2 IN      R     85m    40    fast      55.6 m/s    replaces FAST-3
 *   COUNTER-2         L     72m    20    medium    51.2 m/s
 *   BLOOM-C           R     62m    20    medium    47.5 m/s    third biofilm
 *   BLOOM-C (oil)     R     62m    20    medium    47.5 m/s
 *   FAST-4            R     85m    18    fast      55.6 m/s
 *   COUNTER-3 IN      R    110m    32    sweeper   63.3 m/s    replaces SWEEPER-3
 *   COUNTER-3         L     98m    20    fast      59.7 m/s
 *   HAIRPIN-2         R     50m    54    hairpin   42.7 m/s    last brake before home
 *
 * Twelve conceptual corners (twenty authored arcs): 2 hairpin, 3 biofilm
 * (medium), 1 esses complex (3 pieces, all medium), 3 standalone
 * counter-curves (each fast-into-medium or fast-into-fast), 2 fast-only
 * breathers (FAST-2, FAST-4), 1 spiral, 1 breach. FOUR left-handers --
 * ESSES, COUNTER-1, COUNTER-2, COUNTER-3 -- every one of them -20 degrees,
 * arranged as one esses complex plus three standalone counter-curves.
 *
 * Sixteen right-hand pieces sum to +440 (22+22 bloom-a, 24+18 esses in/out,
 * 36 counter-1 in, 58 hairpin-1, 21+21 bloom-b, 20 fast-2, 14 breach, 40
 * counter-2 in, 20+20 bloom-c, 18 fast-4, 32 counter-3 in, 54 hairpin-2);
 * four left-hand pieces sum to -80 (20 each at esses, counter-1, counter-2,
 * counter-3). Net +360 -- the builder throws unless this is exactly
 * +/-360, and `circuit()` verifies it at build time below.
 */
const SEGS: Seg[] = [
  { t: 'straight', len: 188, tag: 'start', toY: 30, tunnel: true },

  // BLOOM-A. r=64m is the loosest of the three biofilm corners -- deliberately
  // the most forgiving introduction to "the surface changes under you," so a
  // first-timer meets the mechanic here rather than at the tightest of the
  // three. Split metal/oil at a constant 64m radius and +6 deg bank, so only
  // the surface changes across the arc -- an even 22/22 degree split, which is
  // what keeps BOTH halves above the ~24m-arc floor a 3-step corner segment
  // needs to avoid a sub-8m chord (see the chord-ratio note by `CIRCUIT`
  // below).
  { t: 'corner', r: 64, deg: 22, bank: 6, w: 20, tunnel: true, tag: 'bloom' },
  { t: 'corner', r: 64, deg: 22, bank: 6, w: 21, surface: 'oil', tunnel: true },

  { t: 'straight', len: 140, tunnel: true },

  // THE ESSES. Replaces the monotonic draft's single FAST-1 (+22, r=90) with
  // a genuine right-left-right, net degree total UNCHANGED at +22 so the
  // checkpoint heading downstream of it is identical to the proven design
  // (part 4, attempt two). All three pieces sit in the medium band (68-72m)
  // -- this is the corner sequence a driver actually drifts through, flicked
  // one way then the other rather than held in one arc.
  { t: 'corner', r: 72, deg: 24, bank: 6, tunnel: true },
  { t: 'straight', len: 46, tunnel: true },
  { t: 'corner', r: 68, deg: -20, bank: -6, tunnel: true, tag: 'esses' },
  { t: 'straight', len: 46, tunnel: true },
  { t: 'corner', r: 72, deg: 18, bank: 6, tunnel: true },

  { t: 'straight', len: 112, toY: 36, tunnel: true },

  // COUNTER-CURVE 1. Replaces the monotonic draft's SWEEPER-1 (+16, r=140)
  // with a right/left pair, net still +16. Pulled down to the fast band
  // (90-100m) rather than kept at 140m -- a genuine 20-degree reversal at a
  // 140m sweeper radius costs far more arc for the same net heading change
  // than the same reversal at 90-100m, and this corner's job was already
  // "committed, not held flat," so the tighter radii cost less without
  // changing what the corner asks of the driver.
  { t: 'corner', r: 100, deg: 36, bank: 3, tunnel: true },
  { t: 'straight', len: 54, tunnel: true },
  { t: 'corner', r: 90, deg: -20, bank: -4, tunnel: true },

  { t: 'straight', len: 92, tunnel: true },
  // THE TRENCH JUMP. `jump` is its own segment type: the first 18% of its
  // 180m deck is the ramp (`ramp: 29`, auto-boosted), then 60m of unbarriered
  // road over the gap (`open` auto-set by the builder for that span), then a
  // landing runway. toY=24 drops the far side 12m below the crest before it
  // -- a real fall across the trench, not a hop. Tagged `trench-jump` for the
  // theme's wreck cluster underneath.
  { t: 'jump', len: 180, launch: 29, gap: 60, toY: 24, tag: 'trench-jump' },

  // 170m of landing runway before the first hairpin -- the braking zone the
  // brief calls for (150m floor), untouched by the length-trimming in part 4
  // since a hairpin's braking zone was never a candidate for that.
  { t: 'straight', len: 170, tunnel: true },
  // HAIRPIN-1. 52m -- 43.5 m/s, the heaviest brake on the lap. WIDER than the
  // rest of the circuit (25m half-width against a 19m default) for exactly
  // the reason the brief calls out: a tight radius arriving off a long fast
  // run needs room for a car that turns in a little hot to still find the
  // apex rather than the wall. Bank +11, the most aggressive on the lap --
  // this is the corner that most needs the extra grip, not the one that
  // least needs it (see part 5).
  { t: 'corner', r: 52, deg: 58, bank: 11, w: 25, tunnel: true, tag: 'hairpin-1' },

  { t: 'straight', len: 104, toY: 20, tunnel: true },
  // BLOOM-B. 66m -- the middle of the three biofilm radii, same construction
  // as BLOOM-A: metal/oil at a constant radius and bank, split 21/21.
  { t: 'corner', r: 66, deg: 21, bank: 6, w: 20, tunnel: true, tag: 'bloom-b' },
  { t: 'corner', r: 66, deg: 21, bank: 6, w: 21, surface: 'oil', tunnel: true },

  { t: 'straight', len: 72, tunnel: true },
  // FAST-2. 95m -- 58.8 m/s. One of two corners this pass left completely
  // alone (with FAST-4) -- a clean single right, no reversal, a breather
  // between the esses/counter-curve work either side of it.
  { t: 'corner', r: 95, deg: 20, bank: 4, tunnel: true },

  // THE SPIRAL. r=30 (matching the old Descent's own radius -- the one
  // continuous set piece this circuit keeps), three FULL turns over a 400m
  // axis, descending 4m net (toY=10, on top of the 6m the approach already
  // gave up) into the deepest, darkest point of the lap. Still 10m above the
  // 6m floor at the axis -- the coil's own vertical bob adds height on top of
  // that, never subtracts it (see part 2), so nothing here ever reads below
  // the axis value. `turns: 3` is a whole number, which is what keeps the
  // entry and exit seams flush with the flat road on either side.
  { t: 'straight', len: 68, toY: 14, tunnel: true },
  { t: 'cyclone', r: 30, turns: 3, len: 400, toY: 10, tunnel: true, tag: 'spiral' },

  // THE BREACH. The tube is open here -- no `tunnel` on this straight or the
  // corner that follows it, which is the visual the art pass wants at exactly
  // the spot the sim also stops pretending the tube is sealed.
  { t: 'straight', len: 68 },
  // 160m sweeper, taken flat out (76.3 m/s ceiling). ONE piece, not three: at
  // only 14 degrees of total sweep there is no way to split this corner into
  // several sub-arcs without at least one of them falling under the ~24m-arc
  // floor noted at BLOOM-A above. Peak wind is still 15 m/s^2 of lateral
  // push -- it is simply the WHOLE corner now rather than a ramped middle
  // third; the fade in and out happens at the one node gap on either side,
  // same as every other surface change on this lap. BOUNCE walls throughout,
  // never `open` -- see part 3 and Ashkar's 16.3 respawns/race the other way
  // round. +1.5m of width over the default, matching the extra room
  // Elkarim's own crosswind corridor gives a car that is being pushed.
  { t: 'corner', r: 160, deg: 14, bank: 2, w: 20.5, wind: 15, bounce: true, tag: 'breach' },

  { t: 'straight', len: 76, toY: 16, tunnel: true },

  // COUNTER-CURVE 2. Replaces the monotonic draft's FAST-3 (+20, r=100) with
  // a right/left pair, net still +20, right after the breach lets go -- the
  // second standalone counter-curve, the right piece still fast (85m), the
  // left piece down in the medium band (72m) rather than fast, giving this
  // one a slightly sharper bite on the way out than COUNTER-1's.
  { t: 'corner', r: 85, deg: 40, bank: 4, tunnel: true },
  { t: 'straight', len: 50, tunnel: true },
  { t: 'corner', r: 72, deg: -20, bank: -6, tunnel: true },

  { t: 'straight', len: 104, toY: 20, tunnel: true },
  // BLOOM-C. 62m -- the tightest of the three biofilm radii, and deliberately
  // last: by this point in the lap a driver has met the mechanic twice
  // already, so the tightest dose comes when they know what it is. Split
  // 20/20 -- the tightest even split of the three blooms, right at the arc
  // floor rather than comfortably above it, which is why it is spent last.
  { t: 'corner', r: 62, deg: 20, bank: 6, w: 20, tunnel: true, tag: 'bloom-c' },
  { t: 'corner', r: 62, deg: 20, bank: 6, w: 21, surface: 'oil', tunnel: true },

  { t: 'straight', len: 120, toY: 24, tunnel: true },
  // FAST-4. 85m -- 55.6 m/s. The second of the two corners left completely
  // alone (with FAST-2) -- another clean breather, no reversal.
  { t: 'corner', r: 85, deg: 18, bank: 4, tunnel: true },

  { t: 'straight', len: 132, toY: 28, tunnel: true },

  // COUNTER-CURVE 3. Replaces the monotonic draft's SWEEPER-3 (+12, r=180)
  // with a right/left pair, net still +12 -- the third standalone
  // counter-curve, right before the final hairpin's braking zone. The right
  // piece is held at 110m, the bottom edge of the sweeper band, so this lap
  // keeps at least one flexible-section sweeper alongside the breach rather
  // than pushing every fast-radius corner down into the fast band.
  { t: 'corner', r: 110, deg: 32, bank: 2, tunnel: true },
  { t: 'straight', len: 46, tunnel: true },
  { t: 'corner', r: 98, deg: -20, bank: -4, tunnel: true },

  // 195m authored -- comfortably past the 150m brief for a hairpin's braking
  // zone, and, like the zone before HAIRPIN-1, untouched by the
  // length-trimming pass in part 4.
  { t: 'straight', len: 195, tunnel: true },
  // HAIRPIN-2. 50m -- 42.7 m/s, the tightest corner on the circuit and the
  // last thing before the line. Widened and banked the same as HAIRPIN-1 (25m
  // half-width class, +11 deg) for the same reason: the tightest radius on
  // the lap gets the most margin, not the least.
  { t: 'corner', r: 50, deg: 54, bank: 11, w: 25.5, tunnel: true, tag: 'hairpin-2' },
]

/**
 * Closing this lap needs no site scaling at all (`scale` comes back 1.00),
 * exactly as it did for the monotonic draft in part 4 -- gap 0.0000m. This is
 * NOT a coincidence: every corner this pass touched was split net-neutral
 * against a corner sequence already proven to close for free, so the
 * left-handers cost this file nothing in closure math, only in length (see
 * part 4's attempt two).
 *
 * SPACING IS 18m, NOT THE 24m THE API EXAMPLE SUGGESTS, AND THAT IS A
 * MEASURED CHOICE CARRIED OVER FROM THE MONOTONIC DRAFT, NOT AN AESTHETIC
 * ONE. The chord-ratio gate reads the straight-line distance between every
 * pair of CONSECUTIVE AUTHORED NODES, and a `corner` segment's node count is
 * `max(3, round(arc/spacing))` -- a floor of three steps that this lap's
 * shortest corner arcs (the biofilm and breach sub-pieces, and now the
 * esses/counter-curve pieces too, 18-40 degrees of sweep at 62-110m) all
 * land on regardless of spacing. Spacing 18 keeps the long end of the ratio
 * (from the shortest straights) down near 22m against a 7m short end --
 * ratio 3.10, comfortably under the 3.5 gate, essentially unchanged from the
 * monotonic draft's own 3.09.
 */
const CIRCUIT = circuit(SEGS, {
  spacing: 18,
  start: [0, 28, 0],
  heading: 0,
  defaults: { w: 19, surface: 'metal' },
  minStraight: 40,
})

/**
 * MEASURED, via `tools/probe-newtrack.ts --track=abyssal` and
 * `tools/probe-selfclear.ts --track=abyssal` against this exact file:
 *
 *   plan length 3151.1m (+5.9% over the monotonic draft's 2976.6m -- the
 *     structural cost of four genuine reversals, paid for by trimming every
 *     non-braking-zone straight roughly a fifth, see part 4); baked 3328m
 *   gap 0.000m, scale 1.000 -- no site inflation needed
 *   chord 7.2-22.2m, ratio 3.10                       (gate: < 3.5)
 *   35% of the lap reads as curved (|k| > 0.0045)      (gate: >= 12%)
 *   curved-sample radius bands: hairpin 12.2%, medium 22.6%, fast 23.3%,
 *     sweeper 38.8% -- plus 2.2% under 45m (the spiral's own curvature, see
 *     part 2, not a fourteenth authored corner) and 0.9% over 220m (corner-
 *     boundary blend samples). Medium+fast -- the 58-110m band the brief
 *     calls the heart of a lap -- is 45.9% here against the monotonic
 *     draft's 38.3%, richer for the four counter-curves mostly landing there.
 *   24/24 racers finish, three fixed seeds x eight racers
 *   lap time: best 68.47s, mean 73.88s, worst 80.80s   (gate: mean in 55-75s)
 *   0.0 respawns/race, 0.0% off-track                  (gate: <= 3.0/race)
 *   closest the road ever comes to itself: infinite -- no self-overlap
 *
 * "MERIDIAN DEEP IS RACEABLE."
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
  nodes: CIRCUIT.nodes,
  // Five rows, spread across the straights between hazards rather than on top
  // of them. Fractions re-measured against this build's own length
  // (`CIRCUIT.marks` gives the exact beat positions: bloom 0.064, esses
  // 0.152, trench-jump 0.294, hairpin-1 0.405, bloom-b 0.450, spiral 0.512,
  // breach 0.657, bloom-c 0.764, hairpin-2 0.985).
  itemBoxRows: [
    { at: 0.03, count: 5, spread: 4.2 },
    { at: 0.22, count: 4, spread: 4.0 },
    { at: 0.49, count: 5, spread: 4.2 },
    { at: 0.71, count: 5, spread: 4.4 },
    { at: 0.87, count: 4, spread: 4.0 },
  ],
  chargeRuns: [
    { from: 0.01, to: 0.05, count: 6, lateral: -5 },
    { from: 0.18, to: 0.22, count: 6, lateral: 4 },
    { from: 0.33, to: 0.37, count: 6, lateral: 0 },
    { from: 0.56, to: 0.61, count: 6, lateral: -4 },
    { from: 0.70, to: 0.75, count: 7, lateral: 5 },
    { from: 0.88, to: 0.92, count: 6, lateral: 0 },
  ],
  laps: 3,
}
