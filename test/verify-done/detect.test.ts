import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { detectCommand } from '../../src/verify-done/detect.ts';

function project(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'tacklebox-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

test('the test command comes from the project files', () => {
  assert.equal(detectCommand(project({ 'package.json': '{"scripts":{"test":"node --test"}}' })), 'npm test --silent');
  assert.equal(detectCommand(project({ 'package.json': '{"scripts":{"test":"vitest run"}}', 'pnpm-lock.yaml': '' })), 'pnpm test');
  assert.equal(detectCommand(project({ 'package.json': '{"scripts":{"test":"jest"}}', 'yarn.lock': '' })), 'yarn test');
  assert.equal(detectCommand(project({ 'Cargo.toml': '' })), 'cargo test --quiet');
  assert.equal(detectCommand(project({ 'go.mod': 'module x' })), 'go test ./...');
  assert.equal(detectCommand(project({ 'pyproject.toml': '[tool.pytest.ini_options]' })), 'python3 -m pytest -q');
  assert.equal(detectCommand(project({ 'tests/test_app.py': '' })), 'python3 -m pytest -q');
  assert.equal(detectCommand(project({ Makefile: 'build:\n\tcc x.c\ntest:\n\t./run\n' })), 'make test');
});

test("npm's placeholder test script, a broken package.json and a bare folder have no command", () => {
  assert.equal(detectCommand(project({ 'package.json': '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}' })), undefined);
  assert.equal(detectCommand(project({ 'package.json': '{ broken' })), undefined);
  assert.equal(detectCommand(project({ 'README.md': '# hi' })), undefined);
});
