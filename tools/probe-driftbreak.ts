/**
 * HOW OFTEN DOES A DRIFT END FOR A REASON THE PLAYER DID NOT CHOOSE?
 *
 * Reported from play: bounces and barrier contacts break a slide and fire the
 * boost at a moment the player did not pick. Both exits run through the same
 * line in vehicle.ts -- `const exit = !eff.drift || !canDrift` -- and only the
 * first of those is the player. The other two are the car being off the deck
 * for longer than `drift.airGrace` and the speed falling under
 * `drift.minSpeedToDrift`, and BOTH of them pay the full release boost on the
 * way out. There is a third, separate path that cancels the slide outright on a
 * collision above `drift.collisionCancelSpeed`, paying nothing.
 *
 * Nothing measured any of it. `drift.test.ts` proves the mechanic; the balance
 * harness counts tiers reached. Neither can tell a slide the player cashed in
 * from one the road took off them.
 *
 * So: run real races and classify every drift end by which condition actually
 * fired on that frame.
 *
 *   npx tsx tools/probe-driftbreak.ts
 */
import { Track } from '../src/sim/track'
import { Race } from '../src/sim/race'
import { TRACKS } from '../src/content/tracks'
import { CHASSIS } from '../src/content/chassis'
import { PILOTS } from '../src/content/pilots'
import { TUNING as T } from '../src/content/tuning'

let totalEnds = 0, unchosen = 0
for (const def of TRACKS) {
  const t = new Track(def)
  const race = new Race(t, {
    seed: 20260904, totalLaps: 3, racerCount: 8, trackId: def.id,
    chassisIds: Array.from({ length: 8 }, (_, i) => CHASSIS[i % CHASSIS.length].id),
    pilotIds: Array.from({ length: 8 }, (_, i) => PILOTS[i % PILOTS.length].id),
    localRacerIndex: -1, aiSkill: Array.from({ length: 8 }, (_, i) => 2 + (i % 3)),
  })
  const was = race.state.racers.map(() => 0)
  const prevAir = race.state.racers.map(() => 0)
  const prevSpd = race.state.racers.map(() => 0)
  const prevWall = race.state.racers.map(() => 0)
  const by = new Map<string, number>()
  for (let f = 0; f < 60 * 420 && race.state.phase !== 'finished'; f++) {
    race.step()
    race.state.racers.forEach((r, k) => {
      if (was[k] !== 0 && r.driftSide === 0) {
        // Which of the three non-player exits was true on the frame it ended.
        const cause = prevWall[k] > 0 ? 'barrier contact'
          : prevAir[k] >= T.drift.airGrace ? 'off the deck'
            : prevSpd[k] < T.drift.minSpeedToDrift ? 'speed collapsed'
              : 'the player let go'
        by.set(cause, (by.get(cause) ?? 0) + 1)
      }
      was[k] = r.driftSide
      prevAir[k] = r.airTime
      prevSpd[k] = Math.hypot(r.vel.x, r.vel.z)
      prevWall[k] = r.wallTime
    })
  }
  const n = [...by.values()].reduce((a, b) => a + b, 0)
  const chose = by.get('the player let go') ?? 0
  totalEnds += n; unchosen += n - chose
  const parts = [...by.entries()].sort((a, b) => b[1] - a[1])
    .map(([c, v]) => `${c} ${((100 * v) / n).toFixed(0)}%`)
  console.log(`${def.name.padEnd(16)} ${String(n).padStart(4)} drift ends   ${parts.join('   ')}`)
}
const pct = (100 * unchosen) / totalEnds
console.log(`\nended by something other than the player: ${pct.toFixed(1)}%  (${unchosen}/${totalEnds})`)
// MEASURED, not guessed at. On the thresholds this replaced -- airGrace 0.25,
// groundStickMargin 0.22 (i.e. no hysteresis), collisionCancelSpeed 8.0 --
// 11.0% of all drift ends across the four circuits were taken off the player,
// and Frosthelm alone was at 21%. It is 3.8% now.
//
// The floor is not zero and should not be: a real ramp launch ends a slide on
// purpose, and a car that genuinely stops cannot keep drifting. 8% is above
// what the fixed build produces and below what the broken one did.
//
// THE GATE IS ON THE COMBINATION, and single-knob attribution at this sample
// size is noise -- reverting the hysteresis alone measured 1.6% and reverting
// airGrace alone 5.4%, both BELOW the 3.8% of the build with everything in.
// That is not a paradox, it is one seed per circuit: a sim change moves every
// racing line, so the denominator moves too (630 drift ends against 811 on the
// old thresholds). Anyone wanting to attribute a single knob here needs several
// seeds, which is the same rule the roster passes already run under.
if (pct > 8) {
  console.log(`\nFAILED: the road takes ${pct.toFixed(1)}% of all drifts off the player`)
  process.exit(1)
}
console.log('\nDRIFT OWNERSHIP OK')
