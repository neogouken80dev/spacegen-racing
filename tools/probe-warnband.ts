/**
 * THE TURN WARNING BAND: IS IT ON THE OUTSIDE WALL, AND DOES IT POINT THE WAY
 * THE ROAD GOES?
 *
 * `trackMesh.ts` paints a chevron board into the barrier on the outside of
 * every turn. The whole feature hangs off ONE sign convention -- that
 * `side * curvatureAt(s)` is positive exactly on the outside wall -- and
 * getting that backwards paints arrows on the inside barrier pointing away
 * from the corner, which is worse for a driver than painting nothing. It is
 * also completely invisible to every other gate in the repo: the geometry does
 * not move, the draw calls do not change, and the sim never sees it.
 *
 * So this measures the shipped MESH, not the source. It builds the real track
 * visual, reads the attributes the fragment shader will read, recomputes the
 * band exactly as the shader does, and then checks WHICH WALL each painted
 * vertex is on against an outside-of-the-turn test that shares no arithmetic
 * with the thing under test: the two offset paths are walked and the longer
 * one is the outside. That is a fact about the road, not about a sign
 * convention, so flipping the sign anywhere in trackMesh.ts fails this gate.
 *
 *   npx tsx tools/probe-warnband.ts [--track=emberfall] [--quiet]
 *
 * SABOTAGE-CONFIRMED, all three ways it can go wrong. Run, not reasoned about:
 *
 *   - negate the curvature `emitWall` writes (`kLo = fi === 0 ? -kA : 0`) and
 *     all eight circuits fail with 2,820-6,884 painted vertices on the INSIDE
 *     wall and ZERO on the outside. Nothing else in the repo notices.
 *   - drop the inner-face mask (write `kA`/`kB` on all three faces) and all
 *     eight fail with 4,764-11,490 vertices outboard of the road edge -- the
 *     cap and the outer skirt are two of the three faces, so most of the band
 *     ends up where no driver can see it and the infield can see nothing else.
 *   - drop the +/- 9 m kernel in `cornerCurvature` and four circuits fail: the
 *     band swings 0.88 (Meridian Deep s=1844), 0.41 (Ashkar s=4290) and 0.37
 *     (Halcyon Bay s=2104) of full strength and back inside six metres, and
 *     Zhen-9 puts four vertices on the inside wall in its corkscrew.
 *
 * It also reports what the band actually covers, because "it is on the right
 * wall" and "it is where a driver needs it" are different claims: the share of
 * the AI's own corner metres (|k| > 0.0045, its drift-hold gate) that carry a
 * full-strength board, the metres painted on road that is straight, and the
 * worst there-and-back brightness swing on one wall -- which is the blink the
 * feature produces on a rolling road if the curvature is left unfiltered.
 */
import * as THREE from 'three'
import { Track } from '../src/sim/track'
import { TRACKS } from '../src/content/tracks'
import { buildTrackVisual } from '../src/render/trackMesh'
import { QUALITY_PRESETS } from '../src/render/api'

const arg = (k: string, d: string): string =>
  (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=')
const only = arg('track', '')
const quiet = process.argv.includes('--quiet')

/**
 * The shader's own numbers, repeated. They are repeated rather than exported
 * because they live inside a GLSL string and there is nothing to import; the
 * cost of that is this comment. If the band's ramp moves in trackMesh.ts and
 * not here, the coverage figures below go quietly wrong -- the OUTSIDE-WALL
 * gate does not, because it only cares about the sign.
 */
const WARN_LO = 0.0018
const WARN_HI = 0.0045
/** stepAI holds a drift above this. The sim's own line between bend and corner. */
const AI_CORNER = 0.0045
/** Vertex kinds that are barrier. KIND_WALL, KIND_BOUNCE, KIND_FWALL. */
const WALL_KINDS = new Set([1, 2, 5])

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * Which side of the road is the outside of the turn at `s`, measured.
 *
 * Walks both edges of the ribbon and returns the side whose path is longer,
 * which is the outside of a bend for the same reason the outside lane of a
 * running track is longer. Deliberately shares NOTHING with `curvatureAt` --
 * no tangents, no cross products, no sign convention -- so it cannot agree
 * with the mesh by inheriting the same mistake.
 *
 * THE WINDOW IS s..s+20, NOT A SYMMETRIC ONE, AND THAT MATTERS.
 *
 * The first version of this probe walked +/- 26 m about s and reported 16-236
 * "wrong side" vertices on six of the eight circuits. Every one of them was
 * the probe being wrong, and they were all in the same place: an inflection.
 * At Elkarim s=1874 the curvature runs +0.0125 at s-24 and -0.0121 at s+12, so
 * a window straddling s describes TWO corners and returns whichever is
 * stronger -- there, the one already behind the driver. The mesh reads
 * `curvatureAt(s, 20)`, i.e. the road from s to s+20, and paints the barrier
 * at s with the corner that is about to arrive, which is the whole point of a
 * warning. Measuring the claim over a different window measures a different
 * claim. So the window is the mesh's window and only the METHOD is independent.
 *
 * THE NORMAL COMPONENT OF EACH STEP IS THROWN AWAY, AND THAT MATTERS TOO.
 *
 * A raw 3-D path length is not a turn measurement on a road that rolls. Where
 * the bank is coming on, the two edges sweep up and down as well as around,
 * and that vertical sweep is length neither edge got from the corner: at
 * Meridian Deep s=1920 (`right.y` going -0.05 to -0.35 across the window) the
 * raw 3-D split is 1.0% and points the wrong way, while the plan split is 18%
 * and the road is genuinely turning in the surface the car is driving on.
 * Projecting each step into the local surface plane removes the roll and
 * leaves the geodesic offset length, which is the same surface `curvatureAt`
 * measures about on a gravity track and the same surface the driver steers in.
 */
function outsideSide(track: Track, s: number, win = 20): -1 | 0 | 1 {
  let lenL = 0, lenR = 0
  for (let d = 0; d < win; d++) {
    const p = track.at(s + d), q = track.at(s + d + 1)
    const nx = (p.normal.x + q.normal.x) / 2
    const ny = (p.normal.y + q.normal.y) / 2
    const nz = (p.normal.z + q.normal.z) / 2
    const n2 = nx * nx + ny * ny + nz * nz || 1
    for (const sgn of [-1, 1] as const) {
      const px = p.pos.x + p.right.x * sgn * p.width
      const py = p.pos.y + p.right.y * sgn * p.width
      const pz = p.pos.z + p.right.z * sgn * p.width
      const qx = q.pos.x + q.right.x * sgn * q.width
      const qy = q.pos.y + q.right.y * sgn * q.width
      const qz = q.pos.z + q.right.z * sgn * q.width
      let dx = qx - px, dy = qy - py, dz = qz - pz
      const dn = (dx * nx + dy * ny + dz * nz) / n2
      dx -= dn * nx; dy -= dn * ny; dz -= dn * nz
      const l = Math.hypot(dx, dy, dz)
      if (sgn < 0) lenL += l; else lenR += l
    }
  }
  const split = (lenR - lenL) / ((lenR + lenL) / 2)
  if (Math.abs(split) < OUTSIDE_TOL) return 0
  return split > 0 ? 1 : -1
}

/**
 * How far apart the two offset paths have to be before this probe will name an
 * outside, as a fraction of their mean length.
 *
 * MEASURED, not chosen. Across all eight circuits, every sample with
 * |k| > 0.0032 (the band at half strength or better) was scored both ways:
 *
 *     split      agree   disagree
 *     0 -  2%       53         49
 *     2 -  4%       48          1
 *     4 - 12%      155          0
 *    12 - 900%   10215          0
 *
 * The two methods agree on every one of the 10,370 samples where the road
 * bends enough for a path comparison to resolve it, and disagree only in the
 * band where the two edges are the same length to within 2% -- which is road
 * that is barely bending, where "which side is outside" is decided by spline
 * noise and residual cross-slope rather than by a corner. 4% is the floor of
 * the empty column, and it is nowhere near loose enough to hide a flipped
 * sign: a flip makes all 10,370 of those disagree, not 50.
 */
const OUTSIDE_TOL = 0.04

/**
 * The worst brightness swing the band makes on ONE wall inside `win` metres,
 * as a fraction of full strength.
 *
 * THIS REPLACED A SHORTEST-RUN / SHORTEST-GAP MEASUREMENT, WHICH WAS THE WRONG
 * INSTRUMENT. That one thresholded the band at half strength and reported the
 * shortest continuous ON run and OFF gap. It flagged 1.5 m "gaps" on six
 * circuits -- and a 1.5 m stretch where the band dips from 0.52 to 0.48 is not
 * a gap, it is a ramp passing a number. What a driver can actually see is
 * AMPLITUDE over DISTANCE: the board going bright, dark and bright again in
 * six metres is a blink at 60 m/s; the same six metres of a 0.1 wobble is
 * nothing. So this measures the excursion, and the threshold went away.
 *
 * A handover between the two walls at an inflection is not counted, because
 * each wall is walked separately and a handover is monotonic on both.
 *
 * `has` is which samples actually carry a barrier on this side: an `open`
 * section has a drop-off lip instead of a wall, and 600 m of missing barrier
 * on Halcyon Bay is not a swing in anything.
 */
function worstExcursion(band: Float64Array, has: boolean[], res: number, win = 6):
  { amp: number; at: number } {
  const m = band.length
  const n = Math.max(1, Math.round(win / res))
  let amp = 0, at = 0
  for (let i = 0; i < m; i++) {
    let ok = true
    for (let d = 0; d <= n && ok; d++) ok = has[(i + d) % m]
    if (!ok) continue
    let hi = -1, lo = 2
    for (let d = 0; d <= n; d++) {
      const v = band[(i + d) % m]
      hi = Math.max(hi, v); lo = Math.min(lo, v)
    }
    const a = band[i], b = band[(i + n) % m]
    // How far the middle of the window departs from BOTH of its ends. A
    // monotonic ramp scores zero however steep it is; only a there-and-back
    // scores, which is what a blink is.
    const e = Math.max(hi - Math.max(a, b), Math.min(a, b) - lo)
    if (e > amp) { amp = e; at = i * res }
  }
  return { amp, at }
}

/**
 * How big a there-and-back swing is allowed inside six metres.
 *
 * Measured across all eight circuits: 0.79 with the curvature unsmoothed
 * (Meridian Deep s=1847, full board to nothing and back inside the barrel
 * roll), 0.11 with the +/- 9 m kernel `cornerCurvature` now applies. 0.35 sits
 * between them with a 3x margin over what ships and still fails the day the
 * smoothing is removed, which is the regression it exists to catch.
 */
const MAX_BLINK = 0.35

interface Row { id: string; fails: string[] }
const rows: Row[] = []
let anyFail = false

for (const def of TRACKS) {
  if (only && def.id !== only) continue
  const track = new Track(def)
  const m = track.samples.length
  const res = track.length / m
  const vis = buildTrackVisual(track, QUALITY_PRESETS.high)

  /** Per-sample band strength on each wall, filled from the MESH attributes. */
  const bandPos = new Float64Array(m)   // side = +1 barrier
  const bandNeg = new Float64Array(m)   // side = -1 barrier
  /** Which samples actually carry a barrier on each side (an `open` one does not). */
  const hasPos = new Array<boolean>(m).fill(false)
  const hasNeg = new Array<boolean>(m).fill(false)
  let paintedOnOpen = 0
  let wallVerts = 0, paintedVerts = 0, offFaceVerts = 0, dirtyChannels = 0
  let wrongSide = 0, rightSide = 0, undecided = 0
  let calls = 0, tris = 0
  const wrongExamples: string[] = []

  vis.group.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const g = mesh.geometry as THREE.BufferGeometry
    const idx = g.getIndex()
    calls++
    tris += Math.round((idx ? idx.count : g.getAttribute('position').count) / 3)
    const trk = g.getAttribute('aTrack')
    const mix = g.getAttribute('aMix')
    const pos = g.getAttribute('position')
    if (!trk || !mix || !pos) return
    for (let i = 0; i < trk.count; i++) {
      const kind = trk.getW(i)
      if (!WALL_KINDS.has(kind)) continue
      wallVerts++
      const s = trk.getX(i)
      const uM = trk.getY(i)          // side * width; its SIGN is the side
      const k = mix.getX(i)           // signed curvature, inner face only
      if (mix.getY(i) !== 0 || mix.getZ(i) !== 0 || mix.getW(i) !== 0) dirtyChannels++
      const smpI = Math.min(m - 1, Math.max(0, Math.round((s / track.length) * m) % m))
      if (uM > 0) hasPos[smpI] = true; else hasNeg[smpI] = true
      if (k === 0) continue
      // The inner face is the only one that spans h = 0; the cap sits at 1.0
      // and the outer skirt bottoms out at 0.30. A non-zero curvature anywhere
      // outside the inner face means the mask in emitWall has come undone and
      // the band is about to paint down the outside of the barrier.
      const side = Math.sign(uM)
      const lean = side * k
      const warn = smoothstep(WARN_LO, WARN_HI, lean)
      if (warn <= 0) continue
      // IS THIS VERTEX ON THE FACE THE DRIVER CAN SEE?
      //
      // Asked of the POSITION, because the height coordinate cannot answer it:
      // the inner face runs h 0..1, the cap sits at h 1.0 and the outer skirt
      // runs 1.0 down to 0.30, so every face lives inside the same 0..1 and a
      // range check on h passes all three. The barrier's cross-section does
      // separate them though -- the inner face leans INBOARD from the road
      // edge, and the cap and skirt stand 0.55 m and 0.67 m OUTBOARD of it --
      // so the lateral offset from the centreline is the test. This is what
      // fails if emitWall ever stops masking the curvature to face 0 and the
      // warning starts painting down the outside of every wall on the lap,
      // which no screenshot taken from the road would ever show.
      // The EXACT sample the mesh built this vertex from, not `track.at(s)`.
      // The interpolated frame is a different frame: on Ashkar's corkscrew and
      // Meridian Deep's roll it lags the sample's own `right` by enough to
      // throw a 0.3 m lateral test, and it reported 14-34 false outboard hits
      // before this line read the sample directly.
      const smp = track.samples[smpI]
      const lateral = (pos.getX(i) - smp.pos.x) * smp.right.x
                    + (pos.getY(i) - smp.pos.y) * smp.right.y
                    + (pos.getZ(i) - smp.pos.z) * smp.right.z
      if (Math.abs(lateral) > smp.width + 0.30) offFaceVerts++
      paintedVerts++
      // Record the strongest band seen at this sample on this wall.
      if (side > 0) bandPos[smpI] = Math.max(bandPos[smpI], warn)
      else bandNeg[smpI] = Math.max(bandNeg[smpI], warn)
      if (track.samples[smpI].open) paintedOnOpen++
      // The gate. Only assert where the band is actually strong: near the
      // ramp's floor the road is barely bending and "which side is outside"
      // is a question about spline noise.
      if (warn < 0.5) continue
      const out = outsideSide(track, s)
      if (out === 0) { undecided++; continue }
      if (out === side) rightSide++
      else {
        wrongSide++
        if (wrongExamples.length < 4) {
          wrongExamples.push(`s=${s.toFixed(0)}m painted on side ${side > 0 ? '+1' : '-1'}, outside is ${out > 0 ? '+1' : '-1'} (k=${k.toFixed(5)})`)
        }
      }
    }
  })
  vis.dispose()

  /* ---- coverage, measured against the sim's own idea of a corner --------- */
  const kAt = new Float64Array(m)
  for (let i = 0; i < m; i++) kAt[i] = track.curvatureAt((i / m) * track.length, 20)
  let cornerM = 0, cornerCovered = 0, straightM = 0, straightPainted = 0
  let bandM = 0, bothM = 0, cornerNoWall = 0
  for (let i = 0; i < m; i++) {
    const best = Math.max(bandPos[i], bandNeg[i])
    const walled = hasPos[i] || hasNeg[i]
    if (best > 0.05) bandM += res
    if (bandPos[i] > 0.05 && bandNeg[i] > 0.05) bothM += res
    // Corner metres are counted only where there is a barrier to paint. An
    // `open` corner carries a drop-off lip instead, which is a different and
    // louder hazard read, and no amount of shader will put a board on it.
    if (Math.abs(kAt[i]) > AI_CORNER) {
      if (!walled) cornerNoWall += res
      else { cornerM += res; if (best > 0.95) cornerCovered += res }
    }
    // A straight: flatter than R = 1250 m. Painting here would be the "do not
    // paint chevrons down straights" failure.
    if (Math.abs(kAt[i]) < 0.0008) { straightM += res; if (best > 0.05) straightPainted += res }
  }

  /* ---- strobe: the shortest ON run and OFF gap on ONE wall -------------- */
  // A handover between the two walls at an inflection is correct behaviour. A
  // short ON run, or a short OFF gap inside an otherwise painted stretch of
  // the SAME wall, is the flicker this feature could produce if the ramp were
  // narrowed. Measured per wall around the loop.
  let blink = 0, blinkAt = 0
  for (const [band, has] of [[bandPos, hasPos], [bandNeg, hasNeg]] as const) {
    const r = worstExcursion(band, has, res)
    if (r.amp > blink) { blink = r.amp; blinkAt = r.at }
  }

  const fails: string[] = []
  if (wrongSide > 0) fails.push(`${wrongSide} painted vertices are on the INSIDE wall (${rightSide} on the outside). e.g. ${wrongExamples.join('; ')}`)
  if (offFaceVerts > 0) fails.push(`${offFaceVerts} painted vertices sit outboard of the road edge -- the band is on the cap or the outer skirt, not the face a driver sees`)
  if (dirtyChannels > 0) fails.push(`${dirtyChannels} wall vertices have a non-zero aMix.yzw -- the wall is meant to leave those three lanes alone`)
  if (straightPainted > 12) fails.push(`${straightPainted.toFixed(0)}m of band on road flatter than R=1250m`)
  if (paintedOnOpen > 0) fails.push(`${paintedOnOpen} painted vertices sit on an open (barrier-less) sample`)
  if (cornerM > 0 && cornerCovered / cornerM < 0.80) fails.push(`only ${(100 * cornerCovered / cornerM).toFixed(0)}% of the AI's corner metres carry a full board`)
  if (blink > MAX_BLINK) fails.push(`the band swings ${blink.toFixed(2)} of full strength and back inside 6m at s=${blinkAt.toFixed(0)} -- that is a blink, not a sign`)
  if (fails.length) anyFail = true
  rows.push({ id: def.id, fails })

  if (!quiet) {
    console.log(`${def.name} (${def.id}) -- ${track.length.toFixed(0)}m, ${calls} track draw calls, ${tris.toLocaleString()} triangles`)
    console.log(`  wall vertices ${wallVerts.toLocaleString()}, carrying a board ${paintedVerts.toLocaleString()} (${(100 * paintedVerts / wallVerts).toFixed(0)}%)`)
    console.log(`  outside-wall check (independent offset-path test): ${rightSide} correct, ${wrongSide} wrong, ${undecided} too straight to call`)
    console.log(`  band on ${bandM.toFixed(0)}m of lap (${(100 * bandM / track.length).toFixed(0)}%), on both walls at once ${bothM.toFixed(0)}m`)
    console.log(`  AI corner metres |k|>0.0045 with a barrier: ${cornerM.toFixed(0)}m, full board over ${cornerCovered.toFixed(0)}m (${(100 * cornerCovered / Math.max(1, cornerM)).toFixed(0)}%); ${cornerNoWall.toFixed(0)}m of corner is open road with no barrier to paint`)
    console.log(`  straight metres |k|<0.0008: ${straightM.toFixed(0)}m, painted ${straightPainted.toFixed(0)}m`)
    console.log(`  worst there-and-back swing inside 6m on one wall: ${blink.toFixed(2)} at s=${blinkAt.toFixed(0)}m (limit ${MAX_BLINK})`)
    for (const f of fails) console.log(`  FAIL: ${f}`)
    console.log('')
  }
}

if (anyFail) {
  console.error('GATE FAILED:')
  for (const r of rows) for (const f of r.fails) console.error(`  ${r.id}: ${f}`)
  process.exit(1)
}
console.log(`turn warning band: CLEAR on ${rows.length} circuit(s) -- every board is on the outside wall`)
