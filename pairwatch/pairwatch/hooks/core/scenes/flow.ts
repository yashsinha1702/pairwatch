// Scenes for the flow stations: plan, ask, tools, think, talk, done, idle.
// Each returns an SVG fragment drawn inside ctx's box. Never throws.
//
// How these scenes are drawn:
// - A fragment is one <g> translated to the box's top-left, so every coordinate below is local
//   (0..w, 0..h). A clipPath with a uid-prefixed id keeps every mark inside the box.
// - Base attributes always hold the settled picture. An intro animation (only when ctx.isFresh) starts
//   at t = 0, holds its first value through its delay (keyTimes), then freezes on the settled value.
//   So nothing flashes before it starts, and a surface that ignores SMIL still shows the settled state.
// - Loops (repeatCount="indefinite") exist only while not paused. A paused scene has no animation at all.
// - Text stays plain until the last moment. It is cleaned, measured with a conservative width table,
//   wrapped or cut with '…' to fit its space, and then escaped.
import type { SceneData, StepStatus } from '../../../types'
import { COLOR } from '../stations.ts'
import { esc, hash, INK, MONO, rand, SANS, type SceneCtx } from './kit.ts'

type Of<K extends SceneData['kind']> = Extract<SceneData, { kind: K }>

// ---------------------------------------------------------------- the box

/** The scene box made safe: finite sizes, a valid colour and id prefix, and what may animate. */
type Box = {
  x: number
  y: number
  w: number
  h: number
  color: string
  uid: string
  status: StepStatus
  isRunning: boolean
  /** play intro animations: a fresh step on an unpaused stage */
  intro: boolean
  /** loops allowed: not paused */
  live: boolean
}

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,24})$/
const STATUSES: readonly string[] = ['running', 'ok', 'error', 'denied']

const toBox = (ctx: SceneCtx): Box => {
  const c: Partial<SceneCtx> = typeof ctx === 'object' && ctx !== null ? ctx : {}
  const status = typeof c.status === 'string' && STATUSES.includes(c.status) ? c.status : 'running'
  const uid = (typeof c.uid === 'string' ? c.uid : '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)
  const live = c.isPaused !== true
  return {
    x: num(c.x, 0),
    y: num(c.y, 0),
    w: clamp(num(c.w, 592), 80, 4000),
    h: clamp(num(c.h, 90), 40, 1000),
    color: typeof c.color === 'string' && COLOR_RE.test(c.color) ? c.color : INK.textDim,
    uid: /^[A-Za-z_]/.test(uid) ? uid : `s${uid}`,
    status,
    isRunning: status === 'running',
    intro: live && c.isFresh === true,
    live,
  }
}

/** Wrap a scene body: translate to the box, clip to it, and never throw ('' on a failure). */
const scene = (ctx: SceneCtx, body: (b: Box) => string): string => {
  try {
    const b = toBox(ctx)
    const id = `${b.uid}-flow`
    return (
      `<g transform="translate(${f(b.x)} ${f(b.y)})" font-family="${SANS}">` +
      `<defs><clipPath id="${id}"><rect x="-3" y="-3" width="${f(b.w + 6)}" height="${f(b.h + 6)}"/></clipPath></defs>` +
      `<g clip-path="url(#${id})">${body(b)}</g></g>`
    )
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------- numbers and animation

/** A coordinate for an attribute: rounded to 0.1, never NaN or -0. */
const f = (v: number): string => {
  const r = Math.round(v * 10) / 10
  return Number.isFinite(r) && r !== 0 ? String(r) : '0'
}

/** A time, fraction or opacity for SMIL: rounded to 0.001. */
const t3 = (v: number): string => {
  const r = Math.round(v * 1000) / 1000
  return Number.isFinite(r) && r !== 0 ? String(r) : '0'
}

/** A keyframe: [seconds from the start, value]. */
type Frame = readonly [number, string | number]
const EASE = '.25 .1 .25 1'

/** values / keyTimes / dur for keyframes that start at t = 0 and freeze on the last value. */
const keyframes = (frames: readonly Frame[], ease: boolean): string => {
  const first = frames[0]
  if (first === undefined) return ''
  const list: Frame[] = first[0] > 0 ? [[0, first[1]], ...frames] : [...frames]
  const end = list[list.length - 1]?.[0] ?? 0
  if (list.length < 2 || !(end > 0)) return ''
  const values = list.map(k => (typeof k[1] === 'number' ? t3(k[1]) : k[1])).join(';')
  const times = list.map((k, i) => (i === 0 ? '0' : i === list.length - 1 ? '1' : t3(k[0] / end))).join(';')
  const spline = ease ? ` calcMode="spline" keySplines="${Array<string>(list.length - 1).fill(EASE).join(';')}"` : ''
  return ` values="${values}" keyTimes="${times}" dur="${t3(end)}s"${spline} fill="freeze"`
}

/** An intro animation of one attribute; '' unless the step is fresh and the stage is not paused. */
const intro = (b: Box, attr: string, frames: readonly Frame[], ease = true): string => {
  const body = b.intro ? keyframes(frames, ease) : ''
  return body === '' ? '' : `<animate attributeName="${attr}"${body}/>`
}

/** An intro transform ('dx dy' for translate, 'sx sy' for scale, 'deg' for rotate). Put it on a <g>
 *  that has no transform of its own. */
const introT = (b: Box, type: 'translate' | 'scale' | 'rotate', frames: readonly Frame[], ease = true): string => {
  const body = b.intro ? keyframes(frames, ease) : ''
  return body === '' ? '' : `<animateTransform attributeName="transform" type="${type}"${body}/>`
}

/** A looping animation; '' while paused. `extra` may add begin / keyTimes / calcMode. */
const loop = (b: Box, attr: string, values: string, dur: number, extra = ''): string =>
  b.live ? `<animate attributeName="${attr}" values="${values}" dur="${t3(dur)}s"${extra} repeatCount="indefinite"/>` : ''

/** A looping transform; '' while paused. Put it on a <g> that has no transform of its own. */
const loopT = (b: Box, type: 'translate' | 'scale' | 'rotate', values: string, dur: number, extra = ''): string =>
  b.live
    ? `<animateTransform attributeName="transform" type="${type}" values="${values}" dur="${t3(dur)}s"${extra} repeatCount="indefinite"/>`
    : ''

// ---------------------------------------------------------------- plain text

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
// C0/C1 controls, bidi overrides and isolates, and the two XML non-characters.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufffe\uffff]/g

/** Any value as one line of plain text: at most `max` UTF-16 units, whitespace collapsed, and nothing
 *  an SVG text node cannot hold. Not escaped yet. */
const plain = (v: unknown, max = 600): string => {
  const s = typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : ''
  return s.slice(0, max).replace(LONE_SURROGATE, '').replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim()
}

/** A count for display: a whole number in 0..max. */
const count = (v: unknown, max = 999999): number => clamp(Math.round(num(v, 0)), 0, max)

// ---------------------------------------------------------------- measuring text

// Advance widths of printable ASCII (U+0020..U+007E) in 1/100 em, from Helvetica/Arial metrics.
// SANS_K widens them so text measured here also fits the wider UI faces (Noto Sans, DejaVu Sans).
const ASCII_W: readonly number[] = [
  28, 28, 36, 56, 56, 89, 67, 19, 33, 33, 39, 58, 28, 33, 28, 28, 56, 56, 56, 56, 56, 56, 56, 56, 56, 56, 28, 28, 58, 58,
  58, 56, 102, 67, 67, 72, 72, 67, 61, 78, 72, 28, 50, 67, 56, 83, 72, 78, 67, 78, 72, 67, 61, 72, 67, 94, 67, 67, 61, 28,
  28, 28, 47, 56, 33, 56, 56, 50, 56, 56, 28, 56, 56, 22, 22, 50, 22, 83, 56, 56, 56, 56, 33, 50, 28, 56, 50, 72, 50, 50,
  50, 33, 26, 33, 58,
]
const SANS_K = 1.1
const BOLD_K = 1.07

const isWide = (c: number): boolean =>
  (c >= 0x1100 && c <= 0x115f) ||
  (c >= 0x2e80 && c <= 0xa4cf) ||
  (c >= 0xac00 && c <= 0xd7a3) ||
  (c >= 0xf900 && c <= 0xfaff) ||
  (c >= 0xfe30 && c <= 0xfe4f) ||
  (c >= 0xff00 && c <= 0xff60) ||
  (c >= 0xffe0 && c <= 0xffe6) ||
  (c >= 0x20000 && c <= 0x3fffd)

const isEmoji = (c: number): boolean => (c >= 0x1f000 && c <= 0x1faff) || (c >= 0x2600 && c <= 0x27bf) || (c >= 0x2b00 && c <= 0x2bff)

/** Width of one code point in em. Zero-width marks get a floor so a line's length stays bounded. */
const em = (c: number, mono: boolean): number => {
  if (isWide(c)) return 1.05
  if (isEmoji(c)) return 1.3
  if ((c >= 0x300 && c <= 0x36f) || (c >= 0x200b && c <= 0x200f) || c === 0xfe0f) return 0.2
  if (c === 0x2026 || c === 0x2014) return 1.05
  if (mono) return 0.62
  if (c >= 32 && c < 127) return ((ASCII_W[c - 32] ?? 56) / 100) * SANS_K
  return 0.7
}

type Font = { size: number; mono?: boolean; bold?: boolean; spacing?: number }

const widths = (cps: readonly string[], font: Font): number[] => {
  const k = font.size * (font.bold === true ? BOLD_K : 1)
  const ls = font.spacing ?? 0
  return cps.map(ch => em(ch.codePointAt(0) ?? 32, font.mono === true) * k + ls)
}

/** Estimated drawn width of plain text in user units (on the wide side). */
const measure = (text: string, font: Font): number => widths(Array.from(text), font).reduce((a, w) => a + w, 0)

const ELLIPSIS = '…'
/** No line holds more code points than this, whatever their widths: it bounds the escaped size of
 *  pathological text (a run of quotes is narrow but escapes to five characters each). */
const MAX_LINE = 140

/** Greedy word wrap into at most maxLines lines, each at most maxW wide. When text is left over, the
 *  last line ends in '…'. Returns plain lines (escape them). */
const wrap = (text: string, maxW: number, font: Font, maxLines: number): string[] => {
  const cps = Array.from(text)
  const ws = widths(cps, font)
  const ellW = (em(0x2026, font.mono === true) * font.size * (font.bold === true ? BOLD_K : 1)) + (font.spacing ?? 0)
  const lines: string[] = []
  const n = cps.length
  let i = 0
  while (lines.length < maxLines && i < n) {
    while (i < n && cps[i] === ' ') i++
    if (i >= n) break
    let w = 0
    let j = i
    let space = -1
    while (j < n && j - i < MAX_LINE) {
      const cw = ws[j] ?? 0
      if (w + cw > maxW) break
      if (cps[j] === ' ') space = j
      w += cw
      j++
    }
    if (j >= n) {
      lines.push(cps.slice(i).join('').trimEnd())
      break
    }
    if (lines.length === maxLines - 1) {
      // The last line: keep what fits beside the ellipsis, at a word boundary when that keeps most of it.
      let cw = 0
      let e = i
      while (e < n && e - i < MAX_LINE - 1 && cw + (ws[e] ?? 0) + ellW <= maxW) cw += ws[e++] ?? 0
      const cut = cps.slice(i, e).join('')
      const sp = cut.lastIndexOf(' ')
      const body = sp > cut.length * 0.6 ? cut.slice(0, sp) : cut
      lines.push(body.replace(/[\s.,;:!?·–—-]+$/u, '') + ELLIPSIS)
      break
    }
    if (space > i && space - i >= (j - i) * 0.5) {
      lines.push(cps.slice(i, space).join(''))
      i = space + 1
    } else {
      const e = Math.max(j, i + 1)
      lines.push(cps.slice(i, e).join(''))
      i = e
    }
  }
  return lines
}

/** One line cut to fit maxW (with '…' when cut). */
const fit = (text: string, maxW: number, font: Font): string => wrap(text, maxW, font, 1)[0] ?? ''

/** A <text> element. `body` must already be escaped (it may hold <tspan>s). */
const txt = (x: number, y: number, size: number, fill: string, body: string, extra = ''): string =>
  `<text x="${f(x)}" y="${f(y)}" font-size="${f(size)}" fill="${fill}"${extra}>${body}</text>`

// ---------------------------------------------------------------- shared shapes

/** A rounded box with a tail on its left side whose tip is at (x - 9, ty). */
const bubbleLeft = (x: number, y: number, w: number, h: number, r: number, ty: number): string => {
  const lo = y + r + 6
  const hi = y + h - r - 6
  const t = lo <= hi ? clamp(ty, lo, hi) : y + h / 2
  return (
    `M${f(x + r)} ${f(y)}H${f(x + w - r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + w)} ${f(y + r)}V${f(y + h - r)}` +
    `A${f(r)} ${f(r)} 0 0 1 ${f(x + w - r)} ${f(y + h)}H${f(x + r)}A${f(r)} ${f(r)} 0 0 1 ${f(x)} ${f(y + h - r)}` +
    `V${f(t + 6)}L${f(x - 9)} ${f(t)}L${f(x)} ${f(t - 6)}V${f(y + r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + r)} ${f(y)}Z`
  )
}

/** A rounded box with a tail under its bottom-left corner. */
const bubbleDown = (x: number, y: number, w: number, h: number, r: number): string => {
  const tx = x + r + 4
  return (
    `M${f(x + r)} ${f(y)}H${f(x + w - r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + w)} ${f(y + r)}V${f(y + h - r)}` +
    `A${f(r)} ${f(r)} 0 0 1 ${f(x + w - r)} ${f(y + h)}H${f(tx + 14)}L${f(tx - 2)} ${f(y + h + 10)}L${f(tx + 2)} ${f(y + h)}` +
    `H${f(x + r)}A${f(r)} ${f(r)} 0 0 1 ${f(x)} ${f(y + h - r)}V${f(y + r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + r)} ${f(y)}Z`
  )
}

/** A small check (ok) or cross (error / denied) centred on (x, y). */
const mark = (ok: boolean, x: number, y: number): string =>
  ok
    ? `<path d="M${f(x - 3.5)} ${f(y)}l2.3 2.4 4.7-5" stroke="${INK.ok}" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
    : `<path d="M${f(x - 3)} ${f(y - 3)}l6 6M${f(x + 3)} ${f(y - 3)}l-6 6" stroke="${INK.bad}" stroke-width="1.8" stroke-linecap="round"/>`

/** Three dots that pulse in turn (a typing / waiting indicator); static while paused. */
const dots = (b: Box, x: number, y: number, r: number, gap: number, color: string, isAlive: boolean): string =>
  [0, 1, 2]
    .map(i => {
      const pulse = isAlive ? loop(b, 'opacity', '.25;1;.25', 1.2, ` begin="${t3(i * 0.2)}s"`) : ''
      return `<circle cx="${f(x + i * gap)}" cy="${f(y)}" r="${f(r)}" fill="${color}" opacity="${isAlive && b.live ? '.25' : '.85'}">${pulse}</circle>`
    })
    .join('')

/** A fade-in from t = delay over dur seconds (intro only). */
const fadeIn = (b: Box, delay: number, dur = 0.4): string => intro(b, 'opacity', [[0, 0], [delay, 0], [delay + dur, 1]])

// ---------------------------------------------------------------- plan

type PlanState = 'done' | 'doing' | 'todo'

const planState = (it: unknown): PlanState => {
  const st = typeof it === 'object' && it !== null ? (it as { state?: unknown }).state : undefined
  return st === 'done' || st === 'doing' ? st : 'todo'
}

const planText = (it: unknown): string => plain(typeof it === 'object' && it !== null ? (it as { text?: unknown }).text : undefined, 400)

/** ✓ (done), a pulsing ◐ (in progress) or ○ (to do), centred on (x, y). */
const planGlyph = (b: Box, st: PlanState, x: number, y: number): string => {
  if (st === 'done')
    return (
      `<circle cx="${f(x)}" cy="${f(y)}" r="6" fill="${INK.ok}" fill-opacity=".16"/>` +
      `<path d="M${f(x - 3)} ${f(y + 0.2)}l2 2.1 4-4.6" fill="none" stroke="${INK.ok}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`
    )
  if (st === 'doing') {
    const ring = b.live
      ? `<circle cx="${f(x)}" cy="${f(y)}" r="5" fill="none" stroke="${INK.warn}" stroke-width="1.2" opacity="0">${loop(b, 'r', '5;11', 1.6)}${loop(b, 'opacity', '.7;0', 1.6)}</circle>`
      : ''
    return (
      `${ring}<g>${loop(b, 'opacity', '1;.45;1', 1.6)}` +
      `<circle cx="${f(x)}" cy="${f(y)}" r="5.2" fill="none" stroke="${INK.warn}" stroke-width="1.5"/>` +
      `<path d="M${f(x)} ${f(y - 5.2)}A5.2 5.2 0 0 0 ${f(x)} ${f(y + 5.2)}Z" fill="${INK.warn}"/></g>`
    )
  }
  return `<circle cx="${f(x)}" cy="${f(y)}" r="5" fill="none" stroke="${INK.gutter}" stroke-width="1.4"/>`
}

/** A plan with no items yet (plan mode): a clipboard being filled in. */
const planEmpty = (b: Box): string => {
  const cy = b.h / 2
  const lines = [0, 1, 2]
    .map(i => {
      const y = cy - 7 + i * 9
      const w = [16, 12, 14][i] ?? 12
      return (
        `<g>${fadeIn(b, 0.25 + i * 0.25, 0.3)}<rect x="27" y="${f(y - 2)}" width="4" height="4" rx="1" fill="none" stroke="${b.color}" stroke-width="1.1"/>` +
        `<rect x="34" y="${f(y - 1.2)}" width="${w}" height="2.6" rx="1.3" fill="${INK.line2}"/></g>`
      )
    })
    .join('')
  const title = 'Planning the approach'
  const sub = 'Claude is laying out the steps before it acts'
  const tx = 74
  return (
    `<rect x="20" y="${f(cy - 20)}" width="36" height="44" rx="5" fill="${INK.sheet}" stroke="${b.color}" stroke-opacity=".6" stroke-width="1.4"/>` +
    `<rect x="30" y="${f(cy - 24)}" width="16" height="7" rx="2.5" fill="${b.color}"/>` +
    lines +
    `<g>${fadeIn(b, 0.1)}${txt(tx, cy - 3, 13.5, INK.text, esc(fit(title, b.w - tx - 8, { size: 13.5, bold: true })), ' font-weight="600"')}` +
    `${txt(tx, cy + 15, 11, INK.textDim, esc(fit(sub, b.w - tx - 8, { size: 11 })))}</g>`
  )
}

const planScene = (s: Of<'plan'>, b: Box): string => {
  const raw: readonly unknown[] = Array.isArray(s?.items) ? s.items : []
  const total = raw.length
  if (total === 0) return planEmpty(b)

  let done = 0
  let doing = 0
  let focus = -1
  let firstTodo = -1
  for (let i = 0; i < total && i < 20000; i++) {
    const st = planState(raw[i])
    if (st === 'done') done++
    else if (st === 'doing') {
      doing++
      if (focus < 0) focus = i
    } else if (firstTodo < 0) firstTodo = i
  }
  const todo = Math.max(0, total - done - doing)
  if (focus < 0) focus = firstTodo >= 0 ? firstTodo : total - 1

  // Up to five items. A longer plan shows four around the one in progress (with one item of context
  // before it) and a '+N more' line, so the rows stay large enough to read in a narrow pane.
  const MAX = 5
  const shown = total > MAX ? MAX - 1 : total
  const start = clamp(focus - 1, 0, Math.max(0, total - shown))
  const vis = raw.slice(start, start + shown).map(it => ({ text: planText(it), state: planState(it) }))
  const hidden = Math.max(0, total - vis.length)
  const moreText = hidden > 0 ? `+${hidden} more` : ''

  // Left: the checklist card. Right: the progress column.
  const RW = clamp(b.w * 0.3, 110, 190)
  const LW = Math.max(60, b.w - RW - 16)
  const pad = 6
  const moreH = moreText === '' ? 0 : 13
  const rh = Math.min(17, (b.h - 2 * pad - moreH) / Math.max(1, vis.length))
  const fs = clamp(rh - 2.2, 10.5, 12.5)
  const top = (b.h - (rh * vis.length + moreH)) / 2
  const tx = 30

  const rows = vis
    .map((it, i) => {
      const cy = top + rh * (i + 0.5)
      const isDoing = it.state === 'doing'
      const line = fit(it.text === '' ? 'Untitled task' : it.text, LW - tx - 10, { size: fs, bold: isDoing })
      const fill = it.state === 'done' ? INK.textFaint : isDoing ? INK.text : INK.textDim
      const extra = (it.state === 'done' ? ' text-decoration="line-through"' : '') + (isDoing ? ' font-weight="600"' : '')
      const band = isDoing
        ? `<rect x="5" y="${f(cy - rh / 2 + 0.6)}" width="${f(LW - 10)}" height="${f(rh - 1.2)}" rx="4" fill="${INK.warn}" fill-opacity=".09"/>`
        : ''
      const delay = 0.07 * i
      const slide = b.intro
        ? intro(b, 'opacity', [[0, 0], [delay, 0], [delay + 0.35, 1]]) + introT(b, 'translate', [[0, '-14 0'], [delay, '-14 0'], [delay + 0.45, '0 0']])
        : ''
      return `<g>${slide}${band}${planGlyph(b, it.state, 16, cy)}${txt(tx, cy + fs * 0.36, fs, fill, esc(line), extra)}</g>`
    })
    .join('')
  const more =
    moreText === ''
      ? ''
      : `<g>${fadeIn(b, 0.07 * vis.length + 0.1)}${txt(tx, top + rh * vis.length + 10, 10.5, INK.textDim, esc(fit(moreText, LW - tx - 10, { size: 10.5 })))}</g>`

  const rx = LW + 16
  const frac = total > 0 ? done / total : 0
  const doingFrac = total > 0 ? doing / total : 0
  const blockTop = (b.h - 56) / 2
  const fy = blockTop + 18
  const by = blockTop + 28
  const ly = blockTop + 52
  const doneW = RW * frac
  const isAllDone = done >= total
  const breakdown = isAllDone ? 'All tasks done' : `${doing} in progress · ${todo} to do`
  const progress =
    `<g>${fadeIn(b, 0.15)}${txt(rx, fy, 20, INK.text, `${done}/${total}<tspan font-size="12" font-weight="400" fill="${INK.textDim}" dx="5">done</tspan>`, ' font-weight="700"')}</g>` +
    `<rect x="${f(rx)}" y="${f(by)}" width="${f(RW)}" height="7" rx="3.5" fill="${INK.line1}"/>` +
    (doing > 0 && !isAllDone
      ? `<rect x="${f(rx + doneW)}" y="${f(by)}" width="${f(Math.min(RW - doneW, Math.max(3, RW * doingFrac)))}" height="7" rx="2" fill="${INK.warn}" fill-opacity=".55">${loop(b, 'fill-opacity', '.55;.25;.55', 1.6)}</rect>`
      : '') +
    (done > 0
      ? `<rect x="${f(rx)}" y="${f(by)}" width="${f(doneW)}" height="7" rx="3.5" fill="${INK.ok}">${intro(b, 'width', [[0, 0], [0.25, 0], [0.95, doneW]])}</rect>`
      : '') +
    `<g>${fadeIn(b, 0.35)}${txt(rx, ly, 10.5, isAllDone ? INK.ok : INK.textDim, esc(fit(breakdown, RW, { size: 10.5 })))}</g>`

  return (
    `<rect x="0" y="0" width="${f(LW)}" height="${f(b.h)}" rx="8" fill="${INK.sheet}" stroke="${INK.sheetStroke}"/>` +
    rows +
    more +
    progress
  )
}

// ---------------------------------------------------------------- ask

/** The "?" badge or, for a permission prompt, a shield with a lock. Centred on (x, y). */
const askBadge = (b: Box, isPermission: boolean, x: number, y: number): string => {
  const c = b.color
  const halo =
    b.isRunning && b.live
      ? `<circle r="19" fill="none" stroke="${c}" stroke-width="1.4" opacity="0">${loop(b, 'r', '19;28', 1.8)}${loop(b, 'opacity', '.6;0', 1.8)}</circle>`
      : ''
  const bob = b.isRunning ? loopT(b, 'scale', '1;1.1;1', 1.8, ' calcMode="spline" keyTimes="0;.5;1" keySplines=".4 0 .6 1;.4 0 .6 1"') : ''
  const icon = isPermission
    ? `<path d="M0-17L14-11.5V-1.5C14 8 7.5 14.5 0 17.5C-7.5 14.5-14 8-14-1.5V-11.5Z" fill="${c}" fill-opacity=".14" stroke="${c}" stroke-width="1.6" stroke-linejoin="round"/>` +
      `<path d="M-3.6-1.5V-5a3.6 3.6 0 0 1 7.2 0V-1.5" fill="none" stroke="${c}" stroke-width="1.8"/>` +
      `<rect x="-6" y="-2" width="12" height="9.5" rx="2" fill="${c}"/><circle cy="2.2" r="1.5" fill="${INK.panel}"/>`
    : `<circle r="18" fill="${c}" fill-opacity=".14" stroke="${c}" stroke-width="1.6"/>` +
      `<text y="8" text-anchor="middle" font-size="23" font-weight="700" fill="${c}">?</text>`
  return `<g transform="translate(${f(x)} ${f(y)})">${halo}<g>${bob}${icon}</g></g>`
}

const askScene = (s: Of<'ask'>, b: Box): string => {
  const isPermission = s?.isPermission === true
  const question = plain(s?.question, 900)
  const bubbleX = 62
  const padX = 13
  const maxBubbleW = Math.max(120, Math.min(b.w - bubbleX - 6, 480))
  const textW = maxBubbleW - 2 * padX

  // Bubble content: the question (2 lines), or 'Permission needed' and the tool line (2 lines of mono).
  const head = { size: 11, bold: true, spacing: 0.3 }
  const body: Font = isPermission ? { size: 11.5, mono: true } : { size: 13 }
  const lines = wrap(question || (isPermission ? 'Claude wants to use a tool' : 'Claude has a question for you'), textW, body, 2)
  const lineH = isPermission ? 15 : 16.5
  const headH = isPermission ? 16 : 0
  const contentW = Math.max(isPermission ? measure('Permission needed', head) : 0, ...lines.map(l => measure(l, body)))
  const bubbleW = clamp(contentW + 2 * padX + 4, 150, maxBubbleW)
  const bubbleH = 18 + headH + lineH * lines.length - (lineH - 12)
  const captionH = 14
  const top = Math.max(2, (b.h - (bubbleH + 7 + captionH)) / 2)
  const midY = top + bubbleH / 2

  let content = ''
  let y = top + 9
  if (isPermission) {
    content += txt(bubbleX + padX, y + 10.5, 11, b.color, 'Permission needed', ' font-weight="700" letter-spacing=".3"')
    y += headH
  }
  lines.forEach((l, i) => {
    const font = isPermission ? ` font-family="${MONO}"` : ''
    content += txt(bubbleX + padX, y + 11 + i * lineH, body.size, INK.text, esc(l), font)
  })

  const capY = top + bubbleH + 7 + 10
  const caption = b.isRunning
    ? dots(b, bubbleX + 6, capY - 3.5, 2, 6, b.color, true) +
      txt(bubbleX + 22, capY, 10.5, INK.textDim, 'Claude is waiting for you', ' font-style="italic"')
    : mark(b.status === 'ok', bubbleX + 8, capY - 3.5) +
      txt(
        bubbleX + 20,
        capY,
        10.5,
        INK.textDim,
        b.status === 'ok'
          ? isPermission
            ? 'You allowed it'
            : 'You answered'
          : b.status === 'denied'
            ? isPermission
              ? 'You declined'
              : 'Declined'
            : 'No answer',
        ' font-style="italic"',
      )

  const pop = introT(b, 'translate', [[0, '-10 0'], [0.4, '0 0']])
  return (
    `<g>${fadeIn(b, 0, 0.3)}${askBadge(b, isPermission, 28, midY)}</g>` +
    `<g>${intro(b, 'opacity', [[0, 0], [0.12, 0], [0.45, 1]])}<g>${pop}` +
    `<path d="${bubbleLeft(bubbleX, top, bubbleW, bubbleH, 10, midY)}" fill="${INK.sheet}" stroke="${b.color}" stroke-opacity=".55" stroke-width="1.3"/>` +
    `${content}</g></g>` +
    `<g>${fadeIn(b, 0.5)}${caption}</g>`
  )
}

// ---------------------------------------------------------------- tools

const SKILL_WORD = /(^|[^a-z])skills?($|[^a-z])/i

/** True when a tool name (or its server) looks like a skill: 'Skill', 'plugin:skill', '…-skills'. */
const looksLikeSkill = (name: string, server: string): boolean =>
  !/^mcp__/i.test(name) && (SKILL_WORD.test(name) || SKILL_WORD.test(server) || /^[\w.-]+:[\w.-]+$/.test(name))

/** The label card beside the socket or the book: a small label, the name, and a detail line. */
const toolCard = (b: Box, x: number, label: string, title: string, detail: string, led: string): string => {
  const cy = b.h / 2
  const padL = 22
  const lab: Font = { size: 10, spacing: 0.6 }
  const ttl: Font = { size: 15, bold: true }
  const det: Font = { size: 10.5, mono: true }
  const maxW = Math.max(40, b.w - x - padL - 26)
  const l1 = fit(label, maxW, lab)
  const l2 = fit(title, maxW, ttl)
  const l3 = detail === '' ? '' : fit(detail, maxW, det)
  const cw = clamp(Math.max(measure(l1, lab), measure(l2, ttl), measure(l3, det)) + padL + 28, 170, Math.max(170, b.w - x))
  const ch = Math.min(b.h - 8, 66)
  const ty = l3 === '' ? cy + 12 : cy + 5
  return (
    `<rect x="${f(x)}" y="${f(cy - ch / 2)}" width="${f(cw)}" height="${f(ch)}" rx="10" fill="${INK.sheet}" stroke="${INK.sheetStroke}"/>` +
    led.replace(/\{LX\}/g, f(x + cw - 13)).replace(/\{LY\}/g, f(cy - ch / 2 + 12)) +
    txt(x + padL, l3 === '' ? cy - 9 : cy - 14, 10, INK.textDim, esc(l1), ' letter-spacing=".6"') +
    txt(x + padL, ty, 15, INK.text, esc(l2), ' font-weight="700"') +
    (l3 === '' ? '' : txt(x + padL, cy + 22, 10.5, INK.textDim, esc(l3), ` font-family="${MONO}"`))
  )
}

/** The status light on the card: pulsing while running, green when ok, red otherwise. {LX}/{LY} are filled in by toolCard. */
const statusLed = (b: Box): string =>
  b.isRunning
    ? `<circle cx="{LX}" cy="{LY}" r="3.4" fill="${INK.warn}">${loop(b, 'opacity', '1;.3;1', 1)}</circle>`
    : `<circle cx="{LX}" cy="{LY}" r="3.4" fill="${b.status === 'ok' ? INK.ok : INK.bad}"/>`

const plugScene = (b: Box, label: string, title: string, detail: string): string => {
  const cy = b.h / 2
  const plugL = 82
  const sockX = plugL + 27
  const cardX = sockX + 10
  const isDenied = b.status === 'denied'
  const off = isDenied ? -20 : 0
  // The cable runs from a small coral dot (Claude) to the plug.
  const cable = (dx: number): string =>
    `M18 ${f(cy + 18)}C${f(50 + dx / 2)} ${f(cy + 18)} ${f(56 + dx / 2)} ${f(cy)} ${f(plugL + dx)} ${f(cy)}`
  const cablePath = cable(off)
  const cableIntro =
    b.intro && !isDenied
      ? `<animate attributeName="d" values="${cable(-30)};${cable(0)}" dur=".5s" calcMode="spline" keyTimes="0;1" keySplines="${EASE}" fill="freeze"/>`
      : ''
  // While the call runs, little packets travel the cable.
  const flow =
    b.isRunning && b.live
      ? [0, 1]
          .map(i => {
            const begin = ` begin="${t3(0.5 + i * 0.7)}s"`
            return (
              `<circle r="2.6" fill="${INK.text}" opacity="0"><animateMotion path="${cablePath}" dur="1.4s"${begin} repeatCount="indefinite"/>` +
              `<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;.15;.8;1" dur="1.4s"${begin} repeatCount="indefinite"/></circle>`
            )
          })
          .join('')
      : ''
  const plug =
    `<g transform="translate(${f(off)} 0)"><g>${introT(b, 'translate', [[0, '-30 0'], [0.5, '0 0']])}` +
    `<rect x="${f(plugL + 25)}" y="${f(cy - 8)}" width="12" height="3.8" rx="1.2" fill="${INK.textDim}"/>` +
    `<rect x="${f(plugL + 25)}" y="${f(cy + 4.2)}" width="12" height="3.8" rx="1.2" fill="${INK.textDim}"/>` +
    `<rect x="${f(plugL)}" y="${f(cy - 13)}" width="27" height="26" rx="6" fill="${INK.line2}" stroke="${INK.sheetStroke}"/>` +
    `<path d="M${f(plugL + 8)} ${f(cy - 6)}v12M${f(plugL + 14)} ${f(cy - 6)}v12" stroke="${INK.gutter}" stroke-width="1.6" stroke-linecap="round"/></g></g>`
  const socket =
    `<rect x="${f(sockX)}" y="${f(cy - 20)}" width="17" height="40" rx="5" fill="${INK.sheetBar}" stroke="${INK.sheetStroke}"/>` +
    `<rect x="${f(sockX + 5)}" y="${f(cy - 9)}" width="4" height="6" rx="1.2" fill="${INK.term}"/>` +
    `<rect x="${f(sockX + 5)}" y="${f(cy + 3)}" width="4" height="6" rx="1.2" fill="${INK.term}"/>`
  const flash =
    b.intro && !isDenied
      ? `<circle cx="${f(sockX)}" cy="${f(cy)}" r="2" fill="none" stroke="${INK.warn}" stroke-width="1.6" opacity="0">` +
        `${intro(b, 'r', [[0, 2], [0.45, 2], [0.85, 16]], false)}${intro(b, 'opacity', [[0, 0], [0.45, 0], [0.5, 0.9], [0.85, 0]], false)}</circle>`
      : ''
  // error: a spark at the joint; denied: the plug stays out, with a cross over the gap.
  const fault =
    b.status === 'error'
      ? `<path d="M${f(sockX - 5)} ${f(cy - 25)}l5 7-6 2.5 6 7" fill="none" stroke="${INK.bad}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
      : isDenied
        ? `<g transform="translate(${f(sockX - 9)} ${f(cy - 21)})">${mark(false, 0, 0)}</g>`
        : ''
  return (
    `<circle cx="13" cy="${f(cy + 18)}" r="6" fill="${INK.avatar}"/>` +
    `<path d="${cablePath}" fill="none" stroke="${INK.gutter}" stroke-width="3.4" stroke-linecap="round">${cableIntro}</path>` +
    flow +
    toolCard(b, cardX, label, title, detail, statusLed(b)) +
    plug +
    socket +
    flash +
    fault
  )
}

const bookScene = (b: Box, label: string, title: string, detail: string): string => {
  const cy = b.h / 2 + 1
  const bx = 64
  // A page from the spine outwards (side 1 = right, -1 = left), dy shifts it down (the cover).
  const page = (side: 1 | -1, dy: number): string =>
    `M${f(bx)} ${f(cy - 18 + dy)}C${f(bx + side * 11)} ${f(cy - 24 + dy)} ${f(bx + side * 27)} ${f(cy - 24 + dy)} ${f(bx + side * 39)} ${f(cy - 19 + dy)}` +
    `V${f(cy + 21 + dy)}C${f(bx + side * 27)} ${f(cy + 17 + dy)} ${f(bx + side * 11)} ${f(cy + 17 + dy)} ${f(bx)} ${f(cy + 22 + dy)}Z`
  const lines = (side: 1 | -1): string =>
    [0, 1, 2, 3]
      .map(i => {
        const w = [24, 20, 24, 14][i] ?? 18
        const x0 = side === 1 ? bx + 8 : bx - 8 - w
        return `<rect x="${f(x0)}" y="${f(cy - 11 + i * 8)}" width="${w}" height="2.8" rx="1.4" fill="${INK.line2}"/>`
      })
      .join('')
  const sparkle = (x: number, y: number, r: number, begin: number): string =>
    `<path d="M${f(x)} ${f(y - r)}Q${f(x)} ${f(y)} ${f(x + r)} ${f(y)}Q${f(x)} ${f(y)} ${f(x)} ${f(y + r)}Q${f(x)} ${f(y)} ${f(x - r)} ${f(y)}Q${f(x)} ${f(y)} ${f(x)} ${f(y - r)}Z" fill="${INK.match}" opacity="${b.live ? 0 : 0.7}">` +
    `${loop(b, 'opacity', '0;1;0', 1.8, ` begin="${t3(begin)}s"`)}</path>`
  const sparkles = b.isRunning ? sparkle(bx + 33, cy - 30, 4.5, 0) + sparkle(bx + 46, cy - 17, 3, 0.6) + sparkle(bx - 35, cy - 29, 3.5, 1.2) : ''
  const paper = `fill="#1b2a44" stroke="${INK.sheetStroke}" stroke-width="1.2" stroke-linejoin="round"`
  // When fresh the book opens: its right half starts folded over the left (scaleX -1 about the spine)
  // showing the front cover, and swings open; the cover gives way to the page as it passes edge-on.
  const swing = introT(b, 'scale', [[0, '-1 1'], [0.15, '-1 1'], [0.75, '1 1']], false)
  const flip = (from: number): string =>
    b.intro ? `<animate attributeName="opacity" values="${from};${1 - from}" keyTimes="0;.6" calcMode="discrete" dur=".75s" fill="freeze"/>` : ''
  const front = b.intro
    ? `<g opacity="0">${flip(1)}<path d="${page(1, 2)}" fill="${b.color}" stroke="${INK.sheetStroke}" stroke-linejoin="round"/>` +
      `<path d="M${f(bx + 20)} ${f(cy - 6)}l2 4.5 4.5 2-4.5 2-2 4.5-2-4.5-4.5-2 4.5-2z" fill="${INK.match}"/></g>`
    : ''
  return (
    `<path d="${page(-1, 3)}" fill="${b.color}" fill-opacity=".5"/>` +
    `<path d="${page(-1, 0)}" ${paper}/>` +
    `<g>${fadeIn(b, 0.7)}${lines(-1)}</g>` +
    `<g transform="translate(${f(bx)} 0)"><g>${swing}<g transform="translate(${f(-bx)} 0)">` +
    `<path d="${page(1, 3)}" fill="${b.color}" fill-opacity=".5"/><path d="${page(1, 0)}" ${paper}>${flip(0)}</path>${front}</g></g></g>` +
    `<g>${fadeIn(b, 0.8)}${lines(1)}</g>` +
    `<path d="M${f(bx)} ${f(cy - 18)}V${f(cy + 22)}" stroke="${INK.sheetStroke}" stroke-width="1.4"/>` +
    // a ribbon bookmark hanging from the spine
    `<path d="M${f(bx + 2)} ${f(cy - 19)}h4.5v${f(46)}l-2.25-3-2.25 3z" fill="${INK.warn}">${fadeIn(b, 0.75, 0.3)}</path>` +
    sparkles +
    toolCard(b, bx + 60, label, title, detail, statusLed(b))
  )
}

const toolsScene = (s: Of<'tools'>, b: Box): string => {
  const rawName = plain(s?.name, 300)
  let name = rawName
  let server = plain(s?.server, 200)
  let detail = plain(s?.detail, 500)
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  if (mcp !== null) {
    if (server === '') server = mcp[1] ?? ''
    name = mcp[2] ?? name
  }
  if (looksLikeSkill(rawName, server)) {
    // 'Skill' carries the skill's name in its detail; 'plugin:skill' names its plugin.
    let title = name
    if (/^skills?$/i.test(title) && detail !== '') {
      title = detail
      detail = ''
    }
    let label = 'SKILL'
    const k = title.indexOf(':')
    if (k > 0 && k < title.length - 1) {
      label = `SKILL · ${title.slice(0, k)}`
      title = title.slice(k + 1)
    }
    return bookScene(b, label, title || 'Skill', detail)
  }
  const label = server === '' ? 'TOOL' : `MCP · ${server}`
  return plugScene(b, label, name || 'Tool', detail)
}

// ---------------------------------------------------------------- think

// The thought cloud: circles (dx, dy, r) around its centre, drawn as one outlined shape.
const CLOUD: readonly (readonly [number, number, number])[] = [
  [-27, 5, 14],
  [-13, -8, 16],
  [7, -11, 16],
  [25, -3, 14],
  [18, 9, 13],
  [-4, 10, 14],
  [0, 0, 18],
]

/** A cloud outline: the union of the circles grown by the stroke width, then the circles on top. */
const cloud = (cx: number, cy: number, k: number, stroke: string, fill: string): string => {
  const at = (grow: number): string =>
    CLOUD.map(([dx, dy, r]) => `<circle cx="${f(cx + dx * k)}" cy="${f(cy + dy * k)}" r="${f(r * k + grow)}"/>`).join('')
  return `<g fill="${stroke}" opacity=".7">${at(1.4)}</g><g fill="${fill}">${at(0)}</g>`
}

const thinkScene = (s: Of<'think'>, b: Box): string => {
  const text = plain(s?.text, 700)
  const k = clamp((b.h - 22) / 62, 0.6, 1.15)
  const cx = 74
  const cy = b.h / 2 - 5 * k
  const trail =
    `<circle cx="${f(cx - 38 * k)}" cy="${f(cy + 27 * k)}" r="${f(4.6 * k)}" fill="${INK.sheet}" stroke="${b.color}" stroke-opacity=".7" stroke-width="1.3"/>` +
    `<circle cx="${f(cx - 48 * k)}" cy="${f(cy + 35 * k)}" r="${f(2.8 * k)}" fill="${INK.sheet}" stroke="${b.color}" stroke-opacity=".7" stroke-width="1.2"/>`
  const pop = introT(b, 'scale', [[0, '.85 .85'], [0.35, '1 1']])
  const tx = cx + 56 * k + 18
  const maxW = Math.max(60, b.w - tx - 8)
  const font: Font = { size: 13 }
  const lines = text === '' ? [] : wrap(text, maxW, font, 2)
  const lineH = 18
  const ty = b.h / 2 - ((Math.max(1, lines.length) - 1) * lineH) / 2 + 4.5
  const words =
    lines.length === 0
      ? txt(tx, ty, 13, INK.textDim, b.isRunning ? 'Working out what to do next…' : 'Thought it through', ' font-style="italic"')
      : lines.map((l, i) => txt(tx, ty + i * lineH, 13, INK.textSoft, esc(l), ' font-style="italic"')).join('')
  return (
    `<g>${fadeIn(b, 0, 0.3)}${trail}<g transform="translate(${f(cx)} ${f(cy)})"><g>${pop}<g transform="translate(${f(-cx)} ${f(-cy)})">` +
    `${cloud(cx, cy, k, b.color, INK.sheet)}${dots(b, cx - 12 * k, cy + 1, 3.3 * k, 12 * k, b.color, b.isRunning)}</g></g></g></g>` +
    `<g>${fadeIn(b, 0.3, 0.6)}${words}</g>`
  )
}

// ---------------------------------------------------------------- talk

const talkScene = (s: Of<'talk'>, b: Box): string => {
  const text = plain(s?.text, 900)
  const k = clamp((b.h - 20) / 64, 0.7, 1.15)
  const bw = 112 * k
  const bh = 50 * k
  const bx = 10
  const by = b.h / 2 - bh / 2 - 5 * k
  // Three lines of "writing" in the bubble; their widths come from the text so redraws are stable.
  const r = rand(hash(text) || 7)
  const innerW = bw - 26 * k
  const bars = [0, 1, 2]
    .map(i => {
      const w = innerW * (i === 2 ? 0.35 + r() * 0.25 : 0.72 + r() * 0.28)
      const y = by + 13 * k + i * 10 * k
      const x = bx + 13 * k
      let grow = ''
      if (b.isRunning && b.live) {
        const s0 = 0.08 + i * 0.22
        grow = loop(b, 'width', `0;0;${f(w)};${f(w)};0`, 3.2, ` keyTimes="0;${t3(s0)};${t3(s0 + 0.18)};.88;1"`)
      } else if (b.intro) {
        grow = intro(b, 'width', [[0, 0], [0.15 + i * 0.3, 0], [0.45 + i * 0.3, w]])
      }
      return `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(4 * k)}" rx="${f(2 * k)}" fill="${b.color}" fill-opacity="${t3(0.85 - i * 0.12)}">${grow}</rect>`
    })
    .join('')
  const tx = bx + bw + 22
  const maxW = Math.max(60, b.w - tx - 8)
  const font: Font = { size: 13 }
  const maxLines = b.h >= 76 ? 3 : 2
  // Quoted as Claude's words; room is kept for the closing quote, so it survives a cut.
  const lines = text === '' ? [] : wrap(`“${text}`, maxW - measure('”', font), font, maxLines)
  if (lines.length > 0) lines[lines.length - 1] += '”'
  const lineH = 18
  const ty = b.h / 2 - ((Math.max(1, lines.length) - 1) * lineH) / 2 + 4.5
  const words =
    lines.length === 0
      ? txt(tx, ty, 13, INK.textDim, b.isRunning ? 'Writing the answer…' : 'Answered', ' font-style="italic"')
      : lines.map((l, i) => `<g>${fadeIn(b, 0.2 + i * 0.3, 0.4)}${txt(tx, ty + i * lineH, 13, INK.text, esc(l))}</g>`).join('')
  return (
    `<g>${fadeIn(b, 0, 0.3)}<path d="${bubbleDown(bx, by, bw, bh, 12 * k)}" fill="${INK.sheet}" stroke="${b.color}" stroke-opacity=".6" stroke-width="1.4"/>${bars}</g>` +
    words
  )
}

// ---------------------------------------------------------------- done

const CONFETTI: readonly string[] = [COLOR.think, COLOR.plan, COLOR.search, COLOR.edit, COLOR.run, COLOR.delegate, COLOR.web, INK.avatar]

/** A one-shot burst of confetti from (cx, cy); nothing at all unless the step is fresh. Each piece
 *  flies a curved path (turning with it, rotate="auto"), and the whole burst fades out together. */
const confetti = (b: Box, cx: number, cy: number, seed: number): string => {
  if (!b.intro) return ''
  const r = rand(seed)
  const N = 14
  const DUR = 1.4
  let pieces = ''
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + (r() - 0.5) * 0.6
    const dist = 26 + r() * 26
    const fall = 10 + r() * 12
    const dx = clamp(Math.cos(a) * dist * 1.7, 6 - cx, b.w - cx - 6)
    const dy = clamp(Math.sin(a) * dist * 0.8 - 8, 6 - cy, b.h - cy - 6 - fall)
    const color = CONFETTI[i % CONFETTI.length] ?? INK.warn
    const isDot = i % 3 === 0
    const path = `M0 0Q${f(dx * 0.6)} ${f(dy - 16)} ${f(dx)} ${f(dy + fall)}`
    pieces +=
      (isDot ? `<circle r="2.2" fill="${color}">` : `<rect x="-1.5" y="-3" width="3" height="6" rx="1" fill="${color}">`) +
      `<animateMotion path="${path}" dur="${t3(DUR * (0.75 + r() * 0.3))}s" rotate="auto" calcMode="spline" keyPoints="0;1" keyTimes="0;1" keySplines=".2 .6 .35 1" fill="freeze"/>` +
      (isDot ? '</circle>' : '</rect>')
  }
  return `<g transform="translate(${f(cx)} ${f(cy)})" opacity="0">${intro(b, 'opacity', [[0, 1], [DUR * 0.6, 1], [DUR, 0]], false)}${pieces}</g>`
}

const duration = (sec: number): string => {
  const s = Math.max(0, Math.round(sec))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

const doneScene = (s: Of<'done'>, b: Box): string => {
  const steps = count(s?.steps)
  const files = count(s?.files)
  const seconds = count(s?.seconds, 359999)
  const errors = count(s?.errors)
  const cy = b.h / 2
  const R = clamp(b.h / 2 - 13, 14, 25)
  const cx = 14 + R
  const C = 2 * Math.PI * R
  // A turn that ended early (an error or a refusal: 'error'; the person stopped it: 'denied') is no
  // celebration: a red cross or an amber stop sign, no confetti, and 'Stopped' instead of 'All done'.
  const stopped = b.status === 'error' || b.status === 'denied'
  const ink = !stopped ? INK.ok : b.status === 'error' ? INK.bad : INK.warn
  const glyph = !stopped
    ? `M${f(cx - R * 0.42)} ${f(cy + R * 0.02)}l${f(R * 0.29)} ${f(R * 0.29)} ${f(R * 0.55)}-${f(R * 0.6)}`
    : b.status === 'error'
      ? `M${f(cx - R * 0.32)} ${f(cy - R * 0.32)}L${f(cx + R * 0.32)} ${f(cy + R * 0.32)}M${f(cx + R * 0.32)} ${f(cy - R * 0.32)}L${f(cx - R * 0.32)} ${f(cy + R * 0.32)}`
      : `M${f(cx - R * 0.3)} ${f(cy - R * 0.3)}H${f(cx + R * 0.3)}V${f(cy + R * 0.3)}H${f(cx - R * 0.3)}Z`
  const L = !stopped ? R * 1.25 : R * 2.4
  const circle =
    `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(R)}" fill="${ink}" fill-opacity=".12" stroke="${ink}" stroke-width="2.6"` +
    (b.intro ? ` stroke-dasharray="${f(C + 1)}" transform="rotate(-90 ${f(cx)} ${f(cy)})"` : '') +
    `>${intro(b, 'stroke-dashoffset', [[0, C + 1], [0.6, 0]])}${intro(b, 'fill-opacity', [[0, 0], [0.45, 0], [0.8, 0.12]])}</circle>` +
    `<path d="${glyph}" fill="${b.status === 'denied' ? ink : 'none'}" fill-opacity=".85" stroke="${ink}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"` +
    (b.intro ? ` stroke-dasharray="${f(L + 1)}"` : '') +
    `>${intro(b, 'stroke-dashoffset', [[0, L + 1], [0.45, L + 1], [0.8, 0]])}</path>`

  // Title, then the summary chips: steps · files · time · errors.
  const tx = cx + R + 22
  const chipsY = cy + 4
  const chips: { text: string; stroke: string; fill: string }[] = [
    { text: plural(steps, 'step', 'steps'), stroke: INK.sheetStroke, fill: INK.textSoft },
    { text: plural(files, 'file', 'files'), stroke: INK.sheetStroke, fill: INK.textSoft },
    { text: duration(seconds), stroke: INK.sheetStroke, fill: INK.textSoft },
    errors > 0
      ? { text: plural(errors, 'error', 'errors'), stroke: INK.bad, fill: INK.badSoft }
      : { text: 'no errors', stroke: INK.ok, fill: INK.ok },
  ]
  const chipFont: Font = { size: 11.5 }
  let x = tx
  const chipSvg = chips
    .map((c, i) => {
      const w = measure(c.text, chipFont) + 20
      if (x + w > b.w - 4) return ''
      const at = x
      x += w + 7
      const delay = 0.45 + i * 0.1
      return (
        `<g>${intro(b, 'opacity', [[0, 0], [delay, 0], [delay + 0.3, 1]])}<g>${introT(b, 'translate', [[0, '0 5'], [delay, '0 5'], [delay + 0.35, '0 0']])}` +
        `<rect x="${f(at)}" y="${f(chipsY)}" width="${f(w)}" height="22" rx="11" fill="${INK.sheet}" stroke="${c.stroke}" stroke-opacity="${c.stroke === INK.sheetStroke ? 1 : 0.55}"/>` +
        `${txt(at + 10, chipsY + 15, 11.5, c.fill, esc(c.text))}</g></g>`
      )
    })
    .join('')
  const head = stopped ? 'Stopped' : 'All done'
  const sub = !stopped ? 'Claude finished this turn' : b.status === 'error' ? 'The turn ended early' : 'Interrupted before it finished'
  const subX = tx + measure(head, { size: 16, bold: true }) + 10
  const title = `<g>${fadeIn(b, 0.3)}${txt(tx, cy - 9, 16, INK.text, head, ' font-weight="700"')}${txt(subX, cy - 9, 11.5, INK.textDim, esc(fit(sub, Math.max(0, b.w - subX - 8), { size: 11.5 })))}</g>`
  return (stopped ? '' : confetti(b, cx, cy, hash(`${steps}|${files}|${seconds}|${errors}`))) + circle + title + chipSvg
}

// ---------------------------------------------------------------- idle

const idleScene = (b: Box): string => {
  const cy = b.h / 2
  const title = 'Waiting for the next task'
  const hint = 'Each step Claude takes will be explained here'
  const ART = 84
  const tw = Math.max(measure(title, { size: 14 }), measure(hint, { size: 11 }))
  const x0 = Math.max(6, (b.w - ART - tw) / 2)
  // A crescent moon (outer radius 15, bitten by a circle of 12.75) with a slow glow behind it.
  const mx = x0 + 20
  const my = cy + 9
  const glow = `<circle cx="${f(mx + 2)}" cy="${f(my - 2)}" r="22" fill="${b.color}" opacity=".14">${loop(b, 'opacity', '.08;.2;.08', 5)}</circle>`
  const moon = `<path d="M${f(mx - 1.3)} ${f(my - 14.9)}A15 15 0 1 0 ${f(mx + 14)} ${f(my + 5.4)}A12.75 12.75 0 1 1 ${f(mx - 1.3)} ${f(my - 14.9)}Z" fill="${INK.textSoft}" fill-opacity=".8"/>`
  // Three z's drifting up and growing; static (three sizes up a slope) while paused.
  const zx = x0 + 38
  const zy = cy - 6
  const z = `<text y="5" text-anchor="middle" font-size="14" font-weight="700" fill="${INK.textDim}">z</text>`
  const zs = b.live
    ? [0, 1, 2]
        .map(i => {
          const begin = i === 0 ? '' : ` begin="-${t3(i * 1.5)}s"`
          return (
            `<g opacity="0">${loopT(b, 'translate', `${f(zx)} ${f(zy + 8)};${f(zx + 11)} ${f(zy - 6)};${f(zx + 22)} ${f(zy - 22)}`, 4.5, begin)}` +
            `${loop(b, 'opacity', '0;.95;.95;0', 4.5, ` keyTimes="0;.2;.7;1"${begin}`)}` +
            `<g>${loopT(b, 'scale', '.7;1;1.35', 4.5, begin)}${z}</g></g>`
          )
        })
        .join('')
    : (
        [
          [0, 8, 0.7, 0.5],
          [11, -6, 1, 0.7],
          [22, -21, 1.3, 0.9],
        ] as const
      )
        .map(([dx, dy, sc, op]) => `<g transform="translate(${f(zx + dx)} ${f(zy + dy)}) scale(${t3(sc)})" opacity="${t3(op)}">${z}</g>`)
        .join('')
  const tx = x0 + ART
  return (
    glow +
    moon +
    zs +
    txt(tx, cy - 1, 14, INK.textSoft, esc(fit(title, b.w - tx - 6, { size: 14 }))) +
    txt(tx, cy + 17, 11, INK.textDim, esc(fit(hint, b.w - tx - 6, { size: 11 })))
  )
}

// ---------------------------------------------------------------- the scenes

export const scenePlan = (s: Of<'plan'>, ctx: SceneCtx): string => scene(ctx, b => planScene(s, b))
export const sceneAsk = (s: Of<'ask'>, ctx: SceneCtx): string => scene(ctx, b => askScene(s, b))
export const sceneTools = (s: Of<'tools'>, ctx: SceneCtx): string => scene(ctx, b => toolsScene(s, b))
export const sceneThink = (s: Of<'think'>, ctx: SceneCtx): string => scene(ctx, b => thinkScene(s, b))
export const sceneTalk = (s: Of<'talk'>, ctx: SceneCtx): string => scene(ctx, b => talkScene(s, b))
export const sceneDone = (s: Of<'done'>, ctx: SceneCtx): string => scene(ctx, b => doneScene(s, b))
export const sceneIdle = (s: Of<'idle'>, ctx: SceneCtx): string => scene(ctx, b => idleScene(b))
