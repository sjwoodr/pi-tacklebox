import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import { type Attempt, budgetFor, type Rule, streamWithBudget } from '../src/cap.ts';

const usage = () => ({
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const message = (content: AssistantMessage['content']): AssistantMessage => ({
  role: 'assistant',
  content,
  api: 'openai-completions',
  provider: 'ollama',
  model: 'm',
  usage: usage(),
  stopReason: 'stop',
  timestamp: 0,
});

/** A model that thinks `thoughts` tokens, then says `text` (none when empty). */
function reply(thoughts: number, text: string, onAbort?: () => void) {
  return async function* (signal: AbortSignal): AsyncGenerator<AssistantMessageEvent> {
    signal.addEventListener('abort', () => onAbort?.());
    const content: AssistantMessage['content'] = [];
    const partial = () => message(structuredClone(content));
    yield { type: 'start', partial: partial() };
    if (thoughts) {
      content.push({ type: 'thinking', thinking: '' });
      yield { type: 'thinking_start', contentIndex: 0, partial: partial() };
      for (let i = 0; i < thoughts; i++) {
        if (signal.aborted) return;
        (content[0] as { thinking: string }).thinking += 't';
        yield { type: 'thinking_delta', contentIndex: 0, delta: 't', partial: partial() };
      }
      yield { type: 'thinking_end', contentIndex: 0, content: 't'.repeat(thoughts), partial: partial() };
    }
    if (text) {
      const i = content.length;
      content.push({ type: 'text', text });
      yield { type: 'text_start', contentIndex: i, partial: partial() };
      yield { type: 'text_delta', contentIndex: i, delta: text, partial: partial() };
      yield { type: 'text_end', contentIndex: i, content: text, partial: partial() };
    }
    yield { type: 'done', reason: 'stop', message: partial() };
  };
}

async function run(attempts: ReturnType<typeof reply>[], budget: number) {
  const events: AssistantMessageEvent[] = [];
  const notes: (string | undefined)[] = [];
  let n = 0;
  const attempt: Attempt = (note, signal) => {
    notes.push(note);
    return attempts[n++](signal);
  };
  await streamWithBudget(attempt, budget, undefined, { push: (e) => events.push(e), end() {} });
  return { events, notes, final: events.at(-1) };
}

test('a reply that finishes under the budget passes through unchanged', async () => {
  const { events, notes, final } = await run([reply(3, 'hi')], 10);
  assert.deepEqual(notes, [undefined]);
  assert.equal(events.filter((e) => e.type === 'thinking_delta').length, 3);
  assert.equal(final?.type, 'done');
  assert.deepEqual(final.type === 'done' && final.message.content.map((c) => c.type), ['thinking', 'text']);
});

test('at the budget it aborts, then answers with thinking off and the notes', async () => {
  let aborted = false;
  const { events, notes, final } = await run([reply(50, 'never', () => (aborted = true)), reply(0, 'answer')], 5);
  assert.ok(aborted, 'the first request is aborted');
  assert.deepEqual(notes, [undefined, 'ttttt']);
  assert.equal(events.filter((e) => e.type === 'thinking_delta').length, 5);
  assert.equal(events.filter((e) => e.type === 'start').length, 1, 'one message, one start');
  const end = events.find((e) => e.type === 'thinking_end');
  assert.equal(end?.type === 'thinking_end' && end.content, 'ttttt');
  const text = events.find((e) => e.type === 'text_start');
  assert.equal(text?.type === 'text_start' && text.contentIndex, 1, 'follow-up blocks come after the thinking');
  assert.equal(final?.type, 'done');
  if (final?.type !== 'done') return;
  assert.deepEqual(
    final.message.content.map((c) => (c.type === 'thinking' ? c.thinking : c.type === 'text' ? c.text : c.type)),
    ['ttttt', 'answer'],
  );
  assert.equal(final.message.usage.output, 5 + 5);
  assert.equal(final.message.usage.reasoning, 5);
});

test('reasoning that ends with nothing said gets the same follow-up', async () => {
  const { notes, final } = await run([reply(3, ''), reply(0, 'answer')], 10);
  assert.deepEqual(notes, [undefined, 'ttt']);
  assert.deepEqual(final?.type === 'done' && final.message.content.map((c) => c.type), ['thinking', 'text']);
});

test('the budget only counts thinking before the answer starts', async () => {
  const { notes } = await run([reply(4, 'hi'), reply(0, 'answer')], 4);
  assert.deepEqual(notes, [undefined, 'tttt'], 'the cap is reached on the last thought, before any text');
  const late = await run([reply(3, 'hi')], 4);
  assert.deepEqual(late.notes, [undefined]);
});

test('budgetFor picks the rule, the level and the flag', () => {
  const rules: Rule[] = [
    { provider: 'ollama', model: 'gemma', budget: { low: 200, high: 800 } },
    { provider: 'ollama', budget: 400 },
  ];
  assert.equal(budgetFor(rules, 'ollama', 'gemma', 'low'), 200);
  assert.equal(budgetFor(rules, 'ollama', 'gemma', 'medium'), undefined, 'a level left out is not capped');
  assert.equal(budgetFor(rules, 'ollama', 'other', 'medium'), 400);
  assert.equal(budgetFor(rules, 'ollama', 'gemma', 'off'), undefined);
  assert.equal(budgetFor(rules, 'openai', 'gemma', 'low'), undefined);
  assert.equal(budgetFor(rules, 'ollama', 'gemma', 'medium', '150'), 150);
  assert.equal(budgetFor(rules, 'ollama', 'gemma', 'low', '0'), undefined, '--think-budget 0 turns it off');
});
