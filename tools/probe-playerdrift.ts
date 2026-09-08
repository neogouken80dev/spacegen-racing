/**
 * DRIVE IT LIKE THE PLAYER DOES.
 *
 * Holds FULL THROTTLE, NO BRAKE and the drift button down for a whole lap while
 * a simple pursuit controller keeps the car on the racing line, and reports
 * every frame that loses ground speed anyway. This is the reported bug's exact
 * conditions: "during the drift my vehicle slows down while I am still on the
 * accelerator".
 */
import { Race } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { TRACKS_BY_ID, RUSTFALL } from '../src/content/tracks'
import { resetAI } from '../src/sim/ai'

import { PILOTS } from '../src/content/pilots'
import { STEER_SIGN } from '../src/sim/vehicle'
import { clamp, angleDelta } from '../src/sim/math'
import type { SimConfig, InputFrame } from '../src/sim/types'

const trackArg = process.argv.find((a) => a.startsWith('--track='))
const DEF = (trackArg && TRACKS_BY_ID[trackArg.slice(8)]) || RUSTFALL
const cid = (process.argv.find((a) => a.startsWith('--chassis=')) ?? '--chassis=solaire').split('=')[1]

const cfg: SimConfig = {
  seed: 7, totalLaps: 3, racerCount: 1, trackId: DEF.id,
  chassisIds: [cid], pilotIds: [PILOTS[0].id], localRacerIndex: 0, aiSkill: [3],
}
resetAI()
const track = new Track(DEF)
const race = new Race(track, cfg)
const r = race.state.racers[0]

let prev = 0
let worst: { drop: number; s: number; spd: number; dt: number; surf: string; edge: number; steer: number }[] = []
let f = 0
while (f < 60 * 200 && race.state.phase !== 'finished') {
  // Pursuit: aim 24m up the road, hold full throttle and the drift button.
  const aim = track.yawAt(r.splineS + 24)
  const steer = clamp(STEER_SIGN * angleDelta(r.yaw, aim) * 2.2, -1, 1)
  const input: InputFrame = { steer, throttle: 1, brake: 0, drift: true, item: false, itemBack: false, lift: false, lookBack: false }
  race.setInput(0, input)
  race.step(); f++
  if (race.state.phase !== 'racing') { prev = Math.hypot(r.vel.x, r.vel.y, r.vel.z); continue }
  const spd = Math.hypot(r.vel.x, r.vel.y, r.vel.z)
  const drop = prev - spd
  const proj = track.project(r.pos, r.splineS)
  const edge = Math.abs(proj.lateral) / proj.sample.width
  if (drop > 0.35 && r.driftSide !== 0 && r.grounded && r.wallTime === 0 && edge < 1.0
      && r.respawnTime <= 0 && r.spinTime <= 0 && r.slowTime <= 0 && r.boostTime <= 0) {
    worst.push({ drop, s: r.splineS, spd, dt: r.driftTime, surf: proj.sample.surface, edge, steer })
  }
  prev = spd
}
worst.sort((a, b) => b.drop - a.drop)
const total = worst.reduce((a, b) => a + b.drop, 0)
console.log(`${DEF.name} / ${cid}: ${f} frames, ${worst.length} in-drift loss frames on FULL THROTTLE, ${total.toFixed(0)} m/s lost in total`)
for (const w of worst.slice(0, 10)) {
  console.log(`   -${w.drop.toFixed(2).padStart(5)} m/s  s=${w.s.toFixed(0).padStart(5)}  driftTime ${w.dt.toFixed(2)}s  steer ${w.steer.toFixed(2).padStart(5)}  ${w.surf.padEnd(7)} edge ${w.edge.toFixed(2)}  now ${w.spd.toFixed(1)}`)
}
