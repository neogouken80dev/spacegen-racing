/**
 * SEARCH SEVERAL SHAPE FAMILIES AT ONCE, AND REPORT HOW DIFFERENT THEY ARE.
 *
 * `probe-ring.ts` searches one family -- k=1 plus k=2 plus k=3, with the k=2 and
 * k=3 terms coupled to each other by a fixed formula. It found four circuits
 * that all measured correctly and all looked like the same kidney, which is
 * exactly what that parametrisation can produce and nothing else. Reported from
 * play: "they all share the same track map and layout".
 *
 * The fix is not a better search over the same family. It is more families:
 *
 *   PEANUT   k1 + k2        one waist, two lobes. Classic road-course kidney.
 *   CLOVER   k1 + k3        three lobes. Flowing, no long straight.
 *   SQUARED  k1 + k4        four flattened sides. Reads as a street circuit.
 *   LONG     k1 only, high eccentricity, plus a small k2. Two hairpins and two
 *            long straights -- a speedway, and the one shape the old search
 *            could never reach because k2/k3 always rounded the ends off.
 *
 * Each is reported with the numbers that decide whether it is driveable at all
 * (length, tightest radius) plus the one the old search forgot: how close the
 * curve comes to ITSELF, because a lobed shape will happily fold a lobe back
 * against another part of the lap.
 *
 *   npx tsx tools/probe-shapes.ts --len=3000 --tight=48 --loose=95
 */
import { ringStats, ringSelfDistance, curveAt, type Harm } from '../src/content/tracks/ring'

/**
 * Cheap plan length, 360 samples. The full pipeline below is ~1500x dearer per
 * candidate (an analytic curvature sweep plus an O(n^2) self-distance), and the
 * first version of this file ran all of it inside a 128,000-point grid and did
 * not finish. Length rejects almost everything, so it goes first.
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
const TARGET = arg('len', 3000)
const TIGHT = arg('tight', 48)
const LOOSE = arg('loose', 95)
const MIN_SELF = arg('self', 150)

type Family = { name: string; build: (a: number, b: number, c: number, e: number) => Harm[] }

const FAMILIES: Family[] = [
  {
    name: 'PEANUT  k1+k2',
    build: (a, b, _c, e) => [
      { k: 1, ax: a, bx: 0, az: 0, bz: a * e },
      { k: 2, ax: b, bx: b * 0.45, az: b * 0.5, bz: -b * 0.8 },
    ],
  },
  {
    name: 'CLOVER  k1+k3',
    build: (a, _b, c, e) => [
      { k: 1, ax: a, bx: 0, az: 0, bz: a * e },
      { k: 3, ax: c, bx: c * 0.3, az: -c * 0.75, bz: c * 0.35 },
    ],
  },
  {
    name: 'SQUARED k1+k4',
    build: (a, b, _c, e) => [
      { k: 1, ax: a, bx: 0, az: 0, bz: a * e },
      { k: 4, ax: b * 0.8, bx: 0, az: 0, bz: -b * 0.8 },
    ],
  },
  {
    name: 'LONG    k1+small k2',
    build: (a, b, _c, e) => [
      { k: 1, ax: a, bx: 0, az: 0, bz: a * e },
      { k: 2, ax: b * 0.3, bx: 0, az: 0, bz: b * 0.3 },
    ],
  },
]

for (const fam of FAMILIES) {
  const found: { score: number; H: Harm[]; len: number; minR: number; self: number; key: string }[] = []
  for (let a = 260; a <= 700; a += 30)
    for (let e = 0.35; e <= 1.0; e += 0.08)
      for (let b = 0; b <= 190; b += 20)
        for (let c = 0; c <= 190; c += 20) {
          // The shaping term must actually be present. Left unconstrained the
          // search happily returns CLOVER with its k=3 amplitude at zero -- a
          // plain ellipse that satisfies every numeric target and is precisely
          // the sameness this tool exists to break.
          if (fam.name.startsWith('CLOVER') && c < 60) continue
          if (fam.name.startsWith('PEANUT') && b < 50) continue
          if (fam.name.startsWith('SQUARED') && b < 30) continue
          if (fam.name.startsWith('LONG') && (e > 0.55 || b < 20)) continue
          const H = fam.build(a, b, c, e)
          if (Math.abs(fastLen(H) - TARGET) > 100) continue
          const s = ringStats(H)
          if (Math.abs(s.len - TARGET) > 80) continue
          if (s.minR < TIGHT || s.minR > LOOSE) continue
          const self = ringSelfDistance(H)
          if (self < MIN_SELF) continue
          found.push({
            score: Math.abs(s.len - TARGET), H, len: s.len, minR: s.minR, self,
            key: `a=${a} e=${e.toFixed(2)} b=${b} c=${c}`,
          })
          if (found.length > 40) break
        }
  found.sort((x, y) => x.score - y.score)
  const pick = found[0]
  console.log(`\n${fam.name}`)
  if (!pick) { console.log('  nothing in band'); continue }
  console.log(`  ${pick.key}   len ${pick.len.toFixed(0)}m  tightest ${pick.minR.toFixed(0)}m  self-clear ${pick.self.toFixed(0)}m`)
  console.log(`  ${JSON.stringify(pick.H.map((h) => ({ k: h.k, ax: +h.ax.toFixed(1), bx: +h.bx.toFixed(1), az: +h.az.toFixed(1), bz: +h.bz.toFixed(1) })))}`)
}
