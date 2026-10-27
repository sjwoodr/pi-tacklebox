import assert from 'node:assert/strict';
import { test } from 'node:test';
import { problemWith } from '../../src/nudge/reply.ts';

const reply = (text: string, extra: object = {}) => ({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }], ...extra });

test('tool-call markup written as text is a leaked call, for Gemma and Qwen formats', () => {
  assert.equal(problemWith(reply('<tool_call|><|tool_response>')), 'leaked');
  assert.equal(problemWith(reply('<|tool_call>call:edit{path:<|"|>a.ts<|"|>}<tool_call|>')), 'leaked');
  assert.equal(problemWith(reply("I'll read it.\n\n<function=read>\n<parameter=path>\na.ts\n</parameter>\n</function>\n</tool_call>")), 'leaked');
  assert.equal(problemWith(reply('call:bash{command:<|"|>ls<|"|>}')), 'leaked');
  // The UD, after a think-budget cut, in a real pi session (2026-10-27):
  assert.equal(problemWith(reply('I will now apply the change to `calc.js`.\n\n<edit_call>\n{\n  "path": "calc.js",\n  "oldText": "add"\n}\n</edit_call>')), 'leaked');
  assert.equal(problemWith(reply('<tool_code>\nprint(read("a.ts"))\n</tool_code>')), 'leaked');
});

test('an empty reply, and one that stops on an announced action', () => {
  assert.equal(problemWith({ role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', text: 'hmm' }] }), 'empty');
  assert.equal(problemWith(reply('   ')), 'empty');
  assert.equal(problemWith(reply('First, let me update `src/money.ts` to add the currency parameter:')), 'announced');
});

test('ordinary answers, tool calls, errors and aborts are left alone', () => {
  assert.equal(problemWith(reply('Done. The tests pass.')), undefined);
  assert.equal(problemWith(reply('Which cache do you mean: the product cache or the HTTP one?')), undefined);
  assert.equal(problemWith(reply('Let me read it:', { content: [{ type: 'text', text: 'Let me read it:' }, { type: 'toolCall' }] })), undefined);
  assert.equal(problemWith(reply('', { stopReason: 'error' })), undefined);
  assert.equal(problemWith(reply('', { stopReason: 'aborted' })), undefined);
  assert.equal(problemWith({ role: 'user', content: [] }), undefined);
  assert.equal(problemWith(undefined), undefined);
  assert.equal(problemWith(reply('Use the `<function>` tag in your template.')), undefined, 'markup talked about, not leaked');
});
