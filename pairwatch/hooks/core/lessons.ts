// Choosing which concept card to show, and how deep. Pure, no `$`.
// Contract: the exported names and types below.
import type { Concept, Level, LessonState } from '../../types'
import { CONCEPT_IDS } from './concept-ids.ts'
import { CONCEPTS } from './concepts.ts'
import { codeSpan, mdEscape } from './md.ts'

/** What the learner has met, as kept in $.store. */
export type SeenMap = { [conceptId: string]: { n: number; last: number } }

export type PickCtx = {
  level: Level
  known: ReadonlySet<string>
  seen: SeenMap
  now: number
  /** concept ids shown recently, newest last */
  recent: readonly string[]
  /** the knowledge base to choose from (default: every card in concepts.ts) */
  concepts?: Readonly<Record<string, Concept>>
}

/** A card shown this recently (or listed in `recent`) is heavily penalised. */
export const RECENT_MS = 10 * 60_000
const RECENT_PENALTY = 0.04

type Ranked = { id: string; score: number; isStale: boolean; index: number }

const kbOf = (ctx: PickCtx): Readonly<Record<string, Concept>> => (ctx.concepts !== null && typeof ctx.concepts === 'object' ? ctx.concepts : CONCEPTS)

const seenCount = (ctx: PickCtx, id: string): number => {
  const n = ctx.seen?.[id]?.n
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * How well a card's level suits the learner (0 = never).
 * beginner: prefers 1–2, avoids 3. intermediate: prefers 2, allows 1 or 3 only unseen.
 * expert: prefers 3, allows 2 only unseen, never 1.
 */
export function levelFit(learner: Level, card: Level, seen: number): number {
  if (learner === 3) return card === 3 ? 1 : card === 2 && seen === 0 ? 0.45 : 0
  if (learner === 2) return card === 2 ? 1 : seen > 0 ? 0 : card === 3 ? 0.6 : 0.5
  return card === 1 ? 1 : card === 2 ? 0.9 : 0.15
}

const learnerLevel = (x: unknown): Level => (x === 2 || x === 3 ? x : 1)

/** Score every usable candidate; best first, ties broken by candidate order, then id. `flat`: order carries no relevance. */
function rank(candidates: readonly unknown[], ctx: PickCtx, flat = false): Ranked[] {
  const kb = kbOf(ctx)
  const level = learnerLevel(ctx.level)
  const known = ctx.known instanceof Set ? ctx.known : new Set<string>()
  const recent = new Set(Array.isArray(ctx.recent) ? ctx.recent : [])
  const now = typeof ctx.now === 'number' && Number.isFinite(ctx.now) ? ctx.now : 0
  const out: Ranked[] = []
  const taken = new Set<string>()
  candidates.forEach((id, index) => {
    if (typeof id !== 'string' || taken.has(id)) return
    taken.add(id)
    const c = kb[id]
    if (c === undefined || known.has(id)) return
    const n = seenCount(ctx, id)
    const fit = levelFit(level, learnerLevel(c.level), n)
    if (fit <= 0) return
    const last = ctx.seen?.[id]?.last
    const isStale = recent.has(id) || (typeof last === 'number' && now - last < RECENT_MS)
    const relevance = flat ? 1 : 1 / (1 + 0.35 * index)
    const novelty = 1 / (1 + n)
    out.push({ id, score: relevance * fit * novelty * (isStale ? RECENT_PENALTY : 1), isStale, index })
  })
  return out.sort((a, b) => b.score - a.score || a.index - b.index || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Pick the best concept to teach from a step's candidates (most specific first). undefined when none fits. */
export function pickLesson(candidates: readonly string[], ctx: PickCtx): string | undefined {
  try {
    return rank(Array.isArray(candidates) ? candidates : [], ctx)[0]?.id
  } catch {
    return undefined
  }
}

/**
 * The 'Another tip' button: a different card than `current`. Tries the step's other candidates,
 * then the current card's related ones, then any unseen card that suits the level. A card shown
 * recently is used only when nothing fresh is left.
 */
export function nextLesson(current: string | undefined, candidates: readonly string[], ctx: PickCtx): string | undefined {
  try {
    const kb = kbOf(ctx)
    const not = (id: unknown): boolean => id !== current
    const tiers: unknown[][] = [
      (Array.isArray(candidates) ? candidates : []).filter(not),
      (current === undefined ? [] : (kb[current]?.related ?? [])).filter(not),
    ]
    const ids = kb === CONCEPTS ? CONCEPT_IDS.filter(id => kb[id] !== undefined) : Object.keys(kb)
    tiers.push(ids.filter(id => not(id) && seenCount(ctx, id) === 0))
    let fallback: string | undefined
    for (const [i, tier] of tiers.entries()) {
      const ranked = rank(tier, ctx, i === 2) // the whole deck: level fit and novelty decide, not its order
      const fresh = ranked.find(r => !r.isStale)
      if (fresh !== undefined) return fresh.id
      fallback ??= ranked[0]?.id
    }
    return fallback
  } catch {
    return undefined
  }
}

/** How deep the card should be after the activity has run `elapsedMs`: 0 at first, 1 after ~15 s, 2 after ~35 s. */
export function depthFor(elapsedMs: number): LessonState['depth'] {
  return elapsedMs > 35_000 ? 2 : elapsedMs > 15_000 ? 1 : 0
}

/**
 * The card as Markdown for the pane. '💡 **Title** · category', then short + why; depth >= 1 adds
 * deeper; depth 2 adds 'Try it' and 'Related'. Experts (level 3) get the terse card: why (+ deeper).
 * `lookup` finds related cards' titles (default: concepts.ts).
 */
export function lessonMarkdown(c: Concept, depth: LessonState['depth'], level: Level, lookup: (id: string) => Concept | undefined = id => CONCEPTS[id]): string {
  try {
    if (c === null || typeof c !== 'object') return ''
    const parts: string[] = [`💡 **${mdEscape(c.title) || 'Tip'}** · ${mdEscape(c.category)}`]
    const deeper = mdEscape(c.deeper)
    if (level === 3) {
      parts.push(mdEscape(c.why) || mdEscape(c.short))
      if (depth >= 1 && deeper !== '') parts.push(deeper)
      return parts.filter(p => p !== '').join('\n\n')
    }
    parts.push([mdEscape(c.short), mdEscape(c.why)].filter(p => p !== '').join(' '))
    if (depth >= 1 && deeper !== '') parts.push(deeper)
    if (depth >= 2) {
      const tryIt = codeSpan(c.tryIt)
      if (tryIt !== '') parts.push(`Try it: ${tryIt}`)
      const titles = (Array.isArray(c.related) ? c.related : [])
        .map(id => (typeof id === 'string' ? lookup(id)?.title : undefined))
        .filter((t): t is string => typeof t === 'string' && t !== '')
        .map(mdEscape)
      if (titles.length > 0) parts.push(`Related: ${titles.join(', ')}`)
    }
    return parts.filter(p => p !== '').join('\n\n')
  } catch {
    return ''
  }
}

/** Record that a concept was shown. */
export function markSeen(seen: SeenMap, id: string, now: number): SeenMap {
  const base: SeenMap = seen !== null && typeof seen === 'object' ? seen : {}
  const was = base[id]
  const n = typeof was?.n === 'number' && Number.isFinite(was.n) ? was.n : 0
  return { ...base, [id]: { n: n + 1, last: now } }
}
