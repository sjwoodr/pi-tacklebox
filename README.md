# pi-tacklebox

A box of extensions for [pi](https://pi.dev), mostly for running local models on Ollama. The
parts aren't related; each one fixes one thing and can be switched off on its own.

| Extension | What it does | Default |
|---|---|---|
| think-budget | Caps thinking tokens on servers that have no thinking budget (Ollama): stops the reasoning at the cap and asks for the answer, with the reasoning so far as notes. [docs/think-budget.md](docs/think-budget.md) | on for Gemma on Ollama (`gemma*`), or the models in your rules |
| turn-timer | How long each turn took, in the status bar: `⏱ 45.6s · first 0.7s · read 10k @ 310/s · wrote 375 @ 60/s · 13k cached · 3 reqs` (prompt reading and writing timed apart, per request) | on |
| outline-reads | A whole-file read of a large file returns its first 80 lines and an outline of definitions with line numbers, so a slow machine doesn't spend a minute reading 100 KB; reads with `offset`/`limit` are untouched | off |
| search | `web_search` and `web_fetch` tools, through a SearXNG instance or Ollama's web search, with prompt guidance that includes today's date | off |
| nudge | When a run is about to end on a reply that can't be what the model meant (a tool call written out as text, an empty reply, or "let me update `x.ts`:" with no call), sends one short message saying what went wrong and asks for one more request; at most `maxPerPrompt` per prompt | on |
| verify-done | When a run that edited files is about to end, runs the project's tests; if they fail, sends the model the end of the output and one more request, up to `maxRounds`. Tests are also run before the first edit, and a suite that already failed isn't blamed on the change | on |
| jobs | `job_start`, `job_status` and `job_kill` tools: a long command (watching a deploy or CI run, a build, a dev server) runs in the background, and its exit code and last lines reach the model as a message when it ends, starting a turn if pi is idle. A bash call that would block for minutes (`gh run watch`, `kubectl rollout status`, `tail -f`, a polling loop, a long `sleep`) is refused with a pointer to `job_start` | on |
| bang | `!command` gets an answer straight away: the model reads the output and responds, with no need to send another message. `!!command` stays private | on |
| session-search | `session_search` tool and `/recall <regex>` command: search past pi sessions for what you said and the commands that ran, newest first. Tool output, thinking, replies and `!!` commands are never searched or shown. Refuses to run on a model that isn't local (cloud models behind local Ollama count as remote), unless `allowNonLocal` is set | on |
| loop | `/loop <task>`: one model implements, another reviews a throwaway copy, the first fixes, until the review passes, with turn and time limits on every step and the project's tests run between steps. Other workflows (parallel steps, own workspaces, checks, repeats) can be named in tacklebox.json, or drafted for one run with `/flow <what you want>` and approved before they run. [docs/loop.md](docs/loop.md) | on (`/loop` needs its two models named) |
| sandbox | Runs every bash command inside Anthropic's sandbox-runtime (`srt`): writes only where allowed, network only to allowed hosts, denied folders hidden, variables named like secrets removed. read/write/edit/grep/find/ls are checked against the same rules, and `job_start`, verify-done and the loop's gates run through it too. pi, its model calls and your `!` commands stay outside. [docs/sandbox.md](docs/sandbox.md) | off (needs `srt`) |

## Install

```bash
pi install git:https://github.com/sjwoodr/pi-tacklebox
```

If you used the standalone `pi-think-budget` before, remove
`git:https://github.com/sjwoodr/pi-think-budget` from `~/.pi/agent/settings.json`, or the budget
loads twice. Its configuration (`~/.pi/agent/think-budget.json`) is still read.
Likewise remove any loose copies of these extensions from `~/.pi/agent/extensions/` (a second
`web_search` tool stops pi from starting).

## Configure

`~/.pi/agent/tacklebox.json` (or `$PI_CODING_AGENT_DIR/tacklebox.json`); every setting is optional,
and no file means the defaults below. A misspelt setting is an error at startup, not ignored.

```json
{
  "turnTimer": { "enabled": true },
  "outlineReads": { "enabled": false, "maxChars": 20000 },
  "search": {
    "backend": "off",
    "searxngUrl": "http://127.0.0.1:8888",
    "ollamaUrl": "http://127.0.0.1:11434"
  },
  "nudge": { "enabled": true, "maxPerPrompt": 2 },
  "verifyDone": { "enabled": true, "command": "", "maxRounds": 2, "timeoutSeconds": 120 },
  "jobs": { "enabled": true, "blockLong": true, "waitSeconds": 900 },
  "bang": { "enabled": true },
  "sessionSearch": { "enabled": true, "allowNonLocal": false },
  "sandbox": { "enabled": false, "srt": "srt", "settings": "srt-settings.json" },
  "loop": { "enabled": true }
}
```

- `search.backend`: `"off"`, `"searxng"` (needs a SearXNG with the JSON format enabled; pages are
  fetched from your machine, never from local or private addresses) or `"ollama"` (Ollama's web
  search through your local Ollama; needs `ollama signin`, and queries and fetched URLs go to
  ollama.com).
- `outlineReads.maxChars`: a whole-file read returning more text than this gets the outline.
- `verifyDone`: on by default, so it **runs the project's tests on its own** after any edit. In a repo
  whose tests are slow or touch real services (a database, an API, a deploy), turn it off or set a
  safe `command`.
- `verifyDone.command`: the test command; empty means detect it (`npm`/`pnpm`/`yarn test` from
  `package.json`, `cargo test`, `go test ./...`, pytest, or a Makefile's `test` target). A run
  is killed after `timeoutSeconds`. It can't catch a change that passes the tests but isn't what
  was asked.
- `jobs`: output goes to a log file under the system temp dir; jobs still running are killed when
  pi exits. `blockLong: false` lets blocking bash calls through. In print mode (`pi -p`), a run
  that would end with a job still running waits up to `waitSeconds` for it, then carries on with
  the result, so it isn't lost when pi exits.
- `bang`: every `!` becomes a model call, so use `!!` for commands that don't need an answer, or set
  `enabled` to `false` to get pi's own behavior back. A `!` run while the model is busy waits for your
  next message, as it does without this.

- `sandbox`: needs `srt` (`npm install -g @anthropic-ai/sandbox-runtime`) and, on Linux, bubblewrap,
  socat and ripgrep. `settings` is srt's own settings file, in pi's agent directory unless absolute.
  When it is on but unusable, commands and file tools are refused. See [docs/sandbox.md](docs/sandbox.md).
- `loop`: `/flow` works as is, since each workflow names its models. `/loop` (the built-in review loop) also
  needs `loop.implementer.model` and `loop.reviewer.model`; limits, rounds, checks and time all have
  defaults. `enabled: false` removes both commands. See [docs/loop.md](docs/loop.md).

think-budget's rules go in a `thinkBudget` section of the same file, or, without one, in the older
`think-budget.json`: see [docs/think-budget.md](docs/think-budget.md).

To leave an extension out entirely, filter it in pi's settings:

```json
{ "source": "git:https://github.com/sjwoodr/pi-tacklebox", "extensions": ["!src/think-budget/**"] }
```

## Development

```bash
npm install
npm test        # node --test
npm run check   # tsc
```

## License

MIT
