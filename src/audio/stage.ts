/**
 * SpaceGen Racing — the Web Audio stage.
 * ---------------------------------------------------------------------------
 * The only file in the game that knows what an AudioContext is. Everything
 * above it deals in numbers; everything below it is the browser.
 *
 * THREE THINGS THIS HAS TO SURVIVE
 *
 * NO CONTEXT AT ALL. Web Audio can be absent, disabled by policy, or simply
 * refuse to construct. `createStage` returns null, the core latches it, and
 * every call becomes a no-op. The game plays silently and says nothing --
 * exactly as garagePreview hides itself rather than showing a player an error
 * about WebGL. Audio is the one subsystem a player may have deliberately
 * disabled at the OS level, so failure here is not necessarily failure.
 *
 * AUTOPLAY POLICY. Every modern browser starts a context `suspended` and will
 * only resume it inside a real user gesture. That is not an error state and it
 * is not something to work around -- it is the rule. `unlock()` is called from
 * the front end's own click handlers, which is the one place a genuine gesture
 * is guaranteed.
 *
 * BEING LEFT RUNNING. A context with live oscillators in a backgrounded tab is
 * a battery complaint. The core suspends on `visibilitychange`; this exposes
 * the mechanism.
 *
 * WHY OSCILLATORS AND NOT SAMPLES, FOR NOW
 *
 * Every sound in the catalogue currently ships as a synth recipe, so this file
 * builds each one from nodes at trigger time. That is genuinely cheap -- an
 * oscillator, a gain and sometimes a filter, all stopped and collected within a
 * second -- and it means there is no loader, no decode, no cache and no
 * first-play stutter to debug. `playFile` exists alongside it for the moment a
 * recipe becomes a recording, and the two are indistinguishable to callers.
 */
import type {
  AudioStage, EngineVoice, PlayRequest, ScrapeId, ScrapeLevel, SoundDef,
  SynthRecipe, Volumes,
} from './api'

type Ctx = AudioContext

/** A running sustained voice: noise through a filter, gain driven per frame. */
interface Sustain {
  src: AudioBufferSourceNode
  filt: BiquadFilterNode
  gain: GainNode
  pan: PannerNode | null
}

/** A running engine voice for one racer. */
interface Engine {
  osc: OscillatorNode
  sub: OscillatorNode
  noise: AudioBufferSourceNode
  noiseGain: GainNode
  gain: GainNode
  pan: PannerNode | null
}

/**
 * One second of white noise, built once and shared.
 *
 * Every noise-shaped sound in the game loops this same buffer through a
 * different filter. Generating a fresh buffer per play would allocate 44,100
 * floats for a 70-millisecond gatling round, ten times a second, per firing
 * car -- which is a garbage collector problem disguised as an audio feature.
 */
function noiseBuffer(ctx: Ctx): AudioBuffer {
  const b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
  const d = b.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  return b
}

class WebAudioStage implements AudioStage {
  private readonly ctx: Ctx
  private readonly master: GainNode
  private readonly busSfx: GainNode
  private readonly busMusic: GainNode
  private readonly busVo: GainNode
  /** Music sits behind its own trim so ducking cannot fight the user's fader. */
  private readonly duckGain: GainNode
  private readonly noise: AudioBuffer

  private vol: Volumes
  private readonly sustains = new Map<ScrapeId, Sustain>()
  private readonly engines = new Map<number, Engine>()
  private music: { src: AudioBufferSourceNode; gain: GainNode; url: string } | null = null
  private readonly buffers = new Map<string, AudioBuffer | null>()
  private disposed = false

  constructor(ctx: Ctx, vol: Volumes) {
    this.ctx = ctx
    this.vol = vol
    this.noise = noiseBuffer(ctx)

    this.master = ctx.createGain()
    this.master.connect(ctx.destination)

    this.busSfx = ctx.createGain()
    this.busVo = ctx.createGain()
    this.duckGain = ctx.createGain()
    this.busMusic = ctx.createGain()

    this.busSfx.connect(this.master)
    this.busVo.connect(this.master)
    // music -> duck -> master. Two stages on purpose: the duck automates freely
    // without ever overwriting the value the player set on the music slider.
    this.busMusic.connect(this.duckGain)
    this.duckGain.connect(this.master)
    this.duckGain.gain.value = 1

    this.applyVolumes()
  }

  get running(): boolean { return this.ctx.state === 'running' }

  unlock(): void {
    if (this.disposed) return
    if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => {})
  }

  suspend(): void {
    if (this.disposed) return
    if (this.ctx.state === 'running') void this.ctx.suspend().catch(() => {})
  }

  setVolumes(v: Volumes): void {
    this.vol = v
    this.applyVolumes()
  }

  private applyVolumes(): void {
    const m = this.vol.muted ? 0 : this.vol.master
    const t = this.ctx.currentTime
    // Ramped, not assigned. A direct write to .value on a connected gain is an
    // instantaneous step, and an instantaneous step in an audio signal is a
    // click -- which is exactly what a player dragging a volume slider would
    // hear on every pointer move.
    ramp(this.master.gain, m, t, 0.03)
    ramp(this.busSfx.gain, this.vol.sfx, t, 0.03)
    ramp(this.busMusic.gain, this.vol.music, t, 0.03)
    ramp(this.busVo.gain, this.vol.vo, t, 0.03)
  }

  setListener(
    px: number, py: number, pz: number,
    fx: number, fy: number, fz: number,
    ux: number, uy: number, uz: number,
  ): void {
    if (this.disposed) return
    const l = this.ctx.listener
    // The modern AudioParam interface where it exists, the deprecated setters
    // otherwise. Safari shipped the old one for years and still does in places.
    if (l.positionX) {
      const t = this.ctx.currentTime
      l.positionX.setTargetAtTime(px, t, 0.02)
      l.positionY.setTargetAtTime(py, t, 0.02)
      l.positionZ.setTargetAtTime(pz, t, 0.02)
      l.forwardX.setTargetAtTime(fx, t, 0.02)
      l.forwardY.setTargetAtTime(fy, t, 0.02)
      l.forwardZ.setTargetAtTime(fz, t, 0.02)
      l.upX.setTargetAtTime(ux, t, 0.02)
      l.upY.setTargetAtTime(uy, t, 0.02)
      l.upZ.setTargetAtTime(uz, t, 0.02)
    } else {
      const any = l as unknown as {
        setPosition?: (x: number, y: number, z: number) => void
        setOrientation?: (fx: number, fy: number, fz: number, ux: number, uy: number, uz: number) => void
      }
      any.setPosition?.(px, py, pz)
      any.setOrientation?.(fx, fy, fz, ux, uy, uz)
    }
  }

  private panner(at: { x: number; y: number; z: number }): PannerNode {
    const p = this.ctx.createPanner()
    p.panningModel = 'equalpower'
    // `inverse` with a generous rolloff rather than `linear`: the planner has
    // already applied its own falloff for the gain, and this only has to carry
    // DIRECTION. Doubling the distance law here would make far cars inaudible
    // twice over.
    p.distanceModel = 'inverse'
    p.refDistance = 12
    p.rolloffFactor = 0.6
    p.maxDistance = 400
    p.positionX ? (p.positionX.value = at.x) : null
    if (p.positionX) {
      p.positionY.value = at.y
      p.positionZ.value = at.z
    } else {
      (p as unknown as { setPosition: (x: number, y: number, z: number) => void })
        .setPosition(at.x, at.y, at.z)
    }
    return p
  }

  play(req: PlayRequest, def: SoundDef): void {
    if (this.disposed || this.ctx.state !== 'running') return
    const dest = def.bus === 'music' ? this.busMusic : def.bus === 'vo' ? this.busVo : this.busSfx
    const out = this.ctx.createGain()
    out.gain.value = req.gain
    if (req.at) {
      const p = this.panner(req.at)
      out.connect(p)
      p.connect(dest)
    } else {
      out.connect(dest)
    }
    if (def.source.kind === 'synth') this.synth(def.source.recipe, out, req.rate)
    else this.playFile(def.source.url, out, req.rate)
  }

  /** Build one shot from nodes and let it collect itself. */
  private synth(r: SynthRecipe, out: GainNode, rate: number): void {
    const t = this.ctx.currentTime
    const dur = r.dur / Math.max(0.25, rate)
    const env = this.ctx.createGain()
    const atk = Math.max(0.001, r.attack ?? 0.004)
    env.gain.setValueAtTime(0.0001, t)
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, r.gain), t + atk)
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    env.connect(out)

    const f0 = r.freq * rate
    const f1 = (r.freqTo ?? r.freq) * rate

    if (r.shape === 'noise') {
      const src = this.ctx.createBufferSource()
      src.buffer = this.noise
      src.loop = true
      const filt = this.ctx.createBiquadFilter()
      filt.type = 'bandpass'
      filt.Q.value = r.q ?? 1.4
      filt.frequency.setValueAtTime(f0, t)
      if (f1 !== f0) filt.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur)
      src.connect(filt)
      filt.connect(env)
      src.start(t)
      src.stop(t + dur + 0.02)
      cleanup(src, [filt, env, out])
      return
    }

    const osc = this.ctx.createOscillator()
    osc.type = r.shape === 'thud' ? 'sine' : r.shape === 'zap' ? 'sawtooth' : 'triangle'
    osc.frequency.setValueAtTime(Math.max(20, f0), t)
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur)
    osc.connect(env)
    osc.start(t)
    osc.stop(t + dur + 0.02)

    let harm: OscillatorNode | null = null
    if (r.harm && r.harm > 0) {
      // An octave (or a named harmonic) on top is what separates "a tone" from
      // "a note". Cheap: one more oscillator for the length of the shot.
      harm = this.ctx.createOscillator()
      harm.type = 'sine'
      const mul = r.harmonic ?? 2
      harm.frequency.setValueAtTime(Math.max(20, f0 * mul), t)
      if (f1 !== f0) harm.frequency.exponentialRampToValueAtTime(Math.max(20, f1 * mul), t + dur)
      const hg = this.ctx.createGain()
      hg.gain.value = r.harm
      harm.connect(hg)
      hg.connect(env)
      harm.start(t)
      harm.stop(t + dur + 0.02)
    }
    cleanup(osc, harm ? [env, out] : [env, out])
  }

  private playFile(url: string, out: GainNode, rate: number): void {
    const buf = this.buffers.get(url)
    if (buf === undefined) { void this.load(url); return }   // arrives next time
    if (buf === null) return                                  // known missing
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = rate
    src.connect(out)
    src.start()
    cleanup(src, [out])
  }

  /**
   * Fetch and decode, remembering failures as `null`.
   *
   * A missing file is not an error worth surfacing: the catalogue is designed
   * to be upgraded one entry at a time, so a URL that is not there yet simply
   * means that sound is still silent. Retrying it on every trigger would be a
   * request storm on a 404.
   */
  private async load(url: string): Promise<void> {
    this.buffers.set(url, null)
    try {
      const res = await fetch(url)
      if (!res.ok) return
      const arr = await res.arrayBuffer()
      const buf = await this.ctx.decodeAudioData(arr)
      if (!this.disposed) this.buffers.set(url, buf)
    } catch { /* stays null; that sound is silent */ }
  }

  setScrape(id: ScrapeId, level: ScrapeLevel | null): void {
    if (this.disposed || this.ctx.state !== 'running') return
    const live = this.sustains.get(id)
    const want = level && level.gain > 0.01 ? level.gain : 0

    if (want <= 0) {
      if (live) {
        ramp(live.gain.gain, 0.0001, this.ctx.currentTime, 0.08)
        const s = live
        this.sustains.delete(id)
        window.setTimeout(() => { try { s.src.stop() } catch { /* already stopped */ } }, 160)
      }
      return
    }

    if (!live) {
      const src = this.ctx.createBufferSource()
      src.buffer = this.noise
      src.loop = true
      const filt = this.ctx.createBiquadFilter()
      filt.type = 'bandpass'
      filt.Q.value = id === 'scrapeWall' ? 2.2 : 1.6
      filt.frequency.value = id === 'scrapeWall' ? 2200 : 1300
      const gain = this.ctx.createGain()
      gain.gain.value = 0.0001
      src.connect(filt); filt.connect(gain); gain.connect(this.busSfx)
      src.start()
      this.sustains.set(id, { src, filt, gain, pan: null })
    }
    const s = this.sustains.get(id)!
    ramp(s.gain.gain, Math.max(0.0002, want * 0.3), this.ctx.currentTime, 0.05)
    // Harder contact opens the filter: a graze hisses, a lean roars.
    ramp(s.filt.frequency, (id === 'scrapeWall' ? 1500 : 900) + want * 2200,
      this.ctx.currentTime, 0.08)
  }

  setEngine(racerId: number, v: EngineVoice | null): void {
    if (this.disposed || this.ctx.state !== 'running') return
    const live = this.engines.get(racerId)
    if (!v) {
      if (live) {
        ramp(live.gain.gain, 0.0001, this.ctx.currentTime, 0.10)
        const e = live
        this.engines.delete(racerId)
        window.setTimeout(() => {
          try { e.osc.stop(); e.sub.stop(); e.noise.stop() } catch { /* gone */ }
        }, 220)
      }
      return
    }

    let e = live
    if (!e) {
      const osc = this.ctx.createOscillator()
      osc.type = 'sawtooth'
      const sub = this.ctx.createOscillator()
      sub.type = 'sine'
      // A noise layer under the tone is the drift squall and the boost bite.
      // Without it a boosting car just gets louder, which reads as volume
      // rather than as effort.
      const noise = this.ctx.createBufferSource()
      noise.buffer = this.noise
      noise.loop = true
      const noiseFilt = this.ctx.createBiquadFilter()
      noiseFilt.type = 'bandpass'
      noiseFilt.frequency.value = 1800
      noiseFilt.Q.value = 1.1
      const noiseGain = this.ctx.createGain()
      noiseGain.gain.value = 0.0001
      const gain = this.ctx.createGain()
      gain.gain.value = 0.0001

      osc.connect(gain); sub.connect(gain)
      noise.connect(noiseFilt); noiseFilt.connect(noiseGain); noiseGain.connect(gain)

      let pan: PannerNode | null = null
      if (v.at) { pan = this.panner(v.at); gain.connect(pan); pan.connect(this.busSfx) }
      else gain.connect(this.busSfx)

      osc.start(); sub.start(); noise.start()
      e = { osc, sub, noise, noiseGain, gain, pan }
      this.engines.set(racerId, e)
    }

    const t = this.ctx.currentTime
    const base = 92 * v.rate
    ramp(e.osc.frequency, base, t, 0.06)
    ramp(e.sub.frequency, base * 0.5, t, 0.06)
    ramp(e.gain.gain, Math.max(0.0002, v.gain * 0.16), t, 0.06)
    ramp(e.noiseGain.gain, Math.max(0.0001, (v.boost * 0.35 + v.drift * 0.45) * v.gain), t, 0.05)
    if (e.pan && v.at) {
      if (e.pan.positionX) {
        e.pan.positionX.setTargetAtTime(v.at.x, t, 0.04)
        e.pan.positionY.setTargetAtTime(v.at.y, t, 0.04)
        e.pan.positionZ.setTargetAtTime(v.at.z, t, 0.04)
      } else {
        (e.pan as unknown as { setPosition: (x: number, y: number, z: number) => void })
          .setPosition(v.at.x, v.at.y, v.at.z)
      }
    }
  }

  setMusic(url: string | null, fadeSeconds: number): void {
    if (this.disposed) return
    if (this.music && this.music.url === url) return
    const t = this.ctx.currentTime

    if (this.music) {
      const old = this.music
      ramp(old.gain.gain, 0.0001, t, Math.max(0.05, fadeSeconds))
      window.setTimeout(() => {
        try { old.src.stop() } catch { /* already stopped */ }
      }, fadeSeconds * 1000 + 250)
      this.music = null
    }
    if (!url) return

    const buf = this.buffers.get(url)
    if (buf === undefined) {
      // Not loaded yet. Kick the fetch and let the next call pick it up; a
      // missing bed means silence, never a thrown error.
      void this.load(url).then(() => {
        if (!this.disposed && this.buffers.get(url)) this.setMusic(url, fadeSeconds)
      })
      return
    }
    if (buf === null) return

    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.loop = true
    const gain = this.ctx.createGain()
    gain.gain.value = 0.0001
    src.connect(gain)
    gain.connect(this.busMusic)
    src.start()
    ramp(gain.gain, 1, t, Math.max(0.05, fadeSeconds))
    this.music = { src, gain, url }
  }

  duck(level: number, hold: number): void {
    if (this.disposed || this.ctx.state !== 'running') return
    const t = this.ctx.currentTime
    const g = this.duckGain.gain
    g.cancelScheduledValues(t)
    g.setValueAtTime(Math.max(0.0001, g.value), t)
    g.exponentialRampToValueAtTime(Math.max(0.0001, level), t + 0.08)
    g.exponentialRampToValueAtTime(1, t + 0.08 + hold + 0.25)
  }

  speak(url: string): boolean {
    if (this.disposed || this.ctx.state !== 'running') return false
    const buf = this.buffers.get(url)
    if (buf === undefined) { void this.load(url); return false }
    if (buf === null) return false
    const out = this.ctx.createGain()
    out.gain.value = 1
    out.connect(this.busVo)
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.connect(out)
    src.start()
    cleanup(src, [out])
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const [id] of this.sustains) this.setScrape(id, null)
    for (const [id] of this.engines) this.setEngine(id, null)
    this.setMusic(null, 0.05)
    void this.ctx.close().catch(() => {})
  }
}

/** Ramp a param without clicking, and without exponential-to-zero errors. */
function ramp(p: AudioParam, to: number, t: number, seconds: number): void {
  const safe = Math.max(0.0001, to)
  p.cancelScheduledValues(t)
  p.setValueAtTime(Math.max(0.0001, p.value), t)
  p.linearRampToValueAtTime(safe, t + seconds)
}

/** Disconnect a finished source's chain so nothing is retained. */
function cleanup(src: AudioScheduledSourceNode, nodes: AudioNode[]): void {
  src.onended = () => {
    try { src.disconnect() } catch { /* already gone */ }
    for (const n of nodes) { try { n.disconnect() } catch { /* already gone */ } }
  }
}

/**
 * Build a stage, or return null.
 *
 * Null is a supported outcome and the ONLY signal of failure -- there is no
 * error to show a player who has audio switched off at the OS level.
 */
export function createStage(vol: Volumes): AudioStage | null {
  try {
    const C = (window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
    if (!C) return null
    const ctx = new C({ latencyHint: 'interactive' })
    return new WebAudioStage(ctx, vol)
  } catch {
    return null
  }
}

/** Suspend/resume, for the visibility handler. Narrow surface on purpose. */
export function stageSuspend(stage: AudioStage | null, hidden: boolean): void {
  const s = stage as unknown as { suspend?: () => void; unlock?: () => void } | null
  if (!s) return
  if (hidden) s.suspend?.()
  else s.unlock?.()
}
