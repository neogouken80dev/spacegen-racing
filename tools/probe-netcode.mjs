/**
 * TWO BROWSERS, RACING EACH OTHER, OVER REAL WebRTC — and the four ways it
 * goes wrong, each one driven for real.
 * ---------------------------------------------------------------------------
 * Every other probe in this directory photographs one browser. This one opens
 * TWO Chromium contexts, stands up the REAL signalling handler out of
 * src/net/signalProtocol.ts over a local http server, has one context create a
 * lobby and the other join it, opens a genuine RTCPeerConnection and data
 * channel between them, starts a race from one broadcast packet, and then
 * drives both sims in deterministic lockstep off inputs that actually travel
 * over that channel.
 *
 * ===========================================================================
 * WHAT IT PROVES, AND WHY EACH ONE NEEDS A BROWSER
 *
 *   1. A CONNECTION HAPPENS AT ALL, and how long it takes. Measured from
 *      `PeerLink.startedAt` to the data channel's `open`.
 *
 *   2. THE TWO CLIENTS AGREE, BYTE FOR BYTE. Each client drives with a
 *      DIFFERENT scripted stick, so the only way both can compute the same
 *      eight-car race is if the inputs really crossed the wire. The
 *      determinism hash is compared at every checkpoint AND by the shipped
 *      desync detector, which is the same evidence the game would use.
 *
 *   3. A PEER THAT STALLS does not break the race. The guest's `sendInput` is
 *      cut for a chosen number of milliseconds and the host is checked for:
 *      the sim standing still, a NAMED player on the waiting list, and -- when
 *      the tap is turned back on -- both clients resuming in agreement.
 *
 *   4. A PEER THAT DROPS is handed to the AI on an AGREED FRAME. The guest's
 *      page is closed mid-race; the host must keep running, must announce a
 *      frame, and the dropped car must keep driving.
 *
 *   5. A DESYNC IS CAUGHT. One car's position is nudged by a metre on ONE
 *      client -- a real divergence, not a faked hash -- and the round must
 *      halt on both within `HASH_EVERY` frames.
 *
 *   6. A CONNECTION THAT NEVER COMPLETES produces a SENTENCE, not a spinner.
 *      A guest joins a lobby whose host has gone away; the link must fail with
 *      a named reason inside the connect timeout and the room must close with
 *      one.
 *
 * ===========================================================================
 * WHAT IT CANNOT PROVE, SAID UP FRONT
 *
 * TWO CONTEXTS IN ONE CHROMIUM SHARE A MACHINE, A LOOPBACK AND A NAT. They
 * connect over HOST candidates in single-digit milliseconds with no loss and
 * no reordering, and they will do that on any machine and in any CI for ever.
 * So this probe cannot measure NAT traversal, real jitter or real packet loss,
 * and it does not claim to. What it does instead is PUT THE DISTANCE BACK: the
 * second pass runs with `Shape` -- an added one-way delay, jitter, and a loss
 * rate modelled as the retransmit-and-head-of-line-block that a reliable
 * ordered data channel actually suffers -- and measures the stall behaviour
 * against it. `--shape` reports both passes.
 *
 * The number that decides whether `live` should be the default is the fraction
 * of real players who cannot traverse NAT at all, and that number cannot be
 * obtained from this machine at any price.
 *
 * ===========================================================================
 * NEEDS dist/, AND NEEDS tsx.
 *
 *   npx vite build && npx tsx tools/probe-netcode.mjs [--shape] [--keep]
 *
 * `npx vite build` FIRST, ALWAYS: the server below serves the built site, so a
 * run against a stale bundle photographs the last commit -- which has cost
 * this project real time more than once.
 *
 * `tsx` rather than plain node because this is the one probe that mounts a
 * server-side module: it imports `handleSignal` from src/ so the two browsers
 * negotiate through the PRODUCTION handler rather than through a stub written
 * to agree with them. A stub cannot fail the way the endpoint fails, which
 * makes it the one thing not worth testing against.
 */
/*
 * RUN IT WITH tsx, NOT node:  npx tsx tools/probe-netcode.mjs
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

const SHAPE = process.argv.includes('--shape')
const KEEP = process.argv.includes('--keep')

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

/** Blobs, in a Map. The same three methods the Netlify adapter provides. */
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
 * THE ACCOUNT ENDPOINT, FOR REAL, BECAUSE `live` MEANS LIVE EVERYTHING.
 *
 * net/index.ts resolves a peer's identity through `accountService().load()`
 * before a lobby can be created, so a harness with no `/api/account` is one in
 * which every page opens by minting an offline profile and logging a 404 that
 * reads exactly like a fault in the bundle -- which is the thing the named 404
 * line at the bottom of this server exists to stop happening. `handleAccount`
 * takes its store, its clock and its token source as arguments precisely so it
 * can be stood up next to the signalling handler, which is what happens here.
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
        ? await handleSignal(store, parsed, Date.now(), newId)
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
        ? await handleAccount(acctStore, parsed, Date.now(), newToken)
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
    // NAMED, because an anonymous 404 from the probe's own file server sent a
    // previous debugging session looking for a bug in the bundle.
    console.log(`  !! server 404 ${req.url}: ${e && e.code ? e.code : e}`)
    res.writeHead(404)
    res.end('nf')
  }
})
await new Promise((r) => server.listen(0, r))
const base = `http://127.0.0.1:${server.address().port}/`

const OUT = new URL('../shots/netcode/', import.meta.url).pathname
await mkdir(OUT, { recursive: true })
for (const f of await readdir(OUT)) if (f.endsWith('.png')) await unlink(join(OUT, f))

// ---------------------------------------------------------------------------
// Browsers
// ---------------------------------------------------------------------------

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox', '--no-sandbox', '--ignore-gpu-blocklist',
    // Two contexts in one process still get two independent ICE agents; this
    // only stops Chromium hiding host candidates behind its mDNS obfuscation,
    // which would otherwise make a loopback connection take the STUN path to
    // a STUN server this machine cannot reach.
    '--disable-features=WebRtcHideLocalIpsWithMdns',
    // A backgrounded context throttles rAF to 1Hz, and a lockstep race in
    // which one side is running at 1Hz is a stall test the probe did not mean
    // to run. This is the whole reason two contexts can be driven at once.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
})

let shotN = 0
/**
 * Draw ONE frame and park again.
 *
 * Once the renderer is parked the page keeps showing whatever was last
 * painted, so every later screenshot would be the same picture of the
 * countdown -- three identical files with three different names, which is
 * exactly the kind of artefact that gets reviewed as evidence of something it
 * does not show. `Game.loop` re-arms its own rAF at the top, so it is run once
 * by hand and then cancelled again.
 */
async function paintOnce(page) {
  await page.evaluate(() => {
    if (!window.__PROBE__?.parked) return
    window.__GAME__.loop(performance.now())
    cancelAnimationFrame(window.__GAME__.raf)
  }).catch(() => {})
}

async function shoot(page, label) {
  const name = `${String(++shotN).padStart(2, '0')}-${label}.png`
  // A page whose main thread is blocked by a software rasteriser cannot answer
  // a screenshot request, and a probe that dies on a missing picture has
  // thrown away the measurements it already took.
  try {
    await page.screenshot({ path: join(OUT, name), timeout: 20000 })
    say(`shot ${name}`)
  } catch {
    note(`could not photograph ${label} — the page did not respond in time`)
  }
  return name
}

/**
 * A page on `?net=live`, pointed at this probe's own signalling server.
 *
 * `configureLive` has to land BEFORE anything calls `lobbyService()`, which
 * ui/lobby.ts does lazily when the lobby screen is first entered -- so it goes
 * in right after `__NET__` exists and long before any navigation.
 */
let peerN = 0
async function open(label, { shape = null, connectTimeoutMs = 0 } = {}) {
  // SMALL, BECAUSE THERE ARE TWO OF THEM AND THE GPU IS SWIFTSHADER. Two
  // full-size 3D racers rendering in software in one Chromium measured 0.7
  // frames per second between them, which is not a netcode measurement.
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
  await page.evaluate(([endpoint, sh, cto, pid, label2]) => {
    window.__NET__.configureLive({
      endpoint,
      // EXPLICIT IDENTITIES. net/index.ts salts the mock's account id per
      // device so two real browsers cannot collide, but a probe wants ids it
      // can read in a log, and it wants them to be the probe's own business
      // rather than a property of whatever the account service happens to do
      // this week.
      playerId: pid,
      playerName: label2,
      avatarId: 'cadet',
      // NO STUN. Two contexts on one loopback reach each other on host
      // candidates alone, and pointing at a public STUN server this machine
      // cannot reach would add the full gathering timeout to every connection
      // and measure the sandbox's egress policy instead of the netcode.
      iceServers: [],
      ...(sh ? { shape: sh } : {}),
      ...(cto ? { connectTimeoutMs: cto } : {}),
    })
    window.__PROBE__ = { hashes: [], events: [] }
  }, [base + 'api/signal', shape, connectTimeoutMs, peerId, label])
  // Entering the lobby screen is what makes ui/lobby.ts build the service and
  // install ITS handlers -- onRoom, onStart, onClosed. Doing it now means the
  // programmatic calls below go through the same singleton the UI is wired to,
  // so `onStart` really does reach `Game.startMultiplayer` and a real race
  // appears on screen rather than a packet arriving in a test harness.
  await page.evaluate(() => { window.__GAME__.frontEnd.show('lobby') })
  await page.waitForTimeout(400)
  return { ctx, page, label }
}

/** Poll a page-side predicate. Returns the value, or null on timeout. */
async function until(page, fn, arg, ms = 15000, step = 100) {
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
 * THE HOOK THIS PASS IS ASKING FOR, APPLIED FROM OUTSIDE.
 *
 * game/main.ts is not mine to edit, so the runner is attached by shadowing
 * `Race.step` on the instance the game just built. What the patched step does
 * is EXACTLY the one line the report asks for in main.ts's fixed-step loop:
 *
 *     if (this.net) { if (!this.net.beforeStep(frame)) break }
 *     else this.race.setInput(this.localId, frame)
 *
 * main.ts has already called `setInput(localId, rawStick)` by the time step
 * runs, so the raw value is read back out of the sim and handed to the runner,
 * which overwrites it with the QUANTISED one before stepping -- which is the
 * whole point (see the header of net/lockstep.ts).
 *
 * The scripted stick is a pure function of the sim frame and DIFFERENT PER
 * CLIENT, which is what makes hash agreement evidence rather than coincidence:
 * if the inputs were not really crossing the wire, each client would be
 * driving the other's car from an assumption and they would part company in
 * the first second.
 */
const RIG = ({ seedTag }) => {
  const game = window.__GAME__
  const net = window.__NET__
  const P = window.__PROBE__

  // A scripted stick. Deterministic, and deliberately unlike the other side's.
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
  // Auto-accelerate is a getter, and main.ts holds the throttle shut through
  // the whole countdown when it is on -- which would make both clients publish
  // neutral for the first three seconds and prove nothing.
  try {
    Object.defineProperty(game.input, 'autoAccelerate', { get: () => false, configurable: true })
  } catch { /* already plain */ }

  const prev = game.frontEnd.onMultiplayerStart
  game.frontEnd.onMultiplayerStart = (packet) => {
    prev(packet)
    const race = game.race
    if (!race) { P.events.push('no race after start'); return }
    const transport = net.raceTransport()
    if (!transport) { P.events.push('no transport after start'); return }

    const players = new Map()
    for (const s of packet.grid) if (s.playerId) players.set(s.slot, s.playerId)
    let localSlot = -1
    for (const [slot, id] of players) if (id === packet.localPlayerId) localSlot = slot

    const lobby = net.liveLobby()
    const mesh = lobby ? lobby.mesh : null

    /**
     * game/main.ts NOW BUILDS THE RUNNER ITSELF, so this probe uses that one.
     *
     * When this file was written the integration did not exist -- the header
     * above still describes shadowing `race.step` because main.ts was not
     * ours to edit -- and the probe had to stand up its own `LockstepRunner`
     * to have anything to measure. `startMultiplayer` does it now, from the
     * same `raceTransport()`, with the same mesh-backed `health` and the same
     * two announcement callbacks.
     *
     * A SECOND RUNNER IS NOT HARMLESS, WHICH IS WHY THIS IS A BRANCH AND NOT
     * A PREFERENCE. Both would publish a local input for the same frame --
     * main's from the real sampled stick, the probe's from its scripted one
     * -- and the peer's scheduler keeps whichever arrived first. Two clients
     * disagreeing about what THIS client's own input was on frame N is a
     * desync from frame N, and it would look exactly like a protocol bug.
     *
     * The wrapping below is so the event log still records the verdicts even
     * though main.ts now owns the callbacks that produce them.
     */
    const existing = game.net
    if (existing) {
      P.events.push('using game.net (main.ts owns the runner)')
      const ad = transport.announceDrop.bind(transport)
      transport.announceDrop = (playerId, frame) => {
        const l = mesh ? mesh.get(playerId) : null
        P.events.push(`announceDrop ${playerId} @${frame}`
          + ` [raceFrame ${race.state.frame} state ${l ? l.state : '-'}`
          + ` dead ${l ? l.dead : '-'} silent ${l ? Math.round(l.silentFor()) : -1}ms`
          + ` ping ${l && l.pingMs !== null ? Math.round(l.pingMs) : '-'}]`)
        ad(playerId, frame)
      }
      const ax = transport.announceDesync.bind(transport)
      transport.announceDesync = (frame) => { P.events.push(`announceDesync @${frame}`); ax(frame) }
      const rd = transport.onRoundDrop
      transport.onRoundDrop = (playerId, frame) => {
        P.events.push(`acceptDrop ${playerId} @${frame}`)
        rd(playerId, frame)
      }
      const ds = transport.onDesync
      transport.onDesync = (frame) => { P.events.push(`acceptDesync @${frame}`); ds(frame) }
    }

    const runner = existing ?? new net.LockstepRunner({
      race,
      transport,
      players,
      localSlot,
      inputDelay: packet.inputDelay,
      authority: packet.grid.some((s) => s.playerId === packet.localPlayerId && s.isHost),
      health: (slot) => {
        const id = players.get(slot)
        const link = id && mesh ? mesh.get(id) : null
        return link && link.dead ? 'down' : 'up'
      },
      announceDrop: (_slot, playerId, frame) => {
        const l = mesh ? mesh.get(playerId) : null
        P.events.push(`announceDrop ${playerId} @${frame}`
          + ` [raceFrame ${race.state.frame} state ${l ? l.state : '-'}`
          + ` dead ${l ? l.dead : '-'} silent ${l ? Math.round(l.silentFor()) : -1}ms`
          + ` ping ${l && l.pingMs !== null ? Math.round(l.pingMs) : '-'}]`)
        transport.announceDrop(playerId, frame)
      },
      announceDesync: (frame) => {
        P.events.push(`announceDesync @${frame}`)
        transport.announceDesync(frame)
      },
    })
    // --- instrumentation, so a stall can be diagnosed rather than guessed ---
    P.rx = { raw: 0, in: 0, hash: 0, kinds: {} }
    P.tx = { in: 0 }
    const meshOn = lobby ? lobby.mesh.onMessage : null
    if (meshOn && lobby) {
      lobby.mesh.onMessage = (from, m) => {
        P.rx.raw++
        const k = m && m.t ? m.t : '?'
        P.rx.kinds[k] = (P.rx.kinds[k] || 0) + 1
        meshOn(from, m)
      }
    }
    const inHandler = transport.onInput
    transport.onInput = (id, f, pk) => { P.rx.in++; P.lastIn = [id, f]; inHandler(id, f, pk) }
    const send = transport.sendInput.bind(transport)
    transport.sendInput = (f, pk) => { P.tx.in++; P.lastTx = f; send(f, pk) }

    // Only for a runner this file built. When main.ts owns it these two are
    // already wired, and wrapped for the log twenty lines up; re-assigning
    // them here would drop main.ts's own handler on the floor.
    if (!existing) {
      transport.onRoundDrop = (playerId, frame) => {
        P.events.push(`acceptDrop ${playerId} @${frame}`)
        runner.acceptDrop(playerId, frame)
      }
      transport.onDesync = (frame) => {
        P.events.push(`acceptDesync @${frame}`)
        runner.acceptDesync(frame)
      }
    }

    const origStep = race.step.bind(race)
    const EMPTY = {
      steer: 0, throttle: 0, brake: 0,
      drift: false, item: false, itemBack: false, lift: false, lookBack: false,
    }
    race.step = () => {
      const local = race.inputs[localSlot] || EMPTY
      if (!runner.beforeStep(local)) {
        // A STALL MUST NOT BANK SIM TIME. main.ts's accumulator keeps growing
        // while the race stands still, and without this the moment the peer
        // catches up the loop would run its whole sub-step budget and the race
        // would visibly fast-forward. Zeroing it is the behaviour the report
        // asks main.ts for, in one line.
        P.stalls = (P.stalls || 0) + 1
        game.accumulator = 0
        return
      }
      origStep()
      if (race.state.frame % 30 === 0) {
        P.hashes.push([race.state.frame, race.hash()])
      }
    }

    /**
     * THE SIM IS PUMPED BY A TIMER, NOT BY requestAnimationFrame.
     *
     * Two software-rendered racers in one Chromium share one CPU and manage
     * about 0.7 frames per second between them. A lockstep race driven off
     * that renders 8 frames in 12 seconds, every peer looks permanently late,
     * and the stall timer -- which is in WALL CLOCK, because a network is --
     * expires on a link that is working perfectly. The probe would be
     * measuring swiftshader.
     *
     * So the fixed step is driven at 60Hz by an interval instead, which is
     * exactly what lockstep is for: the sim rate is a property of the frame
     * counter and not of the renderer. Everything else is untouched -- the
     * same patched `step`, the same runner, the same wire, the same hashes.
     * The picture on screen is still drawn by the real render loop, at
     * whatever rate software rendering manages.
     *
     * IT ALSO SURFACED A REAL PROPERTY WORTH KNOWING: a peer that cannot
     * sustain the sim rate is, to everybody else, indistinguishable from a
     * peer with a bad link, and the drop policy will eventually eject them.
     * That is the right outcome -- a room runs at its slowest member's frame
     * rate -- but it is a different sentence from "connection lost".
     */
    /**
     * THE PAGE PARKS ITS OWN RENDERER, from inside, on its own clock.
     *
     * Doing it from node (`page.evaluate(cancelAnimationFrame)`) looked
     * equivalent and was not: the call queues behind whatever the page is
     * already doing, so the HOST -- which is not blocked -- parks immediately
     * while the GUEST, which is blocked rendering the first frames of a
     * circuit under a software rasteriser, parks twenty seconds later. The
     * host then free-runs for twenty seconds of awake time against a silent
     * peer and hits even the twenty-second loading deadline. Scheduling it
     * here makes the two symmetric, because each page parks 1.2s after ITS
     * OWN race started.
     */
    setTimeout(() => {
      try { cancelAnimationFrame(window.__GAME__.raf) } catch { /* already gone */ }
      P.parked = true
    }, 1200)

    P.pumpTicks = 0
    P.maxGap = 0
    P.lastTick = performance.now()
    P.pump = setInterval(() => {
      const t = performance.now()
      const gap = t - P.lastTick
      if (gap > P.maxGap) P.maxGap = Math.round(gap)
      P.lastTick = t
      P.pumpTicks++
      try { race.step() } catch { /* the page is being torn down */ }
    }, 16)
    P.stalls = 0

    P.runner = runner
    P.localSlot = localSlot
    P.inputDelay = packet.inputDelay
    P.seed = packet.seed
    P.grid = packet.grid.map((s) => `${s.slot}:${s.playerId ?? 'ai'}`)
    P.events.push(`start slot=${localSlot} delay=${packet.inputDelay} seed=${packet.seed}`)
  }
}

/** What the page knows about its own race right now. */
const READ = () => {
  const P = window.__PROBE__
  const game = window.__GAME__
  const net = window.__NET__
  const lobby = net.liveLobby()
  const mesh = lobby ? lobby.mesh : null
  return {
    frame: game.race ? game.race.state.frame : -1,
    phase: game.race ? game.race.state.phase : '-',
    gamePhase: game.phase,
    hashes: P.hashes,
    events: P.events,
    verdict: P.runner ? P.runner.verdict : '-',
    rx: P.rx, tx: P.tx, lastIn: P.lastIn, lastTx: P.lastTx,
    pumpTicks: P.pumpTicks, maxGap: P.maxGap, stalls: P.stalls,
    missing: P.runner && game.race
      ? P.runner.scheduler.missing(game.race.state.frame + 1) : [],
    horizon: P.runner ? P.runner.scheduler.horizon : -1,
    waitingFor: P.runner ? P.runner.waitingFor : [],
    waitingToLoad: P.runner ? P.runner.waitingToLoad : false,
    dropped: P.runner ? P.runner.droppedSlots : [],
    desyncFrame: P.runner ? P.runner.desyncFrame : -1,
    inputDelay: P.inputDelay ?? -1,
    seed: P.seed ?? -1,
    grid: P.grid ?? [],
    localSlot: P.localSlot ?? -1,
    peers: mesh ? mesh.peers.map((l) => ({
      id: l.peerId, state: l.state, failure: l.failure,
      connectMs: l.connectMs, pingMs: l.pingMs === null ? null : Math.round(l.pingMs),
    })) : [],
    lastFailure: lobby ? lobby.lastFailure : null,
    worstPath: mesh ? Math.round(mesh.worstPathMs(220)) : -1,
    aiSlots: game.race ? game.race.state.racers.filter((r) => r.isAI).map((r) => r.id) : [],
  }
}

// ===========================================================================
// PASS 1 — a race
// ===========================================================================

const shape = SHAPE
  ? { delayMs: 45, jitterMs: 25, lossRate: 0.03, seed: 0x51ce }
  : null

head(SHAPE ? 'two browsers, SHAPED (45ms +25 jitter, 3% retransmit)' : 'two browsers, unshaped')
if (SHAPE) {
  say('shaping is applied on RECEIVE and models loss as retransmit-plus-head-of-')
  say('line-block, because the data channel is reliable and ordered: a lost')
  say('input is not a missing input, it is a late one that holds up the queue.')
}

const A = await open('host', { shape })
const B = await open('guest', { shape })

await A.page.evaluate(RIG, { seedTag: 1 })
await B.page.evaluate(RIG, { seedTag: 2 })

// --- create and join --------------------------------------------------------
const t0 = Date.now()
const created = await A.page.evaluate(async () => {
  const svc = window.__NET__.lobbyService()
  const res = await svc.create({
    name: 'Probe lobby',
    region: 'eu-west',
    maxPlayers: 8,
    private: false,
    // Enough laps that a 60Hz pump cannot finish the race inside the probe:
    // a finished race steps nothing, and "nothing stepped" is not agreement.
    series: { length: 1, trackIds: ['rustfall'], laps: 9 },
  })
  return res.ok ? { id: res.value.id, localId: res.value.localId } : { error: res.error }
})
if (created.error) { note(`host could not create a lobby: ${created.error}`); }
else say(`host created lobby ${created.id} in ${Date.now() - t0}ms`)

const listed = await until(B.page, async () => {
  const svc = window.__NET__.lobbyService()
  const res = await svc.list()
  return res.ok && res.value.length > 0 ? res.value.map((r) => r.id) : null
}, null, 8000)
if (!listed) note('the guest never saw the lobby in the directory')
else say(`guest sees ${listed.length} lobby in the directory`)

const tJoin = Date.now()
const joined = await B.page.evaluate(async (id) => {
  const res = await window.__NET__.lobbyService().join(id)
  return res.ok ? { localId: res.value.localId } : { error: res.error }
}, created.id)
if (joined.error) note(`guest could not join: ${joined.error}`)

// --- the connection ---------------------------------------------------------
const connected = await until(A.page, () => {
  const mesh = window.__NET__.liveLobby()?.mesh
  const open = mesh ? mesh.peers.filter((l) => l.state === 'open') : []
  return open.length > 0 ? open.map((l) => ({ id: l.peerId, ms: l.connectMs })) : null
}, null, 20000)

if (!connected) {
  const a = await A.page.evaluate(READ)
  const b = await B.page.evaluate(READ)
  note('THE DATA CHANNEL NEVER OPENED — everything below is meaningless')
  note(`  host peers: ${JSON.stringify(a.peers)}`)
  note(`  guest peers: ${JSON.stringify(b.peers)}`)
} else {
  say(`data channel open: host side ${connected[0].ms}ms after the link was `
    + `created, ${Date.now() - tJoin}ms after the join call`)
  const gm = await B.page.evaluate(() => {
    const mesh = window.__NET__.liveLobby()?.mesh
    const l = mesh ? mesh.peers[0] : null
    return l ? l.connectMs : null
  })
  say(`  guest side ${gm}ms; ${signalCalls} signalling requests so far`)
}

await B.page.evaluate(async () => { await window.__NET__.lobbyService().setReady(true) })
await A.page.waitForTimeout(600)
const readyRow = await A.page.evaluate(() => {
  const r = window.__NET__.lobbyService().current()
  return r ? r.members.map((m) => `${m.name}:${m.ready ? 'ready' : 'not'}:`
    + `${m.connecting ? 'connecting' : 'in'}:${m.pingMs}ms`) : []
})
say(`the host's room: ${readyRow.join(' | ')}`)

const roomShot = await shoot(A.page, 'host-room')
void roomShot

// --- start ------------------------------------------------------------------
const started = await A.page.evaluate(async () => {
  const res = await window.__NET__.lobbyService().start()
  return res.ok ? { seed: res.value.seed, delay: res.value.inputDelay } : { error: res.error }
})
if (started.error) note(`start refused: ${started.error}`)
else say(`start: seed ${started.seed}, inputDelay ${started.delay} frames`)

const bothRacing = await until(A.page, () => {
  const g = window.__GAME__
  return g.race && window.__PROBE__.runner ? true : null
}, null, 30000) && await until(B.page, () => {
  const g = window.__GAME__
  return g.race && window.__PROBE__.runner ? true : null
}, null, 30000)
if (!bothRacing) note('one of the two clients never entered the race')

// THE PHOTOGRAPHS COME FIRST, AND THEN THE RENDERER IS PARKED.
//
// Measured, because it was not obvious and it wrecked three runs: two of these
// pages rendering a full 3D race under swiftshader block their own main thread
// for FIFTY-THREE SECONDS at a stretch. The 60Hz pump fired forty times in a
// whole minute, every data-channel message sat in the receive queue behind a
// blocked event loop, and every peer looked permanently late to every other
// peer -- a stall test the probe did not mean to run, measuring a software
// rasteriser.
//
// So: a couple of real rendered frames from each browser get photographed
// (that is the picture of two browsers racing), and then `cancelAnimationFrame`
// takes the renderer out of the loop entirely and the sim is driven by the
// timer alone. Every part of the claim -- the peer connection, the data
// channel, the scheduler, the packing, the hashes -- is untouched by this;
// only the drawing stops.
// Each page parks itself 1.2s after its own race starts (see RIG). This waits
// for both to have done it, so the screenshots are of a page that can answer
// and the counters below start from a level field.
const parked = await until(A.page, () => (window.__PROBE__.parked ? true : null), null, 40000, 300)
  && await until(B.page, () => (window.__PROBE__.parked ? true : null), null, 40000, 300)
if (!parked) note('a page never parked its renderer; the timings below are the rasteriser\'s')
for (const pg of [A.page, B.page]) {
  await pg.evaluate(() => {
    // Counters restart here, so what is measured below is the sim's rate and
    // not the software rasteriser's.
    window.__PROBE__.maxGap = 0
    window.__PROBE__.lastTick = performance.now()
    window.__PROBE__.pumpTicks = 0
    window.__PROBE__.stalls = 0
  })
}
await shoot(A.page, 'host-racing')
await shoot(B.page, 'guest-racing')
say('renderer parked on both pages; the sim is now driven by the 60Hz pump')

// --- race -------------------------------------------------------------------
const TARGET_FRAME = 900
say(`racing to frame ${TARGET_FRAME} (15 seconds of sim)...`)
const reached = await until(A.page, (t) => {
  const g = window.__GAME__
  return g.race && g.race.state.frame >= t ? g.race.state.frame : null
}, TARGET_FRAME, 40000, 200)
if (!reached) note(`the host never reached frame ${TARGET_FRAME}`)
// Let the guest catch up to whatever the host reached before the hashes are
// compared: a guest one frame behind has one fewer checkpoint, which is not a
// disagreement.
await A.page.waitForTimeout(600)

let a = await A.page.evaluate(READ)
let b = await B.page.evaluate(READ)

say(`host  frame ${a.frame} (${a.hashes.length} checkpoints), verdict ${a.verdict}`)
say(`guest frame ${b.frame} (${b.hashes.length} checkpoints), verdict ${b.verdict}`)
say(`host  sent ${a.tx.in} inputs, took ${a.rx.in}; guest sent ${b.tx.in}, took ${b.rx.in}`)
say(`sim pump: host ${a.pumpTicks} ticks (worst gap ${a.maxGap}ms, ${a.stalls} stalled ticks), `
  + `guest ${b.pumpTicks} (${b.maxGap}ms, ${b.stalls})`)
say(`grid: ${a.grid.join(' ')}`)
say(`local slots: host ${a.localSlot}, guest ${b.localSlot}; `
  + `seeds ${a.seed} / ${b.seed}; delay ${a.inputDelay} / ${b.inputDelay}`)
say(`worst path: host ${a.worstPath}ms, guest ${b.worstPath}ms; `
  + `ping ${JSON.stringify(a.peers.map((p) => p.pingMs))}`)

if (a.seed !== b.seed) note('the two clients are running different seeds')
if (a.inputDelay !== b.inputDelay) note('the two clients are running different input delays')
if (a.localSlot === b.localSlot) note('both clients think they are the same car')

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
      return { compared, agreed: false }
    }
  }
  return { compared, agreed: true }
}

const cmp = compare(a.hashes, b.hashes, 'race')
if (cmp.compared < 5) note(`only ${cmp.compared} frames were comparable — the race barely ran`)
else if (cmp.agreed) {
  say(`AGREED on all ${cmp.compared} compared checkpoints, up to frame `
    + `${Math.min(a.frame, b.frame)}`)
}
if (a.verdict === 'desync' || b.verdict === 'desync') {
  note(`a client called a desync during the clean race (host ${a.verdict}, guest ${b.verdict})`)
}
say(`signalling requests for the whole session so far: ${signalCalls} `
  + '(nothing after the handshake is gameplay)')

// ===========================================================================
// PASS 2 — a peer that stalls
// ===========================================================================

head('a peer that stalls')
const baseline = await A.page.evaluate(READ)
if (baseline.verdict !== 'racing') {
  note(`the host was already "${baseline.verdict}" before the stall test — `
    + 'whatever it measures next is not a stall')
}
const STALL_MS = 1400
say(`holding the guest's outbound inputs for ${STALL_MS}ms, then flushing them`)
// HELD AND FLUSHED, NOT DROPPED, and the difference is the whole point. The
// data channel is `ordered: true` and reliable, so an input cannot go missing
// -- SCTP retransmits it and everything behind it waits. A probe that simply
// discarded the sends would be simulating a transport this game does not use,
// and it would deadlock lockstep for a reason that cannot happen in the field.
// (It did, on the run before this one, and the deadlock was the probe's.)
await B.page.evaluate(() => {
  const t = window.__NET__.raceTransport()
  const P = window.__PROBE__
  P.realSend = t.sendInput.bind(t)
  P.held = []
  t.sendInput = (f, p) => { P.held.push([f, p]) }
})
// Long enough to pass STALL_ANNOUNCE_MS (300ms) and nowhere near
// STALL_DROP_MS (5000ms), so this measures the WAIT and not the eviction.
const beforeStall = (await A.page.evaluate(READ)).frame
await A.page.waitForTimeout(700)
const midStall = await A.page.evaluate(READ)
say(`host frame ${beforeStall} -> ${midStall.frame} while the guest was silent`)
say(`host verdict "${midStall.verdict}", waiting for ${JSON.stringify(midStall.waitingFor)}`
  + `${midStall.waitingToLoad ? ' (still loading)' : ''}`)
if (midStall.verdict !== 'waiting') note('the host did not notice a peer had stopped sending')
if (midStall.waitingFor.length === 0) {
  note('the host is waiting but cannot name who for — the player would see a frozen race '
    + 'with no explanation, which is the exact outcome the stall policy exists to prevent')
}
await paintOnce(A.page)
await shoot(A.page, 'host-waiting')

await B.page.waitForTimeout(STALL_MS - 700)
const flushed = await B.page.evaluate(() => {
  const t = window.__NET__.raceTransport()
  const P = window.__PROBE__
  t.sendInput = P.realSend
  for (const [f, p] of P.held) P.realSend(f, p)
  const n = P.held.length
  P.held = []
  return n
})
say(`flushed ${flushed} held inputs`)
const resumeFrom = midStall.frame
await A.page.waitForTimeout(2500)
a = await A.page.evaluate(READ)
b = await B.page.evaluate(READ)
say(`after the tap was restored: host frame ${a.frame} verdict ${a.verdict}, `
  + `guest frame ${b.frame} verdict ${b.verdict}`)
// PROGRESS, NOT THE INSTANTANEOUS VERDICT. On a shaped link the race is
// legitimately `waiting` for a sizeable fraction of all ticks -- that is the
// lockstep tax and it is what `inputDelay` is bought to reduce -- so a single
// sample of `verdict` is a coin toss. What has to be true is that the race
// moved on.
if (a.frame < resumeFrom + 60) {
  note(`the host recovered only ${a.frame - resumeFrom} frames in 2.5s after the flush`)
}
if (a.dropped.length > 0) note(`a ${STALL_MS}ms stall dropped somebody: ${a.dropped}`)
const cmp2 = compare(a.hashes, b.hashes, 'after a stall')
if (cmp2.agreed) say(`still AGREED after the stall, on ${cmp2.compared} checkpoints`)

// ===========================================================================
// PASS 3 — a desync, caused for real
// ===========================================================================

head('a desync, caused for real and detected from the hash')
const nudged = await B.page.evaluate(() => {
  const r = window.__GAME__.race
  if (!r) return null
  // A METRE, ON ONE CLIENT, ON ONE CAR. Not a faked hash: this is a genuine
  // divergence of exactly the kind a netcode bug produces, and the detector
  // has to find it from the state hash alone.
  const victim = r.state.racers[7]
  victim.pos.x += 1
  return { frame: r.state.frame, slot: 7 }
})
if (!nudged) note('could not nudge a car to force a divergence')
else say(`nudged slot ${nudged.slot} by 1m on the guest at frame ${nudged.frame}`)

const caught = await until(A.page, () => {
  const p = window.__PROBE__
  return p.runner && p.runner.verdict === 'desync' ? p.runner.desyncFrame : null
}, null, 6000)
if (!caught) note('the host never detected the divergence')
else {
  say(`host called it at frame ${caught}, ${caught - (nudged?.frame ?? caught)} frames `
    + 'after the nudge (a hash goes out every 30)')
}
const guestHalted = await until(B.page, () => {
  const p = window.__PROBE__
  return p.runner && p.runner.verdict === 'desync' ? p.runner.desyncFrame : null
}, null, 4000)
if (!guestHalted) note('the guest kept racing a round the host had already voided')
else say(`guest halted at frame ${guestHalted}`)

a = await A.page.evaluate(READ)
say(`host events: ${a.events.slice(-3).join(' | ')}`)
await paintOnce(A.page)
await shoot(A.page, 'host-desync')

// ===========================================================================
// PASS 4 — a peer that drops, mid-race
// ===========================================================================

head('a peer that drops mid-race')
// A fresh pair, because the round above has been voided on purpose and a
// halted runner is not a fair test of whether the sim keeps running.
await A.ctx.close()
await B.ctx.close()

const C = await open('host2', { shape })
const D = await open('guest2', { shape })
await C.page.evaluate(RIG, { seedTag: 1 })
await D.page.evaluate(RIG, { seedTag: 2 })

const lobby2 = await C.page.evaluate(async () => {
  const res = await window.__NET__.lobbyService().create({
    name: 'Drop probe', region: 'eu-west', maxPlayers: 8, private: false,
    series: { length: 1, trackIds: ['rustfall'], laps: 9 },
  })
  return res.ok ? res.value.id : null
})
await D.page.evaluate(async (id) => { await window.__NET__.lobbyService().join(id) }, lobby2)
const linked = await until(C.page, () => {
  const mesh = window.__NET__.liveLobby()?.mesh
  return mesh && mesh.peers.some((l) => l.state === 'open') ? true : null
}, null, 20000)
if (!linked) note('the second pair never connected')
// READY ONLY ONCE THE LINK IS UP, which is not a probe convenience: the
// service refuses a ready from a member who is still connecting, exactly as
// types.ts says it must ("a player who is still connecting cannot be ready"),
// and a probe that readies too early gets `unready` from start() and blames
// the wrong thing.
await D.page.evaluate(async () => { await window.__NET__.lobbyService().setReady(true) })
await C.page.waitForTimeout(400)
const started2 = await C.page.evaluate(async () => {
  const res = await window.__NET__.lobbyService().start()
  return res.ok ? null : res.error
})
if (started2) note(`the second lobby would not start: ${started2}`)
await until(C.page, () => (window.__PROBE__.parked ? true : null), null, 40000, 300)
await until(D.page, () => (window.__PROBE__.parked ? true : null), null, 40000, 300)
const running2 = await until(C.page, () => {
  const g = window.__GAME__
  return g.race && g.race.state.frame > 200 ? g.race.state.frame : null
}, null, 30000, 250)
if (!running2) note('the second race never got going, so the drop test proves nothing')

let c = await C.page.evaluate(READ)
say(`before the drop: host frame ${c.frame}, AI slots ${JSON.stringify(c.aiSlots)}`)
const humanSlots = c.grid.filter((g) => !g.endsWith(':ai')).map((g) => Number(g.split(':')[0]))
say(`human slots on the grid: ${JSON.stringify(humanSlots)}`)

say('closing the guest\'s browser context outright')
const dropAt = c.frame
await D.ctx.close()

const dropped = await until(C.page, () => {
  const p = window.__PROBE__
  return p.runner && p.runner.droppedSlots.length > 0 ? p.runner.droppedSlots : null
}, null, 12000)
c = await C.page.evaluate(READ)
if (!dropped) {
  note('the host never dropped a peer whose browser had gone away')
} else {
  say(`host dropped slot(s) ${JSON.stringify(dropped)} after `
    + `${c.frame - dropAt} frames (~${Math.round((c.frame - dropAt) / 60 * 1000)}ms)`)
  say(`events: ${c.events.filter((e) => e.startsWith('announceDrop')).join(' | ')}`)
}
if (c.verdict === 'waiting') note('the race is still stalled after the drop was announced')

const afterDrop = c.frame
await C.page.waitForTimeout(3000)
c = await C.page.evaluate(READ)
say(`the sim kept running: frame ${afterDrop} -> ${c.frame}, verdict ${c.verdict}`)
if (c.frame <= afterDrop + 60) {
  note('the race did not keep running after a peer dropped')
}
// The dropped player's car must be BEING DRIVEN, by the AI, at the skill the
// packet published -- which is the mechanism startMultiplayer already uses for
// an empty slot, not a second one invented for this case.
const watchSlot = dropped ? dropped[0] : humanSlots[humanSlots.length - 1]
const drivingOn = typeof watchSlot === 'number'
  ? await C.page.evaluate((slot) => {
    const r = window.__GAME__.race
    if (!r || !r.state.racers[slot]) return null
    const car = r.state.racers[slot]
    return { isAI: car.isAI, speed: Math.hypot(car.vel.x, car.vel.z), totalS: car.totalS }
  }, watchSlot)
  : null
if (!drivingOn) note('could not read the dropped player\'s car at all')
else {
  say(`the dropped car (slot ${watchSlot}): isAI ${drivingOn.isAI}, `
    + `${drivingOn.speed.toFixed(1)} m/s, ${drivingOn.totalS.toFixed(0)}m along`)
  if (!drivingOn.isAI) note('the dropped player\'s car is not marked AI')
  if (drivingOn.speed < 5) note('the dropped player\'s car has stopped driving')
}
await paintOnce(C.page)
await shoot(C.page, 'host-after-drop')

// ===========================================================================
// PASS 5 — a connection that never completes
// ===========================================================================

head('a connection that never completes')
say('joining a lobby whose host has gone away: the guest offers and nobody answers.')
say('THIS IS THE TIMEOUT PATH, NOT THE NAT PATH. A real traversal failure needs')
say('two networks that cannot see each other, and two contexts on one loopback')
say('can always see each other. What is proved here is that a link that never')
say('completes produces a NAMED failure and a closed room inside a bounded')
say('time, rather than a spinner -- which is the part a player experiences.')

const E = await open('host3')
const lobby3 = await E.page.evaluate(async () => {
  const res = await window.__NET__.lobbyService().create({
    name: 'Ghost lobby', region: 'eu-west', maxPlayers: 8, private: false,
    series: { length: 1, trackIds: ['rustfall'], laps: 3 },
  })
  return res.ok ? res.value.id : null
})
await E.ctx.close()

const F = await open('guest3', { connectTimeoutMs: 3000 })
const failure = await F.page.evaluate(async (id) => {
  const svc = window.__NET__.lobbyService()
  const seen = []
  svc.onClosed = (reason) => seen.push(`closed:${reason}`)
  const lobby = window.__NET__.liveLobby()
  lobby.onFailure = (text) => seen.push(`failure:${text}`)
  const t0 = performance.now()
  const res = await svc.join(id)
  if (!res.ok) return { joinError: res.error, seen, ms: 0 }
  await new Promise((r) => setTimeout(r, 6000))
  return {
    seen,
    ms: Math.round(performance.now() - t0),
    lastFailure: lobby.lastFailure,
    peers: lobby.mesh ? lobby.mesh.peers.map((l) => ({ state: l.state, failure: l.failure })) : [],
  }
}, lobby3)
say(`after ${failure.ms}ms: peers ${JSON.stringify(failure.peers)}`)
say(`events: ${JSON.stringify(failure.seen.map((s) => s.slice(0, 90)))}`)
if (!failure.seen.some((s) => s.startsWith('failure:'))) {
  note('a connection that never completed produced no named failure at all — '
    + 'the player would be looking at a spinner')
}
if (!failure.seen.some((s) => s.startsWith('closed:'))) {
  note('the room stayed open around a host who can never arrive')
}
if (failure.lastFailure) say(`the sentence: "${failure.lastFailure.slice(0, 120)}..."`)
await shoot(F.page, 'guest-unreachable')

// ===========================================================================

head('summary')
say(`${signalCalls} signalling requests across the whole session`)
say(`shots in shots/netcode/`)
const report = {
  shaped: SHAPE,
  shape,
  signalCalls,
  connectMs: connected ? connected[0].ms : null,
  inputDelayFrames: a.inputDelay,
  worstPathMs: a.worstPath,
  simTicks: a.pumpTicks,
  stalledTicks: a.stalls,
  agreed: cmp.agreed,
  checkpoints: cmp.compared,
  errors,
}
await writeFile(join(OUT, 'report.json'), JSON.stringify(report, null, 2))

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
