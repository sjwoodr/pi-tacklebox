import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runLoop } from '../../src/loop/loop.ts';
import { FAKE_PI, fakePi, gitRepo, testConfig } from './helpers.ts';

const calls = (log: string) => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const kinds = (r: Awaited<ReturnType<typeof runLoop>>) => r.steps.map((s) => `${s.role}:${s.kind}`);

test('a clean first review ends the loop: implement, review, passed; report written', async () => {
  const { dir } = fakePi({ implementer: { turns: 2, writeFile: 'work.txt' }, reviewer: { turns: 2, texts: ['[minor] naming\nVERDICT: PASS'] } });
  const repo = gitRepo();
  const r = await runLoop({ task: 'do the thing', cwd: repo, config: testConfig(join(dir, 'runs')), piCommand: FAKE_PI });
  assert.equal(r.outcome, 'passed');
  assert.deepEqual(kinds(r), ['implementer:implement', 'reviewer:review']);
  assert.ok(r.finalGates.every((g) => g.ok));
  assert.ok(existsSync(r.reportFile));
  assert.match(readFileSync(r.reportFile, 'utf8'), /Outcome: passed/);
});

test('changes, then a pass: implement, review, apply, review', async () => {
  const { dir } = fakePi({
    implementer: { turns: 1, writeFile: 'work.txt' },
    reviewer: { turns: 1, texts: ['[critical] no tests\nVERDICT: CHANGES', 'VERDICT: PASS'] },
  });
  const r = await runLoop({ task: 't', cwd: gitRepo(), config: testConfig(join(dir, 'runs')), piCommand: FAKE_PI });
  assert.equal(r.outcome, 'passed');
  assert.deepEqual(kinds(r), ['implementer:implement', 'reviewer:review', 'implementer:apply', 'reviewer:review']);
});

test('the reviewer works in a copy, not the repo', async () => {
  const { dir, log } = fakePi({ implementer: { turns: 1, writeFile: 'work.txt' }, reviewer: { turns: 1, texts: ['VERDICT: PASS'], writeFile: 'reviewer-was-here.txt' } });
  const repo = gitRepo();
  await runLoop({ task: 't', cwd: repo, config: testConfig(join(dir, 'runs')), piCommand: FAKE_PI });
  assert.ok(!existsSync(join(repo, 'reviewer-was-here.txt')), 'the reviewer’s write stayed in its copy');
  assert.ok(existsSync(join(repo, 'work.txt')));
  assert.equal(calls(log).filter((c) => c.role === 'reviewer' && c.cmd === 'start').length, 1);
});

test('an apply step that changes nothing stops the loop: no progress', async () => {
  const { dir } = fakePi({ implementer: { turns: 1 }, reviewer: { turns: 1, texts: ['[high] bug\nVERDICT: CHANGES'] } });
  const r = await runLoop({ task: 't', cwd: gitRepo(), config: testConfig(join(dir, 'runs')), piCommand: FAKE_PI });
  assert.equal(r.outcome, 'no progress');
});

test('the round limit stops a reviewer that never passes', async () => {
  const { dir } = fakePi({ implementer: { turns: 1, writeFile: 'work.txt' }, reviewer: { turns: 1, texts: ['[high] still wrong\nVERDICT: CHANGES'] } });
  const r = await runLoop({ task: 't', cwd: gitRepo(), config: testConfig(join(dir, 'runs'), { maxRounds: 2 }), piCommand: FAKE_PI });
  assert.equal(r.outcome, 'rounds used up');
  assert.equal(r.steps.filter((s) => s.kind === 'review').length, 2);
});

test('a reviewer that ignores the warning is aborted at its turn limit and asked in the same process; the report counts', async () => {
  const { dir, log } = fakePi({
    implementer: { turns: 1, writeFile: 'work.txt' },
    reviewer: { turns: 'forever', delayMs: 4, ignoreSteer: true },
    wrapUp: { text: '[minor] partial review\nVERDICT: PASS' },
  });
  const cfg = testConfig(join(dir, 'runs'));
  cfg.reviewer.maxTurns = 6;
  const r = await runLoop({ task: 't', cwd: gitRepo(), config: cfg, piCommand: FAKE_PI });
  const review = r.steps.find((s) => s.kind === 'review')!;
  assert.equal(review.stoppedBy, 'turns');
  assert.ok(review.warned && review.wrappedUp);
  assert.equal(r.outcome, 'passed');
  const rev = calls(log).filter((c) => c.role === 'reviewer');
  assert.equal(rev.filter((c) => c.cmd === 'start').length, 1, 'one reviewer process: no resume');
  assert.deepEqual(rev.filter((c) => c.cmd !== 'start').map((c) => c.cmd), ['get_state', 'prompt', 'steer', 'abort', 'prompt']);
});

test('a reviewer that heeds the warning finishes on its own with its verdict', async () => {
  const { dir, log } = fakePi({
    implementer: { turns: 1, writeFile: 'work.txt' },
    reviewer: { turns: 'forever', delayMs: 4, steeredText: '[minor] nit\nVERDICT: PASS' },
  });
  const cfg = testConfig(join(dir, 'runs'));
  cfg.reviewer.maxTurns = 8;
  const r = await runLoop({ task: 't', cwd: gitRepo(), config: cfg, piCommand: FAKE_PI });
  const review = r.steps.find((s) => s.kind === 'review')!;
  assert.equal(review.stoppedBy, undefined);
  assert.ok(review.warned);
  assert.equal(r.outcome, 'passed');
  assert.ok(!calls(log).some((c) => c.cmd === 'abort'));
});

test('a failing check goes straight back to the implementer before any review', async () => {
  const { dir } = fakePi({ implementer: { turns: 1, writeFile: 'work.txt' }, reviewer: { turns: 1, texts: ['VERDICT: PASS'] } });
  // Passes once the implementer has been called twice (implement + gate-fix).
  const gate = `test "$(wc -l < work.txt)" -ge 2`;
  const r = await runLoop({ task: 't', cwd: gitRepo(), config: testConfig(join(dir, 'runs'), { gates: [gate] }), piCommand: FAKE_PI });
  assert.deepEqual(kinds(r), ['implementer:implement', 'implementer:gate-fix', 'reviewer:review']);
  assert.equal(r.steps[0].gates?.[0].ok, false);
  assert.equal(r.steps[1].gates?.[0].ok, true);
  assert.equal(r.outcome, 'passed');
});

test('aborting stops the loop', async () => {
  const { dir } = fakePi({ implementer: { turns: 'forever', delayMs: 20 } });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  const r = await runLoop({ task: 't', cwd: gitRepo(), config: testConfig(join(dir, 'runs')), piCommand: FAKE_PI, signal: controller.signal });
  assert.equal(r.outcome, 'aborted');
});

test('the report shows read/s and write/s per role and in total', async () => {
  const { dir } = fakePi({ implementer: { turns: 2, writeFile: 'w.txt' }, reviewer: { turns: 2, texts: ['VERDICT: PASS'] } });
  const r = await runLoop({ task: 't', cwd: gitRepo(), config: testConfig(join(dir, 'runs')), piCommand: FAKE_PI });
  assert.match(r.markdown, /- implementer: read \d+\/s, write \d+\/s/);
  assert.match(r.markdown, /- reviewer: read \d+\/s, write \d+\/s/);
  assert.match(r.markdown, /- total: read \d+\/s, write \d+\/s/);
});

test('the report says "no checks" when there are none, and session ids are told apart', async () => {
  const { dir } = fakePi({ implementer: { turns: 1, writeFile: 'w.txt' }, reviewer: { turns: 1, texts: ['VERDICT: PASS'] } });
  const r = await runLoop({ task: 't', cwd: gitRepo(), config: testConfig(join(dir, 'runs'), { gates: [] }), piCommand: FAKE_PI });
  assert.match(r.markdown, /implementer implement → no checks/);
  assert.doesNotMatch(r.markdown, /checks ok/);
  const ids = r.steps.map((s) => s.sessionId!.slice(-12));
  assert.equal(new Set(ids).size, ids.length);
});

test('a final ask that still has no verdict ends the loop: no verdict, no apply step', async () => {
  const { dir } = fakePi({
    implementer: { turns: 1, writeFile: 'work.txt' },
    reviewer: { turns: 'forever', delayMs: 4, ignoreSteer: true },
    wrapUp: { text: 'All checks done. Let me verify one more thing.' },
  });
  const cfg = testConfig(join(dir, 'runs'));
  cfg.reviewer.maxTurns = 5;
  const r = await runLoop({ task: 't', cwd: gitRepo(), config: cfg, piCommand: FAKE_PI });
  assert.equal(r.outcome, 'no verdict');
  assert.deepEqual(kinds(r), ['implementer:implement', 'reviewer:review']);
});

test('a reviewer with no verdict even when asked again ends the loop: no verdict, and no apply step', async () => {
  const { dir } = fakePi({
    implementer: { turns: 1, writeFile: 'work.txt' },
    reviewer: { turns: 2, texts: ['I looked around.'] },
    wrapUp: { text: 'Still looking.' },
  });
  const r = await runLoop({ task: 't', cwd: gitRepo(), config: testConfig(join(dir, 'runs')), piCommand: FAKE_PI });
  assert.equal(r.outcome, 'no verdict');
  assert.deepEqual(kinds(r), ['implementer:implement', 'reviewer:review']);
});

test('a reviewer that finishes on its own without a verdict is asked once for it', async () => {
  const { dir, log } = fakePi({
    implementer: { turns: 1, writeFile: 'work.txt' },
    reviewer: { turns: 2, texts: ['Looks fine overall.'] },
    wrapUp: { text: 'VERDICT: PASS' },
  });
  const r = await runLoop({ task: 't', cwd: gitRepo(), config: testConfig(join(dir, 'runs')), piCommand: FAKE_PI });
  assert.equal(calls(log).filter((c) => c.role === 'reviewer' && c.cmd === 'prompt').length, 2, 'the review prompt plus one follow-up');
  assert.equal(r.outcome, 'passed');
});

test('a pi that never starts its session is killed and retried once; the report notes the stall', async () => {
  const { dir } = fakePi({ stallFirstStart: ['reviewer'], implementer: { turns: 1, writeFile: 'work.txt' }, reviewer: { turns: 1, texts: ['VERDICT: PASS'] } });
  const cfg = testConfig(join(dir, 'runs'), { startupSeconds: 1 });
  const t0 = Date.now();
  const r = await runLoop({ task: 't', cwd: gitRepo(), config: cfg, piCommand: FAKE_PI });
  assert.equal(r.outcome, 'passed');
  const review = r.steps.find((s) => s.kind === 'review')!;
  assert.equal(review.startupStalls, 1);
  assert.match(r.markdown, /1 startup stall/);
  assert.ok(Date.now() - t0 < 30_000, 'the stall cost about a second, not ten minutes');
});

test('steps run with PI_OFFLINE=1', async () => {
  const { dir } = fakePi({ implementer: { turns: 1, writeFile: 'w.txt' }, reviewer: { turns: 1, texts: ['VERDICT: PASS'] } });
  process.env.FAKE_PI_ENV_LOG = join(dir, 'env.log');
  await runLoop({ task: 't', cwd: gitRepo(), config: testConfig(join(dir, 'runs')), piCommand: FAKE_PI });
  delete process.env.FAKE_PI_ENV_LOG;
  const seen = readFileSync(join(dir, 'env.log'), 'utf8').trim().split('\n');
  assert.ok(seen.length >= 2 && seen.every((v) => v === '1'), seen.join(','));
});
