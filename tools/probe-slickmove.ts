/**
 * WHERE SHOULD EACH SLICK ACTUALLY GO?
 *
 * Reported from play: a low-grip patch INSIDE a corner "really offers no
 * challenge as opposed to having oil slicks before entry into corners". He is
 * right, and there is a structural reason this project cannot argue with:
 * `TrackNode.surface` applies to the FULL WIDTH of the road at that arc
 * length. There is no lateral resolution in the surface system at all, so a
 * patch in a corner cannot be steered around -- it is a flat tax on everyone,
 * identical every lap. On the APPROACH the same band is a braking decision,
 * which is the only thing a full-width band can be.
 *
 * This proposes, per biting run, the node range that ends at TURN-IN.
 *
 *   npx tsx tools/probe-slickmove.ts
 */
import { Track } from '../src/sim/track'
import { TRACKS_BY_ID } from '../src/content/tracks'

const CORNER_K = 0.0045
/** Only these actually change how the car behaves. metal at 0.95 is flavour. */
const BITES = new Set(['ice', 'gravel', 'oil'])

for (const id of ['rustfall', 'cryostatic']) {
  const def = TRACKS_BY_ID[id]
  const track = new Track(def)

  // Arc length of every authored node, by projecting its own position back
  // onto the baked ribbon. Avoids duplicating the bake's arc-length pass.
  const nodeS = def.nodes.map((n) => {
    const p = { x: n.p[0], y: n.p[1], z: n.p[2] }
    let best = 0, bestD = Infinity
    for (let s = 0; s < track.length; s += 2) {
      const q = track.posAt(s)
      const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2 + (q.z - p.z) ** 2
      if (d < bestD) { bestD = d; best = s }
    }
    return best
  })

  console.log(`\n=== ${id.toUpperCase()}  ${Math.round(track.length)}m, ${def.nodes.length} nodes ===`)

  // Group contiguous biting nodes into runs.
  const runs: { surf: string; i0: number; i1: number }[] = []
  for (let i = 0; i < def.nodes.length; i++) {
    const s = def.nodes[i].surface
    if (!s || !BITES.has(s)) continue
    const last = runs[runs.length - 1]
    if (last && last.surf === s && last.i1 === i - 1) last.i1 = i
    else runs.push({ surf: s, i0: i, i1: i })
  }

  for (const r of runs) {
    const a = nodeS[r.i0], b = nodeS[r.i1]
    const len = (b - a + track.length) % track.length
    // Walk BACK from the middle of the run to find where the corner began.
    const mid = a + len / 2
    const inCorner = Math.abs(track.curvatureAt(mid, 20)) > CORNER_K
    // TURN-IN, defined LOCALLY. The obvious rule -- walk back to the last
    // straight -- collapses on a corner-dense track: Rustfall's bounce
    // corridor and the middle of Cryostatic are corner COMPLEXES with no
    // straight anywhere between corners, so two different patches both walked
    // back 250-570m to the same node and would have stacked on top of each
    // other. On a complex there is no "before the corner".
    //
    // What a driver actually brakes for is the local curvature MINIMUM before
    // this corner's peak -- the moment the last corner has finished unwinding
    // and this one has not yet started. That is well defined whether or not
    // the road ever goes straight, and it is the same point on a lone corner.
    const kAt = (x: number) => Math.abs(track.curvatureAt(x, 20))
    let peak = mid, peakK = kAt(mid)
    for (let d = -len / 2; d <= len / 2; d += 2) {
      const k = kAt(mid + d)
      if (k > peakK) { peakK = k; peak = mid + d }
    }
    let turnIn = peak, best = peakK
    for (let d = 2; d < 400; d += 2) {
      const k = kAt(peak - d)
      if (k < best) { best = k; turnIn = peak - d }
      // Stop once the road is clearly winding INTO something else behind us.
      else if (k > best * 1.6 && best < CORNER_K * 1.5) break
    }
    const band = Math.min(Math.max(len, 45), 110)
    const want0 = turnIn - band, want1 = turnIn
    const pick: number[] = []
    for (let i = 0; i < def.nodes.length; i++) {
      let s = nodeS[i]
      if (s > want1 + track.length / 2) s -= track.length
      if (s >= want0 - 1 && s <= want1 + 1) pick.push(i)
    }
    console.log(`  ${r.surf.padEnd(7)} nodes ${r.i0}-${r.i1}  s ${Math.round(a)}-${Math.round(b)}m (${Math.round(len)}m)  ` +
      `${inCorner ? 'IN CORNER' : 'on a straight'}`)
    console.log(`      turn-in at ${Math.round(turnIn)}m  ->  want s ${Math.round(want0)}-${Math.round(want1)}m ` +
      `= nodes [${pick.join(', ')}]  (currently ${pick.map((i) => def.nodes[i].surface ?? 'tarmac').join('/')})`)
  }
}
