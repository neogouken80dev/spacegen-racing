import type { TrackDef, TrackNode } from '../../sim/track'
import { ring, envelope, inSpan, type Harm } from './ring'

/**
 * MERIDIAN DEEP — Submerged Transit Tube.
 *
 * The sixth circuit. A maintenance arterial running along the floor of an
 * abyssal trench, inside a transparent pressure tube, with the ocean and
 * everything living in it on the other side of the glass.
 *
 * Difficulty: Hard. Elkarim and Ashkar are decided on surface; this one is
 * decided on GRIP FALLING AWAY UNDER YOU, which is a different and less
 * forgiving thing.
 *
 * ---------------------------------------------------------------------------
 * 1. THE BIOFILM IS THE TRACK.
 *
 * `oil` is grip 0.30 -- lower than ice (0.45) and less than a third of tarmac.
 * Elkarim has a little of it and it is a hazard you avoid. Here it is a
 * FEATURE of the route: the tube leaks, and where it leaks things grow, so the
 * bloom patches sit on the racing line through three of the lap's corners
 * rather than off it. The patches are authored as ramps in and out over 30-40m
 * rather than as edges, for the reason `wind` and `vacuum` both interpolate --
 * a step change in the lateral budget mid-corner takes the car away in one
 * frame and reads as a bug, not a surface.
 *
 * 0.30 grip is survivable at 40 m/s and not at 60, which is the whole design:
 * every bloom is placed where the corner ALREADY wanted you slow, so it
 * punishes a driver who arrived hot and costs a tidy one almost nothing.
 *
 * 2. THE TUBE IS WHY THE ROAD CAN ROLL.
 *
 * A road inside a cylinder can climb its walls, and every node that authors an
 * `up` off world-vertical defaults `stick` to 1, so a car that gets light over
 * a seam falls back toward the road it left rather than into the glass. The
 * Descent is two full turns of that.
 *
 * And, as on Ashkar and for the same arithmetic: A HELIX IS A GEODESIC and the
 * sim reads it as dead straight. The Descent and the Cathedral loop are set
 * pieces. The lap is decided on the blooms.
 *
 * 3. THE BREACH.
 *
 * One span where the tube is cracked and the sea is coming through: a lateral
 * current (`wind`), against BOUNCE walls. Ashkar paid for that lesson at 16.3
 * respawns a race -- a crosswind over unbarriered road is not difficulty, it is
 * a loading screen -- so the current pushes you into something you can lean on.
 * Which, since contact no longer ends a drift, is a corner you can commit to.
 *
 * 4. WHAT THE PLAYER IS LOOKING AT.
 *
 * Everything outside the glass: light shafts from a surface 900m up, schools
 * turning in unison, and the leviathans holding station in the middle distance
 * (themes/abyssal.ts draws them through the celestial `ships` layer, which is
 * silhouettes with running lights -- exactly what a bioluminescent animal at
 * range IS). The tube is the only lit thing; the ocean is the dark.
 */

/**
 * THE SHAPE: a LONG ellipse with a small second harmonic -- two hairpin ends
 * and two very long flanks, which is a trench. It is deliberately the opposite
 * of every other circuit's plan: Ashkar is a kidney, Halcyon Bay a three-lobed
 * clover, Zhen-9 a squared-off block. All four were originally drawn from one
 * k1+k2+k3 parametrisation and came out as versions of the same shape --
 * reported as "they all share the same track map and layout", which is exactly
 * what that family can produce and nothing else.
 *
 * 2910m in plan, tightest corner 74m, and no part of the lap passes within 196m
 * of another part -- see `ringSelfDistance`.
 */
const H: Harm[] = [
  { k: 1, ax: 650, bx: 0, az: 0, bz: 227.5 },
  { k: 2, ax: 30, bx: 0, az: 0, bz: 30 },
]

const SPACING = 26
const RING = ring(H, SPACING)
const PLAN_LEN = RING.length * SPACING

/**
 * Beat map. NO LOOP ON THIS CIRCUIT, by design: the four tracks now divide the
 * set pieces between them rather than each carrying one of everything. Meridian
 * Deep is the SPIRAL track -- one long three-turn descent and nothing else --
 * where Halcyon Bay takes the loops and Zhen-9 takes one of each.
 */
const BEATS = {
  bloomA: [0.10, 0.19] as [number, number],
  trenchJump: 0.27,
  bloomB: [0.34, 0.43] as [number, number],
  descent: [0.52, 0.70] as [number, number],
  breach: [0.76, 0.88] as [number, number],
  bloomC: [0.92, 0.99] as [number, number],
}

/** The trench floor. Floor of 8m: nothing on this lap sits below world zero. */
function elevation(u: number): number {
  return 21 * Math.sin(2 * Math.PI * (u - 0.14)) + 9 * Math.sin(4 * Math.PI * (u + 0.2)) + 38
}

/** Three turns, because this is the circuit whose whole set piece is the spiral. */
const DESC_R = 30
const DESC_TURNS = 3
const DESC_W = 19

/**
 * The descent, snapped to ring-node boundaries.
 *
 * A span that starts or ends partway between two ring nodes emits its last node
 * a few metres before the next ordinary one -- measured here as a 6.3m chord
 * against a 28.7m ring, a ratio of 4.6, which is the spacing mismatch that puts
 * a curvature spike at a join. Snapping makes the spiral REPLACE whole nodes.
 */
const DESC_SPAN = (() => {
  const n = RING.length
  let startIdx = RING.findIndex((p) => p.u >= BEATS.descent[0])
  if (startIdx < 0) startIdx = 0
  let endIdx = startIdx
  while (endIdx + 1 < n && RING[endIdx + 1].u < BEATS.descent[1]) endIdx++
  return { startIdx, endIdx, uFrom: RING[startIdx].u, uTo: RING[(endIdx + 1) % n].u || 1 }
})()

function build(): TrackNode[] {
  const out: TrackNode[] = []
  const n = RING.length

  for (let i = 0; i < n; i++) {
    const p = RING[i]
    const u = p.u
    const y = elevation(u)

    // ---- THE DESCENT. Sampled along its own AXIS rather than on the ring's
    // 26m nodes: a spiral covers far more ground per degree of sweep than the
    // axis does, and riding the ring's spacing puts a 40m lateral hop between
    // neighbours (measured on Ashkar as a chord ratio of 17 and a phantom
    // corner the AI braked for). Radius ramps over the outer 35% at each end so
    // the tube has mouths rather than a step -- at constant radius the helix
    // starts at full angular rate and kinks at both ends.
    if (i >= DESC_SPAN.startIdx && i <= DESC_SPAN.endIdx) {
      if (i !== DESC_SPAN.startIdx) continue
      const span = DESC_SPAN.uTo - DESC_SPAN.uFrom
      const spanLen = span * PLAN_LEN
      const steps = Math.max(24, Math.round(spanLen / 13))
      for (let sIdx = 0; sIdx < steps; sIdx++) {
        const f = sIdx / steps
        const uu = DESC_SPAN.uFrom + span * f
        const rp = ringAt(uu)
        const drx = Math.cos(rp.heading), drz = -Math.sin(rp.heading)
        const th = 2 * Math.PI * DESC_TURNS * f
        const e = Math.max(0, Math.min(1, Math.min(f / 0.35, (1 - f) / 0.35)))
        const rEff = DESC_R * e * e * (3 - 2 * e)
        out.push({
          p: [
            r1(rp.x + rEff * Math.sin(th) * drx),
            r1(elevation(uu) + rEff - rEff * Math.cos(th)),
            r1(rp.z + rEff * Math.sin(th) * drz),
          ],
          w: DESC_W,
          up: [r3(-Math.sin(th) * drx), r3(Math.cos(th)), r3(-Math.sin(th) * drz)],
          surface: 'metal',
          boost: f > 0.40 && f < 0.60,
          tag: sIdx === 0 ? 'descent' : undefined,
        })
      }
      continue
    }

    const node: TrackNode = { p: [r1(p.x), r1(y), r1(p.z)], w: r1(width(u, p.k)) }

    // THE BLOOMS. `surface` snaps at the midpoint between nodes rather than
    // interpolating, so a bloom is made survivable by sitting where the corner
    // is already slow, not by fading the coefficient.
    const bloom = Math.max(
      envelope(u, BEATS.bloomA[0], BEATS.bloomA[1], 0.34),
      envelope(u, BEATS.bloomB[0], BEATS.bloomB[1], 0.34),
      envelope(u, BEATS.bloomC[0], BEATS.bloomC[1], 0.40),
    )
    node.surface = bloom > 0.55 ? 'oil' : 'metal'

    const bank = clamp(-p.k * 1050, -12, 12)
    if (Math.abs(bank) > 0.6) node.bank = r1(bank)

    // The Breach current pushes you at a BOUNCE wall, never off open road:
    // Ashkar measured 16.3 respawns a race the other way round.
    const cur = envelope(u, BEATS.breach[0], BEATS.breach[1], 0.30)
    if (cur > 0.02) { node.wind = r1(15 * cur); node.bounce = true }

    if (Math.abs(u - BEATS.trenchJump) < 0.012) { node.ramp = 29; node.boost = true; node.tag = 'trench-jump' }
    if (inSpan(u, BEATS.trenchJump + 0.012, BEATS.trenchJump + 0.034)) node.open = true

    if (Math.abs(u - BEATS.bloomA[0]) < 0.005) node.tag = 'bloom'
    if (Math.abs(u - BEATS.breach[0]) < 0.005) node.tag = 'breach'
    if (u === 0) node.tag = 'start'
    out.push(node)
  }
  return out
}

/**
 * Road half-width. ADDS to a base and never subtracts, so the narrowest the
 * circuit can be is a number somebody chose -- a width function built out of
 * penalties has no floor you can reason about, because the penalties do not
 * know about each other (Ashkar stacked four of them into one 15.5m bend).
 */
function width(u: number, k: number): number {
  let w = 19
  w += 3 * Math.min(1, Math.abs(k) * 90)
  if (inSpan(u, BEATS.breach[0], BEATS.breach[1])) w += 1.5
  if (inSpan(u, 0.95, 0.06)) w += 3
  return clamp(w, 18, 25)
}

/** The ring at an arbitrary lap fraction, linearly between its baked points. */
function ringAt(u: number): { x: number; z: number; heading: number } {
  const n = RING.length
  const t = (((u % 1) + 1) % 1) * n
  const i = Math.floor(t) % n
  const j = (i + 1) % n
  const f = t - Math.floor(t)
  const a = RING[i], b = RING[j]
  let dh = b.heading - a.heading
  while (dh > Math.PI) dh -= Math.PI * 2
  while (dh < -Math.PI) dh += Math.PI * 2
  return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, heading: a.heading + dh * f }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const r1 = (v: number) => Math.round(v * 10) / 10
const r3 = (v: number) => Math.round(v * 1000) / 1000

export const ABYSSAL: TrackDef = {
  id: 'abyssal',
  name: 'Meridian Deep',
  skyTop: 0x01060f,
  skyBottom: 0x063b55,
  fogColor: 0x042c41,
  fogDensity: 0.0072,
  sunColor: 0x9fd8ee,
  sunIntensity: 0.78,
  ambientColor: 0x0a3a52,
  ambientIntensity: 0.95,
  // The light comes from a surface 900m up and slightly behind: near-vertical,
  // which is what makes the shafts read as shafts.
  sunDirection: [0.14, 0.96, 0.24],
  palette: { a: 0x10323f, b: 0x1d6b7a, c: 0x37b0b4, accent: 0x54f0d0 },
  nodes: build(),
  itemBoxRows: [
    { at: 0.08, count: 5, spread: 4.2 },
    { at: 0.25, count: 4, spread: 4.0 },
    { at: 0.48, count: 5, spread: 4.2 },
    { at: 0.77, count: 5, spread: 4.4 },
    { at: 0.93, count: 4, spread: 4.0 },
  ],
  chargeRuns: [
    { from: 0.02, to: 0.07, count: 6, lateral: -5 },
    { from: 0.22, to: 0.28, count: 7, lateral: 4 },
    { from: 0.46, to: 0.51, count: 6, lateral: 0 },
    { from: 0.57, to: 0.61, count: 6, lateral: -5 },
    { from: 0.81, to: 0.88, count: 7, lateral: 5 },
  ],
  laps: 3,
}
