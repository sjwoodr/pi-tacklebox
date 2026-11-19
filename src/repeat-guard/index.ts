/**
 * repeat-guard: breaks a model out of a loop of the same tool call. A call made again with the same
 * arguments that returns the same output as before builds a streak:
 *
 *   noteAt   the result of the noteAt-th identical call in a row (default 3) gets a note saying the
 *            output is the same as the last ones and asking for a different next step; every
 *            identical result after it gets the note again
 *   blockAt  once blockAt identical results in a row have come back (default 5), the same call is
 *            refused without running, until the model makes a different one; 0 never refuses
 *
 * A call whose output changes (polling a log that grows, a test run after an edit) never builds a
 * streak, and any different call ends one.
 *
 * From a MiMo-V2.6-Distill (Qwen3.5 9B) run on Ollama (2026-11-19): with a file still missing its
 * main(), the model ran the same grep/wc/sed command 46 times in a row over 16 minutes, thinking each
 * time "the file is 627 lines but the last line is at 623, let me check lines 624-627".
 *
 * Listed last in package.json: pi stops at the first tool_call handler that blocks, so a call that
 * jobs or the sandbox refuses is never counted here (it gets no tool_result either).
 *
 * On by default (it only adds to results that repeat, and refuses only a call already repeated
 * blockAt times); `"repeatGuard": { "enabled": false }` in tacklebox.json turns it off.
 */

import { createHash } from 'node:crypto';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadConfig } from '../config.ts';

type Block = { type: string; text?: string };

/** The same call: tool name and arguments, with object keys in a fixed order. */
export function callKey(toolName: string, input: unknown): string {
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]))
        : v;
  return `${toolName}\0${JSON.stringify(stable(input) ?? null)}`;
}

/** The same output: whether it failed, and its text and the kinds of anything else in it. */
export function outputKey(content: readonly Block[], isError: boolean): string {
  const hash = createHash('sha256').update(isError ? 'error\0' : 'ok\0');
  for (const c of content) hash.update(c.type === 'text' ? `text\0${c.text ?? ''}\0` : `${c.type}\0`);
  return hash.digest('hex');
}

export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

export function repeatNote(toolName: string, count: number): string {
  return (
    `repeat-guard: this is the ${ordinal(count)} time in a row you have made this exact ${toolName} call, and its ` +
    `output is the same as the last ${count - 1 === 1 ? 'time' : `${count - 1} times`}. Running it again will only show ` +
    `the same thing. Use what it already shows: if something you are looking for is not in it, it is not there ` +
    `yet. Take a different next step: write or change what is missing, run something else, or say what you are stuck on.`
  );
}

export function refusal(toolName: string, count: number): string {
  return (
    `repeat-guard: not run. You have made this exact ${toolName} call ${count} times in a row and got the same ` +
    `output every time, so it would only return the same again (its output is in the earlier results). Take a ` +
    `different next step: write or change what is missing, run something else, or say what you are stuck on.`
  );
}

/** content with note added to its last text block, or as a new block when it has none. */
function withNote<T extends Block>(content: readonly T[], note: string): T[] {
  const i = content.findLastIndex((c) => c.type === 'text');
  if (i < 0) return [...content, { type: 'text', text: note } as T];
  return content.map((c, k) => (k === i ? { ...c, text: `${c.text ?? ''}\n\n${note}` } : c));
}

export default function (pi: ExtensionAPI) {
  const { enabled, noteAt, blockAt } = loadConfig().repeatGuard;
  if (!enabled) return;
  /** The current run of identical calls with identical output. */
  let streak: { call: string; output: string; count: number } | undefined;

  pi.on('session_start', () => {
    streak = undefined;
  });

  pi.on('tool_result', async (event) => {
    const call = callKey(event.toolName, event.input);
    const output = outputKey(event.content, event.isError);
    if (streak && streak.call === call && streak.output === output) streak.count += 1;
    else streak = { call, output, count: 1 };
    if (streak.count < noteAt) return;
    return { content: withNote(event.content, repeatNote(event.toolName, streak.count)) };
  });

  if (blockAt > 0) {
    pi.on('tool_call', async (event) => {
      if (!streak || streak.count < blockAt || streak.call !== callKey(event.toolName, event.input)) return;
      return { block: true, reason: refusal(event.toolName, streak.count) };
    });
  }
}
