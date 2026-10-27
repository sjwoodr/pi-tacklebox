import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchPage, htmlToText, isPrivateAddress } from '../../src/search/local-fetch.ts';

test('private, loopback, link-local and mapped addresses are refused; public ones are not', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.139', '172.16.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '224.0.0.1'])
    assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111'])
    assert.equal(isPrivateAddress(ip), false, ip);
});

test('fetchPage refuses a local address before sending anything', async () => {
  await assert.rejects(fetchPage('http://127.0.0.1:11434/api/tags', AbortSignal.timeout(1000)), /local or private address/);
});

test('htmlToText keeps the main content, headings and list items, and decodes French entities', () => {
  const filler = 'Du texte. '.repeat(40);
  const html = `<html><head><title>Les r&eacute;sultats</title><script>evil()</script></head><body>
    <nav>Menu</nav><main><h2>Fran&ccedil;ais</h2><p>${filler}</p><ul><li>un</li><li>deux &amp; trois</li></ul></main>
    <footer>Pied</footer></body></html>`;
  const { title, text } = htmlToText(html);
  assert.equal(title, 'Les résultats');
  assert.ok(text.startsWith('## Français'));
  assert.ok(text.includes('- un\n- deux & trois'));
  assert.ok(!/Menu|Pied|evil/.test(text));
});
