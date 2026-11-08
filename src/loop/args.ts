import type { LoopConfig } from './settings.ts';

export const USAGE = `/loop [options] <task>
  --rounds N          review rounds (default from pi-loop.json, else 3)
  --minutes N         total time budget for the whole loop
  --implementer M     implementer model pattern, e.g. ollama/beam:cloud:medium
  --reviewer M        reviewer model pattern, e.g. lmstudio/qwen/qwen3.8-27b:off
  --no-gates          skip the loop's own test and type-check runs`;

/** Leading --options, then the task (the rest, verbatim). Shared by /loop and the pi-loop CLI. */
export function parseArgs(input: string): { overrides: Partial<LoopConfig>; task: string } {
  const overrides: Partial<LoopConfig> = {};
  let rest = input.trimStart();
  const take = () => {
    const m = /^(\S+)\s*/.exec(rest);
    if (!m) throw new Error(`missing value\n${USAGE}`);
    rest = rest.slice(m[0].length);
    return m[1];
  };
  const num = (flag: string) => {
    const v = Number(take());
    if (!Number.isFinite(v) || v <= 0) throw new Error(`${flag} needs a positive number`);
    return v;
  };
  for (;;) {
    const m = /^(--[a-z-]*)(?:\s+|$)/.exec(rest);
    if (!m) break;
    rest = rest.slice(m[0].length);
    switch (m[1]) {
      case '--rounds': overrides.maxRounds = Math.round(num('--rounds')); break;
      case '--minutes': overrides.maxTotalMinutes = num('--minutes'); break;
      case '--implementer': overrides.implementer = { model: take() } as LoopConfig['implementer']; break;
      case '--reviewer': overrides.reviewer = { model: take() } as LoopConfig['reviewer']; break;
      case '--no-gates': overrides.gates = []; break;
      case '--': return { overrides, task: rest.trim() };
      default: throw new Error(`unknown option ${m[1]}\n${USAGE}`);
    }
  }
  return { overrides, task: rest.trim() };
}
