import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_OUTLINE, outlineOf, TOP_LINES } from '../../src/outline-reads/outline.ts';

test('the top of the file, then definitions after it with their line numbers', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `x = ${i}`);
  lines[0] = '#!/bin/bash';
  lines[99] = 'deploy() {';
  lines[149] = 'export async function main() {';
  lines[179] = '## Usage';
  const out = outlineOf('run.sh', lines.join('\n'));
  assert.match(out, /^\[run\.sh is \d+ KB, 200 lines: too large to read whole/);
  assert.ok(out.includes('#!/bin/bash'));
  assert.ok(out.includes(`x = ${TOP_LINES - 1}`) && !out.includes(`x = ${TOP_LINES}\n`), 'only the top lines in full');
  assert.match(out, /--- outline \(3 entries after line 80\) ---\n100: deploy\(\) \{\n150: export async function main\(\) \{\n180: ## Usage$/);
});

test('a file with no definitions says to read ranges, and a long outline is cut', () => {
  assert.match(outlineOf('data.txt', 'a\n'.repeat(500)), /\(no definitions found: read ranges by line number\)$/);
  const many = Array.from({ length: 1000 }, (_, i) => `def f${i}():`).join('\n');
  const out = outlineOf('big.py', many);
  assert.match(out, new RegExp(`--- outline \\(${MAX_OUTLINE}\\+, cut entries`));
});
