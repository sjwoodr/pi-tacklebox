import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CONFIG, DEFAULTS, loadConfig, parseConfig } from '../src/config.ts';

test('no file, or an empty one, gives the defaults: timer, nudge, edit-assist and verify-done on; outlines and search off', () => {
  assert.deepEqual(parseConfig(undefined), DEFAULTS);
  assert.deepEqual(parseConfig({}), DEFAULTS);
  assert.equal(DEFAULTS.turnTimer.enabled, true);
  assert.equal(DEFAULTS.outlineReads.enabled, false);
  assert.equal(DEFAULTS.search.backend, 'off');
  assert.equal(DEFAULTS.nudge.enabled, true);
  assert.equal(DEFAULTS.editAssist.enabled, true);
  assert.equal(DEFAULTS.editAssist.writeGuardMinKept, 0.5);
  assert.deepEqual(DEFAULTS.repeatGuard, { enabled: true, noteAt: 3, blockAt: 5 });
  assert.equal(DEFAULTS.verifyDone.enabled, true);
});

test('settings override the defaults one key at a time', () => {
  const config = parseConfig({ search: { backend: 'searxng' }, outlineReads: { enabled: true } });
  assert.equal(config.search.backend, 'searxng');
  assert.equal(config.search.searxngUrl, DEFAULTS.search.searxngUrl);
  assert.equal(config.outlineReads.enabled, true);
  assert.equal(config.outlineReads.maxChars, 20_000);
  assert.equal(DEFAULTS.search.backend, 'off', 'the defaults are not changed');
});

test('mistakes are errors, not silently ignored', () => {
  assert.throws(() => parseConfig({ serch: {} }), /unknown section "serch"/);
  assert.throws(() => parseConfig({ search: { engine: 'x' } }), /unknown setting "search.engine"/);
  assert.throws(() => parseConfig({ turnTimer: { enabled: 'yes' } }), /"turnTimer.enabled" should be a boolean/);
  assert.throws(() => parseConfig({ search: { backend: 'google' } }), /"search.backend" should be one of "off", "searxng", "ollama"/);
  assert.throws(() => parseConfig({ editAssist: { writeGuardMinKept: 0 } }), /"editAssist.writeGuardMinKept" should be a share above 0 and at most 1/);
  assert.throws(() => parseConfig({ editAssist: { writeGuardMinKept: 50 } }), /"editAssist.writeGuardMinKept" should be a share/);
  assert.throws(() => parseConfig({ repeatGuard: { noteAt: 1 } }), /"repeatGuard.noteAt" should be a whole number, 2 or more/);
  assert.throws(() => parseConfig({ repeatGuard: { noteAt: 2.5 } }), /"repeatGuard.noteAt" should be a whole number/);
  assert.throws(() => parseConfig({ repeatGuard: { noteAt: 4, blockAt: 3 } }), /"repeatGuard.blockAt" should be 0 \(never refuse\) or a whole number no smaller than noteAt/);
  assert.equal(parseConfig({ repeatGuard: { blockAt: 0 } }).repeatGuard.blockAt, 0);
  assert.throws(() => parseConfig([]), /expected a JSON object/);
});

test('loadConfig reads tacklebox.json from the given directory and names it in errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tacklebox-'));
  assert.deepEqual(loadConfig(dir), DEFAULTS);
  writeFileSync(join(dir, CONFIG), JSON.stringify({ search: { backend: 'ollama' } }));
  assert.equal(loadConfig(dir).search.backend, 'ollama');
  writeFileSync(join(dir, CONFIG), '{ not json');
  assert.throws(() => loadConfig(dir), /^Error: tacklebox\.json: /);
});
