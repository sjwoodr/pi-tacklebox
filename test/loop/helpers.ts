import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults, type LoopConfig } from '../../src/loop/settings.ts';

export const FAKE_PI = [process.execPath, join(import.meta.dirname, 'fake-pi.ts')];

/** A temp dir with a fake-pi config; sets FAKE_PI_CONFIG and FAKE_PI_LOG for the child processes. */
export function fakePi(config: unknown): { dir: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pi-loop-test-'));
  const file = join(dir, 'fake.json');
  writeFileSync(file, JSON.stringify(config));
  process.env.FAKE_PI_CONFIG = file;
  process.env.FAKE_PI_LOG = join(dir, 'calls.jsonl');
  return { dir, log: process.env.FAKE_PI_LOG };
}

/** A git repo with one commit. */
export function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-loop-repo-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-qm', 'start');
  return dir;
}

export function testConfig(sessionsRoot: string, over: Partial<LoopConfig> = {}): LoopConfig {
  return {
    ...defaults(),
    implementer: { model: 'fake/impl', tools: [], maxTurns: 10, maxMinutes: 1 },
    reviewer: { model: 'fake/rev', tools: ['read'], maxTurns: 10, maxMinutes: 1 },
    wrapUpMinutes: 0.5,
    maxRounds: 3,
    maxTotalMinutes: 5,
    gates: ['true'],
    gateRetries: 1,
    startupSeconds: 60,
    sessionsRoot,
    ...over,
  };
}
