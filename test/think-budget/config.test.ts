import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseConfig } from '../../src/config.ts';
import { BUILT_IN, DEFAULT_RULES, loadRules } from '../../src/think-budget/index.ts';

const OWN = { provider: 'ollama', model: 'a', budget: 200 };
const OLD = { provider: 'ollama', model: 'b', budget: 400 };

function dir(files: { tacklebox?: object; old?: object | string }) {
  const d = mkdtempSync(join(tmpdir(), 'tacklebox-'));
  if (files.tacklebox) writeFileSync(join(d, 'tacklebox.json'), JSON.stringify(files.tacklebox));
  if (files.old) writeFileSync(join(d, 'think-budget.json'), typeof files.old === 'string' ? files.old : JSON.stringify(files.old));
  return d;
}

test("tacklebox.json's thinkBudget section comes first, and says the old file is ignored", () => {
  assert.deepEqual(loadRules(dir({ tacklebox: { thinkBudget: { rules: [OWN] } }, old: { rules: [OLD] } })), {
    rules: [OWN],
    source: 'tacklebox.json',
    ignored: 'think-budget.json',
  });
  assert.deepEqual(loadRules(dir({ tacklebox: { thinkBudget: { rules: [OWN] } } })), { rules: [OWN], source: 'tacklebox.json', ignored: undefined });
});

test('an empty rules list in tacklebox.json still wins: it is how to switch the old file off', () => {
  assert.deepEqual(loadRules(dir({ tacklebox: { thinkBudget: { rules: [] } }, old: { rules: [OLD] } })).rules, []);
});

test('without the section, think-budget.json is read as before', () => {
  assert.deepEqual(loadRules(dir({ tacklebox: { search: { backend: 'off' } }, old: { rules: [OLD] } })), { rules: [OLD], source: 'think-budget.json' });
  assert.deepEqual(loadRules(dir({ old: { rules: [OLD] } })).rules, [OLD]);
  assert.throws(() => loadRules(dir({ old: '{ broken' })), /^Error: think-budget\.json: /);
});

test('a malformed thinkBudget section is an error', () => {
  assert.throws(() => parseConfig({ thinkBudget: [OWN] }), /"thinkBudget" should be \{ "rules": \[\.\.\.\] \}/);
  assert.throws(() => parseConfig({ thinkBudget: { rule: [OWN] } }), /should be \{ "rules"/);
  assert.equal(parseConfig({}).thinkBudget, undefined);
});

test('with no rules anywhere, the built-in Gemma caps apply; any rules of your own replace them', () => {
  assert.deepEqual(loadRules(dir({})), { rules: DEFAULT_RULES, source: BUILT_IN });
  assert.deepEqual(loadRules(dir({ tacklebox: { search: { backend: 'off' } } })).source, BUILT_IN);
  assert.deepEqual(DEFAULT_RULES[0]!.budget, { minimal: 100, low: 200, medium: 400, high: 800 });
  assert.equal(DEFAULT_RULES[0]!.model, 'gemma*');
  assert.deepEqual(loadRules(dir({ old: { rules: [] } })).rules, [], 'an empty think-budget.json turns the default off');
  assert.deepEqual(loadRules(dir({ tacklebox: { thinkBudget: { rules: [] } } })).rules, [], 'so does an empty section');
});
