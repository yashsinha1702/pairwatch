// Specs for pairwatch/hooks/core/bash.ts: analyzeBash and bashResultNote.
// Every command here is synthetic or paraphrased from common shapes; none is copied from a transcript.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeBash, bashResultNote } from '../../pairwatch/hooks/core/bash.ts'
import type { BashAnalysis } from '../../pairwatch/hooks/core/bash.ts'
import { isConceptId } from '../../pairwatch/hooks/core/concept-ids.ts'

const CATEGORIES = new Set([
  'test', 'build', 'install', 'git', 'run-script', 'read-file', 'list-files', 'search', 'write-file', 'file-ops', 'process',
  'network', 'http', 'gpu', 'media', 'docker', 'database', 'env', 'wait', 'claude', 'other',
])
const STATIONS = new Set(['think', 'plan', 'search', 'read', 'edit', 'run', 'web', 'delegate', 'tools', 'ask', 'talk', 'done', 'idle'])

/** The contract every analysis keeps, whatever the input. */
function valid(a: BashAnalysis): BashAnalysis {
  assert.equal(typeof a, 'object')
  assert.ok(STATIONS.has(a.station), `station ${a.station}`)
  assert.ok(CATEGORIES.has(a.category), `category ${a.category}`)
  assert.equal(typeof a.headline, 'string')
  assert.ok(a.headline.length > 0 && a.headline.length <= 90, `headline length ${a.headline.length}: ${a.headline}`)
  assert.ok(!/[\n\r]/.test(a.headline), 'headline is one line')
  assert.ok(a.why.length > 0 && a.why.length <= 170, `why length ${a.why.length}`)
  assert.ok(Array.isArray(a.concepts) && a.concepts.length <= 8)
  assert.equal(new Set(a.concepts).size, a.concepts.length, 'concepts are unique')
  for (const c of a.concepts) assert.ok(isConceptId(c), `unknown concept ${c}`)
  assert.ok(Array.isArray(a.programs) && a.programs.every(p => typeof p === 'string'))
  assert.equal(new Set(a.programs).size, a.programs.length, 'programs are unique')
  assert.ok(Array.isArray(a.readsFiles) && Array.isArray(a.writesFiles))
  assert.equal(typeof a.isBackground, 'boolean')
  assert.equal(typeof a.isMultiline, 'boolean')
  assert.ok(Number.isInteger(a.segments) && a.segments >= 0)
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a, 'plain JSON')
  return a
}

const A = (command: string, description?: string): BashAnalysis => valid(analyzeBash(command, description))
const has = (a: BashAnalysis, ...ids: string[]): void => {
  for (const id of ids) assert.ok(a.concepts.includes(id), `expected concept ${id} in [${a.concepts.join(', ')}]`)
}

// ------------------------------------------------------------------ categories and headlines

describe('run-script', () => {
  test('a python script with a pager tail stays a script run', () => {
    const a = A('python3 tools/sales/report.py --region eu --since 7d --query "SELECT count(*) FROM orders" 2>&1 | tail -40')
    assert.equal(a.category, 'run-script')
    assert.equal(a.station, 'run')
    assert.equal(a.primary, 'python3 report.py')
    assert.equal(a.headline, 'Running report.py (Python)')
    assert.equal(a.target, 'tools/sales/report.py')
    assert.deepEqual(a.programs, ['python3', 'tail'])
    assert.equal(a.concepts[0], 'python-script')
    has(a, 'pipe', 'stderr-redirect')
  })
  test('python3 - <<EOF is inline Python, and names the file it reads', () => {
    const a = A("python3 - <<'EOF'\nimport json\nd = json.load(open('out/report.json'))\nprint(sorted(d))\nEOF")
    assert.equal(a.category, 'run-script')
    assert.equal(a.headline, 'Running inline Python on out/report.json')
    assert.deepEqual(a.readsFiles, ['out/report.json'])
    has(a, 'python-inline', 'heredoc', 'json')
  })
  test('python3 -c is inline Python', () => {
    const a = A('python3 -c "import json,sys; print(len(json.load(open(\'data/x.json\'))))"')
    assert.equal(a.category, 'run-script')
    has(a, 'python-inline')
  })
  test('inline Python that rewrites a file is an edit of that file', () => {
    const a = A("python3 - <<'EOF'\nfrom pathlib import Path\np = Path('src/app.py')\ns = p.read_text().replace('old', 'new')\np.write_text(s)\nEOF")
    assert.equal(a.headline, 'Editing src/app.py with inline Python')
    assert.deepEqual(a.writesFiles, ['src/app.py'])
  })
  test('node, bash and ./run.sh scripts', () => {
    assert.equal(A('node scripts/build.js --watch').headline, 'Running build.js (Node.js)')
    const b = A('bash scripts/deploy.sh staging')
    assert.equal(b.category, 'run-script')
    assert.equal(b.headline, 'Running deploy.sh staging')
    const c = A('cd ~/app && ./run.sh start-worker')
    assert.equal(c.category, 'run-script')
    assert.equal(c.headline, 'Running run.sh start-worker')
  })
  test('a venv interpreter path is looked through', () => {
    const a = A('/opt/conda/envs/tts/bin/python -I scripts/infer.py --batch 4')
    assert.equal(a.primary, 'python infer.py')
    assert.equal(a.headline, 'Running infer.py (Python)')
    has(a, 'python-script', 'conda', 'inference')
  })
  test('a program held in a variable resolves through the assignment', () => {
    const a = A('PY=/srv/app/.venv/bin/python; $PY tools/check.py')
    assert.equal(a.category, 'run-script')
    assert.equal(a.headline, 'Running check.py (Python)')
    has(a, 'python-venv', 'env-var')
  })
  test('writing a script and running it reads as one step', () => {
    const a = A("cat > /tmp/w/probe.py <<'EOF'\nprint('hello')\nEOF\npython3 /tmp/w/probe.py")
    assert.equal(a.category, 'run-script')
    assert.equal(a.headline, 'Writing and running probe.py (Python)')
    assert.deepEqual(a.writesFiles, ['/tmp/w/probe.py'])
  })
  test('nohup … & is a background start', () => {
    const a = A('nohup python3 serve.py --port 8000 > serve.log 2>&1 &')
    assert.equal(a.isBackground, true)
    assert.equal(a.headline, 'Starting serve.py in the background (Python)')
    assert.deepEqual(a.writesFiles, ['serve.log'])
    has(a, 'background-job', 'nohup', 'redirect', 'stderr-redirect')
  })
  test('VAR=value prefixes and CUDA hints', () => {
    const a = A('CUDA_VISIBLE_DEVICES=0 python3 train.py --epochs 3')
    assert.equal(a.primary, 'python3 train.py')
    has(a, 'cuda', 'env-var', 'training-loop')
  })
})

describe('read-file', () => {
  test('sed -n range', () => {
    const a = A("sed -n '1200,1350p' docs/release/CHANGES.md")
    assert.equal(a.category, 'read-file')
    assert.equal(a.station, 'read')
    assert.equal(a.headline, 'Reading lines 1200–1350 of CHANGES.md')
    assert.deepEqual(a.readsFiles, ['docs/release/CHANGES.md'])
    assert.equal(a.concepts[0], 'sed-print')
  })
  test('awk NR range through a variable', () => {
    const a = A("T=/opt/x/types/api.d.ts; awk 'NR>=10 && NR<=40 {printf \"%d: %s\\n\", NR, $0}' $T")
    assert.equal(a.headline, 'Reading lines 10–40 of api.d.ts')
    assert.deepEqual(a.readsFiles, ['/opt/x/types/api.d.ts'])
    has(a, 'awk', 'reading-code')
  })
  test('two ranges of one file are merged', () => {
    const a = A('cd ~/proj && sed -n 520,600p scripts/eval.py && sed -n 866,910p scripts/eval.py')
    assert.equal(a.headline, 'Reading lines 520–600 and 866–910 of scripts/eval.py')
  })
  test('head, tail and cat | tail', () => {
    assert.equal(A('head -n 50 README.md').headline, 'Reading the first 50 lines of README.md')
    assert.equal(A('tail -20 logs/train.log').headline, 'Reading the last 20 lines of logs/train.log')
    assert.equal(A('cat logs/worker.log | tail -30').headline, 'Reading the last 30 lines of logs/worker.log')
    has(A('tail -20 logs/train.log'), 'head-tail', 'reading-logs')
  })
  test('several files', () => {
    const a = A('cat a.md; echo ---; cat b.md; echo ---; head -5 c.md')
    assert.equal(a.category, 'read-file')
    assert.equal(a.headline, 'Reading a.md, b.md and c.md')
    assert.deepEqual(a.readsFiles, ['a.md', 'b.md', 'c.md'])
  })
  test('wc -l and jq on files', () => {
    assert.equal(A('wc -l data/train.jsonl').headline, 'Counting lines in data/train.jsonl')
    has(A('wc -l data/train.jsonl'), 'wc', 'jsonl')
    const j = A("jq '.permissions' settings.json")
    assert.equal(j.category, 'read-file')
    has(j, 'jq', 'json')
  })
  test('a for loop over literal files names them all', () => {
    const a = A('for f in a.txt b.txt c.txt; do wc -l $f; done')
    assert.equal(a.category, 'read-file')
    assert.equal(a.headline, 'Counting lines in a.txt, b.txt and c.txt')
    has(a, 'shell-loop')
  })
})

describe('search and list-files', () => {
  test('grep -rn in a folder', () => {
    const a = A('grep -rn "redirect" src/ | head -20')
    assert.equal(a.category, 'search')
    assert.equal(a.station, 'search')
    assert.equal(a.headline, 'Searching for “redirect” in src/')
    assert.equal(a.searchQuery, 'redirect')
    assert.equal(a.searchWhere, 'src/')
    assert.equal(a.concepts[0], 'grep')
    has(a, 'pipe', 'head-tail')
  })
  test('rg is ripgrep and searches the current folder by default', () => {
    const a = A('rg -n useState')
    assert.equal(a.searchWhere, '.')
    assert.equal(a.headline, 'Searching for “useState” in the current folder')
    has(a, 'ripgrep')
  })
  test('alternations and regex', () => {
    const a = A('grep -n "argparse\\|add_argument\\|batch_size" tools/infer.py')
    assert.equal(a.headline, 'Searching for “argparse”, “add_argument” and 1 more in tools/infer.py')
    has(a, 'grep', 'regex')
    assert.ok(!A('grep -n "plain" notes.txt').concepts.includes('regex'))
  })
  test('familiar patterns read as what they find', () => {
    assert.equal(A("grep -n '^## ' docs/GUIDE.md").headline, 'Listing the headings in docs/GUIDE.md')
    assert.equal(A('grep -nE "^def |^class " lib/tool.py').headline, 'Listing the definitions in lib/tool.py')
    assert.equal(A('grep -iE "error|traceback" logs/run.log').headline, 'Looking for errors in logs/run.log')
  })
  test('cat file | grep is a search in that file', () => {
    const a = A('cat app/config.yaml | grep -n timeout')
    assert.equal(a.category, 'search')
    assert.equal(a.searchWhere, 'app/config.yaml')
    assert.equal(a.headline, 'Searching for “timeout” in app/config.yaml')
  })
  test('find -name, with -not -path as an exclusion', () => {
    const a = A('find . -name "*.py" -not -path "./.venv/*"')
    assert.equal(a.category, 'search')
    assert.equal(a.searchQuery, '*.py')
    assert.equal(a.headline, 'Searching for files named “*.py” in the current folder')
    has(a, 'find', 'globbing')
  })
  test('find | xargs grep searches the files found', () => {
    const a = A("find src -name '*.ts' | xargs grep -l useState")
    assert.equal(a.category, 'search')
    assert.equal(a.searchQuery, 'useState')
    assert.equal(a.headline, 'Finding the *.ts files in src/ that mention “useState”')
    has(a, 'xargs')
  })
  test('find without a name filter lists', () => {
    const a = A('find ~/proj/assets -maxdepth 3 -type d | head -40')
    assert.equal(a.category, 'list-files')
    assert.equal(a.headline, 'Listing folders under assets/')
  })
  test('ls, tree and du', () => {
    const a = A('ls -la logs/')
    assert.equal(a.category, 'list-files')
    assert.equal(a.station, 'search')
    assert.equal(a.headline, 'Listing files in logs/')
    assert.equal(A('ls').headline, 'Listing files in the current folder')
    assert.equal(A('tree -L 2 src').category, 'list-files')
    const d = A('du -sh models/')
    assert.equal(d.category, 'list-files')
    has(d, 'disk-usage')
  })
  test('ls | grep looks for a name', () => {
    assert.equal(A('ls scripts/ | grep -E "^2[6-9]" | sort | tail -5').headline, 'Looking for “2[6-9]” in scripts/')
    assert.equal(A('ls models | grep lora').headline, 'Looking for “lora” in models/')
  })
})

describe('write-file and file-ops', () => {
  test('cat > path <<EOF writes path', () => {
    const a = A("cat > src/time.ts <<'EOF'\nexport const now = () => Date.now()\nEOF")
    assert.equal(a.category, 'write-file')
    assert.equal(a.station, 'edit')
    assert.equal(a.headline, 'Writing src/time.ts')
    assert.deepEqual(a.writesFiles, ['src/time.ts'])
    assert.deepEqual(a.concepts.slice(0, 2), ['heredoc', 'redirect'])
  })
  test('the body of a quoted heredoc is data, not commands', () => {
    const a = A("cat > s.sh <<'EOF'\nrm -rf /tmp/x\ncurl https://example.com\nEOF")
    assert.ok(!a.programs.includes('rm') && !a.programs.includes('curl'))
    assert.equal(a.category, 'write-file')
  })
  test('cat <<EOF > path and >> append', () => {
    assert.equal(A('cat <<EOF > out/notes.txt\nhello\nEOF').headline, 'Writing out/notes.txt')
    assert.equal(A('cat >> notes.md <<EOF\n- one more\nEOF').headline, 'Appending to notes.md')
  })
  test('echo > file, tee and sed -i', () => {
    assert.equal(A('echo "ok" > status.txt').category, 'write-file')
    const t = A('echo "x=1" | sudo tee /etc/app.conf')
    assert.equal(t.category, 'write-file')
    assert.deepEqual(t.writesFiles, ['/etc/app.conf'])
    has(t, 'tee', 'sudo')
    const s = A("sed -i 's/foo/bar/g' config.yaml")
    assert.equal(s.category, 'write-file')
    assert.equal(s.headline, 'Editing config.yaml in place with sed')
    has(s, 'sed-substitute', 'yaml')
  })
  test('a write beats the read it redirects; /dev/null is not a write', () => {
    assert.equal(A('grep -n TODO src/app.py > todo.txt').category, 'write-file')
    assert.equal(A('grep -q foo bar.txt > /dev/null 2>&1').category, 'search')
  })
  test('{ …; } > file and : > file', () => {
    assert.equal(A('{ echo a; echo b; } > out.txt').headline, 'Writing out.txt')
    assert.equal(A(': > app.log').headline, 'Emptying app.log')
  })
  test('a compile check after writing code is a verification step', () => {
    const body = Array.from({ length: 6 }, (_, i) => `x${i} = ${i}`).join('\n')
    const a = A(`cat > tools/gen.py <<'EOF'\n${body}\nEOF\npython3 -m py_compile tools/gen.py && echo ok`)
    assert.equal(a.category, 'write-file')
    assert.equal(a.headline, 'Writing tools/gen.py, then checking it compiles')
  })
  test('cp, mv, rm, mkdir, chmod, ln', () => {
    const c = A('cp config.yaml config.yaml.bak')
    assert.equal(c.category, 'file-ops')
    assert.equal(c.station, 'edit')
    assert.equal(c.headline, 'Backing up config.yaml')
    has(c, 'backups', 'cp-mv-rm')
    assert.equal(A('mv draft.md final.md').headline, 'Renaming draft.md to final.md')
    assert.equal(A('rm -rf build/').headline, 'Deleting the folder build/')
    assert.equal(A('mkdir -p out/plots').headline, 'Creating the folder out/plots/')
    assert.equal(A('chmod +x run.sh').headline, 'Making run.sh executable')
    has(A('ln -s ~/data/models models'), 'symlinks')
  })
  test('mkdir -p is setup when something real follows', () => {
    const a = A('mkdir -p out && python3 gen.py --out out')
    assert.equal(a.category, 'run-script')
  })
  test('tar: list, extract, read', () => {
    const l = A('tar -tzf backup.tgz | head -40')
    assert.equal(l.category, 'list-files')
    assert.equal(l.headline, 'Listing what is inside backup.tgz')
    const x = A('tar -xzf data.tgz -C out/')
    assert.equal(x.category, 'file-ops')
    assert.equal(x.headline, 'Unpacking data.tgz into out/')
    assert.equal(A('tar -xzOf mem.tgz memory/notes.md | head -50').category, 'read-file')
  })
  test('find -delete', () => {
    const a = A("find . -name '*.pyc' -delete")
    assert.equal(a.category, 'file-ops')
    assert.equal(a.headline, 'Deleting files named “*.pyc” in the current folder')
  })
})

describe('tests, builds, installs, git', () => {
  test('npm test behind cd and a pager', () => {
    const a = A('cd web && npm test 2>&1 | tail -5')
    assert.equal(a.category, 'test')
    assert.equal(a.primary, 'npm test')
    assert.equal(a.headline, 'Running the test suite (npm test)')
    has(a, 'npm-scripts', 'tests', 'and-chain')
  })
  test('pytest variants', () => {
    const a = A('.venv/bin/python -m pytest -q tests/test_api.py')
    assert.equal(a.category, 'test')
    assert.equal(a.headline, 'Running the tests in tests/test_api.py (python -m pytest)')
    has(a, 'pytest', 'python-venv')
    assert.equal(A('pytest -k "login and not slow"').headline, 'Running tests matching “login and not slow” (pytest)')
    assert.equal(A('uv run pytest -q').category, 'test')
    has(A('uv run pytest -q'), 'uv')
  })
  test('go test, jest, node --test, ./run.sh test, make test', () => {
    for (const c of ['go test ./...', 'npx jest --runInBand', 'node --test dist/test/unit.test.js', './run.sh test', 'make test']) {
      assert.equal(A(c).category, 'test', c)
    }
  })
  test('writing a test then running the suite', () => {
    const a = A("cat >> tests/test_cart.py <<'EOF'\n\ndef test_x():\n    assert 1\nEOF\n.venv/bin/python -m pytest -q 2>&1 | tail -3")
    assert.equal(a.category, 'test')
    assert.equal(a.headline, 'Appending to tests/test_cart.py, then running the test suite (python -m pytest)')
  })
  test('builds', () => {
    const t = A('npx tsc --noEmit')
    assert.equal(t.category, 'build')
    assert.equal(t.headline, 'Type-checking the TypeScript code (tsc)')
    has(t, 'typescript', 'npx')
    assert.equal(A('npm run build').category, 'build')
    assert.equal(A('cargo build --release').category, 'build')
    assert.equal(A('make').headline, 'Building with make')
    const d = A('docker build -t app:latest .')
    assert.equal(d.category, 'build')
    assert.equal(d.headline, 'Building the Docker image app:latest')
    has(d, 'docker-images', 'dockerfile')
  })
  test('installs and environments', () => {
    const p = A('pip install torch numpy')
    assert.equal(p.category, 'install')
    assert.equal(p.headline, 'Installing torch and numpy with pip')
    has(p, 'pip')
    assert.equal(A('pip install -r requirements.txt').headline, 'Installing packages from requirements.txt')
    assert.equal(A('pip install').headline, 'Installing packages with pip')
    const v = A('python3 -m venv .venv')
    assert.equal(v.category, 'install')
    has(v, 'python-venv')
    has(A('uv venv --python 3.12'), 'uv', 'python-venv')
    has(A('npm ci'), 'npm-install')
    has(A('conda create -n tts python=3.11 -y'), 'conda')
    has(A('huggingface-cli download org/model-7b --local-dir models/m7'), 'huggingface')
    has(A('sudo dnf install -y ffmpeg'), 'package-managers', 'sudo')
  })
  test('git', () => {
    const s = A('git status')
    assert.equal(s.category, 'git')
    assert.equal(s.headline, 'Checking git status')
    assert.equal(s.primary, 'git status')
    has(s, 'git-status')
    has(A('git diff --stat'), 'git-diff')
    has(A('git log --oneline -5'), 'git-log')
    const c = A('git add -A && git commit -m "Fix flaky checkout test" && git push')
    assert.equal(c.primary, 'git commit')
    assert.equal(c.headline, 'Committing and pushing changes: “Fix flaky checkout test”')
    has(c, 'git-commit', 'git-remote')
    const h = A("git commit -m \"$(cat <<'EOF'\nAdd the settings pane\n\nIt's the first cut.\nEOF\n)\"")
    assert.equal(h.headline, 'Committing changes: “Add the settings pane”')
    has(A('gh pr view 12'), 'gh-cli')
    assert.equal(A('gh pr view 12').category, 'git')
  })
})

describe('systems: gpu, media, docker, database, http, network, process, env, wait, claude', () => {
  test('nvidia-smi', () => {
    const a = A('nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu --format=csv')
    assert.equal(a.category, 'gpu')
    assert.equal(a.headline, 'Checking GPU memory and usage')
    assert.deepEqual(a.concepts.slice(0, 2), ['nvidia-smi', 'gpu-memory'])
    assert.equal(A('nvidia-smi --query-compute-apps=pid,used_memory --format=csv').headline, 'Checking which processes use the GPU')
  })
  test('ffmpeg, ffprobe, sox', () => {
    const f = A('ffmpeg -y -i talk.m4a -ar 16000 -ac 1 talk.wav')
    assert.equal(f.category, 'media')
    assert.equal(f.headline, 'Converting talk.m4a to WAV with ffmpeg')
    assert.deepEqual(f.writesFiles, ['talk.wav'])
    has(f, 'ffmpeg', 'audio-basics')
    assert.equal(A('ffprobe -v error -show_entries format=duration clip.wav').category, 'media')
    assert.equal(A('sox in.wav out.wav rate 16k').category, 'media')
  })
  test('docker', () => {
    const l = A('docker logs --tail 50 shop-api')
    assert.equal(l.category, 'docker')
    assert.equal(l.headline, 'Reading the logs of container shop-api')
    assert.equal(l.primary, 'docker logs')
    has(l, 'docker-containers')
    has(A('docker compose up -d'), 'docker-compose')
    assert.equal(A('docker ps -a').headline, 'Listing all containers')
    assert.equal(A('docker exec -it api node -e "1"').headline, 'Running node in container api')
  })
  test('databases', () => {
    const q = A('sqlite3 shop.db "select count(*) from orders"')
    assert.equal(q.category, 'database')
    assert.equal(q.headline, 'Querying the SQLite database shop.db')
    has(q, 'sqlite', 'sql-queries')
    const u = A("sqlite3 data/app.db <<'SQL'\nUPDATE jobs SET state = 'done' WHERE id = 3;\nSQL")
    assert.equal(u.headline, 'Updating the SQLite database app.db')
    has(u, 'sqlite', 'sql-queries', 'heredoc')
    assert.equal(A("sqlite3 data/app.db \".backup 'data/app.bak'\"").headline, 'Backing up the SQLite database app.db')
    assert.equal(A('psql -d shop -c "select 1"').category, 'database')
  })
  test('http: local is run, remote is web', () => {
    const l = A('curl -s localhost:8000/health')
    assert.equal(l.category, 'http')
    assert.equal(l.station, 'run')
    assert.equal(l.headline, 'Calling localhost:8000/health')
    has(l, 'curl', 'http-requests', 'localhost')
    const r = A('curl -sI https://example.com/docs')
    assert.equal(r.station, 'web')
    has(r, 'http-status-codes')
    assert.equal(A('curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8001/v1/models').headline, 'Checking the HTTP status of 127.0.0.1:8001/v1/models')
    const p = A('curl -s -X POST localhost:8000/v1/chat -H "Content-Type: application/json" -d \'{"q":1}\'')
    assert.equal(p.headline, 'Sending a POST request to localhost:8000/v1/chat')
    has(p, 'json')
  })
  test('http secrets never reach the words', () => {
    const a = A(`curl -s -H "Authorization: Bearer ${'sk-' + 'live-abcdef123456'}" "https://api.example.com/v1/items?api_key=s3cr3tvalue&page=2"`)
    has(a, 'api-tokens')
    const words = JSON.stringify([a.headline, a.target, a.why])
    assert.ok(!/abcdef123456|s3cr3tvalue/.test(words), words)
    assert.ok((a.target ?? '').includes('api_key=…'))
    const u = A('curl -s https://user:hunter22@example.com/private')
    assert.ok(!/hunter22/.test(JSON.stringify(u)))
  })
  test('wget download', () => {
    const a = A('wget -O model.bin https://example.com/files/model.bin')
    assert.equal(a.headline, 'Downloading model.bin from example.com')
    assert.deepEqual(a.writesFiles, ['model.bin'])
  })
  test('network', () => {
    assert.equal(A("ssh deploy@build-01 'uptime'").headline, 'Running a command on build-01 over SSH')
    has(A('rsync -avz out/ deploy@host:/srv/out/'), 'rsync-scp')
    const p = A('lsof -i :8000')
    assert.equal(p.category, 'network')
    assert.equal(p.headline, 'Checking what is listening on port 8000')
    assert.equal(A('ss -tlnp').category, 'network')
    assert.equal(A('ping -c 3 example.com').headline, 'Pinging example.com')
  })
  test('processes', () => {
    const p = A('ps aux | grep python | grep -v grep')
    assert.equal(p.category, 'process')
    assert.equal(p.headline, 'Looking for running processes matching “python”')
    assert.equal(A('kill -9 12345').headline, 'Force-stopping process 12345')
    assert.equal(A('kill -0 $(cat run/app.pid)').headline, 'Checking whether the process in app.pid is still running')
    has(A('pkill -f "serve.py"'), 'kill-signals')
    const t = A("tmux new -d -s train 'python3 train.py'")
    assert.equal(t.category, 'process')
    assert.equal(t.isBackground, true)
    has(t, 'tmux-screen')
    const s = A('sudo systemctl restart nginx')
    assert.equal(s.headline, 'Restarting the service nginx')
    has(s, 'systemd', 'sudo')
  })
  test('env checks', () => {
    assert.equal(A('which python3 node').headline, 'Checking whether python3 and node are installed')
    const e = A('echo "CVD=[${CUDA_VISIBLE_DEVICES-unset}]"')
    assert.equal(e.category, 'env')
    has(e, 'env-var', 'cuda')
    assert.equal(A('df -h /; nproc; free -g').headline, 'Checking disk space, CPU cores and memory')
    assert.equal(A('python3 -c "import torch; print(torch.__version__)"').headline, 'Checking the installed version of torch (Python)')
    const c = A('python3 -c "import torch; print(torch.cuda.is_available())"')
    assert.equal(c.headline, 'Checking whether PyTorch can see the GPU (CUDA)')
    has(c, 'cuda')
    assert.equal(A('node --version').category, 'env')
  })
  test('waits and polling loops', () => {
    const a = A('until grep -q "done" logs/eval.log; do sleep 5; done; tail -3 logs/eval.log')
    assert.equal(a.category, 'wait')
    assert.equal(a.headline, 'Waiting for the eval log to say “done”')
    has(a, 'polling-loop')
    const p = A('until ! pgrep -f "[b]atch.sh" >/dev/null; do sleep 30; done; echo DONE')
    assert.equal(p.headline, 'Waiting for “[b]atch.sh” to finish')
    const k = A('for i in $(seq 58); do kill -0 "$(cat /tmp/run/job.pid)" 2>/dev/null || break; sleep 2; done')
    assert.equal(k.headline, 'Waiting for the process in job.pid to finish')
    const f = A('until [ -s /tmp/out/result.json ]; do sleep 5; done; cat /tmp/out/result.json')
    assert.equal(f.headline, 'Waiting for result.json to appear')
    const s = A('sleep 30 && tail -5 logs/train.log')
    assert.equal(s.category, 'wait')
    assert.equal(s.headline, 'Waiting 30 seconds, then reading the last 5 lines of logs/train.log')
  })
  test('bash -c and timeout around a wait', () => {
    const a = A("timeout 60 bash -c 'until curl -sf localhost:8080/ready; do sleep 2; done'")
    assert.equal(a.category, 'wait')
    assert.equal(a.headline, 'Waiting for localhost:8080/ready to respond')
    has(a, 'polling-loop', 'timeout-cmd')
  })
  test('the claude CLI', () => {
    const p = A('claude -p "Say hi" --output-format json')
    assert.equal(p.category, 'claude')
    assert.equal(p.headline, 'Asking Claude a one-off question (claude -p)')
    has(A('claude plugin validate ./pairwatch'), 'hooks-mods')
    assert.equal(A('claude --version').headline, "Checking Claude Code's version")
  })
})

// ------------------------------------------------------------------ parsing

describe('parsing', () => {
  test('quotes keep operators literal', () => {
    const a = A("grep -n 'a | b ; c && d' file.txt")
    assert.equal(a.segments, 1)
    assert.equal(a.searchQuery, 'a | b ; c && d')
    assert.ok(!a.concepts.includes('pipe'))
  })
  test('double quotes with escapes and $\'…\'', () => {
    assert.equal(A('echo "a \\"b\\" ; c"').segments, 1)
    assert.equal(A("printf $'a\\tb\\n' | wc -l").segments, 2)
  })
  test('# starts a comment only at a word start', () => {
    const a = A('ls logs # rm -rf / ; reboot')
    assert.equal(a.segments, 1)
    assert.deepEqual(a.programs, ['ls'])
    assert.equal(A('echo a#b; ls').segments, 2)
  })
  test('line continuations join one command', () => {
    const a = A('python3 train.py \\\n  --epochs 3 \\\n  --lr 1e-4')
    assert.equal(a.segments, 1)
    assert.equal(a.isMultiline, true)
    assert.equal(a.headline, 'Running train.py (Python)')
  })
  test('all separators split commands', () => {
    const a = A('make a; make b && make c || make d | cat & make f\nmake g')
    assert.equal(a.segments, 7)
    has(a, 'and-chain', 'or-fallback', 'pipe', 'background-job')
  })
  test('redirections: > f, >> f, < f, 2>&1, 2>/dev/null, &> f, N> f', () => {
    const a = A('python3 job.py < in.txt > out.log 2>&1')
    assert.deepEqual(a.writesFiles, ['out.log'])
    has(a, 'redirect', 'stderr-redirect')
    assert.deepEqual(A('python3 job.py &> all.log').writesFiles, ['all.log'])
    assert.deepEqual(A('python3 job.py 2> err.log').writesFiles, [])
    assert.deepEqual(A('ls missing 2>/dev/null').writesFiles, [])
  })
  test('heredocs: <<-, two on one line, unterminated', () => {
    assert.equal(A('cat <<-EOF > tabbed.txt\n\thello\n\tEOF').headline, 'Writing tabbed.txt')
    const two = A('cat <<A > a.txt; cat <<B > b.txt\none\nA\ntwo\nB')
    assert.deepEqual(two.writesFiles, ['a.txt', 'b.txt'])
    assert.equal(two.headline, 'Writing a.txt and b.txt')
    assert.deepEqual(A("cat > half.py <<'EOF'\nprint(1)").writesFiles, ['half.py'])
  })
  test('$( ) and backticks: scanned for programs, never the primary', () => {
    const a = A('echo "$(nvidia-smi --query-gpu=memory.used --format=csv)"')
    assert.ok(a.programs.includes('nvidia-smi'))
    assert.equal(a.primary, undefined)
    const b = A('kill `cat app.pid`')
    assert.equal(b.primary, 'kill')
    assert.ok(b.programs.includes('cat'))
    has(b, 'command-substitution')
  })
  test('groups and subshells', () => {
    assert.equal(A('(cd web && npm test)').category, 'test')
    assert.equal(A('{ make build; } 2>&1 | tail -3').category, 'build')
  })
  test('if, case and loops', () => {
    assert.equal(A('if [ -f out.json ]; then cat out.json; else echo missing; fi').headline, 'Reading out.json')
    const c = A('case "$1" in start) ./run.sh start ;; stop) ./run.sh stop ;; esac')
    assert.equal(c.category, 'run-script')
    assert.ok(!c.programs.some(p => p.endsWith(')')))
    const w = A('while read -r f; do wc -l "$f"; done < files.txt')
    has(w, 'shell-loop')
  })
  test('[[ … && … ]] keeps its && inside; the && after ]] still chains', () => {
    const a = A('[[ -f x.py && -s x.py ]] && python3 x.py')
    assert.equal(a.headline, 'Running x.py (Python)')
    has(a, 'and-chain')
  })
  test('process substitution and here-strings', () => {
    assert.equal(A('diff <(sort a.txt) <(sort b.txt)').headline, 'Comparing two outputs')
    assert.equal(A('diff old.json new.json').headline, 'Comparing old.json with new.json')
    assert.equal(A('python3 - <<< "print(1)"').category, 'run-script')
  })
  test('shell functions: the body is what runs', () => {
    const a = A('run() { .venv/bin/python -m shop.cli --config dev.toml "$@"; }; run sync-once; run report')
    assert.equal(a.category, 'run-script')
    assert.equal(a.primary, 'python -m shop.cli')
  })
  test('sh -c strings are analysed', () => {
    const a = A('sh -c "grep -rn TODO src"')
    assert.equal(a.category, 'search')
    assert.equal(a.searchQuery, 'TODO')
  })
  test('wrappers are looked through', () => {
    const a = A('sudo env X=1 nice -n 10 stdbuf -oL time python3 job.py')
    assert.equal(a.primary, 'python3 job.py')
    assert.ok(a.programs.includes('sudo'))
    assert.equal(A('timeout 30 node scripts/smoke.js').primary, 'node smoke.js')
    assert.equal(A('watch -n 5 nvidia-smi').category, 'gpu')
    assert.equal(A('conda run -n tts python infer.py').headline, 'Running infer.py (Python)')
    assert.equal(A('export PATH=$HOME/.local/bin:$PATH; claude --version').category, 'claude')
  })
  test('xargs runs a real command', () => {
    const a = A('ls *.log | xargs wc -l')
    assert.ok(a.programs.includes('xargs') && a.programs.includes('wc'))
    has(a, 'xargs')
  })
  test('setup segments are skipped', () => {
    const a = A('set -euo pipefail; cd /srv/app; export MODE=prod; source .env; true; : ; python3 manage.py migrate')
    assert.equal(a.primary, 'python3 manage.py')
    assert.deepEqual(a.programs, ['python3'])
    has(a, 'strict-mode', 'source-env', 'secrets-hygiene')
  })
  test('echo labels are not the intent', () => {
    const a = A('echo "=== logs ==="; tail -5 logs/app.log; echo "---"')
    assert.equal(a.category, 'read-file')
    assert.ok(!a.programs.includes('echo'))
  })
  test('a last-resort headline when nothing is recognisable', () => {
    assert.equal(A('x=1; y=2; z=3; echo $((x+y+z))').headline, 'Running a 4-step shell script')
  })
  test('the headline comes from the command, not the description', () => {
    assert.equal(A('ls', 'List the files').headline, 'Listing files in the current folder')
  })
  test('the description settles a tie between plain inspection steps only', () => {
    const cmd = 'ls -la data/raw/; echo ---; cat data/events.jsonl'
    assert.equal(A(cmd).category, 'read-file')
    assert.equal(A(cmd, 'List the raw files and the events').category, 'list-files')
    assert.equal(A(cmd, 'Read the events').category, 'read-file')
    assert.equal(A('pytest -q; cat out.txt', 'Read the output').category, 'test')
    assert.equal(A('grep -rn foo src', 'List matches').category, 'search')
  })
})

describe('totality', () => {
  test('empty and blank commands', () => {
    const a = A('')
    assert.equal(a.segments, 0)
    assert.equal(a.category, 'other')
    A('   \n\t  ')
  })
  test('garbage never throws', () => {
    for (const g of ["))) ((( ''' \"\"\" $( ` <<", 'echo "unterminated', "'", '\\', '|||', '&&&& ;;;; ((', '<<', '$((', '${', 'for do done', 'if then fi esac', '{ } ( )', '`', '\u0000\u0001�', 'cat <<'])
      A(g)
  })
  test('program names that collide with Object.prototype are just unknown programs', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      const a = A(`${name} --x | sort`)
      assert.equal(a.category, 'other', name)
      assert.ok(!/function|native code/.test(a.headline), a.headline)
    }
    assert.ok(!/native code/.test(A('systemctl constructor app').headline))
    assert.ok(!/native code/.test(A('docker toString box').headline))
  })
  test('non-string input never throws', () => {
    for (const x of [undefined, null, 42, {}, [], true]) valid(analyzeBash(x as unknown as string, x as unknown as string))
  })
  test('deep nesting does not overflow the stack', () => {
    A('$('.repeat(5000))
    A('"$('.repeat(3000))
    A('echo ' + '$(echo '.repeat(400) + 'x' + ')'.repeat(400))
    A('('.repeat(4000) + 'ls' + ')'.repeat(4000))
  })
  test('a 30 KB command stays fast and valid', () => {
    const big = Array.from({ length: 520 }, (_, i) => `grep -n "pattern${i}" src/module${i}.py | head -5; echo "--- ${i} ---"`).join('\n')
    assert.ok(big.length > 30_000)
    analyzeBash(big)
    const t0 = performance.now()
    const a = A(big)
    assert.ok(performance.now() - t0 < 100, 'well under 100 ms')
    assert.equal(a.category, 'search')
    assert.equal(a.isMultiline, true)
  })
  test('typical commands are well under 1 ms', () => {
    const cmds = ['cd /x && grep -rn "foo" src | head -20', "sed -n '10,40p' a.py", 'python3 run.py --fast 2>&1 | tail -5', 'git status && git diff --stat']
    for (const c of cmds) analyzeBash(c)
    const t0 = performance.now()
    for (let i = 0; i < 200; i++) for (const c of cmds) analyzeBash(c)
    assert.ok((performance.now() - t0) / 800 < 1)
  })
})

// ------------------------------------------------------------------ result notes

describe('bashResultNote', () => {
  const N = (command: string, status: 'ok' | 'error' | 'denied' | 'running', preview: string): string | undefined => {
    const n = bashResultNote(analyzeBash(command), status, preview)
    if (n !== undefined) assert.ok(n.length <= 120 && !n.includes('\n'), n)
    return n
  }
  test('a Python traceback gives its last line', () => {
    const tb = 'Exit code 1\nTraceback (most recent call last):\n  File "x.py", line 3, in <module>\n    import torch\nModuleNotFoundError: No module named \'torch\''
    assert.equal(N('python3 x.py', 'error', tb), "ModuleNotFoundError: No module named 'torch'")
  })
  test('pytest gives the first FAILED line', () => {
    const out = 'Exit code 1\n..F.\n=== FAILURES ===\nE   assert 1 == 2\nFAILED tests/test_api.py::test_login - assert 1 == 2\n1 failed, 3 passed in 0.4s'
    assert.equal(N('pytest -q', 'error', out), 'FAILED tests/test_api.py::test_login - assert 1 == 2')
  })
  test('error: lines beat usage lines', () => {
    const out = 'Exit code 2\nusage: report.py [-h] --region REGION\nreport.py: error: the following arguments are required: --region'
    assert.equal(N('python3 report.py', 'error', out), 'report.py: error: the following arguments are required: --region')
  })
  test('shell errors', () => {
    assert.equal(N('ls raw/', 'error', "Exit code 2\nls: cannot access 'raw/': No such file or directory"), "ls: cannot access 'raw/': No such file or directory")
    assert.equal(N('foo --bar', 'error', 'Exit code 127\nbash: line 1: foo: command not found'), 'bash: line 1: foo: command not found')
    assert.equal(N('sleep 999', 'error', 'Exit code 143\nTerminated'), 'Terminated (exit code 143)')
    assert.equal(N('python3 big.py', 'error', 'Exit code 137'), 'Killed (exit code 137, often out of memory)')
    assert.equal(N('python3 x.py', 'error', 'Exit code 1\nall done\n3 rows'), 'Exit code 1')
  })
  test('grep finding nothing', () => {
    assert.equal(N('grep -rn nothing-here src', 'error', 'Exit code 1'), 'No matches (grep exited with 1)')
  })
  test('harness blocks and tool errors', () => {
    assert.equal(N('sleep 60; tail log', 'error', '<tool_use_error>Blocked: sleep 60 followed by: tail log. To wait, use Monitor.</tool_use_error>'), 'Blocked: sleep 60 followed by other commands')
  })
  test('denials', () => {
    assert.equal(N('rm -rf x', 'denied', "Permission to use Bash has been denied because Claude Code is running in don't ask mode."), "Not allowed: Claude Code is in don't-ask mode")
    assert.equal(N('rm -rf x', 'denied', 'Permission to use Bash with command rm -rf x has been denied.'), 'Blocked by a permission rule')
    assert.equal(N('rm -rf x', 'denied', "The user doesn't want to proceed with this tool use."), 'You declined this command')
  })
  test('search counts', () => {
    assert.equal(N('grep -rn foo src', 'ok', 'src/a.py:1:foo\nsrc/b.py:9:foo()\nsrc/c.py:3:x = foo'), '3 matching lines')
    assert.equal(N('grep -rn foo src', 'ok', 'src/a.py:1:foo'), '1 matching line')
    assert.equal(N('grep -rn foo src', 'ok', '(Bash completed with no output)'), 'No matches')
    assert.equal(N('grep -c foo a.txt', 'ok', '42'), '42 matching lines')
    const long = Array.from({ length: 200 }, (_, i) => `src/f.py:${i}:foo bar baz`).join('\n').slice(0, 1500)
    assert.match(N('grep -rn foo src', 'ok', long) ?? '', /^\d+\+ matching lines$/)
  })
  test('list-files entries', () => {
    const ls = 'total 12\ndrwxr-xr-x 2 u u 4096 Oct 1 .\ndrwxr-xr-x 9 u u 4096 Oct 1 ..\n-rw-r--r-- 1 u u 10 Oct 1 a.txt\n-rw-r--r-- 1 u u 10 Oct 1 b.txt'
    assert.equal(N('ls -la logs', 'ok', ls), '2 entries')
    assert.equal(N('ls logs | wc -l', 'ok', '17'), '17 entries')
    assert.equal(N('tree src', 'ok', 'src\n├── a.ts\n└── b.ts\n\n1 directory, 2 files'), '2 files in 1 folders')
  })
  test('test summaries', () => {
    assert.equal(N('pytest -q', 'ok', '............ [100%]\n12 passed in 0.22s'), '12 passed')
    assert.equal(N('pytest', 'ok', '==== 1 failed, 12 passed in 3.21s ===='), '1 failed, 12 passed')
    assert.equal(N('npm test', 'ok', '# tests 17\n# pass 16\n# fail 1'), '16 passed, 1 failed')
    assert.equal(N('npx jest', 'ok', 'Tests:       1 failed, 12 passed, 13 total'), '1 failed, 12 passed, 13 total')
    assert.equal(N('node --test', 'ok', 'ok 1 - parses\nok 2 - renders\n# pass 2\n# fail 0'), '2 passed, 0 failed')
  })
  test('gpu memory lines', () => {
    const q = 'nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu --format=csv'
    assert.equal(N(q, 'ok', 'memory.used [MiB], memory.total [MiB], utilization.gpu [%]\n20480 MiB, 24576 MiB, 87 %'), '20 GiB / 24 GiB used, 87% busy')
    const nh = 'nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader'
    assert.equal(N(nh, 'ok', '15360 MiB, 24576 MiB'), '15 GiB / 24 GiB used')
    assert.equal(N('nvidia-smi', 'ok', '|  0  NVIDIA L4  | 12288MiB / 23034MiB |  45%   Default |'), '12 GiB / 22 GiB used, 45% busy')
  })
  test('wc counts', () => {
    assert.equal(N('wc -l data.jsonl', 'ok', '1234 data.jsonl'), '1234 lines')
    assert.equal(N('wc -l a.py b.py', 'ok', '  10 a.py\n  20 b.py\n  30 total'), '30 lines in total')
  })
  test('http status and background launches', () => {
    assert.equal(N('curl -s -o /dev/null -w "%{http_code}" localhost:8000/health', 'ok', '200'), 'HTTP 200 OK')
    assert.equal(N('python3 serve.py', 'ok', 'Command running in background with ID: b1. Output is being written to: /tmp/x'), 'Running in the background')
    assert.equal(N('python3 slow.py', 'ok', 'Command did not complete within its 120s timeout and was moved to the background (ID: b2).'), 'Still running after 120 s, moved to the background')
  })
  test('quiet when there is nothing useful to say', () => {
    assert.equal(N('python3 x.py', 'ok', 'all good'), undefined)
    assert.equal(N('cat a.txt', 'ok', 'hello'), undefined)
    assert.equal(N('python3 x.py', 'running', ''), undefined)
  })
  test('long lines are cut and odd input is tolerated', () => {
    const n = N('python3 x.py', 'error', 'Exit code 1\nValueError: ' + 'x'.repeat(400))
    assert.ok(n !== undefined && n.length <= 120)
    assert.doesNotThrow(() => bashResultNote(null as unknown as BashAnalysis, 'error', null as unknown as string))
    assert.doesNotThrow(() => bashResultNote({} as BashAnalysis, 'ok', 'x'))
  })
})
