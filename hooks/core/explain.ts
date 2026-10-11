// Turning tool calls into explained Steps. Pure, no `$`.
// Contract: the exported names and types below.
//
// explainTool runs when a call starts and must be instant: it is string work on the call's own
// arguments, plus bash.ts for shell commands. applyEnd folds the result in. Every exported function
// is total: odd input gives a plain, generic step, never an exception.
//
// Secrets never reach a Step: both explainTool and applyEnd end with a pass of redact.ts over every
// string the step shows (headline, why, target, detail, resultNote and each string of the scene), and
// the helpers that cut raw text for display redact it before they cut, so a cut never leaves half a key.
import type { BashCategory, Level, SceneData, Station, Step, StepStatus, ToolEnd, ToolObs } from '../../types'
import type { BashAnalysis } from './bash.ts'
import { analyzeBash, bashResultNote } from './bash.ts'
import { isConceptId } from './concept-ids.ts'
import { redactSecrets } from './redact.ts'

export type ExplainCtx = {
  level: Level
  /** the session's working directory, to shorten paths */
  cwd?: string
  /** paths read earlier this session (newest last), to tell 'Editing a file it read' from a blind write */
  readPaths?: readonly string[]
}

/**
 * Explain a tool call at its start (status 'running'). Never throws: unknown tools get a generic step.
 * Bash steps keep the command (newlines included, secrets masked) as `target`; applyEnd re-analyses it.
 */
export function explainTool(obs: ToolObs, ctx: ExplainCtx): Step {
  const base = baseOf(obs)
  try {
    const o: In = { ...base, args: argsOf(obs) }
    return scrubbed(finish(o, explainBy(o, normCtx(ctx))))
  } catch {
    return scrubbed(finish({ ...base, args: {} }, genericPart(base.tool, base.id)))
  }
}

/** Fold a tool call's end into its step: status, endedAt, resultNote, scene output/matches. Never throws. */
export function applyEnd(step: Step, end: ToolEnd, ctx: ExplainCtx): Step {
  if (step === null || typeof step !== 'object') return step
  let status: StepStatus = 'error'
  let endedAt = 0
  try {
    const e = obj(end)
    status = e.status === 'ok' || e.status === 'error' || e.status === 'denied' ? e.status : 'error'
    endedAt = finite(e.at) ?? finite(step.startedAt) ?? 0
    // the mod sends at most 1500 characters; anything far longer is odd input, bounded here
    const preview = typeof e.preview === 'string' ? e.preview.slice(0, PREVIEW_SEEN_MAX) : ''
    const refusal = refusalOf(preview, status)
    if (refusal !== undefined) status = 'denied'
    const r: EndPart = refusal === undefined ? endBy(step, status, preview) : { note: refusal }
    let note = r.note
    if (note === undefined && status !== 'ok') note = errorNote(preview) ?? (status === 'denied' ? 'Blocked by a permission rule' : 'failed with no message')
    let scene = r.scene ?? step.scene
    if (scene.kind === 'delegate' && r.keepRunning !== true) scene = { kind: 'delegate', agents: scene.agents.map(a => ({ ...a, status })) }
    const out: Step = { ...step, status, endedAt, scene }
    delete out.resultNote
    if (note !== undefined && note !== '') out.resultNote = cut(flat(note), NOTE_MAX)
    if (r.detail !== undefined) out.detail = cut(flat(r.detail), DETAIL_MAX)
    return scrubbed(out)
  } catch {
    return scrubbed({ ...step, status, endedAt })
  }
}

/** Shorten a path for display: relative to cwd when under it, ~ for home, keep the last segments. */
export function displayPath(path: string, cwd?: string, max = 48): string {
  try {
    if (typeof path !== 'string') return ''
    const lim = typeof max === 'number' && Number.isFinite(max) ? Math.max(2, Math.floor(max)) : 48
    let p = normPath(path)
    if (p === '') return ''
    const c = typeof cwd === 'string' ? normPath(cwd) : ''
    if (c !== '' && c !== '/' && p === c) p = '.'
    else if (c !== '' && c !== '/' && p.startsWith(c + '/')) p = p.slice(c.length + 1)
    else p = homeShort(p)
    if (p.startsWith('./') && p.length > 2) p = p.slice(2)
    return tailCut(p, lim)
  } catch {
    return ''
  }
}

/** Concept ids a file's path suggests (format, role, place), most specific first. Never throws. */
export function fileConcepts(path: string): string[] {
  try {
    const { special, format } = pathConcepts(path)
    return ids(special, format)
  } catch {
    return []
  }
}

/**
 * The stage scene for a Bash call, from its analysis. Its kind always matches the station the step
 * gets (bashStationOf). Exported so specs can check each station with a synthetic analysis.
 */
export function sceneForBash(a: BashAnalysis, command: string, ctx: ExplainCtx, isBackground = false): SceneData {
  const cmd = typeof command === 'string' ? command : ''
  try {
    return bashScene(a, cmd, normCtx(ctx), isBackground === true)
  } catch {
    return { kind: 'run', command: cut(cmd, SCENE_COMMAND_MAX), category: 'other' }
  }
}

/** The station a Bash step goes to: the analysis' own, unless it is not a place a command can be. */
export function bashStationOf(a: BashAnalysis): Station {
  const s = isObj(a) ? a.station : undefined
  return typeof s === 'string' && BASH_STATIONS.has(s) ? (s as Station) : 'run'
}

// ---------------------------------------------------------------- limits (from the contract)

const HEADLINE_MAX = 90
const WHY_MAX = 170
const DETAIL_MAX = 40
const NOTE_MAX = 120
const OUTPUT_MAX = 100
const DIFF_LINE_MAX = 70
const DIFF_LINES = 3
const SCENE_COMMAND_MAX = 2000
const SCENE_TEXT_MAX = 300
/** Bash keeps its raw command as target (applyEnd re-analyses it); bounded for odd input. */
const BASH_TARGET_MAX = 10_000
/** bash.ts sees at most this much of a command (the mod already cuts arguments to 4000 characters). */
const ANALYZE_MAX = 10_000
/** The mod cuts each string argument to this many characters: a string this long was probably cut. */
const ARG_CUT = 4000
/** ToolEnd.preview holds the first this-many characters of the result. */
const PREVIEW_CUT = 1500
/** applyEnd looks at no more of a preview than this. */
const PREVIEW_SEEN_MAX = 20_000

// ---------------------------------------------------------------- secrets (the final pass)

/**
 * Text with its secrets masked (redact.ts), never longer than `max` or than it was: a mask longer than
 * a tiny secret ('pw=x' -> 'pw=••••') is cut back rather than breaking a length limit.
 */
function hide(s: string, max = 0): string {
  if (typeof s !== 'string' || s === '') return typeof s === 'string' ? s : ''
  const r = redactSecrets(s)
  const lim = Math.max(s.length, max)
  return r.length <= lim ? r : cut(r, lim)
}

/** Scene fields that hold a word of the contract, not text: never touched. */
const SCENE_ENUM_KEYS: ReadonlySet<string> = new Set(['kind', 'category', 'status', 'state'])

/** A scene (or a part of one) with every string in it masked. */
function hideIn(v: unknown, depth: number): unknown {
  if (typeof v === 'string') return hide(v)
  if (v === null || typeof v !== 'object' || depth > 4) return v
  if (Array.isArray(v)) return v.map(x => hideIn(x, depth + 1))
  const out: { [k: string]: unknown } = {}
  for (const [k, x] of Object.entries(v)) out[k] = SCENE_ENUM_KEYS.has(k) ? x : hideIn(x, depth + 1)
  return out
}

/** The step with every string it shows masked: headline, why, target, detail, resultNote and the scene's text. */
function scrubbed(step: Step): Step {
  try {
    const out: Step = { ...step, scene: hideIn(step.scene, 0) as SceneData }
    if (typeof step.headline === 'string') out.headline = hide(step.headline, HEADLINE_MAX)
    if (typeof step.why === 'string') out.why = hide(step.why, WHY_MAX)
    // the target has no length limit: a Bash command keeps every character but its secrets
    if (typeof step.target === 'string') out.target = hide(step.target, Number.MAX_SAFE_INTEGER)
    if (typeof step.detail === 'string') out.detail = hide(step.detail, DETAIL_MAX)
    if (typeof step.resultNote === 'string') out.resultNote = hide(step.resultNote, NOTE_MAX)
    return out
  } catch {
    // an object too odd to copy: keep nothing it said
    let id = ''
    let startedAt = 0
    try {
      id = typeof step.id === 'string' ? step.id : ''
      startedAt = finite(step.startedAt) ?? 0
    } catch {
      // keep the defaults
    }
    return { id, tool: 'tool', station: 'tools', headline: 'Using a tool', why: WHY.generic[0], concepts: ['tool-calls'], scene: { kind: 'tools', name: 'tool' }, status: 'error', startedAt }
  }
}

// ---------------------------------------------------------------- input plumbing

type Args = { readonly [k: string]: unknown }
type In = { id: string; tool: string; args: Args; at: number; agentId?: string }
type Ctx = { level: Level; cwd?: string; readPaths: readonly unknown[] }
/** What one tool's explainer decides; finish() adds identity, status and limits. */
type Part = {
  station: Station
  headline: string
  why: string
  target?: string
  detail?: string
  /** candidate ids; ids() keeps registry ids only (false / undefined entries are skipped) */
  concepts: readonly unknown[]
  scene: SceneData
}
type EndPart = { note?: string; scene?: SceneData; detail?: string; keepRunning?: boolean }

const isObj = (v: unknown): v is Args => v !== null && typeof v === 'object' && !Array.isArray(v)
const obj = (v: unknown): Args => (isObj(v) ? v : {})
const arr = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined)
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const isTrue = (v: unknown): boolean => v === true || v === 'true'
const num = (v: unknown): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string' && /^\s*-?\d+(?:\.\d+)?\s*$/.test(v)) return Number(v)
  return undefined
}

function baseOf(obs: unknown): Omit<In, 'args'> {
  let id = ''
  let tool = 'tool'
  let at = 0
  let agentId: string | undefined
  try {
    const o = obj(obs)
    id = typeof o.id === 'string' ? o.id : typeof o.id === 'number' && Number.isFinite(o.id) ? String(o.id) : ''
    tool = typeof o.tool === 'string' && o.tool.trim() !== '' ? cut(flat(o.tool), 120) || 'tool' : 'tool'
    at = finite(o.at) ?? 0
    agentId = typeof o.agentId === 'string' && o.agentId !== '' ? o.agentId : undefined
  } catch {
    // a hostile object: keep the defaults
  }
  return agentId === undefined ? { id, tool, at } : { id, tool, at, agentId }
}

function argsOf(obs: unknown): Args {
  return obj(obj(obs).args)
}

function normCtx(ctx: unknown): Ctx {
  const c = obj(ctx)
  const level: Level = c.level === 1 || c.level === 2 || c.level === 3 ? c.level : 2
  const cwd = str(c.cwd)
  return cwd === undefined ? { level, readPaths: arr(c.readPaths) } : { level, cwd, readPaths: arr(c.readPaths) }
}

const STATIONS: ReadonlySet<string> = new Set(['think', 'plan', 'search', 'read', 'edit', 'run', 'web', 'delegate', 'tools', 'ask', 'talk', 'done', 'idle'])
/** Stations a shell command can stand at (thinking, answering and the recap are not commands). */
const BASH_STATIONS: ReadonlySet<string> = new Set(['plan', 'search', 'read', 'edit', 'run', 'web', 'delegate', 'tools', 'ask'])
const CATEGORIES: ReadonlySet<string> = new Set([
  'test', 'build', 'install', 'git', 'run-script', 'read-file', 'list-files', 'search', 'write-file', 'file-ops', 'process',
  'network', 'http', 'gpu', 'media', 'docker', 'database', 'env', 'wait', 'claude', 'other',
])
/** The scene kind each station draws. */
const SCENE_OF: Readonly<Record<Station, SceneData['kind']>> = {
  think: 'think', plan: 'plan', search: 'search', read: 'read', edit: 'edit', run: 'run', web: 'web',
  delegate: 'delegate', tools: 'tools', ask: 'ask', talk: 'talk', done: 'done', idle: 'idle',
}

function finish(o: In, p: Part): Step {
  const station: Station = STATIONS.has(p.station) ? p.station : 'tools'
  const scene: SceneData = p.scene.kind === SCENE_OF[station] ? p.scene : sceneFallback(station, o.tool)
  const step: Step = {
    id: o.id,
    tool: o.tool,
    station,
    headline: cut(flat(p.headline), HEADLINE_MAX) || cut(`Using ${o.tool}`, HEADLINE_MAX),
    why: cut(flat(p.why), WHY_MAX) || pick(o.id, WHY.generic),
    concepts: [],
    scene,
    status: 'running',
    startedAt: o.at,
  }
  if (o.agentId !== undefined) step.agentId = o.agentId
  if (p.target !== undefined && p.target !== '') step.target = p.target
  const detail = p.detail === undefined ? '' : cut(flat(p.detail), DETAIL_MAX)
  if (detail !== '') step.detail = detail
  const cs = ids(p.concepts)
  step.concepts = cs.length > 0 ? cs : ['tool-calls']
  return step
}

function sceneFallback(station: Station, tool: string): SceneData {
  switch (station) {
    case 'think': return { kind: 'think' }
    case 'plan': return { kind: 'plan', items: [] }
    case 'search': return { kind: 'search', query: '' }
    case 'read': return { kind: 'read', files: [] }
    case 'edit': return { kind: 'edit', path: '', removed: 0, added: 0, minus: [], plus: [], isNew: false }
    case 'run': return { kind: 'run', command: '', category: 'other' }
    case 'web': return { kind: 'web' }
    case 'delegate': return { kind: 'delegate', agents: [] }
    case 'ask': return { kind: 'ask', question: '', isPermission: false }
    case 'talk': return { kind: 'talk' }
    case 'done': return { kind: 'done', steps: 0, files: 0, seconds: 0, errors: 0 }
    case 'idle': return { kind: 'idle' }
    default: return { kind: 'tools', name: tool }
  }
}

/** Registry ids only, no duplicates, most specific first as given, at most 8. */
function ids(...lists: readonly (readonly unknown[] | undefined)[]): string[] {
  const out: string[] = []
  for (const list of lists) {
    for (const c of list ?? []) if (typeof c === 'string' && isConceptId(c) && !out.includes(c)) out.push(c)
  }
  return out.slice(0, 8)
}

// ---------------------------------------------------------------- text helpers

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-_]/g
// control, zero-width and bidi characters: never shown
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g
const WORDY_RE = /[\p{L}\p{N}]/u

/** One line of plain text: escapes and control characters dropped, whitespace runs collapsed. */
function flat(s: string, keep = 2000): string {
  if (typeof s !== 'string') return ''
  const src = s.length > keep ? s.slice(0, keep) : s
  return src.replace(ANSI_RE, '').replace(/\s+/g, ' ').replace(CTRL_RE, '').trim()
}

/**
 * flat, then its secrets masked: after flat, so escapes and zero-width characters cannot split a key,
 * and before any cut, so a cut can never leave part of one.
 */
const flatShown = (s: string): string => redactSecrets(flat(s))

/** Cut to n characters with an ellipsis (never splitting a surrogate pair). */
function cut(s: string, n: number): string {
  if (s.length <= n) return s
  if (n <= 1) return n === 1 ? '…' : ''
  let end = n - 1
  const code = s.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return s.slice(0, end).trimEnd() + '…'
}

/** Like cut, but ends at a word boundary when one is near. */
function cutWords(s: string, n: number): string {
  if (s.length <= n) return s
  const hard = cut(s, n)
  const body = hard.slice(0, -1)
  const space = body.lastIndexOf(' ')
  if (space < n * 0.6) return hard
  return body.slice(0, space).replace(/[\s,;:.(“"'\-–—]+$/, '') + '…'
}

/** Keep the tail: '…/auth/login.py'. */
const cutLeft = (s: string, n: number): string => (s.length > n ? '…' + s.slice(s.length - Math.max(0, n - 1)) : s)

const cap = (s: string): string => (s === '' ? s : s.charAt(0).toUpperCase() + s.slice(1))

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many)

/** '5 lines', '1 line', '40+ lines' (a count from a string the mod cut). */
const linesText = (n: number, isCut = false): string => `${n}${isCut ? '+' : ''} ${n === 1 && !isCut ? 'line' : 'lines'}`

/** prefix + “quoted” + suffix, the quoted part cut so the whole fits max (its secrets masked before the cut). */
function fitQuote(prefix: string, quoted: string, suffix = '', max = HEADLINE_MAX): string {
  const q = flatShown(quoted)
  const room = max - prefix.length - suffix.length - 2
  if (room < 4) return cut(`${prefix}“${q}”${suffix}`, max)
  return `${prefix}“${cutWords(q, room)}”${suffix}`
}

/** prefix + tail, the tail cut to fit (its secrets masked before the cut). */
function fitTail(prefix: string, tail: string, max = HEADLINE_MAX): string {
  const room = max - prefix.length
  const t = flatShown(tail)
  if (room < 4) return cut(prefix + t, max)
  return prefix + cutWords(t, room)
}

/** prefix + middle + suffix, the middle (a file name) cut from the left to fit (its secrets masked before the cut). */
function fitMiddle(prefix: string, middle: string, suffix = '', max = HEADLINE_MAX): string {
  const m = flatShown(middle)
  const room = max - prefix.length - suffix.length
  if (room < 4) return cut(prefix + m + suffix, max)
  return prefix + cutLeft(m, room) + suffix
}

/** Deterministic 32-bit FNV-1a hash. */
function hashOf(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/** One of the variants, chosen by the call id (stable across redraws and replays). */
const pick = (id: string, variants: readonly [string, string]): string => variants[hashOf(id) % 2] ?? variants[0]

/** 90 s, 10 min, 2 h */
function duration(seconds: number): string {
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))} s`
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`
  return `${Math.round(seconds / 3600)} h`
}

function lineCount(s: string): number {
  if (s === '') return 0
  let n = 1
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++
  return s.endsWith('\n') ? n - 1 : n
}

/** Up to `cap` lines (a trailing newline ends the last line rather than starting another). */
function splitLines(s: string, max: number): string[] {
  if (s === '') return []
  const whole = s.length <= 200_000
  const src = whole ? s : s.slice(0, 200_000)
  const out = src.split('\n', max + 1)
  if (out.length > max) return out.slice(0, max)
  if (whole && s.endsWith('\n')) out.pop()
  return out
}

/** The first lines of a diff side as the edit scene shows them: no leading blanks, tabs as spaces, secrets masked, cut to 70. */
function diffLines(lines: readonly string[]): string[] {
  let i = 0
  while (i < lines.length && (lines[i] ?? '').trim() === '') i++
  return lines.slice(i, i + DIFF_LINES).map(l =>
    cut(redactSecrets(l.slice(0, 400).replace(/\t/g, '  ').replace(ANSI_RE, '').replace(/\r/g, '').replace(CTRL_RE, '').trimEnd()), DIFF_LINE_MAX),
  )
}

// ---------------------------------------------------------------- paths

function normPath(p: string): string {
  let s = p.replace(CTRL_RE, '').replace(/[\r\n\t]/g, '').trim()
  if (/^[A-Za-z]:[\\/]|^\\\\/.test(s)) s = s.replace(/\\/g, '/')
  s = s.replace(/\/{2,}/g, '/').replace(/\/\.(?=\/|$)/g, '')
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  return s
}

function homeShort(p: string): string {
  const m = /^(?:\/home\/[^/]+|\/Users\/[^/]+|\/root|[A-Za-z]:\/Users\/[^/]+)(?=\/|$)/.exec(p)
  return m ? '~' + p.slice(m[0].length) : p
}

/** Keep the last whole segments that fit, after a leading '…/'. */
function tailCut(p: string, lim: number): string {
  if (p.length <= lim) return p
  const parts = p.split('/')
  let out = parts[parts.length - 1] ?? ''
  if (out.length + 2 > lim) return '…' + out.slice(out.length - (lim - 1))
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = `${parts[i] ?? ''}/${out}`
    if (next.length + 2 > lim) break
    out = next
  }
  return '…/' + out
}

/** An absolute, normalised key for comparing paths. */
function absKey(p: string, cwd?: string): string {
  let s = normPath(p)
  if (cwd !== undefined && !s.startsWith('/') && !s.startsWith('~') && !/^[A-Za-z]:\//.test(s)) s = `${normPath(cwd)}/${s}`
  const out: string[] = []
  for (const seg of s.split('/')) {
    if (seg === '..') {
      if (out.length > 1) out.pop()
    } else if (seg !== '.') out.push(seg)
  }
  return out.join('/') || '/'
}

function wasRead(path: string, c: Ctx): boolean {
  if (path === '' || c.readPaths.length === 0) return false
  const key = absKey(path, c.cwd)
  for (let i = c.readPaths.length - 1, seen = 0; i >= 0 && seen < 2000; i--, seen++) {
    const r = c.readPaths[i]
    if (typeof r === 'string' && (r === path || absKey(r, c.cwd) === key)) return true
  }
  return false
}

function baseName(p: string): string {
  const s = normPath(p)
  const i = s.lastIndexOf('/')
  return i >= 0 ? s.slice(i + 1) : s
}

const extOf = (base: string): string => {
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}

/** Plan mode keeps its plan in ~/.claude/plans/<random-slug>.md: the slug means nothing to a person. */
const PLAN_FILE_RE = /\/\.claude\/plans\/[^/]+\.md$/i

/** Names many files share: shown with their folder ('code-review/SKILL.md'). */
const GENERIC_NAME_RE =
  /^(?:index\.[\w.]+|__init__\.py|__main__\.py|mod\.rs|skill\.md|readme(?:\.\w+)?|claude\.md|agents\.md|memory\.md|conftest\.py|\+?page\.\w+|\+?layout\.\w+|route\.\w+|plugin\.json|hooks\.json)$/i

/** The file as a headline names it: 'login.py', 'code-review/SKILL.md' for generic names, 'the plan' for a plan file. */
function fileLabel(path: string, max = 60): string {
  if (PLAN_FILE_RE.test(normPath(path))) return 'the plan'
  const parts = normPath(path).split('/').filter(x => x !== '')
  const base = parts[parts.length - 1] ?? ''
  const parent = parts[parts.length - 2]
  const label = GENERIC_NAME_RE.test(base) && parent !== undefined && parent !== '~' ? `${parent}/${base}` : base
  return cutLeft(label, max)
}

// ---------------------------------------------------------------- file-type concepts

const WEIGHTS_EXT: ReadonlySet<string> = new Set(['pt', 'pth', 'safetensors', 'ckpt', 'gguf', 'onnx'])
const AUDIO_EXT: ReadonlySet<string> = new Set(['wav', 'flac', 'mp3', 'ogg', 'm4a', 'opus', 'aac', 'aiff'])
const IMAGE_EXT: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'ico', 'heic', 'avif'])
const TS_EXT: ReadonlySet<string> = new Set(['ts', 'tsx', 'mts', 'cts'])
const ARCHIVE_EXT: ReadonlySet<string> = new Set(['tar', 'tgz', 'gz', 'zip', 'zst', 'bz2', 'xz', '7z'])

/** special: what the file is for (secrets, memory, tests...); format: what it is written in. */
function pathConcepts(path: unknown): { special: string[]; format: string[] } {
  const special: string[] = []
  const format: string[] = []
  if (typeof path !== 'string' || path.trim() === '') return { special, format }
  const lower = normPath(path).toLowerCase()
  const slashed = lower.startsWith('/') ? lower : '/' + lower
  const b = baseName(lower)
  const ext = extOf(b)
  if (/^\.env(?:\.|rc$|$)|\.env$/.test(b)) special.push('secrets-hygiene', 'config-files')
  if (b === 'skill.md') special.push('skills')
  // auto-memory lives in ~/.claude/projects/<project>/memory/*.md; a source folder named memory/ is not it
  if (b === 'claude.md' || b === 'memory.md' || b === 'agents.md' || (slashed.includes('/memory/') && (ext === 'md' || slashed.includes('/.claude/')))) {
    special.push('agent-memory')
  }
  if (slashed.includes('/.claude/plans/')) special.push('plan-mode')
  if ((b === 'plugin.json' && slashed.includes('/.claude-plugin/')) || b === 'hooks.json') special.push('hooks-mods')
  if (/\/\.claude\/settings(?:\.local)?\.json$/.test(slashed)) special.push('permissions', 'config-files')
  if (slashed.includes('/scratchpad/') || slashed.endsWith('/scratchpad')) special.push('scratchpad')
  if (
    /\/(?:tests?|__tests__|spec)\//.test(slashed) ||
    /^test_.*\.py$|_test\.(?:py|go|rb|rs|[cm]?[jt]sx?)$|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(b) ||
    b === 'conftest.py'
  ) special.push('tests')
  if (ext === 'log' || slashed.includes('/logs/') || slashed.includes('/log/')) special.push('reading-logs')
  if (WEIGHTS_EXT.has(ext) || (ext === 'bin' && /model|weight|ckpt|checkpoint|adapter|lora|pytorch|safetensor/.test(lower))) special.push('model-checkpoints')
  if (AUDIO_EXT.has(ext)) special.push('audio-basics')
  if (b === 'package.json') special.push('package-json')
  if (b === 'dockerfile' || b.startsWith('dockerfile.') || ext === 'dockerfile' || b === 'containerfile') special.push('dockerfile')
  if (/^docker-compose.*\.ya?ml$|^compose(?:\.[\w-]+)?\.ya?ml$/.test(b)) special.push('docker-compose')
  if (b === '.gitignore') special.push('gitignore')
  if (/^requirements.*\.txt$/.test(b) || b === 'pyproject.toml' || b === 'pipfile') special.push('pip')
  if (/^(?:config|settings)\.\w+$/.test(b) || ext === 'ini' || ext === 'cfg' || ext === 'conf') special.push('config-files')
  if (TS_EXT.has(ext) || b === 'tsconfig.json') format.push('typescript')
  if (ext === 'json' || ext === 'jsonc' || ext === 'json5') format.push('json')
  if (ext === 'jsonl' || ext === 'ndjson') format.push('jsonl')
  if (ext === 'yaml' || ext === 'yml') format.push('yaml')
  if (ext === 'toml') format.push('toml')
  if (ext === 'csv' || ext === 'tsv') format.push('csv')
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') format.push('markdown')
  if (ext === 'sh' || ext === 'bash' || ext === 'zsh') format.push('shell-basics')
  if (ext === 'sql') format.push('sql-queries')
  if (ext === 'db' || ext === 'sqlite' || ext === 'sqlite3') format.push('sqlite')
  if (ext === 'diff' || ext === 'patch') format.push('diff')
  if (ARCHIVE_EXT.has(ext)) format.push('tar-zip')
  return { special, format }
}

// ---------------------------------------------------------------- why sentences (two variants each)

const WHY = {
  read: [
    'Claude reads the file before changing or explaining it, so its next step rests on what the code really says, not on a guess.',
    'Reading the actual file gives Claude the facts it needs, such as names, structure and details, before it decides what to do.',
  ],
  readRange: [
    'Reading just the lines that matter keeps Claude’s context small and focused on the part of the file it needs.',
    'A long file is read in slices: Claude jumps to the region it cares about instead of loading everything.',
  ],
  image: [
    'Claude can look at images: a screenshot, chart or diagram shows things no text description captures.',
    'Viewing the picture itself lets Claude check what it really shows instead of guessing from its name.',
  ],
  pdf: [
    'Reading the document directly lets Claude quote and use its real content instead of guessing.',
    'Claude reads only the pages it needs, which keeps a long document from flooding its context.',
  ],
  edit: [
    'An Edit swaps one exact snippet for another, so the change is small, easy to review and easy to undo.',
    'Changing only the lines that need it keeps the rest of the file untouched and the diff easy to check.',
  ],
  editAll: [
    'Replacing every occurrence at once keeps a rename consistent across the whole file.',
    'One replace-all edit changes every copy of the text, so none is missed or left behind.',
  ],
  create: [
    'Writing a whole file at once is the quickest way to create something new: a script, a config or a note.',
    'Claude creates the file with its complete content, ready to run, test or read.',
  ],
  rewrite: [
    'When most of a file changes, rewriting it whole is simpler and safer than many small edits.',
    'Claude replaces the file’s full content; it read the file first, so it knows what it is replacing.',
  ],
  agent: [
    'A sub-agent works on a side task with its own fresh context, so the main conversation stays focused.',
    'Handing a self-contained job to a helper agent lets work run in parallel and keeps the main context small.',
  ],
  workflow: [
    'A workflow fans a big job out to many agents at once, such as readers, builders and reviewers, then gathers their results.',
    'A scripted multi-agent run splits large work into parallel pieces, each handled and checked by its own agent.',
  ],
  todo: [
    'A visible task list keeps long work on track: you can see what is done, what is happening and what is next.',
    'Writing the plan down helps Claude not forget steps and shows you its progress at a glance.',
  ],
  task: [
    'Tracking work as tasks keeps a long job organised and shows you what is left.',
    'Each task is one clear piece of the plan, so progress is easy to follow.',
  ],
  planEnter: [
    'In plan mode Claude explores and designs first, and changes nothing until you approve the plan.',
    'Planning before acting catches wrong turns early, while they are still cheap to fix.',
  ],
  planExit: [
    'Claude shows you its plan before touching anything, so you can steer it while changes are still cheap.',
    'You approve or adjust the plan first; only then does Claude start making changes.',
  ],
  ask: [
    'Some choices are yours to make. Asking now is cheaper than guessing wrong and redoing the work.',
    'Claude asks when a decision depends on what you want, rather than picking for you.',
  ],
  webSearch: [
    'Searching the web grounds the answer in current facts instead of what the model remembers from training.',
    'A quick search finds up-to-date docs, versions and answers that may be newer than the model’s training.',
  ],
  webFetch: [
    'Reading the page itself gives Claude exact, current details instead of relying on memory.',
    'Fetching the source lets Claude quote real facts, versions and examples from it.',
  ],
  skill: [
    'A skill is a packaged set of instructions for this kind of task; loading it gives Claude the right playbook.',
    'Skills hold know-how that Claude loads only when it needs it, which keeps its context lean.',
  ],
  toolLoad: [
    'Some tools stay unloaded until needed; loading their definitions now lets Claude call them correctly.',
    'Deferred tools keep the context small: Claude fetches a tool’s instructions only when it is about to use it.',
  ],
  toolFind: [
    'Claude looks through the tools it could load, to find the right one for the job.',
    'Searching the tool list lets Claude discover a capability it has not loaded yet.',
  ],
  monitor: [
    'A monitor watches a long job’s output and alerts Claude on each event, so it need not poll or sit and wait.',
    'Watching the job in the background lets Claude keep working and react the moment something happens.',
  ],
  taskStop: [
    'Stopping a background job frees the machine and avoids work that is no longer needed.',
    'Background jobs run until they finish or are stopped; Claude stops this one on purpose.',
  ],
  taskCheck: [
    'Claude checks on a job running in the background to see whether it is done and what it printed.',
    'Peeking at a background job’s output tells Claude whether to wait, move on or fix something.',
  ],
  schedule: [
    'Instead of waiting idle, Claude schedules a check for later, when results are likely ready.',
    'A timer lets work happen later or repeatedly without anyone having to remember it.',
  ],
  message: [
    'Agents coordinate by sending messages: handing over results or asking a teammate to do something.',
    'Messaging another agent passes information along without stuffing everything into one context.',
  ],
  handback: [
    'When a helper agent finishes, it hands its report back so the main agent can use the result.',
    'The sub-agent returns only its findings, so the main conversation gets the answer without the noise.',
  ],
  structured: [
    'A fixed JSON shape lets the program that called this agent read its answer reliably.',
    'Structured output turns the agent’s findings into fields that other code can check and combine.',
  ],
  artifact: [
    'A published page turns results into something you can open, read and share outside the chat.',
    'Artifacts present work as a page, such as a report or a dashboard, which is easier to read than terminal text.',
  ],
  artifactData: [
    'A page keeps its records in a small shared database, so they can change without republishing the page.',
    'Updating the page’s data, not its code, keeps the published page live and current.',
  ],
  notebook: [
    'Changing one notebook cell keeps the rest of the notebook and its outputs intact.',
    'Notebooks are edited cell by cell, so each change stays small and easy to rerun.',
  ],
  memory: [
    'Memory files carry facts across sessions, so Claude need not rediscover them every time.',
    'Writing down what it learned helps Claude, and you, pick up where things were left.',
  ],
  worktree: [
    'A separate worktree gives the work its own copy of the repository, so experiments do not disturb your files.',
    'Working in its own git worktree lets Claude change files freely and merge only what works.',
  ],
  mcp: [
    'Connectors (MCP) let Claude use outside services such as docs, trackers and browsers through one standard protocol.',
    'Through an MCP connector Claude can reach a service it has no built-in tool for.',
  ],
  grep: [
    'Searching narrows a big codebase to the few places that matter, so Claude reads only what is relevant.',
    'Finding every place a name appears shows Claude where to look, and what a change might affect, before it reads.',
  ],
  glob: [
    'Listing files by name pattern shows what exists before Claude decides what to read.',
    'A file pattern such as **/*.py maps out a project quickly without opening every folder.',
  ],
  lsp: [
    'The language server knows the code’s structure, so Claude can jump to definitions and uses precisely.',
    'Asking the language server is faster and more exact than searching text for a symbol.',
  ],
  talk: [
    'Claude reports to you directly, so you see the result without digging through the session.',
    'Keeping you in the loop means you can react early instead of finding out at the end.',
  ],
  review: [
    'Reporting findings in a fixed form makes each one easy to check, fix or dismiss.',
    'A review is only useful if its findings are clear: where, what goes wrong and why.',
  ],
  bash: [
    'Claude runs a shell command to inspect or change things directly on the machine.',
    'The shell is Claude’s most flexible tool: one command can check, build or run almost anything.',
  ],
  generic: [
    'Claude acts through tools: it calls one, reads the result, then decides what to do next.',
    'Each tool call is one concrete action; its result shapes Claude’s next step.',
  ],
} as const

// ---------------------------------------------------------------- dispatch

function explainBy(o: In, c: Ctx): Part {
  const t = o.tool
  switch (t) {
    case 'Bash': return explainBash(o, c)
    case 'Read': case 'NotebookRead': return explainRead(o, c)
    case 'Edit': return explainEdit(o, c)
    case 'MultiEdit': return explainMultiEdit(o, c)
    case 'Write': return explainWrite(o, c)
    case 'NotebookEdit': return explainNotebookEdit(o, c)
    case 'Agent': case 'Task': return explainAgent(o)
    case 'Workflow': return explainWorkflow(o)
    case 'TodoWrite': return explainTodos(o)
    case 'TaskCreate': case 'TaskUpdate': case 'TaskList': case 'TaskGet': return explainTask(o)
    case 'EnterPlanMode': return explainEnterPlan(o)
    case 'ExitPlanMode': return explainExitPlan(o)
    case 'AskUserQuestion': return explainAsk(o)
    case 'WebSearch': return explainWebSearch(o)
    case 'WebFetch': return explainWebFetch(o)
    case 'Skill': return explainSkill(o)
    case 'ToolSearch': return explainToolSearch(o)
    case 'Monitor': return explainMonitor(o)
    case 'TaskStop': case 'KillShell': case 'KillBash': return explainTaskStop(o)
    case 'TaskOutput': case 'BashOutput': case 'GetTask': return explainTaskCheck(o)
    case 'ScheduleWakeup': return explainWakeup(o)
    case 'CronCreate': case 'CronDelete': case 'CronList': return explainCron(o)
    case 'SendMessage': return explainSendMessage(o)
    case 'SubagentHandback': return explainHandback(o)
    case 'ListAgents': return explainListAgents(o)
    case 'StructuredOutput': return explainStructured(o)
    case 'Artifact': return explainArtifact(o)
    case 'ArtifactData': case 'ArtifactComments': case 'ArtifactCheck': return explainArtifactData(o)
    case 'memory_list': case 'memory_read': case 'memory_write': return explainMemory(o, c)
    case 'EnterWorktree': case 'ExitWorktree': return explainWorktree(o)
    case 'Grep': return explainGrep(o, c)
    case 'Glob': return explainGlob(o, c)
    case 'LS': return explainLs(o, c)
    case 'LSP': return explainLsp(o, c)
    case 'SendUserFile': case 'SendFile': case 'SendUserMessage': case 'PushNotification': return explainTalk(o)
    case 'ReportFindings': return explainFindings(o)
    case 'WaitForMcpServers': case 'ListMcpResourcesTool': case 'ReadMcpResourceTool': case 'ReadMcpResourceDirTool':
    case 'ListConnectors': case 'SearchMcpRegistry': case 'SuggestConnectors':
      return explainConnectorAdmin(o)
    case 'ListSkills': case 'SearchSkills': case 'SuggestSkills': case 'propose_skills': return explainSkillAdmin(o)
  }
  if (t.startsWith('mcp__')) return explainMcp(o)
  if (t.startsWith('enable__mcp__')) return explainEnableMcp(o)
  return genericPart(t, o.id)
}

function genericPart(tool: string, id: string): Part {
  return {
    station: 'tools',
    headline: fitTail('Using ', tool),
    why: pick(id, WHY.generic),
    concepts: ['tool-calls'],
    scene: { kind: 'tools', name: cut(flat(tool), 80) || 'tool' },
  }
}

// ---------------------------------------------------------------- Bash

/**
 * The analyses of the last few commands, by command text: applyEnd reuses the one explainTool made, since
 * analyzeBash is most of the cost of a Bash step. Same input, same output: this changes no result.
 */
const RECENT_ANALYSES = new Map<string, BashAnalysis>()
const RECENT_ANALYSES_MAX = 64

function remember(command: string, a: BashAnalysis): void {
  RECENT_ANALYSES.delete(command)
  RECENT_ANALYSES.set(command, a)
  if (RECENT_ANALYSES.size > RECENT_ANALYSES_MAX) {
    const oldest = RECENT_ANALYSES.keys().next()
    if (oldest.done !== true) RECENT_ANALYSES.delete(oldest.value)
  }
}

function analysisOf(command: string, description: string | undefined): BashAnalysis {
  const a = safeAnalysis(command, description)
  remember(command, a)
  // the step keeps the command with its secrets masked, and applyEnd looks the analysis up by that text
  const shown = redactSecrets(command)
  if (shown !== command && shown !== '') remember(shown, a)
  return a
}

/** The analysis explainTool made for this command, or a fresh one. */
const analysisAgain = (command: string): BashAnalysis => RECENT_ANALYSES.get(command) ?? safeAnalysis(command, undefined)

function safeAnalysis(command: string, description: string | undefined): BashAnalysis {
  try {
    const a = analyzeBash(command.length > ANALYZE_MAX ? command.slice(0, ANALYZE_MAX) : command, description?.slice(0, ANALYZE_MAX))
    if (isObj(a) && typeof a.headline === 'string') return a
  } catch {
    // fall through to the plain analysis
  }
  return {
    station: 'run',
    category: 'other',
    programs: [],
    headline: description ?? (command.split('\n', 1)[0] ?? ''),
    concepts: [],
    isBackground: false,
    isMultiline: command.includes('\n'),
    segments: 1,
    readsFiles: [],
    writesFiles: [],
    why: '',
  }
}

function explainBash(o: In, c: Ctx): Part {
  const command = typeof o.args.command === 'string' ? o.args.command : ''
  const description = str(o.args.description)
  const a = analysisOf(command.length > BASH_TARGET_MAX ? command.slice(0, BASH_TARGET_MAX) : command, description)
  const bg = isTrue(o.args.run_in_background)
  const station = bashStationOf(a)
  const said = description !== undefined ? flatShown(description) : ''
  const headline =
    (said !== '' ? cutWords(cap(said), HEADLINE_MAX) : '') ||
    cutWords(cap(flat(typeof a.headline === 'string' ? a.headline : '')), HEADLINE_MAX) ||
    (flat(command) !== '' ? fitTail('Running ', command) : 'Running a shell command')
  const scene = bashScene(a, command, c, bg)
  let concepts = ids(bg ? ['background-tasks'] : [], arr(a.concepts))
  if (concepts.length === 0) concepts = ['shell-basics']
  const p: Part = {
    station,
    headline,
    why: (typeof a.why === 'string' ? cut(flat(a.why), WHY_MAX) : '') || pick(o.id, WHY.bash),
    concepts,
    scene,
  }
  if (command !== '') p.target = command.length > BASH_TARGET_MAX ? command.slice(0, BASH_TARGET_MAX) : command
  const detail = bashDetail(a, scene, bg, command)
  if (detail !== undefined) p.detail = detail
  return p
}

function bashDetail(a: BashAnalysis, scene: SceneData, bg: boolean, command: string): string | undefined {
  switch (scene.kind) {
    case 'read':
      return scene.files.length > 1 ? `${scene.files.length} files` : scene.files[0]?.detail
    case 'edit': {
      const { files, folders } = writtenPaths(a, command)
      const n = files.length
      if (n > 1) return `${n} files`
      if (n === 0 && folders.length > 1) return `${folders.length} folders`
      if (scene.added > 0) return `+${scene.added}`
      return scene.removed > 0 ? `−${scene.removed}` : undefined
    }
    case 'web':
      return scene.domain
    case 'run':
      return bg || scene.isBackground === true ? 'in the background' : str(a.primary) !== undefined ? flat(String(a.primary)) : undefined
    default:
      return undefined
  }
}

function bashScene(a: BashAnalysis, command: string, c: Ctx, bg: boolean): SceneData {
  const station = bashStationOf(a)
  const primary = str(a.primary) !== undefined ? cut(flat(String(a.primary)), 80) : undefined
  switch (station) {
    case 'read': {
      const files: { path: string; detail?: string }[] = []
      for (const f of [...new Set(arr(a.readsFiles).filter(isStr))].slice(0, 6)) {
        const detail = lineRangeIn(command, f)
        files.push(detail === undefined ? { path: displayPath(f, c.cwd) } : { path: displayPath(f, c.cwd), detail })
      }
      if (files.length === 0 && str(a.target) !== undefined) files.push({ path: displayPath(String(a.target), c.cwd) })
      return { kind: 'read', files }
    }
    case 'search': {
      // a listing (ls, find with no name pattern, tree) has no search term: every name in a place
      const listing = a.category === 'list-files' && str(a.searchQuery) === undefined
      const query = listing ? '*' : cut(flat(str(a.searchQuery) ?? str(a.target) ?? primary ?? ''), SCENE_TEXT_MAX)
      const where = str(a.searchWhere) ?? (listing ? str(a.target) : undefined)
      if (where === undefined) return { kind: 'search', query }
      const shown = displayPath(where, c.cwd)
      if (shown === '.' || shown === '') return { kind: 'search', query, where: 'the current folder' }
      return { kind: 'search', query, where: listing && extOf(baseName(shown)) === '' && !shown.endsWith('/') ? `${shown}/` : shown }
    }
    case 'edit': {
      const { files: written, folders } = writtenPaths(a, command)
      const docs = heredocsIn(command)
      // the written file a heredoc's line names, else the file a sed -i edits, else the first written file
      let path = written[0] ?? ''
      let doc = docs[0]
      const named = written.map(f => ({ f, d: docs.find(d => namesFile(d.intro, f)) })).find(x => x.d !== undefined)
      if (named !== undefined) {
        path = named.f
        doc = named.d
      }
      const sub = named === undefined ? sedSubstitution(command) : undefined
      if (sub !== undefined) {
        const seg = segmentAround(command, Math.min(sub.end, command.length - 1))
        path = written.find(f => { const m = mentionOf(seg, f); return m !== undefined && m.length >= 2 }) ?? path
        const minus = diffLines(splitLines(sub.from, 12))
        const plus = diffLines(splitLines(sub.to, 12))
        return { kind: 'edit', path: displayPath(path, c.cwd), removed: Math.max(1, minus.length), added: Math.max(1, plus.length), minus, plus, isNew: false }
      }
      if (doc === undefined && path !== '') {
        // echo / printf into a file (> or >>, or through tee): its text is the change
        const r = redirectWrite(command, path)
        if (r !== undefined) {
          const plus = diffLines(r.lines)
          return { kind: 'edit', path: displayPath(path, c.cwd), removed: 0, added: r.lines.length, minus: [], plus, isNew: !r.isAppend && !wasRead(path, c) }
        }
      }
      if (doc === undefined && path === '') {
        // no file written: a folder made, or files deleted. The change is to the file tree.
        if (folders.length > 0) {
          const plus = diffLines(folders.slice(0, 12).map(d => `${displayPath(d, c.cwd)}/`))
          return { kind: 'edit', path: displayPath(folders[0] ?? '', c.cwd), removed: 0, added: folders.length, minus: [], plus, isNew: false }
        }
        const gone = removedPaths(command)
        const shown = gone.length > 0 ? gone : str(a.target) !== undefined ? [String(a.target)] : []
        if (shown.length > 0) {
          const minus = diffLines(shown.slice(0, 12).map(g => displayPath(g, c.cwd) || g))
          return { kind: 'edit', path: displayPath(shown[0] ?? '', c.cwd) || (shown[0] ?? ''), removed: shown.length, added: 0, minus, plus: [], isNew: false }
        }
      }
      return {
        kind: 'edit',
        path: displayPath(path, c.cwd),
        removed: 0,
        added: doc === undefined ? 0 : lineCount(doc.body),
        minus: [],
        plus: doc === undefined ? [] : diffLines(splitLines(doc.body, 12)),
        isNew: path === '' || doc?.isAppend === true || appendsTo(command, path) ? false : !wasRead(path, c),
      }
    }
    case 'web': {
      const url = URL_RE.exec(command)?.[0] ?? (str(a.target) !== undefined && /^[\w.-]+\.[a-z]{2,}(?:[/:]|$)/i.test(String(a.target)) ? String(a.target) : undefined)
      // a url built from a variable ('$API_URL/v1/items') still says where the request goes
      if (url === undefined) return str(a.target) !== undefined ? { kind: 'web', url: cut(safeUrl(flat(String(a.target))), SCENE_TEXT_MAX) } : { kind: 'web' }
      const host = hostOf(url)
      const shown = cut(safeUrl(url), SCENE_TEXT_MAX)
      return host === undefined ? { kind: 'web', url: shown } : { kind: 'web', url: shown, domain: host }
    }
    case 'plan':
      return { kind: 'plan', items: [] }
    case 'delegate':
      return { kind: 'delegate', agents: [{ label: primary ?? 'agent', status: 'running' }] }
    case 'tools':
      return primary === undefined ? { kind: 'tools', name: 'shell' } : { kind: 'tools', name: primary }
    case 'ask':
      return { kind: 'ask', question: cut(flat(typeof a.headline === 'string' ? a.headline : ''), SCENE_TEXT_MAX), isPermission: false }
    default: {
      const category: BashCategory = typeof a.category === 'string' && CATEGORIES.has(a.category) ? a.category : 'other'
      const scene: SceneData = { kind: 'run', command: cut(command, SCENE_COMMAND_MAX), category, isBackground: bg || a.isBackground === true }
      if (primary !== undefined) scene.program = primary
      return scene
    }
  }
}

const URL_RE = /\bhttps?:\/\/[^\s'"`<>|;)\\]+/i

/** A url fit to show: no user:password@, and secret-looking query values masked. */
function safeUrl(url: string): string {
  return url
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/?#\s]*@/i, '$1')
    .replace(/([?&](?:[\w-]*(?:token|key|secret|password|passwd|pwd|auth|sig|signature|session|credential)[\w-]*)=)[^&#\s]*/gi, '$1…')
}

/** 'docs.python.org' from a url (www. dropped), without the URL class (not every engine has it). */
function hostOf(url: string): string | undefined {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/?#\s]*@)?(\[[^\]]+\]|[^:/?#\s]+)/i.exec(url.trim())
  const host = m?.[1]?.toLowerCase().replace(/^www\./, '')
  return host === undefined || host === '' ? undefined : host
}

/** The simple command (between unquoted ; | & newline) around position idx. */
function segmentAround(command: string, idx: number): string {
  let start = 0
  let quote = ''
  for (let i = 0; i < idx; i++) {
    const ch = command[i]
    if (quote !== '') {
      if (ch === quote) quote = ''
      else if (ch === '\\' && quote === '"') i++
      continue
    }
    if (ch === "'" || ch === '"') quote = ch
    else if (ch === '\\') i++
    else if (ch === '|' || ch === ';' || ch === '&' || ch === '\n' || ch === '(' || ch === ')') start = i + 1
  }
  let end = command.length
  for (let i = idx; i < command.length; i++) {
    const ch = command[i]
    if (ch === '|' || ch === ';' || ch === '&' || ch === '\n') {
      end = i
      break
    }
  }
  return command.slice(start, end)
}

/** 'lines 10–40' when the command reads only part of `file` (sed -n, head, tail, awk NR); every mention counts. */
function lineRangeIn(command: string, file: string): string | undefined {
  const found: string[] = []
  const said = mentionOf(command, file)
  if (said === undefined) return undefined
  for (let idx = command.indexOf(said), n = 0; idx >= 0 && idx <= 20_000 && n < 6; idx = command.indexOf(said, idx + said.length), n++) {
    const r = rangeIn(segmentAround(command, idx))
    if (r !== undefined && !found.includes(r)) found.push(r)
  }
  return found.length === 0 ? undefined : cut(found.join(', '), DETAIL_MAX)
}

/** How the command spells `file`: as given, else its longest path suffix that appears (bash.ts may resolve paths). */
function mentionOf(command: string, file: string): string | undefined {
  if (command.includes(file)) return file
  const parts = normPath(file).split('/').filter(x => x !== '')
  for (let i = 1; i < parts.length; i++) {
    const tail = parts.slice(i).join('/')
    if (tail.length >= 3 && command.includes(tail)) return tail
  }
  return undefined
}

/** The line range one simple command reads: sed -n 'a,bp', head -n N, tail -n N, awk 'NR>=a && NR<=b'. */
function rangeIn(seg: string): string | undefined {
  let m = /\bsed\b[^|;&\n]*?-n\s*(?:-e\s*)?['"]?\s*(\d+)\s*(?:,\s*(\d+|\$)\s*)?p\b/.exec(seg)
  if (m) {
    const a = Number(m[1])
    if (m[2] === undefined) return `line ${a}`
    if (m[2] === '$') return `from line ${a}`
    const b = Number(m[2])
    return b > a ? `lines ${a}–${b}` : `line ${a}`
  }
  m = /\bawk\b[^|;&\n]*?NR\s*(>=?)\s*(\d+)\s*&&\s*NR\s*(<=?)\s*(\d+)/.exec(seg)
  if (m) {
    const a = Number(m[2]) + (m[1] === '>' ? 1 : 0)
    const b = Number(m[4]) - (m[3] === '<' ? 1 : 0)
    return b > a ? `lines ${a}–${b}` : `line ${a}`
  }
  m = /\bawk\b[^|;&\n]*?NR\s*==\s*(\d+)/.exec(seg)
  if (m) return `line ${m[1]}`
  m = /\bhead\b(?:\s+-n\s*|\s+-|\s+--lines=)(\d+)/.exec(seg)
  if (m) return m[1] === '1' ? 'line 1' : `lines 1–${m[1]}`
  if (/\bhead\b/.test(seg)) return 'lines 1–10'
  m = /\btail\b(?:\s+-n\s*|\s+--lines=)\+(\d+)/.exec(seg)
  if (m) return `from line ${m[1]}`
  m = /\btail\b(?:\s+-n\s*|\s+-|\s+--lines=)(\d+)/.exec(seg)
  if (m) return m[1] === '1' ? 'last line' : `last ${m[1]} lines`
  return undefined
}

// <<EOF, <<-'EOF', << "EOF" (a here-string <<< is not a heredoc)
const HEREDOC_RE = /<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z_][\w.-]*))/g

type Heredoc = { intro: string; body: string; isAppend: boolean }

/** The heredocs that write a file (their line redirects with > or tee): intro line, body, and whether they append. */
function heredocsIn(command: string): Heredoc[] {
  const src = command.length > 50_000 ? command.slice(0, 50_000) : command
  const out: Heredoc[] = []
  HEREDOC_RE.lastIndex = 0
  for (let m = HEREDOC_RE.exec(src), n = 0; m !== null && n < 20; m = HEREDOC_RE.exec(src), n++) {
    if (src[m.index - 1] === '<') continue
    const delim = m[2] ?? m[3] ?? m[4] ?? ''
    const lineStart = src.lastIndexOf('\n', m.index) + 1
    const nl = src.indexOf('\n', m.index)
    if (nl < 0 || delim === '') continue
    const intro = src.slice(lineStart, nl)
    const redirects = intro.replace(/\d?>&\d|&>\s*\/dev\/null|\d?>\s*\/dev\/null/g, '')
    const writes = />/.test(redirects) || /\btee\b/.test(intro)
    const lines: string[] = []
    let i = nl + 1
    let closed = false
    while (i <= src.length && lines.length < 5000) {
      const e = src.indexOf('\n', i)
      const line = src.slice(i, e < 0 ? src.length : e)
      if ((m[1] === '-' ? line.replace(/^\t+/, '') : line).trim() === delim) {
        closed = true
        break
      }
      lines.push(line)
      if (e < 0) break
      i = e + 1
    }
    HEREDOC_RE.lastIndex = Math.max(HEREDOC_RE.lastIndex, closed ? i : src.length)
    if (writes) out.push({ intro, body: lines.join('\n'), isAppend: />>/.test(redirects) || /\btee\s+(?:-\w*a|--append)/.test(intro) })
  }
  return out
}

/** sed -i 's/from/to/' → { from, to, end: where the expression ends in the command } */
function sedSubstitution(command: string): { from: string; to: string; end: number } | undefined {
  const m = /\bsed\b[^|;&\n]*?\s(?:-[a-zA-Z]*i[a-zA-Z.]*|--in-place\S*)\s[^|;&\n]*?(['"])s([/|#,:@!])((?:\\.|(?!\2)[^\\])*)\2((?:\\.|(?!\2)[^\\])*)\2[a-zA-Z0-9]*(?:\1|\s*;)/.exec(
    command.length > 20_000 ? command.slice(0, 20_000) : command,
  )
  if (!m) return undefined
  const unescape = (x: string): string => x.replace(/\\(.)/g, (_, ch: string) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch))
  return { from: unescape((m[3] ?? '').replace(/^\^/, '').replace(/(?<!\\)\$$/, '')), to: unescape(m[4] ?? ''), end: m.index + m[0].length }
}

/** True when a simple command around a mention of `path` is a mkdir: the path is a folder it makes. */
function madeByMkdir(command: string, path: string): boolean {
  const said = mentionOf(command, path)
  if (said === undefined) return false
  for (let idx = command.indexOf(said), n = 0; idx >= 0 && n < 8; idx = command.indexOf(said, idx + said.length), n++) {
    if (/^\s*(?:sudo\s+)?mkdir\b/.test(segmentAround(command, idx))) return true
  }
  return false
}

/** What a command writes, split into files and the folders it makes (one a mkdir names, or one that holds another written path). */
function writtenPaths(a: BashAnalysis, command: string): { files: string[]; folders: string[] } {
  const all = [...new Set(arr(a.writesFiles).filter(isStr))]
  const trim = (p: string): string => p.replace(/\/+$/, '')
  const isFolder = (p: string): boolean => p.endsWith('/') || all.some(q => q !== p && trim(q).startsWith(trim(p) + '/')) || madeByMkdir(command, p)
  const folders = all.filter(isFolder)
  return { files: all.filter(p => !folders.includes(p)), folders }
}

/** True when a heredoc's opening line names this file (its name as a whole path segment, not inside another name). */
function namesFile(intro: string, file: string): boolean {
  const name = baseName(file)
  if (name === '') return false
  for (let i = intro.indexOf(name); i >= 0; i = intro.indexOf(name, i + 1)) {
    const before = intro[i - 1] ?? ' '
    const after = intro[i + name.length] ?? ' '
    if (/[\s/'"=>]/.test(before) && /[\s'";|&)]/.test(after)) return true
  }
  return false
}

/** The shell's own spelling of a file after a redirect: '>> f', '> "f"', 'tee -a f'. */
function redirectBefore(command: string, idx: number): { op: string; isAppend: boolean } | undefined {
  // the file may be spelled with a folder or a variable before the part the command shares with it ('>> $M/MEMORY.md')
  const m = /(>>|>\|?|\btee(?:\s+-{1,2}[\w-]+)*)\s*['"]?[^\s'"<>|;&]*$/.exec(command.slice(Math.max(0, idx - 200), idx))
  if (!m) return undefined
  const op = m[1] ?? ''
  return { op, isAppend: op === '>>' || /\btee\s.*(?:-\w*a\b|--append)/.test(op) }
}

/** True when the command appends to this file somewhere ('>> f', 'tee -a f'). */
function appendsTo(command: string, file: string): boolean {
  const said: string = file === '' ? '' : (mentionOf(command, file) ?? '')
  if (said === '') return false
  for (let idx = command.indexOf(said), n = 0; idx >= 0 && n < 8; idx = command.indexOf(said, idx + said.length), n++) {
    if (redirectBefore(command, idx)?.isAppend === true) return true
  }
  return false
}

/** The text an echo or printf in this simple command prints ('\n' in printf and echo -e splits lines). */
function printedText(seg: string): string[] | undefined {
  const m = /\b(echo|printf)\s+((?:-[neE]+\s+|--\s+)*)(?:(['"])((?:\\.|(?!\3)[^\\])*)\3|([^>|;&\n]+))/.exec(seg)
  if (!m) return undefined
  const raw = m[4] ?? (m[5] ?? '').trim()
  if (raw === '') return undefined
  const escapes = m[1] === 'printf' || /-\w*e/.test(m[2] ?? '')
  const text = escapes ? raw.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/%s$/, '') : raw
  return splitLines(text, 12).filter((l, i, all) => l.trim() !== '' || (i > 0 && i < all.length - 1))
}

/** An echo / printf written into `file` with > or >> (directly or through tee): its lines and whether it appends. */
function redirectWrite(command: string, file: string): { isAppend: boolean; lines: string[] } | undefined {
  const said: string = mentionOf(command, file) ?? ''
  if (said === '') return undefined
  for (let idx = command.indexOf(said), n = 0; idx >= 0 && n < 8; idx = command.indexOf(said, idx + said.length), n++) {
    const r = redirectBefore(command, idx)
    if (r === undefined) continue
    let seg = segmentAround(command, idx)
    if (/\btee\b/.test(r.op)) {
      // the text comes from the command piped into tee
      const start = command.lastIndexOf('|', idx)
      seg = start > 0 ? segmentAround(command, start - 1) : ''
    }
    const lines = printedText(seg)
    if (lines !== undefined && lines.length > 0) return { isAppend: r.isAppend, lines }
    return undefined
  }
  return undefined
}

/** The paths an rm deletes ('rm -rf build dist' → build, dist); find … -exec rm gives none. */
function removedPaths(command: string): string[] {
  const out: string[] = []
  const re = /(?:^|[;&|\n(]|\bsudo|\bxargs)\s*rm\s+([^;&|\n)]*)/g
  for (let m = re.exec(command), n = 0; m !== null && n < 10; m = re.exec(command), n++) {
    for (const w of (m[1] ?? '').trim().split(/\s+/)) {
      const p = w.replace(/^(['"])(.*)\1$/, '$2')
      if (p === '' || p.startsWith('-') || p === '{}' || p === '+' || p === ';' || /[<>]/.test(p)) continue
      if (!out.includes(p)) out.push(p)
      if (out.length >= 12) return out
    }
  }
  return out
}

// ---------------------------------------------------------------- files

function explainRead(o: In, c: Ctx): Part {
  const path = str(o.args.file_path) ?? str(o.args.notebook_path) ?? str(o.args.path) ?? ''
  const label = fileLabel(path)
  const ext = extOf(baseName(path))
  const offset = num(o.args.offset)
  const limit = num(o.args.limit)
  const pagesArg = str(o.args.pages) ?? (num(o.args.pages) !== undefined ? String(num(o.args.pages)) : undefined)
  let headline: string
  let detail: string | undefined
  let why: readonly [string, string] = WHY.read
  if (label === '') headline = 'Reading a file'
  else if (IMAGE_EXT.has(ext)) {
    headline = fitMiddle('Looking at the image ', label)
    why = WHY.image
  } else if (ext === 'pdf' && pagesArg !== undefined) {
    const pages = cut(flat(pagesArg).replace(/\s*-\s*/g, '–'), 24)
    const many = /[–,]/.test(pages)
    detail = `${many ? 'pages' : 'page'} ${pages}`
    headline = fitMiddle(`Reading ${detail} of `, label)
    why = WHY.pdf
  } else if (ext === 'pdf') {
    headline = fitMiddle('Reading ', label)
    why = WHY.pdf
  } else if (ext === 'ipynb') headline = fitMiddle('Reading the notebook ', label)
  else if (offset !== undefined || limit !== undefined) {
    const start = Math.max(1, Math.floor(offset ?? 1))
    if (limit !== undefined && limit >= 1) {
      const end = start + Math.floor(limit) - 1
      detail = end > start ? `lines ${start}–${end}` : `line ${start}`
      headline = fitMiddle(`Reading ${detail} of `, label)
    } else {
      detail = `from line ${start}`
      headline = fitMiddle('Reading ', label, ` ${detail}`)
    }
    why = WHY.readRange
  } else headline = fitMiddle('Reading ', label)
  const { special, format } = pathConcepts(path)
  const file = displayPath(path, c.cwd)
  const p: Part = {
    station: 'read',
    headline,
    why: pick(o.id, why),
    concepts: [...special, 'reading-code', ...format],
    scene: { kind: 'read', files: file === '' ? [] : [detail === undefined ? { path: file } : { path: file, detail }] },
  }
  if (path !== '') p.target = path
  if (detail !== undefined) p.detail = detail
  return p
}

type Diff = { removed: number; added: number; oldCut: boolean; newCut: boolean; minus: string[]; plus: string[]; onlyAdded?: number; onlyRemoved?: number }

/** Snippet sizes, plus the lines that really differ (common leading and trailing lines dropped). */
function diffOf(a: string, b: string): Diff {
  const oldCut = a.length >= ARG_CUT
  const newCut = b.length >= ARG_CUT
  const la = splitLines(a, 400)
  const lb = splitLines(b, 400)
  let p = 0
  while (p < la.length && p < lb.length && la[p] === lb[p]) p++
  let s = 0
  if (!oldCut && !newCut && la.length < 400 && lb.length < 400) {
    while (s < la.length - p && s < lb.length - p && la[la.length - 1 - s] === lb[lb.length - 1 - s]) s++
  }
  const ra = la.slice(p, la.length - s)
  const rb = lb.slice(p, lb.length - s)
  const same = ra.length === 0 && rb.length === 0
  // The counts are of the lines that really change, like a diff's (context lines Claude quoted to make
  // old_string unique are not changes). A snippet the mod cut, or a huge one, keeps its plain sizes.
  const exact = !same && !oldCut && !newCut && la.length < 400 && lb.length < 400
  const d: Diff = {
    removed: exact ? ra.length : lineCount(a),
    added: exact ? rb.length : lineCount(b),
    oldCut,
    newCut,
    minus: diffLines(same ? la : ra),
    plus: diffLines(same ? lb : rb),
  }
  if (!same && ra.length === 0) d.onlyAdded = rb.length
  if (!same && rb.length === 0) d.onlyRemoved = ra.length
  return d
}

function editWhat(oldS: string, newS: string, all: boolean, d: Diff): { what: string; detail?: string } {
  if (all) {
    const first = flat(oldS.split('\n', 1)[0] ?? '')
    return { what: first === '' ? 'replacing every match' : `replacing every “${first}${oldS.includes('\n') ? ' …' : ''}”`, detail: 'every match' }
  }
  if (oldS === '' && newS === '') return { what: '' }
  if (oldS === '') return { what: `adding ${linesText(d.added, d.newCut)}`, detail: `+${d.added}` }
  if (newS === '') return { what: `deleting ${linesText(d.removed, d.oldCut)}`, detail: `−${d.removed}` }
  if (d.onlyAdded !== undefined) return { what: `adding ${linesText(d.onlyAdded, d.newCut)}`, detail: `+${d.onlyAdded}` }
  if (d.onlyRemoved !== undefined) return { what: `removing ${linesText(d.onlyRemoved, d.oldCut)}`, detail: `−${d.onlyRemoved}` }
  if (d.removed === 1 && d.added === 1) return { what: 'changing 1 line', detail: '+1 −1' }
  return { what: `${linesText(d.removed, d.oldCut)} → ${linesText(d.added, d.newCut)}`, detail: `+${d.added} −${d.removed}` }
}

function editHeadline(label: string, what: string): string {
  const name = cutLeft(label === '' ? 'a file' : label, 40)
  if (what === '') return fitMiddle('Editing ', name)
  const quote = /^(replacing every )“(.*)”$/.exec(what)
  if (quote) return fitQuote(`Editing ${name}: ${quote[1] ?? ''}`, quote[2] ?? '')
  return fitTail(`Editing ${name}: `, what)
}

function explainEdit(o: In, c: Ctx): Part {
  const path = str(o.args.file_path) ?? str(o.args.path) ?? ''
  const oldS = typeof o.args.old_string === 'string' ? o.args.old_string : ''
  const newS = typeof o.args.new_string === 'string' ? o.args.new_string : ''
  const all = isTrue(o.args.replace_all)
  const d = diffOf(oldS, newS)
  const { what, detail } = editWhat(oldS, newS, all, d)
  const { special, format } = pathConcepts(path)
  const p: Part = {
    station: 'edit',
    headline: editHeadline(fileLabel(path), what),
    why: pick(o.id, all ? WHY.editAll : WHY.edit),
    concepts: [wasRead(path, c) && 'read-before-edit', ...special, 'surgical-edit', 'exact-match-edit', all && 'refactoring', ...format],
    scene: { kind: 'edit', path: displayPath(path, c.cwd), removed: d.removed, added: d.added, minus: d.minus, plus: d.plus, isNew: false },
  }
  if (path !== '') p.target = path
  if (detail !== undefined) p.detail = detail
  return p
}

function explainMultiEdit(o: In, c: Ctx): Part {
  const path = str(o.args.file_path) ?? ''
  const edits = arr(o.args.edits).map(obj)
  let removed = 0
  let added = 0
  let first: Diff | undefined
  for (const e of edits.slice(0, 200)) {
    const d = diffOf(typeof e.old_string === 'string' ? e.old_string : '', typeof e.new_string === 'string' ? e.new_string : '')
    removed += d.removed
    added += d.added
    first ??= d
  }
  const { special, format } = pathConcepts(path)
  const n = edits.length
  const p: Part = {
    station: 'edit',
    headline: editHeadline(fileLabel(path), n === 0 ? '' : `${n} ${plural(n, 'change', 'changes')}`),
    why: pick(o.id, WHY.edit),
    concepts: [wasRead(path, c) && 'read-before-edit', ...special, 'surgical-edit', 'exact-match-edit', ...format],
    scene: { kind: 'edit', path: displayPath(path, c.cwd), removed, added, minus: first?.minus ?? [], plus: first?.plus ?? [], isNew: false },
    detail: `+${added} −${removed}`,
  }
  if (path !== '') p.target = path
  return p
}

function explainWrite(o: In, c: Ctx): Part {
  const path = str(o.args.file_path) ?? str(o.args.path) ?? ''
  const content = typeof o.args.content === 'string' ? o.args.content : ''
  const lines = lineCount(content)
  const isCut = content.length >= ARG_CUT
  const rewrite = wasRead(path, c)
  const size = content === '' ? 'empty' : linesText(lines, isCut)
  const label = fileLabel(path) || 'a file'
  const { special, format } = pathConcepts(path)
  const p: Part = {
    station: 'edit',
    headline: fitMiddle(rewrite ? 'Rewriting ' : 'Creating ', label, ` (${size})`),
    why: pick(o.id, rewrite ? WHY.rewrite : WHY.create),
    concepts: [...special, 'create-file', ...format],
    scene: { kind: 'edit', path: displayPath(path, c.cwd), removed: 0, added: lines, minus: [], plus: diffLines(splitLines(content, 12)), isNew: !rewrite },
  }
  if (path !== '') p.target = path
  if (lines > 0) p.detail = `+${lines}`
  return p
}

function explainNotebookEdit(o: In, c: Ctx): Part {
  const path = str(o.args.notebook_path) ?? str(o.args.file_path) ?? ''
  const label = fileLabel(path) || 'a notebook'
  const mode = str(o.args.edit_mode) ?? 'replace'
  const src = typeof o.args.new_source === 'string' ? o.args.new_source : ''
  const kind = o.args.cell_type === 'markdown' ? 'text ' : o.args.cell_type === 'code' ? 'code ' : ''
  const headline = mode === 'insert'
    ? fitMiddle(`Adding a ${kind}cell to `, label)
    : mode === 'delete' ? fitMiddle('Deleting a cell from ', label) : fitMiddle(`Editing a ${kind}cell in `, label)
  const lines = mode === 'delete' ? 0 : lineCount(src)
  const p: Part = {
    station: 'edit',
    headline,
    why: pick(o.id, WHY.notebook),
    concepts: ['surgical-edit', ...fileConcepts(path)],
    scene: { kind: 'edit', path: displayPath(path, c.cwd), removed: 0, added: lines, minus: [], plus: mode === 'delete' ? [] : diffLines(splitLines(src, 12)), isNew: mode === 'insert' },
  }
  if (path !== '') p.target = path
  if (lines > 0) p.detail = `+${lines}`
  return p
}

// ---------------------------------------------------------------- agents and planning

function explainAgent(o: In): Part {
  const desc = str(o.args.description) ?? str(o.args.name) ?? ''
  const type = str(o.args.subagent_type)
  const bg = isTrue(o.args.run_in_background)
  const label = cut(flat(desc !== '' ? desc : type ?? 'sub-agent'), 120) || 'sub-agent'
  const agent: { label: string; type?: string; status: StepStatus } = { label, status: 'running' }
  if (type !== undefined) agent.type = cut(flat(type), 60)
  const p: Part = {
    station: 'delegate',
    headline: desc !== '' ? fitTail('Delegating to a sub-agent: ', desc) : type !== undefined ? fitTail('Delegating to a sub-agent: ', `${type} agent`) : 'Delegating to a sub-agent',
    why: pick(o.id, WHY.agent),
    concepts: ['subagents', bg && 'background-tasks', o.args.isolation === 'worktree' && 'git-branch', 'context-window'],
    scene: { kind: 'delegate', agents: [agent] },
  }
  if (desc !== '') p.target = desc
  const detail = [type, bg ? 'in the background' : o.args.isolation === 'remote' ? 'in the cloud' : undefined].filter(isStr).join(', ')
  if (detail !== '') p.detail = detail
  return p
}

const META_RE = /\bmeta\s*=\s*\{/
const META_NAME_RE = /(?:^|[\s,{])['"]?name['"]?\s*:\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/
const META_DESC_RE = /(?:^|[\s,{])['"]?description['"]?\s*:\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/

/** name and description from a workflow script's `export const meta = { ... }`. */
function metaOf(script: string): { name?: string; description?: string } {
  const head = script.slice(0, 8000)
  const m = META_RE.exec(head)
  if (!m) return {}
  const body = head.slice(m.index, m.index + 4000)
  const field = (re: RegExp): string | undefined => {
    const f = re.exec(body)
    const v = f ? flat((f[2] ?? '').replace(/\\(.)/g, (_, ch: string) => (ch === 'n' || ch === 't' ? ' ' : ch))) : ''
    return v === '' ? undefined : v
  }
  const out: { name?: string; description?: string } = {}
  const name = field(META_NAME_RE)
  const description = field(META_DESC_RE)
  if (name !== undefined) out.name = name
  if (description !== undefined) out.description = description
  return out
}

function explainWorkflow(o: In): Part {
  const script = typeof o.args.script === 'string' ? o.args.script : ''
  const meta = metaOf(script)
  const scriptPath = str(o.args.scriptPath)
  const fromPath = scriptPath === undefined ? undefined : baseName(scriptPath).replace(/\.[cm]?[jt]s$/, '').replace(/-wf_[\w-]+$/, '') || undefined
  const name = meta.name ?? str(o.args.name) ?? fromPath
  const what = meta.description ?? str(o.args.description) ?? str(o.args.title) ?? name
  const verb = str(o.args.resumeFromRunId) !== undefined ? 'Resuming' : 'Running'
  const p: Part = {
    station: 'delegate',
    headline: what === undefined ? `${verb} a multi-agent workflow` : fitTail(`${verb} a multi-agent workflow: `, what),
    why: pick(o.id, WHY.workflow),
    concepts: ['multi-agent-workflow', 'subagents'],
    scene: { kind: 'delegate', agents: [{ label: cut(flat(what ?? 'workflow'), 120) || 'workflow', type: 'workflow', status: 'running' }] },
  }
  const target = what ?? scriptPath
  if (target !== undefined) p.target = flat(target)
  if (name !== undefined) p.detail = flat(name)
  return p
}

type PlanItem = { text: string; state: 'done' | 'doing' | 'todo' }
const PLAN_ITEMS_MAX = 12
const stateOf = (s: unknown): PlanItem['state'] => (s === 'completed' || s === 'done' ? 'done' : s === 'in_progress' ? 'doing' : 'todo')

function explainTodos(o: In): Part {
  const todos = arr(o.args.todos).slice(0, 500).map(obj)
  const all: PlanItem[] = []
  let done = 0
  let doing: Args | undefined
  let doingAt = -1
  for (const t of todos) {
    const text = flat(str(t.content) ?? str(t.activeForm) ?? str(t.subject) ?? '', 400)
    if (text === '') continue
    const state = stateOf(t.status)
    if (state === 'done') done++
    if (state === 'doing' && doing === undefined) {
      doing = t
      doingAt = all.length
    }
    all.push({ text: cutWords(text, 80), state })
  }
  const total = all.length
  // a long list shows 12 items around the one in progress, so the scene always holds it
  const from = total <= PLAN_ITEMS_MAX || doingAt < 0 ? 0 : Math.min(Math.max(0, doingAt - 3), total - PLAN_ITEMS_MAX)
  const items = all.slice(from, from + PLAN_ITEMS_MAX)
  const headline = total === 0
    ? 'Clearing the plan'
    // a fresh plan usually marks its first step in progress at once: still a new plan
    : done === 0 ? `Making a plan: ${total} ${plural(total, 'step', 'steps')}`
    : done === total ? `Updating the plan: all ${total} done` : `Updating the plan: ${done} of ${total} done`
  const p: Part = { station: 'plan', headline, why: pick(o.id, WHY.todo), concepts: ['todo-planning'], scene: { kind: 'plan', items } }
  if (doing !== undefined) {
    const now = str(doing.activeForm) ?? str(doing.content)
    if (now !== undefined) p.detail = flat(now)
    const content = str(doing.content)
    if (content !== undefined) p.target = flat(content)
  }
  return p
}

function explainTask(o: In): Part {
  const subject = str(o.args.subject) ?? str(o.args.content) ?? str(o.args.description)
  const status = o.args.status
  let headline: string
  if (o.tool === 'TaskCreate') headline = subject !== undefined ? fitTail('Adding to the plan: ', subject) : 'Adding a task to the plan'
  else if (o.tool === 'TaskUpdate') {
    const verb = status === 'completed' ? 'Marking a task done' : status === 'in_progress' ? 'Starting a task' : 'Updating a task'
    headline = subject !== undefined ? fitTail(`${verb}: `, subject) : verb
  } else headline = o.tool === 'TaskList' ? 'Checking the task list' : 'Checking a task'
  const items: PlanItem[] = subject !== undefined ? [{ text: cutWords(flat(subject), 80), state: stateOf(status) }] : []
  return { station: 'plan', headline, why: pick(o.id, WHY.task), concepts: ['todo-planning'], scene: { kind: 'plan', items } }
}

function explainEnterPlan(o: In): Part {
  return {
    station: 'plan',
    headline: 'Switching to plan mode: exploring before changing anything',
    why: pick(o.id, WHY.planEnter),
    concepts: ['plan-mode'],
    scene: {
      kind: 'plan',
      items: [
        { text: 'Explore the code', state: 'doing' },
        { text: 'Write a plan', state: 'todo' },
        { text: 'Get your approval', state: 'todo' },
      ],
    },
  }
}

function explainExitPlan(o: In): Part {
  const plan = typeof o.args.plan === 'string' ? o.args.plan.slice(0, 20_000) : ''
  let title: string | undefined
  const sections: string[] = []
  const bullets: string[] = []
  for (const line of plan.split('\n')) {
    const h1 = /^#\s+(.+)/.exec(line)
    if (h1 && title === undefined) title = flat(h1[1] ?? '')
    const h2 = /^##\s+(.+)/.exec(line)
    if (h2 && sections.length < 6) sections.push(cutWords(flat(h2[1] ?? ''), 80))
    const li = /^\s*(?:\d+[.)]|[-*])\s+(.+)/.exec(line)
    if (li && bullets.length < 6) bullets.push(cutWords(flat(li[1] ?? ''), 80))
  }
  const texts = (sections.length > 0 ? sections : bullets).filter(t => t !== '')
  const items: PlanItem[] = texts.length > 0 ? texts.map(text => ({ text, state: 'todo' as const })) : [{ text: 'Waiting for your approval', state: 'doing' }]
  const p: Part = {
    station: 'plan',
    headline: title !== undefined && title !== '' ? fitTail('Asking you to approve the plan: ', title) : 'Asking you to approve the plan',
    why: pick(o.id, WHY.planExit),
    concepts: ['plan-mode'],
    scene: { kind: 'plan', items },
  }
  const file = str(o.args.planFilePath)
  if (file !== undefined) p.target = file
  else if (title !== undefined && title !== '') p.target = title
  return p
}

function explainAsk(o: In): Part {
  const qs = arr(o.args.questions).map(obj)
  const first = qs[0] ?? {}
  const q = flat(str(first.question) ?? str(o.args.question) ?? '')
  const p: Part = {
    station: 'ask',
    headline: q !== '' ? fitTail('Asking you: ', q) : 'Asking you a question',
    why: pick(o.id, WHY.ask),
    concepts: ['clarifying-questions'],
    scene: { kind: 'ask', question: cut(q, SCENE_TEXT_MAX), isPermission: false },
  }
  if (q !== '') p.target = q
  if (qs.length > 1) p.detail = `${qs.length} questions`
  else if (str(first.header) !== undefined) p.detail = flat(String(first.header))
  return p
}

// ---------------------------------------------------------------- web

function explainWebSearch(o: In): Part {
  const q = flat(str(o.args.query) ?? '')
  const domains = arr(o.args.allowed_domains).filter(isStr)
  const p: Part = {
    station: 'web',
    headline: q !== '' ? fitQuote('Searching the web for ', q) : 'Searching the web',
    why: pick(o.id, WHY.webSearch),
    concepts: ['web-research'],
    scene: q !== '' ? { kind: 'web', query: cut(q, SCENE_TEXT_MAX) } : { kind: 'web' },
  }
  if (q !== '') p.target = q
  if (domains.length > 0) p.detail = `on ${flat(domains[0] ?? '')}${domains.length > 1 ? ` +${domains.length - 1}` : ''}`
  return p
}

function explainWebFetch(o: In): Part {
  const url = flat(str(o.args.url) ?? '')
  const host = url === '' ? undefined : hostOf(url)
  let shown = url
  if (host !== undefined) {
    const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?[^/?#\s]*([^?#\s]*)/i.exec(url)
    const path = (m?.[1] ?? '').replace(/\/+$/, '')
    shown = host + path
  }
  const scene: SceneData = { kind: 'web' }
  if (url !== '') scene.url = cut(safeUrl(url), SCENE_TEXT_MAX)
  if (host !== undefined) scene.domain = host
  const local = host !== undefined && /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(host)
  const p: Part = {
    station: 'web',
    headline: shown !== '' ? fitTail('Reading ', shown) : 'Reading a web page',
    why: pick(o.id, WHY.webFetch),
    concepts: ['web-research', 'http-requests', local && 'localhost'],
    scene,
  }
  if (url !== '') p.target = safeUrl(url)
  return p
}

// ---------------------------------------------------------------- tools, skills, connectors

function explainSkill(o: In): Part {
  const full = flat(str(o.args.skill) ?? str(o.args.name) ?? '')
  const short = full.includes(':') ? full.slice(full.lastIndexOf(':') + 1) : full
  const args = str(o.args.args)
  const p: Part = {
    station: 'tools',
    headline: short !== '' ? fitMiddle('Loading the ', short, ' skill') : 'Loading a skill',
    why: pick(o.id, WHY.skill),
    concepts: ['skills'],
    scene: { kind: 'tools', name: cut(short, 80) || 'Skill', detail: args !== undefined ? cut(flat(args), 60) : 'skill' },
  }
  if (full !== '') p.target = full
  if (args !== undefined) p.detail = flat(args)
  return p
}

function explainToolSearch(o: In): Part {
  const q = flat(str(o.args.query) ?? '')
  const sel = /^select:\s*(.*)$/i.exec(q)
  if (sel) {
    const names = (sel[1] ?? '').split(',').map(s => s.trim()).filter(s => s !== '')
    const list = names.join(', ')
    const p: Part = {
      station: 'tools',
      headline: list !== '' ? fitTail('Loading tool definitions: ', list) : 'Loading tool definitions',
      why: pick(o.id, WHY.toolLoad),
      concepts: ['deferred-tools'],
      scene: { kind: 'tools', name: 'ToolSearch', detail: cut(list, 60) || 'tool definitions' },
    }
    if (list !== '') p.target = list
    if (names.length > 1) p.detail = `${names.length} tools`
    return p
  }
  const p: Part = {
    station: 'search',
    headline: q !== '' ? fitQuote('Searching its tool list for ', q) : 'Searching its tool list',
    why: pick(o.id, WHY.toolFind),
    concepts: ['deferred-tools'],
    scene: { kind: 'search', query: cut(q, SCENE_TEXT_MAX), where: 'tools it can load' },
  }
  if (q !== '') p.target = q
  return p
}

const SERVER_WORDS: ReadonlyMap<string, string> = new Map([
  ['vscode', 'VS Code'], ['github', 'GitHub'], ['gitlab', 'GitLab'], ['ide', 'IDE'], ['api', 'API'], ['ai', 'AI'],
  ['mcp', 'MCP'], ['sql', 'SQL'], ['aws', 'AWS'], ['gcp', 'GCP'], ['gdrive', 'Google Drive'], ['pagerduty', 'PagerDuty'],
  ['mongodb', 'MongoDB'], ['bigquery', 'BigQuery'], ['postgres', 'Postgres'], ['postgresql', 'PostgreSQL'],
  ['openai', 'OpenAI'], ['hubspot', 'HubSpot'], ['youtube', 'YouTube'], ['linkedin', 'LinkedIn'],
])

/** 'claude_ai_Claude_Docs' → 'Claude Docs', 'claude-vscode' → 'Claude VS Code'. */
function serverName(raw: string): string {
  const words = raw.replace(/^claude[_-]ai[_-]/i, '').split(/[_\-\s.]+/).filter(w => w !== '')
  const small = new Set(['in', 'of', 'the', 'for', 'and', 'to', 'on', 'via'])
  const out = words
    .map((w, i) => SERVER_WORDS.get(w.toLowerCase()) ?? (i > 0 && small.has(w.toLowerCase()) ? w.toLowerCase() : w === w.toLowerCase() ? cap(w) : w))
    .join(' ')
  return cut(flat(out), 40) || cut(flat(raw), 40) || 'MCP'
}

/** The argument that best says what an MCP call is about. */
function salientArg(args: Args): string | undefined {
  for (const k of ['url', 'query', 'q', 'path', 'file_path', 'filePath', 'uri', 'title', 'name', 'id']) {
    const v = str(args[k])
    if (v !== undefined) return flat(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? safeUrl(v) : v)
  }
  return undefined
}

function explainMcp(o: In): Part {
  const m = /^mcp__(.+?)__(.+)$/.exec(o.tool)
  const server = serverName(m?.[1] ?? o.tool.replace(/^mcp__/, ''))
  const tool = flat(m?.[2] ?? '')
  const about = salientArg(o.args)
  const scene: SceneData = { kind: 'tools', name: cut(tool, 80) || 'tool', server }
  if (about !== undefined) scene.detail = cut(about, 80)
  const p: Part = {
    station: 'tools',
    headline: tool !== '' ? fitTail(`Using the ${server} connector: `, tool) : `Using the ${server} connector`,
    why: pick(o.id, WHY.mcp),
    concepts: ['mcp'],
    scene,
  }
  if (about !== undefined) p.target = about
  return p
}

function explainEnableMcp(o: In): Part {
  const server = serverName(o.tool.replace(/^enable__mcp__/, '').replace(/^remote-devices__/, ''))
  return {
    station: 'tools',
    headline: fitTail('Turning on the connector: ', server),
    why: pick(o.id, WHY.mcp),
    concepts: ['mcp'],
    scene: { kind: 'tools', name: server, detail: 'turning on' },
  }
}

function explainConnectorAdmin(o: In): Part {
  const server = str(o.args.server)
  const headline =
    o.tool === 'WaitForMcpServers' ? 'Waiting for its connectors to start'
    : o.tool === 'ListMcpResourcesTool' ? (server !== undefined ? fitTail('Listing what a connector offers: ', serverName(server)) : 'Listing what its connectors offer')
    : o.tool === 'ReadMcpResourceTool' || o.tool === 'ReadMcpResourceDirTool' ? (server !== undefined ? fitTail('Reading a resource from a connector: ', serverName(server)) : 'Reading a resource from a connector')
    : 'Looking for a connector that fits the job'
  const scene: SceneData = server !== undefined ? { kind: 'tools', name: o.tool, server: serverName(server) } : { kind: 'tools', name: o.tool }
  return { station: 'tools', headline, why: pick(o.id, WHY.mcp), concepts: ['mcp'], scene }
}

function explainSkillAdmin(o: In): Part {
  const words = arr(o.args.keywords).filter(isStr).map(s => flat(s)).join(', ')
  const headline = o.tool === 'propose_skills' ? 'Proposing new skills from this work' : words !== '' ? fitTail('Looking for a skill: ', words) : 'Looking for a skill'
  return { station: 'tools', headline, why: pick(o.id, WHY.skill), concepts: ['skills'], scene: { kind: 'tools', name: o.tool, detail: 'skills' } }
}

function explainMonitor(o: In): Part {
  const desc = str(o.args.description)
  const command = str(o.args.command)
  const ws = str(obj(o.args.ws).url)
  const a = command !== undefined ? safeAnalysis(command, desc) : undefined
  const category: BashCategory = a !== undefined && typeof a.category === 'string' && CATEGORIES.has(a.category) ? a.category : 'wait'
  const scene: SceneData = { kind: 'run', command: cut(command ?? (ws !== undefined ? `watch ${ws}` : desc ?? ''), SCENE_COMMAND_MAX), category, isBackground: true }
  const primary = a !== undefined ? str(a.primary) : undefined
  if (primary !== undefined) scene.program = cut(flat(primary), 80)
  const p: Part = {
    station: 'run',
    headline: desc !== undefined ? fitTail('Watching: ', desc) : command !== undefined ? 'Watching a command’s output' : 'Watching a background job',
    why: pick(o.id, WHY.monitor),
    concepts: ['monitoring', 'background-tasks', ...arr(a?.concepts)],
    scene,
  }
  const target = command ?? ws ?? desc
  if (target !== undefined) p.target = target
  const ms = num(o.args.timeout_ms)
  if (ms !== undefined && ms > 0) p.detail = `up to ${duration(ms / 1000)}`
  return p
}

function explainTaskStop(o: In): Part {
  const id = str(o.args.task_id) ?? str(o.args.shell_id)
  const scene: SceneData = id !== undefined ? { kind: 'tools', name: 'TaskStop', detail: cut(flat(id), 60) } : { kind: 'tools', name: 'TaskStop' }
  return { station: 'tools', headline: 'Stopping a background job', why: pick(o.id, WHY.taskStop), concepts: ['background-tasks'], scene }
}

function explainTaskCheck(o: In): Part {
  const id = str(o.args.task_id) ?? str(o.args.taskId) ?? str(o.args.bash_id) ?? str(o.args.shell_id)
  const scene: SceneData = id !== undefined ? { kind: 'tools', name: o.tool, detail: cut(flat(id), 60) } : { kind: 'tools', name: o.tool }
  return { station: 'tools', headline: 'Checking on a background job', why: pick(o.id, WHY.taskCheck), concepts: ['background-tasks', 'monitoring'], scene }
}

function explainWakeup(o: In): Part {
  const stop = isTrue(o.args.stop)
  const delay = num(o.args.delaySeconds)
  const reason = str(o.args.reason)
  const when = delay !== undefined ? `in ${duration(Math.min(Math.max(delay, 60), 3600))}` : 'later'
  const headline = stop ? 'Ending its check-in loop' : reason !== undefined ? fitTail(`Checking back ${when}: `, reason) : `Scheduling a check-in ${when}`
  return {
    station: 'tools',
    headline,
    why: pick(o.id, WHY.schedule),
    concepts: ['scheduling'],
    scene: { kind: 'tools', name: 'ScheduleWakeup', detail: stop ? 'stop' : when },
  }
}

function explainCron(o: In): Part {
  const cron = str(o.args.cron)
  const prompt = str(o.args.prompt)
  let headline: string
  if (o.tool === 'CronCreate') {
    const kind = o.args.recurring === false ? 'one-time' : 'recurring'
    headline = prompt !== undefined ? fitTail(`Scheduling a ${kind} task: `, prompt) : `Scheduling a ${kind} task`
  } else headline = o.tool === 'CronDelete' ? 'Removing a scheduled task' : 'Listing its scheduled tasks'
  const scene: SceneData = cron !== undefined ? { kind: 'tools', name: o.tool, detail: cut(flat(cron), 60) } : { kind: 'tools', name: o.tool }
  const p: Part = { station: 'tools', headline, why: pick(o.id, WHY.schedule), concepts: ['scheduling'], scene }
  if (cron !== undefined) p.detail = flat(cron)
  return p
}

function explainSendMessage(o: In): Part {
  const to = str(o.args.to) ?? (Array.isArray(o.args.to) ? arr(o.args.to).filter(isStr).join(', ') : undefined)
  const summary = str(o.args.summary) ?? str(o.args.message)
  const who = to !== undefined && to !== '' ? flat(to) : 'another agent'
  const agent: { label: string; status: StepStatus; doing?: string } = { label: cut(who, 120), status: 'running' }
  if (summary !== undefined) agent.doing = cut(flat(summary), 120)
  const p: Part = {
    station: 'delegate',
    headline: summary !== undefined ? fitTail(`Messaging ${cut(who, 30)}: `, summary) : fitTail('Messaging ', who),
    why: pick(o.id, WHY.message),
    concepts: ['subagents'],
    scene: { kind: 'delegate', agents: [agent] },
  }
  if (to !== undefined && to !== '') p.target = flat(to)
  return p
}

function explainHandback(o: In): Part {
  const msg = str(o.args.message) ?? str(o.args.summary)
  const agent: { label: string; status: StepStatus; doing?: string } = { label: 'report to the main agent', status: 'running' }
  if (msg !== undefined) agent.doing = cut(flat(msg), 120)
  return {
    station: 'delegate',
    headline: 'Handing its report back to the main agent',
    why: pick(o.id, WHY.handback),
    concepts: ['subagents', 'context-window'],
    scene: { kind: 'delegate', agents: [agent] },
  }
}

function explainListAgents(o: In): Part {
  return {
    station: 'delegate',
    headline: 'Listing the agents it can message',
    why: pick(o.id, WHY.message),
    concepts: ['subagents'],
    scene: { kind: 'delegate', agents: [] },
  }
}

function explainStructured(o: In): Part {
  const keys = Object.keys(o.args).filter(k => k !== '')
  const summary = str(o.args.summary)
  const fields = `${keys.length} ${plural(keys.length, 'field', 'fields')}`
  const p: Part = {
    station: 'tools',
    headline: summary !== undefined ? fitTail('Returning a structured result: ', summary) : `Returning a structured result (${fields})`,
    why: pick(o.id, WHY.structured),
    concepts: ['structured-output'],
    scene: { kind: 'tools', name: 'StructuredOutput', detail: fields },
  }
  if (keys.length > 0) p.detail = fields
  return p
}

function explainArtifact(o: In): Part {
  const action = str(o.args.action) ?? 'publish'
  const title = str(o.args.title)
  const file = str(o.args.file_path)
  const intent = str(o.args.intent)
  let headline: string
  switch (action) {
    case 'publish':
      headline = title !== undefined ? fitTail('Publishing a page: ', title)
        : file !== undefined ? fitMiddle('Publishing ', fileLabel(file), ' as a page')
        : str(o.args.type_url) !== undefined ? 'Creating a page from a template' : 'Publishing a page'
      break
    case 'quickstart':
      headline = `Looking up how to make ${intent === 'slides' ? 'a slide deck' : intent === 'design' ? 'a design' : intent === 'document' ? 'a document' : 'a page'}`
      break
    case 'read': headline = 'Reading a published page'; break
    case 'list': headline = 'Listing your published pages'; break
    case 'delete': headline = 'Deleting a published page'; break
    case 'open': headline = 'Opening a published page for you'; break
    case 'pin': headline = 'Pinning a page to your sidebar'; break
    case 'unpin': headline = 'Unpinning a page from your sidebar'; break
    default: headline = fitTail('Working on a published page: ', action)
  }
  const p: Part = {
    station: 'tools',
    headline,
    why: pick(o.id, WHY.artifact),
    concepts: ['artifacts'],
    scene: { kind: 'tools', name: 'Artifact', detail: cut(flat(action), 40) },
  }
  const target = str(o.args.url) ?? file ?? title
  if (target !== undefined) p.target = flat(target)
  return p
}

function explainArtifactData(o: In): Part {
  const action = str(o.args.action) ?? ''
  let headline: string
  if (o.tool === 'ArtifactComments') {
    headline = action === 'reply' ? 'Replying to a comment on a page'
      : action === 'resolve' ? 'Resolving a comment on a page'
      : action === 'watch' ? 'Watching a page for new comments' : 'Reading the comments on a page'
  } else if (o.tool === 'ArtifactCheck') headline = 'Checking a page before publishing it'
  else {
    const reads = action === 'get' || action === 'list' || action === 'query' || action === 'profiles'
    const collection = str(o.args.collection)
    headline = reads
      ? (collection !== undefined ? fitTail('Reading a page’s shared data: ', collection) : 'Reading a page’s shared data')
      : (collection !== undefined ? fitTail('Updating a page’s shared data: ', collection) : 'Updating a page’s shared data')
  }
  const scene: SceneData = action !== '' ? { kind: 'tools', name: o.tool, detail: cut(flat(action), 40) } : { kind: 'tools', name: o.tool }
  const p: Part = { station: 'tools', headline, why: pick(o.id, o.tool === 'ArtifactData' ? WHY.artifactData : WHY.artifact), concepts: ['artifacts'], scene }
  const url = str(o.args.url)
  if (url !== undefined) p.target = flat(url)
  return p
}

function explainMemory(o: In, c: Ctx): Part {
  const path = str(o.args.path) ?? ''
  const shown = displayPath(path, c.cwd)
  if (o.tool === 'memory_read') {
    const p: Part = {
      station: 'read',
      headline: shown !== '' ? fitMiddle('Reading a memory: ', fileLabel(path)) : 'Reading a memory',
      why: pick(o.id, WHY.memory),
      concepts: ['agent-memory'],
      scene: { kind: 'read', files: shown !== '' ? [{ path: shown }] : [] },
    }
    if (path !== '') p.target = path
    return p
  }
  if (o.tool === 'memory_write') {
    const content = typeof o.args.content === 'string' ? o.args.content : ''
    const lines = lineCount(content)
    const p: Part = {
      station: 'edit',
      headline: shown !== '' ? fitMiddle('Saving a memory: ', fileLabel(path)) : 'Saving a memory',
      why: pick(o.id, WHY.memory),
      concepts: ['agent-memory'],
      scene: { kind: 'edit', path: shown, removed: 0, added: lines, minus: [], plus: diffLines(splitLines(content, 12)), isNew: false },
    }
    if (path !== '') p.target = path
    if (lines > 0) p.detail = `+${lines}`
    return p
  }
  const prefix = str(o.args.path_prefix)
  return {
    station: 'search',
    headline: 'Looking through its memory files',
    why: pick(o.id, WHY.memory),
    concepts: ['agent-memory'],
    scene: { kind: 'search', query: prefix !== undefined ? cut(flat(prefix), SCENE_TEXT_MAX) : 'memories', where: cut(flat(str(o.args.store) ?? 'memory'), 60) },
  }
}

function explainWorktree(o: In): Part {
  if (o.tool === 'ExitWorktree') {
    const remove = o.args.action === 'remove'
    return {
      station: 'tools',
      headline: remove ? 'Leaving the git worktree and removing it' : 'Leaving the git worktree, keeping its work',
      why: pick(o.id, WHY.worktree),
      concepts: ['git-branch'],
      scene: { kind: 'tools', name: 'ExitWorktree', detail: remove ? 'remove' : 'keep' },
    }
  }
  const name = str(o.args.name) ?? (str(o.args.path) !== undefined ? baseName(String(o.args.path)) : undefined)
  const scene: SceneData = name !== undefined ? { kind: 'tools', name: 'EnterWorktree', detail: cut(flat(name), 60) } : { kind: 'tools', name: 'EnterWorktree' }
  return {
    station: 'tools',
    headline: name !== undefined ? fitTail('Moving into a separate git worktree: ', name) : 'Moving into a separate git worktree',
    why: pick(o.id, WHY.worktree),
    concepts: ['git-branch'],
    scene,
  }
}

// ---------------------------------------------------------------- search tools (other builds)

const REGEXY_RE = /[\\^$*+?()[\]{}|]|\.\*/

/** 'src/' for a folder, 'report.py' for a file, cut to 30. */
function whereLabel(path: string | undefined, c: Ctx): string | undefined {
  if (path === undefined) return undefined
  const shown = displayPath(path, c.cwd, 30)
  if (shown === '' || shown === '.') return shown === '.' ? 'the project' : undefined
  return extOf(baseName(path)) === '' && !shown.endsWith('/') && shown !== '~' ? `${shown}/` : shown
}

function explainGrep(o: In, c: Ctx): Part {
  const pattern = flat(str(o.args.pattern) ?? str(o.args.query) ?? '')
  const glob = str(o.args.glob)
  const type = str(o.args.type)
  const where = whereLabel(str(o.args.path), c) ?? (glob !== undefined ? flat(glob) : type !== undefined ? `${flat(type)} files` : 'the project')
  const counting = o.args.output_mode === 'count'
  const headline = pattern === ''
    ? fitTail('Searching ', where)
    : fitQuote(counting ? 'Counting ' : 'Searching for ', pattern, ` in ${cutLeft(where, 30)}`)
  const p: Part = {
    station: 'search',
    headline,
    why: pick(o.id, WHY.grep),
    concepts: ['grep', REGEXY_RE.test(pattern) && 'regex', glob !== undefined && 'globbing', 'search-then-read'],
    scene: { kind: 'search', query: cut(pattern, SCENE_TEXT_MAX), where },
  }
  if (pattern !== '') p.target = pattern
  return p
}

function explainGlob(o: In, c: Ctx): Part {
  const pattern = flat(str(o.args.pattern) ?? '')
  const where = whereLabel(str(o.args.path), c) ?? 'the project'
  const p: Part = {
    station: 'search',
    headline: pattern !== '' ? fitQuote('Finding files matching ', pattern, ` in ${cutLeft(where, 30)}`) : fitTail('Listing files in ', where),
    why: pick(o.id, WHY.glob),
    concepts: ['globbing', 'search-then-read'],
    scene: { kind: 'search', query: cut(pattern, SCENE_TEXT_MAX), where },
  }
  if (pattern !== '') p.target = pattern
  return p
}

function explainLs(o: In, c: Ctx): Part {
  const where = whereLabel(str(o.args.path), c) ?? 'the project'
  return {
    station: 'search',
    headline: fitTail('Listing files in ', where),
    why: pick(o.id, WHY.glob),
    concepts: ['ls', 'search-then-read'],
    scene: { kind: 'search', query: '*', where },
  }
}

function explainLsp(o: In, c: Ctx): Part {
  const op = flat(str(o.args.operation) ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
  const path = str(o.args.filePath) ?? str(o.args.file_path) ?? ''
  const label = fileLabel(path)
  const where = label !== '' ? label : 'the code'
  const p: Part = {
    station: 'search',
    headline: op !== '' ? fitMiddle(`Asking the language server (${cut(op, 30)}) in `, where) : fitMiddle('Asking the language server about ', where),
    why: pick(o.id, WHY.lsp),
    concepts: ['reading-code', 'type-checking'],
    scene: { kind: 'search', query: cut(flat(str(o.args.query) ?? op), SCENE_TEXT_MAX), where: displayPath(path, c.cwd) || 'the code' },
  }
  if (path !== '') p.target = path
  return p
}

function explainTalk(o: In): Part {
  const files = arr(o.args.files).filter(isStr)
  const message = str(o.args.message)
  const caption = str(o.args.caption) ?? message
  let headline: string
  if (o.tool === 'SendUserMessage') headline = message !== undefined ? fitTail('Messaging you: ', message) : 'Sending you a message'
  else if (o.tool === 'PushNotification') headline = message !== undefined ? fitTail('Sending you a notification: ', message) : 'Sending you a notification'
  else if (files.length === 1) headline = fitMiddle(o.tool === 'SendFile' ? 'Sending a file: ' : 'Sending you a file: ', fileLabel(files[0] ?? ''))
  else headline = files.length > 1 ? `Sending ${o.tool === 'SendFile' ? '' : 'you '}${files.length} files` : 'Sending a file'
  const scene: SceneData = caption !== undefined ? { kind: 'talk', text: cut(flat(caption), SCENE_TEXT_MAX) } : { kind: 'talk' }
  const p: Part = { station: 'talk', headline, why: pick(o.id, WHY.talk), concepts: ['tool-calls'], scene }
  if (files[0] !== undefined) p.target = files[0]
  return p
}

function explainFindings(o: In): Part {
  const n = arr(o.args.findings).length
  return {
    station: 'tools',
    headline: n > 0 ? `Reporting ${n} review ${plural(n, 'finding', 'findings')}` : 'Reporting review findings',
    why: pick(o.id, WHY.review),
    concepts: ['code-review'],
    scene: { kind: 'tools', name: 'ReportFindings', detail: `${n} ${plural(n, 'finding', 'findings')}` },
  }
}

// ---------------------------------------------------------------- endings

/** A refusal reads the same from every tool: the person said no, stopped it, or a rule blocked it. */
function refusalOf(preview: string, status: StepStatus): string | undefined {
  const t = preview.slice(0, 2000).replace(/^\s*(?:<tool_use_error>\s*)?(?:Error:\s*)?/i, '')
  if (/^\[Request interrupted by user/i.test(t)) return 'You stopped this'
  if (/^(?:The user doesn't want to proceed|The user does not want to proceed|User rejected|The user rejected|The user declined)/i.test(t)) {
    const said = /the user said:\s*([\s\S]+)/i.exec(t)
    const words = said ? flat(said[1] ?? '') : ''
    return words !== '' ? fitQuote('You declined this: ', words, '', NOTE_MAX) : 'You declined this'
  }
  if (/^Permission to use [\s\S]{1,2000}?\bdenied\b|^Permission (?:has been )?denied by|^Denied by (?:a )?(?:permission|policy|rule|hook)/i.test(t)) return 'Blocked by a permission rule'
  if (status === 'denied') return /\b(?:declined|rejected)\b/i.test(t) ? 'You declined this' : 'Blocked by a permission rule'
  return undefined
}

const ERROR_NOTES: readonly [RegExp, (m: RegExpExecArray) => string][] = [
  [/String to replace not found/i, () => 'the text to replace was not found'],
  [/Found (\d+) matches of the string to replace/i, m => `the text to replace matches ${m[1] ?? 'several'} places, not one`],
  [/No changes to make: old_string and new_string are exactly the same/i, () => 'the old and new text are identical'],
  [/File has not been read yet/i, () => 'the file must be read before it can be changed'],
  [/File has been (?:unexpectedly )?modified since (?:it was )?read/i, () => 'the file changed since it was read'],
  [/exceeds maximum allowed tokens|File content \([^)]*\) exceeds/i, () => 'too big to read at once: it needs a line range'],
  [/\bEISDIR\b|is a directory/i, () => 'that is a folder, not a file'],
  [/File does not exist|No such file or directory|ENOENT/i, () => 'file not found'],
  [/Path does not exist/i, () => 'path not found'],
  [/\bEACCES\b|Permission denied/i, () => 'the file system denied access'],
  [/timeout of (\d+)\s*ms exceeded/i, m => `timed out after ${duration(Number(m[1] ?? 0) / 1000)}`],
  [/\btimed out\b|\bETIMEDOUT\b/i, () => 'timed out'],
  [/status code (\d{3})/i, m => `HTTP ${m[1] ?? ''}`.trim()],
  [/No such tool available: ([\w:.-]+)/i, m => `there is no tool named ${m[1] ?? 'that'}`],
  [/InputValidationError|Invalid tool parameters/i, () => 'the tool’s inputs were invalid'],
  [/"verdict"\s*:\s*"deny"\s*,\s*"reason"\s*:\s*"([\w-]+)"/, m => `refused: ${(m[1] ?? '').replace(/_/g, ' ')}`],
]

/** The first line of an error worth showing ('Error:' and working-directory notes dropped). */
function firstLine(preview: string): string | undefined {
  const text = preview
    .slice(0, 4000)
    .replace(/<\/?tool_use_error>/g, '')
    .replace(/<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/g, '')
  for (const raw of text.split(/\r?\n/).slice(0, 60)) {
    let l = raw.replace(ANSI_RE, '').replace(CTRL_RE, '').trim()
    if (l === '' || /^<[\w-]+\s*\/>$/.test(l) || /^This result includes Artifact content/i.test(l)) continue
    l = l.replace(/^Error:\s*/i, '').replace(/\s*Note: your current working directory is .*$/i, '').trim()
    if (WORDY_RE.test(l)) return cut(flatShown(l), NOTE_MAX)
  }
  return undefined
}

function errorNote(preview: string): string | undefined {
  const head = preview.slice(0, 4000)
  for (const [re, say] of ERROR_NOTES) {
    const m = re.exec(head)
    if (m) return say(m)
  }
  return firstLine(preview)
}

const isTruncated = (preview: string): boolean => preview.length >= PREVIEW_CUT - 1

/** The last line of output worth showing (<= 100 chars), skipping blank and decoration lines. */
function lastLine(preview: string): string | undefined {
  const lines = preview.replace(ANSI_RE, '').split(/\r\n|\r|\n/)
  if (isTruncated(preview) && lines.length > 1) lines.pop()
  for (let i = lines.length - 1, seen = 0; i >= 0 && seen < 400; i--, seen++) {
    const l = (lines[i] ?? '').slice(0, 2000).replace(/\t/g, ' ').replace(CTRL_RE, '').trim()
    if (l === '' || !WORDY_RE.test(l) || /^<\/?[\w-]+\s*\/?>$/.test(l)) continue
    return cut(redactSecrets(l).replace(/\s+/g, ' '), OUTPUT_MAX)
  }
  return undefined
}

const nonEmptyLines = (preview: string): string[] =>
  preview.split(/\r?\n/).filter(l => {
    const t = l.trim()
    return t !== '' && t !== '--' && !/^\((?:Results are truncated|Showing)/i.test(t) && !/^\[Showing results/i.test(t)
  })

/** '12 matches', '3 files', 'no matches' from a Grep or Glob result. */
function searchCount(preview: string, unit: 'match' | 'file'): string | undefined {
  const t = preview.trim()
  if (t === '' || /^No (?:matches|files) found/i.test(t)) return unit === 'file' ? 'no files found' : 'no matches'
  let m = /^Found (\d+) files?/i.exec(t)
  if (m) return `${m[1]} ${m[1] === '1' ? 'file' : 'files'}`
  m = /Found (\d+) total occurrences?/i.exec(t)
  if (m) return `${m[1]} ${m[1] === '1' ? 'match' : 'matches'}`
  const lines = nonEmptyLines(preview)
  if (isTruncated(preview) && lines.length > 1) lines.pop()
  const more = isTruncated(preview) ? '+' : ''
  if (unit === 'match') {
    const counts = lines.map(l => /:(\d+)$/.exec(l.trim())).filter((x): x is RegExpExecArray => x !== null)
    if (counts.length > 0 && counts.length === lines.length) {
      const total = counts.reduce((s, x) => s + Number(x[1] ?? 0), 0)
      return `${total}${more} ${total === 1 && more === '' ? 'match' : 'matches'}`
    }
    const numbered = lines.filter(l => /^(?:[^\n:]*:)?\d+:/.test(l)).length
    const n = numbered > 0 ? numbered : lines.length
    return `${n}${more} ${n === 1 && more === '' ? 'match' : 'matches'}`
  }
  const n = lines.length
  return `${n}${more} ${n === 1 && more === '' ? 'file' : 'files'}`
}

const COUNT_NOTE_RE = /^(?:\d+\+? (?:match|matches|files?|lines?|results?|entry|entries|folders?)\b|no (?:match|matches|files|results|entries))/i
const GREPPY: ReadonlySet<string> = new Set(['grep', 'rg', 'ag', 'ack', 'egrep', 'fgrep', 'git grep'])

function endBy(step: Step, status: StepStatus, preview: string): EndPart {
  switch (step.tool) {
    case 'Bash': return endBash(step, status, preview)
    case 'Read': case 'NotebookRead': return endRead(step, status, preview)
    case 'Agent': case 'Task': return endAgent(status, preview)
    case 'Workflow':
      return /Workflow launched in background/i.test(preview) ? { note: 'started in the background', keepRunning: true } : {}
    case 'Monitor':
      return /Monitor started/i.test(preview) ? { note: 'watching in the background' } : {}
    case 'WebSearch': {
      if (status !== 'ok') return {}
      const n = webResults(preview)
      return n === undefined ? {} : { note: n }
    }
    case 'WebFetch': {
      if (status !== 'ok') return {}
      if (/^\s*REDIRECT DETECTED/i.test(preview)) return { note: 'the page redirects to another site' }
      const h = /^\s*#{1,3}\s+(.+)/.exec(preview)
      return h ? { note: flat(h[1] ?? '') } : {}
    }
    case 'Grep': case 'Glob': case 'LS': {
      if (status !== 'ok') return {}
      const n = searchCount(preview, step.tool === 'Grep' && !/^Found \d+ files?/i.test(preview.trim()) ? 'match' : 'file')
      const scene = step.scene.kind === 'search' && n !== undefined ? { ...step.scene, matches: n } : undefined
      return n === undefined ? {} : scene === undefined ? { note: n, detail: n } : { note: n, detail: n, scene }
    }
    case 'AskUserQuestion': {
      if (status !== 'ok') return {}
      const answer = firstAnswer(preview)
      return answer !== undefined ? { note: fitQuote('You answered ', answer, '', NOTE_MAX) } : /answered/i.test(preview) ? { note: 'You answered' } : {}
    }
    case 'ExitPlanMode':
      return status === 'ok' && /approved/i.test(preview) ? { note: 'You approved the plan' } : {}
    case 'ToolSearch': {
      if (status !== 'ok') return {}
      const n = (preview.match(/tool_reference/g) ?? []).length
      return n > 0 ? { note: `loaded ${n} ${plural(n, 'tool', 'tools')}` } : {}
    }
    case 'TaskStop': case 'KillShell': case 'KillBash': {
      if (status !== 'ok') return {}
      const m = /Successfully (?:stopped|killed)[^:]*:\s*\S+\s*\(([\s\S]+)\)\s*$/i.exec(messageOf(preview))
      return { note: m ? fitQuote('stopped ', m[1] ?? '', '', NOTE_MAX) : 'stopped' }
    }
    default:
      return {}
  }
}

function endBash(step: Step, status: StepStatus, preview: string): EndPart {
  const command = step.scene.kind === 'run' && step.target === undefined ? step.scene.command : typeof step.target === 'string' ? step.target : ''
  const a = analysisAgain(command)
  let note: string | undefined
  try {
    const n = bashResultNote(a, status, preview)
    note = typeof n === 'string' && n.trim() !== '' ? n : undefined
  } catch {
    note = undefined
  }
  const background = /^\s*Command running in background/i.test(preview) ? 'started in the background'
    : /moved to the background/i.test(preview) ? 'moved to the background after its time limit' : undefined
  if (note === undefined && background !== undefined) note = background
  if (note === undefined && status === 'error') {
    const code = /^\s*Exit code (\d+)/.exec(preview)?.[1]
    const last = lastLine(preview.replace(/^\s*Exit code \d+\s*\n?/, ''))
    note = code !== undefined ? (last !== undefined ? `exit ${code}: ${last}` : `exit ${code}`) : last
  }
  const out: EndPart = {}
  if (note !== undefined) out.note = note
  const scene = step.scene
  if (scene.kind === 'run') {
    const output = background !== undefined ? 'Running in the background…' : lastLine(preview)
    if (output !== undefined) out.scene = { ...scene, output }
  } else if (scene.kind === 'search') {
    const matches = note !== undefined && COUNT_NOTE_RE.test(note.trim()) ? note : bashMatches(a, status, preview)
    if (matches !== undefined) {
      out.scene = { ...scene, matches: cut(matches, DETAIL_MAX) }
      out.detail = matches
    }
  } else if (
    scene.kind === 'read' && status === 'ok' && scene.files.length === 1 && scene.files[0]?.detail === undefined &&
    preview !== '' && !isTruncated(preview) && arr(a.programs).every(p => p === 'cat') && arr(a.programs).length > 0
  ) {
    const n = lineCount(preview)
    const file = scene.files[0]
    if (file !== undefined) out.scene = { kind: 'read', files: [{ ...file, detail: linesText(n) }] }
  }
  return out
}

function bashMatches(a: BashAnalysis, status: StepStatus, preview: string): string | undefined {
  const body = preview.replace(/^\s*Exit code \d+\s*\n?/, '')
  const greppy = arr(a.programs).some(p => typeof p === 'string' && GREPPY.has(p))
  if (status === 'error' && body.trim() === '') return greppy ? 'no matches' : undefined
  if (status !== 'ok') return undefined
  const lines = nonEmptyLines(body).filter(l => !/^==> .* <==$/.test(l.trim()))
  if (lines.length === 0) return greppy ? 'no matches' : 'nothing found'
  const more = isTruncated(preview) ? '+' : ''
  const n = lines.length
  return greppy ? `${n}${more} ${n === 1 && more === '' ? 'match' : 'matches'}` : `${n}${more} ${n === 1 && more === '' ? 'result' : 'results'}`
}

function endRead(step: Step, status: StepStatus, preview: string): EndPart {
  if (status !== 'ok') return {}
  const head = preview.slice(0, 3000)
  if (/File unchanged since last read/i.test(head)) return { note: 'unchanged since the last read' }
  if (/exists but (?:the contents are|is) empty/i.test(head)) return { note: 'empty file' }
  if (/shorter than the provided offset/i.test(head)) return { note: 'the file is shorter than that' }
  const n = (preview.match(/^\s*\d+(?:\t|→)/gm) ?? []).length
  if (n === 0) return {}
  // a cut preview shows only the first lines: beside a requested range ('lines 1–130') a count would mislead
  if (isTruncated(preview) && step.detail !== undefined && /^(?:lines?|from line|pages?) /.test(step.detail)) return {}
  const note = linesText(n, isTruncated(preview))
  const out: EndPart = { note }
  const scene = step.scene
  const file = scene.kind === 'read' ? scene.files[0] : undefined
  if (scene.kind === 'read' && file !== undefined && file.detail === undefined) {
    out.scene = { kind: 'read', files: [{ ...file, detail: note }, ...scene.files.slice(1)] }
    if (step.detail === undefined) out.detail = note
  }
  return out
}

function endAgent(status: StepStatus, preview: string): EndPart {
  if (/Async agent launched|async_launched/i.test(preview)) return { note: 'started in the background', keepRunning: true }
  if (/remote_launched|launched remotely/i.test(preview)) return { note: 'started in the cloud', keepRunning: true }
  if (status !== 'ok') return {}
  const text = preview.replace(/<[\w-]+\s*\/>/g, '')
  for (const raw of text.split(/\r?\n/).slice(0, 40)) {
    const l = flat(raw.replace(/^\s*(?:#+|[-*>]|\d+[.)])\s*/, '').replace(/[*_`]/g, ''))
    if (l !== '' && WORDY_RE.test(l)) return { note: l }
  }
  return {}
}

/** The first answer in 'Your questions have been answered: "Q"="A", "Q2"="A2"' (questions may hold quotes). */
function firstAnswer(preview: string): string | undefined {
  const i = preview.indexOf('"="')
  if (i < 0) return undefined
  const rest = preview.slice(i + 3, i + 3 + 2000)
  const end = rest.search(/"(?:,\s*"|\.\s|\.?\s*$|\s*\n)/)
  const answer = flat(end < 0 ? rest : rest.slice(0, end))
  return answer === '' ? undefined : answer
}

/** A JSON result's "message" field (TaskStop answers in JSON), else the text itself. */
function messageOf(preview: string): string {
  const t = preview.trim()
  if (t.startsWith('{')) {
    try {
      const v: unknown = JSON.parse(t)
      if (isObj(v) && typeof v.message === 'string') return v.message
    } catch {
      // cut JSON: fall back to the raw text
    }
    const m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(t)
    if (m) return (m[1] ?? '').replace(/\\(["\\/])/g, '$1').replace(/\\[nrt]/g, ' ')
  }
  return t
}

/** '8 results' from a WebSearch result's links list ('8+ results' when the list is cut off). */
function webResults(preview: string): string | undefined {
  if (/No (?:links|results) found/i.test(preview)) return 'no results'
  const i = preview.indexOf('Links: [')
  if (i < 0) return undefined
  const rest = preview.slice(i)
  const n = (rest.match(/"url"\s*:/g) ?? []).length
  if (n === 0) return undefined
  const closed = /\}\s*\]/.test(rest)
  return `${n}${closed ? '' : '+'} ${n === 1 && closed ? 'result' : 'results'}`
}
