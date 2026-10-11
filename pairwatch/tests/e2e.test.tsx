// End to end: one realistic main turn through the real hooks module and every core module (timeline,
// explain, bash, narrate, lessons, text, view, stage and the knowledge base), drawn on vscode.
// Synthetic work: a small Flask app whose login redirect drops the next= parameter. The turn plans,
// searches, reads two files at once, runs the tests and watches them fail, fixes the view, hands a
// check to a sub-agent (which runs two calls of its own), runs the whole suite green and reviews the
// diff: nine main-loop tool calls. At each key moment the pane must say what is happening, teach
// something that fits, and draw the right station.
import { describe, expect, mock, test } from 'claude-code/testing'
import type { MockClock, Mounted } from 'claude-code/testing'
import type { On, RenderPropsOf, ToolCallResult, TurnStepChunk, TurnStepResult } from 'claude-code'

const T0 = 1_760_000_000_000
const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const PANE_PROPS: RenderPropsOf['Pane'] = {
  title: 'Pairwatch',
  isFocused: false,
  bodyColumns: 72,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}
const SUB = 'agent-7f3a'
const GOAL = 'After I sign in, the app shows the home page instead of the page I asked for. Fix the login redirect and make sure the tests pass.'
const ANSWER = 'Fixed: the login view now follows next= when it points inside the app, and falls back to the home page otherwise. All 12 tests pass.'
const LOGIN = '/work/app/src/auth/login.py'
const numbered = (lines: readonly string[]): string => lines.map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n')
const FAILING = [
  'Exit code 1',
  '....F',
  '___________________________ test_login_keeps_next ____________________________',
  "E       AssertionError: assert '/home' == '/settings'",
  '=========================== short test summary info ============================',
  "FAILED tests/test_auth.py::test_login_keeps_next - AssertionError: assert '/home' == '/settings'",
  '1 failed, 4 passed in 0.42s',
].join('\n')

type Gate = { open: () => void; wait: Promise<void> }
function gate(): Gate {
  let open: () => void = () => undefined
  const wait = new Promise<void>(resolve => {
    open = resolve
  })
  return { open, wait }
}

/** A tool's scripted answer, optionally held until its gate opens (the tool "runs" meanwhile). */
type Scripted = { answer: ToolCallResult; gate?: Gate }
const ok = (text: string): ToolCallResult => ({ result: { stdout: text, stderr: '', interrupted: false }, text })
const failed = (text: string): ToolCallResult => ({ isError: true, result: text, text })

/** The world beneath the plugin, plus the scripted tools, the narrator and the turn's model steps. */
function world(on: On, script: Map<string, Scripted>, thinking: Gate) {
  const asked: string[] = []
  const models: unknown[] = []
  on('state.set', ($, e, next) => {
    if (e.key === 'model') models.push(e.value)
    return next(e)
  })
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, {})
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.status', () => ({ value: undefined }))
  let isOpen = false
  on('ui.open', () => {
    isOpen = true
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: isOpen ? [{ id: 'pairwatch', title: 'Pairwatch', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  on('prompt.submit', ($, e) => ({ text: e.text, origin: e.origin }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: SUB }))
  on('classic.SubagentStop', () => ({}))
  // The narrator answers from the prompt it got: what is CURRENT and how it stands.
  on('model.complete', ($, e) => {
    const current = /^CURRENT: (.*)$/m.exec(e.prompt)?.[1] ?? 'this step'
    const status = /^\s+status: (.*)$/m.exec(e.prompt)?.[1] ?? ''
    asked.push(`${current} | ${status}`)
    const failure = /^failed/.test(status) ? ` The tests failed: ${status.replace(/^failed after \S+ — /, '')}.` : ''
    return { value: { isAnswered: true, text: `NOW: Narrator on “${current}”.${failure}\nWHY: It moves the fix forward.`, usage: USAGE } }
  })
  // The model's responses: thinking held open until the test lets it finish, then plain text.
  on('turn.step', async function* ($, e) {
    const chunks: TurnStepChunk[] =
      e.index === 0
        ? [{ kind: 'thinking', index: 0, text: 'The redirect probably ignores next=. ' }]
        : [{ kind: 'text', index: 0, text: ANSWER }, { kind: 'stop', stopReason: 'end_turn', usage: null }]
    for (const chunk of chunks) yield chunk
    if (e.index === 0) {
      await thinking.wait
      yield { kind: 'thinking', index: 0, text: 'Plan the fix, then find where login builds its redirect.' }
      yield { kind: 'stop', stopReason: 'tool_use', usage: null }
    }
    const result: TurnStepResult = { turnId: e.turnId, index: e.index, answer: e.index === 0 ? '' : ANSWER, toolUses: [], stopReason: e.index === 0 ? 'tool_use' : 'end_turn', usage: null }
    return result
  })
  on('tool.call', async ($, e) => {
    const x = e as unknown as { tool: string; command?: unknown; file_path?: unknown; description?: unknown }
    const key = `${x.tool}:${String(x.command ?? x.file_path ?? x.description ?? '')}`
    const scripted = script.get(key)
    if (scripted === undefined) return { deny: `nothing scripted for ${key}` }
    await scripted.gate?.wait
    return scripted.answer
  })
  return { clock, asked, models }
}

/** What the vscode pane shows right now: the headline and narration, the card, and the stage. */
async function look(ui: Mounted<'vscode', 'Pane'>) {
  const now = (await ui.find({ type: 'Markdown', key: 'now' }))?.text ?? ''
  const lesson = (await ui.find({ type: 'Markdown', key: 'lesson' }))?.text ?? ''
  const svg = String((await ui.find({ type: 'Svg' }))?.props.source ?? '')
  return { now, lesson, svg, headline: /\*\*(.+?)\*\*/.exec(now)?.[1] ?? '' }
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) {
    // the plugin observes each chunk on its way through
  }
}

/** Let a held tool run for `ms`, then answer it, and give the pump a tick to fold its end. */
async function run(clock: MockClock, call: Promise<ToolCallResult>, g: Gate | undefined, ms: number): Promise<ToolCallResult> {
  await clock.advance(ms)
  g?.open()
  const answer = await call
  await clock.advance(400)
  return answer
}

describe('a realistic turn, end to end', () => {
  test('plan, search, read, a failing test, a fix, a sub-agent, a green suite and the recap', { timeoutMs: 60_000 }, async ($, on) => {
    const thinking = gate()
    const hold = { test1: gate(), agent: gate(), test2: gate(), grep: gate() }
    const script = new Map<string, Scripted>([
      ['TodoWrite:', { answer: { result: { oldTodos: [], newTodos: [] }, text: 'Todos have been modified successfully.' } }],
      ['Bash:grep -rn "redirect(" src/ --include=*.py', { gate: hold.grep, answer: ok('src/auth/login.py:11:    return redirect(url_for("home"))\nsrc/admin/views.py:17:    return redirect(url_for("home"))') }],
      [`Read:${LOGIN}`, { answer: { result: {}, text: numbered(['from flask import redirect, request, url_for', '', 'def login():', '    start_session(check_password(request.form))', '    return redirect(url_for("home"))']) } }],
      ['Read:/work/app/tests/test_auth.py', { answer: { result: {}, text: numbered(['import pytest', '', 'def test_login_keeps_next(client):', '    r = client.post("/login?next=/settings", data=CREDS)', "    assert r.headers['Location'] == '/settings'"]) } }],
      ['Bash:python -m pytest tests/test_auth.py -q', { gate: hold.test1, answer: failed(FAILING) }],
      [`Edit:${LOGIN}`, { answer: { result: {}, text: `The file ${LOGIN} has been updated successfully.` } }],
      ['Agent:Check other views for the same redirect bug', { gate: hold.agent, answer: { result: {}, text: 'Only admin/views.py redirects home, and that is logout, which takes no next parameter.' } }],
      ['Bash:grep -rn "url_for(\\"home\\")" src/', { answer: ok('src/admin/views.py:17:    return redirect(url_for("home"))') }],
      ['Read:/work/app/src/admin/views.py', { answer: { result: {}, text: numbered(['def logout():', '    return redirect(url_for("home"))']) } }],
      ['Bash:python -m pytest -q', { gate: hold.test2, answer: ok('............\n12 passed in 1.03s') }],
      ['Bash:git diff --stat', { answer: ok(' src/auth/login.py | 4 +++-\n 1 file changed, 3 insertions(+), 1 deletion(-)') }],
    ])
    const { clock, asked } = world(on, script, thinking)
    await $.session.start({ cwd: '/work/app', surface: 'vscode', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'pairwatch', surface: 'vscode', component: 'Pane', requestId: 'pairwatch', props: PANE_PROPS })

    // 1. The person asks; Claude starts thinking. The stage stands on Think; a first card is up.
    await $.prompt.submit({ text: GOAL, wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: GOAL, turnId: 'turn-1' })
    const step0 = drain($.turn.step({ turnId: 'turn-1', index: 0, model: 'm', messageCount: 1 }))
    await clock.advance(3_200)
    let v = await look(ui)
    expect(v.svg).toContain('THINKING')
    expect(v.now).toMatch(/Thinking it through|Reading your request|Narrator on/)
    expect(v.lesson).toContain('💡')
    thinking.open()
    await step0

    // 2. A plan: the todo list on the Plan station.
    await $.tool.call({
      tool: 'TodoWrite',
      todos: [
        { content: 'Reproduce the failing redirect', status: 'in_progress', activeForm: 'Reproducing the failing redirect' },
        { content: 'Keep next= on the login redirect', status: 'pending', activeForm: 'Keeping next= on the login redirect' },
        { content: 'Run the whole test suite', status: 'pending', activeForm: 'Running the whole test suite' },
      ],
    })
    await clock.advance(800)
    v = await look(ui)
    expect(v.headline).toBe('Making a plan: 3 steps')
    expect(v.svg).toContain('PLANNED')
    expect(v.svg).toContain('Reproduce the failing redirect')
    expect(v.lesson).toContain('Todo lists')

    // 3. A search while it runs: the headline is Claude's own description; grep is the card.
    const grep = $.tool.call({ tool: 'Bash', command: 'grep -rn "redirect(" src/ --include=*.py', description: 'Find where redirects are built' })
    await clock.advance(800)
    v = await look(ui)
    expect(v.headline).toBe('Find where redirects are built')
    expect(v.svg).toContain('SEARCHING')
    expect(v.svg).toContain('redirect(')
    expect(v.lesson).toContain('**grep**')
    await run(clock, grep, hold.grep, 300)
    v = await look(ui)
    expect(v.svg).toContain('SEARCHED')
    expect(v.svg).toContain('2 matches')

    // 4. Two files read at once become one activity.
    await Promise.all([$.tool.call({ tool: 'Read', file_path: LOGIN }), $.tool.call({ tool: 'Read', file_path: '/work/app/tests/test_auth.py' })])
    await clock.advance(800)
    v = await look(ui)
    expect(v.headline).toBe('Reading 2 files')
    expect(v.svg).toContain('READ')
    expect(v.svg).toContain('2 files')
    expect(v.svg).toContain('tests/test_auth.py')

    // 5. The tests run, then fail: the failure is the news, in words, on stage and in the card.
    const test1 = $.tool.call({ tool: 'Bash', command: 'python -m pytest tests/test_auth.py -q', description: 'Run the auth tests to reproduce the failure' })
    await clock.advance(1_200)
    v = await look(ui)
    expect(v.headline).toBe('Run the auth tests to reproduce the failure')
    expect(v.svg).toContain('RUNNING')
    expect(v.svg).toContain('python -m pytest tests/test_auth.py -q')
    expect(v.lesson).toContain('pytest')
    await run(clock, test1, hold.test1, 2_000)
    await clock.advance(3_000)
    v = await look(ui)
    expect(v.svg).toContain('RAN')
    expect(v.svg).toContain('1 failed, 4 passed')
    expect(v.now).toContain('test\\_login\\_keeps\\_next')
    expect(asked.some(a => a.startsWith('Run the auth tests') && a.includes('failed after'))).toBe(true)

    // 6. The fix: an edit of the file it read, with read-before-edit as the lesson.
    await $.tool.call({
      tool: 'Edit',
      file_path: LOGIN,
      old_string: '    return redirect(url_for("home"))',
      new_string: '    next_url = request.args.get("next")\n    if next_url and is_safe_url(next_url):\n        return redirect(next_url)\n    return redirect(url_for("home"))',
    })
    await clock.advance(800)
    v = await look(ui)
    expect(v.headline).toBe('Editing login.py: adding 3 lines')
    expect(v.svg).toContain('EDITED')
    expect(v.svg).toContain('+3')
    expect(v.lesson).toContain('Read before edit')

    // 7. A sub-agent checks the other views; its own calls show on its lane while the stage stays on Agents.
    const agent = $.tool.call({ tool: 'Agent', description: 'Check other views for the same redirect bug', subagent_type: 'Explore', prompt: 'Look for other views that ignore next= after login.' })
    await $.agent.spawn({
      tool_use_id: 'toolu_agent',
      prompt: 'Look for other views that ignore next= after login.',
      description: 'Check other views for the same redirect bug',
      subagentType: 'Explore',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'm',
      background: false,
      fork: false,
    })
    // calls inside the sub-agent's loop (agentId is the engine's to stamp, so it is not in the call's type)
    const subGrep = { tool: 'Bash' as const, command: 'grep -rn "url_for(\\"home\\")" src/', description: 'Find other hard-coded home redirects', agentId: SUB }
    await $.tool.call(subGrep)
    await clock.advance(800)
    v = await look(ui)
    expect(v.headline).toBe('Delegating to a sub-agent: Check other views for the same redirect bug')
    expect(v.svg).toContain('DELEGATING')
    expect(v.svg).toContain('Find other hard-coded home redirects')
    expect(v.lesson).toContain('Sub-agents')
    const subRead = { tool: 'Read' as const, file_path: '/work/app/src/admin/views.py', agentId: SUB }
    await $.tool.call(subRead)
    await $.turn.complete({ turnId: 'turn-1', agentId: SUB, answer: 'Only admin/views.py redirects home.', durationMs: 4_000, isAborted: false, reason: 'answer' })
    await $.classic.SubagentStop({ stop_hook_active: false, agent_id: SUB, agent_transcript_path: '/t/a.jsonl', agent_type: 'Explore', last_assistant_message: 'Only admin/views.py redirects home.' })
    await run(clock, agent, hold.agent, 1_000)
    v = await look(ui)
    expect(v.svg).toContain('DELEGATED')

    // 8. The whole suite, green, then the diff.
    const test2 = $.tool.call({ tool: 'Bash', command: 'python -m pytest -q', description: 'Run the full test suite' })
    await clock.advance(1_200)
    v = await look(ui)
    expect(v.headline).toBe('Run the full test suite')
    expect(v.svg).toContain('RUNNING')
    await run(clock, test2, hold.test2, 3_000)
    v = await look(ui)
    expect(v.svg).toContain('12 passed')
    await $.tool.call({ tool: 'Bash', command: 'git diff --stat', description: 'Review the change' })
    await clock.advance(800)

    // 9. The answer, then the recap on the You stop: steps, files and the one failure along the way.
    await drain($.turn.step({ turnId: 'turn-1', index: 1, model: 'm', messageCount: 12 }))
    await $.turn.complete({ turnId: 'turn-1', answer: ANSWER, durationMs: 30_000, isAborted: false, reason: 'answer' })
    await clock.advance(800)
    v = await look(ui)
    expect(v.headline).toMatch(/^Done: 11 steps, 3 files in \d+s$/)
    expect(v.svg).toContain('All done')
    expect(v.svg).toContain('1 error')
    expect(v.lesson).toContain('💡')

    // The model narrated what it was shown, and every frame stayed a whole, script-free document.
    expect(asked.length).toBeGreaterThan(4)
    expect(v.svg.startsWith('<svg')).toBe(true)
    expect(v.svg).not.toContain('<script')
    await ui.unmount()
  })

  test('a long command keeps its tail: a big heredoc and then the tests reads as a test run', async ($, on) => {
    const body = Array.from({ length: 200 }, (_, i) => `def case_${i}():\n    assert parse("${'x'.repeat(10)}") == ${i}`).join('\n')
    const command = `cat > /work/app/tests/test_parse.py <<'EOF'\n${body}\nEOF\npython -m pytest tests/test_parse.py -q`
    const script = new Map<string, Scripted>([[`Bash:${command}`, { answer: ok('200 passed in 0.80s') }]])
    const { clock, models } = world(on, script, gate())
    await $.session.start({ cwd: '/work/app', surface: 'vscode', isInteractive: true })
    await $.prompt.submit({ text: 'add parser tests', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'add parser tests', turnId: 'turn-1' })
    expect(command.length).toBeGreaterThan(8_000)
    await $.tool.call({ tool: 'Bash', command, description: 'Write the parser tests and run them' })
    await clock.advance(800)
    type M = { steps: { tool: string; station: string; scene: { kind: string; category?: string }; target?: string }[] }
    const step = (models.at(-1) as M).steps.find(s => s.tool === 'Bash')
    expect(step?.station).toBe('run')
    expect(step?.scene.category).toBe('test')
    expect(step?.target?.length).toBeLessThanOrEqual(4_000)
    expect(step?.target?.endsWith('python -m pytest tests/test_parse.py -q')).toBe(true)
  })
})
