import type { TrackDef, TrackNode } from '../../sim/track'
import { ring, envelope, inSpan, staggeredLoop, loopBias, loopSteps, type Harm } from './ring'

/**
 * ZHEN-9 — Stacked Metropolis.
 *
 * The eighth circuit, and the STREET circuit: the roster had no track whose
 * difficulty came from geometry alone.
 *
 * Difficulty: Hard. Every other Hard circuit in the game is hard because of a
 * substance -- Frosthelm's ice, Meridian Deep's biofilm, Centurion Prime's
 * vacuum. Take the substance away and they are wide, fast and forgiving. This
 * one has no hostile surface anywhere: it is dry maglev deck end to end, grip
 * 1.0, and it is the hardest lap in the game because the road is 15-18m
 * half-width, walled on both sides, and turns through a 46m corner four times.
 *
 * ---------------------------------------------------------------------------
 * 1. NARROW AND WALLED IS A DIFFERENT KIND OF HARD, AND IT ONLY WORKS NOW.
 *
 * A circuit built out of walls would have been a bad idea two passes ago,
 * because contact used to END A DRIFT -- and on a street circuit contact is not
 * an accident, it is the lap. The drift-ownership pass removed that: the button
 * is the only exit, so clipping a barrier mid-slide costs you speed and nothing
 * else. Leaning on a wall through a 46m corner is now a line a driver can
 * choose. That is what makes this track buildable, and it is why it is the last
 * of the four rather than the first.
 *
 * Every wall here is `bounce` rather than scrub, for the same reason.
 *
 * 2. THE MAGLEV IS THE COMPENSATION.
 *
 * Narrow and tight on its own is just slow and irritating. The straights
 * between the corner complexes carry maglev strips -- long `boost` runs, far
 * more of them than any other circuit -- so the lap alternates hard braking
 * with genuine top speed rather than grinding. The rhythm is the point: you are
 * never fast and safe at the same time.
 *
 * 3. THE SQUEEZE, AND THE PHASING SPAN THAT IS NOT HERE.
 *
 * The first draft put a hard-light span across the gap between two towers --
 * Namaresh's half-dropping causeway, used once at a longer span. It measured
 * 15.0 respawns a race against 0.0-0.7 on every shipped circuit, and where it
 * sat mattered far more than how long it was: the same 100m span measured 1.7
 * respawns a race at one lap fraction and 9.0 thirty metres later. That
 * sensitivity is the diagnosis. The
 * AI's lane planner (LANE_CENTRE in sim/ai.ts) holds a lateral offset through a
 * span, and on a circuit this narrow that hold is in direct conflict with the
 * racing line into the next corner -- so whether the field survives depends on
 * which way the corner after the span happens to turn. Namaresh can carry the
 * mechanic because Namaresh is wide and its causeway sits on a straight with
 * room either side. This track is neither.
 *
 * It was removed rather than tuned, because the alternative was choosing the
 * dropping half to AGREE with the racing line, which turns a decision into a
 * formality. What replaced it is the thing this circuit is actually about: the
 * road narrows to 12.5m half-width between two towers, ramped in over 40m so it
 * is a squeeze and not a wall. No hazard, no timing, no new mechanic -- just
 * less room, which is the whole thesis of the lap.
 *
 * 4. THE SET PIECES.
 *
 * A loop through an advertising ring and a two-turn corkscrew down a spire.
 * Both geodesics, both read by the sim as dead straight, both therefore set
 * pieces and not corners. On this circuit that matters more than elsewhere:
 * they are the only two places on the lap where the player can stop working.
 */

/**
 * THE SHAPE: SQUARED OFF -- k=1 with a fourth harmonic, which flattens the
 * ellipse into four sides joined by four corners. That is what a city grid does
 * to a road, and it is deliberately unlike its neighbours: Meridian Deep is a
 * long trench with two hairpins, Halcyon Bay a three-lobed clover, Ashkar a
 * kidney. All four were originally drawn from one k1+k2+k3 parametrisation and
 * came out as versions of the same shape -- reported as "they all share the
 * same track map and layout".
 *
 * 2822m in plan, tightest 60m, self-clearance 205m. The four corners are what
 * make this a street circuit rather than a ring road.
 */
const H: Harm[] = [
  { k: 1, ax: 530, bx: 0, az: 0, bz: 355.1 },
  { k: 4, ax: 32, bx: 0, az: 0, bz: -32 },
]

const SPACING = 26
const RING = ring(H, SPACING)
const PLAN_LEN = RING.length * SPACING

/**
 * Beat map. ONE LOOP AND ONE SPIRAL -- the combo. The four circuits divide the
 * set pieces between them: Halcyon Bay takes the loops, Meridian Deep the
 * spiral, Ashkar all of it at once, and this one has a single example of each
 * because on a lap this narrow they are the only two places the player is
 * allowed to stop working.
 */
const BEATS = {
  maglevA: [0.03, 0.13] as [number, number],
  holoRing: 0.22,
  maglevB: [0.30, 0.38] as [number, number],
  squeeze: [0.42, 0.48] as [number, number],
  spire: [0.58, 0.72] as [number, number],
  maglevC: [0.80, 0.90] as [number, number],
  updraft: [0.93, 0.99] as [number, number],
}

const LOOP_R = 34
const LOOP_SIDE = 1
const LOOP_STAGGER = 52
const LOOP_BLEND = 0.05
const SPIRE_R = 26
const SPIRE_TURNS = 2
const SPIRE_W = 18

/** The city is stacked: the lap climbs a tier, crosses, and drops back. */
function elevation(u: number): number {
  return 23 * Math.sin(2 * Math.PI * (u - 0.10)) + 9 * Math.sin(4 * Math.PI * (u - 0.05)) + 46
}

/** The spire descent, snapped to ring-node boundaries -- see abyssal.ts. */
const SPIRE_SPAN = (() => {
  const n = RING.length
  let startIdx = RING.findIndex((p) => p.u >= BEATS.spire[0])
  if (startIdx < 0) startIdx = 0
  let endIdx = startIdx
  while (endIdx + 1 < n && RING[endIdx + 1].u < BEATS.spire[1]) endIdx++
  return { startIdx, endIdx, uFrom: RING[startIdx].u, uTo: RING[(endIdx + 1) % n].u || 1 }
})()

function build(): TrackNode[] {
  const out: TrackNode[] = []
  const n = RING.length

  for (let i = 0; i < n; i++) {
    const p = RING[i]
    const u = p.u
    const y = elevation(u)
    const fx = Math.sin(p.heading), fz = Math.cos(p.heading)
    const rx = Math.cos(p.heading), rz = -Math.sin(p.heading)

    // ---- THE HOLO RING. A staggered loop: it slides across the corridor
    // between going up and coming down, so its entry and its exit are not the
    // same road. See `staggeredLoop` in ring.ts.
    if (Math.abs(shortest(u - BEATS.holoRing)) < 0.5 / n) {
      const steps = loopSteps(LOOP_R)
      for (let sIdx = 0; sIdx <= steps; sIdx++) {
        const f = sIdx / steps
        const o = staggeredLoop(f, LOOP_R, LOOP_STAGGER, LOOP_SIDE)
        const th = 2 * Math.PI * f
        out.push({
          p: [
            r1(p.x + o.fwd * fx + o.lat * rx),
            r1(y + o.up),
            r1(p.z + o.fwd * fz + o.lat * rz),
          ],
          w: 17,
          up: [r3(-Math.sin(th) * fx), r3(Math.cos(th)), r3(-Math.sin(th) * fz)],
          surface: 'metal',
          tag: sIdx === 0 ? 'holoring'
            : sIdx === Math.round(steps / 2) ? 'holoring-apex'
            : undefined,
        })
      }
      continue
    }

    // ---- THE SPIRE DESCENT. Sampled along its own axis, radius ramped over
    // the outer 35% so the tube has mouths rather than a step.
    if (i >= SPIRE_SPAN.startIdx && i <= SPIRE_SPAN.endIdx) {
      if (i !== SPIRE_SPAN.startIdx) continue
      const span = SPIRE_SPAN.uTo - SPIRE_SPAN.uFrom
      const spanLen = span * PLAN_LEN
      const steps = Math.max(24, Math.round(spanLen / 13))
      for (let sIdx = 0; sIdx < steps; sIdx++) {
        const f = sIdx / steps
        const uu = SPIRE_SPAN.uFrom + span * f
        const rp = ringAt(uu)
        const srx = Math.cos(rp.heading), srz = -Math.sin(rp.heading)
        const th = 2 * Math.PI * SPIRE_TURNS * f
        const e = Math.max(0, Math.min(1, Math.min(f / 0.35, (1 - f) / 0.35)))
        const rEff = SPIRE_R * e * e * (3 - 2 * e)
        out.push({
          p: [
            r1(rp.x + rEff * Math.sin(th) * srx),
            r1(elevation(uu) + rEff - rEff * Math.cos(th)),
            r1(rp.z + rEff * Math.sin(th) * srz),
          ],
          w: SPIRE_W,
          up: [r3(-Math.sin(th) * srx), r3(Math.cos(th)), r3(-Math.sin(th) * srz)],
          surface: 'metal',
          boost: f > 0.44 && f < 0.60,
          tag: sIdx === 0 ? 'spire' : undefined,
        })
      }
      continue
    }

    const bias = loopBias(u, [{ at: BEATS.holoRing, side: LOOP_SIDE }], LOOP_STAGGER, LOOP_BLEND)
    const node: TrackNode = {
      p: [r1(p.x + bias * rx), r1(y), r1(p.z + bias * rz)],
      w: r1(width(u, p.k)),
    }
    node.surface = 'metal'
    // Everything that is not a set piece is a walled street. This only works
    // because contact no longer ends a drift: on a circuit this narrow, leaning
    // on a barrier through a corner is a line a driver CHOOSES.
    node.bounce = true

    const bank = clamp(-p.k * 1250, -14, 14)
    if (Math.abs(bank) > 0.6) node.bank = r1(bank)

    // MAGLEV. Three long runs; more boost road than any other circuit, and the
    // reason a lap this narrow is not simply slow.
    if (inSpan(u, BEATS.maglevA[0], BEATS.maglevA[1]) ||
        inSpan(u, BEATS.maglevB[0], BEATS.maglevB[1]) ||
        inSpan(u, BEATS.maglevC[0], BEATS.maglevC[1])) node.boost = true

    const gust = envelope(u, BEATS.updraft[0], BEATS.updraft[1], 0.34)
    if (gust > 0.02) node.wind = r1(11 * gust)

    if (Math.abs(u - BEATS.squeeze[0]) < 0.005) node.tag = 'squeeze'
    if (Math.abs(u - BEATS.maglevB[0]) < 0.005) node.tag = 'maglev'
    if (u === 0) node.tag = 'start'
    out.push(node)
  }
  return out
}

/**
 * NARROW -- this circuit's entire difficulty, and it is not softened. It still
 * only ADDS to a base, so the narrowest the road gets is a number somebody
 * chose rather than wherever three penalties happened to land.
 */
function width(u: number, k: number): number {
  let w = 17.5
  w += 2.5 * Math.min(1, Math.abs(k) * 95)
  if (inSpan(u, BEATS.maglevA[0], BEATS.maglevA[1])) w += 1.5
  if (inSpan(u, BEATS.maglevC[0], BEATS.maglevC[1])) w += 1.5
  // The Squeeze: the road runs between two towers and there is no more room.
  // Ramped, not stepped -- a width step puts a wall in front of a car.
  w -= 3.0 * envelope(u, BEATS.squeeze[0], BEATS.squeeze[1], 0.45)
  return clamp(w, 14, 21)
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

/** Shortest signed distance between two lap fractions, wrapping the seam. */
function shortest(d: number): number {
  if (d > 0.5) return d - 1
  if (d < -0.5) return d + 1
  return d
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const r1 = (v: number) => Math.round(v * 10) / 10
const r3 = (v: number) => Math.round(v * 1000) / 1000

export const NEONSPIRE: TrackDef = {
  id: 'neonspire',
  name: 'Zhen-9',
  skyTop: 0x080a1c,
  skyBottom: 0x2a1c4a,
  fogColor: 0x241a3e,
  fogDensity: 0.0062,
  sunColor: 0xc0a8ff,
  sunIntensity: 0.62,
  ambientColor: 0x2c2456,
  ambientIntensity: 1.05,
  // There is no sun. This is the glow off a cloud deck lit from below by the
  // city, so the key is high, weak and violet, and the fill carries the frame.
  sunDirection: [-0.28, 0.90, 0.33],
  palette: { a: 0x1a1830, b: 0x2f2a55, c: 0x6a4fd0, accent: 0xff3ea5 },
  nodes: build(),
  itemBoxRows: [
    { at: 0.09, count: 4, spread: 3.8 },
    { at: 0.28, count: 4, spread: 3.8 },
    { at: 0.56, count: 5, spread: 4.0 },
    { at: 0.76, count: 4, spread: 3.8 },
    { at: 0.94, count: 4, spread: 3.6 },
  ],
  chargeRuns: [
    { from: 0.04, to: 0.11, count: 7, lateral: -4 },
    { from: 0.26, to: 0.31, count: 6, lateral: 4 },
    { from: 0.54, to: 0.58, count: 5, lateral: 0 },
    { from: 0.74, to: 0.78, count: 5, lateral: -4 },
    { from: 0.82, to: 0.89, count: 7, lateral: 4 },
  ],
  laps: 3,
}
