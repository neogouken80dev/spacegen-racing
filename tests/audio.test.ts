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
import { describe, it, expect, afterEach } from 'vitest'
import type { Projectile, RaceState, RacerEvent, RacerState } from '../src/sim/types'
import { AudioPlanner, CRASH_FORCE, HEAR_RANGE, enginePitch, engineFor, falloff } from '../src/audio/plan'
import { CATALOGUE, FIRE_SOUND, HIT_SOUND } from '../src/audio/catalogue'
import type { AudioFrame, SoundId } from '../src/audio/api'
import { THREAT_RANGE, RAIL_WINDOW, lockOnTime, threatTime, urgency } from '../src/audio/threat'
import { clearCueSink, cue, setCueSink } from '../src/audio/cues'
import { TUNING } from '../src/content/tuning'

const ORIGIN = { x: 0, y: 0, z: 0 }

function racer(id: number, x = 0): RacerState {
  return {
    id, chassisId: 'solaire', pilotId: '', isAI: false, isLocal: id === 0,
    pos: { x, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 },
    driftSide: 0, driftCharge: 0, driftTier: -1, boostTime: 0, boostMag: 0,
    stunTime: 0, finished: false, lap: 1, position: 1,
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
    for (const i of [1, 2, 3]) carry[i] = [{ t: 'hit', item: 'railMissile', by: -1 }]
    const out = p.frame(st, carry, 0, ORIGIN, 0)
    const hits = out.plays.filter((x) => x.id === 'hitLight')
    expect(hits.length, `${hits.length} impacts for one missile`).toBe(1)
  })

  /**
   * The rattle is `beamFire`, one per round (race.ts stepGatling). This used to
   * feed `fire` for laserGatling ten times a second, which exercised a cadence
   * the game never produces: the sim pushes `fire` ONCE when the item is
   * triggered, and the catalogue comment built on that premise was wrong too.
   */
  it('lets the gatling rattle, because that is what the gatling is', () => {
    const p = new AudioPlanner()
    const st = state()
    let rounds = 0
    // Ten rounds a second for a second, its real fire rate.
    for (let f = 0; f < 60; f++) {
      const evs: RacerEvent[] = f % 6 === 0 ? [{ t: 'beamFire' }] : []
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

// ---------------------------------------------------------------------------
// THE PLAYER IS HEARD FIRST, AND THE FIELD CANNOT SPEND THEIR SLOTS.
// ---------------------------------------------------------------------------

/** One frame with every racer's events given explicitly, from seat `me`. */
function seat(
  p: AudioPlanner, st: RaceState, carry: RacerEvent[][], me: number, now: number,
): AudioFrame {
  return p.frame(st, carry, me, ORIGIN, now)
}

/** Eight cars in a tight pack round the listener, all well inside HEAR_RANGE. */
function pack(): RaceState {
  const st = state(8)
  st.racers.forEach((r, i) => { r.pos.x = 6 + i * 3; r.isLocal = false })
  return st
}

describe('the player cannot be crowded out by the field', () => {
  /**
   * The measured bug: one shared set of floors, visited in index order, so a
   * car with a lower number spent the player's slot. Seat 5 lost 16 of 17 EMP
   * hits over six AI races, because an EMP lands on the whole field in one
   * frame and cars 0-4 were always asked first.
   */
  it('plays the player’s EMP hit from any seat, however many cars it also hit', () => {
    for (const me of [0, 3, 5, 7]) {
      const p = new AudioPlanner()
      const st = pack()
      st.racers[me].isLocal = true
      const carry: RacerEvent[][] = st.racers.map(() => [{ t: 'hit', item: 'empBomb', by: -1 } as RacerEvent])
      const out = seat(p, st, carry, me, 1)
      const flat = out.plays.filter((x) => x.id === 'hitEmp' && x.at === null)
      expect(flat.length, `seat ${me}: the player's own EMP hit was not played`).toBe(1)
    }
  })

  it('never loses the player’s boost to an AI boost that just played', () => {
    const p = new AudioPlanner()
    const st = pack()
    const me = 4
    st.racers[me].isLocal = true
    let mine = 0
    let asked = 0
    // A second of every AI car boosting every frame, and the player boosting
    // every quarter second -- clear of boost's own 0.10 s floor AND of its own
    // two-voice cap at the 0.4 s hold, so the only thing that could silence
    // one of these is the field.
    for (let f = 0; f < 60; f++) {
      const now = f / 60
      const carry: RacerEvent[][] = st.racers.map(() => [{ t: 'boost', tier: 1 } as RacerEvent])
      if (f % 15 !== 3) carry[me] = []
      else asked++
      const out = seat(p, st, carry, me, now)
      mine += out.plays.filter((x) => x.id === 'boost1' && x.at === null).length
    }
    expect(mine, `${mine} of ${asked} of the player's boosts sounded`).toBe(asked)
  })

  /**
   * Split floors must not become double floors. One missile, you and the car
   * beside you, one frame: one explosion -- and it is yours.
   */
  it('lets the field yield to the player’s copy of one shared moment', () => {
    const p = new AudioPlanner()
    const st = state(2)
    st.racers[1].pos.x = 8
    const carry: RacerEvent[][] = [
      [{ t: 'hit', item: 'railMissile', by: -1 }],
      [{ t: 'hit', item: 'railMissile', by: -1 }],
    ]
    const out = p.frame(st, carry, 0, ORIGIN, 0)
    const hits = out.plays.filter((x) => x.id === 'hitLight')
    expect(hits.length).toBe(1)
    expect(hits[0].at, 'the one that plays should be the player’s, flat').toBeNull()
  })

  it('hears one car-to-car crash once, though both cars report it', () => {
    const p = new AudioPlanner()
    const st = state(2)
    st.racers[1].pos.x = 3
    const b = (nx: number): RacerEvent => ({ t: 'bump', force: CRASH_FORCE * 1.4, px: 1.5, py: 0, pz: 0, nx, ny: 0, nz: 0 })
    const out = p.frame(st, [[b(1)], [b(-1)]], 0, ORIGIN, 0)
    expect(out.plays.filter((x) => x.id === 'crashCar').length).toBe(1)
  })
})

describe('another car sounds like another car', () => {
  it('places another car’s boost, nitro and gatling break, and trims them', () => {
    for (const ev of [
      { t: 'boost', tier: 2 }, { t: 'fire', item: 'nitro' }, { t: 'beamHit', targetId: 0, lethal: true },
    ] as RacerEvent[]) {
      const p = new AudioPlanner()
      const st = state(2)
      st.racers[1].pos.x = 10   // inside NEAR_RANGE: falloff is exactly 1
      const out = p.frame(st, [[], [ev]], 0, ORIGIN, 0)
      expect(out.plays.length, `${ev.t} from another car made no sound`).toBe(1)
      expect(out.plays[0].at, `${ev.t} from another car should be positional`).not.toBeNull()
      expect(out.plays[0].gain).toBeCloseTo(0.6, 5)
    }
  })

  it('still plays the player’s own boost flat and at full level', () => {
    const p = new AudioPlanner()
    const out = frame(p, state(2), [{ t: 'boost', tier: 2 }], 0)
    expect(out.plays[0].at).toBeNull()
    expect(out.plays[0].gain).toBe(1)
  })

  /**
   * 73% of the scrape the player heard over six AI races was somebody else
   * leaning on a barrier. The scrape is one flat voice; it can only honestly
   * describe the player's own contact.
   */
  it('keeps the scrape for the player’s own contact', () => {
    const p = new AudioPlanner()
    const st = state(2)
    st.racers[1].pos.x = 8
    let loud = 0
    for (let f = 0; f < 60; f++) {
      const out = frame(p, st, [wallEv(CRASH_FORCE * 0.5)], f / 60, 1)
      if ((out.scrapes.find((s) => s.id === 'scrapeWall')?.gain ?? 0) > 0) loud++
    }
    expect(loud, 'another car’s barrier lean drove the player’s scrape').toBe(0)
  })
})

describe('the race cues say what actually happened', () => {
  /**
   * `lap` carries laps COMPLETED. The final-lap cue was keyed `>= total`, which
   * is the chequered flag: it announced the last lap as the race ended.
   */
  it('fires lapFinal as the last lap begins, and leaves the flag to finish', () => {
    const p = new AudioPlanner()
    const st = state(2)
    const heard = (lap: number, t: number): SoundId[] =>
      frame(p, st, lap === 3
        ? [{ t: 'lap', lap, time: 60 }, { t: 'finish', position: 1 }]
        : [{ t: 'lap', lap, time: 60 }], t).plays.map((x) => x.id)
    expect(heard(1, 60)).toEqual(['lap'])
    expect(heard(2, 120)).toEqual(['lapFinal'])
    expect(heard(3, 180)).toEqual(['finish'])
  })

  /**
   * The plating's `guard` is pushed in the same step as the wall contact it
   * absorbed, and that contact still reports its whole force. 28 of 28 guards
   * over six AI races played a crash on top of the chime.
   */
  it('never plays crashWall on a frame the plating held', () => {
    for (const who of [0, 1]) {
      const p = new AudioPlanner()
      const st = state(2)
      st.racers[1].pos.x = 8
      const out = frame(p, st, [{ t: 'guard' }, wallEv(CRASH_FORCE * 2.5)], 0, who)
      const ids = out.plays.map((x) => x.id)
      expect(ids, `racer ${who}: the guard itself should sound`).toContain('guard')
      expect(ids, `racer ${who}: a held impact played a crash`).not.toContain('crashWall')
    }
    // ...and an unguarded crash of the same force still does.
    const q = new AudioPlanner()
    expect(frame(q, state(2), [wallEv(CRASH_FORCE * 2.5)], 0).plays.map((x) => x.id)).toContain('crashWall')
  })

  it('keeps the clean-landing chime for a landing that paid', () => {
    const p = new AudioPlanner()
    const st = state(2)
    expect(frame(p, st, [{ t: 'land', clean: true }], 0).plays.map((x) => x.id)).toEqual(['land'])
    const out = frame(p, st, [{ t: 'boost', tier: 0 }, { t: 'land', clean: true }], 1).plays.map((x) => x.id)
    expect(out).toContain('landClean')
    expect(out).not.toContain('land')
  })

  /**
   * Catalogued, preloaded, described in index.ts as how "the drift already
   * speaks" -- and never played. It climbs a whole tone per rung now.
   */
  it('plays the drift ladder as it climbs, and higher on every rung', () => {
    const p = new AudioPlanner()
    const st = state(2)
    const me = st.racers[0]
    me.driftSide = 1
    const rates: number[] = []
    for (let tier = -1; tier <= 3; tier++) {
      me.driftTier = tier
      // Two frames per rung: the second must not re-fire it.
      for (let k = 0; k < 2; k++) {
        const out = frame(p, st, [], tier + 1 + k * 0.3)
        for (const x of out.plays) if (x.id === 'driftTier') rates.push(x.rate)
      }
    }
    expect(rates.length, 'one sound per rung, four rungs').toBe(4)
    for (let i = 1; i < rates.length; i++) expect(rates[i]).toBeGreaterThan(rates[i - 1])
    // Releasing and re-entering starts the ladder again from the bottom.
    me.driftSide = 0; me.driftTier = -1
    frame(p, st, [], 10)
    me.driftSide = -1; me.driftTier = 0
    expect(frame(p, st, [], 11).plays.map((x) => x.id)).toContain('driftTier')
  })

  it('does not play another car’s drift ladder', () => {
    const p = new AudioPlanner()
    const st = state(2)
    st.racers[1].driftSide = 1
    st.racers[1].driftTier = 2
    expect(frame(p, st, [], 0).plays.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// THE LOCK-ON TONE, AND THE THREAT RULE IT SHARES WITH THE RIM
// ---------------------------------------------------------------------------

function missile(kind: Projectile['kind'], owner: number, target: number, x: number, vx: number): Projectile {
  return {
    id: 1, kind, ownerId: owner, targetId: target,
    pos: { x, y: 0, z: 0 }, vel: { x: vx, y: 0, z: 0 },
    splineS: 0, life: 5, alive: true,
  }
}

describe('what counts as incoming', () => {
  it('never counts a gatling round', () => {
    expect(threatTime(missile('bullet', 1, -1, -20, 140), racer(0))).toBe(-1)
  })

  it('counts a seeker or an Alpha only against its own target', () => {
    for (const kind of ['seeker', 'alpha'] as const) {
      expect(threatTime(missile(kind, 1, 0, -40, 65), racer(0))).toBeGreaterThan(0)
      expect(threatTime(missile(kind, 1, 2, -40, 65), racer(0))).toBe(-1)
    }
  })

  it('never counts the player’s own missile, or one out of range', () => {
    expect(threatTime(missile('seeker', 0, 0, -40, 65), racer(0))).toBe(-1)
    expect(threatTime(missile('seeker', 1, 0, -(THREAT_RANGE + 5), 65), racer(0))).toBe(-1)
  })

  it('counts a rail only while its line reaches the player inside the window', () => {
    const me = racer(0)
    // Straight at the player, 40 m out at 90 m/s: 0.44 s away.
    expect(threatTime(missile('rail', 1, -1, -40, 90), me)).toBeCloseTo(40 / 90, 5)
    // Straight at the player but further than RAIL_WINDOW seconds out.
    expect(threatTime(missile('rail', 1, -1, -(90 * RAIL_WINDOW + 20), 90), me)).toBe(-1)
    // Going away.
    expect(threatTime(missile('rail', 1, -1, -40, -90), me)).toBe(-1)
    // On a parallel line one lane over: it will pass, not hit.
    const wide = missile('rail', 1, -1, -40, 90)
    wide.pos.z = 12
    expect(threatTime(wide, me)).toBe(-1)
  })

  it('reads a lock that is not closing as calm, not as absent', () => {
    const t = threatTime(missile('alpha', 1, 0, -40, 0), racer(0))
    expect(t).toBe(Infinity)
    expect(urgency(t)).toBe(0)
    expect(urgency(0.2)).toBe(1)
  })

  it('picks the most urgent homing threat and ignores rails for the lock', () => {
    const me = racer(0)
    const list = [
      missile('seeker', 1, 0, -120, 65),
      missile('seeker', 2, 0, -30, 65),
      missile('rail', 3, -1, -10, 90),
    ]
    expect(lockOnTime(list, me)).toBeCloseTo(30 / 65, 5)
  })
})

describe('the lock-on tone', () => {
  function locked(dist: number, seconds: number, target = 0): number {
    const p = new AudioPlanner()
    const st = state(2) as RaceState & { projectiles: Projectile[] }
    st.projectiles = [missile('seeker', 1, target, -dist, 65)]
    let beeps = 0
    // The missile is held where it is so the urgency stays put.
    for (let f = 0; f < seconds * 60; f++) {
      beeps += p.frame(st, [[], []], 0, ORIGIN, f / 60).plays.filter((x) => x.id === 'lockOn').length
    }
    return beeps
  }

  it('beeps faster the closer the missile is', () => {
    const far = locked(140, 3)
    const near = locked(20, 3)
    expect(far).toBeGreaterThan(0)
    expect(near, `near ${near} beeps vs far ${far}`).toBeGreaterThan(far * 2)
  })

  it('is silent for a missile hunting somebody else', () => {
    expect(locked(20, 2, 1)).toBe(0)
  })

  it('is silent for a racer who is not the player, and for a finished one', () => {
    const p = new AudioPlanner()
    const st = state(2) as RaceState & { projectiles: Projectile[] }
    st.projectiles = [missile('seeker', 1, 0, -20, 65)]
    st.racers[0].isLocal = false          // the attract loop's stand-in
    expect(p.frame(st, [[], []], 0, ORIGIN, 0).plays.length).toBe(0)
    st.racers[0].isLocal = true
    st.racers[0].finished = true
    expect(p.frame(st, [[], []], 0, ORIGIN, 1).plays.length).toBe(0)
  })

  it('holds still while the race clock does', () => {
    const p = new AudioPlanner()
    const st = state(2) as RaceState & { projectiles: Projectile[] }
    st.projectiles = [missile('seeker', 1, 0, -20, 65)]
    let beeps = 0
    // A paused race: many frames, one race time.
    for (let f = 0; f < 120; f++) beeps += p.frame(st, [[], []], 0, ORIGIN, 5).plays.length
    expect(beeps).toBe(1)
  })
})

describe('the engine when the car is stunned', () => {
  it('sputters the player’s engine, and only the player’s', () => {
    const me = racer(0)
    me.stunTime = 1.1
    const v = engineFor(me, 70, true, ORIGIN)!
    expect(v.stun).toBe(1)
    const calm = engineFor(racer(0), 70, true, ORIGIN)!
    expect(v.gain).toBeLessThan(calm.gain)
    const other = racer(1, 10)
    other.stunTime = 1.1
    expect(engineFor(other, 70, false, ORIGIN)!.stun).toBe(0)
  })

  it('catches again over the last moments rather than snapping on', () => {
    const me = racer(0)
    me.stunTime = 0.1
    const s = engineFor(me, 70, true, ORIGIN)!.stun
    expect(s).toBeGreaterThan(0)
    expect(s).toBeLessThan(1)
  })
})

describe('the numbers the comments quote', () => {
  /**
   * catalogue.ts, api.ts and stage.ts all say how many entries are recordings.
   * Three comments counted "41 of 43" for a while after the table grew, and one
   * said the game had no audio files at all. This pins the count those
   * sentences state, so the next entry has to update them to pass.
   */
  it('has 42 recordings among 45 entries', () => {
    const all = Object.values(CATALOGUE)
    expect(all.length).toBe(45)
    expect(all.filter((d) => d.source.kind === 'file').length).toBe(42)
  })

  it('prices a crash at the plating’s own threshold', () => {
    expect(CRASH_FORCE).toBe(TUNING.collision.hardImpactSpeed * 0.5)
  })
})

describe('the menu cue line', () => {
  const heard: SoundId[] = []
  const sink = (id: SoundId): void => { heard.push(id) }
  afterEach(() => { clearCueSink(sink) })

  it('reaches whatever AudioSystem registered, and is silent with none', () => {
    heard.length = 0
    cue('uiSelect')                        // nobody listening: a no-op
    setCueSink(sink)
    cue('uiMove')
    cue('uiStart')
    clearCueSink(sink)
    cue('uiBack')
    expect(heard).toEqual(['uiMove', 'uiStart'])
  })

  it('does not let a stale system unplug a newer one', () => {
    heard.length = 0
    const older = (): void => { heard.push('uiBack') }
    setCueSink(older)
    setCueSink(sink)
    clearCueSink(older)                    // the old one's dispose
    cue('uiSelect')
    expect(heard).toEqual(['uiSelect'])
  })
})
