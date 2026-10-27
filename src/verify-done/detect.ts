import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (path: string) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

/** The project's test command, from the files at its root; undefined when there is none to run. */
export function detectCommand(dir: string): string | undefined {
  const pkg = read(join(dir, 'package.json'));
  if (pkg) {
    let test: unknown;
    try {
      test = JSON.parse(pkg).scripts?.test;
    } catch {
      test = undefined;
    }
    // npm init's placeholder fails on purpose; it is not a test suite.
    if (typeof test === 'string' && !/no test specified/.test(test)) {
      if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm test';
      if (existsSync(join(dir, 'yarn.lock'))) return 'yarn test';
      return 'npm test --silent';
    }
  }
  if (existsSync(join(dir, 'Cargo.toml'))) return 'cargo test --quiet';
  if (existsSync(join(dir, 'go.mod'))) return 'go test ./...';
  const pytestConfig = ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini'].some((f) => /pytest/.test(read(join(dir, f)) ?? ''));
  const testsDir = ['tests', 'test'].some((d) => {
    try {
      return readdirSync(join(dir, d)).some((f) => /^test_.*\.py$|_test\.py$/.test(f));
    } catch {
      return false;
    }
  });
  if (pytestConfig || testsDir) return 'python3 -m pytest -q';
  if (/^test\s*:/m.test(read(join(dir, 'Makefile')) ?? '')) return 'make test';
  return undefined;
}
