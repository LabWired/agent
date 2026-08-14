import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { executeHardwareRun, planHardwareRun } from '../lib/hardware/runner.mjs';
import { verifyEvidenceBundle } from '../lib/hardware/evidence.mjs';

const roots = [];
test.after(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'labwired-runner-'));
  roots.push(root);
  await mkdir(path.join(root, '.labwired'));
  const profilePath = path.join(root, '.labwired', 'hardware.json');
  const profile = {
    schema: 1,
    target: { id: 'desk-c3', chip: 'esp32c3', probeSerial: 'probe-123', serialPort: '/dev/ttyACM0' },
    build: { provider: 'platformio', workspace: root, environment: 'release', artifact: path.join(root, 'firmware.bin') },
    twin: { provider: 'labwired-sim', system: path.join(root, 'system.json'), artifactRelation: 'exact' },
    flash: { provider: 'platformio' },
    observations: [
      { id: 'heartbeat', provider: 'serial', contains: 'alive', requiredLevel: 'hardware_observed' },
      { id: 'led', provider: 'logic-csv', file: path.join(root, 'logic.csv'), channel: 0, timeColumn: 't', valueColumn: 'v', edgeCountAtLeast: 1, requiredLevel: 'hardware_observed' },
    ],
    ...overrides,
  };
  await writeFile(profilePath, `${JSON.stringify(profile)}\n`);
  await writeFile(path.join(root, 'system.json'), '{}');
  await writeFile(path.join(root, 'logic.csv'), 't,v\n0,0\n1,1\n');
  return { root, profilePath, evidenceDir: path.join(root, 'evidence'), profile };
}

function result(level, extra = {}) { return { level, ...extra }; }

function harness(profile, behavior = {}) {
  const calls = [];
  let artifactSha256 = 'a'.repeat(64);
  const adapters = {
    build: { platformio: {
      async preflight() { calls.push('preflight:build'); return { toolVersion: 'pio 6' }; },
      async execute(_profile, options) {
        calls.push('build'); behavior.onSignal?.(options.signal);
        if (behavior.realEvidence) {
          await writeFile(path.join(options.evidenceDir, 'observations', 'build.json'), '{"compiled":true}\n');
          const now = new Date().toISOString();
          return result('compiled', { artifactSha256, targetIdentity: profile.target, startedAt: now, endedAt: now, toolVersion: 'pio 6', rawEvidenceRefs: ['observations/build.json'] });
        }
        return behavior.build ?? result('compiled', { artifactSha256 });
      },
    } },
    twin: { 'labwired-sim': {
      async preflight() { calls.push('preflight:twin'); return { toolVersion: 'sim 1' }; },
      async execute() { calls.push('twin'); return behavior.twin ?? result('model_observed', { artifactSha256, rawEvidenceRefs: ['twin/result.json'] }); },
    } },
    flash: { platformio: {
      async preflight(_profile, options) { calls.push('preflight:flash'); assert.equal(options.artifactSha256, artifactSha256); return { provider: 'platformio' }; },
      async execute() { calls.push('flash'); return behavior.flash ?? result('hardware_observed', { artifactSha256, flashedArtifactSha256: artifactSha256, rawEvidenceRefs: ['flash.json'] }); },
    } },
    observation: Object.fromEntries(['serial', 'logic-csv'].map((provider) => [provider, {
      async preflight(_profile, observation) { calls.push(`preflight:${observation.id}`); return { provider }; },
      async execute(_profile, observation) { calls.push(`observe:${observation.id}`); return behavior.observations?.[observation.id] ?? result('hardware_observed', { artifactSha256, flashedArtifactSha256: artifactSha256, rawEvidenceRefs: [`observations/${observation.id}.json`] }); },
    }])),
  };
  const records = new Map();
  const dependencies = {
    async loadProfile() { calls.push('load'); return structuredClone(profile); },
    createAdapters() { calls.push('adapters'); return adapters; },
    async resolveHardwareIdentities() {
      calls.push('resolve');
      return behavior.identities?.shift?.() ?? { target: profile.target.id, probe: profile.target.probeSerial, serial: profile.target.serialPort };
    },
    async acquireLocks(identities, options) {
      calls.push('locks');
      assert.deepEqual(identities, { target: 'desk-c3', probe: 'probe-123', serial: '/dev/ttyACM0' });
      behavior.lockSignal = options.signal;
      return { async release() { calls.push('release'); if (behavior.releaseError) throw new Error('release broke'); } };
    },
    async createEvidence(_dir, p) {
      calls.push('evidence');
      for (const observation of p.observations) records.set(observation.id, result('not-run'));
      return {
        async recordBehavior(id, value) { calls.push(`record:${id}:${value.level}`); records.set(id, value); },
        async finalize() {
          calls.push('finalize');
          const pass = p.observations.every((observation) => records.get(observation.id)?.level === observation.requiredLevel);
          return { result: pass ? 'PASS' : 'FAIL', manifestSha256: createHash('sha256').update(JSON.stringify([...records])).digest('hex') };
        },
      };
    },
    lockRoot: '/safe/locks',
  };
  return { dependencies, calls, records, setArtifactSha256(value) { artifactSha256 = value; } };
}

test('planning is read-only, stable, canonical, and secret-free', async () => {
  const f = await fixture();
  const h = harness(f.profile);
  const before = await readdir(f.root, { recursive: true });
  const first = await planHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, dependencies: h.dependencies });
  const second = await planHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, dependencies: h.dependencies });
  assert.match(first.digest, /^[a-f0-9]{64}$/);
  assert.equal(first.digest, second.digest);
  assert.deepEqual(first.plan, second.plan);
  assert.equal(JSON.stringify(first).includes('super-secret'), false);
  assert.deepEqual(await readdir(f.root, { recursive: true }), before);
  assert.equal(h.calls.includes('evidence'), false);
  assert.equal(h.calls.includes('locks'), false);
  assert.equal(h.calls.includes('build'), false);
});

test('missing, malformed, or wrong confirmation refuses before evidence, locks, or mutation', async (t) => {
  for (const digest of [undefined, 'bad', '0'.repeat(64)]) await t.test(String(digest), async () => {
    const f = await fixture(); const h = harness(f.profile);
    await assert.rejects(executeHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, confirmDigest: digest, dependencies: h.dependencies }), /confirmation digest/i);
    assert.equal(h.calls.includes('evidence'), false); assert.equal(h.calls.includes('locks'), false); assert.equal(h.calls.includes('build'), false);
  });
});

test('ambiguous or drifting identities fail closed', async (t) => {
  await t.test('ambiguous at planning', async () => {
    const f = await fixture(); const h = harness(f.profile, { identities: [{ target: 'desk-c3', probe: 'first', serial: '/dev/ttyACM0' }] });
    await assert.rejects(planHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, dependencies: h.dependencies }), /ambiguous|explicit/i);
  });
  await t.test('drift after flash', async () => {
    const f = await fixture(); const h = harness(f.profile, { identities: [
      { target: 'desk-c3', probe: 'probe-123', serial: '/dev/ttyACM0' },
      { target: 'desk-c3', probe: 'probe-123', serial: '/dev/ttyACM0' },
      { target: 'desk-c3', probe: 'probe-123', serial: '/dev/ttyUSB9' },
    ] });
    const planned = await planHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, dependencies: h.dependencies });
    const outcome = await executeHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, confirmDigest: planned.digest, dependencies: h.dependencies });
    assert.equal(outcome.receipt.result, 'FAIL'); assert.equal(h.calls.some((call) => call.startsWith('observe:')), false); assert.ok(h.calls.indexOf('release') < h.calls.indexOf('finalize'));
  });
});

test('build failure prevents twin and flash while preserving a FAIL receipt', async () => {
  const f = await fixture(); const h = harness(f.profile, { build: result('failed', { diagnostics: 'compile failed' }) });
  const planned = await planHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, dependencies: h.dependencies });
  const outcome = await executeHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, confirmDigest: planned.digest, dependencies: h.dependencies });
  assert.equal(outcome.receipt.result, 'FAIL'); assert.equal(h.calls.includes('flash'), false); assert.equal(h.calls.includes('twin'), false); assert.ok(h.calls.indexOf('release') < h.calls.indexOf('finalize'));
});

test('execution supplies an absolute user-scoped lock root by default', async () => {
  const f = await fixture(); const h = harness(f.profile, { build: result('failed') });
  delete h.dependencies.lockRoot;
  let suppliedRoot;
  h.dependencies.acquireLocks = async (_identities, options) => {
    suppliedRoot = options.root;
    return { async release() {} };
  };
  const p = await planHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, dependencies: h.dependencies });
  await executeHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, confirmDigest: p.digest, dependencies: h.dependencies });
  assert.equal(path.isAbsolute(suppliedRoot), true);
  assert.equal(suppliedRoot.startsWith(f.root), false);
});

test('approved plan continues past twin failure, flash failure blocks physical observations', async (t) => {
  await t.test('twin', async () => {
    const f = await fixture(); const h = harness(f.profile, { twin: result('failed') });
    const p = await planHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, dependencies: h.dependencies });
    assert.equal(p.plan.policy.continueAfterTwinFailure, true);
    const outcome = await executeHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, confirmDigest: p.digest, dependencies: h.dependencies });
    assert.equal(h.calls.includes('flash'), true); assert.equal(outcome.receipt.result, 'PASS');
  });
  await t.test('flash', async () => {
    const f = await fixture(); const h = harness(f.profile, { flash: result('failed') });
    const p = await planHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, dependencies: h.dependencies });
    const outcome = await executeHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, confirmDigest: p.digest, dependencies: h.dependencies });
    assert.equal(outcome.receipt.result, 'FAIL'); assert.equal(h.calls.some((call) => call.startsWith('observe:')), false);
    assert.equal([...h.records.values()].every((record) => record.level === 'blocked'), true);
  });
});

test('independent observations continue and full success returns external authenticated receipt', async () => {
  const f = await fixture(); const h = harness(f.profile, { observations: { heartbeat: result('failed'), led: result('hardware_observed', { artifactSha256: 'a'.repeat(64), flashedArtifactSha256: 'a'.repeat(64), rawEvidenceRefs: ['observations/led.json'] }) } });
  const p = await planHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, dependencies: h.dependencies });
  const failed = await executeHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, confirmDigest: p.digest, dependencies: h.dependencies });
  assert.equal(failed.receipt.result, 'FAIL'); assert.equal(h.calls.includes('observe:led'), true); assert.match(failed.receipt.manifestSha256, /^[a-f0-9]{64}$/);

  const f2 = await fixture(); const h2 = harness(f2.profile); const p2 = await planHardwareRun({ profilePath: f2.profilePath, evidenceDir: f2.evidenceDir, dependencies: h2.dependencies });
  const passed = await executeHardwareRun({ profilePath: f2.profilePath, evidenceDir: f2.evidenceDir, confirmDigest: p2.digest, dependencies: h2.dependencies });
  assert.equal(passed.receipt.result, 'PASS'); assert.equal(passed.receiptDigest, passed.receipt.manifestSha256); assert.equal(passed.plan.digest, p2.digest);
});

test('a build-only compiled requirement produces a verifiable real PASS bundle', async () => {
  const observations = [{ id: 'firmware', provider: 'serial', contains: 'unused', requiredLevel: 'compiled' }];
  const f = await fixture({ twin: undefined, flash: undefined, observations });
  const h = harness(f.profile, { realEvidence: true });
  delete h.dependencies.createEvidence;
  h.dependencies.createEvidence = undefined;
  const dependencies = {
    ...h.dependencies,
    async createEvidence(...args) {
      const { createEvidenceBundle } = await import('../lib/hardware/evidence.mjs');
      return createEvidenceBundle(...args);
    },
  };
  const p = await planHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, dependencies });
  const outcome = await executeHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, confirmDigest: p.digest, dependencies });
  assert.equal(outcome.receipt.result, 'PASS');
  const verified = await verifyEvidenceBundle(f.evidenceDir, { expectedManifestSha256: outcome.receiptDigest });
  assert.equal(verified.valid, true, JSON.stringify(verified));
});

test('cancellation reaches adapters, finalizes FAIL, and releases locks; cleanup errors fail closed', async (t) => {
  await t.test('abort', async () => {
    const f = await fixture(); const controller = new AbortController();
    const h = harness(f.profile, { onSignal(signal) { assert.equal(signal, controller.signal); controller.abort(); }, build: result('failed', { diagnostics: 'cancelled' }) });
    const p = await planHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, dependencies: h.dependencies });
    const outcome = await executeHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, confirmDigest: p.digest, dependencies: h.dependencies, signal: controller.signal });
    assert.equal(outcome.receipt.result, 'FAIL'); assert.equal(h.calls.includes('finalize'), true); assert.ok(h.calls.indexOf('release') < h.calls.indexOf('finalize'));
  });
  await t.test('release failure', async () => {
    const f = await fixture(); const h = harness(f.profile, { releaseError: true });
    const p = await planHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, dependencies: h.dependencies });
    const outcome = await executeHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, confirmDigest: p.digest, dependencies: h.dependencies });
    assert.equal(outcome.receipt.result, 'FAIL'); assert.match(outcome.error, /release broke/); assert.equal(h.calls.includes('finalize'), true);
  });
});
