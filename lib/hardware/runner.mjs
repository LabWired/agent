import { createHash, timingSafeEqual } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createTrustedAdapters } from './adapters.mjs';
import { createEvidenceBundle, redactDeep } from './evidence.mjs';
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
  for (const key of ['provider', 'toolVersion', 'executable', 'toolIdentityFingerprint']) {
    if (typeof value?.[key] === 'string') output[key] = value[key];
  }
  return { ...output, fingerprint: digest(output) };
}

function validateIdentity(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`explicit ${label} identity is required`);
  if (AMBIGUOUS.has(value.trim().toLowerCase())) throw new TypeError(`ambiguous ${label} identity is not allowed`);
  return value;
}

function normalizedIdentities(value, profile) {
  if (!Array.isArray(value) || value.length !== 1) throw new TypeError('hardware resolver must return exactly one unique detected identity');
  const detected = value[0];
  if (!detected || typeof detected !== 'object' || Array.isArray(detected)) throw new TypeError('detected hardware identity must be an object');
  const expected = {
    target: profile.target.id,
    ...(profile.target.probeSerial ? { probe: profile.target.probeSerial } : {}),
    ...(profile.target.serialPort ? { serial: profile.target.serialPort } : {}),
  };
  const configured = { target: validateIdentity(detected.target, 'target') };
  if (expected.probe !== undefined) configured.probe = validateIdentity(detected.probe, 'probe');
  if (expected.serial !== undefined) configured.serial = validateIdentity(detected.serial, 'serial');
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (configured[key] !== expectedValue) throw new Error(`resolved ${key} identity does not match the configured identity`);
  }
  if (!detected.stableIds || typeof detected.stableIds !== 'object' || Array.isArray(detected.stableIds)) {
    throw new TypeError('detected hardware identity requires stable immutable provider IDs');
  }
  const stableIds = {};
  for (const key of Object.keys(configured)) stableIds[key] = validateIdentity(detected.stableIds[key], `${key} stable provider`);
  return Object.freeze({ configured: Object.freeze(configured), stableIds: Object.freeze(stableIds) });
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
    resolveHardwareIdentities: input.resolveHardwareIdentities,
    createEvidence: input.createEvidence ?? createEvidenceBundle,
    acquireLocks: input.acquireLocks ?? acquireHardwareLocks,
    lockRoot: input.lockRoot ?? defaultLockRoot,
    redactValues: input.redactValues ?? [],
    onDelta: input.onDelta,
    twinArtifact: input.twinArtifact,
    sharedSourcePaths: input.sharedSourcePaths,
  };
}

async function canonicalDestination(value) {
  const absolute = path.resolve(value);
  const missing = [];
  let ancestor = absolute;
  while (true) {
    try {
      await lstat(ancestor);
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
  return path.join(await realpath(ancestor), ...missing);
}

async function prepare({ profilePath, evidenceDir, dependencies }) {
  if (typeof profilePath !== 'string' || profilePath === '') throw new TypeError('profilePath is required');
  if (typeof evidenceDir !== 'string' || evidenceDir === '') throw new TypeError('evidenceDir is required');
  const deps = dependenciesFor(dependencies);
  const preparedPaths = Object.freeze({
    evidenceDir: await canonicalDestination(evidenceDir),
    lockRoot: await canonicalDestination(deps.lockRoot),
  });
  const profile = await deps.loadProfile(profilePath, { realpath: true });
  const adapters = deps.createAdapters();
  const selected = selectAdapters(adapters, profile);
  const physical = Boolean(profile.flash || profile.observations.some(isHardwareObservation));
  if (physical && typeof deps.resolveHardwareIdentities !== 'function') {
    throw new Error('BLOCKED: physical hardware requires a genuine provider-backed identity resolver');
  }
  const identities = physical
    ? normalizedIdentities(await deps.resolveHardwareIdentities(profile, { signal: undefined }), profile)
    : Object.freeze({ configured: Object.freeze({ target: profile.target.id }), stableIds: Object.freeze({ target: `profile:${profile.target.id}` }) });

  const buildCapability = await selected.build.preflight(profile);
  const twinCapability = selected.twin ? await selected.twin.preflight(profile) : undefined;
  const flashPlanCapability = selected.flash?.preflightPlan ? await selected.flash.preflightPlan(profile) : undefined;
  const observationCapabilities = [];
  const preparedObservations = new Map();
  for (const { observation, adapter } of selected.observations) {
    const capability = await adapter.preflight(profile, observation);
    preparedObservations.set(observation.id, capability);
    observationCapabilities.push({ id: observation.id, provider: observation.provider, capability: safeCapability(capability) });
  }
  const safeCapabilities = {
    build: { provider: profile.build.provider, ...safeCapability(buildCapability) },
    ...(profile.twin ? { twin: { provider: profile.twin.provider, ...safeCapability(twinCapability) } } : {}),
    ...(profile.flash ? { flash: { provider: profile.flash.provider, ...safeCapability(flashPlanCapability) } } : {}),
    observations: observationCapabilities,
  };
  const rawPlan = {
    schema: 1,
    profile: canonicalProfile(profile),
    paths: {
      evidenceDir: preparedPaths.evidenceDir,
      evidenceDirFingerprint: digest(preparedPaths.evidenceDir),
      lockRoot: preparedPaths.lockRoot,
      lockRootFingerprint: digest(preparedPaths.lockRoot),
    },
    operationalFingerprint: digest({ profile: canonicalProfile(profile), paths: preparedPaths, capabilities: safeCapabilities }),
    identities: identities.configured,
    stableIdentityFingerprints: Object.fromEntries(Object.entries(identities.stableIds).map(([key, value]) => [key, digest(value)])),
    capabilities: safeCapabilities,
    policy: { continueAfterTwinFailure: Boolean(profile.flash) },
  };
  const plan = canonicalize(redactDeep(rawPlan, deps.redactValues));
  const planDigest = digest(plan);
  return { plan, digest: planDigest, profile, deps, preparedPaths, selected, identities, capabilities: { build: buildCapability, twin: twinCapability, flashPlan: flashPlanCapability, observations: preparedObservations } };
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

function abortError(signal) {
  if (!signal?.aborted) return;
  const error = new Error('hardware run cancelled');
  error.name = 'AbortError';
  throw error;
}

function validateArtifactProvenance(value, artifactSha256, context, { flashed = false } = {}) {
  if (!value || value.level === 'failed' || value.level === 'blocked') return value;
  const mismatch = (message) => ({
    level: 'failed',
    rawEvidenceRefs: value.rawEvidenceRefs ?? [],
    diagnostics: `${context} artifact provenance rejected: ${message}`,
  });
  if (!SHA256.test(value.artifactSha256 ?? '') || value.artifactSha256.toLowerCase() !== artifactSha256) {
    return mismatch('artifactSha256 does not match the exact build artifact');
  }
  if (value.level === 'model_observed'
    && (!SHA256.test(value.nativeArtifactSha256 ?? '') || value.nativeArtifactSha256.toLowerCase() !== artifactSha256)) {
    return mismatch('nativeArtifactSha256 does not match the exact build artifact');
  }
  if (value.level === 'surrogate_model_observed') {
    if (value.nativeArtifactSha256 !== undefined
      && (!SHA256.test(value.nativeArtifactSha256) || value.nativeArtifactSha256.toLowerCase() !== artifactSha256)) {
      return mismatch('nativeArtifactSha256 does not match the exact build artifact');
    }
    if (!SHA256.test(value.surrogateArtifactSha256 ?? '')
      || value.surrogateArtifactSha256.toLowerCase() === artifactSha256) {
      return mismatch('surrogateArtifactSha256 is absent, malformed, or not distinct');
    }
  }
  if ((flashed || value.level === 'hardware_observed')
    && (!SHA256.test(value.flashedArtifactSha256 ?? '') || value.flashedArtifactSha256.toLowerCase() !== artifactSha256)) {
    return mismatch('flashedArtifactSha256 does not match the exact build artifact');
  }
  return value;
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
    rawEvidenceRefs: value.rawEvidenceRefs ?? [],
    diagnostics: value.diagnostics,
  };
}

function boundClaim(observation, value, profile, startedAt, endedAt, stage = {}) {
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
    rawEvidenceRefs: [...new Set([...(stage.rawEvidenceRefs ?? []), ...(value.rawEvidenceRefs ?? [])])],
    diagnostics: stage.diagnostics ? { stages: stage.diagnostics, observation: value.diagnostics } : value.diagnostics,
  };
  if (value.level === 'compiled') return { ...common, claim: 'compiled_only' };
  if (value.level === 'model_observed') return { ...common, nativeArtifactSha256: value.nativeArtifactSha256 ?? value.artifactSha256 };
  if (value.level === 'surrogate_model_observed') return { ...common, surrogateArtifactSha256: value.surrogateArtifactSha256, sharedSourcePaths: value.sharedSourcePaths };
  if (value.level === 'hardware_observed') return { ...common, flashedArtifactSha256: value.flashedArtifactSha256 };
  return common;
}

function stageClaim(stageId, provider, value, startedAt, endedAt) {
  return {
    stageId,
    provider,
    level: value.level === 'not-run' ? 'blocked' : value.level,
    rawEvidenceRefs: value.rawEvidenceRefs ?? [],
    diagnostics: value.diagnostics,
    ...(value.artifactSha256 ? { artifactSha256: value.artifactSha256 } : {}),
    ...(value.flashedArtifactSha256 ? { flashedArtifactSha256: value.flashedArtifactSha256 } : {}),
    startedAt: value.startedAt ?? startedAt,
    endedAt: value.endedAt ?? endedAt,
    ...(value.toolVersion ? { toolVersion: value.toolVersion } : {}),
  };
}

/** Execute only the exact plan whose digest the caller explicitly confirmed. */
export async function executeHardwareRun(input) {
  const prepared = await prepare(input);
  verifyConfirmation(input.confirmDigest, prepared.digest);
  const { profile, deps, preparedPaths, selected, identities, capabilities } = prepared;
  const stageDefinitions = [
    { id: 'build', provider: profile.build.provider },
    ...(profile.twin ? [{ id: 'twin', provider: profile.twin.provider }] : []),
    ...(profile.flash ? [{ id: 'flash', provider: profile.flash.provider }] : []),
  ];
  abortError(input.signal);
  const evidence = await deps.createEvidence(preparedPaths.evidenceDir, profile, { redactValues: deps.redactValues, stages: stageDefinitions });
  abortError(input.signal);
  let locks;
  let executionError;
  let halted = false;
  const authenticatedStages = { rawEvidenceRefs: [], diagnostics: {} };
  const recordedStages = new Set();
  const recordStage = async (id, provider, value, startedAt, endedAt) => {
    await evidence.recordStage(id, stageClaim(id, provider, value, startedAt, endedAt));
    recordedStages.add(id);
  };
  try {
    if (profile.flash || profile.observations.some(isHardwareObservation)) {
      abortError(input.signal);
      locks = await deps.acquireLocks(identities.stableIds, { root: preparedPaths.lockRoot, signal: input.signal });
      abortError(input.signal);
    }
    let buildResult;
    const buildStartedAt = new Date().toISOString();
    try {
      abortError(input.signal);
      buildResult = await selected.build.execute(profile, { prepared: capabilities.build, evidenceDir: preparedPaths.evidenceDir, signal: input.signal, redact: deps.redactValues, onDelta: deps.onDelta });
      abortError(input.signal);
    } catch (error) {
      abortError(input.signal);
      buildResult = failure('failed', error?.message ?? error);
    }
    await recordStage('build', profile.build.provider, buildResult, buildStartedAt, new Date().toISOString());
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
          abortError(input.signal);
          twinResult = await selected.twin.execute(profile, {
            prepared: capabilities.twin,
            nativeArtifactSha256: artifactSha256, twinArtifact: deps.twinArtifact,
            sharedSourcePaths: deps.sharedSourcePaths, evidenceDir: preparedPaths.evidenceDir,
            signal: input.signal, redact: deps.redactValues, onDelta: deps.onDelta,
          });
          abortError(input.signal);
        } catch (error) { abortError(input.signal); twinResult = failure('failed', error?.message ?? error); }
        twinResult = validateArtifactProvenance(twinResult, artifactSha256, 'twin');
        const twinEndedAt = new Date().toISOString();
        await recordStage('twin', profile.twin.provider, twinResult, twinStartedAt, twinEndedAt);
        if (twinResult.level === 'failed' || twinResult.level === 'blocked') {
          authenticatedStages.rawEvidenceRefs.push(...(twinResult.rawEvidenceRefs ?? []));
          authenticatedStages.diagnostics.twin = twinResult.diagnostics ?? twinResult.level;
        }
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
          abortError(input.signal);
          const flashCapability = await selected.flash.preflight(profile, { artifactSha256, planPrepared: capabilities.flashPlan });
          abortError(input.signal);
          flashResult = await selected.flash.execute(profile, {
            prepared: flashCapability, artifactSha256, evidenceDir: preparedPaths.evidenceDir, signal: input.signal,
            redact: deps.redactValues, onDelta: deps.onDelta,
          });
          abortError(input.signal);
        } catch (error) { abortError(input.signal); flashResult = failure('failed', error?.message ?? error); }
        flashResult = validateArtifactProvenance(flashResult, artifactSha256, 'flash', { flashed: true });
        if (flashResult.level !== 'hardware_observed') {
          await recordStage('flash', profile.flash.provider, flashResult, new Date().toISOString(), new Date().toISOString());
          for (const observation of profile.observations.filter(isHardwareObservation)) {
            await evidence.recordBehavior(observation.id, boundFailure(observation, failure('blocked', flashResult.diagnostics ?? 'exact flash was not proven')));
          }
          halted = true;
        } else {
          await recordStage('flash', profile.flash.provider, flashResult, new Date().toISOString(), new Date().toISOString());
          authenticatedStages.rawEvidenceRefs.push(...(flashResult.rawEvidenceRefs ?? []));
          authenticatedStages.diagnostics.flash = {
            level: flashResult.level,
            artifactSha256: flashResult.flashedArtifactSha256,
          };
          let after;
          try { abortError(input.signal); after = normalizedIdentities(await deps.resolveHardwareIdentities(profile, { signal: input.signal }), profile); abortError(input.signal); } catch (error) { abortError(input.signal); executionError = error; }
          if (executionError || JSON.stringify(after) !== JSON.stringify(identities)) {
            await recordAll(evidence, profile, failure('blocked', executionError?.message ?? 'hardware identity drifted after flash'));
            halted = true;
          } else {
            for (const { observation, adapter } of selected.observations) {
              if (!isHardwareObservation(observation)) continue;
              abortError(input.signal);
              let observationResult;
              const observationStartedAt = new Date().toISOString();
              try {
                observationResult = await adapter.execute(profile, observation, {
                  prepared: capabilities.observations.get(observation.id),
                  artifactSha256, flashedArtifactSha256: artifactSha256, evidenceDir: preparedPaths.evidenceDir,
                  signal: input.signal, redact: deps.redactValues, onDelta: deps.onDelta,
                });
                abortError(input.signal);
              } catch (error) { abortError(input.signal); observationResult = failure('failed', error?.message ?? error); }
              observationResult = validateArtifactProvenance(observationResult, artifactSha256, `observation ${observation.id}`, { flashed: true });
              const observationEndedAt = new Date().toISOString();
              await evidence.recordBehavior(observation.id, boundClaim(observation, observationResult, profile, observationStartedAt, observationEndedAt, authenticatedStages));
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
  for (const stage of stageDefinitions) {
    if (!recordedStages.has(stage.id)) {
      await recordStage(stage.id, stage.provider, failure('blocked', 'stage dependency did not complete'), new Date().toISOString(), new Date().toISOString());
    }
  }
  const receipt = await evidence.finalize();
  return { plan: { plan: prepared.plan, digest: prepared.digest }, result: receipt.result, receipt, receiptDigest: receipt.manifestSha256, ...(executionError ? { error: String(executionError.message ?? executionError) } : {}) };
}
