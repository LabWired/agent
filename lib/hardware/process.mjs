import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const MAX_RETAINED_BYTES = 1024 * 1024;
const WINDOWS_SCRIPT_EXTENSIONS = new Set(['.bat', '.cmd']);

function assertLaunchInput(launch) {
  if (!launch || typeof launch.executable !== 'string' || launch.executable.length === 0) {
    throw new TypeError('launch executable must be a non-empty string');
  }
  if (!Array.isArray(launch.args) || !launch.args.every((argument) => typeof argument === 'string')) {
    throw new TypeError('launch args must be an array of strings');
  }
  if (typeof launch.cwd !== 'string' || launch.cwd.length === 0) {
    throw new TypeError('launch cwd must be a non-empty string');
  }
  if (!launch.env || typeof launch.env !== 'object' || Array.isArray(launch.env)) {
    throw new TypeError('launch env must be an object');
  }
}

function allowedEnvironment(environment) {
  const result = Object.create(null);
  for (const [name, value] of Object.entries(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new TypeError(`invalid environment name ${name}`);
    if (typeof value !== 'string') throw new TypeError(`environment value ${name} must be a string`);
    result[name] = value;
  }
  return result;
}

function powershellHost(pathEnv) {
  const names = ['pwsh.exe', 'powershell.exe'];
  for (const directory of String(pathEnv ?? '').split(';').filter(Boolean)) {
    for (const name of names) {
      const candidate = path.win32.join(directory, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  const firstDirectory = String(pathEnv ?? '').split(';').find(Boolean);
  return firstDirectory ? path.win32.join(firstDirectory, 'powershell.exe') : 'powershell.exe';
}

export function resolveLaunch(launch, options = {}) {
  assertLaunchInput(launch);
  const platform = options.platform ?? process.platform;
  const extension = path.win32.extname(launch.executable).toLowerCase();
  if (platform === 'win32' && WINDOWS_SCRIPT_EXTENSIONS.has(extension)) {
    throw new TypeError(`${extension} launchers require a kit-owned safe adapter`);
  }

  let command = launch.executable;
  let args = [...launch.args];
  if (platform === 'win32' && extension === '.ps1') {
    command = powershellHost(options.pathEnv ?? process.env.PATH);
    args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launch.executable, ...args];
  }

  return Object.freeze({
    command,
    args: Object.freeze(args),
    cwd: launch.cwd,
    env: Object.freeze(allowedEnvironment(launch.env)),
    platform,
    spawnOptions: Object.freeze({ shell: false, detached: platform !== 'win32' }),
  });
}

export async function terminateProcessTree(child, platform = process.platform, dependencies = {}) {
  if (!child || child.pid === undefined) return;
  const directKill = () => {
    try { child.kill('SIGKILL'); } catch { /* process already exited */ }
  };
  if (platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH' || child.exitCode === null) directKill();
    }
    return;
  }

  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const timeoutMs = dependencies.timeoutMs ?? 2_000;
  let killer;
  try {
    killer = spawnProcess('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch {
    directKill();
    return;
  }

  const succeeded = await new Promise((resolve) => {
    let complete = false;
    const finish = (result) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { killer.kill?.('SIGKILL'); } catch { /* taskkill already exited */ }
      finish(false);
    }, timeoutMs);
    timer.unref?.();
    killer.once('error', () => finish(false));
    killer.once('close', (code) => finish(code === 0));
  });
  if (!succeeded) directKill();
}

function redactor(values) {
  const secrets = (Array.isArray(values) ? values : values ? [values] : [])
    .filter((value) => typeof value === 'string' && value.length > 0);
  return {
    secrets,
    apply(value) {
      return secrets.reduce((output, secret) => output.split(secret).join('[REDACTED]'), value);
    },
  };
}

function boundedAppend(state, value) {
  const available = MAX_RETAINED_BYTES - state.bytes;
  if (available <= 0) {
    state.truncated = true;
    return;
  }
  const buffer = Buffer.from(value);
  let retainedBytes = Math.min(available, buffer.length);
  if (retainedBytes < buffer.length) {
    while (retainedBytes > 0 && (buffer[retainedBytes] & 0xC0) === 0x80) retainedBytes -= 1;
  }
  const retained = buffer.subarray(0, retainedBytes);
  state.value += retained.toString('utf8');
  state.bytes += retained.length;
  if (retained.length < buffer.length) state.truncated = true;
}

export function runLaunch(descriptor, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
  const filter = redactor(options.redact);

  return new Promise((resolve) => {
    let classification = 'exit';
    let spawnError;
    let settled = false;
    let leaderExitCode;
    let leaderSignal;
    let termination = Promise.resolve();
    let closeFallback;
    const output = {
      stdout: { value: '', bytes: 0, truncated: false, pending: '', decoder: new StringDecoder('utf8') },
      stderr: { value: '', bytes: 0, truncated: false, pending: '', decoder: new StringDecoder('utf8') },
    };

    const child = spawn(descriptor.command, descriptor.args, {
      cwd: descriptor.cwd,
      env: descriptor.env,
      shell: false,
      detached: descriptor.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const emit = (stream, text, final = false) => {
      const state = output[stream];
      state.pending += text;
      let safe = '';
      if (final) {
        safe = filter.apply(state.pending);
        state.pending = '';
      } else {
        while (state.pending.length > 0) {
          const matches = filter.secrets
            .map((secret) => ({ secret, index: state.pending.indexOf(secret) }))
            .filter((match) => match.index >= 0)
            .sort((left, right) => left.index - right.index || right.secret.length - left.secret.length);
          if (matches.length > 0) {
            const match = matches[0];
            safe += state.pending.slice(0, match.index) + '[REDACTED]';
            state.pending = state.pending.slice(match.index + match.secret.length);
            continue;
          }
          let retainedPrefix = 0;
          for (const secret of filter.secrets) {
            for (let length = Math.min(secret.length - 1, state.pending.length); length > retainedPrefix; length -= 1) {
              if (state.pending.endsWith(secret.slice(0, length))) {
                retainedPrefix = length;
                break;
              }
            }
          }
          safe += state.pending.slice(0, state.pending.length - retainedPrefix);
          state.pending = state.pending.slice(state.pending.length - retainedPrefix);
          break;
        }
      }
      if (safe.length === 0) return;
      boundedAppend(state, safe);
      options.onDelta?.({ stream, data: safe });
    };
    child.stdout?.on('data', (chunk) => emit('stdout', output.stdout.decoder.write(chunk)));
    child.stderr?.on('data', (chunk) => emit('stderr', output.stderr.decoder.write(chunk)));

    const stop = (reason) => {
      if (leaderExitCode !== undefined) return;
      if (classification === 'exit') classification = reason;
      termination = terminateProcessTree(child, descriptor.platform);
    };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    timer.unref?.();
    const abort = () => stop('cancelled');
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });

    child.once('error', (error) => {
      classification = 'spawn_error';
      spawnError = error;
    });
    child.once('exit', (exitCode, signal) => {
      leaderExitCode = exitCode;
      leaderSignal = signal;
      clearTimeout(timer);
      if (classification === 'exit') {
        closeFallback = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish();
        }, 250);
        closeFallback.unref?.();
      }
    });

    const finish = async (exitCode = leaderExitCode, signal = leaderSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(closeFallback);
      options.signal?.removeEventListener('abort', abort);
      await termination;
      emit('stdout', output.stdout.decoder.end(), true);
      emit('stderr', output.stderr.decoder.end(), true);
      resolve({
        classification,
        exitCode: classification === 'exit' ? exitCode : null,
        signal,
        stdout: output.stdout.value,
        stderr: output.stderr.value,
        truncated: { stdout: output.stdout.truncated, stderr: output.stderr.truncated },
        ...(spawnError ? { error: filter.apply(spawnError.message) } : {}),
      });
    };
    child.once('close', finish);
  });
}
