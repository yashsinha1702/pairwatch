// Pairwatch: the type contract. Self-contained (no import / export-from / require / reference):
// the engine reads it as the mod's $.state contract, and every core module imports its
// types from here (`import type { Step } from '../../types'`), so this file is the single
// source of truth for the data the mod passes around.

// ---------------------------------------------------------------- activity classes

/** Where on the stage Claude is. Each has a rail stop (talk/done/idle share "You"). */
export type Station =
  | 'think' // model is reasoning / writing before acting
  | 'plan' // todo lists, plan mode
  | 'search' // finding things: grep, find, ls -R, Glob, Grep
  | 'read' // reading files: Read, cat, head, sed -n
  | 'edit' // changing files: Edit, Write, heredoc > file, sed -i
  | 'run' // running commands: tests, scripts, builds, installs, git, processes
  | 'web' // WebSearch, WebFetch, curl to the internet
  | 'delegate' // sub-agents, workflows
  | 'tools' // skills, MCP connectors, other tools
  | 'ask' // waiting on the person: a question or a permission prompt
  | 'talk' // writing the answer to the person
  | 'done' // turn finished
  | 'idle' // nothing happening

export type StepStatus = 'running' | 'ok' | 'error' | 'denied'

/** 1 = beginner, 2 = intermediate, 3 = expert. */
export type Level = 1 | 2 | 3

/** What kind of shell work a Bash command is (drives scene decoration and wording). */
export type BashCategory =
  | 'test' // pytest, npm test, go test, jest
  | 'build' // make, tsc, npm run build, docker build, cargo build
  | 'install' // pip/npm/uv/conda/dnf install, venv creation
  | 'git' // any git / gh command
  | 'run-script' // python3 x.py, node x.js, bash x.sh, ./run.sh, inline python -c / heredoc python
  | 'read-file' // cat, head, tail, sed -n, less, wc on files
  | 'list-files' // ls, tree, du on dirs, find without -exec
  | 'search' // grep, rg, find -name, ag
  | 'write-file' // cat > f <<EOF, tee, echo > f, sed -i, cp/mv into place
  | 'file-ops' // mkdir, cp, mv, rm, chmod, ln, tar, unzip
  | 'process' // ps, pgrep, kill, pkill, nohup, tmux, systemctl, background jobs
  | 'network' // ssh, scp, rsync, ping, lsof -i, ss
  | 'http' // curl, wget, http
  | 'gpu' // nvidia-smi and friends
  | 'media' // ffmpeg, ffprobe, sox
  | 'docker' // docker, docker compose
  | 'database' // sqlite3, psql, mysql
  | 'env' // which, env, export, printenv, echo $VAR, uname, nproc, free, df, date
  | 'wait' // sleep, until/while polling loops, timeout wrappers around waits
  | 'claude' // the claude CLI itself
  | 'other'

// ---------------------------------------------------------------- raw observations

/** A tool call as the tool.call hook saw it, made plain JSON. */
export type ToolObs = {
  /** tool_use_id */
  id: string
  /** 'Bash', 'Read', 'Edit', 'mcp__server__tool', ... */
  tool: string
  /** the tool's own arguments (reserved keys stripped), each long string cut to 4000 chars */
  args: { [k: string]: unknown }
  /** present inside a sub-agent's loop */
  agentId?: string
  /** ms since epoch when the call was asked for */
  at: number
}

/** How a tool call ended. */
export type ToolEnd = {
  id: string
  status: 'ok' | 'error' | 'denied'
  /** the result as the model reads it, first 1500 chars ('' if none) */
  preview: string
  /** ms since epoch */
  at: number
}

/** Everything the hooks push into the pump's queue. Plain JSON. */
export type RawEvent =
  | { kind: 'prompt'; text: string; origin: string; at: number }
  | { kind: 'turn-start'; turnId: string; at: number }
  | { kind: 'turn-end'; turnId: string; agentId?: string; durationMs: number; answer: string; reason: string; at: number }
  | { kind: 'stream'; agentId?: string; mode: 'thinking' | 'text'; at: number } // a block began streaming
  | { kind: 'say'; agentId?: string; text: string; at: number } // a finished visible text block
  | { kind: 'think'; agentId?: string; text: string; at: number } // a finished thinking block
  | { kind: 'tool-start'; obs: ToolObs }
  | { kind: 'tool-end'; end: ToolEnd }
  | { kind: 'permission'; id: string; tool: string; at: number } // tool.check answered 'ask'
  | { kind: 'agent-start'; agentId: string; type: string; description: string; toolUseId: string; background: boolean; at: number }
  | { kind: 'agent-stop'; agentId: string; at: number }

// ---------------------------------------------------------------- explained steps

/** Data for the station's mini-scene on the stage. Every string is plain text (the renderer escapes). */
export type SceneData =
  | { kind: 'run'; command: string; category: BashCategory; program?: string; output?: string; isBackground?: boolean }
  | { kind: 'read'; files: { path: string; detail?: string }[] }
  | { kind: 'search'; query: string; where?: string; matches?: string }
  | { kind: 'edit'; path: string; removed: number; added: number; minus: string[]; plus: string[]; isNew: boolean }
  | { kind: 'web'; query?: string; url?: string; domain?: string }
  | { kind: 'delegate'; agents: { label: string; type?: string; status: StepStatus; doing?: string }[] }
  | { kind: 'plan'; items: { text: string; state: 'done' | 'doing' | 'todo' }[] }
  | { kind: 'ask'; question: string; isPermission: boolean }
  | { kind: 'tools'; name: string; server?: string; detail?: string }
  | { kind: 'think'; text?: string }
  | { kind: 'talk'; text?: string }
  | { kind: 'done'; steps: number; files: number; seconds: number; errors: number }
  | { kind: 'idle' }

/** One explained tool call (or a synthetic step: prompt, thinking, answer). */
export type Step = {
  id: string
  /** raw tool name, or '#prompt' / '#think' / '#talk' / '#done' / '#permission' for synthetic steps */
  tool: string
  agentId?: string
  station: Station
  /** plain text, <= 90 chars, e.g. 'Searching for “handleLogin” in src/' */
  headline: string
  /** plain text, one sentence <= 170 chars: why an engineer/agent does this */
  why: string
  /** the main object: path, command, url, query, agent description (plain text, may be long; renderers cut) */
  target?: string
  /** short qualifier <= 40 chars: 'lines 1–200', '+3 −1', '12 matches' */
  detail?: string
  /** concept ids from CONCEPT_IDS, most specific first */
  concepts: string[]
  scene: SceneData
  status: StepStatus
  startedAt: number
  endedAt?: number
  /** <= 120 chars from the result: 'exit 0', '3 matches', 'FAILED tests/test_x.py::test_y' */
  resultNote?: string
}

/** Consecutive steps of one station (and one agent lane) shown as one thing on the stage. */
export type Activity = {
  /** id of its first step */
  id: string
  station: Station
  agentId?: string
  stepIds: string[]
  /** aggregated headline: 'Reading 4 files', or the single step's headline */
  headline: string
  status: StepStatus
  startedAt: number
  endedAt?: number
}

export type AgentLane = {
  id: string
  label: string
  type?: string
  status: 'running' | 'done'
  /** headline of its latest step */
  doing?: string
  startedAt: number
}

export type FileTouch = { path: string; reads: number; edits: number; last: number }

export type Stats = {
  steps: number
  edits: number
  commands: number
  errors: number
  turns: number
  startedAt: number
}

/** The session model the pane draws from. Built by timeline.reduce from RawEvents. */
export type SessionModel = {
  /** the person's latest prompt (cut to 600 chars) */
  goal?: { text: string; at: number }
  /** Claude's latest visible text (its stated intent), cut to 600 chars */
  said?: { text: string; at: number }
  /** a snippet of Claude's latest thinking, cut to 400 chars */
  thought?: { text: string; at: number }
  turn?: { id: string; startedAt: number; isRunning: boolean; endedAt?: number }
  /** newest last, at most 80 */
  steps: Step[]
  /** newest last, at most 30 */
  activities: Activity[]
  /** id of the activity on stage (normally the newest) */
  currentId?: string
  /** the avatar hops from this station when an activity starts; cleared after ~1.5 s */
  hop?: { from: Station; to: Station; until: number }
  /** most recently touched first, at most 40 */
  files: FileTouch[]
  /** sub-agents seen this turn, at most 12 */
  agents: AgentLane[]
  stats: Stats
  /** bumps on every change, so drawings can key on it */
  rev: number
}

// ---------------------------------------------------------------- narration and learning

export type Narration = {
  /** which activity it explains */
  activityId: string
  /** one or two sentences: what Claude is doing right now, specifically */
  now: string
  /** one sentence: why it helps toward the goal ('' if none) */
  why: string
  source: 'model' | 'rules'
  at: number
}

/** The concept card on show. depth 0 = short + why, 1 = + deeper, 2 = + try-it / related. */
export type LessonState = { conceptId: string; depth: 0 | 1 | 2; shownAt: number; activityId?: string }

export type Prefs = {
  level: Level
  isPaused: boolean
  /** use the model (Haiku) for contextual narration */
  useModel: boolean
  /** open the pane by itself on the first prompt of a session */
  autoOpen: boolean
}

/** The on-demand "Why?" question answered by forking the session's own model. */
export type AskState =
  | { status: 'idle' }
  | { status: 'asking'; activityId?: string; at: number }
  | { status: 'answered'; activityId?: string; text: string; at: number }
  | { status: 'failed'; reason: string; at: number }

/** A concept in the knowledge base. All strings plain text except `tryIt` (a command / snippet). */
export type Concept = {
  id: string
  title: string
  category: 'agent' | 'practice' | 'shell' | 'system' | 'ml' | 'git' | 'python' | 'node' | 'docker' | 'data' | 'web'
  /** audience: 1 basics, 2 intermediate, 3 expert nuance */
  level: Level
  /** <= 140 chars: what it is */
  short: string
  /** <= 170 chars: why engineers / agents do it */
  why: string
  /** <= 420 chars: two or three sentences for the curious */
  deeper: string
  /** a runnable example or snippet, <= 80 chars */
  tryIt?: string
  related?: string[]
}

declare module 'claude-code' {
  interface PluginState {
    pairwatch: {
      model: SessionModel
      narration: Narration | null
      lesson: LessonState | null
      prefs: Prefs
      ask: AskState
    }
  }
}
