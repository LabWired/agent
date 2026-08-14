import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const unitDir = join(scriptDir, '../out/test/unit');
const entries = await readdir(unitDir, { withFileTypes: true });
const testFiles = entries
  .filter(entry => entry.isFile() && entry.name.endsWith('.test.js'))
  .map(entry => join(unitDir, entry.name))
  .sort();

if (testFiles.length === 0) {
  throw new Error(`No unit test files found in ${unitDir}`);
}

for (const testFile of testFiles) {
  await import(pathToFileURL(testFile).href);
}
