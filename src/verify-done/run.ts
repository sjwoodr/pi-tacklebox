import { spawn } from 'node:child_process';

export interface TestRun {
  ok: boolean;
  /** The exit code, or undefined when the run timed out. */
  code: number | undefined;
  /** The last TAIL_LINES lines of stdout and stderr together, at most TAIL_CHARS. */
  tail: string;
}

export const TAIL_LINES = 40;
const TAIL_CHARS = 4000;

/** Runs `command` through sh in `cwd`, killing it (and its children) after `timeoutSeconds`. */
export function runTests(command: string, cwd: string, timeoutSeconds: number): Promise<TestRun> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-50_000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {}
    }, timeoutSeconds * 1000);
    const finish = (code: number | undefined) => {
      clearTimeout(timer);
      const tail = output.trimEnd().split('\n').slice(-TAIL_LINES).join('\n').slice(-TAIL_CHARS);
      resolve({ ok: !timedOut && code === 0, code: timedOut ? undefined : code, tail });
    };
    child.on('error', (err) => {
      output += String(err);
      finish(127);
    });
    child.on('close', (code) => finish(code ?? undefined));
  });
}
