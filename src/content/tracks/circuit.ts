import type { TrackNode, SurfaceKind } from '../../sim/track'

/**
 * ===========================================================================
 * THE CIRCUIT BUILDER — a racetrack as a sequence of corners.
 * ===========================================================================
 *
 * This replaces `ring.ts` for authoring, and the reason is worth stating
 * plainly because two passes were spent on the wrong abstraction.
 *
 * A harmonic ring closes by construction and is smooth everywhere, which made
 * it attractive. What it CANNOT express is a racetrack. A sum of three or four
 * harmonics has no straights, no braking zones, and two to four gentle bends;
 * the radius wanders continuously and you get whatever radii the coefficients
 * imply. Four circuits built that way measured correctly on every gate and
 * played, in the report that killed them, as "overall oval or square-ish
 * designs [that] do not offer a lot of variety", with "the few turns... far too
 * sharp", causing crashes rather than challenge.
 *
 * The measurement behind that report is stark. At this grip model
 * (`T.grip.lateralAccel` 34, roster gripCoeff ~1.07) the corner speed for a
 * radius R is sqrt(1.07 * 34 * R), against a roster top speed of 59-64 m/s:
 *
 *      40m   38 m/s   62% of top speed   hairpin, heavy braking
 *      60m   47 m/s   76%                slow corner
 *      80m   54 m/s   88%                medium - the drift corner
 *     100m   61 m/s   98%                fast sweeper, a lift
 *     120m   66 m/s  108%                FLAT OUT - not a corner at all
 *
 * So anything past ~100m is a straight the car happens to be turning on. Those
 * four circuits had a MEDIAN radius of 113-140m and a single 45m minimum: a lap
 * that is flat out everywhere and then, once, asks for 62% of top speed with no
 * warning. That is not a difficulty problem, it is a STRUCTURE problem, and no
 * amount of re-searching coefficients fixes it.
 *
 * A real circuit is a sequence: a straight to build speed, a braking zone, a
 * corner of a CHOSEN radius, an exit, another straight. Ten to fourteen of them,
 * with radii spread across the bands above so the lap has slow corners to drift,
 * medium corners to commit to, and fast sweepers to hold. That is what this file
 * authors, and it is why every corner here is a named thing with a number rather
 * than a consequence of a Fourier coefficient.
 *
 * ---------------------------------------------------------------------------
 * CLOSURE, WITHOUT THE TRAP THAT KILLED THE FIRST TURTLE.
 *
 * Headings close when the corner angles sum to +/-360. Position is then LINEAR
 * in the straight lengths, so closing it is a 2xN linear system -- and the first
 * attempt solved it by picking two straights as free variables, which returns
 * the exact answer and the exact answer was repeatedly "make this straight 400
 * metres long and that one negative". A negative straight is not a road.
 *
 * `close()` instead takes the MINIMUM-NORM correction: the smallest total change
 * to ALL straights that shuts the lap. Every straight moves a little, none is
 * asked to absorb the whole error, and the authored proportions survive. If any
 * straight would still go under its floor the builder says so rather than
 * emitting a circuit that folds through itself.
 */

/** Corner radius bands, in the units that matter: fraction of top speed. */
export const BANDS = {
  /** 45-58m. Heavy braking, 62-74% of top speed. One or two a lap, no more. */
  hairpin: [45, 58] as [number, number],
  /** 58-80m. 74-88%. The corners a driver actually drifts. */
  medium: [58, 80] as [number, number],
  /** 80-110m. 88-103%. A lift and a commitment. */
  fast: [80, 110] as [number, number],
  /** 110-220m. Flat out, but still inside the AI's drift-hold gate (R<222m). */
  sweeper: [110, 220] as [number, number],
}

export type Seg =
  | ({ t: 'straight'; len: number } & Attrs)
  | ({ t: 'corner'; r: number; deg: number } & Attrs)
  /** A vertical loop. Consumes no plan distance; crosses `stagger` sideways. */
  | ({ t: 'loop'; r: number; side?: 1 | -1; stagger?: number } & Attrs)
  /** A corkscrew along a straight of `len`. `turns` must be a whole number. */
  | ({ t: 'cyclone'; r: number; turns: number; len: number } & Attrs)
  /** A ramp and the gap after it. */
  | ({ t: 'jump'; len: number; launch: number; gap: number } & Attrs)

export interface Attrs {
  w?: number
  bank?: number
  surface?: SurfaceKind
  boost?: boolean
  bounce?: boolean
  open?: boolean
  wind?: number
  /** Elevation at the END of this segment, metres. Ramped from the current. */
  toY?: number
  /** Marks the segment as enclosed. Art only -- the sim has no tunnel concept. */
  tunnel?: boolean
  tag?: string
}

export interface CircuitOpts {
  /** Metres between emitted nodes. ~24 keeps chord ratios near 1. */
  spacing?: number
  start?: [number, number, number]
  /** Initial heading, degrees clockwise from +Z. */
  heading?: number
  defaults?: Attrs
  /** Shortest a straight may become after closure. */
  minStraight?: number
  /**
   * Least vertical gap allowed where the road crosses its own road, metres.
   * A car is 2.4m and the deck it drives on has to sit under something, so
   * the default is a bridge's worth rather than a clearance sticker's worth.
   */
  minClearance?: number
}

const DEG = Math.PI / 180
const r1 = (v: number) => Math.round(v * 10) / 10
const r3 = (v: number) => Math.round(v * 1000) / 1000

interface Built {
  nodes: TrackNode[]
  /** Straight lengths after the closure correction. */
  straights: number[]
  gap: number
  turn: number
  /** Plan length. */
  length: number
  /** Which lap fraction each tagged segment starts at. */
  marks: Record<string, number>
  tunnels: [number, number][]
  /** Uniform growth applied to the authored straights to make the lap close. */
  scale?: number
  /** Where the road passes over its own road. Empty for an ordinary lap. */
  crossovers: Crossover[]
}

/** One place where two distant parts of the lap share ground in plan. */
export interface Crossover {
  /** Lap distance of the lower deck and of the upper deck, metres. */
  under: number
  over: number
  /** Vertical separation at the crossing, metres. Always positive. */
  clearance: number
  at: [number, number]
}

/**
 * Walk the segment list, applying `L` as the straight lengths in order.
 * `emit` false runs the geometry only, which is what closure needs.
 */
function walk(segs: Seg[], L: number[], o: Required<CircuitOpts>, emit: boolean): Built {
  let x = o.start[0], y = o.start[1], z = o.start[2]
  let h = o.heading * DEG
  const nodes: TrackNode[] = []
  const marks: Record<string, number> = {}
  const tunnels: [number, number][] = []
  let si = 0
  let dist = 0
  let tunnelFrom = -1

  const attr = (a: Attrs, u: number, upVec?: [number, number, number]): TrackNode => {
    const g = <K extends keyof Attrs>(k: K): Attrs[K] => (a[k] !== undefined ? a[k] : o.defaults[k])
    const n: TrackNode = { p: [r1(x), r1(y), r1(z)], w: r1((g('w') as number) ?? 20) }
    const bank = g('bank') as number | undefined
    if (bank) n.bank = r1(bank)
    const su = g('surface') as SurfaceKind | undefined
    if (su) n.surface = su
    if (g('boost')) n.boost = true
    if (g('bounce')) n.bounce = true
    if (g('open')) n.open = true
    const wd = g('wind') as number | undefined
    if (wd) n.wind = r1(wd)
    if (upVec) n.up = [r3(upVec[0]), r3(upVec[1]), r3(upVec[2])]
    void u
    return n
  }

  for (const s of segs) {
    const startDist = dist
    if (s.tag) marks[s.tag] = startDist
    if (s.tunnel && tunnelFrom < 0) tunnelFrom = startDist
    if (!s.tunnel && tunnelFrom >= 0) { tunnels.push([tunnelFrom, startDist]); tunnelFrom = -1 }

    if (s.t === 'straight' || s.t === 'jump' || s.t === 'cyclone') {
      const len = s.t === 'straight' ? L[si++] : s.len
      const dx = Math.sin(h), dz = Math.cos(h)
      const rx = Math.cos(h), rz = -Math.sin(h)
      const y0 = y, y1 = s.toY ?? y
      const steps = Math.max(1, Math.round(len / (s.t === 'cyclone' ? 13 : o.spacing)))
      for (let i = 0; i < steps; i++) {
        const f = i / steps
        const px = x + len * f * dx, pz = z + len * f * dz
        const py = y0 + (y1 - y0) * f
        if (emit) {
          const sx = x, sy = y, sz = z
          x = px; y = py; z = pz
          if (s.t === 'cyclone') {
            // A corkscrew: the road spirals inside a tube whose axis is this
            // straight. The radius ramps over the outer 35% at each end -- at a
            // constant radius the helix starts at full angular rate and kinks
            // at both mouths, which the sim reads as a phantom corner.
            const th = 2 * Math.PI * s.turns * f
            const e = Math.max(0, Math.min(1, Math.min(f / 0.35, (1 - f) / 0.35)))
            const rEff = s.r * e * e * (3 - 2 * e)
            const ox = rEff * Math.sin(th)
            x = px + ox * rx; z = pz + ox * rz
            y = py + rEff - rEff * Math.cos(th)
            const up: [number, number, number] = [-Math.sin(th) * rx, Math.cos(th), -Math.sin(th) * rz]
            nodes.push(attr(s, f, up))
          } else if (s.t === 'jump') {
            const n = attr(s, f)
            // The ramp is the first few metres; the gap is unbarriered road.
            if (f < 0.18) { n.ramp = s.launch; n.boost = true }
            else if (f < 0.18 + s.gap / len) n.open = true
            nodes.push(n)
          } else {
            nodes.push(attr(s, f))
          }
          x = sx; y = sy; z = sz
        }
      }
      x += len * dx; z += len * dz; y = y1
      dist += len
      continue
    }

    if (s.t === 'loop') {
      /**
       * A TIGHT LOOP CANNOT BE STAGGERED GENTLY, and this is the geometry.
       *
       * The crossing has to move `stagger` metres sideways within the loop's
       * own arc length of 2*pi*r. The smaller the loop, the steeper that is --
       * and the steepness reads to `curvatureAt` as a corner that nobody
       * authored. Measured across the four circuits after the mouth-step fix:
       * r=22 and r=30 loops produced a phantom 15m "corner", r=25 produced 26m,
       * and r=36 produced nothing at all (its 47m reading is a real hairpin).
       *
       * The clearance requirement pushes the other way: `stagger` must exceed
       * the road width by a margin or the entry and exit overlap. So a loop has
       * a genuine minimum size, and it is better to say so here than to let a
       * designer discover it as an unexplained 15m corner three gates later.
       */
      if (s.r < 32) {
        throw new Error(
          `circuit: loop radius ${s.r}m is too tight to stagger. The crossing has ` +
          `to move sideways within 2*pi*r of arc, and under ~32m that reads as a ` +
          `phantom sub-20m corner the AI brakes for. Use r >= 32.`,
        )
      }
      if ((s.stagger ?? 54) > s.r * 1.9) {
        throw new Error(
          `circuit: loop stagger ${s.stagger}m is too wide for radius ${s.r}m ` +
          `(max ~${(s.r * 1.9).toFixed(0)}m). Widen the loop or narrow the crossing.`,
        )
      }
      // Consumes no plan distance. See `staggeredLoop` in ring.ts for why the
      // crossing is lateral and not forward: a loop returns to its own entry
      // point, so without the crossing the approach and the exit are the same
      // ground -- reported as "it launches into itself".
      const stag = s.stagger ?? 54
      const side = s.side ?? 1
      const dx = Math.sin(h), dz = Math.cos(h)
      const rx = Math.cos(h), rz = -Math.sin(h)
      const steps = Math.max(14, Math.round((2 * Math.PI * s.r) / 18))
      const x0 = x, y0 = y, z0 = z
      for (let i = 0; i <= steps; i++) {
        const f = i / steps
        const th = 2 * Math.PI * f
        const sm = f * f * (3 - 2 * f)
        const fwd = s.r * Math.sin(th)
        // THE CROSSING RUNS 0 -> stagger, NOT -stagger/2 -> +stagger/2.
        //
        // The centred version looks tidier and puts a LATERAL STEP of half a
        // stagger at each mouth: the road arrives on the racing line at lateral
        // zero and the loop's first node is 26-39m to one side of it. Two of
        // the four circuits independently reported the consequence as a
        // "tightest radius" of 13m that matched no authored corner -- a phantom
        // hairpin at the loop entry, which is exactly the "turns far too sharp,
        // ends up causing the user to crash into the walls" this pass exists to
        // remove.
        //
        // Starting at zero means the loop begins where the road already is. The
        // exit is then a full stagger across, and the segment's end position
        // below accounts for it, so the next straight simply carries on from
        // there. The smoothstep keeps the derivative zero at both mouths, so
        // there is no kink either.
        const lat = side * stag * sm
        if (emit) {
          x = x0 + fwd * dx + lat * rx
          y = y0 + s.r * (1 - Math.cos(th))
          z = z0 + fwd * dz + lat * rz
          nodes.push(attr(s, f, [-Math.sin(th) * dx, Math.cos(th), -Math.sin(th) * dz]))
        }
      }
      // The loop leaves a FULL stagger across the road, which is also the
      // clearance between its entry and its exit.
      x = x0 + (side * stag) * rx
      z = z0 + (side * stag) * rz
      y = y0
      dist += 2 * Math.PI * s.r
      continue
    }

    // ---- corner ----
    const sgn = Math.sign(s.deg) || 1
    const cx = x + sgn * s.r * Math.cos(h)
    const cz = z - sgn * s.r * Math.sin(h)
    const a0 = Math.atan2(x - cx, z - cz)
    const arc = Math.abs(s.deg) * DEG * s.r
    /**
     * A CORNER IS SAMPLED AT THE CIRCUIT'S SPACING, NOT AT A FIXED COUNT.
     *
     * This read `Math.max(3, Math.round(arc / o.spacing))`, and the constant
     * 3 was a curvature spike waiting for a short corner to trip it. `Track`
     * bakes a UNIFORM Catmull-Rom -- the tangent at a node is (next - prev)/2
     * whatever the spacing -- so a run of 2m chords abutting a run of 24m
     * chords does not read as "finely sampled", it reads as a hairpin. Ashkar
     * measured it: three serpentine corners of 6-10 degrees each emitted their
     * mandatory 3 nodes across an 11m arc, giving 2.0m chords next to 27.6m
     * ones, a chord ratio of 13.73 against the 2.87 the same circuit shipped
     * before they were added.
     *
     * So the spacing term leads, and the floor is expressed in DEGREES PER
     * NODE rather than nodes: a corner has to be resolved finely enough that
     * the spline through its nodes still has its radius, and 30 degrees is
     * where that holds (a 45m hairpin turning 90 degrees gets 3 nodes and
     * bakes at 46m). Both terms are floors, so whichever is stricter wins,
     * and a corner is never emitted with zero nodes.
     */
    const steps = Math.max(1, Math.ceil(Math.abs(s.deg) / 30), Math.round(arc / o.spacing))
    /**
     * A KINK IS NOT A CORNER, and the builder should say so rather than emit
     * one. Sampling at the spacing (above) stops a short corner from being
     * over-resolved, but it cannot help a corner whose whole arc is shorter
     * than a single node: the chord is then the arc, and a 6m chord between
     * two 24m ones is still a curvature spike no matter how few nodes made it.
     *
     * The threshold is stated as the thing that actually matters -- the chord
     * this corner will contribute -- rather than as a minimum angle or a
     * minimum radius, because the same 11m arc can be a small angle at a big
     * radius or a big angle at a tiny one and both are equally unbakeable.
     *
     * It is also a design message, not just a numeric one. A corner this
     * short is under a fifth of a second at racing speed: the player cannot
     * feel it, the AI's drift-hold gate cannot see it, and the only thing it
     * does reliably is spike the curvature at its own joins. Ashkar shipped
     * three of them as a "serpentine" and measured a chord ratio of 13.73 for
     * it. Wanting a rhythm section is right; the way to get one is real
     * corners on short straights, not small numbers.
     */
    if (arc / steps < o.spacing * 0.5) {
      throw new Error(
        `circuit: the ${s.deg}-degree corner at r=${s.r}m turns through only ${arc.toFixed(1)}m of ` +
        `road, so it would emit a ${(arc / steps).toFixed(1)}m chord between ${o.spacing}m neighbours -- a ` +
        `curvature spike, not a corner (it is ${(arc / 55).toFixed(2)}s at racing speed). Give it more ` +
        `degrees or a smaller radius until its arc clears ${(o.spacing * 0.5).toFixed(0)}m, or make it a straight.`,
      )
    }
    const y0 = y, y1 = s.toY ?? y
    for (let i = 0; i < steps; i++) {
      const f = i / steps
      const a = a0 + s.deg * DEG * f
      if (emit) {
        x = cx + s.r * Math.sin(a); z = cz + s.r * Math.cos(a)
        y = y0 + (y1 - y0) * f
        nodes.push(attr(s, f))
      }
    }
    const aEnd = a0 + s.deg * DEG
    x = cx + s.r * Math.sin(aEnd); z = cz + s.r * Math.cos(aEnd)
    y = y1
    h = normalize(aEnd + sgn * (Math.PI / 2))
    dist += arc
  }
  if (tunnelFrom >= 0) tunnels.push([tunnelFrom, dist])

  return {
    nodes,
    straights: L,
    gap: Math.hypot(x - o.start[0], z - o.start[2]),
    turn: Math.abs(normalize(h - o.heading * DEG)) / DEG,
    length: dist,
    marks,
    tunnels,
    crossovers: [],
  }
}

/**
 * ===========================================================================
 * WHERE DOES THE ROAD PASS OVER ITS OWN ROAD?
 * ===========================================================================
 *
 * `tools/probe-selfclear.ts` already answers a version of this on the BAKED
 * track, and it is the stricter instrument: it expands every sample across its
 * ribbon and measures true 3-D distance, so it catches a rolled corkscrew
 * brushing its own barrel, which nothing here would. This function exists
 * anyway, and for a reason worth stating: the probe runs after the track is
 * registered, and it reports a distance, not a fix. By then the designer is
 * three steps downstream of the `toY` that was wrong.
 *
 * So this is the cheap, early, plan-only version -- transverse intersections of
 * the centreline with itself -- and its whole job is to fail the BUILD with a
 * message that names the two lap distances involved, so the answer is "raise
 * the deck at 1840m" rather than "something overlaps".
 *
 * TWO THINGS IT DELIBERATELY DOES NOT COUNT.
 *
 * 1. COLLINEAR OVERLAP. A vertical `loop` runs `r*sin(th)` forward and back
 *    along one line, so in plan it retraces its own path exactly. That is the
 *    loop working, not a crossover, and the near-zero cross product of two
 *    parallel segments skips it.
 *
 * 2. ANYTHING THE LAP REVISITS SOON. The same loop's stagger tilts that
 *    retrace slightly off collinear, and a `cyclone`'s helix does the same, so
 *    both WOULD register as a shallow crossing on the raw geometry. Both are
 *    the road meeting itself a couple of hundred metres later -- which is the
 *    set piece, by construction. A genuine crossover is two parts of the lap
 *    that are FAR APART along it: the looper on Ashkar meets its own feed
 *    straight most of a kilometre later. `APART` is where that line is drawn.
 */
const APART = 300

function crossovers(nodes: TrackNode[]): Crossover[] {
  const N = nodes.length
  if (N < 8) return []
  const cum: number[] = [0]
  for (let i = 1; i < N; i++) {
    const a = nodes[i - 1].p, b = nodes[i].p
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]))
  }
  const total = cum[N - 1] + Math.hypot(
    nodes[0].p[0] - nodes[N - 1].p[0],
    nodes[0].p[1] - nodes[N - 1].p[1],
    nodes[0].p[2] - nodes[N - 1].p[2],
  )
  const apart = (i: number, j: number): number => {
    const d = Math.abs(cum[i] - cum[j])
    return Math.min(d, total - d)
  }

  const out: Crossover[] = []
  for (let i = 0; i < N; i++) {
    const a = nodes[i].p, b = nodes[(i + 1) % N].p
    for (let j = i + 2; j < N; j++) {
      if (i === 0 && j === N - 1) continue
      if (apart(i, j) < APART) continue
      const c = nodes[j].p, d = nodes[(j + 1) % N].p
      const rx = b[0] - a[0], rz = b[2] - a[2]
      const sx = d[0] - c[0], sz = d[2] - c[2]
      const den = rx * sz - rz * sx
      if (Math.abs(den) < 1e-9) continue
      const qx = c[0] - a[0], qz = c[2] - a[2]
      const t = (qx * sz - qz * sx) / den
      const u = (qx * rz - qz * rx) / den
      if (t <= 0 || t >= 1 || u <= 0 || u >= 1) continue
      const yA = a[1] + (b[1] - a[1]) * t
      const yB = c[1] + (d[1] - c[1]) * u
      const lower = yA <= yB ? cum[i] : cum[j]
      const upper = yA <= yB ? cum[j] : cum[i]
      out.push({
        under: r1(lower),
        over: r1(upper),
        clearance: r1(Math.abs(yA - yB)),
        at: [r1(a[0] + rx * t), r1(a[2] + rz * t)],
      })
    }
  }
  // One physical crossing spans several node-segments on each deck; report it
  // once, at its worst clearance, rather than as a cluster of near-duplicates.
  const merged: Crossover[] = []
  for (const c of out.sort((p, q) => p.under - q.under)) {
    const prev = merged[merged.length - 1]
    if (prev && Math.hypot(c.at[0] - prev.at[0], c.at[1] - prev.at[1]) < 60) {
      if (c.clearance < prev.clearance) merged[merged.length - 1] = c
      continue
    }
    merged.push(c)
  }
  return merged
}

/**
 * Close the lap and emit its nodes.
 *
 * Throws with a readable diagnosis rather than returning a broken circuit: a
 * lap that does not close is a kink on the start line, and a negative straight
 * is a road that runs backwards. Both are worth failing loudly for.
 */
export function circuit(segs: Seg[], opts: CircuitOpts = {}): Built {
  const o: Required<CircuitOpts> = {
    spacing: opts.spacing ?? 24,
    start: opts.start ?? [0, 0, 0],
    heading: opts.heading ?? 0,
    defaults: opts.defaults ?? {},
    minStraight: opts.minStraight ?? 40,
    minClearance: opts.minClearance ?? 9,
  }

  /**
   * THE HEADING CLOSES AT ANY WHOLE NUMBER OF TURNS, NOT ONLY ONE.
   *
   * This guard used to demand exactly +/-360, and that was a real restriction
   * rather than a formality: it made a CROSSOVER unauthorable. The total
   * turning of a closed curve is 360 times its turning number, and the Hopf
   * Umlaufsatz says a curve that never touches itself has turning number
   * +/-1. Contrapositive, which is the useful direction here: a lap whose
   * corners sum to +/-720 MUST cross its own road somewhere. That is not a
   * failure mode to be trapped, it is the only way to author the thing every
   * real circuit with a flyover has -- Ashkar's large right-hand looper is a
   * full 360 of right-hander hung off the lap, so the rest of the lap still
   * owes its own 360 and the total is 720.
   *
   * So the sum must be a whole number of turns, and 2 is the ceiling: three
   * would mean two separate crossings, each needing its own bridge, and
   * nothing in the roster wants that yet. `crossovers` below then finds where
   * the road meets itself and checks that one deck actually clears the other,
   * which is the check that ACTUALLY matters and the one +/-360 was standing
   * in for.
   */
  const turnSum = segs.reduce((a, s) => a + (s.t === 'corner' ? s.deg : 0), 0)
  const turns = Math.abs(turnSum) / 360
  if (Math.abs(turns - Math.round(turns)) > 1e-6 || turns < 1 || turns > 2) {
    throw new Error(
      `circuit: corner angles sum to ${turnSum} degrees. They must sum to a whole ` +
      `number of turns -- +/-360 for an ordinary lap, or +/-720 for a lap with one ` +
      `crossover (a looper hung off the circuit) -- or the heading cannot close.`,
    )
  }

  const L0 = segs.filter((s) => s.t === 'straight').map((s) => (s as { len: number }).len)
  if (!L0.length) throw new Error('circuit: needs at least one straight to close with')

  // Headings of each straight, in order. Straights do not turn, so these do not
  // move when the lengths change -- which is what makes closure exactly linear.
  const dirs: [number, number][] = []
  {
    let h = o.heading * DEG
    for (const s of segs) {
      if (s.t === 'straight') dirs.push([Math.sin(h), Math.cos(h)])
      else if (s.t === 'corner') h = normalize(h + s.deg * DEG)
    }
  }
  const a11 = dirs.reduce((s, d) => s + d[0] * d[0], 0)
  const a12 = dirs.reduce((s, d) => s + d[0] * d[1], 0)
  const a22 = dirs.reduce((s, d) => s + d[1] * d[1], 0)
  const det = a11 * a22 - a12 * a12
  if (Math.abs(det) < 1e-9) {
    throw new Error('circuit: every straight points the same way, so closure has no solution -- vary the corner angles')
  }

  /** Minimum-norm straight lengths for a given uniform pre-scale on the authored ones. */
  const solve = (scale: number): number[] => {
    const base = L0.map((v) => v * scale)
    const end = walkEnd(segs, base, o)
    const resX = end[0] - o.start[0], resZ = end[1] - o.start[2]
    const l1 = (-resX * a22 + resZ * a12) / det
    const l2 = (-resZ * a11 + resX * a12) / det
    return base.map((len, i) => len + l1 * dirs[i][0] + l2 * dirs[i][1])
  }

  /**
   * THE UNIFORM PRE-SCALE, and why it is here rather than an error message.
   *
   * The minimum-norm correction is the smallest total change that shuts the
   * lap, but "smallest" is not the same as "positive": a layout whose corners
   * nearly close on their own leaves a large residual for a small set of
   * straights to absorb, and one of them goes under the floor. That is not a
   * broken design, it is a design drawn slightly too tight -- the same corner
   * sequence on a bigger site closes with room to spare.
   *
   * So the builder grows the whole layout uniformly until it fits, which keeps
   * every authored proportion (this straight twice that one) intact and changes
   * only the site. It reports the scale it used so a designer can see whether
   * their lap came out 5% larger than drawn or 60%, and only gives up when even
   * a doubled site will not close.
   */
  let scale = 1
  let L = solve(1)
  while (L.some((v) => v < o.minStraight) && scale < 2.5) {
    scale *= 1.04
    L = solve(scale)
  }
  if (L.some((v) => v < o.minStraight)) {
    const bad = L.findIndex((v) => v < o.minStraight)
    throw new Error(
      `circuit: straight #${bad} closes at ${L[bad].toFixed(0)}m (floor ${o.minStraight}m) ` +
      `even at ${scale.toFixed(2)}x scale. The corner angles fold the lap back on ` +
      `itself -- change a corner's direction or angle rather than lengthening straights.`,
    )
  }

  const built = walk(segs, L, o, true)
  if (built.gap > 1.5) {
    throw new Error(`circuit: lap fails to close by ${built.gap.toFixed(2)}m after correction`)
  }
  built.scale = scale

  /**
   * A CROSSOVER IS A BRIDGE OR IT IS A COLLISION, and the difference is one
   * `toY` the designer either wrote or forgot. Failing here names both decks
   * by lap distance, which is the number you need to fix it; discovering the
   * same thing from probe-selfclear three steps later names neither.
   *
   * A winding-2 lap is REQUIRED to have one of these (see the turn-sum guard
   * above), so a 720 that reports none means the looper closed back onto its
   * own entry point tangentially instead of crossing past it -- geometrically
   * the plan-view twin of the "it launches into itself" report that started
   * all of this, and just as unplayable. Say so rather than shipping it.
   */
  built.crossovers = crossovers(built.nodes)
  const tight = built.crossovers.filter((c) => c.clearance < o.minClearance)
  if (tight.length) {
    const c = tight[0]
    throw new Error(
      `circuit: the road crosses its own road at (${c.at[0]}, ${c.at[1]}) with only ` +
      `${c.clearance}m between the decks (floor ${o.minClearance}m). The lower deck is at ` +
      `${c.under}m round the lap and the upper at ${c.over}m -- give the segment at ${c.over}m ` +
      `a toY that clears the one at ${c.under}m, or move the crossing.`,
    )
  }
  if (turns === 2 && !built.crossovers.length) {
    throw new Error(
      `circuit: the corners sum to ${turnSum} degrees, so this lap has to cross its own ` +
      `road somewhere -- but no crossing was found. That means the looper returned exactly ` +
      `onto its own entry instead of past it: a 360-degree corner ends where it began. ` +
      `Split the looper around a straight, or run its two halves at different radii, so the ` +
      `exit clears the entry.`,
    )
  }
  return built
}

/** End position for a given set of straight lengths. Geometry only. */
function walkEnd(segs: Seg[], L: number[], o: Required<CircuitOpts>): [number, number] {
  let x = o.start[0], z = o.start[2]
  let h = o.heading * DEG
  let si = 0
  for (const s of segs) {
    if (s.t === 'straight') { const len = L[si++]; x += len * Math.sin(h); z += len * Math.cos(h); continue }
    if (s.t === 'jump' || s.t === 'cyclone') { x += s.len * Math.sin(h); z += s.len * Math.cos(h); continue }
    if (s.t === 'loop') {
      // Full stagger, matching the emitter above.
      const stag = (s.stagger ?? 54) * (s.side ?? 1)
      x += stag * Math.cos(h); z += stag * -Math.sin(h)
      continue
    }
    const sgn = Math.sign(s.deg) || 1
    const cx = x + sgn * s.r * Math.cos(h)
    const cz = z - sgn * s.r * Math.sin(h)
    const a0 = Math.atan2(x - cx, z - cz)
    const aEnd = a0 + s.deg * DEG
    x = cx + s.r * Math.sin(aEnd); z = cz + s.r * Math.cos(aEnd)
    h = normalize(aEnd + sgn * (Math.PI / 2))
  }
  return [x, z]
}

function normalize(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2
  while (a < -Math.PI) a += Math.PI * 2
  return a
}
