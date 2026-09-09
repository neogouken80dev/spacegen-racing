/**
 * HOW FAR DOES THE WIND SHOVE A DRIVER WHO IS ALREADY STEERING?
 *
 * The acceleration ratio in probe-push.ts is an argument. This is the
 * measurement: run the SAME pursuit controller over the same lap twice, once
 * with hazard.windScale at its authored value and once at 0, and report how
 * much line the wind costs. No full-lock stunts, no walls -- the only
 * difference between the two runs is the wind.
 *
 *   npx tsx tools/probe-hold.ts --track=hollowchoir
 */
import { Race } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { TRACKS_BY_ID } from '../src/content/tracks'
import { resetAI } from '../src/sim/ai'
import { PILOTS } from '../src/content/pilots'
import { STEER_SIGN } from '../src/sim/vehicle'
import { clamp, angleDelta } from '../src/sim/math'
import { TUNING as T } from '../src/content/tuning'
import type { SimConfig, InputFrame } from '../src/sim/types'

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const DEF = TRACKS_BY_ID[arg('track', 'hollowchoir')]
const cid = arg('chassis', 'solaire')

/** One lap. Returns lateral offset sampled every metre of arc length. */
function lap(windScale: number): { lat: Float64Array; hit: number } {
  ;(T.hazard as any).windScale = windScale
  resetAI()
  const track = new Track(DEF)
  const cfg: SimConfig = {
    seed: 7, totalLaps: 2, racerCount: 1, trackId: DEF.id,
    chassisIds: [cid], pilotIds: [PILOTS[0].id], localRacerIndex: 0, aiSkill: [3],
  }
  const race = new Race(track, cfg)
  const r = race.state.racers[0]
  const lat = new Float64Array(Math.ceil(track.length) + 2).fill(NaN)
  let hit = 0, f = 0
  while (f < 60 * 400 && race.state.phase !== 'finished') {
    // TRUE PURSUIT, not heading-matching.
    //
    // The first cut of this probe steered on `angleDelta(r.yaw, track.yawAt(s+24))`
    // -- pure heading match, with NO lateral-offset term at all. Under any
    // constant lateral force that controller drifts without bound, because
    // being 10m off the line does not change its heading error by one degree.
    // So it reported the wind moving the car 156% of the way to the barrier
    // when a large part of that was the driver never trying to come back.
    // Aiming at the POINT rather than matching the BEARING is what a player
    // does and closes lateral error on its own.
    const tgt = track.posAt(r.splineS + 24)
    const want = Math.atan2(tgt.x - r.pos.x, tgt.z - r.pos.z)
    const steer = clamp(STEER_SIGN * angleDelta(r.yaw, want) * 2.2, -1, 1)
    const inp: InputFrame = { steer, throttle: 1, brake: 0, drift: false, item: false, itemBack: false, lift: false, lookBack: false }
    race.setInput(0, inp); race.step(); f++
    if (race.state.phase !== 'racing' || r.lap !== 0) continue
    const i = Math.round(r.splineS)
    if (i >= 0 && i < lat.length && Number.isNaN(lat[i])) lat[i] = r.lateral
    if (r.wallTime > 0) hit++
  }
  return { lat, hit }
}

const authored = T.hazard.windScale
const on = lap(authored), off = lap(0)
;(T.hazard as any).windScale = authored

const track = new Track(DEF)
let worst = 0, worstS = 0, sumR = 0, sumL = 0, n = 0
for (let i = 0; i < on.lat.length; i++) {
  if (Number.isNaN(on.lat[i]) || Number.isNaN(off.lat[i])) continue
  const d = on.lat[i] - off.lat[i]   // + = wind pushed the car RIGHT of where it would be
  if (Math.abs(d) > Math.abs(worst)) { worst = d; worstS = i }
  if (d > 0) sumR += d; else sumL += -d
  n++
}
console.log(`${DEF.name} / ${cid} — one lap, same driver, wind ON vs wind OFF\n`)
console.log(`  samples compared:        ${n} m of lap`)
console.log(`  pushed RIGHT (total):    ${sumR.toFixed(0)} m-of-offset`)
console.log(`  pushed LEFT  (total):    ${sumL.toFixed(0)} m-of-offset`)
console.log(`  worst single point:      ${worst >= 0 ? '+' : ''}${worst.toFixed(2)} m at s=${worstS}  (half-width there ${track.at(worstS).width.toFixed(1)} m)`)
console.log(`  wall-contact frames:     wind on ${on.hit}   wind off ${off.hit}`)
console.log()
console.log(`  --- LATERAL ERROR AT EACH ITEM ROW (the reported complaint) ---`)
console.log(`      a row is a ${'4.0-4.4'}m spread of 2.4m boxes, so >2m off line is a miss\n`)
for (const row of DEF.itemBoxRows) {
  const s = Math.round(row.at * track.length)
  let d = NaN
  for (let k = 0; k < 30 && Number.isNaN(d); k++) {
    const i = (s + k) % on.lat.length
    if (!Number.isNaN(on.lat[i]) && !Number.isNaN(off.lat[i])) d = on.lat[i] - off.lat[i]
  }
  const tag = Number.isNaN(d) ? 'no data' : `${d >= 0 ? '+' : ''}${d.toFixed(2)} m  ${Math.abs(d) > 2 ? '<-- MISS' : 'ok'}`
  console.log(`      row at ${String(s).padStart(5)}m   wind cost ${tag}`)
}
console.log()
const halfW = track.at(worstS).width
if (Math.abs(worst) > halfW * 0.75) console.log(`  VERDICT: the wind alone moves the car ${(100 * Math.abs(worst) / halfW).toFixed(0)}% of the way to the barrier.`)
else console.log(`  VERDICT: worst displacement is ${(100 * Math.abs(worst) / halfW).toFixed(0)}% of the half-width.`)
