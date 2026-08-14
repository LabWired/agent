import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packagePath = resolve(scriptDir, '../package.json');
const lockPath = resolve(scriptDir, '../package-lock.json');
const runnerPath = resolve(scriptDir, 'run-unit-tests.mjs');
const unitTestPaths = [
  resolve(scriptDir, '../src/test/unit/messages.test.ts'),
  resolve(scriptDir, '../src/test/unit/toolRunnerRpc.test.ts'),
];
const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
const packageLock = await readFile(lockPath, 'utf8');
const runnerSource = await readFile(runnerPath, 'utf8').catch(() => '');
const unitTestSources = await Promise.all(unitTestPaths.map(path => readFile(path, 'utf8')));

assert.equal(
  packageJson.scripts?.['test:unit'],
  'npm run compile && node scripts/run-unit-tests.mjs',
  'test:unit must run the compiled unit tests with the deterministic node:test runner',
);
assert.equal(
  packageJson.scripts?.['test:runtime-contract'],
  'node scripts/test-runtime-contract.mjs',
  'test:runtime-contract must be available as an npm script',
);
assert.match(
  packageJson.scripts?.contract ?? '',
  /npm run test:runtime-contract/,
  'contract must invoke test:runtime-contract',
);
for (const section of ['dependencies', 'devDependencies']) {
  const dependencies = packageJson[section] ?? {};
  for (const name of ['@types/mocha', 'mocha', 'serialize-javascript']) {
    assert.equal(name in dependencies, false, `${name} must not be in ${section}`);
  }
}
assert.notEqual(runnerSource, '', 'unit test runner must exist');
assert.match(runnerSource, /readdir/);
assert.match(runnerSource, /\.sort\(\)/, 'unit test discovery must be deterministic');
assert.doesNotMatch(runnerSource, /\*\*/);
for (const source of unitTestSources) {
  assert.doesNotMatch(source, /\bdescribe\s*\(/, 'unit tests must support Node 18.0');
}
assert.doesNotMatch(packageLock, /serialize-javascript/);

console.log('test runtime contract: OK');
