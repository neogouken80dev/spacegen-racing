import { describe, it, expect } from 'vitest'
import { Race } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { TRACKS_BY_ID } from '../src/content/tracks'
import { resetAI } from '../src/sim/ai'
import { PILOTS } from '../src/content/pilots'
import { CHASSIS, getDerived, getLocomotion } from '../src/content/chassis'
import { lateralBudget } from '../src/sim/vehicle'
import { TUNING as T } from '../src/content/tuning'
import type { SimConfig, InputFrame } from '../src/sim/types'

const WINDY = ['cryostatic', 'aetherion', 'hollowchoir']
const drive: InputFrame = {
  steer: 0, throttle: 1, brake: 0, drift: false,
  item: false, itemBack: false, lift: false, lookBack: false,
}

/** Run one car for `frames` and return the largest |windPush| it ever felt. */
function peakPush(trackId: string, chassisId: string, frames = 60 * 90): number {
  resetAI()
  const track = new Track(TRACKS_BY_ID[trackId])
  const cfg: SimConfig = {
    seed: 11, totalLaps: 3, racerCount: 1, trackId,
    chassisIds: [chassisId], pilotIds: [PILOTS[0].id], localRacerIndex: 0, aiSkill: [3],
  }
  const race = new Race(track, cfg)
  const r = race.state.racers[0]
  let peak = 0
  for (let f = 0; f < frames && race.state.phase !== 'finished'; f++) {
    race.setInput(0, drive); race.step()
    if (Math.abs(r.windPush) > peak) peak = Math.abs(r.windPush)
  }
  return peak
}

describe('the crosswind can never take the whole friction budget', () => {
  /**
   * THE BUG THIS PINS. The crosswind is applied outside the friction budget,
   * so nothing ever asked whether the tyres could resist it. Authored 26 m/s^2
   * on The Hollow Choir's Ribs, times a 1.63 gust envelope, is 42.4 against a
   * 36.5 lateral budget: above 100% there is no steering input that wins, and
   * a player reported exactly that -- "I try to turn, but it pushes me to the
   * right". Aetherion had the same defect at 130%.
   */
  for (const trackId of WINDY) {
    for (const c of CHASSIS) {
      it(`${trackId} / ${c.id}: the push stays inside the car's own grip`, () => {
        const loco = getLocomotion(c.id)
        const share = Math.min(T.hazard.windGripShare * loco.fieldForceMult, T.hazard.windGripCeiling)
        // Full-grip budget is the LOOSEST bound: gripAccel is this or lower
        // once surface, vacuum, off-track and air are folded in, so a push
        // that clears this bound would clear every real one too.
        const bound = lateralBudget(getDerived(c.id), loco, 1.0) * share
        expect(peakPush(trackId, c.id)).toBeLessThanOrEqual(bound + 1e-6)
      })
    }
  }

  it('fails without the cap: a huge windScale must NOT produce a huge push', () => {
    const before = (T.hazard as any).windScale
    try {
      ;(T.hazard as any).windScale = 40
      const loco = getLocomotion('solaire')
      const share = Math.min(T.hazard.windGripShare * loco.fieldForceMult, T.hazard.windGripCeiling)
      const bound = lateralBudget(getDerived('solaire'), loco, 1.0) * share
      const peak = peakPush('hollowchoir', 'solaire')
      // Uncapped this would be ~1000 m/s^2. This assertion is the whole point:
      // remove the clamp in vehicle.ts and it fails by two orders of magnitude.
      expect(peak).toBeLessThanOrEqual(bound + 1e-6)
      expect(peak).toBeGreaterThan(0)
    } finally { (T.hazard as any).windScale = before }
  })
})

describe('an item row is never a coin flip against the wind', () => {
  /**
   * A pickup is a lateral aiming task with one attempt and no feedback until
   * it has already failed -- a row is a 4.0-4.4m spread of 2.4m boxes, half a
   * car of margin. The bake carves calm air around every row; see the calm
   * pass in sim/track.ts.
   */
  for (const trackId of Object.keys(TRACKS_BY_ID)) {
    it(`${trackId}: calm air over every item row`, () => {
      const track = new Track(TRACKS_BY_ID[trackId])
      for (const row of TRACKS_BY_ID[trackId].itemBoxRows) {
        const s = row.at * track.length
        let worst = 0
        for (let d = -T.hazard.itemCalmBefore; d <= T.hazard.itemCalmAfter; d += 2) {
          worst = Math.max(worst, Math.abs(track.at(s + d).wind))
        }
        expect(worst, `row at ${Math.round(s)}m`).toBeLessThan(0.5)
      }
    })
  }
})
