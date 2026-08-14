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
const REQUIRED_LEVELS = new Set([
  'compiled',
  'model_observed',
  'surrogate_model_observed',
  'hardware_observed',
  'untrusted_observation',
]);
const VERIFIED_LEVELS = new Set(['compiled', 'model_observed', 'surrogate_model_observed', 'hardware_observed']);
const CLAIM_LEVELS = new Set([...VERIFIED_LEVELS, 'untrusted_observation']);
const SHA256 = /^[0-9a-f]{64}$/i;
const MAX_RAW_EVIDENCE_REFS = 32;
const MAX_REFERENCE_LENGTH = 512;
const MAX_DIAGNOSTICS_BYTES = 65_536;
const MAX_RECORD_BYTES = 128 * 1_024;
const MAX_CONTROL_JSON_BYTES = 256 * 1_024;
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

function serializeBoundedJson(value, maximumBytes, label) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > maximumBytes) {
    throw new TypeError(`${label} exceeds its ${maximumBytes}-byte size limit`);
  }
  return serialized;
}

async function atomicWriteJson(file, value, beforeRename, maximumBytes = MAX_CONTROL_JSON_BYTES) {
  const directory = path.dirname(file);
  // Initialization may create staged parents. Mutation paths have already been
  // ownership-checked and must never recreate a swapped or missing directory.
  if (!beforeRename) await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(file)}.tmp-${process.pid}-${randomUUID()}`);
  const serialized = serializeBoundedJson(value, maximumBytes, path.basename(file));
  let handle;
  try {
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
    handle = await fs.open(temporary, flags, 0o600);
    await handle.writeFile(serialized, 'utf8');
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
  const portableIdentities = new Set();
  for (const observation of profile.observations) {
    if (!observation || typeof observation.id !== 'string' || typeof observation.requiredLevel !== 'string') {
      throw new TypeError('each observation needs an id and requiredLevel');
    }
    const portableIdentity = validatePortableComponent(observation.id, 'behavior ID', { allowSpaces: false });
    if (observations.has(observation.id)) throw new TypeError(`duplicate behavior ${observation.id}`);
    if (portableIdentities.has(portableIdentity)) {
      throw new TypeError(`duplicate portable identity for behavior ${observation.id}`);
    }
    portableIdentities.add(portableIdentity);
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

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const output = {};
    for (const key of Object.keys(value).sort()) output[key] = canonicalize(value[key]);
    return output;
  }
  return value;
}

function manifestSha256(owner, records, summary) {
  const behaviorRecords = {};
  for (const [behaviorId, record] of [...records].sort(([left], [right]) => left.localeCompare(right))) {
    behaviorRecords[behaviorId] = record;
  }
  const canonical = JSON.stringify(canonicalize({ schema: 1, owner, behaviorRecords, summary }));
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
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
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(expected ?? {}, key)) throw new TypeError(`target identity has unknown key ${key}`);
  }
  for (const [key, expectedValue] of Object.entries(expected ?? {})) {
    if (value[key] !== expectedValue) throw new TypeError(`target identity ${key} does not match the profile`);
  }
  return { ...value };
}

const CALLER_RECORD_KEYS = Object.freeze({
  blocked: ['behaviorId', 'provider', 'level', 'rawEvidenceRefs', 'diagnostics'],
  failed: ['behaviorId', 'provider', 'level', 'rawEvidenceRefs', 'diagnostics'],
  compiled: [
    'behaviorId', 'provider', 'level', 'artifactSha256', 'targetIdentity', 'startedAt', 'endedAt',
    'toolVersion', 'rawEvidenceRefs', 'diagnostics', 'claim',
  ],
  model_observed: [
    'behaviorId', 'provider', 'level', 'artifactSha256', 'targetIdentity', 'startedAt', 'endedAt',
    'toolVersion', 'rawEvidenceRefs', 'diagnostics', 'nativeArtifactSha256',
  ],
  surrogate_model_observed: [
    'behaviorId', 'provider', 'level', 'artifactSha256', 'targetIdentity', 'startedAt', 'endedAt',
    'toolVersion', 'rawEvidenceRefs', 'diagnostics', 'surrogateArtifactSha256', 'sharedSourcePaths',
  ],
  hardware_observed: [
    'behaviorId', 'provider', 'level', 'artifactSha256', 'targetIdentity', 'startedAt', 'endedAt',
    'toolVersion', 'rawEvidenceRefs', 'diagnostics', 'flashedArtifactSha256',
  ],
  untrusted_observation: [
    'behaviorId', 'provider', 'level', 'artifactSha256', 'targetIdentity', 'startedAt', 'endedAt',
    'toolVersion', 'rawEvidenceRefs', 'diagnostics',
  ],
});

function projectCallerRecord(result) {
  const allowed = CALLER_RECORD_KEYS[result.level];
  if (!allowed) throw new TypeError(`unsupported caller evidence level ${result.level}; not-run is internal only`);
  for (const key of Object.keys(result)) {
    if (!allowed.includes(key)) throw new TypeError(`unknown caller evidence key ${key} for level ${result.level}`);
  }
  const projected = {};
  for (const key of allowed) {
    if (Object.hasOwn(result, key)) projected[key] = result[key];
  }
  return projected;
}

function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${label} has unknown key ${key}`);
  }
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

function validatePortableComponent(component, label, { allowSpaces }) {
  const normalized = typeof component === 'string' ? component.normalize('NFKC') : '';
  if (component.length === 0 || component === '.' || component === '..') {
    throw new TypeError(`${label} contains an empty or dot component`);
  }
  const grammar = allowSpaces
    ? /^[A-Za-z0-9_-][A-Za-z0-9._ -]*$/
    : /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  if (normalized !== component || !grammar.test(component) || /[. ]$/.test(component) || component.includes(':')) {
    throw new TypeError(`${label} component is not portable: ${component}`);
  }
  const deviceBase = normalized.split('.')[0].toLowerCase();
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(deviceBase)) {
    throw new TypeError(`${label} uses a reserved Windows device: ${component}`);
  }
  return normalized.toLowerCase();
}

function portableRawComponents(reference) {
  if (reference.includes('\\')) throw new TypeError('raw evidence path must use portable forward-slash separators');
  const components = reference.split('/');
  for (const component of components) validatePortableComponent(component, 'raw evidence path', { allowSpaces: true });
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
  if (result.level === 'compiled') {
    if (result.claim !== undefined && result.claim !== 'compiled_only') {
      throw new TypeError('compiled claim must equal compiled_only when provided');
    }
  } else if (result.level === 'model_observed') {
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
  const ownerManifest = {
    schema: 1,
    owner: ownerToken,
    createdAt: new Date(runStartedMs).toISOString(),
    targetIdentity: redactDeep(profile.target ?? {}, redactValues),
    behaviors: [...observations.values()].map((observation) => ({
      id: observation.id,
      provider: observation.provider,
      requiredLevel: observation.requiredLevel,
    })),
  };
  try {
    await fs.mkdir(path.join(staging, 'observations'));
    await atomicWriteJson(path.join(staging, 'result.json'), failureSummary(observations, records));
    for (const [behaviorId] of observations) {
      const observationsRoot = containedPath(staging, 'observations');
      const behaviorRoot = containedPath(observationsRoot, behaviorId);
      const resultPath = containedPath(behaviorRoot, 'result.json');
      await atomicWriteJson(resultPath, records.get(behaviorId), undefined, MAX_RECORD_BYTES);
    }
    await atomicWriteJson(path.join(staging, '.owner.json'), ownerManifest);
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
    const owner = await readContainedJson(rootReal, ownerPath, 'owner marker');
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
      const persisted = await readContainedJson(
        rootReal,
        behaviorResultPaths.get(behaviorId),
        `behavior result ${behaviorId}`,
        MAX_RECORD_BYTES,
      );
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
        const projected = projectCallerRecord(result);
        const validated = await normalizeRecord(projected, observation, profile, redactValues, root, runStartedMs);
        const record = redactDeep({
          ...validated,
          behaviorId,
          provider: observation.provider,
          requiredLevel: observation.requiredLevel,
        }, redactValues);
        serializeBoundedJson(record, MAX_RECORD_BYTES, `behavior record ${behaviorId}`);
        const resultPath = behaviorResultPaths.get(behaviorId);
        await verifyOwnership(behaviorId);
        // A path-based JS API cannot remove the final OS-level TOCTOU window.
        // Revalidate both immediately before temp creation and before rename;
        // O_EXCL/O_NOFOLLOW protects the newly created temporary leaf itself.
        await atomicWriteJson(resultPath, record, () => verifyOwnership(behaviorId), MAX_RECORD_BYTES);
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
        return { ...summary, manifestSha256: manifestSha256(ownerManifest, records, summary) };
      });
    },
  });
}

async function readBoundedText(file, maximumBytes, label) {
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const details = await handle.stat();
    if (details.size > maximumBytes) throw new Error(`${label} exceeds its ${maximumBytes}-byte size limit`);
    const buffer = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset <= maximumBytes) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maximumBytes) throw new Error(`${label} exceeds its ${maximumBytes}-byte size limit`);
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readContainedJson(rootReal, file, label, maximumBytes = MAX_CONTROL_JSON_BYTES) {
  const details = await fs.lstat(file);
  if (details.isSymbolicLink() || !details.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
  const real = await fs.realpath(file);
  if (!isContained(rootReal, real)) throw new Error(`${label} escapes the evidence bundle`);
  return JSON.parse(await readBoundedText(file, maximumBytes, label));
}

async function verifyPersistedBundle(directory) {
  const root = path.resolve(directory);
  const rootDetails = await fs.lstat(root);
  if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) {
    throw new Error('evidence root must be a real directory, not a symlink or replacement');
  }
  const rootReal = await fs.realpath(root);

  const owner = await readContainedJson(rootReal, containedPath(root, '.owner.json'), 'owner marker');
  assertExactKeys(owner, ['schema', 'owner', 'createdAt', 'targetIdentity', 'behaviors'], 'owner marker');
  if (owner.schema !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(owner.owner)) {
    throw new Error('owner marker identity is invalid');
  }
  const runStartedMs = Date.parse(owner.createdAt);
  if (!Number.isFinite(runStartedMs) || runStartedMs > Date.now() + CLOCK_TOLERANCE_MS) {
    throw new Error('owner marker timestamp is invalid');
  }
  if (!owner.targetIdentity || typeof owner.targetIdentity !== 'object' || Array.isArray(owner.targetIdentity)) {
    throw new Error('owner target identity is invalid');
  }
  if (!Array.isArray(owner.behaviors)) throw new Error('owner behavior manifest is invalid');

  const manifest = new Map();
  const portableIdentities = new Set();
  for (const behavior of owner.behaviors) {
    if (!behavior || typeof behavior.id !== 'string') throw new Error('owner behavior ID is invalid');
    assertExactKeys(behavior, ['id', 'provider', 'requiredLevel'], 'owner behavior');
    const portableIdentity = validatePortableComponent(behavior.id, 'behavior ID', { allowSpaces: false });
    if (manifest.has(behavior.id) || portableIdentities.has(portableIdentity)) {
      throw new Error(`duplicate behavior identity in owner manifest: ${behavior.id}`);
    }
    if (typeof behavior.provider !== 'string' || behavior.provider.length === 0) {
      throw new Error(`owner behavior provider is invalid: ${behavior.id}`);
    }
    if (!REQUIRED_LEVELS.has(behavior.requiredLevel)) {
      throw new Error(`owner required level is invalid: ${behavior.id}`);
    }
    portableIdentities.add(portableIdentity);
    manifest.set(behavior.id, behavior);
  }

  const observationsRoot = containedPath(root, 'observations');
  const observationsDetails = await fs.lstat(observationsRoot);
  if (observationsDetails.isSymbolicLink() || !observationsDetails.isDirectory()) {
    throw new Error('observations root must be a real directory');
  }
  if (!isContained(rootReal, await fs.realpath(observationsRoot))) throw new Error('observations root escapes the bundle');
  const entries = await fs.readdir(observationsRoot, { withFileTypes: true });
  const behaviorDirectories = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
  if (behaviorDirectories.length !== manifest.size) throw new Error('observation directories do not match the owner manifest');
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink() && manifest.has(entry.name)) continue;
    if (entry.isFile() && !entry.isSymbolicLink() && isRawEvidencePath(`observations/${entry.name}`)) continue;
    {
      throw new Error(`unexpected observation directory: ${entry.name}`);
    }
  }

  const records = new Map();
  for (const [behaviorId, behavior] of manifest) {
    const behaviorRoot = containedPath(observationsRoot, behaviorId);
    const behaviorDetails = await fs.lstat(behaviorRoot);
    if (behaviorDetails.isSymbolicLink() || !behaviorDetails.isDirectory()) {
      throw new Error(`behavior directory is not owned: ${behaviorId}`);
    }
    if (!isContained(rootReal, await fs.realpath(behaviorRoot))) throw new Error(`behavior directory escapes: ${behaviorId}`);
    const record = await readContainedJson(
      rootReal,
      containedPath(behaviorRoot, 'result.json'),
      `behavior result ${behaviorId}`,
      MAX_RECORD_BYTES,
    );
    if (record.behaviorId !== behaviorId
      || record.provider !== behavior.provider
      || record.requiredLevel !== behavior.requiredLevel
      || !RESULT_LEVELS.has(record.level)) {
      throw new Error(`behavior result binding is invalid: ${behaviorId}`);
    }
    if (record.level === 'not-run') {
      const initial = { behaviorId, provider: behavior.provider, requiredLevel: behavior.requiredLevel, level: 'not-run' };
      if (JSON.stringify(record) !== JSON.stringify(initial)) throw new Error(`not-run record was mutated: ${behaviorId}`);
    } else {
      const callerKeys = CALLER_RECORD_KEYS[record.level];
      if (!callerKeys) throw new Error(`persisted behavior level is invalid: ${behaviorId}`);
      assertExactKeys(record, [...callerKeys, 'requiredLevel', 'rawEvidence'], `behavior result ${behaviorId}`);
      const normalized = await normalizeRecord(
        record,
        behavior,
        { target: owner.targetIdentity },
        [],
        root,
        runStartedMs,
      );
      if (JSON.stringify(normalized) !== JSON.stringify(record)) {
        throw new Error(`behavior result provenance or raw evidence changed: ${behaviorId}`);
      }
    }
    records.set(behaviorId, record);
  }

  const persistedSummary = await readContainedJson(rootReal, containedPath(root, 'result.json'), 'top-level result');
  const recomputed = failureSummary(manifest, records);
  if (JSON.stringify(persistedSummary) !== JSON.stringify(recomputed)) {
    throw new Error('top-level result does not match reverified behavior evidence');
  }
  return {
    structuralResult: recomputed.result,
    manifestSha256: manifestSha256(owner, records, recomputed),
    reasons: recomputed.reasons,
  };
}

/**
 * Reopen and independently verify a persisted evidence bundle.
 *
 * Consumers must supply the out-of-bundle receipt returned by `finalize()`
 * before trusting a persisted PASS. Without `expectedManifestSha256`, this API
 * reports structural consistency only and deliberately returns an unverified
 * FAIL; `result.json` alone is never authoritative readiness evidence.
 */
export async function verifyEvidenceBundle(directory, options = {}) {
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options must be an object');
    for (const key of Object.keys(options)) {
      if (key !== 'expectedManifestSha256') throw new TypeError(`unknown verification option ${key}`);
    }
    const structural = await verifyPersistedBundle(directory);
    if (options.expectedManifestSha256 === undefined) {
      return {
        valid: false,
        result: 'FAIL',
        authenticity: 'unverified',
        structuralResult: structural.structuralResult,
        manifestSha256: structural.manifestSha256,
        reasons: [{ code: 'receipt_required', message: 'external manifest receipt is required to authenticate this bundle' }],
      };
    }
    const expected = normalizeSha256(options.expectedManifestSha256, 'expectedManifestSha256');
    if (expected !== structural.manifestSha256) {
      return {
        valid: false,
        result: 'FAIL',
        authenticity: 'unverified',
        structuralResult: structural.structuralResult,
        manifestSha256: structural.manifestSha256,
        reasons: [{ code: 'receipt_mismatch', message: 'external manifest receipt does not match the evidence bundle' }],
      };
    }
    return {
      valid: true,
      result: structural.structuralResult,
      authenticity: 'verified',
      manifestSha256: structural.manifestSha256,
      reasons: structural.reasons,
    };
  } catch (error) {
    return {
      valid: false,
      result: 'FAIL',
      authenticity: 'unverified',
      reasons: [{ code: 'integrity_error', message: error?.message ?? String(error) }],
    };
  }
}
