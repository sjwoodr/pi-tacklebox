import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closestMatch, lineOf, mismatchHint } from '../../src/edit-assist/closest.ts';

// The shape of the 2026-11-19 misses: oldText from before the model's own edit (return -> sys.exit(0)).
const file = [
  'import sys',
  '',
  'async def main():',
  '    args = parse()',
  '    if args.self_test:',
  '        await run_self_test()',
  '        sys.exit(0)',
  '',
  '    if args.headless:',
  '        await run_headless()',
  '        return',
  '',
  'main()',
].join('\n');
const stale = ['    if args.self_test:', '        await run_self_test()', '        return', '', '    if args.headless:'].join('\n');

test('the closest stretch is found by line, with the line that changed since', () => {
  const c = closestMatch(file, stale)!;
  assert.equal(c.start, 5);
  assert.equal(c.end, 9);
  assert.equal(c.same, 3);
  assert.equal(c.total, 4);
  assert.deepEqual(c.differences, [{ fileLine: 7, file: '        sys.exit(0)', yours: '        return' }]);
});

test('indentation alone does not count as a difference, as pi forgives it too', () => {
  const c = closestMatch(file, stale.replace(/^ {4}/gm, '\t'))!;
  assert.deepEqual(
    c.differences.map((d) => d.fileLine),
    [7],
  );
});

test('lines only on one side are reported on their own', () => {
  const extra = ['    if args.self_test:', '        print("testing")', '        await run_self_test()', '        sys.exit(0)'].join('\n');
  assert.deepEqual(closestMatch(file, extra)!.differences, [{ yours: '        print("testing")' }]);
  const short = ['    args = parse()', '    if args.self_test:', '        sys.exit(0)'].join('\n');
  const c = closestMatch(file, short)!;
  assert.deepEqual(c.differences, [{ fileLine: 6, file: '        await run_self_test()' }]);
});

test('nothing in common, or an oldText of blank lines, gives no match', () => {
  assert.equal(closestMatch(file, 'class Forwarder:\n    pass'), undefined);
  assert.equal(closestMatch(file, '\n\n'), undefined);
});

test('the hint names the stretch, quotes both sides of each difference and shows the current lines', () => {
  const hint = mismatchHint(file, 'oldText', stale);
  assert.match(hint, /^edit-assist: This oldText is not in the file as it is now\. The closest stretch is lines 5-9, with 3 of its 4 lines the same/);
  assert.match(hint, /line 7 of the file: " {8}sys\.exit\(0\)"\n {2}your oldText has: {3}" {8}return"/);
  assert.match(hint, /Lines 5-9 as they are now[^\n]*\n```\n {4}if args\.self_test:\n[\s\S]*\n {4}if args\.headless:\n```$/);
});

test('a newText already in the file is pointed out first', () => {
  const hint = mismatchHint(file, 'edits[1].oldText', stale, '        await run_self_test()\n        sys.exit(0)');
  assert.match(hint, /^edit-assist: This edit's newText is already in the file, at line 6/);
  assert.match(hint, /This edits\[1\]\.oldText is not in the file/);
});

test('with no close stretch the hint says to read the file again', () => {
  const hint = mismatchHint(file, 'oldText', 'def unrelated():\n    x = 1\n    y = 2\n    return x + y\n    sys.exit(0)');
  assert.match(hint, /Nothing in the file as it is now is close to this oldText \(the nearest stretch, lines \d+-\d+, shares 1 of its 5 lines\)\. read the file again/);
  assert.doesNotMatch(hint, /```/);
});

test('a long stretch is shown from just before its first difference, at most 60 lines', () => {
  const long = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
  const wanted = long.slice(19, 119).map((l, i) => (i === 80 ? 'changed' : l)).join('\n');
  const hint = mismatchHint(long.join('\n'), 'oldText', wanted);
  assert.match(hint, /closest stretch is lines 20-119/);
  assert.match(hint, /Lines 90-119 as they are now/);
});

test('lineOf finds where text starts', () => {
  assert.equal(lineOf(file, 'sys.exit(0)'), 7);
  assert.equal(lineOf(file, 'not there'), undefined);
});
