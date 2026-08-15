import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertHardwarePackageInventory,
  assertPackageFixtureEntries,
  sourceHardwareInventory,
} from '../scripts/check-hardware-package-inventory.mjs';

test('source inventory dynamically includes every hardware runtime and safe fixture', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labwired-package-inventory-'));
  try {
    fs.mkdirSync(path.join(root, 'lib/hardware'), { recursive: true });
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.mkdirSync(path.join(root, 'fixtures/hardware-profiles/logic'), { recursive: true });
    fs.writeFileSync(path.join(root, 'lib/hardware/new-provider.mjs'), 'export {};\n');
    fs.writeFileSync(path.join(root, 'fixtures/hardware-profiles/minimal.json'), '{}\n');
    fs.writeFileSync(path.join(root, 'fixtures/hardware-profiles/logic/pass.csv'), 't,v\n');
    fs.writeFileSync(path.join(root, 'config/public-hardware-fixtures.json'), JSON.stringify({ files: [
      'fixtures/hardware-profiles/minimal.json', 'fixtures/hardware-profiles/logic/pass.csv',
    ] }));
    assert.deepEqual(sourceHardwareInventory(root), [
      'fixtures/hardware-profiles/logic/pass.csv',
      'fixtures/hardware-profiles/minimal.json',
      'lib/hardware/new-provider.mjs',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('package inventory fails when a newly added runtime module is omitted', () => {
  const source = ['lib/hardware/adapters.mjs', 'lib/hardware/future-provider.mjs'];
  assert.throws(
    () => assertHardwarePackageInventory(source, new Set(['lib/hardware/adapters.mjs'])),
    /future-provider\.mjs: required public hardware package file is missing/,
  );
});

test('package inventory rejects machine-bound content even under innocent fixture names', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labwired-package-fixtures-'));
  try {
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.mkdirSync(path.join(root, 'lib/hardware'), { recursive: true });
    fs.mkdirSync(path.join(root, 'fixtures/hardware-profiles'), { recursive: true });
    for (const [name, content] of [
      ['workbench.json', '{"serialPort":"COM7"}'],
      ['capture.csv', '/dev/tty.usbmodem1234'],
      ['coverage.json', '{"evidenceDir":"generated/evidence"}'],
    ]) {
      fs.writeFileSync(path.join(root, 'fixtures/hardware-profiles', name), content);
      fs.writeFileSync(path.join(root, 'config/public-hardware-fixtures.json'), JSON.stringify({ files: [`fixtures/hardware-profiles/${name}`] }));
      assert.throws(() => sourceHardwareInventory(root), /unsafe public hardware fixture content/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('package fixture entries exactly match the central allowlist', () => {
  const manifest = ['fixtures/hardware-profiles/minimal.json'];
  assert.doesNotThrow(() => assertPackageFixtureEntries(manifest, ['README.md', ...manifest]));
  assert.throws(() => assertPackageFixtureEntries(manifest, ['README.md']), /missing package.json fixture entry/);
  assert.throws(() => assertPackageFixtureEntries(manifest, [...manifest, 'fixtures/hardware-profiles/workbench.json']), /non-allowlisted package.json fixture entry/);
  assert.throws(() => assertPackageFixtureEntries(manifest, [...manifest, 'fixtures/hardware-profiles\/\*\*\/\*\.json']), /non-allowlisted package.json fixture entry/);
});
