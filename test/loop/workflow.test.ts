import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runLoop } from '../../src/loop/loop.ts';
import { runWorkflow, validateWorkflow, type Workflow } from '../../src/loop/workflow.ts';
import { FAKE_PI, fakePi, gitRepo, testConfig } from './helpers.ts';

const log = (file: string) => readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('validation names each problem', () => {
  const errs = (w: unknown, main = false) => validateWorkflow(w, { mainModel: main }).join(' | ');
  assert.match(errs({ nodes: [] }), /non-empty "nodes"/);
  assert.match(errs({ nodes: [{ id: 'a', agent: 'wizard', prompt: 'x' }] }), /agent "wizard" is not a role/);
  assert.match(errs({ nodes: [{ id: 'a', agent: 'implementer', prompt: 'x', after: ['b'] }, { id: 'b', agent: 'implementer', prompt: 'y' }] }), /after "b", which isn't an earlier node/);
  assert.match(errs({ nodes: [{ id: 'a', agent: 'implementer', prompt: 'x' }, { id: 'a', agent: 'implementer', prompt: 'y' }] }), /duplicate id "a"/);
  assert.match(errs({ nodes: [{ id: 'a', agent: 'implementer', prompt: 'use {zz}' }] }), /no agent node "zz"/);
  assert.match(errs({ nodes: [{ id: 'a', agent: 'implementer', prompt: 'x' }, { id: 'b', agent: 'implementer', prompt: '{a.patch}' }] }), /needs "a" to have "workspace": "own"/);
  assert.match(errs({ nodes: [{ id: 'r', until: 'clean', repeat: [{ id: 'a', agent: 'implementer', prompt: 'x' }] }] }), /needs a step with a verdict/);
  assert.match(errs({ nodes: [{ id: 'a', agent: 'main', prompt: 'x' }] }), /"main" needs a main model/);
  assert.equal(errs({ nodes: [{ id: 'a', agent: 'main', prompt: 'x' }] }, true), '');
  assert.match(errs({ nodes: [{ id: 'a', checks: 'gates', onFail: { fix: 'nope' } }] }), /onFail.fix "nope" is not an agent node/);
});

test('nodes with no dependency between them run at the same time; a later node gets both outputs', async () => {
  const { dir, log: file } = fakePi({ implementer: { turns: 3, delayMs: 60, echoPrompt: true } });
  const wf: Workflow = { nodes: [
    { id: 'a', agent: 'implementer', prompt: 'do A' },
    { id: 'b', agent: 'ollama/other:model', prompt: 'do B', after: [] },
    { id: 'z', agent: 'implementer', prompt: 'combine [{a}] [{b}]', after: ['a', 'b'] },
  ] };
  const r = await runWorkflow({ workflow: wf, name: 'test', task: 't', cwd: gitRepo(), config: testConfig(join(dir, 'runs'), { gates: [] }), piCommand: FAKE_PI });
  assert.equal(r.outcome, 'finished');
  // Each pi process logs its pid; find a, b and z by what they were asked, not by the order they started.
  const entries = log(file);
  const pidOf = (prompt: string) => entries.find((e) => e.cmd === 'prompt' && e.message.startsWith(prompt))!.pid;
  const at = (pid: number, cmd: string) => entries.find((e) => e.pid === pid && e.cmd === cmd)!;
  const [a, b, z] = [pidOf('do A'), pidOf('do B'), pidOf('combine')];
  assert.equal(entries.filter((e) => e.cmd === 'start').length, 3);
  assert.ok(at(b, 'start').ts < at(a, 'exit').ts && at(a, 'start').ts < at(b, 'exit').ts, 'a and b overlapped');
  assert.ok(at(b, 'start').args.includes('ollama/other:model'), 'a model pattern is used as given');
  assert.equal(entries.find((e) => e.pid === z && e.cmd === 'prompt').message, 'combine [OUT:do A] [OUT:do B]');
  assert.ok(at(z, 'start').ts >= Math.max(at(a, 'exit').ts, at(b, 'exit').ts), 'z waited for both');
});

test('an own workspace keeps the repo untouched and leaves a patch the next step can use', async () => {
  const { dir, log: file } = fakePi({ implementer: { turns: 1, writeFile: 'idea.txt', echoPrompt: true } });
  const repo = gitRepo();
  const wf: Workflow = { nodes: [
    { id: 'try', agent: 'implementer', prompt: 'try it', workspace: 'own' },
    { id: 'judge', agent: 'reviewer', role: 'helper', verdict: false, workspace: 'copy', prompt: 'look at {try.patch}' },
  ] };
  const r = await runWorkflow({ workflow: wf, name: 'test', task: 't', cwd: repo, config: testConfig(join(dir, 'runs'), { gates: [] }), piCommand: FAKE_PI });
  assert.ok(!existsSync(join(repo, 'idea.txt')), 'the repo is untouched');
  const patch = r.steps.find((s) => s.id === 'try')!.patchFile!;
  assert.match(readFileSync(patch, 'utf8'), /idea\.txt/);
  const judgePrompt = log(file).filter((e) => e.cmd === 'prompt').map((e) => e.message).find((m) => m.startsWith('look at'));
  assert.equal(judgePrompt, `look at ${patch}`);
});

test('checks with their own commands; a failure goes to the named step', async () => {
  const { dir } = fakePi({ implementer: { turns: 1, writeFile: 'w.txt' } });
  const wf: Workflow = { nodes: [
    { id: 'build', agent: 'implementer', prompt: 'build' },
    { id: 'verify', checks: ['test "$(wc -l < w.txt)" -ge 2'], onFail: { fix: 'build', times: 2 } },
  ] };
  const r = await runWorkflow({ workflow: wf, name: 'test', task: 't', cwd: gitRepo(), config: testConfig(join(dir, 'runs'), { gates: [] }), piCommand: FAKE_PI });
  assert.deepEqual(r.steps.map((s) => s.label), ['build', 'fix failed checks']);
  assert.equal(r.steps[1].gates?.[0].ok, true);
});

test('"main" runs on the conversation model', async () => {
  const { dir, log: file } = fakePi({ implementer: { turns: 1 } });
  const wf: Workflow = { nodes: [{ id: 'm', agent: 'main', prompt: 'hi' }] };
  await runWorkflow({ workflow: wf, name: 'test', task: 't', cwd: gitRepo(), config: testConfig(join(dir, 'runs'), { gates: [] }), piCommand: FAKE_PI, mainModel: 'ollama/gemma4:latest' });
  assert.ok(log(file).find((e) => e.cmd === 'start').args.includes('ollama/gemma4:latest'));
});

test('the built-in review workflow reviews and reports the verdict', async () => {
  const { dir } = fakePi({ reviewer: { turns: 1, texts: ['[high] bug\nVERDICT: CHANGES'] } });
  const r = await runLoop({ task: 't', cwd: gitRepo(), workflow: 'review', config: testConfig(join(dir, 'runs'), { gates: [] }), piCommand: FAKE_PI });
  assert.equal(r.outcome, 'finished');
  assert.match(r.detail, /CHANGES \(0 critical, 1 high/);
  assert.deepEqual(r.steps.map((s) => s.label), ['review']);
});

test('a workflow named in tacklebox.json runs by name, and a broken one is refused when loaded', async () => {
  const { loopConfig } = await import('../../src/loop/settings.ts');
  const { dir } = fakePi({ implementer: { turns: 1 } });
  writeFileSync(join(dir, 'tacklebox.json'), JSON.stringify({ loop: { workflows: { quick: { nodes: [{ id: 'only', agent: 'implementer', prompt: '{task}' }] } } } }));
  const cfg = { ...loopConfig({}, dir), ...testConfig(join(dir, 'runs'), { gates: [] }), workflows: loopConfig({}, dir).workflows };
  const r = await runLoop({ task: 't', cwd: gitRepo(), workflow: 'quick', config: cfg, piCommand: FAKE_PI });
  assert.equal(r.workflow, 'quick');
  assert.deepEqual(r.steps.map((s) => s.label), ['only']);
  writeFileSync(join(dir, 'tacklebox.json'), JSON.stringify({ loop: { workflows: { broken: { nodes: [{ id: 'x', agent: 'nobody', prompt: 'p' }] } } } }));
  assert.throws(() => loopConfig({}, dir), /loop\.workflows\.broken: .*agent "nobody"/);
  await assert.rejects(runLoop({ task: 't', cwd: gitRepo(), workflow: 'missing', config: cfg, piCommand: FAKE_PI }), /no workflow named "missing"/);
});

test('a stop in one branch keeps later nodes from starting', async () => {
  const { dir, log: file } = fakePi({ reviewer: { turns: 1, texts: ['no verdict here'] }, implementer: { turns: 1 }, wrapUp: { text: 'still none' } });
  const wf: Workflow = { nodes: [
    { id: 'rev', agent: 'reviewer', prompt: 'review' },
    { id: 'after-rev', agent: 'implementer', prompt: 'never' },
  ] };
  const r = await runWorkflow({ workflow: wf, name: 'test', task: 't', cwd: gitRepo(), config: testConfig(join(dir, 'runs'), { gates: [] }), piCommand: FAKE_PI });
  assert.equal(r.outcome, 'no verdict');
  assert.ok(!log(file).some((e) => e.cmd === 'prompt' && e.message === 'never'));
});
