// text.ts: the pane's Markdown and the one-line status. Run: node --test dev/spec/text.spec.ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AskState, Concept, Narration, Prefs, SessionModel, Step } from '../../pairwatch/types'
import { CONCEPTS } from '../../pairwatch/hooks/core/concepts.ts'
import { compactLabel, paneText, statusLine, WAITING_LINE } from '../../pairwatch/hooks/core/text.ts'
import type { PaneTextInput } from '../../pairwatch/hooks/core/text.ts'
import { emptyModel } from '../../pairwatch/hooks/core/timeline.ts'
import { E, fakeDeps, fullTurn, play, s, T0 } from './core.fixtures.ts'

const prefs: Prefs = { level: 1, isPaused: false, useModel: true, autoOpen: true }
const idle: AskState = { status: 'idle' }
const input = (model: SessionModel, o: Partial<PaneTextInput> = {}): PaneTextInput => ({ model, narration: null, lesson: null, prefs, ask: idle, now: T0, ...o })
const turn = fullTurn()
const running = play(turn.slice(0, 10)) // the first test run has started at 13 s
const failed = play(turn.slice(0, 11)) // ... and failed at 17 s
const finished = play(turn)

const KB: Record<string, Concept> = {
  grep: { id: 'grep', title: 'grep', category: 'shell', level: 1, short: 'grep finds lines that match a pattern.', why: 'It narrows a big codebase fast.', deeper: 'Add -r to search folders.', tryIt: 'grep -rn "TODO" src/', related: ['find'] },
  find: { id: 'find', title: 'find', category: 'shell', level: 1, short: 'find walks folders.', why: 'It locates files.', deeper: '', related: [] },
}

describe('paneText: shape across states', () => {
  it('before anything happens: the waiting line and nothing else', () => {
    assert.deepEqual(paneText(input(emptyModel(T0))), { nowLine: WAITING_LINE, narration: '', goalLine: '', lesson: '', askBlock: '', recent: '' })
    assert.equal(paneText(input(emptyModel(T0), { prefs: { ...prefs, isPaused: true } })).nowLine, `${WAITING_LINE} · *paused*`)
  })

  it('while a command runs: glyph, bold headline, the command as code, the running time after 5 s', () => {
    const early = paneText(input(running, { now: s(15) }))
    assert.equal(early.nowLine, '▶️ **Running the tests** · `pytest tests/test_auth.py -q`')
    const late = paneText(input(running, { now: s(25) }))
    assert.equal(late.nowLine, '▶️ **Running the tests** · `pytest tests/test_auth.py -q` (running 12s)')
    assert.equal(late.narration, 'Running the tests. Tests prove the change works.')
    assert.equal(late.goalLine, '🎯 *Goal:* After I sign in I land on a blank page. Fix the redirect.')
    assert.equal(late.recent, '✓ grep “redirect” · ✓ Read login.py · ✓ Read session.py · ✓ Edit login.py')
  })

  it('shows a short target only when the headline does not already say it', () => {
    const step = (headline: string, target: string) =>
      play([[E.turnStart('t', s(0)), E.prompt('x', s(0))], [E.start('b', 'Bash', { command: 'ls' }, s(1))]], {
        deps: { ...fakeDeps, explainTool: obs => ({ ...fakeDeps.explainTool(obs, { level: 1 }), headline, target }) },
      })
    const line = (headline: string, target: string) => paneText(input(step(headline, target), { now: s(2) })).nowLine
    assert.equal(line('Pytest tests/x.py', 'pytest tests/x.py'), '▶️ **Pytest tests/x.py**', 'same words, other case')
    assert.equal(line('Reading a file', '/proj/src/a.py'), '▶️ **Reading a file** · `/proj/src/a.py`')
    assert.equal(line('Reading a file', '/home/someone/projects/demo/src/auth/login_view.py'), '▶️ **Reading a file** · `…/src/auth/login_view.py`', 'a long path keeps its tail')
    assert.equal(line('Reading a file', 'x'.repeat(60)), '▶️ **Reading a file**', 'too long')
  })

  it('after a failure: the result in the rules narration and a ✗ in recent', () => {
    const t = paneText(input(failed, { now: s(18) }))
    assert.equal(t.nowLine, '▶️ **Running the tests** · `pytest tests/test_auth.py -q`', 'over: no running time')
    assert.equal(t.narration, 'Running the tests — FAILED tests/test\\_auth.py::test\\_redirect - AssertionError. Tests prove the change works.')
    assert.equal(t.recent, '✓ Read login.py · ✓ Read session.py · ✓ Edit login.py · ✗ pytest')
  })

  it('when the turn is done: the recap, and recent keeps to the last 4 finished steps', () => {
    const t = paneText(input(finished, { now: s(31) }))
    assert.equal(t.nowLine, '✅ **Done: 7 steps, 2 files in 30s**')
    assert.equal(t.recent, '✓ Edit login.py · ✗ pytest · ✓ Edit login.py · ✓ pytest')
  })

  it('a new turn starts a fresh recent list', () => {
    const next = play([[E.turnStart('turn-2', s(40)), E.prompt('Now add a test', s(40))]], { model: finished })
    assert.equal(paneText(input(next, { now: s(41) })).recent, '')
  })

  it('never throws on junk input', () => {
    assert.equal(paneText(null as unknown as PaneTextInput).nowLine, WAITING_LINE)
    assert.equal(paneText({} as PaneTextInput).nowLine, WAITING_LINE)
    const odd = paneText({ model: { steps: [], activities: [{ id: 'a', station: 'run', stepIds: [], headline: 'x', status: 'running', startedAt: 0 }] } as unknown as SessionModel, narration: null, lesson: null, prefs, ask: null as unknown as AskState, now: 1 })
    assert.equal(odd.askBlock, '')
    assert.equal(typeof odd.nowLine, 'string')
  })
})

describe('paneText: narration', () => {
  const current = failed.currentId!

  it('shows the model narration for the current activity', () => {
    const n: Narration = { activityId: current, now: 'The redirect test failed: the page still goes to “/”.', why: 'Claude will read the assertion and fix login.py.', source: 'model', at: 1 }
    assert.equal(paneText(input(failed, { narration: n })).narration, 'The redirect test failed: the page still goes to “/”. Claude will read the assertion and fix login.py.')
  })

  it('falls back to the rules when the narration is stale (another activity) or empty', () => {
    const stale: Narration = { activityId: 'something-else', now: 'Old news.', why: '', source: 'model', at: 1 }
    assert.match(paneText(input(failed, { narration: stale })).narration, /^Running the tests — FAILED/)
    const empty: Narration = { activityId: current, now: '  ', why: 'x', source: 'model', at: 1 }
    assert.match(paneText(input(failed, { narration: empty })).narration, /^Running the tests — FAILED/)
  })

  it('escapes Markdown and neutralises a block start', () => {
    const n: Narration = { activityId: current, now: '# Claude edits __init__.py and *.cfg files', why: '', source: 'model', at: 1 }
    assert.equal(paneText(input(failed, { narration: n })).narration, '\\# Claude edits \\_\\_init\\_\\_.py and \\*.cfg files')
  })
})

describe('paneText: goal line', () => {
  it('fits in 120 characters and escapes the goal', () => {
    const long = play([[E.turnStart('t', s(0)), E.prompt(`Fix *all* the __bugs__ in ${'src/module_name/'.repeat(30)}`, s(0))]])
    const g = paneText(input(long)).goalLine
    assert.ok(g.startsWith('🎯 *Goal:* Fix \\*all\\* the \\_\\_bugs\\_\\_'), g)
    assert.ok(g.length <= 120, `${g.length}`)
    assert.ok(g.endsWith('…'))
  })
})

describe('paneText: lesson', () => {
  it('renders the card at its depth and level, or nothing', () => {
    const base = input(failed, { concepts: KB })
    assert.equal(paneText({ ...base, lesson: { conceptId: 'grep', depth: 0, shownAt: 0 } }).lesson, '💡 **grep** · shell\n\ngrep finds lines that match a pattern. It narrows a big codebase fast.')
    const deep = paneText({ ...base, lesson: { conceptId: 'grep', depth: 2, shownAt: 0 } }).lesson
    assert.ok(deep.includes('Try it: `grep -rn "TODO" src/`'), deep)
    assert.ok(deep.endsWith('Related: find'), deep)
    assert.equal(paneText({ ...base, prefs: { ...prefs, level: 3 }, lesson: { conceptId: 'grep', depth: 0, shownAt: 0 } }).lesson, '💡 **grep** · shell\n\nIt narrows a big codebase fast.')
    assert.equal(paneText({ ...base, lesson: { conceptId: 'not-there', depth: 0, shownAt: 0 } }).lesson, '')
    assert.equal(paneText(base).lesson, '')
  })

  it('uses the real knowledge base by default', () => {
    const id = Object.keys(CONCEPTS)[0]
    const t = paneText(input(failed, { lesson: id === undefined ? null : { conceptId: id, depth: 0, shownAt: 0 } })).lesson
    if (id === undefined) assert.equal(t, '')
    else assert.ok(t.startsWith('💡 **'), t)
  })
})

describe('paneText: the "Why?" block', () => {
  const ask = (a: AskState) => paneText(input(failed, { ask: a })).askBlock

  it('asking', () => {
    assert.equal(ask({ status: 'asking', at: 1 }), '_Asking Claude why…_')
  })

  it('answered: a quote block with the Lesson line in bold', () => {
    const text = 'I ran the tests to check my fix.\n\n\nOne failed: the redirect still points at <root>.\n**Lesson:** run the tests right after every change.\n'
    assert.equal(ask({ status: 'answered', text, at: 1 }), '> I ran the tests to check my fix.\n>\n> One failed: the redirect still points at \\<root\\>.\n> **Lesson:** run the tests right after every change.')
    assert.equal(ask({ status: 'answered', text: '## Heading\nlesson: keep diffs small', at: 1 }), '> Heading\n> **Lesson:** keep diffs small')
  })

  it('failed: a dim note; idle: nothing', () => {
    assert.equal(ask({ status: 'failed', reason: 'nothing-to-fork', at: 1 }), '_Claude has not started yet, so there is nothing to ask about._')
    assert.equal(ask({ status: 'failed', reason: 'weird_thing', at: 1 }), '_No answer this time (weird\\_thing)._')
    assert.equal(ask(idle), '')
  })
})

describe('compactLabel', () => {
  const step = (o: Partial<Step>): Step => ({ id: 'x', tool: 'Bash', station: 'run', headline: 'Doing it', why: '', concepts: [], scene: { kind: 'idle' }, status: 'ok', startedAt: 0, ...o })

  it('names steps in a few words, escaping Markdown', () => {
    assert.equal(compactLabel(step({ tool: 'Read', scene: { kind: 'read', files: [{ path: '/p/src/my_module/__init__.py' }] } })), 'Read \\_\\_init\\_\\_.py')
    assert.equal(compactLabel(step({ scene: { kind: 'run', command: 'cd /p && FOO=1 python3 train_lora.py --epochs 3', category: 'run-script' } })), 'python3 train\\_lora.py')
    assert.equal(compactLabel(step({ scene: { kind: 'run', command: 'npm test', category: 'test', program: 'npm test' } })), 'npm test')
    assert.equal(compactLabel(step({ station: 'search', concepts: ['ripgrep'], scene: { kind: 'search', query: 'TODO' } })), 'rg “TODO”')
    assert.equal(compactLabel(step({ tool: 'Grep', station: 'search', scene: { kind: 'search', query: 'a*b' } })), 'grep “a\\*b”')
    assert.equal(compactLabel(step({ tool: 'WebFetch', station: 'web', scene: { kind: 'web', url: 'https://docs.python.org/3/', domain: 'docs.python.org' } })), 'fetch docs.python.org')
    assert.equal(compactLabel(step({ tool: 'mcp__github__create_issue', station: 'tools', scene: { kind: 'tools', name: 'mcp__github__create_issue' } })), 'create\\_issue')
  })
})

describe('statusLine', () => {
  it('is one line of at most 160 characters', () => {
    for (const m of [running, failed, finished]) {
      const line = statusLine(m, null)
      assert.ok(line.length <= 160, line)
      assert.ok(!line.includes('\n'))
    }
  })

  it('glyph + headline + why while running, + the result when over', () => {
    assert.equal(statusLine(running, null), '▶️ Running the tests — Tests prove the change works.')
    assert.equal(statusLine(failed, null), '▶️ Running the tests — FAILED tests/test_auth.py::test_redirect - AssertionError')
    const n: Narration = { activityId: running.currentId!, now: 'Claude runs the auth tests.', why: 'to check the redirect fix', source: 'model', at: 1 }
    assert.equal(statusLine(running, n), '▶️ Running the tests — to check the redirect fix')
  })

  it('idle when there is nothing to say', () => {
    assert.equal(statusLine(emptyModel(T0), null), 'pairwatch: idle')
    assert.equal(statusLine(null as unknown as SessionModel, null), 'pairwatch: idle')
  })
})

describe('secrets never reach the pane (redact.ts)', () => {
  // fake secrets, built in pieces so no scanner mistakes this file for one holding real keys
  const HF = 'hf' + '_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz012345'
  const GH = 'gh' + 'p_' + 'x'.repeat(36)
  const leaky = play([[E.turnStart('t', s(0)), E.prompt(`Log in to the hub with HF_TOKEN=${HF} and push the model`, s(0))], [E.start('b', 'Bash', { command: 'ls' }, s(1))]], {
    deps: { ...fakeDeps, explainTool: obs => ({ ...fakeDeps.explainTool(obs, { level: 1 }), headline: 'Checking the token', target: `--token ${GH}` }) },
  })
  const all = (t: Record<string, string>): string => Object.values(t).join('\n')

  it('the goal and a step target keep their labels and lose their secrets', () => {
    const t = paneText(input(leaky, { now: s(2) }))
    assert.ok(!all(t).includes(HF) && !all(t).includes(GH), all(t))
    assert.equal(t.goalLine, '🎯 *Goal:* Log in to the hub with HF\\_TOKEN=•••• and push the model')
    assert.equal(t.nowLine, '▶️ **Checking the token** · `--token ••••`')
  })

  it('narration, the "Why?" answer and the status line are masked too', () => {
    const n: Narration = { activityId: leaky.currentId!, now: `Claude exports HF_TOKEN=${HF}.`, why: `It authenticates with ${GH}.`, source: 'model', at: 1 }
    const answer: AskState = { status: 'answered', text: `I exported HF_TOKEN=${HF} so the upload can log in.\nLesson: keep keys in the environment.`, at: 1 }
    const t = paneText(input(leaky, { narration: n, ask: answer, now: s(2) }))
    assert.ok(!all(t).includes(HF) && !all(t).includes(GH), all(t))
    assert.equal(t.narration, 'Claude exports HF\\_TOKEN=••••. It authenticates with ghp\\_••••.')
    assert.equal(t.askBlock, '> I exported HF_TOKEN=•••• so the upload can log in.\n> **Lesson:** keep keys in the environment.')
    const line = statusLine(leaky, n)
    assert.ok(!line.includes(GH) && line.endsWith('It authenticates with ghp_••••.'), line)
  })
})
