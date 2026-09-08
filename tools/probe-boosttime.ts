/**
 * BANKED BOOST AUDIT.
 *
 * `applyBoost` is a DISCRETE grant, and a boost strip calls it every frame a
 * wheel is on it. This prints how much boost time a racer ends up holding, and
 * how much of the race it spends holding more than the design intends.
 */
import { Race } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { TRACKS_BY_ID, RUSTFALL } from '../src/content/tracks'
import { resetAI } from '../src/sim/ai'
import { CHASSIS } from '../src/content/chassis'
import { PILOTS } from '../src/content/pilots'
import type { SimConfig } from '../src/sim/types'

const trackArg = process.argv.find((a) => a.startsWith('--track='))
const DEF = (trackArg && TRACKS_BY_ID[trackArg.slice(8)]) || RUSTFALL

const cfg: SimConfig = {
  seed: 0x5eed1234, totalLaps: DEF.laps, racerCount: 8, trackId: DEF.id,
  chassisIds: Array.from({ length: 8 }, (_, i) => CHASSIS[i % CHASSIS.length].id),
  pilotIds: Array.from({ length: 8 }, (_, i) => PILOTS[i % PILOTS.length].id),
  localRacerIndex: -1,
  aiSkill: Array.from({ length: 8 }, (_, i) => 2 + (i % 3)),
}
resetAI()
const race = new Race(new Track(DEF), cfg)
const peak = new Array(8).fill(0)
const over5 = new Array(8).fill(0)
let frames = 0
while (frames < 60 * 400 && race.state.phase !== 'finished') {
  race.step(); frames++
  race.state.racers.forEach((r, i) => {
    if (r.boostTime > peak[i]) peak[i] = r.boostTime
    if (r.boostTime > 5) over5[i]++
  })
}
console.log(`${DEF.name}  ${frames} frames`)
console.log('  chassis     peak banked boostTime   frames holding >5s')
race.state.racers.forEach((r, i) => {
  console.log(`  ${r.chassisId.padEnd(10)}  ${peak[i].toFixed(1).padStart(8)}s  ${((over5[i] / frames) * 100).toFixed(0).padStart(20)}%`)
})
