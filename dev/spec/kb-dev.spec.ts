// Spec for the dev knowledge base, pairwatch/hooks/core/kb/dev.ts.
// Run: node --test dev/spec/kb-dev.spec.ts   (Node 22 strips the types itself)
//
// The registry (concept-ids.ts) marks each section with a header comment naming its kb file, like
// `// ---- git (kb/dev.ts)`. This spec reads those headers, so "my ids" always come from the registry
// itself: a card added there without a definition here (or the reverse) fails the run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DEV_CONCEPTS } from '../../pairwatch/hooks/core/kb/dev.ts'
import { CONCEPT_IDS, isConceptId } from '../../pairwatch/hooks/core/concept-ids.ts'

const KB_FILE = 'kb/dev.ts'
const MY_SECTIONS = ['git', 'python', 'node', 'docker', 'data', 'web']
/** The Concept['category'] union in types/index.d.ts. */
const CATEGORIES = ['agent', 'practice', 'shell', 'system', 'ml', 'git', 'python', 'node', 'docker', 'data', 'web']
/** Contract limits, plus a title limit of our own so card headers fit the pane. */
const LIMITS = { title: 40, short: 140, why: 170, deeper: 420, tryIt: 80 } as const
const PROSE = ['title', 'short', 'why', 'deeper'] as const

const readRepo = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

// ------------------------------------------------------------------------------- registry sections

type Section = { name: string; file: string; ids: string[] }

/** Sections of the registry source: a `// ---- name (kb/x.ts)` header, then `'id': 'hint',` lines. */
function registrySections(src: string): Section[] {
  const sections: Section[] = []
  let current: Section | undefined
  for (const line of src.split('\n')) {
    const head = /^\s*\/\/\s*-{3,}\s*(.+?)\s*\((kb\/[\w.-]+)\)\s*$/.exec(line)
    if (head) {
      current = { name: head[1]!, file: head[2]!, ids: [] }
      sections.push(current)
      continue
    }
    const entry = /^\s*'([a-z0-9-]+)'\s*:/.exec(line)
    if (entry && current) current.ids.push(entry[1]!)
  }
  return sections
}

const SECTIONS = registrySections(readRepo('../../pairwatch/hooks/core/concept-ids.ts'))
const MINE = SECTIONS.filter(s => s.file === KB_FILE)
/** id -> its registry section name, for my sections only */
const SECTION_OF = new Map(MINE.flatMap(s => s.ids.map(id => [id, s.name] as const)))

// ------------------------------------------------------------------------------- safety rules

/** Destructive or state-changing shell patterns no tryIt may contain. Checked on the raw command. */
const DESTRUCTIVE: ReadonlyArray<readonly [string, RegExp]> = [
  ['rm', /(^|[\s;&|(`])rm(dir)?(\s|$)/],
  ['git push', /\bgit\s+push\b/],
  ['force flag', /--force\b/],
  ['git rewrite or discard', /\bgit\s+(reset|clean|checkout|switch|restore|rebase|merge|pull|commit|cherry-pick|revert|am|apply|rm|mv|gc|prune|filter-branch|filter-repo|update-ref|replace)\b/],
  ['git ref delete or move', /\bgit\s+(branch|tag)\b[^|;&]*\s(-[a-zA-Z]*[dDmMfF]\b|--delete\b|--move\b)/],
  ['git stash write', /\bgit\s+stash\s*($|[;&|])|\bgit\s+stash\s+(drop|clear|pop|apply|push|save|store|branch)\b/],
  ['git config write', /\bgit\s+config\b(?![^|;&]*\s(--get|--list|-l)\b)/],
  ['kill', /\b(kill|pkill|killall|xkill)\b/],
  ['permissions', /\b(chmod|chown|chgrp|chattr)\b/],
  ['disk tools', /\b(mkfs(\.\w+)?|dd|shred|wipefs|fdisk|sfdisk|parted|truncate|blkdiscard)\b/],
  ['raw device write', />\s*\/dev\/(sd|nvme|hd|vd|xvd|disk|mmcblk)/],
  ['pipe into a shell', /\|\s*(sudo\s+)?(ba|z|da|k|c|tc|fi)?sh\b/],
  ['download then run', /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(python3?|node|perl|ruby|php)\b|\b(ba|z)?sh\s+<\(\s*(curl|wget)/],
  ['eval', /\beval\b/],
  ['privilege', /\b(sudo|doas)\b|(^|[\s;&|])su(\s|$)/],
  ['power', /\b(shutdown|reboot|halt|poweroff)\b/],
  ['fork bomb', /:\(\)\s*\{/],
  ['in-place edit', /\bsed\b[^|;&]*\s(-[a-zA-Z]*i\S*|--in-place)|\bperl\b[^|;&]*\s-[a-zA-Z]*i/],
  ['move, copy, link or tee', /(^|[\s;&|(])(mv|cp|ln|tee|rsync|scp)\s/],
  ['package change', /\b(pip3?|pipx|npm|pnpm|yarn|bun|conda|mamba|micromamba|brew|apt(-get)?|dnf|yum|zypper|pacman|apk|gem|cargo|go|poetry|pdm)\s+(install|i|add|remove|rm|uninstall|un|update|upgrade|up|ci|sync|publish|unpublish|link|prune|dedupe|create|get)\b/],
  ['uv change', /\buv\s+(add|remove|sync|lock|init|venv|pip\s+(install|uninstall|sync)|tool\s+(install|uninstall)|python\s+(install|uninstall))\b/],
  ['npm pkg write', /\bnpm\s+pkg\s+(set|delete|fix)\b/],
  ['npx auto-yes', /\bnpx\b[^|;&]*\s(-y|--yes)\b/],
  ['docker change', /\bdocker\s+(rm|rmi|kill|stop|restart|run|create|start|exec|build|buildx|push|pull|tag|commit|load|import|prune|update|rename|cp)\b|\bdocker\s+(system|volume|image|container|network|builder)\s+(rm|prune|kill|stop)\b|\bdocker[\s-]compose\s+(up|down|rm|kill|stop|restart|build|pull|push|run|exec|create|start|cp)\b/],
  ['SQL write', /\b(sqlite3|psql|mysql|mariadb|duckdb)\b[\s\S]*\b(drop|delete|truncate|update|insert|alter|replace|create|attach|vacuum)\b/i],
  ['HTTP write', /\bcurl\b[^|;&]*\s(-X|--request)\s*['"]?(post|put|patch|delete)\b/i],
  ['curl sends or saves', /\bcurl\b[^|;&]*\s(-d|-D|--data\S*|--dump-header|-F|--form\S*|-T|--upload-file|--json|-O|--remote-name\S*)(\s|$)|\bcurl\b[^|;&]*\s(-o|--output)\s+(?!\/dev\/null\b)\S/],
  ['wget saves a file', /\bwget\b(?![^|;&]*\s-q?O\s*-(\s|$))/],
  ['gh write', /\bgh\s+(pr\s+(create|merge|close|edit|comment|review|ready|reopen)|issue\s+(create|close|edit|comment|delete|reopen|transfer)|repo\s+(create|delete|edit|fork|rename|archive)|release\s+(create|delete|edit|upload)|secret|variable|workflow\s+(run|enable|disable)|run\s+(cancel|rerun|delete))\b|\bgh\s+api\b[^|;&]*\s(-X|--method|-f|-F|--field|--raw-field|--input)\b/],
  ['find delete or exec', /\bfind\b[^|;&]*\s(-delete|-exec|-execdir|-ok)\b/],
  ['crontab', /\bcrontab\b/],
  ['service change', /\bsystemctl\s+(stop|disable|mask|kill|restart|reboot|poweroff|isolate)\b/],
  ['firewall or mount', /\b(iptables|nft|ufw|firewall-cmd|mount|umount)\b/],
  ['kubectl change', /\bkubectl\s+(delete|apply|create|replace|patch|scale|drain|cordon|edit)\b/],
]

/** The command with quoted strings blanked, so `>` or `|` inside SQL, jq or JS is not read as shell. */
const unquote = (cmd: string): string => cmd.replace(/'[^']*'|"[^"]*"/g, "''")

/** True when the command redirects output into a file (anything but /dev/null or another stream). */
const writesFile = (cmd: string): boolean => /(?<![=<>-])>>?(?!>)\s*(?!&\d|\/dev\/null\b)\S/.test(unquote(cmd))

/** Labels of every destructive pattern the command matches ([] when it is clean). */
function dangers(cmd: string): string[] {
  const hits = DESTRUCTIVE.filter(([, re]) => re.test(cmd)).map(([label]) => label)
  return writesFile(cmd) ? [...hits, 'redirect into a file'] : hits
}

/** Read-only forms of git, gh and docker: a tryIt that calls one of these tools must match. */
const READ_ONLY: ReadonlyArray<readonly [string, readonly RegExp[]]> = [
  ['git', [
    /^git (status|log|diff|show|blame|shortlog|describe|grep|ls-files|ls-tree|cat-file|rev-parse|rev-list|check-ignore|check-attr|merge-base|name-rev|count-objects)\b/,
    /^git branch( -(v|vv|a|r)| --(list|show-current|verbose|all|remotes|merged|no-merged))*$/,
    /^git remote( -v| show \S+| get-url \S+)?$/,
    /^git stash (list|show)\b/,
    /^git reflog( show)?( [^-]\S*| -\d+| --oneline)*$/,
    /^git config (--get|--list|-l)\b/,
    /^git tag( (-l|--list)( \S+)?)?$/,
    /^git worktree list\b/,
  ]],
  ['gh', [
    /^gh (pr (list|status|view|checks|diff)|issue (list|status|view)|run (list|view|watch)|repo view|release (list|view)|search \w+|auth status|status|--version|help)\b/,
  ]],
  ['docker', [
    /^docker (ps|images|version|info|logs|inspect|history|top|port|diff|stats --no-stream)\b/,
    /^docker (image|container|volume|network) (ls|list|inspect|history|logs|top|port)\b/,
    /^docker system (df|info)\b/,
    /^docker compose (ps|ls|config|logs|top|images|version|port)\b/,
  ]],
]

/** Simple commands of a shell line: split on ; && || | and newlines, quotes blanked first. */
const simpleCommands = (cmd: string): string[] =>
  unquote(cmd).split(/&&|\|\||[;|\n]/).map(s => s.trim()).filter(Boolean)

/** The simple commands that call git, gh or docker in a form not on the read-only list. */
function notReadOnly(cmd: string): string[] {
  return simpleCommands(cmd).filter(part => {
    const rule = READ_ONLY.find(([tool]) => part === tool || part.startsWith(tool + ' '))
    return rule !== undefined && !rule[1].some(re => re.test(part))
  })
}

/** Sentence count: terminal punctuation followed by a space or the end of the text. */
const sentences = (text: string): number => (text.match(/[.!?](?=\s|$)/g) ?? []).length

// ------------------------------------------------------------------------------- tests: registry

test('the registry parser sees every registry id, in order, under a kb section header', () => {
  assert.deepEqual(SECTIONS.flatMap(s => s.ids), [...CONCEPT_IDS])
})

test('kb/dev.ts owns exactly the git, python, node, docker, data and web sections', () => {
  assert.deepEqual(MINE.map(s => s.name).sort(), [...MY_SECTIONS].sort())
  assert.ok(SECTION_OF.size >= MY_SECTIONS.length, 'each section has ids')
})

test('every id of my sections is defined exactly once, and there are no extra ids', () => {
  const counts = new Map<string, number>()
  for (const c of DEV_CONCEPTS) counts.set(c.id, (counts.get(c.id) ?? 0) + 1)
  const missing = [...SECTION_OF.keys()].filter(id => !counts.has(id))
  const extra = [...counts.keys()].filter(id => !SECTION_OF.has(id))
  const repeated = [...counts].filter(([, n]) => n > 1).map(([id]) => id)
  assert.deepEqual({ missing, extra, repeated }, { missing: [], extra: [], repeated: [] })
  assert.equal(DEV_CONCEPTS.length, SECTION_OF.size)
})

test('each category is a valid Concept category and matches the registry section of its id', () => {
  for (const c of DEV_CONCEPTS) {
    assert.ok(CATEGORIES.includes(c.category), `${c.id}: unknown category ${c.category}`)
    assert.equal(c.category, SECTION_OF.get(c.id), `${c.id}: category vs registry section`)
  }
})

test('related ids: 1 to 3 registry ids, no repeats, never the card itself', () => {
  for (const c of DEV_CONCEPTS) {
    const related = c.related ?? []
    assert.ok(related.length >= 1 && related.length <= 3, `${c.id}: ${related.length} related`)
    assert.equal(new Set(related).size, related.length, `${c.id}: repeated related id`)
    assert.ok(!related.includes(c.id), `${c.id}: relates to itself`)
    for (const r of related) assert.ok(isConceptId(r), `${c.id}: related id ${r} is not in the registry`)
  }
})

// ------------------------------------------------------------------------------- tests: card text

test('length limits: title 40, short 140, why 170, deeper 420, tryIt 80 (none empty)', () => {
  const over: string[] = []
  for (const c of DEV_CONCEPTS) {
    for (const [field, max] of Object.entries(LIMITS)) {
      const value = c[field as keyof typeof LIMITS]
      if (typeof value !== 'string' || value.length === 0 || value.length > max) over.push(`${c.id}.${field} = ${value?.length}`)
    }
  }
  assert.deepEqual(over, [])
})

test('level is 1, 2 or 3, and every level 1 basics section has a day-one card', () => {
  for (const c of DEV_CONCEPTS) assert.ok([1, 2, 3].includes(c.level), `${c.id}: level ${c.level}`)
  const sectionsWithBasics = new Set<string>(DEV_CONCEPTS.filter(c => c.level === 1).map(c => c.category))
  for (const name of ['git', 'python', 'node', 'data', 'web']) assert.ok(sectionsWithBasics.has(name), `${name} has a level 1 card`)
})

test('titles are unique within the file (ignoring case)', () => {
  const titles = DEV_CONCEPTS.map(c => c.title.toLowerCase())
  assert.deepEqual(titles.filter((t, i) => titles.indexOf(t) !== i), [])
})

test('prose fields are clean single-line plain text, with no Markdown', () => {
  for (const c of DEV_CONCEPTS) {
    for (const field of PROSE) {
      const text = c[field]
      const where = `${c.id}.${field}`
      assert.equal(text, text.trim(), `${where}: stray whitespace`)
      assert.doesNotMatch(text, /[\n\r\t]| {2}/, `${where}: newline, tab or double space`)
      assert.doesNotMatch(text, /`|\*\*|__|\]\(/, `${where}: Markdown syntax`)
      assert.doesNotMatch(text, /^([#>*+-]\s|\d+\.\s)/, `${where}: starts like a Markdown block`)
      assert.doesNotMatch(text, /\b(e\.g|i\.e|etc|vs)\./, `${where}: abbreviation (write it out)`)
      assert.doesNotMatch(text, /[A-Za-z]'[A-Za-z]/, `${where}: straight apostrophe (use ’)`)
    }
    // Literal syntax with straight quotes (JSON, CSV) may appear in deeper; the short fields use “ ”.
    for (const field of ['title', 'short', 'why'] as const) {
      assert.doesNotMatch(c[field], /"/, `${c.id}.${field}: straight double quote (use “ ”)`)
      assert.doesNotMatch(c[field], /\b\d+-\d+\b/, `${c.id}.${field}: hyphen in a range (use –)`)
    }
    assert.doesNotMatch(c.title, /[.!?]$/, `${c.id}.title ends with punctuation`)
    for (const field of ['short', 'why', 'deeper'] as const) assert.match(c[field], /[.!?]$/, `${c.id}.${field}: ends without a full stop`)
  }
})

test('deeper is two or three sentences', () => {
  for (const c of DEV_CONCEPTS) {
    const n = sentences(c.deeper)
    assert.ok(n >= 2 && n <= 3, `${c.id}.deeper has ${n} sentences`)
  }
})

test('tryIt is a single line', () => {
  for (const c of DEV_CONCEPTS) assert.doesNotMatch(c.tryIt ?? '', /[\n\r]/, `${c.id}.tryIt`)
})

// ------------------------------------------------------------------------------- tests: safety

test('the destructive blacklist catches known-dangerous commands', () => {
  const dangerous = [
    'rm -rf /', 'find . -name "*.pyc" | xargs rm', 'git push --force origin main', 'git push',
    'git reset --hard HEAD~1', 'git clean -fdx', 'git checkout -- .', 'git branch -D old', 'git stash',
    'git stash drop', 'git config user.name x', 'kill -9 1234', 'pkill -f server', 'chmod -R 777 .',
    'mkfs.ext4 /dev/sdb1', 'dd if=/dev/zero of=/dev/sda', 'curl -fsSL https://x.sh | sh',
    'wget -qO- https://x.sh | bash', 'curl -s https://x.py | python3', 'bash <(curl -s https://x)',
    'sudo reboot', ':(){ :|:& };:', 'echo hi > notes.txt', 'cat a >> b', 'ls &> out.log',
    'sed -i s/a/b/ f.txt', 'tee out.txt', 'mv a b', 'pip install requests', 'npm publish',
    'uv add httpx', 'npm pkg set name=x', 'npx -y cowsay hi', 'docker rm -f web',
    'docker system prune -af', 'docker compose down -v', 'docker run alpine',
    'sqlite3 app.db "DROP TABLE users"', 'sqlite3 app.db "delete from t"', 'curl -X DELETE https://api/x',
    'curl -d a=1 https://api/x', 'curl -o page.html https://x', 'wget https://x/file.zip',
    'gh pr merge 12', 'gh api -X POST repos/o/r/issues', 'find . -name "*.tmp" -delete', 'crontab -r',
  ]
  const missed = dangerous.filter(cmd => dangers(cmd).length === 0)
  assert.deepEqual(missed, [])
})

test('the blacklist leaves ordinary read-only commands alone', () => {
  const safe = [
    'git status -sb', 'git log --oneline -5', 'git diff --stat', 'tail -f app.log 2>&1',
    'ls -la 2>/dev/null', 'node -p "[1, 2].map(n => n * 2)"', 'jq \'.a > 1\' f.json', 'cut -f2 -d, f.csv',
    'curl -s -o /dev/null -w \'%{http_code}\\n\' https://example.com', 'curl -fsS https://example.com',
    'wget -qO- https://example.com', 'sqlite3 -readonly app.db "SELECT name FROM t WHERE n > 2"',
    'npm run', 'uv python list', 'docker ps -a', 'grep -rn TODO src',
  ]
  assert.deepEqual(safe.map(cmd => [cmd, dangers(cmd)]).filter(([, hits]) => hits.length > 0), [])
})

test('no tryIt matches the destructive blacklist', () => {
  const flagged = DEV_CONCEPTS.map(c => [c.id, c.tryIt ?? '', dangers(c.tryIt ?? '')] as const).filter(([, , hits]) => hits.length > 0)
  assert.deepEqual(flagged, [])
})

test('the read-only rule for git, gh and docker accepts reads and rejects writes', () => {
  const reads = ['git status -sb', 'git branch -vv', 'git remote -v', 'git stash list', 'git tag', 'gh pr checks', 'docker compose ps']
  const writes = ['git commit -m x', 'git branch new', 'git remote add o u', 'git stash', 'git tag v1', 'gh pr merge 1', 'docker rm x', 'docker compose up -d']
  assert.deepEqual(reads.flatMap(notReadOnly), [])
  assert.deepEqual(writes.filter(cmd => notReadOnly(cmd).length === 0), [])
})

test('every git, gh and docker tryIt is read-only', () => {
  const offenders = DEV_CONCEPTS.map(c => [c.id, notReadOnly(c.tryIt ?? '')] as const).filter(([, parts]) => parts.length > 0)
  assert.deepEqual(offenders, [])
})

// ------------------------------------------------------------------------------- tests: module shape

test('cards are plain JSON', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(DEV_CONCEPTS)), DEV_CONCEPTS)
})

test('the module stays pure: type-only imports, no Node APIs, timers or console', () => {
  const src = readRepo('../../pairwatch/hooks/core/kb/dev.ts')
  for (const line of src.split('\n').filter(l => /^\s*(import|export)\b.*\bfrom\b/.test(l))) {
    assert.match(line, /^import type /, `runtime import: ${line}`)
  }
  assert.doesNotMatch(src, /\brequire\(|\bprocess\.|\bconsole\.|\bset(Timeout|Interval)\(|\bDate\.now\(|\bfetch\(/)
})
