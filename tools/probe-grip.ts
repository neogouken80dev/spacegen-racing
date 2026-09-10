/**
 * DOES SURFACE GRIP ACTUALLY BITE, OUTSIDE A DRIFT?
 *
 * The build-status READ-FIRST item says it does not -- "three ice grip values,
 * identical trajectory to under a millimetre". If that is still true, moving a
 * slick from inside a corner to its approach accomplishes nothing and the
 * level-design change is theatre. The lateral block has been rewritten since
 * that measurement, so this asks again rather than trusting either doc.
 *
 * The rig is TEST_PLAIN -- a 3000m-radius, 400m-wide, perfectly flat ring, so
 * a car can hold a constant steering input for ten seconds without ever
 * touching a wall. Constant stick, constant throttle, surface swapped
 * underneath. The number that matters is the LATERAL ACCELERATION the car
 * actually achieves: if grip bites, ice must cap lower than tarmac and the
 * traced circle must be wider.
 *
 *   npx tsx tools/probe-grip.ts
 */
import { Track, SURFACE_GRIP, type SurfaceKind, type TrackDef } from '../src/sim/track'
import { Race } from '../src/sim/race'
import { resetAI } from '../src/sim/ai'
import { PILOTS } from '../src/content/pilots'
import { lateralBudget } from '../src/sim/vehicle'
import { getDerived, getLocomotion, CHASSIS } from '../src/content/chassis'
import { TEST_PLAIN } from '../tests/fixtures/testTrack'
import type { SimConfig, InputFrame } from '../src/sim/types'

function resurfaced(k: SurfaceKind): TrackDef {
  return { ...TEST_PLAIN, id: 'grip-' + k, nodes: TEST_PLAIN.nodes.map((n) => ({ ...n, surface: k })) }
}

function run(k: SurfaceKind, chassisId: string, steer: number) {
  resetAI()
  const def = resurfaced(k)
  const track = new Track(def)
  const cfg: SimConfig = {
    seed: 3, totalLaps: 9, racerCount: 1, trackId: def.id,
    chassisIds: [chassisId], pilotIds: [PILOTS[0].id], localRacerIndex: 0, aiSkill: [3],
  }
  const race = new Race(track, cfg)
  const r = race.state.racers[0]
  const inp = (s: number): InputFrame =>
    ({ steer: s, throttle: 1, brake: 0, drift: false, item: false, itemBack: false, lift: false, lookBack: false })

  // 6s straight to reach speed, then 6s of constant lock.
  for (let i = 0; i < 60 * 6; i++) { race.setInput(0, inp(0)); race.step() }
  const spd0 = Math.hypot(r.vel.x, r.vel.y, r.vel.z)
  let prevH = Math.atan2(r.vel.x, r.vel.z)
  let sumLat = 0, n = 0, spd = 0
  for (let i = 0; i < 60 * 6; i++) {
    race.setInput(0, inp(steer)); race.step()
    if (i < 60 * 2) { prevH = Math.atan2(r.vel.x, r.vel.z); continue } // let it settle
    const h = Math.atan2(r.vel.x, r.vel.z)
    let d = h - prevH; prevH = h
    while (d > Math.PI) d -= 2 * Math.PI
    while (d < -Math.PI) d += 2 * Math.PI
    spd = Math.hypot(r.vel.x, r.vel.y, r.vel.z)
    sumLat += Math.abs(d) * 60 * spd; n++       // v * dpsi/dt = lateral accel
  }
  const lat = sumLat / Math.max(1, n)
  return { spd0, spd, lat, radius: lat > 1e-6 ? (spd * spd) / lat : Infinity }
}

for (const cid of ['solaire', 'filament', 'vector7']) {
  const loco = getLocomotion(cid)
  console.log(`\n=== ${CHASSIS.find((c) => c.id === cid)!.name} (${loco === getLocomotion('vector7') ? 'flight' : ''}) — full lock, full throttle ===`)
  console.log('surface   grip   budget   achieved lat   traced radius   speed')
  for (const k of ['tarmac', 'snow', 'gravel', 'ice'] as SurfaceKind[]) {
    const eff = 1 + (SURFACE_GRIP[k] - 1) * loco.surfaceFrictionInfluence
    const b = lateralBudget(getDerived(cid), loco, eff)
    const a = run(k, cid, 1)
    console.log(`${k.padEnd(9)} ${SURFACE_GRIP[k].toFixed(2)}   ${b.toFixed(1).padStart(6)}   ${a.lat.toFixed(2).padStart(12)}   ${a.radius.toFixed(1).padStart(13)}m   ${a.spd.toFixed(1)} m/s`)
  }
}
