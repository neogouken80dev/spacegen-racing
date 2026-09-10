/** Every authored node with its arc length, curvature, surface and tag. */
import { Track } from '../src/sim/track'
import { TRACKS_BY_ID } from '../src/content/tracks'
const id = process.argv.find((a) => a.startsWith('--track='))?.split('=')[1] ?? 'cryostatic'
const def = TRACKS_BY_ID[id]
const track = new Track(def)
const nodeS = def.nodes.map((n) => {
  let best = 0, bestD = Infinity
  for (let s = 0; s < track.length; s += 1) {
    const q = track.posAt(s)
    const d = (q.x - n.p[0]) ** 2 + (q.y - n.p[1]) ** 2 + (q.z - n.p[2]) ** 2
    if (d < bestD) { bestD = d; best = s }
  }
  return best
})
console.log(`${def.name}  ${Math.round(track.length)}m  (gate |k|>0.0045 = a corner)`)
console.log(' idx      s     |k|    R      surface   tag')
def.nodes.forEach((n, i) => {
  const k = Math.abs(track.curvatureAt(nodeS[i], 20))
  const R = k > 1e-4 ? (1 / k).toFixed(0) + 'm' : 'straight'
  console.log(`${String(i).padStart(4)} ${String(Math.round(nodeS[i])).padStart(6)}  ${k.toFixed(4)} ${R.padStart(8)}  ` +
    `${(n.surface ?? 'tarmac').padEnd(8)} ${k > 0.0045 ? 'CORNER' : '      '} ${(n as any).tag ?? ''}`)
})
