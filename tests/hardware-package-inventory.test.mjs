import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertHardwarePackageInventory, sourceHardwareInventory } from '../scripts/check-hardware-package-inventory.mjs';

test('source inventory dynamically includes every hardware runtime and safe fixture', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labwired-package-inventory-'));
  try {
    fs.mkdirSync(path.join(root, 'lib/hardware'), { recursive: true });
    fs.mkdirSync(path.join(root, 'fixtures/hardware-profiles/logic'), { recursive: true });
    fs.writeFileSync(path.join(root, 'lib/hardware/new-provider.mjs'), 'export {};\n');
    fs.writeFileSync(path.join(root, 'fixtures/hardware-profiles/minimal.json'), '{}\n');
    fs.writeFileSync(path.join(root, 'fixtures/hardware-profiles/logic/pass.csv'), 't,v\n');
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

test('package inventory accepts only the defined safe fixture extensions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labwired-package-fixtures-'));
  try {
    fs.mkdirSync(path.join(root, 'lib/hardware'), { recursive: true });
    fs.mkdirSync(path.join(root, 'fixtures/hardware-profiles'), { recursive: true });
    fs.writeFileSync(path.join(root, 'fixtures/hardware-profiles/token.secret'), 'never publish');
    assert.throws(() => sourceHardwareInventory(root), /unsafe hardware profile fixture/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
