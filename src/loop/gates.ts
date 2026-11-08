/** Checks the loop runs itself after an implementer step: no model decides whether tests passed. */
import { spawn } from 'node:child_process';

export interface GateResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  ms: number;
  /** The end of the output, for the implementer when it failed. */
  tail: string;
}

const TAIL_CHARS = 4_000;

export function runGate(command: string, cwd: string, timeoutMs: number): Promise<GateResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const proc = spawn('bash', ['-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let timedOut = false;
    const keep = (chunk: Buffer) => {
      out = (out + chunk.toString()).slice(-TAIL_CHARS * 2);
    };
    proc.stdout.on('data', keep);
    proc.stderr.on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-proc.pid!, 'SIGKILL'); } catch {}
    }, timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ command, ok: code === 0 && !timedOut, exitCode: code, timedOut, ms: Date.now() - started, tail: out.slice(-TAIL_CHARS) });
    });
  });
}

export async function runGates(commands: string[], cwd: string, timeoutMs: number): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const c of commands) results.push(await runGate(c, cwd, timeoutMs));
  return results;
}
