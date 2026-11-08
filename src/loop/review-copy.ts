/**
 * The reviewer works on a throwaway copy of the work, so its "read-only" is real: a git stash, a test
 * that writes files or a stray edit lands in the copy, never in the repo the implementer works in.
 *
 * The copy is a detached git worktree at HEAD, plus the uncommitted changes (tracked diff and untracked
 * files). node_modules is linked, not copied, so tests run without an install.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const git = (cwd: string, args: string[], input?: Buffer) =>
  execFileSync('git', args, { cwd, input, maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });

export interface ReviewCopy {
  path: string;
  remove(): void;
}

export function makeReviewCopy(repo: string, label: string): ReviewCopy {
  const parent = mkdtempSync(join(tmpdir(), `pi-loop-review-${label}-`));
  const path = join(parent, 'repo');
  git(repo, ['worktree', 'add', '--detach', '--quiet', path, 'HEAD']);
  const diff = git(repo, ['diff', '--binary', 'HEAD']);
  if (diff.length) git(path, ['apply', '--whitespace=nowarn'], diff);
  const untracked = git(repo, ['ls-files', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean);
  for (const f of untracked) {
    mkdirSync(dirname(join(path, f)), { recursive: true });
    cpSync(join(repo, f), join(path, f), { recursive: true });
  }
  if (existsSync(join(repo, 'node_modules')) && !existsSync(join(path, 'node_modules')))
    symlinkSync(join(repo, 'node_modules'), join(path, 'node_modules'), 'dir');
  return {
    path,
    remove() {
      try { git(repo, ['worktree', 'remove', '--force', path]); } catch {}
      rmSync(parent, { recursive: true, force: true });
      try { git(repo, ['worktree', 'prune']); } catch {}
    },
  };
}

/** A fingerprint of the uncommitted work: unchanged between two rounds means no progress. */
export function workFingerprint(repo: string): string {
  const diff = git(repo, ['diff', 'HEAD']).toString();
  const untracked = git(repo, ['ls-files', '--others', '--exclude-standard', '-z']).toString();
  const files = untracked.split('\0').filter(Boolean).map((f) => {
    try { return f + '\0' + git(repo, ['hash-object', f]).toString().trim(); } catch { return f; }
  });
  return git(repo, ['hash-object', '--stdin'], Buffer.from(diff + '\0' + files.join('\n'))).toString().trim();
}
