/**
 * BOOST-STRIP AND RAMP EXTENTS.
 *
 * `boost` is a NODE flag that the bake spreads over half a segment either side,
 * so "four pads" and "142 metres of pad" are different facts and only the second
 * one is worth anything. Prints every strip as an arc-length interval, because
 * boost uptime is dominated by dwell on the strip -- applyBoost's weakerExtend
 * branch re-fires every frame a car is on one.
 *
 *   npx tsx tools/probe-strips.ts --track=aetherion,cryostatic,rustfall
 */
import { Track } from '../src/sim/track'
import { TRACKS_BY_ID } from '../src/content/tracks'
const argv = process.argv.slice(2)
const arg = (k: string, d: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
for (const id of arg('track', 'aetherion').split(',')) {
  const tr = new Track(TRACKS_BY_ID[id])
  const m = tr.samples.length, L = tr.length
  console.log(`\n=== ${id}  ${L.toFixed(0)}m ===`)
  const runs: { kind: string; s0: number; s1: number }[] = []
  const flag = (i: number) => (tr.samples[i].boost ? 'boost' : '') + (tr.samples[i].ramp ? '|ramp' + tr.samples[i].ramp : '')
  let i = 0
  while (i < m) {
    const f = flag(i)
    if (!f) { i++; continue }
    let n = 1
    while (i + n < m && flag(i + n) === f) n++
    runs.push({ kind: f, s0: (i / m) * L, s1: ((i + n) / m) * L })
    i += n
  }
  let tot = 0
  for (const r of runs) { console.log(`  ${r.kind.padEnd(12)} ${r.s0.toFixed(0).padStart(6)} -> ${r.s1.toFixed(0).padStart(6)}   ${(r.s1 - r.s0).toFixed(0).padStart(4)}m  ${((r.s1 - r.s0) / L * 100).toFixed(1)}%`); if (r.kind.startsWith('boost')) tot += r.s1 - r.s0 }
  console.log(`  TOTAL boost strip ${tot.toFixed(0)}m  ${(tot / L * 100).toFixed(1)}% of lap`)
}
