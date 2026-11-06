/**
 * bang: `!command` gets an answer straight away. pi keeps the output for the next prompt and makes no
 * model call; this starts a turn once the output is in the session, so the model reads it at once.
 * `!!command` stays private, and a command run while the model is busy waits for the next prompt.
 *
 * It only watches. The command still runs through pi's own path, so shellPath, shellCommandPrefix and
 * other extensions' handling of `!` keep working.
 *
 * On by default, so every `!` is a model call; `"bang": { "enabled": false }` in tacklebox.json turns
 * it off.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadConfig } from '../config.ts';

export const ASK = 'The user just ran the command above with `!`. Read its output and respond.';
const POLL_MS = 100;

export default function (pi: ExtensionAPI) {
  if (!loadConfig().bang.enabled) return;
  let timer: NodeJS.Timeout | undefined;

  pi.on('user_bash', (event, ctx) => {
    if (event.excludeFromContext || !ctx.isIdle()) return;
    clearInterval(timer);
    const start = ctx.sessionManager.getLeafId();
    timer = setInterval(() => {
      const leaf = ctx.sessionManager.getLeafEntry();
      if (leaf?.id === start) return;
      clearInterval(timer);
      // Anything else at the end of the session means the user moved on while it ran.
      if (leaf?.type !== 'message' || leaf.message.role !== 'bashExecution') return;
      if (leaf.message.command !== event.command || leaf.message.cancelled || !ctx.isIdle()) return;
      pi.sendMessage({ customType: 'tacklebox-bang', content: ASK, display: false }, { triggerTurn: true });
    }, POLL_MS);
    timer.unref();
  });

  pi.on('session_shutdown', () => clearInterval(timer));
}
