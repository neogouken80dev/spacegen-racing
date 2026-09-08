/**
 * "MY CAR SLOWS DOWN MID-DRIFT WITH THE THROTTLE DOWN."
 *
 * Holds full throttle and a full-lock drift on each surface and prints what the
 * ground speed actually does, plus what the friction ellipse is doing to the
 * drive while it happens.
 */
import { Track, type TrackDef, type SurfaceKind } from '../src/sim/track'
import { stepVehicle } from '../src/sim/vehicle'
import { getLocomotion, getDerived } from '../src/content/chassis'
import type { RacerState, InputFrame } from '../src/sim/types'

function ring(surface: SurfaceKind): Track {
  const nodes = []
  const R = 260
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2
    nodes.push({ p: [Math.cos(a) * R, 0, Math.sin(a) * R] as [number, number, number], w: 40, surface })
  }
  return new Track({
    id: 'probe', name: 'probe', skyTop: 0, skyBottom: 0, fogColor: 0, fogDensity: 0,
    sunColor: 0, sunIntensity: 1, ambientColor: 0, ambientIntensity: 1, sunDirection: [0, 1, 0],
    palette: { a: 0, b: 0, c: 0, accent: 0 }, nodes, itemBoxRows: [], chargeRuns: [], laps: 3,
  } as TrackDef)
}

function racer(chassisId: string, track: Track, speed: number): RacerState {
  const loco = getLocomotion(chassisId)
  const smp = track.at(0)
  const p = track.surfacePoint(0, 0)
  const yaw = Math.atan2(smp.tangent.x, smp.tangent.z)
  return {
    id: 0, chassisId, pilotId: 'pip', isAI: false, isLocal: true, aiSkill: 3,
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
    lap: 0, checkpoint: 0, splineS: 0, totalS: 0, lateral: 0, position: 1,
    finished: false, finishTime: 0, lapTimes: [], bestLap: 0, charges: 0,
    offTrackTime: 0, respawnTime: 0, respawnPlaced: false, lastHitBy: null, events: [],
  } as unknown as RacerState
}

const IN: InputFrame = { steer: 1, throttle: 1, brake: 0, drift: true, item: false, itemBack: false, lift: false, lookBack: false }
const surfaces: SurfaceKind[] = ['tarmac', 'gravel', 'snow', 'ice']
console.log('full throttle + full-lock drift, 3 seconds, ground speed m/s')
console.log('  chassis    surface   start   after 1s   2s     3s     top-speed')
for (const cid of ['solaire', 'bulwark', 'dray9', 'filament', 'vector7']) {
  for (const s of surfaces) {
    const track = ring(s)
    const derived = getDerived(cid)
    const r = racer(cid, track, derived.topSpeed)
    const ctx = { track, raceTime: 0, iceCracked: false } as any
    const marks: number[] = []
    let wallHits = 0
    const VERBOSE = process.argv.includes('--verbose') && cid === 'solaire' && s === 'tarmac'
    let prevSpd = Math.hypot(r.vel.x, r.vel.z)
    for (let f = 0; f < 180; f++) {
      ctx.raceTime = f / 60
      r.events.length = 0
      stepVehicle(r, IN, ctx)
      if (r.events.some((e: any) => e.t === 'wall')) wallHits++
      if (VERBOSE) {
        const sp = Math.hypot(r.vel.x, r.vel.z)
        const proj = track.project(r.pos, r.splineS)
        const edge = Math.abs(proj.lateral) / proj.sample.width
        if (prevSpd - sp > 0.3 || f % 20 === 0) {
          console.log(`    f${String(f).padStart(3)} spd ${sp.toFixed(1).padStart(5)} d ${(prevSpd - sp).toFixed(2).padStart(6)} edge ${edge.toFixed(2)} grounded ${r.grounded?1:0} wallT ${r.wallTime.toFixed(2)} alt ${r.altitude.toFixed(2)} tier ${r.driftTier} boostT ${r.boostTime.toFixed(2)} yawRate ${r.yawRate.toFixed(2)}`)
        }
        prevSpd = sp
      }
      if (f === 59 || f === 119 || f === 179) marks.push(Math.hypot(r.vel.x, r.vel.z))
    }
    console.log(`  ${cid.padEnd(10)} ${s.padEnd(8)} ${derived.topSpeed.toFixed(1).padStart(6)} ` +
      marks.map((m) => m.toFixed(1).padStart(7)).join('') + `   wallFrames ${wallHits}`)
  }
}
