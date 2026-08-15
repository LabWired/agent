import { constants as fsConstants } from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SCHEMA = 'labwired.hardware-lock';
const VERSION = 1;
const IDENTITY_TYPES = new Set(['instrument', 'probe', 'serial', 'target']);
const INSTRUMENT_TYPE = /^instrument-[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const AMBIGUOUS_IDENTITIES = new Set(['auto', 'first', 'any', 'default']);

function abortError() {
  const error = new Error('Hardware lock acquisition aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function validateIdentities(identities) {
  if (!identities || typeof identities !== 'object' || Array.isArray(identities)) {
    throw new TypeError('Hardware identities must be an object');
  }
  const entries = Object.entries(identities);
  if (entries.length === 0) throw new TypeError('At least one explicit hardware identity is required');
  for (const [type, identity] of entries) {
    if (!IDENTITY_TYPES.has(type) && !INSTRUMENT_TYPE.test(type)) throw new TypeError(`Unsupported hardware identity type: ${type}`);
    if (typeof identity !== 'string' || identity.trim() === '') {
      throw new TypeError(`Explicit ${type} identity must be a non-empty string`);
    }
    if (AMBIGUOUS_IDENTITIES.has(identity.trim().toLocaleLowerCase('en-US'))) {
      throw new TypeError(`Ambiguous ${type} identity is not allowed`);
    }
    if (identity.includes('\0')) throw new TypeError(`${type} identity contains an invalid character`);
  }
  return entries.map(([type, identity]) => [type.startsWith('instrument-') ? 'instrument' : type, identity])
    .sort(([leftType, leftIdentity], [rightType, rightIdentity]) => leftType.localeCompare(rightType) || leftIdentity.localeCompare(rightIdentity));
}

function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US')
    : left === right;
}

function rootComponents(root) {
  const parsed = path.parse(root);
  const relative = root.slice(parsed.root.length);
  const parts = relative.split(path.sep).filter(Boolean);
  const components = [parsed.root];
  for (const part of parts) components.push(path.join(components.at(-1), part));
  return components;
}

async function inspectSafeRoot(root, { create }) {
  for (const component of rootComponents(root)) {
    let info;
    try {
      info = await lstat(component);
    } catch (error) {
      if (error?.code !== 'ENOENT' || !create) throw error;
      await mkdir(component, { mode: 0o700 });
      info = await lstat(component);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Unsafe symbolic or reparse component in hardware lock root: ${component}`);
    }
  }
  const resolved = await realpath(root);
  if (!samePath(resolved, root)) {
    throw new Error('Hardware lock root resolves through a symbolic alias');
  }
  const leaf = await lstat(root);
  return { root: resolved, dev: leaf.dev, ino: leaf.ino };
}

async function prepareRoot(root) {
  if (typeof root !== 'string' || root === '' || !path.isAbsolute(root) || path.normalize(root) !== root) {
    throw new TypeError('Hardware lock root must be an absolute normalized path');
  }
  return inspectSafeRoot(root, { create: true });
}

async function revalidateRoot(expected) {
  const current = await inspectSafeRoot(expected.root, { create: false });
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error('Hardware lock root changed before lock mutation');
  }
}

function identityHash(type, identity) {
  return createHash('sha256').update(`${type}\0${identity}`, 'utf8').digest('hex');
}

async function linuxProcessStart(pid) {
  const [stat, bootId] = await Promise.all([
    readFile(`/proc/${pid}/stat`, 'utf8'),
    readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
  ]);
  const closingParen = stat.lastIndexOf(')');
  if (closingParen < 0) throw new Error('Malformed process stat');
  const fieldsAfterCommand = stat.slice(closingParen + 2).trim().split(/\s+/);
  const startTicks = fieldsAfterCommand[19];
  if (!startTicks) throw new Error('Missing process start time');
  return `linux:${bootId.trim()}:${startTicks}`;
}

async function processStart(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError('Lock PID must be a positive integer');
  if (process.platform === 'linux') return linuxProcessStart(pid);
  if (process.platform === 'darwin' || /bsd$/i.test(process.platform)) {
    const { stdout } = await execFileAsync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    });
    const value = stdout.trim();
    if (!value) {
      const error = new Error(`Process ${pid} is absent`);
      error.code = 'ESRCH';
      throw error;
    }
    return `${process.platform}:${value}`;
  }
  if (process.platform === 'win32') {
    const escapedPid = String(pid);
    const command = `(Get-CimInstance Win32_Process -Filter \"ProcessId=${escapedPid}\").CreationDate.ToUniversalTime().ToString('o')`;
    const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    });
    const value = stdout.trim();
    if (!value) {
      const error = new Error(`Process ${pid} is absent`);
      error.code = 'ESRCH';
      throw error;
    }
    return `win32:${value}`;
  }
  throw new Error(`Cannot reliably identify process instances on ${process.platform}`);
}

async function processState(record) {
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    if (error?.code === 'ESRCH') return 'absent';
    throw new Error(`Cannot safely determine lock owner status: ${error?.code ?? error}`);
  }
  let currentStart;
  try {
    currentStart = await processStart(record.pid);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return 'absent';
    throw new Error(`Cannot safely identify lock owner process: ${error?.message ?? error}`);
  }
  return currentStart === record.processStart ? 'same' : 'reused';
}

function validateRecord(record, expected) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || record.schema !== SCHEMA || record.version !== VERSION
    || !Number.isSafeInteger(record.pid) || record.pid <= 0
    || typeof record.processStart !== 'string' || record.processStart === ''
    || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))
    || typeof record.identityHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.identityHash)
    || typeof record.type !== 'string' || (!IDENTITY_TYPES.has(record.type) && !INSTRUMENT_TYPE.test(record.type))
    || typeof record.token !== 'string' || !/^[a-f0-9]{64}$/.test(record.token)) {
    throw new Error('Hardware lock is corrupt or malformed');
  }
  if (record.type !== expected.type || record.identityHash !== expected.identityHash) {
    throw new Error('Hardware lock identity does not match its path');
  }
}

async function readExistingLock(lockPath, expected) {
  const info = await lstat(lockPath);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('Unsafe symbolic or non-file hardware lock');
  const descriptor = await open(lockPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const record = JSON.parse(await descriptor.readFile({ encoding: 'utf8' }));
    validateRecord(record, expected);
    return { record, info };
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Hardware lock is corrupt or malformed');
    throw error;
  } finally {
    await descriptor.close();
  }
}

async function removeProvenStale(lockPath, expected, rootState, hooks) {
  const { record, info } = await readExistingLock(lockPath, expected);
  const state = await processState(record);
  if (state === 'same') throw new Error(`Refusing competing live hardware lock for ${expected.type}`);

  await hooks.beforeStaleMutation?.();
  await revalidateRoot(rootState);
  const quarantine = `${lockPath}.stale-${randomBytes(16).toString('hex')}`;
  await rename(lockPath, quarantine);
  try {
    const moved = await lstat(quarantine);
    if (moved.dev !== info.dev || moved.ino !== info.ino) {
      throw new Error('Hardware lock changed during stale recovery');
    }
    const movedRecord = JSON.parse(await readFile(quarantine, 'utf8'));
    validateRecord(movedRecord, expected);
    if (movedRecord.token !== record.token) throw new Error('Hardware lock changed during stale recovery');
    await revalidateRoot(rootState);
    await rm(quarantine);
  } catch (error) {
    try {
      await revalidateRoot(rootState);
      await rename(quarantine, lockPath);
    } catch { /* Fail closed; preserve the quarantine. */ }
    throw error;
  }
}

async function cleanupFailedCreation(created) {
  if (!created) return;
  await revalidateRoot(created.rootState);
  let info;
  try {
    info = await lstat(created.lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()
    || info.dev !== created.dev || info.ino !== created.ino) {
    throw new Error('Refusing to clean up a replaced hardware lock after initialization failure');
  }
  const quarantine = `${created.lockPath}.failed-${randomBytes(16).toString('hex')}`;
  await rename(created.lockPath, quarantine);
  const moved = await lstat(quarantine);
  if (moved.isSymbolicLink() || !moved.isFile()
    || moved.dev !== created.dev || moved.ino !== created.ino) {
    try {
      await revalidateRoot(created.rootState);
      await rename(quarantine, created.lockPath);
    } catch { /* Preserve evidence. */ }
    throw new Error('Refusing to remove a replaced hardware lock after initialization failure');
  }
  await revalidateRoot(created.rootState);
  await rm(quarantine);
}

async function acquireOne(rootState, entry, owner, hooks) {
  const [type, identity] = entry;
  const hash = identityHash(type, identity);
  const lockPath = path.join(rootState.root, `${type}-${hash}.lock`);
  const record = {
    schema: SCHEMA,
    version: VERSION,
    token: randomBytes(32).toString('hex'),
    pid: owner.pid,
    processStart: owner.processStart,
    createdAt: new Date().toISOString(),
    identityHash: hash,
    type,
  };
  const encoded = `${JSON.stringify(record)}\n`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    let created;
    try {
      await hooks.beforeLockMutation?.();
      await revalidateRoot(rootState);
      descriptor = await (hooks.openLock ?? open)(lockPath, 'wx', 0o600);
      const initialInfo = await descriptor.stat();
      created = { lockPath, dev: initialInfo.dev, ino: initialInfo.ino, rootState };
      await descriptor.writeFile(encoded, 'utf8');
      await descriptor.sync();
      const info = await descriptor.stat();
      await descriptor.close();
      return { lockPath, record, encoded, dev: info.dev, ino: info.ino, rootState };
    } catch (error) {
      if (descriptor) await descriptor.close().catch(() => {});
      if (created) {
        try {
          await cleanupFailedCreation(created);
        } catch (cleanupError) {
          error.cause = cleanupError;
        }
      }
      if (error?.code !== 'EEXIST' || attempt > 0) throw error;
      await hooks.beforeLockMutation?.();
      await revalidateRoot(rootState);
      await removeProvenStale(lockPath, { type, identityHash: hash }, rootState, hooks);
    }
  }
  throw new Error(`Could not acquire hardware lock for ${type}`);
}

async function releaseOne(acquired) {
  let info;
  try {
    info = await lstat(acquired.lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  await revalidateRoot(acquired.rootState);
  if (info.isSymbolicLink() || !info.isFile() || info.dev !== acquired.dev || info.ino !== acquired.ino) {
    throw new Error('Refusing to release a replaced hardware lock: ownership changed');
  }
  const quarantine = `${acquired.lockPath}.release-${randomBytes(16).toString('hex')}`;
  await rename(acquired.lockPath, quarantine);
  try {
    const moved = await lstat(quarantine);
    const current = await readFile(quarantine, 'utf8');
    if (moved.dev !== acquired.dev || moved.ino !== acquired.ino || current !== acquired.encoded) {
      throw new Error('Refusing to release a replaced hardware lock: ownership token changed');
    }
    await revalidateRoot(acquired.rootState);
    await rm(quarantine);
  } catch (error) {
    try {
      await revalidateRoot(acquired.rootState);
      await rename(quarantine, acquired.lockPath);
    } catch { /* Preserve evidence if restoration races. */ }
    throw error;
  }
}

async function acquireHardwareLocksInternal(identities, { root, pid = process.pid, signal } = {}, hooks = {}) {
  const entries = validateIdentities(identities);
  assertNotAborted(signal);
  const rootState = await prepareRoot(root);
  assertNotAborted(signal);
  const owner = { pid, processStart: await processStart(pid) };
  const acquired = [];
  let releasePromise;
  const release = () => {
    if (!releasePromise) {
      releasePromise = (async () => {
        const errors = [];
        for (const item of [...acquired].reverse()) {
          try { await releaseOne(item); } catch (error) { errors.push(error); }
        }
        if (errors.length) {
          throw new AggregateError(errors, `Failed to release one or more hardware locks: ${errors[0].message}`);
        }
      })();
    }
    return releasePromise;
  };

  try {
    for (const entry of entries) {
      assertNotAborted(signal);
      acquired.push(await acquireOne(rootState, entry, owner, hooks));
    }
    assertNotAborted(signal);
  } catch (error) {
    await release().catch((releaseError) => { error.cause = releaseError; });
    throw error;
  }

  const onAbort = () => { void release().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const records = acquired.map(({ record }) => Object.freeze({ ...record }));
  return {
    records: Object.freeze(records),
    async release() {
      signal?.removeEventListener('abort', onAbort);
      return release();
    },
  };
}

export async function acquireHardwareLocks(identities, options) {
  return acquireHardwareLocksInternal(identities, options);
}

export const __testing = Object.freeze({
  acquireHardwareLocks: acquireHardwareLocksInternal,
});
