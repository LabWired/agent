import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveHardwareIdentities } from '../scripts/hardware-runner.mjs';
import { planHardwareRun } from '../lib/hardware/runner.mjs';

const roots = [];
test.after(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

test('direct runner rejects credential-shaped paths before dependencies or output', async () => {
  let loaded = false;
  await assert.rejects(planHardwareRun({
    profilePath: '/tmp/sk-EXPOSED1234/profile.json', evidenceDir: '/tmp/evidence',
    dependencies: { async loadProfile() { loaded = true; } },
  }), /credential-shaped/);
  assert.equal(loaded, false);
});

test('provider enumeration timeout kills its descendant process tree', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(path.join(os.tmpdir(), 'labwired-enum-')); roots.push(root);
  const pio = path.join(root, 'pio'); const pidFile = path.join(root, 'pid');
  await writeFile(pio, `#!/usr/bin/env bash\nsleep 30 &\necho $! >${JSON.stringify(pidFile)}\nwait\n`, { mode: 0o755 });
  const oldPath = process.env.PATH; process.env.PATH = `${root}:${oldPath}`;
  const profile = { target: { id: 'desk', probeSerial: 'probe', serialPort: '/dev/tty0' }, build: { provider: 'platformio' }, flash: { provider: 'platformio' } };
  try {
    await assert.rejects(resolveHardwareIdentities(profile, { timeoutMs: 500 }), /timed out/);
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally { process.env.PATH = oldPath; }
});

test('already-aborted enumeration never spawns a provider', async () => {
  const abort = new AbortController(); abort.abort();
  const profile = { target: { id: 'desk', probeSerial: 'probe', serialPort: '/dev/tty0' }, build: { provider: 'platformio' }, flash: { provider: 'platformio' } };
  await assert.rejects(resolveHardwareIdentities(profile, { signal: abort.signal }), /cancelled/);
});
