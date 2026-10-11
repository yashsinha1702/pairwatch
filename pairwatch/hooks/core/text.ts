// The pane's words: Markdown for remote surfaces, plain lines for the terminal and the status line. Pure, no `$`.
// Contract: the exported names and types below.
//
// Text the person or Claude wrote (the goal, the narration, the "Why?" answer, a step's target) has its
// secrets masked by redact.ts before it is cut or shown: 'HF_TOKEN=••••'.
import type { AskState, Concept, LessonState, Narration, Prefs, SessionModel, Step } from '../../types'
import { CONCEPTS } from './concepts.ts'
import { displayPath } from './explain.ts'
import { lessonMarkdown } from './lessons.ts'
import { basename, codeSpan, cut, fmtDuration, isPathLike, mdEscape, mdText, oneLine } from './md.ts'
import { rulesNarration } from './narrate.ts'
import { redactSecrets } from './redact.ts'
import { GLYPH } from './stations.ts'
import { currentActivity, stepsOf } from './timeline.ts'

export type PaneText = {
  /** '▶️ **Running the test suite** · `pytest -q`' */
  nowLine: string
  /** the narration paragraph (model or rules) */
  narration: string
  /** '🎯 *Goal:* …' or '' */
  goalLine: string
  /** the concept card as Markdown, or '' */
  lesson: string
  /** the "Why?" answer block, or '' */
  askBlock: string
  /** a compact list of the last few steps, or '' */
  recent: string
}

export type PaneTextInput = {
  model: SessionModel
  narration: Narration | null
  lesson: LessonState | null
  prefs: Prefs
  ask: AskState
  now: number
  /** the knowledge base for the card (default: concepts.ts) */
  concepts?: Readonly<Record<string, Concept>>
  /** the session's working directory: a path beside the headline reads relative to it */
  cwd?: string
}

export const WAITING_LINE = '⏸️ **Waiting for Claude to start…**'
const GOAL_MAX = 120
const STATUS_MAX = 160

const isSynthetic = (s: Step): boolean => s.tool.startsWith('#')

/** One line of text with its secrets masked (redact.ts), ready to cut. Non-strings give ''. */
const shown = (s: unknown): string => redactSecrets(oneLine(s))

/** A target worth showing beside the headline: short, one line, not already said. */
function shortTarget(step: Step | undefined, headline: string, cwd?: string): string {
  if (step === undefined || (isSynthetic(step) && step.tool !== '#permission')) return ''
  // a target this long is a command or a text, never shown beside the headline: no need to mask it
  if (oneLine(step.target).length > 2000) return ''
  let t = shown(step.target)
  if (t === '') return ''
  if (cwd !== undefined && /^[~/]\S*$/.test(t)) t = displayPath(t, cwd, 80) || t
  if (t.length > 40 && isPathLike(t)) t = `…/${t.split('/').filter(p => p !== '').slice(-3).join('/')}`
  const head = headline.toLowerCase()
  if (t.length > 48 || head.includes(t.toLowerCase()) || head.includes(t.replace(/^…\//, '').toLowerCase())) return ''
  return t
}

function nowLineOf(input: PaneTextInput): string {
  const { model, now, prefs } = input
  const act = currentActivity(model)
  const paused = prefs?.isPaused === true ? ' · *paused*' : ''
  if (act === undefined) return WAITING_LINE + paused
  const steps = stepsOf(model, act)
  const glyph = GLYPH[act.station] ?? '•'
  let line = `${glyph} **${mdEscape(act.headline) || 'Working'}**`
  const t = shortTarget(steps[steps.length - 1], act.headline, typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : undefined)
  if (t !== '') line += ` · ${codeSpan(t)}`
  const ms = now - act.startedAt
  if (act.status === 'running' && ms > 5_000) line += ` (running ${fmtDuration(ms)})`
  return line + paused
}

/** 'Now part.' + ' ' + 'Why part.' as one paragraph. */
function sentence(now: string, why: string): string {
  const a = shown(now)
  const b = shown(why)
  if (a === '') return b
  if (b === '') return a
  return `${a}${/[.!?…:]$/.test(a) ? '' : '.'} ${b}`
}

function narrationOf(input: PaneTextInput): string {
  const act = currentActivity(input.model)
  if (act === undefined) return ''
  const n = input.narration
  const use = n !== null && n !== undefined && n.activityId === act.id && oneLine(n.now) !== '' ? n : rulesNarration(input.model, act, input.now)
  return mdText(sentence(use.now, use.why))
}

/** '🎯 *Goal:* …' within 120 characters, the goal's text escaped. */
function goalLineOf(model: SessionModel): string {
  const goal = shown(model.goal?.text)
  if (goal === '') return ''
  const head = '🎯 *Goal:* '
  let room = GOAL_MAX - head.length
  for (let i = 0; i < 6; i++) {
    const line = head + mdEscape(cut(goal, room))
    if (line.length <= GOAL_MAX) return line
    room -= line.length - GOAL_MAX
  }
  return head + mdEscape(cut(goal.replace(/[\\`*_[\]<>~]/g, ''), GOAL_MAX - head.length))
}

function lessonOf(input: PaneTextInput): string {
  const l = input.lesson
  if (l === null || l === undefined || typeof l.conceptId !== 'string') return ''
  const kb = input.concepts ?? CONCEPTS
  const c = kb[l.conceptId]
  if (c === undefined) return ''
  const depth = l.depth === 1 || l.depth === 2 ? l.depth : 0
  const level = input.prefs?.level === 2 || input.prefs?.level === 3 ? input.prefs.level : 1
  return lessonMarkdown(c, depth, level, id => kb[id])
}

const FAILED: { [reason: string]: string } = {
  'nothing-to-fork': 'Claude has not started yet, so there is nothing to ask about.',
  aborted: 'The question was cancelled.',
  'api-error': 'Claude could not be reached just now.',
  'empty-reply': 'Claude gave no answer this time.',
  timeout: 'Claude took too long to answer.',
}

/** The "Why?" answer: a quote block, its 'Lesson:' line in bold, its secrets masked. */
function answerBlock(text: string): string {
  const out: string[] = []
  for (const raw of redactSecrets(text.replace(/\r\n?/g, '\n')).split('\n')) {
    if (/^\s*(?:```|~~~)/.test(raw)) continue
    const line = raw.trim().replace(/^#{1,6}\s+/, '').replace(/[<>]/g, '\\$&')
    const lesson = /^(?:[*_]{1,2})?lesson(?:[*_]{1,2})?\s*[:：]\s*(?:[*_]{1,2})?\s*(.*?)\s*(?:[*_]{1,2})?$/i.exec(line)
    if (lesson !== null) out.push(`> **Lesson:** ${lesson[1] ?? ''}`.trimEnd())
    else if (line === '') {
      if (out.length > 0 && out[out.length - 1] !== '>') out.push('>')
    } else out.push(`> ${line}`)
  }
  while (out[out.length - 1] === '>') out.pop()
  return out.join('\n')
}

function askBlockOf(ask: AskState): string {
  if (ask === null || typeof ask !== 'object') return ''
  switch (ask.status) {
    case 'asking':
      return '_Asking Claude why…_'
    case 'answered':
      return typeof ask.text === 'string' && ask.text.trim() !== '' ? answerBlock(ask.text) : ''
    case 'failed':
      return `_${mdEscape(FAILED[ask.reason] ?? `No answer this time (${cut(ask.reason, 60) || 'unknown reason'}).`)}_`
    default:
      return ''
  }
}

const SEARCH_PROGRAMS: { [concept: string]: string } = { grep: 'grep', ripgrep: 'rg', find: 'find', ls: 'ls' }
const READ_PROGRAMS: { [concept: string]: string } = { cat: 'cat', 'head-tail': 'head', 'sed-print': 'sed', wc: 'wc', jq: 'jq' }
const SETUP = new Set(['cd', 'export', 'set', 'source', '.', 'env', 'sudo', 'nohup', 'time', 'timeout', 'echo', 'true'])

/** The program a shell command really runs: 'cd x && pytest -q' -> 'pytest'. */
function programOf(command: string): string {
  for (const part of command.split(/&&|\|\||[;|\n]/)) {
    const words = part.trim().split(/\s+/).filter(w => w !== '' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
    const head = words[0]
    if (head === undefined || SETUP.has(head) || /^\d+$/.test(head)) continue
    const name = basename(head)
    if (/^(?:python[\d.]*|node|bash|sh|ruby|perl|deno|bun)$/.test(name) && words[1] !== undefined && !words[1].startsWith('-')) return `${name} ${basename(words[1])}`
    return name
  }
  return ''
}

const pick = (concepts: readonly string[], table: { [c: string]: string }): string | undefined => {
  for (const c of concepts) if (table[c] !== undefined) return table[c]
  return undefined
}

/** A step in a few words: 'Read login.py', 'grep “redirect”', 'pytest'. Markdown-escaped. */
export function compactLabel(s: Step): string {
  try {
    return labelOf(s)
  } catch {
    return mdEscape(cut(s?.headline, 28)) || 'step'
  }
}

function labelOf(s: Step): string {
  const sc = s.scene
  const file = (p: unknown): string => mdEscape(cut(basename(p), 28))
  const q = (t: unknown): string => `“${mdEscape(cut(t, 24))}”`
  switch (s.tool) {
    case 'Read':
    case 'NotebookRead':
      return `Read ${file(sc.kind === 'read' ? sc.files[0]?.path : s.target)}`.trim()
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Edit ${file(sc.kind === 'edit' ? sc.path : s.target)}`.trim()
    case 'Write':
      return `Write ${file(sc.kind === 'edit' ? sc.path : s.target)}`.trim()
    case 'Grep':
      return `grep ${sc.kind === 'search' ? q(sc.query) : ''}`.trim()
    case 'Glob':
      return `glob ${sc.kind === 'search' ? q(sc.query) : ''}`.trim()
    case 'WebSearch':
      return `web search ${sc.kind === 'web' && sc.query ? q(sc.query) : ''}`.trim()
    case 'WebFetch':
      return `fetch ${sc.kind === 'web' ? mdEscape(cut(sc.domain ?? sc.url ?? '', 28)) : ''}`.trim()
    case 'Agent':
    case 'Task':
      return `agent ${q(s.target ?? s.headline)}`
  }
  switch (sc.kind) {
    case 'run':
      return mdEscape(cut(sc.program ?? programOf(sc.command) ?? 'command', 28)) || 'command'
    case 'search':
      return `${pick(s.concepts, SEARCH_PROGRAMS) ?? 'search'} ${q(sc.query)}`
    case 'read':
      return `${pick(s.concepts, READ_PROGRAMS) ?? 'read'} ${file(sc.files[0]?.path)}`.trim()
    case 'edit':
      return `edit ${file(sc.path)}`
    case 'web':
      return `${s.tool === 'Bash' ? 'curl' : 'web'} ${mdEscape(cut(sc.domain ?? sc.url ?? sc.query ?? '', 28))}`.trim()
    case 'plan':
      return 'plan'
    case 'tools': {
      const name = sc.name.startsWith('mcp__') ? sc.name.split('__').slice(2).join('__') || sc.name : sc.name
      return mdEscape(cut(name, 28)) || 'tool'
    }
    case 'ask':
      return 'question'
    case 'delegate':
      return 'agents'
    default:
      return mdEscape(cut(s.headline, 28))
  }
}

function recentOf(model: SessionModel): string {
  const since = model.turn?.startedAt ?? Number.NEGATIVE_INFINITY
  const done = model.steps.filter(s => !isSynthetic(s) && s.agentId === undefined && s.status !== 'running' && s.startedAt >= since).slice(-4)
  return done.map(s => `${s.status === 'ok' ? '✓' : '✗'} ${compactLabel(s)}`).join(' · ')
}

export function paneText(input: PaneTextInput): PaneText {
  const out: PaneText = { nowLine: WAITING_LINE, narration: '', goalLine: '', lesson: '', askBlock: '', recent: '' }
  if (input === null || typeof input !== 'object' || input.model === null || typeof input.model !== 'object') return out
  const safe = <T>(f: () => T, fallback: T): T => {
    try {
      return f()
    } catch {
      return fallback
    }
  }
  out.nowLine = safe(() => nowLineOf(input), WAITING_LINE)
  out.narration = safe(() => narrationOf(input), '')
  out.goalLine = safe(() => goalLineOf(input.model), '')
  out.lesson = safe(() => lessonOf(input), '')
  out.askBlock = safe(() => askBlockOf(input.ask), '')
  out.recent = safe(() => recentOf(input.model), '')
  return out
}

/** One line for $.ui.status / terminal: '📖 Reading login.py — to see how redirects work'. <= 160 chars. */
export function statusLine(model: SessionModel, narration: Narration | null): string {
  try {
    const act = currentActivity(model)
    if (act === undefined) return 'pairwatch: idle'
    const glyph = GLYPH[act.station] ?? '•'
    const steps = stepsOf(model, act)
    const last = steps[steps.length - 1]
    const n = narration !== null && narration !== undefined && narration.activityId === act.id ? narration : undefined
    const isOver = act.status !== 'running'
    const tail = shown(isOver && last?.resultNote ? last.resultNote : n?.why || n?.now || last?.why || '')
    return cut(`${glyph} ${shown(act.headline)}${tail === '' ? '' : ` — ${tail}`}`, STATUS_MAX)
  } catch {
    return 'pairwatch: idle'
  }
}
