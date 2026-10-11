// redact.ts: secrets out of everything Pairwatch shows or sends. Run: node --test dev/spec/redact.spec.ts
//
// Every fake secret here is built in pieces ('gh' + 'p_' + …), so no scanner mistakes this file for
// one holding real keys.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MASK, redactSecrets } from '../../pairwatch/hooks/core/redact.ts'

const R = redactSecrets
const x36 = 'x'.repeat(36)

/** Each [input, expected] pair, plus the properties every output keeps. */
function expectAll(cases: readonly (readonly [string, string])[]): void {
  for (const [input, expected] of cases) {
    const out = R(input)
    assert.equal(out, expected, input)
    assert.equal(R(out), out, `masking twice changes nothing: ${input}`)
    assert.equal(out.split('\n').length, input.split('\n').length, `same lines: ${input}`)
  }
}

describe('tokens known by their prefix keep the prefix as their label', () => {
  it('Anthropic and OpenAI style keys: sk-…, sk-ant-…, sk-proj-…', () => {
    expectAll([
      [`key ${'sk-' + 'ant-api03-' + 'AbCdEf0123456789xyzXYZ'} ok`, 'key sk-ant-•••• ok'],
      [`key ${'sk-' + 'proj-' + 'AbCdEfGh1234567890abcd'} ok`, 'key sk-proj-•••• ok'],
      [`key ${'sk-' + 'Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2'}`, 'key sk-••••'],
    ])
  })

  it('GitHub tokens: ghp_, gho_, ghs_, ghu_, ghr_ and github_pat_', () => {
    expectAll([
      [`token ${'gh' + 'p_' + x36}`, 'token ghp_••••'],
      [`token ${'gh' + 'o_' + x36}`, 'token gho_••••'],
      [`token ${'gh' + 's_' + x36}`, 'token ghs_••••'],
      [`token ${'gh' + 'u_' + x36}`, 'token ghu_••••'],
      [`token ${'gh' + 'r_' + x36}`, 'token ghr_••••'],
      [`pat ${'github' + '_pat_' + '11ABCDEFG0' + 'a'.repeat(50)}`, 'pat github_pat_••••'],
    ])
  })

  it('Slack tokens: xoxa-, xoxb-, xoxp-, xoxr-, xoxs-', () => {
    for (const kind of ['a', 'b', 'p', 'r', 's']) expectAll([[`slack ${'xo' + 'x' + kind + '-' + '1234567890-abcdefghij'}`, `slack xox${kind}-••••`]])
  })

  it('AWS access key ids: AKIA…, ASIA…', () => {
    expectAll([
      [`aws ${'AKIA' + 'IOSFODNN7EXAMPLE'} id`, 'aws AKIA•••• id'],
      [`aws ${'ASIA' + 'Q3EGRZ5XEXAMPLE7'} id`, 'aws ASIA•••• id'],
    ])
  })

  it('Hugging Face tokens: hf_…', () => {
    expectAll([[`login ${'hf' + '_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz012345'}`, 'login hf_••••']])
  })

  it('more prefixes: glpat-, npm_, pypi-, sk_live_, AIza, and JSON Web Tokens', () => {
    expectAll([
      [`gitlab ${'glpat' + '-' + 'AbCdEf0123456789xyzXY'}`, 'gitlab glpat-••••'],
      [`npm ${'npm' + '_' + 'a'.repeat(36)}`, 'npm npm_••••'],
      [`pypi ${'pypi' + '-' + 'AgEIcHlwaS5vcmcCJDAwMDAwMDAwLTAwMDAtMDAwMC0wMDAw'}`, 'pypi pypi-••••'],
      [`stripe ${'sk' + '_live_' + 'AbCdEf0123456789xyzXY'}`, 'stripe sk_live_••••'],
      [`google ${'AIza' + 'SyA1234567890abcdefghijklmnopqrstuv'} key`, 'google AIza•••• key'],
      [`jwt ${'eyJ' + 'hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'} ok`, 'jwt •••• ok'],
    ])
  })
})

describe('headers: Authorization (any value) and Bearer / Basic / Token credentials', () => {
  it('Authorization: x, with or without a scheme, as a header, JSON or an assignment', () => {
    expectAll([
      ['curl -H "Authorization: x" https://api.example.com/v1', 'curl -H "Authorization: ••••" https://api.example.com/v1'],
      ['curl -H "Authorization: Bearer x" https://api.example.com/v1', 'curl -H "Authorization: Bearer ••••" https://api.example.com/v1'],
      ["curl -H 'Authorization: token abc123def456' https://api.github.com", "curl -H 'Authorization: token ••••' https://api.github.com"],
      ['Authorization: Basic dXNlcjpwYXNz', 'Authorization: Basic ••••'],
      ['Proxy-Authorization: Negotiate YIIBhwYGKwYBBQUC', 'Proxy-Authorization: Negotiate ••••'],
      ['{"Authorization": "Bearer abc"}', '{"Authorization": "Bearer ••••"}'],
      ['authorization: bearer abc', 'authorization: bearer ••••'],
    ])
  })

  it('Cookie and Set-Cookie: the whole value', () => {
    expectAll([
      ['curl -H "Cookie: session=abc; csrftoken=def" https://x.io', 'curl -H "Cookie: ••••" https://x.io'],
      ['Set-Cookie: sid=abc123; Path=/; HttpOnly', 'Set-Cookie: ••••'],
      ['curl -b cookies.txt https://x.io', 'curl -b cookies.txt https://x.io'],
    ])
  })

  it('Bearer x outside a header: a token-shaped value is hidden, a word of prose is not', () => {
    expectAll([
      ['use Bearer abc123def456ghi789 here', 'use Bearer •••• here'],
      ['header Bearer abc.def-ghi_jkl', 'header Bearer ••••'],
      ['send Basic dXNlcjpwYXNzd29yZA== now', 'send Basic •••• now'],
      ['send Token 9f8e7d6c5b4a3210 now', 'send Token •••• now'],
    ])
  })
})

describe('password / passwd / pwd / token / api_key / secret values', () => {
  it('in environment assignments', () => {
    expectAll([
      ['HF_TOKEN=hf_AbCdEf python3 train.py', 'HF_TOKEN=•••• python3 train.py'],
      ['DB_PASSWORD=hunter2 ./run.sh', 'DB_PASSWORD=•••• ./run.sh'],
      ['export API_KEY=abc123', 'export API_KEY=••••'],
      ['PGPASSWORD=s3cret psql -h localhost -U app shop', 'PGPASSWORD=•••• psql -h localhost -U app shop'],
      ['MYSQL_PWD=s3cret mysql shop', 'MYSQL_PWD=•••• mysql shop'],
      ['SMTP_PASSWD=x CLIENT_SECRET=y GITHUB_TOKEN=z', 'SMTP_PASSWD=•••• CLIENT_SECRET=•••• GITHUB_TOKEN=••••'],
      ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY aws s3 ls', 'AWS_SECRET_ACCESS_KEY=•••• aws s3 ls'],
    ])
  })

  it('in arguments: --flag=value and --flag value', () => {
    expectAll([
      ['tool --password=hunter2 --api-key=abc123', 'tool --password=•••• --api-key=••••'],
      ['tool --password hunter2 --token abc --token-file x.txt', 'tool --password •••• --token •••• --token-file x.txt'],
      ['tool --password "my pass word" --token \'a b\'', 'tool --password "••••" --token \'••••\''],
      ['wget --user=ana --http-password=hunter2 https://x.example.com/f', 'wget --user=ana --http-password=•••• https://x.example.com/f'],
    ])
  })

  it('in URLs: the query value goes, the other parameters stay', () => {
    expectAll([
      ['https://api.example.com/v1/items?api_key=abc123def456&limit=5', 'https://api.example.com/v1/items?api_key=••••&limit=5'],
      ['https://x.example.com/cb?state=1&access_token=abc&code=2', 'https://x.example.com/cb?state=1&access_token=••••&code=2'],
      ['https://x.example.com/?password=hunter2', 'https://x.example.com/?password=••••'],
      ['https://x.example.com/?secret=abc', 'https://x.example.com/?secret=••••'],
    ])
  })

  it('in config and code literals, quoted as they were', () => {
    expectAll([
      ['password: hunter2', 'password: ••••'],
      ['DB_PASSWORD: "p@ss word"', 'DB_PASSWORD: "••••"'],
      ['{"api_key": "abc123", "region": "eu"}', '{"api_key": "••••", "region": "eu"}'],
      ["SECRET_KEY = 'django-insecure-abc123'", "SECRET_KEY = '••••'"],
      ['token := "abc123"', 'token := "••••"'],
      ['X-Api-Key: abc123 and x-auth-token: zzz9', 'X-Api-Key: •••• and x-auth-token: ••••'],
      ['Set **password**: hunter2 and `API_KEY`=abc123, __secret__: s3', 'Set **password**: •••• and `API_KEY`=••••, __secret__: ••••'],
    ])
  })
})

describe('passwords inside commands and URLs', () => {
  it('mysql -p<password>, but not the -p that asks for one', () => {
    expectAll([
      ['mysql -u root -psecret -h db.local shop -e "select 1"', 'mysql -u root -p•••• -h db.local shop -e "select 1"'],
      ["mysqldump -u app -p'hunter2' shop > shop.sql", "mysqldump -u app -p'••••' shop > shop.sql"],
      ['mysql -p"my pass" shop', 'mysql -p"••••" shop'],
      ['mysql -u root -p shop', 'mysql -u root -p shop'],
    ])
  })

  it('curl -u user:password, but not a user alone', () => {
    expectAll([
      ['curl -u admin:hunter2 https://api.example.com/v1/items', 'curl -u admin:•••• https://api.example.com/v1/items'],
      ['curl --user=admin:hunter2 https://x.io', 'curl --user=admin:•••• https://x.io'],
      ['curl -s -u "admin:hunter2" https://x.io', 'curl -s -u "admin:••••" https://x.io'],
      ['curl -u "admin:pass word" https://x.io', 'curl -u "admin:••••" https://x.io'],
      ['curl -u :tok123 https://x.io', 'curl -u :•••• https://x.io'],
      ['curl -u admin https://x.io', 'curl -u admin https://x.io'],
    ])
  })

  it('user:password@host in any URL', () => {
    expectAll([
      ['git clone https://ana:pa55word@git.example.com/shop.git', 'git clone https://ana:••••@git.example.com/shop.git'],
      ['postgres://app:s3cr3t@db:5432/shop', 'postgres://app:••••@db:5432/shop'],
      ['redis://:s3cr3t@cache:6379/0', 'redis://:••••@cache:6379/0'],
      ['https://ana@git.example.com/shop.git', 'https://ana@git.example.com/shop.git'],
    ])
  })

  it('docker login -p, sshpass -p, redis-cli -a', () => {
    expectAll([
      ['docker login -u bob -p hunter22 registry.example.com', 'docker login -u bob -p •••• registry.example.com'],
      ['docker login -u bob --password-stdin < pw.txt', 'docker login -u bob --password-stdin < pw.txt'],
      ['sshpass -p hunter2 ssh ana@host', 'sshpass -p •••• ssh ana@host'],
      ['redis-cli -h cache -a hunter2 ping', 'redis-cli -h cache -a •••• ping'],
      ['docker login -u bob -p "pass word" registry.example.com', 'docker login -u bob -p "••••" registry.example.com'],
    ])
  })
})

describe('private keys and long random runs', () => {
  it('a private key block keeps its BEGIN and END lines and its line count', () => {
    const body = ['MIIEow' + 'IBAAKCAQEAx1y2z3', 'abcDEF' + '123ghiJKL456', 'mnoPQR' + '789==']
    const pem = `cat > key.pem <<'EOF'\n-----BEGIN RSA PRIVATE KEY-----\n${body.join('\n')}\n-----END RSA PRIVATE KEY-----\nEOF`
    expectAll([[pem, `cat > key.pem <<'EOF'\n-----BEGIN RSA PRIVATE KEY-----\n${MASK}\n${MASK}\n${MASK}\n-----END RSA PRIVATE KEY-----\nEOF`]])
    // cut before its END: everything after BEGIN goes
    expectAll([[`-----BEGIN OPENSSH PRIVATE KEY-----\n${body[0]}`, `-----BEGIN OPENSSH PRIVATE KEY-----\n${MASK}`]])
  })

  it('32+ hex digits, and 32+ base64 characters that look random', () => {
    expectAll([
      ['hash 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', 'hash ••••'],
      ['key 0123456789abcdef0123456789abcdef end', 'key •••• end'],
      ['the key is 0123456789abcdef0123456789abcdef.', 'the key is ••••.'],
      ['https://hooks.example.com/incoming/0123456789abcdef0123456789abcdef', 'https://hooks.example.com/incoming/••••'],
      ['blob QWxhZGRpbjpvcGVuIHNlc2FtZQ9xYWxhZGRpbjpvcGVuIHNlc2FtZQ== end', 'blob •••• end'],
      ['https://hooks.example.com/T00/B00/Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe', 'https://hooks.example.com/T00/B00/••••'],
      ['/tmp/runs/Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe/out.log', '/tmp/runs/••••/out.log'],
      ['secret blob AbCd/EfGh1234+IjKlMnOpQrStUvWx5678YzAb/CdEf==', 'secret blob ••••'],
    ])
  })
})

describe('what hides nothing stays as it is', () => {
  it('references to where a secret lives, and values masked already', () => {
    for (const t of [
      'curl -s -H "Authorization: Bearer $API_TOKEN" https://api.example.com/v1/me',
      'TOKEN=$(gh auth token) ./deploy.sh',
      'export GITHUB_TOKEN=${GH_TOKEN}',
      'set PASSWORD=%DB_PASSWORD%',
      'mysql -u root -p$DB_PASS shop',
      'https://api.example.com/v1/items?api_key=…&limit=5',
      'password: ***',
      `HF_TOKEN=${MASK} python3 train.py`,
    ]) assert.equal(R(t), t, t)
  })

  it('code: types, calls, names and comparisons', () => {
    for (const t of [
      'def login(user: str, password: str, token: Optional[str] = None):',
      'password: string;',
      'api_key = os.environ["API_KEY"]',
      'token = get_token()',
      'is_secret: true',
      'password = None',
      'if token == "abc": pass',
      'Token::new(); let x: Token = y;',
      'max_tokens=1024 and the token count is fine',
      'tokenizer=bert num_tokens: 3 secrets: inherit',
    ]) assert.equal(R(t), t, t)
  })
})

describe('negatives: text that must stay unchanged', () => {
  it('normal words', () => {
    for (const t of [
      'The token count is fine and the password field is empty.',
      'Bearer tokens expire; bearer authentication works.',
      'Basic authentication is configured.',
      'A secret sauce, a pass mark and a key insight.',
      'Reading login.py to see how sign-in builds its redirect',
      'Running the tests — FAILED tests/test_auth.py::test_redirect - AssertionError',
      'HTTP 200 OK, 12 passed in 0.31s, exit 0',
    ]) assert.equal(R(t), t, t)
  })

  it('git SHAs of 7 to 12 characters', () => {
    for (const t of ['git checkout abc1234', 'git show 3f2a9c1e7b4d', 'commit 9fceb02 (HEAD -> main)', 'git rebase -i 4e8a9c3f1a2b~1', 'deadbee1']) assert.equal(R(t), t, t)
  })

  it('UUIDs', () => {
    for (const t of ['run id 3f2a9c1e-7b4d-4e8a-9c3f-1a2b3c4d5e6f', 'RUN 3F2A9C1E-7B4D-4E8A-9C3F-1A2B3C4D5E6F', 'session_id=3f2a9c1e-7b4d-4e8a-9c3f-1a2b3c4d5e6f']) assert.equal(R(t), t, t)
  })

  it('paths', () => {
    for (const t of [
      '/home/ana/shop/src/components/LoginForm2Handler3.tsx',
      '~/.claude/projects/-home-ana-shop/3f2a9c1e-7b4d-4e8a-9c3f-1a2b3c4d5e6f/subagents/agent-a1b2c3d4e5f6.jsonl',
      'C:\\Users\\Ana\\shop\\src\\app.py',
      'node_modules/@types/node/index.d.ts',
      'pytest tests/test_auth.py::test_redirect_after_login_when_session_expired -q',
      'PWD=/home/ana/shop OLDPWD=/home/ana',
      'npm_config_cache=/tmp/npm-cache hf_hub_download(repo_id="gpt2")',
      'cat /var/cache/blobs/0a1b2c3d4e5f60718293a4b5c6d7e8f9/model.bin',
      'ls .git/objects/pack/pack-0a1b2c3d4e5f60718293a4b5c6d7e8f901234567.idx',
      'Reading 0a1b2c3d4e5f60718293a4b5c6d7e8f9.json',
    ]) assert.equal(R(t), t, t)
  })
})

describe('totality', () => {
  it('non-strings and empty text give an empty string', () => {
    for (const v of [undefined, null, 3, {}, [], '']) assert.equal(R(v as unknown as string), '')
  })

  it('long and odd text stays fast', () => {
    const long = ('python3 - <<\'EOF\'\nimport os\nprint(os.environ["HOME"])\nEOF\n').repeat(300) + 'curl -u a '.repeat(800) + 'docker login '.repeat(800)
    const t0 = performance.now()
    for (let i = 0; i < 10; i++) R(long)
    const each = (performance.now() - t0) / 10
    assert.ok(each < 50, `${each.toFixed(1)} ms for ${long.length} characters`)
  })
})
