/**
 * nudge: when a run is about to end on a reply that can't be what the model meant, it gets one more
 * request with a short message saying what went wrong:
 *
 *   leaked     a tool call written out as text, which the server didn't parse, so nothing ran
 *   empty      no text and no tool call (Gemma on Ollama: a malformed call comes back as nothing)
 *   announced  the reply ends on "let me update src/money.ts:" with no call
 *
 * All three ended agent-bench code-suite runs early (2026-10-27). It works at pi's
 * agent_before_settle boundary rather than retrying the stream, because by the time a reply is known
 * to be broken its text has already been shown. At most nudge.maxPerPrompt (default 2) per prompt.
 *
 * Off by default; `"nudge": { "enabled": true }` in tacklebox.json turns it on.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { loadConfig } from '../config.ts';
import { NUDGES, problemWith, type Reply } from './reply.ts';

export default function (pi: ExtensionAPI) {
  const { enabled, maxPerPrompt } = loadConfig().nudge;
  if (!enabled) return;
  let sent = 0;
  let total = 0;

  pi.on('before_agent_start', async (event) => {
    if (event.messageType === 'user') sent = 0;
  });

  pi.on('agent_before_settle', async (event, ctx: ExtensionContext) => {
    if (event.outcome !== 'completed' || event.continue || sent >= maxPerPrompt) return;
    const last = event.context.contextMessages.at(-1) as Reply | undefined;
    const problem = problemWith(last);
    if (!problem) return;
    sent++;
    total++;
    const note = `nudge: ${problem} reply, asked to continue (${sent}/${maxPerPrompt})`;
    if (ctx.hasUI) {
      ctx.ui.notify(note, 'info');
      ctx.ui.setStatus('nudge', `nudges: ${total}`);
    } else process.stderr.write(`[tacklebox] ${note}\n`);
    return {
      entries: [{ type: 'custom_message', customType: 'tacklebox-nudge', content: NUDGES[problem], display: true }],
      continue: true,
    };
  });
}
