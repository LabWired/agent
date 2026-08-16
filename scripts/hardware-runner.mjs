#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runDifferential } from '../lib/hardware/differential.mjs';
import { executeHardwareRun, planHardwareRun } from '../lib/hardware/runner.mjs';
import { resolveLaunch, runLaunch } from '../lib/hardware/process.mjs';
import { containsInlineCredential } from '../lib/hardware/profile.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const AMBIGUOUS = new Set(['auto', 'first', 'any', 'default']);

function fail(message, usage = false) {
  const error = new Error(message);
  error.usage = usage;
  throw error;
}

const DIFF_USAGE = 'usage: hardware diff --artifact FILE --twin-evidence DIR --twin-receipt SHA256 '
  + '[--desk-evidence DIR --desk-receipt SHA256] [--out FILE]';

export function parseDifferentialArguments(rest) {
  const allowed = new Set(['--artifact', '--twin-evidence', '--twin-receipt', '--desk-evidence', '--desk-receipt', '--out']);
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (!allowed.has(flag) || index + 1 >= rest.length || rest[index + 1].startsWith('--')) fail(`unsupported or incomplete hardware option ${flag ?? ''}`, true);
    if (values[flag] !== undefined) fail(`duplicate hardware option ${flag}`, true);
    values[flag] = rest[index + 1];
  }
  if (!values['--artifact']) fail(`--artifact is required; ${DIFF_USAGE}`, true);
  if (Object.values(values).some((value) => containsInlineCredential(value))) {
    fail('hardware arguments must not contain credential-shaped values', true);
  }
  for (const flag of ['--twin-receipt', '--desk-receipt']) {
    if (values[flag] !== undefined && !SHA256.test(values[flag])) {
      fail(`${flag} must be the exact lowercase evidence receipt digest`, true);
    }
  }
  // A bundle without its out-of-bundle receipt cannot be authenticated, so it is
  // never silently accepted as evidence for its side.
  if (values['--twin-evidence'] && !values['--twin-receipt']) fail('--twin-evidence requires --twin-receipt', true);
  if (values['--desk-evidence'] && !values['--desk-receipt']) fail('--desk-evidence requires --desk-receipt', true);
  return Object.freeze({
    command: 'diff',
    artifactPath: values['--artifact'],
    twin: Object.freeze({ evidenceDir: values['--twin-evidence'], receipt: values['--twin-receipt'] }),
    desk: Object.freeze({ evidenceDir: values['--desk-evidence'], receipt: values['--desk-receipt'] }),
    outPath: values['--out'],
  });
}

export function parseHardwareArguments(argv) {
  const [command, ...rest] = argv;
  if (command === 'diff') return parseDifferentialArguments(rest);
  if (!['plan', 'run'].includes(command)) fail('usage: hardware plan|run --profile FILE --out DIR [--confirm DIGEST]\n       hardware diff --artifact FILE --twin-evidence DIR --twin-receipt SHA256 [--desk-evidence DIR --desk-receipt SHA256]', true);
  const allowed = new Set(command === 'plan' ? ['--profile', '--out'] : ['--profile', '--out', '--confirm']);
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (!allowed.has(flag) || index + 1 >= rest.length || rest[index + 1].startsWith('--')) fail(`unsupported or incomplete hardware option ${flag ?? ''}`, true);
    if (values[flag] !== undefined) fail(`duplicate hardware option ${flag}`, true);
    values[flag] = rest[index + 1];
  }
  if (!values['--profile'] || !values['--out']) fail('--profile and --out are required', true);
  if ([values['--profile'], values['--out'], values['--confirm']].some((value) => typeof value === 'string' && containsInlineCredential(value))) {
    fail('hardware arguments must not contain credential-shaped values', true);
  }
  if (command === 'run' && (!values['--confirm'] || !SHA256.test(values['--confirm']))) {
    fail('hardware run requires --confirm with the exact lowercase plan digest', true);
  }
  return Object.freeze({ command, profilePath: values['--profile'], evidenceDir: values['--out'], confirmDigest: values['--confirm'] });
}

function executableOnPath(name, environment = process.env) {
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const extensions = process.platform === 'win32' ? String(environment.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const directory of String(environment.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension.toLowerCase()}`);
      try {
        const details = requireStat(candidate);
        if (details) return candidate;
      } catch { /* continue */ }
    }
  }
  return undefined;
}

function requireStat(candidate) {
  // Deliberately synchronous: executable resolution and spawning are one short
  // preflight transaction and the selected absolute path is never shell-parsed.
  return statSync(candidate).isFile();
}

const PROVIDER_ENVIRONMENT_NAMES = Object.freeze([
  'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec', 'HOME', 'USERPROFILE',
  'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE',
]);

export function providerEnvironment(source = process.env) {
  const selected = Object.create(null);
  for (const name of PROVIDER_ENVIRONMENT_NAMES) {
    const value = source[name];
    if (typeof value === 'string' && !containsInlineCredential(value)) selected[name] = value;
  }
  return selected;
}

async function runJson(executable, args, options = {}) {
  if (options.signal?.aborted) throw Object.assign(new Error('hardware enumeration cancelled'), { name: 'AbortError' });
  const descriptor = resolveLaunch({ executable, args, cwd: options.cwd ?? process.cwd(), env: providerEnvironment(options.environment), shell: false });
  const result = await runLaunch(descriptor, { timeoutMs: options.timeoutMs ?? 10_000, signal: options.signal, redact: options.redact ?? [] });
  if (result.classification === 'cancelled') throw Object.assign(new Error('hardware enumeration cancelled'), { name: 'AbortError' });
  if (result.classification === 'timeout') throw new Error('BLOCKED: trusted provider enumeration timed out');
  if (result.classification !== 'exit' || result.exitCode !== 0) throw new Error('BLOCKED: trusted provider enumeration failed');
  if (result.truncated.stdout) throw new Error('BLOCKED: provider enumeration exceeded its output limit');
  return result.stdout;
}

function serials(device) {
  const explicit = [device.serialNumber, device.serial_number].filter((value) => typeof value === 'string');
  if (explicit.length) return explicit;
  const found = [];
  for (const value of [device.hwid, device.description]) {
    if (typeof value !== 'string') continue;
    const token = /(?:^|[\s,;])(?:SER|SERIAL)=([^\s,;]+)/g;
    let match; while ((match = token.exec(value)) !== null) found.push(match[1]);
  }
  return found;
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function parseSigrokScanLine(line) {
  const separator = line.indexOf(' - ');
  if (separator < 1) return undefined;
  const selector = line.slice(0, separator).trim();
  const description = line.slice(separator + 3).trim();
  const [driver, ...optionParts] = selector.split(':');
  if (!driver || !description || optionParts.length === 0) return undefined;
  const options = {};
  for (const part of optionParts) {
    const equals = part.indexOf('=');
    if (equals < 1 || equals === part.length - 1) return undefined;
    const key = part.slice(0, equals); const value = part.slice(equals + 1);
    if (!/^[a-z][a-z0-9_-]*$/i.test(key) || options[key] !== undefined) return undefined;
    options[key] = value;
  }
  if (typeof options.conn !== 'string') return undefined;
  return { driver, conn: options.conn, selector, description };
}

async function platformIoDevices(options) {
  const executable = executableOnPath('pio', options.environment);
  if (!executable) throw new Error('BLOCKED: PlatformIO provider is unavailable for exact device enumeration');
  let devices;
  try { devices = JSON.parse(await runJson(executable, ['device', 'list', '--json-output'], options)); } catch (error) {
    if (error?.name === 'AbortError') throw error;
    if (/^BLOCKED:/.test(error.message)) throw error;
    throw new Error('BLOCKED: PlatformIO returned malformed device enumeration');
  }
  if (!Array.isArray(devices)) throw new Error('BLOCKED: PlatformIO returned malformed device enumeration');
  return devices;
}

async function platformIoIdentities(profile, options) {
  const devices = await platformIoDevices({ ...options, cwd: profile.build.workspace });
  const matches = devices.filter((device) => device && device.port === profile.target.serialPort
    && serials(device).some((value) => value === profile.target.probeSerial));
  return matches.map((device) => {
    const providerIdentity = {
      provider: 'platformio', port: device.port,
      serialNumber: profile.target.probeSerial,
      hwid: typeof device.hwid === 'string' ? device.hwid : '',
      vid: device.vid ?? '', pid: device.pid ?? '', location: device.location ?? '',
    };
    const stable = `platformio:${fingerprint(providerIdentity)}`;
    return {
      target: profile.target.id, probe: profile.target.probeSerial, serial: profile.target.serialPort,
      stableIds: { target: `${stable}:target`, probe: `${stable}:probe`, serial: `${stable}:serial` },
    };
  });
}

async function probeRsIdentities(profile, options) {
  const probeExecutable = executableOnPath('probe-rs', options.environment);
  if (!probeExecutable) throw new Error('BLOCKED: probe-rs provider is unavailable for exact probe enumeration');
  const [probeText, devices] = await Promise.all([
    runJson(probeExecutable, ['list'], { ...options, cwd: profile.build.workspace }),
    platformIoDevices({ ...options, cwd: profile.build.workspace }),
  ]);
  const configuredProbe = profile.target.probeSerial;
  const probes = probeText.split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*\[\d+\]:.*?--\s*(\S+)/);
    return match ? { id: match[1], line: line.trim() } : undefined;
  }).filter((probe) => probe?.id === configuredProbe);
  const ports = devices.filter((device) => device && device.port === profile.target.serialPort);
  if (probes.length !== 1 || ports.length !== 1) return [];
  const probeStable = `probe-rs:${fingerprint({ id: probes[0].id, line: probes[0].line })}`;
  const port = ports[0];
  const serialStable = `serial:${fingerprint({ port: port.port, serials: serials(port), hwid: port.hwid ?? '', vid: port.vid ?? '', pid: port.pid ?? '', location: port.location ?? '' })}`;
  return [{
    target: profile.target.id, probe: configuredProbe, serial: profile.target.serialPort,
    stableIds: {
      target: `target:${fingerprint({ probe: probeStable, serial: serialStable })}`,
      probe: probeStable,
      serial: serialStable,
    },
  }];
}

/** Resolve only exact configured identities from structured trusted provider output. */
export async function resolveHardwareIdentities(profile, options = {}) {
  for (const [label, value] of [['target', profile.target.id], ['probe', profile.target.probeSerial], ['serial', profile.target.serialPort]]) {
    if (typeof value !== 'string' || !value || AMBIGUOUS.has(value.toLowerCase())) throw new Error(`BLOCKED: explicit non-ambiguous ${label} identity is required`);
  }
  let base;
  if (profile.flash?.provider === 'probe-rs') base = await probeRsIdentities(profile, options);
  else if (profile.build.provider === 'platformio' || profile.flash?.provider === 'platformio') base = await platformIoIdentities(profile, options);
  else throw new Error('BLOCKED: this provider has no correlated probe-and-serial identity enumerator');
  const logic = (profile.observations ?? []).filter((item) => item.provider === 'logic-csv' && item.requiredLevel === 'hardware_observed');
  if (logic.length === 0) return base;
  const executable = executableOnPath('sigrok-cli', options.environment);
  if (!executable) throw new Error('BLOCKED: sigrok-cli provider is unavailable for analyzer enumeration');
  const instruments = {}; const stableIds = {};
  for (const observation of logic) {
    const output = await runJson(executable, ['--scan', '--driver', observation.driver], { ...options, cwd: profile.build.workspace });
    const matches = output.split(/\r?\n/).map(parseSigrokScanLine).filter((record) => record?.driver === observation.driver && record.conn === observation.instrumentId);
    if (matches.length !== 1) return [];
    const key = `instrument-${observation.id}`;
    instruments[key] = observation.instrumentId;
    stableIds[key] = `sigrok:${fingerprint({ driver: observation.driver, instrumentId: observation.instrumentId, selector: matches[0].selector, description: matches[0].description })}`;
  }
  return base.map((identity) => ({ ...identity, instruments: { ...instruments }, stableIds: { ...identity.stableIds, ...stableIds } }));
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  // The requested verb is known before parsing, so a diff invocation that fails
  // to parse still reports as a diff and still avoids the "disagree" exit code.
  const requestedDiff = argv[0] === 'diff';
  try {
    if (Number(process.versions.node.split('.')[0]) < 18) fail('Node.js 18+ is required for hardware commands', true);
    parsed = parseHardwareArguments(argv);
    const abort = new AbortController();
    const stop = () => abort.abort();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    const dependencies = { resolveHardwareIdentities };
    try {
      if (parsed.command === 'diff') {
        const diff = await runDifferential(parsed);
        const payload = `${JSON.stringify({ command: 'hardware diff', ...diff })}\n`;
        process.stdout.write(payload);
        if (parsed.outPath) await writeFile(parsed.outPath, payload);
        return diff.exitCode;
      }
      if (parsed.command === 'plan') {
        const result = await planHardwareRun({ ...parsed, dependencies, signal: abort.signal });
        process.stdout.write(`${JSON.stringify({ command: 'hardware plan', ...result })}\n`);
        return 0;
      }
      const result = await executeHardwareRun({ ...parsed, dependencies, signal: abort.signal });
      process.stdout.write(`${JSON.stringify({ command: 'hardware run', ...result })}\n`);
      return result.result === 'PASS' ? 0 : 3;
    } finally {
      process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    }
  } catch (error) {
    const message = String(error?.message ?? error);
    const confirmation = /confirmation digest/i.test(message);
    const blocked = confirmation || /^BLOCKED:|exactly one unique detected identity|ambiguous .* identity/i.test(message);
    process.stdout.write(`${JSON.stringify({
      command: `hardware ${parsed?.command ?? 'invalid'}`,
      result: blocked ? 'BLOCKED' : 'FAIL',
      ...(requestedDiff ? { command: 'hardware diff', verdict: 'invalid' } : {}),
      error: message,
    })}\n`);
    // Exit 3 means "disagree" for diff, so a broken diff invocation must never
    // borrow it. Every diff failure is invalid (2).
    if (requestedDiff) return 2;
    return parsed?.command === 'run' && confirmation ? 2 : (error?.usage ? 2 : 3);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
