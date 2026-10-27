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
  for (const [pattern, what] of LONG) if (pattern.test(command)) return what;
  const sleep = command.match(/\bsleep\s+(\d+)([smh]?)\b/);
  if (sleep) {
    const seconds = Number(sleep[1]) * ({ s: 1, m: 60, h: 3600 } as Record<string, number>)[sleep[2] || 's']!;
    if (seconds >= 60) return `a ${seconds} s sleep`;
  }
  return undefined;
}
