import assert from 'node:assert/strict';
import { test } from 'node:test';
import { argumentHint, isSmallChange, writeChange } from '../../src/edit-assist/write.ts';

const lines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `code line ${from + i}`).join('\n');

test('a write holding only a new part of a file keeps almost none of it', () => {
  // 2026-11-19: part 3 written over parts 1 and 2.
  const c = writeChange(lines(1, 280), lines(281, 394))!;
  assert.equal(c.oldLines, 280);
  assert.equal(c.newLines, 114);
  assert.equal(c.kept, 0);
});

test('a write that adds to a file, or reorders it, keeps all of it', () => {
  assert.equal(writeChange(lines(1, 100), `${lines(1, 100)}\n${lines(101, 150)}`)!.kept, 1);
  assert.equal(writeChange(lines(1, 100), `${lines(51, 100)}\n${lines(1, 50)}`)!.kept, 1);
});

test('blank lines and indentation are not counted', () => {
  const old = lines(1, 40);
  const c = writeChange(old, old.replace(/\n/g, '\n\n').replace(/^/gm, '    '))!;
  assert.equal(c.kept, 1);
  assert.equal(c.changed, 0);
});

test('files under 20 non-blank lines are not judged', () => {
  assert.equal(writeChange(lines(1, 19), ''), undefined);
  assert.notEqual(writeChange(lines(1, 20), ''), undefined);
});

test('a one-line change to a whole file is small; a bigger one or none is not', () => {
  const old = lines(1, 300);
  assert.equal(isSmallChange(writeChange(old, old.replace('code line 150', 'changed line'))!), true);
  assert.equal(isSmallChange(writeChange(old, lines(1, 200))!), false);
  assert.equal(isSmallChange(writeChange(old, old)!), false);
});

const validation = (tool: string, ...problems: string[]) =>
  `Validation failed for tool "${tool}":\n${problems.map((p) => `  - ${p}`).join('\n')}\n\nReceived arguments:\n{}`;

test('a validation failure on edit or write gets the call shape', () => {
  const hint = argumentHint('edit', validation('edit', 'edits.0.oldText: missing'))!;
  assert.match(hint, /^edit-assist: edit's arguments must look like this, with every key present:\n\{"path": "<file>", "edits": \[\{"oldText"/);
  assert.doesNotMatch(hint, /"path" was missing/);
  assert.match(argumentHint('write', validation('write', 'content: missing'))!, /\{"path": "<file>", "content": "<the whole new file>"\}/);
});

test('a missing path is named, with the file last worked on when known', () => {
  assert.match(argumentHint('edit', validation('edit', 'path: missing'), '/tmp/aip/ai-proxy')!, /"path" was missing\. The file you last worked on is \/tmp\/aip\/ai-proxy\.$/);
  assert.match(argumentHint('write', validation('write', 'path: missing'))!, /"path" was missing\.$/);
});

test('other tools and other errors get nothing', () => {
  assert.equal(argumentHint('bash', validation('bash', 'command: missing')), undefined);
  assert.equal(argumentHint('edit', 'Could not find the exact text in x.ts.'), undefined);
  assert.equal(argumentHint('edit', validation('write', 'path: missing')), undefined);
});
