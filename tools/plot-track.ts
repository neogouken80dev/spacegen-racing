/**
 * Draw a track's baked centreline and edges to an SVG, and print its curvature
 * profile.
 *
 * This exists because a track change starts as a PICTURE -- "make these bends
 * more gradual" -- and the node table is a list of coordinates. Plotting the
 * baked samples rather than the nodes is the point: the nodes are control
 * points and the spline between them is what the car actually drives, so a
 * radius read off node spacing is not the radius anybody corners at.
 *
 * THE PROJECTION IS THE MINIMAP'S, NOT WORLD X/Z, and that is load-bearing.
 * hud.ts bakeMap and frontend.ts buildPreview both rotate the lap so the start
 * straight runs up the frame and negate u, because with forward = (sin yaw,
 * 0, cos yaw) screen-right is world -X. Plotting raw world axes gives a
 * mirrored picture, which is exactly the wrong thing to hand somebody who is
 * comparing it against a screenshot of the map.
 *
 *   npx tsx tools/plot-track.ts rustfall out.svg
 */
import { writeFileSync } from 'node:fs'
import { Track } from '../src/sim/track'
import { TRACKS } from '../src/content/tracks'

const id = process.argv[2] ?? 'rustfall'
const out = process.argv[3] ?? `/tmp/${id}.svg`
const def = TRACKS.find((t) => t.id === id)
if (!def) { console.error(`no track "${id}"`); process.exit(1) }
const track = new Track(def)
const S = track.samples
const RES = track.length / S.length // metres per sample

// --- curvature -------------------------------------------------------------
// THE FIRST INSTRUMENT HERE WAS WRONG AND IT MATTERED.
//
// Menger curvature over three points 12m apart is the obvious measure and it
// is unusable at these radii. The baked centreline carries ~0.1m of ripple
// (the resampler walks a Catmull-Rom, not a circle) and the sagitta of a 24m
// chord on a 70m radius is only 1.0m, so a tenth of a metre of noise in the
// middle point moves the circumradius ten percent. Measured against a
// centreline whose every sample sat 69.9-70.0m from a known centre, Menger
// reported 55-75m and called a true 70m arc a 55m corner. A least-squares
// circle fit is no better at the other end: on a nearly straight window it is
// ill-conditioned and returns 12m radii for a dead straight.
//
// SWEPT ANGLE IS THE HONEST MEASURE: radius = window length / heading change
// across it. It is stable against ripple, it degrades gracefully toward
// infinity on a straight, and it is the same quantity Track.curvatureAt feeds
// the AI when it picks a corner speed -- so it is the radius the game itself
// believes in. The window is 30m: wide enough to average the noise, short
// enough that the two halves of a genuine S do not cancel.
const WIN = 30
const radii = S.map((_, i) => {
  const k = Math.abs(track.curvatureAt(i * RES - WIN / 2, WIN))
  return k < 1 / 4000 ? 4000 : 1 / k
})

// --- where the tight bits are ----------------------------------------------
// Reported as contiguous runs under a threshold, because one tight sample is
// noise and forty in a row is a corner.
const TIGHT = Number(process.env.TIGHT ?? 90)
const runs: { from: number; to: number; min: number; s0: number; s1: number }[] = []
let cur: typeof runs[0] | null = null
for (let i = 0; i < radii.length; i++) {
  if (radii[i] < TIGHT) {
    if (!cur) cur = { from: i, to: i, min: radii[i], s0: i * RES, s1: i * RES }
    cur.to = i; cur.s1 = i * RES
    if (radii[i] < cur.min) cur.min = radii[i]
  } else if (cur) { runs.push(cur); cur = null }
}
if (cur) runs.push(cur)

const near = (i: number) => {
  let best = '', bd = 1e9
  for (const n of def.nodes) {
    if (!n.tag) continue
    const d = Math.hypot(n.p[0] - S[i].pos.x, n.p[2] - S[i].pos.z)
    if (d < bd) { bd = d; best = n.tag }
  }
  return `${best} (${bd.toFixed(0)}m)`
}

console.log(`${def.name} (${id})  length ${track.length.toFixed(1)}m  ${S.length} samples`)
console.log(`\ncorners under R=${TIGHT}m:`)
for (const r of runs) {
  const mid = Math.round((r.from + r.to) / 2)
  console.log(`  s ${r.s0.toFixed(0).padStart(5)}..${r.s1.toFixed(0).padStart(5)}m  ` +
    `len ${(r.s1 - r.s0).toFixed(0).padStart(4)}m  minR ${r.min.toFixed(1).padStart(6)}m  near ${near(mid)}`)
}
const sorted = [...radii].sort((a, b) => a - b)
const pc = (f: number) => sorted[Math.floor(sorted.length * f)].toFixed(0)
console.log(`\nradius percentiles: p1 ${pc(0.01)}m  p5 ${pc(0.05)}m  p25 ${pc(0.25)}m  median ${pc(0.5)}m`)

// --- the picture -----------------------------------------------------------
// Same rotation as hud.ts bakeMap / frontend.ts buildPreview.
const t0 = S[0].tangent
const ang = Math.atan2(-t0.x, t0.z)
const CA = Math.cos(ang), SA = Math.sin(ang)
const mu = (x: number, z: number) => -(x * CA + z * SA)
const mv = (x: number, z: number) => -(-x * SA + z * CA)

let minU = 1e9, maxU = -1e9, minV = 1e9, maxV = -1e9
for (const s of S) {
  const hw = s.width / 2 + 4
  const u = mu(s.pos.x, s.pos.z), v = mv(s.pos.x, s.pos.z)
  minU = Math.min(minU, u - hw); maxU = Math.max(maxU, u + hw)
  minV = Math.min(minV, v - hw); maxV = Math.max(maxV, v + hw)
}
const PAD = 34, W = 900
const scale = (W - PAD * 2) / (maxU - minU)
const H = Math.round((maxV - minV) * scale + PAD * 2)
const px = (x: number, z: number) => PAD + (mu(x, z) - minU) * scale
const py = (x: number, z: number) => PAD + (mv(x, z) - minV) * scale

const edge = (side: number) => S.map((s) => {
  const hw = (s.width / 2) * side
  const ex = s.pos.x + s.right.x * hw, ez = s.pos.z + s.right.z * hw
  return `${px(ex, ez).toFixed(1)},${py(ex, ez).toFixed(1)}`
}).join(' ')

const band = S.map((s, i) => {
  const r = radii[i]
  const t = Math.max(0, Math.min(1, (160 - r) / 130))
  const col = `rgb(${Math.round(90 + 165 * t)},${Math.round(200 - 150 * t)},${Math.round(220 - 180 * t)})`
  return `<circle cx="${px(s.pos.x, s.pos.z).toFixed(1)}" cy="${py(s.pos.x, s.pos.z).toFixed(1)}" r="2" fill="${col}"/>`
}).join('')

const tags = def.nodes.filter((n) => n.tag).map((n) =>
  `<circle cx="${px(n.p[0], n.p[2]).toFixed(1)}" cy="${py(n.p[0], n.p[2]).toFixed(1)}" r="3.5" fill="#ffd23f"/>` +
  `<text x="${(px(n.p[0], n.p[2]) + 6).toFixed(1)}" y="${(py(n.p[0], n.p[2]) - 5).toFixed(1)}" font-size="11" fill="#ffd23f">${n.tag}</text>`
).join('')

writeFileSync(out, `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#0a1420"/>
<polygon points="${edge(1)}" fill="none" stroke="#5a7a95" stroke-width="1.4"/>
<polygon points="${edge(-1)}" fill="none" stroke="#5a7a95" stroke-width="1.4"/>
${band}${tags}
<text x="${PAD}" y="${PAD - 12}" font-size="14" fill="#9fb6cc">${def.name} — map orientation; red = tight, blue = open</text>
</svg>`)
console.log(`\nwrote ${out}`)
