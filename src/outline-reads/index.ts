/**
 * outline-reads: a whole-file read of a large file returns the file's top and
 * an outline instead of its text. On a work Mac the model reads a prompt at
 * ~250-500 tokens/s, so a 106 KB script (which pi's read cuts at 50 KB, ~13k
 * tokens) cost a minute before the model could start thinking, and stayed in
 * the context making every later turn slower. A system-prompt rule ("grep
 * first, read ranges") was ignored: asked what a script does, the model went
 * straight to read. So the rule is enforced here.
 *
 * Only reads with neither offset nor limit, whose text comes back over
 * outlineReads.maxChars (default 20,000), are changed; a read with offset or
 * limit always gets the real lines, so the model can still see any part of the file.
 *
 * Off by default; `"outlineReads": { "enabled": true }` in tacklebox.json turns it on.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadConfig } from '../config.ts';
import { outlineOf } from './outline.ts';

export default function (pi: ExtensionAPI) {
  const { enabled, maxChars } = loadConfig().outlineReads;
  if (!enabled) return;
  pi.on('tool_result', async (event, ctx) => {
    if (event.toolName !== 'read' || event.isError) return;
    const input = event.input as { path?: string; offset?: number; limit?: number };
    if (!input.path || input.offset !== undefined || input.limit !== undefined) return;
    const returned = event.content.reduce((n, c) => n + (c.type === 'text' ? c.text.length : 0), 0);
    if (returned <= maxChars) return;

    let text: string;
    try {
      text = await readFile(path.resolve(ctx.cwd, input.path), 'utf8');
    } catch {
      return;
    }
    return { content: [{ type: 'text', text: outlineOf(input.path, text) }] };
  });
}
