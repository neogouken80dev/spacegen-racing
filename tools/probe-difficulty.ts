/**
 * DOES EACH STEP OF THE DIFFICULTY LADDER ACTUALLY COST THE PLAYER A PLACE?
 *
 *   npx tsx tools/probe-difficulty.ts
 *   npx tsx tools/probe-difficulty.ts --track=cryostatic --races=60
 *
 * A difficulty setting is not a number, it is a PROMISE: that turning it up
 * makes winning harder and turning it down makes it easier. Nothing in a band
 * table proves that. A band could be faster in every column and still finish
 * in the same place, because a faster AI that drives into more walls is not a
 * better opponent -- and the top of this ladder buys most of its pace by
 * cornering nearer the friction limit, which is exactly the way to be fast
 * and off the road at the same time.
 *
 * THE INSTRUMENT: A REFERENCE DRIVER.
 *
 * There is no human in a headless run and no model of one, so slot 0 is held
 * at a FIXED band (3 by default -- the middle of a Normal grid) at every
 * difficulty, and what is measured is WHERE IT FINISHES. It is the same
 * driver in every race; only the field around it changes. So its finishing
 * position is a direct reading of how hard the field is, in the unit the
 * player actually experiences.
 *
 * What to expect, and what each reading would mean:
 *
 *   easy    reference wins most races      -- if it does not, Easy is not easy
 *   normal  reference finishes mid-pack    -- it IS a Normal car, by definition
 *   hard    reference drops toward the back
 *   expert  reference is reliably last     -- if it is not, Expert is a label
 *
 * A LADDER THAT IS NOT MONOTONIC IS THE FAILURE THIS EXISTS TO CATCH, and the
 * run exits non-zero for it.
 *
 * THE SECOND READING IS THE ONE THAT DECIDES `caution`. Respawns and
 * off-track time are reported per difficulty because the top bands corner at
 * 0.937 of the friction limit against 0.86 for the shipped field -- a 6.3%
 * margin to absorb a bump, a surface change or their own steering error. If
 * Expert posts a fast mean lap AND a pile of respawns, the pace is a lie: the
 * cars are quick between accidents. The shipped circuits run 0.0-0.7 respawns
 * a race through the same kind of harness, which is the number to read these
 * against.
 */
import { Race } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { TRACKS_BY_ID, RUSTFALL } from '../src/content/tracks'
import { CHASSIS } from '../src/content/chassis'
import { PILOTS } from '../src/content/pilots'
import { resetAI } from '../src/sim/ai'
import type { SimConfig } from '../src/sim/types'
import {
  DIFFICULTIES, DIFFICULTY_SPECS, SKILL_BANDS, skillForSlot, type Difficulty,
} from '../src/content/difficulty'

const arg = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d

const DEF = TRACKS_BY_ID[arg('track', 'rustfall')] ?? RUSTFALL
const RACES = Number(arg('races', '40'))
const REF_BAND = Number(arg('ref', '3'))
const LAPS = 3
const N = 8

interface Row {
  refPos: number[]
  /**
   * Seconds the reference driver finished behind the winner.
   *
   * POSITION SATURATES AND THIS DOES NOT, which is the whole reason it is
   * here. By Hard the reference is already P7 of 8, so Hard and Expert both
   * read "near the back" and the metric stops being able to tell them apart --
   * it reported 7.04 against 7.67 while the field's best lap moved a full
   * second. Position is what the player feels; the gap is what can still be
   * measured once the player is out of places to lose.
   */
  refGap: number[]
  refLap: number
  fieldLap: number
  respawns: number
  offTrack: number
  frames: number
  wallForce: number
}

function run(difficulty: Difficulty, seed: number, row: Row): void {
  resetAI()
  const track = new Track(DEF)
  // Slot 0 is the reference driver at every difficulty; slots 1-7 are the
  // field. `skillForSlot` is given the REAL slot index so the field keeps the
  // pecking order it has in the game rather than being re-spread over seven.
  const cfg: SimConfig = {
    seed,
    totalLaps: LAPS,
    racerCount: N,
    trackId: DEF.id,
    chassisIds: Array.from({ length: N }, (_, i) => CHASSIS[i % CHASSIS.length].id),
    pilotIds: Array.from({ length: N }, (_, i) => PILOTS[i % PILOTS.length].id),
    localRacerIndex: -1,
    aiSkill: Array.from({ length: N }, (_, i) => (i === 0 ? REF_BAND : skillForSlot(difficulty, i))),
  }
  const race = new Race(track, cfg)
  const was = new Array<number>(N).fill(0)
  let frames = 0
  while (frames < 60 * 400 && race.state.phase !== 'finished') {
    race.step()
    frames++
    for (let i = 0; i < N; i++) {
      const r = race.state.racers[i]
      if (r.respawnTime > 0 && was[i] <= 0) row.respawns++
      was[i] = r.respawnTime
      if (r.offTrackTime > 0) row.offTrack++
      for (const e of r.events) if (e.t === 'wall') row.wallForce += e.force
    }
  }
  row.frames += frames * N
  const ref = race.state.racers[0]
  row.refPos.push(ref.position)
  let winner = Infinity
  for (const r of race.state.racers) if (r.finishTime > 0 && r.finishTime < winner) winner = r.finishTime
  if (Number.isFinite(winner) && ref.finishTime > 0) row.refGap.push(ref.finishTime - winner)
  if (ref.bestLap > 0) row.refLap += ref.bestLap
  let best = Infinity
  for (let i = 1; i < N; i++) {
    const b = race.state.racers[i].bestLap
    if (b > 0 && b < best) best = b
  }
  if (Number.isFinite(best)) row.fieldLap += best
}

console.log(`\nDIFFICULTY LADDER on ${DEF.name} -- ${RACES} races each, `
  + `reference driver at band ${REF_BAND}\n`)
console.log('            base   AI bands     ref finish   wins   gap to P1   field best lap   respawns   off-track')

const means: number[] = []
const gaps: number[] = []
for (const d of DIFFICULTIES) {
  const row: Row = { refPos: [], refGap: [], refLap: 0, fieldLap: 0, respawns: 0, offTrack: 0, frames: 0, wallForce: 0 }
  for (let s = 0; s < RACES; s++) run(d, 1000 + s * 7, row)
  const mean = row.refPos.reduce((a, b) => a + b, 0) / row.refPos.length
  const gap = row.refGap.reduce((a, b) => a + b, 0) / Math.max(1, row.refGap.length)
  means.push(mean)
  gaps.push(gap)
  const wins = row.refPos.filter((p) => p === 1).length
  const spec = DIFFICULTY_SPECS[d]
  const bands = [0, 1, 2].map((i) => skillForSlot(d, i)).join(',')
  console.log(
    `  ${spec.label.padEnd(8)}  ${String(spec.base).padStart(2)}   `
    + `${bands.padEnd(10)}   ${mean.toFixed(2).padStart(5)}      `
    + `${String(Math.round(100 * wins / RACES)).padStart(3)}%   `
    + `${(gap >= 0 ? '+' : '') + gap.toFixed(1)}s`.padStart(9) + `   `
    + `${(row.fieldLap / RACES).toFixed(2).padStart(7)}s       `
    + `${(row.respawns / RACES).toFixed(2).padStart(5)}      `
    + `${(100 * row.offTrack / Math.max(1, row.frames)).toFixed(2).padStart(5)}%`,
  )
}

console.log('\nthe band table')
console.log('  band  speed  reaction  mistake  drift  caution  rocket')
for (let k = 0; k < SKILL_BANDS.length; k++) {
  const b = SKILL_BANDS[k]
  console.log(
    `  ${String(k).padStart(4)}  ${b.speed.toFixed(3)}  ${b.reaction.toFixed(3).padStart(8)}`
    + `  ${b.mistake.toFixed(2).padStart(7)}  ${b.drift.toFixed(3)}  ${b.caution.toFixed(3).padStart(7)}`
    + `  ${b.rocket.toFixed(2).padStart(6)}`,
  )
}

// --- The promise -----------------------------------------------------------
// EVERY STEP MUST COST THE REFERENCE DRIVER AT LEAST TWO SECONDS. The gate is
// on the gap rather than on position for the reason given on `Row.refGap`: a
// position gate passes Hard -> Expert on a 0.63 difference that is really the
// metric running out of road, and would go on passing it if Expert were made
// identical to Hard. Two seconds over three laps is about a corner and a half.
const problems: string[] = []
for (let i = 1; i < gaps.length; i++) {
  if (gaps[i] < gaps[i - 1] + 2.0) {
    problems.push(
      `${DIFFICULTIES[i - 1]} -> ${DIFFICULTIES[i]} costs the reference driver `
      + `${(gaps[i] - gaps[i - 1]).toFixed(1)}s. A step the player cannot feel `
      + `is not a difficulty setting.`,
    )
  }
  if (means[i] < means[i - 1] - 0.05) {
    problems.push(`${DIFFICULTIES[i]} finishes the reference driver HIGHER than ${DIFFICULTIES[i - 1]}.`)
  }
}
if (means[0] > 2.5) problems.push(`Easy leaves the reference driver in P${means[0].toFixed(1)} -- that is not easy.`)

console.log('')
if (problems.length > 0) {
  for (const p of problems) console.log(`  FAIL  ${p}`)
  process.exitCode = 1
} else {
  console.log(`  monotonic in places: P${means.map((m) => m.toFixed(2)).join(' -> P')}`)
  console.log(`  monotonic in time:   ${gaps.map((g) => g.toFixed(1) + 's').join(' -> ')}`)
}
console.log('')
