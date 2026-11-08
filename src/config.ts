import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** tacklebox.json in pi's agent directory. think-budget keeps its own file (think-budget.json). */
export const CONFIG = 'tacklebox.json';

export type SearchBackend = 'off' | 'searxng' | 'ollama';

/** One role in the loop: a pi model pattern (thinking level on the end) and its per-step limits. */
export interface LoopRole {
  model: string;
  /** pi --tools allowlist; empty for pi's defaults. */
  tools: string[];
  maxTurns: number;
  maxMinutes: number;
}

export interface LoopSettings {
  enabled: boolean;
  implementer: LoopRole;
  reviewer: LoopRole;
  /** Minutes for the ask after a step is aborted at a limit. */
  wrapUpMinutes: number;
  maxRounds: number;
  maxTotalMinutes: number;
  /** Commands the loop runs itself after every implementer step; empty to skip. */
  gates: string[];
  gateTimeoutMinutes: number;
  gateRetries: number;
  /** A step whose pi doesn't answer in this many seconds is killed and retried once. */
  startupSeconds: number;
  /** The workflow /loop runs by default: "review-loop", "review", or one named in workflows. */
  workflow: string;
  /** Named workflows (see docs/loop.md), checked when the loop loads them. */
  workflows: Record<string, unknown>;
}

export interface Config {
  turnTimer: { enabled: boolean };
  outlineReads: { enabled: boolean; maxChars: number };
  search: { backend: SearchBackend; searxngUrl: string; ollamaUrl: string };
  nudge: { enabled: boolean; maxPerPrompt: number };
  verifyDone: { enabled: boolean; command: string; maxRounds: number; timeoutSeconds: number };
  jobs: { enabled: boolean; blockLong: boolean; waitSeconds: number };
  bang: { enabled: boolean };
  sessionSearch: { enabled: boolean; allowNonLocal: boolean };
  loop: LoopSettings;
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
  // On: `!` answers at once, at the price of a model call; `!!` still just runs the command.
  bang: { enabled: true },
  // On: reads past sessions from disk, and refuses a model that isn't local since results can hold private work.
  sessionSearch: { enabled: true, allowNonLocal: false },
  // Off: it runs other models for many minutes and needs them named (implementer.model, reviewer.model).
  loop: {
    enabled: false,
    implementer: { model: '', tools: [], maxTurns: 40, maxMinutes: 15 },
    reviewer: { model: '', tools: ['read', 'grep', 'find', 'ls', 'bash'], maxTurns: 45, maxMinutes: 12 },
    wrapUpMinutes: 6,
    maxRounds: 3,
    maxTotalMinutes: 75,
    gates: ['npm test', 'npm run check'],
    gateTimeoutMinutes: 5,
    gateRetries: 1,
    startupSeconds: 60,
    workflow: 'review-loop',
    workflows: {},
  },
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
    assign(out[section as keyof Config] as unknown as Record<string, unknown>, file[section] ?? {}, section);
  }
  if (!BACKENDS.includes(out.search.backend)) {
    throw new Error(`"search.backend" should be one of ${BACKENDS.map((b) => `"${b}"`).join(', ')}`);
  }
  return out;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const kind = (v: unknown) => (Array.isArray(v) ? 'list' : typeof v);

/** Copies settings onto the defaults, checking names and types; nested sections (loop.reviewer) merge too. */
function assign(target: Record<string, unknown>, given: unknown, path: string) {
  if (!isPlainObject(given)) throw new Error(`"${path}" should be an object`);
  for (const [key, value] of Object.entries(given)) {
    const where = `${path}.${key}`;
    if (!(key in target)) throw new Error(`unknown setting "${where}"`);
    if (where === 'loop.workflows') {
      // Free-form: workflow names are the user's; the loop validates each workflow when it loads them.
      if (!isPlainObject(value)) throw new Error(`"${where}" should be an object of named workflows`);
      target[key] = value;
      continue;
    }
    if (isPlainObject(target[key])) {
      assign(target[key] as Record<string, unknown>, value, where);
      continue;
    }
    if (kind(value) !== kind(target[key])) throw new Error(`"${where}" should be a ${kind(target[key])}`);
    if (Array.isArray(value) && value.some((v) => typeof v !== 'string')) throw new Error(`"${where}" should be a list of strings`);
    target[key] = value;
  }
}

/**
 * pi's agent directory, found the way pi's getAgentDir does (PI_CODING_AGENT_DIR, else ~/.pi/agent) but without
 * importing pi: an installed package has no node_modules, so the loop's CLI loads this file with plain node.
 */
export function getAgentDir(): string {
  const env = process.env.PI_CODING_AGENT_DIR;
  if (env) return env === '~' ? homedir() : env.startsWith('~/') ? join(homedir(), env.slice(2)) : env;
  return join(homedir(), '.pi', 'agent');
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
