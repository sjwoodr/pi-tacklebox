import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import nudge from '../../src/nudge/index.ts';

function load(maxPerPrompt = 2) {
  const dir = mkdtempSync(join(tmpdir(), 'tacklebox-'));
  writeFileSync(join(dir, 'tacklebox.json'), JSON.stringify({ nudge: { enabled: true, maxPerPrompt } }));
  const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
  process.env.PI_CODING_AGENT_DIR = dir;
  nudge({ on: (name: string, h: any) => void handlers.set(name, h) } as never);
  delete process.env.PI_CODING_AGENT_DIR;
  const ctx = { hasUI: false };
  const prompt = () => handlers.get('before_agent_start')!({ messageType: 'user' }, ctx);
  const settle = (text: string, extra: object = {}) =>
    handlers.get('agent_before_settle')!(
      { outcome: 'completed', continue: false, entries: [], context: { contextMessages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] }] }, ...extra },
      ctx,
    );
  return { prompt, settle };
}

test('a leaked call gets a message saying so and one more request', async () => {
  const { settle } = load();
  const out = await settle('<tool_call|><|tool_response>');
  assert.equal(out.continue, true);
  assert.equal(out.entries[0].type, 'custom_message');
  assert.match(out.entries[0].content, /came out as plain text instead of a tool call/);
});

test('at most maxPerPrompt nudges per prompt, counted again after a new prompt', async () => {
  const { prompt, settle } = load(2);
  await prompt();
  assert.ok(await settle(''));
  assert.ok(await settle(''));
  assert.equal(await settle(''), undefined);
  await prompt();
  assert.ok(await settle(''));
});

test('nothing when the reply is fine, the run was aborted, or another check already continues', async () => {
  const { settle } = load();
  assert.equal(await settle('All done.'), undefined);
  assert.equal(await settle('', { outcome: 'aborted' }), undefined);
  assert.equal(await settle('', { continue: true }), undefined);
});
