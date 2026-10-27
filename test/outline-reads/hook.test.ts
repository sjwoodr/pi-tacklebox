import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import outlineReads from '../../src/outline-reads/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'tacklebox-'));
writeFileSync(join(dir, 'tacklebox.json'), JSON.stringify({ outlineReads: { enabled: true, maxChars: 1000 } }));
writeFileSync(join(dir, 'big.ts'), Array.from({ length: 300 }, (_, i) => `const v${i} = ${i};`).join('\n'));

let hook: (event: object, ctx: object) => Promise<{ content: { text: string }[] } | undefined>;
process.env.PI_CODING_AGENT_DIR = dir;
outlineReads({ on: (_event: string, handler: typeof hook) => (hook = handler) } as never);
delete process.env.PI_CODING_AGENT_DIR;

const read = (input: object, returned: number, extra: object = {}) =>
  hook({ toolName: 'read', isError: false, input, content: [{ type: 'text', text: 'x'.repeat(returned) }], ...extra }, { cwd: dir });

test('a whole-file read over maxChars comes back as an outline', async () => {
  const out = await read({ path: 'big.ts' }, 5000);
  assert.match(out!.content[0]!.text, /^\[big\.ts is \d+ KB, 300 lines/);
});

test('reads with offset or limit, small reads, errors and other tools pass through', async () => {
  assert.equal(await read({ path: 'big.ts', offset: 100 }, 5000), undefined);
  assert.equal(await read({ path: 'big.ts', limit: 50 }, 5000), undefined);
  assert.equal(await read({ path: 'big.ts' }, 999), undefined);
  assert.equal(await read({ path: 'big.ts' }, 5000, { isError: true }), undefined);
  assert.equal(await read({ path: 'big.ts' }, 5000, { toolName: 'grep' }), undefined);
  assert.equal(await read({ path: 'missing.ts' }, 5000), undefined, 'an unreadable file keeps the real result');
});
