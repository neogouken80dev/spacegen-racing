/**
 * WHERE THE LOW-GRIP PATCHES SIT RELATIVE TO THE CORNERS.
 *
 * Reported from play: "there were some oil slicks at corner sections ... it
 * really offers no challenge as opposed to having oil slicks before entry into
 * corners." A slick INSIDE a corner is met by a car that has already chosen its
 * speed and its line; a slick on the APPROACH is a braking decision. This
 * prints every low-grip run on every track and says which it is.
 *
 *   npx tsx tools/probe-slick.ts
 */
import { Track, SURFACE_GRIP } from '../src/sim/track'
import { TRACKS_BY_ID } from '../src/content/tracks'

// The hold gate stepAI uses: above this the road is genuinely turning.
const CORNER_K = 0.0045

for (const id of Object.keys(TRACKS_BY_ID)) {
  const track = new Track(TRACKS_BY_ID[id])
  console.log(`\n=== ${id.toUpperCase()}  ${Math.round(track.length)}m ===`)
  const runs: { surf: string; s0: number; s1: number }[] = []
  let cur: { surf: string; s0: number; s1: number } | null = null
  for (let s = 0; s < track.length; s += 1) {
    const k = track.at(s).surface
    const low = SURFACE_GRIP[k] < 1
    if (low && cur && cur.surf === k) cur.s1 = s
    else if (low) { cur = { surf: k, s0: s, s1: s }; runs.push(cur) }
    else cur = null
  }
  if (!runs.length) { console.log('  no low-grip surface at all'); continue }
  for (const r of runs) {
    if (r.s1 - r.s0 < 4) continue
    // Curvature ACROSS the patch, and on the road it hands you into.
    let kIn = 0, n = 0
    for (let s = r.s0; s <= r.s1; s += 2) { kIn += Math.abs(track.curvatureAt(s, 20)); n++ }
    kIn /= Math.max(1, n)
    let kAfter = 0, m = 0
    for (let s = r.s1; s <= r.s1 + 90; s += 2) { kAfter += Math.abs(track.curvatureAt(s, 20)); m++ }
    kAfter /= Math.max(1, m)
    // The ABSOLUTE gate alone lies here. CORNER_K is the drift-hold gate, a low
    // bar, so a genuine braking zone feeding a hairpin trips it: Rustfall's
    // rehomed oil sits at k 0.0049 (a 204m radius, barely bent) and hands the
    // car into 0.0245 (41m). Calling that "in a corner" is the tool being
    // wrong, not the placement. What separates an approach from a tax is the
    // RATIO -- is the road ahead meaningfully tighter than the road you are on.
    const tightens = kAfter > kIn * 1.8
    const inCorner = kIn > CORNER_K
    const verdict = tightens ? 'on the APPROACH to a corner  <-- what it should be'
      : inCorner ? 'IN A CORNER  <-- the reported problem'
      : 'on a straight, going nowhere'
    console.log(`  ${r.surf.padEnd(7)} ${String(r.s0).padStart(5)}-${String(r.s1).padStart(5)}m `
      + `(${String(r.s1 - r.s0).padStart(4)}m, grip ${SURFACE_GRIP[r.surf as keyof typeof SURFACE_GRIP].toFixed(2)})  `
      + `k_on ${kIn.toFixed(4)}  k_after ${kAfter.toFixed(4)}   ${verdict}`)
  }
}
