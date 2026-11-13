/**
 * The shared part of the sandbox: srt's settings, the command wrapper and the path checks for pi's
 * file tools. Every place tacklebox runs a shell command calls `shellCommand`, so a sandbox that is on
 * covers jobs, verify-done and the loop's gates as well as pi's bash tool.
 */
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Config, getAgentDir, loadConfig } from '../config.ts';

/** The path lists the file tools are checked against: the same ones srt enforces for commands. */
export interface Rules {
  denyRead: string[];
  allowWrite: string[];
  denyWrite: string[];
}

export interface Sandbox {
  srt: string;
  settings: string;
  rules: Rules;
  /** Glob entries in the settings: srt enforces them for commands, the file-tool checks skip them. */
  skipped: string[];
  wrap(command: string): string;
  env(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
}

/** POSIX shell quoting: the string comes back out of `sh -c` unchanged. */
export const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Variable names that look like a secret. They never reach a sandboxed command. */
export const SECRET_NAME = /TOKEN|SECRET|PASSW(?:OR)?D|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL/i;

export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !SECRET_NAME.test(name)));
}

const GLOB = /[*?[\]]/;

/** `~`, `~/x` and relative paths, the way srt reads them. */
export function expand(p: string, cwd: string, home = homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return resolve(cwd, p);
}

const UNICODE_SPACES = /[  -   　]/g;

/**
 * A tool's path argument resolved the way pi's file tools resolve it (resolveToCwd in pi's
 * path-utils): Unicode spaces become plain ones, a leading @ goes, ~ and file:// URLs expand.
 * Checking any other reading of it would let `~/.ssh/x` pass as a folder named `~` in the project.
 */
export function toolPath(p: string, cwd: string, home = homedir()): string {
  let s = p.replace(UNICODE_SPACES, ' ');
  if (s.startsWith('@')) s = s.slice(1);
  if (s === '~') s = home;
  else if (s.startsWith('~/')) s = join(home, s.slice(2));
  else if (s.startsWith('file://')) s = fileURLToPath(s);
  return resolve(cwd, s);
}

/** The other spellings pi's read tool opens when the path does not exist as given (macOS screenshot names). */
export function readVariants(p: string): string[] {
  const nfd = p.normalize('NFD');
  return [...new Set([p, p.replace(/ (AM|PM)\./gi, ' $1.'), nfd, p.replace(/'/g, '’'), nfd.replace(/'/g, '’')])];
}

/** The real path, following symlinks; for a path that does not exist yet, its nearest existing parent's. */
export function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(real(parent), basename(p));
  }
}

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

// srt blocks writes to these whatever the settings say; the file tools get the same list.
const PROTECTED_NAMES = new Set(['.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile', '.gitconfig', '.gitmodules', '.ripgreprc', '.mcp.json']);
const PROTECTED_DIRS = [['.vscode'], ['.idea'], ['.claude', 'commands'], ['.claude', 'agents']];

/** Why a write to `p` is refused regardless of allowWrite, or undefined. Anything in or named `.git` counts. */
export function protectedReason(p: string): string | undefined {
  const parts = p.split(sep);
  if (parts.includes('.git')) return 'git metadata (.git) is protected';
  if (PROTECTED_NAMES.has(basename(p))) return `${basename(p)} is protected`;
  for (const dir of PROTECTED_DIRS) {
    for (let i = 0; i + dir.length <= parts.length; i++) {
      if (dir.every((d, j) => parts[i + j] === d)) return `${dir.join('/')} is protected`;
    }
  }
  return undefined;
}

/** Why the call is refused, or undefined. Only file tools are checked; bash runs inside srt instead. */
export function checkCall(toolName: string, input: Record<string, unknown>, cwd: string, rules: Rules): string | undefined {
  const at = (key: string) => (typeof input[key] === 'string' ? real(toolPath(input[key] as string, cwd)) : undefined);
  const deniedRead = (p: string) => rules.denyRead.find((d) => inside(p, real(expand(d, cwd))));
  switch (toolName) {
    case 'read': {
      if (typeof input.path !== 'string') return undefined;
      const given = toolPath(input.path, cwd);
      for (const p of readVariants(given).map(real)) {
        const hit = deniedRead(p);
        if (hit) return `reading ${p} is denied (denyRead ${hit})`;
      }
      return undefined;
    }
    case 'write':
    case 'edit': {
      const p = at('path');
      if (!p) return undefined;
      const hit = deniedRead(p);
      if (hit) return `${p} is denied (denyRead ${hit})`;
      const why = protectedReason(p);
      if (why) return `writing ${p}: ${why}`;
      const denied = rules.denyWrite.find((d) => inside(p, real(expand(d, cwd))));
      if (denied) return `writing ${p} is denied (denyWrite ${denied})`;
      if (!rules.allowWrite.some((a) => inside(p, real(expand(a, cwd))))) return `writing ${p} is outside allowWrite`;
      return undefined;
    }
    case 'grep':
    case 'find':
    case 'ls': {
      const p = at('path') ?? real(cwd);
      const hit = deniedRead(p);
      if (hit) return `${toolName} on ${p} is denied (denyRead ${hit})`;
      // A search from above a denied folder would walk into it; ls only lists names, so it may.
      const below = toolName !== 'ls' && rules.denyRead.find((d) => inside(real(expand(d, cwd)), p));
      return below ? `${toolName} on ${p} would search ${below}, which is denied` : undefined;
    }
    default:
      return undefined;
  }
}

/** The executable srt names: a path is checked as given, a bare name is looked up on PATH. */
function findExecutable(name: string, cwd: string): string | undefined {
  const runnable = (p: string) => {
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (name.includes('/')) {
    const p = expand(name, cwd);
    return runnable(p) ? p : undefined;
  }
  return (process.env.PATH ?? '').split(delimiter).map((d) => join(d, name)).find(runnable);
}

const list = (v: unknown, where: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`${where} should be a list of strings`);
  return v as string[];
};

/** The sandbox the settings describe. Throws, naming what is missing, when it cannot be used. */
export function loadSandbox(settings: Config['sandbox'], agentDir = getAgentDir(), cwd = process.cwd()): Sandbox {
  const file = settings.settings.startsWith('~') || isAbsolute(settings.settings) ? expand(settings.settings, cwd) : join(agentDir, settings.settings);
  let raw: { filesystem?: Record<string, unknown> };
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`sandbox is on, but its srt settings could not be read (${file}): ${(err as Error).message}`);
  }
  const fs = raw.filesystem ?? {};
  const all = {
    denyRead: list(fs.denyRead, 'filesystem.denyRead'),
    allowWrite: list(fs.allowWrite, 'filesystem.allowWrite'),
    denyWrite: list(fs.denyWrite, 'filesystem.denyWrite'),
  };
  const skipped = Object.values(all).flat().filter((p) => GLOB.test(p));
  const rules: Rules = {
    denyRead: all.denyRead.filter((p) => !GLOB.test(p)),
    allowWrite: all.allowWrite.filter((p) => !GLOB.test(p)),
    denyWrite: all.denyWrite.filter((p) => !GLOB.test(p)),
  };
  const srt = findExecutable(settings.srt, cwd);
  if (!srt) throw new Error(`sandbox is on, but "${settings.srt}" was not found: install @anthropic-ai/sandbox-runtime or set sandbox.srt`);
  return {
    srt,
    settings: file,
    rules,
    skipped,
    wrap: (command) => `exec ${shQuote(srt)} --settings ${shQuote(file)} bash -c ${shQuote(command)}`,
    env: scrubEnv,
  };
}

/**
 * The command and environment to spawn with: unchanged when the sandbox is off, wrapped in srt and
 * scrubbed of secrets when it is on. Throws when the sandbox is on but cannot be used, so a caller
 * never falls back to running the command unprotected.
 */
export function shellCommand(command: string, cwd = process.cwd()): { command: string; env: NodeJS.ProcessEnv } {
  const settings = loadConfig().sandbox;
  if (!settings.enabled) return { command, env: process.env };
  const box = loadSandbox(settings, getAgentDir(), cwd);
  return { command: box.wrap(command), env: box.env(process.env) };
}
