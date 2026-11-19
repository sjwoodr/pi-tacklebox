/**
 * Shell commands that wait on something else for minutes (a deploy, a rollout, a log that never
 * ends) and so block the agent's bash call. A local model ran `gh run watch` in bash and sat blocked
 * on it for 17+ minutes (2026-10-27). Each entry is a pattern, what the command waits on, and a
 * one-shot way to check the same thing.
 */
const LONG: [RegExp, string, string][] = [
  [/\bgh\s+run\s+watch\b/, 'a GitHub Actions run', '`gh run view <id>` instead of `gh run watch`'],
  [/\bgh\s+pr\s+checks\b.*--watch\b/, "a pull request's checks", '`gh pr checks <n>` without `--watch`'],
  [/\bkubectl\b.*\brollout\s+status\b/, 'a Kubernetes rollout', '`kubectl get deploy <name>` instead of `rollout status`'],
  [/\bkubectl\b.*\bwait\b/, 'a Kubernetes condition', '`kubectl get <resource>` instead of `kubectl wait`'],
  [/\b(kubectl|docker|podman)\b.*\blogs\b.*\s(-f|--follow)\b/, 'a log that never ends', '`logs --tail=100` without `-f`'],
  [/\b(kubectl|oc)\b.*\s(-w|--watch)\b/, 'a watch that never ends', 'the same command without `-w`'],
  [/\btail\b.*\s-[a-zA-Z]*[fF]\b/, 'a file that never ends', '`tail -n 100 <file>` without `-f`'],
  [/(^|[;&|]\s*)watch\s/, 'a command repeated forever', 'the command once, without `watch`'],
  // A shell loop: while/until ... do ... sleep N. Program text with a loop and a sleep call in it
  // (python3 -c "...while True: ... asyncio.sleep(1)") is not one; a 2026-11-19 echo test was refused
  // as one. The price is that a Python polling loop goes unnoticed.
  [/\b(while|until)\b[\s\S]*?\bdo\b[\s\S]*?(^|[\s;&|(])sleep\s+[\d$]/m, 'a polling loop', "the loop's check once, without the loop"],
];

export interface LongCommand {
  /** What the command waits on. */
  what: string;
  /** A one-shot way to check the same thing. */
  instead: string;
}

/** What a command waits on and how to check it once, when it blocks for minutes; undefined otherwise. */
export function longRunning(command: string): LongCommand | undefined {
  const text = withoutWrittenText(command);
  for (const [pattern, what, instead] of LONG) if (pattern.test(text)) return { what, instead };
  const sleep = text.match(/\bsleep\s+(\d+)([smh]?)\b/);
  if (sleep) {
    const seconds = Number(sleep[1]) * ({ s: 1, m: 60, h: 3600 } as Record<string, number>)[sleep[2] || 's']!;
    if (seconds >= 60) return { what: `a ${seconds} s sleep`, instead: 'the command without the sleep' };
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
