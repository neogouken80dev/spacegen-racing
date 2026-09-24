/**
 * One-shot events reach the render pass exactly once, at any display rate.
 *
 * The bug this pins: on a 120Hz or 144Hz screen about half the render frames
 * run no sim step, and the loop used to leave the previous step's events in
 * `r.events` on those frames. The scorer read them again and paid every award
 * twice -- one Rustfall race scored 392,840 at 60Hz, 613,769 at 120Hz and
 * 702,337 at 144Hz, and credits are priced on score.
 *
 * Driven the way the game drives it: the render loop's accumulator (the same
 * DT and sub-step cap main.ts uses), the real EventCarry main.ts uses, a real
 * race, and the real Scorer fed `local.events` once per rendered frame. Same
 * seed, same field, so the only thing that changes between rates is how the
 * steps fall across frames -- and the score must not care.
 */
import { describe, it, expect } from 'vitest'
import { Race } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { TRACKS_BY_ID } from '../src/content/tracks'
import { CHASSIS } from '../src/content/chassis'
import { PILOTS } from '../src/content/pilots'
import { resetAI } from '../src/sim/ai'
import { skillForSlot } from '../src/content/difficulty'
import { TUNING as T } from '../src/content/tuning'
import type { RacerState, SimConfig } from '../src/sim/types'
import { Scorer } from '../src/score/scorer'
import { EventCarry } from '../src/game/eventCarry'

const DT = T.sim.dt
const MAX_SUB = T.sim.maxSubSteps

interface Outcome {
  score: number
  awards: string
  frames: number
  idleFrames: number
}

/** One race's first `seconds`, rendered at `hz`. */
function render(hz: number, seconds: number): Outcome {
  resetAI()
  const def = TRACKS_BY_ID.rustfall
  const n = 8
  const cfg: SimConfig = {
    seed: 20260904, totalLaps: 3, racerCount: n, trackId: def.id,
    chassisIds: Array.from({ length: n }, (_, i) => CHASSIS[i % CHASSIS.length].id),
    pilotIds: Array.from({ length: n }, (_, i) => PILOTS[i % PILOTS.length].id),
    localRacerIndex: -1,
    aiSkill: Array.from({ length: n }, (_, i) => skillForSlot('normal', i)),
  }
  const race = new Race(new Track(def), cfg)
  const scorer = new Scorer()
  const carry = new EventCarry()
  const local = race.state.racers[0]
  const kinds = new Map<string, number>()
  let acc = 0
  let frames = 0
  let idleFrames = 0
  while (!local.finished && race.state.time < seconds) {
    // main.ts's loop, minus the renderer.
    acc += 1 / hz
    let steps = 0
    while (acc >= DT && steps < MAX_SUB) {
      race.step()
      carry.collect(race.state.racers)
      acc -= DT
      steps++
    }
    carry.publish(race.state.racers, steps)
    if (steps === MAX_SUB) acc = 0
    if (steps === 0) idleFrames++
    frames++
    const out = scorer.frame(race.state, local, local.events)
    for (const a of out.awards) kinds.set(a.kind, (kinds.get(a.kind) ?? 0) + 1)
  }
  const awards = [...kinds].sort().map(([k, v]) => `${k}:${v}`).join(' ')
  return { score: scorer.score, awards, frames, idleFrames }
}

describe('events at any display rate', () => {
  it('scores the same race the same at 60, 120 and 144Hz', () => {
    const at60 = render(60, 60)
    const at120 = render(120, 60)
    const at144 = render(144, 60)
    // The premise: the fast screens really did render frames with no step.
    // If they stop doing so the test proves nothing, so say so.
    expect(at60.idleFrames).toBe(0)
    expect(at120.idleFrames).toBeGreaterThan(at120.frames * 0.4)
    expect(at144.idleFrames).toBeGreaterThan(at144.frames * 0.5)
    // Something was actually scored, including the drift releases the old
    // loop double-paid.
    expect(at60.score).toBeGreaterThan(0)
    expect(at60.awards).toContain('driftRelease')
    // And the display rate changes nothing about it.
    expect(at120.score).toBe(at60.score)
    expect(at144.score).toBe(at60.score)
    expect(at120.awards).toBe(at60.awards)
    expect(at144.awards).toBe(at60.awards)
  })
})

describe('EventCarry', () => {
  const racer = (): RacerState => ({ events: [] } as unknown as RacerState)

  it('publishes every step of a frame, in order', () => {
    const r = [racer()]
    const c = new EventCarry()
    r[0].events.push({ t: 'driftStart' })
    c.collect(r)
    r[0].events.length = 0 // what race.step() does at the top of a step
    r[0].events.push({ t: 'driftEnd', tier: 2 })
    c.collect(r)
    c.publish(r, 2)
    expect(r[0].events).toEqual([{ t: 'driftStart' }, { t: 'driftEnd', tier: 2 }])
  })

  it('publishes nothing on a frame that ran no step', () => {
    const r = [racer()]
    const c = new EventCarry()
    r[0].events.push({ t: 'boost', tier: 3 })
    c.collect(r)
    c.publish(r, 1)
    expect(r[0].events.length).toBe(1)
    // Next frame, no step: the boost must not be seen a second time.
    c.publish(r, 0)
    expect(r[0].events.length).toBe(0)
  })

  it('forgets a banked frame on reset', () => {
    const r = [racer()]
    const c = new EventCarry()
    r[0].events.push({ t: 'pickup' })
    c.collect(r)
    c.reset()
    r[0].events.length = 0
    c.publish(r, 1)
    expect(r[0].events.length).toBe(0)
  })
})
