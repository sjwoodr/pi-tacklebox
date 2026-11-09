/** What a workflow run produces: one record per agent step, the events while it runs, and report.md. */
import type { GateResult } from './gates.ts';
import { type Speeds, type StepProgress, type StepResult, addSpeeds } from './step.ts';
import type { Verdict } from './verdict.ts';

/** implementer and reviewer carry their instructions; helper is any other agent (a planner, a tester, "main"). */
export type Role = 'implementer' | 'reviewer' | 'helper';

export interface StepRecord extends Speeds {
  n: number;
  /** The workflow node that ran (a gate fix carries the id of the node it fixed). */
  id: string;
  round: number;
  role: Role;
  /** implement, gate-fix, review, apply (the built-in loop), or agent. */
  kind: string;
  /** What the step is, in words: "implement", "review 2", "fix review 2", "fix failed checks". */
  label: string;
  name: string;
  /** The model pattern the step ran on. */
  model: string;
  turns: number;
  ms: number;
  stoppedBy?: StepResult['stoppedBy'];
  wrappedUp: boolean;
  sessionId?: string;
  exitCode: number | null;
  text: string;
  verdict?: Verdict;
  gates?: GateResult[];
  /** The step was warned before its limit. */
  warned?: boolean;
  /** It ignored the firm steer at its limit too and was aborted. */
  aborted?: boolean;
  /** Times pi didn't start its session in time (the step was retried after the first). */
  startupStalls?: number;
  /** For a step in its own workspace: the patch of what it changed (none when it changed nothing). */
  patchFile?: string;
  /** An own-workspace step that changed no files. */
  noChanges?: boolean;
  /** The step's whole answer, saved in the run folder. */
  outputFile?: string;
  /** Why the step failed outright (pi exited before its first turn: an unknown model, a crash). */
  error?: string;
}

export type Outcome = 'passed' | 'finished' | 'rounds used up' | 'no progress' | 'no verdict' | 'time budget' | 'aborted' | 'error';

export interface LoopReport {
  runId: string;
  /** The workflow that ran: "review-loop", a named one, or "flow" for one drafted on the spot. */
  workflow: string;
  outcome: Outcome;
  detail: string;
  ms: number;
  steps: StepRecord[];
  finalGates: GateResult[];
  /** Why the final checks didn't run, when they didn't. */
  finalGatesSkipped?: string;
  lastReview?: string;
  sessionDir: string;
  reportFile: string;
  markdown: string;
}

type StepHead = Pick<StepRecord, 'n' | 'id' | 'round' | 'role' | 'kind' | 'label'>;

export type LoopEvent =
  | { kind: 'start'; runId: string; sessionDir: string; workflow: string }
  | { kind: 'step-start'; step: StepHead & Pick<StepRecord, 'name' | 'model'> }
  | { kind: 'step-progress'; step: StepHead; progress: StepProgress }
  | { kind: 'step-end'; step: StepRecord }
  | { kind: 'gates'; round: number; results: GateResult[] }
  | { kind: 'done'; report: LoopReport };

const THINKING = /:(off|minimal|low|medium|high|xhigh|max)$/;

/** A model pattern without its thinking level: "ollama/beam:cloud:medium" → "ollama/beam:cloud". */
export function withoutThinking(pattern: string): string {
  return pattern.replace(THINKING, '');
}

/** A model pattern made short for display: "ollama/beam:cloud:medium" → "beam:cloud". */
export function shortModel(pattern: string): string {
  const p = withoutThinking(pattern);
  return p.slice(p.lastIndexOf('/') + 1);
}

/** How much of the last step's answer the report shows; the whole answer is in its file. */
const OUTPUT_SHOWN = 6_000;

const min = (ms: number) => `${(ms / 60_000).toFixed(1)} min`;
const perSec = (tokens: number, ms: number) => (ms > 0 && tokens > 0 ? `${Math.round((tokens * 1000) / ms)}/s` : '-');

export function speedsOf(steps: StepRecord[]): Speeds {
  const s: Speeds = { readTokens: 0, readMs: 0, writeTokens: 0, writeMs: 0 };
  for (const r of steps) addSpeeds(s, r);
  return s;
}

export function renderReport(r: LoopReport): string {
  const lines: string[] = [];
  lines.push(`# pi-loop ${r.runId}`, '');
  lines.push(`**Outcome: ${r.outcome}** (${r.detail}). Workflow \`${r.workflow}\`, ${min(r.ms)}, ${r.steps.length} steps.`, '');
  const models = [...new Set(r.steps.map((s) => s.model))];
  if (models.length) lines.push(`Models: ${models.map((m) => `\`${m}\``).join(', ')}.`, '');
  lines.push('| step | what | turns | time | read | write | limit | session |', '|---|---|---|---|---|---|---|---|');
  for (const s of r.steps) {
    const limit = [
      s.error ? `FAILED: ${s.error}` : '',
      s.warned ? 'warned' : '',
      s.stoppedBy ? `${s.stoppedBy} limit${s.aborted ? ', aborted' : ''}${s.wrappedUp ? ', asked again' : ''}` : s.wrappedUp ? 'asked again' : '',
      s.startupStalls ? `${s.startupStalls} startup stall${s.startupStalls > 1 ? 's' : ''}` : '',
    ].filter(Boolean).join('; ');
    const v = s.verdict ? ` → ${s.verdict.verdict} (${s.verdict.counts.critical}c/${s.verdict.counts.high}h/${s.verdict.counts.minor}m)` : '';
    const g = !s.gates ? '' : !s.gates.length ? ' → no checks' : ` → checks ${s.gates.every((x) => x.ok) ? 'ok' : 'FAILED'}`;
    const p = s.patchFile ? ` → patch \`${s.patchFile}\`` : s.noChanges ? ' → no file changes' : '';
    lines.push(`| ${s.n} | ${s.label} (${shortModel(s.model)})${v}${g}${p} | ${s.turns} | ${min(s.ms)} | ${perSec(s.readTokens, s.readMs)} | ${perSec(s.writeTokens, s.writeMs)} | ${limit} | ${s.sessionId?.slice(-12) ?? ''} |`);
  }
  lines.push('');
  for (const role of ['implementer', 'reviewer', 'helper'] as const) {
    const mine = r.steps.filter((s) => s.role === role);
    if (!mine.length) continue;
    const sp = speedsOf(mine);
    lines.push(`- ${role}: read ${perSec(sp.readTokens, sp.readMs)}, write ${perSec(sp.writeTokens, sp.writeMs)}`);
  }
  const all = speedsOf(r.steps);
  lines.push(`- total: read ${perSec(all.readTokens, all.readMs)}, write ${perSec(all.writeTokens, all.writeMs)}`, '');
  lines.push('Final checks (run by the loop):');
  for (const g of r.finalGates) lines.push(`- \`${g.command}\`: ${g.ok ? 'passed' : g.timedOut ? 'TIMED OUT' : `FAILED (exit ${g.exitCode})`}`);
  if (!r.finalGates.length) lines.push(`- not run${r.finalGatesSkipped ? ` (${r.finalGatesSkipped})` : ''}`);
  lines.push('', `Sessions: \`${r.sessionDir}\` (open one with \`pi --session-dir <dir> --session <id>\`); each step's whole answer is in its \`.md\` file there.`);
  // The last step's answer is usually the result (a corrected text, a judgment); a review is shown once, below.
  const last = r.steps.at(-1);
  if (last?.text.trim() && last.text !== r.lastReview) {
    const cut = last.text.length > OUTPUT_SHOWN;
    lines.push('', `## Output: ${last.label} (${shortModel(last.model)})`, '', cut ? `${last.text.slice(0, OUTPUT_SHOWN)}\n\n(cut; the whole answer is in \`${last.outputFile}\`)` : last.text);
  }
  if (r.lastReview) lines.push('', '## Last review', '', r.lastReview);
  return lines.join('\n') + '\n';
}
