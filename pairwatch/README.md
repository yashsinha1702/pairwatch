# Pairwatch

**Learn while Claude works.**

Pairwatch is a Claude Code mod that explains your session while it runs. Instead of watching tool rows scroll past, you see what Claude is doing, why, and the idea behind it, in plain language.

It adds a pane to your session, plus a local page for editors that don't draw mod panes. Both show three things:

- **A stage.** A small avatar hops between stations: Think, Plan, Search, Read, Edit, Run, Web, Agents, Tools and You. Each activity has its own scene.
- **A narration.** A sentence or two on what Claude is doing right now and why.
- **A concept card.** One idea the current step uses: a shell idiom, a git command, an agent habit like "read before edit". There are about 160 cards, picked by your level and by what you haven't seen yet.

Pairwatch only watches. Its hooks pass every event through unchanged, so it never changes what Claude does. If Pairwatch fails, the session carries on without it.

## Requirements

- **Claude Code 2.1.287 or newer, with installed mods turned on for you.** Some builds still check a server-side rollout flag before they load an installed mod, and the mods API can still change between releases. The repository's README shows how to check.
- **Node.js 18 or newer** on the machine Claude runs on. Only the page needs it, not the pane.
- **Linux or macOS.** Windows is untested.

## Use

Run `/pairwatch` in a session. It opens the pane, starts the page and prints the page's link. The pane also opens by itself on your first prompt.

`/pairwatch help` lists the other commands. They set your level (beginner, intermediate or expert), pause the stage, turn the narration model on or off, show the concepts you have met, and close Pairwatch.

## What it runs, saves and sends

Everything stays on your machine. The only exception is calls to Claude made with your own account: the narration and **Why?**.

- **It runs one program.** A small Node server with no dependencies serves the page. It listens on 127.0.0.1 only (port 7979 by default) and answers API calls only when they carry a local key and come from a local Host and Origin. Turn the **Viewer page** setting off and there is no server and no snapshot files.
- **It saves files in two places.** The page's snapshots, its key and the server's log go under `~/.claude/pairwatch`, which is readable by you alone. Your level, your preferences and the cards you have seen are kept in Claude Code's plugin store.
- **It makes two kinds of call to Claude.** The narration asks a small model (Haiku by default) to rewrite the current step in plain words, and only while someone is watching. **Why?** asks the session's own model to explain its current step. Both go through Claude Code with your own account. `/pairwatch model off` keeps the rules narration, which makes no calls.
- **It masks secrets.** Common secret shapes, such as API keys, tokens, passwords and private keys, are masked in everything Pairwatch shows or saves and in the narration prompt. A password with nothing around it that marks it as one can't be recognised.

Pairwatch contacts no other service and loads nothing from the internet.

## Cost

- **Narration:** about $0.0002 per step, at most 600 calls per session (about $0.10).
- **Why?:** about what one more turn of your session costs.

On a Claude subscription, these calls count toward your usage like any other.

## More

The repository has the full guide: every command and setting, where the pane and the page appear, how to uninstall, and how it works.

https://github.com/yashsinha1702/pairwatch

## License

MIT. See `LICENSE`.
