/**
 * The loop's settings: the "loop" section of tacklebox.json (see ../config.ts for the defaults), with one
 * run's /loop options on top, and where its sessions go.
 */
import { join } from 'node:path';
import { CONFIG, DEFAULTS, getAgentDir, type LoopRole, type LoopSettings, loadConfig } from '../config.ts';
import { validateWorkflow } from './workflow.ts';

export interface StepLimits {
  maxTurns: number;
  maxMinutes: number;
}

export type RoleConfig = LoopRole;

export interface LoopConfig extends Omit<LoopSettings, 'enabled'> {
  /** Each run's sessions and report.md go in <sessionsRoot>/<run id>/. */
  sessionsRoot: string;
}

export { CONFIG };

/** The built-in defaults, as a LoopConfig. */
export function defaults(dir = getAgentDir()): LoopConfig {
  const { enabled: _, ...rest } = structuredClone(DEFAULTS.loop);
  return { ...rest, sessionsRoot: join(dir, 'sessions', 'loop') };
}

/** tacklebox.json's loop section, then this run's options. Unknown options, wrong types and broken workflows are errors. */
export function loopConfig(overrides: Partial<LoopConfig> = {}, dir = getAgentDir()): LoopConfig {
  const { enabled: _, ...rest } = loadConfig(dir).loop;
  const config = merge({ ...rest, sessionsRoot: join(dir, 'sessions', 'loop') }, overrides as Record<string, unknown>, 'options');
  for (const [name, w] of Object.entries(config.workflows)) {
    const errors = validateWorkflow(w, { mainModel: true });
    if (errors.length) throw new Error(`${CONFIG}: loop.workflows.${name}: ${errors.join('; ')}`);
  }
  return config;
}

export function loopEnabled(dir = getAgentDir()): boolean {
  return loadConfig(dir).loop.enabled;
}

function merge(base: LoopConfig, given: Record<string, unknown>, where: string): LoopConfig {
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(given)) {
    if (value === undefined) continue;
    if (!(key in out)) throw new Error(`${where}: unknown setting "${key}"`);
    if (key === 'implementer' || key === 'reviewer') {
      const role = out[key];
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (!(k in role)) throw new Error(`${where}: unknown setting "${key}.${k}"`);
        (role as unknown as Record<string, unknown>)[k] = v;
      }
      continue;
    }
    (out as unknown as Record<string, unknown>)[key] = value;
  }
  return out;
}
