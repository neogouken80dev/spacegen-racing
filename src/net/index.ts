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
 *   live      the real backend: `/api/signal` for the directory and the
 *             mailbox, WebRTC data channels for the room and the race. See
 *             net/live.ts. NOT THE DEFAULT YET -- see `DEFAULT_PROFILE`.
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
import { LiveLobbyService, type LiveNetOptions, type LiveRaceTransport } from './live'
import {
  HASH_EVERY as HASH_EVERY_N, LockstepRunner as LockstepRunnerClass,
  packInput as packInputFn, unpackInput as unpackInputFn,
} from './lockstep'
import { LiveAccountService } from './account'
import type { AccountService, LobbyService } from './types'

export type NetProfile = 'mock' | 'perfect' | 'live'

/**
 * The default. Change this line, and only this line, when `live` is real.
 *
 * STILL `mock`, AND DELIBERATELY SO. The live path is implemented and proved
 * -- tools/probe-netcode.mjs stands up two Chromium contexts, opens a real
 * RTCPeerConnection between them through the real signalling handler, races a
 * real `Race` on both and checks that their determinism hashes agree -- but
 * every one of those connections is between two processes on one machine
 * behind one NAT. The thing that decides whether `live` is the right default
 * for strangers on the internet is NAT traversal, and that is exactly the
 * thing a probe on this machine cannot measure. Flipping this is a decision to
 * take with two real players on two real networks, in a commit with a message
 * on it, and not one to take from a green CI run.
 */
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

/**
 * Everything a `live` build needs that is not in the URL.
 *
 * Set by a probe or a harness BEFORE the first `lobbyService()` call. Nothing
 * in a shipped build calls it: the defaults point at `/api/signal` and the
 * public STUN servers, and the shaping fields exist only so a test can put the
 * distance back between two browsers that are sitting on the same loopback.
 */
export type LiveOverrides = Omit<LiveNetOptions, 'identity'>
let liveOverrides: LiveOverrides = {}

export function configureLive(o: LiveOverrides): void {
  liveOverrides = { ...liveOverrides, ...o }
}

/**
 * A PEER ID THAT IS ACTUALLY UNIQUE, which the account id is not.
 *
 * FOUND BY THE PROBE, AND IT IS THE FIRST THING THAT BROKE. `net/mock.ts`
 * mints an account id from a SEEDED counter (`world.nextId('acct-')`), which
 * is exactly right for a mock -- a deterministic world is the whole point --
 * and catastrophic the moment two of those worlds are on two different
 * machines talking to each other. Both browsers mint the same id, the second
 * one to join reads `hostId === myId` and decides it is the host, and the two
 * of them sit in one lobby each waiting for somebody to connect. Nothing logs
 * an error; it simply never starts.
 *
 * So the live peer id is the account id plus a random salt stored on the
 * device. It is stable across reloads (so a rejoin is recognised as a rejoin),
 * unique across devices (which is the whole requirement), and it is
 * EPHEMERAL IN A PRIVATE WINDOW -- where storage throws, the salt is minted per
 * session and a reload is a new player. That is the honest behaviour: a
 * profile that cannot be remembered cannot have a slot held for it either, and
 * `AccountService.ephemeral` already tells the player as much.
 *
 * This disappears the day accounts are minted server-side, which is the same
 * day `AccountService` stops being the mock. Until then the salt is doing all
 * of the work and the account id is along for the ride.
 */
const PEER_SALT_KEY = 'sg.net.peer'
let peerSalt = ''

function devicePeerSalt(): string {
  if (peerSalt) return peerSalt
  const mint = (): string => {
    try {
      const b = new Uint8Array(8)
      crypto.getRandomValues(b)
      return [...b].map((x) => x.toString(36)).join('')
    } catch {
      return Math.floor(Math.random() * 1e12).toString(36)
    }
  }
  try {
    // The property access is wrapped, not just the methods: a partitioned or
    // private context throws on `window.localStorage` itself, which is the
    // same trap net/mock.ts's `deviceStorage` documents.
    const ls = globalThis.localStorage
    const have = ls?.getItem(PEER_SALT_KEY)
    if (have) { peerSalt = have; return peerSalt }
    peerSalt = mint()
    ls?.setItem(PEER_SALT_KEY, peerSalt)
  } catch {
    peerSalt = mint()
  }
  return peerSalt
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
  if (!account) {
    const profile = netProfile()
    account = profile === 'live'
      ? new LiveAccountService()
      : createMockAccountService(optionsFor(profile))
  }
  return account
}

/**
 * The account service IF something has already created it, else null.
 *
 * For a caller that should talk to the player's account when there is one and
 * must never be the reason there is one: the achievement sync after a race
 * (game/achievementRun.ts). `accountService()` would start the mock world's
 * clock for a player who only ever pressed PLAY -- the exact cost the note
 * above exists to refuse.
 */
export function existingAccountService(): AccountService | null {
  return account
}

export function lobbyService(): LobbyService {
  if (!lobby) {
    const profile = netProfile()
    lobby = profile === 'live'
      ? new LiveLobbyService({
        ...liveOverrides,
        /**
         * THE ACCOUNT IS STILL THE MOCK'S, AND THAT IS NOT AN OVERSIGHT.
         * `live` means live LOBBIES and a live TRANSPORT. There is no account
         * endpoint yet, so names are claimed on the device rather than on the
         * server, exactly as they are under `mock` -- and a peer id only has
         * to be unique within one lobby for any of the netcode to work.
         * Saying so here is cheaper than letting somebody discover it from
         * two players managing to pick the same name.
         */
        identity: async () => {
          const p = await accountService().load()
          // Hyphen, not a dot: the endpoint's `idOk` accepts [A-Za-z0-9_-] and
          // silently rejects anything else, which would be a join that fails
          // with `bad-peer` for a reason nobody would look for here.
          return { id: `${p.id}-${devicePeerSalt()}`, name: p.name, avatarId: p.avatarId }
        },
      })
      : createMockLobbyService(optionsFor(profile))
  }
  return lobby
}

/**
 * The transport for the round now running, or null.
 *
 * A SEAM THAT SHOULD BE ON `LobbyService` AND IS NOT YET. types.ts hands the
 * front end a `RaceStartPacket` when a race begins and nothing else, and a
 * packet cannot carry inputs -- so there is currently no route from
 * `LobbyService.onStart` to the `RaceTransport` that belongs to the round it
 * just announced. This is that route, and it is a function in this file rather
 * than a field on the interface only because types.ts is not mine to edit.
 *
 * Returns null under `mock` and `perfect`, which is correct: the mock races
 * against itself and there is nothing on the wire.
 */
export function raceTransport(): LiveRaceTransport | null {
  return lobby instanceof LiveLobbyService ? lobby.raceTransport() : null
}

/** The live service, when that is what is running. For a probe and for the
 *  `endRound` call a series needs between rounds. */
export function liveLobby(): LiveLobbyService | null {
  return lobby instanceof LiveLobbyService ? lobby : null
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
export {
  LockstepRunner, LockstepScheduler, DesyncWatch,
  packInput, unpackInput, HASH_EVERY, STALL_ANNOUNCE_MS, STALL_DROP_MS,
} from './lockstep'
export { CONNECT_TIMEOUT_MS, FAILURE_TEXT, type Shape } from './webrtc'
export { inputDelayFor as liveInputDelayFor } from './live'

/**
 * THE PROBE SEAM, and the same one `game/main.ts` opens with `__GAME__`.
 *
 * tools/probe-netcode.mjs drives two real Chromium contexts against the BUILT
 * bundle, which is an application entry point and exports nothing -- so there
 * is no other way for a screenshot script to reach `configureLive` (to point
 * the two of them at its own signalling server and to put some simulated
 * distance between them) or `LockstepRunner` (to gate the sim on the wire
 * without editing game/main.ts, which is the hook this pass is asking for).
 *
 * Unguarded, exactly as `__GAME__` is. It is the netcode's own public surface
 * on an object with a name nobody types by accident, and a build flag that
 * hid it would mean the thing the probe photographs is not the thing that
 * ships -- which is the whole argument net/index.ts already makes about
 * `DEFAULT_PROFILE`.
 */
if (typeof window !== 'undefined') {
  ;(window as unknown as { __NET__: unknown }).__NET__ = {
    configureLive, lobbyService, accountService, raceTransport, liveLobby,
    netProfile, LockstepRunner: LockstepRunnerClass,
    packInput: packInputFn, unpackInput: unpackInputFn,
    HASH_EVERY: HASH_EVERY_N,
  }
}
