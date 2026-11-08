import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '../config.ts';
import { CONFIG, defaults, type LoopConfig } from './settings.ts';

/** The words `/loop` treats as subcommands, but only when the word is the whole argument. */
export const SUBCOMMANDS = {
  config: 'show the settings the next loop will use',
  status: 'show the running loop',
  stop: 'stop the running loop and its pi processes',
} as const;
export type Subcommand = keyof typeof SUBCOMMANDS;

export function subcommandOf(args: string): Subcommand | undefined {
  const word = args.trim().toLowerCase();
  return word in SUBCOMMANDS ? (word as Subcommand) : undefined;
}

/** The effective settings, marking the ones pi-loop.json changed from the defaults. */
export function describeConfig(config: LoopConfig, file = join(getAgentDir(), CONFIG)): string {
  const d = defaults();
  const mark = (changed: boolean) => (changed ? '  (set in file)' : '');
  const model = (m: string) => m || '(not set: name it in tacklebox.json)';
  const role = (name: 'implementer' | 'reviewer') => {
    const c = config[name];
    const base = d[name];
    return [
      `${name}: ${model(c.model)}${mark(c.model !== base.model)}`,
      `  limits: ${c.maxTurns} turns, ${c.maxMinutes} min per step${mark(c.maxTurns !== base.maxTurns || c.maxMinutes !== base.maxMinutes)}`,
      `  tools: ${c.tools.length ? c.tools.join(', ') : "pi's defaults"}${mark(c.tools.join() !== base.tools.join())}`,
    ];
  };
  return [
    `loop settings (the "loop" section of ${existsSync(file) ? file : `${file}, not found: defaults`})`,
    ...role('implementer'),
    ...role('reviewer'),
    `rounds: up to ${config.maxRounds}${mark(config.maxRounds !== d.maxRounds)}`,
    `total time: ${config.maxTotalMinutes} min${mark(config.maxTotalMinutes !== d.maxTotalMinutes)}`,
    `near a limit: warned 3 turns or 2 min before; at the limit: aborted, then asked once for the report (${config.wrapUpMinutes} min, same process)${mark(config.wrapUpMinutes !== d.wrapUpMinutes)}`,
    `checks: ${config.gates.length ? config.gates.join(' && ') : 'none'}${mark(config.gates.join() !== d.gates.join())}`,
    `  ${config.gateTimeoutMinutes} min timeout, ${config.gateRetries} retr${config.gateRetries === 1 ? 'y' : 'ies'} back to the implementer`,
    `startup watchdog: ${config.startupSeconds} s, then one retry (steps run with PI_OFFLINE=1)${mark(config.startupSeconds !== d.startupSeconds)}`,
    `sessions and reports: ${config.sessionsRoot}/<run>/`,
    `One run can override: /loop --rounds N --minutes N --implementer M --reviewer M --no-gates <task>`,
  ].join('\n');
}
