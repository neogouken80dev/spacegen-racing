/**
 * THE AI's DRIFT INVERSION DOES NOT UNDO THE BOOST RELIEF.
 *
 * ai.ts `driftStick` exists to invert the vehicle's arc->yaw mapping so the AI
 * asks for the stick that produces the rotation it wants. Its own doc comment
 * states the principle using the surface term: ask an ice drift for a snow arc,
 * get less, and answer the shortfall with more lock you also cannot have.
 *
 * It divides by `falloff = 1/(1 + speed/yawSpeedFalloff)`. Since the boost
 * relief was added, the vehicle applies something else while boosting:
 *
 *     arcFalloff = falloff + (1 - falloff) * boostArcRelief * boost01
 *
 * So the inversion is missing a term, in the opposite direction from the ice
 * case: during a boost the car rotates MORE than the stick solved for.
 *
 * WHAT THIS PROBE CAN AND CANNOT TELL YOU.
 *
 * CAN: how much of the AI's drifting is done in that regime, and how big the
 * unmodelled factor is. Both are arithmetic over race state and are reported
 * below.
 *
 * CANNOT: whether fixing it makes the AI drive better. That was tried -- stick
 * reversals per second during boosted drifts, with cold drift frames as the
 * control -- and the A/B is worthless because the sim is chaotic: any change to
 * the AI reshuffles the whole race, so the two runs are not the same corners.
 * The tell was that the CONTROL column moved more than the treatment (cold
 * 0.63 -> 0.54 against boosted 0.58 -> 0.55). Measuring the fix needs a harness
 * that cannot diverge -- a scripted corner on the test plain with the AI's
 * wanted yaw rate recorded against what it got -- not a race.
 *
 * The fix is therefore NOT bundled with the boostArcRelief tune. Two changes to
 * the same mechanic in one commit is how you end up unable to say which one
 * moved the feel, and this repo has written that lesson up three times.
 *
 *   npx tsx tools/probe-aiarc.ts
 */
import { Race } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { TRACKS } from '../src/content/tracks'
import { resetAI } from '../src/sim/ai'
import { TUNING as T } from '../src/content/tuning'
import { CHASSIS } from '../src/content/chassis'

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

for (const trackId of ['rustfall', 'cryostatic', 'aetherion', 'hollowchoir']) {
  const def = TRACKS.find((t) => t.id === trackId)!
  resetAI()
  const race = new Race(new Track(def), {
    seed: 11, totalLaps: 2, racerCount: 8, trackId,
    chassisIds: Array.from({ length: 8 }, (_, i) => CHASSIS[i % CHASSIS.length].id),
    pilotIds: Array.from({ length: 8 }, () => ''),
    localRacerIndex: -1, aiSkill: Array.from({ length: 8 }, () => 0.85),
  })
  let driftFrames = 0, boostedFrames = 0, sumGap = 0, maxGap = 1
  for (let f = 0; f < 60 * 240 && race.state.phase !== 'finished'; f++) {
    race.step()
    for (const r of race.state.racers) {
      if (r.driftSide === 0) continue
      driftFrames++
      const boost01 = clamp01(r.boostTime > 0 ? r.boostMag / T.boost.padMag : 0)
      if (boost01 <= 0) continue
      const speed = Math.hypot(r.vel.x, r.vel.y, r.vel.z)
      const falloff = 1 / (1 + speed / T.steering.yawSpeedFalloff)
      const gap = (falloff + (1 - falloff) * T.drift.boostArcRelief * boost01) / falloff
      boostedFrames++
      sumGap += gap
      if (gap > maxGap) maxGap = gap
    }
  }
  const pct = driftFrames ? (100 * boostedFrames) / driftFrames : 0
  console.log(
    `${trackId.padEnd(13)} drift ${String(driftFrames).padStart(6)}f  ` +
    `boosted ${String(boostedFrames).padStart(6)}f (${pct.toFixed(1).padStart(4)}%)  ` +
    `unmodelled factor: mean ${(boostedFrames ? sumGap / boostedFrames : 1).toFixed(2)}x  ` +
    `worst ${maxGap.toFixed(2)}x`,
  )
}
