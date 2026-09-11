/**
 * RUSTFALL — junkyard planet. ART-LOCKED.
 *
 * GDD 09: "rust orange, sodium-vapour yellow, dust haze. One hard sun key with
 * long shadows. Detail comes from a single scrap trim sheet plus heavy
 * instancing of six hero junk props."
 *
 * The drift-spray gains here run about a quarter below Cryostatic's for the
 * same nominal material. That is not an inconsistency: this planet is a dark
 * road under a low sun with no fog to speak of, so a plume lands against a
 * scene-linear 0.05-0.1 background, where the ice world's lands against 0.2 of
 * blizzard. Same effect, same code, same cap — the planet decides how much of
 * the cap it wants, which is the entire reason this table lives in the theme.
 *
 * This file is the catalogue that used to be hardcoded inside environment.ts,
 * moved out unchanged so that Rustfall renders exactly the frame it was signed
 * off on. Numbers here are load-bearing and were arrived at by measuring the
 * geometry — three of the prop radii were understated by metres, which is how a
 * 15 m crane boom came to hang over the cargo ring. Do not round them.
 */
import * as THREE from 'three'
import {
  bindSurfaceSpray, merge, mulberry32, part, xf,
  type FrameInfo, type Palette, type PropSpec, type SurfaceSprayTable,
  type TerrainPoint, type Theme, type ThemeContext,
} from './kit'

/* ------------------------------------------------------------- hero props */

/** Hero prop 1 — crushed car cube. Squashed body, bent roof, two axle stubs. */
function propCrushedCar(p: Palette, seg: number): THREE.BufferGeometry {
  void seg
  return merge([
    part(new THREE.BoxGeometry(3.7, 1.05, 1.95), p.a, xf(0, 0.55, 0, 0, 0, 0.05)),
    part(new THREE.BoxGeometry(1.9, 0.75, 1.75), p.c, xf(-0.25, 1.35, 0, 0, 0, -0.16)),
    part(new THREE.BoxGeometry(0.55, 0.5, 2.15), 0x24201c, xf(1.25, 0.35, 0)),
    part(new THREE.BoxGeometry(0.55, 0.5, 2.15), 0x24201c, xf(-1.25, 0.3, 0)),
    part(new THREE.BoxGeometry(3.4, 0.16, 1.7), p.b, xf(0.1, 1.02, 0, 0, 0, 0.05)),
  ])
}

/** Hero prop 2 — shredded ship hull section. Curved plate with exposed ribs. */
function propHull(p: Palette, seg: number): THREE.BufferGeometry {
  const parts = [
    part(
      new THREE.CylinderGeometry(6.2, 6.6, 15, seg + 4, 1, true, 0.5, 2.3),
      p.c, xf(0, 5.4, 0, 0, Math.PI / 2, 0.12),
    ),
  ]
  for (let i = 0; i < 4; i++) {
    parts.push(part(
      new THREE.TorusGeometry(6.0, 0.30, 4, seg + 2, 2.2),
      p.a, xf(-6 + i * 4.1, 5.4, 0, Math.PI / 2, 0, 2.05),
    ))
  }
  parts.push(part(new THREE.BoxGeometry(2.2, 3.4, 0.5), p.c, xf(7.4, 2.4, 1.6, 0.3, 0, 0.35)))
  parts.push(part(new THREE.BoxGeometry(1.6, 2.6, 0.4), p.c, xf(-7.6, 2.0, -1.2, -0.4, 0, -0.28)))
  return merge(parts)
}

/** Hero prop 3 — pipe stack, pyramid stacked, strapped. */
function propPipes(p: Palette, seg: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const R = 0.82
  const rows = [3, 2]
  let y = R
  for (let r = 0; r < rows.length; r++) {
    const n = rows[r]
    for (let i = 0; i < n; i++) {
      const x = (i - (n - 1) / 2) * (R * 2.05)
      parts.push(part(
        new THREE.CylinderGeometry(R, R, 8.5, seg + 2, 1, false),
        r === 0 ? p.a : p.c,
        xf(x, y, 0, 0, 0, Math.PI / 2),
      ))
    }
    y += R * 1.72
  }
  parts.push(part(new THREE.BoxGeometry(0.28, 3.4, 4.0), 0x2b2622, xf(0, 1.4, 0)))
  parts.push(part(new THREE.BoxGeometry(7.0, 0.4, 4.4), p.c, xf(0, 0.0, 0)))
  return merge(parts)
}

/** Hero prop 4 — magnetic crane arm. Tracked base, lattice boom, magnet disc. */
function propCrane(p: Palette, seg: number): THREE.BufferGeometry {
  return merge([
    part(new THREE.BoxGeometry(5.4, 1.5, 3.4), 0x2a2521, xf(0, 0.75, 0)),
    part(new THREE.BoxGeometry(3.4, 2.6, 3.0), p.b, xf(-0.6, 2.7, 0)),
    part(new THREE.BoxGeometry(2.0, 1.6, 2.2), 0x1a1815, xf(0.9, 3.0, 0)),
    // Tapered lattice boom, 4-sided so it reads as an open truss at distance.
    part(new THREE.CylinderGeometry(0.85, 0.35, 15.5, 4, 1, false), p.a,
      xf(3.6, 8.6, 0, Math.PI / 4, 0, -0.62)),
    part(new THREE.BoxGeometry(0.16, 7.5, 0.16), 0x1a1815, xf(10.4, 10.1, 0)),
    part(new THREE.CylinderGeometry(2.3, 2.3, 0.75, seg + 4, 1, false), p.c, xf(10.4, 6.1, 0)),
    part(new THREE.CylinderGeometry(1.5, 1.5, 0.4, seg + 2, 1, false), p.b, xf(10.4, 5.6, 0)),
    part(new THREE.BoxGeometry(1.1, 3.2, 1.1), p.c, xf(-2.6, 4.4, 0, 0, 0, 0.35)),
  ])
}

/** Hero prop 5 — scrap tower. Irregular stacked blocks with an aerial. */
function propTower(p: Palette, seg: number): THREE.BufferGeometry {
  void seg
  const rnd = mulberry32(0x5c8a11)
  const parts: THREE.BufferGeometry[] = []
  let y = 0
  let w = 4.6
  for (let i = 0; i < 6; i++) {
    const h = 1.5 + rnd() * 1.9
    parts.push(part(
      new THREE.BoxGeometry(w, h, w * (0.7 + rnd() * 0.5)),
      i % 2 === 0 ? p.a : p.c,
      xf((rnd() - 0.5) * 1.1, y + h / 2, (rnd() - 0.5) * 1.1, rnd() * 1.2, 0, (rnd() - 0.5) * 0.16),
    ))
    y += h * 0.92
    w *= 0.86
  }
  parts.push(part(new THREE.BoxGeometry(0.16, 5.2, 0.16), 0x201d1a, xf(0, y + 2.6, 0)))
  parts.push(part(new THREE.BoxGeometry(0.5, 0.5, 0.5), p.b, xf(0, y + 5.1, 0)))
  return merge(parts)
}

/** Hero prop 6 — smelting chimney. Tapered stack with two collars. */
function propChimney(p: Palette, seg: number): THREE.BufferGeometry {
  return merge([
    part(new THREE.CylinderGeometry(1.5, 2.7, 24, seg + 4, 2, true), p.a, xf(0, 12, 0)),
    part(new THREE.CylinderGeometry(2.05, 2.05, 1.0, seg + 4, 1, true), p.c, xf(0, 8.5, 0)),
    part(new THREE.CylinderGeometry(1.7, 1.7, 0.9, seg + 4, 1, true), p.c, xf(0, 17.5, 0)),
    part(new THREE.CylinderGeometry(1.75, 1.55, 1.2, seg + 4, 1, true), p.b, xf(0, 24.2, 0)),
    part(new THREE.CylinderGeometry(3.3, 3.9, 1.6, seg + 4, 1, false), p.c, xf(0, 0.8, 0)),
  ])
}

/**
 * Landmark — conveyor gantry straddling the start straight.
 *
 * `halfSpan` is the lateral the LEG CENTRES stand on, handed in from
 * `corridor(sample.width)` at the spot the gantry lands on. Nothing in here is
 * an absolute lateral; every X is a fraction of the span the caller asks for.
 * The header rides with the span too, so the opening keeps the aspect it was
 * drawn with at 13 m of half-width or at 20.
 *
 * `footDrop` is how far below the origin the feet reach, so the caller can
 * plant them in the graded verge rather than guessing a burial depth.
 */
function propGantry(p: Palette, halfSpan: number, footDrop: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const deckY = halfSpan * 0.915
  const legH = deckY + footDrop + 1.6
  const legW = Math.max(1.2, halfSpan * 0.075)
  for (const side of [-1, 1]) {
    parts.push(part(new THREE.BoxGeometry(legW, legH, legW), p.c,
      xf(side * halfSpan, legH / 2 - footDrop, 0)))
    parts.push(part(new THREE.BoxGeometry(legW * 2, 0.9, legW * 2), p.a,
      xf(side * halfSpan, -footDrop + 0.45, 0)))
    // Knee brace, leaning OUTWARD from the leg so it can never reach the road.
    parts.push(part(new THREE.BoxGeometry(legW * 0.55, legH * 0.55, legW * 0.55), p.a,
      xf(side * (halfSpan + legW * 1.5), deckY * 0.42, 0, 0, 0, -side * 0.16)))
    // Two sodium lamp heads per leg, cantilevered inboard under the header.
    for (const k of [0.62, 0.86]) {
      parts.push(part(new THREE.BoxGeometry(halfSpan * 0.13, 0.30, 0.55), p.b,
        xf(side * halfSpan * 0.90, deckY * k, 0.55)))
    }
  }
  parts.push(part(new THREE.BoxGeometry(halfSpan * 2 + 4.0, 1.6, 2.6), p.c, xf(0, deckY, 0)))
  parts.push(part(new THREE.BoxGeometry(halfSpan * 2 + 2.0, 1.1, 1.6), 0x25211d,
    xf(0, deckY + 1.2, 0.9, 0, 0, 0.045)))
  parts.push(part(new THREE.BoxGeometry(halfSpan * 2 - 1.0, 0.35, 1.9), p.b, xf(0, deckY - 0.9, 0)))
  return merge(parts)
}

/* ----------------------------------------------------------------- shaders */

const PIT_FRAG = /* glsl */`
uniform vec3 uHot;
uniform vec3 uCool;
uniform float uTime;
varying vec2 vUvp;

float h21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float n2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x),
             mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
}

void main() {
  float r = length(vUvp);
  if (r > 1.0) discard;
  float n = n2(vUvp * 4.0 + vec2(uTime * 0.09, -uTime * 0.06));
  n = n * 0.65 + n2(vUvp * 11.0 - vec2(uTime * 0.14, uTime * 0.11)) * 0.35;
  float crust = smoothstep(0.34, 0.62, n);
  vec3 c = mix(uHot, uCool, crust);
  c *= 1.0 + 0.5 * sin(uTime * 1.6 + n * 9.0);
  float edge = 1.0 - smoothstep(0.62, 1.0, r);
  gl_FragColor = vec4(c * edge, edge);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

const SHIMMER_VERT = /* glsl */`
uniform float uTime;
varying float vH;
void main() {
  vH = clamp(position.y / 26.0, 0.0, 1.0);
  vec3 p = position;
  float w = vH * vH * 2.6;
  p.x += sin(uTime * 1.7 + position.y * 0.35 + position.z * 0.2) * w;
  p.z += cos(uTime * 1.4 + position.y * 0.41) * w;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`

const SHIMMER_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uTime;
varying float vH;
void main() {
  float a = (1.0 - vH) * 0.16 * (0.6 + 0.4 * sin(uTime * 2.1 + vH * 14.0));
  gl_FragColor = vec4(uColor, max(a, 0.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/* --------------------------------------------------------------- landmarks */

const _euler = new THREE.Euler()
const _quat = new THREE.Quaternion()
const _pos = new THREE.Vector3()
const _scale = new THREE.Vector3()
const _basisX = new THREE.Vector3()
const _basisY = new THREE.Vector3()
const _basisZ = new THREE.Vector3()

function landmarks(ctx: ThemeContext): void {
  const { track, quality, palette: pal } = ctx
  // Publish the track/spray pair for the VFX pass. This hook is the only place
  // the art layer is handed the live Track, and it runs once per world build,
  // before the VFX system exists. See bindSurfaceSpray in kit.ts.
  bindSurfaceSpray(track, SPRAY)
  const m = track.samples.length
  const iStart = ctx.tagSample('start')
  const iRing = ctx.tagSample('ring')
  const iLaunch = ctx.tagSample('ramp-chasm')
  const iLanding = ctx.tagSample('landing')

  /* ---- conveyor gantries over the start straight ----------------------- */
  //
  // ONE MERGED MESH, not an InstancedMesh. An instanced gantry shares a single
  // geometry, so the only per-spot control is the instance matrix, and a
  // uniform scale that widens the frame also lifts the header off its footings.
  // Every gantry has to straddle the ribbon AT ITS OWN WIDTH, so each is
  // generated against its own corridor and the lot merged. Six low-poly
  // gantries is one draw call either way.
  if (iStart >= 0) {
    const gantryParts: THREE.BufferGeometry[] = []
    const perM = m / track.length
    for (const s of [30, 102, 174, 246, 318, 390]) {
      const idx = (iStart + Math.round(s * perM)) % m
      const smp = track.samples[idx]
      if (smp.open) continue
      const halfSpan = ctx.corridor(smp.width) + 2.6
      // Feet reach down to the graded verge under the DEEPER of the two legs.
      const tl = Math.hypot(smp.tangent.x, smp.tangent.z) || 1
      const ox = smp.tangent.z / tl, oz = -smp.tangent.x / tl
      let footDrop = 1.5
      for (const side of [-1, 1]) {
        const g = ctx.ground(smp.pos.x + ox * side * halfSpan, smp.pos.z + oz * side * halfSpan)
        footDrop = Math.max(footDrop, smp.pos.y - g.y + 0.8)
      }
      const geo = propGantry(pal, halfSpan, footDrop)
      _euler.set(0, Math.atan2(smp.tangent.x, smp.tangent.z), 0)
      _quat.setFromEuler(_euler)
      _pos.set(smp.pos.x, smp.pos.y, smp.pos.z)
      _scale.setScalar(1)
      geo.applyMatrix4(new THREE.Matrix4().compose(_pos, _quat, _scale))
      gantryParts.push(geo)
    }
    if (gantryParts.length > 0) {
      const gantryGeo = merge(gantryParts)
      const gantries = new THREE.Mesh(gantryGeo, ctx.propMaterial)
      gantries.name = 'landmark-gantry'
      gantries.castShadow = quality.shadows
      gantries.receiveShadow = quality.shadows
      gantries.matrixAutoUpdate = false
      gantries.updateMatrix()
      ctx.add(gantries)
      ctx.own(gantryGeo)
    }
  }

  /* ---- cargo ring around the banked 'ring' section --------------------- */
  if (iRing >= 0) {
    const smp = track.samples[iRing]
    // The bore is sized off the ribbon it hoops: it has to clear the road, the
    // 3 m barrier and the 4.5 m the ring centre is lifted, by a constant margin
    // so the hoop keeps framing rather than growing into a halo.
    const R = smp.width + 13.5
    const ringParts: THREE.BufferGeometry[] = [
      part(new THREE.TorusGeometry(R, 2.2, 6, 26), pal.c, xf(0, 0, 0)),
      part(new THREE.TorusGeometry(R - 3.5, 0.7, 4, 20), pal.a, xf(0, 0, 0)),
    ]
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2
      ringParts.push(part(
        new THREE.BoxGeometry(1.0, 7.5, 1.6), i % 2 === 0 ? pal.b : pal.a,
        xf(Math.cos(a) * (R - 1.8), Math.sin(a) * (R - 1.8), 0, 0, 0, a + Math.PI / 2),
      ))
    }
    const ringGeo = merge(ringParts)
    const ring = new THREE.Mesh(ringGeo, ctx.propMaterial)
    ring.name = 'landmark-cargo-ring'
    // Ring plane perpendicular to the track: local +Z along the tangent.
    _basisX.set(smp.right.x, smp.right.y, smp.right.z)
    _basisY.set(smp.normal.x, smp.normal.y, smp.normal.z)
    _basisZ.set(-smp.tangent.x, -smp.tangent.y, -smp.tangent.z)
    ring.matrix.makeBasis(_basisX, _basisY, _basisZ)
    ring.matrix.setPosition(smp.pos.x, smp.pos.y + 4.5, smp.pos.z)
    ring.matrixAutoUpdate = false
    ring.castShadow = quality.shadows
    ring.receiveShadow = quality.shadows
    ctx.add(ring)
    ctx.own(ringGeo)
  }

  /* ---- smelting pit at the chasm --------------------------------------- */
  const pitAnchor = iLaunch >= 0 ? iLaunch : iLanding
  if (pitAnchor >= 0) {
    const smp = track.samples[pitAnchor]
    const tl = Math.hypot(smp.tangent.x, smp.tangent.z) || 1
    const rx = smp.tangent.z / tl, rz = -smp.tangent.x / tl
    // A 26 m disc, so its near rim has to stand off by more than its own
    // radius: corridor + 32 leaves 6 m of ground between lip and forgiving edge.
    const pitLat = ctx.corridor(smp.width) + 32
    const px = smp.pos.x + rx * pitLat
    const pz = smp.pos.z + rz * pitLat
    const py = ctx.ground(px, pz).y + 0.6

    const pitGeo = new THREE.CircleGeometry(26, 28)
    pitGeo.rotateX(-Math.PI / 2)
    const pitMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      uniforms: {
        uHot: { value: new THREE.Color().setHex(pal.b).multiplyScalar(2.4) },
        uCool: { value: new THREE.Color().setHex(pal.a).multiplyScalar(0.5) },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUvp;
        void main() {
          vUvp = (uv - 0.5) * 2.0;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: PIT_FRAG,
    })
    const pit = new THREE.Mesh(pitGeo, pitMat)
    pit.name = 'landmark-smelt-pit'
    pit.position.set(px, py, pz)
    pit.matrixAutoUpdate = false
    pit.updateMatrix()
    pit.renderOrder = 2
    ctx.add(pit)
    ctx.own(pitGeo); ctx.own(pitMat)
    const pitTime = pitMat.uniforms.uTime as { value: number }

    if (quality.tier !== 'low') {
      const pitLight = new THREE.PointLight(pal.b, 2600, 220, 2)
      pitLight.position.set(px, py + 9, pz)
      ctx.add(pitLight)

      const shGeo = new THREE.CylinderGeometry(20, 26, 26, 14, 4, true)
      shGeo.translate(0, 13, 0)
      const shimmerMat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        fog: false,
        uniforms: {
          uColor: { value: new THREE.Color().setHex(pal.b).multiplyScalar(0.35) },
          uTime: { value: 0 },
        },
        vertexShader: SHIMMER_VERT,
        fragmentShader: SHIMMER_FRAG,
      })
      const shimmer = new THREE.Mesh(shGeo, shimmerMat)
      shimmer.name = 'heat-shimmer'
      shimmer.position.set(px, py, pz)
      shimmer.matrixAutoUpdate = false
      shimmer.updateMatrix()
      shimmer.renderOrder = 3
      ctx.add(shimmer)
      ctx.own(shGeo); ctx.own(shimmerMat)
      const shTime = shimmerMat.uniforms.uTime as { value: number }
      ctx.onUpdate((f: FrameInfo) => { pitTime.value = f.time; shTime.value = f.time })
    } else {
      ctx.onUpdate((f: FrameInfo) => { pitTime.value = f.time })
    }
  }
}

/**
 * Landmark instance — an oversized crane presiding over the crane-drop oil
 * section. It rides the scattered crane's own InstancedMesh, so it is free.
 *
 * This was once the only prop in the file placed with no clearance test at
 * all: a fixed lateral off the crane-drop sample and straight into the buffer.
 * At 3.1x it is a 48 m boom, and the yard behind crane-drop is only 90 m wide
 * before the cargo ring, so once the ring went from 11 m a side to 16.5 the
 * magnet ended up hanging 2.3 m over the ring's high side. (The high side of a
 * 34-degree bank is 9 m in the air: a prop does not have to be near the road
 * in plan to be inside it.)
 *
 * A circular radius cannot express this thing — 13 m of reach at 3.1x is a
 * 40 m disc and nothing that size fits anywhere near crane-drop — so it is
 * tested as what it is: three discs down the boom axis. The lateral is then
 * pulled IN from the authored distance until all three clear, because pushing
 * a landmark out to the horizon is not framing.
 */
function craneLandmark(
  ctx: ThemeContext, push: (m: THREE.Matrix4, tint: THREE.Color) => void,
): void {
  const iCrane = ctx.tagSample('crane-drop')
  if (iCrane < 0) return
  const smp = ctx.track.samples[iCrane]
  const tl = Math.hypot(smp.tangent.x, smp.tangent.z) || 1
  const rx = smp.tangent.z / tl, rz = -smp.tangent.x / tl
  const LSCALE = 3.1
  // Local x, plan radius: tracked base, mid-boom lattice, magnet disc.
  const silhouette: [number, number][] = [[0, 3.2], [5.5, 1.8], [10.4, 2.6]]
  // Measured from the corridor, so 30 m of clear yard between the forgiving
  // edge and the crane no longer depends on the ribbon staying where it was.
  const want = ctx.corridor(smp.width) + 30
  let lateral = -1
  for (let d = 0; d <= 22 && lateral < 0; d += 2) {
    for (const trial of d === 0 ? [want] : [want - d, want + d]) {
      if (trial < ctx.corridor(smp.width) + 12) continue
      const bx = smp.pos.x + rx * trial, bz = smp.pos.z + rz * trial
      // The boom is yawed along the track: local +X maps to (-rz, rx).
      const ok = silhouette.every(([lx, lr]) =>
        ctx.clearOfTrack(bx - rz * lx * LSCALE, bz + rx * lx * LSCALE, lr * LSCALE))
      if (ok) { lateral = trial; break }
    }
  }
  if (lateral < 0) return
  const x = smp.pos.x + rx * lateral, z = smp.pos.z + rz * lateral
  const g = ctx.ground(x, z)
  _euler.set(0, Math.atan2(-rx, -rz), 0)
  _quat.setFromEuler(_euler)
  _pos.set(x, g.y, z)
  _scale.setScalar(LSCALE)
  push(new THREE.Matrix4().compose(_pos, _quat, _scale), new THREE.Color(1.0, 0.92, 0.86))
}

/* ------------------------------------------------------------------ theme */

/* ----------------------------------------------------------- drift spray */

/**
 * What Rustfall throws at you when you slide on it.
 *
 * THIS PLANET IS THE SPARK PLANET. Two thirds of the lap is bare tarmac or
 * bolted steel plate under a grounded chassis, so the signature of a drift
 * here is a hard, hot, ballistic spray of struck sparks with a warm dust cloud
 * behind it. (Cryostatic is the opposite case and reads completely differently
 * — see its table.) Hues are the art-locked palette: rust close in, sodium
 * vapour on anything the light catches, and near-black for the oil.
 */
const SPRAY: SurfaceSprayTable = {
  // The default surface. Rust dust and grit off a road nobody has swept in a
  // century, and enough of a strike to keep the sparks reading as sparks.
  tarmac: {
    bulk: 0x77604c, glint: 0xd9a441, weight: 0.34, grit: 0.24,
    density: 1.00, gain: 0.46, spark: 0.60, sparkCol: 0xffb45a,
  },
  // Bolted plate. Almost no dust to lift — instead the chassis rides steel and
  // the whole budget goes into the strike, hot enough to read white at the core.
  metal: {
    bulk: 0x5d5348, glint: 0xffd9a0, weight: 0.52, grit: 0.30,
    density: 0.46, gain: 0.36, spark: 1.00, sparkCol: 0xfff0c8,
  },
  // Loose stone: the heaviest thing on the planet. Chips fly flat and drop.
  gravel: {
    bulk: 0x8a6b4a, glint: 0xd9a441, weight: 0.92, grit: 0.58,
    density: 1.25, gain: 0.52, spark: 0.14, sparkCol: 0xffa347,
  },
  // The crane drop. A slick lifts as a dark greasy sheet with an iridescent
  // sheen and almost NO spark: the one place on the circuit where the fiction
  // says the sparks should stop, and the player should be able to see that.
  oil: {
    bulk: 0x241d22, glint: 0x8a6fe0, weight: 0.58, grit: 0.26,
    density: 0.90, gain: 0.26, spark: 0.06, sparkCol: 0xff7a2f,
  },
  // Boost plate: tarmac grit, lit by the strip it is being scraped off.
  boost: {
    bulk: 0x6f6153, glint: 0x9ce8ff, weight: 0.30, grit: 0.30,
    density: 1.00, gain: 0.46, spark: 0.55, sparkCol: 0x9ce8ff,
  },
  // Rustfall authors neither of these today. They exist so a future night or
  // winter pass on this circuit is a track edit and not a code change, and
  // they are tinted to THIS planet rather than copied off the ice world.
  ice: {
    bulk: 0x9aa9ad, glint: 0xdfeef2, weight: 0.60, grit: 0.52,
    density: 0.70, gain: 0.40, spark: 0.14, sparkCol: 0xcfe8f0,
  },
  snow: {
    bulk: 0xb6bcb4, glint: 0xe8efe6, weight: 0.14, grit: 0.20,
    density: 1.40, gain: 0.48, spark: 0.00, sparkCol: 0xe8efe6,
  },
}

const _rust = new THREE.Color()
const _scrap = new THREE.Color()
const _sodium = new THREE.Color()

export const RUSTFALL_THEME: Theme = {
  id: 'rustfall',

  props(pal, seg) {
    // Counts are up ~15% on the original: the ribbon got 50% wider without the
    // world getting any bigger, so the same instance count reads as a thinner
    // junkyard — at 39 m of road the camera simply sees more plain per prop.
    return [
      {
        name: 'crushed-car', geo: propCrushedCar(pal, seg), count: 170,
        radius: 2.6, gap: 2.0, spread: 62, scale: [0.85, 1.5],
        // Stacked cars line the bounce corridor — its visual signature.
        cluster: { tag: 'bounce', span: 190, share: 0.42 },
      },
      {
        name: 'scrap-tower', geo: propTower(pal, seg), count: 110,
        radius: 3.4, gap: 3.5, spread: 150, scale: [0.8, 1.9],
        // Towers are the tall silhouette element, so they give the rebuilt
        // final corner an outside wall to turn against.
        cluster: { tag: 'final-corner', span: 260, share: 0.30 },
      },
      {
        name: 'pipe-stack', geo: propPipes(pal, seg), count: 86,
        // 8.5 m pipes across a 4.4 m pallet: the plan half-diagonal is 4.8.
        radius: 5.0, gap: 2.5, spread: 120, scale: [0.8, 1.5],
        cluster: { tag: 'start', span: 460, share: 0.34 },
      },
      {
        name: 'hull-section', geo: propHull(pal, seg), count: 30,
        // 15 m barrel plus ribs and two torn plates: 8.5 x 7.5 in plan.
        radius: 11.3, gap: 6, spread: 230, scale: [0.9, 2.1],
      },
      {
        name: 'crane-arm', geo: propCrane(pal, seg), count: 14,
        // The boom reaches x = 10.4 and carries a 2.3 m magnet on the end.
        // Declared as 8.0 it was under by 4.7 m — 8.5 m once scaled — which is
        // how a scattered crane came to hang its magnet 2.5 m over the high
        // side of the cargo ring.
        radius: 13.0, gap: 8, spread: 210, scale: [1.0, 1.8],
        cluster: { tag: 'crane-drop', span: 150, share: 0.4 },
        landmark: craneLandmark,
      },
      {
        name: 'smelt-chimney', geo: propChimney(pal, seg), count: 17,
        radius: 4.6, gap: 24, spread: 320, scale: [0.9, 2.4],
        cluster: { tag: 'ramp-chasm', span: 260, share: 0.45 },
      },
    ] satisfies PropSpec[]
  },

  landmarks,

  terrainColor(out, p: TerrainPoint, pal) {
    // Rust close in, scrap grey in the hollows, sodium dusting on the ridges.
    _rust.setHex(pal.a); _scrap.setHex(pal.c); _sodium.setHex(pal.b)
    out.copy(_scrap).lerp(_rust, 0.16 + 0.78 * p.macro)
    out.lerp(_sodium, p.ridge * 0.20 + Math.max(0, p.mid - 0.66) * 0.55)
    const near = Math.min(1, Math.max(0, p.edge) / 40)
    out.multiplyScalar(0.62 + 0.30 * (1 - near) + 0.18 * p.grit + 0.26 * p.mid)
  },
  terrainMaterial: { roughness: 0.97, metalness: 0.03 },
  terrainFade: [110, 580],
  propMaterial: { roughness: 0.88, metalness: 0.22 },

  motes: {
    count: 1100, box: 150, size: [1.4, 5.9], pixel: 220, maxPixels: 34,
    alpha: 0.5, fall: 0, streak: 0,
    color: (pal, fog) => new THREE.Color().setHex(pal.b).lerp(fog, 0.45),
  },
  /**
   * THE SKY OVER A SHIPBREAKING YARD.
   *
   * Rustfall's whole premise is that things come here to be taken apart, and
   * the sky says so before the track does: a ringed gas giant low over the
   * horizon, and the ring is not ice -- it is the yard's own intake, a belt of
   * hulls waiting to come down. The giant sits LOW and large because the
   * planet's own dust haze is the thing that sells scale, and a body near the
   * horizon is read against the terrain rather than floating in empty sky.
   *
   * Colour is pulled toward the track's own rust so it belongs to this
   * palette; a cold blue giant over an orange planet reads as two pictures.
   */
  sky: {
    band: 'strata',
    // A hot dust glow lying along the skyline: this planet's light is a low
    // sun through an atmosphere full of grit, and the band is where that gets
    // said. Warmer and redder than the sky above it.
    horizonColor: 0xff7a2e,
    horizonSpan: [0.040, 0.26],
    horizonGain: 0.58,
    celestial: {
      gain: 0.92,
      bodies: [{
        // Deliberately DARKER and more saturated than the sky it hangs in.
        // At the sky's own value it vanished: a body reads by contrast, and
        // this planet's sky is a wall of orange.
        // ON THE HORIZON, and enormous. A body high in the sky is scenery you
        // have to go looking for; a body sitting on the skyline is in the
        // frame the whole lap, gets occluded by the yard's own gantries and
        // cranes, and is read against them for scale.
        // ANTI-SOLAR. The key on this track is up and to the left; a body
        // in that half of the sky is backlit, and the honest render of a
        // backlit planet is a crescent. Opposite the key it is 82% lit --
        // still a visible terminator across the lower right, but a sphere
        // rather than a sliver.
        dir: [0.788, 0.055, -0.613],
        sizeDeg: 26,
        color: 0x8f4f2c,
        bandColor: 0x4a2517,
        bands: 7,
        mottle: 0.36,
        shade: 0.74,
        limb: 0.70,
        ring: {
          /**
           * PULLED IN, because the ring has to fit the same frame the giant
           * does. At 2.55 radii the ring's top sat 20 degrees up and its
           * sides 33 degrees out, against a viewport that is +/-16 vertical
           * and +/-28 horizontal at this FOV: the whole annulus was outside
           * the picture, which is why the shipped frame had a banded planet
           * and no ring at all. 1.85 puts the far edge at 23 degrees from
           * centre, inside both.
           */
          inner: 1.18, outer: 1.85, color: 0xe8c9a4, opacity: 0.62,
          /**
           * OPENED TO 34 DEGREES, measured against the body direction rather
           * than eyeballed. A ring's axis near world up is only "tilted" for
           * a body high in the sky; with the giant moved down onto the
           * skyline that same axis became perpendicular to the view and the
           * ring collapsed to a line -- it was absent from the shipped frame
           * entirely. asin(dot(axis, dir)) is the opening angle, and 34
           * degrees is a readable ellipse with the near half still crossing
           * in front of the disc.
           */
          axis: [0.402, 0.861, -0.312],
        },
      }],
      // The intake queue: rubble strung around the same plane as the ring,
      // reaching across the sky toward the yard.
      belt: {
        // Same plane as the ring, because it is the same queue.
        axis: [0.402, 0.861, -0.312],
        tiltDeg: 6,
        widthDeg: 2.6,
        color: 0xb08a63,
        density: 0.11,
        driftDeg: 0.22,
        gain: 0.85,
      },
      // Derelicts under tow, dark against the haze. Barely any running lights
      // -- these are dead hulls being walked down the well, not a fleet.
      ships: {
        dir: [-0.34, 0.085, 0.94],
        spreadDeg: 30,
        sizeDeg: 2.6,
        color: 0x2a1c16,
        lightColor: 0xff9a4a,
        lightGain: 0.30,
        count: 4,
        driftDeg: 0.10,
      },
    },
  },
  fogBanks: null,
  weather: null,
  road: 'industrial',
  spray: SPRAY,
}
