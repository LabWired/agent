#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SAFE_FIXTURE_EXTENSION = new Set(['.json', '.csv']);
const FIXTURE_PREFIX = 'fixtures/hardware-profiles/';
const MACHINE_VALUE = /(?:^|["'\s:])(?:COM\d+|\/dev\/|\/Users\/|\/home\/|[A-Za-z]:\\)/i;
const CREDENTIAL_VALUE = /(?:bearer\s+\S+|basic\s+[A-Za-z0-9+/]+=*|sk-[A-Za-z0-9_-]{4,}|(?:password|secret|token|credential|authorization)\s*[":=])/i;
const GENERATED_EVIDENCE = /["'](?:evidenceDir|rawEvidence|receipt|generatedAt|generated_at|result)["']\s*:/i;

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

export function publicFixtureInventory(root) {
  const manifestPath = path.join(root, 'config/public-hardware-fixtures.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest || Object.keys(manifest).join(',') !== 'files' || !Array.isArray(manifest.files)) {
    throw new TypeError('public hardware fixture manifest must contain only a files array');
  }
  const seen = new Set();
  return manifest.files.map((file) => {
    if (typeof file !== 'string' || !file.startsWith(FIXTURE_PREFIX) || file.includes('..')
      || !SAFE_FIXTURE_EXTENSION.has(path.extname(file).toLowerCase()) || seen.has(file)) {
      throw new TypeError(`unsafe public hardware fixture manifest entry: ${file}`);
    }
    seen.add(file);
    const absolute = path.join(root, file);
    const details = fs.lstatSync(absolute);
    if (!details.isFile() || details.isSymbolicLink()) throw new TypeError(`unsafe public hardware fixture file: ${file}`);
    const content = fs.readFileSync(absolute, 'utf8');
    if (MACHINE_VALUE.test(content) || CREDENTIAL_VALUE.test(content) || GENERATED_EVIDENCE.test(content)) {
      throw new TypeError(`unsafe public hardware fixture content: ${file}`);
    }
    if (path.extname(file).toLowerCase() === '.json') JSON.parse(content);
    return file;
  });
}

export function sourceHardwareInventory(root) {
  const runtimeDirectory = path.join(root, 'lib/hardware');
  const runtime = walk(runtimeDirectory).map((file) => {
    if (path.extname(file) !== '.mjs') throw new TypeError(`unsafe hardware runtime source: ${file}`);
    return path.relative(root, file).split(path.sep).join('/');
  });
  const fixtures = publicFixtureInventory(root);
  return [...runtime, ...fixtures].sort();
}

export function assertHardwarePackageInventory(sourceFiles, packedFiles) {
  const missing = sourceFiles.filter((file) => !packedFiles.has(file));
  if (missing.length) {
    throw new TypeError(missing.map((file) => `${file}: required public hardware package file is missing`).join('\n'));
  }
  const expectedFixtures = new Set(sourceFiles.filter((file) => file.startsWith(FIXTURE_PREFIX)));
  const extraFixtures = [...packedFiles].filter((file) => file.startsWith(FIXTURE_PREFIX) && !expectedFixtures.has(file));
  if (extraFixtures.length) throw new TypeError(`${extraFixtures[0]}: non-allowlisted hardware profile fixture is packaged`);
}

export function assertPackageFixtureEntries(manifestFiles, packageFiles) {
  const declared = packageFiles.filter((file) => typeof file === 'string' && file.startsWith(FIXTURE_PREFIX));
  for (const file of manifestFiles) {
    if (!declared.includes(file)) throw new TypeError(`${file}: missing package.json fixture entry`);
  }
  for (const file of declared) {
    if (!manifestFiles.includes(file)) throw new TypeError(`${file}: non-allowlisted package.json fixture entry`);
  }
}

async function main() {
  const [root, packReport] = process.argv.slice(2);
  if (!root || !packReport) throw new TypeError('usage: check-hardware-package-inventory.mjs ROOT PACK_REPORT');
  const report = JSON.parse(fs.readFileSync(packReport, 'utf8'));
  const packed = new Set((report[0]?.files ?? []).map((entry) => entry.path));
  const source = sourceHardwareInventory(root);
  assertPackageFixtureEntries(publicFixtureInventory(root), JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).files ?? []);
  assertHardwarePackageInventory(source, packed);
  process.stdout.write('ok   exhaustive hardware package inventory\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`FAIL ${error.message}\n`);
    process.exitCode = 1;
  });
}
