/**
 * DOES THE ROAD EVER PASS THROUGH ITSELF?
 *
 * Reported on Ashkar: "there is a section that has the loop de-loop, but it
 * launches into itself". That is a real geometric defect and nothing in the
 * repo could see it. Every existing gate measures the road as a 1-D thing --
 * curvature, width, lap time, respawns -- and a loop whose entry and exit
 * occupy the same ground is perfectly well-behaved on all of them. It is only
 * wrong in 3-space.
 *
 * So: for every pair of samples that are FAR APART ALONG THE LAP but CLOSE
 * TOGETHER IN SPACE, ask whether there is room for two roads there. Two decks
 * stacked vertically are fine and intended -- that is what a loop is -- so the
 * test is on the plane of each deck: if two samples are within a road-width of
 * each other AND their surfaces are within a car's height, they are the same
 * piece of ground and one of them should not be there.
 *
 *   npx tsx tools/probe-selfclear.ts --track=emberfall
 */
import { Track } from '../src/sim/track'
import { TRACKS_BY_ID } from '../src/content/tracks'

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const id = arg('track', 'emberfall')
const def = TRACKS_BY_ID[id]
if (!def) { console.log(`no track ${id}`); process.exit(1) }
const t = new Track(def)
const S = t.samples
const N = S.length

/** Lap distance between two samples, the short way round. */
function apart(i: number, j: number): number {
  const d = Math.abs(i - j) * 1.5
  return Math.min(d, t.length - d)
}

/**
 * THE FIRST VERSION OF THIS FILE MEASURED THE WRONG THING, and it is worth
 * writing down because the mistake is the same shape as the bug it was hunting.
 *
 * It compared PLAN distance against the sum of the two half-widths. That is
 * only valid where the road is flat: through a corkscrew the ribbon is ROLLED,
 * so its width extends vertically rather than across the map, and two sections
 * facing each other across a 52m barrel were reported as overlapping by 17m
 * when they are nowhere near each other. It failed a working corkscrew in three
 * places.
 *
 * So the test is on the actual SURFACE. Each sample is expanded into points
 * across its ribbon using its own `right` vector -- which is what carries the
 * roll -- and the question is the true 3-D distance between those point sets.
 * Orientation then takes care of itself.
 */
const ACROSS = [-1, -0.5, 0, 0.5, 1]
/**
 * How close two pieces of road may come before they are the same ground.
 *
 * 2.0m, NOT "enough room to drive between". Elkarim has two entirely different
 * parts of its lap -- 1290m apart along the circuit -- running alongside each
 * other with 3.9m between their edges, which is an ordinary circuit layout with
 * a barrier down the middle and nothing anyone drives through. Gating at 4.5m
 * failed that, and a gate that fails correct shipped tracks gets switched off.
 *
 * The defect this exists to catch is surfaces INTERPENETRATING: the staggered
 * loops measure 9.1m, and the same loops with their stagger removed measure
 * 0.1m. There is no ambiguity to split at 2m.
 */
const CLEARANCE = 2.0
/** Samples closer than this along the lap are neighbours, not a conflict. */
const IGNORE_ALONG = 70
/** Every second sample: 3m of resolution is finer than the defect being sought. */
const STRIDE = 2

const pts: number[][] = []
for (let i = 0; i < N; i += STRIDE) {
  const s = S[i]
  const row: number[] = []
  for (const a of ACROSS) {
    row.push(s.pos.x + s.right.x * s.width * a,
      s.pos.y + s.right.y * s.width * a,
      s.pos.z + s.right.z * s.width * a)
  }
  pts.push(row)
}

let worst = { gap: Infinity, i: -1, j: -1, along: 0 }
const hits: { i: number; j: number; gap: number }[] = []

for (let a = 0; a < pts.length; a++) {
  const ia = a * STRIDE
  for (let b = a + 1; b < pts.length; b++) {
    const ib = b * STRIDE
    const along = apart(ia, ib)
    if (along < IGNORE_ALONG) continue
    // Cheap reject on centre-to-centre before the 25-point inner loop.
    const cdx = pts[a][6] - pts[b][6], cdy = pts[a][7] - pts[b][7], cdz = pts[a][8] - pts[b][8]
    const centre = Math.hypot(cdx, cdy, cdz)
    if (centre > S[ia].width + S[ib].width + CLEARANCE + 6) continue
    let best = Infinity
    for (let u = 0; u < 5; u++) {
      for (let v = 0; v < 5; v++) {
        const dx = pts[a][u * 3] - pts[b][v * 3]
        const dy = pts[a][u * 3 + 1] - pts[b][v * 3 + 1]
        const dz = pts[a][u * 3 + 2] - pts[b][v * 3 + 2]
        const d = Math.hypot(dx, dy, dz)
        if (d < best) best = d
      }
    }
    if (best < worst.gap) worst = { gap: best, i: ia, j: ib, along }
    if (best < CLEARANCE) hits.push({ i: ia, j: ib, gap: best })
  }
}

console.log(`${def.name} (${id}) -- ${t.length.toFixed(0)}m, ${N} samples`)
console.log(`closest the road ever comes to another part of itself: ${worst.gap.toFixed(1)}m`)
if (worst.i >= 0) {
  console.log(`  between s=${(worst.i * 1.5).toFixed(0)}m and s=${(worst.j * 1.5).toFixed(0)}m` +
    `  (${worst.along.toFixed(0)}m apart along the lap)`)
}
console.log(`  a car needs ${CLEARANCE}m`)

if (hits.length) {
  const regions: { from: number; to: number; worst: number }[] = []
  for (const h of hits.sort((a, b) => a.i - b.i)) {
    const last = regions[regions.length - 1]
    if (last && h.i * 1.5 - last.to < 40) { last.to = h.i * 1.5; last.worst = Math.min(last.worst, h.gap) }
    else regions.push({ from: h.i * 1.5, to: h.i * 1.5, worst: h.gap })
  }
  console.log(`\nFAILED: the road runs into itself in ${regions.length} place(s)`)
  for (const r of regions) {
    console.log(`  s=${r.from.toFixed(0)}-${r.to.toFixed(0)}m, down to ${r.worst.toFixed(1)}m`)
  }
  process.exit(1)
}
console.log('\nNO SELF-OVERLAP -- every stretch of road has ground of its own')
