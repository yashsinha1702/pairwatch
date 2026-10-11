// Secrets out of everything Pairwatch shows or sends to a model. Pure, no `$`.
//
// API keys, tokens, passwords, private keys and long random strings become '••••'. The label that
// says what a secret was stays, so the step still reads: 'HF_TOKEN=••••', 'Authorization: Bearer ••••',
// 'mysql -p••••', 'https://ana:••••@db.example.com', 'ghp_••••'. A value that hides nothing is left
// alone: one already masked ('••••', '…', '***'), or a reference to where the secret lives ($TOKEN,
// ${TOKEN}, $(cat token.txt), %TOKEN%).
//
// What counts as a secret:
//   - private key blocks (-----BEGIN … PRIVATE KEY-----): the body, line by line
//   - Authorization / Proxy-Authorization / Cookie headers (any value), and Bearer / Basic / Token credentials
//   - the password in user:password@host, curl -u user:password, mysql -p<password>, docker login -p,
//     sshpass -p and redis-cli -a, and the value of --password / --token style flags
//   - KEY=value, key: value, ?key=value and "key": "value" whose key names a secret: password, passwd,
//     pwd, pass, passphrase, secret, token, api_key, access_key, private_key, credentials, signature …
//   - tokens known by their prefix: sk-…, sk-ant-…, ghp_ / gho_ / ghu_ / ghs_ / ghr_…, github_pat_…,
//     xoxb- / xoxp- …, AKIA…, AIza…, hf_…, glpat-…, npm_…, pypi-…, sk_live_…, and JWTs (eyJ….….…)
//   - runs of 32+ hex digits (unless they name a file or sit in a file path), and runs of 32+ base64
//     characters that look random (mixed case and digits)
// Not secrets: ordinary words, paths, UUIDs, git SHAs of 7–12 characters, code such as
// `token = get_token()` or `password: str`.
//
// Total (odd input gives ''), line-preserving (newlines are never added or removed) and idempotent
// (masking masked text changes nothing).

/** What a secret is replaced with. */
export const MASK = '••••'

type Rule = readonly [RegExp, (m: string, ...g: string[]) => string]

const quoteOf = (v: string): string => (/^(["'`]).*\1$/s.test(v) && v.length >= 2 ? v.charAt(0) : '')
const unquote = (v: string): string => (quoteOf(v) === '' ? v : v.slice(1, -1))

/** Hides nothing: empty, masked already, or a reference to where the secret lives. */
function isHidden(raw: string): boolean {
  const v = unquote(raw.trim())
  return v === '' || v.includes(MASK) || /^[•…*]+$/.test(v) || v.startsWith('$') || /^%\w+%$/.test(v)
}

/** A masked value, quoted as the original was: '"••••"' for '"hunter2"'. */
const masked = (raw: string): string => {
  const q = quoteOf(raw)
  return `${q}${MASK}${q}`
}

/** 'user:password' (quoted or not) with the password masked; a value with no ':' names a user only. */
function maskAfterColon(raw: string): string {
  const q = quoteOf(raw)
  const v = unquote(raw)
  const i = v.indexOf(':')
  if (i < 0 || isHidden(v.slice(i + 1))) return raw
  return `${q}${v.slice(0, i)}:${MASK}${q}`
}

/** Mixed case and digits, as random keys are and words and paths are not. */
function looksRandom(s: string): boolean {
  const count = (re: RegExp): number => (s.match(re) ?? []).length
  return count(/[0-9]/g) >= 2 && count(/[A-Z]/g) >= 2 && count(/[a-z]/g) >= 2
}

/**
 * A long base64-like run with its key hidden. A run with + or = padding, or with no '/', is one blob:
 * masked whole when it looks random. A run with slashes and neither is a path or a URL's path: only
 * its random-looking parts go ('com/T00/B00/••••'), and only when one of them is 24+ characters long.
 */
function maskRun(run: string): string {
  const body = run.replace(/=+$/, '')
  if (body.length < 32) return run
  if (!body.includes('/') || body.includes('+') || body !== run) return looksRandom(body) ? MASK : run
  const parts = body.split('/')
  if (!parts.some(p => p.length >= 24 && looksRandom(p))) return run
  return parts.map(p => (p.length >= 8 && looksRandom(p) ? MASK : p)).join('/')
}

/** The offset of a match and the whole text, which a replacer receives after its groups. */
const placeOf = (rest: readonly unknown[]): { at: number; text: string } => ({ at: Number(rest[rest.length - 2]), text: String(rest[rest.length - 1]) })

/** Characters that end a word of a command or a text: a path or a URL never holds one unescaped. */
const WORD_END = /[\s"'`=(),;|&<>]/

/**
 * A run of 32+ hex digits that is a key: it mixes digits and letters, and it is not a file's name or
 * part of a file path ('/var/cache/blobs/0a1b…/model.bin' and '0a1b….json' name content hashes,
 * '.git/objects/pack/pack-0a1b….idx' a pack). Inside a URL it still counts: webhook URLs carry their
 * secret in the path.
 */
function isHexKey(run: string, at: number, text: string): boolean {
  if (!/[0-9]/.test(run) || !/[a-f]/i.test(run)) return false
  if (/^\.[A-Za-z][A-Za-z0-9]{0,7}(?![\w.])/.test(text.slice(at + run.length, at + run.length + 10))) return false
  let start = at
  while (start > 0 && at - start < 400 && !WORD_END.test(text.charAt(start - 1))) start--
  let end = at + run.length
  while (end < text.length && end - at < 400 && !WORD_END.test(text.charAt(end))) end++
  const word = text.slice(start, end)
  return !(word.includes('/') && !word.includes('://'))
}

/** A Bearer value worth hiding: token-shaped (digits, symbols, mixed case or long), not a word of prose. */
const isTokenish = (v: string): boolean =>
  (v.length >= 8 && (/[0-9._~+/=-]/.test(v) || (v.match(/[A-Z]/g) ?? []).length >= 2)) || v.length >= 24

/** Key names whose value is a secret (matched at the end of the key: DB_PASSWORD, apiKey, x-auth-token). */
const SECRET_NAME =
  /(?:passw(?:or)?d|passphrase|secret|token|credentials?|signature|apikey|(?:api|access|secret|private|auth|client|master|encryption|signing|app|license)[_.-]?key)$|(?:^|[_.-])(?:pwd|pass|pw|sig)$/i

/** Values that are words of code or config, not secrets: 'token: str', 'is_secret: true'. */
const NOT_A_VALUE = /^(?:true|false|null|none|nil|undefined|yes|no|on|off|required|optional)$/i
const TYPE_NAME = /^(?:str|string|int|integer|float|double|number|bool|boolean|bytes|any|unknown|object|char|varchar|text|uuid|date|datetime|secretstr|secretbytes)\??$/i

/** True when `value`, given for `key` with separator `sep`, should stay visible. */
function keepsValue(key: string, sep: string, value: string): boolean {
  if (isHidden(value)) return true
  const v = unquote(value)
  if (NOT_A_VALUE.test(v)) return true
  // the shell's own PWD / OLDPWD hold a folder, not a password
  if (/^(?:OLD)?PWD$/.test(key) && /^[~/]/.test(v)) return true
  if (quoteOf(value) !== '') return false // a quoted literal is the secret itself
  if (/[([{<]/.test(v)) return true // code: a call, an index, a generic type
  if (!sep.includes('=') && TYPE_NAME.test(v)) return true // a type annotation: 'password: str'
  return false
}

const RULES: readonly Rule[] = [
  // a private key block: keep its BEGIN and END lines, hide each line of the body
  [
    /(-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----)([\s\S]*?)(-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
    (_m, begin, body, end) => `${begin}${(body ?? '').replace(/[^\s]+(?:[ \t]+[^\s]+)*/g, MASK)}${end}`,
  ],
  // Authorization: <scheme> <credentials>, as a header, a JSON field or an assignment
  [
    /\b((?:Proxy-)?Authorization["']?[ \t]*[:=][ \t]*["']?)((?:Bearer|Basic|Token|Digest|Bot|Negotiate|ApiKey|Key|JWT|SSWS)[ \t]+)?([^\s"'`\\,;]+)/gi,
    (m, label, scheme, value) => (isHidden(value ?? '') ? m : `${label}${scheme ?? ''}${MASK}`),
  ],
  // the password in scheme://user:password@host
  [
    /\b([a-z][a-z0-9+.-]{1,15}:\/\/[^\s/:@'"]{0,100}:)([^\s/@'"]{1,200})@/gi,
    (m, head, pass) => (isHidden(pass ?? '') ? m : `${head}${MASK}@`),
  ],
  // Cookie: and Set-Cookie: headers hold sessions: the whole value goes
  [
    /\b((?:Set-)?Cookie["']?[ \t]*:[ \t]*["']?)([^"'\n]+)/gi,
    (m, label, value) => (isHidden(value ?? '') ? m : `${label}${MASK}`),
  ],
  // curl -u user:password, curl --user=user:password (a shell word: "quoted", 'quoted' or bare)
  [
    /(\bcurl\b[^\n|;&]{0,300}?[ \t](?:-u|--user)(?:[ \t]+|=)?)("[^"\n]*"|'[^'\n]*'|[^\s"'`;|&<>]+)/g,
    (_m, head, value) => `${head}${maskAfterColon(value ?? '')}`,
  ],
  // mysql -p<password> (attached: '-p secret' asks for the password and names a database)
  [
    /(\b(?:mysql|mysqldump|mysqladmin|mysqlimport|mysqlcheck|mysqlsh|mariadb(?:-dump|-admin)?)\b[^\n|;&]{0,300}?[ \t]-p)("[^"\n]*"|'[^'\n]*'|[^\s"'`;|&<>]+)/g,
    (m, head, value) => (isHidden(value ?? '') ? m : `${head}${masked(value ?? '')}`),
  ],
  // sshpass -p <password>, docker / podman login -p <password>, redis-cli -a <password>
  [
    /(\b(?:sshpass(?:[ \t]+-[a-zA-Z])*[ \t]+-p|(?:docker|podman|nerdctl|buildah)[ \t]+(?:registry[ \t]+)?login\b[^\n|;&]{0,300}?[ \t]-p|redis-cli\b[^\n|;&]{0,300}?[ \t]-a)(?:[ \t]+|(?=[^\s-])))("[^"\n]*"|'[^'\n]*'|[^\s"'`;|&<>-][^\s"'`;|&<>]*)/g,
    (m, head, value) => (isHidden(value ?? '') ? m : `${head}${masked(value ?? '')}`),
  ],
  // --password <value>, --token <value> (the --flag=value form is a key=value below)
  [
    /((?<![\w-])--(?:password|passwd|pass|token|api-key|apikey|access-token|auth-token|client-secret|secret-key)[ \t]+)("[^"\n]*"|'[^'\n]*'|[^\s"'`;|&<>-][^\s"'`;|&<>]*)/gi,
    (m, head, value) => (isHidden(value ?? '') ? m : `${head}${masked(value ?? '')}`),
  ],
  // KEY=value, key: value, ?key=value, "key": "value", --key=value, **key**: value, whose key names a secret
  [
    /(?<![\w.-])(-{0,2}[A-Za-z_][\w.-]{0,80})(["'*`]{0,4}[ \t]*(?::=|=(?![=>~])|:(?![:=/]))[ \t]*[*`]{0,4}[ \t]*)((?:Bearer|Basic|Token|Digest)[ \t]+)?("[^"\n]*"|'[^'\n]*'|[^\s"'`&;,|<>)\]}]+)/g,
    (m, key, sep, scheme, value) => {
      const name = (key ?? '').replace(/^-+/, '').replace(/_+$/, '')
      if (!SECRET_NAME.test(name) || keepsValue(name, sep ?? '', value ?? '')) return m
      return `${key}${sep}${scheme ?? ''}${masked(value ?? '')}`
    },
  ],
  // Bearer / Basic / Token credentials outside a header
  [/\b(Bearer[ \t]+)([A-Za-z0-9._~+/=-]+)/gi, (m, label, v) => (isTokenish(v ?? '') ? `${label}${MASK}` : m)],
  [
    /\b((?:Basic|Token)[ \t]+)([A-Za-z0-9._~+/=-]{8,})/gi,
    (m, label, v) => (/[0-9]/.test(v ?? '') || ((v ?? '').match(/[A-Z]/g) ?? []).length >= 2 ? `${label}${MASK}` : m),
  ],
  // tokens known by their prefix: the prefix stays as the label
  [/\b(sk-(?:ant-|proj-|svcacct-|admin-)?)([A-Za-z0-9_-]{16,})/g, (m, label, body) => (/[0-9]/.test(body ?? '') ? `${label}${MASK}` : m)],
  [/\b([sr]k_(?:live|test)_)[A-Za-z0-9]{16,}\b/g, (_m, label) => `${label}${MASK}`],
  [/\b(gh[pousr]_)[A-Za-z0-9]{16,}\b/g, (_m, label) => `${label}${MASK}`],
  [/\b(github_pat_)[A-Za-z0-9_]{20,}/g, (_m, label) => `${label}${MASK}`],
  [/\b(xox[abeoprs]-)[A-Za-z0-9-]{8,}/g, (_m, label) => `${label}${MASK}`],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, (_m, label) => `${label}${MASK}`],
  [/\b(AIza)[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g, (_m, label) => `${label}${MASK}`],
  [/\b(hf_)[A-Za-z0-9]{20,}\b/g, (_m, label) => `${label}${MASK}`],
  [/\b(glpat-)[A-Za-z0-9_-]{20,}/g, (_m, label) => `${label}${MASK}`],
  [/\b(npm_)[A-Za-z0-9]{30,}\b/g, (_m, label) => `${label}${MASK}`],
  [/\b(pypi-)[A-Za-z0-9_-]{40,}/g, (_m, label) => `${label}${MASK}`],
  // a JSON Web Token: header.payload.signature
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g, () => MASK],
  // long random runs: 32+ hex digits (with letters and digits both), 32+ base64 characters that look random
  [/\b[0-9a-fA-F]{32,}\b/g, (m, ...rest) => {
    const { at, text } = placeOf(rest)
    return isHexKey(m, at, text) ? MASK : m
  }],
  [/[A-Za-z0-9+/_-]{32,}={0,2}/g, m => maskRun(m)],
]

/** Anything a rule could match: text without any of these is returned as it is, quickly. */
const MAYBE =
  /[=:@]|-p\S|[ \t]-a|sshpass|login|redis-cli|cookie|\b[sr]k[-_]|gh[pousr]_|github_pat_|xox[a-z]-|AKIA|ASIA|AIza|hf_|glpat-|npm_|pypi-|eyJ|bearer|basic[ \t]|token[ \t]|--(?:pass|token|api|access|auth|client|secret)|PRIVATE KEY|[A-Za-z0-9+/_-]{32}/i

/** Hide secrets (API keys, tokens, passwords, private keys, long random strings) in text, keeping their labels. */
export function redactSecrets(text: string): string {
  if (typeof text !== 'string' || text === '') return ''
  try {
    if (!MAYBE.test(text)) return text
    let out = text
    for (const [re, to] of RULES) {
      re.lastIndex = 0
      out = out.replace(re, to)
    }
    return out
  } catch {
    // a regex can only fail on absurd input: show nothing rather than something unmasked
    return ''
  }
}
