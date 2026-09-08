/**
 * WHERE THE BOOST ACTUALLY COMES FROM.
 *
 * boostSource only names the STRONGEST boost currently running, so on a track
 * where the drift never reaches Tier 2 every drift release is quietly folded
 * into whatever pad is already active (applyBoost's weakerExtend branch) and
 * the attribution lies. This reconstructs the GRANTS instead, from the one
 * thing that cannot lie: boostTime moves by -DT every frame unless something
 * granted. A jump of exactly weakerExtend is an extension; anything else is a
 * fresh set, and boostMag says which.
 */
import { Race } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { TRACKS_BY_ID } from '../src/content/tracks'
import { CHASSIS } from '../src/content/chassis'
import { PILOTS } from '../src/content/pilots'
import { resetAI } from '../src/sim/ai'
import { emptyInput } from '../src/sim/types'
import { TUNING as T } from '../src/content/tuning'
import type { SimConfig } from '../src/sim/types'

const argv = process.argv.slice(2)
const arg = (k: string, d: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const RACES = parseInt(arg('races', '4'), 10)
const DT = T.sim.dt

for (const id of arg('track', 'aetherion').split(',')) {
  const TD = TRACKS_BY_ID[id]
  const n = 8
  const cfg = (seed: number): SimConfig => ({
    seed, totalLaps: 3, racerCount: n, trackId: TD.id,
    chassisIds: Array.from({ length: n }, (_, i) => CHASSIS[i % CHASSIS.length].id),
    pilotIds: Array.from({ length: n }, (_, i) => PILOTS[i % PILOTS.length].id),
    localRacerIndex: -1,
    aiSkill: Array.from({ length: n }, (_, i) => 2 + (i % 3)),
  })
  const grants = new Map<string, number>()
  const extendBy = new Map<string, number>()   // source that was RUNNING when extended
  let extendSeconds = 0
  let boostFrames = 0, driveFrames = 0
  let extendEvents = 0
  let maxBoostTime = 0
  const btHist = new Array(24).fill(0)
  let padStripFrames = 0
  const lapTimes: number[] = []
  for (let race = 0; race < RACES; race++) {
    resetAI()
    const tr = new Track(TD)
    const r = new Race(tr, cfg(9000 + race * 977))
    const idle = emptyInput()
    const rs = r.state.racers
    const pT = new Array(n).fill(0), pM = new Array(n).fill(0), pS: string[] = new Array(n).fill('none')
    let f = 0
    while (f < 60 * 400 && r.state.phase !== 'finished') {
      for (const x of rs) if (!x.isAI) r.setInput(x.id, idle)
      r.step(); f++
      for (let k = 0; k < n; k++) {
        const x = rs[k]
        if (x.finished) { pT[k] = x.boostTime; pM[k] = x.boostMag; pS[k] = x.boostSource; continue }
        driveFrames++
        if (x.boostTime > 0) boostFrames++
        if (x.boostTime > maxBoostTime) maxBoostTime = x.boostTime
        btHist[Math.min(23, Math.floor(x.boostTime))]++
        if (tr.at(x.splineS).boost && x.altitude < 3.0) padStripFrames++
        const expect = Math.max(0, pT[k] - DT)
        const d = x.boostTime - expect
        if (d > 1e-9) {
          if (Math.abs(d - T.boost.weakerExtend) < 1e-6 && x.boostSource === pS[k] && x.boostMag === pM[k]) {
            extendEvents++
            extendSeconds += T.boost.weakerExtend
            extendBy.set(pS[k], (extendBy.get(pS[k]) ?? 0) + 1)
          } else {
            grants.set(x.boostSource, (grants.get(x.boostSource) ?? 0) + 1)
          }
        }
        pT[k] = x.boostTime; pM[k] = x.boostMag; pS[k] = x.boostSource
      }
    }
    for (const x of rs) for (const lt of x.lapTimes) if (lt > 0) lapTimes.push(lt)
  }
  const lapMean = lapTimes.reduce((a, b) => a + b, 0) / Math.max(1, lapTimes.length)
  console.log(`\n=== ${id}  ${RACES} races  lapMean ${lapMean.toFixed(2)}s  boost uptime ${(boostFrames / driveFrames * 100).toFixed(1)}% ===`)
  console.log('  FRESH/UPGRADE GRANTS per race (the source that WON the slot):')
  for (const [k, v] of [...grants].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(12)} ${(v / RACES).toFixed(1).padStart(8)}`)
  console.log(`  weakerExtend events per race ${(extendEvents / RACES).toFixed(1)}  = ${(extendSeconds / RACES).toFixed(1)}s of boost per race added to an already-running boost`)
  console.log('    extending a running: ' + [...extendBy].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v / RACES).toFixed(1)}`).join('  '))
  const raceSeconds = driveFrames * DT / RACES
  console.log(`  max boostTime seen ${maxBoostTime.toFixed(1)}s   boostTime histogram (whole seconds): ` + btHist.map((v, i) => v ? `${i}s:${(v / driveFrames * 100).toFixed(1)}%` : '').filter(Boolean).join(' '))
  console.log(`  frames standing on a boost strip: ${(padStripFrames / RACES).toFixed(0)} per race = ${(padStripFrames / RACES * DT).toFixed(1)}s, granting ${(padStripFrames / RACES * T.boost.weakerExtend).toFixed(0)}s of extension`)
  console.log(`  drive-seconds per race ${raceSeconds.toFixed(0)}  extension is ${(extendSeconds / RACES / raceSeconds * 100).toFixed(1)} points of uptime`)
}
