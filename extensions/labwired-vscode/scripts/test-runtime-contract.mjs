import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packagePath = resolve(scriptDir, '../package.json');
const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
const devDependencies = packageJson.devDependencies ?? {};

assert.equal(
  packageJson.scripts?.['test:unit'],
  'npm run compile && node --test "out/test/unit/**/*.test.js"',
  'test:unit must run the compiled unit tests with node:test',
);
assert.equal('@types/mocha' in devDependencies, false, '@types/mocha must not be a devDependency');
assert.equal('mocha' in devDependencies, false, 'mocha must not be a devDependency');

console.log('test runtime contract: OK');
