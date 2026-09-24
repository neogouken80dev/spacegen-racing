/**
 * The page tools/probe-kinds.mjs drives. See that file for what it is for.
 *
 * One burst per particle kind, IDENTICAL in every argument but `kind`, drawn
 * on its own pool into its own scene, and the framebuffer read back. Nothing
 * here knows what a kind is supposed to look like: it only knows that a kind
 * which emits sixty particles and lights zero pixels is not drawing.
 */
import * as THREE from 'three'
import { ParticlePool } from '/src/render/particles.ts'

const W = 640, H = 480
const canvas = document.getElementById('c')
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: false, alpha: false, preserveDrawingBuffer: true,
})
renderer.setPixelRatio(1)
renderer.setSize(W, H, false)
renderer.setClearColor(0x000000, 1)

// Thirty metres out, which is past the far end of every near-fade window in
// the shader (the widest is smoke's 2.6-9.5), so no kind is dimmed for being
// close to the lens.
//
// TWO CAMERAS, BECAUSE ONE KIND IS NOT A BILLBOARD. K_SURFRING lies in the
// plane perpendicular to its axis, which defaults to world +Y, so it is a
// disc lying flat on the ground -- and a disc on the ground photographed from
// ground level is an edge-on line. That is the probe being wrong about how
// the kind is seen, not the kind failing to draw: in game it is a shockwave
// under a car, viewed by a chase camera that looks down at it. So that one
// kind is photographed from above, which is the only view it has ever had.
const camSide = new THREE.PerspectiveCamera(50, W / H, 0.1, 1000)
camSide.position.set(0, 0, 30)
camSide.lookAt(0, 0, 0)
const camTop = new THREE.PerspectiveCamera(50, W / H, 0.1, 1000)
camTop.position.set(0, 30, 0)
camTop.lookAt(0, 0, 0)

const gl = renderer.getContext()
function measure() {
  const buf = new Uint8Array(W * H * 4)
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
  let n = 0, sum = 0
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9
  for (let i = 0; i < W * H; i++) {
    const v = buf[i * 4] + buf[i * 4 + 1] + buf[i * 4 + 2]
    if (v > 12) {
      n++
      sum += v
      const x = i % W, y = (i / W) | 0
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  return {
    lit: n,
    mean: n ? +(sum / n).toFixed(1) : 0,
    box: n ? [maxX - minX + 1, maxY - minY + 1] : [0, 0],
  }
}

const COL = new Float32Array([1.0, 0.85, 0.5])
const KINDS = [
  ['K_SPRITE', 0], ['K_SPARK', 1], ['K_RING', 2], ['K_SURFRING', 3],
  ['K_SHELL', 4], ['K_SMOKE', 5], ['K_BEAM', 6], ['K_BEAD', 7],
]

const out = []
for (const [name, kind] of KINDS) {
  const scene = new THREE.Scene()
  const pool = new ParticlePool(2000)
  scene.add(pool.mesh)
  const overhead = kind === 3
  const cam = overhead ? camTop : camSide
  const cy = overhead ? 30 : 0
  const cz = overhead ? 0 : 30
  pool.beginFrame(0, 0, cy, cz)
  pool.burst(0, 0, 0, 0, 0, 0, 60, 8.0, 1.0, COL, 1.0, 1.2, 0.45, kind, 0, 0)
  pool.flush()
  // Advance only the clock, so every kind is photographed at the same age.
  pool.beginFrame(0.25, 0, cy, cz)
  renderer.render(scene, cam)
  out.push({ name, kind, view: overhead ? 'top' : 'side', ...measure() })
  scene.remove(pool.mesh)
  pool.dispose()
}

/**
 * THE SHAPE PASS: is each kind a DISC, or the quad it is drawn on?
 *
 * The burst above answers "does anything reach a pixel". It cannot see this
 * bug, which is the opposite one: every smoke puff in the game reached a
 * pixel all the way out to the corners of its quad, because the gaussian was
 * still at 13.5% of peak on the quad's edge, and additive blending drew the
 * tile. Sixty particles at random rotations hide that in their own overlap.
 *
 * So: ONE particle per kind, about 140 px across, HDR-bright so a faint edge
 * lights pixels the way it does over a dark road under bloom, and seeded so
 * the quad is axis-aligned (seed 0.5 puts the shader's spin at exactly pi
 * with no drift over age, and a square turned by pi is the same square).
 * Then the lit pixels are compared with their own bounding box: a disc fills
 * pi/4 = 78.5% of it, an axis-aligned square fills 100%, and an annulus less
 * than either. probe-kinds.mjs fails anything over 85%.
 *
 * K_BEAM is photographed and reported but not judged: it is a light column,
 * square-ended at the ground by design, and its lower half is buried in the
 * road in every frame the game actually draws.
 */
const shape = []
const HOT = new Float32Array([3.0, 2.55, 1.5])
for (const [name, kind] of KINDS) {
  const scene = new THREE.Scene()
  const pool = new ParticlePool(8, () => 0.5)
  scene.add(pool.mesh)
  const overhead = kind === 3
  const cam = overhead ? camTop : camSide
  const cy = overhead ? 30 : 0
  const cz = overhead ? 0 : 30
  pool.beginFrame(0, 0, cy, cz)
  pool.spawn(0, 0, 0, 0, 0, 0, HOT[0], HOT[1], HOT[2], 1.2, 8.0, 0, 0, 0, kind)
  pool.flush()
  pool.beginFrame(0.25, 0, cy, cz)
  renderer.render(scene, cam)
  const m = measure()
  const boxArea = m.box[0] * m.box[1]
  shape.push({
    name, kind, view: overhead ? 'top' : 'side', ...m,
    fill: boxArea > 0 ? +(m.lit / boxArea).toFixed(3) : 0,
    judged: kind !== 6,
    // The photograph itself, so `--shots` can write it out and a person can
    // look at the corner the number is about.
    png: canvas.toDataURL('image/png'),
  })
  scene.remove(pool.mesh)
  pool.dispose()
}
window.__SHAPE__ = shape
window.__KINDS__ = out
