import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Api,
  createAssistantMessageEventStream,
  getApiProvider,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from '@earendil-works/pi-ai/compat';
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from '@earendil-works/pi-coding-agent';
import { CONFIG, loadConfig } from '../config.ts';
import { answerNow, budgetFor, type Cut, type Rule, streamWithBudget, unmatchedRules } from './cap.ts';

/** The old standalone file, still read when tacklebox.json has no thinkBudget section. */
const FALLBACK = 'think-budget.json';

/** The rules and the file they came from: tacklebox.json's thinkBudget section first, else think-budget.json. */
export function loadRules(dir = getAgentDir()): { rules: Rule[]; source: string; ignored?: string } {
  const own = loadConfig(dir).thinkBudget;
  const fallback = join(dir, FALLBACK);
  if (own) return { rules: own.rules as Rule[], source: CONFIG, ignored: existsSync(fallback) ? FALLBACK : undefined };
  try {
    return { rules: JSON.parse(readFileSync(fallback, 'utf8')).rules ?? [], source: FALLBACK };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { rules: [], source: CONFIG };
    throw new Error(`${FALLBACK}: ${(err as Error).message}`);
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag('think-budget', {
    type: 'string',
    description: 'Thinking token cap for the models with think-budget rules (0 turns the cap off)',
  });
  const { rules, source, ignored } = loadRules();

  // The stream has no context of its own, so cuts are reported through the session's UI:
  // a notice and a running count in the footer, or a stderr line where there is no UI (pi -p).
  let ui: ExtensionContext['ui'] | undefined;
  let cuts = 0;
  const say = (message: string, type: 'info' | 'warning') =>
    ui ? ui.notify(message, type) : process.stderr.write(`[think-budget] ${message}\n`);
  pi.on('session_start', (_event, ctx) => {
    ui = ctx.hasUI ? ctx.ui : undefined;
    cuts = 0;
    if (ignored) say(`${ignored} is ignored: ${source} has a thinkBudget section`, 'warning');
    for (const problem of unmatchedRules(rules, ctx.modelRegistry.getAll()))
      say(`${source}: ${problem}, so that rule caps nothing`, 'warning');
  });
  const report = (cut: Cut, budget: number) => {
    const message =
      cut.reason === 'budget'
        ? `Thinking capped at ${budget} tokens; asked for the answer`
        : `Reasoning ended without an answer after ${cut.tokens} tokens; asked for one`;
    const asked = cut.asked > 1 ? ` (asked ${cut.asked} times: ${cut.asked - 1} follow-up${cut.asked > 2 ? 's were' : ' was'} empty)` : '';
    cuts++;
    say(message + asked, 'info');
    ui?.setStatus('think-budget', `think cap: ${cuts} ${cuts === 1 ? 'cut' : 'cuts'}`);
  };

  const streamSimple = (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => {
    const api = getApiProvider(model.api);
    if (!api) throw new Error(`No API provider registered for api: ${model.api}`);
    const flag = pi.getFlag('think-budget');
    const budget = budgetFor(rules, model.provider, model.id, options?.reasoning, typeof flag === 'string' ? flag : undefined);
    if (!budget) return api.streamSimple(model, context, options);

    const out = createAssistantMessageEventStream();
    const attempt = (notes: string | undefined, signal: AbortSignal, again?: boolean) =>
      notes === undefined
        ? api.streamSimple(model, context, { ...options, signal })
        : api.streamSimple(
            model,
            { ...context, messages: [...context.messages, { role: 'user', content: answerNow(notes, again), timestamp: Date.now() }] },
            // No level is how pi asks for thinking off (the model's thinkingLevelMap.off is sent).
            { ...options, reasoning: undefined, signal },
          );
    streamWithBudget(attempt, budget, options?.signal, out)
      .then((cut) => cut && report(cut, budget))
      .catch((err) =>
        out.push({
          type: 'error',
          reason: 'error',
          error: {
            role: 'assistant',
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: 'error',
            errorMessage: err instanceof Error ? err.message : String(err),
            timestamp: Date.now(),
          },
        }),
      )
      .finally(() => out.end());
    return out;
  };

  // Wrapping the provider's stream keeps its models, endpoint and key from models.json.
  const providers = new Map(rules.map((r) => [r.provider, r.api ?? 'openai-completions']));
  for (const [provider, api] of providers) pi.registerProvider(provider, { api: api as Api, streamSimple });
}
