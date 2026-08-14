import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const SATISFIES = new Set([
  'compiled:compiled',
  'model_observed:compiled',
  'model_observed:model_observed',
  'model_observed:surrogate_model_observed',
  'surrogate_model_observed:compiled',
  'surrogate_model_observed:surrogate_model_observed',
  'hardware_observed:compiled',
  'hardware_observed:model_observed',
  'hardware_observed:surrogate_model_observed',
  'hardware_observed:hardware_observed',
  'untrusted_observation:untrusted_observation',
]);

const RESULT_LEVELS = new Set([
  'compiled',
  'model_observed',
  'surrogate_model_observed',
  'hardware_observed',
  'untrusted_observation',
  'blocked',
  'failed',
  'not-run',
]);
const VERIFIED_LEVELS = new Set(['compiled', 'model_observed', 'surrogate_model_observed', 'hardware_observed']);
const SHA256 = /^[0-9a-f]{64}$/i;
const MAX_RAW_EVIDENCE_REFS = 32;
const MAX_REFERENCE_LENGTH = 512;
const MAX_DIAGNOSTICS_BYTES = 65_536;

function replacementPattern(value) {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
}

function redactString(value, secrets) {
  let output = value;
  for (const secret of secrets) output = output.replace(replacementPattern(secret), '[REDACTED]');
  return output;
}

/** Recursively copy plain data while replacing configured secret substrings. */
export function redactDeep(value, redactValues = [], seen = new WeakMap()) {
  const secrets = [...new Set(redactValues.filter((entry) => typeof entry === 'string' && entry.length > 0))];
  function visit(current) {
    if (typeof current === 'string') return redactString(current, secrets);
    if (current === null || typeof current !== 'object') return current;
    if (seen.has(current)) return '[Circular]';
    seen.set(current, true);
    if (current instanceof Error) {
      const serialized = { name: current.name, message: current.message, stack: current.stack };
      for (const key of Object.keys(current)) serialized[key] = current[key];
      return visit(serialized);
    }
    if (Array.isArray(current)) return current.map(visit);
    const copy = {};
    for (const [key, child] of Object.entries(current)) {
      copy[redactString(key, secrets)] = visit(child);
    }
    return copy;
  }
  return visit(value);
}

/** Return the lowercase SHA-256 digest of the exact bytes in a file. */
export async function sha256File(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

/** Check an actual evidence level against a requirement using explicit pairs. */
export function levelSatisfies(actualLevel, requiredLevel) {
  return SATISFIES.has(`${actualLevel}:${requiredLevel}`);
}

async function atomicWriteJson(file, value) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(file)}.tmp-${process.pid}-${randomUUID()}`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function assertProfile(profile) {
  if (!profile || !Array.isArray(profile.observations)) {
    throw new TypeError('profile.observations must be an array');
  }
  const observations = new Map();
  for (const observation of profile.observations) {
    if (!observation || typeof observation.id !== 'string' || typeof observation.requiredLevel !== 'string') {
      throw new TypeError('each observation needs an id and requiredLevel');
    }
    if (observations.has(observation.id)) throw new TypeError(`duplicate behavior ${observation.id}`);
    observations.set(observation.id, observation);
  }
  return observations;
}

function failureSummary(observations, records) {
  const reasons = [];
  for (const [behaviorId, observation] of observations) {
    const actualLevel = records.get(behaviorId)?.level ?? 'not-run';
    if (!levelSatisfies(actualLevel, observation.requiredLevel)) {
      reasons.push({
        behaviorId,
        requiredLevel: observation.requiredLevel,
        actualLevel,
        reason: `required ${observation.requiredLevel}; recorded ${actualLevel}`,
      });
    }
  }
  return { result: reasons.length === 0 ? 'PASS' : 'FAIL', reasons };
}

function normalizeSha256(value, field) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new TypeError(`${field} must be a 64-character SHA-256 digest`);
  }
  return value.toLowerCase();
}

function safeRelativeReference(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REFERENCE_LENGTH) {
    throw new TypeError(`${field} entries must be nonempty and at most ${MAX_REFERENCE_LENGTH} characters`);
  }
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || value.split(/[\\/]+/).includes('..')) {
    throw new TypeError(`${field} entries must be safe relative paths`);
  }
  return value;
}

function normalizeReferences(value, field, { nonempty = false, maximum = MAX_RAW_EVIDENCE_REFS } = {}) {
  if (!Array.isArray(value) || (nonempty && value.length === 0) || value.length > maximum) {
    throw new TypeError(`${field} must be ${nonempty ? 'a nonempty' : 'an'} array with at most ${maximum} entries`);
  }
  return value.map((entry) => safeRelativeReference(entry, field));
}

function normalizeTimestamp(value, field) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be a valid timestamp`);
  }
  return new Date(value).toISOString();
}

function normalizeTargetIdentity(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('target identity must be an object');
  }
  for (const [key, expectedValue] of Object.entries(expected ?? {})) {
    if (value[key] !== expectedValue) throw new TypeError(`target identity ${key} does not match the profile`);
  }
  return { ...value };
}

function normalizeVerifiedRecord(result, observation, profile, redactValues) {
  if (typeof result.provider !== 'string' || result.provider.length === 0 || result.provider !== observation.provider) {
    throw new TypeError(`provider must match ${observation.provider}`);
  }
  if (typeof result.behaviorId !== 'string' || result.behaviorId.length === 0) {
    throw new TypeError('behaviorId must explicitly name the destination behavior');
  }
  const artifactSha256 = normalizeSha256(result.artifactSha256, 'artifactSha256');
  const targetIdentity = normalizeTargetIdentity(result.targetIdentity, profile.target);
  const startedAt = normalizeTimestamp(result.startedAt, 'startedAt');
  const endedAt = normalizeTimestamp(result.endedAt, 'endedAt');
  if (Date.parse(endedAt) < Date.parse(startedAt)) throw new TypeError('endedAt precedes startedAt');
  if (typeof result.toolVersion !== 'string' || result.toolVersion.trim().length === 0) {
    throw new TypeError('toolVersion must be nonempty');
  }
  const rawEvidenceRefs = normalizeReferences(result.rawEvidenceRefs, 'rawEvidenceRefs');
  const diagnostics = redactDeep(result.diagnostics ?? {}, redactValues);
  if (Buffer.byteLength(JSON.stringify(diagnostics), 'utf8') > MAX_DIAGNOSTICS_BYTES) {
    throw new TypeError(`diagnostics must be at most ${MAX_DIAGNOSTICS_BYTES} bytes`);
  }

  const normalized = {
    ...result,
    artifactSha256,
    targetIdentity,
    startedAt,
    endedAt,
    toolVersion: result.toolVersion.trim(),
    rawEvidenceRefs,
    diagnostics,
  };
  if (result.level === 'model_observed') {
    normalized.nativeArtifactSha256 = normalizeSha256(result.nativeArtifactSha256, 'nativeArtifactSha256');
    if (normalized.nativeArtifactSha256 !== artifactSha256) {
      throw new TypeError('nativeArtifactSha256 must match artifactSha256');
    }
  } else if (result.level === 'surrogate_model_observed') {
    normalized.surrogateArtifactSha256 = normalizeSha256(result.surrogateArtifactSha256, 'surrogateArtifactSha256');
    if (normalized.surrogateArtifactSha256 === artifactSha256) {
      throw new TypeError('surrogateArtifactSha256 must differ from artifactSha256');
    }
    normalized.sharedSourcePaths = normalizeReferences(result.sharedSourcePaths, 'sharedSourcePaths', {
      nonempty: true,
      maximum: 128,
    });
  } else if (result.level === 'hardware_observed') {
    normalized.flashedArtifactSha256 = normalizeSha256(result.flashedArtifactSha256, 'flashedArtifactSha256');
    if (normalized.flashedArtifactSha256 !== artifactSha256) {
      throw new TypeError('flashedArtifactSha256 must match artifactSha256');
    }
  }
  return normalized;
}

async function targetExists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

/** Create a fail-first, behavior-bound evidence bundle. */
export async function createEvidenceBundle(directory, profile, { redactValues = [] } = {}) {
  const root = path.resolve(directory);
  const observations = assertProfile(profile);
  const records = new Map();
  let writeQueue = Promise.resolve();
  let finalized = false;

  const parent = path.dirname(root);
  const staging = path.join(parent, `.${path.basename(root)}.staging-${process.pid}-${randomUUID()}`);
  await fs.mkdir(parent, { recursive: true });
  if (await targetExists(root)) throw new Error(`evidence bundle already exists: ${root}`);
  await fs.mkdir(staging);
  for (const [behaviorId, observation] of observations) {
    const initial = redactDeep({
      behaviorId,
      provider: observation.provider,
      requiredLevel: observation.requiredLevel,
      level: 'not-run',
    }, redactValues);
    records.set(behaviorId, initial);
  }
  try {
    await atomicWriteJson(path.join(staging, 'result.json'), failureSummary(observations, records));
    for (const [behaviorId] of observations) {
      await atomicWriteJson(path.join(staging, 'observations', behaviorId, 'result.json'), records.get(behaviorId));
    }
    await atomicWriteJson(path.join(staging, '.owner.json'), {
      owner: randomUUID(),
      createdAt: new Date().toISOString(),
    });
    await fs.rename(staging, root);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY'
      ? new Error(`evidence bundle already exists: ${root}`, { cause: error })
      : error;
  }

  function serializeWrite(operation) {
    const pending = writeQueue.then(operation, operation);
    writeQueue = pending.catch(() => {});
    return pending;
  }

  return Object.freeze({
    root,
    async recordBehavior(behaviorId, result) {
      return serializeWrite(async () => {
        if (finalized) throw new Error('evidence bundle is finalized');
        const observation = observations.get(behaviorId);
        if (!observation) throw new TypeError(`unknown behavior ${behaviorId}`);
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
          throw new TypeError('behavior result must be an object');
        }
        if (result.behaviorId !== undefined && result.behaviorId !== behaviorId) {
          throw new TypeError(`result behavior ${result.behaviorId} does not match ${behaviorId}`);
        }
        if (!RESULT_LEVELS.has(result.level)) throw new TypeError(`unsupported evidence level ${result.level}`);
        const validated = VERIFIED_LEVELS.has(result.level)
          ? normalizeVerifiedRecord(result, observation, profile, redactValues)
          : result;
        const record = redactDeep({
          ...validated,
          behaviorId,
          provider: observation.provider,
          requiredLevel: observation.requiredLevel,
        }, redactValues);
        await atomicWriteJson(path.join(root, 'observations', behaviorId, 'result.json'), record);
        records.set(behaviorId, record);
        return record;
      });
    },
    async finalize() {
      return serializeWrite(async () => {
        if (finalized) throw new Error('evidence bundle is finalized');
        const summary = redactDeep(failureSummary(observations, records), redactValues);
        await atomicWriteJson(path.join(root, 'result.json'), summary);
        finalized = true;
        return summary;
      });
    },
  });
}
