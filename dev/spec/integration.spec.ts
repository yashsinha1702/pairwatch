// Cross-module integration: the detectors, the knowledge base, the timeline, the pane's words and
// the stage agree with each other. Every other spec tests one module (often with fakes); this one
// runs the real modules together on synthetic sessions.
// Run: node --test dev/spec/integration.spec.ts
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Concept, Level, Prefs, RawEvent, SceneData, SessionModel, Station, Step, ToolEnd, ToolObs } from '../../pairwatch/types'
import { analyzeBash } from '../../pairwatch/hooks/core/bash.ts'
import { CONCEPT_IDS, isConceptId } from '../../pairwatch/hooks/core/concept-ids.ts'
import { CONCEPTS, getConcept } from '../../pairwatch/hooks/core/concepts.ts'
import { applyEnd, explainTool } from '../../pairwatch/hooks/core/explain.ts'
import type { ExplainCtx } from '../../pairwatch/hooks/core/explain.ts'
import { lessonMarkdown, nextLesson, pickLesson } from '../../pairwatch/hooks/core/lessons.ts'
import { buildNarrationPrompt, rulesNarration } from '../../pairwatch/hooks/core/narrate.ts'
import { renderStage } from '../../pairwatch/hooks/core/stage.ts'
import { RAIL_STOP, verbFor } from '../../pairwatch/hooks/core/stations.ts'
import { paneText, statusLine } from '../../pairwatch/hooks/core/text.ts'
import { currentActivity, emptyModel, reduce, settleHop, stepsOf } from '../../pairwatch/hooks/core/timeline.ts'
import { clockText, elapsedText, freshKey, stageInput } from '../../pairwatch/hooks/core/view.ts'
import { ANSWER, CWD, GOAL, MAIN_CALLS, SCENARIO, SUB, T0 } from './scenario.fixtures.ts'

// ------------------------------------------------------------------ helpers

const SCENE_OF: Record<Station, SceneData['kind']> = {
  think: 'think', plan: 'plan', search: 'search', read: 'read', edit: 'edit', run: 'run', web: 'web',
  delegate: 'delegate', tools: 'tools', ask: 'ask', talk: 'talk', done: 'done', idle: 'idle',
}
const CTX: ExplainCtx = { level: 1, cwd: '/home/dev/shop', readPaths: ['/home/dev/shop/src/app.py'] }
const PREFS: Prefs = { level: 1, isPaused: false, useModel: true, autoOpen: true }
let seq = 0
const obs = (tool: string, args: { [k: string]: unknown }, agentId?: string): ToolObs => ({
  id: `toolu_int_${++seq}`,
  tool,
  args,
  at: T0 + seq,
  ...(agentId === undefined ? {} : { agentId }),
})

/** Contract limits every step keeps, whichever module last touched it. */
function checkStep(s: Step, where: string): void {
  assert.ok(s.headline.length > 0 && s.headline.length <= 90, `${where}: headline ${JSON.stringify(s.headline)}`)
  assert.ok(s.why.length <= 170, `${where}: why ${s.why.length}`)
  if (s.detail !== undefined) assert.ok(s.detail.length <= 40, `${where}: detail ${JSON.stringify(s.detail)}`)
  if (s.resultNote !== undefined) assert.ok(s.resultNote.length <= 120, `${where}: resultNote ${JSON.stringify(s.resultNote)}`)
  assert.equal(s.scene.kind, SCENE_OF[s.station], `${where}: scene ${s.scene.kind} at station ${s.station}`)
  for (const c of s.concepts) {
    assert.ok(isConceptId(c), `${where}: ${c} is not a registry id`)
    assert.ok(getConcept(c) !== undefined, `${where}: no card for ${c}`)
  }
}

/** Fold events the way the pump does: a batch every 400 ms, then settleHop. Returns every state seen. */
function play(events: readonly RawEvent[], level: Level = 1): { model: SessionModel; states: { now: number; model: SessionModel }[] } {
  const at = (e: RawEvent): number => (e.kind === 'tool-start' ? e.obs.at : e.kind === 'tool-end' ? e.end.at : e.at)
  const queue = [...events].sort((a, b) => at(a) - at(b))
  let model = emptyModel(T0)
  const states: { now: number; model: SessionModel }[] = []
  const last = at(queue[queue.length - 1]!) + 3_000
  for (let now = T0; now <= last; now += 400) {
    const batch: RawEvent[] = []
    while (queue.length > 0 && at(queue[0]!) <= now) batch.push(queue.shift()!)
    const next = settleHop(reduce(model, batch, { level, now, cwd: CWD }), now)
    if (next !== model) states.push({ now, model: next })
    model = next
  }
  return { model, states }
}

// ------------------------------------------------------------------ a varied set of tool calls

const ok = (preview: string): Partial<ToolEnd> => ({ status: 'ok', preview })
const err = (preview: string): Partial<ToolEnd> => ({ status: 'error', preview })

/** Every tool family, with typical endings (results paraphrased, not copied from any session). */
const CALLS: { tool: string; args: { [k: string]: unknown }; end?: Partial<ToolEnd> }[] = [
  { tool: 'Read', args: { file_path: '/home/dev/shop/src/app.py' }, end: ok('     1\timport flask\n     2\tapp = flask.Flask(__name__)') },
  { tool: 'Read', args: { file_path: '/home/dev/shop/src/app.py', offset: 120, limit: 80 } },
  { tool: 'Read', args: { file_path: '/home/dev/shop/README.md' }, end: err('File does not exist.') },
  { tool: 'Read', args: { file_path: '/home/dev/shop/.env' } },
  { tool: 'Read', args: { file_path: '/home/dev/shop/docs/design.pdf', pages: '1-3' } },
  { tool: 'Read', args: { file_path: '/home/dev/shop/shot.png' } },
  { tool: 'Read', args: { file_path: '/home/dev/shop/notebooks/eda.ipynb' } },
  { tool: 'Read', args: { file_path: '/home/dev/shop/logs/server.log' } },
  { tool: 'Read', args: { file_path: '/home/dev/.claude/projects/shop/memory/MEMORY.md' } },
  { tool: 'Read', args: { file_path: '/home/dev/shop/.claude/skills/deploy/SKILL.md' } },
  { tool: 'Read', args: { file_path: '/home/dev/shop/package.json' } },
  { tool: 'Read', args: { file_path: '/home/dev/shop/pyproject.toml' } },
  { tool: 'Read', args: { file_path: '/home/dev/shop/docker-compose.yml' } },
  { tool: 'Read', args: { file_path: '/home/dev/shop/Dockerfile' } },
  { tool: 'Read', args: { file_path: '/home/dev/shop/data/rows.csv' } },
  { tool: 'Read', args: { file_path: '/home/dev/shop/data/events.jsonl' } },
  { tool: 'Read', args: { file_path: '/home/dev/shop/models/adapter.safetensors' } },
  { tool: 'Read', args: { file_path: '/home/dev/shop/audio/take1.wav' } },
  { tool: 'Edit', args: { file_path: '/home/dev/shop/src/app.py', old_string: 'a = 1\nb = 2', new_string: 'a = 1\nb = 3' }, end: ok('The file has been updated successfully.') },
  { tool: 'Edit', args: { file_path: '/home/dev/shop/src/app.py', old_string: 'x', new_string: 'y' }, end: err('<tool_use_error>String to replace not found in file.</tool_use_error>') },
  { tool: 'Edit', args: { file_path: '/home/dev/shop/src/app.py', old_string: 'getUser', new_string: 'fetchUser', replace_all: true } },
  { tool: 'Edit', args: { file_path: '/home/dev/shop/src/app.py', old_string: 'q', new_string: 'r' }, end: err("The user doesn't want to proceed with this tool use. The tool use was rejected.") },
  { tool: 'MultiEdit', args: { file_path: '/home/dev/shop/src/app.py', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd\ne' }] } },
  { tool: 'Write', args: { file_path: '/home/dev/shop/tests/test_app.py', content: 'def test_ok():\n    assert True\n' } },
  { tool: 'Write', args: { file_path: '/home/dev/shop/src/app.py', content: 'print(1)\n' } },
  { tool: 'Write', args: { file_path: '/home/dev/shop/.gitignore', content: '.venv/\n' } },
  { tool: 'NotebookEdit', args: { notebook_path: '/home/dev/shop/notebooks/eda.ipynb', new_source: 'df.head()', cell_type: 'code', edit_mode: 'insert' } },
  { tool: 'Agent', args: { description: 'Survey the auth module', subagent_type: 'Explore', prompt: 'Look around' }, end: ok('The auth module has three views.') },
  { tool: 'Agent', args: { description: 'Review the diff', subagent_type: 'general-purpose', run_in_background: true, prompt: 'Review' }, end: ok('Async agent launched successfully.') },
  { tool: 'Task', args: { description: 'Find flaky tests', subagent_type: 'general-purpose', prompt: 'Find them' } },
  { tool: 'Workflow', args: { script: "export const meta = { name: 'review', description: 'Review every package in parallel' }\n" }, end: ok('Workflow launched in background.') },
  { tool: 'TodoWrite', args: { todos: [{ content: 'Read the code', status: 'completed', activeForm: 'Reading the code' }, { content: 'Fix it', status: 'in_progress', activeForm: 'Fixing it' }] } },
  { tool: 'TaskCreate', args: { subject: 'Write the migration' } },
  { tool: 'TaskUpdate', args: { subject: 'Write the migration', status: 'completed' } },
  { tool: 'TaskList', args: {} },
  { tool: 'EnterPlanMode', args: {} },
  { tool: 'ExitPlanMode', args: { plan: '# Fix the redirect\n## Find the view\n## Keep next=\n' }, end: ok('User has approved your plan.') },
  { tool: 'AskUserQuestion', args: { questions: [{ question: 'Keep the old route?', header: 'Routes', options: [] }] }, end: ok('User has answered your questions: "Keep the old route?"="Yes, for now". You can now continue.') },
  { tool: 'WebSearch', args: { query: 'flask safe redirect next parameter' }, end: ok('Links: [{"title":"a","url":"https://x.dev/a"},{"title":"b","url":"https://x.dev/b"}]') },
  { tool: 'WebFetch', args: { url: 'https://docs.python.org/3/library/urllib.parse.html', prompt: 'How to parse a URL' }, end: ok('# urllib.parse\nParse URLs into components.') },
  { tool: 'WebFetch', args: { url: 'http://localhost:8080/health', prompt: 'Is it up?' }, end: err('Request failed with status code 503') },
  { tool: 'Skill', args: { skill: 'pdf', args: 'report.pdf' } },
  { tool: 'ToolSearch', args: { query: 'select:Monitor,WebFetch', max_results: 2 }, end: ok('<tool_reference>Monitor</tool_reference><tool_reference>WebFetch</tool_reference>') },
  { tool: 'ToolSearch', args: { query: 'notebook jupyter', max_results: 5 } },
  { tool: 'Monitor', args: { description: 'training loss and errors', command: 'tail -f train.log | grep --line-buffered -E "loss|Error"', timeout_ms: 600000 }, end: ok('Monitor started.') },
  { tool: 'TaskStop', args: { task_id: 'bg_12' }, end: ok('{"message":"Successfully stopped task: bg_12 (python3 train.py)"}') },
  { tool: 'TaskOutput', args: { task_id: 'bg_12' } },
  { tool: 'ScheduleWakeup', args: { delaySeconds: 300, reason: 'check the training run' } },
  { tool: 'CronCreate', args: { cron: '*/10 * * * *', prompt: 'check the queue', recurring: true } },
  { tool: 'SendMessage', args: { to: 'reviewer', summary: 'the diff is ready', message: 'Please review.' } },
  { tool: 'SubagentHandback', args: { message: 'Found two callers.' } },
  { tool: 'ListAgents', args: {} },
  { tool: 'StructuredOutput', args: { summary: 'All checks pass', verdict: 'ok' } },
  { tool: 'Artifact', args: { action: 'publish', title: 'Weekly report', file_path: '/tmp/report.html' } },
  { tool: 'ArtifactData', args: { action: 'query', collection: 'rows', url: 'https://claude.ai/artifact/x' } },
  { tool: 'memory_read', args: { path: '/memories/notes.md' } },
  { tool: 'memory_write', args: { path: '/memories/notes.md', content: 'A fact.\n' } },
  { tool: 'memory_list', args: {} },
  { tool: 'EnterWorktree', args: { name: 'fix-redirect' } },
  { tool: 'ExitWorktree', args: { action: 'keep' } },
  { tool: 'Grep', args: { pattern: 'handleLogin\\(', path: '/home/dev/shop/src' }, end: ok('src/a.py:3:handleLogin(x)\nsrc/b.py:9:handleLogin(y)') },
  { tool: 'Glob', args: { pattern: '**/*.py' }, end: ok('src/a.py\nsrc/b.py') },
  { tool: 'LS', args: { path: '/home/dev/shop' } },
  { tool: 'LSP', args: { operation: 'goToDefinition', filePath: '/home/dev/shop/src/app.py' } },
  { tool: 'SendUserFile', args: { files: ['/home/dev/shop/report.md'] } },
  { tool: 'ReportFindings', args: { findings: [{ file: 'a.py', summary: 'x' }] } },
  { tool: 'mcp__github__search_issues', args: { query: 'login redirect' }, end: ok('3 issues') },
  { tool: 'mcp__claude_ai_Claude_Docs__update', args: { ref: { object: 'node', id: 'n1' }, payload: 'x' } },
  { tool: 'enable__mcp__remote-devices__Claude_Browser', args: {} },
  { tool: 'SomeBrandNewTool', args: { anything: 1 } },
]

/** Shell commands across the analyser's categories (made up, in the style real sessions use). */
const COMMANDS: string[] = [
  'git status --short', 'git diff --stat', 'git log --oneline -10', 'git add -A && git commit -m "Keep next= on login redirect"',
  'git push origin main', 'git pull --rebase', 'git checkout -b fix/redirect', 'git stash && git stash pop', 'git merge main',
  'git rebase -i HEAD~3', 'git blame -L 10,20 src/app.py', 'git show HEAD:src/app.py | head -40', 'gh pr create --fill', 'gh run list',
  'python3 scripts/report.py --since 7d', "python3 -c 'import sys; print(sys.version)'", "python3 - <<'EOF'\nimport json\nprint(json.load(open('a.json')))\nEOF",
  'python -m pytest -q', 'pytest tests/test_app.py -k redirect -x', 'pip install -r requirements.txt', 'uv sync', 'uv run pytest',
  'python3 -m venv .venv && . .venv/bin/activate', 'conda activate ml && python train.py', 'node scripts/build.js', 'npm test', 'npm run build',
  'npm install', 'npx tsc --noEmit', 'npx eslint src', 'docker ps', 'docker build -t shop .', 'docker compose up -d db', 'docker logs -f web',
  'docker exec -it web bash', "sqlite3 app.db 'SELECT count(*) FROM users'", 'psql -c "select 1"', 'curl -s https://api.example.com/v1/health',
  'curl -s -H "Authorization: Bearer $API_TOKEN" https://api.example.com/v1/me | jq .', 'wget -q https://example.com/data.csv',
  'curl -sf localhost:8080/ready || echo down', 'ffmpeg -i talk.m4a -ar 16000 -ac 1 talk.wav', 'ffprobe -hide_banner talk.wav', 'nvidia-smi',
  'nvidia-smi --query-gpu=memory.used,memory.total --format=csv', 'ssh box "uptime"', 'scp a.txt box:/tmp/', 'rsync -avn src/ backup/',
  'tar -czf logs.tgz logs/', 'tar -tzf logs.tgz | head', 'unzip -l archive.zip', 'zstd -d data.zst', 'chmod +x run.sh', 'ln -s ../shared shared',
  'mkdir -p out/logs', 'cp config.yaml config.yaml.bak', 'mv old.txt new.txt', 'rm -rf build dist', 'ps aux | grep python', 'pgrep -fl uvicorn',
  'kill -TERM 4242', 'pkill -f train.py', 'nohup python3 serve.py > serve.log 2>&1 &', 'tmux new -d -s train "python train.py"',
  'systemctl status nginx', 'lsof -i :8080', 'ss -ltnp', 'df -h', 'du -sh * | sort -h | tail', 'free -h', 'nproc', 'date -u +%FT%TZ',
  'which python3', 'env | grep -i proxy', 'export PATH="$HOME/.local/bin:$PATH"', 'source .env', 'sleep 30',
  'until curl -sf localhost:8080/health; do sleep 2; done', 'timeout 60 python3 slow.py', 'for f in *.wav; do ffprobe "$f"; done',
  'while true; do nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader; sleep 30; done', 'find . -name "*.py" -newer setup.py',
  'find src -type f | wc -l', 'grep -rn "TODO" src/', 'rg -n "def main" --type py', 'grep -c ERROR logs/server.log',
  "sed -n '10,40p' src/app.py", "sed -i 's/DEBUG = True/DEBUG = False/' settings.py", "awk -F, '{print $2}' data.csv | sort | uniq -c",
  'cut -d: -f1 /etc/passwd | sort', "tr -d '\\r' < in.txt > out.txt", 'diff -u a.txt b.txt', 'head -20 README.md', 'tail -n 50 logs/server.log',
  'tail -f logs/server.log', 'cat src/app.py', 'wc -l src/*.py', 'ls -la', 'tree -L 2', "cat > notes.md <<'EOF'\n# Notes\nEOF",
  'echo "PORT=8080" >> .env.local', 'make test', 'cargo build --release', 'go test ./...', 'set -euo pipefail; ./deploy.sh',
  'xargs -n1 echo < list.txt', 'tee build.log < output.txt', 'jq ".items | length" data.json', 'huggingface-cli download gpt2',
  'sudo dnf install -y ffmpeg', 'claude -p "summarise the diff"', 'cd src && ls', 'echo $HOME', 'true',
]

// ------------------------------------------------------------------ the knowledge base and the registry

describe('the knowledge base and the registry', () => {
  test('every registry id has exactly one card, and every card is a registry id', () => {
    const cards = Object.values(CONCEPTS)
    assert.equal(cards.length, CONCEPT_IDS.length)
    for (const id of CONCEPT_IDS) assert.ok(getConcept(id) !== undefined, `no card for ${id}`)
    for (const c of cards) assert.ok(isConceptId(c.id), `card ${c.id} is not in the registry`)
  })

  test('related ids point at real cards', () => {
    for (const c of Object.values(CONCEPTS)) for (const r of c.related ?? []) assert.ok(getConcept(r) !== undefined, `${c.id} → ${r}`)
  })
})

// ------------------------------------------------------------------ detectors → cards

describe('every concept a detector can emit has a card', () => {
  test('explainTool and applyEnd over every tool family', () => {
    const emitted = new Set<string>()
    for (const call of CALLS) {
      const start = explainTool(obs(call.tool, call.args), CTX)
      checkStep(start, `${call.tool} start`)
      for (const c of start.concepts) emitted.add(c)
      const ends: Partial<ToolEnd>[] = [call.end ?? ok(''), err('Exit code 1\nboom'), { status: 'denied', preview: 'Permission to use it has been denied.' }]
      for (const e of ends) {
        const done = applyEnd(start, { id: start.id, status: e.status ?? 'ok', preview: e.preview ?? '', at: start.startedAt + 500 }, CTX)
        checkStep(done, `${call.tool} end ${e.status}`)
        for (const c of done.concepts) emitted.add(c)
      }
    }
    assert.ok(emitted.size >= 45, `only ${emitted.size} distinct concepts from the tool set`)
  })

  test('Bash: analyzeBash and the Bash step, for every kind of command', () => {
    const emitted = new Set<string>()
    for (const command of COMMANDS) {
      const a = analyzeBash(command)
      for (const c of a.concepts) {
        assert.ok(isConceptId(c) && getConcept(c) !== undefined, `${command}: ${c}`)
        emitted.add(c)
      }
      const step = explainTool(obs('Bash', { command, description: 'Do the thing' }), CTX)
      checkStep(step, `Bash ${command}`)
      for (const c of step.concepts) emitted.add(c)
      for (const [status, preview] of [['ok', 'done\n'], ['error', 'Exit code 2\nsomething failed']] as const) {
        const done = applyEnd(step, { id: step.id, status, preview, at: step.startedAt + 900 }, CTX)
        checkStep(done, `Bash ${command} ${status}`)
      }
    }
    assert.ok(emitted.size >= 90, `only ${emitted.size} distinct concepts from the shell commands`)
  })

  test('the timeline’s own concepts (prompts, thinking, permissions, agent craft, the recap) have cards', () => {
    const { model } = play([
      ...SCENARIO,
      { kind: 'prompt', text: '<task-notification><summary>Build finished</summary></task-notification>', origin: 'task-notification', at: T0 + 40_000 },
      { kind: 'tool-start', obs: { id: 'toolu_rm', tool: 'Bash', args: { command: 'rm -rf build' }, at: T0 + 41_000 } },
      { kind: 'permission', id: 'toolu_rm', tool: 'Bash', at: T0 + 41_100 },
      { kind: 'tool-end', end: { id: 'toolu_rm', status: 'denied', preview: 'Permission to use Bash has been denied.', at: T0 + 44_000 } },
      { kind: 'turn-end', turnId: 'turn-2', durationMs: 5_000, answer: 'Stopped.', reason: 'aborted', at: T0 + 45_000 },
    ])
    const seen = new Set<string>()
    for (const s of model.steps) {
      checkStep(s, s.id)
      for (const c of s.concepts) seen.add(c)
    }
    for (const id of ['tool-calls', 'thinking', 'todo-planning', 'read-before-edit', 'subagents', 'verify-after-change', 'code-review', 'permissions']) {
      assert.ok(seen.has(id), `the session never taught ${id}`)
    }
  })
})

// ------------------------------------------------------------------ the timeline uses explain

describe('the timeline uses explain correctly', () => {
  const { model, states } = play(SCENARIO)
  const step = (id: string): Step => {
    const s = model.steps.find(x => x.id === id)
    assert.ok(s !== undefined, `no step ${id}`)
    return s
  }

  test('each main-loop call is the step explainTool made of it, ended by applyEnd', () => {
    for (const id of MAIN_CALLS) {
      const s = step(id)
      const ev = SCENARIO.find((e): e is Extract<RawEvent, { kind: 'tool-start' }> => e.kind === 'tool-start' && e.obs.id === id)!
      const fresh = explainTool(ev.obs, { level: 1, cwd: CWD })
      assert.equal(s.tool, fresh.tool)
      assert.equal(s.station, fresh.station, id)
      assert.equal(s.target, fresh.target, `${id}: target`)
      assert.ok(s.status !== 'running', `${id} ended`)
      for (const c of fresh.concepts) assert.ok(s.concepts.includes(c), `${id} lost ${c}`)
      checkStep(s, id)
    }
    assert.equal(step('toolu_grep').target, 'grep -rn "redirect(" src/ --include=*.py', 'a Bash step keeps its raw command')
    assert.equal(step('toolu_grep').headline, 'Find where redirects are built', 'the description is the headline')
  })

  test('results flow through: the failure, its note, and the stats', () => {
    const failed = step('toolu_test1')
    assert.equal(failed.status, 'error')
    assert.match(failed.resultNote ?? '', /FAILED tests\/test_auth\.py::test_login_keeps_next/)
    assert.equal(failed.scene.kind === 'run' ? failed.scene.output : '', '1 failed, 4 passed in 0.42s')
    assert.equal(step('toolu_test2').status, 'ok')
    assert.equal(step('toolu_grep').scene.kind === 'search' ? step('toolu_grep').scene : undefined, step('toolu_grep').scene)
    assert.deepEqual(
      { steps: model.stats.steps, edits: model.stats.edits, commands: model.stats.commands, errors: model.stats.errors, turns: model.stats.turns },
      { steps: 11, edits: 1, commands: 5, errors: 1, turns: 1 },
    )
  })

  test('agent craft lands on the right steps', () => {
    assert.ok(step('toolu_edit').concepts.includes('read-before-edit'), 'the edit follows a read of the same file')
    assert.ok(step('toolu_edit').concepts.includes('learning-from-errors'), 'the edit follows the failed run')
    assert.ok(step('toolu_test2').concepts.includes('verify-after-change'), 'the suite runs after the edit')
    assert.ok(step('toolu_read2').concepts.includes('parallel-tool-calls'), 'two reads in flight at once')
  })

  test('the sub-agent’s calls sit in its own lane; the delegation is what the stage shows', () => {
    for (const id of ['toolu_sub1', 'toolu_sub2']) assert.equal(step(id).agentId, SUB)
    const during = states.find(s => s.now >= T0 + 15_000)!.model
    const act = currentActivity(during)!
    assert.equal(act.station, 'delegate')
    assert.equal(act.agentId, undefined)
    const lane = during.agents.find(l => l.id === SUB)!
    assert.equal(lane.type, 'Explore')
    assert.equal(lane.doing, 'Find other hard-coded home redirects')
  })

  test('a refusal explain recognises is a refusal everywhere: denied, not an error', () => {
    const { model: m } = play([
      { kind: 'prompt', text: 'run it', origin: 'composer', at: T0 },
      { kind: 'turn-start', turnId: 't', at: T0 + 10 },
      { kind: 'tool-start', obs: { id: 'a', tool: 'Bash', args: { command: 'pytest -q', description: 'Run the tests' }, at: T0 + 100 } },
      { kind: 'tool-end', end: { id: 'a', status: 'error', preview: '[Request interrupted by user for tool use]', at: T0 + 900 } },
    ])
    const a = m.steps.find(s => s.id === 'a')!
    assert.equal(a.status, 'denied')
    assert.equal(a.resultNote, 'You stopped this')
    assert.equal(m.stats.errors, 0)
  })

  test('the recap counts the whole turn', () => {
    const done = model.steps.find(s => s.tool === '#done')!
    assert.deepEqual(done.scene, { kind: 'done', steps: 11, files: 3, seconds: 26, errors: 1 })
    assert.match(done.headline, /^Done: 11 steps, 3 files in 26s$/)
    assert.equal(model.said?.text, ANSWER)
    assert.equal(model.goal?.text, GOAL)
  })
})

// ------------------------------------------------------------------ the words and the cards

describe('text and lessons render real cards', () => {
  test('every card at every depth and level: a titled Markdown card, its try-it and related titles', () => {
    for (const c of Object.values(CONCEPTS) as Concept[]) {
      for (const level of [1, 2, 3] as const) {
        for (const depth of [0, 1, 2] as const) {
          const md = lessonMarkdown(c, depth, level)
          assert.ok(md.startsWith('💡 **'), `${c.id} ${level}/${depth}`)
          assert.ok(!/(?<!\\)<[a-z/!]/i.test(md.replace(/`[^`]*`/g, '')), `${c.id}: raw markup`)
          if (level < 3 && depth === 2 && c.tryIt !== undefined) assert.ok(md.includes('Try it: `'), `${c.id}: try it`)
          if (level < 3 && depth === 2 && (c.related ?? []).length > 0) {
            assert.ok(md.includes('Related: '), `${c.id}: related`)
            for (const r of c.related ?? []) assert.ok(md.includes(getConcept(r)!.title.replace(/[\\`*_[\]<>~]/g, '\\$&')), `${c.id}: related ${r}`)
          }
        }
      }
      const shown = paneText({ model: emptyModel(T0), narration: null, lesson: { conceptId: c.id, depth: 1, shownAt: T0 }, prefs: PREFS, ask: { status: 'idle' }, now: T0 }).lesson
      assert.equal(shown, lessonMarkdown(c, 1, 1), `${c.id} in the pane`)
    }
  })

  test('each activity of the turn gets a fitting card at every level, and Another tip finds a different one', () => {
    const { model } = play(SCENARIO)
    for (const level of [1, 2, 3] as const) {
      let found = 0
      for (const act of model.activities) {
        const candidates = [...new Set(stepsOf(model, act).reverse().flatMap(s => s.concepts))]
        const id = pickLesson(candidates, { level, known: new Set(), seen: {}, now: T0, recent: [] })
        if (id === undefined) continue
        found++
        assert.ok(candidates.includes(id) && getConcept(id) !== undefined, `${act.headline}: ${id}`)
        const other = nextLesson(id, candidates, { level, known: new Set(), seen: {}, now: T0, recent: [id] })
        assert.ok(other !== undefined && other !== id && getConcept(other) !== undefined, `another tip after ${id}`)
      }
      // experts see only expert cards and unseen intermediate ones, so a basic step may have none for them
      const want = level === 3 ? Math.ceil(model.activities.length / 3) : model.activities.length - 2
      assert.ok(found >= want, `level ${level}: cards for ${found} of ${model.activities.length} activities`)
    }
  })

  test('the pane’s words follow the turn: headline, narration with the failure, recap', () => {
    const { states } = play(SCENARIO)
    const at = (ms: number) => states.filter(s => s.now <= T0 + ms).at(-1)!
    const words = (ms: number) => {
      const s = at(ms)
      return paneText({ model: s.model, narration: null, lesson: null, prefs: PREFS, ask: { status: 'idle' }, now: s.now })
    }
    assert.match(words(4_100).nowLine, /^🔎 \*\*Find where redirects are built\*\*/)
    const reading = at(4_900)
    assert.equal(paneText({ model: reading.model, narration: null, lesson: null, prefs: PREFS, ask: { status: 'idle' }, now: reading.now, cwd: CWD }).nowLine, '📖 **Reading login.py** · `src/auth/login.py`', 'a path relative to the project')
    assert.match(words(9_000).nowLine, /^▶️ \*\*Run the auth tests to reproduce the failure\*\*/)
    assert.match(words(12_000).narration, /FAILED tests\/test\\_auth\.py::test\\_login\\_keeps\\_next/)
    assert.match(words(15_000).nowLine, /^🤝 \*\*Delegating to a sub-agent: Check other views/)
    assert.match(words(29_000).nowLine, /^✅ \*\*Done: 11 steps, 3 files in 26s\*\*/)
    assert.match(statusLine(at(12_000).model, null), /^▶️ Run the auth tests to reproduce the failure — FAILED/)
  })

  test('the narrator prompt names the goal and the current activity, within its budget', () => {
    const { states } = play(SCENARIO)
    for (const { model, now } of states) {
      const act = currentActivity(model)
      if (act === undefined) continue
      const p = buildNarrationPrompt(model, act, 1, now)
      assert.ok(p.length <= 6000)
      assert.match(p, /^LEVEL: beginner/)
      assert.ok(p.includes('GOAL: “After I sign in'), 'the goal')
      assert.ok(p.includes(`CURRENT: ${act.headline.slice(0, 40)}`), act.headline)
      assert.equal(rulesNarration(model, act, now).activityId, act.id)
    }
  })
})

// ------------------------------------------------------------------ the stage draws what the timeline produces

describe('the stage draws what the timeline produces (view.ts → stage.ts)', () => {
  const { states } = play(SCENARIO)

  test('every state of the turn draws a whole, safe frame of the right station', () => {
    assert.ok(states.length >= 25, `${states.length} states`)
    for (const { model, now } of states) {
      const input = stageInput(model, PREFS, now, CWD)
      const act = currentActivity(model)
      assert.equal(input.station, act?.station ?? 'idle')
      assert.equal(input.scene.kind, SCENE_OF[input.station], `${input.station} draws ${input.scene.kind}`)
      assert.ok(input.trail.length <= 38)
      const svg = renderStage(input)
      assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'), 'a whole document')
      assert.ok(svg.length < 60_000)
      assert.ok(!/NaN|undefined|\[object/.test(svg), 'no broken values')
      assert.ok(!/<script|foreignObject|\son[a-z]+=/i.test(svg), 'no script')
      assert.ok(svg.includes(verbFor(input.station, input.status)), `the verb for ${input.station}`)
    }
  })

  test('headers: the command, the file count, no repeated verb, the goal on the recap', () => {
    const at = (ms: number) => {
      const s = states.filter(x => x.now <= T0 + ms).at(-1)!
      return stageInput(s.model, PREFS, s.now, CWD)
    }
    assert.equal(at(4_100).title, 'grep -rn "redirect(" src/ --include=*.py')
    assert.equal(at(5_500).title, '2 files')
    assert.equal(at(13_300).title, 'src/auth/login.py', 'a path relative to the project')
    assert.equal(at(8_450).title, '', 'thinking shows its words in the scene, not after THINKING')
    assert.equal(at(29_000).title, GOAL)
    assert.equal(at(29_000).scene.kind, 'done')
  })

  test('intros play while a step is new and never while paused; the hop comes from the last stop', () => {
    let hops = 0
    for (const { model, now } of states) {
      const live = stageInput(model, PREFS, now, CWD)
      if (live.hopFrom !== undefined) {
        hops++
        assert.notEqual(RAIL_STOP[live.hopFrom] === RAIL_STOP[live.station] && live.hopFrom === live.station, true)
        assert.equal(live.isFresh, true)
      }
      const paused = stageInput(model, { ...PREFS, isPaused: true }, now, CWD)
      assert.equal(paused.isFresh, false)
      assert.ok(!renderStage(paused).includes('<animate'), 'a paused frame holds still')
    }
    assert.ok(hops >= 6, `${hops} hops`)
  })

  test('view.ts is total: odd models draw the idle stage, never throw', () => {
    const odd: unknown[] = [null, undefined, {}, { steps: 'x' }, { activities: [{ id: 'a', station: 'run', stepIds: ['gone'], headline: 'x', status: 'running', startedAt: 0 }], steps: [], agents: null, files: 3, stats: null }]
    for (const m of odd) {
      const input = stageInput(m as SessionModel, PREFS, T0, CWD)
      assert.ok(renderStage(input).startsWith('<svg'))
      assert.equal(typeof freshKey(m as SessionModel), 'string')
    }
    assert.equal(stageInput(null as unknown as SessionModel, PREFS, T0).station, 'idle')
    assert.deepEqual([clockText(42_000), clockText(187_000), clockText(3_900_000), clockText(Number.NaN)], ['42s', '3m 07s', '1h 05m', '0s'])
    assert.equal(elapsedText(emptyModel(T0)), '0s')
  })

  test('freshKey marks each new step on stage once', () => {
    const keys = states.map(s => freshKey(s.model)).filter(k => k !== '')
    const distinct = new Set(keys)
    assert.ok(distinct.size >= 10, `${distinct.size} distinct`)
    // the same step on stage keeps its key while only its status changes
    const run = states.filter(s => currentActivity(s.model)?.stepIds.includes('toolu_test1'))
    assert.equal(new Set(run.map(s => freshKey(s.model))).size, 1)
  })
})

// ------------------------------------------------------------------ secrets end to end

describe('no secret reaches anything Pairwatch shows, saves or sends (redact.ts at every door)', () => {
  // fake secrets, built in pieces so no scanner mistakes this file for one holding real keys
  const HF = 'hf' + '_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz012345'
  const GH = 'gh' + 'p_' + 'Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0FeDcBa'
  const ANT = 'sk-' + 'ant-api03-' + 'Qq1Ww2Ee3Rr4Tt5Yy6Uu7Ii8Oo9'
  const PW = 'Hunter2Pw'
  const SECRETS = [HF, GH, ANT, PW]
  /** The secret, or any 8 characters in a row of its random part. */
  const leaked = (text: string): string | undefined => {
    for (const s of SECRETS) {
      if (text.includes(s)) return s
      const body = s.replace(/^(?:hf_|ghp_|sk-ant-api03-)/, '')
      for (let i = 0; i + 8 <= body.length; i++) if (text.includes(body.slice(i, i + 8))) return `${s} (${body.slice(i, i + 8)})`
    }
    return undefined
  }
  const at = (s: number): number => T0 + s * 1000
  const start = (id: string, tool: string, args: { [k: string]: unknown }, s: number, agentId?: string): RawEvent =>
    ({ kind: 'tool-start', obs: { id, tool, args, at: at(s), ...(agentId === undefined ? {} : { agentId }) } })
  const end = (id: string, status: ToolEnd['status'], preview: string, s: number): RawEvent => ({ kind: 'tool-end', end: { id, status, preview, at: at(s) } })
  const events: RawEvent[] = [
    { kind: 'prompt', text: `Push the model with HF_TOKEN=${HF} and use the key ${ANT} for the API`, origin: 'user', at: at(0) },
    { kind: 'turn-start', turnId: 'turn-s', at: at(0) },
    { kind: 'think', text: `The token is ${GH}; I should not print it.`, at: at(1) },
    { kind: 'say', text: `I will log in with HF_TOKEN=${HF} first.`, at: at(2) },
    start('s1', 'Bash', { command: `HF_TOKEN=${HF} python3 push.py && mysql -u root -p${PW} -h db.local shop -e "select 1"` }, 3),
    end('s1', 'error', `Exit code 1\nERROR 1045: Access denied (password=${PW})\nwhile pushing with HF_TOKEN=${HF}`, 5),
    start('s2', 'Edit', { file_path: '/home/dev/shop/.env', old_string: 'API_KEY=', new_string: `API_KEY=${ANT}` }, 6),
    end('s2', 'ok', 'The file has been updated successfully.', 7),
    start('s3', 'WebFetch', { url: `https://api.example.com/v1/me?access_token=${GH}`, prompt: 'Who am I?' }, 8),
    end('s3', 'error', `Request failed: invalid token ${GH}`, 9),
    { kind: 'agent-start', agentId: 'ag1', type: 'general-purpose', description: `Rotate the leaked key ${ANT}`, toolUseId: 's4', background: false, at: at(10) },
    start('s4', 'Agent', { description: `Rotate the leaked key ${ANT}`, subagent_type: 'general-purpose', prompt: 'x' }, 10),
    start('a1', 'Bash', { command: `curl -s -H "Authorization: Bearer ${GH}" https://api.github.com/user` }, 11, 'ag1'),
    end('a1', 'ok', `{"login": "ana", "token": "${GH}"}`, 12),
    { kind: 'agent-stop', agentId: 'ag1', at: at(13) },
    end('s4', 'ok', `Rotated. The old key ${ANT} is revoked.`, 13),
    { kind: 'say', text: `Done: HF_TOKEN=${HF} worked and ${GH} is revoked.`, at: at(14) },
    { kind: 'turn-end', turnId: 'turn-s', durationMs: 15_000, answer: `All set. I used HF_TOKEN=${HF} and the key ${ANT}.`, reason: 'answer', at: at(15) },
  ]

  test('the model, the stage, the pane, the status line and the narrator prompt hold none of them, at every moment', () => {
    const { model, states } = play(events)
    assert.ok(states.length > 8, `${states.length} states`)
    for (const { now, model: m } of states) {
      const json = JSON.stringify(m)
      assert.equal(leaked(json), undefined, `model at +${now - T0} ms`)
      const svg = renderStage(stageInput(m, PREFS, now, CWD))
      assert.equal(leaked(svg), undefined, `stage at +${now - T0} ms`)
      const why = { status: 'answered' as const, text: `I exported HF_TOKEN=${HF} so the push can log in.\nLesson: keep keys in the environment.`, at: now }
      const pane = paneText({ model: m, narration: null, lesson: null, prefs: PREFS, ask: why, now, cwd: CWD })
      assert.equal(leaked(Object.values(pane).join('\n')), undefined, `pane at +${now - T0} ms`)
      assert.equal(leaked(statusLine(m, null)), undefined, `status line at +${now - T0} ms`)
      const act = currentActivity(m)
      if (act !== undefined) {
        assert.equal(leaked(buildNarrationPrompt(m, act, 2, now)), undefined, `narrator prompt at +${now - T0} ms`)
        assert.equal(leaked(JSON.stringify(rulesNarration(m, act, now))), undefined, `rules narration at +${now - T0} ms`)
      }
    }
    // and the labels stay, so the steps still read
    const json = JSON.stringify(model)
    for (const label of ['HF_TOKEN=••••', '-p••••', 'API_KEY=••••', 'Bearer ••••', 'sk-ant-••••']) assert.ok(json.includes(label), label)
  })
})
