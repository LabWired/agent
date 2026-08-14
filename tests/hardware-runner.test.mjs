import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { executeHardwareRun, planHardwareRun } from '../lib/hardware/runner.mjs';
import { verifyEvidenceBundle } from '../lib/hardware/evidence.mjs';
import { createTrustedAdapters } from '../lib/hardware/adapters.mjs';

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
      async preflight() { calls.push('preflight:build'); return { kind: 'build-capability', executable: '/trusted/pio', toolVersion: behavior.toolVersion ?? 'pio 6' }; },
      async execute(_profile, options) {
        calls.push('build'); behavior.onSignal?.(options.signal);
        assert.equal(options.prepared?.kind, 'build-capability');
        if (behavior.realEvidence || behavior.realPhysical) {
          await writeFile(path.join(options.evidenceDir, 'observations', 'build.json'), '{"compiled":true}\n');
          const now = new Date().toISOString();
          return result('compiled', { artifactSha256, targetIdentity: profile.target, startedAt: now, endedAt: now, toolVersion: 'pio 6', rawEvidenceRefs: ['observations/build.json'] });
        }
        return behavior.build ?? result('compiled', { artifactSha256 });
      },
    } },
    twin: { 'labwired-sim': {
      async preflight() { calls.push('preflight:twin'); return { kind: 'twin-capability', executable: '/trusted/sim', toolVersion: 'sim 1' }; },
      async execute(_profile, options) {
        calls.push('twin'); behavior.onTwin?.(options.signal); assert.equal(options.prepared?.kind, 'twin-capability');
        if (behavior.realPhysical) {
          await writeFile(path.join(options.evidenceDir, 'observations', 'twin-failure.json'), '{"twin":"unsupported"}\n');
          return result('failed', { diagnostics: 'native format unsupported', rawEvidenceRefs: ['observations/twin-failure.json'] });
        }
        if (behavior.realEvidence) {
          await writeFile(path.join(options.evidenceDir, 'observations', 'twin.json'), '{"twin":"observed"}\n');
          return behavior.twin ?? result('model_observed', { artifactSha256, nativeArtifactSha256: artifactSha256, rawEvidenceRefs: ['observations/twin.json'] });
        }
        return behavior.twin ?? result('model_observed', { artifactSha256, nativeArtifactSha256: artifactSha256, rawEvidenceRefs: ['twin/result.json'] });
      },
    } },
    flash: { platformio: {
      async preflightPlan() { calls.push('preflight-plan:flash'); return { kind: 'flash-plan-capability', provider: 'platformio', executable: '/trusted/agent' }; },
      async preflight(_profile, options) { calls.push('preflight:flash'); assert.equal(options.artifactSha256, artifactSha256); assert.equal(options.planPrepared?.kind, 'flash-plan-capability'); return { kind: 'flash-capability', provider: 'platformio' }; },
      async execute(_profile, options) {
        calls.push('flash'); assert.equal(options.prepared?.kind, 'flash-capability');
        if (behavior.realPhysical) {
          await writeFile(path.join(options.evidenceDir, 'observations', 'flash.json'), '{"flash":"exact"}\n');
          return behavior.flash ?? result('hardware_observed', { artifactSha256, flashedArtifactSha256: artifactSha256, rawEvidenceRefs: ['observations/flash.json'] });
        }
        return behavior.flash ?? result('hardware_observed', { artifactSha256, flashedArtifactSha256: artifactSha256, rawEvidenceRefs: ['flash.json'] });
      },
    } },
    observation: Object.fromEntries(['serial', 'logic-csv'].map((provider) => [provider, {
      async preflight(_profile, observation) { calls.push(`preflight:${observation.id}`); return { kind: `observation-capability:${observation.id}`, provider }; },
      async execute(_profile, observation, options) {
        calls.push(`observe:${observation.id}`); behavior.onObservation?.(observation, options.signal); assert.equal(options.prepared?.kind, `observation-capability:${observation.id}`);
        if (behavior.realPhysical) {
          await writeFile(path.join(options.evidenceDir, 'observations', `${observation.id}.json`), `{"behavior":"${observation.id}"}\n`);
          return behavior.observations?.[observation.id] ?? result('hardware_observed', { artifactSha256, flashedArtifactSha256: artifactSha256, rawEvidenceRefs: [`observations/${observation.id}.json`] });
        }
        return behavior.observations?.[observation.id] ?? result('hardware_observed', { artifactSha256, flashedArtifactSha256: artifactSha256, rawEvidenceRefs: [`observations/${observation.id}.json`] });
      },
    }])),
  };
  const records = new Map();
  const dependencies = {
    async loadProfile() { calls.push('load'); return structuredClone(profile); },
    createAdapters() { calls.push('adapters'); return adapters; },
    async resolveHardwareIdentities() {
      calls.push('resolve');
      return behavior.identities?.shift?.() ?? [{ target: profile.target.id, probe: profile.target.probeSerial, serial: profile.target.serialPort, stableIds: { target: 'usb:target-1', probe: 'usb:probe-1', serial: 'usb:port-1' } }];
    },
    async acquireLocks(identities, options) {
      calls.push('locks');
      assert.deepEqual(identities, { target: 'usb:target-1', probe: 'usb:probe-1', serial: 'usb:port-1' });
      behavior.lockSignal = options.signal;
      return { async release() { calls.push('release'); if (behavior.releaseError) throw new Error('release broke'); } };
    },
    async createEvidence(_dir, p) {
      calls.push('evidence');
      for (const observation of p.observations) records.set(observation.id, result('not-run'));
      return {
        async recordStage(id, value) { calls.push(`stage:${id}:${value.level}`); },
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

test('planning redacts configured secrets from paths and capability metadata before digesting', async () => {
  const secret = 'actual-secret-value';
  const f = await fixture(); const h = harness(f.profile, { toolVersion: `pio ${secret}` });
  h.dependencies.redactValues = [secret];
  const planned = await planHardwareRun({ profilePath: f.profilePath, evidenceDir: path.join(f.root, secret), dependencies: h.dependencies });
  const serialized = JSON.stringify(planned.plan);
  assert.equal(serialized.includes(secret), false);
  assert.match(serialized, /\[REDACTED\]/);
  assert.match(planned.plan.capabilities.build.fingerprint, /^[a-f0-9]{64}$/);
  const changed = await planHardwareRun({ profilePath: f.profilePath, evidenceDir: path.join(f.root, 'different-secret'), dependencies: { ...h.dependencies, redactValues: [secret, 'different-secret'] } });
  assert.notEqual(changed.digest, planned.digest);
});

test('plan then same-path tool replacement changes the digest before evidence or build', async () => {
  const observations = [{ id: 'firmware', provider: 'serial', contains: 'unused', requiredLevel: 'compiled' }];
  const f = await fixture({ twin: undefined, flash: undefined, observations });
  const tool = path.join(f.root, 'pio'); await writeFile(tool, 'same tool bytes');
  let ran = false; let evidenceCreated = false;
  const dependencies = {
    async loadProfile() { return structuredClone(f.profile); },
    createAdapters() { return createTrustedAdapters({
      async resolveTool() { return tool; }, async toolVersion() { return 'pio unchanged'; },
      async run() { ran = true; return { classification: 'exit', exitCode: 1, stdout: '', stderr: '' }; },
    }); },
    async createEvidence() { evidenceCreated = true; throw new Error('must not create evidence'); },
  };
  const p = await planHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, dependencies });
  await rm(tool); await writeFile(tool, 'same tool bytes');
  await assert.rejects(executeHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, confirmDigest: p.digest, dependencies }), /confirmation digest/);
  assert.equal(evidenceCreated, false); assert.equal(ran, false);
});

test('missing, malformed, or wrong confirmation refuses before evidence, locks, or mutation', async (t) => {
  for (const digest of [undefined, 'bad', '0'.repeat(64)]) await t.test(String(digest), async () => {
    const f = await fixture(); const h = harness(f.profile);
    await assert.rejects(executeHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, confirmDigest: digest, dependencies: h.dependencies }), /confirmation digest/i);
    assert.equal(h.calls.includes('evidence'), false); assert.equal(h.calls.includes('locks'), false); assert.equal(h.calls.includes('build'), false);
  });
});

test('ambiguous or drifting identities fail closed', async (t) => {
  await t.test('no production resolver', async () => {
    const f = await fixture(); const h = harness(f.profile);
    delete h.dependencies.resolveHardwareIdentities;
    await assert.rejects(planHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, dependencies: h.dependencies }), /BLOCKED.*resolver/i);
    assert.equal(h.calls.includes('locks'), false); assert.equal(h.calls.includes('flash'), false);
  });
  for (const [name, enumeration] of [['zero matches', []], ['multiple matches', [
    { target: 'desk-c3', probe: 'probe-123', serial: '/dev/ttyACM0', stableIds: { target: 't1', probe: 'p1', serial: 's1' } },
    { target: 'desk-c3', probe: 'probe-123', serial: '/dev/ttyACM0', stableIds: { target: 't2', probe: 'p2', serial: 's2' } },
  ]]]) await t.test(name, async () => {
    const f = await fixture(); const h = harness(f.profile, { identities: [enumeration] });
    await assert.rejects(planHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, dependencies: h.dependencies }), /exactly one|unique/i);
    assert.equal(h.calls.includes('locks'), false); assert.equal(h.calls.includes('flash'), false);
  });
  await t.test('ambiguous at planning', async () => {
    const f = await fixture(); const h = harness(f.profile, { identities: [[{ target: 'desk-c3', probe: 'first', serial: '/dev/ttyACM0', stableIds: { target: 't', probe: 'p', serial: 's' } }]] });
    await assert.rejects(planHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, dependencies: h.dependencies }), /ambiguous|explicit/i);
  });
  await t.test('drift after flash', async () => {
    const exact = { target: 'desk-c3', probe: 'probe-123', serial: '/dev/ttyACM0', stableIds: { target: 'usb:target-1', probe: 'usb:probe-1', serial: 'usb:port-1' } };
    const f = await fixture(); const h = harness(f.profile, { identities: [
      [exact],
      [exact],
      [{ ...exact, stableIds: { ...exact.stableIds, serial: 'usb:port-9' } }],
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

test('confirmation binds canonical evidence destination across cwd drift', async () => {
  const f = await fixture(); const h = harness(f.profile);
  const first = await mkdtemp(path.join(os.tmpdir(), 'labwired-cwd-a-'));
  const second = await mkdtemp(path.join(os.tmpdir(), 'labwired-cwd-b-'));
  roots.push(first, second);
  const original = process.cwd();
  try {
    process.chdir(first);
    const planned = await planHardwareRun({ profilePath: f.profilePath, evidenceDir: 'relative-evidence', dependencies: h.dependencies });
    process.chdir(second);
    await assert.rejects(executeHardwareRun({ profilePath: f.profilePath, evidenceDir: 'relative-evidence', confirmDigest: planned.digest, dependencies: h.dependencies }), /confirmation digest/);
    assert.equal(h.calls.includes('evidence'), false);
    await assert.rejects(readFile(path.join(second, 'relative-evidence', 'result.json')));
  } finally { process.chdir(original); }
});

test('confirmation binds the effective default lock root across environment drift', async () => {
  const f = await fixture(); const h = harness(f.profile); delete h.dependencies.lockRoot;
  const variable = process.platform === 'win32' ? 'LOCALAPPDATA' : 'XDG_RUNTIME_DIR';
  const original = process.env[variable];
  const first = path.join(f.root, 'runtime-a'); const second = path.join(f.root, 'runtime-b');
  try {
    process.env[variable] = first;
    const planned = await planHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, dependencies: h.dependencies });
    process.env[variable] = second;
    await assert.rejects(executeHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, confirmDigest: planned.digest, dependencies: h.dependencies }), /confirmation digest/);
    assert.equal(h.calls.includes('locks'), false);
    await assert.rejects(readdir(second));
  } finally {
    if (original === undefined) delete process.env[variable]; else process.env[variable] = original;
  }
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

test('physical PASS authenticates exact flash and permitted twin failure provenance', async () => {
  const f = await fixture(); const h = harness(f.profile, { realPhysical: true });
  h.dependencies.createEvidence = async (...args) => {
    const { createEvidenceBundle } = await import('../lib/hardware/evidence.mjs');
    return createEvidenceBundle(...args);
  };
  const p = await planHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, dependencies: h.dependencies });
  const outcome = await executeHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, confirmDigest: p.digest, dependencies: h.dependencies });
  assert.equal(outcome.receipt.result, 'PASS');
  const record = JSON.parse(await readFile(path.join(f.evidenceDir, 'observations', 'heartbeat', 'result.json'), 'utf8'));
  assert.equal(record.rawEvidenceRefs.includes('observations/flash.json'), true);
  assert.equal(record.rawEvidenceRefs.includes('observations/twin-failure.json'), true);
  assert.match(JSON.stringify(record.diagnostics), /unsupported/);
  const twinStage = JSON.parse(await readFile(path.join(f.evidenceDir, 'stages', 'twin', 'result.json'), 'utf8'));
  const flashStage = JSON.parse(await readFile(path.join(f.evidenceDir, 'stages', 'flash', 'result.json'), 'utf8'));
  assert.equal(twinStage.level, 'failed'); assert.match(JSON.stringify(twinStage.diagnostics), /unsupported/);
  assert.equal(flashStage.level, 'hardware_observed'); assert.equal(flashStage.rawEvidenceRefs.includes('observations/flash.json'), true);
  const verifiedFail = await verifyEvidenceBundle(f.evidenceDir, { expectedManifestSha256: outcome.receiptDigest });
  assert.equal(verifiedFail.authenticity, 'verified');
  assert.equal(verifiedFail.valid, true);
  await writeFile(path.join(f.evidenceDir, 'observations', 'flash.json'), '{"flash":"tampered"}\n');
  assert.equal((await verifyEvidenceBundle(f.evidenceDir, { expectedManifestSha256: outcome.receiptDigest })).valid, false);
});

test('run stages remain authenticated when every observation fails', async () => {
  const f = await fixture();
  const failed = (id) => result('failed', { diagnostics: `${id} failed`, rawEvidenceRefs: [`observations/${id}.json`] });
  const h = harness(f.profile, { realPhysical: true, observations: { heartbeat: failed('heartbeat'), led: failed('led') } });
  h.dependencies.createEvidence = async (...args) => (await import('../lib/hardware/evidence.mjs')).createEvidenceBundle(...args);
  const p = await planHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, dependencies: h.dependencies });
  const outcome = await executeHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, confirmDigest: p.digest, dependencies: h.dependencies });
  assert.equal(outcome.receipt.result, 'FAIL');
  const verifiedFailure = await verifyEvidenceBundle(f.evidenceDir, { expectedManifestSha256: outcome.receiptDigest });
  assert.equal(verifiedFailure.authenticity, 'verified', JSON.stringify(verifiedFailure));
  await writeFile(path.join(f.evidenceDir, 'observations', 'twin-failure.json'), '{"tampered":true}\n');
  assert.equal((await verifyEvidenceBundle(f.evidenceDir, { expectedManifestSha256: outcome.receiptDigest })).valid, false);
});

test('compiled-only behavior after flash still authenticates flash stage', async () => {
  const observations = [{ id: 'firmware', provider: 'serial', contains: 'unused', requiredLevel: 'compiled' }];
  const f = await fixture({ twin: undefined, observations }); const h = harness(f.profile, { realPhysical: true });
  h.dependencies.createEvidence = async (...args) => (await import('../lib/hardware/evidence.mjs')).createEvidenceBundle(...args);
  const p = await planHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, dependencies: h.dependencies });
  const outcome = await executeHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, confirmDigest: p.digest, dependencies: h.dependencies });
  assert.equal(outcome.receipt.result, 'PASS');
  assert.equal(JSON.parse(await readFile(path.join(f.evidenceDir, 'stages', 'flash', 'result.json'), 'utf8')).level, 'hardware_observed');
  await writeFile(path.join(f.evidenceDir, 'observations', 'flash.json'), '{"tampered":true}\n');
  assert.equal((await verifyEvidenceBundle(f.evidenceDir, { expectedManifestSha256: outcome.receiptDigest })).valid, false);
});

test('unrelated but coherent artifact claims finalize authenticated FAIL', async (t) => {
  const unrelated = 'b'.repeat(64);
  for (const [name, requiredLevel, twin] of [
    ['model observation', 'model_observed', result('model_observed', { artifactSha256: unrelated, nativeArtifactSha256: unrelated, rawEvidenceRefs: ['observations/twin.json'] })],
    ['surrogate observation', 'surrogate_model_observed', result('surrogate_model_observed', { artifactSha256: unrelated, surrogateArtifactSha256: 'c'.repeat(64), sharedSourcePaths: ['src/main.cpp'], rawEvidenceRefs: ['observations/twin.json'] })],
  ]) await t.test(name, async () => {
    const observations = [{ id: 'firmware', provider: 'serial', contains: 'ready', requiredLevel }];
    const f = await fixture({ flash: undefined, observations }); const h = harness(f.profile, { realEvidence: true, twin });
    h.dependencies.createEvidence = async (...args) => (await import('../lib/hardware/evidence.mjs')).createEvidenceBundle(...args);
    const p = await planHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, dependencies: h.dependencies });
    const outcome = await executeHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, confirmDigest: p.digest, dependencies: h.dependencies });
    assert.equal(outcome.result, 'FAIL');
    assert.equal((await verifyEvidenceBundle(f.evidenceDir, { expectedManifestSha256: outcome.receiptDigest })).authenticity, 'verified');
  });
  await t.test('hardware observation', async () => {
    const f = await fixture();
    const h = harness(f.profile, { realPhysical: true, observations: {
      heartbeat: result('hardware_observed', { artifactSha256: unrelated, flashedArtifactSha256: unrelated, rawEvidenceRefs: ['observations/heartbeat.json'] }),
    } });
    h.dependencies.createEvidence = async (...args) => (await import('../lib/hardware/evidence.mjs')).createEvidenceBundle(...args);
    const p = await planHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, dependencies: h.dependencies });
    const outcome = await executeHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, confirmDigest: p.digest, dependencies: h.dependencies });
    assert.equal(outcome.result, 'FAIL');
    assert.equal((await verifyEvidenceBundle(f.evidenceDir, { expectedManifestSha256: outcome.receiptDigest })).authenticity, 'verified');
  });
  await t.test('flash receipt', async () => {
    const f = await fixture(); const h = harness(f.profile, { realPhysical: true, flash: result('hardware_observed', { artifactSha256: unrelated, flashedArtifactSha256: unrelated, rawEvidenceRefs: ['observations/flash.json'] }) });
    h.dependencies.createEvidence = async (...args) => (await import('../lib/hardware/evidence.mjs')).createEvidenceBundle(...args);
    const p = await planHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, dependencies: h.dependencies });
    const outcome = await executeHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, confirmDigest: p.digest, dependencies: h.dependencies });
    assert.equal(outcome.result, 'FAIL'); assert.equal(h.calls.some((call) => call.startsWith('observe:')), false);
  });
});

test('exact model and surrogate artifact provenance can produce authenticated PASS', async (t) => {
  const exact = 'a'.repeat(64);
  for (const [name, requiredLevel, twin] of [
    ['model', 'model_observed', result('model_observed', { artifactSha256: exact, nativeArtifactSha256: exact, rawEvidenceRefs: ['observations/twin.json'] })],
    ['surrogate', 'surrogate_model_observed', result('surrogate_model_observed', { artifactSha256: exact, surrogateArtifactSha256: 'c'.repeat(64), sharedSourcePaths: ['src/main.cpp'], rawEvidenceRefs: ['observations/twin.json'] })],
  ]) await t.test(name, async () => {
    const observations = [{ id: 'firmware', provider: 'serial', contains: 'ready', requiredLevel }];
    const f = await fixture({ flash: undefined, observations }); const h = harness(f.profile, { realEvidence: true, twin });
    h.dependencies.createEvidence = async (...args) => (await import('../lib/hardware/evidence.mjs')).createEvidenceBundle(...args);
    const p = await planHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, dependencies: h.dependencies });
    const outcome = await executeHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, confirmDigest: p.digest, dependencies: h.dependencies });
    assert.equal(outcome.result, 'PASS');
    assert.equal((await verifyEvidenceBundle(f.evidenceDir, { expectedManifestSha256: outcome.receiptDigest })).valid, true);
  });
});

test('abort during twin or between observations stops all later hardware work', async (t) => {
  await t.test('during twin', async () => {
    const controller = new AbortController(); const f = await fixture();
    const h = harness(f.profile, { onTwin() { controller.abort(); } });
    const p = await planHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, dependencies: h.dependencies });
    const outcome = await executeHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, confirmDigest: p.digest, dependencies: h.dependencies, signal: controller.signal });
    assert.equal(outcome.result, 'FAIL'); assert.equal(h.calls.includes('flash'), false); assert.equal(h.calls.some((call) => call.startsWith('observe:')), false);
  });
  await t.test('between observations', async () => {
    const controller = new AbortController(); const f = await fixture();
    const h = harness(f.profile, { onObservation(observation) { if (observation.id === 'heartbeat') controller.abort(); } });
    const p = await planHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, dependencies: h.dependencies });
    const outcome = await executeHardwareRun({ profilePath: f.profilePath, evidenceDir: f.evidenceDir, confirmDigest: p.digest, dependencies: h.dependencies, signal: controller.signal });
    assert.equal(outcome.result, 'FAIL'); assert.equal(h.calls.includes('observe:led'), false);
  });
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
