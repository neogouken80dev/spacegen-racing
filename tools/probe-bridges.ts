/**
 * THE LIGHT-BRIDGE PROBE.
 *
 * probe-track measures geometry and probe-line measures the driven line.
 * Neither can answer the only question that matters about a phasing bridge,
 * which is whether the field is TIMING it or surviving it by luck: a hazard
 * everybody falls through is a random respawn generator, and one nobody falls
 * through is a decoration with a period.
 *
 * Reports, per locomotion class: falls through a span, seconds spent off the
 * causeway, Lift spent on it, and the speed the field actually crosses at
 * against the wave speed the offsets were authored for.
 *
 * SINCE A SPAN DROPS ONE HALF, it also reports the lane. `wrong%` is the share
 * of the frames a racer spends on a span that it spends on the half that gives
 * way -- the number the whole change is about, because a racer that is never on
 * the dropping half cannot fall through it whatever the beat does. `exposed s`
 * is the subset of that spent while the deck is ACTUALLY out, i.e. the seconds
 * the racer was standing on nothing.
 *
 *   npx tsx tools/probe-bridges.ts --track=aetherion --races=24
 */
import { Race } from '../src/sim/race'
import { Track, bridgeSolid, onDroppingHalf } from '../src/sim/track'
import { TRACKS_BY_ID } from '../src/content/tracks'
import { CHASSIS, getLocomotion } from '../src/content/chassis'
import { PILOTS } from '../src/content/pilots'
import { resetAI } from '../src/sim/ai'
import { emptyInput } from '../src/sim/types'
import type { SimConfig } from '../src/sim/types'
import { TUNING as T } from '../src/content/tuning'

const arg = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const def = TRACKS_BY_ID[arg('track', 'aetherion')]
const RACES = Number(arg('races', '24'))
const track = new Track(def)

console.log(`${def.name}  ${track.length.toFixed(0)}m  bridges=${track.hasBridges}`)
for (const b of track.bridges) {
  console.log(`  span s=${b.s0.toFixed(0)}-${b.s1.toFixed(0)}m  len ${(b.s1 - b.s0).toFixed(0)}m  phase ${b.phase.toFixed(2)}` +
    `  drops ${b.side < 0 ? 'LEFT ' : 'RIGHT'} (lane ${b.side < 0 ? 'right' : 'left'})` +
    `  solid ${(T.hazard.bridgePeriod * T.hazard.bridgeDuty).toFixed(2)}s of ${T.hazard.bridgePeriod}s`)
}
if (track.bridges.length >= 2) {
  const gap = track.bridges[1].s0 - track.bridges[0].s0
  const dphi = ((track.bridges[1].phase - track.bridges[0].phase) % 1 + 1) % 1
  console.log(`  wave: ${gap.toFixed(0)}m per ${(dphi * T.hazard.bridgePeriod).toFixed(2)}s = ${(gap / (dphi * T.hazard.bridgePeriod)).toFixed(1)} m/s`)
}

const cfg = (seed: number, n = 8): SimConfig => ({
  seed, totalLaps: 3, racerCount: n, trackId: def.id,
  chassisIds: Array.from({ length: n }, (_, i) => CHASSIS[(i + seed) % CHASSIS.length].id),
  pilotIds: Array.from({ length: n }, (_, i) => PILOTS[i % PILOTS.length].id),
  localRacerIndex: -1,
  aiSkill: Array.from({ length: n }, (_, i) => 2 + (i % 3)),
})

type Acc = {
  entries: number; falls: number; crossings: number; speedSum: number; lift: number; airOnSpan: number
  onSpanFrames: number; wrongHalfFrames: number; exposed: number; latSum: number
}
const byLoco = new Map<string, Acc>()
const byChassis = new Map<string, Acc>()
const get = (m: Map<string, Acc>, k: string): Acc => {
  let a = m.get(k)
  if (!a) {
    a = {
      entries: 0, falls: 0, crossings: 0, speedSum: 0, lift: 0, airOnSpan: 0,
      onSpanFrames: 0, wrongHalfFrames: 0, exposed: 0, latSum: 0,
    }
    m.set(k, a)
  }
  return a
}
const onSpan = (s: number): number => {
  for (let i = 0; i < track.bridges.length; i++) {
    const b = track.bridges[i]
    const s0 = b.s0 % track.length, s1 = b.s1 % track.length
    if (s1 >= s0 ? (s >= s0 && s <= s1) : (s >= s0 || s <= s1)) return i
  }
  return -1
}

let laps = 0, lapSum = 0
for (let race = 0; race < RACES; race++) {
  resetAI()
  const r = new Race(track, cfg(race + 1))
  const idle = emptyInput()
  const wasOn = new Array<number>(8).fill(-1)
  const wasResp = new Array<boolean>(8).fill(false)
  const enteredAt = new Array<number>(8).fill(-1)
  for (const x of r.state.racers) { get(byLoco, getLocomotion(x.chassisId) === undefined ? '?' : CHASSIS.find((c) => c.id === x.chassisId)!.locomotion).entries++; get(byChassis, x.chassisId).entries++ }
  for (let f = 0; f < 60 * 420 && r.state.phase !== 'finished'; f++) {
    for (const x of r.state.racers) if (!x.isAI) r.setInput(x.id, idle)
    r.step()
    for (const x of r.state.racers) {
      if (x.finished) continue
      const loco = CHASSIS.find((c) => c.id === x.chassisId)!.locomotion
      const L = get(byLoco, loco), C = get(byChassis, x.chassisId)
      const idx = onSpan(x.splineS)
      if (idx >= 0) {
        if (!x.grounded) { L.airOnSpan += T.sim.dt; C.airOnSpan += T.sim.dt }
        if (x.liftActive) { L.lift += T.sim.dt; C.lift += T.sim.dt }
        // THE LANE. Read off the raw sample and the racer's own lateral, which
        // is the same pair Track.project() resolves the fall test from.
        const raw = track.at(x.splineS)
        const wrong = onDroppingHalf(raw, x.lateral)
        L.onSpanFrames++; C.onSpanFrames++
        L.latSum += x.lateral; C.latSum += x.lateral
        if (wrong) {
          L.wrongHalfFrames++; C.wrongHalfFrames++
          if (!bridgeSolid(raw.bridge, r.state.time)) { L.exposed += T.sim.dt; C.exposed += T.sim.dt }
        }
        if (wasOn[x.id] < 0) {
          enteredAt[x.id] = Math.hypot(x.vel.x, x.vel.y, x.vel.z)
        }
      } else if (wasOn[x.id] >= 0 && enteredAt[x.id] > 0 && x.respawnTime <= 0) {
        L.crossings++; C.crossings++; L.speedSum += enteredAt[x.id]; C.speedSum += enteredAt[x.id]
        enteredAt[x.id] = -1
      }
      // A respawn that STARTS while the racer is on a span is a fall through it.
      const resp = x.respawnTime > 0
      if (resp && !wasResp[x.id] && idx >= 0) { L.falls++; C.falls++; enteredAt[x.id] = -1 }
      wasResp[x.id] = resp
      wasOn[x.id] = idx
    }
  }
  for (const x of r.state.racers) for (const t of x.lapTimes) if (t > 0) { laps++; lapSum += t }
}

const pad = (s: string, n: number) => s.length >= n ? s : s + ' '.repeat(n - s.length)
const padL = (s: string, n: number) => s.length >= n ? s : ' '.repeat(n - s.length) + s
console.log(`\n${RACES} races, mean lap ${(lapSum / laps).toFixed(2)}s`)
for (const [label, m] of [['LOCOMOTION', byLoco], ['CHASSIS', byChassis]] as const) {
  console.log(`\n${label}` + ' '.repeat(Math.max(0, 12 - label.length)) +
    `${padL('entries', 8)}${padL('crossings', 10)}${padL('falls', 7)}${padL('falls/entry', 12)}${padL('entry m/s', 10)}${padL('air s', 8)}${padL('lift s', 8)}` +
    `${padL('mean lat', 10)}${padL('wrong%', 8)}${padL('exposed s', 11)}`)
  for (const [k, a] of [...m.entries()].sort()) {
    console.log(`  ${pad(k, 10)}${padL(String(a.entries), 8)}${padL(String(a.crossings), 10)}${padL(String(a.falls), 7)}` +
      `${padL((a.falls / Math.max(1, a.entries)).toFixed(2), 12)}${padL((a.speedSum / Math.max(1, a.crossings)).toFixed(1), 10)}` +
      `${padL((a.airOnSpan / Math.max(1, a.entries)).toFixed(2), 8)}${padL((a.lift / Math.max(1, a.entries)).toFixed(2), 8)}` +
      `${padL((a.latSum / Math.max(1, a.onSpanFrames)).toFixed(1), 10)}` +
      `${padL((100 * a.wrongHalfFrames / Math.max(1, a.onSpanFrames)).toFixed(1), 8)}` +
      `${padL((a.exposed / Math.max(1, a.entries)).toFixed(3), 11)}`)
  }
}
