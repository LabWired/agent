import fs from 'node:fs';
import path from 'node:path';

const MAX_TIMEOUT_SECONDS = 3600;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const SECRET_KEY = /(?:api[-_]?key|access[-_]?key|authorization|credential|cookie|pass(?:word)?|private[-_]?key|secret|token)/i;
const SECRET_ASSIGNMENT = /(?:api[-_]?key|access[-_]?key|authorization|credential|cookie|pass(?:word)?|private[-_]?key|secret|token)\s*[:=]/i;
const SECRET_VALUE = /\b(?:sk-[a-zA-Z0-9_-]{4,}|AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,})\b/;
const SECRET_URL_USERINFO = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]+@/i;
const BEARER_CREDENTIAL = /\bbearer[ \t]+[^\s,;]+/i;
const BASIC_CREDENTIAL = /\bbasic[ \t]+[a-z0-9+/]+={0,2}(?:\s|$|[,;])/i;
const AMBIGUOUS_IDENTITY = new Set(['auto', 'first', 'any', 'default']);

export const TRUSTED_PROVIDERS = Object.freeze({
  build: Object.freeze(['platformio', 'make', 'cmake']),
  twin: Object.freeze(['labwired-sim']),
  flash: Object.freeze(['platformio', 'probe-rs']),
  observation: Object.freeze(['serial', 'rtt', 'logic-csv', 'network']),
});

const REQUIRED_LEVELS = new Set([
  'compiled',
  'model_observed',
  'surrogate_model_observed',
  'hardware_observed',
  'untrusted_observation',
]);

function fail(location, message) {
  throw new TypeError(`${location}: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value, location) {
  if (!isRecord(value)) fail(location, 'must be an object');
  return value;
}

function exactKeys(value, allowed, location) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(location, `unknown key ${key}`);
  }
}

function containsInlineCredential(value) {
  return SECRET_ASSIGNMENT.test(value)
    || SECRET_VALUE.test(value)
    || SECRET_URL_USERINFO.test(value)
    || BEARER_CREDENTIAL.test(value)
    || BASIC_CREDENTIAL.test(value);
}

function requireString(value, location) {
  if (typeof value !== 'string' || value.length === 0) fail(location, 'must be a non-empty string');
  if (containsInlineCredential(value)) {
    fail(location, 'must not contain an inline credential value');
  }
  return value;
}

function identity(value, location) {
  const normalized = requireString(value, location).trim();
  if (normalized.length === 0) fail(location, 'must be a non-empty identity string');
  if (AMBIGUOUS_IDENTITY.has(normalized.trim().toLowerCase())) {
    fail(location, 'must not use an ambiguous identity');
  }
  return normalized;
}

function timeout(value, location) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) fail(location, 'timeout must be an integer');
  if (value < 1 || value > MAX_TIMEOUT_SECONDS) {
    fail(location, `timeout must be bounded between 1 and ${MAX_TIMEOUT_SECONDS}`);
  }
  return value;
}

function safeId(value, location) {
  const id = requireString(value, location);
  if (!SAFE_ID.test(id) || id === '.' || id === '..') fail(location, 'must be a safe id');
  return id;
}

function relativePath(value, location) {
  const candidate = requireString(value, location);
  if (path.isAbsolute(candidate) || path.win32.isAbsolute(candidate)) {
    fail(location, 'must be relative');
  }
  if (candidate.split(/[\\/]+/).includes('..')) fail(location, 'must not escape through ..');
  return candidate;
}

function realpathExistingPrefix(candidate, location) {
  let current = path.parse(candidate).root;
  const parts = path.resolve(candidate).slice(current.length).split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const details = fs.lstatSync(current);
      if (details.isSymbolicLink()) fail(location, 'must not contain a symlink or reparse point');
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      if (error instanceof TypeError) throw error;
      fail(location, `cannot resolve path: ${error.message}`);
    }
  }
  return current;
}

function containedPath(relative, root, rootReal, location) {
  const candidate = path.resolve(root, relativePath(relative, location));
  const resolvedPrefix = realpathExistingPrefix(candidate, location);
  const relativeToRoot = path.relative(rootReal, resolvedPrefix);
  if (relativeToRoot === '..' || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
    fail(location, 'must not escape the allowed workspace');
  }
  return candidate;
}

function normalizeWorkspace(value, profileDirectory) {
  const workspace = path.resolve(profileDirectory, relativePath(value, 'build.workspace'));
  const relativeToProfile = path.relative(profileDirectory, workspace);
  if (relativeToProfile === '..' || relativeToProfile.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToProfile)) {
    fail('build.workspace', 'must not escape the profile workspace');
  }
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    fail('build.workspace', 'must be an existing directory');
  }
  const workspaceReal = fs.realpathSync.native(workspace);
  const profileReal = fs.realpathSync.native(profileDirectory);
  const relativeToProfileReal = path.relative(profileReal, workspaceReal);
  if (relativeToProfileReal === '..' || relativeToProfileReal.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToProfileReal)) {
    fail('build.workspace', 'must not escape the profile workspace through a symlink');
  }
  return { workspace: workspaceReal, workspaceReal };
}

function provider(value, kind, location) {
  const selected = requireString(value, `${location}.provider`);
  if (!TRUSTED_PROVIDERS[kind].includes(selected)) {
    fail(`${location}.provider`, `provider ${selected} is not trusted`);
  }
  return selected;
}

function normalizeTarget(value) {
  const target = record(value, 'target');
  exactKeys(target, ['id', 'chip', 'probeSerial', 'serialPort'], 'target');
  return {
    id: safeId(identity(target.id, 'target.id'), 'target.id'),
    chip: identity(target.chip, 'target.chip'),
    ...(target.probeSerial === undefined ? {} : { probeSerial: identity(target.probeSerial, 'target.probeSerial') }),
    ...(target.serialPort === undefined ? {} : { serialPort: identity(target.serialPort, 'target.serialPort') }),
  };
}

function normalizeBuild(value, profileDirectory) {
  const build = record(value, 'build');
  exactKeys(build, ['provider', 'workspace', 'environment', 'artifact', 'timeoutSeconds'], 'build');
  const { workspace, workspaceReal } = normalizeWorkspace(build.workspace, profileDirectory);
  return {
    provider: provider(build.provider, 'build', 'build'),
    workspace,
    environment: requireString(build.environment, 'build.environment'),
    artifact: containedPath(build.artifact, workspace, workspaceReal, 'build.artifact'),
    ...(build.timeoutSeconds === undefined ? {} : { timeoutSeconds: timeout(build.timeoutSeconds, 'build.timeoutSeconds') }),
  };
}

function normalizeTwin(value, build) {
  if (value === undefined) return undefined;
  const twin = record(value, 'twin');
  exactKeys(twin, ['provider', 'system', 'artifactRelation', 'timeoutSeconds'], 'twin');
  const artifactRelation = requireString(twin.artifactRelation, 'twin.artifactRelation');
  if (!['exact', 'surrogate'].includes(artifactRelation)) fail('twin.artifactRelation', 'must be exact or surrogate');
  return {
    provider: provider(twin.provider, 'twin', 'twin'),
    system: containedPath(twin.system, build.workspace, build.workspace, 'twin.system'),
    artifactRelation,
    ...(twin.timeoutSeconds === undefined ? {} : { timeoutSeconds: timeout(twin.timeoutSeconds, 'twin.timeoutSeconds') }),
  };
}

function normalizeFlash(value) {
  if (value === undefined) return undefined;
  const flash = record(value, 'flash');
  exactKeys(flash, ['provider', 'timeoutSeconds'], 'flash');
  return {
    provider: provider(flash.provider, 'flash', 'flash'),
    ...(flash.timeoutSeconds === undefined ? {} : { timeoutSeconds: timeout(flash.timeoutSeconds, 'flash.timeoutSeconds') }),
  };
}

function normalizeObservation(value, index, build) {
  const location = `observations[${index}]`;
  const observation = record(value, location);
  const selectedProvider = requireString(observation.provider, `${location}.provider`);
  const keys = {
    serial: ['id', 'provider', 'contains', 'timeoutSeconds', 'requiredLevel'],
    rtt: ['id', 'provider', 'contains', 'timeoutSeconds', 'requiredLevel'],
    'logic-csv': ['id', 'provider', 'file', 'channel', 'timeColumn', 'valueColumn', 'edgeCountAtLeast', 'timeoutSeconds', 'requiredLevel'],
    network: ['id', 'provider', 'deviceMarker', 'hostProbeUrlFromMarker', 'hostProbePath', 'timeoutSeconds', 'requiredLevel'],
  };
  if (!keys[selectedProvider]) fail(`${location}.provider`, `provider ${selectedProvider} is not trusted`);
  exactKeys(observation, keys[selectedProvider], location);
  const requiredLevel = requireString(observation.requiredLevel, `${location}.requiredLevel`);
  if (!REQUIRED_LEVELS.has(requiredLevel)) fail(`${location}.requiredLevel`, 'is not supported');
  const normalized = {
    id: safeId(observation.id, `${location}.id`),
    provider: provider(selectedProvider, 'observation', location),
    requiredLevel,
    ...(observation.timeoutSeconds === undefined ? {} : { timeoutSeconds: timeout(observation.timeoutSeconds, `${location}.timeoutSeconds`) }),
  };
  if (selectedProvider === 'serial' || selectedProvider === 'rtt') {
    normalized.contains = requireString(observation.contains, `${location}.contains`);
  } else if (selectedProvider === 'logic-csv') {
    normalized.file = containedPath(observation.file, build.workspace, build.workspace, `${location}.file`);
    if (!Number.isInteger(observation.channel) || observation.channel < 0) fail(`${location}.channel`, 'must be a non-negative integer');
    if (!Number.isInteger(observation.edgeCountAtLeast) || observation.edgeCountAtLeast < 1) fail(`${location}.edgeCountAtLeast`, 'must be a positive integer');
    normalized.channel = observation.channel;
    normalized.timeColumn = requireString(observation.timeColumn, `${location}.timeColumn`);
    normalized.valueColumn = requireString(observation.valueColumn, `${location}.valueColumn`);
  } else {
    normalized.deviceMarker = requireString(observation.deviceMarker, `${location}.deviceMarker`);
    normalized.hostProbeUrlFromMarker = requireString(observation.hostProbeUrlFromMarker, `${location}.hostProbeUrlFromMarker`);
    normalized.hostProbePath = requireString(observation.hostProbePath, `${location}.hostProbePath`);
  }
  return normalized;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Validate and normalize an in-memory schema v1 hardware profile. */
export function validateHardwareProfile(value, sourcePath) {
  const profile = record(value, 'profile');
  exactKeys(profile, ['schema', 'target', 'build', 'twin', 'flash', 'observations'], 'profile');
  if (profile.schema !== 1) fail('schema', 'must equal 1');
  const profilePath = path.resolve(requireString(sourcePath, 'sourcePath'));
  const profileDirectory = path.dirname(profilePath);
  if (!fs.existsSync(profileDirectory)) fail('sourcePath', 'parent directory does not exist');
  const build = normalizeBuild(profile.build, profileDirectory);
  const target = normalizeTarget(profile.target);
  const flash = normalizeFlash(profile.flash);
  if (flash && (!target.probeSerial || !target.serialPort)) {
    fail('target', 'physical identity requires explicit probeSerial and serialPort');
  }
  if (!Array.isArray(profile.observations)) fail('observations', 'must be an array');
  const observations = profile.observations.map((observation, index) => normalizeObservation(observation, index, build));
  const ids = new Set();
  for (const observation of observations) {
    if (ids.has(observation.id)) fail('observations', `duplicate id ${observation.id}`);
    ids.add(observation.id);
  }
  for (const observation of observations) {
    if (observation.requiredLevel !== 'hardware_observed') continue;
    if (!target.probeSerial || !target.serialPort) {
      fail('target', 'physical observation requires explicit probeSerial and serialPort identity');
    }
  }
  return deepFreeze({
    schema: 1,
    target,
    build,
    ...(profile.twin === undefined ? {} : { twin: normalizeTwin(profile.twin, build) }),
    ...(flash === undefined ? {} : { flash }),
    observations,
  });
}

/** Read, parse, validate, and deeply freeze a hardware profile from JSON. */
export async function loadHardwareProfile(profilePath, options = {}) {
  if (!isRecord(options)) fail('options', 'must be an object');
  exactKeys(options, ['realpath'], 'options');
  const resolvedPath = path.resolve(requireString(profilePath, 'profilePath'));
  let parsed;
  try {
    parsed = JSON.parse(await fs.promises.readFile(resolvedPath, 'utf8'));
  } catch (error) {
    fail('profilePath', `cannot load JSON: ${error.message}`);
  }
  // Resolution is always symlink-aware; `realpath` remains accepted for callers of v1.
  if (options.realpath !== undefined && typeof options.realpath !== 'boolean') fail('options.realpath', 'must be a boolean');
  return validateHardwareProfile(parsed, resolvedPath);
}

/** Return a deterministic, recursively redacted plain-data profile representation. */
export function canonicalProfile(profile) {
  if (Array.isArray(profile)) return profile.map(canonicalProfile);
  if (!isRecord(profile)) return typeof profile === 'string' && containsInlineCredential(profile) ? '[REDACTED]' : profile;
  const canonical = {};
  for (const key of Object.keys(profile).sort()) {
    canonical[key] = SECRET_KEY.test(key) ? '[REDACTED]' : canonicalProfile(profile[key]);
  }
  return canonical;
}
