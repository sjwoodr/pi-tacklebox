/**
 * /loop <task>: runs the implement → review → fix loop on the current directory in the background and
 * posts the report into the conversation when it ends. /loop config shows the settings, /loop status
 * where it is, /loop stop stops it (its pi processes go with it); a subcommand is only recognized as the
 * whole argument, so a task can still start with one of those words. /loop-status and /loop-stop are
 * aliases. Quitting pi stops a running loop too.
 */
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { parseArgs, USAGE } from './args.ts';
import { loopConfig, loopEnabled } from './settings.ts';
import { type LoopEvent, type LoopReport, runLoop } from './loop.ts';
import { describeEvent, describeProgress } from './progress.ts';
import { describeConfig, SUBCOMMANDS, subcommandOf } from './show-config.ts';

/** The command that started this pi, so steps run the same pi (as pi's subagent example does). */
function piCommand(): string[] {
  const script = process.argv[1];
  if (script && existsSync(script)) return [process.execPath, script];
  const exec = basename(process.execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(exec) ? ['pi'] : [process.execPath];
}

interface LoopState {
  controller: AbortController;
  log: string[];
  status: string;
  sessionDir?: string;
}

export default function (pi: ExtensionAPI) {
  // Off by default: it runs other models for many minutes and needs them named in tacklebox.json.
  if (!loopEnabled()) return;
  let running: LoopState | undefined;
  let ui: ExtensionContext | undefined;

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

  const status = (ctx: ExtensionContext) => {
    if (!running) return ctx.ui.notify('No loop is running.', 'info');
    ctx.ui.notify([`now: ${running.status}`, ...running.log.slice(-10), `sessions: ${running.sessionDir ?? '?'}`].join('\n'), 'info');
  };
  const stop = (ctx: ExtensionContext) => {
    if (!running) return ctx.ui.notify('No loop is running.', 'info');
    running.controller.abort();
    ctx.ui.notify('Stopping the loop…', 'warning');
  };
  const showConfig = (ctx: ExtensionContext) => {
    try {
      ctx.ui.notify(describeConfig(loopConfig()), 'info');
    } catch (err) {
      ctx.ui.notify(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  pi.registerCommand('loop', {
    description: 'Implement → review → fix with turn and time limits: /loop [--rounds N] [--minutes N] <task> | config | status | stop',
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
      if (subcommand === 'config') return showConfig(ctx);
      if (subcommand === 'status') return status(ctx);
      if (subcommand === 'stop') return stop(ctx);
      if (running) {
        ctx.ui.notify('A loop is already running: /loop status, or /loop stop to stop it.', 'warning');
        return;
      }
      let parsed: ReturnType<typeof parseArgs>;
      let config: ReturnType<typeof loopConfig>;
      try {
        parsed = parseArgs(args);
        config = loopConfig(parsed.overrides);
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), 'error');
        return;
      }
      if (!parsed.task) {
        ctx.ui.notify(USAGE, 'info');
        return;
      }
      if (!config.implementer.model || !config.reviewer.model) {
        ctx.ui.notify('Name the models first: "loop": { "implementer": { "model": ... }, "reviewer": { "model": ... } } in tacklebox.json (or --implementer / --reviewer).', 'error');
        return;
      }
      const controller = new AbortController();
      const state: LoopState = { controller, log: [], status: 'starting' };
      running = state;
      ctx.ui.notify(`Loop started: implementer ${config.implementer.model}, reviewer ${config.reviewer.model}, up to ${config.maxRounds} rounds.`, 'info');
      show();

      const onEvent = (e: LoopEvent) => {
        if (e.kind === 'start') state.sessionDir = e.sessionDir;
        if (e.kind === 'step-progress') {
          state.status = describeProgress(e);
        } else {
          const line = describeEvent(e);
          if (line) state.log.push(line);
          if (e.kind === 'step-start') state.status = `#${e.step.n} ${e.step.role} ${e.step.kind}`;
        }
        show();
      };

      runLoop({ task: parsed.task, cwd: ctx.cwd, config, piCommand: piCommand(), signal: controller.signal, onEvent })
        .then((report: LoopReport) => {
          pi.sendMessage({ customType: 'pi-loop', content: report.markdown, display: true, details: { reportFile: report.reportFile, outcome: report.outcome } });
        })
        .catch((err: unknown) => {
          pi.sendMessage({ customType: 'pi-loop', content: `pi-loop failed: ${err instanceof Error ? err.message : String(err)}`, display: true });
        })
        .finally(() => {
          if (running === state) running = undefined;
          clear();
        });
    },
  });

  pi.registerCommand('loop-status', { description: 'Show the running loop (same as /loop status)', handler: async (_a, ctx) => status(ctx) });
  pi.registerCommand('loop-stop', { description: 'Stop the running loop (same as /loop stop)', handler: async (_a, ctx) => stop(ctx) });

  pi.on('session_shutdown', async () => {
    running?.controller.abort();
  });
}
