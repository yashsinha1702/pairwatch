// Spec for the 'agent' and 'practice' concept cards (pairwatch/hooks/core/kb/agent.ts).
//   node --test dev/spec/kb-agent.spec.ts
// Which ids belong to those sections is read from the registry source itself (its section headers
// name the kb file), so the spec follows the registry when ids are added, moved or removed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Concept } from '../../pairwatch/types'
import { AGENT_CONCEPTS } from '../../pairwatch/hooks/core/kb/agent.ts'
import { CONCEPT_IDS, isConceptId } from '../../pairwatch/hooks/core/concept-ids.ts'

// ---------------------------------------------------------------- the registry's sections

type Section = { name: string; file: string; ids: string[] }

/** Each `// ---- <name> (kb/<file>.ts)` header opens a section; each `'id':` line below it is one of its ids. */
function registrySections(src: string): Section[] {
  const out: Section[] = []
  let cur: Section | undefined
  for (const line of src.split('\n')) {
    const head = /^\s*\/\/\s*-{3,}\s*(.+?)\s*\(kb\/([\w-]+)\.ts\)\s*$/.exec(line)
    if (head) {
      cur = { name: head[1] ?? '', file: head[2] ?? '', ids: [] }
      out.push(cur)
      continue
    }
    const id = /^\s*'([a-z0-9-]+)'\s*:/.exec(line)
    if (id && cur) cur.ids.push(id[1] ?? '')
  }
  return out
}

const SECTIONS = registrySections(readFileSync(new URL('../../pairwatch/hooks/core/concept-ids.ts', import.meta.url), 'utf8'))
const MINE = SECTIONS.filter(s => s.file === 'agent')
/** id -> the section (and so the category) it belongs to, for this file's sections only */
const SECTION_OF = new Map<string, string>(MINE.flatMap(s => s.ids.map(id => [id, s.name] as [string, string])))

const CATEGORIES: readonly Concept['category'][] = ['agent', 'practice', 'shell', 'system', 'ml', 'git', 'python', 'node', 'docker', 'data', 'web']
const LIMITS = { short: 140, why: 170, deeper: 420, tryIt: 80 } as const
const TEXT_FIELDS = ['title', 'short', 'why', 'deeper'] as const

const cards = AGENT_CONCEPTS
const label = (c: Concept) => `card “${c.id}”`

// ---------------------------------------------------------------- the destructive-command guard

/** The command with everything inside '…' and "…" blanked out, so quoted text never reads as syntax. */
function unquoted(cmd: string): string {
  let out = ''
  let quote: string | null = null
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i] ?? ''
    if (quote === null) {
      if (ch === "'" || ch === '"') quote = ch
      else if (ch === '\\') i++
      else {
        out += ch
        continue
      }
      out += ' '
    } else {
      if (quote === '"' && ch === '\\') i++
      else if (ch === quote) quote = null
      out += ' '
    }
  }
  return out
}

const DESTRUCTIVE: readonly (readonly [string, RegExp])[] = [
  ['rm', /(^|[\s;&|(])rm\s/],
  ['rmdir', /\brmdir\b/],
  ['mv (can overwrite)', /(^|[\s;&|(])mv\s/],
  ['find -delete or -exec rm', /\s-delete\b|-exec\s+rm\b/],
  ['git push', /\bgit\s+push\b/],
  ['git reset --hard', /\bgit\s+reset\b[^;&|]*--hard\b/],
  ['git clean', /\bgit\s+clean\b/],
  ['git checkout -- or restore', /\bgit\s+(checkout\s+(--|\.)|restore\b)/],
  ['git branch -D or stash drop/clear', /\bgit\s+(branch\s+-D|stash\s+(drop|clear))\b/],
  ['force flag', /--force\b|\s-f\s+origin\b/],
  ['kill -9', /\bkill\s+-(9|KILL|SIGKILL)\b/],
  ['pkill or killall', /\b(pkill|killall)\b/],
  ['chmod -R or 777', /\bchmod\s+(-R\b|[^;&|]*\b0?777\b)/],
  ['chown -R', /\bchown\s+-R\b/],
  ['mkfs', /\bmkfs/],
  ['dd', /(^|[\s;&|(])dd\s/],
  ['pipe a download into a shell', /\b(curl|wget)\b[^;&]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/],
  ['fork bomb', /:\s*\(\s*\)\s*\{/],
  ['raw disk device', /\/dev\/(sd|nvme|hd|xvd|vd)[a-z0-9]/],
  ['power off', /\b(shutdown|reboot|halt|poweroff)\b/],
  ['sudo', /\bsudo\b/],
  ['shred or truncate', /\b(shred|truncate)\b/],
  ['sed -i (in place)', /\bsed\b[^;&|]*\s-i/],
  ['crontab -r', /\bcrontab\s+-r\b/],
  ['SQL drop or delete', /\b(drop\s+(table|database)|delete\s+from|truncate\s+table)\b/i],
  ['docker prune or rm', /\bdocker\s+(system\s+prune|rm\b|rmi\b|volume\s+rm\b)/],
  ['eval', /\beval\b/],
  ['--no-preserve-root', /--no-preserve-root/],
  ['tee outside /tmp', /(^|[\s;&|(])tee\s+(-a\s+)?(?!\/tmp\/|\/dev\/null)[^\s;&|]/],
]

/** Every reason the command is not safe to suggest; [] when it is. */
function dangers(cmd: string): string[] {
  const bare = unquoted(cmd)
  const found = DESTRUCTIVE.filter(([, re]) => re.test(cmd)).map(([why]) => why)
  // > and >> may write only under /tmp/ or to /dev/null (2>&1 and quoted text are not redirects)
  for (const m of bare.matchAll(/(?<![=<>-])\d*(?:&>>?|>>?\|?)\s*([^\s;|&()<>]+)/g)) {
    const target = m[1] ?? ''
    if (!target.startsWith('/tmp/') && target !== '/dev/null') found.push(`redirect into ${target}`)
  }
  // cp may overwrite its target unless it is told not to (-n, --no-clobber, --backup) or writes under /tmp/
  for (const m of bare.matchAll(/(?:^|[\s;&|(])cp\s+([^;&|]*)/g)) {
    const words = (m[1] ?? '').trim().split(/\s+/)
    const careful = words.some(w => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(w) || w === '--no-clobber' || w === '--update=none' || w.startsWith('--backup'))
    if (!careful && !(words[words.length - 1] ?? '').startsWith('/tmp/')) found.push('cp that can overwrite')
  }
  return found
}

// ---------------------------------------------------------------- plain-text style helpers

/** Sentence ends: . ! or ? (optionally closing a quote or bracket) followed by a space or the end. */
const sentenceCount = (s: string) => (s.match(/[.!?]["”’)]?(?=\s|$)/g) ?? []).length

/** Tool-like CamelCase names the cards may mention: the tools of this build and the hook events. */
const KNOWN_NAMES = new Set([
  'TodoWrite', 'WebSearch', 'WebFetch', 'ToolSearch', 'AskUserQuestion', 'TaskStop', 'EnterPlanMode', 'ExitPlanMode',
  'ScheduleWakeup', 'CronCreate', 'PreToolUse', 'PostToolUse', 'TypeScript',
])

// ---------------------------------------------------------------- tests

test('the registry parse sees every registry id, in an agent and a practice section', () => {
  const parsed = SECTIONS.flatMap(s => s.ids)
  assert.equal(parsed.length, CONCEPT_IDS.length, 'every registry entry sits under a section header')
  assert.deepEqual(new Set(parsed), new Set(CONCEPT_IDS))
  assert.ok(parsed.every(id => isConceptId(id)))
  assert.deepEqual(MINE.map(s => s.name).sort(), ['agent', 'practice'])
  assert.ok(MINE.every(s => s.ids.length > 0), 'both sections have ids')
})

test('defines every id of its sections exactly once, and no other id', () => {
  const ids = cards.map(c => c.id)
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
  const missing = [...SECTION_OF.keys()].filter(id => !ids.includes(id))
  const extra = ids.filter(id => !SECTION_OF.has(id))
  assert.deepEqual(dupes, [], 'duplicate ids')
  assert.deepEqual(missing, [], 'registry ids with no card')
  assert.deepEqual(extra, [], 'cards for ids outside the agent and practice sections')
  assert.equal(cards.length, SECTION_OF.size)
})

test('categories are valid and match the section the id is registered in', () => {
  for (const c of cards) {
    assert.ok(CATEGORIES.includes(c.category), `${label(c)}: unknown category ${c.category}`)
    assert.equal(c.category, SECTION_OF.get(c.id), `${label(c)}: category must be its section's`)
  }
})

test('fields are present and within their length limits', () => {
  for (const c of cards) {
    assert.ok(c.title.length > 0 && c.title.length <= 32, `${label(c)}: title length ${c.title.length}`)
    for (const k of ['short', 'why', 'deeper', 'tryIt'] as const) {
      const v = c[k] ?? ''
      assert.ok(v.length > 0, `${label(c)}: ${k} is empty`)
      assert.ok(v.length <= LIMITS[k], `${label(c)}: ${k} is ${v.length} chars (max ${LIMITS[k]})`)
    }
  }
})

test('levels are 1, 2 or 3', () => {
  for (const c of cards) assert.ok([1, 2, 3].includes(c.level), `${label(c)}: level ${c.level}`)
})

test('related lists 1–3 registry ids, never itself, never twice', () => {
  for (const c of cards) {
    const rel = c.related ?? []
    assert.ok(rel.length >= 1 && rel.length <= 3, `${label(c)}: ${rel.length} related ids`)
    for (const r of rel) assert.ok(isConceptId(r), `${label(c)}: related “${r}” is not in the registry`)
    assert.ok(!rel.includes(c.id), `${label(c)}: relates to itself`)
    assert.equal(new Set(rel).size, rel.length, `${label(c)}: repeated related id`)
  }
})

test('the destructive-command guard flags dangerous commands and passes safe ones', () => {
  const bad = [
    'rm -rf /', 'rm -r build', 'find . -name "*.tmp" -delete', 'git push --force origin main', 'git push -f origin main',
    'git reset --hard HEAD~1', 'git clean -fdx', 'git checkout -- .', 'git stash drop', 'kill -9 1234', 'pkill python',
    'chmod -R 777 .', 'chmod 777 run.sh', 'mkfs.ext4 /dev/sdb1', 'dd if=/dev/zero of=/dev/sda bs=1M',
    'curl -fsSL https://example.com/i.sh | sh', 'wget -qO- https://example.com | sudo bash', 'sudo dnf install x',
    ':(){ :|:& };:', 'echo hi > notes.txt', 'echo x >> ~/.bashrc', 'make &> build.log', 'sed -i s/a/b/ f.txt',
    'mv a.txt b.txt', 'cp a.txt b.txt', 'ls | tee files.txt', 'crontab -r', 'sqlite3 app.db "DROP TABLE users"',
    'docker system prune -a', 'shred key.pem', 'eval "$CMD"',
  ]
  for (const cmd of bad) assert.notDeepEqual(dangers(cmd), [], `should flag: ${cmd}`)
  const good = [
    'ls -la', 'echo one > /tmp/w.txt', 'ls 2>&1 | head', 'make > /dev/null 2>&1', "jq -e '.a > 1' x.json",
    'cp -an a b', 'cp -a src /tmp/src-copy', "git log --oneline --since='3 days ago'", 'ruff check . && ruff format --diff .',
    'git add -p', "sed 's/a/b/' f.txt | diff f.txt -", 'ls | tee /tmp/files.txt', 'mkdir -p /tmp/x', '/context',
  ]
  for (const cmd of good) assert.deepEqual(dangers(cmd), [], `should pass: ${cmd}`)
})

test('every tryIt is one safe line', () => {
  for (const c of cards) {
    const t = c.tryIt ?? ''
    assert.ok(!/[\n\r\t]/.test(t) && t === t.trim(), `${label(c)}: tryIt must be one trimmed line`)
    assert.deepEqual(dangers(t), [], `${label(c)}: unsafe tryIt “${t}”`)
  }
})

test('titles are unique within the file', () => {
  const titles = cards.map(c => c.title.toLowerCase())
  assert.deepEqual(titles.filter((t, i) => titles.indexOf(t) !== i), [])
})

test('text fields are tidy plain text: no markdown, curly quotes, en-dash ranges', () => {
  for (const c of cards) {
    for (const k of TEXT_FIELDS) {
      const v = c[k]
      const at = `${label(c)}.${k}`
      assert.ok(v === v.trim() && !/\s{2}|[\n\r\t]/.test(v), `${at}: stray whitespace`)
      assert.ok(!/[`*]|\]\(|<\/?[a-zA-Z]|^#|^- /.test(v), `${at}: markdown or markup`)
      assert.ok(!v.includes('"'), `${at}: use curly quotes “ ”, not "`)
      assert.ok(!/\d-\d/.test(v), `${at}: write ranges with an en dash (2–3)`)
    }
    assert.ok(!/[.!?]$/.test(c.title), `${label(c)}: title ends with punctuation`)
  }
})

test('short and why are one sentence; deeper is two or three', () => {
  for (const c of cards) {
    assert.equal(sentenceCount(c.short), 1, `${label(c)}: short should be one sentence`)
    assert.equal(sentenceCount(c.why), 1, `${label(c)}: why should be one sentence`)
    const n = sentenceCount(c.deeper)
    assert.ok(n >= 2 && n <= 3, `${label(c)}: deeper has ${n} sentences`)
    for (const k of ['short', 'why', 'deeper'] as const) assert.match(c[k], /[.?!]$/, `${label(c)}.${k}: end with a full stop`)
  }
})

test('cards name only real tools: no Glob or Grep tool on this build, no invented CamelCase tools', () => {
  for (const c of cards) {
    const text = TEXT_FIELDS.map(k => c[k]).join(' ')
    assert.ok(!/\b(Glob|Grep|MultiEdit)\b/.test(text), `${label(c)}: mentions a tool this build lacks`)
    for (const name of text.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g) ?? []) {
      assert.ok(KNOWN_NAMES.has(name), `${label(c)}: unknown tool-like name ${name}`)
    }
  }
})

test('the export is plain JSON', () => {
  assert.ok(Array.isArray(cards))
  assert.deepEqual(JSON.parse(JSON.stringify(cards)), cards)
  for (const c of cards) {
    for (const [k, v] of Object.entries(c)) assert.notEqual(v, undefined, `${label(c)}.${k} is undefined`)
  }
})
