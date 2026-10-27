/**
 * verify-done: when a run that edited files is about to end, run the project's tests, and if they
 * fail, send the model the end of the output and one more request. In the agent-bench code-suite
 * (2026-10-27) models said "Done" with failing tests: a rename that left callers behind, and tests
 * written for vitest in a node:test repo, never run. Given a failure, every model fixed it.
 *
 * The tests also run once before the model's first edit of a prompt; if they already failed, the run
 * is not checked, so a broken suite isn't blamed on the change. At most verifyDone.maxRounds
 * (default 2) per prompt; each run is killed after timeoutSeconds (default 120). The command comes
 * from verifyDone.command, or is detected from the project (detect.ts).
 *
 * It can't catch a change that passes the tests but isn't what was asked.
 *
 * Off by default; `"verifyDone": { "enabled": true }` in tacklebox.json turns it on.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { loadConfig } from '../config.ts';
import { detectCommand } from './detect.ts';
import { runTests } from './run.ts';

const EDIT_TOOLS = new Set(['edit', 'write']);
// Shell commands that change files in place: sed -i, a redirect into a file, tee, mv, cp.
const SHELL_EDIT = /\bsed\s+-i|(?<![<>&\d])>{1,2}\s*[\w./-]|\btee\b|\b(mv|cp)\s/;

export const failureMessage = (command: string, code: number | undefined, tail: string) =>
  `The tests fail after your changes (\`${command}\`, ${code === undefined ? 'timed out' : `exit ${code}`}):\n\n` +
  '```\n' +
  tail +
  '\n```\n\n' +
  "Fix the cause, then finish. Don't weaken or skip tests to make them pass.";

export default function (pi: ExtensionAPI) {
  const { enabled, command: configured, maxRounds, timeoutSeconds } = loadConfig().verifyDone;
  if (!enabled) return;
  let edited = false;
  let rounds = 0;
  let baseline: Promise<boolean | undefined> | undefined;

  const say = (ctx: ExtensionContext, message: string, type: 'info' | 'warning') => {
    if (ctx.hasUI) {
      ctx.ui.notify(`verify-done: ${message}`, type);
      ctx.ui.setStatus('verify-done', `verify: ${message.split(':')[0]}`);
    } else process.stderr.write(`[tacklebox] verify-done: ${message}\n`);
  };

  pi.on('before_agent_start', async (event) => {
    if (event.messageType !== 'user') return;
    edited = false;
    rounds = 0;
    baseline = undefined;
  });

  // Before the first edit of a prompt: were the tests passing to begin with?
  pi.on('tool_call', async (event, ctx) => {
    const input = event.input as { command?: string };
    const editing = EDIT_TOOLS.has(event.toolName) || (event.toolName === 'bash' && SHELL_EDIT.test(input.command ?? ''));
    if (!editing) return;
    edited = true;
    if (!baseline) {
      const command = configured || detectCommand(ctx.cwd);
      baseline = command ? runTests(command, ctx.cwd, timeoutSeconds).then((r) => r.ok) : Promise.resolve(undefined);
      await baseline;
    }
  });

  pi.on('agent_before_settle', async (event, ctx) => {
    // Another check (nudge) already asked for more: let that request run first.
    if (!edited || event.outcome !== 'completed' || event.continue) return;
    const command = configured || detectCommand(ctx.cwd);
    if (!command) return;
    if ((await baseline) === false) {
      say(ctx, 'tests were failing before the change; not checked', 'warning');
      edited = false;
      return;
    }
    const run = await runTests(command, ctx.cwd, timeoutSeconds);
    if (run.ok) {
      say(ctx, `tests pass (${command})`, 'info');
      edited = false;
      return;
    }
    if (rounds >= maxRounds) {
      say(ctx, `tests still fail after ${rounds} rounds; stopping`, 'warning');
      edited = false;
      return;
    }
    rounds++;
    say(ctx, `tests failed, round ${rounds}/${maxRounds}`, 'warning');
    return {
      entries: [
        { type: 'custom_message', customType: 'tacklebox-verify-done', content: failureMessage(command, run.code, run.tail), display: true },
      ],
      continue: true,
    };
  });
}
