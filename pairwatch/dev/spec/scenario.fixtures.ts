// A realistic main turn as RawEvents, for the integration spec (and dev/gallery-style renders).
// Synthetic: a small Flask app whose login redirect drops the next= parameter. Nine main-loop tool
// calls (a plan, a search, two parallel reads, a failing test run, an edit, a sub-agent with two
// calls of its own, the full suite, a diff), thinking and text between them, then the answer.
import type { RawEvent, ToolEnd, ToolObs } from '../../pairwatch/types'

export const T0 = 1_760_000_000_000
export const CWD = '/work/app'
export const GOAL = 'After I sign in, the app shows the home page instead of the page I asked for. Fix the login redirect and make sure the tests pass.'
export const SUB = 'agent-7f3a'

const at = (ms: number): number => T0 + ms
const start = (id: string, tool: string, args: ToolObs['args'], ms: number, agentId?: string): RawEvent => ({
  kind: 'tool-start',
  obs: { id, tool, args, at: at(ms), ...(agentId === undefined ? {} : { agentId }) },
})
const end = (id: string, status: ToolEnd['status'], preview: string, ms: number): RawEvent => ({ kind: 'tool-end', end: { id, status, preview, at: at(ms) } })
const numbered = (lines: readonly string[]): string => lines.map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n')

export const LOGIN_PY = [
  'from flask import Blueprint, redirect, request, url_for',
  'from .session import start_session',
  'from .safety import is_safe_url',
  '',
  "bp = Blueprint('auth', __name__)",
  '',
  "@bp.route('/login', methods=['POST'])",
  'def login():',
  '    user = check_password(request.form)',
  '    start_session(user)',
  '    return redirect(url_for("home"))',
]

export const FAILING_RUN = [
  'Exit code 1',
  '....F',
  '=================================== FAILURES ===================================',
  '___________________________ test_login_keeps_next ____________________________',
  '    def test_login_keeps_next(client):',
  '        r = client.post("/login?next=/settings", data=CREDS)',
  ">       assert r.headers['Location'] == '/settings'",
  "E       AssertionError: assert '/home' == '/settings'",
  '=========================== short test summary info ============================',
  "FAILED tests/test_auth.py::test_login_keeps_next - AssertionError: assert '/home' == '/settings'",
  '1 failed, 4 passed in 0.42s',
].join('\n')

export const ANSWER = 'Fixed: the login view now follows the next= parameter when it points inside the app, and falls back to the home page otherwise. All 12 tests pass.'

/** Ids of the main loop's tool calls, in order. */
export const MAIN_CALLS = ['toolu_plan', 'toolu_grep', 'toolu_read1', 'toolu_read2', 'toolu_test1', 'toolu_edit', 'toolu_agent', 'toolu_test2', 'toolu_diff'] as const

export const SCENARIO: readonly RawEvent[] = [
  { kind: 'prompt', text: GOAL, origin: 'composer', at: at(0) },
  { kind: 'turn-start', turnId: 'turn-1', at: at(20) },
  { kind: 'stream', mode: 'thinking', at: at(300) },
  { kind: 'think', text: 'The redirect probably ignores the next= parameter. Plan the fix, then find where login builds its redirect.', at: at(2_900) },
  start('toolu_plan', 'TodoWrite', {
    todos: [
      { content: 'Reproduce the failing redirect', status: 'in_progress', activeForm: 'Reproducing the failing redirect' },
      { content: 'Keep next= on the login redirect', status: 'pending', activeForm: 'Keeping next= on the login redirect' },
      { content: 'Run the whole test suite', status: 'pending', activeForm: 'Running the whole test suite' },
    ],
  }, 3_000),
  end('toolu_plan', 'ok', 'Todos have been modified successfully.', 3_100),
  { kind: 'stream', mode: 'text', at: at(3_400) },
  { kind: 'say', text: 'I’ll find where the login view builds its redirect.', at: at(3_900) },
  start('toolu_grep', 'Bash', { command: 'grep -rn "redirect(" src/ --include=*.py', description: 'Find where redirects are built' }, 4_000),
  end('toolu_grep', 'ok', 'src/auth/login.py:11:    return redirect(url_for("home"))\nsrc/auth/views.py:88:    return redirect(next_url)\nsrc/admin/views.py:17:    return redirect(url_for("home"))', 4_300),
  start('toolu_read1', 'Read', { file_path: '/work/app/src/auth/login.py' }, 4_800),
  start('toolu_read2', 'Read', { file_path: '/work/app/tests/test_auth.py' }, 4_850),
  end('toolu_read1', 'ok', numbered(LOGIN_PY), 5_000),
  end('toolu_read2', 'ok', numbered(Array.from({ length: 48 }, (_, i) => (i === 0 ? 'import pytest' : `    # line ${i + 1}`))), 5_050),
  { kind: 'stream', mode: 'thinking', at: at(5_300) },
  { kind: 'think', text: 'login() always redirects home. Run the auth tests first to see the failure for myself.', at: at(8_400) },
  start('toolu_test1', 'Bash', { command: 'python -m pytest tests/test_auth.py -q', description: 'Run the auth tests to reproduce the failure' }, 8_500),
  end('toolu_test1', 'error', FAILING_RUN, 11_500),
  start('toolu_edit', 'Edit', {
    file_path: '/work/app/src/auth/login.py',
    old_string: '    return redirect(url_for("home"))',
    new_string: '    next_url = request.args.get("next")\n    if next_url and is_safe_url(next_url):\n        return redirect(next_url)\n    return redirect(url_for("home"))',
  }, 13_000),
  end('toolu_edit', 'ok', 'The file /work/app/src/auth/login.py has been updated successfully.', 13_200),
  start('toolu_agent', 'Agent', { description: 'Check other views for the same redirect bug', subagent_type: 'Explore', prompt: 'Look through src/ for other views that redirect after login and ignore next=.' }, 14_000),
  { kind: 'agent-start', agentId: SUB, type: 'Explore', description: 'Check other views for the same redirect bug', toolUseId: 'toolu_agent', background: false, at: at(14_100) },
  { kind: 'stream', agentId: SUB, mode: 'thinking', at: at(14_300) },
  start('toolu_sub1', 'Bash', { command: 'grep -rn "url_for(\\"home\\")" src/', description: 'Find other hard-coded home redirects' }, 14_600, SUB),
  end('toolu_sub1', 'ok', 'src/admin/views.py:17:    return redirect(url_for("home"))', 14_900),
  start('toolu_sub2', 'Read', { file_path: '/work/app/src/admin/views.py' }, 15_400, SUB),
  end('toolu_sub2', 'ok', numbered(['from flask import redirect, url_for', '', 'def logout():', '    return redirect(url_for("home"))']), 15_600),
  { kind: 'turn-end', turnId: 'turn-1', agentId: SUB, durationMs: 4_000, answer: 'Only admin/views.py redirects home, and that is logout, which takes no next parameter.', reason: 'answer', at: at(18_000) },
  { kind: 'agent-stop', agentId: SUB, at: at(18_050) },
  end('toolu_agent', 'ok', 'Only admin/views.py redirects home, and that is logout, which takes no next parameter.', 18_100),
  start('toolu_test2', 'Bash', { command: 'python -m pytest -q', description: 'Run the full test suite' }, 19_000),
  end('toolu_test2', 'ok', '............\n12 passed in 1.03s', 23_000),
  start('toolu_diff', 'Bash', { command: 'git diff --stat', description: 'Review the change' }, 23_500),
  end('toolu_diff', 'ok', ' src/auth/login.py | 4 +++-\n 1 file changed, 3 insertions(+), 1 deletion(-)', 23_700),
  { kind: 'stream', mode: 'text', at: at(24_000) },
  { kind: 'say', text: ANSWER, at: at(26_000) },
  { kind: 'turn-end', turnId: 'turn-1', durationMs: 26_100, answer: ANSWER, reason: 'answer', at: at(26_100) },
]
