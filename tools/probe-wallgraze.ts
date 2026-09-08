/**
 * SCRAPING THE OUTSIDE WALL MID-DRIFT.
 *
 * The realistic version of "my car slows down in a drift": full throttle, drift
 * held, and a line biased hard onto the outside barrier through every corner --
 * which is what a player does when a slide runs wide. Reports the speed lost
 * while actually in contact.
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
resetAI()
const track = new Track(DEF)
const race = new Race(track, {
  seed: 7, totalLaps: 2, racerCount: 1, trackId: DEF.id,
  chassisIds: [cid], pilotIds: [PILOTS[0].id], localRacerIndex: 0, aiSkill: [3],
} as SimConfig)
const r = race.state.racers[0]

let prev = 0, lostInContact = 0, contactFrames = 0, worst = 0, f = 0, maxWallT = 0, over3 = 0
while (f < 60 * 200 && race.state.phase !== 'finished') {
  const proj = track.project(r.pos, r.splineS)
  // Aim at the outside of the corner: 88% of half-width, on the outside of the
  // local curvature. Then steer at the resulting point.
  const k = track.curvatureAt(r.splineS + 10, 24)
  const want = (k >= 0 ? -1 : 1) * proj.sample.width * 0.88
  const aimYaw = track.yawAt(r.splineS + 22)
  const lateralErr = (want - proj.lateral) / Math.max(1, proj.sample.width)
  const steer = clamp(STEER_SIGN * (angleDelta(r.yaw, aimYaw) * 2.0 - lateralErr * 1.1), -1, 1)
  const input: InputFrame = { steer, throttle: 1, brake: 0, drift: true, item: false, itemBack: false, lift: false, lookBack: false }
  race.setInput(0, input)
  const wasContact = r.wallTime > 0
  race.step(); f++
  if (race.state.phase !== 'racing') { prev = Math.hypot(r.vel.x, r.vel.y, r.vel.z); continue }
  const spd = Math.hypot(r.vel.x, r.vel.y, r.vel.z)
  if (r.wallTime > maxWallT) maxWallT = r.wallTime
  if (r.wallTime > 3 / 60) over3++
  if (r.wallTime > 0 || wasContact) {
    contactFrames++
    const d = prev - spd
    if (d > 0) { lostInContact += d; if (d > worst) worst = d }
  }
  prev = spd
}
const laps = r.lapTimes.length
console.log(`${DEF.name} / ${cid}: ${contactFrames} contact frames, ${lostInContact.toFixed(0)} m/s lost in contact, worst single frame ${worst.toFixed(1)} m/s, laps ${laps}  maxWallTime ${maxWallT.toFixed(3)}s  frames past 3 of contact ${over3}`)
