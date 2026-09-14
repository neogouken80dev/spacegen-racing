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
 * Fourteen corners land: 2 hairpin, 4 fast, 2 sweeper, 6 medium -- 71% of the
 * lap in the 58-110m band the old ring never visited. A street circuit earns
 * the densest corner count of the four for exactly the reason the feedback
 * asked for it: variety, not one impossible apex.
 *
 * ---------------------------------------------------------------------------
 * IDENTITY, UNCHANGED: HARD FROM GEOMETRY ALONE.
 *
 * Every other Hard circuit in the game is hard because of a substance --
 * Frosthelm's ice, Meridian Deep's biofilm, Centurion Prime's vacuum. Take the
 * substance away and they are wide, fast and forgiving. Zhen-9 has no hostile
 * surface anywhere: dry maglev deck, grip 1.0, `metal` end to end. It is the
 * hardest lap in the roster because the road is 14-21m half-width and walled
 * on both sides (`bounce: true` everywhere except the two set pieces), not
 * because anything is slippery. Every wall bounces rather than scrubs, which
 * is what makes a walled street circuit driveable at all: contact costs speed
 * and nothing else, so leaning on a barrier through a corner is a line a
 * driver CHOOSES rather than a drift-ending accident.
 *
 * THE MAGLEV IS THE COMPENSATION. Three `boost: true` runs -- the start
 * straight, the loop straight, and the run into the final corner -- carry
 * more boost road than any other circuit. That is what stops a narrow,
 * technical lap from being merely slow: the rhythm is real top speed
 * alternating with hard braking, never both at once.
 *
 * ---------------------------------------------------------------------------
 * WHY A CORNER'S POSITION IN THE LAP MATTERS AS MUCH AS ITS RADIUS.
 *
 * `circuit()` closes a lap by taking the minimum-norm correction across every
 * authored straight -- see its own header for why. That correction is not
 * free: a corner sequence has a "natural" shape (trace the headings with EQUAL
 * straights and see where the closed lengths land), and a straight asked to be
 * far longer than its natural gap wants fights the correction, which pays for
 * it by shrinking straights elsewhere -- sometimes negative. The first draft
 * of this lap put the tight, 180m-plus-lead-in corners exactly where the
 * *narrative* wanted them and NOT where the corner sequence's natural shape
 * had room, and it failed to close (a straight solved at -31m even at 2.5x
 * site scale). The fix was not to lengthen straights -- the builder says as
 * much in its own error -- it was to swap which RADIUS sits at which point in
 * the sequence: corner 1 (opening the lap, fed by the start straight, whose
 * natural gap is generously large) trades its radius with corner 7 (fed by
 * the loop's exit, whose natural gap is a bare few metres). The result: the
 * driving identity is the same -- a tight braking corner right off the grid,
 * a fast corner out of the Holo Ring -- and the lap closes at scale 1.0 with
 * every straight clear of the 40m floor. Four other corners (the second
 * hairpin, both post-set-piece exits, the final corner) already sat on
 * naturally large gaps and needed no such swap. Every corner below still
 * occupies the exact SLOT that story assigned it; only the radius drawn
 * inside a handful of slots moved, in the second pass described next.
 *
 * A SECOND BUILDER QUIRK, WORKED AROUND HERE RATHER THAN IN circuit.ts. A
 * `loop` segment's last emitted node (f=1) is, by construction, the exact
 * point the next segment continues from -- see `staggeredLoop`'s own comment
 * on why the crossing is lateral. That means the node immediately after a loop
 * sits at IDENTICAL position to the loop's own last node: a zero-length chord,
 * which reads as an infinite chord ratio to anything that measures min/max.
 * Nothing upstream of this file can see that it is one feature (a loop) rather
 * than a modelling defect, so `dedupeCoincidentNodes()` below removes the
 * duplicate after `circuit()` returns, the same way a caller would trim a
 * degenerate polygon edge. One node out of ~160, and the loop's own geometry
 * is untouched.
 *
 * ---------------------------------------------------------------------------
 * THE SECOND PASS: A NARROW LAP IS THE SLOWEST WAY TO SPEND A METRE.
 *
 * The first geometry that closed (every corner where the story above puts it,
 * every mandatory lead-in comfortably over 180m) baked to 4082m and averaged
 * 87s a lap -- a strong pass on every OTHER gate (24/24 finishers, chord ratio
 * under 3, respawns near zero) and a hard fail on the one that matters most: a
 * lap 12-32s outside the 55-75s band. Telemetry on a single racer's speed
 * against distance travelled explained why: on a track this narrow, with
 * fourteen corners plus a loop and a cyclone, almost NONE of a straight is
 * spent at top speed -- most of it is spent decelerating into the next
 * braking zone or still building back up out of the last one. Cutting
 * straight length here does not trade a lazy cruise for a shorter one, it
 * cuts directly into that transition, so it earns real seconds even though
 * the CORNERS never moved.
 *
 * Two levers, applied together, closed the gap:
 *
 *   1. EVERY STRAIGHT WAS RE-SOLVED, NOT GUESSED. `circuit()`'s closure is
 *      exact linear algebra (closed length = authored length + a correction
 *      that is itself linear in every OTHER authored length), which means a
 *      hand-trimmed straight can look safe in isolation and still push some
 *      distant, unrelated gap under the 40m floor once the correction
 *      re-solves -- three separate trims here did exactly that, each one
 *      auto-growing the whole site back to a bigger total than the trim
 *      saved. The fix was a small linear program: minimise total closed
 *      straight length subject to every floor (40m plain, 180m on the five
 *      corners tighter than 70m) as a hard constraint, solved once over ALL
 *      nineteen straights at once rather than one at a time. Where two
 *      straights turned out to share an identical heading -- Maglev B's two
 *      halves either side of the Holo Ring, the three Squeeze segments, the
 *      Spire's entry and exit gap -- the correction cannot tell them apart
 *      (moving length from one to the other changes nothing else in the
 *      lap), which is what let the long, characterless side of that trade
 *      (the plain gap after the Spire, the plain gap before Summit Sweep)
 *      absorb it instead of a named, narrow one.
 *
 *   2. EVERY RADIUS THAT COULD MOVE, MOVED TOWARD THE CHEAP END OF ITS BAND.
 *      Corner time is `r * angle / cornerSpeed(r)`, and because cornerSpeed
 *      grows with the SQUARE ROOT of r while the arc grows linearly with it,
 *      a wide corner costs more lap time per degree of direction change than
 *      a tight one -- worst of all a sweeper, whose speed is capped at top
 *      speed so widening it buys nothing back at all. Long Bank Sweep and
 *      Summit Sweep both came down from deep in their 110-220m band toward
 *      its floor; the fast band came down from the 84-96m the first pass
 *      drew toward 80-83m; three medium corners came in a few metres each.
 *      No radius left its band and no corner changed which of the four bands
 *      it belongs to -- the table above still reads 2 / 6 / 4 / 2 -- so nose
 *      the AI drift-holds and the speed-percent story are exactly what the
 *      table already promised, just measured at the inexpensive edge of each
 *      promise instead of the middle.
 *
 * The Holo Ring itself took a third, smaller cut: its radius was part of the
 * cornerSpeed(r) cost too, and telemetry showed it as the single slowest
 * stretch of the lap by a wide margin (under 30 m/s sustained through a
 * corner named after a radius that formula would call "hairpin-and-a-half").
 * 34m shrank to 25m -- still comfortably above `circuit()`'s own floor for a
 * loop this width -- which cost about a second and a half of lap time and
 * nothing else on its own.
 *
 * ---------------------------------------------------------------------------
 * THE THIRD PASS: A BUG IN THE MARGIN, AND THE LAST SECOND OF LAP TIME.
 *
 * The second pass's straight-length linear program used bare 40m/180m floors
 * with no safety margin, and rounding the solved lengths to whole metres for
 * this file pushed several of them a few centimetres UNDER their floor after
 * rounding -- invisible in the LP's own output, which checked the unrounded
 * solution. `circuit()` doesn't error on that; it silently auto-grows the
 * whole site (its own documented behaviour, see this file's header) until
 * every straight clears 40m, which is exactly as harmless-looking and as
 * expensive as it sounds: the site grew 12% and the lap that had just been
 * cut to 74.5s came back at 76-79s. The fix was the same linear program, this
 * time queried directly against `circuit()` itself rather than a hand
 * re-derivation of its closure math (a finite-difference probe of the real
 * function IS the Jacobian, with no translation step left to get wrong), and
 * solved with a real half-metre of margin on every floor so 1-decimal
 * rounding can never cross it again. That alone reset the site to scale 1.0
 * -- no auto-grow -- at a total straight length the same LP then proved was
 * the true minimum for this exact corner sequence: two further attempts to
 * free more slack from the long, anonymous straights both converged back to
 * the identical total, which is the linear program's own proof that no more
 * time was available from straight length alone.
 *
 * The remaining margin came from lever 2 again, pushed one step further: ten
 * corners that still had daylight between their drawn radius and their
 * band's true floor -- T1/T2/T3's esses, both hairpins, T7/T9's fast pair,
 * T12/T14's medium pair, T13's sweeper -- came down those last few metres
 * each. None left its band (the table below is still 2 / 6 / 4 / 2) and nine
 * of them now sit exactly on their band's floor, which is where lever 2
 * always said the cheapest lap time lived.
 *
 * That tightening, worked back through the closure correction, is also what
 * pulled the Holo Ring's own entry and exit ramps close enough together to
 * fail a THIRD gate no earlier pass had triggered: `probe-selfclear.ts`
 * (added after Ashkar shipped a loop whose de-loop launched into itself)
 * found the last metre of ST6a and the first metre of Maglev B's exit only
 * 1.8m apart in 3-space, 192m apart along the lap -- a car needs 2m. The
 * loop's `stagger` is exactly the parameter that number depends on and
 * nothing else does (it never enters `dist`, only the lateral crossing
 * offset), so it was the only lever pulled: 52 to 58 bought 2.7m of
 * clearance for about 4m of total site growth, found by testing the real
 * probe directly rather than re-deriving the loop's helix geometry by hand.
 * A larger jump (70) clears self-overlap with room to spare but drags the
 * chord ratio to 3.6 and the lap back over 75s -- proof that this gate,
 * like the others, wants the cheapest fix that clears it, not the
 * safest-looking one.
 *
 * The result: 3258m, mean lap 74.7s, 24/24 finishers, 0.3 respawns/race,
 * chord ratio 3.18, no self-overlap. The corners are the same fourteen, in
 * the same order, at the same braking zones; the lap is simply drawn at the
 * tightest, cheapest radius each one's band, role and neighbouring geometry
 * will still support.
 *
 * ---------------------------------------------------------------------------
 * THE FOURTH PASS: A BUILDER CHANGE, A SET-PIECE BUG, AND TWO LEVERS THAT
 * MEASURED BACKWARDS.
 *
 * `circuit.ts` changed under this file twice, for reasons this file had
 * nothing to do with. First, its loop crossing moved from CENTRED
 * (-stagger/2 to +stagger/2, a half-stagger sideways step at each mouth --
 * exactly the self-overlap the third pass fought above) to a crossing that
 * begins where the road already is and exits a full `stagger` across; the
 * builder now accounts for that in closure itself. Second, a hard guard
 * followed: loop radius must be >=32m, and `stagger` <=1.9x radius, after
 * measuring that a 25m loop was reading to `curvatureAt` as a phantom 26m
 * "corner" nobody authored. LOOP_R went 25 -> 34 to clear the guard; stagger
 * came down 58 -> 54, comfortably inside the new [road width+14, 1.9r]
 * window -- and the wide-crossing fix means the self-overlap fight from the
 * third pass is simply gone: no stagger value in that window reproduces it.
 *
 * A second problem was this pass's own, and cost far more time to find. Once
 * the site was re-closed for the new loop geometry, the Spire began eating
 * the field: EVERY racer, on some lap, drove off the road inside the
 * corkscrew -- 8 respawns/race, 100% of them at that one tag, on a segment
 * this pass had not touched. `RacerState.splineS` at the moment each respawn
 * armed showed a car still translating (~8 m/s of spline progress in the
 * final 1.3s, not stalled dead), which is the off-track edge watchdog, not
 * the stall one -- something was pushing cars past the tube wall, not
 * wedging them. Hand-reasoning about *why* has been wrong all through this
 * project, so the cause was isolated the same way every other one was: by
 * changing one thing at a time on a local harness that builds the real
 * `Track`/`Race` classes but skips the full track registry (so a sibling
 * file mid-edit elsewhere can't block it) and reading back respawns per
 * race. Widening the tube's own radius made it WORSE (26m -> 36m: 8 -> 11.3
 * respawns/race) -- ruling out "too tight". Flipping `bounce` made no
 * difference -- ruling out wall-scrub physics. Reverting every upstream
 * corner and boost-length change made no difference -- ruling out approach
 * speed; entry speed measured ~39 m/s in every configuration tried,
 * unchanged. What fixed it, completely, was halving the corkscrew's own roll
 * rate: `turns: 2 -> 1` over the same 180m axis, same radius, same width.
 * 0 respawns/race across 64 test races, and the gentler corkscrew was also
 * FASTER -- a car that isn't grazing the tube wall on every lap needs less
 * recovery time, not just fewer trips to the medic. The identity survives
 * unbothered: still one cyclone, still a 16m descent, still the lap's other
 * set piece; it just turns once instead of twice.
 *
 * With the field no longer bleeding respawns at the Spire, the lap was
 * still measuring at the very top of its time band, and the two obvious
 * levers for pulling it down -- open the sweepers past their 110m floor,
 * and trade one hairpin for a wider corner -- were tried directly and both
 * measured BACKWARDS. Long Bank Sweep and Summit Sweep are both already
 * flat-out at 110m (the band's own floor); pushing either to 160m bought
 * roughly 0.7s of extra arc time at the same capped speed and nothing else,
 * exactly what the second pass's lever-2 note above already said a sweeper
 * does. Trading Chinatown Hairpin for a 75m "kink" of the same 108-degree
 * turn cost about 2s on its own -- corner time scales with the SQUARE ROOT
 * of radius at a fixed angle, so 49m -> 75m is a real 24% increase on that
 * corner alone, however much smoother it looks on paper. Both were reverted:
 * both hairpins stayed (the brief allows two, and two is what this lap was
 * quickest with), both sweepers went back to their 110m band floor.
 *
 * The lever that actually worked was the one the second and third passes
 * already trusted, re-run from first principles rather than patched: the new
 * loop crossing changes the closure correction for every straight downstream
 * of the Holo Ring, so the exact lengths those passes solved no longer
 * applied to this corner sequence and had to be re-derived, not nudged. A
 * fresh finite-difference Jacobian of the real `circuit()`, re-solved as one
 * linear program over all nineteen straights (same 40.5m/180.5m floors, a
 * half-metre of margin as before), found a new true minimum for this exact
 * sequence -- about 70m shorter, closed, than what this pass inherited --
 * and in the same solve corrected a genuine violation the round's earlier
 * shuffling had left behind: Chinatown's lead-in had drifted to 157m against
 * its required 180m brake zone. The LP grew it back out and paid for most of
 * that growth from the two anonymous gaps either side of the Spire, which is
 * exactly the length the second pass already said belongs on an unnamed
 * straight rather than a named one.
 *
 * The result: 3231m, mean lap 69.6s, 64/64 finishers over an 8-seed test
 * (0 respawns/race), chord ratio 2.28, corner radii tightest-34m/median-90m
 * -- the tightest reading on the whole lap is the Holo Ring's own authored
 * radius, not a phantom number below anything drawn here. The fourteen
 * corners, their order and their braking zones are unchanged from the third
 * pass; only the loop's geometry, the Spire's roll rate, and the straight
 * lengths the closure correction hangs off of moved.
 *
 * ---------------------------------------------------------------------------
 * THE SQUEEZE. Three narrow straights ramp the road from the standard 17.5m
 * half-width down to 14m and back -- 15.5 / 14 / 15.5 either side of the
 * pinch, so the change lands in three small steps over three node-to-node
 * spacings rather than one cliff. It sits entirely on straight road between
 * two corners that need no braking-zone favour, exactly per the rule: a
 * squeeze inside a corner is a wall placed in a blind spot, not a challenge.
 *
 * TWO TUNNELS. "Underpass #1" (Transit Cut) doubles as the brake zone into
 * the first hairpin; "Underpass #2" (Podium Undercroft) sits on the approach
 * to Riverside Kink. `tunnel: true` is art only -- the sim drives it exactly
 * like open road -- so both are free to also be the geometry doing the actual
 * work of closing the lap.
 *
 * ONE LOOP, ONE CYCLONE, NO JUMP. The Holo Ring and the Spire are this
 * circuit's set pieces, both geodesics the sim reads as dead straight -- the
 * only two places on a walled, 14-corner lap the driver is allowed to stop
 * working. A jump has no place on a street circuit with buildings either side
 * of the road.
 *
 * ELEVATION. The deck climbs and drops in small, gentle grades (every ramp
 * here is under 9% -- re-tuned DOWN alongside the second pass above, since a
 * fixed metres-of-rise against a much shorter straight is a much steeper
 * grade) between district tiers -- down into the Transit Cut, up past the
 * Holo Ring, down again through the Spire's own descent, back up to the
 * finish -- and never drops below 24m, comfortably clear of the 6m floor.
 * The cyclone adds its own local rise on top of whatever the deck under it is
 * doing, and that always maths out to never dip below the descending
 * baseline, so the elevation floor is never at risk from the set piece.
 */

/** Metres between emitted nodes. Keeps chord ratios well inside the gate. */
const SPACING = 24
/** Deck elevation at the start/finish line, and where the lap returns to. */
const START_Y = 42
/**
 * Holo Ring radius -- referenced again below when locating its apex node.
 * 34m in the first pass; shrunk to 25m in the second (see the header note);
 * raised back to 34m in the fourth pass, this time because `circuit()`
 * itself now REQUIRES >=32m for a loop (a 25m loop was reading as a phantom
 * 26m corner to `curvatureAt` -- see the fourth-pass note). `stagger` is 54,
 * comfortably inside the builder's own [road width+14, 1.9*r] window for
 * this radius.
 */
const LOOP_R = 34

/**
 * THE FOURTEEN CORNERS, IN LAP ORDER.
 *
 * Every corner's comment gives its band and, where it isn't obvious, why it
 * sits at that point in the sequence. `deg` signs: +right, -left. Angles sum
 * to exactly +360 -- `circuit()` throws otherwise, so treat that sum as load
 * -bearing if this list is ever edited. Straight lengths were solved as one
 * linear program over all nineteen at once (see the header's second-pass
 * note) rather than authored by feel -- several read oddly small because
 * `circuit()`'s correction inflates them well past what is written here; the
 * comment on each names what it actually closes to.
 */
const SEGS: Seg[] = [
  // --- MAGLEV A. The opening sprint: boosted, and closes to ~195m -- comfortably
  // over corner 1's mandatory 180m brake zone. See the header note on why the
  // tight corner lives HERE and not at its narrative "natural" position seven
  // corners later.
  { t: 'straight', len: 215.00, tag: 'start', boost: true, w: 18.5 },

  // T1 GRID CORNER -- medium, 62m (77% of top speed). The radius the loop
  // exit corner would have carried in a naive authoring pass; it lives here
  // instead because this is where the lap has a 180m+ mandatory straight to
  // brake on. Widened to 20m: first-corner braking under a fresh field is the
  // single most contested moment of the lap.
  { t: 'corner', r: 62, deg: 46, bank: 8, w: 20, tag: 'T1-tight' },
  { t: 'straight', len: 44.36 },

  // T2 DOCKSIDE SWEEP -- medium, 60m (76%), opens the esses -- tightened twice
  // over from this design's 78m first draft, since T2/T3's esses gap kept
  // proving able to spend it for free, with no floor at risk either time.
  { t: 'corner', r: 60, deg: 50, bank: 7, tag: 'T2' },
  { t: 'straight', len: 24.85 },

  // T3 COUNTER DOCK -- medium, 62m (77%), the esses' reversal.
  { t: 'corner', r: 62, deg: -44, bank: -7, tag: 'T3' },

  // Underpass #1, the Transit Cut -- also the ~181m brake zone the hairpin
  // needs. Deck drops 12m through it, a gentle ~7% grade.
  { t: 'straight', len: 181.87, tunnel: true, toY: 30, tag: 'tunnel1' },

  // T4 FOUNDERS HAIRPIN -- 46m (67%, 98m of arc) -- eased 2m tighter still in
  // the third pass (see the header note): the tightest band on the lap is
  // already the cheapest place to spend a degree of turn, so even a small
  // cut here is close to free. Widened to 20m and fed by a proper straight
  // brake zone.
  { t: 'corner', r: 46, deg: 122, bank: 11, w: 20, tag: 'T4-hairpin' },
  { t: 'straight', len: 38.10, toY: 33 },

  // T5 EXCHANGE KINK -- fast, 80m (88%), the floor of its band -- a lift
  // rather than a full brake, and the cheapest radius that still reads fast.
  { t: 'corner', r: 80, deg: -38, bank: -5, tag: 'T5' },
  { t: 'straight', len: 16.83 },

  // T6 LONG BANK SWEEP -- sweeper, 110m (103% -- flat out), down from 150m in
  // the first pass. A sweeper's speed is capped at top speed regardless of
  // radius, so the first draft's extra 40m bought nothing but arc length;
  // still clearly the loosest corner before the Holo Ring.
  { t: 'corner', r: 110, deg: -22, bank: -3, tag: 'T6' },

  // --- MAGLEV B, part 1: the run up to the loop.
  { t: 'straight', len: 20.00, boost: true, w: 18.5, toY: 36 },

  // THE HOLO RING. A staggered vertical loop through an advertising hoop --
  // see circuit.ts's own note on why the crossing is lateral. Not boosted,
  // not `bounce`: the one set piece a driver gets to just enjoy. Its radius
  // is `LOOP_R` above -- see the header's second-pass note for why it shrank.
  // Its apex node is located and tagged in the post-processing block below.
  { t: 'loop', r: LOOP_R, side: 1, stagger: 54, w: 17, bounce: false, tag: 'holoring' },

  // --- MAGLEV B, part 2: the loop's exit straight. This gap and the one
  // above share an identical heading (the loop is a geodesic and does not
  // turn it), so the closure math cannot tell them apart -- both stay short
  // and are simply a good boost burst rather than a long one; the run's
  // "long" identity belongs to Maglev C at the finish.
  { t: 'straight', len: 20.00, boost: true, w: 18.5, tag: 'maglev' },

  // T7 RING EXIT -- fast, 80m (88%). Carries the radius T1 traded away: fed
  // by the loop's exit rather than a dedicated brake zone, which is fine,
  // because a fast corner never needed the 180m rule in the first place.
  { t: 'corner', r: 80, deg: -58, bank: -5, tag: 'T7' },
  { t: 'straight', len: 40.19, toY: 33 },

  // T8 TERRACE CURVE -- medium, 58m (75%), the floor of its band.
  { t: 'corner', r: 58, deg: 48, bank: 7, tag: 'T8' },
  { t: 'straight', len: 22.47, toY: 30 },

  // T9 PODIUM KINK -- fast, 80m (88%), the last corner before the lap's
  // longest uninterrupted straight.
  { t: 'corner', r: 80, deg: -36, bank: -5, tag: 'T9' },

  // Plain brake zone into the second hairpin, closing to ~181m -- no set
  // piece stacked on it, on purpose, after the first draft's lesson.
  { t: 'straight', len: 175.21, tag: 'lead-T10' },

  // T10 CHINATOWN HAIRPIN -- 49m (69%, 92m of arc). The lap's other hairpin,
  // opposite hand from Founders -- left alone through the second pass, then
  // tightened in the third once the lap-time budget needed one more
  // hairpin's worth of margin; still 4m clear of the 45m floor. Widened to
  // 20m.
  { t: 'corner', r: 49, deg: 108, bank: 11, w: 20, tag: 'T10-hairpin' },

  // Underpass #2, the Podium Undercroft. Deck climbs 3m through it.
  { t: 'straight', len: 39.40, tunnel: true, toY: 33, tag: 'tunnel2' },

  // T11 RIVERSIDE KINK -- fast, 80m (88%), the floor of its band.
  { t: 'corner', r: 80, deg: 42, bank: 5, tag: 'T11' },
  { t: 'straight', len: 33.38, toY: 39 },

  // THE SPIRE. A one-turn corkscrew down a tower's service helix -- a
  // geodesic, read by the sim as dead straight, and this lap's other set
  // piece. `bounce: false` for the same reason as the loop. Descends 16m
  // across its own 180m axis (~9% grade); the helical wobble on top of that
  // never dips below the descending baseline, so the elevation floor is safe
  // regardless of where in the turn a racer is. Two turns over this same
  // axis is what the fourth pass traced the Spire's respawns to -- see the
  // header note; one turn is fully clean and, as a side effect, faster too.
  { t: 'cyclone', r: 26, turns: 1, len: 180, w: 18, bounce: false, toY: 23, tag: 'spire' },

  // Plain gap, closing to ~269m -- the Spire's exit shares its heading with
  // the plain gap before Summit Sweep below (see the header note), so
  // between the two of them this is the one asked to carry most of it: an
  // anonymous straight is a far better place for that length than a named
  // one.
  { t: 'straight', len: 261.98, toY: 33 },

  // T12 SPIRE EXIT -- medium, 58m (75%), the floor of its band. Widened to
  // 20m and fed by the gap above, which comfortably clears the 180m a corner
  // this tight needs.
  { t: 'corner', r: 58, deg: 60, bank: 9, w: 20, tag: 'T12-tight' },
  { t: 'straight', len: 250.00, toY: 42 },

  // T13 SUMMIT SWEEP -- sweeper, 110m (103% -- flat out), down from 170m in
  // the first pass and tightened again in the third to sit exactly on its
  // band floor, for the same reason as Long Bank Sweep: a sweeper's speed is
  // capped regardless of radius, so the extra length bought nothing but lap
  // time.
  { t: 'corner', r: 110, deg: 26, bank: 3, tag: 'T13' },

  // THE SQUEEZE. Three straights, never a corner: 17.5 -> 15.5 -> 14 -> 15.5
  // -> 17.5, ramped across three node-to-node spacings rather than stepped.
  // All three share a heading (see the header note), so they were solved and
  // then hand-balanced to roughly equal spans rather than left lopsided.
  { t: 'straight', len: 82.50, w: 15.5, tag: 'squeeze' },
  { t: 'straight', len: 101.00, w: 14 },
  { t: 'straight', len: 82.50, w: 15.5 },

  // --- MAGLEV C. The last boost run, and the lead-in to the final corner --
  // boost hard, then brake hard, one more time before the line. The lap's
  // one deliberately LONG straight, closing to ~223m, well clear of T14's
  // mandatory 180m.
  { t: 'straight', len: 245.00, boost: true, w: 18.5, tag: 'maglevC' },

  // T14 GRID RETURN -- medium, 58m (75%), the floor of its band. The lap's
  // third tight corner, closing onto the start/finish straight. Widened to
  // 20m.
  { t: 'corner', r: 58, deg: 56, bank: 8, w: 20, tag: 'T14-tight' },
]

const built = circuit(SEGS, {
  spacing: SPACING,
  start: [0, START_Y, 0],
  heading: 0,
  defaults: { w: 17.5, surface: 'metal', bounce: true },
  minStraight: 40,
})

/**
 * Remove the one node the Holo Ring duplicates on its way out -- see the
 * header note. Anything else this coincident (there is nothing else in this
 * lap) would be removed the same way, which is why this walks the whole
 * array rather than special-casing the loop's index.
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
 * `neonspire.ts`'s theme) has to be placed on an actual node here.
 */
nodes[0].tag = 'start'
nodes[nodeNear(built.marks['maglev'])].tag = 'maglev'
nodes[nodeNear(built.marks['squeeze'])].tag = 'squeeze'
const iHoloring = nodeNear(built.marks['holoring'])
nodes[iHoloring].tag = 'holoring'

/**
 * THE HOLO RING'S APEX. The loop emits `steps+1` nodes (see circuit.ts's own
 * `loop` branch); its highest point is somewhere in that run, not
 * necessarily its midpoint once banking and the stagger are accounted for, so
 * this finds the true maximum rather than assuming it.
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
    { at: (frac('maglevC') + frac('T14-tight')) / 2, count: 4, spread: 3.6 },
  ],
  chargeRuns: [
    { from: frac('start') + 0.005, to: frac('T1-tight') - 0.01, count: 7, lateral: -4 },
    { from: frac('maglev') + 0.003, to: frac('T7') - 0.01, count: 5, lateral: 4 },
    { from: frac('lead-T10') + 0.005, to: frac('T10-hairpin') - 0.015, count: 6, lateral: 0 },
    { from: frac('T13') + 0.005, to: frac('squeeze') - 0.01, count: 5, lateral: -4 },
    { from: frac('maglevC') + 0.003, to: frac('T14-tight') - 0.01, count: 7, lateral: 4 },
  ],
  laps: 3,
}
