/**
 * DOES THE PATH BUILDER ACTUALLY CLOSE A LAP, AND DOES IT KILL THE JUNCTION
 * SPIKE IT CLAIMS TO KILL?
 *
 * `content/tracks/path.ts` makes two promises. Both are testable and neither
 * should be taken on trust, because the failure mode of the second one is
 * invisible: an exact 70m circle entered off a 100m straight measured in the
 * FIFTIES on Aetherion, and nothing about the authored numbers looked wrong.
 *
 *   1. closure: last node meets first, in position and in heading.
 *   2. matched chords across joins, so `curvatureAt` reads a constant-radius
 *      arc as constant radius all the way through -- including the first and
 *      last few metres, where the straight either side is pulling on the
 *      Catmull-Rom tangent.
 *
 * The control is the SAME oval authored with mismatched spacing, which must
 * show the spike. A probe that only ever runs the good case proves nothing.
 *
 *   npx tsx tools/probe-path.ts
 */
import { Path } from '../src/content/tracks/path'
import { Track } from '../src/sim/track'
import type { TrackDef } from '../src/sim/track'

const R = 70
const STRAIGHT = 260

function oval(spacingStraight: number, spacingArc: number) {
  const p = new Path({
    start: [0, 0, 0], heading: 0, spacing: 26,
    defaults: { w: 20, surface: 'tarmac' },
  })
  p.straight(STRAIGHT, { spacing: spacingStraight })
  p.turn(R, 180, { spacing: spacingArc, tag: 'arc-a' })
  p.straight(STRAIGHT, { spacing: spacingStraight })
  p.turn(R, 180, { spacing: spacingArc, tag: 'arc-b' })
  return p
}

function defOf(nodes: ReturnType<Path['nodes']>): TrackDef {
  return {
    id: 'probe-path', name: 'Probe Path',
    skyTop: 0x101828, skyBottom: 0x2a3550, fogColor: 0x2a3550, fogDensity: 0.003,
    sunColor: 0xffffff, sunIntensity: 1, ambientColor: 0x404860, ambientIntensity: 0.6,
    sunDirection: [0.4, 0.8, 0.3],
    palette: { a: 0x666666, b: 0x888888, c: 0xaaaaaa, accent: 0x44ccff },
    nodes, itemBoxRows: [], chargeRuns: [], laps: 2,
  }
}

/**
 * Radius the sim reads across the STEADY MIDDLE of the first 180-degree arc.
 *
 * Not the whole arc, and the reason is a correction to this probe's first
 * version, which failed a working builder at 250%. A Catmull-Rom cannot step
 * its curvature: entering a circle off a straight ALWAYS blends over a few
 * samples, so the ends of the arc legitimately read as a large radius and
 * including them measures the blend rather than the arc. The junction spike
 * this is looking for is not "the ends are soft" -- it is the MIDDLE of a
 * constant-radius arc failing to read as constant.
 *
 * So: find the contiguous run the sim considers genuinely curved, drop the
 * outer 20% at each end, and report what is left.
 */
function arcRadii(t: Track): { min: number; max: number; mean: number; n: number } {
  const n = t.samples.length
  const k = (i: number) => Math.abs(t.curvatureAt(i * 1.5, 20))
  let i0 = -1
  for (let i = 4; i < n; i++) if (k(i) > 0.006) { i0 = i; break }
  let i1 = i0
  while (i1 + 1 < n && k(i1 + 1) > 0.006) i1++
  const span = i1 - i0
  const a = i0 + Math.round(span * 0.2), b = i1 - Math.round(span * 0.2)
  const radii: number[] = []
  for (let i = a; i <= b; i++) radii.push(1 / k(i))
  const mean = radii.reduce((x, y) => x + y, 0) / Math.max(1, radii.length)
  return { min: Math.min(...radii), max: Math.max(...radii), mean, n: radii.length }
}

console.log(`an oval: two ${STRAIGHT}m straights and two ${R}m half-circles\n`)

const good = oval(26, 26)
const gc = good.closure()
console.log(`MATCHED CHORDS (26m throughout)`)
console.log(`  closure: gap ${gc.gap.toFixed(3)}m   heading ${gc.turn.toFixed(3)} deg`)
const gt = new Track(defOf(good.nodes()))
const gr = arcRadii(gt)
console.log(`  length ${gt.length.toFixed(0)}m, ${good.nodes().length} nodes`)
console.log(`  arc radius as the sim reads it: min ${gr.min.toFixed(1)}  mean ${gr.mean.toFixed(1)}  max ${gr.max.toFixed(1)}  (authored ${R})`)

// THE CONTROL. Author the identical oval with a 90m chord on the straights and
// a 12m chord on the arcs -- the exact shape that bit Aetherion.
const bad = oval(90, 12)
const bt = new Track(defOf(bad.nodes()))
const br = arcRadii(bt)
console.log(`\nMISMATCHED CHORDS (90m straights into 12m arcs) -- the control`)
console.log(`  arc radius as the sim reads it: min ${br.min.toFixed(1)}  mean ${br.mean.toFixed(1)}  max ${br.max.toFixed(1)}  (authored ${R})`)

const err = (r: { min: number; max: number }) => Math.max(Math.abs(r.max - R), Math.abs(r.min - R)) / R
const gErr = err(gr), bErr = err(br)
console.log(`\nworst radius error: matched ${(100 * gErr).toFixed(1)}%   mismatched ${(100 * bErr).toFixed(1)}%`)

const ok = gc.gap < 0.5 && gc.turn < 0.5 && gErr < 0.08 && bErr > gErr * 1.5
console.log(ok ? '\nPATH BUILDER OK' : '\nPATH BUILDER FAILED')
if (!ok) {
  if (gc.gap >= 0.5 || gc.turn >= 0.5) console.log(`  the lap does not close`)
  if (gErr >= 0.08) console.log(`  matched chords still distort the arc by ${(100 * gErr).toFixed(1)}%`)
  if (bErr <= gErr * 1.5) console.log(`  the control did not misbehave -- this probe is not measuring anything`)
}
process.exit(ok ? 0 : 1)
