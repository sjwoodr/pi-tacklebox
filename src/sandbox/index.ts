/**
 * sandbox: every bash tool command runs inside Anthropic's sandbox-runtime (`srt`, the engine behind
 * Claude Code's sandbox): writes only where allowed, network only to allowed hosts, denied folders
 * hidden, and no variable whose name looks like a secret. read/write/edit/grep/find/ls are checked
 * against the same lists, and jobs, verify-done and the loop's gates run their commands through srt
 * too. pi itself, its model calls, your `!` commands and other packages' tools stay outside.
 *
 * Off by default. It needs srt (`npm install -g @anthropic-ai/sandbox-runtime`) and, on Linux,
 * bubblewrap, socat and ripgrep; the rules live in srt's own settings file (docs/sandbox.md). When it
 * is on but cannot be used, commands and file tools are refused rather than run unprotected.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createBashToolDefinition } from '@earendil-works/pi-coding-agent';
import { getAgentDir, loadConfig } from '../config.ts';
import { checkCall, loadSandbox, type Sandbox } from './sandbox.ts';

/** Tools refused outright when the sandbox is on but cannot be used. */
const GUARDED = new Set(['bash', 'read', 'write', 'edit', 'grep', 'find', 'ls', 'job_start']);

export default function (pi: ExtensionAPI) {
  const settings = loadConfig().sandbox;
  if (!settings.enabled) return;
  const cwd = process.cwd();
  let box: Sandbox | undefined;
  let problem = '';
  try {
    box = loadSandbox(settings, getAgentDir(), cwd);
  } catch (err) {
    problem = (err as Error).message;
  }

  pi.registerTool(
    createBashToolDefinition(cwd, {
      spawnHook: ({ command, cwd: dir, env }) => {
        if (!box) throw new Error(problem);
        return { command: box.wrap(command), cwd: dir, env: box.env(env) };
      },
    }),
  );

  pi.on('tool_call', (event) => {
    if (!box) return GUARDED.has(event.toolName) ? { block: true, reason: problem } : undefined;
    const reason = checkCall(event.toolName, event.input as Record<string, unknown>, cwd, box.rules);
    return reason ? { block: true, reason: `sandbox: ${reason}` } : undefined;
  });

  pi.on('session_start', (_event, ctx) => {
    if (!ctx.hasUI) return;
    if (!box) return ctx.ui.notify(`sandbox: ${problem}; commands and file tools are refused`, 'error');
    const note = box.skipped.length ? `; file tools skip the glob entries ${box.skipped.join(', ')}` : '';
    ctx.ui.notify(`sandbox: commands run through srt with ${box.settings}${note}`, 'info');
  });
}
