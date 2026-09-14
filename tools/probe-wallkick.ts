/**
 * WHICH WAY DOES A WALL HAND THE CAR BACK?
 *
 * The ask was that a hit into a barrier should return the car pointing down the
 * circuit, so a player can get going again instead of untangling themselves
 * from a recovery that pointed the wrong way. That is a claim about DIRECTION,
 * and nothing else in the repo measures direction after a wall contact --
 * walls.test.ts measures energy, barriers.test.ts measures penetration and
 * cost. Both would pass with the recovery aimed at oncoming traffic.
 *
 * So: put a car into the outer barrier already facing the wrong way -- the case
 * worth helping, and the case the old rule made worse -- and measure the
 * heading it comes off with, plus whether its along-track velocity ends up
 * positive.
 *
 *   npx tsx tools/probe-wallkick.ts
 */
import { Track, type TrackDef } from '../src/sim/track'
import { stepVehicle } from '../src/sim/vehicle'
import { getLocomotion, getDerived } from '../src/content/chassis'
import { CHASSIS } from '../src/content/chassis'
import { Race } from '../src/sim/race'
import { PILOTS } from '../src/content/pilots'
import type { RacerState, InputFrame } from '../src/sim/types'

function ring(w = 40, R = 260): Track {
  const nodes = []
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2
    nodes.push({ p: [Math.cos(a) * R, 0, Math.sin(a) * R] as [number, number, number], w, surface: 'tarmac' as const })
  }
  return new Track({
    id: 'probe', name: 'probe', skyTop: 0, skyBottom: 0, fogColor: 0, fogDensity: 0,
    sunColor: 0, sunIntensity: 1, ambientColor: 0, ambientIntensity: 1, sunDirection: [0, 1, 0],
    palette: { a: 0, b: 0, c: 0, accent: 0 }, nodes, itemBoxRows: [], chargeRuns: [], laps: 3,
  } as TrackDef)
}

/**
 * A real racer from a real Race, then moved against the outer barrier facing
 * `headingDeg` off the tangent. Built through Race rather than by hand because
 * RacerState has grown a lot of fields and a hand-rolled one silently produces
 * NaN inside Track.project rather than a missing-property error.
 */
function wedged(chassisId: string, track: Track, speed: number, headingDeg: number): RacerState {
  const race = new Race(track, {
    seed: 1, totalLaps: 3, racerCount: 1, trackId: 'probe',
    chassisIds: [chassisId], pilotIds: [PILOTS[0].id], localRacerIndex: 0, aiSkill: [3],
  })
  const r = race.state.racers[0]
  const loco = getLocomotion(chassisId)
  const s = 40
  const smp = track.at(s)
  // Just inside the barrier, so the contact happens on the probe's own clock
  // rather than on frame zero with the car already buried in it.
  const lat = smp.width * 0.80
  const p = track.surfacePoint(s, lat)
  const tanYaw = Math.atan2(smp.tangent.x, smp.tangent.z)
  const yaw = tanYaw + headingDeg * (Math.PI / 180)
  r.pos.x = p.x; r.pos.y = p.y + loco.rideHeight; r.pos.z = p.z
  r.vel.x = Math.sin(yaw) * speed; r.vel.y = 0; r.vel.z = Math.cos(yaw) * speed
  r.yaw = yaw
  r.fwd.x = Math.sin(yaw); r.fwd.y = 0; r.fwd.z = Math.cos(yaw)
  r.splineS = s; r.totalS = s; r.lateral = lat
  r.grounded = true; r.altitude = loco.rideHeight
  return r
}

const drive: InputFrame = {
  throttle: 1, brake: 0, steer: 0, drift: false, item: false, fire: false, look: 0,
} as unknown as InputFrame

const track = ring()
console.log('AFTER THE FIRST WALL CONTACT, per entry angle (degrees off the tangent,')
console.log('all of them aimed INTO the barrier). "along" is the velocity component')
console.log('down the circuit -- negative means the car was sent back up it.\n')
const ANGLES = [60, 80, 95, 115, 135, 155, 170]
console.log('each cell: along-track m/s on contact / heading error 1s later\n')
console.log('chassis   ' + ANGLES.map((d) => `${d}deg`.padStart(13)).join(''))
let backwards = 0, total = 0, facingWrong = 0, shovedBack = 0
for (const c of CHASSIS) {
  const spd = getDerived(c.id).topSpeed * 0.7
  const row: string[] = []
  for (const entry of ANGLES) {
    const r = wedged(c.id, track, spd, entry)
    const ctx = { track, raceTime: 0, iceCracked: false } as never
    let along = NaN, hit = false
    for (let f = 0; f < 240 && !hit; f++) {
      ;(ctx as { raceTime: number }).raceTime = f / 60
      r.events.length = 0
      stepVehicle(r, drive, ctx)
      if (r.events.some((e) => e.t === 'wall')) {
        hit = true
        const smp = track.at(((r.splineS % track.length) + track.length) % track.length)
        along = r.vel.x * smp.tangent.x + r.vel.z * smp.tangent.z
      }
    }
    total++
    if (!hit) { row.push('no contact'.padStart(13)); continue }
    if (along < 0) backwards++
    // ...and where the NOSE is pointing a second later, which is what decides
    // whether the player can simply drive out of it. A wall cannot add energy,
    // so at steep entry angles some backwards travel is unavoidable; what is
    // avoidable is being left facing the wrong way while it bleeds off.
    for (let f = 0; f < 60; f++) {
      ;(ctx as { raceTime: number }).raceTime = (240 + f) / 60
      r.events.length = 0
      stepVehicle(r, drive, ctx)
    }
    const smp2 = track.at(((r.splineS % track.length) + track.length) % track.length)
    let err = (r.yaw - Math.atan2(smp2.tangent.x, smp2.tangent.z)) * (180 / Math.PI)
    while (err > 180) err -= 360
    while (err < -180) err += 360
    if (Math.abs(err) > 90) facingWrong++
    row.push(`${along.toFixed(1)} / ${Math.abs(err).toFixed(0)}deg`.padStart(13))
    if (entry < 90 && along < 0) shovedBack++
  }
  console.log(`${c.id.padEnd(10)}${row.join('')}`)
}
console.log(`\nvelocity back up the circuit on contact: ${backwards}/${total}`)
console.log(`still facing the wrong way a second later : ${facingWrong}/${total}`)

/**
 * TWO GATES, AND DELIBERATELY NOT A THIRD.
 *
 * There is no gate on `backwards` as a whole, because at a steep enough entry
 * most of the car's momentum is already pointing up the circuit and a barrier
 * may not add energy to reverse it -- the `wsp > spd` cap in vehicle.ts is what
 * stops a redirect ever becoming a push, and it is load-bearing. Demanding a
 * forward result at 170 degrees would be demanding the wall break that rule.
 *
 * What IS demanded: a car that arrived still travelling down the circuit must
 * never leave the contact travelling up it, and the recovery has to get the
 * nose pointing roughly the right way. Measured before the fix, on the shipped
 * rule that took `dir` from the car's own along-wall velocity: 25/25 sent back
 * up the circuit at up to -51 m/s, and 25/25 still broadside a second later.
 */
const errors: string[] = []
if (shovedBack > 0) {
  errors.push(`${shovedBack} cars arrived moving FORWARD and were sent back up the circuit`)
}
if (facingWrong / total > 0.3) {
  errors.push(`${facingWrong}/${total} still facing the wrong way a second after the hit`)
}
console.log(errors.length ? `\nFAILED: ${errors.join('; ')}` : '\nWALL RECOVERY OK')
process.exit(errors.length ? 1 : 0)
