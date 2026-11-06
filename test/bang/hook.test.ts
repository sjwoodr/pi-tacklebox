import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import bang, { ASK } from '../../src/bang/index.ts';

/** bang loaded against a fake pi and session; `record` puts an entry at the end of the session. */
function setup(config: object = {}) {
  const agent = mkdtempSync(join(tmpdir(), 'tacklebox-'));
  writeFileSync(join(agent, 'tacklebox.json'), JSON.stringify({ bang: config }));
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const sent: { message: any; options: any }[] = [];
  process.env.PI_CODING_AGENT_DIR = agent;
  bang({
    on: (name: string, h: any) => void handlers.set(name, h),
    sendMessage: (message: any, options: any) => void sent.push({ message, options }),
  } as never);
  delete process.env.PI_CODING_AGENT_DIR;
  const state = { leaf: { id: 'a', type: 'message', message: { role: 'user' } } as any, idle: true };
  const ctx = {
    isIdle: () => state.idle,
    sessionManager: { getLeafId: () => state.leaf.id, getLeafEntry: () => state.leaf },
  };
  const run = (command: string, excludeFromContext = false) =>
    handlers.get('user_bash')?.({ command, excludeFromContext, cwd: '/' }, ctx);
  const record = (message: object) => void (state.leaf = { id: 'b', type: 'message', message });
  const ran = (command: string, extra: object = {}) => record({ role: 'bashExecution', command, ...extra });
  return { handlers, sent, state, run, record, ran };
}
const settle = () => sleep(250);

test('on by default, and off when the config says so', () => {
  assert.ok(setup().handlers.has('user_bash'));
  assert.equal(setup({ enabled: false }).handlers.size, 0);
});

test('starts a turn only once the output is in the session', async () => {
  const { sent, run, ran } = setup();
  assert.equal(run('ls'), undefined); // pi still runs the command itself
  await settle();
  assert.equal(sent.length, 0);
  ran('ls');
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.message.content, ASK);
  assert.equal(sent[0]!.options.triggerTurn, true);
});

test('starts a turn when the command failed', async () => {
  const { sent, run, ran } = setup();
  run('false');
  ran('false', { exitCode: 1 });
  await settle();
  assert.equal(sent.length, 1);
});

test('leaves !! alone', async () => {
  const { sent, run, ran } = setup();
  run('ls', true);
  ran('ls', { excludeFromContext: true });
  await settle();
  assert.equal(sent.length, 0);
});

test('stays out of the way while the model is busy', async () => {
  const { sent, state, run, ran } = setup();
  state.idle = false;
  run('ls');
  ran('ls');
  await settle();
  assert.equal(sent.length, 0);
});

test('does nothing for a cancelled command', async () => {
  const { sent, run, ran } = setup();
  run('sleep 99');
  ran('sleep 99', { cancelled: true });
  await settle();
  assert.equal(sent.length, 0);
});

test('stands down if the user sent a prompt while it ran', async () => {
  const { sent, run, record } = setup();
  run('ls');
  record({ role: 'user' });
  await settle();
  assert.equal(sent.length, 0);
});

test('stands down if the model got busy before the output landed', async () => {
  const { sent, state, run, ran } = setup();
  run('ls');
  state.idle = false;
  ran('ls');
  await settle();
  assert.equal(sent.length, 0);
});

test('stops watching when the session ends', async () => {
  const { handlers, sent, run, ran } = setup();
  run('ls');
  handlers.get('session_shutdown')?.({}, {});
  ran('ls');
  await settle();
  assert.equal(sent.length, 0);
});
