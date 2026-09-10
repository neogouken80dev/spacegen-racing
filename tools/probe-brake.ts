/**
 * DOES A SLICK COST YOU ANY BRAKING DISTANCE?
 *
 * The whole case for moving a slick from inside a corner to its APPROACH is
 * that it turns a tax into a braking decision. That only works if braking is
 * grip-sensitive. vehicle.ts says, in as many words, that it deliberately is
 * not -- "ONLY DRIVE IS LIMITED. Braking is left alone on purpose". This
 * measures it rather than trusting the comment either way.
 */
import { Track, type SurfaceKind, type TrackDef } from '../src/sim/track'
import { Race } from '../src/sim/race'
import { resetAI } from '../src/sim/ai'
import { PILOTS } from '../src/content/pilots'
import { TEST_PLAIN } from '../tests/fixtures/testTrack'
import type { SimConfig, InputFrame } from '../src/sim/types'

function stop(k: SurfaceKind) {
  resetAI()
  const def: TrackDef = { ...TEST_PLAIN, id: 'brake-' + k, nodes: TEST_PLAIN.nodes.map((n) => ({ ...n, surface: k })) }
  const track = new Track(def)
  const race = new Race(track, { seed: 3, totalLaps: 9, racerCount: 1, trackId: def.id,
    chassisIds: ['solaire'], pilotIds: [PILOTS[0].id], localRacerIndex: 0, aiSkill: [3] } as SimConfig)
  const r = race.state.racers[0]
  const go: InputFrame = { steer: 0, throttle: 1, brake: 0, drift: false, item: false, itemBack: false, lift: false, lookBack: false }
  const brake: InputFrame = { ...go, throttle: 0, brake: 1 }
  for (let i = 0; i < 60 * 14; i++) { race.setInput(0, go); race.step() }
  const v0 = Math.hypot(r.vel.x, r.vel.y, r.vel.z)
  const s0 = r.splineS
  let n = 0
  while (Math.hypot(r.vel.x, r.vel.y, r.vel.z) > 5 && n < 60 * 30) { race.setInput(0, brake); race.step(); n++ }
  return { v0, dist: r.splineS - s0, t: n / 60 }
}
console.log('Solaire, full throttle to terminal, then 100% brake to 5 m/s.\n')
console.log('surface   entry speed   distance to stop   time')
for (const k of ['tarmac', 'gravel', 'ice'] as SurfaceKind[]) {
  const a = stop(k)
  console.log(`${k.padEnd(9)} ${a.v0.toFixed(1).padStart(9)} m/s ${a.dist.toFixed(1).padStart(15)} m ${a.t.toFixed(2).padStart(7)}s`)
}
