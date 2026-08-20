import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { createTrustedAdapters, resolveAgentLauncher } from '../lib/hardware/adapters.mjs';
import { createEvidenceBundle, sha256File } from '../lib/hardware/evidence.mjs';
import { resolveLaunch } from '../lib/hardware/process.mjs';
import { validateHardwareProfile } from '../lib/hardware/profile.mjs';

const roots = new Set();
process.once('exit', () => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

async function sandbox() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'labwired-observe-'));
  roots.add(root);
  await mkdir(path.join(root, 'build'));
  await writeFile(path.join(root, 'build', 'firmware.bin'), 'exact firmware');
  return root;
}

function profile(root, flash = 'platformio') {
  return {
    schema: 1,
    target: { id: 'desk-c3', chip: 'esp32c3', probeSerial: 'probe-123', serialPort: '/dev/ttyACM0' },
    build: { provider: 'platformio', workspace: root, environment: 'release', artifact: path.join(root, 'build', 'firmware.bin') },
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

function trustedLogic(overrides = {}) {
  return { id: 'led', provider: 'logic-csv', channel: 0, timeColumn: 'time', valueColumn: 'CH0', edgeCountAtLeast: 3,
    captureProvider: 'sigrok-cli', instrumentId: 'analyzer-1', driver: 'saleae-logic16', sourceChannel: 'D0', sampleRateHz: 1000, durationSeconds: 2,
    timeoutSeconds: 5, requiredLevel: 'hardware_observed', ...overrides };
}

function captureHarness(body, overrides = {}) {
  return harness(async (descriptor) => {
    const outputIndex = descriptor.args.indexOf('--output-file');
    if (outputIndex >= 0 && body !== undefined) await writeFile(descriptor.args[outputIndex + 1], body);
    return { classification: 'exit', exitCode: 0, stdout: '', stderr: '', truncated: { stdout: false, stderr: false } };
  }, overrides);
}

test('flash adapters delegate exact identities and artifact to the existing shell-free CLI', async (t) => {
  for (const provider of ['platformio', 'probe-rs']) await t.test(provider, async () => {
    const root = await sandbox();
    const p = profile(root, provider);
    if (provider === 'probe-rs') {
      p.build.artifact = path.join(root, 'build', 'firmware.elf');
      await writeFile(p.build.artifact, 'exact firmware');
    }
    const hash = await sha256File(p.build.artifact);
    const { adapters } = harness();
    const ready = await adapters.flash[provider].preflight(p, { artifactSha256: hash });
    const descriptor = adapters.flash[provider].plan(p, ready);
    assert.equal(descriptor.executable, '/trusted/labwired-agent');
    assert.equal(descriptor.shell, false);
    assert.deepEqual(descriptor.args, ['probe', 'flash', p.build.artifact, '--provider', provider, '--chip', 'esp32c3', '--target', 'probe', '--probe', 'probe-123', '--port', '/dev/ttyACM0', '--expected-sha256', hash, '--environment', 'release', '--workspace', root]);
    assert.throws(() => adapters.flash[provider].plan(p, {}), /capability/);
  });
});

test('flash revalidates the exact artifact before and after execution and redacts evidence', async () => {
  const root = await sandbox();
  const p = profile(root);
  const hash = await sha256File(p.build.artifact);
  const bundle = await evidence(root, p);
  const receipt = { provider: 'platformio', artifactSha256: hash, chip: p.target.chip, environment: p.build.environment, workspace: p.build.workspace, probeSerial: p.target.probeSerial, observationPort: p.target.serialPort, identityApplied: true, serialPortApplied: true };
  const { adapters } = harness(async () => ({ classification: 'exit', exitCode: 0, stdout: `secret-value\nLABWIRED_FLASH_RECEIPT ${JSON.stringify(receipt)}\n`, stderr: 'secret-value', truncated: { stdout: false, stderr: false } }));
  const result = await adapters.flash.platformio.execute(p, { artifactSha256: hash, evidenceDir: bundle, redact: ['secret-value'] });
  assert.equal(result.level, 'hardware_observed');
  assert.equal(result.artifactSha256, hash);
  assert.equal(JSON.stringify(result).includes('secret-value'), false);
  assert.equal((await readFile(path.join(bundle, result.rawEvidenceRefs[0]), 'utf8')).includes('secret-value'), false);
});

test('flash refuses a success exit with a missing or mismatched exact receipt', async (t) => {
  const root = await sandbox(); const p = profile(root); const hash = await sha256File(p.build.artifact);
  const base = { provider: 'platformio', artifactSha256: hash, chip: p.target.chip, environment: p.build.environment, workspace: p.build.workspace, probeSerial: p.target.probeSerial, observationPort: p.target.serialPort, identityApplied: true, serialPortApplied: true };
  for (const [name, stdout] of [
    ['missing', 'claim: flashed'],
    ['wrong chip', `LABWIRED_FLASH_RECEIPT ${JSON.stringify({ ...base, chip: 'wrong-chip' })}`],
    ['wrong environment', `LABWIRED_FLASH_RECEIPT ${JSON.stringify({ ...base, environment: 'other' })}`],
    ['wrong workspace', `LABWIRED_FLASH_RECEIPT ${JSON.stringify({ ...base, workspace: `${p.build.workspace}-other` })}`],
    ['identity unused', `LABWIRED_FLASH_RECEIPT ${JSON.stringify({ ...base, identityApplied: false })}`],
    ['port unused', `LABWIRED_FLASH_RECEIPT ${JSON.stringify({ ...base, serialPortApplied: false })}`],
  ]) await t.test(name, async () => {
    const { adapters } = harness(async () => ({ classification: 'exit', exitCode: 0, stdout, stderr: '', truncated: { stdout: false, stderr: false } }));
    const result = await adapters.flash.platformio.execute(p, { artifactSha256: hash });
    assert.equal(result.level, 'failed'); assert.match(result.diagnostics, /receipt/);
  });
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

test('default launcher decodes spaced module paths and all physical adapters inherit the Windows ps1', async () => {
  const simulatedModule = pathToFileURL(path.join('/tmp', 'Program Files', 'LabWired', 'lib', 'hardware', 'adapters.mjs'));
  const decoded = resolveAgentLauncher({ platform: 'win32', moduleUrl: simulatedModule });
  assert.equal(decoded.includes('%20'), false); assert.match(decoded, /Program Files/); assert.match(decoded, /labwired-agent\.ps1$/);
  const root = await sandbox(); const p = profile(root); const hash = await sha256File(p.build.artifact);
  const { adapters, calls } = harness(undefined, { agentPath: undefined, platform: 'win32' });
  const flashReady = await adapters.flash.platformio.preflight(p, { artifactSha256: hash });
  const serial = { id: 'serial', provider: 'serial', contains: 'ok', requiredLevel: 'hardware_observed' };
  const rtt = { id: 'rtt', provider: 'rtt', contains: 'ok', requiredLevel: 'hardware_observed' };
  const plans = [
    adapters.flash.platformio.plan(p, flashReady),
    adapters.observation.serial.plan(p, serial, await adapters.observation.serial.preflight(p, serial)),
    adapters.observation.rtt.plan(p, rtt, await adapters.observation.rtt.preflight(p, rtt)),
  ];
  for (const descriptor of plans) {
    assert.match(descriptor.executable, /labwired-agent\.ps1$/);
    const resolved = resolveLaunch(descriptor, { platform: 'win32', pathEnv: 'C:\\Windows\\System32' });
    assert.deepEqual(resolved.args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
    assert.equal(resolved.args[5], descriptor.executable);
  }
  const network = { id: 'network', provider: 'network', deviceMarker: 'READY', hostProbeUrlFromMarker: 'IP', hostProbePath: '/', requiredLevel: 'hardware_observed' };
  await adapters.observation.network.execute(p, network);
  assert.match(calls[0].descriptor.executable, /labwired-agent\.ps1$/);
  assert.throws(() => resolveAgentLauncher({ platform: 'win32', override: 'relative-agent.ps1' }), /absolute/);
  assert.throws(() => resolveAgentLauncher({ platform: 'win32', override: 'C:\\LabWired\\agent.cmd' }), /command shim/);
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
  // A physical profile boots the target from inside the capture, after the port
  // is open — otherwise a banner printed once at boot is emitted to nobody and
  // read back as "marker was not observed".
  assert.deepEqual(adapters.observation.serial.plan(p, serial, serialReady).args, [
    'serial-capture', '/dev/ttyACM0', '115200', 'alive', '7',
    '--reset-chip', 'esp32c3', '--reset-probe', 'probe-123',
  ]);
  // No flash stage means nothing of ours put firmware there, so nothing of ours
  // resets it either: the flags must be absent, not merely harmless.
  const observeOnly = { ...p, flash: undefined };
  const observeOnlyReady = await adapters.observation.serial.preflight(observeOnly, serial);
  assert.deepEqual(adapters.observation.serial.plan(observeOnly, serial, observeOnlyReady).args, [
    'serial-capture', '/dev/ttyACM0', '115200', 'alive', '7',
  ]);
  const rttReady = await adapters.observation.rtt.preflight(p, rtt);
  assert.deepEqual(adapters.observation.rtt.plan(p, rtt, rttReady).args, ['probe', 'rtt-capture', '--chip', 'esp32c3', '--probe', 'probe-123', '--elf', p.build.artifact, '--marker', 'ready', '--timeout', '8']);
  assert.throws(() => adapters.observation.rtt.plan(p, rtt, serialReady), /capability/);
});

test('logic CSV proves real transitions and frequency independently of serial text', async () => {
  const root = await sandbox();
  const p = profile(root);
  const observation = trustedLogic({ frequencyMinHz: 0.9, frequencyMaxHz: 1.1 });
  const bundle = await evidence(root, p);
  const { adapters, calls } = captureHarness('time,CH0\n0,0\n0.5,1\n1,0\n1.5,1\n');
  const hash = await sha256File(p.build.artifact);
  const result = await adapters.observation['logic-csv'].execute(p, observation, { evidenceDir: bundle, flashedArtifactSha256: hash, serialCapture: 'LED ON\nLED OFF' });
  assert.equal(result.level, 'hardware_observed');
  assert.equal(result.transitions, 3);
  assert.equal(result.frequencyHz, 1);
  assert.deepEqual(calls[0].descriptor.args.slice(0, 10), ['--driver', 'saleae-logic16:conn=analyzer-1', '--channels', 'D0', '--config', 'samplerate=1000', '--samples', '2000', '--output-format', 'csv']);
  assert.equal(calls[0].descriptor.env.API_TOKEN, undefined); assert.equal(calls[0].descriptor.env.NODE_OPTIONS, undefined);
  assert.equal(calls[0].descriptor.env.PATH, '/trusted');
  assert.deepEqual(result.rawEvidenceRefs, ['observations/led.csv', 'observations/led.json']);
  const rawLogic = await readFile(path.join(bundle, result.rawEvidenceRefs[0]), 'utf8');
  assert.match(rawLogic, /0\.5,1/);
  const logicSummary = JSON.parse(await readFile(path.join(bundle, result.rawEvidenceRefs[1]), 'utf8'));
  assert.equal(logicSummary.captureSha256, createHash('sha256').update(rawLogic).digest('hex'));
});

test('validated profile frequency bounds flow unchanged into the logic adapter', async () => {
  const root = await sandbox();
  const normalized = validateHardwareProfile({
    schema: 1,
    target: { id: 'desk', chip: 'esp32c3', probeSerial: 'probe-1', serialPort: '/dev/ttyACM0' },
    build: { provider: 'platformio', workspace: '.', environment: 'release', artifact: 'build/firmware.bin' },
    observations: [trustedLogic({ valueColumn: 'v', edgeCountAtLeast: 2, frequencyMinHz: 0.9, frequencyMaxHz: 1.1 })],
  }, path.join(root, 'hardware.json'));
  const hash = await sha256File(normalized.build.artifact);
  const result = await captureHarness('time,v\n0,0\n0.5,1\n1,0\n').adapters.observation['logic-csv'].execute(normalized, normalized.observations[0], { flashedArtifactSha256: hash });
  assert.equal(result.level, 'hardware_observed'); assert.equal(result.frequencyHz, 1);
});

test('trusted logic capture refuses missing output, forged capability, and instrument mutation', async () => {
  const root = await sandbox(); const p = profile(root); const hash = await sha256File(p.build.artifact);
  const observation = trustedLogic({ edgeCountAtLeast: 1 });
  const absent = await harness().adapters.observation['logic-csv'].execute(p, observation, { flashedArtifactSha256: hash });
  assert.equal(absent.level, 'failed'); assert.match(absent.diagnostics, /did not create|absent/);
  const { adapters } = captureHarness('time,CH0\n0,0\n1,1\n');
  assert.throws(() => adapters.observation['logic-csv'].plan(p, observation, {}, {}), /capability/);
  const prepared = await adapters.observation['logic-csv'].preflight(p, observation);
  const changed = { ...observation, instrumentId: 'analyzer-2' };
  const result = await adapters.observation['logic-csv'].execute(p, changed, { prepared, flashedArtifactSha256: hash });
  assert.equal(result.level, 'failed'); assert.match(result.diagnostics, /capability|inputs changed/);
});

test('trusted logic capture preserves timeout and cancellation failure boundaries', async (t) => {
  for (const classification of ['timeout', 'cancelled']) await t.test(classification, async () => {
    const root = await sandbox(); const p = profile(root); const hash = await sha256File(p.build.artifact);
    const result = await harness(async () => ({ classification, exitCode: null, stdout: '', stderr: '', truncated: {} })).adapters.observation['logic-csv'].execute(p, trustedLogic(), { flashedArtifactSha256: hash });
    assert.equal(result.level, 'failed'); assert.match(result.diagnostics, new RegExp(classification));
  });
});

test('physical raw evidence rejects symlink roots/directories and publication swaps', async (t) => {
  for (const scenario of ['symlink-root', 'symlink-directory', 'swap-root', 'swap-directory']) await t.test(scenario, async () => {
    const root = await sandbox(); const p = profile(root); const bundle = await evidence(root, p);
    const external = await mkdtemp(path.join(os.tmpdir(), 'labwired-evidence-external-')); roots.add(external);
    await writeFile(path.join(external, 'sentinel'), 'untouched');
    const original = `${bundle}-original`;
    if (scenario === 'symlink-root') { await rename(bundle, original); await symlink(external, bundle); }
    if (scenario === 'symlink-directory') { await rm(path.join(bundle, 'observations'), { recursive: true }); await symlink(external, path.join(bundle, 'observations')); }
    const hooks = scenario === 'swap-root' ? { async beforePublish() { await rename(bundle, original); await symlink(external, bundle); } }
      : scenario === 'swap-directory' ? { async beforePublish() { await rename(path.join(bundle, 'observations'), path.join(bundle, 'observations-original')); await symlink(external, path.join(bundle, 'observations')); } }
        : undefined;
    const observation = trustedLogic({ timeColumn: 't', valueColumn: 'v', edgeCountAtLeast: 1 });
    const hash = await sha256File(p.build.artifact);
    const result = await captureHarness('t,v\n0,0\n1,1\n', { physicalEvidenceHooks: hooks }).adapters.observation['logic-csv'].execute(p, observation, { evidenceDir: bundle, flashedArtifactSha256: hash });
    assert.equal(result.level, 'failed');
    assert.equal(await readFile(path.join(external, 'sentinel'), 'utf8'), 'untouched');
    await assert.rejects(readFile(path.join(external, 'led.csv')), /ENOENT/);
  });
});

test('logic CSV rejects static, malformed, non-monotonic, symlinked, and raced captures', async (t) => {
  for (const [name, body, pattern] of [
    ['static', 'time,v\n0,1\n1,1\n', /transitions/],
    ['malformed', 'time,v\nwat,1\n', /finite/],
    ['nonmonotonic', 'time,v\n1,0\n0,1\n', /monotonic/],
    ['digital', 'time,v\n0,0\n1,2\n', /digital/],
  ]) await t.test(name, async () => {
    const root = await sandbox();
    const obs = trustedLogic({ timeColumn: 'time', valueColumn: 'v', edgeCountAtLeast: 1 });
    const result = await captureHarness(body).adapters.observation['logic-csv'].execute(profile(root), obs);
    assert.equal(result.level, 'failed'); assert.match(result.diagnostics, pattern);
  });
  await t.test('checked-in replay stays untrusted and provider is not invoked', async () => {
    const root = await sandbox(); const file = path.join(root, 'led-pass.csv');
    await writeFile(file, 'time,v\n0,0\n1,1\n'); let invoked = false;
    const obs = { id: 'led', provider: 'logic-csv', file, channel: 0, timeColumn: 'time', valueColumn: 'v', edgeCountAtLeast: 1, requiredLevel: 'untrusted_observation' };
    const result = await harness(async () => { invoked = true; }).adapters.observation['logic-csv'].execute(profile(root), obs);
    assert.equal(result.level, 'untrusted_observation'); assert.equal(invoked, false);
  });
  await t.test('invalid frequency bound', async () => {
    const root = await sandbox();
    const obs = trustedLogic({ timeColumn: 'time', valueColumn: 'v', edgeCountAtLeast: 1, frequencyMinHz: Number.NaN });
    const result = await captureHarness('time,v\n0,0\n1,1\n').adapters.observation['logic-csv'].execute(profile(root), obs);
    assert.equal(result.level, 'failed'); assert.match(result.diagnostics, /frequency bound/);
  });
  await t.test('mutation race', async () => {
    const root = await sandbox();
    const obs = trustedLogic({ timeColumn: 'time', valueColumn: 'v', edgeCountAtLeast: 1 });
    const { adapters } = captureHarness('time,v\n0,0\n1,1\n', { snapshotHooks: { async duringRead({ file: readPath }) { if (readPath.endsWith('capture.csv')) await writeFile(readPath, 'time,v\n0,0\n2,1\n'); } } });
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
    const { adapters, calls } = harness(async (descriptor) => {
      assert.equal(descriptor.args[0], 'serial-challenge');
      return { classification: 'exit', exitCode: 0, stdout: `WIFI_CONNECTED nonce=${nonce} DEVICE_IP=127.0.0.1:${port}\n`, stderr: '', truncated: { stdout: false, stderr: false } };
    }, { randomBytes: () => Buffer.from(nonce, 'hex') });
    const result = await adapters.observation.network.execute(p, observation, { evidenceDir: bundle, flashedArtifactSha256: hash });
    assert.equal(result.level, 'hardware_observed');
    assert.equal(result.nonce, nonce);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].descriptor.args.slice(0, 4), ['serial-challenge', '/dev/ttyACM0', '115200', nonce]);
    assert.deepEqual(result.rawEvidenceRefs, ['observations/wifi-device.txt', 'observations/wifi-host.txt', 'observations/wifi.json']);
    const rawDevice = await readFile(path.join(bundle, result.rawEvidenceRefs[0]), 'utf8');
    const rawHost = await readFile(path.join(bundle, result.rawEvidenceRefs[1]), 'utf8');
    const summary = JSON.parse(await readFile(path.join(bundle, result.rawEvidenceRefs[2]), 'utf8'));
    assert.match(rawDevice, new RegExp(nonce));
    assert.equal(summary.deviceCaptureSha256, createHash('sha256').update(rawDevice).digest('hex'));
    assert.equal(summary.hostResponseSha256, createHash('sha256').update(rawHost).digest('hex'));
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('network cannot accept a preconstructed marker without a successful trusted challenge', async () => {
  const nonce = '0123456789abcdef0123456789abcdef'; const root = await sandbox(); const p = profile(root);
  const observation = { id: 'wifi', provider: 'network', deviceMarker: 'WIFI_CONNECTED', hostProbeUrlFromMarker: 'DEVICE_IP', hostProbePath: '/health', requiredLevel: 'hardware_observed' };
  const { adapters } = harness(async () => ({ classification: 'exit', exitCode: 1, stdout: '', stderr: 'challenge failed', truncated: { stdout: false, stderr: false } }), { randomBytes: () => Buffer.from(nonce, 'hex') });
  const result = await adapters.observation.network.execute(p, observation, { deviceCapture: `WIFI_CONNECTED nonce=${nonce} DEVICE_IP=127.0.0.1` });
  assert.equal(result.level, 'failed'); assert.match(result.diagnostics, /challenge/);
});

test('network rejects wrong nonce, public addresses, redirects, and oversized responses', async (t) => {
  const nonce = '0123456789abcdef0123456789abcdef';
  const observation = { id: 'wifi', provider: 'network', deviceMarker: 'WIFI_CONNECTED', hostProbeUrlFromMarker: 'DEVICE_IP', hostProbePath: '/health', requiredLevel: 'hardware_observed' };
  const root = await sandbox(); const p = profile(root);
  let adapter = harness(async () => ({ classification: 'exit', exitCode: 0, stdout: 'WIFI_CONNECTED nonce=wrong DEVICE_IP=127.0.0.1', stderr: '', truncated: {} }), { randomBytes: () => Buffer.from(nonce, 'hex') }).adapters.observation.network;
  assert.equal((await adapter.execute(p, observation)).level, 'failed');
  adapter = harness(async () => ({ classification: 'exit', exitCode: 0, stdout: `WIFI_CONNECTED nonce=${nonce} DEVICE_IP=8.8.8.8`, stderr: '', truncated: {} }), { randomBytes: () => Buffer.from(nonce, 'hex') }).adapters.observation.network;
  assert.equal((await adapter.execute(p, observation)).level, 'failed');
  for (const [name, handler, pattern] of [
    ['redirect', (_q, r) => { r.writeHead(302, { location: '/health' }); r.end(); }, /redirect/],
    ['unauthorized', (_q, r) => { r.writeHead(401); r.end(nonce); }, /status 401/],
    ['not found', (_q, r) => { r.writeHead(404); r.end(nonce); }, /status 404/],
    ['server error', (_q, r) => { r.writeHead(500); r.end(nonce); }, /status 500/],
    ['oversize', (_q, r) => r.end('x'.repeat(70_000)), /size/],
  ]) await t.test(name, async () => {
    const server = createServer(handler); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const challengeAdapter = harness(async () => ({ classification: 'exit', exitCode: 0, stdout: `WIFI_CONNECTED nonce=${nonce} DEVICE_IP=127.0.0.1:${server.address().port}`, stderr: '', truncated: {} }), { randomBytes: () => Buffer.from(nonce, 'hex') }).adapters.observation.network;
      const result = await challengeAdapter.execute(p, observation);
      assert.equal(result.level, 'failed'); assert.match(result.diagnostics, pattern);
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });
});

test('RTT plan binds the exact probe selector end to end', async () => {
  const root = await sandbox(); const p = profile(root, 'probe-rs');
  p.build.artifact = path.join(root, 'build', 'firmware.elf'); await writeFile(p.build.artifact, 'elf');
  const observation = { id: 'rtt', provider: 'rtt', contains: 'ready', timeoutSeconds: 4, requiredLevel: 'hardware_observed' };
  const { adapters } = harness(); const ready = await adapters.observation.rtt.preflight(p, observation);
  assert.deepEqual(adapters.observation.rtt.plan(p, observation, ready).args, ['probe', 'rtt-capture', '--chip', p.target.chip, '--probe', p.target.probeSerial, '--elf', p.build.artifact, '--marker', 'ready', '--timeout', '4']);
});
