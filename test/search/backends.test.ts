import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { ollama, searxng } from '../../src/search/backends.ts';

/** A local HTTP server that answers with `handle`; returns its base URL and the requests it saw. */
async function serve(handle: (req: IncomingMessage, body: string, res: ServerResponse) => void) {
  const seen: { url: string; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', body });
      handle(req, body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  test.after(() => server.close());
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const json = (res: ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};

test('searxng: asks for JSON, keeps web results only, at most six, snippets clipped', async () => {
  const results = [
    { title: 'Not web', url: 'ftp://example.com/x', content: 'x' },
    ...Array.from({ length: 8 }, (_, i) => ({ title: `T${i}`, url: `https://example.com/${i}`, content: 'word '.repeat(100) })),
  ];
  const { base, seen } = await serve((_req, _body, res) => json(res, 200, { results }));
  const found = await searxng(base).search('bears schedule', undefined);
  assert.equal(seen[0]!.url, '/search?q=bears+schedule&format=json');
  assert.equal(found.length, 6);
  assert.equal(found[0]!.url, 'https://example.com/0');
  assert.ok(found[0]!.snippet.length <= 300 && found[0]!.snippet.endsWith('…'));
});

test('searxng: an error status is reported, and its fetch never reads local addresses', async () => {
  const { base } = await serve((_req, _body, res) => json(res, 429, {}));
  await assert.rejects(searxng(base).search('q', undefined), /SearXNG returned 429/);
  await assert.rejects(searxng(base).fetch(`${base}/page`, undefined), /local or private address/);
});

test('ollama: posts to the experimental endpoints, clips results, and explains a 401', async () => {
  const { base, seen } = await serve((req, body, res) => {
    if (req.url === '/api/experimental/web_search') {
      const { max_results } = JSON.parse(body);
      json(res, 200, { results: Array.from({ length: max_results + 2 }, (_, i) => ({ title: '', url: `https://e.com/${i}`, content: 'w '.repeat(1000) })) });
    } else if (req.url === '/api/experimental/web_fetch') json(res, 200, { title: 'Page', content: '  Hello  ' });
    else json(res, 404, {});
  });
  const found = await ollama(base).search('q', undefined);
  assert.equal(JSON.parse(seen[0]!.body).max_results, 5);
  assert.equal(found.length, 5);
  assert.equal(found[0]!.title, 'https://e.com/0', 'a missing title falls back to the URL');
  assert.ok(found[0]!.snippet.length <= 600);
  assert.deepEqual(await ollama(base).fetch('https://e.com/a', undefined), { url: 'https://e.com/a', title: 'Page', text: 'Hello' });

  const { base: signedOut } = await serve((_req, _body, res) => json(res, 401, {}));
  await assert.rejects(ollama(signedOut).search('q', undefined), /not signed in to ollama\.com \(run `ollama signin`\)/);
});
