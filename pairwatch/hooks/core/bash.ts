// Shell command analysis: what a Bash tool call is doing, for people. Pure, no `$`.
// Contract: the exported names and types below.
//
// How it works:
//   lex       quotes ('…', "…", $'…'), escapes, comments, line continuations, operators,
//             redirections and heredocs (each body attached to the redirect that opened it);
//             $( ), ` `, <( ) and $(( )) stay whole and their sources are remembered.
//   parse     simple commands that know their pipeline, &&/|| chain, loop, condition and
//             group context; VAR=value assignments are tracked so later $VAR resolves;
//             substitutions, bash -c '…', eval and watch strings are parsed recursively.
//   unwrap    sudo, env, timeout, nohup, nice, time, stdbuf, setsid, xargs, uv run, conda run,
//             npx … are looked through to the real program.
//   classify  each command becomes a Role: category, weight, target, files, concepts.
//   combine   setup (cd, export, VAR=, mkdir -p, echo labels) and pager tails (| head, | grep,
//             | sort …) never win; a polling loop becomes one 'wait' Role and a sampling loop
//             (for … sleep, no break) one 'every N seconds' Role; the heaviest remaining Role is
//             the intent (see WEIGHT), and the words come from it.
//
// Decisions worth knowing:
//   - `headline` is always built from the command; the caller shows the tool's description
//     instead when there is one. `description` is used only to settle a tie between plain
//     inspection steps (a script that lists, reads and greps): 'Read …' / 'Search …' / 'List …'.
//   - A write (heredoc, tee, > file, sed -i) beats reads; a heredoc of 5+ lines beats most work
//     after it, except tests, builds, installs and the claude CLI. A compile or syntax check
//     right after a write is a verification step ('…, then checking it compiles').
//   - `nohup cmd &` keeps the category of cmd (a script stays 'run-script'); isBackground carries
//     the background part. Detached tmux/screen sessions and `docker run -d` count as background.
//   - Targets keep credentials and secret-looking query values out ('?api_key=…'), and quoted text
//     (a search pattern, a commit message) has its secrets masked before it is cut (redact.ts).
import type { BashCategory, Station, StepStatus } from '../../types'
import { isConceptId } from './concept-ids.ts'
import { redactSecrets } from './redact.ts'

export type BashAnalysis = {
  /** where it goes on the stage: usually 'run'; 'read' / 'search' / 'edit' / 'web' / 'plan'... when that is what it really does */
  station: Station
  category: BashCategory
  /** substantive programs in order of appearance, setup (cd, export, set, VAR=) left out: ['grep', 'head'] */
  programs: string[]
  /** the dominant program as a person would name it: 'pytest', 'python3 train.py', 'git status', 'nvidia-smi' */
  primary?: string
  /** headline from the command alone (used when the call has no description), plain text <= 90 chars */
  headline: string
  /** the main object: a script, file, dir, url, query (plain text) */
  target?: string
  /** concept ids from CONCEPT_IDS, most specific first, no duplicates */
  concepts: string[]
  isBackground: boolean
  isMultiline: boolean
  /** count of simple commands (pipelines and chains counted per command) */
  segments: number
  /** files it reads whole or in part (cat, head, tail, sed -n, wc ...) */
  readsFiles: string[]
  /** files it writes (heredoc > f, tee f, > f, sed -i f, cp/mv destinations) */
  writesFiles: string[]
  /** what it searches for (grep/rg pattern, find -name glob) */
  searchQuery?: string
  /** where it searches */
  searchWhere?: string
  /** one-sentence why for this kind of command, plain text <= 170 chars */
  why: string
}

/** Analyse one Bash command. `description` is the tool's own description input, when given. Never throws. */
export function analyzeBash(command: string, description?: string): BashAnalysis {
  const cmd = typeof command === 'string' ? command : command == null ? '' : String(command)
  try {
    return analyze(cmd, typeof description === 'string' ? description : undefined)
  } catch {
    return fallback(cmd)
  }
}

/** A short note about how the command ended, from its result text: 'exit 0', '3 matches', 'ModuleNotFoundError: torch'. <= 120 chars. Never throws. */
export function bashResultNote(a: BashAnalysis, status: StepStatus, preview: string): string | undefined {
  try {
    const note = resultNote(a, status, typeof preview === 'string' ? preview : '')
    return note === undefined || note.trim() === '' ? undefined : clip(oneLine(note), 120)
  } catch {
    return undefined
  }
}

// ===================================================================== text helpers

const clip = (s: string, max: number): string => (s.length <= max ? s : s.slice(0, Math.max(1, max - 1)).trimEnd() + '…')
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
const quote = (s: string, max = 30): string => '“' + clip(redactSecrets(oneLine(s)), max) + '”'
const cap = (s: string): string => (s === '' ? s : s.charAt(0).toUpperCase() + s.slice(1))
const lower1 = (s: string): string => (s === '' || /^[A-Z]{2}/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1))
const uniq = <T>(a: readonly T[]): T[] => [...new Set(a)]
const plural = (n: number, one: string, many = one + 's'): string => `${n} ${n === 1 ? one : many}`

/** A record lookup keyed by user text: never reaches Object.prototype ('constructor', 'toString'). */
const own = <T>(rec: Readonly<Record<string, T>>, key: string | undefined): T | undefined => (key !== undefined && Object.hasOwn(rec, key) ? rec[key] : undefined)

function listOf(items: readonly string[], max = 3): string {
  const a = items.filter(x => x !== '')
  if (a.length <= 1) return a[0] ?? ''
  if (a.length === 2) return `${a[0]} and ${a[1]}`
  if (a.length <= max) return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`
  return `${a.slice(0, max - 1).join(', ')} and ${a.length - max + 1} more`
}

/** FNV-1a over the first 2000 chars and the length: picks a 'why' variant stably and cheaply. */
function hash(s: string): number {
  let h = 2166136261 ^ s.length
  const n = Math.min(s.length, 2000)
  for (let i = 0; i < n; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Seconds from a sleep/timeout argument: '30', '1.5', '2m', '1h'. */
function parseDuration(s: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?|\.\d+)([smhd]?)$/.exec(s.trim())
  if (!m) return s.trim() === 'infinity' ? Infinity : undefined
  const k = m[2] === 'm' ? 60 : m[2] === 'h' ? 3600 : m[2] === 'd' ? 86400 : 1
  return Number(m[1]) * k
}

function showDuration(s: number): string {
  if (!Number.isFinite(s)) return 'indefinitely'
  if (s < 1) return 'a moment'
  if (s < 100) {
    const r = Math.round(s * 10) / 10
    return `${r} ${r === 1 ? 'second' : 'seconds'}`
  }
  if (s < 5400) {
    const m = Math.round(s / 60)
    return `${m} ${m === 1 ? 'minute' : 'minutes'}`
  }
  const h = Math.round(s / 360) / 10
  return `${h} ${h === 1 ? 'hour' : 'hours'}`
}

// ===================================================================== paths, urls, patterns

const DOT_DIRS: ReadonlySet<string> = new Set([
  '.claude', '.git', '.github', '.venv', '.vscode', '.idea', '.cache', '.config', '.local', '.ssh', '.npm', '.next',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.conda', '.cargo', '.rustup', '.nvm', '.docker', '.husky',
  '.devcontainer', '.claude-plugin', '.tsbuild',
])
const NO_EXT: ReadonlySet<string> = new Set([
  'Makefile', 'makefile', 'GNUmakefile', 'Dockerfile', 'Containerfile', 'LICENSE', 'README', 'Procfile', 'Gemfile',
  'Rakefile', 'Vagrantfile', 'Jenkinsfile', 'CODEOWNERS', 'Justfile', 'justfile', 'Brewfile', 'Pipfile', 'NOTICE',
  'AUTHORS', 'CHANGELOG', 'VERSION', 'cmdline', 'environ', 'status', 'meminfo', 'cpuinfo',
])
const GENERIC: ReadonlySet<string> = new Set([
  'index.ts', 'index.tsx', 'index.js', 'index.mjs', 'index.html', 'index.d.ts', '__init__.py', '__main__.py', 'main.py',
  'main.ts', 'main.go', 'main.rs', 'mod.rs', 'lib.rs', 'app.py', 'cli.py', 'utils.py', 'util.py', 'common.py',
  'config.py', 'settings.py', 'types.ts', 'config.json', 'config.yaml', 'config.yml', 'settings.json', 'package.json',
  'tsconfig.json', 'pyproject.toml', 'Cargo.toml', 'README.md', 'SKILL.md', 'CLAUDE.md', 'Makefile', 'Dockerfile',
  'docker-compose.yml', 'requirements.txt', 'setup.py', 'run.sh', 'test.py', 'output.log', 'log.txt', 'out.txt',
  'output.txt', 'report.json', 'summary.md', 'manifest.json', 'meta.json', 'metadata.json', 'data.json',
  'results.json', 'train.log', 'driver.log', 'plugin.json', 'hooks.json',
])

function baseName(p: string): string {
  const s = p.replace(/\/+$/, '')
  const k = s.lastIndexOf('/')
  return k < 0 ? s : s.slice(k + 1)
}

function looksDir(p: string): boolean {
  if (p.endsWith('/')) return true
  const b = baseName(p)
  if (b === '' || b === '.' || b === '..' || b === '~' || b === '*') return true
  if (NO_EXT.has(b)) return false
  if (b.startsWith('.')) return DOT_DIRS.has(b)
  return !/\.[A-Za-z0-9_~-]{1,10}$/.test(b) && !/[*?]/.test(b) && !/^\$/.test(b)
}

/** Text that stands for an unknown value: `$f`, `${OUT}`, `{}`, a `$(…)` result. */
const isPlaceholder = (s: string): boolean =>
  /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(s) || s === '{}' || /^[$<>]\(.*\)$/s.test(s) || s === '' || s === '-'

/** `$(…)` becomes '…' and `${VAR%/}` becomes `$VAR`, so a path reads cleanly. */
function tidy(p: string): string {
  let s = p
  for (let guard = 0; guard < 8 && s.includes('$('); guard++) {
    const i = s.indexOf('$(')
    const e = scanClose(s, i + 2, 1, 0)
    s = s.slice(0, i) + '…' + s.slice(e + 1)
  }
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)[^}]*\}/g, '$$$1')
}

/** A short display form of a path: 'src/time.ts', 'RESULTS.md', 'logs/', 'the current folder', '' when unknown. */
function showPath(p: string, dir?: boolean): string {
  let s = tidy(oneLine(p).replace(/^['"]|['"]$/g, ''))
  if (isPlaceholder(s) || /^…?$/.test(s)) return ''
  if (s === '.' || s === './') return 'the current folder'
  if (s === '..' || s === '../') return 'the parent folder'
  if (s === '~' || s === '~/' || s === '$HOME' || /^\/(home\/[^/]+|root)\/?$/.test(s)) return 'the home folder'
  if (s === '/') return 'the root folder'
  const isDir = dir ?? looksDir(s)
  const slash = s.endsWith('/')
  s = s.replace(/^\.\//, '').replace(/\/+$/, '')
  const segs = s.split('/').filter(x => x !== '')
  const last = segs[segs.length - 1] ?? s
  if (last === '*' && slash) {
    const parent = segs.length > 1 ? showPath(segs.slice(0, -1).join('/') + '/', true) : ''
    return `every folder${parent && parent !== 'the current folder' ? ` in ${parent}` : ''}`
  }
  if (/[*?]/.test(last)) {
    const parent = segs.length > 1 ? showPath(segs.slice(0, -1).join('/') + '/', true) : ''
    const inP = parent && parent !== 'the current folder' ? ` in ${parent}` : ''
    if (last === '*') return `every file${inP}`
    if (/^\*\.[\w.-]+$/.test(last)) return `the ${last} files${inP}`
    return `the files matching ${clip(last, 30)}${inP}`
  }
  if (/^…/.test(last) && last.replace(/^…/, '').length <= 5) return ''
  const rel = !/^[/~$…]/.test(s)
  let out: string
  if (rel && segs.length <= 2 && s.length <= 30) out = s
  else if (segs.length >= 2 && (GENERIC.has(last) || /^…/.test(last))) out = `${segs[segs.length - 2]}/${last}`
  else out = last
  out = clip(out, 44)
  return isDir && !out.endsWith('/') && !out.endsWith('…') ? out + '/' : out
}

/** showPath, or `fallback` when the path is unknown. */
const P = (t: string | undefined, fallback: string, dir?: boolean): string => {
  const s = t === undefined ? '' : showPath(t, dir)
  return s === '' ? fallback : s
}

/** Two paths that would read the same get their parent folder too: 'shop/' vs 'backup/shop/'. */
function showTwo(a: string, b: string): [string, string] {
  const x = showPath(a)
  const y = showPath(b)
  if (x !== y || x === '') return [x, y]
  const two = (p: string): string => {
    const segs = tidy(p).replace(/\/+$/, '').split('/').filter(Boolean)
    return segs.slice(-2).join('/') + (looksDir(p) ? '/' : '')
  }
  return [two(a), two(b)]
}

const isDevNull = (t: string): boolean => /^\/dev\/(null|stdout|stderr|tty|fd\/\d)$/.test(t) || /^&?-?\d?$/.test(t)

const SENSITIVE_KEY = /token|secret|passw|pwd|key|sig|auth|session|credential|code/i

/** The URL without credentials or secret-looking query values. */
function cleanUrl(u: string): string {
  let s = u.trim().replace(/^['"]|['"]$/g, '')
  s = s.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1')
  const q = s.indexOf('?')
  if (q >= 0) {
    const params = s
      .slice(q + 1)
      .split('&')
      .map(kv => {
        const eq = kv.indexOf('=')
        return eq > 0 && SENSITIVE_KEY.test(kv.slice(0, eq)) ? `${kv.slice(0, eq)}=…` : kv
      })
    s = s.slice(0, q) + '?' + params.join('&')
  }
  return s
}

function urlParts(u: string): { host: string; hostport: string; path: string; local: boolean } {
  const s = cleanUrl(u).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  const cut = s.search(/[/?#]/)
  const hostport = cut < 0 ? s : s.slice(0, cut)
  const path = cut < 0 ? '' : s.slice(cut)
  const host = hostport.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  const local = /^(localhost|127(?:\.\d+){3}|0\.0\.0\.0|::1|host\.docker\.internal)$/i.test(host)
  return { host, hostport, path, local }
}

function showUrl(u: string, max = 52): string {
  const { hostport, path } = urlParts(tidy(u))
  let p = path.replace(/\?.*$/, q => (q.length > 24 ? '?…' : q))
  if (p === '/') p = ''
  return clip(hostport + p, max)
}

const looksUrl = (s: string): boolean =>
  /^(https?|ftp|wss?):\/\//i.test(s) || /^(localhost|127\.\d|0\.0\.0\.0|\[::1\])/i.test(s) || /^[\w-]+(\.[\w-]+)*\.[a-z]{2,}(:\d+)?\/\S*$/i.test(s)

/** Split a pattern at its top-level alternation: \\| in basic regex, | in extended. */
function splitTop(p: string, ere: boolean): string[] {
  const alts: string[] = []
  let cur = ''
  let depth = 0
  let bracket = false
  for (let i = 0; i < p.length; i++) {
    const c = p.charAt(i)
    if (bracket) {
      cur += c
      if (c === ']') bracket = false
      continue
    }
    if (c === '[') {
      bracket = true
      cur += c
      continue
    }
    if (c === '\\') {
      const d = p.charAt(i + 1)
      if (!ere && d === '|' && depth === 0) {
        alts.push(cur)
        cur = ''
        i++
        continue
      }
      if (!ere && d === '(') depth++
      if (!ere && d === ')') depth--
      cur += c + d
      i++
      continue
    }
    if (ere && c === '(') depth++
    if (ere && c === ')') depth--
    if (ere && c === '|' && depth === 0) {
      alts.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  alts.push(cur)
  return alts
}

/** The readable words of one alternative: anchors, \\b, escapes and regex machinery stripped. */
function literalOf(a: string): string {
  const t = a.replace(/^\^/, '').replace(/\$$/, '').replace(/\\[b<>]/g, '').replace(/^\.\*|\.\*$/g, '').trim()
  const unesc = t.replace(/\\([^A-Za-z0-9])/g, '$1')
  // escaped punctuation is literal text: park it on private-use characters while splitting
  const parked = t.replace(/\\([^A-Za-z0-9])/g, (_m: string, c: string) => String.fromCharCode(0xe100 + c.charCodeAt(0)))
  if (!/[[\](){}*+?|^$\\]|\.[*+?{]/.test(parked)) return unesc.replace(/^(['"])(.*)\1$/, '$2')
  const chunks = parked
    .split(/\[[^\]]*\]|\{[\d,]*\}|\\[a-zA-Z]|[()|*+?^$]|\.(?=[*+?{])/)
    .map(c => c.replace(/[\ue100-\ue17f]/g, (ch: string) => String.fromCharCode(ch.charCodeAt(0) - 0xe100)).trim())
    .filter(c => /[A-Za-z0-9]/.test(c))
  let best = ''
  for (const c of chunks) if (c.length > best.length) best = c
  return best.length >= 2 ? best.replace(/^(['"])(.*)\1$/, '$2') : unesc
}

/** The alternatives of a grep pattern as a person would read them. */
function patternAlts(p: string, ere: boolean): string[] {
  let alts = splitTop(p, ere)
  if (alts.length === 1) {
    // one group of alternatives: ^(torch|numpy) or \(a\|b\)
    const one = alts[0] ?? ''
    const g = ere ? /^([^()]*)\(([^()]*\|[^()]*)\)([^()]*)$/.exec(one) : /^((?:[^\\]|\\[^()])*)\\\(((?:[^\\]|\\[^()])*\\\|(?:[^\\]|\\[^()])*)\\\)((?:[^\\]|\\[^()])*)$/.exec(one)
    if (g && !/[A-Za-z0-9]{2}/.test((g[1] ?? '') + (g[3] ?? ''))) alts = splitTop(g[2] ?? '', ere)
  }
  return uniq(alts.map(literalOf).filter(a => a !== ''))
}

function showQuery(p: string, ere: boolean): string {
  const alts = patternAlts(p, ere)
  if (alts.length <= 1) return quote(alts[0] ?? p)
  if (alts.length === 2) return `${quote(alts[0] ?? '', 24)} or ${quote(alts[1] ?? '', 24)}`
  return `${quote(alts[0] ?? '', 22)}, ${quote(alts[1] ?? '', 22)} and ${alts.length - 2} more`
}

/** What a familiar pattern is looking for: Markdown headings, definitions, imports, errors. */
function patternIntent(p: string, ere: boolean): string | undefined {
  const raw = splitTop(p, ere).map(a => a.trim())
  if (!raw.length) return undefined
  if (raw.every(a => /^\^#{1,6}\s*\+?\s*$|^\^#\+?\s*$/.test(a) || /^\^#{1,6} ?$/.test(a))) return 'headings'
  const alts = patternAlts(p, ere).map(a => a.trim())
  if (alts.every(a => /^(def|class|async def|function|export (async )?function|export (default )?class|func|fn|interface|struct|impl)$/.test(a))) return 'definitions'
  if (alts.every(a => /^(import|from|require|use|include)$/.test(a))) return 'imports'
  if (alts.every(a => /^(todo|fixme|xxx|hack)$/i.test(a))) return 'to-do notes'
  if (alts.length && alts.every(a => /^(error|errors|exception|traceback|fail|failed|failure|fatal|panic|warn|warning|critical|oom|out of memory|killed|abort|aborted|cuda out of memory|outofmemory(error)?|runtimeerror|valueerror|keyerror)$/i.test(a))) return 'errors'
  return undefined
}

function hasRegex(p: string, fixed: boolean): boolean {
  if (fixed || p === '') return false
  return /[\^$*+?()[\]{}|]|\\[dDwWsSbB<>|()]/.test(p.replace(/\\[.\-/]/g, ''))
}

// ===================================================================== lexer

/** Stands for a literal '$' (quoted or escaped) so variable expansion leaves it alone. */
const LIT = '\uE000'
const unlit = (s: string): string => (s.includes(LIT) ? s.split(LIT).join('$') : s)

type WordTok = { k: 'w'; v: string; raw: string; q: boolean; subs: string[] }
type OpTok = { k: 'op'; v: string }
type HereDoc = { delim: string; quoted: boolean; strip: boolean; body: string }
type RedirTok = { k: 'r'; op: string; fd: string; target: WordTok | null; doc: HereDoc | null }
type Tok = WordTok | OpTok | RedirTok

const MAX_NEST = 48

const isBlank = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v'
const isWordEnd = (c: string | undefined): boolean =>
  c === undefined || isBlank(c) || c === '\n' || c === ';' || c === '&' || c === '|' || c === '<' || c === '>' || c === '(' || c === ')'

function skipBacktick(src: string, i: number): number {
  const n = src.length
  while (i < n) {
    const c = src.charAt(i)
    if (c === '\\') i += 2
    else if (c === '`') return i
    else i++
  }
  return n
}

function skipDouble(src: string, i: number, lvl: number): number {
  const n = src.length
  while (i < n) {
    const c = src.charAt(i)
    if (c === '\\') i += 2
    else if (c === '"') return i + 1
    else if (c === '$' && src.charAt(i + 1) === '(' && lvl < MAX_NEST) i = scanClose(src, i + 2, 1, lvl + 1) + 1
    else if (c === '`') i = skipBacktick(src, i + 1) + 1
    else i++
  }
  return n
}

const DOC_DELIM = /^(['"]?)([A-Za-z0-9_.:+@%-]+)\1/

function skipDocs(src: string, i: number, docs: readonly { delim: string; strip: boolean }[]): number {
  const n = src.length
  for (const d of docs) {
    while (i < n) {
      let e = src.indexOf('\n', i)
      if (e < 0) e = n
      let line = src.slice(i, e)
      i = e < n ? e + 1 : n
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (d.strip) line = line.replace(/^\t+/, '')
      if (line === d.delim) break
    }
  }
  return i
}

/** From inside an open paren (at `depth`), the index of the paren that closes it (or the length). */
function scanClose(src: string, i: number, depth: number, lvl: number): number {
  const n = src.length
  let docs: { delim: string; strip: boolean }[] | null = null
  while (i < n) {
    const c = src.charAt(i)
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === "'") {
      const e = src.indexOf("'", i + 1)
      i = e < 0 ? n : e + 1
      continue
    }
    if (c === '"') {
      i = lvl < MAX_NEST ? skipDouble(src, i + 1, lvl + 1) : i + 1
      continue
    }
    if (c === '`') {
      i = skipBacktick(src, i + 1) + 1
      continue
    }
    if (c === '#') {
      const p = i > 0 ? src.charAt(i - 1) : ''
      if (p === '' || isBlank(p) || p === '\n' || p === ';' || p === '(' || p === '&' || p === '|') {
        const e = src.indexOf('\n', i)
        i = e < 0 ? n : e
        continue
      }
    } else if (c === '<' && src.charAt(i + 1) === '<' && src.charAt(i + 2) !== '<') {
      let j = i + 2
      let strip = false
      if (src.charAt(j) === '-') {
        strip = true
        j++
      }
      while (isBlank(src.charAt(j))) j++
      const m = DOC_DELIM.exec(src.slice(j, j + 64))
      if (m) {
        ;(docs ??= []).push({ delim: m[2] ?? '', strip })
        i = j + m[0].length
        continue
      }
    } else if (c === '\n') {
      if (docs) {
        i = skipDocs(src, i + 1, docs)
        docs = null
        continue
      }
    } else if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth <= 0) return i
    }
    i++
  }
  return n
}

function scanBrace(src: string, i: number): number {
  const n = src.length
  let depth = 1
  while (i < n) {
    const c = src.charAt(i)
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === '"') {
      i = skipDouble(src, i + 1, 1)
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i
    } else if (c === '\n') return i - 1
    i++
  }
  return n
}

/** At `$(`: remember the substitution's source; returns the index after it. `$((` arithmetic is scanned for nested `$(`. */
function readSubst(src: string, i: number, subs: string[], lvl: number): number {
  if (src.charAt(i + 2) === '(') {
    const e = scanClose(src, i + 3, 2, lvl + 1)
    if (lvl < MAX_NEST) collectSubs(src.slice(i + 3, Math.max(i + 3, e - 1)), subs, lvl + 1)
    return e + 1
  }
  const e = scanClose(src, i + 2, 1, lvl + 1)
  subs.push(src.slice(i + 2, e))
  return e + 1
}

function collectSubs(text: string, subs: string[], lvl: number): void {
  const n = text.length
  for (let k = 0; k < n; k++) {
    const c = text.charAt(k)
    if (c === "'") {
      const e = text.indexOf("'", k + 1)
      if (e < 0) return
      k = e
    } else if (c === '$' && text.charAt(k + 1) === '(') k = readSubst(text, k, subs, lvl) - 1
    else if (c === '`') {
      const e = skipBacktick(text, k + 1)
      subs.push(text.slice(k + 1, e))
      k = e
    }
  }
}

function readDouble(src: string, j: number, subs: string[]): [string, number] {
  const n = src.length
  let v = ''
  while (j < n) {
    const c = src.charAt(j)
    if (c === '"') return [v, j + 1]
    if (c === '\\') {
      const d = src.charAt(j + 1)
      if (d === '"' || d === '\\' || d === '`') {
        v += d
        j += 2
      } else if (d === '$') {
        v += LIT
        j += 2
      } else if (d === '\n') j += 2
      else {
        v += '\\'
        j++
      }
      continue
    }
    if (c === '$' && src.charAt(j + 1) === '(') {
      const e = readSubst(src, j, subs, 0)
      v += src.slice(j, e)
      j = e
      continue
    }
    if (c === '$' && src.charAt(j + 1) === '{') {
      const e = scanBrace(src, j + 2)
      v += src.slice(j, e + 1)
      j = e + 1
      continue
    }
    if (c === '`') {
      const e = skipBacktick(src, j + 1)
      subs.push(src.slice(j + 1, e))
      v += src.slice(j, e + 1)
      j = e + 1
      continue
    }
    v += c
    j++
  }
  return [v, n]
}

const ANSI_ESC: ReadonlyMap<string, string> = new Map([
  ['n', '\n'], ['t', '\t'], ['r', '\r'], ['\\', '\\'], ["'", "'"], ['"', '"'], ['?', '?'], ['a', ''], ['b', ''], ['e', ''], ['E', ''], ['f', ''], ['v', ''],
])

function readAnsi(src: string, j: number): [string, number] {
  const n = src.length
  let v = ''
  while (j < n) {
    const c = src.charAt(j)
    if (c === "'") return [v, j + 1]
    if (c === '\\' && j + 1 < n) {
      const d = src.charAt(j + 1)
      v += ANSI_ESC.get(d) ?? '\\' + d
      j += 2
      continue
    }
    v += c
    j++
  }
  return [v, n]
}

function lex(src: string): Tok[] {
  const n = src.length
  const toks: Tok[] = []
  let pending: HereDoc[] = []
  let i = 0

  const readDocs = (): void => {
    for (const d of pending) {
      const lines: string[] = []
      while (i < n) {
        let e = src.indexOf('\n', i)
        if (e < 0) e = n
        const line = src.slice(i, e)
        i = e < n ? e + 1 : n
        let cmp = line.endsWith('\r') ? line.slice(0, -1) : line
        if (d.strip) cmp = cmp.replace(/^\t+/, '')
        if (cmp === d.delim) break
        lines.push(d.strip ? line.replace(/^\t+/, '') : line)
      }
      d.body = lines.join('\n')
    }
    pending = []
  }

  const word = (): WordTok => {
    const start = i
    let v = ''
    let q = false
    const subs: string[] = []
    while (i < n) {
      const c = src.charAt(i)
      if ((c === '<' || c === '>') && src.charAt(i + 1) === '(') {
        const e = scanClose(src, i + 2, 1, 0)
        subs.push(src.slice(i + 2, e))
        v += src.slice(i, e + 1)
        i = e + 1
        continue
      }
      if (c === '(' && /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=$/.test(v)) {
        const e = scanClose(src, i + 1, 1, 0)
        v += src.slice(i, e + 1)
        i = e + 1
        continue
      }
      if (isWordEnd(c)) break
      if (c === '\\') {
        const d = src.charAt(i + 1)
        i += 2
        if (d === '' || d === '\n') continue
        v += d === '$' ? LIT : d
        q = true
        continue
      }
      if (c === "'") {
        const e = src.indexOf("'", i + 1)
        const end = e < 0 ? n : e
        v += src.slice(i + 1, end).split('$').join(LIT)
        q = true
        i = end + 1
        continue
      }
      if (c === '"') {
        const [s, e] = readDouble(src, i + 1, subs)
        v += s
        q = true
        i = e
        continue
      }
      if (c === '`') {
        const e = skipBacktick(src, i + 1)
        subs.push(src.slice(i + 1, e))
        v += src.slice(i, e + 1)
        i = e + 1
        continue
      }
      if (c === '$') {
        const d = src.charAt(i + 1)
        if (d === "'") {
          const [s, e] = readAnsi(src, i + 2)
          v += s.split('$').join(LIT)
          q = true
          i = e
          continue
        }
        if (d === '"') {
          const [s, e] = readDouble(src, i + 2, subs)
          v += s
          q = true
          i = e
          continue
        }
        if (d === '(') {
          const e = readSubst(src, i, subs, 0)
          v += src.slice(i, e)
          i = e
          continue
        }
        if (d === '{') {
          const e = scanBrace(src, i + 2)
          v += src.slice(i, e + 1)
          i = e + 1
          continue
        }
      }
      v += c
      i++
    }
    return { k: 'w', v, raw: src.slice(start, i), q, subs }
  }

  const redir = (fd: string): void => {
    const c = src.charAt(i)
    const d = src.charAt(i + 1)
    let op: string
    if (c === '<') {
      if (d === '<' && src.charAt(i + 2) === '<') op = '<<<'
      else if (d === '<') op = src.charAt(i + 2) === '-' ? '<<-' : '<<'
      else if (d === '>') op = '<>'
      else if (d === '&') op = '<&'
      else op = '<'
    } else if (d === '>') op = '>>'
    else if (d === '&') op = '>&'
    else if (d === '|') op = '>|'
    else op = '>'
    i += op.length
    while (i < n && isBlank(src.charAt(i))) i++
    const t = src.charAt(i)
    let target: WordTok | null = null
    if (t !== '' && t !== '\n' && t !== ';' && t !== '&' && t !== '|' && t !== ')' && t !== '(' && !((t === '<' || t === '>') && src.charAt(i + 1) !== '(')) target = word()
    let doc: HereDoc | null = null
    if ((op === '<<' || op === '<<-') && target) {
      doc = { delim: unlit(target.v), quoted: /['"\\]/.test(target.raw), strip: op === '<<-', body: '' }
      pending.push(doc)
    }
    toks.push({ k: 'r', op: fd === '&' ? '&' + op : op, fd: fd === '&' ? '' : fd, target, doc })
  }

  while (i < n) {
    const c = src.charAt(i)
    if (isBlank(c)) {
      i++
      continue
    }
    if (c === '\\' && src.charAt(i + 1) === '\n') {
      i += 2
      continue
    }
    if (c === '#') {
      const e = src.indexOf('\n', i)
      i = e < 0 ? n : e
      continue
    }
    if (c === '\n') {
      toks.push({ k: 'op', v: '\n' })
      i++
      if (pending.length) readDocs()
      continue
    }
    if (c >= '0' && c <= '9') {
      let j = i + 1
      while (j < n && j - i < 3 && src.charAt(j) >= '0' && src.charAt(j) <= '9') j++
      const r = src.charAt(j)
      if ((r === '>' || r === '<') && src.charAt(j + 1) !== '(') {
        const fd = src.slice(i, j)
        i = j
        redir(fd)
        continue
      }
    }
    if ((c === '<' || c === '>') && src.charAt(i + 1) !== '(') {
      redir('')
      continue
    }
    if (c === '&') {
      if (src.charAt(i + 1) === '&') {
        toks.push({ k: 'op', v: '&&' })
        i += 2
      } else if (src.charAt(i + 1) === '>') {
        i++
        redir('&')
      } else {
        toks.push({ k: 'op', v: '&' })
        i++
      }
      continue
    }
    if (c === '|') {
      const d = src.charAt(i + 1)
      const v = d === '|' ? '||' : d === '&' ? '|&' : '|'
      toks.push({ k: 'op', v })
      i += v.length
      continue
    }
    if (c === ';') {
      const v = src.startsWith(';;&', i) ? ';;&' : src.startsWith(';;', i) ? ';;' : src.startsWith(';&', i) ? ';&' : ';'
      toks.push({ k: 'op', v })
      i += v.length
      continue
    }
    if (c === '(') {
      if (src.charAt(i + 1) === '(') {
        const e = scanClose(src, i + 2, 2, 0)
        const subs: string[] = []
        collectSubs(src.slice(i + 2, Math.max(i + 2, e - 1)), subs, 0)
        toks.push({ k: 'w', v: '((', raw: src.slice(i, e + 1), q: false, subs })
        i = e + 1
        continue
      }
      toks.push({ k: 'op', v: '(' })
      i++
      continue
    }
    if (c === ')') {
      toks.push({ k: 'op', v: ')' })
      i++
      continue
    }
    const before = i
    toks.push(word())
    if (i === before) i++ // never stall on an odd character
  }
  return toks
}

// ===================================================================== parser

type Loop = {
  kind: 'for' | 'while' | 'until' | 'select'
  varName: string
  items: string[]
  cond: Cmd[]
  body: Cmd[]
  sleeps: number[]
  /** commands whose outcome ends the loop through `break`: ends = true means "breaks when it succeeds" */
  guards: { cmds: Cmd[]; ends: boolean }[]
  breaks: number
}

type Inv = {
  /** normalised program name: 'python3', 'git', 'run.sh' */
  prog: string
  /** the program word as typed (expanded) */
  word: string
  args: string[]
  wrap: string[]
  secs?: number
  env: string[]
  /** a shell string to parse: bash -c '…', eval, watch, a heredoc fed to bash */
  inner?: string
}

type Cmd = {
  idx: number
  argv: string[]
  quoted: boolean[]
  assigns: { name: string; value: string }[]
  redirs: { op: string; fd: string; target: string }[]
  doc: { body: string; quoted: boolean } | null
  herestr: string | null
  pipe: number
  pos: number
  len: number
  joiner: string
  bg: boolean
  neg: boolean
  loops: Loop[]
  condOf: Loop | null
  origin: 'top' | 'sub' | 'inner'
  wrap: string[]
  u: Inv
  inner: Cmd[]
  subs: Cmd[]
  /** loop variables with several items used in its words (for 'and N more') */
  multi: number
  /** the items of that loop variable */
  loopItems?: string[]
  /** the program itself comes from a loop variable: `for c in a b; do $c --version; done` */
  progItems?: string[]
  /** a redirect that follows a closing } or ): it applies to the whole group */
  groupOut?: boolean
}

type Shape = {
  pipe: boolean
  and: boolean
  or: boolean
  bg: boolean
  heredoc: boolean
  subst: boolean
  redirOut: boolean
  redirIn: boolean
  stderr: boolean
  strict: boolean
  envVar: boolean
  source: boolean
  glob: boolean
  exitCode: boolean
  quoting: boolean
}

type PState = {
  vars: Map<string, string>
  loopN: Map<string, number>
  loopItems: Map<string, string[]>
  cmds: Cmd[]
  loops: Loop[]
  shape: Shape
  pipeSeq: number
}

const MAX_CMDS = 600
const MAX_DEPTH = 5

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g

function expand(s: string, vars: ReadonlyMap<string, string>): string {
  if (!s.includes('$')) return unlit(s)
  const out = s.replace(VAR_RE, (m: string, a: string | undefined, b: string | undefined) => vars.get(a ?? b ?? '') ?? m)
  return unlit(out)
}

/** A value for VAR=…: `$(ls X)`, `$(realpath X)`, `$(which X)` resolve to X for display. */
function assignValue(v: string, vars: ReadonlyMap<string, string>): string {
  const m = /^\$\(\s*(ls|echo|realpath|readlink|which|command\s+-v|dirname|basename|printf\s+%s)((?:\s+-[\w-]+)*)\s+(['"]?)([^\s()$`|;&<>'"]+)\3\s*\)$/.exec(v)
  if (m) {
    const x = expand(m[4] ?? '', vars)
    if (m[1] === 'dirname') return x.replace(/\/[^/]*\/?$/, '') || '.'
    if (m[1] === 'basename') return baseName(x)
    return x
  }
  if (/^\$\(\s*pwd\s*\)$/.test(v)) return '.'
  return expand(v, vars)
}

type Cur = { words: WordTok[]; assigns: WordTok[]; redirs: RedirTok[]; dbl: boolean; groupOut?: boolean }
type Frame = {
  kind: 'for' | 'while' | 'until' | 'select' | 'if' | 'case' | 'group' | 'sub'
  phase: string
  loop?: Loop
  inSeen?: boolean
  guard?: { cmds: Cmd[]; ends: boolean } | null
  ifCond?: Cmd[]
}

const isAssignWord = (w: WordTok): boolean => /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(w.raw)

function newShape(): Shape {
  return {
    pipe: false, and: false, or: false, bg: false, heredoc: false, subst: false, redirOut: false, redirIn: false, stderr: false,
    strict: false, envVar: false, source: false, glob: false, exitCode: false, quoting: false,
  }
}

function parseScript(src: string, st: PState, origin: Cmd['origin'], wrap: string[], depth: number, outer: Loop[]): Cmd[] {
  const made: Cmd[] = []
  if (depth > MAX_DEPTH || src.trim() === '' || st.cmds.length >= MAX_CMDS) return made
  const toks = lex(src)
  const frames: Frame[] = []
  let cur: Cur | null = null
  let neg = false
  let joiner = ''
  let pipe = st.pipeSeq++
  let pos = 0
  let pipeCmds: Cmd[] = []
  let lastPipe: Cmd[] = []
  let afterPipe = false
  let closed = false

  const loopsNow = (): Loop[] => {
    const a = outer.slice()
    for (const f of frames) if (f.loop) a.push(f.loop)
    return a
  }
  const condLoop = (): Loop | null => {
    for (let k = frames.length - 1; k >= 0; k--) {
      const f = frames[k]
      if (!f || f.kind === 'if') return null
      if (f.loop) return (f.kind === 'while' || f.kind === 'until') && f.phase === 'cond' ? f.loop : null
    }
    return null
  }
  const ifCondFrame = (): Frame | null => {
    for (let k = frames.length - 1; k >= 0; k--) {
      const f = frames[k]
      if (!f || f.loop) return null
      if (f.kind === 'if') return f.phase === 'cond' ? f : null
    }
    return null
  }
  const guardFromFrames = (): { cmds: Cmd[]; ends: boolean } | null => {
    for (let k = frames.length - 1; k >= 0; k--) {
      const f = frames[k]
      if (!f || f.loop) return null
      if (f.kind === 'if' && f.phase === 'body' && f.ifCond && f.ifCond.length) return { cmds: f.ifCond, ends: true }
      if (f.kind === 'group' && f.guard) return f.guard
    }
    return null
  }
  const innermost = (pred: (f: Frame) => boolean): number => {
    for (let k = frames.length - 1; k >= 0; k--) {
      const f = frames[k]
      if (f && pred(f)) return k
    }
    return -1
  }

  const endCmd = (): void => {
    const c = cur
    cur = null
    if (!c || (!c.words.length && !c.assigns.length && !c.redirs.length)) return
    if (st.cmds.length >= MAX_CMDS) return
    const cmd = buildCmd(c, st, origin, wrap, loopsNow())
    cmd.pipe = pipe
    cmd.pos = pos
    cmd.joiner = joiner
    cmd.neg = neg
    cmd.condOf = condLoop()
    const ifc = ifCondFrame()
    if (ifc) (ifc.ifCond ??= []).push(cmd)
    made.push(cmd)
    st.cmds.push(cmd)
    pipeCmds.push(cmd)
    for (const L of cmd.loops) L.body.push(cmd)
    if (cmd.condOf) cmd.condOf.cond.push(cmd)
    const p = cmd.u.prog
    if (p === 'sleep') {
      const s = parseDuration(cmd.u.args.find(a => !a.startsWith('-')) ?? '') ?? 0
      for (const L of cmd.loops) L.sleeps.push(s)
    }
    if (p === 'break' && cmd.loops.length) {
      const L = cmd.loops[cmd.loops.length - 1]
      if (L) {
        L.breaks++
        const g = (joiner === '&&' || joiner === '||') && lastPipe.length ? { cmds: lastPipe, ends: joiner === '&&' } : guardFromFrames()
        if (g) L.guards.push(g)
      }
    }
    for (const s of c.words.flatMap(w => w.subs).concat(c.assigns.flatMap(w => w.subs), c.redirs.flatMap(r => r.target?.subs ?? []))) {
      const sub = parseScript(s, st, 'sub', wrap, depth + 1, cmd.loops)
      if (sub.length) st.shape.subst = true
      cmd.subs.push(...sub)
    }
    if (cmd.u.inner !== undefined) {
      const inn = parseScript(cmd.u.inner, st, origin === 'sub' ? 'sub' : 'inner', wrap.concat(cmd.u.wrap), depth + 1, cmd.loops)
      cmd.inner.push(...inn)
    }
  }

  const endPipe = (op: string): void => {
    endCmd()
    for (const c of pipeCmds) {
      c.len = pipeCmds.length
      if (op === '&') {
        c.bg = true
        for (const k of c.inner) k.bg = true
      }
    }
    if (pipeCmds.length > 1) st.shape.pipe = true
    if (pipeCmds.length) {
      if (op === '&') st.shape.bg = true
      if (op === '&&') st.shape.and = true
      if (op === '||') st.shape.or = true
      lastPipe = pipeCmds
    }
    pipeCmds = []
    pipe = st.pipeSeq++
    pos = 0
    neg = false
    joiner = op
    afterPipe = false
  }

  for (let ti = 0; ti < toks.length; ti++) {
    const t = toks[ti]
    if (!t) continue
    const wasClosed = closed
    if (t.k !== 'r') closed = false
    const top = frames[frames.length - 1]
    // case: skip the subject and the patterns, up to the ')' that ends each pattern
    if (top && top.kind === 'case' && top.phase !== 'body') {
      if (t.k === 'w' && !t.q && t.v === 'esac') frames.pop()
      else if (top.phase === 'word') {
        if (t.k === 'w' && t.v === 'in') top.phase = 'pat'
      } else if (t.k === 'op' && t.v === ')') top.phase = 'body'
      continue
    }
    // for-loop head: NAME [in WORDS…] up to 'do'
    if (top && top.loop && top.phase === 'head') {
      if (t.k === 'w' && !t.q && t.v === 'do') {
        top.phase = 'body'
        bindLoopVar(top.loop, st)
      } else if (t.k === 'w') {
        if (top.loop.varName === '') top.loop.varName = t.v === '((' ? '((' : t.v
        else if (t.v === 'in' && !top.inSeen) top.inSeen = true
        else if (top.inSeen) {
          top.loop.items.push(expand(t.v, st.vars))
          for (const s of t.subs) {
            const sub = parseScript(s, st, 'sub', wrap, depth + 1, loopsNow())
            if (sub.length) st.shape.subst = true
          }
        }
      }
      continue
    }
    if (t.k === 'op') {
      const v = t.v
      if (cur && cur.dbl && (v === '&&' || v === '||' || v === '(' || v === ')' || v === '|')) {
        cur.words.push({ k: 'w', v, raw: v, q: false, subs: [] })
        continue
      }
      if (v === '|' || v === '|&') {
        endCmd()
        pos++
        afterPipe = true
        if (v === '|&') st.shape.stderr = true
        continue
      }
      if (v === '\n' && !cur && (afterPipe || !pipeCmds.length)) continue
      if (v === '&&' || v === '||' || v === ';' || v === '\n' || v === '&') {
        endPipe(v === '\n' ? ';' : v)
        continue
      }
      if (v === ';;' || v === ';&' || v === ';;&') {
        endPipe(';')
        const k = innermost(f => f.kind === 'case')
        const f = frames[k]
        if (f) f.phase = 'pat'
        continue
      }
      if (v === '(') {
        const nx = toks[ti + 1]
        if (cur && cur.words.length === 1 && !cur.assigns.length && nx && nx.k === 'op' && nx.v === ')') {
          cur = null // name() { … }: a function definition
          ti++
          continue
        }
        endCmd()
        frames.push({ kind: 'sub', phase: 'body' })
        continue
      }
      if (v === ')') {
        endPipe(';')
        const k = innermost(f => f.kind === 'sub')
        if (k >= 0) frames.length = k
        closed = true
        continue
      }
      continue
    }
    if (t.k === 'r') {
      ;(cur ??= { words: [], assigns: [], redirs: [], dbl: false, groupOut: wasClosed }).redirs.push(t)
      if (t.doc) st.shape.heredoc = true
      continue
    }
    // a word
    if (!cur) {
      if (!t.q) {
        const kw = t.v
        if (kw === '!' ) {
          neg = true
          continue
        }
        if (kw === '{') {
          frames.push({ kind: 'group', phase: 'body', guard: (joiner === '&&' || joiner === '||') && lastPipe.length ? { cmds: lastPipe, ends: joiner === '&&' } : null })
          continue
        }
        if (kw === '}') {
          endPipe(';')
          const k = innermost(f => f.kind === 'group')
          if (k >= 0) frames.length = k
          closed = true
          continue
        }
        if (kw === 'for' || kw === 'select' || kw === 'while' || kw === 'until') {
          const L: Loop = { kind: kw, varName: '', items: [], cond: [], body: [], sleeps: [], guards: [], breaks: 0 }
          st.loops.push(L)
          frames.push({ kind: kw, phase: kw === 'for' || kw === 'select' ? 'head' : 'cond', loop: L, inSeen: false })
          continue
        }
        if (kw === 'do') {
          const k = innermost(f => f.loop !== undefined)
          const f = frames[k]
          if (f) f.phase = 'body'
          continue
        }
        if (kw === 'done') {
          const k = innermost(f => f.loop !== undefined)
          if (k >= 0) frames.length = k
          continue
        }
        if (kw === 'if') {
          frames.push({ kind: 'if', phase: 'cond', ifCond: [] })
          continue
        }
        if (kw === 'elif') {
          const f = frames[innermost(x => x.kind === 'if')]
          if (f) {
            f.phase = 'cond'
            f.ifCond = []
          }
          continue
        }
        if (kw === 'then' || kw === 'else') {
          const f = frames[innermost(x => x.kind === 'if')]
          if (f) f.phase = 'body'
          continue
        }
        if (kw === 'fi') {
          const k = innermost(f => f.kind === 'if')
          if (k >= 0) frames.length = k
          continue
        }
        if (kw === 'case') {
          frames.push({ kind: 'case', phase: 'word' })
          continue
        }
        if (kw === 'esac') {
          const k = innermost(f => f.kind === 'case')
          if (k >= 0) frames.length = k
          continue
        }
        if (kw === 'function') {
          ti++ // the name
          const a = toks[ti + 1]
          const b = toks[ti + 2]
          if (a && a.k === 'op' && a.v === '(' && b && b.k === 'op' && b.v === ')') ti += 2
          continue
        }
        if (kw === 'time' || kw === 'coproc') continue
      }
      cur = { words: [], assigns: [], redirs: [], dbl: !t.q && t.v === '[[' }
    }
    if (!cur.words.length && !cur.dbl && isAssignWord(t)) cur.assigns.push(t)
    else {
      cur.words.push(t)
      if (cur.dbl && !t.q && t.v === ']]' && cur.words.length > 1) cur.dbl = false // the test is closed: && and || separate again
    }
  }
  endPipe('')
  return made
}

function bindLoopVar(L: Loop, st: PState): void {
  if (L.varName === '' || L.varName === '((' || !L.items.length) return
  const literal = L.items.every(x => !/[$`]/.test(x))
  if (!literal) return
  st.vars.set(L.varName, L.items[0] ?? '')
  st.loopN.set(L.varName, L.items.length)
  st.loopItems.set(L.varName, L.items.slice(0, 50))
}

function buildCmd(c: Cur, st: PState, origin: Cmd['origin'], wrap: string[], loops: Loop[]): Cmd {
  const assigns: { name: string; value: string }[] = []
  for (const w of c.assigns) {
    const eq = w.v.indexOf('=')
    const name = w.v.slice(0, eq).replace(/\+$/, '').replace(/\[.*$/, '')
    assigns.push({ name, value: assignValue(w.v.slice(eq + 1), st.vars) })
  }
  let multi = 0
  let loopItems: string[] | undefined
  for (const w of c.words) {
    if (!w.v.includes('$')) continue
    for (const m of w.v.matchAll(VAR_RE)) {
      const name = m[1] ?? m[2] ?? ''
      const k = st.loopN.get(name) ?? 0
      if (k > multi) {
        multi = k
        loopItems = st.loopItems.get(name)
      }
    }
  }
  const pv = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(c.words[0]?.v ?? '')
  const progItems = pv && (st.loopN.get(pv[1] ?? '') ?? 0) > 1 ? st.loopItems.get(pv[1] ?? '') : undefined
  const argv = c.words.map(w => expand(w.v, st.vars))
  const quoted = c.words.map(w => w.q)
  for (const w of c.words) if (w.q && /'[^']*\$/.test(w.raw)) st.shape.quoting = true
  const redirs = c.redirs.map(r => ({ op: r.op, fd: r.fd, target: r.target ? expand(r.target.v, st.vars) : '' }))
  const d = c.redirs.find(r => r.doc !== null)?.doc ?? null
  const hs = c.redirs.find(r => r.op === '<<<')
  if (!argv.length) {
    for (const a of assigns) st.vars.set(a.name, a.value)
  }
  if (assigns.length) st.shape.envVar = true
  const p0 = argv[0] ?? ''
  if (p0 === 'export' || p0 === 'declare' || p0 === 'typeset' || p0 === 'local' || p0 === 'readonly') {
    st.shape.envVar = true
    for (const a of argv.slice(1)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(a)
      if (m) st.vars.set(m[1] ?? '', m[2] ?? '')
    }
  }
  for (const r of redirs) {
    if (r.op === '<<' || r.op === '<<-') continue
    if (r.fd === '2' || r.op.startsWith('&') || (r.op === '>&' && r.fd !== '' && r.fd !== '1')) st.shape.stderr = true
    else if (r.op === '<' || r.op === '<<<') st.shape.redirIn = true
    else if (r.op === '>&' && /^\d$/.test(r.target)) st.shape.stderr = true
    else st.shape.redirOut = true
  }
  const cmd: Cmd = {
    idx: st.cmds.length,
    argv,
    quoted,
    assigns,
    redirs,
    doc: d ? { body: d.body, quoted: d.quoted } : null,
    herestr: hs ? (hs.target ? expand(hs.target.v, st.vars) : '') : null,
    pipe: 0,
    pos: 0,
    len: 1,
    joiner: '',
    bg: false,
    neg: false,
    loops,
    condOf: null,
    origin,
    wrap,
    u: { prog: '', word: '', args: [], wrap: [], env: [] },
    inner: [],
    subs: [],
    multi,
    loopItems,
    progItems,
    groupOut: c.groupOut === true,
  }
  cmd.u = unwrap(argv, cmd)
  return cmd
}

// ===================================================================== unwrap

const SHELLS: ReadonlySet<string> = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'])

/** Skip leading options; returns the index of the first operand. */
function skipOpts(argv: readonly string[], k: number, shortArg: string, longArg: readonly string[]): number {
  while (k < argv.length) {
    const a = argv[k] ?? ''
    if (a === '--') return k + 1
    if (!a.startsWith('-') || a === '-') return k
    if (a.startsWith('--')) {
      const name = a.slice(2).split('=')[0] ?? ''
      k += !a.includes('=') && longArg.includes(name) ? 2 : 1
      continue
    }
    let takes = false
    for (let j = 1; j < a.length; j++) {
      if (shortArg.includes(a.charAt(j))) {
        takes = j === a.length - 1
        break
      }
    }
    k += takes ? 2 : 1
  }
  return k
}

function progName(w: string): string {
  let s = w.trim()
  if (s === '') return ''
  if (s.startsWith('$')) {
    const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?(.*)$/.exec(s)
    if (m) {
      const rest = m[2] ?? ''
      if (rest.includes('/')) s = rest
      else if (/py/i.test(m[1] ?? '')) return 'python3'
      else if (/node/i.test(m[1] ?? '')) return 'node'
      else return s
    }
  }
  let b = s.replace(/\/+$/, '')
  const slash = b.lastIndexOf('/')
  if (slash >= 0) b = b.slice(slash + 1)
  const m = /^(python|pip|pypy)(\d(?:\.\d+)*)?$/.exec(b)
  if (m) return (m[1] ?? '') + (m[2] ? m[2].charAt(0) : '')
  return b
}

function unwrap(argv: readonly string[], cmd: { doc: { body: string } | null }): Inv {
  const wrap: string[] = []
  const env: string[] = []
  let secs: number | undefined
  let k = 0
  for (let guard = 0; guard < 16 && k < argv.length; guard++) {
    const w = argv[k] ?? ''
    const b = progName(w)
    const next = argv[k + 1] ?? ''
    if (b === 'sudo' || b === 'doas') {
      wrap.push('sudo')
      k = skipOpts(argv, k + 1, 'ugCDhprtUT', ['user', 'group', 'chdir', 'prompt', 'role', 'type', 'host', 'other-user', 'close-from'])
      continue
    }
    if (b === 'env') {
      wrap.push('env')
      k++
      while (k < argv.length) {
        const a = argv[k] ?? ''
        if (a === '--') {
          k++
          break
        }
        if (a === '-u' || a === '-C' || a === '--unset' || a === '--chdir') {
          k += 2
          continue
        }
        if (a === '-S' || a === '--split-string') return { prog: 'env', word: w, args: [], wrap, env, inner: argv.slice(k + 1).join(' ') }
        if (a.startsWith('-')) {
          k++
          continue
        }
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(a)
        if (m) {
          env.push(m[1] ?? '')
          k++
          continue
        }
        break
      }
      if (k >= argv.length) return { prog: 'env', word: w, args: [], wrap: wrap.slice(0, -1), env }
      continue
    }
    if (b === 'timeout') {
      k++
      while (k < argv.length && (argv[k] ?? '').startsWith('-')) {
        const a = argv[k] ?? ''
        k += a === '-s' || a === '-k' || a === '--signal' || a === '--kill-after' ? 2 : 1
      }
      secs = parseDuration(argv[k] ?? '')
      wrap.push('timeout')
      k++
      continue
    }
    if (b === 'nohup' || b === 'setsid') {
      wrap.push(b)
      k++
      while (b === 'setsid' && (argv[k] ?? '').startsWith('-')) k++
      continue
    }
    if (b === 'nice') {
      k++
      const a = argv[k] ?? ''
      if (a === '-n' || a === '--adjustment') k += 2
      else if (/^(-n?-?\d+|--adjustment=.*)$/.test(a)) k++
      wrap.push('nice')
      continue
    }
    if (b === 'ionice' || b === 'chrt' || b === 'numactl' || b === 'cpulimit') {
      k = skipOpts(argv, k + 1, 'cnpPuNCml', ['class', 'classdata', 'pid', 'pgid', 'uid', 'cpunodebind', 'physcpubind', 'membind', 'limit'])
      if (b === 'chrt' && /^\d+$/.test(argv[k] ?? '')) k++
      continue
    }
    if (b === 'taskset') {
      k++
      if (argv[k] === '-c' || argv[k] === '--cpu-list') k += 2
      else {
        while ((argv[k] ?? '').startsWith('-')) k++
        k++
      }
      continue
    }
    if (b === 'time' || b === 'exec' || b === 'builtin' || b === 'unbuffer' || b === 'caffeinate' || b === 'chronic' || b === 'nocache' || b === 'stdbuf' || (b === 'command' && next !== '-v' && next !== '-V')) {
      k = b === 'time' ? skipOpts(argv, k + 1, 'fo', ['format', 'output']) : b === 'stdbuf' ? skipOpts(argv, k + 1, 'ioe', []) : skipOpts(argv, k + 1, '', [])
      continue
    }
    if (b === 'flock') {
      k = skipOpts(argv, k + 1, 'wEc', ['timeout', 'conflict-exit-code', 'command'])
      k++ // the lock file
      continue
    }
    if (b === 'xargs') {
      wrap.push('xargs')
      k = skipOpts(argv, k + 1, 'IdEsanPL', ['max-args', 'max-procs', 'delimiter', 'replace', 'arg-file', 'max-chars', 'max-lines', 'eof', 'process-slot-var'])
      if (k >= argv.length) return { prog: 'echo', word: 'echo', args: [], wrap, env, secs }
      continue
    }
    if (b === 'watch') {
      wrap.push('watch')
      const j = skipOpts(argv, k + 1, 'nq', ['interval', 'equexit'])
      const n = argv.slice(k + 1, j)
      const iv = n.findIndex(a => a === '-n' || a === '--interval')
      const ivv = iv >= 0 ? parseDuration(n[iv + 1] ?? '') : undefined
      const inline = n.map(a => /^-n(\d+(?:\.\d+)?)$/.exec(a)?.[1]).find(x => x !== undefined)
      return { prog: 'watch', word: w, args: argv.slice(j), wrap, env, secs: ivv ?? (inline !== undefined ? Number(inline) : 2), inner: argv.slice(j).join(' ') }
    }
    if (b === 'eval') return { prog: 'eval', word: w, args: argv.slice(k + 1), wrap, env, secs, inner: argv.slice(k + 1).join(' ') }
    if ((b === 'uv' || b === 'poetry' || b === 'pipenv' || b === 'pdm' || b === 'hatch' || b === 'rye' || b === 'pixi') && next === 'run') {
      wrap.push(b === 'uv' ? 'uv run' : `${b} run`)
      k = skipOpts(argv, k + 2, 'pe', ['with', 'python', 'project', 'directory', 'package', 'env-file', 'extra', 'group', 'index', 'with-requirements', 'with-editable', 'environment'])
      if (argv[k] === '-m' || argv[k] === '--module') return finishShell({ prog: 'python3', word: 'python3', args: argv.slice(k), wrap, env, secs }, cmd)
      if (/\.py$/.test(argv[k] ?? '')) return { prog: 'python3', word: 'python3', args: argv.slice(k), wrap, env, secs }
      continue
    }
    if (b === 'uvx' || b === 'pipx' && next === 'run' || (b === 'uv' && next === 'tool' && argv[k + 2] === 'run')) {
      wrap.push('uvx')
      k = skipOpts(argv, k + (b === 'uvx' ? 1 : b === 'pipx' ? 2 : 3), '', ['from', 'with', 'python'])
      continue
    }
    if ((b === 'conda' || b === 'mamba' || b === 'micromamba') && next === 'run') {
      wrap.push('conda run')
      k = skipOpts(argv, k + 2, 'np', ['name', 'prefix', 'cwd'])
      continue
    }
    if (b === 'npx' || b === 'bunx' || b === 'pnpx') {
      wrap.push('npx')
      k = skipOpts(argv, k + 1, 'pc', ['package', 'call'])
      continue
    }
    if ((b === 'pnpm' || b === 'yarn') && (next === 'exec' || next === 'dlx')) {
      wrap.push('npx')
      k += 2
      continue
    }
    if (b === 'bundle' && next === 'exec') {
      k += 2
      continue
    }
    break
  }
  const word = argv[k] ?? ''
  return finishShell({ prog: progName(word), word, args: argv.slice(k + 1), wrap, env, secs }, cmd)
}

function finishShell(u: Inv, cmd: { doc: { body: string } | null }): Inv {
  if (!SHELLS.has(u.prog)) return u
  for (let j = 0; j < u.args.length; j++) {
    const a = u.args[j] ?? ''
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(a)) return { ...u, inner: u.args[j + 1] ?? '' }
    if (!a.startsWith('-') && !a.startsWith('+')) return u
    if (a === '-o' || a === '+o' || a === '-O' || a === '+O') j++
  }
  if (cmd.doc) return { ...u, inner: cmd.doc.body }
  return u
}

// ===================================================================== roles

type X = {
  ranges?: { a: number; b?: number; toEnd?: boolean }[]
  n?: number
  from?: number
  bytes?: boolean
  secs?: number
  sub?: string
  sub2?: string
  url?: string
  local?: boolean
  method?: string
  status?: boolean
  download?: boolean
  db?: string
  sql?: string
  name?: string
  pkgs?: string[]
  pid?: string
  sig?: string
  msg?: string
  follow?: boolean
  fields?: string
  files?: string[]
  count?: boolean
  list?: boolean
  invert?: boolean
  quiet?: boolean
  glob?: string
  ere?: boolean
  recursive?: boolean
  q?: string
  qEre?: boolean
  loopN?: number
  loopItems?: string[]
  lines?: number
  verify?: string
  what?: string
  arg?: string
  input?: string
  append?: boolean
  bg?: boolean
  dir?: string
  type?: string
  manager?: string
  host?: string
  port?: string
  section?: string
  unit?: string
  mode?: string
  inline?: boolean
  help?: boolean
  version?: boolean
  via?: string
  then?: string
}

type Role = {
  cat: BashCategory
  w: number
  kind: string
  prog: string
  name?: string
  target?: string
  reads: string[]
  writes: string[]
  query?: string
  where?: string
  concepts: string[]
  /** cd, export, labels: never the intent */
  setup?: boolean
  /** only produces input for the next stage (echo, printf, cat <<EOF) */
  feeder?: boolean
  /** a stage that only trims or reshapes the output before it (head, grep, sort, wc …) */
  filter?: boolean
  /** set when it really is a pager tail of a pipeline */
  pager?: boolean
  /** set when it only prints a label */
  label?: boolean
  /** inside a polling loop that is already explained as one 'wait' */
  covered?: boolean
  x: X
  cmd: Cmd
}

const WEIGHT: Readonly<Record<BashCategory, number>> = {
  test: 100,
  build: 92,
  install: 90,
  claude: 88,
  docker: 80,
  database: 80,
  media: 78,
  http: 76,
  'run-script': 75,
  network: 74,
  git: 70,
  'write-file': 60,
  gpu: 58,
  wait: 55,
  process: 50,
  other: 15,
  'file-ops': 40,
  search: 32,
  'read-file': 28,
  'list-files': 22,
  env: 12,
}

type Opts = { f: Set<string>; v: Map<string, string[]>; pos: string[] }

/** A small getopt: combined short flags (-rn), attached values (-A3, --max-count=5) and `--`. */
function parseOpts(args: readonly string[], shortArg: string, longArg: readonly string[] = [], numFlag = false): Opts {
  const f = new Set<string>()
  const v = new Map<string, string[]>()
  const pos: string[] = []
  const put = (k: string, val: string): void => {
    f.add(k)
    const a = v.get(k)
    if (a) a.push(val)
    else v.set(k, [val])
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    if (a === '--') {
      pos.push(...args.slice(i + 1))
      break
    }
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=')
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2)
      if (eq > 0) put(name, a.slice(eq + 1))
      else if (longArg.includes(name) && i + 1 < args.length) put(name, args[++i] ?? '')
      else f.add(name)
      continue
    }
    if (a.startsWith('-') && a.length > 1 && !(numFlag && /^-\d+$/.test(a))) {
      for (let j = 1; j < a.length; j++) {
        const ch = a.charAt(j)
        if (shortArg.includes(ch)) {
          const rest = a.slice(j + 1)
          put(ch, rest !== '' ? rest : i + 1 < args.length ? args[++i] ?? '' : '')
          break
        }
        f.add(ch)
      }
      continue
    }
    if (numFlag && /^-\d+$/.test(a)) {
      put('#', a.slice(1))
      continue
    }
    pos.push(a)
  }
  return { f, v, pos }
}

const first = (o: Opts, ...keys: string[]): string | undefined => {
  for (const k of keys) {
    const a = o.v.get(k)
    if (a && a.length) return a[0]
  }
  return undefined
}

const isFileArg = (a: string): boolean => a !== '' && a !== '-' && !a.startsWith('-') && !/^\d+$/.test(a)

function mk(cmd: Cmd, cat: BashCategory, kind: string, o: Partial<Role> = {}): Role {
  return { cat, w: WEIGHT[cat], kind, prog: cmd.u.prog, reads: [], writes: [], concepts: [], x: {}, cmd, ...o }
}

const inputFile = (cmd: Cmd): string | undefined => cmd.redirs.find(r => r.op === '<' && r.target !== '' && !isDevNull(r.target))?.target

// ------------------------------------------------------------------- filters and readers

type FilterSpec = { arg: string; long?: string[]; firstIsProgram?: boolean; noFiles?: boolean; kind: string; concepts: string[] }

const FILTERS: Readonly<Record<string, FilterSpec>> = {
  sort: { arg: 'ktoST', long: ['key', 'field-separator', 'output', 'buffer-size', 'temporary-directory', 'parallel'], kind: 'sort', concepts: ['cut-sort-uniq'] },
  uniq: { arg: 'fsw', kind: 'uniq', concepts: ['cut-sort-uniq'] },
  cut: { arg: 'dfcb', long: ['delimiter', 'fields', 'characters', 'bytes', 'output-delimiter'], kind: 'cut', concepts: ['cut-sort-uniq'] },
  tr: { arg: '', noFiles: true, kind: 'tr', concepts: ['tr'] },
  paste: { arg: 'd', kind: 'paste', concepts: ['cut-sort-uniq'] },
  column: { arg: 'sotcN', kind: 'column', concepts: [] },
  nl: { arg: 'bsvwi', kind: 'nl', concepts: ['cat'] },
  tac: { arg: 's', kind: 'tac', concepts: ['cat'] },
  rev: { arg: '', kind: 'rev', concepts: [] },
  fold: { arg: 'w', kind: 'fold', concepts: [] },
  fmt: { arg: 'w', kind: 'fold', concepts: [] },
  expand: { arg: 't', kind: 'fold', concepts: [] },
  join: { arg: 'tj12o', kind: 'join', concepts: ['cut-sort-uniq'] },
  comm: { arg: '', kind: 'diff', concepts: ['diff'] },
  shuf: { arg: 'nio', kind: 'sort', concepts: ['cut-sort-uniq'] },
  numfmt: { arg: '', noFiles: true, kind: 'fold', concepts: [] },
  iconv: { arg: 'fto', kind: 'iconv', concepts: [] },
  xxd: { arg: 'lsgc', kind: 'hex', concepts: [] },
  od: { arg: 'tNjAw', kind: 'hex', concepts: [] },
  hexdump: { arg: 'nsef', kind: 'hex', concepts: [] },
  strings: { arg: 'n', kind: 'strings', concepts: [] },
  base64: { arg: 'w', kind: 'base64', concepts: [] },
  less: { arg: '', kind: 'cat', concepts: ['cat'] },
  more: { arg: '', kind: 'cat', concepts: ['cat'] },
  bat: { arg: 'lr', long: ['language', 'line-range', 'style', 'theme'], kind: 'cat', concepts: ['cat'] },
  batcat: { arg: 'lr', long: ['language', 'line-range', 'style', 'theme'], kind: 'cat', concepts: ['cat'] },
  zcat: { arg: '', kind: 'zcat', concepts: ['tar-zip'] },
  gzcat: { arg: '', kind: 'zcat', concepts: ['tar-zip'] },
  bzcat: { arg: '', kind: 'zcat', concepts: ['tar-zip'] },
  xzcat: { arg: '', kind: 'zcat', concepts: ['tar-zip'] },
  zstdcat: { arg: '', kind: 'zcat', concepts: ['tar-zip'] },
  zless: { arg: '', kind: 'zcat', concepts: ['tar-zip'] },
  md5sum: { arg: '', kind: 'checksum', concepts: [] },
  sha1sum: { arg: '', kind: 'checksum', concepts: [] },
  sha256sum: { arg: '', kind: 'checksum', concepts: [] },
  sha512sum: { arg: '', kind: 'checksum', concepts: [] },
  b2sum: { arg: '', kind: 'checksum', concepts: [] },
  cksum: { arg: '', kind: 'checksum', concepts: [] },
  jq: { arg: 'fL', long: ['indent', 'from-file'], firstIsProgram: true, kind: 'jq', concepts: ['jq', 'json'] },
  yq: { arg: 'oIp', long: ['output-format', 'input-format', 'indent'], firstIsProgram: true, kind: 'jq', concepts: ['yaml'] },
  csvlook: { arg: 'd', kind: 'column', concepts: ['csv'] },
  json_pp: { arg: '', kind: 'jq', concepts: ['json'] },
  ts: { arg: '', noFiles: true, kind: 'fold', concepts: [] },
  pv: { arg: 'sLN', kind: 'cat', concepts: [] },
  sponge: { arg: '', noFiles: true, kind: 'fold', concepts: [] },
  diff: { arg: 'UCIxX', long: ['unified', 'context', 'ignore-matching-lines', 'exclude', 'label', 'color'], kind: 'diff', concepts: ['diff'] },
  colordiff: { arg: 'UC', kind: 'diff', concepts: ['diff'] },
  cmp: { arg: 'in', kind: 'diff', concepts: ['diff'] },
}

/** Programs that can sit after a | without changing what the pipeline is for. */
const PAGER_PROGS: ReadonlySet<string> = new Set([
  'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'sort', 'uniq', 'wc', 'cut', 'tr', 'awk', 'gawk', 'mawk', 'sed', 'column', 'less', 'more',
  'cat', 'nl', 'fold', 'fmt', 'paste', 'tac', 'rev', 'jq', 'yq', 'xxd', 'od', 'base64', 'iconv', 'strings', 'expand', 'numfmt', 'ts', 'pv',
  'json_pp', 'bat', 'batcat', 'shuf', 'join', 'comm', 'cmp', 'md5sum', 'sha256sum', 'sha1sum', 'csvlook',
])

function filterRole(cmd: Cmd, spec: FilterSpec): Role {
  const u = cmd.u
  let args = u.args
  if (u.prog === 'jq') {
    const a: string[] = []
    for (let i = 0; i < args.length; i++) {
      const x = args[i] ?? ''
      if (x === '--arg' || x === '--argjson' || x === '--slurpfile' || x === '--rawfile') i += 2
      else a.push(x)
    }
    args = a
  }
  const o = parseOpts(args, spec.arg, spec.long ?? [])
  let pos = o.pos
  let program: string | undefined
  if (spec.firstIsProgram && !o.f.has('f') && !o.f.has('from-file')) {
    program = pos[0]
    pos = pos.slice(1)
  }
  const files = spec.noFiles ? [] : pos.filter(isFileArg)
  const inF = inputFile(cmd)
  if (inF) files.push(inF)
  const decode = (u.prog === 'base64' && (o.f.has('d') || o.f.has('decode'))) || false
  if (!files.length) return mk(cmd, 'read-file', spec.kind, { filter: true, concepts: spec.concepts.slice(), query: program, x: { arg: program, sub: decode ? 'decode' : undefined } })
  return mk(cmd, 'read-file', spec.kind, {
    reads: files,
    target: files[0],
    concepts: spec.concepts.slice(),
    query: program,
    x: { files, arg: program, count: o.f.has('c'), sub: decode ? 'decode' : o.f.has('c') && spec.kind === 'checksum' ? 'check' : undefined },
  })
}

function headTailRole(cmd: Cmd): Role {
  const u = cmd.u
  const o = parseOpts(u.args, 'ncs', ['lines', 'bytes', 'sleep-interval', 'pid', 'max-unchanged-stats'], true)
  const raw = first(o, '#', 'n', 'lines', 'c', 'bytes')
  const bytes = o.f.has('c') || o.f.has('bytes')
  let n: number | undefined
  let from: number | undefined
  if (raw !== undefined) {
    const m = /^([+-]?)(\d+)/.exec(raw)
    if (m) {
      if (m[1] === '+' && u.prog === 'tail') from = Number(m[2])
      else n = Number(m[2])
    }
  }
  const follow = o.f.has('f') || o.f.has('F') || o.f.has('follow')
  const files = o.pos.filter(isFileArg)
  const inF = inputFile(cmd)
  if (inF) files.push(inF)
  const kind = follow ? 'tail-follow' : u.prog
  if (!files.length) return mk(cmd, 'read-file', kind, { filter: true, concepts: ['head-tail'], x: { n, from, bytes, follow } })
  return mk(cmd, 'read-file', kind, { reads: files, target: files[0], concepts: ['head-tail'], x: { n, from, bytes, follow, files } })
}

function parseSedRanges(script: string): { a: number; b?: number; toEnd?: boolean }[] | undefined {
  const parts = script.split(/[;\n]/).map(s => s.trim()).filter(s => s !== '' && !/^\d*q$/.test(s))
  if (!parts.length) return undefined
  const out: { a: number; b?: number; toEnd?: boolean }[] = []
  for (const p of parts) {
    const m = /^(\d+)\s*(?:,\s*(\d+|\$|\+\d+))?\s*p$/.exec(p)
    if (!m) return undefined
    const a = Number(m[1])
    const e = m[2]
    if (e === undefined) out.push({ a })
    else if (e === '$') out.push({ a, toEnd: true })
    else if (e.startsWith('+')) out.push({ a, b: a + Number(e.slice(1)) })
    else out.push({ a, b: Number(e) })
  }
  return out
}

function sedRole(cmd: Cmd): Role {
  const u = cmd.u
  const args = u.args.map(a => (/^-[a-zA-Z]*i/.test(a) && !a.startsWith('--') ? a.replace(/i.*$/, 'i') : a))
  const o = parseOpts(args, 'efl', ['expression', 'file', 'line-length'])
  const scripts = o.v.get('e') ?? o.v.get('expression') ?? []
  let pos = o.pos
  if (!scripts.length && !o.f.has('f') && !o.f.has('file')) {
    if (pos[0] !== undefined) scripts.push(pos[0])
    pos = pos.slice(1)
  }
  const script = scripts.join(';')
  const inplace = o.f.has('i') || o.f.has('in-place') || u.args.some(a => /^--in-place/.test(a))
  const quiet = o.f.has('n') || o.f.has('quiet') || o.f.has('silent')
  const files = pos.filter(isFileArg)
  const inF = inputFile(cmd)
  const subst = /(^|[;{}\s\d$/])s([^\w\s\\]).*\2.*\2/.test(script) || /^s(.).*\1.*\1/.test(script)
  const rx = (subst ? /s(.)((?:\\.|(?!\1).)*)\1/.exec(script)?.[2] : /\/((?:\\.|[^/])+)\//.exec(script)?.[1]) ?? ''
  const concepts = [subst ? 'sed-substitute' : 'sed-print']
  if (hasRegex(rx, false)) concepts.push('regex')
  if (inplace) return mk(cmd, 'write-file', 'sed-i', { writes: files, reads: files, target: files[0], concepts, x: { files } })
  if (!files.length && !inF) return mk(cmd, 'read-file', 'sed', { filter: true, concepts })
  const all = inF ? files.concat(inF) : files
  if (quiet) {
    const ranges = parseSedRanges(script)
    if (ranges) return mk(cmd, 'read-file', 'range', { reads: all, target: all[0], concepts: ['sed-print'], x: { ranges, files: all } })
    const pat = /^\/((?:\\.|[^/])+)\/\s*,?\s*(?:\/((?:\\.|[^/])+)\/)?\s*p$/.exec(script.trim())
    if (pat) return mk(cmd, 'read-file', 'section', { reads: all, target: all[0], concepts: ['sed-print', ...(hasRegex(pat[1] ?? '', false) ? ['regex'] : [])], x: { files: all, section: pat[1] } })
    return mk(cmd, 'read-file', 'part', { reads: all, target: all[0], concepts: ['sed-print'], x: { files: all } })
  }
  return mk(cmd, 'read-file', 'sed', { reads: all, target: all[0], concepts, x: { files: all } })
}

function awkRole(cmd: Cmd): Role {
  const u = cmd.u
  const o = parseOpts(u.args, 'Ffv', ['field-separator', 'file', 'assign'])
  let pos = o.pos
  let prog = ''
  if (!o.f.has('f') && !o.f.has('file')) {
    prog = pos[0] ?? ''
    pos = pos.slice(1)
  }
  const files = pos.filter(a => isFileArg(a) && !/^[A-Za-z_]\w*=/.test(a))
  const inF = inputFile(cmd)
  if (inF) files.push(inF)
  if (!files.length) return mk(cmd, 'read-file', 'awk', { filter: true, concepts: ['awk'] })
  const ranges: { a: number; b?: number }[] = []
  for (const m of prog.matchAll(/NR\s*(>=?)\s*(\d+)\s*&&\s*NR\s*(<=?)\s*(\d+)/g)) {
    ranges.push({ a: Number(m[2]) + (m[1] === '>' ? 1 : 0), b: Number(m[4]) - (m[3] === '<' ? 1 : 0) })
  }
  if (!ranges.length) {
    const m = /NR\s*==\s*(\d+)\s*,\s*NR\s*==\s*(\d+)/.exec(prog)
    if (m) ranges.push({ a: Number(m[1]), b: Number(m[2]) })
    else {
      const one = /^\s*NR\s*==\s*(\d+)\s*(\{|$)/.exec(prog)
      if (one) ranges.push({ a: Number(one[1]) })
    }
  }
  if (ranges.length) return mk(cmd, 'read-file', 'range', { reads: files, target: files[0], concepts: ['awk'], x: { ranges, files } })
  const sec = /^\s*\/((?:\\.|[^/])+)\/\s*,\s*\/((?:\\.|[^/])+)\/\s*$/.exec(prog)
  if (sec) return mk(cmd, 'read-file', 'section', { reads: files, target: files[0], concepts: ['awk'], x: { files, section: sec[1] } })
  return mk(cmd, 'read-file', 'awk', { reads: files, target: files[0], concepts: ['awk'], x: { files } })
}

function wcRole(cmd: Cmd): Role {
  const o = parseOpts(cmd.u.args, '', ['files0-from'])
  const files = o.pos.filter(isFileArg)
  const inF = inputFile(cmd)
  if (inF) files.push(inF)
  const unit = o.f.has('l') || o.f.has('lines') ? 'l' : o.f.has('w') || o.f.has('words') ? 'w' : o.f.has('c') || o.f.has('bytes') ? 'c' : o.f.has('m') || o.f.has('chars') ? 'm' : ''
  const name = unit ? `wc -${unit}` : 'wc'
  if (!files.length) return mk(cmd, 'read-file', 'wc', { filter: true, name, concepts: ['wc'], x: { sub: unit } })
  return mk(cmd, 'read-file', 'wc', { name, reads: files, target: files[0], concepts: ['wc'], x: { files, sub: unit } })
}

function catRole(cmd: Cmd): Role {
  const o = parseOpts(cmd.u.args, '', [])
  const files = o.pos.filter(isFileArg)
  const inF = inputFile(cmd)
  if (inF) files.push(inF)
  if (!files.length) {
    if (cmd.doc || cmd.herestr !== null) return mk(cmd, 'other', 'print', { feeder: true, concepts: cmd.doc ? ['heredoc'] : [] })
    return mk(cmd, 'read-file', 'cat', { filter: true, feeder: cmd.pos === 0, concepts: ['cat'] })
  }
  return mk(cmd, 'read-file', 'cat', { reads: files, target: files[0], concepts: ['cat'], x: { files } })
}

// ------------------------------------------------------------------- search

const GREP_ARG = 'efmABCdD'
const GREP_LONG = ['regexp', 'file', 'max-count', 'after-context', 'before-context', 'context', 'include', 'exclude', 'exclude-dir', 'exclude-from', 'label', 'binary-files', 'devices', 'directories', 'group-separator']
const RG_ARG = 'efgtTmABCMjErd'
const RG_LONG = ['regexp', 'file', 'glob', 'iglob', 'type', 'type-not', 'max-count', 'after-context', 'before-context', 'context', 'max-columns', 'threads', 'encoding', 'replace', 'max-depth', 'max-filesize', 'type-add', 'sort', 'sortr', 'pre', 'pre-glob', 'path-separator', 'engine', 'colors', 'context-separator', 'ignore-file']

function grepRole(cmd: Cmd, args: readonly string[], prog: string): Role {
  const rg = prog === 'rg' || prog === 'ag' || prog === 'ack' || prog === 'git grep'
  const o = parseOpts(args, rg ? RG_ARG : GREP_ARG, rg ? RG_LONG : GREP_LONG)
  if (rg && o.f.has('files')) {
    const dirs = o.pos.filter(isFileArg)
    return mk(cmd, 'list-files', 'rg-files', { name: 'rg --files', target: dirs[0] ?? '.', concepts: ['ripgrep'], x: { files: dirs.length ? dirs : ['.'] } })
  }
  const pats = o.v.get('e') ?? o.v.get('regexp') ?? []
  const pos = o.pos.slice()
  const pattern = pats.length ? pats.join('|') : pos.shift() ?? ''
  const paths = pos.filter(a => a !== '' && a !== '-')
  const inF = inputFile(cmd)
  if (inF) paths.push(inF)
  const recursive = rg || o.f.has('r') || o.f.has('R') || o.f.has('recursive') || o.f.has('dereference-recursive')
  const fixed = o.f.has('F') || o.f.has('fixed-strings') || prog === 'fgrep'
  const ere = rg || o.f.has('E') || o.f.has('P') || o.f.has('extended-regexp') || o.f.has('perl-regexp') || prog === 'egrep'
  const invert = o.f.has('v') || o.f.has('invert-match')
  const count = o.f.has('c') || o.f.has('count')
  const list = o.f.has('l') || o.f.has('files-with-matches') || o.f.has('L')
  const quiet = o.f.has('q') || o.f.has('quiet') || o.f.has('silent')
  const glob = first(o, 'include', 'g', 'glob', 'iglob') ?? (first(o, 't', 'type') !== undefined ? `*.${first(o, 't', 'type')}` : undefined)
  const concepts = [prog === 'rg' ? 'ripgrep' : 'grep']
  if (hasRegex(pattern, fixed)) concepts.push('regex')
  const name = prog === 'git grep' ? 'git grep' : prog
  const x: X = { invert, count, list, quiet, glob, ere, recursive, files: paths }
  if (!paths.length && !recursive) {
    return mk(cmd, 'search', 'grep', { name, filter: true, query: pattern, target: pattern, concepts, x })
  }
  const where = paths.length ? paths.join(' ') : '.'
  return mk(cmd, 'search', 'grep', { name, query: pattern, where, target: pattern, reads: paths.filter(p => !looksDir(p)), concepts, x })
}

function findRole(cmd: Cmd): Role {
  const args = cmd.u.args
  let k = 0
  const paths: string[] = []
  while (k < args.length && !/^[-(!]/.test(args[k] ?? '') && args[k] !== '\\(') paths.push(args[k++] ?? '')
  const names: string[] = []
  let type: string | undefined
  let del = false
  let exec: string[] | null = null
  for (; k < args.length; k++) {
    const a = args[k] ?? ''
    const prev = args[k - 1] ?? ''
    if (/^-(i?name|i?path|i?wholename|i?regex|lname)$/.test(a)) {
      const v = args[++k] ?? ''
      if (prev !== '-not' && prev !== '!' && !(args[k + 1] === '-prune')) names.push(v) // -not -path X and -path X -prune exclude
    }
    else if (a === '-type') type = args[++k]
    else if (a === '-delete') del = true
    else if (a === '-exec' || a === '-execdir' || a === '-ok' || a === '-okdir') {
      const e: string[] = []
      for (k++; k < args.length && args[k] !== ';' && args[k] !== '+'; k++) e.push(args[k] ?? '')
      if (!exec) exec = e
    } else if (/^-(maxdepth|mindepth|newer|mtime|mmin|atime|amin|ctime|cmin|size|user|group|perm|printf|fprint|fprintf|samefile|links|inum|uid|gid|used|fstype|context)$/.test(a)) k++
  }
  const where = paths.length ? paths : ['.']
  const glob = names.find(n => n !== '')
  const base = ['find']
  if (glob && /[*?[]/.test(glob)) base.push('globbing')
  const x: X = { files: where, type, glob }
  if (del || (exec && /^(rm|unlink|shred)$/.test(progName(exec[0] ?? '')))) {
    return mk(cmd, 'file-ops', 'find-delete', { target: glob ?? where[0], where: where.join(' '), concepts: base.concat('cp-mv-rm'), x })
  }
  if (exec) {
    const ep = progName(exec[0] ?? '')
    if (/^(grep|egrep|fgrep|rg|zgrep)$/.test(ep)) {
      const g = grepRole(cmd, exec.slice(1).filter(e => e !== '{}'), ep)
      return mk(cmd, 'search', 'find-grep', { query: g.query, target: g.query, where: where.join(' '), concepts: g.concepts.concat(base), x: { ...x, ere: g.x.ere, list: g.x.list } })
    }
    if (/^(sed|perl)$/.test(ep) && exec.some(e => /^-[a-zA-Z]*i/.test(e))) return mk(cmd, 'write-file', 'find-edit', { target: glob ?? where[0], concepts: base.concat('sed-substitute'), x: { ...x, sub: ep } })
    if (/^(chmod|chown|chgrp|mv|cp|ln|touch|gzip|tar)$/.test(ep)) return mk(cmd, 'file-ops', 'find-exec', { target: glob ?? where[0], concepts: base, x: { ...x, sub: ep } })
  }
  if (names.length) return mk(cmd, 'search', 'find-name', { query: names.filter(n => n !== '').join(' or '), target: glob, where: where.join(' '), concepts: base, x })
  return mk(cmd, 'list-files', 'find-list', { target: where[0], concepts: base, x })
}

function lsRole(cmd: Cmd): Role {
  const o = parseOpts(cmd.u.args, 'IwT', ['ignore', 'hide', 'width', 'tabsize', 'color', 'sort', 'time-style', 'format', 'block-size', 'indicator-style', 'quoting-style', 'time'])
  const targets = o.pos.filter(a => a !== '')
  const recursive = o.f.has('R') || o.f.has('recursive')
  return mk(cmd, 'list-files', 'ls', { target: targets[0] ?? '.', concepts: ['ls'], x: { files: targets.length ? targets : ['.'], recursive } })
}

// ------------------------------------------------------------------- python, node, scripts

const PY_FILE_RE = /(?:open|load|loads|read_csv|read_json|read_parquet|read_table|read_excel|read_text|read_bytes|Path|connect|np\.load|torch\.load|sf\.read|safe_open|load_file|glob|json\.load\(open)\(\s*(?:f?r?)['"]([^'"\n]{2,160})['"]/

const PY_PATH_ASSIGN = /\b[A-Za-z_]\w*\s*=\s*(?:Path\(\s*)?(?:f?r?)['"]([^'"\n]*\/[^'"\n]*\.[A-Za-z0-9]{1,8})['"]/
const PY_WRITES = /\.write_text\(|\.write_bytes\(|open\([^)\n]*,\s*['"](?:w|a|wb|ab|w\+|r\+)['"]|\bjson\.dump\(|\.to_csv\(|\.to_json\(|\bshutil\.(?:copy\w*|move)\(|\bos\.replace\(|\bsf\.write\(|\btorch\.save\(|\bnp\.save\(/
const PY_OPEN_W = /open\(\s*(?:f?r?)['"]([^'"\n]{2,160})['"]\s*,\s*['"](?:w|a|wb|ab|w\+)['"]/

function pyFileIn(code: string): string | undefined {
  const m = PY_FILE_RE.exec(code) ?? PY_PATH_ASSIGN.exec(code)
  return m?.[1]?.replace(/^file:/, '').replace(/\?[\w&=.-]*=[\w&=.-]*$/, '')
}

const PY_SERVERS: ReadonlySet<string> = new Set(['uvicorn', 'gunicorn', 'flask', 'streamlit', 'gradio', 'jupyter', 'tensorboard', 'vllm', 'llama-server', 'ollama', 'text-generation-launcher', 'hypercorn', 'daphne', 'mlflow', 'http-server', 'serve', 'live-server'])

function pythonRole(cmd: Cmd): Role {
  const u = cmd.u
  const a = u.args
  let k = 0
  for (; k < a.length; k++) {
    const x = a[k] ?? ''
    if (x === '-c' || x === '-m' || x === '-') break
    if (x === '-X' || x === '-W' || x === '--check-hash-based-pycs') {
      k++
      continue
    }
    if (/^-[A-Za-z]+$/.test(x) && x.endsWith('c') && x.length > 2) break
    if (!x.startsWith('-')) break
  }
  const x = a[k] ?? ''
  const viaVenv = /(^|\/)(\.?venv|env|virtualenv)\/bin\//.test(u.word) || /\.venv\b/.test(u.word)
  const viaConda = /\/(envs|miniconda\d?|anaconda\d?|miniforge\d?|mambaforge)\//.test(u.word)
  const envConcepts = viaVenv ? ['python-venv'] : viaConda ? ['conda'] : []
  const p = u.prog
  if (x === '-m') {
    const mod = a[k + 1] ?? ''
    const rest = a.slice(k + 2)
    return moduleRole(cmd, mod, rest, envConcepts)
  }
  if (x === '-c' || (/^-[A-Za-z]+c$/.test(x) && x.length > 2)) {
    const code = a[k + 1] ?? ''
    return inlinePython(cmd, code, envConcepts)
  }
  if (x === '-' || (x === '' && (cmd.doc || cmd.herestr !== null || cmd.pos > 0))) {
    const code = cmd.doc?.body ?? cmd.herestr ?? ''
    return inlinePython(cmd, code, envConcepts.concat(cmd.doc ? ['heredoc'] : []))
  }
  if (x === '') {
    if (u.args.some(v => v === '--version' || v === '-V')) return versionRole(cmd, 'Python')
    return mk(cmd, 'run-script', 'py-repl', { name: p, concepts: ['python-script', ...envConcepts] })
  }
  const script = x
  const rest = a.slice(k + 1)
  return scriptRole(cmd, script, rest, 'Python', `${p} ${baseName(script)}`, ['python-script', ...envConcepts])
}

/** Modules a snippet only imports and reports on (versions, paths, CUDA): `import torch; print(torch.__version__)`. */
function importCheck(code: string): { mods: string[]; version: boolean; cuda: boolean } | undefined {
  const stmts = code.split(/[;\n]/).map(x => x.trim()).filter(x => x !== '' && !x.startsWith('#'))
  if (!stmts.length || stmts.length > 14) return undefined
  const mods: string[] = []
  let version = false
  let cuda = false
  for (const st of stmts) {
    const im = /^import\s+(.+)$/.exec(st)
    if (im) {
      for (const part of (im[1] ?? '').split(',')) mods.push((part.trim().split(/\s+/)[0] ?? '').split('.')[0] ?? '')
      continue
    }
    const fm = /^from\s+([\w.]+)\s+import\s+[\w., *]+$/.exec(st)
    if (fm) {
      mods.push((fm[1] ?? '').split('.')[0] ?? '')
      continue
    }
    if (/^print\s*\(/.test(st)) {
      if (/__version__|\bversion\b|__file__/.test(st)) version = true
      if (/cuda\.(is_available|device_count|get_device_name)|torch\.version\.cuda/.test(st)) cuda = true
      if (/__version__|\bversion\b|__file__|cuda\.|['"]\s*\)$|^print\s*\(\s*['"]/.test(st)) continue
    }
    return undefined
  }
  const m = uniq(mods.filter(x => x !== ''))
  return m.length ? { mods: m, version, cuda } : undefined
}

function inlinePython(cmd: Cmd, code: string, envConcepts: string[]): Role {
  const chk = importCheck(code)
  if (chk) {
    const name = listOf(chk.mods, 3)
    if (chk.cuda) return mk(cmd, 'env', 'py-version', { name: 'python3 -c', target: chk.mods[0], concepts: ['cuda', 'python-inline', ...envConcepts], x: { name, sub: 'cuda' } })
    if (chk.version) return mk(cmd, 'env', 'py-version', { name: 'python3 -c', target: chk.mods[0], concepts: ['python-imports', 'python-inline', ...envConcepts], x: { name, sub: /__file__/.test(code) && !/__version__/.test(code) ? 'file' : 'version' } })
    return mk(cmd, 'env', 'py-import', { name: 'python3 -c', target: chk.mods[0], concepts: ['python-imports', 'python-inline', ...envConcepts], x: { name } })
  }
  const file = pyFileIn(code)
  const concepts = ['python-inline', ...envConcepts]
  if (/\bimport\s+sqlite3\b|sqlite3\.connect/.test(code)) concepts.push('sqlite')
  if (/\bjson\.loads?\(|import json\b/.test(code)) concepts.push('json')
  const name = `${cmd.u.prog} ${cmd.doc || cmd.herestr !== null ? '-' : '-c'}`
  if (PY_WRITES.test(code)) {
    const out = PY_OPEN_W.exec(code)?.[1] ?? file
    if (out) {
      const patch = out === file && /read_text\(|\.read\(\)|open\(\s*\w+\s*\)\.read/.test(code)
      return mk(cmd, 'run-script', 'py-edit', { name, target: out, reads: file && file !== out ? [file] : [], writes: [out], concepts, x: { inline: true, input: file, sub: patch ? 'patch' : 'write' } })
    }
  }
  return mk(cmd, 'run-script', 'py-inline', { name, target: file, reads: file ? [file] : [], concepts, x: { inline: true, input: file } })
}

function moduleRole(cmd: Cmd, mod: string, rest: readonly string[], envConcepts: string[]): Role {
  const p = cmd.u.prog
  const name = `${p} -m ${mod}`
  const sub = { ...cmd, u: { ...cmd.u, prog: mod, args: rest.slice() } }
  switch (mod) {
    case 'pytest':
    case 'py.test':
      return { ...testRunner(sub, 'pytest', rest), name, cmd }
    case 'unittest':
      return mk(cmd, 'test', 'test', { name, concepts: ['tests', 'verify-after-change', ...envConcepts], x: { what: 'unittest' } })
    case 'pip':
      return { ...pipRole(sub, rest), name: `${p} -m pip ${rest[0] ?? ''}`.trim(), cmd }
    case 'venv':
    case 'virtualenv': {
      const dir = rest.find(r => !r.startsWith('-')) ?? '.venv'
      return mk(cmd, 'install', 'venv', { name, target: dir, writes: [dir], concepts: ['python-venv'], x: { dir } })
    }
    case 'json.tool': {
      const f = rest.find(isFileArg) ?? inputFile(cmd)
      return mk(cmd, 'read-file', 'jq', { name, filter: !f, target: f, reads: f ? [f] : [], concepts: ['json'] })
    }
    case 'http.server':
      return mk(cmd, 'run-script', 'server', { name, concepts: ['localhost', 'python-module-run'], x: { what: 'a simple web server', port: rest.find(r => /^\d+$/.test(r)) } })
    case 'py_compile':
    case 'compileall':
      return mk(cmd, 'build', 'compile', { name, target: rest.find(isFileArg), concepts: ['python-module-run'] })
    case 'build':
      return mk(cmd, 'build', 'build', { name, concepts: ['python-module-run'], x: { what: 'the Python package' } })
    case 'mypy':
    case 'pyright':
      return mk(cmd, 'build', 'typecheck', { name, concepts: ['type-checking'], x: { what: mod } })
    case 'black':
    case 'ruff':
    case 'flake8':
    case 'pylint':
    case 'isort':
      return mk(cmd, 'build', 'lint', { name, concepts: ['linting'], x: { what: mod } })
    case 'uvicorn':
    case 'gunicorn':
    case 'flask':
    case 'streamlit':
    case 'vllm.entrypoints.openai.api_server':
      return mk(cmd, 'run-script', 'server', { name, concepts: ['python-module-run', 'localhost'], x: { what: mod.startsWith('vllm') ? 'the vLLM' : mod } })
    case 'ensurepip':
      return mk(cmd, 'install', 'pip', { name, concepts: ['pip'] })
    case 'site':
    case 'sysconfig':
    case 'platform':
      return mk(cmd, 'env', 'py-env', { name, concepts: ['python-module-run'] })
    case 'huggingface_hub':
    case 'huggingface_hub.commands.huggingface_cli':
      return mk(cmd, 'install', 'hf-download', { name, concepts: ['huggingface'], x: { what: rest.find(r => /\//.test(r)) } })
    default: {
      const sc = scriptConcepts(mod + ' ' + rest.join(' '))
      return mk(cmd, 'run-script', 'py-module', { name, target: mod, concepts: ['python-module-run', ...envConcepts, ...sc], x: { what: mod, bg: false } })
    }
  }
}

/** ML hints from a script's name and arguments. */
function scriptConcepts(s: string): string[] {
  const out: string[] = []
  if (/train|finetune|fine_tune|fine-tune/i.test(s)) out.push('training-loop')
  if (/lora/i.test(s)) out.push('lora')
  if (/infer|predict|generate|inference/i.test(s)) out.push('inference')
  if (/checkpoint|\.safetensors|\.ckpt\b|\.pth?\b/i.test(s)) out.push('model-checkpoints')
  return out
}

/** A word that reads like a subcommand (start, sync-once, freeze), not a data name (sales_2024). */
const SUBCOMMAND = /^[a-z][a-z0-9-]{1,18}$/

function scriptRole(cmd: Cmd, script: string, rest: readonly string[], lang: string, name: string, concepts: string[]): Role {
  const sub = rest[0] !== undefined && SUBCOMMAND.test(rest[0]) ? rest[0] : undefined
  const help = rest.length === 1 && /^(-h|--help|help)$/.test(rest[0] ?? '')
  const all = concepts.concat(scriptConcepts(baseName(script) + ' ' + rest.slice(0, 12).join(' ')))
  if (sub === 'test' || sub === 'tests') return mk(cmd, 'test', 'test', { name: `${name} ${sub}`, target: script, concepts: ['tests', 'verify-after-change', ...all], x: { what: name + ' ' + sub } })
  if (sub === 'build') return mk(cmd, 'build', 'build', { name: `${name} ${sub}`, target: script, concepts: all, x: { what: `${baseName(script)} build` } })
  if (sub === 'install' || sub === 'setup') return mk(cmd, 'install', 'install-misc', { name: `${name} ${sub}`, target: script, concepts: all, x: { what: `${baseName(script)} ${sub}` } })
  return mk(cmd, 'run-script', 'script', { name, target: script, reads: [], concepts: all, x: { what: lang, sub, help } })
}

function nodeRole(cmd: Cmd): Role {
  const a = cmd.u.args
  const p = cmd.u.prog
  let k = 0
  for (; k < a.length; k++) {
    const x = a[k] ?? ''
    if (x === '-r' || x === '--require' || x === '--import' || x === '--loader' || x === '--experimental-loader' || x === '--env-file') {
      k++
      continue
    }
    if (!x.startsWith('-') || x === '-e' || x === '--eval' || x === '-p' || x === '--print' || x === '--test' || x === '--check' || x === '-c' || x === '-') break
  }
  const x = a[k] ?? ''
  if (x === '--test') {
    const files = a.slice(k + 1).filter(isFileArg)
    return mk(cmd, 'test', 'test', { name: 'node --test', target: files[0], concepts: ['tests', 'node-script', 'verify-after-change'], x: { what: 'node --test', files } })
  }
  if (x === '--check' || x === '-c') return mk(cmd, 'build', 'syntax', { name: 'node --check', target: a[k + 1], concepts: ['node-script'] })
  if (x === '-e' || x === '--eval' || x === '-p' || x === '--print' || x === '-' || (x === '' && (cmd.doc || cmd.pos > 0))) {
    return mk(cmd, 'run-script', 'js-inline', { name: `${p} ${x === '' ? '-' : x}`, concepts: ['node-script'], x: { inline: true } })
  }
  if (x === '') {
    if (a.some(v => v === '--version' || v === '-v')) return versionRole(cmd, 'Node.js')
    return mk(cmd, 'run-script', 'js-repl', { name: p, concepts: ['node-script'] })
  }
  const lang = /\.tsx?$/.test(x) ? 'TypeScript' : 'Node.js'
  return scriptRole(cmd, x, a.slice(k + 1), lang, `${p} ${baseName(x)}`, ['node-script', ...(lang === 'TypeScript' ? ['typescript'] : [])])
}

function shellScriptRole(cmd: Cmd): Role {
  const a = cmd.u.args
  const k = skipOpts(a, 0, 'oO', [])
  const x = a[k] ?? ''
  if (a.includes('-n') && x !== '') return mk(cmd, 'build', 'syntax', { name: `${cmd.u.prog} -n`, target: x, concepts: ['shell-basics'] })
  if (x === '') return mk(cmd, 'run-script', 'sh-inline', { name: cmd.u.prog, concepts: ['shell-basics'], x: { inline: true } })
  return scriptRole(cmd, x, a.slice(k + 1), 'shell', `${cmd.u.prog} ${baseName(x)}`, ['shell-basics'])
}

function versionRole(cmd: Cmd, what: string): Role {
  return mk(cmd, 'env', 'version', { name: `${cmd.u.prog} --version`, target: cmd.u.prog, concepts: [], x: { what } })
}

// ------------------------------------------------------------------- tests, builds, installs

function testRunner(cmd: Cmd, runner: string, args: readonly string[]): Role {
  const o = parseOpts(args, 'kmcnpo', ['maxfail', 'tb', 'rootdir', 'cov', 'ignore', 'deselect', 'durations', 'junitxml', 'log-level', 'timeout', 'testNamePattern', 'config', 'reporter', 'grep', 'run', 'project', 'workers'])
  const target = o.pos.find(isFileArg)
  const k = first(o, 'k', 't', 'testNamePattern', 'grep', 'run')
  const concepts = runner === 'pytest' ? ['pytest', 'tests', 'verify-after-change'] : ['tests', 'verify-after-change']
  return mk(cmd, 'test', 'test', { name: runner, target, concepts, query: k, x: { what: runner, files: o.pos.filter(isFileArg) } })
}

const SYS_PM: ReadonlySet<string> = new Set(['apt', 'apt-get', 'dnf', 'yum', 'zypper', 'apk', 'pacman', 'brew', 'port', 'snap', 'choco', 'winget', 'scoop'])

function pkgArgs(args: readonly string[], shortArg = 'rceitf', longArg: readonly string[] = ['requirement', 'constraint', 'editable', 'index-url', 'extra-index-url', 'find-links', 'target', 'prefix', 'root', 'python', 'platform', 'python-version', 'implementation', 'abi', 'cache-dir', 'log', 'timeout', 'retries', 'proxy', 'trusted-host', 'src', 'upgrade-strategy', 'config-settings', 'index', 'default-index', 'group', 'extra', 'save-prefix', 'registry', 'channel', 'name', 'prefix', 'file']): Opts {
  return parseOpts(args, shortArg, longArg)
}

function pipRole(cmd: Cmd, args: readonly string[]): Role {
  const sub = args.find(a => !a.startsWith('-')) ?? ''
  const rest = args.slice(args.indexOf(sub) + 1)
  const name = `${cmd.u.prog} ${sub}`.trim()
  if (sub === 'install' || sub === 'download' || sub === 'wheel') {
    const o = pkgArgs(rest)
    const req = first(o, 'r', 'requirement')
    const ed = first(o, 'e', 'editable')
    const pkgs = o.pos.map(p => p.replace(/\[.*$/, ''))
    return mk(cmd, 'install', 'pip-install', { name, target: req ?? ed ?? pkgs[0], concepts: ['pip'], x: { pkgs, arg: req, sub: ed !== undefined ? 'editable' : sub, manager: 'pip' } })
  }
  if (sub === 'uninstall') return mk(cmd, 'install', 'pip-install', { name, concepts: ['pip'], x: { pkgs: pkgArgs(rest).pos, sub: 'uninstall', manager: 'pip' } })
  const pkg = rest.find(a => !a.startsWith('-'))
  return mk(cmd, 'env', 'pip-list', { name, target: pkg, concepts: ['pip'], x: { sub, name: pkg } })
}

function uvRole(cmd: Cmd): Role {
  const a = cmd.u.args
  const sub = a.find(x => !x.startsWith('-')) ?? ''
  const rest = a.slice(a.indexOf(sub) + 1)
  if (sub === 'pip') {
    const r = pipRole({ ...cmd, u: { ...cmd.u, prog: 'uv pip' } }, rest)
    return { ...r, name: `uv pip ${rest.find(x => !x.startsWith('-')) ?? ''}`.trim(), concepts: ['uv', ...r.concepts], cmd }
  }
  if (sub === 'venv') {
    const dir = parseOpts(rest, 'p', ['python', 'prompt', 'seed', 'index-url']).pos[0] ?? '.venv'
    return mk(cmd, 'install', 'venv', { name: 'uv venv', target: dir, writes: [dir], concepts: ['python-venv', 'uv'], x: { dir, via: 'uv' } })
  }
  if (sub === 'sync' || sub === 'lock') return mk(cmd, 'install', 'uv-sync', { name: `uv ${sub}`, concepts: ['uv'], x: { sub } })
  if (sub === 'add' || sub === 'remove') return mk(cmd, 'install', 'pip-install', { name: `uv ${sub}`, concepts: ['uv'], x: { pkgs: pkgArgs(rest).pos, sub: sub === 'remove' ? 'uninstall' : 'install', manager: 'uv' } })
  if ((sub === 'tool' || sub === 'python') && /^(list|find|dir|pin|uninstall)$/.test(rest[0] ?? '')) return mk(cmd, 'env', 'pip-list', { name: `uv ${sub} ${rest[0] ?? ''}`, concepts: ['uv'], x: { sub: `uv-${sub}` } })
  if (sub === 'tool' || sub === 'python') return mk(cmd, 'install', 'install-misc', { name: `uv ${sub} ${rest[0] ?? ''}`.trim(), concepts: ['uv'], x: { what: rest.slice(1).find(x => !x.startsWith('-')) ?? sub, manager: 'uv' } })
  if (sub === 'init') return mk(cmd, 'install', 'install-misc', { name: 'uv init', concepts: ['uv'], x: { what: 'a new project', manager: 'uv' } })
  return mk(cmd, 'install', 'install-misc', { name: `uv ${sub}`.trim(), concepts: ['uv'], x: { what: sub, manager: 'uv' } })
}

function condaRole(cmd: Cmd): Role {
  const a = cmd.u.args
  const sub = a.find(x => !x.startsWith('-')) ?? ''
  const rest = a.slice(a.indexOf(sub) + 1)
  const p = cmd.u.prog
  const o = pkgArgs(rest, 'npcf', ['name', 'prefix', 'channel', 'file', 'override-channels'])
  const env = first(o, 'n', 'name') ?? first(o, 'p', 'prefix')
  if (sub === 'create' || (sub === 'env' && rest[0] === 'create')) return mk(cmd, 'install', 'conda-create', { name: `${p} create`, target: env, concepts: ['conda'], x: { name: env, pkgs: o.pos.filter(x => x !== 'create') } })
  if (sub === 'install' || sub === 'update' || sub === 'remove' || sub === 'uninstall') return mk(cmd, 'install', 'pip-install', { name: `${p} ${sub}`, concepts: ['conda'], x: { pkgs: o.pos, sub: sub === 'remove' || sub === 'uninstall' ? 'uninstall' : 'install', manager: p } })
  if (sub === 'activate' || sub === 'deactivate') return mk(cmd, 'other', 'setup', { setup: true, concepts: ['conda'] })
  return mk(cmd, 'env', 'conda-list', { name: `${p} ${sub} ${sub === 'env' ? rest[0] ?? '' : ''}`.trim(), concepts: ['conda'], x: { sub: sub === 'env' ? 'envs' : sub, name: env } })
}

const NPM_TESTISH = /^(test|tests|t|test:\S+|e2e|spec|check)$/
const NPM_BUILDISH = /^(build|build:\S+|compile|tsc|typecheck|type-check|types|lint|lint:\S+|format|bundle|dist|prepare)$/

function npmRole(cmd: Cmd): Role {
  const p = cmd.u.prog
  const a = cmd.u.args
  const k = skipOpts(a, 0, 'wC', ['workspace', 'prefix', 'dir', 'filter', 'cwd'])
  const sub = a[k] ?? ''
  const rest = a.slice(k + 1)
  const install = /^(install|i|ci|add|uninstall|remove|rm|un|update|up|upgrade|link)$/
  if (sub === '' && (p === 'yarn' || p === 'pnpm' || p === 'bun')) return mk(cmd, 'install', 'npm-install', { name: p, concepts: ['npm-install', 'package-json'], x: { manager: p, pkgs: [] } })
  if (install.test(sub)) {
    const pkgs = parseOpts(rest, 'w', ['save-prefix', 'registry', 'workspace', 'filter']).pos
    return mk(cmd, 'install', 'npm-install', { name: `${p} ${sub}`, target: pkgs[0], concepts: ['npm-install', 'package-json'], x: { manager: p, pkgs, sub } })
  }
  const script = sub === 'run' || sub === 'run-script' ? rest.find(x => !x.startsWith('-')) ?? '' : sub
  const name = sub === 'run' || sub === 'run-script' ? `${p} run ${script}` : `${p} ${sub}`
  if (sub === 'test' || sub === 't' || NPM_TESTISH.test(script)) return mk(cmd, 'test', 'test', { name: sub === 't' ? `${p} test` : name, concepts: ['npm-scripts', 'tests', 'verify-after-change'], x: { what: name } })
  if (NPM_BUILDISH.test(script)) {
    const lint = /lint|format/.test(script)
    const tc = /typecheck|type-check|types|tsc/.test(script)
    return mk(cmd, 'build', lint ? 'lint' : tc ? 'typecheck' : 'build', { name, concepts: ['npm-scripts', ...(lint ? ['linting'] : tc ? ['type-checking', 'typescript'] : [])], x: { what: name } })
  }
  if (/^(ls|list|outdated|view|info|show|config|whoami|root|bin|prefix|doctor|explain|why|audit|search|help|-v|--version|version)$/.test(sub)) {
    if (sub === '-v' || sub === '--version' || (sub === 'version' && !rest.length)) return versionRole(cmd, p)
    return mk(cmd, 'env', 'npm-ls', { name: `${p} ${sub}`, concepts: ['package-json'], x: { sub } })
  }
  if (sub === 'init' || sub === 'create') return mk(cmd, 'file-ops', 'init', { name: `${p} ${sub}`, concepts: ['package-json'], x: { what: `${p} ${sub}` } })
  if (sub === 'publish' || sub === 'pack') return mk(cmd, 'build', 'build', { name, concepts: ['package-json'], x: { what: name } })
  if (sub === 'exec' || sub === 'x' || sub === 'dlx') return mk(cmd, 'run-script', 'npm-run', { name, concepts: ['npx'], x: { what: rest[0] } })
  if (p === 'bun' && /\.(m?[jt]sx?)$/.test(sub)) return scriptRole(cmd, sub, rest, /\.tsx?$/.test(sub) ? 'TypeScript' : 'JavaScript', `bun ${baseName(sub)}`, ['node-script'])
  if (sub === 'start' || script === 'start' || script === 'dev' || script === 'serve' || script === 'preview') return mk(cmd, 'run-script', 'npm-start', { name, concepts: ['npm-scripts', 'package-json'], x: { what: script } })
  return mk(cmd, 'run-script', 'npm-run', { name, concepts: ['npm-scripts', 'package-json'], x: { what: script } })
}

function makeRole(cmd: Cmd): Role {
  const o = parseOpts(cmd.u.args, 'Cfj', ['directory', 'file', 'jobs'])
  const targets = o.pos.filter(t => !/=/.test(t))
  const t = targets[0] ?? ''
  const name = t ? `make ${t}` : 'make'
  if (/^(test|tests|check|unittest|e2e)$/.test(t)) return mk(cmd, 'test', 'test', { name, concepts: ['tests', 'verify-after-change'], x: { what: name } })
  if (/^(install|deps|setup|bootstrap)$/.test(t)) return mk(cmd, 'install', 'install-misc', { name, concepts: [], x: { what: `make ${t}` } })
  if (/^(clean|distclean)$/.test(t)) return mk(cmd, 'file-ops', 'make-clean', { name, concepts: [], x: { what: name } })
  if (/^(run|serve|start|dev)$/.test(t)) return mk(cmd, 'run-script', 'npm-run', { name, concepts: [], x: { what: name } })
  if (/^(lint|fmt|format)$/.test(t)) return mk(cmd, 'build', 'lint', { name, concepts: ['linting'], x: { what: name } })
  return mk(cmd, 'build', 'make', { name, target: t || undefined, concepts: [], x: { what: name } })
}

// ------------------------------------------------------------------- git

function gitRole(cmd: Cmd): Role {
  const a = cmd.u.args
  let k = 0
  let dir: string | undefined
  while (k < a.length && (a[k] ?? '').startsWith('-')) {
    const x = a[k] ?? ''
    if (x === '-C') dir = a[k + 1]
    k += x === '-C' || x === '-c' || x === '--git-dir' || x === '--work-tree' || x === '--namespace' ? 2 : 1
  }
  const sub = a[k] ?? ''
  const rest = a.slice(k + 1)
  const name = sub ? `git ${sub}` : 'git'
  const pos = rest.filter(x => !x.startsWith('-'))
  const dash = rest.indexOf('--')
  const paths = dash >= 0 ? rest.slice(dash + 1) : []
  const base: Partial<Role> = { name, x: { sub, dir } }
  const GW: Readonly<Record<string, number>> = { 'git-commit': 73, 'git-remote': 72, 'git-merge': 72, 'git-add': 60, 'git-stash': 60 }
  const r = (kind: string, concepts: string[], extra: Partial<Role> = {}): Role =>
    mk(cmd, 'git', kind, { w: sub === 'remote' ? 45 : GW[kind] ?? 45, ...base, ...extra, concepts: concepts.concat('git-basics'), x: { ...base.x, ...(extra.x ?? {}) } })
  switch (sub) {
    case 'status':
      return r('git-status', ['git-status'])
    case 'diff': {
      const staged = rest.includes('--cached') || rest.includes('--staged')
      const stat = rest.includes('--stat') || rest.includes('--name-only') || rest.includes('--name-status') || rest.includes('--shortstat')
      const file = paths[0] ?? pos.find(p => /[./]/.test(p) && !/\.\./.test(p) && !/^[0-9a-f]{7,40}$/.test(p))
      return r('git-diff', ['git-diff'], { target: file, x: { sub, mode: staged ? 'staged' : stat ? 'stat' : undefined, arg: file } })
    }
    case 'log':
    case 'shortlog':
    case 'reflog': {
      const n = /^-(\d+)$/.exec(rest.find(x => /^-\d+$/.test(x)) ?? '')?.[1] ?? rest[rest.indexOf('-n') + 1]
      return r('git-log', ['git-log'], { target: paths[0], x: { sub, arg: paths[0], n: n !== undefined && /^\d+$/.test(n) ? Number(n) : undefined } })
    }
    case 'show': {
      const ref = pos[0]
      return r('git-show', ['git-blame'], { target: ref, x: { sub, arg: ref } })
    }
    case 'blame':
    case 'annotate':
      return r('git-blame', ['git-blame'], { target: pos[pos.length - 1], x: { sub, arg: pos[pos.length - 1] } })
    case 'add':
    case 'commit': {
      const mi = rest.findIndex(x => x === '-m' || x === '--message' || /^-[a-zA-Z]*m$/.test(x))
      let msg = mi >= 0 ? rest[mi + 1] : rest.find(x => x.startsWith('--message='))?.slice(10)
      if (msg !== undefined) {
        const here = /^\$\(\s*cat\s*<<-?\s*['"]?\w+['"]?\s*\n([\s\S]*)$/.exec(msg)
        if (here) msg = (here[1] ?? '').split('\n').find(l => l.trim() !== '')
      }
      return r(sub === 'add' ? 'git-add' : 'git-commit', ['git-commit'], { target: sub === 'add' ? pos[0] : undefined, x: { sub, msg: msg?.trim(), files: pos } })
    }
    case 'push':
    case 'pull':
    case 'fetch':
    case 'clone':
    case 'remote':
      return r('git-remote', ['git-remote'], { target: pos[0], x: { sub, arg: pos[0], sub2: pos[1] } })
    case 'branch':
    case 'checkout':
    case 'switch':
    case 'restore':
    case 'worktree':
      return r('git-branch', ['git-branch'], { target: pos[pos.length - 1], x: { sub, arg: pos[pos.length - 1], mode: rest.includes('-b') || rest.includes('-c') || rest.includes('-B') ? 'new' : rest.includes('-d') || rest.includes('-D') ? 'delete' : dash >= 0 ? 'files' : undefined } })
    case 'merge':
    case 'rebase':
    case 'cherry-pick':
      return r('git-merge', ['git-merge-rebase'], { target: pos[0], x: { sub, arg: pos[0] } })
    case 'stash':
      return r('git-stash', ['git-stash'], { x: { sub, arg: pos[0] } })
    case 'grep': {
      const g = grepRole(cmd, rest, 'git grep')
      return { ...g, name: 'git grep', concepts: g.concepts.concat('git-basics'), x: { ...g.x, recursive: true }, where: g.where ?? '.' }
    }
    case 'check-ignore':
      return r('git-misc', ['gitignore'], { target: pos[0], x: { sub, arg: pos[0] } })
    default:
      return r('git-misc', [], { target: pos[0], x: { sub, arg: pos[0] } })
  }
}

function ghRole(cmd: Cmd): Role {
  const a = cmd.u.args
  const pos = a.filter(x => !x.startsWith('-'))
  const sub = pos[0] ?? ''
  const sub2 = pos[1] ?? ''
  const arg = pos[2]
  return mk(cmd, 'git', 'gh', { w: 60, name: `gh ${sub} ${sub === 'api' ? '' : sub2}`.trim(), target: sub === 'api' ? sub2 : arg, concepts: ['gh-cli', 'git-remote'], x: { sub, sub2, arg } })
}

// ------------------------------------------------------------------- network and http

const CURL_ARG = 'XHdFouAebcwmxTKErDyYzPQUCt'
const CURL_LONG = [
  'request', 'header', 'data', 'data-raw', 'data-binary', 'data-urlencode', 'data-ascii', 'json', 'form', 'form-string', 'output', 'user', 'user-agent',
  'referer', 'cookie', 'cookie-jar', 'write-out', 'max-time', 'connect-timeout', 'retry', 'retry-delay', 'retry-max-time', 'proxy', 'upload-file',
  'cacert', 'capath', 'cert', 'key', 'config', 'resolve', 'limit-rate', 'range', 'url', 'unix-socket', 'dump-header', 'stderr', 'trace',
  'trace-ascii', 'oauth2-bearer', 'aws-sigv4', 'variable', 'interface', 'max-filesize', 'output-dir', 'proto', 'proto-redir', 'ciphers',
  'continue-at', 'local-port', 'max-redirs', 'netrc-file', 'noproxy', 'pass', 'proxy-user', 'pinnedpubkey', 'preproxy', 'socks5', 'socks5-hostname', 'connect-to',
]

function curlRole(cmd: Cmd): Role {
  const o = parseOpts(cmd.u.args, CURL_ARG, CURL_LONG)
  const url = first(o, 'url') ?? o.pos.find(looksUrl) ?? o.pos[0] ?? ''
  const headers = (o.v.get('H') ?? []).concat(o.v.get('header') ?? [])
  const auth = headers.some(h => /^\s*(authorization|x-api-key|api-key|x-auth-token|private-token|x-access-token)\s*:/i.test(h)) || o.f.has('u') || o.f.has('user') || o.f.has('oauth2-bearer')
  const data = ['d', 'F', 'data', 'data-raw', 'data-binary', 'data-urlencode', 'json', 'form'].some(k => o.f.has(k))
  const method = (first(o, 'X', 'request') ?? (o.f.has('I') || o.f.has('head') ? 'HEAD' : data && !o.f.has('G') ? 'POST' : o.f.has('T') ? 'PUT' : 'GET')).toUpperCase()
  const wout = first(o, 'w', 'write-out') ?? ''
  const status = o.f.has('I') || o.f.has('head') || /http_code|response_code/.test(wout)
  const out = first(o, 'o', 'output')
  const download = (out !== undefined && !isDevNull(out)) || o.f.has('O') || o.f.has('remote-name')
  const { local, host } = urlParts(url)
  const concepts = ['curl', 'http-requests']
  if (local) concepts.push('localhost')
  if (status) concepts.push('http-status-codes')
  if (auth) concepts.push('api-tokens')
  if (headers.some(h => /json/i.test(h)) || o.f.has('json')) concepts.push('json')
  if (/\/(api|v\d+)\//.test(urlParts(url).path + '/')) concepts.push('rest-api')
  const clean = url ? cleanUrl(url) : undefined
  return mk(cmd, 'http', download ? 'download' : 'curl', {
    name: 'curl',
    target: clean,
    writes: out !== undefined && !isDevNull(out) ? [out] : [],
    concepts,
    x: { url: clean, local, method, status, download, host, arg: out ?? (o.f.has('O') ? baseName(urlParts(url).path) : undefined) },
  })
}

function wgetRole(cmd: Cmd): Role {
  const o = parseOpts(cmd.u.args, 'OoPaUtTwiNeQlADRXIH', ['output-document', 'output-file', 'directory-prefix', 'header', 'user-agent', 'post-data', 'post-file', 'user', 'password', 'http-user', 'http-password', 'tries', 'timeout', 'wait', 'load-cookies', 'save-cookies', 'method', 'body-data', 'ca-certificate', 'certificate', 'private-key', 'input-file', 'level', 'accept', 'reject', 'domains', 'limit-rate', 'quota', 'referer', 'execute'])
  const url = o.pos.find(looksUrl) ?? o.pos[0] ?? ''
  const out = first(o, 'O', 'output-document')
  const spider = o.f.has('spider')
  const { local, host } = urlParts(url)
  const concepts = ['http-requests']
  if (local) concepts.push('localhost')
  const clean = url ? cleanUrl(url) : undefined
  const toStdout = out === '-'
  return mk(cmd, 'http', spider || toStdout ? 'curl' : 'download', {
    name: 'wget',
    target: clean,
    writes: out && out !== '-' ? [out] : [],
    concepts,
    x: { url: clean, local, method: 'GET', status: spider, download: !spider && !toStdout, host, arg: out && out !== '-' ? out : baseName(urlParts(url).path) || undefined },
  })
}

function hostOf(s: string): string {
  return s.replace(/^[^@]*@/, '').replace(/:.*$/, '')
}

// ------------------------------------------------------------------- docker

function dockerRole(cmd: Cmd): Role {
  const p = cmd.u.prog
  let a = cmd.u.args
  if (p === 'docker-compose' || p === 'podman-compose') a = ['compose', ...a]
  const k = skipOpts(a, 0, 'Hcl', ['host', 'context', 'config', 'log-level', 'tlscacert', 'tlscert', 'tlskey'])
  let sub = a[k] ?? ''
  let rest = a.slice(k + 1)
  if ((sub === 'container' || sub === 'image' || sub === 'buildx' || sub === 'builder') && rest[0]) {
    const s2 = rest[0]
    sub = sub === 'image' && s2 === 'ls' ? 'images' : sub === 'container' && s2 === 'ls' ? 'ps' : s2
    rest = rest.slice(1)
  }
  const tool = p === 'podman' ? 'podman' : 'docker'
  const firstPos = (args: readonly string[], shortArg: string, longArg: readonly string[]): string | undefined => args[skipOpts(args, 0, shortArg, longArg)]
  switch (sub) {
    case 'build': {
      const o = parseOpts(rest, 'tf', ['tag', 'file', 'build-arg', 'target', 'platform', 'label', 'secret', 'ssh', 'cache-from', 'network', 'progress', 'output'])
      const image = first(o, 't', 'tag')
      return mk(cmd, 'build', 'docker-build', { name: `${tool} build`, target: image ?? o.pos[0], concepts: ['docker-images', 'dockerfile'], x: { name: image } })
    }
    case 'compose': {
      const j = skipOpts(rest, 0, 'fp', ['file', 'project-name', 'env-file', 'profile', 'project-directory', 'ansi', 'parallel'])
      const s2 = rest[j] ?? ''
      const svc = firstPos(rest.slice(j + 1), 'e', ['tail', 'since', 'until', 'scale', 'timeout', 'env', 'user', 'workdir'])
      if (s2 === 'build') return mk(cmd, 'build', 'docker-build', { name: `${tool} compose build`, target: svc, concepts: ['docker-compose', 'docker-images'], x: { name: svc, sub: 'compose' } })
      return mk(cmd, 'docker', 'compose', { name: `${tool} compose ${s2}`.trim(), target: svc, concepts: ['docker-compose', 'docker-containers'], x: { sub: s2, name: svc } })
    }
    case 'ps':
      return mk(cmd, 'docker', 'docker-ps', { name: `${tool} ps`, concepts: ['docker-containers'], x: { sub, mode: rest.includes('-a') || rest.includes('--all') ? 'all' : undefined } })
    case 'logs': {
      const c = firstPos(rest, 'n', ['tail', 'since', 'until'])
      return mk(cmd, 'docker', 'docker-logs', { name: `${tool} logs`, target: c, concepts: ['docker-containers', 'reading-logs'], x: { name: c, follow: rest.includes('-f') || rest.includes('--follow') } })
    }
    case 'exec': {
      const j = skipOpts(rest, 0, 'euw', ['env', 'user', 'workdir', 'env-file', 'detach-keys'])
      const c = rest[j]
      const inner = rest.slice(j + 1)
      return mk(cmd, 'docker', 'docker-exec', { name: `${tool} exec`, target: c, concepts: ['docker-containers'], x: { name: c, what: progName(inner[0] ?? '') } })
    }
    case 'run': {
      const j = skipOpts(rest, 0, 'evpwuhlmc', ['env', 'volume', 'publish', 'name', 'workdir', 'user', 'network', 'net', 'entrypoint', 'memory', 'cpus', 'gpus', 'env-file', 'mount', 'shm-size', 'label', 'hostname', 'add-host', 'device', 'restart', 'log-driver', 'log-opt', 'ulimit', 'platform', 'pull', 'ipc', 'pid', 'runtime', 'security-opt', 'cap-add', 'cap-drop', 'tmpfs', 'dns', 'expose', 'link', 'cidfile', 'stop-signal', 'stop-timeout', 'health-cmd', 'health-interval', 'cpuset-cpus', 'memory-swap'])
      const image = rest[j]
      return mk(cmd, 'docker', 'docker-run', { name: `${tool} run`, target: image, concepts: ['docker-containers', 'docker-images'], x: { name: image, bg: rest.slice(0, j).some(x => x === '-d' || x === '--detach' || /^-[a-z]*d[a-z]*$/.test(x)) } })
    }
    case 'images':
    case 'pull':
    case 'push':
    case 'rmi':
    case 'tag':
    case 'save':
    case 'load':
    case 'history': {
      const img = firstPos(rest, '', [])
      return mk(cmd, 'docker', 'docker-images', { name: `${tool} ${sub}`, target: img, concepts: ['docker-images'], x: { sub, name: img } })
    }
    case 'inspect':
    case 'stop':
    case 'start':
    case 'restart':
    case 'kill':
    case 'rm':
    case 'pause':
    case 'unpause':
    case 'wait':
    case 'top':
    case 'port':
    case 'stats':
    case 'cp':
    case 'diff':
    case 'attach': {
      const c = firstPos(rest, 'fts', ['format', 'type', 'time', 'signal'])
      return mk(cmd, 'docker', 'docker-ctl', { name: `${tool} ${sub}`, target: c, concepts: ['docker-containers'], x: { sub, name: c } })
    }
    default:
      return mk(cmd, 'docker', 'docker-misc', { name: `${tool} ${sub}`.trim(), concepts: ['docker-containers'], x: { sub } })
  }
}

// ------------------------------------------------------------------- databases

function sqlKind(sql: string): string {
  const s = sql.trim()
  if (/^\.(backup|dump|clone|save)\b/m.test(s)) return 'backup'
  if (/^\.tables\b/m.test(s) && !/\bselect\b/i.test(s)) return 'tables'
  if (/^\.(schema|indexes|indices)\b/m.test(s) && !/\bselect\b/i.test(s)) return 'schema'
  if (/^\.(import|read)\b/m.test(s)) return 'import'
  if (/\b(insert|update|delete|replace)\b\s+(into\s+|from\s+)?[\w."]+/i.test(s) && /^\s*(insert|update|delete|replace|begin|with)\b/im.test(s)) return 'write'
  if (/^\s*(create|alter|drop)\s+(table|index|view|trigger)\b/im.test(s)) return 'ddl'
  return 'read'
}

const SQL_VISIBLE = /\b(select|insert\s+into|update\s+\w+\s+set|delete\s+from|create\s+table|alter\s+table|drop\s+table|pragma)\b/i

function sqliteRole(cmd: Cmd): Role {
  const a = cmd.u.args
  const pos: string[] = []
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? ''
    if (/^--?(cmd|separator|nullvalue|init|newline|maxsize|vfs|mmap|pagecache|lookaside|heap)$/.test(x)) {
      if (x.endsWith('cmd')) pos.push(a[i + 1] ?? '')
      i++
      continue
    }
    if (x.startsWith('-') && x.length > 1) continue
    pos.push(x)
  }
  const db = pos[0]
  const sql = pos.slice(1).join('\n') || cmd.doc?.body || cmd.herestr || ''
  const sqlFile = inputFile(cmd)
  const kind = sqlKind(sql)
  const concepts = ['sqlite']
  if (SQL_VISIBLE.test(sql) || (sqlFile !== undefined && /\.sql$/.test(sqlFile))) concepts.push('sql-queries')
  if (kind === 'backup') concepts.push('backups')
  return mk(cmd, 'database', 'sqlite', { name: cmd.u.prog, target: db, reads: db ? [db] : [], writes: kind === 'write' || kind === 'ddl' ? (db ? [db] : []) : [], concepts, x: { db, sql: kind, what: 'SQLite' } })
}

function sqlClientRole(cmd: Cmd, what: string): Role {
  const p = cmd.u.prog
  const o = parseOpts(cmd.u.args, p === 'psql' ? 'cdhUpfFvP' : 'eDhupPS', ['command', 'dbname', 'host', 'username', 'port', 'file', 'execute', 'database', 'user', 'password', 'socket'])
  const db = first(o, 'd', 'dbname', 'D', 'database') ?? o.pos[0]
  const sql = first(o, 'c', 'command', 'e', 'execute') ?? cmd.doc?.body ?? cmd.herestr ?? ''
  const concepts = ['sql-queries']
  if (/dump/.test(p)) concepts.push('backups')
  return mk(cmd, 'database', /dump/.test(p) ? 'db-dump' : 'sql', { name: p, target: db, concepts, x: { db, sql: sqlKind(sql), what } })
}

// ------------------------------------------------------------------- processes

function pidLabel(s: string | undefined): string {
  if (s === undefined || s.trim() === '') return 'the process'
  const t = s.trim()
  const ids = t.split(/[\s,]+/).filter(Boolean)
  if (ids.every(i => /^\d+$/.test(i))) return ids.length === 1 ? `process ${ids[0]}` : `processes ${listOf(ids, 3)}`
  const f = /\$\(\s*(?:cat|<)\s+["']?([^)"'\s]+)["']?\s*\)/.exec(t)
  if (f) return `the process in ${baseName(f[1] ?? '')}`
  const g = /\$\(\s*(?:pgrep|pidof)\s+(?:-\w+\s+)*["']?([^)"'|]+?)["']?\s*(?:\||\))/.exec(t)
  if (g) return `the ${quote(g[1] ?? '', 28)} process`
  if (/^%\d+$/.test(t)) return `background job ${t}`
  if (/^\$!$/.test(t)) return 'the last background job'
  return 'the process'
}

function killRole(cmd: Cmd): Role {
  const a = cmd.u.args
  let sig = ''
  const targets: string[] = []
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? ''
    if (x === '-s' || x === '-n' || x === '--signal') sig = a[++i] ?? ''
    else if (/^-(\d+|[A-Z][A-Z0-9+]*|SIG\w+)$/.test(x)) sig = x.slice(1)
    else if (x === '-l' || x === '-L') return mk(cmd, 'process', 'kill-list', { name: 'kill -l', concepts: ['kill-signals'] })
    else if (x === '--') continue
    else targets.push(x)
  }
  const pid = targets.join(' ')
  if (sig === '0') return mk(cmd, 'process', 'kill-0', { name: 'kill -0', target: pid, concepts: ['processes', 'kill-signals'], x: { pid, sig } })
  return mk(cmd, 'process', 'kill', { name: sig ? `kill -${sig}` : 'kill', target: pid, w: 52, concepts: ['kill-signals', 'processes'], x: { pid, sig } })
}

function systemctlRole(cmd: Cmd): Role {
  const a = cmd.u.args
  const p = cmd.u.prog
  if (p === 'service') return mk(cmd, 'process', 'systemctl', { name: `service ${a[1] ?? ''}`.trim(), target: a[0], concepts: ['systemd'], x: { sub: a[1] ?? 'status', unit: a[0] } })
  const k = skipOpts(a, 0, 'pnotHMs', ['property', 'lines', 'output', 'type', 'state', 'host', 'machine', 'signal', 'kill-whom', 'root'])
  const sub = a[k] ?? 'list-units'
  const unit = a.slice(k + 1).find(x => !x.startsWith('-'))
  return mk(cmd, 'process', 'systemctl', { name: `systemctl ${sub}`, target: unit, concepts: ['systemd'], x: { sub, unit } })
}

function tmuxRole(cmd: Cmd): Role {
  const a = cmd.u.args
  const p = cmd.u.prog
  if (p === 'screen') {
    const o = parseOpts(a, 'SrXpxL', [])
    const name = first(o, 'S', 'r', 'x')
    const sub = o.f.has('ls') || o.f.has('list') || a.includes('-ls') || a.includes('-list') ? 'ls' : o.f.has('d') && o.f.has('m') ? 'new' : o.f.has('X') ? 'cmd' : o.f.has('r') || o.f.has('x') ? 'attach' : 'new'
    return mk(cmd, 'process', 'tmux', { name: 'screen', target: name, concepts: ['tmux-screen'], x: { sub, name, bg: sub === 'new' && o.f.has('d') } })
  }
  const k = skipOpts(a, 0, 'LSf', [])
  const sub = a[k] ?? 'new-session'
  const o = parseOpts(a.slice(k + 1), 'stncFxyeTl', [])
  const name = first(o, 's', 't')
  const norm = /^(new|new-session)$/.test(sub) ? 'new' : /^(ls|list-sessions)$/.test(sub) ? 'ls' : /^(a|at|attach|attach-session)$/.test(sub) ? 'attach' : /^(kill-session|kill-server)$/.test(sub) ? 'kill' : /^(send|send-keys)$/.test(sub) ? 'send' : /^(capture-pane|capturep)$/.test(sub) ? 'capture' : /^has(-session)?$/.test(sub) ? 'has' : sub
  return mk(cmd, 'process', 'tmux', { name: `tmux ${sub}`, target: name, concepts: ['tmux-screen'], x: { sub: norm, name: name?.replace(/[:.].*$/, ''), bg: norm === 'new' && o.f.has('d') } })
}

// ------------------------------------------------------------------- media, gpu

const FF_FLAGS: ReadonlySet<string> = new Set(['-y', '-n', '-hide_banner', '-nostdin', '-nostats', '-stats', '-re', '-shortest', '-vn', '-an', '-sn', '-dn', '-copyts', '-benchmark', '-ignore_unknown', '-report', '-xerror', '-dump'])

function ffmpegRole(cmd: Cmd): Role {
  const a = cmd.u.args
  const inputs: string[] = []
  const outs: string[] = []
  let nullOut = false
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? ''
    if (x === '-i') inputs.push(a[++i] ?? '')
    else if (x === '-f' && a[i + 1] === 'null') {
      nullOut = true
      i++
    } else if (x.startsWith('-') && x !== '-') {
      if (!FF_FLAGS.has(x)) i++
    } else outs.push(x)
  }
  const out = outs[outs.length - 1]
  if (out === '-' || out === '/dev/null') nullOut = true
  if (!inputs.length && a.some(x => /^-(encoders|decoders|codecs|formats|filters|version|buildconf|muxers|demuxers|pix_fmts|layouts|sample_fmts|bsfs|protocols|devices|hwaccels|h|help)$/.test(x))) {
    return mk(cmd, 'media', 'ffmpeg', { name: 'ffmpeg', w: 30, concepts: ['ffmpeg'], x: { mode: 'info' } })
  }
  return mk(cmd, 'media', 'ffmpeg', {
    name: 'ffmpeg',
    target: inputs[0],
    reads: inputs.filter(isFileArg),
    writes: out && !nullOut ? [out] : [],
    concepts: ['ffmpeg', 'audio-basics'],
    x: { files: inputs, arg: nullOut ? undefined : out, mode: nullOut ? 'analyze' : undefined },
  })
}

function ffprobeRole(cmd: Cmd): Role {
  const a = cmd.u.args
  let file: string | undefined
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? ''
    if (x === '-i') file = a[++i]
    else if (x.startsWith('-')) {
      if (!/^-(show_\w+|hide_banner|pretty|count_frames|count_packets|sexagesimal|unit|prefix|byte_binary_prefix)$/.test(x)) i++
    } else file = x
  }
  return mk(cmd, 'media', 'ffprobe', { name: 'ffprobe', target: file, reads: file ? [file] : [], concepts: ['ffmpeg', 'audio-basics'], x: {} })
}

function nvidiaRole(cmd: Cmd): Role {
  const a = cmd.u.args
  const o = parseOpts(a, 'ilfd', ['query-gpu', 'query-compute-apps', 'format', 'id', 'loop', 'loop-ms', 'filename'])
  const q = first(o, 'query-gpu')
  const apps = first(o, 'query-compute-apps')
  const loop = first(o, 'l', 'loop')
  const sub = o.pos[0]
  const mode = apps !== undefined || sub === 'pmon' ? 'apps' : o.f.has('L') || o.f.has('list-gpus') ? 'list' : sub === 'dmon' ? 'watch' : sub === 'topo' ? 'topo' : o.f.has('q') || o.f.has('query') ? 'full' : q !== undefined && /clocks|power|temperature|fan|pstate/.test(q) && !/memory/.test(q) ? 'clocks' : 'mem'
  const concepts = ['nvidia-smi', 'gpu-memory']
  if (mode === 'apps') concepts.push('processes')
  return mk(cmd, 'gpu', 'nvidia-smi', { name: 'nvidia-smi', target: q ?? apps, concepts, x: { fields: q ?? apps, mode, secs: loop !== undefined ? Number(loop) : undefined } })
}

// ------------------------------------------------------------------- the dispatcher

const SETUP_PROGS: ReadonlySet<string> = new Set([
  'cd', 'pushd', 'popd', 'export', 'set', 'unset', 'shopt', 'trap', 'ulimit', 'umask', 'alias', 'unalias', 'hash', 'local', 'declare', 'typeset',
  'readonly', 'true', 'false', ':', 'exit', 'return', 'continue', 'break', 'shift', 'let', 'read', 'clear', 'reset', 'source', '.', '[', '[[', 'test',
  '((', 'mapfile', 'readarray', 'getopts', 'enable', 'disown', 'complete', 'bind', 'history', 'logout', 'tput', 'stty', 'mktemp', 'yes', 'seq',
])

const ENV_KINDS: Readonly<Record<string, [string, string[]]>> = {
  uname: ['uname', []],
  arch: ['uname', []],
  sw_vers: ['uname', []],
  lsb_release: ['uname', []],
  hostname: ['hostname', []],
  hostnamectl: ['hostname', []],
  whoami: ['whoami', []],
  id: ['whoami', []],
  groups: ['whoami', []],
  logname: ['whoami', []],
  nproc: ['cpu', ['cpu-memory']],
  lscpu: ['cpu', ['cpu-memory']],
  free: ['mem', ['cpu-memory']],
  vmstat: ['mem', ['cpu-memory']],
  uptime: ['uptime', ['cpu-memory']],
  date: ['date', ['date-time']],
  timedatectl: ['date', ['date-time']],
  df: ['df', ['disk-usage']],
  lsblk: ['disk', ['disk-usage']],
  findmnt: ['disk', ['disk-usage']],
  mount: ['disk', ['disk-usage']],
  blkid: ['disk', ['disk-usage']],
  lspci: ['hw', []],
  lsusb: ['hw', []],
  lshw: ['hw', []],
  dmidecode: ['hw', []],
  locale: ['locale', []],
  getconf: ['sysinfo', []],
  sysctl: ['sysinfo', []],
  printenv: ['env', ['env-var']],
  pwd: ['pwd', ['cwd-and-paths']],
  realpath: ['path', ['cwd-and-paths']],
  readlink: ['path', ['symlinks']],
  basename: ['path', ['cwd-and-paths']],
  dirname: ['path', ['cwd-and-paths']],
  ldd: ['libs', []],
  ldconfig: ['libs', []],
  'pkg-config': ['libs', []],
  dmesg: ['dmesg', ['reading-logs']],
  last: ['whoami', []],
  w: ['whoami', []],
  who: ['whoami', []],
  iostat: ['mem', ['cpu-memory']],
}

const ENV_WEIGHT: Readonly<Record<string, number>> = { date: 4, pwd: 5, path: 6 }

const UNKNOWN_SKIP = /^(\$\(|\(\(|`)/

function classify(cmd: Cmd): Role {
  const u = cmd.u
  if (!cmd.argv.length) {
    if (stdoutTarget(cmd)) return mk(cmd, 'other', cmd.groupOut ? 'group-out' : 'truncate-out', { feeder: true })
    return mk(cmd, 'other', 'assign', { setup: true, concepts: cmd.assigns.length ? ['env-var'] : [] })
  }
  if (u.inner !== undefined && (u.prog === 'eval' || SHELLS.has(u.prog) || u.prog === 'env')) return mk(cmd, 'other', 'shell-wrap', { setup: true })
  const p = u.prog
  const a = u.args
  if (p === '') return mk(cmd, 'other', 'setup', { setup: true })
  if (p === ':' && stdoutTarget(cmd)) return mk(cmd, 'other', 'truncate-out', { feeder: true })
  if (cmd.progItems && cmd.progItems.length > 1 && uniq(cmd.progItems.map(x => progName(x).replace(/\d+$/, ''))).length > 1) {
    const names = uniq(cmd.progItems.map(progName))
    if (a.some(x => /^(--version|-V|version|-v)$/.test(x))) return mk(cmd, 'env', 'version', { name: 'each --version', concepts: ['which-path'], x: { files: names } })
    return mk(cmd, 'other', 'each-prog', { name: undefined, w: 20, concepts: ['shell-loop'], x: { files: names } })
  }
  if (p === 'watch') return mk(cmd, 'other', 'shell-wrap', { setup: true, x: { secs: u.secs } })
  // `X --version` / `X --help` for any known program
  if (a.length === 1 && /^(--version|-V|-version|version)$/.test(a[0] ?? '') && !/^(git|docker|npm|claude|kubectl|go|cargo)$/.test(p) && !UNKNOWN_SKIP.test(p)) return versionRole(cmd, p)
  if (a.length === 1 && /^(--help|-h|help)$/.test(a[0] ?? '') && p !== 'claude') return mk(cmd, 'env', 'help', { name: `${p} --help`, target: p, concepts: [], x: { what: p } })
  switch (p) {
    case 'cd':
    case 'pushd':
    case 'popd':
      return mk(cmd, 'other', 'cd', { setup: true, concepts: ['cwd-and-paths'] })
    case 'source':
    case '.': {
      const f = a[0] ?? ''
      const c = ['source-env']
      if (/activate$/.test(f)) c.unshift(/conda/.test(f) ? 'conda' : 'python-venv')
      if (/\.env$|\.env\b|secrets?/.test(f)) c.push('secrets-hygiene')
      return mk(cmd, 'other', 'source', { setup: true, concepts: c, target: f })
    }
    case 'set':
      return mk(cmd, 'other', 'set', { setup: true, concepts: a.some(x => /^-[a-zA-Z]*e/.test(x) || x === 'pipefail' || x === 'errexit') ? ['strict-mode'] : [] })
    case 'export':
      return mk(cmd, 'other', 'export', { setup: true, concepts: ['env-var'] })
    case 'echo':
    case 'printf': {
      const text = a.join(' ')
      const envRefs = [...text.matchAll(/\$\{?([A-Z_][A-Z0-9_]{1,})/g)].map(m => m[1] ?? '').filter(v => v !== '' && !/^(LINENO|RANDOM|SECONDS|BASHPID)$/.test(v))
      if (envRefs.length && cmd.pos === 0 && cmd.len <= 1) return mk(cmd, 'env', 'echo-env', { name: p, target: envRefs[0], concepts: ['env-var'], x: { files: uniq(envRefs) } })
      return mk(cmd, 'other', 'print', { feeder: true })
    }
    case 'sleep': {
      const s = parseDuration(a.find(x => !x.startsWith('-')) ?? '') ?? 0
      return mk(cmd, 'wait', 'sleep', { name: 'sleep', w: s >= 10 ? 55 : 3, concepts: [], x: { secs: s } })
    }
    case 'wait':
      return mk(cmd, 'wait', 'wait-bg', { name: 'wait', w: 50, concepts: ['background-job'], x: { pid: a.join(' ') } })
    case 'inotifywait':
      return mk(cmd, 'wait', 'inotify', { name: p, target: a.filter(isFileArg).pop(), concepts: [] })
    case 'mkdir': {
      const o = parseOpts(a, 'm', ['mode', 'context'])
      return mk(cmd, 'file-ops', 'mkdir', { w: 8, target: o.pos[0], writes: o.pos.slice(), concepts: o.f.has('p') || o.f.has('parents') ? ['mkdir-p'] : [], x: { files: o.pos } })
    }
    case 'touch':
      return mk(cmd, 'file-ops', 'touch', { w: 10, target: a.filter(isFileArg)[0], writes: a.filter(isFileArg), concepts: [], x: { files: a.filter(isFileArg) } })
    case 'cat':
      return catRole(cmd)
    case 'head':
    case 'tail':
      return headTailRole(cmd)
    case 'sed':
    case 'gsed':
      return sedRole(cmd)
    case 'awk':
    case 'gawk':
    case 'mawk':
    case 'nawk':
      return awkRole(cmd)
    case 'wc':
      return wcRole(cmd)
    case 'grep':
    case 'egrep':
    case 'fgrep':
    case 'zgrep':
    case 'rg':
    case 'ag':
    case 'ack':
      return grepRole(cmd, a, p === 'zgrep' ? 'grep' : p)
    case 'find':
      return findRole(cmd)
    case 'fd':
    case 'fdfind': {
      const o = parseOpts(a, 'etdEcxXj', ['extension', 'type', 'max-depth', 'exclude', 'color', 'exec', 'exec-batch', 'threads', 'size', 'changed-within'])
      if (!o.pos.length) return mk(cmd, 'list-files', 'find-list', { name: p, target: '.', concepts: ['find'], x: { files: ['.'] } })
      return mk(cmd, 'search', 'find-name', { name: p, query: o.pos[0], target: o.pos[0], where: o.pos[1] ?? '.', concepts: ['find'], x: { files: [o.pos[1] ?? '.'] } })
    }
    case 'locate':
    case 'plocate':
    case 'mlocate':
      return mk(cmd, 'search', 'find-name', { name: p, query: a.filter(x => !x.startsWith('-')).join(' '), target: a.find(x => !x.startsWith('-')), concepts: ['find'], x: {} })
    case 'ls':
    case 'll':
    case 'la':
    case 'exa':
    case 'eza':
    case 'lsd':
    case 'dir':
    case 'vdir':
      return lsRole(cmd)
    case 'tree': {
      const o = parseOpts(a, 'LIPo', ['filelimit', 'charset', 'sort', 'timefmt'])
      return mk(cmd, 'list-files', 'tree', { target: o.pos[0] ?? '.', concepts: ['ls'], x: { files: o.pos.length ? o.pos : ['.'] } })
    }
    case 'du':
    case 'dust':
    case 'ncdu': {
      const o = parseOpts(a, 'dBtX', ['max-depth', 'exclude', 'threshold', 'time-style', 'block-size', 'files0-from', 'exclude-from'])
      return mk(cmd, 'list-files', 'du', { target: o.pos[0] ?? '.', concepts: ['disk-usage'], x: { files: o.pos.length ? o.pos : ['.'] } })
    }
    case 'stat':
    case 'file': {
      const files = parseOpts(a, 'cf', ['format', 'printf', 'magic-file']).pos.filter(isFileArg)
      return mk(cmd, 'read-file', 'stat', { target: files[0], reads: [], concepts: [], x: { files } })
    }
    case 'tee': {
      const o = parseOpts(a, '', ['output-error'])
      const files = o.pos.filter(f => isFileArg(f) && !isDevNull(f))
      if (!files.length) return mk(cmd, 'read-file', 'tee', { filter: true, concepts: ['tee'] })
      return mk(cmd, 'write-file', 'tee', { target: files[0], writes: files, concepts: ['tee'], x: { append: o.f.has('a') || o.f.has('append'), files } })
    }
    case 'cp':
    case 'mv':
    case 'install': {
      const o = parseOpts(a, 'tSmogb', ['target-directory', 'suffix', 'backup', 'reflink', 'sparse', 'preserve', 'no-preserve', 'mode', 'owner', 'group'])
      const tdir = first(o, 't', 'target-directory')
      const pos = o.pos.filter(x => x !== '')
      const dest = tdir ?? (pos.length > 1 ? pos[pos.length - 1] : undefined)
      const srcs = tdir ? pos : pos.slice(0, -1)
      const backup = dest !== undefined && /\.(bak|orig|backup|old)\b|backup|bak[-_.]/i.test(dest)
      return mk(cmd, 'file-ops', p === 'mv' ? 'mv' : 'cp', { target: dest, reads: srcs.filter(s => !looksDir(s)), writes: dest ? [dest] : [], concepts: backup ? ['backups', 'cp-mv-rm'] : ['cp-mv-rm'], x: { files: srcs, arg: dest, recursive: o.f.has('r') || o.f.has('R') || o.f.has('a') } })
    }
    case 'rm':
    case 'rmdir':
    case 'unlink':
    case 'shred':
    case 'trash':
    case 'trash-put': {
      const o = parseOpts(a, '', [])
      const files = o.pos.filter(x => x !== '')
      return mk(cmd, 'file-ops', 'rm', { target: files[0], concepts: ['cp-mv-rm'], x: { files, recursive: o.f.has('r') || o.f.has('R') || o.f.has('recursive') || p === 'rmdir' } })
    }
    case 'ln': {
      const o = parseOpts(a, 'tS', ['target-directory', 'suffix'])
      return mk(cmd, 'file-ops', 'ln', { target: o.pos[o.pos.length - 1], writes: o.pos.length > 1 ? [o.pos[o.pos.length - 1] ?? ''] : [], concepts: o.f.has('s') ? ['symlinks'] : ['symlinks'], x: { files: o.pos.slice(0, -1), arg: o.pos[o.pos.length - 1] } })
    }
    case 'chmod':
    case 'chown':
    case 'chgrp': {
      const o = parseOpts(a, '', ['reference'])
      const mode = o.pos[0] ?? ''
      const files = o.pos.slice(1)
      return mk(cmd, 'file-ops', p === 'chmod' ? 'chmod' : 'chown', { target: files[0], concepts: ['chmod'], x: { files, mode } })
    }
    case 'truncate':
      return mk(cmd, 'file-ops', 'truncate', { target: a.filter(isFileArg).pop(), writes: a.filter(isFileArg).slice(-1), concepts: [], x: {} })
    case 'dd': {
      const of = a.find(x => x.startsWith('of='))?.slice(3)
      const inf = a.find(x => x.startsWith('if='))?.slice(3)
      return mk(cmd, 'file-ops', 'dd', { target: of ?? inf, writes: of ? [of] : [], reads: inf ? [inf] : [], concepts: [], x: {} })
    }
    case 'split':
    case 'csplit':
      return mk(cmd, 'file-ops', 'split', { target: a.filter(isFileArg)[0], concepts: [], x: {} })
    case 'patch': {
      const o = parseOpts(a, 'pidoiDBrFVYz', ['strip', 'input', 'directory', 'output'])
      const pf = first(o, 'i', 'input') ?? inputFile(cmd)
      return mk(cmd, 'write-file', 'patch', { target: o.pos[0] ?? pf, writes: o.pos.slice(0, 1), concepts: ['diff'], x: { arg: pf } })
    }
    case 'tar':
    case 'bsdtar':
      return tarRole(cmd)
    case 'zip':
    case 'unzip':
    case '7z':
    case '7za':
    case 'unrar':
      return zipRole(cmd)
    case 'gzip':
    case 'gunzip':
    case 'bzip2':
    case 'bunzip2':
    case 'xz':
    case 'unxz':
    case 'zstd':
    case 'unzstd':
    case 'pigz':
    case 'lz4':
    case 'brotli': {
      const o = parseOpts(a, 'SbT', ['suffix', 'threads'])
      const files = o.pos.filter(isFileArg)
      const toStdout = o.f.has('c') || o.f.has('stdout')
      const decomp = /^(gunzip|bunzip2|unxz|unzstd)$/.test(p) || o.f.has('d') || o.f.has('decompress')
      if (toStdout && decomp) return mk(cmd, 'read-file', 'zcat', { target: files[0], reads: files, filter: !files.length, concepts: ['tar-zip'], x: { files } })
      return mk(cmd, 'file-ops', 'gzip', { target: files[0], concepts: ['tar-zip'], x: { files, mode: decomp ? 'd' : 'c' } })
    }
    case 'ps':
    case 'pstree':
    case 'pgrep':
    case 'pidof':
      return psRole(cmd)
    case 'kill':
      return killRole(cmd)
    case 'pkill':
    case 'killall': {
      const o = parseOpts(a, 'usgGPtF', ['signal', 'euid', 'uid', 'group', 'parent', 'session', 'terminal', 'pidfile'])
      const sig = [...o.f].find(f => /^\d+$|^[A-Z]+$/.test(f)) ?? first(o, 's', 'signal') ?? (a.find(x => /^-\d+$|^-[A-Z]{3,}$/.test(x)) ?? '').slice(1)
      return mk(cmd, 'process', 'pkill', { name: p, query: o.pos[0], target: o.pos[0], w: 52, concepts: ['kill-signals', 'processes'], x: { sig } })
    }
    case 'top':
    case 'htop':
    case 'btop':
    case 'atop':
    case 'glances':
      return mk(cmd, 'process', 'top', { concepts: ['processes', 'cpu-memory'] })
    case 'jobs':
    case 'bg':
    case 'fg':
      return mk(cmd, 'process', 'jobs', { concepts: ['background-job'] })
    case 'lsof':
    case 'fuser': {
      const net = a.some(x => /^-i/.test(x)) || a.some(x => /^\d+\/(tcp|udp)$/.test(x))
      const port = /:(\d+)/.exec(a.join(' '))?.[1] ?? /^(\d+)\/(tcp|udp)$/.exec(a.find(x => /\/(tcp|udp)$/.test(x)) ?? '')?.[1]
      if (net) return mk(cmd, 'network', 'ports', { concepts: ['ports'], x: { port } })
      const pid = a[a.indexOf('-p') + 1]
      return mk(cmd, 'process', 'lsof', { target: pid ?? a.filter(isFileArg).pop(), concepts: ['processes'], x: { pid: a.includes('-p') ? pid : undefined } })
    }
    case 'ss':
    case 'netstat':
      return mk(cmd, 'network', 'ports', { concepts: ['ports'], x: {} })
    case 'tmux':
    case 'screen':
      return tmuxRole(cmd)
    case 'systemctl':
    case 'service':
      return systemctlRole(cmd)
    case 'journalctl': {
      const o = parseOpts(a, 'unpoSUbt', ['unit', 'lines', 'priority', 'output', 'since', 'until', 'boot', 'identifier', 'user-unit'])
      const unit = first(o, 'u', 'unit', 'user-unit')
      return mk(cmd, 'process', 'journalctl', { name: 'journalctl', target: unit, concepts: ['systemd', 'reading-logs'], x: { unit, follow: o.f.has('f') || o.f.has('follow') } })
    }
    case 'systemd-run':
      return mk(cmd, 'process', 'svc', { name: 'systemd-run', concepts: ['systemd'], x: { sub: 'run' } })
    case 'getent':
      return mk(cmd, 'network', 'dns', { name: 'getent', target: a[1], concepts: [], x: { host: a[1] } })
    case 'quota':
      return mk(cmd, 'env', 'disk', { name: 'quota', w: WEIGHT.env, concepts: ['disk-usage'], x: {} })
    case 'supervisorctl':
    case 'pm2':
      return mk(cmd, 'process', 'svc', { name: `${p} ${a[0] ?? ''}`.trim(), target: a[1], concepts: ['processes'], x: { sub: a[0], unit: a[1] } })
    case 'nohup':
    case 'setsid':
      return mk(cmd, 'process', 'jobs', { concepts: ['nohup', 'background-job'] })
    case 'ssh':
    case 'mosh':
    case 'sshpass': {
      const o = parseOpts(a, 'bcDEeFIiJLlmOopQRSWwf', [])
      const host = o.pos[0]
      return mk(cmd, 'network', 'ssh', { name: 'ssh', target: host ? hostOf(host) : undefined, concepts: ['ssh'], x: { host: host ? hostOf(host) : undefined, what: o.pos.slice(1).join(' ') } })
    }
    case 'scp':
    case 'sftp':
    case 'rsync': {
      const o = parseOpts(a, p === 'rsync' ? 'eBfT' : 'cFiJloPS', ['exclude', 'include', 'filter', 'rsh', 'rsync-path', 'partial-dir', 'temp-dir', 'compare-dest', 'link-dest', 'copy-dest', 'log-file', 'password-file', 'bwlimit', 'timeout', 'chmod', 'chown', 'max-size', 'min-size', 'exclude-from', 'include-from', 'files-from', 'info', 'debug', 'out-format', 'backup-dir', 'suffix'])
      const pos = o.pos.filter(x => x !== '')
      const dest = pos[pos.length - 1]
      const srcs = pos.slice(0, -1)
      const remote = pos.find(x => /^[^/]*:/.test(x) && !/^[a-z]+:\/\//i.test(x))
      const toRemote = dest !== undefined && dest === remote
      return mk(cmd, 'network', p === 'rsync' ? 'rsync' : 'scp', { name: p, target: dest, writes: !toRemote && dest ? [dest] : [], concepts: ['rsync-scp'], x: { host: remote ? hostOf(remote.split(':')[0] ?? '') : undefined, mode: remote ? (toRemote ? 'to' : 'from') : 'local', files: srcs, arg: dest } })
    }
    case 'ping':
    case 'ping6': {
      const o = parseOpts(a, 'cIiWwstlpQSM', [])
      return mk(cmd, 'network', 'ping', { target: o.pos[0], concepts: [], x: { host: o.pos[0] } })
    }
    case 'nc':
    case 'ncat':
    case 'netcat':
    case 'telnet': {
      const o = parseOpts(a, 'wpsiqx', [])
      return mk(cmd, 'network', 'nc', { target: o.pos[0], concepts: ['ports'], x: { host: o.pos[0], port: o.pos[1] } })
    }
    case 'dig':
    case 'nslookup':
    case 'host':
    case 'whois':
      return mk(cmd, 'network', 'dns', { target: a.find(x => !x.startsWith('-') && !x.startsWith('@') && !/^[A-Z]+$/.test(x)), concepts: [], x: { host: a.find(x => !x.startsWith('-') && !x.startsWith('@')) } })
    case 'traceroute':
    case 'tracepath':
    case 'mtr':
      return mk(cmd, 'network', 'trace', { target: a.find(x => !x.startsWith('-')), concepts: [], x: { host: a.find(x => !x.startsWith('-')) } })
    case 'ip':
    case 'ifconfig':
    case 'iwconfig':
    case 'route':
    case 'arp':
    case 'iptables':
    case 'ufw':
    case 'nft':
    case 'firewall-cmd':
      return mk(cmd, 'network', 'netif', { concepts: [], x: { sub: a[0] } })
    case 'openssl':
      if (a[0] === 's_client') return mk(cmd, 'network', 'tls', { name: 'openssl s_client', target: a[a.indexOf('-connect') + 1], concepts: [], x: { host: a[a.indexOf('-connect') + 1] } })
      return mk(cmd, 'other', 'openssl', { name: `openssl ${a[0] ?? ''}`.trim(), w: 30, concepts: [] })
    case 'nmap':
      return mk(cmd, 'network', 'ports', { target: a.filter(x => !x.startsWith('-')).pop(), concepts: ['ports'], x: { host: a.filter(x => !x.startsWith('-')).pop() } })
    case 'aws':
    case 'gcloud':
    case 'gsutil':
    case 'az':
    case 'doctl':
    case 'flyctl':
    case 'heroku':
    case 'vercel':
    case 'netlify':
    case 'wrangler':
    case 'firebase':
    case 'terraform':
    case 'pulumi':
    case 'ansible':
    case 'ansible-playbook':
      return mk(cmd, 'network', 'cloud', { name: `${p} ${a.filter(x => !x.startsWith('-')).slice(0, 2).join(' ')}`.trim(), concepts: [], x: {} })
    case 'curl':
      return curlRole(cmd)
    case 'wget':
      return wgetRole(cmd)
    case 'http':
    case 'https':
    case 'xh':
    case 'httpie': {
      const pos = a.filter(x => !x.startsWith('-'))
      const method = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i.test(pos[0] ?? '') ? (pos.shift() ?? 'GET').toUpperCase() : 'GET'
      const url = pos[0] ?? ''
      const { local, host } = urlParts(url)
      return mk(cmd, 'http', 'curl', { name: p, target: cleanUrl(url), concepts: ['http-requests', ...(local ? ['localhost'] : [])], x: { url: cleanUrl(url), local, method, host } })
    }
    case 'nvidia-smi':
      return nvidiaRole(cmd)
    case 'nvtop':
    case 'gpustat':
    case 'nvitop':
    case 'rocm-smi':
    case 'intel_gpu_top':
      return mk(cmd, 'gpu', 'nvidia-smi', { name: p, concepts: ['gpu-memory'], x: { mode: 'mem' } })
    case 'nvcc':
      return mk(cmd, 'build', 'compile', { name: 'nvcc', target: a.filter(isFileArg)[0], concepts: ['cuda'] })
    case 'ffmpeg':
      return ffmpegRole(cmd)
    case 'ffprobe':
      return ffprobeRole(cmd)
    case 'sox':
    case 'play':
    case 'rec':
    case 'soxi': {
      const files = a.filter(x => isFileArg(x) && /\.\w{2,5}$/.test(x))
      return mk(cmd, 'media', p === 'soxi' ? 'soxi' : 'sox', { name: p, target: files[0], reads: files.slice(0, p === 'soxi' ? files.length : 1), writes: p === 'sox' && files.length > 1 ? files.slice(-1) : [], concepts: ['audio-basics'], x: { files } })
    }
    case 'mediainfo':
    case 'exiftool':
    case 'identify':
      return mk(cmd, 'media', 'ffprobe', { name: p, target: a.filter(isFileArg).pop(), reads: a.filter(isFileArg), concepts: [], x: {} })
    case 'convert':
    case 'magick':
    case 'mogrify':
      return mk(cmd, 'media', 'image', { name: p, target: a.filter(isFileArg)[0], concepts: [], x: { arg: a.filter(isFileArg).pop() } })
    case 'yt-dlp':
    case 'youtube-dl':
      return mk(cmd, 'media', 'ytdl', { name: p, target: a.find(looksUrl), concepts: ['ffmpeg'], x: { url: a.find(looksUrl) } })
    case 'aplay':
    case 'afplay':
    case 'paplay':
    case 'ffplay':
    case 'mpv':
    case 'vlc':
      return mk(cmd, 'media', 'play', { name: p, target: a.filter(isFileArg).pop(), concepts: ['audio-basics'], x: {} })
    case 'lame':
    case 'flac':
    case 'opusenc':
    case 'oggenc':
    case 'opusdec':
      return mk(cmd, 'media', 'encode', { name: p, target: a.filter(isFileArg)[0], concepts: ['audio-basics'], x: {} })
    case 'docker':
    case 'podman':
    case 'nerdctl':
    case 'docker-compose':
    case 'podman-compose':
      return dockerRole(cmd)
    case 'kubectl':
    case 'helm':
    case 'k9s':
    case 'minikube':
    case 'kind':
    case 'k3d':
      return mk(cmd, 'docker', 'kube', { name: `${p} ${a.filter(x => !x.startsWith('-')).slice(0, 2).join(' ')}`.trim(), concepts: ['docker-containers'], x: { sub: a.find(x => !x.startsWith('-')) } })
    case 'sqlite3':
    case 'sqlite':
    case 'sqlite-utils':
      return sqliteRole(cmd)
    case 'psql':
    case 'pg_dump':
    case 'pg_restore':
      return sqlClientRole(cmd, 'Postgres')
    case 'mysql':
    case 'mariadb':
    case 'mysqldump':
      return sqlClientRole(cmd, 'MySQL')
    case 'duckdb':
      return mk(cmd, 'database', 'sql', { name: p, target: a.find(isFileArg), concepts: ['sql-queries'], x: { db: a.find(isFileArg), sql: sqlKind(a.join(' ') + (cmd.doc?.body ?? '')), what: 'DuckDB' } })
    case 'redis-cli':
      return mk(cmd, 'database', 'redis', { name: p, concepts: [], x: { what: 'Redis' } })
    case 'mongosh':
    case 'mongo':
      return mk(cmd, 'database', 'redis', { name: p, concepts: [], x: { what: 'MongoDB' } })
    case 'clickhouse-client':
      return mk(cmd, 'database', 'sql', { name: p, concepts: ['sql-queries'], x: { what: 'ClickHouse', sql: 'read' } })
    case 'which':
    case 'whereis':
    case 'type':
      return mk(cmd, 'env', 'which', { name: p, target: a.filter(x => !x.startsWith('-')).join(' '), concepts: ['which-path'], x: { files: a.filter(x => !x.startsWith('-')) } })
    case 'command':
      return mk(cmd, 'env', 'which', { name: 'command -v', target: a.filter(x => !x.startsWith('-')).join(' '), concepts: ['which-path'], x: { files: a.filter(x => !x.startsWith('-')) } })
    case 'env':
      return mk(cmd, 'env', 'env', { name: 'env', concepts: ['env-var'] })
    case 'python':
    case 'python3':
    case 'python2':
    case 'pypy':
    case 'pypy3':
    case 'py':
    case 'ipython':
      return pythonRole(cmd)
    case 'pip':
    case 'pip3':
    case 'pip2':
      return pipRole(cmd, a)
    case 'uv':
      return uvRole(cmd)
    case 'pipx':
    case 'poetry':
    case 'pdm':
    case 'pipenv':
    case 'hatch':
    case 'rye':
    case 'pixi': {
      const sub = a.find(x => !x.startsWith('-')) ?? ''
      if (/^(install|add|sync|lock|update|remove|uninstall|inject|upgrade)$/.test(sub)) return mk(cmd, 'install', 'install-misc', { name: `${p} ${sub}`, concepts: ['pip'], x: { what: a.filter(x => !x.startsWith('-')).slice(1).join(' ') || 'the dependencies', manager: p } })
      if (/^(build|publish)$/.test(sub)) return mk(cmd, 'build', 'build', { name: `${p} ${sub}`, concepts: [], x: { what: `${p} ${sub}` } })
      return mk(cmd, 'env', 'pip-list', { name: `${p} ${sub}`.trim(), concepts: ['pip'], x: { sub } })
    }
    case 'virtualenv': {
      const dir = a.find(x => !x.startsWith('-')) ?? '.venv'
      return mk(cmd, 'install', 'venv', { name: p, target: dir, writes: [dir], concepts: ['python-venv'], x: { dir } })
    }
    case 'conda':
    case 'mamba':
    case 'micromamba':
      return condaRole(cmd)
    case 'npm':
    case 'yarn':
    case 'pnpm':
    case 'bun':
      return npmRole(cmd)
    case 'node':
    case 'nodejs':
    case 'deno':
    case 'tsx':
    case 'ts-node':
    case 'esno':
      if (p === 'deno' && a[0] === 'test') return mk(cmd, 'test', 'test', { name: 'deno test', concepts: ['tests', 'verify-after-change'], x: { what: 'deno test' } })
      if (p === 'deno' && a[0] === 'run') return nodeRole({ ...cmd, u: { ...u, args: a.slice(1) } })
      return nodeRole(cmd)
    case 'bash':
    case 'sh':
    case 'zsh':
    case 'dash':
    case 'ksh':
    case 'fish':
      return shellScriptRole(cmd)
    case 'pytest':
    case 'py.test':
      return testRunner(cmd, 'pytest', a)
    case 'jest':
    case 'vitest':
    case 'mocha':
    case 'ava':
    case 'tap':
    case 'karma':
    case 'jasmine':
    case 'tox':
    case 'nox':
    case 'rspec':
    case 'phpunit':
    case 'ctest':
    case 'playwright':
    case 'cypress':
      if ((p === 'playwright' || p === 'cypress') && a[0] === 'install') return mk(cmd, 'install', 'install-misc', { name: `${p} install`, concepts: [], x: { what: `${p}'s browsers`, manager: p } })
      return testRunner(cmd, p, a.filter(x => x !== 'run' && x !== 'test'))
    case 'go': {
      const sub = a[0] ?? ''
      if (sub === 'test') return mk(cmd, 'test', 'test', { name: 'go test', concepts: ['tests', 'verify-after-change'], x: { what: 'go test' } })
      if (sub === 'build') return mk(cmd, 'build', 'build', { name: 'go build', concepts: [], x: { what: 'go build' } })
      if (sub === 'run') return mk(cmd, 'run-script', 'script', { name: 'go run', target: a[1], concepts: [], x: { what: 'Go', sub: undefined } })
      if (sub === 'get' || sub === 'install' || sub === 'mod') return mk(cmd, 'install', 'install-misc', { name: `go ${sub}`, concepts: [], x: { what: a.slice(1).filter(x => !x.startsWith('-')).join(' ') || 'the dependencies', manager: 'go' } })
      if (sub === 'fmt' || sub === 'vet') return mk(cmd, 'build', 'lint', { name: `go ${sub}`, concepts: ['linting'], x: { what: `go ${sub}` } })
      if (sub === 'version' || sub === 'env') return versionRole(cmd, 'Go')
      return mk(cmd, 'build', 'build', { name: `go ${sub}`.trim(), concepts: [], x: { what: `go ${sub}` } })
    }
    case 'cargo': {
      const sub = a[0] ?? ''
      if (sub === 'test') return mk(cmd, 'test', 'test', { name: 'cargo test', concepts: ['tests', 'verify-after-change'], x: { what: 'cargo test' } })
      if (sub === 'run') return mk(cmd, 'run-script', 'script', { name: 'cargo run', concepts: [], x: { what: 'Rust' } })
      if (sub === 'install' || sub === 'add' || sub === 'update' || sub === 'fetch') return mk(cmd, 'install', 'install-misc', { name: `cargo ${sub}`, concepts: [], x: { what: a.slice(1).filter(x => !x.startsWith('-')).join(' ') || 'the dependencies', manager: 'cargo' } })
      if (sub === 'clippy' || sub === 'fmt') return mk(cmd, 'build', 'lint', { name: `cargo ${sub}`, concepts: ['linting'], x: { what: `cargo ${sub}` } })
      return mk(cmd, 'build', 'build', { name: `cargo ${sub}`.trim(), concepts: [], x: { what: `cargo ${sub}` } })
    }
    case 'make':
    case 'gmake':
    case 'just':
    case 'task':
      return makeRole(cmd)
    case 'cmake':
    case 'ninja':
    case 'meson':
    case 'bazel':
    case 'buck':
    case 'gradle':
    case 'gradlew':
    case 'mvn':
    case 'ant':
    case 'sbt':
    case 'dotnet':
    case 'swift':
    case 'xcodebuild': {
      const sub = a.find(x => !x.startsWith('-')) ?? ''
      if (/^test$/.test(sub)) return mk(cmd, 'test', 'test', { name: `${p} test`, concepts: ['tests', 'verify-after-change'], x: { what: `${p} test` } })
      if (/^run$/.test(sub)) return mk(cmd, 'run-script', 'script', { name: `${p} run`, concepts: [], x: { what: p } })
      return mk(cmd, 'build', 'build', { name: `${p} ${sub}`.trim(), concepts: [], x: { what: `${p} ${sub}`.trim() } })
    }
    case 'gcc':
    case 'g++':
    case 'cc':
    case 'c++':
    case 'clang':
    case 'clang++':
    case 'rustc':
    case 'javac':
    case 'kotlinc':
    case 'swiftc':
    case 'zig':
      return mk(cmd, 'build', 'compile', { name: p, target: a.filter(x => isFileArg(x) && /\.\w+$/.test(x))[0], concepts: [], x: {} })
    case 'tsc':
    case 'vue-tsc':
    {
      const pi = a.indexOf('-p') >= 0 ? a.indexOf('-p') : a.indexOf('--project')
      return mk(cmd, 'build', a.includes('--noEmit') || a.includes('--noemit') ? 'typecheck' : 'tsc', { name: p, target: pi >= 0 ? a[pi + 1] : undefined, concepts: ['typescript', 'type-checking'], x: { what: 'tsc' } })
    }
    case 'mypy':
    case 'pyright':
    case 'basedpyright':
    case 'pyre':
      return mk(cmd, 'build', 'typecheck', { name: p, target: a.filter(isFileArg)[0], concepts: ['type-checking'], x: { what: p } })
    case 'ruff':
    case 'flake8':
    case 'pylint':
    case 'black':
    case 'isort':
    case 'prettier':
    case 'eslint':
    case 'biome':
    case 'stylelint':
    case 'shellcheck':
    case 'golangci-lint':
    case 'rubocop':
    case 'yamllint':
    case 'markdownlint':
    case 'hadolint':
    case 'gofmt':
    case 'rustfmt':
    case 'clang-format':
      return mk(cmd, 'build', /^(black|isort|prettier|gofmt|rustfmt|clang-format)$/.test(p) || (p === 'ruff' && a[0] === 'format') || a.includes('--fix') || a.includes('--write') ? 'format' : 'lint', { name: p, target: a.filter(isFileArg)[0], concepts: ['linting'], x: { what: p } })
    case 'webpack':
    case 'vite':
    case 'esbuild':
    case 'rollup':
    case 'parcel':
    case 'tsup':
    case 'swc':
    case 'babel':
    case 'next':
    case 'turbo':
    case 'nx':
    case 'hugo':
    case 'jekyll':
    case 'mkdocs':
    case 'sphinx-build':
    case 'latexmk':
    case 'pdflatex':
    case 'xelatex':
    case 'pandoc':
    case 'typst':
      if ((p === 'vite' || p === 'next') && /^(dev|start|serve|preview)?$/.test(a[0] ?? '')) return mk(cmd, 'run-script', 'npm-start', { name: `${p} ${a[0] ?? ''}`.trim(), concepts: ['localhost'], x: { what: `${p} ${a[0] ?? 'dev'}` } })
      return mk(cmd, 'build', 'build', { name: p, target: a.filter(isFileArg)[0], concepts: [], x: { what: p } })
    case 'git':
      return gitRole(cmd)
    case 'gh':
    case 'glab':
      return ghRole(cmd)
    case 'claude':
      return claudeRole(cmd)
    case 'apt':
    case 'apt-get':
    case 'dnf':
    case 'yum':
    case 'zypper':
    case 'apk':
    case 'pacman':
    case 'brew':
    case 'port':
    case 'snap':
    case 'choco':
    case 'winget':
    case 'scoop':
    case 'rpm':
    case 'dpkg':
      return sysPkgRole(cmd)
    case 'huggingface-cli':
    case 'hf': {
      const sub = a.find(x => !x.startsWith('-')) ?? ''
      const rest = a.slice(a.indexOf(sub) + 1)
      if (sub === 'download' || sub === 'upload') return mk(cmd, 'install', 'hf-download', { name: `${p} ${sub}`, target: rest.find(x => !x.startsWith('-')), concepts: ['huggingface'], x: { what: rest.find(x => !x.startsWith('-')), sub } })
      return mk(cmd, 'env', 'hf', { name: `${p} ${sub}`.trim(), concepts: ['huggingface', ...(sub === 'login' || sub === 'auth' ? ['api-tokens'] : [])], x: { sub } })
    }
    case 'ollama': {
      const sub = a[0] ?? ''
      if (sub === 'pull') return mk(cmd, 'install', 'hf-download', { name: 'ollama pull', target: a[1], concepts: ['inference'], x: { what: a[1], via: 'ollama' } })
      if (sub === 'serve') return mk(cmd, 'run-script', 'server', { name: 'ollama serve', concepts: ['inference', 'localhost'], x: { what: 'the Ollama' } })
      if (sub === 'list' || sub === 'ps') return mk(cmd, 'env', 'npm-ls', { name: `ollama ${sub}`, concepts: ['inference'], x: { sub, what: 'ollama' } })
      return mk(cmd, 'run-script', 'script', { name: `ollama ${sub}`.trim(), target: a[1], concepts: ['inference'], x: { what: 'Ollama' } })
    }
    case 'vllm':
    case 'llama-server':
    case 'text-generation-launcher':
    case 'tgi':
      return mk(cmd, 'run-script', 'server', { name: `${p} ${a[0] ?? ''}`.trim(), target: a[1] ?? a[0], concepts: ['inference', 'localhost'], x: { what: p === 'vllm' ? 'the vLLM' : `the ${p}` } })
    case 'uvicorn':
    case 'gunicorn':
    case 'hypercorn':
    case 'flask':
    case 'streamlit':
    case 'gradio':
    case 'jupyter':
    case 'tensorboard':
    case 'mlflow':
    case 'http-server':
    case 'serve':
    case 'live-server':
      return mk(cmd, 'run-script', 'server', { name: p, target: a.find(x => !x.startsWith('-')), concepts: ['localhost'], x: { what: p === 'jupyter' ? 'the Jupyter' : p === 'tensorboard' ? 'the TensorBoard' : `the ${p}` } })
    case 'accelerate':
    case 'torchrun':
    case 'deepspeed': {
      const script = a.find(x => /\.py$/.test(x))
      if (script) return scriptRole(cmd, script, a.slice(a.indexOf(script) + 1), 'Python', `${p} ${baseName(script)}`, ['python-script', 'gpu-memory'])
      return mk(cmd, 'run-script', 'script', { name: `${p} ${a[0] ?? ''}`.trim(), concepts: ['python-script'], x: { what: p } })
    }
    case 'ruby':
    case 'perl':
    case 'php':
    case 'Rscript':
    case 'julia':
    case 'lua':
    case 'java':
    case 'elixir':
    case 'scala':
    case 'kotlin':
      return otherInterpreter(cmd)
    case 'crontab':
      return mk(cmd, 'process', 'cron', { name: `crontab ${a.join(' ')}`.trim(), concepts: ['scheduling'], x: {} })
    case 'at':
    case 'batch':
      return mk(cmd, 'process', 'cron', { name: p, concepts: ['scheduling'], x: {} })
    case 'xdg-open':
    case 'open':
      return mk(cmd, 'other', 'open', { name: p, target: a.find(x => !x.startsWith('-')), w: 30, concepts: [], x: {} })
    case 'bc':
    case 'expr':
    case 'factor':
    case 'calc':
      return mk(cmd, 'other', 'calc', { name: p, w: 20, filter: cmd.pos > 0, concepts: [], x: {} })
  }
  if (SETUP_PROGS.has(p)) return mk(cmd, 'other', 'setup', { setup: true })
  const ek = own(ENV_KINDS, p)
  if (ek) {
    const arg = ek[0] === 'path' ? a.filter(x => !x.startsWith('-'))[0] : undefined
    return mk(cmd, 'env', ek[0], { name: p, w: ENV_WEIGHT[ek[0]] ?? WEIGHT.env, target: arg, concepts: ek[1].slice(), x: { arg } })
  }
  const fs = own(FILTERS, p)
  if (fs) return filterRole(cmd, fs)
  // a path-run program: ./run.sh, scripts/x.py, .venv/bin/tool
  if (u.word.includes('/') && !UNKNOWN_SKIP.test(u.word)) {
    const lang = /\.py$/.test(p) ? 'Python' : /\.(m?js|cjs)$/.test(p) ? 'Node.js' : /\.tsx?$/.test(p) ? 'TypeScript' : /\.(sh|bash)$/.test(p) ? 'shell' : ''
    const c = lang === 'Python' ? ['python-script'] : lang === 'shell' ? ['shell-basics'] : lang === 'Node.js' ? ['node-script'] : []
    return scriptRole(cmd, u.word, a, lang, p, c)
  }
  if (/\.(sh|py|js|ts|rb|pl)$/.test(p)) return scriptRole(cmd, u.word, a, '', p, [])
  if (UNKNOWN_SKIP.test(p) || p.startsWith('$')) return mk(cmd, 'other', 'unknown', { name: undefined, w: 30, concepts: [], x: {} })
  const sub = a[0] !== undefined && SUBCOMMAND.test(a[0]) ? a[0] : undefined
  return mk(cmd, 'other', 'unknown', { name: sub ? `${p} ${sub}` : p, target: a.find(x => !x.startsWith('-')), concepts: [], x: { sub } })
}

function otherInterpreter(cmd: Cmd): Role {
  const p = cmd.u.prog
  const a = cmd.u.args
  if (p === 'perl' && a.some(x => /^-[a-zA-Z]*i/.test(x)) && a.some(x => /^-[a-zA-Z]*[ep]/.test(x))) {
    const files = a.filter((x, i) => isFileArg(x) && !/^-/.test(a[i - 1] ?? '') && i > 0).slice(1)
    return mk(cmd, 'write-file', 'perl-i', { target: files[0], writes: files, concepts: ['regex'], x: { files } })
  }
  const inline = a.findIndex(x => x === '-e' || x === '-E' || x === '-r')
  if (inline >= 0) return mk(cmd, 'run-script', 'other-inline', { name: `${p} -e`, concepts: [], x: { what: p, inline: true } })
  if (p === 'java') {
    const jar = a[a.indexOf('-jar') + 1]
    if (a.includes('-jar') && jar) return scriptRole(cmd, jar, a.slice(a.indexOf('-jar') + 2), 'Java', `java -jar ${baseName(jar)}`, [])
    if (a.some(x => /^-?-?version$/.test(x))) return versionRole(cmd, 'Java')
  }
  const script = a.find(x => !x.startsWith('-'))
  if (!script) return mk(cmd, 'run-script', 'other-inline', { name: p, concepts: [], x: { what: p } })
  const lang = p === 'Rscript' ? 'R' : cap(p)
  return scriptRole(cmd, script, a.slice(a.indexOf(script) + 1), lang, `${p} ${baseName(script)}`, [])
}

function psRole(cmd: Cmd): Role {
  const p = cmd.u.prog
  const a = cmd.u.args
  if (p === 'pgrep' || p === 'pidof') {
    const o = parseOpts(a, 'ugGPsStF', ['euid', 'uid', 'group', 'parent', 'session', 'terminal', 'pidfile'])
    return mk(cmd, 'process', 'pgrep', { name: p, query: o.pos[0], target: o.pos[0], concepts: ['processes'], x: {} })
  }
  const pidI = a.findIndex(x => x === '-p' || x === '--pid' || x === 'p' || x === '-q')
  let pid = pidI >= 0 ? a[pidI + 1] : a.find(x => /^--pid=/.test(x))?.slice(6)
  const ppidI = a.findIndex(x => x === '--ppid')
  if (pid === undefined && ppidI >= 0) pid = a[ppidI + 1]
  const name = a.includes('-C') ? a[a.indexOf('-C') + 1] : undefined
  return mk(cmd, 'process', 'ps', { name: p === 'pstree' ? 'pstree' : 'ps', target: pid ?? name, concepts: ['processes'], x: { pid, q: name, sub: ppidI >= 0 ? 'children' : undefined } })
}

function tarRole(cmd: Cmd): Role {
  const a = cmd.u.args
  let letters = ''
  let file: string | undefined
  let dir: string | undefined
  const pos: string[] = []
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? ''
    if (i === 0 && /^[a-zA-Z]+$/.test(x) && !x.startsWith('-')) {
      letters += x
      if (x.includes('f')) file = a[++i]
      continue
    }
    if (/^--file=/.test(x)) file = x.slice(7)
    else if (x === '--file' || x === '-f') file = a[++i]
    else if (/^--directory=/.test(x)) dir = x.slice(12)
    else if (x === '-C' || x === '--directory') dir = a[++i]
    else if (/^--(extract|get)$/.test(x)) letters += 'x'
    else if (x === '--create') letters += 'c'
    else if (x === '--list') letters += 't'
    else if (x === '--to-stdout') letters += 'O'
    else if (/^-[a-zA-Z]+$/.test(x)) {
      letters += x.slice(1)
      if (x.endsWith('f')) file = a[++i]
    } else if (!x.startsWith('-')) pos.push(x)
  }
  const concepts = ['tar-zip']
  if (letters.includes('t')) return mk(cmd, 'list-files', 'tar-list', { name: 'tar -t', target: file, reads: file ? [file] : [], concepts, x: { arg: file } })
  if (letters.includes('x') && letters.includes('O')) return mk(cmd, 'read-file', 'tar-read', { name: 'tar -xO', target: file, reads: file ? [file] : [], concepts, x: { arg: file, files: pos } })
  if (letters.includes('x')) return mk(cmd, 'file-ops', 'tar-x', { name: 'tar -x', target: file, reads: file ? [file] : [], writes: dir ? [dir] : [], concepts, x: { arg: file, dir } })
  return mk(cmd, 'file-ops', 'tar-c', { name: 'tar -c', target: file, writes: file ? [file] : [], reads: [], concepts, x: { arg: file, files: pos } })
}

function zipRole(cmd: Cmd): Role {
  const p = cmd.u.prog
  const a = cmd.u.args
  const o = parseOpts(a, 'dxi', [])
  const files = o.pos
  if (p === 'unzip' && (o.f.has('l') || o.f.has('v') && !o.f.has('d'))) return mk(cmd, 'list-files', 'tar-list', { name: 'unzip -l', target: files[0], concepts: ['tar-zip'], x: { arg: files[0] } })
  if (p === 'unzip' && o.f.has('p')) return mk(cmd, 'read-file', 'tar-read', { name: 'unzip -p', target: files[0], concepts: ['tar-zip'], x: { arg: files[0] } })
  if (p === 'unzip' || p === 'unrar' || (/^7za?$/.test(p) && files[0] === 'x')) {
    const f = /^7za?$/.test(p) ? files[1] : files[0]
    const dir = first(o, 'd')
    return mk(cmd, 'file-ops', 'tar-x', { name: p, target: f, writes: dir ? [dir] : [], concepts: ['tar-zip'], x: { arg: f, dir } })
  }
  return mk(cmd, 'file-ops', 'tar-c', { name: p, target: files[0], writes: files.slice(0, 1), concepts: ['tar-zip'], x: { arg: files[0], files: files.slice(1) } })
}

function sysPkgRole(cmd: Cmd): Role {
  const p = cmd.u.prog
  const a = cmd.u.args
  const pos = a.filter(x => !x.startsWith('-'))
  const sub = pos[0] ?? ''
  const pkgs = pos.slice(1)
  if (p === 'rpm' || p === 'dpkg' || /^(list|search|info|show|policy|provides|whatprovides|list-installed)$/.test(sub)) return mk(cmd, 'env', 'pkg-list', { name: `${p} ${sub}`.trim(), concepts: ['package-managers'], x: { sub, manager: p } })
  if (/^(update|makecache|check-update)$/.test(sub) && !pkgs.length) return mk(cmd, 'install', 'sys-install', { name: `${p} ${sub}`, concepts: ['package-managers'], x: { sub: 'update', manager: p } })
  if (/^(upgrade|dist-upgrade|full-upgrade)$/.test(sub)) return mk(cmd, 'install', 'sys-install', { name: `${p} ${sub}`, concepts: ['package-managers'], x: { sub: 'upgrade', manager: p, pkgs } })
  if (/^(remove|purge|erase|uninstall|autoremove)$/.test(sub)) return mk(cmd, 'install', 'sys-install', { name: `${p} ${sub}`, concepts: ['package-managers'], x: { sub: 'remove', manager: p, pkgs } })
  return mk(cmd, 'install', 'sys-install', { name: `${p} ${sub}`.trim(), target: pkgs[0], concepts: ['package-managers'], x: { sub: 'install', manager: p, pkgs } })
}

function claudeRole(cmd: Cmd): Role {
  const a = cmd.u.args
  const concepts: string[] = []
  if (a.some(x => /^--(permission-mode|allowedTools|allowed-tools|disallowedTools|dangerously-skip-permissions)/.test(x))) concepts.push('permissions')
  if (a.includes('--output-format') || a.some(x => x.startsWith('--json-schema'))) concepts.push('structured-output')
  const pos = a.filter(x => !x.startsWith('-'))
  const sub = pos[0] ?? ''
  if (a.includes('--version') || a.includes('-v') || sub === 'version') return mk(cmd, 'claude', 'claude', { name: 'claude --version', concepts, x: { sub: 'version' } })
  if (a.includes('--help') || a.includes('-h')) return mk(cmd, 'claude', 'claude', { name: sub && sub !== 'help' ? `claude ${sub} --help` : 'claude --help', concepts, x: { sub: 'help', sub2: sub } })
  if (a.includes('-p') || a.includes('--print')) return mk(cmd, 'claude', 'claude', { name: 'claude -p', concepts, x: { sub: 'print' } })
  if (sub === 'plugin' || sub === 'plugins') return mk(cmd, 'claude', 'claude', { name: `claude plugin ${pos[1] ?? ''}`.trim(), target: pos[2], concepts: ['hooks-mods', ...concepts], x: { sub: 'plugin', sub2: pos[1], arg: pos[2] } })
  if (sub === 'mcp') return mk(cmd, 'claude', 'claude', { name: `claude mcp ${pos[1] ?? ''}`.trim(), target: pos[2], concepts: ['mcp', ...concepts], x: { sub: 'mcp', sub2: pos[1], arg: pos[2] } })
  return mk(cmd, 'claude', 'claude', { name: sub ? `claude ${sub}` : 'claude', concepts, x: { sub } })
}

// ===================================================================== combine

const READERS: ReadonlySet<string> = new Set(['cat', 'head', 'tail', 'tail-follow', 'zcat', 'tac', 'tr', 'nl', 'range', 'part', 'section', 'sed', 'awk', 'text', 'sort', 'cut', 'uniq', 'iconv', 'strings', 'tar-read'])
const QUERYABLE: ReadonlySet<string> = new Set(['ps', 'env', 'pip-list', 'docker-ps', 'docker-images', 'ls', 'nvidia-smi', 'ports', 'lsof', 'systemctl', 'conda-list', 'npm-ls', 'find-list', 'git-log', 'git-branch', 'git-misc', 'tar-list', 'journalctl', 'dmesg', 'pkg-list', 'du', 'tree', 'docker-ctl', 'kube', 'tmux', 'which', 'rg-files', 'compose', 'docker-logs'])
const STDOUT_OPS: ReadonlySet<string> = new Set(['>', '>>', '>|', '&>', '&>>', '>&'])

function stdoutTarget(c: Cmd): { target: string; append: boolean } | undefined {
  let out: { target: string; append: boolean } | undefined
  for (const r of c.redirs) {
    if (!STDOUT_OPS.has(r.op)) continue
    if (r.fd !== '' && r.fd !== '1') continue
    if (r.op === '>&' && /^\d*-?$/.test(r.target)) continue
    if (r.target === '' || isDevNull(r.target)) {
      out = undefined
      continue
    }
    out = { target: r.target, append: r.op.endsWith('>>') }
  }
  return out
}

function groupPipelines(roles: Role[]): void {
  const pipes = new Map<number, Role[]>()
  for (const r of roles) {
    const a = pipes.get(r.cmd.pipe)
    if (a) a.push(r)
    else pipes.set(r.cmd.pipe, [r])
  }
  for (const stages of pipes.values()) {
    stages.sort((x, y) => x.cmd.pos - y.cmd.pos)
    let h = 0
    while (h < stages.length - 1 && (stages[h]?.feeder || stages[h]?.setup)) {
      const s = stages[h]
      if (s) s.label = true
      h++
    }
    const head = stages[h]
    if (!head) continue
    for (let k = h + 1; k < stages.length; k++) {
      const s = stages[k]
      if (!s) continue
      if (s.cmd.u.wrap.includes('xargs')) {
        // find … | xargs grep / rm: one search or one delete over the files found
        if ((head.kind === 'find-name' || head.kind === 'find-list') && s.kind === 'grep' && s.query !== undefined) {
          s.pager = true
          head.cat = 'search'
          head.w = WEIGHT.search
          head.kind = 'find-grep'
          head.x = { ...head.x, glob: head.x.glob, ere: s.x.ere, list: s.x.list, count: s.x.count }
          head.where = head.where ?? head.target ?? '.'
          head.query = s.query
          head.target = s.query
          head.concepts = uniq(s.concepts.concat(head.concepts))
          continue
        }
        if ((head.kind === 'find-name' || head.kind === 'find-list') && s.kind === 'rm') {
          s.pager = true
          head.cat = 'file-ops'
          head.w = WEIGHT['file-ops']
          head.kind = 'find-delete'
          head.where = head.where ?? head.target ?? '.'
          head.concepts = uniq(head.concepts.concat('cp-mv-rm'))
          continue
        }
        s.filter = false
        s.x.input = 'xargs'
        continue
      }
      if ((s.filter && PAGER_PROGS.has(s.prog)) || (s.filter && s.kind === 'jq') || s.kind === 'calc') {
        s.pager = true
        absorbPager(head, s, stages.slice(k + 1))
      } else if (head.cat === 'http' && (s.kind === 'sh-inline' || s.kind === 'py-inline' || s.kind === 'js-inline')) {
        s.pager = true
        if (s.kind === 'sh-inline') {
          // curl … | sh: an install script
          head.cat = 'install'
          head.w = WEIGHT.install
          head.kind = 'curl-sh'
        } else head.concepts.push('json')
      }
    }
    // a stdout redirect into a real file turns a light pipeline into a write
    let out: { target: string; append: boolean } | undefined
    for (const s of stages) out = stdoutTarget(s.cmd) ?? out
    if (out) {
      head.writes.push(out.target)
      const light = head.feeder || head.label || head.cat === 'read-file' || head.cat === 'search' || head.cat === 'list-files' || head.cat === 'env' || (head.cat === 'other' && !head.setup)
      if (light && !head.setup) {
        const doc = head.cmd.doc !== null && head.kind === 'print' ? head.cmd.doc : null
        const lines = doc ? doc.body.split('\n').length : 0
        const flavour = head.kind === 'truncate-out' ? 'truncate' : head.kind === 'group-out' ? 'group' : undefined
        head.cat = 'write-file'
        head.w = lines >= 5 ? 85 : WEIGHT['write-file']
        head.kind = doc ? 'heredoc-write' : 'redirect-write'
        head.x.sub = flavour
        head.target = out.target
        head.feeder = false
        head.label = false
        head.filter = false
        head.x = { ...head.x, append: out.append, arg: out.target, lines }
        head.concepts = doc ? ['heredoc', 'redirect'] : ['redirect', ...head.concepts]
      }
    } else if (head.feeder && stages.length === 1) head.label = true
  }
}

function absorbPager(head: Role, s: Role, after: readonly Role[]): void {
  if (s.kind === 'grep' && s.query !== undefined && !s.x.invert) {
    if (READERS.has(head.kind) && head.target !== undefined && head.cat === 'read-file') {
      head.cat = 'search'
      head.w = WEIGHT.search
      head.where = head.target
      head.x = { ...head.x, ere: s.x.ere, count: s.x.count || after.some(a => a.prog === 'wc'), files: [head.target] }
      head.query = s.query
      head.target = s.query
      head.kind = 'grep-in'
      head.concepts = s.concepts.concat(head.concepts)
      return
    }
    if (QUERYABLE.has(head.kind) && head.x.q === undefined && head.prog !== 'grep') {
      head.x.q = s.query
      head.x.qEre = s.x.ere
    }
  }
  // cat f | tail -30 reads like tail -30 f
  if (head.kind === 'cat' && head.x.files?.length === 1 && (s.prog === 'head' || s.prog === 'tail') && !s.x.follow) {
    head.kind = s.prog
    head.x = { ...head.x, n: s.x.n, from: s.x.from, bytes: s.x.bytes }
    head.concepts = uniq(['head-tail', ...head.concepts])
  }
  if (s.prog === 'uniq' && s.cmd.u.args.some(a => /^-[a-zA-Z]*c/.test(a)) && head.cat === 'read-file') head.x.sub = 'count-uniq'
  if (s.prog === 'wc') head.x.count = true
}

function isPolling(L: Loop): boolean {
  if (!L.sleeps.length) return false
  if (L.kind === 'while' || L.kind === 'until') return true
  return L.breaks > 0
}

/** What a polling loop waits for, from its condition (while/until) or its break guards (for). */
function pollRole(L: Loop, roleOf: (c: Cmd) => Role | undefined): Role | undefined {
  const anchor = L.cond[0] ?? L.body[0]
  if (!anchor) return undefined
  const probes: { cmd: Cmd; ends: boolean }[] = []
  for (const c of L.cond) {
    if (c.condOf !== L) continue
    const endsWhenTrue = L.kind === 'until' ? !c.neg : c.neg
    probes.push({ cmd: c, ends: endsWhenTrue })
  }
  for (const g of L.guards) for (const c of g.cmds) probes.push({ cmd: c, ends: c.neg ? !g.ends : g.ends })
  const secs = Math.max(0, ...L.sleeps.filter(s => Number.isFinite(s)))
  let what: string | undefined
  let target: string | undefined
  const concepts = ['polling-loop', 'monitoring']
  // the condition or break guard first; else any recognisable check in the loop (st=$(sqlite3 …); [ "$st" = x ] && break)
  const fallback = L.body.filter(c => c.u.prog !== 'sleep' && c.u.prog !== 'echo' && c.u.prog !== 'printf' && !probes.some(p => p.cmd === c)).map(c => ({ cmd: c, ends: true }))
  for (const pr of probes.concat(fallback)) {
    const found = probeText(pr.cmd, pr.ends, roleOf)
    if (found) {
      what = found.what
      target = found.target
      concepts.push(...found.concepts)
      break
    }
  }
  return {
    cat: 'wait',
    w: 96,
    kind: 'poll',
    prog: L.kind,
    name: `${L.kind} loop`,
    target,
    reads: [],
    writes: [],
    concepts,
    x: { what, secs: secs > 0 ? secs : undefined },
    cmd: anchor,
  }
}

function logLabel(f: string): string {
  const b = baseName(f)
  const m = /^([A-Za-z][\w-]{0,20})\.log$/.exec(b)
  return m ? `the ${m[1]?.replace(/[_-]/g, ' ')} log` : showPath(f, false)
}

function probeText(c: Cmd, ends: boolean, roleOf: (c: Cmd) => Role | undefined): { what: string; target?: string; concepts: string[] } | undefined {
  const r = roleOf(c)
  const p = c.u.prog
  const a = c.u.args
  // [ -s F ] / [ -f F ] / test -e F, and [ "$(grep -c X F)" -ge N ]
  if (p === '[' || p === '[[' || p === 'test') {
    for (const s of c.subs) {
      const t = probeText(s, ends, roleOf)
      if (t) return t
    }
    const fi = a.findIndex(x => /^-[sfedrwxL]$/.test(x))
    if (fi >= 0) {
      const f = a[fi + 1] ?? ''
      const negated = a[fi - 1] === '!'
      const appear = negated ? !ends : ends
      if (f && !/^\$\(\(/.test(f)) return { what: `${showPath(f)} to ${appear ? 'appear' : 'disappear'}`, target: f, concepts: [] }
    }
    return undefined
  }
  if (r && (r.kind === 'grep' || r.kind === 'grep-in') && r.query !== undefined) {
    const f = r.where ?? r.x.files?.[0]
    const q = showQuery(r.query, r.x.ere === true)
    if (f && f !== '.') return { what: `${logLabel(f)} to ${ends ? 'say' : 'stop saying'} ${q}`, target: f, concepts: ['reading-logs'] }
    return { what: `the output to ${ends ? 'show' : 'stop showing'} ${q}`, concepts: [] }
  }
  if (p === 'kill' && r?.kind === 'kill-0') return { what: `${pidLabel(r.x.pid)} to ${ends ? 'start' : 'finish'}`, target: r.x.pid, concepts: ['processes'] }
  if (p === 'pgrep' || p === 'pidof' || (p === 'ps' && r?.x.pid)) {
    const who = p === 'ps' ? pidLabel(r?.x.pid) : quote(r?.query ?? '', 28)
    return { what: `${who} to ${ends ? 'start' : 'finish'}`, target: r?.query ?? r?.x.pid, concepts: ['processes'] }
  }
  if (r && r.cat === 'http' && r.x.url) return { what: `${showUrl(r.x.url, 44)} to ${ends ? 'respond' : 'go down'}`, target: r.x.url, concepts: ['curl', ...(r.x.local ? ['localhost'] : [])] }
  if (p === 'nc' && r) return { what: r.x.port ? `port ${r.x.port} to open` : 'the port to open', concepts: ['ports'] }
  if (p === 'nvidia-smi') return { what: 'the GPU to free up', concepts: ['nvidia-smi', 'gpu-memory'] }
  if (r && r.cat === 'docker') return { what: `container ${r.target ?? ''} to be ready`.replace('container  ', 'the container '), target: r.target, concepts: ['docker-containers'] }
  if (r && (r.kind === 'tail' || r.kind === 'cat') && r.target) return { what: `${logLabel(r.target)} to change`, target: r.target, concepts: ['reading-logs'] }
  if (r && r.cat === 'database') return { what: r.x.db ? `the database ${baseName(tidy(r.x.db))} to change` : 'the database to change', target: r.x.db, concepts: r.kind === 'sqlite' ? ['sqlite'] : ['sql-queries'] }
  for (const s of c.subs) {
    const t = probeText(s, ends, roleOf)
    if (t) return t
  }
  return undefined
}

// ===================================================================== words

function fileList(files: readonly string[], n = 3): string {
  const shown = uniq(files.map(f => showPath(f, false)).filter(Boolean))
  if (shown.length > n) return `${shown.length} files`
  return listOf(shown, n)
}

function rangeText(r: { a: number; b?: number; toEnd?: boolean }): string {
  if (r.toEnd) return `from line ${r.a}`
  if (r.b === undefined || r.b <= r.a) return `line ${r.a}`
  return `lines ${r.a}–${r.b}`
}

/** A role's target for words: loop items spelled out, unknown values dropped ('' then). */
function targetText(r: Role, t: string | undefined, dir?: boolean): string {
  if (t === undefined) return ''
  const items = r.x.loopItems
  const first = items?.[0]
  if (items && items.length > 1 && first && t.includes(first)) {
    const shown = uniq(items.map(i => showPath(t.split(first).join(i), dir)).filter(Boolean))
    if (shown.length > 1) return shown.length <= 3 ? listOf(shown, 3) : `${shown.length} ${dir ? 'folders' : 'files'}`
  }
  const s = showPath(t, dir)
  if (s !== '' && r.x.loopN && r.x.loopN > 1 && !items) return `${s} (and ${r.x.loopN - 1} more)`
  return s
}

const VERB_ING: Readonly<Record<string, string>> = {
  start: 'Starting', stop: 'Stopping', restart: 'Restarting', reload: 'Reloading', kill: 'Killing', rm: 'Removing', pause: 'Pausing',
  unpause: 'Resuming', enable: 'Enabling', disable: 'Disabling', status: 'Checking', show: 'Checking', inspect: 'Inspecting', wait: 'Waiting for',
  top: 'Checking the processes in', port: 'Checking the ports of', stats: 'Checking the resource use of', cp: 'Copying files with', diff: 'Checking the changes in',
  attach: 'Attaching to', cat: 'Reading the unit file of', mask: 'Masking', unmask: 'Unmasking',
}

const MEDIA_FORMAT: Readonly<Record<string, string>> = {
  wav: 'WAV', mp3: 'MP3', flac: 'FLAC', m4a: 'M4A', aac: 'AAC', ogg: 'Ogg', opus: 'Opus', mp4: 'MP4', mkv: 'MKV', webm: 'WebM', mov: 'MOV',
  png: 'PNG', jpg: 'JPEG', jpeg: 'JPEG', gif: 'GIF', avi: 'AVI', pcm: 'raw PCM', raw: 'raw audio',
}

function grepHeadline(r: Role, T: (t: string | undefined, f: string, dir?: boolean) => string): string {
  const x = r.x
  const ere = x.ere === true
  const files = (r.where ?? '').split(' ').filter(Boolean)
  const fromX = r.cmd.u.wrap.includes('xargs') || x.input === 'xargs'
  let where = ''
  if (r.where !== undefined) {
    if (files.length > 1) where = fileList(files)
    else if (x.glob && r.kind !== 'find-grep') where = `the ${x.glob} files in ${T(r.where, 'the current folder', true)}`
    else where = T(r.where, '')
  } else if (fromX) where = 'the listed files'
  const inW = where ? ` in ${where}` : ''
  if (r.query === '') return x.count ? `Counting lines${inW}` : `Listing lines${inW}`
  const alts = r.query !== undefined ? patternAlts(r.query, ere) : []
  const q = r.query !== undefined ? showQuery(r.query, ere) : quote('')
  const qShort = alts.length > 2 ? `${quote(alts[0] ?? '', 26)} and ${alts.length - 1} more` : q
  const intent = r.query !== undefined ? patternIntent(r.query, ere) : undefined
  const opts = (f: (qq: string, w: string) => string): string => firstFit([f(q, inW), f(qShort, inW), f(qShort, '')])
  if (intent && !x.invert && !x.count && !x.quiet && !x.list) {
    if (intent === 'errors' || intent === 'to-do notes') return `Looking for ${intent}${inW}`
    return firstFit([`Listing the ${intent}${inW}`, `Listing the ${intent}`])
  }
  if (x.invert) return opts((qq, w) => `Filtering out ${qq}${w ? ' from' + w.slice(3) : ''}`)
  if (x.quiet) return firstFit([`Checking whether ${where || 'the input'} mentions ${q}`, `Checking whether ${where || 'the input'} mentions ${qShort}`, `Checking for ${qShort}`])
  if (x.count) return opts((qq, w) => `Counting lines matching ${qq}${w}`)
  if (r.kind === 'find-grep') {
    const dir = T(r.where ?? '.', 'the current folder', true)
    const fs = x.glob ? `the ${x.glob} files` : 'files'
    if (x.list) return firstFit([`Finding ${fs} in ${dir} that mention ${q}`, `Finding ${fs} that mention ${qShort}`])
    return firstFit([`Searching ${fs} in ${dir} for ${q}`, `Searching ${fs} in ${dir} for ${qShort}`, `Searching ${fs} for ${qShort}`])
  }
  if (x.list) return opts((qq, w) => `Finding files that mention ${qq}${w}`)
  if (!where) return firstFit([`Searching the output for ${q}`, `Searching the output for ${qShort}`])
  return opts((qq, w) => `Searching for ${qq}${w}`)
}

function roleHeadline(r: Role): string {
  const x = r.x
  const t = r.target
  /** a target for words, or `fallback` when unknown */
  const T = (v: string | undefined, fallback: string, dir?: boolean): string => {
    const s = targetText(r, v, dir)
    return s === '' ? fallback : s
  }
  switch (r.kind) {
    case 'cat':
    case 'zcat':
    case 'tac':
    case 'nl':
      if (x.files && x.files.length > 1) return `Reading ${fileList(x.files)}`
      if (x.sub === 'count-uniq') return `Counting how often each line appears in ${T(t, 'the input')}`
      return t ? `Reading ${r.kind === 'zcat' ? 'the compressed file ' : ''}${T(t, 'a file', false)}` : 'Reading the input'
    case 'head':
    case 'tail': {
      const f = T(t, 'the input', false)
      if (x.from !== undefined) return `Reading ${f} from line ${x.from}`
      const n = x.n ?? 10
      const unit = x.bytes ? 'bytes' : 'lines'
      const end = r.kind === 'head' ? 'first' : 'last'
      return `Reading the ${end} ${n === 1 ? (x.bytes ? 'byte' : 'line') : `${n} ${unit}`} of ${f}`
    }
    case 'tail-follow':
      return `Following new lines in ${t ? logLabel(t) : 'the output'}`
    case 'range': {
      const f = T(t, 'the file', false)
      const rs = x.ranges ?? []
      if (rs.length === 1 && rs[0]) return `Reading ${rangeText(rs[0])} of ${f}`
      if (rs.length === 2 && rs[0] && rs[1]) return `Reading ${rangeText(rs[0])} and ${rangeText(rs[1]).replace(/^lines? /, '')} of ${f}`
      return `Reading ${rs.length} parts of ${f}`
    }
    case 'section':
      return x.section ? `Reading the ${quote(patternAlts(x.section, false)[0] ?? x.section, 24)} part of ${T(t, 'the file', false)}` : `Reading part of ${T(t, 'the file', false)}`
    case 'part':
      return `Reading part of ${T(t, 'the file', false)}`
    case 'sed':
      return t ? `Running sed over ${T(t, 'the file', false)}` : 'Reshaping text with sed'
    case 'awk':
      return t ? `Processing ${T(t, 'the file', false)} with awk` : 'Processing text with awk'
    case 'wc': {
      const what = x.sub === 'w' ? 'words' : x.sub === 'c' ? 'bytes' : x.sub === 'm' ? 'characters' : 'lines'
      if (x.files && x.files.length > 1) return `Counting ${what} in ${fileList(x.files)}`
      return `Counting ${what} in ${T(t, 'the input', false)}`
    }
    case 'jq':
      return t ? `Querying ${T(t, 'a JSON file', false)} with ${r.prog === 'jq' ? 'jq' : r.prog === 'yq' ? 'yq' : 'Python'}` : 'Formatting JSON'
    case 'diff': {
      const fs = x.files ?? []
      if (fs.length >= 2) {
        const [a, b] = showTwo(fs[0] ?? '', fs[1] ?? '')
        return a && b ? `Comparing ${a} with ${b}` : 'Comparing two outputs'
      }
      return t ? `Comparing ${T(t, 'files', false)}` : 'Comparing two outputs'
    }
    case 'stat':
      return `Checking details of ${T(t, 'a file')}`
    case 'hex':
      return `Looking at the raw bytes of ${T(t, 'the input', false)}`
    case 'checksum':
      if (x.sub === 'check') return `Verifying checksums from ${T(t, 'a list', false)}`
      return `Computing the checksum of ${x.files && x.files.length > 1 ? fileList(x.files) : T(t, 'the input', false)}`
    case 'strings':
      return `Pulling readable text out of ${T(t, 'the input', false)}`
    case 'base64':
      return x.sub === 'decode' ? `Decoding base64${t ? ' from ' + T(t, 'the input', false) : ''}` : `Encoding ${T(t, 'the input', false)} as base64`
    case 'sort':
    case 'uniq':
    case 'cut':
    case 'tr':
    case 'paste':
    case 'column':
    case 'rev':
    case 'fold':
    case 'join':
    case 'iconv': {
      if (x.sub === 'count-uniq') return `Counting how often each value appears in ${T(t, 'the input', false)}`
      const verb: Readonly<Record<string, string>> = { sort: 'Sorting', uniq: 'Finding repeated lines in', cut: 'Cutting columns from', tr: 'Translating characters in', paste: 'Joining lines of', column: 'Lining up', rev: 'Reversing lines of', fold: 'Reformatting', join: 'Joining', iconv: 'Converting the encoding of' }
      return `${verb[r.kind] ?? 'Processing'} ${T(t, 'the input', false)}`
    }
    case 'tar-read':
      return `Reading a file inside ${T(t, 'an archive', false)}`
    case 'tee':
      return x.append ? `Appending to ${T(t, 'a file', false)}` : `Writing ${T(t, 'a file', false)}`
    case 'grep':
    case 'grep-in':
    case 'find-grep':
      return grepHeadline(r, T)
    case 'rg-files':
      return `Listing the files in ${T(t ?? '.', 'the current folder', true)}`
    case 'find-name': {
      const w = r.where?.split(' ')[0]
      const where = w === undefined ? '' : w === '.' ? ' in the current folder' : ` in ${T(w, 'a folder', true)}`
      const q = (r.query ?? '').split(' or ').filter(Boolean)
      return `Searching for files named ${q.length > 1 ? `${quote(q[0] ?? '', 20)} or ${quote(q[1] ?? '', 20)}` : quote(q[0] ?? '')}${where}`
    }
    case 'find-list':
      return x.q !== undefined ? `Looking for ${quote(x.q)} under ${T(t ?? '.', 'a folder', true)}` : `Listing ${x.type === 'd' ? 'folders' : 'files'} under ${T(t ?? '.', 'a folder', true)}`
    case 'find-delete':
      return `Deleting ${x.glob ? `files named ${quote(x.glob)}` : 'the files found'} in ${T(r.where?.split(' ')[0] ?? '.', 'a folder', true)}`
    case 'find-edit':
      return `Editing files named ${quote(x.glob ?? '*')} in place`
    case 'find-exec':
      return `Running ${x.sub ?? 'a command'} on files named ${quote(x.glob ?? '*')}`
    case 'ls': {
      const fs = x.files ?? ['.']
      const f = fs[0] ?? '.'
      if (x.q !== undefined) return `Looking for ${quote(patternAlts(x.q, x.qEre === true)[0] ?? x.q)} in ${T(f, 'a folder', true)}`
      if (x.count) return `Counting the files in ${T(f, 'a folder', true)}`
      if (fs.length > 1) {
        const dirs = fs.filter(d => looksDir(d))
        const shown = uniq(fs.map(d => showPath(d, looksDir(d))).filter(Boolean))
        if (shown.length > 3) return dirs.length === fs.length ? `Listing ${shown.length} folders` : `Checking ${shown.length} files and folders`
        return dirs.length === fs.length ? `Listing files in ${listOf(shown, 3)}` : `Checking ${listOf(shown, 3)}`
      }
      if (/[*?]/.test(baseName(f))) return `Listing ${showPath(f, false) || 'matching files'}`
      if (!looksDir(f)) return `Checking ${T(f, 'a file', false)}`
      return x.recursive ? `Listing all files under ${T(f, 'a folder', true)}` : `Listing files in ${T(f, 'a folder', true)}`
    }
    case 'tree':
      return `Showing the folder tree of ${T(t ?? '.', 'a folder', true)}`
    case 'du':
      return x.files && x.files.length > 1 ? `Checking how much space ${listOf(uniq(x.files.map(f => showPath(f)).filter(Boolean)), 2)} use` : `Checking how much space ${T(t ?? '.', 'it', undefined)} uses`
    case 'heredoc-write':
    case 'redirect-write':
      if (x.append) return `Appending to ${T(t, 'a file', false)}`
      if (x.sub === 'truncate') return `Emptying ${T(t, 'a file', false)}`
      return `Writing ${T(t, 'a file', false)}`
    case 'sed-i':
      return `Editing ${x.files && x.files.length > 1 ? fileList(x.files) : T(t, 'files', false)} in place with sed`
    case 'perl-i':
      return `Editing ${T(t, 'files', false)} in place with perl`
    case 'patch':
      return `Applying a patch${t ? ' to ' + T(t, 'files', false) : ''}`
    case 'cp':
    case 'mv': {
      const srcs = x.files ?? []
      const verb = r.kind === 'mv' ? 'Moving' : 'Copying'
      if (r.concepts.includes('backups') && srcs.length === 1) return `Backing up ${T(srcs[0], 'a file')}`
      const dest = x.arg ?? ''
      const src0 = srcs[0] ?? ''
      if (srcs.length === 1 && r.kind === 'mv' && dest && baseName(src0) !== baseName(dest) && src0.replace(/[^/]*$/, '') === dest.replace(/[^/]*$/, '') && !looksDir(dest)) return `Renaming ${T(src0, 'a file')} to ${baseName(dest)}`
      const destDir = looksDir(dest) || (srcs.length === 1 && baseName(src0) === baseName(dest))
      const destText = destDir ? T(dest.endsWith('/') || looksDir(dest) ? dest : dest.replace(/\/[^/]*$/, '') || '.', 'a folder', true) : T(dest, 'a new place')
      const what = srcs.length > 1 ? (fileList(srcs).match(/^\d+ files$/) ? `${srcs.length} files` : fileList(srcs)) : T(src0, 'files')
      return `${verb} ${what} ${destDir ? 'into' : 'to'} ${destText}`
    }
    case 'rm': {
      const fs = x.files ?? []
      if (fs.length > 1) return `Deleting ${fileList(fs)}`
      const f = fs[0] ?? ''
      const isD = x.recursive && looksDir(f)
      const s = T(f, '', isD ? true : undefined)
      return s ? `Deleting ${isD ? 'the folder ' : ''}${s}` : 'Deleting files'
    }
    case 'mkdir':
      return x.files && x.files.length > 1 ? `Creating ${plural(x.files.length, 'folder')}` : `Creating the folder ${T(t, 'a new folder', true)}`
    case 'touch':
      return x.files && x.files.length > 1 ? `Creating ${x.files.length} empty files` : `Creating an empty file ${T(t, '', false)}`.trim()
    case 'chmod':
      return /\+x|^[0-7]?7[0-7]{2}$/.test(x.mode ?? '') ? `Making ${x.files && x.files.length > 1 ? fileList(x.files) : T(t, 'files', false)} executable` : `Changing the permissions of ${T(t, 'files')}`
    case 'chown':
      return `Changing the owner of ${T(t, 'files')}`
    case 'ln': {
      if (!x.arg) return 'Creating a link'
      const [link, to] = showTwo(x.arg, x.files?.[0] ?? '')
      return to ? `Linking ${link || 'a name'} to ${to}` : `Creating the link ${link}`
    }
    case 'truncate':
      return `Resizing ${T(t, 'a file', false)}`
    case 'dd':
      return `Copying raw data${t ? ' to ' + T(t, 'a file', false) : ''}`
    case 'split':
      return `Splitting ${T(t, 'a file', false)} into pieces`
    case 'tar-list':
      return `Listing what is inside ${T(t, 'the archive', false)}`
    case 'tar-x':
      return `Unpacking ${T(t, 'an archive', false)}${x.dir && showPath(x.dir, true) ? ' into ' + showPath(x.dir, true) : ''}`
    case 'tar-c': {
      const what = x.files && x.files.length ? listOf(uniq(x.files.map(f => showPath(f)).filter(Boolean)), 2) : ''
      return t ? `Packing ${what || 'files'} into ${T(t, 'an archive', false)}` : 'Packing files into an archive'
    }
    case 'gzip':
      return `${x.mode === 'd' ? 'Decompressing' : 'Compressing'} ${T(t, 'files', false)}`
    case 'make-clean':
      return `Cleaning up build files (${r.name ?? 'make clean'})`
    case 'init':
      return `Creating a new project (${r.name ?? ''})`
    case 'ps':
      if (x.pid) return x.sub === 'children' ? `Checking the child processes of ${pidLabel(x.pid)}` : `Checking ${pidLabel(x.pid)}`
      if (x.q !== undefined) return `Looking for running processes matching ${quote(patternAlts(x.q, x.qEre === true)[0] ?? x.q)}`
      return r.prog === 'pstree' || r.name === 'pstree' ? 'Showing the tree of running processes' : 'Listing running processes'
    case 'pgrep':
      return `Looking for processes matching ${quote(r.query ?? '')}`
    case 'kill': {
      const force = /^(9|KILL|SIGKILL)$/.test(x.sig ?? '')
      const verb = force ? 'Force-stopping' : x.sig && !/^(15|TERM|SIGTERM)$/.test(x.sig) ? `Sending ${x.sig} to` : 'Stopping'
      return `${verb} ${pidLabel(x.pid)}`
    }
    case 'kill-0':
      return `Checking whether ${pidLabel(x.pid)} is still running`
    case 'kill-list':
      return 'Listing the signals kill can send'
    case 'pkill':
      return `${/^(9|KILL|SIGKILL)$/.test(x.sig ?? '') ? 'Force-stopping' : 'Stopping'} processes matching ${quote(r.query ?? '')}`
    case 'top':
      return 'Checking what is using the CPU and memory'
    case 'jobs':
      return r.prog === 'nohup' || r.prog === 'setsid' ? 'Starting a job in the background' : 'Checking background jobs'
    case 'lsof':
      return x.pid ? `Checking which files ${pidLabel(x.pid)} has open` : t ? `Checking which processes have ${T(t, 'it')} open` : 'Checking open files'
    case 'ports':
      return x.port ? `Checking what is listening on port ${x.port}` : x.q !== undefined ? `Checking network connections matching ${quote(x.q)}` : 'Checking which ports are in use'
    case 'tmux': {
      const n = x.name ? ` ${quote(x.name, 24)}` : ''
      const tool = r.prog === 'screen' ? 'screen' : 'tmux'
      switch (x.sub) {
        case 'new': return `Starting the ${tool} session${n}`
        case 'ls': return `Listing ${tool} sessions`
        case 'attach': return `Attaching to the ${tool} session${n}`
        case 'kill': return `Closing the ${tool} session${n}`
        case 'send': return `Typing a command into the ${tool} session${n}`
        case 'capture': return `Reading the screen of the ${tool} session${n}`
        case 'has': return `Checking whether the ${tool} session${n} exists`
        default: return `Managing ${tool} sessions`
      }
    }
    case 'systemctl': {
      const unit = x.unit ? `the service ${x.unit}` : 'the services'
      const sub = x.sub ?? ''
      if (/^(list-units|list-unit-files|list-timers)$/.test(sub)) return 'Listing services'
      if (sub === 'daemon-reload') return "Reloading systemd's service files"
      if (sub === 'is-active' || sub === 'is-enabled' || sub === 'is-failed') return `Checking whether ${unit} is ${sub.slice(3)}`
      const v = own(VERB_ING, sub)
      if (v) return `${v} ${sub === 'cat' ? unit.replace('the service ', '') : unit}`
      return `Managing ${unit} (systemctl ${sub})`
    }
    case 'journalctl':
      return x.unit ? `${x.follow ? 'Following' : 'Reading'} the logs of service ${x.unit}` : 'Reading the system logs'
    case 'svc':
      return x.sub === 'run' ? 'Running a command as a systemd service (systemd-run)' : `Managing services with ${r.name ?? r.prog}`
    case 'cron':
      return /-l/.test(r.name ?? '') ? 'Listing scheduled jobs' : 'Scheduling a job'
    case 'ssh':
      return x.what ? `Running a command on ${x.host ?? 'another machine'} over SSH` : `Connecting to ${x.host ?? 'another machine'} over SSH`
    case 'scp':
    case 'rsync':
      if (x.mode === 'to') return `Copying files to ${x.host}`
      if (x.mode === 'from') return `Copying files from ${x.host}`
      return `Syncing ${x.files && x.files.length ? listOf(uniq(x.files.map(f => showPath(f)).filter(Boolean)), 2) || 'files' : 'files'} to ${T(x.arg, 'another folder')}`
    case 'ping':
      return `Pinging ${x.host ?? 'a host'}`
    case 'nc':
      return `Checking whether ${x.host ?? 'a host'}${x.port ? ':' + x.port : ''} is reachable`
    case 'dns':
      return x.host ? `Looking up ${x.host} in DNS` : 'Looking up a name in DNS'
    case 'trace':
      return `Tracing the network route to ${x.host ?? 'a host'}`
    case 'netif':
      return 'Checking the network setup'
    case 'tls':
      return `Checking the TLS certificate of ${x.host ?? 'a server'}`
    case 'cloud':
      return `Running ${r.name ?? r.prog}`
    case 'curl': {
      const u = x.url ? showUrl(x.url) : ''
      if (!u) return 'Making an HTTP request'
      if (x.status) return `Checking the HTTP status of ${u}`
      if (x.method && x.method !== 'GET' && x.method !== 'HEAD') return `Sending a ${x.method} request to ${u}`
      return x.local ? `Calling ${u}` : `Fetching ${u}`
    }
    case 'download': {
      const f = x.arg && !isDevNull(x.arg) ? showPath(x.arg, false) : ''
      const host = x.url ? urlParts(x.url).hostport : ''
      return f ? `Downloading ${f}${host ? ' from ' + tidy(host) : ''}` : `Downloading ${x.url ? showUrl(x.url) : 'a file'}`
    }
    case 'curl-sh':
      return `Running an install script from ${x.url ? tidy(urlParts(x.url).hostport) : 'the web'}`
    case 'nvidia-smi':
      switch (x.mode) {
        case 'apps': return 'Checking which processes use the GPU'
        case 'list': return 'Listing the GPUs'
        case 'watch': return 'Watching GPU usage'
        case 'topo': return 'Checking how the GPUs are connected'
        case 'full': return "Reading the GPU's full status"
        case 'clocks': return "Checking the GPU's clocks, power and temperature"
        default: return x.secs ? `Watching GPU memory and usage every ${showDuration(x.secs)}` : 'Checking GPU memory and usage'
      }
    case 'ffmpeg': {
      const ins = (x.files ?? []).filter(f => showPath(f, false) !== '')
      const i = ins[0] ? showPath(ins[0], false) : (x.files ?? []).length ? 'each file' : 'media'
      if (x.mode === 'info') return 'Checking what ffmpeg supports'
      if (x.mode === 'analyze') return `Analyzing ${i} with ffmpeg`
      if (ins.length > 1) return `Combining ${ins.length} files with ffmpeg`
      const outExt = /\.([A-Za-z0-9]{2,5})$/.exec(x.arg ?? '')?.[1]?.toLowerCase()
      const inExt = /\.([A-Za-z0-9]{2,5})$/.exec(ins[0] ?? '')?.[1]?.toLowerCase()
      const fmt = own(MEDIA_FORMAT, outExt)
      if (fmt && outExt !== inExt) return `Converting ${i} to ${fmt} with ffmpeg`
      return x.arg ? `Processing ${i} with ffmpeg` : `Converting ${i} with ffmpeg`
    }
    case 'ffprobe':
      return `Inspecting the media file ${T(t, '', false)}`.trim()
    case 'sox':
      return `Processing the audio ${T(t, 'file', false)} with sox`
    case 'soxi':
      return x.files && x.files.length > 1 ? `Inspecting ${x.files.length} audio files` : `Inspecting the audio file ${T(t, '', false)}`.trim()
    case 'image':
      return `Converting the image ${T(t, '', false)}`.trim()
    case 'ytdl':
      return `Downloading media from ${x.url ? tidy(urlParts(x.url).hostport) : 'the web'}`
    case 'play':
      return `Playing ${T(t, 'audio', false)}`
    case 'encode':
      return `Encoding ${T(t, 'audio', false)}`
    case 'docker-build':
      return x.name ? `Building the Docker image ${clip(x.name, 40)}` : x.sub === 'compose' ? 'Building the Compose services' : 'Building a Docker image'
    case 'compose': {
      const svc = x.name ? ` ${x.name}` : ''
      switch (x.sub) {
        case 'up': return `Starting the services${svc} with Docker Compose`
        case 'down': return 'Stopping the services with Docker Compose'
        case 'logs': return `Reading the logs of service${svc || 's'} (docker compose)`
        case 'ps': return 'Listing the Compose services'
        case 'exec': return `Running a command in service${svc}`
        case 'restart': return `Restarting the service${svc || 's'} with Docker Compose`
        case 'stop': return `Stopping the service${svc || 's'} with Docker Compose`
        case 'pull': return 'Downloading the service images (docker compose pull)'
        default: return `Running docker compose ${x.sub ?? ''}`.trim()
      }
    }
    case 'docker-ps':
      return x.q !== undefined ? `Looking for the container ${quote(x.q)}` : x.mode === 'all' ? 'Listing all containers' : 'Listing running containers'
    case 'docker-logs':
      return `${x.follow ? 'Following' : 'Reading'} the logs of container ${x.name ?? ''}`.trim()
    case 'docker-exec':
      return `Running ${x.what ? x.what + ' ' : 'a command '}in container ${x.name ?? ''}`.trim()
    case 'docker-run':
      return `Starting a container from ${x.name ? clip(x.name, 40) : 'an image'}`
    case 'docker-images':
      switch (x.sub) {
        case 'pull': return `Downloading the image ${x.name ?? ''}`.trim()
        case 'push': return `Uploading the image ${x.name ?? ''}`.trim()
        case 'rmi': return `Deleting the image ${x.name ?? ''}`.trim()
        case 'tag': return `Tagging the image ${x.name ?? ''}`.trim()
        default: return x.q !== undefined ? `Looking for the image ${quote(x.q)}` : 'Listing Docker images'
      }
    case 'docker-ctl': {
      const v = own(VERB_ING, x.sub) ?? 'Managing'
      return `${v} container ${x.name ?? ''}`.trim()
    }
    case 'docker-misc':
    case 'kube':
      return `Running ${r.name ?? r.prog}`
    case 'sqlite':
    case 'sql':
    case 'db-dump': {
      const dbName = x.db ? baseName(tidy(x.db)) : ''
      const db = dbName && !isPlaceholder(dbName) && dbName !== '…' ? ` ${clip(dbName, 40)}` : ''
      const what = x.what ?? 'SQL'
      if (r.kind === 'db-dump') return `Backing up the ${what} database${db}`
      switch (x.sql) {
        case 'backup': return `Backing up the ${what} database${db}`
        case 'tables': return `Listing the tables in${db || ' the database'}`
        case 'schema': return `Reading the schema of${db || ' the database'}`
        case 'import': return `Loading data into${db || ' the database'}`
        case 'write': return `Updating the ${what} database${db}`
        case 'ddl': return `Changing the tables of${db || ' the database'}`
        default: return `Querying the ${what} database${db}`
      }
    }
    case 'redis':
      return `Talking to ${x.what ?? 'the database'}`
    case 'which': {
      const names = uniq((x.files ?? []).map(n => baseName(n)).filter(n => n !== '' && !n.startsWith('$')))
      if (names.length <= 1) return `Checking where ${names[0] ?? 'a program'} is installed`
      return names.length <= 3 ? `Checking whether ${listOf(names, 3)} are installed` : `Checking whether ${names.length} tools are installed`
    }
    case 'env':
      return x.q !== undefined ? `Checking environment variables matching ${quote(patternAlts(x.q, x.qEre === true)[0] ?? x.q)}` : 'Checking environment variables'
    case 'echo-env':
      return `Checking ${listOf((x.files ?? []).slice(0, 3), 3) || 'a variable'}`
    case 'version': {
      const names = x.files ?? []
      if (names.length > 1) return names.length <= 3 ? `Checking the versions of ${listOf(names, 3)}` : `Checking the versions of ${listOf(names, 3)} tools`.replace(/and (\d+) more tools$/, 'and $1 more')
      return `Checking the ${x.what === r.prog ? r.prog : x.what ?? r.prog} version`
    }
    case 'help':
      return `Reading the help for ${x.what ?? r.prog}`
    case 'py-version':
      if (x.sub === 'cuda') return 'Checking whether PyTorch can see the GPU (CUDA)'
      if (x.sub === 'file') return `Checking where ${x.name ?? 'a module'} is installed (Python)`
      return /,| and /.test(x.name ?? '') ? `Checking the installed versions of ${x.name} (Python)` : `Checking the installed version of ${x.name ?? 'a module'} (Python)`
    case 'py-import':
      return `Checking that ${clip(x.name ?? 'a module', 40)} can be imported`
    case 'py-env':
      return `Checking the Python setup (${r.name ?? 'python'})`
    case 'uname':
      return 'Checking the operating system'
    case 'hostname':
      return "Checking the machine's name"
    case 'whoami':
      return 'Checking which user is running commands'
    case 'cpu':
      return 'Checking the CPU cores'
    case 'mem':
      return 'Checking free memory'
    case 'uptime':
      return 'Checking uptime and system load'
    case 'date':
      return 'Checking the date and time'
    case 'df':
      return 'Checking free disk space'
    case 'disk':
      return r.name === 'quota' ? 'Checking the disk quota' : 'Checking the disks'
    case 'hw':
      return 'Checking the hardware'
    case 'locale':
    case 'sysinfo':
      return 'Checking system settings'
    case 'pwd':
      return 'Checking the current folder'
    case 'path':
      return t && showPath(t) ? `Resolving the path ${showPath(t)}` : 'Resolving a path'
    case 'libs':
      return 'Checking shared libraries'
    case 'dmesg':
      return 'Reading the kernel log'
    case 'pip-list': {
      if (x.sub === 'uv-python') return 'Listing the Python versions uv knows (uv python)'
      if (x.sub === 'uv-tool') return 'Listing the tools installed with uv'
      if (x.q !== undefined) {
        const alts = patternAlts(x.q, x.qEre === true)
        return alts.length > 1 ? `Checking whether ${listOf(alts.map(a => clip(a, 20)), 3)} are installed` : `Checking whether ${quote(alts[0] ?? x.q, 24)} is installed`
      }
      if (x.sub === 'show' && x.name) return `Checking the installed version of ${x.name}`
      return x.sub === 'freeze' || x.sub === 'list' || x.sub === '' ? 'Listing installed Python packages' : `Checking Python packages (${r.name ?? 'pip'})`
    }
    case 'conda-list':
      return x.sub === 'envs' || x.sub === 'info' ? 'Listing conda environments' : 'Listing packages in the conda environment'
    case 'npm-ls':
      return x.what === 'ollama' ? 'Listing local models (ollama)' : `Checking installed packages (${r.name ?? r.prog})`
    case 'pkg-list':
      return `Checking installed system packages (${r.name ?? r.prog})`
    case 'hf':
      return `Using the Hugging Face CLI (${r.name ?? 'hf'})`
    case 'pip-install': {
      const pkgs = (x.pkgs ?? []).filter(p => p !== '')
      const m = x.manager ?? 'pip'
      if (x.sub === 'uninstall') return pkgs.length ? `Removing ${listOf(pkgs.map(p => clip(p, 24)), 2)} with ${m}` : `Removing packages with ${m}`
      if (x.sub === 'editable') return `Installing this project in editable mode (${m})`
      if (x.arg) return `Installing packages from ${T(x.arg, 'a requirements file', false)}`
      if (pkgs.length === 1 || pkgs.length === 2) return `Installing ${listOf(pkgs.map(p => clip(p, 28)), 2)} with ${m}`
      if (pkgs.length > 2) return `Installing ${pkgs.length} packages with ${m}`
      return `Installing packages with ${m}`
    }
    case 'venv':
      return `Creating a virtual environment in ${T(x.dir ?? '.venv', '.venv/', true)}${x.via ? ' with ' + x.via : ''}`
    case 'uv-sync':
      return x.sub === 'lock' ? "Locking the project's dependency versions (uv lock)" : "Installing the project's dependencies (uv sync)"
    case 'conda-create':
      return `Creating the conda environment ${x.name ?? ''}`.trim()
    case 'npm-install': {
      const pkgs = x.pkgs ?? []
      const m = x.manager ?? 'npm'
      if (x.sub === 'ci') return 'Installing the exact npm dependencies (npm ci)'
      if (/^(uninstall|remove|rm|un)$/.test(x.sub ?? '')) return `Removing ${pkgs.length ? listOf(pkgs, 2) : 'packages'} with ${m}`
      if (/^(update|up|upgrade)$/.test(x.sub ?? '')) return `Updating ${pkgs.length ? listOf(pkgs, 2) : 'the dependencies'} with ${m}`
      if (pkgs.length) return pkgs.length > 2 ? `Installing ${pkgs.length} packages with ${m}` : `Installing ${listOf(pkgs, 2)} with ${m}`
      return `Installing the ${m} dependencies`
    }
    case 'sys-install': {
      const pkgs = x.pkgs ?? []
      const m = x.manager ?? 'the package manager'
      if (x.sub === 'update') return `Refreshing the package lists (${m})`
      if (x.sub === 'upgrade') return `Upgrading system packages (${m})`
      if (x.sub === 'remove') return `Removing ${pkgs.length ? listOf(pkgs, 2) : 'packages'} with ${m}`
      return pkgs.length ? `Installing ${pkgs.length > 2 ? pkgs.length + ' packages' : listOf(pkgs, 2)} with ${m}` : `Installing packages with ${m}`
    }
    case 'hf-download':
      if (x.via === 'ollama') return `Downloading the model ${x.what ?? ''} (ollama)`.trim()
      return x.sub === 'upload' ? 'Uploading to Hugging Face' : `Downloading ${x.what ? clip(x.what, 44) : 'files'} from Hugging Face`
    case 'install-misc':
      return `Installing ${x.what ? clip(x.what, 40) : 'dependencies'}${x.manager ? ' with ' + x.manager : ''}`
    case 'test': {
      const name = r.name ?? 'tests'
      if (r.query !== undefined && r.query !== '') return `Running tests matching ${quote(r.query, 28)} (${name})`
      const tt = t && !/run\.sh$|\.sh$/.test(t) ? showPath(t) : ''
      return tt ? `Running the tests in ${tt} (${name})` : `Running the test suite (${name})`
    }
    case 'build':
      return x.what && x.what !== r.prog ? `Building the project (${x.what})` : `Building the project (${r.name ?? r.prog})`
    case 'make':
      return r.target ? `Running make ${r.target}` : 'Building with make'
    case 'compile':
      if (r.name && /py_compile|compileall/.test(r.name)) return `Checking that ${T(t, 'the code', false)} compiles (Python)`
      return t && showPath(t, false) ? `Compiling ${showPath(t, false)}${r.name ? ' with ' + r.name : ''}` : `Compiling with ${r.name ?? r.prog}`
    case 'tsc':
      return 'Compiling TypeScript (tsc)'
    case 'typecheck':
      return r.prog === 'tsc' || r.name === 'tsc' || r.prog === 'vue-tsc' ? 'Type-checking the TypeScript code (tsc)' : `Type-checking with ${x.what ?? r.prog}`
    case 'lint':
      return `Checking the code with ${x.what ?? r.prog}`
    case 'format':
      return `Formatting the code with ${x.what ?? r.prog}`
    case 'syntax':
      return `Checking ${T(t, 'the script', false)} for syntax errors`
    case 'git-status':
      return 'Checking git status'
    case 'git-diff':
      if (x.arg && showPath(x.arg)) return `Showing the changes to ${showPath(x.arg)}`
      return x.mode === 'staged' ? 'Showing the staged changes (git diff --cached)' : x.mode === 'stat' ? 'Listing what changed (git diff --stat)' : 'Showing what changed (git diff)'
    case 'git-log':
      if (x.arg && showPath(x.arg)) return `Reading the history of ${showPath(x.arg)} (git log)`
      if (x.q !== undefined) return `Searching the commit history for ${quote(x.q)}`
      return x.n ? `Reading the last ${plural(x.n, 'commit')} (git log)` : 'Reading the commit history (git log)'
    case 'git-show':
      if (x.arg && /:/.test(x.arg)) return `Reading ${P(x.arg.split(':').pop(), 'a file')} as of ${x.arg.split(':')[0] || 'the index'} (git show)`
      return x.arg ? `Showing commit ${clip(x.arg, 20)} (git show)` : 'Showing the latest commit (git show)'
    case 'git-blame':
      return `Checking who last changed each line of ${T(t, 'the file')} (git blame)`
    case 'git-add':
      return x.files && x.files.length && !(x.files.length === 1 && (x.files[0] === '.' || x.files[0] === '-A')) ? `Staging ${fileList(x.files)} (git add)` : 'Staging all changes (git add)'
    case 'git-commit':
      return x.msg ? `Committing changes: ${quote(x.msg, 50)}` : 'Committing changes (git commit)'
    case 'git-remote':
      switch (x.sub) {
        case 'push': return `Pushing commits to ${x.arg ?? 'the remote'}`
        case 'pull': return `Pulling the latest changes${x.arg ? ' from ' + x.arg : ''}`
        case 'fetch': return `Fetching from ${x.arg ?? 'the remote'}`
        case 'clone': return `Cloning ${x.arg ? clip(baseName(x.arg).replace(/\.git$/, ''), 40) : 'a repository'}`
        default: return 'Checking the git remotes'
      }
    case 'git-branch':
      if (x.sub === 'restore' || x.mode === 'files') return `Restoring ${P(x.arg, 'files')} from git`
      if (x.mode === 'new') return `Creating the branch ${x.arg ?? ''}`.trim()
      if (x.mode === 'delete') return `Deleting the branch ${x.arg ?? ''}`.trim()
      if (x.sub === 'branch') return x.arg ? `Creating the branch ${x.arg}` : 'Listing branches'
      if (x.sub === 'worktree') return 'Managing git worktrees'
      return x.arg ? `Switching to ${x.arg}` : 'Switching branches'
    case 'git-merge':
      if (x.sub === 'rebase') return `Rebasing onto ${x.arg ?? 'another branch'}`
      if (x.sub === 'cherry-pick') return `Cherry-picking commit ${x.arg ?? ''}`.trim()
      return `Merging ${x.arg ?? 'a branch'} into this branch`
    case 'git-stash':
      if (x.arg === undefined || x.arg === 'push' || x.arg === 'save') return 'Stashing changes for later'
      if (x.arg === 'pop' || x.arg === 'apply') return 'Restoring stashed changes'
      return x.arg === 'list' ? 'Listing stashed changes' : `Managing stashed changes (git stash ${x.arg})`
    case 'git-misc': {
      const sub = x.sub ?? ''
      if (sub === 'rev-parse') return 'Checking the current commit or repo root'
      if (sub === 'ls-files') return x.q !== undefined ? `Looking for tracked files matching ${quote(x.q)}` : 'Listing the files git tracks'
      if (sub === 'check-ignore') return `Checking whether ${P(x.arg, 'a file')} is ignored by git`
      if (sub === 'init') return 'Creating a new git repository'
      if (sub === 'clean') return 'Deleting untracked files (git clean)'
      if (sub === 'config') return 'Checking git settings'
      if (sub === 'reset') return 'Resetting changes (git reset)'
      if (sub === 'tag') return 'Managing git tags'
      if (sub === 'apply') return 'Applying a patch (git apply)'
      return sub ? `Running git ${sub}` : 'Running git'
    }
    case 'gh': {
      const num = x.arg && /^\d+$/.test(x.arg) ? ` #${x.arg}` : ''
      if (x.sub === 'api') return `Calling the GitHub API: ${clip(x.sub2 ?? '', 40)}`
      if (x.sub === 'pr' && x.sub2 === 'view') return `Viewing pull request${num} (gh)`
      if (x.sub === 'pr' && x.sub2 === 'list') return 'Listing pull requests (gh)'
      if (x.sub === 'pr' && x.sub2 === 'create') return 'Creating a pull request (gh)'
      if (x.sub === 'pr' && x.sub2 === 'checks') return `Checking CI status${num ? ' of' + num : ''} (gh)`
      if (x.sub === 'pr' && x.sub2 === 'diff') return `Reading the diff of pull request${num} (gh)`
      if (x.sub === 'issue' && x.sub2 === 'view') return `Viewing issue${num} (gh)`
      if (x.sub === 'issue' && x.sub2 === 'list') return 'Listing issues (gh)'
      if (x.sub === 'run') return x.sub2 ? `Checking CI runs (gh run ${x.sub2})` : 'Checking CI runs (gh run)'
      return `Using GitHub from the terminal (gh ${`${x.sub ?? ''} ${x.sub2 ?? ''}`.trim()})`
    }
    case 'script': {
      const nm = (t && showPath(t, false) ? baseName(tidy(t)) : '') || r.name || r.prog
      const lang = x.what && x.what !== 'shell' && x.what !== '' ? ` (${x.what})` : ''
      if (x.help) return `Reading the help of ${nm}`
      const sub = x.sub && !/\.(py|sh|js|ts)$/.test(x.sub) ? ` ${x.sub}` : ''
      if (x.bg) return `Starting ${nm}${sub} in the background${lang}`
      return `Running ${nm}${sub}${lang}`
    }
    case 'py-inline': {
      if (x.bg) return 'Starting inline Python in the background'
      const f = x.input ? showPath(x.input, false) : ''
      return f ? `Running inline Python on ${f}` : 'Running inline Python'
    }
    case 'py-edit': {
      const f = T(t, 'a file', false)
      return x.sub === 'patch' ? `Editing ${f} with inline Python` : `Writing ${f} with inline Python`
    }
    case 'py-module':
      return `${x.bg ? 'Starting' : 'Running'} the Python module ${clip(x.what ?? '', 48)}${x.bg ? ' in the background' : ''}`
    case 'py-repl':
      return 'Starting a Python shell'
    case 'js-inline':
      return 'Running inline JavaScript (Node.js)'
    case 'js-repl':
      return 'Starting a Node.js shell'
    case 'sh-inline':
      return 'Running a shell script from the input'
    case 'other-inline':
      return `Running an inline ${x.what ?? 'script'}`
    case 'server': {
      const port = x.port ? ` on port ${x.port}` : ''
      return `Starting ${x.what ?? 'a'} server${port}${x.bg ? ' in the background' : ''}`
    }
    case 'npm-start':
      return `Starting the app (${r.name ?? 'npm start'})`
    case 'npm-run':
      return x.what ? `Running the ${r.prog === 'make' ? 'make target' : 'npm script'} ${quote(x.what, 30)}` : `Running ${r.name ?? 'an npm script'}`
    case 'claude':
      switch (x.sub) {
        case 'version': return "Checking Claude Code's version"
        case 'help': return x.sub2 ? `Reading the help for claude ${x.sub2}` : 'Reading the Claude CLI help'
        case 'print': return 'Asking Claude a one-off question (claude -p)'
        case 'plugin':
          if (x.sub2 === 'validate') return `Validating the plugin${x.arg && showPath(x.arg, true) ? ' ' + showPath(x.arg, true) : ''}`
          return x.sub2 === 'test' ? "Running the plugin's tests (claude plugin test)" : `Managing plugins (claude plugin${x.sub2 ? ' ' + x.sub2 : ''})`
        case 'mcp': return `Managing MCP servers (claude mcp${x.sub2 ? ' ' + x.sub2 : ''})`
        default: return x.sub ? `Running claude ${x.sub}` : 'Starting Claude Code'
      }
    case 'poll':
      if (x.what) return `Waiting for ${x.what}`
      return x.secs && x.secs >= 1 ? `Waiting, checking every ${showDuration(x.secs)}` : 'Waiting in a polling loop'
    case 'sleep':
      return x.secs ? `Waiting ${showDuration(x.secs)}` : 'Pausing'
    case 'wait-bg':
      return x.pid ? `Waiting for ${pidLabel(x.pid)} to finish` : 'Waiting for background jobs to finish'
    case 'inotify':
      return `Waiting for ${T(t, 'a file')} to change`
    case 'open':
      return `Opening ${T(t, 'a file')}`
    case 'calc':
      return 'Doing some arithmetic'
    case 'openssl':
      return `Using OpenSSL (${r.name ?? 'openssl'})`
    case 'print':
      return 'Printing a message'
    case 'each-prog':
      return `Running ${listOf(x.files ?? [], 3)} in a loop`
    case 'sample': {
      const base = `${x.then ?? 'Taking a reading'} every ${showDuration(x.secs ?? 1)}`
      const into = x.arg ? showPath(x.arg, false) : ''
      return firstFit([into ? `${base}, saving to ${into}` : undefined, base])
    }
    default:
      return r.name ? `Running ${clip(r.name, 60)}` : 'Running a shell command'
  }
}

/** Fit a headline into 90 chars: try it, then cut at a word boundary. */
function fit(s: string, max = 90): string {
  const t = oneLine(s)
  if (t.length <= max) return t
  const cut = t.slice(0, max - 1)
  const sp = cut.lastIndexOf(' ')
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:(–-]+$/, '') + '…'
}

const ENV_WORDS: Readonly<Record<string, string>> = {
  df: 'disk space', disk: 'disks', cpu: 'CPU cores', mem: 'memory', uptime: 'load', uname: 'the OS', hostname: 'the host name', whoami: 'the user',
  date: 'the time', which: 'installed tools', version: 'versions', env: 'environment variables', 'echo-env': 'environment variables',
  'pip-list': 'Python packages', 'conda-list': 'conda environments', hw: 'hardware', libs: 'libraries', pwd: 'the folder', path: 'paths',
  'py-version': 'versions', 'py-import': 'imports', help: 'the help text', locale: 'settings', sysinfo: 'settings', dmesg: 'the kernel log',
}

const GIT_WORDS: Readonly<Record<string, string>> = {
  'git-status': 'status', 'git-diff': 'changes', 'git-log': 'history', 'git-show': 'a commit', 'git-blame': 'blame', 'git-branch': 'branches',
  'git-remote': 'remotes', 'git-stash': 'stash', 'git-misc': 'settings', gh: 'GitHub', 'git-add': 'staged files', 'git-merge': 'merges',
}

/** The first option that fits in 90 chars (the last one, cut, when none does). */
function firstFit(options: readonly (string | undefined)[]): string {
  const ok = options.filter((o): o is string => o !== undefined && o !== '')
  for (const o of ok) if (o.length <= 90) return o
  return ok[ok.length - 1] ?? ''
}

function combinedHeadline(dom: Role, cands: readonly Role[]): string {
  const same = cands.filter(r => r.cat === dom.cat)
  const head = roleHeadline(dom)
  if (same.length <= 1) return head
  switch (dom.cat) {
    case 'read-file': {
      const reads = same.filter(r => r.kind !== 'stat')
      const targets = uniq(reads.map(r => r.target ?? ''))
      if (targets.length === 1 && reads.every(r => r.kind === 'range')) {
        const ranges = reads.flatMap(r => r.x.ranges ?? [])
        const f = P(targets[0], 'the file', false)
        const [r0, r1] = ranges
        if (ranges.length === 2 && r0 && r1) return firstFit([`Reading ${rangeText(r0)} and ${rangeText(r1).replace(/^lines? /, '')} of ${f}`, head])
        return firstFit([`Reading ${ranges.length} parts of ${f}`, head])
      }
      const files = uniq(reads.flatMap(r => (r.reads.length ? r.reads : r.target ? [r.target] : [])))
      const shown = uniq(files.map(f => showPath(f, false)).filter(Boolean))
      if (shown.length <= 1) return head
      return firstFit([shown.length <= 3 ? `Reading ${listOf(shown, 3)}` : undefined, `Reading ${shown.length} files (${shown.slice(0, 2).join(', ')}, …)`, `Reading ${shown.length} files`])
    }
    case 'list-files': {
      if (!same.every(r => r.kind === 'ls')) return head
      const all = same.flatMap(r => r.x.files ?? [])
      const dirs = uniq(all.map(f => showPath(f, /[*?]/.test(baseName(f)) ? undefined : looksDir(f))).filter(Boolean))
      if (dirs.length <= 1) return head
      const globs = all.some(f => /[*?]/.test(baseName(f)))
      return firstFit([dirs.length <= 3 ? (globs ? `Listing ${listOf(dirs, 3)}` : `Listing files in ${listOf(dirs, 3)}`) : undefined, `Listing ${dirs.length} folders`])
    }
    case 'search': {
      const qs = uniq(same.map(r => patternAlts(r.query ?? '', r.x.ere === true)[0] ?? '').filter(q => q !== ''))
      if (qs.length <= 1) return head
      const wheres = uniq(same.map(r => r.where ?? '').filter(w => w !== ''))
      const qq = qs.length === 2 ? `${quote(qs[0] ?? '', 24)} and ${quote(qs[1] ?? '', 24)}` : `${quote(qs[0] ?? '', 24)} and ${qs.length - 1} more patterns`
      const w = wheres.length === 1 ? showPath(wheres[0] ?? '') : ''
      return firstFit([w ? `Searching ${w} for ${qq}` : `Searching for ${qq}`, head])
    }
    case 'env': {
      const words = uniq(same.map(r => ENV_WORDS[r.kind] ?? '').filter(w => w !== ''))
      return words.length > 1 ? firstFit([`Checking ${listOf(words, 4)}`, `Checking ${listOf(words, 3)}`, head]) : head
    }
    case 'git': {
      const commit = same.find(r => r.kind === 'git-commit')
      if (commit) {
        const base = roleHeadline(commit)
        const push = same.some(r => r.kind === 'git-remote' && r.x.sub === 'push')
        return firstFit([push ? base.replace(/^Committing/, 'Committing and pushing') : base, base])
      }
      const words = uniq(same.map(r => GIT_WORDS[r.kind] ?? '').filter(w => w !== ''))
      return words.length > 1 ? firstFit([`Checking git ${listOf(words, 3)}`, head]) : head
    }
    case 'process': {
      const stop = same.find(r => r.kind === 'kill' || r.kind === 'pkill')
      return stop ? roleHeadline(stop) : head
    }
    case 'write-file': {
      const files = uniq(same.flatMap(r => (r.target ? [r.target] : r.writes)))
      return files.length > 1 ? firstFit([`Writing ${fileList(files)}`, `Writing ${files.length} files`]) : head
    }
    case 'file-ops': {
      if (same.every(r => r.kind === 'rm')) return firstFit([`Deleting ${fileList(same.flatMap(r => r.x.files ?? []))}`, head])
      return head
    }
    default:
      return head
  }
}

// ===================================================================== why

const WHY: Readonly<Record<BashCategory, readonly string[]>> = {
  test: [
    'Running the tests proves the change works and that nothing else broke.',
    'Tests are an automatic check: if they pass, the code still does what it promised.',
    'Claude runs the test suite to verify its work instead of assuming it is right.',
  ],
  build: [
    'Building or type-checking catches mistakes before the code ever runs.',
    'A build turns source code into something runnable and flags errors early.',
    'Compiling and checking types is a cheap way to find broken code without running it.',
  ],
  install: [
    'Installing the missing pieces gives the project the libraries it needs to run.',
    'Projects lean on outside libraries; this fetches them so the code can import them.',
    'Setting up the environment first avoids confusing “module not found” errors later.',
  ],
  git: [
    'Git keeps the project’s history, so Claude can see exactly what changed and why.',
    'Version control lets Claude review, save or undo changes safely.',
    'Git is the safety net: every change is recorded and can be reviewed or rolled back.',
  ],
  'run-script': [
    'Running the code is the fastest way to see what it really does.',
    'A small script lets Claude compute or check something precisely instead of guessing.',
    'Claude runs the program to get real output it can reason about.',
  ],
  'read-file': [
    'Reading the file first means Claude works from what the code really says, not from memory.',
    'Claude reads just the part it needs, which keeps its context small and focused.',
    'Looking at the actual content avoids guessing about how things work.',
  ],
  'list-files': [
    'Listing a folder shows what exists before Claude decides where to look.',
    'A quick look at the folder layout tells Claude where things live.',
  ],
  search: [
    'Search narrows a big codebase to the few places that matter, so Claude reads only what is relevant.',
    'Finding every place a name appears shows Claude where a change would ripple.',
    'Searching first is much cheaper than reading whole files one by one.',
  ],
  'write-file': [
    'Claude writes the file in one go, so its content is exactly what it planned.',
    'Saving the work to a file makes it real: the next steps can run or review it.',
  ],
  'file-ops': [
    'Moving, copying or deleting files keeps the project tidy for the next step.',
    'File housekeeping puts things where the next command expects them.',
  ],
  process: [
    'Checking running processes shows whether a job is alive, stuck or finished.',
    'Every program runs as a process; managing them keeps long jobs under control.',
  ],
  network: [
    'Network tools check that machines and services can reach each other.',
    'Claude checks connections and ports to see whether a service is reachable.',
  ],
  http: [
    'An HTTP request asks a server directly, so Claude sees exactly what it answers.',
    'Calling the endpoint checks that the service is up and returns what is expected.',
  ],
  gpu: [
    'Checking the GPU shows how much memory is free before starting or judging a heavy job.',
    'GPU memory is the scarce resource for big models, so Claude checks it often.',
  ],
  media: [
    'Media tools inspect or convert audio and video so the next step gets the right format.',
    'Sample rates, lengths and formats matter to models, so Claude checks and converts them.',
  ],
  docker: [
    'Containers package an app with everything it needs; Claude inspects or runs them here.',
    'Docker keeps services isolated, so Claude checks their state and logs through it.',
  ],
  database: [
    'Querying the database shows the real data instead of what the code assumes.',
    'A direct query is the quickest way to check what is actually stored.',
  ],
  env: [
    'Checking the environment first avoids surprises from missing tools or wrong versions.',
    'Knowing the machine (versions, paths, resources) helps Claude pick commands that will work.',
  ],
  wait: [
    'Waiting for the job to report back lets Claude react to the real result, not a guess.',
    'A polling loop checks every few seconds, so Claude continues as soon as the job is ready.',
    'Long jobs take time; Claude waits for a clear signal before reading the results.',
  ],
  claude: [
    'Claude Code has its own command line; running it checks how Claude itself behaves or is set up.',
    'Using the claude command lets Claude test its own settings, plugins or prompts.',
  ],
  other: [
    'Claude runs a shell command to get something done.',
    'The shell can run any program on the machine, which makes it Claude’s most flexible tool.',
  ],
}

const WHY_KIND: Readonly<Record<string, readonly string[]>> = {
  venv: ['A virtual environment keeps this project’s packages apart from everything else on the machine.'],
  'heredoc-write': ['A heredoc lets Claude write a whole file in one command, exactly as planned.'],
  'sed-i': ['sed -i edits the file in place, which is quick for small, mechanical changes.'],
  kill: ['Stopping a process frees its resources or clears the way for a fresh start.'],
  pkill: ['Stopping the matching processes frees their resources or clears the way for a fresh start.'],
  'kill-0': ['kill -0 sends no signal at all; it only asks whether the process is still alive.'],
  download: ['Downloading the file puts it on this machine, where the next steps can use it.'],
  'py-inline': ['A throwaway Python snippet answers a precise question without creating a file.'],
  sleep: ['Pausing gives the job time to make progress before Claude checks on it again.'],
  'docker-logs': ['A container’s logs are the first place to look when a service misbehaves.'],
  'git-commit': ['A commit saves a named snapshot, so this step can be reviewed or undone later.'],
  'git-diff': ['Reading the diff shows exactly which lines changed before anything is saved.'],
  'git-status': ['git status shows which files changed, so nothing is committed by accident.'],
  'git-log': ['The commit history explains how the code got here and why.'],
  wc: ['Counting lines first tells Claude how big a file is before it reads it.'],
  which: ['Checking that a tool is installed avoids a confusing “command not found” later.'],
  range: ['Reading only the lines it needs keeps Claude’s context small and focused.'],
  'tail-follow': ['Following a log shows new lines as they appear, like watching a job live.'],
  'py-version': ['Checking the installed version first avoids chasing bugs that come from the wrong library version.'],
  'py-import': ['Importing a module is the quickest check that it is installed and works.'],
  ps: ['Checking the process list shows whether a job is still running.'],
  'sqlite-write': ['Changing the database directly is powerful, so Claude does it deliberately and checks the result.'],
  'curl-sh': ['Install scripts set up a tool in one step; Claude runs one from the project’s official site.'],
  server: ['Starting the server lets Claude talk to it and check that it behaves as expected.'],
  'py-edit': ['A few lines of Python can make a precise edit that would be awkward to type by hand.'],
  backup: ['A backup copy makes the next change easy to undo if it goes wrong.'],
  rm: ['Deleting stale files keeps old results from being mistaken for new ones; rm has no undo.'],
  'find-delete': ['Cleaning out generated files keeps them from hiding real changes; deleted files do not come back.'],
  sample: ['Sampling at a steady interval shows how things change over time, not just at one moment.'],
  'tar-x': ['Unpacking the archive puts its files where the next steps can read them.'],
  'docker-build': ['Building the image packages the code and everything it needs into one runnable unit.'],
  'hf-download': ['Models are big files kept on a hub; downloading once lets every later step load them locally.'],
}

function whyFor(dom: Role | undefined, command: string, bg: boolean): string {
  const h = hash(command)
  if (bg && dom && (dom.cat === 'run-script' || dom.cat === 'process' || dom.cat === 'other')) return 'Running it in the background lets Claude keep working while the job runs.'
  if (dom) {
    const tail = dom.kind === 'tail' && dom.target && /\.log$|\/logs?\//.test(dom.target) ? ['The end of a log shows the latest state of a running job.'] : undefined
    const key = dom.kind === 'sqlite' && dom.x.sql === 'write' ? 'sqlite-write' : dom.kind === 'cp' && dom.concepts.includes('backups') ? 'backup' : dom.kind
    const kind = tail ?? WHY_KIND[key]
    if (kind && kind.length) return kind[h % kind.length] ?? kind[0] ?? ''
    if (dom.cat === 'http' && dom.x.local) return 'Calling the local server directly checks that it is up and answering correctly.'
  }
  const list = WHY[dom?.cat ?? 'other']
  return list[h % list.length] ?? WHY.other[0] ?? ''
}

// ===================================================================== analyze

function newState(): PState {
  return { vars: new Map(), loopN: new Map(), loopItems: new Map(), cmds: [], loops: [], shape: newShape(), pipeSeq: 0 }
}

const INSPECT: ReadonlySet<BashCategory> = new Set<BashCategory>(['read-file', 'search', 'list-files'])

const NOTABLE_WRAPPERS: ReadonlySet<string> = new Set(['sudo', 'timeout', 'nohup', 'setsid', 'xargs', 'watch'])

function stationFor(r: Role | undefined): Station {
  if (!r) return 'run'
  switch (r.cat) {
    case 'read-file':
      return 'read'
    case 'search':
    case 'list-files':
      return 'search'
    case 'write-file':
    case 'file-ops':
      return 'edit'
    case 'http':
      return r.x.local ? 'run' : 'web'
    default:
      return 'run'
  }
}

/** The first verb of a description, for telling apart plain inspection steps. */
const DESC_VERBS: readonly [RegExp, BashCategory][] = [
  [/^(read|show|view|print|inspect|dump|display|peek at|look at)\b/i, 'read-file'],
  [/^(search|find|grep|locate|look for|scan for)\b/i, 'search'],
  [/^(list|enumerate)\b/i, 'list-files'],
]

function analyze(command: string, description?: string): BashAnalysis {
  const src = command.length > 200_000 ? command.slice(0, 200_000) : command
  const st = newState()
  parseScript(src, st, 'top', [], 0, [])
  const roles = st.cmds.map(c => classify(c))
  const byCmd = new Map<Cmd, Role>()
  roles.forEach(r => byCmd.set(r.cmd, r))
  for (const r of roles) {
    if (r.cmd.multi > 1) {
      r.x.loopN = r.cmd.multi
      r.x.loopItems = r.cmd.loopItems
    }
  }
  groupPipelines(roles)

  // polling loops become one 'wait' Role; their own commands are covered by it
  const polls: Role[] = []
  for (const L of st.loops) {
    if (!isPolling(L)) continue
    if (L.body.concat(L.cond).every(c => c.origin === 'sub')) continue
    const pr = pollRole(L, c => byCmd.get(c))
    if (!pr) continue
    polls.push(pr)
    for (const c of L.body.concat(L.cond)) {
      const r = byCmd.get(c)
      if (r) r.covered = true
    }
  }

  const samples: Role[] = []
  // a for loop with sleep and no break samples something: 'Checking GPU memory and usage every 30 seconds'
  for (const L of st.loops) {
    if (isPolling(L) || !L.sleeps.length || L.kind !== 'for') continue
    const body = L.body.flatMap(c => [c, ...c.subs]).map(c => byCmd.get(c)).filter((r): r is Role => r !== undefined && !r.setup && r.kind !== 'sleep' && r.kind !== 'print')
    let probe: Role | undefined
    for (const r of body) if (r.w >= 10 && /^(gpu|process|http|docker|database|env|read-file|search|network)$/.test(r.cat) && (!probe || r.w > probe.w)) probe = r
    const secs = Math.max(0, ...L.sleeps.filter(x => Number.isFinite(x)))
    if (!probe || secs < 1) continue
    const out = L.body.map(c => stdoutTarget(c)).find(o => o !== undefined)
    const anchor = L.body[0]
    if (!anchor) continue
    samples.push({ ...probe, w: 73, kind: 'sample', cmd: anchor, x: { ...probe.x, secs, then: roleHeadline(probe), arg: out?.target }, writes: out ? [out.target] : [], reads: probe.reads.slice(), concepts: probe.concepts.concat('shell-loop', 'monitoring') })
    for (const c of L.body) {
      const r = byCmd.get(c)
      if (r) r.covered = true
    }
  }

  // background: a trailing &, nohup … &, setsid, a detached tmux/screen session
  const isBg = (r: Role): boolean => r.cmd.bg || r.cmd.wrap.includes('setsid') || r.cmd.u.wrap.includes('setsid') || r.x.bg === true
  for (const r of roles) {
    if (r.cmd.origin === 'sub') continue
    if (isBg(r) && !r.setup) {
      r.x.bg = true
      if (r.cat === 'run-script' || r.cat === 'process' || r.cat === 'other' || r.cat === 'media' || r.cat === 'gpu') r.w = Math.max(r.w, 85)
    }
  }

  const live = (r: Role): boolean => !r.setup && !r.pager && !r.label && !r.covered
  let cands = roles.filter(r => r.cmd.origin !== 'sub' && live(r)).concat(polls, samples)
  cands.sort((p, q) => p.cmd.idx - q.cmd.idx)
  // a compile or syntax check right after writing code is a verification step, not the point
  const writers = cands.filter(r => r.cat === 'write-file' || r.kind === 'py-edit')
  if (writers.length) {
    for (const r of cands) {
      if (r.kind === 'syntax' || (r.kind === 'compile' && /py_compile|compileall/.test(r.name ?? ''))) {
        r.w = 20
        const many = writers.length > 1
        r.x.verify = r.kind === 'syntax' ? (many ? 'their syntax' : 'its syntax') : many ? 'they compile' : 'it compiles'
      }
    }
  }
  // writing a script and then running it: the run is the point
  for (const r of cands) {
    const tb = r.target === undefined ? '' : baseName(r.target)
    if ((r.kind === 'script' || r.cat === 'test') && tb !== '' && writers.some(w => w.target !== undefined && baseName(w.target) === tb && w.cmd.idx < r.cmd.idx)) {
      r.w = Math.max(r.w, 86)
      r.x.then = 'write-run'
    }
  }
  let fromSub = false
  if (!cands.length) {
    cands = roles.filter(r => r.cmd.origin === 'sub' && live(r))
    fromSub = cands.length > 0
  }
  let dom: Role | undefined
  for (const r of cands) if (!dom || r.w > dom.w) dom = r
  // among plain inspection (read / search / list), the kind of step done most often is the intent
  if (dom && INSPECT.has(dom.cat)) {
    const n = new Map<BashCategory, number>()
    for (const r of cands) if (INSPECT.has(r.cat)) n.set(r.cat, (n.get(r.cat) ?? 0) + 1)
    let best: BashCategory = dom.cat
    for (const [c, k] of n) if (k > (n.get(best) ?? 0)) best = c
    if (best !== dom.cat) dom = cands.find(r => r.cat === best) ?? dom
    // Claude's own description can settle it: 'Read …', 'Search …', 'List …'
    const said = description === undefined ? undefined : DESC_VERBS.find(([re]) => re.test(description.trim()))?.[1]
    if (said && said !== dom.cat && n.has(said)) dom = cands.find(r => r.cat === said) ?? dom
  }

  // headline
  const topCmds = st.cmds.filter(c => c.origin !== 'sub' && !(c.u.inner !== undefined && c.inner.length))
  let headline: string
  if (dom) {
    const d = dom
    headline = combinedHeadline(d, cands)
    if (d.x.then === 'write-run') {
      headline = d.cat === 'test' ? headline.replace(/^Running the tests in /, 'Writing and running the tests in ') : headline.replace(/^Running /, 'Writing and running ').replace(/^Starting /, 'Writing and starting ')
    } else {
      // "Writing X, then running the test suite (pytest)"
      const before = cands.find(r => r.cmd.idx < d.cmd.idx && /^(heredoc-write|sed-i|perl-i|py-edit|patch|tee)$/.test(r.kind) && r !== d)
      if (before && (d.cat === 'test' || d.cat === 'build' || d.cat === 'claude' || d.cat === 'install' || d.cat === 'docker' || d.kind === 'script')) {
        const s = `${roleHeadline(before)}, then ${lower1(headline)}`
        if (s.length <= 90) headline = s
      }
      // "Writing X, then checking it compiles"
      const wrote = new Set([d, ...cands.filter(r => r.cat === 'write-file' || r.kind === 'py-edit')].flatMap(r => r.writes.concat(r.target ?? [])).map(f => baseName(f)))
      const ver = cands.find(r => r.x.verify !== undefined && r.cmd.idx > d.cmd.idx && r.target !== undefined && wrote.has(baseName(r.target)))
      if (ver && (d.cat === 'write-file' || d.kind === 'py-edit')) {
        const s = `${headline}, then checking ${ver.x.verify}`
        if (s.length <= 90) headline = s
      }
    }
    // "Waiting 30 seconds, then reading the last 5 lines of train.log"
    if (d.kind === 'sleep' && d.x.secs) {
      const next = cands.find(r => r !== d && r.cmd.idx > d.cmd.idx)
      if (next) {
        const s = `${headline}, then ${lower1(roleHeadline(next))}`
        if (s.length <= 90) headline = s
      }
    }
  } else if (topCmds.length > 1) headline = `Running a ${topCmds.length}-step shell script`
  else if (roles.some(r => r.kind === 'print')) headline = 'Printing a message'
  else if (roles.some(r => r.kind === 'assign')) headline = 'Setting shell variables'
  else if (roles.some(r => r.kind === 'cd')) headline = 'Changing the working folder'
  else headline = 'Running a shell command'
  if (dom && dom.cat === 'other' && dom.kind === 'unknown' && !dom.name && topCmds.length > 1) headline = `Running a ${topCmds.length}-step shell script`

  // programs, files
  const programs: string[] = []
  for (const r of roles) {
    if (r.setup || r.label || r.kind === 'print' || r.kind === 'assign') continue
    for (const w of r.cmd.u.wrap) if (NOTABLE_WRAPPERS.has(w)) programs.push(w)
    const p = r.prog === 'git' && r.x.sub === 'grep' ? 'git' : r.prog
    if (p && !UNKNOWN_SKIP.test(p) && p.length <= 40) programs.push(p)
  }
  const fileRoles = roles.filter(r => r.cmd.origin !== 'sub' && !r.setup)
  const clean = (a: string[]): string[] => uniq(a.filter(f => f !== '' && f !== '-' && !isDevNull(f) && f.length <= 400)).slice(0, 24)
  const readsFiles = clean(fileRoles.flatMap(r => r.reads))
  const writesFiles = clean(fileRoles.flatMap(r => r.writes))

  const isBackground = roles.some(r => r.cmd.origin !== 'sub' && !r.setup && isBg(r))
  const category: BashCategory = dom?.cat ?? 'other'
  const out: BashAnalysis = {
    station: stationFor(dom),
    category,
    programs: uniq(programs),
    headline: fit(headline),
    concepts: conceptsFor(dom, cands, roles, st, polls, src),
    isBackground,
    isMultiline: src.trim().includes('\n'),
    segments: topCmds.length,
    readsFiles,
    writesFiles,
    why: clip(whyFor(dom, src, isBackground && dom?.x.bg === true), 170),
  }
  if (dom && !fromSub && dom.name) out.primary = dom.name
  else if (dom && !fromSub && dom.prog && !UNKNOWN_SKIP.test(dom.prog) && dom.kind !== 'poll') out.primary = dom.prog
  if (dom && dom.target !== undefined && dom.target !== '') out.target = dom.target
  const s = dom && dom.cat === 'search' ? dom : cands.find(r => r.cat === 'search')
  if (s && s.query !== undefined && s.query !== '') out.searchQuery = s.query
  if (s && s.where !== undefined && s.where !== '') out.searchWhere = s.where
  return out
}

function conceptsFor(dom: Role | undefined, cands: readonly Role[], roles: readonly Role[], st: PState, polls: readonly Role[], src: string): string[] {
  const out: string[] = []
  const add = (ids: readonly string[]): void => {
    for (const id of ids) if (out.length < 16 && id !== '' && !out.includes(id) && isConceptId(id)) out.push(id)
  }
  if (dom) add(dom.concepts)
  // domain hints
  const live = roles.filter(r => !r.setup || r.kind === 'source')
  const words = live.flatMap(r => r.cmd.argv.concat(r.reads, r.writes, r.target ? [r.target] : []))
  const hint: string[] = []
  if (/\bCUDA_VISIBLE_DEVICES\b|\btorch\.cuda\b|\bcuda\b/.test(src)) hint.push('cuda')
  if (words.some(w => /\.jsonl\b/.test(w)) || /\.jsonl\b/.test(src)) hint.push('jsonl')
  if (words.some(w => /\.json$/.test(w))) hint.push('json')
  if (words.some(w => /\.ya?ml$/.test(w))) hint.push('yaml')
  if (words.some(w => /\.toml$/.test(w))) hint.push('toml')
  if (words.some(w => /\.(csv|tsv)$/.test(w))) hint.push('csv')
  const reads = roles.flatMap(r => r.reads.concat(r.target && (r.cat === 'read-file' || r.cat === 'search') ? [r.target] : []))
  if (reads.some(f => /\.md$/.test(f)) || roles.some(r => r.writes.some(f => /\.md$/.test(f)))) hint.push('markdown')
  if (words.some(w => /(^|\/)package\.json$/.test(w))) hint.push('package-json')
  if (words.some(w => /(^|\/)Dockerfile$/.test(w))) hint.push('dockerfile')
  if (words.some(w => /(^|\/)\.gitignore$/.test(w))) hint.push('gitignore')
  if (reads.some(f => /\.log$|\/logs?\//.test(f))) hint.push('reading-logs')
  if (dom && dom.cat === 'read-file' && reads.some(f => /\.(py|ts|tsx|js|mjs|go|rs|java|rb|c|cc|cpp|h|sh|kt|swift)$/.test(f))) hint.push('reading-code')
  if (/authorization\s*:|\bbearer\s/i.test(src) || roles.some(r => r.concepts.includes('api-tokens'))) hint.push('api-tokens')
  if (/huggingface|\bhf_hub|\bHF_HOME\b|\bHF_TOKEN\b|\bhf (download|upload|auth)\b/i.test(src)) hint.push('huggingface')
  if (roles.some(r => /\/(envs|miniconda\d?|anaconda\d?|miniforge\d?)\//.test(r.cmd.u.word) || r.cmd.u.wrap.includes('conda run'))) hint.push('conda')
  if (roles.some(r => r.cmd.u.wrap.includes('uv run') || r.cmd.u.wrap.includes('uvx'))) hint.push('uv')
  if (roles.some(r => r.cmd.u.wrap.includes('npx'))) hint.push('npx')
  if (roles.some(r => /(^|\/)\.?venv\/bin\//.test(r.cmd.u.word))) hint.push('python-venv')
  if (words.some(w => /\.(safetensors|ckpt|pth?)$|checkpoint-\d+/.test(w))) hint.push('model-checkpoints')
  if (/\blora\b|_lora|lora_/i.test(src)) hint.push('lora')
  if (roles.some(r => /\.env$/.test(r.target ?? '') && (r.kind === 'source' || r.cat === 'read-file'))) hint.push('secrets-hygiene')
  add(hint)
  // operators, most specific first
  const sh = st.shape
  const ops: string[] = []
  if (sh.heredoc) ops.push('heredoc')
  if (polls.length) ops.push('polling-loop')
  if (st.loops.some(L => !isPolling(L) && L.body.length)) ops.push('shell-loop')
  if (sh.pipe) ops.push('pipe')
  if (sh.redirOut || sh.redirIn) ops.push('redirect')
  if (sh.stderr) ops.push('stderr-redirect')
  if (sh.subst) ops.push('command-substitution')
  if (sh.and) ops.push('and-chain')
  if (sh.or) ops.push('or-fallback')
  const anyWrap = (w: string): boolean => roles.some(r => r.cmd.u.wrap.includes(w) || r.cmd.wrap.includes(w))
  if (sh.bg || anyWrap('nohup') || anyWrap('setsid')) ops.push('background-job')
  if (anyWrap('nohup')) ops.push('nohup')
  if (roles.some(r => r.kind === 'set' && r.concepts.includes('strict-mode'))) ops.push('strict-mode')
  if (sh.envVar || /\$\{?[A-Z_][A-Z0-9_]{2,}/.test(src)) ops.push('env-var')
  if (anyWrap('timeout')) ops.push('timeout-cmd')
  if (anyWrap('xargs')) ops.push('xargs')
  if (roles.some(r => r.prog === 'tee')) ops.push('tee')
  if (anyWrap('sudo')) ops.push('sudo')
  if (roles.some(r => r.kind === 'source')) ops.push('source-env')
  if (roles.some(r => !r.setup && r.cmd.origin !== 'sub' && r.cmd.argv.some((w, i) => i > 0 && r.cmd.quoted[i] === false && /[*?]/.test(w) && !w.startsWith('-') && !/[=$(]/.test(w)))) ops.push('globbing')
  if (/\$\?|\|\|\s*exit\b/.test(src)) ops.push('exit-codes')
  if (sh.quoting) ops.push('quoting')
  add(ops)
  for (const r of cands) if (r !== dom) add(r.concepts)
  for (const r of roles) if (r.pager) add(r.concepts)
  for (const r of roles) if (r.cmd.origin === 'sub' && !r.setup) add(r.concepts)
  for (const r of roles) if (r.setup) add(r.concepts)
  if (!out.length) add(['shell-basics'])
  return out.slice(0, 8)
}

function fallback(command: string): BashAnalysis {
  const first = oneLine(command.split('\n', 1)[0] ?? '')
  return {
    station: 'run',
    category: 'other',
    programs: [],
    headline: first ? fit(`Running ${first}`) : 'Running a shell command',
    concepts: ['shell-basics'],
    isBackground: false,
    isMultiline: command.trim().includes('\n'),
    segments: first ? 1 : 0,
    readsFiles: [],
    writesFiles: [],
    why: WHY.other[0] ?? '',
  }
}

// ===================================================================== result notes

const PY_EXC = /^(?:[A-Za-z_][\w.]*\.)?(?:[A-Z]\w*)?(?:Error|Exception|Exit|Interrupt|Failure)\b(?::|$)/
const PYTEST_FAIL = /^(FAILED|ERROR)\s+\S+/
const TIER1 = /^(?:FAIL\b|ERROR\b|E\s{2,}\S|error(?:\[\w+\])?:|fatal:|npm ERR!|panic:|Segmentation fault|not ok \d+|\S+\.\w+[:(]\d+[:,]?\d*\)?:?\s*error\b|.*\berror TS\d+:|\S+: (?:fatal )?error\b)/i
const PHRASES = /(No such file or directory|Permission denied|command not found|No module named|Connection refused|cannot access|cannot open|Could not resolve host|Name or service not known|Operation not permitted|Is a directory|Not a directory|Address already in use|out of memory)/i
const WEAK = /(not found|could not|unable to|unrecognized|invalid|unknown option|denied|does not exist|missing|failed|refused|timed out)/i
const PREFIXED = /^(?:[\w./+-]+: |\/bin\/\w+: )/

function exitMeaning(code: number): string {
  switch (code) {
    case 124:
      return 'Timed out (exit code 124)'
    case 126:
      return 'Not executable (exit code 126)'
    case 127:
      return 'Command not found (exit code 127)'
    case 130:
      return 'Interrupted (exit code 130)'
    case 137:
      return 'Killed (exit code 137, often out of memory)'
    case 139:
      return 'Crashed: segmentation fault (exit code 139)'
    case 143:
      return 'Terminated (exit code 143)'
    default:
      return `Exit code ${code}`
  }
}

function errorNote(a: BashAnalysis, t: string): string {
  const lines = t.split('\n').map(l => l.trimEnd()).filter(l => l.trim() !== '')
  const m = /^Exit code (\d+)/.exec(lines[0] ?? '')
  const code = m ? Number(m[1]) : undefined
  const body = (m ? lines.slice(1) : lines).map(l => l.trim())
  const s0 = body[0] ?? ''
  if (/^Blocked:/.test(s0)) return clip(s0.replace(/\s+followed by:.*$/, ' followed by other commands'), 120)
  if (/^Error: No such tool available/.test(s0)) return 'The tool name was wrong (no such tool)'
  if (/^\[Request interrupted/.test(s0)) return 'Stopped by you'
  if (code === 143 || code === 137 || code === 124 || code === 130 || code === 139) {
    const last = body[body.length - 1] ?? ''
    if (body.length === 0 || /^(Terminated|Killed|Interrupted)$/i.test(last)) return exitMeaning(code)
  }
  const search = a.category === 'search'
  // read / search / list output is file content: only 'prog: message' lines count as errors there
  const inspect = search || a.category === 'read-file' || a.category === 'list-files'
  for (const l of body) if (PYTEST_FAIL.test(l)) return l
  for (let i = body.length - 1; i >= 0; i--) {
    const l = body[i] ?? ''
    if (PY_EXC.test(l)) return l
  }
  for (const l of body) if (TIER1.test(l)) return l
  for (const l of body) if (PHRASES.test(l) && (!inspect || PREFIXED.test(l))) return l
  for (const l of body) if (WEAK.test(l) && (PREFIXED.test(l) || (!inspect && (/error/i.test(l) || /^[A-Z][A-Z ]{2,}\b/.test(l))))) return l
  for (const l of body) if (/^usage:/i.test(l)) return l
  const fails = /^# fail (\d+)/m.exec(t)
  if (fails && Number(fails[1]) > 0) return `${plural(Number(fails[1]), 'test')} failed`
  if (code !== undefined) {
    if (code === 1 && (search || a.programs.some(p => /grep|^rg$/.test(p)))) return body.length === 0 ? 'No matches (grep exited with 1)' : 'The last search found nothing (exit code 1)'
    return exitMeaning(code)
  }
  return body[body.length - 1] ?? 'Failed'
}

function deniedNote(t: string): string {
  if (/don'?t ask mode/i.test(t)) return "Not allowed: Claude Code is in don't-ask mode"
  if (/^Permission to use [\s\S]*has been denied/i.test(t)) return 'Blocked by a permission rule'
  if (/doesn'?t want to proceed|rejected/i.test(t)) return 'You declined this command'
  if (/interrupted/i.test(t)) return 'Stopped by you'
  const first = oneLine(t.split('\n', 1)[0] ?? '')
  return first || 'Not allowed'
}

function testSummary(t: string): string | undefined {
  const out: string[] = []
  for (const m of t.matchAll(/(?:^|\n)[=\s]*((?:\d+ (?:passed|failed|errors?|skipped|xfailed|xpassed|warnings?|deselected|rerun)(?:,\s*)?)+)(?: in [\d.]+s)?(?: \([\d:.]+\))?[=\s]*(?=\n|$)/g)) {
    out.push((m[1] ?? '').replace(/,\s*$/, ''))
  }
  const pass = /^# pass (\d+)/m.exec(t)
  const fail = /^# fail (\d+)/m.exec(t)
  if (pass || fail) out.push(`${pass?.[1] ?? 0} passed, ${fail?.[1] ?? 0} failed`)
  const jest = /^Tests:\s+(.+)$/m.exec(t)
  if (jest) out.push((jest[1] ?? '').trim())
  const passing = /^\s*(\d+) passing\b/m.exec(t)
  const failing = /^\s*(\d+) failing\b/m.exec(t)
  if (passing) out.push(`${passing[1]} passed${failing ? `, ${failing[1]} failed` : ''}`)
  const vit = /^\s*Tests\s+(\d+ (?:passed|failed)[^(\n]*)/m.exec(t)
  if (vit && !jest) out.push((vit[1] ?? '').trim().replace(/\s*\|\s*/g, ', '))
  const goOk = (t.match(/^ok\s+\S+\s+(?:\(cached\)|[\d.]+s)/gm) ?? []).length
  const goFail = (t.match(/^FAIL\s+\S+\s+[\d.]+s/gm) ?? []).length
  if (goOk || goFail) out.push(`${plural(goOk, 'package')} ok${goFail ? `, ${goFail} failed` : ''}`)
  const cargo = /test result: \w+\. (\d+) passed; (\d+) failed/.exec(t)
  if (cargo) out.push(`${cargo[1]} passed, ${cargo[2]} failed`)
  const unit = /^Ran (\d+) tests? in [\d.]+s\s*\n+\s*(OK|FAILED)(?: \(([^)]*)\))?/m.exec(t)
  if (unit) out.push(`${unit[1]} tests ${unit[2] === 'OK' ? 'passed' : 'ran, ' + (unit[3] ?? 'some failed')}`)
  return out.length ? uniq(out).join('; ') : undefined
}

const gib = (mib: number): number => Math.round(mib / 1024)

function memLine(used?: number, total?: number, util?: number, free?: number): string | undefined {
  let s: string | undefined
  if (used !== undefined && total !== undefined && total > 0) s = `${gib(used)} GiB / ${gib(total)} GiB used`
  else if (used !== undefined) s = `${gib(used)} GiB used`
  else if (free !== undefined) s = `${gib(free)} GiB free`
  if (util !== undefined) s = s ? `${s}, ${util}% busy` : `${util}% busy`
  return s
}

function gpuNote(t: string, fields?: string): string | undefined {
  const tab = /(\d+)\s*MiB\s*\/\s*(\d+)\s*MiB/.exec(t)
  if (tab) {
    const util = /MiB\s*\|\s*(\d+)%/.exec(t)?.[1]
    const n = (t.match(/(\d+)\s*MiB\s*\/\s*(\d+)\s*MiB/g) ?? []).length
    const s = memLine(Number(tab[1]), Number(tab[2]), util !== undefined ? Number(util) : undefined)
    return s && n > 1 ? `GPU 0: ${s} (${n} GPUs)` : s
  }
  const lines = t.split('\n').map(l => l.trim()).filter(Boolean)
  let names: string[] | undefined
  let row: string[] | undefined
  const hi = lines.findIndex(l => /memory\.(used|total|free)|utilization\.gpu/.test(l))
  if (hi >= 0) {
    names = (lines[hi] ?? '').split(',').map(s => s.trim().replace(/\s*\[.*\]$/, ''))
    row = (lines[hi + 1] ?? '').split(',').map(s => s.trim())
  } else if (fields) {
    names = fields.split(',').map(s => s.trim())
    row = lines.find(l => /\d/.test(l) && l.split(',').length === names?.length)?.split(',').map(s => s.trim())
  }
  if (names && row) {
    const val = (k: string): number | undefined => {
      const i = names?.indexOf(k) ?? -1
      const v = i >= 0 ? /^(\d+(?:\.\d+)?)/.exec(row?.[i] ?? '')?.[1] : undefined
      return v !== undefined ? Number(v) : undefined
    }
    const s = memLine(val('memory.used'), val('memory.total'), val('utilization.gpu'), val('memory.free'))
    if (s) return s
  }
  return undefined
}

const HTTP_NAMES: Readonly<Record<string, string>> = {
  '200': 'OK', '201': 'Created', '204': 'No Content', '301': 'Moved', '302': 'Found (redirect)', '304': 'Not Modified', '400': 'Bad Request',
  '401': 'Unauthorized', '403': 'Forbidden', '404': 'Not Found', '405': 'Method Not Allowed', '409': 'Conflict', '422': 'Unprocessable',
  '429': 'Too Many Requests', '500': 'Server Error', '502': 'Bad Gateway', '503': 'Service Unavailable', '504': 'Gateway Timeout',
}

function okNote(a: BashAnalysis, t: string): string | undefined {
  const empty = t === '' || /^\(Bash completed with no output\)$/.test(t) || t === '(no output)'
  const lines = empty ? [] : t.split('\n').filter(l => l.trim() !== '')
  const more = t.length >= 1490 ? '+' : ''
  const single = lines.length === 1 && /^\s*\d+\s*$/.test(lines[0] ?? '') ? Number(lines[0]) : undefined
  switch (a.category) {
    case 'search': {
      if (empty) return 'No matches'
      if (single !== undefined) return `${single} matching ${single === 1 ? 'line' : 'lines'}`
      const n = lines.filter(l => !/^==> .* <==$|^--$/.test(l.trim())).length
      return `${n}${more} matching ${n === 1 && !more ? 'line' : 'lines'}`
    }
    case 'list-files': {
      if (empty) return 'No entries'
      if (single !== undefined) return `${single} ${single === 1 ? 'entry' : 'entries'}`
      const tree = /(\d+) director(?:y|ies),\s*(\d+) files?/.exec(t)
      if (tree) return `${tree[2]} files in ${tree[1]} folders`
      if (a.primary === 'du' || a.programs[0] === 'du') {
        const last = lines[lines.length - 1] ?? ''
        const size = /^\s*([\d.,]+[KMGTP]?i?B?)\s/.exec(last)?.[1]
        if (size && lines.length === 1) return `${size} in total`
      }
      const n = lines.filter(l => !/^total \d+/.test(l) && !/:\s*$/.test(l) && !/\s\.\.?$/.test(l)).length
      return `${n}${more} ${n === 1 && !more ? 'entry' : 'entries'}`
    }
    case 'test':
      return testSummary(t)
    case 'gpu':
      return gpuNote(t, a.target)
    case 'read-file': {
      if (a.primary !== undefined && /^wc\b/.test(a.primary)) {
        const unit = /-w/.test(a.primary) ? 'words' : /-c/.test(a.primary) ? 'bytes' : /-m/.test(a.primary) ? 'characters' : 'lines'
        const tot = lines.find(l => /^\s*\d+\s+total$/.test(l))
        const num = tot ? /\d+/.exec(tot)?.[0] : /^\s*(\d+)/.exec(lines[0] ?? '')?.[1]
        if (num !== undefined) return tot ? `${num} ${unit} in total` : `${num} ${unit}`
      }
      if (single !== undefined) return `${single} ${single === 1 ? 'line' : 'lines'}`
      return undefined
    }
    case 'http': {
      const code = /^\s*(\d{3})\b/.exec(lines[lines.length - 1] ?? '')?.[1] ?? /HTTP\/[\d.]+\s+(\d{3})/.exec(t)?.[1] ?? /\bHTTP (\d{3})\b/.exec(t)?.[1]
      if (code === '000') return 'No response (HTTP 000)'
      const name = own(HTTP_NAMES, code)
      if (code !== undefined && /^[1-5]\d\d$/.test(code)) return `HTTP ${code}${name ? ' ' + name : ''}`
      return undefined
    }
    default:
      return undefined
  }
}

function resultNote(a: BashAnalysis, status: StepStatus, preview: string): string | undefined {
  if (status === 'running') return undefined
  const ana: BashAnalysis = a !== null && typeof a === 'object' ? a : fallback('')
  const safe: BashAnalysis = { ...ana, programs: Array.isArray(ana.programs) ? ana.programs.filter(p => typeof p === 'string') : [] }
  const t = preview.replace(/<\/?tool_use_error>/g, '').replace(/\r/g, '').trim()
  if (status === 'denied') return deniedNote(t)
  if (/^Command running in background/.test(t)) return 'Running in the background'
  const to = /^Command did not complete within its (\d+)s timeout/.exec(t)
  if (to) return `Still running after ${to[1]} s, moved to the background`
  if (status === 'error') return errorNote(safe, t)
  return okNote(safe, t)
}
