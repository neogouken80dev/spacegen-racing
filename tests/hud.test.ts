/**
 * THE HUD'S RULES, WHERE A SCREENSHOT CANNOT SEE THEM.
 *
 * A photograph of the wrong-way plate proves it can be drawn. It says nothing
 * about the two failures a wrong-way warning actually has: shouting at a car
 * that is merely facing backwards for a moment (a spin, a wall bounce, a
 * reverse), and strobing at a car parked on the threshold. Both are rules
 * about time and angle, and both are pinned here without a DOM.
 *
 * The stylesheet checks are the same kind of thing: a 6.5px label and a text
 * shadow an older engine throws away both look fine in a screenshot taken on
 * the machine that wrote them. tools/probe-hudstates.mjs is the browser half.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { RaceState, RacerState } from '../src/sim/types'
import type { Track } from '../src/sim/track'
import { Track as RealTrack } from '../src/sim/track'
import { Race } from '../src/sim/race'
import { TRACKS_BY_ID } from '../src/content/tracks'
import { CHASSIS } from '../src/content/chassis'
import { PILOTS } from '../src/content/pilots'
import { resetAI } from '../src/sim/ai'
import { skillForSlot } from '../src/content/difficulty'
import { WrongWayWatch } from '../src/ui/hud'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A straight road running along world +Z, flat or not. */
function road(hasGravity = false): Track {
  return {
    hasGravity,
    at: () => ({ tangent: { x: 0, y: 0, z: 1 } }),
  } as unknown as Track
}

/** A car on it, heading `deg` off the road's direction, moving `v` m/s along its nose. */
function car(deg: number, v: number): RacerState {
  const a = deg * (Math.PI / 180)
  const fx = Math.sin(a), fz = Math.cos(a)
  return {
    id: 0, yaw: a, splineS: 0,
    fwd: { x: fx, y: 0, z: fz }, up: { x: 0, y: 1, z: 0 },
    vel: { x: fx * v, y: 0, z: fz * v },
    spinTime: 0, stunTime: 0, respawnTime: 0, finished: false,
  } as unknown as RacerState
}

/** Drive the watch for `seconds` of race time at 60 Hz; return seconds it was up. */
function run(w: WrongWayWatch, r: RacerState, track: Track, from: number, seconds: number): number {
  let up = 0
  const n = Math.round(seconds * 60)
  for (let i = 1; i <= n; i++) if (w.update(r, track, from + i / 60, true)) up += 1 / 60
  return up
}

// ---------------------------------------------------------------------------

describe('the wrong-way warning', () => {
  it('comes up after 0.6 s of driving back up the track, and not before', () => {
    const w = new WrongWayWatch()
    const r = car(180, 30)
    expect(run(w, r, road(), 0, 0.55)).toBe(0)
    expect(w.update(r, road(), 0.7, true)).toBe(true)
  })

  it('ignores a car that is merely facing backwards', () => {
    // Spun round but still sliding the right way, as after a wall bounce.
    const bounced = car(170, 0)
    bounced.vel.z = 25
    const w = new WrongWayWatch()
    expect(run(w, bounced, road(), 0, 3)).toBe(0)
    // Nose the right way, reversing: moving backwards, facing forwards.
    const reversing = car(0, -12)
    expect(run(new WrongWayWatch(), reversing, road(), 0, 3)).toBe(0)
    // Facing backwards and crawling: not "at speed".
    expect(run(new WrongWayWatch(), car(180, 4), road(), 0, 3)).toBe(0)
  })

  it('needs the nose more than a right angle round', () => {
    // Velocity held straight back up the road in both, so only the angle differs.
    const at = (deg: number): RacerState => { const r = car(deg, 0); r.vel.z = -30; return r }
    expect(run(new WrongWayWatch(), at(95), road(), 0, 3)).toBe(0)
    expect(run(new WrongWayWatch(), at(105), road(), 0, 3)).toBeGreaterThan(2)
  })

  it('needs real backwards progress, not a slide across the road', () => {
    // 105 degrees at 30 m/s is only 7.8 m/s back up the track: mostly sideways.
    expect(run(new WrongWayWatch(), car(105, 30), road(), 0, 3)).toBe(0)
    expect(run(new WrongWayWatch(), car(105, 45), road(), 0, 3)).toBeGreaterThan(2)
  })

  /**
   * Hysteresis. Once up it clears only when the nose is back inside 80
   * degrees, so a car sitting on the threshold cannot strobe it -- and it does
   * not clear just because the car stopped to turn round.
   */
  it('holds between 80 and 100 degrees, and while stopped, and clears inside 80', () => {
    const w = new WrongWayWatch()
    const r = car(180, 30)
    run(w, r, road(), 0, 1)
    expect(w.on).toBe(true)
    const turning = car(90, 0)
    expect(run(w, turning, road(), 1, 1)).toBeCloseTo(1, 5)
    const back = car(70, 20)
    expect(w.update(back, road(), 2.1, true)).toBe(false)
  })

  it('stands down for a spin, a stun and a respawn, and starts counting again after', () => {
    for (const k of ['spinTime', 'stunTime', 'respawnTime'] as const) {
      const w = new WrongWayWatch()
      const r = car(180, 30)
      run(w, r, road(), 0, 1)
      expect(w.on).toBe(true)
      ;(r as unknown as Record<string, number>)[k] = 0.8
      expect(w.update(r, road(), 1.05, true), k).toBe(false)
      ;(r as unknown as Record<string, number>)[k] = 0
      // The hold starts from zero: a spin does not bank time toward the warning.
      expect(run(w, r, road(), 1.05, 0.5), k).toBe(0)
    }
  })

  it('runs on the race clock, so a paused race cannot tick it up', () => {
    const w = new WrongWayWatch()
    const r = car(180, 30)
    for (let i = 0; i < 600; i++) w.update(r, road(), 5, true)
    expect(w.on).toBe(false)
  })

  it('is off outside a live race', () => {
    const w = new WrongWayWatch()
    let up = 0
    for (let i = 1; i <= 120; i++) if (w.update(car(180, 30), road(), i / 60, false)) up++
    expect(up).toBe(0)
  })

  /**
   * On a flat track the sim never maintains `fwd` -- it is the spawn heading
   * forever, and `yaw` is the truth (vehicle.ts headingError). On a gravity
   * track it is the other way round. The watch has to read the right one.
   */
  it('reads yaw on a flat track and fwd on a gravity track, as the sim does', () => {
    const flat = car(180, 30)
    flat.fwd.x = 0; flat.fwd.z = 1          // stale spawn heading, facing forwards
    expect(run(new WrongWayWatch(), flat, road(false), 0, 1)).toBeGreaterThan(0)
    const walled = car(180, 30)
    walled.yaw = 0                          // a compass bearing that means nothing on a wall
    expect(run(new WrongWayWatch(), walled, road(true), 0, 1)).toBeGreaterThan(0)
  })

  /**
   * THE FALSE-POSITIVE BUDGET IS ZERO. A full AI field on a real circuit spins,
   * gets hit, bounces off barriers and respawns, and never once drives the
   * wrong way -- so over a real stretch of racing the warning must never come
   * up for any of the eight cars.
   */
  it('never fires for a field of AI cars racing a real circuit', () => {
    resetAI()
    const def = TRACKS_BY_ID.rustfall
    const track = new RealTrack(def)
    const n = 8
    const race = new Race(track, {
      seed: 20260904, totalLaps: 3, racerCount: n, trackId: def.id,
      chassisIds: Array.from({ length: n }, (_, i) => CHASSIS[i % CHASSIS.length].id),
      pilotIds: Array.from({ length: n }, (_, i) => PILOTS[i % PILOTS.length].id),
      localRacerIndex: -1,
      aiSkill: Array.from({ length: n }, (_, i) => skillForSlot('normal', i)),
    })
    const watches = Array.from({ length: n }, () => new WrongWayWatch())
    let flagged = 0
    const st: RaceState = race.state
    // 90 s of a 60 Hz sim, watched every step: past the first lap, through the
    // opening pile-up and the first round of items.
    for (let f = 0; f < 60 * 90; f++) {
      race.step()
      for (let i = 0; i < n; i++) {
        if (watches[i].update(st.racers[i], track, st.time, st.phase === 'racing')) flagged++
      }
    }
    expect(flagged, `${flagged} racer-frames flagged as wrong-way in 90 s of AI racing`).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The stylesheet
// ---------------------------------------------------------------------------

const CSS = readFileSync(resolve(__dirname, '../src/ui/styles.css'), 'utf8')
/** Comments blanked without moving any line numbers. */
const CLEAN = CSS.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
const RAW_LINES = CSS.split('\n')
const LINES = CLEAN.split('\n')

describe('the HUD stylesheet', () => {
  /**
   * cheer.ts writes its halo colours from script because color-mix() is newer
   * than the device floor, and a text-shadow list that fails to parse is
   * dropped whole -- taking the dark outline with it. The score block had ten
   * color-mix() calls, five inside that outline's shadow.
   */
  it('uses no color-mix()', () => {
    const bad = LINES.map((l, i) => [i + 1, l] as const).filter(([, l]) => l.includes('color-mix('))
    expect(bad.map(([n, l]) => `${n}: ${l.trim()}`)).toEqual([])
  })

  /**
   * Every rule that sets the score block's hue sets its RGB triple too, and
   * the two name the same colour -- or a rung's glow comes out in the
   * previous rung's hue.
   */
  it('keeps --sc and --sc-rgb in step in every rule that sets them', () => {
    const root: Record<string, string> = {}
    for (const m of CLEAN.matchAll(/(--sg-[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) root[m[1]] ??= m[2]
    const rgb = (hex: string): string => {
      const n = parseInt(hex.slice(1), 16)
      return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`
    }
    const bad: string[] = []
    let rules = 0
    for (const m of CLEAN.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = m[2]
      const sc = /--sc:\s*([^;]+);/.exec(body)
      if (!sc) continue
      rules++
      const trip = /--sc-rgb:\s*([^;]+);/.exec(body)
      const v = sc[1].trim()
      const hex = v.startsWith('#') ? v : root[/var\((--sg-[a-z0-9-]+)\)/.exec(v)?.[1] ?? '']
      if (!trip) { bad.push(`${m[1].trim()}: sets --sc without --sc-rgb`); continue }
      if (!hex || rgb(hex) !== trip[1].trim()) bad.push(`${m[1].trim()}: --sc ${v} vs --sc-rgb ${trip[1].trim()}`)
    }
    expect(rules).toBeGreaterThan(10)
    expect(bad).toEqual([])
  })

  /**
   * THE 11 PX FLOOR. Every font-size in the in-race HUD's sections must be
   * unable to render under 11px. A clamp's first argument is its floor; a
   * size multiplied by the phone's --sgs is halved there, so it has to carry
   * its own max(11px, ...) or have a floor of 22 or more.
   */
  it('puts no in-race HUD text under 11px', () => {
    const at = (s: string): number => RAW_LINES.findIndex((l) => l.includes(s))
    const sections: [string, string][] = [
      ['HUD SHELL', '   FRONT END'],
      ['THE FINISH CEREMONY', 'THE SCORE COUNTER'],
      ['THE SCORE COUNTER', 'RESULTS: THE RUN SCORE'],
      ['THE SCORE READOUT, STYLISED', 'CALLOUTS: MORE POSITIVE FEEDBACK'],
      ['THE ROUND CARD', 'THE CHAMPIONSHIP PODIUM'],
    ]
    const bad: string[] = []
    let seen = 0
    for (const [a, b] of sections) {
      const from = at(a), to = at(b)
      expect(from, a).toBeGreaterThan(0)
      expect(to, b).toBeGreaterThan(from)
      for (let i = from; i < to; i++) {
        const m = /font-size:\s*([^;]+);/.exec(LINES[i])
        if (!m) continue
        const v = m[1].trim()
        if (v.startsWith('var(--sg-fs-')) continue       // the menu scale; every step floors at 11
        seen++
        const floorMax = /^max\(\s*(\d+(?:\.\d+)?)px/.exec(v)
        const px = /(\d+(?:\.\d+)?)px/.exec(v)
        const floor = floorMax ? +floorMax[1] : px ? +px[1] * (v.includes('--sgs') ? 0.5 : 1) : NaN
        if (!(floor >= 11)) bad.push(`${i + 1}: font-size: ${v}`)
      }
    }
    expect(seen).toBeGreaterThan(40)
    expect(bad).toEqual([])
  })
})
