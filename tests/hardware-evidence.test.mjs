import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createEvidenceBundle,
  levelSatisfies,
  redactDeep,
  sha256File,
} from '../lib/hardware/evidence.mjs';

const profile = {
  target: { id: 'desk-c3', chip: 'esp32c3', probeSerial: 'probe-1', serialPort: '/dev/ttyUSB0' },
  observations: [
    { id: 'led', provider: 'logic-csv', requiredLevel: 'hardware_observed' },
    { id: 'wifi', provider: 'network', requiredLevel: 'hardware_observed' },
  ],
};

async function temporaryDirectory() {
  return mkdtemp(path.join(os.tmpdir(), 'labwired-evidence-'));
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

test('a rejected record leaves the fail-first bundle intact', async () => {
  const directory = await temporaryDirectory();
  const evidence = await createEvidenceBundle(directory, profile, { redactValues: [] });
  await assert.rejects(evidence.recordBehavior('unknown', { level: 'hardware_observed' }), /unknown behavior/);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8')).result, 'FAIL');
  assert.equal(JSON.parse(await readFile(path.join(directory, 'observations/led/result.json'), 'utf8')).level, 'not-run');
});

test('atomic replacement never exposes truncated JSON or leftover temporary files', async () => {
  const directory = await temporaryDirectory();
  const evidence = await createEvidenceBundle(directory, profile, { redactValues: [] });
  const target = path.join(directory, 'observations/led/result.json');
  const readers = Array.from({ length: 40 }, async (_, index) => {
    await evidence.recordBehavior('led', {
      level: 'hardware_observed',
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
    level: 'failed',
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
  const evidence = await createEvidenceBundle(directory, profile, { redactValues: [] });
  await assert.rejects(
    evidence.recordBehavior('led', { behaviorId: 'wifi', level: 'hardware_observed' }),
    /does not match/,
  );
  await evidence.recordBehavior('led', { level: 'hardware_observed', artifactSha256: 'a'.repeat(64) });
  const summary = await evidence.finalize();
  assert.equal(summary.result, 'FAIL');
  assert.deepEqual(summary.reasons.map(({ behaviorId }) => behaviorId), ['wifi']);
});

test('finalize passes only when every behavior meets its declared level', async () => {
  const directory = await temporaryDirectory();
  const evidence = await createEvidenceBundle(directory, profile, { redactValues: [] });
  await evidence.recordBehavior('led', { level: 'hardware_observed' });
  await evidence.recordBehavior('wifi', { level: 'hardware_observed' });
  assert.deepEqual(await evidence.finalize(), { result: 'PASS', reasons: [] });
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8')), { result: 'PASS', reasons: [] });
});

test('compiled evidence preserves compiled-only semantics', async () => {
  const directory = await temporaryDirectory();
  const compiledProfile = {
    ...profile,
    observations: [{ id: 'firmware', provider: 'serial', requiredLevel: 'model_observed' }],
  };
  const evidence = await createEvidenceBundle(directory, compiledProfile, { redactValues: [] });
  await evidence.recordBehavior('firmware', { level: 'compiled', claim: 'compiled_only' });
  const summary = await evidence.finalize();
  assert.equal(summary.result, 'FAIL');
  assert.equal(summary.reasons[0].actualLevel, 'compiled');
});
