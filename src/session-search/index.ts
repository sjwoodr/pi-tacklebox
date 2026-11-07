/**
 * session-search: the session_search tool and /recall search past pi sessions for a regex. Only what
 * the user said and the commands that ran can be searched or shown, never tool output, thinking or
 * the model's replies, and `!!` commands stay private.
 *
 * Results go to the current model and can hold private work, so both refuse to run on a model that
 * isn't local, unless "sessionSearch": { "allowNonLocal": true } is set in tacklebox.json.
 */

import { join } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ExtensionAPI, type ExtensionContext, getAgentDir } from '@earendil-works/pi-coding-agent';
import { loadConfig } from '../config.ts';
import { DEFAULT_LIMIT, MAX_LIMIT, type Mode, render, search, sessionFiles } from './search.ts';

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Ollama's cloud models sit behind the same local address as its local ones, so the URL can't tell them
 * apart. Shortcut: this goes by the model's name, so a cloud model copied to a name without "cloud" passes.
 */
export function isLocal(model: { id: string; baseUrl: string } | undefined): boolean {
  if (!model || /cloud/i.test(model.id)) return false;
  try {
    return LOCAL_HOSTS.includes(new URL(model.baseUrl).hostname);
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  const { enabled, allowNonLocal } = loadConfig().sessionSearch;
  if (!enabled) return;
  const root = join(getAgentDir(), 'sessions');

  function run(regex: string, limit: number | undefined, mode: Mode, ctx: ExtensionContext): string {
    if (!allowNonLocal && !isLocal(ctx.model)) {
      throw new Error(
        `Session search is off for ${ctx.model?.id ?? 'this model'}: results can hold private work and it isn't a local model. ` +
          'Set sessionSearch.allowNonLocal in tacklebox.json to allow it.',
      );
    }
    if (!regex) throw new Error('Give a regex to search for.');
    let re: RegExp;
    try {
      re = new RegExp(regex, 'i');
    } catch (err) {
      throw new Error(`Invalid regex: ${err instanceof Error ? err.message : String(err)}`);
    }
    const current = ctx.sessionManager.getSessionFile();
    const files = sessionFiles(root).filter((file) => file !== current);
    const { hits, more } = search(files, re, Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT));
    return hits.length ? render(hits, mode, more) : `No past session matches /${regex}/.`;
  }

  pi.registerTool(
    defineTool({
      name: 'session_search',
      label: 'Session search',
      description:
        'Search past pi sessions for a case-insensitive regex, newest first. Searches what the user said and the commands ' +
        'that ran. "files" mode lists matching sessions; "details" mode adds the matching lines.',
      promptSnippet: 'session_search: find past pi sessions by what was said or run',
      promptGuidelines: ['Use session_search in "files" mode first, and "details" mode only for the sessions that matter.'],
      parameters: Type.Object({
        regex: Type.String({ description: 'The regex to search for' }),
        limit: Type.Optional(Type.Integer({ description: `Most sessions to return, default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}` })),
        mode: Type.Optional(Type.Union([Type.Literal('files'), Type.Literal('details')], { description: 'Default "files"' })),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const text = run(params.regex, params.limit, params.mode ?? 'files', ctx);
        return { content: [{ type: 'text', text }], details: {} };
      },
    }),
  );

  pi.registerCommand('recall', {
    description: 'Search past pi sessions: /recall <regex>',
    handler: async (args, ctx) => {
      try {
        ctx.ui.notify(run(args.trim(), undefined, 'files', ctx), 'info');
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), 'error');
      }
    },
  });
}
