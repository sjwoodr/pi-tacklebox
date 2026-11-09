/**
 * Workflows: agent steps, checks and repeats, wired by `after`, run by code. The built-in review loop is one;
 * tacklebox.json can name more, and /flow has the main model draft one for a single run.
 *
 *   { "nodes": [
 *     { "id": "a", "agent": "implementer", "prompt": "{task}" },                       // after the previous node
 *     { "id": "b", "agent": "ollama/beam:cloud:medium", "prompt": "Do Y", "after": [] },  // starts at once, beside a
 *     { "id": "z", "agent": "main", "after": ["a", "b"], "prompt": "Combine {a} and {b}" },
 *     { "id": "rounds", "max": 3, "until": "clean", "repeat": [ ...review, fix, checks... ] }
 *   ] }
 *
 * A node runs after the node listed before it, unless `after` names others (only earlier nodes in the same list)
 * or is empty; nodes whose dependencies are done run in parallel. `agent` is a role (implementer, reviewer, main)
 * or a pi model pattern. Prompts use {task}, {round}, {again} (a note for later review rounds), the last output of
 * any agent or checks node as {id}, the file it was saved in as {id.file}, and an own-workspace node's patch file as
 * {id.patch}. A checks command can use {task} and {round} (shell-quoted), and nothing else: no model's output is ever
 * put into a command.
 *
 * Every agent step runs with the step limits of runStep: warned, steered firmly at its limit, aborted only if it
 * ignores both, killed only if pi is stuck, its session kept.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type GateResult, runGates } from './gates.ts';
import { HELPER_ROLE, IMPLEMENTER_ROLE, REVIEWER_ROLE, VERDICT_ASK, WARNING, WRAP_UP_INSIST, gateFixPrompt } from './prompts.ts';
import { type LoopEvent, type LoopReport, type Outcome, type Role, type StepRecord, renderReport, withoutThinking } from './report.ts';
import { makeReviewCopy, workFingerprint } from './review-copy.ts';
import type { LoopConfig, RoleConfig } from './settings.ts';
import { runStep } from './step.ts';
import { isClean, parseVerdict } from './verdict.ts';

export type Workspace = 'repo' | 'copy' | 'own';

export interface AgentNode {
  id: string;
  after?: string[];
  /** implementer, reviewer, main, or a pi model pattern ("ollama/beam:cloud:medium"). */
  agent: string;
  prompt: string;
  /** Whose instructions it gets; by default reviewer for the reviewer, implementer for the implementer, else helper. */
  role?: Role;
  /** repo (the real one), copy (a throwaway copy: read-only in effect), own (a private copy whose changes are kept as a patch). */
  workspace?: Workspace;
  /** How the step is shown; may use {round}. Defaults to the id. */
  label?: string;
  /** For the report and for compatibility (implement, review, apply); defaults to agent. */
  kind?: string;
  /** The step must end with a VERDICT line (default for the reviewer role); in a repeat, a clean one ends it. */
  verdict?: boolean;
  /** A step meant to change the repo: if it changes nothing, the run stops with "no progress". */
  progress?: boolean;
  tools?: string[];
  maxTurns?: number;
  maxMinutes?: number;
}

export interface ChecksNode {
  id: string;
  after?: string[];
  /** "gates" for the configured commands, or a list of shell commands. */
  checks: 'gates' | string[];
  /** On failure, run this agent node again with the failures, up to `times` (default gateRetries). */
  onFail?: { fix: string; times?: number };
  /** If the checks still fail, stop the run (a setup step that later steps can't do without). */
  stopOnFail?: boolean;
}

export interface RepeatNode {
  id: string;
  after?: string[];
  repeat: WorkflowNode[];
  /** Rounds (default maxRounds). */
  max?: number;
  /** Stop when a verdict step in the body is clean. */
  until: 'clean';
}

export type WorkflowNode = AgentNode | ChecksNode | RepeatNode;

export interface Workflow {
  description?: string;
  nodes: WorkflowNode[];
}

const isAgent = (n: WorkflowNode): n is AgentNode => 'agent' in n;
const isChecks = (n: WorkflowNode): n is ChecksNode => 'checks' in n;
const isRepeat = (n: WorkflowNode): n is RepeatNode => 'repeat' in n;

export const REVIEW_PROMPT = 'Review the uncommitted changes in this repository against the TASK below.{again}\n\nTASK:\n{task}';
export const APPLY_PROMPT =
  'A reviewer checked your work. Check each finding against the code before acting: fix the real problems, ' +
  'and say which findings you did not act on and why. Change only what the review and the task call for.' +
  '\n\nREVIEW:\n{review}\n\nTASK:\n{task}';

/** The built-in workflows; tacklebox.json can add more, or replace these by name. */
export const BUILT_IN: Record<string, Workflow> = {
  'review-loop': {
    description: 'Implement, run the checks, then review a throwaway copy and fix until the review is clean.',
    nodes: [
      { id: 'implement', agent: 'implementer', kind: 'implement', label: 'implement', prompt: '{task}' },
      { id: 'checks', checks: 'gates', onFail: { fix: 'implement' } },
      {
        id: 'rounds', until: 'clean',
        repeat: [
          { id: 'review', agent: 'reviewer', kind: 'review', label: 'review {round}', prompt: REVIEW_PROMPT },
          { id: 'fix', agent: 'implementer', kind: 'apply', label: 'fix review {round}', progress: true, prompt: APPLY_PROMPT },
          { id: 'fix-checks', checks: 'gates', onFail: { fix: 'fix' } },
        ],
      },
    ],
  },
  review: {
    description: 'Review the uncommitted work already in the repo, on a throwaway copy, and stop at the verdict.',
    nodes: [{ id: 'review', agent: 'reviewer', kind: 'review', label: 'review', prompt: REVIEW_PROMPT }],
  },
};

const ID = /^[a-z][a-z0-9-]*$/;
/** A variable in a prompt: {name}, {name.patch} or {name.file}. */
const VAR = /\{([a-z][a-z0-9-]*)(\.patch|\.file)?\}/g;
/** A variable in a checks command; ${name} is the shell's, left alone. */
const COMMAND_VAR = /(?<!\$)\{([a-z][a-z0-9-]*)\}/g;

/** A value as one shell word. */
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const ROLES = new Set(['implementer', 'reviewer', 'helper']);
const WORKSPACES = new Set(['repo', 'copy', 'own']);

/** Problems with a workflow, in words; empty when it can run. `mainModel` says whether "main" can be used. */
export function validateWorkflow(raw: unknown, opts: { mainModel?: boolean } = {}): string[] {
  const errors: string[] = [];
  const w = raw as Workflow;
  if (!w || typeof w !== 'object' || !Array.isArray(w.nodes) || !w.nodes.length) return ['a workflow needs a non-empty "nodes" list'];
  const all = new Map<string, WorkflowNode>();
  const collect = (nodes: unknown[], where: string) => {
    for (const [i, raw] of nodes.entries()) {
      const n = raw as WorkflowNode;
      const at = `${where}[${i}]`;
      if (!n || typeof n !== 'object') { errors.push(`${at}: not an object`); continue; }
      const kinds = ['agent', 'checks', 'repeat'].filter((k) => k in n);
      if (kinds.length !== 1) { errors.push(`${at}: needs exactly one of "agent", "checks" or "repeat"`); continue; }
      if (typeof n.id !== 'string' || !ID.test(n.id)) { errors.push(`${at}: "id" must be lowercase letters, digits and dashes`); continue; }
      if (all.has(n.id)) errors.push(`${at}: duplicate id "${n.id}"`);
      all.set(n.id, n);
      if (isRepeat(n)) {
        if (!Array.isArray(n.repeat) || !n.repeat.length) errors.push(`"${n.id}": "repeat" needs a non-empty list`);
        else collect(n.repeat, `${n.id}.repeat`);
      }
    }
  };
  collect(w.nodes, 'nodes');
  const vars = (s: string) => [...s.matchAll(VAR)];
  const check = (nodes: WorkflowNode[], scope: string[]) => {
    const seen: string[] = [];
    for (const n of nodes) {
      if (n.after !== undefined) {
        if (!Array.isArray(n.after)) errors.push(`"${n.id}": "after" must be a list of ids`);
        else for (const a of n.after) if (!seen.includes(a)) errors.push(`"${n.id}": after "${a}", which isn't an earlier node in the same list`);
      }
      if (isAgent(n)) {
        if (typeof n.agent !== 'string' || !n.agent) errors.push(`"${n.id}": "agent" must be implementer, reviewer, main or a model pattern`);
        else if (!['implementer', 'reviewer', 'main'].includes(n.agent) && !n.agent.includes('/'))
          errors.push(`"${n.id}": agent "${n.agent}" is not a role (implementer, reviewer, main) or a model pattern (provider/model)`);
        else if (n.agent === 'main' && !opts.mainModel) errors.push(`"${n.id}": "main" needs a main model, which only /loop and /flow inside pi have`);
        if (typeof n.prompt !== 'string' || !n.prompt.trim()) errors.push(`"${n.id}": "prompt" must be a non-empty string`);
        else for (const [, name, suffix] of vars(n.prompt)) {
          if (['task', 'round', 'again'].includes(name) && !suffix) continue;
          const ref = all.get(name);
          if (!ref || isRepeat(ref)) errors.push(`"${n.id}": the prompt uses {${name}${suffix ?? ''}}, but there is no agent or checks node "${name}" (braces are only for variables; write <${name}> for a placeholder)`);
          else if (suffix === '.patch' && !(isAgent(ref) && ref.workspace === 'own')) errors.push(`"${n.id}": {${name}.patch} needs "${name}" to be an agent node with "workspace": "own"`);
        }
        if (n.role !== undefined && !ROLES.has(n.role)) errors.push(`"${n.id}": "role" must be implementer, reviewer or helper`);
        if (n.workspace !== undefined && !WORKSPACES.has(n.workspace)) errors.push(`"${n.id}": "workspace" must be repo, copy or own`);
        for (const k of ['maxTurns', 'maxMinutes'] as const)
          if (n[k] !== undefined && !(typeof n[k] === 'number' && n[k]! > 0)) errors.push(`"${n.id}": "${k}" must be a positive number`);
        if (n.tools !== undefined && !(Array.isArray(n.tools) && n.tools.every((t) => typeof t === 'string'))) errors.push(`"${n.id}": "tools" must be a list of names`);
      } else if (isChecks(n)) {
        if (n.checks !== 'gates' && !(Array.isArray(n.checks) && n.checks.length && n.checks.every((c) => typeof c === 'string')))
          errors.push(`"${n.id}": "checks" must be "gates" or a list of commands`);
        else if (Array.isArray(n.checks))
          for (const c of n.checks)
            for (const [, name] of c.matchAll(COMMAND_VAR))
              if (all.has(name)) errors.push(`"${n.id}": a command can't use {${name}}: only {task} and {round} go into a command, never a step's output`);
        if (n.stopOnFail !== undefined && typeof n.stopOnFail !== 'boolean') errors.push(`"${n.id}": "stopOnFail" must be true or false`);
        if (n.onFail) {
          const fix = all.get(n.onFail.fix);
          if (!fix || !isAgent(fix)) errors.push(`"${n.id}": onFail.fix "${n.onFail.fix}" is not an agent node`);
          if (n.onFail.times !== undefined && !(Number.isInteger(n.onFail.times) && n.onFail.times >= 0)) errors.push(`"${n.id}": onFail.times must be a whole number`);
        }
      } else if (isRepeat(n)) {
        if (n.until !== 'clean') errors.push(`"${n.id}": "until" must be "clean"`);
        if (n.max !== undefined && !(Number.isInteger(n.max) && n.max >= 1 && n.max <= 10)) errors.push(`"${n.id}": "max" must be 1 to 10`);
        const hasVerdict = (nodes: WorkflowNode[]): boolean =>
          nodes.some((c) => (isAgent(c) && (c.verdict ?? (c.role ?? (c.agent === 'reviewer' ? 'reviewer' : '')) === 'reviewer')) || (isRepeat(c) && hasVerdict(c.repeat)));
        if (Array.isArray(n.repeat) && !hasVerdict(n.repeat)) errors.push(`"${n.id}": a repeat until clean needs a step with a verdict: give the checking step "verdict": true, or use "agent": "reviewer"`);
        if (Array.isArray(n.repeat)) check(n.repeat, [...scope, n.id]);
      }
      seen.push(n.id);
    }
  };
  if (!errors.length) check(w.nodes, []);
  return errors;
}

/** A workflow in a few lines, for a confirmation dialog. */
export function describeWorkflow(w: Workflow, cfg: LoopConfig, mainModel?: string): string {
  const who = (a: string) => (a === 'implementer' ? `implementer (${cfg.implementer.model})` : a === 'reviewer' ? `reviewer (${cfg.reviewer.model})` : a === 'main' ? `main (${mainModel ?? '?'})` : a);
  const lines: string[] = [];
  const walk = (nodes: WorkflowNode[], indent: string) => {
    nodes.forEach((n, i) => {
      const after = n.after === undefined ? (i ? '' : '') : n.after.length ? ` after ${n.after.join(', ')}` : ' (at once)';
      if (isAgent(n)) lines.push(`${indent}${n.id}: ${who(n.agent)}${n.workspace && n.workspace !== 'repo' ? `, ${n.workspace} workspace` : ''}${after}: ${n.prompt.replace(/\s+/g, ' ').slice(0, 90)}`);
      else if (isChecks(n)) lines.push(`${indent}${n.id}: checks ${n.checks === 'gates' ? cfg.gates.join(' && ') || '(none)' : n.checks.join(' && ')}${n.onFail ? `, failures back to ${n.onFail.fix}` : ''}${n.stopOnFail ? ', the run stops if they fail' : ''}${after}`);
      else {
        lines.push(`${indent}${n.id}: repeat up to ${n.max ?? cfg.maxRounds} rounds until clean${after}:`);
        walk(n.repeat, indent + '  ');
      }
    });
  };
  walk(w.nodes, '');
  return lines.join('\n');
}

export interface RunOptions {
  workflow: Workflow;
  /** The workflow's name for the report: review-loop, a named one, or flow. */
  name: string;
  task: string;
  cwd: string;
  config: LoopConfig;
  /** The model pattern behind agent "main" (the conversation's model). */
  mainModel?: string;
  piCommand?: string[];
  signal?: AbortSignal;
  onEvent?: (e: LoopEvent) => void;
  runId?: string;
}

type Signal = { kind: 'ok' } | { kind: 'skip' } | { kind: 'clean'; round: number } | { kind: 'final'; round: number } | { kind: 'stop'; outcome: Outcome; detail: string };

/** A model pi knows: provider and id, as its model registry lists them. */
export interface KnownModel {
  provider: string;
  id: string;
}

/**
 * Every model a workflow would run, checked against pi's models before anything starts. A pattern must name one
 * model exactly ("provider/id" or a bare id only one provider has), with an optional thinking level: pi itself
 * also takes partial names, and quietly picks one ("gpt-oss" got the local 20B, not the 120B cloud model).
 */
export function checkModels(workflow: Workflow, cfg: LoopConfig, mainModel: string | undefined, known: KnownModel[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  const check = (where: string, pattern: string) => {
    if (!pattern) {
      if (where === 'implementer' || where === 'reviewer') errors.push(`${where}: no model set (loop.${where}.model in tacklebox.json); name a model in the step instead`);
      return;
    }
    const p = withoutThinking(pattern);
    if (seen.has(p)) return;
    seen.add(p);
    if (known.some((m) => `${m.provider}/${m.id}` === p)) return;
    const byId = known.filter((m) => m.id === p);
    if (byId.length === 1) return;
    if (byId.length > 1) {
      errors.push(`${where}: "${pattern}" is in more than one provider; name one: ${byId.map((m) => `${m.provider}/${m.id}`).join(', ')}`);
      return;
    }
    const word = p.slice(p.lastIndexOf('/') + 1).split(':')[0].toLowerCase();
    const near = known.filter((m) => `${m.provider}/${m.id}`.toLowerCase().includes(word)).slice(0, 5).map((m) => `${m.provider}/${m.id}`);
    errors.push(`${where}: pi has no model "${pattern}"${near.length ? `; did you mean ${near.join(', ')}?` : ' (pi --list-models lists them)'}`);
  };
  const walk = (nodes: WorkflowNode[]) => {
    for (const n of nodes) {
      if (isRepeat(n)) walk(n.repeat);
      else if (isAgent(n)) {
        if (n.agent === 'implementer') check('implementer', cfg.implementer.model);
        else if (n.agent === 'reviewer') check('reviewer', cfg.reviewer.model);
        else if (n.agent === 'main') { if (mainModel) check('main', mainModel); }
        else check(`"${n.id}"`, n.agent);
      }
    }
  };
  walk(workflow.nodes);
  return errors;
}

/** The last line pi wrote to stderr, for a step that failed before it started. */
const lastLine = (text: string) => text.trim().split('\n').filter((l) => l.trim()).at(-1)?.trim().slice(0, 300);

export async function runWorkflow(o: RunOptions): Promise<LoopReport> {
  const cfg = o.config;
  const errors = validateWorkflow(o.workflow, { mainModel: !!o.mainModel });
  if (errors.length) throw new Error(`workflow "${o.name}": ${errors.join('; ')}`);
  const started = Date.now();
  const deadline = started + cfg.maxTotalMinutes * 60_000;
  const runId = o.runId ?? `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${randomBytes(2).toString('hex')}`;
  const sessionDir = join(cfg.sessionsRoot, runId);
  mkdirSync(sessionDir, { recursive: true });
  const emit = (e: LoopEvent) => o.onEvent?.(e);
  emit({ kind: 'start', runId, sessionDir, workflow: o.name });

  const steps: StepRecord[] = [];
  const outputs = new Map<string, string>();
  const patches = new Map<string, string>();
  /** Where each node's last output was saved, for {id.file}. */
  const files = new Map<string, string>();
  const nodesById = new Map<string, WorkflowNode>();
  const index = (nodes: WorkflowNode[]) => nodes.forEach((n) => { nodesById.set(n.id, n); if (isRepeat(n)) index(n.repeat); });
  index(o.workflow.nodes);
  let lastReview: string | undefined;
  /** Whether any step worked in the real repo; if none did, there is nothing for the final checks to check. */
  let touchedRepo = false;
  let halted: Signal | undefined;
  let result: { outcome: Outcome; detail: string } | undefined;
  const aborted = () => o.signal?.aborted ?? false;
  const minutesLeft = () => (deadline - Date.now()) / 60_000;
  const outOfTime = (): Signal => aborted()
    ? { kind: 'stop', outcome: 'aborted', detail: 'stopped by the user' }
    : { kind: 'stop', outcome: 'time budget', detail: `the ${cfg.maxTotalMinutes}-minute total ran out` };

  const render = (template: string, round: number) =>
    template.replace(VAR, (whole, name: string, suffix?: string) => {
      if (name === 'task' && !suffix) return o.task;
      if (name === 'round' && !suffix) return String(round);
      if (name === 'again' && !suffix) return round > 1 ? ` This is review round ${round}: earlier reviews have been applied, so judge the code as it is now.` : '';
      if (suffix === '.patch') return patches.get(name) ?? '(no patch)';
      if (suffix === '.file') return files.get(name) ?? '(no file)';
      return outputs.get(name) ?? whole;
    });
  /** A checks command with {task} and {round} filled in, each as one shell word. */
  const renderCommand = (command: string, round: number) =>
    command.replace(COMMAND_VAR, (whole, name: string) => (name === 'task' ? shellQuote(o.task) : name === 'round' ? String(round) : whole));

  const resolve = (n: AgentNode): { rc: RoleConfig; role: Role } => {
    const role: Role = n.role ?? (n.agent === 'reviewer' ? 'reviewer' : n.agent === 'implementer' ? 'implementer' : 'helper');
    const base = n.agent === 'reviewer' || role === 'reviewer' ? cfg.reviewer : cfg.implementer;
    const model = n.agent === 'implementer' ? cfg.implementer.model : n.agent === 'reviewer' ? cfg.reviewer.model : n.agent === 'main' ? o.mainModel! : n.agent;
    return {
      role,
      rc: { model, tools: n.tools ?? (n.agent === 'main' ? [] : base.tools), maxTurns: n.maxTurns ?? base.maxTurns, maxMinutes: n.maxMinutes ?? base.maxMinutes },
    };
  };

  /** One agent step: its workspace, limits, verdict and progress checks. */
  const runAgent = async (n: AgentNode, round: number, prompt: string, overrides: { kind?: string; label?: string; workspace?: Workspace } = {}): Promise<Signal> => {
    if (aborted() || minutesLeft() < 1) return outOfTime();
    const { rc, role } = resolve(n);
    const kind = overrides.kind ?? n.kind ?? 'agent';
    const label = overrides.label ?? render(n.label ?? n.id, round);
    const workspace = overrides.workspace ?? n.workspace ?? (role === 'reviewer' ? 'copy' : 'repo');
    const wantsVerdict = n.verdict ?? role === 'reviewer';
    const stepN = nextStep++;
    running.add(n.id);
    const name = `pi-loop ${runId} #${stepN} ${label}`;
    emit({ kind: 'step-start', step: { n: stepN, id: n.id, round, role, kind, label, name, model: rc.model } });
    const copy = workspace === 'repo' ? undefined : makeReviewCopy(o.cwd, `${n.id}-r${round}`);
    if (!copy) touchedRepo = true;
    const cwd = copy?.path ?? o.cwd;
    // The copy starts with the repo's uncommitted work (and a node_modules link): an own step's patch is what
    // the step changed on top of that, so record where it started.
    let baseTree: string | undefined;
    if (copy && workspace === 'own') {
      try {
        execFileSync('git', ['add', '-A'], { cwd: copy.path, stdio: 'pipe' });
        baseTree = execFileSync('git', ['write-tree'], { cwd: copy.path, stdio: 'pipe' }).toString().trim();
      } catch {
        // no base: the patch falls back to HEAD
      }
    }
    const before = n.progress && workspace === 'repo' && kind !== 'gate-fix' ? workFingerprint(o.cwd) : undefined;
    const instructions = role === 'reviewer' ? REVIEWER_ROLE(rc) : role === 'implementer' ? IMPLEMENTER_ROLE(rc) : HELPER_ROLE(rc);
    const run = () =>
      runStep({
        cwd, model: rc.model, sessionDir, piCommand: o.piCommand, signal: o.signal, name, tools: rc.tools, prompt,
        appendSystemPrompt: instructions,
        limits: { maxTurns: rc.maxTurns, maxMinutes: Math.min(rc.maxMinutes, minutesLeft()) },
        startupSeconds: cfg.startupSeconds,
        warning: WARNING(role),
        finalAsk: WRAP_UP_INSIST(role),
        askMinutes: cfg.wrapUpMinutes,
        followUpFor: (text) => (wantsVerdict && parseVerdict(text).verdict === 'NONE' ? VERDICT_ASK : undefined),
        onProgress: (progress) => emit({ kind: 'step-progress', step: { n: stepN, id: n.id, round, role, kind, label }, progress }),
      });
    let main;
    let startupStalls = 0;
    try {
      // A pi that never answers at start (seen intermittently in headless runs) is killed and retried once.
      main = await run();
      if (main.stoppedBy === 'startup' && !aborted()) {
        startupStalls++;
        main = await run();
        if (main.stoppedBy === 'startup') startupStalls++;
      }
    } finally {
      running.delete(n.id);
    }
    const record: StepRecord = {
      n: stepN, id: n.id, round, role, kind, label, name, model: rc.model, turns: main.turns, ms: main.ms, stoppedBy: main.stoppedBy,
      wrappedUp: main.asks > 0, warned: main.warned, aborted: main.aborted, startupStalls, sessionId: main.sessionId,
      exitCode: main.exitCode, text: main.text,
      readTokens: main.readTokens, readMs: main.readMs, writeTokens: main.writeTokens, writeMs: main.writeMs,
    };
    // pi that exits before its first turn never ran the step: an unknown model, a crash at start.
    if (main.turns === 0 && !main.stoppedBy && !aborted())
      record.error = lastLine(main.stderrTail) ?? `pi exited (code ${main.exitCode}) before its first turn`;
    if (copy && workspace === 'own' && !record.error) {
      const file = join(sessionDir, `${n.id}-r${round}.patch`);
      try {
        execFileSync('git', ['add', '-A'], { cwd: copy.path, stdio: 'pipe' });
        const patch = execFileSync('git', ['diff', '--cached', '--binary', baseTree ?? 'HEAD'], { cwd: copy.path, maxBuffer: 64 * 1024 * 1024 });
        if (patch.length) {
          writeFileSync(file, patch);
          record.patchFile = file;
          patches.set(n.id, file);
        } else record.noChanges = true;
      } catch {
        // no patch: the report shows none
      }
    }
    copy?.remove();
    if (record.text.trim()) {
      record.outputFile = join(sessionDir, `${n.id}-r${round}${kind === 'gate-fix' ? '-fix' : ''}.md`);
      writeFileSync(record.outputFile, record.text.endsWith('\n') ? record.text : record.text + '\n');
      files.set(n.id, record.outputFile);
    }
    if (wantsVerdict) record.verdict = parseVerdict(record.text);
    steps.push(record);
    steps.sort((a, b) => a.n - b.n);
    outputs.set(n.id, record.text);
    emit({ kind: 'step-end', step: record });
    if (aborted()) return outOfTime();
    if (main.stoppedBy === 'startup') return { kind: 'stop', outcome: 'error', detail: `${label}: pi didn't start, twice` };
    if (record.error) return { kind: 'stop', outcome: 'error', detail: `${label} didn't run: ${record.error}` };
    if (before !== undefined && workFingerprint(o.cwd) === before)
      return { kind: 'stop', outcome: 'no progress', detail: `round ${round}: ${label} changed nothing` };
    if (record.verdict) {
      lastReview = record.text;
      // Never hand the next step a "review" with no verdict: it has nothing to act on.
      if (record.verdict.verdict === 'NONE') return { kind: 'stop', outcome: 'no verdict', detail: `round ${round}: ${label} gave no VERDICT line, even when asked again` };
      if (isClean(record.verdict)) return { kind: 'clean', round };
      if (round > 0 && round === currentMax) return { kind: 'final', round };
    }
    return { kind: 'ok' };
  };

  /** Checks run by code; a failure goes back to the onFail agent with the output, up to `times`. */
  const runChecks = async (n: ChecksNode, round: number): Promise<Signal> => {
    if (aborted() || minutesLeft() < 1) return outOfTime();
    const commands = n.checks === 'gates' ? cfg.gates : n.checks.map((c) => renderCommand(c, round));
    const timeout = cfg.gateTimeoutMinutes * 60_000;
    let results: GateResult[] = await runGates(commands, o.cwd, timeout);
    emit({ kind: 'gates', round, results });
    if (steps.length) steps[steps.length - 1].gates = results;
    const fixNode = n.onFail ? (nodesById.get(n.onFail.fix) as AgentNode) : undefined;
    const times = n.onFail?.times ?? cfg.gateRetries;
    for (let i = 0; fixNode && i < times && results.some((g) => !g.ok); i++) {
      const sig = await runAgent(fixNode, round, gateFixPrompt(results, o.task), { kind: 'gate-fix', label: 'fix failed checks', workspace: 'repo' });
      if (sig.kind === 'stop') return sig;
      results = await runGates(commands, o.cwd, timeout);
      steps[steps.length - 1].gates = results;
      emit({ kind: 'gates', round, results });
    }
    // Later steps get what the commands printed as {id}, and the file it was saved in as {id.file}.
    const output = results.map((g) => (results.length > 1 ? `$ ${g.command}\n${g.output}` : g.output)).join('\n');
    const file = join(sessionDir, `${n.id}-r${round}.txt`);
    writeFileSync(file, output.endsWith('\n') ? output : output + '\n');
    outputs.set(n.id, output);
    files.set(n.id, file);
    const failed = results.find((g) => !g.ok);
    if (failed && n.stopOnFail)
      return { kind: 'stop', outcome: 'error', detail: `${n.id}: \`${failed.command}\` ${failed.timedOut ? 'timed out' : `failed (exit ${failed.exitCode})`}: ${lastLine(failed.tail) ?? 'no output'}` };
    return { kind: 'ok' };
  };

  const running = new Set<string>();
  let nextStep = 1;
  let currentMax = 0;

  /** A list of nodes: each waits for its `after` (default: the node before it); independent ones run together. */
  const runList = async (nodes: WorkflowNode[], round: number): Promise<Signal> => {
    const done = new Map<string, Promise<Signal>>();
    nodes.forEach((n, i) => {
      const deps = n.after ?? (i ? [nodes[i - 1].id] : []);
      done.set(n.id, Promise.all(deps.map((d) => done.get(d)!)).then(async (results): Promise<Signal> => {
        const stop = results.find((r) => r.kind === 'stop');
        if (stop) return stop;
        if (results.some((r) => r.kind !== 'ok')) return { kind: 'skip' };
        if (halted) return { kind: 'skip' };
        const sig = await runNode(n, round);
        if (sig.kind === 'stop') halted ??= sig;
        return sig;
      }));
    });
    const all = await Promise.all(nodes.map((n) => done.get(n.id)!));
    return all.find((r) => r.kind === 'stop') ?? all.find((r) => r.kind === 'clean') ?? all.find((r) => r.kind === 'final') ?? { kind: 'ok' };
  };

  const runNode = async (n: WorkflowNode, round: number): Promise<Signal> => {
    if (isAgent(n)) return runAgent(n, round, render(n.prompt, round));
    if (isChecks(n)) return runChecks(n, round);
    const max = n.max ?? cfg.maxRounds;
    for (let r = 1; r <= max; r++) {
      currentMax = max;
      const sig = await runList(n.repeat, r);
      if (sig.kind === 'stop') return sig;
      if (sig.kind === 'clean') {
        result = { outcome: 'passed', detail: `round ${r}: the reviewer passed it with nothing critical or high` };
        return { kind: 'ok' };
      }
      if (sig.kind === 'final' || r === max) {
        const last = [...steps].reverse().find((s) => s.verdict);
        result = { outcome: 'rounds used up', detail: `${max} review rounds; the last verdict was ${last?.verdict?.verdict ?? 'NONE'}` };
        return { kind: 'ok' };
      }
    }
    return { kind: 'ok' };
  };

  try {
    const sig = await runList(o.workflow.nodes, 0);
    if (sig.kind === 'stop') result = { outcome: sig.outcome, detail: sig.detail };
    else if (sig.kind === 'clean') result = { outcome: 'passed', detail: 'the reviewer passed it with nothing critical or high' };
    else if (sig.kind === 'final') result ??= { outcome: 'finished', detail: 'the review asked for changes' };
    const lastVerdict = [...steps].reverse().find((s) => s.verdict)?.verdict;
    result ??= lastVerdict
      ? { outcome: 'finished', detail: `the review says ${lastVerdict.verdict} (${lastVerdict.counts.critical} critical, ${lastVerdict.counts.high} high, ${lastVerdict.counts.minor} minor)` }
      : { outcome: 'finished', detail: `every step of ${o.name} ran` };
  } catch (err) {
    result = { outcome: 'error', detail: err instanceof Error ? err.message : String(err) };
  }

  const finalGatesSkipped = aborted() ? 'stopped' : !touchedRepo ? 'no step worked in the repo' : undefined;
  const finalGates = finalGatesSkipped ? [] : await runGates(cfg.gates, o.cwd, cfg.gateTimeoutMinutes * 60_000);
  const reportFile = join(sessionDir, 'report.md');
  const report: LoopReport = {
    runId, workflow: o.name, outcome: result.outcome, detail: result.detail, ms: Date.now() - started, steps, finalGates, finalGatesSkipped,
    lastReview, sessionDir, reportFile, markdown: '',
  };
  report.markdown = renderReport(report);
  writeFileSync(reportFile, report.markdown);
  emit({ kind: 'done', report });
  return report;
}
