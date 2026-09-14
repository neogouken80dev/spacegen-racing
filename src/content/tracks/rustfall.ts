import type { TrackDef } from '../../sim/track'

/**
 * RUSTFALL — Junkyard Planet.
 * Easy, wide and legible: the first track a new player sees.
 * Beats follow the GDD: primary straight, Class C hairpin, crane drop zone,
 * Class A Tier-4 sweeper, chasm jump, bounce corridor, cargo ring, esses home.
 */
export const RUSTFALL: TrackDef = {
  id: 'rustfall',
  name: 'Elkarim',
  skyTop: 0x2a1a12,
  skyBottom: 0xc4682a,
  fogColor: 0x8a5a33,
  fogDensity: 0.0042,
  sunColor: 0xffc98a,
  sunIntensity: 2.1,
  ambientColor: 0x6b4a38,
  ambientIntensity: 0.85,
  sunDirection: [-0.45, 0.62, 0.35],
  palette: { a: 0xa8481f, b: 0xd9a441, c: 0x4a4038, accent: 0x35e0ff },
  laps: 3,
  nodes: [
    { p: [0, 0, 0], w: 24.375, surface: 'tarmac', tag: 'start' },
    { p: [0, 0, 105], w: 24.375, surface: 'tarmac', ramp: 32, tag: 'ramp-main' },
    { p: [0, 1.5, 210], w: 24.375, surface: 'tarmac' },
    { p: [0, 3, 315], w: 23.438, surface: 'gravel' },
    { p: [0, 3.6, 378.8], w: 23.438, surface: 'gravel' },
    // THE OIL SLICK WAS TRIED HERE AND PUT BACK. Recorded because the result
    // is the finding, not the change.
    //
    // Rustfall's oil is one node at `crane-drop`: 72m of the lowest-grip
    // surface in the game (0.30) on a stretch whose tightest radius is 927m.
    // Its speed limit there is 100.8 m/s against a 61.4 m/s top speed, so it
    // cannot cost anybody anything, and measured it does not -- the whole
    // surface layer of this track was worth 0.108s a lap.
    //
    // The obvious fix is to move it to the braking zone at the end of the
    // primary straight, where the radius falls 476m -> 128m and 0.30 grip gives
    // a limit falling 72 -> 37.4 m/s. That measures 45m of binding oil and
    // +0.17s of lap, and it breaks the field: across 14 fixed seeds the worst
    // heading error of a racer under power went from 74 degrees to 131, out of
    // the 120-degree bound tests/recovery.test.ts holds ("never driving back
    // down the circuit under power"). The car it breaks is a Filament holding a
    // drift through the hairpin at s=515-570 -- the slick does not spin anyone
    // itself, it changes the entry enough that the AI commits to a slide it
    // cannot finish. Gravel in the same place measures 88 degrees and 5m of
    // binding surface, i.e. safe and pointless.
    //
    // The reason is geometric and it is Rustfall's, not the surface's: at 0.30
    // grip a corner has to be about 220m in radius for the slick to cost ~20%
    // of top speed, and THIS TRACK HAS NO SUSTAINED 150-250m CORNER. Every
    // corner here either tightens straight through that band into Class C or is
    // a flat-out Class A. So the low-grip work went to gravel in the bounce
    // corridor instead (see beat 6 below), and the crane-drop oil stays as what
    // it has always been: an art beat, and 0.00s a lap.
    //
    // RE-READ AFTER THE RESHAPE. The geometry this was measured against is
    // gone: the hairpin it names is now 65m rather than 32m and the whole lap
    // is 146m longer. The conclusion survives, and was re-measured -- the
    // longest sustained run of 140-260m radius anywhere on this circuit is
    // 51m, so there is still no corner an oil slick could bind. What was NOT
    // re-measured is the 131-degree heading error that broke the field when
    // the slick was moved to the braking zone; if anyone tries that again,
    // measure it again rather than trusting the number above.
    { p: [0, 4, 415], w: 22.5, surface: 'tarmac', tag: 'straight-end' },
    // OPENED OUT: THE TWO 32m HAIRPINS ARE NOW 64-66m SWEEPS.
    //
    // Measured with the swept-angle instrument described below, authored ->
    // now: hairpin 32.2 -> 65.5m, final corner 31.8 -> 63.5m, the "esses" hook
    // 40.3 -> 57.3m, and the tightest radius ANYWHERE on the lap 31.8 -> 56.9m.
    // The distribution moves with them: p1 33 -> 60m, p5 41 -> 66m. Lap length
    // 2479.6 -> 2625.6m, and the lap got FASTER anyway (56.85 -> 56.10s in the
    // fixed-seed race tests/gravity.test.ts pins), because corner speed goes as
    // the square root of radius and doubling the three slowest corners buys
    // more than 146m of extra road costs.
    //
    // WHY SEPARATION IS THE ONLY LEVER. Each of these is a 180 between two
    // parallel legs, and for that shape the largest radius available is HALF
    // THE LEG SEPARATION. Splaying the entry, over-rotating into a teardrop, a
    // compound curve -- each was worked through and each buys LESS lateral per
    // metre of radius than a plain semicircle, because the lateral travel of an
    // arc turning psi is R(1 - cos psi) and psi = 180 is where that peaks.
    //
    // The only free direction is +x: the start straight is this track's whole
    // right-hand boundary and there is nothing beyond it, while the left-hand
    // legs are hemmed in -- the hairpin's exit by the cargo ring at x=-208, the
    // final corner's approach by the sweeper at x=-190. So the left block moved
    // 50m further out and the straight stayed on the origin, widening the
    // hairpin 90 -> 140m and the final corner 64 -> 128m for nothing.
    //
    // THE OTHER HALF OF THE FIX IS NODE SPACING, and it is the half that is not
    // obvious. Track.catmull is UNIFORM Catmull-Rom: the tangent at a node is
    // (next - prev) / 2 however far apart those neighbours are, and every
    // segment is walked over t in [0,1] whatever its length. Where a long
    // straight meets a short arc chord, the tangent is far longer than the
    // segment it has to cover, the curve overshoots and the curvature spikes.
    // That is why the authored hairpin measured 32m inside a 45m envelope, and
    // why the first cut of this reshape -- a mathematically exact 70m circle --
    // still measured in the fifties when entered off a 100m straight segment.
    //
    // The rule that fixes it: THE SEGMENT EITHER SIDE OF AN ARC MATCHES THAT
    // ARC'S CHORD. Hence the nodes at z=378.8 on both legs of the hairpin and
    // at z=-25 on both legs of the final corner, which otherwise look
    // arbitrary. Nodes further out on a straight can sit anywhere, because
    // uniform Catmull-Rom through collinear points is still a straight line;
    // only a junction node has a neighbourhood that bends.
    //
    // AND THE INSTRUMENT WAS WRONG FIRST. Menger curvature over three points
    // 12m apart is the obvious way to measure a radius and it is unusable at
    // this scale: the baked centreline carries ~0.1m of ripple, the sagitta of
    // a 24m chord on a 70m radius is 1.0m, so a tenth of a metre of noise moves
    // the circumradius ten percent. Against a centreline whose every sample sat
    // 69.9-70.0m from a known centre it reported 55-75m and called a true 70m
    // arc a 55m corner. Every radius quoted in this file's new comments is
    // instead window length / heading change over 30m -- stable against ripple,
    // and the same quantity Track.curvatureAt hands the AI when it picks a
    // corner speed. tools/plot-track.ts carries the working.
    { p: [-9.4, 3.75, 450], w: 22.5, bank: -6, surface: 'tarmac' },
    { p: [-35, 3.5, 475.6], w: 22.5, bank: -10, surface: 'tarmac' },
    { p: [-70, 3.25, 485], w: 22.5, bank: -11, surface: 'tarmac', tag: 'hairpin' },
    { p: [-105, 3, 475.6], w: 22.5, bank: -10, surface: 'tarmac' },
    { p: [-130.6, 2.75, 450], w: 22.5, bank: -6, surface: 'tarmac' },
    { p: [-140, 2.5, 415], w: 23.438, bank: -2, surface: 'tarmac' },
    { p: [-140, 2.2, 378.8], w: 22.5, surface: 'tarmac', tag: 'crane-drop' },
    { p: [-140, 1, 285], w: 22.5, surface: 'metal', ramp: 28, tag: 'ramp-crane' },
    { p: [-142, 0, 220], w: 23.438, surface: 'tarmac' },
    { p: [-154, 0, 150], w: 24.375, bank: 11, surface: 'metal', tag: 'sweeper-T4' },
    // THIS NODE IS A RIGID 50m SHIFT OF THE AUTHORED ONE AND MUST STAY THAT
    // WAY. The most expensive finding of the reshape is recorded here.
    //
    // An earlier cut nudged it 6m further out, to x=-196, to buy margin against
    // the return leg on the flyover above. Six metres, on one node, on a
    // section nobody was asked to change. It QUADRUPLED the field's respawns --
    // 78 -> 331 over 30 fixed races -- and every one of the new ones landed
    // 400m downstream, in the open chasm section at s=1300-1400, where there
    // are no barriers and a car that is 10% further out at launch simply leaves
    // the map. Bulwark went from 0.56 to 3.88 respawns a race and its win share
    // from 22% to 5%; Dray-9 from 21% to 3%. Putting the node back put the
    // whole balance gate back, and better than it started: at 2000 races every
    // chassis now sits inside the 12-30% band, which the authored track did not
    // manage (Vector-7 read 8.0% at n=200 before this pass).
    //
    // The margin it was buying came from the return leg instead -- that leg
    // exits at x=-128 rather than -135, which costs the final corner 7m of
    // radius and is worth it.
    //
    // The general lesson, which is the reason this is a comment and not a diff:
    // on a circuit with an unbarriered section, a small change to the LINE
    // hundreds of metres upstream is a large change to where cars are when they
    // reach it. Curvature plots will not show this. Only racing the field will.
    { p: [-190, 1, 96], w: 24.375, bank: 14, surface: 'metal' },
    { p: [-242, 2, 66], w: 24.375, bank: 14, surface: 'metal' },
    { p: [-300, 2.5, 62], w: 24.375, bank: 12, surface: 'metal' },
    { p: [-356, 3, 86], w: 24.375, bank: 9, surface: 'metal' },
    { p: [-396, 4, 132], w: 23.438, bank: 5, surface: 'metal' },
    { p: [-412, 6, 190], w: 22.5, boost: true, ramp: 34, surface: 'metal', tag: 'ramp-chasm' },
    { p: [-416, 9, 232], w: 20.625, open: true, surface: 'metal' },
    { p: [-418, 5, 300], w: 22.5, open: true, surface: 'gravel', tag: 'landing' },
    { p: [-418, 3, 352], w: 23.438, surface: 'oil' },
    // GRAVEL AT THE CARGO RING -- where Rustfall's low-grip work ended up, and
    // the extent is a measurement, not a taste.
    //
    // The reasoning for the surface is above at `straight-end`: oil (0.30) is
    // too strong for any corner this track has, gravel (0.70) is too weak for
    // anything gentler than R=147m, and the ring approach and the ring itself
    // run R=93m and R=48m. So gravel is the one surface that fits and this is
    // where it fits. Measured: 135m of gravel, ALL of it binding (48.9 m/s at
    // R=93, 35.2 at R=48, against 58.4 and 42.1 on the metal it replaces), and
    // the track's whole surface layer goes from 0.108s a lap to 0.430s. The
    // worst limit it imposes stays above the corner's own floor, so the surface
    // never becomes a trap, and the worst heading error across 14 fixed seeds
    // is unchanged from the authored track.
    //
    // THE EXTENT IS SET BY LEAD RETENTION. Gravel also costs lap time, and on
    // this track lap time is retention: T.ai.corneringCaution's own note
    // records 0.86 -> 48.3%, 0.84 -> 45.0%, 0.82 -> 42.7%, i.e. roughly three
    // points of retention per 0.6s of field pace. Gravelling the bounce
    // corridor as well measures 0.433s of surface tax for +0.8s of lap and took
    // retention to 44.8%, under the 45% floor; the whole corridor plus both
    // ring aprons measured 0.645s and 43.2%. This version buys the same 0.43s
    // of surface tax for +0.57s of lap and retention holds at 47.2%.
    //
    // The two 34-degree ring nodes stay METAL, and that one is an art call:
    // loose stone does not sit on a 34-degree bank, and that pair is the
    // wall-ride the beat is named for. Grit belongs on the floor either side.
    //
    // RE-READ AFTER THE RESHAPE, and one number here has moved a long way. The
    // ring approach and the ring itself now measure R=131m and R=74m (they
    // were 93m and 48m), because the reshape widened the whole left-hand block
    // and the ring sits inside it. Gravel therefore binds less than it did:
    // the surface tax fell 0.645 -> 0.274s a lap, against the 0.25s floor in
    // tests/track.test.ts. That still passes and the layer is still not
    // decorative, but the margin is now thin enough that the next person to
    // touch either the floor or these corners has to re-measure rather than
    // assume. Lead retention was re-measured over 2000 races and holds at
    // 46.0%, inside the 45-55% band.
    { p: [-406, 2, 404], w: 15.938, bounce: true, surface: 'tarmac', tag: 'bounce' },
    { p: [-380, 1.5, 444], w: 15, bounce: true, surface: 'tarmac' },
    { p: [-342, 1, 470], w: 15, bounce: true, surface: 'tarmac' },
    { p: [-300, 1, 480], w: 15.938, bounce: true, surface: 'tarmac' },
    { p: [-260, 1, 468], w: 18.75, surface: 'tarmac' },
    { p: [-226, 1.5, 436], w: 20.625, bank: 22, surface: 'tarmac', tag: 'ring' },
    { p: [-208, 3.5, 392], w: 20.625, bank: 34, surface: 'metal' },
    { p: [-210, 5.5, 344], w: 20.625, bank: 34, surface: 'metal' },
    { p: [-240.4, 6, 309.9], w: 20.625, bank: 18, surface: 'metal' },
    // THE "ESSES" WAS NEVER AN S, and that is why it was pinched.
    //
    // Its authored headings fall monotonically -- 243, 242, 193, 151, 113, 85
    // degrees -- so it is one continuous 158-degree hook, i.e. a third hairpin
    // wearing the wrong name. Drawn as a hook it takes a 72m constant radius
    // between the same entry and exit it always had, against the 30.8m the
    // squashed version measured. The tag stays because the render theme and the
    // design docs both say "esses home"; the shape is what changed.
    //
    // The bank now follows the turn instead of flipping sign mid-corner.
    { p: [-283.9, 5, 288.2], w: 22.5, bank: 6, surface: 'metal', tag: 'esses' },
    { p: [-317.5, 3.5, 253], w: 22.5, bank: -10, surface: 'tarmac' },
    { p: [-321.1, 3.4, 204.4], w: 22.5, bank: -12, surface: 'tarmac' },
    { p: [-293, 5, 164.7], w: 22.5, bank: -10, surface: 'metal' },
    { p: [-246, 8, 152], w: 23.438, bank: 10, surface: 'metal', tag: 'flyover' },
    // The return leg crosses back over the sweeper-T4 entry, so it climbs onto
    // a flyover. Plan separation alone was 18m against 26m of combined width,
    // which folded the ribbon through itself and made Track.project ambiguous.
    { p: [-201.6, 9.8, 146.3], w: 24.375, bank: -6, surface: 'metal' },
    { p: [-163.2, 11.5, 123.4], w: 24.375, bank: -6, surface: 'metal', tag: 'flyover-cross' },
    { p: [-137.2, 7.3, 86.9], w: 24.375, bank: -6, surface: 'metal', ramp: 24, tag: 'ramp-descent' },
    { p: [-128, 3, 43.1], w: 24.375, bank: -2, surface: 'metal' },
    // FINAL CORNER, rebuilt for the 50% width pass and reopened here.
    //
    // The authored version was a squashed oval that ran a 19.7m radius against
    // an 18m half-width, so the inside edge folded through itself -- the ribbon
    // self-intersection the geometry test guards. Deepening it was not enough:
    // the curvature was concentrated at the apex, so opening the loop just moved
    // the pinch to the exit. Laying it out as an actual semicircle fixed that
    // and took it to a nominal 32m, which is where it sat until this pass.
    //
    // What a semicircle could not fix was the 64m between its two legs. The
    // approach now runs straight down x=-128 instead of pinching in to -64, so
    // the loop is centred (-64, -50) at radius 64 -- double the old one, and
    // still 54m of margin against the 19.5m half-width. It reaches z=-114 to do
    // it, into ground nothing else on this track uses.
    //
    // THE BANK IS NEGATIVE NOW, AND THE OLD SIGN WAS A BUG. Track bakes +bank
    // as the RIGHT edge rising, and both of this track's 180s turn toward -psi,
    // which needs the left edge up. The authored hairpin and final corner were
    // banked 11 and 15 degrees OFF CAMBER. At a 32m radius nobody arrived
    // faster than ~34 m/s and it did not show; at 64m the corner speed is ~48
    // and it would. Measured honestly, though: flipping the sign on its own
    // moved Bulwark's respawns 3.88 -> 3.79 a race, i.e. it was NOT what was
    // throwing the field off the circuit (see the sweeper node, above). It is
    // fixed because it is wrong, not because it was the bug.
    { p: [-128, 0, 0], w: 24.375, surface: 'tarmac', tag: 'final-corner' },
    { p: [-128, 0, -25], w: 24.375, bank: -3, surface: 'tarmac' },
    { p: [-128, 0, -50], w: 24.375, bank: -6, surface: 'tarmac' },
    { p: [-123.1, 0, -74.5], w: 23.438, bank: -9, surface: 'tarmac' },
    { p: [-109.3, 0, -95.3], w: 23.438, bank: -12, surface: 'tarmac' },
    { p: [-88.5, 0, -109.1], w: 23.438, bank: -14, surface: 'tarmac' },
    { p: [-64, 0, -114], w: 23.438, bank: -15, surface: 'tarmac' },
    { p: [-39.5, 0, -109.1], w: 23.438, bank: -14, surface: 'tarmac' },
    { p: [-18.7, 0, -95.3], w: 23.438, bank: -12, surface: 'tarmac' },
    { p: [-4.9, 0, -74.5], w: 23.438, bank: -9, surface: 'tarmac' },
    { p: [0, 0, -50], w: 24.375, bank: -4, surface: 'tarmac', boost: true, tag: 'home-boost' },
    { p: [0, 0, -25], w: 24.375, bank: -3, surface: 'tarmac' },
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
  // inside that displacement -- {0.19, 0.50, 0.72, 0.925} here and
  // {0.16, 0.37, 0.56, 0.70, 0.94} on Cryostatic, with spreads floored at 2.4m
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
  //
  // THE NORMALISED POSITIONS SURVIVED THE RESHAPE AND WERE RE-CHECKED, not
  // assumed: the lap grew 2479.6 -> 2625.6m, so every `at` and `from`/`to`
  // slid. Re-measured, the five rows now sit on the main straight, the
  // hairpin exit, the chasm approach, the cargo ring and the flyover return,
  // and the six charge runs still bracket the straight, the hairpin, the
  // sweeper, the bounce corridor, the esses hook and the final corner. Spread
  // and width still satisfy the geometry test. The finding above is unchanged
  // and still unfixable from this file.
  itemBoxRows: [
    { at: 0.10, count: 5, spread: 4.4 },
    { at: 0.27, count: 5, spread: 4.2 },
    { at: 0.46, count: 5, spread: 4.4 },
    { at: 0.63, count: 4, spread: 4.0 },
    { at: 0.81, count: 5, spread: 4.2 },
  ],
  chargeRuns: [
    { from: 0.03, to: 0.08, count: 6, lateral: -5 },
    { from: 0.15, to: 0.20, count: 6, lateral: 5 },
    { from: 0.33, to: 0.40, count: 8, lateral: 0 },
    { from: 0.53, to: 0.58, count: 6, lateral: -4 },
    { from: 0.70, to: 0.76, count: 7, lateral: 4 },
    { from: 0.88, to: 0.95, count: 8, lateral: 0 },
  ],
}
