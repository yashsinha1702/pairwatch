// Spec for pairwatch/hooks/core/explain.ts: tool calls -> explained Steps.
// Run: node --test dev/spec/explain.spec.ts
//
// Bash steps are checked only at the contract level (the description is the headline, the scene kind
// matches the station, concepts are registry ids): bash.ts owns the shell analysis and its wording.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SceneData, Station, Step, ToolEnd, ToolObs } from '../../pairwatch/types'
import type { BashAnalysis } from '../../pairwatch/hooks/core/bash.ts'
import { analyzeBash, bashResultNote } from '../../pairwatch/hooks/core/bash.ts'
import { isConceptId } from '../../pairwatch/hooks/core/concept-ids.ts'
import type { ExplainCtx } from '../../pairwatch/hooks/core/explain.ts'
import { applyEnd, bashStationOf, displayPath, explainTool, fileConcepts, sceneForBash } from '../../pairwatch/hooks/core/explain.ts'

// ------------------------------------------------------------------ helpers

const CWD = '/home/ana/shop'
const CTX: ExplainCtx = { level: 1, cwd: CWD }
let seq = 0
const mkObs = (tool: string, args: unknown, extra: Partial<ToolObs> = {}): ToolObs =>
  ({ id: `toolu_${String(++seq).padStart(4, '0')}`, tool, args, at: 1_000, ...extra }) as ToolObs

const SCENE_OF: Record<Station, SceneData['kind']> = {
  think: 'think', plan: 'plan', search: 'search', read: 'read', edit: 'edit', run: 'run', web: 'web',
  delegate: 'delegate', tools: 'tools', ask: 'ask', talk: 'talk', done: 'done', idle: 'idle',
}
const CONTROL = /[\u0000-\u001f\u007f]/

/** Every contract-level invariant of a Step; returns the step for chaining. */
function check(step: Step): Step {
  assert.equal(typeof step.id, 'string')
  assert.equal(typeof step.tool, 'string')
  assert.ok(step.headline.length > 0 && step.headline.length <= 90, `headline (${step.headline.length}): ${step.headline}`)
  assert.ok(!CONTROL.test(step.headline), `control chars in headline: ${JSON.stringify(step.headline)}`)
  assert.ok(step.why.length > 0 && step.why.length <= 170, `why (${step.why.length}): ${step.why}`)
  assert.ok(!CONTROL.test(step.why))
  if (step.detail !== undefined) {
    assert.ok(step.detail.length > 0 && step.detail.length <= 40, `detail: ${step.detail}`)
    assert.ok(!CONTROL.test(step.detail))
  }
  if (step.resultNote !== undefined) {
    assert.ok(step.resultNote.length > 0 && step.resultNote.length <= 120, `resultNote: ${step.resultNote}`)
    assert.ok(!CONTROL.test(step.resultNote))
  }
  assert.ok(step.concepts.length > 0, 'at least one concept')
  for (const c of step.concepts) assert.ok(isConceptId(c), `not a registry id: ${c}`)
  assert.equal(new Set(step.concepts).size, step.concepts.length, 'no duplicate concepts')
  assert.equal(step.scene.kind, SCENE_OF[step.station], `scene ${step.scene.kind} at station ${step.station}`)
  assert.ok((['running', 'ok', 'error', 'denied'] as const).includes(step.status))
  assert.ok(Number.isFinite(step.startedAt))
  assert.deepEqual(JSON.parse(JSON.stringify(step)), step, 'plain JSON: no undefined, NaN or functions')
  return step
}

const explain = (tool: string, args: unknown, ctx: ExplainCtx = CTX, extra: Partial<ToolObs> = {}): Step =>
  check(explainTool(mkObs(tool, args, extra), ctx))

const finish = (step: Step, status: ToolEnd['status'], preview: string, ctx: ExplainCtx = CTX): Step =>
  check(applyEnd(step, { id: step.id, status, preview, at: 2_000 }, ctx))

/** The scene narrowed to its kind (fails the test otherwise). */
function sceneOf<K extends SceneData['kind']>(step: Step | SceneData, kind: K): Extract<SceneData, { kind: K }> {
  const scene = 'scene' in step ? step.scene : step
  assert.equal(scene.kind, kind)
  return scene as Extract<SceneData, { kind: K }>
}

const analysis = (over: Partial<BashAnalysis>): BashAnalysis => ({
  station: 'run', category: 'other', programs: [], headline: 'Running a command', concepts: [], isBackground: false,
  isMultiline: false, segments: 1, readsFiles: [], writesFiles: [], why: 'Because.', ...over,
})

const lines = (n: number, prefix = 'line'): string => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n')

// ------------------------------------------------------------------ displayPath

test('displayPath: relative to cwd when under it', () => {
  assert.equal(displayPath('/home/ana/shop/src/login.py', CWD), 'src/login.py')
  assert.equal(displayPath('/home/ana/shop/src/login.py', CWD + '/'), 'src/login.py')
  assert.equal(displayPath(CWD, CWD), '.')
  assert.equal(displayPath('/home/ana/shopping/x.py', CWD), '~/shopping/x.py', 'a sibling with the same prefix is not under cwd')
})

test('displayPath: ~ for home folders, outside cwd', () => {
  assert.equal(displayPath('/home/ana/notes/todo.md', CWD), '~/notes/todo.md')
  assert.equal(displayPath('/home/ana'), '~')
  assert.equal(displayPath('/Users/bob/dev/app.ts'), '~/dev/app.ts')
  assert.equal(displayPath('/root/.bashrc'), '~/.bashrc')
  assert.equal(displayPath('/etc/hosts', CWD), '/etc/hosts')
})

test('displayPath: long paths keep their tail behind an ellipsis, deterministically', () => {
  const p = '/srv/data/projects/very-long-project-name/packages/core/src/auth/handlers/login.py'
  const a = displayPath(p)
  assert.ok(a.length <= 48, a)
  assert.ok(a.startsWith('…/'), a)
  assert.ok(a.endsWith('/handlers/login.py'), a)
  assert.equal(displayPath(p), a, 'same input, same output')
  const b = displayPath(p, undefined, 24)
  assert.ok(b.length <= 24 && b.endsWith('login.py'), b)
  const huge = displayPath('/x/' + 'a'.repeat(300) + '.txt', undefined, 20)
  assert.equal(huge.length, 20)
  assert.ok(huge.startsWith('…') && huge.endsWith('.txt'))
  assert.ok(displayPath(p, undefined, 3).length <= 3)
})

test('displayPath: odd input', () => {
  assert.equal(displayPath(42 as unknown as string), '')
  assert.equal(displayPath(undefined as unknown as string), '')
  assert.equal(displayPath(''), '')
  assert.equal(displayPath('./src//a.ts'), 'src/a.ts')
  assert.equal(displayPath('/a/./b/'), '/a/b')
  assert.equal(displayPath('C:\\Users\\ana\\proj\\a.ts'), '~/proj/a.ts')
  assert.equal(displayPath('src/a.ts', 7 as unknown as string), 'src/a.ts')
  assert.equal(displayPath('/x/y.py', '/', Number.NaN), '/x/y.py')
})

// ------------------------------------------------------------------ fileConcepts

test('fileConcepts: data and doc formats', () => {
  assert.deepEqual(fileConcepts('a/b/data.json'), ['json'])
  assert.deepEqual(fileConcepts('rows.jsonl'), ['jsonl'])
  assert.deepEqual(fileConcepts('ci.yaml'), ['yaml'])
  assert.deepEqual(fileConcepts('ci.yml'), ['yaml'])
  assert.deepEqual(fileConcepts('Cargo.toml'), ['toml'])
  assert.deepEqual(fileConcepts('sales.csv'), ['csv'])
  assert.deepEqual(fileConcepts('README.md'), ['markdown'])
})

test('fileConcepts: project files by name', () => {
  assert.deepEqual(fileConcepts('/x/package.json'), ['package-json', 'json'])
  assert.deepEqual(fileConcepts('Dockerfile'), ['dockerfile'])
  assert.ok(fileConcepts('docker-compose.prod.yml').includes('docker-compose'))
  assert.ok(fileConcepts('compose.yaml').includes('docker-compose'))
  assert.deepEqual(fileConcepts('/repo/.gitignore'), ['gitignore'])
  assert.ok(fileConcepts('requirements-dev.txt').includes('pip'))
  assert.deepEqual(fileConcepts('pyproject.toml'), ['pip', 'toml'])
})

test('fileConcepts: .env files teach secrets hygiene', () => {
  for (const p of ['.env', '/app/.env.local', 'services/api.env', '.envrc']) {
    const cs = fileConcepts(p)
    assert.ok(cs.includes('secrets-hygiene') && cs.includes('config-files'), `${p}: ${cs}`)
  }
  assert.ok(!fileConcepts('environment.py').includes('secrets-hygiene'))
})

test('fileConcepts: logs and tests', () => {
  assert.ok(fileConcepts('server.log').includes('reading-logs'))
  assert.ok(fileConcepts('/var/app/logs/out.txt').includes('reading-logs'))
  for (const p of ['tests/test_auth.py', 'test_auth.py', 'auth_test.py', 'src/login.test.ts', 'login.spec.ts', '/repo/tests/helpers.py', 'conftest.py']) {
    assert.ok(fileConcepts(p).includes('tests'), p)
  }
  assert.ok(!fileConcepts('src/latest/contest.py').includes('tests'))
})

test('fileConcepts: languages, scripts, queries', () => {
  assert.deepEqual(fileConcepts('src/app.ts'), ['typescript'])
  assert.deepEqual(fileConcepts('ui/Button.tsx'), ['typescript'])
  assert.deepEqual(fileConcepts('deploy.sh'), ['shell-basics'])
  assert.deepEqual(fileConcepts('schema.sql'), ['sql-queries'])
  assert.deepEqual(fileConcepts('main.py'), [])
})

test('fileConcepts: model weights and audio', () => {
  for (const p of ['out/model.safetensors', 'ckpt/step_1000.pt', 'lora.pth', 'last.ckpt', 'hf/pytorch_model.bin']) {
    assert.ok(fileConcepts(p).includes('model-checkpoints'), p)
  }
  assert.ok(!fileConcepts('firmware/data.bin').includes('model-checkpoints'))
  for (const p of ['a.wav', 'b.flac', 'c.mp3']) assert.deepEqual(fileConcepts(p), ['audio-basics'])
})

test('fileConcepts: agent files (skills, memory, scratchpad)', () => {
  assert.deepEqual(fileConcepts('.claude/skills/review/SKILL.md'), ['skills', 'markdown'])
  assert.ok(fileConcepts('/repo/CLAUDE.md').includes('agent-memory'))
  assert.ok(fileConcepts('/home/ana/.claude/projects/x/memory/MEMORY.md').includes('agent-memory'))
  assert.ok(fileConcepts('/home/ana/.claude/projects/x/memory/gpu-notes.md').includes('agent-memory'))
  assert.ok(!fileConcepts('/srv/kernel/src/memory/alloc.c').includes('agent-memory'), 'a source folder named memory/')
  assert.ok(fileConcepts('/tmp/claude-1000/p/s/scratchpad/fix.py').includes('scratchpad'))
})

test('fileConcepts: registry ids only, odd input', () => {
  const all = ['a.json', '.env', 'x.log', 'tests/a.py', 'model.pt', 'SKILL.md', '/scratchpad/a.sh', 'Dockerfile', 'z.unknownext']
  for (const p of all) for (const c of fileConcepts(p)) assert.ok(isConceptId(c), c)
  assert.deepEqual(fileConcepts('notes.unknownext'), [])
  assert.deepEqual(fileConcepts(null as unknown as string), [])
  assert.deepEqual(fileConcepts(''), [])
})

// ------------------------------------------------------------------ Read

test('Read: whole file', () => {
  const s = explain('Read', { file_path: '/home/ana/shop/src/login.py' })
  assert.equal(s.station, 'read')
  assert.equal(s.headline, 'Reading login.py')
  assert.equal(s.target, '/home/ana/shop/src/login.py')
  assert.equal(s.status, 'running')
  assert.equal(s.startedAt, 1_000)
  assert.deepEqual(sceneOf(s, 'read').files, [{ path: 'src/login.py' }])
  assert.ok(s.concepts.includes('reading-code'))
})

test('Read: a line range', () => {
  const s = explain('Read', { file_path: '/home/ana/shop/src/login.py', offset: 100, limit: 81 })
  assert.equal(s.headline, 'Reading lines 100–180 of login.py')
  assert.equal(s.detail, 'lines 100–180')
  assert.deepEqual(sceneOf(s, 'read').files, [{ path: 'src/login.py', detail: 'lines 100–180' }])
  const from = explain('Read', { file_path: 'src/login.py', offset: 50 })
  assert.equal(from.headline, 'Reading login.py from line 50')
  const first = explain('Read', { file_path: 'src/login.py', limit: 40 })
  assert.equal(first.headline, 'Reading lines 1–40 of login.py')
})

test('Read: images and PDFs', () => {
  assert.equal(explain('Read', { file_path: '/x/chart.png' }).headline, 'Looking at the image chart.png')
  const pdf = explain('Read', { file_path: '/x/paper.pdf', pages: '1-5' })
  assert.equal(pdf.headline, 'Reading pages 1–5 of paper.pdf')
  assert.equal(pdf.detail, 'pages 1–5')
  assert.equal(explain('Read', { file_path: '/x/paper.pdf', pages: '3' }).headline, 'Reading page 3 of paper.pdf')
  assert.equal(explain('Read', { file_path: '/x/paper.pdf' }).headline, 'Reading paper.pdf')
})

test('Read: generic names get their folder, file concepts join reading-code', () => {
  const s = explain('Read', { file_path: '/repo/.claude/skills/code-review/SKILL.md' })
  assert.equal(s.headline, 'Reading code-review/SKILL.md')
  assert.ok(s.concepts.includes('skills') && s.concepts.includes('markdown') && s.concepts.includes('reading-code'))
  const env = explain('Read', { file_path: '/home/ana/shop/.env' })
  assert.ok(env.concepts.includes('secrets-hygiene'))
  assert.equal(explain('Read', { file_path: '/home/ana/shop/config.yaml' }).concepts.includes('yaml'), true)
})

// ------------------------------------------------------------------ Edit

test('Edit: line counts, headline, detail, scene', () => {
  const s = explain('Edit', { file_path: '/home/ana/shop/src/login.py', old_string: 'a\nb\nc', new_string: 'x\ny\nz\nw\nv' })
  assert.equal(s.station, 'edit')
  assert.equal(s.headline, 'Editing login.py: 3 lines → 5 lines')
  assert.equal(s.detail, '+5 −3')
  const e = sceneOf(s, 'edit')
  assert.equal(e.path, 'src/login.py')
  assert.equal(e.removed, 3)
  assert.equal(e.added, 5)
  assert.equal(e.isNew, false)
  assert.deepEqual(e.minus, ['a', 'b', 'c'])
  assert.deepEqual(e.plus, ['x', 'y', 'z'])
  assert.ok(s.concepts.includes('surgical-edit') && s.concepts.includes('exact-match-edit'))
})

test('Edit: minus and plus hold at most 3 lines of at most 70 chars', () => {
  const long = 'const value = ' + 'x'.repeat(200)
  const s = explain('Edit', { file_path: 'a.ts', old_string: `${long}\n${long}\n${long}\n${long}`, new_string: `${long}y\nq\nr\ns\nt` })
  const e = sceneOf(s, 'edit')
  assert.ok(e.minus.length <= 3 && e.plus.length <= 3)
  for (const l of [...e.minus, ...e.plus]) assert.ok(l.length <= 70, l)
  assert.ok(e.minus[0]?.endsWith('…'))
})

test('Edit: replace_all names the replaced text', () => {
  const s = explain('Edit', { file_path: 'src/login.py', old_string: 'foo', new_string: 'bar', replace_all: true })
  assert.equal(s.headline, 'Editing login.py: replacing every “foo”')
  assert.ok(s.concepts.includes('exact-match-edit'))
})

test('Edit: a strict prefix or suffix is an addition', () => {
  const add = explain('Edit', { file_path: 'src/login.py', old_string: 'import os', new_string: 'import os\nimport sys\nimport re\nimport json\nimport time' })
  assert.equal(add.headline, 'Editing login.py: adding 4 lines')
  assert.deepEqual(sceneOf(add, 'edit').plus, ['import sys', 'import re', 'import json'])
  assert.deepEqual(sceneOf(add, 'edit').minus, [])
  const before = explain('Edit', { file_path: 'src/login.py', old_string: 'def main():', new_string: '@cli\n@trace\ndef main():' })
  assert.equal(before.headline, 'Editing login.py: adding 2 lines')
})

test('Edit: deletions and single-line changes', () => {
  assert.equal(explain('Edit', { file_path: 'a.py', old_string: 'x = 1\ny = 2\n', new_string: '' }).headline, 'Editing a.py: deleting 2 lines')
  assert.equal(explain('Edit', { file_path: 'a.py', old_string: 'x = 1\ny = 2\nz = 3', new_string: 'x = 1' }).headline, 'Editing a.py: removing 2 lines')
  const one = explain('Edit', { file_path: 'a.py', old_string: 'x = 1', new_string: 'x = 2' })
  assert.equal(one.headline, 'Editing a.py: changing 1 line')
  assert.deepEqual([sceneOf(one, 'edit').minus, sceneOf(one, 'edit').plus], [['x = 1'], ['x = 2']])
})

test('Edit: read-before-edit only when the file was read', () => {
  const args = { file_path: '/home/ana/shop/src/login.py', old_string: 'a', new_string: 'b' }
  assert.ok(!explain('Edit', args).concepts.includes('read-before-edit'))
  assert.equal(explain('Edit', args, { ...CTX, readPaths: ['/home/ana/shop/src/login.py'] }).concepts[0], 'read-before-edit')
  assert.ok(explain('Edit', args, { ...CTX, readPaths: ['src/login.py'] }).concepts.includes('read-before-edit'), 'relative read path')
  assert.ok(explain('Edit', { ...args, file_path: 'src/../src/login.py' }, { ...CTX, readPaths: ['/home/ana/shop/src/login.py'] }).concepts.includes('read-before-edit'))
})

test('Edit: file-type concepts', () => {
  const s = explain('Edit', { file_path: '/home/ana/shop/package.json', old_string: '"a": 1', new_string: '"a": 2' })
  assert.ok(s.concepts.includes('package-json') && s.concepts.includes('json'))
})

// ------------------------------------------------------------------ Write

test('Write: creating a new file', () => {
  const s = explain('Write', { file_path: '/home/ana/shop/notes.md', content: lines(42) + '\n' })
  assert.equal(s.headline, 'Creating notes.md (42 lines)')
  const e = sceneOf(s, 'edit')
  assert.equal(e.isNew, true)
  assert.equal(e.added, 42)
  assert.deepEqual(e.plus, ['line 1', 'line 2', 'line 3'])
  assert.deepEqual(s.concepts, ['create-file', 'markdown'])
})

test('Write: rewriting a file it read', () => {
  const s = explain('Write', { file_path: '/home/ana/shop/config.py', content: lines(120) }, { ...CTX, readPaths: ['/tmp/a', '/home/ana/shop/config.py'] })
  assert.equal(s.headline, 'Rewriting config.py (120 lines)')
  assert.equal(sceneOf(s, 'edit').isNew, false)
  assert.ok(s.concepts.includes('create-file') && s.concepts.includes('config-files'))
})

test('Write and Read: a plan-mode plan file is called the plan', () => {
  const w = explain('Write', { file_path: '/home/ana/.claude/plans/brave-otter-sings.md', content: '# Plan\n\n## Steps' })
  assert.equal(w.headline, 'Creating the plan (3 lines)')
  assert.ok(w.concepts.includes('plan-mode'))
  assert.equal(explain('Read', { file_path: '/home/ana/.claude/plans/brave-otter-sings.md' }).headline, 'Reading the plan')
})

test('Write: one line, empty, and a content the mod cut', () => {
  assert.equal(explain('Write', { file_path: 'a.txt', content: 'hi' }).headline, 'Creating a.txt (1 line)')
  assert.equal(explain('Write', { file_path: 'a.txt', content: '' }).headline, 'Creating a.txt (empty)')
  const cut = explain('Write', { file_path: 'big.py', content: 'x = 1\n'.repeat(700).slice(0, 4000) })
  assert.match(cut.headline, /^Creating big\.py \(\d+\+ lines\)$/)
})

// ------------------------------------------------------------------ Bash (contract level only)

test('Bash: the description is the headline, capitalised', () => {
  const s = explain('Bash', { command: 'ls -la src', description: 'list the source folder' })
  assert.equal(s.headline, 'List the source folder')
  assert.equal(s.target, 'ls -la src')
})

test('Bash: a long description is cut to 90 characters', () => {
  const desc = 'Rebuild both images and restart the containers from the new location, then tail the logs of each service until healthy'
  const s = explain('Bash', { command: 'make all', description: desc })
  assert.ok(s.headline.length <= 90)
  assert.ok(s.headline.endsWith('…'))
  assert.ok(desc.startsWith(s.headline.slice(0, -1)), s.headline)
})

test('Bash: without a description the analysis headline is used', () => {
  const cmd = 'git status --short'
  const a = analyzeBash(cmd)
  const s = explain('Bash', { command: cmd })
  const expected = a.headline.replace(/\s+/g, ' ').trim()
  const got = s.headline.replace(/…$/, '')
  assert.equal(got.toLowerCase(), expected.slice(0, got.length).toLowerCase())
})

test('Bash: scene kind matches the station, concepts are registry ids, why from the analysis', () => {
  const commands = [
    'pytest -q tests/test_auth.py',
    "sed -n '10,40p' src/login.py",
    'grep -rn "handleLogin" src/',
    "cat > notes.txt <<'EOF'\nhello\nworld\nEOF",
    'curl -s https://api.github.com/repos/x/y',
    'nohup python3 train.py > train.log 2>&1 &',
    'for f in *.wav; do ffprobe "$f"; done',
    '',
  ]
  for (const command of commands) {
    const s = explain('Bash', { command, description: 'Do the thing' })
    assert.equal(s.scene.kind, SCENE_OF[s.station], command)
    const a = analyzeBash(command, 'Do the thing')
    const why = a.why.replace(/\s+/g, ' ').trim()
    if (why !== '') assert.ok(why.startsWith(s.why.replace(/…$/, '')), `${command}: ${s.why}`)
  }
})

test('Bash: run_in_background adds background-tasks and marks a run scene', () => {
  const s = explain('Bash', { command: 'python3 serve.py --port 8000', description: 'Start the dev server', run_in_background: true })
  assert.equal(s.concepts[0], 'background-tasks')
  if (s.scene.kind === 'run') assert.equal(s.scene.isBackground, true)
})

// ------------------------------------------------------------------ sceneForBash (synthetic analyses)

test('sceneForBash: run scene carries command, category, program and background flag', () => {
  const a = analysis({ station: 'run', category: 'test', primary: 'pytest', isBackground: true })
  const s = sceneOf(sceneForBash(a, 'pytest -q', CTX), 'run')
  assert.deepEqual(s, { kind: 'run', command: 'pytest -q', category: 'test', program: 'pytest', isBackground: true })
  const plain = sceneOf(sceneForBash(analysis({ category: 'nonsense' as BashAnalysis['category'] }), 'x', CTX, true), 'run')
  assert.equal(plain.category, 'other')
  assert.equal(plain.isBackground, true)
})

test('sceneForBash: read scene lists files with their line ranges', () => {
  const cmd = "sed -n '10,40p' /home/ana/shop/src/a.py && head -n 20 src/b.py; tail -n 5 logs/c.log; awk 'NR>=3 && NR<=9' d.txt; cat e.md"
  const a = analysis({ station: 'read', category: 'read-file', readsFiles: ['/home/ana/shop/src/a.py', 'src/b.py', 'logs/c.log', 'd.txt', 'e.md'] })
  assert.deepEqual(sceneOf(sceneForBash(a, cmd, CTX), 'read').files, [
    { path: 'src/a.py', detail: 'lines 10–40' },
    { path: 'src/b.py', detail: 'lines 1–20' },
    { path: 'logs/c.log', detail: 'last 5 lines' },
    { path: 'd.txt', detail: 'lines 3–9' },
    { path: 'e.md' },
  ])
})

test('sceneForBash: one file read twice keeps both ranges; head -1 and tail -1 are single lines', () => {
  const a = analysis({ station: 'read', readsFiles: ['/srv/app.py', '/srv/app.py', 'x.log', 'y.log'] })
  const cmd = "wc -l /srv/app.py; sed -n '1,80p' /srv/app.py; echo ===; sed -n '180,300p' /srv/app.py; tail -1 x.log; head -1 y.log"
  assert.deepEqual(sceneOf(sceneForBash(a, cmd, CTX), 'read').files, [
    { path: '/srv/app.py', detail: 'lines 1–80, lines 180–300' },
    { path: 'x.log', detail: 'last line' },
    { path: 'y.log', detail: 'line 1' },
  ])
  const resolved = analysis({ station: 'read', readsFiles: ['/home/ana/shop/src/cart.py'] })
  assert.deepEqual(sceneOf(sceneForBash(resolved, "cd /home/ana/shop && sed -n '5,9p' src/cart.py", CTX), 'read').files, [{ path: 'src/cart.py', detail: 'lines 5–9' }])
})

test('sceneForBash: search scene has the query and where', () => {
  const a = analysis({ station: 'search', category: 'search', searchQuery: 'handleLogin', searchWhere: '/home/ana/shop/src' })
  assert.deepEqual(sceneForBash(a, 'grep -rn handleLogin src', CTX), { kind: 'search', query: 'handleLogin', where: 'src' })
})

test('sceneForBash: edit scene from a heredoc, and from sed -i', () => {
  const cmd = "cd /home/ana/shop && python3 - <<'PY'\nprint(1)\nPY\ncat > src/time.ts <<'EOF'\nexport const a = 1\nexport const b = 2\n\nexport const c = 3\nexport const d = 4\nEOF\necho done"
  const a = analysis({ station: 'edit', category: 'write-file', writesFiles: ['src/time.ts'] })
  const e = sceneOf(sceneForBash(a, cmd, CTX), 'edit')
  assert.equal(e.path, 'src/time.ts')
  assert.equal(e.added, 5)
  assert.deepEqual(e.plus, ['export const a = 1', 'export const b = 2', ''])
  assert.deepEqual(e.minus, [])
  assert.equal(e.isNew, true)
  assert.equal(sceneOf(sceneForBash(a, cmd, { ...CTX, readPaths: ['/home/ana/shop/src/time.ts'] }), 'edit').isNew, false)
  const sed = sceneOf(sceneForBash(analysis({ station: 'edit', writesFiles: ['conf.ini'] }), "sed -i 's/debug = false/debug = true/' conf.ini", CTX), 'edit')
  assert.deepEqual([sed.minus, sed.plus, sed.isNew], [['debug = false'], ['debug = true'], false])
  const multi = sceneOf(sceneForBash(analysis({ station: 'edit', writesFiles: ['.env'] }), "sed -i 's/^PORT=80$/PORT=8080\\n# moved off 80/' .env", CTX), 'edit')
  assert.deepEqual([multi.minus, multi.plus], [['PORT=80'], ['PORT=8080', '# moved off 80']])
  const backup = sceneOf(sceneForBash(analysis({ station: 'edit', writesFiles: ['.env.bak', '.env'] }), "cp .env .env.bak && sed -i 's/HOST=a/HOST=b/' .env", CTX), 'edit')
  assert.deepEqual([backup.path, backup.minus, backup.plus], ['.env', ['HOST=a'], ['HOST=b']])
  const pair = sceneOf(sceneForBash(analysis({ station: 'edit', writesFiles: ['src/a.ts', 'src/b.ts'] }), "cat > src/a.ts <<'A'\nexport const a = 1\nA\ncat > src/b.ts <<'B'\nexport const b = 2\nexport const c = 3\nB", CTX), 'edit')
  assert.deepEqual([pair.path, pair.added, pair.plus], ['src/a.ts', 1, ['export const a = 1']])
  const two = sceneOf(sceneForBash(analysis({ station: 'edit', writesFiles: ['a.md'] }), "sed -i 's/^- old: /- new: /; s/x/y/' a.md", CTX), 'edit')
  assert.deepEqual([two.minus, two.plus], [['- old:'], ['- new:']])
  const append = sceneOf(sceneForBash(analysis({ station: 'edit', writesFiles: ['notes.md'] }), "cat >> notes.md <<'EOF'\n- one more\nEOF", CTX), 'edit')
  assert.deepEqual([append.added, append.plus, append.isNew], [1, ['- one more'], false])
})

test('sceneForBash: echo/printf into a file, folders made, files deleted, folder vs file', () => {
  const echo = sceneOf(sceneForBash(analysis({ station: 'edit', category: 'write-file', writesFiles: ['/home/ana/shop/memory/MEMORY.md'] }), "M=/home/ana/shop/memory; echo '- [Deploy notes](deploy.md)' >> $M/MEMORY.md", CTX), 'edit')
  assert.deepEqual([echo.path, echo.added, echo.plus, echo.isNew], ['memory/MEMORY.md', 1, ['- [Deploy notes](deploy.md)'], false])
  const fresh = sceneOf(sceneForBash(analysis({ station: 'edit', writesFiles: ['.env.local'] }), "printf 'PORT=8080\\nDEBUG=0\\n' > .env.local", CTX), 'edit')
  assert.deepEqual([fresh.plus, fresh.isNew], [['PORT=8080', 'DEBUG=0'], true])
  const tee = sceneOf(sceneForBash(analysis({ station: 'edit', writesFiles: ['log.txt'] }), "echo started | tee -a log.txt", CTX), 'edit')
  assert.deepEqual([tee.plus, tee.isNew], [['started'], false])
  const dirs = sceneOf(sceneForBash(analysis({ station: 'edit', category: 'file-ops', programs: ['mkdir'], writesFiles: ['out/logs', 'out/data'] }), 'mkdir -p out/logs out/data', CTX), 'edit')
  assert.deepEqual([dirs.path, dirs.plus, dirs.added, dirs.isNew], ['out/logs', ['out/logs/', 'out/data/'], 2, false])
  const rm = sceneOf(sceneForBash(analysis({ station: 'edit', category: 'file-ops', programs: ['rm'], target: 'build' }), 'rm -rf build dist', CTX), 'edit')
  assert.deepEqual([rm.path, rm.minus, rm.removed, rm.added], ['build', ['build', 'dist'], 2, 0])
  // a folder made for the files written into it is not the file on show
  const pack = sceneOf(sceneForBash(analysis({ station: 'edit', programs: ['mkdir', 'cat'], writesFiles: ['/w/pack', '/w/pack/README.txt'] }), "mkdir -p /w/pack && cat > /w/pack/README.txt <<'EOF'\nhello\nEOF", CTX), 'edit')
  assert.deepEqual([pack.path, pack.plus], ['/w/pack/README.txt', ['hello']])
  // a name inside another name is not a match: data.py is not a.py
  const two = sceneOf(sceneForBash(analysis({ station: 'edit', writesFiles: ['a.py', 'data.py'] }), "cat > data.py <<'EOF'\nx = 1\nEOF\ncat > a.py <<'EOF'\ny = 2\nEOF", CTX), 'edit')
  assert.deepEqual([two.path, two.plus], ['a.py', ['y = 2']])
})

test('sceneForBash: a listing has no search term: “*” in the folder listed', () => {
  assert.deepEqual(sceneForBash(analysis({ station: 'search', category: 'list-files', target: '/home/ana/shop/src' }), 'ls -la /home/ana/shop/src', CTX), { kind: 'search', query: '*', where: 'src/' })
  assert.deepEqual(sceneForBash(analysis({ station: 'search', category: 'list-files', target: '.' }), 'find . -type f | sort', CTX), { kind: 'search', query: '*', where: 'the current folder' })
  assert.deepEqual(sceneForBash(analysis({ station: 'search', category: 'list-files', target: 'src', searchQuery: '*.py', searchWhere: 'src' }), "find src -name '*.py'", CTX), { kind: 'search', query: '*.py', where: 'src' })
})

test('Edit: context lines quoted to make old_string unique are not counted as changes', () => {
  const s = explain('Edit', { file_path: 'src/login.py', old_string: 'def a():\n    x = 1\n    return x', new_string: 'def a():\n    x = 2\n    return x' })
  assert.equal(s.headline, 'Editing login.py: changing 1 line')
  assert.equal(s.detail, '+1 −1')
  const e = sceneOf(s, 'edit')
  assert.deepEqual([e.removed, e.added, e.minus, e.plus], [1, 1, ['    x = 1'], ['    x = 2']])
  const grow = sceneOf(explain('Edit', { file_path: 'a.py', old_string: '    return redirect(home)', new_string: '    nxt = get()\n    if nxt:\n        return redirect(nxt)\n    return redirect(home)' }), 'edit')
  assert.deepEqual([grow.removed, grow.added, grow.plus.length], [0, 3, 3], 'the badge and the hidden-line count agree with the lines shown')
})

test('TodoWrite: a fresh plan is a new plan, even with its first step already in progress', () => {
  const todos = [{ content: 'A', status: 'in_progress', activeForm: 'Doing A' }, { content: 'B', status: 'pending', activeForm: 'Doing B' }]
  assert.equal(explain('TodoWrite', { todos }).headline, 'Making a plan: 2 steps')
})

test('sceneForBash: web scene has url and domain', () => {
  const a = analysis({ station: 'web', category: 'http', target: 'https://www.example.com/api/v1' })
  assert.deepEqual(sceneForBash(a, "curl -s 'https://www.example.com/api/v1?x=1' | jq .", CTX), {
    kind: 'web', url: 'https://www.example.com/api/v1?x=1', domain: 'example.com',
  })
})

test('bashStationOf: stations a command cannot stand at fall back to run, others get matching scenes', () => {
  assert.equal(bashStationOf(analysis({ station: 'talk' })), 'run')
  assert.equal(bashStationOf(analysis({ station: 'bogus' as Station })), 'run')
  assert.equal(bashStationOf(null as unknown as BashAnalysis), 'run')
  for (const station of ['plan', 'delegate', 'tools', 'ask', 'read', 'search', 'edit', 'web', 'run'] as const) {
    const a = analysis({ station })
    assert.equal(bashStationOf(a), station)
    assert.equal(sceneForBash(a, 'x', CTX).kind, SCENE_OF[station])
  }
})

// ------------------------------------------------------------------ agents, planning, asking

test('Agent: delegate scene with one agent', () => {
  const s = explain('Agent', { description: 'Map the checkout module', subagent_type: 'Explore', prompt: '…' })
  assert.equal(s.station, 'delegate')
  assert.equal(s.headline, 'Delegating to a sub-agent: Map the checkout module')
  assert.deepEqual(sceneOf(s, 'delegate').agents, [{ label: 'Map the checkout module', type: 'Explore', status: 'running' }])
  assert.equal(s.concepts[0], 'subagents')
  assert.ok(!s.concepts.includes('background-tasks'))
  assert.ok(explain('Agent', { description: 'x', prompt: 'y', run_in_background: true }).concepts.includes('background-tasks'))
})

test('Workflow: name and description from the script meta', () => {
  const script = "export const meta = {\n  name: 'shop-review',\n  description: 'Review the shop\\'s checkout flow, then fix what fails',\n  phases: [{ title: 'Read' }],\n}\nawait agent('x')"
  const s = explain('Workflow', { script })
  assert.equal(s.headline, 'Running a multi-agent workflow: Review the shop\'s checkout flow, then fix what fails')
  assert.equal(s.detail, 'shop-review')
  assert.deepEqual(s.concepts, ['multi-agent-workflow', 'subagents'])
  assert.equal(sceneOf(s, 'delegate').agents[0]?.type, 'workflow')
})

test('Workflow: a saved script path, resumed', () => {
  const s = explain('Workflow', { scriptPath: '/home/ana/.claude/projects/p/s/workflows/scripts/shop-review-wf_1a2b3c4d-5ef.js', resumeFromRunId: 'wf_1a2b3c4d-5ef' })
  assert.equal(s.headline, 'Resuming a multi-agent workflow: shop-review')
  assert.equal(explain('Workflow', {}).headline, 'Running a multi-agent workflow')
})

test('TodoWrite: plan items and progress', () => {
  const todos = [
    { content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
    { content: 'Write the fix', status: 'completed', activeForm: 'Writing the fix' },
    { content: 'Run the tests', status: 'in_progress', activeForm: 'Running the tests' },
    { content: 'Update docs', status: 'pending', activeForm: 'Updating docs' },
    { content: 'Open a PR', status: 'pending', activeForm: 'Opening a PR' },
  ]
  const s = explain('TodoWrite', { todos })
  assert.equal(s.station, 'plan')
  assert.equal(s.headline, 'Updating the plan: 2 of 5 done')
  assert.equal(s.detail, 'Running the tests')
  assert.deepEqual(sceneOf(s, 'plan').items.map(i => i.state), ['done', 'done', 'doing', 'todo', 'todo'])
  assert.deepEqual(s.concepts, ['todo-planning'])
  assert.equal(explain('TodoWrite', { todos: todos.map(t => ({ ...t, status: 'pending' })) }).headline, 'Making a plan: 5 steps')
  assert.equal(explain('TodoWrite', { todos: todos.map(t => ({ ...t, status: 'completed' })) }).headline, 'Updating the plan: all 5 done')
  assert.equal(explain('TodoWrite', { todos: [] }).headline, 'Clearing the plan')
  const long = Array.from({ length: 20 }, (_, i) => ({ content: `task ${i}`, status: i < 15 ? 'completed' : i === 15 ? 'in_progress' : 'pending', activeForm: `doing ${i}` }))
  const items = sceneOf(explain('TodoWrite', { todos: long }), 'plan').items
  assert.equal(items.length, 12)
  assert.ok(items.some(i => i.state === 'doing' && i.text === 'task 15'), 'the in-progress item stays in view')
})

test('Plan mode: entering and asking for approval', () => {
  const enter = explain('EnterPlanMode', {})
  assert.deepEqual([enter.station, enter.concepts], ['plan', ['plan-mode']])
  const exit = explain('ExitPlanMode', { plan: '# Faster checkout\n\n## Context\nslow\n## Approach\ncache\n## Verification\ntests' })
  assert.equal(exit.headline, 'Asking you to approve the plan: Faster checkout')
  assert.deepEqual(sceneOf(exit, 'plan').items.map(i => i.text), ['Context', 'Approach', 'Verification'])
  assert.deepEqual(exit.concepts, ['plan-mode'])
})

test('AskUserQuestion: ask scene with the first question', () => {
  const qs = [
    { question: 'Which database should the shop use?', header: 'Database', options: [], multiSelect: false },
    { question: 'Deploy now?', header: 'Deploy', options: [], multiSelect: false },
  ]
  const s = explain('AskUserQuestion', { questions: qs })
  assert.equal(s.station, 'ask')
  assert.equal(s.headline, 'Asking you: Which database should the shop use?')
  assert.deepEqual(s.scene, { kind: 'ask', question: 'Which database should the shop use?', isPermission: false })
  assert.equal(s.detail, '2 questions')
  assert.deepEqual(s.concepts, ['clarifying-questions'])
})

// ------------------------------------------------------------------ web

test('WebSearch: web scene and quoted query', () => {
  const s = explain('WebSearch', { query: 'python 3.13 release notes', mode: 'standard' })
  assert.equal(s.headline, 'Searching the web for “python 3.13 release notes”')
  assert.deepEqual(s.scene, { kind: 'web', query: 'python 3.13 release notes' })
  assert.deepEqual(s.concepts, ['web-research'])
  const long = explain('WebSearch', { query: 'word '.repeat(60) })
  assert.ok(long.headline.length <= 90 && long.headline.endsWith('”'))
})

test('WebFetch: reading domain/path', () => {
  const s = explain('WebFetch', { url: 'https://www.docs.python.org/3/library/os.html?highlight=x#os.walk', prompt: 'what does walk do' })
  assert.equal(s.headline, 'Reading docs.python.org/3/library/os.html')
  const w = sceneOf(s, 'web')
  assert.equal(w.domain, 'docs.python.org')
  assert.ok(w.url?.startsWith('https://www.docs.python.org/3/library/os.html'))
  assert.deepEqual(s.concepts, ['web-research', 'http-requests'])
  assert.equal(explain('WebFetch', { url: 'https://pi.dev/' }).headline, 'Reading pi.dev')
  const secret = explain('WebFetch', { url: 'https://ana:hunter2@api.shop.dev/v1/orders?api_key=abc123&page=2' })
  assert.equal(secret.headline, 'Reading api.shop.dev/v1/orders')
  assert.equal(secret.target, 'https://api.shop.dev/v1/orders?api_key=…&page=2')
  assert.equal(sceneOf(secret, 'web').url, 'https://api.shop.dev/v1/orders?api_key=…&page=2')
})

// ------------------------------------------------------------------ tools and connectors

test('Skill: loading a skill (plugin prefix dropped)', () => {
  const s = explain('Skill', { skill: 'anthropic-skills:docs' })
  assert.equal(s.headline, 'Loading the docs skill')
  assert.equal(s.station, 'tools')
  assert.equal(sceneOf(s, 'tools').name, 'docs')
  assert.deepEqual(s.concepts, ['skills'])
  assert.equal(explain('Skill', { skill: 'code-review', args: 'PR-482' }).detail, 'PR-482')
})

test('ToolSearch: loading definitions vs searching the tool list', () => {
  const s = explain('ToolSearch', { query: 'select:WebFetch,WebSearch', max_results: 2 })
  assert.equal(s.headline, 'Loading tool definitions: WebFetch, WebSearch')
  assert.equal(s.station, 'tools')
  assert.deepEqual(s.concepts, ['deferred-tools'])
  const k = explain('ToolSearch', { query: 'notebook jupyter', max_results: 5 })
  assert.equal(k.station, 'search')
  assert.equal(k.headline, 'Searching its tool list for “notebook jupyter”')
})

test('Monitor: watching a job in the background', () => {
  const s = explain('Monitor', { description: 'vLLM server readiness', timeout_ms: 600_000, command: 'until curl -s localhost:8001; do sleep 2; done' })
  assert.equal(s.headline, 'Watching: vLLM server readiness')
  assert.equal(s.detail, 'up to 10 min')
  assert.ok(s.concepts.includes('monitoring') && s.concepts.includes('background-tasks'))
  assert.equal(sceneOf(s, 'run').isBackground, true)
})

test('Background and scheduling tools', () => {
  assert.deepEqual(explain('TaskStop', { task_id: 'b12' }).concepts, ['background-tasks'])
  const wake = explain('ScheduleWakeup', { delaySeconds: 600, reason: 'the build should be done', prompt: '/loop' })
  assert.equal(wake.headline, 'Checking back in 10 min: the build should be done')
  assert.deepEqual(wake.concepts, ['scheduling'])
  for (const t of ['CronCreate', 'CronDelete', 'CronList']) assert.deepEqual(explain(t, { cron: '0 9 * * 1', prompt: 'check CI' }).concepts, ['scheduling'])
})

test('Messages, structured output and artifacts', () => {
  const m = explain('SendMessage', { to: 'reviewer', summary: 'tests pass now', message: 'long text' })
  assert.deepEqual([m.station, m.concepts[0], m.headline], ['delegate', 'subagents', 'Messaging reviewer: tests pass now'])
  const so = explain('StructuredOutput', { summary: 'All 12 checks pass', failures: [], numbers: {} })
  assert.deepEqual([so.concepts, so.headline], [['structured-output'], 'Returning a structured result: All 12 checks pass'])
  assert.equal(explain('StructuredOutput', { a: 1, b: 2 }).headline, 'Returning a structured result (2 fields)')
  const art = explain('Artifact', { action: 'publish', title: 'Checkout report', file_path: '/x/report.html' })
  assert.deepEqual([art.concepts, art.headline], [['artifacts'], 'Publishing a page: Checkout report'])
  assert.deepEqual(explain('ArtifactData', { action: 'set', url: 'https://claude.ai/artifact/x', collection: 'rows' }).concepts, ['artifacts'])
})

test('NotebookEdit, memory tools and worktrees', () => {
  const nb = explain('NotebookEdit', { notebook_path: '/home/ana/shop/eda.ipynb', new_source: 'df.head()', edit_mode: 'insert', cell_type: 'code' })
  assert.deepEqual([nb.station, nb.headline, sceneOf(nb, 'edit').isNew], ['edit', 'Adding a code cell to eda.ipynb', true])
  for (const t of ['memory_list', 'memory_read', 'memory_write']) {
    assert.deepEqual(explain(t, { store: 'notes', path: 'gpu.md', content: 'a\nb' }).concepts, ['agent-memory'])
  }
  assert.equal(explain('memory_write', { store: 's', path: 'gpu.md', content: 'x' }).station, 'edit')
  assert.deepEqual(explain('EnterWorktree', { name: 'fix-login' }).concepts, ['git-branch'])
  assert.deepEqual(explain('ExitWorktree', { action: 'keep' }).concepts, ['git-branch'])
})

test('MCP connectors: server and tool from the name', () => {
  const s = explain('mcp__claude_ai_Claude_Docs__update', { ref: { id: 'n1' }, payload: {} })
  assert.equal(s.headline, 'Using the Claude Docs connector: update')
  assert.deepEqual(s.concepts, ['mcp'])
  assert.deepEqual(s.scene, { kind: 'tools', name: 'update', server: 'Claude Docs' })
  const ide = explain('mcp__claude-vscode__getDiagnostics', { uri: 'file:///x.ts' })
  assert.equal(ide.headline, 'Using the Claude VS Code connector: getDiagnostics')
  assert.equal(sceneOf(ide, 'tools').detail, 'file:///x.ts')
  const chrome = explain('mcp__claude-in-chrome__navigate', { url: 'https://bob:pw@shop.dev/cart?session_id=9' })
  assert.equal(chrome.headline, 'Using the Claude in Chrome connector: navigate')
  assert.equal(chrome.target, 'https://shop.dev/cart?session_id=…')
})

test('Grep and Glob: search scenes', () => {
  const g = explain('Grep', { pattern: 'handleLogin', path: '/home/ana/shop/src', output_mode: 'content' })
  assert.equal(g.headline, 'Searching for “handleLogin” in src/')
  assert.deepEqual(g.scene, { kind: 'search', query: 'handleLogin', where: 'src/' })
  assert.ok(g.concepts.includes('grep') && !g.concepts.includes('regex'))
  assert.ok(explain('Grep', { pattern: 'def (get|set)_\\w+', path: 'src/models.py' }).concepts.includes('regex'))
  const gl = explain('Glob', { pattern: '**/*.py' })
  assert.equal(gl.headline, 'Finding files matching “**/*.py” in the project')
  assert.ok(gl.concepts.includes('globbing'))
})

test('Unknown tools: a generic tools step', () => {
  const s = explain('FrobnicateWidgets', { x: 1 })
  assert.equal(s.headline, 'Using FrobnicateWidgets')
  assert.deepEqual(s.concepts, ['tool-calls'])
  assert.deepEqual(s.scene, { kind: 'tools', name: 'FrobnicateWidgets' })
  assert.equal(s.station, 'tools')
})

test('why: two variants per tool, chosen deterministically by the call id', () => {
  const whys = new Set<string>()
  for (let i = 0; i < 40; i++) whys.add(check(explainTool({ id: `id-${i}`, tool: 'Read', args: { file_path: 'a.py' }, at: 0 }, CTX)).why)
  assert.equal(whys.size, 2)
  const a = explainTool({ id: 'same-id', tool: 'Agent', args: { description: 'x' }, at: 0 }, CTX)
  const b = explainTool({ id: 'same-id', tool: 'Agent', args: { description: 'y' }, at: 5 }, CTX)
  assert.equal(a.why, b.why)
})

test('agentId is carried over for sub-agent calls', () => {
  assert.equal(explain('Read', { file_path: 'a.py' }, CTX, { agentId: 'a1b2' }).agentId, 'a1b2')
  assert.ok(!('agentId' in explain('Read', { file_path: 'a.py' })))
})

// ------------------------------------------------------------------ applyEnd

test('applyEnd: status and endedAt, input untouched', () => {
  const s = explain('Read', { file_path: 'a.py' })
  const frozen = JSON.stringify(s)
  const e = finish(s, 'ok', '')
  assert.equal(e.status, 'ok')
  assert.equal(e.endedAt, 2_000)
  assert.equal(JSON.stringify(s), frozen)
  assert.equal(e.id, s.id)
})

test('applyEnd: Bash resultNote comes from bashResultNote', () => {
  const command = 'cd /home/ana/shop && pytest -q'
  const s = explain('Bash', { command, description: 'Run the tests' })
  const preview = 'Exit code 1\n....F\nFAILED tests/test_cart.py::test_total - AssertionError\n1 failed, 4 passed in 0.31s'
  const e = finish(s, 'error', preview)
  const note = bashResultNote(analyzeBash(command, 'Run the tests'), 'error', preview) // the analysis that explained the step
  assert.ok(e.resultNote !== undefined)
  if (note !== undefined && note.trim() !== '') assert.ok(note.replace(/\s+/g, ' ').trim().startsWith(e.resultNote.replace(/…$/, '')), `${e.resultNote} vs ${note}`)
})

test('applyEnd: a run scene shows the last meaningful output line', () => {
  const s = check({ ...explain('Bash', { command: 'make', description: 'Build' }), station: 'run', scene: { kind: 'run', command: 'make', category: 'build' } })
  const preview = '\u001b[32mcompiling\u001b[0m a.c\nlinking\u0007 app\x00\n' + 'Built target app in ' + 'x'.repeat(200) + '\n========\n\n'
  const out = sceneOf(finish(s, 'ok', preview), 'run').output ?? ''
  assert.ok(out.startsWith('Built target app in'), out)
  assert.ok(out.length <= 100)
  assert.ok(!CONTROL.test(out))
  const ansi = sceneOf(finish(s, 'ok', 'ok\n\u001b[1;31mFAILED\u001b[0m: 3 tests'), 'run').output
  assert.equal(ansi, 'FAILED: 3 tests')
})

test('applyEnd: Read counts the numbered lines', () => {
  const s = explain('Read', { file_path: '/home/ana/shop/src/a.py' })
  const e = finish(s, 'ok', '1\timport os\n2\t\n3\tprint(1)\n')
  assert.equal(e.resultNote, '3 lines')
  assert.equal(sceneOf(e, 'read').files[0]?.detail, '3 lines')
  assert.equal(finish(s, 'ok', '     1→a\n     2→b').resultNote, '2 lines')
  const big = Array.from({ length: 400 }, (_, i) => `${i + 1}\tsome code on this line`).join('\n').slice(0, 1500)
  assert.match(finish(s, 'ok', big).resultNote ?? '', /^\d+\+ lines$/)
  const ranged = finish(explain('Read', { file_path: 'a.py', offset: 10, limit: 2 }), 'ok', '10\ta\n11\tb')
  assert.equal(sceneOf(ranged, 'read').files[0]?.detail, 'lines 10–11')
  assert.equal(ranged.resultNote, '2 lines')
  const cutRange = finish(explain('Read', { file_path: 'a.py', offset: 1, limit: 400 }), 'ok', big)
  assert.equal(cutRange.resultNote, undefined, 'no partial count beside a requested range')
})

test('applyEnd: Edit errors say what went wrong', () => {
  const s = explain('Edit', { file_path: 'a.py', old_string: 'x', new_string: 'y' })
  assert.equal(finish(s, 'error', '<tool_use_error>String to replace not found in file.\nString: x</tool_use_error>').resultNote, 'the text to replace was not found')
  assert.equal(finish(s, 'error', 'Found 3 matches of the string to replace, but replace_all is false.').resultNote, 'the text to replace matches 3 places, not one')
  assert.equal(finish(s, 'error', 'File has not been read yet. Read it first before writing to it.').resultNote, 'the file must be read before it can be changed')
})

test('applyEnd: an async Agent launch keeps its agent running', () => {
  const s = explain('Agent', { description: 'Audit the cart', subagent_type: 'Explore', run_in_background: true })
  const e = finish(s, 'ok', 'Async agent launched successfully.\nagentId: a123 (internal ID)')
  assert.equal(e.resultNote, 'started in the background')
  assert.equal(sceneOf(e, 'delegate').agents[0]?.status, 'running')
  const sync = finish(explain('Agent', { description: 'Audit the cart' }), 'ok', '## Findings\nThe cart total ignores discounts.')
  assert.equal(sceneOf(sync, 'delegate').agents[0]?.status, 'ok')
  assert.equal(sync.resultNote, 'Findings')
})

test('applyEnd: denials by a permission rule', () => {
  const s = explain('Bash', { command: 'curl https://x.dev', description: 'Fetch it' })
  const d = finish(s, 'denied', 'blocked by policy no-network')
  assert.deepEqual([d.status, d.resultNote], ['denied', 'Blocked by a permission rule'])
  const e = finish(s, 'error', "Permission to use Bash with command curl --version has been denied.")
  assert.deepEqual([e.status, e.resultNote], ['denied', 'Blocked by a permission rule'])
  const dontAsk = finish(explain('Skill', { skill: 'x' }), 'error', "Permission to use Skill has been denied because Claude Code is running in don't ask mode.")
  assert.equal(dontAsk.status, 'denied')
})

test('applyEnd: the person declining, with their words, or stopping it', () => {
  const s = explain('ExitPlanMode', { plan: '# P' })
  const no = finish(s, 'error', "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.")
  assert.deepEqual([no.status, no.resultNote], ['denied', 'You declined this'])
  const said = finish(s, 'error', "The user doesn't want to proceed with this tool use. To tell you how to proceed, the user said:\nkeep the old API too")
  assert.equal(said.resultNote, 'You declined this: “keep the old API too”')
  const stop = finish(explain('Bash', { command: 'sleep 100' }), 'error', '[Request interrupted by user for tool use]')
  assert.deepEqual([stop.status, stop.resultNote], ['denied', 'You stopped this'])
  const agent = finish(explain('Agent', { description: 'x' }), 'denied', 'User rejected tool use')
  assert.equal(sceneOf(agent, 'delegate').agents[0]?.status, 'denied')
})

test('applyEnd: WebSearch counts visible results', () => {
  const s = explain('WebSearch', { query: 'q' })
  const links = (n: number) => Array.from({ length: n }, (_, i) => `{"title":"t${i}","url":"https://e.com/${i}"}`).join(',')
  assert.equal(finish(s, 'ok', `Web search results for query: "q"\n\nLinks: [${links(8)}]\n\nSummary`).resultNote, '8 results')
  assert.equal(finish(s, 'ok', `Web search results for query: "q"\n\nLinks: [${links(3)}`).resultNote, '3+ results')
  assert.equal(finish(s, 'ok', 'nothing useful').resultNote, undefined)
})

test('applyEnd: Grep and Glob matches land in the search scene', () => {
  const g = finish(explain('Grep', { pattern: 'foo', output_mode: 'content' }), 'ok', 'src/a.ts:12:foo()\nsrc/b.ts-13-  context\nsrc/b.ts:14:  foo(x)\n')
  assert.equal(sceneOf(g, 'search').matches, '2 matches')
  assert.equal(g.detail, '2 matches')
  assert.equal(finish(explain('Grep', { pattern: 'foo' }), 'ok', 'Found 4 files\na.ts\nb.ts\nc.ts\nd.ts').resultNote, '4 files')
  assert.equal(finish(explain('Grep', { pattern: 'foo' }), 'ok', 'No matches found').resultNote, 'no matches')
  assert.equal(finish(explain('Glob', { pattern: '*.py' }), 'ok', 'a.py\nb.py\nc.py').resultNote, '3 files')
})

test('applyEnd: a Bash search scene gets a match count', () => {
  const step = check({
    ...explain('Bash', { command: 'grep -rn foo src', description: 'Find foo' }),
    station: 'search',
    scene: { kind: 'search', query: 'foo', where: 'src' },
  })
  const e = finish(step, 'ok', 'src/a.py:1:foo\nsrc/b.py:9:foo = 2\n')
  const m = sceneOf(e, 'search').matches
  assert.ok(m !== undefined && m.length > 0 && m.length <= 40, String(m))
})

test('applyEnd: other tools’ results', () => {
  const ask = explain('AskUserQuestion', { questions: [{ question: 'Use "fast" mode?', header: 'Mode', options: [], multiSelect: false }] })
  assert.equal(finish(ask, 'ok', 'Your questions have been answered: "Use "fast" mode?"="Yes, fast (Recommended)". You can now continue.').resultNote, 'You answered “Yes, fast (Recommended)”')
  assert.equal(finish(explain('ExitPlanMode', {}), 'ok', 'User has approved your plan. You can now start coding.').resultNote, 'You approved the plan')
  assert.equal(finish(explain('ToolSearch', { query: 'select:A,B' }), 'ok', '[tool_reference:A]\n[tool_reference:B]').resultNote, 'loaded 2 tools')
  assert.equal(finish(explain('Workflow', {}), 'ok', 'Workflow launched in background. Task ID: w1').resultNote, 'started in the background')
  assert.equal(finish(explain('Monitor', { description: 'd' }), 'ok', 'Monitor started (task b1, expires in 10m)').resultNote, 'watching in the background')
  const stop = finish(explain('TaskStop', { task_id: 'w1' }), 'ok', '{"message":"Successfully stopped task: w1 (Rebuild the \\"cart\\" index)","task_id":"w1"}')
  assert.equal(stop.resultNote, 'stopped “Rebuild the "cart" index”')
  assert.equal(finish(explain('WebFetch', { url: 'https://x.dev' }), 'error', 'timeout of 60000ms exceeded').resultNote, 'timed out after 60 s')
  assert.equal(finish(explain('WebFetch', { url: 'https://x.dev' }), 'error', 'Request failed with status code 404').resultNote, 'HTTP 404')
})

test('applyEnd: every error gets a note', () => {
  const s = explain('mcp__tracker__create_issue', { title: 'x' })
  assert.equal(finish(s, 'error', '<artifact-content-authored-by-others/>\nError: quota exceeded for project\nmore').resultNote, 'quota exceeded for project')
  assert.equal(finish(s, 'error', '').resultNote, 'failed with no message')
  assert.equal(finish(s, 'error', '{"verdict":"deny","reason":"bad_request","detail":"x"}').resultNote, 'refused: bad request')
  assert.equal(finish(explain('Read', { file_path: 'nope.py' }), 'error', 'File does not exist. Note: your current working directory is /x.').resultNote, 'file not found')
  assert.equal(finish(explain('Read', { file_path: 'big.log' }), 'error', 'File content (28.5k tokens) exceeds maximum allowed tokens (25000). Please use offset and limit.').resultNote, 'too big to read at once: it needs a line range')
  assert.equal(finish(explain('Read', { file_path: 'src' }), 'error', 'EISDIR: illegal operation on a directory, read').resultNote, 'that is a folder, not a file')
  assert.equal(finish(explain('WebFetch', { url: 'https://a.dev' }), 'ok', 'REDIRECT DETECTED: The URL redirects to a different host.').resultNote, 'the page redirects to another site')
})

// ------------------------------------------------------------------ odd input

const ALL_TOOLS = [
  'Bash', 'Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'NotebookRead', 'Agent', 'Task', 'Workflow', 'TodoWrite',
  'TaskCreate', 'TaskUpdate', 'TaskList', 'EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion', 'WebSearch', 'WebFetch',
  'Skill', 'ToolSearch', 'Monitor', 'TaskStop', 'TaskOutput', 'ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList',
  'SendMessage', 'SubagentHandback', 'ListAgents', 'StructuredOutput', 'Artifact', 'ArtifactData', 'ArtifactComments',
  'memory_list', 'memory_read', 'memory_write', 'EnterWorktree', 'ExitWorktree', 'Grep', 'Glob', 'LS', 'LSP',
  'SendUserFile', 'SendUserMessage', 'PushNotification', 'ReportFindings', 'WaitForMcpServers', 'ListSkills',
  'mcp__x__y', 'mcp__', 'enable__mcp__claude-in-chrome', 'Unknown',
]

// ------------------------------------------------------------------ secrets (redact.ts, the final pass)

// Fake secrets, built in pieces so no scanner mistakes this file for one holding real keys.
const HF = 'hf' + '_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz012345'
const GH = 'gh' + 'p_' + 'x'.repeat(36)
const ANT = 'sk-' + 'ant-api03-' + 'Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2Ji1'

/** The step as JSON, without its concept ids (an id such as 'secrets-hygiene' names a card, not a secret). */
const shown = (s: Step): string => JSON.stringify({ ...s, concepts: [] })

/** The secret, or any 8 characters in a row of its random part, appears in the text. */
function leaks(text: string, secret: string): boolean {
  if (text.includes(secret)) return true
  const body = secret.replace(/^(?:hf_|ghp_|sk-ant-api03-)/, '')
  if (body.length < 12) return false
  for (let i = 0; i + 8 <= body.length; i++) if (text.includes(body.slice(i, i + 8))) return true
  return false
}

test('secrets: a Bash command with HF_TOKEN=hf_… and mysql -psecret shows neither, start to end', () => {
  const command = `HF_TOKEN=${HF} python3 train.py --push && mysql -u root -psecret -h db.local shop -e "select count(*) from orders"`
  const s = explain('Bash', { command })
  assert.ok(!leaks(JSON.stringify(s), HF), JSON.stringify(s))
  assert.ok(!/psecret|\bsecret\b/.test(JSON.stringify(s)), JSON.stringify(s))
  assert.equal(s.target, command.replace(HF, '••••').replace('-psecret', '-p••••'), 'the command keeps everything but its secrets')
  // the output echoes them: masked there too
  const end = finish(s, 'error', `Exit code 1\nERROR 1045 (28000): Access denied for user 'root' (using password: YES)\nwhile pushing with HF_TOKEN=${HF}`)
  assert.ok(!leaks(JSON.stringify(end), HF), JSON.stringify(end))
  assert.ok(!/psecret|\bsecret\b/.test(JSON.stringify(end)), JSON.stringify(end))
  assert.equal(end.status, 'error')
})

test('secrets: every string a step shows is masked, for each kind of tool and at its end', () => {
  const calls: [string, Record<string, unknown>, string][] = [
    ['Bash', { command: `curl -s -H "Authorization: Bearer ${GH}" https://api.github.com/user`, description: 'Check who the token belongs to' }, GH],
    ['Bash', { command: 'git clone https://ana:hunter2@git.example.com/shop.git' }, 'hunter2'],
    ['Bash', { command: `export ANTHROPIC_API_KEY=${ANT}` }, ANT],
    ['Bash', { command: 'docker login -u ana -p hunter2 registry.example.com' }, 'hunter2'],
    ['Bash', { command: `cat > .env <<'EOF'\nDB_PASSWORD=hunter2\nAPI_KEY=${ANT}\nEOF` }, 'hunter2'],
    ['Bash', { command: `cat > .env <<'EOF'\nDB_PASSWORD=hunter2\nAPI_KEY=${ANT}\nEOF` }, ANT],
    ['Bash', { command: `grep -rn "${GH}" src/` }, GH],
    ['Bash', { command: `echo ${HF} | huggingface-cli login --token ${HF}`, description: `Log in with ${HF}` }, HF],
    ['Write', { file_path: '/home/ana/shop/.env', content: `DB_PASSWORD=hunter2\nHF_TOKEN=${HF}\n` }, 'hunter2'],
    ['Write', { file_path: '/home/ana/shop/.env', content: `DB_PASSWORD=hunter2\nHF_TOKEN=${HF}\n` }, HF],
    ['Edit', { file_path: '/home/ana/shop/config.py', old_string: `API_KEY = "${ANT}"`, new_string: 'API_KEY = os.environ["API_KEY"]' }, ANT],
    ['WebFetch', { url: `https://api.example.com/v1/me?access_token=${GH}` }, GH],
    ['Grep', { pattern: GH, path: '/home/ana/shop/src' }, GH],
    ['Agent', { description: `Rotate the leaked key ${ANT}`, prompt: 'x' }, ANT],
    ['Monitor', { command: 'curl -s -u ana:hunter2 https://ci.example.com/api/status', description: 'Watch the build' }, 'hunter2'],
    ['mcp__github__search_code', { query: `token ${GH}` }, GH],
    ['AskUserQuestion', { questions: [{ question: `Use the key ${ANT} for staging?` }] }, ANT],
    ['TodoWrite', { todos: [{ content: `Revoke ${GH}`, status: 'in_progress', activeForm: `Revoking ${GH}` }] }, GH],
  ]
  for (const [tool, args, secret] of calls) {
    const s = explain(tool, args)
    assert.ok(!leaks(shown(s), secret), `${tool}: ${shown(s)}`)
    // output that repeats the secret, labelled as output does ('password=…'): a bare word is not recognisable
    const said = secret === 'hunter2' ? `password=${secret}` : secret
    for (const [status, preview] of [['error', `Exit code 1\nfailed with ${said}`], ['ok', `done\nthe key is ${said}`]] as const) {
      const e = finish(s, status, preview)
      assert.ok(!leaks(shown(e), secret), `${tool} ${status}: ${shown(e)}`)
    }
  }
})

test('secrets: the label stays, ordinary text is untouched, and applyEnd still reads a masked command', () => {
  const s = explain('Bash', { command: `HF_TOKEN=${HF} pytest -q tests/test_hub.py` })
  assert.equal(s.target, 'HF_TOKEN=•••• pytest -q tests/test_hub.py')
  assert.equal(sceneOf(s, 'run').command, 'HF_TOKEN=•••• pytest -q tests/test_hub.py')
  assert.equal(sceneOf(s, 'run').category, 'test')
  assert.equal(finish(s, 'ok', '........ [100%]\n8 passed in 0.31s').resultNote, '8 passed', 'the masked command is still a test run')
  const plain = 'git show 3f2a9c1e7b4d && cat /home/ana/shop/runs/3f2a9c1e-7b4d-4e8a-9c3f-1a2b3c4d5e6f/out.log'
  assert.equal(explain('Bash', { command: plain }).target, plain, 'short SHAs, UUIDs and paths are not secrets')
  const edit = explain('Edit', { file_path: '/home/ana/shop/settings.py', old_string: 'def login(user: str, password: str):', new_string: 'def login(user: str, password: str, token: str | None = None):' })
  assert.deepEqual(sceneOf(edit, 'edit').plus, ['def login(user: str, password: str, token: str | None = None):'], 'code is not a secret')
})

test('odd input: missing, null, array and string args for every tool', () => {
  for (const tool of ALL_TOOLS) {
    for (const args of [{}, null, undefined, [], 'text', 7]) {
      const s = explain(tool, args)
      assert.equal(s.tool, tool)
      check(finish(s, 'ok', ''))
      check(finish(s, 'error', ''))
    }
  }
})

test('why: every variant of every tool fits in 170 characters', () => {
  const args = {
    file_path: '/home/ana/shop/a.py', offset: 3, limit: 4, pages: '2', old_string: 'a', new_string: 'b', replace_all: true, content: 'x',
    command: 'ls', description: 'List', query: 'select:A', url: 'https://x.dev', skill: 's', todos: [{ content: 'c', status: 'pending', activeForm: 'C' }],
    questions: [{ question: 'q?', header: 'h', options: [], multiSelect: false }], pattern: 'p', to: 'w', summary: 's', message: 'm', action: 'get',
  }
  const seen = new Set<string>()
  for (const tool of ALL_TOOLS) {
    for (let i = 0; i < 12; i++) seen.add(check(explainTool({ id: `why-${tool}-${i}`, tool, args, at: 0 }, CTX)).why)
  }
  assert.ok(seen.size >= 50, `distinct why sentences: ${seen.size}`)
})

test('odd input: arguments of the wrong type', () => {
  const wrong = {
    file_path: 42, command: { a: 1 }, description: 7, old_string: null, new_string: ['x'], content: false, todos: 'all of them',
    questions: { question: 'q' }, query: 12, url: [], pattern: {}, skill: true, script: 99, offset: 'ten', limit: -5,
    pages: {}, replace_all: 'yes', run_in_background: 'no', subagent_type: 3, edits: 'x', timeout_ms: 'soon', to: { name: 'x' },
  }
  for (const tool of ALL_TOOLS) check(finish(explain(tool, wrong), 'ok', 'x'))
})

test('odd input: huge strings stay fast and within limits', () => {
  const huge = 'abc def\n'.repeat(131_072) // 1 MiB
  const t0 = performance.now()
  for (const tool of ['Bash', 'Edit', 'Write', 'Read', 'Grep', 'WebSearch', 'Workflow', 'AskUserQuestion', 'Agent', 'mcp__a__b']) {
    const s = explain(tool, {
      command: huge, description: huge, file_path: '/x/' + 'p'.repeat(5000) + '.py', old_string: huge, new_string: huge + 'x',
      content: huge, pattern: huge, query: huge, script: huge, questions: [{ question: huge }], url: 'https://' + huge,
    })
    check(finish(s, 'error', huge))
    check(finish(s, 'ok', huge))
  }
  assert.ok(performance.now() - t0 < 2_000, 'huge inputs handled in well under 2 s')
})

test('odd input: broken observations and contexts', () => {
  for (const o of [null, undefined, 3, 'Bash', {}, { tool: 5 }, { id: 9, tool: 'Read', args: { file_path: 'a' }, at: Number.NaN }]) {
    const s = check(explainTool(o as unknown as ToolObs, CTX))
    assert.equal(s.startedAt, 0, 'a missing or NaN time becomes 0')
  }
  for (const ctx of [null, undefined, {}, { level: 9, cwd: 5, readPaths: 'a.py' }, { level: 1, readPaths: [null, 3, {}] }]) {
    check(explainTool(mkObs('Edit', { file_path: 'a.py', old_string: 'a', new_string: 'b' }), ctx as unknown as ExplainCtx))
  }
  const hostile = { get id(): string { throw new Error('boom') }, tool: 'Read', args: { file_path: 'a.py' }, at: 1 }
  check(explainTool(hostile as unknown as ToolObs, CTX))
  const hostileArgs = { id: 'h', tool: 'Read', at: 1, args: { get file_path(): string { throw new Error('boom') } } }
  const h = check(explainTool(hostileArgs as unknown as ToolObs, CTX))
  assert.equal(h.headline, 'Using Read')
})

test('odd input: broken ends', () => {
  const s = explain('Read', { file_path: 'a.py' })
  for (const end of [null, undefined, 7, {}, { status: 'weird', preview: 5, at: Number.NaN }, { status: 'ok', preview: null, at: 'x' }]) {
    const e = check(applyEnd(s, end as never, CTX))
    assert.ok(Number.isFinite(e.endedAt))
  }
  assert.equal(applyEnd(null as unknown as Step, { id: 'x', status: 'ok', preview: '', at: 1 }, CTX), null)
  const broken = { ...s, scene: null } as unknown as Step
  assert.doesNotThrow(() => applyEnd(broken, { id: s.id, status: 'ok', preview: 'x', at: 3 }, CTX))
})

test('odd input: control characters and newlines never reach the text fields', () => {
  const nasty = 'line one\nline two\t\u0007bell\u001b[31mred\u001b[0m\u202eevil'
  for (const tool of ['Bash', 'Read', 'Edit', 'Write', 'Agent', 'WebSearch', 'AskUserQuestion', 'TodoWrite']) {
    const s = explain(tool, {
      command: nasty, description: nasty, file_path: `/x/${nasty}.py`, old_string: nasty, new_string: nasty, content: nasty,
      query: nasty, questions: [{ question: nasty }], todos: [{ content: nasty, status: 'in_progress', activeForm: nasty }],
    })
    assert.ok(!/[\u202e\u001b]/.test(s.headline + s.why + (s.detail ?? '')), s.headline)
    check(finish(s, 'error', nasty))
  }
})

test('speed: a mixed batch averages well under 1 ms per call', () => {
  const calls: [string, unknown][] = [
    ['Read', { file_path: '/home/ana/shop/src/login.py', offset: 10, limit: 50 }],
    ['Edit', { file_path: '/home/ana/shop/src/login.py', old_string: lines(30), new_string: lines(35, 'row') }],
    ['Write', { file_path: '/home/ana/shop/notes.md', content: lines(200) }],
    ['Bash', { command: "cd /home/ana/shop && sed -n '1,200p' src/login.py | grep -n def | head -20", description: 'Find functions' }],
    ['Grep', { pattern: 'def (get|set)_\\w+', path: '/home/ana/shop/src' }],
    ['TodoWrite', { todos: Array.from({ length: 10 }, (_, i) => ({ content: `step ${i}`, status: 'pending', activeForm: 'x' })) }],
    ['mcp__claude_ai_Claude_Docs__update', { ref: { id: 'x' } }],
  ]
  const readPaths = Array.from({ length: 300 }, (_, i) => `/home/ana/shop/f${i}.py`)
  const ctx: ExplainCtx = { ...CTX, readPaths }
  const n = 1_400
  const t0 = performance.now()
  for (let i = 0; i < n; i++) {
    const [tool, args] = calls[i % calls.length] as [string, unknown]
    const s = explainTool(mkObs(tool, args), ctx)
    applyEnd(s, { id: s.id, status: i % 5 === 0 ? 'error' : 'ok', preview: '1\tx\n2\ty\nExit code 1', at: 2 }, ctx)
  }
  const mean = (performance.now() - t0) / n
  assert.ok(mean < 1, `mean ${mean.toFixed(3)} ms per call`)
})
