/**
 * WHY DID I SLOW DOWN? Finds every frame in a real race where a racer LOST
 * ground speed while holding the throttle, and attributes it.
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
  localRacerIndex: -1, aiSkill: Array.from({ length: 8 }, () => 4),
}
resetAI()
const track = new Track(DEF)
const race = new Race(track, cfg)
const prev = new Array(8).fill(0)
type Row = { drop: number; s: number; drift: boolean; edge: number; wall: number; surf: string; ground: boolean; spd: number; cid: string; dt: number; entry: boolean; boost: number }
const rows: Row[] = []
let f = 0
while (f < 60 * 400 && race.state.phase !== 'finished') {
  race.step(); f++
  if (race.state.phase !== 'racing') { race.state.racers.forEach((r, i) => { prev[i] = Math.hypot(r.vel.x, r.vel.y, r.vel.z) }); continue }
  race.state.racers.forEach((r, i) => {
    const spd = Math.hypot(r.vel.x, r.vel.y, r.vel.z)
    const drop = prev[i] - spd
    if (drop > 0.35 && !r.finished && r.respawnTime <= 0 && r.spinTime <= 0 && r.stunTime <= 0 && r.slowTime <= 0) {
      const proj = track.project(r.pos, r.splineS)
      rows.push({
        drop, s: r.splineS, drift: r.driftSide !== 0,
        edge: Math.abs(proj.lateral) / proj.sample.width,
        wall: r.wallTime, surf: proj.sample.surface, ground: r.grounded, spd, cid: r.chassisId,
        dt: r.driftTime, entry: r.driftTime < 0.05, boost: r.boostTime,
      })
    }
    prev[i] = spd
  })
}
rows.sort((a, b) => b.drop - a.drop)
console.log(`${DEF.name}: ${rows.length} frames lost >0.35 m/s on the throttle, out of ${f} frames x 8 racers`)
const inDrift = rows.filter((r) => r.drift)
console.log(`  in a drift: ${inDrift.length}   clean (on track, no wall, grounded): ${
  inDrift.filter((r) => r.edge < 1.0 && r.wall === 0 && r.ground).length}`)
const clean = inDrift.filter((x) => x.edge < 1.0 && x.wall === 0 && x.ground)
const early = clean.filter((r) => r.dt < 0.10)
const totalEarly = early.reduce((a, b) => a + b.drop, 0)
const totalAll = clean.reduce((a, b) => a + b.drop, 0)
console.log(`  of ${clean.length} clean in-drift loss frames, ${early.length} are in the first 0.10s of the slide`)
console.log(`  and they carry ${(100 * totalEarly / Math.max(1e-9, totalAll)).toFixed(0)}% of all the speed lost`)
console.log('  worst 12, with time-into-slide:')
for (const r of clean.slice(0, 12)) {
  console.log(`   -${r.drop.toFixed(1).padStart(5)} m/s  ${r.cid.padEnd(9)} driftTime ${r.dt.toFixed(3)}s  ${r.surf.padEnd(7)}  now ${r.spd.toFixed(1)}`)
}
