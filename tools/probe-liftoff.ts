/**
 * WHERE A GROUNDED CAR LEAVES THE ROAD, AND WHY.
 *
 * `canDrift` is false for a grounded chassis the moment `r.grounded` is, so any
 * metre of road that flicks the flag cancels the drift of three of the five
 * chassis and cancels neither of the other two. This finds those metres: every
 * grounded -> airborne transition, binned by arc length, with the lateral offset
 * and the surface roll where it happened.
 *
 *   npx tsx tools/probe-liftoff.ts --track=aetherion --from=880 --to=1300
 */
import { Race } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { TRACKS_BY_ID } from '../src/content/tracks'
import { CHASSIS } from '../src/content/chassis'
import { PILOTS } from '../src/content/pilots'
import { resetAI } from '../src/sim/ai'
import { emptyInput } from '../src/sim/types'
import type { SimConfig } from '../src/sim/types'
import { TUNING as T } from '../src/content/tuning'

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const TD = TRACKS_BY_ID[arg('track', 'aetherion')]
const RACES = parseInt(arg('races', '4'), 10)
const FROM = parseFloat(arg('from', '0'))
const TO = parseFloat(arg('to', '99999'))
const BIN = parseFloat(arg('bin', '10'))

const track = new Track(TD)
const L = track.length
const NB = Math.ceil(L / BIN)
const lift = new Array(NB).fill(0)
const frames = new Array(NB).fill(0)
const latSum = new Array(NB).fill(0)
const altSum = new Array(NB).fill(0)
const driftKill = new Array(NB).fill(0)
let causeBelow = 0, causeAbove = 0, causeOther = 0, whileDrifting = 0, afterHit = 0
let liftLatSum = 0, liftAltSum = 0, liftN = 0

for (let race = 0; race < RACES; race++) {
  resetAI()
  const t = new Track(TD)
  const n = parseInt(arg('racers', '8'), 10)
  const cfg: SimConfig = {
    seed: 4000 + race * 811, totalLaps: 3, racerCount: n, trackId: TD.id,
    chassisIds: Array.from({ length: n }, (_, i) => CHASSIS[i % CHASSIS.length].id),
    pilotIds: Array.from({ length: n }, (_, i) => PILOTS[i % PILOTS.length].id),
    localRacerIndex: -1,
    aiSkill: Array.from({ length: n }, (_, i) => 2 + (i % 3)),
  }
  const r = new Race(t, cfg)
  const idle = emptyInput()
  const rs = r.state.racers
  const wasG: boolean[] = new Array(n).fill(true)
  const wasD = new Array(n).fill(0)
  let f = 0
  while (f < 60 * 400 && r.state.phase !== 'finished') {
    for (const x of rs) if (!x.isAI) r.setInput(x.id, idle)
    r.step(); f++
    for (let k = 0; k < n; k++) {
      const x = rs[k]
      if (x.finished) continue
      if ((CHASSIS.find((c) => c.id === x.chassisId) as any).locomotion !== 'grounded') continue
      const b = Math.min(NB - 1, Math.floor((((x.splineS % L) + L) % L) / BIN))
      frames[b]++
      const proj = t.project(x.pos, x.splineS)
      latSum[b] += Math.abs(proj.lateral)
      altSum[b] += x.altitude
      if (wasG[k] && !x.grounded) {
        lift[b]++
        if (wasD[k] !== 0 && x.driftSide === 0) driftKill[b]++
        if (x.altitude < T.gravity.fallThrough) causeBelow++
        else if (x.altitude > 0.77) causeAbove++
        else causeOther++
        if (wasD[k] !== 0) whileDrifting++
        liftLatSum += Math.abs(proj.lateral); liftAltSum += x.altitude; liftN++
        if (x.lastHitBy || x.spinTime > 0 || x.stunTime > 0) afterHit++
      }
      wasG[k] = x.grounded
      wasD[k] = x.driftSide
    }
  }
}

console.log(`\n${TD.name}  grounded lift-offs, ${RACES} races, ${BIN}m bins`)
console.log('     s   liftoffs  per1000fr  meanLat  meanAlt  roll  R(hold)')
for (let b = 0; b < NB; b++) {
  const s = b * BIN
  if (s < FROM || s > TO) continue
  if (frames[b] === 0) continue
  const smp = track.at(s + BIN / 2)
  const roll = (Math.acos(Math.max(-1, Math.min(1, smp.normal.y))) * 180) / Math.PI
  const k = Math.abs(track.curvatureAt(s + BIN / 2, 20))
  console.log(`  ${s.toFixed(0).padStart(5)} ${String(lift[b]).padStart(9)} ${(lift[b] / frames[b] * 1000).toFixed(1).padStart(10)} ${(latSum[b] / frames[b]).toFixed(1).padStart(8)} ${(altSum[b] / frames[b]).toFixed(2).padStart(8)} ${roll.toFixed(0).padStart(5)} ${(1 / Math.max(1e-6, k)).toFixed(0).padStart(8)}`)
}
const tot = lift.reduce((a, b2) => a + b2, 0)
console.log(`  TOTAL grounded lift-offs ${tot}  (${(tot / RACES).toFixed(0)} per race)`)
console.log(`  cause: alt > rideHeight+0.22 ${causeAbove}   alt < fallThrough(${T.gravity.fallThrough}) ${causeBelow}   neither (ramp/deck) ${causeOther}`)
console.log(`  while drifting ${whileDrifting}   soon after a hit ${afterHit}   mean lateral at lift ${(liftLatSum / Math.max(1, liftN)).toFixed(1)}m  mean alt ${(liftAltSum / Math.max(1, liftN)).toFixed(2)}m`)
console.log(`  drift-cancelling lift-offs ${driftKill.reduce((a, b3) => a + b3, 0)}`)
