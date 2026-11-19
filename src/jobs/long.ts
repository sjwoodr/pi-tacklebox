/**
 * Shell commands that wait on something else for minutes (a deploy, a rollout, a log that never
 * ends) and so block the agent's bash call. A local model ran `gh run watch` in bash and sat blocked
 * on it for 17+ minutes (2026-10-27). Each entry is a pattern and what the command waits on.
 */
const LONG: [RegExp, string][] = [
  [/\bgh\s+run\s+watch\b/, 'a GitHub Actions run'],
  [/\bgh\s+pr\s+checks\b.*--watch\b/, "a pull request's checks"],
  [/\bkubectl\b.*\brollout\s+status\b/, 'a Kubernetes rollout'],
  [/\bkubectl\b.*\bwait\b/, 'a Kubernetes condition'],
  [/\b(kubectl|docker|podman)\b.*\blogs\b.*\s(-f|--follow)\b/, 'a log that never ends'],
  [/\b(kubectl|oc)\b.*\s(-w|--watch)\b/, 'a watch that never ends'],
  [/\btail\b.*\s-[a-zA-Z]*[fF]\b/, 'a file that never ends'],
  [/(^|[;&|]\s*)watch\s/, 'a command repeated forever'],
  [/\b(while|until)\b[\s\S]*\bsleep\b/, 'a polling loop'],
];

/** What a command waits on, when it is one that blocks for minutes; undefined otherwise. */
export function longRunning(command: string): string | undefined {
  const text = withoutWrittenText(command);
  for (const [pattern, what] of LONG) if (pattern.test(text)) return what;
  const sleep = text.match(/\bsleep\s+(\d+)([smh]?)\b/);
  if (sleep) {
    const seconds = Number(sleep[1]) * ({ s: 1, m: 60, h: 3600 } as Record<string, number>)[sleep[2] || 's']!;
    if (seconds >= 60) return `a ${seconds} s sleep`;
  }
  return undefined;
}

/** A heredoc's start: the operator and its delimiter, which may be quoted. */
const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/;

/**
 * The command without the text of heredocs that cat or tee only write out: that text is file content,
 * and a loop in it never runs here. A Gemma 4 run (2026-11-19) had `cat << 'PYEOF' > repro.py` refused
 * as a polling loop because the Python in it had `while True:` and, further down, `asyncio.sleep(1)`.
 * A heredoc read by anything else (python3 <<'EOF', cat <<'EOF' | bash) keeps its text: that runs.
 */
function withoutWrittenText(command: string): string {
  const lines = command.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]!);
    const start = HEREDOC.exec(lines[i]!);
    if (!start || !onlyWritten(lines[i]!)) continue;
    const end = lines.findIndex((line, k) => k > i && line.trim() === start[2]);
    if (end < 0) continue; // no terminator: leave the command as it is
    out.push(lines[end]!);
    i = end;
  }
  return out.join('\n');
}

/** Whether the command on this line that reads the heredoc is cat or tee, with nothing piped after it. */
function onlyWritten(line: string): boolean {
  const reader = line.split(/&&|\|\||;/).find((part) => part.includes('<<')) ?? '';
  return /^\s*(cat|tee)\b/.test(reader) && !reader.includes('|');
}
