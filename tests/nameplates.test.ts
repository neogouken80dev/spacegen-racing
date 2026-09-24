/**
 * NAME PLATES — the things a screenshot cannot prove.
 *
 * A photograph of a race shows that plates are drawn. It cannot show that the
 * player's own car is excluded for two independent reasons, that an anchor
 * follows a car's OWN up-vector through a barrel roll rather than the world's,
 * that the plate that survived a bunch is the one the rule says should have,
 * or that a missing portrait degrades to a name instead of to a hole. Those
 * are the four things that will break quietly, so those are the four things
 * this file is mostly about.
 *
 * It runs without a graphics driver and without a DOM. src/render/nameplates.ts
 * is written so that everything above the texture -- the roster resolution, the
 * anchors, the projection, the overlap contest, the budget and the crossfades
 * -- runs identically whether or not a canvas could be created; `bake()` is the
 * one function that checks for a document and returns early. So the system
 * under test here is the shipping one, with a null atlas.
 */
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  createNameplates, plateRoster, plateBudget, plateHeightPx,
  MAX_PLATES, NAMEPLATE_TUNING as N,
  type NameplateRoster, type NameplateSystem,
} from '../src/render/nameplates'
import { QUALITY_PRESETS } from '../src/render/api'
import { AVATARS, placeholderPortrait, AVATAR_BY_ID, hasArt, portraitFor } from '../src/content/avatars'
import { Race } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { RUSTFALL } from '../src/content/tracks/rustfall'
import { CHASSIS, CHASSIS_BY_ID } from '../src/content/chassis'
import { resetAI } from '../src/sim/ai'
import type { MultiplayerSlot } from '../src/net/types'
import type { RacerState, SimConfig } from '../src/sim/types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HUMANS = ['p-ada', 'p-bo', 'p-cy', 'p-dee']

/**
 * A plausible eight-car multiplayer grid: four people and four bots, which is
 * the shape of most lobbies that do not fill.
 *
 * Built from the real avatar roster rather than from invented ids, so a change
 * to the catalogue that renamed a starter would surface here.
 */
function grid(): MultiplayerSlot[] {
  return Array.from({ length: MAX_PLATES }, (_, i): MultiplayerSlot => {
    const human = i < HUMANS.length
    return {
      slot: i,
      playerId: human ? HUMANS[i] : null,
      name: human ? ['Ada', 'Bo', 'Cygnet', 'Deep Field'][i] : `DRONE-${i}`,
      avatarId: human ? AVATARS[i].id : null,
      chassisId: CHASSIS[i % CHASSIS.length].id,
      pilotId: '',
      isHost: i === 0,
      aiSkill: human ? null : 3,
    }
  })
}

const cfg = (): SimConfig => ({
  seed: 7, totalLaps: 3, racerCount: MAX_PLATES, trackId: 'rustfall',
  chassisIds: Array.from({ length: MAX_PLATES }, (_, i) => CHASSIS[i % CHASSIS.length].id),
  pilotIds: Array.from({ length: MAX_PLATES }, () => ''),
  localRacerIndex: 0,
  aiSkill: Array.from({ length: MAX_PLATES }, () => 3),
})

/** Eight real RacerStates from the real sim. Cheaper than inventing the
 *  thirty-odd fields by hand, and it cannot fall out of date. */
function field(): RacerState[] {
  resetAI()
  const race = new Race(new Track(RUSTFALL), cfg())
  return race.state.racers
}

/**
 * A camera at the origin looking down -Z, and a world laid out in front of it,
 * so every expectation below can be written in plain metres.
 */
function camera(w = 1440, h = 810): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(62, w / h, 0.35, 4000)
  c.position.set(0, 0, 0)
  c.lookAt(0, 0, -1)
  c.updateMatrixWorld()
  return c
}

/** Put a racer at a world point with a given up-vector. */
function place(r: RacerState, x: number, y: number, z: number, up = [0, 1, 0]): void {
  r.pos.x = x; r.pos.y = y; r.pos.z = z
  r.up.x = up[0]; r.up.y = up[1]; r.up.z = up[2]
  r.respawnTime = 0
}

/**
 * The whole field on screen at once, in a diagonal that CANNOT overlap.
 *
 * Seven plates side by side do not fit: a plate is about 165 CSS pixels wide
 * at desktop size, and seven of those is 1,155 across a 1,440 viewport before
 * any perspective. Stepping the cars in height as well as across puts more
 * than a plate's height between each pair, so the overlap rule has nothing to
 * do and a test about draw calls is about draw calls.
 */
function spread(racers: RacerState[], skip: number): void {
  for (let i = 0; i < racers.length; i++) {
    if (i === skip) continue
    place(racers[i], (i - 4) * 7, (i - 4) * 5, -60)
  }
}

/** The roof clearance this racer's chassis gets. */
const lift = (r: RacerState): number =>
  CHASSIS_BY_ID[r.chassisId].halfExtents.y + N.ROOF_CLEARANCE

/**
 * Place a racer so its ANCHOR sits exactly on the camera axis (world y = 0).
 *
 * Needed by every overlap test, and it is not a fudge. A plate is a constant
 * size on screen but its anchor is not: two cars level with each other on the
 * road and forty metres apart in depth project their anchors to screen heights
 * that differ by more than a plate, so "same lateral position" is NOT "same
 * place on screen". Dropping both anchors onto the view axis is the only way
 * to make an overlap test about the overlap rule rather than about perspective.
 */
function onAxis(r: RacerState, x: number, z: number): void {
  place(r, x, -lift(r), z)
}

interface Rig {
  sys: NameplateSystem
  racers: RacerState[]
  cam: THREE.PerspectiveCamera
  /** Run one frame at `dt`. */
  step(dt?: number, w?: number, h?: number, enabled?: boolean): void
  /** Settle the crossfades: enough frames that alpha is at its target. */
  settle(w?: number, h?: number): void
  plate(slot: number): (typeof rig.sys.plates)[number]
}
let rig: Rig

function build(
  roster: NameplateRoster | null,
  tier: 'low' | 'medium' | 'high' = 'high',
): Rig {
  const sys = createNameplates(QUALITY_PRESETS[tier])
  sys.setRoster(roster)
  const racers = field()
  const cam = camera()
  const r: Rig = {
    sys, racers, cam,
    step(dt = 1 / 60, w = 1440, h = 810, enabled = true) {
      sys.update(dt, racers, cam, w, h, enabled)
    },
    settle(w = 1440, h = 810) {
      // Long enough that the crossfade is inside a thousandth of its target:
      // 2.5 s at 60 Hz is twenty-eight half-lives.
      for (let i = 0; i < 150; i++) sys.update(1 / 60, racers, cam, w, h, true)
    },
    plate(slot: number) {
      const p = sys.plates.find((x) => x.slot === slot)
      if (!p) throw new Error(`no plate for slot ${slot}`)
      return p
    },
  }
  rig = r
  return r
}

const roster = (localPlayerId = HUMANS[0]): NameplateRoster =>
  ({ grid: grid(), localPlayerId })

// ---------------------------------------------------------------------------

describe('the roster', () => {
  it('never gives the local player a plate', () => {
    const specs = plateRoster(grid(), HUMANS[0])
    expect(specs).toHaveLength(MAX_PLATES - 1)
    expect(specs.some((s) => s.slot === 0)).toBe(false)
  })

  it('drops the local player wherever they are on the grid, not just slot 0', () => {
    // The obvious bug this guards is an implementation that assumes the reader
    // is always the host in slot 0. `RaceStartPacket` is one broadcast and the
    // reader matches its OWN id against it -- see the note on localPlayerId in
    // src/net/types.ts -- so the local player is at whatever slot they joined.
    for (let i = 0; i < HUMANS.length; i++) {
      const specs = plateRoster(grid(), HUMANS[i])
      expect(specs.map((s) => s.slot)).not.toContain(i)
      expect(specs).toHaveLength(MAX_PLATES - 1)
    }
  })

  it('gives every other human a plate, and every AI one too', () => {
    const specs = plateRoster(grid(), HUMANS[0])
    expect(specs.filter((s) => s.human)).toHaveLength(HUMANS.length - 1)
    expect(specs.filter((s) => !s.human)).toHaveLength(MAX_PLATES - HUMANS.length)
  })

  it('draws no portrait on an AI plate, but still draws the name', () => {
    const specs = plateRoster(grid(), HUMANS[0])
    for (const s of specs.filter((x) => !x.human)) {
      expect(s.portrait).toBeNull()
      expect(s.name.length).toBeGreaterThan(0)
    }
  })

  it('degrades an unknown avatar id to a name, not to a broken image', () => {
    // The two ways this arrives for real: a peer on a newer build wearing an
    // avatar this one has never heard of, and a profile whose stored avatarId
    // survived a roster rename. Both must produce a plate that still says who
    // the player is.
    const g = grid()
    g[1].avatarId = 'avatar-from-the-future'
    const spec = plateRoster(g, HUMANS[0]).find((s) => s.slot === 1)
    expect(spec).toBeDefined()
    expect(spec?.portrait).toBeNull()
    expect(spec?.name).toBe('Bo')
    expect(spec?.human).toBe(true)
  })

  it('takes the portrait from portraitFor at plate size, never from def.src', () => {
    // `src` is the 512px file; a plate draws a 40-texel face, so a plate that
    // read `src` would pull the largest file for the smallest use -- eight
    // portraits a race, on a phone. And for an avatar whose art has not been
    // delivered, `src` is a path that 404s where portraitFor is the stand-in.
    const spec = plateRoster(grid(), HUMANS[0]).find((s) => s.slot === 1)
    const def = AVATAR_BY_ID.get(AVATARS[1].id)
    expect(def).toBeDefined()
    expect(spec?.portrait).toBe(portraitFor(def!, 40))
    expect(spec?.portrait).not.toBe(def!.src)
    if (hasArt(def!.id)) expect(spec?.portrait).toMatch(/-128\.webp$/)
    else expect(spec?.portrait).toBe(placeholderPortrait(def!))
  })

  it('carries the avatar accent so a player is the same colour everywhere', () => {
    const spec = plateRoster(grid(), HUMANS[0]).find((s) => s.slot === 2)
    expect(spec?.accent).toBe(AVATARS[2].accent)
  })

  it('ignores a slot index outside the grid', () => {
    const g = grid()
    g[3] = { ...g[3], slot: 99 }
    expect(plateRoster(g, HUMANS[0]).some((s) => s.slot === 99)).toBe(false)
  })

  it('is inert with no roster installed', () => {
    const r = build(null)
    place(r.racers[1], 0, 0, -30)
    r.step()
    expect(r.sys.stats.roster).toBe(0)
    expect(r.sys.stats.visible).toBe(0)
    expect(r.sys.stats.calls).toBe(0)
    expect(r.sys.stats.tris).toBe(0)
    r.sys.dispose()
  })
})

describe('the local player never gets a plate', () => {
  it('is dropped a second time by the sim flag, even if the roster is wrong', () => {
    /**
     * THE SECOND GUARD, ON ITS OWN.
     *
     * A roster whose `localPlayerId` matches nothing -- a stale profile id, a
     * packet from a lobby the player rejoined under a new id -- sails straight
     * past `plateRoster` and hands every slot a plate, including the one the
     * player is sitting in. That is the single worst failure this feature has:
     * a label nailed over your own roof for a whole race. So the frame path
     * refuses to draw a plate for whichever racer the SIM calls local,
     * whatever the roster says.
     */
    const r = build({ grid: grid(), localPlayerId: 'nobody-by-that-name' })
    expect(r.sys.stats.roster).toBe(MAX_PLATES) // the roster guard did not fire
    // Every car in front of the camera, in a line, well within range.
    for (let i = 0; i < MAX_PLATES; i++) place(r.racers[i], i * 0.4, 0, -40)
    expect(r.racers[0].isLocal).toBe(true)
    r.settle()
    expect(r.plate(0).alpha).toBe(0)
    expect(r.plate(0).rect).toBeNull()
    // ...and it is not that nothing drew at all.
    expect(r.sys.stats.visible).toBeGreaterThan(0)
    r.sys.dispose()
  })
})

describe('the anchor through a loop', () => {
  it('lifts along the racer own up, not world up', () => {
    /**
     * THE `aAxis` BUG, IN ITS NAMEPLATE FORM. See render/particles.ts.
     *
     * Swept through a full barrel roll: at the top of a vertical loop the
     * roof points at the ground, and a plate lifted along world +Y there is
     * two and a half metres UNDER the car, inside the road.
     */
    const r = build(roster())
    const car = r.racers[1]
    const roof = CHASSIS_BY_ID[car.chassisId].halfExtents.y + N.ROOF_CLEARANCE
    for (let deg = 0; deg < 360; deg += 15) {
      const t = (deg * Math.PI) / 180
      // Roll about the car's forward axis: up sweeps the whole circle.
      place(car, 0, 0, -40, [Math.sin(t), Math.cos(t), 0])
      r.step()
      const p = r.plate(1)
      const dx = p.anchor.x - car.pos.x
      const dy = p.anchor.y - car.pos.y
      const dz = p.anchor.z - car.pos.z
      // Parallel to the car's up, and exactly the roof clearance long.
      expect(Math.hypot(dx, dy, dz)).toBeCloseTo(roof, 5)
      expect(dx).toBeCloseTo(car.up.x * roof, 5)
      expect(dy).toBeCloseTo(car.up.y * roof, 5)
      expect(dz).toBeCloseTo(car.up.z * roof, 5)
    }
    r.sys.dispose()
  })

  it('puts the plate BELOW the car in world terms when the car is inverted', () => {
    // The blunt version of the same claim, stated the way it looks on screen:
    // upside down at the top of a loop, the plate is at a lower world Y than
    // the car it belongs to, because that is where the roof is.
    const r = build(roster())
    const car = r.racers[1]
    place(car, 0, 12, -40, [0, -1, 0])
    r.step()
    expect(r.plate(1).anchor.y).toBeLessThan(car.pos.y)
    r.sys.dispose()
  })

  it('tracks the car across a move without lag', () => {
    const r = build(roster())
    const car = r.racers[1]
    place(car, 0, 0, -40)
    r.step()
    place(car, 9, 3, -55)
    r.step()
    expect(r.plate(1).anchor.x).toBeCloseTo(9, 5)
    expect(r.plate(1).anchor.z).toBeCloseTo(-55, 5)
    r.sys.dispose()
  })
})

describe('distance', () => {
  it('holds the plate at a constant size on screen', () => {
    // The whole point of a screen-space quad. Same pixels at 12 m and at 140 m.
    const r = build(roster())
    const car = r.racers[1]
    place(car, 0, 0, -12)
    r.settle()
    const near = r.plate(1).rect
    place(car, 0, 0, -140)
    r.step()
    const far = r.plate(1).rect
    expect(near).not.toBeNull()
    expect(far).not.toBeNull()
    expect(far!.w).toBeCloseTo(near!.w, 4)
    expect(far!.h).toBeCloseTo(near!.h, 4)
  })

  it('fades out between FAR_FADE and FAR_CULL rather than winking out', () => {
    const r = build(roster())
    const car = r.racers[1]
    place(car, 0, 0, -(N.FAR_FADE - 5))
    r.settle()
    expect(r.plate(1).target).toBeCloseTo(N.ALPHA_HUMAN, 5)

    place(car, 0, 0, -(N.FAR_FADE + (N.FAR_CULL - N.FAR_FADE) * 0.5))
    r.step()
    const mid = r.plate(1).target
    expect(mid).toBeGreaterThan(0.2)
    expect(mid).toBeLessThan(0.8)

    place(car, 0, 0, -(N.FAR_CULL + 30))
    r.settle()
    expect(r.plate(1).alpha).toBe(0)
    expect(r.plate(1).rect).toBeNull()
    r.sys.dispose()
  })

  it('draws nothing for a car behind the camera', () => {
    // The trap: `project()` divides by a negative w behind the lens, so a car
    // directly astern lands in the middle of the frame. If this ever passes
    // by accident, put a car at +z and watch the plate appear over the road
    // ahead of you.
    const r = build(roster())
    for (let i = 1; i < MAX_PLATES; i++) place(r.racers[i], 0, 0, +40)
    r.settle()
    for (let i = 1; i < MAX_PLATES; i++) {
      expect(r.plate(i).rect).toBeNull()
      expect(r.plate(i).alpha).toBe(0)
    }
    expect(r.sys.stats.visible).toBe(0)
    r.sys.dispose()
  })

  it('draws nothing while a car is being respawned', () => {
    const r = build(roster())
    place(r.racers[1], 0, 0, -30)
    r.settle()
    expect(r.plate(1).alpha).toBeGreaterThan(0.5)
    r.racers[1].respawnTime = 1.4
    r.settle()
    expect(r.plate(1).alpha).toBe(0)
    r.sys.dispose()
  })
})

describe('the overlap rule', () => {
  /** Park every rival far away and off to one side so only the named ones
   *  can win the contest. */
  function scatter(r: Rig): void {
    for (let i = 1; i < MAX_PLATES; i++) place(r.racers[i], 900 + i, 0, -900)
  }

  it('keeps the nearer plate and suppresses the one behind it', () => {
    const r = build(roster())
    scatter(r)
    // Two humans, same screen position, different depths.
    onAxis(r.racers[1], 0, -30)
    onAxis(r.racers[2], 0, -70)
    r.settle()
    expect(r.plate(1).suppressed).toBe(false)
    expect(r.plate(1).alpha).toBeGreaterThan(0.5)
    expect(r.plate(2).suppressed).toBe(true)
    expect(r.plate(2).alpha).toBe(0)
    r.sys.dispose()
  })

  it('moves nobody: the surviving plate is still over its own car', () => {
    /**
     * The claim the whole overlap design rests on. A label engine that
     * declutters by nudging would have shifted this plate off its anchor; the
     * rule here never moves one, so the projected anchor is still the centre
     * of the rect.
     */
    const r = build(roster())
    scatter(r)
    onAxis(r.racers[1], 0, -30)
    onAxis(r.racers[2], 0.2, -31)
    onAxis(r.racers[3], -0.2, -32)
    r.settle()
    const shown = r.sys.plates.filter((p) => p.alpha > 0 && p.rect)
    expect(shown.length).toBeGreaterThan(0)
    for (const p of shown) {
      const car = r.racers[p.slot]
      const v = new THREE.Vector3(p.anchor.x, p.anchor.y, p.anchor.z).project(r.cam)
      const sx = (v.x * 0.5 + 0.5) * 1440
      expect(p.rect!.x + p.rect!.w * 0.5).toBeCloseTo(sx, 3)
      // ...and the anchor is still that car's anchor.
      expect(p.anchor.x).toBeCloseTo(car.pos.x + car.up.x * (CHASSIS_BY_ID[car.chassisId].halfExtents.y + N.ROOF_CLEARANCE), 4)
    }
    r.sys.dispose()
  })

  it('lets a human beat a nearer bot, inside the penalty', () => {
    // The bot is 20 m closer, which is less than AI_PRIORITY_PENALTY, so the
    // human's name is the one that survives the bunch.
    const r = build(roster())
    scatter(r)
    onAxis(r.racers[4], 0, -30)  // AI
    onAxis(r.racers[1], 0, -50)  // human
    r.settle()
    expect(r.plate(1).suppressed).toBe(false)
    expect(r.plate(4).suppressed).toBe(true)
    r.sys.dispose()
  })

  it('still lets a bot win when it is nearer by more than the penalty', () => {
    // The penalty is a thumb on the scale, not a rule that bots are never
    // named: the car alongside you gets its name whoever is driving it.
    const r = build(roster())
    scatter(r)
    onAxis(r.racers[4], 0, -20)                            // AI
    onAxis(r.racers[1], 0, -(20 + N.AI_PRIORITY_PENALTY + 30)) // human, far back
    r.settle()
    expect(r.plate(4).suppressed).toBe(false)
    expect(r.plate(1).suppressed).toBe(true)
    r.sys.dispose()
  })

  it('leaves plates alone when they do not actually touch', () => {
    const r = build(roster())
    scatter(r)
    // Well apart horizontally at the same depth: both survive.
    onAxis(r.racers[1], -14, -40)
    onAxis(r.racers[2], 14, -40)
    r.settle()
    expect(r.plate(1).suppressed).toBe(false)
    expect(r.plate(2).suppressed).toBe(false)
    expect(r.plate(1).alpha).toBeGreaterThan(0.5)
    expect(r.plate(2).alpha).toBeGreaterThan(0.5)
    r.sys.dispose()
  })

  it('holds a shown plate through a graze it would not have been granted', () => {
    /**
     * HYSTERESIS, which exists because two cars swapping places swap plate
     * priority at the crossing point, and without it both would strobe.
     * A plate that is already up tolerates SHARE_OUT of cover; one trying to
     * come back needs to be clear to SHARE_IN. An overlap between the two
     * thresholds therefore has two legitimate answers, and which one you get
     * depends on where you came from -- which is exactly the property pinned
     * here.
     *
     * The winner is pinned at 30 m and the challenger at 60 m so the priority
     * order cannot flip as the challenger slides sideways; the only thing
     * changing between the two halves is which state the challenger's plate
     * was in when the frame started.
     */
    const WIN_Z = -30
    const LOSE_Z = -60

    /** Screen-x pixels per metre of world x, at LOSE_Z, measured. */
    function perMetre(r: Rig): number {
      onAxis(r.racers[2], 0, LOSE_Z)
      r.step()
      const a = r.plate(2).rect!.x
      onAxis(r.racers[2], 1, LOSE_Z)
      r.step()
      return Math.abs(r.plate(2).rect!.x - a)
    }

    // --- from SHOWN: the graze is tolerated ---------------------------------
    const r = build(roster())
    scatter(r)
    onAxis(r.racers[1], 0, WIN_Z)
    onAxis(r.racers[2], 0, LOSE_Z)
    const px = perMetre(r)
    // Clear of each other first, so the challenger's plate is up.
    const w = r.plate(2).rect!.w
    const share = (N.SHARE_IN + N.SHARE_OUT) * 0.5
    const grazeM = (w * (1 - share)) / px
    onAxis(r.racers[2], (w * 1.6) / px, LOSE_Z)
    r.settle()
    expect(r.plate(2).alpha).toBeGreaterThan(0.5)
    // ...then slide in to a cover fraction between the two thresholds.
    onAxis(r.racers[2], grazeM, LOSE_Z)
    r.settle()
    expect(r.plate(1).suppressed).toBe(false)
    expect(r.plate(2).suppressed).toBe(false)
    r.sys.dispose()

    // --- from HIDDEN: the identical geometry is refused ---------------------
    const r2 = build(roster())
    scatter(r2)
    onAxis(r2.racers[1], 0, WIN_Z)
    onAxis(r2.racers[2], 0, LOSE_Z)   // dead on top of the winner
    r2.settle()
    expect(r2.plate(2).alpha).toBe(0)
    onAxis(r2.racers[2], grazeM, LOSE_Z)
    r2.settle()
    expect(r2.plate(2).suppressed).toBe(true)
    expect(r2.plate(2).alpha).toBe(0)
    r2.sys.dispose()
  })
})

describe('the clutter budget', () => {
  it('is three on a phone and seven on a desktop', () => {
    expect(plateBudget(412, 915)).toBe(N.BUDGET_NARROW)
    expect(plateBudget(915, 412)).toBe(N.BUDGET_NARROW)
    expect(plateBudget(1440, 810)).toBe(N.BUDGET_WIDE)
    expect(N.BUDGET_WIDE).toBe(MAX_PLATES - 1)
  })

  it('caps how many plates a phone shows in a bunch', () => {
    const r = build(roster())
    // The whole field spread across the road ahead, all in range, all clear
    // of each other on a desktop.
    spread(r.racers, 0)
    r.settle(1440, 810)
    const wide = r.sys.plates.filter((p) => p.alpha > 0).length
    expect(wide).toBeGreaterThan(N.BUDGET_NARROW)

    r.settle(412, 915)
    const narrow = r.sys.plates.filter((p) => p.alpha > 0).length
    expect(narrow).toBeLessThanOrEqual(N.BUDGET_NARROW)
    expect(r.sys.stats.budget).toBe(N.BUDGET_NARROW)
    r.sys.dispose()
  })

  it('spends the phone budget on the nearest cars', () => {
    /**
     * WHAT THE CAP IS SPENT ON, stated as the two things that are true
     * whatever the geometry: the nearest car on screen is ALWAYS named, and
     * the total never exceeds the cap.
     *
     * Deliberately not "these three exact slots". The budget is applied inside
     * the same walk as the overlap rule, so which plates a given arrangement
     * keeps depends on both, and a test that pinned the exact set would be
     * pinning an arrangement rather than a rule.
     */
    const r = build(roster())
    spread(r.racers, 0)
    r.settle(412, 915)

    const onScreen = r.sys.plates.filter((p) => p.rect !== null)
    expect(onScreen.length).toBeGreaterThan(N.BUDGET_NARROW)
    const key = (p: (typeof onScreen)[number]) =>
      p.dist + (p.human ? 0 : N.AI_PRIORITY_PENALTY)
    const nearest = [...onScreen].sort((a, b) => key(a) - key(b))[0]

    const up = r.sys.plates.filter((p) => p.alpha > 0)
    expect(up.length).toBeLessThanOrEqual(N.BUDGET_NARROW)
    expect(up.map((p) => p.slot)).toContain(nearest.slot)
    r.sys.dispose()
  })
})

describe('size', () => {
  it('clamps the plate height at both ends', () => {
    expect(plateHeightPx(412, 915)).toBe(19)
    expect(plateHeightPx(915, 412)).toBe(19)
    expect(plateHeightPx(3840, 2160)).toBe(26)
    // Between the clamps it tracks the SHORT edge, so a wide desktop and a
    // tall one get the same plate.
    expect(plateHeightPx(1440, 810)).toBeCloseTo(plateHeightPx(810, 1440), 6)
    expect(plateHeightPx(1440, 810)).toBeGreaterThan(19)
    expect(plateHeightPx(1440, 810)).toBeLessThan(26)
  })

  it('never goes below the size at which type stops being type', () => {
    for (const [w, h] of [[320, 480], [240, 240], [1, 1]] as const) {
      expect(plateHeightPx(w, h)).toBeGreaterThanOrEqual(19)
    }
  })
})

describe('the crossfade', () => {
  it('ramps in rather than popping', () => {
    const r = build(roster())
    place(r.racers[1], 0, 0, -40)
    r.step(1 / 120)
    const a1 = r.plate(1).alpha
    expect(a1).toBeGreaterThan(0)
    expect(a1).toBeLessThan(1)
    r.settle()
    expect(r.plate(1).alpha).toBeCloseTo(N.ALPHA_HUMAN, 3)
    r.sys.dispose()
  })

  it('is removed entirely under reduced motion', () => {
    const r = build(roster())
    r.sys.reduceMotion = true
    place(r.racers[1], 0, 0, -40)
    r.step(1 / 120)
    expect(r.plate(1).alpha).toBe(N.ALPHA_HUMAN)
    // ...and off again on the same frame it leaves.
    place(r.racers[1], 0, 0, +40)
    r.step(1 / 120)
    expect(r.plate(1).alpha).toBe(0)
    r.sys.dispose()
  })

  it('draws bots quieter than people', () => {
    const r = build(roster())
    place(r.racers[1], -20, 0, -45)   // human
    place(r.racers[5], 20, 0, -45)    // AI
    r.settle()
    expect(r.plate(1).alpha).toBeCloseTo(N.ALPHA_HUMAN, 3)
    expect(r.plate(5).alpha).toBeCloseTo(N.ALPHA_AI, 3)
    expect(N.ALPHA_AI).toBeLessThan(N.ALPHA_HUMAN)
    r.sys.dispose()
  })
})

describe('cost', () => {
  it('costs nothing at all when no plate is on screen', () => {
    const r = build(roster())
    for (let i = 1; i < MAX_PLATES; i++) place(r.racers[i], 0, 0, +400)
    r.settle()
    expect(r.sys.stats.visible).toBe(0)
    expect(r.sys.stats.calls).toBe(0)
    expect(r.sys.stats.tris).toBe(0)
    expect(r.sys.group.children.every((c) => !c.visible)).toBe(true)
    r.sys.dispose()
  })

  it('draws the whole field in two passes on high, one on low', () => {
    /**
     * THE COST CLAIM, IN THE HALF OF IT A HEADLESS RUN CAN CHECK.
     *
     * Passes times plates times two triangles is the whole arithmetic: seven
     * plates on high is 2 calls and 28 triangles, and the entire field is one
     * instanced draw per pass however many cars are in it. The other half of
     * the claim -- that the renderer agrees -- needs a GL context and is
     * measured by tools/probe-nameplates.mjs off renderer.info.
     */
    const hi = build(roster(), 'high')
    spread(hi.racers, 0)
    hi.settle()
    expect(hi.sys.stats.passes).toBe(2)
    expect(hi.sys.stats.visible).toBe(MAX_PLATES - 1)
    hi.sys.dispose()

    const lo = build(roster(), 'low')
    spread(lo.racers, 0)
    lo.settle()
    expect(lo.sys.stats.passes).toBe(1)
    lo.sys.dispose()
  })

  it('has nothing in the scene while it is disabled', () => {
    const r = build(roster())
    spread(r.racers, 0)
    r.settle()
    expect(r.sys.stats.visible).toBeGreaterThan(0)
    for (let i = 0; i < 150; i++) r.step(1 / 60, 1440, 810, false)
    expect(r.sys.stats.visible).toBe(0)
    expect(r.sys.stats.calls).toBe(0)
    expect(r.sys.group.children.every((c) => !c.visible)).toBe(true)
    r.sys.dispose()
  })

  it('survives a world rebuild with the roster intact', () => {
    // What an adaptive quality step-down does mid-race: the system is thrown
    // away and a new one is built. The roster has to be re-installable.
    const rs = roster()
    const a = createNameplates(QUALITY_PRESETS.high)
    a.setRoster(rs)
    expect(a.stats.roster).toBe(MAX_PLATES - 1)
    a.dispose()
    const b = createNameplates(QUALITY_PRESETS.low)
    b.setRoster(rs)
    expect(b.stats.roster).toBe(MAX_PLATES - 1)
    b.dispose()
  })

  it('clears out when the roster is taken away', () => {
    const r = build(roster())
    place(r.racers[1], 0, 0, -40)
    r.settle()
    expect(r.sys.stats.visible).toBeGreaterThan(0)
    r.sys.setRoster(null)
    r.step()
    expect(r.sys.stats.roster).toBe(0)
    expect(r.sys.plates).toHaveLength(0)
    expect(r.sys.stats.calls).toBe(0)
    r.sys.dispose()
  })
})
