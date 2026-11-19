/**
 * edit-assist: keeps a small model using edit rather than rewriting files with write, and stops write
 * from silently throwing most of a file away. Three parts, each with its own switch:
 *
 *   closestMatch   an edit whose oldText isn't in the file gets, added to its error, the closest
 *                  stretch of the file as it is now and the lines that differ
 *   argumentHints  an edit or write rejected for missing arguments gets the exact call shape, and the
 *                  file last worked on when path was the key missing
 *   writeGuard     a write that would keep under writeGuardMinKept (default half) of an existing file's
 *                  lines is refused once, saying what it would lose; the same write sent again goes
 *                  through. A write that re-sends a whole file to change a few lines gets a note.
 *
 * From a Gemma 4 26B-A4B run on LM Studio (2026-11-19): edit failed on a missing path twice, then on
 * oldText copied from earlier versions of the file eight times in a row; the model fell back to
 * write, and one write meant to add a part replaced a 280-line file with 114 lines.
 *
 * pi skips tool_call and tool_result for a call whose arguments fail validation, so argumentHints
 * rewrites that call's tool-result message at message_end instead. It is listed after sandbox in
 * package.json: pi stops at the first tool_call handler that blocks, so a write the sandbox refuses
 * is never read here.
 *
 * On by default (it only adds to failed results, and refuses a write once); `"editAssist":
 * { "enabled": false }` in tacklebox.json turns it off.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadConfig } from '../config.ts';
import { mismatchHint } from './closest.ts';
import { argumentHint, isSmallChange, refusal, smallChangeNote, writeChange } from './write.ts';

/** pi's edit errors for an oldText it can't find: one edit, or edits[N] of several. */
const NOT_FOUND = /Could not find (?:the exact text|edits\[(\d+)\]) in /;

type Block = { type: string; text?: string };
const textOf = (content: readonly Block[]) =>
  content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');

/** content with note added to its last text block, or as a new block when it has none. */
function withNote<T extends Block>(content: readonly T[], note: string): T[] {
  const i = content.findLastIndex((c) => c.type === 'text');
  if (i < 0) return [...content, { type: 'text', text: note } as T];
  return content.map((c, k) => (k === i ? { ...c, text: `${c.text ?? ''}\n\n${note}` } : c));
}

const lf = (s: string) => s.replace(/\r\n/g, '\n');

export default function (pi: ExtensionAPI) {
  const { enabled, closestMatch, argumentHints, writeGuard, writeGuardMinKept } = loadConfig().editAssist;
  if (!enabled) return;
  let lastPath: string | undefined;
  /** The file before each write the guard let through, by toolCallId, for the small-change note. */
  const before = new Map<string, string>();
  /** The last refused write (file and content hash): sent again unchanged, it goes through. */
  let refused: string | undefined;

  pi.on('tool_result', async (event, ctx) => {
    const input = event.input as { path?: unknown; edits?: unknown; content?: unknown };
    const given = typeof input.path === 'string' ? input.path : undefined;
    if (given && ['read', 'edit', 'write'].includes(event.toolName)) lastPath = given;

    if (event.toolName === 'write') {
      const old = before.get(event.toolCallId);
      before.delete(event.toolCallId);
      if (old === undefined || event.isError || !given || typeof input.content !== 'string') return;
      const change = writeChange(old, input.content);
      if (change && isSmallChange(change)) return { content: withNote(event.content, smallChangeNote(given, change)) };
      return;
    }

    if (event.toolName !== 'edit' || !event.isError || !closestMatch || !given || !Array.isArray(input.edits)) return;
    const miss = NOT_FOUND.exec(textOf(event.content));
    if (!miss) return;
    const index = miss[1] === undefined ? 0 : Number(miss[1]);
    const edit = input.edits[index] as { oldText?: unknown; newText?: unknown } | undefined;
    if (!edit || typeof edit.oldText !== 'string') return;
    let text: string;
    try {
      text = await readFile(path.resolve(ctx.cwd, given), 'utf8');
    } catch {
      return;
    }
    const label = miss[1] === undefined ? 'oldText' : `edits[${index}].oldText`;
    const newText = typeof edit.newText === 'string' ? lf(edit.newText) : undefined;
    return { content: withNote(event.content, mismatchHint(lf(text), label, lf(edit.oldText), newText)) };
  });

  if (argumentHints) {
    pi.on('message_end', async (event) => {
      const message = event.message as { role: string; toolName?: string; isError?: boolean; content?: Block[] };
      if (message.role !== 'toolResult' || !message.isError || !message.toolName || !Array.isArray(message.content)) return;
      const hint = argumentHint(message.toolName, textOf(message.content), lastPath);
      if (!hint) return;
      return { message: { ...event.message, content: withNote(message.content, hint) } as typeof event.message };
    });
  }

  if (writeGuard) {
    pi.on('tool_call', async (event, ctx) => {
      if (event.toolName !== 'write') return;
      const { path: given, content } = event.input as { path?: unknown; content?: unknown };
      if (typeof given !== 'string' || typeof content !== 'string') return;
      const file = path.resolve(ctx.cwd, given);
      let old: string;
      try {
        old = await readFile(file, 'utf8');
      } catch {
        return; // a new file: nothing to lose
      }
      const change = writeChange(lf(old), lf(content));
      if (!change) return;
      if (change.kept < writeGuardMinKept) {
        const key = `${file}\0${createHash('sha256').update(content).digest('hex')}`;
        if (refused !== key) {
          refused = key;
          return { block: true, reason: refusal(given, change) };
        }
        refused = undefined;
      }
      before.set(event.toolCallId, lf(old));
    });
  }
}
