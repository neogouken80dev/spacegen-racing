/**
 * SEARCH COEFFICIENT SPACE FOR A CIRCUIT SHAPE.
 *
 * `content/tracks/ring.ts` guarantees a lap that closes, and pays for it by
 * taking away the ability to draw a corner where you want one: you get the
 * radii the harmonic coefficients imply. So the workflow is inverted -- search
 * for a shape whose LENGTH and RADIUS RANGE are right, then read the beats off
 * the shape you got.
 *
 * The radius band matters more than the length. Too tight and nothing in the
 * roster can hold the corner (the field piles into it and respawns); too loose
 * and the whole lap is flat out, which the balance harness reads as a top-speed
 * contest and Bulwark loses by construction. The four shipped circuits measure
 * a tightest corner of 35-65m through probe-newtrack, so that is the band.
 *
 *   npx tsx tools/probe-ring.ts --len=3100 --tight=60 --loose=95 [--seed=3]
 */
import { ringStats, curveAt, type Harm } from '../src/content/tracks/ring'

/**
 * Cheap plan length. The full `ringStats` walks 4000 points AND computes an
 * analytic curvature at every one of them; the first version of this file put
 * that inside six nested loops and took longer than the session had. Length is
 * the selective filter and needs a fraction of the resolution, so it runs first
 * and the expensive call only sees shapes that already fit.
 */
function fastLen(H: Harm[]): number {
  let len = 0
  let prev = curveAt(H, 0)
  for (let i = 1; i <= 360; i++) {
    const p = curveAt(H, (2 * Math.PI * i) / 360)
    len += Math.hypot(p.x - prev.x, p.z - prev.z)
    prev = p
  }
  return len
}

const arg = (k: string, d: number) => Number(process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d)
const TARGET = arg('len', 3100)
const TIGHT = arg('tight', 58)
const LOOSE = arg('loose', 100)
const VARIANT = arg('seed', 0)

function harm(r1: number, e: number, a2: number, b2: number, a3: number, b3: number): Harm[] {
  return [
    { k: 1, ax: r1, bx: 0, az: 0, bz: r1 * e },
    { k: 2, ax: a2, bx: b2, az: b2 * 0.7, bz: -a2 * 0.7 },
    { k: 3, ax: a3, bx: b3, az: -b3 * 0.6, bz: a3 * 0.6 },
  ]
}

const found: { score: number; H: Harm[]; s: ReturnType<typeof ringStats>; key: string }[] = []
for (let r1 = 360; r1 <= 600; r1 += 20)
  for (let e = 0.55; e <= 1.0; e += 0.09)
    for (let a2 = 0; a2 <= 150; a2 += 30)
      for (let b2 = 0; b2 <= 150; b2 += 30)
        for (let a3 = 0; a3 <= 130; a3 += 26)
          for (let b3 = 0; b3 <= 130; b3 += 26) {
            const H = harm(r1, e, a2, b2, a3, b3)
            // Cheap test first; the analytic curvature sweep is ~40x dearer.
            if (Math.abs(fastLen(H) - TARGET) > 110) continue
            const s = ringStats(H)
            if (s.minR < TIGHT || s.minR > LOOSE) continue
            if (Math.abs(s.len - TARGET) > 90) continue
            found.push({ score: Math.abs(s.len - TARGET), H, s, key: `${r1}/${e.toFixed(2)}/${a2}/${b2}/${a3}/${b3}` })
          }

if (!found.length) { console.log('nothing in that band -- widen --tight/--loose or move --len'); process.exit(1) }
// Spread the variants out rather than returning six near-identical ovals: sort
// by score, then walk down taking only shapes that differ meaningfully in the
// higher harmonics, which is what actually changes the CHARACTER of a lap.
found.sort((a, b) => a.score - b.score)
const picked: typeof found = []
for (const f of found) {
  if (picked.some((p) => Math.abs(p.s.minR - f.s.minR) < 4 && Math.abs(p.s.len - f.s.len) < 40)) continue
  picked.push(f)
  if (picked.length > 7) break
}
console.log(`${found.length} shapes in band; ${picked.length} distinct:\n`)
picked.forEach((f, i) => {
  console.log(`[${i}] ${f.key}   len ${f.s.len.toFixed(0)}m   tightest ${f.s.minR.toFixed(0)}m`)
  if (i === VARIANT) console.log(`    ${JSON.stringify(f.H.map((h) => ({ k: h.k, ax: +h.ax.toFixed(1), bx: +h.bx.toFixed(1), az: +h.az.toFixed(1), bz: +h.bz.toFixed(1) })))}`)
})
