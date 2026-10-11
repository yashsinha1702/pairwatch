// timeline.ts: RawEvents in, SessionModel out. Run: node --test dev/spec/timeline.spec.ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { RawEvent, SessionModel } from '../../pairwatch/types'
import { activityScene, currentActivity, emptyModel, HOP_MS, LIMITS, normalizePath, reduce, reduceWith, settleHop, stepsOf, THINK_DELAY_MS, trail } from '../../pairwatch/hooks/core/timeline.ts'
import { byId, E, fakeDeps, fullTurn, invariantProblems, nonJson, play, s, statusOf, T0, timeOf } from './core.fixtures.ts'

const ctx = (now: number) => ({ level: 1 as const, cwd: '/proj', now })
const activityOf = (m: SessionModel, stepId: string) => m.activities.find(a => a.stepIds.includes(stepId))

describe('a full turn', () => {
  const m = play(fullTurn())

  it('keeps the model consistent', () => {
    assert.deepEqual(invariantProblems(m), [])
  })

  it('opens with the prompt: goal, a turn, a #prompt step', () => {
    assert.equal(m.goal?.text, 'After I sign in I land on a blank page. Fix the redirect.')
    assert.equal(m.stats.turns, 1)
    const p = m.steps[0]!
    assert.equal(p.tool, '#prompt')
    assert.equal(p.station, 'think')
    assert.equal(p.headline, 'Reading your request')
    assert.equal(p.target, 'After I sign in I land on a blank page. Fix the redirect.')
    assert.equal(m.turn?.id, 'turn-1')
    assert.equal(m.turn?.isRunning, false)
  })

  it('counts the work', () => {
    assert.deepEqual({ ...m.stats, startedAt: 0 }, { steps: 7, edits: 2, commands: 3, errors: 1, turns: 1, startedAt: 0 })
    const tools = m.steps.filter(x => !x.tool.startsWith('#')).map(x => `${x.id}:${x.status}`)
    assert.deepEqual(tools, ['g1:ok', 'r1:ok', 'r2:ok', 'e1:ok', 't1:error', 'e2:ok', 't2:ok'])
  })

  it('drops think gaps shorter than THINK_DELAY_MS and keeps the long one', () => {
    const thinks = m.steps.filter(x => x.tool === '#think')
    assert.equal(thinks.length, 1)
    assert.equal(thinks[0]!.startedAt, s(5.5))
    assert.equal(thinks[0]!.status, 'ok')
    assert.equal(m.thought?.text, 'The next_url is never checked, so an empty value sends people to a blank page.')
  })

  it('groups the two reads into one activity with an aggregated headline', () => {
    const a = activityOf(m, 'r1')!
    assert.deepEqual(a.stepIds, ['r1', 'r2'])
    assert.equal(a.headline, 'Reading 2 files')
    assert.equal(a.status, 'ok')
    assert.equal(a.station, 'read')
    assert.deepEqual(activityScene(m, a), { kind: 'read', files: [{ path: '/proj/src/auth/login.py' }, { path: '/proj/src/auth/session.py' }] })
  })

  it('a single step keeps its own headline; activities follow the work', () => {
    assert.equal(activityOf(m, 'g1')!.headline, 'Searching for “redirect”')
    assert.deepEqual(
      m.activities.map(a => a.station),
      ['think', 'search', 'read', 'think', 'edit', 'run', 'edit', 'run', 'talk', 'done'],
    )
    assert.equal(activityOf(m, 't1')!.status, 'error')
  })

  it('appends agent-craft concepts where each pattern completes', () => {
    const has = (id: string, c: string) => byId(m, id)!.concepts.includes(c)
    assert.ok(has('r1', 'search-then-read'), 'Read right after a search')
    assert.ok(!has('r2', 'search-then-read'), 'the second read follows a read')
    assert.ok(has('r2', 'parallel-tool-calls'), 'second start before any end')
    assert.ok(!has('r1', 'parallel-tool-calls'))
    assert.ok(has('e1', 'read-before-edit'), 'login.py was read first')
    assert.ok(has('t1', 'verify-after-change'), 'test after an edit')
    assert.ok(has('e2', 'learning-from-errors'), 'step right after the failed test')
    assert.ok(has('t2', 'verify-after-change'), 'test after the second edit')
    assert.ok(!has('g1', 'learning-from-errors'))
    assert.equal(byId(m, 'r1')!.concepts[0], 'reading-code', 'explainer concepts stay first')
  })

  it('ends with #talk (the answer) and #done (the recap)', () => {
    const talk = m.steps.find(x => x.tool === '#talk')!
    assert.equal(talk.station, 'talk')
    assert.equal(talk.startedAt, s(25), 'starts when the answer began streaming')
    assert.equal(talk.scene.kind, 'talk')
    assert.equal(talk.resultNote, 'Fixed the redirect in login.py.')
    const done = m.steps.at(-1)!
    assert.equal(done.tool, '#done')
    assert.deepEqual(done.scene, { kind: 'done', steps: 7, files: 2, seconds: 30, errors: 1 })
    assert.equal(done.headline, 'Done: 7 steps, 2 files in 30s')
    assert.ok(done.concepts.includes('code-review'), 'there were edits to review')
    assert.equal(m.currentId, activityOf(m, done.id)!.id)
    assert.equal(m.said?.text, 'Fixed the redirect in login.py. All 5 tests pass.')
  })

  it('tracks files from Read / Edit, most recent first', () => {
    assert.deepEqual(
      m.files.map(f => [f.path, f.reads, f.edits]),
      [
        ['/proj/src/auth/login.py', 1, 2],
        ['/proj/src/auth/session.py', 1, 0],
      ],
    )
  })

  it('gives the stage a trail of {station, status}', () => {
    const t = trail(m)
    assert.equal(t.length, m.steps.length)
    assert.deepEqual(t[6], { station: 'run', status: 'error' })
    assert.deepEqual(t.at(-1), { station: 'done', status: 'ok' })
  })

  it('is plain JSON: no undefined, NaN or functions anywhere', () => {
    assert.deepEqual(nonJson(m), [])
  })

  it('survives a JSON round trip between every batch ($.state, hot reload)', () => {
    assert.deepEqual(play(fullTurn(), { roundTrip: true }), m)
  })

  it('bumps rev on every change and returns the same object when nothing changes', () => {
    assert.ok(m.rev >= fullTurn().length)
    assert.equal(reduceWith(fakeDeps, m, [], ctx(s(31))), m)
    assert.equal(reduceWith(fakeDeps, m, [E.end('t2', 'ok', 'again', s(31))], ctx(s(31))), m, 'a duplicate end changes nothing')
  })
})

describe('events in other orders', () => {
  it('a prompt that arrives before its turn-start is one turn, with the real id', () => {
    const m = play([[E.prompt('Hello', s(0)), E.turnStart('t-9', s(0.2))]])
    assert.equal(m.stats.turns, 1)
    assert.equal(m.turn?.id, 't-9')
    assert.equal(m.steps.filter(x => x.tool === '#prompt').length, 1)
  })

  it('a turn without a prompt (a continuation) still opens with a step', () => {
    const m = play([[E.turnStart('t-2', s(0))]])
    assert.equal(m.steps[0]?.headline, 'Continuing the work')
    assert.equal(m.goal, undefined)
  })

  it('a message typed during a turn joins it', () => {
    const m = play([[E.turnStart('t-1', s(0)), E.prompt('first', s(0.1))], [E.prompt('also check the logout page', s(5))]])
    assert.equal(m.stats.turns, 1)
    assert.equal(m.goal?.text, 'also check the logout page')
    assert.equal(m.steps.filter(x => x.tool === '#prompt').at(-1)?.headline, 'Reading your new message')
  })

  it('a background task notification does not replace the goal', () => {
    const m = play([
      [E.turnStart('t-1', s(0)), E.prompt('Build the image', s(0))],
      [E.turnEnd('t-1', s(5), { answer: 'Started the build.' })],
      [E.turnStart('t-2', s(60)), E.prompt('<task-notification><summary>Background command “docker build” completed</summary></task-notification>', s(60), 'task-notification')],
    ])
    assert.equal(m.goal?.text, 'Build the image')
    const p = m.steps.filter(x => x.tool === '#prompt').at(-1)!
    assert.equal(p.target, 'Background command “docker build” completed')
    assert.ok(p.concepts.includes('background-tasks'))
    assert.equal(m.stats.turns, 2)
  })

  it('a turn with no tool calls: think, then the answer, then the recap', () => {
    const m = play([[E.turnStart('t-1', s(0)), E.prompt('What does HTTP 418 mean?', s(0))], [E.stream('thinking', s(0.5))], [E.stream('text', s(4))], [E.say('It is the “I’m a teapot” joke status.', s(6)), E.turnEnd('t-1', s(6.1), { answer: 'It is the “I’m a teapot” joke status.', durationMs: 6100 })]])
    assert.deepEqual(
      m.steps.map(x => x.tool),
      ['#prompt', '#talk', '#done'],
    )
    assert.equal(byId(m, m.steps[1]!.id)!.startedAt, s(0.5), 'the answer spans the thinking and the writing')
    assert.equal(m.steps.at(-1)!.headline, 'Answered in 6s')
    assert.deepEqual(m.steps.at(-1)!.scene, { kind: 'done', steps: 0, files: 0, seconds: 6, errors: 0 })
    assert.equal(currentActivity(m)?.station, 'done')
    assert.deepEqual(invariantProblems(m), [])
  })

  it('an aborted turn closes what was running', () => {
    const m = play([[E.turnStart('t-1', s(0)), E.prompt('go', s(0))], [E.start('b1', 'Bash', { command: 'sleep 100' }, s(1))], [E.turnEnd('t-1', s(3), { reason: 'aborted' })]])
    assert.equal(statusOf(m, 'b1'), 'denied')
    const done = m.steps.at(-1)!
    assert.equal(done.status, 'denied')
    assert.match(done.headline, /^Stopped/)
    assert.ok(!m.steps.some(x => x.status === 'running'))
  })
})

describe('the stage: current activity, hop, think delay', () => {
  it('sets a hop when the station changes and settleHop drops it after HOP_MS', () => {
    const m1 = play([[E.turnStart('t', s(0)), E.prompt('find it', s(0))]])
    const now = s(2) + 50
    const m2 = reduceWith(fakeDeps, m1, [E.start('g', 'Grep', { pattern: 'x' }, s(2))], ctx(now))
    assert.equal(currentActivity(m2)?.station, 'search')
    assert.deepEqual(m2.hop, { from: 'think', to: 'search', until: now + HOP_MS })
    assert.equal(settleHop(m2, now + HOP_MS - 1), m2, 'still hopping: same object')
    const m3 = settleHop(m2, now + HOP_MS + 1)
    assert.equal(m3.hop, undefined)
    assert.ok(!('hop' in m3), 'no undefined key left behind (plain JSON)')
    assert.equal(m3.rev, m2.rev + 1)
    assert.equal(settleHop(m3, now + 10_000), m3)
  })

  it('a think gap goes on stage only once it has lasted THINK_DELAY_MS', () => {
    const m1 = play([[E.turnStart('t', s(0)), E.prompt('go', s(0))], [E.start('g', 'Grep', { pattern: 'x' }, s(1))], [E.end('g', 'ok', 'hit', s(1.2))]])
    const m2 = reduceWith(fakeDeps, m1, [E.stream('thinking', s(2))], ctx(s(2) + 100))
    assert.equal(currentActivity(m2)?.station, 'search', 'a young think stays off stage')
    assert.equal(trail(m2).length, trail(m1).length, 'and off the trail')
    const m3 = settleHop(m2, s(2) + THINK_DELAY_MS + 10)
    assert.equal(currentActivity(m3)?.station, 'think')
    assert.equal(m3.hop?.to, 'think')
    assert.equal(m3.hop?.from, 'search')
  })

  it('a running ask (a permission prompt) takes the stage; approval hands it back to the tool', () => {
    const m1 = play([[E.turnStart('t', s(0)), E.prompt('clean up', s(0))], [E.start('b1', 'Bash', { command: 'rm -rf build' }, s(1)), E.permission('b1', 'Bash', s(1.1))]])
    const ask = currentActivity(m1)!
    assert.equal(ask.station, 'ask')
    assert.equal(ask.status, 'running')
    const perm = stepsOf(m1, ask)[0]!
    assert.equal(perm.tool, '#permission')
    assert.deepEqual(perm.scene, { kind: 'ask', question: 'Allow: Running rm?', isPermission: true })
    assert.ok(perm.concepts.includes('permissions'))
    assert.equal(m1.hop?.to, 'ask')
    const m2 = play([[E.end('b1', 'ok', '', s(9))]], { model: m1 })
    assert.equal(statusOf(m2, '#permission-b1'), 'ok')
    assert.equal(currentActivity(m2)?.station, 'run', 'approved: the stage shows the command')
    assert.equal(m2.hop?.from, 'ask')
  })

  it('a refusal marks the tool denied (not an error) and keeps the ask on stage', () => {
    const m1 = play([[E.turnStart('t', s(0)), E.prompt('clean up', s(0))], [E.start('b2', 'Bash', { command: 'rm -rf /tmp/x' }, s(1)), E.permission('b2', 'Bash', s(1.1))]])
    const m2 = play([[E.end('b2', 'error', "The user doesn't want to proceed with this tool use.", s(4))]], { model: m1 })
    assert.equal(statusOf(m2, 'b2'), 'denied')
    assert.equal(statusOf(m2, '#permission-b2'), 'denied')
    assert.equal(m2.stats.errors, 0)
    assert.equal(currentActivity(m2)?.station, 'ask')
    assert.equal(currentActivity(m2)?.status, 'denied')
  })

  it('a late or duplicate permission event is ignored', () => {
    const m1 = play([[E.turnStart('t', s(0)), E.prompt('x', s(0))], [E.start('b', 'Bash', { command: 'ls' }, s(1))], [E.end('b', 'ok', '', s(1.5))]])
    assert.equal(reduceWith(fakeDeps, m1, [E.permission('b', 'Bash', s(1.6))], ctx(s(2))), m1)
  })
})

describe('parallel tool calls', () => {
  it('marks the second start of a batch, once per batch', () => {
    const m = play([
      [E.turnStart('t', s(0)), E.prompt('look around', s(0))],
      [E.start('a', 'Read', { file_path: '/proj/a.py' }, s(1)), E.start('b', 'Read', { file_path: '/proj/b.py' }, s(1)), E.start('c', 'Read', { file_path: '/proj/c.py' }, s(1))],
      [E.end('a', 'ok', '', s(1.2)), E.end('b', 'ok', '', s(1.2)), E.end('c', 'ok', '', s(1.2))],
      [E.start('d', 'Read', { file_path: '/proj/d.py' }, s(2))],
      [E.end('d', 'ok', '', s(2.1))],
      [E.start('e', 'Grep', { pattern: 'x' }, s(3)), E.start('f', 'Grep', { pattern: 'y' }, s(3))],
    ])
    const marked = m.steps.filter(x => x.concepts.includes('parallel-tool-calls')).map(x => x.id)
    assert.deepEqual(marked, ['b', 'f'])
    assert.equal(activityOf(m, 'a')!.headline, 'Reading 4 files')
    assert.equal(activityOf(m, 'e')!.headline, 'Searching (2 searches)')
  })

  it('sub-agent calls never count as the main lane’s parallel calls', () => {
    const m = play([
      [E.turnStart('t', s(0)), E.prompt('x', s(0))],
      [E.start('m1', 'Read', { file_path: '/proj/a.py' }, s(1)), E.start('x1', 'Read', { file_path: '/proj/b.py' }, s(1), 'agent-a')],
    ])
    assert.ok(!byId(m, 'x1')!.concepts.includes('parallel-tool-calls'))
  })
})

describe('sub-agent lanes', () => {
  const launch = (): RawEvent[][] => [
    [E.turnStart('t-1', s(0)), E.prompt('Audit the handlers', s(0))],
    [E.start('a1', 'Agent', { description: 'Billing handlers', subagent_type: 'Explore' }, s(1)), E.start('a2', 'Agent', { description: 'User handlers' }, s(1.1))],
    [E.end('a1', 'ok', 'async_launched', s(1.5)), E.end('a2', 'ok', 'async_launched', s(1.6)), E.agentStart('ag1', 'Billing handlers', 'a1', s(1.5), 'Explore'), E.agentStart('ag2', 'User handlers', 'a2', s(1.6))],
    [E.say('Two agents are on it.', s(2)), E.turnEnd('t-1', s(2.5), { answer: 'Two agents are on it.' })],
    [E.start('x1', 'Grep', { pattern: 'login_required' }, s(3), 'ag1'), E.start('y1', 'Read', { file_path: '/proj/users/views.py' }, s(3.2), 'ag2')],
  ]

  it('keeps one delegate activity on stage that lists the lanes', () => {
    const m = play(launch())
    assert.deepEqual(invariantProblems(m), [])
    const cur = currentActivity(m)!
    assert.equal(cur.station, 'delegate')
    assert.equal(cur.agentId, undefined)
    assert.deepEqual(cur.stepIds, ['a1', 'a2'])
    assert.equal(cur.status, 'running', 'helpers still work')
    const scene = stepsOf(m, cur).at(-1)!.scene
    assert.deepEqual(scene, {
      kind: 'delegate',
      agents: [
        { label: 'Billing handlers', type: 'Explore', status: 'running', doing: 'Searching for “login_required”' },
        { label: 'User handlers', type: 'general-purpose', status: 'running', doing: 'Reading views.py' },
      ],
    })
    assert.deepEqual(activityScene(m, cur), scene)
    assert.deepEqual(
      m.agents.map(l => [l.id, l.status, l.doing]),
      [
        ['ag1', 'running', 'Searching for “login_required”'],
        ['ag2', 'running', 'Reading views.py'],
      ],
    )
    assert.ok(m.activities.some(a => a.agentId === 'ag1' && a.station === 'search'), 'lanes keep their own activities')
  })

  it('hands the stage back when the helpers finish', () => {
    const m = play([...launch(), [E.end('x1', 'ok', '', s(4)), E.agentStop('ag1', s(5))], [E.end('y1', 'ok', '', s(6)), E.turnEnd('sub', s(7), { agentId: 'ag2', answer: 'report' })]])
    assert.deepEqual(
      m.agents.map(l => l.status),
      ['done', 'done'],
    )
    const cur = currentActivity(m)!
    assert.equal(cur.station, 'done', 'back to the newest main activity')
    const del = activityOf(m, 'a1')!
    assert.equal(del.status, 'ok')
    assert.equal(del.endedAt, s(7), 'ends when the last helper did')
    assert.equal(m.said?.text, 'Two agents are on it.', 'a helper’s words are not Claude’s')
  })

  it('shows the delegate activity while the main lane waits on a foreground Agent call', () => {
    const m = play([
      [E.turnStart('t', s(0)), E.prompt('x', s(0))],
      [E.start('a9', 'Agent', { description: 'Explore the repo' }, s(1)), E.agentStart('ag9', 'Explore the repo', 'a9', s(1.2))],
      [E.start('z1', 'Read', { file_path: '/proj/README.md' }, s(2), 'ag9')],
    ])
    assert.equal(currentActivity(m)?.station, 'delegate')
    assert.equal(currentActivity(m)?.status, 'running')
  })

  it('keeps the delegation on stage through a long stretch of main-lane work', () => {
    const busy: RawEvent[][] = [...launch()]
    for (let i = 0; i < 120; i++) busy.push([E.start(`m${i}`, 'Grep', { pattern: `q${i}` }, s(10 + i * 10))], [E.end(`m${i}`, 'ok', '', s(10.5 + i * 10))])
    busy.push([E.turnEnd('t-2', s(1300), { answer: 'ok' })])
    const m = play(busy)
    assert.ok(m.steps.length <= LIMITS.steps)
    assert.equal(currentActivity(m)?.station, 'delegate', 'helpers still work, so the stage shows them')
    assert.deepEqual(currentActivity(m)?.stepIds, ['a1', 'a2'])
    assert.deepEqual(invariantProblems(m), [])
  })

  it('a new turn forgets finished helpers but keeps working ones', () => {
    const m = play([...launch(), [E.agentStop('ag1', s(5))], [E.turnStart('t-2', s(10)), E.prompt('next', s(10))]])
    assert.deepEqual(
      m.agents.map(l => l.id),
      ['ag2'],
    )
  })
})

describe('files', () => {
  it('normalises paths against cwd', () => {
    assert.equal(normalizePath('./src/../lib/a.py', '/proj'), '/proj/lib/a.py')
    assert.equal(normalizePath('/abs//x/./y.txt'), '/abs/x/y.txt')
    assert.equal(normalizePath('/dev/null'), '')
    assert.equal(normalizePath('"quoted name.txt"', '/p'), '/p/quoted name.txt')
    assert.equal(normalizePath('*.py', '/p'), '')
  })

  it('counts reads and writes from shell commands', () => {
    const m = play([[E.turnStart('t', s(0)), E.prompt('x', s(0))], [E.start('c1', 'Bash', { command: 'cat src/app.py' }, s(1))], [E.start('c2', 'Bash', { command: "sed -i 's/a/b/' src/app.py" }, s(2))]])
    assert.deepEqual(m.files[0], { path: '/proj/src/app.py', reads: 1, edits: 1, last: s(2) })
  })
})

describe('caps', () => {
  it('keeps steps <= 80, activities <= 30, files <= 40, agents <= 12', () => {
    const batches: RawEvent[][] = [[E.turnStart('t', s(0)), E.prompt('big job', s(0))]]
    for (let i = 0; i < 200; i++) {
      const at = s(1 + i * 10) // 10 s apart: every step is its own activity
      const cmd = i % 2 === 0 ? `cat /proj/f${i}.txt` : `echo ${i}`
      batches.push([E.start(`b${i}`, 'Bash', { command: cmd }, at)], [E.end(`b${i}`, 'ok', 'fine', at + 100)])
    }
    for (let i = 0; i < 20; i++) batches.push([E.agentStart(`ag${i}`, `helper ${i}`, `x${i}`, s(3000 + i)), E.start(`h${i}`, 'Read', { file_path: `/proj/h${i}.md` }, s(3000 + i), `ag${i}`)])
    const m = play(batches)
    assert.ok(m.steps.length <= LIMITS.steps, `steps ${m.steps.length}`)
    assert.ok(m.activities.length <= LIMITS.activities, `activities ${m.activities.length}`)
    assert.ok(m.files.length <= LIMITS.files, `files ${m.files.length}`)
    assert.ok(m.agents.length <= LIMITS.agents, `agents ${m.agents.length}`)
    assert.deepEqual(invariantProblems(m), [])
    assert.equal(m.stats.steps, 220)
    assert.equal(m.steps.at(-1)?.id, 'h19')
    assert.equal(m.agents.at(-1)?.id, 'ag19')
    assert.equal(m.files[0]?.path, '/proj/h19.md')
    assert.ok(m.steps.some(x => x.tool === '#prompt'), 'the running turn keeps its opening step')
  })

  it('the done recap counts a turn longer than the step window exactly', () => {
    const batches: RawEvent[][] = [[E.turnStart('t', s(0)), E.prompt('long one', s(0))]]
    for (let i = 0; i < 150; i++) batches.push([E.start(`q${i}`, 'Grep', { pattern: `p${i}` }, s(1 + i)), E.end(`q${i}`, i % 50 === 0 ? 'error' : 'ok', 'x', s(1.5 + i))])
    batches.push([E.turnEnd('t', s(200), { answer: 'done', durationMs: 200_000 })])
    const done = play(batches).steps.at(-1)!
    assert.deepEqual(done.scene, { kind: 'done', steps: 150, files: 0, seconds: 200, errors: 3 })
  })
})

describe('junk', () => {
  const m0 = play(fullTurn())

  it('ignores junk events without throwing or changing anything', () => {
    const junk = [
      null,
      undefined,
      42,
      'tool-start',
      [],
      {},
      { kind: 'nope' },
      { kind: 'tool-start' },
      { kind: 'tool-start', obs: {} },
      { kind: 'tool-start', obs: { id: '', tool: 'Bash' } },
      { kind: 'tool-start', obs: { id: '#x', tool: 'Bash', args: {}, at: 1 } },
      { kind: 'tool-end', end: { id: 'missing', status: 'ok', preview: '', at: 1 } },
      { kind: 'tool-end', end: null },
      { kind: 'permission' },
      { kind: 'agent-stop', agentId: 'nobody', at: 1 },
      { kind: 'agent-start' },
      { kind: 'say', text: 42 },
      { kind: 'say', text: '', at: 1 },
      { kind: 'turn-start' },
      { kind: 'turn-start', turnId: 'turn-1', at: 1 },
    ] as unknown as RawEvent[]
    assert.equal(reduceWith(fakeDeps, m0, junk, ctx(s(40))), m0)
    assert.equal(reduce(m0, junk, ctx(s(40))), m0)
  })

  it('tolerates odd models and odd context', () => {
    const fromNull = reduceWith(fakeDeps, null as unknown as SessionModel, [E.turnStart('t', s(0))], ctx(s(1)))
    assert.equal(fromNull.stats.turns, 1)
    assert.deepEqual(invariantProblems(fromNull), [])
    const broken = { steps: [null, { id: 3 }], activities: 'x', files: [{}], agents: null, stats: null, rev: 'x' } as unknown as SessionModel
    const fixed = reduceWith(fakeDeps, broken, [E.turnStart('t', s(0))], ctx(s(1)))
    assert.equal(fixed.steps.length, 1)
    assert.deepEqual(invariantProblems(fixed), [])
    assert.equal(reduce(undefined as unknown as SessionModel, [], ctx(1)).rev, 0)
    assert.doesNotThrow(() => reduce(m0, null as unknown as RawEvent[], ctx(1)))
    assert.doesNotThrow(() => reduceWith(fakeDeps, emptyModel(T0), [E.turnStart('t', s(0))], null as unknown as { level: 1; now: number }))
    assert.equal(currentActivity({} as SessionModel), undefined)
    assert.deepEqual(trail({} as SessionModel), [])
    assert.equal(settleHop(null as unknown as SessionModel, 5), null)
  })

  it('survives an explainer that throws or returns junk', () => {
    const angry = {
      explainTool: () => {
        throw new Error('boom')
      },
      applyEnd: () => 'junk' as never,
      bashFiles: () => {
        throw new Error('boom')
      },
    }
    const m = play([[E.turnStart('t', s(0)), E.prompt('x', s(0))], [E.start('b', 'Bash', { command: 'ls' }, s(1))], [E.end('b', 'error', 'ls: cannot access', s(2))]], { deps: angry })
    const b = byId(m, 'b')!
    assert.equal(b.status, 'error')
    const sloppy = {
      ...fakeDeps,
      explainTool: (o: Parameters<typeof fakeDeps.explainTool>[0]) => ({ ...fakeDeps.explainTool(o, { level: 1 }), target: undefined, scene: { kind: 'run' as const, command: 'ls', category: 'other' as const, program: undefined, output: undefined } }),
    }
    const tidy = play([[E.turnStart('t', s(0)), E.prompt('x', s(0))], [E.start('c', 'Bash', { command: 'ls' }, s(1))]], { deps: sloppy })
    assert.deepEqual(nonJson(tidy), [], 'undefined fields from an explainer never reach the model')
    assert.deepEqual(byId(tidy, 'c')!.scene, { kind: 'run', command: 'ls', category: 'other' })
    assert.equal(b.headline, 'Using Bash')
    assert.equal(b.resultNote, 'ls: cannot access')
    assert.deepEqual(invariantProblems(m), [])
  })
})

describe('with the real explain.ts / bash.ts', () => {
  it('runs the full turn and keeps the model valid', () => {
    let m = emptyModel(T0)
    for (const batch of fullTurn()) m = reduce(m, batch, ctx(Math.max(...batch.map(timeOf)) + 50))
    assert.deepEqual(invariantProblems(m), [])
    assert.equal(m.stats.steps, 7)
    assert.equal(m.stats.errors, 1)
    assert.equal(m.steps.at(-1)?.tool, '#done')
    assert.ok(m.steps.every(x => x.concepts.every(c => typeof c === 'string')))
    assert.deepEqual(nonJson(m), [], 'plain JSON even with the real explainer’s scenes')
  })

  it('averages well under 1 ms per event over 2,000 events', () => {
    const events: RawEvent[] = []
    let t = T0
    let turn = 0
    const cmds = [
      'cd /proj && grep -rn "handleLogin" src/ | head -20',
      "sed -n '1,200p' src/auth/login.py",
      'pytest tests/test_auth.py -q 2>&1 | tail -30',
      'python3 - <<\'EOF\'\nimport json\nprint(json.dumps({"a": 1}))\nEOF',
      'git status --short && git diff --stat',
      'nvidia-smi --query-gpu=memory.used --format=csv',
    ]
    while (events.length < 2000) {
      turn++
      events.push(E.turnStart(`t${turn}`, (t += 1000)), E.prompt(`task number ${turn}`, t), E.stream('thinking', (t += 500)))
      for (let i = 0; i < 12; i++) {
        const id = `c${turn}.${i}`
        const lane = i % 4 === 3 ? `ag${turn}` : undefined
        if (i === 2) events.push(E.agentStart(`ag${turn}`, 'helper', id, t))
        events.push(E.think('', (t += 800)))
        if (i % 3 === 0) events.push(E.start(id, 'Read', { file_path: `/proj/src/m${i}.py` }, (t += 200), lane))
        else if (i % 3 === 1) events.push(E.start(id, 'Edit', { file_path: `/proj/src/m${i - 1}.py`, old_string: 'a', new_string: 'b' }, (t += 200), lane))
        else events.push(E.start(id, 'Bash', { command: cmds[(turn + i) % cmds.length]!, description: 'Do a thing' }, (t += 200), lane))
        if (i === 5) events.push(E.permission(id, 'Bash', t + 10))
        events.push(E.end(id, i % 7 === 0 ? 'error' : 'ok', 'some output\nmore', (t += 300)))
      }
      events.push(E.agentStop(`ag${turn}`, (t += 100)), E.stream('text', (t += 100)), E.say('All done here.', (t += 2000)), E.turnEnd(`t${turn}`, (t += 10), { answer: 'All done here.', durationMs: 20_000 }))
    }
    const all = events.slice(0, 2000)
    let m = emptyModel(T0)
    const t0 = performance.now()
    for (let i = 0; i < all.length; i += 4) {
      const batch = all.slice(i, i + 4)
      m = reduce(m, batch, ctx(timeOf(batch.at(-1)!) + 20))
      m = settleHop(m, timeOf(batch.at(-1)!) + 40)
    }
    const perEvent = (performance.now() - t0) / all.length
    assert.deepEqual(invariantProblems(m), [])
    assert.ok(perEvent < 1, `average ${perEvent.toFixed(3)} ms per event`)
    console.log(`# timeline: ${perEvent.toFixed(4)} ms per event over ${all.length} events (real explain.ts)`)
  })
})
