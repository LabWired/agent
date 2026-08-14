import { constants as fsConstants } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { redactDeep } from './evidence.mjs';
import { resolveLaunch, runLaunch } from './process.mjs';

const SAFE_ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const MAX_SIMULATOR_RESULT_BYTES = 128 * 1024;
const SIMULATOR_EVIDENCE_REF = 'twin/simulator-output.json';
const MAX_PHYSICAL_EVIDENCE_BYTES = 64 * 1024;

function assertProfile(profile) {
  if (!profile?.build || typeof profile.build.workspace !== 'string' || typeof profile.build.artifact !== 'string') {
    throw new TypeError('a validated hardware profile is required');
  }
}

function contained(candidate, root, label) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new TypeError(`${label} must be contained by the build workspace`);
  }
  return resolved;
}

async function executableOnPath(name, environment) {
  if (path.isAbsolute(name)) return name;
  const separator = process.platform === 'win32' ? ';' : ':';
  const extensions = process.platform === 'win32'
    ? String(environment.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const directory of String(environment.PATH ?? '').split(separator).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension.toLowerCase()}`);
      try {
        await fs.access(candidate, fsConstants.X_OK);
        return candidate;
      } catch { /* continue */ }
    }
  }
  throw new Error(`trusted tool ${name} was not found`);
}

function launch(executable, args, cwd, env) {
  return Object.freeze({
    executable,
    args: Object.freeze([...args]),
    cwd,
    env: Object.freeze({ ...env }),
    shell: false,
  });
}

async function artifactSnapshot(file, workspace, hooks = {}, options = {}) {
  let handle;
  try {
    const checked = contained(file, workspace, 'build artifact');
    const workspacePath = path.resolve(workspace);
    const workspaceDetails = await fs.lstat(workspacePath);
    if (workspaceDetails.isSymbolicLink() || !workspaceDetails.isDirectory()) throw new TypeError('workspace must be a real directory');
    const relative = path.relative(workspacePath, checked);
    let current = workspacePath;
    let details;
    for (const component of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      details = await fs.lstat(current, { bigint: true });
      if (details.isSymbolicLink()) throw new TypeError('artifact path must not contain a symlink');
    }
    if (!details?.isFile()) throw new TypeError('build artifact must be a regular non-symlink file');
    const pathnameIdentity = { dev: details.dev.toString(), ino: details.ino.toString() };
    await hooks.afterLstatBeforeOpen?.({ file: checked });
    handle = await fs.open(checked, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()
      || before.dev.toString() !== pathnameIdentity.dev
      || before.ino.toString() !== pathnameIdentity.ino) {
      throw new Error('artifact path changed before it could be opened safely');
    }
    const real = await fs.realpath(checked);
    contained(real, await fs.realpath(workspacePath), 'build artifact');
    const hash = createHash('sha256');
    if (options.captureBytes && before.size > BigInt(options.maximumBytes)) {
      throw new Error(`${options.label ?? 'file'} exceeds the capture size limit`);
    }
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const captured = options.captureBytes ? [] : undefined;
    let position = 0;
    let hookCalled = false;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      if (captured) captured.push(Buffer.from(buffer.subarray(0, bytesRead)));
      position += bytesRead;
      if (!hookCalled) {
        hookCalled = true;
        await hooks.duringRead?.({ file: checked, bytesRead: position });
      }
    }
    const after = await handle.stat({ bigint: true });
    const stableFields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'];
    if (stableFields.some((field) => before[field] !== after[field])) {
      throw new Error('artifact changed while it was being read');
    }
    await hooks.afterReadBeforePathValidation?.({ file: checked, bytesRead: position });
    const pathnameAfter = await fs.lstat(checked, { bigint: true });
    if (pathnameAfter.isSymbolicLink() || !pathnameAfter.isFile()
      || pathnameAfter.dev !== before.dev || pathnameAfter.ino !== before.ino) {
      throw new Error('artifact path was replaced while it was being read');
    }
    contained(await fs.realpath(checked), await fs.realpath(workspacePath), 'build artifact');
    return {
      file: checked,
      dev: before.dev.toString(),
      ino: before.ino.toString(),
      size: before.size.toString(),
      mtimeNs: before.mtimeNs.toString(),
      ctimeNs: before.ctimeNs.toString(),
      sha256: hash.digest('hex'),
      ...(captured ? { bytes: Buffer.concat(captured) } : {}),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function sameSnapshot(before, after) {
  return Boolean(before && after)
    && before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs
    && before.sha256 === after.sha256;
}

function sameIdentityAndBytes(before, after) {
  return Boolean(before && after)
    && before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.sha256 === after.sha256;
}

function processSucceeded(result) {
  return result?.classification === 'exit' && result.exitCode === 0;
}

function diagnostics(result) {
  return [result?.error, result?.stderr, result?.stdout].filter(Boolean).join('\n');
}

function yamlString(value) {
  return JSON.stringify(value);
}

function requestedTwinAssertions(profile) {
  return profile.observations
    .filter((observation) => observation.provider === 'serial' && typeof observation.contains === 'string')
    .map((observation) => Object.freeze({ uart_contains: observation.contains }));
}

function simulatorScript(profile, artifact, system, requested) {
  const assertions = requested.map((assertion) => `  - uart_contains: ${yamlString(assertion.uart_contains)}`);
  if (assertions.length === 0) return undefined;
  return [
    'schema_version: "1.0"',
    'inputs:',
    `  firmware: ${yamlString(artifact)}`,
    `  system: ${yamlString(system)}`,
    'limits:',
    '  max_steps: 10000000',
    'assertions:',
    ...assertions,
    '',
  ].join('\n');
}

async function quarantineArtifact(file, workspace, snapshot) {
  const existing = await snapshot(file, workspace);
  if (!existing) return undefined;
  const quarantine = path.join(path.dirname(existing.file), `.${path.basename(existing.file)}.labwired-quarantine-${randomUUID()}`);
  await fs.rename(existing.file, quarantine);
  const moved = await snapshot(quarantine, workspace);
  if (!sameIdentityAndBytes(existing, moved)) {
    try { await fs.rename(quarantine, existing.file); } catch { /* fail closed without overwriting */ }
    throw new Error('build artifact changed while entering quarantine');
  }
  return Object.freeze({ original: existing.file, quarantine, snapshot: moved });
}

async function restoreQuarantine(entry, workspace, snapshot) {
  if (!entry) return false;
  const held = await snapshot(entry.quarantine, workspace);
  if (!sameSnapshot(entry.snapshot, held)) throw new Error('quarantined artifact changed unexpectedly');
  try {
    await fs.lstat(entry.original);
    return false;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await fs.rename(entry.quarantine, entry.original);
  const restored = await snapshot(entry.original, workspace);
  if (!sameIdentityAndBytes(entry.snapshot, restored)) throw new Error('restored artifact identity does not match quarantine');
  try {
    await fs.lstat(entry.quarantine);
    throw new Error(`restored quarantine path still exists; recovery path: ${path.basename(entry.quarantine)}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return true;
}

async function discardQuarantine(entry, workspace, snapshot, hook) {
  if (!entry) return;
  await hook?.(entry);
  const held = await snapshot(entry.quarantine, workspace);
  if (!sameSnapshot(entry.snapshot, held)) {
    throw new Error(`quarantine cleanup ownership check failed; recovery path: ${path.basename(entry.quarantine)}`);
  }
  await fs.unlink(entry.quarantine);
  try {
    await fs.lstat(entry.quarantine);
    throw new Error(`quarantine cleanup did not remove owned file; recovery path: ${path.basename(entry.quarantine)}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function portableSourcePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new TypeError('shared-source paths must be nonempty relative paths');
  }
  const components = value.split('/');
  if (components.some((component) => {
    const normalized = component.normalize('NFKC');
    return !component || component === '.' || component === '..'
      || normalized !== component
      || !/^[A-Za-z0-9_-][A-Za-z0-9._ -]*$/.test(component)
      || /[. ]$/.test(component);
  })) {
    throw new TypeError('shared-source paths must use portable contained components');
  }
  const portable = components.join('/');
  const canonical = components.map((component) => component.toLowerCase()).join('/');
  for (const component of canonical.split('/')) {
    const stem = component.split('.')[0];
    if (!component || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(stem)) {
      throw new TypeError('shared-source paths must not use reserved portable components');
    }
  }
  return { portable, canonical, components };
}

async function snapshotSharedSources(values, workspace, snapshotFile) {
  if (!Array.isArray(values) || values.length === 0) throw new TypeError('surrogate twin execution requires shared-source provenance');
  const seen = new Set();
  const records = [];
  for (const value of values) {
    const normalized = portableSourcePath(value);
    if (seen.has(normalized.canonical)) throw new TypeError(`duplicate portable shared-source path ${value}`);
    seen.add(normalized.canonical);
    const file = contained(path.join(workspace, ...normalized.components), workspace, 'shared-source path');
    const snapshot = await snapshotFile(file, workspace);
    if (!snapshot) throw new TypeError(`shared-source file does not exist: ${value}`);
    const size = Number(snapshot.size);
    if (!Number.isSafeInteger(size)) throw new TypeError(`shared-source file is too large: ${value}`);
    records.push({ path: normalized.portable, file, snapshot, sha256: snapshot.sha256, size });
  }
  return records;
}

function pathIdentity(details) {
  return { dev: details.dev, ino: details.ino };
}

function samePathIdentity(left, right) {
  return left.ino === 0 || right.ino === 0 || (left.dev === right.dev && left.ino === right.ino);
}

async function snapshotEvidenceBundle(directory) {
  if (typeof directory !== 'string' || directory.length === 0) throw new TypeError('evidenceDir must name an owned evidence bundle');
  const root = path.resolve(directory);
  const rootDetails = await fs.lstat(root);
  if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) throw new TypeError('evidenceDir must be a real directory');
  const rootReal = await fs.realpath(root);
  const children = {};
  for (const [name, kind] of [['.owner.json', 'file'], ['result.json', 'file'], ['observations', 'directory']]) {
    const child = path.join(root, name);
    const details = await fs.lstat(child);
    if (details.isSymbolicLink() || (kind === 'file' ? !details.isFile() : !details.isDirectory())) {
      throw new TypeError(`evidence bundle ${name} must be a real ${kind}`);
    }
    const real = await fs.realpath(child);
    contained(real, rootReal, `evidence bundle ${name}`);
    children[name] = pathIdentity(details);
  }
  const ownerPath = path.join(root, '.owner.json');
  const ownerHandle = await fs.open(ownerPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let ownerText;
  try {
    const ownerDetails = await ownerHandle.stat();
    if (!samePathIdentity(children['.owner.json'], pathIdentity(ownerDetails))) throw new Error('evidence owner marker was replaced');
    if (ownerDetails.size > 64 * 1024) throw new TypeError('evidence owner marker is oversized');
    ownerText = await ownerHandle.readFile('utf8');
  } finally {
    await ownerHandle.close();
  }
  const owner = JSON.parse(ownerText);
  if (owner?.schema !== 1 || typeof owner.owner !== 'string' || owner.owner.length === 0) {
    throw new TypeError('evidenceDir is not an owned evidence bundle');
  }
  return { root, rootReal, rootIdentity: pathIdentity(rootDetails), children, owner: owner.owner };
}

async function verifyEvidenceBundleSnapshot(expected) {
  const current = await snapshotEvidenceBundle(expected.root);
  if (current.rootReal !== expected.rootReal
    || current.owner !== expected.owner
    || !samePathIdentity(expected.rootIdentity, current.rootIdentity)
    || Object.keys(expected.children).some((name) => !samePathIdentity(expected.children[name], current.children[name]))) {
    throw new Error('evidence bundle ownership changed during twin execution');
  }
}

async function readSimulatorResult(file, temporaryRoot, snapshotFile) {
  const snapshot = await snapshotFile(file, temporaryRoot, {
    captureBytes: true,
    maximumBytes: MAX_SIMULATOR_RESULT_BYTES,
    label: 'simulator result.json',
  });
  if (!snapshot) throw new Error('simulator did not publish result.json');
  let parsed;
  try { parsed = JSON.parse(snapshot.bytes.toString('utf8')); }
  catch { throw new Error('simulator did not publish a valid result.json'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('simulator result.json must contain an object');
  return parsed;
}

async function persistSimulatorEvidence(bundle, observed, redactValues, snapshotFile) {
  await verifyEvidenceBundleSnapshot(bundle);
  const directory = path.join(bundle.root, 'twin');
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (error?.code !== 'EEXIST') throw error; }
  const directoryDetails = await fs.lstat(directory);
  if (directoryDetails.isSymbolicLink() || !directoryDetails.isDirectory()) throw new Error('twin evidence path must be a real directory');
  contained(await fs.realpath(directory), bundle.rootReal, 'twin evidence path');
  const directoryIdentity = pathIdentity(directoryDetails);
  const finalPath = path.join(bundle.root, SIMULATOR_EVIDENCE_REF);
  try {
    await fs.lstat(finalPath);
    throw new Error(`refusing to overwrite ${SIMULATOR_EVIDENCE_REF}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const serialized = `${JSON.stringify(redactDeep(observed, redactValues), null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_SIMULATOR_RESULT_BYTES) throw new Error('redacted simulator evidence exceeds the capture size limit');
  const temporary = path.join(directory, `.simulator-output.tmp-${process.pid}-${randomUUID()}`);
  let handle;
  try {
    handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.chmod(temporary, 0o400);
    await verifyEvidenceBundleSnapshot(bundle);
    const currentDirectory = await fs.lstat(directory);
    if (currentDirectory.isSymbolicLink() || !currentDirectory.isDirectory()
      || !samePathIdentity(directoryIdentity, pathIdentity(currentDirectory))) {
      throw new Error('twin evidence directory was replaced');
    }
    await fs.link(temporary, finalPath);
    await fs.unlink(temporary);
    try {
      const directoryHandle = await fs.open(directory, fsConstants.O_RDONLY);
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    } catch (error) {
      if (!['EACCES', 'EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error?.code)) throw error;
    }
    const persisted = await snapshotFile(finalPath, bundle.root);
    if (!persisted) throw new Error('simulator evidence persistence failed');
    return SIMULATOR_EVIDENCE_REF;
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

function exactAssertionsObserved(observed, requested) {
  if (!Array.isArray(observed) || observed.length !== requested.length) return false;
  return observed.every((result, index) => {
    if (!result || result.passed !== true || !result.assertion || Array.isArray(result.assertion)) return false;
    const keys = Object.keys(result.assertion);
    return keys.length === 1
      && keys[0] === 'uart_contains'
      && result.assertion.uart_contains === requested[index].uart_contains;
  });
}

function buildFingerprint(profile) {
  return JSON.stringify({
    provider: profile.build.provider,
    workspace: profile.build.workspace,
    environment: profile.build.environment,
    artifact: profile.build.artifact,
    timeoutSeconds: profile.build.timeoutSeconds ?? null,
  });
}

function twinFingerprint(profile) {
  return JSON.stringify({
    build: JSON.parse(buildFingerprint(profile)),
    twin: profile.twin,
    observations: profile.observations,
  });
}

function physicalFingerprint(profile, extra = {}) {
  return JSON.stringify({
    artifact: profile.build.artifact,
    target: profile.target,
    flash: profile.flash,
    ...extra,
  });
}

function safePhysicalEnvironment(environment, additions = {}) {
  const selected = {};
  for (const name of ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'LANG', 'LC_ALL', 'TMP', 'TEMP']) {
    if (typeof environment[name] === 'string') selected[name] = environment[name];
  }
  return Object.freeze({ ...selected, ...additions });
}

/** Resolve the trusted platform launcher without leaking URL percent encoding into filesystem paths. */
export function resolveAgentLauncher(options = {}) {
  const platform = options.platform ?? process.platform;
  if (options.override !== undefined) {
    if (typeof options.override !== 'string' || options.override.length === 0
      || (!path.isAbsolute(options.override) && !path.win32.isAbsolute(options.override))) {
      throw new TypeError('agent launcher override must be an absolute path');
    }
    if (['.cmd', '.bat'].includes(path.win32.extname(options.override).toLowerCase())) {
      throw new TypeError('agent launcher override must not use a command shim');
    }
    return options.override;
  }
  const moduleFile = fileURLToPath(options.moduleUrl ?? import.meta.url);
  return path.resolve(path.dirname(moduleFile), '../../bin', platform === 'win32' ? 'labwired-agent.ps1' : 'labwired-agent');
}

async function persistPhysicalArtifact(evidenceDir, observationId, extension, value, redactValues = [], hooks) {
  if (!evidenceDir) return [];
  const bundle = await snapshotEvidenceBundle(evidenceDir);
  const directory = path.join(bundle.root, 'observations');
  const directoryIdentity = bundle.children.observations;
  const reference = `observations/${observationId}.${extension}`;
  const redacted = (Array.isArray(redactValues) ? redactValues : []).reduce((output, secret) => output.split(secret).join('[REDACTED]'), String(value));
  if (Buffer.byteLength(redacted) > MAX_PHYSICAL_EVIDENCE_BYTES) throw new Error('raw physical evidence exceeds the capture size limit');
  const output = path.join(bundle.root, reference);
  const temporary = path.join(directory, `.${observationId}.${extension}.tmp-${process.pid}-${randomUUID()}`);
  await hooks?.beforePublish?.({ root: bundle.root, directory, output });
  await verifyEvidenceBundleSnapshot(bundle);
  const before = await fs.lstat(directory);
  if (before.isSymbolicLink() || !before.isDirectory() || !samePathIdentity(directoryIdentity, pathIdentity(before))) {
    throw new Error('observation evidence directory was replaced');
  }
  let handle;
  try {
    handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(redacted, 'utf8'); await handle.sync(); await handle.close(); handle = undefined;
    await fs.chmod(temporary, 0o400);
    await verifyEvidenceBundleSnapshot(bundle);
    const current = await fs.lstat(directory);
    if (current.isSymbolicLink() || !current.isDirectory() || !samePathIdentity(directoryIdentity, pathIdentity(current))) {
      throw new Error('observation evidence directory was replaced');
    }
    await fs.link(temporary, output);
    await fs.unlink(temporary);
    return [reference];
  } catch (error) {
    await handle?.close().catch(() => {});
    try {
      const current = await fs.lstat(directory);
      if (!current.isSymbolicLink() && current.isDirectory() && samePathIdentity(directoryIdentity, pathIdentity(current))) {
        await fs.unlink(temporary).catch(() => {});
      }
    } catch { /* ownership changed; leave only our inaccessible temporary for recovery */ }
    throw error;
  }
}

async function persistPhysicalEvidence(evidenceDir, observationId, value, redactValues = [], hooks) {
  return persistPhysicalArtifact(evidenceDir, observationId, 'json', `${JSON.stringify(redactDeep(value, redactValues), null, 2)}\n`, [], hooks);
}

async function persistPhysicalBytes(evidenceDir, observationId, extension, value, redactValues = [], hooks) {
  return persistPhysicalArtifact(evidenceDir, observationId, extension, value, redactValues, hooks);
}

function parseCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === ',' && !quoted) { values.push(value); value = ''; }
    else value += character;
  }
  if (quoted) throw new Error('logic CSV contains an unterminated quote');
  values.push(value);
  return values;
}

function analyzeLogicCsv(text, observation) {
  for (const key of ['frequencyMinHz', 'frequencyMaxHz']) {
    if (observation[key] !== undefined && (!Number.isFinite(observation[key]) || observation[key] <= 0)) {
      throw new Error(`logic CSV ${key} must be a positive finite frequency bound`);
    }
  }
  if (observation.frequencyMinHz !== undefined && observation.frequencyMaxHz !== undefined
    && observation.frequencyMinHz > observation.frequencyMaxHz) {
    throw new Error('logic CSV minimum frequency bound must not exceed maximum');
  }
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length < 2) throw new Error('logic CSV requires a header and samples');
  const header = parseCsvLine(lines[0]);
  const timeIndex = header.indexOf(observation.timeColumn);
  const valueIndex = header.indexOf(observation.valueColumn);
  if (timeIndex < 0 || valueIndex < 0) throw new Error('logic CSV is missing configured time/value columns');
  const samples = lines.slice(1).map((line, index) => {
    const columns = parseCsvLine(line);
    const time = Number(columns[timeIndex]);
    const value = Number(columns[valueIndex]);
    if (!Number.isFinite(time) || !Number.isFinite(value)) throw new Error(`logic CSV row ${index + 2} must contain finite values`);
    if (value !== 0 && value !== 1) throw new Error(`logic CSV row ${index + 2} value must be digital 0 or 1`);
    return { time, value };
  });
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index].time <= samples[index - 1].time) throw new Error('logic CSV timestamps must be strictly monotonic');
  }
  let transitions = 0;
  for (let index = 1; index < samples.length; index += 1) if (samples[index].value !== samples[index - 1].value) transitions += 1;
  if (transitions < observation.edgeCountAtLeast) throw new Error(`logic CSV observed ${transitions} transitions, fewer than required`);
  const duration = samples.at(-1).time - samples[0].time;
  const frequencyHz = duration > 0 ? transitions / (2 * duration) : 0;
  if (observation.frequencyMinHz !== undefined && frequencyHz < observation.frequencyMinHz) throw new Error('logic CSV frequency is below the configured bound');
  if (observation.frequencyMaxHz !== undefined && frequencyHz > observation.frequencyMaxHz) throw new Error('logic CSV frequency is above the configured bound');
  return { sampleCount: samples.length, transitions, durationSeconds: duration, frequencyHz };
}

function parseHost(value) {
  const match = value.match(/^(?:\[([^\]]+)\]|([^:]+))(?:\:(\d{1,5}))?$/);
  if (!match) throw new Error('device marker contains an invalid address');
  const address = match[1] ?? match[2];
  const family = net.isIP(address);
  if (!family) throw new Error('device marker must contain a literal IP address');
  const port = match[3] === undefined ? 80 : Number(match[3]);
  if (port < 1 || port > 65535) throw new Error('device marker contains an invalid port');
  return { address, family, port };
}

function isPrivateAddress(address, family) {
  if (family === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const normalized = address.toLowerCase();
  return normalized === '::1' || normalized.startsWith('fe8') || normalized.startsWith('fe9')
    || normalized.startsWith('fea') || normalized.startsWith('feb')
    || normalized.startsWith('fc') || normalized.startsWith('fd');
}

function boundedHttpProbe({ address, family, port, probePath, nonce, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    const request = http.request({ hostname: address, family, port, path: probePath, method: 'GET', timeout: timeoutMs, signal }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400) { response.resume(); reject(new Error('network probe redirects are forbidden')); return; }
      if (response.statusCode < 200 || response.statusCode > 299) { response.resume(); reject(new Error(`network probe returned status ${response.statusCode}`)); return; }
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_PHYSICAL_EVIDENCE_BYTES) { request.destroy(new Error('network response exceeds size limit')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (!body.includes(nonce)) reject(new Error('network response does not contain the exact run nonce'));
        else resolve({ statusCode: response.statusCode, body });
      });
    });
    request.on('timeout', () => request.destroy(new Error('network probe timeout')));
    request.on('error', reject);
    request.end();
  });
}

/** Construct the closed registry of trusted hardware adapters. */
export function createTrustedAdapters(dependencies = {}) {
  const environment = Object.freeze({ ...(dependencies.env ?? process.env) });
  const resolveTool = dependencies.resolveTool ?? ((name) => executableOnPath(name, environment));
  const executeLaunch = dependencies.run ?? ((descriptor, options) => runLaunch(resolveLaunch(descriptor), options));
  const snapshotFile = (file, workspace, options) => artifactSnapshot(file, workspace, dependencies.snapshotHooks, options);
  const getVersion = dependencies.toolVersion ?? (async (name, executable, cwd) => {
    const result = await executeLaunch(launch(executable, ['--version'], cwd, environment), { timeoutMs: 10_000 });
    if (!processSucceeded(result)) throw new Error(`cannot determine ${name} version`);
    return String(result.stdout || result.stderr).trim().split(/\r?\n/, 1)[0];
  });
  const snapshotToolIdentity = async (executable) => {
    if (dependencies.toolIdentity) return dependencies.toolIdentity(executable);
    try {
      const real = await fs.realpath(executable);
      const details = await fs.lstat(real);
      if (!details.isFile()) throw new Error(`trusted executable is not a regular file: ${executable}`);
      return { real, dev: details.dev, ino: details.ino, size: details.size, mtimeMs: details.mtimeMs };
    } catch (error) {
      if (error?.code === 'ENOENT' && dependencies.resolveTool) return { injectedVirtualPath: executable };
      throw error;
    }
  };
  const verifyToolIdentity = async (executable, expected) => {
    const current = await snapshotToolIdentity(executable);
    if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error(`trusted executable identity changed after preflight: ${executable}`);
  };
  const bindFlashedArtifact = async (profile, options) => {
    const digest = options.flashedArtifactSha256 ?? options.artifactSha256;
    if (!SHA256.test(digest ?? '')) throw new Error('observation requires the exact flashed artifact SHA-256');
    const artifact = await snapshotFile(profile.build.artifact, profile.build.workspace);
    if (!artifact || artifact.sha256 !== digest.toLowerCase()) throw new Error('observed artifact does not match the exact flashed artifact');
    return artifact.sha256;
  };

  function buildAdapter(provider, toolName, makeArgs, validate = () => {}) {
    const capabilities = new WeakMap();
    const adapter = {
      async preflight(profile) {
        assertProfile(profile);
        if (profile.build.provider !== provider) throw new TypeError(`build provider must be ${provider}`);
        validate(profile);
        const executable = await resolveTool(toolName);
        if (typeof executable !== 'string' || !path.isAbsolute(executable)) throw new TypeError(`${toolName} must resolve to an explicit absolute executable`);
        const toolVersion = await getVersion(toolName, executable, profile.build.workspace);
        const prepared = Object.freeze({ executable, toolVersion });
        capabilities.set(prepared, Object.freeze({ executable, toolVersion, toolIdentity: await snapshotToolIdentity(executable), fingerprint: buildFingerprint(profile) }));
        return prepared;
      },
      plan(profile, prepared) {
        assertProfile(profile);
        const capability = capabilities.get(prepared);
        if (!capability) throw new TypeError('adapter-owned preflight capability is required');
        if (capability.fingerprint !== buildFingerprint(profile)) throw new TypeError('build inputs changed after preflight');
        validate(profile);
        return launch(capability.executable, makeArgs(profile), profile.build.workspace, environment);
      },
      async execute(profile, options = {}) {
        let quarantine;
        const startedAt = new Date().toISOString();
        try {
          const prepared = options.prepared ?? await this.preflight(profile);
          await verifyToolIdentity(prepared.executable, capabilities.get(prepared)?.toolIdentity);
          quarantine = await quarantineArtifact(profile.build.artifact, profile.build.workspace, snapshotFile);
          const descriptor = this.plan(profile, prepared);
          const result = await executeLaunch(descriptor, {
            timeoutMs: (profile.build.timeoutSeconds ?? 60) * 1000,
            signal: options.signal,
            redact: options.redact,
            onDelta: options.onDelta,
          });
          if (!processSucceeded(result)) {
            const restored = await restoreQuarantine(quarantine, profile.build.workspace, snapshotFile);
            if (!restored) {
              await discardQuarantine(quarantine, profile.build.workspace, snapshotFile, dependencies.quarantineHooks?.beforeCleanup);
            }
            quarantine = undefined;
            return redactDeep({ level: 'failed', provider, toolVersion: prepared.toolVersion, process: result, diagnostics: diagnostics(result) }, options.redact);
          }
          const after = await snapshotFile(profile.build.artifact, profile.build.workspace);
          if (!after) throw new Error('build completed without producing its declared artifact');
          if (quarantine && after.dev === quarantine.snapshot.dev && after.ino === quarantine.snapshot.ino) {
            throw new Error('build reused the quarantined stale artifact instead of producing output');
          }
          if (quarantine) {
            await discardQuarantine(quarantine, profile.build.workspace, snapshotFile, dependencies.quarantineHooks?.beforeCleanup);
          }
          quarantine = undefined;
          const endedAt = new Date().toISOString();
          const rawEvidenceRefs = options.evidenceDir
            ? await persistPhysicalEvidence(options.evidenceDir, `build-${profile.target.id}`, {
              provider, artifactSha256: after.sha256, target: profile.target.id,
              command: { executable: descriptor.executable, args: descriptor.args, shell: false },
              process: result, startedAt, endedAt,
            }, options.redact, dependencies.physicalEvidenceHooks)
            : [];
          return redactDeep({
            level: 'compiled', provider, artifact: after.file, artifactSha256: after.sha256,
            targetIdentity: profile.target, startedAt, endedAt, rawEvidenceRefs,
            toolVersion: prepared.toolVersion, process: result, diagnostics: diagnostics(result),
          }, options.redact);
        } catch (error) {
          if (quarantine) {
            try {
              const restored = await restoreQuarantine(quarantine, profile.build.workspace, snapshotFile);
              if (!restored) {
                await discardQuarantine(quarantine, profile.build.workspace, snapshotFile, dependencies.quarantineHooks?.beforeCleanup);
              }
            } catch (restoreError) { error.message += `; quarantine cleanup failed: ${restoreError.message}`; }
          }
          return redactDeep({ level: 'failed', provider, diagnostics: error.message }, options.redact);
        }
      },
    };
    return Object.freeze(adapter);
  }

  const platformio = buildAdapter('platformio', 'pio', (profile) => ['run', '-e', profile.build.environment], (profile) => {
    if (!SAFE_ENVIRONMENT.test(profile.build.environment)) throw new TypeError('PlatformIO environment must be a safe identifier');
  });
  const make = buildAdapter('make', 'make', (profile) => ['-C', profile.build.workspace]);
  const cmake = buildAdapter('cmake', 'cmake', (profile) => ['--build', contained(path.join(profile.build.workspace, profile.build.environment), profile.build.workspace, 'CMake build directory')], (profile) => {
    contained(path.join(profile.build.workspace, profile.build.environment), profile.build.workspace, 'CMake build directory');
  });

  const twinCapabilities = new WeakMap();
  const twinRuntimeCapabilities = new WeakMap();
  const twin = Object.freeze({
    async preflight(profile) {
      assertProfile(profile);
      if (profile.twin?.provider !== 'labwired-sim') throw new TypeError('twin provider must be labwired-sim');
      const executable = await resolveTool('labwired-sim');
      if (typeof executable !== 'string' || !path.isAbsolute(executable)) throw new TypeError('labwired-sim must resolve to an explicit absolute executable');
      const prepared = Object.freeze({ executable, toolVersion: await getVersion('labwired-sim', executable, profile.build.workspace) });
      twinCapabilities.set(prepared, Object.freeze({
        executable: prepared.executable,
        toolVersion: prepared.toolVersion,
        toolIdentity: await snapshotToolIdentity(executable),
        fingerprint: twinFingerprint(profile),
      }));
      return prepared;
    },
    plan(profile, prepared, runtime) {
      const capability = twinCapabilities.get(prepared);
      if (!capability) throw new TypeError('adapter-owned preflight capability is required');
      if (capability.fingerprint !== twinFingerprint(profile)) throw new TypeError('twin inputs changed after preflight');
      const runtimeCapability = twinRuntimeCapabilities.get(runtime);
      if (!runtimeCapability) throw new TypeError('adapter-owned runtime capability is required');
      return launch(capability.executable, [
        'test', '--script', runtimeCapability.script, '--output-dir', runtimeCapability.output, '--no-uart-stdout',
      ], profile.build.workspace, environment);
    },
    async execute(profile, options = {}) {
      let temporary;
      try {
        if (typeof options.nativeArtifactSha256 !== 'string' || !SHA256.test(options.nativeArtifactSha256)) {
          throw new TypeError('nativeArtifactSha256 must be an exact 64-character SHA-256 digest');
        }
        const expectedNativeHash = options.nativeArtifactSha256.toLowerCase();
        const prepared = options.prepared ?? await this.preflight(profile);
        await verifyToolIdentity(prepared.executable, twinCapabilities.get(prepared)?.toolIdentity);
        const system = await snapshotFile(profile.twin.system, profile.build.workspace);
        if (!system) throw new Error('selected twin system is absent');
        const nativeArtifact = contained(profile.build.artifact, profile.build.workspace, 'native artifact');
        const native = await snapshotFile(nativeArtifact, profile.build.workspace);
        if (!native) throw new Error('native artifact is absent');
        if (expectedNativeHash !== native.sha256) {
          throw new Error('native artifact hash does not match the build result');
        }
        const relation = profile.twin.artifactRelation;
        const selectedArtifact = relation === 'surrogate'
          ? contained(options.twinArtifact, profile.build.workspace, 'surrogate artifact')
          : nativeArtifact;
        const selected = await snapshotFile(selectedArtifact, profile.build.workspace);
        if (!selected) throw new Error('selected twin artifact is absent');
        if (relation === 'exact' && selected.sha256 !== native.sha256) throw new Error('exact twin artifact differs from native artifact');
        let sharedSources = [];
        if (relation === 'surrogate') {
          if (selected.sha256 === native.sha256) throw new Error('surrogate twin artifact must differ from native artifact');
          sharedSources = await snapshotSharedSources(options.sharedSourcePaths, profile.build.workspace, snapshotFile);
        }
        const evidenceBundle = await snapshotEvidenceBundle(options.evidenceDir);
        const requestedAssertions = requestedTwinAssertions(profile);
        if (requestedAssertions.length === 0) return { level: 'blocked', provider: 'labwired-sim', diagnostics: 'no supported twin behavior assertion is configured' };
        temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'labwired-twin-'));
        const stagedArtifact = path.join(temporary, 'firmware.bin');
        await fs.copyFile(selected.file, stagedArtifact, fsConstants.COPYFILE_EXCL);
        await fs.chmod(stagedArtifact, 0o400);
        const stagedBefore = await snapshotFile(stagedArtifact, temporary);
        if (!stagedBefore || stagedBefore.sha256 !== selected.sha256) throw new Error('staged artifact does not match selected artifact');
        const stagedSystem = path.join(temporary, 'system.yaml');
        await fs.copyFile(system.file, stagedSystem, fsConstants.COPYFILE_EXCL);
        await fs.chmod(stagedSystem, 0o400);
        const stagedSystemBefore = await snapshotFile(stagedSystem, temporary);
        if (!stagedSystemBefore || stagedSystemBefore.sha256 !== system.sha256) throw new Error('staged system does not match selected system');
        const stagedScriptBody = simulatorScript(profile, stagedArtifact, stagedSystem, requestedAssertions);
        const script = path.join(temporary, 'test.yaml');
        const output = path.join(temporary, 'evidence');
        await fs.writeFile(script, stagedScriptBody, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await fs.mkdir(output, { mode: 0o700 });
        const runtime = Object.freeze({ script, output });
        twinRuntimeCapabilities.set(runtime, Object.freeze({ script, output }));
        const descriptor = this.plan(profile, prepared, runtime);
        const processResult = await executeLaunch(descriptor, {
          timeoutMs: (profile.twin.timeoutSeconds ?? 60) * 1000,
          signal: options.signal, redact: options.redact, onDelta: options.onDelta,
        });
        const stagedAfter = await snapshotFile(stagedArtifact, temporary);
        const stagedSystemAfter = await snapshotFile(stagedSystem, temporary);
        const systemAfter = await snapshotFile(system.file, profile.build.workspace);
        const selectedAfter = await snapshotFile(selected.file, profile.build.workspace);
        const nativeAfter = selected.file === native.file
          ? selectedAfter
          : await snapshotFile(native.file, profile.build.workspace);
        const sharedSourcesUnchanged = (await Promise.all(sharedSources.map(async (source) => ({
          source,
          after: await snapshotFile(source.file, profile.build.workspace),
        })))).every(({ source, after }) => sameSnapshot(source.snapshot, after));
        if (!sameSnapshot(stagedBefore, stagedAfter)
          || !sameSnapshot(stagedSystemBefore, stagedSystemAfter)
          || !sameSnapshot(system, systemAfter)
          || !sameSnapshot(selected, selectedAfter)
          || !sameSnapshot(native, nativeAfter)
          || !sharedSourcesUnchanged) {
          throw new Error('twin input changed during execution');
        }
        const processDiagnostics = diagnostics(processResult);
        if (!processSucceeded(processResult)) {
          const level = /unsupported|not supported|unknown (?:firmware|architecture|format)/i.test(processDiagnostics) ? 'blocked' : 'failed';
          const rawEvidenceRefs = await persistPhysicalEvidence(options.evidenceDir, `twin-failure-${profile.target.id}`, {
            provider: 'labwired-sim', level, toolVersion: prepared.toolVersion,
            process: processResult, diagnostics: processDiagnostics,
          }, options.redact, dependencies.physicalEvidenceHooks);
          return redactDeep({ level, provider: 'labwired-sim', toolVersion: prepared.toolVersion, process: processResult, diagnostics: processDiagnostics, rawEvidenceRefs }, options.redact);
        }
        const observed = await readSimulatorResult(path.join(output, 'result.json'), temporary, snapshotFile);
        const observedHash = String(observed.firmware_hash ?? '').toLowerCase();
        const genuinelyObserved = observed.status === 'pass'
          && exactAssertionsObserved(observed.assertions, requestedAssertions)
          && SHA256.test(observedHash) && observedHash === selected.sha256;
        if (!genuinelyObserved) {
          return redactDeep({ level: 'failed', provider: 'labwired-sim', toolVersion: prepared.toolVersion, diagnostics: 'simulator result did not prove behavior for the selected artifact', result: observed }, options.redact);
        }
        const rawEvidenceRef = await persistSimulatorEvidence(evidenceBundle, observed, options.redact, snapshotFile);
        if (relation === 'exact') {
          return {
            level: 'model_observed', provider: 'labwired-sim', artifactSha256: selected.sha256,
            nativeArtifactSha256: native.sha256, toolVersion: prepared.toolVersion,
            rawEvidenceRefs: [rawEvidenceRef],
          };
        }
        return {
          level: 'surrogate_model_observed', provider: 'labwired-sim', artifactSha256: native.sha256,
          surrogateArtifactSha256: selected.sha256,
          sharedSourcePaths: sharedSources.map(({ path: sourcePath }) => sourcePath),
          toolVersion: prepared.toolVersion, rawEvidenceRefs: [rawEvidenceRef],
        };
      } catch (error) {
        let rawEvidenceRefs = [];
        try {
          rawEvidenceRefs = await persistPhysicalEvidence(options.evidenceDir, `twin-failure-${profile.target.id}`, {
            provider: 'labwired-sim', level: 'failed', diagnostics: error.message,
          }, options.redact, dependencies.physicalEvidenceHooks);
        } catch (persistenceError) { error.message += `; twin failure evidence persistence failed: ${persistenceError.message}`; }
        return redactDeep({ level: 'failed', provider: 'labwired-sim', diagnostics: error.message, rawEvidenceRefs }, options.redact);
      } finally {
        if (temporary) await fs.rm(temporary, { recursive: true, force: true });
      }
    },
  });

  const agentPath = resolveAgentLauncher({
    platform: dependencies.platform ?? process.platform,
    moduleUrl: import.meta.url,
    override: dependencies.agentPath,
  });

  function flashAdapter(provider) {
    const capabilities = new WeakMap();
    const planCapabilities = new WeakMap();
    return Object.freeze({
      async preflightPlan(profile) {
        assertProfile(profile);
        if (profile.flash?.provider !== provider) throw new TypeError(`flash provider must be ${provider}`);
        const prepared = Object.freeze({ provider, executable: agentPath });
        planCapabilities.set(prepared, Object.freeze({ fingerprint: physicalFingerprint(profile), toolIdentity: await snapshotToolIdentity(agentPath) }));
        return prepared;
      },
      async preflight(profile, options = {}) {
        assertProfile(profile);
        if (profile.flash?.provider !== provider) throw new TypeError(`flash provider must be ${provider}`);
        if (options.planPrepared !== undefined) {
          const planned = planCapabilities.get(options.planPrepared);
          if (!planned || planned.fingerprint !== physicalFingerprint(profile)) throw new TypeError('adapter-owned flash plan capability is required');
          await verifyToolIdentity(agentPath, planned.toolIdentity);
        }
        if (!profile.target?.probeSerial || !profile.target?.serialPort) throw new TypeError('explicit probe and serial identities are required');
        const requiredExtension = provider === 'platformio' ? '.bin' : '.elf';
        if (path.extname(profile.build.artifact).toLowerCase() !== requiredExtension) {
          throw new TypeError(`${provider} exact flash requires a ${requiredExtension} artifact`);
        }
        if (!SHA256.test(options.artifactSha256 ?? '')) throw new TypeError('artifactSha256 must be an exact SHA-256 digest');
        const artifact = await snapshotFile(profile.build.artifact, profile.build.workspace);
        if (!artifact || artifact.sha256 !== options.artifactSha256.toLowerCase()) throw new Error('flash artifact hash does not match the build result');
        const prepared = Object.freeze({ provider, artifactSha256: artifact.sha256 });
        capabilities.set(prepared, Object.freeze({ fingerprint: physicalFingerprint(profile), artifact, toolIdentity: await snapshotToolIdentity(agentPath) }));
        return prepared;
      },
      plan(profile, prepared) {
        const capability = capabilities.get(prepared);
        if (!capability) throw new TypeError('adapter-owned preflight capability is required');
        if (capability.fingerprint !== physicalFingerprint(profile)) throw new TypeError('flash inputs changed after preflight');
        return launch(agentPath, [
          'probe', 'flash', profile.build.artifact, '--provider', provider, '--chip', profile.target.chip,
          '--target', 'probe', '--probe', profile.target.probeSerial, '--port', profile.target.serialPort,
          '--expected-sha256', capability.artifact.sha256, '--environment', profile.build.environment,
          '--workspace', profile.build.workspace,
        ], profile.build.workspace, safePhysicalEnvironment(environment));
      },
      async execute(profile, options = {}) {
        try {
          const prepared = options.prepared ?? await this.preflight(profile, options);
          const capability = capabilities.get(prepared);
          await verifyToolIdentity(agentPath, capability?.toolIdentity);
          const descriptor = this.plan(profile, prepared);
          const processResult = await executeLaunch(descriptor, {
            timeoutMs: (profile.flash.timeoutSeconds ?? 60) * 1000,
            signal: options.signal, redact: options.redact, onDelta: options.onDelta,
          });
          const after = await snapshotFile(profile.build.artifact, profile.build.workspace);
          if (!sameSnapshot(capability.artifact, after)) throw new Error('flash artifact changed during execution');
          if (!processSucceeded(processResult)) {
            return redactDeep({
              level: 'failed', provider, process: processResult,
              diagnostics: diagnostics(processResult) || `flash command ${processResult?.classification ?? 'failed'}`,
            }, options.redact);
          }
          const receiptLine = String(processResult.stdout).split(/\r?\n/).find((line) => line.startsWith('LABWIRED_FLASH_RECEIPT '));
          let receipt;
          try { receipt = JSON.parse(receiptLine?.slice('LABWIRED_FLASH_RECEIPT '.length) ?? ''); } catch { throw new Error('flash command did not emit a valid exact receipt'); }
          if (receipt.provider !== provider || receipt.artifactSha256 !== after.sha256
            || receipt.chip !== profile.target.chip || receipt.probeSerial !== profile.target.probeSerial
            || receipt.observationPort !== profile.target.serialPort || receipt.environment !== profile.build.environment
            || receipt.workspace !== profile.build.workspace || receipt.identityApplied !== true
            || receipt.serialPortApplied !== (provider === 'platformio')) throw new Error('flash receipt does not match the exact artifact and identities');
          const capture = redactDeep({
            provider, artifactSha256: after.sha256,
            target: profile.target.id, probeSerial: profile.target.probeSerial, serialPort: profile.target.serialPort,
            command: { executable: descriptor.executable, args: descriptor.args, shell: false }, process: processResult,
          }, options.redact);
          const rawEvidenceRefs = await persistPhysicalEvidence(options.evidenceDir, `flash-${profile.target.id}`, capture, options.redact, dependencies.physicalEvidenceHooks);
          return { level: 'hardware_observed', provider, artifactSha256: after.sha256, flashedArtifactSha256: after.sha256, rawEvidenceRefs };
        } catch (error) {
          return redactDeep({ level: 'failed', provider, diagnostics: error.message }, options.redact);
        }
      },
    });
  }

  function commandObservationAdapter(provider) {
    const capabilities = new WeakMap();
    return Object.freeze({
      async preflight(profile, observation) {
        assertProfile(profile);
        if (observation?.provider !== provider) throw new TypeError(`observation provider must be ${provider}`);
        const prepared = Object.freeze({ provider, executable: agentPath });
        capabilities.set(prepared, Object.freeze({ fingerprint: physicalFingerprint(profile, { observation }), toolIdentity: await snapshotToolIdentity(agentPath) }));
        return prepared;
      },
      plan(profile, observation, prepared) {
        const capability = capabilities.get(prepared);
        if (!capability) throw new TypeError('adapter-owned preflight capability is required');
        if (capability.fingerprint !== physicalFingerprint(profile, { observation })) throw new TypeError('observation inputs changed after preflight');
        const args = provider === 'serial'
          ? ['serial-capture', profile.target.serialPort, '115200', observation.contains, String(observation.timeoutSeconds ?? 8)]
          : ['probe', 'rtt-capture', '--chip', profile.target.chip, '--probe', profile.target.probeSerial, '--elf', profile.build.artifact, '--marker', observation.contains, '--timeout', String(observation.timeoutSeconds ?? 8)];
        return launch(agentPath, args, profile.build.workspace, safePhysicalEnvironment(environment));
      },
      async execute(profile, observation, options = {}) {
        try {
          const prepared = options.prepared ?? await this.preflight(profile, observation);
          await verifyToolIdentity(agentPath, capabilities.get(prepared)?.toolIdentity);
          const descriptor = this.plan(profile, observation, prepared);
          const processResult = await executeLaunch(descriptor, {
            timeoutMs: (observation.timeoutSeconds ?? 8) * 1000,
            signal: options.signal, redact: options.redact, onDelta: options.onDelta,
          });
          if (!processSucceeded(processResult) || !String(processResult.stdout).includes(observation.contains)) {
            throw new Error(diagnostics(processResult) || `${provider} marker was not observed`);
          }
          const artifactSha256 = await bindFlashedArtifact(profile, options);
          const capture = redactDeep({ provider, target: profile.target.id, artifactSha256, command: { executable: descriptor.executable, args: descriptor.args, shell: false }, process: processResult }, options.redact);
          const rawEvidenceRefs = await persistPhysicalEvidence(options.evidenceDir, observation.id, capture, options.redact, dependencies.physicalEvidenceHooks);
          return { level: 'hardware_observed', provider, artifactSha256, flashedArtifactSha256: artifactSha256, rawEvidenceRefs };
        } catch (error) { return redactDeep({ level: 'failed', provider, diagnostics: error.message }, options.redact); }
      },
    });
  }

  const logicCsv = Object.freeze({
    async preflight(profile, observation) {
      assertProfile(profile);
      if (observation?.provider !== 'logic-csv') throw new TypeError('observation provider must be logic-csv');
      return Object.freeze({ provider: 'logic-csv' });
    },
    async execute(profile, observation, options = {}) {
      try {
        const prepared = options.prepared ?? await this.preflight(profile, observation);
        if (prepared?.provider !== 'logic-csv') throw new TypeError('adapter-owned logic-csv capability is required');
        const snapshot = await snapshotFile(observation.file, profile.build.workspace, {
          captureBytes: true, maximumBytes: MAX_PHYSICAL_EVIDENCE_BYTES, label: 'logic CSV',
        });
        if (!snapshot) throw new Error('logic CSV capture is absent');
        const rawText = (Array.isArray(options.redact) ? options.redact : []).reduce(
          (output, secret) => output.split(secret).join('[REDACTED]'), snapshot.bytes.toString('utf8'),
        );
        const analysis = analyzeLogicCsv(rawText, observation);
        const after = await snapshotFile(observation.file, profile.build.workspace);
        if (!sameSnapshot(snapshot, after)) throw new Error('logic CSV capture changed during observation');
        const artifactSha256 = await bindFlashedArtifact(profile, options);
        const capture = { provider: 'logic-csv', artifactSha256, captureSha256: createHash('sha256').update(rawText).digest('hex'), ...analysis };
        const sourceRefs = await persistPhysicalBytes(options.evidenceDir, observation.id, 'csv', rawText, [], dependencies.physicalEvidenceHooks);
        const rawEvidenceRefs = [...sourceRefs, ...await persistPhysicalEvidence(options.evidenceDir, observation.id, capture, options.redact, dependencies.physicalEvidenceHooks)];
        return { level: 'hardware_observed', ...capture, artifactSha256, flashedArtifactSha256: artifactSha256, rawEvidenceRefs };
      } catch (error) { return redactDeep({ level: 'failed', provider: 'logic-csv', diagnostics: error.message }, options.redact); }
    },
  });

  const networkCapabilities = new WeakMap();
  const network = Object.freeze({
    async preflight(profile, observation) {
      assertProfile(profile);
      if (observation?.provider !== 'network') throw new TypeError('observation provider must be network');
      const prepared = Object.freeze({ provider: 'network', executable: agentPath });
      networkCapabilities.set(prepared, await snapshotToolIdentity(agentPath));
      return prepared;
    },
    async execute(profile, observation, options = {}) {
      const nonce = (dependencies.randomBytes ?? randomBytes)(16).toString('hex');
      try {
        const prepared = options.prepared ?? await this.preflight(profile, observation);
        const toolIdentity = networkCapabilities.get(prepared);
        if (!toolIdentity) throw new TypeError('adapter-owned network capability is required');
        await verifyToolIdentity(agentPath, toolIdentity);
        const challengeDescriptor = launch(agentPath, [
          'serial-challenge', profile.target.serialPort, '115200', nonce, observation.deviceMarker,
          observation.hostProbeUrlFromMarker, String(observation.timeoutSeconds ?? 8),
        ], profile.build.workspace, safePhysicalEnvironment(environment));
        const challengeStartedAt = new Date().toISOString();
        const challenge = await executeLaunch(challengeDescriptor, {
          timeoutMs: (observation.timeoutSeconds ?? 8) * 1000, signal: options.signal,
          redact: options.redact, onDelta: options.onDelta,
        });
        const challengeEndedAt = new Date().toISOString();
        if (!processSucceeded(challenge)) throw new Error(diagnostics(challenge) || 'trusted serial challenge failed');
        const deviceCapture = String(challenge.stdout);
        const escapedMarker = observation.deviceMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedKey = observation.hostProbeUrlFromMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = deviceCapture.match(new RegExp(`${escapedMarker}[^\\r\\n]*\\bnonce=([^\\s]+)[^\\r\\n]*\\b${escapedKey}=([^\\s]+)`));
        if (!match || match[1] !== nonce) throw new Error('device marker does not contain the exact run nonce and address');
        const host = parseHost(match[2]);
        if (!isPrivateAddress(host.address, host.family) && options.allowPublicAddress !== true) throw new Error('public network addresses require explicit opt-in');
        if (options.allowPublicAddress !== undefined && typeof options.allowPublicAddress !== 'boolean') throw new TypeError('allowPublicAddress must be boolean');
        const response = await (dependencies.httpProbe ?? boundedHttpProbe)({
          ...host, probePath: observation.hostProbePath, nonce,
          timeoutMs: (observation.timeoutSeconds ?? 8) * 1000, signal: options.signal,
        });
        const artifactSha256 = await bindFlashedArtifact(profile, options);
        const challengeCapture = `challenge nonce=${nonce} port=${profile.target.serialPort} startedAt=${challengeStartedAt} endedAt=${challengeEndedAt}\n${deviceCapture}`;
        const redactText = (value) => (Array.isArray(options.redact) ? options.redact : []).reduce((output, secret) => output.split(secret).join('[REDACTED]'), String(value));
        const capture = redactDeep({
          provider: 'network', nonce, address: host.address, port: host.port, artifactSha256,
          challenge: { serialPort: profile.target.serialPort, startedAt: challengeStartedAt, endedAt: challengeEndedAt },
          deviceCaptureSha256: createHash('sha256').update(redactText(challengeCapture)).digest('hex'),
          hostResponseSha256: createHash('sha256').update(redactText(response.body)).digest('hex'),
          statusCode: response.statusCode, response: response.body,
        }, options.redact);
        const deviceRefs = await persistPhysicalBytes(options.evidenceDir, `${observation.id}-device`, 'txt', challengeCapture, options.redact, dependencies.physicalEvidenceHooks);
        const hostRefs = await persistPhysicalBytes(options.evidenceDir, `${observation.id}-host`, 'txt', response.body, options.redact, dependencies.physicalEvidenceHooks);
        const rawEvidenceRefs = [...deviceRefs, ...hostRefs, ...await persistPhysicalEvidence(options.evidenceDir, observation.id, capture, options.redact, dependencies.physicalEvidenceHooks)];
        return { level: 'hardware_observed', provider: 'network', nonce, address: host.address, artifactSha256, flashedArtifactSha256: artifactSha256, rawEvidenceRefs };
      } catch (error) { return redactDeep({ level: 'failed', provider: 'network', diagnostics: error.message }, options.redact); }
    },
  });

  const platformioFlash = flashAdapter('platformio');
  const probeRsFlash = flashAdapter('probe-rs');
  const serial = commandObservationAdapter('serial');
  const rtt = commandObservationAdapter('rtt');

  return Object.freeze({
    build: Object.freeze({ platformio, make, cmake }),
    twin: Object.freeze({ 'labwired-sim': twin }),
    flash: Object.freeze({ platformio: platformioFlash, 'probe-rs': probeRsFlash }),
    observation: Object.freeze({ serial, rtt, 'logic-csv': logicCsv, network }),
  });
}
