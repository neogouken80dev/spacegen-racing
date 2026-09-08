/**
 * THE CURVATURE RULER.
 *
 * Prints, metre by metre, the two numbers stepAI actually gates the drift on:
 * |curvatureAt(s, 20)| (it HOLDS a drift above 0.0045) and
 * |curvatureAt(s + 6, 30)| (it OPENS one above 0.0075), with the sign and the
 * implied radius. Everything that goes wrong with a drift on a lap is visible
 * here first: a ripple that crosses the hold gate twice inside one corner, a
 * stretch that grazes it for ten metres, an E without an H.
 *
 *   npx tsx tools/probe-curv.ts --track=aetherion --from=2900 --to=3040 --step=2
 */
import { Track } from '../src/sim/track'
import { TRACKS_BY_ID } from '../src/content/tracks'
const argv = process.argv.slice(2)
const arg = (k: string, d: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const track = new Track(TRACKS_BY_ID[arg('track', 'aetherion')])
const s0 = parseFloat(arg('from', '0')), s1 = parseFloat(arg('to', String(track.length))), st = parseFloat(arg('step', '2'))
console.log('    s   hold|k(s,20)|  enter|k(s+6,30)|   E H   R(hold)  width  surf  grade')
for (let s = s0; s < s1; s += st) {
  const hs = track.curvatureAt(s, 20)
  const h = Math.abs(hs)
  const e = Math.abs(track.curvatureAt(s + 6, 30))
  const smp = track.at(s)
  const flags = `${e > 0.0075 ? 'E' : '.'} ${h > 0.0045 ? 'H' : '.'}`
  console.log(`${s.toFixed(0).padStart(5)}  ${h.toFixed(5).padStart(9)}  ${e.toFixed(5).padStart(9)}   ${flags}  ${(hs<0?'-':'+')}${(1 / Math.max(1e-6, h)).toFixed(0).padStart(6)}  ${smp.width.toFixed(0).padStart(4)}  ${smp.surface.padEnd(7)} ${smp.tangent.y.toFixed(3)}`)
}
