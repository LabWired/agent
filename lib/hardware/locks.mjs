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
const IDENTITY_TYPES = new Set(['probe', 'serial', 'target']);

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
    if (!IDENTITY_TYPES.has(type)) throw new TypeError(`Unsupported hardware identity type: ${type}`);
    if (typeof identity !== 'string' || identity.trim() === '') {
      throw new TypeError(`Explicit ${type} identity must be a non-empty string`);
    }
    if (identity.includes('\0')) throw new TypeError(`${type} identity contains an invalid character`);
  }
  return entries.sort(([left], [right]) => left.localeCompare(right));
}

async function prepareRoot(root) {
  if (typeof root !== 'string' || root === '' || !path.isAbsolute(root) || path.normalize(root) !== root) {
    throw new TypeError('Hardware lock root must be an absolute normalized path');
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Hardware lock root is not a safe directory');
  return realpath(root);
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
    || typeof record.type !== 'string' || !IDENTITY_TYPES.has(record.type)
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

async function removeProvenStale(lockPath, expected) {
  const { record, info } = await readExistingLock(lockPath, expected);
  const state = await processState(record);
  if (state === 'same') throw new Error(`Refusing competing live hardware lock for ${expected.type}`);

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
    await rm(quarantine);
  } catch (error) {
    try { await rename(quarantine, lockPath); } catch { /* Fail closed; preserve the quarantine. */ }
    throw error;
  }
}

async function acquireOne(root, entry, owner) {
  const [type, identity] = entry;
  const hash = identityHash(type, identity);
  const lockPath = path.join(root, `${type}-${hash}.lock`);
  const record = {
    schema: SCHEMA,
    version: VERSION,
    pid: owner.pid,
    processStart: owner.processStart,
    createdAt: new Date().toISOString(),
    identityHash: hash,
    type,
    token: randomBytes(32).toString('hex'),
  };
  const encoded = `${JSON.stringify(record)}\n`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    try {
      descriptor = await open(lockPath, 'wx', 0o600);
      await descriptor.writeFile(encoded, 'utf8');
      await descriptor.sync();
      const info = await descriptor.stat();
      await descriptor.close();
      return { lockPath, record, encoded, dev: info.dev, ino: info.ino };
    } catch (error) {
      if (descriptor) await descriptor.close().catch(() => {});
      if (error?.code !== 'EEXIST' || attempt > 0) throw error;
      await removeProvenStale(lockPath, { type, identityHash: hash });
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
    await rm(quarantine);
  } catch (error) {
    try { await rename(quarantine, acquired.lockPath); } catch { /* Preserve evidence if restoration races. */ }
    throw error;
  }
}

export async function acquireHardwareLocks(identities, { root, pid = process.pid, signal } = {}) {
  const entries = validateIdentities(identities);
  assertNotAborted(signal);
  const safeRoot = await prepareRoot(root);
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
      acquired.push(await acquireOne(safeRoot, entry, owner));
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
