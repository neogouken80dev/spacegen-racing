/**
 * THE GROUND AND THE RAILINGS ARE HARD.
 *
 * Four defects reported from play, in one session:
 *   "at high speeds and drop sections, the vehicle phases into the floor"
 *   "there is similar behavior to the railings of the track as well"
 *   "during the drift my vehicle slows down while i am still on the accelerator"
 *
 * They turned out to be three separate mechanisms and one shared consequence.
 * Each test below was run against the pre-fix build and fails there.
 */
import { describe, it, expect } from 'vitest'
import { Track, type TrackDef, type SurfaceKind } from '../src/sim/track'
import { stepVehicle, orientedInset, bodyInset } from '../src/sim/vehicle'
import { getLocomotion, getDerived, CHASSIS_BY_ID } from '../src/content/chassis'
import { Race } from '../src/sim/race'
import { RUSTFALL, TRACKS_BY_ID } from '../src/content/tracks'
const AETHERION = TRACKS_BY_ID['aetherion']
import { STEER_SIGN } from '../src/sim/vehicle'
import { angleDelta } from '../src/sim/math'
import { TUNING } from '../src/content/tuning'
import type { RacerState, InputFrame, SimConfig } from '../src/sim/types'

function ring(surface: SurfaceKind = 'tarmac', w = 40, R = 260, drop = 0): Track {
  const nodes = []
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2
    // `drop` tilts the ring into a descent on half the loop, so a car can be
    // genuinely falling toward road that is falling away from it.
    nodes.push({ p: [Math.cos(a) * R, Math.sin(a * 2) * drop, Math.sin(a) * R] as [number, number, number], w, surface })
  }
  return new Track({
    id: 'probe', name: 'probe', skyTop: 0, skyBottom: 0, fogColor: 0, fogDensity: 0,
    sunColor: 0, sunIntensity: 1, ambientColor: 0, ambientIntensity: 1, sunDirection: [0, 1, 0],
    palette: { a: 0, b: 0, c: 0, accent: 0 }, nodes, itemBoxRows: [], chargeRuns: [], laps: 3,
  } as TrackDef)
}

function racer(chassisId: string, track: Track, speed: number, s = 0): RacerState {
  const loco = getLocomotion(chassisId)
  const smp = track.at(s)
  const p = track.surfacePoint(s, 0)
  const yaw = Math.atan2(smp.tangent.x, smp.tangent.z)
  return {
    id: 0, chassisId, pilotId: '', isAI: false, isLocal: true, aiSkill: 3,
    pos: { x: p.x, y: p.y + loco.rideHeight, z: p.z },
    vel: { x: Math.sin(yaw) * speed, y: 0, z: Math.cos(yaw) * speed },
    yaw, yawRate: 0, fwd: { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) }, up: { x: 0, y: 1, z: 0 },
    altitude: loco.rideHeight, vertVel: 0, grounded: true, wallTime: 0,
    driftSide: 0, driftCharge: 0, driftTier: -1, driftInward: 1, driftEntry: false, driftTime: 0,
    chainStacks: 0, chainWindow: 0, boostTime: 0, boostMag: 0, boostSource: 'none',
    lift: loco.liftCapacity, liftActive: false, airTime: 0, trickArmed: false,
    rampCooldown: 0, ballisticTime: 0,
    item: null, itemCharges: 0, itemSlot2: null, rouletteTime: 0,
    gatlingTime: 0, gatlingCooldown: 0, beamCharge: 0, beamGrace: 0,
    spinTime: 0, stunTime: 0, immuneTime: 0, invincibleTime: 0,
    slowTime: 0, slowMag: 0, massMult: 1,
    lap: 0, checkpoint: 0, splineS: s, totalS: 0, lateral: 0, position: 1,
    finished: false, finishTime: 0, lapTimes: [], bestLap: 0, charges: 0,
    offTrackTime: 0, respawnTime: 0, respawnPlaced: false, lastHitBy: null, events: [],
  } as unknown as RacerState
}

const drive = (steer: number, drift: boolean): InputFrame =>
  ({ steer, throttle: 1, brake: 0, drift, item: false, itemBack: false, lift: false, lookBack: false })

describe('the deck is a hard barrier', () => {
  it('a car falling fast never ends a frame inside the road', () => {
    // 49 m/s downward is what Aetherion's 35m descent is worth in free fall.
    for (const cid of ['solaire', 'bulwark', 'dray9']) {
      const track = ring('tarmac', 40, 260, 6)
      const r = racer(cid, track, getDerived(cid).topSpeed)
      const loco = getLocomotion(cid)
      const ctx = { track, raceTime: 0, iceCracked: false } as never
      let worstBelow = 0
      for (let f = 0; f < 240; f++) {
        // Re-launch the car upward periodically so it keeps falling back down
        // onto road that is itself dropping away.
        if (f % 40 === 0) { r.vertVel = 26; r.grounded = false }
        ;(ctx as { raceTime: number }).raceTime = f / 60
        r.events.length = 0
        stepVehicle(r, drive(0.15, false), ctx)
        const proj = track.project(r.pos, r.splineS)
        // How far the car's CENTRE sits below where its wheels should be.
        worstBelow = Math.max(worstBelow, loco.rideHeight - proj.height)
      }
      // A tolerance of 12cm covers the suspension spring's own travel; the old
      // build reached 0.8m and stayed there for eight to ten frames.
      expect(worstBelow, `${cid} sank below the deck`).toBeLessThan(0.12)
    }
  })
})

describe('the barrier inset follows the car, not just its width', () => {
  it('a crabbed car reaches further sideways than half its width', () => {
    const r = racer('solaire', ring(), 50)
    const flat = bodyInset('solaire')
    // Square to the barrier: the oriented answer must equal the flat one.
    expect(orientedInset(r, -Math.cos(r.yaw), 0, Math.sin(r.yaw))).toBeCloseTo(flat, 6)
    // Turned 32 degrees -- the drift's own sustained slide angle -- it must not.
    const b = 32 * (Math.PI / 180)
    const y2 = r.yaw + b
    r.fwd = { x: Math.sin(y2), y: 0, z: Math.cos(y2) }
    const crabbed = orientedInset(r, -Math.cos(r.yaw), 0, Math.sin(r.yaw))
    const he = CHASSIS_BY_ID['solaire'].halfExtents
    expect(crabbed).toBeCloseTo(he.x * Math.cos(b) + he.z * Math.sin(b) + 0.12, 5)
    expect(crabbed).toBeGreaterThan(flat + 0.8)
  })

  it('holds the whole body inside the barrier through a drift', () => {
    const track = ring('tarmac', 26, 200)
    const r = racer('solaire', track, getDerived('solaire').topSpeed)
    const he = CHASSIS_BY_ID['solaire'].halfExtents
    const ctx = { track, raceTime: 0, iceCracked: false } as never
    let worstPast = -Infinity
    for (let f = 0; f < 300; f++) {
      ;(ctx as { raceTime: number }).raceTime = f / 60
      r.events.length = 0
      stepVehicle(r, drive(1, true), ctx)
      const proj = track.project(r.pos, r.splineS)
      if (Math.abs(proj.lateral) < proj.sample.width * 0.8) continue
      // Reach of the oriented body along the barrier normal.
      const n = proj.sample.right
      const reach = orientedInset(r, n.x, n.y, n.z) - 0.12
      worstPast = Math.max(worstPast, Math.abs(proj.lateral) + reach - proj.sample.width)
    }
    // The old inset was he.x + 0.12 regardless of heading, so a 32-degree crab
    // put the outside front corner about a metre past the barrier face.
    expect(worstPast, `body past the barrier by ${worstPast.toFixed(2)}m`).toBeLessThan(0.2)
    expect(he.z).toBeGreaterThan(he.x) // the premise: the car is longer than it is wide
  })
})

describe('a barrier charges for the impact, not for the slide', () => {
  it('sliding along a wall costs far less than driving into one', () => {
    const track = ring('tarmac', 30, 240)
    const ctx = { track, raceTime: 0, iceCracked: false } as never

    // (a) Parallel: placed against the wall, travelling ALONG it.
    // CRABBED, which is the whole point: the nose is 30 degrees off the
    // barrier so the velocity has a large component pointing INTO it, while the
    // car's actual lateral offset barely moves. That is a drift running the
    // outside of a corner, and it used to be priced as a 27 m/s collision.
    const along = racer('solaire', track, 55)
    {
      const smp = track.at(0)
      const lat = smp.width * 0.97
      const p = track.surfacePoint(0, lat)
      along.pos = { x: p.x, y: p.y + getLocomotion('solaire').rideHeight, z: p.z }
      along.lateral = lat
      const b = 30 * (Math.PI / 180)
      const y2 = along.yaw - b
      along.fwd = { x: Math.sin(y2), y: 0, z: Math.cos(y2) }
      along.yaw = y2
      // Velocity stays along the road: the CAR is turned, the travel is not.
      along.vel = { x: smp.tangent.x * 55, y: 0, z: smp.tangent.z * 55 }
      along.driftSide = 1
      along.driftInward = 1
    }
    let alongLost = 0
    let prev = Math.hypot(along.vel.x, along.vel.z)
    for (let f = 0; f < 60; f++) {
      ;(ctx as { raceTime: number }).raceTime = f / 60
      along.events.length = 0
      stepVehicle(along, drive(0.06, false), ctx)
      const sp = Math.hypot(along.vel.x, along.vel.z)
      alongLost += Math.max(0, prev - sp); prev = sp
    }

    // (b) Into it: same wall, aimed at it.
    const into = racer('solaire', track, 55)
    {
      const smp = track.at(0)
      const p = track.surfacePoint(0, smp.width - 6)
      into.pos = { x: p.x, y: p.y + getLocomotion('solaire').rideHeight, z: p.z }
      into.lateral = smp.width - 6
      const n = smp.right
      into.vel = { x: n.x * 55, y: 0, z: n.z * 55 }
    }
    let intoLost = 0
    prev = Math.hypot(into.vel.x, into.vel.z)
    for (let f = 0; f < 60; f++) {
      ;(ctx as { raceTime: number }).raceTime = f / 60
      into.events.length = 0
      stepVehicle(into, drive(0, false), ctx)
      const sp = Math.hypot(into.vel.x, into.vel.z)
      intoLost += Math.max(0, prev - sp); prev = sp
    }
    // A real collision must still hurt, and by a wide margin over a scrape.
    expect(intoLost).toBeGreaterThan(alongLost * 3)
    expect(alongLost).toBeLessThan(14)
  })

  it('a lap spent leaning on the barrier stays inside a measured budget', () => {
    // The two mechanisms above -- pricing the impact on the CLOSING RATE rather
    // than on the slide angle, and fading the impact bite over the first 0.18s
    // of unbroken contact -- do different work on different circuits, and this
    // pins both. A line biased hard onto the outside wall for two laps, full
    // throttle, drift held, total ground speed lost while in contact:
    //
    //                        Rustfall   Aetherion
    //   both off (shipped)      243        129
    //   fade only               172        129
    //   severity only           243         87
    //   both (this build)       181         79
    //
    // Rustfall catches the fade being removed; Aetherion catches the severity
    // model being removed. Neither budget is comfortable padding -- they are
    // about 10% above the measured values, so this fails on a real regression
    // and not on a tenth of a metre per second.
    // RE-BASELINED against the firmer aim above (1.45 of half-width). The old
    // 200/100 were measured with a car that only grazed the wall; pressing into
    // it properly costs more, and a budget carried over from a gentler harness
    // would have been slack rather than strict. Measured here: rustfall 176.8,
    // aetherion 132.3. Kept to the same ~10% margin the previous pair used, so
    // this still fails on a real regression rather than on noise.
    //
    // BOTH BUDGETS WERE THEN CHECKED AGAINST AN ACTUAL SABOTAGE rather than
    // assumed to be strict. With contactFade forced to 1, the numbers go 176.8
    // -> 193.0 (rustfall) and 132.3 -> 217.6 (aetherion). Aetherion catches that
    // with room to spare; Rustfall at a 10% margin would NOT have -- 193 slips
    // under 195 -- so its budget is 185 instead, keeping the job the header
    // assigns it. A re-baselined budget that cannot fail is not a test.
    for (const [def, budget] of [[RUSTFALL, 185], [AETHERION, 146]] as const) {
      const track = new Track(def)
      const race = new Race(track, {
        seed: 7, totalLaps: 2, racerCount: 1, trackId: def.id,
        chassisIds: ['solaire'], pilotIds: [''], localRacerIndex: 0, aiSkill: [3],
      } as SimConfig)
      const r = race.state.racers[0]
      let prev = 0
      let lost = 0
      let longest = 0
      for (let f = 0; f < 60 * 200 && race.state.phase !== 'finished'; f++) {
        const proj = track.project(r.pos, r.splineS)
        const k = track.curvatureAt(r.splineS + 10, 24)
        // PRESS INTO THE BARRIER, do not merely aim near it.
      //
      // This was 0.88 of the half-width -- just inside the road -- and it held
      // sustained contact only because the car's line happened to drift out to
      // meet the wall. That made the PREMISE of this test (contact lasting past
      // impactFadeTime) a coincidence of the cornering model rather than
      // something the harness causes, and the first change to the drift arc
      // broke it: swept against boostArcRelief, `longest` came back 0.067,
      // 0.017, 0.033, 0.083 for reliefs of 0.25, 0.45, 0.65, 0.85 -- chaotic,
      // not a trend, which is what a coincidence looks like when you vary
      // something upstream of it.
      //
      // Aiming PAST the edge makes contact the harness's doing. The budgets
      // below were then re-measured against this line, not carried over.
      const want = (k >= 0 ? -1 : 1) * proj.sample.width * 1.45
        const aimYaw = track.yawAt(r.splineS + 22)
        const latErr = (want - proj.lateral) / Math.max(1, proj.sample.width)
        const steer = Math.max(-1, Math.min(1, STEER_SIGN * (angleDelta(r.yaw, aimYaw) * 2.0 - latErr * 1.1)))
        const wasContact = r.wallTime > 0
        race.setInput(0, { steer, throttle: 1, brake: 0, drift: true, item: false, itemBack: false, lift: false, lookBack: false })
        race.step()
        if (race.state.phase !== 'racing') { prev = Math.hypot(r.vel.x, r.vel.y, r.vel.z); continue }
        const sp = Math.hypot(r.vel.x, r.vel.y, r.vel.z)
        longest = Math.max(longest, r.wallTime)
        if (r.wallTime > 0 || wasContact) lost += Math.max(0, prev - sp)
        prev = sp
      }
      // The premise: contact really was sustained past the fade window, so both
      // mechanisms were exercised.
      // eslint-disable-next-line no-console
      if (process.env.SG_MEASURE) console.log(`MEASURE ${def.id} longest=${longest.toFixed(3)} lost=${lost.toFixed(1)}`)
      expect(longest, `${def.id} never held contact`).toBeGreaterThan(TUNING.collision.impactFadeTime)
      expect(lost, `${def.id} lost ${lost.toFixed(0)} m/s to barriers`).toBeLessThan(budget)
    }
  })
})
