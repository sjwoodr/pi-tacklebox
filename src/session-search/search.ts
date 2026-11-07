import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;
export const MAX_OUTPUT = 8_000;
const MAX_SNIPPET = 200;
const SNIPPETS_PER_SESSION = 5;

export type Mode = 'files' | 'details';

export interface Hit {
  file: string;
  cwd: string;
  date: string;
  count: number;
  snippets: string[];
}

/** Every session file, newest first: a file's name starts with the time the session began. */
export function sessionFiles(root: string): string[] {
  let names: string[];
  try {
    names = readdirSync(root, { recursive: true, encoding: 'utf8' });
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => join(root, name))
    .sort((a, b) => basename(b).localeCompare(basename(a)));
}

const parse = (line: string): any => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

const words = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
      : '';

/** A tool call's target, not its whole arguments: a write's arguments hold the file's contents. */
function call(block: any): string {
  const args = block.arguments ?? {};
  return `${block.name}: ${args.command ?? args.path ?? args.url ?? args.query ?? ''}`.trim();
}

/** The only text that can be searched or shown: what the user said and the commands that ran. */
function visible(entry: any): string[] {
  if (entry?.type !== 'message') return [];
  const { role, content, command, excludeFromContext } = entry.message ?? {};
  if (role === 'user') return [words(content)].filter(Boolean);
  if (role === 'bashExecution') return command && !excludeFromContext ? [`$ ${command}`] : [];
  if (role === 'assistant' && Array.isArray(content)) {
    return content.filter((block) => block?.type === 'toolCall').map(call);
  }
  return [];
}

/** The text around the match, on one line. */
function snippet(text: string, re: RegExp): string {
  const at = Math.max(0, (re.exec(text)?.index ?? 0) - 40);
  const cut = text.slice(at, at + MAX_SNIPPET).replace(/\s+/g, ' ').trim();
  return `${at > 0 ? '...' : ''}${cut}${at + MAX_SNIPPET < text.length ? '...' : ''}`;
}

function searchFile(file: string, re: RegExp): Hit | undefined {
  const lines = readFileSync(file, 'utf8').split('\n');
  const header = parse(lines[0]);
  const hit: Hit = {
    file,
    cwd: header?.cwd ?? '?',
    date: String(header?.timestamp ?? basename(file)).slice(0, 10),
    count: 0,
    snippets: [],
  };
  for (const line of lines) {
    for (const text of visible(parse(line))) {
      if (!re.test(text)) continue;
      hit.count += 1;
      if (hit.snippets.length < SNIPPETS_PER_SESSION) hit.snippets.push(snippet(text, re));
    }
  }
  return hit.count ? hit : undefined;
}

/** Up to `limit` matching sessions, newest first. `more` says some were left out. */
export function search(files: string[], re: RegExp, limit: number): { hits: Hit[]; more: boolean } {
  const hits: Hit[] = [];
  for (const file of files) {
    let hit: Hit | undefined;
    try {
      hit = searchFile(file, re);
    } catch {
      continue;
    }
    if (!hit) continue;
    if (hits.length === limit) return { hits, more: true };
    hits.push(hit);
  }
  return { hits, more: false };
}

/** The hits as text, never longer than MAX_OUTPUT plus the note that says it was cut. */
export function render(hits: Hit[], mode: Mode, more: boolean): string {
  const out: string[] = [];
  let size = 0;
  for (const hit of hits) {
    const matches = `${hit.count} match${hit.count === 1 ? '' : 'es'}`;
    const lines = [`${hit.date}  ${hit.cwd}  ${hit.file}  (${matches})`];
    if (mode === 'details') lines.push(...hit.snippets.map((text) => `  ${text}`));
    for (const line of lines) {
      size += line.length + 1;
      if (size > MAX_OUTPUT) return `${out.join('\n')}\n[output cut at ${MAX_OUTPUT} characters: narrow the regex or lower the limit]`;
      out.push(line);
    }
  }
  return more ? `${out.join('\n')}\n[more sessions match: raise the limit or narrow the regex]` : out.join('\n');
}
