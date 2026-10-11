// What the stage draws, from the session model: the StageInput for renderStage. Pure, no `$`.
// register.tsx calls stageInput() on every redraw; specs check it against models built by
// timeline.reduce, so the frame always sees what the timeline really produces.
import type { Activity, Prefs, SceneData, SessionModel, Step } from '../../types'
import { displayPath } from './explain.ts'
import { redactSecrets } from './redact.ts'
import type { StageInput } from './stage.ts'
import { activityScene, currentActivity, stepsOf, trail } from './timeline.ts'

/** A step drawn within this long of its start plays its intro (typing, sliding in); later frames show it settled. */
export const FRESH_MS = 2_500
/** Paths in the header keep at most this many characters (the frame cuts the rest by its own width). */
const TITLE_PATH_MAX = 72
const TRAIL_MAX = 38
/** The most of a header text the frame could ever show (it cuts to its own width, far less). */
const TITLE_SEEN_MAX = 2_000

const attempt = <T>(fn: () => T, fallback: T): T => {
  try {
    return fn()
  } catch {
    return fallback
  }
}

/** '42s', '3m 07s', '1h 05m'. */
export function clockText(ms: number): string {
  const s = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  if (h > 0) return `${h}h ${pad(m)}m`
  if (m > 0) return `${m}m ${pad(s % 60)}s`
  return `${s}s`
}

/** The turn's time as of the model's latest event (not the clock), so redraws that change nothing else keep the same picture. */
export function elapsedText(m: SessionModel): string {
  const t = m.turn
  if (t === undefined) return '0s'
  let end = t.endedAt ?? t.startedAt
  if (t.endedAt === undefined) {
    for (const s of m.steps.slice(-3)) end = Math.max(end, s.startedAt, s.endedAt ?? 0)
    end = Math.max(end, m.said?.at ?? 0, m.thought?.at ?? 0)
  }
  return clockText(end - t.startedAt)
}

/** 'sub-agent: Explore' for an activity inside a helper's loop. */
function laneOf(m: SessionModel, agentId: string): string {
  const lane = Array.isArray(m.agents) ? m.agents.find(a => a.id === agentId) : undefined
  return lane === undefined ? 'sub-agent' : `sub-agent: ${lane.type ?? lane.label}`
}

/** The scene for the activity as a whole (the files of all its reads, the lanes of a delegation), else its newest step's. */
function sceneOf(m: SessionModel, act: Activity, steps: readonly Step[]): SceneData {
  const scene = attempt<SceneData | undefined>(() => activityScene(m, act), undefined)
  return scene ?? steps[steps.length - 1]?.scene ?? { kind: 'idle' }
}

/**
 * The header text after the verb. A path reads as the scene's own file list does (relative to the
 * project); a group of reads names its file count; a synthetic step never repeats the verb
 * ('THINKING Thinking it through'): thinking and answering show their words in the scene, and the
 * recap names the goal it finished.
 */
function titleOf(m: SessionModel, act: Activity, steps: readonly Step[], scene: SceneData, cwd: string | undefined): string {
  const latest = steps[steps.length - 1]
  if (latest === undefined) return act.headline
  switch (latest.tool) {
    case '#think':
    case '#talk':
      return ''
    case '#done':
      return m.goal?.text ?? ''
  }
  if (scene.kind === 'read' && scene.files.length > 1) return `${scene.files.length} files`
  const target = latest.target
  if (target === undefined || target.trim() === '') return act.headline
  // a path (a file read or edited, or the one a permission prompt is about) reads relative to the project
  if (scene.kind === 'read' || scene.kind === 'edit' || /^[~/][^\s]*$/.test(target)) return attempt(() => displayPath(target, cwd, TITLE_PATH_MAX), target) || target
  return target
}

/**
 * The header text with its secrets masked. The timeline stores text masked already; this keeps a model
 * saved before that from ever showing one. The header shows one line, so a long text is looked at only
 * as far as the frame could ever show it.
 */
const shownTitle = (title: unknown): string =>
  typeof title === 'string' ? redactSecrets(title.length > TITLE_SEEN_MAX ? title.slice(0, TITLE_SEEN_MAX) : title) : ''

/**
 * Identity of what is newly on stage: the activity and its newest step. The pane plays a frame's
 * intro only the first time it draws one of these (see register.tsx), so a redraw for a status
 * change never replays the typing.
 */
export function freshKey(m: SessionModel): string {
  const act = attempt(() => currentActivity(m), undefined)
  if (act === undefined) return ''
  return `${act.id}#${act.stepIds.length}#${act.stepIds[act.stepIds.length - 1] ?? ''}`
}

/** The stage for the model at `now`: the activity on stage, its scene and header, the trail and the stats. Never throws. */
export function stageInput(m: SessionModel, prefs: Prefs, now: number, cwd?: string): StageInput {
  const isPaused = prefs?.isPaused === true
  const steps0 = Array.isArray(m?.steps) ? m.steps : []
  const strip = attempt(() => trail(m), steps0.slice(-TRAIL_MAX).map(s => ({ station: s.station, status: s.status })))
  const stats = {
    steps: m?.stats?.steps ?? 0,
    files: Array.isArray(m?.files) ? m.files.length : 0,
    edits: m?.stats?.edits ?? 0,
    elapsed: attempt(() => elapsedText(m), '0s'),
  }
  const idle: StageInput = { station: 'idle', status: 'ok', title: '', scene: { kind: 'idle' }, trail: strip, stats, isFresh: false, isPaused }
  const act = attempt(() => currentActivity(m), undefined)
  if (act === undefined) return idle
  try {
    const steps = attempt(() => stepsOf(m, act), [])
    const latest = steps[steps.length - 1]
    const scene = sceneOf(m, act, steps)
    const hop = m.hop
    const isHopping = hop !== undefined && hop.to === act.station && hop.from !== act.station && now <= hop.until
    const startedAt = latest?.startedAt ?? act.startedAt
    return {
      station: act.station,
      ...(isHopping ? { hopFrom: hop.from } : {}),
      status: act.status,
      title: shownTitle(titleOf(m, act, steps, scene, cwd)),
      scene,
      trail: strip,
      stats,
      isFresh: !isPaused && (isHopping || now - startedAt < FRESH_MS),
      isPaused,
      ...(act.agentId === undefined ? {} : { lane: laneOf(m, act.agentId) }),
    }
  } catch {
    return idle
  }
}
