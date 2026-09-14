import type { TrackNode, SurfaceKind } from '../../sim/track'

/**
 * ===========================================================================
 * THE PATH BUILDER — a turtle for authoring closed circuits.
 * ===========================================================================
 *
 * The four shipped circuits were authored as literal node arrays, with arcs
 * emitted by one-off helpers written into each file (Aetherion's `rotunda`,
 * Hollow Choir's drum). That was the right call for four tracks and is the
 * wrong one for eight, because every one of those helpers had to rediscover
 * the same two traps:
 *
 *   1. SPACING IS NOT COSMETIC. `Track` bakes a UNIFORM Catmull-Rom: the
 *      tangent at a node is (next - prev) / 2 regardless of how far away those
 *      neighbours are, and each segment is walked over t in [0,1] whatever its
 *      length. So a 100m chord meeting a 14m chord does not merely look
 *      uneven, it puts a curvature SPIKE at the junction -- measured on
 *      Aetherion, an exact 70m circle entered off a 100m straight read in the
 *      fifties. Every segment this builder emits is walked at a requested
 *      spacing and the spacing is carried across joins, so arcs and straights
 *      meet at matched chords by construction.
 *
 *   2. A LAP HAS TO CLOSE, IN POSITION AND IN HEADING. Authoring by hand means
 *      the last node lands near the first and the tangents disagree, which the
 *      bake smooths into a kink on the start line -- the one piece of road
 *      every racer crosses at full speed on every lap. `closure()` reports both
 *      errors in metres and degrees so a track can assert its own closure in a
 *      test instead of hoping.
 *
 * WHAT IT DOES NOT DO. It has no opinion about racing: it will happily draw a
 * circuit that is flat out everywhere, or a corkscrew that reads as dead
 * straight to the AI. Geodesic curvature on a developable surface is zero (see
 * the headers of hollowchoir.ts and aetherion.ts, which paid for that lesson
 * three balance rounds running), so `loop()` and `helix()` below produce SET
 * PIECES and never corners. The corners have to come from `turn()`.
 */

/** A value that may vary along a segment, given u in [0,1]. */
export type Along<T> = T | ((u: number) => T)
const at = <T>(v: Along<T>, u: number): T => (typeof v === 'function' ? (v as (u: number) => T)(u) : v)

/** Per-node attributes. Anything omitted is inherited from the builder default. */
export interface SegOpts {
  w?: Along<number>
  bank?: Along<number>
  surface?: Along<SurfaceKind>
  boost?: Along<boolean>
  ramp?: Along<number>
  bounce?: Along<boolean>
  open?: Along<boolean>
  fragile?: Along<boolean>
  wind?: Along<number>
  vacuum?: Along<number>
  phase?: Along<number>
  drops?: Along<'left' | 'right' | undefined>
  stick?: Along<number>
  /** Elevation at the END of this segment. Ramped linearly from the current y. */
  toY?: number
  /** Roll, degrees, applied as an `up` vector about the local heading. */
  roll?: Along<number>
  /** Metres between nodes for this segment. Defaults to the builder's spacing. */
  spacing?: number
  /** Tag placed on the FIRST node of the segment. */
  tag?: string
}

const DEG = Math.PI / 180

/**
 * `up` for a road rolled `deg` about its own heading while lying on level
 * ground. `bearing` is radians clockwise from +Z; positive `deg` lifts the
 * driver's LEFT edge, which is a left-hander banking correctly.
 *
 * This is Aetherion's `roll()` helper, moved here unchanged. Note what it is
 * FOR: `bank` tilts the ribbon and leaves gravity pointing at the world floor,
 * while `up` moves gravity with the road -- and a node with a non-default `up`
 * defaults `stick` to 1, so a car that gets airborne over a kerb falls back
 * toward the road it left instead of out of the twist.
 */
export function rollUp(bearing: number, deg: number): [number, number, number] {
  const r = deg * DEG
  return [-Math.cos(bearing) * Math.sin(r), Math.cos(r), Math.sin(bearing) * Math.sin(r)]
}

export class Path {
  private out: TrackNode[] = []
  private x: number
  private z: number
  private y: number
  /** Heading, radians clockwise from +Z. */
  private h: number
  private readonly x0: number
  private readonly z0: number
  private readonly h0: number
  private base: SegOpts
  private spacing: number

  constructor(opts: {
    start: [number, number, number]
    /** Initial heading in degrees clockwise from +Z. */
    heading?: number
    spacing?: number
    defaults: SegOpts
  }) {
    this.x = opts.start[0]; this.y = opts.start[1]; this.z = opts.start[2]
    this.x0 = this.x; this.z0 = this.z
    this.h = (opts.heading ?? 0) * DEG
    this.h0 = this.h
    this.spacing = opts.spacing ?? 26
    this.base = opts.defaults
  }

  /** Current plan-view position and heading, for laying out a track by hand. */
  get here(): { x: number; y: number; z: number; heading: number } {
    return { x: this.x, y: this.y, z: this.z, heading: this.h / DEG }
  }

  private emit(u: number, o: SegOpts, upVec?: [number, number, number], tag?: string): void {
    const pick = <K extends keyof SegOpts>(k: K): SegOpts[K] =>
      (o[k] !== undefined ? o[k] : this.base[k]) as SegOpts[K]
    const n: TrackNode = { p: [round(this.x), round(this.y), round(this.z)], w: round(at(pick('w') as Along<number> ?? 20, u)) }
    const bank = pick('bank'); if (bank !== undefined) { const v = at(bank, u); if (v !== 0) n.bank = round(v) }
    const surface = pick('surface'); if (surface !== undefined) n.surface = at(surface, u)
    const boost = pick('boost'); if (boost !== undefined && at(boost, u)) n.boost = true
    const ramp = pick('ramp'); if (ramp !== undefined) { const v = at(ramp, u); if (v > 0) n.ramp = round(v) }
    const bounce = pick('bounce'); if (bounce !== undefined && at(bounce, u)) n.bounce = true
    const open = pick('open'); if (open !== undefined && at(open, u)) n.open = true
    const fragile = pick('fragile'); if (fragile !== undefined && at(fragile, u)) n.fragile = true
    const wind = pick('wind'); if (wind !== undefined) { const v = at(wind, u); if (v !== 0) n.wind = round(v) }
    const vac = pick('vacuum'); if (vac !== undefined) { const v = at(vac, u); if (v !== 0) n.vacuum = round3(v) }
    const ph = pick('phase'); if (ph !== undefined) { const v = at(ph, u); if (v >= 0) n.phase = round3(v) }
    const dr = pick('drops'); if (dr !== undefined) { const v = at(dr, u); if (v) n.drops = v }
    const st = pick('stick'); if (st !== undefined) { const v = at(st, u); if (v > 0) n.stick = round3(v) }
    if (upVec) n.up = [round3(upVec[0]), round3(upVec[1]), round3(upVec[2])]
    else {
      const rl = pick('roll')
      if (rl !== undefined) { const v = at(rl, u); if (v !== 0) n.up = vround(rollUp(this.h, v)) }
    }
    if (tag) n.tag = tag
    this.out.push(n)
  }

  /** A straight run of `len` metres on the current heading. */
  straight(len: number, o: SegOpts = {}): this {
    const sp = o.spacing ?? this.spacing
    const steps = Math.max(1, Math.round(len / sp))
    const y0 = this.y, y1 = o.toY ?? this.y
    const dx = Math.sin(this.h), dz = Math.cos(this.h)
    for (let i = 0; i < steps; i++) {
      const u = i / steps
      this.x = this.x + (i === 0 ? 0 : (len / steps) * dx)
      this.z = this.z + (i === 0 ? 0 : (len / steps) * dz)
      this.y = y0 + (y1 - y0) * u
      this.emit(u, o, undefined, i === 0 ? o.tag : undefined)
    }
    // Advance to the end without emitting: the next segment emits its own start.
    this.x += (len / steps) * dx
    this.z += (len / steps) * dz
    this.y = y1
    return this
  }

  /**
   * An arc of `deg` degrees at `radius`. Positive turns RIGHT (toward +x at
   * heading 0), matching the heading convention.
   */
  turn(radius: number, deg: number, o: SegOpts = {}): this {
    const sp = o.spacing ?? this.spacing
    const arcLen = Math.abs(deg) * DEG * radius
    const steps = Math.max(2, Math.round(arcLen / sp))
    const sgn = Math.sign(deg)
    // Centre of the arc, 90 degrees off the heading on the turning side.
    const cx = this.x + sgn * radius * Math.cos(this.h)
    const cz = this.z - sgn * radius * Math.sin(this.h)
    const a0 = Math.atan2(this.x - cx, this.z - cz)
    const y0 = this.y, y1 = o.toY ?? this.y
    for (let i = 0; i < steps; i++) {
      const u = i / steps
      const a = a0 + sgn * deg * DEG * u
      this.x = cx + radius * Math.sin(a)
      this.z = cz + radius * Math.cos(a)
      this.y = y0 + (y1 - y0) * u
      // Heading on a circle: the tangent at polar angle `a` is 90 degrees off
      // the radius, on the side the turn is going. Derived rather than
      // accumulated, so a long arc cannot drift out of true one step at a time.
      this.h = normalize(a + sgn * (Math.PI / 2))
      this.emit(u, o, undefined, i === 0 ? o.tag : undefined)
    }
    const aFinal = a0 + deg * DEG
    this.x = cx + radius * Math.sin(aFinal)
    this.z = cz + radius * Math.cos(aFinal)
    this.y = y1
    this.h = normalize(aFinal + sgn * (Math.PI / 2))
    return this
  }

  /**
   * A FULL VERTICAL LOOP of `radius`, entered and left on the current heading
   * at the current position. Plan-view displacement is zero: the road climbs,
   * inverts, and comes back down onto its own entry point, which the bake and
   * the projection both handle (tools/probe-loop.ts measures the deck's
   * self-projection error at 0.00m and puts a full field of eight over the top
   * with no respawns).
   *
   * `up` points at the loop's centre the whole way round, so the car is held on
   * the INSIDE and `stick` defaults to 1. Steps default to 15 degrees apart:
   * the bake refuses more than 120 degrees of up-vector between neighbours, and
   * a loop authored coarsely reads as a polygon.
   *
   * IT IS A SET PIECE, NOT A CORNER. Its curvature vector points straight along
   * the surface normal, so `curvatureAt` -- which measures about that normal on
   * a gravity track -- reports EXACTLY zero through the whole loop (measured:
   * 0.0000 across 120m either side of the apex, against the AI's 0.0045 drift
   * -hold gate). Nothing brakes for it and nothing drifts in it. Put it where
   * the lap can afford to be flat out.
   */
  loop(radius: number, o: SegOpts & { steps?: number } = {}): this {
    const steps = o.steps ?? 24
    const dx = Math.sin(this.h), dz = Math.cos(this.h)
    const x0 = this.x, y0 = this.y, z0 = this.z
    for (let i = 0; i < steps; i++) {
      const th = (2 * Math.PI * i) / steps
      const fwd = radius * Math.sin(th)
      this.x = x0 + fwd * dx
      this.z = z0 + fwd * dz
      this.y = y0 + radius - radius * Math.cos(th)
      const up: [number, number, number] = [-Math.sin(th) * dx, Math.cos(th), -Math.sin(th) * dz]
      this.emit(i / steps, o, up, i === 0 ? o.tag : undefined)
    }
    this.x = x0; this.y = y0; this.z = z0
    return this
  }

  /**
   * A HELIX: `turns` revolutions about an axis running along the current
   * heading, climbing `rise` metres in total. The road spirals around the
   * inside of a tube of `radius`, which is what a corkscrew and a drum section
   * both are.
   *
   * Same warning as `loop`, for the same reason and with the same arithmetic: a
   * helix on a cylinder is a geodesic, its geodesic curvature is identically
   * zero, and `curvatureAt` reports it as dead straight. Aetherion's rotunda
   * cost three balance rounds to exactly this, and the lesson written down
   * afterwards was that the corners have to come from the road WEAVING on the
   * drum rather than from the drum. This helper draws the drum.
   */
  helix(radius: number, turns: number, rise: number, o: SegOpts & { steps?: number; phase0?: number } = {}): this {
    const steps = o.steps ?? Math.max(12, Math.round(turns * 24))
    const dx = Math.sin(this.h), dz = Math.cos(this.h)
    // Right-hand basis: `right` is 90 degrees clockwise of the heading in plan.
    const rx = Math.cos(this.h), rz = -Math.sin(this.h)
    const x0 = this.x, y0 = this.y, z0 = this.z
    const p0 = (o.phase0 ?? 0) * DEG
    for (let i = 0; i < steps; i++) {
      const u = i / steps
      const th = p0 + 2 * Math.PI * turns * u
      const fwd = rise * u
      const ox = radius * Math.sin(th), oy = -radius * Math.cos(th)
      this.x = x0 + fwd * dx + ox * rx
      this.z = z0 + fwd * dz + ox * rz
      this.y = y0 + radius + oy
      const up: [number, number, number] = [-Math.sin(th) * rx, Math.cos(th), -Math.sin(th) * rz]
      this.emit(u, o, up, i === 0 ? o.tag : undefined)
    }
    this.x = x0 + rise * dx + radius * Math.sin(p0 + 2 * Math.PI * turns) * rx
    this.z = z0 + rise * dz + radius * Math.sin(p0 + 2 * Math.PI * turns) * rz
    this.y = y0 + radius - radius * Math.cos(p0 + 2 * Math.PI * turns)
    return this
  }

  /** How far the lap misses closing, in metres and in degrees of heading. */
  closure(): { gap: number; turn: number } {
    return {
      gap: Math.hypot(this.x - this.x0, this.z - this.z0),
      turn: Math.abs(normalize(this.h - this.h0)) / DEG,
    }
  }

  nodes(): TrackNode[] { return this.out }
}

function normalize(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2
  while (a < -Math.PI) a += Math.PI * 2
  return a
}
const round = (v: number) => Math.round(v * 10) / 10
const round3 = (v: number) => Math.round(v * 1000) / 1000
const vround = (v: [number, number, number]): [number, number, number] => [round3(v[0]), round3(v[1]), round3(v[2])]
