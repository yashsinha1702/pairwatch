// Pairwatch's hooks module: every function that touches `$` lives in this file (the validator never
// follows `$` across an import).
//
// Flow. The hooks only push RawEvents onto `queue`: synchronous, cheap, nothing awaited but
// `next`. A 400 ms pump started in session.start folds the queue into $.state (timeline.reduce),
// follows the activity on stage (rules narration at once, a lesson pick, the lesson's depth),
// asks the narrator model for a short narration, saves what the learner met, and keeps a
// status-line fallback while the pane is not shown. The Pane hook only reads state and draws;
// its buttons write through update().
//
// The viewer page (viewer/server.mjs, for editors that draw no mod pane). While it is wanted (the
// 'viewer' setting on, a home folder known, Pairwatch not closed) the pump starts it when nothing
// answers (`node server.mjs --detach`, no shell), writes the view as a snapshot file once it has
// answered, and collects the page's button presses and how many pages show this session (model
// narration needs one, or the pane). session.end marks the snapshot ended. /pairwatch close quiets
// the whole of Pairwatch (no status line, no narration, no snapshots) until /pairwatch opens it again.
//
// Validator rules kept here: `$` is passed only to functions declared at the top of this file;
// `$` and its nouns are never bound or destructured; atoms are the literal consts below, named
// at each call site and never passed as parameters; no event is registered twice unmatched.
import { atom, read, update } from 'claude-code'
import type {
  BoxProps,
  ButtonProps,
  CommandRunResult,
  ElementConstructor,
  EngineInterface,
  MarkdownProps,
  ModelCompleteRequest,
  ModelCompleteResult,
  ModelForkResult,
  Register,
  RenderElement,
  SelectOption,
  TextProps,
  Timer,
  ToolCallResult,
  TurnStepChunk,
  UiOpenResult,
} from 'claude-code'

import type {
  Activity,
  AskState,
  Concept,
  Level,
  LessonState,
  Narration,
  Prefs,
  RawEvent,
  SessionModel,
  Station,
  Step,
  StepStatus,
  ToolEnd,
} from '../types'
import { isConceptId } from './core/concept-ids.ts'
import { getConcept } from './core/concepts.ts'
import { RECENT_MS, depthFor, markSeen, nextLesson, pickLesson } from './core/lessons.ts'
import type { PickCtx, SeenMap } from './core/lessons.ts'
import { NARRATOR_SYSTEM, buildNarrationPrompt, parseNarration, rulesNarration, whyForkPrompt } from './core/narrate.ts'
import { esc } from './core/scenes/kit.ts'
import { renderStage } from './core/stage.ts'
import type { StageInput } from './core/stage.ts'
import { GLYPH, RAIL, RAIL_STOP, verbFor } from './core/stations.ts'
import { paneText, statusLine } from './core/text.ts'
import type { PaneText } from './core/text.ts'
import { currentActivity, emptyModel, reduce, settleHop, stepsOf } from './core/timeline.ts'
import { freshKey, stageInput } from './core/view.ts'

// ---------------------------------------------------------------- constants

const PANE = 'pairwatch'
const TITLE = 'Pairwatch'
const TICK_MS = 400
/** the queue drops its oldest events past this (a stalled pump never grows memory without bound) */
const QUEUE_MAX = 2_000
const ARG_TEXT_MAX = 4_000
/** of a long `command`, this much of its start is kept (the rest of ARG_TEXT_MAX is its end) */
const COMMAND_HEAD = 2_800
const PREVIEW_MAX = 1_500
const BLOCK_TEXT_MAX = 1_500
const ANSWER_MAX = 1_500
const NARRATION_GAP_MS = 2_500
/** a narration may still land for an activity that left the stage less than this ago */
const NARRATION_FRESH_MS = 10_000
/** a narration request still flagged in flight after this is treated as lost */
const NARRATION_STUCK_MS = 30_000
const BACKOFF_MS = 60_000
const MODEL_CALL_CAP = 600
const SAVE_EVERY_MS = 15_000
/** how often (in ticks) the pump re-reads the engine's record of open panes */
const PANES_EVERY_TICKS = 25
/** a pump silent this long (real time) is started again by the next hook that pushes */
const PUMP_QUIET_MS = 5_000
/** a tick still running after this (real time) is taken as lost */
const TICK_STUCK_MS = 10_000
const JOURNAL_MAX = 500
const RECENT_MAX = 12
const ASK_STALE_MS = 90_000
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const SVG_MAX = 120_000
/** Pairwatch's own window: a local page (viewer/server.mjs) that any browser, or VS Code's Simple Browser, shows; the port is a setting. */
const DEFAULT_VIEWER_PORT = 7979
/** the viewer/server.mjs this module expects; an older one still running is asked to quit and replaced */
const VIEWER_VERSION = 3
/** what the viewer's /health calls itself; the server from before the rename said LEGACY_APP (older, whatever its version) */
const VIEWER_APP = 'pairwatch'
const LEGACY_APP = 'claude-tutor'
/** the header that carries the server's key; the server from before the rename reads LEGACY_KEY_HEADER */
const KEY_HEADER = 'x-pairwatch-key'
const LEGACY_KEY_HEADER = 'x-tutor-key'
/** a "Why?" asks the session's own (large) model over the whole conversation: at most one per this */
const WHY_COOLDOWN_MS = 20_000
/** how often (in ticks) the pump collects the page's button presses */
const INBOX_EVERY_TICKS = 2
/** how often (in ticks) the pump looks for a viewer that is not answering */
const VIEWER_RETRY_TICKS = 25
/** after a start, or a request to an older server to make way, the next look comes this soon (in ticks) */
const VIEWER_SOON_TICKS = 3
/** starts of the viewer this module tries before it stops trying (the log says why) */
const VIEWER_LAUNCH_MAX = 5
/** requests to an older server to make way that are made soon after one another; later ones wait for the slow retry */
const QUIT_ASKS_SOON = 3
const NODE_CHECK_MS = 5_000
const VIEWER_LAUNCH_MS = 8_000
/** /pairwatch status shows this much of the end of viewer.log while the page does not answer */
const LOG_TAIL_LINES = 5
const LOG_TAIL_MAX = 600
const NO_NODE_NOTE = "Node.js was not found on PATH; Pairwatch's page needs Node 18 or newer"
const NO_HOME_NOTE = "No home folder is set (HOME or USERPROFILE), so Pairwatch's page is off here; the pane still works"

const DEFAULT_PREFS: Prefs = { level: 1, isPaused: false, useModel: true, autoOpen: true }
const IDLE_ASK: AskState = { status: 'idle' }
const LEVEL_NAME: Record<Level, string> = { 1: 'beginner', 2: 'intermediate', 3: 'expert' }
const LEVEL_OPTIONS: readonly SelectOption[] = [
  { value: '1', label: 'Beginner' },
  { value: '2', label: 'Intermediate' },
  { value: '3', label: 'Expert' },
]
const STATUS_COLOR: Record<StepStatus, string> = { running: 'claude', ok: 'success', error: 'error', denied: 'error' }
const CATEGORY_NAME: Record<Concept['category'], string> = {
  agent: 'agent craft',
  practice: 'good practice',
  shell: 'the shell',
  system: 'the system',
  ml: 'ML and GPUs',
  git: 'git',
  python: 'Python',
  node: 'Node',
  docker: 'Docker',
  data: 'data formats',
  web: 'the web',
}
/** api errors that clear on their own: back off, then try again */
const TRANSIENT_ERRORS: ReadonlySet<string> = new Set(['rate_limit', 'overloaded', 'server_error', 'unknown'])
/** api errors that will not clear this session: narration falls back to rules */
const HARD_ERRORS: ReadonlySet<string> = new Set([
  'authentication_failed',
  'billing_error',
  'model_not_found',
  'invalid_request',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'cloud_credential_error',
])
const RESERVED_ARGS: ReadonlySet<string> = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent'])
/** Permission modes whose 'ask' verdicts no person answers: the auto-mode classifier decides, or the call is refused. */
const NOBODY_ASKED: ReadonlySet<string> = new Set(['auto', 'dontAsk', 'bypassPermissions'])
const EMPTY_TEXT: PaneText = { nowLine: '', narration: '', goalLine: '', lesson: '', askBlock: '', recent: '' }
const IDLE_STAGE: StageInput = {
  station: 'idle',
  status: 'ok',
  title: '',
  scene: { kind: 'idle' },
  trail: [],
  stats: { steps: 0, files: 0, edits: 0, elapsed: '0s' },
  isFresh: false,
  isPaused: false,
}
const HELP = [
  '**/pairwatch** opens the Pairwatch pane (and its page). Also:',
  '- `close`: close it; no status line, narration or page updates, and it stops opening by itself, until /pairwatch opens it again',
  '- `pause`, `resume`',
  '- `level beginner|intermediate|expert`',
  '- `model on|off`: narration by the narrator model',
  '- `auto on|off`: open on your first prompt',
  '- `journal`: what you have met so far',
  '- `reset`: forget the concepts seen and known',
  '- `status`: where the pane and the page are, and what Pairwatch sees',
].join('\n')

// ---------------------------------------------------------------- small pure helpers

/** Calls into the other agents' modules go through here: a throw there never stops the pump or a drawing. */
function attempt<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

/** Text elements refuse every control character but tab and newline (a refused tree closes the pane). */
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
const clean = (s: unknown): string => (typeof s === 'string' ? s.replace(CONTROL_CHARS, '') : '')

const cut = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s)

/** Plain text made safe inside Markdown (a title with `_` or `*` stays as written). */
const mdPlain = (s: string): string => s.replace(/([\\`*_[\]<>#|])/g, '\\$1')

const where = (agentId: string | undefined): { agentId?: string } => (agentId === undefined ? {} : { agentId })

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const blankModel = (now: number): SessionModel =>
  attempt(() => emptyModel(now), {
    steps: [],
    activities: [],
    files: [],
    agents: [],
    stats: { steps: 0, edits: 0, commands: 0, errors: 0, turns: 0, startedAt: now },
    rev: 0,
  })

/** A model as read from state, made safe to draw from (an older shape after a code change reads as blank). */
const saneModel = (m: SessionModel, now: number): SessionModel =>
  Array.isArray(m.steps) && Array.isArray(m.activities) && Array.isArray(m.files) && Array.isArray(m.agents) && isRecord(m.stats)
    ? m
    : blankModel(now)

const isBlank = (m: SessionModel): boolean => m.rev === 0 && m.steps.length === 0 && m.activities.length === 0

/** userConfig 'viewerPort' as a port (the engine already holds it to 1024–65535; anything else is the default). */
const portFrom = (v: unknown): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1024 && v <= 65535 ? v : DEFAULT_VIEWER_PORT

/** The last lines of a log, one line each, at most `max` characters (its end kept: the newest lines matter). */
function logTail(text: string, lines: number, max: number): string {
  const kept = clean(text)
    .split('\n')
    .map(l => l.trimEnd())
    .filter(l => l.trim() !== '')
    .slice(-lines)
    .join('\n')
  return kept.length > max ? `…${kept.slice(kept.length - max + 1)}` : kept
}

// ---------------------------------------------------------------- the atoms (literal refs, declared in types/index.d.ts)

const MODEL = atom({ plugin: 'pairwatch', key: 'model' } as const, blankModel(0))
const NARRATION = atom({ plugin: 'pairwatch', key: 'narration' } as const, null)
const LESSON = atom({ plugin: 'pairwatch', key: 'lesson' } as const, null)
const PREFS = atom({ plugin: 'pairwatch', key: 'prefs' } as const, DEFAULT_PREFS)
const ASK = atom({ plugin: 'pairwatch', key: 'ask' } as const, IDLE_ASK)

// ---------------------------------------------------------------- module memory (lost on a hot reload; $.state and $.store stay)

const queue: RawEvent[] = []
let pump: Timer | undefined
/** true from session.start until a session.end that is not a /clear */
let isPumpWanted = false
let isTicking = false
let tickCount = 0
/** performance.now() at the last tick's start: a pump that went quiet is restarted from a hook */
let tickPerf = Number.NEGATIVE_INFINITY
let narratorModel = 'haiku'
/** the session's permission mode, as the classic events last reported it ('' until one does) */
let permissionMode = ''
let cwd: string | undefined

// Hooks stamp events without awaiting: the last $.clock.now() the pump read, plus the time since.
let clockBase = 0
let perfBase = 0
let isClockSynced = false

// The pump's working copies of what this module last wrote to $.state.
let isStateLoaded = false
let lastModel: SessionModel | undefined
let narrationNow: Narration | null = null
let lessonNow: LessonState | null = null
let prefsNow: Prefs = DEFAULT_PREFS

// The activity the pump last handled, and when each activity was last on stage.
let handledId: string | undefined
let handledSig = ''
const onStageAt = new Map<string, number>()

// Model narration.
const narrated = new Set<string>()
let isNarrating = false
let lastAskedAt = Number.NEGATIVE_INFINITY
let backoffUntil = 0
let modelCalls = 0
let isModelOff = false
let modelNote = ''

// The pane, as this module last heard: ui.open results, ui.close events, drawings, $.ui.panes().
const pane = { isOpen: false, isPlaced: false, hasDrawn: false, epoch: 0 }
/**
 * /pairwatch close (or off) quiets Pairwatch until /pairwatch opens it again: no status line, no
 * model narration, no new cards, no snapshots for the page. Kept in $.store ('off'), so a reload (a
 * settings change reloads the module) or the next session stays quiet too. The pane flags above
 * stay the engine's record of the pane alone.
 */
let isOff = false

/** What the page draws from: the view the pane would draw, and the session it belongs to. */
type Snapshot = { sid: string } & Record<string, unknown>

/** The viewer page: its settings, where its files go, and how its server answers. */
const viewer = {
  /** userConfig 'viewer' */
  isEnabled: true,
  /** userConfig 'viewerPort' */
  port: DEFAULT_VIEWER_PORT,
  /** HOME, else USERPROFILE ('' when neither is set: no page, the pane still works) */
  home: '',
  sid: '',
  key: '',
  /** a server of this version (or newer) answers and its key is known: the inbox is polled */
  isUp: false,
  /** such a server answered once: from then on the snapshots are written */
  hasAnswered: false,
  /** open pages, and those showing this session (`watching`): model narration needs a watcher */
  clients: 0,
  watching: 0,
  /** the pump's next look for a server that does not answer, as a tick count */
  nextLook: VIEWER_RETRY_TICKS,
  launches: 0,
  /** the tick of the last start (a server just started is given a while to answer before another) */
  launchedAt: Number.NEGATIVE_INFINITY,
  /** requests made to an older server to make way since one last answered or nothing did */
  quitAsks: 0,
  node: 'unknown' as 'unknown' | 'ok' | 'missing' | 'old',
  lastSnapKey: '',
  /** the snapshot last written (without `at`): session.end writes it once more, marked ended */
  lastSnap: null as Snapshot | null,
  /** the snapshot write in flight, if any (it settles to whether it landed, never rejects) */
  writing: undefined as Promise<boolean> | undefined,
  /** this session ended: nothing more is written for it */
  isEnded: false,
  /** presses queued while Pairwatch was closed are dropped at the next look */
  isDraining: false,
  note: '',
}
/** One look for the server at a time: session.start, the pump's retry and /pairwatch share the one in flight. */
let viewerLook: Promise<void> | undefined
/** One collection of the page's presses at a time (the pump does not wait for it). */
let isPolling = false
let lastWhyAt = Number.NEGATIVE_INFINITY

const viewerUrl = (): string => `http://localhost:${viewer.port}`
const viewerApi = (): string => `http://127.0.0.1:${viewer.port}`
/** The page's address, with the key that lets it in. */
const viewerLink = (): string => (viewer.key === '' ? viewerUrl() : `${viewerUrl()}/?key=${viewer.key}`)
let statusShown: string | undefined
let isStatusKnown = false
let hasPrompted = false
let isResetPending = false

type JournalEntry = { id: string; at: number }
const learning = {
  known: new Set<string>(),
  seen: {} as SeenMap,
  journal: [] as JournalEntry[],
  /** concept ids shown lately, newest last (pickLesson avoids them) */
  recent: [] as string[],
  isDirty: false,
  savedAt: 0,
}

/**
 * What Pairwatch can see of itself: the surfaces attached, each pane open and its answer, each
 * drawing. Saved to $.store as 'diag' (its developer reads that file) and shown by /pairwatch status.
 */
type OpenNote = { at: number; from: string; isPlaced: boolean; reason?: string }
const diag = {
  surfaces: [] as string[],
  opens: [] as OpenNote[],
  renders: {} as Record<string, number>,
  lastRender: null as null | { at: number; surface: string; placement: string; bodyColumns: number; columns?: number; rows?: number },
  narration: { asked: 0, answered: 0, last: '' },
  isDirty: false,
  savedAt: 0,
}
const DIAG_SAVE_MS = 5_000

function noteOpen(from: string, opened: UiOpenResult): void {
  diag.opens.push({ at: stamp(), from, isPlaced: opened.isPlaced, ...(opened.isPlaced ? {} : { reason: cut(clean(opened.reason), 300) }) })
  if (diag.opens.length > 10) diag.opens.splice(0, diag.opens.length - 10)
  diag.isDirty = true
}

// ---------------------------------------------------------------- capture: hooks push, the pump folds

function syncClock(now: number): void {
  clockBase = now
  perfBase = performance.now()
  isClockSynced = true
}

/** ms since the epoch on the engine's clock, without a round trip. */
function stamp(): number {
  return isClockSynced ? Math.round(clockBase + (performance.now() - perfBase)) : Date.now()
}

function notePermissionMode(mode: unknown): void {
  if (typeof mode === 'string' && mode !== '') permissionMode = mode
}

function push(ev: RawEvent): void {
  queue.push(ev)
  if (queue.length > QUEUE_MAX) queue.splice(0, queue.length - QUEUE_MAX)
}

/** A tool argument as plain JSON: long strings cut, deep or huge structures bounded. */
function plain(v: unknown, depth: number): unknown {
  if (typeof v === 'string') return cut(v, ARG_TEXT_MAX)
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean' || v === null) return v
  if (depth >= 4) return undefined
  if (Array.isArray(v)) return v.slice(0, 200).map(x => plain(x, depth + 1) ?? null)
  if (isRecord(v)) {
    const out: Record<string, unknown> = {}
    let n = 0
    for (const [k, x] of Object.entries(v)) {
      if (n++ >= 100) break
      const p = plain(x, depth + 1)
      if (p !== undefined) out[k] = p
    }
    return out
  }
  return undefined
}

/**
 * A long shell command keeps its head and its tail (4000 characters in all): what runs after a long
 * heredoc, the test or the build, is often the point of the command (with the head alone, a third of
 * the long commands in a sample of real sessions read as the wrong kind of work).
 */
function cutCommand(s: string): string {
  return s.length <= ARG_TEXT_MAX ? s : `${s.slice(0, COMMAND_HEAD)}\n${s.slice(s.length - (ARG_TEXT_MAX - COMMAND_HEAD - 1))}`
}

/** tool.call's `e` minus the reserved keys: the tool's own arguments. */
function argsOf(e: object): { [k: string]: unknown } {
  const out: { [k: string]: unknown } = {}
  for (const [k, v] of Object.entries(e)) {
    if (RESERVED_ARGS.has(k)) continue
    const p = k === 'command' && typeof v === 'string' ? cutCommand(v) : plain(v, 0)
    if (p !== undefined) out[k] = p
  }
  return out
}

function endOf(id: string, ran: ToolCallResult | undefined): ToolEnd {
  if (ran === undefined) return { id, status: 'error', preview: '', at: stamp() }
  const status = ran.deny !== undefined ? 'denied' : ran.isError === true ? 'error' : 'ok'
  const raw: unknown = ran.deny ?? ran.text
  return { id, status, preview: typeof raw === 'string' ? cut(raw, PREVIEW_MAX) : '', at: stamp() }
}

/** A text or thinking block of one turn.step response, collected until it ends. */
type OpenBlock = { mode: 'thinking' | 'text'; text: string }

/** Ends every open block but `keep` (blocks stream one after another, so a new index ends the last). */
function closeBlocks(open: Map<number, OpenBlock>, agentId: string | undefined, keep?: number): void {
  for (const [index, block] of open) {
    if (index === keep) continue
    open.delete(index)
    const text = block.text.trim()
    if (text === '') continue
    push(
      block.mode === 'text'
        ? { kind: 'say', ...where(agentId), text: cut(text, BLOCK_TEXT_MAX), at: stamp() }
        : { kind: 'think', ...where(agentId), text: cut(text, BLOCK_TEXT_MAX), at: stamp() },
    )
  }
}

function seeChunk(open: Map<number, OpenBlock>, agentId: string | undefined, chunk: TurnStepChunk): void {
  switch (chunk.kind) {
    case 'text':
    case 'thinking': {
      closeBlocks(open, agentId, chunk.index)
      let block = open.get(chunk.index)
      if (block === undefined) {
        block = { mode: chunk.kind, text: '' }
        open.set(chunk.index, block)
        push({ kind: 'stream', ...where(agentId), mode: chunk.kind, at: stamp() })
      }
      if (block.text.length < BLOCK_TEXT_MAX && typeof chunk.text === 'string') block.text += chunk.text
      return
    }
    case 'tool':
    case 'input':
      closeBlocks(open, agentId, chunk.index)
      return
    case 'stop':
      closeBlocks(open, agentId)
      return
    default:
      return
  }
}

// ---------------------------------------------------------------- learning data ($.store)

function prefsFrom(v: unknown): Prefs {
  const o = isRecord(v) ? v : {}
  const flag = (x: unknown, fallback: boolean): boolean => (typeof x === 'boolean' ? x : fallback)
  return {
    level: o.level === 1 || o.level === 2 || o.level === 3 ? o.level : DEFAULT_PREFS.level,
    isPaused: flag(o.isPaused, DEFAULT_PREFS.isPaused),
    useModel: flag(o.useModel, DEFAULT_PREFS.useModel),
    autoOpen: flag(o.autoOpen, DEFAULT_PREFS.autoOpen),
  }
}

function seenFrom(v: unknown): SeenMap {
  const out: SeenMap = {}
  if (!isRecord(v)) return out
  for (const [id, x] of Object.entries(v)) {
    if (isRecord(x) && typeof x.n === 'number' && typeof x.last === 'number') out[id] = { n: x.n, last: x.last }
  }
  return out
}

function journalFrom(v: unknown): JournalEntry[] {
  if (!Array.isArray(v)) return []
  const out: JournalEntry[] = []
  for (const x of v) if (isRecord(x) && typeof x.id === 'string' && typeof x.at === 'number') out.push({ id: x.id, at: x.at })
  return out.slice(-JOURNAL_MAX)
}

function levelFrom(word: string): Level | undefined {
  const w = word.toLowerCase()
  if (w === '1' || w.startsWith('beg') || w === 'novice' || w === 'basic') return 1
  if (w === '2' || w.startsWith('int') || w === 'mid' || w === 'medium') return 2
  if (w === '3' || w.startsWith('exp') || w.startsWith('adv')) return 3
  return undefined
}

function switchFrom(word: string): boolean | undefined {
  const w = word.toLowerCase()
  if (w === 'on' || w === 'yes' || w === 'true' || w === '1') return true
  if (w === 'off' || w === 'no' || w === 'false' || w === '0') return false
  return undefined
}

async function loadLearning($: EngineInterface): Promise<void> {
  let stored: unknown[] | undefined
  try {
    stored = await Promise.all([$.store.get('prefs'), $.store.get('known'), $.store.get('seen'), $.store.get('journal'), $.store.get('off')])
  } catch {
    stored = undefined
  }
  if (stored === undefined) {
    // No store: this session's prefs if a reload left them in $.state, else the defaults (the atom's initial).
    try {
      prefsNow = prefsFrom(await read($, PREFS))
    } catch {
      prefsNow = DEFAULT_PREFS
    }
    return
  }
  const [prefs, known, seen, journal, off] = stored
  isOff = off === true
  prefsNow = prefsFrom(prefs)
  learning.known = new Set(Array.isArray(known) ? known.filter((x): x is string => typeof x === 'string') : [])
  learning.seen = seenFrom(seen)
  learning.journal = journalFrom(journal)
  learning.recent = learning.journal.slice(-RECENT_MAX).map(x => x.id)
  learning.isDirty = false
  try {
    prefsNow = await update($, PREFS, () => prefsNow)
  } catch {
    // the pump reads prefs again at its first tick
  }
}

async function savePrefs($: EngineInterface): Promise<void> {
  try {
    await $.store.set('prefs', prefsNow)
  } catch {
    // kept for this session in $.state; the next change tries again
  }
}

async function changePrefs($: EngineInterface, change: (p: Prefs) => Prefs): Promise<Prefs> {
  prefsNow = await update($, PREFS, p => change(prefsFrom(p)))
  await savePrefs($)
  return prefsNow
}

async function saveKnown($: EngineInterface): Promise<void> {
  try {
    await $.store.set('known', [...learning.known])
  } catch {
    // kept in memory; the next save tries again
  }
}

/** /pairwatch close quiets Pairwatch, /pairwatch opens it again: kept across reloads and sessions. */
async function setOff($: EngineInterface, isNowOff: boolean): Promise<void> {
  if (isNowOff && !isOff) viewer.isDraining = true // a press made on the page meanwhile is not acted on later
  isOff = isNowOff
  try {
    await $.store.set('off', isNowOff)
  } catch {
    // kept for this module's life
  }
}

/** Saves seen and journal at most every 15 s (or at once when `isForced`). */
async function saveLearning($: EngineInterface, now: number, isForced: boolean): Promise<void> {
  if (!learning.isDirty || (!isForced && now - learning.savedAt < SAVE_EVERY_MS)) return
  learning.isDirty = false
  learning.savedAt = now
  try {
    await Promise.all([$.store.set('seen', learning.seen), $.store.set('journal', learning.journal)])
  } catch {
    learning.isDirty = true
  }
}

async function forgetLearning($: EngineInterface): Promise<void> {
  learning.known = new Set()
  learning.seen = {}
  learning.journal = []
  learning.recent = []
  learning.isDirty = false
  try {
    await Promise.all([$.store.set('known', []), $.store.set('seen', {}), $.store.set('journal', [])])
  } catch {
    // forgotten in memory; the next save writes the empty values
    learning.isDirty = true
  }
}

// ---------------------------------------------------------------- lessons

/** Concept ids a set of steps teaches: newest step first, each step's most specific first, known to the KB. */
function lessonCandidates(steps: readonly Step[]): string[] {
  const out: string[] = []
  const have = new Set<string>()
  for (let i = steps.length - 1; i >= 0; i--) {
    const concepts = steps[i]?.concepts
    if (!Array.isArray(concepts)) continue
    for (const id of concepts) {
      if (typeof id !== 'string' || have.has(id) || !isConceptId(id) || getConcept(id) === undefined) continue
      have.add(id)
      out.push(id)
    }
  }
  return out
}

const lessonCtx = (now: number): PickCtx => ({
  level: prefsNow.level,
  known: learning.known,
  seen: learning.seen,
  now,
  recent: learning.recent,
})

/** Shown within the last ten minutes (lessons.ts's own measure): no reason to swap the card on show for it. */
const isStale = (id: string, now: number): boolean =>
  learning.recent.includes(id) || now - (learning.seen[id]?.last ?? Number.NEGATIVE_INFINITY) < RECENT_MS

/** Puts a card on show and records that the learner met it (saved within 15 s). */
async function putLesson($: EngineInterface, id: string, now: number, forActivity: string | undefined): Promise<void> {
  const next: LessonState = { conceptId: id, depth: 0, shownAt: now, ...(forActivity === undefined ? {} : { activityId: forActivity }) }
  lessonNow = await update($, LESSON, () => next)
  learning.seen = attempt(() => markSeen(learning.seen, id, now), learning.seen)
  learning.journal.push({ id, at: now })
  if (learning.journal.length > JOURNAL_MAX) learning.journal.splice(0, learning.journal.length - JOURNAL_MAX)
  learning.recent.push(id)
  if (learning.recent.length > RECENT_MAX) learning.recent.splice(0, learning.recent.length - RECENT_MAX)
  learning.isDirty = true
}

/** A new activity's card: the best of its concepts, unless only recently shown ones remain and a card is already up. */
async function lessonForActivity($: EngineInterface, m: SessionModel, act: Activity, now: number): Promise<void> {
  const candidates = lessonCandidates(attempt(() => stepsOf(m, act), []))
  if (candidates.length === 0) return
  const id = attempt(() => pickLesson(candidates, lessonCtx(now)), undefined)
  if (typeof id !== 'string' || !candidates.includes(id) || lessonNow?.conceptId === id) return
  if (lessonNow !== null && isStale(id, now)) return
  await putLesson($, id, now, act.id)
}

/** "Another tip" and "I know this": a different card, from the activity on stage, the recent steps, related and unseen cards. */
async function showAnotherLesson($: EngineInterface, current: string | undefined): Promise<boolean> {
  const now = await $.clock.now()
  const m = saneModel(await read($, MODEL), now)
  const act = attempt(() => currentActivity(m), undefined)
  const onStage = act === undefined ? [] : lessonCandidates(attempt(() => stepsOf(m, act), []))
  const candidates = [...new Set([...onStage, ...lessonCandidates(m.steps.slice(-30))])]
  const id = attempt(() => nextLesson(current, candidates, lessonCtx(now)), undefined)
  if (typeof id !== 'string' || id === current || !isConceptId(id) || getConcept(id) === undefined) return false
  await putLesson($, id, now, act?.id)
  return true
}

// ---------------------------------------------------------------- the pump

function startPump($: EngineInterface): void {
  pump?.cancel()
  isPumpWanted = true
  tickPerf = performance.now()
  pump = $.clock.every(TICK_MS, () => {
    void tick($)
  })
}

function stopPump(): void {
  pump?.cancel()
  pump = undefined
  isPumpWanted = false
}

/** Hooks call this: a pump whose timer stopped firing (a refused period ends an interval) comes back. */
function keepPumping($: EngineInterface): void {
  if (isPumpWanted && performance.now() - tickPerf > PUMP_QUIET_MS) startPump($)
}

async function tick($: EngineInterface): Promise<void> {
  if (isTicking && performance.now() - tickPerf < TICK_STUCK_MS) return
  isTicking = true
  tickPerf = performance.now()
  try {
    const now = await $.clock.now()
    syncClock(now)
    tickCount += 1
    if (!isStateLoaded) await loadState($, now)
    await foldEvents($, now)
    const m = lastModel
    if (m !== undefined) {
      await followActivity($, m, now).catch(() => undefined)
      await deepenLesson($, m, now).catch(() => undefined)
      startNarration($, m, now)
    }
    await saveLearning($, now, false)
    showStatus($, now)
    if (tickCount % PANES_EVERY_TICKS === 0) await refreshPanes($)
    if (tickCount % PANES_EVERY_TICKS === 1) await refreshSurfaces($)
    await saveDiag($, now)
    if (isViewerWanted()) {
      await writeSnapshot($, now)
      // the page's server is asked beside the pump, never waited on: a slow start or a stuck port never holds the stage
      if (viewer.isUp && tickCount % INBOX_EVERY_TICKS === 0) pollInbox($)
      else if (!viewer.isUp && tickCount >= viewer.nextLook) void ensureViewer($).catch(() => undefined)
    }
  } catch {
    // one bad tick never stops the pump
  } finally {
    isTicking = false
  }
}

/** After a (re)load: the pump's working copies come back from $.state. */
async function loadState($: EngineInterface, now: number): Promise<void> {
  const [m, n, l, p] = await Promise.all([read($, MODEL), read($, NARRATION), read($, LESSON), read($, PREFS)])
  lastModel = saneModel(m, now)
  narrationNow = n
  lessonNow = l
  prefsNow = prefsFrom(p)
  if (n !== null) {
    handledId = n.activityId
    if (n.source === 'model') narrated.add(n.activityId)
  }
  isStateLoaded = true
}

/**
 * a. At most one state write per tick: the queued events folded in, then settleHop (an expired
 * hop dropped, a thinking gap put on stage once it lasted): it moves the stage with the clock
 * alone, so it runs every tick and a write follows only when it changed something.
 */
async function foldEvents($: EngineInterface, now: number): Promise<void> {
  const isReset = isResetPending
  if (queue.length === 0 && !isReset) {
    const m = lastModel
    if (m === undefined || attempt(() => settleHop(m, now), m) === m) return
  }
  isResetPending = false
  const batch = queue.splice(0)
  const ctx = { level: prefsNow.level, now, ...(cwd === undefined ? {} : { cwd }) }
  try {
    lastModel = await update($, MODEL, cur => {
      const base = isReset || isBlank(saneModel(cur, now)) ? blankModel(now) : saneModel(cur, now)
      return attempt(() => settleHop(reduce(base, batch, ctx), now), base)
    })
  } catch {
    queue.unshift(...batch.slice(-QUEUE_MAX))
    isResetPending = isResetPending || isReset
    return
  }
  if (isReset) await clearSession($)
}

/** After /clear: a fresh conversation, so a fresh stage (prefs and the card stay). */
async function clearSession($: EngineInterface): Promise<void> {
  const before = viewer.sid
  if (viewer.isEnabled) {
    try {
      viewer.sid = await $.session.id()
    } catch {
      // keep writing under the old id
    }
  }
  // The cleared conversation goes on under a new id: its page says it ended, so a page that
  // follows the newest session moves on to this one at once (here, in the pump: no write races it).
  if (viewer.sid !== before && isSnapshotWanted()) await endSnapshot($, stamp())
  viewer.lastSnap = null
  viewer.lastSnapKey = ''
  handledId = undefined
  handledSig = ''
  narrated.clear()
  onStageAt.clear()
  narrationNow = await update($, NARRATION, () => null)
  await update($, ASK, () => IDLE_ASK)
}

/** A failure is a teaching moment: an activity that ends in an error or a refusal is narrated again. */
const isFailed = (status: StepStatus): boolean => status === 'error' || status === 'denied'

/** What a model narration was asked for: the activity, or the activity once it failed. */
const narrationKey = (act: Activity): string => (isFailed(act.status) ? `${act.id}!` : act.id)

function signatureOf(m: SessionModel, act: Activity): string {
  const latest = m.steps.find(s => s.id === act.stepIds[act.stepIds.length - 1])
  return `${act.headline}|${act.status}|${act.stepIds.length}|${latest?.status ?? ''}|${latest?.resultNote ?? ''}`
}

async function setRulesNarration($: EngineInterface, m: SessionModel, act: Activity, now: number): Promise<void> {
  const value = attempt<Narration | null>(() => rulesNarration(m, act, now), null)
  if (value === null) return
  narrationNow = await update($, NARRATION, () => value)
}

/** b. A new activity on stage: rules narration at once, then a lesson for it. */
async function followActivity($: EngineInterface, m: SessionModel, now: number): Promise<void> {
  const act = attempt(() => currentActivity(m), undefined)
  if (act === undefined) return
  onStageAt.delete(act.id)
  onStageAt.set(act.id, now)
  if (onStageAt.size > 64) {
    const oldest = onStageAt.keys().next().value
    if (oldest !== undefined) onStageAt.delete(oldest)
  }
  const sig = signatureOf(m, act)
  if (act.id !== handledId) {
    handledId = act.id
    handledSig = sig
    await setRulesNarration($, m, act, now)
    // a closed Pairwatch shows no card, so it records none as met
    if (!prefsNow.isPaused && !isOff) await lessonForActivity($, m, act, now)
    return
  }
  if (sig === handledSig) return
  handledSig = sig
  // The activity grew or ended: refresh the rules text, never a model narration of this activity,
  // unless the activity has just failed: words written while it ran are out of date, and the failure
  // (in the rules text at once, then in a new model narration) is the news.
  const n = narrationNow
  const isStale = n !== null && n.source === 'model' && isFailed(act.status) && !narrated.has(narrationKey(act))
  if (n === null || n.activityId !== act.id || n.source === 'rules' || isStale) await setRulesNarration($, m, act, now)
}

/** c. The card deepens while the learner waits; depth only grows. */
async function deepenLesson($: EngineInterface, m: SessionModel, now: number): Promise<void> {
  const shown = lessonNow
  if (shown === null || shown.depth >= 2 || prefsNow.isPaused || isOff) return
  const act = attempt(() => currentActivity(m), undefined)
  const since = Math.max(shown.shownAt, act?.startedAt ?? shown.shownAt)
  const depth = attempt(() => depthFor(now - since), shown.depth)
  if (!(depth > shown.depth)) return
  lessonNow = await update($, LESSON, cur =>
    cur !== null && cur.conceptId === shown.conceptId && depth > cur.depth ? { ...cur, depth } : cur,
  )
}

function isPaneShown(): boolean {
  return pane.isOpen && pane.isPlaced && pane.hasDrawn
}

/**
 * Someone can see this session's Pairwatch: its pane was drawn, or a page shows this session (the
 * server's `watching`; an open page on another session does not count).
 */
function isWatched(): boolean {
  return isPaneShown() || (viewer.isUp && viewer.watching > 0)
}

/** d. One narration request at a time, spaced, only for an activity someone can see. */
function startNarration($: EngineInterface, m: SessionModel, now: number): void {
  if (isNarrating && now - lastAskedAt > NARRATION_STUCK_MS) isNarrating = false
  if (!prefsNow.useModel || prefsNow.isPaused || isModelOff || isNarrating || isOff) return
  if (!isWatched()) return
  if (now - lastAskedAt < NARRATION_GAP_MS || now < backoffUntil) return
  const act = attempt(() => currentActivity(m), undefined)
  if (act === undefined || act.station === 'idle' || narrated.has(narrationKey(act))) return
  if (modelCalls >= MODEL_CALL_CAP) {
    isModelOff = true
    modelNote = `Narration uses rules only now: this session made its ${MODEL_CALL_CAP} narration calls.`
    return
  }
  narrated.add(narrationKey(act))
  if (narrated.size > 200) {
    const first = narrated.values().next().value
    if (first !== undefined) narrated.delete(first)
  }
  isNarrating = true
  lastAskedAt = now
  modelCalls += 1
  void narrate($, m, act, prefsNow.level, now)
    .catch(() => undefined)
    .then(() => {
      isNarrating = false
    })
}

function turnModelOff(why: string): void {
  isModelOff = true
  modelNote = `Narration uses rules only for this session: ${why}.`
}

async function narrate($: EngineInterface, m: SessionModel, act: Activity, level: Level, now: number): Promise<void> {
  const request: ModelCompleteRequest = {
    model: narratorModel,
    prompt: attempt(() => buildNarrationPrompt(m, act, level, now), act.headline) || act.headline || 'Claude is working.',
    maxTokens: 200,
    effort: 'low',
    timeoutMs: 15_000,
  }
  if (NARRATOR_SYSTEM.trim() !== '') request.system = [{ text: NARRATOR_SYSTEM, cache: true }]
  let reply: ModelCompleteResult
  diag.narration.asked += 1
  diag.isDirty = true
  try {
    reply = await $.model.complete(request)
    diag.narration.last = reply.isAnswered ? 'answered' : reply.reason === 'api-error' ? `api-error ${reply.error}` : reply.reason
    if (reply.isAnswered) diag.narration.answered += 1
  } catch {
    diag.narration.last = 'refused by the engine'
    // only a request the engine refuses to send rejects (a blocked model, a bad cap)
    turnModelOff(`the narration model “${narratorModel}” was refused`)
    return
  }
  const at = stamp()
  if (!reply.isAnswered) {
    if (reply.reason !== 'api-error') return
    if (HARD_ERRORS.has(reply.error)) turnModelOff(`the narration model answered “${reply.error.replace(/_/g, ' ')}”`)
    else if (TRANSIENT_ERRORS.has(reply.error) || reply.status === null) backoffUntil = at + BACKOFF_MS
    return
  }
  // switched off, paused or closed while it was asked: the answer is not shown
  if (!prefsNow.useModel || prefsNow.isPaused || isOff) return
  const parsed = attempt(() => parseNarration(reply.text), null)
  if (parsed === null || typeof parsed.now !== 'string' || parsed.now.trim() === '') return
  const current = lastModel === undefined ? undefined : attempt(() => currentActivity(lastModel as SessionModel), undefined)
  const isCurrent = current?.id === act.id
  // asked while it ran, answered after it failed: the failure gets a narration of its own
  const later = lastModel?.activities.find(a => a.id === act.id)
  if (later !== undefined && !isFailed(act.status) && isFailed(later.status)) return
  const seenAt = isCurrent ? at : onStageAt.get(act.id)
  if (seenAt === undefined || at - seenAt > NARRATION_FRESH_MS) return
  const value: Narration = { activityId: act.id, now: parsed.now, why: typeof parsed.why === 'string' ? parsed.why : '', source: 'model', at }
  narrationNow = await update($, NARRATION, n =>
    // a late answer never replaces the model narration of a newer activity
    !isCurrent && n !== null && n.source === 'model' && n.activityId !== act.id ? n : value,
  )
}

/** e. The status line stands in for the pane while it is not shown; it is cleared when the pane shows, or Pairwatch is closed. */
function showStatus($: EngineInterface, now: number): void {
  let text: string | undefined
  if (!isOff && !isPaneShown()) {
    text = prefsNow.isPaused
      ? 'pairwatch: paused (/pairwatch resume)'
      : cut(clean(attempt(() => statusLine(lastModel ?? blankModel(now), narrationNow), '')).replace(/\s+/g, ' ').trim(), 160) || 'pairwatch'
  }
  if (isStatusKnown && text === statusShown) return
  statusShown = text
  isStatusKnown = true
  $.ui.status(text)
}

/** The engine's record of the pane: catches a close this module never heard of (an unload). */
async function refreshPanes($: EngineInterface): Promise<void> {
  const epoch = pane.epoch
  try {
    const panes = await $.ui.panes()
    if (pane.epoch !== epoch) return
    const mine = panes.find(p => p.id === PANE)
    pane.isOpen = mine !== undefined
    pane.isPlaced = mine?.isPlaced ?? false
    if (mine === undefined) pane.hasDrawn = false
  } catch {
    // keep what the module heard
  }
}

async function refreshSurfaces($: EngineInterface): Promise<void> {
  try {
    const surfaces = [...(await $.session.surfaces())].map(String)
    if (surfaces.join() !== diag.surfaces.join()) {
      diag.surfaces = surfaces
      diag.isDirty = true
    }
  } catch {
    // keep what was known
  }
}

function diagReport(): Record<string, unknown> {
  const act = lastModel === undefined ? undefined : attempt(() => currentActivity(lastModel as SessionModel), undefined)
  return {
    surfaces: diag.surfaces,
    pane: { ...pane },
    opens: diag.opens,
    renders: diag.renders,
    lastRender: diag.lastRender,
    statusLine: statusShown ?? null,
    narration: { ...diag.narration, model: narratorModel, isModelOff, modelNote },
    pump: { ticks: tickCount, queue: queue.length, rev: lastModel?.rev ?? 0, steps: lastModel?.steps.length ?? 0 },
    current: act === undefined ? null : { station: act.station, status: act.status, headline: act.headline },
    lesson: lessonNow,
    prefs: prefsNow,
    isOff,
    viewer: {
      isEnabled: viewer.isEnabled,
      port: viewer.port,
      isUp: viewer.isUp,
      hasAnswered: viewer.hasAnswered,
      clients: viewer.clients,
      watching: viewer.watching,
      launches: viewer.launches,
      node: viewer.node,
      note: viewer.note,
    },
  }
}

/** Saves the self-report at most every 5 s, when something changed. */
async function saveDiag($: EngineInterface, now: number): Promise<void> {
  if (!diag.isDirty || now - diag.savedAt < DIAG_SAVE_MS) return
  diag.isDirty = false
  diag.savedAt = now
  try {
    await $.store.set('diag', { at: now, ...diagReport() })
  } catch {
    diag.isDirty = true
  }
}

/** /pairwatch status's word on the page. */
function viewerStatus(): string {
  if (!viewer.isEnabled) return 'off (the Viewer page setting)'
  if (viewer.home === '') return `off (${NO_HOME_NOTE})`
  if (isOff) return 'not updated while Pairwatch is closed'
  if (viewer.isUp) {
    const pages = `${viewer.clients} page${viewer.clients === 1 ? '' : 's'} open, ${viewer.watching} on this session`
    return `running at ${viewerLink()}, ${pages}`
  }
  return `not answering on port ${viewer.port}${viewer.note === '' ? '' : ` (${mdPlain(viewer.note)})`}`
}

/** The end of viewer.log while the page is wanted and does not answer: why it did not start ('' when there is nothing to show). */
async function viewerLogTail($: EngineInterface): Promise<string> {
  if (!isViewerWanted() || viewer.isUp || viewer.node === 'missing' || viewer.node === 'old') return ''
  try {
    return logTail(await $.fs.read(`${dataDir()}/viewer.log`), LOG_TAIL_LINES, LOG_TAIL_MAX)
  } catch {
    return '' // not written yet
  }
}

async function statusText($: EngineInterface): Promise<string> {
  const r = diagReport()
  const opens = diag.opens.length === 0 ? 'none yet' : diag.opens.map(o => `${o.from}: ${o.isPlaced ? 'placed' : `waiting (${o.reason ?? 'no reason given'})`}`).join('; ')
  const renders = Object.entries(diag.renders).map(([s, n]) => `${s} ×${n}`).join(', ') || 'never drawn yet'
  const last = diag.lastRender === null ? '' : ` (last: ${diag.lastRender.surface}, ${diag.lastRender.placement}, ${diag.lastRender.bodyColumns} columns)`
  const cur = r.current as { headline?: string } | null
  const line = statusShown === undefined ? (isOff ? 'off (Pairwatch is closed; /pairwatch opens it)' : 'off (the pane is shown)') : mdPlain(cut(statusShown, 120))
  const lines = [
    '**Pairwatch status**',
    `- Surfaces attached: ${diag.surfaces.join(', ') || 'none reported'}`,
    `- Pane opens: ${opens}`,
    `- Pane drawn: ${renders}${last}`,
    `- Status line: ${line}`,
    `- Narration (${narratorModel}): ${diag.narration.asked} asked, ${diag.narration.answered} answered${diag.narration.last === '' ? '' : `, last: ${diag.narration.last}`}${isModelOff ? ` — ${modelNote}` : ''}${isOff ? ' — none while Pairwatch is closed' : ''}`,
    `- Viewer page: ${viewerStatus()}`,
    `- Pump: ${tickCount} ticks, ${lastModel?.steps.length ?? 0} steps seen; on stage: ${cur?.headline === undefined ? 'nothing yet' : mdPlain(cut(clean(cur.headline), 100))}`,
  ]
  const tail = await viewerLogTail($)
  if (tail !== '') lines.push('', `Last lines of \`${dataDir()}/viewer.log\`:`, '```', tail.replace(/`/g, "'"), '```')
  return lines.join('\n')
}

/** The folder of the plugin itself ($.plugin.root names the plugin's folder; one naming its .claude-plugin is taken up a level). */
function pluginDir($: EngineInterface): string {
  return $.plugin.root.replace(/[\\/]\.claude-plugin[\\/]?$/, '')
}

/** Pairwatch's own folder: the snapshots (live/), the server's key (viewer.token) and its log (viewer.log). */
const dataDir = (): string => `${viewer.home}/.claude/pairwatch`

/** Where the server from before the rename kept its key: it is asked to make way with that key. */
const legacyDir = (): string => `${viewer.home}/.claude/tutor`

/** HOME, else USERPROFILE (Windows sets no HOME); '' when neither is set. Each name is spelled out, as $.env.get wants. */
async function homeFolder($: EngineInterface): Promise<string> {
  try {
    const home = await $.env.get('HOME')
    if (home !== undefined && home.trim() !== '') return home
  } catch {
    // the other one, then
  }
  try {
    const profile = await $.env.get('USERPROFILE')
    if (profile !== undefined && profile.trim() !== '') return profile
  } catch {
    // neither: no page
  }
  return ''
}

const snapshotFile = (sid: string): string => `${dataDir()}/live/${sid}.json`

/** The page is worth serving: the setting is on, a home folder holds its files, Pairwatch is not closed, the session goes on. */
const isViewerWanted = (): boolean => viewer.isEnabled && viewer.home !== '' && !isOff && !viewer.isEnded

/** Snapshots are written once a server answered (never for a page that could not be there). */
const isSnapshotWanted = (): boolean => isViewerWanted() && viewer.hasAnswered && viewer.sid !== ''

/**
 * Who answers on the viewer's port: ours (`current`: this version or newer), an `older` one of ours,
 * the `legacy` one from before the rename (older, whatever its version), or nothing of ours (`none`).
 * It also tells how many pages are open.
 */
async function viewerHealth($: EngineInterface): Promise<'current' | 'older' | 'legacy' | 'none'> {
  let body: unknown
  try {
    const res = await $.http.fetch(`${viewerApi()}/health`)
    if (!res.ok) return 'none'
    body = JSON.parse(res.text)
  } catch {
    return 'none'
  }
  if (!isRecord(body)) return 'none'
  if (body.app === LEGACY_APP) return 'legacy'
  if (body.app !== VIEWER_APP) return 'none'
  if (typeof body.clients === 'number') viewer.clients = body.clients
  const version = typeof body.version === 'number' ? body.version : 1
  return version >= VIEWER_VERSION ? 'current' : 'older'
}

/** A server's key, from the file it keeps that only this user can read ('' while there is none). */
async function keyIn($: EngineInterface, dir: string): Promise<string> {
  try {
    const key = (await $.fs.read(`${dir}/viewer.token`)).trim()
    return /^[A-Za-z0-9_-]{20,}$/.test(key) ? key : ''
  } catch {
    return '' // not made yet: the server writes it when it starts
  }
}

async function readViewerKey($: EngineInterface): Promise<void> {
  const key = await keyIn($, dataDir())
  if (key !== '') viewer.key = key
}

/** Looks for the viewer and starts it when nothing answers; one look at a time, its callers share it. */
function ensureViewer($: EngineInterface): Promise<void> {
  if (!isViewerWanted()) return Promise.resolve()
  if (viewerLook === undefined) {
    viewerLook = lookForViewer($).finally(() => {
      viewerLook = undefined
    })
  }
  return viewerLook
}

async function lookForViewer($: EngineInterface): Promise<void> {
  viewer.nextLook = tickCount + VIEWER_RETRY_TICKS
  const found = await viewerHealth($)
  if (found === 'current') {
    // ours, or a newer one an updated Pairwatch in another session started: it serves this session too
    viewer.hasAnswered = true
    viewer.quitAsks = 0
    await readViewerKey($)
    viewer.isUp = viewer.key !== ''
    viewer.note = viewer.isUp ? '' : `the page answers, but its key (${dataDir()}/viewer.token) could not be read`
    return
  }
  viewer.isUp = false
  if (!isViewerWanted()) return // closed, or ended, while it looked: nothing is asked or started
  if (found !== 'none') {
    // An older server (from before an update, or the rename) holds the port: it is asked to make way.
    // One that frees the port as it answers is replaced at once; one that takes a moment to go, at the
    // next look, soon. One too old to know /api/quit holds the port until it is stopped by hand.
    viewer.quitAsks += 1
    await askViewerToQuit($, found === 'legacy')
    if ((await viewerHealth($)) === 'none') {
      viewer.quitAsks = 0
      if (await launchViewer($)) viewer.nextLook = tickCount + VIEWER_SOON_TICKS
      return
    }
    viewer.note = `an older viewer holds port ${viewer.port} and was asked to make way; if it stays, stop it or choose another Viewer port`
    if (viewer.quitAsks <= QUIT_ASKS_SOON) viewer.nextLook = tickCount + VIEWER_SOON_TICKS
    return
  }
  viewer.quitAsks = 0
  if (tickCount < viewer.launchedAt + VIEWER_RETRY_TICKS) {
    // one started a moment ago may still be coming up: looked for again soon, not started twice
    viewer.nextLook = tickCount + VIEWER_SOON_TICKS
    return
  }
  if (await launchViewer($)) viewer.nextLook = tickCount + VIEWER_SOON_TICKS
}

/** An older server makes way: POST /api/quit with its own key (the one from before the rename keeps it in the old folder, and reads it from its old header). */
async function askViewerToQuit($: EngineInterface, isLegacy: boolean): Promise<void> {
  const key = await keyIn($, isLegacy ? legacyDir() : dataDir())
  try {
    await $.http.fetch(`${viewerApi()}/api/quit`, {
      method: 'POST',
      headers: { [isLegacy ? LEGACY_KEY_HEADER : KEY_HEADER]: key, 'content-type': 'application/json' },
      body: '{}',
    })
  } catch {
    // it may be gone already
  }
}

/** Node.js on PATH, checked once, before the first start: without it there is no page, and the note says why. */
async function hasNode($: EngineInterface): Promise<boolean> {
  if (viewer.node !== 'unknown') return viewer.node === 'ok'
  try {
    const ran = await $.process.run(['node', '--version'], { timeoutMs: NODE_CHECK_MS })
    const version = clean(ran.stdout).trim()
    if (Number(/^v(\d+)\./.exec(version)?.[1]) < 18) {
      viewer.node = 'old'
      viewer.note = `Node.js ${cut(version, 20)} is too old; Pairwatch's page needs Node 18 or newer`
      return false
    }
    viewer.node = 'ok'
    return true
  } catch {
    viewer.node = 'missing'
    viewer.note = NO_NODE_NOTE
    return false
  }
}

/**
 * Starts the server with no shell: `server.mjs --detach` starts itself again as a detached process
 * (its output in viewer.log) and exits at once, so neither this call nor a reload of this module
 * holds it. Resolves whether it was started.
 */
async function launchViewer($: EngineInterface): Promise<boolean> {
  if (viewer.launches >= VIEWER_LAUNCH_MAX) {
    if (viewer.note === '') viewer.note = `no answer after ${VIEWER_LAUNCH_MAX} starts`
    return false
  }
  if (!(await hasNode($))) return false
  viewer.launches += 1
  viewer.launchedAt = tickCount
  try {
    const ran = await $.process.run(
      ['node', `${pluginDir($)}/viewer/server.mjs`, '--detach', '--port', String(viewer.port), '--dir', dataDir()],
      { timeoutMs: VIEWER_LAUNCH_MS },
    )
    const why = cut(clean(ran.stderr).trim().split('\n')[0] ?? '', 160)
    viewer.note = ran.exitCode === 0 ? '' : `server.mjs exited with code ${ran.exitCode}${why === '' ? '' : `: ${why}`}`
    return ran.exitCode === 0
  } catch (err) {
    viewer.note = `node could not run server.mjs: ${cut(clean(String(err)), 160)}`
    return false
  }
}

/** The view the pane would draw, written for the viewer page when it changed (one small file per session). */
async function writeSnapshot($: EngineInterface, now: number): Promise<void> {
  if (!isSnapshotWanted()) return
  const m = lastModel ?? blankModel(now)
  const a = await read($, ASK)
  const view = viewOf(m, narrationNow, lessonNow, prefsNow, a, now)
  const snapshot: Snapshot = {
    v: 1,
    sid: viewer.sid,
    cwd: cwd ?? '',
    svg: stageSource(view.stage, view.fresh),
    alt: view.alt,
    head: view.head,
    lesson: view.lesson,
    ask: view.ask,
    goal: view.goal,
    goalText: cut(clean(m.goal?.text ?? ''), 120),
    recent: view.recent,
    note: view.note || viewer.note,
    station: view.station,
    status: view.status,
    isPaused: view.isPaused,
    isAsking: view.isAsking,
    hasLesson: view.hasLesson,
    level: view.level,
    narrationSource: narrationNow?.source ?? null,
    /** the narratorModel setting: the page names the model that wrote the narration */
    narrator: narratorModel,
  }
  const key = JSON.stringify(snapshot)
  if (key === viewer.lastSnapKey) return
  // again, with nothing awaited from here to the write: the session may have ended meanwhile
  if (!isSnapshotWanted() || snapshot.sid !== viewer.sid) return
  const writing = $.fs.write(snapshotFile(snapshot.sid), JSON.stringify({ ...snapshot, at: now })).then(
    () => true,
    () => false,
  )
  viewer.writing = writing
  const isWritten = await writing
  if (viewer.writing === writing) viewer.writing = undefined
  if (!isWritten) return // the next tick tries again
  viewer.lastSnapKey = key
  viewer.lastSnap = snapshot
}

/** The session's page says it ended: its last snapshot once more, marked (the server's newest-session pick skips it). */
async function endSnapshot($: EngineInterface, now: number): Promise<void> {
  const last = viewer.lastSnap
  if (last === null) return // no page ever showed this session
  viewer.lastSnap = null
  try {
    await $.fs.write(snapshotFile(last.sid), JSON.stringify({ ...last, ended: true, at: now }))
  } catch {
    // the server stops following it once it is quiet
  }
}

/**
 * The session ends: nothing more is written for it but, while snapshots are wanted, its last one
 * once more, marked ended. One write at most (session.end has one short bound for every hook).
 */
async function finishViewer($: EngineInterface, now: number): Promise<void> {
  const isWanted = isSnapshotWanted()
  viewer.isEnded = true // from here the pump writes nothing and starts nothing
  viewer.isUp = false
  if (!isWanted) return
  const pending = viewer.writing
  if (pending !== undefined) await pending // a tick's write in flight lands first, so the ended one is the last
  await endSnapshot($, now)
}

/** Collects the page's presses beside the pump, one collection at a time. */
function pollInbox($: EngineInterface): void {
  if (isPolling) return
  isPolling = true
  void collectPresses($)
    .catch(() => undefined)
    .then(() => {
      isPolling = false
    })
}

/** The buttons pressed on the viewer page since the last look, done here as if pressed in the pane; and who watches. */
async function collectPresses($: EngineInterface): Promise<void> {
  let body: unknown
  try {
    const res = await $.http.fetch(`${viewerApi()}/api/inbox?sid=${encodeURIComponent(viewer.sid)}`, { headers: { [KEY_HEADER]: viewer.key } })
    if (res.status === 403) {
      // The key is not this server's: its file was made anew, or the port is another user's server.
      // It is read again at the next look, a while from now (not a refusal a tick).
      viewer.isUp = false
      viewer.key = ''
      viewer.watching = 0
      viewer.nextLook = tickCount + VIEWER_RETRY_TICKS
      viewer.note = `the page on port ${viewer.port} refused this key; if another user's page holds the port, choose another Viewer port`
      return
    }
    body = JSON.parse(res.text)
  } catch {
    viewer.isUp = false
    viewer.clients = 0
    viewer.watching = 0
    return
  }
  if (!isRecord(body)) return
  if (typeof body.clients === 'number') viewer.clients = body.clients
  // the pages showing this session; a server that does not say counts every open page
  viewer.watching = typeof body.watching === 'number' ? body.watching : viewer.clients
  if (isOff || viewer.isEnded) return // closed, or ended, while it was asked: nothing is acted on
  if (viewer.isDraining) {
    viewer.isDraining = false // pressed while Pairwatch was closed: not acted on now
    return
  }
  const actions = Array.isArray(body.actions) ? body.actions : []
  for (const a of actions.slice(0, 10)) {
    if (!isRecord(a)) continue
    if (a.action === 'why') void askWhy($) // at most one per WHY_COOLDOWN_MS, however often it is pressed
    else if (a.action === 'tip') await anotherTip($)
    else if (a.action === 'known') await knowThis($)
    else if (a.action === 'pause') await togglePause($)
    else if (a.action === 'level' && typeof a.value === 'string') await chooseLevel($, a.value)
  }
}

function markOpened(opened: UiOpenResult): void {
  pane.isOpen = true
  pane.isPlaced = opened.isPlaced
  pane.epoch += 1
}

function markClosed(): void {
  pane.isOpen = false
  pane.isPlaced = false
  pane.hasDrawn = false
  pane.epoch += 1
}

function openOnFirstPrompt($: EngineInterface): void {
  if (isOff) {
    // auto-open is back on since the close (/pairwatch auto on): opening by itself turns Pairwatch on, as /pairwatch does
    void setOff($, false).then(() => ensureViewer($)).catch(() => undefined)
  }
  void $.ui.open({ id: PANE, title: TITLE }).then(
    opened => {
      markOpened(opened)
      noteOpen('first prompt', opened)
    },
    () => undefined,
  )
}

// ---------------------------------------------------------------- /pairwatch

/** What /pairwatch says about the page: its link and how to reach it, or in one line why there is none. */
async function pageText($: EngineInterface, isPanePlaced: boolean): Promise<string> {
  if (!viewer.isEnabled) return isPanePlaced ? '' : 'Its page is off (Pairwatch’s Viewer page setting).'
  if (viewer.home === '') return `${NO_HOME_NOTE}.`
  try {
    await ensureViewer($)
  } catch {
    // the link still says where it will be
  }
  if (viewer.node === 'missing' || viewer.node === 'old') return `${viewer.note}.`
  if (viewer.key === '') await readViewerKey($)
  const port = viewer.port
  const where =
    viewer.key === ''
      ? `Its page is starting on the machine Claude runs on, at ${viewerUrl()}: /pairwatch again in a moment gives its link with the key that lets you in. `
      : `Its page runs on the machine Claude runs on, at ${viewerLink()} (the key in the link keeps others out). `
  const reach =
    `Over SSH, forward port ${port} first: in VS Code open the Ports tab, choose Forward a Port and enter ${port} ` +
    `(or run ssh -N -L ${port}:127.0.0.1:${port} <host> on your computer). ` +
    `Then open that link in Simple Browser (Ctrl+Shift+P, “Simple Browser: Show”) or any browser, beside this chat.`
  const trouble = !viewer.isUp && viewer.note !== '' ? ` It does not answer yet: ${mdPlain(viewer.note)} (/pairwatch status says more).` : ''
  return `${where}${reach}${trouble}`
}

async function openFromCommand($: EngineInterface): Promise<string> {
  await setOff($, false)
  let opened: UiOpenResult | undefined
  try {
    opened = await $.ui.open({ id: PANE, title: TITLE })
  } catch {
    opened = undefined // the status line and the page still work
  }
  if (opened !== undefined) {
    markOpened(opened)
    noteOpen('/pairwatch', opened)
  }
  const page = await pageText($, opened?.isPlaced === true)
  const head =
    opened === undefined
      ? 'Pairwatch could not open its pane here.'
      : diag.surfaces.length === 0 || opened.isPlaced
        ? 'Pairwatch is on.'
        : `Pairwatch’s pane waits (${cut(clean(opened.reason), 200) || 'no surface places it yet'}).`
  return page === '' ? head : `${head} ${page}`
}

/** /pairwatch close (or off): the pane closes, and nothing more is shown, asked or written until /pairwatch. */
async function closeFromCommand($: EngineInterface): Promise<string> {
  await setOff($, true) // first: from here no narration is asked for and no snapshot is written
  try {
    await $.ui.close({ id: PANE })
    markClosed()
  } catch {
    // a hook kept it open: the engine's record, read next, says so
  }
  await refreshPanes($)
  showStatus($, stamp()) // the status line goes now, not at the next tick
  await changePrefs($, p => ({ ...p, autoOpen: false }))
  return 'Pairwatch closed: no status line, narration or page updates, and it won’t open by itself, until /pairwatch opens it again.'
}

function journalText(now: number): string {
  const ids = Object.keys(learning.seen)
  if (ids.length === 0) return 'Your Pairwatch journal is empty: concept cards land here as Claude works.'
  const weekAgo = now - WEEK_MS
  const thisWeek = ids.filter(id => (learning.seen[id]?.last ?? 0) >= weekAgo).length
  const byCategory = new Map<string, number>()
  for (const id of ids) {
    const c = getConcept(id)
    if (c === undefined) continue
    const name = CATEGORY_NAME[c.category] ?? c.category
    byCategory.set(name, (byCategory.get(name) ?? 0) + 1)
  }
  const top = [...byCategory.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
  const latest: string[] = []
  const log = learning.journal.length > 0 ? [...learning.journal].reverse().map(j => j.id) : [...ids].sort((a, b) => (learning.seen[b]?.last ?? 0) - (learning.seen[a]?.last ?? 0))
  for (const id of log) {
    if (latest.length >= 8) break
    const title = mdPlain(clean(getConcept(id)?.title ?? id))
    if (!latest.includes(title)) latest.push(title)
  }
  return [
    '**Pairwatch journal**',
    `- Concepts met: ${ids.length} in all, ${thisWeek} this week`,
    ...(top.length > 0 ? [`- Top topics: ${top.map(([name, n]) => `${name} (${n})`).join(', ')}`] : []),
    `- Most recent: ${latest.join(', ')}`,
    `- Marked as known: ${learning.known.size}`,
  ].join('\n')
}

async function runCommand($: EngineInterface, args: string): Promise<CommandRunResult> {
  const words = args.trim().split(/\s+/).filter(w => w !== '')
  const verb = (words[0] ?? 'open').toLowerCase()
  const arg = words[1] ?? ''
  switch (verb) {
    case 'open':
    case 'show':
    case 'on':
      return { text: await openFromCommand($) }
    case 'close':
    case 'hide':
    case 'off':
      return { text: await closeFromCommand($) }
    case 'pause':
      await changePrefs($, p => ({ ...p, isPaused: true }))
      return { text: 'Pairwatch paused: the stage holds still and no narration is asked for. /pairwatch resume goes on.' }
    case 'resume':
      await changePrefs($, p => ({ ...p, isPaused: false }))
      return { text: 'Pairwatch resumed.' }
    case 'level': {
      const level = levelFrom(arg)
      if (level === undefined) return { text: `Pairwatch level: ${LEVEL_NAME[prefsNow.level]}. Change it with /pairwatch level beginner|intermediate|expert.` }
      await changePrefs($, p => ({ ...p, level }))
      return { text: `Pairwatch level: ${LEVEL_NAME[level]}.` }
    }
    case 'model': {
      const isOn = switchFrom(arg)
      if (isOn === undefined) return { text: `Model narration is ${prefsNow.useModel ? 'on' : 'off'}. /pairwatch model on|off changes it.` }
      if (isOn) {
        isModelOff = false
        modelNote = ''
        backoffUntil = 0
      }
      await changePrefs($, p => ({ ...p, useModel: isOn }))
      return { text: isOn ? `Model narration on (${narratorModel}).` : 'Model narration off: rule-based text only.' }
    }
    case 'auto': {
      const isOn = switchFrom(arg)
      if (isOn === undefined) return { text: `Auto-open is ${prefsNow.autoOpen ? 'on' : 'off'}. /pairwatch auto on|off changes it.` }
      await changePrefs($, p => ({ ...p, autoOpen: isOn }))
      return { text: isOn ? 'Pairwatch opens by itself on your first prompt.' : 'Pairwatch no longer opens by itself; /pairwatch opens it.' }
    }
    case 'journal':
      return { text: journalText(await $.clock.now()) }
    case 'reset':
      await forgetLearning($)
      return { text: 'Pairwatch forgot the concepts you have seen and marked as known.' }
    case 'status':
    case 'debug':
      return { text: await statusText($) }
    case 'help':
    case '?':
      return { text: HELP }
    default:
      return { text: `Unknown option “${cut(clean(words[0] ?? ''), 40)}”. /pairwatch help lists them.` }
  }
}

// ---------------------------------------------------------------- pane handlers (closures call these with the render hook's $)

function forkFailure(reply: ModelForkResult): string {
  if (reply.isAnswered) return ''
  switch (reply.reason) {
    case 'empty-reply':
      return 'Claude gave no answer.'
    case 'aborted':
      return 'The question was interrupted.'
    case 'api-error':
      return `The model could not answer (${reply.error.replace(/_/g, ' ')}).`
    default:
      return 'There was nothing to ask about yet.'
  }
}

/**
 * "Why?", from the pane or the page: one question to the session's own model, at most one per
 * WHY_COOLDOWN_MS (each is a whole turn of that model over the conversation). The cooldown is
 * checked and taken before anything is awaited, so presses that arrive together ask once; a press
 * that sent nothing (one already asking, nothing to ask about yet, a refused call) gives it back.
 */
async function askWhy($: EngineInterface): Promise<void> {
  const pressedAt = stamp()
  if (pressedAt - lastWhyAt < WHY_COOLDOWN_MS) return
  const previous = lastWhyAt
  lastWhyAt = pressedAt
  const now = await $.clock.now()
  const before = await read($, ASK)
  if (before.status === 'asking' && now - before.at < ASK_STALE_MS) {
    lastWhyAt = previous
    return
  }
  const m = saneModel(await read($, MODEL), now)
  const act = attempt(() => currentActivity(m), undefined)
  const about = act === undefined ? {} : { activityId: act.id }
  const asking: AskState = { status: 'asking', ...about, at: now }
  await update($, ASK, () => asking)
  let answer: AskState
  try {
    const reply = await $.model.fork({ prompt: attempt(() => whyForkPrompt(prefsNow.level), 'What are you doing right now, and why?') })
    const at = await $.clock.now()
    if (reply.isAnswered) {
      answer = { status: 'answered', ...about, text: cut(clean(reply.text).trim(), 2_000) || 'Claude gave no answer.', at }
    } else if (reply.reason === 'nothing-to-fork') {
      lastWhyAt = previous
      answer = { status: 'answered', ...about, text: 'Nothing to explain yet.', at }
    } else {
      answer = { status: 'failed', reason: forkFailure(reply), at }
    }
  } catch {
    lastWhyAt = previous
    answer = { status: 'failed', reason: 'The question could not be sent.', at: stamp() }
  }
  await update($, ASK, () => answer)
}

async function anotherTip($: EngineInterface): Promise<void> {
  lessonNow = await read($, LESSON)
  await showAnotherLesson($, lessonNow?.conceptId)
}

async function knowThis($: EngineInterface): Promise<void> {
  const shown = await read($, LESSON)
  if (shown === null) return
  learning.known.add(shown.conceptId)
  await saveKnown($)
  lessonNow = shown
  if (!(await showAnotherLesson($, shown.conceptId))) lessonNow = await update($, LESSON, () => null)
}

async function togglePause($: EngineInterface): Promise<void> {
  await changePrefs($, p => ({ ...p, isPaused: !p.isPaused }))
}

async function chooseLevel($: EngineInterface, value: string): Promise<void> {
  const level = levelFrom(value)
  if (level !== undefined) await changePrefs($, p => ({ ...p, level }))
}

async function cycleLevel($: EngineInterface): Promise<void> {
  await changePrefs($, p => ({ ...p, level: p.level === 3 ? 1 : p.level === 1 ? 2 : 3 }))
}

// ---------------------------------------------------------------- drawing (pure helpers + the element tables)

function fallbackStage(input: StageInput): string {
  const line = `${verbFor(input.station, input.status)}  ${input.title}`.slice(0, 70)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 64" width="640" height="64">` +
    `<rect width="640" height="64" rx="12" fill="#0c1424"/>` +
    `<text x="24" y="39" font-family="system-ui,sans-serif" font-size="17" fill="#e2e8f0">${esc(line)}</text></svg>`
  )
}

// The last stage drawn. The same input gives the byte-identical source (no needless reload of the
// frame), and a step's intro (typing, sliding in) plays only in the first frame that shows it: a
// redraw for its end, a hop cleared or another surface never replays it.
let stageKey = ''
let stageSvg = ''
let stageFresh = ''

function stageSource(input: StageInput, fresh: string): string {
  const key = JSON.stringify({ ...input, isFresh: false })
  if (key === stageKey && stageSvg !== '') return stageSvg
  const drawn = input.isFresh && fresh !== '' && fresh === stageFresh ? { ...input, isFresh: false } : input
  const svg = attempt(() => renderStage(drawn), '')
  stageSvg = clean(typeof svg === 'string' && svg.includes('<svg') && svg.length <= SVG_MAX ? svg : fallbackStage(drawn))
  stageKey = key
  stageFresh = fresh
  return stageSvg
}

type View = {
  head: string
  lesson: string
  ask: string
  goal: string
  recent: string
  note: string
  alt: string
  isPaused: boolean
  isAsking: boolean
  hasLesson: boolean
  level: Level
  station: Station
  status: StepStatus
  stage: StageInput
  /** what is newly on stage (view.ts freshKey): the frame plays its intro once per value */
  fresh: string
}

function viewOf(m: SessionModel, n: Narration | null, l: LessonState | null, p: Prefs, a: AskState, now: number): View {
  const t = attempt(() => paneText({ model: m, narration: n, lesson: l, prefs: p, ask: a, now, ...(cwd === undefined ? {} : { cwd }) }), EMPTY_TEXT)
  const act = attempt(() => currentActivity(m), undefined)
  const head = [clean(t.nowLine), clean(t.narration)].filter(s => s.trim() !== '').join('\n\n')
  const alt = cut(clean(attempt(() => statusLine(m, n), '')).replace(/\s+/g, ' ').trim(), 300)
  return {
    head: head || '**Pairwatch is ready.** It explains what Claude does while you wait.',
    lesson: clean(t.lesson),
    ask: clean(t.askBlock),
    goal: clean(t.goalLine),
    recent: clean(t.recent),
    note: isModelOff && p.useModel ? modelNote : '',
    alt: alt || 'Pairwatch: what Claude is doing',
    isPaused: p.isPaused,
    isAsking: a.status === 'asking',
    hasLesson: l !== null,
    level: p.level,
    station: act?.station ?? 'idle',
    status: act?.status ?? 'ok',
    stage: attempt(() => stageInput(m, p, now, cwd), IDLE_STAGE),
    fresh: attempt(() => freshKey(m), ''),
  }
}

type Kit = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
  Markdown: ElementConstructor<MarkdownProps>
}

/** The terminal's stand-in for the stage: one line of stops, the current one marked. */
function railLine(Text: ElementConstructor<TextProps>, view: View): RenderElement {
  const here = RAIL_STOP[view.station]
  const color = view.station === 'idle' ? 'subtle' : STATUS_COLOR[view.status]
  const parts: RenderElement[] = [<Text color={color}>{`${GLYPH[view.station] ?? '•'} `}</Text>]
  RAIL.forEach((stop, i) => {
    if (i > 0) parts.push(<Text color="subtle"> · </Text>)
    parts.push(
      stop.id === here ? (
        <Text color={color} bold>
          {`[${stop.label}]`}
        </Text>
      ) : (
        <Text color="subtle">{stop.label}</Text>
      ),
    )
  })
  return <Text wrap="truncate-end">{parts}</Text>
}

/** Everything below the stage, the same on every surface; `top` is the Svg or the rail, `picker` the level control. */
function paneColumn($: EngineInterface, kit: Kit, view: View, top: RenderElement, picker: RenderElement): RenderElement {
  const { Box, Text, Button, Markdown } = kit
  return (
    <Box flexDirection="column" gap={1}>
      {top}
      <Markdown key="now" text={view.head} />
      {view.lesson !== '' && <Markdown key="lesson" text={view.lesson} />}
      {view.ask !== '' && <Markdown key="ask" text={view.ask} />}
      {view.goal !== '' && <Markdown key="goal" text={view.goal} dimColor />}
      {view.recent !== '' && <Markdown key="recent" text={view.recent} dimColor />}
      <Box key="controls" flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Button
          key="why"
          label={view.isAsking ? 'Asking…' : 'Why?'}
          hotkey="w"
          onPress={() => {
            void askWhy($)
          }}
        />
        <Button
          key="tip"
          label="Another tip"
          hotkey="t"
          onPress={() => {
            void anotherTip($)
          }}
        />
        <Button
          key="known"
          label="I know this"
          hotkey="k"
          dimColor={!view.hasLesson}
          onPress={() => {
            void knowThis($)
          }}
        />
        <Button
          key="pause"
          label={view.isPaused ? 'Resume' : 'Pause'}
          hotkey="p"
          onPress={() => {
            void togglePause($)
          }}
        />
        {picker}
      </Box>
      {view.note !== '' && <Text dimColor>{view.note}</Text>}
    </Box>
  )
}

// ---------------------------------------------------------------- the hooks

export const register: Register = (on, options) => {
  narratorModel = typeof options.narratorModel === 'string' && options.narratorModel.trim() !== '' ? options.narratorModel : 'haiku'
  viewer.isEnabled = options.viewer !== false
  viewer.port = portFrom(options.viewerPort)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    cwd = started.cwd || e.cwd
    try {
      syncClock(await $.clock.now())
    } catch {
      // the pump syncs at its first tick
    }
    try {
      await $.command.register({
        name: 'pairwatch',
        description: 'Learn while Claude works: a pane that shows and explains what Claude is doing',
        argumentHint: '[open|close|pause|resume|level beginner|intermediate|expert|model on|off|auto on|off|journal|status|reset|help]',
        immediate: true,
      })
    } catch {
      // the pane still works; only the command is missing
    }
    await loadLearning($)
    isStateLoaded = false
    // this session's page: nothing written for it yet, nor ended
    viewer.sid = ''
    viewer.isEnded = false
    viewer.lastSnap = null
    viewer.lastSnapKey = ''
    if (viewer.isEnabled) {
      // the page's files go in the home folder: without one there is no page, and the pane still works
      viewer.home = await homeFolder($)
      try {
        viewer.sid = await $.session.id()
      } catch {
        // no snapshots for this session: the page could not tell it apart
      }
    }
    void ensureViewer($).catch(() => undefined)
    startPump($)
    return started
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      queue.splice(0) // the old conversation's last events; the pump starts the new one blank
      isResetPending = true
      await saveLearning($, stamp(), true)
    } else {
      stopPump()
      // The page's last word on this session (one write at most) beside the learning saved:
      // session.end has one short bound for every hook.
      await Promise.all([finishViewer($, stamp()), saveLearning($, stamp(), true)])
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const entered = await next(e)
    keepPumping($)
    if (entered.drop === undefined) {
      push({ kind: 'prompt', text: cut(entered.text, ARG_TEXT_MAX), origin: (entered.origin ?? e.origin).kind, at: stamp() })
      if (!hasPrompted) {
        hasPrompted = true
        // The person's prompt is behind this call, so the open counts as asked.
        if (prefsNow.autoOpen && !pane.isOpen) openOnFirstPrompt($)
      }
    }
    return entered
  })

  on('turn.start', ($, e, next) => {
    keepPumping($)
    push({ kind: 'turn-start', turnId: e.turnId, at: stamp() })
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const stream = next(e) // once: each call would open a fresh model request
    const open = new Map<number, OpenBlock>()
    try {
      for await (const chunk of stream) {
        try {
          seeChunk(open, e.agentId, chunk)
        } catch {
          // observing never breaks the stream
        }
        yield chunk // the very object: its ref keeps the engine's own item
      }
    } finally {
      try {
        closeBlocks(open, e.agentId)
      } catch {
        // nothing to add
      }
    }
    return await stream.result
  })

  on('turn.complete', ($, e, next) => {
    push({
      kind: 'turn-end',
      turnId: e.turnId,
      ...where(e.agentId),
      durationMs: e.durationMs,
      answer: cut(e.answer, ANSWER_MAX),
      reason: e.reason,
      at: stamp(),
    })
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id
    keepPumping($)
    try {
      push({ kind: 'tool-start', obs: { id, tool: String(e.tool), args: argsOf(e), ...where(e.agentId), at: stamp() } })
    } catch {
      // a call this module cannot read still runs
    }
    let ran: ToolCallResult | undefined
    try {
      ran = await next(e) // the permission prompt, PreToolUse and the tool itself run in here
      return ran // the same object: core keeps its own messages (ref)
    } finally {
      try {
        push({ kind: 'tool-end', end: endOf(id, ran) })
      } catch {
        // nothing to add
      }
    }
  })

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    // 'ask' goes to the mode's decider: the person, unless the session runs in a mode where no one is asked
    if (e.tool_use_id !== undefined && verdict.decision === 'ask' && !NOBODY_ASKED.has(permissionMode)) {
      push({ kind: 'permission', id: e.tool_use_id, tool: String(e.tool), at: stamp() })
    }
    return verdict
  })

  // The session's permission mode, as the classic events report it (shift+tab changes it mid-session).
  on('classic.UserPromptSubmit', ($, e, next) => {
    notePermissionMode(e.permission_mode)
    return next(e)
  })

  on('classic.PostToolUse', ($, e, next) => {
    notePermissionMode(e.permission_mode)
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.agentId !== undefined) {
      push({
        kind: 'agent-start',
        agentId: started.agentId,
        type: e.subagentType,
        description: cut(e.description, 300),
        toolUseId: e.tool_use_id,
        background: e.background,
        at: stamp(),
      })
    }
    return started
  })

  on('classic.SubagentStop', ($, e, next) => {
    push({ kind: 'agent-stop', agentId: e.agent_id, at: stamp() })
    return next(e)
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    if (closed.deny === undefined) markClosed()
    return closed
  })

  on('command.run', { command: 'pairwatch' }, async ($, e) => runCommand($, e.args))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // Being drawn is the surest sign the pane is open and placed (it also heals the flags after a reload).
    if (!pane.isOpen || !pane.isPlaced || !pane.hasDrawn) {
      pane.isOpen = true
      pane.isPlaced = true
      pane.hasDrawn = true
      pane.epoch += 1
    }
    const [rawModel, narration, lesson, rawPrefs, ask, now] = await Promise.all([
      read($, MODEL),
      read($, NARRATION),
      read($, LESSON),
      read($, PREFS),
      read($, ASK),
      $.clock.now(),
    ])
    const prefs = prefsFrom(rawPrefs)
    const view = viewOf(saneModel(rawModel, now), narration, lesson, prefs, ask, now)
    diag.renders[e.surface] = (diag.renders[e.surface] ?? 0) + 1
    diag.lastRender = {
      at: now,
      surface: e.surface,
      placement: String(e.props.placement),
      bodyColumns: e.props.bodyColumns,
      ...(e.viewport === undefined ? {} : { columns: e.viewport.columns, rows: e.viewport.rows }),
    }
    diag.isDirty = true

    if (e.surface === 'terminal') {
      const { Box, Text, Button, Markdown, Select } = $.ui.resolve(e)
      const picker = (
        <Select
          key="level"
          label="Level"
          options={LEVEL_OPTIONS}
          value={String(view.level)}
          onSelect={value => {
            void chooseLevel($, value)
          }}
        />
      )
      return paneColumn($, { Box, Text, Button, Markdown }, view, railLine(Text, view), picker)
    }

    if (e.surface === 'mobile') {
      const { Box, Text, Button, Markdown, Svg } = $.ui.resolve(e)
      const stage = <Svg source={stageSource(view.stage, view.fresh)} alt={view.alt} isInteractive />
      const picker = (
        <Button
          key="level"
          label={`Level: ${LEVEL_NAME[view.level]}`}
          onPress={() => {
            void cycleLevel($)
          }}
        />
      )
      return paneColumn($, { Box, Text, Button, Markdown }, view, stage, picker)
    }

    const { Box, Text, Button, Markdown, Select, Svg } = $.ui.resolve(e)
    const stage = <Svg source={stageSource(view.stage, view.fresh)} alt={view.alt} isInteractive />
    const picker = (
      <Select
        key="level"
        label="Level"
        options={LEVEL_OPTIONS}
        value={String(view.level)}
        onSelect={value => {
          void chooseLevel($, value)
        }}
      />
    )
    return paneColumn($, { Box, Text, Button, Markdown }, view, stage, picker)
  }).catch(($, e) => {
    // A throw inside the hook: a pane nothing draws is closed, so always answer with a tree.
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>Pairwatch could not draw this frame; it tries again at the next change.</Text>
  })
}
