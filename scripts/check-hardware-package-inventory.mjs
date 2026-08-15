#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SAFE_FIXTURE_EXTENSION = new Set(['.json', '.csv']);
const PRIVATE_COMPONENT = /(?:^|[-_.])(credential|secret|token|machine|evidence)(?:[-_.]|$)/i;

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new TypeError(`unsafe hardware profile fixture symlink: ${absolute}`);
    if (entry.isDirectory()) result.push(...walk(absolute));
    else if (entry.isFile()) result.push(absolute);
  }
  return result;
}

export function sourceHardwareInventory(root) {
  const runtimeDirectory = path.join(root, 'lib/hardware');
  const runtime = walk(runtimeDirectory).map((file) => {
    if (path.extname(file) !== '.mjs') throw new TypeError(`unsafe hardware runtime source: ${file}`);
    return path.relative(root, file).split(path.sep).join('/');
  });
  const fixtureDirectory = path.join(root, 'fixtures/hardware-profiles');
  const fixtures = walk(fixtureDirectory).flatMap((file) => {
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (PRIVATE_COMPONENT.test(relative)) {
      throw new TypeError(`unsafe hardware profile fixture: ${relative}`);
    }
    return SAFE_FIXTURE_EXTENSION.has(path.extname(file).toLowerCase()) ? [relative] : [];
  });
  return [...runtime, ...fixtures].sort();
}

export function assertHardwarePackageInventory(sourceFiles, packedFiles) {
  const missing = sourceFiles.filter((file) => !packedFiles.has(file));
  if (missing.length) {
    throw new TypeError(missing.map((file) => `${file}: required public hardware package file is missing`).join('\n'));
  }
}

async function main() {
  const [root, packReport] = process.argv.slice(2);
  if (!root || !packReport) throw new TypeError('usage: check-hardware-package-inventory.mjs ROOT PACK_REPORT');
  const report = JSON.parse(fs.readFileSync(packReport, 'utf8'));
  const packed = new Set((report[0]?.files ?? []).map((entry) => entry.path));
  assertHardwarePackageInventory(sourceHardwareInventory(root), packed);
  process.stdout.write('ok   exhaustive hardware package inventory\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`FAIL ${error.message}\n`);
    process.exitCode = 1;
  });
}
