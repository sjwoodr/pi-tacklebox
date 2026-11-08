/**
 * The review loop: the built-in "review-loop" workflow (see workflow.ts), or a named one from tacklebox.json.
 * Code decides every step; no model is asked what happened.
 */
import type { LoopConfig } from './settings.ts';
import type { LoopEvent, LoopReport } from './report.ts';
import { BUILT_IN, type Workflow, runWorkflow } from './workflow.ts';

export type { LoopEvent, LoopReport, Outcome, Role, StepRecord } from './report.ts';
export { renderReport, shortModel, speedsOf } from './report.ts';

export interface LoopOptions {
  task: string;
  cwd: string;
  config: LoopConfig;
  /** A workflow name (built-in or from tacklebox.json); default config.workflow. */
  workflow?: string;
  /** The model behind agent "main". */
  mainModel?: string;
  piCommand?: string[];
  signal?: AbortSignal;
  onEvent?: (e: LoopEvent) => void;
  /** Overrides the generated run id (tests). */
  runId?: string;
}

/** Every workflow this config can run by name: the built-ins, with tacklebox.json's on top. */
export function workflows(config: LoopConfig): Record<string, Workflow> {
  return { ...BUILT_IN, ...(config.workflows as Record<string, Workflow>) };
}

export async function runLoop(o: LoopOptions): Promise<LoopReport> {
  const name = o.workflow ?? o.config.workflow;
  const workflow = workflows(o.config)[name];
  if (!workflow) throw new Error(`no workflow named "${name}" (have: ${Object.keys(workflows(o.config)).join(', ')})`);
  return runWorkflow({ ...o, workflow, name });
}
