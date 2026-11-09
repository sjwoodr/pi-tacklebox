/**
 * The reviewer ends with a verdict line and tags each finding with a severity, so the loop, not a
 * model, decides whether another round is needed.
 */
export type Severity = 'critical' | 'high' | 'minor';

export interface Verdict {
  /** PASS or CHANGES from the reviewer's VERDICT line; NONE when it wrote none. */
  verdict: 'PASS' | 'CHANGES' | 'NONE';
  counts: Record<Severity, number>;
}

export const VERDICT_RULES = `End your report with exactly one line, the last line:
VERDICT: PASS     when nothing critical or high is left
VERDICT: CHANGES  otherwise
Tag every finding with its severity at the start of its line: [critical], [high] or [minor].
critical = a requirement is broken or missing, or private data can leak; high = wrong behavior a user
would hit; minor = style, naming, small gaps.`;

export function parseVerdict(text: string): Verdict {
  const counts: Record<Severity, number> = { critical: 0, high: 0, minor: 0 };
  // Only a tag that starts a finding counts (after list markers, bold, a quote or a table pipe): "No remaining
  // [high] or [minor] errors were found" in a PASS is prose, not two findings.
  for (const m of text.matchAll(/^[ \t>#*_|+•-]*(?:\d+[.)][ \t]*)?[*_`]*\[(critical|high|minor)\]/gim)) counts[m[1].toLowerCase() as Severity]++;
  const lines = [...text.matchAll(/^\s*\**\s*VERDICT\s*:\s*\**\s*(PASS|CHANGES)\b/gim)];
  const verdict = lines.length ? (lines[lines.length - 1][1].toUpperCase() as 'PASS' | 'CHANGES') : 'NONE';
  return { verdict, counts };
}

/** Done when the reviewer passes it and tagged nothing critical or high (a PASS with blockers is not a pass). */
export function isClean(v: Verdict): boolean {
  return v.verdict === 'PASS' && v.counts.critical === 0 && v.counts.high === 0;
}
