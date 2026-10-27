/**
 * search: web_search and web_fetch tools, with no approval step: the model uses them whenever it
 * decides to. Two backends, chosen in tacklebox.json:
 *
 *   "search": { "backend": "searxng" }   a SearXNG instance (searxngUrl, default 127.0.0.1:8888,
 *                                        JSON format enabled); pages are fetched from this machine
 *   "search": { "backend": "ollama" }    Ollama's web search through the local Ollama (ollamaUrl);
 *                                        needs `ollama signin`, and queries go to ollama.com
 *
 * Off by default, since it sends queries off the machine. Both backends share the guidance, the
 * result wording and the caps (guidance.ts), so a model sees the same tools on either.
 */

import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadConfig } from '../config.ts';
import { type Backend, ollama, searxng } from './backends.ts';
import { clip, fetchFailed, guidelines, isWebUrl, noResults, pageText, type Result, resultsText, searchFailed } from './guidance.ts';

type SearchDetails = { query: string; results?: Result[]; error?: string };
type FetchDetails = { url: string; title?: string; chars?: number; cut?: boolean; error?: string };

export default function (pi: ExtensionAPI) {
  const { backend, searxngUrl, ollamaUrl } = loadConfig().search;
  if (backend === 'off') return;
  registerSearch(pi, backend === 'searxng' ? searxng(searxngUrl) : ollama(ollamaUrl));
}

export function registerSearch(pi: Pick<ExtensionAPI, 'registerTool'>, backend: Backend, now = new Date()) {
  pi.registerTool(
    defineTool({
      name: 'web_search',
      label: 'Web search',
      description: `Search the web (via ${backend.via}) for current information. Returns titles, URLs and snippets.`,
      promptSnippet: 'web_search: look up current or uncertain facts on the web',
      promptGuidelines: guidelines(now),
      parameters: Type.Object({
        query: Type.String({ description: "The search query, written from today's date" }),
      }),

      async execute(_toolCallId, params, signal) {
        const query = clip(params.query, 200);
        try {
          const results = await backend.search(query, signal);
          const text = results.length ? resultsText(query, results) : noResults(query);
          return { content: [{ type: 'text', text }], details: { query, results } as SearchDetails };
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          return { content: [{ type: 'text', text: searchFailed(why) }], details: { query, error: why } as SearchDetails };
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: 'web_fetch',
      label: 'Web fetch',
      description: 'Read a web page (a search result or a URL the user gives) as plain text. Public http(s) pages only.',
      promptSnippet: "web_fetch: read a web page's text, when search snippets aren't enough",
      parameters: Type.Object({
        url: Type.String({ description: 'The full http(s) URL of the page' }),
      }),

      async execute(_toolCallId, params, signal) {
        const fail = (why: string) => ({
          content: [{ type: 'text' as const, text: fetchFailed(params.url, why) }],
          details: { url: params.url, error: why } as FetchDetails,
        });
        if (!isWebUrl(params.url)) return fail('not an http(s) URL');
        try {
          const page = await backend.fetch(params.url, signal);
          const { text, cut } = pageText(page);
          return { content: [{ type: 'text', text }], details: { url: page.url, title: page.title, chars: page.text.length, cut } as FetchDetails };
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    }),
  );
}
