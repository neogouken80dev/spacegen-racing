/**
 * WHAT DECIDES THE PACE, METRE BY METRE.
 *
 * A corner whose speed limit sits above the roster's top speed is not a corner:
 * it is road where the only thing separating two chassis is `topSpeed`, and a
 * lap made mostly of that road is a lap the low-top-speed chassis cannot win
 * however well it drives. This prints, per bin, the AI's own corner limit
 * (cornerSpeedAt on the surface under the car, times T.ai.corneringCaution) and
 * totals the arc where that limit binds nobody.
 *
 *   npx tsx tools/probe-pace.ts --track=aetherion,rustfall,cryostatic
 */
import { Track, SURFACE_GRIP } from '../src/sim/track'
import { TRACKS_BY_ID } from '../src/content/tracks'
import { CHASSIS, getDerived, getLocomotion } from '../src/content/chassis'
import { TUNING as T } from '../src/content/tuning'
import { lateralBudget, cornerSpeedAt } from '../src/sim/vehicle'

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const BIN = parseFloat(arg('bin', '10'))
const FROM = parseFloat(arg('from', '-1'))
const TO = parseFloat(arg('to', '1e9'))
const TOPMAX = Math.max(...CHASSIS.map((c) => getDerived(c.id).topSpeed))
const TOPMIN = Math.min(...CHASSIS.map((c) => getDerived(c.id).topSpeed))

for (const id of arg('track', 'aetherion').split(',')) {
  const tr = new Track(TRACKS_BY_ID[id])
  const L = tr.length
  const N = Math.round(L / 2)
  const step = L / N
  let freeArc = 0        // limit above the FASTEST chassis: pure top-speed road
  let partArc = 0        // limit between the slowest and fastest: partly binding
  let bindArc = 0        // limit below the slowest: binds everyone
  const rows: { s: number; lim: number; k: number }[] = []
  for (let i = 0; i < N; i++) {
    const s = i * step
    const smp = tr.at(s)
    const k = Math.max(
      Math.abs(tr.curvatureAt(s, 26)),
      Math.abs(tr.curvatureAt(s, 14)) * T.ai.cornerHoldShare,
    )
    // Reference: the roster's own median grip on the surface actually there.
    let lim = 0
    for (const c of CHASSIS) {
      const d = getDerived(c.id), lo = getLocomotion(c.id)
      const g = 1 + (SURFACE_GRIP[smp.surface] - 1) * lo.surfaceFrictionInfluence
      lim += Math.min(d.topSpeed, cornerSpeedAt(lateralBudget(d, lo, g), k) * T.ai.corneringCaution)
    }
    lim /= CHASSIS.length
    const raw = cornerSpeedAt(lateralBudget(getDerived('solaire'), getLocomotion('solaire'),
      1 + (SURFACE_GRIP[smp.surface] - 1)), k) * T.ai.corneringCaution
    if (raw >= TOPMAX) freeArc += step
    else if (raw >= TOPMIN) partArc += step
    else bindArc += step
    rows.push({ s, lim: raw, k })
  }
  console.log(`\n=== ${id}  ${L.toFixed(0)}m   roster top speed ${TOPMIN.toFixed(1)}-${TOPMAX.toFixed(1)} m/s ===`)
  console.log(`  FLAT OUT for everyone (limit >= ${TOPMAX.toFixed(1)}):  ${freeArc.toFixed(0)}m  ${(freeArc / L * 100).toFixed(1)}%`)
  console.log(`  binds only the fastest (${TOPMIN.toFixed(1)}-${TOPMAX.toFixed(1)}): ${partArc.toFixed(0)}m  ${(partArc / L * 100).toFixed(1)}%`)
  console.log(`  binds everyone (limit < ${TOPMIN.toFixed(1)}):        ${bindArc.toFixed(0)}m  ${(bindArc / L * 100).toFixed(1)}%`)
  if (FROM >= 0) {
    console.log('      s    limit   R      status')
    for (const r of rows) {
      if (r.s < FROM || r.s > TO) continue
      if (Math.round(r.s) % Math.round(BIN) > step) continue
      const st = r.lim >= TOPMAX ? 'FLAT OUT' : r.lim >= TOPMIN ? 'part' : 'binds'
      console.log(`  ${r.s.toFixed(0).padStart(6)} ${r.lim.toFixed(1).padStart(7)} ${(1 / Math.max(1e-6, r.k)).toFixed(0).padStart(6)}   ${st}`)
    }
  }
}
