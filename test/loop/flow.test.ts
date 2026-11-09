import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseWorkflow, plannerPrompt, saveWorkflow } from '../../src/loop/flow.ts';
import { testConfig } from './helpers.ts';

const good = { description: 'one step', nodes: [{ id: 'only', agent: 'implementer', prompt: '{task}' }] };

test('the planner prompt names the models, the rules and the tool', () => {
  const cfg = testConfig('/tmp/x');
  const p = plannerPrompt('two models try it, main picks', cfg, 'ollama/gemma4:latest');
  assert.match(p, /two models try it, main picks/);
  assert.match(p, /"implementer" \(fake\/impl\), "reviewer" \(fake\/rev\), "main"\s+\(ollama\/gemma4:latest\)/);
  assert.match(p, /"verdict": true makes a step end with a VERDICT line/, 'how a non-reviewer model judges');
  assert.match(p, /use "role": "helper"/);
  assert.match(p, /Call flow_run with "task"/);
  assert.match(p, /"review-loop"|"id":"implement"/);
});

test('parseWorkflow takes JSON, fenced JSON or an object, and names a JSON mistake', () => {
  assert.deepEqual(parseWorkflow(JSON.stringify(good)).workflow, good);
  assert.deepEqual(parseWorkflow('```json\n' + JSON.stringify(good) + '\n```').workflow, good);
  assert.deepEqual(parseWorkflow(good).workflow, good);
  assert.match(parseWorkflow('{ nodes: [').error ?? '', /not valid JSON/);
});

test('saveWorkflow adds to tacklebox.json and keeps the rest; it refuses built-in names, bad names and broken workflows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tacklebox-flow-'));
  writeFileSync(join(dir, 'tacklebox.json'), JSON.stringify({ bang: { enabled: false }, loop: { enabled: true } }));
  saveWorkflow('quick', good as never, dir);
  const saved = JSON.parse(readFileSync(join(dir, 'tacklebox.json'), 'utf8'));
  assert.deepEqual(saved.bang, { enabled: false });
  assert.equal(saved.loop.enabled, true);
  assert.deepEqual(saved.loop.workflows.quick, good);
  assert.throws(() => saveWorkflow('review-loop', good as never, dir), /built-in/);
  assert.throws(() => saveWorkflow('Bad Name', good as never, dir), /lowercase/);
  assert.throws(() => saveWorkflow('bad', { nodes: [{ id: 'x', agent: 'nobody', prompt: 'p' }] } as never, dir), /agent "nobody"/);
});

test('flow_run: problems go back to the model; the user can edit, then cancel, and nothing runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tacklebox-flow-ext-'));
  writeFileSync(join(dir, 'tacklebox.json'), JSON.stringify({ loop: { enabled: true, implementer: { model: 'a/b' }, reviewer: { model: 'c/d' } } }));
  const before = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const { default: loop } = await import('../../src/loop/index.ts');
    const tools: Record<string, any> = {};
    loop({ registerCommand: () => {}, registerTool: (t: any) => (tools[t.name] = t), on: () => {}, sendMessage: () => {} } as never);
    const choices = ['Edit', 'Cancel'];
    const shown: string[] = [];
    const ctx = {
      hasUI: true, cwd: dir, model: { provider: 'ollama', id: 'gemma4' },
      modelRegistry: { getAll: () => [{ provider: 'a', id: 'b' }, { provider: 'c', id: 'd' }, { provider: 'ollama', id: 'gemma4' }] },
      ui: {
        select: async (title: string) => { shown.push(title); return choices.shift(); },
        editor: async (_t: string, prefill: string) => prefill.replace('"{task}"', '"{task} carefully"'),
        notify: () => {},
      },
    };
    const run = (workflow: string) => tools.flow_run.execute('id', { task: 'the job', workflow }, undefined, undefined, ctx);
    const bad = await run('{"nodes":[{"id":"x","agent":"nobody","prompt":"p"}]}');
    assert.match(bad.content[0].text, /problems; fix them[\s\S]*agent "nobody"/);
    const unknown = await run('{"nodes":[{"id":"x","agent":"gemma/gemma4","prompt":"p"}]}');
    assert.match(unknown.content[0].text, /problems; fix them[\s\S]*"x": pi has no model "gemma\/gemma4"; did you mean ollama\/gemma4\?/);
    const cancelled = await run(JSON.stringify(good));
    assert.match(cancelled.content[0].text, /cancelled/);
    assert.equal(shown.length, 2, 'shown, edited, shown again');
    assert.match(shown[0], /only: implementer \(a\/b\)/);
    assert.match(shown[1], /\{task\} carefully/);
  } finally {
    if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = before;
  }
});
