/**
 * THREE BROWSERS, ONE RACE, AND THE HOST'S TAB CLOSING HALFWAY THROUGH.
 * ---------------------------------------------------------------------------
 * tools/probe-netcode.mjs proved that two real Chromium contexts can open a
 * real RTCPeerConnection through the real signalling handler and race in
 * deterministic lockstep. This one proves the three things that happen when
 * that arrangement BREAKS:
 *
 *   1. THE HOST GOES AWAY MID-RACE and the race continues under a new one.
 *      Three contexts, because two cannot prove an election: with one survivor
 *      there is only one possible answer and any rule at all would look
 *      correct. With two survivors the rule has to pick, both have to pick the
 *      SAME one alone, and the one that was not picked has to find its way to
 *      the one that was -- through a polled mailbox, with no link to anybody.
 *
 *   2. A GUEST LOSES ITS LINK AND COMES BACK. Its slot is held, its car is
 *      driven by the AI from an agreed frame, it replays the round's inputs
 *      and is given the wheel again from a second agreed frame -- and the two
 *      clients' determinism hashes have to agree across both of those.
 *
 *   3. A MIGRATION FAILS AND SAYS SO. The elected host is gone too, nobody
 *      answers, and the budget runs out. What the player gets has to be a
 *      sentence naming what happened, not a spinner and not "error".
 *
 * ===========================================================================
 * WHAT IT CANNOT PROVE, SAID UP FRONT AND AT LENGTH
 *
 * THREE CONTEXTS IN ONE CHROMIUM SHARE A MACHINE, A LOOPBACK AND A NAT. They
 * reach each other over host candidates in single-digit milliseconds. So:
 *
 *   - The RE-HANDSHAKE here is a best case. A real migration's cost is
 *     dominated by NAT traversal and by the poll interval of a mailbox on
 *     another continent, and neither is present. What IS real is the
 *     sequencing: detect, elect, rebuild the star, exchange digests, take the
 *     cut, resume. Every one of those steps runs here for real.
 *   - A relayed migration is not tested at all, because there is no relay on
 *     a loopback and no way to force one.
 *   - Killing a context is a CLEAN kill: the channel closes inside a hundred
 *     milliseconds and `PeerLink.dead` fires immediately. A laptop lid or a
 *     train tunnel is the other case -- silence with no close -- and it is
 *     covered here only by the one-second liveness tick, not by a real one.
 *   - Three players is not eight. The message volume, the digest size and the
 *     number of peers the new host has to wait for all scale, and the eighth
 *     player is the one that finds the timing bug.
 *
 * ===========================================================================
 * NEEDS dist/, AND NEEDS tsx.
 *
 *   npx vite build && npx tsx tools/probe-migrate.mjs [--keep]
 *
 * `npx vite build` FIRST, ALWAYS. The server below serves the built site, so a
 * run against a stale bundle photographs the last commit.
 */
/*
 * RUN IT WITH tsx, NOT node:  npx tsx tools/probe-migrate.mjs
 *
 * This probe imports the real server logic out of src/net/*.ts so the two
 * browsers talk to the code that ships rather than to a stub. Those modules
 * import each other WITHOUT file extensions, which Node's ESM resolver does
 * not do for local files -- so plain `node` dies on the first hop with
 * ERR_MODULE_NOT_FOUND naming a path that obviously exists, which reads like
 * a broken build and is not one. tsx resolves them.
 *
 * Every other probe in tools/ runs under plain node because none of them
 * import TypeScript. These two are the exception; hence the sign.
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile, mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { handleSignal } from '../src/net/signalProtocol.ts'
import { handleAccount } from '../src/net/account.ts'

const KEEP = process.argv.includes('--keep')
/** `--only=2` runs one pass. The whole file takes three minutes; iterating on
 *  one failure should not. */
const ONLY = Number((process.argv.find((a) => a.startsWith('--only=')) ?? '').split('=')[1] || 0)
const wants = (n) => ONLY === 0 || ONLY === n

const errors = []
const note = (m) => { errors.push(m); console.log('  !! ' + m) }
const say = (m) => console.log('  ' + m)
const head = (m) => console.log('\n-- ' + m + ' ' + '-'.repeat(Math.max(0, 68 - m.length)))

// ---------------------------------------------------------------------------
// The server: dist/, plus the real signalling handler over a Map
// ---------------------------------------------------------------------------

const ROOT = new URL('../dist/', import.meta.url).pathname
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
}

const blobs = new Map()
const store = {
  get: async (k) => (blobs.has(k) ? JSON.parse(blobs.get(k)) : null),
  set: async (k, v) => { blobs.set(k, JSON.stringify(v)) },
  del: async (k) => { blobs.delete(k) },
}
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
let idN = 0
const newId = () => {
  let x = (++idN * 2654435761) >>> 0
  let out = ''
  for (let i = 0; i < 12; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0
    out += ALPHABET[(x >>> 16) % ALPHABET.length]
  }
  return out
}

/**
 * THE CLOCK THE ENDPOINT SEES IS SHIFTABLE, and that is not a cheat.
 *
 * `HOST_CLAIM_AFTER_MS` is fourteen seconds of real time before a survivor may
 * take the directory row from a host that never said goodbye. The RACE does
 * not wait for it -- the survivors dial the elected host directly -- so the
 * probe measures the race recovery on the real clock and then jumps this one
 * to check that the claim lands and the lobby stays in the browser. Waiting
 * fourteen real seconds would measure a `setTimeout`.
 */
/**
 * THE ACCOUNT ENDPOINT, FOR REAL, BECAUSE `live` MEANS LIVE EVERYTHING.
 *
 * net/index.ts resolves a peer's identity through `accountService().load()`
 * before a lobby can be created, so a harness with no `/api/account` is one in
 * which every page opens by minting an offline profile and logging a 404 that
 * reads exactly like a fault in the bundle. `handleAccount` takes its store,
 * its clock and its token source as arguments precisely so it can be stood up
 * next to the signalling handler, which is what happens here.
 *
 * `newToken` is length-aware and `newId` is not: an id is 16 characters and a
 * secret is 32, and both are validated on the way in, so the 12-character
 * signalling id would be refused by the endpoint's own `secretOk`.
 */
const newToken = (len) => {
  let out = ''
  while (out.length < len) out += newId()
  return out.slice(0, len)
}
const acctBlobs = new Map()
let acctTag = 0
const acctStore = {
  get: async (k) => (acctBlobs.has(k) ? { ...acctBlobs.get(k) } : null),
  create: async (k, v) => {
    if (acctBlobs.has(k)) return false
    acctBlobs.set(k, { value: v, etag: String(++acctTag) })
    return true
  },
  replace: async (k, v, etag) => {
    const cur = acctBlobs.get(k)
    // A null etag writes unconditionally, which is the contract in account.ts.
    if (etag !== null && (!cur || cur.etag !== etag)) return false
    acctBlobs.set(k, { value: v, etag: String(++acctTag) })
    return true
  },
  del: async (k) => { acctBlobs.delete(k) },
}

let clockSkew = 0
let signalCalls = 0
const readBody = (req) => new Promise((r) => {
  let b = ''
  req.on('data', (c) => { b += c })
  req.on('end', () => r(b))
})
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent((req.url || '/').split('?')[0])
    if (path === '/api/signal') {
      signalCalls++
      const body = await readBody(req)
      let parsed = null
      try { parsed = JSON.parse(body) } catch { /* handled below */ }
      const out = parsed
        ? await handleSignal(store, parsed, Date.now() + clockSkew, newId)
        : { ok: false, error: 'bad-body' }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(out))
      return
    }
    if (path === '/api/account') {
      const body = await readBody(req)
      let parsed = null
      try { parsed = JSON.parse(body) } catch { /* handled below */ }
      const out = parsed
        ? await handleAccount(acctStore, parsed, Date.now() + clockSkew, newToken)
        : { ok: false, error: 'bad-body' }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(out))
      return
    }
    if (path === '/api/leaderboard') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ rows: [], rank: 0 }))
      return
    }
    let p = path
    if (p === '/' || p.endsWith('/')) p += 'index.html'
    const buf = await readFile(join(ROOT, p))
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' })
    res.end(buf)
  } catch (e) {
    console.log(`  !! server 404 ${req.url}: ${e && e.code ? e.code : e}`)
    res.writeHead(404)
    res.end('nf')
  }
})
await new Promise((r) => server.listen(0, r))
const base = `http://127.0.0.1:${server.address().port}/`

const OUT = new URL('../shots/migrate/', import.meta.url).pathname
await mkdir(OUT, { recursive: true })
for (const f of await readdir(OUT)) if (f.endsWith('.png')) await unlink(join(OUT, f))

// ---------------------------------------------------------------------------
// Browsers
// ---------------------------------------------------------------------------

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox', '--no-sandbox', '--ignore-gpu-blocklist',
    '--disable-features=WebRtcHideLocalIpsWithMdns',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
})

let shotN = 0
async function shoot(page, label) {
  const name = `${String(++shotN).padStart(2, '0')}-${label}.png`
  try {
    await page.screenshot({ path: join(OUT, name), timeout: 20000 })
    say(`shot ${name}`)
  } catch {
    note(`could not photograph ${label} — the page did not respond in time`)
  }
  return name
}

/** Draw one frame and park again, so a screenshot is of the moment asked for
 *  and not of whatever was last painted before the renderer was parked. */
async function paintOnce(page) {
  await page.evaluate(() => {
    if (!window.__PROBE__?.parked) return
    window.__GAME__.loop(performance.now())
    cancelAnimationFrame(window.__GAME__.raf)
  }).catch(() => {})
}

let peerN = 0
async function open(label) {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 450 } })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => note(`[${label}] page error: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    note(`[${label}] console: ${m.text()}`)
  })
  await page.goto(base + '?net=live', { waitUntil: 'load', timeout: 40000 })
  await page.waitForFunction(() => !!window.__GAME__ && !!window.__NET__, null, { timeout: 60000 })
  const peerId = `probe-${label}-${++peerN}`
  await page.evaluate(([endpoint, pid, name]) => {
    window.__NET__.configureLive({
      endpoint,
      playerId: pid,
      playerName: name,
      avatarId: 'cadet',
      // NO STUN. Three contexts on one loopback reach each other on host
      // candidates alone, and a public STUN server this sandbox cannot reach
      // would add the whole gathering timeout to every connection -- and to
      // every RE-connection, which is the thing being timed here.
      iceServers: [],
    })
    window.__PROBE__ = { hashes: [], events: [], migrations: [] }
  }, [base + 'api/signal', peerId, label])
  await page.evaluate(() => { window.__GAME__.frontEnd.show('lobby') })
  await page.waitForTimeout(400)
  return { ctx, page, label, peerId }
}

async function until(page, fn, arg, ms = 20000, step = 150) {
  const t0 = Date.now()
  for (;;) {
    const v = await page.evaluate(fn, arg).catch(() => null)
    if (v) return v
    if (Date.now() - t0 > ms) return null
    await page.waitForTimeout(step)
  }
}

// ---------------------------------------------------------------------------
// The page-side rig
// ---------------------------------------------------------------------------

/**
 * game/main.ts BUILDS THE RUNNER ITSELF AND WIRES EVERY HOOK, so this only
 * observes.
 *
 * AN EARLIER PASS OF THIS FILE SUPPLIED TWO OF THEM -- `onRoundLive` and
 * `onResync` -- because main.ts had neither and photographing a feature nobody
 * had connected would have been a photograph of the probe. Both are wired in
 * the shipping code now, so the rig no longer stands in for them and, more to
 * the point, no longer HIDES them: an assignment to `transport.onResync` here
 * would replace main.ts's and the probe would be testing itself.
 *
 * What is left is a wrapper round each one that records and then delegates, so
 * the two properties a screenshot cannot show can be asserted afterwards:
 *
 *   A RESTORE LANDS ON THE AGREED FRAME, NOT ON ARRIVAL. The announcement is
 *   deliberately `REJOIN_LEAD_FRAMES` ahead of the play head, so the frame the
 *   message TURNS UP on differs between clients and the frame it is honoured on
 *   must not. `restoreAt` records both.
 *   A RESYNC REBUILDS RATHER THAN REUSING. The returning client is still
 *   holding a perfectly good `Race` for this very round and must throw it away
 *   -- see `RoundResume` in net/types.ts. Object identity is the only honest
 *   test of that, so the `Race` and the `LockstepRunner` are captured either
 *   side of the callback and compared.
 */
const RIG = ({ seedTag }) => {
  const game = window.__GAME__
  const net = window.__NET__
  const P = window.__PROBE__

  const tag = seedTag
  game.input.sample = () => {
    const f = game.race ? game.race.state.frame : 0
    return {
      steer: Math.sin((f + tag * 411) * 0.021) * (0.35 + tag * 0.25),
      throttle: 1,
      brake: 0,
      drift: ((f + tag * 33) % 110) < 30,
      item: ((f + tag * 17) % 240) === 0,
      itemBack: false,
      lift: false,
      lookBack: false,
    }
  }
  try {
    Object.defineProperty(game.input, 'autoAccelerate', { get: () => false, configurable: true })
  } catch { /* already plain */ }

  /**
   * RE-ARMED ON EVERY RACE THIS PAGE BUILDS, NOT JUST THE FIRST.
   *
   * A rejoin replaces the `Race` and the `LockstepRunner` (that is the point of
   * it), and it does so from inside `onResync` rather than through
   * `frontEnd.onMultiplayerStart` -- game/main.ts calls its own
   * `startMultiplayer` directly, because nothing else in the shipping code is
   * hooked on that seam. So the rig cannot hang everything off the front end's
   * callback: a pump holding the race it captured at lap one would step the old
   * world while the runner gated the new one, and the probe would report a
   * stall that nothing in the game had.
   */
  const arm = (packet) => {
    const race = game.race
    const transport = net.raceTransport()
    if (!race || !transport) { P.events.push('no race/transport after start'); return }

    P.localSlot = -1
    for (const s of packet.grid) if (s.playerId === packet.localPlayerId) P.localSlot = s.slot
    P.inputDelay = packet.inputDelay
    P.seed = packet.seed
    P.grid = packet.grid.map((s) => `${s.slot}:${s.playerId ?? 'ai'}`)
    P.events.push(`start slot=${P.localSlot} delay=${packet.inputDelay} seed=${packet.seed}`)

    // --- observation, wrapped round main.ts's own wiring ------------------
    //
    // Every one of these keeps the handler the game installed and calls it.
    // Replacing one would mean the probe photographs the probe.
    const live = transport.onRoundLive
    transport.onRoundLive = (playerId, frame) => {
      // BOTH FRAMES. The one it arrived on and the one it is FOR: the gap
      // between them is `REJOIN_LEAD_FRAMES` minus flight time, and a restore
      // honoured on arrival would show them equal on one client and not on
      // another. `isAI` either side is checked at the end of pass 2.
      P.restoreAt = { id: playerId, agreed: frame, arrived: game.race ? game.race.state.frame : -1 }
      P.events.push(`restore ${playerId} @${frame} (message arrived at ${P.restoreAt.arrived})`)
      live(playerId, frame)
    }
    const resync = transport.onResync
    transport.onResync = (resume) => {
      P.events.push(`resync to frame ${resume.frame} (${resume.rows.length} rows)`)
      // IDENTITY, BECAUSE THAT IS THE CLAIM. `RoundResume` requires the race to
      // be REBUILT and not reused, every time, even though this page is holding
      // a perfectly good one for this very round -- our own frames either side
      // of the AI handover were simulated with a person at the wheel where the
      // room had an AI, and no forward replay undoes that. Nothing about the
      // finished state can show whether that happened; the object can.
      const was = { race: game.race, net: game.net, frame: game.race ? game.race.state.frame : -1 }
      const t0 = performance.now()
      resync(resume)
      P.replayMs = Math.round(performance.now() - t0)
      P.resync = {
        rebuiltRace: game.race !== was.race,
        rebuiltRunner: game.net !== was.net,
        fromFrame: was.frame,
        reached: game.race ? game.race.state.frame : -1,
        wanted: resume.frame,
        ms: P.replayMs,
      }
      P.events.push(`rebuilt+replayed to ${P.resync.reached} in ${P.replayMs}ms`
        + ` (race rebuilt: ${P.resync.rebuiltRace ? 'yes' : 'NO'})`)
      if (P.resync.reached !== resume.frame) {
        P.events.push(`REPLAY SHORT: ${P.resync.reached} of ${resume.frame}`)
      }
      // The new race needs the same instruments the old one had, and the
      // hash log has to start again: everything this page recorded before the
      // rebuild came from frames it now agrees it simulated wrongly.
      arm(resume.packet)
    }
    const migrating = transport.onMigration
    transport.onMigration = (state) => {
      P.migrations.push(state ? {
        at: Math.round(performance.now()),
        newHostId: state.newHostId, isLocal: state.isLocal,
        remainingMs: Math.round(state.remainingMs),
        connected: state.connected, expected: state.expected,
      } : { at: Math.round(performance.now()), done: true })
      // DELEGATED, because this is what puts the line on the screen the probe
      // is about to photograph. An earlier pass replaced this handler and the
      // migration banner never appeared in any shot taken here.
      migrating(state)
    }
    const rehosted = transport.onHostChange
    transport.onHostChange = (hostId) => { P.events.push(`hostChange ${hostId}`); rehosted(hostId) }
    const drop = transport.onRoundDrop
    transport.onRoundDrop = (id, f) => { P.events.push(`drop ${id} @${f}`); drop(id, f) }

    const origStep = race.step.bind(race)
    P.hashes = []
    P.stalls = 0
    race.step = () => {
      origStep()
      if (race.state.frame % 30 === 0) P.hashes.push([race.state.frame, race.hash()])
    }

    // The renderer is parked 1.2s in and the sim is driven by a timer, for the
    // reasons tools/probe-netcode.mjs sets out at length: two software-rendered
    // racers in one Chromium manage under a frame a second between them, and a
    // lockstep race driven off that is a stall test nobody meant to run.
    setTimeout(() => {
      try { cancelAnimationFrame(window.__GAME__.raf) } catch { /* already gone */ }
      P.parked = true
    }, 1200)

    if (P.pump) clearInterval(P.pump)
    P.pump = setInterval(() => {
      try {
        // `game.race` EVERY TICK, NOT THE ONE CAPTURED ABOVE. A rejoin swaps
        // the object underneath this timer; a captured reference would go on
        // stepping the world the game has already thrown away.
        const r = game.race
        if (!r) return
        const local = game.input.sample()
        if (!game.net) { r.step(); return }
        if (!game.net.beforeStep(local)) { P.stalls++; return }
        r.step()
      } catch { /* torn down */ }
    }, 16)
  }

  const prev = game.frontEnd.onMultiplayerStart
  game.frontEnd.onMultiplayerStart = (packet) => { prev(packet); arm(packet) }
}

/** What a page knows about its own race and its own wire right now. */
const READ = () => {
  const P = window.__PROBE__
  const game = window.__GAME__
  const net = window.__NET__
  const lobby = net.liveLobby()
  const mesh = lobby ? lobby.mesh : null
  const t = net.raceTransport()
  return {
    frame: game.race ? game.race.state.frame : -1,
    hashes: P.hashes,
    events: P.events,
    migrations: P.migrations,
    stalls: P.stalls,
    verdict: game.net ? game.net.verdict : '-',
    waitingFor: game.net ? game.net.waitingFor : [],
    held: game.net ? game.net.held : false,
    isAuthority: game.net ? game.net.isAuthority : false,
    dropped: game.net ? game.net.everDropped : [],
    status: t ? t.status : '-',
    hostId: lobby && lobby.current() ? null : null,
    roomHost: (() => {
      const r = net.lobbyService().current()
      if (!r) return null
      const h = r.members.find((m) => m.isHost)
      return h ? h.playerId : null
    })(),
    members: (() => {
      const r = net.lobbyService().current()
      return r ? r.members.map((m) => `${m.name}${m.isHost ? '*' : ''}`) : []
    })(),
    peers: mesh ? mesh.peers.map((l) => ({
      id: l.peerId, state: l.state, failure: l.failure,
      connectMs: l.connectMs, pingMs: l.pingMs === null ? null : Math.round(l.pingMs),
      relay: l.relay, pair: l.candidatePair,
    })) : [],
    traffic: mesh ? mesh.traffic : null,
    worst: t ? t.worstPingMs : -1,
    localSlot: P.localSlot ?? -1,
    grid: P.grid ?? [],
    aiSlots: game.race ? game.race.state.racers.filter((r) => r.isAI).map((r) => r.id) : [],
    lastFailure: lobby ? lobby.lastFailure : null,
    closed: P.closed ?? null,
    // The two things a photograph cannot show. See the rig's header.
    resync: P.resync ?? null,
    restoreAt: P.restoreAt ?? null,
    // What the HUD would actually draw right now, through the shipping
    // projection rather than through a field the screen does not read.
    netLine: (() => {
      const el = document.querySelector('.sg-ctr__netText')
      return el ? el.textContent : null
    })(),
    migrationSeen: game.netMigration ?? null,
  }
}

/** Compare two hash tables frame by frame and report the FIRST disagreement. */
function compare(ha, hb, where) {
  const mb = new Map(hb)
  let compared = 0
  for (const [f, h] of ha) {
    const other = mb.get(f)
    if (other === undefined) continue
    compared++
    if (other !== h) {
      note(`${where}: the clients disagree from frame ${f} (${h} vs ${other})`)
      return { compared, agreed: false, at: f }
    }
  }
  return { compared, agreed: true }
}

/** Stand a room up and get it racing. Returns the contexts, host first. */
async function raceOf(labels, lobbyName) {
  const pages = []
  for (let i = 0; i < labels.length; i++) {
    const p = await open(labels[i])
    await p.page.evaluate(RIG, { seedTag: i + 1 })
    pages.push(p)
  }
  const [host, ...guests] = pages
  const lobbyId = await host.page.evaluate(async (name) => {
    const res = await window.__NET__.lobbyService().create({
      name, region: 'eu-west', maxPlayers: 8, private: false,
      // Enough laps that the 60Hz pump cannot finish the race inside the
      // probe: a finished race steps nothing, and nothing stepped is not
      // agreement.
      series: { length: 1, trackIds: ['rustfall'], laps: 9 },
    })
    return res.ok ? res.value.id : null
  }, lobbyName)
  if (!lobbyId) { note('the host could not create a lobby'); return null }

  for (const g of guests) {
    const joined = await g.page.evaluate(async (id) => {
      const res = await window.__NET__.lobbyService().join(id)
      return res.ok ? true : res.error
    }, lobbyId)
    if (joined !== true) note(`${g.label} could not join: ${joined}`)
  }
  const linked = await until(host.page, (n) => {
    const mesh = window.__NET__.liveLobby()?.mesh
    const open = mesh ? mesh.peers.filter((l) => l.state === 'open') : []
    return open.length >= n ? open.map((l) => ({ id: l.peerId, ms: l.connectMs })) : null
  }, guests.length, 25000)
  if (!linked) { note('the room never fully connected'); return null }
  say(`all ${guests.length} guests linked (${linked.map((l) => l.ms + 'ms').join(', ')})`)

  // READY ONLY ONCE THE LINK IS UP: the service refuses a ready from a member
  // who is still connecting, exactly as types.ts says it must.
  for (const g of guests) {
    await g.page.evaluate(async () => { await window.__NET__.lobbyService().setReady(true) })
  }
  await host.page.waitForTimeout(500)
  const started = await host.page.evaluate(async () => {
    const res = await window.__NET__.lobbyService().start()
    return res.ok ? { delay: res.value.inputDelay, seed: res.value.seed } : { error: res.error }
  })
  if (started.error) { note(`start refused: ${started.error}`); return null }
  say(`start: seed ${started.seed}, inputDelay ${started.delay} frames`)
  for (const p of pages) {
    await until(p.page, () => (window.__PROBE__.parked ? true : null), null, 60000, 300)
  }
  return { pages, host, guests, lobbyId, started }
}

const reach = async (page, frame, ms = 60000) => until(page, (f) => {
  const g = window.__GAME__
  return g.race && g.race.state.frame >= f ? g.race.state.frame : null
}, frame, ms, 200)

// ===========================================================================
// PASS 1 — the host closes its tab mid-race
// ===========================================================================

if (wants(1)) head('three browsers; the host closes its tab mid-race')
say('Three and not two, because two cannot prove an election: with one survivor')
say('any rule at all looks correct. With two, the rule has to pick, both have to')
say('pick the SAME one alone, and the loser has to find the winner through a')
say('polled mailbox with no link to anybody.')

const room = wants(1) ? await raceOf(['host', 'ada', 'kit'], 'Migration probe') : null
if (!room) {
  if (wants(1)) note('PASS 1 could not get a race going; everything below it is meaningless')
} else {
  const [A, B, C] = room.pages
  await shoot(A.page, 'three-racing-host')
  await shoot(B.page, 'three-racing-ada')

  const got = await reach(A.page, 420)
  if (!got) note('the race never reached frame 420')
  const before = await A.page.evaluate(READ)
  say(`grid: ${before.grid.join(' ')}`)
  say(`before the kill: frame ${before.frame}, host authority ${before.isAuthority}`)
  say(`worst path ${before.worst}ms; peers `
    + JSON.stringify(before.peers.map((p) => `${p.id}:${p.pingMs}ms:${p.pair ?? 'direct'}`)))

  // BANDWIDTH, MEASURED HERE AND NOT AFTER, because a migration rebuilds the
  // mesh and the per-link counters go with it. This is a three-player room, so
  // the host is relaying two guests' inputs to each other.
  const tr = before.traffic
  say(`payload over ${before.frame} frames: host out ${tr.out}B in ${tr.in}B `
    + `(${tr.msgsOut} sent / ${tr.msgsIn} taken), ${(tr.out / Math.max(1, tr.msgsOut)).toFixed(0)}B per message`)
  say(`= ${(tr.out / Math.max(1, before.frame) * 60 / 1024).toFixed(1)} KB/s host upload at 60Hz `
    + 'with two guests')
  await writeFile(join(OUT, 'traffic.json'), JSON.stringify({
    frames: before.frame, players: 3, host: tr,
    bytesPerMessage: tr.out / Math.max(1, tr.msgsOut),
    hostUpBytesPerFrame: tr.out / Math.max(1, before.frame),
  }, null, 2))

  const bFrames = (await B.page.evaluate(READ)).frame
  const cFrames = (await C.page.evaluate(READ)).frame
  say(`survivor frames at the moment of the kill: ada ${bFrames}, kit ${cFrames} `
    + `(spread ${Math.abs(bFrames - cFrames)}; the bound is inputDelay + 1 = `
    + `${room.started.delay + 1})`)

  const tKill = Date.now()
  say('closing the host\'s browser context outright')
  await A.ctx.close()

  /**
   * THE ORDINARY STALL, WHICH THIS IS THE ONLY CHANCE TO PHOTOGRAPH.
   *
   * For the seconds between the host's tab closing and the room deciding it
   * has gone, this is a plain lockstep stall: the runner is waiting on a slot
   * whose inputs stopped, the migration has not started, and the stall grammar
   * is what the HUD draws. That window is also the only place a LIVE stall line
   * can be read at all -- tools/probe-series.mjs pushes hand-made ones into the
   * HUD, which cannot catch this.
   *
   * What it is checked for is a NAME. `LockstepRunner` is built with a slot ->
   * player id map (that is what `announceDrop` needs) and fills `waitingFor`
   * from it, so without game/main.ts resolving them the banner offers to wait
   * for a minted account id with a device salt glued on the end.
   */
  await B.page.waitForTimeout(600)
  await paintOnce(B.page)
  const stalled = await B.page.evaluate(READ)
  if (stalled.waitingFor.length > 0 && stalled.netLine) {
    say(`the ordinary stall, before the room notices: ${JSON.stringify(stalled.netLine)} `
      + `(the runner is holding ${JSON.stringify(stalled.waitingFor)})`)
    const rawId = String(stalled.waitingFor[0]).toUpperCase()
    if (stalled.netLine.includes(rawId) && /-\d/.test(rawId)) {
      note(`the stall banner is offering to wait for "${rawId}", which is a player id `
        + 'and not a name — nobody in the room is called that')
    }
  }

  // --- the wait, which is the bit the player looks at ----------------------
  const noticed = await until(B.page, () => {
    const t = window.__NET__.raceTransport()
    return t && t.status === 'migrating' ? Math.round(performance.now()) : null
  }, null, 20000, 50)
  if (!noticed) note('ada never noticed the host had gone')
  else say(`ada noticed the host was gone ${Date.now() - tKill}ms after the tab closed`)

  // A beat, so the sim pump has run at least one frame under the hold and the
  // line on screen is the migration's rather than the stall it interrupted.
  await B.page.waitForTimeout(400)
  // PAINTED FIRST, ON PURPOSE. The rig parks the render loop and the net line
  // is written by `netFrame` from inside it, so the DOM says what a player
  // would actually be looking at only after a frame has been drawn.
  await paintOnce(B.page)
  const mid = await B.page.evaluate(READ)
  say(`status "${mid.status}", held ${mid.held}`)
  say(`the line on screen: ${JSON.stringify(mid.netLine)}`)
  if (!mid.netLine) {
    note('the paused race says nothing at all — the player is looking at a frozen '
      + 'track with no sentence on it, which is the outcome the whole stall policy '
      + 'exists to prevent')
  } else {
    // THE THREE THINGS THE LINE HAS TO CARRY. tests/series.test.ts pins the
    // exact grammar; what this checks is that the sentence on the glass came
    // from the MIGRATION and not from the stall it interrupted -- the old
    // stopgap routed a hold line through `waitingFor`, which is documented as
    // the peers we are blocked on, and during a repair those are players who
    // are perfectly fine.
    if (!/\d+S\b/.test(mid.netLine)) {
      note('the migration line has no clock on it — a thirty-second wait with no '
        + 'number is indistinguishable from a hang')
    }
    if (!/LEFT/.test(mid.netLine)) {
      note(`the line reads "${mid.netLine}" and never says anybody left, so the one `
        + 'thing that has actually happened is missing from it')
    }
    if (/WAITING FOR/.test(mid.netLine)) {
      note(`the line reads "${mid.netLine}" — that is the stall grammar, which means `
        + 'the migration state never reached the HUD and the stopgap is still what '
        + 'is being drawn')
    }
  }
  if (mid.migrationSeen == null) {
    note('game/main.ts is holding no migration state, so the line above cannot be '
      + 'the repair\'s however it reads')
  } else {
    say(`main.ts resolved: previousHost "${mid.migrationSeen.previousHostName}" `
      + `newHost "${mid.migrationSeen.newHostName}" isLocal ${mid.migrationSeen.isLocal}`)
  }
  if (mid.migrations.length === 0) {
    note('no migration state was published at all — the HUD would have nothing '
      + 'to draw and the player would be looking at a frozen race with no clock')
  } else {
    const m = mid.migrations[mid.migrations.length - 1]
    say(`migration state: newHost ${m.newHostId} isLocal ${m.isLocal} `
      + `remaining ${m.remainingMs}ms connected ${m.connected}/${m.expected}`)
    if (m.remainingMs <= 0 || m.remainingMs > 30000) {
      note(`the countdown is nonsense (${m.remainingMs}ms of a 30000ms budget)`)
    }
  }
  await shoot(B.page, 'ada-during-migration')
  await paintOnce(C.page)
  await shoot(C.page, 'kit-during-migration')
  // AND AGAIN A FEW SECONDS LATER, because the claim being made is that the
  // wait has a CLOCK on it. One photograph of a number proves a number; two
  // with different numbers prove a countdown. Read off the DOM rather than off
  // any field, because a number that ticks in a state object and not on the
  // glass is exactly the bug this is looking for.
  const line1 = mid.netLine
  await B.page.waitForTimeout(3000)
  await paintOnce(B.page)
  const line2 = (await B.page.evaluate(READ)).netLine
  say(`the line on screen: "${line1}" -> "${line2}"`)
  if (line1 && line1 === line2) {
    note('the countdown did not move in three seconds — a clock that does not '
      + 'tick is worse than no clock')
  }
  // A SECOND PHOTOGRAPH OF THE SAME WAIT, three seconds in, so the pair can be
  // put side by side. The claim is a countdown; one still frame cannot show one.
  await shoot(B.page, 'ada-during-migration-3s')

  // --- did it work? --------------------------------------------------------
  // THE END OF A MIGRATION IS A MIGRATION STATE OF NULL, not a status of 'up'
  // -- which is also the state it STARTS in, so a probe that waited for that
  // would measure nothing and report success. (It did, on the run before this.)
  const done = (page) => until(page, () => {
    const P = window.__PROBE__
    const last = P.migrations[P.migrations.length - 1]
    return last && last.done ? Math.round(performance.now()) : null
  }, null, 45000, 100)
  const backB = await done(B.page)
  const backC = await done(C.page)
  const tBack = Date.now()
  if (!backB || !backC) {
    note('a survivor never came out of migration')
    for (const [who, pg] of [['ada', B.page], ['kit', C.page]]) {
      const d = await pg.evaluate(READ)
      note(`  ${who}: status ${d.status} held ${d.held} frame ${d.frame} `
        + `peers ${JSON.stringify(d.peers.map((x) => `${x.id}:${x.state}:${x.failure ?? '-'}`))}`)
      note(`  ${who}: events ${d.events.join(' | ')}`)
      note(`  ${who}: last migration ${JSON.stringify(d.migrations[d.migrations.length - 1])}`)
    }
  } else say(`MIGRATION COMPLETE in ${tBack - tKill}ms end to end (kill -> both racing)`)

  const b1 = await B.page.evaluate(READ)
  const c1 = await C.page.evaluate(READ)
  say(`elected: ada isAuthority ${b1.isAuthority}, kit isAuthority ${c1.isAuthority}`)
  if (b1.isAuthority === c1.isAuthority) {
    note(`both survivors think they are ${b1.isAuthority ? 'the host' : 'a guest'} `
      + '— the election did not agree')
  }
  say(`ada room host ${b1.roomHost}, kit room host ${c1.roomHost}`)
  if (b1.roomHost !== c1.roomHost) {
    note(`the two survivors point at different hosts (${b1.roomHost} vs ${c1.roomHost})`)
  }
  say(`ada events: ${b1.events.slice(-4).join(' | ')}`)
  /**
   * COMPARE THE AGREED HANDOVER LISTS, NOT THE INSTANTANEOUS `isAI` FLAGS.
   *
   * `isAI` is re-derived every step from the frame about to run, so two
   * clients a few frames apart legitimately disagree about it at any given
   * instant -- and they SHOULD, because that is the mechanism working: each
   * flips on the same frame number, not at the same moment. The thing that
   * has to be identical is the list of frames. Comparing the flags reported a
   * problem on a run whose hashes agreed at all thirty checkpoints, which is
   * a check that cries wolf about the one property it was meant to defend.
   */
  const HANDS = () => {
    const n = window.__GAME__.net
    if (!n) return null
    const out = {}
    for (let s = 0; s < 8; s++) {
      const h = [...n.scheduler.handover(s)]
      if (h.length > 0) out[s] = h
    }
    return out
  }
  const bHand = await B.page.evaluate(HANDS)
  const cHand = await C.page.evaluate(HANDS)
  say(`agreed handovers: ada ${JSON.stringify(bHand)} / kit ${JSON.stringify(cHand)}`)
  if (JSON.stringify(bHand) !== JSON.stringify(cHand)) {
    note('the survivors hold different handover lists, which is a desync by '
      + 'construction: stepAI draws from the racer rng and two clients flipping on '
      + 'different frames make a different number of draws')
  }
  if (!bHand || !bHand['0']) {
    note('the dead host\'s slot was never handed to the AI, so its car is frozen '
      + 'on the track and every client is waiting for an input it will never get')
  }

  // --- and does the race still agree? --------------------------------------
  const target = Math.max(b1.frame, c1.frame) + 420
  say(`racing on to frame ${target}...`)
  await reach(B.page, target)
  await B.page.waitForTimeout(1200)
  const b2 = await B.page.evaluate(READ)
  const c2 = await C.page.evaluate(READ)
  say(`after: ada frame ${b2.frame} (${b2.stalls} stalled ticks), `
    + `kit frame ${c2.frame} (${c2.stalls})`)
  const cmp = compare(b2.hashes, c2.hashes, 'after the migration')
  if (cmp.compared < 8) note(`only ${cmp.compared} checkpoints were comparable`)
  else if (cmp.agreed) {
    say(`AGREED on all ${cmp.compared} compared checkpoints, across the migration `
      + `and up to frame ${Math.min(b2.frame, c2.frame)}`)
  }
  if (b2.verdict === 'desync' || c2.verdict === 'desync') {
    note(`a survivor called a desync after the migration (ada ${b2.verdict}, kit ${c2.verdict})`)
  }
  await paintOnce(B.page)
  await shoot(B.page, 'ada-racing-as-host')

  // --- the directory row ---------------------------------------------------
  // THE RACE DID NOT WAIT FOR THIS and neither did the measurement above. The
  // endpoint refuses a claim until the old host has been quiet for
  // HOST_CLAIM_AFTER_MS, because it cannot tell a dead host from a slow one.
  // What the claim buys is the lobby not vanishing from the browser mid-race.
  say('advancing the endpoint\'s clock past the claim window...')
  clockSkew += 20_000
  const claimed = await until(B.page, async () => {
    const res = await window.__NET__.lobbyService().list()
    if (!res.ok || res.value.length === 0) return null
    return res.value[0].hostName
  }, null, 25000, 1000)
  if (!claimed) {
    note('the lobby row disappeared from the browser after the host left — '
      + 'a race that is still running is not in the directory')
  } else {
    say(`the directory row is back, hosted by "${claimed}"`)
    if (claimed === 'host') note('the row still names the dead host')
  }

  for (const p of [B, C]) await p.ctx.close()
}

// ===========================================================================
// PASS 2 — a guest drops and comes back
// ===========================================================================

if (wants(2)) head('a guest loses its link and takes its slot back')
say('The symmetry is the requirement: a drop is agreed on a frame so every client')
say('makes the same number of stepAI draws, and a rejoin has exactly the same')
say('requirement in reverse. Get it wrong by one and the rejoin causes a desync.')

const room2 = wants(2) ? await raceOf(['host2', 'ada2'], 'Rejoin probe') : null
if (!room2) {
  if (wants(2)) note('PASS 2 could not get a race going')
} else {
  const [H, G] = room2.pages
  if (!await reach(H.page, 300)) note('the rejoin race never got going')

  /**
   * THE LINK IS CUT AT THE MESH, NOT AT THE TAB.
   *
   * Closing the context would take the page with it and there would be nothing
   * left to rejoin WITH. What a wifi blip actually does is kill the transport
   * and leave the page standing, so that is what is done: the guest's peer
   * connection is closed from underneath it and the host sees a dead wire.
   */
  const cutAt = (await G.page.evaluate(READ)).frame
  say(`cutting the guest's link at frame ${cutAt}`)
  await G.page.evaluate(() => {
    const mesh = window.__NET__.liveLobby().mesh
    for (const l of mesh.peers) l.close('lost')
  })

  const watch = async (label) => {
    const g = await G.page.evaluate(READ)
    const h = await H.page.evaluate(READ)
    say(`  [${label}] guest frame ${g.frame} status ${g.status} held ${g.held} `
      + `verdict ${g.verdict} auth ${g.isAuthority} | host frame ${h.frame}`)
  }
  const dropped = await until(H.page, () => {
    const n = window.__GAME__.net
    return n && n.everDropped.length > 0 ? n.everDropped : null
  }, null, 20000)
  await watch('dropped')
  const hMid = await H.page.evaluate(READ)
  if (!dropped) note('the host never dropped a guest whose link had gone')
  else {
    say(`host handed slot(s) ${JSON.stringify(dropped)} to the AI after `
      + `${hMid.frame - cutAt} frames`)
    say(`host events: ${hMid.events.filter((e) => e.startsWith('drop')).join(' | ')}`)
  }
  await reach(H.page, hMid.frame + 240)
  const hRun = await H.page.evaluate(READ)
  say(`the race kept running without them: ${hMid.frame} -> ${hRun.frame}`)
  await paintOnce(G.page)
  await shoot(G.page, 'guest-cut-off')

  // --- back ----------------------------------------------------------------
  await watch('before rejoin')
  const tRejoin = Date.now()
  const res = await G.page.evaluate(async () => {
    const t = window.__NET__.raceTransport()
    const r = await t.rejoin()
    return r.ok ? 'ok' : r.error
  })
  say(`rejoin() returned "${res}" after ${Date.now() - tRejoin}ms`)
  if (res !== 'ok') note(`the rejoin was refused: ${res}`)

  await watch('after rejoin')
  const live = await until(G.page, () => {
    const P = window.__PROBE__
    const e = P.events.find((x) => x.startsWith('restore '))
    return e ?? null
  }, null, 30000)
  if (!live) note('the guest was never given its slot back')
  else say(`the room gave the slot back: ${live}`)

  const g1 = await G.page.evaluate(READ)
  const replayed = g1.events.find((e) => e.startsWith('rebuilt+replayed to'))
  say(`catch-up: ${replayed ?? 'never replayed'}`)
  if (g1.events.some((e) => e.startsWith('REPLAY SHORT'))) {
    note('the replay did not reach the frame the tape claimed — the returning '
      + 'client would be racing a different race from the room')
  }

  // The frame out of the event line, by pattern rather than by splitting on
  // '@': the line also records the frame the message ARRIVED on, and a parser
  // that took everything after the marker turned the number into NaN and then
  // raced on to `NaN + 300`, which `reach` reads as "as far as you like".
  const liveFrom = live ? Number((/@(\d+)/.exec(live) ?? [])[1] ?? 0) : 0
  say(`racing on past the restore frame (${liveFrom})...`)
  await reach(H.page, liveFrom + 300, 60000)
  await H.page.waitForTimeout(1200)
  const h2 = await H.page.evaluate(READ)
  const g2 = await G.page.evaluate(READ)
  say(`host frame ${h2.frame} verdict ${h2.verdict}; guest frame ${g2.frame} verdict ${g2.verdict}`)
  // WHEN IT DISAGREES, SAY WHAT ABOUT. A hash mismatch with no detail is a
  // bug report with nothing in it; the handover lists and the cells either
  // side of the drop are the two things that can differ.
  const hDump = await H.page.evaluate((r) => {
    const n = window.__GAME__.net
    if (!n) return null
    const out = { hand: {}, cells: {} }
    for (const slot of [0, 1]) {
      out.hand[slot] = [...n.scheduler.handover(slot)]
      const row = []
      for (let f = r[0]; f <= r[1]; f++) row.push(n.scheduler.inputAt(slot, f) ?? null)
      out.cells[slot] = row
    }
    return out
  }, [cutAt - 2, cutAt + 8])
  const gDump = await G.page.evaluate((r) => {
    const n = window.__GAME__.net
    if (!n) return null
    const out = { hand: {}, cells: {} }
    for (const slot of [0, 1]) {
      out.hand[slot] = [...n.scheduler.handover(slot)]
      const row = []
      for (let f = r[0]; f <= r[1]; f++) row.push(n.scheduler.inputAt(slot, f) ?? null)
      out.cells[slot] = row
    }
    return out
  }, [cutAt - 2, cutAt + 8])
  say(`handovers: host ${JSON.stringify(hDump?.hand)} guest ${JSON.stringify(gDump?.hand)}`)
  if (JSON.stringify(hDump?.hand) !== JSON.stringify(gDump?.hand)) {
    note('the two clients hold different handover lists, which is a divergence by '
      + 'construction: stepAI is called a different number of times on each')
  }
  say(`cells ${cutAt - 2}..${cutAt + 8}: host ${JSON.stringify(hDump?.cells)}`)
  say(`                                  guest ${JSON.stringify(gDump?.cells)}`)
  const cmp2 = compare(h2.hashes, g2.hashes, 'across a drop and a rejoin')
  if (cmp2.compared < 8) note(`only ${cmp2.compared} checkpoints were comparable after the rejoin`)
  else if (cmp2.agreed) {
    say(`AGREED on all ${cmp2.compared} compared checkpoints, across both handovers`)
  }
  if (h2.verdict === 'desync' || g2.verdict === 'desync') {
    note('a rejoin caused a desync, which is the exact failure the agreed frame exists to prevent')
  }
  // PAST THE RESTORE FRAME BEFORE LOOKING. A car that is still AI three
  // hundred frames before its handover is a car behaving correctly.
  if (liveFrom) await reach(G.page, liveFrom + 60, 60000)
  const drivenAgain = await G.page.evaluate((slot) => {
    const r = window.__GAME__.race
    const car = r && r.state.racers[slot]
    return car ? { isAI: car.isAI, speed: Math.hypot(car.vel.x, car.vel.z) } : null
  }, g2.localSlot)
  say(`the returning player's car: ${JSON.stringify(drivenAgain)}`)
  if (drivenAgain && drivenAgain.isAI) note('the returning player\'s car is still marked AI')

  // --- the two things the screenshot below cannot show ----------------------
  say('')
  say('--- what a photograph of the rejoin cannot show ---')
  const sync = g2.resync
  if (!sync) {
    note('game/main.ts never handled onResync — the returning client rebuilt nothing')
  } else {
    say(`resync: rebuilt race ${sync.rebuiltRace}, rebuilt runner ${sync.rebuiltRunner}, `
      + `frame ${sync.fromFrame} -> ${sync.reached} (wanted ${sync.wanted}) in ${sync.ms}ms`)
    // THE CLAIM `RoundResume` MAKES. A returning client must throw away the
    // `Race` it is holding and build a new one from the packet EVERY time,
    // because its own frames either side of the handover were simulated with a
    // person at the wheel where the room ran an AI. Reusing would look fine
    // here and come apart at a checkpoint two corners later, which is why this
    // is asserted on object identity rather than on the outcome.
    if (!sync.rebuiltRace) {
      note('the resync REUSED the race it already had. RoundResume requires a rebuild '
        + 'every time: this client stepped frames past its own handover with a person '
        + 'at the wheel, and no forward replay undoes them')
    }
    if (!sync.rebuiltRunner) note('the resync kept the old lockstep runner')
    if (sync.reached !== sync.wanted) {
      note(`the replay reached ${sync.reached} of ${sync.wanted}`)
    }
  }
  const rest = g2.restoreAt
  if (!rest) {
    note('the returning client was never told its slot was a person again')
  } else {
    say(`restore: agreed frame ${rest.agreed}, message arrived at frame ${rest.arrived}`)
    // AGREED AHEAD, APPLIED THERE. `REJOIN_LEAD_FRAMES` exists so the restore
    // frame is in everybody's future when it is announced -- including the
    // returning client's own. Honouring one on ARRIVAL would put the AI/person
    // switch on a different frame on every client, each of them making a
    // different number of stepAI draws, which is the desync the agreed frame
    // exists to prevent. The hash comparison above is what proves it did not
    // happen; this is what says why if it did.
    if (rest.arrived >= 0 && rest.agreed <= rest.arrived) {
      note(`the restore frame ${rest.agreed} was not ahead of the frame it arrived on `
        + `(${rest.arrived}) — there was nothing stopping this client applying it early`)
    }
  }
  await paintOnce(G.page)
  await shoot(G.page, 'guest-back-in')

  say(`host events: ${h2.events.slice(-4).join(' | ')}`)
  say(`guest events: ${g2.events.slice(-5).join(' | ')}`)

  for (const p of [H, G]) await p.ctx.close()
}

// ===========================================================================
// PASS 3 — a migration that fails
// ===========================================================================

if (wants(3)) head('a migration that fails, and what the player is told')
say('The host goes, and so does the survivor the election picks. The last client')
say('standing has nobody to migrate to. What it must NOT do is sit on a spinner;')
say('what it must do is run the budget out and say something specific.')

const room3 = wants(3) ? await raceOf(['host3', 'ada3', 'kit3'], 'Doomed probe') : null
if (!room3) {
  if (wants(3)) note('PASS 3 could not get a race going')
} else {
  const [A3, B3, C3] = room3.pages
  await reach(A3.page, 300)
  const grid = (await A3.page.evaluate(READ)).grid
  say(`grid: ${grid.join(' ')}`)

  await C3.page.evaluate(() => {
    const svc = window.__NET__.lobbyService()
    window.__PROBE__.closed = null
    // CHAINED, NOT REPLACED. ui/lobby.ts owns this callback and is what puts
    // the player back on a screen with a sentence on it; a probe that steals
    // it photographs a frozen track and concludes the UI does nothing.
    const prev = svc.onClosed.bind(svc)
    svc.onClosed = (reason, detail) => {
      window.__PROBE__.closed = { reason, detail }
      try { prev(reason, detail) } catch (e) { window.__PROBE__.events.push('onClosed threw: ' + e) }
    }
  })

  // The election is the lowest surviving grid slot, which is slot 1 -- the
  // first guest to have joined. Killing the host AND slot 1 leaves slot 2
  // dialling somebody who is not there.
  say('closing the host AND the guest the election will pick, at the same moment')
  const tFail = Date.now()
  await Promise.all([A3.ctx.close(), B3.ctx.close()])

  /**
   * DETECTION IS MEASURED SEPARATELY FROM THE BUDGET, because they are
   * different numbers and only one of them is a design choice.
   *
   * Closing a browser context is a HARD kill: the renderer goes and nothing
   * says goodbye, so the surviving peer does not get a channel close. It finds
   * out the way a player whose laptop lid shuts would be found out -- ICE
   * stops hearing from the far end and `SILENCE_MS` elapses with not even a
   * ping arriving. That takes seconds, and it is on top of the thirty the
   * budget allows.
   */
  const noticed3 = await until(C3.page, () => {
    const t = window.__NET__.raceTransport()
    return t && t.status === 'migrating' ? Math.round(performance.now()) : null
  }, null, 25000, 100)
  const tNoticed = Date.now()
  if (!noticed3) note('kit never noticed the host had gone')
  else say(`kit noticed ${tNoticed - tFail}ms after both tabs closed`)
  const f1 = await C3.page.evaluate(READ)
  say(`status "${f1.status}", ${f1.migrations.length} migration updates published`)
  if (f1.migrations.length > 0) {
    const m = f1.migrations[f1.migrations.length - 1]
    say(`  waiting for ${m.newHostId}, ${m.remainingMs}ms left of the budget`)
    if (m.remainingMs <= 0) note('the countdown was already at zero 2.5s in')
  }
  await paintOnce(C3.page)
  await shoot(C3.page, 'kit-waiting-in-vain')

  const failed = await until(C3.page, () => window.__PROBE__.closed ?? null, null, 45000, 500)
  const took = Date.now() - tFail
  if (!failed) {
    note('the budget expired and the race never ended — the player is on a spinner, '
      + 'which is the single outcome this whole feature exists to avoid')
  } else {
    say(`the race ended after ${took}ms (budget is 30000ms)`)
    say(`reason "${failed.reason}"`)
    say(`what the player is told: "${failed.detail}"`)
    if (!failed.detail || failed.detail.length < 30) {
      note('the failure has no sentence attached, only a code')
    }
    if (failed.detail && !/ada|kit|host/i.test(failed.detail)) {
      note('the failure does not name who could not be reached, which is the one '
        + 'thing that tells the player whether to blame their own connection')
    }
    const budgeted = took - (tNoticed - tFail)
    say(`of which ${budgeted}ms was the budget itself (MIGRATION_BUDGET_MS is 30000)`)
    if (Math.abs(budgeted - 30000) > 4000) {
      note(`the budget was not honoured: ${budgeted}ms of waiting against 30000`)
    }
  }
  const f2 = await C3.page.evaluate(READ)
  say(`last events: ${f2.events.slice(-3).join(' | ')}`)
  // Let the UI act on the close, and draw one real frame of whatever it put up.
  await C3.page.waitForTimeout(1200)
  await paintOnce(C3.page)
  await C3.page.waitForTimeout(400)
  await shoot(C3.page, 'kit-race-over')
  const where = await C3.page.evaluate(() => ({
    screen: window.__GAME__.frontEnd.screen ?? '-',
    phase: window.__GAME__.phase,
    hasRace: !!window.__GAME__.race,
  }))
  say(`where the player ends up: ${JSON.stringify(where)}`)
  await C3.ctx.close()
}

// ===========================================================================

head('summary')
say(`${signalCalls} signalling requests across the whole session`)
say('shots in shots/migrate/')
await writeFile(join(OUT, 'report.json'), JSON.stringify({ signalCalls, errors }, null, 2))

if (errors.length === 0) console.log('\nOK — nothing to report\n')
else {
  console.log(`\n${errors.length} PROBLEM(S):`)
  for (const e of errors) console.log('  - ' + e)
  console.log('')
}

if (!KEEP) {
  await browser.close()
  server.close()
}
process.exit(errors.length === 0 ? 0 : 1)
