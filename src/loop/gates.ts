/** Checks the loop runs itself after an implementer step: no model decides whether tests passed. */
import { spawn } from 'node:child_process';
import { shellCommand } from '../sandbox/sandbox.ts';

export interface GateResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  ms: number;
  /** The end of the output, for the implementer when it failed. */
  tail: string;
  /** The output itself, for a later step as {id}: whole up to OUTPUT_CHARS, else its start and end. */
  output: string;
}

const TAIL_CHARS = 4_000;
const OUTPUT_CHARS = 30_000;

export function runGate(command: string, cwd: string, timeoutMs: number): Promise<GateResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let run: ReturnType<typeof shellCommand>;
    try {
      run = shellCommand(command, cwd);
    } catch (err) {
      const output = `could not run it: ${(err as Error).message}`;
      return resolve({ command, ok: false, exitCode: null, timedOut: false, ms: Date.now() - started, tail: output, output });
    }
    const proc = spawn('bash', ['-c', run.command], { cwd, detached: true, env: run.env, stdio: ['ignore', 'pipe', 'pipe'] });
    // The start (a setup script prints its paths first) and the end (a test run ends with its failures).
    const half = OUTPUT_CHARS / 2;
    let head = '';
    let end = '';
    let total = 0;
    let timedOut = false;
    const keep = (chunk: Buffer) => {
      const s = chunk.toString();
      total += s.length;
      const take = s.slice(0, Math.max(0, half - head.length));
      head += take;
      end = (end + s.slice(take.length)).slice(-half);
    };
    proc.stdout.on('data', keep);
    proc.stderr.on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-proc.pid!, 'SIGKILL'); } catch {}
    }, timeoutMs);
    // A command that can't start (a missing directory) fails as a check; unhandled, it would end the whole loop.
    proc.on('error', (err) => {
      clearTimeout(timer);
      const output = `could not run it: ${err.message}`;
      resolve({ command, ok: false, exitCode: null, timedOut: false, ms: Date.now() - started, tail: output, output });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      const cut = total - head.length - end.length;
      const output = cut > 0 ? `${head}\n[... ${cut} characters cut ...]\n${end}` : head + end;
      resolve({ command, ok: code === 0 && !timedOut, exitCode: code, timedOut, ms: Date.now() - started, tail: (head + end).slice(-TAIL_CHARS), output });
    });
  });
}

export async function runGates(commands: string[], cwd: string, timeoutMs: number): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const c of commands) results.push(await runGate(c, cwd, timeoutMs));
  return results;
}
