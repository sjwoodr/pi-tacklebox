import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import editAssist from '../../src/edit-assist/index.ts';

type Handler = (event: any, ctx: any) => Promise<any>;

function load(settings: object = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tacklebox-'));
  writeFileSync(join(dir, 'tacklebox.json'), JSON.stringify({ editAssist: settings }));
  const handlers = new Map<string, Handler>();
  const before = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    editAssist({ on: (name: string, h: Handler) => void handlers.set(name, h) } as never);
  } finally {
    if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = before;
  }
  const ctx = { cwd: dir };
  return { dir, handlers, call: (name: string, event: object) => handlers.get(name)!(event, ctx) };
}

const script = Array.from({ length: 40 }, (_, i) => `step_${i + 1}()`).join('\n');
const text = (s: string) => [{ type: 'text', text: s }];

test('an edit whose oldText is not in the file gets the closest current lines added to its error', async () => {
  const { dir, call } = load();
  writeFileSync(join(dir, 'app.py'), script.replace('step_20()', 'step_20(fast=True)'));
  const error = 'Could not find the exact text in app.py. The old text must match exactly including all whitespace and newlines.';
  const out = await call('tool_result', {
    toolName: 'edit',
    toolCallId: '1',
    isError: true,
    input: { path: 'app.py', edits: [{ oldText: 'step_19()\nstep_20()\nstep_21()', newText: 'x' }] },
    content: text(error),
  });
  const said = out.content[0].text as string;
  assert.ok(said.startsWith(`${error}\n\nedit-assist: This oldText is not in the file as it is now. The closest stretch is lines 19-21`));
  assert.match(said, /line 20 of the file: "step_20\(fast=True\)"\n {2}your oldText has: {3}"step_20\(\)"/);
});

test('with several edits, the one pi names is the one matched', async () => {
  const { dir, call } = load();
  writeFileSync(join(dir, 'app.py'), script);
  const out = await call('tool_result', {
    toolName: 'edit',
    toolCallId: '1',
    isError: true,
    input: { path: join(dir, 'app.py'), edits: [{ oldText: 'step_1()', newText: 'a' }, { oldText: 'step_5()\nstep_6(x)', newText: 'b' }] },
    content: text(`Could not find edits[1] in ${join(dir, 'app.py')}. The oldText must match exactly including all whitespace and newlines.`),
  });
  assert.match(out.content[0].text, /This edits\[1\]\.oldText is not in the file as it is now\. The closest stretch is lines 5-6/);
});

test('other edit errors, successful edits and unreadable files are left alone', async () => {
  const { dir, call } = load();
  writeFileSync(join(dir, 'app.py'), script);
  const edit = (content: string, extra: object = {}) =>
    call('tool_result', { toolName: 'edit', toolCallId: '1', isError: true, input: { path: 'app.py', edits: [{ oldText: 'nope', newText: 'x' }] }, content: text(content), ...extra });
  assert.equal(await edit('Found 2 occurrences of the text in app.py. The text must be unique.'), undefined);
  assert.equal(await edit('Successfully replaced 1 block(s) in app.py.', { isError: false }), undefined);
  assert.equal(
    await call('tool_result', { toolName: 'edit', toolCallId: '1', isError: true, input: { path: 'gone.py', edits: [{ oldText: 'x', newText: 'y' }] }, content: text('Could not find the exact text in gone.py.') }),
    undefined,
  );
});

test('a write that would drop most of a file is refused once; the same write again goes through', async () => {
  const { dir, call } = load();
  writeFileSync(join(dir, 'app.py'), script);
  const partThree = Array.from({ length: 30 }, (_, i) => `part_three_${i}()`).join('\n');
  const write = (content: string, id = 'w1') => call('tool_call', { toolName: 'write', toolCallId: id, input: { path: 'app.py', content } });

  const refused = await write(partThree);
  assert.equal(refused.block, true);
  assert.match(refused.reason, /^edit-assist: not written\. app\.py has 40 lines, and this write would keep only 0% of them \(the new content has 30 lines\)/);
  assert.match(refused.reason, /cat >> app\.py <<'EOF'/);
  assert.equal(await write(partThree, 'w2'), undefined, 'sent again unchanged, it is allowed');
  assert.equal((await write(partThree, 'w3'))?.block, true, 'one pass per refusal, not a permanent pass');
});

test('writes that keep the file, new files and small files pass the guard', async () => {
  const { dir, call } = load();
  writeFileSync(join(dir, 'app.py'), script);
  writeFileSync(join(dir, 'tiny.py'), 'a = 1\nb = 2');
  const write = (path: string, content: string) => call('tool_call', { toolName: 'write', toolCallId: 'w', input: { path, content } });
  assert.equal(await write('app.py', `${script}\nstep_41()`), undefined);
  assert.equal(await write('new.py', 'anything'), undefined);
  assert.equal(await write('tiny.py', ''), undefined);
  assert.equal(await call('tool_call', { toolName: 'bash', toolCallId: 'b', input: { command: 'true' } }), undefined);
});

test('a write that re-sends a whole file for a one-line change gets a note to use edit', async () => {
  const { dir, call } = load();
  writeFileSync(join(dir, 'app.py'), script);
  const changed = script.replace('step_7()', 'step_7(retry=True)');
  assert.equal(await call('tool_call', { toolName: 'write', toolCallId: 'w', input: { path: 'app.py', content: changed } }), undefined);
  const out = await call('tool_result', { toolName: 'write', toolCallId: 'w', isError: false, input: { path: 'app.py', content: changed }, content: text('Successfully wrote to app.py') });
  assert.match(out.content[0].text, /^Successfully wrote to app\.py\n\nedit-assist: this write sent all 40 lines of app\.py again to change about 2 of them\./);
  // Once only: the record is used up.
  assert.equal(await call('tool_result', { toolName: 'write', toolCallId: 'w', isError: false, input: { path: 'app.py', content: changed }, content: text('ok') }), undefined);
});

test('a tool result rejected for missing arguments gets the call shape and the file last worked on', async () => {
  const { call } = load();
  await call('tool_result', { toolName: 'read', toolCallId: 'r', isError: false, input: { path: '/tmp/aip/ai-proxy' }, content: text('…') });
  const message = {
    role: 'toolResult',
    toolCallId: 'e',
    toolName: 'edit',
    isError: true,
    content: text('Validation failed for tool "edit":\n  - path: missing\n\nReceived arguments:\n{"edits": []}'),
  };
  const out = await call('message_end', { message });
  assert.equal(out.message.role, 'toolResult');
  assert.equal(out.message.toolCallId, 'e');
  assert.match(out.message.content[0].text, /\n\nedit-assist: edit's arguments must look like this[\s\S]*"path" was missing\. The file you last worked on is \/tmp\/aip\/ai-proxy\.$/);
  assert.equal(await call('message_end', { message: { ...message, isError: false } }), undefined);
  assert.equal(await call('message_end', { message: { role: 'assistant', content: text('hi') } }), undefined);
});

test('each part follows its switch, and enabled: false turns all of them off', async () => {
  assert.deepEqual([...load().handlers.keys()].sort(), ['message_end', 'tool_call', 'tool_result']);
  assert.deepEqual([...load({ argumentHints: false, writeGuard: false }).handlers.keys()], ['tool_result']);
  assert.deepEqual([...load({ enabled: false }).handlers.keys()], []);

  const { dir, call } = load({ closestMatch: false });
  writeFileSync(join(dir, 'app.py'), script);
  const miss = await call('tool_result', {
    toolName: 'edit',
    toolCallId: '1',
    isError: true,
    input: { path: 'app.py', edits: [{ oldText: 'step_1(x)', newText: 'y' }] },
    content: text('Could not find the exact text in app.py.'),
  });
  assert.equal(miss, undefined);
});
