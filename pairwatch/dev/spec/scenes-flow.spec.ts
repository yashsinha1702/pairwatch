// Specs for the flow scenes (plan, ask, tools, think, talk, done, idle).
// Run: node --test dev/spec/scenes-flow.spec.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SceneData, StepStatus } from '../../pairwatch/types'
import type { SceneCtx } from '../../pairwatch/hooks/core/scenes/kit.ts'
import { sceneAsk, sceneDone, sceneIdle, scenePlan, sceneTalk, sceneThink, sceneTools } from '../../pairwatch/hooks/core/scenes/flow.ts'

type Of<K extends SceneData['kind']> = Extract<SceneData, { kind: K }>

// ---------------------------------------------------------------- helpers

const BOX = { x: 24, y: 122, w: 592, h: 90 }
const ctx = (over: Partial<SceneCtx> = {}): SceneCtx => ({
  ...BOX,
  status: 'running',
  isFresh: true,
  isPaused: false,
  color: '#a78bfa',
  uid: 'tu1x-',
  ...over,
})

const STATUSES: readonly StepStatus[] = ['running', 'ok', 'error', 'denied']
/** Every combination of status, fresh and paused. */
const CTXS: readonly SceneCtx[] = STATUSES.flatMap(status =>
  [true, false].flatMap(isFresh => [true, false].map(isPaused => ctx({ status, isFresh, isPaused }))),
)

const items = (n: number, text = (i: number) => `Task number ${i + 1}`): Of<'plan'>['items'] =>
  Array.from({ length: n }, (_, i) => ({ text: text(i), state: i < 2 ? 'done' : i === 2 ? 'doing' : 'todo' }))

/** One drawing per scene shape, each a function of the box. */
const SAMPLES: Record<string, (c: SceneCtx) => string> = {
  plan: c => scenePlan({ kind: 'plan', items: items(7) }, c),
  planFew: c => scenePlan({ kind: 'plan', items: items(3) }, c),
  planEmpty: c => scenePlan({ kind: 'plan', items: [] }, c),
  ask: c => sceneAsk({ kind: 'ask', question: 'Should I keep the old route working for now?', isPermission: false }, c),
  askPermission: c => sceneAsk({ kind: 'ask', question: 'Bash: rm -rf build/ && npm run build', isPermission: true }, c),
  toolsMcp: c => sceneTools({ kind: 'tools', name: 'mcp__docs__create', detail: 'title: “Weekly report”' }, c),
  tools: c => sceneTools({ kind: 'tools', name: 'Artifact', detail: 'publish report.html' }, c),
  skill: c => sceneTools({ kind: 'tools', name: 'Skill', detail: 'pdf' }, c),
  think: c => sceneThink({ kind: 'think', text: 'The redirect drops the next parameter when the session is created.' }, c),
  thinkEmpty: c => sceneThink({ kind: 'think' }, c),
  talk: c => sceneTalk({ kind: 'talk', text: 'I fixed the redirect and added a test. All 48 tests pass.' }, c),
  talkEmpty: c => sceneTalk({ kind: 'talk' }, c),
  done: c => sceneDone({ kind: 'done', steps: 23, files: 7, seconds: 252, errors: 1 }, c),
  idle: c => sceneIdle({ kind: 'idle' }, c),
}

const unescape = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

/** The text content of every <text> element (inner tags dropped, entities decoded). */
const texts = (svg: string): string[] =>
  [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map(m => unescape((m[1] ?? '').replace(/<[^>]+>/g, '')))

/** The <text> elements' opening tags, with their text. */
const textEls = (svg: string): { attrs: string; text: string }[] =>
  [...svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)].map(m => ({ attrs: m[1] ?? '', text: unescape((m[2] ?? '').replace(/<[^>]+>/g, '')) }))

/**
 * A small XML well-formedness check: every '<' opens a valid tag whose attributes are double-quoted,
 * unique and free of '<'; tags balance; text has no raw '>' and every '&' starts an entity.
 * Returns the first problem, or '' when the fragment is fine.
 */
const problem = (svg: string): string => {
  const TAG = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>/y
  const ENTITY = /&(?!(?:amp|lt|gt|quot|#39);)/
  const stack: string[] = []
  let i = 0
  while (i < svg.length) {
    const lt = svg.indexOf('<', i)
    const text = svg.slice(i, lt < 0 ? svg.length : lt)
    if (ENTITY.test(text)) return `bad entity in text: ${text.slice(0, 60)}`
    if (text.includes('>')) return `raw > in text: ${text.slice(0, 60)}`
    if (lt < 0) break
    TAG.lastIndex = lt
    const m = TAG.exec(svg)
    if (m === null) return `bad tag: ${svg.slice(lt, lt + 80)}`
    const [whole, close, name = '', attrs = '', self] = m
    if (ENTITY.test(attrs)) return `bad entity in attributes of <${name}>`
    const names = [...attrs.matchAll(/([\w:-]+)="/g)].map(a => a[1])
    if (new Set(names).size !== names.length) return `duplicate attribute in <${name}${attrs}>`
    if (close) {
      const open = stack.pop()
      if (open !== name) return `</${name}> closes <${open}>`
    } else if (!self) stack.push(name)
    i = lt + whole.length
  }
  return stack.length === 0 ? '' : `unclosed <${stack.join('> <')}>`
}

const assertSafe = (svg: string, c: SceneCtx, label: string): void => {
  assert.equal(typeof svg, 'string', label)
  assert.ok(svg.length > 0, `${label}: empty`)
  assert.equal(problem(svg), '', `${label}: ${problem(svg)}`)
  assert.ok(svg.length < 12000, `${label}: ${svg.length} chars`)
  assert.doesNotMatch(svg, /NaN|undefined|Infinity|\[object/, label)
  // no scripts, handlers or external references in any tag (text may mention them: it is escaped)
  for (const tag of svg.match(/<[^>]*>/g) ?? [])
    assert.doesNotMatch(tag, /^<\/?(script|foreignObject|image|iframe|use|a)\b|\son\w+\s*=|href|https?:|javascript:|@import/i, `${label}: ${tag.slice(0, 80)}`)
  // every id is uid-prefixed, and every url(#...) points at an id defined here
  const ids = [...svg.matchAll(/\bid="([^"]*)"/g)].map(m => m[1] ?? '')
  for (const id of ids) assert.ok(id.startsWith(c.uid), `${label}: id ${id} lacks the uid prefix`)
  for (const m of svg.matchAll(/url\(([^)]*)\)/g)) {
    const ref = m[1] ?? ''
    assert.ok(ref.startsWith('#') && ids.includes(ref.slice(1)), `${label}: url(${ref}) is not a local id`)
  }
  // fonts: nothing under 9, and every text element sized
  for (const el of textEls(svg)) {
    const size = Number(/font-size="([\d.]+)"/.exec(el.attrs)?.[1] ?? 'NaN')
    assert.ok(size >= 9, `${label}: font-size ${size} for “${el.text}”`)
  }
}

const HOSTILE = `<script>alert("x")</script> & 'single' "double" <svg onload="go()"> href='https://evil.example/x.png' ]]> <!-- c --> \u0007bell \u202ebidi \ud800lone`

const HUGE: readonly string[] = [
  'x'.repeat(100_000),
  '&'.repeat(50_000),
  "'".repeat(50_000),
  '"<>&\''.repeat(20_000),
  'e\u0301'.repeat(30_000),
  '😀'.repeat(30_000),
  '中文'.repeat(30_000),
  'word '.repeat(20_000),
  '\u200b'.repeat(50_000),
  'i'.repeat(50_000),
  `${HOSTILE} `.repeat(2000),
]

// ---------------------------------------------------------------- the rules every scene keeps

test('every scene is deterministic', () => {
  for (const [name, draw] of Object.entries(SAMPLES))
    for (const c of CTXS) {
      const a = draw(c)
      const b = draw(structuredClone(c))
      assert.equal(a, b, `${name} ${JSON.stringify(c)}`)
    }
})

test('every scene is well-formed, small, self-contained and uses readable fonts in every state', () => {
  for (const [name, draw] of Object.entries(SAMPLES)) for (const c of CTXS) assertSafe(draw(c), c, `${name} ${c.status} fresh=${c.isFresh} paused=${c.isPaused}`)
})

test('a paused scene has no animation at all, and no loop', () => {
  for (const [name, draw] of Object.entries(SAMPLES))
    for (const c of CTXS.filter(x => x.isPaused)) {
      const svg = draw(c)
      assert.ok(!svg.includes('repeatCount="indefinite"'), `${name} loops while paused`)
      assert.doesNotMatch(svg, /<(animate|animateTransform|animateMotion|set)\b/, `${name} animates while paused`)
    }
})

test('a scene that is not fresh plays no intro (no one-shot animations)', () => {
  for (const [name, draw] of Object.entries(SAMPLES))
    for (const c of CTXS.filter(x => !x.isFresh)) assert.ok(!draw(c).includes('fill="freeze"'), `${name} plays an intro when not fresh`)
})

test('intros start at t = 0 (no begin delay that would show the settled state first)', () => {
  for (const [name, draw] of Object.entries(SAMPLES)) {
    const svg = draw(ctx({ isFresh: true }))
    for (const m of svg.matchAll(/<(animate|animateTransform|animateMotion)\b[^>]*fill="freeze"[^>]*>/g))
      assert.ok(!/\bbegin="/.test(m[0]), `${name}: ${m[0]}`)
  }
})

test('the fragment is placed at the box and clipped to it', () => {
  for (const [name, draw] of Object.entries(SAMPLES)) {
    const c = ctx({ x: 40, y: 130, w: 500, h: 80, uid: 'zz9-' })
    const svg = draw(c)
    assert.ok(svg.startsWith('<g transform="translate(40 130)"'), `${name}: ${svg.slice(0, 60)}`)
    assert.match(svg, /<clipPath id="zz9-[^"]*"><rect x="-3" y="-3" width="506" height="86"\/><\/clipPath>/, name)
    assert.match(svg, /clip-path="url\(#zz9-/, name)
  }
})

test('text from the session is escaped (and stripped of characters SVG cannot hold)', () => {
  const c = ctx()
  const drawn = [
    scenePlan({ kind: 'plan', items: [{ text: HOSTILE, state: 'done' }, { text: HOSTILE, state: 'doing' }, { text: HOSTILE, state: 'todo' }] }, c),
    sceneAsk({ kind: 'ask', question: HOSTILE, isPermission: false }, c),
    sceneAsk({ kind: 'ask', question: HOSTILE, isPermission: true }, c),
    sceneTools({ kind: 'tools', name: HOSTILE, server: HOSTILE, detail: HOSTILE }, c),
    sceneTools({ kind: 'tools', name: 'Skill', detail: HOSTILE }, c),
    sceneThink({ kind: 'think', text: HOSTILE }, c),
    sceneTalk({ kind: 'talk', text: HOSTILE }, c),
  ]
  for (const svg of drawn) {
    assertSafe(svg, c, svg.slice(0, 80))
    assert.ok(!svg.includes('<script') && !svg.includes('<!--') && !svg.includes(']]>'), 'raw markup leaked')
    assert.ok(!/[\u0007\u202e]/.test(svg), 'control or bidi character kept')
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(svg), 'lone surrogate kept')
    assert.ok(texts(svg).some(t => t.includes('<script') || t.includes('<scr')), 'the hostile text should still be shown, escaped')
  }
  // talk has room for three lines: the handler and the URL are shown as words, never as attributes
  const said = texts(sceneTalk({ kind: 'talk', text: HOSTILE }, c)).join(' ')
  assert.ok(said.includes('<svg onload="go()">') && said.includes('https://evil'), said)
})

test('huge and hostile inputs stay under 12 000 characters, well-formed', () => {
  for (const s of HUGE) {
    for (const c of [ctx(), ctx({ isFresh: false, status: 'ok' }), ctx({ w: 300, h: 60 }), ctx({ w: 1200, h: 200 })]) {
      const many = Array.from({ length: 10_000 }, (_, i) => ({ text: s, state: (['done', 'doing', 'todo'] as const)[i % 3] ?? 'todo' }))
      const drawn = [
        scenePlan({ kind: 'plan', items: many }, c),
        scenePlan({ kind: 'plan', items: many.slice(0, 5) }, c),
        sceneAsk({ kind: 'ask', question: s, isPermission: false }, c),
        sceneAsk({ kind: 'ask', question: s, isPermission: true }, c),
        sceneTools({ kind: 'tools', name: s, server: s, detail: s }, c),
        sceneTools({ kind: 'tools', name: `${s}:${s}`, detail: s }, c),
        sceneThink({ kind: 'think', text: s }, c),
        sceneTalk({ kind: 'talk', text: s }, c),
        sceneDone({ kind: 'done', steps: 1e12, files: 1e12, seconds: 1e15, errors: 1e12 }, c),
        sceneIdle({ kind: 'idle' }, c),
      ]
      for (const svg of drawn) assertSafe(svg, c, `${s.slice(0, 12)}… ${svg.slice(0, 40)}`)
    }
  }
})

test('odd input never throws and still draws something safe', () => {
  const odd: unknown[] = [null, undefined, {}, { kind: 'plan' }, { items: 'abc' }, { items: [null, 5, 'x', { text: 5, state: 'weird' }, { state: 'done' }] }, { question: 42, isPermission: 'yes' }, { name: null, server: {}, detail: [] }, { text: { a: 1 } }, { steps: -5, files: NaN, seconds: Infinity, errors: '3' }]
  const oddCtx: unknown[] = [
    null,
    {},
    { x: NaN, y: Infinity, w: -5, h: 0, status: 'weird', isFresh: 'yes', isPaused: 1, color: '"/><script>', uid: '1 <bad> id' },
    { ...BOX, color: 'url(https://x)', uid: '' },
  ]
  const scenes = [scenePlan, sceneAsk, sceneTools, sceneThink, sceneTalk, sceneDone, sceneIdle] as unknown as ((s: unknown, c: unknown) => string)[]
  for (const draw of scenes)
    for (const s of odd)
      for (const c of oddCtx) {
        let svg = ''
        assert.doesNotThrow(() => {
          svg = draw(s, c)
        })
        assert.equal(typeof svg, 'string')
        assert.equal(problem(svg), '', `${draw.name}: ${problem(svg)}`)
        assert.ok(svg.length < 12000)
        assert.ok(!svg.includes('<script') && !svg.includes('https:'), 'ctx.color or uid leaked into the markup')
      }
})

test('each call is fast (well under 1 ms)', () => {
  // The best of three rounds: the specs run in parallel on a shared machine, and a round that
  // another process preempted measures the machine, not the scenes.
  const best = (round: () => number): number => Math.min(round(), round(), round())
  const draws = Object.values(SAMPLES)
  const c = ctx()
  const each = best(() => {
    const t0 = performance.now()
    let n = 0
    for (let i = 0; i < 200; i++) for (const draw of draws) (draw(c), n++)
    return (performance.now() - t0) / n
  })
  assert.ok(each < 0.5, `${each.toFixed(3)} ms per call`)
  const long = 'word '.repeat(20_000)
  const huge: Of<'plan'> = { kind: 'plan', items: items(5000, () => long) } // built once: only the drawing is timed
  const perPlan = best(() => {
    const t1 = performance.now()
    for (let i = 0; i < 50; i++) scenePlan(huge, c)
    return (performance.now() - t1) / 50
  })
  assert.ok(perPlan < 1, `a 5000-item plan of long texts: ${perPlan.toFixed(3)} ms`)
})

// ---------------------------------------------------------------- plan

test('plan: up to five items; a longer plan shows four, a “+N more” line and N/M done', () => {
  const long = texts(scenePlan({ kind: 'plan', items: items(7) }, ctx()))
  assert.ok(long.includes('+3 more'), long.join(' | '))
  assert.ok(long.includes('2/7done'), long.join(' | '))
  assert.equal(long.filter(t => /^Task number/.test(t)).length, 4)
  assert.ok(long.includes('Task number 3'), 'the item in progress is shown')
  assert.ok(long.includes('1 in progress · 4 to do'))

  const five = texts(scenePlan({ kind: 'plan', items: items(5) }, ctx()))
  assert.equal(five.filter(t => /^Task number/.test(t)).length, 5)
  assert.ok(!five.some(t => t.includes('more')))

  const six = texts(scenePlan({ kind: 'plan', items: items(6) }, ctx()))
  assert.ok(six.includes('+2 more'))
})

test('plan: the window follows the item in progress', () => {
  const list = Array.from({ length: 12 }, (_, i) => ({ text: `Step ${i + 1}`, state: i < 9 ? 'done' : i === 9 ? 'doing' : 'todo' }) as const)
  const shown = texts(scenePlan({ kind: 'plan', items: [...list] }, ctx())).filter(t => t.startsWith('Step '))
  assert.deepEqual(shown, ['Step 9', 'Step 10', 'Step 11', 'Step 12'])
})

test('plan: done items are struck and dim; the item in progress pulses amber; all done says so', () => {
  const svg = scenePlan({ kind: 'plan', items: items(4) }, ctx({ isFresh: false }))
  const done = textEls(svg).filter(e => /^Task number [12]$/.test(e.text))
  assert.equal(done.length, 2)
  for (const e of done) assert.match(e.attrs, /text-decoration="line-through"/)
  assert.match(svg, /#fbbf24/, 'amber in-progress mark')
  assert.match(svg, /repeatCount="indefinite"/, 'the in-progress mark pulses')
  const all = texts(scenePlan({ kind: 'plan', items: items(3).map(i => ({ ...i, state: 'done' as const })) }, ctx()))
  assert.ok(all.includes('All tasks done') && all.includes('3/3done'))
})

test('plan: items slide in only when fresh', () => {
  const fresh = scenePlan({ kind: 'plan', items: items(3) }, ctx({ isFresh: true }))
  assert.match(fresh, /type="translate" values="-14 0;/)
  const settled = scenePlan({ kind: 'plan', items: items(3) }, ctx({ isFresh: false }))
  assert.doesNotMatch(settled, /type="translate"/)
})

test('plan: no items yet (plan mode) draws a plan being sketched', () => {
  assert.ok(texts(scenePlan({ kind: 'plan', items: [] }, ctx())).includes('Planning the approach'))
})

// ---------------------------------------------------------------- ask

test('ask: the question wraps to at most two lines, with a pulsing “?” and the soft caption', () => {
  const q = 'Should I keep the old login route working for a while, or remove it now that the new flow handles every redirect case, including the ones from the mobile app and the admin console?'
  const svg = sceneAsk({ kind: 'ask', question: q, isPermission: false }, ctx())
  const lines = textEls(svg).filter(e => /font-size="13"/.test(e.attrs))
  assert.equal(lines.length, 2)
  assert.ok(lines[1]?.text.endsWith('…'))
  assert.ok(lines[0]?.text.startsWith('Should I keep'))
  assert.ok(texts(svg).includes('?'))
  assert.ok(texts(svg).includes('Claude is waiting for you'))
  assert.match(svg, /repeatCount="indefinite"/)
})

test('ask: a permission prompt shows a lock, “Permission needed” and the tool line in mono', () => {
  const svg = sceneAsk({ kind: 'ask', question: 'Bash: rm -rf build/', isPermission: true }, ctx())
  assert.ok(texts(svg).includes('Permission needed'))
  const tool = textEls(svg).find(e => e.text === 'Bash: rm -rf build/')
  assert.ok(tool && /font-family="ui-monospace/.test(tool.attrs))
  assert.ok(!texts(svg).includes('?'))
})

test('ask: once answered the caption says how it went, and nothing pulses', () => {
  const ok = sceneAsk({ kind: 'ask', question: 'Which database?', isPermission: false }, ctx({ status: 'ok', isFresh: false }))
  assert.ok(texts(ok).includes('You answered'))
  assert.ok(!ok.includes('repeatCount'))
  assert.ok(texts(sceneAsk({ kind: 'ask', question: 'Bash: ls', isPermission: true }, ctx({ status: 'ok' }))).includes('You allowed it'))
  assert.ok(texts(sceneAsk({ kind: 'ask', question: 'Bash: ls', isPermission: true }, ctx({ status: 'denied' }))).includes('You declined'))
})

// ---------------------------------------------------------------- tools

test('tools: a plug in a socket labelled with the server, the tool and the detail', () => {
  const svg = sceneTools({ kind: 'tools', name: 'mcp__github__create_issue', detail: 'repo: acme/web' }, ctx())
  const t = texts(svg)
  assert.ok(t.includes('MCP · github') && t.includes('create_issue') && t.includes('repo: acme/web'), t.join(' | '))
  assert.match(svg, /<animateMotion path="M18 /, 'packets travel the cable while it runs')
  const plain = texts(sceneTools({ kind: 'tools', name: 'create', server: 'docs' }, ctx()))
  assert.ok(plain.includes('MCP · docs') && plain.includes('create'))
  assert.ok(texts(sceneTools({ kind: 'tools', name: 'Monitor' }, ctx())).includes('TOOL'))
  assert.doesNotMatch(sceneTools({ kind: 'tools', name: 'Monitor' }, ctx({ status: 'ok' })), /animateMotion/, 'no traffic once it is over')
})

test('tools: a skill shows an opening book instead of a plug', () => {
  const cases: [Of<'tools'>, string, string][] = [
    [{ kind: 'tools', name: 'Skill', detail: 'pdf' }, 'SKILL', 'pdf'],
    [{ kind: 'tools', name: 'anthropic-skills:docx' }, 'SKILL · anthropic-skills', 'docx'],
    [{ kind: 'tools', name: 'Skill', detail: 'claude-pace:setup' }, 'SKILL · claude-pace', 'setup'],
    [{ kind: 'tools', name: 'plugin-authoring', server: 'skill' }, 'SKILL', 'plugin-authoring'],
  ]
  for (const [s, label, title] of cases) {
    const svg = sceneTools(s, ctx())
    const t = texts(svg)
    assert.ok(t.includes(label) && t.includes(title), `${JSON.stringify(s)}: ${t.join(' | ')}`)
    assert.doesNotMatch(svg, /animateMotion/, 'no cable')
    assert.match(svg, /type="scale" values="-1 1;/, 'the page swings open')
  }
  assert.ok(!texts(sceneTools({ kind: 'tools', name: 'mcp__x__list_skills' }, ctx())).includes('SKILL'), 'an MCP tool is never a skill')
})

// ---------------------------------------------------------------- think and talk

test('think: a cloud with three pulsing dots, and the snippet fading in, in at most two lines', () => {
  const text = 'The redirect goes to /home because the next parameter is dropped when the session is created, so I should look at where the session is made and whether it passes next along to the handler that redirects.'
  const svg = sceneThink({ kind: 'think', text }, ctx())
  const lines = textEls(svg).filter(e => /font-style="italic"/.test(e.attrs))
  assert.equal(lines.length, 2)
  assert.ok(lines[1]?.text.endsWith('…'))
  assert.equal((svg.match(/begin="0s" repeatCount="indefinite"|begin="0.2s" repeatCount="indefinite"|begin="0.4s" repeatCount="indefinite"/g) ?? []).length, 3)
  assert.match(svg, /attributeName="opacity" values="0;0;1"/, 'the snippet fades in')
  assert.ok(texts(sceneThink({ kind: 'think' }, ctx())).includes('Working out what to do next…'))
  assert.ok(!sceneThink({ kind: 'think', text }, ctx({ status: 'ok', isFresh: false })).includes('repeatCount'), 'still once the thought is over')
})

test('talk: a bubble whose lines appear one by one, plus the quoted snippet', () => {
  const text = 'I fixed the redirect: the login handler now keeps the next parameter when it creates the session, and a new test covers the case. All 48 tests pass, and the build is green again on every platform we support.'
  const svg = sceneTalk({ kind: 'talk', text }, ctx())
  const t = textEls(svg).map(e => e.text)
  assert.ok(t.length >= 2 && t.length <= 3, t.join(' | '))
  assert.ok(t[0]?.startsWith('“I fixed'))
  assert.ok(t[t.length - 1]?.endsWith('…”'), 'the closing quote survives the cut')
  assert.equal((svg.match(/attributeName="width" values="0;0;/g) ?? []).length, 3, 'three lines grow in turn')
  const short = texts(sceneTalk({ kind: 'talk', text: 'Done.' }, ctx({ status: 'ok', isFresh: false })))
  assert.deepEqual(short, ['“Done.”'])
})

// ---------------------------------------------------------------- done and idle

test('done: a check drawn by dashoffset, confetti only when fresh, and the summary chips', () => {
  const s: Of<'done'> = { kind: 'done', steps: 23, files: 7, seconds: 252, errors: 1 }
  const fresh = sceneDone(s, ctx({ status: 'ok' }))
  const t = texts(fresh)
  for (const chip of ['23 steps', '7 files', '4m 12s', '1 error', 'All done']) assert.ok(t.includes(chip), `${chip}: ${t.join(' | ')}`)
  assert.match(fresh, /attributeName="stroke-dashoffset"/)
  assert.ok((fresh.match(/<animateMotion/g) ?? []).length >= 10, 'a confetti burst')
  assert.ok(!fresh.includes('repeatCount'), 'the burst is short, not a loop')
  const settled = sceneDone(s, ctx({ status: 'ok', isFresh: false }))
  assert.doesNotMatch(settled, /animateMotion|stroke-dashoffset/)
  const one = texts(sceneDone({ kind: 'done', steps: 1, files: 1, seconds: 9, errors: 0 }, ctx()))
  for (const chip of ['1 step', '1 file', '9s', 'no errors']) assert.ok(one.includes(chip), chip)
  assert.ok(texts(sceneDone({ kind: 'done', steps: 2, files: 0, seconds: 7300, errors: 0 }, ctx())).includes('2h 01m'))
})

test('done: a turn that ended early says “Stopped”, without the green check or confetti', () => {
  const s: Of<'done'> = { kind: 'done', steps: 4, files: 1, seconds: 30, errors: 1 }
  for (const status of ['error', 'denied'] as const) {
    const svg = sceneDone(s, ctx({ status }))
    const t = texts(svg)
    assert.ok(t.includes('Stopped') && !t.includes('All done'), t.join(' | '))
    assert.ok(t.includes(status === 'error' ? 'The turn ended early' : 'Interrupted before it finished'), t.join(' | '))
    assert.doesNotMatch(svg, /<animateMotion/, 'no confetti')
    assert.doesNotMatch(svg, /stroke="#4ade80" stroke-width="3.2"/, 'no green check')
  }
  assert.ok(texts(sceneDone(s, ctx({ status: 'ok' }))).includes('All done'))
})

test('idle: drifting z z z and “Waiting for the next task”; still while paused', () => {
  const live = sceneIdle({ kind: 'idle' }, ctx({ isFresh: false }))
  assert.ok(texts(live).includes('Waiting for the next task'))
  assert.equal(texts(live).filter(t => t === 'z').length, 3)
  assert.match(live, /repeatCount="indefinite"/)
  const paused = sceneIdle({ kind: 'idle' }, ctx({ isPaused: true }))
  assert.equal(texts(paused).filter(t => t === 'z').length, 3)
  assert.ok(!paused.includes('<animate'))
})
