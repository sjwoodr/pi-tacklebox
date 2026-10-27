import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Job {
  id: number;
  command: string;
  cwd: string;
  pid: number | undefined;
  log: string;
  started: number;
  /** Set when the job has ended: its exit code, or undefined when a signal ended it. */
  ended?: { at: number; code: number | undefined; killed: boolean };
}

/** The last `lines` lines of a job's output, at most `chars` characters. */
export function tail(job: Job, lines = 20, chars = 3000): string {
  let text = '';
  try {
    text = readFileSync(job.log, 'utf8');
  } catch {}
  return text.trimEnd().split('\n').slice(-lines).join('\n').slice(-chars);
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

/** Shell commands run in the background, each in its own process group, output to a log file. */
export class Jobs {
  private jobs = new Map<number, Job>();
  private next = 1;
  private killed = new Set<number>();

  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  start(command: string, cwd: string, onExit: (job: Job) => void): Job {
    mkdirSync(this.dir, { recursive: true });
    const id = this.next++;
    const log = join(this.dir, `job-${id}.log`);
    const fd = openSync(log, 'w');
    const child = spawn('sh', ['-c', command], { cwd, detached: true, stdio: ['ignore', fd, fd] });
    closeSync(fd);
    const job: Job = { id, command, cwd, pid: child.pid, log, started: Date.now() };
    this.jobs.set(id, job);
    const end = (code: number | undefined) => {
      if (job.ended) return;
      job.ended = { at: Date.now(), code, killed: this.killed.has(id) };
      onExit(job);
    };
    child.on('error', () => end(127));
    child.on('exit', (code) => end(code ?? undefined));
    return job;
  }

  get(id: number): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return [...this.jobs.values()];
  }

  running(): Job[] {
    return this.list().filter((j) => !j.ended);
  }

  /** Kills a running job's whole process group. False when there is no such running job. */
  kill(id: number): boolean {
    const job = this.jobs.get(id);
    if (!job || job.ended || job.pid === undefined) return false;
    this.killed.add(id);
    try {
      process.kill(-job.pid, 'SIGTERM');
    } catch {}
    return true;
  }

  killAll(): void {
    for (const job of this.running()) this.kill(job.id);
  }
}
