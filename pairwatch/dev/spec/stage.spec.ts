// Specs for the animated stage (pairwatch/hooks/core/stage.ts and scenes/work.ts).
// Run: node --test dev/spec/stage.spec.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderStage, type StageInput } from '../../pairwatch/hooks/core/stage.ts'
import { VERB } from '../../pairwatch/hooks/core/stations.ts'
import type { BashCategory, SceneData, Station, StepStatus } from '../../pairwatch/types'

// ------------------------------------------------------------------ fixtures (synthetic)

const STATIONS: Station[] = ['think', 'plan', 'search', 'read', 'edit', 'run', 'web', 'delegate', 'tools', 'ask', 'talk', 'done', 'idle']
const STATUSES: StepStatus[] = ['running', 'ok', 'error', 'denied']
const CATEGORIES: BashCategory[] = ['test', 'build', 'install', 'git', 'run-script', 'read-file', 'list-files', 'search', 'write-file', 'file-ops', 'process', 'network', 'http', 'gpu', 'media', 'docker', 'database', 'env', 'wait', 'claude', 'other']

const SCENES: Record<Station, SceneData> = {
  think: { kind: 'think', text: 'The redirect probably drops the next parameter.' },
  plan: { kind: 'plan', items: [{ text: 'Reproduce the bug', state: 'done' }, { text: 'Fix the redirect', state: 'doing' }, { text: 'Run the tests', state: 'todo' }] },
  search: { kind: 'search', query: 'handleLogin', where: 'src/', matches: '12 matches in 4 files' },
  read: { kind: 'read', files: [{ path: 'src/auth/login.py', detail: 'lines 120–180' }, { path: 'src/auth/session.py' }] },
  edit: { kind: 'edit', path: 'src/auth/login.py', removed: 1, added: 2, minus: ['    return redirect(home)'], plus: ['    nxt = request.args.get("next")', '    return redirect(nxt or home)'], isNew: false },
  run: { kind: 'run', command: 'pytest -q tests/test_auth.py', category: 'test', program: 'pytest', output: '1 failed, 4 passed in 0.5s' },
  web: { kind: 'web', url: 'https://docs.python.org/3/library/urllib.parse.html', domain: 'docs.python.org' },
  delegate: { kind: 'delegate', agents: [{ label: 'Explore auth', type: 'Explore', status: 'running', doing: 'Reading session.py' }, { label: 'Check fixtures', status: 'ok' }, { label: 'Audit helpers', status: 'error' }] },
  tools: { kind: 'tools', name: 'search_issues', server: 'github', detail: 'login redirect' },
  ask: { kind: 'ask', question: 'Allow running “rm -rf build/”?', isPermission: true },
  talk: { kind: 'talk', text: 'Fixed the redirect; all auth tests pass.' },
  done: { kind: 'done', steps: 23, files: 7, seconds: 252, errors: 1 },
  idle: { kind: 'idle' },
}

const trail = (n: number): StageInput['trail'] =>
  Array.from({ length: n }, (_, i) => ({ station: STATIONS[i % STATIONS.length] ?? 'read', status: (i % 5 === 0 ? 'error' : 'ok') as StepStatus }))

const make = (station: Station, over: Partial<StageInput> = {}): StageInput => ({
  station,
  hopFrom: 'read',
  status: 'running',
  title: `doing ${station}`,
  scene: SCENES[station],
  trail: trail(20),
  stats: { steps: 20, files: 4, edits: 2, elapsed: '1m 05s' },
  isFresh: true,
  isPaused: false,
  ...over,
})

const huge = (n: number, s: string): string => s.repeat(Math.ceil(n / s.length)).slice(0, n)
const EVIL = 'a<b>c&d"e\'f</text><script>alert(1)</script>\u0000\u0001\u0007\u000b\u001b[31m\u007f\u2028\ud800x\uffff\ttab\r\nline'

/** Every station with absurdly large or hostile inputs. */
const stressInputs = (): StageInput[] => {
  const longs = Array.from({ length: 3000 }, () => huge(3000, EVIL))
  const big = huge(300000, EVIL + ' ')
  const scenes: SceneData[] = [
    { kind: 'run', command: big + '\n' + huge(20000, 'x\n'), category: 'test', program: big, output: big, isBackground: true },
    ...CATEGORIES.map(category => ({ kind: 'run' as const, command: big, category, program: big, output: big })),
    { kind: 'read', files: longs.map(p => ({ path: p, detail: p })) },
    { kind: 'search', query: big, where: big, matches: big },
    { kind: 'edit', path: big, removed: 1e15, added: Number.MAX_SAFE_INTEGER, minus: longs, plus: longs, isNew: true },
    { kind: 'web', query: big, url: big, domain: big },
    { kind: 'web', url: 'https://' + big },
    { kind: 'delegate', agents: longs.map(l => ({ label: l, type: l, status: 'running' as const, doing: l })) },
    { kind: 'plan', items: longs.map(l => ({ text: l, state: 'doing' as const })) },
    { kind: 'ask', question: big, isPermission: false },
    { kind: 'tools', name: big, server: big, detail: big },
    { kind: 'think', text: big },
    { kind: 'talk', text: big },
    { kind: 'done', steps: 1e18, files: -5, seconds: Number.NaN, errors: Infinity },
  ]
  const out: StageInput[] = []
  for (const scene of scenes) {
    for (const status of STATUSES) {
      out.push({
        station: 'run',
        hopFrom: 'think',
        status,
        title: big,
        scene,
        trail: Array.from({ length: 50000 }, (_, i) => ({ station: STATIONS[i % 13] ?? 'run', status: STATUSES[i % 4] ?? 'ok' })),
        stats: { steps: 1e20, files: 123456789, edits: -1, elapsed: big },
        isFresh: status === 'running',
        isPaused: false,
        lane: big,
      })
    }
  }
  for (const station of STATIONS) out.push(make(station, { title: big, lane: big, scene: scenes[0] as SceneData }))
  return out
}

// ------------------------------------------------------------------ a minimal XML checker

type Tag = { name: string; attrs: Record<string, string> }
type Parsed = { issues: string[]; texts: string[]; tags: Tag[]; root?: Tag }

const ENTITY = /&(?!(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});)/
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

/** Tag balance, quoted attributes, entities, no raw '<' outside markup, no forbidden characters. */
function parseXml(src: string): Parsed {
  const issues: string[] = []
  const texts: string[] = []
  const tags: Tag[] = []
  const stack: string[] = []
  let root: Tag | undefined
  let rootClosed = false
  const name = /[A-Za-z_][\w.:-]*/y
  const space = /\s*/y
  let i = 0
  if (BAD_CHARS.test(src)) issues.push('forbidden character in output')
  while (i < src.length && issues.length === 0) {
    if (src[i] !== '<') {
      const j = src.indexOf('<', i)
      const end = j < 0 ? src.length : j
      const text = src.slice(i, end)
      if (stack.length === 0 && text.trim() !== '') issues.push(`text outside the root: ${text.slice(0, 30)}`)
      if (ENTITY.test(text)) issues.push(`bare '&' in text: ${text.slice(0, 40)}`)
      texts.push(text)
      i = end
      continue
    }
    if (src.startsWith('<!', i) || src.startsWith('<?', i)) {
      issues.push(`unexpected declaration at ${i}`)
      break
    }
    if (src.startsWith('</', i)) {
      name.lastIndex = i + 2
      const m = name.exec(src)
      const close = m ? src.indexOf('>', i) : -1
      if (!m || close !== i + 2 + m[0].length) {
        issues.push(`bad closing tag at ${i}: ${src.slice(i, i + 30)}`)
        break
      }
      const open = stack.pop()
      if (open !== m[0]) issues.push(`</${m[0]}> closes <${open ?? 'nothing'}>`)
      if (stack.length === 0) rootClosed = true
      i = close + 1
      continue
    }
    name.lastIndex = i + 1
    const m = name.exec(src)
    if (!m) {
      issues.push(`raw '<' at ${i}: ${src.slice(i, i + 30)}`)
      break
    }
    const tag: Tag = { name: m[0], attrs: {} }
    if (rootClosed) issues.push(`element after the root: <${tag.name}>`)
    let k = name.lastIndex
    for (;;) {
      const before = k
      space.lastIndex = k
      space.exec(src)
      k = space.lastIndex
      if (src.startsWith('/>', k)) {
        k += 2
        break
      }
      if (src[k] === '>') {
        k += 1
        stack.push(tag.name)
        break
      }
      if (k === before) {
        issues.push(`attributes need a space in <${tag.name}> at ${k}`)
        break
      }
      name.lastIndex = k
      const a = name.exec(src)
      if (!a || src[name.lastIndex] !== '=') {
        issues.push(`bad attribute in <${tag.name}> at ${k}: ${src.slice(k, k + 30)}`)
        break
      }
      k = name.lastIndex + 1
      const q = src[k]
      const end = q === '"' || q === "'" ? src.indexOf(q, k + 1) : -1
      if (end < 0) {
        issues.push(`unquoted attribute ${a[0]} in <${tag.name}>`)
        break
      }
      const value = src.slice(k + 1, end)
      if (value.includes('<')) issues.push(`'<' inside ${a[0]} of <${tag.name}>`)
      if (ENTITY.test(value)) issues.push(`bare '&' inside ${a[0]} of <${tag.name}>`)
      if (a[0] in tag.attrs) issues.push(`duplicate attribute ${a[0]} in <${tag.name}>`)
      tag.attrs[a[0]] = value
      k = end + 1
    }
    if (!root) {
      root = tag
      if (stack.length !== 1) issues.push('the root must not be self-closing')
    }
    tags.push(tag)
    i = k
  }
  if (issues.length === 0 && stack.length > 0) issues.push(`unclosed: ${stack.join(' > ')}`)
  return { issues, texts, tags, root }
}

/** Structure and safety rules every stage document must meet. */
function assertSound(svg: string, label: string): Parsed {
  assert.equal(typeof svg, 'string', label)
  assert.ok(svg.length < 60000, `${label}: ${svg.length} chars`)
  const p = parseXml(svg)
  assert.deepEqual(p.issues, [], `${label}: ${p.issues.join('; ')}`)
  assert.equal(p.root?.name, 'svg', label)
  assert.equal(p.root?.attrs.viewBox, '0 0 640 246', label)
  assert.equal(p.root?.attrs.width, '640', label)
  assert.equal(p.root?.attrs.height, '246', label)
  assert.equal(p.root?.attrs.xmlns, 'http://www.w3.org/2000/svg', label)
  const ids = new Set<string>()
  for (const t of p.tags) {
    assert.ok(!['script', 'foreignObject', 'iframe', 'image', 'style', 'a'].includes(t.name), `${label}: <${t.name}>`)
    for (const [k, v] of Object.entries(t.attrs)) {
      assert.ok(!/^on/i.test(k), `${label}: event attribute ${k}`)
      if (/href$/i.test(k)) assert.ok(v.startsWith('#'), `${label}: external ${k}=${v}`)
      for (const ref of v.matchAll(/url\(([^)]*)\)/g)) assert.match(ref[1] ?? '', /^#/, `${label}: external url(${ref[1]})`)
    }
    const id = t.attrs.id
    if (id !== undefined) {
      assert.ok(!ids.has(id), `${label}: duplicate id ${id}`)
      ids.add(id)
    }
  }
  for (const t of p.tags) for (const v of Object.values(t.attrs)) for (const ref of v.matchAll(/url\(#([^)]*)\)/g)) assert.ok(ids.has(ref[1] ?? ''), `${label}: url(#${ref[1]}) has no target`)
  return p
}

/** Monospace columns: East Asian wide characters and emoji take two (as the renderer assumes). */
const WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7a3\uf900-\ufaff\uff00-\uff60\uffe0-\uffe6\u2705\u274c]|[\ud800-\udbff][\udc00-\udfff]/
const columns = (s: string): number => Array.from(s).reduce((n, ch) => n + (/[\u0300-\u036f\u200b-\u200f\ufe00-\ufe0f]/.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1), 0)
const decode = (s: string): string =>
  s.replace(/&(amp|lt|gt|quot|#39|apos);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" })[e] ?? '')

/**
 * Every monospace <text> without tspans, placed through translate() groups only: its estimated extent
 * (0.6 em per column) must stay on the card. Returns the offenders.
 */
function monoOverflow(svg: string): string[] {
  const bad: string[] = []
  const stack: { dx: number; skip: boolean }[] = [{ dx: 0, skip: false }]
  const re = /<(\/?)([A-Za-z]+)([^>]*?)(\/?)>|([^<]+)/g
  let text: { x: number; size: number; anchor: string; mono: boolean; body: string; nested: boolean; skip: boolean } | null = null
  for (let m = re.exec(svg); m; m = re.exec(svg)) {
    const [, close, name, attrs = '', selfClose, chars] = m
    if (chars !== undefined) {
      if (text) text.body += chars
      continue
    }
    const top = stack[stack.length - 1] ?? { dx: 0, skip: false }
    if (name === 'g' && !close) {
      const tr = /transform="([^"]*)"/.exec(attrs)?.[1] ?? ''
      const tx = /^translate\(\s*(-?[\d.]+)/.exec(tr)
      const other = tr !== '' && (!tx || /rotate|scale|matrix|skew/.test(tr))
      if (!selfClose) stack.push({ dx: top.dx + (tx ? Number(tx[1]) : 0), skip: top.skip || other })
    } else if (name === 'g' && close) stack.pop()
    else if (name === 'text' && !close) {
      const get = (k: string) => new RegExp(`\\s${k}="([^"]*)"`).exec(attrs)?.[1]
      text = {
        x: top.dx + Number(get('x') ?? 0),
        size: Number(get('font-size') ?? 12),
        anchor: get('text-anchor') ?? 'start',
        mono: (get('font-family') ?? '').includes('monospace'),
        body: '',
        nested: false,
        skip: top.skip || /transform=/.test(attrs),
      }
    } else if (name === 'tspan' && text) text.nested = true
    else if (name === 'text' && close && text) {
      if (text.mono && !text.nested && !text.skip) {
        const w = columns(decode(text.body)) * 0.6 * text.size
        const [lo, hi] = text.anchor === 'end' ? [text.x - w, text.x] : text.anchor === 'middle' ? [text.x - w / 2, text.x + w / 2] : [text.x, text.x + w]
        if (lo < 4 || hi > 636) bad.push(`${decode(text.body).slice(0, 40)} [${lo.toFixed(0)}, ${hi.toFixed(0)}]`)
      }
      text = null
    }
  }
  return bad
}

// ------------------------------------------------------------------ specs

test('every station renders a sound document in every status', () => {
  for (const station of STATIONS) {
    for (const status of STATUSES) {
      for (const isFresh of [true, false]) {
        const svg = renderStage(make(station, { status, isFresh }))
        const p = assertSound(svg, `${station}/${status}/${isFresh ? 'fresh' : 'settled'}`)
        const verb = status === 'running' ? VERB[station].running : VERB[station].over
        assert.ok(p.texts.some(t => t.includes(verb)), `${station}/${status}: header verb ${verb}`)
      }
    }
  }
})

test('every run category renders, with and without output, in the background or not', () => {
  for (const category of CATEGORIES) {
    for (const status of STATUSES) {
      for (const isBackground of [false, true]) {
        const scene: SceneData = { kind: 'run', command: `${category} --flag value`, category, program: category, output: status === 'running' ? undefined : 'exit code 3\nsomething happened', isBackground }
        assertSound(renderStage(make('run', { status, scene })), `run/${category}/${status}/${isBackground}`)
      }
    }
  }
})

test('output is deterministic: same input, same bytes', () => {
  for (const station of STATIONS) {
    const input = make(station, { lane: 'sub-agent: Explore' })
    const a = renderStage(input)
    const b = renderStage(structuredClone(input))
    const c = renderStage(input)
    assert.equal(a, b, station)
    assert.equal(a, c, station)
  }
})

test('stays under 60 000 characters for huge and hostile inputs, fast', () => {
  let worst = 0
  let slowest = 0
  for (const input of stressInputs()) {
    const t0 = performance.now()
    const svg = renderStage(input)
    slowest = Math.max(slowest, performance.now() - t0)
    worst = Math.max(worst, svg.length)
    assertSound(svg, `stress ${input.scene.kind}/${input.status}`)
  }
  assert.ok(worst < 60000, `largest ${worst}`)
  assert.ok(slowest < 250, `slowest stress render ${slowest.toFixed(1)} ms`)
})

test('monospace text is cut to fit the card, also with wide characters', () => {
  const wideText = '日本語のファイル名と✅絵文字🚀を含むとても長いコマンド'.repeat(20)
  for (const filler of [huge(3000, 'abcdefghij '), wideText, huge(3000, 'W')]) {
    const scenes: SceneData[] = [
      { kind: 'run', command: filler, category: 'test', program: filler, output: filler },
      { kind: 'run', command: filler + '\nline two', category: 'other', output: filler, isBackground: true },
      { kind: 'read', files: [{ path: filler, detail: filler }] },
      { kind: 'read', files: [{ path: filler, detail: filler }, { path: filler, detail: filler }, { path: filler }] },
      { kind: 'search', query: filler, where: filler, matches: filler },
      { kind: 'edit', path: filler, removed: 3, added: 3, minus: [filler, '\t\t' + filler], plus: [filler, '        ' + filler, filler], isNew: true },
      { kind: 'web', url: 'https://' + filler, domain: filler },
      { kind: 'web', query: filler },
      { kind: 'delegate', agents: [{ label: filler, type: filler, status: 'running', doing: filler }] },
    ]
    for (const scene of scenes) {
      for (const status of ['running', 'error'] as StepStatus[]) {
        for (const lane of [undefined, filler]) {
          const svg = renderStage(make('run', { status, scene, title: filler, lane, isPaused: lane !== undefined }))
          assert.deepEqual(monoOverflow(svg), [], `${scene.kind}/${status}`)
          // the header title (a monospace tspan after the verb) fits the panel too
          const title = /font-size="12" font-weight="400" letter-spacing="0"[^>]*>([^<]*)<\/tspan>/.exec(svg)?.[1] ?? ''
          const verb = status === 'running' ? VERB.run.running : VERB.run.over
          assert.ok(40 + verb.length * 8.9 + 9 + columns(decode(title)) * 7.22 <= 620, `header title too long: ${columns(decode(title))} columns`)
        }
      }
    }
  }
})

test('a typed command lets go of its clip once typed, so a wide font never hides its end', () => {
  const svg = renderStage(make('run', { scene: { kind: 'run', command: 'echo ✅ 完了', category: 'other' } }))
  assert.match(svg, /<clipPath id="[^"]+"><rect[^>]*><animate attributeName="width" from="0"[^>]*\/><set attributeName="width"/)
})

test('escapes user text: no raw markup, quotes or control characters get through', () => {
  const hostile = 'x</text><script>alert("1")</script> & \' " \u0000\u0008\u001f\u007f <svg onload=alert(1)>'
  const scenes: SceneData[] = [
    { kind: 'run', command: hostile, category: 'test', program: hostile, output: hostile, isBackground: true },
    { kind: 'read', files: [{ path: hostile, detail: hostile }, { path: hostile }] },
    { kind: 'read', files: [{ path: hostile, detail: hostile }] },
    { kind: 'search', query: hostile, where: hostile, matches: hostile },
    { kind: 'edit', path: hostile, removed: 2, added: 2, minus: [hostile, hostile], plus: [hostile, hostile], isNew: true },
    { kind: 'web', url: 'https://ex.com/' + hostile, domain: hostile },
    { kind: 'web', query: hostile },
    { kind: 'delegate', agents: [{ label: hostile, type: hostile, status: 'running', doing: hostile }, { label: hostile, status: 'ok' }] },
  ]
  for (const scene of scenes) {
    for (const status of STATUSES) {
      const svg = renderStage(make('run', { status, title: hostile, lane: hostile, scene }))
      const p = assertSound(svg, `escape ${scene.kind}/${status}`)
      assert.ok(!svg.includes('<script'), 'no script element')
      assert.ok(p.tags.every(t => t.name !== 'script' && Object.keys(t.attrs).every(k => !/^on/i.test(k))), 'no script tag or handler')
      for (const text of p.texts) assert.ok(!text.includes('<'), `raw '<' in text: ${text.slice(0, 40)}`)
    }
  }
  const svg = renderStage(make('run', { title: '<b>&"\'' }))
  assert.ok(svg.includes('&lt;b&gt;&amp;&quot;&#39;'), 'the title is escaped, not dropped')
  // lone surrogates and non-characters cut out of every field, short ones included
  const units = '\ud800\udfff\uffff\ufffe'
  const odd = renderStage(make('delegate', { title: units, lane: units, stats: { steps: 1, files: 2, edits: 3, elapsed: units + 'x' }, scene: { kind: 'delegate', agents: [{ label: units, type: units, status: 'ok', doing: units }] } }))
  assertSound(odd, 'lone surrogates')
})

test('paused: a static picture with no animation at all, plus a paused tag', () => {
  for (const station of STATIONS) {
    for (const status of STATUSES) {
      const svg = renderStage(make(station, { status, isPaused: true, isFresh: true, hopFrom: 'think' }))
      assertSound(svg, `paused ${station}/${status}`)
      assert.ok(!svg.includes('repeatCount="indefinite"'), `${station}/${status}: looping animation while paused`)
      assert.ok(!/<(animate|animateMotion|animateTransform|set)\b/.test(svg), `${station}/${status}: animation element while paused`)
      assert.ok(svg.includes('>paused<'), `${station}/${status}: paused tag`)
    }
  }
  for (const category of CATEGORIES) {
    const svg = renderStage(make('run', { isPaused: true, scene: { kind: 'run', command: 'x', category, isBackground: true } }))
    assert.ok(!/<(animate|animateMotion|animateTransform|set)\b/.test(svg), `run/${category} paused`)
  }
})

test('intros play only when fresh; the hop only from another stop', () => {
  const run = make('run', { hopFrom: 'edit' })
  const fresh = renderStage(run)
  const settled = renderStage({ ...run, isFresh: false })
  assert.match(fresh, /<animateMotion[^>]*path="M-63/, 'the avatar hops in from Edit')
  assert.match(fresh, /attributeName="width" from="0"/, 'the command is typed')
  assert.ok(!settled.includes('<animateMotion'), 'no hop on a settled redraw')
  assert.ok(!/attributeName="width" from="0"/.test(settled), 'no typing on a settled redraw')
  assert.ok(!renderStage(make('run', { hopFrom: 'run' })).includes('<animateMotion'), 'no hop from the same station')
  assert.ok(!renderStage(make('run', { hopFrom: undefined })).includes('<animateMotion'), 'no hop without hopFrom')
  // talk and done share the You stop: a hop between them is a jump in place
  assert.match(renderStage(make('done', { hopFrom: 'talk' })), /<animateMotion[^>]*path="M0 0Q0 -20 0 0"/)
})

test('the header carries the lane, and the trail shows the last 38 steps with errors outlined', () => {
  const svg = renderStage(make('read', { lane: 'sub-agent: Explore', trail: trail(100), status: 'running' }))
  assert.ok(svg.includes('>sub-agent: Explore<'), 'lane label')
  const pills = svg.match(/<rect x="\d+" y="227" width="8" height="8"/g) ?? []
  assert.equal(pills.length, 38)
  const outlined = svg.match(/<rect x="\d+" y="227" width="8" height="8" rx="2" fill="#[0-9a-f]+" fill-opacity="[\d.]+" stroke="#f87171"/g) ?? []
  assert.ok(outlined.length >= 7, `error pills outlined: ${outlined.length}`)
  assert.ok(svg.includes('20 steps · 4 files · 2 edits · 1m 05s'), 'stats')
  assert.ok(renderStage(make('read', { stats: { steps: 1, files: 1, edits: 1, elapsed: '' } })).includes('1 step · 1 file · 1 edit<'), 'singulars')
})

test('scenes show what matters: commands, paths, counts, multi-line commands, more-agents', () => {
  const run = renderStage(make('run', { status: 'error', scene: { kind: 'run', command: "python3 - <<'EOF'\nimport os\nprint(os.getcwd())\nEOF", category: 'run-script', output: 'Traceback (most recent call last):\nNameError: name x is not defined\nExit code 1' } }))
  assert.ok(run.includes('+3 lines'), 'first line plus a line count')
  assert.ok(run.includes('NameError: name x is not defined'), 'the error line')
  assert.ok(run.includes('✗ exit 1'), 'the exit code')
  const ok = renderStage(make('run', { status: 'ok', scene: { kind: 'run', command: 'ls', category: 'list-files', output: 'a\nb' } }))
  assert.ok(ok.includes('✓ exit 0'), 'ok exit')
  const bg = renderStage(make('run', { scene: { kind: 'run', command: 'npm run dev', category: 'process', isBackground: true } }))
  assert.ok(bg.includes('runs in background') && bg.includes('&amp;'), 'background badge')
  const read = renderStage(make('read', { scene: { kind: 'read', files: Array.from({ length: 9 }, (_, i) => ({ path: `/repo/src/deep/folder/file${i}.ts`, detail: `${i} lines` })) } }))
  assert.ok(read.includes('+6 more files'), 'more files')
  assert.ok(read.includes('…/repo/src/deep/folder/file0.ts') || read.includes('/repo/src/deep/folder/file0.ts'), 'paths keep their tail')
  const search = renderStage(make('search', { status: 'ok' }))
  assert.ok(search.includes('“handleLogin”') && search.includes('12 matches in 4 files'), 'query and matches')
  const edit = renderStage(make('edit', { status: 'ok', scene: { kind: 'edit', path: 'a/new.py', removed: 0, added: 40, minus: [], plus: ['import os'], isNew: true } }))
  assert.ok(edit.includes('NEW FILE') && edit.includes('+40') && edit.includes('+39 more lines'), 'new file ribbon and counts')
  const del = renderStage(make('delegate', { scene: { kind: 'delegate', agents: Array.from({ length: 7 }, (_, i) => ({ label: `Agent ${i}`, status: 'running' as const })) } }))
  assert.ok(del.includes('+3 more') && del.includes('Agent 3') && !del.includes('Agent 4<'), 'four cards and +3 more')
  const web = renderStage(make('web', { scene: { kind: 'web', query: 'flask redirect' } }))
  assert.ok(web.includes('“flask redirect”'), 'curly-quoted query')
})

test('never throws on odd input', () => {
  const odd: unknown[] = [
    null,
    undefined,
    {},
    { station: 'nope', status: 42, title: {}, scene: { kind: 'bogus' }, trail: 'x', stats: null },
    { station: 'run', status: 'ok', scene: { kind: 'run' }, trail: [null, 1, 'a', { station: 'zzz', status: 'yyy' }] },
    { station: 'read', scene: { kind: 'read', files: [null, 1, { path: 5 }, { detail: [] }] } },
    { station: 'edit', scene: { kind: 'edit', minus: 'x', plus: [1, null, {}], removed: -3, added: Number.NaN } },
    { station: 'delegate', scene: { kind: 'delegate', agents: [null, { status: 'weird' }, 7] } },
    { station: 'search', scene: { kind: 'search', query: null, matches: 12 } },
    { station: 'web', scene: { kind: 'web', url: 5 } },
    { station: 'run', hopFrom: 'bogus', scene: null, stats: { steps: Number.NaN, files: Infinity, edits: -1, elapsed: 7 }, isPaused: 'yes' },
  ]
  for (const input of odd) {
    const svg = renderStage(input as StageInput)
    assertSound(svg, `odd ${JSON.stringify(input)?.slice(0, 60)}`)
  }
})

test('renders quickly', () => {
  const inputs = STATIONS.map(s => make(s))
  for (const i of inputs) renderStage(i) // warm up
  const n = 400
  const t0 = performance.now()
  for (let k = 0; k < n; k++) renderStage(inputs[k % inputs.length] as StageInput)
  const mean = (performance.now() - t0) / n
  assert.ok(mean < 5, `mean ${mean.toFixed(3)} ms per render`)
})
