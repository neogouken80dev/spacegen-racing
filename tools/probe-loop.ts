/**
 * CAN THIS ENGINE ACTUALLY DRIVE A LOOP-DE-LOOP?
 *
 * Asked for four new circuits with "loop-de-loops, spirals". The gravity system
 * says yes on paper -- `TrackNode.up` is the road's own anti-gravity direction
 * and `stick` defaults to 1 wherever it leaves world +Y -- but three things
 * could make a full vertical loop unbuildable, and all three are cheaper to
 * find out here than four tracks from now:
 *
 *   1. THE 120-DEGREE GUARD. The bake refuses more than 120 degrees of
 *      up-vector between neighbours. A loop needs enough nodes; how many is
 *      arithmetic, but the constructor is the authority.
 *   2. THE ROAD PASSES OVER ITSELF. A true loop returns to the same (x, z) at a
 *      different y. `Track.project` resolves a world point to a lap position,
 *      and two decks stacked 2R apart is exactly the case that breaks a nearest
 *      -sample search. If a car at the bottom of the loop projects onto the
 *      TOP of it, the sim thinks it is off the road and respawns it.
 *   3. GEODESIC CURVATURE IS ZERO. Known and expected -- `curvatureAt` measures
 *      about the surface normal, and a loop's curvature vector points straight
 *      along that normal. So a loop reads as DEAD STRAIGHT to the AI's corner
 *      braking and to the drift-hold gate. That is not a bug to fix, it is the
 *      fact that decides what a loop is FOR: a set piece you hold the throttle
 *      through, never a corner. Measured here so it is a number, not a belief.
 *
 *   npx tsx tools/probe-loop.ts
 */
import { Track } from '../src/sim/track'
import { Race } from '../src/sim/race'
import type { TrackDef, TrackNode } from '../src/sim/track'

const R = 42
const STEPS = 24 // 15 degrees apart

/** A vertical loop entered at the bottom heading +Z, centred at (0, R, z0). */
function loop(z0: number, w: number): TrackNode[] {
  const out: TrackNode[] = []
  for (let i = 1; i <= STEPS; i++) {
    const th = (2 * Math.PI * i) / STEPS
    out.push({
      p: [0, R - R * Math.cos(th), z0 + R * Math.sin(th)],
      w,
      up: [0, Math.cos(th), -Math.sin(th)],
      tag: i === STEPS / 2 ? 'loop-top' : undefined,
    })
  }
  return out
}

/** Straight run along +Z from z to z+len, level. */
function run(z: number, len: number, n: number, w: number): TrackNode[] {
  return Array.from({ length: n }, (_, i) => ({ p: [0, 0, z + (len * i) / n] as [number, number, number], w }))
}

// A long oval so the field has somewhere to be, with the loop on the back
// straight. The return leg is offset in x so the lap closes without the two
// straights sharing a line.
const nodes: TrackNode[] = [
  ...run(-300, 300, 20, 20),
  ...loop(0, 20),
  ...run(2 * 0, 0, 0, 20), // placeholder, removed below
]
nodes.length = 20 + STEPS
// Close the lap: out to +x, back down -Z, and in again.
const back: TrackNode[] = []
for (let i = 1; i <= 10; i++) {
  const th = (Math.PI * i) / 10
  back.push({ p: [120 - 120 * Math.cos(th), 0, 40 + 120 * Math.sin(th)] as [number, number, number], w: 20 })
}
for (let i = 1; i <= 24; i++) back.push({ p: [240, 0, 40 - (340 * i) / 24] as [number, number, number], w: 20 })
for (let i = 1; i <= 10; i++) {
  const th = (Math.PI * i) / 10
  back.push({ p: [120 + 120 * Math.cos(th), 0, -300 - 120 * Math.sin(th)] as [number, number, number], w: 20 })
}
nodes.push(...back)

const DEF: TrackDef = {
  id: 'probe-loop', name: 'Probe Loop',
  skyTop: 0x101828, skyBottom: 0x2a3550, fogColor: 0x2a3550, fogDensity: 0.0035,
  sunColor: 0xffffff, sunIntensity: 1.0, ambientColor: 0x404860, ambientIntensity: 0.6,
  sunDirection: [0.4, 0.8, 0.3],
  palette: { a: 0x666666, b: 0x888888, c: 0xaaaaaa, accent: 0x44ccff },
  nodes, itemBoxRows: [], chargeRuns: [], laps: 2,
}

// ---- 1. Does it bake at all? ----
let track: Track
try {
  track = new Track(DEF)
} catch (e) {
  console.log('FAILED to bake:', (e as Error).message)
  process.exit(1)
}
console.log(`baked: ${track.length.toFixed(0)}m, ${track.samples.length} samples, ${nodes.length} nodes`)

// ---- 2. What does curvature read through the loop? ----
const topIdx = track.samples.findIndex((_, i) => {
  const s = track.samples[i]
  return s.pos.y > 2 * R - 3
})
if (topIdx < 0) { console.log('FAILED: no sample near the top of the loop'); process.exit(1) }
const topS = topIdx * 1.5
console.log(`loop apex at s=${topS.toFixed(0)}m, y=${track.samples[topIdx].pos.y.toFixed(1)}m`)
const ks: number[] = []
for (let d = -60; d <= 60; d += 10) ks.push(Math.abs(track.curvatureAt(topS + d, 20)))
console.log(`|k| through the apex: ${ks.map((k) => k.toFixed(4)).join(' ')}`)
console.log(`  (the AI's drift-hold gate is 0.0045; a geodesic reads ~0)`)

// ---- 3. Does the projection survive the road passing over itself? ----
// Take a point on the deck at the BOTTOM of the loop and ask the track where it
// is. If it answers with the top of the loop, the sim will think a car down
// here is 84m off the road.
let worstProj = 0
for (let i = 0; i < track.samples.length; i++) {
  const s = track.samples[i]
  const pr = track.project({ x: s.pos.x, y: s.pos.y, z: s.pos.z }, i * 1.5)
  const dy = Math.abs(pr.sample.pos.y - s.pos.y)
  if (dy > worstProj) worstProj = dy
}
console.log(`worst deck self-projection error: ${worstProj.toFixed(2)}m  (must stay near 0)`)

// ---- 4. Can a full field actually get round it? ----
const race = new Race(track, {
  seed: 99, totalLaps: 2, racerCount: 8, trackId: 'probe-loop',
  chassisIds: ['solaire', 'filament', 'bulwark', 'dray9', 'vector7', 'solaire', 'bulwark', 'dray9'],
  pilotIds: Array.from({ length: 8 }, () => ''),
  localRacerIndex: -1, aiSkill: [2, 3, 4, 2, 3, 4, 2, 3],
})
let respawns = 0, invertedFrames = 0
const seenTop = new Set<number>()
for (let f = 0; f < 60 * 300 && race.state.phase !== 'finished'; f++) {
  const before = race.state.racers.map((r) => r.respawnTime)
  race.step()
  race.state.racers.forEach((r, k) => {
    if (r.respawnTime > 0 && before[k] <= 0) respawns++
    if (r.pos.y > 2 * R - 8) { invertedFrames++; seenTop.add(k) }
  })
}
console.log(`\nrace: phase=${race.state.phase}  finished=${race.state.racers.filter((r) => r.finished).length}/8`)
console.log(`respawns: ${respawns}   frames spent near the apex: ${invertedFrames}   racers that got over the top: ${seenTop.size}/8`)

const ok = seenTop.size === 8 && worstProj < 2 && respawns < 12
console.log(ok ? '\nLOOP IS DRIVEABLE' : '\nLOOP IS NOT DRIVEABLE AS AUTHORED')
process.exit(ok ? 0 : 1)
