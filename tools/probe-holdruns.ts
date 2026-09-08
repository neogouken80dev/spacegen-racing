/**
 * THE DRIFT-HOLD RUN LENGTH.
 *
 * stepAI opens a drift where |k(s+6,30)| > 0.0075 and holds it only while
 * |k(s,20)| > 0.0045. So the longest drift a lap can physically support is the
 * longest contiguous run of arc length over that hold threshold, and the charge
 * it banks is that run divided by the speed it is taken at. This prints the run
 * spectrum, which is the thing that decides the tier histogram.
 */
import { Track, SURFACE_GRIP } from '../src/sim/track'
import { TRACKS_BY_ID } from '../src/content/tracks'
import { CHASSIS, getDerived, getLocomotion } from '../src/content/chassis'
import { TUNING as T } from '../src/content/tuning'
import { lateralBudget, cornerSpeedAt } from '../src/sim/vehicle'
const argv = process.argv.slice(2)
const arg = (k: string, d: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const HOLD = parseFloat(arg('hold', '0.0045'))
const ENTER = parseFloat(arg('enter', '0.0075'))
const ref = CHASSIS.find((c) => c.id === 'solaire')!
const d = getDerived(ref.id), lo = getLocomotion(ref.id)

for (const id of arg('track', 'aetherion').split(',')) {
  const tr = new Track(TRACKS_BY_ID[id])
  const L = tr.length
  const N = 4000, step = L / N
  const hold: boolean[] = [], enter: boolean[] = []
  for (let i = 0; i < N; i++) {
    const s = i * step
    hold.push(Math.abs(tr.curvatureAt(s, 20)) > HOLD)
    enter.push(Math.abs(tr.curvatureAt(s + 6, 30)) > ENTER)
  }
  // contiguous holdable runs, wrapping
  let start = 0
  while (start < N && hold[start]) start++
  const runs: { s0: number; len: number; hasEnter: boolean; vmin: number; est: number; charge: number }[] = []
  let i = 0
  while (i < N) {
    const idx = (start + i) % N
    if (!hold[idx]) { i++; continue }
    let n = 1
    while (i + n < N && hold[(start + i + n) % N]) n++
    let he = false, vmin = Infinity, secs = 0
    for (let j = 0; j < n; j++) {
      const jj = (start + i + j) % N
      if (enter[jj]) he = true
      const s = jj * step
      const smp = tr.at(s)
      const g = 1 + (SURFACE_GRIP[smp.surface] - 1) * lo.surfaceFrictionInfluence
      const k = Math.abs(tr.curvatureAt(s, 20))
      // T.ai.corneringCaution is what the AI actually asks for, and the drift
      // is exempt from the lateral budget anyway, so the speed a car really
      // carries here is the AI's target, not the physical limit.
      const v = Math.min(d.topSpeed, cornerSpeedAt(lateralBudget(d, lo, g), k) * T.ai.corneringCaution)
      if (v < vmin) vmin = v
      secs += step / v
    }
    const len = n * step
    // Charge accrues at lerp(0.55, 1.0, v/top) per second; tiers at tierTimes.
    let charge = 0
    for (let j = 0; j < n; j++) {
      const s = (start + i + j) % N * step
      const smp = tr.at(s)
      const g = 1 + (SURFACE_GRIP[smp.surface] - 1) * lo.surfaceFrictionInfluence
      const k = Math.abs(tr.curvatureAt(s, 20))
      const v = Math.min(d.topSpeed, cornerSpeedAt(lateralBudget(d, lo, g), k) * T.ai.corneringCaution)
      charge += (step / v) * (0.55 + 0.45 * (v / d.topSpeed))
    }
    runs.push({ s0: (start + i) % N * step, len, hasEnter: he, vmin, est: secs, charge })
    i += n
  }
  runs.sort((a, b) => b.len - a.len)
  const usable = runs.filter((r) => r.hasEnter)
  const totalHold = runs.reduce((a, r) => a + r.len, 0)
  console.log(`\n=== ${id}  ${L.toFixed(0)}m ===`)
  console.log(`  holdable arc ${totalHold.toFixed(0)}m (${(totalHold / L * 100).toFixed(1)}%) in ${runs.length} runs, ${usable.length} of them enterable`)
  console.log(`  run length: max ${runs[0].len.toFixed(0)}m  median ${runs[Math.floor(runs.length / 2)].len.toFixed(0)}m  mean ${(totalHold / runs.length).toFixed(0)}m`)
  console.log('  TOP RUNS (est = seconds of drift at the corner speed limit; tiers at 0.65/1.50/2.60/4.20s of charge):')
  console.log('    s0      len   vmin   est(s) charge  tier')
  const show = argv.includes('--all') ? runs : runs.slice(0, 14)
  for (const r of show) {
    const tier = r.charge >= 4.2 ? 'T3' : r.charge >= 2.6 ? 'T2' : r.charge >= 1.5 ? 'T1' : r.charge >= 0.65 ? 'T0' : '--'
    console.log(`   ${r.s0.toFixed(0).padStart(5)} ${r.len.toFixed(0).padStart(7)} ${r.vmin.toFixed(1).padStart(6)} ${r.est.toFixed(2).padStart(7)} ${r.charge.toFixed(2).padStart(7)}   ${tier}${r.hasEnter ? '' : '   (never entered: no 0.0075 point)'}`)
  }
  const bins = [0, 0.65, 1.5, 2.6, 4.2]
  const counts = [0, 0, 0, 0, 0]
  for (const r of usable) {
    let b = 0
    for (let j = bins.length - 1; j >= 0; j--) if (r.charge >= bins[j]) { b = j; break }
    counts[b]++
  }
  console.log(`  enterable runs by best reachable tier: none ${counts[0]}  T0 ${counts[1]}  T1 ${counts[2]}  T2 ${counts[3]}  T3 ${counts[4]}`)
}
