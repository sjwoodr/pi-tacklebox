#!/usr/bin/env node
/**
 * pi-loop from a shell: `pi-loop [options] <task>` or `pi-loop [options] --task-file task.md`, run in
 * the repository to work on. Progress goes to stderr, the report to stdout; exit 0 only when the
 * reviewer passed the work and the final checks passed.
 */
import { readFileSync } from 'node:fs';
import { parseArgs, USAGE } from './args.ts';
import { loopConfig } from './settings.ts';
import { runLoop } from './loop.ts';
import { describeEvent } from './progress.ts';

let argv = process.argv.slice(2).join(' ');
let taskFile: string | undefined;
const tf = /(?:^|\s)--task-file\s+(\S+)/.exec(argv);
if (tf) {
  taskFile = tf[1];
  argv = argv.replace(tf[0], ' ');
}
if (/(^|\s)(-h|--help)(\s|$)/.test(argv)) {
  console.log(USAGE.replace('/loop', 'pi-loop') + '\n  --task-file F       read the task from a file');
  process.exit(0);
}
const { overrides, task: inline } = parseArgs(argv);
const task = taskFile ? readFileSync(taskFile, 'utf8').trim() : inline;
const config = loopConfig(overrides);
if (!config.implementer.model || !config.reviewer.model) {
  console.error('pi-loop: name the models in tacklebox.json ("loop": { "implementer": { "model": ... }, "reviewer": ... }) or with --implementer / --reviewer');
  process.exit(2);
}
if (!task) {
  console.error('pi-loop: no task given\n' + USAGE.replace('/loop', 'pi-loop'));
  process.exit(2);
}

const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
const report = await runLoop({
  task,
  cwd: process.cwd(),
  config,
  signal: controller.signal,
  onEvent: (e) => {
    const line = describeEvent(e);
    if (line) console.error(line);
  },
});
console.log(report.markdown);
process.exit(report.outcome === 'passed' && report.finalGates.every((g) => g.ok) ? 0 : 1);
