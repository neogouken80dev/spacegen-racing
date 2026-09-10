import { describe, it, expect, afterEach } from 'vitest'
import {
  fullscreenMode, isFullscreen, isStandalone, isSupported, setFullscreen, onFullscreenChange,
} from '../src/game/fullscreen'

/**
 * THE PLATFORM MATRIX, PINNED.
 *
 * The whole reason `fullscreen.ts` exists rather than four lines in the
 * settings panel is that "can this device go fullscreen" has three answers,
 * and the UI has to say something different and TRUE for each. That logic is
 * pure feature detection over globals, so it is testable without a browser --
 * and worth testing, because the failure mode is silent: a wrong branch gives
 * an iPhone player a switch that does nothing and no explanation.
 *
 * Everything here stubs the globals the module reads. It never asserts on a
 * user-agent string, because the module never reads one -- which is the point.
 * When Apple eventually ships the Fullscreen API on iPhone, the 'unsupported'
 * case below stops being reachable on that device and nothing needs editing.
 */

const realDoc = globalThis.document
const realWin = globalThis.window
const realNav = globalThis.navigator

interface Stub {
  fullscreenEnabled?: boolean
  webkitFullscreenEnabled?: boolean
  fullscreenElement?: unknown
  webkitFullscreenElement?: unknown
  standalone?: boolean
  displayMode?: string | null
  requestFails?: boolean
}

const listeners = new Map<string, Set<() => void>>()
let currentEl: unknown = null

function def(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

function install(s: Stub): void {
  listeners.clear()
  currentEl = s.fullscreenElement ?? s.webkitFullscreenElement ?? null
  const d = {
    get fullscreenEnabled() { return !!s.fullscreenEnabled },
    get webkitFullscreenEnabled() { return !!s.webkitFullscreenEnabled },
    get fullscreenElement() { return s.fullscreenEnabled ? currentEl : undefined },
    get webkitFullscreenElement() { return s.webkitFullscreenEnabled ? currentEl : undefined },
    documentElement: {
      requestFullscreen: s.fullscreenEnabled
        ? async () => { if (s.requestFails) throw new Error('gesture required'); currentEl = {} }
        : undefined,
      webkitRequestFullscreen: s.webkitFullscreenEnabled && !s.fullscreenEnabled
        ? async () => { if (s.requestFails) throw new Error('gesture required'); currentEl = {} }
        : undefined,
    },
    exitFullscreen: s.fullscreenEnabled ? async () => { currentEl = null } : undefined,
    webkitExitFullscreen: s.webkitFullscreenEnabled ? async () => { currentEl = null } : undefined,
    addEventListener: (e: string, cb: () => void) => {
      if (!listeners.has(e)) listeners.set(e, new Set())
      listeners.get(e)!.add(cb)
    },
    removeEventListener: (e: string, cb: () => void) => { listeners.get(e)?.delete(cb) },
  }
  // defineProperty, not assignment: `navigator` is getter-only on globalThis
  // in Node 22 and a plain assign throws.
  def('document', d)
  def('window', {
    matchMedia: (q: string) => ({ matches: s.displayMode ? q.includes(s.displayMode) : false }),
  })
  def('navigator', { standalone: s.standalone })
}

afterEach(() => {
  def('document', realDoc)
  def('window', realWin)
  def('navigator', realNav)
})

describe('the three platform answers', () => {
  it('desktop and Android: the API is there, so the switch is live', () => {
    install({ fullscreenEnabled: true })
    expect(isSupported()).toBe(true)
    expect(fullscreenMode()).toBe('available')
  })

  it('older Safari: the webkit prefix counts as supported', () => {
    install({ webkitFullscreenEnabled: true })
    expect(isSupported()).toBe(true)
    expect(fullscreenMode()).toBe('available')
  })

  it('iPhone Safari in a tab: no API, not installed -> unsupported', () => {
    // The case the row's copy exists for. `fullscreenEnabled` is false and
    // requestFullscreen is undefined; there is no prefix that helps.
    install({})
    expect(isSupported()).toBe(false)
    expect(isStandalone()).toBe(false)
    expect(fullscreenMode()).toBe('unsupported')
  })

  it('installed to the home screen: already fullscreen, nothing to toggle', () => {
    install({ standalone: true })
    expect(fullscreenMode()).toBe('standalone')
    install({ displayMode: 'fullscreen' })
    expect(fullscreenMode()).toBe('standalone')
    install({ displayMode: 'standalone' })
    expect(fullscreenMode()).toBe('standalone')
  })

  it('an iframe without allowfullscreen is unsupported, not merely off', () => {
    // fullscreenEnabled is exactly the flag that goes false here while the
    // method still exists, which is why the module tests the flag.
    install({ fullscreenEnabled: false })
    expect(isSupported()).toBe(false)
  })
})

describe('the switch never lies about the state', () => {
  it('reports what actually happened, not what was asked', async () => {
    install({ fullscreenEnabled: true })
    expect(await setFullscreen(true)).toBe(true)
    expect(isFullscreen()).toBe(true)
    expect(await setFullscreen(false)).toBe(false)
  })

  it('a refused request reports false rather than throwing', async () => {
    // The browser demands a user gesture and may decide this call is too far
    // from one. Swallowing that and flipping the switch anyway is how a UI
    // ends up claiming to be fullscreen while it plainly is not.
    install({ fullscreenEnabled: true, requestFails: true })
    expect(await setFullscreen(true)).toBe(false)
  })

  it('asking on a platform with no API resolves false instead of throwing', async () => {
    install({})
    expect(await setFullscreen(true)).toBe(false)
  })
})

describe('changes made outside the switch still reach it', () => {
  it('listens on both event spellings and unsubscribes', () => {
    install({ fullscreenEnabled: true, webkitFullscreenEnabled: true })
    let n = 0
    const off = onFullscreenChange(() => { n++ })
    // Escape, F11, the Android back gesture and the OS all arrive as one of
    // these. Without them the toggle would sit saying ON with the browser
    // bars plainly back.
    for (const cb of listeners.get('fullscreenchange') ?? []) cb()
    for (const cb of listeners.get('webkitfullscreenchange') ?? []) cb()
    expect(n).toBe(2)
    off()
    for (const cb of listeners.get('fullscreenchange') ?? []) cb()
    expect(n).toBe(2)
  })
})
