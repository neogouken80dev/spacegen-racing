/**
 * IS THE SKY ACTUALLY VISIBLE, OR MERELY IN THE FRUSTUM?
 *
 * probe-attract.mjs reported the black hole in frame 100% of the time and it
 * was telling the truth: the hole's direction really did project inside the
 * view. The screenshots showed a start/finish gantry filling that exact part of
 * the picture. In-frustum is not visible, and a projection test cannot tell the
 * difference -- it knows where things are and nothing about what is in front of
 * them.
 *
 * So this looks at PIXELS. Point the camera, render, read the patch where the
 * hole is supposed to be, and ask whether what came back looks like an
 * accretion disc (bright, warm, saturated) or like a piece of unlit structure.
 * It is the same A/B discipline that found the invisible ring in the sky shader:
 * when two models disagree with a picture, believe the picture.
 *
 *   node tools/probe-attract-sky.mjs [--tag=x]
 *
 * Run it after changing an attract shot. It prints the patch statistics so a
 * threshold can be set from measurement rather than from taste.
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { execFileSync } from 'node:child_process'

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1]
const TAG = arg('tag', 'x')
const W = Number(arg('w', 1600))
const H = Number(arg('h', 900))

const ROOT = new URL('../dist/', import.meta.url).pathname
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
}
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url || '/').split('?')[0])
    if (p === '/' || p.endsWith('/')) p += 'index.html'
    const buf = await readFile(join(ROOT, p))
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' })
    res.end(buf)
  } catch { res.writeHead(404); res.end('nf') }
})
await new Promise((r) => server.listen(0, r))
const url = `http://127.0.0.1:${server.address().port}/`

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-gpu-sandbox', '--no-sandbox', '--ignore-gpu-blocklist'],
})
const page = await (await browser.newContext({
  viewport: { width: W, height: H }, deviceScaleFactor: 1,
})).newPage()
await page.goto(url, { waitUntil: 'load', timeout: 30000 })
await page.waitForTimeout(6000)

const info = await page.evaluate(() => {
  const g = window.__GAME__
  const cam = g.chase.camera
  const cel = g.theme?.sky?.celestial
  const hero = cel?.hole ?? cel?.bodies?.[0]
  if (!hero) return null
  const project = (x, y, z) => {
    const m = cam.matrixWorldInverse.elements
    const vx = m[0] * x + m[4] * y + m[8] * z + m[12]
    const vy = m[1] * x + m[5] * y + m[9] * z + m[13]
    const vz = m[2] * x + m[6] * y + m[10] * z + m[14]
    const p = cam.projectionMatrix.elements
    const cx = p[0] * vx + p[4] * vy + p[8] * vz + p[12]
    const cy = p[1] * vx + p[5] * vy + p[9] * vz + p[13]
    const cw = p[3] * vx + p[7] * vy + p[11] * vz + p[15]
    const w = cw === 0 ? 1e-6 : cw
    return { x: cx / w, y: cy / w, inFront: vz < 0 }
  }
  const d = hero.dir
  const len = Math.hypot(d[0], d[1], d[2]) || 1
  const r = project(
    cam.position.x + (d[0] / len) * 3000,
    cam.position.y + (d[1] / len) * 3000,
    cam.position.z + (d[2] / len) * 3000,
  )
  return {
    ndc: { x: r.x, y: r.y }, inFront: r.inFront,
    sizeDeg: hero.sizeDeg, fov: cam.fov,
    s: g.track?.def?.id, phase: g.phase,
  }
})
console.log('hole:', JSON.stringify(info))

const dir = new URL('../shots/', import.meta.url).pathname
await mkdir(dir, { recursive: true })

// Hide the front end so the scrim and the logo are not part of the measurement.
await page.evaluate(() => {
  const fe = document.querySelector('.sg-fe')
  if (fe) fe.style.display = 'none'
})
await page.waitForTimeout(1500)

const full = `${dir}attract-sky-${TAG}.png`
await page.screenshot({ path: full })

// The disc is `sizeDeg` across; sample a patch a little wider than that so the
// bright ring is inside it even if the shadow centre is not.
const px = Math.round((info.ndc.x * 0.5 + 0.5) * W)
const py = Math.round((1 - (info.ndc.y * 0.5 + 0.5)) * H)
const half = Math.round((info.sizeDeg / info.fov) * H * 0.9)
console.log(`hole at pixel (${px}, ${py}), patch half-size ${half}px`)

const py3 = `
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
W,H = im.size
px,py,half = int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
box = (max(0,px-half), max(0,py-half), min(W,px+half), min(H,py+half))
patch = im.crop(box)
pix = list(patch.getdata())
n = len(pix)
lum = [0.2126*r+0.7152*g+0.0722*b for r,g,b in pix]
mean = sum(lum)/n
mx = max(lum)
# "Disc-like": bright AND warm. Unlit structure in this scene is dark red, which
# is warm but not bright; the accretion disc is both.
hot = sum(1 for (r,g,b),l in zip(pix,lum) if l > 110 and r > 150 and r > b*1.5)
print('%.1f %.1f %.4f' % (mean, mx, hot/n))
`
const out = execFileSync('python3', ['-c', py3, full, String(px), String(py), String(half)])
  .toString().trim().split(/\s+/).map(Number)
const [mean, mx, hot] = out

console.log(`\npatch mean luminance ${mean.toFixed(1)}   max ${mx.toFixed(1)}`)
console.log(`disc-like pixels     ${(hot * 100).toFixed(1)}%`)
console.log(full)

/**
 * THIS REPORTS. IT DOES NOT GATE, AND THAT IS A CORRECTION.
 *
 * The first version of this file asserted "disc-like pixels > 4%" on the theory
 * that an accretion disc is bright and warm. Measured against the real renderer
 * that theory is wrong: at s=152 the hole came back as a DARK lensed shadow
 * with a pale rim, against a bright hazy sky -- mean luminance 159, and 0.3% by
 * the warm-and-bright rule. The rule would have failed a shot that shows the
 * hole perfectly well, which is worse than having no rule: a gate that lies
 * gets believed.
 *
 * The honest instrument is the patch statistics plus the saved frame. A human
 * decides whether the subject is on screen; this makes that cheap and
 * repeatable rather than pretending to decide it.
 */
const ok = true
console.log(`\nSaved ${full} -- look at it. Patch stats above are advisory:`)
console.log('the hole reads as a dark lensed disc on this track, not a bright one,')
console.log('so low "disc-like" does NOT mean occluded. Compare frames, do not trust one number.')

await browser.close()
server.close()
process.exit(ok ? 0 : 1)
