// The animated stage: one self-contained <svg> string. Pure, no `$`.
// Contract: the exported names and types below.
//
// Layout (viewBox 0 0 640 246): the coral avatar stands on the active rail stop (y 58); the panel
// (y 96..216) holds the header (verb + title) and the station's mini-scene (box 24..616 x 122..212);
// the timeline trail of recent steps and the stats run along the bottom (y 227).
// Animation is SMIL only. isFresh plays intros (hop, typing, slide-ins); isPaused draws a static picture
// with no animation element at all.
import type { SceneData, Station, StepStatus } from '../../types'
import { COLOR, RAIL, RAIL_STOP, verbFor } from './stations.ts'
import { INK, MONO, SANS, clip, esc, hash, statusMark, type SceneCtx } from './scenes/kit.ts'
import { compact, f, flat, sansWidth, sceneDelegate, sceneEdit, sceneRead, sceneRun, sceneSearch, sceneWeb, str, t, tm } from './scenes/work.ts'
import { sceneAsk, sceneDone, sceneIdle, scenePlan, sceneTalk, sceneThink, sceneTools } from './scenes/flow.ts'

export type StageInput = {
  station: Station
  /** set while the avatar should hop in from another stop */
  hopFrom?: Station
  status: StepStatus
  /** header text after the verb: a command, a path, a query (plain; the renderer escapes and cuts) */
  title: string
  scene: SceneData
  /** recent steps, oldest first (the renderer shows the last ~38) */
  trail: readonly { station: Station; status: StepStatus }[]
  stats: { steps: number; files: number; edits: number; elapsed: string }
  /** true when the step just started: typing / intro animations play; false on later redraws of the same step */
  isFresh: boolean
  isPaused: boolean
  /** e.g. 'sub-agent: Explore' when the activity runs inside a sub-agent */
  lane?: string
}

const W = 640
const H = 246
const RAIL_Y = 58
/** the avatar's feet rest on the top of the active stop's halo */
const FEET_Y = 39
const PANEL = { x: 12, y: 96, w: 616, h: 120 }
const HEAD_Y = 114
const BOX = { x: 24, y: 122, w: 592, h: 90 }
const TL_Y = 227
const MAX_PILLS = 38
/** the whole document stays under this (the Svg element accepts 131 072) */
const LIMIT = 60000
/** a scene that grows past this is replaced by a quiet placeholder */
const SCENE_BUDGET = 36000

// 22x22 line icons centred on (0,0), stroked with the stop's colour.
const ICONS: Record<string, string> = {
  think: '<path d="M-5 6h10M-4 9h8M0-10a7 7 0 0 1 4.5 12.4c-.9.8-1.5 1.6-1.5 2.6h-6c0-1-.6-1.8-1.5-2.6A7 7 0 0 1 0-10z"/>',
  plan: '<path d="M-9-7l2 2 3-4M-1-6h10M-9 1l2 2 3-4M-1 0h10M-9 8h4M-1 7h10"/>',
  search: '<circle cx="-2" cy="-2" r="6.5"/><path d="M3 3l6 6"/>',
  read: '<path d="M-7-10h9l5 5v15h-14zM2-10v5h5M-4-2h8M-4 2h8M-4 6h5"/>',
  edit: '<path d="M-8 8l2-6 10-10 4 4-10 10zM2-6l4 4M-8 8l4-1"/>',
  run: '<rect x="-10" y="-8" width="20" height="16" rx="2"/><path d="M-6-3l3 3-3 3M0 4h5"/>',
  web: '<circle r="9"/><ellipse rx="4" ry="9"/><path d="M-9 0h18"/>',
  delegate: '<circle cx="0" cy="-5" r="3"/><circle cx="-7" cy="1" r="2.5"/><circle cx="7" cy="1" r="2.5"/><path d="M-5 9a5 4 0 0 1 10 0M-11 9a4 3 0 0 1 6-2M11 9a4 3 0 0 0-6-2"/>',
  tools: '<path d="M4-9a5 5 0 0 0-6 6l-7 7 3 3 7-7a5 5 0 0 0 6-6l-3 3-3-1-1-3z"/>',
  ask: '<path d="M-9-8h18v12h-8l-5 5v-5h-5zM-3-4a3 3 0 1 1 3 3v1.5"/><circle cx="0" cy="2.8" r=".6"/>',
}

// ------------------------------------------------------------------ small helpers
// (f, str, tm, compact and sansWidth come from scenes/work.ts, so the frame and the scenes cut text alike)

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)

const STATUSES: readonly StepStatus[] = ['running', 'ok', 'error', 'denied']
const isStation = (v: unknown): v is Station => typeof v === 'string' && Object.prototype.hasOwnProperty.call(RAIL_STOP, v)
const isStatus = (v: unknown): v is StepStatus => typeof v === 'string' && (STATUSES as readonly string[]).includes(v)

const railX = (i: number): number => 36 + (i * (W - 72)) / (RAIL.length - 1)
const railIndex = (s: Station): number => Math.max(0, RAIL.findIndex(r => r.id === RAIL_STOP[s]))

// ------------------------------------------------------------------ the rail

function rail(station: Station, color: string, paused: boolean, visited: ReadonlySet<Station>): string {
  const cur = railIndex(station)
  let out = `<path d="M${f(railX(0))} ${RAIL_Y}H${f(railX(RAIL.length - 1))}" stroke="#1b2740" stroke-width="2" stroke-dasharray="2 5"/>`
  RAIL.forEach((stop, i) => {
    const active = i === cur
    const c = active ? color : COLOR[stop.id]
    const halo = active
      ? `<circle r="19" fill="${c}" fill-opacity=".16" stroke="${c}" stroke-opacity=".7" stroke-width="1.2">` +
        (paused
          ? ''
          : '<animate attributeName="r" values="17;21;17" dur="1.8s" repeatCount="indefinite"/>' +
            '<animate attributeName="stroke-opacity" values=".8;.25;.8" dur="1.8s" repeatCount="indefinite"/>') +
        '</circle>'
      : `<circle r="15" fill="#0f1a2e" stroke="${visited.has(stop.id) ? c : '#1e2b44'}" stroke-opacity="${visited.has(stop.id) ? '.45' : '1'}"/>`
    const ink = active ? c : visited.has(stop.id) ? '#7a8aa6' : '#5b6b86'
    out +=
      `<g transform="translate(${f(railX(i))} ${RAIL_Y})">${halo}` +
      `<g fill="none" stroke="${ink}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" transform="scale(.82)">${ICONS[stop.id] ?? ''}</g>` +
      `<text y="30" text-anchor="middle" font-family="${SANS}" font-size="${active ? 10 : 9.5}" font-weight="${active ? 700 : 500}" fill="${active ? c : '#6b7a93'}" letter-spacing=".3">${esc(stop.label)}</text></g>`
  })
  return out
}

// ------------------------------------------------------------------ the avatar

/**
 * The coral spark, standing on the active stop. Its origin is at its feet, so the landing squash
 * presses it into the ground. A hop is a run of small bounces (the card leaves little headroom).
 */
function avatar(x: number, hop: { dx: number } | null, status: StepStatus, paused: boolean, uid: string): string {
  let motion = ''
  let landAt = 0
  if (hop && !paused) {
    const dist = Math.abs(hop.dx)
    if (dist < 1) {
      landAt = 0.5
      motion = `<animateMotion dur=".5s" fill="freeze" calcMode="spline" keyPoints="0;1" keyTimes="0;1" keySplines=".25 .1 .25 1" path="M0 0Q0 -20 0 0"/>`
    } else {
      const k = Math.max(1, Math.min(6, Math.round(dist / 95)))
      landAt = Math.min(1.4, 0.3 + 0.22 * k)
      let d = `M${f(hop.dx)} 0`
      for (let j = 0; j < k; j++) {
        const x0 = hop.dx * (1 - j / k)
        const x1 = hop.dx * (1 - (j + 1) / k)
        d += `Q${f((x0 + x1) / 2)} -20 ${f(x1)} 0`
      }
      motion = `<animateMotion dur="${f(landAt)}s" fill="freeze" calcMode="spline" keyPoints="0;1" keyTimes="0;1" keySplines=".3 0 .35 1" path="${d}"/>`
    }
  }
  const bob = paused
    ? ''
    : `<animateTransform attributeName="transform" type="translate" values="0 0;0 -2.5;0 0" dur="1.4s" begin="${f(landAt)}s" repeatCount="indefinite"/>`
  const squash =
    motion === ''
      ? ''
      : `<animateTransform attributeName="transform" type="scale" values="1 1;1.16 .82;1 1" begin="${f(landAt)}s" dur=".26s"/>`
  const blink = (base: string) =>
    paused ? '' : `<animate attributeName="ry" values="${base};${base};.3;${base}" keyTimes="0;.92;.96;1" dur="3.2s" repeatCount="indefinite"/>`
  const eyes = paused
    ? '<path d="M-5.8-11q2.1 1.8 4.2 0M1.6-11q2.1 1.8 4.2 0" stroke="#1d2433" stroke-width="1.4" fill="none" stroke-linecap="round"/>'
    : `<g fill="#fff"><ellipse cx="-3.6" cy="-11" rx="2.2" ry="2.7">${blink('2.7')}</ellipse><ellipse cx="3.6" cy="-11" rx="2.2" ry="2.7">${blink('2.7')}</ellipse></g>` +
      `<g fill="#1d2433"><ellipse cx="-3.1" cy="-10.6" rx="1.15" ry="1.15">${blink('1.15')}</ellipse><ellipse cx="4.1" cy="-10.6" rx="1.15" ry="1.15">${blink('1.15')}</ellipse></g>`
  const mouth =
    status === 'ok'
      ? '<path d="M-2.8-5.6q2.8 2.6 5.6 0" stroke="#6b2414" stroke-width="1.3" fill="none" stroke-linecap="round"/>'
      : status === 'running'
        ? '<ellipse cx="0" cy="-4.9" rx="1.3" ry="1.1" fill="#6b2414"/>'
        : '<path d="M-2.6-4.1q2.6-2.2 5.2 0" stroke="#6b2414" stroke-width="1.3" fill="none" stroke-linecap="round"/>'
  const extra =
    status === 'error' || status === 'denied'
      ? '<path d="M11.6-21.5c1.7 2.5 2.5 3.6 2.5 4.6a2.5 2.5 0 0 1-5 0c0-1 .8-2.1 2.5-4.6z" fill="#7dd3fc"/>'
      : ''
  const zz = paused
    ? `<text x="11" y="-21" font-family="${SANS}" font-size="9" font-weight="700" fill="#94a3b8">z<tspan x="16" y="-28" font-size="10">z</tspan></text>`
    : ''
  return (
    `<g transform="translate(${f(x)} ${FEET_Y})"><g>${motion}<g>${bob}<g>${squash}` +
    '<path d="M0-20v-4.5" stroke="#f0a58a" stroke-width="1.6" stroke-linecap="round"/>' +
    '<circle cy="-26.3" r="2" fill="#ffd2c2"/>' +
    `<circle cy="-10" r="10.5" fill="${INK.avatar}"/><circle cy="-10" r="10.5" fill="url(#${uid}sh)"/>` +
    '<g fill="#f59e86" fill-opacity=".55"><ellipse cx="-6.6" cy="-6.6" rx="1.9" ry="1.3"/><ellipse cx="6.6" cy="-6.6" rx="1.9" ry="1.3"/></g>' +
    eyes +
    mouth +
    extra +
    zz +
    '</g></g></g></g>'
  )
}

// ------------------------------------------------------------------ the header

function header(station: Station, status: StepStatus, title: string, lane: string, paused: boolean, ctx: SceneCtx): string {
  const verb = verbFor(station, status)
  const color = ctx.color
  let right = PANEL.x + PANEL.w - 12
  let tags = ''
  if (paused) {
    const w = 54
    const x = right - w
    tags +=
      `<g transform="translate(${f(x)} ${HEAD_Y - 10.5})"><rect width="${w}" height="14" rx="7" fill="#1e293b" stroke="#334155"/>` +
      '<rect x="8" y="3.5" width="2" height="7" rx=".6" fill="#cbd5e1"/><rect x="12" y="3.5" width="2" height="7" rx=".6" fill="#cbd5e1"/>' +
      `<text x="18" y="10.6" font-family="${SANS}" font-size="9.5" fill="#cbd5e1">paused</text></g>`
    right = x - 8
  }
  if (lane) {
    const label = clip(flat(lane.slice(0, 400)), 32)
    const w = sansWidth(label, 9.5) + 12
    tags +=
      `<circle cx="${f(right - w + 3)}" cy="${HEAD_Y - 3.5}" r="2.6" fill="${COLOR.delegate}" fill-opacity=".8"/>` +
      `<text x="${f(right)}" y="${HEAD_Y}" text-anchor="end" font-family="${SANS}" font-size="9.5" fill="${INK.textDim}">${t(label, 32)}</text>`
    right -= w + 10
  }
  const titleX = 40 + verb.length * 8.9 + 9
  const room = Math.floor((right - titleX) / 7.22)
  const body = title && room >= 4 ? `<tspan dx="9" font-family="${MONO}" font-size="12" font-weight="400" letter-spacing="0" fill="${INK.textSoft}">${tm(title, room)}</tspan>` : ''
  return (
    statusMark(ctx, 30, HEAD_Y - 4) +
    `<text x="40" y="${HEAD_Y}" font-family="${SANS}" font-size="10.5" font-weight="700" letter-spacing="1.2" fill="${color}">${esc(verb)}${body}</text>` +
    tags
  )
}

// ------------------------------------------------------------------ the timeline trail

function trailStrip(input: StageInput, trail: readonly { station: Station; status: StepStatus }[], fresh: boolean): string {
  const s = input.stats ?? ({} as StageInput['stats'])
  const plural = (n: number, one: string) => `${compact(n)} ${one}${n === 1 ? '' : 's'}`
  const parts = [plural(count(s.steps), 'step'), plural(count(s.files), 'file'), plural(count(s.edits), 'edit')]
  const elapsed = clip(flat(str(s.elapsed).slice(0, 200)).trim(), 12)
  if (elapsed) parts.push(elapsed)
  const stats = clip(parts.join(' · '), 64)
  const statsW = sansWidth(stats, 9.5)
  const room = Math.floor((W - 18 - statsW - 14 - 18) / 11)
  const n = Math.max(0, Math.min(MAX_PILLS, room, trail.length))
  const shown = trail.slice(trail.length - n)
  const running = input.status === 'running'
  let pills = ''
  shown.forEach((step, i) => {
    const last = i === shown.length - 1
    const c = COLOR[isStation(step?.station) ? step.station : 'idle']
    const bad = step?.status === 'error' || step?.status === 'denied'
    const stroke = bad ? ` stroke="${INK.bad}" stroke-width="1.3"` : ''
    let a = ''
    if (last && !input.isPaused) {
      if (fresh) a += '<animate attributeName="opacity" from="0" to="1" dur=".35s" fill="freeze"/>'
      if (running) a += '<animate attributeName="fill-opacity" values="1;.3;1" dur="1s" repeatCount="indefinite"/>'
    }
    pills += `<rect x="${18 + i * 11}" y="${TL_Y}" width="8" height="8" rx="2" fill="${c}" fill-opacity="${last ? 1 : bad ? 0.75 : 0.55}"${stroke}>${a}</rect>`
  })
  return pills + `<text x="${W - 18}" y="${TL_Y + 7.5}" text-anchor="end" font-family="${SANS}" font-size="9.5" fill="#6b7a93">${t(stats, 64)}</text>`
}

// ------------------------------------------------------------------ scenes

// Escaped text never holds a raw '<' or quote, so these only ever match real markup: scripts, embedded
// documents, event handlers, and references that leave the document.
const UNSAFE = /<\s*(script|foreignObject|iframe|embed|object)\b|\son[a-z]+\s*=\s*["']|(?:href|src)\s*=\s*["'](?!#)|=\s*["'][^"'<>]*url\(\s*(?!["']?#)/i

function scene(s: SceneData | undefined, ctx: SceneCtx): string {
  let out = ''
  try {
    const kind = s && typeof s === 'object' ? s.kind : 'idle'
    switch (kind) {
      case 'run': out = sceneRun(s as Extract<SceneData, { kind: 'run' }>, ctx); break
      case 'read': out = sceneRead(s as Extract<SceneData, { kind: 'read' }>, ctx); break
      case 'search': out = sceneSearch(s as Extract<SceneData, { kind: 'search' }>, ctx); break
      case 'edit': out = sceneEdit(s as Extract<SceneData, { kind: 'edit' }>, ctx); break
      case 'web': out = sceneWeb(s as Extract<SceneData, { kind: 'web' }>, ctx); break
      case 'delegate': out = sceneDelegate(s as Extract<SceneData, { kind: 'delegate' }>, ctx); break
      case 'plan': out = scenePlan(s as Extract<SceneData, { kind: 'plan' }>, ctx); break
      case 'ask': out = sceneAsk(s as Extract<SceneData, { kind: 'ask' }>, ctx); break
      case 'tools': out = sceneTools(s as Extract<SceneData, { kind: 'tools' }>, ctx); break
      case 'think': out = sceneThink(s as Extract<SceneData, { kind: 'think' }>, ctx); break
      case 'talk': out = sceneTalk(s as Extract<SceneData, { kind: 'talk' }>, ctx); break
      case 'done': out = sceneDone(s as Extract<SceneData, { kind: 'done' }>, ctx); break
      default: out = sceneIdle({ kind: 'idle' }, ctx)
    }
  } catch {
    out = ''
  }
  if (typeof out !== 'string' || out.length > SCENE_BUDGET || UNSAFE.test(out)) out = ''
  // A paused stage carries no animation at all, whatever a scene drew.
  if (ctx.isPaused && /<(animate|set)\b/.test(out)) out = out.replace(/<(animate|animateTransform|animateMotion|set)\b[^>]*\/>/g, '')
  return out
}

// ------------------------------------------------------------------ the document

const open = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">`
const FALLBACK = `${open}<rect width="${W}" height="${H}" rx="12" fill="${INK.card}"/><text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-family="${SANS}" font-size="12" fill="${INK.textFaint}">Pairwatch</text></svg>`

function draw(input: StageInput, withScene: boolean): string {
  const station: Station = isStation(input.station) ? input.station : 'idle'
  const status: StepStatus = isStatus(input.status) ? input.status : 'running'
  const paused = input.isPaused === true
  const fresh = input.isFresh === true && !paused
  const color = COLOR[station]
  const title = str(input.title)
  const lane = str(input.lane).trim()
  const trailIn: unknown = input.trail
  const trail = (Array.isArray(trailIn) ? (trailIn as unknown[]).slice(-MAX_PILLS) : []).filter(
    (step): step is { station: Station; status: StepStatus } => !!step && typeof step === 'object',
  )
  const sceneIn = input.scene && typeof input.scene === 'object' ? input.scene : ({ kind: 'idle' } as SceneData)
  const uid = 'tu' + hash(`${station}|${status}|${title.slice(0, 400)}|${str((sceneIn as { kind?: unknown }).kind)}`).toString(36)
  const ctx: SceneCtx = { ...BOX, status, isFresh: fresh, isPaused: paused, color, uid: uid + '-' }

  // stops used in the last few steps get a tinted ring: where Claude has just been
  const visited = new Set<Station>()
  for (const step of trail.slice(-8)) if (isStation(step.station)) visited.add(RAIL_STOP[step.station])

  const x = railX(railIndex(station))
  const from = isStation(input.hopFrom) && input.hopFrom !== station && fresh ? railX(railIndex(input.hopFrom)) : null
  const hop = from === null ? null : { dx: from - x }

  return (
    open +
    `<defs><linearGradient id="${uid}bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${INK.card}"/><stop offset="1" stop-color="#0a101d"/></linearGradient>` +
    `<radialGradient id="${uid}sh" cx=".35" cy=".3" r=".7"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset=".6" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>` +
    `<rect width="${W}" height="${H}" rx="12" fill="url(#${uid}bg)"/>` +
    rail(station, color, paused, visited) +
    `<rect x="${PANEL.x}" y="${PANEL.y}" width="${PANEL.w}" height="${PANEL.h}" rx="10" fill="${INK.panel}" stroke="${INK.panelStroke}"/>` +
    `<path d="M${PANEL.x + 1} ${PANEL.y + 12}a11 11 0 0 1 11-11" fill="none" stroke="${color}" stroke-opacity=".55" stroke-width="1.6" stroke-linecap="round"/>` +
    header(station, status, title, lane, paused, ctx) +
    (withScene ? `<g>${scene(sceneIn, ctx)}</g>` : '') +
    trailStrip(input, trail, fresh) +
    avatar(x, hop, status, paused, uid) +
    '</svg>'
  )
}

/** The whole stage as an <svg> document (viewBox 0 0 640 246, explicit width/height). < 60 000 chars. Never throws. */
export function renderStage(input: StageInput): string {
  try {
    const safe = input && typeof input === 'object' ? input : ({} as StageInput)
    const out = draw(safe, true)
    if (out.length < LIMIT) return out
    const bare = draw(safe, false)
    return bare.length < LIMIT ? bare : FALLBACK
  } catch {
    return FALLBACK
  }
}
