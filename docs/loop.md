# loop

`/loop <task>` runs an implement → review → fix loop in the current repository, with two other models, and
code (not a model) deciding every step:

```
implement → checks → review (on a throwaway copy) → clean? stop : fix → checks → review … (up to maxRounds)
```

- **Limits on every step**, enforced from outside through pi's RPC mode, gentlest first. A few turns (or
  minutes) before a limit the step is **warned** (a steer message: stop and write the report), so a model
  that listens finishes on its own. At the limit it gets a **firm steer** (the final ask), which rides on the
  request pi sends anyway. Only a model that ignores both is **aborted**, 3 turns or 2 minutes later, and asked
  once for its report in the same process, so the conversation and the model server's prompt cache stay warm.
  Only a pi that is stuck is **killed**, with its whole process group. A pi that doesn't answer at start is killed and
  retried once. Killing or aborting a step mid-request leaves LM Studio reading the dead request's prompt
  for minutes (it only notices a closed connection when it sends a token), so steers come first.
- **Checks run by the loop**, not the model: `npm test` and `npm run check` by default after every
  implementer step. A failure goes straight back to the implementer, without spending a review.
- **The reviewer can't touch the real code**: it reviews a detached git worktree with the uncommitted work
  copied in (node_modules linked). A reviewer once ran `git stash` / `git stash pop` through bash to compare
  against the baseline; in the copy, that's harmless.
- **A verdict decides**: the reviewer ends with `VERDICT: PASS` or `VERDICT: CHANGES` and tags findings
  `[critical]`, `[high]` or `[minor]`. The loop stops when it passes with nothing critical or high, after
  `maxRounds`, when a fix changes nothing, when the reviewer gives no verdict even when asked again, or when
  the total time runs out. A review with no verdict is never handed to the implementer.
- **Every step keeps its session** under `~/.pi/agent/sessions/loop/<run id>/`, named by step, with a
  `report.md`: per step the turns, minutes, read/s and write/s and any limit hit, per role and in total, the
  final checks, and the last review. Steps run with `PI_OFFLINE=1` (no startup network work).

The loop is only as good as its reviewer: a gap the reviewer misses is never fixed.

## Use

- `/loop [--rounds N] [--minutes N] [--implementer M] [--reviewer M] [--no-gates] <task>`; the options
  change one run. A word alone (`/loop config`, `/loop status`, `/loop stop`) is a subcommand;
  `/loop config the logger…` is a task.
- From a shell, in the repository: `node src/loop/cli.ts --task-file task.md` (from this package), progress
  on stderr, the report on stdout, exit 0 only for a pass with passing checks.

## Configure

Off by default. In `tacklebox.json`, the models are required; everything else has a default:

```json
"loop": {
  "enabled": true,
  "implementer": { "model": "ollama/beam:cloud:medium", "tools": [], "maxTurns": 40, "maxMinutes": 15 },
  "reviewer": { "model": "lmstudio/qwen/qwen3.8-27b:off", "tools": ["read", "grep", "find", "ls", "bash"], "maxTurns": 45, "maxMinutes": 12 },
  "wrapUpMinutes": 6,
  "maxRounds": 3,
  "maxTotalMinutes": 75,
  "gates": ["npm test", "npm run check"],
  "gateTimeoutMinutes": 5,
  "gateRetries": 1,
  "startupSeconds": 60
}
```

Model patterns take pi's thinking suffix, `provider/model:level`; pi splits at the last colon, so
`ollama/beam:cloud:medium` works. `tools: []` means pi's defaults. Give the implementer a model that edits
reliably and the reviewer one that reads carefully; a fast model that loops on edits won't get far.
