// lessons.ts: which concept card to show, and how deep. Run: node --test dev/spec/lessons.spec.ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Concept, Level } from '../../pairwatch/types'
import { CONCEPTS } from '../../pairwatch/hooks/core/concepts.ts'
import { depthFor, lessonMarkdown, levelFit, markSeen, nextLesson, pickLesson, RECENT_MS } from '../../pairwatch/hooks/core/lessons.ts'
import type { PickCtx, SeenMap } from '../../pairwatch/hooks/core/lessons.ts'

const NOW = 1_760_000_000_000
const HOUR = 3_600_000

const card = (id: string, level: Level, related: string[] = [], extra: Partial<Concept> = {}): Concept => ({
  id,
  title: `Card ${id}`,
  category: 'shell',
  level,
  short: `What ${id} is.`,
  why: `Why ${id} matters.`,
  deeper: `More about ${id}.`,
  tryIt: `echo ${id}`,
  related,
  ...extra,
})

/** A made-up knowledge base: a* and b* at levels 1, 2, 3. */
const KB: Record<string, Concept> = {
  a1: card('a1', 1),
  a2: card('a2', 2),
  a3: card('a3', 3),
  b1: card('b1', 1, ['a2', 'b2', 'nope']),
  b2: card('b2', 2),
  b3: card('b3', 3, ['a3']),
}

const ctx = (level: Level, o: Partial<PickCtx> = {}): PickCtx => ({ level, known: new Set(), seen: {}, now: NOW, recent: [], concepts: KB, ...o })
const seenLongAgo = (n: number): SeenMap[string] => ({ n, last: NOW - 5 * HOUR })

describe('pickLesson: level fit', () => {
  it('beginner prefers levels 1–2 and avoids 3', () => {
    assert.equal(pickLesson(['a3', 'a1'], ctx(1)), 'a1')
    assert.equal(pickLesson(['a3', 'a2'], ctx(1)), 'a2')
    assert.equal(pickLesson(['a3'], ctx(1)), 'a3', 'avoided, not forbidden')
  })

  it('intermediate prefers 2 and allows 1 or 3 only while unseen', () => {
    assert.equal(pickLesson(['a1', 'a3', 'a2'], ctx(2)), 'a2')
    assert.equal(pickLesson(['a3'], ctx(2)), 'a3')
    assert.equal(pickLesson(['a1'], ctx(2)), 'a1')
    assert.equal(pickLesson(['a3'], ctx(2, { seen: { a3: seenLongAgo(1) } })), undefined)
    assert.equal(pickLesson(['a1'], ctx(2, { seen: { a1: seenLongAgo(1) } })), undefined)
  })

  it('expert prefers 3, allows 2 only while unseen, never 1', () => {
    assert.equal(pickLesson(['a2', 'a3'], ctx(3)), 'a3')
    assert.equal(pickLesson(['a2'], ctx(3)), 'a2')
    assert.equal(pickLesson(['a2'], ctx(3, { seen: { a2: seenLongAgo(1) } })), undefined)
    assert.equal(pickLesson(['a1'], ctx(3)), undefined)
    assert.equal(levelFit(3, 1, 0), 0)
  })
})

describe('pickLesson: relevance, novelty, known, recent', () => {
  it('candidate order decides between equals', () => {
    assert.equal(pickLesson(['a2', 'b2'], ctx(2)), 'a2')
    assert.equal(pickLesson(['b2', 'a2'], ctx(2)), 'b2')
  })

  it('novelty: a card seen many times gives way to a fresh one', () => {
    assert.equal(pickLesson(['a2', 'b2'], ctx(2, { seen: { a2: seenLongAgo(4) } })), 'b2')
    assert.equal(pickLesson(['a2', 'b2'], ctx(2, { seen: { a2: seenLongAgo(4), b2: seenLongAgo(9) } })), 'a2')
  })

  it('known cards are never picked', () => {
    assert.equal(pickLesson(['a2', 'b2'], ctx(2, { known: new Set(['a2']) })), 'b2')
    assert.equal(pickLesson(['a2'], ctx(2, { known: new Set(['a2']) })), undefined)
  })

  it('a card shown in the last 10 minutes, or listed in recent, is heavily penalised', () => {
    assert.equal(pickLesson(['a2', 'b2'], ctx(2, { recent: ['a2'] })), 'b2')
    assert.equal(pickLesson(['a2', 'b2'], ctx(2, { seen: { a2: { n: 1, last: NOW - 2 * 60_000 } } })), 'b2')
    assert.equal(pickLesson(['a2', 'b2'], ctx(2, { seen: { a2: { n: 1, last: NOW - RECENT_MS + 60_000 }, b2: seenLongAgo(1) } })), 'b2')
    assert.equal(pickLesson(['a2', 'b2'], ctx(2, { seen: { a2: { n: 1, last: NOW - RECENT_MS - 1 }, b2: seenLongAgo(1) } })), 'a2', 'outside the window only novelty counts')
    assert.equal(pickLesson(['a2', 'b1'], ctx(2, { recent: ['a2'] })), 'b1', 'even a weaker fit beats a repeat')
    assert.equal(pickLesson(['a2'], ctx(2, { recent: ['a2'] })), 'a2', 'a penalty, not a ban')
  })

  it('is deterministic and ignores junk', () => {
    const c = ctx(1, { seen: { a1: seenLongAgo(1), b1: seenLongAgo(1) } })
    assert.equal(pickLesson(['b1', 'a1'], c), 'b1')
    assert.equal(pickLesson(['b1', 'a1'], c), 'b1')
    assert.equal(pickLesson(['zz', 7 as unknown as string, 'a1', 'a1'], ctx(1)), 'a1')
    assert.equal(pickLesson([], ctx(1)), undefined)
    assert.equal(pickLesson(null as unknown as string[], ctx(1)), undefined)
    assert.equal(pickLesson(['a1'], { ...ctx(1), seen: null as unknown as SeenMap, known: undefined as unknown as Set<string> }), 'a1')
  })

  it('uses the real knowledge base by default', () => {
    const first = Object.keys(CONCEPTS)[0]
    const plain = { level: 1 as const, known: new Set<string>(), seen: {}, now: NOW, recent: [] }
    if (first === undefined) assert.equal(pickLesson(['grep'], plain), undefined)
    else assert.equal(pickLesson([first], { ...plain, level: CONCEPTS[first]!.level }), first)
    assert.equal(pickLesson(['not-a-concept'], plain), undefined)
  })
})

describe('nextLesson ("Another tip")', () => {
  it('never returns the current card', () => {
    assert.equal(nextLesson('a2', ['a2', 'b2'], ctx(2)), 'b2')
  })

  it('falls back to the current card’s related ones', () => {
    assert.equal(nextLesson('b1', ['b1'], ctx(1)), 'a2')
    assert.equal(nextLesson('b1', ['b1'], ctx(1, { known: new Set(['a2']) })), 'b2')
  })

  it('then to any unseen card that suits the level', () => {
    assert.equal(nextLesson('a2', ['a2'], ctx(2)), 'b2', 'level 2 fits an intermediate best')
    assert.equal(nextLesson('a3', ['a3'], ctx(3, { seen: { b3: seenLongAgo(1) } })), 'a2', 'b3 is seen; a2 is the only unseen fit left')
    assert.equal(nextLesson('a1', [], ctx(1, { seen: { a2: seenLongAgo(1), b1: seenLongAgo(1), b2: seenLongAgo(1) } })), 'a3')
  })

  it('prefers a fresh card over a recent one from an earlier tier', () => {
    assert.equal(nextLesson('a2', ['a2', 'b2'], ctx(2, { recent: ['b2'] })), 'a3')
  })

  it('returns undefined when nothing is left', () => {
    const all = new Set(Object.keys(KB))
    assert.equal(nextLesson('a1', ['a1'], ctx(1, { known: all })), undefined)
    assert.equal(nextLesson(undefined, [], ctx(3, { known: new Set(['a3', 'b3']), seen: { a2: seenLongAgo(1), b2: seenLongAgo(1) } })), undefined)
  })
})

describe('depthFor', () => {
  it('deepens at ~15 s and ~35 s', () => {
    assert.equal(depthFor(0), 0)
    assert.equal(depthFor(15_000), 0)
    assert.equal(depthFor(15_001), 1)
    assert.equal(depthFor(35_001), 2)
    assert.equal(depthFor(Number.NaN), 0)
  })
})

describe('lessonMarkdown', () => {
  const lookup = (id: string) => KB[id]

  it('depth 0: title line, then short + why', () => {
    const md = lessonMarkdown(KB.a1!, 0, 1, lookup)
    assert.equal(md, '💡 **Card a1** · shell\n\nWhat a1 is. Why a1 matters.')
  })

  it('depth 1 adds deeper; depth 2 adds Try it and Related', () => {
    assert.equal(lessonMarkdown(KB.a1!, 1, 1, lookup), '💡 **Card a1** · shell\n\nWhat a1 is. Why a1 matters.\n\nMore about a1.')
    const md = lessonMarkdown(KB.b1!, 2, 2, lookup)
    assert.equal(md, '💡 **Card b1** · shell\n\nWhat b1 is. Why b1 matters.\n\nMore about b1.\n\nTry it: `echo b1`\n\nRelated: Card a2, Card b2')
  })

  it('experts get the terse card: why (+ deeper), no short, no try-it', () => {
    assert.equal(lessonMarkdown(KB.b3!, 0, 3, lookup), '💡 **Card b3** · shell\n\nWhy b3 matters.')
    assert.equal(lessonMarkdown(KB.b3!, 2, 3, lookup), '💡 **Card b3** · shell\n\nWhy b3 matters.\n\nMore about b3.')
  })

  it('uses double backticks when the command holds one', () => {
    const md = lessonMarkdown(card('t', 1, [], { tryIt: 'echo "today is `date`"' }), 2, 1, lookup)
    assert.ok(md.includes('Try it: `` echo "today is `date`" ``'), md)
  })

  it('escapes Markdown in the card text', () => {
    const md = lessonMarkdown(card('m', 1, [], { title: 'Globs: *.py and __init__', short: 'Use `*` [carefully].' }), 0, 1, lookup)
    assert.ok(md.startsWith('💡 **Globs: \\*.py and \\_\\_init\\_\\_** · shell'), md)
    assert.ok(md.includes('Use \\`\\*\\` \\[carefully\\].'), md)
  })

  it('tolerates junk', () => {
    assert.equal(lessonMarkdown(null as unknown as Concept, 0, 1), '')
    const bare = lessonMarkdown({ id: 'x', title: 'X', category: 'agent', level: 1, short: '', why: '', deeper: '' }, 2, 1)
    assert.equal(bare, '💡 **X** · agent')
  })
})

describe('markSeen', () => {
  it('counts and stamps without touching the input', () => {
    const before: SeenMap = { a1: { n: 2, last: 5 } }
    const after = markSeen(before, 'a1', 99)
    assert.deepEqual(after, { a1: { n: 3, last: 99 } })
    assert.deepEqual(before, { a1: { n: 2, last: 5 } })
    assert.deepEqual(markSeen({}, 'b2', 7), { b2: { n: 1, last: 7 } })
    assert.deepEqual(markSeen(undefined as unknown as SeenMap, 'c', 1), { c: { n: 1, last: 1 } })
  })
})
