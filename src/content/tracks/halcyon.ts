import type { TrackDef, TrackNode } from '../../sim/track'
import { circuit, type Seg } from './circuit'

/**
 * ===========================================================================
 * HALCYON BAY -- Tidal Coast.
 * ===========================================================================
 *
 * The seventh circuit, rebuilt on the corner-based `circuit()` builder in
 * place of the harmonic ring (`ring()`) it shipped with. The reason is the
 * report that killed the four harmonic circuits: "the overall oval or
 * square-ish type design does not offer a lot of variety in driving
 * experience... the few turns are far too sharp to allow smooth drifts".
 * A ring summed from three or four sine terms has no straights, no braking
 * zones, and radii that fall out of the coefficients rather than being
 * chosen -- see `circuit.ts` for the full argument and the measured band
 * table. This file applies the fix to Halcyon Bay specifically: a real
 * sequence of straight, corner, straight, authored corner by corner, with
 * radii picked from the measured speed bands instead of left to drift.
 *
 * ---------------------------------------------------------------------------
 * 1. WHAT "EASY" IS BUILT OUT OF HERE, AND WHAT DID NOT SURVIVE THE REWRITE.
 *
 * Difficulty is still a structural choice, not a mood: every other circuit in
 * the roster is Medium or Hard, and this is the one place (with Namaresh) a
 * new player gets a second opinion on what a corner feels like. Three things
 * build that "Easy", and the rewrite keeps all three exactly:
 *
 *   - WIDTH. 23-27m half-width on this lap against 17-21m on the rest of the
 *     roster -- see the `w` on every segment below. A bad entry costs a wide
 *     line, not a lap.
 *   - NO SURFACE BELOW GRIP 0.70. Dry sand is `gravel` (0.70) through the
 *     dunes; wet packed sand and the boardwalk are `tarmac` (1.0) everywhere
 *     else. No ice, no oil, anywhere on the circuit.
 *   - FORGIVING EDGES. `open: true` runs the length of the tideline and
 *     nowhere else -- the beach continues past the verge there, so running
 *     wide costs time on sand, not a wall. Where the lap DOES fence you in,
 *     the dunes use `bounce` (dune fencing catches a car rather than
 *     scrubbing or launching it) and everything else is an ordinary wall,
 *     which is exactly where a beginner expects a boardwalk railing or a pier
 *     rail to be.
 *
 * What did NOT survive: the crosswind. The harmonic version carried a
 * moderate (10 m/s^2) sea breeze over the dunes, ramped and behind `bounce`
 * walls, and it never caused trouble on that geometry. This rewrite is held
 * to a tighter bar than the repo default, though (<=1.0 respawns a race,
 * where the general gate allows 3.0), and the corner-based dune section below
 * is a genuinely different curvature profile -- two real corners and a jump,
 * not one continuous bend -- that has never been measured against wind.
 * Re-tuning a crosswind for a shape that did not exist yet is exactly the
 * unforced risk an Easy circuit's respawn budget should not carry, so it is
 * left out here. The dune fences stay in as scenery on their own merits, and
 * nothing stops a later pass from re-introducing a breeze once this shape has
 * raced and its margins are known.
 *
 * It is still the fastest lap in the game by design: the tideline is a
 * genuine flat-out straight leading into two sweepers that never ask for a
 * lift, and only one corner on the whole circuit asks for real braking.
 *
 * ---------------------------------------------------------------------------
 * 2. THE CORNER SEQUENCE, BAND BY BAND.
 *
 * Twelve corners (the harmonic ring drew two to four). Radius bands, from
 * `circuit.ts`'s measurement at this grip model (corner speed = sqrt(1.07 *
 * 34 * R), roster top speed 59-64 m/s):
 *
 *   45-58m   hairpin, 62-74% of top speed, heavy braking     -- ONE corner
 *   58-80m   medium, 74-88%, the corners a driver actually   -- SIX corners
 *            drifts
 *   80-110m  fast, 88-103%, a lift and a commitment          -- THREE corners
 *   110-220m sweeper, flat out, still a corner to the AI     -- TWO corners
 *
 * Nine of twelve corners sit in the medium/fast bands: the lap's weight is
 * exactly where a coast road's should be, "the corners a driver actually
 * drifts". The one hairpin (Lagoon Hook, 50m) sits at the LOOSE end of its
 * band on purpose -- this is the circuit where the hardest corner should
 * still be forgiving -- and it gets the widest road on the lap (27m) and the
 * longest straight on the whole lap ahead of it (Brake Zone, ~210m closed)
 * to set up for it. See the per-segment comments below for why each radius
 * is what it is; nothing here is a corner sprung on a driver with no warning.
 *
 * A fixed defect, not a caveat: earlier passes on this circuit (and
 * Ashkar's, independently) reported `probe-newtrack`'s corner census showing
 * a "tightest" radius well under 45m that matched no authored corner here --
 * a phantom hairpin sitting right at the Pier loop's mouth. That was never
 * this file's geometry; it was `circuit.ts`'s own loop crossing, which used
 * to run symmetrically (-stagger/2 to +stagger/2) and put a half-stagger
 * SIDEWAYS STEP at each mouth, steep enough to read to `curvatureAt` as
 * tight "steering" curvature nobody authored. `circuit.ts` now runs the
 * crossing 0 -> stagger instead (see its own comment on the loop segment
 * below for the full mechanism), which removes the step entirely -- this
 * lap's own census now bottoms out at a real 47m, comfortably inside the
 * medium band, not an artifact left to explain away.
 *
 * ---------------------------------------------------------------------------
 * 3. FEATURE MIX: ONE LOOP, TWO JUMPS, NO CYCLONE, NO TUNNEL.
 *
 * The roster's four newest circuits split the set pieces between them rather
 * than each carrying one of everything -- that division is itself part of
 * what stops them reading as copies of each other. Halcyon Bay carries the
 * Pier loop and two ramps (the dune crest, and a hop over the tidal channel
 * by the pier); no corkscrew, and nothing enclosed -- this is open coastline
 * and a tunnel has no fictional home on it. Both jumps and the loop are
 * geodesics as far as `curvatureAt` is concerned (see the note on the loop's
 * `up` vector in part 4), so none of them can throw a new player into a
 * wall. They are spectacle, not difficulty.
 *
 * ---------------------------------------------------------------------------
 * 4. WHY `build()` POST-PROCESSES `circuit()`'S OUTPUT INSTEAD OF RETURNING
 *    IT DIRECTLY.
 *
 * `circuit()` records where a tagged segment STARTS in `built.marks` (a plan
 * distance), but it never writes a tag onto the `TrackNode`s it emits --
 * `Attrs.tag` exists purely for that bookkeeping. The theme, though, reads
 * `TrackNode.tag` directly (`ctx.tagSample` does a literal `.find(n => n.tag
 * === tag)` over `def.nodes`), and it needs FIVE of them here: `start`,
 * `dunes` (first gravel), `tideline` (first open coastal stretch), `pier`
 * (the loop) and `pier-apex` (the top of the loop, a concept `circuit()`
 * itself has no notion of). So `build()` below replays the exact node-count
 * arithmetic `circuit()`'s own `walk()` uses -- per segment type, against the
 * CLOSED straight lengths it actually settled on, not the authored ones -- to
 * find which node index each tag lands on, tags those five nodes directly,
 * and only then returns the array. The apex is simply the highest node inside
 * the loop's own index range once that range is known.
 *
 * The same pass also drops one node. A vertical loop's own last sample (its
 * exit, at a full turn) and the very next segment's first sample are not
 * merely close -- they are bit-identical, because `sin`/`cos` of a full turn
 * are exactly 0 and 1 and both computations reduce to the same expression.
 * Left in, that is a zero-length span: a degenerate Catmull-Rom knot, and an
 * infinite chord ratio. Dropping the duplicate costs nothing, so `build()`
 * does that too, generically, in case a future pass adds a second loop.
 *
 * ---------------------------------------------------------------------------
 * 5. THE SECOND PASS: A LOOP GUARD, AND ACTUALLY BEING THE FASTEST LAP.
 *
 * `circuit.ts` picked up two changes after this file first shipped: the loop
 * crossing fix in part 2, and a hard guard riding on it (loop radius >= 32m,
 * stagger <= 1.9x radius) -- the Pier loop's original stagger=78 at r=36
 * violated the second half of that (78 > 1.9*36 = 68.4) and the builder now
 * throws rather than emit it. Dropping to stagger=64 satisfies the guard
 * with room to spare, and the self-clearance story that justified 78 in the
 * first place -- measured 1.8m of overlap at the wrong `side`, 2.9m at the
 * right one -- no longer applies as written: the new 0->stagger crossing
 * separates the loop's approach and departure by the FULL stagger, not half
 * of it, so the same neighbourhood now clears by more than `probe-
 * selfclear`'s coarse pre-filter even bothers to measure (it reports the gap
 * as unbounded, because nothing ever gets close enough to trigger the exact
 * check). `side: -1` is kept for the same reason as before -- Harbor Left,
 * Harbor Right and Pier Exit Bend all turn the same way approaching and
 * leaving the loop, and `-1` crosses away from that curl -- though with this
 * much margin now, it was not re-tested against `side: 1`.
 *
 * The loop fix alone, with nothing else touched, dropped the mean lap from
 * 68.5s to 65.7s: that whole 2.8s was the old phantom corner costing a real,
 * if small, lift every lap for a corner that was never authored. Getting the
 * rest of the way to the 57-63s target took a second round, and two things
 * worth trying both measured against that 65.7s guard-fix baseline (r50
 * hairpin, every straight still at its original authored length):
 *
 *   - Softening Lagoon Hook alone from r50 to r56 -- easing the one hairpin,
 *     isolated from every other change -- made respawns WORSE (1.0 to
 *     2.7/race) for a 0.9s lap-time gain that was not worth it. Read after
 *     the fact this makes sense: more corner speed into a FIXED 125-degree
 *     direction change is more speed to carry through the same turn, not
 *     less to manage. It was not the intuitive result, and it is why Lagoon
 *     Hook is still r50 below -- measured, not assumed.
 *   - Opening Bay Sweep A/B toward 200m+, together with longer main
 *     straights and the softened hairpin above, measured SLOWER (70.5s) as a
 *     combination, not faster. The sweepers are the diagnosable part of
 *     that: both were already flat out at their OLD radii -- sqrt(1.07*34*
 *     140) is 71 m/s and sqrt(1.07*34*180) is 80 m/s, both comfortably past
 *     the 59-64 m/s roster ceiling -- so widening them bought no speed and
 *     only added arc length (`deg` is fixed by closure; a bigger `r` at the
 *     same `deg` is simply more metres of turn) for the closure solver to
 *     pay for.
 *
 * What actually worked was distance, taken from where the closure solver was
 * already spending it. Several straights here close much longer than their
 * authored length -- the dune group especially: 95m of authored `dunes`
 * closes at ~147m -- because the minimum-norm correction that shuts the lap
 * adds roughly the same correction to every straight sharing a heading, and
 * the dune group shares its heading with very little else on this lap.
 * Trimming THOSE authored lengths, plus a modest cut to the boardwalk and
 * the tideline, plus pulling both sweepers in toward the tight end of their
 * own band (r120/r155: still comfortably flat out by the same formula, just
 * less arc to cover) removes real metres without asking any corner to do
 * more work. The closure system's correction is GLOBAL, though, not local:
 * several combinations that looked like safe, independent trims instead
 * pushed some other straight under the 40m floor and tripped the automatic
 * uniform rescale, which grows every straight to compensate and made the lap
 * LONGER than before the trim. Every value below was checked against the
 * CLOSED length it actually produces, not the authored one, for exactly this
 * reason.
 *
 * Shrinking several straights also moved two of the six item-box rows and
 * two of the five charge runs -- both keyed to fixed lap FRACTIONS -- off
 * their intended straights and onto the corners next to them (Bay Sweep B
 * and Pier Exit Bend). A pickup mid-corner is exactly what the placement
 * comment by `itemBoxRows` rules out, so both sets were refit against the
 * new marks table; same six rows, same five runs, same rough intent, landing
 * where they were meant to again.
 *
 * End state: 61.3s mean lap (was 68.5s before this pass, 65.7s after just
 * the guard fix), chord ratio 1.66 (was 2.96), respawns 0.3/race,
 * self-clearance past what the probe can even measure.
 */

const DEG = Math.PI / 180
/**
 * Metres between emitted nodes on straights and corners. The loop uses its
 * own, coarser formula (`circuit.ts`, independent of `SPACING`), which used
 * to be where the measured chord ratio came from -- a phantom curvature spike
 * at the loop's mouth pushed it to 2.96 in earlier passes on this lap. With
 * that spike fixed upstream (part 2 below) the measured ratio is 1.66, close
 * to the 1.0 a perfectly smooth road would read and comfortably inside the
 * <3.5 gate; see `build()`'s dedup pass below for the one seam that would
 * otherwise be a literal zero regardless.
 */
const SPACING = 24

/**
 * THE LAP. Straight, corner, straight -- in the order a car meets them,
 * start/finish first. Every corner's comment gives its band and, briefly, why
 * that radius: what it is doing to the lap, not just what it measures.
 */
const SEGS: Seg[] = [
  // ---- THE BOARDWALK. The front straight, timber underfoot, golden-hour sun
  // raking down it. Long enough to reach real speed before Headland asks for
  // the first lift.
  { t: 'straight', len: 180, tag: 'start', toY: 20 },

  // HEADLAND -- fast, r95 (fast band, 88-103%). The road leaves the boardwalk
  // and sweeps around the first headland: a lift, not a brake, and the first
  // taste of bank.
  { t: 'corner', r: 95, deg: 70, bank: 6, toY: 23, tag: 'headland' },

  // ---- Into the dunes. Dry sand from here (`gravel`, 0.70) until the lap
  // drops back to the coast -- this is the FIRST gravel segment, so it is
  // where the `dunes` tag the theme reads for its marram grass and dune
  // fencing has to land.
  { t: 'straight', len: 95, tag: 'dunes', surface: 'gravel', toY: 27 },

  // DUNE HOLLOW -- medium, r70 (medium band, 74-88%). The first corner a
  // driver is actually meant to drift: threading a dip between two dunes,
  // gravel underneath so the rear steps out a little easier than the tarmac
  // corners do.
  { t: 'corner', r: 70, deg: 65, bank: 7, w: 23, surface: 'gravel', bounce: true, toY: 29, tag: 'dune-hollow' },

  { t: 'straight', len: 75, w: 23, surface: 'gravel', bounce: true, toY: 33, tag: 'dune-crest' },

  // THE DUNE JUMP. Launches at the highest point on the lap (33m) and lands
  // 9m lower on the far side of the dune field -- a real drop, not a hop.
  // launch=28 matches the ramp the harmonic version shipped with (roughly 1.6s
  // of hang time at this track's gravity), which is a known-comfortable pad
  // rather than a fresh guess.
  { t: 'jump', len: 170, launch: 28, gap: 48, w: 23, surface: 'gravel', bounce: true, toY: 24, tag: 'dune-jump' },

  // DUNE HOOK -- medium, r62, LEFT (medium band). A direction change on
  // purpose: two rights in a row through the dunes would read as one long
  // bend rather than two corners, and Dune Hook is what turns the lap back
  // toward the coast.
  { t: 'corner', r: 62, deg: -60, bank: -6, w: 23, surface: 'gravel', bounce: true, toY: 20, tag: 'dune-hook' },

  { t: 'straight', len: 60, w: 23, surface: 'gravel', bounce: true, toY: 16, tag: 'dune-exit' },

  // ---- Back onto full-grip tarmac for the one corner on this circuit that
  // asks for a real brake. A loose surface under the hardest corner on an
  // Easy lap is the wrong kind of challenge; the dunes stay for the flowing
  // corners, and the hairpin gets its confidence back on solid ground.
  { t: 'straight', len: 155, toY: 13, tag: 'brake-zone' },

  // LAGOON HOOK -- the ONE hairpin, r50 (band 45-58, so 70% of top speed: the
  // loose end of the band, not the tightest 45m case). It hooks hard around a
  // tidal inlet, and everything about the approach is built to make it feel
  // fair rather than sudden: ~210m of dead-straight brake zone behind it (the
  // longest single straight on the whole lap, edging out even the tideline),
  // and w=27 -- wider than anywhere else on the circuit, wider even than the
  // tideline. Tried once at r56 to ease it further and reverted -- see part 5
  // of the file header for why a softer hairpin here measured WORSE.
  { t: 'corner', r: 50, deg: 125, w: 27, bank: 6, toY: 11, tag: 'lagoon-hook' },

  // ---- THE TIDELINE. Wet packed sand (`tarmac`, full grip) and the first
  // OPEN coastal segment: the beach runs on past the verge here, so drifting
  // wide costs sand time, never a wall. This is the fastest stretch on the
  // lap by feel -- flat out into two sweepers that never ask for a lift --
  // even though Brake Zone edges it out by a few metres on the tape measure;
  // the identity this whole circuit is built to deliver.
  { t: 'straight', len: 215, tag: 'tideline', open: true, w: 26, toY: 12 },

  // BAY SWEEP A -- sweeper, r120 (band 110-220: flat out, still registers as
  // a corner to the AI's drift-hold gate). The shoreline itself curving away;
  // nobody lifts here.
  { t: 'corner', r: 120, deg: 38, bank: 5, open: true, w: 26, toY: 13, tag: 'bay-sweep-a' },

  { t: 'straight', len: 105, open: true, w: 26, toY: 13, tag: 'tideline-mid' },

  // BAY SWEEP B -- sweeper, r155. A second, even gentler arc holding the
  // shoreline's curve -- the two sweepers together are most of what makes
  // this the fastest lap in the game.
  { t: 'corner', r: 155, deg: 32, bank: 4, open: true, w: 26, toY: 14, tag: 'bay-sweep-b' },

  { t: 'straight', len: 105, open: true, w: 26, toY: 14, tag: 'tideline-end' },

  // ---- The beach ends here; ordinary walls resume for the pier village.
  // HARBOR LEFT / HARBOR RIGHT -- medium, r66 then r74, opposite-handed: a
  // proper rhythm pair (the lap's only real esses) that bleeds speed off the
  // tideline before the Pier without ever asking for a full brake.
  { t: 'corner', r: 66, deg: -55, bank: -7, toY: 16, tag: 'harbor-left' },
  { t: 'straight', len: 70, toY: 17, tag: 'esses' },
  { t: 'corner', r: 74, deg: 58, bank: 7, toY: 18, tag: 'harbor-right' },

  { t: 'straight', len: 105, toY: 19, tag: 'pier-approach' },

  // ---- THE PIER. A full vertical loop -- consumes no plan distance, crosses
  // `stagger` sideways instead (see circuit.ts). w=20 here, narrower than the
  // open road: a loop is a defined tube by nature (the harmonic version's
  // loop ran the same narrower width, w=19, for the same reason), and it is
  // still comfortably wider than any OTHER circuit's ordinary road.
  //
  // `stagger` lives between two bounds now, both on this same r=36. The
  // floor is the design guideline this file was built to -- "road width + 16"
  // off this loop's own w=20 is 36m, and stagger=64 clears it by 28m. The
  // ceiling is new: `circuit.ts` added a hard guard (stagger <= 1.9x radius,
  // so <= 68.4m here) after the crossing it uses to stagger the loop changed
  // from a centred sweep to one that runs 0 -> stagger -- see part 2 and
  // part 5 of the file header for what that fixed and why it moved this
  // value down from 78. 64 sits comfortably inside both bounds, with 4.4m to
  // spare below the new ceiling.
  //
  // `side: -1` is unchanged from the original tuning pass and for the same
  // reason: Harbor Left, Harbor Right and Pier Exit Bend all turn the same
  // way (right) around this neighbourhood, so it curls toward one side, and
  // `-1` crosses the loop away from that curl rather than into it. The new
  // crossing separates the loop's own approach and departure by a FULL
  // stagger rather than half of one, so clearance here is no longer the
  // tight, measured-in-metres trade-off it used to be -- `probe-selfclear`
  // now reports the gap to the rest of the lap as larger than its own
  // pre-filter bothers to measure, rather than a specific number close to
  // the 2m floor. `side: 1` was not re-tried against that much headroom.
  //
  // Set-piece, not difficulty, for the CAR passing through it either way: a
  // full turn's tangent rotates in the plane perpendicular to the loop's own
  // `up`, so the vertical rotation itself reads as straight to `curvatureAt`
  // (which measures steering around the local up-axis).
  { t: 'loop', r: 36, side: -1, stagger: 64, w: 20, tag: 'pier' },

  { t: 'straight', len: 110, toY: 20, tag: 'pier-exit' },

  // PIER EXIT BEND -- medium, r78. Curls the lap back inland off the
  // waterfront, toward the second jump.
  { t: 'corner', r: 78, deg: 50, bank: 6, toY: 21, tag: 'pier-exit-bend' },

  { t: 'straight', len: 120, toY: 23, tag: 'creek-approach' },

  // THE CHANNEL JUMP. A shorter hop than the dune crest -- skipping the tidal
  // channel that drains the lagoon back to the sea, not clearing a dune.
  { t: 'jump', len: 150, launch: 27, gap: 42, toY: 19, tag: 'channel-jump' },

  // CREEKSIDE -- fast, r88, LEFT. The landing bend off the channel jump: a
  // lift rather than a brake, and the lap's last direction reversal before
  // the run for home.
  { t: 'corner', r: 88, deg: -42, bank: -5, toY: 18, tag: 'creekside' },

  { t: 'straight', len: 110, toY: 19, tag: 'run-home-a' },

  // HOME HOOK -- medium, r64.
  { t: 'corner', r: 64, deg: 48, bank: 6, toY: 19, tag: 'home-hook' },

  { t: 'straight', len: 90, toY: 18, tag: 'run-home-b' },

  // FINAL BEND -- fast, r100, deg31: the shallowest corner on the lap by
  // design. Its angle is what makes the last eleven corners close the loop
  // back to the boardwalk exactly, and a shallow, fast final corner is also
  // the right way onto a front straight -- nobody should be recovering from
  // the last corner instead of accelerating out of it.
  { t: 'corner', r: 100, deg: 31, bank: 5, toY: 18, tag: 'final-bend' },
]

/**
 * Node index where each tagged segment's FIRST sample lands, replaying
 * `circuit()`'s own per-segment step-count arithmetic (see part 4 above).
 * `loopStart`/`loopCount` additionally bound the one loop's own node range,
 * which is what makes finding its apex a bounded scan rather than a guess.
 */
function nodeIndices(
  segs: Seg[],
  straights: number[],
  spacing: number,
): { at: Record<string, number>; loopStart: number; loopCount: number } {
  const at: Record<string, number> = {}
  let idx = 0
  let si = 0
  let loopStart = -1
  let loopCount = 0
  for (const s of segs) {
    if (s.tag) at[s.tag] = idx
    let count: number
    if (s.t === 'straight') {
      count = Math.max(1, Math.round(straights[si++] / spacing))
    } else if (s.t === 'jump') {
      count = Math.max(1, Math.round(s.len / spacing))
    } else if (s.t === 'cyclone') {
      count = Math.max(1, Math.round(s.len / 13))
    } else if (s.t === 'loop') {
      count = Math.max(14, Math.round((2 * Math.PI * s.r) / 18)) + 1
      loopStart = idx
      loopCount = count
    } else {
      const arc = Math.abs(s.deg) * DEG * s.r
      count = Math.max(3, Math.round(arc / spacing))
    }
    idx += count
  }
  return { at, loopStart, loopCount }
}

function build(): TrackNode[] {
  const built = circuit(SEGS, {
    spacing: SPACING,
    start: [0, 18, 0],
    heading: 0,
    defaults: { w: 24, surface: 'tarmac' },
    minStraight: 40,
  })

  const { at, loopStart, loopCount } = nodeIndices(SEGS, built.straights, SPACING)
  const nodes = built.nodes

  // The theme reads these five tags directly off TrackNode.tag -- see part 4.
  nodes[at['start']].tag = 'start'
  nodes[at['dunes']].tag = 'dunes'
  nodes[at['tideline']].tag = 'tideline'
  nodes[at['pier']].tag = 'pier'

  let apex = loopStart
  for (let i = loopStart; i < loopStart + loopCount; i++) {
    if (nodes[i].p[1] > nodes[apex].p[1]) apex = i
  }
  nodes[apex].tag = 'pier-apex'

  // Drop the loop-exit / next-segment duplicate (part 4). Generic over any
  // adjacent pair, not just this one seam, in case a later pass adds a
  // second loop.
  const out: TrackNode[] = []
  for (const n of nodes) {
    const prev = out[out.length - 1]
    if (
      prev &&
      Math.abs(prev.p[0] - n.p[0]) < 0.05 &&
      Math.abs(prev.p[1] - n.p[1]) < 0.05 &&
      Math.abs(prev.p[2] - n.p[2]) < 0.05
    ) continue
    out.push(n)
  }
  return out
}

export const HALCYON: TrackDef = {
  id: 'halcyon',
  name: 'Halcyon Bay',
  skyTop: 0x1b3b6b,
  skyBottom: 0xd8a878,
  fogColor: 0xa9bcc0,
  fogDensity: 0.0011,
  sunColor: 0xffd9a0,
  sunIntensity: 1.12,
  ambientColor: 0x5d7fa8,
  ambientIntensity: 0.9,
  // Low and nearly along the start straight: a sun ON the horizon, which is
  // the whole look, and long shadows raking across the road.
  sunDirection: [0.86, 0.12, -0.50],
  palette: { a: 0xc9a97e, b: 0x4f93a8, c: 0xf0d2a4, accent: 0xffb45e },
  nodes: build(),
  // Six rows, all on straights, none inside the esses / pier technical
  // section (0.66-0.76) or on either jump -- a pickup is a one-shot lateral
  // aim, and it stays off the corners and set pieces where that aim is
  // hardest to place. Refit against this pass's marks (part 5 of the file
  // header) after several straights changed length and two rows drifted
  // onto the corners next to them.
  itemBoxRows: [
    { at: 0.030, count: 5, spread: 4.4 }, // the boardwalk
    { at: 0.125, count: 5, spread: 4.2 }, // the dunes
    { at: 0.385, count: 6, spread: 4.8 }, // brake zone, before Lagoon Hook
    { at: 0.500, count: 6, spread: 4.6 }, // the tideline, mid-straight
    { at: 0.617, count: 4, spread: 4.0 }, // tideline-end
    { at: 0.838, count: 5, spread: 4.4 }, // creek approach
  ],
  chargeRuns: [
    { from: 0.008, to: 0.050, count: 6, lateral: -6 }, // the boardwalk
    { from: 0.108, to: 0.145, count: 6, lateral: 5 }, // the dunes
    { from: 0.468, to: 0.520, count: 8, lateral: 0 }, // the tideline
    { from: 0.560, to: 0.577, count: 5, lateral: -5 }, // tideline-mid
    { from: 0.829, to: 0.849, count: 6, lateral: 5 }, // creek approach
  ],
  laps: 3,
}
