/**
 * WHERE A CHASSIS LOSES THE LAP.
 *
 * Win share is decided by lap time and lap time is a sum over arc length, so the
 * only honest way to ask "why is this chassis slow here" is to bin the seconds.
 * Accumulates, per chassis, the time spent in each arc bin (frames / 60) over a
 * batch of races, normalises to one lap, and prints the per-bin deficit of a
 * chosen chassis against the field mean. The last column is the cumulative
 * deficit, so the beats that actually cost the race are the ones where it steps.
 *
 *   npx tsx tools/probe-sector.ts --track=aetherion --who=bulwark --races=8
 */
import { Race } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { TRACKS_BY_ID } from '../src/content/tracks'
import { CHASSIS } from '../src/content/chassis'
import { PILOTS } from '../src/content/pilots'
import { resetAI } from '../src/sim/ai'
import { emptyInput } from '../src/sim/types'
import type { SimConfig } from '../src/sim/types'

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const TD = TRACKS_BY_ID[arg('track', 'aetherion')]
const RACES = parseInt(arg('races', '8'), 10)
const WHO = arg('who', 'bulwark')
const NB = parseInt(arg('bins', '40'), 10)

const track = new Track(TD)
const L = track.length
const NC = CHASSIS.length
const CI: Record<string, number> = {}
CHASSIS.forEach((c, i) => { CI[c.id] = i })
const frames = CHASSIS.map(() => new Array(NB).fill(0))
const passes = CHASSIS.map(() => new Array(NB).fill(0))
const spdSum = CHASSIS.map(() => new Array(NB).fill(0))
const driftFr = CHASSIS.map(() => new Array(NB).fill(0))
const boostFr = CHASSIS.map(() => new Array(NB).fill(0))

for (let race = 0; race < RACES; race++) {
  resetAI()
  const t = new Track(TD)
  const n = NC
  const cfg: SimConfig = {
    seed: 7000 + race * 613, totalLaps: 3, racerCount: n, trackId: TD.id,
    chassisIds: Array.from({ length: n }, (_, i) => CHASSIS[i % NC].id),
    // One of each chassis, all at the SAME skill: any per-chassis difference the
    // bins show is then the car, not the driver.
    pilotIds: Array.from({ length: n }, (_, i) => PILOTS[i % PILOTS.length].id),
    localRacerIndex: -1,
    aiSkill: Array.from({ length: n }, () => 3),
  }
  const r = new Race(t, cfg)
  const idle = emptyInput()
  const rs = r.state.racers
  const prevBin = new Array(n).fill(-1)
  let f = 0
  while (f < 60 * 400 && r.state.phase !== 'finished') {
    for (const x of rs) if (!x.isAI) r.setInput(x.id, idle)
    r.step(); f++
    for (let k = 0; k < n; k++) {
      const x = rs[k]
      if (x.finished) continue
      const ci = CI[x.chassisId]
      const b = Math.min(NB - 1, Math.floor((((x.splineS % L) + L) % L) / L * NB))
      frames[ci][b]++
      spdSum[ci][b] += Math.hypot(x.vel.x, x.vel.y, x.vel.z)
      if (x.driftSide !== 0) driftFr[ci][b]++
      if (x.boostTime > 0) boostFr[ci][b]++
      if (b !== prevBin[k]) { passes[ci][b]++; prevBin[k] = b }
    }
  }
}

const tagAt: { s: number; tag: string }[] = []
for (const nd of TD.nodes) {
  if (!nd.tag) continue
  let best = 0, bd = Infinity
  for (let k = 0; k < track.samples.length; k++) {
    const p = track.samples[k].pos
    const d = (p.x - nd.p[0]) ** 2 + (p.y - nd.p[1]) ** 2 + (p.z - nd.p[2]) ** 2
    if (d < bd) { bd = d; best = k }
  }
  tagAt.push({ s: (best / track.samples.length) * L, tag: nd.tag })
}

const who = CI[WHO]
console.log(`\n=== ${TD.name}  ${L.toFixed(0)}m   seconds per lap per bin, ${RACES} races ===`)
console.log(`  bin      s0    ${WHO.padEnd(8)}  fieldMean   delta   cumulative   tags`)
let cum = 0
let totWho = 0, totField = 0
for (let b = 0; b < NB; b++) {
  const secWho = frames[who][b] / 60 / Math.max(1, passes[who][b])
  let sf = 0, nf = 0
  for (let c = 0; c < NC; c++) {
    if (c === who) continue
    if (passes[c][b] === 0) continue
    sf += frames[c][b] / 60 / passes[c][b]; nf++
  }
  const secField = sf / Math.max(1, nf)
  const delta = secWho - secField
  cum += delta
  totWho += secWho; totField += secField
  const s0 = (b / NB) * L, s1 = ((b + 1) / NB) * L
  const tags = tagAt.filter((x) => x.s >= s0 && x.s < s1).map((x) => x.tag).join(',')
  const flag = delta > 0.02 ? ' <<<' : ''
  const spdWho = spdSum[who][b] / Math.max(1, frames[who][b])
  let ss = 0, sd = 0, sb = 0, nn = 0
  for (let c = 0; c < NC; c++) {
    if (c === who || frames[c][b] === 0) continue
    ss += spdSum[c][b] / frames[c][b]; sd += driftFr[c][b] / frames[c][b]; sb += boostFr[c][b] / frames[c][b]; nn++
  }
  const dWho = driftFr[who][b] / Math.max(1, frames[who][b])
  const bWho = boostFr[who][b] / Math.max(1, frames[who][b])
  console.log(`  ${String(b).padStart(3)} ${s0.toFixed(0).padStart(7)} ${secWho.toFixed(3).padStart(9)} ${secField.toFixed(3).padStart(10)} ${delta >= 0 ? '+' : ''}${delta.toFixed(3).padStart(7)} ${cum.toFixed(3).padStart(11)}  ${spdWho.toFixed(1).padStart(5)}/${(ss / Math.max(1, nn)).toFixed(1).padStart(5)} ${(dWho * 100).toFixed(0).padStart(3)}/${(sd / Math.max(1, nn) * 100).toFixed(0).padStart(3)}% ${(bWho * 100).toFixed(0).padStart(3)}/${(sb / Math.max(1, nn) * 100).toFixed(0).padStart(3)}%  ${tags}${flag}`)
}
console.log(`  LAP: ${WHO} ${totWho.toFixed(2)}s   field ${totField.toFixed(2)}s   deficit ${(totWho - totField).toFixed(2)}s`)
