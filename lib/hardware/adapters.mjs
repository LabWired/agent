import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { redactDeep, sha256File } from './evidence.mjs';
import { resolveLaunch, runLaunch } from './process.mjs';

const SAFE_ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256 = /^[a-f0-9]{64}$/i;

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

async function artifactSnapshot(file, workspace) {
  try {
    const checked = contained(file, workspace, 'build artifact');
    const details = await fs.lstat(checked, { bigint: true });
    if (details.isSymbolicLink() || !details.isFile()) throw new TypeError('build artifact must be a regular non-symlink file');
    const real = await fs.realpath(checked);
    contained(real, await fs.realpath(workspace), 'build artifact');
    return {
      file: checked,
      dev: details.dev.toString(),
      ino: details.ino.toString(),
      size: details.size.toString(),
      mtimeNs: details.mtimeNs.toString(),
      ctimeNs: details.ctimeNs.toString(),
      sha256: await sha256File(checked),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function wasProduced(before, after) {
  if (!before) return true;
  return before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs
    || before.ctimeNs !== after.ctimeNs
    || before.sha256 !== after.sha256;
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

function simulatorScript(profile, artifact, requested) {
  const assertions = requested.map((assertion) => `  - uart_contains: ${yamlString(assertion.uart_contains)}`);
  if (assertions.length === 0) return undefined;
  return [
    'schema_version: "1.0"',
    'inputs:',
    `  firmware: ${yamlString(artifact)}`,
    `  system: ${yamlString(profile.twin.system)}`,
    'limits:',
    '  max_steps: 10000000',
    'assertions:',
    ...assertions,
    '',
  ].join('\n');
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

/** Construct the closed registry of trusted hardware adapters. */
export function createTrustedAdapters(dependencies = {}) {
  const environment = Object.freeze({ ...(dependencies.env ?? process.env) });
  const resolveTool = dependencies.resolveTool ?? ((name) => executableOnPath(name, environment));
  const executeLaunch = dependencies.run ?? ((descriptor, options) => runLaunch(resolveLaunch(descriptor), options));
  const getVersion = dependencies.toolVersion ?? (async (name, executable, cwd) => {
    const result = await executeLaunch(launch(executable, ['--version'], cwd, environment), { timeoutMs: 10_000 });
    if (!processSucceeded(result)) throw new Error(`cannot determine ${name} version`);
    return String(result.stdout || result.stderr).trim().split(/\r?\n/, 1)[0];
  });

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
        capabilities.set(prepared, Object.freeze({ executable, toolVersion, fingerprint: buildFingerprint(profile) }));
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
        let before;
        try {
          before = await artifactSnapshot(profile.build.artifact, profile.build.workspace);
          const prepared = await this.preflight(profile);
          const descriptor = this.plan(profile, prepared);
          const result = await executeLaunch(descriptor, {
            timeoutMs: (profile.build.timeoutSeconds ?? 60) * 1000,
            signal: options.signal,
            redact: options.redact,
            onDelta: options.onDelta,
          });
          if (!processSucceeded(result)) {
            return redactDeep({ level: 'failed', provider, toolVersion: prepared.toolVersion, process: result, diagnostics: diagnostics(result) }, options.redact);
          }
          const after = await artifactSnapshot(profile.build.artifact, profile.build.workspace);
          if (!after) throw new Error('build completed without producing its declared artifact');
          if (!wasProduced(before, after)) throw new Error('build artifact is stale: this run did not produce or update it');
          return redactDeep({
            level: 'compiled', provider, artifact: after.file, artifactSha256: after.sha256,
            toolVersion: prepared.toolVersion, process: result, diagnostics: diagnostics(result),
          }, options.redact);
        } catch (error) {
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
        const prepared = await this.preflight(profile);
        const system = await artifactSnapshot(profile.twin.system, profile.build.workspace);
        if (!system) throw new Error('selected twin system is absent');
        const nativeArtifact = contained(profile.build.artifact, profile.build.workspace, 'native artifact');
        const native = await artifactSnapshot(nativeArtifact, profile.build.workspace);
        if (!native) throw new Error('native artifact is absent');
        if (options.nativeArtifactSha256 && options.nativeArtifactSha256.toLowerCase() !== native.sha256) {
          throw new Error('native artifact hash does not match the build result');
        }
        const relation = profile.twin.artifactRelation;
        const selectedArtifact = relation === 'surrogate'
          ? contained(options.twinArtifact, profile.build.workspace, 'surrogate artifact')
          : nativeArtifact;
        const selected = await artifactSnapshot(selectedArtifact, profile.build.workspace);
        if (!selected) throw new Error('selected twin artifact is absent');
        if (relation === 'exact' && selected.sha256 !== native.sha256) throw new Error('exact twin artifact differs from native artifact');
        if (relation === 'surrogate') {
          if (selected.sha256 === native.sha256) throw new Error('surrogate twin artifact must differ from native artifact');
          if (!Array.isArray(options.sharedSourcePaths) || options.sharedSourcePaths.length === 0
            || !options.sharedSourcePaths.every((entry) => typeof entry === 'string' && entry.length > 0 && !path.isAbsolute(entry) && !entry.split(/[\\/]+/).includes('..'))) {
            throw new TypeError('surrogate twin execution requires safe shared-source provenance');
          }
        }
        const requestedAssertions = requestedTwinAssertions(profile);
        const scriptBody = simulatorScript(profile, selected.file, requestedAssertions);
        if (!scriptBody) return { level: 'blocked', provider: 'labwired-sim', diagnostics: 'no supported twin behavior assertion is configured' };
        temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'labwired-twin-'));
        const stagedArtifact = path.join(temporary, 'firmware.bin');
        await fs.copyFile(selected.file, stagedArtifact, fsConstants.COPYFILE_EXCL);
        await fs.chmod(stagedArtifact, 0o400);
        const stagedBefore = await artifactSnapshot(stagedArtifact, temporary);
        if (!stagedBefore || stagedBefore.sha256 !== selected.sha256) throw new Error('staged artifact does not match selected artifact');
        const stagedScriptBody = simulatorScript(profile, stagedArtifact, requestedAssertions);
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
        const stagedAfter = await artifactSnapshot(stagedArtifact, temporary);
        const selectedAfter = await artifactSnapshot(selected.file, profile.build.workspace);
        const nativeAfter = selected.file === native.file
          ? selectedAfter
          : await artifactSnapshot(native.file, profile.build.workspace);
        if (!sameSnapshot(stagedBefore, stagedAfter)
          || !sameSnapshot(selected, selectedAfter)
          || !sameSnapshot(native, nativeAfter)) {
          throw new Error('firmware artifact changed during twin execution');
        }
        const processDiagnostics = diagnostics(processResult);
        if (!processSucceeded(processResult)) {
          const level = /unsupported|not supported|unknown (?:firmware|architecture|format)/i.test(processDiagnostics) ? 'blocked' : 'failed';
          return redactDeep({ level, provider: 'labwired-sim', toolVersion: prepared.toolVersion, process: processResult, diagnostics: processDiagnostics }, options.redact);
        }
        let observed;
        try { observed = JSON.parse(await fs.readFile(path.join(output, 'result.json'), 'utf8')); }
        catch { return { level: 'failed', provider: 'labwired-sim', toolVersion: prepared.toolVersion, diagnostics: 'simulator did not publish a valid result.json' }; }
        const observedHash = String(observed.firmware_hash ?? '').toLowerCase();
        const genuinelyObserved = observed.status === 'pass'
          && exactAssertionsObserved(observed.assertions, requestedAssertions)
          && SHA256.test(observedHash) && observedHash === selected.sha256;
        if (!genuinelyObserved) {
          return redactDeep({ level: 'failed', provider: 'labwired-sim', toolVersion: prepared.toolVersion, diagnostics: 'simulator result did not prove behavior for the selected artifact', result: observed }, options.redact);
        }
        if (relation === 'exact') {
          return { level: 'model_observed', provider: 'labwired-sim', artifactSha256: selected.sha256, nativeArtifactSha256: native.sha256, toolVersion: prepared.toolVersion };
        }
        return {
          level: 'surrogate_model_observed', provider: 'labwired-sim', artifactSha256: native.sha256,
          nativeArtifactSha256: native.sha256, surrogateArtifactSha256: selected.sha256,
          sharedSourcePaths: [...options.sharedSourcePaths], toolVersion: prepared.toolVersion,
        };
      } catch (error) {
        return redactDeep({ level: 'failed', provider: 'labwired-sim', diagnostics: error.message }, options.redact);
      } finally {
        if (temporary) await fs.rm(temporary, { recursive: true, force: true });
      }
    },
  });

  return Object.freeze({
    build: Object.freeze({ platformio, make, cmake }),
    twin: Object.freeze({ 'labwired-sim': twin }),
  });
}
