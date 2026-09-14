/**
 * ===========================================================================
 * THE RING — a closed plan-view centreline, authored as harmonics.
 * ===========================================================================
 *
 * `path.ts` builds a circuit as a turtle: straights and arcs, one after
 * another. That is the right tool when the shape is known, and it has one
 * failure mode that cost this pass several hours before it was named. A lap has
 * to close in POSITION and in HEADING. Heading is easy -- make the turns sum to
 * 360 degrees. Position is a 2x2 linear solve once the turns are fixed, and the
 * solve is exact, and the exact answer is frequently NEGATIVE: the layout as
 * drawn needs a straight that runs 400 metres backwards. Three restructurings
 * of the volcanic circuit all landed there.
 *
 * A periodic curve cannot have that problem:
 *
 *   x(t) = Sum_k  ax[k] cos(k t) + bx[k] sin(k t)
 *   z(t) = Sum_k  az[k] cos(k t) + bz[k] sin(k t)
 *
 * It closes because it is periodic and it is smooth because it is a sum of
 * smooth terms -- so there is no start-line kink to find later, on the one
 * piece of road every racer crosses flat out on every lap. k=1 is the overall
 * oval, k=2 puts a waist in it, k=3 adds a lobe. Past k=5 the wiggle is finer
 * than the road is wide and there is no point.
 *
 * WHAT THIS DOES NOT GIVE YOU. A harmonic curve has no straights in the strict
 * sense, only stretches where the radius is very large, and it has no corner
 * whose radius you chose -- you get the radii the coefficients imply. So the
 * workflow is: search coefficient space for a shape whose length and radius
 * RANGE are right (tools/probe-ring.ts), then read the beats off the shape you
 * got rather than drawing the beats first. That is backwards from how a circuit
 * is usually designed and it is the price of guaranteed closure.
 *
 * SPACING IS RESAMPLED AT CONSTANT ARC LENGTH, which is not decoration. `Track`
 * bakes a UNIFORM Catmull-Rom -- the tangent at a node is (next - prev)/2 no
 * matter how far away those neighbours are -- so uneven chords put curvature
 * SPIKES at the joins. Measured on Aetherion: an exact 70m circle entered off a
 * 100m straight read in the fifties. `resample` exists to make that impossible.
 */

export interface Harm { k: number; ax: number; bx: number; az: number; bz: number }

/** A resampled point on the ring, with the frame the track needs. */
export interface RingPoint {
  x: number
  z: number
  /** Lap fraction, 0..1. */
  u: number
  /** Heading, radians clockwise from +Z. */
  heading: number
  /** Signed plan curvature, 1/m. Positive turns right. */
  k: number
}

export function curveAt(H: Harm[], t: number): { x: number; z: number } {
  let x = 0, z = 0
  for (const h of H) {
    x += h.ax * Math.cos(h.k * t) + h.bx * Math.sin(h.k * t)
    z += h.az * Math.cos(h.k * t) + h.bz * Math.sin(h.k * t)
  }
  return { x, z }
}

/** Analytic first and second derivatives — exact, so curvature is not a finite difference. */
function deriv(H: Harm[], t: number): { dx: number; dz: number; ddx: number; ddz: number } {
  let dx = 0, dz = 0, ddx = 0, ddz = 0
  for (const h of H) {
    const c = Math.cos(h.k * t), s = Math.sin(h.k * t)
    dx += h.k * (-h.ax * s + h.bx * c)
    dz += h.k * (-h.az * s + h.bz * c)
    ddx += h.k * h.k * (-h.ax * c - h.bx * s)
    ddz += h.k * h.k * (-h.az * c - h.bz * s)
  }
  return { dx, dz, ddx, ddz }
}

/**
 * Resample the closed curve at a constant arc-length spacing, returning exactly
 * `round(length / spacing)` points with no duplicate at the seam.
 */
export function ring(H: Harm[], spacing: number): RingPoint[] {
  const FINE = 20000
  const xs: number[] = [], zs: number[] = [], ts: number[] = [], ss: number[] = []
  let s = 0
  let prev = curveAt(H, 0)
  xs.push(prev.x); zs.push(prev.z); ts.push(0); ss.push(0)
  for (let i = 1; i <= FINE; i++) {
    const t = (2 * Math.PI * i) / FINE
    const p = curveAt(H, t)
    s += Math.hypot(p.x - prev.x, p.z - prev.z)
    xs.push(p.x); zs.push(p.z); ts.push(t); ss.push(s)
    prev = p
  }
  const total = ss[ss.length - 1]
  const n = Math.max(24, Math.round(total / spacing))
  const out: RingPoint[] = []
  let j = 0
  for (let i = 0; i < n; i++) {
    const target = (total * i) / n
    while (j < ss.length - 1 && ss[j + 1] < target) j++
    const a = j, b = Math.min(j + 1, ss.length - 1)
    const f = ss[b] > ss[a] ? (target - ss[a]) / (ss[b] - ss[a]) : 0
    const t = ts[a] + (ts[b] - ts[a]) * f
    const p = curveAt(H, t)
    const d = deriv(H, t)
    const sp = Math.hypot(d.dx, d.dz) || 1e-9
    // Signed planar curvature. The cross product is (dx*ddz - dz*ddx) in the
    // (x, z) plane; the sign convention is chosen so positive turns RIGHT,
    // matching `Path`'s heading convention.
    const k = (d.dx * d.ddz - d.dz * d.ddx) / (sp * sp * sp)
    out.push({ x: p.x, z: p.z, u: i / n, heading: Math.atan2(d.dx, d.dz), k: -k })
  }
  return out
}

/** Plan length and the radius range, for searching coefficient space. */
export function ringStats(H: Harm[]): { len: number; minR: number; maxR: number } {
  const N = 4000
  let len = 0, minR = Infinity, maxR = 0
  let prev = curveAt(H, 0)
  for (let i = 1; i <= N; i++) {
    const p = curveAt(H, (2 * Math.PI * i) / N)
    len += Math.hypot(p.x - prev.x, p.z - prev.z)
    prev = p
  }
  for (let i = 0; i < N; i++) {
    const t = (2 * Math.PI * i) / N
    const d = deriv(H, t)
    const sp = Math.hypot(d.dx, d.dz) || 1e-9
    const k = Math.abs((d.dx * d.ddz - d.dz * d.ddx) / (sp * sp * sp))
    const R = k > 1e-9 ? 1 / k : Infinity
    minR = Math.min(minR, R)
    if (Number.isFinite(R)) maxR = Math.max(maxR, R)
  }
  return { len, minR, maxR }
}

/** Shortest signed difference between two headings, radians. */
export function angleDiff(a: number, b: number): number {
  let d = b - a
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return d
}

/** True where lap fraction `u` lies in [from, to), wrapping past the seam. */
export function inSpan(u: number, from: number, to: number): boolean {
  return from <= to ? u >= from && u < to : u >= from || u < to
}

/** 0 outside [from,to], ramping to 1 over `edge` of the span at each end. */
export function envelope(u: number, from: number, to: number, edge = 0.25): number {
  if (!inSpan(u, from, to)) return 0
  const span = from <= to ? to - from : 1 - from + to
  let d = u - from; if (d < 0) d += 1
  const f = d / span
  const e = Math.max(1e-6, edge)
  return Math.max(0, Math.min(1, Math.min(f / e, (1 - f) / e)))
}
