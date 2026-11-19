/**
 * How much of an existing file a write keeps. write replaces the whole file, and a small model that has
 * given up on edit uses it to "append": in a Gemma 4 run (2026-11-19) the write meant to add part 3 of a
 * script held only part 3, and the 280 lines before it were gone, with "Successfully wrote" as the
 * result. The same run re-sent the whole file for every one-line change.
 */

export interface WriteChange {
  /** Lines in the file now and in the new content. */
  oldLines: number;
  newLines: number;
  /** Share (0-1) of the file's non-blank lines that the new content still has. */
  kept: number;
  /** Non-blank lines removed plus added. */
  changed: number;
}

// A file this small is cheap to rewrite and to get wrong; no judgement either way.
const MIN_LINES = 20;
const norm = (line: string) => line.trim();

/** What a write of next over old changes; undefined for a file under MIN_LINES non-blank lines. */
export function writeChange(old: string, next: string): WriteChange | undefined {
  const before = old.split('\n').map(norm).filter(Boolean);
  if (before.length < MIN_LINES) return undefined;
  const after = next.split('\n').map(norm).filter(Boolean);
  const left = new Map<string, number>();
  for (const line of after) left.set(line, (left.get(line) ?? 0) + 1);
  let kept = 0;
  for (const line of before) {
    const n = left.get(line) ?? 0;
    if (n > 0) {
      kept++;
      left.set(line, n - 1);
    }
  }
  return {
    oldLines: old.split('\n').length,
    newLines: next.split('\n').length,
    kept: kept / before.length,
    changed: before.length - kept + (after.length - kept),
  };
}

/** A successful write that changed so little that edit would have sent a fraction of it. */
export function isSmallChange(c: WriteChange): boolean {
  return c.changed > 0 && c.changed <= Math.max(3, Math.ceil(c.oldLines * 0.1));
}

export function refusal(path: string, c: WriteChange): string {
  const pct = Math.round(c.kept * 100);
  return (
    `edit-assist: not written. ${path} has ${c.oldLines} lines, and this write would keep only ${pct}% of them ` +
    `(the new content has ${c.newLines} lines). write replaces the whole file, so everything not in this call ` +
    `would be lost. To add code to the file, append it (bash: cat >> ${path} <<'EOF' … EOF) or use edit. ` +
    'If you do mean to replace the file, send exactly the same write again.'
  );
}

export function smallChangeNote(path: string, c: WriteChange): string {
  return (
    `edit-assist: this write sent all ${c.newLines} lines of ${path} again to change about ${c.changed} of them. ` +
    'For a change that small, edit is cheaper and safer: it sends only the lines that change.'
  );
}

const SHAPES: Record<string, string> = {
  edit: '{"path": "<file>", "edits": [{"oldText": "<lines copied exactly from the file>", "newText": "<replacement>"}]}',
  write: '{"path": "<file>", "content": "<the whole new file>"}',
};

/** The call shape to add to a "Validation failed for tool" result for edit or write; undefined otherwise. */
export function argumentHint(toolName: string, error: string, lastPath?: string): string | undefined {
  const shape = SHAPES[toolName];
  if (!shape || !error.startsWith(`Validation failed for tool "${toolName}"`)) return undefined;
  const out = [`edit-assist: ${toolName}'s arguments must look like this, with every key present:`, shape];
  if (/^\s*- path: missing/m.test(error)) {
    out.push(`"path" was missing.${lastPath ? ` The file you last worked on is ${lastPath}.` : ''}`);
  }
  return out.join('\n');
}
