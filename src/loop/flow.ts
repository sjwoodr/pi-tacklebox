/**
 * /flow <description>: the conversation's model drafts a workflow for one run and hands it to the flow_run tool,
 * which checks it and asks the user to run, edit or cancel it. Code runs it; the model only plans. /flow save NAME
 * keeps the last one that ran in tacklebox.json.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG, getAgentDir } from '../config.ts';
import type { LoopConfig } from './settings.ts';
import { BUILT_IN, type Workflow, validateWorkflow } from './workflow.ts';

/** A non-code example for the planner: the text lives in files in the repo, so each round sees the last. */
const TEXT_EXAMPLE = {
  description: 'One model corrects draft.md, another checks it, until the checker passes it',
  nodes: [
    { id: 'edit', agent: 'implementer', role: 'helper', workspace: 'repo',
      prompt: 'Correct draft.md in place: {task}. List each change and why in notes.md.' },
    { id: 'rounds', until: 'clean', max: 3, repeat: [
      { id: 'check', agent: 'reviewer', role: 'helper', verdict: true, workspace: 'copy',
        prompt: 'Check draft.md against: {task}. git diff HEAD shows the changes, notes.md the reasons. Do not edit files. Tag each problem [high] or [minor].' },
      { id: 'answer', agent: 'implementer', role: 'helper', workspace: 'repo',
        prompt: 'The checker wrote:\n{check}\nFix draft.md where it is right; where it is wrong, keep your version and say why in notes.md.' },
    ] },
  ],
};

/** What the conversation's model is asked to do with /flow. */
export function plannerPrompt(description: string, cfg: LoopConfig, mainModel?: string): string {
  return `Plan a workflow for pi-loop and hand it to the flow_run tool. Do not do the work yourself and do not call
any other tool: a program runs the workflow, with limits on every step, after the user approves it.

What the user wants:
${description}

A workflow is JSON: { "description": "...", "nodes": [ ... ] }, with "gates": false added when it changes no code
(a text, a review, research), so the project's tests don't run at the end. Each node is one of:
- an agent step: { "id": "a", "agent": "...", "prompt": "...", "workspace": "repo"|"copy"|"own", "after": [...] },
  optionally with "verdict": true, "role": "implementer"|"reviewer"|"helper", "label": "...", "maxTurns": N, "maxMinutes": N
- checks: { "id": "c", "checks": "gates" | ["shell command", ...], "onFail": { "fix": "<agent step id>" }, "stopOnFail": true, "setsCwd": true }
- a repeat: { "id": "r", "until": "clean", "max": 3, "repeat": [ ...nodes... ] }

Rules:
- ids: lowercase letters, digits and dashes, unique.
- A node runs after the node listed before it; "after": ["x", "y"] waits for those instead (earlier nodes in the
  same list only), and "after": [] starts at once. Nodes that don't wait for each other run in parallel.
- "agent": "implementer" (${cfg.implementer.model || 'not set: don\'t use it'}), "reviewer" (${cfg.reviewer.model || 'not set: don\'t use it'}), "main"
  (${mainModel ?? 'this conversation\'s model'}), or another model only if the user names one: its exact
  "provider/id" as \`pi --list-models\` shows it, optionally with ":off", ":low" etc. for thinking. Don't guess a
  provider; flow_run refuses a name pi doesn't have and suggests the right ones.
- "workspace": "repo" is the real directory: a step's edits there are what later steps and later rounds see (one
  writer at a time). "copy" is a throwaway copy of it, made when the step starts (uncommitted edits included) and
  deleted when it ends: for checking and reading; nothing a step does there survives, and it cannot reach the
  real files. "own" is a private copy whose changes become a patch ({id.patch}), for parallel attempts at code.
  So a step that must change files works in "repo"; never ask a "copy" step to edit the real files.
- To carry work from round to round, keep it in files in "repo" (the text, notes, a log): {id} is only a step's
  last reply. A step that only answers (a story, a summary) changes no files: use "copy", pass its reply on with
  {id}, and ask for the text itself in the reply. The user sees the last step's reply.
- Prompts can use {task} (the task below), {round}, {id} (a step's last reply, or what a checks step printed),
  {id.file} (the file that was saved in) and {id.patch} (an own step's patch file). Braces mean a variable and
  nothing else: for something a step should fill in, write <like this>.
- A checks command can use {task} and {round} (each passed as one quoted word) and no other variable. To prepare
  something every later step needs (fetch, set up, list files), use a checks step with "stopOnFail": true rather
  than asking a model to run a command: code runs it exactly, and its output reaches later steps as {id}. If that
  setup makes a directory the work must happen in (a worktree, a checkout), make it the first node with
  "setsCwd": true and have it print LOOP_CWD=<absolute path>: every later step then works there.
- A long step can lose its prompt's middle when its context is compacted: for a long input from an earlier step,
  give its {id.file} as well, so the step can read it again.
- "verdict": true makes a step end with a VERDICT line (PASS or CHANGES, findings tagged [critical], [high] or
  [minor]); "agent": "reviewer" has it already. A repeat "until": "clean" needs such a step, and stops when it
  passes. Any model can be the one that judges: give it "verdict": true.
- "role" picks a step's standing instructions. The implementer's and reviewer's are written for code (tests, type
  checks, git diff); for anything else (text, French, research) use "role": "helper". By default the implementer
  and reviewer get their own, and any other agent a helper's.
- "checks": "gates" runs the project's tests (${cfg.gates.join(' && ') || 'none configured'}).
- Keep it as small as the request allows.

For example, the built-in review loop (code) is:
${JSON.stringify(BUILT_IN['review-loop'])}

And a loop over a text file, where one model edits and another checks until it agrees:
${JSON.stringify(TEXT_EXAMPLE)}

Call flow_run with "task" (the job in plain words, used as {task}) and "workflow" (the JSON, as a string).`;
}

/** The workflow JSON a model sent: a string (possibly in a ```json fence) or an object. */
export function parseWorkflow(raw: unknown): { workflow?: Workflow; error?: string } {
  let value = raw;
  if (typeof raw === 'string') {
    const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    try {
      value = JSON.parse(text);
    } catch (err) {
      return { error: `the workflow is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { workflow: value as Workflow };
}

const NAME = /^[a-z][a-z0-9-]*$/;

/** Adds a workflow to tacklebox.json's loop.workflows under `name`, keeping everything else in the file. */
export function saveWorkflow(name: string, workflow: Workflow, dir = getAgentDir()): string {
  if (!NAME.test(name)) throw new Error('a workflow name is lowercase letters, digits and dashes');
  if (name in BUILT_IN) throw new Error(`"${name}" is a built-in workflow; pick another name`);
  const errors = validateWorkflow(workflow, { mainModel: true });
  if (errors.length) throw new Error(errors.join('; '));
  const file = join(dir, CONFIG);
  const config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  config.loop ??= {};
  config.loop.workflows ??= {};
  config.loop.workflows[name] = workflow;
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  return file;
}
