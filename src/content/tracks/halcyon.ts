import type { TrackDef, TrackNode } from '../../sim/track'
import { ring, envelope, inSpan, type Harm } from './ring'

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

const H: Harm[] = [
  { k: 1, ax: 460, bx: 0, az: 0, bz: 377.2 },
  { k: 2, ax: 60, bx: 90, az: 63, bz: -42 },
  { k: 3, ax: 26, bx: 52, az: -31.2, bz: 15.6 },
]

const SPACING = 26
const RING = ring(H, SPACING)

const BEATS = {
  dunes: [0.12, 0.30] as [number, number],
  duneJump: 0.22,
  tideline: [0.34, 0.52] as [number, number],
  pier: 0.58,
  waterspout: [0.66, 0.78] as [number, number],
  breeze: [0.10, 0.32] as [number, number],
}

/** Low coastal relief: over the dunes, down to the flats, back up to the head. */
function elevation(u: number): number {
  return 11 * Math.sin(2 * Math.PI * (u - 0.02)) + 6 * Math.sin(4 * Math.PI * (u + 0.3)) + 14
}

const LOOP_R = 36
const LOOP_STEPS = 14
const SPOUT_R = 25
const SPOUT_TURNS = 2

function build(): TrackNode[] {
  const out: TrackNode[] = []
  const n = RING.length
  const [wFrom, wTo] = BEATS.waterspout

  for (let i = 0; i < n; i++) {
    const p = RING[i]
    const u = p.u
    const y = elevation(u)

    // ---- THE WATERSPOUT. Radius ramps in and out over the outer 35%: at a
    // constant radius a helix starts at its full angular rate and the road
    // steps sideways as fast as it travels, which Ashkar measured as a phantom
    // 22m corner at each mouth.
    if (inSpan(u, wFrom, wTo)) {
      const f = (u - wFrom) / (wTo - wFrom)
      const th = 2 * Math.PI * SPOUT_TURNS * f
      const rx = Math.cos(p.heading), rz = -Math.sin(p.heading)
      const e = Math.max(0, Math.min(1, Math.min(f / 0.35, (1 - f) / 0.35)))
      const rEff = SPOUT_R * e * e * (3 - 2 * e)
      out.push({
        p: [
          r1(p.x + rEff * Math.sin(th) * rx),
          r1(y + rEff - rEff * Math.cos(th)),
          r1(p.z + rEff * Math.sin(th) * rz),
        ],
        w: 18,
        up: [r3(-Math.sin(th) * rx), r3(Math.cos(th)), r3(-Math.sin(th) * rz)],
        surface: 'tarmac',
        boost: f > 0.40 && f < 0.62,
        tag: f === 0 ? 'waterspout' : undefined,
      })
      continue
    }

    const node: TrackNode = { p: [r1(p.x), r1(y), r1(p.z)], w: r1(width(u, p.k)) }

    // Dry sand over the dunes, wet packed sand along the tideline. Note what is
    // NOT here: no surface on this circuit drops below gravel's 0.70.
    if (inSpan(u, BEATS.dunes[0], BEATS.dunes[1])) node.surface = 'gravel'
    else node.surface = 'tarmac'

    const bank = clamp(-p.k * 900, -10, 10)
    if (Math.abs(bank) > 0.6) node.bank = r1(bank)

    const breeze = envelope(u, BEATS.breeze[0], BEATS.breeze[1], 0.32)
    if (breeze > 0.02) { node.wind = r1(10 * breeze); node.bounce = true }

    if (Math.abs(u - BEATS.duneJump) < 0.012) { node.ramp = 28; node.boost = true; node.tag = 'dune-jump' }
    // The beach continues past the tideline, so running wide there costs time
    // on soft sand rather than a respawn. This is the only `open` on the lap.
    if (inSpan(u, BEATS.tideline[0], BEATS.tideline[1])) node.open = true

    if (Math.abs(u - BEATS.tideline[0]) < 0.005) node.tag = 'tideline'
    if (Math.abs(u - BEATS.dunes[0]) < 0.005) node.tag = 'dunes'
    if (u === 0) node.tag = 'start'
    out.push(node)

    // ---- THE PIER. A loop around the head of the old pier. Advances one node
    // spacing over the revolution so it comes down on the next node rather than
    // folding back onto its own entry.
    if (Math.abs(u - BEATS.pier) < 0.5 / n) {
      const dx = Math.sin(p.heading), dz = Math.cos(p.heading)
      for (let s = 1; s < LOOP_STEPS; s++) {
        const th = (2 * Math.PI * s) / LOOP_STEPS
        const fwd = LOOP_R * Math.sin(th) + SPACING * (th / (2 * Math.PI))
        out.push({
          p: [r1(p.x + fwd * dx), r1(y + LOOP_R - LOOP_R * Math.cos(th)), r1(p.z + fwd * dz)],
          w: 18,
          up: [r3(-Math.sin(th) * dx), r3(Math.cos(th)), r3(-Math.sin(th) * dz)],
          surface: 'tarmac',
          tag: s === LOOP_STEPS / 2 ? 'pier-apex' : s === 1 ? 'pier' : undefined,
        })
      }
    }
  }
  return out
}

/** WIDE. See the note above: width is most of what makes this circuit Easy. */
function width(u: number, k: number): number {
  let w = 24 - 3 * Math.min(1, Math.abs(k) * 80)
  if (inSpan(u, BEATS.tideline[0], BEATS.tideline[1])) w += 2.5
  if (inSpan(u, BEATS.dunes[0], BEATS.dunes[1])) w -= 1.5
  return clamp(w, 18, 27)
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
