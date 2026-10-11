// The session model: RawEvents in, SessionModel out. Pure, no `$`.
// Contract: the exported names and types below.
//
// How the model is built (all of it derivable from the model itself, so it survives a hot reload
// and a JSON round trip through $.state):
// - Tool calls become Steps through explain.ts (explainTool at the start, applyEnd at the end).
// - Synthetic steps: '#prompt' (a turn opens), '#think' (the model streams with no tool running),
//   '#talk' (the answer after the last tool call), '#permission' (waiting for the person's OK),
//   '#done' (the turn ended). A '#think' gap shorter than THINK_DELAY_MS is dropped when the next
//   tool starts, so quick back-to-back reads still group into 'Reading 3 files'.
// - Steps of one lane and one station whose starts are <= 8 s apart form an Activity.
// - The turn's opening '#prompt' step id carries a snapshot of stats.steps / stats.errors
//   ('#prompt-<n>~s<steps>e<errors>'), so the '#done' recap counts a long turn exactly.
// - Text the person or Claude wrote (the prompt, Claude's words and thinking, a helper's description,
//   an error line) is stored with its secrets masked (redact.ts), so no key reaches the stage, the pane,
//   the narrator or a saved snapshot. Tool steps come masked from explain.ts.
import type { Activity, AgentLane, FileTouch, Level, RawEvent, SceneData, SessionModel, Station, Step, StepStatus, ToolEnd, ToolObs } from '../../types'
import { analyzeBash } from './bash.ts'
import { isConceptId } from './concept-ids.ts'
import { applyEnd, explainTool } from './explain.ts'
import type { ExplainCtx } from './explain.ts'
import { basename, cut, cutTail, firstSentences, fmtDuration, oneLine } from './md.ts'
import { redactSecrets } from './redact.ts'

export type ReduceCtx = { level: Level; cwd?: string; now: number }

/** What reduce leans on to explain tool calls. The defaults are explain.ts and bash.ts; specs pass fakes. */
export type ReduceDeps = {
  explainTool: (obs: ToolObs, ctx: ExplainCtx) => Step
  applyEnd: (step: Step, end: ToolEnd, ctx: ExplainCtx) => Step
  /** files a shell command reads and writes (paths as written in the command) */
  bashFiles: (command: string, description?: string) => { reads: readonly string[]; writes: readonly string[] }
}

export const LIMITS = { steps: 80, activities: 30, files: 40, agents: 12 } as const
/** Consecutive same-station steps of one lane whose starts are this close form one activity. */
export const GROUP_GAP_MS = 8_000
/** How long the avatar's hop animation lasts. */
export const HOP_MS = 1_500
/** A '#think' gap shorter than this is not put on stage, and is dropped when the next tool starts. */
export const THINK_DELAY_MS = 2_500
/** A prompt and a turn-start this close belong to the same turn, whichever arrives first. */
const ATTACH_MS = 15_000
const TRAIL_LEN = 38

const DEFAULT_DEPS: ReduceDeps = {
  explainTool,
  applyEnd,
  bashFiles: (command, description) => {
    const a = analyzeBash(command, description)
    return { reads: a.readsFiles, writes: a.writesFiles }
  },
}

// ---------------------------------------------------------------- wording of synthetic steps

const HEAD = {
  prompt: 'Reading your request',
  promptMid: 'Reading your new message',
  task: 'Reading a finished task’s report',
  resume: 'Continuing the work',
  schedule: 'Waking up on a schedule',
  peer: 'Reading a message from another agent',
  thinking: 'Thinking it through',
  writing: 'Writing to you',
  talk: 'Writing the answer',
  laneThinking: 'Thinking it through',
} as const

const WHY = {
  prompt: 'Claude first works out what you are asking for and how to approach it.',
  task: 'A background job or helper agent finished, so Claude reads its report before deciding what to do next.',
  resume: 'Claude carries on with the task from where it left off.',
  schedule: 'A timer Claude set earlier went off, so it checks on the work it planned.',
  peer: 'Another agent sent Claude a message, so it reads it and decides how to respond.',
  thinking: 'The model reasons before it acts, so its next step fits what it has just learned.',
  writing: 'Claude tells you what it found or what it will do next, so you can follow along.',
  talk: 'Claude reports what it did and found, so you can check the result.',
  permission: 'Claude Code asks before actions that could change your machine, so you stay in control of what runs.',
  done: 'The turn is over: read the answer and check any changes before you ask for the next thing.',
  stopped: 'The turn ended early, so the work may be half done: check what changed before you go on.',
} as const

type PromptKind = 'person' | 'task' | 'resume' | 'schedule' | 'peer'

const PROMPT_CONCEPTS: Record<PromptKind, string[]> = {
  person: ['tool-calls', 'context-window'],
  task: ['background-tasks'],
  resume: ['context-window'],
  schedule: ['scheduling'],
  peer: ['subagents'],
}

// ---------------------------------------------------------------- small guards

const STATIONS: ReadonlySet<string> = new Set(['think', 'plan', 'search', 'read', 'edit', 'run', 'web', 'delegate', 'tools', 'ask', 'talk', 'done', 'idle'])
const STATUSES: ReadonlySet<string> = new Set(['running', 'ok', 'error', 'denied'])
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const VERIFY_CATEGORIES: ReadonlySet<string> = new Set(['test', 'build', 'run-script'])
/** The person (or a rule) refused the call: the tool never ran. */
const REFUSED = /permission to use [\w.-]+ (?:has been|was) denied|doesn['’]t want to (?:proceed|take this action)|user (?:rejected|declined|denied) (?:this|the|your)/i

type Obj = { [k: string]: unknown }
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)
const str = (x: unknown): string => (typeof x === 'string' ? x : '')
const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined)
const isSynthetic = (s: Step): boolean => s.tool.startsWith('#')
const dedupe = (ids: readonly string[]): string[] => [...new Set(ids)]
const conceptIds = (x: unknown): string[] => (Array.isArray(x) ? dedupe(x.filter((c): c is string => typeof c === 'string' && isConceptId(c))) : [])

/** Room past a cut that the masking looks at, so a secret the cut would split is still found whole. */
const MASK_MARGIN = 200
/** The start of a text as it is kept: one line, secrets masked, cut to n characters. */
const shownHead = (t: unknown, n: number): string => cut(redactSecrets(oneLine(t).slice(0, n + MASK_MARGIN)), n)
/** The end of a text as it is kept: one line, secrets masked, the last n characters. */
const shownTail = (t: unknown, n: number): string => cutTail(redactSecrets(oneLine(t).slice(-(n + MASK_MARGIN))), n)

/** A copy holding only what JSON keeps (no undefined, NaN, functions), so $.state always takes it. */
function plain(x: unknown, depth = 0): unknown {
  if (x === null || typeof x === 'string' || typeof x === 'boolean') return x
  if (typeof x === 'number') return Number.isFinite(x) ? x : undefined
  if (typeof x !== 'object' || depth > 6) return undefined
  if (Array.isArray(x)) return x.map(v => plain(v, depth + 1) ?? null)
  const out: Obj = {}
  for (const [k, v] of Object.entries(x)) {
    const p = plain(v, depth + 1)
    if (p !== undefined) out[k] = p
  }
  return out
}

const sceneOf = (x: unknown): SceneData | undefined => {
  if (!isObj(x) || typeof x.kind !== 'string') return undefined
  return plain(x) as SceneData
}

function isStepLike(s: unknown): s is Step {
  return (
    isObj(s) &&
    typeof s.id === 'string' &&
    typeof s.tool === 'string' &&
    typeof s.station === 'string' &&
    STATIONS.has(s.station) &&
    typeof s.headline === 'string' &&
    typeof s.status === 'string' &&
    STATUSES.has(s.status) &&
    typeof s.startedAt === 'number' &&
    Array.isArray(s.concepts) &&
    isObj(s.scene)
  )
}

function isActivityLike(a: unknown): a is Activity {
  return isObj(a) && typeof a.id === 'string' && typeof a.station === 'string' && STATIONS.has(a.station) && Array.isArray(a.stepIds) && typeof a.headline === 'string' && typeof a.status === 'string' && typeof a.startedAt === 'number'
}

const isFileLike = (f: unknown): f is FileTouch => isObj(f) && typeof f.path === 'string' && typeof f.reads === 'number' && typeof f.edits === 'number' && typeof f.last === 'number'
const isLaneLike = (l: unknown): l is AgentLane => isObj(l) && typeof l.id === 'string' && typeof l.label === 'string' && (l.status === 'running' || l.status === 'done')
const isStamped = (x: unknown): x is { text: string; at: number } => isObj(x) && typeof x.text === 'string' && typeof x.at === 'number'

// ---------------------------------------------------------------- the model

export function emptyModel(now: number): SessionModel {
  return { steps: [], activities: [], files: [], agents: [], stats: { steps: 0, edits: 0, commands: 0, errors: 0, turns: 0, startedAt: num(now) ?? 0 }, rev: 0 }
}

/** A fresh, well-formed copy of whatever came in: own arrays, junk entries dropped. */
function normalize(model: unknown, now: number): SessionModel {
  if (!isObj(model)) return emptyModel(now)
  const st = isObj(model.stats) ? model.stats : {}
  const count = (x: unknown): number => Math.max(0, Math.floor(num(x) ?? 0))
  const m: SessionModel = {
    steps: Array.isArray(model.steps) ? model.steps.filter(isStepLike) : [],
    activities: Array.isArray(model.activities) ? model.activities.filter(isActivityLike).map(a => ({ ...a, stepIds: a.stepIds.filter(id => typeof id === 'string') })) : [],
    files: Array.isArray(model.files) ? model.files.filter(isFileLike) : [],
    agents: Array.isArray(model.agents) ? model.agents.filter(isLaneLike) : [],
    stats: { steps: count(st.steps), edits: count(st.edits), commands: count(st.commands), errors: count(st.errors), turns: count(st.turns), startedAt: num(st.startedAt) ?? now },
    rev: Math.max(0, Math.floor(num(model.rev) ?? 0)),
  }
  if (isStamped(model.goal)) m.goal = model.goal
  if (isStamped(model.said)) m.said = model.said
  if (isStamped(model.thought)) m.thought = model.thought
  const t = model.turn
  if (isObj(t) && typeof t.id === 'string' && typeof t.startedAt === 'number' && typeof t.isRunning === 'boolean') {
    m.turn = { id: t.id, startedAt: t.startedAt, isRunning: t.isRunning, ...(typeof t.endedAt === 'number' ? { endedAt: t.endedAt } : {}) }
  }
  if (typeof model.currentId === 'string') m.currentId = model.currentId
  const h = model.hop
  if (isObj(h) && typeof h.from === 'string' && STATIONS.has(h.from) && typeof h.to === 'string' && STATIONS.has(h.to) && typeof h.until === 'number') {
    m.hop = { from: h.from as Station, to: h.to as Station, until: h.until }
  }
  return m
}

/** Working state of one reduce call. */
type Work = {
  m: SessionModel
  ctx: ReduceCtx
  deps: ReduceDeps
  now: number
  /** rev the batch started from: synthetic ids are `${base}.${seq}`, unique across calls */
  base: number
  seq: number
  lanesDirty: boolean
  /** when the last running lane stopped in this batch */
  lanesEndedAt?: number
}

const synthId = (w: Work, tool: string): string => `${tool}-${w.base}.${++w.seq}`

// ---------------------------------------------------------------- lookups

function findStep(w: Work, id: string): number {
  const s = w.m.steps
  for (let i = s.length - 1; i >= 0; i--) if (s[i]!.id === id) return i
  return -1
}

function stepById(m: SessionModel, id: string): Step | undefined {
  const s = m.steps
  for (let i = s.length - 1; i >= 0; i--) if (s[i]!.id === id) return s[i]
  return undefined
}

function activityIndexOf(w: Work, stepId: string): number {
  const a = w.m.activities
  for (let i = a.length - 1; i >= 0; i--) if (a[i]!.stepIds.includes(stepId)) return i
  return -1
}

function newestActivityOfLane(w: Work, lane: string | undefined): number {
  const a = w.m.activities
  for (let i = a.length - 1; i >= 0; i--) if (a[i]!.agentId === lane) return i
  return -1
}

/** The newest real (non-synthetic) step of a lane. */
function prevToolStep(w: Work, lane: string | undefined): Step | undefined {
  const s = w.m.steps
  for (let i = s.length - 1; i >= 0; i--) {
    const st = s[i]!
    if (st.agentId === lane && !isSynthetic(st)) return st
  }
  return undefined
}

function laneHasRunningTool(w: Work, lane: string | undefined): boolean {
  return w.m.steps.some(s => s.agentId === lane && s.status === 'running' && !isSynthetic(s))
}

function openThink(w: Work, lane: string | undefined): number {
  const s = w.m.steps
  for (let i = s.length - 1; i >= 0; i--) {
    const st = s[i]!
    if (st.agentId === lane && st.tool === '#think' && st.status === 'running') return i
  }
  return -1
}

const turnStart = (w: Work): number => w.m.turn?.startedAt ?? Number.NEGATIVE_INFINITY

// ---------------------------------------------------------------- activities

/** Paths an activity's step is about, for 'Reading 3 files'. */
function pathsOf(s: Step): string[] {
  const sc = s.scene
  if (sc.kind === 'read' && Array.isArray(sc.files)) return sc.files.map(f => str(f?.path)).filter(p => p !== '')
  if (sc.kind === 'edit' && typeof sc.path === 'string' && sc.path !== '') return [sc.path]
  return s.target ? [s.target] : []
}

function aggregateHeadline(station: Station, steps: readonly Step[]): string {
  const last = steps[steps.length - 1]
  if (last === undefined) return ''
  const n = steps.length
  if (n === 1) return last.headline
  switch (station) {
    case 'read':
    case 'edit': {
      const paths = new Set(steps.flatMap(pathsOf))
      if (paths.size > 1) return `${station === 'read' ? 'Reading' : 'Editing'} ${paths.size} files`
      const only = [...paths][0]
      if (only === undefined) return last.headline
      return cut(`${station === 'read' ? 'Reading' : 'Editing'} ${basename(only)} (${n} ${station === 'read' ? 'parts' : 'changes'})`, 90)
    }
    case 'run':
      return `Running ${n} commands`
    case 'search':
      return `Searching (${n} searches)`
    case 'web':
      return `Looking things up (${n} requests)`
    case 'delegate':
      return `Delegating to ${n} agents`
    case 'tools':
      return `Using tools (${n} calls)`
    default:
      return last.headline
  }
}

/** Rebuild an activity's headline, status and end from its steps. Removes it when no step is left. */
function refreshActivity(w: Work, ai: number): void {
  const a = w.m.activities[ai]
  if (a === undefined) return
  const steps: Step[] = []
  for (const id of a.stepIds) {
    const s = stepById(w.m, id)
    if (s !== undefined) steps.push(s)
  }
  if (steps.length === 0) {
    w.m.activities.splice(ai, 1)
    return
  }
  const isRunning = steps.some(s => s.status === 'running')
  const last = steps[steps.length - 1]!
  const next: Activity = {
    id: a.id,
    station: a.station,
    stepIds: steps.map(s => s.id),
    headline: cut(aggregateHeadline(a.station, steps), 90),
    status: isRunning ? 'running' : last.status,
    startedAt: steps[0]!.startedAt,
  }
  if (a.agentId !== undefined) next.agentId = a.agentId
  if (!isRunning) next.endedAt = Math.max(...steps.map(s => s.endedAt ?? s.startedAt))
  w.m.activities[ai] = next
}

function refreshActivityOf(w: Work, stepId: string): void {
  const ai = activityIndexOf(w, stepId)
  if (ai >= 0) refreshActivity(w, ai)
}

/** Put a new step into its lane's newest activity, or open a new one. */
function groupStep(w: Work, step: Step): void {
  const acts = w.m.activities
  const ai = newestActivityOfLane(w, step.agentId)
  const a = ai >= 0 ? acts[ai] : undefined
  if (a !== undefined && a.station === step.station) {
    const lastId = a.stepIds[a.stepIds.length - 1]
    const last = lastId === undefined ? undefined : stepById(w.m, lastId)
    if (last !== undefined && step.startedAt - last.startedAt <= GROUP_GAP_MS) {
      acts[ai] = { ...a, stepIds: [...a.stepIds, step.id] }
      refreshActivity(w, ai)
      return
    }
  }
  const fresh: Activity = { id: step.id, station: step.station, stepIds: [step.id], headline: step.headline, status: step.status, startedAt: step.startedAt }
  if (step.agentId !== undefined) fresh.agentId = step.agentId
  acts.push(fresh)
  refreshActivity(w, acts.length - 1)
  capActivities(w)
}

function newestMainDelegate(m: SessionModel): number {
  const a = m.activities
  for (let i = a.length - 1; i >= 0; i--) if (a[i]!.agentId === undefined && a[i]!.station === 'delegate') return i
  return -1
}

function capActivities(w: Work): void {
  const acts = w.m.activities
  while (acts.length > LIMITS.activities) {
    let newestMain = -1
    for (let i = acts.length - 1; i >= 0; i--) {
      if (acts[i]!.agentId === undefined) {
        newestMain = i
        break
      }
    }
    const keep = new Set([newestMain, newestMainDelegate(w.m), acts.length - 1])
    const subOver = acts.filter(a => a.agentId !== undefined && a.status !== 'running').length > LIMITS.activities / 2
    let victim = -1
    if (subOver) victim = acts.findIndex((a, i) => a.agentId !== undefined && a.status !== 'running' && !keep.has(i))
    if (victim < 0) victim = acts.findIndex((a, i) => a.status !== 'running' && !keep.has(i))
    if (victim < 0) victim = acts.findIndex((_, i) => !keep.has(i))
    if (victim < 0) victim = 0
    acts.splice(victim, 1)
  }
}

// ---------------------------------------------------------------- steps

function addStep(w: Work, step: Step): void {
  w.m.steps.push(step)
  groupStep(w, step)
  capSteps(w)
}

function setStep(w: Work, i: number, next: Step): void {
  w.m.steps[i] = next
  refreshActivityOf(w, next.id)
}

function removeStep(w: Work, i: number): void {
  const gone = w.m.steps[i]
  if (gone === undefined) return
  w.m.steps.splice(i, 1)
  const ai = activityIndexOf(w, gone.id)
  if (ai >= 0) {
    const a = w.m.activities[ai]!
    w.m.activities[ai] = { ...a, stepIds: a.stepIds.filter(id => id !== gone.id) }
    refreshActivity(w, ai)
  }
}

/**
 * Never evicted: running steps, the running turn's opening '#prompt' (it holds the stats snapshot),
 * and the newest delegation's steps while its helpers still work (the stage shows them).
 */
function isProtected(w: Work, s: Step, helping: ReadonlySet<string>): boolean {
  if (s.status === 'running' || helping.has(s.id)) return true
  const t = w.m.turn
  return s.tool === '#prompt' && t !== undefined && t.isRunning && s.startedAt >= t.startedAt && SNAPSHOT.test(s.id)
}

function capSteps(w: Work): void {
  const steps = w.m.steps
  if (steps.length <= LIMITS.steps) return
  const di = w.m.agents.some(l => l.status === 'running') ? newestMainDelegate(w.m) : -1
  const helping: ReadonlySet<string> = new Set(di >= 0 ? w.m.activities[di]!.stepIds : [])
  while (steps.length > LIMITS.steps) {
    let subOld = 0
    for (const s of steps) if (s.agentId !== undefined && s.status !== 'running') subOld++
    let victim = -1
    // A busy workflow can flood the window: give up its old steps before the main lane's history.
    if (subOld > LIMITS.steps / 2) victim = steps.findIndex(s => s.agentId !== undefined && s.status !== 'running')
    if (victim < 0) victim = steps.findIndex(s => !isProtected(w, s, helping))
    if (victim < 0) victim = 0
    const gone = steps[victim]!
    steps.splice(victim, 1)
    const ai = activityIndexOf(w, gone.id)
    if (ai >= 0) {
      const a = w.m.activities[ai]!
      const left = a.stepIds.filter(id => id !== gone.id)
      if (left.length === 0) w.m.activities.splice(ai, 1)
      else w.m.activities[ai] = { ...a, stepIds: left }
    }
  }
}

/** End the lane's open '#prompt' / '#think' steps as a tool starts; a short think gap is dropped. */
function closeLaneSynthetics(w: Work, lane: string | undefined, at: number, dropShortThinks: boolean): void {
  const steps = w.m.steps
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]!
    if (s.agentId !== lane || s.status !== 'running') continue
    if (s.tool === '#think') {
      if (dropShortThinks && at - s.startedAt < THINK_DELAY_MS) removeStep(w, i)
      else setStep(w, i, { ...s, status: 'ok', endedAt: Math.max(at, s.startedAt) })
    } else if (s.tool === '#prompt') {
      setStep(w, i, { ...s, status: 'ok', endedAt: Math.max(at, s.startedAt) })
    }
  }
}

// ---------------------------------------------------------------- files

/** Absolute, tidy path ('./a/../b.py' under cwd -> '/cwd/b.py'); '' for things that are not files. */
export function normalizePath(p: string, cwd?: string): string {
  if (typeof p !== 'string') return ''
  let s = p.trim().replace(/^(['"])(.*)\1$/, '$2')
  if (s === '' || s === '-' || s.startsWith('/dev/') || s.startsWith('/proc/') || /[\n*?$`]/.test(s)) return ''
  if (!s.startsWith('/') && !s.startsWith('~') && typeof cwd === 'string' && cwd.startsWith('/')) s = `${cwd.replace(/\/+$/, '')}/${s}`
  if (s.startsWith('/')) {
    const out: string[] = []
    for (const part of s.split('/')) {
      if (part === '' || part === '.') continue
      if (part === '..') out.pop()
      else out.push(part)
    }
    s = '/' + out.join('/')
  }
  return s
}

type Touched = { reads: string[]; writes: string[] }

function filesOf(w: Work, obs: ToolObs): Touched {
  const a = obs.args
  const path = (x: unknown): string[] => {
    const p = normalizePath(str(x), w.ctx.cwd)
    return p === '' ? [] : [p]
  }
  switch (obs.tool) {
    case 'Read':
    case 'NotebookRead':
      return { reads: path(a.file_path ?? a.notebook_path), writes: [] }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return { reads: [], writes: path(a.file_path ?? a.notebook_path) }
    case 'Bash': {
      if (typeof a.command !== 'string') return { reads: [], writes: [] }
      try {
        const f = w.deps.bashFiles(a.command, typeof a.description === 'string' ? a.description : undefined)
        const list = (xs: unknown): string[] => (Array.isArray(xs) ? dedupe(xs.slice(0, 12).flatMap(path)) : [])
        return { reads: list(f.reads), writes: list(f.writes) }
      } catch {
        return { reads: [], writes: [] }
      }
    }
    default:
      return { reads: [], writes: [] }
  }
}

function touchFile(w: Work, path: string, kind: 'read' | 'edit', at: number): void {
  const files = w.m.files
  const i = files.findIndex(f => f.path === path)
  const was = i >= 0 ? files[i] : undefined
  const next: FileTouch = {
    path,
    reads: (was?.reads ?? 0) + (kind === 'read' ? 1 : 0),
    edits: (was?.edits ?? 0) + (kind === 'edit' ? 1 : 0),
    last: Math.max(at, was?.last ?? Number.NEGATIVE_INFINITY),
  }
  if (i >= 0) files.splice(i, 1)
  files.unshift(next)
  if (files.length > LIMITS.files) files.length = LIMITS.files
}

/** Paths read earlier this session, newest last (what explain.ts wants). */
const readPathsOf = (files: readonly FileTouch[]): string[] => files.filter(f => f.reads > 0).map(f => f.path).reverse()

// ---------------------------------------------------------------- lanes (sub-agents)

function laneIndex(w: Work, id: string): number {
  return w.m.agents.findIndex(l => l.id === id)
}

function capAgents(w: Work): void {
  const lanes = w.m.agents
  while (lanes.length > LIMITS.agents) {
    const done = lanes.findIndex(l => l.status === 'done')
    lanes.splice(done >= 0 ? done : 0, 1)
  }
}

/** A lane did something: make sure it is listed (running when `wake`) and says what it is doing. */
function laneSaw(w: Work, id: string, doing: string | undefined, at: number, wake: boolean): boolean {
  let changed = false
  let i = laneIndex(w, id)
  if (i < 0) {
    w.m.agents.push({ id, label: 'Helper agent', status: 'running', startedAt: at })
    capAgents(w)
    i = laneIndex(w, id)
    changed = true
    if (i < 0) return changed
  }
  const lane = w.m.agents[i]!
  const status = wake ? 'running' : lane.status
  const text = doing === undefined ? lane.doing : cut(doing, 80)
  if (lane.status !== status || lane.doing !== text) {
    const next: AgentLane = { ...lane, status }
    if (text !== undefined) next.doing = text
    w.m.agents[i] = next
    changed = true
  }
  if (changed) w.lanesDirty = true
  return changed
}

function laneStopped(w: Work, id: string, at: number): boolean {
  const i = laneIndex(w, id)
  if (i < 0) return false
  const lane = w.m.agents[i]!
  if (lane.status === 'done') return false
  w.m.agents[i] = { ...lane, status: 'done' }
  w.lanesDirty = true
  if (!w.m.agents.some(l => l.status === 'running')) w.lanesEndedAt = at
  return true
}

const sceneOfLanes = (lanes: readonly AgentLane[]): SceneData => ({
  kind: 'delegate',
  agents: lanes.map(l => ({ label: l.label, ...(l.type ? { type: l.type } : {}), status: l.status === 'running' ? 'running' : 'ok', ...(l.doing ? { doing: l.doing } : {}) })),
})

// ---------------------------------------------------------------- explaining tool calls

function explainCtx(w: Work): ExplainCtx {
  return { level: w.ctx.level, ...(w.ctx.cwd === undefined ? {} : { cwd: w.ctx.cwd }), readPaths: readPathsOf(w.m.files) }
}

function startStep(w: Work, obs: ToolObs): Step {
  let raw: unknown
  try {
    raw = w.deps.explainTool(obs, explainCtx(w))
  } catch {
    raw = undefined
  }
  const r: Obj = isObj(raw) ? raw : {}
  const step: Step = {
    id: obs.id,
    tool: obs.tool,
    station: typeof r.station === 'string' && STATIONS.has(r.station) ? (r.station as Station) : 'tools',
    headline: cut(str(r.headline) || `Using ${obs.tool}`, 90),
    why: cut(str(r.why) || 'Claude uses a tool to act on your project.', 170),
    concepts: isObj(raw) ? conceptIds(r.concepts) : ['tool-calls'],
    scene: sceneOf(r.scene) ?? { kind: 'tools', name: obs.tool },
    status: 'running',
    startedAt: obs.at,
  }
  if (obs.agentId !== undefined) step.agentId = obs.agentId
  if (typeof r.target === 'string' && r.target.trim() !== '') step.target = r.target
  if (typeof r.detail === 'string' && r.detail.trim() !== '') step.detail = cut(r.detail, 40)
  return step
}

function endStep(w: Work, step: Step, end: ToolEnd): Step {
  let raw: unknown
  try {
    raw = w.deps.applyEnd(step, end, explainCtx(w))
  } catch {
    raw = undefined
  }
  const r: Obj = isObj(raw) ? raw : {}
  // explain.ts knows refusals best ('You stopped this', a declined edit): its 'denied' wins over a plain error
  const status: StepStatus = end.status === 'error' && r.status === 'denied' ? 'denied' : end.status
  const out: Step = { ...step, status, endedAt: Math.max(end.at, step.startedAt) }
  if (typeof r.headline === 'string' && r.headline.trim() !== '') out.headline = cut(r.headline, 90)
  if (typeof r.why === 'string' && r.why.trim() !== '') out.why = cut(r.why, 170)
  if (typeof r.target === 'string' && r.target.trim() !== '') out.target = r.target
  if (typeof r.detail === 'string' && r.detail.trim() !== '') out.detail = cut(r.detail, 40)
  if (Array.isArray(r.concepts)) out.concepts = dedupe([...conceptIds(r.concepts), ...step.concepts])
  const scene = sceneOf(r.scene)
  if (scene !== undefined) out.scene = scene
  if (typeof r.resultNote === 'string' && r.resultNote.trim() !== '') out.resultNote = cut(r.resultNote, 120)
  if (out.resultNote === undefined && status !== 'ok') {
    const line = end.preview.split('\n').find(l => l.trim() !== '')
    if (line !== undefined) out.resultNote = shownHead(line, 120)
  }
  return out
}

// ---------------------------------------------------------------- agent craft

const isVerifyRun = (s: Step): boolean => s.station === 'run' && s.scene.kind === 'run' && VERIFY_CATEGORIES.has(s.scene.category)

/** An edit in this lane (this turn, for the main lane) with no verifying run after it yet. */
function editAwaitsVerify(w: Work, lane: string | undefined): boolean {
  const since = lane === undefined ? turnStart(w) : Number.NEGATIVE_INFINITY
  const steps = w.m.steps
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]!
    if (s.agentId !== lane || isSynthetic(s)) continue
    if (s.startedAt < since) return false
    if (isVerifyRun(s)) return false
    if (s.station === 'edit') return true
  }
  return false
}

/** The second main-lane tool-start before any of the batch ended. */
function parallelCompletes(w: Work): boolean {
  const since = turnStart(w)
  let running = 0
  for (const s of w.m.steps) {
    if (s.agentId !== undefined || isSynthetic(s) || s.status !== 'running' || s.startedAt < since) continue
    if (s.concepts.includes('parallel-tool-calls')) return false
    running++
  }
  return running >= 1
}

function craftConcepts(w: Work, step: Step, obs: ToolObs, touched: Touched): string[] {
  const out: string[] = []
  const lane = obs.agentId
  const prev = prevToolStep(w, lane)
  if (EDIT_TOOLS.has(obs.tool) && touched.writes.some(p => w.m.files.some(f => f.path === p && f.reads > 0))) out.push('read-before-edit')
  if (step.station === 'read' && prev?.station === 'search') out.push('search-then-read')
  if (isVerifyRun(step) && editAwaitsVerify(w, lane)) out.push('verify-after-change')
  if (prev?.status === 'error') out.push('learning-from-errors')
  if (lane === undefined && parallelCompletes(w)) out.push('parallel-tool-calls')
  return out
}

// ---------------------------------------------------------------- turns

const SNAPSHOT = /~s(\d+)e(\d+)$/

function promptKind(origin: string, text: string): PromptKind {
  if (origin === 'task-notification' || /^\s*<task-notification>/.test(text)) return 'task'
  if (origin === 'auto-continuation' || origin === 'observer' || origin === 'observer-activity') return 'resume'
  if (origin === 'scheduled-trigger') return 'schedule'
  if (origin === 'peer' || origin === 'peer-send-message' || origin === 'coordinator') return 'peer'
  return 'person'
}

function promptTarget(kind: PromptKind, text: string): string | undefined {
  if (kind === 'task') {
    const m = /<summary>([\s\S]*?)<\/summary>/.exec(text)
    const t = oneLine(m ? m[1] : text.replace(/<[^>]+>/g, ' '))
    return t === '' ? undefined : shownHead(t, 600)
  }
  const t = text.trim()
  return t === '' ? undefined : shownHead(t, 600)
}

function promptStep(w: Work, id: string, kind: PromptKind, isMid: boolean, text: string, at: number): Step {
  const head = kind === 'person' ? (isMid ? HEAD.promptMid : HEAD.prompt) : kind === 'task' ? HEAD.task : kind === 'schedule' ? HEAD.schedule : kind === 'peer' ? HEAD.peer : HEAD.resume
  const why = kind === 'person' ? WHY.prompt : WHY[kind]
  const target = promptTarget(kind, text)
  const step: Step = {
    id,
    tool: '#prompt',
    station: 'think',
    headline: head,
    why,
    concepts: PROMPT_CONCEPTS[kind].filter(isConceptId),
    scene: { kind: 'think', ...(target === undefined ? {} : { text: cut(target, 200) }) },
    status: 'running',
    startedAt: at,
  }
  if (target !== undefined) step.target = target
  return step
}

/** Leftovers of a turn that never reported its end: close them so nothing spins forever. */
function closeStaleMain(w: Work, at: number, status: StepStatus): void {
  const steps = w.m.steps
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]!
    if (s.agentId !== undefined || s.status !== 'running') continue
    const st: StepStatus = s.tool === '#think' || s.tool === '#prompt' ? 'ok' : s.tool === '#permission' ? 'denied' : status
    setStep(w, i, { ...s, status: st, endedAt: Math.max(at, s.startedAt) })
  }
}

function startTurn(w: Work, id: string, at: number): void {
  closeStaleMain(w, at, 'ok')
  w.m.turn = { id, startedAt: at, isRunning: true }
  w.m.stats.turns += 1
  // "sub-agents seen this turn": finished lanes go, ones still working stay
  const before = w.m.agents.length
  w.m.agents = w.m.agents.filter(l => l.status === 'running')
  if (w.m.agents.length !== before) w.lanesDirty = true
}

function openingPrompt(w: Work): number {
  const t = w.m.turn
  if (t === undefined) return -1
  const steps = w.m.steps
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!
    if (s.tool === '#prompt' && s.agentId === undefined && s.startedAt >= t.startedAt && SNAPSHOT.test(s.id)) return i
  }
  return -1
}

const snapshotId = (w: Work): string => `${synthId(w, '#prompt')}~s${w.m.stats.steps}e${w.m.stats.errors}`

function onPrompt(w: Work, ev: Obj): boolean {
  const text = str(ev.text)
  const origin = str(ev.origin)
  const at = num(ev.at) ?? w.now
  const kind = promptKind(origin, text)
  const turn = w.m.turn
  const oi = turn?.isRunning ? openingPrompt(w) : -1
  const opening = oi >= 0 ? w.m.steps[oi] : undefined
  if (turn?.isRunning && opening !== undefined && opening.target === undefined && opening.headline === HEAD.resume && at - turn.startedAt <= ATTACH_MS) {
    // turn-start came first: this prompt is what opened the turn
    const filled = promptStep(w, opening.id, kind, false, text, opening.startedAt)
    setStep(w, oi, { ...filled, status: opening.status, ...(opening.endedAt === undefined ? {} : { endedAt: opening.endedAt }) })
  } else if (turn?.isRunning && !turn.id.startsWith('#')) {
    // typed while a turn runs: it joins that turn
    closeLaneSynthetics(w, undefined, at, false)
    addStep(w, promptStep(w, synthId(w, '#prompt'), kind, true, text, at))
  } else {
    startTurn(w, `#turn-${w.base}.${w.seq + 1}`, at)
    addStep(w, promptStep(w, snapshotId(w), kind, false, text, at))
  }
  if (kind === 'person' && text.trim() !== '') w.m.goal = { text: shownHead(text, 600), at }
  return true
}

function onTurnStart(w: Work, ev: Obj): boolean {
  const turnId = str(ev.turnId)
  if (turnId === '') return false
  const at = num(ev.at) ?? w.now
  const turn = w.m.turn
  if (turn !== undefined && turn.id === turnId) return false
  if (turn?.isRunning && turn.id.startsWith('#') && at - turn.startedAt <= ATTACH_MS) {
    w.m.turn = { ...turn, id: turnId } // the prompt came first; now the turn has its real id
    return true
  }
  startTurn(w, turnId, at)
  const step = promptStep(w, snapshotId(w), 'resume', false, '', at)
  addStep(w, step)
  return true
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function turnCounts(w: Work, at: number, durationMs: number | undefined): { steps: number; files: number; seconds: number; errors: number; edits: number } {
  const t = w.m.turn
  const since = t?.startedAt ?? (durationMs !== undefined ? at - durationMs : Number.NEGATIVE_INFINITY)
  const oi = openingPrompt(w)
  const snap = oi >= 0 ? SNAPSHOT.exec(w.m.steps[oi]!.id) : null
  let steps = 0
  let errors = 0
  let edits = 0
  for (const s of w.m.steps) {
    if (isSynthetic(s) || s.startedAt < since) continue
    steps++
    if (s.status === 'error') errors++
    if (s.station === 'edit') edits++
  }
  if (snap !== null) {
    steps = Math.max(steps, w.m.stats.steps - Number(snap[1]))
    errors = Math.max(errors, w.m.stats.errors - Number(snap[2]))
  }
  const files = w.m.files.filter(f => f.last >= since).length
  const ms = durationMs !== undefined && durationMs >= 0 ? durationMs : Number.isFinite(since) ? at - since : 0
  return { steps, files, seconds: Math.max(0, Math.round(ms / 1000)), errors, edits }
}

function onTurnEnd(w: Work, ev: Obj): boolean {
  const at = num(ev.at) ?? w.now
  const agentId = typeof ev.agentId === 'string' && ev.agentId !== '' ? ev.agentId : undefined
  if (agentId !== undefined) {
    // one run of a sub-agent's loop finished: its lane is done
    let changed = laneStopped(w, agentId, at)
    const steps = w.m.steps
    for (let i = steps.length - 1; i >= 0; i--) {
      const s = steps[i]!
      if (s.agentId === agentId && s.status === 'running') {
        setStep(w, i, { ...s, status: s.tool === '#permission' ? 'denied' : 'ok', endedAt: Math.max(at, s.startedAt) })
        changed = true
      }
    }
    return changed
  }
  const turnId = str(ev.turnId)
  const turn = w.m.turn
  if (turn !== undefined && !turn.isRunning && (turn.id === turnId || turnId === '')) return false // already over
  const reason = str(ev.reason) || 'answer'
  const answer = str(ev.answer).trim()
  const durationMs = num(ev.durationMs)
  if (turn === undefined || !turn.isRunning) {
    // a turn whose start we never saw: count from its reported duration
    w.m.turn = { id: turnId || `#turn-${w.base}.${w.seq + 1}`, startedAt: durationMs !== undefined && durationMs >= 0 ? at - durationMs : at, isRunning: true }
  }
  // the answer: visible text after the last tool call becomes '#talk'
  let talkFrom: number | undefined
  const ti = openThink(w, undefined)
  if (ti >= 0) {
    const t = w.m.steps[ti]!
    if (answer !== '' || t.headline === HEAD.writing) {
      talkFrom = t.startedAt
      removeStep(w, ti)
    }
  } else if (answer !== '') {
    const lastTool = prevToolStep(w, undefined)
    const said = w.m.said
    talkFrom = said !== undefined && (lastTool === undefined || said.at >= lastTool.startedAt) ? Math.min(said.at, at) : at
  }
  const status: StepStatus = reason === 'aborted' ? 'denied' : reason === 'error' || reason === 'refusal' ? 'error' : 'ok'
  closeStaleMain(w, at, status)
  if (talkFrom !== undefined) {
    const text = answer !== '' ? shownHead(answer, 600) : w.m.said?.text ?? ''
    const talk: Step = {
      id: synthId(w, '#talk'),
      tool: '#talk',
      station: 'talk',
      headline: HEAD.talk,
      why: WHY.talk,
      concepts: [],
      scene: { kind: 'talk', ...(text === '' ? {} : { text: cut(text, 280) }) },
      status: 'ok',
      startedAt: talkFrom,
      endedAt: Math.max(at, talkFrom),
    }
    const note = firstSentences(text.replace(/[*_`#>]+/g, ''), 1, 120)
    if (note !== '') talk.resultNote = note
    addStep(w, talk)
  }
  const c = turnCounts(w, at, durationMs)
  const dur = fmtDuration(c.seconds * 1000)
  const headline =
    reason === 'aborted'
      ? c.steps > 0 ? `Stopped after ${plural(c.steps, 'step')}` : 'Stopped'
      : reason === 'error'
        ? 'Stopped by an error'
        : reason === 'refusal'
          ? 'Declined the request'
          : c.steps === 0
            ? `Answered in ${dur}`
            : `Done: ${plural(c.steps, 'step')}, ${plural(c.files, 'file')} in ${dur}`
  const done: Step = {
    id: synthId(w, '#done'),
    tool: '#done',
    station: 'done',
    headline: cut(headline, 90),
    why: status === 'ok' ? WHY.done : WHY.stopped,
    concepts: c.edits > 0 && status === 'ok' ? ['code-review'] : [],
    scene: { kind: 'done', steps: c.steps, files: c.files, seconds: c.seconds, errors: c.errors },
    status,
    startedAt: at,
    endedAt: at,
  }
  if (reason === 'aborted') done.resultNote = 'Interrupted'
  addStep(w, done)
  const t = w.m.turn!
  w.m.turn = { id: t.id.startsWith('#') && turnId !== '' ? turnId : t.id, startedAt: t.startedAt, isRunning: false, endedAt: at }
  if (answer !== '') w.m.said = { text: shownHead(answer, 600), at }
  return true
}

// ---------------------------------------------------------------- streaming text and thinking

function thinkStep(w: Work, mode: 'thinking' | 'writing', at: number, snippet: string): Step {
  return {
    id: synthId(w, '#think'),
    tool: '#think',
    station: 'think',
    headline: mode === 'writing' ? HEAD.writing : HEAD.thinking,
    why: mode === 'writing' ? WHY.writing : WHY.thinking,
    concepts: mode === 'writing' ? [] : ['thinking'],
    scene: { kind: 'think', ...(snippet === '' ? {} : { text: snippet }) },
    status: 'running',
    startedAt: at,
  }
}

/** Open (or update) the main lane's '#think' step. mode undefined keeps the step's mode. */
function think(w: Work, mode: 'thinking' | 'writing' | undefined, at: number, snippet: string): boolean {
  const i = openThink(w, undefined)
  if (i < 0) {
    closeLaneSynthetics(w, undefined, at, false) // the opening '#prompt' has been read
    addStep(w, thinkStep(w, mode ?? 'thinking', at, snippet))
    return true
  }
  const s = w.m.steps[i]!
  const isWriting = mode === undefined ? s.headline === HEAD.writing : mode === 'writing'
  const headline = isWriting ? HEAD.writing : HEAD.thinking
  const text = snippet !== '' ? snippet : s.scene.kind === 'think' ? s.scene.text : undefined
  if (headline === s.headline && (s.scene.kind !== 'think' || text === s.scene.text)) return false
  setStep(w, i, {
    ...s,
    headline,
    why: isWriting ? WHY.writing : WHY.thinking,
    concepts: isWriting ? [] : ['thinking'],
    scene: { kind: 'think', ...(text === undefined || text === '' ? {} : { text }) },
  })
  return true
}

function onStream(w: Work, ev: Obj): boolean {
  const at = num(ev.at) ?? w.now
  const lane = typeof ev.agentId === 'string' && ev.agentId !== '' ? ev.agentId : undefined
  if (lane !== undefined) return !laneHasRunningTool(w, lane) && laneSaw(w, lane, HEAD.laneThinking, at, true)
  if (laneHasRunningTool(w, undefined)) return false
  return think(w, ev.mode === 'text' ? 'writing' : 'thinking', at, '')
}

function onSay(w: Work, ev: Obj): boolean {
  const text = str(ev.text).trim()
  const at = num(ev.at) ?? w.now
  if (typeof ev.agentId === 'string' && ev.agentId !== '') return false // a helper's words are its own
  if (text === '') return false
  w.m.said = { text: shownHead(text, 600), at }
  if (!laneHasRunningTool(w, undefined)) think(w, 'writing', at, shownHead(text, 160))
  return true
}

function onThink(w: Work, ev: Obj): boolean {
  const text = str(ev.text).trim()
  const at = num(ev.at) ?? w.now
  if (typeof ev.agentId === 'string' && ev.agentId !== '') return false
  let changed = false
  if (text !== '') {
    w.m.thought = { text: shownTail(text, 400), at }
    changed = true
  }
  if (!laneHasRunningTool(w, undefined)) changed = think(w, undefined, at, text === '' ? '' : shownTail(text, 160)) || changed
  return changed
}

// ---------------------------------------------------------------- tool calls

function readObs(x: unknown, now: number): ToolObs | undefined {
  if (!isObj(x)) return undefined
  const id = str(x.id)
  const tool = str(x.tool)
  if (id === '' || id.startsWith('#') || tool === '') return undefined
  const obs: ToolObs = { id, tool, args: isObj(x.args) ? x.args : {}, at: num(x.at) ?? now }
  if (typeof x.agentId === 'string' && x.agentId !== '') obs.agentId = x.agentId
  return obs
}

function onToolStart(w: Work, ev: Obj): boolean {
  const obs = readObs(ev.obs, w.now)
  if (obs === undefined || findStep(w, obs.id) >= 0) return false
  const lane = obs.agentId
  closeLaneSynthetics(w, lane, obs.at, true)
  let step = startStep(w, obs)
  const touched = filesOf(w, obs)
  const extra = craftConcepts(w, step, obs, touched)
  if (extra.length > 0) step = { ...step, concepts: dedupe([...step.concepts, ...extra]) }
  addStep(w, step)
  for (const p of touched.reads) touchFile(w, p, 'read', obs.at)
  for (const p of touched.writes) touchFile(w, p, 'edit', obs.at)
  const st = w.m.stats
  st.steps += 1
  if (step.station === 'edit') st.edits += 1
  if (obs.tool === 'Bash') st.commands += 1
  if (lane !== undefined) laneSaw(w, lane, step.headline, obs.at, true)
  return true
}

function onToolEnd(w: Work, ev: Obj): boolean {
  const e = ev.end
  if (!isObj(e)) return false
  const id = str(e.id)
  const i = id === '' ? -1 : findStep(w, id)
  if (i < 0) return false
  const prev = w.m.steps[i]!
  if (prev.status !== 'running' || isSynthetic(prev)) return false
  const preview = str(e.preview)
  let status: ToolEnd['status'] = e.status === 'ok' || e.status === 'error' || e.status === 'denied' ? e.status : 'error'
  if (status === 'error' && REFUSED.test(preview.slice(0, 400))) status = 'denied'
  const end: ToolEnd = { id, status, preview, at: num(e.at) ?? w.now }
  const step = endStep(w, prev, end)
  setStep(w, i, step)
  if (step.status === 'error') w.m.stats.errors += 1
  const pi = findStep(w, `#permission-${id}`)
  const perm = pi >= 0 ? w.m.steps[pi] : undefined
  if (perm !== undefined && perm.status === 'running') {
    setStep(w, pi, { ...perm, status: step.status === 'denied' ? 'denied' : 'ok', endedAt: Math.max(end.at, perm.startedAt) })
  }
  if (step.agentId !== undefined) laneSaw(w, step.agentId, step.headline, end.at, false)
  return true
}

const PERMISSION_PHRASE: { [tool: string]: string } = {
  Bash: 'run a command',
  Edit: 'edit a file',
  MultiEdit: 'edit a file',
  Write: 'write a file',
  NotebookEdit: 'edit a notebook',
  WebFetch: 'fetch a web page',
  WebSearch: 'search the web',
  Agent: 'start a helper agent',
  Task: 'start a helper agent',
}

function onPermission(w: Work, ev: Obj): boolean {
  const toolId = str(ev.id)
  if (toolId === '' || findStep(w, `#permission-${toolId}`) >= 0) return false
  const at = num(ev.at) ?? w.now
  const ti = findStep(w, toolId)
  const tool = ti >= 0 ? w.m.steps[ti] : undefined
  if (tool !== undefined && tool.status !== 'running') return false // answered already
  const name = str(ev.tool) || tool?.tool || 'a tool'
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__/.exec(name)
  const phrase = PERMISSION_PHRASE[name] ?? (mcp ? `use ${mcp[1]!.replace(/_/g, ' ')}` : `use ${name}`)
  const step: Step = {
    id: `#permission-${toolId}`,
    tool: '#permission',
    station: 'ask',
    headline: cut(`Waiting for your OK to ${phrase}`, 90),
    why: WHY.permission,
    concepts: ['permissions'],
    scene: { kind: 'ask', question: cut(tool ? `Allow: ${tool.headline}?` : `Allow Claude to ${phrase}?`, 200), isPermission: true },
    status: 'running',
    startedAt: Math.max(at, tool?.startedAt ?? at),
  }
  if (tool?.agentId !== undefined) step.agentId = tool.agentId
  const target = tool?.target ?? tool?.headline
  if (target !== undefined) step.target = target
  addStep(w, step)
  if (step.agentId !== undefined) laneSaw(w, step.agentId, step.headline, at, true)
  return true
}

function onAgentStart(w: Work, ev: Obj): boolean {
  const id = str(ev.agentId)
  if (id === '') return false
  const at = num(ev.at) ?? w.now
  const type = oneLine(ev.type)
  const label = shownHead(oneLine(ev.description) || type || 'Helper agent', 60)
  const i = laneIndex(w, id)
  if (i >= 0) {
    const l = w.m.agents[i]!
    w.m.agents[i] = { ...l, label, ...(type === '' ? {} : { type }), status: 'running' }
  } else {
    w.m.agents.push({ id, label, ...(type === '' ? {} : { type }), status: 'running', startedAt: at })
    capAgents(w)
  }
  w.lanesDirty = true
  return true
}

function onAgentStop(w: Work, ev: Obj): boolean {
  const id = str(ev.agentId)
  return id !== '' && laneStopped(w, id, num(ev.at) ?? w.now)
}

function apply(w: Work, ev: unknown): boolean {
  if (!isObj(ev)) return false
  switch (ev.kind) {
    case 'prompt':
      return onPrompt(w, ev)
    case 'turn-start':
      return onTurnStart(w, ev)
    case 'turn-end':
      return onTurnEnd(w, ev)
    case 'stream':
      return onStream(w, ev)
    case 'say':
      return onSay(w, ev)
    case 'think':
      return onThink(w, ev)
    case 'tool-start':
      return onToolStart(w, ev)
    case 'tool-end':
      return onToolEnd(w, ev)
    case 'permission':
      return onPermission(w, ev)
    case 'agent-start':
      return onAgentStart(w, ev)
    case 'agent-stop':
      return onAgentStop(w, ev)
    default:
      return false
  }
}

// ---------------------------------------------------------------- what is on stage

const isThinkOnly = (a: Activity): boolean => a.station === 'think' && a.stepIds.length > 0 && a.stepIds.every(id => id.startsWith('#think-'))
const isApprovedAsk = (a: Activity): boolean => a.station === 'ask' && a.status === 'ok' && a.stepIds.length > 0 && a.stepIds.every(id => id.startsWith('#permission-'))

/** The activity the stage should show at `now`. */
function pickCurrent(m: SessionModel, now: number): Activity | undefined {
  const acts = m.activities
  let main: Activity | undefined
  let prevMain: Activity | undefined
  let delegate: Activity | undefined
  for (let i = acts.length - 1; i >= 0; i--) {
    const a = acts[i]!
    if (a.station === 'ask' && a.status === 'running') return a // the person is needed, whoever asked
    if (a.agentId !== undefined) continue
    if (main === undefined) main = a
    else if (prevMain === undefined) prevMain = a
    if (delegate === undefined && a.station === 'delegate') delegate = a
  }
  const isYoung = main !== undefined && main.status === 'running' && isThinkOnly(main) && now - main.startedAt < THINK_DELAY_MS
  const isHelping = Array.isArray(m.agents) && m.agents.some(l => l?.status === 'running')
  if (delegate !== undefined && (delegate.status === 'running' || isHelping)) {
    const isMainBusy = main !== undefined && main !== delegate && main.status === 'running' && !isYoung
    if (!isMainBusy) return delegate
  }
  if (main === undefined) return acts[acts.length - 1]
  const pick = isYoung && prevMain !== undefined ? prevMain : main
  if (isApprovedAsk(pick)) {
    const toolId = pick.stepIds[0]!.slice('#permission-'.length)
    const guarded = acts.find(a => a.stepIds.includes(toolId))
    if (guarded !== undefined) return guarded
  }
  return pick
}

function stationOf(m: SessionModel, id: string | undefined): Station {
  const a = id === undefined ? undefined : m.activities.find(x => x.id === id)
  return a?.station ?? m.activities[m.activities.length - 1]?.station ?? 'idle'
}

/** Lanes on the delegate activity's scene, its status while helpers work, then currentId and the hop. */
function finish(w: Work, prevStation: Station): void {
  const m = w.m
  const di = newestMainDelegate(m)
  if (di >= 0) {
    const id = m.activities[di]!.id
    if (w.lanesDirty) {
      if (m.agents.length > 0) {
        const scene = sceneOfLanes(m.agents)
        for (const sid of m.activities[di]!.stepIds) {
          const si = findStep(w, sid)
          if (si >= 0) m.steps[si] = { ...m.steps[si]!, scene }
        }
      }
      refreshActivity(w, di) // status from its steps; the helpers' share comes next
    }
    const a = m.activities[di]
    const isHelping = m.agents.some(l => l.status === 'running')
    if (a !== undefined && a.id === id) {
      if (isHelping && a.status !== 'running') {
        const { endedAt: _, ...rest } = a
        m.activities[di] = { ...rest, status: 'running' }
      } else if (!isHelping && w.lanesEndedAt !== undefined && a.endedAt !== undefined) {
        m.activities[di] = { ...a, endedAt: Math.max(a.endedAt, w.lanesEndedAt) }
      }
    }
  }
  const cur = pickCurrent(m, w.now)
  if (cur === undefined) delete m.currentId
  else m.currentId = cur.id
  const station = cur?.station ?? 'idle'
  if (station !== prevStation) m.hop = { from: prevStation, to: station, until: w.now + HOP_MS }
  else if (m.hop !== undefined && w.now > m.hop.until) delete m.hop
}

// ---------------------------------------------------------------- exports

/** reduce with explicit dependencies (specs pass fakes for explain.ts / bash.ts). */
export function reduceWith(deps: Partial<ReduceDeps>, model: SessionModel, events: readonly RawEvent[], ctx: ReduceCtx): SessionModel {
  try {
    const now = num(ctx?.now) ?? Date.now()
    const isValid = isObj(model)
    if (!Array.isArray(events) || events.length === 0) return isValid ? model : emptyModel(now)
    const level: Level = ctx?.level === 1 || ctx?.level === 2 || ctx?.level === 3 ? ctx.level : 1
    const m = normalize(model, now)
    const prevStation = stationOf(m, m.currentId)
    const w: Work = {
      m,
      ctx: { level, now, ...(typeof ctx?.cwd === 'string' && ctx.cwd !== '' ? { cwd: ctx.cwd } : {}) },
      deps: { ...DEFAULT_DEPS, ...deps },
      now,
      base: m.rev,
      seq: 0,
      lanesDirty: false,
    }
    let changed = 0
    for (const ev of events) {
      try {
        if (apply(w, ev)) changed++
      } catch {
        // a malformed event is skipped; the rest of the batch still counts
      }
    }
    if (changed === 0) return isValid ? model : m
    finish(w, prevStation)
    m.rev = w.base + changed
    return m
  } catch {
    return isObj(model) ? model : emptyModel(num(ctx?.now) ?? 0)
  }
}

/** Fold a batch of events (oldest first) into the model. Never throws; unknown events are ignored. */
export function reduce(model: SessionModel, events: readonly RawEvent[], ctx: ReduceCtx): SessionModel {
  return reduceWith(DEFAULT_DEPS, model, events, ctx)
}

/** The activity on stage, if any. */
export function currentActivity(model: SessionModel): Activity | undefined {
  const acts = Array.isArray(model?.activities) ? model.activities : []
  return acts.find(a => a.id === model.currentId) ?? acts[acts.length - 1]
}

/** The steps of an activity, oldest first. */
export function stepsOf(model: SessionModel, activity: Activity): Step[] {
  if (!Array.isArray(model?.steps) || !Array.isArray(activity?.stepIds)) return []
  const ids = new Set(activity.stepIds)
  return model.steps.filter(s => ids.has(s.id))
}

/**
 * Settle the stage with the clock (call from the pump): drop an expired avatar hop, and put a
 * '#think' gap on stage once it has lasted THINK_DELAY_MS. Returns the same object when nothing changed.
 */
export function settleHop(model: SessionModel, now: number): SessionModel {
  try {
    if (!Array.isArray(model?.activities) || !Number.isFinite(now)) return model
    const cur = pickCurrent(model, now)
    if (cur !== undefined && cur.id !== model.currentId) {
      const from = stationOf(model, model.currentId)
      const { hop: _, ...rest } = model
      return { ...rest, currentId: cur.id, rev: model.rev + 1, ...(from !== cur.station ? { hop: { from, to: cur.station, until: now + HOP_MS } } : {}) }
    }
    if (model.hop !== undefined && now > model.hop.until) {
      const { hop: _, ...rest } = model
      return { ...rest, rev: model.rev + 1 }
    }
    return model
  } catch {
    return model
  }
}

/** The stage's timeline strip: the last 38 steps as {station, status}, oldest first. */
export function trail(model: SessionModel): { station: Station; status: StepStatus }[] {
  if (!Array.isArray(model?.steps)) return []
  const cur = currentActivity(model)
  const onStage = new Set(cur?.stepIds ?? [])
  const out: { station: Station; status: StepStatus }[] = []
  for (const s of model.steps) {
    if (s.tool === '#think' && s.status === 'running' && !onStage.has(s.id)) continue // a gap that may vanish
    out.push({ station: s.station, status: s.status })
  }
  return out.slice(-TRAIL_LEN)
}

/**
 * The scene for an activity as a whole: the files of all its reads, the lanes of a delegation,
 * otherwise its newest step's scene.
 */
export function activityScene(model: SessionModel, activity: Activity): SceneData {
  const steps = stepsOf(model, activity)
  const last = steps[steps.length - 1]
  if (last === undefined) return { kind: 'idle' }
  if (activity.station === 'read' && steps.length > 1) {
    const seen = new Map<string, { path: string; detail?: string }>()
    for (const s of steps) {
      if (s.scene.kind !== 'read') continue
      for (const f of s.scene.files) {
        if (typeof f?.path !== 'string') continue
        seen.delete(f.path)
        seen.set(f.path, f.detail === undefined ? { path: f.path } : { path: f.path, detail: f.detail })
      }
    }
    if (seen.size > 0) return { kind: 'read', files: [...seen.values()].slice(-6) }
  }
  if (activity.station === 'delegate' && activity.agentId === undefined && Array.isArray(model.agents) && model.agents.length > 0) return sceneOfLanes(model.agents)
  return last.scene
}
