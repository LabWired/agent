import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, createReadStream } from 'node:fs';
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
const CLAIM_LEVELS = new Set([...VERIFIED_LEVELS, 'untrusted_observation']);
const SHA256 = /^[0-9a-f]{64}$/i;
const MAX_RAW_EVIDENCE_REFS = 32;
const MAX_REFERENCE_LENGTH = 512;
const MAX_DIAGNOSTICS_BYTES = 65_536;
const SAFE_BEHAVIOR_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Instruments may have modest clock skew, but cannot claim observations from
// before this run or the distant future. Five minutes is the explicit bound.
const CLOCK_TOLERANCE_MS = 5 * 60 * 1_000;

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

async function sha256Handle(handle) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = handle.createReadStream({ autoClose: false });
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

async function atomicWriteJson(file, value, beforeRename) {
  const directory = path.dirname(file);
  // Initialization may create staged parents. Mutation paths have already been
  // ownership-checked and must never recreate a swapped or missing directory.
  if (!beforeRename) await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(file)}.tmp-${process.pid}-${randomUUID()}`);
  let handle;
  try {
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
    handle = await fs.open(temporary, flags, 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (beforeRename) await beforeRename();
    await fs.rename(temporary, file);
  } catch (error) {
    await handle?.close().catch(() => {});
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
    if (!SAFE_BEHAVIOR_ID.test(observation.id)) {
      throw new TypeError(`behavior ${observation.id} must use one safe behavior ID segment`);
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
  if (/[%\u0000-\u001f\u007f]/.test(value)
    || path.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || value.split(/[\\/]+/).includes('..')) {
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

function isContained(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function containedPath(parent, ...segments) {
  const candidate = path.resolve(parent, ...segments);
  if (!isContained(parent, candidate)) throw new TypeError('derived evidence path escapes its expected root');
  return candidate;
}

function portableRawComponents(reference) {
  if (reference.includes('\\')) throw new TypeError('raw evidence path must use portable forward-slash separators');
  const components = reference.split('/');
  for (const component of components) {
    const normalized = component.normalize('NFKC');
    if (component.length === 0 || component === '.' || component === '..') {
      throw new TypeError('raw evidence path contains an empty or dot component');
    }
    if (normalized !== component || !/^[A-Za-z0-9_-][A-Za-z0-9._ -]*$/.test(component)) {
      throw new TypeError(`raw evidence path component is not portable: ${component}`);
    }
    if (/[. ]$/.test(component) || component.includes(':')) {
      throw new TypeError(`raw evidence path component has a Windows alias: ${component}`);
    }
    const deviceBase = component.split('.')[0].toLowerCase();
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(deviceBase)) {
      throw new TypeError(`raw evidence path uses a reserved Windows device: ${component}`);
    }
  }
  return components;
}

function isRawEvidencePath(reference) {
  const components = portableRawComponents(reference);
  const lower = components.map((component) => component.normalize('NFKC').toLowerCase());
  const basename = lower.at(-1);
  if (lower.some((component) => component.startsWith('.'))) return false;
  if (lower.some((component) => ['tmp', 'temp', 'staging', 'lock', 'locks'].includes(component))) return false;
  if (lower.some((component) => component.includes('.tmp-') || component.includes('.staging-'))) return false;
  if (lower.some((component) => component.endsWith('.lock'))) return false;
  if (basename === 'result.json') return false;
  if (components.length === 1 && ['plan.json', 'platform.json', 'tools.json'].includes(basename)) return false;
  return true;
}

async function inspectEvidenceReference(root, reference) {
  if (!isRawEvidencePath(reference)) {
    throw new TypeError(`raw evidence path targets a mutable control file: ${reference}`);
  }
  const rootReal = await fs.realpath(root);
  const segments = reference.split(/[\\/]+/);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = containedPath(root, ...segments.slice(0, index + 1));
    let details;
    try {
      details = await fs.lstat(current);
    } catch (error) {
      if (error?.code === 'ENOENT') throw new TypeError(`rawEvidenceRefs entry does not exist: ${reference}`);
      throw error;
    }
    if (details.isSymbolicLink()) throw new TypeError(`rawEvidenceRefs entry must not traverse a symlink: ${reference}`);
    if (index < segments.length - 1 && !details.isDirectory()) {
      throw new TypeError(`rawEvidenceRefs parent must be a directory: ${reference}`);
    }
    if (index === segments.length - 1 && !details.isFile()) {
      throw new TypeError(`rawEvidenceRefs entry must be a regular file: ${reference}`);
    }
  }
  const real = await fs.realpath(current);
  if (!isContained(rootReal, real)) throw new TypeError(`rawEvidenceRefs entry escapes the bundle: ${reference}`);
  const details = await fs.lstat(current);
  let handle;
  try {
    handle = await fs.open(current, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile()) throw new TypeError(`rawEvidenceRefs entry must remain a regular file: ${reference}`);
    if (details.ino !== 0 && opened.ino !== 0 && (details.dev !== opened.dev || details.ino !== opened.ino)) {
      throw new TypeError(`rawEvidenceRefs entry changed during validation: ${reference}`);
    }
    const sha256 = await sha256Handle(handle);
    const after = await handle.stat();
    if (opened.size !== after.size || opened.mtimeMs !== after.mtimeMs) {
      throw new TypeError(`rawEvidenceRefs entry changed while hashing: ${reference}`);
    }
    return { path: reference, sha256, size: after.size };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function normalizeRecord(result, observation, profile, redactValues, root, runStartedMs) {
  if (typeof result.provider !== 'string' || result.provider.length === 0 || result.provider !== observation.provider) {
    throw new TypeError(`provider must match ${observation.provider}`);
  }
  if (typeof result.behaviorId !== 'string' || result.behaviorId !== observation.id) {
    throw new TypeError('behaviorId must explicitly match the destination behavior');
  }
  const rawEvidenceRefs = normalizeReferences(result.rawEvidenceRefs, 'rawEvidenceRefs');
  const diagnostics = redactDeep(result.diagnostics ?? {}, redactValues);
  if (Buffer.byteLength(JSON.stringify(diagnostics), 'utf8') > MAX_DIAGNOSTICS_BYTES) {
    throw new TypeError(`diagnostics must be at most ${MAX_DIAGNOSTICS_BYTES} bytes`);
  }

  const rawEvidence = [];
  for (const reference of rawEvidenceRefs) rawEvidence.push(await inspectEvidenceReference(root, reference));
  const normalized = {
    ...result,
    rawEvidenceRefs,
    rawEvidence,
    diagnostics,
  };
  if (!CLAIM_LEVELS.has(result.level)) return normalized;
  if (rawEvidenceRefs.length === 0) throw new TypeError('rawEvidenceRefs must be nonempty for a satisfying claim');
  const artifactSha256 = normalizeSha256(result.artifactSha256, 'artifactSha256');
  const targetIdentity = normalizeTargetIdentity(result.targetIdentity, profile.target);
  const startedAt = normalizeTimestamp(result.startedAt, 'startedAt');
  const endedAt = normalizeTimestamp(result.endedAt, 'endedAt');
  const now = Date.now();
  if (Date.parse(startedAt) < runStartedMs - CLOCK_TOLERANCE_MS
    || Date.parse(startedAt) > now + CLOCK_TOLERANCE_MS
    || Date.parse(endedAt) > now + CLOCK_TOLERANCE_MS) {
    throw new TypeError('evidence timestamps fall outside the bundle run window or future tolerance');
  }
  if (Date.parse(endedAt) < Date.parse(startedAt)) throw new TypeError('endedAt precedes startedAt');
  if (typeof result.toolVersion !== 'string' || result.toolVersion.trim().length === 0) {
    throw new TypeError('toolVersion must be nonempty');
  }
  Object.assign(normalized, {
    artifactSha256,
    targetIdentity,
    startedAt,
    endedAt,
    toolVersion: result.toolVersion.trim(),
  });
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

async function snapshotOwnedPath(target, kind) {
  const details = await fs.lstat(target);
  if (details.isSymbolicLink()) throw new Error(`evidence ownership rejected symlink replacement: ${target}`);
  if (kind === 'directory' && !details.isDirectory()) throw new Error(`evidence ownership expected directory: ${target}`);
  if (kind === 'file' && !details.isFile()) throw new Error(`evidence ownership expected file: ${target}`);
  return { dev: details.dev, ino: details.ino, kind };
}

function assertSameIdentity(expected, actual, target) {
  if (expected.kind !== actual.kind) throw new Error(`evidence ownership kind changed: ${target}`);
  // Node exposes stable dev/ino values on supported filesystems. When a platform
  // reports zero, owner-token and realpath checks remain the portable fallback.
  if (expected.ino !== 0 && actual.ino !== 0 && (expected.dev !== actual.dev || expected.ino !== actual.ino)) {
    throw new Error(`evidence ownership path was replaced: ${target}`);
  }
}

/** Create a fail-first, behavior-bound evidence bundle. */
export async function createEvidenceBundle(directory, profile, { redactValues = [] } = {}) {
  const runStartedMs = Date.now();
  const root = path.resolve(directory);
  const observations = assertProfile(profile);
  const records = new Map();
  let writeQueue = Promise.resolve();
  let finalized = false;
  const ownerToken = randomUUID();

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
    await fs.mkdir(path.join(staging, 'observations'));
    await atomicWriteJson(path.join(staging, 'result.json'), failureSummary(observations, records));
    for (const [behaviorId] of observations) {
      const observationsRoot = containedPath(staging, 'observations');
      const behaviorRoot = containedPath(observationsRoot, behaviorId);
      const resultPath = containedPath(behaviorRoot, 'result.json');
      await atomicWriteJson(resultPath, records.get(behaviorId));
    }
    await atomicWriteJson(path.join(staging, '.owner.json'), {
      owner: ownerToken,
      createdAt: new Date(runStartedMs).toISOString(),
    });
    await fs.rename(staging, root);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY'
      ? new Error(`evidence bundle already exists: ${root}`, { cause: error })
      : error;
  }

  const observationsRoot = containedPath(root, 'observations');
  const ownerPath = containedPath(root, '.owner.json');
  const rootResultPath = containedPath(root, 'result.json');
  const behaviorPaths = new Map();
  const behaviorResultPaths = new Map();
  for (const [behaviorId] of observations) {
    const behaviorRoot = containedPath(observationsRoot, behaviorId);
    behaviorPaths.set(behaviorId, behaviorRoot);
    behaviorResultPaths.set(behaviorId, containedPath(behaviorRoot, 'result.json'));
  }
  const rootReal = await fs.realpath(root);
  const expectedIdentities = {
    root: await snapshotOwnedPath(root, 'directory'),
    observations: await snapshotOwnedPath(observationsRoot, 'directory'),
    owner: await snapshotOwnedPath(ownerPath, 'file'),
    rootResult: await snapshotOwnedPath(rootResultPath, 'file'),
    behaviors: new Map(),
    behaviorResults: new Map(),
  };
  for (const [behaviorId] of observations) {
    expectedIdentities.behaviors.set(behaviorId, await snapshotOwnedPath(behaviorPaths.get(behaviorId), 'directory'));
    expectedIdentities.behaviorResults.set(behaviorId, await snapshotOwnedPath(behaviorResultPaths.get(behaviorId), 'file'));
  }

  async function verifyPath(target, kind, expected) {
    const actual = await snapshotOwnedPath(target, kind);
    assertSameIdentity(expected, actual, target);
    const real = await fs.realpath(target);
    if (!isContained(rootReal, real)) throw new Error(`evidence ownership path escapes bundle: ${target}`);
  }

  async function verifyOwnership(behaviorId) {
    await verifyPath(root, 'directory', expectedIdentities.root);
    if (await fs.realpath(root) !== rootReal) throw new Error('evidence ownership root realpath changed');
    await verifyPath(observationsRoot, 'directory', expectedIdentities.observations);
    await verifyPath(ownerPath, 'file', expectedIdentities.owner);
    const owner = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
    if (owner.owner !== ownerToken) throw new Error('evidence ownership token changed');
    await verifyPath(rootResultPath, 'file', expectedIdentities.rootResult);
    const selected = behaviorId === undefined ? [...observations.keys()] : [behaviorId];
    for (const id of selected) {
      if (!behaviorPaths.has(id)) continue;
      await verifyPath(behaviorPaths.get(id), 'directory', expectedIdentities.behaviors.get(id));
      await verifyPath(behaviorResultPaths.get(id), 'file', expectedIdentities.behaviorResults.get(id));
    }
  }

  async function validatePersistedClaims() {
    for (const [behaviorId, record] of records) {
      const persisted = JSON.parse(await fs.readFile(behaviorResultPaths.get(behaviorId), 'utf8'));
      if (JSON.stringify(persisted) !== JSON.stringify(record)) {
        throw new Error(`on-disk evidence claim changed for ${behaviorId}`);
      }
      if (!CLAIM_LEVELS.has(record.level)) continue;
      for (let index = 0; index < record.rawEvidenceRefs.length; index += 1) {
        const current = await inspectEvidenceReference(root, record.rawEvidenceRefs[index]);
        const expected = record.rawEvidence[index];
        if (current.sha256 !== expected.sha256 || current.size !== expected.size) {
          throw new Error(`raw evidence changed for ${behaviorId}: ${current.path}`);
        }
      }
    }
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
        await verifyOwnership(behaviorId);
        const observation = observations.get(behaviorId);
        if (!observation) throw new TypeError(`unknown behavior ${behaviorId}`);
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
          throw new TypeError('behavior result must be an object');
        }
        if (result.behaviorId !== undefined && result.behaviorId !== behaviorId) {
          throw new TypeError(`result behavior ${result.behaviorId} does not match ${behaviorId}`);
        }
        if (!RESULT_LEVELS.has(result.level) || result.level === 'not-run') {
          throw new TypeError(`unsupported caller evidence level ${result.level}; not-run is internal only`);
        }
        const validated = await normalizeRecord(result, observation, profile, redactValues, root, runStartedMs);
        const record = redactDeep({
          ...validated,
          behaviorId,
          provider: observation.provider,
          requiredLevel: observation.requiredLevel,
        }, redactValues);
        const resultPath = behaviorResultPaths.get(behaviorId);
        await verifyOwnership(behaviorId);
        // A path-based JS API cannot remove the final OS-level TOCTOU window.
        // Revalidate both immediately before temp creation and before rename;
        // O_EXCL/O_NOFOLLOW protects the newly created temporary leaf itself.
        await atomicWriteJson(resultPath, record, () => verifyOwnership(behaviorId));
        expectedIdentities.behaviorResults.set(behaviorId, await snapshotOwnedPath(resultPath, 'file'));
        records.set(behaviorId, record);
        return record;
      });
    },
    async finalize() {
      return serializeWrite(async () => {
        if (finalized) throw new Error('evidence bundle is finalized');
        await verifyOwnership();
        await validatePersistedClaims();
        const summary = redactDeep(failureSummary(observations, records), redactValues);
        await verifyOwnership();
        await atomicWriteJson(rootResultPath, summary, () => verifyOwnership());
        expectedIdentities.rootResult = await snapshotOwnedPath(rootResultPath, 'file');
        finalized = true;
        return summary;
      });
    },
  });
}
