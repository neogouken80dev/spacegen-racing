// Feed every declaration in styles.css to a real CSS parser and report the ones
// the parser throws away.
//
// A dropped declaration is silent in the browser and invisible in a screenshot
// whenever the fallback happens to be legible -- which is exactly how
// `font: 800 clamp(34px,6.6vw,64px)/1 inherit` survived several commits. A
// CSS-wide keyword like `inherit` may not appear as PART of a shorthand value,
// so the whole declaration was discarded and the score HUD rendered at the
// 16px/400 default while looking merely "a bit small" in every screenshot.
//
// Usage: node tools/probe-css.mjs   (exit 1 if anything is dropped)
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['src/ui/styles.css'];

const decls = [];
const skipped = [];
for (const rel of FILES) {
  const css = readFileSync(path.join(ROOT, rel), 'utf8');
  // Blank out comments without moving any line numbers.
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const lines = clean.split('\n');
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const text = raw.trim();
    const opens = (raw.match(/\{/g) || []).length;
    const closes = (raw.match(/\}/g) || []).length;
    // Inside a block, on its own line, and shaped like a declaration.
    if (depth > 0 && opens === 0 && closes === 0 && /^[-a-zA-Z]/.test(text) && text.includes(':') && text.endsWith(';')) {
      // Vendor-prefixed properties are deliberately engine-specific: Chromium
      // discards -webkit-backdrop-filter, Safari needs it. Only flag them when
      // the rule does NOT also carry the unprefixed spelling.
      const prefixed = /^-(webkit|moz|ms|o)-/.exec(text);
      if (prefixed) { skipped.push({ file: rel, line: i + 1, text }); continue; }
      decls.push({ file: rel, line: i + 1, text });
    }
    depth += opens - closes;
  }
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
await page.setContent('<div id=t></div>');

const dropped = await page.evaluate((items) => {
  const el = document.createElement('style');
  document.head.appendChild(el);
  const bad = [];
  for (const it of items) {
    el.textContent = `#t{${it.text}}`;
    const rule = el.sheet.cssRules[0];
    if (!rule || rule.style.length === 0) bad.push(it);
  }
  return bad;
}, decls);

await browser.close();

console.log(JSON.stringify({
  checked: decls.length,
  skippedVendorPrefixed: skipped.length,
  droppedCount: dropped.length,
  dropped,
}, null, 2));
if (dropped.length) {
  console.error(`\nFAIL: ${dropped.length} declaration(s) discarded by the CSS parser.`);
  process.exit(1);
}
console.log('\nOK: every declaration parsed.');
