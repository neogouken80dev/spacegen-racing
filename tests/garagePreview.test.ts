/**
 * The garage's live vehicle preview.
 *
 * Everything here is about a claim that is invisible in a screenshot. A
 * photograph of the garage proves the car is drawn; it cannot prove that the
 * WebGL context went away when the race started, that a reduced-motion player
 * is not being spun round, or that the pilot's idle animation is running rather
 * than the car being a still image. Those are the three things that will break
 * quietly later, so those are the three things that are pinned down here.
 *
 * src/ui/garagePreview.ts is split so this file can exist without a graphics
 * driver: PreviewCore talks to a PreviewStage interface, and the stage used
 * below is a recorder.
 */
import { describe, it, expect } from 'vitest'
import {
  AUTO_RATE, PreviewCore, RESUME_DELAY, RESUME_EASE, REST_YAW, Turntable,
  stationaryRacer, type PreviewStage,
} from '../src/ui/garagePreview'
import { createVehicleVisual } from '../src/render/vehicles'
import { QUALITY_PRESETS, type QualityTier } from '../src/render/api'
import { CHASSIS } from '../src/content/chassis'
import { PILOTS } from '../src/content/pilots'

/** A PreviewStage that draws nothing and remembers everything. */
class FakeStage implements PreviewStage {
  built: { chassisId: string; pilotId: string; tier: QualityTier }[] = []
  frames: { dt: number; yaw: number }[] = []
  resizes = 0
  disposed = 0

  setVehicle(chassisId: string, pilotId: string, tier: QualityTier): void {
    this.built.push({ chassisId, pilotId, tier })
  }

  render(dt: number, yaw: number): void {
    this.frames.push({ dt, yaw })
  }

  resize(): void {
    this.resizes++
  }

  dispose(): void {
    this.disposed++
  }
}

interface Harness {
  core: PreviewCore
  stages: FakeStage[]
  /** The stage currently allocated, or the last one that was. */
  stage(): FakeStage
}

function harness(opts: { reducedMotion?: boolean; fail?: boolean } = {}): Harness {
  const stages: FakeStage[] = []
  const core = new PreviewCore(
    () => {
      if (opts.fail) return null
      const s = new FakeStage()
      stages.push(s)
      return s
    },
    {
      chassisId: 'solaire',
      pilotId: 'socket',
      tier: 'medium',
      reducedMotion: opts.reducedMotion === true,
    },
  )
  return { core, stages, stage: () => stages[stages.length - 1] }
}

/** Run n frames of dt through the core, the way the rAF loop would. */
function run(core: PreviewCore, seconds: number, dt = 1 / 60): void {
  const n = Math.round(seconds / dt)
  for (let i = 0; i < n; i++) core.tick(dt)
}

// ---------------------------------------------------------------------------

describe('the preview holds a GPU context only while the garage is up', () => {
  it('has no context before the garage is ever shown', () => {
    const h = harness()
    expect(h.core.live).toBe(false)
    expect(h.core.running).toBe(false)
    expect(h.stages.length).toBe(0)
  })

  it('builds one on show and destroys it on hide', () => {
    const h = harness()
    h.core.setVisible(true)
    expect(h.core.live).toBe(true)
    expect(h.stages.length).toBe(1)
    expect(h.stage().disposed).toBe(0)

    h.core.setVisible(false)
    // THE POINT OF THE WHOLE LIFECYCLE. A second WebGL context that outlives
    // the garage is a context the race is paying for, and on a phone that is
    // the difference between 60fps and a slideshow.
    expect(h.stage().disposed).toBe(1)
    expect(h.core.live).toBe(false)
    expect(h.core.running).toBe(false)
  })

  it('draws nothing at all once hidden', () => {
    const h = harness()
    h.core.setVisible(true)
    run(h.core, 0.5)
    const drawn = h.stage().frames.length
    expect(drawn).toBeGreaterThan(0)
    h.core.setVisible(false)
    run(h.core, 2)
    expect(h.stage().frames.length).toBe(drawn)
  })

  it('leaks nothing across ten visits', () => {
    const h = harness()
    for (let i = 0; i < 10; i++) {
      h.core.setVisible(true)
      run(h.core, 0.2)
      h.core.setVisible(false)
    }
    expect(h.stages.length).toBe(10)
    // Every one of them was handed back.
    for (const s of h.stages) expect(s.disposed).toBe(1)
    expect(h.core.live).toBe(false)
  })

  it('dispose() takes the context with it', () => {
    const h = harness()
    h.core.setVisible(true)
    h.core.dispose()
    expect(h.stage().disposed).toBe(1)
    expect(h.core.live).toBe(false)
  })

  it('pauses on a hidden tab but keeps the context', () => {
    const h = harness()
    h.core.setVisible(true)
    h.core.setPageHidden(true)
    expect(h.core.running).toBe(false)
    // Not disposed: alt-tabbing away from a menu is not a race starting, and
    // rebuilding the car on every tab switch would cost more than it saves.
    expect(h.core.live).toBe(true)
    const drawn = h.stage().frames.length
    run(h.core, 1)
    expect(h.stage().frames.length).toBe(drawn)
    h.core.setPageHidden(false)
    expect(h.core.running).toBe(true)
    run(h.core, 0.2)
    expect(h.stage().frames.length).toBeGreaterThan(drawn)
  })

  it('gives up quietly and permanently when WebGL cannot be had', () => {
    const h = harness({ fail: true })
    h.core.setVisible(true)
    expect(h.core.failed).toBe(true)
    expect(h.core.live).toBe(false)
    expect(h.core.running).toBe(false)
    // Nothing throws, and it is never retried -- a garage that tried to build a
    // context on every visit would stall the screen once per visit forever.
    h.core.setVisible(false)
    h.core.setVisible(true)
    expect(h.core.live).toBe(false)
    run(h.core, 1)
  })

  it('treats a context lost underneath it as the same permanent failure', () => {
    const h = harness()
    h.core.setVisible(true)
    h.core.contextLost()
    expect(h.core.live).toBe(false)
    expect(h.core.failed).toBe(true)
    expect(h.stage().disposed).toBe(1)
  })
})

describe('the preview shows what is actually selected', () => {
  it('builds the stored selection the first time the garage opens', () => {
    const h = harness()
    h.core.setVisible(true)
    expect(h.stage().built[0]).toEqual({ chassisId: 'solaire', pilotId: 'socket', tier: 'medium' })
  })

  it('rebuilds when the chassis changes', () => {
    const h = harness()
    h.core.setVisible(true)
    h.core.setSelection('bulwark', 'socket')
    const last = h.stage().built[h.stage().built.length - 1]
    expect(last.chassisId).toBe('bulwark')
    expect(last.pilotId).toBe('socket')
  })

  it('rebuilds when the pilot changes', () => {
    const h = harness()
    h.core.setVisible(true)
    h.core.setSelection('solaire', 'koan')
    expect(h.stage().built[h.stage().built.length - 1].pilotId).toBe('koan')
  })

  it('rebuilds when the quality tier changes', () => {
    const h = harness()
    h.core.setVisible(true)
    h.core.setQuality('low')
    expect(h.stage().built[h.stage().built.length - 1].tier).toBe('low')
  })

  it('does not rebuild for a re-pick of what is already selected', () => {
    const h = harness()
    h.core.setVisible(true)
    const n = h.stage().built.length
    h.core.setSelection('solaire', 'socket')
    h.core.setQuality('medium')
    run(h.core, 1)
    expect(h.stage().built.length).toBe(n)
  })

  it('carries a selection made while hidden into the next visit', () => {
    // The garage is not the only place these change: the front end restores a
    // stored chassis and pilot at construction, long before the garage screen
    // is ever shown.
    const h = harness()
    h.core.setSelection('dray9', 'vanguard')
    h.core.setVisible(true)
    expect(h.stage().built[0]).toEqual({ chassisId: 'dray9', pilotId: 'vanguard', tier: 'medium' })
  })

  it('rebuilds from scratch on the visit after a hide', () => {
    const h = harness()
    h.core.setVisible(true)
    h.core.setVisible(false)
    h.core.setSelection('vector7', 'zephyr')
    h.core.setVisible(true)
    expect(h.stages.length).toBe(2)
    expect(h.stage().built[0]).toEqual({ chassisId: 'vector7', pilotId: 'zephyr', tier: 'medium' })
  })

  it('every chassis and every pilot in the roster is a valid selection', () => {
    const h = harness()
    h.core.setVisible(true)
    for (const c of CHASSIS) {
      for (const p of PILOTS) {
        h.core.setSelection(c.id, p.id)
        const last = h.stage().built[h.stage().built.length - 1]
        expect(last.chassisId).toBe(c.id)
        expect(last.pilotId).toBe(p.id)
      }
    }
  })
})

describe('the turntable', () => {
  it('rests at a three-quarter angle', () => {
    expect(new Turntable(false).yaw).toBe(REST_YAW)
    // Three-quarter, not head-on and not broadside: somewhere between 20 and
    // 70 degrees off the nose.
    const deg = Math.abs(REST_YAW) * (180 / Math.PI)
    expect(deg).toBeGreaterThan(20)
    expect(deg).toBeLessThan(70)
  })

  it('turns at 12 degrees a second', () => {
    const t = new Turntable(false)
    const start = t.yaw
    for (let i = 0; i < 60; i++) t.step(1 / 60)
    expect(t.yaw - start).toBeCloseTo(AUTO_RATE, 4)
    expect(AUTO_RATE * (180 / Math.PI)).toBeCloseTo(12, 6)
  })

  it('holds where a drag released it, then eases back to turning', () => {
    const t = new Turntable(false)
    t.grab()
    t.dragBy(120, 400)
    const released = t.yaw
    t.release()

    // A few seconds of nothing: the angle the player chose is the angle they
    // keep. This is the whole reason drag is worth having.
    for (let i = 0; i < Math.round((RESUME_DELAY - 0.2) * 60); i++) t.step(1 / 60)
    expect(t.yaw).toBeCloseTo(released, 6)
    expect(t.autoBlend).toBe(0)

    // Then it comes back, and it comes back gradually rather than snapping to
    // full rate.
    for (let i = 0; i < Math.round(RESUME_EASE * 0.5 * 60); i++) t.step(1 / 60)
    expect(t.autoBlend).toBeGreaterThan(0)
    expect(t.autoBlend).toBeLessThan(1)
    for (let i = 0; i < Math.round(RESUME_EASE * 60); i++) t.step(1 / 60)
    expect(t.autoBlend).toBe(1)
    expect(t.yaw).not.toBeCloseTo(released, 3)
  })

  it('does not turn while a finger is down', () => {
    const t = new Turntable(false)
    t.grab()
    const held = t.yaw
    for (let i = 0; i < 120; i++) t.step(1 / 60)
    expect(t.yaw).toBe(held)
  })

  it('drags in the direction of the finger, scaled to the box', () => {
    const a = new Turntable(false)
    a.grab()
    a.dragBy(200, 400)
    // Right is positive: the near face of the car follows the finger.
    expect(a.yaw).toBeGreaterThan(REST_YAW)

    // Half the box is half the turn, whatever the box measures.
    const b = new Turntable(false)
    b.grab()
    b.dragBy(100, 200)
    expect(b.yaw).toBeCloseTo(a.yaw, 6)
  })

  it('ignores a drag nobody started', () => {
    const t = new Turntable(false)
    t.dragBy(500, 400)
    expect(t.yaw).toBe(REST_YAW)
  })

  it('keeps the angle inside +/- pi however long it runs', () => {
    const t = new Turntable(false)
    for (let i = 0; i < 60 * 600; i++) t.step(1 / 60)
    expect(Math.abs(t.yaw)).toBeLessThanOrEqual(Math.PI + 1e-9)
  })
})

describe('prefers-reduced-motion', () => {
  it('holds the static three-quarter angle instead of turning', () => {
    const t = new Turntable(true)
    expect(t.yaw).toBe(REST_YAW)
    for (let i = 0; i < 60 * 30; i++) t.step(1 / 60)
    // Thirty seconds is one full revolution at the shipped rate. Not one
    // degree of it happens.
    expect(t.yaw).toBe(REST_YAW)
    expect(t.autoBlend).toBe(0)
  })

  it('still lets the player turn the car by hand', () => {
    const t = new Turntable(true)
    t.grab()
    t.dragBy(150, 400)
    const turned = t.yaw
    expect(turned).not.toBe(REST_YAW)
    t.release()
    // And it stays where it was put -- there is no auto-rotation to ease back
    // in, which is the difference between "does not move" and "cannot move".
    for (let i = 0; i < 60 * 30; i++) t.step(1 / 60)
    expect(t.yaw).toBe(turned)
  })

  it('the preview as a whole draws a still car under it', () => {
    const h = harness({ reducedMotion: true })
    h.core.setVisible(true)
    run(h.core, 5)
    const frames = h.stage().frames
    expect(frames.length).toBeGreaterThan(0)
    for (const f of frames) expect(f.yaw).toBe(REST_YAW)
  })

  it('still draws frames, because the pilot is what is being previewed', () => {
    // Deliberately NOT frozen. The idle set -- a blink, a breath, a slow lean
    // -- is the only reason the pilot is in the box at all, and it is the kind
    // of motion the preference is not about. The turntable is what stops.
    const h = harness({ reducedMotion: true })
    h.core.setVisible(true)
    run(h.core, 2)
    expect(h.stage().frames.length).toBeGreaterThan(60)
  })

  it('follows a preference that changes while the garage is open', () => {
    const h = harness({ reducedMotion: true })
    h.core.setVisible(true)
    run(h.core, 1)
    expect(h.stage().frames[h.stage().frames.length - 1].yaw).toBe(REST_YAW)
    h.core.setReducedMotion(false)
    run(h.core, 1)
    expect(h.stage().frames[h.stage().frames.length - 1].yaw).not.toBe(REST_YAW)
  })
})

describe('the stationary racer handed to the vehicle visual', () => {
  it('is a car standing still on the ground, not a fake', () => {
    for (const c of CHASSIS) {
      const r = stationaryRacer(c.id, 'socket')
      expect(r.chassisId).toBe(c.id)
      expect(r.vel).toEqual({ x: 0, y: 0, z: 0 })
      expect(r.grounded).toBe(true)
      expect(r.driftSide).toBe(0)
      expect(r.boostTime).toBe(0)
      expect(r.spinTime).toBe(0)
      expect(r.invincibleTime).toBe(0)
      // Sitting at its own ride height, so its wheels are on y = 0 and the
      // contact shadow lands where the car does.
      expect(r.pos.x).toBe(0)
      expect(r.pos.z).toBe(0)
      expect(r.pos.y).toBeGreaterThan(0)
      expect(r.up).toEqual({ x: 0, y: 1, z: 0 })
    }
  })

  it('drives the pilot idle animation, which nothing else in the game does', () => {
    // The garage is the only screen a player can look at a pilot on. If the
    // temperament set stopped running here it would stop running everywhere,
    // and no screenshot would say so.
    const jitteryFace: number[] = []
    const v = createVehicleVisual('solaire', 'vanguard', QUALITY_PRESETS.low)
    const r = stationaryRacer('solaire', 'vanguard')
    const face = v.materials.face.sg
    for (let i = 0; i < 60 * 6; i++) {
      v.update(r, 1 / 60, 8)
      jitteryFace.push(face.uBlink.value)
    }
    // VOLT blinks about once a second. Over six seconds the lid has to have
    // actually moved.
    const blinked = jitteryFace.some((b) => b > 0.5)
    expect(blinked).toBe(true)
    // And the shader clock is advancing, which is what carries the jitter.
    expect(face.uTime.value).toBeGreaterThan(5)
    v.dispose()
  })

  it('leaves a cold pilot cold', () => {
    // AEGIS's whole character is that nothing happens. A test that only
    // checked "something moves" would pass on a preview that animated every
    // pilot identically.
    const v = createVehicleVisual('filament', 'aegis', QUALITY_PRESETS.low)
    const r = stationaryRacer('filament', 'aegis')
    const face = v.materials.face.sg
    for (let i = 0; i < 60 * 6; i++) v.update(r, 1 / 60, 8)
    expect(face.uBlink.value).toBe(0)
    expect(Math.abs(face.uEmote.value)).toBeLessThan(0.05)
    v.dispose()
  })

  it('parks a stationary car without NaN, at rest, for every chassis', () => {
    for (const c of CHASSIS) {
      const v = createVehicleVisual(c.id, 'socket', QUALITY_PRESETS.low)
      const r = stationaryRacer(c.id, 'socket')
      for (let i = 0; i < 240; i++) v.update(r, 1 / 60, 8)
      const p = v.group.position
      expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true)
      expect(p.y).toBeCloseTo(r.pos.y, 6)
      // The turntable owns the heading, and the visual honours it.
      r.yaw = 1.234
      v.update(r, 1 / 60, 8)
      expect(v.group.rotation.y).toBeCloseTo(1.234, 6)
      v.dispose()
    }
  })

  it('gets a cheaper model when the box it is drawn in is small', () => {
    // The LOD switches on metres, but what it approximates is screen coverage.
    // The preview scales the distance by how few pixels a phone's box has, so
    // a phone gets LOD1 without anybody writing a device check.
    const v = createVehicleVisual('solaire', 'socket', QUALITY_PRESETS.low)
    const r = stationaryRacer('solaire', 'socket')
    v.update(r, 1 / 60, 8)
    const near = v.lodIndex
    v.update(r, 1 / 60, 30)
    const far = v.lodIndex
    expect(near).toBe(0)
    expect(far).toBeGreaterThan(near)
    v.dispose()
  })
})
