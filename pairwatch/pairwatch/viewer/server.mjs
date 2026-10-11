// Pairwatch's own page: a small local web server that shows the live Pairwatch view in a browser
// tab (in VS Code: Simple Browser, beside the Claude panel), for editors that draw no mod pane.
// No dependencies; Node 18 or newer.
//
// The mod writes one snapshot per session to <dir>/live/<session-id>.json while the page is wanted.
// Each open page follows one session, by name or "the newest", and gets its snapshot pushed as it
// changes (server-sent events). The buttons pressed there wait in an inbox per session, which the
// mod empties every second or so; the inbox also tells it how many pages show its session.
//
//   node server.mjs [--port 7979] [--dir ~/.claude/pairwatch] [--detach]
//
// --detach starts the server again as a detached process, its output appended to <dir>/viewer.log,
// and exits at once: that is how the mod starts it, with no shell.
//
// Every /api call needs the key kept in <dir>/viewer.token (0600): the x-pairwatch-key header, or ?key=
// in the page's link. The Host, and the Origin when sent, must name this machine, and actions must
// be application/json, so web pages open in a browser cannot reach in.
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = 'pairwatch'
/** /health reports it; the mod replaces a server older than the one it expects */
const VERSION = 3
const DEFAULT_PORT = 7979
/** with no page open, no mod asking and no snapshot written for this long, the server exits by itself */
const IDLE_EXIT_MS = 8 * 60 * 60 * 1000
/** how often the snapshots the pages follow are looked at (one stat each) */
const TICK_MS = 250
/** the live folder is listed at most this often, however many ask */
const LIST_EVERY_MS = 1000
/** a page following the newest session keeps the one it shows while that is updated this recently */
const STICKY_QUIET_MS = 10 * 60 * 1000
/** an older snapshot is not "the newest session", unless nothing else exists */
const NEWEST_MAX_AGE_MS = 12 * 60 * 60 * 1000
/** older snapshots are deleted, at start and then hourly */
const PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000
const PRUNE_EVERY_MS = 60 * 60 * 1000
const PING_EVERY_MS = 15_000
const SESSIONS_MAX = 50
const BODY_MAX = 10_000
/** presses kept per session, and sessions with presses waiting */
const QUEUE_MAX = 20
const INBOX_MAX = 100
/** a page that stops reading its stream is dropped once this much waits for it */
const STREAM_BACKLOG_MAX = 4 * 1024 * 1024
/** viewer.log starts over at a --detach start once it is this big */
const LOG_MAX = 1024 * 1024
/** a taken port is tried again this often, this many times, before the server gives up */
const BIND_RETRY_MS = 200
const BIND_TRIES = 10
const SID_RE = /^[A-Za-z0-9_-]{1,80}$/
const KEY_RE = /^[A-Za-z0-9_-]{20,}$/
const ACTIONS = new Set(['why', 'tip', 'known', 'pause', 'level'])
/** Only names of this machine: a page that rebinds its own domain to 127.0.0.1 is turned away. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
const JSON_TYPE = 'application/json'
const LOG_REQUESTS = process.env.PAIRWATCH_VIEWER_LOG === '1'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const opt = name => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
}
const portText = String(opt('port') ?? process.env.PAIRWATCH_PORT ?? DEFAULT_PORT)
const PORT = /^\d{1,5}$/.test(portText) ? Number(portText) : Number.NaN
const DIR = resolve(opt('dir') ?? join(homedir(), '.claude', 'pairwatch'))
const LIVE = join(DIR, 'live')

const log = (...parts) => console.log(new Date().toISOString(), ...parts)
let lastErrorAt = Number.NEGATIVE_INFINITY
/** An unexpected error, to viewer.log: at most one a minute, so a repeating one cannot flood it. */
function logError(where, err) {
  const now = Date.now()
  if (now - lastErrorAt < 60_000) return
  lastErrorAt = now
  console.error(new Date().toISOString(), `error (${where}):`, err && err.stack ? err.stack : String(err))
}

const chmodQuietly = (path, mode) => {
  try {
    chmodSync(path, mode)
  } catch {
    // best effort (Windows keeps its own permissions)
  }
}

// ------------------------------------------------------------------ --detach

/**
 * Starts this server again with the same arguments but --detach, detached from the caller (no
 * shell, no setsid: the same on Linux, macOS and Windows), its output appended to viewer.log, and
 * exits as soon as it runs: the caller never waits on it, and a reload of the mod never stops it.
 */
function detach() {
  try {
    mkdirSync(DIR, { recursive: true, mode: 0o700 })
    const logFile = join(DIR, 'viewer.log')
    try {
      if (statSync(logFile).size > LOG_MAX) truncateSync(logFile, 0)
    } catch {
      // no log yet
    }
    const fd = openSync(logFile, 'a', 0o600)
    chmodQuietly(logFile, 0o600)
    const args = []
    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i] === '--detach') continue
      args.push(argv[i])
      // the folder as a full path: the new process runs in it, so a relative one would point elsewhere
      if (argv[i] === '--dir' && i + 1 < argv.length) {
        args.push(DIR)
        i += 1
      }
    }
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], {
      detached: true,
      stdio: ['ignore', fd, fd],
      cwd: DIR,
      windowsHide: true,
    })
    closeSync(fd)
    child.once('error', err => {
      console.error(`pairwatch viewer: could not start in the background: ${err.message}`)
      process.exit(1)
    })
    child.once('spawn', () => {
      child.unref()
      process.exit(0)
    })
  } catch (err) {
    console.error(`pairwatch viewer: could not start in the background: ${err && err.message ? err.message : String(err)}`)
    process.exit(1)
  }
}

// ------------------------------------------------------------------ the key

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function readKey(file) {
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    return undefined
  }
}

/** The key: made once, kept in a file only this user can read, the same across restarts. */
function loadKey(file) {
  const kept = readKey(file)
  if (kept !== undefined && KEY_RE.test(kept)) return kept
  const made = randomBytes(24).toString('base64url')
  if (kept === undefined) {
    try {
      // created only if absent: of two servers starting at once, both end up with the first one's key
      writeFileSync(file, `${made}\n`, { mode: 0o600, flag: 'wx' })
      return made
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err
    }
    for (let i = 0; i < 25; i += 1) {
      const theirs = readKey(file)
      if (theirs !== undefined && KEY_RE.test(theirs)) return theirs
      sleep(20) // the other server is writing it
    }
  }
  writeFileSync(file, `${made}\n`, { mode: 0o600 })
  return made
}

let KEY = Buffer.alloc(0)
function isKey(value) {
  const given = Buffer.from(typeof value === 'string' ? value : '')
  return KEY.length > 0 && given.length === KEY.length && timingSafeEqual(given, KEY)
}

function hostOf(value) {
  if (typeof value !== 'string' || value === '') return ''
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname.toLowerCase()
  } catch {
    return '?'
  }
}
const isLocal = value => LOCAL_HOSTS.has(hostOf(value))

// ------------------------------------------------------------------ snapshots

/** One look at a session's snapshot file: when it was written and its version, or null when there is none. */
function statSnap(sid) {
  try {
    const st = statSync(join(LIVE, `${sid}.json`))
    return { sid, mtimeMs: st.mtimeMs, version: `${st.mtimeMs}:${st.size}` }
  } catch {
    return null
  }
}

/** sid -> what its snapshot holds, as last read: { version, ended, meta, text } (text null when read for the list only) */
const snaps = new Map()
/** the live folder as last listed, newest first */
let listed = { at: Number.NEGATIVE_INFINITY, list: [] }
let lastActivity = Date.now()

/** The snapshots in the live folder, newest first: listed at most once a second however many ask. */
function listing(now) {
  if (now - listed.at < LIST_EVERY_MS) return listed.list
  let names = []
  try {
    names = readdirSync(LIVE)
  } catch {
    // no folder yet
  }
  const list = []
  for (const name of names) {
    const sid = name.endsWith('.json') ? name.slice(0, -5) : ''
    if (!SID_RE.test(sid)) continue
    const st = statSnap(sid)
    if (st !== null) list.push(st) // else it vanished between the listing and the look
  }
  list.sort((a, b) => b.mtimeMs - a.mtimeMs)
  listed = { at: now, list }
  const present = new Set(list.map(st => st.sid))
  for (const sid of snaps.keys()) if (!present.has(sid)) snaps.delete(sid)
  return list
}

/**
 * What a snapshot holds, read again only when its file changed; a half-written file is skipped
 * until the next look. `withText` keeps its text, for a page that shows it (the list needs less).
 */
function snapOf(st, withText) {
  const known = snaps.get(st.sid)
  if (known !== undefined && known.version === st.version && (known.text !== null || !withText)) return known
  let text
  let snap
  try {
    text = readFileSync(join(LIVE, `${st.sid}.json`), 'utf8')
    snap = JSON.parse(text)
  } catch {
    return known ?? null
  }
  if (snap === null || typeof snap !== 'object' || Array.isArray(snap)) return known ?? null
  if (known === undefined || known.version !== st.version) lastActivity = Date.now()
  const entry = {
    version: st.version,
    ended: snap.ended === true,
    meta: {
      cwd: typeof snap.cwd === 'string' ? snap.cwd.slice(0, 500) : '',
      goal: typeof snap.goalText === 'string' ? snap.goalText.slice(0, 200) : '',
      at: typeof snap.at === 'number' ? snap.at : st.mtimeMs,
    },
    text: withText ? text : null,
  }
  snaps.set(st.sid, entry)
  return entry
}

/**
 * The newest session: the most recently written snapshot that is not ended and not older than
 * 12 hours; when there is none, the most recent of all ('' when the folder is empty).
 */
function newestSid(now) {
  const list = listing(now)
  for (const st of list) {
    if (now - st.mtimeMs > NEWEST_MAX_AGE_MS) break // newest first: the rest are older still
    const snap = snapOf(st, false)
    if (snap !== null && !snap.ended) return st.sid
  }
  return list[0]?.sid ?? ''
}

/** Deletes the snapshots not written for a week. */
function prune(now) {
  let names = []
  try {
    names = readdirSync(LIVE)
  } catch {
    return
  }
  let count = 0
  for (const name of names) {
    const sid = name.endsWith('.json') ? name.slice(0, -5) : ''
    if (!SID_RE.test(sid)) continue
    const st = statSnap(sid)
    if (st === null || now - st.mtimeMs <= PRUNE_AGE_MS) continue
    try {
      unlinkSync(join(LIVE, name))
      snaps.delete(sid)
      count += 1
    } catch {
      // the next pass tries again
    }
  }
  if (count > 0) {
    listed = { at: Number.NEGATIVE_INFINITY, list: [] }
    log(`deleted ${count} snapshot${count === 1 ? '' : 's'} older than 7 days`)
  }
}

// ------------------------------------------------------------------ pages and their streams

/**
 * Open pages, one event stream each: `sid` is the session it asked for ('' follows the newest),
 * `current` the one it shows now ('' none), `sent` what it was last sent.
 */
const clients = new Set()
const SENT_EMPTY = Symbol('empty')

/** Pages showing a session: following it by name, or following the newest while it is that one. */
function watchingOf(sid) {
  let count = 0
  for (const client of clients) if (client.current === sid) count += 1
  return count
}

/**
 * The session a page shows: the one it asked for by name; else the one it already shows, while
 * that goes on (not ended, updated in the last 10 minutes); else the newest.
 */
function follow(client, now, look) {
  if (client.sid !== '') return client.sid
  if (client.current !== '') {
    const st = look(client.current)
    if (st !== null && now - st.mtimeMs <= STICKY_QUIET_MS) {
      const snap = snapOf(st, true)
      if (snap !== null && !snap.ended) return client.current
    }
  }
  return newestSid(now)
}

function sendEvent(client, event, text) {
  const { res } = client
  if (res.writableLength > STREAM_BACKLOG_MAX) {
    clients.delete(client)
    res.destroy()
    return
  }
  try {
    res.write(`event: ${event}\n${text.split('\n').map(line => `data: ${line}`).join('\n')}\n\n`)
  } catch {
    clients.delete(client)
  }
}

/** Brings a page up to date: the snapshot of the session it shows when that changed, or 'empty' when there is none. */
function push(client, now, look) {
  client.current = follow(client, now, look)
  const st = client.current === '' ? null : look(client.current)
  if (st === null) {
    if (client.sent !== SENT_EMPTY) {
      client.sent = SENT_EMPTY
      sendEvent(client, 'empty', '{}')
    }
    return
  }
  const snap = snapOf(st, true)
  if (snap === null || snap.text === null) {
    // not readable yet (half-written): a page that has nothing yet waits meanwhile
    if (client.sent === null) {
      client.sent = SENT_EMPTY
      sendEvent(client, 'empty', '{}')
    }
    return
  }
  if (snap.text === client.sent) return
  client.sent = snap.text
  sendEvent(client, 'snapshot', snap.text)
}

/** Four times a second: one stat per session a page follows; the folder is listed only to pick the newest. */
function tick() {
  const now = Date.now()
  const looks = new Map()
  const look = sid => {
    if (!looks.has(sid)) looks.set(sid, statSnap(sid))
    return looks.get(sid)
  }
  for (const client of clients) push(client, now, look)
  if (clients.size === 0 && now - lastActivity > IDLE_EXIT_MS) {
    // a snapshot written meanwhile counts too
    const newest = listing(now)[0]
    if (newest !== undefined) lastActivity = Math.max(lastActivity, newest.mtimeMs)
    if (now - lastActivity > IDLE_EXIT_MS) {
      log('no page open, no session asking and no snapshot written for 8 hours: exiting')
      process.exit(0)
    }
  }
}

function openStream(res, url) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
  res.write('retry: 1500\n\n')
  const asked = url.searchParams.get('sid') ?? ''
  const client = { res, sid: SID_RE.test(asked) ? asked : '', current: '', sent: null }
  clients.add(client)
  lastActivity = Date.now()
  // the response never ends, so its 'close' is the page going away
  const drop = () => clients.delete(client)
  res.on('close', drop)
  res.on('error', drop)
  push(client, Date.now(), statSnap) // its first view at once
}

function sessionList(now) {
  return listing(now)
    .slice(0, SESSIONS_MAX)
    .map(st => {
      const snap = snapOf(st, false)
      return { sid: st.sid, mtimeMs: st.mtimeMs, ...(snap === null ? { cwd: '', goal: '', at: st.mtimeMs } : snap.meta), ended: snap?.ended === true }
    })
}

// ------------------------------------------------------------------ the page's presses

/** sid -> presses waiting for its mod, oldest first */
const inbox = new Map()

function queuePress(sid, press) {
  const queue = inbox.get(sid) ?? []
  queue.push(press)
  inbox.delete(sid) // set again below, so the map runs from the longest-waiting session to this one
  inbox.set(sid, queue.slice(-QUEUE_MAX))
  while (inbox.size > INBOX_MAX) inbox.delete(inbox.keys().next().value)
}

/** The request body as text; '' when it is too long or cut off before its end (it always settles). */
function readBody(req) {
  return new Promise(settle => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => {
      body += chunk
      if (body.length > BODY_MAX) {
        settle('')
        req.destroy()
      }
    })
    req.on('end', () => settle(body))
    req.on('error', () => settle(''))
    req.on('aborted', () => settle(''))
    req.on('close', () => settle('')) // after 'end' this changes nothing
  })
}

// ------------------------------------------------------------------ HTTP

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers })
  res.end(body)
}

/** Errors say no more than their status. */
const fail = (res, status) => send(res, status, JSON_TYPE, JSON.stringify({ ok: false, error: http.STATUS_CODES[status] ?? 'Error' }))

let page = { html: '', csp: '' }
/** The page, read per request (an edited page shows on the next reload), with a policy that runs its own script only. */
function pageNow() {
  const html = readFileSync(join(HERE, 'index.html'), 'utf8')
  if (html !== page.html) {
    const hashes = []
    for (const m of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
      if (/\ssrc\s*=/i.test(m[1] ?? '')) continue
      // the browser hashes the script as parsed: its line ends made LF
      hashes.push(`'sha256-${createHash('sha256').update(m[2].replace(/\r\n?/g, '\n')).digest('base64')}'`)
    }
    const csp = [
      "default-src 'none'",
      `script-src ${hashes.length > 0 ? hashes.join(' ') : "'none'"}`,
      "style-src 'unsafe-inline'",
      'img-src data:',
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; ')
    page = { html, csp }
  }
  return page
}

async function handle(req, res) {
  let url
  try {
    url = new URL(req.url ?? '/', 'http://localhost')
  } catch {
    return fail(res, 400)
  }
  const path = url.pathname
  if (LOG_REQUESTS && path !== '/health' && path !== '/api/inbox') {
    log(req.method, path, '|', String(req.headers['user-agent'] ?? '').slice(0, 60), '|', String(req.headers.host ?? '').slice(0, 60))
  }
  // DNS rebinding and cross-site requests: the Host must be this machine, and an Origin, when sent, too.
  if (!isLocal(req.headers.host) || (req.headers.origin !== undefined && !isLocal(req.headers.origin))) return fail(res, 403)
  if (path.startsWith('/api/') && !isKey(req.headers['x-pairwatch-key'] ?? url.searchParams.get('key'))) return fail(res, 403)

  if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
    const { html, csp } = pageNow()
    return send(res, 200, 'text/html; charset=utf-8', html, { 'content-security-policy': csp, 'referrer-policy': 'no-referrer' })
  }
  if (path === '/health') {
    return send(res, 200, JSON_TYPE, JSON.stringify({ ok: true, app: APP, version: VERSION, clients: clients.size }))
  }
  if (path === '/api/sessions') return send(res, 200, JSON_TYPE, JSON.stringify(sessionList(Date.now())))
  if (path === '/api/state') {
    const asked = url.searchParams.get('sid') ?? ''
    const sid = SID_RE.test(asked) ? asked : newestSid(Date.now())
    const st = sid === '' ? null : statSnap(sid)
    const snap = st === null ? null : snapOf(st, true)
    return snap !== null && snap.text !== null ? send(res, 200, JSON_TYPE, snap.text) : send(res, 404, JSON_TYPE, '{"empty":true}')
  }
  if (path === '/api/events') return openStream(res, url)
  if (path === '/api/action' && req.method === 'POST') {
    // JSON only: a page elsewhere cannot send it cross-site without a preflight this server never answers
    if (!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] ?? ''))) return fail(res, 415)
    const body = await readBody(req)
    let msg
    try {
      msg = JSON.parse(body)
    } catch {
      return fail(res, 400)
    }
    if (msg === null || typeof msg !== 'object' || !ACTIONS.has(msg.action)) return fail(res, 400)
    const sid = typeof msg.sid === 'string' && SID_RE.test(msg.sid) ? msg.sid : newestSid(Date.now())
    if (sid === '') return fail(res, 400)
    queuePress(sid, { action: msg.action, value: typeof msg.value === 'string' ? msg.value.slice(0, 40) : undefined, at: Date.now() })
    return send(res, 200, JSON_TYPE, '{"ok":true}')
  }
  if (path === '/api/quit' && req.method === 'POST') {
    // a newer Pairwatch replaces this server: answer, free the port at once, then go
    log('asked to quit')
    send(res, 200, JSON_TYPE, '{"ok":true}')
    server.close()
    setTimeout(() => process.exit(0), 50)
    return
  }
  if (path === '/api/inbox') {
    // the mod collects the presses for its session, and learns how many pages show it
    lastActivity = Date.now()
    const sid = url.searchParams.get('sid') ?? ''
    const isSid = SID_RE.test(sid)
    const actions = isSid ? inbox.get(sid) ?? [] : []
    if (isSid) inbox.delete(sid)
    return send(res, 200, JSON_TYPE, JSON.stringify({ actions, clients: clients.size, watching: isSid ? watchingOf(sid) : 0 }))
  }
  return fail(res, 404)
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    logError(req.method ?? 'request', err)
    if (!res.headersSent) fail(res, 500)
    else res.destroy()
  })
})

function serve() {
  try {
    // the snapshots hold commands and paths: this user's eyes only
    mkdirSync(LIVE, { recursive: true, mode: 0o700 })
    chmodQuietly(DIR, 0o700)
    chmodQuietly(LIVE, 0o700)
    const keyFile = join(DIR, 'viewer.token')
    KEY = Buffer.from(loadKey(keyFile))
    chmodQuietly(keyFile, 0o600)
  } catch (err) {
    console.error(new Date().toISOString(), `cannot set up ${DIR}: ${err && err.message ? err.message : String(err)}`)
    process.exit(1)
  }
  prune(Date.now())
  // started by a Node process over an IPC channel (the specs do): it goes when that process goes,
  // however that ends. The mod's start (--detach) has no such channel.
  if (typeof process.send === 'function') process.once('disconnect', () => process.exit(0))

  setInterval(() => {
    try {
      tick()
    } catch (err) {
      logError('tick', err)
    }
  }, TICK_MS)
  // keep event streams alive through proxies and port forwarding
  setInterval(() => {
    for (const client of clients) {
      try {
        client.res.write(': ping\n\n')
      } catch {
        clients.delete(client)
      }
    }
  }, PING_EVERY_MS)
  setInterval(() => {
    try {
      prune(Date.now())
    } catch (err) {
      logError('prune', err)
    }
  }, PRUNE_EVERY_MS)

  let bindTries = 0
  server.on('error', err => {
    if (err && err.code === 'EADDRINUSE') {
      // an older server asked to quit may still hold the port for a moment
      if (bindTries < BIND_TRIES) {
        bindTries += 1
        setTimeout(() => {
          server.close()
          server.listen(PORT, '127.0.0.1')
        }, BIND_RETRY_MS)
        return
      }
      // most often another Pairwatch page server, started a moment earlier for another session
      log(`port ${PORT} is taken (by another Pairwatch page server, or by another program: then set Pairwatch's Viewer port to a free one)`)
      process.exit(0)
    }
    console.error(new Date().toISOString(), `cannot serve on port ${PORT}: ${err && err.message ? err.message : String(err)}`)
    process.exit(1)
  })
  server.listen(PORT, '127.0.0.1', () => {
    const address = server.address()
    const port = address !== null && typeof address === 'object' ? address.port : PORT
    log(`pairwatch viewer ${VERSION} (pid ${process.pid}) on http://localhost:${port}, snapshots in ${LIVE}`)
  })
}

// ------------------------------------------------------------------ start (last: everything above is set up)

if (!(PORT >= 0 && PORT <= 65535)) {
  console.error(`pairwatch viewer: --port takes a number from 0 to 65535, not ${JSON.stringify(portText.slice(0, 20))}`)
  process.exit(2)
}
if (argv.includes('--detach')) detach()
else serve()
