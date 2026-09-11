/**
 * DOES THE CAR HOLD ITS MARK?
 *
 * Three reports, one question: the view shifting left and right through
 * corners, the car wandering off its position, and a loop or a jump putting
 * the car somewhere unplayable. All three are "where does the car land in the
 * frame", so all three are measurable as one number.
 *
 * Projects the car through the real camera every frame of a lap and reports
 * the spread of its screen position -- overall, and separately for the frames
 * where the car is INVERTED, which is the case that was unplayable.
 *
 *   npx tsx tools/probe-anchor.ts --track=hollowchoir
 */
import * as THREE from 'three'
import { Race } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { TRACKS_BY_ID } from '../src/content/tracks'
import { resetAI } from '../src/sim/ai'
import { PILOTS } from '../src/content/pilots'
import { ChaseCamera } from '../src/game/camera'
import { TUNING as T } from '../src/content/tuning'
import type { SimConfig } from '../src/sim/types'

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const id = arg('track', 'hollowchoir')
const def = TRACKS_BY_ID[id]

function lap(anchorOn: boolean, trail: number) {
  ;(T.camera as any).anchorStrength = anchorOn ? 1 : 0
  ;(T.camera as any).trailDamp = trail
  resetAI()
  const track = new Track(def)
  const cfg: SimConfig = {
    seed: 9, totalLaps: 2, racerCount: 8, trackId: def.id,
    chassisIds: Array.from({ length: 8 }, (_, i) => ['solaire','filament','bulwark','dray9','vector7'][i % 5]),
    pilotIds: Array.from({ length: 8 }, (_, i) => PILOTS[i % PILOTS.length].id),
    localRacerIndex: -1, aiSkill: Array.from({ length: 8 }, () => 3),
  }
  const race = new Race(track, cfg)
  const r = race.state.racers[0]
  const chase = new ChaseCamera(16 / 9)
  // Racer 0 must be AI-DRIVEN or it never moves and the lap never happens --
  // the first version of this probe fed idle input to the local racer and
  // collected zero samples for exactly that reason.
  const topSpeed = 62
  const p = new THREE.Vector3()
  const xs: number[] = [], ys: number[] = [], inx: number[] = [], iny: number[] = []
  const off: any[] = []
  let f = 0
  while (f < 60 * 200 && r.lap < 1) {
    race.step(); f++
    if (race.state.phase !== 'racing') continue
    chase.update(r, 1 / 60, topSpeed, false, false)
    const cam = chase.camera
    cam.updateMatrixWorld(true)
    p.set(r.pos.x, r.pos.y, r.pos.z).project(cam)
    if (p.z > 1) continue
    const sx = (p.x + 1) / 2, sy = (1 - p.y) / 2
    xs.push(sx); ys.push(sy)
    if (r.up.y < 0.2) { inx.push(sx); iny.push(sy) }   // on the wall or inverted
    if (sx < 0 || sx > 1 || sy < 0 || sy > 1) off.push({ f, sx, sy, resp: r.respawnTime, up: r.up.y })
  }
  const st = (a: number[]) => {
    if (!a.length) return { n: 0, mean: NaN, sd: NaN, lo: NaN, hi: NaN }
    const m = a.reduce((x, y) => x + y, 0) / a.length
    const sd = Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length)
    return { n: a.length, mean: m, sd, lo: Math.min(...a), hi: Math.max(...a) }
  }
  return { x: st(xs), y: st(ys), ix: st(inx), iy: st(iny), off, total: xs.length }
}

const fmt = (s: any) => `mean ${s.mean.toFixed(3)}  sd ${s.sd.toFixed(4)}  range ${s.lo.toFixed(3)}-${s.hi.toFixed(3)}`
console.log(`${def.name} — where the car lands in the frame, one lap, 8 cars\n`)
for (const [label, on, trail] of [['BEFORE (no anchor, full trail)', false, 0], ['AFTER  (anchor + trailDamp)', true, 0.72]] as const) {
  const a = lap(on, trail)
  console.log(`  ${label}`)
  console.log(`    x: ${fmt(a.x)}`)
  console.log(`    y: ${fmt(a.y)}`)
  console.log(`    frames with the car OFF SCREEN: ${a.off.length} of ${a.total}` +
    (a.off.length ? `   first few: ${a.off.slice(0,3).map((o:any)=>`f${o.f} (${o.sx.toFixed(2)},${o.sy.toFixed(2)}) respawn=${o.resp.toFixed(1)}`).join('  ')}` : ''))
  if (a.ix.n) {
    console.log(`    INVERTED / wall frames (${a.ix.n}):`)
    console.log(`      x: ${fmt(a.ix)}`)
    console.log(`      y: ${fmt(a.iy)}`)
  }
  console.log()
}
console.log(`  target from the reference frame: x 0.502, y 0.812`)
