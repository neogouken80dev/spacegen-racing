/**
 * THE VACUUM RULER, and the flat-out census the corner table cannot give you.
 *
 * tools/probe-track.ts prices every corner with `lateralBudget(derived, loco,
 * surfaceGrip)` and knows nothing about TrackNode.vacuum, so on The Hollow
 * Choir it reports the Fall as flat out when the AI is actually braking for it:
 * the vacuum is a SECOND multiplier on the same budget and it is worth more
 * than any surface in the game. This prints what stepAI actually computes.
 *
 * Three tables:
 *   1. per class, the lateral budget and the corner limit with and without the
 *      vacuum -- the class contract, as numbers;
 *   2. the flat-out census: the share of the lap where the AI's own desired
 *      speed is its top speed, i.e. where nothing but top speed decides;
 *   3. the same census binned by beat, so it is obvious WHICH beat is dead.
 *
 *   npx tsx tools/probe-vacuum.ts --track=hollowchoir
 */
import { Track, SURFACE_GRIP } from '../src/sim/track'
import { TRACKS_BY_ID } from '../src/content/tracks'
import { CHASSIS, getDerived, getLocomotion } from '../src/content/chassis'
import { TUNING as T } from '../src/content/tuning'
import { lateralBudget, cornerSpeedAt, vacuumGripMult, vacuumTopSpeedMult } from '../src/sim/vehicle'

const arg = (k: string, d: string) =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const track = new Track(TRACKS_BY_ID[arg('track', 'hollowchoir')])
const L = track.length
const N = 3000
const step = L / N

console.log(`\n=== ${track.def.name}  ${L.toFixed(0)}m  hasVacuum=${track.hasVacuum} ===\n`)

// --- 1. the class contract -------------------------------------------------
console.log('CLASS CONTRACT AT FULL VACUUM (tarmac, R=110m corner)')
console.log('  chassis    class      budget  ->  in vac   loss    corner v  ->  in vac    top v -> in vac')
for (const c of CHASSIS) {
  const d = getDerived(c.id), lo = getLocomotion(c.id)
  const b = lateralBudget(d, lo, 1)
  const bv = b * vacuumGripMult(1, lo)
  const k = 1 / 110
  const v = cornerSpeedAt(b, k) * T.ai.corneringCaution
  const vv = cornerSpeedAt(bv, k) * T.ai.corneringCaution
  console.log(
    `  ${c.id.padEnd(9)} ${c.locomotion.padEnd(9)} ${b.toFixed(1).padStart(7)}  -> ${bv.toFixed(1).padStart(6)}` +
    `  ${(100 * (1 - bv / b)).toFixed(0).padStart(4)}%  ${v.toFixed(1).padStart(8)}  -> ${vv.toFixed(1).padStart(7)}` +
    `  ${d.topSpeed.toFixed(1).padStart(7)} -> ${(d.topSpeed * vacuumTopSpeedMult(1)).toFixed(1)}`,
  )
}

// --- 2/3. the flat-out census ----------------------------------------------
/** What stepAI's `desired` would be here, ignoring traffic and items. */
function desiredAt(s: number, cid: string): { want: number; top: number } {
  const d = getDerived(cid), lo = getLocomotion(cid)
  const curveNear = track.curvatureAt(s, 14)
  const curveFar = track.curvatureAt(s + T.ai.lookaheadBase + 50 * T.ai.lookaheadPerSpeed, 26)
  const k = Math.max(Math.abs(curveFar), Math.abs(curveNear) * T.ai.cornerHoldShare)
  const ahead = track.at(s + T.ai.lookaheadBase + 50 * T.ai.lookaheadPerSpeed)
  const g = 1 + (SURFACE_GRIP[ahead.surface] - 1) * lo.surfaceFrictionInfluence * T.ai.surfaceCaution
  let budget = lateralBudget(d, lo, g)
  let top = d.topSpeed
  if (track.hasVacuum) { budget *= vacuumGripMult(ahead.vacuum, lo); top *= vacuumTopSpeedMult(ahead.vacuum) }
  return { want: Math.min(top, cornerSpeedAt(budget, k) * T.ai.corneringCaution), top }
}

console.log('\nFLAT-OUT CENSUS  (metres where the corner limit is at or above top speed)')
for (const c of CHASSIS) {
  let flat = 0
  for (let i = 0; i < N; i++) {
    const s = i * step
    const { want, top } = desiredAt(s, c.id)
    if (want >= top - 1e-9) flat += step
  }
  console.log(`  ${c.id.padEnd(9)} ${flat.toFixed(0).padStart(5)}m of ${L.toFixed(0)}m  ${(100 * flat / L).toFixed(1)}%`)
}

// beats from the authored tags
const beats: { s: number; tag: string }[] = []
{
  const n = track.def.nodes.length
  // rough arc position of each tagged node: nearest baked sample
  for (let i = 0; i < n; i++) {
    const nd = track.def.nodes[i]
    if (!nd.tag) continue
    let best = 0, bd = Infinity
    for (let j = 0; j < track.samples.length; j++) {
      const p = track.samples[j].pos
      const dd = (p.x - nd.p[0]) ** 2 + (p.y - nd.p[1]) ** 2 + (p.z - nd.p[2]) ** 2
      if (dd < bd) { bd = dd; best = j }
    }
    beats.push({ s: (best / track.samples.length) * L, tag: nd.tag })
  }
  beats.sort((a, b) => a.s - b.s)
}
console.log('\nBY BEAT  (solaire; "flat" = nothing but top speed decides; vac = mean vacuum; wind = mean)')
console.log('   s0     s1   len   beat                flat%   vac   wind   meanR')
for (let b = 0; b < beats.length; b++) {
  const s0 = beats[b].s, s1 = b + 1 < beats.length ? beats[b + 1].s : L
  let flat = 0, tot = 0, vac = 0, wind = 0, kk = 0
  for (let s = s0; s < s1; s += 2) {
    const { want, top } = desiredAt(s, 'solaire')
    if (want >= top - 1e-9) flat += 2
    const smp = track.at(s)
    vac += smp.vacuum * 2; wind += smp.wind * 2; kk += Math.abs(track.curvatureAt(s, 20)) * 2
    tot += 2
  }
  console.log(
    `${s0.toFixed(0).padStart(5)} ${s1.toFixed(0).padStart(6)} ${(s1 - s0).toFixed(0).padStart(5)}   ${beats[b].tag.padEnd(18)}` +
    `${(100 * flat / tot).toFixed(0).padStart(5)}%  ${(vac / tot).toFixed(2)}  ${(wind / tot).toFixed(1).padStart(5)}  ` +
    `${(kk / tot > 1e-5 ? (1 / (kk / tot)).toFixed(0) : 'inf').padStart(6)}`,
  )
}
