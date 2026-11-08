/**
 * /loop <task>: runs a workflow (the review loop by default) on the current directory in the background and posts
 * the report into the conversation when it ends. /loop config shows the settings, /loop workflows the workflows,
 * /loop status where it is, /loop stop stops it (its pi processes go with it); a subcommand is only recognized as
 * the whole argument, so a task can still start with one of those words. /loop-status and /loop-stop are aliases.
 *
 * /flow <description>: the conversation's model drafts a workflow and calls flow_run, which checks it and asks the
 * user to run, edit or cancel it; then code runs it like /loop. /flow save NAME keeps the last one that ran.
 *
 * Quitting pi stops a running loop too.
 */
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { parseArgs, USAGE } from './args.ts';
import { parseWorkflow, plannerPrompt, saveWorkflow } from './flow.ts';
import { type LoopEvent, type LoopReport, runLoop, workflows } from './loop.ts';
import { describeEvent, describeProgress } from './progress.ts';
import { type LoopConfig, loopConfig, loopEnabled } from './settings.ts';
import { describeConfig, describeWorkflows, SUBCOMMANDS, subcommandOf } from './show-config.ts';
import { BUILT_IN, type Workflow, describeWorkflow, runWorkflow, validateWorkflow } from './workflow.ts';

/** The command that started this pi, so steps run the same pi (as pi's subagent example does). */
function piCommand(): string[] {
  const script = process.argv[1];
  if (script && existsSync(script)) return [process.execPath, script];
  const exec = basename(process.execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(exec) ? ['pi'] : [process.execPath];
}

/** The conversation's model as a pi model pattern, for agent "main" in a workflow. */
export function mainModelOf(ctx: ExtensionContext): string | undefined {
  const m = ctx.model as { provider?: string; id?: string } | undefined;
  return m?.provider && m.id ? `${m.provider}/${m.id}` : undefined;
}

interface LoopState {
  controller: AbortController;
  log: string[];
  status: string;
  sessionDir?: string;
}

const NEEDS_MODELS =
  'Name the models first: "loop": { "implementer": { "model": ... }, "reviewer": { "model": ... } } in tacklebox.json (or --implementer / --reviewer).';

export default function (pi: ExtensionAPI) {
  // Off by default: it runs other models for many minutes and needs them named in tacklebox.json.
  if (!loopEnabled()) return;
  let running: LoopState | undefined;
  let ui: ExtensionContext | undefined;
  /** The last workflow /flow ran, for /flow save. */
  let lastFlow: Workflow | undefined;

  const show = () => {
    if (!ui?.hasUI || !running) return;
    ui.ui.setStatus('pi-loop', `loop: ${running.status}`);
    ui.ui.setWidget('pi-loop', running.log.slice(-6));
  };
  const clear = () => {
    if (!ui?.hasUI) return;
    ui.ui.setStatus('pi-loop', undefined);
    ui.ui.setWidget('pi-loop', undefined);
  };
  const say = (ctx: ExtensionContext, err: unknown) => ctx.ui.notify(err instanceof Error ? err.message : String(err), 'error');

  /** Starts a run in the background; its report comes back as a message when it ends. */
  const start = (ctx: ExtensionContext, run: (signal: AbortSignal, onEvent: (e: LoopEvent) => void) => Promise<LoopReport>) => {
    ui = ctx;
    const controller = new AbortController();
    const state: LoopState = { controller, log: [], status: 'starting' };
    running = state;
    show();
    const onEvent = (e: LoopEvent) => {
      if (e.kind === 'start') state.sessionDir = e.sessionDir;
      if (e.kind === 'step-progress') state.status = describeProgress(e);
      else {
        const line = describeEvent(e);
        if (line) state.log.push(line);
        if (e.kind === 'step-start') state.status = `step ${e.step.n}: ${e.step.label}`;
      }
      show();
    };
    run(controller.signal, onEvent)
      .then((report) => {
        pi.sendMessage({ customType: 'pi-loop', content: report.markdown, display: true, details: { reportFile: report.reportFile, outcome: report.outcome } });
      })
      .catch((err: unknown) => {
        pi.sendMessage({ customType: 'pi-loop', content: `pi-loop failed: ${err instanceof Error ? err.message : String(err)}`, display: true });
      })
      .finally(() => {
        if (running === state) running = undefined;
        clear();
      });
  };

  const status = (ctx: ExtensionContext) => {
    if (!running) return ctx.ui.notify('No loop is running.', 'info');
    ctx.ui.notify([`now: ${running.status}`, ...running.log.slice(-10), `sessions: ${running.sessionDir ?? '?'}`].join('\n'), 'info');
  };
  const stop = (ctx: ExtensionContext) => {
    if (!running) return ctx.ui.notify('No loop is running.', 'info');
    running.controller.abort();
    ctx.ui.notify('Stopping the loop…', 'warning');
  };
  const configOrSay = (ctx: ExtensionContext, overrides = {}): LoopConfig | undefined => {
    try {
      return loopConfig(overrides);
    } catch (err) {
      say(ctx, err);
      return undefined;
    }
  };

  pi.registerCommand('loop', {
    description: 'Run a workflow (the review loop by default) with limits on every step: /loop [--workflow NAME] [--rounds N] <task> | config | workflows | status | stop',
    getArgumentCompletions: (prefix) => {
      const p = prefix.trim().toLowerCase();
      const items = Object.entries(SUBCOMMANDS)
        .filter(([word]) => word.startsWith(p))
        .map(([word, description]) => ({ value: word, label: word, description }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      ui = ctx;
      const subcommand = subcommandOf(args);
      if (subcommand === 'status') return status(ctx);
      if (subcommand === 'stop') return stop(ctx);
      if (subcommand === 'config') {
        const config = configOrSay(ctx);
        return config && ctx.ui.notify(describeConfig(config), 'info');
      }
      if (subcommand === 'workflows') {
        const config = configOrSay(ctx);
        return config && ctx.ui.notify(describeWorkflows(workflows(config), config.workflow, Object.keys(BUILT_IN)), 'info');
      }
      if (running) return ctx.ui.notify('A loop is already running: /loop status, or /loop stop to stop it.', 'warning');
      let parsed: ReturnType<typeof parseArgs>;
      try {
        parsed = parseArgs(args);
      } catch (err) {
        return say(ctx, err);
      }
      const config = configOrSay(ctx, parsed.overrides);
      if (!config) return;
      if (!parsed.task) return ctx.ui.notify(USAGE, 'info');
      if (!config.implementer.model || !config.reviewer.model) return ctx.ui.notify(NEEDS_MODELS, 'error');
      const name = config.workflow;
      if (!workflows(config)[name]) return ctx.ui.notify(`No workflow named "${name}": /loop workflows lists them.`, 'error');
      ctx.ui.notify(`Loop started (${name}): implementer ${config.implementer.model}, reviewer ${config.reviewer.model}.`, 'info');
      start(ctx, (signal, onEvent) =>
        runLoop({ task: parsed.task, cwd: ctx.cwd, config, workflow: name, mainModel: mainModelOf(ctx), piCommand: piCommand(), signal, onEvent }));
    },
  });

  pi.registerCommand('flow', {
    description: 'Have this model draft a workflow for one run, approve it, and let code run it: /flow <what you want> | save NAME',
    handler: async (args, ctx) => {
      ui = ctx;
      const save = /^save\s+(\S+)\s*$/i.exec(args.trim());
      if (save) {
        if (!lastFlow) return ctx.ui.notify('No /flow workflow has run yet in this session.', 'warning');
        try {
          const file = saveWorkflow(save[1].toLowerCase(), lastFlow);
          return ctx.ui.notify(`Saved as "${save[1].toLowerCase()}" in ${file}: /loop --workflow ${save[1].toLowerCase()} <task> runs it.`, 'info');
        } catch (err) {
          return say(ctx, err);
        }
      }
      if (!args.trim()) return ctx.ui.notify('/flow <what you want done, by which models, in what order> | /flow save NAME', 'info');
      if (running) return ctx.ui.notify('A loop is already running: /loop status, or /loop stop to stop it.', 'warning');
      const config = configOrSay(ctx);
      if (!config) return;
      pi.sendUserMessage(plannerPrompt(args.trim(), config, mainModelOf(ctx)));
    },
  });

  pi.registerTool(
    defineTool({
      name: 'flow_run',
      label: 'Run workflow',
      description:
        'Only after the user typed /flow: check a drafted pi-loop workflow, show it to the user to run, edit or cancel, and ' +
        'start it in the background if they approve. Returns problems to fix if the workflow is invalid.',
      parameters: Type.Object({
        task: Type.String({ description: 'The job in plain words; workflow prompts use it as {task}' }),
        workflow: Type.String({ description: 'The workflow, as JSON: { "description": "...", "nodes": [...] }' }),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }], details: undefined });
        if (running) return text('A loop is already running; tell the user to wait for it or /loop stop it.');
        if (!ctx.hasUI) return text('flow_run needs a person to approve the workflow; it only runs in interactive pi.');
        let config: LoopConfig;
        try {
          config = loopConfig();
        } catch (err) {
          return text(`The loop settings have a problem: ${err instanceof Error ? err.message : String(err)}`);
        }
        const mainModel = mainModelOf(ctx);
        let { workflow, error } = parseWorkflow(params.workflow);
        for (;;) {
          const problems = error ? [error] : validateWorkflow(workflow, { mainModel: !!mainModel });
          if (problems.length) {
            return text(`The workflow has problems; fix them and call flow_run again:\n- ${problems.join('\n- ')}`);
          }
          const summary = describeWorkflow(workflow!, config, mainModel);
          const choice = await ctx.ui.select(`Run this workflow?\n\n${workflow!.description ?? ''}\n${summary}\n\nTask: ${params.task}`, ['Run', 'Edit', 'Cancel']);
          if (choice === 'Run') break;
          if (choice !== 'Edit') return text('The user cancelled the workflow. Ask what they want changed.');
          const edited = await ctx.ui.editor('Workflow JSON', JSON.stringify(workflow, null, 2));
          if (edited === undefined) return text('The user cancelled the workflow. Ask what they want changed.');
          ({ workflow, error } = parseWorkflow(edited));
          if (!error) {
            const again = validateWorkflow(workflow, { mainModel: !!mainModel });
            if (again.length) {
              ctx.ui.notify(`The edited workflow has problems:\n- ${again.join('\n- ')}`, 'error');
              ({ workflow, error } = parseWorkflow(params.workflow));
            }
          } else {
            ctx.ui.notify(error, 'error');
            ({ workflow, error } = parseWorkflow(params.workflow));
          }
        }
        lastFlow = workflow!;
        const wf = workflow!;
        start(ctx, (signal, onEvent) =>
          runWorkflow({ workflow: wf, name: 'flow', task: params.task, cwd: ctx.cwd, config, mainModel, piCommand: piCommand(), signal, onEvent }));
        return text('Started in the background. The report will appear in the conversation when it ends; /loop status shows progress. Don\'t poll it.');
      },
    }),
  );

  pi.registerCommand('loop-status', { description: 'Show the running loop (same as /loop status)', handler: async (_a, ctx) => status(ctx) });
  pi.registerCommand('loop-stop', { description: 'Stop the running loop (same as /loop stop)', handler: async (_a, ctx) => stop(ctx) });

  pi.on('session_shutdown', async () => {
    running?.controller.abort();
  });
}
