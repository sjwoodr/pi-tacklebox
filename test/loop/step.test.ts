import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runStep, type StepOptions } from '../../src/loop/step.ts';
import { FAKE_PI, fakePi } from './helpers.ts';

const base = (dir: string, over: Partial<StepOptions> = {}): StepOptions => ({
  name: 'test step', cwd: dir, model: 'fake/model', tools: [], prompt: 'do it',
  limits: { maxTurns: 10, maxMinutes: 1 }, sessionDir: join(dir, 'sessions'), piCommand: FAKE_PI,
  finalAsk: 'FINAL ASK', ...over,
});
const commands = (log: string) => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((c) => c.cmd !== 'start');

test('a step that finishes on its own: text, turns, session id, speeds; RPC flags and no warning', async () => {
  const { dir, log } = fakePi({ implementer: { turns: 3, texts: ['all done'] } });
  const r = await runStep(base(dir, { appendSystemPrompt: 'You are the implementer.' }));
  assert.equal(r.text, 'all done');
  assert.equal(r.turns, 3);
  assert.equal(r.stoppedBy, undefined);
  assert.equal(r.warned, false);
  assert.match(r.sessionId ?? '', /^fake/);
  assert.ok(r.readTokens === 3000 && r.writeTokens === 150 && r.readMs > 0 && r.writeMs > 0);
  const start = JSON.parse(readFileSync(log, 'utf8').split('\n')[0]);
  for (const flag of ['--mode', 'rpc', '--session-dir', '--model', '--name', '--append-system-prompt']) assert.ok(start.args.includes(flag), flag);
  assert.deepEqual(commands(log).map((c) => c.cmd), ['get_state', 'prompt']);
});

test('near the turn limit the step is warned, and a model that listens finishes without an abort', async () => {
  const { dir, log } = fakePi({ implementer: { turns: 'forever', delayMs: 4, steeredText: 'my report' } });
  const r = await runStep(base(dir, { limits: { maxTurns: 8, maxMinutes: 1 }, warnTurns: 3 }));
  assert.equal(r.warned, true);
  assert.equal(r.stoppedBy, undefined, 'no limit was enforced');
  assert.equal(r.text, 'my report');
  assert.ok(r.turns < 8, `finished before the limit, at ${r.turns}`);
  const cmds = commands(log).map((c) => c.cmd);
  assert.ok(cmds.includes('steer') && !cmds.includes('abort'), cmds.join(','));
});

test('ignoring the warning brings a firm steer at the limit; a model that obeys it finishes with no abort', async () => {
  const { dir, log } = fakePi({ implementer: { turns: 'forever', delayMs: 4, ignoreSteers: 1, steeredText: 'report at the limit' } });
  const r = await runStep(base(dir, { limits: { maxTurns: 6, maxMinutes: 1 } }));
  assert.equal(r.stoppedBy, 'turns');
  assert.equal(r.aborted, false);
  assert.equal(r.text, 'report at the limit');
  assert.equal(r.asks, 0);
  assert.deepEqual(commands(log).map((c) => c.cmd), ['get_state', 'prompt', 'steer', 'steer']);
  assert.equal(commands(log)[3].message, 'FINAL ASK', 'the firm steer is the final ask');
  // The steer lands in the request after the one already under way, so up to 2 turns past the limit.
  assert.ok(r.turns <= 8, `finished within 2 turns of the limit and before the abort at 9, at ${r.turns}`);
});

test('a model that ignores both steers is aborted after the grace turns, then asked in the same process', async () => {
  const { dir, log } = fakePi({ implementer: { turns: 'forever', delayMs: 4, ignoreSteer: true }, wrapUp: { text: 'late report' } });
  const r = await runStep(base(dir, { limits: { maxTurns: 6, maxMinutes: 1 }, graceTurns: 3 }));
  assert.equal(r.stoppedBy, 'turns');
  assert.equal(r.aborted, true);
  assert.equal(r.text, 'late report');
  assert.equal(r.asks, 1);
  assert.ok(r.turns >= 9, `aborted only after the grace turns, at ${r.turns}`);
  assert.deepEqual(commands(log).map((c) => c.cmd), ['get_state', 'prompt', 'steer', 'steer', 'abort', 'prompt']);
  assert.equal(commands(log).at(-1).message, 'FINAL ASK');
  assert.equal(JSON.parse(readFileSync(log, 'utf8').split('\n')[0]).cmd, 'start');
  assert.equal(readFileSync(log, 'utf8').split('\n').filter((l) => l.includes('"cmd":"start"')).length, 1, 'one pi process, no resume');
});

test('the time limit warns, steers firmly, then aborts and asks', async () => {
  const { dir, log } = fakePi({ implementer: { turns: 'forever', delayMs: 100, ignoreSteer: true }, wrapUp: { text: 'timed report' } });
  const r = await runStep(base(dir, { limits: { maxTurns: 1000, maxMinutes: 0.02 }, warnMinutes: 0.01, graceMinutes: 0.01 }));
  assert.equal(r.stoppedBy, 'time');
  assert.equal(r.aborted, true);
  assert.equal(r.warned, true);
  assert.equal(r.text, 'timed report');
  assert.ok(commands(log).some((c) => c.cmd === 'abort'));
});

test('a reviewer that finishes without what the loop needs gets one follow-up ask', async () => {
  const { dir, log } = fakePi({ implementer: { turns: 2, texts: ['no verdict here'] }, wrapUp: { text: 'VERDICT: PASS' } });
  const r = await runStep(base(dir, { followUpFor: (t) => (/VERDICT/.test(t) ? undefined : 'give me a verdict') }));
  assert.equal(r.text, 'VERDICT: PASS');
  assert.equal(r.asks, 1);
  assert.equal(commands(log).at(-1).message, 'give me a verdict');
});

test('a pi that never answers is killed at the startup limit', async () => {
  const { dir } = fakePi({ stallFirstStart: ['implementer'] });
  const t = Date.now();
  const r = await runStep(base(dir, { startupSeconds: 1 }));
  assert.equal(r.stoppedBy, 'startup');
  assert.ok(Date.now() - t < 10_000);
});

test('a pi that won’t exit when told is killed, with everything it started', async () => {
  const { dir } = fakePi({ implementer: { turns: 2, hangOnClose: true, spawnSleeper: 'sleeper.pid' } });
  const r = await runStep(base(dir));
  assert.equal(r.stoppedBy, 'stuck');
  const pid = Number(readFileSync(join(dir, 'sleeper.pid'), 'utf8'));
  await new Promise((res) => setTimeout(res, 300));
  assert.throws(() => process.kill(pid, 0), 'the sleep child is gone');
});

test('an orderly exit still cleans up what pi left running', async () => {
  const { dir } = fakePi({ implementer: { turns: 2, spawnSleeper: 'sleeper.pid' } });
  const r = await runStep(base(dir));
  assert.equal(r.stoppedBy, undefined);
  const pid = Number(readFileSync(join(dir, 'sleeper.pid'), 'utf8'));
  await new Promise((res) => setTimeout(res, 300));
  assert.throws(() => process.kill(pid, 0), 'the sleep child is gone');
});

test('an abort signal stops a step', async () => {
  const { dir } = fakePi({ implementer: { turns: 'forever', delayMs: 20 } });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  const r = await runStep(base(dir, { limits: { maxTurns: 1000, maxMinutes: 1 }, signal: controller.signal }));
  assert.equal(r.stoppedBy, 'aborted');
});

test('a short step is not warned the moment it starts', async () => {
  const { dir, log } = fakePi({ implementer: { turns: 5, delayMs: 20 } });
  const r = await runStep(base(dir, { limits: { maxTurns: 100, maxMinutes: 1 }, warnMinutes: 2 }));
  assert.equal(r.warned, false);
  assert.equal(r.turns, 5);
  assert.ok(!commands(log).some((c) => c.cmd === 'steer'));
});
