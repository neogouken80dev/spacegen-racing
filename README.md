# SpaceGen Racing

An 8-player arcade combat racer that runs in a browser tab. Kart-racer
mechanical spine — drift-charged boost, position-weighted item chaos, 3-lap
sprints — with sci-fi vehicles across three genuinely different locomotion
classes.

Design doc: the full GDD lives in Notion (see the project index).

## Quick start

```
npm install
npm run dev        # http://localhost:5173
npm run build      # production build into dist/
npm run verify     # typecheck + unit tests + determinism gate
npm run balance -- --races=600 --assert   # the Phase 2 balance gate
node tools/smoke.mjs              # real-browser smoke test, desktop
node tools/smoke.mjs --mobile     # real-browser smoke test, mobile viewport
node tools/smoke.mjs --reduced-motion   # ...as a prefers-reduced-motion user

npx vite build --config vite.single.config.ts   # one self-contained HTML file
node tools/build-artifact.mjs                   # wrap it for an embed host
```

## Deploying

Netlify, built from this repo. `netlify.toml` is the whole configuration:
`npm run build` into `dist/`, Node 22, immutable caching on the hashed bundles,
`must-revalidate` on `index.html` and the service worker so a new deploy is
picked up rather than served stale, and an SPA redirect.

Note that the build command is `tsc --noEmit && vite build`, so **a type error
fails the deploy** instead of shipping a broken bundle. That is deliberate.

Playwright is a devDependency used only by `tools/smoke.mjs`, which runs locally
against a real Chromium. `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` is set in
`netlify.toml` so CI does not pull ~150MB of browsers it will never open.

First-time setup:

```
git remote add origin git@github.com:<you>/spacegen-racing.git
git push -u origin main
```

then in Netlify: the `spacegen-racing` project -> Site configuration -> Build &
deploy -> Link repository. Every push to `main` deploys itself after that.

To verify a deploy the way CI will, from a clean tree:

```
npm ci && npm run build
```

## Architecture

The one rule everything else depends on: **`src/sim` has zero imports from
three.js, the DOM or the network.** It is a pure fixed-timestep simulation —
input in, state out — that runs headless in Node. That is what makes the
determinism gate, the 600-race balance simulation and future server-authoritative
multiplayer all possible. There is a test that enforces it.

```
src/sim/       Pure TS simulation. Fixed 60 Hz timestep, seeded RNG,
               deterministic state hash.
  math.ts      Allocation-free vector math on plain objects
  rng.ts       mulberry32 + FNV-1a state hashing
  track.ts     Catmull-Rom spline baked to fixed arc-length samples
  vehicle.ts   The driving model: accel curve, 4-tier drift, boost stacking,
               locomotion classes, walls, off-track
  ai.ts        AI racers driving the same InputFrame a human does
  race.ts      Orchestration: items, collisions, ranking, laps, watchdogs
src/render/    three.js. Reads sim state, never writes it.
  vehicles.ts  Procedural chassis + pilot meshes, 4 LODs, GLB swap hook
  trackMesh.ts Track ribbon generated from the same spline the physics uses
  environment.ts  Sky, terrain, instanced junkyard props
  entities.ts  Item boxes, pickups, projectiles, mines, wells, start gate
  vfx.ts       One pooled instanced-quad particle system, shader-driven
  postfx.ts    Bloom, speed blur, vignette, chromatic aberration
src/ui/        HUD and front-end. DOM, built once, mutated per frame.
src/game/      Glue: input, camera, game loop, quality scaler
src/content/   All tuning data. No gameplay magic number lives anywhere else.
tools/         headless.ts (determinism gate), balance.ts (balance gate),
               smoke.mjs (real-browser test)
```

## Tuning

Every gameplay constant is in `src/content/tuning.ts`, and chassis stats are
the designer-facing 1-10 scale in `src/content/chassis.ts`. Physical values
derive by published formula:

```
topSpeed_mps      = 46.0 + TopSpeed  * 2.20
timeToTop_s       =  6.4 - Accel     * 0.34
lateralGrip_coeff = 0.55 + Grip      * 0.075
mass_kg           = 400  + Mass      * 180
driftChargeMult   = 0.70 + Drift     * 0.06
maxYawRate_degps  = 55   + Handling  * 9
```

`window.__TUNING__` is exposed at runtime for live poking in devtools, and
`window.__GAME__` gives access to the running `Race`.

## Gates

| Gate | Command | Asserts |
|---|---|---|
| Determinism | `npm run headless -- --assert` | Identical state hash over 600 frames from a fixed seed |
| Unit + purity | `npx vitest run` | Sim math, item table, track geometry, `src/sim` purity |
| Balance | `npm run balance -- --races=600 --assert` | Chassis win share 12-30%, lead retention 45-55%, lap times 55-75s |
| Steering | `npx vitest run tests/steering.test.ts` | Steering right moves the car to the player's right, and the vehicle and track bases agree |
| Drift | `npx vitest run tests/drift.test.ts` | Counter-steering shapes the slide instead of ending it; boost scales with hold time |
| Ramps | `npx vitest run tests/ramps.test.ts` | Every ramp is landable by every chassis with the air control available |
| Gatling | `npx vitest run tests/gatling.test.ts` | Sustained tracking breaks a target; breaking line of sight bleeds it off |
| Walls | `npx vitest run tests/walls.test.ts` | A bounce wall redirects momentum and can never create it |
| Recovery | `npx vitest run tests/recovery.test.ts` | A spin ends pointing down the track; the wrong-way rescue never fights the player |
| Browser | `node tools/smoke.mjs` | Real Chromium: renders, races, zero console errors |

`tools/balance.ts` takes `--tune=drift.arcBase=1.6,chassis.dray9.grip=5` to sweep
tuning or roster values for one run without editing source. Sweep with it; never
ship a value that only exists on a command line.

## Deploying

`netlify.toml` is configured for a Netlify build (`npm run build` → `dist`).
Connect the repo in the Netlify UI, or run `netlify deploy --prod --dir=dist`
after `netlify login`.

A single self-contained HTML build (everything inlined, ~820 KB) is produced by
`npx vite build --config vite.single.config.ts` into `dist-single/`.

## Coordinate convention

Read this before touching anything that has a left or a right in it.

Yaw is defined so `forward = (sin y, 0, cos y)`, matching
`Track.yawAt() = atan2(tangent.x, tangent.z)`.

**Right is `forward x up`.** At yaw 0 that is world **-X**, not +X. `Track`
uses this, the chase camera puts it on screen-right, and the HUD warning arcs
use it. `vehicle.ts` originally used +X, which silently inverted the steering:
the car turned left when the player steered right.

Because `d(forward)/d(yaw) = -right`, **turning toward right decreases yaw**.
That is what `STEER_SIGN` in `src/sim/vehicle.ts` encodes. Anything that reads
`yawRate` and compares it to `driftSide` must account for the two having
opposite signs for the same steering input — the vehicle body lean and the
camera roll both do.

`tests/steering.test.ts` guards all of this. It fails if `STEER_SIGN` is
flipped back.

## Drift model

Counter-steering **controls** the slide, it does not end it. While drifting,
`driftInward` maps the stick continuously from 0 (full counter-steer: wide,
shallow, nearly straight) to 1 (full lock: tight arc, hard crab). It drives the
arc rate, the crab angle, the charge rate and the spark fan together. The only
things that end a drift are releasing the button, dropping below
`minSpeedToDrift`, or a hard collision.

Boost has two components. **Magnitude** is the tier reached, in four discrete
steps, so the visual language stays legible. **Duration** is the tier's base
plus `driftCharge * durationPerSecond`, capped at `durationBonusCap` — so
committing to a long slide pays more than scraping into a tier and letting go.

**Entry rotates the car; it never throws it sideways.** The slide angle may not OPEN
faster than the nose is rotating (`slideYawLinked`). The two are the same motion seen from
different frames: if the nose turns by dPsi and the car keeps travelling exactly where it
was, the slide angle grows by exactly dPsi, so anything faster is the velocity being shoved
outward — a lateral lurch off the line, which is what "the tail kicks out" actually is.
Measured: 0.000 degrees of outward travel-direction swing on every chassis. Only the rise is
capped; the angle may close at full `slideResponse`, which is grip recovering under
counter-steer and throws the car nowhere.

**The arc eases off as the slide is held** (`arcSustain` 0.78, `arcEaseTime` 0.55s). A
constant yaw rate is a constant-radius spiral, so an arc that never eases keeps winding
tighter relative to the road until the car is aimed at the inside barrier — the turn-in was
never the problem, holding it was. 0.78 is the floor: at 0.72 Vector-7's sustained drift yaw
falls under the 1.35x-of-steering-lock guarantee and the drift stops being worth taking.

**The stick has three positions, not two.** Full lock carves, the centre HOLDS the slide at
`arcNeutral`, full counter-steer opens the line. A single lerp from `arcCounter` to full lock
puts the arc's SIGN FLIP wherever those two happen to cross — at `arcCounter` -0.34 that
lands within 0.04 of dead centre, so letting go of the steering key throws the car the other
way.

**The drift takes hold on the frame you press it.** `driftEntry` marks the entry
frame, and on that frame both the yaw rate and the crab jump straight to their
commanded values instead of easing in over the steering half-life. Measured on
the flat ring: 1 frame to 90% of the sustained slide angle, against 19 frames
(317 ms) before — that lag was the "initial slide" the drift used to open with.
The snap changes direction only: speed delta across the entry frame is 0.000 m/s
and the position delta is unchanged, so nothing is manufactured or teleported.

**Counter-steer is a real control**, not a token. `arcCounter` went -0.085 -> -0.34: the nose
now swings out at about a third of the lock arc, worth 45-52 m of outward travel over 1.6s
against 38-50 m the other way at lock. It cannot go much further — counter-steer must never
out-rotate the drift itself, or flicking the stick becomes a faster way round a corner than
committing to the slide.

**Entry honours the stick.** The entry seeds `driftInward` from the stick with the
same mapping every later frame uses. Seeding full lock instead was invisible while
entry eased in, but once it snaps it becomes a one-frame flick to 2.48x the
sustained yaw rate on a quarter-stick entry — and a quarter stick is the normal
case, since keyboard steering ramps over 120 ms and pad, touch and tilt are analog.

`arcBase` + `arcPerYaw * maxYawRate` sets the full-lock arc. Both were raised for
a tighter drift: the traced path radius fell 15-16% across the whole roster (for
example Solaire 34.2m -> 29.0m at 55 m/s), and a drift now out-turns the same
chassis's best steering lock by 1.76-2.32x.

Unit-tested on `tests/fixtures/testTrack.ts`, a huge flat ring, so the tests
measure the drift model rather than Rustfall's walls.

## Spin and wrong-way recovery

A spin is two phases. For the first `spinTime - spinAlignTime` seconds it rotates
freely at `spinRate` so the hit reads as a spin-out; for the last
`spinAlignTime` the tail unwinds toward `track.yawAt()`, so the car comes to rest
pointing down the track instead of wherever the rotation happened to stop.
Measured across 76 organic spins in 8-car races: mean 4.7 degrees of heading
error at spin end, worst case 11.9. From a cold 180-degree start: worst 12.7.

The separate wrong-way block is a **last resort for an idle car**, and it is gated
on the controls being idle, not on speed alone. `wrongWayRate` out-rotates every
chassis's own steering authority, so armed on a speed gate alone it simply
overrides the player: measured, a player holding full lock could not hold any
heading past `wrongWayAngle`, and a player deliberately reversing was rotated 81
degrees inside 0.75s (a reverse always starts from a standstill, so a speed gate
never protects it). `tests/recovery.test.ts` pins both directions of this.

## Booster ramps

`TrackNode.ramp` is an upward launch velocity in m/s, baked into a discrete
18m deck (`RAMP_HALF_LENGTH`) rather than smeared between nodes. Crossing one
sets `ballisticTime`, which forces a gravity arc for **every** locomotion class
— without it the hover and flight classes' altitude damping cancels the launch
and they never leave the deck.

Placement is validated, not eyeballed: `tests/ramps.test.ts` checks that the
heading change each flight demands is inside the air-control budget for every
chassis at max boosted speed, that no ramp fires into an unlandable corner, and
that all four are spread around the lap.

## The AI drives on curvature inside a slide

Outside a drift the AI steers on a NOSE heading error to a lookahead point. Inside one it
does not, because the nose leads the direction of travel by up to 32 degrees and a
heading-error controller reads that as over-rotation and asks for opposite lock. Measured on
the shipped AI before the fix: **49.6% of all drift frames were spent on the counter-steer
side of the stick**, with a median sustained run of 750 ms — the AI was driving half of every
drift on counter-steer it never meant to give. That was harmless while counter-steer was a
token -0.085 of the arc; at -0.34 it drove Vector-7 off the road 4.7 times a race for a 0.0%
win share.

While drifting, the stick now comes from the path curvature the car needs: pure pursuit off
the VELOCITY heading (`kappa = 2 sin(alpha) / L`), converted to a yaw rate, then inverted
through the arc mapping, which is monotonic. This is stable where offsetting the heading
target by the measured crab is not — alpha feeds a CURVATURE, not a heading, so there is no
"increase the nose lead" term to run away with, and `slideYawLinked` independently guarantees
the travel direction cannot swing away from the corner. Nose-to-target error on drift frames
fell 27.4 -> 8.8 degrees; drifts per race halved while Tier 3 Singularity went from 1.1% to
11.3% of them.

## A note on tuning the AI

Three plausible-looking AI changes were measured and reverted, because the
balance gate said they were wrong:

- Normalising steer against a fixed reference rate instead of the chassis's own
  `maxYawRate` makes heavy chassis understeer — Bulwark fell to 2.7% win share.
- Forcing a steer floor to guarantee drift entry makes every car oversteer:
  drifts per race doubled and 80% of them reached no tier at all.
- Buffing Vector-7's handling made it *worse* (11.2% → 6.3%), because higher
  handling means a smaller steer output, which fell under the drift-entry
  threshold.

What actually worked was removing the steer-magnitude gate on the AI's drift
*decision*, so it commits based on the corner rather than on a number that
happens to scale with its own handling stat. Run `npm run balance` before and
after any AI change; intuition is unreliable here.

**The AI steers on two different laws, and the split matters.** Outside a drift
it aims its NOSE at a lookahead point, which is correct — with no crab the nose
and the direction of travel are the same line. Inside a drift they are not: the
nose leads the travel direction by 18-19 degrees on average, and a heading-error
controller reads that lead as over-rotation and answers with opposite lock. That
was survivable while `drift.arcCounter` was a token -0.085; once counter-steer
became a real control at -0.34 the AI drove itself off the road with it, and the
gate went to a 45%/0% win split with Vector-7 respawning 4.7 times a race.

While drifting, the AI now picks its stick from the PATH CURVATURE it needs —
pure pursuit measured off the velocity heading, `kappa = 2 sin(alpha) / L`,
converted to a yaw rate and fed backwards through the (invertible) stick-to-arc
mapping in `vehicle.ts`. See `T.ai.driftPursuitGain`. Aiming the velocity by
OFFSETTING the nose target instead is the trap: steering to increase the nose
lead increases the crab, which increases the offset, and it diverges. A
curvature has no such term.

One consequence worth knowing before you tune the drift: the AI now inverts
`drift.stickCurve` exactly, and saturates against the ends of the stick on under
5% of drift frames. The drift block is no longer a back-door balance lever — it
changes what the player feels, and win share now moves in `chassis.ts`, which is
where it belongs.

## Collision and terrain invariants

**The wall clamps the BODY, not the centre point.** `bodyInset(chassisId)` is the chassis
half-width plus a margin, and both the in-step wall block and `clampToTrack()` inset by it.
Clamping the centre to the wall line leaves half the car buried in the barrier, which is what
"vehicles clipping outside the track walls" actually looks like on screen.

**Anything that moves a racer after `stepVehicle` must re-apply `clampToTrack()`.** Racer-vs-racer
collision resolution runs after the vehicle step and knows nothing about the barrier, so two cars
running side by side simply push each other through it. Measured before the fix: 73,780 frames
past the wall across 25 races. After: 10, all of them legitimately airborne off a ramp.

**A bounce wall may redirect momentum; it may never create it.** The response works in
the (tangent, normal) frame and is then capped at the speed carried in, so a square-on hit
can convert its whole into-wall component into travel along the wall and no more. Two
different forms of this have shipped broken: scaling the whole velocity (a scrape multiplied
itself every contact frame), and adding a tangential push on top of a full reflection — the
reflection has already cancelled the into component, so the push was free energy, worth
`into * bounceWallForward` every frame a car held a line against the barrier. It pumped the
field to the hard `SPEED_CEILING` of 120 m/s against a design maximum of ~108.

**Respawn relocates immediately, not at the end of the window.** Holding the racer at the point of
failure left a car sitting motionless on the terrain outside the barrier for nearly two seconds.

**Terrain height must be derived in the ribbon's banked frame.** `Track.surfacePoint(s, lat)` is
`pos + right * lat`, and `right.y` is non-zero wherever the track banks — on Rustfall's 34 degree
cargo ring the low edge of the road sits 6.1m below its own centreline, so a ground height of
`centreY - tuck` ended up 3.3m ABOVE the road it was supposed to be under.
