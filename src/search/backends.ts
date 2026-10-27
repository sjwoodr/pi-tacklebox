import { fetchPage } from './local-fetch.ts';
import { clip, isWebUrl, MAX_TITLE, type Page, type Result, withTimeout } from './guidance.ts';

const TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 20_000;
const OLLAMA_TIMEOUT_MS = 20_000;

/** Where web_search and web_fetch go. Errors are thrown with the reason the model is told. */
export interface Backend {
  /** Fills in the tool descriptions: "Search the web (via ...)". */
  via: string;
  search(query: string, signal: AbortSignal | undefined): Promise<Result[]>;
  fetch(url: string, signal: AbortSignal | undefined): Promise<Page>;
}

/** A SearXNG instance with the JSON format enabled; pages are fetched from this machine. */
export function searxng(base: string): Backend {
  const MAX_RESULTS = 6;
  const MAX_SNIPPET = 300;
  return {
    via: 'the local SearXNG',
    async search(query, signal) {
      const url = new URL('/search', base);
      url.search = new URLSearchParams({ q: query, format: 'json' }).toString();
      const res = await fetch(url, { signal: withTimeout(signal, TIMEOUT_MS) });
      if (!res.ok) throw new Error(`SearXNG returned ${res.status}`);
      const data = (await res.json()) as { results?: { title?: unknown; url?: unknown; content?: unknown }[] };
      return (data.results ?? [])
        .filter((r) => isWebUrl(r.url))
        .slice(0, MAX_RESULTS)
        .map((r) => ({
          title: clip(typeof r.title === 'string' && r.title ? r.title : String(r.url), MAX_TITLE),
          url: r.url as string,
          snippet: clip(typeof r.content === 'string' ? r.content : '', MAX_SNIPPET),
        }));
    },
    fetch: (url, signal) => fetchPage(url, withTimeout(signal, FETCH_TIMEOUT_MS)),
  };
}

/** Ollama's web search service, through the local Ollama (needs `ollama signin`; queries and
 *  fetched URLs go to ollama.com). Its results carry each page's whole text, which made one search
 *  ~800 lines to read in Ollama's own pi package, so each result is cut to MAX_SNIPPET. */
export function ollama(base: string): Backend {
  const MAX_RESULTS = 5;
  const MAX_SNIPPET = 600;
  const call = async (path: string, body: object, signal: AbortSignal | undefined) => {
    const res = await fetch(new URL(`/api/experimental/${path}`, base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: withTimeout(signal, OLLAMA_TIMEOUT_MS),
    });
    if (res.status === 401) throw new Error('not signed in to ollama.com (run `ollama signin`)');
    if (!res.ok) throw new Error(`Ollama returned ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    return res.json() as Promise<Record<string, unknown>>;
  };
  return {
    via: "Ollama's web search",
    async search(query, signal) {
      const data = await call('web_search', { query, max_results: MAX_RESULTS }, signal);
      const raw = Array.isArray(data.results) ? (data.results as Record<string, unknown>[]) : [];
      return raw.slice(0, MAX_RESULTS).map((r) => ({
        title: clip(typeof r.title === 'string' && r.title ? r.title : String(r.url), MAX_TITLE),
        url: String(r.url),
        snippet: clip(typeof r.content === 'string' ? r.content : '', MAX_SNIPPET),
      }));
    },
    async fetch(url, signal) {
      const data = await call('web_fetch', { url }, signal);
      const text = typeof data.content === 'string' ? data.content.trim() : '';
      if (!text) throw new Error('the page has no readable text');
      return { url, title: typeof data.title === 'string' ? data.title : '', text };
    },
  };
}
