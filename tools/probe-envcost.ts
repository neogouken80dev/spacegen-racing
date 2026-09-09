/**
 * ENVIRONMENT DRAW-CALL AND TRIANGLE COST, per track, headless.
 *
 * `tools/smoke.mjs` reports the whole scene — road, cars, VFX pool and HUD
 * included — which is the right number for "does this frame fit in the budget"
 * and the wrong one for "what did the art pass just add". This builds ONLY the
 * environment group, the same way `buildEnvironment` builds it in the game, and
 * counts the draw calls and triangles it contributes.
 *
 *   npx tsx tools/probe-envcost.ts [--track=hollowchoir] [--tier=high|medium|low]
 */
import * as THREE from 'three'
import { Track } from '../src/sim/track'
import { TRACKS } from '../src/content/tracks'
import { buildEnvironment } from '../src/render/environment'
import { QUALITY_PRESETS } from '../src/render/api'

const arg = (k: string, d: string): string =>
  (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=')
const only = arg('track', '')
const tier = arg('tier', 'high') as 'high' | 'medium' | 'low'

for (const def of TRACKS) {
  if (only && def.id !== only) continue
  const track = new Track(def)
  const scene = new THREE.Scene()
  const env = buildEnvironment(track, scene, QUALITY_PRESETS[tier])
  let calls = 0, tris = 0
  const rows: string[] = []
  env.group.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh && !(o as THREE.Points).isPoints) return
    const g = (mesh as THREE.Mesh).geometry as THREE.BufferGeometry
    const idx = g.getIndex()
    const pos = g.getAttribute('position')
    // TWO WAYS TO BE INSTANCED, and this used to count only one of them.
    // InstancedMesh carries its own `count`; a plain Mesh drawing an
    // InstancedBufferGeometry carries it on the GEOMETRY, and the crosswind
    // debris is the second kind (one unit quad, n instances, one draw call).
    // Counted as x1 it reported 2 triangles for 560 quads.
    const ig = g as THREE.InstancedBufferGeometry
    const inst = (mesh as unknown as THREE.InstancedMesh).isInstancedMesh
      ? (mesh as unknown as THREE.InstancedMesh).count
      : ig.isInstancedBufferGeometry
        ? (ig.instanceCount === Infinity ? 1 : ig.instanceCount)
        : 1
    const t = (o as THREE.Points).isPoints
      ? 0
      : Math.round(((idx ? idx.count : pos.count) / 3) * inst)
    calls++; tris += t
    rows.push(`  ${String(t).padStart(7)}  ${(o as THREE.Points).isPoints ? 'points' : `x${inst}`.padStart(6)}  ${mesh.name || o.type}`)
  })
  console.log(`${def.id} @ ${tier}: ${calls} draw calls, ${tris.toLocaleString()} triangles`)
  console.log(rows.sort((a, b) => Number(b.trim().split(/\s+/)[0]) - Number(a.trim().split(/\s+/)[0])).join('\n'))
  env.dispose()
}
