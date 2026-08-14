import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createTrustedAdapters } from '../lib/hardware/adapters.mjs';
import { createEvidenceBundle, sha256File } from '../lib/hardware/evidence.mjs';
import { resolveLaunch } from '../lib/hardware/process.mjs';

const roots = new Set();
process.once('exit', () => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

async function sandbox() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'labwired-observe-'));
  roots.add(root);
  await mkdir(path.join(root, 'build'));
  await writeFile(path.join(root, 'build', 'firmware.elf'), 'exact firmware');
  return root;
}

function profile(root, flash = 'platformio') {
  return {
    schema: 1,
    target: { id: 'desk-c3', chip: 'esp32c3', probeSerial: 'probe-123', serialPort: '/dev/ttyACM0' },
    build: { provider: 'platformio', workspace: root, environment: 'release', artifact: path.join(root, 'build', 'firmware.elf') },
    flash: { provider: flash, timeoutSeconds: 2 },
    observations: [],
  };
}

async function evidence(root, p) {
  const directory = path.join(root, `evidence-${Math.random().toString(16).slice(2)}`);
  await createEvidenceBundle(directory, p);
  return directory;
}

function harness(onRun, overrides = {}) {
  const calls = [];
  const adapters = createTrustedAdapters({
    env: { PATH: '/trusted', LANG: 'C', API_TOKEN: 'secret-value' },
    agentPath: '/trusted/labwired-agent',
    async resolveTool(name) { return `/trusted/${name}`; },
    async toolVersion(name) { return `${name} 1.0`; },
    async run(descriptor, options) {
      calls.push({ descriptor, options });
      return onRun ? onRun(descriptor, options, calls.length) : { classification: 'exit', exitCode: 0, stdout: '', stderr: '', truncated: { stdout: false, stderr: false } };
    },
    ...overrides,
  });
  return { adapters, calls };
}

test('flash adapters delegate exact identities and artifact to the existing shell-free CLI', async (t) => {
  for (const provider of ['platformio', 'probe-rs']) await t.test(provider, async () => {
    const root = await sandbox();
    const p = profile(root, provider);
    const hash = await sha256File(p.build.artifact);
    const { adapters } = harness();
    const ready = await adapters.flash[provider].preflight(p, { artifactSha256: hash });
    const descriptor = adapters.flash[provider].plan(p, ready);
    assert.equal(descriptor.executable, '/trusted/labwired-agent');
    assert.equal(descriptor.shell, false);
    assert.deepEqual(descriptor.args, ['probe', 'flash', p.build.artifact, '--chip', 'esp32c3', '--target', 'probe', '--probe', 'probe-123']);
    assert.equal(descriptor.env.LABWIRED_HW_PORT, '/dev/ttyACM0');
    assert.equal(descriptor.env.LABWIRED_FLASH_PROVIDER, provider);
    assert.throws(() => adapters.flash[provider].plan(p, {}), /capability/);
  });
});

test('flash revalidates the exact artifact before and after execution and redacts evidence', async () => {
  const root = await sandbox();
  const p = profile(root);
  const hash = await sha256File(p.build.artifact);
  const bundle = await evidence(root, p);
  const { adapters } = harness(async () => ({ classification: 'exit', exitCode: 0, stdout: 'ok secret-value', stderr: '', truncated: { stdout: false, stderr: false } }));
  const result = await adapters.flash.platformio.execute(p, { artifactSha256: hash, evidenceDir: bundle, redact: ['secret-value'] });
  assert.equal(result.level, 'hardware_observed');
  assert.equal(result.artifactSha256, hash);
  assert.equal(JSON.stringify(result).includes('secret-value'), false);
  assert.equal((await readFile(path.join(bundle, result.rawEvidenceRefs[0]), 'utf8')).includes('secret-value'), false);
});

test('flash fails closed on an artifact mutation race', async () => {
  const root = await sandbox();
  const p = profile(root);
  const hash = await sha256File(p.build.artifact);
  const { adapters } = harness(async () => {
    await writeFile(p.build.artifact, 'mutated firmware');
    return { classification: 'exit', exitCode: 0, stdout: '', stderr: '', truncated: { stdout: false, stderr: false } };
  });
  const result = await adapters.flash.platformio.execute(p, { artifactSha256: hash });
  assert.equal(result.level, 'failed');
  assert.match(result.diagnostics, /changed/);
});

test('physical plans are credential-free and normalize safely on Windows', async () => {
  const root = await sandbox(); const p = profile(root); const hash = await sha256File(p.build.artifact);
  const { adapters } = harness(undefined, { agentPath: 'C:\\LabWired\\labwired-agent.ps1' });
  const ready = await adapters.flash.platformio.preflight(p, { artifactSha256: hash });
  const descriptor = adapters.flash.platformio.plan(p, ready);
  assert.equal(JSON.stringify(descriptor).includes('secret-value'), false);
  const resolved = resolveLaunch(descriptor, { platform: 'win32', pathEnv: 'C:\\Windows\\System32' });
  assert.equal(resolved.spawnOptions.shell, false);
  assert.deepEqual(resolved.args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
});

test('flash preserves timeout and cancellation classifications without granting evidence', async (t) => {
  for (const classification of ['timeout', 'cancelled']) await t.test(classification, async () => {
    const root = await sandbox(); const p = profile(root); const hash = await sha256File(p.build.artifact);
    const { adapters } = harness(async () => ({ classification, exitCode: null, stdout: '', stderr: '', truncated: { stdout: false, stderr: false } }));
    const result = await adapters.flash.platformio.execute(p, { artifactSha256: hash });
    assert.equal(result.level, 'failed');
    assert.equal(result.process.classification, classification);
  });
});

test('serial and RTT delegate to existing capture commands and cannot share capabilities', async () => {
  const root = await sandbox();
  const p = profile(root);
  const { adapters } = harness();
  const serial = { id: 'heartbeat', provider: 'serial', contains: 'alive', timeoutSeconds: 7, requiredLevel: 'hardware_observed' };
  const rtt = { id: 'trace', provider: 'rtt', contains: 'ready', timeoutSeconds: 8, requiredLevel: 'hardware_observed' };
  const serialReady = await adapters.observation.serial.preflight(p, serial);
  assert.deepEqual(adapters.observation.serial.plan(p, serial, serialReady).args, ['serial-capture', '/dev/ttyACM0', '115200', 'alive', '7']);
  const rttReady = await adapters.observation.rtt.preflight(p, rtt);
  assert.deepEqual(adapters.observation.rtt.plan(p, rtt, rttReady).args, ['probe', 'rtt-capture', '--chip', 'esp32c3', '--elf', p.build.artifact, '--marker', 'ready', '--timeout', '8']);
  assert.throws(() => adapters.observation.rtt.plan(p, rtt, serialReady), /capability/);
});

test('logic CSV proves real transitions and frequency independently of serial text', async () => {
  const root = await sandbox();
  const capture = path.join(root, 'logic.csv');
  await writeFile(capture, 'time,CH0\n0,0\n0.5,1\n1,0\n1.5,1\n');
  const p = profile(root);
  const observation = { id: 'led', provider: 'logic-csv', file: capture, channel: 0, timeColumn: 'time', valueColumn: 'CH0', edgeCountAtLeast: 3, frequencyMinHz: 0.9, frequencyMaxHz: 1.1, requiredLevel: 'hardware_observed' };
  const bundle = await evidence(root, p);
  const { adapters } = harness();
  const hash = await sha256File(p.build.artifact);
  const result = await adapters.observation['logic-csv'].execute(p, observation, { evidenceDir: bundle, flashedArtifactSha256: hash, serialCapture: 'LED ON\nLED OFF' });
  assert.equal(result.level, 'hardware_observed');
  assert.equal(result.transitions, 3);
  assert.equal(result.frequencyHz, 1);
  assert.deepEqual(result.rawEvidenceRefs, ['observations/led.json']);
});

test('logic CSV rejects static, malformed, non-monotonic, symlinked, and raced captures', async (t) => {
  for (const [name, body, pattern] of [
    ['static', 'time,v\n0,1\n1,1\n', /transitions/],
    ['malformed', 'time,v\nwat,1\n', /finite/],
    ['nonmonotonic', 'time,v\n1,0\n0,1\n', /monotonic/],
    ['digital', 'time,v\n0,0\n1,2\n', /digital/],
  ]) await t.test(name, async () => {
    const root = await sandbox();
    const file = path.join(root, 'logic.csv'); await writeFile(file, body);
    const obs = { id: 'led', provider: 'logic-csv', file, channel: 0, timeColumn: 'time', valueColumn: 'v', edgeCountAtLeast: 1, requiredLevel: 'hardware_observed' };
    const result = await harness().adapters.observation['logic-csv'].execute(profile(root), obs);
    assert.equal(result.level, 'failed'); assert.match(result.diagnostics, pattern);
  });
  await t.test('symlink', async () => {
    const root = await sandbox(); const outside = path.join(os.tmpdir(), `logic-${Date.now()}.csv`); roots.add(outside);
    await writeFile(outside, 'time,v\n0,0\n1,1\n'); const file = path.join(root, 'logic.csv'); await symlink(outside, file);
    const obs = { id: 'led', provider: 'logic-csv', file, channel: 0, timeColumn: 'time', valueColumn: 'v', edgeCountAtLeast: 1, requiredLevel: 'hardware_observed' };
    assert.equal((await harness().adapters.observation['logic-csv'].execute(profile(root), obs)).level, 'failed');
  });
  await t.test('invalid frequency bound', async () => {
    const root = await sandbox(); const file = path.join(root, 'logic.csv');
    await writeFile(file, 'time,v\n0,0\n1,1\n');
    const obs = { id: 'led', provider: 'logic-csv', file, channel: 0, timeColumn: 'time', valueColumn: 'v', edgeCountAtLeast: 1, frequencyMinHz: Number.NaN, requiredLevel: 'hardware_observed' };
    const result = await harness().adapters.observation['logic-csv'].execute(profile(root), obs);
    assert.equal(result.level, 'failed'); assert.match(result.diagnostics, /frequency bound/);
  });
  await t.test('mutation race', async () => {
    const root = await sandbox(); const file = path.join(root, 'logic.csv');
    await writeFile(file, 'time,v\n0,0\n1,1\n');
    const obs = { id: 'led', provider: 'logic-csv', file, channel: 0, timeColumn: 'time', valueColumn: 'v', edgeCountAtLeast: 1, requiredLevel: 'hardware_observed' };
    const { adapters } = harness(undefined, { snapshotHooks: { async duringRead({ file: readPath }) { if (readPath === file) await writeFile(file, 'time,v\n0,0\n2,1\n'); } } });
    const result = await adapters.observation['logic-csv'].execute(profile(root), obs);
    assert.equal(result.level, 'failed'); assert.match(result.diagnostics, /changed/);
  });
});

test('network correlates a cryptographic nonce across serial marker and bounded host response', async () => {
  const nonce = '0123456789abcdef0123456789abcdef';
  const server = createServer((request, response) => { response.end(`healthy ${nonce}`); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const root = await sandbox(); const p = profile(root); const bundle = await evidence(root, p);
    const port = server.address().port;
    const hash = await sha256File(p.build.artifact);
    const observation = { id: 'wifi', provider: 'network', deviceMarker: 'WIFI_CONNECTED', hostProbeUrlFromMarker: 'DEVICE_IP', hostProbePath: '/health', requiredLevel: 'hardware_observed' };
    const { adapters } = harness(undefined, { randomBytes: () => Buffer.from(nonce, 'hex') });
    const result = await adapters.observation.network.execute(p, observation, { evidenceDir: bundle, flashedArtifactSha256: hash, deviceCapture: `WIFI_CONNECTED nonce=${nonce} DEVICE_IP=127.0.0.1:${port}` });
    assert.equal(result.level, 'hardware_observed');
    assert.equal(result.nonce, nonce);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('network rejects wrong nonce, public addresses, redirects, and oversized responses', async (t) => {
  const nonce = '0123456789abcdef0123456789abcdef';
  const observation = { id: 'wifi', provider: 'network', deviceMarker: 'WIFI_CONNECTED', hostProbeUrlFromMarker: 'DEVICE_IP', hostProbePath: '/health', requiredLevel: 'hardware_observed' };
  const root = await sandbox(); const p = profile(root);
  const adapter = harness(undefined, { randomBytes: () => Buffer.from(nonce, 'hex') }).adapters.observation.network;
  assert.equal((await adapter.execute(p, observation, { deviceCapture: `WIFI_CONNECTED nonce=wrong DEVICE_IP=127.0.0.1` })).level, 'failed');
  assert.equal((await adapter.execute(p, observation, { deviceCapture: `WIFI_CONNECTED nonce=${nonce} DEVICE_IP=8.8.8.8` })).level, 'failed');
  for (const [name, handler, pattern] of [
    ['redirect', (_q, r) => { r.writeHead(302, { location: '/health' }); r.end(); }, /redirect/],
    ['oversize', (_q, r) => r.end('x'.repeat(70_000)), /size/],
  ]) await t.test(name, async () => {
    const server = createServer(handler); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const result = await adapter.execute(p, observation, { deviceCapture: `WIFI_CONNECTED nonce=${nonce} DEVICE_IP=127.0.0.1:${server.address().port}` });
      assert.equal(result.level, 'failed'); assert.match(result.diagnostics, pattern);
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });
});
