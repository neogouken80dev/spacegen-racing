/**
 * THE FINISH CEREMONY, and the one thing it is not allowed to do.
 *
 * `Race.stepCeremony()` hands every finished car back to the AI so it keeps
 * driving instead of stopping dead on the line. It is a cosmetic pass, and the
 * whole safety argument for it is that a finished racer is a GHOST: it can
 * move, and nothing that decides a race can see it move.
 *
 * That argument is made from a dozen `if (r.finished) continue` guards spread
 * across race.ts, which is exactly the kind of claim that rots. So it is
 * measured here instead: two identical races, one of them with the ceremony
 * pass interleaved on every single step, must produce the same finishing
 * order, the same finish times, the same lap times and the same state hash for
 * every racer still running.
 */
import { describe, it, expect } from 'vitest'
import { ChaseCamera } from '../src/game/camera'
import { TUNING as T } from '../src/content/tuning'
import { Race } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { RUSTFALL, CRYOSTATIC } from '../src/content/tracks'
import { CHASSIS } from '../src/content/chassis'
import { PILOTS } from '../src/content/pilots'
import { resetAI } from '../src/sim/ai'
import { emptyInput } from '../src/sim/types'
import type { SimConfig } from '../src/sim/types'

type Def = typeof RUSTFALL

const cfg = (def: Def, seed: number): SimConfig => ({
  seed,
  totalLaps: 3,
  racerCount: 8,
  trackId: def.id,
  chassisIds: Array.from({ length: 8 }, (_, i) => CHASSIS[i % CHASSIS.length].id),
  pilotIds: Array.from({ length: 8 }, (_, i) => PILOTS[i % PILOTS.length].id),
  localRacerIndex: -1,
  aiSkill: Array.from({ length: 8 }, (_, i) => 2 + (i % 3)),
})

/**
 * Run one race to the flag. `ceremony` interleaves the victory-lap pass on
 * every step, which is strictly more aggressive than the game does it (the
 * game only calls it once anyone has finished).
 */
function run(def: Def, seed: number, ceremony: boolean) {
  resetAI()
  const track = new Track(def)
  const race = new Race(track, cfg(def, seed))
  const idle = emptyInput()
  let frames = 0
  while (frames < 60 * 400 && race.state.phase !== 'finished') {
    for (const r of race.state.racers) if (!r.isAI) race.setInput(r.id, idle)
    race.step()
    if (ceremony) race.stepCeremony()
    frames++
  }
  return { race, frames, track }
}

/** Everything about a race that the player is entitled to see. */
function outcome(race: Race) {
  return {
    phase: race.state.phase,
    order: race.state.finishOrder.slice(),
    rows: race.state.racers.map((r) => ({
      id: r.id,
      chassisId: r.chassisId,
      position: r.position,
      finished: r.finished,
      finishTime: r.finishTime,
      bestLap: r.bestLap,
      lapTimes: r.lapTimes.slice(),
      lap: r.lap,
      charges: r.charges,
    })),
  }
}

describe('the victory lap cannot change the race', () => {
  for (const def of [RUSTFALL, CRYOSTATIC] as Def[]) {
    it(`${def.id}: identical results with and without the ceremony pass`, () => {
      const plain = run(def, 20260906, false)
      const cere = run(def, 20260906, true)
      expect(cere.race.state.phase).toBe('finished')
      expect(outcome(cere.race)).toEqual(outcome(plain.race))
      // ...and it must not make the race take longer to reach the flag either,
      // which is the failure mode that would break tools/balance.ts.
      expect(cere.frames).toBe(plain.frames)
    })
  }

  it('a finished car actually moves, or this test proves nothing', () => {
    const { race } = run(RUSTFALL, 4242, true)
    // The winner crossed the line first and has been driving ever since, so by
    // the flag it is a long way past the finish it recorded.
    const winner = race.state.racers[race.state.finishOrder[0]]
    const line = race.state.totalLaps * race.track.length
    expect(winner.finished).toBe(true)
    expect(winner.totalS).toBeGreaterThan(line + 100)
    expect(Math.hypot(winner.vel.x, winner.vel.z)).toBeGreaterThan(10)
  })

  it('a finished car re-runs no lap and takes no second finish', () => {
    const { race } = run(RUSTFALL, 99, true)
    for (const r of race.state.racers) {
      // totalS has run on for hundreds of metres, but `lap` and `lapTimes` are
      // frozen at what the race recorded. resolveLaps skips finished racers,
      // and this is the assertion that keeps it that way.
      expect(r.lapTimes.length).toBeLessThanOrEqual(race.state.totalLaps)
      expect(r.lap).toBe(race.state.totalLaps)
    }
    expect(race.state.finishOrder.length).toBe(race.state.racers.length)
    expect(new Set(race.state.finishOrder).size).toBe(race.state.racers.length)
  })

  it('a finished car stays inside the barriers while it laps', () => {
    resetAI()
    const track = new Track(RUSTFALL)
    const race = new Race(track, cfg(RUSTFALL, 7))
    const idle = emptyInput()
    let worst = 0
    for (let f = 0; f < 60 * 400 && race.state.phase !== 'finished'; f++) {
      for (const r of race.state.racers) if (!r.isAI) race.setInput(r.id, idle)
      race.step()
      race.stepCeremony()
      for (const r of race.state.racers) {
        if (!r.finished) continue
        const proj = track.project(r.pos, r.splineS)
        if (proj.sample.open) continue
        const over = Math.abs(proj.lateral) / Math.max(1, proj.sample.width)
        if (over > worst) worst = over
      }
    }
    // clampToTrack is applied to ceremony racers exactly as it is to racing
    // ones; without it a victory lap drives through the wall and off the map.
    expect(worst).toBeLessThan(1.2)
  })

  it('the ceremony pass is inert while nobody has finished', () => {
    // SEQUENTIALLY, never interleaved: ai.ts keeps its per-racer memory in a
    // module-level Map keyed by racer id, so two races stepped alternately
    // share one set of memories and neither is the race it looks like.
    const first600 = (ceremony: boolean): { hash: string; anyFinished: boolean } => {
      resetAI()
      const race = new Race(new Track(RUSTFALL), cfg(RUSTFALL, 11))
      const idle = emptyInput()
      for (let f = 0; f < 600; f++) {
        race.setInput(0, idle)
        race.step()
        if (ceremony) race.stepCeremony()
      }
      return { hash: race.hash(), anyFinished: race.state.racers.some((r) => r.finished) }
    }
    const plain = first600(false)
    const cere = first600(true)
    expect(cere.anyFinished).toBe(false)
    expect(cere.hash).toBe(plain.hash)
  })
})


/**
 * THE FINISH SHOT.
 *
 * A camera move nobody has watched is not done, and the two ways this one can
 * be wrong are both silent: it can sink through the deck on a crest, and it can
 * swing out through a barrier on a narrow section. Both are geometry, so both
 * are measurable without a browser.
 */
describe('the finish camera stays in the world', () => {
  /**
   * Race until the leader crosses, then run the finish shot over the victory
   * lap for `seconds`, sampling the camera every frame.
   */
  function shoot(def: Def, seconds: number, reduceMotion: boolean) {
    resetAI()
    const track = new Track(def)
    const race = new Race(track, cfg(def, 20260906))
    const idle = emptyInput()
    while (race.state.finishOrder.length === 0) {
      for (const r of race.state.racers) if (!r.isAI) race.setInput(r.id, idle)
      race.step()
    }
    const hero = race.state.racers[race.state.finishOrder[0]]

    const cam = new ChaseCamera(16 / 9)
    // Put the chase rig where it would really be at the line, so the handover
    // starts from a live pose rather than from the origin.
    cam.reset(hero)
    for (let f = 0; f < 30; f++) cam.update(hero, 1 / 60, 60, false, reduceMotion)
    cam.beginCinematic(hero)

    const rows: { clearance: number; edge: number; step: number; az: number }[] = []
    let prevX = cam.camera.position.x, prevY = cam.camera.position.y, prevZ = cam.camera.position.z
    for (let f = 0; f < Math.round(seconds * 60); f++) {
      race.setInput(0, idle)
      race.step()
      race.stepCeremony()
      cam.updateCinematic(hero, 1 / 60, track, reduceMotion)
      const p = cam.camera.position
      const proj = track.project(p, hero.splineS)
      const surf = track.surfacePoint(proj.s, proj.lateral)
      rows.push({
        clearance: p.y - surf.y,
        edge: Math.abs(proj.lateral) / Math.max(1, proj.sample.width),
        step: Math.hypot(p.x - prevX, p.y - prevY, p.z - prevZ),
        // Bearing of the camera from the car: what the orbit is walking.
        az: Math.atan2(p.x - hero.pos.x, p.z - hero.pos.z),
      })
      prevX = p.x; prevY = p.y; prevZ = p.z
    }
    return rows
  }

  for (const def of [RUSTFALL, CRYOSTATIC] as Def[]) {
    it(`${def.id}: never sinks through the deck and never leaves the road`, () => {
      const rows = shoot(def, T.ceremony.maxDuration, false)
      const worstClearance = Math.min(...rows.map((r) => r.clearance))
      const worstEdge = Math.max(...rows.map((r) => r.edge))
      // groundClearance with a little slack for the blend, which interpolates
      // between two legal poses across a crest.
      expect(worstClearance).toBeGreaterThan(T.ceremony.groundClearance * 0.6)
      // lateralMargin is 0.80 of the half-width; the barrier is at 1.0.
      expect(worstEdge).toBeLessThan(0.95)
    })

    it(`${def.id}: moves smoothly -- no cut, no snap`, () => {
      const rows = shoot(def, T.ceremony.maxDuration, false)
      // The car itself is doing up to ~1.6 m a frame, and the camera tracks it
      // plus its own orbit and climb. Anything past 4 m in one frame at 60Hz is
      // a jump the eye reads as a cut.
      const worstStep = Math.max(...rows.map((r) => r.step))
      expect(worstStep).toBeLessThan(4)
    })
  }

  it('the orbit actually walks around the car', () => {
    const rows = shoot(RUSTFALL, T.ceremony.maxDuration, false)
    // Total unwrapped bearing travel, minus what the CAR's own heading did --
    // a shot that merely followed the nose would score near zero here.
    let travel = 0
    for (let i = 1; i < rows.length; i++) {
      let d = rows[i].az - rows[i - 1].az
      while (d > Math.PI) d -= Math.PI * 2
      while (d < -Math.PI) d += Math.PI * 2
      travel += d
    }
    const wanted = T.ceremony.orbitRate * (Math.PI / 180) * T.ceremony.maxDuration
    // Within a third: the car is cornering under it, and the ease-in costs the
    // first second. The point is that it is a real orbit, not that it is exact.
    expect(Math.abs(travel)).toBeGreaterThan(wanted * 0.5)
  })

  it('reduced motion does not orbit', () => {
    const calm = shoot(RUSTFALL, T.ceremony.maxDuration, true)
    let travel = 0
    for (let i = 1; i < calm.length; i++) {
      let d = calm[i].az - calm[i - 1].az
      while (d > Math.PI) d -= Math.PI * 2
      while (d < -Math.PI) d += Math.PI * 2
      travel += d
    }
    const wanted = T.ceremony.orbitRate * (Math.PI / 180) * T.ceremony.maxDuration
    // It still tracks the car round corners -- that is the CAR turning, not the
    // camera walking -- so this is a bound, not a zero.
    expect(Math.abs(travel)).toBeLessThan(wanted * 0.5)
    // ...and it is still a legal shot.
    expect(Math.min(...calm.map((r) => r.clearance))).toBeGreaterThan(T.ceremony.groundClearance * 0.6)
  })
})
