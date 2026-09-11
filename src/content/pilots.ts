/**
 * SpaceGen Racing — the pilots.
 * ---------------------------------------------------------------------------
 * Pilots used to be pure decoration: a face in the tub and an idle animation.
 * They now carry the game's second build axis. You pick a chassis for how it
 * drives and a pilot for what it does about everything else.
 *
 * SIX ARCHETYPES, AND WHY EACH ONE IS SHAPED THE WAY IT IS
 *
 *   assistance  goes faster. Pure stats, no ability -- so it gets the largest
 *               stat share, which is what makes "boring" a real choice.
 *   agility     turns better. The other pure-stat pilot, for the same reason.
 *   offensive   hits harder and wider. Its value is almost all in the ability.
 *   defensive   eats one impact every 20s.
 *   health      shrugs one weapon every 30s and gets up faster.
 *   flow        recovers fast from walls and hits and keeps its speed.
 *
 * THE BUDGET, WHICH IS THE WHOLE BALANCE ARGUMENT
 *
 * Every pilot is worth `budget` points of chassis stat. Two of them spend it
 * all on stats; four spend most of it on an ability and take a smaller stat
 * bonus. tests/pilots.test.ts asserts the totals match, so a later "just bump
 * it a bit" shows up as a failure rather than as a quietly dominant pilot.
 *
 * THE NUMBERS ARE SMALL ON PURPOSE, and the reason is in tuning.ts: the entire
 * 12-30% win-share band is spanned by TWO stat points, and the chassis history
 * in chassis.ts records that a single grip point was repeatedly "too coarse a
 * step" to balance with. A pilot handing out a whole point would therefore be a
 * bigger lever than most of the chassis differences it sits on top of. So the
 * cap is 1.4 points, split -- enough to feel and to see on a gauge, small
 * enough that chassis identity still decides the race.
 *
 * Ability value is stated, not guessed at. Each `abilityWorth` is the stat
 * budget that ability is being paid out of, and it is the number to revise if
 * the balance gate says a pilot is out of band -- revise it in the open rather
 * than by nudging a stat until the number looks right.
 */

/** Extra chassis stat points, added before the chassis is derived. */
export interface PilotStatBonus {
  topSpeed?: number
  accel?: number
  grip?: number
  mass?: number
  drift?: number
  handling?: number
}

export type PilotArchetype =
  | 'assistance' | 'offensive' | 'defensive' | 'agility' | 'health' | 'flow'

/**
 * What a pilot does beyond its stat points.
 *
 * Every field is a multiplier or a cooldown rather than a flag, so a pilot that
 * does not have an ability simply leaves it undefined and every consumer reads
 * the same default. There is no `if (pilot.id === ...)` anywhere in the sim.
 */
export interface PilotAbility {
  /** Damage this pilot's weapons deal, as a multiplier. */
  weaponMult?: number
  /** Blast radius of this pilot's weapons, as a multiplier. */
  blastMult?: number
  /** Seconds between free impact negations. One hard hit is simply ignored. */
  guardCooldown?: number
  /** Seconds between free weapon negations. One weapon hit is simply ignored. */
  wardCooldown?: number
  /** Multiplier on how long a spin or stun lasts. Below 1 is faster recovery. */
  recoverMult?: number
  /** Multiplier on speed lost to walls and hits. Below 1 keeps more of it. */
  scrubMult?: number
}

export interface PilotDef {
  id: string
  name: string
  archetype: PilotArchetype
  read: string
  /** One line the garage shows under the name: what this pilot DOES. */
  perk: string
  shell: number
  accent: number
  face: number
  /** Face-panel personality drives the idle animation set. */
  temperament: 'eager' | 'jittery' | 'cold' | 'gruff' | 'serene' | 'glitched'
  /** Total stat-point value of this pilot. Equal across the roster. */
  budget: number
  /** The share of `budget` spent on the ability rather than on stats. */
  abilityWorth: number
  stats: PilotStatBonus
  ability: PilotAbility
}

/** Every pilot is worth this many chassis stat points, spent one way or another. */
export const PILOT_BUDGET = 1.4

export const PILOTS: PilotDef[] = [
  {
    id: 'socket', name: 'SOCKET', archetype: 'assistance',
    read: 'Pit technician unit. Talks to the drivetrain, not to you.',
    perk: 'Tuned drivetrain — more top speed and quicker to reach it.',
    shell: 0xf2f3f5, accent: 0xff7a2f, face: 0x36e0ff, temperament: 'eager',
    // No ability at all, so the whole budget is stats. That is the trade being
    // offered: the plainest pilot is the one that makes the car itself best.
    budget: PILOT_BUDGET, abilityWorth: 0,
    stats: { topSpeed: 0.7, accel: 0.7 },
    ability: {},
  },
  {
    id: 'vanguard', name: 'VANGUARD', archetype: 'offensive',
    read: 'Ex-military escort frame. The V is not decoration, it is a rank.',
    perk: 'Heavier ordnance — weapons hit harder and wider.',
    shell: 0x3a4150, accent: 0xffe14d, face: 0xfff27a, temperament: 'jittery',
    budget: PILOT_BUDGET, abilityWorth: 0.9,
    stats: { drift: 0.5 },
    ability: { weaponMult: 1.28, blastMult: 1.35 },
  },
  {
    id: 'aegis', name: 'AEGIS', archetype: 'defensive',
    read: 'Armoured escort unit. Built to be hit and keep going.',
    perk: 'Impact plating — ignores one hard impact every 20s.',
    shell: 0xc8d2dd, accent: 0x24d3ff, face: 0x24d3ff, temperament: 'cold',
    budget: PILOT_BUDGET, abilityWorth: 0.9,
    stats: { mass: 0.5 },
    ability: { guardCooldown: 20 },
  },
  {
    id: 'zephyr', name: 'ZEPHYR', archetype: 'agility',
    read: 'Courier unit. The wings are an affectation and it knows it.',
    perk: 'Light touch — more grip and sharper handling.',
    shell: 0xf5efe2, accent: 0xe8c66a, face: 0x9fe8d4, temperament: 'serene',
    budget: PILOT_BUDGET, abilityWorth: 0,
    stats: { grip: 0.7, handling: 0.7 },
    ability: {},
  },
  {
    id: 'triage', name: 'TRIAGE', archetype: 'health',
    read: 'Field medic chassis. Has seen worse than whatever just happened.',
    perk: 'Field repair — shrugs off one weapon every 30s, and gets up fast.',
    shell: 0x7d6a55, accent: 0xd94f1e, face: 0xffa94d, temperament: 'gruff',
    budget: PILOT_BUDGET, abilityWorth: 0.9,
    stats: { accel: 0.5 },
    ability: { wardCooldown: 30, recoverMult: 0.6 },
  },
  {
    id: 'koan', name: 'KOAN', archetype: 'flow',
    read: 'Meditation unit. Treats a barrier as information.',
    perk: 'Unbroken line — recovers fast and scrubs far less speed.',
    shell: 0x14121a, accent: 0xb44dff, face: 0xff3b6b, temperament: 'glitched',
    budget: PILOT_BUDGET, abilityWorth: 0.9,
    stats: { handling: 0.5 },
    ability: { recoverMult: 0.62, scrubMult: 0.58 },
  },
]

export const PILOTS_BY_ID: Record<string, PilotDef> = Object.fromEntries(
  PILOTS.map((p) => [p.id, p]),
)

/** Total stat points a pilot hands out. Used by the budget test and the UI. */
export function pilotStatTotal(p: PilotDef): number {
  const s = p.stats
  return (s.topSpeed ?? 0) + (s.accel ?? 0) + (s.grip ?? 0)
    + (s.mass ?? 0) + (s.drift ?? 0) + (s.handling ?? 0)
}

/**
 * Resolve a pilot id to a definition, never throwing.
 *
 * A saved selection from before the archetype pass names a pilot that no longer
 * exists ('pip', 'volt', ...). Returning the first pilot rather than undefined
 * means an old localStorage entry degrades to a default instead of taking the
 * garage down on load.
 */
export function pilotOrDefault(pilotId: string): PilotDef {
  return PILOTS_BY_ID[pilotId] ?? PILOTS[0]
}

/** The ability of a pilot id, or an empty one. The sim's single read point. */
export function pilotAbility(pilotId: string): PilotAbility {
  return PILOTS_BY_ID[pilotId]?.ability ?? {}
}
