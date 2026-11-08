/**
 * The loop: implement, check, then up to maxRounds of review and fix. Code decides every step; no
 * model is asked what happened.
 *
 *   implement → gates (a failure goes straight back to the implementer, up to gateRetries times)
 *   round n: review a throwaway copy → clean? stop : apply the review → gates → no change? stop
 *
 * It stops when the reviewer passes the work with nothing critical or high, the rounds are used up,
 * an apply step changes nothing, or the total time runs out. Every step has its own turn and time
 * limits; a step that reaches one is resumed for a single tool-less wrap-up turn.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoopConfig, RoleConfig } from './settings.ts';
import { type GateResult, runGates } from './gates.ts';
import { IMPLEMENTER_ROLE, REVIEWER_ROLE, VERDICT_ASK, WARNING, WRAP_UP_INSIST, applyPrompt, gateFixPrompt, reviewPrompt } from './prompts.ts';
import { makeReviewCopy, workFingerprint } from './review-copy.ts';
import { type Speeds, type StepProgress, type StepResult, addSpeeds, runStep } from './step.ts';
import { type Verdict, isClean, parseVerdict } from './verdict.ts';

export type Role = 'implementer' | 'reviewer';
export type StepKind = 'implement' | 'gate-fix' | 'review' | 'apply';

/** What a step is, in words: "implement", "fix failed checks", "review 2", "fix review 2". */
export function stepLabel(kind: StepKind, round: number): string {
  if (kind === 'implement') return 'implement';
  if (kind === 'gate-fix') return 'fix failed checks';
  if (kind === 'review') return `review ${round}`;
  return `fix review ${round}`;
}

/** A model pattern made short for display: "ollama/beam:cloud:medium" → "beam:cloud". */
export function shortModel(pattern: string): string {
  const tail = pattern.slice(pattern.lastIndexOf('/') + 1);
  return tail.replace(/:(off|minimal|low|medium|high|xhigh|max)$/, '');
}

export interface StepRecord extends Speeds {
  n: number;
  round: number;
  role: Role;
  kind: StepKind;
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
  /** Times pi didn't start its session in time (the step was retried after the first). */
  startupStalls?: number;
}

export type Outcome = 'passed' | 'rounds used up' | 'no progress' | 'no verdict' | 'time budget' | 'aborted' | 'error';

export interface LoopReport {
  runId: string;
  outcome: Outcome;
  detail: string;
  ms: number;
  steps: StepRecord[];
  finalGates: GateResult[];
  lastReview?: string;
  sessionDir: string;
  reportFile: string;
  markdown: string;
}

export type LoopEvent =
  | { kind: 'start'; runId: string; sessionDir: string }
  | { kind: 'step-start'; step: Pick<StepRecord, 'n' | 'round' | 'role' | 'kind' | 'name' | 'model'> }
  | { kind: 'step-progress'; step: Pick<StepRecord, 'n' | 'round' | 'role' | 'kind'>; progress: StepProgress }
  | { kind: 'step-end'; step: StepRecord }
  | { kind: 'gates'; round: number; results: GateResult[] }
  | { kind: 'done'; report: LoopReport };

export interface LoopOptions {
  task: string;
  cwd: string;
  config: LoopConfig;
  piCommand?: string[];
  signal?: AbortSignal;
  onEvent?: (e: LoopEvent) => void;
  /** Overrides the generated run id (tests). */
  runId?: string;
}

export async function runLoop(o: LoopOptions): Promise<LoopReport> {
  const cfg = o.config;
  const started = Date.now();
  const deadline = started + cfg.maxTotalMinutes * 60_000;
  const runId = o.runId ?? `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${randomBytes(2).toString('hex')}`;
  const sessionDir = join(cfg.sessionsRoot, runId);
  mkdirSync(sessionDir, { recursive: true });
  const emit = (e: LoopEvent) => o.onEvent?.(e);
  emit({ kind: 'start', runId, sessionDir });

  const steps: StepRecord[] = [];
  let outcome: Outcome = 'rounds used up';
  let detail = '';
  let lastReview: string | undefined;
  const aborted = () => o.signal?.aborted ?? false;
  const minutesLeft = () => (deadline - Date.now()) / 60_000;

  /** Runs one role step with its limits, then a wrap-up turn if it was stopped. Null when out of time. */
  const step = async (role: Role, kind: StepKind, round: number, prompt: string, cwd: string): Promise<StepRecord | null> => {
    if (aborted()) return null;
    const left = minutesLeft();
    if (left < 1) return null;
    const rc: RoleConfig = cfg[role];
    const n = steps.length + 1;
    const name = `pi-loop ${runId} #${n} r${round} ${role} ${kind}`;
    emit({ kind: 'step-start', step: { n, round, role, kind, name, model: rc.model } });
    const common = { cwd, model: rc.model, sessionDir, piCommand: o.piCommand, signal: o.signal };
    // The warning and the asks happen inside the step's own pi process (RPC), so the conversation and the model
    // server's prompt cache stay warm and no half-sent request is left running.
    const needsVerdict = (text: string) => (role === 'reviewer' && parseVerdict(text).verdict === 'NONE' ? VERDICT_ASK : undefined);
    const run = () =>
      runStep({
        ...common, name, tools: rc.tools, prompt,
        appendSystemPrompt: role === 'implementer' ? IMPLEMENTER_ROLE(rc) : REVIEWER_ROLE(rc),
        limits: { maxTurns: rc.maxTurns, maxMinutes: Math.min(rc.maxMinutes, minutesLeft()) },
        startupSeconds: cfg.startupSeconds,
        warning: WARNING(role),
        finalAsk: WRAP_UP_INSIST(role),
        askMinutes: cfg.wrapUpMinutes,
        followUpFor: needsVerdict,
        onProgress: (progress) => emit({ kind: 'step-progress', step: { n, round, role, kind }, progress }),
      });
    // A pi that never answers at start (seen intermittently in headless runs) is killed and retried once.
    let main = await run();
    let startupStalls = 0;
    if (main.stoppedBy === 'startup' && !aborted()) {
      startupStalls++;
      main = await run();
      if (main.stoppedBy === 'startup') startupStalls++;
    }
    const record: StepRecord = {
      n, round, role, kind, name, model: rc.model, turns: main.turns, ms: main.ms, stoppedBy: main.stoppedBy, wrappedUp: main.asks > 0,
      warned: main.warned, startupStalls, sessionId: main.sessionId, exitCode: main.exitCode, text: main.text,
      readTokens: main.readTokens, readMs: main.readMs, writeTokens: main.writeTokens, writeMs: main.writeMs,
    };
    if (role === 'reviewer') record.verdict = parseVerdict(record.text);
    steps.push(record);
    emit({ kind: 'step-end', step: record });
    return record;
  };

  /** Runs the gates; a failure goes back to the implementer up to gateRetries times. */
  const gated = async (round: number): Promise<GateResult[] | null> => {
    const timeout = cfg.gateTimeoutMinutes * 60_000;
    let results = await runGates(cfg.gates, o.cwd, timeout);
    emit({ kind: 'gates', round, results });
    steps[steps.length - 1].gates = results;
    for (let i = 0; i < cfg.gateRetries && results.some((g) => !g.ok); i++) {
      const fix = await step('implementer', 'gate-fix', round, gateFixPrompt(results, o.task), o.cwd);
      if (!fix) return null;
      results = await runGates(cfg.gates, o.cwd, timeout);
      fix.gates = results;
      emit({ kind: 'gates', round, results });
    }
    return results;
  };

  try {
    const first = await step('implementer', 'implement', 0, o.task, o.cwd);
    if (!first || !(await gated(0))) throw new Stop();

    for (let round = 1; round <= cfg.maxRounds; round++) {
      const copy = makeReviewCopy(o.cwd, `r${round}`);
      let review: StepRecord | null;
      try {
        review = await step('reviewer', 'review', round, reviewPrompt(o.task, round), copy.path);
      } finally {
        copy.remove();
      }
      if (!review) throw new Stop();
      lastReview = review.text;
      if (review.verdict?.verdict === 'NONE') {
        // Never hand the implementer a "review" with no verdict: it has nothing to act on.
        outcome = 'no verdict';
        detail = `round ${round}: the reviewer gave no VERDICT line, even when asked again`;
        break;
      }
      if (review.verdict && isClean(review.verdict)) {
        outcome = 'passed';
        detail = `round ${round}: the reviewer passed it with nothing critical or high`;
        break;
      }
      if (round === cfg.maxRounds) {
        outcome = 'rounds used up';
        detail = `${cfg.maxRounds} review rounds; the last verdict was ${review.verdict?.verdict ?? 'NONE'}`;
        break;
      }
      const before = workFingerprint(o.cwd);
      const apply = await step('implementer', 'apply', round, applyPrompt(review.text, o.task), o.cwd);
      if (!apply) throw new Stop();
      if (workFingerprint(o.cwd) === before) {
        outcome = 'no progress';
        detail = `round ${round}: applying the review changed nothing`;
        break;
      }
      if (!(await gated(round))) throw new Stop();
    }
  } catch (err) {
    if (err instanceof Stop || aborted()) {
      outcome = aborted() ? 'aborted' : 'time budget';
      detail = aborted() ? 'stopped by the user' : `the ${cfg.maxTotalMinutes}-minute total ran out`;
    } else {
      outcome = 'error';
      detail = err instanceof Error ? err.message : String(err);
    }
  }

  const finalGates = aborted() ? [] : await runGates(cfg.gates, o.cwd, cfg.gateTimeoutMinutes * 60_000);
  const reportFile = join(sessionDir, 'report.md');
  const report: LoopReport = { runId, outcome, detail, ms: Date.now() - started, steps, finalGates, lastReview, sessionDir, reportFile, markdown: '' };
  report.markdown = renderReport(report, cfg);
  writeFileSync(reportFile, report.markdown);
  emit({ kind: 'done', report });
  return report;
}

class Stop extends Error {}

const min = (ms: number) => `${(ms / 60_000).toFixed(1)} min`;
const perSec = (tokens: number, ms: number) => (ms > 0 && tokens > 0 ? `${Math.round((tokens * 1000) / ms)}/s` : '-');

export function speedsOf(steps: StepRecord[]): Speeds {
  const s: Speeds = { readTokens: 0, readMs: 0, writeTokens: 0, writeMs: 0 };
  for (const r of steps) addSpeeds(s, r);
  return s;
}

export function renderReport(r: LoopReport, cfg: LoopConfig): string {
  const lines: string[] = [];
  lines.push(`# pi-loop ${r.runId}`, '');
  lines.push(`**Outcome: ${r.outcome}** (${r.detail}). ${min(r.ms)}, ${r.steps.length} steps.`, '');
  lines.push(`Implementer \`${cfg.implementer.model}\`, reviewer \`${cfg.reviewer.model}\`.`, '');
  lines.push('| step | what | turns | time | read | write | limit | session |', '|---|---|---|---|---|---|---|---|');
  for (const s of r.steps) {
    const limit = [s.warned ? 'warned' : '', s.stoppedBy ? `${s.stoppedBy}${s.wrappedUp ? ', wrapped up' : ''}` : (s.wrappedUp ? 'asked again' : ''), s.startupStalls ? `${s.startupStalls} startup stall${s.startupStalls > 1 ? 's' : ''}` : ''].filter(Boolean).join('; ');
    const v = s.verdict ? ` → ${s.verdict.verdict} (${s.verdict.counts.critical}c/${s.verdict.counts.high}h/${s.verdict.counts.minor}m)` : '';
    const g = !s.gates ? '' : !s.gates.length ? ' → no checks' : ` → checks ${s.gates.every((x) => x.ok) ? 'ok' : 'FAILED'}`;
    lines.push(`| ${s.n} | ${stepLabel(s.kind, s.round)} (${shortModel(s.model)})${v}${g} | ${s.turns} | ${min(s.ms)} | ${perSec(s.readTokens, s.readMs)} | ${perSec(s.writeTokens, s.writeMs)} | ${limit} | ${s.sessionId?.slice(-12) ?? ''} |`);
  }
  lines.push('');
  for (const role of ['implementer', 'reviewer'] as const) {
    const sp = speedsOf(r.steps.filter((s) => s.role === role));
    lines.push(`- ${role}: read ${perSec(sp.readTokens, sp.readMs)}, write ${perSec(sp.writeTokens, sp.writeMs)}`);
  }
  const all = speedsOf(r.steps);
  lines.push(`- total: read ${perSec(all.readTokens, all.readMs)}, write ${perSec(all.writeTokens, all.writeMs)}`, '');
  lines.push('Final checks (run by the loop):');
  for (const g of r.finalGates) lines.push(`- \`${g.command}\`: ${g.ok ? 'passed' : g.timedOut ? 'TIMED OUT' : `FAILED (exit ${g.exitCode})`}`);
  if (!r.finalGates.length) lines.push('- not run');
  lines.push('', `Sessions: \`${r.sessionDir}\` (open one with \`pi --session-dir <dir> --session <id>\`).`);
  if (r.lastReview) lines.push('', '## Last review', '', r.lastReview);
  return lines.join('\n') + '\n';
}
