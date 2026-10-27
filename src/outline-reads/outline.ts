export const TOP_LINES = 80;
export const MAX_OUTLINE = 150;

// Definitions and headings in the languages that turn up here: shell, Python,
// JS/TS, Go, Ruby, Markdown.
const OUTLINE =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\b|def\s|class\s|func\s|interface\s|type\s+\w+\s*=|(?:const|let)\s+\w+\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>|[A-Za-z_][\w:.-]*\s*\(\)\s*\{|#{1,3}\s)/;

/** What a whole-file read of a large file returns instead: a note, the file's top, and an outline of the rest. */
export function outlineOf(name: string, text: string): string {
  const lines = text.split('\n');
  const outline: string[] = [];
  for (let i = TOP_LINES; i < lines.length && outline.length < MAX_OUTLINE; i++) {
    if (OUTLINE.test(lines[i]!)) outline.push(`${i + 1}: ${lines[i]!.trimEnd().slice(0, 160)}`);
  }
  const kb = Math.round(Buffer.byteLength(text) / 1024);
  const note =
    `[${name} is ${kb} KB, ${lines.length} lines: too large to read whole on this machine (about a minute ` +
    `per 100 KB). Shown: lines 1-${Math.min(TOP_LINES, lines.length)} and an outline of the rest (line: definition). ` +
    "Read the parts you need with the read tool's offset and limit, e.g. the main flow and any function the " +
    "outline leaves unclear. Don't ask for the whole file again.]";
  return [
    note,
    '',
    lines.slice(0, TOP_LINES).join('\n'),
    '',
    `--- outline (${outline.length}${outline.length === MAX_OUTLINE ? '+, cut' : ''} entries after line ${TOP_LINES}) ---`,
    outline.join('\n') || '(no definitions found: read ranges by line number)',
  ].join('\n');
}
