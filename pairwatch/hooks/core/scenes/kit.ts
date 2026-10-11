// Shared drawing helpers for the stage and its scenes. Pure string building, no `$`.
import type { StepStatus } from '../../../types'

/** The box a scene draws in (inside the stage's panel), plus what it needs to know. */
export type SceneCtx = {
  x: number
  y: number
  w: number
  h: number
  status: StepStatus
  /** the step just started: play intro animations (typing, sliding in); otherwise draw the settled state */
  isFresh: boolean
  /** paused: draw the settled state with no looping animation */
  isPaused: boolean
  /** the station's accent colour */
  color: string
  /** prefix for ids inside <defs> (clipPath, gradient) so ids never collide */
  uid: string
}

export const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace"
export const SANS = "system-ui,-apple-system,'Segoe UI',Roboto,Ubuntu,sans-serif"

/** Palette of the dark stage card (works on light and dark editor themes alike). */
export const INK = {
  card: '#0c1424',
  panel: '#0a1120',
  panelStroke: '#18233a',
  sheet: '#0f1a2e',
  sheetStroke: '#2a3a58',
  sheetBar: '#16233b',
  term: '#060b16',
  termStroke: '#1f2a40',
  line1: '#334155',
  line2: '#3b4a63',
  line3: '#2f3d55',
  text: '#e2e8f0',
  textSoft: '#cbd5e1',
  textDim: '#94a3b8',
  textFaint: '#64748b',
  gutter: '#475569',
  ok: '#4ade80',
  bad: '#f87171',
  badSoft: '#fca5a5',
  warn: '#fbbf24',
  match: '#facc15',
  avatar: '#e07a5f',
} as const

/** Escape text for SVG text nodes and attribute values. Also drops control characters SVG cannot hold. */
export const esc = (s: string): string =>
  s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

/** Cut to n characters with an ellipsis. Newlines and tabs become spaces. */
export const clip = (s: string, n: number): string => {
  const flat = s.replace(/[\t\r\n]+/g, ' ')
  return flat.length > n ? flat.slice(0, Math.max(0, n - 1)) + '…' : flat
}

/** Cut a path from the left, keeping its tail: '…/auth/login.py'. */
export const clipLeft = (s: string, n: number): string => (s.length > n ? '…' + s.slice(s.length - (n - 1)) : s)

/** Deterministic 32-bit hash (FNV-1a): stable "random" shapes across redraws. */
export const hash = (s: string): number => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/** A small seeded PRNG in [0, 1). */
export const rand = (seed: number): (() => number) => {
  let x = seed >>> 0 || 1
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    return x / 4294967296
  }
}

/** Approximate advance of monospace text at a font size (for typing clips and cursors). */
export const monoWidth = (chars: number, fontSize: number): number => chars * fontSize * 0.6

/** An SMIL <animate> that only exists when animation is allowed. */
export const anim = (ctx: SceneCtx, attrs: string): string => (ctx.isPaused ? '' : `<animate ${attrs}/>`)

/** Status mark: a pulsing dot while running, a check when ok, a cross on error/denied. Centred on (x, y). */
export const statusMark = (ctx: SceneCtx, x: number, y: number): string =>
  ctx.status === 'running'
    ? `<circle cx="${x}" cy="${y}" r="3.2" fill="${ctx.color}">${anim(ctx, 'attributeName="opacity" values="1;.25;1" dur="1s" repeatCount="indefinite"')}</circle>`
    : ctx.status === 'ok'
      ? `<path d="M${x - 3.5} ${y}l2.3 2.4 4.7-5" stroke="${INK.ok}" stroke-width="1.8" fill="none" stroke-linecap="round"/>`
      : `<path d="M${x - 3} ${y - 3}l6 6M${x + 3} ${y - 3}l-6 6" stroke="${INK.bad}" stroke-width="1.8" stroke-linecap="round"/>`

export const isOver = (status: StepStatus): boolean => status !== 'running'
