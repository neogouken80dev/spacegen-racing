import type { ItemId } from '../sim/types'

export interface ItemDef {
  id: ItemId
  name: string
  /** Charges granted when picked up. */
  charges: number
  color: number
  icon: string
  description: string
}

export const ITEMS: Record<ItemId, ItemDef> = {
  laserGatling: { id: 'laserGatling', name: 'Pulse Gatling', charges: 1, color: 0x35ff9e, icon: 'gatling', description: 'Three seconds of auto-fire. Hold a racer in your sights to break them.' },
  voidMine:      { id: 'voidMine',      name: 'Void Mine',      charges: 1, color: 0xb44dff, icon: 'mine',    description: 'Drops behind you. Hold back to lob it further. Arms in 0.5s.' },
  nitro:         { id: 'nitro',         name: 'Nitro',          charges: 1, color: 0x2fe36b, icon: 'nitro',   description: 'Instant boost. Clears light debuffs.' },
  nitroTriple:   { id: 'nitroTriple',   name: 'Nitro x3',       charges: 3, color: 0x2fe36b, icon: 'nitro3',  description: 'Three boosts, held as orbiting pips.' },
  railMissile:   { id: 'railMissile',   name: 'Rail Missile',   charges: 1, color: 0xffd23f, icon: 'rail',    description: 'Fires dead straight. Rewards aim.' },
  seekerMissile: { id: 'seekerMissile', name: 'Seeker Missile', charges: 1, color: 0xff8b2f, icon: 'seeker',  description: 'Homes on the racer ahead. Breakable lock.' },
  alphaMissile:  { id: 'alphaMissile',  name: 'Alpha Missile',  charges: 1, color: 0xff2f5e, icon: 'alpha',   description: 'Hunts 1st place along the spline.' },
  empBomb:       { id: 'empBomb',       name: 'EMP Bomb',       charges: 1, color: 0x5ad2ff, icon: 'emp',     description: 'Locks out every racer but you.' },
  overdriveCore: { id: 'overdriveCore', name: 'Overdrive Core', charges: 1, color: 0xfff27a, icon: 'core',    description: 'Speed, invulnerability, contact damage.' },
  gravityWell:   { id: 'gravityWell',   name: 'Gravity Well',   charges: 1, color: 0x8f6bff, icon: 'well',    description: 'Deployed field. Slows and absorbs one missile.' },
}

/** Item behaviour parameters. Every number the sim reads lives here. */
export const ITEM_PARAMS = {
  // voidMine: BOTH distances are rearward -- see the note in race.ts. dropBack
  // is the default drop just behind the car; lobDistance is the longer throw
  // on the backward modifier, landing it where a chaser is about to be.
  voidMine:      { triggerRadius: 3.5, spinTime: 1.6, speedLoss: 0.60, life: 20, armDelay: 0.5, lobDistance: 20, dropBack: 6 },
  nitro:         { mag: 0.45, duration: 1.6 },
  nitroTriple:   { mag: 0.45, duration: 1.6 },
  railMissile:   { speed: 90, spinTime: 1.2, life: 4.0, radius: 2.6 },
  seekerMissile: { speed: 65, turnRate: 120 * (Math.PI / 180), spinTime: 1.4, life: 6.0, radius: 2.8, acquireRange: 200 },
  alphaMissile:  { speed: 110, spinTime: 2.0, life: 14.0, radius: 4.0, fullStop: true },
  empBomb:       { stunTime: 1.1, stunTimeBoosting: 0.6 },
  overdriveCore: { mag: 0.50, duration: 6.0, contactSpin: 1.6 },
  gravityWell:   { radius: 8.0, life: 12, slowMag: 0.45, slowTime: 2.0, massMult: 1.4 },
  laserGatling: {
    /** Seconds of continuous auto-fire once activated. */
    fireTime: 3.0,
    /** Shots per second. */
    fireRate: 14,
    range: 130,
    /** Half-angle of the hit cone, radians. Tight enough that aim matters. */
    cone: 0.115,
    /** Speed removed per hit, as a fraction of current speed. */
    chip: 0.030,
    /** Sideways shove per hit, m/s. */
    nudge: 1.5,
    /** Accumulated beam seconds on one target before it spins out. */
    breakAt: 0.80,
    spinTime: 1.0,
    /** Accumulated beam bleeds off this fast when fire stops. */
    decay: 1.30,
  },
} as const

export const ITEM_ORDER: ItemId[] = [
  'voidMine', 'nitro', 'railMissile', 'gravityWell', 'laserGatling',
  'seekerMissile', 'nitroTriple', 'empBomb', 'alphaMissile', 'overdriveCore',
]

/**
 * Distribution weights by finishing position, 1st..8th.
 * Rows follow ITEM_ORDER. Every column sums to 100.
 *
 * Balance pass 2026-09: the Alpha Missile row was thinned in columns 5-8,
 * [4,8,14,18] -> [4,7,12,15]. Once the chassis pass closed the pace gap the
 * field bunched, 3.4 Alphas were fired per race, 77% connected and 87% of
 * those landed on the racer actually in P1 -- the leader was hit about 2.3
 * times a race and lead retention fell to 41.5%, under the 45% floor. Cutting
 * the row to [2,5,9,12] overcorrected to 57.8%; [4,7,12,15] sits mid-band. The
 * freed weight went to the Seeker Missile, which hits whoever is directly
 * ahead rather than always decapitating P1.
 */
export const ITEM_DISTRIBUTION: Record<ItemId, number[]> = {
  // ANTI-PROCESSION PASS. The leader used to draw nitro 29% of the time, so a
  // clean lead compounded: the leader at the final-lap marker won 58-59% of
  // races against a 45-55% target. P1 and P2 now trade that PACE for DEFENCE
  // (mine, gravity well) -- the leader can still protect a lead, but can no
  // longer extend one out of an item box -- and the back of the field gets a
  // little more of what actually closes a gap. Every column still sums to 100
  // and P1 still cannot draw a leader-killer; see tests/sim.test.ts.
  voidMine:      [46, 34, 23, 15,  9,  5,  3,  2],
  nitro:         [ 6, 12, 15, 14, 11,  8,  4,  2],
  railMissile:   [20, 21, 20, 18, 14, 11,  6,  4],
  gravityWell:   [22, 18, 16, 14, 13, 10,  6,  4],
  laserGatling:  [ 6,  9, 12, 12, 12, 10,  7,  5],
  seekerMissile: [ 0,  6, 10, 15, 18, 17, 13, 10],
  nitroTriple:   [ 0,  0,  4, 12, 14, 17, 21, 23],
  empBomb:       [ 0,  0,  0,  0,  5, 10, 14, 16],
  alphaMissile:  [ 0,  0,  0,  0,  4,  8, 15, 19],
  overdriveCore: [ 0,  0,  0,  0,  0,  4, 11, 15],
}

/** Weights for a given 1-based position, clamped to the table width. */
export function itemWeightsForPosition(position: number): number[] {
  const col = Math.max(0, Math.min(7, position - 1))
  return ITEM_ORDER.map((id) => ITEM_DISTRIBUTION[id][col])
}
