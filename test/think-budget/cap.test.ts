import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import { type Attempt, budgetFor, MAX_ASKS, type Rule, streamWithBudget, unmatchedRules } from '../../src/think-budget/cap.ts';

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
  const cut = await streamWithBudget(attempt, budget, undefined, { push: (e) => events.push(e), end() {} });
  return { events, notes, final: events.at(-1), cut };
}

test('a reply that finishes under the budget passes through unchanged', async () => {
  const { events, notes, final, cut } = await run([reply(3, 'hi')], 10);
  assert.deepEqual(notes, [undefined]);
  assert.equal(cut, undefined, 'nothing to report');
  assert.equal(events.filter((e) => e.type === 'thinking_delta').length, 3);
  assert.equal(final?.type, 'done');
  assert.deepEqual(final.type === 'done' && final.message.content.map((c) => c.type), ['thinking', 'text']);
});

test('at the budget it aborts, then answers with thinking off and the notes', async () => {
  let aborted = false;
  const { events, notes, final, cut } = await run([reply(50, 'never', () => (aborted = true)), reply(0, 'answer')], 5);
  assert.ok(aborted, 'the first request is aborted');
  assert.deepEqual(cut, { reason: 'budget', tokens: 5, asked: 1 });
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
  const { notes, final, cut } = await run([reply(3, ''), reply(0, 'answer')], 10);
  assert.deepEqual(notes, [undefined, 'ttt']);
  assert.deepEqual(cut, { reason: 'empty', tokens: 3, asked: 1 });
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

test('unmatchedRules names rules that match no model', () => {
  const models = [{ provider: 'ollama', id: 'gemma4-26b-a4b-64k:latest' }];
  const rules: Rule[] = [
    { provider: 'ollama', model: 'gemma4-26b-a4b-64k:latest', budget: 200 },
    { provider: 'ollama', model: 'gemma4:26b', budget: 200 },
    { provider: 'ollama', budget: 200 },
    { provider: 'lmstudio', budget: 200 },
  ];
  assert.deepEqual(unmatchedRules(rules, models), ['no model "ollama/gemma4:26b"', 'provider "lmstudio" has no models']);
});

test('the cut thinking is not shown as aborted', async () => {
  // Like pi-ai's adapters: every event shares one message, and an abort marks it aborted.
  const shared = async function* (signal: AbortSignal): AsyncGenerator<AssistantMessageEvent> {
    const output = message([{ type: 'thinking', thinking: '' }]);
    signal.addEventListener('abort', () => {
      output.stopReason = 'aborted';
    });
    yield { type: 'start', partial: output };
    yield { type: 'thinking_start', contentIndex: 0, partial: output };
    for (let i = 0; i < 50 && !signal.aborted; i++) {
      (output.content[0] as { thinking: string }).thinking += 't';
      yield { type: 'thinking_delta', contentIndex: 0, delta: 't', partial: output };
    }
  };
  const { events, final } = await run([shared, reply(0, 'answer')], 5);
  const end = events.find((e) => e.type === 'thinking_end');
  assert.equal(end?.type === 'thinking_end' && end.partial.stopReason, 'stop');
  assert.equal(final?.type === 'done' && final.message.stopReason, 'stop');
});

test('an empty follow-up is asked once more, after its own blocks', async () => {
  const { events, notes, final, cut } = await run([reply(50, 'never'), reply(3, ''), reply(0, 'answer')], 5);
  assert.deepEqual(notes, [undefined, 'ttttt', 'ttttt']);
  assert.equal(cut?.asked, 2);
  const text = events.find((e) => e.type === 'text_start');
  assert.equal(text?.type === 'text_start' && text.contentIndex, 2, 'after the cut thinking and the empty reply');
  assert.deepEqual(final?.type === 'done' && final.message.content.map((c) => c.type), ['thinking', 'thinking', 'text']);
  assert.equal(final?.type === 'done' && final.message.usage.output, 5 + 5 + 5, 'every request counted');
});

test('empty follow-ups are asked again up to MAX_ASKS, then the reply ends', async () => {
  const empties = Array.from({ length: MAX_ASKS }, () => reply(0, ''));
  const { notes, final, cut } = await run([reply(50, 'never'), ...empties, reply(0, 'unused')], 5);
  assert.equal(notes.length, 1 + MAX_ASKS);
  assert.equal(cut?.asked, MAX_ASKS);
  assert.equal(final?.type, 'done');
});

test('a third follow-up that answers ends the asking', async () => {
  const { notes, cut, final } = await run([reply(50, 'never'), reply(0, ''), reply(0, ''), reply(0, 'answer')], 5);
  assert.equal(notes.length, 4);
  assert.equal(cut?.asked, 3);
  assert.deepEqual(final?.type === 'done' && final.message.content.map((c) => c.type), ['thinking', 'text']);
});
