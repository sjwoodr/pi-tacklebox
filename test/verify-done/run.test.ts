import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { runTests, TAIL_LINES } from '../../src/verify-done/run.ts';

test('a passing and a failing command, with the end of the output', async () => {
  assert.deepEqual(await runTests('echo fine', tmpdir(), 5), { ok: true, code: 0, tail: 'fine' });
  const fail = await runTests('for i in $(seq 1 100); do echo line $i; done; echo oops >&2; exit 3', tmpdir(), 5);
  assert.equal(fail.ok, false);
  assert.equal(fail.code, 3);
  const lines = fail.tail.split('\n');
  assert.equal(lines.length, TAIL_LINES);
  assert.equal(lines.at(-1), 'oops');
});

test('a run past the timeout is killed and reported as timed out', async () => {
  const start = Date.now();
  const run = await runTests('sleep 30', tmpdir(), 1);
  assert.equal(run.ok, false);
  assert.equal(run.code, undefined);
  assert.ok(Date.now() - start < 5000);
});
