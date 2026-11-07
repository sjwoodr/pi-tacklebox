import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sessionSearch, { isLocal } from '../../src/session-search/index.ts';
import { MAX_OUTPUT } from '../../src/session-search/search.ts';

const LOCAL = { id: 'made-up-model:latest', baseUrl: 'http://127.0.0.1:11434/v1' };

const user = (text: string) => ({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } });
const bash = (command: string, excludeFromContext = false) => ({ type: 'message', message: { role: 'bashExecution', command, output: 'bash-output-secret', excludeFromContext } });
const assistant = (...content: object[]) => ({ type: 'message', message: { role: 'assistant', content } });
const toolResult = (text: string) => ({ type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text }] } });

/** The extension loaded against a fake pi, with `sessions` as { 'dir/name.jsonl': [entries] } under its agent dir. */
function setup(sessions: Record<string, (object | string)[]> = {}, config: object = {}) {
  const agent = mkdtempSync(join(tmpdir(), 'tacklebox-'));
  writeFileSync(join(agent, 'tacklebox.json'), JSON.stringify({ sessionSearch: config }));
  for (const [path, entries] of Object.entries(sessions)) {
    const file = join(agent, 'sessions', path);
    mkdirSync(join(file, '..'), { recursive: true });
    const header = { type: 'session', timestamp: `${path.split('/')[1].slice(0, 10)}T00:00:00.000Z`, cwd: `/work/${path.split('/')[0]}` };
    writeFileSync(file, [header, ...entries].map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n'));
  }
  const tools: any[] = [];
  const commands = new Map<string, any>();
  process.env.PI_CODING_AGENT_DIR = agent;
  sessionSearch({
    registerTool: (tool: any) => void tools.push(tool),
    registerCommand: (name: string, command: any) => void commands.set(name, command),
  } as never);
  delete process.env.PI_CODING_AGENT_DIR;
  const notes: { text: string; type: string }[] = [];
  const ctx = (model: object | undefined = LOCAL, current?: string) => ({
    model,
    sessionManager: { getSessionFile: () => current && join(agent, 'sessions', current) },
    ui: { notify: (text: string, type: string) => void notes.push({ text, type }) },
  });
  const run = async (params: object, c = ctx()) => (await tools[0].execute('id', params, undefined, undefined, c)).content[0].text as string;
  return { tools, commands, run, ctx, notes };
}

test('on by default, and off when the config says so', () => {
  assert.equal(setup().tools[0].name, 'session_search');
  assert.ok(setup().commands.has('recall'));
  const off = setup({}, { enabled: false });
  assert.equal(off.tools.length, 0);
  assert.equal(off.commands.size, 0);
});

test('isLocal: a cloud model behind the local address is not local', () => {
  const url = LOCAL.baseUrl;
  for (const id of ['gpt-oss:120b-cloud', 'glm-5.3:cloud', 'kimi-k2.7-code:cloud', 'deepseek-v4-pro:cloud', 'beam:cloud']) {
    assert.equal(isLocal({ id, baseUrl: url }), false, id);
  }
  assert.equal(isLocal({ id: 'made-up', baseUrl: 'https://api.example.com/v1' }), false);
  assert.equal(isLocal({ id: 'made-up', baseUrl: 'not a url' }), false);
  assert.equal(isLocal(undefined), false);
  assert.equal(isLocal(LOCAL), true);
  assert.equal(isLocal({ id: 'made-up', baseUrl: 'http://localhost:11434' }), true);
});

test('refuses a non-local model, unless the config allows it', async () => {
  const sessions = { 'a/2026-01-01T00-00-00-000Z_x.jsonl': [user('find the widget')] };
  const cloud = { id: 'made-up:cloud', baseUrl: LOCAL.baseUrl };
  const { run, ctx } = setup(sessions);
  await assert.rejects(run({ regex: 'widget' }, ctx(cloud)), /isn't a local model/);
  const open = setup(sessions, { allowNonLocal: true });
  assert.match(await open.run({ regex: 'widget' }, open.ctx(cloud)), /1 match/);
});

test('files mode lists matching sessions newest first, across folders, with no matched text', async () => {
  const { run } = setup({
    'z/2026-01-01T00-00-00-000Z_old.jsonl': [user('the widget broke'), user('widget again')],
    'a/2026-03-01T00-00-00-000Z_new.jsonl': [user('a WIDGET in capitals')],
    'm/2026-02-01T00-00-00-000Z_none.jsonl': [user('nothing here')],
  });
  const lines = (await run({ regex: 'widget' })).split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^2026-03-01 {2}\/work\/a .*_new\.jsonl {2}\(1 match\)$/);
  assert.match(lines[1], /^2026-01-01 {2}\/work\/z .*_old\.jsonl {2}\(2 matches\)$/);
});

test('details mode shows what the user said and the commands that ran', async () => {
  const { run } = setup({
    'a/2026-01-01T00-00-00-000Z_x.jsonl': [
      user('please fix the widget'),
      assistant({ type: 'toolCall', name: 'bash', arguments: { command: 'grep widget src' } }),
      assistant({ type: 'toolCall', name: 'write', arguments: { path: 'widget.ts', content: 'write-body-secret' } }),
      bash('cat widget.txt'),
    ],
  });
  const out = await run({ regex: 'widget', mode: 'details' });
  assert.match(out, /please fix the widget/);
  assert.match(out, /bash: grep widget src/);
  assert.match(out, /write: widget\.ts/);
  assert.match(out, /\$ cat widget\.txt/);
  assert.doesNotMatch(out, /secret/);
});

test('tool output, thinking, replies and !! commands can be neither found nor shown', async () => {
  const { run } = setup({
    'a/2026-01-01T00-00-00-000Z_x.jsonl': [
      user('hello'),
      toolResult('tool-secret'),
      assistant({ type: 'thinking', thinking: 'think-secret' }, { type: 'text', text: 'reply-secret' }),
      bash('echo private-secret', true),
      bash('echo fine'),
      { type: 'compaction', summary: 'summary-secret' },
    ],
  });
  for (const mode of ['files', 'details']) {
    assert.match(await run({ regex: 'secret', mode }), /No past session matches/);
  }
  assert.doesNotMatch(await run({ regex: 'fine|hello', mode: 'details' }), /secret/);
});

test('skips broken lines and the session in progress', async () => {
  const { run, ctx } = setup({
    'a/2026-02-01T00-00-00-000Z_now.jsonl': [user('widget here')],
    'a/2026-01-01T00-00-00-000Z_old.jsonl': ['{"type":"message","mess', '', 'not json', user('widget there')],
  });
  const out = await run({ regex: 'widget' }, ctx(LOCAL, 'a/2026-02-01T00-00-00-000Z_now.jsonl'));
  assert.match(out, /_old\.jsonl/);
  assert.doesNotMatch(out, /_now\.jsonl/);
});

test('a limit stops at that many sessions and says more match', async () => {
  const sessions: Record<string, object[]> = {};
  for (let i = 1; i <= 4; i += 1) sessions[`a/2026-01-0${i}T00-00-00-000Z_s.jsonl`] = [user('widget')];
  const { run } = setup(sessions);
  const lines = (await run({ regex: 'widget', limit: 2 })).split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /2026-01-04/);
  assert.match(lines[2], /more sessions match/);
  assert.doesNotMatch(await run({ regex: 'widget', limit: 4 }), /more sessions/);
});

test('a huge message and many sessions stay under the output cap', async () => {
  const sessions: Record<string, object[]> = {};
  const huge = `${'x'.repeat(2_000_000)} widget ${'y'.repeat(2_000_000)}`;
  for (let i = 10; i < 60; i += 1) sessions[`a/2026-01-${i}T00-00-00-000Z_s.jsonl`] = Array(6).fill(user(huge));
  const { run } = setup(sessions);
  const out = await run({ regex: 'widget', mode: 'details', limit: 50 });
  assert.ok(out.length < MAX_OUTPUT + 200, String(out.length));
  assert.match(out, /output cut/);
  assert.match(out, /\.\.\.x+ widget y+\.\.\./);
});

test('a bad regex, an empty regex and no sessions all answer cleanly', async () => {
  const { run } = setup();
  await assert.rejects(run({ regex: '(' }), /Invalid regex/);
  await assert.rejects(run({ regex: '' }), /Give a regex/);
  assert.match(await run({ regex: 'widget' }), /No past session matches/);
});

test('/recall shows the same results, and reports errors', async () => {
  const { commands, ctx, notes } = setup({ 'a/2026-01-01T00-00-00-000Z_x.jsonl': [user('the widget')] });
  const recall = commands.get('recall');
  await recall.handler(' widget ', ctx());
  assert.equal(notes[0].type, 'info');
  assert.match(notes[0].text, /_x\.jsonl {2}\(1 match\)/);
  await recall.handler('', ctx());
  assert.deepEqual(notes[1], { text: 'Give a regex to search for.', type: 'error' });
  await recall.handler('widget', ctx({ id: 'made-up:cloud', baseUrl: LOCAL.baseUrl }));
  assert.equal(notes[2].type, 'error');
});
