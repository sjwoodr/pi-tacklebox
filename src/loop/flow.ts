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

/** What the conversation's model is asked to do with /flow. */
export function plannerPrompt(description: string, cfg: LoopConfig, mainModel?: string): string {
  return `Plan a workflow for pi-loop and hand it to the flow_run tool. Do not do the work yourself and do not call
any other tool: a program runs the workflow, with limits on every step, after the user approves it.

What the user wants:
${description}

A workflow is JSON: { "description": "...", "nodes": [ ... ] }. Each node is one of:
- an agent step: { "id": "a", "agent": "...", "prompt": "...", "workspace": "repo"|"copy"|"own", "after": [...] }
- checks: { "id": "c", "checks": "gates" | ["shell command", ...], "onFail": { "fix": "<agent step id>" } }
- a repeat: { "id": "r", "until": "clean", "max": 3, "repeat": [ ...nodes... ] }

Rules:
- ids: lowercase letters, digits and dashes, unique.
- A node runs after the node listed before it; "after": ["x", "y"] waits for those instead (earlier nodes in the
  same list only), and "after": [] starts at once. Nodes that don't wait for each other run in parallel.
- "agent": "implementer" (${cfg.implementer.model}), "reviewer" (${cfg.reviewer.model}), "main"
  (${mainModel ?? 'this conversation\'s model'}), or another model only if the user names one: its exact
  "provider/id" as \`pi --list-models\` shows it, optionally with ":off", ":low" etc. for thinking. Don't guess a
  provider; flow_run refuses a name pi doesn't have and suggests the right ones.
- "workspace": "repo" changes the real repository (one writer at a time); "copy" is a throwaway copy (reviewers,
  read-only work); "own" is a private copy whose changes become a patch, for parallel attempts at code changes.
- A step that only writes text (a story, an answer, a summary, a review) changes no files: use "copy", pass its
  text on with {id}, and ask for the text itself in the reply. The user sees the last step's reply.
- Prompts can use {task} (the task below), {id} (a step's last output) and {id.patch} (an own step's patch file).
- A reviewer must end with a VERDICT line; a repeat "until": "clean" needs one, and stops when it passes.
- "checks": "gates" runs the project's tests (${cfg.gates.join(' && ') || 'none configured'}).
- Keep it as small as the request allows.

For example, the built-in review loop is:
${JSON.stringify(BUILT_IN['review-loop'])}

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
