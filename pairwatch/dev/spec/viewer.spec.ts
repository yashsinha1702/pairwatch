// viewer/server.mjs, the server behind Pairwatch's own page. Each group starts the real server on a
// free port with a temporary folder, and checks what the mod and the page rely on: /health, the key,
// the Host and Origin checks, JSON-only actions, the inbox and who watches which session, the newest
// session (ended and stale snapshots skipped, sticky following), pruning, the list cap, /api/quit
// and --detach. Every process it starts is stopped at the end.
// Run: node --test dev/spec/viewer.spec.ts
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, afterEach, before, describe, it } from 'node:test'

const SERVER = fileURLToPath(new URL('../../pairwatch/viewer/server.mjs', import.meta.url))
const PAGE = fileURLToPath(new URL('../../pairwatch/viewer/index.html', import.meta.url))
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const isPosix = process.platform !== 'win32'

// ------------------------------------------------------------------ processes and folders, all cleaned up

const children = new Set<ChildProcess>()
/** detached servers (no child handle): their pids, read from viewer.log */
const detachedPids = new Set<number>()
const roots: string[] = []

/** Stops the servers started so far (each group's own, once it is done with them). */
function stopServers(): void {
  for (const child of children) child.kill('SIGKILL')
  children.clear()
}

function stopAll(): void {
  stopServers()
  for (const pid of detachedPids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // gone already
    }
  }
  detachedPids.clear()
}
process.on('exit', stopAll)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stopAll()
    process.exit(1)
  })
}

after(() => {
  stopAll()
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A data folder the server has not made yet, in a fresh temporary root. */
function newDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'pairwatch-viewer-spec-'))
  roots.push(root)
  return join(root, 'data')
}

const sleep = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))

async function until(check: () => boolean | Promise<boolean>, what: () => string, timeoutMs = 6000): Promise<void> {
  const end = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() > end) assert.fail(`timed out waiting for ${what()}`)
    await sleep(25)
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

// ------------------------------------------------------------------ HTTP

type Reply = { status: number; headers: IncomingHttpHeaders; text: string }
type CallOptions = { method?: string; headers?: Record<string, string>; body?: string }

function call(port: number, path: string, options: CallOptions = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: options.headers, agent: false }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => {
        text += chunk
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error(`no answer to ${path}`)))
    req.end(options.body)
  })
}

const answers = async (port: number): Promise<boolean> => (await call(port, '/health').catch(() => null))?.status === 200

type Server = {
  port: number
  dir: string
  key: string
  proc: ChildProcess
  output: () => string
  get: (path: string, headers?: Record<string, string>) => Promise<Reply>
  act: (body: unknown, headers?: Record<string, string>) => Promise<Reply>
  inbox: (sid: string) => Promise<{ actions: { action: string; value?: string; at: number }[]; clients: number; watching: number }>
}

/** Runs the server (not detached), its output collected. */
function run(port: number, dir: string): { proc: ChildProcess; output: () => string } {
  // the IPC channel: the server exits when this process does, even if it is killed before cleaning up
  const proc = spawn(process.execPath, [SERVER, '--port', String(port), '--dir', dir], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  children.add(proc)
  proc.on('exit', () => children.delete(proc))
  let out = ''
  proc.stdout?.on('data', chunk => {
    out += chunk
  })
  proc.stderr?.on('data', chunk => {
    out += chunk
  })
  return { proc, output: () => out }
}

/** A port held by something else until `release()`. */
async function holdPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const port = await freePort()
  const holder = net.createServer()
  await new Promise<void>((resolve, reject) => {
    holder.on('error', reject)
    holder.listen(port, '127.0.0.1', () => resolve())
  })
  return { port, release: () => new Promise<void>(resolve => holder.close(() => resolve())) }
}

async function start(dir: string): Promise<Server> {
  const port = await freePort()
  const { proc, output } = run(port, dir)
  await until(
    async () => {
      if (proc.exitCode !== null) assert.fail(`the server exited (${proc.exitCode}): ${output()}`)
      return answers(port)
    },
    () => `the server on port ${port} (output: ${output()})`,
  )
  const key = readFileSync(join(dir, 'viewer.token'), 'utf8').trim()
  const keyed = (path: string): string => `${path}${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`
  return {
    port,
    dir,
    key,
    proc,
    output,
    get: (path, headers) => call(port, keyed(path), { headers }),
    act: (body, headers) =>
      call(port, '/api/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-pairwatch-key': key, ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    inbox: async sid => {
      const reply = await call(port, `/api/inbox?sid=${encodeURIComponent(sid)}`, { headers: { 'x-pairwatch-key': key } })
      assert.equal(reply.status, 200, reply.text)
      return JSON.parse(reply.text)
    },
  }
}

/** A process has exited (on Linux, one exited but not yet reaped counts too). */
function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return true
  }
  try {
    return /^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return false
  }
}

function exited(proc: ChildProcess): Promise<number | null> {
  if (proc.exitCode !== null) return Promise.resolve(proc.exitCode)
  return new Promise(resolve => proc.once('exit', code => resolve(code)))
}

// ------------------------------------------------------------------ snapshots and event streams

/** Writes a session's snapshot as the mod does, last written `ageMs` ago. */
function writeSnap(dir: string, sid: string, ageMs: number, fields: Record<string, unknown> = {}): string {
  const live = join(dir, 'live')
  mkdirSync(live, { recursive: true })
  const file = join(live, `${sid}.json`)
  const at = Date.now() - ageMs
  const snap = { v: 1, sid, cwd: '/home/dev/shop', svg: `<svg xmlns="http://www.w3.org/2000/svg"><text>${sid}</text></svg>`, head: `Working on ${sid}`, goalText: `the goal of ${sid}`, at, ...fields }
  writeFileSync(file, JSON.stringify(snap))
  utimesSync(file, at / 1000, at / 1000)
  return file
}

type Event = { event: string; data: string }
type Stream = { events: Event[]; close: () => void; lastSid: () => string | undefined }

const streams = new Set<Stream>()
after(() => {
  for (const s of streams) s.close()
})

/** A page's event stream, as a raw GET: by name when `sid` is given, else following the newest. */
function openStream(server: Server, sid?: string): Promise<Stream> {
  const query = new URLSearchParams({ key: server.key, ...(sid === undefined ? {} : { sid }) })
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: server.port, path: `/api/events?${query}`, agent: false }, res => {
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`events answered ${res.statusCode}`))
        return
      }
      let buffer = ''
      const stream: Stream = {
        events: [],
        close: () => {
          streams.delete(stream)
          req.destroy()
        },
        lastSid: () => {
          const last = stream.events.filter(e => e.event === 'snapshot').pop()
          return last === undefined ? undefined : (JSON.parse(last.data) as { sid: string }).sid
        },
      }
      streams.add(stream)
      res.setEncoding('utf8')
      res.on('data', chunk => {
        buffer += chunk
        for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
          const block = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          let event = 'message'
          const data: string[] = []
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice('event: '.length)
            else if (line.startsWith('data: ')) data.push(line.slice('data: '.length))
          }
          if (data.length > 0) stream.events.push({ event, data: data.join('\n') })
        }
      })
      res.on('error', () => undefined)
      resolve(stream)
    })
    req.on('error', err => reject(err))
  })
}

// ------------------------------------------------------------------ the specs

describe('viewer server: identity, key and checks', () => {
  let server: Server
  before(async () => {
    server = await start(newDir())
  })

  it('answers /health as pairwatch, version 3, with its page count', async () => {
    const reply = await call(server.port, '/health')
    assert.equal(reply.status, 200)
    assert.deepEqual(JSON.parse(reply.text), { ok: true, app: 'pairwatch', version: 3, clients: 0 })
  })

  it('keeps its key in a 0600 file inside a 0700 folder', { skip: !isPosix && 'POSIX modes only' }, () => {
    assert.match(server.key, /^[A-Za-z0-9_-]{20,}$/)
    assert.equal(statSync(server.dir).mode & 0o777, 0o700)
    assert.equal(statSync(join(server.dir, 'viewer.token')).mode & 0o777, 0o600)
  })

  it('serves the page with a policy that lets only its own script run', async () => {
    const reply = await call(server.port, '/')
    assert.equal(reply.status, 200)
    assert.match(reply.text, /<title>Pairwatch<\/title>/)
    const script = /<script>([\s\S]*?)<\/script>/.exec(readFileSync(PAGE, 'utf8'))?.[1]
    assert.ok(script !== undefined, 'the page has its inline script')
    const hash = createHash('sha256').update(script).digest('base64')
    const csp = String(reply.headers['content-security-policy'])
    assert.ok(csp.includes(`script-src 'sha256-${hash}'`), csp)
    assert.ok(csp.includes("default-src 'none'"), csp)
    assert.equal(reply.headers['referrer-policy'], 'no-referrer')
  })

  it('turns away /api calls with no key or a wrong one, saying no more than Forbidden', async () => {
    for (const reply of [
      await call(server.port, '/api/sessions'),
      await call(server.port, '/api/sessions?key=not-the-key-at-all-000000'),
      await call(server.port, '/api/inbox?sid=s1', { headers: { 'x-pairwatch-key': `${server.key}x` } }),
      // the key under the header of the server from before the rename
      await call(server.port, '/api/inbox?sid=s1', { headers: { 'x-tutor-key': server.key } }),
      await call(server.port, '/api/quit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
    ]) {
      assert.equal(reply.status, 403)
      assert.deepEqual(JSON.parse(reply.text), { ok: false, error: 'Forbidden' })
    }
    assert.equal((await server.get('/api/sessions')).status, 200)
    assert.equal((await call(server.port, '/api/inbox?sid=s1', { headers: { 'x-pairwatch-key': server.key } })).status, 200)
    assert.ok(await answers(server.port), 'a quit without the key did nothing')
  })

  it('turns away a foreign Host, even with the key', async () => {
    assert.equal((await call(server.port, '/health', { headers: { host: 'evil.example' } })).status, 403)
    assert.equal((await call(server.port, '/', { headers: { host: `rebound.example:${server.port}` } })).status, 403)
    assert.equal((await server.get('/api/sessions', { host: `evil.example:${server.port}` })).status, 403)
    assert.equal((await server.get('/api/sessions', { host: `localhost:${server.port}` })).status, 200)
    assert.equal((await server.get('/api/sessions', { host: `[::1]:${server.port}` })).status, 200)
  })

  it('turns away a foreign Origin, even with the key', async () => {
    assert.equal((await server.act({ sid: 'origin-s', action: 'why' }, { origin: 'https://evil.example' })).status, 403)
    assert.equal((await server.act({ sid: 'origin-s', action: 'why' }, { origin: 'null' })).status, 403)
    assert.deepEqual((await server.inbox('origin-s')).actions, [])
    assert.equal((await server.act({ sid: 'origin-s', action: 'why' }, { origin: `http://localhost:${server.port}` })).status, 200)
    assert.equal((await server.inbox('origin-s')).actions.length, 1)
  })

  it('takes actions as JSON only (415 for text/plain and forms)', async () => {
    for (const type of ['text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'application/jsonp']) {
      const reply = await server.act(JSON.stringify({ sid: 'plain-s', action: 'why' }), { 'content-type': type })
      assert.equal(reply.status, 415, type)
      assert.deepEqual(JSON.parse(reply.text), { ok: false, error: 'Unsupported Media Type' })
    }
    assert.equal((await server.act({ sid: 'plain-s', action: 'why' }, { 'content-type': 'application/json; charset=utf-8' })).status, 200)
    assert.deepEqual((await server.inbox('plain-s')).actions.map(a => a.action), ['why'])
  })

  it('answers a bad action with a bare 400', async () => {
    for (const body of ['{"sid":', '[]', 'null', JSON.stringify({ sid: 'bad-s', action: 'rm -rf' }), JSON.stringify({ sid: 'bad-s' })]) {
      const reply = await server.act(body)
      assert.equal(reply.status, 400, body)
      assert.deepEqual(JSON.parse(reply.text), { ok: false, error: 'Bad Request' })
    }
    assert.equal((await server.get('/api/nothing')).status, 404)
    assert.deepEqual((await server.inbox('bad-s')).actions, [])
  })

  it('round-trips a press from the page to the mod, once, for its own session', async () => {
    assert.deepEqual(JSON.parse((await server.act({ sid: 'trip-a', action: 'level', value: '2' })).text), { ok: true })
    assert.equal((await server.act({ sid: 'trip-a', action: 'tip' })).status, 200)
    assert.deepEqual((await server.inbox('trip-b')).actions, [])
    const first = await server.inbox('trip-a')
    assert.deepEqual(
      first.actions.map(a => [a.action, a.value]),
      [
        ['level', '2'],
        ['tip', undefined],
      ],
    )
    assert.ok(first.actions.every(a => typeof a.at === 'number'))
    assert.deepEqual((await server.inbox('trip-a')).actions, [])
  })

  it('settles a body that is too long or cut off, and keeps serving', async () => {
    /** Sends raw bytes; resolves to who closed the connection. */
    const raw = (text: string, hangUpMs?: number): Promise<'server' | 'us'> =>
      new Promise(resolve => {
        let closer: 'server' | 'us' = 'server'
        let timer: ReturnType<typeof setTimeout> | undefined
        const socket = net.connect(server.port, '127.0.0.1', () => {
          socket.write(text)
          timer = setTimeout(() => {
            closer = 'us'
            socket.destroy()
          }, hangUpMs ?? 4000)
        })
        socket.on('error', () => undefined)
        socket.on('close', () => {
          clearTimeout(timer)
          resolve(closer)
        })
        socket.resume()
      })
    const head = (length: number): string =>
      `POST /api/action HTTP/1.1\r\nHost: localhost:${server.port}\r\nContent-Type: application/json\r\nx-pairwatch-key: ${server.key}\r\nContent-Length: ${length}\r\n\r\n`
    assert.equal(await raw(head(50_000) + 'x'.repeat(20_000)), 'server', 'a body over the limit is cut off by the server')
    await raw(`${head(500)}{"sid":"cut-s","action":`, 100)
    assert.ok(await answers(server.port))
    assert.equal((await server.act({ sid: 'cut-s', action: 'known' })).status, 200)
    assert.deepEqual((await server.inbox('cut-s')).actions.map(a => a.action), ['known'])
  })

  it('counts the pages watching each session: by name, or following the newest while it is that one', async () => {
    const byName = await openStream(server, 'watch-x')
    await until(async () => (await server.inbox('watch-x')).watching === 1, () => 'one page on watch-x')
    assert.deepEqual(await server.inbox('watch-y'), { actions: [], clients: 1, watching: 0 })
    await until(() => byName.events.some(e => e.event === 'empty'), () => 'an empty event (watch-x has no snapshot)')

    writeSnap(server.dir, 'watch-y', 1000)
    const newest = await openStream(server)
    await until(() => newest.lastSid() === 'watch-y', () => 'the newest page on watch-y')
    await until(async () => (await server.inbox('watch-y')).watching === 1, () => 'one page on watch-y')
    const x = await server.inbox('watch-x')
    assert.equal(x.clients, 2)
    assert.equal(x.watching, 1)
    assert.equal(JSON.parse((await call(server.port, '/health')).text).clients, 2)

    byName.close()
    newest.close()
    await until(async () => (await server.inbox('watch-y')).clients === 0, () => 'no page open')
    assert.equal((await server.inbox('watch-y')).watching, 0)
  })
})

describe('viewer server: the newest session', () => {
  afterEach(stopServers)

  it('skips an ended snapshot', async () => {
    const dir = newDir()
    writeSnap(dir, 'going', 5000)
    writeSnap(dir, 'over', 1000, { ended: true })
    const server = await start(dir)
    assert.equal(JSON.parse((await server.get('/api/state')).text).sid, 'going')
    const page = await openStream(server)
    await until(() => page.lastSid() === 'going', () => 'the page on the session still going')
    await until(async () => (await server.inbox('going')).watching === 1, () => 'one page on going')
    assert.equal((await server.inbox('over')).watching, 0)
    const listed = JSON.parse((await server.get('/api/sessions')).text) as { sid: string; ended: boolean; cwd: string; goal: string }[]
    assert.deepEqual(
      listed.map(s => [s.sid, s.ended]),
      [
        ['over', true],
        ['going', false],
      ],
    )
    assert.equal(listed[1]?.goal, 'the goal of going')
    assert.equal(listed[1]?.cwd, '/home/dev/shop')
    page.close()
  })

  it('skips a snapshot older than 12 hours, and falls back to an ended one when nothing else exists', async () => {
    const dir = newDir()
    writeSnap(dir, 'stale', 13 * HOUR)
    writeSnap(dir, 'ended', 1 * HOUR, { ended: true })
    const server = await start(dir)
    assert.equal(JSON.parse((await server.get('/api/state')).text).sid, 'ended')
    const page = await openStream(server)
    await until(() => page.lastSid() === 'ended', () => 'the page on the ended session')
    const shown = JSON.parse(page.events.filter(e => e.event === 'snapshot').pop()!.data) as { ended?: boolean }
    assert.equal(shown.ended, true)
    // by name, any session can be shown
    assert.equal(JSON.parse((await server.get('/api/state?sid=stale')).text).sid, 'stale')
    page.close()
  })

  it('keeps following its session while it goes on, and moves on when it ends', async () => {
    const dir = newDir()
    writeSnap(dir, 'first', 3000)
    const server = await start(dir)
    const page = await openStream(server)
    await until(() => page.lastSid() === 'first', () => 'the page on first')

    // first goes on, and a newer session starts: the page stays on first
    writeSnap(dir, 'first', 1000, { head: 'still going' })
    writeSnap(dir, 'second', 0)
    await until(() => page.events.some(e => e.event === 'snapshot' && e.data.includes('still going')), () => 'the update of first')
    await sleep(1500) // more than a listing of the folder and a few ticks
    assert.equal(page.lastSid(), 'first')
    assert.equal((await server.inbox('first')).watching, 1)
    assert.equal((await server.inbox('second')).watching, 0)

    // first ends: the page moves on to second
    writeSnap(dir, 'first', 0, { ended: true })
    await until(() => page.lastSid() === 'second', () => 'the page on second')
    await until(async () => (await server.inbox('second')).watching === 1, () => 'one page on second')
    assert.equal((await server.inbox('first')).watching, 0)
    page.close()
  })

  it('moves on from a session that went quiet for 10 minutes', async () => {
    const dir = newDir()
    const quiet = writeSnap(dir, 'quiet', 2000)
    const server = await start(dir)
    const page = await openStream(server)
    await until(() => page.lastSid() === 'quiet', () => 'the page on quiet')
    writeSnap(dir, 'newer', 1000)
    await sleep(1500)
    assert.equal(page.lastSid(), 'quiet', 'still on quiet while it was just updated')
    const elevenMinutesAgo = (Date.now() - 11 * 60 * 1000) / 1000
    utimesSync(quiet, elevenMinutesAgo, elevenMinutesAgo)
    await until(() => page.lastSid() === 'newer', () => 'the page on newer')
    page.close()
  })

  it('waits, with an empty event, while there is no session at all', async () => {
    const server = await start(newDir())
    const page = await openStream(server)
    await until(() => page.events.some(e => e.event === 'empty'), () => 'an empty event')
    const state = await server.get('/api/state')
    assert.equal(state.status, 404)
    assert.deepEqual(JSON.parse(state.text), { empty: true })
    assert.deepEqual(JSON.parse((await server.get('/api/sessions')).text), [])
    writeSnap(server.dir, 'arrives', 0)
    await until(() => page.lastSid() === 'arrives', () => 'the page on the first session')
    page.close()
  })

  it('waits out a half-written snapshot, then shows it whole', async () => {
    const dir = newDir()
    mkdirSync(join(dir, 'live'), { recursive: true })
    const file = join(dir, 'live', 'half.json')
    writeFileSync(file, '{"v":1,"sid":"half","svg":"<svg')
    const server = await start(dir)
    const page = await openStream(server)
    await until(() => page.events.some(e => e.event === 'empty'), () => 'an empty event for the unreadable file')
    assert.equal(page.lastSid(), undefined)
    writeSnap(dir, 'half', 0)
    await until(() => page.lastSid() === 'half', () => 'the whole snapshot')
    page.close()
  })
})

describe('viewer server: pruning and the session list', () => {
  afterEach(stopServers)

  it('deletes snapshots older than 7 days when it starts', async () => {
    const dir = newDir()
    mkdirSync(dir, { recursive: true, mode: 0o755 })
    const old = writeSnap(dir, 'eight-days', 8 * DAY)
    const kept = writeSnap(dir, 'six-days', 6 * DAY)
    const server = await start(dir)
    assert.equal(existsSync(old), false)
    assert.equal(existsSync(kept), true)
    assert.deepEqual(
      (JSON.parse((await server.get('/api/sessions')).text) as { sid: string }[]).map(s => s.sid),
      ['six-days'],
    )
    if (isPosix) assert.equal(statSync(dir).mode & 0o777, 0o700, 'an existing folder is made private too')
  })

  it('lists at most 50 sessions, newest first', async () => {
    const dir = newDir()
    for (let i = 0; i < 55; i += 1) writeSnap(dir, `s${String(i).padStart(2, '0')}`, (i + 1) * 60_000)
    const server = await start(dir)
    const listed = JSON.parse((await server.get('/api/sessions')).text) as { sid: string; mtimeMs: number }[]
    assert.equal(listed.length, 50)
    assert.equal(listed[0]?.sid, 's00')
    assert.equal(listed[49]?.sid, 's49')
    assert.ok(listed.every((s, i) => i === 0 || listed[i - 1]!.mtimeMs >= s.mtimeMs))
  })
})

describe('viewer server: quit and --detach', () => {
  afterEach(stopServers)

  it('quits on POST /api/quit with the key', async () => {
    const server = await start(newDir())
    const reply = await call(server.port, '/api/quit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pairwatch-key': server.key },
      body: '{}',
    })
    assert.equal(reply.status, 200)
    assert.deepEqual(JSON.parse(reply.text), { ok: true })
    assert.equal(await exited(server.proc), 0)
    assert.equal(await answers(server.port), false)
  })

  it('--detach returns at once and leaves a server answering, until it is asked to quit', async () => {
    const dir = newDir()
    const port = await freePort()
    const startedAt = Date.now()
    const launcher = spawn(process.execPath, [SERVER, '--detach', '--port', String(port), '--dir', dir], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(launcher)
    let out = ''
    launcher.stdout?.on('data', chunk => {
      out += chunk
    })
    launcher.stderr?.on('data', chunk => {
      out += chunk
    })
    // its pipes close too: nothing of the server holds them, so a caller waiting on its output is not kept
    const closed = new Promise<void>(resolve => launcher.once('close', () => resolve()))
    assert.equal(await exited(launcher), 0, out)
    await closed
    children.delete(launcher)
    assert.ok(Date.now() - startedAt < 4000, `--detach took ${Date.now() - startedAt} ms`)

    const logFile = join(dir, 'viewer.log')
    await until(() => existsSync(logFile) && /\(pid (\d+)\)/.test(readFileSync(logFile, 'utf8')), () => `the start line in viewer.log (${out})`)
    const pid = Number(/\(pid (\d+)\)/.exec(readFileSync(logFile, 'utf8'))?.[1])
    detachedPids.add(pid)
    await until(() => answers(port), () => `the detached server on port ${port}`)
    assert.deepEqual(JSON.parse((await call(port, '/health')).text), { ok: true, app: 'pairwatch', version: 3, clients: 0 })
    if (isPosix) assert.equal(statSync(logFile).mode & 0o777, 0o600)

    const key = readFileSync(join(dir, 'viewer.token'), 'utf8').trim()
    const reply = await call(port, '/api/quit', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pairwatch-key': key }, body: '{}' })
    assert.equal(reply.status, 200)
    await until(async () => !(await answers(port)), () => 'the detached server to stop answering')
    await until(() => isGone(pid), () => `process ${pid} to exit`)
    detachedPids.delete(pid)
  })

  it('exits when the Node process that started it over IPC goes away', async () => {
    const server = await start(newDir())
    server.proc.disconnect()
    assert.equal(await exited(server.proc), 0)
  })

  it('waits a moment for a port that an older server is freeing', async () => {
    const held = await holdPort()
    const { proc } = run(held.port, newDir())
    await sleep(500)
    assert.equal(proc.exitCode, null, 'still trying')
    await held.release()
    await until(() => answers(held.port), () => `the server on port ${held.port} once it was freed`)
  })

  it('gives up on a port that stays taken, and says so in its log', async () => {
    const held = await holdPort()
    try {
      const { proc, output } = run(held.port, newDir())
      assert.equal(await exited(proc), 0)
      assert.match(output(), new RegExp(`port ${held.port} is taken`))
      assert.match(output(), /Viewer port/)
    } finally {
      await held.release()
    }
  })

  it('--detach refuses a bad port with a message, and starts nothing', async () => {
    const launcher = spawn(process.execPath, [SERVER, '--detach', '--port', 'seventy', '--dir', newDir()], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(launcher)
    let err = ''
    launcher.stderr?.on('data', chunk => {
      err += chunk
    })
    const code = await exited(launcher)
    children.delete(launcher)
    assert.equal(code, 2)
    assert.match(err, /--port/)
  })
})
