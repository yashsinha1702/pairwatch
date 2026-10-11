// Replay real Claude Code transcripts through the explainer and print quality metrics.
//
//   node dev/eval-corpus.ts [--out DIR] [--limit N] [--root DIR]
//
// Reads ~/.claude/projects/**/*.jsonl in place: each session's main transcript (<session-id>.jsonl)
// and its sub-agents' (agent-<id>.jsonl). Every tool_use row becomes a ToolObs (string args cut to
// 4000 chars, as the mod's hook does, at every depth), its tool_result row a ToolEnd (preview = the
// text blocks, first 1500 chars). Each call runs explainTool then applyEnd; readPaths accumulate per
// transcript (one agent's context) from successful Read / Write / Edit calls. Nothing is copied into
// the repo: the 60-row sample report and the metrics go to --out (default: a new private temp
// folder). The report quotes your own sessions: keep it out of the repository.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { isConceptId } from '../pairwatch/hooks/core/concept-ids.ts'
import { applyEnd, explainTool, type ExplainCtx } from '../pairwatch/hooks/core/explain.ts'
import type { Step, ToolEnd, ToolObs } from '../pairwatch/types'

// ---------------------------------------------------------------- options

const argv = process.argv.slice(2)
const option = (flag: string): string | undefined => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('usage: node dev/eval-corpus.ts [--out DIR] [--limit N] [--root DIR]')
  process.exit(0)
}
const OUT_ARG = option('--out')
const LIMIT = option('--limit') !== undefined ? Math.max(1, Number(option('--limit'))) : Number.POSITIVE_INFINITY
const ROOT = option('--root') ?? join(homedir(), '.claude', 'projects')

/** The keys the mod's tool.call hook strips from the event's flat input: the engine's, not the tool's arguments. */
const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent'])
const ARG_CUT = 4000
const PREVIEW_CUT = 1500
const SCENE_OF: Record<string, string> = {
  think: 'think', plan: 'plan', search: 'search', read: 'read', edit: 'edit', run: 'run', web: 'web',
  delegate: 'delegate', tools: 'tools', ask: 'ask', talk: 'talk', done: 'done', idle: 'idle',
}

// ---------------------------------------------------------------- transcripts

type Row = { [k: string]: unknown }
const isObj = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v)

function transcriptFiles(root: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(root, { recursive: true }) as string[]
  } catch {
    return []
  }
  return entries
    .filter(rel => {
      const name = basename(rel)
      return /^[0-9a-f]{8}-[0-9a-f-]{27}\.jsonl$/.test(name) || /^agent-[\w-]+\.jsonl$/.test(name)
    })
    .map(rel => join(root, rel))
    .sort()
}

/** A tool argument as the mod's hook passes it (register.tsx plain()): strings cut, deep or huge structures bounded. */
function plain(v: unknown, depth: number): unknown {
  if (typeof v === 'string') return v.length > ARG_CUT ? v.slice(0, ARG_CUT) : v
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean' || v === null) return v
  if (depth >= 4) return undefined
  if (Array.isArray(v)) return v.slice(0, 200).map(x => plain(x, depth + 1) ?? null)
  if (isObj(v)) {
    const out: Row = {}
    let n = 0
    for (const [k, x] of Object.entries(v)) {
      if (n++ >= 100) break
      const p = plain(x, depth + 1)
      if (p !== undefined) out[k] = p
    }
    return out
  }
  return undefined
}

/** A long shell command keeps its head and tail, as register.tsx's cutCommand does. */
const cutCommand = (s: string): string => (s.length <= ARG_CUT ? s : `${s.slice(0, 2800)}\n${s.slice(s.length - (ARG_CUT - 2800 - 1))}`)

function argsOf(input: unknown): { [k: string]: unknown } {
  const out: { [k: string]: unknown } = {}
  if (!isObj(input)) return out
  for (const [k, v] of Object.entries(input)) {
    if (RESERVED.has(k)) continue
    const p = k === 'command' && typeof v === 'string' ? cutCommand(v) : plain(v, 0)
    if (p !== undefined) out[k] = p
  }
  return out
}

/** The result as the model reads it, text blocks joined (what the hook's ran.text holds). */
function previewOf(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, PREVIEW_CUT)
  if (!Array.isArray(content)) return ''
  return content
    .map(b => (isObj(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .filter(t => t !== '')
    .join('\n')
    .slice(0, PREVIEW_CUT)
}

// ---------------------------------------------------------------- replay

type Result = {
  file: string
  isSub: boolean
  tool: string
  station: string
  headline: string
  why: string
  detail?: string
  concepts: string[]
  resultNote?: string
  /** status after applyEnd ('running' when the transcript has no result) */
  status: string
  /** the transcript's own denial kind, to check refusals are recognised */
  denialKind?: string
  hasDescription: boolean
  usedDescription: boolean
  sceneOk: boolean
  explainMs: number
  endMs: number
  threw: boolean
}

const results: Result[] = []
const files = transcriptFiles(ROOT)
let mainFiles = 0
let subFiles = 0

outer: for (const file of files) {
  const isSub = basename(file).startsWith('agent-')
  if (isSub) subFiles++
  else mainFiles++
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const seen = new Set<string>()
  const pending = new Map<string, { step: Step; index: number }>()
  const readPaths: string[] = []
  let cwd: string | undefined
  for (const line of text.split('\n')) {
    if (line === '') continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObj(row)) continue
    if (typeof row.uuid === 'string') {
      if (seen.has(row.uuid)) continue
      seen.add(row.uuid)
    }
    if (typeof row.cwd === 'string') cwd = row.cwd
    const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) || 0 : 0
    const message = isObj(row.message) ? row.message : undefined
    const content = message !== undefined && Array.isArray(message.content) ? message.content : []
    const ctx: ExplainCtx = cwd === undefined ? { level: 2, readPaths } : { level: 2, cwd, readPaths }
    if (row.type === 'assistant') {
      for (const b of content) {
        if (!isObj(b) || b.type !== 'tool_use' || typeof b.id !== 'string' || typeof b.name !== 'string') continue
        if (results.length >= LIMIT) break outer
        const obs: ToolObs = { id: b.id, tool: b.name, args: argsOf(b.input), at }
        if (typeof row.agentId === 'string') obs.agentId = row.agentId
        let step: Step
        let threw = false
        const t0 = performance.now()
        try {
          step = explainTool(obs, ctx)
        } catch {
          threw = true
          step = { id: b.id, tool: b.name, station: 'tools', headline: '', why: '', concepts: [], scene: { kind: 'tools', name: b.name }, status: 'running', startedAt: at }
        }
        const explainMs = performance.now() - t0
        const desc = typeof obs.args.description === 'string' && obs.args.description.trim() !== '' ? obs.args.description : undefined
        results.push({
          file,
          isSub,
          tool: b.name,
          station: step.station,
          headline: step.headline,
          why: step.why,
          concepts: step.concepts,
          status: step.status,
          hasDescription: b.name === 'Bash' && desc !== undefined,
          usedDescription: b.name === 'Bash' && desc !== undefined && step.headline.replace(/…$/, '').length > 0 && desc.replace(/\s+/g, ' ').trim().toLowerCase().startsWith(step.headline.replace(/…$/, '').toLowerCase()),
          sceneOk: SCENE_OF[step.station] === step.scene.kind,
          explainMs,
          endMs: 0,
          threw,
          ...(step.detail === undefined ? {} : { detail: step.detail }),
        })
        pending.set(b.id, { step, index: results.length - 1 })
      }
    } else if (row.type === 'user') {
      for (const b of content) {
        if (!isObj(b) || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue
        const open = pending.get(b.tool_use_id)
        if (open === undefined) continue
        pending.delete(b.tool_use_id)
        const end: ToolEnd = { id: b.tool_use_id, status: b.is_error === true ? 'error' : 'ok', preview: previewOf(b.content), at }
        const t0 = performance.now()
        let step = open.step
        try {
          step = applyEnd(open.step, end, ctx)
        } catch {
          const r = results[open.index]
          if (r !== undefined) r.threw = true
        }
        const endMs = performance.now() - t0
        const r = results[open.index]
        if (r === undefined) continue
        r.endMs = endMs
        r.status = step.status
        r.sceneOk = r.sceneOk && SCENE_OF[step.station] === step.scene.kind
        if (step.resultNote !== undefined) r.resultNote = step.resultNote
        if (step.detail !== undefined) r.detail = step.detail
        if (typeof row.toolDenialKind === 'string') r.denialKind = row.toolDenialKind
        const path = (open.step.tool === 'Read' || open.step.tool === 'Write' || open.step.tool === 'Edit' || open.step.tool === 'MultiEdit') ? open.step.target : undefined
        if (step.status === 'ok' && typeof path === 'string') {
          readPaths.push(path)
          if (readPaths.length > 500) readPaths.splice(0, readPaths.length - 500)
        }
      }
    }
  }
}

// ---------------------------------------------------------------- metrics

const n = results.length
const pct = (k: number, of = n): string => (of === 0 ? '–' : `${((100 * k) / of).toFixed(1)}%`)
const countBy = (key: (r: Result) => string): [string, number][] => {
  const m = new Map<string, number>()
  for (const r of results) m.set(key(r), (m.get(key(r)) ?? 0) + 1)
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}
const quantile = (xs: number[], q: number): number => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0
}
const ms = (x: number): string => `${x.toFixed(3)} ms`

const isGeneric = (r: Result): boolean => r.headline === `Using ${r.tool}`
const ended = results.filter(r => r.status !== 'running')
const failed = ended.filter(r => r.status === 'error' || r.status === 'denied')
const totals = results.map(r => r.explainMs + r.endMs)
const explainTimes = results.map(r => r.explainMs)
const endTimes = ended.map(r => r.endMs)
const bash = results.filter(r => r.tool === 'Bash')
const withDesc = bash.filter(r => r.hasDescription)
const denials = ended.filter(r => r.denialKind !== undefined)
const limits = {
  'headline > 90': results.filter(r => r.headline.length > 90).length,
  'headline empty': results.filter(r => r.headline.trim() === '').length,
  'why > 170': results.filter(r => r.why.length > 170).length,
  'detail > 40': results.filter(r => (r.detail ?? '').length > 40).length,
  'resultNote > 120': results.filter(r => (r.resultNote ?? '').length > 120).length,
  'non-registry concept ids': results.filter(r => r.concepts.some(c => !isConceptId(c))).length,
  'scene kind != station': results.filter(r => !r.sceneOk).length,
  'threw': results.filter(r => r.threw).length,
}

const lines: string[] = []
const say = (s = ''): void => {
  lines.push(s)
}
say(`pairwatch explain eval: ${n} tool calls from ${mainFiles + subFiles} transcripts (${mainFiles} main, ${subFiles} sub-agent) under ${ROOT}`)
say(`  ${ended.length} with a result, ${n - ended.length} without (still running when written)`)
say()
say('calls by tool:')
for (const [k, v] of countBy(r => r.tool).slice(0, 40)) say(`  ${k.padEnd(40)} ${String(v).padStart(6)}  ${pct(v)}`)
say()
say('calls by station:')
for (const [k, v] of countBy(r => r.station)) say(`  ${k.padEnd(10)} ${String(v).padStart(6)}  ${pct(v)}`)
say()
say('Bash calls by station:')
for (const [k, v] of countBy(r => (r.tool === 'Bash' ? r.station : '-')).filter(([k]) => k !== '-')) say(`  ${k.padEnd(10)} ${String(v).padStart(6)}  ${pct(v, bash.length)}`)
say()
say(`generic headlines ('Using X'):        ${results.filter(isGeneric).length}  (${pct(results.filter(isGeneric).length)})`)
say(`with at least one concept:            ${results.filter(r => r.concepts.length > 0).length}  (${pct(results.filter(r => r.concepts.length > 0).length)})`)
say(`mean concepts per step:               ${(results.reduce((s, r) => s + r.concepts.length, 0) / Math.max(1, n)).toFixed(2)}`)
say(`errors / refusals after applyEnd:     ${failed.length}  (error ${failed.filter(r => r.status === 'error').length}, denied ${failed.filter(r => r.status === 'denied').length})`)
say(`  with a resultNote:                  ${failed.filter(r => r.resultNote !== undefined).length}  (${pct(failed.filter(r => r.resultNote !== undefined).length, failed.length)})`)
say(`ok steps with a resultNote:           ${pct(ended.filter(r => r.status === 'ok' && r.resultNote !== undefined).length, ended.filter(r => r.status === 'ok').length)}`)
say(`transcript denials (toolDenialKind):  ${denials.length}, recognised as 'denied': ${denials.filter(r => r.status === 'denied').length}`)
say(`Bash with a description:              ${withDesc.length} of ${bash.length}; headline taken from it: ${pct(withDesc.filter(r => r.usedDescription).length, withDesc.length)}`)
say()
say(`time per call (explainTool + applyEnd): mean ${ms(totals.reduce((s, x) => s + x, 0) / Math.max(1, n))}, p50 ${ms(quantile(totals, 0.5))}, p95 ${ms(quantile(totals, 0.95))}, p99 ${ms(quantile(totals, 0.99))}, max ${ms(quantile(totals, 1))}`)
say(`  explainTool: mean ${ms(explainTimes.reduce((s, x) => s + x, 0) / Math.max(1, n))}, p95 ${ms(quantile(explainTimes, 0.95))}`)
say(`  applyEnd:    mean ${ms(endTimes.reduce((s, x) => s + x, 0) / Math.max(1, endTimes.length))}, p95 ${ms(quantile(endTimes, 0.95))}`)
const slowest = results.reduce<{ r?: Result; t: number }>((best, r, i) => ((totals[i] ?? 0) > best.t ? { r, t: totals[i] ?? 0 } : best), { t: -1 })
if (slowest.r !== undefined) say(`  slowest call: ${slowest.r.tool} (${ms(slowest.t)}, call #${results.indexOf(slowest.r) + 1} of ${n})`)
say()
say('contract checks (all should be 0):')
for (const [k, v] of Object.entries(limits)) say(`  ${k.padEnd(28)} ${v}`)
console.log(lines.join('\n'))

// ---------------------------------------------------------------- sample report

/** Deterministic spread: round-robin over (tool, station) buckets, a prime stride inside each. */
function samples(want: number, errorsWanted: number): Result[] {
  const buckets = new Map<string, Result[]>()
  for (const r of results) {
    const key = r.tool === 'Bash' ? `Bash/${r.station}` : r.tool.startsWith('mcp__') ? 'mcp' : r.tool
    const list = buckets.get(key) ?? []
    list.push(r)
    buckets.set(key, list)
  }
  const ordered = [...buckets.values()].sort((a, b) => b.length - a.length)
  const picked: Result[] = []
  const taken = new Set<Result>()
  for (let round = 0; picked.length < want - errorsWanted && round < 50; round++) {
    for (const list of ordered) {
      if (picked.length >= want - errorsWanted) break
      if (round >= list.length) continue
      const r = list[(round * 7919 + 13) % list.length]
      if (r !== undefined && !taken.has(r)) {
        picked.push(r)
        taken.add(r)
      }
    }
  }
  // failures, spread over tools and statuses the same way
  const errBuckets = new Map<string, Result[]>()
  for (const r of results) {
    if ((r.status !== 'error' && r.status !== 'denied') || taken.has(r)) continue
    const key = `${r.tool.startsWith('mcp__') ? 'mcp' : r.tool}/${r.status}`
    const list = errBuckets.get(key) ?? []
    list.push(r)
    errBuckets.set(key, list)
  }
  const errOrdered = [...errBuckets.values()].sort((a, b) => b.length - a.length)
  for (let round = 0; picked.length < want && round < 50; round++) {
    let added = false
    for (const list of errOrdered) {
      if (picked.length >= want) break
      if (round >= list.length) continue
      const r = list[(round * 7919 + 7) % list.length]
      if (r !== undefined && !taken.has(r)) {
        picked.push(r)
        taken.add(r)
        added = true
      }
    }
    if (!added && errOrdered.every(list => round >= list.length)) break
  }
  return picked
}

const cell = (s: string | undefined): string => (s ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()
const report: string[] = [
  '# Pairwatch explain: corpus samples',
  '',
  `${n} calls from ${mainFiles + subFiles} transcripts. Generated by dev/eval-corpus.ts; private data, keep out of the repo.`,
  '',
  '```',
  ...lines,
  '```',
  '',
  '| tool | headline | why | concepts | resultNote |',
  '|---|---|---|---|---|',
]
for (const r of samples(60, 12)) {
  const tool = r.tool === 'Bash' ? `Bash · ${r.station}` : `${r.tool} · ${r.station}`
  const note = r.resultNote === undefined ? (r.status === 'running' ? '(no result)' : '') : `${r.status === 'ok' ? '' : `[${r.status}] `}${r.resultNote}`
  report.push(`| ${cell(tool)} | ${cell(r.headline)}${r.detail ? ` · _${cell(r.detail)}_` : ''} | ${cell(r.why)} | ${cell(r.concepts.join(', '))} | ${cell(note)} |`)
}
// Under --out as asked, else a new private (0700) temp folder: the samples quote real sessions.
let OUT = OUT_ARG ?? `a new folder in ${tmpdir()}`
try {
  if (OUT_ARG === undefined) OUT = mkdtempSync(join(tmpdir(), 'pairwatch-eval-'))
  else mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, 'samples.md'), report.join('\n') + '\n')
  writeFileSync(
    join(OUT, 'metrics.json'),
    JSON.stringify(
      {
        calls: n,
        transcripts: mainFiles + subFiles,
        byTool: Object.fromEntries(countBy(r => r.tool)),
        byStation: Object.fromEntries(countBy(r => r.station)),
        genericPct: n === 0 ? 0 : results.filter(isGeneric).length / n,
        conceptPct: n === 0 ? 0 : results.filter(r => r.concepts.length > 0).length / n,
        errorNotePct: failed.length === 0 ? 1 : failed.filter(r => r.resultNote !== undefined).length / failed.length,
        meanMs: totals.reduce((s, x) => s + x, 0) / Math.max(1, n),
        p95Ms: quantile(totals, 0.95),
        limits,
      },
      null,
      2,
    ) + '\n',
  )
  console.log(`\nsample report: ${join(OUT, 'samples.md')}`)
} catch (e) {
  console.error(`could not write the report to ${OUT}: ${String(e)}`)
  process.exitCode = 1
}
