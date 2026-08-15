import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import nodeTest from 'node:test';

import { providerEnvironment, resolveHardwareIdentities } from '../scripts/hardware-runner.mjs';
import { planHardwareRun } from '../lib/hardware/runner.mjs';

let activeRoots;
function test(name, fn) {
  return nodeTest(name, async (context) => {
    const previous = activeRoots;
    const owned = [];
    activeRoots = owned;
    try { return await fn(context); }
    finally {
      activeRoots = previous;
      await Promise.all(owned.map((root) => rm(root, { recursive: true, force: true })));
    }
  });
}

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
  const root = await mkdtemp(path.join(os.tmpdir(), 'labwired-enum-')); activeRoots.push(root);
  const pio = path.join(root, 'pio'); const pidFile = path.join(root, 'pid');
  await writeFile(pio, `#!/usr/bin/env bash\nsleep 30 &\necho $! >${JSON.stringify(pidFile)}\nwait\n`, { mode: 0o755 });
  const oldPath = process.env.PATH; process.env.PATH = `${root}:${oldPath}`;
  const profile = { target: { id: 'desk', probeSerial: 'probe', serialPort: '/dev/tty0' }, build: { provider: 'platformio' }, flash: { provider: 'platformio' } };
  const abort = new AbortController();
  let enumeration;
  try {
    enumeration = resolveHardwareIdentities(profile, { timeoutMs: 5_000, signal: abort.signal });
    const deadline = Date.now() + 4_000;
    let pid;
    while (Date.now() < deadline) {
      try { pid = Number((await readFile(pidFile, 'utf8')).trim()); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(Number.isInteger(pid), 'provider never reached the READY/pid handshake');
    await assert.rejects(enumeration, /timed out/);
    const deathDeadline = Date.now() + 1_000;
    while (Date.now() < deathDeadline) {
      try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`provider descendant ${pid} remained alive after timeout`);
  } finally {
    abort.abort();
    await enumeration?.catch(() => {});
    process.env.PATH = oldPath;
  }
});

test('provider environment is an explicit secret-free cross-platform allowlist', () => {
  const selected = providerEnvironment({
    PATH: '/safe/bin', HOME: '/safe/home', TMPDIR: '/safe/tmp', LANG: 'C.UTF-8',
    SECRET_API_KEY: 'do-not-pass', TOKEN: 'do-not-pass', NODE_OPTIONS: '--require attacker.js',
    TEMP: '/tmp/sk-EXPOSED1234',
  });
  assert.deepEqual({ ...selected }, { PATH: '/safe/bin', HOME: '/safe/home', TMPDIR: '/safe/tmp', LANG: 'C.UTF-8' });
});

test('provider process receives safe runtime variables but no ambient secrets or NODE_OPTIONS', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(path.join(os.tmpdir(), 'labwired-env-')); activeRoots.push(root);
  const envFile = path.join(root, 'provider.env');
  await writeFile(path.join(root, 'pio'), `#!/usr/bin/env bash\nenv >${JSON.stringify(envFile)}\nprintf '[]\\n'\n`, { mode: 0o755 });
  const oldPath = process.env.PATH; process.env.PATH = `${root}:${oldPath}`;
  const profile = { target: { id: 'desk', probeSerial: 'probe', serialPort: '/dev/tty0' }, build: { provider: 'platformio', workspace: root }, flash: { provider: 'platformio' } };
  try {
    await resolveHardwareIdentities(profile, { environment: {
      PATH: `${root}:/usr/bin:/bin`, HOME: '/safe/home', TMPDIR: '/safe/tmp', LANG: 'C',
      SECRET_API_KEY: 'exposed', TOKEN: 'exposed', NODE_OPTIONS: '--require attacker.js',
    } });
    const names = new Set((await readFile(envFile, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => line.split('=', 1)[0]));
    for (const required of ['PATH', 'HOME', 'TMPDIR', 'LANG']) assert.equal(names.has(required), true, required);
    for (const forbidden of ['SECRET_API_KEY', 'TOKEN', 'NODE_OPTIONS']) assert.equal(names.has(forbidden), false, forbidden);
  } finally { process.env.PATH = oldPath; }
});

test('already-aborted enumeration never spawns a provider', async () => {
  const abort = new AbortController(); abort.abort();
  const profile = { target: { id: 'desk', probeSerial: 'probe', serialPort: '/dev/tty0' }, build: { provider: 'platformio' }, flash: { provider: 'platformio' } };
  await assert.rejects(resolveHardwareIdentities(profile, { signal: abort.signal }), /cancelled/);
});

test('logic analyzer enumeration requires one exact provider-owned instrument identity', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(path.join(os.tmpdir(), 'labwired-instrument-')); activeRoots.push(root);
  await writeFile(path.join(root, 'pio'), '#!/usr/bin/env bash\nprintf \'[{"port":"/dev/tty0","serialNumber":"probe"}]\\n\'\n', { mode: 0o755 });
  const sigrok = path.join(root, 'sigrok-cli');
  const profile = { target: { id: 'desk', probeSerial: 'probe', serialPort: '/dev/tty0' }, build: { provider: 'platformio', workspace: root }, flash: { provider: 'platformio' }, observations: [{ id: 'led', provider: 'logic-csv', requiredLevel: 'hardware_observed', driver: 'saleae-logic16', instrumentId: 'analyzer-1' }] };
  await writeFile(sigrok, '#!/usr/bin/env bash\nprintf \'saleae-logic16 - analyzer-1\\n\'\n', { mode: 0o755 });
  const exact = await resolveHardwareIdentities(profile, { environment: { PATH: `${root}:/usr/bin:/bin` } });
  assert.equal(exact.length, 1); assert.equal(exact[0].instruments['instrument-led'], 'analyzer-1');
  await writeFile(sigrok, '#!/usr/bin/env bash\nprintf \'saleae-logic16 - analyzer-1\\nsaleae-logic16 - analyzer-1\\n\'\n', { mode: 0o755 });
  assert.deepEqual(await resolveHardwareIdentities(profile, { environment: { PATH: `${root}:/usr/bin:/bin` } }), []);
});
