#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

export function parseHardwareArguments(argv) {
  const [command, ...rest] = argv;
  if (!['plan', 'run'].includes(command)) fail('usage: hardware plan|run --profile FILE --out DIR [--confirm DIGEST]', true);
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

async function runJson(executable, args, options = {}) {
  if (options.signal?.aborted) throw Object.assign(new Error('hardware enumeration cancelled'), { name: 'AbortError' });
  const descriptor = resolveLaunch({ executable, args, cwd: options.cwd ?? process.cwd(), env: process.env, shell: false });
  const result = await runLaunch(descriptor, { timeoutMs: options.timeoutMs ?? 10_000, signal: options.signal, redact: options.redact });
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

async function platformIoDevices(options) {
  const executable = executableOnPath('pio');
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
  const devices = await platformIoDevices(options);
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
  const probeExecutable = executableOnPath('probe-rs');
  if (!probeExecutable) throw new Error('BLOCKED: probe-rs provider is unavailable for exact probe enumeration');
  const [probeText, devices] = await Promise.all([
    runJson(probeExecutable, ['list'], options),
    platformIoDevices(options),
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
  if (profile.flash?.provider === 'probe-rs') return probeRsIdentities(profile, options);
  if (profile.build.provider === 'platformio' || profile.flash?.provider === 'platformio') return platformIoIdentities(profile, options);
  throw new Error('BLOCKED: this provider has no correlated probe-and-serial identity enumerator');
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    if (Number(process.versions.node.split('.')[0]) < 18) fail('Node.js 18+ is required for hardware commands', true);
    parsed = parseHardwareArguments(argv);
    const abort = new AbortController();
    const stop = () => abort.abort();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    const dependencies = { resolveHardwareIdentities };
    try {
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
    process.stdout.write(`${JSON.stringify({ command: `hardware ${parsed?.command ?? 'invalid'}`, result: blocked ? 'BLOCKED' : 'FAIL', error: message })}\n`);
    return parsed?.command === 'run' && confirmation ? 2 : (error?.usage ? 2 : 3);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
