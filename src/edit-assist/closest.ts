/**
 * Where a failed edit's oldText was meant to go. pi's edit already forgives whitespace (fuzzyFindText
 * in pi's edit-diff), so an oldText it can't find differs in content. In a Gemma 4 run (2026-11-19)
 * every miss was text from an earlier version of the file, from before one of the model's own edits:
 * eight misses in a row, some straight after a read, before it gave up and rewrote the whole file with
 * write. Showing the current lines where it is looking breaks that loop.
 */

export interface Difference {
  /** 1-based line in the file; absent when the line is only in the oldText. */
  fileLine?: number;
  file?: string;
  /** The oldText's line; absent when the line is only in the file. */
  yours?: string;
}

export interface Closest {
  /** 1-based first and last line of the stretch of the file most like the oldText. */
  start: number;
  end: number;
  /** Non-blank oldText lines the stretch also has, out of total. */
  same: number;
  total: number;
  differences: Difference[];
}

// Lines are compared trimmed, as pi's own matching forgives indentation and trailing spaces.
const norm = (line: string) => line.trim();
// Bounds on the work: the slide is linear in the file; each stretch tried after it costs oldText lines squared.
const MAX_OLD_LINES = 400;
const MAX_FILE_LINES = 50_000;
const MAX_CANDIDATES = 16;
// How far each end of a candidate stretch may move, so an oldText that added or dropped a line still lines up.
const SLACK = 3;
const SLACK_UP_TO = 100;

/**
 * The stretch of text most like oldText. A window as long as oldText slides over the file to find
 * where most of its lines are; each best window's ends then move by up to SLACK lines, and the stretch
 * with the most lines in common wins, then the one closest to oldText's length (so a changed line is
 * shown as changed rather than left out), then the one with the fewest differences to report (a stray
 * line at each end is two; the same line changed is one), then the earliest.
 */
export function closestMatch(text: string, oldText: string): Closest | undefined {
  const file = text.split('\n');
  const want = oldText.replace(/\n+$/, '').split('\n');
  if (want.length > MAX_OLD_LINES || file.length > MAX_FILE_LINES) return undefined;
  const wanted = countLines(want);
  const total = [...wanted.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return undefined;
  const size = Math.min(want.length, file.length);
  const starts = bestWindows(file, size, wanted);
  if (!starts) return undefined;

  let closest: Closest | undefined;
  for (const { from, to } of adjustEnds(file, want, starts, size)) {
    const { same, differences } = compare(file.slice(from, to), want, from + 1);
    const n = differences.length;
    if (!closest || n < closest.differences.length || (n === closest.differences.length && from + 1 < closest.start)) {
      closest = { start: from + 1, end: to, same, total, differences };
    }
  }
  return closest;
}

/** How many times each non-blank line occurs, compared trimmed. */
function countLines(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const k = norm(line);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

/**
 * Starts of the windows of size lines holding the most wanted lines (at most MAX_CANDIDATES), from one
 * window slid over the file with its line counts kept up to date; undefined when none holds any.
 */
function bestWindows(file: string[], size: number, wanted: Map<string, number>): number[] | undefined {
  const counts = new Map<string, number>();
  let overlap = 0;
  const step = (line: string, by: 1 | -1) => {
    const k = norm(line);
    if (!k) return;
    const before = counts.get(k) ?? 0;
    counts.set(k, before + by);
    const want = wanted.get(k) ?? 0;
    overlap += Math.min(before + by, want) - Math.min(before, want);
  };
  for (let i = 0; i < size; i++) step(file[i]!, 1);
  let best = overlap;
  let starts = [0];
  for (let i = size; i < file.length; i++) {
    step(file[i]!, 1);
    step(file[i - size]!, -1);
    if (overlap > best) {
      best = overlap;
      starts = [i - size + 1];
    } else if (overlap === best && starts.length < MAX_CANDIDATES) {
      starts.push(i - size + 1);
    }
  }
  return best > 0 ? starts : undefined;
}

/**
 * Each candidate window with its ends moved by up to SLACK lines: the stretches (end exclusive) with
 * the most lines in common with want, and of those the ones closest to want's length.
 */
function adjustEnds(file: string[], want: string[], starts: number[], size: number): { from: number; to: number }[] {
  const fileN = file.map(norm);
  const wantN = want.map(norm);
  const slack = want.length <= SLACK_UP_TO ? SLACK : 0;
  let best = { common: -1, off: Infinity };
  let tied: { from: number; to: number }[] = [];
  for (const { from, to } of stretches(starts, size, slack, file.length)) {
    const common = lcsTable(fileN.slice(from, to), wantN)[0]![0]!;
    const off = Math.abs(to - from - want.length);
    if (common > best.common || (common === best.common && off < best.off)) {
      best = { common, off };
      tied = [{ from, to }];
    } else if (common === best.common && off === best.off) {
      tied.push({ from, to });
    }
  }
  return tied;
}

/** Every distinct stretch (end exclusive) that a window becomes with each end moved by up to slack lines. */
function stretches(starts: number[], size: number, slack: number, fileLength: number): { from: number; to: number }[] {
  const seen = new Set<string>();
  const out: { from: number; to: number }[] = [];
  for (const s of starts) {
    for (let from = Math.max(0, s - slack); from <= s + slack; from++) {
      for (let to = Math.max(from + 1, s + size - slack); to <= Math.min(fileLength, s + size + slack); to++) {
        const key = `${from}:${to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ from, to });
      }
    }
  }
  return out;
}

/**
 * The non-blank oldText lines a stretch of the file shares, and the lines that differ, paired up in
 * order within each changed run. A difference that is only blank lines is left out.
 */
function compare(window: string[], want: string[], firstLine: number): { same: number; differences: Difference[] } {
  const a = window.map(norm);
  const b = want.map(norm);
  const lcs = lcsTable(a, b);
  const differences: Difference[] = [];
  let fileRun: number[] = [];
  let wantRun: number[] = [];
  let same = 0;
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      differences.push(...pairUp(window, want, firstLine, fileRun, wantRun));
      fileRun = [];
      wantRun = [];
      if (a[i]) same++;
      i++;
      j++;
    } else if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      wantRun.push(j++);
    } else {
      fileRun.push(i++);
    }
  }
  differences.push(...pairUp(window, want, firstLine, fileRun, wantRun));
  return { same, differences };
}

/** Longest common subsequence table of two line lists, filled from the end so a walk can go forward. */
function lcsTable(a: string[], b: string[]): Uint16Array[] {
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  return lcs;
}

/** One changed run's lines paired in order, a file line with an oldText line; pairs of blank lines are left out. */
function pairUp(window: string[], want: string[], firstLine: number, fileRun: number[], wantRun: number[]): Difference[] {
  const out: Difference[] = [];
  for (let k = 0; k < Math.max(fileRun.length, wantRun.length); k++) {
    const fi = fileRun[k];
    const wj = wantRun[k];
    const file = fi === undefined ? undefined : window[fi];
    const yours = wj === undefined ? undefined : want[wj];
    if (!file?.trim() && !yours?.trim()) continue;
    const d: Difference = {};
    if (fi !== undefined) {
      d.fileLine = firstLine + fi;
      d.file = file;
    }
    if (yours !== undefined) d.yours = yours;
    out.push(d);
  }
  return out;
}

/** 1-based line where needle starts in text, if it is there. */
export function lineOf(text: string, needle: string): number | undefined {
  const at = text.indexOf(needle);
  if (at < 0) return undefined;
  let line = 1;
  for (let i = 0; i < at; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

const MAX_DIFFS = 8;
const MAX_SHOWN = 60;
const quote = (line: string) => JSON.stringify(line.length > 160 ? `${line.slice(0, 160)}…` : line);

/**
 * What to tell the model when label (oldText, or edits[N].oldText) isn't in text: the current lines
 * it was most likely aimed at, what differs, and whether its newText is already there.
 */
export function mismatchHint(text: string, label: string, oldText: string, newText?: string): string {
  const out: string[] = [];
  // A newText already in the file means the edit was probably made earlier and is being sent again.
  const already = newText && newText.trim().length >= 20 && newText !== oldText ? lineOf(text, newText) : undefined;
  if (already) {
    out.push(`This edit's newText is already in the file, at line ${already}, so the change may have been made already. read the file before editing it again.`);
  }

  const c = closestMatch(text, oldText);
  if (!c || c.same * 2 < c.total) {
    const nearest = c ? ` (the nearest stretch, lines ${c.start}-${c.end}, shares ${c.same} of its ${c.total} lines)` : '';
    out.push(`Nothing in the file as it is now is close to this ${label}${nearest}. read the file again and copy oldText from what it says now.`);
    return `edit-assist: ${out.join('\n')}`;
  }

  out.push(`This ${label} is not in the file as it is now. The closest stretch is lines ${c.start}-${c.end}, with ${c.same} of its ${c.total} lines the same. Where they differ:`);
  for (const d of c.differences.slice(0, MAX_DIFFS)) {
    if (d.file !== undefined && d.yours !== undefined) {
      out.push(`  line ${d.fileLine} of the file: ${quote(d.file)}`, `  your oldText has:   ${quote(d.yours)}`);
    } else if (d.file !== undefined) {
      out.push(`  line ${d.fileLine} of the file, missing from your oldText: ${quote(d.file)}`);
    } else {
      out.push(`  only in your oldText, not in the file: ${quote(d.yours!)}`);
    }
  }
  if (c.differences.length > MAX_DIFFS) out.push(`  … and ${c.differences.length - MAX_DIFFS} more`);

  // Show the stretch as it is now, from a little before the first difference when it is long.
  const lines = text.split('\n');
  const focus = c.differences.find((d) => d.fileLine !== undefined)?.fileLine ?? c.start;
  const from = c.end - c.start + 1 <= MAX_SHOWN ? c.start : Math.max(c.start, focus - 10);
  const to = Math.min(c.end, from + MAX_SHOWN - 1);
  out.push(
    `The oldText was probably copied from an earlier version of the file. Lines ${from}-${to} as they are now (copy oldText from these, without the fence):`,
    '```',
    ...lines.slice(from - 1, to),
    '```',
  );
  return `edit-assist: ${out.join('\n')}`;
}
