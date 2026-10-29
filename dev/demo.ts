// The README's demo: the page (viewer/index.html) following a realistic turn.
//   node dev/demo.ts [--out DIR] [--fps 12] [--width 760] [--no-png]
// Folds dev/spec/scenario.fixtures.ts through the real core every 400 ms, the way register.tsx's pump
// does with the narrator model off (rules narration, cards picked by lessons.ts, the stage by
// stage.ts, the text by text.ts), and writes the snapshots the page's server would push to
// DIR/snapshots.json. Then dev/demo-record.mjs plays them into the real page in Chromium
// (PAIRWATCH_TOOLS, as for dev/filmstrip.mjs) and, with ffmpeg on PATH, joins the frames into
// DIR/pairwatch-demo.gif. --no-png writes the snapshots only and needs no Playwright.
// Default DIR: a new private temp folder.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONCEPTS } from '../pairwatch/hooks/core/concepts.ts'
import { isConceptId } from '../pairwatch/hooks/core/concept-ids.ts'
import { depthFor, pickLesson, RECENT_MS } from '../pairwatch/hooks/core/lessons.ts'
import { rulesNarration } from '../pairwatch/hooks/core/narrate.ts'
import { renderStage } from '../pairwatch/hooks/core/stage.ts'
import { paneText, statusLine } from '../pairwatch/hooks/core/text.ts'
import { currentActivity, emptyModel, reduce, settleHop, stepsOf } from '../pairwatch/hooks/core/timeline.ts'
import { freshKey, stageInput } from '../pairwatch/hooks/core/view.ts'
import type { Activity, LessonState, Narration, RawEvent, SessionModel, Step } from '../pairwatch/types'
import { CWD, SCENARIO, T0 } from './spec/scenario.fixtures.ts'

const argv = process.argv.slice(2)
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = opt('--out') ?? mkdtempSync(join(tmpdir(), 'pairwatch-demo-'))
mkdirSync(OUT, { recursive: true, mode: 0o700 })

const TICK_MS = 400 // register.tsx's pump
const prefs = { level: 1 as const, isPaused: false, useModel: false, autoOpen: true }
const ask = { status: 'idle' as const }
const at = (e: RawEvent): number => (e.kind === 'tool-start' ? e.obs.at : e.kind === 'tool-end' ? e.end.at : e.at)
const queue = [...SCENARIO].sort((a, b) => at(a) - at(b))
const end = at(queue[queue.length - 1]!) + 4_000

// register.tsx's learning state, as far as picking a card needs it
const seen: Record<string, { n: number; last: number }> = {}
const recent: string[] = []
const ctx = (now: number) => ({ level: prefs.level, known: [] as string[], seen, now, recent })
const isStale = (id: string, now: number): boolean => recent.includes(id) || now - (seen[id]?.last ?? Number.NEGATIVE_INFINITY) < RECENT_MS
/** register.tsx's lessonCandidates: the concepts of an activity's steps, newest first */
function candidatesOf(steps: readonly Step[]): string[] {
  const out: string[] = []
  for (let i = steps.length - 1; i >= 0; i--) {
    for (const id of steps[i]?.concepts ?? []) {
      if (!out.includes(id) && isConceptId(id) && CONCEPTS[id] !== undefined) out.push(id)
    }
  }
  return out
}
/** register.tsx's signatureOf: an activity that grew or ended gets its rules narration again */
function signatureOf(m: SessionModel, act: Activity): string {
  const latest = m.steps.find(s => s.id === act.stepIds[act.stepIds.length - 1])
  return `${act.headline}|${act.status}|${act.stepIds.length}|${latest?.status ?? ''}|${latest?.resultNote ?? ''}`
}

let model: SessionModel = emptyModel(T0)
let narration: Narration | null = null
let lesson: LessonState | null = null
let handledId = ''
let handledSig = ''
let drawnFresh = ''
let lastKey = ''
const snapshots: { t: number; snap: Record<string, unknown> }[] = []
for (let now = T0; now <= end; now += TICK_MS) {
  const batch: RawEvent[] = []
  while (queue.length > 0 && at(queue[0]!) <= now) batch.push(queue.shift()!)
  model = settleHop(reduce(model, batch, { level: prefs.level, now, cwd: CWD }), now)
  const act = currentActivity(model)
  if (act !== undefined) {
    const sig = signatureOf(model, act)
    if (act.id !== handledId) {
      // followActivity: a new activity gets rules narration at once, then a card
      handledId = act.id
      handledSig = sig
      narration = rulesNarration(model, act, now)
      const candidates = candidatesOf(stepsOf(model, act))
      const id = candidates.length > 0 ? pickLesson(candidates, ctx(now)) : undefined
      if (id !== undefined && candidates.includes(id) && lesson?.conceptId !== id && !(lesson !== null && isStale(id, now))) {
        lesson = { conceptId: id, depth: 0, shownAt: now, activityId: act.id }
        seen[id] = { n: (seen[id]?.n ?? 0) + 1, last: now }
        recent.push(id)
      }
    } else if (sig !== handledSig) {
      handledSig = sig
      narration = rulesNarration(model, act, now)
    }
    // deepenLesson: the card goes deeper while a step runs long
    if (lesson !== null && lesson.depth < 2) {
      const depth = depthFor(now - Math.max(lesson.shownAt, act.startedAt ?? lesson.shownAt))
      if (depth > lesson.depth) lesson = { ...lesson, depth }
    }
  }
  // writeSnapshot / viewOf: what the page draws
  const text = paneText({ model, narration, lesson, prefs, ask, now, cwd: CWD })
  const input = stageInput(model, prefs, now, CWD)
  const fresh = freshKey(model)
  const stage = input.isFresh && fresh !== '' && fresh === drawnFresh ? { ...input, isFresh: false } : input
  drawnFresh = fresh
  const snap = {
    v: 1,
    sid: 'demo',
    cwd: CWD,
    svg: renderStage(stage),
    alt: statusLine(model, narration).replace(/\s+/g, ' ').trim().slice(0, 300),
    head: [text.nowLine, text.narration].filter(s => s.trim() !== '').join('\n\n'),
    lesson: text.lesson,
    ask: text.askBlock,
    goal: text.goalLine,
    recent: text.recent,
    note: '',
    station: act?.station ?? 'idle',
    status: act?.status ?? 'ok',
    isPaused: false,
    isAsking: false,
    hasLesson: lesson !== null,
    level: prefs.level,
    narrationSource: narration?.source ?? null,
    narrator: 'haiku',
  }
  const key = JSON.stringify({ ...snap, svg: snap.svg.replace(/id="[^"]*"/g, '') })
  if (key === lastKey) continue
  lastKey = key
  snapshots.push({ t: now - T0, snap })
}
const file = join(OUT, 'snapshots.json')
writeFileSync(file, JSON.stringify(snapshots))
console.log(`demo: ${snapshots.length} snapshots over ${((end - T0) / 1000).toFixed(1)} s -> ${file}`)
if (argv.includes('--no-png')) process.exit(0)

const frames = join(OUT, 'frames')
execFileSync(process.execPath, [join(HERE, 'demo-record.mjs'), file, frames, '--fps', opt('--fps') ?? '12', '--width', opt('--width') ?? '760'], { stdio: 'inherit' })
const gif = join(OUT, 'pairwatch-demo.gif')
try {
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', opt('--fps') ?? '12', '-i', join(frames, 'f%04d.png'),
    '-vf', 'split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
    '-loop', '0', gif], { stdio: 'inherit' })
  console.log(`demo: ${gif}`)
} catch {
  console.log(`demo: no ffmpeg on PATH; the frames are in ${frames}`)
}
