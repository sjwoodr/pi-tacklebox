import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

/** tacklebox.json in pi's agent directory. think-budget keeps its own file (think-budget.json). */
export const CONFIG = 'tacklebox.json';

export type SearchBackend = 'off' | 'searxng' | 'ollama';

export interface Config {
  turnTimer: { enabled: boolean };
  outlineReads: { enabled: boolean; maxChars: number };
  search: { backend: SearchBackend; searxngUrl: string; ollamaUrl: string };
  nudge: { enabled: boolean; maxPerPrompt: number };
  verifyDone: { enabled: boolean; command: string; maxRounds: number; timeoutSeconds: number };
  jobs: { enabled: boolean; blockLong: boolean; waitSeconds: number };
  /** think-budget's rules (see src/think-budget/cap.ts); absent means think-budget.json is read instead. */
  thinkBudget?: { rules: unknown[] };
}

// Anything that reaches outside the machine (search) or changes what the model sees (outline-reads) is
// off until the config turns it on. nudge and verify-done are on: they only add a message when a run
// would otherwise end broken, and verify-done runs the project's own tests (turn it off, or set a
// safe command, in a repo whose tests are slow or touch real services). jobs is on: it adds tools and
// refuses only bash calls that would block for minutes.
export const DEFAULTS: Config = {
  turnTimer: { enabled: true },
  outlineReads: { enabled: false, maxChars: 20_000 },
  search: { backend: 'off', searxngUrl: 'http://127.0.0.1:8888', ollamaUrl: 'http://127.0.0.1:11434' },
  nudge: { enabled: true, maxPerPrompt: 2 },
  // An empty command means detect it from the project (package.json, go.mod, Cargo.toml, pytest, Makefile).
  verifyDone: { enabled: true, command: '', maxRounds: 2, timeoutSeconds: 120 },
  // Long commands run in the background; bash calls that would block for minutes are refused (jobs/long.ts).
  jobs: { enabled: true, blockLong: true, waitSeconds: 900 },
};

const BACKENDS: SearchBackend[] = ['off', 'searxng', 'ollama'];

/** The defaults with the file's settings on top. A setting of the wrong type is an error, not ignored. */
export function parseConfig(raw: unknown): Config {
  const file = (raw ?? {}) as Record<string, Record<string, unknown> | undefined>;
  if (typeof file !== 'object' || Array.isArray(file)) throw new Error('expected a JSON object');
  const out: Config = structuredClone(DEFAULTS);
  for (const section of Object.keys(file)) {
    if (section === 'thinkBudget') {
      const given = file.thinkBudget;
      if (!given || typeof given !== 'object' || !Array.isArray(given.rules) || Object.keys(given).length !== 1)
        throw new Error('"thinkBudget" should be { "rules": [...] }');
      out.thinkBudget = { rules: given.rules };
      continue;
    }
    if (!(section in out)) throw new Error(`unknown section "${section}"`);
    const given = file[section] ?? {};
    const target = out[section as keyof Config] as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(given)) {
      if (!(key in target)) throw new Error(`unknown setting "${section}.${key}"`);
      if (typeof value !== typeof target[key]) throw new Error(`"${section}.${key}" should be a ${typeof target[key]}`);
      target[key] = value;
    }
  }
  if (!BACKENDS.includes(out.search.backend)) {
    throw new Error(`"search.backend" should be one of ${BACKENDS.map((b) => `"${b}"`).join(', ')}`);
  }
  return out;
}

/** The config from pi's agent directory; no file means the defaults. Each extension reads it at load. */
export function loadConfig(dir = getAgentDir()): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, CONFIG), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`${CONFIG}: ${(err as Error).message}`);
  }
  try {
    return parseConfig(raw);
  } catch (err) {
    throw new Error(`${CONFIG}: ${(err as Error).message}`);
  }
}
