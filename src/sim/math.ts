/**
 * Pure deterministic math. No Three.js, no DOM. Plain object vectors so the
 * whole sim can run headless in Node and produce a stable state hash.
 */

export interface Vec3 { x: number; y: number; z: number }

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z })
export const vclone = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z })
export const vset = (o: Vec3, x: number, y: number, z: number): Vec3 => { o.x = x; o.y = y; o.z = z; return o }
export const vcopy = (o: Vec3, a: Vec3): Vec3 => { o.x = a.x; o.y = a.y; o.z = a.z; return o }

/** In-place add. Written to avoid allocation inside the fixed-step loop. */
export const vaddi = (o: Vec3, a: Vec3): Vec3 => { o.x += a.x; o.y += a.y; o.z += a.z; return o }
export const vsubi = (o: Vec3, a: Vec3): Vec3 => { o.x -= a.x; o.y -= a.y; o.z -= a.z; return o }
export const vscalei = (o: Vec3, s: number): Vec3 => { o.x *= s; o.y *= s; o.z *= s; return o }
export const vaddScaledi = (o: Vec3, a: Vec3, s: number): Vec3 => {
  o.x += a.x * s; o.y += a.y * s; o.z += a.z * s; return o
}

export const vadd = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z })
export const vsub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
export const vscale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s })
export const vdot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z
export const vcross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})
export const vlen = (a: Vec3): number => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z)
export const vlenSq = (a: Vec3): number => a.x * a.x + a.y * a.y + a.z * a.z
export const vdist = (a: Vec3, b: Vec3): number => {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}
export const vdistSq = (a: Vec3, b: Vec3): number => {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z
  return dx * dx + dy * dy + dz * dz
}

export const vnorm = (a: Vec3): Vec3 => {
  const l = vlen(a)
  return l > 1e-9 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: 0, y: 0, z: 0 }
}
export const vnormi = (o: Vec3): Vec3 => {
  const l = vlen(o)
  if (l > 1e-9) { o.x /= l; o.y /= l; o.z /= l } else { o.x = 0; o.y = 0; o.z = 0 }
  return o
}

export const vlerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
})
export const vlerpi = (o: Vec3, b: Vec3, t: number): Vec3 => {
  o.x += (b.x - o.x) * t; o.y += (b.y - o.y) * t; o.z += (b.z - o.z) * t; return o
}

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)
export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
export const smoothstep = (t: number): number => { const c = clamp01(t); return c * c * (3 - 2 * c) }
export const sign = (x: number): number => (x > 0 ? 1 : x < 0 ? -1 : 0)

export const TAU = Math.PI * 2
export const DEG = Math.PI / 180
export const RAD = 180 / Math.PI

/** Shortest signed angular difference from a to b, in radians. */
export const angleDelta = (a: number, b: number): number => {
  let d = (b - a) % TAU
  if (d > Math.PI) d -= TAU
  if (d < -Math.PI) d += TAU
  return d
}

/** Move `a` toward `b` by at most `maxStep` radians, wrapping correctly. */
export const angleToward = (a: number, b: number, maxStep: number): number => {
  const d = angleDelta(a, b)
  if (Math.abs(d) <= maxStep) return b
  return a + sign(d) * maxStep
}

/**
 * Frame-rate independent exponential smoothing.
 * `halfLife` is the time in seconds for the gap to halve.
 */
export const damp = (current: number, target: number, halfLife: number, dt: number): number => {
  if (halfLife <= 0) return target
  return target + (current - target) * Math.pow(2, -dt / halfLife)
}

export const dampVec = (o: Vec3, target: Vec3, halfLife: number, dt: number): Vec3 => {
  const f = halfLife <= 0 ? 0 : Math.pow(2, -dt / halfLife)
  o.x = target.x + (o.x - target.x) * f
  o.y = target.y + (o.y - target.y) * f
  o.z = target.z + (o.z - target.z) * f
  return o
}

/**
 * Rotate `o` in place about a UNIT axis by `angle` radians (Rodrigues).
 *
 * Used by the gravity system: when a racer's up-vector swings onto a wall the
 * whole state that lives in the old surface plane -- heading, velocity -- has
 * to swing with it, or the car arrives on the wall pointing into it.
 */
export const vrotAxis = (o: Vec3, axis: Vec3, angle: number): Vec3 => {
  const c = Math.cos(angle), s = Math.sin(angle)
  const d = axis.x * o.x + axis.y * o.y + axis.z * o.z
  const cx = axis.y * o.z - axis.z * o.y
  const cy = axis.z * o.x - axis.x * o.z
  const cz = axis.x * o.y - axis.y * o.x
  const k = d * (1 - c)
  o.x = o.x * c + cx * s + axis.x * k
  o.y = o.y * c + cy * s + axis.y * k
  o.z = o.z * c + cz * s + axis.z * k
  return o
}

/**
 * Rotate `o` in place by the MINIMAL rotation that takes unit vector `from` to
 * unit vector `to`. A no-op when they already agree, which is the case on every
 * metre of a flat track, so this costs nothing where gravity is boring.
 */
export const vrotFromTo = (o: Vec3, from: Vec3, to: Vec3): Vec3 => {
  const d = clamp(from.x * to.x + from.y * to.y + from.z * to.z, -1, 1)
  if (d > 0.9999999) return o
  let ax = from.y * to.z - from.z * to.y
  let ay = from.z * to.x - from.x * to.z
  let az = from.x * to.y - from.y * to.x
  const len = Math.hypot(ax, ay, az)
  if (len < 1e-9) {
    // Exactly antiparallel: every perpendicular axis is a minimal rotation, so
    // the cross product gives no answer. Cross with whichever world axis `from`
    // is least aligned with, which is guaranteed not to be degenerate too.
    if (Math.abs(from.x) < 0.9) { ax = 0; ay = from.z; az = -from.y }
    else { ax = -from.z; ay = 0; az = from.x }
    const l2 = Math.hypot(ax, ay, az) || 1
    ax /= l2; ay /= l2; az /= l2
  } else {
    ax /= len; ay /= len; az /= len
  }
  _rotAxis.x = ax; _rotAxis.y = ay; _rotAxis.z = az
  return vrotAxis(o, _rotAxis, Math.acos(d))
}
const _rotAxis: Vec3 = { x: 0, y: 1, z: 0 }
