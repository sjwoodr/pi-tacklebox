import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import jobs from '../../src/jobs/index.ts';

/** jobs loaded against a fake pi; returns its tools, handlers and what it sent. */
function setup(config: object = {}) {
  const agent = mkdtempSync(join(tmpdir(), 'tacklebox-'));
  writeFileSync(join(agent, 'tacklebox.json'), JSON.stringify({ jobs: config }));
  const tools = new Map<string, any>();
  const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
  const sent: { message: any; options: any }[] = [];
  const statuses: (string | undefined)[] = [];
  process.env.PI_CODING_AGENT_DIR = agent;
  jobs({
    on: (name: string, h: any) => void handlers.set(name, h),
    registerTool: (tool: any) => void tools.set(tool.name, tool),
    sendMessage: (message: any, options: any) => void sent.push({ message, options }),
  } as never);
  delete process.env.PI_CODING_AGENT_DIR;
  const cwd = mkdtempSync(join(tmpdir(), 'tacklebox-project-'));
  const ui = { hasUI: true, cwd, ui: { setStatus: (_k: string, v?: string) => void statuses.push(v) } };
  const print = { hasUI: false, cwd };
  const run = async (name: string, params: object, ctx: object = ui) =>
    (await tools.get(name).execute('id', params, undefined, undefined, ctx)).content[0].text as string;
  return { tools, handlers, sent, statuses, run, ui, print };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const until = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('job_start returns at once, and the end reaches the model as a message that starts a turn', async () => {
  const { run, sent, statuses, handlers } = setup();
  const t0 = Date.now();
  const started = await run('job_start', { command: 'echo building; sleep 0.3; echo done; exit 3' });
  assert.ok(Date.now() - t0 < 200, 'returned before the command finished');
  assert.match(started, /Started job 1/);
  assert.equal(statuses.at(-1), 'jobs: 1 running');
  assert.match(await run('job_status', {}), /1: running/);
  await until(() => sent.length === 1);
  const { message, options } = sent[0]!;
  assert.match(message.content, /Background job 1 ended with exit 3/);
  assert.match(message.content, /building\ndone/);
  assert.deepEqual(options, { triggerTurn: true, deliverAs: 'followUp' });
  assert.equal(statuses.at(-1), undefined);
  assert.match(await run('job_status', { id: 1 }), /ended, exit 3/);
  await handlers.get('session_shutdown')!({}, {});
});

test('job_kill stops the job and everything it started', async () => {
  const { run, sent, handlers, ui } = setup();
  await run('job_start', { command: 'sleep 30 & echo $! > child.pid; wait' });
  const pidFile = join(ui.cwd, 'child.pid');
  await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
  const child = Number(readFileSync(pidFile, 'utf8'));
  assert.match(await run('job_kill', { id: 1 }), /Stopping job 1/);
  await until(() => sent.length === 1);
  assert.match(sent[0]!.message.content, /was killed/);
  await until(() => !alive(child));
  await assert.rejects(run('job_kill', { id: 1 }), /No running job 1/);
  await handlers.get('session_shutdown')!({}, {});
});

test('a bash call that would block for minutes is refused, others pass; blockLong: false lets it through', async () => {
  const { handlers } = setup();
  const call = (command: string) => handlers.get('tool_call')!({ toolName: 'bash', input: { command } }, {});
  const blocked = await call('gh run watch 123');
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /job_start/);
  assert.equal(await call('gh run view 123'), undefined);
  assert.equal(setup({ blockLong: false }).handlers.get('tool_call'), undefined);
});

test('print mode: a run that would end with a job running waits for it, then continues with the result', async () => {
  const { run, sent, handlers, print } = setup({ waitSeconds: 5 });
  await run('job_start', { command: 'sleep 0.3; echo deployed' }, print);
  const settle = handlers.get('agent_before_settle')!;
  const result = await settle({ outcome: 'completed', continue: false, entries: [] }, print);
  assert.equal(result.continue, true);
  assert.match(result.entries[0].content, /exit 0[\s\S]*deployed/);
  assert.equal(sent.length, 0, 'delivered through the settle, not twice');
  // With the UI, or nothing running, the run settles normally.
  assert.equal(await settle({ outcome: 'completed', continue: false, entries: [] }, print), undefined);
});

test('print mode gives up after waitSeconds and lets the run end', async () => {
  const { run, handlers, print } = setup({ waitSeconds: 0.2 });
  await run('job_start', { command: 'sleep 30' }, print);
  const result = await handlers.get('agent_before_settle')!({ outcome: 'completed', continue: false, entries: [] }, print);
  assert.equal(result, undefined);
  await handlers.get('session_shutdown')!({}, {});
});

test('jobs still running when pi exits are killed', async () => {
  const { run, handlers, ui } = setup();
  await run('job_start', { command: 'sleep 30 & echo $! > child.pid; wait' });
  const pidFile = join(ui.cwd, 'child.pid');
  await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
  const child = Number(readFileSync(pidFile, 'utf8'));
  await handlers.get('session_shutdown')!({ reason: 'quit' }, {});
  await until(() => !alive(child));
});

test('off: no tools, no hooks', () => {
  const { tools, handlers } = setup({ enabled: false });
  assert.equal(tools.size, 0);
  assert.equal(handlers.size, 0);
});
