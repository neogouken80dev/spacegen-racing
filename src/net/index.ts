/**
 * SpaceGen Racing — where the app gets its network services.
 * ---------------------------------------------------------------------------
 * ONE FILE, TWO FUNCTIONS. Nothing above this line -- no screen, no HUD, no
 * garage -- ever imports `./mock` directly. They import `accountService()` and
 * `lobbyService()` from here, and the day the real backend lands it is this
 * file that changes and nothing else. That is the entire point of types.ts's
 * seam and it only holds if there is exactly one place that names an
 * implementation.
 *
 * ===========================================================================
 * HOW IT CHOOSES, AND WHY THAT WAY
 *
 * Three profiles, resolved in this order: URL parameter, then build-time env,
 * then the default constant.
 *
 *   mock      the lively mock: latency, failures, a directory that moves.
 *             The default, because it is the only implementation that exists
 *             and because it is the one that finds bugs.
 *   perfect   the same mock with the failure dice off and the latency floored
 *             at a constant. FOR PHOTOGRAPHS AND FOR DEMOS ONLY.
 *   live      the real backend. Not written yet; asks for it and you get a
 *             clear error rather than a silent fallback to the mock.
 *
 * WHY A URL PARAMETER RATHER THAN ONLY A BUILD FLAG. The probe scripts in
 * tools/ drive a real browser against a built site and take screenshots. A
 * shot of the lobby browser has to be reproducible -- same rows, no error
 * banner, no half-loaded pings -- and a build flag cannot be flipped by a
 * screenshot script without rebuilding the site, which costs a minute per shot
 * and produces a build nobody ships. `?net=perfect` costs nothing and cannot
 * affect a normal player, who has no reason to type it.
 *
 * WHY A BUILD-TIME ENV VAR AS WELL. `VITE_NET=live npm run build` is how the
 * real backend eventually becomes the default for a deploy without editing
 * source, which is what a Netlify build environment can actually do.
 *
 * WHY THE DEFAULT IS A CONSTANT IN SOURCE AND NOT `import.meta.env.DEV`. Tying
 * it to dev-vs-prod would mean the thing that ships is a thing no developer
 * ever runs. When `live` works it becomes the default here, deliberately, in a
 * commit with a message on it.
 */
import {
  createMockAccountService, createMockLobbyService, resetSharedWorld, sharedWorld,
  type MockNetOptions,
} from './mock'
import type { AccountService, LobbyService } from './types'

export type NetProfile = 'mock' | 'perfect' | 'live'

/** The default. Change this line, and only this line, when `live` is real. */
export const DEFAULT_PROFILE: NetProfile = 'mock'

function isProfile(v: string | null | undefined): v is NetProfile {
  return v === 'mock' || v === 'perfect' || v === 'live'
}

/**
 * The profile in force.
 *
 * Every lookup is wrapped. `location` does not exist in a worker or in a test,
 * `URLSearchParams` is unavailable in old embedded webviews, and
 * `import.meta.env` is undefined anywhere this module is loaded outside a Vite
 * pipeline. None of those is a reason for the game not to start.
 */
export function netProfile(): NetProfile {
  try {
    const search = (globalThis as { location?: { search?: string } }).location?.search
    if (search) {
      const q = new URLSearchParams(search).get('net')
      if (isProfile(q)) return q
    }
  } catch {
    /* no location, or a URLSearchParams that is not there */
  }
  try {
    const env = (import.meta as { env?: Record<string, string | undefined> }).env
    const v = env?.VITE_NET
    if (isProfile(v)) return v
  } catch {
    /* not built by Vite */
  }
  return DEFAULT_PROFILE
}

/**
 * The options each profile hands the mock.
 *
 * `perfect` keeps the latency SCALE at a fifth rather than at zero. Zero would
 * resolve every call in the same tick and hide the one thing a screenshot can
 * still catch -- a screen that renders nothing at all while a request is in
 * flight, because it has no loading state. A fifth is ~25ms: fast enough that
 * nobody waits for a shot, slow enough that the loading state still has to
 * exist.
 */
function optionsFor(profile: NetProfile): MockNetOptions {
  if (profile === 'perfect') return { world: sharedWorld(), failureRate: 0, latencyScale: 0.2 }
  return { world: sharedWorld() }
}

let account: AccountService | null = null
let lobby: LobbyService | null = null

/**
 * The account service.
 *
 * LAZY, AND THAT MATTERS. Creating a lobby service attaches to the world and
 * starts its clock. If these were module-level constants, importing anything
 * from `net/` would start a directory ticking -- during the attract loop, in a
 * unit test that only wanted a type, in the headless balance harness. Nothing
 * should begin because a module was named.
 */
export function accountService(): AccountService {
  if (!account) account = createMockAccountService(optionsFor(netProfile()))
  return account
}

export function lobbyService(): LobbyService {
  if (!lobby) {
    const profile = netProfile()
    if (profile === 'live') {
      // Loud, not silent. A build that asked for the real backend and quietly
      // got a mock directory full of invented people is the worst outcome
      // available: it looks like it works.
      throw new Error('net: the live backend is not implemented yet (see src/net/types.ts)')
    }
    lobby = createMockLobbyService(optionsFor(profile))
  }
  return lobby
}

/**
 * Tear both down and forget the world.
 *
 * For tests, and for the one production case that will need it: signing out, or
 * whatever replaces signing out for an anonymous account.
 */
export function resetNetServices(): void {
  // Both halves have a dispose() in the contract now, so neither needs casting
  // to find one.
  account?.dispose()
  lobby?.dispose()
  account = null
  lobby = null
  resetSharedWorld()
}

export * from './types'
