import type { TrackDef, TrackNode } from '../../sim/track'
import { ring, envelope, inSpan, type Harm } from './ring'

/**
 * ASHKAR — Volcanic Shield.
 *
 * The fifth circuit, and the first authored from a harmonic ring rather than a
 * turtle (see the header of ring.ts for why the turtle kept demanding a
 * straight that ran 400 metres backwards).
 *
 * Difficulty: Medium. It sits between Namaresh and Elkarim on purpose -- the
 * roster needed a circuit whose difficulty comes from SURFACE and SIGHTLINES
 * rather than from a hazard you can be killed by. Nothing on Ashkar deletes a
 * lap. The ash beds cost you a tenth at a time.
 *
 * ---------------------------------------------------------------------------
 * 1. THE TWO SET PIECES ARE SET PIECES, AND THE ARITHMETIC SAYS SO.
 *
 * The Lava Tube is a full vertical loop; the Corkscrew is two turns of helix
 * around the inside of a tube. Both are the headline images of the track and
 * NEITHER IS A CORNER, which is not a disappointment to be designed around but
 * a fact to design WITH.
 *
 * `Track.curvatureAt` measures curvature about the SURFACE NORMAL on a gravity
 * track, which is the right thing to measure. A loop's curvature vector points
 * straight along that normal; so does a helix's. Their geodesic curvature is
 * therefore identically zero, and the sim reads both as DEAD STRAIGHT --
 * measured at 0.0000 across 120m either side of the loop apex (tools/probe
 * -loop.ts), against the AI's 0.0045 drift-hold gate. Nothing brakes for them.
 * Nothing drifts in them. Aetherion's rotunda cost three balance rounds to
 * exactly this arithmetic before anyone wrote it down.
 *
 * So both are placed where the lap can AFFORD to be flat out, and the lap's
 * actual work is done by the ash beds and the last corner. The loop's job is to
 * be the thing you tell someone about; the ash beds' job is to decide the race.
 *
 * 2. THE ASH BEDS ARE THE TRACK.
 *
 * A third of the lap is gravel (grip 0.70). They are wide, fast and banked,
 * which makes them a drift section rather than a penalty box -- the same shape
 * as Elkarim's gravel, opened out. Gravel also means the AI's corner model and
 * the player's are furthest apart here, which is where overtakes come from.
 *
 * 3. THE UPDRAFT.
 *
 * `wind` through the caldera rim, ramped in and out across 14% of the lap so it
 * never switches on at a sample boundary. The rim is BARRIERED, and that is a
 * measurement rather than a preference: run with the same gust over `open` road
 * and the field respawns 16.3 times a race against 0.0-0.7 on every shipped
 * circuit, all of it inside that one stretch. The wind now pushes you into a
 * bounce wall instead of off a cliff, which is a corner you can commit to --
 * especially since contact no longer ends a drift. Debris draws it (see
 * themes/emberfall.ts); a force the player cannot see is not weather, it is a
 * bug, and that lesson is already paid for.
 *
 * 4. WHAT IT DELIBERATELY DOES NOT HAVE.
 *
 * No `fragile`. A collapsing lava crust is the obvious gimmick and it is not
 * available honestly: `fragile` turns the surface into `T.hazard.crackedSurface`
 * which is a GLOBAL, and on this planet that global is ice. Shipping a lava
 * shelf that cracks into ice to reuse a mechanic would be a lie in the one
 * place the player is looking. Making the cracked surface per-track is a real
 * change to a determinism-gated system and belongs in its own pass, not
 * smuggled in behind a new planet.
 * ---------------------------------------------------------------------------
 */

/**
 * The ring. Searched rather than drawn (tools/probe-ring.ts): plan length
 * 3150m with radii from 64m to effectively straight, which puts the tightest
 * corner just inside Class B and leaves two stretches long enough to be read as
 * straights. k=2 puts the waist in at the ash beds; k=3 gives the rim its lobe.
 */
const H: Harm[] = [
  { k: 1, ax: 440, bx: 0, az: 0, bz: 352 },
  { k: 2, ax: 0, bx: 70.4, az: 49.3, bz: 0 },
  { k: 3, ax: 52.8, bx: 70.4, az: -42.2, bz: 31.7 },
]

const SPACING = 26
const RING = ring(H, SPACING)

/** Lap-fraction beat map. Everything below reads off this and nothing else. */
const BEATS = {
  start: [0.95, 0.08] as [number, number],
  fissure: 0.20,
  ashBeds: [0.25, 0.42] as [number, number],
  lavaTube: 0.50,
  corkscrew: [0.59, 0.75] as [number, number],
  updraft: [0.76, 0.90] as [number, number],
}

/** Elevation, metres. A shield volcano: climb to the rim, drop into the vent. */
function elevation(u: number): number {
  return (
    18 * Math.sin(2 * Math.PI * (u - 0.05)) +
    9 * Math.sin(4 * Math.PI * (u + 0.12)) +
    22
  )
}

const LOOP_R = 40
const LOOP_STEPS = 14
const CORK_R = 26
const CORK_TURNS = 2

function build(): TrackNode[] {
  const out: TrackNode[] = []
  const n = RING.length
  const corkFrom = BEATS.corkscrew[0], corkTo = BEATS.corkscrew[1]

  for (let i = 0; i < n; i++) {
    const p = RING[i]
    const u = p.u
    const y = elevation(u)

    // ---- THE CORKSCREW. The ring still supplies the AXIS; the road spirals
    // around the inside of it. Two full turns, so it leaves upright -- a
    // half-turn would hand the next node a 180-degree up-vector flip and the
    // bake would (correctly) refuse it.
    if (inSpan(u, corkFrom, corkTo)) {
      const span = corkTo - corkFrom
      const f = (u - corkFrom) / span
      const th = 2 * Math.PI * CORK_TURNS * f
      const rx = Math.cos(p.heading), rz = -Math.sin(p.heading)
      // THE SPIRAL RADIUS RAMPS IN AND OUT, and this is not styling.
      //
      // At a constant radius the helix starts at its full ANGULAR rate on its
      // very first node, so the road steps sideways almost as fast as it moves
      // forward -- a 45-degree kink at each mouth, which the sim read as a 22m
      // -radius corner in the middle of what is supposed to be a flat-out set
      // piece. Nothing in the roster can hold 22m; the AI braked for a corner
      // that was not there and the field piled into the entry.
      //
      // Ramping the radius over the outer 35% at each end keeps the lateral
      // rate under 0.16 m/m throughout. The road spirals OUT of the centreline
      // and back INTO it, which is also what a corkscrew actually looks like:
      // the tube has mouths, not a step. The angular sweep is untouched, so it
      // still leaves upright after exactly two turns.
      const rawEnv = Math.max(0, Math.min(1, Math.min(f / 0.35, (1 - f) / 0.35)))
      const rEff = CORK_R * rawEnv * rawEnv * (3 - 2 * rawEnv)
      out.push({
        p: [
          r1(p.x + rEff * Math.sin(th) * rx),
          r1(y + rEff - rEff * Math.cos(th)),
          r1(p.z + rEff * Math.sin(th) * rz),
        ],
        w: 17,
        up: [r3(-Math.sin(th) * rx), r3(Math.cos(th)), r3(-Math.sin(th) * rz)],
        surface: 'metal',
        boost: f > 0.42 && f < 0.58,
        tag: f === 0 ? 'corkscrew' : undefined,
      })
      continue
    }

    // ---- ORDINARY ROAD.
    const onAsh = inSpan(u, BEATS.ashBeds[0], BEATS.ashBeds[1])
    const gustNow = envelope(u, BEATS.updraft[0], BEATS.updraft[1], 0.30)
    const node: TrackNode = {
      p: [r1(p.x), r1(y), r1(p.z)],
      w: r1(width(u, p.k)),
    }
    if (onAsh) node.surface = 'gravel'
    // Bank INTO the corner, scaled by how tight it actually is. `bank` and not
    // `up`: this is level ground that leans, not anti-gravity architecture, and
    // a banked node with world-up keeps plain world gravity on a jump.
    const bank = clamp(-p.k * 1150, -13, 13)
    if (Math.abs(bank) > 0.6) node.bank = r1(bank)
    // THE UPDRAFT KEEPS ITS WALLS. The first draft made the crosswind and the
    // drop the same beat -- wind over `open` road, so being blown wide meant
    // falling off the rim. Measured: 16.3 respawns a race against 0.0-0.7 on
    // every shipped circuit, and all 49 of them inside this one stretch. That
    // is not difficulty, it is a section the field cannot survive.
    //
    // The wind stays and the edge gets barriers. Being blown into a wall you
    // bounce off is a beat; being blown off a cliff is a loading screen. It
    // also now reads WITH the drift rules rather than against them -- contact
    // no longer ends a slide, so fighting the gust against the barrier is
    // something a driver can actually commit to.
    if (gustNow > 0.02) { node.wind = r1(13 * gustNow); node.bounce = true }
    if (Math.abs(u - BEATS.fissure) < 0.012) { node.ramp = 30; node.boost = true; node.tag = 'fissure' }
    if (inSpan(u, BEATS.fissure + 0.012, BEATS.fissure + 0.05)) node.open = true
    if (inSpan(u, 0.90, 0.97)) node.bounce = true
    if (Math.abs(u - BEATS.ashBeds[0]) < 0.005) node.tag = 'ashbeds'
    if (Math.abs(u - 0.92) < 0.005) node.tag = 'last-corner'
    if (u === 0) node.tag = 'start'
    out.push(node)

    // ---- THE LAVA TUBE. Inserted AFTER the ring node it hangs off, and it
    // has zero plan displacement: the road climbs, inverts and comes back down
    // onto its own entry point. tools/probe-loop.ts measures the deck's
    // self-projection error at 0.00m there and puts a full field of eight over
    // the top with no respawns, which is the only reason this is allowed to
    // exist -- two decks stacked 80m apart is exactly the case that breaks a
    // nearest-sample search.
    if (Math.abs(u - BEATS.lavaTube) < 0.5 / n) {
      const dx = Math.sin(p.heading), dz = Math.cos(p.heading)
      for (let s = 1; s < LOOP_STEPS; s++) {
        const th = (2 * Math.PI * s) / LOOP_STEPS
        // A PURE vertical loop returns to its own entry point, which means its
        // last node sits BEHIND the entry and the road then has to jump forward
        // to the next ring node -- a fold, measured as a 43m chord against a
        // 26m ring and a phantom 26m-radius "corner" that nothing could drive.
        // So the loop ADVANCES by exactly one ring spacing over the revolution:
        // it comes back down onto the next node along instead of onto itself.
        const fwd = LOOP_R * Math.sin(th) + SPACING * (th / (2 * Math.PI))
        out.push({
          p: [r1(p.x + fwd * dx), r1(y + LOOP_R - LOOP_R * Math.cos(th)), r1(p.z + fwd * dz)],
          w: 18,
          up: [r3(-Math.sin(th) * dx), r3(Math.cos(th)), r3(-Math.sin(th) * dz)],
          surface: 'metal',
          tag: s === LOOP_STEPS / 2 ? 'lavatube-apex' : s === 1 ? 'lavatube' : undefined,
        })
      }
    }
  }
  return out
}

/** Road half-width. Wide on the ash, pinched at the rim and the last corner. */
function width(u: number, k: number): number {
  let w = 21 - 4 * Math.min(1, Math.abs(k) * 90)
  if (inSpan(u, BEATS.ashBeds[0], BEATS.ashBeds[1])) w += 3.5
  if (inSpan(u, BEATS.updraft[0], BEATS.updraft[1])) w -= 1.5
  if (inSpan(u, BEATS.start[0], BEATS.start[1])) w += 2
  return clamp(w, 15, 25)
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const r1 = (v: number) => Math.round(v * 10) / 10
const r3 = (v: number) => Math.round(v * 1000) / 1000

export const EMBERFALL: TrackDef = {
  id: 'emberfall',
  name: 'Ashkar',
  skyTop: 0x1a0806,
  skyBottom: 0x6b1f12,
  fogColor: 0x53200f,
  fogDensity: 0.0052,
  sunColor: 0xffb27a,
  sunIntensity: 1.05,
  ambientColor: 0x6a2412,
  ambientIntensity: 0.85,
  sunDirection: [-0.35, 0.55, -0.75],
  palette: { a: 0x2b211f, b: 0x6e3a24, c: 0xa8502a, accent: 0xff6a18 },
  nodes: build(),
  // Rows sit ON the driven line and at or above the 2.4m box mesh, for the
  // reason the other four circuits all record: `stepAI` has no item-seeking
  // term, so a row taken off the line is a row the AI never touches.
  itemBoxRows: [
    { at: 0.10, count: 5, spread: 4.4 },
    { at: 0.30, count: 5, spread: 4.6 },
    { at: 0.46, count: 4, spread: 4.0 },
    { at: 0.74, count: 5, spread: 4.4 },
    { at: 0.88, count: 5, spread: 4.2 },
  ],
  chargeRuns: [
    { from: 0.03, to: 0.08, count: 6, lateral: -5 },
    { from: 0.26, to: 0.33, count: 8, lateral: 5 },
    { from: 0.36, to: 0.41, count: 6, lateral: -6 },
    { from: 0.53, to: 0.58, count: 6, lateral: 0 },
    { from: 0.78, to: 0.85, count: 7, lateral: -5 },
  ],
  laps: 3,
}
