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

/** Create a fail-first, behavior-bound evidence bundle. */
export async function createEvidenceBundle(directory, profile, { redactValues = [] } = {}) {
  const root = path.resolve(directory);
  const observations = assertProfile(profile);
  const records = new Map();
  let writeQueue = Promise.resolve();

  await fs.mkdir(root, { recursive: true });
  for (const [behaviorId, observation] of observations) {
    const initial = redactDeep({
      behaviorId,
      provider: observation.provider,
      requiredLevel: observation.requiredLevel,
      level: 'not-run',
    }, redactValues);
    records.set(behaviorId, initial);
  }
  // Persist FAIL before any later initialization step can be interrupted.
  await atomicWriteJson(path.join(root, 'result.json'), failureSummary(observations, records));
  for (const [behaviorId] of observations) {
    const initial = records.get(behaviorId);
    await atomicWriteJson(path.join(root, 'observations', behaviorId, 'result.json'), initial);
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
        const observation = observations.get(behaviorId);
        if (!observation) throw new TypeError(`unknown behavior ${behaviorId}`);
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
          throw new TypeError('behavior result must be an object');
        }
        if (result.behaviorId !== undefined && result.behaviorId !== behaviorId) {
          throw new TypeError(`result behavior ${result.behaviorId} does not match ${behaviorId}`);
        }
        if (!RESULT_LEVELS.has(result.level)) throw new TypeError(`unsupported evidence level ${result.level}`);
        const record = redactDeep({
          ...result,
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
        const summary = redactDeep(failureSummary(observations, records), redactValues);
        await atomicWriteJson(path.join(root, 'result.json'), summary);
        return summary;
      });
    },
  });
}
