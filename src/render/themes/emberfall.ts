/**
 * ASHKAR — volcanic shield planet.
 *
 * ---------------------------------------------------------------------------
 * THE VALUE PROBLEM ON A PLANET MADE OF LIGHT.
 *
 * GDD 09: "Track environments sit in the mid-to-dark band so vehicles and VFX
 * always pop. If a track section washes out the racers, the track is wrong."
 * Cryostatic's header records how an ice planet breaks that rule by being
 * bright. A lava planet breaks it the other way and worse, because lava is
 * EMISSIVE: it is not merely pale, it survives the bloom threshold and blooms,
 * and the first grey-box had glowing ground over a third of the frame with the
 * racers reduced to silhouettes crossing it.
 *
 * The answer is that this planet is almost entirely COLD. It is basalt, ash and
 * obsidian -- albedos from 0.06 to 0.34, darker on average than any other
 * circuit in the game -- and the lava is a THIN, RARE, BRIGHT line threaded
 * through it: fissures a couple of metres wide, the glow inside a vent, the
 * underside of the ash cloud. Emissive area is the budget, not emissive
 * brightness, and the budget is small.
 *
 * That inversion is also what makes the planet read as a volcano rather than as
 * an orange room. A lava field photographs as black rock with cracks of light
 * in it; the light is shocking precisely because there is so little of it.
 *
 * Concretely: every albedo below sits between 0x14 and 0x6e on its brightest
 * channel. The palest chassis in the game (Filament, 0xdfe6ee) is 0.88. The
 * three things allowed to be bright are the fissure lines, the sky's horizon
 * band, and the ember motes.
 *
 * ---------------------------------------------------------------------------
 * THE HERO SKY.
 *
 * The planet the shield is a moon OF -- a banded gas giant with a ring system,
 * sitting low and enormous on the horizon behind the caldera. It is the reason
 * the sky is lit at all on the night side of the track, it gives the horizon
 * band something to be, and it is drawn in the dome's fragment shader for zero
 * draw calls and zero depth work (see the Celestial block in kit.ts).
 *
 * Beats and what each one gets:
 *   1  start / basalt apron   flow ridges, cooled pillow lava, vent gantries
 *   2  the fissure jump       a lit crack under the ramp, spatter cones beyond
 *   3  the ash beds           dune fields, standing dead spires, drifting ash
 *   4  the Lava Tube          the loop: a basalt tube with a molten seam
 *   5  the Corkscrew          a lava tube bored through the shield, lit inside
 *   6  the caldera rim        the updraft: ash streamers and the gas giant
 */
import * as THREE from 'three'
import {
  bindSurfaceSpray, loopHoop, merge, mulberry32, part, xf,
  type FrameInfo, type Palette, type PropSpec, type SurfaceSprayTable,
  type TerrainPoint, type Theme, type ThemeContext,
} from './kit'

/* ------------------------------------------------------------- the values */

/** Cold basalt. The darkest ground in the game, and most of the frame. */
const BASALT = 0x1c1614
const BASALT_LIT = 0x342825
/** Weathered scoria — the red-brown that says "oxidised" without saying "hot". */
const SCORIA = 0x5c3320
/** Ash. A mid warm grey; the only genuinely light ground, and it is still 0.34. */
const ASH = 0x574b45
const ASH_LO = 0x392f2b
/** Obsidian: near-black with a hard specular. Used for edges, never for fields. */
const OBSIDIAN = 0x14101a
/** The three bright things. */
const LAVA = 0xff5a10
const LAVA_CORE = 0xffa848
const EMBER = 0xff8a3c
/** The seams in the road. Deliberately dim -- see the veins block in `landmarks`. */
const VEIN = 0xb04408
/** The full-width wash that stops the deck reading as a hole. Barely a colour. */
const WASH = 0x241008

/* ------------------------------------------------------------------ props */

/** A basalt column cluster: hexagonal jointing, the signature of a cooled flow. */
function propColumns(pal: Palette, seg: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const rnd = mulberry32(0x10ba51)
  for (let i = 0; i < 7; i++) {
    const h = 5 + rnd() * 13
    const r = 1.0 + rnd() * 0.8
    const a = rnd() * Math.PI * 2
    const d = rnd() * 3.4
    parts.push(part(
      new THREE.CylinderGeometry(r * 0.92, r, h, 6, 1),
      i % 3 === 0 ? BASALT_LIT : BASALT,
      xf(Math.cos(a) * d, h / 2, Math.sin(a) * d, rnd() * Math.PI, (rnd() - 0.5) * 0.10, 0),
    ))
  }
  void pal; void seg
  return merge(parts)
}

/** A spatter cone: a squat vent with a lit throat. */
function propVent(pal: Palette, seg: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  parts.push(part(new THREE.ConeGeometry(4.6, 6.2, Math.max(7, seg >> 1), 1, true), SCORIA, xf(0, 3.1, 0)))
  parts.push(part(new THREE.ConeGeometry(3.1, 4.0, Math.max(6, seg >> 2), 1, true), BASALT, xf(0, 4.6, 0)))
  // The throat. Small, and the only emissive geometry in the scatter.
  parts.push(part(new THREE.CylinderGeometry(1.5, 1.9, 0.5, Math.max(6, seg >> 2)), LAVA, xf(0, 6.0, 0)))
  void pal
  return merge(parts)
}

/** A standing spire — a lava plug left when the cone around it eroded away. */
function propSpire(pal: Palette, seg: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const rnd = mulberry32(0x5915e)
  let y = 0
  for (let i = 0; i < 5; i++) {
    const h = 4.5 + rnd() * 5
    const r = 2.6 - i * 0.42
    parts.push(part(
      new THREE.CylinderGeometry(r * 0.8, r, h, Math.max(5, seg >> 2), 1),
      i > 2 ? OBSIDIAN : BASALT,
      xf((rnd() - 0.5) * 1.1, y + h / 2, (rnd() - 0.5) * 1.1, rnd() * 2, (rnd() - 0.5) * 0.06, 0),
    ))
    y += h * 0.92
  }
  void pal
  return merge(parts)
}

/** Obsidian shards: low, sharp, catches the key. Breaks up the ash flats. */
function propShards(pal: Palette, seg: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const rnd = mulberry32(0x0b51d1)
  for (let i = 0; i < 9; i++) {
    const h = 1.6 + rnd() * 4.4
    const a = rnd() * Math.PI * 2
    const d = rnd() * 5
    parts.push(part(
      new THREE.ConeGeometry(0.5 + rnd() * 0.8, h, 4, 1),
      rnd() < 0.3 ? SCORIA : OBSIDIAN,
      xf(Math.cos(a) * d, h / 2, Math.sin(a) * d, rnd() * 3, (rnd() - 0.5) * 0.5, (rnd() - 0.5) * 0.5),
    ))
  }
  void pal; void seg
  return merge(parts)
}

/** A collapsed lava tube: a broken basalt arch you can see daylight through. */
function propArch(pal: Palette, seg: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const R = 11, T = 2.4
  const s = Math.max(7, seg >> 1)
  // Two thirds of a torus, cut so it reads as fallen-in rather than built.
  parts.push(part(new THREE.TorusGeometry(R, T, 5, s, Math.PI * 1.15), BASALT, xf(0, 0, 0, 0, 0, -0.18)))
  parts.push(part(new THREE.CylinderGeometry(T * 1.2, T * 1.5, 5, 6), BASALT_LIT, xf(-R, 2, 0)))
  void pal
  return merge(parts)
}

/* ------------------------------------------------------------ ash spires */

/**
 * THE ASH BEDS' OWN SPIRES, AND WHY A `cluster` CANNOT PLACE THEM.
 *
 * These used to ride `cluster: { tag: 'ashbeds', span: 420 }`. The layout pass
 * that added the looper cut the gravel from 769 m to 236 m and the dressing
 * went on spilling over the basalt either side of it, which is the obvious
 * half of the problem. The other half is not obvious and does not go away by
 * shrinking the span.
 *
 * `cluster` is SYMMETRIC: environment.ts places at `clusterIdx` plus a uniform
 * draw in [-span/2, +span/2]. That is the right shape for a tag in the middle
 * of the thing it names. `ashbeds` is not: it marks where the beds BEGIN, and
 * it sits 11 m into a 236 m run with 225 m of gravel ahead of it. A symmetric
 * window centred there is about half gravel and half the basalt approach FOR
 * ANY SPAN -- measured, 53% at the old 420 and 53% at a "corrected" 236, and
 * the count that actually landed on gravel was 22 of 96. Tuning the number
 * changes how far the misplaced ones are thrown, not how many there are.
 *
 * So the gather stops being a window around a node and becomes what it always
 * meant: the stretch of GRAVEL the node opens. The run is walked off
 * `sample.surface`, which is the same field the spray table and the sim read,
 * so it tracks the beds through any future re-lay without a number in this
 * file to forget to update -- and it is the ash beds' own definition, not a
 * measurement of them. `landmark` appends to the spec's own InstancedMesh, so
 * all of this still costs exactly the draw call the scatter was already
 * paying for.
 */
function ashSpires(ctx: ThemeContext, push: (m: THREE.Matrix4, tint: THREE.Color) => void): void {
  const iTag = ctx.tagSample('ashbeds')
  if (iTag < 0) return
  const S = ctx.track.samples
  const m = S.length
  const res = ctx.track.length / m
  const N = (i: number): number => ((i % m) + m) % m

  // Gravel at, just before, or shortly after the tag. A node marking the start
  // of a bed can round to either side of the surface change, and a layout that
  // moves the tag a little should not silently stop dressing the beds.
  let seed = -1
  for (let d = -Math.round(12 / res); d <= Math.round(60 / res); d++) {
    if (S[N(iTag + d)].surface === 'gravel') { seed = N(iTag + d); break }
  }
  if (seed < 0) return
  let back = 0
  while (back < m && S[N(seed - back - 1)].surface === 'gravel') back++
  let fwd = 0
  while (fwd < m && S[N(seed + fwd + 1)].surface === 'gravel') fwd++
  const len = back + fwd + 1
  // Too short to be a bed, or so long it is the whole planet and the tag has
  // been put on something this routine has no business dressing.
  if (len * res < 40 || len > m * 0.5) return
  const i0 = N(seed - back)

  /**
   * Placed the way environment.ts places the scatter -- the prop's SHELL set
   * `gap` past the protected corridor, the lateral carrying its own scaled
   * radius, `clearOfTrack` with the same radius, sunk by the same fraction --
   * so a landmark spire and a scattered one are the same object standing the
   * same way, and the two cannot drift apart in look.
   */
  const RADIUS = 3.2, GAP = 3.0, SPREAD = 175, SINK = 0.35
  const want = Math.max(1, Math.round(30 * (ctx.quality.propDensity ?? 1)))
  const rnd = mulberry32(0xa5be05)
  let placed = 0, guard = 0
  while (placed < want && guard++ < want * 40) {
    const smp = S[N(i0 + Math.floor(rnd() * len))]
    const side = rnd() < 0.5 ? -1 : 1
    const tl = Math.hypot(smp.tangent.x, smp.tangent.z) || 1
    const rx = (smp.tangent.z / tl) * side, rz = (-smp.tangent.x / tl) * side
    const scl = 0.75 + rnd() * 1.35
    const lateral = ctx.corridor(smp.width) + RADIUS * scl + GAP + rnd() * SPREAD
    const x = smp.pos.x + rx * lateral, z = smp.pos.z + rz * lateral
    if (!ctx.clearOfTrack(x, z, RADIUS * scl)) continue
    const g = ctx.ground(x, z)
    _fe.set((rnd() - 0.5) * 0.10, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.10)
    _fq.setFromEuler(_fe)
    _fp.set(x, g.y - SINK * scl, z)
    _fs.set(scl, scl * (0.9 + rnd() * 0.3), scl)
    const tint = 0.62 + rnd() * 0.62
    push(
      new THREE.Matrix4().compose(_fp, _fq, _fs),
      new THREE.Color(tint, tint * (0.94 + rnd() * 0.12), tint * (0.88 + rnd() * 0.2)),
    )
    placed++
  }
}

/* ---------------------------------------------------------------- caldera */

/** Base radius of the cinder cone. Also what has to clear the road. */
const CALDERA_BASE_R = 210
/** Plan gap the base circle keeps from the protected corridor, metres. */
const CALDERA_CLEAR = 25
/** How far out the search is willing to walk before giving up, metres. */
const CALDERA_MAX = 900

/**
 * WHERE THE CINDER CONE STANDS, measured rather than written down.
 *
 * See the long note at the caldera block in `landmarks` for what this replaces
 * and why. Two questions, both answered off the ribbon:
 *
 *   WHICH CORNER   the tightest one in the first 500 m after `start`. The
 *                  layout calls its first corner the CALDERA HOOK and makes it
 *                  the tightest thing on the lap (r=50 against nothing else
 *                  under 60), so "tightest, early" picks it out without this
 *                  file needing a tag the tracks do not carry. Measured on the
 *                  current lap: s=247m, r=50m.
 *
 *   HOW FAR OUT    the first distance along that corner's own lateral at which
 *                  `clearOfTrack` says a CALDERA_BASE_R + CALDERA_CLEAR
 *                  footprint has left the lap. Both sides are walked and the
 *                  nearer wins, because the side that runs out of racetrack
 *                  first IS the outside of the corner. Measured: 270 m west
 *                  against 1150 m east, base clearing the road by 30 m.
 *
 * Null when nothing inside CALDERA_MAX clears -- a planet with no room for its
 * own mountain gets no mountain, rather than one parked on the racing line.
 */
function calderaSite(ctx: ThemeContext): { x: number; z: number } | null {
  const { track } = ctx
  const m = track.samples.length
  const i0 = ctx.tagSample('start')
  if (i0 < 0) return null
  const span = Math.round(500 / (track.length / m))
  let bestK = 0, iHook = -1
  for (let d = 0; d < span; d++) {
    const i = (i0 + d) % m
    const k = Math.abs(track.curvatureAt((i / m) * track.length, 20))
    if (k > bestK) { bestK = k; iHook = i }
  }
  if (iHook < 0) return null
  const smp = track.samples[iHook]
  const hl = Math.hypot(smp.right.x, smp.right.z) || 1
  let out: { x: number; z: number } | null = null
  let best = Infinity
  for (const side of [1, -1]) {
    const ox = (smp.right.x / hl) * side, oz = (smp.right.z / hl) * side
    for (let d = 120; d < best && d <= CALDERA_MAX; d += 5) {
      const x = smp.pos.x + ox * d, z = smp.pos.z + oz * d
      if (!ctx.clearOfTrack(x, z, CALDERA_BASE_R + CALDERA_CLEAR)) continue
      best = d; out = { x, z }
      break
    }
  }
  return out
}

/* -------------------------------------------------------------- landmarks */

function landmarks(ctx: ThemeContext): void {
  const { track, palette: pal, quality } = ctx
  bindSurfaceSpray(track, SPRAY)
  const m = track.samples.length

  /* ---- THE CALDERA. The landmark the whole planet is named for: a cinder
   * cone on the skyline, venting, standing on the outside of the corner the
   * layout names after it.
   *
   * It is ONE merged mesh at a fixed spot rather than an instanced prop,
   * because its whole job is to be in a particular place relative to a
   * particular corner. A cone that wanders is scenery; a cone you can brake
   * against is a landmark.
   *
   * -------------------------------------------------------------------------
   * IT USED TO BE THE PASSTHROUGH WALL, and it was reported from play as one:
   * "this strange passthrough wall ... do not have any tracks that clip into
   * the track". It was anchored 420 m off the `ashbeds` bearing, which put its
   * axis at (365, 0) -- and the road at (495, 130) is 184 m from there, inside
   * a 210 m base. The lap ran INSIDE the cone for 2526 m of its 4482, and
   * because the cone is `openEnded` you see straight through it except where
   * the deck crosses its shell, which is a rock face lying across the road.
   * `probe-intrude.ts`: 6.89 m inside the edge at s=1740m, 3.62 m above it.
   *
   * TWO THINGS WERE WRONG AND ONLY ONE OF THEM WAS THE NUMBER.
   *
   * 1. THE DISTANCE WAS WRITTEN DOWN. 420 was measured against a lap that has
   *    since been rebuilt at a much larger scale, and nothing re-measured it.
   *    Pushing it to 840 on the same bearing does clear every road point by
   *    25 m -- and puts a landmark 840 m from the corner it exists to frame,
   *    which is a different way of not having one. So the distance is MEASURED
   *    now: walk outward until `clearOfTrack` says the base has left the lap,
   *    and stop at the first place it does. That is the closest the cone can
   *    stand, and it re-measures itself the next time the layout moves.
   *
   * 2. THE ANCHOR WAS THE WRONG CORNER. `src/content/tracks/emberfall.ts`
   *    calls its first corner the CALDERA HOOK -- r=50, off the 235 m start
   *    straight, the tightest thing anybody authored on the lap -- so the
   *    mountain the planet is named for belongs on the outside of it, not off
   *    the ash beds 600 m later. That corner carries no tag of its own and the
   *    tag list is another worker's file, so it is found the way the layout
   *    describes it: the tightest corner in the first 500 m after `start`.
   *    Measured, that lands at s=247m, r=50m -- the hook, to the metre.
   *
   * WHICH SIDE IS THE OUTSIDE is not written down either. Both are walked and
   * the one that runs out of racetrack first wins, which is what "outside of
   * a corner" means. Measured here: 270 m to the west, against 1150 m to the
   * east, and the cone's base clears the road by 30 m.
   * ------------------------------------------------------------------------- */
  const site = calderaSite(ctx)
  if (site) {
    const { x: cx, z: cz } = site
    const g = ctx.ground(cx, cz)
    const parts: THREE.BufferGeometry[] = []
    const s = Math.max(9, ctx.seg)
    parts.push(part(new THREE.ConeGeometry(CALDERA_BASE_R, 190, s, 2, true), BASALT, xf(0, 95, 0)))
    parts.push(part(new THREE.ConeGeometry(96, 70, s, 1, true), SCORIA, xf(0, 205, 0)))
    // The vent: a shallow bowl of light, small against a 190m cone.
    parts.push(part(new THREE.CylinderGeometry(54, 42, 6, s), LAVA, xf(0, 228, 0)))
    // A smaller, hotter disc inside the vent. Two emissive values read as depth
    // where one reads as a painted circle.
    parts.push(part(new THREE.CylinderGeometry(26, 20, 4, s), LAVA_CORE, xf(0, 231, 0)))
    const geo = merge(parts)
    ctx.own(geo)
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.94, metalness: 0.04 })
    ctx.own(mat)
    const mesh = new THREE.Mesh(geo, mat)
    mesh.name = 'landmark-caldera'
    mesh.position.set(cx, g.y - 12, cz)
    mesh.frustumCulled = true
    ctx.add(mesh)

    /* ---- The eruption plume. Six big soft sprites stacked over the vent,
     * drifting with the wind. This is the same trick as Cryostatic's fog banks
     * -- one draw call pretending to be a participating medium -- but anchored
     * to the world rather than to the camera, because a plume that follows you
     * is not a landmark. ---- */
    const tex = plumeTexture()
    ctx.own(tex as unknown as THREE.Material)
    const pm = new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false,
      color: new THREE.Color(0x6a5a55), opacity: 0.40, fog: true,
    })
    ctx.own(pm)
    const plume = new THREE.Group()
    const puffs: THREE.Sprite[] = []
    for (let i = 0; i < 7; i++) {
      const sp = new THREE.Sprite(pm)
      const t = i / 6
      sp.position.set(0, 250 + t * 420, 0)
      const sc = 190 + t * 520
      sp.scale.set(sc, sc, 1)
      plume.add(sp)
      puffs.push(sp)
    }
    plume.position.set(cx, g.y - 12, cz)
    ctx.add(plume)
    // Rise and recycle. No allocation, and the phase is per-sprite so the
    // column churns instead of pulsing as one object.
    ctx.onUpdate((f: FrameInfo) => {
      for (let i = 0; i < puffs.length; i++) {
        const sp = puffs[i]
        let y = sp.position.y + f.dt * 11
        if (y > 700) y = 250
        sp.position.y = y
        const t = (y - 250) / 450
        const sc = 190 + t * 520
        sp.scale.set(sc, sc, 1)
        sp.position.x = Math.sin(f.time * 0.11 + i) * (24 + t * 130)
      }
    })
  }

  /* ---- THE MOLTEN SEAMS, one per loop, and why the loops need them at all.
   *
   * Photographed at the apex, the first Lava Tube came out very nearly black.
   * The corkscrew did not, and the difference is instructive: the corkscrew
   * carries a boost strip through its middle, and the emissive chevrons light
   * the whole bore from the inside. A loop has no strip -- it must not, because
   * a geodesic set piece that also hands out speed is a gift with no bill -- so
   * it had nothing lighting it at all. A headline set piece the player cannot
   * see is not a set piece.
   *
   * So each loop the layout tags gets a seam of molten rock concentric with it,
   * plus two warm point lights inside the bore. The ring is emissive and does
   * no lighting work by itself (that is what the bloom pass sees); the two
   * lights are what actually puts the road surface back in the frame. Geometry
   * is derived from each loop's own two tags rather than from the track's
   * constants -- the art layer reads content, it never imports it. ---- */
  const SEAM_TUBE = 1.1
  for (let li = 1; li <= 3; li++) {
    // Radius and sweep both come off the ribbon -- see `loopHoop` in kit.ts for
    // what the hand-written `loopR + corridor(width) + 3.5` was getting wrong
    // and how far into the road it put this seam. Measured: Cinder One is a
    // 38.5 m hoop over 325 degrees and Cinder Two a 44.7 m hoop over 326,
    // against 59.3 m and 66.3 m full circles that crossed their own feed roads
    // 10.01 m and 6.38 m inside the edge, 50-60 m before each loop's mouth.
    // The layout currently tags two; `loopHoop` answers null for a third.
    const hoop = loopHoop(ctx, `loop${li}`, `loop${li}-apex`, { tube: SEAM_TUBE, clear: 2.0 })
    if (!hoop) continue
    // Same arc-length per segment the full circle had, so the seam does not get
    // chunkier just because it is no longer closed.
    const seg = Math.max(12, Math.round(ctx.seg * 2 * (hoop.sweep / (Math.PI * 2))))
    const ringGeo = new THREE.TorusGeometry(hoop.radius, SEAM_TUBE, 5, seg, hoop.sweep)
    // A torus sweeps from its own +X; swing the whole geometry round to where
    // the clear window starts.
    ringGeo.rotateZ(hoop.from)
    ctx.own(ringGeo)
    const ringMat = new THREE.MeshBasicMaterial({ color: LAVA, fog: true })
    ctx.own(ringMat)
    const ringMesh = new THREE.Mesh(ringGeo, ringMat)
    // Named, because `probe-intrude.ts` reported this as `child#13
    // MeshBasicMaterial` and that is not something anyone can go and look at.
    ringMesh.name = `loop-seam-${li}`
    ringMesh.position.set(hoop.cx, hoop.cy, hoop.cz)
    // The torus lies in its own XY plane; stand it up and swing it to face
    // along the road, so it is concentric with the loop rather than crossing it.
    ringMesh.rotation.y = hoop.rotY
    ctx.add(ringMesh)

    if (quality.tier !== 'low') {
      for (const k of [-1, 1]) {
        const L = new THREE.PointLight(0xff7a2a, 3.0, hoop.loopR * 4.2, 1.6)
        L.position.set(
          hoop.cx + hoop.fx * k * hoop.loopR * 0.55, hoop.cy,
          hoop.cz + hoop.fz * k * hoop.loopR * 0.55,
        )
        ctx.add(L)
      }
    }
    // A slow breath, offset per loop so the three do not pulse in lockstep.
    const phase = li * 1.9
    ctx.onUpdate((f: FrameInfo) => {
      const g = 0.82 + 0.18 * Math.sin(f.time * 0.9 + phase)
      ringMat.color.setHex(LAVA).multiplyScalar(g)
    })
  }

  /* ---- MAGMA VEINS IN THE ROAD ITSELF.
   *
   * Reported directly: the track floor reads as "all black and unfinished".
   * That is the mid-to-dark rule taken one step too far -- basalt at 0x1c1614
   * under a weak key is a correct value for a volcanic road and an unreadable
   * one for a racing line, because nothing in the frame tells you where the
   * surface is between the barriers.
   *
   * The road's albedo cannot be the answer: `SURFACE_HEX` in trackMesh is a
   * GLOBAL shared with every circuit, so brightening basalt here would repaint
   * Elkarim. So the light goes ON the road as geometry the theme owns -- three
   * wandering seams of cooling crust, laid on the deck and following its
   * banking and its loops.
   *
   * DIM AND PULSING, on instruction and for a reason the file already knows:
   * this planet's entire emissive budget is meant to be thin, rare and bright,
   * and a glowing racing line competing with the cars would undo the value
   * separation the rest of the theme is built on. The veins sit at roughly a
   * third of the chassis' own luminance and breathe slowly, so they read as
   * ground the player can judge distance against rather than as a light.
   *
   * One mesh, one draw call, no depth writes -- it is a decal on a surface that
   * is already there, and writing depth would fight the road at grazing angles.
   */
  {
    const S = track.samples
    const STRIDE = 2

    /**
     * Two layers, and the first one is the actual fix.
     *
     * THE WASH is a single very faint warm sheet across the full road width. It
     * does almost nothing you can point at and it is the reason the deck stops
     * reading as a hole in the screen: basalt at 0x1c1614 under this planet's
     * weak key lands near black, and a surface with no value at all gives the
     * eye nothing to judge distance or camber against. At 0.07 it lifts the
     * road just off black without approaching the chassis, which sit an order
     * of magnitude brighter.
     *
     * THE CRACKS are the texture on top. The first version of these ran a heat
     * term at 0.0013 rad/m -- a 4,833m wavelength on a 3,152m lap, so "heat"
     * never completed a cycle and every seam came out as one unbroken red
     * stripe down the road. They now cycle every 40-90m, which is what makes
     * them cooling crust rather than a painted racing line, and there are six
     * thin ones instead of three fat ones.
     */
    const pos: number[] = []
    const col: number[] = []
    const idx: number[] = []

    const pushStrip = (
      lat: (s: number, w: number) => number,
      half: (s: number, w: number) => number,
      heat: (s: number) => number,
      tint: THREE.Color,
    ) => {
      const first = pos.length / 3
      let row = 0
      for (let i = 0; i <= S.length; i += STRIDE) {
        const smp = S[i % S.length]
        const s = i * 1.5
        const l = lat(s, smp.width)
        const h = half(s, smp.width)
        const g = Math.max(0, heat(s))
        for (const side of [-1, 1]) {
          const off = l + side * h
          pos.push(
            smp.pos.x + smp.right.x * off + smp.normal.x * 0.07,
            smp.pos.y + smp.right.y * off + smp.normal.y * 0.07,
            smp.pos.z + smp.right.z * off + smp.normal.z * 0.07,
          )
          col.push(tint.r * g, tint.g * g, tint.b * g)
        }
        if (row > 0) {
          const a0 = first + (row - 1) * 2
          idx.push(a0, a0 + 1, a0 + 2, a0 + 1, a0 + 3, a0 + 2)
        }
        row++
      }
    }

    // 1. The wash: the full drivable width at every sample, so it widens with
    // the road across the ash beds and pinches through the loops on its own.
    pushStrip(() => 0, (_s, w) => w * 0.98, () => 1, new THREE.Color(WASH))

    // 2. Six cracks. Offsets spread across the corridor, each wandering on its
    // own slow frequency and breaking into segments on a fast one.
    const CRACKS = [
      { off: -0.62, w: 0.55, wander: 0.0037, seg: 0.086, ph: 0.0 },
      { off: -0.30, w: 0.38, wander: 0.0061, seg: 0.124, ph: 1.3 },
      { off: -0.06, w: 0.62, wander: 0.0029, seg: 0.071, ph: 2.6 },
      { off: 0.22, w: 0.44, wander: 0.0052, seg: 0.103, ph: 3.9 },
      { off: 0.48, w: 0.58, wander: 0.0034, seg: 0.068, ph: 5.2 },
      { off: 0.71, w: 0.33, wander: 0.0071, seg: 0.141, ph: 0.7 },
    ]
    const crackCol = new THREE.Color(VEIN)
    for (const c of CRACKS) {
      pushStrip(
        // WANDER HARD. At 0.16 of a half-width the six seams ran parallel down
        // the deck and read as lane markings; at 0.34, with a second slower
        // term beating against the first, they cross each other and the road
        // reads as cracked ground instead of a painted circuit.
        (s, w) => (c.off + 0.34 * Math.sin(s * c.wander + c.ph)
          + 0.14 * Math.sin(s * c.wander * 0.41 + c.ph * 2.2)) * w,
        (s) => c.w * (0.6 + 0.6 * Math.abs(Math.sin(s * c.wander * 2.7 + c.ph))),
        // Sharpened hard so the seam is mostly DARK with bright stretches,
        // rather than a stripe that merely varies.
        (s) => Math.max(0, Math.sin(s * c.seg + c.ph) * 0.7 + 0.5 * Math.sin(s * c.seg * 2.3 + c.ph * 1.7)) ** 2.2,
        crackCol,
      )
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
    geo.setIndex(idx)
    geo.computeBoundingSphere()
    ctx.own(geo)
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true, fog: true, transparent: true, opacity: 0.5,
      depthWrite: false, blending: THREE.AdditiveBlending,
    })
    ctx.own(mat)
    const mesh = new THREE.Mesh(geo, mat)
    mesh.renderOrder = 2
    ctx.add(mesh)
    ctx.onUpdate((f: FrameInfo) => {
      // Two beats at different rates so the pulse never looks metronomic, and
      // shallow: this is meant to be the ground breathing, not a strobe.
      mat.opacity = 0.44 + 0.10 * Math.sin(f.time * 0.7) + 0.05 * Math.sin(f.time * 1.9)
    })
  }

  /* ---- THE SKYLOOP FLYOVER. See `buildFlyover` below for the whole argument.
   *
   * Three tags or nothing. `tagSample` answers -1 for a tag no node carries, so
   * on a circuit that has not authored the looper yet -- which is every circuit
   * in the game the day this shipped -- the guard falls through and the theme
   * builds exactly what it built before: no geometry, no material, no hook. ---- */
  {
    const iLooper = ctx.tagSample('looper')
    const iApex = ctx.tagSample('looper-apex')
    const iOver = ctx.tagSample('overpass')
    if (iLooper >= 0 && iApex >= 0 && iOver >= 0) buildFlyover(ctx, iLooper, iApex, iOver)
  }

  /* ---- LAVA BOILING OFF THE FLATS.
   *
   * The planet's horizon was static: a lava field that never moves is a
   * painting of one. This is a pool of bursts scattered on the terrain well off
   * the road, each swelling out of the ground, brightening, and sinking back on
   * its own cycle -- one InstancedMesh, one draw call, matrices rewritten per
   * frame and nothing allocated.
   *
   * Placed with `clearOfTrack` so a burst can never erupt through the deck, and
   * kept to the middle distance: close enough to read through the fog, far
   * enough that its glow is graded most of the way onto the fog colour before
   * it reaches the frame. ---- */
  if (quality.tier !== 'low') {
    const N = Math.round(54 * (quality.propDensity ?? 1))
    const burstGeo = new THREE.SphereGeometry(1, 6, 5)
    ctx.own(burstGeo)
    const burstMat = new THREE.MeshBasicMaterial({ color: LAVA_CORE, fog: true })
    ctx.own(burstMat)
    const inst = new THREE.InstancedMesh(burstGeo, burstMat, N)
    inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    inst.frustumCulled = false
    const rnd = mulberry32(0xb0115)
    const spots: { x: number; z: number; y: number; r: number; t0: number; period: number }[] = []
    const m = track.samples.length
    let guard = 0
    while (spots.length < N && guard++ < N * 40) {
      const smp = track.samples[Math.floor(rnd() * m)]
      const tl = Math.hypot(smp.tangent.x, smp.tangent.z) || 1
      const ox = smp.tangent.z / tl, oz = -smp.tangent.x / tl
      const side = rnd() < 0.5 ? -1 : 1
      const d = 60 + rnd() * 260
      const x = smp.pos.x + ox * d * side, z = smp.pos.z + oz * d * side
      const r = 3 + rnd() * 9
      if (!ctx.clearOfTrack(x, z, r + 6)) continue
      const g = ctx.ground(x, z)
      spots.push({ x, z, y: g.y, r, t0: rnd() * 6, period: 3.4 + rnd() * 4.6 })
    }
    const mtx = new THREE.Matrix4()
    for (let i = 0; i < N; i++) mtx.makeScale(0, 0, 0), inst.setMatrixAt(i, mtx)
    ctx.add(inst)
    ctx.onUpdate((f: FrameInfo) => {
      for (let i = 0; i < spots.length; i++) {
        const sp = spots[i]
        const t = ((f.time + sp.t0) % sp.period) / sp.period
        // Swell fast, sink slow: a burst is an eruption, not a sine wave.
        const rise = t < 0.25 ? t / 0.25 : Math.max(0, 1 - (t - 0.25) / 0.75)
        const k = rise * rise * (3 - 2 * rise)
        const sc = sp.r * (0.25 + 0.75 * k)
        mtx.makeScale(sc, sc * (0.45 + 0.9 * k), sc)
        mtx.setPosition(sp.x, sp.y - sp.r * 0.45 + sc * 0.8 * k, sp.z)
        inst.setMatrixAt(i, mtx)
      }
      inst.instanceMatrix.needsUpdate = true
    })
  }

  void pal; void m
}

/* ---------------------------------------------------------------- flyover */

/**
 * THE SKYLOOP'S FLYOVER, AND THE ONE THING A GENERIC BRIDGE CANNOT DO.
 *
 * The Skyloop is a plan-view looper: 360 degrees of right-hander hung off the
 * circuit whose late, high arc comes back over its own low feed road. It is a
 * bridge, and the renderer already knows how to build a bridge -- trackMesh's
 * `buildViaductPiers` grows a soffit and a row of steel bays under ANY deck
 * standing VIA_LO+ above the floor, on every track, and environment.ts drops
 * the terrain out from under it to match. None of that needs a theme and none
 * of it is repeated here; a second soffit would z-fight the first and a second
 * pier row would stand beside it arguing.
 *
 * What the generic bridge cannot do is be MADE OF ANYTHING. It is steel bays
 * and a flat plate, which is correct over Rustfall's junkyard and wrong over a
 * shield volcano, and it leaves three specific holes this theme fills:
 *
 *   THE UNDERSIDE HAS NO DEPTH. `emitSoffit` is one downward-facing plane at
 *   VIA_FOOT, which closes the deck and stops you seeing sky through it, and
 *   which from a car 25 m below is a flat ceiling with no scale in it. So the
 *   span gets a basalt EDGE BEAM down each flank and transverse ribs across
 *   the bay between them -- the thing that passes overhead and casts a shape.
 *
 *   THE DECK CANNOT CAST A SHADOW. trackMesh sets `castShadow = false` on
 *   every road chunk (it receives, it never casts), on every tier, so no
 *   amount of shadow quality will ever put shade on the road underneath. It
 *   is authored here instead, and authored as SKY occlusion rather than sun
 *   occlusion: this planet's key is scaled to 0.40 through the ash and most of
 *   what lights the deck is the hemisphere, so what a 49 m-wide slab 25 m up
 *   actually takes away is the dome -- which is directly beneath it, not
 *   thrown 38 m downsun where a hard shadow would land and where it would miss
 *   the road entirely.
 *
 *   NOTHING MARKS THE CROSSING AT SPEED. One dim molten seam along the beam's
 *   bottom edge, in VEIN -- the same deliberately-dim value the road's own
 *   cracks use, for the same reason the veins block gives at length. It is a
 *   line you read the span's width off at 70 m/s, not a light: this planet
 *   spends its whole emissive budget on three things and a bridge is not one
 *   of them.
 *
 * GEOMETRY IS MEASURED, NEVER AUTHORED. The span's extent is found by walking
 * out from `overpass` while the deck still overhangs the road beneath it, the
 * road beneath is found by searching near `looper`, and how far the walk may
 * run is bounded by the looper's own arc to `looper-apex`. Nothing here knows
 * a node count, a length or a position, so the geometry worker can move the
 * whole loop and the art follows it.
 *
 * COST: four draw calls (span, pylons, shade, seam), two of which share
 * `ctx.propMaterial` and add no material at all.
 */

/** Lateral overhang of trackMesh's soffit past the physics edge (`WALL_CAP` +
 *  0.12), and its depth below the surface on a viaduct (`VIA_FOOT`). Copied,
 *  not imported -- the same arrangement trackMesh and environment.ts already
 *  have over the viaduct test itself. Change those and change these. */
const SPAN_OUT = 0.67
const SPAN_SOFFIT = 0.90
/** The edge beam hanging under each deck flank: depth, and how far in it
 *  reaches from the soffit's outer edge. */
const BEAM_H = 2.60
const BEAM_W = 2.20
/**
 * How far the beam's top edge tucks ABOVE that soffit plate.
 *
 * Without it the two agree to the millimetre -- the beam's top corners land on
 * the soffit's own edge vertices, which is a clean butt joint for exactly as
 * long as `via` is 1 across the whole span. It is 1 across this one, but
 * `wallFoot` slides the plate from 0.90 m down to 2.7 m as `via` falls off,
 * and a plate that has dropped away from a beam pinned to where it used to be
 * leaves a slot you can see the sky through. A quarter of a metre of overlap
 * costs nothing, is never coplanar with anything, and makes the joint true for
 * every value the plate can take.
 */
const BEAM_RISE = 0.25
/** Transverse ribs: spacing along the span, and the depth band they occupy.
 *  The band is below trackMesh's pier cross-head (which bottoms out 2.20 m
 *  under the deck) and above the beam's own soffit, so the two never meet. */
const RIB_STEP = 12.5
const RIB_TOP = 2.45
const RIB_BOT = 3.45
/** How far the deck must stand over the road beneath to count as a span. */
const SPAN_CLEAR = 6.0
/** Structure carried past each end of the overlap, metres -- so the beams
 *  finish past the lower road's edge rather than stopping dead on it. */
const SPAN_ABUT = 9.0
/** Pylon lateral as a fraction of the deck's half-width -- outboard of
 *  trackMesh's own legs, which sit at 0.46 and reach 12.5 m. */
const PYLON_LAT_F = 0.86
/** Clearance a pylon keeps from every other part of the ribbon, metres. */
const PYLON_GAP = 3.0
/** Arc window around a pylon that counts as its own deck rather than as
 *  something it could foul. trackMesh uses 60 samples for the same job. */
const PYLON_SELF = 90
/** The shade under the span: peak darkening and how far it feathers past the
 *  deck's plan edge. */
const SHADE_PEAK = 0.46
const SHADE_PEN = 7.5
/** Width of the molten chamfer along the beam's bottom outer corner. */
const SEAM_W = 0.52

type Smp = ThemeContext['track']['samples'][number]

const _fa = new THREE.Vector3()
const _fb = new THREE.Vector3()
const _fn = new THREE.Vector3()
const _fp = new THREE.Vector3()
const _fq = new THREE.Quaternion()
const _fe = new THREE.Euler()
const _fs = new THREE.Vector3()
/** Filled by `nearestUnder`; module scope so the search never allocates. */
const _under = { d: 0, y: 0, w: 0, i: 0 }

function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x }
function smooth01(x: number): number { const t = clamp01(x); return t * t * (3 - 2 * t) }

/**
 * Emit a quad into `idx`, wound so that the face it makes points along
 * (ox,oy,oz) rather than away from it.
 *
 * DERIVED, NOT REASONED ABOUT, and this is not caution. The first version of
 * the molten seam picked its winding by hand and got it right -- on one flank.
 * The other flank is the mirror image, so the same vertex order describes the
 * opposite face and half the seam was back-face culled: invisible, no error,
 * nothing in a typecheck or a draw-call count that would ever say so. The
 * beams, the ribs and the corbels all have the same mirror in them, on a deck
 * that is banking and climbing and turning at the same time. One cross product
 * at build time settles all of it.
 */
function windQuad(
  p: number[], idx: number[],
  a: number, b: number, c: number, d: number,
  ox: number, oy: number, oz: number,
): void {
  _fa.set(p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2])
  _fb.set(p[c * 3] - p[a * 3], p[c * 3 + 1] - p[a * 3 + 1], p[c * 3 + 2] - p[a * 3 + 2])
  _fn.crossVectors(_fa, _fb)
  if (_fn.x * ox + _fn.y * oy + _fn.z * oz >= 0) idx.push(a, b, c, a, c, d)
  else idx.push(a, d, c, a, c, b)
}

/**
 * Build the flyover, or build nothing.
 *
 * Every exit below is silent and complete: no geometry is created before the
 * last test passes, so a tag that points somewhere the geometry does not
 * support leaves the theme exactly as it was.
 */
function buildFlyover(ctx: ThemeContext, iLooper: number, iApex: number, iOver: number): void {
  const S = ctx.track.samples
  const m = S.length
  const res = ctx.track.length / m
  const N = (i: number): number => ((i % m) + m) % m
  /** Separation between two samples along the lap, in samples, either way round. */
  const arcGap = (a: number, b: number): number => Math.abs(((b - a + m + m / 2) % m) - m / 2)

  /* ---- 1. WHICH ROAD DOES THE SPAN CROSS, AND WHERE EXACTLY.
   *
   * THE DECK ANCHOR IS `overpass` ITSELF, NOT A SEARCH.
   *
   * This used to hunt a window either side of the tag for the closest approach
   * in plan between the two decks, on the reasoning that a node is 15-20 m of
   * track and the tag is only roughly on the crossing. That reasoning holds
   * for a crossing you can see the angle of. Ashkar's does not have one: the
   * looper turns 441 degrees, so its exit comes back over the feed road at a
   * SKEW OF 18 DEGREES and runs within four metres of that road's centreline
   * for seventy metres. Over a near-parallel overlap the plan separation is a
   * near-tie along its whole length -- measured, 1.64 m at the tag against
   * 0.28 m fifty-seven metres downstream -- so "closest approach" stopped
   * meaning "the crossing" and started meaning "wherever the noise floor
   * happened to dip". It moved the span 57 m past the tag and aimed the
   * forward walk at the looper's SECOND crossing.
   *
   * A tag does not have that problem. `overpass` is the node the author chose
   * to mean "the bridge starts here", and it is the one piece of information
   * in this whole routine that is not a measurement. Take it, and walk FORWARD
   * only far enough to be genuinely over the road beneath -- which is d=0 on
   * the shipped layout, and which also covers a future tag placed at the foot
   * of the climb rather than on the crossing. ---- */
  const MIN_ARC = Math.round(90 / res)
  /** Plan distance from (x,z) to a stretch of lower deck, and that deck's
   *  height and half-width where it is closest. */
  const nearestIn = (win: number[], x: number, z: number): void => {
    let bd2 = Infinity, bk = 0
    for (let k = 0; k < win.length; k++) {
      const s = S[win[k]]
      const dx = x - s.pos.x, dz = z - s.pos.z
      const d2 = dx * dx + dz * dz
      if (d2 < bd2) { bd2 = d2; bk = k }
    }
    const s = S[win[bk]]
    _under.d = Math.sqrt(bd2); _under.y = s.pos.y; _under.w = s.width; _under.i = win[bk]
  }
  // The feed road, seeded at `looper`. Wide, because this only has to FIND the
  // crossing; the walk below gets a tighter window centred on what it finds.
  const feed: number[] = []
  const feedWin = Math.round(240 / res)
  for (let e = -feedWin; e <= feedWin; e++) {
    const j = N(iLooper + e)
    if (arcGap(iOver, j) >= MIN_ARC) feed.push(j)
  }
  if (feed.length === 0) return
  let ci = -1, cj = -1
  for (let d = 0; d <= Math.round(140 / res); d++) {
    const i = N(iOver + d)
    nearestIn(feed, S[i].pos.x, S[i].pos.z)
    if (S[i].pos.y - _under.y < SPAN_CLEAR) continue
    // Over the road it crosses means over the part of it a car can drive on.
    if (_under.d > _under.w) continue
    ci = i; cj = _under.i; break
  }
  if (ci < 0) return

  /* ---- 2. HOW FAR THE SPAN RUNS.
   *
   * Out from the anchor in both directions while the deck's centreline is
   * still inside the lower road's DRIVEABLE WIDTH, stopping at the first
   * sample that is not.
   *
   * That test used to carry a generous spill -- three quarters of the deck's
   * own half-width past the lower road's edge -- on the reasoning that the
   * deck's EDGE is still overhead even once its centreline is not. True, and
   * unusable here. A 441-degree looper crosses its own feed road TWICE, and
   * between the two crossings the decks part by only about forty metres; at
   * three quarters of a 30 m half-width the allowance is 48 m, the walk never
   * registers an exit at all, and the two bridges weld into one 290 m slab
   * with a hole in the middle. Measured exits, forward, by spill: 107 m at
   * zero, 116 m at a quarter, 225 m at a half. The cliff is not a tuning
   * curve, it is the gap closing.
   *
   * So the span is exactly the overlap, and the structure is carried a fixed
   * short abutment past each end so the beams finish past the road's edge
   * instead of stopping dead on it. The centreline test has a third of the
   * gap in hand rather than a couple of metres, and it means something you
   * can say in one sentence.
   *
   * `looper-apex` still bounds the walk, but only as a runaway guard now:
   * half the looper's own arc from its entry to its far side. On the shipped
   * layout that is 130 m against a walk that ends at 107 m, so it does not
   * bind -- which is the point. The old bound was a flat 70 m ceiling and it
   * truncated this span by 34 m. ---- */
  const underWin = Math.round(120 / res)
  const under: number[] = []
  for (let e = -underWin; e <= underWin; e++) under.push(N(cj + e))
  const overhangs = (i: number): boolean => {
    const s = S[i]
    nearestIn(under, s.pos.x, s.pos.z)
    return s.pos.y - _under.y >= SPAN_CLEAR && _under.d <= _under.w
  }
  /** Elevated, but no longer over the road: how the abutment is allowed to end. */
  const stillHigh = (i: number): boolean => {
    nearestIn(under, S[i].pos.x, S[i].pos.z)
    return S[i].pos.y - _under.y >= SPAN_CLEAR
  }
  const loopArc = arcGap(iLooper, iApex) * res
  const maxHalf = Math.round(Math.min(200, Math.max(40, loopArc * 0.5)) / res)
  let iA = ci, iB = ci
  for (let d = 1; d <= maxHalf; d++) { const i = N(ci - d); if (!overhangs(i)) break; iA = i }
  for (let d = 1; d <= maxHalf; d++) { const i = N(ci + d); if (!overhangs(i)) break; iB = i }
  const abut = Math.round(SPAN_ABUT / res)
  for (let d = 1; d <= abut; d++) { const i = N(iA - 1); if (!stillHigh(i)) break; iA = i }
  for (let d = 1; d <= abut; d++) { const i = N(iB + 1); if (!stillHigh(i)) break; iB = i }
  const spanLen = arcGap(iA, iB)
  // A span shorter than its own deck is wide is not a crossing anyone can read.
  if (spanLen * res < 24) return
  const run: number[] = []
  for (let d = 0; d <= spanLen; d++) run.push(N(iA + d))

  /* ---- 3. THE SPAN: EDGE BEAMS, RIBS AND CORBELS.
   *
   * Hand-built rather than merged from primitives for the same reason the
   * magma veins are: this follows the ribbon's own banked frame at every
   * station, so it inherits width and camber for free and cannot drift off
   * the deck it is hanging from. One geometry, and it borrows
   * `ctx.propMaterial` -- the shared flat-shaded basalt the scatter already
   * pays for -- so it adds a draw call and no material. ---- */
  const pos: number[] = []
  const col: number[] = []
  const idx: number[] = []
  const pushV = (x: number, y: number, z: number, c: THREE.Color): number => {
    const k = pos.length / 3
    pos.push(x, y, z); col.push(c.r, c.g, c.b)
    return k
  }
  const faceOut = (a: number, b: number, c: number, d: number, ox: number, oy: number, oz: number): void =>
    windQuad(pos, idx, a, b, c, d, ox, oy, oz)
  /** A box in one sample's frame: lateral along `right`, depth down `-normal`,
   *  length along the tangent. */
  const pushBox = (
    s: Smp, lat: number, dep: number, hl: number, hd: number, hg: number, c: THREE.Color,
  ): void => {
    const tl = Math.hypot(s.tangent.x, s.tangent.y, s.tangent.z) || 1
    const tx = s.tangent.x / tl, ty = s.tangent.y / tl, tz = s.tangent.z / tl
    const b = pos.length / 3
    for (let a = 0; a < 8; a++) {
      const L = lat + ((a & 1) ? hl : -hl)
      const D = dep + ((a & 2) ? hd : -hd)
      const G = (a & 4) ? hg : -hg
      pushV(
        s.pos.x + s.right.x * L - s.normal.x * D + tx * G,
        s.pos.y + s.right.y * L - s.normal.y * D + ty * G,
        s.pos.z + s.right.z * L - s.normal.z * D + tz * G,
        c,
      )
    }
    const nx = -s.normal.x, ny = -s.normal.y, nz = -s.normal.z
    faceOut(b + 1, b + 3, b + 7, b + 5, s.right.x, s.right.y, s.right.z)
    faceOut(b + 0, b + 2, b + 6, b + 4, -s.right.x, -s.right.y, -s.right.z)
    faceOut(b + 2, b + 3, b + 7, b + 6, nx, ny, nz)
    faceOut(b + 0, b + 1, b + 5, b + 4, -nx, -ny, -nz)
    faceOut(b + 4, b + 5, b + 7, b + 6, tx, ty, tz)
    faceOut(b + 0, b + 1, b + 3, b + 2, -tx, -ty, -tz)
  }

  const cLit = new THREE.Color(BASALT_LIT)
  const cRock = new THREE.Color(BASALT)
  const cDark = new THREE.Color(OBSIDIAN)
  const cVein = new THREE.Color(VEIN)

  // Rings every ~3 m. Finer than that buys nothing on a shape with no
  // cross-sectional detail, and the span is 100 m of it.
  const stride = Math.max(1, Math.round(3 / res))
  const rings: number[] = []
  for (let d = 0; d <= spanLen; d += stride) rings.push(N(iA + d))
  if (rings[rings.length - 1] !== iB) rings.push(iB)
  if (rings.length < 3) return

  // Four verts per flank per ring: outer-top, outer-bottom, inner-bottom,
  // inner-top. The outer pair carry BASALT_LIT so the fascia is the one face
  // on the whole structure that catches the key; the inner pair fall away to
  // obsidian, which is what gives the underside somewhere to be dark.
  const beam: number[][] = []
  const seamPos: number[] = []
  const seamIdx: number[] = []
  for (const i of rings) {
    const s = S[i]
    const out = s.width + SPAN_OUT
    const inn = out - BEAM_W
    const row: number[] = []
    for (const side of [-1, 1]) {
      const at = (lat: number, dep: number, c: THREE.Color): number => pushV(
        s.pos.x + s.right.x * lat - s.normal.x * dep,
        s.pos.y + s.right.y * lat - s.normal.y * dep,
        s.pos.z + s.right.z * lat - s.normal.z * dep,
        c,
      )
      row.push(
        at(side * out, SPAN_SOFFIT - BEAM_RISE, cLit),
        at(side * out, SPAN_SOFFIT + BEAM_H, cLit),
        at(side * inn, SPAN_SOFFIT + BEAM_H, cRock),
        at(side * inn, SPAN_SOFFIT - BEAM_RISE, cDark),
      )
      // The seam rides the bottom outer corner as a chamfer standing slightly
      // proud of both faces, so it reads from the flank AND from directly
      // underneath without ever being coplanar with the beam.
      seamPos.push(
        s.pos.x + s.right.x * side * (out + 0.04) - s.normal.x * (SPAN_SOFFIT + BEAM_H - SEAM_W),
        s.pos.y + s.right.y * side * (out + 0.04) - s.normal.y * (SPAN_SOFFIT + BEAM_H - SEAM_W),
        s.pos.z + s.right.z * side * (out + 0.04) - s.normal.z * (SPAN_SOFFIT + BEAM_H - SEAM_W),
        s.pos.x + s.right.x * side * (out - SEAM_W) - s.normal.x * (SPAN_SOFFIT + BEAM_H + 0.04),
        s.pos.y + s.right.y * side * (out - SEAM_W) - s.normal.y * (SPAN_SOFFIT + BEAM_H + 0.04),
        s.pos.z + s.right.z * side * (out - SEAM_W) - s.normal.z * (SPAN_SOFFIT + BEAM_H + 0.04),
      )
    }
    beam.push(row)
  }
  for (let r = 1; r < beam.length; r++) {
    const p = beam[r - 1], q = beam[r]
    const s = S[rings[r]]
    for (let k = 0; k < 2; k++) {
      const o = k * 4, side = k === 0 ? -1 : 1
      const rx = s.right.x * side, ry = s.right.y * side, rz = s.right.z * side
      faceOut(p[o + 0], p[o + 1], q[o + 1], q[o + 0], rx, ry, rz)                       // fascia
      faceOut(p[o + 1], p[o + 2], q[o + 2], q[o + 1], -s.normal.x, -s.normal.y, -s.normal.z) // soffit
      faceOut(p[o + 2], p[o + 3], q[o + 3], q[o + 2], -rx, -ry, -rz)                    // inner
      // Seam ribbon, two verts per flank per ring, in its own buffer. The
      // chamfer faces down AND out, which is the whole point of cutting the
      // corner with it, so that is the direction its winding is derived from.
      const a0 = ((r - 1) * 2 + k) * 2, b0 = (r * 2 + k) * 2
      windQuad(seamPos, seamIdx, a0, a0 + 1, b0 + 1, b0,
        rx - s.normal.x, ry - s.normal.y, rz - s.normal.z)
    }
  }
  // Close both ends so the beams are boxes and not troughs.
  for (const [r, sgn] of [[0, -1], [beam.length - 1, 1]] as const) {
    const row = beam[r]
    const s = S[rings[r]]
    const tl = Math.hypot(s.tangent.x, s.tangent.y, s.tangent.z) || 1
    for (let k = 0; k < 2; k++) {
      const o = k * 4
      faceOut(row[o], row[o + 1], row[o + 2], row[o + 3],
        sgn * s.tangent.x / tl, sgn * s.tangent.y / tl, sgn * s.tangent.z / tl)
    }
  }
  // Transverse ribs. Full bay width, in the band between the pier cross-head
  // above them and the beams' own soffit below.
  const ribStep = Math.max(stride, Math.round(RIB_STEP / res))
  for (let d = ribStep; d < spanLen; d += ribStep) {
    const s = S[N(iA + d)]
    const half = s.width + SPAN_OUT - BEAM_W
    pushBox(s, 0, (RIB_TOP + RIB_BOT) / 2, half, (RIB_BOT - RIB_TOP) / 2, 0.85,
      (d / ribStep) % 2 === 0 ? cRock : cLit)
  }

  /* ---- 4. PYLONS.
   *
   * Basalt, hexagonal, clustered -- the same columnar jointing the scatter's
   * `propColumns` is built from, because a flyover on this planet is a flow
   * that cooled standing up, not a structure someone welded.
   *
   * WHERE THEY STAND IS THE WHOLE PROBLEM. The span crosses its own feed road
   * at 55 degrees and both decks are wide, so the obvious spot -- under the
   * middle of the crossing -- is the middle of a road. Each station is
   * therefore the FIRST sample walking out from the crossing whose columns
   * clear the lower deck's own corridor, read off that deck's width, not off a
   * constant; and every candidate is then tested against every other part of
   * the ribbon in plan AND in height, so a column can stand under its own deck
   * without the deck rejecting it. One InstancedMesh for all of them. ---- */
  const pylonM: THREE.Matrix4[] = []
  const standsClear = (x: number, z: number, r: number, topY: number, baseY: number, home: number): boolean => {
    for (let j = 0; j < m; j++) {
      if (arcGap(home, j) < PYLON_SELF) continue
      const s = S[j]
      // A road passing well over the column's head or under its foot is not in
      // its way. Without this the span the column carries rejects it.
      if (s.pos.y > topY + 2.5 || s.pos.y < baseY - 2.5) continue
      const hl = Math.hypot(s.right.x, s.right.z) || 1
      const need = ctx.corridor(s.width * hl) + r + PYLON_GAP
      const dx = x - s.pos.x, dz = z - s.pos.z
      if (dx * dx + dz * dz < need * need) return false
    }
    return true
  }
  // One column per direction out of the crossing, per flank: four at most, and
  // fewer wherever the ground or the road below refuses one. Each flank walks
  // out on its own rather than as a pair, because the span crosses at a skew --
  // the flank the lower road recedes from clears it several metres sooner, and
  // staggering the two is what the legs of a skew pier actually do.
  for (const dir of [-1, 1]) {
    const limit = dir < 0 ? arcGap(iA, ci) : arcGap(ci, iB)
    for (const side of [-1, 1]) {
      for (let d = Math.round(6 / res); d <= limit - Math.round(4 / res); d++) {
        const st = N(ci + dir * d)
        const s = S[st]
        const lat = s.width * PYLON_LAT_F * side
        const x = s.pos.x + s.right.x * lat
        const z = s.pos.z + s.right.z * lat
        const topY = s.pos.y + s.right.y * lat - s.normal.y * (SPAN_SOFFIT + BEAM_H + 0.70)
        const h = topY - (ctx.ground(x, z).y - 1.8)
        if (h < 5) continue
        const r = Math.min(3.4, 1.9 + h * 0.042)
        if (!standsClear(x, z, r, topY, topY - h, st)) continue
        _fe.set(0, Math.atan2(s.tangent.x, s.tangent.z), 0)
        _fq.setFromEuler(_fe)
        _fp.set(x, topY - h, z)
        _fs.set(r, h, r)
        pylonM.push(new THREE.Matrix4().compose(_fp, _fq, _fs))
        // The corbel is the one piece of a pier that must not stretch with it,
        // so it rides in the span's own geometry instead of the instance.
        pushBox(s, lat, SPAN_SOFFIT + BEAM_H + 0.40, r * 1.05, 0.45, 1.6, cRock)
        break
      }
    }
  }

  /* ---- 5. THE SHADE. See the header: this is sky occlusion, so it sits
   * directly under the span's plan footprint and is feathered rather than
   * edged. It is the magma veins' own strip, built the same way and laid a
   * hair above them so it darkens the seams too -- a crack that stayed bright
   * under a bridge would give the whole thing away. ---- */
  const spanHalf = S[ci].width + SPAN_OUT
  const shadeWin = Math.round(Math.min(150, spanHalf * 2.6 + 34) / res)
  const shadeStride = Math.max(1, Math.round(3 / res))
  const sPos: number[] = []
  const sCol: number[] = []
  const sIdx: number[] = []
  let rows = 0, peak = 0
  for (let d = -shadeWin; d <= shadeWin; d += shadeStride) {
    const s = S[N(cj + d)]
    for (const side of [-1, 1]) {
      const off = s.width * 0.99 * side
      const x = s.pos.x + s.right.x * off + s.normal.x * 0.11
      const y = s.pos.y + s.right.y * off + s.normal.y * 0.11
      const z = s.pos.z + s.right.z * off + s.normal.z * 0.11
      let bd2 = Infinity
      for (const i of run) {
        const dx = x - S[i].pos.x, dz = z - S[i].pos.z
        const q = dx * dx + dz * dz
        if (q < bd2) bd2 = q
      }
      const a = SHADE_PEAK * (1 - smooth01((Math.sqrt(bd2) - (spanHalf - 2)) / (SHADE_PEN + 2)))
      if (a > peak) peak = a
      sPos.push(x, y, z); sCol.push(1, 1, 1, a)
    }
    if (rows > 0) {
      const a0 = (rows - 1) * 2
      sIdx.push(a0, a0 + 1, a0 + 2, a0 + 1, a0 + 3, a0 + 2)
    }
    rows++
  }

  /* ---- 6. COMMIT. Nothing above touched the scene; everything below is
   * owned, so the environment's own teardown disposes it. `propMaterial` is
   * NOT owned here -- environment.ts already disposes it. ---- */
  const spanGeo = new THREE.BufferGeometry()
  spanGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  spanGeo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  spanGeo.setIndex(idx)
  spanGeo.computeVertexNormals()
  spanGeo.computeBoundingSphere()
  ctx.own(spanGeo)
  const spanMesh = new THREE.Mesh(spanGeo, ctx.propMaterial)
  spanMesh.name = 'flyover-span'
  spanMesh.castShadow = ctx.quality.shadows
  ctx.add(spanMesh)

  if (pylonM.length > 0) {
    const parts: THREE.BufferGeometry[] = []
    const rnd = mulberry32(0x5f1ce7)
    // Three shafts of a cooled flow, the subordinate two stopping short of the
    // cap. Everything is prismatic between base and cap, so an instance scaled
    // to 32 m of column has nothing in it that can stretch wrong.
    for (let k = 0; k < 3; k++) {
      const rr = 1.0 - k * 0.21
      const hh = k === 0 ? 1 : 0.93 - k * 0.06
      const ang = rnd() * Math.PI * 2
      const dd = k === 0 ? 0 : 0.58 + rnd() * 0.28
      parts.push(part(
        new THREE.CylinderGeometry(rr * 0.86, rr, 1, 6, 1),
        k === 1 ? BASALT_LIT : BASALT,
        xf(Math.cos(ang) * dd, hh / 2, Math.sin(ang) * dd, rnd() * Math.PI, 0, 0, 1, hh, 1),
      ))
    }
    const pylonGeo = merge(parts)
    ctx.own(pylonGeo)
    const inst = new THREE.InstancedMesh(pylonGeo, ctx.propMaterial, pylonM.length)
    inst.name = 'flyover-pylons'
    for (let k = 0; k < pylonM.length; k++) inst.setMatrixAt(k, pylonM[k])
    inst.instanceMatrix.needsUpdate = true
    inst.computeBoundingSphere()
    inst.castShadow = ctx.quality.shadows
    inst.receiveShadow = ctx.quality.shadows
    ctx.add(inst)
  }

  if (rows > 1 && peak > 0.02) {
    const shadeGeo = new THREE.BufferGeometry()
    shadeGeo.setAttribute('position', new THREE.Float32BufferAttribute(sPos, 3))
    shadeGeo.setAttribute('color', new THREE.Float32BufferAttribute(sCol, 4))
    shadeGeo.setIndex(sIdx)
    shadeGeo.computeBoundingSphere()
    ctx.own(shadeGeo)
    // Warm-dark rather than black: the value rule this file opens with cuts
    // both ways, and a hole punched in the deck is as wrong as a hot one.
    const shadeMat = new THREE.MeshBasicMaterial({
      color: 0x120906, vertexColors: true, fog: true,
      transparent: true, depthWrite: false,
    })
    ctx.own(shadeMat)
    const shadeMesh = new THREE.Mesh(shadeGeo, shadeMat)
    shadeMesh.name = 'flyover-shade'
    // Over the veins (2), so the seams go under the bridge with the road.
    shadeMesh.renderOrder = 3
    ctx.add(shadeMesh)
  }

  {
    const seamGeo = new THREE.BufferGeometry()
    seamGeo.setAttribute('position', new THREE.Float32BufferAttribute(seamPos, 3))
    seamGeo.setIndex(seamIdx)
    seamGeo.computeBoundingSphere()
    ctx.own(seamGeo)
    const seamMat = new THREE.MeshBasicMaterial({
      color: cVein, fog: true, transparent: true, opacity: 0.52,
      depthWrite: false, blending: THREE.AdditiveBlending,
    })
    ctx.own(seamMat)
    const seamMesh = new THREE.Mesh(seamGeo, seamMat)
    seamMesh.name = 'flyover-seam'
    seamMesh.renderOrder = 2
    ctx.add(seamMesh)
    // One breath every seventeen seconds, eight percent deep. The loops' rings
    // run at 0.9 rad/s because a set piece you pass through can afford to be
    // noticed; this one hangs over a corner a driver is committed in, and
    // anything faster than this would be read as a signal.
    ctx.onUpdate((f: FrameInfo) => {
      seamMat.opacity = 0.52 + 0.08 * Math.sin(f.time * 0.37)
    })
  }
}

/** A soft radial blob, built once. The plume and nothing else uses it. */
function plumeTexture(): THREE.Texture {
  const N = 64
  const data = new Uint8Array(N * N * 4)
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = (x + 0.5) / N - 0.5, dy = (y + 0.5) / N - 0.5
      const d = Math.min(1, Math.hypot(dx, dy) * 2)
      const a = Math.pow(1 - d, 2.4)
      const i = (y * N + x) * 4
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255
      data[i + 3] = Math.round(a * 255)
    }
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat)
  t.needsUpdate = true
  return t
}

/* ---------------------------------------------------------------- terrain */

const _c = new THREE.Color()

/**
 * The ground. Basalt everywhere, ash where the macro noise says a bed has
 * drifted, and a THIN fissure line where two noise bands cross -- that last one
 * is the entire emissive budget of the terrain and it covers about 2% of it.
 */
function terrainColor(out: THREE.Color, p: TerrainPoint, pal: Palette): void {
  // Base: basalt, lifted toward scoria on the high ridges where the key rakes.
  out.set(BASALT).lerp(_c.set(BASALT_LIT), p.grit * 0.55)
  out.lerp(_c.set(SCORIA), Math.max(0, p.ridge) * 0.38 + p.mid * 0.12)
  // Ash beds: broad, soft, and only in the macro band, so they read as fields
  // rather than as noise.
  const ashiness = Math.max(0, p.macro - 0.52) * 2.1
  out.lerp(_c.set(ASH).lerp(_c.set(ASH_LO), p.grit * 0.6), Math.min(0.85, ashiness))
  // THE FISSURES. A narrow ridge in one noise band intersected with another,
  // so they form lines rather than patches, and only away from the road.
  const seam = 1 - Math.min(1, Math.abs(p.mid - 0.5) * 14)
  const gate = Math.max(0, Math.min(1, (p.edge - 6) / 26))
  const heat = seam * gate * Math.max(0, p.macro - 0.34)
  if (heat > 0.01) out.lerp(_c.set(LAVA), Math.min(0.92, heat * 1.5))
  void pal
}

/* ----------------------------------------------------------------- spray */

const SPRAY: SurfaceSprayTable = {
  // Basalt apron. Dark grit, and real sparks: this is rock over a metal
  // underbody at 60 m/s.
  tarmac: { bulk: 0x4a3c36, glint: 0x9a7a62, weight: 0.62, grit: 0.30, density: 1.0, gain: 0.50, spark: 0.55, sparkCol: 0xffb060 },
  // The ash beds. Powder that hangs -- the signature of the whole track.
  gravel: { bulk: 0x6b5c54, glint: 0xa89486, weight: 0.18, grit: 0.14, density: 1.9, gain: 0.68, spark: 0.14, sparkCol: 0xff9a4a },
  // The lava tubes are glassy basalt: little comes off, and what does is hot.
  metal: { bulk: 0x2a2228, glint: 0xff9a50, weight: 0.70, grit: 0.46, density: 0.55, gain: 0.44, spark: 0.86, sparkCol: 0xffd08a },
  oil: { bulk: 0x201a18, glint: 0x5a4a42, weight: 0.30, grit: 0.10, density: 0.8, gain: 0.34, spark: 0.10, sparkCol: 0xff7a30 },
  // Authored for completeness; this planet has no ice or snow anywhere.
  ice: { bulk: 0x4a4650, glint: 0xbfc6d2, weight: 0.55, grit: 0.40, density: 0.5, gain: 0.42, spark: 0.30, sparkCol: 0xffc27a },
  snow: { bulk: 0x6a6058, glint: 0xc0b4a6, weight: 0.22, grit: 0.16, density: 1.4, gain: 0.55, spark: 0.10, sparkCol: 0xffc27a },
  boost: { bulk: 0x5a4038, glint: 0xffa860, weight: 0.40, grit: 0.34, density: 1.1, gain: 0.60, spark: 0.62, sparkCol: 0xffcc90 },
}

/* ----------------------------------------------------------------- theme */

export const EMBERFALL_THEME: Theme = {
  id: 'emberfall',

  props(pal, seg): PropSpec[] {
    return [
      {
        name: 'basalt-columns', geo: propColumns(pal, seg), count: 165,
        radius: 4.2, gap: 2.4, spread: 90, scale: [0.8, 1.7],
        cluster: { tag: 'start', span: 420, share: 0.30 },
      },
      {
        name: 'spatter-vent', geo: propVent(pal, seg), count: 74,
        radius: 5.0, gap: 4.0, spread: 130, scale: [0.7, 1.8],
        // Vents gather where the road is torn open: the fissure jump.
        cluster: { tag: 'fissure', span: 240, share: 0.44 },
      },
      {
        name: 'lava-spire', geo: propSpire(pal, seg), count: 68,
        radius: 3.2, gap: 3.0, spread: 175, scale: [0.75, 2.1],
        // No `cluster` -- see `ashSpires`, which is the gather instead and does
        // it on the gravel rather than near a node.
        landmark: ashSpires,
      },
      {
        name: 'obsidian-shards', geo: propShards(pal, seg), count: 210,
        radius: 5.4, gap: 1.8, spread: 70, scale: [0.7, 1.5],
      },
      {
        name: 'collapsed-tube', geo: propArch(pal, seg), count: 26,
        radius: 13, gap: 6.5, spread: 150, scale: [0.85, 1.6],
        cluster: { tag: 'loop2', span: 300, share: 0.50 },
      },
    ]
  },

  landmarks,
  terrainColor,
  terrainMaterial: { roughness: 0.95, metalness: 0.05 },
  // Graded onto the fog early: this is a dusty, smoky atmosphere and a crisp
  // horizon would make the terrain shell's edge visible.
  terrainFade: [180, 620],

  /**
   * EMBERS, and they RISE. `fall` is a constant downward drift, so a negative
   * value is the whole effect -- the air over a shield volcano is going up, and
   * a planet whose particles fall reads as snow no matter what colour it is.
   * They are allowed to be bright because they are tiny and there are few of
   * them: this is one of the three things on Ashkar permitted past the bloom
   * threshold.
   */
  motes: {
    count: 1150, box: 92, size: [0.05, 0.26], pixel: 165, maxPixels: 6,
    alpha: 0.92, fall: -2.9, streak: 0.42,
    color: (_pal, fog) => new THREE.Color(EMBER).lerp(fog, 0.18),
  },

  /** Blown ash, not grit: long, soft, dark, and it only tints the frame down. */
  debris: {
    count: 720, box: 92, length: 7.4, width: 0.34, alpha: 0.34, fall: 0.6,
    color: (_pal, fog) => new THREE.Color(0.36, 0.30, 0.27).lerp(fog, 0.42),
  },

  sky: {
    // Ash strata, not stars: there is far too much in this atmosphere to see
    // through it, and the bands double as the plume's context.
    band: 'strata',
    // The horizon is the brightest thing in the sky and it is doing the work of
    // a sunset that never finishes -- this is the glow off the lava fields
    // beyond the rim, not a sun.
    horizonColor: 0xff6a20,
    horizonSpan: [0.02, 0.34],
    horizonGain: 0.92,
    celestial: {
      bodies: [
        {
          // THE PARENT WORLD. Ashkar is a moon; this is what it orbits, and at
          // 16 degrees of angular radius it is roughly sixty times the size of
          // Earth's moon -- which is the point, and is also why it sits LOW
          // and mostly below the horizon line rather than overhead, where it
          // would dominate every frame the camera pitches up in.
          dir: [-0.62, 0.09, -0.78],
          sizeDeg: 16,
          color: 0xb8794a,
          bands: 7,
          bandColor: 0x7a4526,
          shade: 0.55,
          limb: 0.34,
          mottle: 0.22,
          ring: {
            inner: 1.35, outer: 2.15, color: 0xc9a184, opacity: 0.42,
            axis: [0.19, 0.93, 0.31],
          },
        },
      ],
      // Pulled back hard. The gas giant is enormous and the frame still has to
      // belong to the racers; this is the dimmer that keeps it a backdrop.
      gain: 0.62,
    },
  },

  /** Smoke lying in the basins, not cloud. Warm, because here that is true. */
  fogBanks: {
    count: 9, size: 112, alpha: 0.048, low: -10, high: 30,
    color: (_pal, fog) => fog.clone().lerp(new THREE.Color(0.42, 0.30, 0.25), 0.40),
  },

  /**
   * The ash storm over the caldera rim. `windFull` is 13 because that is the
   * peak the track authors (see BEATS.updraft in content/tracks/emberfall.ts)
   * -- the cue has to arrive and leave exactly where the force does, or it is
   * decoration rather than weather.
   *
   * The fog goes DARK, not pale. Cryostatic's blizzard closes the world to a
   * mid grey the racers silhouette against; ash does the same job by going the
   * other way, and the emissive chevrons are what survives it.
   */
  weather: {
    windFull: 13.0,
    fogColor: 0x3a1d12,
    fogDensity: 0.0138,
    sunScale: 0.40,
    moteGain: 2.1,
  },

  road: 'industrial',
  propMaterial: { roughness: 0.93, metalness: 0.08 },
  spray: SPRAY,
}
