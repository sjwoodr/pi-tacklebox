---
name: loop
description: Runs an implement → review → fix loop on a coding task with two other models (an implementer and a read-only reviewer), with turn and time limits on every step and the project's tests run between steps. Use when the user asks for the review loop, /loop, or to have another model implement and review a task.
---

# loop

The loop runs in the current repository. The user normally starts it with the `/loop` command:

```
/loop [--rounds N] [--minutes N] [--implementer MODEL] [--reviewer MODEL] [--no-gates] <task>
```

`/loop status` shows progress, `/loop stop` stops it and `/loop config` shows the settings. The report
appears in the conversation when it ends, and is saved as `report.md` next to the run's sessions.

If the user asks you to start it yourself, write the task to a file and run the CLI in the background
with the `job_start` tool (it takes many minutes; never block on it in bash):

```
node <this skill's directory>/../../src/loop/cli.ts --task-file <file> [options]
```

What to tell the user about it:

- The implementer and reviewer are separate pi processes on their own models (the `loop` section of
  `tacklebox.json`); this conversation's model only starts it.
- The loop stops when the reviewer passes the work with nothing critical or high, after the round limit,
  when a fix changes nothing, or when the total time runs out. Every step keeps its session.
- Read the report before calling the work done: the loop's own test results are in it, and a reviewer
  can miss things.
