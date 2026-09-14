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

const H: Harm[] = [
  { k: 1, ax: 520, bx: 0, az: 0, bz: 332.8 },
  { k: 2, ax: 90, bx: 60, az: 42, bz: -63 },
  { k: 3, ax: 52, bx: 0, az: 0, bz: 31.2 },
]

const SPACING = 26
const RING = ring(H, SPACING)

const BEATS = {
  bloomA: [0.13, 0.21] as [number, number],
  trenchJump: 0.30,
  bloomB: [0.36, 0.45] as [number, number],
  cathedral: 0.53,
  descent: [0.62, 0.74] as [number, number],
  breach: [0.79, 0.90] as [number, number],
  bloomC: [0.92, 0.98] as [number, number],
}

/** The trench floor: down into the deep and back up to the shelf. */
function elevation(u: number): number {
  return 26 * Math.sin(2 * Math.PI * (u - 0.18)) + 7 * Math.sin(6 * Math.PI * u) + 30
}

const LOOP_R = 37
const LOOP_STEPS = 14
const DESC_R = 24
const DESC_TURNS = 2

function build(): TrackNode[] {
  const out: TrackNode[] = []
  const n = RING.length
  const [dFrom, dTo] = BEATS.descent

  for (let i = 0; i < n; i++) {
    const p = RING[i]
    const u = p.u
    const y = elevation(u)

    // ---- THE DESCENT. The ring supplies the axis; the road spirals inside the
    // tube. The radius ramps in and out over the outer 35% at each end -- at a
    // constant radius the spiral starts at its full angular rate and the road
    // steps sideways as fast as it moves forward, which Ashkar measured as a
    // phantom 22m corner at each mouth that nothing in the roster could hold.
    if (inSpan(u, dFrom, dTo)) {
      const f = (u - dFrom) / (dTo - dFrom)
      const th = 2 * Math.PI * DESC_TURNS * f
      const rx = Math.cos(p.heading), rz = -Math.sin(p.heading)
      const e = Math.max(0, Math.min(1, Math.min(f / 0.35, (1 - f) / 0.35)))
      const rEff = DESC_R * e * e * (3 - 2 * e)
      out.push({
        p: [
          r1(p.x + rEff * Math.sin(th) * rx),
          r1(y + rEff - rEff * Math.cos(th)),
          r1(p.z + rEff * Math.sin(th) * rz),
        ],
        w: 16.5,
        up: [r3(-Math.sin(th) * rx), r3(Math.cos(th)), r3(-Math.sin(th) * rz)],
        surface: 'metal',
        boost: f > 0.44 && f < 0.60,
        tag: f === 0 ? 'descent' : undefined,
      })
      continue
    }

    const node: TrackNode = { p: [r1(p.x), r1(y), r1(p.z)], w: r1(width(u, p.k)) }

    // THE BLOOMS. Ramped, never stepped: `surface` does NOT interpolate between
    // nodes (it snaps at the midpoint), so a bloom is made survivable by being
    // ENTERED where the corner is already slow, not by fading the coefficient.
    // The envelope below decides how much of the patch is biofilm and how much
    // is the wet metal either side of it.
    const bloom = Math.max(
      envelope(u, BEATS.bloomA[0], BEATS.bloomA[1], 0.34),
      envelope(u, BEATS.bloomB[0], BEATS.bloomB[1], 0.34),
      envelope(u, BEATS.bloomC[0], BEATS.bloomC[1], 0.40),
    )
    node.surface = bloom > 0.55 ? 'oil' : 'metal'

    const bank = clamp(-p.k * 1050, -12, 12)
    if (Math.abs(bank) > 0.6) node.bank = r1(bank)

    const cur = envelope(u, BEATS.breach[0], BEATS.breach[1], 0.30)
    if (cur > 0.02) { node.wind = r1(15 * cur); node.bounce = true }

    if (Math.abs(u - BEATS.trenchJump) < 0.012) { node.ramp = 29; node.boost = true; node.tag = 'trench-jump' }
    if (inSpan(u, BEATS.trenchJump + 0.012, BEATS.trenchJump + 0.042)) node.open = true

    if (Math.abs(u - BEATS.bloomA[0]) < 0.005) node.tag = 'bloom'
    if (Math.abs(u - BEATS.breach[0]) < 0.005) node.tag = 'breach'
    if (u === 0) node.tag = 'start'
    out.push(node)

    // ---- THE CATHEDRAL. A vertical loop through a dome in the tube run. It
    // ADVANCES by one node spacing over the revolution rather than returning to
    // its own entry point, because a pure loop's exit lands BEHIND its entry and
    // the road then folds forward to the next node -- measured on Ashkar as a
    // 43m chord and a corner that was not there.
    if (Math.abs(u - BEATS.cathedral) < 0.5 / n) {
      const dx = Math.sin(p.heading), dz = Math.cos(p.heading)
      for (let s = 1; s < LOOP_STEPS; s++) {
        const th = (2 * Math.PI * s) / LOOP_STEPS
        const fwd = LOOP_R * Math.sin(th) + SPACING * (th / (2 * Math.PI))
        out.push({
          p: [r1(p.x + fwd * dx), r1(y + LOOP_R - LOOP_R * Math.cos(th)), r1(p.z + fwd * dz)],
          w: 17,
          up: [r3(-Math.sin(th) * dx), r3(Math.cos(th)), r3(-Math.sin(th) * dz)],
          surface: 'metal',
          tag: s === LOOP_STEPS / 2 ? 'cathedral-apex' : s === 1 ? 'cathedral' : undefined,
        })
      }
    }
  }
  return out
}

function width(u: number, k: number): number {
  let w = 19.5 - 3.5 * Math.min(1, Math.abs(k) * 90)
  if (inSpan(u, BEATS.breach[0], BEATS.breach[1])) w -= 1.5
  if (inSpan(u, 0.95, 0.06)) w += 2.5
  return clamp(w, 14.5, 23)
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
