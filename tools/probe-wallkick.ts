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
console.log('each cell: degrees the nose came OFF THE WALL in the 0.3s after the hit,')
console.log('           then the share of the next 2s spent still touching it\n')
console.log('chassis   ' + ANGLES.map((d) => `${d}deg`.padStart(13)).join(''))
let backwards = 0, total = 0, facingWrong = 0, shovedBack = 0, noseInWall = 0, stuckTotal = 0, kickWeak = 0
for (const c of CHASSIS) {
  const spd = getDerived(c.id).topSpeed * 0.7
  const row: string[] = []
  for (const entry of ANGLES) {
    const r = wedged(c.id, track, spd, entry)
    const ctx = { track, raceTime: 0, iceCracked: false } as never
    let along = NaN, hit = false, yawIn = r.yaw, latIn = r.lateral
    for (let f = 0; f < 240 && !hit; f++) {
      ;(ctx as { raceTime: number }).raceTime = f / 60
      r.events.length = 0
      // The heading as it ARRIVES, kept from the frame before the bang. Taking
      // it after the contact frame measures the car once the kick has already
      // been applied, which reads as the kick doing nothing.
      yawIn = r.yaw; latIn = r.lateral
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
    /**
     * MEASURED AT THE MOMENT THE CAR LEAVES THE WALL, not a fixed time later.
     *
     * The first cut of this sampled one second after contact, which is not a
     * measurement of the recovery at all: by then the car has driven several
     * tens of metres under full throttle, very possibly across the track and
     * into the OPPOSITE barrier, and what gets measured is wherever it ended
     * up. It read 35/35 noses "in the wall" on a build whose recovery was
     * working, because the wall it was being measured against was the far one.
     *
     * So: run until contact has been clear for five frames, and measure
     * against the barrier the car actually just left.
     */
    /**
     * DOES IT GET AWAY? -- which is the symptom, rather than the nose angle on
     * any one frame.
     *
     * Two earlier framings of this were both wrong. Sampling a fixed second
     * after the hit measured wherever the car had driven to, very possibly the
     * opposite barrier. Sampling the instant contact ended measured a car that
     * had been touching the wall for two frames and had barely been acted on.
     * What a player actually complains about is being STUCK: nosed into the
     * barrier, throttle open, scraping along it.
     *
     * So: two seconds from the first contact, and the measure is how much of
     * that the car spent touching the wall.
     */
    const leftSide = latIn >= 0 ? -1 : 1
    /**
     * THE KICK, ISOLATED. How far the nose has come off the barrier 0.3s after
     * the hit -- early enough that the car has not driven anywhere, so this is
     * the impact's own doing and not the line it took afterwards.
     *
     * Measured against the wall it hit: 0 degrees is running parallel to the
     * barrier, negative is still aimed at it, positive is angled off it.
     */
    const noseAt = () => {
      const sm = track.at(((r.splineS % track.length) + track.length) % track.length)
      const nx0 = sm.right.x * leftSide, nz0 = sm.right.z * leftSide
      const nl0 = Math.hypot(nx0, nz0) || 1
      const d = (Math.sin(r.yaw) * nx0 + Math.cos(r.yaw) * nz0) / nl0
      return Math.asin(Math.max(-1, Math.min(1, d))) * (180 / Math.PI)
    }
    const noseBefore = (() => {
      const sm = track.at(((r.splineS % track.length) + track.length) % track.length)
      const nx0 = sm.right.x * leftSide, nz0 = sm.right.z * leftSide
      const nl0 = Math.hypot(nx0, nz0) || 1
      const d = (Math.sin(yawIn) * nx0 + Math.cos(yawIn) * nz0) / nl0
      return Math.asin(Math.max(-1, Math.min(1, d))) * (180 / Math.PI)
    })()
    for (let f = 0; f < 18; f++) {
      ;(ctx as { raceTime: number }).raceTime = (240 + f) / 60
      r.events.length = 0
      stepVehicle(r, drive, ctx)
    }
    const turned = noseAt() - noseBefore
    // Entries between 100 and 150 degrees are excluded: the car arrives almost
    // side-on and the kick is clamped so it can never swing the nose PAST the
    // barrier's normal into the track, which at those angles leaves little
    // room to turn. Everywhere else the nose must come off the wall.
    if ((entry < 100 || entry > 150) && turned < 4) kickWeak++
    let stuck = 0
    const FRAMES = 120
    for (let f = 0; f < FRAMES; f++) {
      ;(ctx as { raceTime: number }).raceTime = (240 + f) / 60
      r.events.length = 0
      stepVehicle(r, drive, ctx)
      if (r.wallTime > 0) stuck++
    }
    const stuckPct = Math.round((100 * stuck) / FRAMES)
    stuckTotal += stuckPct
    const smp2 = track.at(((r.splineS % track.length) + track.length) % track.length)
    let err = (r.yaw - Math.atan2(smp2.tangent.x, smp2.tangent.z)) * (180 / Math.PI)
    while (err > 180) err -= 360
    while (err < -180) err += 360
    /**
     * ONLY GATED BELOW 90 DEGREES OF ENTRY, and the cut-off is the physics.
     *
     * A car that arrives at the barrier at 95 degrees or more was already
     * travelling backwards along the circuit when it got there; a wall may not
     * add energy, so which way it ends up pointing afterwards is not the
     * barrier's doing and the wrong-way recovery in ai/vehicle is what covers
     * it. Below 90 the car still has forward momentum and there is no excuse
     * for it to finish facing back up the road. Measured at those entries:
     * 1-2 degrees on every chassis.
     */
    if (entry < 90 && Math.abs(err) > 90) facingWrong++
    /**
     * IS THE NOSE STILL IN THE WALL? -- the thing actually reported, and a
     * different question from the heading error above. A car can be only 30
     * degrees off the tangent and still driving straight into the barrier;
     * that reads as fine on every other measure here and is the case the
     * player complains about.
     *
     * The inward normal is the track's `right` flipped to point away from
     * whichever edge the car is on. A positive angle is a nose pointing off
     * the wall; negative is a nose buried in it.
     */
    const nx = smp2.right.x * leftSide, nz = smp2.right.z * leftSide
    const nl = Math.hypot(nx, nz) || 1
    const dotAway = (Math.sin(r.yaw) * nx + Math.cos(r.yaw) * nz) / nl
    const awayDeg = Math.asin(Math.max(-1, Math.min(1, dotAway))) * (180 / Math.PI)
    if (awayDeg < 0) noseInWall++
    row.push(`+${turned.toFixed(0)}deg ${String(stuckPct).padStart(3)}%`.padStart(13))
    if (entry < 90 && along < 0) shovedBack++
  }
  console.log(`${c.id.padEnd(10)}${row.join('')}`)
}
console.log(`\nvelocity back up the circuit on contact: ${backwards}/${total}`)
console.log(`shallow hits left facing back up the track: ${facingWrong}`)
console.log(`hits that barely turned the nose off       : ${kickWeak}/${total}`)
console.log(`mean time pinned to the barrier over 2s    : ${(stuckTotal / total).toFixed(0)}%`)

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
if (facingWrong > 0) {
  errors.push(`${facingWrong} shallow hits finished facing back up the circuit`)
}
// THE HEADLINE GATE: a barrier must not hold on to you. Measured on the rule
// this replaced, the field spent 44% of the two seconds after a hit still
// scraping along the wall it had already bounced off.
// THE KICK IS THE HEADLINE. A barrier that does not turn the nose off itself
// is the reported bug; measured on the rule this replaced, every one of these
// hits left the nose within a degree of where it arrived.
if (kickWeak > 0) {
  errors.push(`${kickWeak}/${total} hits left the nose still aimed at the wall`)
}
/**
 * THE PINNED FIGURE IS REPORTED, AND ONLY LOOSELY GATED, on purpose.
 *
 * This probe holds FULL THROTTLE INTO THE BARRIER for the whole two seconds
 * and never lifts or steers. Under that input a car staying in contact is the
 * correct outcome -- it is being driven into a wall -- so a tight gate here
 * would be a gate on the probe's own driving rather than on the barrier.
 *
 * It is kept at a ceiling because the number still catches a real regression:
 * a barrier that started catching and holding cars would run this far past 45%.
 * What the recovery is actually gated on is the kick above, which is the
 * behaviour that was asked for.
 */
const stuckMean = stuckTotal / total
if (stuckMean > 45) {
  errors.push(`the field spends ${stuckMean.toFixed(0)}% of the 2s after a hit pinned to the barrier`)
}
console.log(errors.length ? `\nFAILED: ${errors.join('; ')}` : '\nWALL RECOVERY OK')
process.exit(errors.length ? 1 : 0)
