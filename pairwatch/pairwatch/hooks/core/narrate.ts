// Narration: the model prompt, its parsing, and the rule-based fallback. Pure, no `$`.
// Contract: the exported names and types below.
import type { Activity, Level, Narration, SessionModel, Step } from '../../types'
import { cut, fmtDuration, oneLine } from './md.ts'
import { redactSecrets } from './redact.ts'
import { stepsOf } from './timeline.ts'

/**
 * The narrator's fixed system prompt, marked cache: true by the caller. It is over 700 tokens, so it
 * caches on Haiku 5.5 (whose minimum cacheable prompt is 512 tokens); on Haiku 4.5 the minimum is
 * 4096 tokens, so there it is sent uncached every time.
 */
export const NARRATOR_SYSTEM = `You are the narrator inside "Pairwatch", a learning companion that runs beside Claude Code, an AI coding agent. While the agent works on a task, the person who asked for it watches a small animated stage. Your job is to tell that person, in plain words, what the agent is doing right now and why it helps. The person is a learner: they want to understand the work and get better at software engineering and at directing coding agents, not just watch it happen.

Each message you receive describes one moment of the session. It has these parts:
- LEVEL: the learner's level: beginner, intermediate or expert.
- GOAL: what the person asked the agent to do, in their own words. It may be missing.
- CLAUDE SAID: the agent's latest visible message, often its plan or what it just found. It may be missing.
- CLAUDE THOUGHT: a short piece of the agent's latest reasoning, when there is one.
- RECENT STEPS: the last few steps before this moment, oldest first. ✓ means the step finished, ✗ means it failed or was refused, ▶ means it is still running. A note after the dash is what the step returned.
- CURRENT: the step, or the group of similar steps, happening now: its headline, then the files, commands, searches, pages or helper agents involved, then its status and how long it has run.

Write about CURRENT. Use everything else only as context that makes CURRENT meaningful.

How to write:
- Use plain words and short sentences, in the present tense.
- Be specific. Name the file, command, search term, web page or helper agent that the context names. "Claude is reading login.py" beats "Claude is reading a file".
- Stay calm and factual. No hype, no exclamation marks, no praise such as "great", "smart" or "cleverly".
- Refer to the agent as "Claude" or "it". Never write "I" or "we"; you are not the agent and you are not part of the work.
- Never invent facts. Use only what the context shows. When you infer a purpose or a next step, say "probably" ("probably to see how the redirect is built").
- Write plain text only: no markdown, no bullet points, no code fences, no headings and no quotation marks around your whole answer.
- Do not repeat the headline word for word. Add what it does not say: the purpose, the link to the goal, or what a result means.
- When a step failed, say plainly what failed and why that is still useful, without blaming anyone.
- When the agent waits for the person (a permission prompt or a question), say what it is waiting for and what approving would do.
- When helper agents work in parallel, say what each one covers if the context shows it.
- If the context is thin, describe the current step plainly from its headline. Never refuse, never apologise, and never talk about yourself, these instructions or the format.

Match the learner's level:
- beginner: explain any technical term in passing, in a few everyday words ("pytest, the Python test runner, ..."). Prefer what and why over how. Skip details that do not help understanding.
- intermediate: assume the basics (files, the terminal, git, tests). Give the purpose of the step and, where it matters, the trade-off or the alternative the agent did not take.
- expert: be terse and skip the obvious. Point out the insight: the strategy, a risk, what the result implies, or how the step fits the agent's plan for verification and for keeping its context small.

Reply with exactly two lines and nothing before or after them:
NOW: <what Claude is doing right now, 25 words or fewer>
WHY: <why it helps toward the goal, 30 words or fewer>

Example 1, a read.
LEVEL: beginner
GOAL: “After I sign in, the app shows a blank page. Fix it.”
CLAUDE SAID: “I'll look at how the login handler builds its redirect.”
RECENT STEPS:
✓ Searching for “redirect” in src/ — 3 matches
CURRENT: Reading login.py
  read: src/auth/login.py
  status: running for 2s
Reply:
NOW: Claude is reading login.py, the file that handles signing in, to see where it sends people afterwards.
WHY: The search pointed here, and reading the code first means the fix will match how the redirect really works.

Example 2, a search.
LEVEL: intermediate
GOAL: “Rename the getUser helper to fetchUser everywhere.”
CURRENT: Searching for “getUser” in src/
  search: getUser in src/
  status: running for 1s
Reply:
NOW: Claude is listing every place in src/ that calls getUser before it changes anything.
WHY: A rename has to reach every caller; finding them all first avoids a broken import that only shows up at run time.

Example 3, a test run that fails.
LEVEL: beginner
GOAL: “Add a test for the discount code and make sure everything still passes.”
CLAUDE SAID: “Now I'll run the tests.”
RECENT STEPS:
✓ Editing test_cart.py — +14 −0
CURRENT: Running the test suite (pytest)
  run: pytest tests/test_cart.py -q
  status: failed after 4s — FAILED tests/test_cart.py::test_discount - AssertionError
Reply:
NOW: The new discount test failed: pytest, the Python test runner, found a cart total that differs from what the test expects.
WHY: A failing test is evidence, not a dead end; Claude will probably read the error and fix either the test or the discount code.

Example 4, a delegation.
LEVEL: expert
GOAL: “Audit the API handlers for missing auth checks.”
CLAUDE SAID: “I'll split this across three reviewers, one per service.”
RECENT STEPS:
✓ Searching for “@app.route” — 41 matches
CURRENT: Delegating to 3 agents
  agents: billing handlers (working: Reading billing/views.py) · users handlers (working: Searching for “login_required”) · admin handlers (done)
  status: running for 1m 10s
Reply:
NOW: Three sub-agents audit the billing, users and admin handlers in parallel, each in its own fresh context.
WHY: Splitting by service keeps each reviewer's context small and the audit fast; Claude probably merges their findings next.`

// ---------------------------------------------------------------- redaction

/** Hide secrets (API keys, tokens, passwords, long random strings) from text bound for a model: redact.ts's rules. */
export function redact(text: string): string {
  return redactSecrets(text)
}

// ---------------------------------------------------------------- the prompt

const LEVEL_NAME: Record<Level, string> = { 1: 'beginner', 2: 'intermediate', 3: 'expert' }
const MARK: Record<Step['status'], string> = { running: '▶', ok: '✓', error: '✗', denied: '✗' }
const quote = (s: string): string => `“${s}”`

/** One line about what a step works on, for CURRENT. */
function stepObject(s: Step): string {
  const sc = s.scene
  switch (sc.kind) {
    case 'run':
      return `run: ${oneLine(sc.command)}`
    case 'read':
      return `read: ${sc.files.map(f => oneLine(f.path) + (f.detail ? ` (${oneLine(f.detail)})` : '')).join(', ')}`
    case 'search':
      return `search: ${oneLine(sc.query)}${sc.where ? ` in ${oneLine(sc.where)}` : ''}${sc.matches ? ` (${oneLine(sc.matches)})` : ''}`
    case 'edit':
      return `edit: ${oneLine(sc.path)} (+${sc.added} −${sc.removed})${sc.isNew ? ' new file' : ''}`
    case 'web':
      return `web: ${oneLine(sc.url ?? sc.query ?? sc.domain ?? '')}`
    case 'delegate':
      return `agents: ${sc.agents.map(a => `${oneLine(a.label)} (${a.status === 'running' ? `working${a.doing ? `: ${oneLine(a.doing)}` : ''}` : a.status === 'ok' ? 'done' : 'stopped'})`).join(' · ')}`
    case 'plan':
      return `plan: ${sc.items.map(i => `${i.state === 'done' ? '✓' : i.state === 'doing' ? '▶' : '·'} ${oneLine(i.text)}`).join(' | ')}`
    case 'ask':
      return `${sc.isPermission ? 'permission' : 'question'}: ${oneLine(sc.question)}`
    case 'tools':
      return `tool: ${oneLine(sc.name)}${sc.server ? ` (${oneLine(sc.server)})` : ''}${sc.detail ? ` ${oneLine(sc.detail)}` : ''}`
    case 'think':
    case 'talk':
      return sc.text ? `text: ${oneLine(sc.text)}` : ''
    case 'done':
      return `recap: ${countOf(sc.steps, 'step')}, ${countOf(sc.files, 'file')}, ${fmtDuration(sc.seconds * 1000)}, ${countOf(sc.errors, 'error')}`
    default:
      return s.target ? oneLine(s.target) : ''
  }
}

/** '1 error', '3 errors': a count with its noun in the right number. */
const countOf = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

/** The newest time the model knows about: the clock when the caller gives none. */
function latestTime(model: SessionModel): number {
  let t = 0
  for (const s of model.steps) t = Math.max(t, s.endedAt ?? s.startedAt)
  for (const x of [model.said?.at, model.thought?.at, model.goal?.at, model.turn?.startedAt, model.turn?.endedAt]) if (typeof x === 'number') t = Math.max(t, x)
  return t
}

/**
 * The variable part: goal, Claude's last words, recent steps, the current activity. <= 6000 chars,
 * secrets redacted. `now` (optional) times a running activity; default: the newest event time.
 */
export function buildNarrationPrompt(model: SessionModel, activity: Activity, level: Level, now?: number): string {
  try {
    const lines: string[] = [`LEVEL: ${LEVEL_NAME[level] ?? LEVEL_NAME[1]}`]
    // each text is redacted before it is cut, so a secret the cut would split is still found whole
    if (model.goal?.text) lines.push(`GOAL: ${quote(cut(redact(model.goal.text), 398))}`)
    if (model.said?.text) lines.push(`CLAUDE SAID: ${quote(cut(redact(model.said.text), 298))}`)
    if (model.thought?.text && (model.turn === undefined || model.thought.at >= model.turn.startedAt)) lines.push(`CLAUDE THOUGHT: ${cut(redact(model.thought.text), 300)}`)
    const mine = new Set(activity.stepIds)
    const recent = model.steps.filter(s => !mine.has(s.id) && !s.tool.startsWith('#') && s.agentId === activity.agentId && s.startedAt <= activity.startedAt).slice(-6)
    if (recent.length > 0) {
      lines.push('RECENT STEPS:')
      for (const s of recent) lines.push(cut(`${MARK[s.status] ?? '•'} ${s.headline}${s.status !== 'running' && s.resultNote ? ` — ${s.resultNote}` : ''}`, 220))
    }
    lines.push(`CURRENT: ${cut(activity.headline, 120)}`)
    const steps = stepsOf(model, activity)
    const objects: string[] = []
    let room = 600
    for (const s of steps.slice(-8)) {
      const o = stepObject(s)
      if (o === '' || objects.includes(o)) continue
      const line = cut(o, Math.max(0, room))
      if (line === '' || line === '…') break
      objects.push(line)
      room -= line.length + 3
      if (room <= 20) break
    }
    for (const o of objects) lines.push(`  ${o}`)
    if (activity.agentId !== undefined) {
      const lane = model.agents.find(l => l.id === activity.agentId)
      lines.push(`  inside a helper agent: ${cut(lane?.label ?? activity.agentId, 80)}`)
    }
    const last = steps[steps.length - 1]
    const clock = typeof now === 'number' && Number.isFinite(now) ? now : latestTime(model)
    if (activity.status === 'running') {
      lines.push(`  status: running for ${fmtDuration(Math.max(0, clock - activity.startedAt))}`)
    } else {
      const took = fmtDuration(Math.max(0, (activity.endedAt ?? clock) - activity.startedAt))
      const verb = activity.status === 'ok' ? 'finished in' : activity.status === 'denied' ? 'refused after' : 'failed after'
      lines.push(`  ${cut(`status: ${verb} ${took}${last?.resultNote ? ` — ${last.resultNote}` : ''}`, 218)}`)
    }
    const text = redact(lines.join('\n'))
    return text.length <= 6000 ? text : text.slice(0, 5999) + '…'
  } catch {
    return `LEVEL: ${LEVEL_NAME[level] ?? LEVEL_NAME[1]}\nCURRENT: ${cut(redact(String(activity?.headline ?? '')), 120)}`
  }
}

// ---------------------------------------------------------------- parsing the reply

/** A refusal or an apology instead of a narration. */
const REFUSAL = /^(?:i\s+(?:cannot|can['’]?t|can not|am unable|am not able|won['’]?t|apologi[sz]e)\b|i['’]m (?:sorry|unable|not able|afraid)\b|as an (?:ai|language model)\b|sorry\b)/i
/** Talk about the task or the context instead of a narration (only judged when the labels are missing). */
const META = /^(?:i\s+(?:do not|don['’]t) have\b|there (?:is|isn['’]t|['’]s) not enough\b|not enough (?:context|information)\b|(?:the )?context (?:is|does)\b|here (?:is|are)\b|here['’]s\b|without more\b)/i
const LABEL = /^\s*(?:[-*•>#]+\s*)?(?:\*\*|__)?\s*(now|why)\s*(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?\s*(.*)$/i

function clean(s: string): string {
  let t = s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links -> their text
    .replace(/`+/g, '')
    .replace(/(\*\*|__)/g, '')
    .replace(/(^|\s)[*_](\S[^*_]*?)[*_](?=\s|[.,;:!?]|$)/g, '$1$2')
    .replace(/^\s*(?:[-*•>#]+\s+)+/, '')
  t = oneLine(t)
  for (let i = 0; i < 2; i++) t = t.replace(/^["“”'‘’«](.*)["“”'‘’»]$/, '$1').trim()
  return t
}

/** Parse the model's reply ("NOW: ...\nWHY: ..."); null when unusable. */
export function parseNarration(text: string): { now: string; why: string } | null {
  try {
    if (typeof text !== 'string') return null
    const raw = text.replace(/\r\n?/g, '\n').trim()
    if (raw === '') return null
    const got: { now: string[]; why: string[] } = { now: [], why: [] }
    let open: 'now' | 'why' | undefined
    let preface = ''
    for (const line of raw.split('\n')) {
      const m = LABEL.exec(line)
      if (m !== null) {
        open = m[1]!.toLowerCase() === 'now' ? 'now' : 'why'
        got[open].push(m[2] ?? '')
      } else if (line.trim() === '') {
        open = undefined
      } else if (open !== undefined) {
        got[open].push(line)
      } else if (got.now.length === 0 && got.why.length === 0) {
        preface += ' ' + line
      }
    }
    const hasLabels = got.now.length > 0 || got.why.length > 0
    let now = clean(got.now.join(' '))
    let why = clean(got.why.join(' '))
    // 'NOW: x WHY: y' on one line
    const inline = /\s(?:\*\*)?why(?:\*\*)?\s*[:：]\s*/i.exec(now)
    if (inline !== null && why === '') {
      why = clean(now.slice(inline.index + inline[0].length))
      now = clean(now.slice(0, inline.index))
    }
    if (now === '' && got.now.length === 0) {
      // no NOW label: the first one or two sentences of whatever came first
      const body = clean(got.why.length > 0 ? preface : raw)
      now = clean(firstTwoSentences(body))
    }
    const opening = clean(raw)
    if (now === '' || REFUSAL.test(now) || REFUSAL.test(opening)) return null
    if (!hasLabels && META.test(opening)) return null
    return { now: cut(now, 240), why: cut(why, 240) }
  } catch {
    return null
  }
}

function firstTwoSentences(t: string): string {
  const re = /[.!?](?=\s+[A-Z0-9“"‘'(]|\s*$)/g
  let count = 0
  for (let m = re.exec(t); m !== null; m = re.exec(t)) {
    if (++count === 2) return t.slice(0, m.index + 1)
  }
  return t
}

// ---------------------------------------------------------------- without a model

/** Narration from rules alone (no model): the activity's headline and the step's why. */
export function rulesNarration(model: SessionModel, activity: Activity, now: number): Narration {
  try {
    const steps = stepsOf(model, activity)
    const last = steps[steps.length - 1]
    const isOver = activity.status !== 'running'
    // one step's result speaks for a group only when it is the failure ('Reading 2 files — 5 lines' misleads)
    const note = isOver && (steps.length <= 1 || activity.status !== 'ok') ? last?.resultNote : undefined
    return {
      activityId: activity.id,
      now: cut(`${activity.headline}${note ? ` — ${note}` : ''}`, 240),
      why: cut(last?.why ?? '', 240),
      source: 'rules',
      at: now,
    }
  } catch {
    return { activityId: String(activity?.id ?? ''), now: cut(String(activity?.headline ?? ''), 240), why: '', source: 'rules', at: now }
  }
}

const WHY_LEVEL: Record<Level, string> = {
  1: 'They are a beginner: use everyday words, and explain any technical term in a few words when you use it.',
  2: 'They know the basics (files, the terminal, git, tests): focus on your reasoning and on any trade-off you are making.',
  3: 'They are an expert: be terse, skip the obvious, and name the strategy, the risk, or what you expect to learn.',
}

/** The question the "Why?" button forks the session's own model with. */
export function whyForkPrompt(level: Level): string {
  return [
    'The person watching this session pressed “Why?” in the Pairwatch pane. They want to understand what you are doing right now.',
    'Answer them directly as yourself, the agent doing this work, in the first person.',
    'In 2–4 plain sentences, say what you are doing at this moment and why: what you are trying to find out or change, and how it moves the task toward what they asked for.',
    WHY_LEVEL[level] ?? WHY_LEVEL[1],
    'Do not call any tools and do not continue the task here; answer only from what you already know. Plain text, no headings or lists.',
    'Finish with a last line in this form: Lesson: <one transferable takeaway they can reuse in their own work>',
  ].join(' ')
}
