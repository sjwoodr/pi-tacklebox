import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseArgs } from '../../src/loop/args.ts';
import { describeConfig, subcommandOf } from '../../src/loop/show-config.ts';
import { defaults, loopConfig } from '../../src/loop/settings.ts';
import { makeReviewCopy, workFingerprint } from '../../src/loop/review-copy.ts';
import { isClean, parseVerdict } from '../../src/loop/verdict.ts';
import { STEP_ENV } from '../../src/loop/step.ts';
import { gitRepo } from './helpers.ts';

test('verdict: the last VERDICT line wins, findings are counted by tag', () => {
  const v = parseVerdict('1. [critical] no check\n2. [High] leak\n3. [minor] name\nVERDICT: CHANGES');
  assert.deepEqual(v, { verdict: 'CHANGES', counts: { critical: 1, high: 1, minor: 1 } });
  assert.equal(parseVerdict('**VERDICT: PASS**').verdict, 'PASS');
  assert.equal(parseVerdict('looks fine to me').verdict, 'NONE');
});

test('verdict: a PASS with a critical or high finding is not clean', () => {
  assert.ok(isClean(parseVerdict('[minor] nit\nVERDICT: PASS')));
  assert.ok(!isClean(parseVerdict('[high] bug\nVERDICT: PASS')));
  assert.ok(!isClean(parseVerdict('nothing to add')));
  // Gemma's real round-2 PASS: the tags named in prose are not findings.
  const gemma = parseVerdict('All previous errors are fixed.\n\nNo remaining [high] or [minor] errors were found.\n\nVERDICT: PASS');
  assert.deepEqual(gemma.counts, { critical: 0, high: 0, minor: 0 });
  assert.ok(isClean(gemma));
  const marked = parseVerdict('- **[high]** a\n* [minor] b\n  2) [critical] c\n| [high] | d |\n> [minor] e\nVERDICT: CHANGES');
  assert.deepEqual(marked.counts, { critical: 1, high: 2, minor: 2 }, 'list markers, bold, numbering, tables and quotes still count');
});

test('config: the loop section of tacklebox.json and /loop options merge per role; mistakes are errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tacklebox-loop-'));
  const file = join(dir, 'tacklebox.json');
  writeFileSync(file, JSON.stringify({ loop: { enabled: true, maxRounds: 2, reviewer: { maxMinutes: 5 } } }));
  const c = loopConfig({ reviewer: { model: 'x/y' } as never }, dir);
  assert.equal(c.maxRounds, 2);
  assert.equal(c.reviewer.maxMinutes, 5);
  assert.equal(c.reviewer.model, 'x/y');
  assert.equal(c.reviewer.maxTurns, defaults(dir).reviewer.maxTurns, 'unset role settings keep their defaults');
  assert.deepEqual(c.reviewer.tools, defaults(dir).reviewer.tools);
  assert.equal(c.sessionsRoot, join(dir, 'sessions', 'loop'));
  writeFileSync(file, JSON.stringify({ loop: { rounds: 2 } }));
  assert.throws(() => loopConfig({}, dir), /unknown setting "loop.rounds"/);
  writeFileSync(file, JSON.stringify({ loop: { reviewer: { maxTurns: 'lots' } } }));
  assert.throws(() => loopConfig({}, dir), /"loop.reviewer.maxTurns" should be a number/);
  writeFileSync(file, JSON.stringify({ loop: { gates: ['npm test', 3] } }));
  assert.throws(() => loopConfig({}, dir), /list of strings/);
  assert.throws(() => loopConfig({ bogus: 1 } as never, join(dir, 'none')), /unknown setting "bogus"/);
});

test('args: leading options, then the task verbatim', () => {
  const { overrides, task } = parseArgs('--rounds 2 --reviewer a/b:off Add a thing.\n\nRequirements: x --y');
  assert.equal(overrides.maxRounds, 2);
  assert.equal(overrides.reviewer?.model, 'a/b:off');
  assert.equal(task, 'Add a thing.\n\nRequirements: x --y');
  assert.deepEqual(parseArgs('--no-gates -- --rounds is text').task, '--rounds is text');
  assert.throws(() => parseArgs('--bogus task'), /unknown option --bogus/);
});

test('review copy: has the uncommitted work, and nothing done in it reaches the repo', () => {
  const repo = gitRepo();
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
  writeFileSync(join(repo, 'new.txt'), 'new file\n');
  const before = workFingerprint(repo);
  const copy = makeReviewCopy(repo, 't');
  try {
    assert.equal(readFileSync(join(copy.path, 'a.txt'), 'utf8'), 'one\ntwo\n');
    assert.equal(readFileSync(join(copy.path, 'new.txt'), 'utf8'), 'new file\n');
    writeFileSync(join(copy.path, 'a.txt'), 'vandalized\n');
    execFileSync('git', ['stash', '-u', '-q'], { cwd: copy.path });
  } finally {
    copy.remove();
  }
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'one\ntwo\n');
  assert.ok(existsSync(join(repo, 'new.txt')));
  assert.equal(workFingerprint(repo), before);
  assert.ok(!existsSync(copy.path), 'the copy is gone');
  const worktrees = execFileSync('git', ['worktree', 'list'], { cwd: repo }).toString().trim().split('\n');
  assert.equal(worktrees.length, 1);
});

test('fingerprint changes with tracked or untracked work, and not otherwise', () => {
  const repo = gitRepo();
  const a = workFingerprint(repo);
  assert.equal(workFingerprint(repo), a);
  writeFileSync(join(repo, 'b.txt'), 'b\n');
  const b = workFingerprint(repo);
  assert.notEqual(b, a);
  writeFileSync(join(repo, 'b.txt'), 'b2\n');
  assert.notEqual(workFingerprint(repo), b);
});

test('subcommands only when the word is the whole argument', () => {
  assert.equal(subcommandOf('config'), 'config');
  assert.equal(subcommandOf('  STATUS '), 'status');
  assert.equal(subcommandOf('stop'), 'stop');
  assert.equal(subcommandOf('config the logger to write JSON'), undefined);
  assert.equal(subcommandOf('Add a stop button'), undefined);
});

test('config description: models (or a reminder to set them), limits, rounds and time, with file changes marked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tacklebox-loop-'));
  const file = join(dir, 'tacklebox.json');
  writeFileSync(file, JSON.stringify({ loop: { maxRounds: 2, reviewer: { model: 'x/y:off' } } }));
  const text = describeConfig(loopConfig({}, dir), file);
  assert.match(text, /reviewer: x\/y:off  \(set in file\)/);
  assert.match(text, /implementer: \(not set: name it in tacklebox.json\)/);
  assert.match(text, /rounds: up to 2  \(set in file\)/);
  assert.match(text, /total time: 75 min\n/);
  assert.match(describeConfig(loopConfig({}, join(dir, 'none')), join(dir, 'none', 'tacklebox.json')), /not found: defaults/);
});

test('the extension is on by default, off when tacklebox.json says so, and absent inside a loop step', async () => {
  const { default: loop } = await import('../../src/loop/index.ts');
  const load = (config?: object) => {
    const dir = mkdtempSync(join(tmpdir(), 'tacklebox-loop-ext-'));
    if (config) writeFileSync(join(dir, 'tacklebox.json'), JSON.stringify(config));
    const before = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    const commands: string[] = [];
    try {
      loop({ registerCommand: (name: string) => commands.push(name), registerTool: (tool: { name: string }) => commands.push(`tool:${tool.name}`), on: () => {}, sendMessage: () => {} } as never);
    } finally {
      if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = before;
    }
    return commands;
  };
  const all = ['loop', 'flow', 'tool:flow_run', 'loop-status', 'loop-stop'];
  // A step's pi passes STEP_ENV to what it runs (this suite, when a loop works on tacklebox): clear it here.
  const step = process.env[STEP_ENV];
  delete process.env[STEP_ENV];
  try {
    assert.deepEqual(load(), all, 'on by default: no tacklebox.json');
    assert.deepEqual(load({ loop: { enabled: false } }), []);
    assert.deepEqual(load({ loop: { enabled: true } }), all);
    process.env[STEP_ENV] = '1';
    assert.deepEqual(load(), [], 'nothing registers inside a loop step\'s own pi');
  } finally {
    if (step === undefined) delete process.env[STEP_ENV];
    else process.env[STEP_ENV] = step;
  }
  assert.equal(subcommandOf('workflows'), 'workflows');
});

test('the CLI runs with plain node from a copy with no node_modules, as pi installs packages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tacklebox-installed-'));
  const repo = join(import.meta.dirname, '..', '..');
  execFileSync('cp', ['-r', join(repo, 'src'), join(repo, 'package.json'), dir]);
  const out = execFileSync(process.execPath, [join(dir, 'src', 'loop', 'cli.ts'), '--help'], { cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: dir } }).toString();
  assert.match(out, /pi-loop \[options\] <task>/);
});
