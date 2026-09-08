import type { TrackDef } from '../../sim/track'

/**
 * RUSTFALL — Junkyard Planet.
 * Easy, wide and legible: the first track a new player sees.
 * Beats follow the GDD: primary straight, Class C hairpin, crane drop zone,
 * Class A Tier-4 sweeper, chasm jump, bounce corridor, cargo ring, esses home.
 */
export const RUSTFALL: TrackDef = {
  id: 'rustfall',
  name: 'Rustfall',
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
    { p: [0, 0, 0], w: 19.5, surface: 'tarmac', tag: 'start' },
    { p: [0, 0, 105], w: 19.5, surface: 'tarmac', ramp: 32, tag: 'ramp-main' },
    { p: [0, 1.5, 210], w: 19.5, surface: 'tarmac' },
    { p: [0, 3, 315], w: 18.75, surface: 'tarmac' },
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
    { p: [0, 4, 415], w: 18, surface: 'tarmac', tag: 'straight-end' },
    { p: [-14, 4, 468], w: 16.5, bank: 4, surface: 'tarmac' },
    { p: [-44, 3.5, 486], w: 15.75, bank: 9, surface: 'tarmac', tag: 'hairpin' },
    { p: [-74, 3, 468], w: 15.75, bank: 9, surface: 'tarmac' },
    { p: [-88, 2.5, 424], w: 16.5, bank: 4, surface: 'tarmac' },
    { p: [-90, 2, 350], w: 18, surface: 'oil', tag: 'crane-drop' },
    { p: [-90, 1, 285], w: 18, surface: 'metal', ramp: 28, tag: 'ramp-crane' },
    { p: [-92, 0, 220], w: 18.75, surface: 'tarmac' },
    { p: [-104, 0, 150], w: 19.5, bank: 11, surface: 'metal', tag: 'sweeper-T4' },
    { p: [-140, 1, 96], w: 19.5, bank: 14, surface: 'metal' },
    { p: [-192, 2, 66], w: 19.5, bank: 14, surface: 'metal' },
    { p: [-250, 2.5, 62], w: 19.5, bank: 12, surface: 'metal' },
    { p: [-306, 3, 86], w: 19.5, bank: 9, surface: 'metal' },
    { p: [-346, 4, 132], w: 18.75, bank: 5, surface: 'metal' },
    { p: [-362, 6, 190], w: 18, boost: true, ramp: 34, surface: 'metal', tag: 'ramp-chasm' },
    { p: [-366, 9, 232], w: 16.5, open: true, surface: 'metal' },
    { p: [-368, 5, 300], w: 18, open: true, surface: 'metal', tag: 'landing' },
    { p: [-368, 3, 352], w: 18.75, surface: 'tarmac' },
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
    { p: [-356, 2, 404], w: 12.75, bounce: true, surface: 'tarmac', tag: 'bounce' },
    { p: [-330, 1.5, 444], w: 12, bounce: true, surface: 'tarmac' },
    { p: [-292, 1, 470], w: 12, bounce: true, surface: 'tarmac' },
    { p: [-250, 1, 480], w: 12.75, bounce: true, surface: 'tarmac' },
    { p: [-210, 1, 468], w: 15, surface: 'gravel' },
    { p: [-176, 1.5, 436], w: 16.5, bank: 22, surface: 'gravel', tag: 'ring' },
    { p: [-158, 3.5, 392], w: 16.5, bank: 34, surface: 'metal' },
    { p: [-160, 5.5, 344], w: 16.5, bank: 34, surface: 'metal' },
    { p: [-182, 6, 306], w: 16.5, bank: 22, surface: 'gravel' },
    { p: [-218, 5, 288], w: 18, bank: 8, surface: 'metal' },
    { p: [-256, 4, 268], w: 18, bank: -8, surface: 'tarmac', tag: 'esses' },
    { p: [-268, 3, 216], w: 18, bank: -12, surface: 'tarmac' },
    // The return leg crosses back over the sweeper-T4 entry, so it climbs onto
    // a flyover. Plan separation alone was 18m against 26m of combined width,
    // which folded the ribbon through itself and made Track.project ambiguous.
    { p: [-244, 5, 172], w: 18, bank: 10, surface: 'metal' },
    { p: [-196, 8, 152], w: 18.75, bank: 10, surface: 'metal', tag: 'flyover' },
    { p: [-146, 10, 156], w: 19.5, bank: 4, surface: 'metal' },
    { p: [-104, 10, 132], w: 19.5, bank: -6, surface: 'metal', tag: 'flyover-cross' },
    { p: [-80, 5, 88], w: 19.5, bank: -8, surface: 'metal', ramp: 24, tag: 'ramp-descent' },
    { p: [-70, 1.5, 40], w: 19.5, bank: -4, surface: 'tarmac' },
    // FINAL CORNER, rebuilt for the 50% width pass.
    //
    // The authored version was a squashed oval that ran a 19.7m radius against
    // an 18m half-width, so the inside edge folded through itself -- the ribbon
    // self-intersection the geometry test guards. Deepening it was not enough:
    // the curvature was concentrated at the apex, so opening the loop just moved
    // the pinch to the exit.
    //
    // It is now laid out as an actual semicircle: centre (-32, -40), radius 32,
    // which is the widest 180 given the 64m separation between the two legs
    // (x = -64 inbound, x = 0 outbound). Constant radius means the curvature is
    // spread evenly instead of spiking, and 32 against an 18m half-width leaves
    // 14m of margin -- room for the next width pass, if there is one.
    { p: [-64, 0, 0], w: 18.75, bank: 6, surface: 'tarmac', tag: 'final-corner' },
    { p: [-64, 0, -40], w: 18, bank: 12, surface: 'tarmac' },
    { p: [-57.6, 0, -59.3], w: 18, bank: 14, surface: 'tarmac' },
    { p: [-40.8, 0, -70.8], w: 18, bank: 14, surface: 'tarmac' },
    { p: [-20.5, 0, -69.9], w: 18, bank: 14, surface: 'tarmac' },
    { p: [-4.9, 0, -57.0], w: 18.75, bank: 10, surface: 'tarmac' },
    { p: [0, 0, -40], w: 19.5, bank: 4, boost: true, surface: 'tarmac', tag: 'home-boost' },
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
