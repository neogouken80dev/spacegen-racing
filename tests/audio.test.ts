/**
 * THE AUDIO RULES, WHICH ARE ALL RULES ABOUT NOT PLAYING SOMETHING.
 *
 * None of these can be checked in a browser. This renderer runs at 1-5fps under
 * SwiftShader, there is no way to assert on what came out of a speaker, and the
 * failures are all of the form "it played four hundred sounds instead of four"
 * -- which a human notices immediately and an automated browser check never
 * does. Pure, they run in milliseconds and fail with the actual count.
 *
 * The one that matters most is the contact test. `wall` fires on EVERY contact
 * frame by design (see RacerEvent in sim/types.ts), so a naive implementation
 * plays sixty sounds a second per car leaning on a barrier. That is not a
 * hypothetical: it is what the event was built to do, for the VFX's benefit.
 */
import { describe, it, expect } from 'vitest'
import type { RaceState, RacerEvent, RacerState } from '../src/sim/types'
import { AudioPlanner, CRASH_FORCE, HEAR_RANGE, enginePitch, engineFor, falloff } from '../src/audio/plan'
import { CATALOGUE, FIRE_SOUND, HIT_SOUND } from '../src/audio/catalogue'
import type { SoundId } from '../src/audio/api'

const ORIGIN = { x: 0, y: 0, z: 0 }

function racer(id: number, x = 0): RacerState {
  return {
    id, chassisId: 'solaire', pilotId: '', isAI: false, isLocal: id === 0,
    pos: { x, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 },
    driftSide: 0, driftCharge: 0, boostTime: 0, boostMag: 0,
    finished: false, lap: 1, position: 1,
  } as unknown as RacerState
}

function state(n = 2): RaceState {
  return {
    racers: Array.from({ length: n }, (_, i) => racer(i)),
    phase: 'racing', time: 0, frame: 0, totalLaps: 3,
  } as unknown as RaceState
}

/** Feed one racer's events for one frame. */
function frame(
  p: AudioPlanner, st: RaceState, evs: RacerEvent[], now: number, who = 0,
) {
  const carry: RacerEvent[][] = st.racers.map(() => [])
  carry[who] = evs
  return p.frame(st, carry, 0, ORIGIN, now)
}

const wallEv = (force: number): RacerEvent => ({
  t: 'wall', force, px: 0, py: 0, pz: 0, nx: 1, ny: 0, nz: 0,
})

describe('contacts do not become a machine gun', () => {
  /**
   * The headline number. A car leaning on a barrier through a long corner
   * generates one wall event per frame for as long as the contact lasts; at
   * 60fps for four seconds that is 240 events.
   */
  it('turns a four-second barrier lean into a sustained scrape, not 240 shots', () => {
    const p = new AudioPlanner()
    const st = state()
    let shots = 0
    let scrapeFrames = 0
    for (let f = 0; f < 240; f++) {
      // A lean: real contact, well under the crash threshold, every frame.
      const out = frame(p, st, [wallEv(CRASH_FORCE * 0.35)], f / 60)
      shots += out.plays.length
      if ((out.scrapes.find((s) => s.id === 'scrapeWall')?.gain ?? 0) > 0) scrapeFrames++
    }
    expect(shots, `a lean fired ${shots} one-shots`).toBe(0)
    expect(scrapeFrames, 'the scrape should be sounding the whole time')
      .toBeGreaterThan(230)
  })

  it('still fires an impact for a real crash', () => {
    const p = new AudioPlanner()
    const st = state()
    const out = frame(p, st, [wallEv(CRASH_FORCE * 1.5)], 0)
    expect(out.plays.map((x) => x.id)).toContain('crashWall')
  })

  /**
   * And the crash itself is rate-limited, because a crash is also a stream:
   * the frames on either side of the worst one are usually over the threshold
   * too.
   */
  it('does not fire one crash sound per frame of a heavy contact', () => {
    const p = new AudioPlanner()
    const st = state()
    let crashes = 0
    for (let f = 0; f < 60; f++) {
      const out = frame(p, st, [wallEv(CRASH_FORCE * 1.6)], f / 60)
      crashes += out.plays.filter((x) => x.id === 'crashWall').length
    }
    // One second of sustained heavy contact at minGap 0.18 allows about six.
    expect(crashes, `${crashes} crash sounds in one second`).toBeLessThanOrEqual(7)
    expect(crashes).toBeGreaterThan(0)
  })

  it('lets the scrape go once contact stops', () => {
    const p = new AudioPlanner()
    const st = state()
    for (let f = 0; f < 30; f++) frame(p, st, [wallEv(CRASH_FORCE * 0.4)], f / 60)
    // Release window is 0.12s; step well past it with no events.
    const after = frame(p, st, [], 30 / 60 + 0.4)
    expect(after.scrapes.find((s) => s.id === 'scrapeWall')?.gain ?? 0).toBe(0)
  })
})

describe('the voice limiter', () => {
  it('collapses one missile catching three cars into a single sound', () => {
    const p = new AudioPlanner()
    const st = state(4)
    const carry: RacerEvent[][] = st.racers.map(() => [])
    // Same frame, three victims, one explosion.
    for (const i of [1, 2, 3]) carry[i] = [{ t: 'hit', item: 'railMissile' }]
    const out = p.frame(st, carry, 0, ORIGIN, 0)
    const hits = out.plays.filter((x) => x.id === 'hitLight')
    expect(hits.length, `${hits.length} impacts for one missile`).toBe(1)
  })

  it('lets the gatling rattle, because that is what the gatling is', () => {
    const p = new AudioPlanner()
    const st = state()
    let rounds = 0
    // Ten rounds a second for a second, its real fire rate.
    for (let f = 0; f < 60; f++) {
      const evs: RacerEvent[] = f % 6 === 0 ? [{ t: 'fire', item: 'laserGatling' }] : []
      rounds += frame(p, st, evs, f / 60).plays.length
    }
    expect(rounds, 'the gatling should not be throttled to silence')
      .toBeGreaterThanOrEqual(8)
  })

  it('honours each sound’s own repeat floor', () => {
    const p = new AudioPlanner()
    const st = state()
    let n = 0
    // Ask for the same boost every single frame for a second.
    for (let f = 0; f < 60; f++) {
      n += frame(p, st, [{ t: 'boost', tier: 3 }], f / 60).plays.length
    }
    const cap = Math.ceil(1 / CATALOGUE.boost3.minGap) + 1
    expect(n, `${n} boosts in a second against a ${CATALOGUE.boost3.minGap}s floor`)
      .toBeLessThanOrEqual(cap)
  })

  it('starts clean after a reset, so a rematch cannot inherit a held scrape', () => {
    const p = new AudioPlanner()
    const st = state()
    for (let f = 0; f < 20; f++) frame(p, st, [wallEv(CRASH_FORCE * 0.5)], f / 60)
    p.reset()
    const out = frame(p, st, [], 0)
    expect(out.scrapes.every((s) => s.gain === 0)).toBe(true)
  })
})

describe('the field stays audible', () => {
  it('drops another car entirely past the hearing range', () => {
    const p = new AudioPlanner()
    const st = state(2)
    st.racers[1].pos.x = HEAR_RANGE + 50
    const carry: RacerEvent[][] = [[], [{ t: 'pickup' }]]
    expect(p.frame(st, carry, 0, ORIGIN, 0).plays.length).toBe(0)
  })

  it('attenuates with distance, and never gains with it', () => {
    let prev = Infinity
    for (const d of [0, 5, 20, 50, 100, 140, 200]) {
      const f = falloff(d)
      expect(f).toBeLessThanOrEqual(prev + 1e-9)
      expect(f).toBeGreaterThanOrEqual(0)
      expect(f).toBeLessThanOrEqual(1)
      prev = f
    }
    expect(falloff(HEAR_RANGE + 1)).toBe(0)
  })

  /**
   * Your own drift is worth hearing. Seven other cars entering slides is an
   * undifferentiated hiss that tells the player nothing.
   */
  it('keeps another car’s drift silent but plays your own', () => {
    const p = new AudioPlanner()
    const st = state(2)
    expect(frame(p, st, [{ t: 'driftStart' }], 0, 0).plays.length).toBe(1)
    const q = new AudioPlanner()
    expect(frame(q, st, [{ t: 'driftStart' }], 0, 1).plays.length).toBe(0)
  })
})

describe('the engine voice', () => {
  it('rises with speed and never runs away', () => {
    let prev = 0
    for (const v of [0, 10, 30, 50, 70, 90]) {
      const r = enginePitch(v, 70)
      expect(r).toBeGreaterThan(prev - 1e-9)
      expect(r).toBeGreaterThan(0.3)
      expect(r, `pitch ${r} at ${v} m/s is a siren`).toBeLessThan(2.4)
      prev = r
    }
  })

  it('is audible at a standstill, so the grid is not dead', () => {
    const r = racer(0)
    const v = engineFor(r, 70, true, ORIGIN)
    expect(v).not.toBeNull()
    expect(v!.gain).toBeGreaterThan(0.1)
  })

  it('retires a distant car rather than keeping an oscillator for it', () => {
    const r = racer(1, HEAR_RANGE)
    expect(engineFor(r, 70, false, ORIGIN)).toBeNull()
  })
})

/**
 * THE BUG THE UNIT TESTS COULD NOT SEE.
 *
 * Every test above hands the planner a DENSE array built by `state().racers.map`,
 * because that is what the signature says. main.ts handed it `eventCarry`, whose
 * slots are created lazily only for racers that have had an event -- so a real
 * eight-car race with a quiet racer 0 produced a hole, and `for (const ev of
 * events[i])` threw on undefined every single frame. tools/smoke.mjs caught it;
 * 397 unit tests did not, because they all built the input the correct way.
 */
describe('a caller that gets the array shape wrong', () => {
  it('treats a missing racer slot as silence rather than throwing', () => {
    const p = new AudioPlanner()
    const st = state(4)
    const sparse: RacerEvent[][] = []
    sparse[3] = [{ t: 'pickup' }]        // holes at 0, 1, 2
    expect(() => p.frame(st, sparse, 0, ORIGIN, 0)).not.toThrow()
  })

  it('still plays the events that ARE there', () => {
    const p = new AudioPlanner()
    const st = state(4)
    const sparse: RacerEvent[][] = []
    sparse[0] = [{ t: 'boost', tier: 2 }]
    expect(p.frame(st, sparse, 0, ORIGIN, 0).plays.length).toBe(1)
  })
})

describe('the catalogue is complete', () => {
  it('has a fire and a hit sound for every item', () => {
    for (const [item, id] of Object.entries(FIRE_SOUND)) {
      expect(CATALOGUE[id as SoundId], `${item} fires ${id}, which is not in the catalogue`)
        .toBeDefined()
    }
    for (const [item, id] of Object.entries(HIT_SOUND)) {
      expect(CATALOGUE[id as SoundId], `${item} hits as ${id}, which is not in the catalogue`)
        .toBeDefined()
    }
  })

  it('gives every sound a repeat floor and a voice cap', () => {
    for (const [id, def] of Object.entries(CATALOGUE)) {
      expect(def.minGap, `${id} has no repeat floor`).toBeGreaterThanOrEqual(0)
      expect(def.maxVoices, `${id} may play unlimited voices`).toBeGreaterThan(0)
      expect(def.maxVoices, `${id} allows ${def.maxVoices} voices at once`).toBeLessThanOrEqual(8)
    }
  })
})
