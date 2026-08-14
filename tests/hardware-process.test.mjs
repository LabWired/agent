import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { resolveLaunch, runLaunch, terminateProcessTree } from '../lib/hardware/process.mjs';

const nodeLaunch = (source, env = {}) => resolveLaunch({
  executable: process.execPath,
  args: ['-e', source],
  cwd: process.cwd(),
  env,
});

test('captures stdout and stderr and propagates the exact exit code without a shell', async () => {
  const descriptor = nodeLaunch("process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 17");
  assert.equal(descriptor.spawnOptions.shell, false);
  const result = await runLaunch(descriptor, { timeoutMs: 2_000 });
  assert.deepEqual({ classification: result.classification, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }, {
    classification: 'exit', exitCode: 17, stdout: 'out', stderr: 'err',
  });
});

test('classifies timeout separately', async () => {
  const result = await runLaunch(nodeLaunch('setInterval(() => {}, 1000)'), { timeoutMs: 30 });
  assert.equal(result.classification, 'timeout');
  assert.equal(result.exitCode, null);
});

test('classifies AbortSignal cancellation separately', async () => {
  const controller = new AbortController();
  const pending = runLaunch(nodeLaunch('setInterval(() => {}, 1000)'), { timeoutMs: 2_000, signal: controller.signal });
  controller.abort();
  assert.equal((await pending).classification, 'cancelled');
});

test('classifies a missing executable as spawn_error', async () => {
  const descriptor = resolveLaunch({ executable: path.join(os.tmpdir(), 'labwired-does-not-exist'), args: [], cwd: process.cwd(), env: {} });
  const result = await runLaunch(descriptor, { timeoutMs: 500 });
  assert.equal(result.classification, 'spawn_error');
  assert.match(result.error, /ENOENT|not found/i);
});

test('redacts secrets from spawn-error diagnostics and streamed deltas', async () => {
  const secret = 'spawn-error-secret';
  const deltas = [];
  const descriptor = resolveLaunch({
    executable: path.join(os.tmpdir(), `${secret}-missing`),
    args: [],
    cwd: process.cwd(),
    env: {},
  });
  const result = await runLaunch(descriptor, {
    timeoutMs: 500,
    redact: [secret],
    onDelta: (delta) => deltas.push(delta),
  });
  assert.equal(result.classification, 'spawn_error');
  assert.equal(JSON.stringify({ result, deltas }).includes(secret), false);
  assert.match(result.error, /\[REDACTED\]/);
});

test('passes only explicitly allowlisted environment entries', async () => {
  const descriptor = nodeLaunch("process.stdout.write(JSON.stringify({ kept: process.env.LABWIRED_ALLOWED, leaked: process.env.LABWIRED_UNLISTED }))", { LABWIRED_ALLOWED: 'yes' });
  process.env.LABWIRED_UNLISTED = 'no';
  try {
    const result = await runLaunch(descriptor, { timeoutMs: 2_000 });
    assert.deepEqual(JSON.parse(result.stdout), { kept: 'yes' });
  } finally {
    delete process.env.LABWIRED_UNLISTED;
  }
});

test('redacts secrets before streaming or retaining output', async () => {
  const deltas = [];
  const result = await runLaunch(nodeLaunch("process.stdout.write('token=swordfish'); process.stderr.write('swordfish')"), {
    timeoutMs: 2_000,
    redact: ['swordfish'],
    onDelta: (delta) => deltas.push(delta),
  });
  assert.equal(result.stdout, 'token=[REDACTED]');
  assert.equal(result.stderr, '[REDACTED]');
  assert.equal(JSON.stringify(deltas).includes('swordfish'), false);
});

test('retains bounded evidence while reporting truncation', async () => {
  const result = await runLaunch(nodeLaunch("process.stdout.write('x'.repeat(2_000_000))"), { timeoutMs: 2_000 });
  assert.ok(Buffer.byteLength(result.stdout) <= 1024 * 1024);
  assert.equal(result.truncated.stdout, true);
});

test('retention cap does not split a multibyte UTF-8 code point', async () => {
  const result = await runLaunch(nodeLaunch("process.stdout.write('€'.repeat(400_000))"), { timeoutMs: 2_000 });
  assert.ok(Buffer.byteLength(result.stdout) <= 1024 * 1024);
  assert.equal(result.stdout.includes('\uFFFD'), false);
  assert.equal(result.truncated.stdout, true);
});

test('terminates descendants when timing out on POSIX', { skip: process.platform === 'win32' }, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'labwired-process-'));
  const marker = path.join(temporary, 'descendant-survived');
  const grandchild = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad'), 250)`;
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {stdio:'ignore'}); setInterval(() => {}, 1000)`;
  const result = await runLaunch(nodeLaunch(parent), { timeoutMs: 30 });
  assert.equal(result.classification, 'timeout');
  await delay(400);
  assert.equal(fs.existsSync(marker), false);
  fs.rmSync(temporary, { recursive: true });
});

test('preserves leader exit when a descendant holds inherited pipes beyond the timeout', { skip: process.platform === 'win32' }, async () => {
  const descendant = "setInterval(() => {}, 1000)";
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'inherit'}); process.exit(0)`;
  const result = await runLaunch(nodeLaunch(parent), { timeoutMs: 100 });
  assert.equal(result.classification, 'exit');
  assert.equal(result.exitCode, 0);
});

function fakeTaskkill({ error, exitCode = 0 } = {}) {
  const process = new EventEmitter();
  process.unref = () => {};
  queueMicrotask(() => error ? process.emit('error', error) : process.emit('close', exitCode));
  return process;
}

test('awaits successful Windows taskkill tree termination', async () => {
  const calls = [];
  const child = { pid: 123, exitCode: null, kill: () => assert.fail('direct kill should not be needed') };
  await terminateProcessTree(child, 'win32', {
    spawnProcess: (...args) => { calls.push(args); return fakeTaskkill(); },
    timeoutMs: 100,
  });
  assert.deepEqual(calls[0].slice(0, 2), ['taskkill.exe', ['/pid', '123', '/t', '/f']]);
  assert.equal(calls[0][2].shell, false);
});

test('handles Windows taskkill spawn failure and falls back to direct kill', async () => {
  let killed = false;
  const child = { pid: 123, exitCode: null, kill: () => { killed = true; } };
  await terminateProcessTree(child, 'win32', {
    spawnProcess: () => fakeTaskkill({ error: Object.assign(new Error('missing'), { code: 'ENOENT' }) }),
    timeoutMs: 100,
  });
  assert.equal(killed, true);
});

test('handles nonzero Windows taskkill exit and falls back to direct kill', async () => {
  let killed = false;
  const child = { pid: 123, exitCode: null, kill: () => { killed = true; } };
  await terminateProcessTree(child, 'win32', {
    spawnProcess: () => fakeTaskkill({ exitCode: 1 }),
    timeoutMs: 100,
  });
  assert.equal(killed, true);
});

test('normalizes win32 PowerShell scripts and rejects command shims', () => {
  const ps = resolveLaunch({ executable: 'C:\\kit\\flash.ps1', args: ['--port', 'COM7'], cwd: 'C:\\kit', env: {} }, {
    platform: 'win32', pathEnv: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
  });
  assert.match(ps.command, /powershell\.exe$/i);
  assert.deepEqual(ps.args, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\kit\\flash.ps1', '--port', 'COM7']);
  assert.equal(ps.spawnOptions.shell, false);
  assert.throws(() => resolveLaunch({ executable: 'flash.cmd', args: [], cwd: 'C:\\kit', env: {} }, { platform: 'win32', pathEnv: '' }), /\.cmd/i);
});
