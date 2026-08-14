import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  TRUSTED_PROVIDERS,
  canonicalProfile,
  loadHardwareProfile,
  validateHardwareProfile,
} from '../lib/hardware/profile.mjs';

const fixturePath = path.resolve('fixtures/hardware-profiles/minimal.json');

async function withProfile(value, fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'labwired-hardware-profile-'));
  const profilePath = path.join(root, 'hardware.json');
  await writeFile(profilePath, JSON.stringify(value));
  try {
    return await fn({ root, profilePath });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function minimal(overrides = {}) {
  return {
    schema: 1,
    target: { id: 'twin-c3', chip: 'esp32c3' },
    build: {
      provider: 'platformio',
      workspace: '.',
      environment: 'native',
      artifact: 'build/firmware.elf',
    },
    twin: { provider: 'labwired-sim', system: 'systems/c3.json', artifactRelation: 'exact' },
    observations: [{
      id: 'heartbeat', provider: 'serial', contains: 'alive', timeoutSeconds: 12,
      requiredLevel: 'model_observed',
    }],
    ...overrides,
  };
}

test('loads and deeply freezes the minimal profile with trusted providers', async () => {
  const profile = await loadHardwareProfile(fixturePath, { realpath: true });

  assert.equal(profile.schema, 1);
  assert.equal(profile.build.provider, 'platformio');
  assert.equal(profile.twin.provider, 'labwired-sim');
  assert.equal(profile.observations[0].provider, 'serial');
  assert.equal(Object.isFrozen(profile), true);
  assert.equal(Object.isFrozen(profile.observations), true);
  assert.equal(Object.isFrozen(profile.observations[0]), true);
  assert.throws(() => { profile.build.provider = 'make'; }, TypeError);
  assert.deepEqual(TRUSTED_PROVIDERS, {
    build: ['platformio', 'make', 'cmake'],
    twin: ['labwired-sim'],
    flash: ['platformio', 'probe-rs'],
    observation: ['serial', 'rtt', 'logic-csv', 'network'],
  });
});

test('canonicalProfile is deterministic and redacts credential-shaped values', () => {
  const profile = minimal({ metadata: undefined });
  profile.observations[0].apiToken = 'never-return-this';

  const canonical = canonicalProfile(profile);

  assert.equal(JSON.stringify(canonical).includes('never-return-this'), false);
  assert.equal(canonical.observations[0].apiToken, '[REDACTED]');
  assert.equal(canonicalProfile({ note: 'token=never-return-this' }).note, '[REDACTED]');
  assert.equal(canonicalProfile({ note: 'sk-live-secret' }).note, '[REDACTED]');
  assert.equal(canonicalProfile({ endpoint: 'https://user:password@example.test' }).endpoint, '[REDACTED]');
  assert.equal(canonicalProfile({ note: 'Authorization: Bearer abc' }).note, '[REDACTED]');
  assert.equal(canonicalProfile({ note: 'Basic dXNlcjpwYXNz' }).note, '[REDACTED]');
  assert.deepEqual(canonical, canonicalProfile(profile));
});

test('requires exactly schema version 1 and explicit keys at every level', () => {
  assert.throws(() => validateHardwareProfile(minimal({ schema: 2 }), fixturePath), /schema.*1/i);
  assert.throws(() => validateHardwareProfile(minimal({ command: 'rm -rf /' }), fixturePath), /unknown.*command/i);
  assert.throws(() => validateHardwareProfile(minimal({ build: { ...minimal().build, shell: true } }), fixturePath), /unknown.*shell/i);
  assert.throws(() => validateHardwareProfile(minimal({
    observations: [{ ...minimal().observations[0], command: 'danger' }],
  }), fixturePath), /unknown.*command/i);
});

test('allows only trusted providers', () => {
  assert.throws(() => validateHardwareProfile(minimal({
    build: { ...minimal().build, provider: 'custom' },
  }), fixturePath), /provider.*custom/i);
  assert.throws(() => validateHardwareProfile(minimal({
    observations: [{ ...minimal().observations[0], provider: 'logic' }],
  }), fixturePath), /provider.*logic/i);
});

test('rejects inline credential values before they can enter a profile', () => {
  assert.throws(() => validateHardwareProfile(minimal({
    observations: [{ ...minimal().observations[0], token: 'not-allowed' }],
  }), fixturePath), /credential|secret|token|unknown/i);
  assert.throws(() => validateHardwareProfile(minimal({
    build: { ...minimal().build, environment: 'password=hunter2' },
  }), fixturePath), /inline credential/i);
  assert.throws(() => validateHardwareProfile(minimal({
    observations: [{ ...minimal().observations[0], contains: 'api_key=sk-test' }],
  }), fixturePath), /inline credential/i);
  assert.throws(() => validateHardwareProfile(minimal({
    build: { ...minimal().build, environment: 'https://user:password@example.test' },
  }), fixturePath), /inline credential/i);
  assert.throws(() => validateHardwareProfile(minimal({
    observations: [{ ...minimal().observations[0], contains: 'Authorization: Bearer abc' }],
  }), fixturePath), /inline credential/i);
  assert.throws(() => validateHardwareProfile(minimal({
    observations: [{ ...minimal().observations[0], contains: 'Bearer abc' }],
  }), fixturePath), /inline credential/i);
  assert.throws(() => validateHardwareProfile(minimal({
    observations: [{ ...minimal().observations[0], contains: 'Basic dXNlcjpwYXNz' }],
  }), fixturePath), /inline credential/i);
  assert.doesNotThrow(() => validateHardwareProfile(minimal({
    observations: [{ ...minimal().observations[0], contains: 'TOKEN_READY' }],
  }), fixturePath));
});

test('resolves workspace, artifact, and system paths under the workspace', async () => {
  await withProfile(minimal(), async ({ root, profilePath }) => {
    await mkdir(path.join(root, 'build'), { recursive: true });
    await mkdir(path.join(root, 'systems'), { recursive: true });
    await writeFile(path.join(root, 'systems', 'c3.json'), '{}');
    const profile = await loadHardwareProfile(profilePath, { realpath: true });
    const resolvedRoot = await realpath(root);

    assert.equal(profile.build.workspace, resolvedRoot);
    assert.equal(profile.build.artifact, path.join(resolvedRoot, 'build', 'firmware.elf'));
    assert.equal(profile.twin.system, path.join(resolvedRoot, 'systems', 'c3.json'));
  });
});

test('resolves logic CSV files under the workspace', async () => {
  const observation = {
    id: 'led', provider: 'logic-csv', file: 'captures/logic.csv', channel: 0,
    timeColumn: 'time', valueColumn: 'value', edgeCountAtLeast: 2,
    requiredLevel: 'hardware_observed',
  };
  await withProfile(minimal({
    target: { id: 'desk-c3', chip: 'esp32c3', probeSerial: 'probe-123', serialPort: '/dev/ttyACM0' },
    observations: [observation],
  }), async ({ root, profilePath }) => {
    const profile = await loadHardwareProfile(profilePath, { realpath: true });
    assert.equal(profile.observations[0].file, path.join(await realpath(root), 'captures', 'logic.csv'));
  });
});

test('normalizes and freezes optional positive logic frequency bounds', async () => {
  const value = minimal();
  value.observations = [{ id: 'led', provider: 'logic-csv', file: 'logic.csv', channel: 0, timeColumn: 'time', valueColumn: 'value', edgeCountAtLeast: 1, frequencyMinHz: 0.5, frequencyMaxHz: 2, requiredLevel: 'hardware_observed' }];
  value.target.probeSerial = 'probe-1'; value.target.serialPort = '/dev/ttyACM0';
  await withProfile(value, async ({ profilePath }) => {
    const normalized = validateHardwareProfile(value, profilePath);
    assert.equal(normalized.observations[0].frequencyMinHz, 0.5);
    assert.equal(normalized.observations[0].frequencyMaxHz, 2);
    assert.equal(Object.isFrozen(normalized.observations[0]), true);
    for (const [minimum, maximum] of [[0, 2], [Number.NaN, 2], [3, 2]]) {
      value.observations[0].frequencyMinHz = minimum; value.observations[0].frequencyMaxHz = maximum;
      assert.throws(() => validateHardwareProfile(value, profilePath), /frequency/);
    }
  });
});

test('rejects traversal and symlink escapes from the workspace', async () => {
  await withProfile(minimal({ build: { ...minimal().build, artifact: '../outside.elf' } }), async ({ profilePath }) => {
    await assert.rejects(loadHardwareProfile(profilePath, { realpath: true }), /escape|outside|contain/i);
  });

  await withProfile(minimal(), async ({ root, profilePath }) => {
    const outside = await mkdtemp(path.join(tmpdir(), 'labwired-hardware-outside-'));
    try {
      await symlink(outside, path.join(root, 'linked'));
      await writeFile(profilePath, JSON.stringify(minimal({
        build: { ...minimal().build, artifact: 'linked/firmware.elf' },
      })));
      await assert.rejects(loadHardwareProfile(profilePath, { realpath: true }), /escape|outside|contain|symlink/i);
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });

  await withProfile(minimal(), async ({ root, profilePath }) => {
    await mkdir(path.join(root, 'nested'), { recursive: true });
    await symlink(path.join(root, 'target-that-does-not-exist'), path.join(root, 'nested', 'dangling'));
    await writeFile(profilePath, JSON.stringify(minimal({
      build: { ...minimal().build, artifact: 'nested/dangling/firmware.elf' },
    })));
    await assert.rejects(loadHardwareProfile(profilePath, { realpath: true }), /dangling|symlink|reparse/i);
  });
});

test('requires unique safe observation IDs and bounded integer timeouts', () => {
  assert.throws(() => validateHardwareProfile(minimal({ observations: [
    minimal().observations[0], { ...minimal().observations[0] },
  ] }), fixturePath), /duplicate.*id/i);
  assert.throws(() => validateHardwareProfile(minimal({ observations: [{
    ...minimal().observations[0], id: '../heartbeat',
  }] }), fixturePath), /safe.*id/i);
  assert.throws(() => validateHardwareProfile(minimal({ observations: [{
    ...minimal().observations[0], timeoutSeconds: 1.5,
  }] }), fixturePath), /timeout.*integer/i);
  assert.throws(() => validateHardwareProfile(minimal({ observations: [{
    ...minimal().observations[0], timeoutSeconds: 3601,
  }] }), fixturePath), /timeout.*bound/i);
});

test('requires a physical profile to name the target, probe, and serial port', () => {
  assert.throws(() => validateHardwareProfile(minimal({
    target: { id: 'desk-c3', chip: 'esp32c3' },
    flash: { provider: 'probe-rs' },
  }), fixturePath), /probeSerial.*serialPort|physical.*identity/i);
  assert.doesNotThrow(() => validateHardwareProfile(minimal({
    target: {
      id: 'desk-c3', chip: 'esp32c3', probeSerial: 'probe-123', serialPort: '/dev/ttyACM0',
    },
    flash: { provider: 'probe-rs' },
  }), fixturePath));
  assert.throws(() => validateHardwareProfile(minimal({
    observations: [{ ...minimal().observations[0], requiredLevel: 'hardware_observed' }],
  }), fixturePath), /serialPort|physical.*identity/i);
  assert.throws(() => validateHardwareProfile(minimal({
    target: { id: 'desk-c3', chip: 'esp32c3', serialPort: '/dev/ttyACM0' },
    observations: [{
      id: 'rtt-marker', provider: 'rtt', contains: 'alive', timeoutSeconds: 12,
      requiredLevel: 'hardware_observed',
    }],
  }), fixturePath), /probeSerial|physical.*identity/i);
  assert.doesNotThrow(() => validateHardwareProfile(minimal({
    target: {
      id: 'desk-c3', chip: 'esp32c3', probeSerial: 'probe-123', serialPort: '/dev/ttyACM0',
    },
    observations: [{ ...minimal().observations[0], requiredLevel: 'hardware_observed' }],
  }), fixturePath));
  assert.throws(() => validateHardwareProfile(minimal({
    observations: [{
      id: 'led', provider: 'logic-csv', file: 'capture.csv', channel: 0,
      timeColumn: 'time', valueColumn: 'value', edgeCountAtLeast: 2,
      requiredLevel: 'hardware_observed',
    }],
  }), fixturePath), /probeSerial.*serialPort|physical.*identity/i);
  assert.throws(() => validateHardwareProfile(minimal({
    observations: [{
      id: 'wifi', provider: 'network', deviceMarker: 'WIFI_READY',
      hostProbeUrlFromMarker: 'DEVICE_IP', hostProbePath: '/health',
      requiredLevel: 'hardware_observed',
    }],
  }), fixturePath), /probeSerial.*serialPort|physical.*identity/i);
  for (const sentinel of ['auto', 'FIRST', 'Any', 'default']) {
    assert.throws(() => validateHardwareProfile(minimal({
      target: {
        id: sentinel, chip: 'esp32c3', probeSerial: 'probe-123', serialPort: '/dev/ttyACM0',
      },
      observations: [{ ...minimal().observations[0], requiredLevel: 'hardware_observed' }],
    }), fixturePath), /ambiguous.*identity/i);
  }
  for (const [field, value] of [['probeSerial', '   '], ['serialPort', '\t']]) {
    assert.throws(() => validateHardwareProfile(minimal({
      target: { id: 'desk-c3', chip: 'esp32c3', probeSerial: 'probe-123', serialPort: '/dev/ttyACM0', [field]: value },
      observations: [{ ...minimal().observations[0], requiredLevel: 'hardware_observed' }],
    }), fixturePath), /non-empty|identity/i);
  }
});

test('allows only the intentional load options', async () => {
  await assert.rejects(loadHardwareProfile(fixturePath, { shell: true }), /unknown.*shell/i);
  await assert.rejects(loadHardwareProfile(fixturePath, { unexpected: true }), /unknown.*unexpected/i);
});

test('fixture remains valid JSON and contains no inline secret values', async () => {
  const raw = await readFile(fixturePath, 'utf8');
  assert.equal(raw.includes('token'), false);
  assert.equal(raw.includes('password'), false);
  assert.equal(raw.includes('secret'), false);
  assert.equal(raw.includes('credential'), false);
});
