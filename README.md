# Pairwatch

**Learn while Claude works.**

Pairwatch is a Claude Code mod that explains your session while it runs. Instead of watching tool rows scroll past, you see what Claude is doing, why, and the idea behind it, in plain language.

<!-- TODO: add docs/screenshot.png (the pane in a terminal session, and the page beside the VS Code chat), then move this line out of the comment:
![Pairwatch beside a Claude Code session](docs/screenshot.png)
-->

## What it is

A pane in your session, plus a local page for editors that don't draw mod panes. Both show three things:

- **A stage.** A small avatar hops between stations: Think, Plan, Search, Read, Edit, Run, Web, Agents, Tools and You. Each activity has its own scene: a terminal typing the command, a file being scanned, a diff sliding in, sub-agents fanning out, a checklist ticking.
- **A narration.** A sentence or two on what Claude is doing right now and why. Rules write it at once; a short narration from a small model (Haiku) replaces it a moment later.
- **A concept card.** One idea the current step uses: a shell idiom, a git command, an agent habit like "read before edit". There are about 160 cards, picked by your level and by what you haven't seen yet. A card goes deeper while a long step runs.

| Button | Key | What it does |
| --- | --- | --- |
| **Why?** | `w` | Asks the session's own model to explain its current step, in the first person |
| **Another tip** | `t` | Shows a different card |
| **I know this** | `k` | Marks the card as known, so it stops coming up |
| **Pause** | `p` | Holds the stage still and stops the narration |
| **Level** | | Beginner, intermediate or expert |

Pairwatch only watches. Its hooks pass every event through unchanged, so it never changes what Claude does. If Pairwatch fails, the session carries on without it.

## Requirements

- **Claude Code 2.1.287 or newer.** Mods arrived in 2.1.287. Pairwatch is built against 2.1.295, and the mods API can still change between releases.
- **Installed mods turned on for you.** Some builds still check a server-side rollout flag before they load an installed plugin's hooks. If `/pairwatch` is an unknown command after you install, check the debug log:

  ```sh
  claude --debug      # start a session, try /pairwatch, then quit
  grep "hooks modules" "$(ls -t ~/.claude/debug/*.txt | head -n 1)"
  ```

  If it says `installed plugins' hooks modules not loaded: rollout flag (…) is off`, this build doesn't run installed mods for you yet. If it says `not loaded until workspace trust is accepted`, trust the folder first.
- **Node.js 18 or newer** on the machine Claude runs on. Only the page needs it, not the pane.
- **Linux or macOS.** Windows is untested.

## Install

Type this at the prompt of a terminal session (`claude`):

```
/plugin install pairwatch --marketplace <owner>/pairwatch
```

Answer `y` to add the marketplace. Pick a scope: User puts Pairwatch in every session. Then keep the default settings. It is active at once: run `/pairwatch`.

Or install from a shell:

```sh
claude plugin marketplace add <owner>/pairwatch
claude plugin install pairwatch@pairwatch
```

- **Desktop app:** its Code tab doesn't take the install line. Install from a terminal at User scope, and Pairwatch loads in the Desktop app's local sessions too.
- **Updates:** third-party marketplaces don't auto-update by default. Run `claude plugin marketplace update pairwatch`, then `claude plugin update pairwatch@pairwatch`, then `/reload-plugins` in open sessions.
- **Local development:** from a clone, run `claude --plugin-dir ./pairwatch`. It reloads when you save.

## Where to see it

| Where you run Claude | What shows Pairwatch |
| --- | --- |
| `claude` in a terminal, including VS Code's integrated terminal | The pane. The stage is a line of station marks there. |
| The Claude Desktop app (Code tab, local sessions) | The pane, with the animated stage |
| The VS Code extension's chat panel | Nothing: the panel doesn't draw mod panes. Use the page. |
| `claude -p` and the Agent SDK | Nothing: there is no screen to draw on |

The pane opens by itself on your first prompt. `/pairwatch auto off` stops that.

### The page

Pairwatch serves its own page on the machine Claude runs on, for editors that don't draw mod panes, such as the VS Code chat panel.

1. Run `/pairwatch`. It prints the page's link, with its key: `http://localhost:7979/?key=…`
2. If you work over SSH (for example, VS Code Remote-SSH), forward the port to your computer first. Either:
   - in VS Code's **Ports** tab, choose **Forward a Port** and enter `7979`; or
   - on your computer, run `ssh -N -L 7979:127.0.0.1:7979 <host>`.
3. Open the link in **Simple Browser** (Ctrl+Shift+P, or ⇧⌘P on a Mac, then "Simple Browser: Show") and put it beside the chat. Any browser works too.

By default the page follows the newest session. It stays with that session until it ends or is quiet for 10 minutes. To keep one session, pick it from the page's list. A session that has ended says so.

If the page doesn't answer, `/pairwatch status` says why and shows the end of the server's log.

## Commands

| Command | What it does |
| --- | --- |
| `/pairwatch` | Opens the pane, starts the page and prints its link |
| `/pairwatch close` | Closes Pairwatch until you run `/pairwatch` again: no status line, narration or page updates, and no opening by itself |
| `/pairwatch pause`, `resume` | Holds the stage still; no narration is asked for |
| `/pairwatch level beginner\|intermediate\|expert` | Sets how much the narration and the cards assume you know |
| `/pairwatch model on\|off` | Narration by the narrator model, or by rules only (free) |
| `/pairwatch auto on\|off` | Opens by itself on your first prompt (on by default) |
| `/pairwatch journal` | Lists the concepts you have met so far |
| `/pairwatch reset` | Forgets the cards you've seen and marked as known |
| `/pairwatch status` | Shows where the pane and the page are, the narration counts, and why the page is down |
| `/pairwatch help` | Lists these commands |

## Settings

You can set these when you install. To change them later, run `/plugin configure pairwatch@pairwatch` in a session. From a shell, pipe the values in as JSON and restart Claude Code:

```sh
echo '{"viewerPort": "8080"}' | claude plugin configure pairwatch@pairwatch --values-stdin
```

| Setting | Default | What it does |
| --- | --- | --- |
| **Viewer page** (`viewer`) | on | Serves Pairwatch's own page on this machine, for editors that don't draw mod panes. When off, there is no server and no snapshot files. |
| **Viewer port** (`viewerPort`) | `7979` | Sets the page's port (1024 to 65535). |
| **Narration model** (`narratorModel`) | `haiku` | Picks `haiku` or `sonnet`. Sonnet costs about ten times as much. |

## Privacy

Everything stays on your machine. The only exception is calls to Claude made with your own account: the narration and **Why?**.

| What | Where | Details |
| --- | --- | --- |
| Snapshots for the page | `~/.claude/pairwatch/live/<session>.json` | `~/.claude/pairwatch` is readable by you alone (0700). Each snapshot holds what the page shows: the working folder, the start of your prompt, the narration, the card and the stage (the current command, file paths, diff lines and output lines). They are written only while the Viewer page setting is on and once its server has answered, and they stop after `/pairwatch close`. The server deletes snapshots older than 7 days. |
| The page's key | `~/.claude/pairwatch/viewer.token` (0600) | The server listens on 127.0.0.1 only. It answers API calls only when they carry this key and come from a local Host and Origin. |
| The server's log | `~/.claude/pairwatch/viewer.log` | Start-up messages and errors |
| Your level, preferences, cards seen and known, the journal | Claude Code's plugin store, `~/.claude/plugins/store/pairwatch_*.json` | Kept by Claude Code |

Common secret shapes, such as API keys, tokens, passwords and private keys, are masked in everything Pairwatch shows or saves (the pane, the status line, the page's snapshots) and in the narration prompt. A password with nothing around it that marks it as one can't be recognised.

## Cost

| Call | Cost | Limits |
| --- | --- | --- |
| Narration (Haiku) | About $0.0002 per step | Only while someone watches: the pane is drawn, or a page shows this session. One call at a time, at least 2.5 s apart, and at most 600 per session (about $0.10). |
| **Why?** | About what one more turn of your session costs | A full call to the session's main model over the whole conversation. At most one every 20 s. |

`/pairwatch model off` keeps the rules narration, which costs nothing. On a Claude subscription, these calls count toward your usage like any other.

## Uninstall

```sh
claude plugin uninstall pairwatch
# Stop the page's server. Use your Viewer port if you changed it. It also exits by itself after 8 idle hours.
curl -X POST -H "x-pairwatch-key: $(cat ~/.claude/pairwatch/viewer.token)" http://127.0.0.1:7979/api/quit
rm -rf ~/.claude/pairwatch
```

You can also run `claude plugin marketplace remove pairwatch`, and delete `~/.claude/plugins/store/pairwatch_*.json`, which holds your level and cards.

## How it works

```
hooks: prompt.submit, turn.step, tool.call, agent.spawn, ...   observe only; every event passes through unchanged
  -> a pump folds the events into a timeline of steps every 400 ms
       rules explain each step (with a reader for shell commands) and pick a card by level and novelty
       while someone watches, the narrator model rewrites the line in plain words
  -> the pane draws from Claude Code's shared state
  -> the page draws from a snapshot file, which a small Node server (no dependencies) streams to the browser
```

The repository:

- `pairwatch/` is the plugin.
  - `hooks/register.tsx` holds all the code that talks to Claude Code.
  - `hooks/core/` holds pure modules: the timeline, the explainer, the shell reader, the stage and the cards. They also run unchanged in Node.
  - `viewer/` holds the page and its server.
  - `types/index.d.ts` is the shared-type contract.
  - `tests/` holds the kit tests.
- `dev/` holds the checks, specs and tools (see [Development](#development)).
- `.claude-plugin/marketplace.json` makes this repository a marketplace.

## Roadmap

- A quiz during long waits: "what will Claude do next?"
- Replays of past sessions on the page
- Sub-agent lanes on the stage, and a heat map of the files touched
- A per-project glossary: Claude explaining your codebase's own vocabulary
- Windows support for the page

## Credits

Pairwatch grew out of watching agents work and wanting the wait to teach something. Similar projects worth knowing:

- [Pixel Agents](https://github.com/pablodelucca/pixel-agents): each Claude Code session as an animated pixel-art character in a virtual office, in VS Code.
- [Eklavya](https://github.com/ProjectAJ14/eklavya): short questions about the code Claude just wrote, with spaced repetition and project memory.
- [maxlearn](https://github.com/yashverma2110/maxlearn): a mod that turns the topics your chats touch into lessons and flashcards.
- Claude Code's built-in [Explanatory and Learning output styles](https://code.claude.com/docs/en/output-styles): Claude explains its choices, or leaves you a piece to write, in its own replies.

## Development

From the repository's root:

```sh
(cd dev && npm ci)   # TypeScript, for the type-check
dev/check.sh         # all checks: tsc, plugin validate, kit tests, node specs
dev/check.sh spec    # or one of them: tsc | validate | test | spec
```

- **Node 22.18 or newer.** The specs and tools are TypeScript that Node runs directly.
- **`dev/check.sh` finds what it needs, and prints what it picked.**
  - The API declarations: `$TYPES`; else the copy Claude Code lays in `pairwatch/.claude-plugin/types/` when it loads the mod with `--plugin-dir`; else the plugin-authoring skill's copy in Claude Code's temp folder.
  - The `claude` binary: `$CLAUDE_BIN`; else a `claude` on PATH at or above the declarations' version; else the VS Code extension's binary of that version (or a newer one).
- **Kit tests** (`claude plugin test`) run only where installed mods run. See the rollout flag under [Requirements](#requirements).
- **`claude --plugin-dir ./pairwatch`** loads your working copy and reloads it on save. `dev/deploy.sh <session-id>` copies it into a running session's mods folder instead, and that session hot-reloads it.

Eval and gallery:

```sh
node dev/eval-corpus.ts [--limit N] [--out DIR]   # replays your own transcripts (~/.claude/projects) through the explainer
node dev/gallery.ts [--no-png] [--out DIR]        # draws every station and state as SVG, plus PNG filmstrips
```

- Both write to a new private temp folder unless you pass `--out`, and print where. The eval's sample report quotes your own sessions, so keep it out of the repository.
- The PNG filmstrips need Playwright with Chromium. Install them once, in a folder of your choice, and point `PAIRWATCH_TOOLS` at it:

  ```sh
  mkdir -p ~/pw-tools && cd ~/pw-tools && npm init -y && npm install playwright
  PLAYWRIGHT_BROWSERS_PATH="$PWD/browsers" npx playwright install chromium   # on Linux, add --with-deps if Chromium lacks libraries
  export PAIRWATCH_TOOLS=~/pw-tools
  ```

## License

[MIT](LICENSE)
