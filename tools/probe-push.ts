/**
 * THE SIDEWAYS-PUSH RULER.
 *
 * Reported from play on the Hollow Choir: "there are portions of the track
 * where I try to turn, but it pushes me to the right." This answers, per
 * track: how hard is the crosswind, WHICH WAY does it point, how much of the
 * lap is under it, and how much of the car's own cornering budget it eats.
 *
 *   npx tsx tools/probe-push.ts
 */
import { Track } from '../src/sim/track'
import { TRACKS_BY_ID } from '../src/content/tracks'
import { lateralBudget, vacuumGripMult } from '../src/sim/vehicle'
import { CHASSIS, getDerived, getLocomotion } from '../src/content/chassis'
import { TUNING as T } from '../src/content/tuning'

const GUST = 1 + T.hazard.windGustDepth + T.hazard.windRippleDepth

for (const id of ['rustfall', 'cryostatic', 'aetherion', 'hollowchoir']) {
  const track = new Track(TRACKS_BY_ID[id])
  let posLen = 0, negLen = 0, peak = 0, peakS = 0
  // metres where the wind is live AND the road is actually curving
  let windInCorner = 0
  for (let s = 0; s < track.length; s += 1) {
    const w = track.at(s).wind
    const k = Math.abs(track.curvatureAt(s, 20))
    if (w > 0.05) posLen++
    if (w < -0.05) negLen++
    if (Math.abs(w) > 2 && k > 0.0045) windInCorner++
    if (Math.abs(w) > Math.abs(peak)) { peak = w; peakS = s }
  }
  const dir = posLen && negLen ? 'BOTH WAYS'
    : posLen ? '>>> RIGHT ONLY, every windy metre <<<'
    : negLen ? 'LEFT ONLY' : 'no wind'
  console.log(`\n=== ${id.toUpperCase()}  ${Math.round(track.length)}m ===`)
  if (!posLen && !negLen) { console.log('  no crosswind'); continue }
  console.log(`  under wind:      ${posLen + negLen}m  (${Math.round(100 * (posLen + negLen) / track.length)}% of the lap)`)
  console.log(`  peak:            ${peak.toFixed(1)} m/s^2 at s=${peakS}   gusting to ${(peak * GUST).toFixed(1)}`)
  console.log(`  wind IN a corner:${String(windInCorner).padStart(5)}m  <- blowing while you are turning`)
  console.log(`  DIRECTION:       ${dir}`)
}

const capShare = (loco: any) => Math.min(T.hazard.windGripShare * loco.fieldForceMult, T.hazard.windGripCeiling)

console.log(`\n\n====== PEAK DRAUGHT (26) vs THE CAR'S OWN CORNERING BUDGET ======`)
console.log(`chassis        loco      budget   WAS(gusted)   NOW(capped)   was%   now%`)
for (const c of CHASSIS) {
  const loco = getLocomotion(c.id), d = getDerived(c.id)
  const b = lateralBudget(d, loco, 1.0)
  const was = 26 * loco.fieldForceMult * GUST
  const now = Math.min(was, b * capShare(loco))
  console.log(`${c.name.padEnd(14)} ${c.locomotion.padEnd(9)} ${b.toFixed(1).padStart(6)} ${was.toFixed(1).padStart(12)} ${now.toFixed(1).padStart(13)} ${(100*was/b).toFixed(0).padStart(6)}% ${(100*now/b).toFixed(0).padStart(5)}%`)
}

console.log(`\n\n===== AT THE FALL'S TURN-IN, WHERE THE VACUUM TAKES THE GRIP =====`)
console.log(`chassis        budget@vac   WAS(gusted)   NOW(capped)   was%   now%`)
for (const c of CHASSIS) {
  const loco = getLocomotion(c.id), d = getDerived(c.id)
  const b = lateralBudget(d, loco, 1.0) * vacuumGripMult(1.0, loco)
  const was = 24 * loco.fieldForceMult * GUST
  const now = Math.min(was, b * capShare(loco))
  console.log(`${c.name.padEnd(14)} ${b.toFixed(1).padStart(10)} ${was.toFixed(1).padStart(12)} ${now.toFixed(1).padStart(13)} ${(100*was/b).toFixed(0).padStart(6)}% ${(100*now/b).toFixed(0).padStart(5)}%`)
}

console.log(`\n\n============ WIND AT EACH ITEM BOX ROW ============`)
console.log(`(after the calm pass in the bake -- these should all be ~0)\n`)
for (const id of ['rustfall', 'cryostatic', 'aetherion', 'hollowchoir']) {
  const track = new Track(TRACKS_BY_ID[id])
  const rows = TRACKS_BY_ID[id].itemBoxRows
  const at = rows.map((r) => {
    const s = r.at * track.length
    // worst wind anywhere in the aiming window
    let w = 0
    for (let d = -T.hazard.itemCalmBefore; d <= T.hazard.itemCalmAfter; d += 2) { const v = Math.abs(track.at(s + d).wind); if (v > w) w = v }
    return `${Math.round(s)}m:${w.toFixed(1)}`
  })
  console.log(`  ${id.padEnd(12)} ${at.join('  ')}`)
}
