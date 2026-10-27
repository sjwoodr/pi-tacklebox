import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CONFIG, DEFAULTS, loadConfig, parseConfig } from '../src/config.ts';

test('no file, or an empty one, gives the defaults: timer on, outlines and search off', () => {
  assert.deepEqual(parseConfig(undefined), DEFAULTS);
  assert.deepEqual(parseConfig({}), DEFAULTS);
  assert.equal(DEFAULTS.turnTimer.enabled, true);
  assert.equal(DEFAULTS.outlineReads.enabled, false);
  assert.equal(DEFAULTS.search.backend, 'off');
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
