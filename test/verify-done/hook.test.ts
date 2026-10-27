import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import verifyDone from '../../src/verify-done/index.ts';

/** A project whose tests pass while ./status holds 0; and verify-done loaded against it. */
function setup(maxRounds = 2) {
  const agent = mkdtempSync(join(tmpdir(), 'tacklebox-'));
  writeFileSync(join(agent, 'tacklebox.json'), JSON.stringify({ verifyDone: { enabled: true, command: 'echo checked; exit $(cat status)', maxRounds } }));
  const cwd = mkdtempSync(join(tmpdir(), 'tacklebox-project-'));
  const status = (code: number) => writeFileSync(join(cwd, 'status'), String(code));
  status(0);
  const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
  process.env.PI_CODING_AGENT_DIR = agent;
  verifyDone({ on: (name: string, h: any) => void handlers.set(name, h) } as never);
  delete process.env.PI_CODING_AGENT_DIR;
  const ctx = { hasUI: false, cwd };
  return {
    status,
    prompt: () => handlers.get('before_agent_start')!({ messageType: 'user' }, ctx),
    call: (toolName: string, input: object = {}) => handlers.get('tool_call')!({ toolName, input }, ctx),
    settle: (extra: object = {}) => handlers.get('agent_before_settle')!({ outcome: 'completed', continue: false, entries: [], context: {}, ...extra }, ctx),
  };
}

test('an edit that breaks the tests gets the output and another request, up to maxRounds', async () => {
  const { status, prompt, call, settle } = setup(2);
  await prompt();
  await call('edit');
  status(1);
  const first = await settle();
  assert.equal(first.continue, true);
  assert.match(first.entries[0].content, /^The tests fail after your changes \(`echo checked; exit \$\(cat status\)`, exit 1\):/);
  assert.match(first.entries[0].content, /checked/);
  assert.ok(await settle());
  assert.equal(await settle(), undefined, 'stops after maxRounds');
});

test('passing tests, no edits, or tests that already failed: no message', async () => {
  const pass = setup();
  await pass.prompt();
  await pass.call('write');
  assert.equal(await pass.settle(), undefined);

  const readOnly = setup();
  await readOnly.prompt();
  await readOnly.call('read');
  await readOnly.call('bash', { command: 'grep -rn foo src 2>&1' });
  readOnly.status(1);
  assert.equal(await readOnly.settle(), undefined, 'reading and grepping are not edits');

  const broken = setup();
  broken.status(1);
  await broken.prompt();
  await broken.call('edit');
  assert.equal(await broken.settle(), undefined, 'a suite that failed before the edit is not blamed on it');
});

test('a shell edit counts, and a check already continuing waits its turn', async () => {
  const { status, prompt, call, settle } = setup();
  await prompt();
  await call('bash', { command: "sed -i 's/a/b/' src/x.ts" });
  status(1);
  assert.equal(await settle({ continue: true }), undefined);
  assert.ok(await settle());
});
