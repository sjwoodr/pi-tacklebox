import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Jobs } from '../../src/jobs/jobs.ts';
import { runGate } from '../../src/loop/gates.ts';
import sandbox from '../../src/sandbox/index.ts';
import { checkCall, expand, loadSandbox, protectedReason, type Rules, scrubEnv, shellCommand, shQuote } from '../../src/sandbox/sandbox.ts';
import { runTests } from '../../src/verify-done/run.ts';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'tacklebox-sandbox-')));

/** Runs `fn` with pi's agent dir set to a fresh directory holding the given tacklebox.json. */
function withAgentDir<T>(tacklebox: object | undefined, fn: (dir: string) => T): T {
  const dir = tmp();
  if (tacklebox) writeFileSync(join(dir, 'tacklebox.json'), JSON.stringify(tacklebox));
  const before = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = before;
  }
}

/** A stand-in srt: an executable that runs its command, so the wrapping can be checked without a sandbox. */
function fakeSrt(dir: string) {
  const path = join(dir, 'fake-srt');
  writeFileSync(path, '#!/bin/sh\n# fake-srt --settings FILE bash -c CMD\nshift 2\nexec "$@"\n');
  chmodSync(path, 0o755);
  return path;
}

const SETTINGS = { network: { allowedDomains: [], deniedDomains: [] }, filesystem: { denyRead: [], allowWrite: ['.'], denyWrite: [] } };

test('shQuote survives sh -c for quotes, $, backticks and newlines', () => {
  for (const s of [`it's`, `"double" and 'single'`, '$HOME `id` $(id)', 'two\nlines', '']) {
    assert.equal(execFileSync('sh', ['-c', `printf %s ${shQuote(s)}`]).toString(), s);
  }
});

test('scrubEnv drops variables named like secrets and keeps the rest', () => {
  const env = scrubEnv({
    GITHUB_TOKEN: 'x', SLACK_BOT_TOKEN: 'x', GEMINI_API_KEY: 'x', NODE_AUTH_TOKEN: 'x', RESTIC_PASSWORD_FILE: 'x',
    AWS_SECRET_ACCESS_KEY: 'x', MY_APIKEY: 'x', PATH: '/bin', HOME: '/h', GIT_CONFIG_KEY_0: 'core.x', XAUTHORITY: '/x',
  });
  assert.deepEqual(Object.keys(env).sort(), ['GIT_CONFIG_KEY_0', 'HOME', 'PATH', 'XAUTHORITY']);
});

test('expand reads ~, ~/x and relative paths the way srt does', () => {
  assert.equal(expand('~', '/w', '/h'), '/h');
  assert.equal(expand('~/.ssh', '/w', '/h'), '/h/.ssh');
  assert.equal(expand('.', '/w', '/h'), '/w');
  assert.equal(expand('/tmp', '/w', '/h'), '/tmp');
});

test('protected paths match srt: .git anywhere, shell and git rc files, IDE and Claude dirs', () => {
  for (const p of ['/w/.git/hooks/pre-commit', '/w/.git/config', '/w/sub/.git', '/w/.bashrc', '/w/.gitconfig', '/w/.mcp.json', '/w/.vscode/settings.json', '/w/.claude/commands/x.md', '/w/a/.claude/agents/y.md']) {
    assert.ok(protectedReason(p), p);
  }
  for (const p of ['/w/src/a.ts', '/w/.claude/settings.json', '/w/.github/workflows/ci.yml', '/w/gitconfig.md']) {
    assert.equal(protectedReason(p), undefined, p);
  }
});

test('checkCall applies denyRead, allowWrite and denyWrite to the file tools, through symlinks', () => {
  const root = tmp();
  const home = join(root, 'home');
  const proj = join(root, 'proj');
  const out = join(root, 'out');
  mkdirSync(join(home, '.ssh'), { recursive: true });
  writeFileSync(join(home, '.ssh', 'id'), 'key');
  mkdirSync(proj);
  mkdirSync(out);
  writeFileSync(join(proj, 'a.txt'), 'a');
  writeFileSync(join(proj, 'secret.txt'), 's');
  symlinkSync(join(home, '.ssh'), join(proj, 'link'));
  const rules: Rules = { denyRead: [join(home, '.ssh')], allowWrite: ['.', out], denyWrite: [join(proj, 'secret.txt')] };
  const check = (tool: string, input: Record<string, unknown>) => checkCall(tool, input, proj, rules);

  assert.equal(check('read', { path: 'a.txt' }), undefined);
  assert.match(check('read', { path: join(home, '.ssh', 'id') }) ?? '', /denyRead/);
  assert.match(check('read', { path: 'link/id' }) ?? '', /denyRead/, 'a symlink into a denied folder');

  assert.equal(check('write', { path: 'new/dir/b.txt' }), undefined, 'a new file under the project');
  assert.equal(check('write', { path: join(out, 'c.txt') }), undefined, 'another allowWrite entry');
  assert.match(check('write', { path: join(home, 'x') }) ?? '', /outside allowWrite/);
  assert.match(check('edit', { path: '.git/hooks/pre-commit' }) ?? '', /protected/);
  assert.match(check('write', { path: '.bashrc' }) ?? '', /protected/);
  assert.match(check('write', { path: 'secret.txt' }) ?? '', /denyWrite/);
  assert.match(check('write', { path: 'link/id' }) ?? '', /denyRead/);

  assert.match(check('grep', { pattern: 'x', path: home }) ?? '', /would search/, 'a search above a denied folder');
  assert.equal(check('grep', { pattern: 'x', path: proj }), undefined);
  assert.equal(check('find', { pattern: '*' }), undefined, 'no path means the project');
  assert.equal(check('ls', { path: home }), undefined, 'ls only lists names');
  assert.match(check('ls', { path: join(home, '.ssh') }) ?? '', /denyRead/);
  assert.equal(check('bash', { command: 'cat ~/.ssh/id' }), undefined, 'bash is left to srt');
});

test('checkCall reads tool paths the way pi does: ~, @, file://, Unicode spaces, and read\'s NFD variant', () => {
  const root = tmp();
  const home = join(root, 'home');
  const proj = join(root, 'proj');
  const nfdDir = join(home, 'déja'); // "déjà" as macOS stores it, decomposed
  for (const d of [join(home, '.ssh'), join(home, 'my secrets'), nfdDir, proj]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, '.ssh', 'id'), 'key');
  writeFileSync(join(nfdDir, 'x'), 'x');
  const rules: Rules = { denyRead: [join(home, '.ssh'), join(home, 'my secrets'), nfdDir], allowWrite: ['.'], denyWrite: [] };
  const before = process.env.HOME;
  process.env.HOME = home; // os.homedir() reads it, so ~ means the fixture's home
  try {
    const read = (path: string) => checkCall('read', { path }, proj, rules);
    assert.match(read('~/.ssh/id') ?? '', /denyRead/, '~ is the home folder, not a folder named ~');
    assert.match(read('@~/.ssh/id') ?? '', /denyRead/, 'a leading @ is dropped');
    assert.match(read(`file://${join(home, '.ssh', 'id')}`) ?? '', /denyRead/, 'a file:// URL');
    assert.match(read(join(home, 'my secrets', 'x')) ?? '', /denyRead/, 'a non-breaking space');
    assert.match(read(join(home, 'déja', 'x')) ?? '', /denyRead/, 'the NFD spelling read falls back to');
    assert.match(checkCall('write', { path: '~/x' }, proj, rules) ?? '', /outside allowWrite/);
  } finally {
    if (before === undefined) delete process.env.HOME;
    else process.env.HOME = before;
  }
});

test('loadSandbox names what is missing, and wraps commands once srt is found', () => {
  const dir = tmp();
  assert.throws(() => loadSandbox({ enabled: true, srt: 'srt', settings: 'none.json' }, dir, dir), /could not be read/);
  writeFileSync(join(dir, 'srt-settings.json'), JSON.stringify({ ...SETTINGS, filesystem: { ...SETTINGS.filesystem, denyRead: ['~/.ssh', '**/.env'] } }));
  assert.throws(() => loadSandbox({ enabled: true, srt: 'no-such-srt-command', settings: 'srt-settings.json' }, dir, dir), /was not found/);
  const srt = fakeSrt(dir);
  const box = loadSandbox({ enabled: true, srt, settings: 'srt-settings.json' }, dir, dir);
  assert.deepEqual(box.skipped, ['**/.env']);
  assert.deepEqual(box.rules.denyRead, ['~/.ssh']);
  assert.equal(box.wrap(`echo 'hi'`), `exec '${srt}' --settings '${join(dir, 'srt-settings.json')}' bash -c 'echo '\\''hi'\\'''`);
  assert.equal(execFileSync('sh', ['-c', box.wrap(`printf '%s' "it's"`)]).toString(), "it's");
});

test('shellCommand: unchanged when off, wrapped and scrubbed when on, refused when on but unusable', () => {
  withAgentDir(undefined, () => {
    const run = shellCommand('true');
    assert.equal(run.command, 'true');
    assert.equal(run.env, process.env);
  });
  withAgentDir({ sandbox: { enabled: true } }, () => {
    assert.throws(() => shellCommand('true'), /could not be read/);
  });
  withAgentDir({}, (dir) => {
    writeFileSync(join(dir, 'tacklebox.json'), JSON.stringify({ sandbox: { enabled: true, srt: fakeSrt(dir) } }));
    writeFileSync(join(dir, 'srt-settings.json'), JSON.stringify(SETTINGS));
    process.env.TACKLEBOX_TEST_TOKEN = 'x';
    try {
      const run = shellCommand('true');
      assert.match(run.command, /^exec '.*fake-srt' --settings /);
      assert.equal(run.env.TACKLEBOX_TEST_TOKEN, undefined);
      assert.equal(run.env.PATH, process.env.PATH);
    } finally {
      delete process.env.TACKLEBOX_TEST_TOKEN;
    }
  });
});

test('verify-done, the loop gates and jobs refuse to run when the sandbox is on but unusable', async () => {
  const cwd = tmp();
  // All three read the config when they start, so they start while the agent dir is set.
  const [tests, gate] = await withAgentDir({ sandbox: { enabled: true } }, (dir) => {
    assert.throws(() => new Jobs(join(dir, 'jobs')).start('echo should-not-run', cwd, () => {}), /sandbox is on/);
    return Promise.all([runTests('echo should-not-run', cwd, 10), runGate('echo should-not-run', cwd, 10_000)]);
  });
  assert.equal(tests.ok, false);
  assert.equal(tests.code, 126);
  assert.match(tests.tail, /sandbox is on/);
  assert.equal(gate.ok, false);
  assert.match(gate.output, /could not run it: sandbox is on/);
});

test('the extension stays out when off, guards file tools when on, and refuses everything when broken', () => {
  const load = () => {
    const handlers = new Map<string, (event: any, ctx?: any) => any>();
    const tools: string[] = [];
    sandbox({ on: (name: string, h: any) => void handlers.set(name, h), registerTool: (t: { name: string }) => void tools.push(t.name) } as never);
    return { handlers, tools };
  };
  withAgentDir(undefined, () => {
    const { handlers, tools } = load();
    assert.equal(handlers.size, 0);
    assert.deepEqual(tools, []);
  });
  withAgentDir({}, (dir) => {
    writeFileSync(join(dir, 'tacklebox.json'), JSON.stringify({ sandbox: { enabled: true, srt: fakeSrt(dir) } }));
    writeFileSync(join(dir, 'srt-settings.json'), JSON.stringify({ ...SETTINGS, filesystem: { ...SETTINGS.filesystem, denyRead: [dir] } }));
    const { handlers, tools } = load();
    assert.deepEqual(tools, ['bash']);
    const call = handlers.get('tool_call')!;
    assert.equal(call({ toolName: 'read', input: { path: join(dir, 'x') } })?.block, true);
    assert.equal(call({ toolName: 'bash', input: { command: 'ls' } }), undefined);
  });
  withAgentDir({ sandbox: { enabled: true } }, () => {
    const call = load().handlers.get('tool_call')!;
    for (const toolName of ['bash', 'read', 'write', 'job_start']) {
      const result = call({ toolName, input: {} });
      assert.equal(result?.block, true, toolName);
      assert.match(result.reason, /could not be read/);
    }
  });
});

// The real thing: needs srt on PATH and a place where it can start bubblewrap (not inside another sandbox).
const realSrt = spawnSync('sh', ['-c', 'command -v srt'], { encoding: 'utf8' }).stdout.trim();
test('with the real srt, a command gets no secrets and cannot write outside the project', { skip: !realSrt && 'srt is not installed' }, (t) => {
  const dir = tmp();
  const proj = join(dir, 'proj');
  mkdirSync(proj);
  writeFileSync(join(dir, 'srt-settings.json'), JSON.stringify(SETTINGS));
  const box = loadSandbox({ enabled: true, srt: realSrt, settings: 'srt-settings.json' }, dir, proj);
  if (spawnSync('sh', ['-c', box.wrap('true')], { cwd: proj }).status !== 0) return t.skip('srt cannot start a sandbox here');
  const outside = join(dir, 'outside.txt');
  const result = spawnSync('sh', ['-c', box.wrap(`echo "[$TACKLEBOX_TEST_TOKEN]"; touch ${shQuote(outside)} 2>/dev/null; touch inside.txt`)], {
    cwd: proj,
    env: box.env({ ...process.env, TACKLEBOX_TEST_TOKEN: 'leaked' }),
    encoding: 'utf8',
  });
  assert.match(result.stdout, /^\[\]$/m);
  assert.equal(existsSync(outside), false);
  assert.equal(existsSync(join(proj, 'inside.txt')), true);
});
