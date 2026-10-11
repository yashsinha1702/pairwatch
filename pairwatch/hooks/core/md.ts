// Plain-text and Markdown helpers shared by the timeline, narration, lesson and pane modules.
// Pure, no `$`. Every function is total: odd input gives ''.

/** Collapse whitespace runs (newlines, tabs) to single spaces and trim. Non-strings give ''. */
export function oneLine(s: unknown): string {
  return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : ''
}

/** Slice without splitting a UTF-16 surrogate pair (an emoji cut in half). */
function safeEnd(t: string, end: number): number {
  const c = t.charCodeAt(end - 1)
  return c >= 0xd800 && c <= 0xdbff ? end - 1 : end
}

/** One line of at most n characters, cut at a word boundary when one is near, ending with '…'. */
export function cut(s: unknown, n: number): string {
  const t = oneLine(s)
  if (t.length <= n) return t
  if (n < 2) return n === 1 ? '…' : ''
  const room = n - 1
  let end = room
  const space = t.lastIndexOf(' ', room)
  if (space >= room * 0.6) end = space
  const body = t.slice(0, safeEnd(t, end)).replace(/[\s,;:—–-]+$/, '')
  return body + '…'
}

/** The last n characters on one line, from a word boundary when one is near, starting with '…'. */
export function cutTail(s: unknown, n: number): string {
  const t = oneLine(s)
  if (t.length <= n) return t
  if (n < 2) return n === 1 ? '…' : ''
  const room = n - 1
  let start = t.length - room
  const space = t.indexOf(' ', start)
  if (space !== -1 && space - start <= room * 0.4) start = space + 1
  const c = t.charCodeAt(start)
  if (c >= 0xdc00 && c <= 0xdfff) start += 1
  return '…' + t.slice(start)
}

const SENTENCE_END = /[.!?…](?=\s+[A-Z0-9“"‘'(]|\s*$)/g

/** The first k sentences of a text, on one line, cut to n characters. */
export function firstSentences(s: unknown, k: number, n: number): string {
  const t = oneLine(s)
  if (t === '') return ''
  let count = 0
  let end = t.length
  SENTENCE_END.lastIndex = 0
  for (let m = SENTENCE_END.exec(t); m !== null; m = SENTENCE_END.exec(t)) {
    count += 1
    if (count >= k) {
      end = m.index + 1
      break
    }
  }
  return cut(t.slice(0, end), n)
}

/** The last path segment: '/a/b/login.py' -> 'login.py'. */
export function basename(p: unknown): string {
  const t = oneLine(p).replace(/\/+$/, '')
  const i = t.lastIndexOf('/')
  return i >= 0 ? t.slice(i + 1) : t
}

/** True for strings that look like a file path rather than a sentence or a command. */
export function isPathLike(s: string): boolean {
  return /^(?:~|\.{1,2})?\/?[\w.@+~-]+(?:\/[\w.@+~ -]+)+\/?$/.test(s) || /^[\w@+~-][\w.@+~-]*\.[A-Za-z0-9]{1,8}$/.test(s)
}

/** '12s', '4m 05s', '1h 02m'. */
export function fmtDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m < 60) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** Escape what Markdown would read as formatting inside one line of text: emphasis, code, links, html, strike. */
export function mdEscape(s: unknown): string {
  return oneLine(s).replace(/[\\`*_[\]<>~]/g, '\\$&')
}

/** mdEscape, and neutralise a start that would open a block (heading, quote, list, rule). */
export function mdText(s: unknown): string {
  const t = mdEscape(s)
  if (/^(?:#|>|[-+=](?:\s|$)|\d{1,9}[.)](?:\s|$))/.test(t)) {
    const m = /^\d+/.exec(t)
    return m ? `${m[0]}\\${t.slice(m[0].length)}` : `\\${t}`
  }
  return t
}

/** An inline code span that survives backticks in the text: `x`, or `` a`b `` when it holds one. */
export function codeSpan(s: unknown): string {
  const t = oneLine(s)
  if (t === '') return ''
  let longest = 0
  for (const m of t.matchAll(/`+/g)) longest = Math.max(longest, m[0].length)
  const fence = '`'.repeat(longest + 1)
  const pad = longest > 0 ? ' ' : ''
  return `${fence}${pad}${t}${pad}${fence}`
}
