import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import repeatGuard, { callKey, ordinal } from '../../src/repeat-guard/index.ts';

type Handler = (event: any, ctx: any) => Promise<any> | any;

function load(settings: object = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tacklebox-'));
  writeFileSync(join(dir, 'tacklebox.json'), JSON.stringify({ repeatGuard: settings }));
  const handlers = new Map<string, Handler>();
  const before = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    repeatGuard({ on: (name: string, h: Handler) => void handlers.set(name, h) } as never);
  } finally {
    if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = before;
  }
  const ctx = { cwd: dir };
  const call = (name: string, event: object) => handlers.get(name)?.(event, ctx);
  let id = 0;
  /** One whole tool call as pi makes it: tool_call (which may refuse it), then tool_result if it ran. */
  const run = async (
    toolName: string,
    input: object,
    output: string,
    isError = false,
  ): Promise<{ refused?: string; text: string; noted: boolean }> => {
    const toolCallId = `c${++id}`;
    const refused = await call('tool_call', { toolName, toolCallId, input });
    if (refused?.block) return { refused: refused.reason as string, text: '', noted: false };
    const result = await call('tool_result', { toolName, toolCallId, input, isError, content: [{ type: 'text', text: output }] });
    return { text: (result?.content?.[0]?.text ?? output) as string, noted: result !== undefined };
  };
  return { handlers, call, run };
}

// The call MiMo made 46 times in a row.
const grep = { command: 'grep -n "def main\\|if __name__" /tmp/aip-mimo/ai-proxy; wc -l /tmp/aip-mimo/ai-proxy' };
const same = '606:def _run_self_test() -> int:\n===\n627 /tmp/aip-mimo/ai-proxy';

test('the 3rd identical call with identical output gets a note, and so does each one after it', async () => {
  const { run } = load();
  assert.equal((await run('bash', grep, same)).noted, false);
  assert.equal((await run('bash', grep, same)).noted, false);
  const third = await run('bash', grep, same);
  assert.equal(
    third.text,
    `${same}\n\nrepeat-guard: this is the 3rd time in a row you have made this exact bash call, and its output is the same as ` +
      'the last 2 times. Running it again will only show the same thing. Use what it already shows: if something you are ' +
      'looking for is not in it, it is not there yet. Take a different next step: write or change what is missing, run ' +
      'something else, or say what you are stuck on.',
  );
  assert.match((await run('bash', grep, same)).text, /this is the 4th time in a row .* the same as the last 3 times\./);
});

test('after 5 identical results the same call is refused until a different one is made', async () => {
  const { run } = load();
  for (let i = 0; i < 5; i++) assert.equal((await run('bash', grep, same)).refused, undefined, `call ${i + 1} runs`);
  const sixth = await run('bash', grep, same);
  assert.equal(
    sixth.refused,
    'repeat-guard: not run. You have made this exact bash call 5 times in a row and got the same output every time, so it ' +
      'would only return the same again (its output is in the earlier results). Take a different next step: write or ' +
      'change what is missing, run something else, or say what you are stuck on.',
  );
  assert.ok((await run('bash', grep, same)).refused, 'still refused while nothing else has run');
  assert.equal((await run('read', { path: '/tmp/aip-mimo/ai-proxy', offset: 600 }, 'lines 600-627')).refused, undefined);
  const again = await run('bash', grep, same);
  assert.equal(again.refused, undefined, 'a different call in between ends the streak');
  assert.equal(again.noted, false);
});

test('a call whose output changes never builds a streak (polling a log that grows)', async () => {
  const { run } = load();
  const tail = { command: 'tail -3 build.log' };
  for (let i = 0; i < 8; i++) {
    const out = await run('bash', tail, `step ${i} of 8`);
    assert.equal(out.noted, false);
    assert.equal(out.refused, undefined);
  }
});

test('the same output from a different call, or a different tool, does not count', async () => {
  const { run } = load();
  await run('bash', { command: 'ls' }, 'a.py');
  await run('bash', { command: 'ls .' }, 'a.py');
  await run('bash', { command: 'ls' }, 'a.py');
  assert.equal((await run('bash', { command: 'ls' }, 'a.py')).noted, false, 'only 2 in a row');
  assert.equal((await run('read', { command: 'ls' }, 'a.py')).noted, false);
});

test('a failed result repeats too; the same text as a success is a different output', async () => {
  const { run } = load();
  await run('edit', { path: 'a.py', edits: [] }, 'Could not find the text', true);
  await run('edit', { path: 'a.py', edits: [] }, 'Could not find the text', true);
  assert.equal((await run('edit', { path: 'a.py', edits: [] }, 'Could not find the text', true)).noted, true);
  assert.equal((await run('edit', { path: 'a.py', edits: [] }, 'Could not find the text', false)).noted, false);
});

test('a new session starts with no streak', async () => {
  const { run, call } = load();
  for (let i = 0; i < 5; i++) await run('bash', grep, same);
  await call('session_start', {});
  const out = await run('bash', grep, same);
  assert.equal(out.refused, undefined);
  assert.equal(out.noted, false);
});

test('argument order does not make a call different', () => {
  assert.equal(callKey('read', { path: 'a', offset: 1, limit: 5 }), callKey('read', { limit: 5, offset: 1, path: 'a' }));
  assert.notEqual(callKey('read', { path: 'a' }), callKey('read', { path: 'b' }));
  assert.notEqual(callKey('read', { path: 'a' }), callKey('ls', { path: 'a' }));
});

test('noteAt and blockAt move the thresholds; blockAt 0 never refuses; enabled false turns it off', async () => {
  const early = load({ noteAt: 2, blockAt: 2 });
  await early.run('bash', grep, same);
  assert.match((await early.run('bash', grep, same)).text, /2nd time in a row .* the same as the last time\./);
  assert.ok((await early.run('bash', grep, same)).refused);

  const never = load({ blockAt: 0 });
  assert.deepEqual([...never.handlers.keys()].sort(), ['session_start', 'tool_result']);
  for (let i = 0; i < 9; i++) assert.equal((await never.run('bash', grep, same)).refused, undefined);

  assert.deepEqual([...load({ enabled: false }).handlers.keys()], []);
  assert.deepEqual([...load().handlers.keys()].sort(), ['session_start', 'tool_call', 'tool_result']);
});

test('ordinals', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal), [
    '1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th',
  ]);
});
