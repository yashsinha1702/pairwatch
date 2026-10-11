// Scenes for the doing stations: run, read, search, edit, web, delegate.
// Each returns an SVG fragment drawn inside ctx's box. Never throws.
//
// Conventions: intro animations (typing, sliding in) only when ctx.isFresh; loops only while the step
// runs; nothing animated at all when ctx.isPaused. Every user string goes through t()/tl() (cut + escaped).
// Designed for the stage's box (592 x 90) but positioned from ctx, so the box can move.
import type { BashCategory, SceneData, StepStatus } from '../../../types'
import { INK, MONO, SANS, clip, clipLeft, esc, hash, rand, statusMark, type SceneCtx } from './kit.ts'

type Of<K extends SceneData['kind']> = Extract<SceneData, { kind: K }>
type Box = { x: number; y: number; w: number; h: number }

// ------------------------------------------------------------------ text and number helpers
// (exported for stage.ts, which draws with the same rules)

/** A coordinate as short, stable text (one decimal, no -0, no NaN). */
export const f = (v: number): string => {
  if (!Number.isFinite(v)) return '0'
  const r = Math.round(v * 10) / 10
  return r === 0 ? '0' : String(r)
}
/** Lone surrogates and the two non-characters: not allowed in an XML document. */
const BAD_UNITS = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]|[\ufffe\uffff]/g
/** A string from anything (numbers allowed; everything else is empty). */
export const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '')
/** One line: tabs, newlines and the Unicode line separators become spaces. */
export const flat = (s: string): string => s.replace(/[\t\r\n\u000b\u000c\u0085\u2028\u2029]+/g, ' ')
/** Proportional (sans) text cut to n chars with an ellipsis, then escaped. */
export const t = (v: unknown, n: number): string => esc(clip(flat(str(v).slice(0, 4000)), Math.max(1, n)).replace(BAD_UNITS, ''))

// Monospace text is measured in columns: East Asian wide characters and emoji take two, marks none.
const ZERO_W = /[\u0300-\u036f\u200b-\u200f\u20d0-\u20ff\ufe00-\ufe0f]/
const WIDE = /[\u1100-\u115f\u231a\u231b\u23e9-\u23f3\u2614\u2615\u26a1\u26aa\u26ab\u26bd\u26be\u26c4\u26c5\u26d4\u26ea\u26f2-\u26fd\u2705\u270a\u270b\u2728\u274c\u274e\u2753-\u2757\u2795-\u2797\u2b1b\u2b1c\u2b50\u2b55\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\ud800-\udbff][\udc00-\udfff]/
const colsOf = (ch: string): number => (ZERO_W.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1)
/** Display columns of monospace text. */
export const cols = (s: string): number => {
  let n = 0
  for (const ch of s) n += colsOf(ch)
  return n
}
/** Cut to n columns, keeping the head (or the tail, for paths), with an ellipsis. Not escaped. */
export const clipCols = (s: string, n: number, keepTail = false): string => {
  const max = Math.max(1, n)
  const chars = Array.from(flat(s.length > 8000 ? (keepTail ? s.slice(-8000) : s.slice(0, 8000)) : s))
  let total = 0
  for (const ch of chars) total += colsOf(ch)
  if (total <= max) return chars.join('')
  const kept: string[] = []
  let used = 0
  const order = keepTail ? [...chars].reverse() : chars
  for (const ch of order) {
    const c = colsOf(ch)
    if (used + c > max - 1) break
    kept.push(ch)
    used += c
  }
  return keepTail ? '…' + kept.reverse().join('') : kept.join('') + '…'
}
/** Monospace text cut to n columns, escaped. */
export const tm = (v: unknown, n: number): string => esc(clipCols(str(v), n).replace(BAD_UNITS, ''))
/** Monospace text cut from the left (keeps a path's tail), escaped. */
export const tl = (v: unknown, n: number): string => esc(clipCols(str(v), n, true).replace(BAD_UNITS, ''))
/** Monospace columns that fit in px at a font size. */
export const fit = (px: number, size: number): number => Math.max(1, Math.floor(px / (size * 0.6 + 0.03)))
const nonNeg = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null)
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
/** 1234 -> '1234', 12345 -> '12.3k', 4.2e6 -> '4.2M' (keeps badges, chips and stats short). */
export const compact = (v: number): string => {
  if (!Number.isFinite(v)) return '0'
  const a = Math.abs(v)
  const one = (x: number, u: string) => (x >= 100 ? String(Math.round(x)) : String(Math.round(x * 10) / 10)) + u
  return a < 10000 ? String(Math.round(v)) : a < 1e6 ? one(v / 1e3, 'k') : a < 1e9 ? one(v / 1e6, 'M') : a < 1e12 ? one(v / 1e9, 'B') : '1T+'
}
/** A generous estimate of proportional (sans) text width: digits and capitals are wide, spaces narrow. */
export const sansWidth = (s: string, size: number): number => {
  let em = 0
  for (const ch of s) em += /[0-9]/.test(ch) ? 0.64 : /[A-Z]/.test(ch) ? 0.7 : /[\s.,:;·'|!il]/.test(ch) ? 0.33 : WIDE.test(ch) ? 1 : 0.55
  return em * size
}
const baseName = (p: string): string => {
  const s = p.replace(/[\\/]+$/, '')
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return i >= 0 ? s.slice(i + 1) : s
}
const dirName = (p: string): string => {
  const s = p.replace(/[\\/]+$/, '')
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return i > 0 ? s.slice(0, i + 1) : ''
}
const STATUSES: readonly StepStatus[] = ['running', 'ok', 'error', 'denied']
const asStatus = (v: unknown): StepStatus => ((STATUSES as readonly unknown[]).includes(v) ? (v as StepStatus) : 'running')
const isBad = (s: StepStatus): boolean => s === 'error' || s === 'denied'

const mono = (size: number): string => `font-family="${MONO}" font-size="${size}"`
const sans = (size: number): string => `font-family="${SANS}" font-size="${size}"`

/** Intro animations play. */
const intro = (ctx: SceneCtx): boolean => ctx.isFresh && !ctx.isPaused
/** Loops play (the step is still running and the stage is not paused). */
const live = (ctx: SceneCtx): boolean => ctx.status === 'running' && !ctx.isPaused
const loopA = (ctx: SceneCtx, attrs: string): string => (live(ctx) ? `<animate ${attrs} repeatCount="indefinite"/>` : '')
const animT = (ctx: SceneCtx, attrs: string): string => (ctx.isPaused ? '' : `<animateTransform ${attrs}/>`)
const animM = (ctx: SceneCtx, attrs: string): string => (ctx.isPaused ? '' : `<animateMotion ${attrs}/>`)
const setA = (ctx: SceneCtx, attrs: string): string => (ctx.isPaused ? '' : `<set ${attrs}/>`)

/** Fade a group in at `begin` seconds (fresh only). */
const fadeIn = (ctx: SceneCtx, begin: number, body: string, dur = 0.3): string =>
  intro(ctx)
    ? `<g opacity="0"><animate attributeName="opacity" from="0" to="1" begin="${f(begin)}s" dur="${f(dur)}s" fill="freeze"/>${body}</g>`
    : body
/** Slide a group in from (dx, dy) while fading in (fresh only). */
const slideIn = (ctx: SceneCtx, begin: number, dx: number, dy: number, body: string, dur = 0.35): string =>
  intro(ctx)
    ? `<g opacity="0"><animate attributeName="opacity" from="0" to="1" begin="${f(begin)}s" dur="${f(dur)}s" fill="freeze"/>` +
      `<animateTransform attributeName="transform" type="translate" from="${f(dx)} ${f(dy)}" to="0 0" begin="${f(begin)}s" dur="${f(dur)}s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines=".2 .7 .3 1"/>${body}</g>`
    : body

/** Three pulsing dots (static and dim when not live). */
const dots = (ctx: SceneCtx, x: number, y: number, color: string): string =>
  [0, 1, 2]
    .map(
      i =>
        `<circle cx="${f(x + i * 8)}" cy="${f(y)}" r="2.4" fill="${color}"${live(ctx) ? '' : ` fill-opacity="${i === 0 ? 1 : i === 1 ? 0.6 : 0.3}"`}>` +
        loopA(ctx, `attributeName="opacity" values=".2;1;.2" dur="1.2s" begin="${f(i * 0.2)}s"`) +
        '</circle>',
    )
    .join('')

/** A rounded chip with centred monospace text. Returns its width so callers can lay chips out. */
const chip = (x: number, y: number, label: string, color: string, size = 10.5): { svg: string; w: number } => {
  const w = label.length * size * 0.62 + 14
  return {
    w,
    svg:
      `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="16" rx="8" fill="${color}" fill-opacity=".14" stroke="${color}" stroke-opacity=".5"/>` +
      `<text x="${f(x + w / 2)}" y="${f(y + 11.6)}" text-anchor="middle" ${mono(size)} font-weight="700" fill="${color}">${esc(label)}</text>`,
  }
}

/** The status words at the end of a scene. */
const overWord = (status: StepStatus, ok: string, bad: string): { text: string; color: string } =>
  status === 'ok'
    ? { text: '✓ ' + ok, color: INK.ok }
    : status === 'denied'
      ? { text: '✗ not allowed', color: INK.bad }
      : { text: '✗ ' + bad, color: INK.bad }

/** A tiny copy of the avatar centred on (0,0), radius r. */
const miniAvatar = (r: number, eyes = true): string => {
  const k = r / 10
  return (
    `<circle r="${f(r)}" fill="${INK.avatar}"/>` +
    `<circle cx="${f(-3 * k)}" cy="${f(-3.4 * k)}" r="${f(3.6 * k)}" fill="#fff" fill-opacity=".18"/>` +
    (eyes
      ? `<g fill="#fff"><ellipse cx="${f(-3.5 * k)}" cy="${f(-1 * k)}" rx="${f(2.1 * k)}" ry="${f(2.6 * k)}"/><ellipse cx="${f(3.5 * k)}" cy="${f(-1 * k)}" rx="${f(2.1 * k)}" ry="${f(2.6 * k)}"/></g>` +
        `<g fill="#1d2433"><circle cx="${f(-3 * k)}" cy="${f(-0.6 * k)}" r="${f(1.1 * k)}"/><circle cx="${f(4 * k)}" cy="${f(-0.6 * k)}" r="${f(1.1 * k)}"/></g>`
      : '')
  )
}

/** A file tab on top of a sheet (x, y = the sheet's top-left). Returns the tab's path + label. */
const sheetTab = (x: number, y: number, label: string, color: string, maxW: number): string => {
  const room = fit(maxW - 20, 10.5)
  const name = tm(label || 'file', room)
  const w = Math.min(maxW, cols(clipCols(label || 'file', room)) * 6.33 + 20)
  return (
    `<path d="M${f(x)} ${f(y + 1)}V${f(y - 10)}q0-4 4-4H${f(x + w - 4)}q4 0 4 4V${f(y + 1)}" fill="${INK.sheetBar}" stroke="${INK.sheetStroke}"/>` +
    `<text x="${f(x + 10)}" y="${f(y - 3)}" ${mono(10.5)} fill="${color}">${name}</text>`
  )
}

// ------------------------------------------------------------------ run

/** Pick the most telling line of a result: an error line on failure, a summary line on success. */
const pickLine = (out: unknown, bad: boolean): string => {
  const lines = str(out)
    .slice(0, 4000)
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l !== '' && !/^[-=_*#~.\s]+$/.test(l))
  if (lines.length === 0) return ''
  const rev = [...lines].reverse()
  if (bad)
    return (
      rev.find(l => /\b[A-Z][A-Za-z]*(Error|Exception)\b|^HTTP\/[\d.]+\s+[45]\d\d|\bFAILED\b|\bfatal:|\berror(\[\w+\])?:|\bERROR\b|panic:|No such file|not found|Permission denied|refused|timed? ?out/.test(l)) ??
      rev.find(l => /error|fail|exception|fatal|denied|cannot|invalid/i.test(l)) ??
      rev[0] ??
      ''
    )
  return rev.find(l => /\b(passed|ok|done|success(fully)?|installed|built|compiled|finished|complete[d]?|added|up to date|wrote|saved|ready)\b/i.test(l)) ?? lines[0] ?? ''
}

const exitCode = (out: string): number | null => {
  const m = /exit(?:ed)?(?:\s+with)?(?:\s+(?:code|status))?[\s:=]+(-?\d{1,3})\b/i.exec(out)
  return m ? Number(m[1]) : null
}

/** Words after the program that are not flags (for captions like 'git commit'). */
const subcommand = (cmd: string, prog: RegExp, take: number): string => {
  const words = cmd.slice(0, 600).split(/\s+/).filter(Boolean)
  const i = words.findIndex(w => prog.test(w.replace(/^.*\//, '')))
  if (i < 0) return ''
  const out: string[] = []
  for (let j = i + 1; j < words.length && out.length < take; j++) {
    const w = words[j] ?? ''
    if (w.startsWith('-')) {
      if (/^-[Cc]$/.test(w)) j++
      continue
    }
    if (/^[|&;<>]/.test(w)) break
    out.push(w)
  }
  return out.join(' ')
}

type Widget = (s: Of<'run'>, ctx: SceneCtx, b: Box & { cx: number; cy: number }) => { svg: string; caption: string }

const WIDGETS: Partial<Record<BashCategory, Widget>> = {
  // ✓ / ✗ tally: a grid of test dots that light up while the suite runs, then the counts.
  test: (s, ctx, b) => {
    const out = str(s.output).slice(0, 4000)
    const pm = /(\d+)\s+(?:tests?\s+)?(?:passed|passing)\b/i.exec(out)
    const fm = /(\d+)\s+(?:tests?\s+)?(?:failed|failing|failures?|errors?)\b/i.exec(out)
    const passed = pm ? Number(pm[1]) : null
    const failed = fm ? Number(fm[1]) : null
    const N = 12
    const perRow = 6
    const size = 10
    const gap = 4
    const gx = b.cx - (perRow * size + (perRow - 1) * gap) / 2
    const gy = b.y + 6
    const r = rand(hash(str(s.command)) + 7)
    const reds = new Set<number>()
    if (ctx.status === 'error') {
      const k = passed !== null && failed !== null && passed + failed > 0 ? clamp(Math.round((N * failed) / (passed + failed)), 1, N) : 2
      for (let guard = 0; reds.size < k && guard < 400; guard++) reds.add(Math.floor(r() * N))
    }
    let svg = ''
    for (let i = 0; i < N; i++) {
      const x = gx + (i % perRow) * (size + gap)
      const y = gy + Math.floor(i / perRow) * (size + gap)
      svg += `<rect x="${f(x)}" y="${f(y)}" width="${size}" height="${size}" rx="2.5" fill="#1e293b"/>`
      if (ctx.status === 'running') {
        if (live(ctx)) {
          const a = (i / N) * 0.8 + 0.02
          svg += `<rect x="${f(x)}" y="${f(y)}" width="${size}" height="${size}" rx="2.5" fill="${INK.ok}" opacity="0"><animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;${f(a)};${f(a + 0.04)};.94;1" dur="3s" repeatCount="indefinite"/></rect>`
        }
      } else if (ctx.status !== 'denied') {
        const bad = reds.has(i)
        svg += fadeIn(ctx, 0.5 + i * 0.04, `<rect x="${f(x)}" y="${f(y)}" width="${size}" height="${size}" rx="2.5" fill="${bad ? INK.bad : INK.ok}" fill-opacity="${bad ? 1 : 0.85}"/>`, 0.15)
      }
    }
    const chips: { label: string; color: string }[] = []
    if (ctx.status === 'running') chips.push({ label: 'running', color: INK.textDim })
    else if (ctx.status === 'denied') chips.push({ label: 'not run', color: INK.textDim })
    else {
      if (passed !== null) chips.push({ label: `✓ ${compact(passed)}`, color: INK.ok })
      if (failed !== null && (failed > 0 || ctx.status === 'error')) chips.push({ label: `✗ ${compact(failed)}`, color: INK.bad })
      if (chips.length === 0) chips.push(ctx.status === 'ok' ? { label: '✓ passed', color: INK.ok } : { label: '✗ failed', color: INK.bad })
    }
    const ws = chips.map(c => c.label.length * 10.5 * 0.62 + 14)
    let x = b.cx - (ws.reduce((a, w) => a + w, 0) + (ws.length - 1) * 6) / 2
    chips.forEach((c, i) => {
      svg += fadeIn(ctx, 1, chip(x, gy + 2 * size + gap + 9, c.label, c.color).svg)
      x += (ws[i] ?? 0) + 6
    })
    return { svg, caption: 'tests' }
  },

  // Package boxes dropping into a crate.
  install: (s, ctx, b) => {
    const cmd = flat(str(s.command).slice(0, 600))
    const ox = b.cx
    const oy = b.cy + 4
    const colors = ['#60a5fa', '#34d399', '#f472b6']
    const rest = [
      [-15, -4],
      [-1, -7],
      [13, -4],
    ] as const
    let pk = ''
    rest.forEach(([px, py], i) => {
      const stuck = ctx.status === 'error' && i === 2
      const body =
        `<rect x="${f(-6)}" y="${f(-6)}" width="12" height="12" rx="2" fill="${colors[i]}"/>` +
        `<path d="M0-6v12M-6-1h12" stroke="#0b1220" stroke-opacity=".45" stroke-width="1.4"/>`
      if (live(ctx)) {
        const begin = i * 0.55
        pk +=
          `<g transform="translate(${f(ox + px)} ${f(oy + py)})"><g opacity="0">` +
          `<animateTransform attributeName="transform" type="translate" values="0 -44;0 0;0 0;0 0" keyTimes="0;.28;.9;1" dur="2.4s" begin="${f(begin)}s" repeatCount="indefinite" calcMode="spline" keySplines=".5 0 .9 .6;0 0 1 1;0 0 1 1"/>` +
          `<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;.08;.9;1" dur="2.4s" begin="${f(begin)}s" repeatCount="indefinite"/>${body}</g></g>`
      } else if (ctx.status !== 'running' || ctx.isPaused) {
        const y = stuck ? py - 22 : py
        const g = `<g transform="translate(${f(ox + px)} ${f(oy + y)})">${body}${stuck ? `<path d="M9-12l6 6M15-12l-6 6" stroke="${INK.bad}" stroke-width="1.8" stroke-linecap="round"/>` : ''}</g>`
        pk += intro(ctx) ? slideIn(ctx, 0.3 + i * 0.18, 0, -30, g, 0.4) : g
      }
    })
    const crate =
      `<path d="M${f(ox - 25)} ${f(oy)}l-9-8h24l9 8zM${f(ox + 25)} ${f(oy)}l9-8h-24l-9 8z" fill="#5c4326" stroke="#a16207" stroke-linejoin="round"/>` +
      `<rect x="${f(ox - 25)}" y="${f(oy)}" width="50" height="22" rx="2" fill="#4a3520" stroke="#a16207"/>` +
      `<path d="M${f(ox - 25)} ${f(oy + 7)}h50" stroke="#a16207" stroke-opacity=".5"/>`
    const after = (/\b(?:install|add)\s+(.*)$/i.exec(cmd)?.[1] ?? '').split(/\s+/)
    const stop = after.findIndex(w => /^[|&;<>]/.test(w))
    const names = (stop < 0 ? after : after.slice(0, stop)).filter(w => w && !w.startsWith('-')).slice(0, 2)
    const caption = /\b(venv|virtualenv)\b/.test(cmd) ? 'new virtual env' : names.length ? names.join(', ') : 'packages'
    return { svg: pk + crate, caption }
  },

  // A tiny branch graph; the newest commit pops in and pulses.
  git: (s, ctx, b) => {
    const cmd = flat(str(s.command).slice(0, 600))
    const isGh = /(^|\s|\/)gh\s/.test(cmd + ' ') && !/(^|\s|\/)git\s/.test(cmd + ' ')
    const sub = isGh ? subcommand(cmd, /^gh$/, 2) : subcommand(cmd, /^git$/, 1)
    const ox = b.cx
    const oy = b.cy + 2
    const head = ctx.status === 'error' || ctx.status === 'denied' ? INK.bad : ctx.color
    let svg =
      `<path d="M${f(ox - 52)} ${f(oy + 10)}H${f(ox + 50)}" stroke="#64748b" stroke-width="2"/>` +
      `<path d="M${f(ox - 22)} ${f(oy + 10)}C${f(ox - 8)} ${f(oy + 10)} ${f(ox - 10)} ${f(oy - 10)} ${f(ox + 6)} ${f(oy - 10)}H${f(ox + 36)}" stroke="${ctx.color}" stroke-opacity=".8" stroke-width="2" fill="none"/>`
    for (const cx of [-44, -22, 4, 28]) svg += `<circle cx="${f(ox + cx)}" cy="${f(oy + 10)}" r="3.8" fill="#0d1729" stroke="#94a3b8" stroke-width="1.6"/>`
    svg += `<circle cx="${f(ox + 12)}" cy="${f(oy - 10)}" r="3.8" fill="#0d1729" stroke="${ctx.color}" stroke-width="1.6"/>`
    const hx = ox + 38
    const hy = oy - 10
    const pulse = live(ctx)
      ? `<circle cx="${f(hx)}" cy="${f(hy)}" r="5" fill="none" stroke="${head}"><animate attributeName="r" values="5;11" dur="1.4s" repeatCount="indefinite"/><animate attributeName="opacity" values=".8;0" dur="1.4s" repeatCount="indefinite"/></circle>`
      : ''
    const dot = `<circle cx="${f(hx)}" cy="${f(hy)}" r="${intro(ctx) ? 0 : 5}" fill="${head}">${intro(ctx) ? `<animate attributeName="r" values="0;6.5;5" keyTimes="0;.7;1" dur=".45s" begin=".35s" fill="freeze"/>` : ''}</circle>`
    svg += pulse + dot
    svg += `<text x="${f(hx)}" y="${f(hy - 9)}" text-anchor="middle" ${sans(9)} font-weight="700" fill="${head}" letter-spacing=".5">HEAD</text>`
    return { svg, caption: (isGh ? 'gh ' : 'git ') + (sub || '') }
  },

  // A GPU memory meter (nvidia-smi's "used / total MiB" when the output has it).
  gpu: (s, ctx, b) => {
    const out = str(s.output).slice(0, 4000)
    const m = /(\d+)\s*MiB\s*\/\s*(\d+)\s*MiB/.exec(out)
    const used = m ? Number(m[1]) : null
    const total = m ? Number(m[2]) : null
    const frac = used !== null && total ? clamp(used / total, 0, 1) : 0.58
    const known = used !== null && !!total
    const x0 = b.cx - 26
    const y0 = b.cy - 4
    const bw = 80
    const col = frac > 0.85 ? INK.bad : frac > 0.6 ? INK.warn : INK.ok
    let svg = `<g transform="translate(${f(b.cx - 49)} ${f(b.cy - 2)})"><rect x="-11" y="-11" width="22" height="22" rx="3" fill="#13203a" stroke="#64748b"/>`
    for (const p of [-6, 0, 6]) svg += `<path d="M${p} -14v3M${p} 11v3M-14 ${p}h3M11 ${p}h3" stroke="#64748b" stroke-width="1.3"/>`
    svg += `<text y="3.4" text-anchor="middle" ${sans(9)} font-weight="700" fill="${INK.textSoft}">GPU</text></g>`
    svg += `<text x="${f(x0)}" y="${f(y0 - 6)}" ${sans(9.5)} fill="${INK.textDim}">${known ? `${Math.round(frac * 100)}% used` : 'memory'}</text>`
    svg += `<rect x="${f(x0)}" y="${f(y0)}" width="${bw}" height="10" rx="3" fill="#1e293b"/>`
    const w = Math.max(3, bw * frac)
    const grow = intro(ctx) ? `<animate attributeName="width" from="0" to="${f(w)}" dur=".7s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines=".2 .7 .3 1"/>` : ''
    const wiggle = live(ctx) ? `<animate attributeName="width" values="${f(w)};${f(Math.min(bw, w * 1.07))};${f(w * 0.96)};${f(w)}" dur="2.2s" begin="${intro(ctx) ? '.7' : '0'}s" repeatCount="indefinite"/>` : ''
    svg += `<rect x="${f(x0)}" y="${f(y0)}" width="${f(w)}" height="10" rx="3" fill="${col}">${grow}${wiggle}</rect>`
    if (known) svg += `<text x="${f(x0)}" y="${f(y0 + 23)}" ${mono(10)} fill="${INK.textSoft}">${esc(`${((used ?? 0) / 1024).toFixed(1)} / ${((total ?? 0) / 1024).toFixed(1)} GB`)}</text>`
    else if (ctx.status === 'running') svg += `<text x="${f(x0)}" y="${f(y0 + 23)}" ${mono(10)} fill="${INK.textFaint}">checking…</text>`
    return { svg, caption: 'GPU memory' }
  },

  // Shipping containers, the top one lowered into place.
  docker: (s, ctx, b) => {
    const cmd = flat(str(s.command).slice(0, 600))
    const sub = subcommand(cmd, /^docker(-compose)?$/, 1)
    const ox = b.cx
    const oy = b.cy + 8
    const box = (x: number, y: number, c: string, light: number): string => {
      let r = `<rect x="${f(x)}" y="${f(y)}" width="32" height="16" rx="1.5" fill="${c}" stroke="#0b1220" stroke-opacity=".5"/>`
      for (let k = 1; k < 8; k++) r += `<path d="M${f(x + k * 4)} ${f(y + 2.5)}v11" stroke="#0b1220" stroke-opacity=".28"/>`
      r += `<circle cx="${f(x + 28)}" cy="${f(y + 4.5)}" r="1.6" fill="${INK.ok}">${loopA(ctx, `attributeName="opacity" values="1;.2;1" dur="1.2s" begin="${f(light * 0.3)}s"`)}</circle>`
      return r
    }
    const topColor = ctx.status === 'error' ? INK.bad : '#7dd3fc'
    const top = box(ox - 16, oy - 17, topColor, 2)
    const svg =
      `<path d="M${f(ox - 44)} ${f(oy + 17)}h88" stroke="#334155" stroke-width="2" stroke-linecap="round"/>` +
      box(ox - 34, oy, '#0ea5e9', 0) +
      box(ox + 2, oy, '#38bdf8', 1) +
      (intro(ctx) ? slideIn(ctx, 0.3, 0, -26, top, 0.5) : top)
    return { svg, caption: 'docker ' + sub }
  },

  // A little table grid; a highlighted row scans while the query runs.
  database: (s, ctx, b) => {
    const nc = 4
    const rows = 4
    const cw = 22
    const ch = 11
    const x0 = b.cx - (nc * cw) / 2
    const y0 = b.cy - (rows * ch) / 2 - 3
    let svg = `<rect x="${f(x0)}" y="${f(y0)}" width="${nc * cw}" height="${ch}" fill="#60a5fa" fill-opacity=".55"/>`
    for (let r = 1; r < rows; r++) svg += `<rect x="${f(x0)}" y="${f(y0 + r * ch)}" width="${nc * cw}" height="${ch}" fill="${r % 2 ? '#111c30' : '#0f192b'}"/>`
    const hi = isBad(ctx.status) ? INK.bad : ctx.status === 'ok' ? INK.ok : ctx.color
    const scan = live(ctx)
      ? `<animate attributeName="y" values="${f(y0 + ch)};${f(y0 + 2 * ch)};${f(y0 + 3 * ch)}" calcMode="discrete" dur="1.5s" repeatCount="indefinite"/>`
      : ''
    svg += `<rect x="${f(x0)}" y="${f(y0 + 2 * ch)}" width="${nc * cw}" height="${ch}" fill="${hi}" fill-opacity=".35">${scan}</rect>`
    svg += `<rect x="${f(x0)}" y="${f(y0)}" width="${nc * cw}" height="${rows * ch}" fill="none" stroke="#3b4a63"/>`
    for (let c = 1; c < nc; c++) svg += `<path d="M${f(x0 + c * cw)} ${f(y0)}v${rows * ch}" stroke="#3b4a63" stroke-opacity=".7"/>`
    for (let r = 1; r < rows; r++) svg += `<path d="M${f(x0)} ${f(y0 + r * ch)}h${nc * cw}" stroke="#3b4a63" stroke-opacity=".7"/>`
    return { svg, caption: s.program ? clip(flat(str(s.program)), 18) + ' query' : 'database query' }
  },

  // Request and response arrows between a laptop and a server.
  http: (s, ctx, b) => {
    const cmd = flat(str(s.command).slice(0, 600))
    const out = str(s.output).slice(0, 4000)
    const code = /HTTP\/[\d.]+\s+(\d{3})/i.exec(out)?.[1] ?? /\b(?:status(?:\s+code)?|code)[:\s]+(\d{3})\b/i.exec(out)?.[1] ?? ''
    const host = /https?:\/\/([^/\s'"]+)/i.exec(cmd)?.[1] ?? ''
    const method = (/(?:-X|--request)\s*([A-Za-z]+)/.exec(cmd)?.[1] ?? (/\s(?:-d|--data\S*|-F|--form)\s/.test(cmd + ' ') ? 'POST' : 'GET')).toUpperCase()
    const ox = b.cx
    const oy = b.cy - 2
    const back = isBad(ctx.status) || (code !== '' && Number(code) >= 400) ? INK.bad : ctx.status === 'ok' ? INK.ok : '#475569'
    let svg =
      // laptop
      `<rect x="${f(ox - 58)}" y="${f(oy - 12)}" width="22" height="15" rx="2" fill="#13203a" stroke="#94a3b8" stroke-width="1.3"/>` +
      `<path d="M${f(ox - 61)} ${f(oy + 5)}h28" stroke="#94a3b8" stroke-width="2" stroke-linecap="round"/>` +
      // server
      [0, 1, 2]
        .map(k => `<rect x="${f(ox + 36)}" y="${f(oy - 15 + k * 8)}" width="22" height="6.5" rx="1.5" fill="#13203a" stroke="#94a3b8" stroke-width="1.2"/><circle cx="${f(ox + 40)}" cy="${f(oy - 11.7 + k * 8)}" r="1.1" fill="${INK.ok}"/>`)
        .join('') +
      // arrows
      `<path d="M${f(ox - 30)} ${f(oy - 8)}H${f(ox + 28)}m-5-3.5l5 3.5-5 3.5" stroke="${ctx.color}" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` +
      `<path d="M${f(ox + 28)} ${f(oy + 6)}H${f(ox - 30)}m5-3.5l-5 3.5 5 3.5" stroke="${back}" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"${ctx.status === 'running' ? ' stroke-dasharray="3 3"' : ''}/>` +
      `<text x="${f(ox - 1)}" y="${f(oy - 12)}" text-anchor="middle" ${mono(9.5)} font-weight="700" fill="${ctx.color}">${esc(clip(method, 7))}</text>`
    if (code) svg += `<text x="${f(ox - 1)}" y="${f(oy + 19)}" text-anchor="middle" ${mono(10)} font-weight="700" fill="${back}">${esc(code)}</text>`
    if (live(ctx)) {
      svg +=
        `<circle r="2.6" fill="${ctx.color}"><animateMotion dur="1.6s" repeatCount="indefinite" calcMode="linear" keyPoints="0;1;1" keyTimes="0;.5;1" path="M${f(ox - 30)} ${f(oy - 8)}H${f(ox + 26)}"/></circle>` +
        `<circle r="2.6" fill="${INK.ok}" opacity="0"><animateMotion dur="1.6s" repeatCount="indefinite" calcMode="linear" keyPoints="0;0;1" keyTimes="0;.5;1" path="M${f(ox + 26)} ${f(oy + 6)}H${f(ox - 30)}"/><animate attributeName="opacity" values="0;0;1;1" keyTimes="0;.5;.52;1" dur="1.6s" repeatCount="indefinite"/></circle>`
    }
    return { svg, caption: host ? clip(host, 22) : 'HTTP request' }
  },

  // An hourglass; sand falls while waiting.
  wait: (s, ctx, b) => {
    const cmd = flat(str(s.command).slice(0, 600))
    const sl = /\bsleep\s+(\d+(?:\.\d+)?)([smhd]?)\b/.exec(cmd)
    const ox = b.cx
    const oy = b.cy
    const running = ctx.status === 'running'
    const topSand = running ? '-8,-14 8,-14 0,-2' : '0,-3 0,-3 0,-3'
    const botSand = running ? '-3,15 3,15 0,13' : '-8,15 8,15 0,4'
    let svg =
      `<g transform="translate(${f(ox)} ${f(oy)})">` +
      `<path d="M-12-19h24M-12 19h24" stroke="${ctx.color}" stroke-width="2.6" stroke-linecap="round"/>` +
      `<path d="M-9-17v2q0 9 7 15q-7 6-7 15v2M9-17v2q0 9-7 15q7 6 7 15v2" stroke="#94a3b8" stroke-width="1.4" fill="#0f1a2e" fill-opacity=".6"/>` +
      `<polygon points="${topSand}" fill="${ctx.color}">${loopA(ctx, 'attributeName="points" values="-8,-14 8,-14 0,-2;0,-3 0,-3 0,-3" dur="3s"')}</polygon>` +
      `<polygon points="${botSand}" fill="${ctx.color}">${loopA(ctx, 'attributeName="points" values="-1,15 1,15 0,14;-8,15 8,15 0,4" dur="3s"')}</polygon>`
    if (live(ctx)) svg += `<path d="M0-2V14" stroke="${ctx.color}" stroke-width="1.2" stroke-dasharray="2 2"><animate attributeName="stroke-dashoffset" from="8" to="0" dur=".5s" repeatCount="indefinite"/></path>`
    svg += '</g>'
    return { svg, caption: sl ? `sleep ${sl[1]}${sl[2] || 's'}` : 'waiting' }
  },

  // Two meshing gears turning while the build runs.
  build: (s, ctx, b) => {
    const gear = (n: number, R: number, r: number): string => {
      let d = ''
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2
        const a1 = a0 + (Math.PI * 2) / n / 2
        const pts = [
          [r, a0],
          [R, a0 + 0.08],
          [R, a1 - 0.08],
          [r, a1],
        ] as const
        for (const [rad, a] of pts) d += `${d ? 'L' : 'M'}${f(Math.cos(a) * rad)} ${f(Math.sin(a) * rad)}`
      }
      return d + 'Z'
    }
    const spin = (dir: number, dur: number) =>
      live(ctx) ? `<animateTransform attributeName="transform" type="rotate" from="0" to="${dir * 360}" dur="${dur}s" repeatCount="indefinite"/>` : ''
    const col = isBad(ctx.status) ? INK.bad : ctx.color
    const svg =
      `<g transform="translate(${f(b.cx - 13)} ${f(b.cy - 2)})"><g>${spin(1, 4)}<path d="${gear(10, 17, 13)}" fill="#13203a" stroke="${col}" stroke-width="1.5" stroke-linejoin="round"/><circle r="4.5" fill="none" stroke="${col}" stroke-width="1.5"/></g></g>` +
      `<g transform="translate(${f(b.cx + 17)} ${f(b.cy + 9)})"><g transform="rotate(12)"><g>${spin(-1, 2.8)}<path d="${gear(7, 12, 9)}" fill="#13203a" stroke="#94a3b8" stroke-width="1.5" stroke-linejoin="round"/><circle r="3.2" fill="none" stroke="#94a3b8" stroke-width="1.5"/></g></g></g>`
    return { svg, caption: s.program ? clip(flat(str(s.program)), 16) + ' build' : 'build' }
  },

  // A sound wave for ffmpeg / sox.
  media: (s, ctx, b) => {
    const r = rand(hash(str(s.command)) + 3)
    let svg = ''
    const n = 15
    for (let i = 0; i < n; i++) {
      const h = 6 + Math.floor(r() * 30)
      const x = b.cx - (n * 6) / 2 + i * 6
      const y = b.cy - 4
      const a = live(ctx)
        ? `<animate attributeName="height" values="${h};${f(h * 0.35)};${h}" dur="${f(0.8 + (i % 4) * 0.15)}s" repeatCount="indefinite"/><animate attributeName="y" values="${f(y - h / 2)};${f(y - h * 0.175)};${f(y - h / 2)}" dur="${f(0.8 + (i % 4) * 0.15)}s" repeatCount="indefinite"/>`
        : ''
      svg += `<rect x="${f(x)}" y="${f(y - h / 2)}" width="3.4" height="${h}" rx="1.7" fill="${ctx.color}" fill-opacity="${f(0.55 + (i % 3) * 0.15)}">${a}</rect>`
    }
    return { svg, caption: s.program ? clip(flat(str(s.program)), 18) : 'media' }
  },
}

function run(s: Of<'run'>, ctx: SceneCtx): string {
  const raw = str(s.command).slice(0, 20000)
  const lines = raw.split(/\r?\n/).filter(l => l.trim() !== '')
  const first = (lines[0] ?? '').trim()
  const extra = Math.max(0, lines.length - 1)
  const category = (typeof s.category === 'string' ? s.category : 'other') as BashCategory
  const widget = Object.prototype.hasOwnProperty.call(WIDGETS, category) ? WIDGETS[category] : undefined
  const sideW = widget ? 140 : 0
  const X = ctx.x
  const Y = ctx.y + 1
  const TW = ctx.w - (widget ? sideW + 10 : 0)
  const TH = ctx.h - 2
  const running = ctx.status === 'running'
  const bg = s.isBackground === true
  const u = ctx.uid

  // the window
  let svg =
    `<rect x="${f(X)}" y="${f(Y)}" width="${f(TW)}" height="${f(TH)}" rx="8" fill="${INK.term}" stroke="${INK.termStroke}"/>` +
    `<path d="M${f(X + 1)} ${f(Y + 17)}H${f(X + TW - 1)}" stroke="${INK.termStroke}"/>` +
    `<g fill-opacity=".9"><circle cx="${f(X + 12)}" cy="${f(Y + 9)}" r="3.3" fill="#ef4444"/><circle cx="${f(X + 23)}" cy="${f(Y + 9)}" r="3.3" fill="#f59e0b"/><circle cx="${f(X + 34)}" cy="${f(Y + 9)}" r="3.3" fill="#22c55e"/></g>`
  const prog = flat(str(s.program)).trim()
  const badgeW = bg ? 124 : 0
  svg += `<text x="${f(X + 46)}" y="${f(Y + 12.5)}" ${sans(9.5)} fill="${INK.textFaint}">terminal${prog ? ' · ' + t(prog, fit(TW - 100 - badgeW, 9.5)) : ''}</text>`
  if (bg) {
    const bx = X + TW - badgeW - 6
    svg +=
      `<g transform="translate(${f(bx)} ${f(Y + 2.5)})"><rect width="${badgeW}" height="13" rx="6.5" fill="${ctx.color}" fill-opacity=".14" stroke="${ctx.color}" stroke-opacity=".55"/>` +
      `<text x="9" y="10" ${mono(10)} font-weight="700" fill="${ctx.color}">&amp;</text>` +
      `<text x="20" y="9.9" ${sans(9.5)} fill="${ctx.color}">runs in background</text></g>`
  }

  // the command, typed
  const cmdY = Y + 38
  const cmdX = X + 26
  const more = extra > 0 ? `+${extra} line${extra === 1 ? '' : 's'}` : ''
  const moreW = more ? more.length * 5.7 + 14 : 0
  const room = fit(TW - 26 - 16 - moreW, 12)
  const cmd = clipCols(first, room)
  const cw = cols(cmd) * 7.22
  const typeDur = clamp(0.2 + cols(cmd) * 0.028, 0.35, 1.5)
  const typing = intro(ctx)
  svg += `<text x="${f(X + 12)}" y="${f(cmdY)}" ${mono(12)} fill="${INK.ok}">$</text>`
  if (typing) {
    svg +=
      // the clip opens as the command is typed, then lets go entirely (a font wider than estimated still shows it all)
      `<clipPath id="${u}ty"><rect x="${f(cmdX - 1)}" y="${f(cmdY - 13)}" width="0" height="17"><animate attributeName="width" from="0" to="${f(cw + 2)}" dur="${f(typeDur)}s" fill="freeze"/><set attributeName="width" to="${f(TW)}" begin="${f(typeDur)}s" fill="freeze"/></rect></clipPath>` +
      `<text x="${f(cmdX)}" y="${f(cmdY)}" ${mono(12)} fill="${INK.text}" clip-path="url(#${u}ty)">${tm(cmd, room)}</text>`
  } else {
    svg += `<text x="${f(cmdX)}" y="${f(cmdY)}" ${mono(12)} fill="${INK.text}">${tm(cmd, room)}</text>`
  }
  if (more) svg += fadeIn(ctx, typeDur, `<text x="${f(cmdX + cw + 10)}" y="${f(cmdY - 0.5)}" ${sans(10)} fill="${INK.textDim}">${esc(more)}</text>`)
  // the cursor: follows the typing, then blinks while the command runs
  if (running || typing) {
    let a = ''
    if (typing) a += `<animate attributeName="x" from="${f(cmdX)}" to="${f(cmdX + cw + 1)}" dur="${f(typeDur)}s" fill="freeze"/>`
    if (running) a += live(ctx) ? `<animate attributeName="opacity" values="1;0" calcMode="discrete" dur="1s" begin="${f(typing ? typeDur : 0)}s" repeatCount="indefinite"/>` : ''
    else a += setA(ctx, `attributeName="opacity" to="0" begin="${f(typeDur)}s" fill="freeze"`)
    svg += `<rect x="${f(cmdX + cw + 1)}" y="${f(cmdY - 10.5)}" width="7" height="13" fill="${INK.text}" fill-opacity=".85">${a}</rect>`
  }

  // the outcome
  const outW = TW - 28
  const y1 = Y + 59
  const y2 = Y + 78
  let result = ''
  if (running) {
    result = dots(ctx, X + 15, y1 - 4, ctx.color) + `<text x="${f(X + 40)}" y="${f(y1)}" ${mono(11)} fill="${INK.textDim}">${bg ? 'starting in the background…' : 'running…'}</text>`
  } else {
    const bad = isBad(ctx.status)
    const note = ctx.status === 'denied' ? '' : pickLine(s.output, bad)
    const code = exitCode(str(s.output).slice(0, 4000))
    const word =
      ctx.status === 'ok'
        ? bg
          ? '✓ started · keeps running in the background'
          : code !== null && code !== 0
            ? `exit ${code}`
            : '✓ exit 0'
        : ctx.status === 'denied'
          ? '✗ not run · permission denied'
          : /timed? ?out/i.test(str(s.output).slice(0, 4000))
            ? '✗ timed out'
            : code !== null && code !== 0
              ? `✗ exit ${code}`
              : '✗ failed'
    const wordColor = ctx.status === 'ok' ? (word.startsWith('✓') ? INK.ok : INK.warn) : INK.bad
    if (note) {
      result =
        `<text x="${f(X + 12)}" y="${f(y1)}" ${mono(11)} fill="${bad ? INK.badSoft : INK.textDim}">${tm(note, fit(outW, 11))}</text>` +
        `<text x="${f(X + 12)}" y="${f(y2)}" ${mono(11)} font-weight="700" fill="${wordColor}">${esc(clip(word, fit(outW, 11)))}</text>`
    } else {
      result = `<text x="${f(X + 12)}" y="${f(y1)}" ${mono(11)} font-weight="700" fill="${wordColor}">${esc(clip(word, fit(outW, 11)))}</text>`
    }
  }
  svg += fadeIn(ctx, typing ? typeDur + 0.1 : 0, result)

  // the side picture
  if (widget) {
    const wx = X + TW + 10
    const box = { x: wx, y: Y, w: sideW, h: TH, cx: wx + sideW / 2, cy: Y + (TH - 14) / 2 }
    let w = { svg: '', caption: '' }
    try {
      w = widget(s, ctx, box)
    } catch {
      w = { svg: '', caption: '' }
    }
    svg +=
      `<rect x="${f(wx)}" y="${f(Y)}" width="${sideW}" height="${f(TH)}" rx="8" fill="#0d1729" stroke="${INK.panelStroke}"/>` +
      w.svg +
      `<text x="${f(box.cx)}" y="${f(Y + TH - 8)}" text-anchor="middle" ${sans(9.5)} fill="${INK.textDim}">${t(w.caption.trim(), 24)}</text>`
  }
  return svg
}

export const sceneRun = (s: Of<'run'>, ctx: SceneCtx): string => {
  try {
    return run(s && typeof s === 'object' ? s : { kind: 'run', command: '', category: 'other' }, ctx)
  } catch {
    return ''
  }
}

// ------------------------------------------------------------------ read

const lineRange = (detail: string): [number, number] | null => {
  const m = /(\d+)\s*(?:[–-]|to|\.\.)\s*(\d+)/.exec(detail)
  return m ? [Number(m[1]), Number(m[2])] : null
}

function read(s: Of<'read'>, ctx: SceneCtx): string {
  const all: unknown[] = Array.isArray(s.files) ? s.files : []
  const files = all
    .slice(0, 64)
    .map(x => (x && typeof x === 'object' ? { path: str((x as { path?: unknown }).path), detail: str((x as { detail?: unknown }).detail) } : { path: '', detail: '' }))
    .filter(x => x.path !== '' || x.detail !== '')
  const total = Math.max(files.length, all.length)
  const main = files[0] ?? { path: '', detail: '' }
  const multi = total > 1
  const X = ctx.x + 6
  const SY = ctx.y + 16
  const SW = 236
  const SH = 71
  const running = ctx.status === 'running'
  const bad = isBad(ctx.status)
  let svg = ''

  // the stack behind
  if (multi) {
    const back = (dx: number, dy: number, op: string) =>
      `<rect x="${f(X + dx)}" y="${f(SY + dy)}" width="${SW}" height="${SH}" rx="6" fill="#0d1628" stroke="#24324d" opacity="${op}"/>`
    svg += slideIn(ctx, 0.05, -10, 6, back(12, -7, '.8'), 0.4) + slideIn(ctx, 0, -5, 3, back(6, -3.5, '1'), 0.4)
  }
  // the sheet + tab
  svg += `<rect x="${f(X)}" y="${f(SY)}" width="${SW}" height="${SH}" rx="6" fill="${INK.sheet}" stroke="${bad ? INK.bad : INK.sheetStroke}"${bad ? ' stroke-opacity=".7"' : ''}/>`
  svg += sheetTab(X, SY, baseName(main.path), '#93c5fd', SW - 40)
  // numbered lines
  const range = lineRange(main.detail)
  const start = range ? range[0] : 1
  const digits = String(start + 5).length
  const gw = digits * 5.4 + 12
  const r = rand(hash(main.path || 'file'))
  const barMax = SW - gw - 24
  for (let i = 0; i < 6; i++) {
    const y = SY + 12 + i * 9.6
    const indent = [0, 0, 12, 12, 24, 12][(i + Math.floor(r() * 3)) % 6] ?? 0
    const w = Math.min(barMax - indent, 34 + Math.floor(r() * (barMax - 40)))
    const fill = [INK.line1, INK.line2, INK.line3][i % 3] ?? INK.line1
    const grow = intro(ctx) ? `<animate attributeName="width" from="0" to="${f(w)}" begin="${f(0.15 + i * 0.07)}s" dur=".25s" fill="freeze"/>` : ''
    svg +=
      `<text x="${f(X + gw - 4)}" y="${f(y + 4)}" text-anchor="end" ${mono(9)} fill="${INK.gutter}">${start + i}</text>` +
      `<rect x="${f(X + gw + 4 + indent)}" y="${f(y)}" width="${intro(ctx) ? 0 : f(w)}" height="4.5" rx="2.2" fill="${fill}">${grow}</rect>`
  }
  // the reading highlight
  if (running) {
    const scan = live(ctx) ? `<animate attributeName="y" values="${f(SY + 8)};${f(SY + 56)};${f(SY + 8)}" dur="2.6s" repeatCount="indefinite"/>` : ''
    svg += `<rect x="${f(X + gw)}" y="${f(SY + 8)}" width="${f(SW - gw - 6)}" height="11" rx="2.5" fill="${ctx.color}" fill-opacity=".22" stroke="${ctx.color}" stroke-opacity=".35">${scan}</rect>`
  }

  // the words on the right
  const lx = X + SW + 34
  const right = ctx.x + ctx.w - 4
  if (!multi) {
    const dir = dirName(main.path)
    const base = baseName(main.path) || main.path || '(no file)'
    const mark = ctx.status === 'running' ? '' : bad ? `<tspan fill="${INK.bad}">✗ </tspan>` : `<tspan fill="${INK.ok}">✓ </tspan>`
    let words = ''
    if (dir) words += `<text x="${f(lx)}" y="${f(ctx.y + 30)}" ${mono(10.5)} fill="${INK.textFaint}">${tl(dir, fit(right - lx, 10.5))}</text>`
    words += `<text x="${f(lx)}" y="${f(ctx.y + 51)}" ${mono(14)} font-weight="700" fill="${INK.text}">${mark}${tm(base, fit(right - lx - (mark ? 20 : 0), 14))}</text>`
    const detail = main.detail || (ctx.status === 'denied' ? 'not allowed' : bad ? 'could not read it' : running ? 'opening…' : '')
    if (detail) words += `<text x="${f(lx)}" y="${f(ctx.y + 72)}" ${sans(11)} fill="${bad ? INK.badSoft : INK.textDim}">${t(detail, Math.floor((right - lx) / 5.8))}</text>`
    svg += fadeIn(ctx, 0.1, words)
  } else {
    const rows = total > 4 ? files.slice(0, 3) : files.slice(0, 4)
    rows.forEach((fl, i) => {
      const y = ctx.y + 22 + i * 19.5
      const glyph =
        ctx.status === 'running'
          ? i === 0
            ? `<tspan fill="${ctx.color}">▸</tspan>`
            : `<tspan fill="${INK.textFaint}">·</tspan>`
          : bad
            ? i === 0
              ? `<tspan fill="${INK.bad}">✗</tspan>`
              : `<tspan fill="${INK.textFaint}">·</tspan>`
            : `<tspan fill="${INK.ok}">✓</tspan>`
      const detail = clipCols(fl.detail, 16)
      const dw = detail ? cols(detail) * 6 + 12 : 0
      const row =
        `<text x="${f(lx)}" y="${f(y)}" ${mono(11.5)} fill="${i === 0 ? INK.text : '#a9b6c9'}">${glyph} ${tl(fl.path || '(file)', fit(right - lx - 16 - dw, 11.5))}</text>` +
        (detail ? `<text x="${f(right)}" y="${f(y)}" text-anchor="end" ${mono(10)} fill="${INK.textFaint}">${esc(detail.replace(BAD_UNITS, ''))}</text>` : '')
      svg += fadeIn(ctx, 0.15 + i * 0.12, row)
    })
    if (total > 4) svg += fadeIn(ctx, 0.55, `<text x="${f(lx + 16)}" y="${f(ctx.y + 22 + 3 * 19.5)}" ${sans(10.5)} fill="${INK.textDim}">+${compact(total - 3)} more files</text>`)
  }
  return svg
}

export const sceneRead = (s: Of<'read'>, ctx: SceneCtx): string => {
  try {
    return read(s && typeof s === 'object' ? s : { kind: 'read', files: [] }, ctx)
  } catch {
    return ''
  }
}

// ------------------------------------------------------------------ search

/** keyTimes / values for an opacity that flashes to 1 at each fraction of the cycle. */
const flashes = (peaks: number[]): { keyTimes: string; values: string } => {
  const kt: number[] = [0]
  const vs: number[] = [0.45]
  for (const p of [...peaks].sort((a, b) => a - b)) {
    const a = clamp(p - 0.05, 0.01, 0.97)
    const b = clamp(p, a + 0.005, 0.98)
    const c = clamp(p + 0.09, b + 0.005, 0.99)
    if (a <= (kt[kt.length - 1] ?? 0)) continue
    kt.push(a, b, c)
    vs.push(0.45, 1, 0.45)
  }
  kt.push(1)
  vs.push(0.45)
  return { keyTimes: kt.map(k => f(Math.round(k * 1000) / 1000)).join(';'), values: vs.map(v => String(v)).join(';') }
}

function search(s: Of<'search'>, ctx: SceneCtx): string {
  const query = flat(str(s.query)).trim()
  const where = flat(str(s.where)).trim()
  const matches = flat(str(s.matches)).trim()
  const X = ctx.x + 2
  const Y = ctx.y
  const PW = 232
  const PY = Y + 6
  let svg = ''

  // the query pill
  const qRoom = fit(PW - 34 - 12, 12) - 2
  const pill =
    `<rect x="${f(X)}" y="${f(PY)}" width="${PW}" height="28" rx="14" fill="${INK.sheet}" stroke="${ctx.color}" stroke-opacity=".6"/>` +
    `<circle cx="${f(X + 16)}" cy="${f(PY + 12.5)}" r="5.2" fill="none" stroke="${ctx.color}" stroke-width="1.8"/><path d="M${f(X + 19.8)} ${f(PY + 16.3)}l4 4" stroke="${ctx.color}" stroke-width="2" stroke-linecap="round"/>` +
    `<text x="${f(X + 30)}" y="${f(PY + 18.5)}" ${mono(12)} fill="${INK.text}">“${tm(query || '…', qRoom)}”</text>`
  svg += slideIn(ctx, 0, 0, 4, pill, 0.3)
  if (where) svg += fadeIn(ctx, 0.15, `<text x="${f(X + 6)}" y="${f(Y + 54)}" ${sans(11)} fill="${INK.textDim}">in <tspan ${mono(11)} fill="${INK.textSoft}">${tl(where, fit(PW - 24, 11))}</tspan></text>`)

  // the outcome
  const n = /(\d[\d,]*)/.exec(matches)
  const count = /^\s*(no|none|zero)\b/i.test(matches) ? 0 : n ? Number((n[1] ?? '').replace(/,/g, '')) : null
  let outcome = ''
  const oy = Y + 80
  if (ctx.status === 'running') outcome = dots(ctx, X + 9, oy - 4, ctx.color) + `<text x="${f(X + 34)}" y="${f(oy)}" ${mono(11)} fill="${INK.textDim}">searching…</text>`
  else if (ctx.status === 'denied') outcome = `<text x="${f(X + 6)}" y="${f(oy)}" ${mono(11.5)} font-weight="700" fill="${INK.bad}">✗ not allowed</text>`
  else if (matches) {
    const col = count === 0 || ctx.status === 'error' ? INK.textDim : INK.match
    outcome = `<text x="${f(X + 6)}" y="${f(oy)}" ${mono(12)} font-weight="700" fill="${col}">${tm(matches, fit(PW, 12))}</text>`
  } else outcome = `<text x="${f(X + 6)}" y="${f(oy)}" ${mono(11.5)} font-weight="700" fill="${ctx.status === 'ok' ? INK.ok : INK.bad}">${ctx.status === 'ok' ? '✓ done' : '✗ search failed'}</text>`
  svg += fadeIn(ctx, 0.2, outcome)

  // four file cards and the sweeping lens
  const CW = 74
  const CH = 66
  const G = 12
  const total = 4 * CW + 3 * G
  const cx0 = ctx.x + ctx.w - total - 8
  const CY = Y + 10
  const nHi = count !== null ? Math.min(count, 7) : ctx.status === 'running' || ctx.status === 'ok' ? 3 : 0
  const r = rand(hash(query || 'q') + 11)
  const hits: Set<string> = new Set()
  for (let k = 0; k < nHi; k++) {
    const card = (k + Math.floor(r() * 4)) % 4
    let line = Math.floor(r() * 5)
    for (let tries = 0; hits.has(`${card}:${line}`) && tries < 5; tries++) line = (line + 1) % 5
    hits.add(`${card}:${line}`)
  }
  const sweepDur = 3.2
  const lensFrom = cx0 - 2
  const lensTo = cx0 + total + 2
  for (let i = 0; i < 4; i++) {
    const x = cx0 + i * (CW + G)
    let card =
      `<path d="M${f(x)} ${f(CY)}H${f(x + CW - 12)}l12 12V${f(CY + CH)}H${f(x)}z" fill="${INK.sheet}" stroke="${INK.sheetStroke}"/>` +
      `<path d="M${f(x + CW - 12)} ${f(CY)}v12h12" fill="none" stroke="${INK.sheetStroke}"/>`
    const rr = rand(hash(query + i))
    const centre = (x + CW / 2 - lensFrom) / (lensTo - lensFrom)
    const fl = flashes([centre / 2, 1 - centre / 2])
    for (let j = 0; j < 5; j++) {
      const y = CY + 14 + j * 10
      const w = 16 + Math.floor(rr() * (CW - 34))
      const hit = hits.has(`${i}:${j}`)
      card += `<rect x="${f(x + 8)}" y="${f(y)}" width="${w}" height="4" rx="2" fill="${hit ? INK.match : j % 2 ? INK.line2 : INK.line1}"${hit && live(ctx) ? ' opacity=".45"' : ''}>${hit && live(ctx) ? `<animate attributeName="opacity" values="${fl.values}" keyTimes="${fl.keyTimes}" dur="${sweepDur}s" repeatCount="indefinite"/>` : ''}</rect>`
      if (hit && ctx.status !== 'running') card += `<rect x="${f(x + 5)}" y="${f(y - 2.5)}" width="${w + 6}" height="9" rx="3" fill="${INK.match}" fill-opacity=".16"/>`
    }
    svg += slideIn(ctx, 0.1 + i * 0.08, 0, 8, card, 0.3)
  }
  if (ctx.status === 'running') {
    const lens =
      `<circle r="13" fill="#e2e8f0" fill-opacity=".07" stroke="#e2e8f0" stroke-width="2.2"/>` +
      `<path d="M9.5 9.5l7.5 7.5" stroke="#cbd5e1" stroke-width="4" stroke-linecap="round"/>`
    const motion = live(ctx)
      ? animM(ctx, `dur="${sweepDur}s" repeatCount="indefinite" keyPoints="0;1;0" keyTimes="0;.5;1" calcMode="linear" path="M0 0H${f(lensTo - lensFrom)}"`)
      : ''
    const px = live(ctx) ? lensFrom : cx0 + CW + G / 2
    svg += `<g transform="translate(${f(px)} ${f(CY + CH / 2 - 4)})"><g>${motion}${lens}</g></g>`
  }
  return svg
}

export const sceneSearch = (s: Of<'search'>, ctx: SceneCtx): string => {
  try {
    return search(s && typeof s === 'object' ? s : { kind: 'search', query: '' }, ctx)
  } catch {
    return ''
  }
}

// ------------------------------------------------------------------ edit

const lineList = (v: unknown): string[] => (Array.isArray(v) ? v.slice(0, 200).map(x => str(x)) : [])

function edit(s: Of<'edit'>, ctx: SceneCtx): string {
  const minus = lineList(s.minus)
  const plus = lineList(s.plus)
  const isNew = s.isNew === true
  const added = nonNeg(s.added) ?? plus.length
  const removed = nonNeg(s.removed) ?? minus.length
  const X = ctx.x + 2
  const SY = ctx.y + 16
  const SW = 452
  const SH = 71
  const bad = isBad(ctx.status)
  const u = ctx.uid
  let svg = ''

  svg += `<rect x="${f(X)}" y="${f(SY)}" width="${SW}" height="${SH}" rx="6" fill="${INK.sheet}" stroke="${bad ? INK.bad : INK.sheetStroke}"${bad ? ' stroke-opacity=".7"' : ''}/>`
  svg += sheetTab(X, SY, baseName(str(s.path)), '#6ee7b7', SW - 80)

  // which lines fit: up to 5 rows, removed lines first
  const maxRows = 5
  let m = Math.min(minus.length, plus.length > 0 ? 2 : maxRows)
  const p = Math.min(plus.length, maxRows - m)
  m = Math.min(minus.length, maxRows - p)
  const hidden = Math.max(0, Math.max(removed, minus.length) - m) + Math.max(0, Math.max(added, plus.length) - p)
  const rowH = 12.9
  const textX = X + 24
  // the ribbon's lower edge runs from (SW-56, 0) to (SW, 56) across the sheet's corner
  const rightAt = (y0: number): number => (isNew ? Math.min(X + SW - 10, X + SW - 60 + (y0 - SY)) : X + SW - 10)
  const rowsOf: { kind: '-' | '+'; text: string; i: number }[] = [
    ...minus.slice(0, m).map((text, i) => ({ kind: '-' as const, text, i })),
    ...plus.slice(0, p).map((text, i) => ({ kind: '+' as const, text, i })),
  ]
  let lastPlusEnd: { x: number; y: number } | null = null
  rowsOf.forEach((row, k) => {
    const y0 = SY + 5 + k * rowH
    const base = y0 + 9.5
    const raw = row.text.replace(/\t/g, '    ')
    const indent = Math.min(12, raw.length - raw.trimStart().length)
    const room = fit(rightAt(y0) - textX - indent * 6.6, 11)
    const body = clipCols(raw.trimStart(), room)
    const tx = textX + indent * 6.6
    const tw = cols(body) * 6.62
    if (row.kind === '-') {
      const struck = !bad
      const strike = struck
        ? `<rect x="${f(tx - 2)}" y="${f(y0 + 5.6)}" width="${intro(ctx) ? 0 : f(tw + 4)}" height="1.3" fill="${INK.bad}">${intro(ctx) ? `<animate attributeName="width" from="0" to="${f(tw + 4)}" begin="${f(0.25 + row.i * 0.08)}s" dur=".3s" fill="freeze"/>` : ''}</rect>`
        : ''
      const g =
        `<rect x="${f(X + 4)}" y="${f(y0)}" width="${SW - 8}" height="12.4" rx="2" fill="${INK.bad}" fill-opacity=".12"/>` +
        `<text x="${f(X + 12)}" y="${f(base)}" ${mono(11)} font-weight="700" fill="${INK.bad}">−</text>` +
        `<text x="${f(tx)}" y="${f(base)}" ${mono(11)} fill="${INK.badSoft}">${esc(body.replace(BAD_UNITS, ''))}</text>` +
        strike
      const fadeTo = struck ? '.45' : '1'
      svg += intro(ctx) && struck
        ? `<g><animate attributeName="opacity" from="1" to=".45" begin="${f(0.6 + row.i * 0.08)}s" dur=".35s" fill="freeze"/>${g}</g>`
        : `<g opacity="${fadeTo}">${g}</g>`
    } else {
      const g =
        `<rect x="${f(X + 4)}" y="${f(y0)}" width="${SW - 8}" height="12.4" rx="2" fill="${INK.ok}" fill-opacity=".12"/>` +
        `<text x="${f(X + 12)}" y="${f(base)}" ${mono(11)} font-weight="700" fill="${INK.ok}">+</text>` +
        `<text x="${f(tx)}" y="${f(base)}" ${mono(11)} fill="#bbf7d0">${esc(body.replace(BAD_UNITS, ''))}</text>`
      const begin = (m > 0 ? 0.85 : 0.2) + row.i * 0.12
      svg += `<g${bad ? ' opacity=".4"' : ''}>${slideIn(ctx, begin, -14, 0, g, 0.3)}</g>`
      lastPlusEnd = { x: tx + tw + 2, y: y0 + 1 }
    }
  })
  if (rowsOf.length === 0) svg += `<text x="${f(X + 14)}" y="${f(SY + 30)}" ${sans(11)} fill="${INK.textFaint}">${isNew ? 'an empty new file' : 'no line changes to show'}</text>`
  // a caret blinking where the typing ended
  const caretAt = lastPlusEnd as { x: number; y: number } | null
  if (ctx.status === 'running' && caretAt) {
    const caret = `<rect x="${f(caretAt.x)}" y="${f(caretAt.y)}" width="1.6" height="11" fill="#bbf7d0">${live(ctx) ? `<animate attributeName="opacity" values="1;0" calcMode="discrete" dur="1s" repeatCount="indefinite"/>` : ''}</rect>`
    svg += fadeIn(ctx, (m > 0 ? 0.85 : 0.2) + p * 0.12 + 0.2, caret, 0.1)
  }
  // the 'new file' ribbon across the sheet's corner
  if (isNew) {
    const cx = X + SW - 21
    const cy = SY + 21
    svg +=
      `<clipPath id="${u}nf"><rect x="${f(X)}" y="${f(SY)}" width="${SW}" height="${SH}" rx="6"/></clipPath>` +
      `<g clip-path="url(#${u}nf)"><path d="M${f(X + SW - 56)} ${f(SY)}h18l38 38v18z" fill="${INK.ok}"/>` +
      `<text x="${f(cx + 1.5)}" y="${f(cy + 3)}" transform="rotate(45 ${f(cx + 1.5)} ${f(cy)})" text-anchor="middle" ${sans(9)} font-weight="800" letter-spacing=".6" fill="#052e16">NEW FILE</text></g>`
  }

  // the +N −M badge, a diff bar and the outcome
  const RX = X + SW + 12
  const RC = RX + (ctx.x + ctx.w - RX) / 2
  const plusTxt = `+${compact(added)}`
  const minusTxt = isNew && removed === 0 ? '' : ` −${compact(removed)}`
  const bw = (plusTxt.length + minusTxt.length) * 8.6 + 22
  svg += slideIn(
    ctx,
    0.1,
    0,
    -4,
    `<rect x="${f(RC - bw / 2)}" y="${f(ctx.y + 6)}" width="${f(bw)}" height="26" rx="13" fill="${INK.sheet}" stroke="${INK.sheetStroke}"/>` +
      `<text x="${f(RC)}" y="${f(ctx.y + 23.5)}" text-anchor="middle" ${mono(14)} font-weight="700"><tspan fill="${INK.ok}">${esc(plusTxt)}</tspan>${minusTxt ? `<tspan fill="${INK.bad}">${esc(minusTxt)}</tspan>` : ''}</text>`,
  )
  const sum = added + removed
  const greens = sum === 0 ? 0 : clamp(Math.round((5 * added) / sum), added > 0 ? 1 : 0, removed > 0 ? 4 : 5)
  for (let i = 0; i < 5; i++) {
    const c = sum === 0 ? '#334155' : i < greens ? INK.ok : INK.bad
    svg += fadeIn(ctx, 0.9 + i * 0.06, `<rect x="${f(RC - 31 + i * 13)}" y="${f(ctx.y + 42)}" width="10" height="10" rx="2" fill="${c}" fill-opacity=".9"/>`, 0.15)
  }
  if (hidden > 0) svg += `<text x="${f(RC)}" y="${f(ctx.y + 67)}" text-anchor="middle" ${sans(10)} fill="${INK.textDim}">+${compact(hidden)} more line${hidden === 1 ? '' : 's'}</text>`
  const end =
    ctx.status === 'running'
      ? dots(ctx, RC - 34, ctx.y + 82, ctx.color) + `<text x="${f(RC - 12)}" y="${f(ctx.y + 86)}" ${mono(11)} fill="${INK.textDim}">editing</text>`
      : (() => {
          const w = overWord(ctx.status, isNew ? 'file written' : 'saved', 'not applied')
          return `<text x="${f(RC)}" y="${f(ctx.y + 86)}" text-anchor="middle" ${mono(11.5)} font-weight="700" fill="${w.color}">${esc(w.text)}</text>`
        })()
  svg += fadeIn(ctx, 1.1, end)
  return svg
}

export const sceneEdit = (s: Of<'edit'>, ctx: SceneCtx): string => {
  try {
    return edit(s && typeof s === 'object' ? s : { kind: 'edit', path: '', removed: 0, added: 0, minus: [], plus: [], isNew: false }, ctx)
  } catch {
    return ''
  }
}

// ------------------------------------------------------------------ web

const hostOf = (url: string): string => /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]+)/i.exec(url)?.[1] ?? ''

function web(s: Of<'web'>, ctx: SceneCtx): string {
  const url = flat(str(s.url)).trim()
  const query = flat(str(s.query)).trim()
  const domain = flat(str(s.domain)).trim() || hostOf(url)
  const isSearch = url === '' && query !== ''
  const shown = isSearch ? query : url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') || domain || '…'
  const X = ctx.x + 2
  const BY = ctx.y + 8
  const BW = 392
  const u = ctx.uid
  let svg = ''

  // the address / search bar, typed
  const room = fit(BW - 34 - 14, 12) - (isSearch ? 2 : 0)
  const body = isSearch ? `“${clipCols(shown, room)}”` : clipCols(shown, room)
  const cw = cols(body) * 7.22
  const typeDur = clamp(0.2 + cols(body) * 0.022, 0.35, 1.2)
  const icon = isSearch
    ? `<circle cx="${f(X + 17)}" cy="${f(BY + 13.5)}" r="5.2" fill="none" stroke="${ctx.color}" stroke-width="1.8"/><path d="M${f(X + 20.8)} ${f(BY + 17.3)}l4 4" stroke="${ctx.color}" stroke-width="2" stroke-linecap="round"/>`
    : `<rect x="${f(X + 12)}" y="${f(BY + 13)}" width="10" height="8" rx="1.5" fill="${ctx.color}"/><path d="M${f(X + 14.2)} ${f(BY + 13)}v-2.6a2.8 2.8 0 0 1 5.6 0v2.6" fill="none" stroke="${ctx.color}" stroke-width="1.6"/>`
  svg += `<rect x="${f(X)}" y="${f(BY)}" width="${BW}" height="30" rx="15" fill="${INK.sheet}" stroke="${ctx.color}" stroke-opacity=".55"/>` + icon
  const tx = X + 32
  const ty = BY + 19.5
  if (intro(ctx)) {
    svg +=
      `<clipPath id="${u}wt"><rect x="${f(tx - 1)}" y="${f(ty - 13)}" width="0" height="17"><animate attributeName="width" from="0" to="${f(cw + 2)}" dur="${f(typeDur)}s" fill="freeze"/></rect></clipPath>` +
      `<text x="${f(tx)}" y="${f(ty)}" ${mono(12)} fill="${INK.text}" clip-path="url(#${u}wt)">${esc(body.replace(BAD_UNITS, ''))}</text>` +
      `<rect x="${f(tx)}" y="${f(ty - 10.5)}" width="1.6" height="13" fill="${INK.text}"><animate attributeName="x" from="${f(tx)}" to="${f(tx + cw + 1)}" dur="${f(typeDur)}s" fill="freeze"/>${setA(ctx, `attributeName="opacity" to="0" begin="${f(typeDur + 0.2)}s" fill="freeze"`)}</rect>`
  } else {
    svg += `<text x="${f(tx)}" y="${f(ty)}" ${mono(12)} fill="${INK.text}">${esc(body.replace(BAD_UNITS, ''))}</text>`
  }
  // where it goes, and how it went
  const lineA = isSearch ? 'a search engine finds pages' : domain ? `site: ${domain}` : 'a web page'
  svg += fadeIn(ctx, typeDur, `<text x="${f(X + 14)}" y="${f(ctx.y + 58)}" ${sans(11)} fill="${INK.textDim}">${t(lineA, Math.floor((BW - 20) / 5.9))}</text>`)
  const oy = ctx.y + 80
  const outcome =
    ctx.status === 'running'
      ? dots(ctx, X + 17, oy - 4, ctx.color) + `<text x="${f(X + 42)}" y="${f(oy)}" ${mono(11)} fill="${INK.textDim}">${isSearch ? 'searching the web…' : 'fetching the page…'}</text>`
      : (() => {
          const w = overWord(ctx.status, isSearch ? 'got results' : 'page fetched', 'request failed')
          return `<text x="${f(X + 14)}" y="${f(oy)}" ${mono(11.5)} font-weight="700" fill="${w.color}">${esc(w.text)}</text>`
        })()
  svg += fadeIn(ctx, typeDur + 0.1, outcome)

  // the globe
  const R = 36
  const GX = ctx.x + ctx.w - R - 22
  const GY = ctx.y + 45
  const spin = live(ctx)
  let globe =
    `<circle cx="${f(GX)}" cy="${f(GY)}" r="${R + 7}" fill="${ctx.color}" fill-opacity=".07"/>` +
    `<circle cx="${f(GX)}" cy="${f(GY)}" r="${R}" fill="#072a35" stroke="${ctx.color}" stroke-width="1.5"/>` +
    `<path d="M${f(GX - R)} ${f(GY)}h${2 * R}M${f(GX - R * 0.866)} ${f(GY - R / 2)}h${f(R * 1.732)}M${f(GX - R * 0.866)} ${f(GY + R / 2)}h${f(R * 1.732)}M${f(GX)} ${f(GY - R)}v${2 * R}" stroke="${ctx.color}" stroke-opacity=".45"/>`
  const phases = [0, -1.33, -2.67]
  for (const [k, ph] of phases.entries()) {
    const still = [R * 0.45, R * 0.82, R * 0.2][k] ?? R * 0.5
    const a = spin ? `<animate attributeName="rx" values="${R};0;${R}" dur="4s" begin="${f(ph)}s" repeatCount="indefinite"/>` : ''
    globe += `<ellipse cx="${f(GX)}" cy="${f(GY)}" rx="${f(still)}" ry="${R}" fill="none" stroke="${ctx.color}" stroke-opacity=".6">${a}</ellipse>`
  }
  // two land masses for charm
  globe += `<path d="M${f(GX - 20)} ${f(GY - 16)}q8-6 15-1t4 9q-6 5-13 2t-6-10zM${f(GX + 6)} ${f(GY + 6)}q9-3 13 3t-3 13q-7 1-9-5t-1-11z" fill="${ctx.color}" fill-opacity=".28"/>`
  svg += fadeIn(ctx, 0, globe, 0.4)

  // packets out to the site and back
  const ax = X + BW + 8
  const ay = BY + 15
  const bx = GX - R - 6
  const out = `M${f(ax)} ${f(ay)}C${f(ax + 40)} ${f(ay)} ${f(bx - 40)} ${f(GY - 10)} ${f(bx)} ${f(GY - 10)}`
  const back = `M${f(bx)} ${f(GY + 10)}C${f(bx - 40)} ${f(GY + 10)} ${f(ax + 40)} ${f(ay + 26)} ${f(ax)} ${f(ay + 26)}`
  svg += `<path d="${out}" fill="none" stroke="${ctx.color}" stroke-opacity=".35" stroke-dasharray="3 4"/>`
  svg += `<path d="${back}" fill="none" stroke="${ctx.status === 'ok' ? INK.ok : isBad(ctx.status) ? INK.bad : '#475569'}" stroke-opacity=".45" stroke-dasharray="3 4"/>`
  if (spin) {
    for (let i = 0; i < 3; i++) {
      svg += `<circle r="2.6" fill="${ctx.color}"><animateMotion dur="1.5s" begin="${f(-i * 0.5)}s" repeatCount="indefinite" path="${out}"/></circle>`
      svg += `<rect x="-2.4" y="-2.4" width="4.8" height="4.8" rx="1" fill="${INK.ok}"><animateMotion dur="1.5s" begin="${f(-i * 0.5 - 0.25)}s" repeatCount="indefinite" path="${back}"/></rect>`
    }
  }
  return svg
}

export const sceneWeb = (s: Of<'web'>, ctx: SceneCtx): string => {
  try {
    return web(s && typeof s === 'object' ? s : { kind: 'web' }, ctx)
  } catch {
    return ''
  }
}

// ------------------------------------------------------------------ delegate

function delegate(s: Of<'delegate'>, ctx: SceneCtx): string {
  const all: unknown[] = Array.isArray(s.agents) ? s.agents : []
  const agents = all.slice(0, 4).map(a => {
    const o = (a && typeof a === 'object' ? a : {}) as { label?: unknown; type?: unknown; status?: unknown; doing?: unknown }
    return { label: flat(str(o.label)).trim(), type: flat(str(o.type)).trim(), status: asStatus(o.status), doing: flat(str(o.doing)).trim() }
  })
  const more = Math.max(0, all.length - agents.length)
  const n = agents.length
  // One helper: Claude on the left, a wide card. Two or more: Claude in the middle, helpers fanned out
  // to both sides, so no line ever crosses a card.
  const centred = n >= 2
  const HX = centred ? ctx.x + ctx.w / 2 : ctx.x + 28
  const HY = centred ? ctx.y + 36 : ctx.y + 40
  let svg = ''

  const hub =
    `<g transform="translate(${f(HX)} ${f(HY)})">${miniAvatar(13)}</g>` +
    `<text x="${f(HX)}" y="${f(HY + 28)}" text-anchor="middle" ${sans(9.5)} fill="${INK.textDim}">Claude</text>` +
    (more > 0 ? `<text x="${f(HX)}" y="${f(HY + 44)}" text-anchor="middle" ${sans(10.5)} font-weight="700" fill="${ctx.color}">+${compact(more)} more</text>` : '')
  if (n === 0) {
    return hub + `<text x="${f(ctx.x + 84)}" y="${f(HY + 4)}" ${sans(11)} fill="${INK.textDim}">${ctx.status === 'running' ? 'starting a helper agent…' : 'no helper agents'}</text>`
  }

  // where each card sits; `left` cards face the hub with their right edge
  const half = 44
  const sideW = ctx.w / 2 - half
  const cards = agents.map((a, i) => {
    if (!centred) return { a, x: ctx.x + 84, y: ctx.y + 18, w: ctx.w - 84, h: 50, left: false }
    const left = i % 2 === 0
    const x = left ? ctx.x : HX + half
    if (n === 2 || (n === 3 && i === 1)) return { a, x, y: ctx.y + 16, w: sideW, h: 52, left }
    return { a, x, y: ctx.y + 2 + Math.floor(i / 2) * 45, w: sideW, h: 41, left }
  })

  let lines = ''
  let bodies = ''
  let flyers = ''
  cards.forEach((c, i) => {
    const my = c.y + c.h / 2
    const ax = c.left ? c.x + c.w - 18 : c.x + 18
    const sx = c.left ? HX - 15 : HX + 15
    const ex = c.left ? c.x + c.w : c.x
    const bend = c.left ? -1 : 1
    const path = `M${f(sx)} ${f(HY)}C${f(sx + bend * 24)} ${f(HY)} ${f(ex - bend * 24)} ${f(my)} ${f(ex)} ${f(my)}`
    const color = c.a.status === 'ok' ? INK.ok : isBad(c.a.status) ? INK.bad : ctx.color
    lines += `<path d="${path}" fill="none" stroke="${color}" stroke-opacity=".5" stroke-width="1.3" stroke-dasharray="3 3"/>`
    if (c.a.status === 'running' && live(ctx)) {
      lines += `<circle r="2.4" fill="${ctx.color}"><animateMotion dur="1.4s" begin="${f(-i * 0.35)}s" repeatCount="indefinite" path="${path}"/></circle>`
    }

    // the card: [mark] label · type / doing, with the helper's avatar on the side facing Claude
    const agentCtx: SceneCtx = { ...ctx, status: c.a.status, isFresh: false }
    const tall = c.h > 45
    const ly = tall ? c.y + 22 : c.y + 16.5
    const markX = c.left ? c.x + 13 : c.x + 37
    const tx = markX + 10
    const right = c.left ? c.x + c.w - 32 : c.x + c.w - 10
    const labelRoom = Math.max(4, Math.floor((right - tx) / 6.4))
    const label = clip(c.a.label || c.a.type || 'agent', labelRoom)
    const typeRoom = labelRoom - label.length - 3
    // the helper's type ('Explore') only when it fits whole: a cut type reads as noise
    const typeTxt = c.a.type && c.a.type !== c.a.label && c.a.type.length <= Math.min(typeRoom, 18) ? `<tspan ${sans(10)} font-weight="400" fill="${INK.textFaint}"> · ${t(c.a.type, 18)}</tspan>` : ''
    const doing = c.a.doing || (c.a.status === 'running' ? 'working…' : c.a.status === 'ok' ? 'finished' : c.a.status === 'denied' ? 'not allowed' : 'stopped with an error')
    const body =
      `<rect x="${f(c.x)}" y="${f(c.y)}" width="${f(c.w)}" height="${c.h}" rx="8" fill="${INK.sheet}" stroke="${c.a.status === 'running' ? ctx.color : INK.sheetStroke}" stroke-opacity="${c.a.status === 'running' ? 0.5 : 1}"/>` +
      statusMark(agentCtx, markX, ly - 4) +
      `<text x="${f(tx)}" y="${f(ly)}" ${sans(11)} font-weight="700" fill="${INK.text}">${esc(label.replace(BAD_UNITS, ''))}${typeTxt}</text>` +
      `<text x="${f(markX - 4)}" y="${f(ly + 15.5)}" ${sans(10.5)} fill="${INK.textDim}">${t(doing, Math.max(4, Math.floor((right - markX + 4) / 5.5)))}</text>`
    bodies += fadeIn(ctx, 0.3 + i * 0.12, body)

    // the helper's avatar flies out of the hub and lands on its card
    const mini = `<g>${live(ctx) && c.a.status === 'running' ? animT(ctx, `attributeName="transform" type="translate" values="0 0;0 -1.8;0 0" dur="1.2s" begin="${f(i * 0.3)}s" repeatCount="indefinite"`) : ''}${miniAvatar(8)}</g>`
    if (intro(ctx)) {
      const rel = `M0 0C${f(bend * 24)} 0 ${f(ex - bend * 24 - HX)} ${f(my - HY)} ${f(ax - HX)} ${f(my - HY)}`
      flyers += `<g transform="translate(${f(HX)} ${f(HY)})"><g opacity="0">${setA(ctx, `attributeName="opacity" to="1" begin="${f(0.1 + i * 0.12)}s" fill="freeze"`)}${animM(ctx, `path="${rel}" begin="${f(0.1 + i * 0.12)}s" dur=".55s" fill="freeze" calcMode="spline" keyPoints="0;1" keyTimes="0;1" keySplines=".3 0 .2 1"`)}${mini}</g></g>`
    } else {
      flyers += `<g transform="translate(${f(ax)} ${f(my)})">${mini}</g>`
    }
  })
  return lines + bodies + hub + flyers
}

export const sceneDelegate = (s: Of<'delegate'>, ctx: SceneCtx): string => {
  try {
    return delegate(s && typeof s === 'object' ? s : { kind: 'delegate', agents: [] }, ctx)
  } catch {
    return ''
  }
}

