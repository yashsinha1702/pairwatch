// narrate.ts: the narrator's prompt, its reply parser and the rule-based fallback.
// Run: node --test dev/spec/narrate.spec.ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Activity, SessionModel } from '../../pairwatch/types'
import { buildNarrationPrompt, NARRATOR_SYSTEM, parseNarration, redact, rulesNarration, whyForkPrompt } from '../../pairwatch/hooks/core/narrate.ts'
import { E, fullTurn, play, s } from './core.fixtures.ts'

const act = (m: SessionModel, stepId: string): Activity => m.activities.find(a => a.stepIds.includes(stepId))!

// Fake secrets, built in pieces so no scanner mistakes this file for one holding real keys.
const ANT_KEY = 'sk-' + 'ant-api03-' + 'AbCdEf0123456789xyzXYZ'
const GH_TOKEN = 'gh' + 'p_' + 'abcdefghijklmnopqrstuvwxyz0123456789'
const JWT = 'eyJ' + 'hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'

describe('NARRATOR_SYSTEM', () => {
  it('is long enough to cache (>= 700 tokens, estimated generously)', () => {
    const words = NARRATOR_SYSTEM.split(/\s+/).length
    assert.ok(words >= 700, `${words} words`)
    assert.ok(NARRATOR_SYSTEM.length >= 4000, `${NARRATOR_SYSTEM.length} chars`)
  })

  it('covers the role, the style, the levels, the format and four examples', () => {
    for (const must of ['learner', 'plain words', 'present tense', 'probably', 'Never invent', 'no markdown', 'beginner', 'intermediate', 'expert', 'NOW: <', 'WHY: <', '25 words', '30 words']) {
      assert.ok(NARRATOR_SYSTEM.includes(must), must)
    }
    assert.match(NARRATOR_SYSTEM, /Never write "I" or "we"/)
    for (const n of [1, 2, 3, 4]) assert.ok(NARRATOR_SYSTEM.includes(`Example ${n},`), `example ${n}`)
    for (const kind of ['a read', 'a search', 'a test run that fails', 'a delegation']) assert.ok(NARRATOR_SYSTEM.includes(kind), kind)
  })
})

describe('buildNarrationPrompt', () => {
  const batches = fullTurn()
  const m = play(batches.slice(0, 11)) // up to the failing test run

  it('holds LEVEL, GOAL, CLAUDE SAID, RECENT STEPS and CURRENT', () => {
    const p = buildNarrationPrompt(m, act(m, 't1'), 1)
    const lines = p.split('\n')
    assert.equal(lines[0], 'LEVEL: beginner')
    assert.ok(lines.includes('GOAL: “After I sign in I land on a blank page. Fix the redirect.”'), p)
    assert.ok(lines.includes('CLAUDE SAID: “Let me find where the redirect is built.”'), p)
    assert.ok(lines.includes('RECENT STEPS:'), p)
    assert.ok(lines.includes('✓ Searching for “redirect” — 3 matches'), p)
    assert.ok(lines.includes('CURRENT: Running the tests'), p)
    assert.ok(lines.includes('  run: pytest tests/test_auth.py -q'), p)
    assert.ok(lines.includes('  status: failed after 4s — FAILED tests/test_auth.py::test_redirect - AssertionError'), p)
  })

  it('times a running activity and names the level', () => {
    const m2 = play(batches.slice(0, 10))
    const p = buildNarrationPrompt(m2, act(m2, 't1'), 3, s(25))
    assert.ok(p.startsWith('LEVEL: expert\n'))
    assert.ok(p.includes('  status: running for 12s'), p)
    assert.ok(buildNarrationPrompt(m2, act(m2, 't1'), 2).startsWith('LEVEL: intermediate\n'))
  })

  it('marks recent steps ✓ ✗ ▶ and keeps only the last 6', () => {
    const many = [[E.turnStart('t', s(0)), E.prompt('go', s(0))]]
    for (let i = 0; i < 9; i++) many.push([E.start(`g${i}`, 'Grep', { pattern: `p${i}` }, s(10 * i + 1))], [E.end(`g${i}`, i === 7 ? 'error' : 'ok', 'no such file', s(10 * i + 2))])
    many.push([E.start('x', 'Bash', { command: 'ls' }, s(200))])
    const mm = play(many)
    const p = buildNarrationPrompt(mm, act(mm, 'x'), 1)
    const recent = p.split('\n').filter(l => /^[✓✗▶] /.test(l))
    assert.equal(recent.length, 6)
    assert.equal(recent[0], '✓ Searching for “p3” — 3 matches')
    assert.equal(recent[4], '✗ Searching for “p7” — no such file')
  })

  it('stays within its limits however long the inputs', () => {
    const huge = 'word '.repeat(20_000)
    const big = play(
      [[E.turnStart('t', s(0)), E.prompt(huge, s(0))], [E.say(huge, s(1)), E.think(huge, s(1))], ...Array.from({ length: 30 }, (_, i) => [E.start(`b${i}`, 'Bash', { command: `${'x'.repeat(5000)} ${i}` }, s(2 + i / 10))])],
    )
    const cur = big.activities.at(-1)!
    assert.ok(cur.stepIds.length > 5, 'many steps in one activity')
    const p = buildNarrationPrompt(big, cur, 1)
    assert.ok(p.length <= 6000, `${p.length} chars`)
    const line = (label: string) => p.split('\n').find(l => l.startsWith(label)) ?? ''
    assert.ok(line('GOAL: ').length - 'GOAL: '.length <= 400)
    assert.ok(line('CLAUDE SAID: ').length - 'CLAUDE SAID: '.length <= 300)
    const current = p.slice(p.indexOf('CURRENT: ')).split('\n').slice(1).filter(l => !l.startsWith('  status:'))
    assert.ok(current.join('\n').length <= 620, `current block ${current.join('\n').length}`)
  })

  it('redacts secrets in every part of the prompt', () => {
    const leaky = play([
      [E.turnStart('t', s(0)), E.prompt(`Use the key ${ANT_KEY} to call the API`, s(0))],
      [E.say(`I will export GITHUB_TOKEN=${GH_TOKEN} first.`, s(1))],
      [E.start('b', 'Bash', { command: `curl -H "Authorization: Bearer ${JWT}" https://api.example.com/v1 --data password=hunter2` }, s(2))],
    ])
    const p = buildNarrationPrompt(leaky, act(leaky, 'b'), 1)
    for (const secret of [ANT_KEY, GH_TOKEN, JWT.slice(0, 20), 'hunter2']) assert.ok(!p.includes(secret), secret)
    assert.ok(p.includes('https://api.example.com/v1'), 'the rest of the command stays')
    assert.ok(p.includes('GITHUB_TOKEN=••••') && p.includes('sk-ant-••••'), 'each secret keeps its label')
  })
})

describe('redact (redact.ts, as the narrator uses it; dev/spec/redact.spec.ts covers every rule)', () => {
  it('hides each kind of secret', () => {
    const proj = 'sk-' + 'proj-' + 'AbCdEfGh1234567890abcd'
    const gh = 'gh' + 'p_' + '0123456789abcdefghijABCDEFGHIJ'
    const slack = 'xo' + 'xb-' + '1234567890-abcdefghij'
    const cases: [string, string][] = [
      [`key ${proj} ok`, proj],
      [`token ${gh}`, gh],
      [`slack ${slack}`, slack],
      [`aws ${'AKIA' + 'IOSFODNN7EXAMPLE'} id`, 'AKIA' + 'IOSFODNN7EXAMPLE'],
      ['header Authorization: Bearer abc.def-ghi_jkl', 'abc.def-ghi_jkl'],
      ['login password=s3cret! now', 's3cret!'],
      ['DB_PASSWORD: "p@ss word"', 'p@ss word'],
      ['api_key=1234abcd', '1234abcd'],
      ['hash 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', '2cf24dba5fb0a30e26e83b2ac5b9e29e'],
      ['blob QWxhZGRpbjpvcGVuIHNlc2FtZQ9xYWxhZGRpbjpvcGVuIHNlc2FtZQ== end', 'QWxhZGRpbjpvcGVuIHNlc2FtZQ9xYWxh'],
      ['url https://user:hunter2@example.com/x', 'hunter2'],
    ]
    for (const [text, secret] of cases) {
      const out = redact(text)
      assert.ok(!out.includes(secret), `${text} -> ${out}`)
      assert.ok(out.includes('••••'), out)
    }
  })

  it('leaves ordinary text, paths and identifiers alone', () => {
    const plain = [
      'pytest tests/test_auth.py::test_redirect_after_login_when_session_expired -q',
      '/home/ana/shop/src/hooks/core/timeline.ts',
      'max_tokens=1024 and the token count is fine',
      'Basic authentication is configured',
      'run id 3f2a9c1e-7b4d-4e8a-9c3f-1a2b3c4d5e6f',
      'git checkout abc1234',
    ]
    for (const t of plain) assert.equal(redact(t), t)
    assert.equal(redact(''), '')
    assert.equal(redact(undefined as unknown as string), '')
  })
})

describe('parseNarration', () => {
  it('reads a good reply', () => {
    assert.deepEqual(parseNarration('NOW: Claude is reading login.py to find the redirect.\nWHY: Reading first means the fix matches the real code.'), {
      now: 'Claude is reading login.py to find the redirect.',
      why: 'Reading first means the fix matches the real code.',
    })
  })

  it('reads a messy reply: a preface, bold labels, code, quotes, extra lines', () => {
    const reply = 'Sure, here it is:\n\n**NOW:** "Claude runs `pytest` on the auth tests,\nwatching for the redirect test."\n**Why**: _To prove_ the fix works.\n\nLet me know if you want more.'
    assert.deepEqual(parseNarration(reply), { now: 'Claude runs pytest on the auth tests, watching for the redirect test.', why: 'To prove the fix works.' })
  })

  it('reads lowercase labels and both on one line', () => {
    assert.deepEqual(parseNarration('now: Claude searches src/ for “getUser”.\nwhy: a rename must reach every caller.'), { now: 'Claude searches src/ for “getUser”.', why: 'a rename must reach every caller.' })
    assert.deepEqual(parseNarration('NOW: Claude edits app.py. WHY: the bug lives there.'), { now: 'Claude edits app.py.', why: 'the bug lives there.' })
    assert.deepEqual(parseNarration('- Now: Claude lists the folder.\n- Why: to see what exists.'), { now: 'Claude lists the folder.', why: 'to see what exists.' })
  })

  it('a missing WHY gives an empty why', () => {
    assert.deepEqual(parseNarration('NOW: Claude is installing the requests package.'), { now: 'Claude is installing the requests package.', why: '' })
  })

  it('no labels: the first one or two sentences', () => {
    assert.deepEqual(parseNarration('Claude is reading the config. It wants the port number. Then it will start the server.'), { now: 'Claude is reading the config. It wants the port number.', why: '' })
    assert.deepEqual(parseNarration('Claude checks the GPU memory.\nWHY: the model needs 20 GB free.'), { now: 'Claude checks the GPU memory.', why: 'the model needs 20 GB free.' })
  })

  it('cuts each part to 240 characters', () => {
    const r = parseNarration(`NOW: ${'very '.repeat(100)}long\nWHY: ${'quite '.repeat(100)}long`)!
    assert.ok(r.now.length <= 240 && r.now.endsWith('…'))
    assert.ok(r.why.length <= 240 && r.why.endsWith('…'))
  })

  it('returns null for empty, refusal and meta replies', () => {
    for (const bad of ['', '   \n  ', 'NOW:', 'NOW:\nWHY: something', "I cannot narrate this without more context.", 'As an AI, I am unable to see the screen.', "I'm sorry, but I can't help with that.", 'NOW: I cannot tell what Claude is doing.\nWHY: not enough context.', "Here's what is happening in the session", 'There is not enough context to say.']) {
      assert.equal(parseNarration(bad), null, JSON.stringify(bad))
    }
    assert.equal(parseNarration(42 as unknown as string), null)
  })

  it('does not mistake ordinary narration for a refusal', () => {
    assert.ok(parseNarration('NOW: Unfortunately the test failed: the total is off by one.\nWHY: The failure shows exactly what to fix.') !== null)
    assert.ok(parseNarration('NOW: There is not enough free GPU memory, so Claude stops the old server.\nWHY: The new model needs it.') !== null)
  })
})

describe('rulesNarration', () => {
  const m = play(fullTurn())

  it('uses the headline, plus the result once the activity is over, and the latest step’s why', () => {
    const failed = act(m, 't1')
    const n = rulesNarration(m, failed, 123)
    assert.deepEqual(n, { activityId: failed.id, now: 'Running the tests — FAILED tests/test_auth.py::test_redirect - AssertionError', why: 'Tests prove the change works.', source: 'rules', at: 123 })
    const reads = act(m, 'r2')
    assert.equal(rulesNarration(m, reads, 1).now, 'Reading 2 files')
    assert.equal(rulesNarration(m, reads, 1).why, 'Reading the code first shows how it really works.')
  })

  it('leaves the result off while running', () => {
    const live = play(fullTurn().slice(0, 10))
    assert.equal(rulesNarration(live, act(live, 't1'), 1).now, 'Running the tests')
  })

  it('tolerates an activity with no steps left', () => {
    const ghost: Activity = { id: 'gone', station: 'run', stepIds: ['nope'], headline: 'Running 3 commands', status: 'ok', startedAt: 0 }
    assert.deepEqual(rulesNarration(m, ghost, 5), { activityId: 'gone', now: 'Running 3 commands', why: '', source: 'rules', at: 5 })
  })
})

describe('whyForkPrompt', () => {
  it('asks for a first-person, plain, tool-free answer ending in a Lesson line', () => {
    for (const level of [1, 2, 3] as const) {
      const p = whyForkPrompt(level)
      assert.match(p, /first person/)
      assert.match(p, /2–4 plain sentences/)
      assert.match(p, /Do not call any tools/)
      assert.match(p, /Lesson: </)
    }
  })

  it('adapts to the level', () => {
    assert.match(whyForkPrompt(1), /beginner/)
    assert.match(whyForkPrompt(2), /trade-off/)
    assert.match(whyForkPrompt(3), /expert/)
    assert.notEqual(whyForkPrompt(1), whyForkPrompt(3))
  })
})
