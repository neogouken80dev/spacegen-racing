/**
 * WHAT IS STANDING IN THE ROAD?
 *
 * Reported from play on The Hollow Choir: "there is what seems to be a lampost
 * object that is on the left side of the track, near the end of the track. It
 * is out of place and seems placed in the middle of the track."
 *
 * tests/track.test.ts already asserts that no prop reaches into the road, and
 * it passes -- because it samples VERTICES. A lamp mast is a tall thin box:
 * its only vertices are at the two ends, one on the ground well below the deck
 * and one in the air well above it, so a mast whose MIDDLE passes through the
 * road has no vertex anywhere near the band and clears the fixture by
 * construction. The theme's own placement test knew about this failure mode
 * and sampled six points up the shaft -- but at FRACTIONS of the height, so on
 * a 20 m mast the gaps are 8 m and the airspace band is only 7.5 m tall.
 *
 * This samples along every EDGE instead, which is what actually finds it.
 *
 *   npx tsx tools/probe-intrude.ts --track=hollowchoir
 */
import * as THREE from 'three'
import { Track } from '../src/sim/track'
import { TRACKS_BY_ID } from '../src/content/tracks'
import { buildEnvironment } from '../src/render/environment'
import { QUALITY_PRESETS } from '../src/render/api'
import { TUNING as T } from '../src/content/tuning'

const id = process.argv.find((a) => a.startsWith('--track='))?.split('=')[1] ?? 'hollowchoir'
const track = new Track(TRACKS_BY_ID[id])
const EDGE = T.offTrack.edgeTolerance, RACER = T.collision.racerRadius
const m = track.samples.length

const CELL = 40
const grid = new Map<string, number[]>()
const frames = track.samples.map((s, i) => {
  const f = { x: s.pos.x, y: s.pos.y, z: s.pos.z, rx: s.right.x, ry: s.right.y, rz: s.right.z, w: s.width, i }
  const gi = Math.floor(f.x / CELL), gj = Math.floor(f.z / CELL)
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
    const k = `${gi + a},${gj + b}`
    const arr = grid.get(k); if (arr) arr.push(i); else grid.set(k, [i])
  }
  return f
})
const inv = frames.map((f) => 1 / Math.hypot(f.rx, f.rz) || 1)

function reach(x: number, y: number, z: number) {
  const cands = grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`)
  if (!cands) return null
  let out: { pen: number; dy: number; s: number } | null = null
  for (const i of cands) {
    const f = frames[i]
    const dx = x - f.x, dz = z - f.z
    const alongLat = dx * f.rx + dz * f.rz
    if ((dx * dx + dz * dz) - alongLat * alongLat > 0.81) continue
    const lat = alongLat * inv[i]
    const pen = f.w * EDGE + RACER - Math.abs(lat)
    if (pen <= 0) continue
    const dy = y - (f.y + f.ry * Math.max(-f.w, Math.min(f.w, lat)))
    if (!out || pen > out.pen) out = { pen, dy, s: (i / m) * track.length }
  }
  return out
}

const scene = new THREE.Scene()
const env = buildEnvironment(track, scene, QUALITY_PRESETS.high)
const LO = -0.15, HI = 5.0
const hits: string[] = []

for (const obj of env.group.children) {
  const mesh = obj as THREE.Mesh
  if (!mesh.isMesh || mesh.name === 'sky' || mesh.name === 'terrain') continue
  if (mesh.name === 'wind-debris' || mesh.name === 'heat-shimmer') continue
  if (mesh.name.startsWith('landmark-smelt') || mesh.name === 'crack-ripple') continue
  if (mesh.name === 'bridge-void-decal') continue
  const pos = mesh.geometry.getAttribute('position')
  const idx = mesh.geometry.getIndex()
  const instm = mesh as unknown as THREE.InstancedMesh
  const count = instm.isInstancedMesh ? instm.count : 1
  const mat = new THREE.Matrix4(), a = new THREE.Vector3(), b = new THREE.Vector3(), p = new THREE.Vector3()
  mesh.updateMatrix()
  const tri = idx ? idx.count / 3 : pos.count / 3
  for (let n = 0; n < count; n++) {
    if (instm.isInstancedMesh) instm.getMatrixAt(n, mat); else mat.copy(mesh.matrix)
    for (let t = 0; t < tri; t++) {
      for (let e = 0; e < 3; e++) {
        const i0 = idx ? idx.getX(t * 3 + e) : t * 3 + e
        const i1 = idx ? idx.getX(t * 3 + ((e + 1) % 3)) : t * 3 + ((e + 1) % 3)
        a.set(pos.getX(i0), pos.getY(i0), pos.getZ(i0)).applyMatrix4(mat)
        b.set(pos.getX(i1), pos.getY(i1), pos.getZ(i1)).applyMatrix4(mat)
        // SAMPLE ALONG THE EDGE, every ~0.6m. This is the whole difference.
        const len = a.distanceTo(b)
        const steps = Math.min(64, Math.max(1, Math.ceil(len / 0.6)))
        for (let k = 0; k <= steps; k++) {
          p.lerpVectors(a, b, k / steps)
          const r = reach(p.x, p.y, p.z)
          if (!r || r.dy < LO || r.dy > HI) continue
          hits.push(`${mesh.name.padEnd(22)} inst ${String(n).padStart(3)}  ` +
            `${r.pen.toFixed(2)}m inside the edge at s=${r.s.toFixed(0)}m, ${r.dy.toFixed(2)}m above the road  ` +
            `world (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`)
          k = steps + 1; e = 3; t = tri  // one report per instance
        }
      }
    }
  }
}
console.log(`${TRACKS_BY_ID[id].name}: ${hits.length} intruding piece(s)\n`)
for (const h of hits.slice(0, 25)) console.log('  ' + h)
