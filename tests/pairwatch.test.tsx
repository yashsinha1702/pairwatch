// Kit tests for Pairwatch's hooks module (claude plugin test). Everything the module touches is
// answered here: the clock and store by the kit's mocks, the rest by hooks beneath the plugin.
// The examples are synthetic: no real session's work is copied in.
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
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
const SURFACES = ['vscode', 'desktop', 'mobile', 'terminal'] as const
const NO_PANE = { level: 1, isPaused: false, useModel: true, autoOpen: false } as const

type Write = { key: string; value: unknown }

/** The world beneath the plugin: clock, store, and every service the module calls but the page's. */
function world(on: On, store: Record<string, unknown> = {}) {
  const stored: Write[] = []
  const states: Write[] = []
  const statuses: (string | undefined)[] = []
  const opens: string[] = []
  let isOpen = false
  // matched, so it may stand beside mock.store's own unmatched store.set hook (beneath this one)
  on('store.set', { key: /./ }, ($, e, next) => {
    stored.push({ key: e.key, value: e.value })
    return next(e)
  })
  on('state.set', ($, e, next) => {
    states.push({ key: e.key, value: e.value })
    return next(e)
  })
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, store)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    opens.push(e.id)
    isOpen = true
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    isOpen = false
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: isOpen ? [{ id: 'pairwatch', title: 'Pairwatch', isShown: true, isFocused: false, isPlaced: true }] : [],
  }))
  on('prompt.submit', ($, e) => ({ text: e.text, origin: e.origin }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  return {
    clock,
    stored,
    statuses,
    opens,
    /** the values the module wrote under a state key, oldest first */
    written: (key: string) => states.filter(w => w.key === key).map(w => w.value),
  }
}

const KEY = 'pw-key-0123456789abcdefghij'
const OLD_KEY = 'old-tutor-key-0123456789abcdef'
const SID = 'sess-1'
const ran = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const answer = (body: unknown) => ({ value: { status: 200, ok: true, headers: { 'content-type': 'application/json' }, text: JSON.stringify(body) } })

type Run = { argv: string[]; timeoutMs?: number }
type Fetched = { url: string; path: string; method: string; headers: Record<string, string>; body?: string }
type FileWrite = { path: string; text: string }

/**
 * The machine beneath the plugin for its page: the environment, node, the viewer server on
 * 127.0.0.1 (answered per URL) and the files. `server` is what answers before Pairwatch starts one.
 */
function machine(
  on: On,
  setup: {
    env?: Record<string, string>
    server?: 'none' | 'ours' | 'older' | 'legacy'
    hasNode?: boolean
    /** a server Pairwatch starts comes up (true when not given) */
    startsUp?: boolean
    /** how many more /health calls a server asked to quit still answers (it takes a moment to go) */
    lingers?: number
    files?: Record<string, string>
  } = {},
) {
  const env = setup.env ?? { HOME: '/home/ana' }
  const home = env.HOME ?? env.USERPROFILE ?? ''
  const dir = `${home}/.claude/pairwatch`
  const runs: Run[] = []
  const fetches: Fetched[] = []
  const writes: FileWrite[] = []
  const files: Record<string, string> = { [`${home}/.claude/tutor/viewer.token`]: `${OLD_KEY}\n`, ...(setup.files ?? {}) }
  if (setup.server === 'ours' || setup.server === 'older') files[`${dir}/viewer.token`] = `${KEY}\n`
  /** the server on the port, and what its inbox answers */
  const page = {
    app: setup.server ?? 'none',
    clients: 1,
    watching: 0 as number | undefined,
    actions: [] as unknown[],
    /** once asked to quit: the /health calls it still answers before it is gone (-1: not asked) */
    lingers: -1,
  }
  mock.env(on, env)
  on('session.id', () => ({ value: SID }))
  on('process.run', ($, e) => {
    runs.push({ argv: [...e.argv], ...(e.init?.timeoutMs === undefined ? {} : { timeoutMs: e.init.timeoutMs }) })
    if (e.argv[1] === '--version') return setup.hasNode === false ? { deny: 'spawn node ENOENT' } : ran('v22.11.0\n')
    if (setup.startsUp !== false) {
      page.app = 'ours' // server.mjs --detach: the server is up, its key written
      page.lingers = -1
      files[`${dir}/viewer.token`] = `${KEY}\n`
    }
    return ran('')
  })
  on('http.fetch', ($, e) => {
    const url = new URL(e.url)
    fetches.push({
      url: e.url,
      path: url.pathname,
      method: e.init?.method ?? 'GET',
      headers: { ...(e.init?.headers ?? {}) },
      ...(e.init?.body === undefined ? {} : { body: e.init.body }),
    })
    if (page.app === 'none') return { deny: 'connect ECONNREFUSED' }
    if (url.pathname === '/health') {
      if (page.lingers === 0) {
        page.app = 'none'
        return { deny: 'connect ECONNREFUSED' }
      }
      if (page.lingers > 0) page.lingers -= 1
      if (page.app === 'legacy') return answer({ ok: true, app: 'claude-tutor', version: 2, clients: 0 })
      return answer({ ok: true, app: 'pairwatch', version: page.app === 'older' ? 2 : 3, clients: page.clients })
    }
    if (url.pathname === '/api/quit') {
      page.lingers = setup.lingers ?? 0
      return answer({ ok: true })
    }
    if (url.pathname === '/api/inbox') {
      return answer({ actions: page.actions.splice(0), clients: page.clients, ...(page.watching === undefined ? {} : { watching: page.watching }) })
    }
    return { value: { status: 404, ok: false, headers: {}, text: 'not found' } }
  })
  on('fs.read', ($, e) => {
    const text = files[e.path]
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.write', ($, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  return {
    dir,
    runs,
    fetches,
    writes,
    page,
    files,
    /** the snapshots written for this session, parsed, oldest first */
    snapshots: () => writes.filter(w => w.path === `${dir}/live/${SID}.json`).map(w => JSON.parse(w.text) as Record<string, unknown>),
  }
}

const mountPane = <S extends (typeof SURFACES)[number]>($: Engine, surface: S) =>
  $.ui.mount({ plugin: 'pairwatch', surface, component: 'Pane', requestId: 'pairwatch', props: PANE_PROPS })

const pairwatch = ($: Engine, args: string) =>
  $.command.run({ command: 'pairwatch', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

const startSession = ($: Engine) => $.session.start({ cwd: '/work/app', surface: 'vscode', isInteractive: true })

async function firstTurn($: Engine, clock: MockClock, prompt: string): Promise<void> {
  await $.prompt.submit({ text: prompt, wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: prompt, turnId: 'turn-1' })
  await clock.advance(10)
}

const bashOk = (): ToolCallResult => ({ result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' })

describe('Pairwatch pane', () => {
  test('draws on every surface with an empty model; the stage is an Svg on remote surfaces only', async ($, on) => {
    world(on)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      expect(await ui.drawn()).toMatchObject({ type: 'Box' })
      const svg = await ui.find({ type: 'Svg' })
      if (surface === 'terminal') {
        expect(svg).toBeUndefined()
        expect(await ui.find({ type: 'Text', text: 'Read' })).toBeDefined() // the text rail
      } else {
        expect(String(svg?.props.source)).toContain('<svg')
        expect(String(svg?.props.alt).length).toBeGreaterThan(0)
        expect(svg?.props.width).toBeUndefined()
      }
      expect((await ui.find({ type: 'Markdown', key: 'now' }))?.text.length).toBeGreaterThan(0)
      for (const key of ['why', 'tip', 'known', 'pause']) expect(await ui.find({ type: 'Button', key })).toBeDefined()
      expect(await ui.find({ key: 'level' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('a frame that throws while drawing still answers with a tree (the .catch)', async $ => {
    // no mock clock: the hook's $.clock.now() rejects inside the hook
    for (const surface of ['vscode', 'terminal'] as const) {
      const ui = await mountPane($, surface)
      expect(await ui.drawn()).toMatchObject({ type: 'Text' })
      expect(await ui.find({ type: 'Text', text: 'could not draw' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('prefs saved in the store come back at session start', async ($, on) => {
    world(on, { prefs: { level: 3, isPaused: true, useModel: false, autoOpen: false } })
    await startSession($)
    const ui = await mountPane($, 'vscode')
    expect((await ui.find({ type: 'Button', key: 'pause' }))?.props.label).toBe('Resume')
    expect((await ui.find({ type: 'Select', key: 'level' }))?.props.value).toBe('3')
    await ui.unmount()
  })

  test('Pause and the level picker write prefs and save them', async ($, on) => {
    const w = world(on)
    await startSession($)
    const ui = await mountPane($, 'desktop')
    await ui.press({ key: 'pause' })
    expect((await ui.find({ type: 'Button', key: 'pause' }))?.props.label).toBe('Resume')
    await ui.select({ key: 'level', value: '2' })
    expect((await ui.find({ type: 'Select', key: 'level' }))?.props.value).toBe('2')
    expect(w.stored.filter(s => s.key === 'prefs').at(-1)?.value).toEqual({ level: 2, isPaused: true, useModel: true, autoOpen: true })
    await ui.unmount()
  })
})

describe('a simulated turn', () => {
  test('a Bash call shows its headline, and its verb on the stage, while it runs and once it ends', async ($, on) => {
    const { clock } = world(on)
    const finished = clock.sleep(5_000)
    on('tool.call', async () => {
      await finished
      return { result: { stdout: '3 passed', stderr: '', interrupted: false }, text: '3 passed in 0.41s' }
    })
    await startSession($)
    await firstTurn($, clock, 'run the auth tests')
    const running = $.tool.call({ tool: 'Bash', command: 'pytest -q tests/test_auth.py', description: 'Run the auth tests' })
    await clock.advance(500)

    const ui = await mountPane($, 'vscode')
    expect((await ui.find({ type: 'Markdown', key: 'now' }))?.text).toContain('Run the auth tests')
    expect(String((await ui.find({ type: 'Svg' }))?.props.source)).toContain('RUNNING')

    await clock.advance(5_000)
    await running
    await clock.advance(500)
    expect(String((await ui.find({ type: 'Svg' }))?.props.source)).toContain('RAN')
    await ui.unmount()

    const term = await mountPane($, 'terminal')
    expect((await term.find({ type: 'Markdown', key: 'now' }))?.text).toContain('Run the auth tests')
    expect(await term.find({ type: 'Text', text: '[Run]' })).toBeDefined()
    await term.unmount()
  })

  test('a model narration ("NOW: … WHY: …") replaces the rules text once the clock moves', async ($, on) => {
    const { clock, written } = world(on)
    machine(on, { server: 'ours' })
    const asked: { model: string; prompt: string; system?: string }[] = []
    on('model.complete', ($, e) => {
      asked.push({ model: e.model, prompt: e.prompt, ...(e.system === undefined ? {} : { system: e.system }) })
      return { value: { isAnswered: true, text: 'NOW: Claude checks the login tests\nWHY: to prove the fix works', usage: USAGE } }
    })
    on('tool.call', () => bashOk())
    await startSession($)
    const opened = (await pairwatch($, 'open')).text ?? ''
    expect(opened).toContain('Pairwatch is on.')
    expect(opened).toContain(`http://localhost:7979/?key=${KEY}`)
    const ui = await mountPane($, 'vscode')
    await firstTurn($, clock, 'fix the login redirect')
    await $.tool.call({ tool: 'Bash', command: 'pytest -q tests/test_login.py', description: 'Run the login tests' })
    await clock.advance(500)
    await clock.advance(500)

    expect(asked.length).toBe(1)
    expect(asked[0]?.model).toBe('haiku')
    const narrations = written('narration') as { source: string; now: string; why: string }[]
    expect(narrations.at(-1)).toMatchObject({ source: 'model' })
    expect(narrations.at(-1)?.now).toContain('Claude checks the login tests')
    expect((await ui.find({ type: 'Markdown', key: 'now' }))?.text).toContain('Claude checks the login tests')
    await ui.unmount()
  })

  test('a model that refuses the credentials leaves rules narration for the rest of the session', async ($, on) => {
    const { clock } = world(on)
    let calls = 0
    on('model.complete', () => {
      calls += 1
      return { value: { isAnswered: false, reason: 'api-error', status: 401, error: 'authentication_failed', usage: USAGE } }
    })
    on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }))
    await startSession($)
    await pairwatch($, 'open')
    const ui = await mountPane($, 'vscode')
    await firstTurn($, clock, 'look around')
    await $.tool.call({ tool: 'Bash', command: 'ls -la', description: 'List the project' })
    await clock.advance(3_000)
    await $.tool.call({ tool: 'Bash', command: 'git status', description: 'Check git status' })
    await clock.advance(3_000)
    expect(calls).toBe(1)
    expect(await ui.find({ type: 'Text', text: 'rules only' })).toBeDefined()
    await ui.unmount()
  })
})

describe('concept cards', () => {
  test('a new activity puts a card on show; it deepens; Another tip swaps it; I know this retires it', async ($, on) => {
    const { clock, written, stored } = world(on)
    on('tool.call', () => ({ result: { oldTodos: [], newTodos: [] }, text: 'Todos have been modified successfully.' }))
    await startSession($)
    const ui = await mountPane($, 'vscode')
    await firstTurn($, clock, 'plan the refactor')
    await $.tool.call({
      tool: 'TodoWrite',
      todos: [
        { content: 'Read the auth module', status: 'in_progress', activeForm: 'Reading the auth module' },
        { content: 'Split the login handler', status: 'pending', activeForm: 'Splitting the login handler' },
      ],
    })
    await clock.advance(500)
    type Card = { conceptId: string; depth: number }
    const first = (written('lesson') as Card[]).at(-1)
    expect(first).toMatchObject({ conceptId: 'todo-planning', depth: 0 })

    await clock.advance(16_000)
    expect((written('lesson') as Card[]).at(-1)).toMatchObject({ conceptId: 'todo-planning', depth: 1 })

    await ui.press({ key: 'tip' })
    const tip = (written('lesson') as Card[]).at(-1)
    expect(tip?.depth).toBe(0)
    expect(typeof tip?.conceptId).toBe('string')
    expect(tip?.conceptId).not.toBe('todo-planning')

    await ui.press({ key: 'known' })
    expect(stored.filter(s => s.key === 'known').at(-1)?.value).toEqual([tip?.conceptId])
    const after = (written('lesson') as (Card | null)[]).at(-1)
    expect(after?.conceptId).not.toBe(tip?.conceptId)

    await clock.advance(15_000)
    const seen = stored.filter(s => s.key === 'seen').at(-1)?.value as Record<string, { n: number }>
    expect(Object.keys(seen)).toContain('todo-planning')
    await ui.unmount()
  })
})

describe('/pairwatch', () => {
  test('open, pause, level expert and journal', async ($, on) => {
    const day = 24 * 60 * 60 * 1000
    const w = world(on, {
      seen: { pipe: { n: 3, last: T0 - day }, grep: { n: 1, last: T0 - 2 * day }, 'git-status': { n: 2, last: T0 - 30 * day } },
      journal: [
        { id: 'git-status', at: T0 - 30 * day },
        { id: 'grep', at: T0 - 2 * day },
        { id: 'pipe', at: T0 - day },
      ],
      known: ['ls'],
    })
    await startSession($)
    expect((await pairwatch($, '')).text).toContain('Pairwatch is on.')
    expect(w.opens).toEqual(['pairwatch'])
    expect((await pairwatch($, 'pause')).text).toContain('paused')
    expect((await pairwatch($, 'level expert')).text).toBe('Pairwatch level: expert.')
    const prefs = w.stored.filter(s => s.key === 'prefs').at(-1)?.value
    expect(prefs).toEqual({ level: 3, isPaused: true, useModel: true, autoOpen: true })

    const journal = String((await pairwatch($, 'journal')).text)
    expect(journal).toContain('Concepts met: 3 in all, 2 this week')
    expect(journal).toContain('Marked as known: 1')

    const ui = await mountPane($, 'vscode')
    expect((await ui.find({ type: 'Button', key: 'pause' }))?.props.label).toBe('Resume')
    expect((await ui.find({ type: 'Select', key: 'level' }))?.props.value).toBe('3')
    await ui.unmount()
  })

  test('help, an unknown option, model/auto switches, close and reset answer briefly', async ($, on) => {
    const w = world(on, { known: ['pipe'], seen: { pipe: { n: 1, last: T0 } } })
    await startSession($)
    expect(String((await pairwatch($, 'help')).text)).toContain('/pairwatch')
    expect((await pairwatch($, 'dance')).text).toBe('Unknown option “dance”. /pairwatch help lists them.')
    expect((await pairwatch($, 'model off')).text).toContain('off')
    expect((await pairwatch($, 'auto off')).text).toContain('no longer')
    expect((await pairwatch($, 'close')).text).toContain('closed')
    expect(w.stored.filter(s => s.key === 'prefs').at(-1)?.value).toEqual({ level: 1, isPaused: false, useModel: false, autoOpen: false })
    expect((await pairwatch($, 'reset')).text).toContain('forgot')
    expect(w.stored.filter(s => s.key === 'known').at(-1)?.value).toEqual([])
    expect(String((await pairwatch($, 'journal')).text)).toContain('empty')
  })
})

describe('opening and the status line', () => {
  test('the first prompt opens the pane by itself; later prompts do not', async ($, on) => {
    const { clock, opens } = world(on)
    await startSession($)
    await firstTurn($, clock, 'hello')
    await $.prompt.submit({ text: 'and again', wait: false, origin: { kind: 'composer' } })
    await clock.settle()
    expect(opens).toEqual(['pairwatch'])
  })

  test('with auto-open off the first prompt opens nothing', async ($, on) => {
    const { clock, opens } = world(on, { prefs: NO_PANE })
    await startSession($)
    await firstTurn($, clock, 'hello')
    expect(opens).toEqual([])
  })

  test('the status line stands in while the pane is not shown and clears once it is', async ($, on) => {
    const { clock, statuses } = world(on, { prefs: { ...NO_PANE, useModel: false } })
    await startSession($)
    await clock.advance(500)
    expect(typeof statuses.at(-1)).toBe('string')
    expect(String(statuses.at(-1)).length).toBeGreaterThan(0)
    await pairwatch($, 'open')
    await clock.advance(500)
    // opened but drawn by no surface (VS Code today): the status line stays
    expect(typeof statuses.at(-1)).toBe('string')
    const ui = await mountPane($, 'vscode')
    await clock.advance(500)
    expect(statuses.at(-1)).toBeUndefined()
    await ui.unmount()
    const count = statuses.length
    await clock.advance(2_000)
    expect(statuses.length).toBe(count) // throttled to changes
  })

  test('/pairwatch close clears the status line and stops narration and the page until /pairwatch opens it again', async ($, on) => {
    const { clock, statuses, stored } = world(on, { prefs: NO_PANE })
    const m = machine(on, { server: 'ours' })
    m.page.watching = 1 // a page shows this session: narration is wanted
    let asked = 0
    on('model.complete', () => {
      asked += 1
      return { value: { isAnswered: true, text: 'NOW: Claude lists the files\nWHY: to see the project', usage: USAGE } }
    })
    on('tool.call', () => bashOk())
    await startSession($)
    await clock.advance(1_000)
    expect(typeof statuses.at(-1)).toBe('string')

    const closed = String((await pairwatch($, 'close')).text)
    expect(closed).toContain('closed')
    expect(statuses.at(-1)).toBeUndefined() // at once, not at the next tick
    expect(stored.filter(s => s.key === 'off').at(-1)?.value).toBe(true)
    const writes = m.writes.length
    const polls = m.fetches.filter(f => f.path === '/api/inbox').length

    await firstTurn($, clock, 'list the files')
    await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List the files' })
    await clock.advance(3_000)
    expect(statuses.at(-1)).toBeUndefined()
    expect(asked).toBe(0)
    expect(m.writes.length).toBe(writes) // no snapshot while closed
    expect(m.fetches.filter(f => f.path === '/api/inbox').length).toBe(polls)
    expect(String((await pairwatch($, 'status')).text)).toContain('Status line: off (Pairwatch is closed; /pairwatch opens it)')

    // /pairwatch: on again; the pane is open but no surface drew it, so the status line comes back
    expect(String((await pairwatch($, '')).text)).toContain('Pairwatch is on.')
    expect(stored.filter(s => s.key === 'off').at(-1)?.value).toBe(false)
    await clock.advance(1_500)
    expect(typeof statuses.at(-1)).toBe('string')
    expect(asked).toBe(1)
    expect(m.writes.length).toBeGreaterThan(writes)
  })
})

describe('the viewer page', () => {
  test('it checks for node, then starts server.mjs detached on the port set, and links the page with its key', { options: { viewerPort: 17979 } }, async ($, on) => {
    const { clock } = world(on, { prefs: NO_PANE })
    const m = machine(on)
    await startSession($)
    await clock.settle()
    expect(m.runs[0]).toEqual({ argv: ['node', '--version'], timeoutMs: 5_000 })
    expect(m.runs[1]?.timeoutMs).toBe(8_000)
    const argv = m.runs[1]?.argv ?? []
    expect(argv.length).toBe(7)
    expect(argv[0]).toBe('node')
    expect(String(argv[1]).endsWith('/viewer/server.mjs')).toBe(true)
    expect(argv.slice(2)).toEqual(['--detach', '--port', '17979', '--dir', '/home/ana/.claude/pairwatch'])
    expect(m.runs.length).toBe(2)
    expect(m.writes).toEqual([]) // no snapshot before the server answered

    await clock.advance(1_500) // a server just started is looked for again soon
    const text = String((await pairwatch($, '')).text)
    expect(text).toContain(`http://localhost:17979/?key=${KEY}`)
    expect(text).toContain('forward port 17979')
    await clock.advance(1_000)
    expect(m.fetches.every(f => f.url.startsWith('http://127.0.0.1:17979/'))).toBe(true)
    const polls = m.fetches.filter(f => f.path === '/api/inbox')
    expect(polls.length).toBeGreaterThan(0)
    expect(polls.every(f => f.url.endsWith(`?sid=${SID}`) && f.headers['x-pairwatch-key'] === KEY)).toBe(true)
    expect(String((await pairwatch($, 'status')).text)).toContain(`Viewer page: running at http://localhost:17979/?key=${KEY}`)
    expect(m.snapshots().length).toBeGreaterThan(0)
    await clock.advance(15_000)
    expect(m.runs.length).toBe(2) // it answers: no other start
  })

  test('without node on PATH the pane still works and one line says why there is no page', async ($, on) => {
    const { clock } = world(on, { prefs: NO_PANE })
    const m = machine(on, { hasNode: false })
    await startSession($)
    await clock.advance(12_000)
    const text = String((await pairwatch($, '')).text)
    expect(text).toContain('Pairwatch is on.')
    expect(text).toContain("Node.js was not found on PATH; Pairwatch's page needs Node 18 or newer.")
    expect(text).not.toContain('localhost')
    expect(m.runs.map(r => r.argv.join(' '))).toEqual(['node --version']) // checked once, nothing started
    expect(m.writes).toEqual([])
    expect(String((await pairwatch($, 'status')).text)).toContain('Node.js was not found on PATH')
  })

  test('with no HOME it uses USERPROFILE', async ($, on) => {
    const { clock } = world(on, { prefs: NO_PANE })
    const m = machine(on, { env: { USERPROFILE: 'C:\\Users\\ana' } })
    await startSession($)
    await clock.settle()
    expect(m.runs[1]?.argv.slice(-2)).toEqual(['--dir', 'C:\\Users\\ana/.claude/pairwatch'])
  })

  test('with neither HOME nor USERPROFILE there is no page, the pane still works, and one line says why', async ($, on) => {
    const { clock, opens } = world(on, { prefs: NO_PANE })
    const m = machine(on, { env: {} })
    await startSession($)
    await clock.advance(12_000)
    const text = String((await pairwatch($, '')).text)
    expect(text).toContain('Pairwatch is on.')
    expect(text).toContain('No home folder is set (HOME or USERPROFILE)')
    expect(opens).toEqual(['pairwatch'])
    expect(m.runs).toEqual([])
    expect(m.fetches).toEqual([])
    expect(m.writes).toEqual([])
  })

  test('an old claude-tutor server is asked to quit with its own key, then Pairwatch starts its own', async ($, on) => {
    const { clock } = world(on, { prefs: NO_PANE })
    const m = machine(on, { server: 'legacy', lingers: 1 }) // it goes a moment after it answers
    await startSession($)
    await clock.settle()
    const quit = m.fetches.find(f => f.path === '/api/quit')
    expect(quit?.method).toBe('POST')
    expect(quit?.headers['x-tutor-key']).toBe(OLD_KEY) // the header the server from before the rename reads
    expect(quit?.headers['x-pairwatch-key']).toBeUndefined()
    expect(quit?.headers['content-type']).toBe('application/json')
    expect(m.runs).toEqual([]) // not while it still holds the port

    await clock.advance(3_000)
    expect(m.runs.map(r => (r.argv[1] === '--version' ? 'check' : r.argv[2]))).toEqual(['check', '--detach'])
    expect(String((await pairwatch($, '')).text)).toContain(`http://localhost:7979/?key=${KEY}`)
  })

  test('an older Pairwatch server is asked to quit with the key in the Pairwatch folder, and replaced at once', async ($, on) => {
    const { clock } = world(on, { prefs: NO_PANE })
    const m = machine(on, { server: 'older' }) // it frees the port as it answers
    await startSession($)
    await clock.settle()
    const quit = m.fetches.find(f => f.path === '/api/quit')
    expect(quit?.method).toBe('POST')
    expect(quit?.headers['x-pairwatch-key']).toBe(KEY)
    expect(quit?.headers['content-type']).toBe('application/json')
    expect(m.fetches.map(f => f.path)).toEqual(['/health', '/api/quit', '/health'])
    expect(m.runs.map(r => (r.argv[1] === '--version' ? 'check' : r.argv[2]))).toEqual(['check', '--detach'])
    await clock.advance(1_500)
    expect(String((await pairwatch($, 'status')).text)).toContain(`Viewer page: running at http://localhost:7979/?key=${KEY}`)
  })

  test('model narration waits for a page that shows this session', async ($, on) => {
    const { clock } = world(on, { prefs: NO_PANE })
    const m = machine(on, { server: 'ours' })
    m.page.clients = 2 // pages open, on other sessions
    let asked = 0
    on('model.complete', () => {
      asked += 1
      return { value: { isAnswered: true, text: 'NOW: Claude runs the tests\nWHY: to check the fix', usage: USAGE } }
    })
    on('tool.call', () => bashOk())
    await startSession($)
    await firstTurn($, clock, 'run the tests')
    await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the tests' })
    await clock.advance(4_000)
    expect(asked).toBe(0)

    m.page.watching = 1
    await clock.advance(1_200)
    expect(asked).toBe(1)
  })

  test('a server that does not say who watches counts every open page', async ($, on) => {
    const { clock } = world(on, { prefs: NO_PANE })
    const m = machine(on, { server: 'ours' })
    m.page.watching = undefined
    let asked = 0
    on('model.complete', () => {
      asked += 1
      return { value: { isAnswered: true, text: 'NOW: Claude runs the tests\nWHY: to check the fix', usage: USAGE } }
    })
    on('tool.call', () => bashOk())
    await startSession($)
    await firstTurn($, clock, 'run the tests')
    await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the tests' })
    await clock.advance(2_000)
    expect(asked).toBe(1)
  })

  test('snapshots are written once the server answered; session.end writes the last one again, marked ended', async ($, on) => {
    const { clock } = world(on, { prefs: NO_PANE })
    const m = machine(on, { server: 'ours' })
    on('tool.call', () => bashOk())
    await startSession($)
    await firstTurn($, clock, 'list the files')
    await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List the files' })
    await clock.advance(1_000)
    const live = m.snapshots()
    expect(live.length).toBeGreaterThan(0)
    expect(live.at(-1)).toMatchObject({ sid: SID, cwd: '/work/app', narrator: 'haiku' })
    expect(live.at(-1)?.ended).toBeUndefined()

    await $.session.end({ reason: 'prompt_input_exit', sessionId: SID, resume: { id: SID } })
    const last = m.writes.at(-1)
    expect(last?.path).toBe(`${m.dir}/live/${SID}.json`)
    const ended = JSON.parse(String(last?.text)) as Record<string, unknown>
    expect(ended).toMatchObject({ sid: SID, ended: true, head: live.at(-1)?.head })
    const count = m.writes.length
    await clock.advance(3_000)
    expect(m.writes.length).toBe(count)
  })

  test('the snapshot names the narrator model set, for the page to show', { options: { narratorModel: 'sonnet' } }, async ($, on) => {
    const { clock } = world(on, { prefs: NO_PANE })
    const m = machine(on, { server: 'ours' })
    on('tool.call', () => bashOk())
    await startSession($)
    await firstTurn($, clock, 'list the files')
    await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List the files' })
    await clock.advance(1_000)
    expect(m.snapshots().at(-1)?.narrator).toBe('sonnet')
  })

  test('with the Viewer page setting off nothing is started, fetched or written', { options: { viewer: false } }, async ($, on) => {
    const { clock } = world(on, { prefs: NO_PANE })
    const m = machine(on, { server: 'ours' })
    on('tool.call', () => bashOk())
    await startSession($)
    await firstTurn($, clock, 'list the files')
    await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List the files' })
    await clock.advance(12_000)
    expect((await pairwatch($, '')).text).toBe('Pairwatch is on.')
    expect(String((await pairwatch($, 'status')).text)).toContain('Viewer page: off (the Viewer page setting)')
    await $.session.end({ reason: 'prompt_input_exit', sessionId: SID, resume: { id: SID } })
    expect(m.runs).toEqual([])
    expect(m.fetches).toEqual([])
    expect(m.writes).toEqual([])
  })

  test('/pairwatch status shows the end of viewer.log while the page does not answer', async ($, on) => {
    const { clock } = world(on, { prefs: NO_PANE })
    const lines = Array.from({ length: 8 }, (_, i) => `log line ${i + 1}`)
    lines[6] = `log line 7 ${'x'.repeat(700)}`
    const m = machine(on, { startsUp: false, files: { '/home/ana/.claude/pairwatch/viewer.log': `${lines.join('\n')}\n` } })
    await startSession($)
    await clock.advance(2_000)
    expect(m.runs.length).toBe(2)
    const status = String((await pairwatch($, 'status')).text)
    expect(status).toContain('Viewer page: not answering on port 7979')
    expect(status).toContain('Last lines of `/home/ana/.claude/pairwatch/viewer.log`')
    expect(status).toContain('log line 8')
    expect(status).not.toContain('log line 3')
    const block = status.slice(status.indexOf('```') + 3, status.lastIndexOf('```')).trim()
    expect(block.length).toBeLessThanOrEqual(600)
  })
})

describe('Why?', () => {
  test('asks the session model through a fork and shows its answer', async ($, on) => {
    const { written } = world(on)
    let prompt = ''
    on('model.fork', ($, e) => {
      prompt = e.prompt
      return { value: { isAnswered: true, text: 'I am running the login tests to check the redirect fix.', usage: USAGE } }
    })
    const ui = await mountPane($, 'vscode')
    await ui.press({ key: 'why' })
    expect(prompt.length).toBeGreaterThan(0)
    const asks = written('ask') as { status: string; text?: string }[]
    expect(asks.map(a => a.status)).toEqual(['asking', 'answered'])
    expect(asks.at(-1)?.text).toBe('I am running the login tests to check the redirect fix.')
    expect((await ui.find({ type: 'Markdown', key: 'ask' }))?.text).toContain('running the login tests')
    await ui.unmount()
  })

  test('with nothing to fork it answers “Nothing to explain yet.”', async ($, on) => {
    const { written } = world(on)
    on('model.fork', () => ({ value: { isAnswered: false, reason: 'nothing-to-fork' } }))
    const ui = await mountPane($, 'terminal')
    await ui.press({ key: 'why' })
    expect((written('ask') as { text?: string }[]).at(-1)?.text).toBe('Nothing to explain yet.')
    await ui.unmount()
  })

  test('one question per 20 s, from the pane and the page alike', async ($, on) => {
    const { clock } = world(on, { prefs: NO_PANE })
    const m = machine(on, { server: 'ours' })
    let forks = 0
    on('model.fork', () => {
      forks += 1
      return { value: { isAnswered: true, text: 'Because the tests must pass first.', usage: USAGE } }
    })
    await startSession($)
    await clock.advance(1_000)
    const ui = await mountPane($, 'vscode')
    await ui.press({ key: 'why' })
    await ui.press({ key: 'why' })
    m.page.actions.push({ action: 'why', at: T0 })
    await clock.advance(1_000)
    expect(m.page.actions).toEqual([]) // the page's press was collected, and asked nothing
    expect(forks).toBe(1)
    await clock.advance(20_000)
    await ui.press({ key: 'why' })
    expect(forks).toBe(2)
    await ui.unmount()
  })
})

describe('observers change nothing', () => {
  test('turn.step passes every chunk through unchanged and in order, and its result', async ($, on) => {
    const { clock, written } = world(on)
    // no `engine` chunks: the kit refuses one a link did not pull from beneath it
    const chunks: TurnStepChunk[] = [
      { kind: 'thinking', index: 0, text: 'The user wants the files ' },
      { kind: 'thinking', index: 0, text: 'listed.' },
      { kind: 'text', index: 1, text: 'Listing ' },
      { kind: 'text', index: 1, text: 'the files.' },
      { kind: 'tool', index: 2, id: 'toolu_ls', name: 'Bash' },
      { kind: 'input', index: 2, json: '{"command":"ls"}' },
      { kind: 'stop', stopReason: 'tool_use', usage: null },
    ]
    const result: TurnStepResult = {
      turnId: 'turn-1',
      index: 0,
      answer: 'Listing the files.',
      toolUses: [{ name: 'Bash', input: { command: 'ls' } }],
      stopReason: 'tool_use',
      usage: null,
    }
    on('turn.step', async function* () {
      for (const chunk of chunks) yield chunk
      return result
    })
    await startSession($)
    const it = $.turn.step({ turnId: 'turn-1', index: 0, model: 'm', messageCount: 1 })[Symbol.asyncIterator]()
    const seen: unknown[] = []
    let returned: unknown
    for (;;) {
      const step = await it.next()
      if (step.done === true) {
        returned = step.value
        break
      }
      seen.push(step.value)
    }
    expect(seen).toEqual(chunks)
    expect(returned).toEqual(result)
    await clock.advance(500)
    // each finished block reached the model: the text as what Claude said, the thinking as its thought
    const model = written('model').at(-1) as { said?: { text: string }; thought?: { text: string } }
    expect(model.said?.text).toBe('Listing the files.')
    expect(model.thought?.text).toContain('The user wants the files listed.')
  })

  test('tool.call hands back the result it got: answered, errored and denied', async ($, on) => {
    const { clock } = world(on)
    const answers = new Map<string, ToolCallResult>([
      // (isReadOnly is left out: the kit does not relay it from a test hook, plugin or none)
      ['echo ok', { result: { stdout: 'ok\n', stderr: '', interrupted: false }, text: 'ok' }],
      ['false', { isError: true, result: 'Exit code 1', text: 'Exit code 1' }],
      ['rm -rf build', { deny: 'not in this repo' }],
    ])
    on('tool.call', ($, e) => answers.get(String((e as { command?: unknown }).command)) ?? { deny: 'unexpected' })
    await startSession($)
    for (const [command, result] of answers) {
      expect(await $.tool.call({ tool: 'Bash', command, description: `Run ${command}` })).toEqual(result)
    }
    const write = await $.tool.call({ tool: 'Write', file_path: '/work/app/big.txt', content: 'x'.repeat(10_000) })
    expect(write).toEqual({ deny: 'unexpected' })
    await clock.advance(500)
  })

  test('agent.spawn and SubagentStop pass through', async ($, on) => {
    const { clock } = world(on)
    on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-7' }))
    on('classic.SubagentStop', () => ({}))
    await startSession($)
    const spawned = await $.agent.spawn({
      tool_use_id: 'toolu_agent',
      prompt: 'Find where the login redirect is decided',
      description: 'Find the redirect',
      subagentType: 'Explore',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'm',
      background: true,
      fork: false,
    })
    expect(spawned).toEqual({ model: 'haiku', agentId: 'agent-7' })
    const stopped = await $.classic.SubagentStop({
      stop_hook_active: false,
      agent_id: 'agent-7',
      agent_transcript_path: '/t/agent-7.jsonl',
      agent_type: 'Explore',
      last_assistant_message: 'It is decided in auth/login.py.',
    })
    expect(stopped).toEqual({})
    await clock.advance(500)
  })

  test('a permission ask and a sub-agent reach the model', async ($, on) => {
    const { clock, written } = world(on)
    on('tool.check', () => ({ decision: 'ask' }))
    on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-7' }))
    on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }))
    await startSession($)
    await firstTurn($, clock, 'clean the build folder')
    expect(await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 'toolu_rm' })).toEqual({ decision: 'ask' })
    await clock.advance(500)
    type M = { steps: { tool: string; station: string; agentId?: string }[]; agents: { id: string }[] }
    expect((written('model').at(-1) as M).steps.some(s => s.tool === '#permission' && s.station === 'ask')).toBe(true)

    await $.agent.spawn({
      tool_use_id: 'toolu_agent',
      prompt: 'Find where the login redirect is decided',
      description: 'Find the redirect',
      subagentType: 'Explore',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'm',
      background: false,
      fork: false,
    })
    // a call inside the sub-agent's loop (agentId is the engine's to stamp, so it is not in the call's type)
    const inAgent = { tool: 'Read' as const, file_path: '/work/app/auth/login.py', agentId: 'agent-7' }
    await $.tool.call(inAgent)
    await clock.advance(500)
    const model = written('model').at(-1) as M
    expect(model.agents.map(a => a.id)).toContain('agent-7')
    expect(model.steps.some(s => s.agentId === 'agent-7' && s.station === 'read')).toBe(true)
  })

  test('in auto mode an ask goes to the classifier: no “Waiting for your OK” on stage', async ($, on) => {
    const { clock, written } = world(on)
    on('tool.check', () => ({ decision: 'ask' }))
    on('classic.UserPromptSubmit', () => ({}))
    await startSession($)
    await firstTurn($, clock, 'clean the build folder')
    await $.classic.UserPromptSubmit({ session_id: 's1', transcript_path: '/t/s1.jsonl', cwd: '/work/app', permission_mode: 'auto', prompt: 'clean the build folder' })
    await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 'toolu_rm' })
    await clock.advance(500)
    type M = { steps: { tool: string }[] }
    expect((written('model').at(-1) as M).steps.some(s => s.tool === '#permission')).toBe(false)
    await $.classic.UserPromptSubmit({ session_id: 's1', transcript_path: '/t/s1.jsonl', cwd: '/work/app', permission_mode: 'default', prompt: 'now ask me' })
    await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf dist' }, tool_use_id: 'toolu_rm2' })
    await clock.advance(500)
    expect((written('model').at(-1) as M).steps.some(s => s.tool === '#permission')).toBe(true)
  })

  test('/clear starts the stage blank and the pump keeps going', async ($, on) => {
    const { clock, written } = world(on)
    on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }))
    await startSession($)
    await firstTurn($, clock, 'list the files')
    await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List the files' })
    await clock.advance(500)
    type M = { steps: unknown[] }
    expect((written('model').at(-1) as M).steps.length).toBeGreaterThan(0)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    await clock.advance(500)
    expect((written('model').at(-1) as M).steps).toEqual([])
    expect(written('narration').at(-1)).toBeNull()
    await $.prompt.submit({ text: 'start over', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'start over', turnId: 'turn-2' })
    await clock.advance(500)
    expect((written('model').at(-1) as M).steps.length).toBeGreaterThan(0)
  })

  test('session.end saves what was met and stops the pump', async ($, on) => {
    const { clock, stored } = world(on)
    await startSession($)
    await clock.advance(500)
    await $.session.end({ reason: 'other', sessionId: 's1', resume: { id: 's1' } })
    const before = stored.length
    await clock.advance(2_000)
    expect(stored.length).toBe(before)
  })
})
