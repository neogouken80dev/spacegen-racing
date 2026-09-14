/**
 * HOW OFTEN DOES A DRIFT END FOR A REASON THE PLAYER DID NOT CHOOSE?
 *
 * Reported three times, each time after a pass that had only WIDENED the
 * windows: bounces, barriers and (the one that was actually biting) weapon
 * stuns break a slide and fire the boost at a moment the player did not pick.
 *
 * THIS PROBE USED TO GUESS. It reconstructed the cause from the previous
 * frame's state -- wallTime, airTime, speed -- and picked whichever condition
 * happened to be true. That is an inference, not a measurement: it cannot see a
 * cause it was not told to look for, and the cause that was actually firing
 * (`eff.drift` blanked to false by an EMP stun) was not in its list. It scored
 * the build 3.8% and called it fixed while the reported bug was still there.
 *
 * It now classifies by what the sim EMITS. There is exactly one code path that
 * ends a drift the player's way, and it pushes `driftEnd`. Respawn and weapon
 * spin-out zero the slide directly and push nothing. So:
 *
 *   driftSide went non-zero -> 0 WITH a driftEnd event  = the player let go
 *   driftSide went non-zero -> 0 WITHOUT one            = the car was taken away
 *
 * That is exact. There is no third answer for it to miss, and a new cancel
 * added anywhere in the sim shows up here as an unattributed end without anyone
 * having to remember to teach this file about it.
 *
 *   npx tsx tools/probe-driftbreak.ts
 */
import { Track } from '../src/sim/track'
import { Race } from '../src/sim/race'
import { TRACKS } from '../src/content/tracks'
import { CHASSIS } from '../src/content/chassis'
import { PILOTS } from '../src/content/pilots'

const SEEDS = [20260904, 7717, 1234567]

let totalEnds = 0
let stolen = 0
const rows: string[] = []

for (const def of TRACKS) {
  let n = 0, chose = 0, respawned = 0, spun = 0, other = 0, blanked = 0
  for (const seed of SEEDS) {
    const t = new Track(def)
    const race = new Race(t, {
      seed, totalLaps: 3, racerCount: 8, trackId: def.id,
      chassisIds: Array.from({ length: 8 }, (_, i) => CHASSIS[i % CHASSIS.length].id),
      pilotIds: Array.from({ length: 8 }, (_, i) => PILOTS[i % PILOTS.length].id),
      localRacerIndex: -1, aiSkill: Array.from({ length: 8 }, (_, i) => 2 + (i % 3)),
    })
    const was = race.state.racers.map(() => 0)
    for (let f = 0; f < 60 * 420 && race.state.phase !== 'finished'; f++) {
      race.step()
      race.state.racers.forEach((r, k) => {
        if (was[k] !== 0 && r.driftSide === 0) {
          n++
          // The events array is this frame's, cleared per step.
          const paid = r.events.some(e => e.t === 'driftEnd')
          // A driftEnd fired while the car was in a control blackout is NOT the
          // player, even though it went down the player's code path: `eff` is
          // blanked to a dead frame during spin/stun/respawn, so reading
          // `eff.drift` there is indistinguishable from a release, and it pays
          // the boost. This is the bucket that was actually being reported and
          // that the old inferential probe had no way to see.
          const blackout = r.spinTime > 0 || r.stunTime > 0 || r.respawnTime > 0
          if (paid && blackout) blanked++
          else if (paid) chose++
          else if (r.respawnTime > 0) respawned++
          else if (r.spinTime > 0) spun++
          else other++
        }
        was[k] = r.driftSide
      })
    }
  }
  totalEnds += n
  // Respawn and spin-out are the car being taken away outright -- loud,
  // attributable, and they pay no boost. An end in neither bucket and with no
  // driftEnd event is a cancel nobody declared, which is the failure this probe
  // exists to catch.
  stolen += other
  // BLANKED IS REPORTED, NOT GATED, and the distinction matters. It counts
  // releases that happened to land inside a control blackout -- which, now that
  // the exit reads the true `input` rather than the blanked `eff`, are real
  // releases: an AI's `driftHold` timer expiring while it happens to be
  // spinning. The bucket cannot tell those from the bug, because both push the
  // same event, so gating on it here would fail the build for something
  // correct. The bug itself is owned by a scripted repro instead --
  // tests/drift.test.ts, "an EMP stun does not end a drift" -- which sets the
  // stun deliberately and checks the slide survives it. Watch this number: a
  // jump means a new blackout source arrived and wants looking at.
  const pc = (v: number) => `${((100 * v) / Math.max(1, n)).toFixed(1)}%`
  rows.push(`${def.name.padEnd(16)} ${String(n).padStart(5)} ends   player ${pc(chose).padStart(6)}   respawn ${pc(respawned).padStart(6)}   spun ${pc(spun).padStart(6)}   BLANKED ${pc(blanked).padStart(6)}   UNDECLARED ${pc(other).padStart(6)}`)
}

for (const r of rows) console.log(r)
const pct = (100 * stolen) / totalEnds
console.log(`\nended by a cancel nobody declared: ${pct.toFixed(2)}%  (${stolen}/${totalEnds})`)

// THE GATE IS ZERO UNDECLARED, and it can be zero because the classification is
// exact rather than inferential. Every drift end is the player's button, a
// respawn, or a spin-out. Anything else is a regression by definition.
//
// SABOTAGE-TESTED, all three, because a probe that has never been seen red is
// not evidence of anything:
//   restore the vehicle.ts wall cancel      -> 1.10% undeclared, 20 ends
//   restore the race.ts car-to-car cancel   -> 3.27% undeclared, 60 ends
//   restore `!eff.drift` for the exit       -> 3.25% blanked, 60 ends, and the
//                                              scripted EMP test goes red
// The last of those is the one that was actually being reported, and note what
// it did to the OLD version of this file: it scored that build 3.8% and printed
// DRIFT OWNERSHIP OK.
if (stolen > 0) {
  console.log(`\nFAILED: ${stolen} drift ends came from a cancel that is not the player, a respawn or a spin-out`)
  process.exit(1)
}
console.log('\nDRIFT OWNERSHIP OK -- the button is the only exit')
