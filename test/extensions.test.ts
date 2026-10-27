import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import outlineReads from '../src/outline-reads/index.ts';
import search from '../src/search/index.ts';
import turnTimer from '../src/turn-timer/index.ts';

/** Loads an extension against a fake pi with the given tacklebox.json; returns what it hooked and registered. */
function load(extension: (pi: any) => void, config?: object) {
  const dir = mkdtempSync(join(tmpdir(), 'tacklebox-'));
  if (config) writeFileSync(join(dir, 'tacklebox.json'), JSON.stringify(config));
  const before = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const events: string[] = [];
  const tools: string[] = [];
  try {
    extension({ on: (event: string) => events.push(event), registerTool: (tool: { name: string }) => tools.push(tool.name) });
  } finally {
    if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = before;
  }
  return { events, tools };
}

test('with no tacklebox.json the turn timer runs, and outlines and search stay off', () => {
  assert.ok(load(turnTimer).events.includes('agent_end'));
  assert.deepEqual(load(outlineReads).events, []);
  assert.deepEqual(load(search).tools, []);
});

test('each extension follows its switch', () => {
  assert.deepEqual(load(turnTimer, { turnTimer: { enabled: false } }).events, []);
  assert.deepEqual(load(outlineReads, { outlineReads: { enabled: true } }).events, ['tool_result']);
  assert.deepEqual(load(search, { search: { backend: 'searxng' } }).tools, ['web_search', 'web_fetch']);
  assert.deepEqual(load(search, { search: { backend: 'ollama' } }).tools, ['web_search', 'web_fetch']);
});
