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
  `report.md`: the models that ran, per step the turns, minutes, read/s and write/s and any limit hit, per role
  and in total, the final checks, the last step's answer and the last review. Each step's whole answer is saved
  next to it as `<id>-r<round>.md`. The final checks run only when a step worked in the real repo. Steps run
  with `PI_OFFLINE=1` (no startup network work).
- **A step that never ran stops the run:** if pi exits before its first turn (an unknown model, a crash at
  start), the outcome is "error" with pi's message, and no later step gets its empty output.

The loop is only as good as its reviewer: a gap the reviewer misses is never fixed.

## Use

- `/loop [--rounds N] [--minutes N] [--implementer M] [--reviewer M] [--no-gates] <task>`; the options
  change one run. A word alone (`/loop config`, `/loop status`, `/loop stop`) is a subcommand;
  `/loop config the logger…` is a task.
- From a shell, in the repository: `node src/loop/cli.ts --task-file task.md` (from this package), progress
  on stderr, the report on stdout, exit 0 only for a pass with passing checks.

## Configure

On by default. `/flow` needs nothing else, since each workflow names its own models. `/loop`'s built-in review
loop needs the two models named in `tacklebox.json`; everything else has a default (`"enabled": false` turns
both commands off):

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
`ollama/beam:cloud:medium` works. Every model a run would use is checked against pi's models before it starts:
it must be an exact `provider/id`, or a bare id only one provider has. pi alone would also take a partial name
and quietly pick a model (`gpt-oss` gets the local 20B, not `gpt-oss:120b-cloud`), so the loop refuses those
and suggests the full names. `tools: []` means pi's defaults. Give the implementer a model that edits
reliably and the reviewer one that reads carefully; a fast model that loops on edits won't get far.

## Workflows

The loop above is the built-in workflow `review-loop`. A workflow is a list of nodes run by code; `/loop`
runs `loop.workflow` (default `review-loop`), and `/loop --workflow NAME <task>` runs another. `/loop workflows`
lists them. Built in: `review-loop`, and `review` (review the uncommitted work already in the repo, on a copy,
and stop at the verdict).

```json
"loop": {
  "workflows": {
    "two-tries": {
      "description": "Two models try the task side by side; the main model compares the patches",
      "nodes": [
        { "id": "a", "agent": "implementer", "workspace": "own", "prompt": "{task}" },
        { "id": "b", "agent": "lmstudio/qwen/qwen3.8-27b:off", "workspace": "own", "prompt": "{task}", "after": [] },
        { "id": "pick", "agent": "main", "role": "helper", "after": ["a", "b"],
          "prompt": "Two attempts at this task: {task}\nA: {a.patch}\nB: {b.patch}\nRead both patches and say which is better and why." }
      ]
    }
  }
}
```

- **Nodes:** `agent` (a step), `checks` (commands the code runs) or `repeat` (rounds of a body list).
- **Order:** a node runs after the node listed before it, unless `after` names others (earlier nodes in the
  same list only) or is `[]`. Nodes whose dependencies are done run in parallel; a stop anywhere keeps later
  nodes from starting.
- **`agent`:** `implementer` and `reviewer` (the models above), `main` (the conversation's model, inside pi),
  or any pi model pattern. `role` (`implementer`, `reviewer`, `helper`) picks the instructions; by default
  the reviewer gets the reviewer's, the implementer the implementer's, anything else a helper's.
- **`workspace`:** `repo` (the real repo; default), `copy` (a throwaway copy: default for reviewers), `own` (a
  private copy whose changes are kept as a patch for later steps, `{id.patch}`; the repo is left alone). A copy
  starts with the repo's uncommitted work; an `own` patch holds only what the step changed on top of that (none
  if it changed nothing). A step that only writes text (a story, an answer) needs `copy`, not `own`.
- **Prompts:** `{task}`, `{round}`, `{again}` (a note for later review rounds), `{id}` (a step's last output,
  or what a checks node printed: its start and end when over 30,000 characters), `{id.file}` (the file that
  output was saved in, `<id>-r<round>.md` or `.txt` in the run folder: a step whose context gets compacted can
  read it again), `{id.patch}`.
- **Steps that must deliver:** a step that ends without writing an answer (all thinking, or cut off at its output
  limit) is asked once more for it; still empty, it stops the run when a later step uses its output, rather than
  hand that step nothing. `verdict: true` (default for reviewers) means a VERDICT line is required: none,
  even when asked again, stops the run; a clean one ends the surrounding `repeat`. `progress: true` means the
  step must change the repo, or the run stops with "no progress".
- **`checks`:** `"gates"` (the configured commands) or a list; `onFail: { "fix": "<agent node>", "times": N }`
  sends failures back to that step, and `stopOnFail: true` stops the run if they still fail. A command can use
  `{task}` and `{round}`, each passed as one shell-quoted word, and nothing else: no model's output is put into a
  command. So a setup that later steps rely on (`setup.sh {task}`) is a checks node with `stopOnFail`, not an
  agent asked to run it: code runs it exactly, and its output reaches the others as `{setup}`. A setup that makes
  a directory for the work (a worktree, a checkout) can move the run there: give the first node `setsCwd: true`
  and have it print `LOOP_CWD=<absolute path>` (the last such line counts). Every later step, check, copy and
  the final checks then work in that directory instead of where pi started, so a relative path reads the right
  code. No such line, a path that isn't an absolute directory, or a failed command stops the run before any
  step starts; only the first node can set it, and no other node may start beside it (`after: []`).
- **`repeat`:** `{ "id", "repeat": [...], "until": "clean", "max": N }` (default `maxRounds`).

A workflow that changes no code (a review, a text) can say `"gates": false` next to its `nodes`: the final checks
don't run, as with `--no-gates`, and a `checks: "gates"` step in it is refused.

Every agent step gets the same limits, steers, sessions and speeds as the loop. A workflow in tacklebox.json is
checked when the loop loads, and a mistake is named (`loop.workflows.two-tries: "b": after "x", which isn't an
earlier node in the same list`).

## /flow: a workflow for one run

`/flow <what you want>` asks the conversation's model to draft a workflow in the format above and hand it to the
`flow_run` tool. The tool checks it (a broken one goes back to the model with each problem named), then asks you:
**Run**, **Edit** (the JSON, in pi's editor, checked again) or **Cancel**. Only a run you approve starts, in the
background like `/loop`, with the same limits and report. The model plans; code runs, so the report says what
happened, not the model.

`/flow save NAME` adds the last workflow that ran to `tacklebox.json` (`loop.workflows.NAME`); after that,
`/loop --workflow NAME <task>` runs it again. Built-in names can't be reused.

For example: `/flow beam and qwen each try this in their own copy, at the same time; then you compare the two
patches and tell me which is better: add a --dry-run flag to the deploy script`.

The `flow_run` tool is offered to the model only while `/flow` is being planned: it is hidden when a session
starts, added when you type `/flow`, and hidden again when that reply ends, so other requests don't carry it.
Each step's own pi process skips the loop extension entirely (the loop marks it with `PI_TACKLEBOX_LOOP_STEP`),
so a step can't start a loop of its own.
