import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createEvidenceBundle,
  levelSatisfies,
  redactDeep,
  sha256File,
  verifyEvidenceBundle,
} from '../lib/hardware/evidence.mjs';

const profile = {
  target: { id: 'desk-c3', chip: 'esp32c3', probeSerial: 'probe-1', serialPort: '/dev/ttyUSB0' },
  observations: [
    { id: 'led', provider: 'logic-csv', requiredLevel: 'hardware_observed' },
    { id: 'wifi', provider: 'network', requiredLevel: 'hardware_observed' },
  ],
};

async function temporaryDirectory() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'labwired-evidence-'));
  return path.join(parent, 'bundle');
}

function verifiedResult(level, behaviorId, overrides = {}) {
  const artifactSha256 = 'a'.repeat(64);
  const startedAt = new Date(Date.now() - 1_000).toISOString();
  const endedAt = new Date().toISOString();
  const result = {
    behaviorId,
    provider: profile.observations.find(({ id }) => id === behaviorId)?.provider ?? 'serial',
    level,
    artifactSha256,
    targetIdentity: { ...profile.target },
    startedAt,
    endedAt,
    toolVersion: 'fixture-tool 1.0.0',
    rawEvidenceRefs: [`captures/${behaviorId}.txt`],
    diagnostics: { message: 'verified' },
  };
  if (level === 'model_observed') result.nativeArtifactSha256 = artifactSha256;
  if (level === 'surrogate_model_observed') {
    result.surrogateArtifactSha256 = 'b'.repeat(64);
    result.sharedSourcePaths = ['src/main.cpp'];
  }
  if (level === 'hardware_observed') result.flashedArtifactSha256 = artifactSha256;
  return { ...result, ...overrides };
}

async function createReadyEvidence(directory, selectedProfile = profile, options = { redactValues: [] }) {
  const evidence = await createEvidenceBundle(directory, selectedProfile, options);
  await mkdir(path.join(directory, 'captures'), { recursive: true });
  for (const { id } of selectedProfile.observations) {
    await writeFile(path.join(directory, 'captures', `${id}.txt`), `capture for ${id}\n`);
  }
  return evidence;
}

test('initialization persists complete fail-first behavior records before returning', async () => {
  const directory = await temporaryDirectory();
  await createEvidenceBundle(directory, profile, { redactValues: [] });

  const summary = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'));
  assert.equal(summary.result, 'FAIL');
  assert.deepEqual(summary.reasons.map(({ behaviorId }) => behaviorId), ['led', 'wifi']);
  for (const observation of profile.observations) {
    const record = JSON.parse(await readFile(path.join(directory, 'observations', observation.id, 'result.json'), 'utf8'));
    assert.equal(record.behaviorId, observation.id);
    assert.equal(record.requiredLevel, observation.requiredLevel);
    assert.equal(record.level, 'not-run');
  }
});

test('run stages are fail-first, receipt-bound, and policy-neutral to behavior PASS', async () => {
  const directory = await temporaryDirectory();
  const evidence = await createReadyEvidence(directory, profile, { stages: [{ id: 'twin', provider: 'labwired-sim' }] });
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'stages', 'twin', 'result.json'), 'utf8')), { stageId: 'twin', provider: 'labwired-sim', level: 'not-run' });
  await writeFile(path.join(directory, 'observations', 'twin-failure.json'), '{"unsupported":true}\n');
  const now = new Date().toISOString();
  await evidence.recordStage('twin', { stageId: 'twin', provider: 'labwired-sim', level: 'failed', rawEvidenceRefs: ['observations/twin-failure.json'], diagnostics: 'unsupported', startedAt: now, endedAt: now });
  for (const observation of profile.observations) await evidence.recordBehavior(observation.id, verifiedResult('hardware_observed', observation.id));
  const receipt = await evidence.finalize();
  assert.equal(receipt.result, 'PASS');
  assert.equal((await verifyEvidenceBundle(directory, { expectedManifestSha256: receipt.manifestSha256 })).valid, true);
  await writeFile(path.join(directory, 'observations', 'twin-failure.json'), '{"unsupported":false}\n');
  assert.equal((await verifyEvidenceBundle(directory, { expectedManifestSha256: receipt.manifestSha256 })).valid, false);
});

test('a rejected record leaves the fail-first bundle intact', async () => {
  const directory = await temporaryDirectory();
  const evidence = await createReadyEvidence(directory);
  await assert.rejects(evidence.recordBehavior('unknown', { level: 'hardware_observed' }), /unknown behavior/);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8')).result, 'FAIL');
  assert.equal(JSON.parse(await readFile(path.join(directory, 'observations/led/result.json'), 'utf8')).level, 'not-run');
});

test('atomic replacement never exposes truncated JSON or leftover temporary files', async () => {
  const directory = await temporaryDirectory();
  const evidence = await createReadyEvidence(directory);
  const target = path.join(directory, 'observations/led/result.json');
  const readers = Array.from({ length: 40 }, async (_, index) => {
    await evidence.recordBehavior('led', {
      ...verifiedResult('hardware_observed', 'led'),
      diagnostics: `record-${index}-${'x'.repeat(index * 79)}`,
    });
    JSON.parse(await readFile(target, 'utf8'));
  });
  await Promise.all(readers);
  JSON.parse(await readFile(target, 'utf8'));
  assert.deepEqual((await readdir(path.dirname(target))).filter((name) => name.includes('.tmp-')), []);
});

test('redactDeep removes configured values from nested keys, values, arrays, and errors', () => {
  const secret = 'super-secret-value';
  const error = new Error(`failure ${secret}`);
  error.context = { [`key-${secret}`]: [`prefix-${secret}-suffix`] };
  const redacted = redactDeep({ [`outer-${secret}`]: { error } }, [secret]);
  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes(secret), false);
  assert.match(serialized, /\[REDACTED\]/);
  assert.equal(redacted[`outer-[REDACTED]`].error.name, 'Error');
});

test('behavior persistence redacts secrets before writing them', async () => {
  const directory = await temporaryDirectory();
  const evidence = await createEvidenceBundle(directory, profile, { redactValues: ['wireless-password'] });
  await evidence.recordBehavior('led', {
    behaviorId: 'led',
    provider: 'logic-csv',
    level: 'failed',
    rawEvidenceRefs: [],
    diagnostics: { message: 'bad wireless-password', 'wireless-password-key': 'wireless-password' },
  });
  assert.equal((await readFile(path.join(directory, 'observations/led/result.json'), 'utf8')).includes('wireless-password'), false);
});

test('fail-first records are redacted during initialization', async () => {
  const directory = await temporaryDirectory();
  const initialProfile = {
    ...profile,
    observations: [{ id: 'led', provider: 'logic-private-value', requiredLevel: 'hardware_observed' }],
  };
  await createEvidenceBundle(directory, initialProfile, { redactValues: ['private-value'] });
  const persisted = await readFile(path.join(directory, 'observations/led/result.json'), 'utf8');
  assert.equal(persisted.includes('private-value'), false);
  assert.match(persisted, /logic-\[REDACTED\]/);
});

test('sha256File hashes the exact artifact bytes', async () => {
  const directory = await temporaryDirectory();
  await mkdir(directory);
  const artifact = path.join(directory, 'firmware.bin');
  const bytes = Buffer.from([0, 1, 2, 3, 255, 128, 64]);
  await writeFile(artifact, bytes);
  assert.equal(await sha256File(artifact), createHash('sha256').update(bytes).digest('hex'));
});

test('level satisfaction uses an explicit non-ordinal evidence lattice', () => {
  assert.equal(levelSatisfies('compiled', 'compiled'), true);
  assert.equal(levelSatisfies('model_observed', 'compiled'), true);
  assert.equal(levelSatisfies('hardware_observed', 'model_observed'), true);
  assert.equal(levelSatisfies('surrogate_model_observed', 'surrogate_model_observed'), true);
  assert.equal(levelSatisfies('model_observed', 'surrogate_model_observed'), true);
  assert.equal(levelSatisfies('surrogate_model_observed', 'model_observed'), false);
  assert.equal(levelSatisfies('compiled', 'model_observed'), false);
  for (const required of ['compiled', 'model_observed', 'surrogate_model_observed', 'hardware_observed']) {
    assert.equal(levelSatisfies('untrusted_observation', required), false);
    assert.equal(levelSatisfies('blocked', required), false);
    assert.equal(levelSatisfies('failed', required), false);
    assert.equal(levelSatisfies('not-run', required), false);
  }
});

test('evidence stays behavior-bound and incomplete observations finalize FAIL with reasons', async () => {
  const directory = await temporaryDirectory();
  const evidence = await createReadyEvidence(directory);
  await assert.rejects(
    evidence.recordBehavior('led', verifiedResult('hardware_observed', 'wifi')),
    /does not match/,
  );
  await evidence.recordBehavior('led', verifiedResult('hardware_observed', 'led'));
  const summary = await evidence.finalize();
  assert.equal(summary.result, 'FAIL');
  assert.deepEqual(summary.reasons.map(({ behaviorId }) => behaviorId), ['wifi']);
});

test('finalize passes only when every behavior meets its declared level', async () => {
  const directory = await temporaryDirectory();
  const evidence = await createReadyEvidence(directory);
  await evidence.recordBehavior('led', verifiedResult('hardware_observed', 'led'));
  await evidence.recordBehavior('wifi', verifiedResult('hardware_observed', 'wifi'));
  const finalized = await evidence.finalize();
  assert.equal(finalized.result, 'PASS');
  assert.deepEqual(finalized.reasons, []);
  assert.match(finalized.manifestSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8')), { result: 'PASS', reasons: [] });
});

test('compiled evidence preserves compiled-only semantics', async () => {
  const directory = await temporaryDirectory();
  const compiledProfile = {
    ...profile,
    observations: [{ id: 'firmware', provider: 'serial', requiredLevel: 'model_observed' }],
  };
  const evidence = await createReadyEvidence(directory, compiledProfile);
  await evidence.recordBehavior('firmware', verifiedResult('compiled', 'firmware', {
    provider: 'serial',
    claim: 'compiled_only',
  }));
  const summary = await evidence.finalize();
  assert.equal(summary.result, 'FAIL');
  assert.equal(summary.reasons[0].actualLevel, 'compiled');
});

test('finalize freezes the bundle so a persisted PASS cannot become stale', async () => {
  const directory = await temporaryDirectory();
  const evidence = await createReadyEvidence(directory);
  await evidence.recordBehavior('led', verifiedResult('hardware_observed', 'led'));
  await evidence.recordBehavior('wifi', verifiedResult('hardware_observed', 'wifi'));
  await evidence.finalize();
  await assert.rejects(evidence.recordBehavior('led', { level: 'failed' }), /finalized/);
  await assert.rejects(evidence.finalize(), /finalized/);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8')).result, 'PASS');
});

test('verified evidence rejects absent, malformed, and mismatched provenance', async () => {
  const cases = [
    [{ level: 'hardware_observed' }, /provider/],
    [verifiedResult('hardware_observed', 'led', { behaviorId: undefined }), /behaviorId/],
    [verifiedResult('hardware_observed', 'led', { provider: 'network' }), /provider/],
    [verifiedResult('hardware_observed', 'led', { artifactSha256: 'nope' }), /artifactSha256/],
    [verifiedResult('hardware_observed', 'led', { targetIdentity: { id: 'other-target' } }), /target identity/],
    [verifiedResult('hardware_observed', 'led', { startedAt: 'invalid' }), /startedAt/],
    [verifiedResult('hardware_observed', 'led', { endedAt: '2026-08-14T09:59:59.000Z' }), /precedes/],
    [verifiedResult('hardware_observed', 'led', { toolVersion: '' }), /toolVersion/],
    [verifiedResult('hardware_observed', 'led', { rawEvidenceRefs: ['../escape.txt'] }), /rawEvidenceRefs/],
    [verifiedResult('hardware_observed', 'led', { rawEvidenceRefs: Array(33).fill('capture.txt') }), /rawEvidenceRefs/],
    [verifiedResult('hardware_observed', 'led', { diagnostics: 'x'.repeat(65_537) }), /diagnostics/],
    [verifiedResult('hardware_observed', 'led', { flashedArtifactSha256: 'b'.repeat(64) }), /flashedArtifactSha256/],
  ];
  for (const [candidate, pattern] of cases) {
    const directory = await temporaryDirectory();
    const evidence = await createReadyEvidence(directory);
    await assert.rejects(evidence.recordBehavior('led', candidate), pattern, `candidate should reject: ${pattern}`);
    assert.equal(JSON.parse(await readFile(path.join(directory, 'observations/led/result.json'), 'utf8')).level, 'not-run');
  }
});

test('model and surrogate claims require artifact-specific provenance', async () => {
  const modelProfile = { ...profile, observations: [{ id: 'led', provider: 'logic-csv', requiredLevel: 'model_observed' }] };
  let directory = await temporaryDirectory();
  let evidence = await createReadyEvidence(directory, modelProfile);
  await assert.rejects(
    evidence.recordBehavior('led', verifiedResult('model_observed', 'led', { nativeArtifactSha256: 'b'.repeat(64) })),
    /nativeArtifactSha256/,
  );

  directory = await temporaryDirectory();
  evidence = await createReadyEvidence(directory, modelProfile);
  const surrogate = verifiedResult('surrogate_model_observed', 'led');
  delete surrogate.sharedSourcePaths;
  await assert.rejects(evidence.recordBehavior('led', surrogate), /sharedSourcePaths/);

  directory = await temporaryDirectory();
  evidence = await createReadyEvidence(directory, modelProfile);
  await assert.rejects(evidence.recordBehavior('led', verifiedResult('surrogate_model_observed', 'led', {
    surrogateArtifactSha256: 'a'.repeat(64),
  })), /must differ/);
});

test('verified SHA-256 fields are accepted case-insensitively and persisted lowercase', async () => {
  const directory = await temporaryDirectory();
  const evidence = await createReadyEvidence(directory);
  const uppercase = 'A'.repeat(64);
  const record = await evidence.recordBehavior('led', verifiedResult('hardware_observed', 'led', {
    artifactSha256: uppercase,
    flashedArtifactSha256: uppercase,
  }));
  assert.equal(record.artifactSha256, 'a'.repeat(64));
  assert.equal(record.flashedArtifactSha256, 'a'.repeat(64));
});

test('whole-bundle staging failure never exposes a partial target', async () => {
  const directory = await temporaryDirectory();
  const brokenProfile = {
    ...profile,
    observations: [...profile.observations, { id: 'broken\u0000id', provider: 'serial', requiredLevel: 'compiled' }],
  };
  await assert.rejects(createEvidenceBundle(directory, brokenProfile, { redactValues: [] }));
  await assert.rejects(access(directory));
  const leftovers = (await readdir(path.dirname(directory))).filter((name) => name.includes('.staging-'));
  assert.deepEqual(leftovers, []);
});

test('simultaneous creators produce exactly one owner and one complete bundle', async () => {
  const directory = await temporaryDirectory();
  const results = await Promise.allSettled([
    createEvidenceBundle(directory, profile, { redactValues: [] }),
    createEvidenceBundle(directory, profile, { redactValues: [] }),
  ]);
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(results.filter(({ status }) => status === 'rejected').length, 1);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8')).result, 'FAIL');
  for (const { id } of profile.observations) {
    assert.equal(JSON.parse(await readFile(path.join(directory, 'observations', id, 'result.json'), 'utf8')).level, 'not-run');
  }
  await access(path.join(directory, '.owner.json'));
});

test('a preexisting target bundle is never reused by another handle', async () => {
  const directory = await temporaryDirectory();
  await createEvidenceBundle(directory, profile, { redactValues: [] });
  await assert.rejects(createEvidenceBundle(directory, profile, { redactValues: [] }), /already exists/);
});

test('rejects unsafe behavior IDs before creating any bundle path', async () => {
  for (const id of ['../escape', '/absolute', 'nested/child', 'nested\\child', '.', '..', '%2e%2e']) {
    const directory = await temporaryDirectory();
    const unsafeProfile = { ...profile, observations: [{ ...profile.observations[0], id }] };
    await assert.rejects(createEvidenceBundle(directory, unsafeProfile, { redactValues: [] }), /behavior ID|portable/);
    await assert.rejects(access(directory));
  }
});

test('rejects a renamed bundle root replaced by an external symlink before writing', async () => {
  const directory = await temporaryDirectory();
  const evidence = await createReadyEvidence(directory);
  const original = `${directory}.original`;
  const external = await mkdtemp(path.join(os.tmpdir(), 'labwired-external-'));
  const sentinel = path.join(external, 'sentinel.txt');
  await writeFile(sentinel, 'untouched');
  await rename(directory, original);
  await symlink(external, directory, process.platform === 'win32' ? 'junction' : 'dir');

  await assert.rejects(evidence.recordBehavior('led', {
    behaviorId: 'led', provider: 'logic-csv', level: 'failed', rawEvidenceRefs: [], diagnostics: {},
  }), /ownership|symlink|replaced/);
  assert.equal(await readFile(sentinel, 'utf8'), 'untouched');
});

test('rejects a behavior directory replaced by an external symlink before writing', async () => {
  const directory = await temporaryDirectory();
  const evidence = await createReadyEvidence(directory);
  const behaviorDirectory = path.join(directory, 'observations', 'led');
  const external = await mkdtemp(path.join(os.tmpdir(), 'labwired-external-'));
  const sentinel = path.join(external, 'sentinel.txt');
  await writeFile(sentinel, 'untouched');
  await rm(behaviorDirectory, { recursive: true });
  await symlink(external, behaviorDirectory, process.platform === 'win32' ? 'junction' : 'dir');

  await assert.rejects(evidence.recordBehavior('led', {
    behaviorId: 'led', provider: 'logic-csv', level: 'failed', rawEvidenceRefs: [], diagnostics: {},
  }), /ownership|symlink|replaced/);
  assert.equal(await readFile(sentinel, 'utf8'), 'untouched');
});

test('failed and untrusted records share binding, redaction, and bounds validation', async () => {
  let directory = await temporaryDirectory();
  let evidence = await createReadyEvidence(directory);
  await assert.rejects(evidence.recordBehavior('led', {
    behaviorId: 'led', provider: 'logic-csv', level: 'failed', rawEvidenceRefs: ['../outside'], diagnostics: {},
  }), /rawEvidenceRefs/);

  directory = await temporaryDirectory();
  evidence = await createReadyEvidence(directory);
  await assert.rejects(evidence.recordBehavior('led', {
    behaviorId: 'led', provider: 'logic-csv', level: 'failed', rawEvidenceRefs: [], diagnostics: 'x'.repeat(65_537),
  }), /diagnostics/);

  const untrustedProfile = {
    ...profile,
    observations: [{ id: 'led', provider: 'logic-csv', requiredLevel: 'untrusted_observation' }],
  };
  directory = await temporaryDirectory();
  evidence = await createReadyEvidence(directory, untrustedProfile);
  await assert.rejects(evidence.recordBehavior('led', verifiedResult('untrusted_observation', 'led', {
    rawEvidenceRefs: ['../outside'],
  })), /rawEvidenceRefs/);
  await assert.rejects(evidence.recordBehavior('led', verifiedResult('untrusted_observation', 'led', {
    diagnostics: 'x'.repeat(65_537),
  })), /diagnostics/);
  await assert.rejects(evidence.recordBehavior('led', {
    behaviorId: 'led', provider: 'logic-csv', level: 'not-run', rawEvidenceRefs: [], diagnostics: {},
  }), /not-run/);
});

test('satisfying claims require real contained non-symlink evidence files and sane times', async () => {
  let directory = await temporaryDirectory();
  let evidence = await createReadyEvidence(directory);
  await assert.rejects(evidence.recordBehavior('led', verifiedResult('hardware_observed', 'led', {
    rawEvidenceRefs: ['captures/missing.txt'],
  })), /does not exist/);

  directory = await temporaryDirectory();
  evidence = await createReadyEvidence(directory);
  const external = path.join(path.dirname(directory), 'external.txt');
  await writeFile(external, 'external');
  await symlink(external, path.join(directory, 'captures', 'linked.txt'));
  await assert.rejects(evidence.recordBehavior('led', verifiedResult('hardware_observed', 'led', {
    rawEvidenceRefs: ['captures/linked.txt'],
  })), /symlink/);

  directory = await temporaryDirectory();
  evidence = await createReadyEvidence(directory);
  await assert.rejects(evidence.recordBehavior('led', verifiedResult('hardware_observed', 'led', {
    startedAt: '9999-01-01T00:00:00.000Z',
    endedAt: '9999-01-01T00:00:01.000Z',
  })), /run window|future/);
});

test('finalize rehashes evidence so mutated captures cannot produce stale PASS', async () => {
  const directory = await temporaryDirectory();
  const evidence = await createReadyEvidence(directory);
  const led = await evidence.recordBehavior('led', verifiedResult('hardware_observed', 'led'));
  await evidence.recordBehavior('wifi', verifiedResult('hardware_observed', 'wifi'));
  assert.equal(led.rawEvidence[0].size > 0, true);
  assert.match(led.rawEvidence[0].sha256, /^[0-9a-f]{64}$/);
  await writeFile(path.join(directory, 'captures', 'led.txt'), 'tampered\n');
  await assert.rejects(evidence.finalize(), /changed|hash/);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8')).result, 'FAIL');
});

test('control and mutable bundle files can never serve as raw behavioral evidence', async () => {
  const cases = [
    'result.json',
    '.owner.json',
    'observations/led/result.json',
    'captures/.result.json.tmp-fixture',
    'captures/session.lock',
  ];
  for (const reference of cases) {
    const directory = await temporaryDirectory();
    const evidence = await createReadyEvidence(directory);
    if (reference.startsWith('captures/')) {
      await writeFile(path.join(directory, reference), 'control file\n');
    }
    await assert.rejects(evidence.recordBehavior('led', verifiedResult('hardware_observed', 'led', {
      rawEvidenceRefs: [reference],
    })), /control|mutable|raw evidence path/);
    assert.equal(JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8')).result, 'FAIL');
  }

  const directory = await temporaryDirectory();
  const modelProfile = { ...profile, observations: [{ id: 'led', provider: 'logic-csv', requiredLevel: 'model_observed' }] };
  const evidence = await createReadyEvidence(directory, modelProfile);
  await assert.rejects(evidence.recordBehavior('led', verifiedResult('model_observed', 'led', {
    rawEvidenceRefs: ['result.json'],
  })), /control|mutable|raw evidence path/);
  assert.equal((await evidence.finalize()).result, 'FAIL');
});

test('a legitimate contained capture remains acceptable raw evidence', async () => {
  const directory = await temporaryDirectory();
  const evidence = await createReadyEvidence(directory);
  const record = await evidence.recordBehavior('led', verifiedResult('hardware_observed', 'led'));
  assert.equal(record.rawEvidence[0].path, 'captures/led.txt');
  assert.match(record.rawEvidence[0].sha256, /^[0-9a-f]{64}$/);
});

test('raw evidence paths reject Windows aliases and non-portable components on every host', async () => {
  const aliases = [
    'result.json.',
    'result.json ',
    '.owner.json.',
    'captures/RESULT.JSON',
    'observations/led/RESULT.JSON',
    'captures/led.txt:secret-stream',
    'captures/CON',
    'captures/PRN.txt',
    'captures/AUX.log',
    'captures/NUL.bin',
    'captures/COM1.txt',
    'captures/com9.data',
    'captures/LPT1.csv',
    'captures/lpt9.bin',
    'captures//led.txt',
    'captures\\led.txt',
    'captures/./led.txt',
  ];
  for (const reference of aliases) {
    const directory = await temporaryDirectory();
    const evidence = await createReadyEvidence(directory);
    await assert.rejects(evidence.recordBehavior('led', verifiedResult('hardware_observed', 'led', {
      rawEvidenceRefs: [reference],
    })), /portable|control|mutable|raw evidence path/);
    assert.equal(JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8')).result, 'FAIL');
  }
});

test('behavior IDs use portable component rules and portable uniqueness before filesystem work', async () => {
  for (const id of ['CON', 'con.txt', 'PRN.log', 'NUL.bin', 'COM1.data', 'lpt9.csv', 'led.', 'led ', 'led:stream', 'led\\child', 'léd']) {
    const directory = await temporaryDirectory();
    const invalidProfile = { ...profile, observations: [{ ...profile.observations[0], id }] };
    await assert.rejects(createEvidenceBundle(directory, invalidProfile, { redactValues: [] }), /portable|reserved|behavior ID/);
    await assert.rejects(access(directory));
  }

  const directory = await temporaryDirectory();
  const collidingProfile = {
    ...profile,
    observations: [
      { ...profile.observations[0], id: 'LED' },
      { ...profile.observations[1], id: 'led' },
    ],
  };
  await assert.rejects(createEvidenceBundle(directory, collidingProfile, { redactValues: [] }), /portable identity|duplicate/);
  await assert.rejects(access(directory));
});

test('verifyEvidenceBundle independently validates a persisted PASS', async () => {
  const directory = await temporaryDirectory();
  const evidence = await createReadyEvidence(directory);
  await evidence.recordBehavior('led', verifiedResult('hardware_observed', 'led'));
  await evidence.recordBehavior('wifi', verifiedResult('hardware_observed', 'wifi'));
  const receipt = await evidence.finalize();

  const unverified = await verifyEvidenceBundle(directory);
  assert.equal(unverified.valid, false);
  assert.equal(unverified.result, 'FAIL');
  assert.equal(unverified.authenticity, 'unverified');
  assert.equal(unverified.structuralResult, 'PASS');
  assert.equal(unverified.manifestSha256, receipt.manifestSha256);

  const verified = await verifyEvidenceBundle(directory, { expectedManifestSha256: receipt.manifestSha256 });
  assert.deepEqual(verified, {
    valid: true,
    result: 'PASS',
    authenticity: 'verified',
    manifestSha256: receipt.manifestSha256,
    reasons: [],
  });
});

test('verifyEvidenceBundle downgrades capture, record, owner, and root mutations to invalid FAIL', async () => {
  async function finalizedBundle() {
    const directory = await temporaryDirectory();
    const evidence = await createReadyEvidence(directory);
    await evidence.recordBehavior('led', verifiedResult('hardware_observed', 'led'));
    await evidence.recordBehavior('wifi', verifiedResult('hardware_observed', 'wifi'));
    await evidence.finalize();
    return directory;
  }

  let directory = await finalizedBundle();
  await writeFile(path.join(directory, 'captures', 'led.txt'), 'tampered capture\n');
  let verified = await verifyEvidenceBundle(directory);
  assert.equal(verified.valid, false);
  assert.equal(verified.result, 'FAIL');

  directory = await finalizedBundle();
  const recordPath = path.join(directory, 'observations', 'led', 'result.json');
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  await writeFile(recordPath, `${JSON.stringify({ ...record, level: 'failed' })}\n`);
  verified = await verifyEvidenceBundle(directory);
  assert.equal(verified.valid, false);
  assert.equal(verified.result, 'FAIL');

  directory = await finalizedBundle();
  const ownerPath = path.join(directory, '.owner.json');
  const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
  await writeFile(ownerPath, `${JSON.stringify({ ...owner, owner: 'replaced' })}\n`);
  verified = await verifyEvidenceBundle(directory);
  assert.equal(verified.valid, false);
  assert.equal(verified.result, 'FAIL');

  directory = await finalizedBundle();
  const original = `${directory}.original`;
  await rename(directory, original);
  await symlink(original, directory, process.platform === 'win32' ? 'junction' : 'dir');
  verified = await verifyEvidenceBundle(directory);
  assert.equal(verified.valid, false);
  assert.equal(verified.result, 'FAIL');
});

test('verifyEvidenceBundle rejects a zero-stage root symlink without touching its target', async () => {
  const directory = await temporaryDirectory();
  const evidence = await createReadyEvidence(directory);
  const receipt = await evidence.finalize();
  const external = await mkdtemp(path.join(os.tmpdir(), 'labwired-external-'));
  const sentinel = path.join(external, 'sentinel.txt');
  await writeFile(sentinel, 'untouched');
  await rm(path.join(directory, 'stages'), { recursive: true });
  await symlink(external, path.join(directory, 'stages'), process.platform === 'win32' ? 'junction' : 'dir');

  for (const options of [{}, { expectedManifestSha256: receipt.manifestSha256 }]) {
    const verified = await verifyEvidenceBundle(directory, options);
    assert.equal(verified.valid, false);
    assert.equal(verified.result, 'FAIL');
    assert.match(verified.reasons[0].message, /stage.*real directory|symlink|escape/i);
  }
  assert.equal(await readFile(sentinel, 'utf8'), 'untouched');
});

test('verifyEvidenceBundle rejects a populated stage root replacement without touching its target', async () => {
  const directory = await temporaryDirectory();
  const evidence = await createReadyEvidence(directory, profile, { stages: [{ id: 'flash', provider: 'openocd' }] });
  const receipt = await evidence.finalize();
  const external = await mkdtemp(path.join(os.tmpdir(), 'labwired-external-'));
  const sentinel = path.join(external, 'sentinel.txt');
  await writeFile(sentinel, 'untouched');
  await rm(path.join(directory, 'stages'), { recursive: true });
  await symlink(external, path.join(directory, 'stages'), process.platform === 'win32' ? 'junction' : 'dir');

  for (const options of [{}, { expectedManifestSha256: receipt.manifestSha256 }]) {
    const verified = await verifyEvidenceBundle(directory, options);
    assert.equal(verified.valid, false);
    assert.equal(verified.result, 'FAIL');
    assert.match(verified.reasons[0].message, /stage.*real directory|symlink|escape/i);
  }
  assert.equal(await readFile(sentinel, 'utf8'), 'untouched');
});

test('typed persistence rejects unknown top-level and nested caller fields', async () => {
  let directory = await temporaryDirectory();
  let evidence = await createReadyEvidence(directory);
  await assert.rejects(evidence.recordBehavior('led', {
    ...verifiedResult('hardware_observed', 'led'),
    padding: 'x'.repeat(1_000),
  }), /unknown.*padding|allowed key/);

  directory = await temporaryDirectory();
  evidence = await createReadyEvidence(directory);
  await assert.rejects(evidence.recordBehavior('led', verifiedResult('hardware_observed', 'led', {
    targetIdentity: { ...profile.target, nestedPadding: { value: 'x' } },
  })), /target identity.*unknown|nestedPadding/);

  directory = await temporaryDirectory();
  evidence = await createReadyEvidence(directory);
  await assert.rejects(evidence.recordBehavior('led', {
    behaviorId: 'led',
    provider: 'logic-csv',
    level: 'failed',
    rawEvidenceRefs: [],
    diagnostics: {},
    nestedExtras: { padding: 'x' },
  }), /unknown.*nestedExtras|allowed key/);

  directory = await temporaryDirectory();
  evidence = await createReadyEvidence(directory);
  await assert.rejects(evidence.recordBehavior('led', verifiedResult('hardware_observed', 'led', {
    toolVersion: `fixture-${'x'.repeat(150_000)}`,
  })), /size limit/);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'observations', 'led', 'result.json'), 'utf8')).level, 'not-run');
});

test('verifyEvidenceBundle bounds record and control JSON before parsing', async () => {
  async function finalizedBundle() {
    const directory = await temporaryDirectory();
    const evidence = await createReadyEvidence(directory);
    await evidence.recordBehavior('led', verifiedResult('hardware_observed', 'led'));
    await evidence.recordBehavior('wifi', verifiedResult('hardware_observed', 'wifi'));
    await evidence.finalize();
    return directory;
  }

  let directory = await finalizedBundle();
  await writeFile(path.join(directory, 'observations', 'led', 'result.json'), `{"padding":"${'x'.repeat(200_000)}"}`);
  let verified = await verifyEvidenceBundle(directory);
  assert.equal(verified.valid, false);
  assert.match(verified.reasons[0].message, /size|large|limit/);

  directory = await finalizedBundle();
  await writeFile(path.join(directory, '.owner.json'), `{"padding":"${'x'.repeat(400_000)}"}`);
  verified = await verifyEvidenceBundle(directory);
  assert.equal(verified.valid, false);
  assert.match(verified.reasons[0].message, /size|large|limit/);

  directory = await finalizedBundle();
  await writeFile(path.join(directory, 'result.json'), `{"padding":"${'x'.repeat(400_000)}"}`);
  verified = await verifyEvidenceBundle(directory);
  assert.equal(verified.valid, false);
  assert.match(verified.reasons[0].message, /size|large|limit/);
});

test('external receipt detects a coherent capture and record rewrite', async () => {
  const directory = await temporaryDirectory();
  const evidence = await createReadyEvidence(directory);
  await evidence.recordBehavior('led', verifiedResult('hardware_observed', 'led'));
  await evidence.recordBehavior('wifi', verifiedResult('hardware_observed', 'wifi'));
  const receipt = await evidence.finalize();

  const capturePath = path.join(directory, 'captures', 'led.txt');
  const rewritten = Buffer.from('coherently rewritten capture\n');
  await writeFile(capturePath, rewritten);
  const recordPath = path.join(directory, 'observations', 'led', 'result.json');
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  record.rawEvidence[0] = {
    ...record.rawEvidence[0],
    sha256: await sha256File(capturePath),
    size: rewritten.length,
  };
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);

  const structural = await verifyEvidenceBundle(directory);
  assert.equal(structural.authenticity, 'unverified');
  assert.equal(structural.structuralResult, 'PASS');
  assert.notEqual(structural.manifestSha256, receipt.manifestSha256);
  const verified = await verifyEvidenceBundle(directory, { expectedManifestSha256: receipt.manifestSha256 });
  assert.equal(verified.valid, false);
  assert.equal(verified.result, 'FAIL');
  assert.equal(verified.authenticity, 'unverified');
  assert.match(verified.reasons[0].message, /receipt|manifest/i);
});
