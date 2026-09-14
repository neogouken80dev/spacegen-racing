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
 * Thirteen corners land: 1 hairpin, 6 medium (the heart of the lap), 5 fast,
 * 1 sweeper -- 85% of the lap in the 58-110m band the old ring rarely
 * visited, with the single hairpin fed by the 159m start straight so there
 * is exactly one corner on the circuit that demands a full stop.
 *
 * ---------------------------------------------------------------------------
 * THE FEATURE MIX IS DIFFERENT FROM THE OTHER THREE REDESIGNS ON PURPOSE.
 *
 * Zhen-9 got a street circuit's corner density. Ashkar gets the maximalist
 * set-piece list, because a volcanic shield is the one planet in the roster
 * built entirely from held terrain: TWO vertical loops, ONE corkscrew, ONE
 * launch across an open fissure, and ONE enclosed tunnel bored through the
 * basalt. `Track.curvatureAt` reads a loop's and a corkscrew's curvature
 * about the surface normal, which for both is identically the axis they
 * spiral around -- geodesic curvature zero, DEAD STRAIGHT to the AI (see
 * `tools/probe-loop.ts` on the old ring: 0.0000 across 120m either side of a
 * loop apex, against the 0.0045 drift-hold gate). Nothing brakes for them and
 * nothing drifts in them, which is why they sit where the lap can afford to
 * be flat out and let the ash beds and the tunnel corner do the lap's actual
 * cornering work.
 *
 * THE ASH BEDS ARE STILL THE TRACK. A quarter of the lap (24%) is gravel
 * (grip 0.70) -- four corners and the straights that join them, wide, fast
 * and banked, the same shape as Elkarim's gravel opened out into its own
 * quarter of the lap rather than one pinch. Gravel is also where the AI's
 * corner model and a drifting player's diverge furthest, which is where
 * overtakes come from.
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
 * of idling near one direction for five corners in a row (see CORNERS below:
 * only two of the thirteen turn the "wrong" way, both short jinks that keep
 * the fast band honest rather than long detours). At site scale 1.0 the same
 * feature list -- same two loops, same corkscrew, same fissure and tunnel --
 * closes with every straight at least 56.5m, 41% clear of the floor; the
 * lengths actually authored below are that pass scaled by 0.87 for lap time
 * (see THE FULL SEGMENT LIST), which brings the shipped minimum to 43.8m,
 * still 9% clear -- the tightest margin on the circuit, and it belongs to
 * one of the two short straights bracing the Corkscrew, not to anything
 * this pass touched.
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
 *    Combined with the dedupe, the circuit's worst chord ratio measures 2.87
 *    and its tightest curvature reads 47m -- a little under the 55m hairpin,
 *    not a number far below anything authored.
 *
 * These fixes do not touch `circuit.ts` beyond what its own guard now
 * enforces: the dedupe operates on the `TrackNode[]` the builder returns,
 * the same way every tag below does, because a single track's file cannot
 * change the builder for everyone. Item 3 below is a different kind of fix
 * -- not a workaround for something `circuit()` leaves undone, but a
 * parameter this file got wrong the first time and a race actually caught.
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
 * now comes from the ash beds' width and bank plus the loops' and
 * corkscrew's own elevation swing (16m to 122m over the lap), which is more
 * of the track doing the work than a wind band ever was.
 * ---------------------------------------------------------------------------
 */

/**
 * THE THIRTEEN CORNERS, in lap order. Each radius is picked from the band
 * table above; each `bank` carries the SAME SIGN as `deg` (positive = right)
 * -- `circuit()` does not infer one from the other, and every corner on every
 * shipped `circuit()` track keeps this pairing, so a mismatched sign here
 * would be the one corner on the planet that banks away from the turn.
 */
const CORNERS: (Seg & { t: 'corner' })[] = [
  // C1 -- CALDERA HOOK. The lap's only hairpin, and the reason the start
  // straight closes at 159m: a hairpin fed by anything shorter is a corner the AI
  // arrives at still on the throttle. Widened (26 against the 21m base) for
  // the same reason the old file widened its own tightest bend -- a driver
  // who needs an alternate line through the lap's one full stop should have
  // room to take it.
  { t: 'corner', r: 55, deg: 45, bank: 10, w: 26, tag: 'caldera-hook' },
  // C2 -- BASALT SWEEP. Medium band, opens the lap's second half of the
  // opening straight into the run toward the fissure.
  { t: 'corner', r: 65, deg: 35, bank: 8, tag: 'basalt-sweep' },
  // C3-C5 -- THE ASH BEDS' OWN CORNERS. Landing off the fissure onto gravel,
  // three medium/fast turns and one jink (C4, the lap's other sign change)
  // keep this from reading as one long bend -- a third of a lap on 0.70 grip
  // needs its own variety or it is just a skid pad.
  { t: 'corner', r: 72, deg: 46, bank: 8, surface: 'gravel', w: 25, tag: 'ash-curve' },
  { t: 'corner', r: 85, deg: 20, bank: 5, surface: 'gravel', w: 25, tag: 'ash-bend' },
  { t: 'corner', r: 95, deg: -25, bank: -6, surface: 'gravel', w: 25, tag: 'ash-jink' },
  { t: 'corner', r: 68, deg: 40, bank: 8, surface: 'gravel', w: 25, tag: 'ash-exit' },
  // C6 -- TUBE BEND. The only corner inside the Lava Tube tunnel: fast band,
  // so the tunnel reads as a held commitment through the rock rather than a
  // second braking zone stacked on top of the ash beds' exit.
  { t: 'corner', r: 100, deg: 45, bank: 7, surface: 'metal', w: 20, tag: 'tube-bend' },
  // C7-C8 -- EMBER SWEEP / EMBER HOOK. Medium band, between the tunnel's
  // first Cinder Loop and the second -- the technical heart of the lap the
  // band table calls for, on ordinary basalt with nothing else going on.
  { t: 'corner', r: 76, deg: 45, bank: 8, tag: 'ember-sweep' },
  { t: 'corner', r: 62, deg: 38, bank: 8, tag: 'ember-hook' },
  // C9 -- RIDGE JINK. The lap's third and last sign change, a short fast
  // left between the second loop and the Corkscrew that keeps the run of
  // right-handers from the tunnel to the final sweeper from reading as one
  // uninterrupted curl.
  { t: 'corner', r: 90, deg: -20, bank: -5, tag: 'ridge-jink' },
  // C10-C11 -- RIDGE BEND / FLOW HOOK. Fast then medium, unwinding out of the
  // Corkscrew's exit straight toward the lap's final approach.
  { t: 'corner', r: 105, deg: 33, bank: 6, tag: 'ridge-bend' },
  { t: 'corner', r: 60, deg: 30, bank: 8, tag: 'flow-hook' },
  // C12 -- RIM SWEEPER. r=170m, the lap's one sweeper: flat out, closes the
  // final 115m+ straight back onto the start.
  { t: 'corner', r: 170, deg: 28, bank: 4, tag: 'rim-sweeper' },
]
{
  const sum = CORNERS.reduce((a, c) => a + c.deg, 0)
  if (Math.abs(sum) !== 360) throw new Error(`Ashkar: corner angles sum to ${sum}, not 360`)
}

/**
 * THE FULL SEGMENT LIST. Straight lengths are AUTHORED, not final -- see the
 * header above on why the closed values (logged by tools/probe-newtrack.ts)
 * land at 43.8-206.5m rather than these numbers. Sized to close comfortably
 * (9% clear of the 40m floor at the tightest) AND to land the lap near the
 * middle of the 55-75s band once the two loops and the corkscrew's own
 * travelled distance are added on top of the plan length -- the first pass
 * used the straight, roomier lengths this comment used to cite and measured
 * a 75.95s mean lap, over the ceiling; every length below is that pass
 * scaled by 0.87. `toY` only appears where the elevation actually changes;
 * every segment between keeps the last value, so the profile reads top to
 * bottom as: climb off the grid, launch the fissure, plateau on the ash
 * beds, dive into the tunnel, climb out through the loops, hold through the
 * corkscrew, settle back to the grid's 30m.
 */
const segs: Seg[] = [
  // Held above the 0.87 scale everything else took: a hairpin's braking zone
  // is a hard 150m+ floor, not a soft one, so this alone was bumped back up
  // (96 -> 116 authored) until its closed length cleared it with room to
  // spare -- 159.3m, against the 137.6m the flat scale would have left.
  { t: 'straight', len: 116, tag: 'start', w: 26 },
  CORNERS[0],
  { t: 'straight', len: 70 },
  CORNERS[1],
  { t: 'straight', len: 61 },
  // THE FISSURE. A launch across an open crack in the shield, not a corner --
  // `ramp`/`boost` on the first 18% and `open` road over the gap are set by
  // `circuit()`'s own `jump` branch.
  { t: 'jump', len: 110, launch: 26, gap: 45, tag: 'fissure', w: 24, toY: 36 },
  // THE ASH BEDS. Tagged at its own first node; `ashbeds` is read directly by
  // themes/emberfall.ts to place the gravel dressing.
  { t: 'straight', len: 170, tag: 'ashbeds', surface: 'gravel', w: 25, toY: 44 },
  CORNERS[2],
  { t: 'straight', len: 117, surface: 'gravel', w: 25 },
  CORNERS[3],
  { t: 'straight', len: 113, surface: 'gravel', w: 25, toY: 48 },
  CORNERS[4],
  { t: 'straight', len: 109, surface: 'gravel', w: 25 },
  CORNERS[5],
  { t: 'straight', len: 96, surface: 'gravel', w: 24, toY: 44 },
  // THE LAVA TUBE. An enclosed run of basalt tunnel -- `tunnel: true` is art
  // metadata only (the sim has no tunnel concept), and it dives to y=16-22
  // for it, well clear of the 6m floor. Authored at 100, not the 96 its
  // gravel neighbour uses: this is the straight the closure correction
  // squeezes hardest (to ~59-70m depending on the rest of the lap), and
  // `walk()`'s own `steps = round(len/spacing)` rounds anything under 60m
  // down to 2 samples -- one f=0..0.5 chord and one f=0.5..1.0-into-the-corner
  // chord, each roughly HALF the closed length on its own. That was the
  // circuit's actual worst joint (a 35.0m chord straight into the tube-bend
  // corner, ratio 3.57 -- failing the <3.5 gate), not the loop mouths the
  // rest of this file's post-processing targets. 87 authored closed at
  // 58.7m, one metre under the 60m/3-step line; 100 authored clears it with
  // room instead of sitting on the boundary, closing at 68.7m (3 steps, an
  // ordinary ~23m chord). The circuit's worst ratio today is 2.87, and it
  // belongs to the Cinder Loops' radius fix below, not to this joint.
  { t: 'straight', len: 100, surface: 'metal', tunnel: true, w: 20, toY: 22 },
  { ...CORNERS[6], tunnel: true },
  { t: 'straight', len: 96, surface: 'metal', tunnel: true, w: 20, toY: 16 },
  // CINDER LOOP ONE. Consumes no plan distance; its exit duplicate is fixed
  // by the post-processing below. r=34 (not a smaller, tighter loop) because
  // `circuit.ts` now refuses anything under 32m -- see the header's rewritten
  // item 2 for why a tight loop cannot carry a wide stagger gently.
  { t: 'loop', r: 34, side: 1, stagger: 54, surface: 'metal', w: 18, tag: 'loop1' },
  { t: 'straight', len: 96, toY: 28 },
  CORNERS[7],
  { t: 'straight', len: 87, toY: 32 },
  CORNERS[8],
  { t: 'straight', len: 78, w: 19, toY: 34 },
  // CINDER LOOP TWO. Larger and opposite-handed to the first (r=40 against
  // 34, side=-1 against +1), so the two loops read as a pair rather than a
  // repeat -- and comfortably inside the legal stagger band (52-76 at this
  // radius).
  { t: 'loop', r: 40, side: -1, stagger: 58, surface: 'metal', w: 19, tag: 'loop2' },
  { t: 'straight', len: 70, toY: 36 },
  CORNERS[9],
  { t: 'straight', len: 74, toY: 38 },
  // THE CORKSCREW. A single turn around a 42m bore. `turns` only has to be a
  // whole number to leave upright -- `th` at f=1 is `2*PI*turns`, a multiple
  // of a full circle for ANY integer, one included -- so two turns was never
  // required for that; it was the first number tried, and it measured badly.
  // At r=42, turns=2, len=280 the helix's own steepest climb is 62.1 degrees
  // (arctan(2*PI*r*turns/len), the corkscrew's own slope), and a scripted
  // race reproduced a racer falling off the tube there every time: altitude
  // goes negative mid-climb, contact never comes back, and the stall
  // watchdog eventually respawns it -- measured at 6.0 respawns a race, all
  // seven of one race's respawns within 6 metres of the same s. Its own
  // radius ramp is eased in `cyclone`'s own f-parametrisation (the outer 35%
  // at each mouth), which is why this set piece needed neither the dedupe
  // nor any mouth easing -- the CLIMB was the problem, not a kink. One turn
  // at the same r and len cuts that to 43.3 degrees, which raced clean at
  // 0.0 respawns a race across three seeds.
  { t: 'cyclone', r: 42, turns: 1, len: 280, surface: 'metal', w: 30 },
  { t: 'straight', len: 78, toY: 34 },
  CORNERS[10],
  { t: 'straight', len: 70, toY: 31 },
  CORNERS[11],
  { t: 'straight', len: 91, w: 24, toY: 30 },
  CORNERS[12],
]

const OPTS = {
  spacing: 24,
  start: [0, 30, 0] as [number, number, number],
  heading: 0,
  defaults: { w: 21, surface: 'tarmac' as const },
  minStraight: 40,
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
 * `themes/emberfall.ts`'s prop clusters and Cinder Loop rings) has to be
 * placed on an actual node here.
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
    { at: frac('loop1') + 0.015, count: 4, spread: 4.0 },
    { at: frac('loop2') + 0.02, count: 5, spread: 4.2 },
    { at: (frac('ridge-bend') + frac('flow-hook')) / 2, count: 4, spread: 3.8 },
  ],
  chargeRuns: [
    { from: frac('start') + 0.005, to: frac('caldera-hook') - 0.015, count: 6, lateral: -5 },
    { from: frac('ashbeds') + 0.005, to: frac('ash-curve') - 0.01, count: 7, lateral: 5 },
    { from: frac('ash-exit') + 0.01, to: frac('tube-bend') - 0.01, count: 5, lateral: 0 },
    { from: frac('loop2') + 0.015, to: frac('ridge-jink') - 0.015, count: 6, lateral: -5 },
    { from: frac('flow-hook') + 0.015, to: frac('rim-sweeper') - 0.02, count: 7, lateral: 5 },
  ],
  laps: 3,
}
