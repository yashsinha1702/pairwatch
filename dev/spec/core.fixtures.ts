// Synthetic fixtures for the core specs (timeline, narrate, text). Made-up sessions only, no real data.
// The fake explainer stands in for explain.ts / bash.ts so these specs test the core modules alone.
import type { RawEvent, SessionModel, Step, StepStatus } from '../../pairwatch/types'
import { emptyModel, reduceWith } from '../../pairwatch/hooks/core/timeline.ts'
import type { ReduceDeps } from '../../pairwatch/hooks/core/timeline.ts'

export const T0 = 1_760_000_000_000
const tail = (p: unknown): string => String(p).split('/').pop() ?? String(p)

/** A small, predictable explainer: just enough stations, scenes and concepts for the timeline rules. */
export const fakeDeps: ReduceDeps = {
  explainTool(obs) {
    const a = obs.args
    const base = { id: obs.id, tool: obs.tool, ...(obs.agentId === undefined ? {} : { agentId: obs.agentId }), status: 'running' as const, startedAt: obs.at }
    switch (obs.tool) {
      case 'Read':
        return { ...base, station: 'read', headline: `Reading ${tail(a.file_path)}`, why: 'Reading the code first shows how it really works.', target: String(a.file_path), concepts: ['reading-code'], scene: { kind: 'read', files: [{ path: String(a.file_path) }] } }
      case 'Edit':
      case 'Write':
        return { ...base, station: 'edit', headline: `Editing ${tail(a.file_path)}`, why: 'A small, exact change is easy to review.', target: String(a.file_path), concepts: ['surgical-edit'], scene: { kind: 'edit', path: String(a.file_path), removed: 1, added: 2, minus: ['old'], plus: ['new', 'line'], isNew: false } }
      case 'Grep':
        return { ...base, station: 'search', headline: `Searching for “${String(a.pattern)}”`, why: 'Search narrows a big codebase to the few places that matter.', target: String(a.pattern), concepts: ['grep'], scene: { kind: 'search', query: String(a.pattern) } }
      case 'Agent':
        return { ...base, station: 'delegate', headline: `Handing off: ${String(a.description)}`, why: 'A helper works in its own fresh context.', target: String(a.description), concepts: ['subagents'], scene: { kind: 'delegate', agents: [{ label: String(a.description), status: 'running' }] } }
      case 'Bash': {
        const cmd = String(a.command)
        if (/^(?:grep|rg)\b/.test(cmd)) {
          const q = /"([^"]+)"/.exec(cmd)?.[1] ?? cmd
          return { ...base, station: 'search', headline: `Searching for “${q}”`, why: 'Search narrows a big codebase to the few places that matter.', concepts: ['grep', 'regex'], scene: { kind: 'search', query: q, where: 'src/' } }
        }
        if (/^cat\b/.test(cmd)) {
          const f = cmd.split(/\s+/)[1] ?? ''
          return { ...base, station: 'read', headline: `Reading ${tail(f)}`, why: 'cat prints a whole file.', target: f, concepts: ['cat'], scene: { kind: 'read', files: [{ path: f }] } }
        }
        const isTest = /pytest|npm test/.test(cmd)
        return { ...base, station: 'run', headline: isTest ? 'Running the tests' : `Running ${cmd.split(' ')[0]}`, why: isTest ? 'Tests prove the change works.' : 'Claude runs a command.', target: cmd, concepts: isTest ? ['pytest', 'tests'] : ['shell-basics'], scene: { kind: 'run', command: cmd, category: isTest ? 'test' : 'other' } }
      }
      default:
        return { ...base, station: 'tools', headline: `Using ${obs.tool}`, why: 'Claude uses a tool.', concepts: ['tool-calls'], scene: { kind: 'tools', name: obs.tool } }
    }
  },
  applyEnd(step, end) {
    const note = end.status === 'ok' ? (step.scene.kind === 'search' ? '3 matches' : step.scene.kind === 'run' ? 'exit 0' : undefined) : end.preview.split('\n')[0]
    return { ...step, status: end.status, endedAt: end.at, ...(note === undefined ? {} : { resultNote: note }) }
  },
  bashFiles(command) {
    const reads = [...command.matchAll(/(?:^|&&\s*)(?:cat|head|tail)\s+([^\s|;&-][^\s|;&]*)/g)].map(m => m[1]!)
    const writes = [...command.matchAll(/sed -i\S*\s+'[^']*'\s+(\S+)/g)].map(m => m[1]!)
    return { reads, writes }
  },
}

/** Event builders. */
export const E = {
  prompt: (text: string, at: number, origin = 'composer'): RawEvent => ({ kind: 'prompt', text, origin, at }),
  turnStart: (turnId: string, at: number): RawEvent => ({ kind: 'turn-start', turnId, at }),
  turnEnd: (turnId: string, at: number, o: { answer?: string; durationMs?: number; reason?: string; agentId?: string } = {}): RawEvent => ({
    kind: 'turn-end',
    turnId,
    ...(o.agentId === undefined ? {} : { agentId: o.agentId }),
    durationMs: o.durationMs ?? 0,
    answer: o.answer ?? '',
    reason: o.reason ?? 'answer',
    at,
  }),
  stream: (mode: 'thinking' | 'text', at: number, agentId?: string): RawEvent => ({ kind: 'stream', mode, at, ...(agentId === undefined ? {} : { agentId }) }),
  say: (text: string, at: number, agentId?: string): RawEvent => ({ kind: 'say', text, at, ...(agentId === undefined ? {} : { agentId }) }),
  think: (text: string, at: number, agentId?: string): RawEvent => ({ kind: 'think', text, at, ...(agentId === undefined ? {} : { agentId }) }),
  start: (id: string, tool: string, args: { [k: string]: unknown }, at: number, agentId?: string): RawEvent => ({ kind: 'tool-start', obs: { id, tool, args, at, ...(agentId === undefined ? {} : { agentId }) } }),
  end: (id: string, status: 'ok' | 'error' | 'denied', preview: string, at: number): RawEvent => ({ kind: 'tool-end', end: { id, status, preview, at } }),
  permission: (id: string, tool: string, at: number): RawEvent => ({ kind: 'permission', id, tool, at }),
  agentStart: (agentId: string, description: string, toolUseId: string, at: number, type = 'general-purpose'): RawEvent => ({ kind: 'agent-start', agentId, type, description, toolUseId, background: true, at }),
  agentStop: (agentId: string, at: number): RawEvent => ({ kind: 'agent-stop', agentId, at }),
}

export function timeOf(ev: RawEvent): number {
  return ev.kind === 'tool-start' ? ev.obs.at : ev.kind === 'tool-end' ? ev.end.at : ev.at
}

/** Reduce batch by batch, the way the pump does: each batch at now = its last event + 50 ms. */
export function play(batches: readonly RawEvent[][], o: { deps?: Partial<ReduceDeps>; model?: SessionModel; level?: 1 | 2 | 3; roundTrip?: boolean } = {}): SessionModel {
  let m = o.model ?? emptyModel(T0)
  for (const batch of batches) {
    const now = Math.max(...batch.map(timeOf)) + 50
    m = reduceWith(o.deps ?? fakeDeps, m, batch, { level: o.level ?? 1, cwd: '/proj', now })
    if (o.roundTrip === true) m = JSON.parse(JSON.stringify(m)) as SessionModel
  }
  return m
}

export const s = (sec: number): number => T0 + sec * 1000

/**
 * One full turn: prompt → thinking → grep → two parallel reads → long think → edit → failing test →
 * edit → passing test → the answer → turn end. Times in seconds after T0.
 */
export function fullTurn(): RawEvent[][] {
  return [
    [E.turnStart('turn-1', s(0)), E.prompt('After I sign in I land on a blank page. Fix the redirect.', s(0.1))],
    [E.stream('thinking', s(1.5))],
    [E.think('', s(2.4)), E.say('Let me find where the redirect is built.', s(2.4)), E.start('g1', 'Bash', { command: 'grep -rn "redirect" src/', description: 'Find redirect code' }, s(2.5))],
    [E.end('g1', 'ok', 'src/auth/login.py:42: return redirect(next_url)', s(2.8))],
    [E.stream('thinking', s(3.5)), E.start('r1', 'Read', { file_path: '/proj/src/auth/login.py' }, s(4.5)), E.start('r2', 'Read', { file_path: '/proj/src/auth/session.py' }, s(4.6))],
    [E.end('r1', 'ok', '1\timport flask', s(4.7)), E.end('r2', 'ok', '1\timport time', s(4.8))],
    [E.stream('thinking', s(5.5))],
    [E.think('The next_url is never checked, so an empty value sends people to a blank page.', s(11.9)), E.start('e1', 'Edit', { file_path: '/proj/src/auth/login.py', old_string: 'a', new_string: 'b' }, s(12))],
    [E.end('e1', 'ok', 'The file was updated.', s(12.1))],
    [E.stream('thinking', s(12.5)), E.start('t1', 'Bash', { command: 'pytest tests/test_auth.py -q' }, s(13))],
    [E.end('t1', 'error', 'FAILED tests/test_auth.py::test_redirect - AssertionError\n1 failed, 4 passed', s(17))],
    [E.stream('thinking', s(18)), E.start('e2', 'Edit', { file_path: '/proj/src/auth/login.py', old_string: 'b', new_string: 'c' }, s(19))],
    [E.end('e2', 'ok', 'The file was updated.', s(19.1))],
    [E.start('t2', 'Bash', { command: 'pytest tests/test_auth.py -q' }, s(20))],
    [E.end('t2', 'ok', '5 passed in 0.4s', s(24))],
    [E.stream('text', s(25))],
    [E.say('Fixed the redirect in login.py. All 5 tests pass.', s(29.5)), E.turnEnd('turn-1', s(30), { answer: 'Fixed the redirect in login.py. All 5 tests pass.', durationMs: 30_000 })],
  ]
}

/** Every activity's steps exist, ids are unique, currentId resolves: the model's own invariants. */
export function invariantProblems(m: SessionModel): string[] {
  const out: string[] = []
  const ids = new Set<string>()
  for (const st of m.steps) {
    if (ids.has(st.id)) out.push(`duplicate step ${st.id}`)
    ids.add(st.id)
  }
  const actIds = new Set<string>()
  for (const a of m.activities) {
    if (actIds.has(a.id)) out.push(`duplicate activity ${a.id}`)
    actIds.add(a.id)
    if (a.stepIds.length === 0) out.push(`empty activity ${a.id}`)
    for (const id of a.stepIds) if (!ids.has(id)) out.push(`activity ${a.id} names missing step ${id}`)
  }
  if (m.currentId !== undefined && !actIds.has(m.currentId)) out.push(`currentId ${m.currentId} not an activity`)
  for (const st of m.steps) {
    if (st.headline.length > 90) out.push(`headline > 90: ${st.id}`)
    if (st.why.length > 170) out.push(`why > 170: ${st.id}`)
    if (st.resultNote !== undefined && st.resultNote.length > 120) out.push(`resultNote > 120: ${st.id}`)
  }
  return out
}

export const byId = (m: SessionModel, id: string): Step | undefined => m.steps.find(x => x.id === id)
export const statusOf = (m: SessionModel, id: string): StepStatus | undefined => byId(m, id)?.status

/** Paths inside a value that hold undefined, a function, NaN or Infinity: anything JSON would not keep. */
export function nonJson(x: unknown, path = '$'): string[] {
  if (x === undefined || typeof x === 'function' || typeof x === 'symbol' || typeof x === 'bigint') return [path]
  if (typeof x === 'number') return Number.isFinite(x) ? [] : [path]
  if (x === null || typeof x !== 'object') return []
  if (Array.isArray(x)) return x.flatMap((v, i) => nonJson(v, `${path}[${i}]`))
  return Object.entries(x).flatMap(([k, v]) => nonJson(v, `${path}.${k}`))
}
