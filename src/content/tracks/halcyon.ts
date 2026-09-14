import type { TrackDef, TrackNode } from '../../sim/track'
import { ring, envelope, inSpan, staggeredLoop, loopBias, loopSteps, type Harm } from './ring'

/**
 * HALCYON BAY — Tidal Coast.
 *
 * The seventh circuit, and the one the roster was actually missing.
 *
 * Difficulty: Easy, and that is a deliberate structural choice rather than a
 * gentle mood. Count what shipped before it: Elkarim Hard, Frosthelm Hard,
 * Centurion Prime Hard, Ashkar Medium, Meridian Deep Hard. Namaresh is the only
 * Easy circuit in the game, which means a new player has exactly one place to
 * learn to drift and no second opinion about what a corner feels like. This is
 * the second opinion.
 *
 * ---------------------------------------------------------------------------
 * 1. WHAT "EASY" IS BUILT OUT OF HERE.
 *
 * Not fewer corners, and not a shorter lap: 3142m with a 50m tightest corner,
 * which is tighter than Centurion Prime's. Easy is made of three things:
 *
 *   - WIDTH. The road runs 23-26m half-width across the tideline, against
 *     17-21 on every other circuit. A wide road forgives a bad entry, which is
 *     the single most common way a new player loses a lap.
 *   - NO SURFACE THAT REMOVES GRIP. Dry sand is gravel (0.70) and wet packed
 *     sand is tarmac (1.0). There is no ice, no biofilm, no oil anywhere. The
 *     lap can be driven badly and survived.
 *   - CONSEQUENCE-FREE EDGES. Where the road is unbarriered it is because the
 *     beach continues -- running wide costs time on sand, not a respawn. The
 *     only bounce walls are the dune fences, and they are there to catch you.
 *
 * What it keeps is SPEED. It is the fastest circuit in the game by design: the
 * tideline is a genuinely long flat-out stretch, and being fast is the thing a
 * beginner enjoys before they can drift.
 *
 * 2. THE SET PIECES, AND THE SAME ARITHMETIC AS EVERY OTHER TRACK.
 *
 * The Pier loop and the Waterspout corkscrew are geodesics -- curvature vector
 * along the surface normal, so `curvatureAt` reads them as dead straight and
 * nothing brakes or drifts through them. Set pieces. On a beginner's circuit
 * that is a feature: they are the two most spectacular things on the lap and
 * neither of them can spit a new player off.
 *
 * 3. THE SEA BREEZE.
 *
 * Moderate (10, against Ashkar's 13 and Meridian Deep's 15), across the dunes,
 * ramped over 16% of the lap, and the verge there is FENCED. Ashkar measured
 * what a crosswind over open road does -- 16.3 respawns a race -- and an Easy
 * circuit is the last place to re-learn it.
 */

/**
 * THE SHAPE: a CLOVER -- k=1 with a strong third harmonic, so the lap runs
 * three lobes with no long straight anywhere. That is the right plan for a
 * coast road, which follows headlands rather than cutting across them, and it
 * is deliberately unlike its neighbours: Meridian Deep is a long trench with
 * two hairpins, Zhen-9 a squared-off block, Ashkar a kidney. All four were
 * originally drawn from one k1+k2+k3 parametrisation and came out as versions
 * of the same shape -- reported as "they all share the same track map".
 *
 * 2654m in plan, tightest 81m, self-clearance 196m.
 */
const H: Harm[] = [
  { k: 1, ax: 380, bx: 0, az: 0, bz: 315.4 },
  { k: 3, ax: 100, bx: 30, az: -75, bz: 35 },
]

const SPACING = 26
const RING = ring(H, SPACING)

/**
 * Beat map. TWO LOOPS AND NO SPIRAL, by design: the four circuits divide the
 * set pieces between them rather than each carrying one of everything. Halcyon
 * Bay is the LOOP track, Meridian Deep the spiral track, Zhen-9 one of each.
 *
 * Two loops is also the right count for an Easy circuit -- they are the most
 * spectacular thing on the lap and neither can spit a new player off, so they
 * are where a beginner gets to feel fast for free.
 */
const BEATS = {
  dunes: [0.12, 0.30] as [number, number],
  duneJump: 0.21,
  tideline: [0.36, 0.54] as [number, number],
  loops: [
    { at: 0.62, r: 34, side: +1, tag: 'pier' },
    { at: 0.82, r: 40, side: -1, tag: 'arch' },
  ],
  breeze: [0.10, 0.32] as [number, number],
}

const LOOP_STAGGER = 60
const LOOP_BLEND = 0.055

/** Low coastal relief. Floor of 6m: nothing sits below world zero. */
function elevation(u: number): number {
  return 12 * Math.sin(2 * Math.PI * (u - 0.02)) + 7 * Math.sin(4 * Math.PI * (u + 0.3)) + 22
}

function build(): TrackNode[] {
  const out: TrackNode[] = []
  const n = RING.length

  for (let i = 0; i < n; i++) {
    const p = RING[i]
    const u = p.u
    const y = elevation(u)
    const fx = Math.sin(p.heading), fz = Math.cos(p.heading)
    const rx = Math.cos(p.heading), rz = -Math.sin(p.heading)

    // ---- THE LOOPS. Each hangs off one ring node, consumes no ring distance,
    // and slides LOOP_STAGGER metres across the corridor between going up and
    // coming down -- see `staggeredLoop` in ring.ts. Without that crossing a
    // loop returns to its own entry point and the approach and the exit are the
    // same piece of ground, which is what "it launches into itself" is.
    const li = BEATS.loops.findIndex((L) => Math.abs(shortest(u - L.at)) < 0.5 / n)
    if (li >= 0) {
      const L = BEATS.loops[li]
      const steps = loopSteps(L.r)
      // Inclusive of f=1: just under 1 the road is still behind its exit
      // station, and stopping short leaves a long jump to the next ring node.
      for (let sIdx = 0; sIdx <= steps; sIdx++) {
        const f = sIdx / steps
        const o = staggeredLoop(f, L.r, LOOP_STAGGER, L.side)
        const th = 2 * Math.PI * f
        out.push({
          p: [
            r1(p.x + o.fwd * fx + o.lat * rx),
            r1(y + o.up),
            r1(p.z + o.fwd * fz + o.lat * rz),
          ],
          w: 19,
          up: [r3(-Math.sin(th) * fx), r3(Math.cos(th)), r3(-Math.sin(th) * fz)],
          surface: 'tarmac',
          tag: sIdx === 0 ? L.tag
            : sIdx === Math.round(steps / 2) ? `${L.tag}-apex`
            : undefined,
        })
      }
      continue
    }

    const bias = loopBias(u, BEATS.loops, LOOP_STAGGER, LOOP_BLEND)
    const node: TrackNode = {
      p: [r1(p.x + bias * rx), r1(y), r1(p.z + bias * rz)],
      w: r1(width(u, p.k)),
    }

    // Dry sand over the dunes, wet packed sand along the tideline. Note what is
    // NOT here: no surface on this circuit drops below gravel's 0.70.
    node.surface = inSpan(u, BEATS.dunes[0], BEATS.dunes[1]) ? 'gravel' : 'tarmac'

    const bank = clamp(-p.k * 900, -10, 10)
    if (Math.abs(bank) > 0.6) node.bank = r1(bank)

    const breeze = envelope(u, BEATS.breeze[0], BEATS.breeze[1], 0.32)
    if (breeze > 0.02) { node.wind = r1(10 * breeze); node.bounce = true }

    if (Math.abs(u - BEATS.duneJump) < 0.012) { node.ramp = 28; node.boost = true; node.tag = 'dune-jump' }
    // The beach continues past the tideline, so running wide there costs time on
    // soft sand rather than a respawn. This is the only `open` on the lap.
    if (inSpan(u, BEATS.tideline[0], BEATS.tideline[1])) node.open = true

    if (Math.abs(u - BEATS.tideline[0]) < 0.005) node.tag = 'tideline'
    if (Math.abs(u - BEATS.dunes[0]) < 0.005) node.tag = 'dunes'
    if (u === 0) node.tag = 'start'
    out.push(node)
  }
  return out
}

/**
 * WIDE, and it only ever ADDS. Width is most of what makes this circuit Easy,
 * and a width function built out of penalties has no floor you can reason about
 * -- Ashkar stacked four of them into one 15.5m bend before this rule.
 */
function width(u: number, k: number): number {
  let w = 23
  w += 2.5 * Math.min(1, Math.abs(k) * 80)
  if (inSpan(u, BEATS.tideline[0], BEATS.tideline[1])) w += 2.5
  return clamp(w, 21, 28)
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

export const HALCYON: TrackDef = {
  id: 'halcyon',
  name: 'Halcyon Bay',
  skyTop: 0x1b3b6b,
  skyBottom: 0xd8a878,
  fogColor: 0xa9bcc0,
  fogDensity: 0.0011,
  sunColor: 0xffd9a0,
  sunIntensity: 1.12,
  ambientColor: 0x5d7fa8,
  ambientIntensity: 0.9,
  // Low and nearly along the start straight: a sun ON the horizon, which is the
  // whole look, and long shadows raking across the road.
  sunDirection: [0.86, 0.12, -0.50],
  palette: { a: 0xc9a97e, b: 0x4f93a8, c: 0xf0d2a4, accent: 0xffb45e },
  nodes: build(),
  itemBoxRows: [
    { at: 0.07, count: 5, spread: 4.6 },
    { at: 0.26, count: 5, spread: 4.4 },
    { at: 0.44, count: 6, spread: 4.8 },
    { at: 0.62, count: 4, spread: 4.0 },
    { at: 0.86, count: 5, spread: 4.4 },
  ],
  chargeRuns: [
    { from: 0.02, to: 0.08, count: 6, lateral: -6 },
    { from: 0.18, to: 0.24, count: 6, lateral: 5 },
    { from: 0.38, to: 0.46, count: 8, lateral: 0 },
    { from: 0.54, to: 0.58, count: 5, lateral: -5 },
    { from: 0.82, to: 0.90, count: 7, lateral: 5 },
  ],
  laps: 3,
}
