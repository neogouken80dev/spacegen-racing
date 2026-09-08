/**
 * WHERE THE LAP IS WON, METRE BY METRE.
 *
 * probe-track prints one ideal lap per chassis. That number says WHICH chassis
 * a track suits and never says WHY, which is useless when the answer has to be
 * a geometry edit: "Dray-9 is 2.3s a lap up" is a diagnosis with no address.
 *
 * This integrates the same ideal lap and then attributes the DIFFERENCE between
 * two chassis to the metres that produced it, bucketed by the local speed
 * limit. The output is a shopping list: how many metres of the lap are
 * throttle-limited (where top speed pays and grip cannot), how many are
 * genuinely corner-limited, and what the exchange rate is between them.
 *
 *   npx tsx tools/probe-chassis.ts --track=aetherion [--a=bulwark --b=dray9]
 */
import { Track } from '../src/sim/track'
import { TRACKS_BY_ID } from '../src/content/tracks'
import { CHASSIS, getDerived, getLocomotion } from '../src/content/chassis'
import { SURFACE_GRIP } from '../src/sim/track'
import { lateralBudget, cornerSpeedAt } from '../src/sim/vehicle'

const arg = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const def = TRACKS_BY_ID[arg('track', 'aetherion')]
const track = new Track(def)
const m = track.samples.length
const ds = track.length / m
const radiusAt = (s: number): number => {
  const k = Math.abs(track.curvatureAt(s - 7.5, 15))
  return k > 1e-6 ? 1 / k : Infinity
}
const limit = (id: string, i: number): number => {
  const d = getDerived(id), l = getLocomotion(id)
  const su = track.samples[i].surface
  const g = 1 + (SURFACE_GRIP[su] - 1) * l.surfaceFrictionInfluence
  return Math.min(d.topSpeed, cornerSpeedAt(lateralBudget(d, l, g), 1 / radiusAt((i / m) * track.length)))
}
const pad = (s: string, n: number) => s.length >= n ? s : s + ' '.repeat(n - s.length)
const padL = (s: string, n: number) => s.length >= n ? s : ' '.repeat(n - s.length) + s

console.log(`${def.name}  ${track.length.toFixed(0)}m`)
console.log(`\nIDEAL LAP`)
const ideal: Record<string, number> = {}
for (const c of CHASSIS) {
  let t = 0
  for (let i = 0; i < m; i++) t += ds / limit(c.id, i)
  ideal[c.id] = t
  console.log(`  ${pad(c.id, 9)} ${pad(c.locomotion, 9)} top ${getDerived(c.id).topSpeed.toFixed(1)}  ideal ${t.toFixed(2)}s`)
}
const best = Math.min(...Object.values(ideal)), worst = Math.max(...Object.values(ideal))
console.log(`  SPREAD ${(worst - best).toFixed(2)}s  (${((worst - best) / track.length * 1000).toFixed(2)} ms/m)`)

const A = arg('a', 'bulwark'), B = arg('b', 'dray9')
console.log(`\nWHERE ${A} LOSES TO ${B}, bucketed by ${B}'s local limit:`)
const buckets: [number, number][] = [[0, 35], [35, 45], [45, 55], [55, 62], [62, 999]]
const rows = buckets.map(() => ({ metres: 0, dt: 0 }))
for (let i = 0; i < m; i++) {
  const va = limit(A, i), vb = limit(B, i)
  const dt = ds / va - ds / vb
  const bi = buckets.findIndex(([lo, hi]) => vb >= lo && vb < hi)
  rows[bi].metres += ds
  rows[bi].dt += dt
}
console.log(`  ${pad(`${B} limit`, 14)}${padL('metres', 8)}${padL('% lap', 7)}${padL(`${A} loses`, 11)}${padL('ms/m', 8)}`)
for (let i = 0; i < buckets.length; i++) {
  const [lo, hi] = buckets[i]
  console.log(`  ${pad(hi > 900 ? `${lo}+ m/s (flat)` : `${lo}-${hi} m/s`, 14)}${padL(rows[i].metres.toFixed(0), 8)}` +
    `${padL((rows[i].metres / track.length * 100).toFixed(0) + '%', 7)}${padL(rows[i].dt.toFixed(3) + 's', 11)}` +
    `${padL((rows[i].dt / Math.max(1, rows[i].metres) * 1000).toFixed(3), 8)}`)
}
console.log(`  ${pad('TOTAL', 14)}${padL(track.length.toFixed(0), 8)}${padL('100%', 7)}` +
  `${padL((ideal[A] - ideal[B]).toFixed(3) + 's', 11)}`)
console.log(`\n  Exchange rate: a metre at ${B}'s top speed costs ${A} ` +
  `${((1 / getDerived(A).topSpeed - 1 / getDerived(B).topSpeed) * 1000).toFixed(3)} ms;` +
  ` breaking even needs a corner metre under ~40m radius.`)

// --- Where the flat-out metres are, so the fix has an address ------------------
console.log(`\nFLAT-OUT RUNS for ${B} (>= its top speed), longest first:`)
{
  type Run = { s0: number; len: number }
  const runs: Run[] = []
  let cur: Run | null = null
  for (let n = 0; n < m * 2; n++) {
    const i = n % m
    const flat = limit(B, i) >= getDerived(B).topSpeed - 1e-6
    if (flat) {
      if (!cur) cur = { s0: (i / m) * track.length, len: 0 }
      cur.len += ds
    } else if (cur) { if (n <= m + 1) runs.push(cur); cur = null }
  }
  if (cur) runs.push(cur)
  const seen = new Set<number>()
  const uniq = runs.filter((r) => { const k = Math.round(r.s0); if (seen.has(k)) return false; seen.add(k); return true })
  uniq.sort((a, b) => b.len - a.len)
  const tags = def.nodes.filter((n) => n.tag)
  const nearestTag = (s: number): string => {
    let best = '', bd = Infinity
    for (const nd of tags) {
      let bi = 0, bdd = Infinity
      for (let i = 0; i < m; i++) {
        const p = track.samples[i].pos
        const d = (p.x - nd.p[0]) ** 2 + (p.z - nd.p[2]) ** 2
        if (d < bdd) { bdd = d; bi = i }
      }
      const ts = (bi / m) * track.length
      let dd = Math.abs(ts - s); dd = Math.min(dd, track.length - dd)
      if (dd < bd) { bd = dd; best = nd.tag! }
    }
    return best
  }
  for (const r of uniq.slice(0, 12)) {
    console.log(`  s=${padL(r.s0.toFixed(0), 5)}m  len ${padL(r.len.toFixed(0), 4)}m   near ${nearestTag(r.s0 + r.len / 2)}`)
  }
}

// --- Which flat-out metres are actually gentle CORNERS -----------------------
// A metre that is flat out because the road is straight can only be made to
// bind by re-laying it. A metre that is flat out because the corner is merely
// open can be made to bind by putting a surface on it. The two are worth
// knowing apart before reaching for either tool.
console.log(`\nFLAT-OUT METRES BY RADIUS (${B}), and what gravel (0.70) would do to them:`)
{
  const bands: [number, number][] = [[0, 130], [130, 180], [180, 260], [260, 400], [400, 1e9]]
  const met = bands.map(() => 0)
  const dGravel = bands.map(() => 0)
  const dA = getDerived(A), lA = getLocomotion(A), dB = getDerived(B), lB = getLocomotion(B)
  for (let i = 0; i < m; i++) {
    if (limit(B, i) < dB.topSpeed - 1e-6) continue
    const r = radiusAt((i / m) * track.length)
    const bi = bands.findIndex(([lo, hi]) => r >= lo && r < hi)
    met[bi] += ds
    const va = Math.min(dA.topSpeed, cornerSpeedAt(lateralBudget(dA, lA, 0.70), 1 / r))
    const vb = Math.min(dB.topSpeed, cornerSpeedAt(lateralBudget(dB, lB, 0.70), 1 / r))
    // change in (t_A - t_B) for this metre if it were gravel
    dGravel[bi] += (ds / va - ds / vb) - (ds / dA.topSpeed - ds / dB.topSpeed)
  }
  for (let i = 0; i < bands.length; i++) {
    const [lo, hi] = bands[i]
    console.log(`  R ${pad(hi > 1e8 ? `${lo}m+ (straight)` : `${lo}-${hi}m`, 18)}${padL(met[i].toFixed(0) + 'm', 7)}` +
      `   gravel here would move the spread by ${padL(dGravel[i].toFixed(3) + 's', 8)}`)
  }
}
