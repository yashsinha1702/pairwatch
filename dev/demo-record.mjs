// Plays dev/demo.ts's snapshots into the real page (pairwatch/viewer/index.html) and saves a PNG per frame.
//   PAIRWATCH_TOOLS=<folder> node dev/demo-record.mjs snapshots.json FRAMES_DIR [--fps 12] [--width 760]
// The page's EventSource and fetch are stubbed, so each snapshot arrives the way its server pushes it.
// Animation time is set for every frame (SMIL + CSS, as dev/filmstrip.mjs does), so the capture is
// the same on every run. Long waits are shortened: a snapshot stays up for its real gap, kept between
// 0.5 and 1.7 s, and the last one for 3.5 s.
// PAIRWATCH_TOOLS is a folder where Playwright is installed (see dev/filmstrip.mjs); PAIRWATCH_CHROMIUM,
// when set, is the Chromium binary to launch instead of Playwright's own.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const [snapsFile, outDir] = args;
if (!snapsFile || !outDir) {
  console.error('usage: PAIRWATCH_TOOLS=<folder with playwright> node dev/demo-record.mjs snapshots.json FRAMES_DIR [--fps 12] [--width 760]');
  process.exit(2);
}
const FPS = Number(opt('--fps', '12'));
const WIDTH = Number(opt('--width', '760'));
const TOOLS = process.env.PAIRWATCH_TOOLS;
if (!TOOLS) {
  console.error('demo-record: PAIRWATCH_TOOLS is not set. See dev/filmstrip.mjs for installing Playwright with Chromium.');
  process.exit(2);
}
const tools = resolve(TOOLS);
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(join(tools, 'browsers'))) process.env.PLAYWRIGHT_BROWSERS_PATH = join(tools, 'browsers');
const { chromium } = createRequire(join(tools, 'demo-record.cjs'))('playwright');
const viewer = join(dirname(fileURLToPath(import.meta.url)), '..', 'pairwatch', 'viewer', 'index.html');

const snaps = JSON.parse(readFileSync(snapsFile, 'utf8'));
const plan = [];
let total = 0;
for (let i = 0; i < snaps.length; i++) {
  const gap = i + 1 < snaps.length ? snaps[i + 1].t - snaps[i].t : 0;
  const d = i + 1 < snaps.length ? Math.min(1700, Math.max(500, gap)) : 3500;
  plan.push({ start: total, snap: snaps[i].snap });
  total += d;
}

const browser = await chromium.launch(process.env.PAIRWATCH_CHROMIUM ? { executablePath: process.env.PAIRWATCH_CHROMIUM } : {});
// The page's tallest state sets the height, so the fixed bar sits just under the content.
const page = await browser.newPage({ viewport: { width: WIDTH, height: 1400 }, colorScheme: 'dark' });
await page.addInitScript(() => {
  window.__listeners = {};
  window.EventSource = class {
    static CLOSED = 2;
    constructor() {
      this.readyState = 1;
      setTimeout(() => this.onopen && this.onopen(), 0);
    }
    addEventListener(type, fn) {
      window.__listeners[type] = fn;
    }
    close() {}
  };
  window.fetch = async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  window.__push = snap => window.__listeners.snapshot({ data: JSON.stringify({ ...snap, at: Date.now() }) });
});
await page.goto(pathToFileURL(viewer).href + '?key=demo');
await page.waitForFunction(() => typeof window.__listeners.snapshot === 'function');
let tallest = 0;
for (const { snap } of plan) tallest = Math.max(tallest, await page.evaluate(s => (window.__push(s), Math.ceil(document.querySelector('.wrap').getBoundingClientRect().bottom)), snap));
const bar = await page.evaluate(() => Math.ceil(document.querySelector('.bar').getBoundingClientRect().height));
await page.setViewportSize({ width: WIDTH, height: tallest + 16 + bar });

mkdirSync(outDir, { recursive: true });
const frames = Math.ceil((total / 1000) * FPS);
let shown = -1;
let insertedAt = 0;
let lastSvg = null;
for (let f = 0; f < frames; f++) {
  const t = (f * 1000) / FPS;
  let k = 0;
  while (k + 1 < plan.length && plan[k + 1].start <= t) k++;
  if (k !== shown) {
    await page.evaluate(s => window.__push(s), plan[k].snap);
    if (plan[k].snap.svg !== lastSvg) insertedAt = t; // a new stage document: its animations start over
    lastSvg = plan[k].snap.svg;
    shown = k;
  }
  await page.evaluate(([local, now]) => {
    const svg = document.querySelector('#stage svg');
    if (svg && svg.pauseAnimations) {
      svg.pauseAnimations();
      svg.setCurrentTime(local / 1000);
    }
    const stage = document.getElementById('stage');
    for (const a of document.getAnimations()) {
      a.pause();
      a.currentTime = a.effect && a.effect.target && stage.contains(a.effect.target) ? local : now;
    }
  }, [Math.max(0, t - insertedAt), t]);
  await page.screenshot({ path: join(outDir, `f${String(f).padStart(4, '0')}.png`) });
}
await browser.close();
console.log(`demo-record: ${frames} frames (${(total / 1000).toFixed(1)} s at ${FPS} fps) -> ${outDir}`);
