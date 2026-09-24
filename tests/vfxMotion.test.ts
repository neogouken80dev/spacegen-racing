import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ParticlePool, K_GROUND, K_SPARK } from '../src/render/particles'
import { createVfx } from '../src/render/vfx'
import { QUALITY_PRESETS } from '../src/render/api'
import { Track } from '../src/sim/track'
import { Race } from '../src/sim/race'
import type { SimConfig } from '../src/sim/types'
import { CHASSIS } from '../src/content/chassis'
import { PILOTS } from '../src/content/pilots'
import { TEST_PLAIN } from './fixtures/testTrack'

/**
 * WHERE A PARTICLE IS BORN, AND WHAT IT IS BORN MOVING WITH.
 *
 * Everything here is read straight off the pool's instance buffers, which is
 * the whole of a particle's state -- the shader integrates the rest from the
 * spawn position, velocity and birth stamp. So "is the effect on the car" and
 * "did the player's drift survive the pack" are measurable without a GPU.
 */

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

const spark = (p: ParticlePool, x: number): void =>
  p.spawn(x, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0.1, 0, 0, 0, K_SPARK)

describe('the particle pool', () => {
  it("fences the reserved lane off from everybody else's pile-up", () => {
    // 100 slots, 35% reserved: lane 1 is slots [65, 100).
    const pool = new ParticlePool(100, () => 0.5, 0.35)
    pool.beginFrame(1, 0, 0, 0)
    pool.lane = 1
    for (let i = 0; i < 10; i++) spark(pool, i)
    // Twenty frames of the shared lane writing its whole budget -- 960 writes
    // into 65 slots, wrapping it fifteen times. beginFrame puts the lane back
    // to 0, so none of this is aimed at lane 1 even though nothing here says so.
    for (let f = 0; f < 20; f++) {
      pool.beginFrame(1 + (f + 1) / 60, 0, 0, 0)
      for (let i = 0; i < pool.frameBudget; i++) spark(pool, 1000 + i)
    }
    const mine = Array.from({ length: 10 }, (_, i) => pool.aPos[(65 + i) * 3])
    expect(mine).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('is one ring, exactly as before, when nothing is reserved', () => {
    const pool = new ParticlePool(100, () => 0.5)
    pool.beginFrame(1, 0, 0, 0)
    pool.lane = 1
    spark(pool, 7)
    expect(pool.lastSlot).toBe(0)
    expect(pool.aPos[0]).toBe(7)
  })

  it('uploads exactly the slots each lane wrote', () => {
    const pool = new ParticlePool(100, () => 0.5, 0.35)
    pool.beginFrame(1, 0, 0, 0)
    for (let i = 0; i < 3; i++) spark(pool, i)
    pool.lane = 1
    for (let i = 0; i < 2; i++) spark(pool, i)
    pool.flush()
    const attr = pool.geometry.getAttribute('aPos') as THREE.InstancedBufferAttribute
    expect(attr.updateRanges).toEqual([{ start: 0, count: 9 }, { start: 65 * 3, count: 6 }])
    // And the probes' view of the same frame: five written, two of them the
    // reserved lane's (tools/probe-driftfx.mjs reads the second).
    expect(pool.spawnedThisFrame).toBe(5)
    expect(pool.spawnedThisFrameReserved).toBe(2)
  })

  it('adds a carried velocity to the one asked for, and never lets it leak into the next frame', () => {
    const pool = new ParticlePool(64, () => 0.5)
    pool.beginFrame(2, 0, 0, 0)
    pool.inheritX = 30
    pool.inheritZ = -4
    pool.spawn(0, 0, 0, 1, 2, 3, 1, 1, 1, 1, 0.1, 0, 0, 0, K_SPARK)
    const a = pool.lastSlot
    expect(Array.from(pool.aVel.subarray(a * 3, a * 3 + 3))).toEqual([31, 2, -1])

    pool.delay = 0.5
    pool.beginFrame(2.25, 0, 0, 0)
    pool.spawn(0, 0, 0, 1, 2, 3, 1, 1, 1, 1, 0.1, 0, 0, 0, K_SPARK)
    const b = pool.lastSlot
    expect(Array.from(pool.aVel.subarray(b * 3, b * 3 + 3))).toEqual([1, 2, 3])
    // Born now: the delay did not survive the frame boundary either.
    expect(pool.aMisc[b * 4]).toBe(2.25)
  })
})

// ---------------------------------------------------------------------------
// The VFX system on a moving car
// ---------------------------------------------------------------------------

const cfg: SimConfig = {
  seed: 20260924,
  totalLaps: 3,
  racerCount: 1,
  trackId: TEST_PLAIN.id,
  chassisIds: [CHASSIS[0].id],
  pilotIds: [PILOTS[0].id],
  localRacerIndex: -1,
  aiSkill: [2],
}

/** 45 m/s down world +Z on the flat, with the chase camera where it rides. */
const SPEED = 45

function rig() {
  const scene = new THREE.Scene()
  const vfx = createVfx(scene, QUALITY_PRESETS.high)
  const race = new Race(new Track(TEST_PLAIN), cfg)
  while (race.state.phase === 'countdown') race.step()
  const r = race.state.racers[0]
  r.yaw = 0
  r.fwd = { x: 0, y: 0, z: 1 }
  r.up = { x: 0, y: 1, z: 0 }
  r.vel = { x: 0, y: 0, z: SPEED }
  r.grounded = true
  r.altitude = 0.55
  r.driftSide = 0
  r.driftTier = -1
  r.events = []

  const mesh = vfx.group.children.find(
    (c) => (c as THREE.Mesh).geometry?.getAttribute('aAxis') !== undefined,
  ) as THREE.Mesh
  const geo = mesh.geometry as THREE.InstancedBufferGeometry
  const pos = geo.getAttribute('aPos').array as Float32Array
  const misc = geo.getAttribute('aMisc').array as Float32Array
  const misc2 = geo.getAttribute('aMisc2').array as Float32Array

  /** One sim step's worth of VFX. Returns the slots it wrote. */
  const step = (): number[] => {
    const born = misc.slice()
    const at = pos.slice()
    race.state.frame++
    const cam = { x: r.pos.x, y: r.pos.y + 5.8, z: r.pos.z - 14 }
    vfx.update(1 / 60, race.state, cam, r.id)
    const out: number[] = []
    for (let i = 0; i < misc.length / 4; i++) {
      if (misc[i * 4] !== born[i * 4] || pos[i * 3] !== at[i * 3] || pos[i * 3 + 2] !== at[i * 3 + 2]) out.push(i)
    }
    return out
  }
  return { vfx, r, pos, misc, misc2, step }
}

describe('effects bolted to a moving car', () => {
  it('are born where the car is DRAWN, not where the sim has it', () => {
    const { vfx, r, pos, step } = rig()
    step()
    // The render view trails the sim by up to one step (a metre at 60 m/s);
    // five metres here, so the two answers cannot be confused.
    const view = { id: r.id, pos: { x: r.pos.x, y: r.pos.y, z: r.pos.z - 5 }, yaw: r.yaw, fwd: r.fwd, up: r.up }
    vfx.drawn = [{ view }]
    r.events = [{ t: 'driftStart' }]
    const w = step()
    expect(w.length).toBeGreaterThan(20)
    let mean = 0
    for (const i of w) mean += pos[i * 3 + 2]
    mean /= w.length
    // The entry kick and snap are thrown off the tail and the flank: all of
    // it inside a car length of the drawn car, none of it on the live one.
    expect(Math.abs(mean - view.pos.z)).toBeLessThan(2.5)
    expect(Math.abs(mean - r.pos.z)).toBeGreaterThan(2.5)
  })

  it("fire a queued beat where the car IS when it lands, and the entry kick's echo is a ring", () => {
    const { r, pos, misc, misc2, step } = rig()
    step()
    r.events = [{ t: 'driftStart' }]
    step()
    r.events = []
    const z0 = r.pos.z
    // The kick's second front: a ground ring born at 0.9 m with the kick's
    // 0.34 s life. Nothing else on a car that is not drifting makes one.
    let echo: number[] = []
    let carZ = NaN
    for (let k = 1; k <= 10; k++) {
      r.pos.z += SPEED / 60
      const w = step().filter((i) => misc2[i * 4 + 2] === K_GROUND
        && Math.abs(misc[i * 4 + 1] - 0.34) < 1e-4 && Math.abs(misc[i * 4 + 2] - 0.9) < 1e-4)
      if (w.length > 0) { echo = echo.concat(w); carZ = r.pos.z }
    }
    // Exactly one: it used to be queued as the drift crack's echo with no
    // direction, which drew a row of sparks along world X and no ring at all.
    expect(echo.length).toBe(1)
    // 85 ms at 45 m/s is four metres; queued at rest, it landed that far
    // behind the car it belonged to.
    expect(carZ - z0).toBeGreaterThan(3.5)
    expect(Math.abs(pos[echo[0] * 3 + 2] - carZ)).toBeLessThan(0.5)
  })
})

// ---------------------------------------------------------------------------
// Item colours
// ---------------------------------------------------------------------------

describe('item colours', () => {
  it('are presentation only: nothing under src/sim reads ITEMS', () => {
    // So re-hueing an item (the rail and the mine both moved off the drift
    // tiers' colours) can never move the determinism hash.
    const dir = resolve(__dirname, '../src/sim')
    const offenders: string[] = []
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts')) continue
      const src = readFileSync(join(dir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
      if (/\bITEMS\b/.test(src)) offenders.push(f)
    }
    expect(offenders).toEqual([])
  })
})
