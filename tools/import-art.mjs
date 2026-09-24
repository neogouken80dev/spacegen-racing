// Import the avatar and badge art: square PNGs in, three WebP sizes out, and
// the manifest that tells the game which ids have art.
//
// Usage:
//   node tools/import-art.mjs --src=<folder>   (holding avatars/ and badges/)
//   node tools/import-art.mjs --check          (manifest vs public/, no writes)
//
// The source folder is the one the image generator hands back -- e.g. the
// unzipped `spacegen_assets/` -- with files named by id: `avatars/cadet.png`,
// `badges/track-victory.png`. Drop a new one in, run this, commit public/ and
// src/content/artManifest.ts. Nothing else changes: the game looks every image
// up through the manifest, so a new file is live on the next build and a
// missing one falls back to its stand-in instead of a broken image.
//
// WHY THREE SIZES AND NOT ONE. The generator delivers 1254 px squares at about
// 1.7 MB each -- 80 MB for the set, on a game that has to load on a phone. The
// art is seen at three scales: a nameplate chasing a car at 16-22 px, a picker
// or achievement tile at 48-96 px, and a detail card or unlock toast at up to
// 256 px. At a 3x phone those need 64, 288 and 768 device pixels; 128/256/512
// covers each with the next size up, and the picker never downloads a 512 to
// draw it at 48. The whole set comes to a few megabytes, fetched only as the
// screens that show it open.
//
// WHY WEBP. Every browser the game supports decodes it (Safari since 14), it
// is about a fifth of the PNG at the same look, and these are painted
// portraits with soft glows -- exactly where WebP's lossy mode is invisible
// and PNG's lossless mode is wasted.
//
// THE ACCENT IS REPORTED, NOT WRITTEN. Each avatar's ring colour lives in
// src/content/avatars.ts, curated by hand, because it has a job beyond
// matching the art: the twenty-four accents are spread around the hue wheel
// and kept off the HUD's reds and ambers. This prints what the art's own glow
// measures as, so the curated value can be checked against it -- it does not
// overwrite a choice somebody made on purpose.
import sharp from 'sharp';
import { readdirSync, existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [128, 256, 512];
// Smaller outputs get more quality: at 128 px every pixel is a feature, and
// the file is tiny either way.
const QUALITY = { 128: 88, 256: 84, 512: 82 };
const KINDS = ['avatars', 'badges'];
const MANIFEST = path.join(ROOT, 'src/content/artManifest.ts');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));

/** Ids are lowercase letters, digits and hyphens: what the catalogues use. */
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const CURATED = curatedAccents();

async function importKind(src, kind) {
  const dir = path.join(src, kind);
  if (!existsSync(dir)) return [];
  const out = path.join(ROOT, 'public', kind);
  mkdirSync(out, { recursive: true });
  const done = [];
  for (const file of readdirSync(dir).sort()) {
    const ext = path.extname(file).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) continue;
    const id = path.basename(file, path.extname(file)).toLowerCase();
    if (!ID.test(id)) {
      console.warn(`  skip ${kind}/${file}: "${id}" is not an id (lowercase, digits, hyphens)`);
      continue;
    }
    const input = path.join(dir, file);
    const meta = await sharp(input).metadata();
    // A non-square source is centre-cropped rather than squashed: the game
    // crops to a circle, and a stretched face is worse than a trimmed edge.
    const side = Math.min(meta.width, meta.height);
    if (meta.width !== meta.height) {
      console.warn(`  ${kind}/${file} is ${meta.width}x${meta.height}; centre-cropping to ${side}`);
    }
    const base = sharp(input).extract({
      left: Math.floor((meta.width - side) / 2),
      top: Math.floor((meta.height - side) / 2),
      width: side, height: side,
    }).removeAlpha().toColourspace('srgb');
    let bytes = 0;
    for (const n of SIZES) {
      const target = path.join(out, `${id}-${n}.webp`);
      await base.clone().resize(n, n, { kernel: 'lanczos3' })
        .webp({ quality: QUALITY[n], effort: 6, smartSubsample: true })
        .toFile(target);
      bytes += statSync(target).size;
    }
    let note = '';
    if (kind === 'avatars') {
      const glow = await glowOf(input);
      const curated = CURATED.get(id);
      if (glow && curated) {
        const d = Math.abs(hueOf(glow) - hueOf(curated));
        const off = Math.min(d, 360 - d);
        note = `  glow ${glow} vs accent ${curated} (${off.toFixed(0)} deg${off > 30 ? ' -- LOOK AT IT' : ''})`;
      } else if (glow) {
        note = `  glow ${glow} (no curated accent for this id)`;
      }
    }
    done.push({ id, bytes });
    console.log(`  ${kind}/${id}  ${(bytes / 1024).toFixed(0)} KB for ${SIZES.length} sizes${note}`);
  }
  return done;
}

/**
 * The colour of the art's background glow, measured.
 *
 * Every portrait was prompted with a single-hue rim light and a halo of the
 * same hue behind the head -- and ALSO with a warm key light from the upper
 * left, which is why the first version of this read nearly every avatar as
 * orange: it sampled the whole outer ring, and the outer ring is mostly lit
 * shoulders and costume. The halo is cleanest in the UPPER arc of the circle
 * the game shows, above and beside the head, so that is all this reads: a hue
 * histogram weighted by saturation and brightness, peak bin, mean of its
 * pixels, lifted to ring brightness.
 *
 * It is still a measurement of a painting. Tall headgear (a hat brim, a
 * luchador mask, a zombie's cap) fills that arc on a few portraits and pulls
 * the reading toward the costume, so a large disagreement with the curated
 * accent is a prompt to look, not a correction to apply.
 */
async function glowOf(input) {
  const N = 160;
  const { data } = await sharp(input).removeAlpha().resize(N, N).raw().toBuffer({ resolveWithObject: true });
  const BINS = 72;
  const w = new Float64Array(BINS);
  const sum = Array.from({ length: BINS }, () => [0, 0, 0]);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = (x + 0.5) / N - 0.5, dy = (y + 0.5) / N - 0.5;
      const rr = Math.sqrt(dx * dx + dy * dy) / 0.5;
      if (rr < 0.62 || rr > 1.0 || dy > 0.05) continue;
      const i = (y * N + x) * 3;
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const v = max, s = max > 0 ? (max - min) / max : 0;
      if (s < 0.35 || v < 0.12) continue;
      const d = max - min;
      let h;
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
      const k = Math.floor(h / (360 / BINS)) % BINS;
      const wt = s * v;
      w[k] += wt;
      sum[k][0] += r * wt; sum[k][1] += g * wt; sum[k][2] += b * wt;
    }
  }
  let best = 0, bestW = -1;
  for (let k = 0; k < BINS; k++) {
    const s3 = w[(k + BINS - 1) % BINS] + w[k] + w[(k + 1) % BINS];
    if (s3 > bestW) { bestW = s3; best = k; }
  }
  let R = 0, G = 0, B = 0, W = 0;
  for (const k of [(best + BINS - 1) % BINS, best, (best + 1) % BINS]) {
    R += sum[k][0]; G += sum[k][1]; B += sum[k][2]; W += w[k];
  }
  if (W <= 0) return null;
  R /= W; G /= W; B /= W;
  const m = Math.max(R, G, B);
  const lift = m > 0 ? 0.9 / m : 1;
  const hex = (c) => Math.round(Math.min(1, c * lift) * 255).toString(16).padStart(2, '0');
  return '#' + hex(R) + hex(G) + hex(B);
}

/** Hue in degrees of a #rrggbb colour. */
function hueOf(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

/** The curated accents, read out of avatars.ts so the report can compare. */
function curatedAccents() {
  const src = readFileSync(path.join(ROOT, 'src/content/avatars.ts'), 'utf8');
  const out = new Map();
  for (const m of src.matchAll(/def\('([a-z0-9-]+)',[^\n]*'(#[0-9a-fA-F]{6})'\)/g)) out.set(m[1], m[2]);
  return out;
}

/** What public/ actually holds: ids with every size present. */
function present(kind) {
  const dir = path.join(ROOT, 'public', kind);
  if (!existsSync(dir)) return [];
  const files = new Set(readdirSync(dir));
  const ids = new Set();
  for (const f of files) {
    const m = /^(.+)-(\d+)\.webp$/.exec(f);
    if (m) ids.add(m[1]);
  }
  return [...ids].filter((id) => SIZES.every((n) => files.has(`${id}-${n}.webp`))).sort();
}

function manifestSource() {
  const list = (ids) => ids.length === 0 ? '[]'
    : '[\n' + ids.map((id) => `  '${id}',`).join('\n') + '\n]';
  return `/**
 * SpaceGen Racing — WHICH ART EXISTS.
 * ---------------------------------------------------------------------------
 * GENERATED by tools/import-art.mjs from the files in public/. Do not edit by
 * hand: run \`node tools/import-art.mjs --src=<folder>\` to add art, and the
 * tool rewrites this list from what is actually on disk.
 *
 * An id here has \`public/<kind>/<id>-<size>.webp\` at every size in ART_SIZES.
 * An id NOT here has no art yet and is drawn as its stand-in, which is how a
 * roster can be twenty-three portraits and one placeholder without a broken
 * image anywhere. tests/art.test.ts holds this list to the folder.
 */

/** Square edge lengths, in pixels, that every art file is exported at. */
export const ART_SIZES = [${SIZES.join(', ')}] as const

export type ArtSize = typeof ART_SIZES[number]

/** Avatar ids with art in public/avatars/. */
export const AVATAR_ART: readonly string[] = ${list(present('avatars'))}

/** Badge ids with art in public/badges/. */
export const BADGE_ART: readonly string[] = ${list(present('badges'))}
`;
}

async function main() {
  if (args.check) {
    const want = manifestSource();
    const have = existsSync(MANIFEST) ? readFileSync(MANIFEST, 'utf8') : '';
    if (want !== have) {
      console.error('artManifest.ts does not match public/ -- run node tools/import-art.mjs');
      process.exit(1);
    }
    console.log('artManifest.ts matches public/');
    return;
  }
  const src = typeof args.src === 'string' ? path.resolve(args.src) : null;
  if (!src || !existsSync(src)) {
    console.error('usage: node tools/import-art.mjs --src=<folder holding avatars/ and badges/>');
    process.exit(2);
  }
  let total = 0;
  for (const kind of KINDS) {
    console.log(`${kind}:`);
    const done = await importKind(src, kind);
    total += done.reduce((a, d) => a + d.bytes, 0);
  }
  writeFileSync(MANIFEST, manifestSource());
  console.log(`\nwrote ${path.relative(ROOT, MANIFEST)}; ${(total / 1048576).toFixed(2)} MB of WebP in all`);
}

main().catch((e) => { console.error(e); process.exit(1); });
