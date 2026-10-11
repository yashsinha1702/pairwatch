// Render one or more SVG files at several animation times into a single PNG filmstrip.
// Handles SMIL (svg.setCurrentTime) and CSS animations (document.getAnimations()).
//
// usage: PAIRWATCH_TOOLS=<folder> node dev/filmstrip.mjs out.png [--times 0,0.5,1,2] [--width 560] [--dark|--light] a.svg [b.svg ...]
//   each input row = one svg; each column = one time (seconds)
// PAIRWATCH_TOOLS is a folder where Playwright is installed (its node_modules/playwright). Chromium comes
// from PLAYWRIGHT_BROWSERS_PATH, else from <PAIRWATCH_TOOLS>/browsers when that exists, else from
// Playwright's own cache.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';

const HELP = `The filmstrips need Playwright with Chromium. Install them once, in a folder of your choice:
  mkdir -p ~/pw-tools && cd ~/pw-tools && npm init -y && npm install playwright
  PLAYWRIGHT_BROWSERS_PATH="$PWD/browsers" npx playwright install chromium
(on Linux, add --with-deps to that line if Chromium lacks system libraries), then point PAIRWATCH_TOOLS at it:
  export PAIRWATCH_TOOLS=~/pw-tools`;

const args = process.argv.slice(2);
const out = args.shift();
let times = [0, 0.4, 1, 2.5];
let width = 560;
let bg = '#1e1e1e'; // VS Code dark editor background by default
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--times') times = args[++i].split(',').map(Number);
  else if (args[i] === '--width') width = Number(args[++i]);
  else if (args[i] === '--light') bg = '#ffffff';
  else if (args[i] === '--dark') bg = '#1e1e1e';
  else files.push(args[i]);
}
if (!out || files.length === 0) {
  console.error('usage: PAIRWATCH_TOOLS=<folder with playwright> node dev/filmstrip.mjs out.png [--times 0,0.5,1] [--width 560] [--light] a.svg [...]');
  process.exit(2);
}

const TOOLS = process.env.PAIRWATCH_TOOLS;
if (!TOOLS) {
  console.error(`filmstrip: PAIRWATCH_TOOLS is not set.\n${HELP}`);
  process.exit(2);
}
const tools = resolve(TOOLS);
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(join(tools, 'browsers'))) process.env.PLAYWRIGHT_BROWSERS_PATH = join(tools, 'browsers');
let chromium;
try {
  ({ chromium } = createRequire(join(tools, 'filmstrip.cjs'))('playwright'));
} catch {
  console.error(`filmstrip: Playwright is not installed in PAIRWATCH_TOOLS (${tools}).\n${HELP}`);
  process.exit(2);
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const cells = files.map(f => readFileSync(f, 'utf8'));
// Each cell is an <iframe srcdoc> so every SVG gets its own document timeline, like the
// sandboxed frame the VS Code surface draws an isInteractive Svg in.
const html = `<!doctype html><html><head><style>
  body{margin:0;background:${bg};font:11px/1.3 monospace;color:#888}
  table{border-collapse:collapse} td{padding:6px;vertical-align:top}
  iframe{border:0;width:${width}px;background:transparent;display:block}
</style></head><body><table>
<tr><td></td>${times.map(t => `<td>t=${t}s</td>`).join('')}</tr>
${cells.map((src, r) => `<tr><td>${esc(basename(files[r]))}</td>${times.map((_, c) =>
  `<td><iframe id="f${r}_${c}" sandbox="allow-same-origin" srcdoc="${src.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe></td>`).join('')}</tr>`).join('\n')}
</table></body></html>`;

let browser;
try {
  browser = await chromium.launch();
} catch (e) {
  console.error(`filmstrip: Chromium did not start: ${String(e?.message ?? e).split('\n')[0]}\n${HELP}`);
  process.exit(2);
}
const page = await browser.newPage({ viewport: { width: 200 + (width + 12) * times.length, height: 400 } });
await page.setContent(html, { waitUntil: 'load' });
for (let r = 0; r < files.length; r++) {
  for (let c = 0; c < times.length; c++) {
    const handle = await page.$(`#f${r}_${c}`);
    const fr = await handle.contentFrame();
    const h = await fr.evaluate(t => {
      const svg = document.querySelector('svg');
      if (svg && svg.pauseAnimations) { svg.pauseAnimations(); svg.setCurrentTime(t); }
      for (const a of document.getAnimations()) { a.pause(); a.currentTime = t * 1000; }
      const b = svg ? svg.getBoundingClientRect() : { height: 100 };
      return Math.ceil(b.height) + 4;
    }, times[c]);
    await handle.evaluate((el, h) => { el.style.height = h + 'px'; }, h);
  }
}
const body = await page.$('table');
await body.screenshot({ path: out });
await browser.close();
console.log('wrote', out);
