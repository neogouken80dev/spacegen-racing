import type { TrackDef, TrackNode, SurfaceKind } from '../../sim/track'

/**
 * THE HOLLOW CHOIR — Derelict Megastructure.
 *
 * GDD hook: "rotating gravity + vacuum section", one line, and the rest of the
 * design is the answer to a question that line does not ask: what is a rotating
 * habitat drum FOR, in a racing game, once you know that a drum is flat out?
 *
 * Difficulty: Hard. The fourth track, and THE DRIFT TRACK -- the opposite of
 * Aetherion. Six corners in 3255m, two direction changes in the whole lap, and
 * every one of the six banks a tier: two Tier 3, three Tier 2, one Tier 1. It
 * has EIGHT drift-hold runs in total against Cryostatic's 41, Rustfall's 22 and
 * Aetherion's 24, and only two of those eight are junk.
 *
 * ---------------------------------------------------------------------------
 * 1. THE DRUM IS FLAT OUT, AND THAT IS WHY THE VACUUM LIVES IN IT.
 *
 * Aetherion's rotunda cost three balance rounds to the same arithmetic, and it
 * is worth restating exactly because this track is built ON it rather than
 * around it. Geodesic curvature on a cylinder of radius R at roll r is
 * cos(r)/R. A road that runs along the inside of a drum -- a helix -- has
 * curvature vector pointing straight along the surface normal, so its GEODESIC
 * curvature is exactly zero. `Track.curvatureAt` measures about the surface
 * normal on a gravity track, which is the right thing to measure and which
 * therefore reports a helix as DEAD STRAIGHT. Not "a big corner". Zero.
 *
 * So the naive drum is a spectacle you hold the throttle through, and the
 * lesson written down after Aetherion was: THE CORNERS HAVE TO COME FROM THE
 * ROAD WEAVING ON THE DRUM, NOT FROM THE DRUM.
 *
 * Both halves of that are used here, and the second one is the design:
 *
 *   - A cylinder is DEVELOPABLE. Unroll it and geodesic curvature becomes
 *     ordinary planar curvature of the unrolled curve, exactly, with no
 *     approximation. So the drum section is designed in the flat (z, u) plane
 *     -- z along the axis, u = R*phi around it -- as an ordinary piece of
 *     racetrack, and then wrapped. What is drawn as a 100m-radius corner in
 *     that plane IS a 100m-radius corner on the drum, and `curvatureAt` agrees
 *     to the third decimal (the proof is one line: for a curve on a surface,
 *     dT/ds = k_g * w + k_n * n, and (T x dT).n = k_g exactly, which is what
 *     `curvatureAt`'s gravity branch computes). Both of the drum's corners are
 *     drawn this way, and probe-curv measures the Breach's residual ripple at
 *     |k| < 0.0007 against a 0.0045 hold gate: a factor of six of margin, with
 *     no crossings at all in 224m.
 *   - The stretch where the unrolled path is STRAIGHT is a helix, is a
 *     geodesic, is genuinely flat out, and there is no version of this beat
 *     where it is not. That stretch is THE BREACH, and it is where the hull is
 *     torn open and the vacuum is. The one piece of road that cannot be a
 *     corner is handed to the mechanic that punishes cornering.
 *
 * That is the whole track in a sentence: the corkscrew's straight is the
 * vacuum's straight, and the corkscrew's corners are the drift track.
 *
 * ---------------------------------------------------------------------------
 * 2. THE VACUUM.
 *
 * `TrackNode.vacuum`, 0..1, interpolating like `wind`. Three effects, and all
 * three are the same fact stated three times -- there is no medium here:
 *
 *   TOP SPEED climbs by 1/sqrt(1 - vac * T.sim.airDrag) = 1.147x at full
 *   vacuum: 59.2 -> 67.9 for Bulwark, 63.6 -> 73.0 for Dray-9. `T.sim.airDrag`
 *   had never been read by anything in this repo; see T.vacuum.dragRemoved for
 *   why the gift is a multiplier on the asymptote rather than a drag force
 *   switched off, and why adding a real drag term was the wrong call (it would
 *   have moved all three shipped circuits, which are balanced against the
 *   speeds they have).
 *
 *   THE LATERAL BUDGET collapses by the class's own `vacuumGripLoss`: hover
 *   0.47, grounded 0.42, flight 0.38. Hover is worst because a hovercraft
 *   corners by pushing on the cushion it floats on and the cushion is gone;
 *   grounded keeps its mass and its contact patch and loses the aero load;
 *   flight is least dependent on either. Measured on a 110m corner at full
 *   vacuum (tools/probe-vacuum.ts): Filament 55.6 -> 40.5 m/s, Solaire
 *   54.5 -> 41.5, Vector-7 54.8 -> 43.2. That IS the GDD's class contract, and
 *   it is the one place in the locomotion table where hover comes out strictly
 *   worse than grounded on the same metres.
 *
 *   THE FLIGHT CLASS CANNOT LIFT. Aerodynamic lift needs air exactly as much as
 *   a hovercraft's cushion does, so the same rule takes it. See section 3.
 *
 * The vacuum is deterministic and identical for every racer -- a property of
 * the road and of literally nothing else, not even race time -- which is the
 * same standard Cryostatic's ice crack and Aetherion's phasing spans are held
 * to, and it clears it more easily than either.
 *
 * THE VACUUM RAMPS THROUGH THE CORNERS AT BOTH ENDS, AND THAT IS THE MECHANIC.
 * A vacuum that only ever covered the geodesic would be a pure gift: nobody
 * needs to turn on a straight, so nobody would ever pay for it. It fades in
 * over the last 100m of the Ascent and out over the first 110m of the Fall, so
 * the grip goes out from under a car that is still turning, twice a lap. The
 * measured cost is in section 5.
 *
 * ---------------------------------------------------------------------------
 * 3. THE FLIGHT BILL. IT IS TWO BILLS, AND BOTH WERE MEASURED, NOT ARGUED.
 *
 * Vector-7 was at 27.0% of wins on Aetherion against a 30% ceiling, with
 * roster-high air time and boost uptime, and this track's headline mechanic
 * hands the flight class the top-speed gift AND the smallest cornering loss.
 * The first cut of it measured exactly what the designer warned it would:
 * 46.5% of wins at 200 races, with tools/probe-sector.ts putting 1.17s of
 * Vector-7's 2.79s-per-lap advantage in the three arc bins that carry the
 * vacuum.
 *
 * Two isolating runs at 200 races say where the class's advantage on this
 * circuit actually lives, and both numbers are worth having:
 *
 *   flight vacuumGripLoss set equal to grounded's   28.7% -> 19.5% of wins
 *   flight maxLift clamped to 0 for the whole lap   28.7% -> 21.0%, air 34%->0%
 *
 * So the vacuum is worth about nine points to it and Lift about eight. Both
 * bills are charged, and neither is charged by flattening the class contract:
 *
 *   NO LIFT IN VACUUM. The same rule that takes hover's cushion. It is the
 *   cheaper of the two -- about a fifth of the road Vector-7 lifts on is the
 *   Breach -- but it is the honest one, and it means the grip ladder did not
 *   have to be flattened to nothing to pay for it.
 *
 *   THE DRAUGHT AND THE SPIN DRAG, which are the same air going the same place.
 *   The drum has been venting through the Breach for two centuries: there is a
 *   circumferential draft across the sealed bays (the drum is a rotating
 *   habitat and its air turns with the hull while the road does not) and a
 *   steady draught down the two superstructure galleries. Both are `wind`, so
 *   both scale by `fieldForceMult` -- grounded 1.00, hover 1.50, flight 1.80 --
 *   and the gallery half is spent on the Keel and the Ribs, which are the two
 *   longest flat-out stretches on the lap and exactly where stepAI's Lift
 *   heuristic fires. Measured at 600 races, taking the gallery peak from
 *   20/24 to 24/29 m/s^2 moved Vector-7 from 27.2% to 17.0% and Bulwark from
 *   12.5% to 17.0%, at a cost of 4.2 points of lead retention. 22/26 is the
 *   settled value and the whole sweep is in the report.
 *
 * Every metre of wind on this track is on WALLED road of 19-24m half-width.
 * That is Aetherion's plaza/causeway lesson applied rather than rediscovered:
 * the same field on an open deck is a cliff that converts straight into
 * respawns, and on walled road it is a ramp that spends itself as scrub and
 * lost line. There are no open-edge nodes on this circuit at all.
 *
 * Wind is zero through the Breach, and that is physics rather than tuning: a
 * crosswind is air, and there is none there. Vacuum and wind are mutually
 * exclusive on this track by construction.
 *
 * ---------------------------------------------------------------------------
 * 4. WHY THE WHOLE LAP IS NOT INSIDE THE DRUM, WHICH WAS TRIED FIRST.
 *
 * The brief's second decision is "the lap corkscrews a full 360 degrees, so
 * down points outward the whole way round", and the tidiest reading of that is
 * a lap that never leaves the drum. It closes: a serpentine on a cylinder that
 * wraps once is a real closed curve. It was worked out and rejected on two
 * counts, both structural rather than aesthetic.
 *
 *   - A closed lap on a cylinder that wraps once has ZERO total geodesic
 *     turning. Its tangent must come back to itself without winding in the
 *     unrolled plane, so every left is paid for by an equal right: a lap of
 *     four hairpins is two lefts and two rights and FOUR sign changes, on the
 *     track whose entire brief is that a drift cannot survive a sign change.
 *   - The circumference is then set by the hairpins, not chosen: net wrap is
 *     about 2R per hairpin, so a lap with four 140m-radius hairpins needs a
 *     drum 356m across, and one with two needs legs over a kilometre long.
 *     Every version was either a huge drum or two enormous straights.
 *
 * What is here instead: 863m of the 3255m lap is inside the drum and wraps a
 * full 360 degrees over that stretch, on a 140m bore, with the road passing
 * through fully inverted at the top and 155m of elevation range doing it. The
 * remaining 2384m is the wreck's surviving superstructure, which is where the
 * two hardest braking zones are and where a closed loop is free to turn all one
 * way. Four of the six corners are outside the drum. Down points outward for
 * every metre of the drum, which is the beat; it does not point outward for the
 * whole lap, which would have cost the beat sheet more than it bought.
 *
 * ---------------------------------------------------------------------------
 * 5. THE LAP AS BUILT: 3255m, 110 nodes, lap mean 64.95s over 600 races.
 * Radii and lengths are AUTHORED below and MEASURED off the baked ribbon by
 * tools/probe-track.ts; the two never agree by accident, so trust the table.
 *
 *   s      beat            measured                 binds at        charge
 *   ---------------------------------------------------------------------
 *      0   The Keel        419m straight            -               -
 *              primary straight and start/finish. Gallery draught 22.
 *    404   The Antechoir   302m  R 126 mean / 74     43.6 m/s        5.83  T3
 *              opens, then TIGHTENS into the near mouth on shed regolith.
 *              The hardest braking on the lap and the drift king's corner.
 *    806   The Nave         81m  drum floor, level   -               -
 *              the mouth run-in. Spin drag 13.
 *    879   The Ascent      239m  R 162 mean / 107    61.0 m/s        3.89  T2
 *              drum corner one, climbing the wall. Vacuum fades IN over its
 *              back half; spin drag over its front half.
 *   1127   The Breach      224m  geodesic helix      -               -
 *              VACUUM 1.0. 186 degrees of wrap through fully inverted, on a
 *              140m bore. No wind: there is no air to make one of.
 *   1349   The Fall        240m  R 156 mean / 125    flat out        3.72  T2
 *              drum corner two, the other way, off the ceiling. The vacuum
 *              fades OUT across its tightest point, which is why it prices
 *              at 47.5 m/s for a grounded chassis rather than the 67.7 the
 *              corner table reads with the field ignored.
 *   1610   The Transept    176m  drum exit
 *   1785   The Gantry      188m  R 113 mean / 64     48.4 m/s        2.57  T1
 *              the collapsed dock. Second-hardest braking, tight-then-open.
 *   2001   The Ribs        342m  link                -               -
 *              gallery draught 26, the strongest field on the circuit.
 *   2343   The Spine        98m  R 117 mean / 89     57.1 m/s        3.96  T2
 *   2534   The Carousel    669m  R 134 mean / 91     57.8 m/s       11.71  T3
 *              a full 360 in the cargo dock, crossing under its own entry.
 *
 * DIRECTION CHANGES: TWO. Antechoir(L) -> Ascent(L) is none; Ascent(L) ->
 * Fall(R) is one; Fall(R) -> Gantry(L) is two; Gantry(L) -> Spine(L) ->
 * Carousel(L) -> Antechoir(L) is none. Cryostatic runs one and Aetherion
 * eight, and the Aetherion report is unambiguous that this number, not total
 * charge, is what decides the Tier-3 share.
 *
 * THE DRIFT-RUN SPECTRUM, which is what this track is FOR
 * (tools/probe-holdruns.ts, and the number the whole design is aimed at):
 *
 *                     runs   enterable   median   mean len   mean charge
 *   Hollow Choir         8       6        211m      232m        5.28
 *   Cryostatic          41       4          1m       38m        6.10
 *   Rustfall            22       7          1m       68m        3.86
 *   Aetherion           24      11          9m       65m        2.33
 *
 * Six enterable runs, of which two reach Tier 3, three reach Tier 2 and one
 * reaches Tier 1, and only two runs on the whole lap are junk (15m and 1m,
 * neither of them enterable). Measured over 600 races the field reaches Tier 3
 * on 23.5% of its drifts against Cryostatic's 29.6% and Aetherion's 7.2%.
 *
 * ---------------------------------------------------------------------------
 * 6. TWO LINK LENGTHS ARE SOLVED, NOT AUTHORED, AND THAT IS NOT WHAT
 *    CRYOSTATIC WARNS ABOUT.
 *
 * Cryostatic's header records a solve for a chain of arcs of stated radii that
 * returned "a 303-degree corner joined by a MINUS 735 metre straight -- a real
 * root of the closure equations, and not a racetrack", and concludes: author
 * waypoints, because a closed Catmull-Rom closes by construction.
 *
 * That warning is about an UNDERDETERMINED, NONLINEAR solve where the turn
 * angles were free. Here every angle and every radius is authored, and the only
 * unknowns are the lengths of two non-parallel straights. Closure is then two
 * linear equations in two unknowns with a well-conditioned 2x2 -- there is one
 * root, `solveLink` finds it in closed form, and it is checked against a sane
 * band and throws otherwise, so Cryostatic's failure mode is a construction
 * error rather than a silent racetrack-shaped thing. IT FIRED TWICE DURING
 * AUTHORING -- once at runOut = -733m when the two free straights were chosen
 * 166 degrees apart and the 2x2 was nearly singular -- which is the whole
 * argument for leaving the solve in the file rather than baking its output as
 * magic numbers that silently stop closing the day a radius moves by a metre.
 * ---------------------------------------------------------------------------
 */

const D2R = Math.PI / 180

// ===========================================================================
// THE DRUM
// ===========================================================================

/**
 * Drum radius, metres. The road runs on the INSIDE at this radius from the
 * axis, which lies along +Z at (x = 0, y = DRUM_YA).
 *
 * 70 puts the deck at y=30 at the floor and y=170 at the ceiling: a 140m bore,
 * and 140m of vertical excursion for a car that drives all the way round the
 * inside of it.
 *
 * IT IS SET BY THE WRAP BUDGET RATHER THAN BY TASTE, and the constraint is
 * worth stating because it is not obvious. The drum's two corners contribute
 * about R_corner * (cos psi_in - cos psi_max) of circumferential travel each,
 * and everything left over has to be made up by the Breach -- which is a
 * geodesic, hence flat out. A bigger bore is a longer Breach and therefore
 * more dead road, one for one: at DRUM_R 84 the Breach solves to 343m against
 * 224m here. 70 is the largest bore whose Breach stays under a quarter of the
 * drum's own length.
 */
const DRUM_R = 70
const DRUM_YA = 100

/**
 * THE UNROLLED CHAIN, and the only place the drum's shape is stated.
 *
 * psi is the road's heading in the unrolled (z, u) plane, measured from the
 * drum axis toward +u: psi = 0 runs straight down the drum, psi = 90 would run
 * purely around it. u = DRUM_R * phi, and phi = 0 is the floor.
 *
 * The chain is: run in along the floor, turn LEFT through 98 degrees while
 * climbing (THE ASCENT), hold psi through THE BREACH -- which is a geodesic,
 * hence flat out, hence the vacuum -- then turn RIGHT through 96 (THE FALL) and
 * settle back onto the floor. That is the lap's only sign change inside the
 * drum and one of only two on the whole circuit.
 *
 * BREACH_LEN IS SOLVED, NOT CHOSEN. The net circumferential travel of the whole
 * chain has to be exactly one circumference or the drum's exit does not land on
 * its entry's own angle and the lap has a step in it. Everything else in the
 * chain is authored; the Breach is the one free length, and `solveBreach`
 * bisects for it. At the values below it comes out at 224m.
 *
 * PSI_MAX = 80 RATHER THAN 90, AND THE CEILING IS A HARD ONE. At exactly 90 the
 * road runs purely circumferentially -- a horizontal ring at constant z, still
 * a geodesic, still flat out, and the bake is perfectly happy with it. Past 90
 * it runs BACKWARDS down the drum while still wrapping, which is also legal and
 * was also built: at PSI_MAX 100 the drum's own length collapsed from 548m to
 * 384m and the Ascent came back over the Fall -- 0.3m of 3D separation between
 * two stretches of road 828m apart along the lap, on a ribbon that needs 39.
 * 80 keeps the Breach advancing 39m down the drum while it wraps 186 degrees,
 * which is what makes it read as a corridor with an end rather than as a
 * loop-the-loop.
 */
const PSI_IN = -18
const PSI_MAX = 80
const PSI_OUT = -16
const NAVE_LEN = 76
const DRUM_OUT_LEN = 70
/** THE ASCENT: tight at the mouth, opening as the wall comes up. */
const ASCENT_R0 = 100, ASCENT_R1 = 180
/** THE FALL: the other way, off the ceiling and back down to the floor. */
const FALL_R0 = 176, FALL_R1 = 112

/**
 * THE DRUM'S CORNERS ARE GENTLE ON PURPOSE, AND THE VACUUM IS WHY.
 *
 * R=180 is |k| = 0.0056 and prices at 67.7 m/s on metal -- above every top
 * speed in the roster, i.e. a straight with scenery. In FULL VACUUM the same
 * corner prices at 47.5 for a grounded chassis and 43.9 for a hovercraft. The
 * Ascent's back half and the Fall's front half are corners THAT EXIST ONLY
 * BECAUSE THERE IS NO AIR, which is the same argument Cryostatic makes about
 * its lake ("the corner exists ONLY because it is ice") and the only argument
 * that earns a mechanic the right to reprice a corner.
 *
 * The ceiling on the radius is the AI's drift HOLD gate at |k| = 0.0045
 * (R = 222m). Aetherion's rule 2 -- "curvature that GRAZES the hold gate is
 * worse than curvature that crosses it", because stepAI re-rolls drift entry
 * every frame it is not drifting -- is why neither corner opens past 180 even
 * though both would take another 40m of radius geometrically. 0.0056 against
 * 0.0045 is 24% of headroom against a Catmull-Rom's own ripple, and the drum
 * nodes are emitted at uniform arc length so the ripple is small: measured,
 * this lap has EIGHT drift-hold runs in total, of which two are junk (15m and
 * 1m). Cryostatic has 41 and Aetherion 24.
 */
type Seg =
  | { kind: 'str'; len: number }
  | { kind: 'arc'; dpsi: number; r0: number; r1: number }

function drumChain(breach: number): Seg[] {
  return [
    { kind: 'str', len: NAVE_LEN },
    { kind: 'arc', dpsi: PSI_MAX - PSI_IN, r0: ASCENT_R0, r1: ASCENT_R1 },
    { kind: 'str', len: breach },
    { kind: 'arc', dpsi: PSI_OUT - PSI_MAX, r0: FALL_R0, r1: FALL_R1 },
    { kind: 'str', len: DRUM_OUT_LEN },
  ]
}

interface UPoint { s: number; z: number; u: number; psi: number }

/** Integrate a chain in the unrolled plane. Pure arithmetic, no RNG, no state. */
function walkUnrolled(segs: Seg[], psi0: number): UPoint[] {
  let psi = psi0 * D2R, u = 0, z = 0, s = 0
  const out: UPoint[] = [{ s: 0, z: 0, u: 0, psi }]
  for (const g of segs) {
    if (g.kind === 'str') {
      const n = Math.max(1, Math.round(g.len / 0.5))
      for (let i = 0; i < n; i++) {
        const d = g.len / n
        z += Math.cos(psi) * d; u += Math.sin(psi) * d; s += d
        out.push({ s, z, u, psi })
      }
    } else {
      const dp = g.dpsi * D2R
      const M = 1200
      for (let i = 0; i < M; i++) {
        const f = (i + 0.5) / M
        const R = g.r0 + (g.r1 - g.r0) * f
        const d = (Math.abs(dp) / M) * R
        psi += dp / M
        z += Math.cos(psi) * d; u += Math.sin(psi) * d; s += d
        out.push({ s, z, u, psi })
      }
    }
  }
  return out
}

/** The one free length in the drum: the Breach, set so the wrap is exactly 360. */
function solveBreach(): number {
  const want = 2 * Math.PI * DRUM_R
  let lo = 10, hi = 900
  for (let i = 0; i < 70; i++) {
    const mid = (lo + hi) / 2
    const p = walkUnrolled(drumChain(mid), PSI_IN)
    if (p[p.length - 1].u < want) lo = mid; else hi = mid
  }
  return (lo + hi) / 2
}

const BREACH_LEN = solveBreach()
const DRUM_PATH = walkUnrolled(drumChain(BREACH_LEN), PSI_IN)
const DRUM_ARC = DRUM_PATH[DRUM_PATH.length - 1].s

/** Where the Ascent, the Breach and the Fall begin, as arc length in the drum. */
const S_ASCENT = NAVE_LEN
const S_BREACH = S_ASCENT + (PSI_MAX - PSI_IN) * D2R * (ASCENT_R0 + ASCENT_R1) / 2
const S_FALL = S_BREACH + BREACH_LEN
const S_DRUM_OUT = S_FALL + (PSI_MAX - PSI_OUT) * D2R * (FALL_R0 + FALL_R1) / 2

/** Wrap an unrolled point onto the drum: world position, world tangent, phi. */
function onDrum(p: UPoint) {
  const phi = p.u / DRUM_R
  const sp = Math.sin(phi), cp = Math.cos(phi)
  const spsi = Math.sin(p.psi), cpsi = Math.cos(p.psi)
  return {
    pos: [DRUM_R * sp, DRUM_YA - DRUM_R * cp, p.z] as [number, number, number],
    // The circumferential basis vector is (cos phi, sin phi, 0) -- it lies in
    // the XY plane, because the axis is Z.
    tan: [spsi * cp, spsi * sp, cpsi] as [number, number, number],
    // Up is the INWARD radial: the car is on the inside of the drum and spin
    // gravity throws it outward, so "down" is away from the axis, everywhere.
    up: [-sp, cp, 0] as [number, number, number],
    phi,
  }
}

function lerpAt(path: UPoint[], s: number): UPoint {
  const last = path[path.length - 1]
  if (s <= 0) return path[0]
  if (s >= last.s) return last
  let lo = 0, hi = path.length - 1
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    if (path[mid].s <= s) lo = mid; else hi = mid
  }
  const a = path[lo], b = path[hi]
  const f = (s - a.s) / Math.max(1e-9, b.s - a.s)
  return { s, z: a.z + (b.z - a.z) * f, u: a.u + (b.u - a.u) * f, psi: a.psi + (b.psi - a.psi) * f }
}

/**
 * The drum's nodes, emitted at UNIFORM arc length.
 *
 * Uniform is not tidiness, it is Aetherion's rule 1: a Catmull-Rom is uniformly
 * parameterised, so uneven waypoint spacing IS a curvature ripple, and a ripple
 * across the 0.0045 hold gate is a drift-entry machine gun. Aetherion measured
 * |k| swinging between R=41m and R=641m six times in 60m where a 32m segment
 * met 14.1m ones. The whole drum is on one spacing and the links at both mouths
 * taper into it.
 *
 * 20m at PSI_MAX turns the up-vector 13.8 degrees per node, comfortably inside
 * the bake's 120-degree ceiling and fine enough that the ribbon does not
 * visibly facet on a 164m bore.
 */
const DRUM_STEP = 20

function drumNodes(): TrackNode[] {
  const n = Math.round(DRUM_ARC / DRUM_STEP)
  const out: TrackNode[] = []
  for (let i = 0; i <= n; i++) {
    const s = (i / n) * DRUM_ARC
    const p = lerpAt(DRUM_PATH, s)
    const w = onDrum(p)
    out.push({
      p: [round1(w.pos[0]), round1(w.pos[1]), round1(w.pos[2])],
      w: round1(drumWidth(s)),
      surface: 'metal',
      up: [round4(w.up[0]), round4(w.up[1]), round4(w.up[2])],
      vacuum: round3(vacuumAt(s)),
      wind: round1(spinDragAt(s)),
      tag: drumTag(i, n),
    })
  }
  return out
}

/**
 * THE BREACH IS NARROWER THAN THE SEALED DECK, and it is the only width change
 * on the drum. 20m of half-width in the sealed sections, 17 through the torn
 * one. It is a legibility choice before it is a difficulty one: the section
 * where the grip is gone is the section that visibly has less road, so the
 * mechanic is announced by the geometry rather than only by the HUD.
 */
function drumWidth(s: number): number {
  const t = smoothBand(s, S_BREACH - 40, S_BREACH + 30, S_FALL - 20, S_FALL + 90)
  return 20 - 3 * t
}

/**
 * THE VACUUM ENVELOPE.
 *
 * Full through the Breach, and -- the part that matters -- covering the back
 * TWO THIRDS of the Ascent and the front two thirds of the Fall. Those metres
 * are where a car is asked to turn without a medium to turn against, and they
 * are the entire cost side of the mechanic. A vacuum that only ever covered the
 * geodesic would be a pure gift: nobody needs to turn on a straight, so nobody
 * would ever pay for it.
 *
 * IT COVERS TWO THIRDS OF EACH CORNER AND NOT A NARROW RAMP AT EACH END, and
 * that changed the track. The first cut faded it in over the last 100m of the
 * Ascent only; measured with tools/probe-vacuum.ts, the drum then ran 47% and
 * 81% flat out for a Solaire on the two corners, against 11% and 18% now,
 * because both corners are gentle enough (R 107-180) that nothing in the roster
 * brakes for them in air. The vacuum IS the difficulty of the drum.
 *
 * The envelope is expressed as fractions of each corner rather than as metres
 * so that moving a radius does not silently move the mechanic off the corner it
 * was aimed at.
 */
function vacuumAt(s: number): number {
  return smoothBand(s, S_ASCENT + 0.34 * (S_BREACH - S_ASCENT), S_BREACH - 20,
    S_FALL + 20, S_FALL + 0.66 * (S_DRUM_OUT - S_FALL))
}

/**
 * THE SPIN DRAG: half of the flight class's bill, and the other half of the
 * draught in the galleries. Same air, same direction, same reason.
 *
 * A rotating habitat drags its air round with it and the road does not turn, so
 * there is a steady circumferential draft across the sealed bays. `wind` pushes
 * toward the sample's `right`, and on this drum `right` is minus the direction
 * of wrap (at psi = 0, `right` = tangent x up = -u exactly), so a positive value
 * blows AGAINST the corkscrew -- down the wall the Ascent is climbing and into
 * the Fall's turn-in. One direction, all the way round, which is what a rotating
 * drum would actually do.
 *
 * Zero through the Breach, and that is physics rather than tuning: there is no
 * air out there to blow. It is also what keeps the two mechanics off the same
 * metres. The first cut let them overlap by 80m and it showed: hover paid a
 * 62% budget cut AND a 1.5x crosswind on the same 19m of road, and Filament
 * measured 0.5% of wins over 200 races.
 */
function spinDragAt(s: number): number {
  const inSealed = 1 - smoothBand(s, S_ASCENT + 0.20 * (S_BREACH - S_ASCENT), S_ASCENT + 0.44 * (S_BREACH - S_ASCENT),
    S_FALL + 0.56 * (S_DRUM_OUT - S_FALL), S_FALL + 0.80 * (S_DRUM_OUT - S_FALL))
  // Fades up out of the mouth and back down into the exit so the draft never
  // switches on at a sample boundary.
  const mouths = smoothBand(s, 0, 70, DRUM_ARC - 70, DRUM_ARC)
  return SPIN_DRAG_PEAK * inSealed * mouths
}
const SPIN_DRAG_PEAK = 40.0

function drumTag(i: number, n: number): string | undefined {
  if (i === 0) return 'nave'
  if (i === Math.round((S_ASCENT / DRUM_ARC) * n)) return 'ascent'
  if (i === Math.round((S_BREACH / DRUM_ARC) * n)) return 'breach'
  if (i === Math.round(((S_BREACH + BREACH_LEN * 0.5) / DRUM_ARC) * n)) return 'breach-inverted'
  if (i === Math.round((S_FALL / DRUM_ARC) * n)) return 'fall'
  if (i === Math.round((S_DRUM_OUT / DRUM_ARC) * n)) return 'transept'
  return undefined
}

/** 0 outside [a, d], 1 inside [b, c], smoothstep on both shoulders. */
function smoothBand(s: number, a: number, b: number, c: number, d: number): number {
  const up = b > a ? clamp01((s - a) / (b - a)) : (s >= b ? 1 : 0)
  const dn = d > c ? clamp01((d - s) / (d - c)) : (s <= c ? 1 : 0)
  const t = Math.min(up, dn)
  return t * t * (3 - 2 * t)
}
function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x }
function round1(x: number): number { return Math.round(x * 10) / 10 }
function round3(x: number): number { return Math.round(x * 1000) / 1000 }
function round4(x: number): number { return Math.round(x * 10000) / 10000 }

// ===========================================================================
// THE SUPERSTRUCTURE — the 2008m outside the drum
// ===========================================================================

const DRUM_ENTRY = onDrum(DRUM_PATH[0])
const DRUM_EXIT = onDrum(DRUM_PATH[DRUM_PATH.length - 1])
const BEAR_IN = Math.atan2(DRUM_ENTRY.tan[0], DRUM_ENTRY.tan[2]) / D2R
const BEAR_OUT = Math.atan2(DRUM_EXIT.tan[0], DRUM_EXIT.tan[2]) / D2R
/**
 * The external loop turns 725 degrees LEFT: 720 for a lap that winds TWICE in
 * plan (see CAROUSEL below), plus the 5 degrees the drum's exit bearing differs
 * from its entry's. The drum itself contributes almost nothing to the plan
 * winding -- its bearing swings as phi does and comes back -- which is exactly
 * why the outside can be all one direction and the whole lap still has only two
 * sign changes.
 */
const EXT_WINDINGS = 2
const EXT_TURN = BEAR_IN - BEAR_OUT - 360 * EXT_WINDINGS

const RUN_OUT = 96   // past the far mouth before the Gantry starts
const RUN_IN = 90    // the final run at the near mouth
/**
 * THE KEEL: the primary straight, and the only authored straight on the lap.
 *
 * The GDD grammar wants exactly one straight over 400m and nothing else near
 * it, so it is a fixed 430 rather than something the closure solve is allowed
 * to hand back at whatever length happens to close. Every other straight out
 * here is a link and comes out of the solve.
 */
const KEEL = 430
const GANTRY = { turn: -118, r0: 76, r1: 120 }
/**
 * THE CAROUSEL, and the reason this lap crosses over itself.
 *
 * A closed loop in plan turns exactly 360 degrees, and that is the hard ceiling
 * on how much CORNER a lap can contain. The drum sidesteps it -- geodesic
 * turning on a cylinder costs nothing in plan, which is why the Ascent and the
 * Fall are free -- but the superstructure does not, and the first cut of it
 * spent its 365 degrees on three corners and then had 780m of straight left
 * over to fill with nothing. Measured, the lap came out 51% flat out for
 * Solaire and 61.5% for Bulwark, against Aetherion's 48/57 and Rustfall's
 * 40/50, and 2507m long, which is a 50.8s lap against a 55s floor.
 *
 * A self-crossing lap turns 720. So the road leaves the Gantry, spirals through
 * a full turn of the collapsed cargo dock tightening from R=150 to R=96, drops
 * 15m doing it, and passes under the line it came in on. That is +465m of road,
 * ALL of it corner, and it converts the deadest 303m on the circuit into the
 * second-longest drift run. Both shipped precedents cross over -- Rustfall's
 * viaduct and Aetherion's keystone flyover -- so nothing about it is new to the
 * mesh or to `Track.project`.
 *
 * THE SPIRAL IS WHAT MAKES THE CROSSING SAFE, and it is not decoration. A
 * CONSTANT-radius 360 returns to its own start point exactly: not a crossover,
 * a collision. Shrinking the radius by 54m over the turn puts the exit 54m
 * inside the entry, against 40m of combined road width, and the 15m of drop
 * gives the vertical clearance on top of that.
 */
const CAROUSEL = { turn: -360, r0: 134, r1: 88 }
const SPINE = { turn: -76, r0: 82, r1: 116 }
const ANTECHOIR = {
  turn: EXT_TURN - GANTRY.turn - CAROUSEL.turn - SPINE.turn,
  r0: 145, r1: 66,
}

interface PlanPoint { s: number; x: number; z: number; bear: number }

function planStraight(from: PlanPoint, len: number, out: PlanPoint[]): PlanPoint {
  const n = Math.max(1, Math.round(len / 1))
  let { x, z, s } = from
  const dx = Math.sin(from.bear * D2R), dz = Math.cos(from.bear * D2R)
  for (let i = 0; i < n; i++) {
    x += dx * (len / n); z += dz * (len / n); s += len / n
    out.push({ s, x, z, bear: from.bear })
  }
  return out[out.length - 1]
}

function planArc(from: PlanPoint, turn: number, r0: number, r1: number, out: PlanPoint[]): PlanPoint {
  const N = 900
  let { x, z, s, bear } = from
  for (let i = 0; i < N; i++) {
    const f = (i + 0.5) / N
    const R = r0 + (r1 - r0) * f
    const d = (Math.abs(turn) * D2R / N) * R
    bear += turn / N
    x += Math.sin(bear * D2R) * d; z += Math.cos(bear * D2R) * d; s += d
    out.push({ s, x, z, bear })
  }
  return out[out.length - 1]
}

function arcLength(turn: number, r0: number, r1: number): number {
  return Math.abs(turn) * D2R * (r0 + r1) / 2
}

/**
 * THE CLOSURE SOLVE. Two linear equations, two unknowns, one root.
 *
 * The external chain is runout -> Gantry -> link -> Spine -> KEEL -> Antechoir
 * -> runin, with every turn and every radius authored above. The end point is
 * affine in the two straight lengths, so sampling it at (0,0), (1,0) and (0,1)
 * gives the 2x2 exactly and the solve is closed-form. The two straights run on
 * bearings 125 degrees apart, so the matrix is nowhere near singular.
 *
 * The band check is the whole reason this is safe to leave in the file rather
 * than baking the numbers: Cryostatic's cautionary solve returned a minus 735
 * metre straight, and a negative length here throws at construction instead of
 * building a ribbon that folds back through itself.
 */
function extChain(ribs: number, approach: number, pts: PlanPoint[]): PlanPoint {
  let p: PlanPoint = { s: 0, x: DRUM_EXIT.pos[0], z: DRUM_EXIT.pos[2], bear: BEAR_OUT }
  pts.push(p)
  p = planStraight(p, RUN_OUT, pts)
  p = planArc(p, GANTRY.turn, GANTRY.r0, GANTRY.r1, pts)
  p = planStraight(p, ribs, pts)
  p = planArc(p, SPINE.turn, SPINE.r0, SPINE.r1, pts)
  p = planStraight(p, approach, pts)
  p = planArc(p, CAROUSEL.turn, CAROUSEL.r0, CAROUSEL.r1, pts)
  p = planStraight(p, KEEL, pts)
  p = planArc(p, ANTECHOIR.turn, ANTECHOIR.r0, ANTECHOIR.r1, pts)
  p = planStraight(p, RUN_IN, pts)
  return p
}

/**
 * WHICH TWO STRAIGHTS ARE FREE MATTERS, and the first attempt got it wrong.
 * Freeing the run-out and the Keel put the 2x2 on two straights 166 degrees
 * apart -- nearly antiparallel, so the determinant is nearly zero and the one
 * root it does have is enormous. It solved to runOut = -733m, the guard below
 * caught it, and the fix is to free the two straights that bracket the Spine's
 * 76 degrees instead. Cryostatic's warning about closure solves is about
 * exactly this failure mode; the difference is that here it throws.
 */
function solveLink(): { ribs: number; approach: number } {
  const end = (a: number, b: number): [number, number] => {
    const pts: PlanPoint[] = []
    const p = extChain(a, b, pts)
    return [p.x, p.z]
  }
  const p00 = end(0, 0), p10 = end(1, 0), p01 = end(0, 1)
  const a11 = p10[0] - p00[0], a12 = p01[0] - p00[0]
  const a21 = p10[1] - p00[1], a22 = p01[1] - p00[1]
  const rx = DRUM_ENTRY.pos[0] - p00[0], rz = DRUM_ENTRY.pos[2] - p00[1]
  const det = a11 * a22 - a12 * a21
  if (Math.abs(det) < 1e-6) {
    throw new Error('hollowchoir: the two free straights are parallel; closure is singular')
  }
  const ribs = (rx * a22 - a12 * rz) / det
  const approach = (a11 * rz - a21 * rx) / det
  if (!(ribs > 40 && ribs < 600 && approach > 30 && approach < 600)) {
    throw new Error(
      `hollowchoir: closure solved to ribs=${ribs.toFixed(1)}m approach=${approach.toFixed(1)}m, ` +
      `which is not a racetrack. Re-check the authored turns (${EXT_TURN.toFixed(2)} deg total) and radii.`,
    )
  }
  const check = end(ribs, approach)
  const err = Math.hypot(check[0] - DRUM_ENTRY.pos[0], check[1] - DRUM_ENTRY.pos[2])
  if (err > 0.05) throw new Error(`hollowchoir: closure residual ${err.toFixed(3)}m`)
  return { ribs, approach }
}

const LINK = solveLink()

/** Arc-length marks along the external chain, from the drum exit. */
const E_GANTRY = RUN_OUT
const E_RIBS = E_GANTRY + arcLength(GANTRY.turn, GANTRY.r0, GANTRY.r1)
const E_SPINE = E_RIBS + LINK.ribs
const E_APPROACH = E_SPINE + arcLength(SPINE.turn, SPINE.r0, SPINE.r1)
const E_CAROUSEL = E_APPROACH + LINK.approach
const E_KEEL = E_CAROUSEL + arcLength(CAROUSEL.turn, CAROUSEL.r0, CAROUSEL.r1)
const E_ANTECHOIR = E_KEEL + KEEL
const E_RUNIN = E_ANTECHOIR + arcLength(ANTECHOIR.turn, ANTECHOIR.r0, ANTECHOIR.r1)
const EXT_ARC = E_RUNIN + RUN_IN

const EXT_PATH: PlanPoint[] = (() => {
  const pts: PlanPoint[] = []
  extChain(LINK.ribs, LINK.approach, pts)
  return pts
})()

function extAt(s: number): PlanPoint {
  const last = EXT_PATH[EXT_PATH.length - 1]
  if (s <= 0) return EXT_PATH[0]
  if (s >= last.s) return last
  let lo = 0, hi = EXT_PATH.length - 1
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    if (EXT_PATH[mid].s <= s) lo = mid; else hi = mid
  }
  const a = EXT_PATH[lo], b = EXT_PATH[hi]
  const f = (s - a.s) / Math.max(1e-9, b.s - a.s)
  return { s, x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, bear: a.bear + (b.bear - a.bear) * f }
}

/**
 * ELEVATION OUTSIDE THE DRUM.
 *
 * Both drum mouths sit at y=18 -- the drum floor -- so the external loop starts
 * and ends there and is free in between. It climbs onto the collapsed dock over
 * the Gantry, runs the link at its high point, and comes back down the Keel, so
 * the primary straight is a descent and the hardest braking zone on the lap
 * (the Antechoir, into the near mouth) is at the bottom of it.
 *
 * Every gradient here is under 6%, against the GDD's 12% sustained limit. The
 * drum is a different question and is not governed by that number at all: a
 * road on the inside of a rotating drum is vertical in world terms at phi=90
 * and inverted at 180, which is the beat, and `stick` holds the car to it.
 */
const EXT_Y: [number, number][] = [
  [0, 18], [E_GANTRY, 26], [E_RIBS, 38], [E_SPINE, 40], [E_APPROACH, 44],
  [E_CAROUSEL, 46], [E_KEEL, 31], [E_ANTECHOIR, 15], [E_RUNIN, 17.4], [EXT_ARC, 18],
]
function extY(s: number): number {
  for (let i = 1; i < EXT_Y.length; i++) {
    if (s <= EXT_Y[i][0]) {
      const [a, ya] = EXT_Y[i - 1], [b, yb] = EXT_Y[i]
      const t = clamp01((s - a) / Math.max(1e-9, b - a))
      return ya + (yb - ya) * (t * t * (3 - 2 * t))
    }
  }
  return EXT_Y[EXT_Y.length - 1][1]
}

/**
 * WIDTH AND BANK OUTSIDE THE DRUM.
 *
 * Bank is POSITIVE on every external corner, and the sign is worth stating
 * because the field's doc comment has it backwards. The bake builds
 * `right = cos(bank) * flatRight + sin(bank) * up`, so a point at lateral +w
 * rises by w*sin(bank): positive bank raises the RIGHT edge. Every corner out
 * here turns left, so the right edge is the outside, and positive is the
 * corner banked the way a corner is banked.
 */
function extWidth(s: number): number {
  if (s < E_GANTRY) return 21
  if (s < E_RIBS) return 20
  if (s < E_SPINE) return 22
  if (s < E_APPROACH) return 21
  if (s < E_CAROUSEL) return 22
  if (s < E_KEEL) return 19
  if (s < E_ANTECHOIR) return 24
  return 20
}
function extBank(s: number): number {
  const g = smoothBand(s, E_GANTRY - 30, E_GANTRY + 60, E_RIBS - 50, E_RIBS + 10)
  const sp = smoothBand(s, E_SPINE - 30, E_SPINE + 50, E_APPROACH - 40, E_APPROACH + 20)
  const c = smoothBand(s, E_CAROUSEL - 30, E_CAROUSEL + 70, E_KEEL - 70, E_KEEL + 20)
  const a = smoothBand(s, E_ANTECHOIR - 40, E_ANTECHOIR + 70, E_RUNIN - 90, E_RUNIN + 10)
  return round1(16 * g + 12 * sp + 22 * c + 18 * a)
}

/**
 * THE BOOST STRIPS: TWO, and they are placed on opposite sides of the same
 * measurement rather than by the same rule.
 *
 * Aetherion's finding is that stepAI lifts the flight class wherever the local
 * radius exceeds ~333m and the car is over 70% of top speed, and that a lifted
 * chassis sits at 5m where the pad test (altitude < 3.0) cannot see it. So a
 * pad on a straight is a pad Vector-7 skips and a pad in a corner is one
 * everybody gets.
 *
 *   - The CAROUSEL strip is on the exit of a 669m corner: nobody is lifting
 *     there, so it is a pad the whole field collects.
 *   - The RIBS strip is on the run into the Spine, which is one of the two
 *     stretches where the Lift heuristic fires. It is deliberately on the side
 *     of the measurement that the flight class loses, and it is the cheapest
 *     line on this track that is part of the flight bill.
 *
 * TWO rather than six is the other half of that lesson: the first cut of
 * Aetherion had six pads and the fourth of them was on its own worth 17 points
 * of boost uptime, because `applyBoost` re-applies every frame a wheel is on a
 * strip. Measured at 600 races this lap runs 46-53% boost uptime, which is the
 * band the three shipped circuits sit in.
 */
function extBoost(s: number): boolean {
  return (s > E_SPINE - 70 && s < E_SPINE - 25)
    || (s > E_KEEL - 60 && s < E_KEEL - 15)
}

/**
 * Node spacing outside the drum: 38m on open road, tapering to the drum's 20m
 * at both mouths so the Catmull-Rom does not bulge where the two meet.
 * Aetherion's rotunda entry is the cautionary tale -- a 32m segment meeting
 * 14.1m ones swung |k| over a 20m window between R=41m and R=641m six times in
 * 60m, which is nine crossings of the drift-hold gate and 482 drifts a race
 * started and thrown away.
 */
const EXT_MARKS: number[] = (() => {
  const stepAt = (s: number): number => {
    const toEnd = Math.min(s, EXT_ARC - s)
    return toEnd < 60 ? 20 : toEnd < 110 ? 26 : toEnd < 170 ? 32 : 38
  }
  const raw: number[] = []
  let s = 0
  while (s < EXT_ARC) { raw.push(s); s += stepAt(s) }
  // Rescale so the walk lands EXACTLY on the drum's entry rather than
  // somewhere inside the last step, then drop the node at s=0.
  //
  // BOTH HALVES OF THAT ARE A BUG FIX AND THE BUG WAS MEASURED. `s=0` is the
  // drum's EXIT, which `drumNodes` already emits, so emitting it here too put
  // two coincident waypoints in the ribbon; and an unscaled walk left the last
  // external node anywhere from 1m to 21m short of the drum's ENTRY, which
  // `drumNodes` also emits. probe-track read the pair as a 15m corner of
  // Rmin 5m turning 36 degrees -- a Class C kink, on the seam, priced at
  // 12.9 m/s against a field arriving at 55.
  const k = EXT_ARC / s
  return raw.map((v) => v * k).slice(1)
})()

function extNodes(): TrackNode[] {
  const out: TrackNode[] = []
  for (const m of EXT_MARKS) {
    const p = extAt(m)
    out.push({
      p: [round1(p.x), round1(extY(m)), round1(p.z)],
      w: extWidth(m),
      surface: extSurface(m),
      bank: extBank(m),
      wind: extWind(m),
      boost: extBoost(m) || undefined,
      tag: extTag(m),
    })
  }
  return out
}

/**
 * THE ANTECHOIR IS THE ONLY LOW-GRIP SURFACE ON THE TRACK, AND IT IS THERE FOR
 * BULWARK, by exactly the arithmetic Aetherion's last corner uses.
 *
 * Drift charge per metre is 0.55/v + 0.45/topSpeed, so a corner taken slower
 * banks more. The Antechoir tightens from R=196 to R=70 into the near mouth and
 * is already the hardest braking on the lap; putting its last third on shed
 * regolith -- two centuries of dust off the wreck's own hull, drifted into the
 * lee of the mouth -- takes it slower still and hands the difference back as
 * charge, on the one corner that ends pointing at the drum.
 *
 * `gravel` at 0.70, not ice: this is a debris field, and 0.45 on a 70m-radius
 * corner would make it a braking event rather than a chargeable one.
 */
function extSurface(s: number): SurfaceKind {
  return (s > E_ANTECHOIR + 190 && s < E_RUNIN + 40) ? 'gravel' : 'tarmac'
}

/**
 * THE DRAUGHT, and the second half of the flight bill.
 *
 * The drum's atmosphere has been escaping through the Breach for two hundred
 * years, and the superstructure is what it escapes THROUGH: there is a steady
 * draught down the galleries, strongest in the two narrow links where the
 * cross-section pinches. It is the same air the spin drag is made of and it is
 * going the same place, which is why one wind envelope covers the drum's sealed
 * bays and another covers the galleries, and why neither of them touches the
 * Breach itself.
 *
 * MECHANICALLY IT IS THE ONLY TAX ON THIS TRACK AIMED AT THE STRAIGHTS, and
 * that is deliberate: `wind` scales by `fieldForceMult` (grounded 1.00, hover
 * 1.50, flight 1.80), so a crosswind on the two longest flat-out stretches is
 * the one cost that charges the flight class and forgives the grounded one.
 * The Keel and the Ribs are also exactly where Vector-7's Lift heuristic fires
 * (stepAI lifts wherever the local radius exceeds ~333m), so it is spent where
 * the class is strongest rather than averaged over the lap.
 *
 * Both stretches are WALLED and 20-24m of half-width. Aetherion's measurement
 * is the reason that matters and it is not re-litigated here: the same field on
 * an open deck is a cliff (16.4 -> 18.9 moved Vector-7 from 23.5% of wins to
 * 11.5% and put respawns on the section) and on walled road it is a ramp that
 * spends itself as scrub and lost line. This is a ramp.
 */
function extWind(s: number): number {
  const keel = smoothBand(s, E_KEEL - 20, E_KEEL + 90, E_ANTECHOIR - 120, E_ANTECHOIR - 10)
  const ribs = smoothBand(s, E_RIBS - 20, E_RIBS + 80, E_SPINE - 80, E_SPINE + 10)
  return round1(DRAUGHT_KEEL * keel + DRAUGHT_RIBS * ribs)
}
const DRAUGHT_KEEL = 38
const DRAUGHT_RIBS = 46

function extTag(s: number): string | undefined {
  if (s < 1) return 'transept-out'
  if (s >= E_GANTRY && s < E_GANTRY + 38) return 'gantry'
  if (s >= E_CAROUSEL && s < E_CAROUSEL + 38) return 'carousel'
  if (s >= E_RIBS && s < E_RIBS + 38) return 'ribs'
  if (s >= E_SPINE && s < E_SPINE + 38) return 'spine'
  if (s >= E_KEEL && s < E_KEEL + 38) return 'keel'
  if (s >= E_ANTECHOIR && s < E_ANTECHOIR + 38) return 'antechoir'
  return undefined
}

// ===========================================================================
// THE LAP
//
// Assembled starting at the KEEL -- the primary straight -- so the start line
// sits on the longest piece of road on the circuit and the first corner a
// player meets is the Antechoir, which is the one that teaches the lap: turn
// in, hold it, let it tighten, and arrive at the drum's mouth pointing at it.
// ===========================================================================

function lapNodes(): TrackNode[] {
  const ext = extNodes()
  let cut = EXT_MARKS.findIndex((m) => m >= E_KEEL)
  if (cut < 0) cut = 0
  return [...ext.slice(cut), ...drumNodes(), ...ext.slice(0, cut)]
}

export const HOLLOWCHOIR: TrackDef = {
  id: 'hollowchoir',
  name: 'The Hollow Choir',
  // GREY-BOX PALETTE, authored for a derelict and not art-passed.
  //
  // The one lighting fact that drives everything: there is no sun here worth
  // the name. This is a wreck a long way out, lit by a small cold star and by
  // its own surviving emergency lamps, and the interior of the drum is lit by
  // whatever comes through the Breach. So the key is weak and blue-white, the
  // ambient carries most of the load (a huge enclosed metal volume bouncing its
  // own light), and the accent -- the only warm colour on the planet -- is the
  // amber of the failing strip lighting along the deck.
  //
  // Cryostatic's warning is heeded from the other side: that track buries pale
  // cars in a pale sky, and this one could bury dark cars in a dark one. The
  // fog is a cold grey well ABOVE the hull's own value, so the structure reads
  // as silhouette against haze rather than as darkness against darkness, and
  // the density is low because the drum is 164m across and the whole point of
  // being inside it is that you can see the road above your head.
  //
  //
  // THE FILL WAS RAISED BY THE ART PASS, AND THE REASON IS MEASURED.
  //
  // Authored at 0x3a4656 / 1.05 against a 0x1b2430 sky, the total INDIRECT
  // irradiance on an up-facing surface came to about 0.03 in linear, against
  // Rustfall's 0.53 and Aetherion's comparable figure -- an order of magnitude
  // under both, because `skyBottom` doubles as the HemisphereLight's sky
  // colour and the shipped three all author it bright. On this circuit that is
  // fatal rather than merely dark: inside a drum the KEY does no work at all,
  // since the road's normal is the inward radial and the sun runs nearly along
  // the axis, so N.L is close to zero everywhere on the bore. Every photograph
  // of the drum came back with the deck at pure black and nothing visible but
  // the barrier's own emissive cap lamps.
  //
  // What is below is the same intent with numbers that reach it. The key is
  // HARD and cold, because a small star in vacuum casts a hard shadow and
  // there is no air to soften it; the fill is ambient-dominant, because a huge
  // enclosed metal volume bounces its own light, which was always the note.
  // The one deliberate asymmetry is that the DOWN-facing fill (0x76889c, the
  // HemisphereLight's ground colour) is brighter than the up-facing one
  // (0x46596e, its sky colour) -- which inside a drum is simply true: what is
  // over an inverted car's head is the lit floor of the bore, and what is over
  // an upright one's is 140 m of dark.
  skyTop: 0x05070d,
  skyBottom: 0x46596e,
  fogColor: 0x39424e,
  fogDensity: 0.0024,
  sunColor: 0xcfe0ff,
  sunIntensity: 2.40,
  ambientColor: 0x76889c,
  ambientIntensity: 1.90,
  // Low and nearly along the drum's axis, so the light rakes down the bore and
  // the ribs read as ribs. A high sun on a cylinder lights one stripe of it and
  // leaves the rest flat.
  sunDirection: [0.16, 0.26, -0.95],
  // a: hull plate, grey-green oxidised steel.  b: bare structural alloy, the
  // ribs and the gantry.  c: the dark of an unlit interior.  accent: amber
  // emergency lighting, the only emissive and the only warmth.
  palette: { a: 0x8f9a96, b: 0xb9c2c8, c: 0x141a20, accent: 0xffa63a },
  laps: 3,
  nodes: lapNodes(),
  // ITEM BOX ROWS. Same measured failure Rustfall, Cryostatic and Aetherion all
  // record: `stepAI` has no item-seeking term, so a row taken off the driven
  // line is a row the AI never touches. Rows sit on the line and spreads stay
  // at or above the 2.4m box mesh. Nothing here re-litigates it; the fix is in
  // src/sim/ai.ts.
  itemBoxRows: [
    { at: 0.05, count: 5, spread: 4.4 },
    { at: 0.20, count: 4, spread: 4.0 },
    { at: 0.35, count: 5, spread: 4.2 },
    { at: 0.50, count: 5, spread: 4.2 },
    { at: 0.66, count: 5, spread: 4.2 },
    { at: 0.84, count: 5, spread: 4.4 },
  ],
  chargeRuns: [
    { from: 0.02, to: 0.07, count: 6, lateral: -5 },
    { from: 0.17, to: 0.23, count: 7, lateral: 5 },
    { from: 0.34, to: 0.40, count: 7, lateral: 0 },
    { from: 0.52, to: 0.58, count: 6, lateral: -5 },
    { from: 0.70, to: 0.76, count: 7, lateral: 5 },
    { from: 0.88, to: 0.94, count: 8, lateral: 0 },
  ],
}

/** Exposed for tools/probes and tests: the authored beat marks, in lap order. */
export const HOLLOWCHOIR_BEATS = {
  drumArc: DRUM_ARC,
  breachLen: BREACH_LEN,
  extArc: EXT_ARC,
  extTurn: EXT_TURN,
  runOut: RUN_OUT,
  keel: KEEL,
  drumR: DRUM_R,
}
