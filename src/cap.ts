import type { AssistantMessage, AssistantMessageEvent, Usage } from '@earendil-works/pi-ai';

/** Where the capped reply goes: pi's assistant event stream, or a test collector. */
export interface Sink {
  push(event: AssistantMessageEvent): void;
  end(): void;
}

/** One request to the model. `notes` is set on the follow-up after a cut, with thinking off. */
export type Attempt = (notes: string | undefined, signal: AbortSignal) => AsyncIterable<AssistantMessageEvent>;

export const answerNow = (notes: string) =>
  `(Your private reasoning so far, not shown to me:)\n${notes}\n\n` +
  'Thinking time is up. Continue now: answer, or make the tool call you need.';

/**
 * Streams one reply that thinks for at most `budget` tokens. At the cap the request is aborted and
 * the model is asked to answer straight away with thinking off, its reasoning so far passed back as
 * notes. The same follow-up runs when the reasoning ends with nothing said, which otherwise leaves
 * an empty reply. pi sees one assistant message: the thinking, then the follow-up's content.
 */
/** Why a reply got the follow-up: the budget ran out, or the reasoning ended with nothing said. */
export type Cut = { reason: 'budget' | 'empty'; tokens: number };

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
  // The follow-up's blocks come after everything the first request produced.
  const before = kept.content;
  const merge = (message: AssistantMessage): AssistantMessage => ({
    ...message,
    content: [...before, ...message.content],
    usage: withThinking(message.usage, tokens),
  });
  for await (const event of attempt(notes, signal ?? new AbortController().signal)) {
    if (event.type === 'start') continue;
    if (event.type === 'done') out.push({ ...event, message: merge(event.message) });
    else if (event.type === 'error') out.push({ ...event, error: merge(event.error) });
    else out.push({ ...event, contentIndex: event.contentIndex + before.length, partial: merge(event.partial) });
  }
  return { reason: retry, tokens };
}

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
  /** Exact model id; omitted or "*" means every model of the provider. */
  model?: string;
  /** The API the provider's models use (default "openai-completions"). */
  api?: string;
  /** One cap for every thinking level, or a cap per level (a level left out is not capped). */
  budget: number | Partial<Record<Level, number>>;
}

/** The cap for this request, or undefined to pass it through. `override` is the --think-budget flag. */
export function budgetFor(rules: Rule[], provider: string, model: string, level: string | undefined, override?: string) {
  if (!level || level === 'off') return undefined;
  const rule = rules.find((r) => r.provider === provider && (!r.model || r.model === '*' || r.model === model));
  if (!rule) return undefined;
  const cap = override ? Number(override) : typeof rule.budget === 'number' ? rule.budget : rule.budget[level as Level];
  return cap && cap > 0 ? cap : undefined;
}

/** Rules that match no known model, described for a warning: a typo here silently caps nothing. */
export function unmatchedRules(rules: Rule[], models: { provider: string; id: string }[]) {
  return rules
    .filter((r) => !models.some((m) => m.provider === r.provider && (!r.model || r.model === '*' || r.model === m.id)))
    .map((r) => (!r.model || r.model === '*' ? `provider "${r.provider}" has no models` : `no model "${r.provider}/${r.model}"`));
}
