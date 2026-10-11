// Visual gallery for Pairwatch's stage.
//   node dev/gallery.ts [--out DIR] [--width 640] [--light] [--no-png] [--only stations|run|extra|turn]
// Renders every station x {running+fresh, ok, error} with realistic sample data, the run categories,
// the paused state, a long-input stress case and a realistic turn folded by the real timeline (the
// frames the pane would draw, through view.ts) to SVG files, then draws PNG filmstrips (times 0.2,
// 0.8 and 2.0 s; one row per SVG) through dev/filmstrip.mjs. Default DIR: a new private temp folder.
// --width N draws the filmstrips with the stage scaled to N px wide (e.g. 400 for a narrow pane).
// Env: PAIRWATCH_TOOLS, a folder with Playwright installed, for the PNGs (see dev/filmstrip.mjs);
// --no-png writes the SVGs only and needs no Playwright.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderStage, type StageInput } from '../pairwatch/hooks/core/stage.ts'
import { currentActivity, emptyModel, reduce, settleHop } from '../pairwatch/hooks/core/timeline.ts'
import { freshKey, stageInput } from '../pairwatch/hooks/core/view.ts'
import type { RawEvent, SceneData, SessionModel, Station, StepStatus } from '../pairwatch/types'
import { CWD, SCENARIO, T0 } from './spec/scenario.fixtures.ts'

const argv = process.argv.slice(2)
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const OUT_ARG = opt('--out')
const WIDTH = Number(opt('--width') ?? 640)
const ONLY = opt('--only')
const LIGHT = argv.includes('--light')
const PNG = !argv.includes('--no-png')
const HERE = dirname(fileURLToPath(import.meta.url))
const TOOLS = process.env.PAIRWATCH_TOOLS
if (PNG && !TOOLS) {
  console.error(`gallery: PAIRWATCH_TOOLS is not set. The PNG filmstrips need Playwright with Chromium. Install them once, in a folder of your choice:
  mkdir -p ~/pw-tools && cd ~/pw-tools && npm init -y && npm install playwright
  PLAYWRIGHT_BROWSERS_PATH="$PWD/browsers" npx playwright install chromium
(on Linux, add --with-deps to that line if Chromium lacks system libraries), then point PAIRWATCH_TOOLS at it:
  export PAIRWATCH_TOOLS=~/pw-tools
Or pass --no-png to write the SVGs only.`)
  process.exit(2)
}

// ------------------------------------------------------------------ sample data

const TRAIL_STATIONS: Station[] = ['think', 'plan', 'search', 'read', 'read', 'search', 'read', 'edit', 'run', 'think', 'read', 'edit', 'edit', 'run', 'web', 'read', 'delegate', 'think', 'edit', 'run', 'tools', 'read', 'search']
const trail = (n: number, last: Station): StageInput['trail'] =>
  Array.from({ length: n }, (_, i) => ({
    station: i === n - 1 ? last : (TRAIL_STATIONS[i % TRAIL_STATIONS.length] ?? 'read'),
    status: (i === 8 || i === 13 ? 'error' : 'ok') as StepStatus,
  }))
const stats = { steps: 23, files: 7, edits: 3, elapsed: '4m 12s' }

type Sample = { station: Station; hopFrom?: Station; title: string; scene: SceneData; errScene?: SceneData; lane?: string }

const SAMPLES: Sample[] = [
  { station: 'think', hopFrom: 'read', title: 'about the failing login redirect', scene: { kind: 'think', text: 'The redirect probably drops the next= parameter. Check the login view before touching the tests.' } },
  {
    station: 'plan',
    hopFrom: 'think',
    title: 'Fix the login redirect (4 tasks)',
    scene: {
      kind: 'plan',
      items: [
        { text: 'Reproduce the failing test', state: 'done' },
        { text: 'Find where the redirect URL is built', state: 'doing' },
        { text: 'Keep the next= parameter', state: 'todo' },
        { text: 'Run the auth tests again', state: 'todo' },
      ],
    },
  },
  {
    station: 'search',
    hopFrom: 'plan',
    title: '“handleLogin” in src/',
    scene: { kind: 'search', query: 'handleLogin', where: 'src/', matches: '12 matches in 4 files' },
    errScene: { kind: 'search', query: 'handleLogin', where: 'src/', matches: 'no matches' },
  },
  { station: 'read', hopFrom: 'search', title: 'src/auth/login.py', scene: { kind: 'read', files: [{ path: 'src/auth/login.py', detail: 'lines 120–180' }] } },
  {
    station: 'edit',
    hopFrom: 'read',
    title: 'src/auth/login.py',
    scene: {
      kind: 'edit',
      path: 'src/auth/login.py',
      removed: 1,
      added: 3,
      minus: ['    return redirect(url_for("home"))'],
      plus: ['    next_url = request.args.get("next")', '    if next_url and is_safe_url(next_url):', '        return redirect(next_url)'],
      isNew: false,
    },
  },
  {
    station: 'run',
    hopFrom: 'edit',
    title: 'pytest tests/test_auth.py -q',
    scene: { kind: 'run', command: 'pytest tests/test_auth.py -q', category: 'test', program: 'pytest', output: '.....\n5 passed in 0.42s' },
    errScene: { kind: 'run', command: 'pytest tests/test_auth.py -q', category: 'test', program: 'pytest', output: 'FAILED tests/test_auth.py::test_redirect - AssertionError: assert 302 == 200\n1 failed, 4 passed in 0.51s' },
  },
  { station: 'web', hopFrom: 'run', title: 'docs.python.org/3/library/urllib.parse.html', scene: { kind: 'web', url: 'https://docs.python.org/3/library/urllib.parse.html', domain: 'docs.python.org' } },
  {
    station: 'delegate',
    hopFrom: 'web',
    title: 'Explore the auth module (3 agents)',
    scene: {
      kind: 'delegate',
      agents: [
        { label: 'Explore the auth module', type: 'Explore', status: 'running', doing: 'Reading src/auth/session.py' },
        { label: 'Check the test fixtures', type: 'general-purpose', status: 'ok', doing: 'Found 3 fixtures in conftest.py' },
        { label: 'Survey redirect helpers', type: 'Explore', status: 'running', doing: 'Searching for “redirect(” in src/' },
      ],
    },
  },
  { station: 'tools', hopFrom: 'delegate', title: 'github · search_issues', scene: { kind: 'tools', name: 'search_issues', server: 'github', detail: 'repo acme/web · “login redirect”' } },
  { station: 'ask', hopFrom: 'run', title: 'Allow “rm -rf build/”?', scene: { kind: 'ask', question: 'Allow Claude to run “rm -rf build/”?', isPermission: true } },
  { station: 'talk', hopFrom: 'run', title: 'Fixed the login redirect', scene: { kind: 'talk', text: 'Fixed it: login now keeps the next= parameter, and all 5 auth tests pass.' } },
  { station: 'done', hopFrom: 'talk', title: 'Turn finished in 4m 12s', scene: { kind: 'done', steps: 23, files: 7, seconds: 252, errors: 1 } },
  { station: 'idle', title: '', scene: { kind: 'idle' } },
]

const RUNS: { name: string; status: StepStatus; scene: Extract<SceneData, { kind: 'run' }> }[] = [
  { name: 'install', status: 'running', scene: { kind: 'run', command: 'pip install requests flask', category: 'install', program: 'pip' } },
  { name: 'install-ok', status: 'ok', scene: { kind: 'run', command: 'pip install requests flask', category: 'install', program: 'pip', output: 'Successfully installed flask-3.0.3 requests-2.32.3' } },
  { name: 'git', status: 'running', scene: { kind: 'run', command: 'git commit -m "Keep next= on login redirect"', category: 'git', program: 'git' } },
  { name: 'git-ok', status: 'ok', scene: { kind: 'run', command: 'git status --short', category: 'git', program: 'git', output: ' M src/auth/login.py\n M tests/test_auth.py' } },
  { name: 'gpu', status: 'running', scene: { kind: 'run', command: 'nvidia-smi --query-gpu=memory.used,memory.total --format=csv', category: 'gpu', program: 'nvidia-smi' } },
  { name: 'gpu-ok', status: 'ok', scene: { kind: 'run', command: 'nvidia-smi', category: 'gpu', program: 'nvidia-smi', output: '|  0  NVIDIA A100-SXM4-40GB   On | 10240MiB / 40960MiB |  25%  Default |' } },
  { name: 'docker', status: 'running', scene: { kind: 'run', command: 'docker compose up -d db', category: 'docker', program: 'docker' } },
  { name: 'docker-err', status: 'error', scene: { kind: 'run', command: 'docker compose up -d db', category: 'docker', program: 'docker', output: 'Error response from daemon: port 5432 is already allocated\nExit code 1' } },
  { name: 'database', status: 'running', scene: { kind: 'run', command: 'sqlite3 app.db "SELECT id, email FROM users LIMIT 5"', category: 'database', program: 'sqlite3' } },
  { name: 'database-ok', status: 'ok', scene: { kind: 'run', command: 'sqlite3 app.db "SELECT count(*) FROM users"', category: 'database', program: 'sqlite3', output: '42' } },
  { name: 'http', status: 'running', scene: { kind: 'run', command: 'curl -s -X POST https://api.example.com/v1/login -d @body.json', category: 'http', program: 'curl' } },
  { name: 'http-err', status: 'error', scene: { kind: 'run', command: 'curl -si https://api.example.com/v1/users/7', category: 'http', program: 'curl', output: 'HTTP/2 404\ncontent-type: application/json\n\n{"error":"not found"}' } },
  { name: 'wait', status: 'running', scene: { kind: 'run', command: 'sleep 30 && curl -s localhost:8000/health', category: 'wait', program: 'sleep' } },
  { name: 'wait-ok', status: 'ok', scene: { kind: 'run', command: 'sleep 30', category: 'wait', program: 'sleep' } },
  { name: 'background', status: 'running', scene: { kind: 'run', command: 'python3 train.py --epochs 20 > train.log 2>&1', category: 'run-script', program: 'python3', isBackground: true } },
  { name: 'background-ok', status: 'ok', scene: { kind: 'run', command: 'nohup python3 serve.py --port 8000 &', category: 'process', program: 'python3', isBackground: true } },
  { name: 'build', status: 'running', scene: { kind: 'run', command: 'npm run build', category: 'build', program: 'npm' } },
  { name: 'build-err', status: 'error', scene: { kind: 'run', command: 'npx tsc --noEmit', category: 'build', program: 'tsc', output: "src/app.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\nExit code 2" } },
  { name: 'media', status: 'running', scene: { kind: 'run', command: 'ffmpeg -i talk.wav -ar 16000 -ac 1 talk16k.wav', category: 'media', program: 'ffmpeg' } },
  {
    name: 'multiline',
    status: 'ok',
    scene: { kind: 'run', command: "python3 - <<'EOF'\nimport json\ndata = json.load(open('config.json'))\nprint(sorted(data))\nEOF", category: 'run-script', program: 'python3', output: "['debug', 'port', 'secret_key']" },
  },
  { name: 'denied', status: 'denied', scene: { kind: 'run', command: 'rm -rf build/ dist/', category: 'file-ops', program: 'rm' } },
]

const huge = (n: number, s: string) => s.repeat(Math.ceil(n / s.length)).slice(0, n)
const EVIL = 'a<b>&c"d\'e\u0000\u0007\u001b[31m\u2028tab\there\r\nnew'

// ------------------------------------------------------------------ render

type Job = { name: string; input: StageInput }
const jobs: { group: string; items: Job[] }[] = []
/** A copy of the document drawn at another width (the pane scales the stage to its slot). */
const scaled = (svg: string, w: number): string =>
  w === 640 ? svg : svg.replace('width="640" height="246"', `width="${w}" height="${Math.round((w * 246) / 640)}"`)
const base = (s: Sample, status: StepStatus, fresh: boolean, extra: Partial<StageInput> = {}): StageInput => ({
  station: s.station,
  hopFrom: fresh ? s.hopFrom : undefined,
  status,
  title: s.title,
  scene: status === 'error' && s.errScene ? s.errScene : s.scene,
  trail: trail(23, s.station),
  stats,
  isFresh: fresh,
  isPaused: false,
  lane: s.lane,
  ...extra,
})

if (!ONLY || ONLY === 'stations') {
  for (let i = 0; i < SAMPLES.length; i += 2) {
    const pair = SAMPLES.slice(i, i + 2)
    jobs.push({
      group: 'stations-' + pair.map(p => p.station).join('-'),
      items: pair.flatMap(s => [
        { name: `${s.station}-running`, input: base(s, 'running', true) },
        { name: `${s.station}-ok`, input: base(s, 'ok', false) },
        { name: `${s.station}-error`, input: base(s, 'error', false) },
      ]),
    })
  }
}
if (!ONLY || ONLY === 'run') {
  for (let i = 0; i < RUNS.length; i += 6) {
    jobs.push({
      group: `run-categories-${i / 6 + 1}`,
      items: RUNS.slice(i, i + 6).map(r => ({
        name: `run-${r.name}`,
        input: { ...base(SAMPLES[5] as Sample, r.status, r.status === 'running', { title: r.scene.command.split('\n')[0] ?? '' }), scene: r.scene },
      })),
    })
  }
}
if (!ONLY || ONLY === 'extra') {
  const read = SAMPLES[3] as Sample
  const run = SAMPLES[5] as Sample
  const del = SAMPLES[7] as Sample
  const web = SAMPLES[6] as Sample
  const edit = SAMPLES[4] as Sample
  jobs.push({
    group: 'extra-variants',
    items: [
      {
        name: 'read-multi',
        input: base(read, 'running', true, {
          title: '4 files',
          scene: { kind: 'read', files: [{ path: 'src/auth/login.py', detail: '214 lines' }, { path: 'src/auth/session.py', detail: '88 lines' }, { path: 'tests/test_auth.py' }, { path: 'src/auth/templates/login.html', detail: 'lines 1–40' }] },
        }),
      },
      {
        name: 'read-many',
        input: base(read, 'ok', false, { title: '9 files', scene: { kind: 'read', files: Array.from({ length: 9 }, (_, i) => ({ path: `src/components/forms/field_${i}.tsx`, detail: `${40 + i * 7} lines` })) } }),
      },
      { name: 'web-search', input: base(web, 'running', true, { title: '“flask safe redirect next parameter”', scene: { kind: 'web', query: 'flask safe redirect next parameter' } }) },
      {
        name: 'edit-newfile',
        input: base(edit, 'running', true, {
          title: 'tests/test_redirect.py',
          scene: { kind: 'edit', path: 'tests/test_redirect.py', removed: 0, added: 24, minus: [], plus: ['import pytest', 'from app import create_app', '', 'def test_keeps_next(client):', '    r = client.post("/login?next=/a")', '    assert r.headers["Location"] == "/a"'], isNew: true },
        }),
      },
      {
        name: 'delegate-many',
        input: base(del, 'ok', false, {
          title: '6 agents',
          scene: { kind: 'delegate', agents: Array.from({ length: 6 }, (_, i) => ({ label: `Audit package ${i + 1}`, type: 'Explore', status: (i % 3 === 2 ? 'error' : 'ok') as StepStatus, doing: `Checked ${10 + i} files` })) },
        }),
      },
      { name: 'run-lane', input: base(run, 'running', true, { lane: 'sub-agent: Explore', hopFrom: 'search' }) },
      {
        name: 'run-wide',
        input: base(run, 'ok', true, {
          title: 'echo "✅ 完了しました" && ls 資料/',
          scene: { kind: 'run', command: 'echo "✅ 完了しました（ビルドとテスト）🚀" && ls 資料/ドキュメント/ && cat 設定.json', category: 'other', program: 'echo', output: '✅ 完了しました（ビルドとテスト）🚀\n議事録.md  設計書.pdf' },
        }),
      },
    ],
  })
  jobs.push({
    group: 'extra-paused-stress',
    items: [
      { name: 'paused-run', input: base(run, 'running', true, { isPaused: true, lane: 'sub-agent: Explore' }) },
      { name: 'paused-delegate', input: base(del, 'running', true, { isPaused: true }) },
      {
        name: 'stress-run',
        input: {
          ...base(run, 'error', false),
          title: huge(5000, 'pytest -k "' + EVIL + '" '),
          lane: huge(400, 'sub-agent: ' + EVIL),
          scene: { kind: 'run', command: huge(200000, 'echo ' + EVIL + ' && ') + '\n' + huge(5000, 'x\n'), category: 'test', program: huge(500, 'py'), output: huge(100000, EVIL + ' 3 failed, 9 passed\n'), isBackground: true },
          trail: Array.from({ length: 5000 }, (_, i) => ({ station: (['run', 'read', 'edit'] as Station[])[i % 3] ?? 'run', status: (i % 7 ? 'ok' : 'error') as StepStatus })),
          stats: { steps: 123456789, files: 98765, edits: 4321, elapsed: huge(80, '99h ') },
        },
      },
      {
        name: 'stress-read',
        input: base(read, 'running', true, { title: huge(3000, EVIL), scene: { kind: 'read', files: Array.from({ length: 3000 }, (_, i) => ({ path: huge(900, `/very/deep/${EVIL}/path${i}/`), detail: huge(300, EVIL) })) } }),
      },
      {
        name: 'stress-edit',
        input: base(edit, 'ok', true, {
          title: huge(2000, EVIL),
          scene: { kind: 'edit', path: huge(4000, EVIL + '/'), removed: 1e9, added: 1e12, minus: Array.from({ length: 5000 }, () => huge(3000, '\t' + EVIL)), plus: Array.from({ length: 5000 }, () => huge(3000, '  ' + EVIL)), isNew: true },
        }),
      },
      {
        name: 'stress-delegate',
        input: base(del, 'running', true, {
          title: huge(2000, EVIL),
          scene: { kind: 'delegate', agents: Array.from({ length: 2000 }, () => ({ label: huge(2000, EVIL), type: huge(500, EVIL), status: 'running' as StepStatus, doing: huge(2000, EVIL) })) },
        }),
      },
    ],
  })
}

// A realistic turn (dev/spec/scenario.fixtures.ts) folded the way the pump does, one frame per new
// activity on stage, drawn exactly as the pane draws it: view.ts's stageInput, intros once per step.
if (!ONLY || ONLY === 'turn') {
  const at = (e: RawEvent): number => (e.kind === 'tool-start' ? e.obs.at : e.kind === 'tool-end' ? e.end.at : e.at)
  const queue = [...SCENARIO].sort((a, b) => at(a) - at(b))
  let model: SessionModel = emptyModel(T0)
  let shown = ''
  let drawnKey = ''
  const frames: Job[] = []
  const prefs = { level: 1 as const, isPaused: false, useModel: false, autoOpen: true }
  const end = at(queue[queue.length - 1]!) + 3_000
  for (let now = T0; now <= end; now += 400) {
    const batch: RawEvent[] = []
    while (queue.length > 0 && at(queue[0]!) <= now) batch.push(queue.shift()!)
    model = settleHop(reduce(model, batch, { level: 1, now, cwd: CWD }), now)
    const act = currentActivity(model)
    const key = act === undefined ? '' : `${act.id}|${act.status}|${act.stepIds.length}`
    if (act === undefined || key === shown) continue
    shown = key
    const input = stageInput(model, prefs, now, CWD)
    const fresh = freshKey(model)
    frames.push({ name: `turn-${String(frames.length + 1).padStart(2, '0')}-${act.station}-${act.status}`, input: fresh === drawnKey ? { ...input, isFresh: false } : input })
    drawnKey = fresh
  }
  for (let i = 0; i < frames.length; i += 6) jobs.push({ group: `turn-${i / 6 + 1}`, items: frames.slice(i, i + 6) })
}

// Under --out as asked, else a new private (0700) temp folder.
const OUT = OUT_ARG ?? mkdtempSync(join(tmpdir(), 'pairwatch-gallery-'))
mkdirSync(OUT, { recursive: true })
let worst = 0
let totalMs = 0
let renders = 0
const pngs: string[] = []
for (const job of jobs) {
  const files: string[] = []
  for (const item of job.items) {
    const t0 = performance.now()
    const svg = renderStage(item.input)
    const ms = performance.now() - t0
    totalMs += ms
    renders++
    worst = Math.max(worst, svg.length)
    const file = join(OUT, `${item.name}.svg`)
    writeFileSync(file, svg)
    if (WIDTH === 640) files.push(file)
    else {
      const copy = join(OUT, `${item.name}.w${WIDTH}.svg`)
      writeFileSync(copy, scaled(svg, WIDTH))
      files.push(copy)
    }
    console.log(`${item.name.padEnd(22)} ${String(svg.length).padStart(6)} chars ${ms.toFixed(2).padStart(6)} ms`)
  }
  if (PNG) {
    const png = join(OUT, `${job.group}${LIGHT ? '-light' : ''}${WIDTH !== 640 ? '-w' + WIDTH : ''}.png`)
    // +16: the frame's body margin, so the card's right edge is not cut off
    try {
      execFileSync(process.execPath, [join(HERE, 'filmstrip.mjs'), png, '--times', '0.2,0.8,2', '--width', String(WIDTH + 16), ...(LIGHT ? ['--light'] : []), ...files], {
        stdio: ['ignore', 'ignore', 'inherit'],
      })
    } catch {
      console.error(`gallery: the filmstrip for ${job.group} failed (above); the SVGs are in ${OUT}`)
      process.exit(1)
    }
    pngs.push(png)
  }
}
console.log(`\n${renders} stages, largest ${worst} chars, mean ${(totalMs / renders).toFixed(2)} ms per render`)
for (const p of pngs) console.log('png', p)
console.log('out', OUT)
