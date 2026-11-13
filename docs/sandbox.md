# sandbox

Runs pi's tools the way Claude Code runs its own: every command inside Anthropic's sandbox-runtime
(`srt`, the engine behind Claude Code's sandbox), the file tools checked against the same rules, and pi
itself outside. Off by default.

## Why this shape

pi's security doc describes three setups: run pi directly, run all of pi inside a container or
sandbox, or run pi outside with only its tools inside. This is the third. pi, its model calls (a local
Ollama included), its credentials (`auth.json`, provider API keys) and your `!` commands stay outside,
so a command the model runs cannot read pi's keys or reach your local model server. The price is that
anything else running inside pi's own process is not covered (see [Limits](#limits)).

`srt` is a research preview (version 0.0.x): its settings format may change.

## Setup

1. Install `srt` and, on Linux, the tools it uses (macOS needs nothing more):

   ```bash
   npm install -g @anthropic-ai/sandbox-runtime
   sudo apt-get install bubblewrap socat ripgrep
   ```

2. Write srt's settings to `~/.pi/agent/srt-settings.json`, for example:

   ```json
   {
     "network": {
       "allowedDomains": ["github.com", "api.github.com", "codeload.github.com", "*.githubusercontent.com", "registry.npmjs.org"],
       "deniedDomains": []
     },
     "filesystem": {
       "denyRead": ["~/.ssh", "~/.aws", "~/.config/gh", "~/.pi/agent/auth.json"],
       "allowWrite": [".", "/tmp"],
       "denyWrite": []
     },
     "credentials": {
       "envVars": [
         { "name": "GITHUB_TOKEN", "mode": "deny" },
         { "name": "GH_TOKEN", "mode": "deny" }
       ]
     }
   }
   ```

   srt refuses a settings file that leaves out a required list (`network.deniedDomains`,
   `filesystem.denyWrite`), even an empty one, rather than fall back to its defaults. The full
   reference is srt's README: <https://github.com/anthropics/sandbox-runtime>.

3. Turn it on in `tacklebox.json`:

   ```json
   { "sandbox": { "enabled": true } }
   ```

   If `srt` is not on the PATH pi starts with (an nvm install, say), set `"srt"` to its full path.
   `"settings"` names another settings file, relative to pi's agent directory unless absolute.

4. Start pi. A notice says which settings file is in use.

## What it covers

- **pi's bash tool.** Each command runs as `srt --settings <file> bash -c <command>`: it can write only
  to `allowWrite`, reach only `allowedDomains` (through srt's proxy), and not see `denyRead`. srt also
  always blocks writes to git hooks and config, shell rc files, `.gitconfig`, `.gitmodules`,
  `.mcp.json`, and `.vscode/`, `.idea/`, `.claude/commands/` and `.claude/agents/`.
- **Secrets in the environment.** Every variable whose name looks like a secret (`TOKEN`, `SECRET`,
  `PASSWORD`, `API_KEY`, `ACCESS_KEY`, `PRIVATE_KEY`, `CREDENTIAL`) is removed before a command
  starts, on top of whatever srt's `credentials` block denies or masks.
- **read, write, edit, grep, find and ls.** Checked against the same `denyRead`, `allowWrite` and
  `denyWrite` lists and the same protected paths, after symlinks are resolved. A grep or find from a
  folder above a denied one is refused, since it would search it. Glob entries in those lists are
  enforced by srt for commands only; the file tools skip them, and the start-up notice lists any.
- **tacklebox's own commands:** `job_start`, verify-done's test run and the loop's gates.
- **It fails closed.** When the sandbox is on but `srt` or its settings cannot be used, commands, file
  tools and `job_start` are refused, never run unprotected.

## Limits

- **pi itself and other packages run with your full access.** A tool from another extension that reads
  files, runs commands or fetches URLs on its own is not checked. Install only extensions you have
  read.
- **`web_fetch` and `web_search`** (tacklebox's search) fetch from pi's process, so the network
  allowlist does not limit them.
- **MCP servers** pi starts run outside.
- **Your `!` and `!!` commands** run outside, as in Claude Code.
- **The project is readable and writable.** A secret in a project file (`.env`) can be read, and a
  script the model edits (`package.json`'s test script, a Makefile) runs with full access when you run
  it yourself outside pi. verify-done and the loop's gates run it inside.
- **Local servers.** Inside srt, `localhost` is the sandbox's own, so a command cannot reach a server on
  your machine's loopback (Ollama, a dev database). pi's model calls are outside and unaffected.
- **Start pi in a project, not above many of them.** On Linux srt protects the hooks and config of every
  git repository it finds below the working directory, and bubblewrap takes at most 9000 arguments.
  Started from a folder with hundreds of repositories below it (`/tmp` full of worktrees, say), every
  command fails with `Sandbox profile has N bwrap arguments and bwrap accepts at most 9000`. Start pi
  from the project itself. srt's `mandatoryDenySearchDepth` lowers the count, but leaves the deeper
  repositories unprotected.

## Checking it

Ask the model to run each of these:

| Command | Expected |
|---|---|
| `curl -sS -o /dev/null -w '%{http_code}' https://example.com` | `000` (blocked) |
| `echo ${#GITHUB_TOKEN}` | `0` |
| `ls -A ~/.ssh \| wc -l` | `0` |
| `touch ~/sandbox-probe` | fails |

Then ask it to read `~/.ssh/known_hosts`: the read is refused with a `sandbox:` reason.
