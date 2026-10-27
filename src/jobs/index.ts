/**
 * jobs: run long shell commands in the background and tell the model when they end, instead of
 * blocking its bash call. A local model watched a deploy with `gh run watch` in bash and sat blocked
 * on it for 17+ minutes (2026-10-27); pi's bash tool has no default timeout.
 *
 *   job_start   starts a command in the background (output to a log file) and returns at once
 *   job_status  lists the jobs, or shows one with the end of its output
 *   job_kill    stops a running job
 *
 * When a job ends, its exit code and the end of its output reach the model as a message: right
 * away when pi is idle (it starts a turn), after the current run otherwise. In print mode
 * (`pi -p`, no UI) a run that would end with jobs still running waits for the next one to end
 * (up to jobs.waitSeconds, default 900), so the result isn't lost when pi exits.
 *
 * A bash call that would wait on something for minutes (gh run watch, kubectl rollout status,
 * tail -f, a polling loop, a sleep of a minute or more; long.ts) is refused with a pointer to
 * job_start; `"jobs": { "blockLong": false }` lets them through. Jobs are killed when pi exits.
 *
 * On by default; `"jobs": { "enabled": false }` in tacklebox.json turns it off.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { loadConfig } from '../config.ts';
import { duration, type Job, Jobs, tail } from './jobs.ts';
import { longRunning } from './long.ts';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }], details: undefined });

const state = (job: Job) =>
  !job.ended
    ? `running for ${duration(Date.now() - job.started)}`
    : job.ended.killed
      ? `killed after ${duration(job.ended.at - job.started)}`
      : `ended, exit ${job.ended.code ?? 'by signal'}, after ${duration(job.ended.at - job.started)}`;

const how = (job: Job) =>
  job.ended?.killed
    ? `was killed after ${duration(job.ended.at - job.started)}`
    : `ended with exit ${job.ended?.code ?? 'by signal'} after ${duration((job.ended?.at ?? Date.now()) - job.started)}`;

export const endedMessage = (job: Job) =>
  `Background job ${job.id} ${how(job)}: \`${job.command}\`\n\n` +
  'Last lines of its output:\n```\n' +
  (tail(job) || '(no output)') +
  `\n\`\`\`\nFull output: ${job.log}`;

export const blockedReason = (what: string) =>
  `Not run: this waits on ${what} and would block you for minutes. Start the same command with job_start ` +
  "instead; you'll get a message when it ends. To check once without waiting, use a one-shot command " +
  '(for example `gh run view <id>` instead of `gh run watch`).';

export default function (pi: ExtensionAPI) {
  const { enabled, blockLong, waitSeconds } = loadConfig().jobs;
  if (!enabled) return;
  const jobs = new Jobs(join(tmpdir(), `pi-tacklebox-jobs-${process.pid}`));
  let ui: ExtensionContext | undefined;
  // Print mode: a settle waiting for the next job to end takes the message instead of sendMessage.
  let waiter: ((job: Job) => void) | undefined;

  const status = () => {
    if (!ui?.hasUI) return;
    const n = jobs.running().length;
    ui.ui.setStatus('jobs', n ? `jobs: ${n} running` : undefined);
  };

  const ended = (job: Job) => {
    status();
    if (waiter) return waiter(job);
    pi.sendMessage(
      { customType: 'tacklebox-jobs', content: endedMessage(job), display: true },
      { triggerTurn: true, deliverAs: 'followUp' },
    );
  };

  pi.registerTool(
    defineTool({
      name: 'job_start',
      label: 'Start job',
      description:
        'Run a shell command in the background and return at once. Its output goes to a log file, and you get a ' +
        'message with the exit code and the last lines of output when it ends.',
      promptSnippet: 'job_start: run a long command (deploy watch, build, server) in the background',
      promptGuidelines: [
        'Use job_start, not bash, for anything that can take more than a minute or never ends: watching a deploy or ' +
          'CI run, a rollout, a long build or test suite, a dev server, following logs.',
        "After job_start, don't poll the job, sleep or wait on it: do other work, or end your turn and say what you're " +
          'waiting for. The result arrives as a message when the job ends.',
      ],
      parameters: Type.Object({
        command: Type.String({ description: 'The shell command, run with sh -c in the current directory' }),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        ui = ctx;
        const job = jobs.start(params.command, ctx.cwd, ended);
        status();
        return text(
          `Started job ${job.id}: \`${job.command}\`. Output goes to ${job.log}. You'll get a message when it ends; ` +
            "don't poll it, sleep or wait on it.",
        );
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: 'job_status',
      label: 'Job status',
      description: 'List the background jobs, or show one job with the last lines of its output.',
      parameters: Type.Object({
        id: Type.Optional(Type.Number({ description: 'A job id; leave out to list every job' })),
      }),
      async execute(_id, params) {
        if (params.id === undefined) {
          const all = jobs.list();
          return text(all.length ? all.map((j) => `${j.id}: ${state(j)}: \`${j.command}\``).join('\n') : 'No jobs.');
        }
        const job = jobs.get(params.id);
        if (!job) throw new Error(`No job ${params.id}.`);
        return text(`Job ${job.id}, ${state(job)}: \`${job.command}\`\n\`\`\`\n${tail(job, 40) || '(no output yet)'}\n\`\`\``);
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: 'job_kill',
      label: 'Kill job',
      description: 'Stop a running background job (and everything it started).',
      parameters: Type.Object({ id: Type.Number({ description: 'The job id' }) }),
      async execute(_id, params) {
        if (!jobs.kill(params.id)) throw new Error(`No running job ${params.id}.`);
        return text(`Stopping job ${params.id}.`);
      },
    }),
  );

  if (blockLong) {
    pi.on('tool_call', async (event) => {
      if (event.toolName !== 'bash') return;
      const what = longRunning((event.input as { command?: string }).command ?? '');
      if (what) return { block: true, reason: blockedReason(what) };
    });
  }

  // Print mode: don't let the run end (and pi exit, killing the jobs) while a job is still running.
  pi.on('agent_before_settle', async (event, ctx) => {
    if (ctx.hasUI || event.outcome !== 'completed' || event.continue || !jobs.running().length) return;
    process.stderr.write(`[tacklebox] jobs: waiting for ${jobs.running().length} running job(s)\n`);
    const job = await new Promise<Job | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), waitSeconds * 1000);
      waiter = (j) => {
        clearTimeout(timer);
        resolve(j);
      };
    });
    waiter = undefined;
    if (!job) {
      process.stderr.write(`[tacklebox] jobs: still running after ${waitSeconds}s; ending\n`);
      return;
    }
    return {
      entries: [{ type: 'custom_message', customType: 'tacklebox-jobs', content: endedMessage(job), display: true }],
      continue: true,
    };
  });

  pi.on('session_shutdown', async () => {
    jobs.killAll();
  });
}
