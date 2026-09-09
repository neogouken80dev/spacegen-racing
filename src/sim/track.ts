import { type Vec3, v3, vadd, vscale, vsub, vnorm, vcross, vlen, clamp, lerp, TAU } from './math'
import { TUNING } from '../content/tuning'

export type SurfaceKind = 'tarmac' | 'ice' | 'snow' | 'gravel' | 'oil' | 'metal' | 'boost'

/** Grip multiplier applied to grounded chassis only. */
/**
 * Grip multiplier per surface. Lives in tuning because it is gameplay balance,
 * not geometry: an ice track's whole balance problem is how far 0.45 is from
 * 1.0 and how much of the lap sits on it, and that has to be sweepable by
 * tools/balance.ts without editing source.
 */
export const SURFACE_GRIP: Record<SurfaceKind, number> = TUNING.surfaceGrip

/** A control node on the track centreline. The level designer authors these. */
export interface TrackNode {
  /** Centreline position, metres. */
  p: [number, number, number]
  /** Half-width of the drivable surface at this node, metres. */
  w: number
  /** Banking in degrees, positive banks the left edge up. */
  bank?: number
  surface?: SurfaceKind
  /** Marks a boost strip. */
  boost?: boolean
  /** Booster ramp: upward launch velocity in m/s. Roughly 26 clears a short
   *  gap, 38 gives about 2 seconds of hang time. */
  ramp?: number
  /** Walls on this segment bounce rather than scrub. */
  bounce?: boolean
  /** No side walls: driving off the edge means falling. */
  open?: boolean
  /**
   * Ice shelf that cracks and gives way once the leader reaches
   * TUNING.hazard.crackLap. A fragile sample keeps its geometry but loses its
   * walls and turns to bare ice, so the section a player learned on lap one is
   * not the section they meet on lap three.
   */
  fragile?: boolean
  /**
   * THE PHASING LIGHT-BRIDGE. Phase offset, in cycles [0,1), of the span this
   * node bounds.
   *
   * A phasing span cycles solid/absent on T.hazard.bridgePeriod. While it is
   * absent there is no deck under the HALF named by `drops`: nothing is holding
   * a racer up there, whatever it rides on and whatever it is doing, and it
   * falls. (The flight class was exempt while it held Lift for exactly one
   * balance pass; see the deck block in sim/vehicle.ts for the measurement that
   * removed the exemption.) The cycle is a pure function of race time and the
   * authored offset -- no RNG, no per-racer state -- so it is ONE event the
   * whole field shares, exactly like the fragile ice shelf, and exactly like it
   * for the same reason: eight private hazards do not survive netcode.
   *
   * A SPAN NEEDS BOTH ENDS, WHICH IS WHY THIS IS NOT `open`-SHAPED. `open`,
   * `bounce` and `fragile` are OR'd across a segment, so tagging two nodes also
   * flags the segment leading INTO the first one and the segment leading OUT of
   * the last. That is harmless for a wall flag and fatal for a hole in the
   * road: the hazard would bleed one segment onto its own approach. So a
   * segment is a bridge only where BOTH of its bounding nodes declare a phase
   * AND the two agree.
   *
   * The consequence for authoring: two bridges that happen to share an offset
   * would merge into one span, so put at least one plain node between any two
   * phasing spans. Aetherion's causeway does exactly that, and the gaps between
   * its spans are the solid ground the timing puzzle is played from.
   */
  phase?: number
  /**
   * WHICH HALF OF THE DECK GIVES WAY. Required on every node that authors a
   * `phase`, and AND'd across a segment the same way `phase` is.
   *
   * A span drops the half named here and NEVER the other one, so there is
   * always a line through it. `'left'` is negative lateral (the -`right` side
   * of the ribbon frame), `'right'` is positive.
   *
   * WHY A HALF AND NOT THE WHOLE DECK. A whole-span drop is decided by WHEN you
   * arrive, and when you arrive is a function of the corner before, the item
   * that hit you and the car you were behind -- none of which is driving the
   * causeway well. Measured, the field fell 0.48-0.70 times a race on a hazard
   * no rival earned, and the balance harness read the section as noise rather
   * than as difficulty. Half-span phasing moves the question from "did you
   * arrive on the beat" to "are you in the surviving lane", which a driver
   * chooses, holds, and can get right on every lap of every race.
   *
   * THE SIDE IS AUTHORED, NEVER DRAWN. It is a fixed property of the span, so
   * a player who has driven the causeway once knows which way to commit --
   * which is the whole point of the change. Deriving it from anything
   * per-racer, or from the RNG, would reintroduce exactly the dice roll this
   * replaces.
   *
   * A NOTE ON AUTHORING A PATTERN. Consecutive spans may name different halves,
   * and the sim does not care. Whether a driver can ACT on that is a different
   * question and it is a geometry one: a racer who is off the beat drifts only
   * about 0.09 of a cycle across the whole of Aetherion's causeway, so it meets
   * the absent window at all three spans, and the 32 m between spans is 0.6 s
   * at causeway speed -- about 3 m of lateral shift against the friction
   * budget, against the 8 m it takes to cross the seam with clearance. A
   * causeway that alternates halves span to span is therefore a slalom nobody
   * can drive when it matters. Author a pattern the driver can HOLD.
   */
  drops?: 'left' | 'right'
  /**
   * Lateral wind acceleration, m/s^2. Positive pushes toward `right`
   * (forward x up, so world -X at yaw 0). Scaled per locomotion class by
   * LocomotionProfile.fieldForceMult: grounded 1.0, hover 1.5, flight 1.8.
   */
  wind?: number
  /**
   * HARD VACUUM, 0..1. 0 is a breathable atmosphere -- every metre of the
   * first three circuits -- and 1 is open space.
   *
   * It does exactly two things, and both of them are the SAME fact stated
   * twice: there is no medium here.
   *
   *   - the air is not slowing you down any more, so top speed climbs
   *     (`vacuumTopSpeedMult` in sim/vehicle.ts, derived from T.sim.airDrag);
   *   - the medium a chassis pushes against to change direction is gone, so
   *     the lateral friction budget collapses (`vacuumGripMult`, scaled per
   *     locomotion class by LocomotionProfile.vacuumGripLoss).
   *
   * A straight-line gift that charges anyone who needs to turn in it, which is
   * why the beat it was built for -- The Hollow Choir's Breach -- puts the
   * vacuum exactly where the road is a geodesic and fades it in and out
   * THROUGH the two corners either side. A vacuum that only ever covers
   * straight road is a gift with no bill attached.
   *
   * IT INTERPOLATES BETWEEN NODES, EXACTLY LIKE `wind`, and for the same
   * reason: a hull breach that switched on at a sample boundary would take
   * the grip out from under a car mid-corner in one frame. Authoring a ramp
   * is the whole mechanic, not a nicety.
   *
   * IT IS DETERMINISTIC AND IDENTICAL FOR EVERY RACER. Like Cryostatic's
   * fragile shelf and Aetherion's phasing spans, it is a property of the ROAD
   * and of nothing else -- no RNG, no per-racer state, not even race time. Two
   * clients agree by construction because there is nothing to agree about.
   *
   * A NOTE ON WIND. Vacuum and `wind` are mutually exclusive by physics: a
   * crosswind is air, and there is none here. Nothing enforces that -- the sim
   * would happily blow a gale through hard vacuum -- so it is an authoring
   * rule, and The Hollow Choir keeps it.
   */
  vacuum?: number
  /**
   * THE GRAVITY SYSTEM.
   *
   * Surface up-vector at this node, world space, need not be normalised.
   * Defaults to world +Y, which is what every metre of Rustfall and Cryostatic
   * uses, so a track that says nothing here behaves exactly as it did before
   * this existed.
   *
   * The road always lies in the plane perpendicular to `up`, and `up` IS the
   * local anti-gravity direction for anything driving on it. Rotating it around
   * the lap is how a wall-ride, a corkscrew or a full loop is authored: swing
   * `up` from +Y through +X to -Y over a handful of nodes and the road climbs
   * the wall, goes vertical, and comes back over the top, with the car held on
   * it the whole way.
   *
   * Two authoring rules, both enforced by the constructor:
   *   - `up` must never be parallel to the tangent. It is the road's own up, so
   *     on a vertical wall it points sideways while the tangent runs along the
   *     wall; they are perpendicular by construction unless you make a mistake.
   *   - adjacent nodes must not be more than ~120 degrees apart, because the
   *     bake interpolates between them. Use more nodes for a loop, not fewer.
   */
  up?: [number, number, number]
  /**
   * How strongly a racer is held to the surface frame while AIRBORNE over this
   * stretch, 0..1.
   *
   * 0 (the default on level road) means plain world gravity the moment the
   * wheels leave the deck, so a ramp still throws you in a natural arc that
   * falls back toward world down.
   *
   * 1 means full surface gravity: you fall back toward the road you left even
   * if that road is a wall or a ceiling. Anywhere `up` departs from world +Y
   * this defaults to 1 automatically -- sliding off the outside of a wall-ride
   * into the sky is never what the designer meant, and making that the default
   * removes a whole class of authoring bug.
   */
  stick?: number
  /** Designer label, shown in the debug overlay. */
  tag?: string
}

export interface TrackDef {
  id: string
  name: string
  /** Sky / fog colours as 0xRRGGBB. */
  skyTop: number
  skyBottom: number
  fogColor: number
  fogDensity: number
  sunColor: number
  sunIntensity: number
  ambientColor: number
  ambientIntensity: number
  sunDirection: [number, number, number]
  /** Three-colour key palette plus accent emissive, from the art direction. */
  palette: { a: number; b: number; c: number; accent: number }
  nodes: TrackNode[]
  /** Fractions along the lap [0..1] where item box rows sit. */
  itemBoxRows: { at: number; count: number; spread: number }[]
  /** Fractions along the lap where Charge pickups sit, with lateral offset. */
  chargeRuns: { from: number; to: number; count: number; lateral: number }[]
  laps: number
}

export interface TrackSample {
  pos: Vec3
  tangent: Vec3
  normal: Vec3   // surface up
  right: Vec3
  width: number
  bank: number
  surface: SurfaceKind
  boost: boolean
  ramp: number
  bounce: boolean
  open: boolean
  fragile: boolean
  wind: number
  /** Hard vacuum, 0..1. See TrackNode.vacuum. 0 on a track that authors none. */
  vacuum: number
  /**
   * Phasing light-bridge offset in cycles, or -1 where the deck is permanent.
   * -1 on every sample of a track that authors no `phase`, and `bridgeSolid`
   * answers true for -1, so the flat tracks never take a bridge branch.
   *
   * ON A SAMPLE THIS IS THE PHASE OF THE HALF THAT GIVES WAY, and it says
   * nothing about where the reader is standing. `Track.project()` hands back a
   * sample whose `bridge` has already been resolved against the projected
   * lateral -- see the note on `project`. Read it off `at()`/`samples[]` to ask
   * "does this stretch of deck phase, and on what beat"; read it off a
   * projection to ask "is the deck there under THIS point".
   */
  bridge: number
  /**
   * Which half of the deck `bridge` applies to: -1 left, +1 right, 0 where the
   * deck is permanent. See TrackNode.drops.
   */
  bridgeSide: number
  /** Surface-gravity authority while airborne, 0..1. See TrackNode.stick. */
  stick: number
}

const RESOLUTION = 1.5 // metres between baked samples
/** Half-length of a ramp deck, metres. A ramp is ~18m of track, not a region. */
const RAMP_HALF_LENGTH = 9

/**
 * A baked track: the centreline resampled at fixed arc-length intervals so the
 * sim can do O(1) lookups by distance. Catmull-Rom through the authored nodes.
 */
export class Track {
  readonly def: TrackDef
  readonly samples: TrackSample[] = []
  readonly length: number
  readonly startPos: Vec3
  readonly startYaw: number
  /** True if any sample is a fragile ice shelf. Lets Race skip the crack check
   *  entirely on tracks that have none. */
  readonly hasFragile: boolean = false
  /**
   * True if any node authors a non-default up-vector. The sim reads this to
   * skip the whole gravity path on flat tracks, so Rustfall and Cryostatic
   * take literally the same branches they took before the system existed.
   */
  readonly hasGravity: boolean = false
  /**
   * True if any node authors a `phase`. Lets the AI skip its bridge-timing
   * planner entirely on tracks with no bridges, so Rustfall and Cryostatic run
   * the identical AI they ran before this existed.
   */
  readonly hasBridges: boolean = false
  /**
   * True if any node authors a non-zero `vacuum`. Read by stepVehicle and
   * stepAI to skip the vacuum terms entirely, so the three circuits that
   * shipped before this existed take literally the branches they took then --
   * the same gate `hasGravity` and `hasBridges` already carry, for the same
   * reason.
   */
  readonly hasVacuum: boolean = false
  /**
   * The phasing spans, as arc-length intervals, in lap order.
   *
   * Built once here rather than scanned per frame: the AI has to plan its
   * arrival at every span inside its horizon on every tick for every racer, and
   * walking the sample array to find them is 170-odd lookups per racer per
   * frame against a list that never changes. Three entries, read O(1).
   *
   * `side` is -1 where the LEFT half gives way and +1 where the right one does.
   * The other half is permanent deck, so `-side` is the lane that is always
   * there and the one the AI's lane planner steers for.
   */
  readonly bridges: { s0: number; s1: number; phase: number; side: number }[] = []

  /**
   * Per-sample twins with `bridge` forced to permanent, one for every sample
   * that phases. Used by `project()` and by nothing else.
   *
   * Indexed by sample index, sparse: `undefined` everywhere the deck does not
   * phase, which is every sample of Rustfall and Cryostatic and 93% of
   * Aetherion. Built once at the end of the constructor so it picks up the
   * ramp pass, and it shares the sample's Vec3s by reference rather than
   * copying them, so the geometry can never disagree with the original.
   */
  private readonly safeHalf: (TrackSample | undefined)[] = []

  constructor(def: TrackDef) {
    this.def = def
    const nodes = def.nodes
    const n = nodes.length

    // Dense pre-pass through the Catmull-Rom spline to measure arc length.
    const dense: { p: Vec3; t: number; i: number }[] = []
    const SUB = 24
    for (let i = 0; i < n; i++) {
      for (let s = 0; s < SUB; s++) {
        const t = s / SUB
        dense.push({ p: catmull(nodes, i, t), t, i })
      }
    }
    dense.push({ p: catmull(nodes, 0, 0), t: 0, i: 0 })

    const cum: number[] = [0]
    for (let k = 1; k < dense.length; k++) {
      const a = dense[k - 1].p, b = dense[k].p
      cum.push(cum[k - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z))
    }
    this.length = cum[cum.length - 1]
    this.hasFragile = def.nodes.some((n) => n.fragile === true)
    this.hasVacuum = def.nodes.some((n) => (n.vacuum ?? 0) > 0)

    // Gravity: normalise the authored up-vectors once, up front, so the bake
    // loop below can interpolate them without re-normalising per sample. A node
    // that says nothing gets world +Y, which is what makes a track written
    // before the gravity system existed behave identically after it.
    const ups: Vec3[] = nodes.map((nd) => (nd.up ? vnorm(v3(nd.up[0], nd.up[1], nd.up[2])) : v3(0, 1, 0)))
    for (let i = 0; i < n; i++) {
      if (vlen(ups[i]) < 0.5) throw new Error(`${def.id}: node ${i} has a degenerate up-vector`)
      const nx = ups[(i + 1) % n]
      const d = ups[i].x * nx.x + ups[i].y * nx.y + ups[i].z * nx.z
      // cos(120 deg) = -0.5. Past that the normalised lerp between the two
      // passes near zero length and the frame snaps through a half turn in one
      // sample -- a loop authored in three nodes instead of eight.
      if (d < -0.5) {
        throw new Error(
          `${def.id}: up-vector turns more than 120 degrees between nodes ${i} and ${(i + 1) % n}. ` +
          `Author the roll across more nodes.`,
        )
      }
    }
    this.hasGravity = ups.some((u) => u.y < 0.999999)

    const sampleUp: Vec3[] = []
    const count = Math.max(16, Math.round(this.length / RESOLUTION))
    for (let k = 0; k < count; k++) {
      const target = (k / count) * this.length
      let lo = 0, hi = cum.length - 1
      while (lo < hi - 1) {
        const mid = (lo + hi) >> 1
        if (cum[mid] <= target) lo = mid; else hi = mid
      }
      const span = cum[hi] - cum[lo] || 1
      const f = (target - cum[lo]) / span
      const a = dense[lo], b = dense[hi]
      const pos = { x: lerp(a.p.x, b.p.x, f), y: lerp(a.p.y, b.p.y, f), z: lerp(a.p.z, b.p.z, f) }

      const nodeF = a.i + a.t + (b.i === a.i ? (b.t - a.t) * f : 0)
      const i0 = Math.floor(nodeF) % n
      const i1 = (i0 + 1) % n
      const nf = nodeF - Math.floor(nodeF)
      const n0 = nodes[i0], n1 = nodes[i1]

      this.samples.push({
        pos,
        tangent: v3(0, 0, 1),
        normal: v3(0, 1, 0),
        right: v3(1, 0, 0),
        width: lerp(n0.w, n1.w, nf),
        bank: lerp(n0.bank ?? 0, n1.bank ?? 0, nf) * (Math.PI / 180),
        surface: nf < 0.5 ? (n0.surface ?? 'tarmac') : (n1.surface ?? 'tarmac'),
        boost: nf < 0.5 ? !!n0.boost : !!n1.boost,
        ramp: 0, // assigned precisely in a second pass below
        bounce: (n0.bounce ?? false) || (n1.bounce ?? false),
        open: (n0.open ?? false) || (n1.open ?? false),
        // Fragile spans a segment the way bounce and open do: either endpoint
        // marking it makes the whole run fragile, so a shelf is authored by
        // tagging the nodes at its two ends.
        fragile: (n0.fragile ?? false) || (n1.fragile ?? false),
        // Wind interpolates, so a blizzard band can ramp in and out instead of
        // switching on at a sample boundary and punching the car sideways.
        wind: lerp(n0.wind ?? 0, n1.wind ?? 0, nf),
        // Vacuum interpolates for the same reason and one stronger: this term
        // is a multiplier on the LATERAL BUDGET, so a step change in it is a
        // step change in how hard the car can corner. `?? 0` is what makes a
        // track written before this existed read exactly 0 everywhere.
        vacuum: clamp(lerp(n0.vacuum ?? 0, n1.vacuum ?? 0, nf), 0, 1),
        // A phasing span is a DECK and needs both of its ends. See TrackNode.
        // phase for why this is an AND where `open`/`bounce`/`fragile` are ORs.
        // The half that gives way is AND'd with it: a segment whose two ends
        // disagree about which side drops is not a span, the same way a segment
        // whose ends disagree about the beat is not one.
        bridge: (n0.phase !== undefined && n0.phase === n1.phase && n0.drops === n1.drops)
          ? n0.phase : -1,
        bridgeSide: (n0.phase !== undefined && n0.phase === n1.phase && n0.drops === n1.drops)
          ? (n0.drops === 'left' ? -1 : 1) : 0,
        // Airborne surface authority. Interpolates like wind so a wall-ride can
        // hand the racer back to world gravity gradually on the way out instead
        // of dropping them the instant the flag clears.
        stick: clamp(lerp(defaultStick(n0, ups[i0]), defaultStick(n1, ups[i1]), nf), 0, 1),
      })

      // The authored up for this sample, normalised-lerped between its two
      // nodes. Kept beside the samples rather than on them: it is scaffolding
      // for the frame pass below, and `normal` is what the sim actually reads.
      const ua = ups[i0], ub = ups[i1]
      sampleUp.push(vnorm(v3(
        ua.x + (ub.x - ua.x) * nf,
        ua.y + (ub.y - ua.y) * nf,
        ua.z + (ub.z - ua.z) * nf,
      )))
    }

    // Second pass: tangents, then banked normals and rights.
    const m = this.samples.length
    for (let k = 0; k < m; k++) {
      const prev = this.samples[(k - 1 + m) % m].pos
      const next = this.samples[(k + 1) % m].pos
      const tan = vnorm(vsub(next, prev))
      this.samples[k].tangent = tan
      // The whole gravity system is this one substitution: the reference the
      // frame is built against is the AUTHORED up, not world +Y. Everything
      // downstream -- normal, right, the plane the car drives in, the direction
      // gravity pulls, where the walls stand -- follows from it. With no
      // authored up this is v3(0, 1, 0) and the arithmetic is unchanged.
      const ref = sampleUp[k]
      let flatRight = vnorm(vcross(tan, ref))
      if (vlen(flatRight) < 0.5) {
        // tangent parallel to the authored up: the road has no defined sideways.
        throw new Error(
          `${def.id}: up-vector is parallel to the track direction at sample ${k} ` +
          `(${tan.x.toFixed(2)}, ${tan.y.toFixed(2)}, ${tan.z.toFixed(2)}). ` +
          `The up is the ROAD's up, so it must stay perpendicular to where the road runs.`,
        )
      }
      const bank = this.samples[k].bank
      const cb = Math.cos(bank), sb = Math.sin(bank)
      const up = vnorm(vcross(flatRight, tan))
      this.samples[k].right = vnorm(vadd(vscale(flatRight, cb), vscale(up, sb)))
      this.samples[k].normal = vnorm(vcross(this.samples[k].right, tan))
    }

    // Ramps are a physical deck, not a region. Interpolating the flag between
    // nodes smeared one authored ramp across ~100m of track, so every racer
    // entering anywhere in that stretch got launched. Snap each authored ramp
    // to the samples within RAMP_HALF_LENGTH of its node instead.
    for (const node of nodes) {
      if (!node.ramp) continue
      let bestIdx = 0
      let bestD = Infinity
      for (let k = 0; k < this.samples.length; k++) {
        const p = this.samples[k].pos
        const d = (p.x - node.p[0]) ** 2 + (p.y - node.p[1]) ** 2 + (p.z - node.p[2]) ** 2
        if (d < bestD) { bestD = d; bestIdx = k }
      }
      const span = Math.max(1, Math.round(RAMP_HALF_LENGTH / RESOLUTION))
      const total = this.samples.length
      for (let d = -span; d <= span; d++) {
        this.samples[((bestIdx + d) % total + total) % total].ramp = node.ramp
      }
    }

    // Phasing spans as arc-length intervals. Runs of equal `bridge`, rotated so
    // a span that straddles the start line is reported once, from its true
    // entry. Aetherion's causeway is nowhere near the line, but a span that
    // silently split in two would give the AI two half-spans to plan for and a
    // hole in the middle it never sees.
    this.hasBridges = def.nodes.some((nd) => nd.phase !== undefined)
    if (this.hasBridges) {
      // A span that names a beat but not a half is a half-authored hazard: the
      // deck would drop nothing at all and the section would silently become
      // decoration. Caught here rather than at 52 m/s.
      for (let i = 0; i < n; i++) {
        if (nodes[i].phase !== undefined && nodes[i].drops === undefined) {
          throw new Error(
            `${def.id}: node ${i} authors a phase but no \`drops\`. ` +
            `A phasing span gives way on one HALF of the deck; say which.`,
          )
        }
      }
      const total = this.samples.length
      let start = 0
      while (start < total && this.samples[start].bridge >= 0) start++
      if (start >= total) throw new Error(`${def.id}: the entire lap is a phasing bridge`)
      let k = 0
      while (k < total) {
        const i = (start + k) % total
        const ph = this.samples[i].bridge
        const sd = this.samples[i].bridgeSide
        if (ph < 0) { k++; continue }
        // Grouped by the beat AND the half. Two spans that share an offset but
        // drop opposite halves are two spans, not one.
        let run = 1
        while (k + run < total
          && this.samples[(start + k + run) % total].bridge === ph
          && this.samples[(start + k + run) % total].bridgeSide === sd) run++
        this.bridges.push({
          s0: (i / total) * this.length,
          s1: (i / total) * this.length + run * (this.length / total),
          phase: ph,
          side: sd,
        })
        k += run
      }
    }

    // The permanent-deck twins. Built LAST so they carry the ramp pass, and
    // built only where the deck actually phases -- `safeHalf` stays entirely
    // empty on a track that authors no `phase`, which is what keeps `project()`
    // on Rustfall and Cryostatic exactly the lookup it has always been.
    if (this.hasBridges) {
      for (let i = 0; i < this.samples.length; i++) {
        const s = this.samples[i]
        this.safeHalf[i] = s.bridgeSide === 0
          ? undefined
          // Spread copies the scalars and SHARES the Vec3s (pos, tangent,
          // normal, right are objects), so the twin can never disagree with
          // the original about where the road is or which way it faces.
          : { ...s, bridge: -1, bridgeSide: 0 }
      }
    }

    const s0 = this.samples[0]
    this.startPos = { ...s0.pos }
    this.startYaw = Math.atan2(s0.tangent.x, s0.tangent.z)
  }

  /** Sample index for a distance along the centreline, wrapping. */
  indexAt(s: number): number {
    const m = this.samples.length
    const f = ((s / this.length) % 1 + 1) % 1
    return Math.min(m - 1, Math.floor(f * m))
  }

  at(s: number): TrackSample {
    return this.samples[this.indexAt(s)]
  }

  /** Interpolated centreline position at distance s. */
  posAt(s: number): Vec3 {
    const m = this.samples.length
    const f = (((s / this.length) % 1) + 1) % 1
    const raw = f * m
    const i0 = Math.floor(raw) % m
    const i1 = (i0 + 1) % m
    const t = raw - Math.floor(raw)
    const a = this.samples[i0].pos, b = this.samples[i1].pos
    return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) }
  }

  /** World position on the surface at (s, lateral offset). */
  surfacePoint(s: number, lateral: number): Vec3 {
    const smp = this.at(s)
    const c = this.posAt(s)
    return vadd(c, vscale(smp.right, lateral))
  }

  /**
   * Project a world position onto the track. Uses `hintS` to search locally,
   * which keeps this O(1) during a race instead of O(track length).
   *
   * ---------------------------------------------------------------------------
   * THE RETURNED SAMPLE IS RESOLVED FOR THE LATERAL, AND ONLY FOR `bridge`.
   *
   * A phasing span gives way on ONE half of its deck (TrackNode.drops). Whether
   * there is road under a point is therefore not a property of the arc length
   * alone -- it is a property of the point, and this is the one call in the sim
   * that has both. So a projection that lands on the half that gives way gets
   * the sample as authored, with `bridge` carrying that span's beat; a
   * projection that lands on the half that stays gets a twin whose `bridge` is
   * -1, which is what every caller already reads as permanent deck.
   *
   * That is the whole of the half-span mechanic on the physics side. Every
   * existing caller -- the fall test in `vehicle.ts` above all, which asks
   * `bridgeSolid(proj.sample.bridge, raceTime)` -- becomes half-aware without
   * knowing that halves exist, and `bridgeSolid` itself stays the two-argument
   * pure function of (phase, time) that the netcode argument rests on.
   *
   * THE TRAP, STATED PLAINLY: `project(p, s).sample.bridge` is not
   * `at(s).bridge`. The first answers "is there deck under this point", the
   * second answers "does this stretch phase, and on what beat". Both are wanted
   * and they are different questions. Anything that has a lateral and wants the
   * first should use `bridgePhaseFor()` rather than reaching for `at()`.
   *
   * Nothing else on the sample is touched, and on a track with no phasing deck
   * this returns `this.samples[bestIdx]` exactly as it always has.
   * ---------------------------------------------------------------------------
   */
  project(p: Vec3, hintS: number): { s: number; lateral: number; height: number; sample: TrackSample } {
    const m = this.samples.length
    const hintIdx = this.indexAt(hintS)
    const span = 40 // +/- 60 metres of search
    let bestIdx = hintIdx
    let bestD = Infinity
    for (let d = -span; d <= span; d++) {
      const idx = ((hintIdx + d) % m + m) % m
      const sp = this.samples[idx].pos
      const dx = p.x - sp.x, dy = p.y - sp.y, dz = p.z - sp.z
      const dist = dx * dx + dy * dy + dz * dz
      if (dist < bestD) { bestD = dist; bestIdx = idx }
    }
    const smp = this.samples[bestIdx]
    const rel = vsub(p, smp.pos)
    const along = rel.x * smp.tangent.x + rel.y * smp.tangent.y + rel.z * smp.tangent.z
    const lateral = rel.x * smp.right.x + rel.y * smp.right.y + rel.z * smp.right.z
    const height = rel.x * smp.normal.x + rel.y * smp.normal.y + rel.z * smp.normal.z
    const s = (bestIdx / m) * this.length + along
    // The half resolution. `smp.bridgeSide` is 0 everywhere except the phasing
    // spans, so this is one integer compare per projection on every other metre
    // of every track.
    const resolved = smp.bridgeSide !== 0 && !onDroppingHalf(smp, lateral)
      ? (this.safeHalf[bestIdx] as TrackSample)
      : smp
    return { s: ((s % this.length) + this.length) % this.length, lateral, height, sample: resolved }
  }

  /**
   * Signed curvature at s. Positive turns right. Used by the AI and by VFX.
   *
   * Flat, this is the turn measured about world +Y: the XZ cross product over
   * the XZ dot. That is the whole corner on a track that never leaves the
   * ground, and it is left EXACTLY as it was, arithmetic included, because the
   * AI's braking points are gated against it.
   *
   * On a gravity track it is measured about the SURFACE NORMAL instead. The
   * difference is not cosmetic: on a road climbing a wall the tangent picks up
   * a large Y component, its XZ projection shortens toward nothing, and the
   * world-+Y reading reports a hard corner where the road is dead straight --
   * so the AI stands on the brakes halfway up every wall-ride. Measuring in the
   * plane the car is actually driving in reports the turn it will actually
   * take.
   */
  curvatureAt(s: number, ahead = 12): number {
    const a = this.at(s).tangent
    const b = this.at(s + ahead).tangent
    if (this.hasGravity) {
      const n = this.at(s).normal
      const cx = a.y * b.z - a.z * b.y
      const cy = a.z * b.x - a.x * b.z
      const cz = a.x * b.y - a.y * b.x
      const an = a.x * n.x + a.y * n.y + a.z * n.z
      const bn = b.x * n.x + b.y * n.y + b.z * n.z
      const cross = cx * n.x + cy * n.y + cz * n.z
      const dot = clamp((a.x * b.x + a.y * b.y + a.z * b.z) - an * bn, -1, 1)
      return Math.atan2(cross, dot) / ahead
    }
    const cross = a.z * b.x - a.x * b.z
    const dot = clamp(a.x * b.x + a.z * b.z, -1, 1)
    const angle = Math.atan2(cross, dot)
    return angle / ahead
  }

  /** Yaw of the centreline at s. */
  yawAt(s: number): number {
    const t = this.at(s).tangent
    return Math.atan2(t.x, t.z)
  }

  /** Shortest signed distance from a to b along the loop. */
  deltaS(a: number, b: number): number {
    let d = (b - a) % this.length
    if (d > this.length / 2) d -= this.length
    if (d < -this.length / 2) d += this.length
    return d
  }
}

/**
 * Is a phasing span solid at race time `t`?
 *
 * Takes the phase of ONE half of a deck -- see `bridgePhaseFor` -- because a
 * span gives way on one half at a time. The half that stays passes -1 here and
 * is answered `true` forever, which is how the surviving lane costs this
 * function nothing and needed no new branch.
 *
 * Everything that matters about it is in what the line does NOT take: no
 * racer, no RNG, no accumulated state. Two
 * clients stepping the same race time agree by construction, and a replay from
 * a seed reproduces every bridge exactly -- the same property the fragile ice
 * shelf buys by latching off the LEADER's lap rather than each racer's own.
 *
 * `phase < 0` is permanent deck and answers true, which is what makes every
 * caller safe to run unguarded on a track with no bridges.
 */
/**
 * Is the point at `lateral` on the half of this span that gives way?
 *
 * THE SEAM IS THE CENTRELINE, and it is a hard edge rather than a band. A
 * softened seam would mean a strip down the middle of the road that is neither
 * half, which is a third state for a driver to learn about a mechanic whose
 * whole job is to be legible. `lateral < 0` is the left half, and everything
 * from the centreline outward on the named side is gone together.
 */
export function onDroppingHalf(smp: TrackSample, lateral: number): boolean {
  if (smp.bridgeSide === 0) return false
  return smp.bridgeSide < 0 ? lateral < 0 : lateral >= 0
}

/**
 * The phase that governs the deck under a point: the span's own beat on the
 * half that gives way, and -1 (permanent) on the half that stays.
 *
 * The predicate `Track.project()` applies. Exported for the callers that hold a
 * sample and a lateral without going through a projection -- the AI's lane
 * planner and the probes -- so there is exactly one place that decides which
 * half a lateral is on.
 */
export function bridgePhaseFor(smp: TrackSample, lateral: number): number {
  return onDroppingHalf(smp, lateral) ? smp.bridge : -1
}

export function bridgeSolid(phase: number, t: number): boolean {
  if (phase < 0) return true
  const u = (t / TUNING.hazard.bridgePeriod + phase) % 1
  return (u < 0 ? u + 1 : u) < TUNING.hazard.bridgeDuty
}

/**
 * Is a phasing span solid for the WHOLE interval [t0, t1]?
 *
 * What a driver actually needs to know: not "is it there now" but "will it
 * still be there when my back wheels are off it". The solid window is [0, duty)
 * in phase space and phase advances monotonically, so a crossing that starts at
 * phase `a` and lasts `d` cycles is clean exactly when `a + d < duty` -- no
 * wrap case to get wrong, because a crossing that wraps past 1.0 has already
 * passed through the absent window on the way.
 */
export function bridgeSolidThrough(phase: number, t0: number, t1: number): boolean {
  if (phase < 0) return true
  const P = TUNING.hazard.bridgePeriod
  const d = (t1 - t0) / P
  if (d >= TUNING.hazard.bridgeDuty) return false
  const u = (t0 / P + phase) % 1
  return (u < 0 ? u + 1 : u) + d < TUNING.hazard.bridgeDuty
}

/**
 * Airborne surface authority for a node. Explicit `stick` wins; otherwise a
 * node whose road is not level defaults to full authority, because the only
 * reason to tilt a road that far is to drive on the tilt.
 */
function defaultStick(node: TrackNode, up: Vec3): number {
  if (node.stick !== undefined) return node.stick
  return up.y < 0.985 ? 1 : 0
}

function catmull(nodes: TrackNode[], i: number, t: number): Vec3 {
  const n = nodes.length
  const p0 = nodes[(i - 1 + n) % n].p
  const p1 = nodes[i % n].p
  const p2 = nodes[(i + 1) % n].p
  const p3 = nodes[(i + 2) % n].p
  const t2 = t * t, t3 = t2 * t
  const c = (a: number, b: number, cc: number, d: number) =>
    0.5 * ((2 * b) + (-a + cc) * t + (2 * a - 5 * b + 4 * cc - d) * t2 + (-a + 3 * b - 3 * cc + d) * t3)
  return { x: c(p0[0], p1[0], p2[0], p3[0]), y: c(p0[1], p1[1], p2[1], p3[1]), z: c(p0[2], p1[2], p2[2], p3[2]) }
}

export { TAU }
