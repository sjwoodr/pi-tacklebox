import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runLoop } from '../../src/loop/loop.ts';
import { checkModels, runWorkflow, validateWorkflow, type Workflow } from '../../src/loop/workflow.ts';
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
  assert.match(errs({ nodes: [{ id: 'r', until: 'clean', repeat: [{ id: 'a', agent: 'implementer', prompt: 'x' }] }] }), /needs a step with a verdict: give the checking step "verdict": true/);
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

test('a step whose pi exits before its first turn stops the run as an error, with pi\'s message', async () => {
  const { dir, log: file } = fakePi({ implementer: { turns: 1, failStart: 'Error: Model "gpt-oss/gpt-oss:120b-cloud" not found.' } });
  const wf: Workflow = { nodes: [
    { id: 'story', agent: 'implementer', prompt: 'write it', workspace: 'copy' },
    { id: 'correct', agent: 'reviewer', role: 'helper', verdict: false, workspace: 'copy', prompt: 'correct {story}' },
  ] };
  const r = await runWorkflow({ workflow: wf, name: 'test', task: 't', cwd: gitRepo(), config: testConfig(join(dir, 'runs')), piCommand: FAKE_PI });
  assert.equal(r.outcome, 'error');
  assert.match(r.detail, /story didn't run: Error: Model "gpt-oss\/gpt-oss:120b-cloud" not found/);
  assert.match(r.steps[0].error!, /not found/);
  assert.deepEqual(r.steps.map((s) => s.id), ['story'], 'the next step never starts with an empty {story}');
  assert.ok(!log(file).some((e) => e.cmd === 'prompt' && e.message.startsWith('correct')));
  assert.match(r.markdown, /FAILED: Error: Model/);
});

test('an own patch holds only what the step changed, not the repo\'s uncommitted work or the node_modules link', async () => {
  const { dir } = fakePi({ implementer: { turns: 1, writeFile: 'idea.txt' }, reviewer: { turns: 1 } });
  const repo = gitRepo();
  writeFileSync(join(repo, 'a.txt'), 'one\nwork in progress\n');
  writeFileSync(join(repo, 'untracked.txt'), 'mine\n');
  mkdirSync(join(repo, 'node_modules'));
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  const wf: Workflow = { nodes: [
    { id: 'try', agent: 'implementer', prompt: 'try it', workspace: 'own' },
    { id: 'idle', agent: 'reviewer', verdict: false, prompt: 'just answer', workspace: 'own', after: [] },
  ] };
  const r = await runWorkflow({ workflow: wf, name: 'test', task: 't', cwd: repo, config: testConfig(join(dir, 'runs')), piCommand: FAKE_PI });
  const patch = readFileSync(r.steps.find((s) => s.id === 'try')!.patchFile!, 'utf8');
  assert.match(patch, /idea\.txt/);
  assert.doesNotMatch(patch, /b\/a\.txt|untracked\.txt|node_modules|gitignore/);
  const idle = r.steps.find((s) => s.id === 'idle')!;
  assert.equal(idle.patchFile, undefined);
  assert.equal(idle.noChanges, true);
  assert.match(r.markdown, /no file changes/);
});

test('the report shows the last step\'s answer and the models that ran; every answer is saved; checks skip when no step used the repo', async () => {
  // Both steps run as the fake's "implementer" (a helper isn't told it reviews): one text per call, in order.
  const { dir } = fakePi({ implementer: { turns: 1, texts: ['Il était une fois un fromage.', 'Il était une fois un fromage, corrigé.'] } });
  const wf: Workflow = { nodes: [
    { id: 'story', agent: 'implementer', prompt: 'write', workspace: 'copy' },
    { id: 'correct', agent: 'reviewer', role: 'helper', verdict: false, prompt: 'correct {story}', workspace: 'copy' },
  ] };
  const r = await runWorkflow({ workflow: wf, name: 'flow', task: 't', cwd: gitRepo(), config: testConfig(join(dir, 'runs'), { gates: ['false'] }), piCommand: FAKE_PI });
  assert.equal(r.outcome, 'finished');
  assert.match(r.markdown, /## Output: correct \(rev\)\n\nIl était une fois un fromage, corrigé\./);
  assert.match(r.markdown, /Models: `fake\/impl`, `fake\/rev`\./);
  assert.equal(readFileSync(r.steps[0].outputFile!, 'utf8'), 'Il était une fois un fromage.\n');
  assert.deepEqual(r.finalGates, [], 'gates: ["false"] would have failed if run');
  assert.match(r.markdown, /not run \(no step worked in the repo\)/);
});

test('model names must match one pi model exactly; near misses get suggestions', () => {
  const known = [
    { provider: 'ollama', id: 'gpt-oss:120b-cloud' },
    { provider: 'ollama', id: 'gpt-oss:20b' },
    { provider: 'mac-lmstudio', id: 'qwen/qwen3.8-27b' },
    { provider: 'ollama', id: 'gemma4:latest' },
    { provider: 'other', id: 'gemma4:latest' },
  ];
  const cfg = testConfig('/tmp', { implementer: { model: 'ollama/gpt-oss:120b-cloud:low', tools: [], maxTurns: 1, maxMinutes: 1 }, reviewer: { model: 'qwen/qwen3.8-27b:off', tools: [], maxTurns: 1, maxMinutes: 1 } });
  const errs = (agents: string[], main?: string) =>
    checkModels({ nodes: agents.map((agent, i) => ({ id: `s${i}`, agent, prompt: 'x', after: [] })) }, cfg, main, known);
  assert.deepEqual(errs(['implementer', 'reviewer', 'mac-lmstudio/qwen/qwen3.8-27b:high', 'gpt-oss:20b']), [], 'exact names, bare unique ids and thinking levels pass');
  const [bad] = errs(['gpt-oss/gpt-oss:120b-cloud']);
  assert.match(bad, /"s0": pi has no model "gpt-oss\/gpt-oss:120b-cloud"; did you mean ollama\/gpt-oss:120b-cloud, ollama\/gpt-oss:20b\?/);
  assert.match(errs(['gpt-oss'])[0], /no model "gpt-oss"/, 'a partial name pi would resolve on its own is refused');
  assert.match(errs(['gemma4:latest'])[0], /more than one provider; name one: ollama\/gemma4:latest, other\/gemma4:latest/);
  assert.deepEqual(errs(['main']), [], 'no main model: validation reports that, not this');
  assert.match(errs(['main'], 'nope/x')[0], /main: pi has no model "nope\/x"/);
  const unset = testConfig('/tmp', { implementer: { model: '', tools: [], maxTurns: 1, maxMinutes: 1 } });
  assert.match(checkModels({ nodes: [{ id: 'a', agent: 'implementer', prompt: 'x' }] }, unset, undefined, known)[0], /implementer: no model set \(loop\.implementer\.model in tacklebox\.json\)/);
});
