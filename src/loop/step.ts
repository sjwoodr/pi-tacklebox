/**
 * One step of the loop: a `pi --mode rpc` process the loop can talk to while it works.
 *
 * Limits, gentlest first:
 *   1. warn:  a few turns (or minutes) before a limit, a `steer` message tells the model to stop and write its
 *             report. pi delivers it before the next model request, so a model that listens finishes on its
 *             own: nothing is killed, and no half-sent request is left running on the model server.
 *   2. limit: at the limit, a firm steer (the final ask), which rides on the request pi sends anyway.
 *   3. abort: a few turns (or minutes) later, only for a model that ignored both: `abort` stops the run (pi stays
 *             up), then one more `prompt` asks for the report in the same process, cache still warm.
 *   4. kill:  only if pi itself is stuck (no answer at start, or past the hard deadline), its whole process
 *             group is killed, so a running `npm test` goes too.
 *
 * Killing mid-request was the old way, and it left LM Studio reading a dead request's prompt for minutes
 * (it only notices a closed connection when it sends a token). Every step keeps its session (--session-dir,
 * --name), so it can be watched, resumed and searched.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StepLimits } from './settings.ts';

export interface StepOptions {
  /** Shown in pi's session list. */
  name: string;
  cwd: string;
  model: string;
  /** pi --tools allowlist; empty for pi's defaults. */
  tools: string[];
  /** Role instructions, appended to pi's system prompt. */
  appendSystemPrompt?: string;
  prompt: string;
  limits: StepLimits;
  sessionDir: string;
  /** The command that runs pi; tests swap in a fake. */
  piCommand?: string[];
  signal?: AbortSignal;
  onProgress?: (p: StepProgress) => void;
  /** Kill the step if pi hasn't answered at all within this many seconds (default 60). */
  startupSeconds?: number;
  /** Warn this many turns before maxTurns (default 3). */
  warnTurns?: number;
  /** ...or this many minutes before maxMinutes (default 2), whichever comes first. */
  warnMinutes?: number;
  /** The warning sent as a steer message. */
  warning?: string;
  /** Sent as a steer at the limit, and asked again after an abort: the report, in the same process. */
  finalAsk?: string;
  /** After the limit, turns (default 3) or minutes (default 2) before an abort: the model's chance to obey the firm steer. */
  graceTurns?: number;
  graceMinutes?: number;
  /** Time allowed for each ask after the run (default 6 minutes). */
  askMinutes?: number;
  /**
   * After the run settles on its own: return a prompt to send one more time (for example when the reviewer
   * gave no VERDICT line), or undefined when the answer is usable. Asked at most once, and not after finalAsk.
   */
  followUpFor?: (text: string) => string | undefined;
}

export interface StepProgress {
  turns: number;
  elapsedMs: number;
  /** The tool the step is running, if any. */
  tool?: string;
  /** Set once the step has been warned. */
  warned?: boolean;
}

export interface Speeds {
  readTokens: number;
  readMs: number;
  writeTokens: number;
  writeMs: number;
}

export interface StepResult extends Speeds {
  /** The last assistant text of the step. */
  text: string;
  turns: number;
  ms: number;
  /** The limit that was reached (turns/time), or why the step was stopped otherwise. */
  stoppedBy?: 'turns' | 'time' | 'aborted' | 'startup' | 'stuck';
  /** The step was warned before its limit. */
  warned: boolean;
  /** It ignored the firm steer at its limit too, and its run was aborted. */
  aborted: boolean;
  /** Prompts sent after the main one (the final ask, a follow-up). */
  asks: number;
  exitCode: number | null;
  sessionId?: string;
  input: number;
  output: number;
  cacheRead: number;
  stderrTail: string;
}

const KILL_GRACE_MS = 5_000;

export const DEFAULT_WARNING =
  'Your budget for this step is almost used up. Stop investigating now: do not start new checks. Write your ' +
  'final report from what you have, in the format your instructions ask for.';

export function piArgs(o: StepOptions, systemPromptFile?: string): string[] {
  const args = ['--mode', 'rpc', '--session-dir', o.sessionDir, '--model', o.model, '--name', o.name];
  if (o.tools.length) args.push('--tools', o.tools.join(','));
  if (systemPromptFile) args.push('--append-system-prompt', systemPromptFile);
  return args;
}

export function runStep(o: StepOptions): Promise<StepResult> {
  mkdirSync(o.sessionDir, { recursive: true });
  let promptDir: string | undefined;
  let promptFile: string | undefined;
  if (o.appendSystemPrompt) {
    promptDir = mkdtempSync(join(tmpdir(), 'pi-loop-'));
    promptFile = join(promptDir, 'role.md');
    writeFileSync(promptFile, o.appendSystemPrompt);
  }
  const [cmd, ...pre] = o.piCommand ?? ['pi'];
  const started = Date.now();
  const warnTurns = o.warnTurns ?? 3;
  // Warn warnMinutes before the time limit, but never before 75% of it: a short step (the end of the loop's
  // total budget) must not be told to wrap up as soon as it starts.
  const warnMs = Math.max(o.limits.maxMinutes - (o.warnMinutes ?? 2), o.limits.maxMinutes * 0.75) * 60_000;
  const askMs = (o.askMinutes ?? 6) * 60_000;
  const graceTurns = o.graceTurns ?? 3;
  const graceMs = (o.graceMinutes ?? 2) * 60_000;
  const result: StepResult = {
    text: '', turns: 0, ms: 0, warned: false, aborted: false, asks: 0, exitCode: null, input: 0, output: 0, cacheRead: 0,
    stderrTail: '', readTokens: 0, readMs: 0, writeTokens: 0, writeMs: 0,
  };

  return new Promise((resolve) => {
    // PI_OFFLINE stops pi's own startup network work (model catalog refresh); model requests still go out.
    const proc = spawn(cmd, [...pre, ...piArgs(o, promptFile)], {
      cwd: o.cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PI_OFFLINE: '1' },
    });
    let buffer = '';
    let requestStart = 0;
    let firstOutput = 0;
    let tool: string | undefined;
    let answered = false; // pi has said anything at all
    let limitHit = false; // a limit was reached and the firm steer sent
    let abortSent = false;
    let finalAsked = false;
    let followedUp = false;
    let closing = false;
    let killed = false;
    let seq = 0;
    const timers: NodeJS.Timeout[] = [];
    const later = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));

    const send = (command: Record<string, unknown>) => {
      if (closing || proc.stdin.destroyed) return;
      proc.stdin.write(JSON.stringify({ id: `pl-${++seq}`, ...command }) + '\n');
    };
    const progress = () => o.onProgress?.({ turns: result.turns, elapsedMs: Date.now() - started, tool, warned: result.warned });
    const kill = (why: NonNullable<StepResult['stoppedBy']>) => {
      if (killed) return;
      killed = true;
      result.stoppedBy ??= why;
      killGroup(proc.pid, 'SIGTERM');
      setTimeout(() => killGroup(proc.pid, 'SIGKILL'), KILL_GRACE_MS).unref();
    };
    /** Orderly shutdown: close stdin, and kill only if pi doesn't exit by itself. */
    const finish = () => {
      if (closing) return;
      closing = true;
      proc.stdin.end();
      setTimeout(() => kill('stuck'), KILL_GRACE_MS).unref();
    };
    const warn = () => {
      if (result.warned || limitHit || closing) return;
      result.warned = true;
      send({ type: 'steer', message: o.warning ?? DEFAULT_WARNING });
      progress();
    };
    // At the limit, a firm steer rides on the request pi sends anyway. Aborting there cancelled a request LM
    // Studio had started reading, and it went on reading it (an orphan, at half speed for the next step).
    const reachLimit = (why: 'turns' | 'time') => {
      if (limitHit || closing) return;
      limitHit = true;
      result.stoppedBy = why;
      result.warned = true;
      send({ type: 'steer', message: o.finalAsk ?? o.warning ?? DEFAULT_WARNING });
      progress();
      later(graceMs, abortRun);
    };
    /** Only for a model that ignored both steers: stop the run, then ask for the report in the same process. */
    const abortRun = () => {
      if (abortSent || closing) return;
      abortSent = true;
      result.aborted = true;
      send({ type: 'abort' });
      // The ask follows the abort's agent_settled; if pi never settles, it's stuck.
      later(askMs + 60_000, () => kill('stuck'));
    };
    const ask = (message: string) => {
      result.asks++;
      send({ type: 'prompt', message });
      later(askMs, () => kill('stuck'));
    };

    later((o.startupSeconds ?? 60) * 1000, () => {
      if (!answered) kill('startup');
    });
    later(warnMs, warn);
    later(o.limits.maxMinutes * 60_000, () => reachLimit('time'));
    const onAbort = () => {
      result.stoppedBy = 'aborted';
      send({ type: 'abort' });
      finish();
    };
    o.signal?.addEventListener('abort', onAbort, { once: true });

    const handle = (line: string) => {
      let e: any;
      try { e = JSON.parse(line); } catch { return; }
      answered = true;
      switch (e.type) {
        case 'response':
          if (e.command === 'get_state' && e.success) result.sessionId ??= e.data?.sessionId;
          if (e.command === 'prompt' && !e.success) {
            result.stderrTail += `\nprompt refused: ${e.error ?? JSON.stringify(e)}`;
            finish();
          }
          break;
        case 'turn_start':
          requestStart = Date.now();
          firstOutput = 0;
          break;
        case 'message_update':
          if (requestStart && !firstOutput) firstOutput = Date.now();
          break;
        case 'tool_execution_start':
          tool = e.toolName ?? e.name;
          progress();
          break;
        case 'message_end': {
          const m = e.message;
          if (m?.role !== 'assistant') break;
          const u = m.usage ?? {};
          result.input += u.input ?? 0;
          result.output += u.output ?? 0;
          result.cacheRead += u.cacheRead ?? 0;
          if (requestStart && firstOutput) {
            result.readTokens += u.input ?? 0;
            result.readMs += firstOutput - requestStart;
            result.writeTokens += u.output ?? 0;
            result.writeMs += Date.now() - firstOutput;
          }
          requestStart = 0;
          firstOutput = 0;
          const text = (m.content ?? []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('').trim();
          if (text) result.text = text;
          break;
        }
        case 'turn_end':
          result.turns++;
          tool = undefined;
          progress();
          if (finalAsked && result.turns >= o.limits.maxTurns + graceTurns + 3) kill('stuck'); // the final ask went on calling tools
          else if (limitHit && result.turns >= o.limits.maxTurns + graceTurns) abortRun();
          else if (result.turns >= o.limits.maxTurns) reachLimit('turns');
          else if (result.turns >= o.limits.maxTurns - warnTurns) warn();
          break;
        case 'agent_settled':
          if (closing) break;
          if (abortSent && !finalAsked && o.finalAsk) {
            finalAsked = true;
            ask(o.finalAsk);
          } else if (!abortSent && !finalAsked && !followedUp && o.followUpFor?.(result.text)) {
            followedUp = true;
            ask(o.followUpFor(result.text)!);
          } else {
            finish();
          }
          break;
      }
    };

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      // Strict JSONL: split on LF only (not on U+2028/U+2029, which are valid inside JSON strings).
      let i: number;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const l = buffer.slice(0, i).replace(/\r$/, '');
        buffer = buffer.slice(i + 1);
        if (l.trim()) handle(l);
      }
    });
    proc.stderr.on('data', (chunk) => {
      result.stderrTail = (result.stderrTail + chunk.toString()).slice(-2_000);
    });
    proc.stdin.on('error', () => {}); // pi gone before we finished writing
    proc.on('close', (code) => {
      // Whatever pi left running in its group (a test, a sleep) goes too, even after an orderly exit.
      killGroup(proc.pid, 'SIGKILL');
      if (buffer.trim()) handle(buffer);
      for (const t of timers) clearTimeout(t);
      o.signal?.removeEventListener('abort', onAbort);
      if (promptDir) rmSync(promptDir, { recursive: true, force: true });
      result.exitCode = code;
      result.ms = Date.now() - started;
      resolve(result);
    });
    proc.on('error', (err) => {
      result.stderrTail += `\n${err.message}`;
    });

    if (o.signal?.aborted) onAbort();
    else {
      send({ type: 'get_state' });
      send({ type: 'prompt', message: o.prompt });
    }
  });
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
  }
}

/** Tokens per second for a speed pair, or undefined with no time measured. */
export function rate(tokens: number, ms: number): number | undefined {
  return ms > 0 && tokens > 0 ? Math.round((tokens * 1000) / ms) : undefined;
}

export function addSpeeds(into: Speeds, from: Speeds) {
  into.readTokens += from.readTokens;
  into.readMs += from.readMs;
  into.writeTokens += from.writeTokens;
  into.writeMs += from.writeMs;
}
