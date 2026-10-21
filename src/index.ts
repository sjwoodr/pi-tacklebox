import { readFileSync } from 'node:fs';
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
import { answerNow, budgetFor, type Cut, type Rule, streamWithBudget } from './cap.ts';

const CONFIG = 'think-budget.json';

function loadRules(): Rule[] {
  try {
    return JSON.parse(readFileSync(join(getAgentDir(), CONFIG), 'utf8')).rules ?? [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`${CONFIG}: ${(err as Error).message}`);
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag('think-budget', {
    type: 'string',
    description: 'Thinking token cap for models in think-budget.json (0 turns the cap off)',
  });
  const rules = loadRules();

  // The stream has no context of its own, so cuts are reported through the session's UI:
  // a notice and a running count in the footer, or a stderr line where there is no UI (pi -p).
  let ui: ExtensionContext['ui'] | undefined;
  let cuts = 0;
  pi.on('session_start', (_event, ctx) => {
    ui = ctx.hasUI ? ctx.ui : undefined;
    cuts = 0;
  });
  const report = (cut: Cut, budget: number) => {
    const message =
      cut.reason === 'budget'
        ? `Thinking capped at ${budget} tokens; asked for the answer`
        : `Reasoning ended without an answer after ${cut.tokens} tokens; asked for one`;
    cuts++;
    if (!ui) return void process.stderr.write(`[think-budget] ${message}\n`);
    ui.notify(message, 'info');
    ui.setStatus('think-budget', `think cap: ${cuts} ${cuts === 1 ? 'cut' : 'cuts'}`);
  };

  const streamSimple = (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => {
    const api = getApiProvider(model.api);
    if (!api) throw new Error(`No API provider registered for api: ${model.api}`);
    const flag = pi.getFlag('think-budget');
    const budget = budgetFor(rules, model.provider, model.id, options?.reasoning, typeof flag === 'string' ? flag : undefined);
    if (!budget) return api.streamSimple(model, context, options);

    const out = createAssistantMessageEventStream();
    const attempt = (notes: string | undefined, signal: AbortSignal) =>
      notes === undefined
        ? api.streamSimple(model, context, { ...options, signal })
        : api.streamSimple(
            model,
            { ...context, messages: [...context.messages, { role: 'user', content: answerNow(notes), timestamp: Date.now() }] },
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
