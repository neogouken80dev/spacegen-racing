import type { TrackDef, TrackNode } from '../../sim/track'
import { ring, envelope, inSpan, type Harm } from './ring'

/**
 * ASHKAR — Volcanic Shield.
 *
 * The fifth circuit, and the first authored from a harmonic ring rather than a
 * turtle (see the header of ring.ts for why the turtle kept demanding a
 * straight that ran 400 metres backwards).
 *
 * Difficulty: Medium. It sits between Namaresh and Elkarim on purpose -- the
 * roster needed a circuit whose difficulty comes from SURFACE and SIGHTLINES
 * rather than from a hazard you can be killed by. Nothing on Ashkar deletes a
 * lap. The ash beds cost you a tenth at a time.
 *
 * ---------------------------------------------------------------------------
 * 1. THE TWO SET PIECES ARE SET PIECES, AND THE ARITHMETIC SAYS SO.
 *
 * The Lava Tube is a full vertical loop; the Corkscrew is two turns of helix
 * around the inside of a tube. Both are the headline images of the track and
 * NEITHER IS A CORNER, which is not a disappointment to be designed around but
 * a fact to design WITH.
 *
 * `Track.curvatureAt` measures curvature about the SURFACE NORMAL on a gravity
 * track, which is the right thing to measure. A loop's curvature vector points
 * straight along that normal; so does a helix's. Their geodesic curvature is
 * therefore identically zero, and the sim reads both as DEAD STRAIGHT --
 * measured at 0.0000 across 120m either side of the loop apex (tools/probe
 * -loop.ts), against the AI's 0.0045 drift-hold gate. Nothing brakes for them.
 * Nothing drifts in them. Aetherion's rotunda cost three balance rounds to
 * exactly this arithmetic before anyone wrote it down.
 *
 * So both are placed where the lap can AFFORD to be flat out, and the lap's
 * actual work is done by the ash beds and the last corner. The loop's job is to
 * be the thing you tell someone about; the ash beds' job is to decide the race.
 *
 * 2. THE ASH BEDS ARE THE TRACK.
 *
 * A third of the lap is gravel (grip 0.70). They are wide, fast and banked,
 * which makes them a drift section rather than a penalty box -- the same shape
 * as Elkarim's gravel, opened out. Gravel also means the AI's corner model and
 * the player's are furthest apart here, which is where overtakes come from.
 *
 * 3. THE UPDRAFT.
 *
 * `wind` through the caldera rim, ramped in and out across 14% of the lap so it
 * never switches on at a sample boundary. The rim is BARRIERED, and that is a
 * measurement rather than a preference: run with the same gust over `open` road
 * and the field respawns 16.3 times a race against 0.0-0.7 on every shipped
 * circuit, all of it inside that one stretch. The wind now pushes you into a
 * bounce wall instead of off a cliff, which is a corner you can commit to --
 * especially since contact no longer ends a drift. Debris draws it (see
 * themes/emberfall.ts); a force the player cannot see is not weather, it is a
 * bug, and that lesson is already paid for.
 *
 * 4. WHAT IT DELIBERATELY DOES NOT HAVE.
 *
 * No `fragile`. A collapsing lava crust is the obvious gimmick and it is not
 * available honestly: `fragile` turns the surface into `T.hazard.crackedSurface`
 * which is a GLOBAL, and on this planet that global is ice. Shipping a lava
 * shelf that cracks into ice to reuse a mechanic would be a lie in the one
 * place the player is looking. Making the cracked surface per-track is a real
 * change to a determinism-gated system and belongs in its own pass, not
 * smuggled in behind a new planet.
 * ---------------------------------------------------------------------------
 */

/**
 * The ring. Searched rather than drawn (tools/probe-ring.ts): plan length
 * 3150m with radii from 64m to effectively straight, which puts the tightest
 * corner just inside Class B and leaves two stretches long enough to be read as
 * straights. k=2 puts the waist in at the ash beds; k=3 gives the rim its lobe.
 */
const H: Harm[] = [
  { k: 1, ax: 352, bx: 0, az: 0, bz: 281.6 },
  { k: 2, ax: 0, bx: 56.3, az: 39.4, bz: 0 },
  { k: 3, ax: 42.2, bx: 56.3, az: -33.8, bz: 25.4 },
]

const SPACING = 26
const RING = ring(H, SPACING)
/** Plan length of the ring, metres — the loops size their sampling off it. */
const PLAN_LEN = RING.length * SPACING

/** Lap-fraction beat map. Everything below reads off this and nothing else. */
const BEATS = {
  start: [0.95, 0.08] as [number, number],
  fissure: 0.17,
  ashBeds: [0.22, 0.40] as [number, number],
  /**
   * THE THREE LOOPS, escalating. Each spans a stretch of ring rather than
   * hanging off one node -- see `loopAt` for why a loop that does not travel
   * cannot help but drive through itself.
   */
  loops: [
    { at: 0.44, r: 26, side: +1 },
    { at: 0.525, r: 32, side: -1 },
    { at: 0.615, r: 38, side: +1 },
  ],
  corkscrew: [0.74, 0.90] as [number, number],
  updraft: [0.915, 0.985] as [number, number],
}

/**
 * Elevation, metres. A shield volcano: climb to the rim, drop into the vent.
 *
 * THE FLOOR IS 6m AND USED TO BE -5. The old profile bottomed out below the
 * world's own zero, which put the lap's tightest corner in a trench -- and that
 * corner was also the narrowest road on the circuit, because the updraft's
 * width penalty happened to land on it. Reported as "a very narrow portion with
 * a strange bend in it", which is exactly what three unrelated minima stacking
 * on one another looks like from the driver's seat.
 */
function elevation(u: number): number {
  return (
    16 * Math.sin(2 * Math.PI * (u - 0.05)) +
    8 * Math.sin(4 * Math.PI * (u + 0.12)) +
    30
  )
}

/**
 * How far a loop steps SIDEWAYS between going up and coming down, metres.
 *
 * This is the whole fix for "it launches into itself". A loop-de-loop returns
 * to its own entry point by definition: the road climbs, inverts, and comes
 * back down onto the exact metre it left, so the up-leg and the down-leg occupy
 * the same space and the car drives through the piece of track it is about to
 * be on. Advancing the loop FORWARD does not fix it either -- at the apex a
 * loop is travelling backwards relative to the road, so a forward-only stagger
 * still folds through itself at the crossing.
 *
 * What separates the legs is lateral offset: the loop leans out of the racing
 * line on the way up and back through it on the way down, so the two passes sit
 * side by side. 62m against a ~38m road leaves 24m of daylight between them.
 *
 * The offset is enveloped so that its VALUE and its DERIVATIVE are both zero at
 * the mouths -- see `loopAt`. A stagger that merely starts at zero still hands
 * the entry a 50-degree kink.
 */
const LOOP_STAGGER = 54
const CORK_R = 52
const CORK_TURNS = 2
const CORK_W = 34

/**
 * The ring at an arbitrary lap fraction, linearly between its baked points.
 *
 * The corkscrew needs this: at a 52m bore it cannot be sampled at the ring's
 * own 26m spacing without hopping 42m sideways between neighbours.
 */
function ringAt(u: number): { x: number; z: number; heading: number } {
  const n = RING.length
  const t = (((u % 1) + 1) % 1) * n
  const i = Math.floor(t) % n
  const j = (i + 1) % n
  const f = t - Math.floor(t)
  const a = RING[i], b = RING[j]
  // Headings interpolate on the shortest arc, or the seam flips the road.
  let dh = b.heading - a.heading
  while (dh > Math.PI) dh -= Math.PI * 2
  while (dh < -Math.PI) dh += Math.PI * 2
  return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, heading: a.heading + dh * f }
}

/**
 * A LOOP THAT CROSSES SIDEWAYS, so its entry and its exit are not the same road.
 *
 * WHAT "IT LAUNCHES INTO ITSELF" ACTUALLY IS. A circle traversed once does not
 * intersect itself -- the problem was never the loop. It was that a textbook
 * loop RETURNS TO ITS OWN ENTRY POINT, so the approach road and the exit road
 * occupy the same metre of ground, and the car flies up through the piece of
 * track it is about to land on.
 *
 * TWO FIXES WERE TRIED. Advancing the loop forward along the ring looks like
 * the obvious one and is wrong twice over: at the apex a loop travels BACKWARDS
 * relative to the road, so the ring's advance and the loop's own swing cancel
 * -- measured as a 1.6m step between nodes where the neighbours were 23m apart,
 * a chord ratio of 17, and an 11m-radius phantom corner the AI braked for. It
 * also needs the span to exceed the loop's circumference to work at all, which
 * for three loops is 40% of the lap.
 *
 * What works is LATERAL. The loop sits at one point on the ring, consumes no
 * distance, and slides `LOOP_STAGGER` metres across the road between going up
 * and coming down: in at the left of the corridor, out at the right. Entry and
 * exit are then 54m apart against a ~38m road, and every chord through the loop
 * comes out within a metre of every other because nothing is cancelling.
 *
 * The slide is a smoothstep, so its DERIVATIVE is zero at both mouths as well
 * as its value -- a linear crossing hands the entry a visible kink. It runs
 * -A/2 to +A/2 rather than 0 to A so the debt is shared: the approach eases one
 * way, the exit eases back, and neither has to swallow the whole 54m.
 */
function loopAt(f: number, r: number, side: number): { fwd: number; up: number; lat: number } {
  const th = 2 * Math.PI * f
  const sm = f * f * (3 - 2 * f)
  return {
    fwd: r * Math.sin(th),
    up: r * (1 - Math.cos(th)),
    lat: side * LOOP_STAGGER * (sm - 0.5),
  }
}

/**
 * The lateral lead-in and lead-out either side of each loop.
 *
 * A loop leaves the road half a stagger off the racing line, so the ring has to
 * absorb it: the approach drifts to -A/2 over `LOOP_BLEND` of the lap and the
 * exit comes back from +A/2 over the same. At 0.05 of a ~2500m ring that is
 * 125m to shed 27m, about 12 degrees -- a lane change, not a chicane.
 */
const LOOP_BLEND = 0.05

function loopBias(u: number): number {
  let bias = 0
  for (const L of BEATS.loops) {
    let d = u - L.at
    if (d > 0.5) d -= 1
    if (d < -0.5) d += 1
    if (d < 0 && d > -LOOP_BLEND) {
      const t = 1 + d / LOOP_BLEND
      bias += L.side * -0.5 * LOOP_STAGGER * (t * t * (3 - 2 * t))
    } else if (d > 0 && d < LOOP_BLEND) {
      const t = 1 - d / LOOP_BLEND
      bias += L.side * 0.5 * LOOP_STAGGER * (t * t * (3 - 2 * t))
    }
  }
  return bias
}

function build(): TrackNode[] {
  const out: TrackNode[] = []
  const n = RING.length
  const corkFrom = BEATS.corkscrew[0], corkTo = BEATS.corkscrew[1]

  for (let i = 0; i < n; i++) {
    const p = RING[i]
    const u = p.u
    const y = elevation(u)
    const fx = Math.sin(p.heading), fz = Math.cos(p.heading)
    const rx = Math.cos(p.heading), rz = -Math.sin(p.heading)

    // ---- THE THREE LOOPS. Each hangs off one ring node and consumes no ring
    // distance; the lateral crossing is what separates its entry from its exit.
    // See `loopAt` for why forward advance was tried first and does not work.
    const li = BEATS.loops.findIndex((L) => Math.abs(shortest(u - L.at)) < 0.5 / n)
    if (li >= 0) {
      const L = BEATS.loops[li]
      // Sampled to match the RING's chord, not to be as smooth as possible.
      // A section sampled far finer than its neighbours is its own kind of
      // spacing mismatch -- the bake's Catmull-Rom weights a node against its
      // neighbours regardless of distance, so 8m nodes meeting 26m ones spike
      // curvature exactly like 100m ones do. 26 degrees of arc between nodes
      // costs 4mm of circularity on a 38m loop, which is nothing.
      const steps = Math.max(14, Math.round((2 * Math.PI * L.r) / 18))
      // INCLUSIVE of f=1, and that closing node matters. At f slightly under 1
      // the road is still 16m BEHIND its exit station (the forward term is
      // returning from -R), so stopping at steps-1 left a 42m jump to the next
      // ring node against a 12m loop chord. The f=1 node sits at the same
      // longitudinal station as the entry, half a stagger across the road --
      // which is the whole point of the loop, and is also where the lead-out
      // ramp expects to start.
      for (let sIdx = 0; sIdx <= steps; sIdx++) {
        const f = sIdx / steps
        const o = loopAt(f, L.r, L.side)
        const th = 2 * Math.PI * f
        out.push({
          p: [
            r1(p.x + o.fwd * fx + o.lat * rx),
            r1(y + o.up),
            r1(p.z + o.fwd * fz + o.lat * rz),
          ],
          w: 19,
          // Up points at the loop's centre: world-up at the mouths, world-DOWN
          // at the apex, which is what inverts the car. `stick` defaults to 1
          // wherever up leaves +Y, so a racer that gets light over the top
          // falls back toward the road rather than out of the loop.
          up: [r3(-Math.sin(th) * fx), r3(Math.cos(th)), r3(-Math.sin(th) * fz)],
          surface: 'metal',
          tag: sIdx === 0 ? `loop${li + 1}`
            : sIdx === Math.round(steps / 2) ? `loop${li + 1}-apex`
            : undefined,
        })
      }
      continue
    }

    // ---- THE CORKSCREW. The ring supplies the AXIS; the road spirals around
    // the inside of it. Two full turns, so it leaves upright -- a half-turn
    // would hand the next node a 180-degree up-vector flip and the bake would
    // (correctly) refuse it.
    //
    // THE BORE AND THE ROAD BOTH DOUBLED (26 -> 52m, 17 -> 34m half-width). At
    // the old size the spiral read as a pipe you were threaded through rather
    // than a place you drove; at 52m the barrel is wide enough that the far
    // wall is scenery instead of a ceiling.
    //
    // AND IT SAMPLES ITSELF, at ~12m, instead of riding the ring's 26m nodes.
    // Doubling the bore doubled the distance the road travels per degree of
    // sweep: at ring spacing the spiral was stepping 48 degrees at a time round
    // a 52m barrel, which is a 42m lateral hop between neighbours -- measured as
    // a 53.9m chord against an 8m one elsewhere, and an 18m phantom corner. The
    // sweep did not change; the resolution had to.
    if (inSpan(u, corkFrom, corkTo)) {
      const prevU = RING[(i - 1 + n) % n].u
      if (inSpan(prevU, corkFrom, corkTo)) continue
      const span = corkTo - corkFrom
      const spanLen = span * PLAN_LEN
      // Stepped along the AXIS, not along the arc. Sizing by arc length gives
      // 6m chords at the mouths (where the radius ramp is near zero and the
      // road is barely moving sideways) against 26m on the ring either side --
      // the mismatch this whole file keeps paying for. Axis stepping puts the
      // mouths at 13m and the full-bore middle at ~25m, which straddles the
      // ring instead of undercutting it.
      const steps = Math.max(24, Math.round(spanLen / 13))
      for (let sIdx = 0; sIdx < steps; sIdx++) {
        const f = sIdx / steps
        const uu = corkFrom + span * f
        const rp = ringAt(uu)
        const crx = Math.cos(rp.heading), crz = -Math.sin(rp.heading)
        const th = 2 * Math.PI * CORK_TURNS * f
        // THE SPIRAL RADIUS RAMPS IN AND OUT, and this is not styling. At a
        // constant radius the helix starts at its full ANGULAR rate on its very
        // first node, so the road steps sideways almost as fast as it moves
        // forward -- a 45-degree kink at each mouth, which the sim read as a
        // 22m-radius corner in the middle of what is supposed to be a flat-out
        // set piece. Nothing in the roster can hold 22m.
        const rawEnv = Math.max(0, Math.min(1, Math.min(f / 0.35, (1 - f) / 0.35)))
        const rEff = CORK_R * rawEnv * rawEnv * (3 - 2 * rawEnv)
        out.push({
          p: [
            r1(rp.x + rEff * Math.sin(th) * crx),
            r1(elevation(uu) + rEff - rEff * Math.cos(th)),
            r1(rp.z + rEff * Math.sin(th) * crz),
          ],
          w: CORK_W,
          up: [r3(-Math.sin(th) * crx), r3(Math.cos(th)), r3(-Math.sin(th) * crz)],
          surface: 'metal',
          boost: f > 0.42 && f < 0.58,
          tag: sIdx === 0 ? 'corkscrew' : undefined,
        })
      }
      continue
    }

    // ---- ORDINARY ROAD.
    const onAsh = inSpan(u, BEATS.ashBeds[0], BEATS.ashBeds[1])
    const gustNow = envelope(u, BEATS.updraft[0], BEATS.updraft[1], 0.30)
    const bias = loopBias(u)
    const node: TrackNode = {
      p: [r1(p.x + bias * rx), r1(y), r1(p.z + bias * rz)],
      w: r1(width(u, p.k)),
    }
    if (onAsh) node.surface = 'gravel'
    // Bank INTO the corner, scaled by how tight it actually is. `bank` and not
    // `up`: this is level ground that leans, not anti-gravity architecture, and
    // a banked node with world-up keeps plain world gravity on a jump.
    const bank = clamp(-p.k * 1150, -13, 13)
    if (Math.abs(bank) > 0.6) node.bank = r1(bank)
    // THE UPDRAFT KEEPS ITS WALLS. The first draft made the crosswind and the
    // drop the same beat -- wind over `open` road, so being blown wide meant
    // falling off the rim. Measured: 16.3 respawns a race against 0.0-0.7 on
    // every shipped circuit, and all 49 of them inside this one stretch. That
    // is not difficulty, it is a section the field cannot survive.
    //
    // The wind stays and the edge gets barriers. Being blown into a wall you
    // bounce off is a beat; being blown off a cliff is a loading screen.
    if (gustNow > 0.02) { node.wind = r1(13 * gustNow); node.bounce = true }
    if (Math.abs(u - BEATS.fissure) < 0.012) { node.ramp = 30; node.boost = true; node.tag = 'fissure' }
    if (inSpan(u, BEATS.fissure + 0.012, BEATS.fissure + 0.05)) node.open = true
    if (Math.abs(u - BEATS.ashBeds[0]) < 0.005) node.tag = 'ashbeds'
    if (u === 0) node.tag = 'start'
    out.push(node)
  }
  return out
}

/**
 * Road half-width.
 *
 * NOTHING SUBTRACTS ANY MORE, and the floor went 15 -> 18.5. The old version
 * took 4m off for curvature and another 1.5m across the updraft, and those two
 * penalties landed on the same stretch as the ring's tightest corner and the
 * elevation profile's minimum. Four independent "slightly worse here" terms
 * stacked into one 15.5m-wide 55m-radius bend in a trench -- reported as "a
 * very narrow portion with a strange bend in it".
 *
 * The lesson generalises past this track: a width function built out of
 * subtractions has no floor you can reason about, because the penalties do not
 * know about each other. This one ADDS to a base, so the narrowest the circuit
 * can be is the base, and the base is a number somebody chose.
 *
 * The tightest corner also gets a WIDENING rather than a pinch. A tight bend is
 * where a driver most needs room to take a different line, and pinching it is
 * the one thing guaranteed to make a corner feel arbitrary.
 */
function width(u: number, k: number): number {
  let w = 20
  w += 3.5 * Math.min(1, Math.abs(k) * 90)
  if (inSpan(u, BEATS.ashBeds[0], BEATS.ashBeds[1])) w += 3.5
  if (inSpan(u, BEATS.start[0], BEATS.start[1])) w += 2
  return clamp(w, 18.5, 26)
}

/** Shortest signed distance between two lap fractions, wrapping the seam. */
function shortest(d: number): number {
  if (d > 0.5) return d - 1
  if (d < -0.5) return d + 1
  return d
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const r1 = (v: number) => Math.round(v * 10) / 10
const r3 = (v: number) => Math.round(v * 1000) / 1000

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
  nodes: build(),
  // Rows sit ON the driven line and at or above the 2.4m box mesh, for the
  // reason the other four circuits all record: `stepAI` has no item-seeking
  // term, so a row taken off the line is a row the AI never touches.
  itemBoxRows: [
    { at: 0.10, count: 5, spread: 4.4 },
    { at: 0.30, count: 5, spread: 4.6 },
    { at: 0.46, count: 4, spread: 4.0 },
    { at: 0.74, count: 5, spread: 4.4 },
    { at: 0.88, count: 5, spread: 4.2 },
  ],
  chargeRuns: [
    { from: 0.03, to: 0.08, count: 6, lateral: -5 },
    { from: 0.26, to: 0.33, count: 8, lateral: 5 },
    { from: 0.36, to: 0.41, count: 6, lateral: -6 },
    { from: 0.53, to: 0.58, count: 6, lateral: 0 },
    { from: 0.78, to: 0.85, count: 7, lateral: -5 },
  ],
  laps: 3,
}
