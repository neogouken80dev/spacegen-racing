/**
 * SpaceGen Racing — what counts as INCOMING.
 * ---------------------------------------------------------------------------
 * One rule, two readers: the HUD's threat rim (ui/hud.ts updateWarnings) and
 * the lock-on tone (audio/plan.ts). They read the same function for the same
 * reason audio and the VFX read the same event array -- a rim that lights for
 * a missile the tone is silent about, or a tone for one the rim does not show,
 * is two instruments disagreeing about the one thing a warning exists to say.
 *
 * It lives beside the planner because the tone is the stricter of the two
 * readers: a sound cannot be glanced away from, so the rules for what deserves
 * one were written against it, and the rim inherits them.
 *
 * WHAT THE RIM USED TO DO, MEASURED.
 *
 * It lit for every live projectile within 150 m that the player had not fired,
 * in array order, into four slots. Replayed over eight AI races on four tracks
 * (components-audit/warn-probe.ts), 58% of the slots it filled were Pulse
 * Gatling rounds -- drawn with the ALPHA MISSILE glyph, because the kind switch
 * had no case for `bullet` and the default arm was alpha -- and only 4.9% were
 * a missile actually aimed at the player. A warning that is wrong nineteen
 * times in twenty is not a warning; it is a light the player learns to ignore,
 * which is worse than no light, because the twentieth time is the one it was
 * for. So:
 *
 *   A GATLING ROUND IS NEVER A THREAT HERE. It chips and shoves; it does not
 *   spin you until the fourth round fills the beam meter, and the gatling's own
 *   tracer and hit flash already say it is happening. Thirty rounds a burst
 *   would otherwise own the rim.
 *
 *   A SEEKER OR AN ALPHA IS A THREAT ONLY TO ITS TARGET. Both are homing, both
 *   carry `targetId`, and a seeker hunting the car beside you is that car's
 *   problem. (An Alpha only ever connects with its target -- race.ts skips
 *   everyone else -- so for the Alpha this is not even a judgement call.)
 *
 *   A RAIL IS A THREAT ONLY IF ITS LINE REACHES YOU SOON. It is dumb-fire: it
 *   flies straight and hits whatever is on that line. So it is judged on the
 *   closest approach of its straight path against yours, and counts only when
 *   that approach is inside RAIL_MISS metres and inside RAIL_WINDOW seconds.
 *
 * Everything returns TIME TO IMPACT, because that is what urgency is made of:
 * the rim pulses faster and the tone beeps faster as it falls, and a missile
 * aimed at you but not yet closing reads as a steady, calm warning.
 */
import type { Projectile, RacerState } from '../sim/types'

/** Metres. Past this nothing is announced, homing or not. */
export const THREAT_RANGE = 150

/**
 * A rail's closest approach, metres, inside which it counts.
 *
 * The rail's blast is 2.6 m plus the 1.5 m body allowance race.ts adds -- 4.1 m
 * -- and this is deliberately wider: a near miss the player could not see
 * coming is still worth having been told about, and it costs nothing when the
 * shot is going to miss by a lane.
 */
export const RAIL_MISS = 7

/** Seconds. A rail further out than this along its line is not yet news. */
export const RAIL_WINDOW = 2

/** Time to impact at which urgency is zero (calm) and one (imminent). */
const URGENT_FAR = 3
const URGENT_NEAR = 0.5

/**
 * Seconds until `p` reaches `r`, or -1 if it is not a threat to them at all.
 *
 * `Infinity` is a real answer and means "aimed at you, not closing": a seeker
 * that has not yet turned onto you, or an Alpha still working its way round
 * from behind a car that is outrunning it for the moment. It is shown, calmly.
 */
export function threatTime(p: Projectile, r: RacerState): number {
  if (!p.alive || p.ownerId === r.id || p.kind === 'bullet') return -1
  const dx = p.pos.x - r.pos.x, dy = p.pos.y - r.pos.y, dz = p.pos.z - r.pos.z
  const d2 = dx * dx + dy * dy + dz * dz
  if (d2 > THREAT_RANGE * THREAT_RANGE) return -1
  const vx = p.vel.x - r.vel.x, vy = p.vel.y - r.vel.y, vz = p.vel.z - r.vel.z

  if (p.kind === 'rail') {
    const vv = vx * vx + vy * vy + vz * vz
    if (vv < 1) return -1
    // Closest approach of the two straight lines, in the racer's frame.
    const t = -(dx * vx + dy * vy + dz * vz) / vv
    if (t <= 0 || t > RAIL_WINDOW) return -1
    const mx = dx + vx * t, my = dy + vy * t, mz = dz + vz * t
    if (mx * mx + my * my + mz * mz > RAIL_MISS * RAIL_MISS) return -1
    return t
  }

  // Homing: seeker and alpha.
  if (p.targetId !== r.id) return -1
  const d = Math.sqrt(d2)
  if (d < 1e-3) return 0
  const closing = -(dx * vx + dy * vy + dz * vz) / d
  return closing > 1 ? d / closing : Infinity
}

/** 0 (calm) to 1 (imminent), from a time to impact. */
export function urgency(tti: number): number {
  if (!(tti >= 0) || tti === Infinity) return 0
  if (tti <= URGENT_NEAR) return 1
  if (tti >= URGENT_FAR) return 0
  return (URGENT_FAR - tti) / (URGENT_FAR - URGENT_NEAR)
}

/**
 * The most urgent HOMING threat to `r`, as a time to impact, or -1 for none.
 *
 * Homing only, because this is what the lock-on tone keys off and "lock-on"
 * is a promise: something is hunting you. A rail inside its window is on the
 * rim, but a dumb-fire shot has no lock to announce.
 */
export function lockOnTime(projectiles: readonly Projectile[], r: RacerState): number {
  let best = -1
  for (let i = 0; i < projectiles.length; i++) {
    const p = projectiles[i]
    if (p.kind !== 'seeker' && p.kind !== 'alpha') continue
    const t = threatTime(p, r)
    if (t < 0) continue
    if (best < 0 || t < best) best = t
  }
  return best
}
