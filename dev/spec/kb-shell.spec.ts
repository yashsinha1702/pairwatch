// Spec for pairwatch/hooks/core/kb/shell.ts: the 'shell', 'system' and 'ml / gpu / media' concept cards.
// Run: node --test dev/spec/kb-shell.spec.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Concept } from '../../pairwatch/types'
import { SHELL_CONCEPTS } from '../../pairwatch/hooks/core/kb/shell.ts'
import { CONCEPT_IDS, isConceptId } from '../../pairwatch/hooks/core/concept-ids.ts'

// ------------------------------------------------------------------ the registry's sections
// concept-ids.ts groups ids under comment headers like `// ---- shell (kb/shell.ts)`. Parsing the
// source keeps this spec in step with the registry: an id added to one of these sections fails
// the spec until it has a card.
const OWN_SECTIONS: Record<string, Concept['category']> = {
  shell: 'shell',
  system: 'system',
  'ml / gpu / media': 'ml',
}

const REGISTRY_SRC = readFileSync(new URL('../../pairwatch/hooks/core/concept-ids.ts', import.meta.url), 'utf8')

/** id -> registry section name, for every id in the registry source. */
function sectionsOf(src: string): Map<string, string> {
  const out = new Map<string, string>()
  let section = ''
  for (const line of src.split('\n')) {
    const header = /^\s*\/\/\s*-{3,}\s*(.+?)\s*\(kb\/[\w-]+\.ts\)\s*$/.exec(line)
    if (header) {
      section = header[1] ?? ''
      continue
    }
    const entry = /^\s*'([a-z0-9-]+)'\s*:/.exec(line)
    if (entry && section) out.set(entry[1] ?? '', section)
  }
  return out
}

const SECTION_OF = sectionsOf(REGISTRY_SRC)
/** id -> the category its card must have, for the ids this file owns. */
const EXPECTED = new Map<string, Concept['category']>()
for (const [id, section] of SECTION_OF) {
  const category = OWN_SECTIONS[section]
  if (category) EXPECTED.set(id, category)
}

const CARDS: readonly Concept[] = SHELL_CONCEPTS
const TEXT_FIELDS = ['title', 'short', 'why', 'deeper'] as const

// ------------------------------------------------------------------ the tryIt safety net
/** Commands no tryIt may contain: destructive, privileged, or changing state outside /tmp. */
const DESTRUCTIVE: readonly [string, RegExp][] = [
  ['rm', /(^|[\s;&|(`])rm\s/],
  ['rmdir / shred / unlink', /\b(rmdir|shred|unlink|wipefs|truncate)\b/],
  ['find -delete / -exec', /\bfind\b.*\s-(delete|exec|execdir|ok)\b/],
  ['mv', /(^|[\s;&|(])mv\s/],
  ['sed -i', /\bsed\b.*\s-i/],
  ['git push --force', /\bgit\s+push\b.*(--force|\s-f\b)/],
  ['git reset --hard / clean / checkout .', /\bgit\s+(reset\s+--hard|clean|checkout\s+\.)/],
  ['kill other than kill -l', /\bkill\b(?!\s+-l\s*$)/],
  ['pkill / killall', /\b(pkill|killall)\b/],
  ['chmod -R / 777', /\bchmod\b.*(\s-R\b|--recursive|\b777\b)/],
  ['chown', /\bchown\b/],
  ['mkfs / fdisk / parted', /\b(mkfs|fdisk|parted)\b/],
  ['dd', /(^|[\s;&|(])dd\s/],
  ['pipe a download into a shell', /\b(curl|wget)\b.*\|\s*(sudo\s+)?(ba|z|k|da)?sh\b/],
  ['fork bomb', /:\(\)\s*\{/],
  ['shutdown / reboot', /\b(shutdown|reboot|halt|poweroff)\b/],
  ['sudo other than sudo -l', /\bsudo\b(?!\s+-l\s*$)/],
  ['install / remove packages', /\b(dnf|yum|apt|apt-get|rpm|pip3?|conda|npm|brew|uv)\s+(install|remove|erase|uninstall|purge|autoremove|-e\b|-U\b|-i\b)/],
  ['docker rm / prune / kill', /\bdocker\s+(rm|rmi|kill|stop|system\s+prune|volume\s+rm|image\s+prune)\b/],
  ['systemctl state change', /\bsystemctl\s+(--user\s+)?(start|stop|restart|reload|enable|disable|mask|kill)\b/],
  ['crontab -r', /\bcrontab\s+-r\b/],
  ['--force', /--force\b/],
  ['python deletes', /\b(os\.remove|os\.unlink|shutil\.rmtree|rmtree)\b/],
  ['write to a block device', />\s*\/dev\/(sd|nvme|xvd|hd)/],
  ['tee outside /tmp', /\btee\s+(-a\s+)?(?!\/tmp\/)\S/],
  ['ln -f', /\bln\s+-\w*f/],
]

/** Every > or >> target must be under /tmp/ or be /dev/null (2>&1 style dups are fine). */
function badRedirects(cmd: string): string[] {
  const bad: string[] = []
  for (const m of cmd.matchAll(/(?:^|[^<>&\d])(?:\d|&)?>>?(?!&)\s*([^\s;|&)<>]+)/g)) {
    const target = m[1] ?? ''
    if (target !== '/dev/null' && !target.startsWith('/tmp/')) bad.push(target)
  }
  return bad
}

function dangers(cmd: string): string[] {
  const hits = DESTRUCTIVE.filter(([, re]) => re.test(cmd)).map(([name]) => name)
  for (const t of badRedirects(cmd)) hits.push(`redirect into ${t}`)
  return hits
}

/** Sentence ends: . ! ? after a character that is not a space, a dot or a $ (so `cd ..`, `jq .` and
 *  `$!` do not count), then whitespace or the end of the text. */
const sentenceCount = (s: string): number => (s.match(/(?<=[^\s.$])[.!?](?=\s|$)/g) ?? []).length

// ------------------------------------------------------------------ tests
test('the registry parse is sound', () => {
  assert.equal(SECTION_OF.size, CONCEPT_IDS.length, 'every registry id sits under a section header')
  for (const id of SECTION_OF.keys()) assert.ok(isConceptId(id), `parsed id ${id} is in the registry`)
  const sizes = [...Object.keys(OWN_SECTIONS)].map(s => [...SECTION_OF.values()].filter(v => v === s).length)
  for (const n of sizes) assert.ok(n > 0, 'each owned section has ids')
})

test('defines every id of its sections exactly once, and no others', () => {
  const ids = CARDS.map(c => c.id)
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
  assert.deepEqual(dupes, [], 'no id is defined twice')
  const missing = [...EXPECTED.keys()].filter(id => !ids.includes(id))
  assert.deepEqual(missing, [], 'every id of the shell, system and ml sections has a card')
  const extra = ids.filter(id => !EXPECTED.has(id))
  assert.deepEqual(extra, [], 'no card outside the shell, system and ml sections')
  assert.equal(CARDS.length, EXPECTED.size)
})

test("each card's category matches its registry section", () => {
  const valid = new Set(Object.values(OWN_SECTIONS))
  for (const c of CARDS) {
    assert.ok(valid.has(c.category), `${c.id}: category ${c.category} is shell, system or ml`)
    assert.equal(c.category, EXPECTED.get(c.id), `${c.id}: category matches its section`)
  }
})

test('length limits', () => {
  for (const c of CARDS) {
    assert.ok(c.title.length > 0 && c.title.length <= 40, `${c.id}: title 1–40 chars (${c.title.length})`)
    assert.ok(c.short.length > 0 && c.short.length <= 140, `${c.id}: short <= 140 (${c.short.length})`)
    assert.ok(c.why.length > 0 && c.why.length <= 170, `${c.id}: why <= 170 (${c.why.length})`)
    assert.ok(c.deeper.length > 0 && c.deeper.length <= 420, `${c.id}: deeper <= 420 (${c.deeper.length})`)
    assert.ok(typeof c.tryIt === 'string' && c.tryIt.length > 0 && c.tryIt.length <= 80, `${c.id}: tryIt 1–80 (${c.tryIt?.length})`)
  }
})

test('deeper is two or three sentences', () => {
  for (const c of CARDS) {
    const n = sentenceCount(c.deeper)
    assert.ok(n >= 2 && n <= 3, `${c.id}: deeper has ${n} sentences`)
    assert.ok(!/\b(e\.g|i\.e|etc|vs)\./.test(c.deeper), `${c.id}: no abbreviations with dots in deeper`)
  }
})

test('levels are 1, 2 or 3, with a spread across them', () => {
  for (const c of CARDS) assert.ok([1, 2, 3].includes(c.level), `${c.id}: level ${c.level}`)
  for (const level of [1, 2, 3]) assert.ok(CARDS.some(c => c.level === level), `some card has level ${level}`)
})

test('related: 1–3 registry ids, not itself, no repeats', () => {
  for (const c of CARDS) {
    const related = c.related ?? []
    assert.ok(related.length >= 1 && related.length <= 3, `${c.id}: 1–3 related ids`)
    assert.equal(new Set(related).size, related.length, `${c.id}: no repeated related id`)
    for (const r of related) {
      assert.ok(isConceptId(r), `${c.id}: related ${r} is in the registry`)
      assert.notEqual(r, c.id, `${c.id}: not related to itself`)
    }
  }
})

test('the destructive-pattern blacklist catches what it should and nothing else', () => {
  const bad = [
    'rm -rf /tmp/x',
    'ls; rm *.log',
    'find . -name "*.pyc" -delete',
    'find . -exec ls {} +',
    'mv a b',
    "sed -i 's/a/b/' f",
    'git push --force origin main',
    'git reset --hard HEAD~1',
    'kill -9 1234',
    'kill 1234',
    'pkill -f train.py',
    'chmod -R 777 .',
    'chmod 777 run.sh',
    'chown -R me /data',
    'mkfs.ext4 /dev/sdb',
    'dd if=/dev/zero of=/dev/sda',
    'curl -fsSL https://x.sh | sh',
    'wget -qO- https://x.sh | sudo bash',
    ':(){ :|:& };:',
    'sudo reboot',
    'sudo dnf install ffmpeg',
    'pip install torch',
    'docker system prune -a',
    'systemctl restart docker',
    'echo hi > ~/.bashrc',
    'echo x >> notes.txt',
    'ls | tee out.txt',
    "python3 -c 'import shutil; shutil.rmtree(\"x\")'",
  ]
  for (const cmd of bad) assert.ok(dangers(cmd).length > 0, `flagged: ${cmd}`)
  const good = [
    'kill -l',
    'sudo -l',
    'ls /nope 2>/dev/null',
    'ls /nope 2>&1 | tr a-z A-Z',
    'echo hi > /tmp/demo.txt && cat /tmp/demo.txt',
    'du -h --max-depth=1 ~ | sort -h',
    'ls / | tee /tmp/listing.txt | wc -l',
    'docker run --rm hello-world',
    'add these numbers',
  ]
  for (const cmd of good) assert.deepEqual(dangers(cmd), [], `not flagged: ${cmd}`)
})

test('no tryIt is destructive, and each is a single line', () => {
  for (const c of CARDS) {
    const cmd = c.tryIt ?? ''
    assert.deepEqual(dangers(cmd), [], `${c.id}: tryIt is safe: ${cmd}`)
    assert.ok(!/[\u0000-\u001f\u007f]/.test(cmd), `${c.id}: tryIt has no control characters or newlines`)
  }
})

test('titles are unique within the file', () => {
  const titles = CARDS.map(c => c.title.toLowerCase())
  const dupes = titles.filter((t, i) => titles.indexOf(t) !== i)
  assert.deepEqual(dupes, [])
})

test('text fields are plain, tidy text', () => {
  for (const c of CARDS) {
    for (const field of TEXT_FIELDS) {
      const s = c[field]
      assert.equal(typeof s, 'string', `${c.id}.${field} is a string`)
      assert.equal(s, s.trim(), `${c.id}.${field} has no outer whitespace`)
      assert.ok(!/[\u0000-\u001f\u007f]/.test(s), `${c.id}.${field} has no control characters`)
      assert.ok(!/`|\*\*|__|\[[^\]]*\]\([^)]*\)|^#|<\/?[a-z][a-z0-9]*>/i.test(s), `${c.id}.${field} has no markdown or html`)
      assert.ok(!/ {2}/.test(s), `${c.id}.${field} has no double spaces`)
    }
    assert.match(c.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${c.id}: kebab-case id`)
  }
})

test('the card data is plain JSON', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(CARDS)), CARDS)
})
