import { createHash, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { createTrustedAdapters } from './adapters.mjs';
import { createEvidenceBundle } from './evidence.mjs';
import { acquireHardwareLocks } from './locks.mjs';
import { canonicalProfile, loadHardwareProfile } from './profile.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const AMBIGUOUS = new Set(['auto', 'first', 'any', 'default']);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const output = {};
    for (const key of Object.keys(value).sort()) output[key] = canonicalize(value[key]);
    return output;
  }
  return value;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value)), 'utf8').digest('hex');
}

function safeCapability(value) {
  const output = {};
  for (const key of ['provider', 'toolVersion']) {
    if (typeof value?.[key] === 'string') output[key] = value[key];
  }
  return output;
}

function validateIdentity(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`explicit ${label} identity is required`);
  if (AMBIGUOUS.has(value.trim().toLowerCase())) throw new TypeError(`ambiguous ${label} identity is not allowed`);
  return value;
}

function normalizedIdentities(value, profile) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('resolved hardware identities must be an object');
  const expected = {
    target: profile.target.id,
    ...(profile.target.probeSerial ? { probe: profile.target.probeSerial } : {}),
    ...(profile.target.serialPort ? { serial: profile.target.serialPort } : {}),
  };
  const output = { target: validateIdentity(value.target, 'target') };
  if (expected.probe !== undefined) output.probe = validateIdentity(value.probe, 'probe');
  if (expected.serial !== undefined) output.serial = validateIdentity(value.serial, 'serial');
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (output[key] !== expectedValue) throw new Error(`resolved ${key} identity does not match the configured identity`);
  }
  return output;
}

async function defaultResolveHardwareIdentities(profile) {
  return {
    target: profile.target.id,
    ...(profile.target.probeSerial ? { probe: profile.target.probeSerial } : {}),
    ...(profile.target.serialPort ? { serial: profile.target.serialPort } : {}),
  };
}

function selectAdapters(adapters, profile) {
  const build = adapters.build?.[profile.build.provider];
  const twin = profile.twin ? adapters.twin?.[profile.twin.provider] : undefined;
  const flash = profile.flash ? adapters.flash?.[profile.flash.provider] : undefined;
  if (!build) throw new Error(`trusted build adapter ${profile.build.provider} is unavailable`);
  if (profile.twin && !twin) throw new Error(`trusted twin adapter ${profile.twin.provider} is unavailable`);
  if (profile.flash && !flash) throw new Error(`trusted flash adapter ${profile.flash.provider} is unavailable`);
  const observations = profile.observations.map((observation) => {
    const adapter = adapters.observation?.[observation.provider];
    if (!adapter) throw new Error(`trusted observation adapter ${observation.provider} is unavailable`);
    return { observation, adapter };
  });
  return { build, twin, flash, observations };
}

function dependenciesFor(input = {}) {
  const defaultLockRoot = process.platform === 'win32'
    ? path.resolve(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'LabWired', 'runtime', 'hardware-locks')
    : path.resolve(process.env.XDG_RUNTIME_DIR ?? path.join(os.homedir(), '.labwired', 'runtime'), 'hardware-locks');
  return {
    loadProfile: input.loadProfile ?? loadHardwareProfile,
    createAdapters: input.createAdapters ?? (() => createTrustedAdapters(input.adapterDependencies)),
    resolveHardwareIdentities: input.resolveHardwareIdentities ?? defaultResolveHardwareIdentities,
    createEvidence: input.createEvidence ?? createEvidenceBundle,
    acquireLocks: input.acquireLocks ?? acquireHardwareLocks,
    lockRoot: input.lockRoot ?? defaultLockRoot,
    redactValues: input.redactValues ?? [],
    onDelta: input.onDelta,
    twinArtifact: input.twinArtifact,
    sharedSourcePaths: input.sharedSourcePaths,
  };
}

async function prepare({ profilePath, evidenceDir, dependencies }) {
  if (typeof profilePath !== 'string' || profilePath === '') throw new TypeError('profilePath is required');
  if (typeof evidenceDir !== 'string' || evidenceDir === '') throw new TypeError('evidenceDir is required');
  const deps = dependenciesFor(dependencies);
  const profile = await deps.loadProfile(profilePath, { realpath: true });
  const adapters = deps.createAdapters();
  const selected = selectAdapters(adapters, profile);
  const identities = normalizedIdentities(await deps.resolveHardwareIdentities(profile, { signal: undefined }), profile);

  const buildCapability = await selected.build.preflight(profile);
  const twinCapability = selected.twin ? await selected.twin.preflight(profile) : undefined;
  const observationCapabilities = [];
  for (const { observation, adapter } of selected.observations) {
    observationCapabilities.push({ id: observation.id, provider: observation.provider, capability: safeCapability(await adapter.preflight(profile, observation)) });
  }
  const plan = canonicalize({
    schema: 1,
    profile: canonicalProfile(profile),
    evidenceDir,
    identities,
    capabilities: {
      build: { provider: profile.build.provider, ...safeCapability(buildCapability) },
      ...(profile.twin ? { twin: { provider: profile.twin.provider, ...safeCapability(twinCapability) } } : {}),
      ...(profile.flash ? { flash: { provider: profile.flash.provider } } : {}),
      observations: observationCapabilities,
    },
    policy: { continueAfterTwinFailure: Boolean(profile.flash) },
  });
  const planDigest = digest(plan);
  return { plan, digest: planDigest, profile, deps, selected, identities };
}

/** Produce a stable confirmation-bound plan without creating evidence or locks. */
export async function planHardwareRun(input) {
  const prepared = await prepare(input);
  return { plan: prepared.plan, digest: prepared.digest };
}

function verifyConfirmation(confirmDigest, expected) {
  if (typeof confirmDigest !== 'string' || !SHA256.test(confirmDigest)) {
    throw new TypeError('confirmation digest must be an exact lowercase SHA-256 digest');
  }
  const supplied = Buffer.from(confirmDigest, 'hex');
  const actual = Buffer.from(expected, 'hex');
  if (!timingSafeEqual(supplied, actual)) throw new Error('confirmation digest does not match the current hardware plan');
}

function failure(level, diagnostics) {
  return { level, diagnostics: String(diagnostics) };
}

async function recordAll(bundle, profile, value) {
  for (const observation of profile.observations) {
    await bundle.recordBehavior(observation.id, {
      behaviorId: observation.id,
      provider: observation.provider,
      level: value.level,
      rawEvidenceRefs: [],
      diagnostics: value.diagnostics,
    });
  }
}

function isHardwareObservation(observation) {
  return observation.requiredLevel === 'hardware_observed';
}

function boundFailure(observation, value) {
  return {
    behaviorId: observation.id,
    provider: observation.provider,
    level: value.level === 'blocked' ? 'blocked' : 'failed',
    rawEvidenceRefs: [],
    diagnostics: value.diagnostics,
  };
}

function boundClaim(observation, value, profile, startedAt, endedAt) {
  if (value.level === 'blocked' || value.level === 'failed') return boundFailure(observation, value);
  const common = {
    behaviorId: observation.id,
    provider: observation.provider,
    level: value.level,
    artifactSha256: value.artifactSha256,
    targetIdentity: profile.target,
    startedAt: value.startedAt ?? startedAt,
    endedAt: value.endedAt ?? endedAt,
    toolVersion: value.toolVersion ?? `${observation.provider} trusted adapter`,
    rawEvidenceRefs: value.rawEvidenceRefs ?? [],
    diagnostics: value.diagnostics,
  };
  if (value.level === 'compiled') return { ...common, claim: 'compiled_only' };
  if (value.level === 'model_observed') return { ...common, nativeArtifactSha256: value.nativeArtifactSha256 ?? value.artifactSha256 };
  if (value.level === 'surrogate_model_observed') return { ...common, surrogateArtifactSha256: value.surrogateArtifactSha256, sharedSourcePaths: value.sharedSourcePaths };
  if (value.level === 'hardware_observed') return { ...common, flashedArtifactSha256: value.flashedArtifactSha256 };
  return common;
}

/** Execute only the exact plan whose digest the caller explicitly confirmed. */
export async function executeHardwareRun(input) {
  const prepared = await prepare(input);
  verifyConfirmation(input.confirmDigest, prepared.digest);
  const { profile, deps, selected, identities } = prepared;
  const evidence = await deps.createEvidence(input.evidenceDir, profile, { redactValues: deps.redactValues });
  let locks;
  let executionError;
  let halted = false;
  try {
    locks = await deps.acquireLocks(identities, { root: deps.lockRoot, signal: input.signal });
    let buildResult;
    try {
      buildResult = await selected.build.execute(profile, { evidenceDir: input.evidenceDir, signal: input.signal, redact: deps.redactValues, onDelta: deps.onDelta });
    } catch (error) {
      buildResult = failure('failed', error?.message ?? error);
    }
    if (buildResult?.level !== 'compiled' || !SHA256.test(buildResult.artifactSha256 ?? '')) {
      await recordAll(evidence, profile, failure('blocked', buildResult?.diagnostics ?? 'build did not produce an exact compiled artifact'));
      halted = true;
    } else {
      const artifactSha256 = buildResult.artifactSha256.toLowerCase();
      for (const observation of profile.observations.filter((item) => item.requiredLevel === 'compiled')) {
        await evidence.recordBehavior(observation.id, {
          behaviorId: observation.id,
          provider: observation.provider,
          level: 'compiled',
          artifactSha256,
          targetIdentity: buildResult.targetIdentity ?? profile.target,
          startedAt: buildResult.startedAt,
          endedAt: buildResult.endedAt,
          toolVersion: buildResult.toolVersion,
          rawEvidenceRefs: buildResult.rawEvidenceRefs ?? [],
          diagnostics: buildResult.diagnostics,
          claim: 'compiled_only',
        });
      }
      if (selected.twin) {
        let twinResult;
        const twinStartedAt = new Date().toISOString();
        try {
          twinResult = await selected.twin.execute(profile, {
            nativeArtifactSha256: artifactSha256, twinArtifact: deps.twinArtifact,
            sharedSourcePaths: deps.sharedSourcePaths, evidenceDir: input.evidenceDir,
            signal: input.signal, redact: deps.redactValues, onDelta: deps.onDelta,
          });
        } catch (error) { twinResult = failure('failed', error?.message ?? error); }
        const twinEndedAt = new Date().toISOString();
        for (const observation of profile.observations.filter((item) => !isHardwareObservation(item) && item.provider === 'serial')) {
          await evidence.recordBehavior(observation.id, boundClaim(observation, twinResult, profile, twinStartedAt, twinEndedAt));
        }
        if (twinResult.level === 'failed' && !prepared.plan.policy.continueAfterTwinFailure) {
          for (const observation of profile.observations.filter(isHardwareObservation)) {
            await evidence.recordBehavior(observation.id, boundFailure(observation, failure('blocked', 'twin failed and the confirmed plan does not permit physical continuation')));
          }
          halted = true;
        }
      }

      if (!halted && selected.flash) {
        let flashResult;
        try {
          await selected.flash.preflight(profile, { artifactSha256 });
          flashResult = await selected.flash.execute(profile, {
            artifactSha256, evidenceDir: input.evidenceDir, signal: input.signal,
            redact: deps.redactValues, onDelta: deps.onDelta,
          });
        } catch (error) { flashResult = failure('failed', error?.message ?? error); }
        if (flashResult.level !== 'hardware_observed' || flashResult.flashedArtifactSha256 !== artifactSha256) {
          for (const observation of profile.observations.filter(isHardwareObservation)) {
            await evidence.recordBehavior(observation.id, boundFailure(observation, failure('blocked', flashResult.diagnostics ?? 'exact flash was not proven')));
          }
          halted = true;
        } else {
          let after;
          try { after = normalizedIdentities(await deps.resolveHardwareIdentities(profile, { signal: input.signal }), profile); } catch (error) { executionError = error; }
          if (executionError || JSON.stringify(after) !== JSON.stringify(identities)) {
            await recordAll(evidence, profile, failure('blocked', executionError?.message ?? 'hardware identity drifted after flash'));
            halted = true;
          } else {
            for (const { observation, adapter } of selected.observations) {
              if (!isHardwareObservation(observation)) continue;
              let observationResult;
              const observationStartedAt = new Date().toISOString();
              try {
                observationResult = await adapter.execute(profile, observation, {
                  artifactSha256, flashedArtifactSha256: artifactSha256, evidenceDir: input.evidenceDir,
                  signal: input.signal, redact: deps.redactValues, onDelta: deps.onDelta,
                });
              } catch (error) { observationResult = failure('failed', error?.message ?? error); }
              const observationEndedAt = new Date().toISOString();
              await evidence.recordBehavior(observation.id, boundClaim(observation, observationResult, profile, observationStartedAt, observationEndedAt));
            }
          }
        }
      }
    }
  } catch (error) {
    executionError = error;
    try { await recordAll(evidence, profile, failure('blocked', error?.message ?? error)); } catch { /* finalization reports the durable state */ }
  } finally {
    try {
      await locks?.release();
    } catch (error) {
      executionError = error;
      await recordAll(evidence, profile, failure('failed', `hardware lock cleanup failed: ${error?.message ?? error}`));
    }
  }
  const receipt = await evidence.finalize();
  return { plan: { plan: prepared.plan, digest: prepared.digest }, result: receipt.result, receipt, receiptDigest: receipt.manifestSha256, ...(executionError ? { error: String(executionError.message ?? executionError) } : {}) };
}
