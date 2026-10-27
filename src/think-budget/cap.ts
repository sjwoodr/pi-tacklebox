import type { AssistantMessage, AssistantMessageEvent, Usage } from '@earendil-works/pi-ai';

/** Where the capped reply goes: pi's assistant event stream, or a test collector. */
export interface Sink {
  push(event: AssistantMessageEvent): void;
  end(): void;
}

/**
 * One request to the model. `notes` is set on a follow-up after a cut, with thinking off; `again`
 * marks a later follow-up, after the one before came back with nothing.
 */
export type Attempt = (
  notes: string | undefined,
  signal: AbortSignal,
  again?: boolean,
) => AsyncIterable<AssistantMessageEvent>;

export const answerNow = (notes: string, again = false) =>
  `(Your private reasoning so far, not shown to me:)\n${notes}\n\n` +
  (again ? 'Your last reply was empty. ' : '') +
  'Thinking time is up. Continue now: answer, or make the tool call you need.';

/**
 * How many follow-ups a reply gets before it ends empty. An empty follow-up is usually a tool call
 * the server dropped: Gemma on Ollama wrote `call{edit{` for `call:edit{`, or an empty call, in
 * 3 to 5 of 10 replays of one cut, and Ollama returns nothing for those, without an error.
 */
export const MAX_ASKS = 4;

/** Why a reply got the follow-up: the budget ran out, or the reasoning ended with nothing said. */
export type Cut = { reason: 'budget' | 'empty'; tokens: number; asked: number };

/**
 * Streams one reply that thinks for at most `budget` tokens. At the cap the request is aborted and
 * the model is asked to answer straight away with thinking off, its reasoning so far passed back as
 * notes. The same follow-up runs when the reasoning ends with nothing said, which otherwise leaves
 * an empty reply, and again (up to MAX_ASKS in all) while the follow-up itself says nothing. pi sees one assistant
 * message: the thinking, then the follow-ups' content.
 */

export async function streamWithBudget(
  attempt: Attempt,
  budget: number,
  signal: AbortSignal | undefined,
  out: Sink,
): Promise<Cut | undefined> {
  const first = new AbortController();
  const relay = () => first.abort();
  signal?.addEventListener('abort', relay, { once: true });
  let notes = '';
  let tokens = 0; // Ollama streams about one token per chunk, so deltas stand in for tokens
  let answered = false;
  let openThinking: number | undefined;
  let kept: AssistantMessage | undefined;
  let retry: Cut['reason'] | undefined;
  try {
    for await (const event of attempt(undefined, first.signal)) {
      if (event.type === 'done') {
        if (answered) {
          out.push(event);
          return;
        }
        kept = event.message;
        retry = 'empty';
        break;
      }
      if (event.type === 'error') {
        out.push(event);
        return;
      }
      out.push(event);
      kept = event.partial;
      if (event.type === 'thinking_start') openThinking = event.contentIndex;
      if (event.type === 'thinking_end') openThinking = undefined;
      if (event.type === 'toolcall_start' || (event.type === 'text_delta' && event.delta.trim())) answered = true;
      if (event.type === 'thinking_delta') {
        notes += event.delta;
        if (++tokens >= budget && !answered) {
          retry = 'budget';
          // A copy: the adapter shares this message across events and marks it aborted when we abort.
          kept = structuredClone(event.partial);
          break;
        }
      }
    }
  } finally {
    signal?.removeEventListener('abort', relay);
    first.abort();
  }
  if (!retry || !kept) return;
  if (openThinking !== undefined) {
    const block = kept.content[openThinking];
    out.push({
      type: 'thinking_end',
      contentIndex: openThinking,
      content: block?.type === 'thinking' ? block.thinking : notes,
      partial: kept,
    });
  }
  // Each follow-up's blocks come after everything already sent; an empty one stays in the message
  // (pi has seen its events) and the next follows it.
  let before = kept.content;
  let extra = tokens;
  const merge = (message: AssistantMessage): AssistantMessage => ({
    ...message,
    content: [...before, ...message.content],
    usage: withThinking(message.usage, extra),
  });
  for (let asked = 1; ; asked++) {
    const last = asked === MAX_ASKS;
    for await (const event of attempt(notes, signal ?? new AbortController().signal, asked > 1)) {
      if (event.type === 'start') continue;
      if (event.type === 'done') {
        if (last || said(event.message)) {
          out.push({ ...event, message: merge(event.message) });
          return { reason: retry, tokens, asked };
        }
        before = [...before, ...event.message.content];
        extra += event.message.usage.output;
      } else if (event.type === 'error') {
        out.push({ ...event, error: merge(event.error) });
        return { reason: retry, tokens, asked };
      } else out.push({ ...event, contentIndex: event.contentIndex + before.length, partial: merge(event.partial) });
    }
    if (last) return { reason: retry, tokens, asked }; // a stream that ended without done or error
  }
}

/** Whether a reply gives pi something to act on: text, or a tool call. */
const said = (message: AssistantMessage) =>
  message.content.some((c) => c.type === 'toolCall' || (c.type === 'text' && c.text.trim()));

// The aborted request never reports usage, so its thinking is counted from the stream and its
// input tokens are left out.
function withThinking(usage: Usage, tokens: number): Usage {
  return {
    ...usage,
    output: usage.output + tokens,
    reasoning: (usage.reasoning ?? 0) + tokens,
    totalTokens: usage.totalTokens + tokens,
  };
}

export type Level = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface Rule {
  provider: string;
  /** A model id, where `*` matches any run of characters ("gemma4*"); omitted or "*" means every model of the provider. */
  model?: string;
  /** The API the provider's models use (default "openai-completions"). */
  api?: string;
  /** One cap for every thinking level, or a cap per level (a level left out is not capped). */
  budget: number | Partial<Record<Level, number>>;
}

/** Whether a rule's model (an id, or a pattern with `*`) covers this model id. */
export function modelMatches(pattern: string | undefined, id: string): boolean {
  if (!pattern || pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === id;
  const regex = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${regex}$`).test(id);
}

/** The cap for this request, or undefined to pass it through. `override` is the --think-budget flag. */
export function budgetFor(rules: Rule[], provider: string, model: string, level: string | undefined, override?: string) {
  if (!level || level === 'off') return undefined;
  const rule = rules.find((r) => r.provider === provider && modelMatches(r.model, model));
  if (!rule) return undefined;
  const cap = override ? Number(override) : typeof rule.budget === 'number' ? rule.budget : rule.budget[level as Level];
  return cap && cap > 0 ? cap : undefined;
}

/** Rules that match no known model, described for a warning: a typo here silently caps nothing. */
export function unmatchedRules(rules: Rule[], models: { provider: string; id: string }[]) {
  return rules
    .filter((r) => !models.some((m) => m.provider === r.provider && modelMatches(r.model, m.id)))
    .map((r) =>
      !r.model || r.model === '*'
        ? `provider "${r.provider}" has no models`
        : r.model.includes('*')
          ? `no model matches "${r.provider}/${r.model}"`
          : `no model "${r.provider}/${r.model}"`,
    );
}
