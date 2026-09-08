/**
 * THE TRACK CRITIC'S RULER.
 *
 * Measures a built track against GDD page 05 -- the corner-class grammar, the
 * structural element specs and the lap authoring checklist -- and against the
 * friction budget that `src/sim/vehicle.ts` actually enforces.
 *
 * It exists because "Class A sweeper, 145m radius" is a claim in a beat sheet
 * and the ribbon is a closed Catmull-Rom through 47 waypoints. The two agree
 * only by accident, and until the friction budget landed nothing checked. The
 * one number this tool exists to print is the LAST column of the corner table:
 * whether a corner's speed limit is below the speed a car would otherwise
 * carry there -- because a corner whose limit is above top speed is a straight
 * with scenery, whatever radius it measures.
 *
 * Usage:
 *   npx tsx tools/probe-track.ts                 # both tracks
 *   npx tsx tools/probe-track.ts --track=cryostatic
 *   npx tsx tools/probe-track.ts --csv           # corner table as CSV
 */
import { Track, SURFACE_GRIP, type SurfaceKind } from '../src/sim/track'
import { TRACKS } from '../src/content/tracks'
import { CHASSIS, getDerived, getLocomotion } from '../src/content/chassis'
import { TUNING as T } from '../src/content/tuning'
import { lateralBudget, cornerSpeedAt } from '../src/sim/vehicle'

const argv = process.argv.slice(2)
const arg = (k: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1]
const has = (k: string): boolean => argv.includes(`--${k}`)

// --------------------------------------------------------------------------
// GDD page 05 grammar, as data.
// --------------------------------------------------------------------------
const GRAMMAR = {
  classA: 110,          // >= 110m
  classB: 55,           // 55-110m
  classC: 20,           // 20-55m
  primaryStraight: 400, // >= 400m, exactly one
  secondaryStraight: [150, 300] as [number, number],
  widthMin: 18, widthMax: 26, widthHardFloor: 14,
  elevationRange: 40,
  sustainedGrade: 0.12,
  lapTime: [55, 75] as [number, number],
}

/** A corner is only a corner once it has turned this far. */
const CORNER_MIN_TURN = (22 * Math.PI) / 180
/** Curvature under this reads as straight (R > 260m). */
const STRAIGHT_K = 1 / 260

type Corner = {
  index: number
  s0: number
  s1: number
  length: number
  turnDeg: number
  dir: 'L' | 'R'
  rMean: number
  rMin: number
  sAtMin: number
  bankDeg: number
  widthMin: number
  surfaceAtMin: SurfaceKind
  /**
   * THE BINDING POINT: the place in the corner where the speed limit is lowest
   * for the reference chassis, which is NOT the same as the tightest point once
   * surfaces differ. Cryostatic's lake sweeper is exactly this case -- its
   * tightest radius sits on snow and its ice sits on a wider arc, so a table
   * keyed on the tightest radius reports the corner as a snow corner and the
   * ice never appears at all.
   */
  rAtBind: number
  surfaceAtBind: SurfaceKind
  sAtBind: number
  surfaces: Map<SurfaceKind, number>
  fragile: boolean
  tags: string[]
}

const cls = (r: number): 'A' | 'B' | 'C' | 'kink' =>
  r >= GRAMMAR.classA ? 'A' : r >= GRAMMAR.classB ? 'B' : r >= GRAMMAR.classC ? 'C' : 'kink'

// --------------------------------------------------------------------------
// The friction budget, per chassis, per surface.
// --------------------------------------------------------------------------
type Roster = { id: string; name: string; loco: string; top: number; budget: (g: number) => number }
const roster: Roster[] = CHASSIS.map((c) => {
  const d = getDerived(c.id)
  const l = getLocomotion(c.id)
  return {
    id: c.id, name: c.name, loco: c.locomotion, top: d.topSpeed,
    budget: (surfaceGrip: number) => lateralBudget(d, l, surfaceGrip),
  }
})

/** Effective surface grip a class feels. All three are 1.0 influence now. */
const effSurface = (r: Roster, su: SurfaceKind): number => {
  const infl = (T.locomotion as any)[r.loco].surfaceFrictionInfluence as number
  return 1 + (SURFACE_GRIP[su] - 1) * infl
}

const limitFor = (r: Roster, su: SurfaceKind, radius: number): number =>
  cornerSpeedAt(r.budget(effSurface(r, su)), 1 / radius)

const REF = roster.find((r) => r.id === 'solaire')!

/**
 * Local curvature from the heading swept over a fixed arc window, which is
 * what a car actually meets. `Track.curvatureAt` with a 15m window: short
 * enough to find the apex of a Class C, long enough not to read sample noise.
 */
function curvature(track: Track, s: number): number {
  return track.curvatureAt(s - 7.5, 15)
}

/** Which authored node tags fall inside [s0, s1]. */
function tagsIn(track: Track, s0: number, s1: number): string[] {
  const out: string[] = []
  for (const node of track.def.nodes) {
    if (!node.tag) continue
    // Nearest sample to the node, then its arc length.
    let best = 0, bestD = Infinity
    for (let i = 0; i < track.samples.length; i++) {
      const p = track.samples[i].pos
      const d = (p.x - node.p[0]) ** 2 + (p.y - node.p[1]) ** 2 + (p.z - node.p[2]) ** 2
      if (d < bestD) { bestD = d; best = i }
    }
    const s = (best / track.samples.length) * track.length
    const inSpan = s1 >= s0
      ? (s >= s0 - 12 && s <= s1 + 12)
      : (s >= s0 - 12 || s <= s1 + 12)
    if (inSpan) out.push(node.tag)
  }
  return out
}

function findCorners(track: Track): Corner[] {
  const m = track.samples.length
  const ds = track.length / m
  const k: number[] = []
  for (let i = 0; i < m; i++) k.push(curvature(track, (i / m) * track.length))

  // Segment into signed runs above the straight threshold, allowing a short
  // dip below it (a corner with a momentary flat spot is still one corner).
  const GAP = Math.max(2, Math.round(14 / ds))
  const runs: { i0: number; i1: number; sign: number }[] = []
  let i = 0
  while (i < m) {
    if (Math.abs(k[i]) < STRAIGHT_K) { i++; continue }
    const sg = Math.sign(k[i])
    let j = i, last = i, gap = 0
    while (j < m + i) {
      const idx = j % m
      if (Math.sign(k[idx]) === sg && Math.abs(k[idx]) >= STRAIGHT_K) { last = j; gap = 0 }
      else if (++gap > GAP) break
      j++
    }
    runs.push({ i0: i, i1: last, sign: sg })
    i = last + 1
  }

  /**
   * SPLIT DOUBLE-APEX RUNS.
   *
   * Rustfall's bounce corridor and its cargo ring turn the same way with no
   * straight between them, so a sign-run merges 213 degrees of two different
   * corners into one 113m "Class A" that exists nowhere on the track: the two
   * real apexes measure 76m and 49m. A run is cut at the flattest point
   * between two apexes whenever that point is materially straighter than both (0.62 of the tighter apex)
   * of them, which is the same thing a driver means by "two corners".
   */
  const APEX_GAP = Math.max(3, Math.round(25 / ds))
  const split: { i0: number; i1: number }[] = []
  for (const run of runs) {
    const idxs: number[] = []
    for (let j = run.i0; j <= run.i1; j++) idxs.push(((j % m) + m) % m)
    const mag = idxs.map((x) => Math.abs(k[x]))
    // Local maxima of |k|, at least APEX_GAP apart, keeping the strongest.
    let apex: number[] = []
    for (let a = 1; a < mag.length - 1; a++) {
      if (mag[a] >= mag[a - 1] && mag[a] > mag[a + 1]) {
        if (apex.length && a - apex[apex.length - 1] < APEX_GAP) {
          if (mag[a] > mag[apex[apex.length - 1]]) apex[apex.length - 1] = a
        } else apex.push(a)
      }
    }
    /**
     * PRUNE BY PROMINENCE, iteratively.
     *
     * A long sweeper's radius wanders -- Rustfall's cargo-ring approach reads
     * 131 / 114 / 130 / 115 / 132 metres over 100m of arc -- and every dip is a
     * local maximum of |k|. Comparing only ADJACENT apexes therefore never
     * splits anything, because a real corner boundary is always separated from
     * the next real apex by one of these wiggles. So the shallow apexes are
     * merged away first: repeatedly drop the weaker of the adjacent pair whose
     * separating minimum is too shallow to be a boundary, until only apexes
     * that are genuinely separated survive.
     */
    const col = (a: number, b: number): number => {
      let lo = Infinity
      for (let x = a; x <= b; x++) lo = Math.min(lo, mag[x])
      return lo
    }
    for (;;) {
      let drop = -1, worst = -Infinity
      for (let a = 0; a + 1 < apex.length; a++) {
        const c = col(apex[a], apex[a + 1])
        const thr = 0.62 * Math.min(mag[apex[a]], mag[apex[a + 1]])
        if (c >= thr) {
          // Shallowest boundary first, so the flattest join is merged away.
          const score = c / Math.max(1e-9, thr)
          if (score > worst) { worst = score; drop = mag[apex[a]] <= mag[apex[a + 1]] ? a : a + 1 }
        }
      }
      if (drop < 0) break
      apex.splice(drop, 1)
    }
    const cuts: number[] = []
    for (let a = 0; a + 1 < apex.length; a++) {
      let lo = apex[a], loV = Infinity
      for (let b = apex[a]; b <= apex[a + 1]; b++) if (mag[b] < loV) { loV = mag[b]; lo = b }
      cuts.push(lo)
    }
    let start = 0
    for (const c of cuts) { split.push({ i0: run.i0 + start, i1: run.i0 + c }); start = c + 1 }
    split.push({ i0: run.i0 + start, i1: run.i1 })
  }
  runs.length = 0
  for (const s of split) runs.push({ i0: s.i0, i1: s.i1, sign: 0 })

  const corners: Corner[] = []
  for (const run of runs) {
    let turn = 0, len = 0, rMin = Infinity, iMin = run.i0
    let bank = 0, wMin = Infinity
    let vBind = Infinity, iBind = run.i0
    const surfaces = new Map<SurfaceKind, number>()
    let fragile = false
    for (let j = run.i0; j <= run.i1; j++) {
      const idx = ((j % m) + m) % m
      const kk = k[idx]
      turn += kk * ds
      len += ds
      bank += track.samples[idx].bank * ds
      wMin = Math.min(wMin, track.samples[idx].width)
      const su = track.samples[idx].surface
      surfaces.set(su, (surfaces.get(su) ?? 0) + ds)
      if (track.samples[idx].fragile) fragile = true
      const r = Math.abs(kk) > 1e-6 ? 1 / Math.abs(kk) : Infinity
      if (r < rMin) { rMin = r; iMin = idx }
      const v = limitFor(REF, su, r)
      if (v < vBind) { vBind = v; iBind = idx }
    }
    if (Math.abs(turn) < CORNER_MIN_TURN) continue
    const s0 = ((run.i0 % m) / m) * track.length
    const s1 = ((((run.i1 % m) + m) % m) / m) * track.length
    corners.push({
      index: 0,
      s0, s1, length: len,
      turnDeg: (Math.abs(turn) * 180) / Math.PI,
      // STEER_SIGN aside, curvatureAt is "positive turns right".
      dir: turn > 0 ? 'R' : 'L',
      rMean: len / Math.abs(turn),
      rMin,
      sAtMin: (iMin / m) * track.length,
      bankDeg: (bank / len) * (180 / Math.PI),
      widthMin: wMin,
      surfaceAtMin: track.samples[iMin].surface,
      rAtBind: Math.abs(k[iBind]) > 1e-6 ? 1 / Math.abs(k[iBind]) : Infinity,
      surfaceAtBind: track.samples[iBind].surface,
      sAtBind: (iBind / m) * track.length,
      surfaces,
      fragile,
      tags: tagsIn(track, s0, s1),
    })
  }
  corners.sort((a, b) => a.s0 - b.s0)
  corners.forEach((c, n) => { c.index = n + 1 })
  return corners
}

function findStraights(track: Track): { s0: number; len: number }[] {
  const m = track.samples.length
  const ds = track.length / m
  const out: { s0: number; len: number }[] = []
  let run = 0, start = 0
  for (let n = 0; n < m * 2; n++) {
    const i = n % m
    const kk = Math.abs(curvature(track, (i / m) * track.length))
    if (kk < STRAIGHT_K) {
      if (run === 0) start = i
      run += ds
    } else {
      if (run > 60) out.push({ s0: (start / m) * track.length, len: run })
      run = 0
    }
    if (n === m * 2 - 1 && run > 60) out.push({ s0: (start / m) * track.length, len: run })
  }
  // The double pass can emit the seam-crossing straight twice; keep the longest
  // per start position.
  const seen = new Map<number, number>()
  for (const s of out) seen.set(Math.round(s.s0), Math.max(seen.get(Math.round(s.s0)) ?? 0, s.len))
  return [...seen.entries()].map(([s0, len]) => ({ s0, len })).sort((a, b) => b.len - a.len)
}

const fmt = (n: number, d = 1): string => (Number.isFinite(n) ? n.toFixed(d) : 'inf')
const pad = (s: string, n: number): string => s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length)
const padL = (s: string, n: number): string => s.length >= n ? s : ' '.repeat(n - s.length) + s

// --------------------------------------------------------------------------
function report(def: (typeof TRACKS)[number]): void {
  const track = new Track(def)
  const m = track.samples.length
  const corners = findCorners(track)
  const straights = findStraights(track)

  console.log(`\n${'='.repeat(112)}`)
  console.log(`${def.name.toUpperCase()}  --  ${fmt(track.length, 0)}m, ${def.nodes.length} nodes, ${def.laps} laps`)
  console.log('='.repeat(112))

  // ---- Corner table ------------------------------------------------------
  // Reference chassis for the "binds" column: the roster median grip (Solaire,
  // grip 7) on the surface the corner's tightest point actually carries.
  const ref = REF
  console.log(`\nCORNERS  (radius from swept heading; limit v = sqrt(gripCoeff*gripMult*SURFACE*${T.grip.lateralAccel}/k))`)
  console.log(`  "binds" = limit for Solaire (grip 7) below its ${fmt(ref.top)} m/s top speed on the corner's own surface.`)
  console.log()
  const head = [pad('#', 3), pad('tag', 16), padL('s(m)', 6), padL('len', 5), padL('turn', 6),
    padL('Rmean', 6), padL('Rmin', 6), pad(' cls', 5), padL('bank', 5), padL('w', 5),
    pad('surface', 9), padL('v_snow', 7), padL('v_ice', 6), padL('v_oil', 6), pad('  binds', 22)]
  console.log(head.join(' '))
  console.log('-'.repeat(112))

  const rows: string[][] = []
  for (const c of corners) {
    const vSnow = limitFor(ref, 'snow', c.rAtBind)
    const vIce = limitFor(ref, 'ice', c.rAtBind)
    const vOil = limitFor(ref, 'oil', c.rAtBind)
    const vHere = limitFor(ref, c.surfaceAtBind, c.rAtBind)
    const binds = vHere < ref.top
    const marginPct = ((vHere - ref.top) / ref.top) * 100
    const verdict = binds
      ? `YES  ${fmt(vHere)} m/s (${fmt(marginPct, 0)}%)`
      : `no   flat out (+${fmt(marginPct, 0)}%)`
    const classified = cls(c.rMean)
    const minClass = cls(c.rMin)
    const clsStr = classified === minClass ? ` ${classified}` : ` ${classified}/${minClass}`
    rows.push([
      pad(String(c.index), 3),
      pad(c.tags.join(',') || '-', 16),
      padL(fmt(c.s0, 0), 6),
      padL(fmt(c.length, 0), 5),
      padL(fmt(c.turnDeg, 0) + c.dir, 6),
      padL(fmt(c.rMean, 0), 6),
      padL(fmt(c.rMin, 0), 6),
      pad(clsStr, 5),
      padL(fmt(c.bankDeg, 0), 5),
      padL(fmt(c.widthMin, 0), 5),
      pad(c.surfaceAtBind + (c.fragile ? '*' : '') + (c.rAtBind > c.rMin * 1.15 ? `@${fmt(c.rAtBind, 0)}` : ''), 9),
      padL(fmt(vSnow), 7),
      padL(fmt(vIce), 6),
      padL(fmt(vOil), 6),
      pad('  ' + verdict, 22),
    ])
  }
  for (const r of rows) console.log(r.join(' '))

  // ---- Per-class binding summary ----------------------------------------
  console.log(`\nBINDING BY CHASSIS (limit at each corner's tightest point, on its own surface):`)
  console.log(pad('  chassis', 18) + roster.length && '')
  const hdr = ['  ' + pad('corner', 18)].concat(roster.map((r) => padL(r.id, 9)))
  console.log(hdr.join(' '))
  for (const c of corners) {
    const cells = roster.map((r) => {
      const v = limitFor(r, c.surfaceAtBind, c.rAtBind)
      return padL(v < r.top ? fmt(v) : '-', 9)
    })
    console.log(['  ' + pad(`${c.index} ${c.tags[0] ?? ''}`, 18)].concat(cells).join(' '))
  }
  console.log('  ("-" = above that chassis top speed, i.e. flat out)')

  // ---- Surface economics -------------------------------------------------
  // What the surface is actually worth, in seconds, at the speed the corner
  // allows. This is the "is the ice decorative" number.
  console.log(`\nSURFACE TAX  (time this corner costs vs. the same corner on full grip, at the limit)`)
  let taxTotal = 0
  for (const c of corners) {
    const su = c.surfaceAtBind
    if (SURFACE_GRIP[su] >= 0.999) continue
    const vHere = Math.min(limitFor(ref, su, c.rAtBind), ref.top)
    const vFull = Math.min(limitFor(ref, 'snow', c.rAtBind), ref.top)
    const dt = c.length * (1 / vHere - 1 / vFull)
    taxTotal += dt
    console.log(`  #${padL(String(c.index), 2)} ${pad(c.tags[0] ?? '-', 14)} ${pad(su, 6)} ` +
      `R=${padL(fmt(c.rAtBind, 0), 4)}m len=${padL(fmt(c.length, 0), 4)}m  ` +
      `${fmt(vHere)} vs ${fmt(vFull)} m/s  ->  ${fmt(dt, 3)}s  (${fmt(dt / c.length * 1000, 2)} ms/m)`)
  }
  // Low-grip surface that is NOT in a corner: pure decoration.
  const ds = track.length / m
  let lowGripTotal = 0, lowGripInCorner = 0
  const cornerSpans = corners.map((c) => [c.s0, c.s1] as const)
  for (let i = 0; i < m; i++) {
    const su = track.samples[i].surface
    if (SURFACE_GRIP[su] >= 0.999) continue
    lowGripTotal += ds
    const s = (i / m) * track.length
    if (cornerSpans.some(([a, b]) => (b >= a ? s >= a && s <= b : s >= a || s <= b))) lowGripInCorner += ds
  }
  console.log(`  TOTAL cornering tax: ${fmt(taxTotal, 3)}s/lap`)
  console.log(`  Low-grip surface: ${fmt(lowGripTotal, 0)}m of ${fmt(track.length, 0)}m ` +
    `(${fmt(lowGripTotal / track.length * 100, 1)}%), of which ${fmt(lowGripInCorner, 0)}m ` +
    `(${fmt(lowGripTotal > 0 ? lowGripInCorner / lowGripTotal * 100 : 0, 1)}%) is inside a corner.`)

  // ---- Low-grip audit ----------------------------------------------------
  //
  // THE QUESTION THIS TOOL WAS BUILT FOR. A surface only does something where
  // the corner is tight enough that the reduced budget bites BEFORE top speed
  // does. Everywhere else the car is throttle-limited and the surface is paint.
  console.log(`\nLOW-GRIP RUNS  (does the surface bite, or is it paint?)`)
  {
    const runs: { s0: number; len: number; su: SurfaceKind; rMin: number; vMin: number; sBind: number; bindLen: number }[] = []
    let cur: (typeof runs)[number] | null = null
    for (let n = 0; n < m * 2; n++) {
      const i = n % m
      const su = track.samples[i].surface
      const low = SURFACE_GRIP[su] < 0.999
      const sHere = (i / m) * track.length
      if (low) {
        const kk = Math.abs(curvature(track, sHere))
        const r = kk > 1e-6 ? 1 / kk : Infinity
        const v = limitFor(REF, su, r)
        if (!cur || cur.su !== su) {
          if (cur && n <= m) runs.push(cur)
          cur = { s0: sHere, len: 0, su, rMin: r, vMin: v, sBind: sHere, bindLen: 0 }
        }
        cur.len += ds
        // Metres of this run where the surface actually costs speed: the
        // limit is under top speed AND under what full grip would allow here.
        if (v < REF.top) cur.bindLen += ds
        cur.rMin = Math.min(cur.rMin, r)
        if (v < cur.vMin) { cur.vMin = v; cur.sBind = sHere }
      } else if (cur) {
        if (n <= m + 1) runs.push(cur)
        cur = null
      }
      if (n === m * 2 - 1 && cur) runs.push(cur)
    }
    // De-duplicate the seam-crossing run.
    const seen = new Set<string>()
    const uniq = runs.filter((r) => {
      const key = `${Math.round(r.sBind)}|${r.su}`
      if (seen.has(key)) return false
      seen.add(key); return true
    })
    if (!uniq.length) console.log('  (no low-grip surface on this track)')
    for (const r of uniq) {
      const vFull = limitFor(REF, 'snow', r.rMin)
      const bindsPct = ((Math.min(r.vMin, REF.top) - REF.top) / REF.top) * 100
      console.log(`  ${pad(r.su, 6)} s=${padL(fmt(r.s0, 0), 5)}m len=${padL(fmt(r.len, 0), 4)}m  ` +
        `tightest R=${padL(fmt(r.rMin, 0), 4)}m  limit ${padL(fmt(r.vMin), 5)} m/s ` +
        `(full grip ${padL(fmt(vFull), 5)})  -> ${r.vMin < REF.top
          ? `BINDS ${fmt(bindsPct, 0)}% under top over ${fmt(r.bindLen, 0)}m of ${fmt(r.len, 0)}m ` +
            `(${fmt(r.bindLen / r.len * 100, 0)}% of the run)`
          : `PAINT (limit is ${fmt(r.vMin - REF.top, 0)} m/s ABOVE top speed)`}`)
    }
  }

  // ---- The whole-lap tax under the friction budget -----------------------
  //
  // Integrate ds / min(topSpeed, v_limit(s)) once with the authored surfaces
  // and once with every surface at full grip. The difference is what the
  // SURFACES are worth per lap under the physics alone -- no AI caution, no
  // drift, no items. If this number is near zero the hook is decorative.
  {
    const idealLap = (real: boolean, r: Roster): number => {
      let t = 0
      for (let i = 0; i < m; i++) {
        const sHere = (i / m) * track.length
        const kk = Math.abs(curvature(track, sHere))
        const rad = kk > 1e-6 ? 1 / kk : Infinity
        const su = real ? track.samples[i].surface : 'snow'
        t += ds / Math.min(r.top, limitFor(r, su, rad))
      }
      return t
    }
    console.log(`\nFRICTION-BUDGET LAP TAX  (ideal lap at the limit; surfaces on vs. all full grip)`)
    for (const r of roster) {
      const withS = idealLap(true, r)
      const without = idealLap(false, r)
      console.log(`  ${pad(r.id, 9)} ${pad(r.loco, 9)} ideal ${fmt(withS, 2)}s vs ${fmt(without, 2)}s ` +
        `-> surfaces cost ${fmt(withS - without, 3)}s/lap`)
    }
  }

  // ---- Structural checklist ---------------------------------------------
  console.log(`\nSTRUCTURE`)
  const ys = track.samples.map((s) => s.pos.y)
  const elev = Math.max(...ys) - Math.min(...ys)
  let worstGrade = 0, worstAt = 0
  for (let i = 0; i < m; i++) {
    const a = track.samples[i], b = track.samples[(i + 20) % m]  // ~30m window
    const run = Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z)
    if (run < 1) continue
    const g = Math.abs(b.pos.y - a.pos.y) / run
    if (g > worstGrade) { worstGrade = g; worstAt = (i / m) * track.length }
  }
  const widths = track.samples.map((s) => s.width)
  const wMin = Math.min(...widths), wMax = Math.max(...widths)
  console.log(`  Straights >60m: ` + straights.map((s) => `${fmt(s.len, 0)}m@${fmt(s.s0, 0)}`).join(', '))
  const primary = straights[0]
  console.log(`  Primary straight: ${fmt(primary?.len ?? 0, 0)}m ` +
    `(need >=${GRAMMAR.primaryStraight}m, exactly one) -> ${(primary?.len ?? 0) >= GRAMMAR.primaryStraight ? 'PASS' : 'FAIL'}`)
  const secondaries = straights.slice(1).filter((s) => s.len >= GRAMMAR.secondaryStraight[0])
  console.log(`  Secondary straights 150-300m: ${secondaries.length} (need 2-4) -> ${secondaries.length >= 2 && secondaries.length <= 4 ? 'PASS' : 'FAIL'}`)
  console.log(`  Half-widths ${fmt(wMin)}-${fmt(wMax)}m (grammar quotes full width 18-26m; ` +
    `full = ${fmt(wMin * 2)}-${fmt(wMax * 2)}m) -> ${wMin * 2 >= GRAMMAR.widthHardFloor ? 'PASS' : 'FAIL'}`)
  console.log(`  Elevation range ${fmt(elev)}m (need >=${GRAMMAR.elevationRange}m) -> ${elev >= GRAMMAR.elevationRange ? 'PASS' : 'FAIL'}`)
  console.log(`  Max sustained grade ${fmt(worstGrade * 100)}% at s=${fmt(worstAt, 0)}m ` +
    `(limit ${GRAMMAR.sustainedGrade * 100}%) -> ${worstGrade <= GRAMMAR.sustainedGrade + 0.005 ? 'PASS' : 'FAIL'}`)

  // Corner class census
  const census = { A: 0, B: 0, C: 0, kink: 0 } as Record<string, number>
  for (const c of corners) census[cls(c.rMean)]++
  console.log(`  Corner census by Rmean: A=${census.A}  B=${census.B}  C=${census.C}  sub-20m=${census.kink}`)
  const censusMin = { A: 0, B: 0, C: 0, kink: 0 } as Record<string, number>
  for (const c of corners) censusMin[cls(c.rMin)]++
  console.log(`  Corner census by Rmin : A=${censusMin.A}  B=${censusMin.B}  C=${censusMin.C}  sub-20m=${censusMin.kink}`)

  // Tier 4 sweeper: sustained arc long enough to charge to tier 4.
  console.log(`  Tier-4 candidates (Class A/B, >=150m of arc): ` +
    corners.filter((c) => c.rMean >= GRAMMAR.classB && c.length >= 150)
      .map((c) => `#${c.index}(${c.tags[0] ?? '-'} R${fmt(c.rMean, 0)} L${fmt(c.length, 0)})`).join(', ') || 'NONE')

  // ---- Item boxes vs the optimal line ------------------------------------
  console.log(`\nITEM BOX ROWS  (grammar: placed OFF the optimal line)`)
  for (const row of def.itemBoxRows) {
    const s = row.at * track.length
    // The AI's own racing-line model: apexBias = -sign(k)*clamp01(|k|*42)*0.62
    const kFar = track.curvatureAt(s, 26)
    const apexBias = -Math.sign(kFar) * Math.min(1, Math.abs(kFar) * 42) * 0.62
    const w = track.at(s).width
    const lineLat = apexBias * w
    const half = ((row.count - 1) / 2) * row.spread
    // A row is centred on the centreline and spans +/- half.
    const onLine = Math.abs(lineLat) <= half
    console.log(`  at=${row.at.toFixed(2)} s=${padL(fmt(s, 0), 5)}m  row spans +/-${fmt(half)}m of centre, ` +
      `racing line at ${fmt(lineLat, 1)}m (w=${fmt(w)}m)  -> ${onLine ? 'ON the line' : 'off the line'}`)
  }

  // ---- Class balance contract -------------------------------------------
  console.log(`\nCLASS BALANCE CONTRACT  (need >=1 section punishing each of grounded / hover / flight)`)
  const infl = Object.fromEntries(
    (['grounded', 'hover', 'flight'] as const).map((c) => [c, (T.locomotion as any)[c].surfaceFrictionInfluence]),
  )
  console.log(`  surfaceFrictionInfluence: grounded ${infl.grounded}, hover ${infl.hover}, flight ${infl.flight}` +
    `  -> low grip is ${infl.grounded === infl.hover && infl.hover === infl.flight ? 'SYMMETRIC (punishes nobody differentially)' : 'asymmetric'}`)
  const windNodes = def.nodes.filter((n) => n.wind)
  const maxWind = Math.max(0, ...def.nodes.map((n) => n.wind ?? 0))
  console.log(`  crosswind: ${windNodes.length} nodes, peak ${fmt(maxWind)} m/s^2 ` +
    `* windScale ${T.hazard.windScale} -> grounded ${fmt(maxWind * T.hazard.windScale)}, ` +
    `hover ${fmt(maxWind * T.hazard.windScale * 1.5)}, flight ${fmt(maxWind * T.hazard.windScale * 1.8)} m/s^2` +
    ` [taxes hover+flight]`)
  const gaps = def.nodes.filter((n) => n.open).length
  const ramps = def.nodes.filter((n) => n.ramp).length
  const bounce = def.nodes.filter((n) => n.bounce).length
  console.log(`  open-edge nodes ${gaps}, ramps ${ramps}, bounce-wall nodes ${bounce}`)
  const tightC = corners.filter((c) => c.rMin < GRAMMAR.classB)
  console.log(`  Class C corners (the low-mass equaliser, taxes Dray-9/Bulwark): ${tightC.length}` +
    (tightC.length ? ` -> ${tightC.map((c) => `#${c.index}(R${fmt(c.rMin, 0)})`).join(', ')}` : ''))

  // ---- Shortcuts ---------------------------------------------------------
  console.log(`\nSHORTCUTS  (grammar: exactly two -- one item-gated, one skill-gated, each 1.2-2.5s)`)
  console.log(`  TrackDef has no shortcut representation at all: 0 authored, 0 timed. -> FAIL`)
}

// --------------------------------------------------------------------------
const only = arg('track')
for (const def of TRACKS) {
  if (only && def.id !== only) continue
  report(def)
}
if (has('csv')) {
  console.log('\n--- CSV ---')
  console.log('track,corner,tag,s,length,turnDeg,rMean,rMin,class,bank,width,surface,vSnow,vIce,binds')
  for (const def of TRACKS) {
    if (only && def.id !== only) continue
    const track = new Track(def)
    const ref = roster.find((r) => r.id === 'solaire')!
    for (const c of findCorners(track)) {
      const vHere = limitFor(ref, c.surfaceAtMin, c.rMin)
      console.log([def.id, c.index, c.tags.join('|') || '-', fmt(c.s0, 0), fmt(c.length, 0),
        fmt(c.turnDeg, 0), fmt(c.rMean, 0), fmt(c.rMin, 0), cls(c.rMean), fmt(c.bankDeg, 0),
        fmt(c.widthMin, 0), c.surfaceAtMin, fmt(limitFor(ref, 'snow', c.rMin)),
        fmt(limitFor(ref, 'ice', c.rMin)), vHere < ref.top ? 'yes' : 'no'].join(','))
    }
  }
}
