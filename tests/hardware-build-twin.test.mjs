import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createTrustedAdapters } from '../lib/hardware/adapters.mjs';
import { sha256File } from '../lib/hardware/evidence.mjs';

const temporaryRoots = new Set();
process.once('exit', () => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

async function sandbox() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'labwired-adapters-'));
  temporaryRoots.add(root);
  await mkdir(path.join(root, 'build'), { recursive: true });
  await writeFile(path.join(root, 'system.yaml'), 'chip: fixture\n');
  return root;
}

function profile(root, provider = 'platformio') {
  return {
    schema: 1,
    target: { id: 'fixture', chip: 'fixture-chip' },
    build: {
      provider,
      workspace: root,
      environment: provider === 'cmake' ? 'build' : 'test-env',
      artifact: path.join(root, 'build', 'firmware.elf'),
      timeoutSeconds: 2,
    },
    twin: {
      provider: 'labwired-sim',
      system: path.join(root, 'system.yaml'),
      artifactRelation: 'exact',
      timeoutSeconds: 2,
    },
    observations: [{ id: 'alive', provider: 'serial', contains: 'ALIVE', requiredLevel: 'model_observed' }],
  };
}

function harness(onRun) {
  const calls = [];
  const tools = { pio: '/trusted/pio', make: '/trusted/make', cmake: '/trusted/cmake', 'labwired-sim': '/trusted/labwired-sim' };
  const adapters = createTrustedAdapters({
    env: { PATH: '/trusted', LANG: 'C' },
    async resolveTool(name) { return tools[name]; },
    async toolVersion(name) { return `${name} 1.2.3`; },
    async run(descriptor, options) {
      calls.push({ descriptor, options });
      return onRun ? onRun(descriptor, options, calls.length) : { classification: 'exit', exitCode: 0, stdout: '', stderr: '', truncated: { stdout: false, stderr: false } };
    },
  });
  return { adapters, calls };
}

test('build plans exact shell-free PlatformIO, Make, and CMake descriptors', async (t) => {
  for (const [provider, args] of [
    ['platformio', ['run', '-e', 'test-env']],
    ['make', null],
    ['cmake', null],
  ]) await t.test(provider, async () => {
    const root = await sandbox();
    const { adapters } = harness();
    const selected = adapters.build[provider];
    const ready = await selected.preflight(profile(root, provider));
    const launch = selected.plan(profile(root, provider), ready);
    assert.equal(launch.executable, `/trusted/${provider === 'platformio' ? 'pio' : provider}`);
    assert.deepEqual(launch.args, args ?? (provider === 'make' ? ['-C', root] : ['--build', path.join(root, 'build')]));
    assert.equal(launch.cwd, root);
    assert.equal(launch.shell, false);
    assert.deepEqual(launch.env, { PATH: '/trusted', LANG: 'C' });
  });
});

test('successful build requires a freshly produced regular artifact and hashes exact bytes', async (t) => {
  const root = await sandbox();
  const artifact = profile(root).build.artifact;
  const { adapters } = harness(async () => {
    await writeFile(artifact, Buffer.from([0, 1, 2, 255]));
    return { classification: 'exit', exitCode: 0, stdout: 'built', stderr: '', truncated: { stdout: false, stderr: false } };
  });
  const result = await adapters.build.platformio.execute(profile(root));
  assert.equal(result.level, 'compiled');
  assert.equal(result.artifactSha256, await sha256File(artifact));
  assert.equal(result.toolVersion, 'pio 1.2.3');
});

test('nonzero, timeout, absent, stale, symlink, and escaped artifacts never compile', async (t) => {
  for (const scenario of ['nonzero', 'timeout', 'absent', 'stale', 'symlink', 'escape']) await t.test(scenario, async () => {
    const root = await sandbox();
    const p = profile(root);
    if (scenario === 'escape') p.build.artifact = path.join(root, '..', 'outside.elf');
    if (scenario === 'stale') await writeFile(p.build.artifact, 'old');
    if (scenario === 'symlink') {
      const outside = path.join(root, 'outside.elf');
      await writeFile(outside, 'outside');
      await import('node:fs/promises').then(({ symlink }) => symlink(outside, p.build.artifact));
    }
    const { adapters } = harness(async () => ({
      classification: scenario === 'timeout' ? 'timeout' : 'exit',
      exitCode: scenario === 'nonzero' ? 3 : (scenario === 'timeout' ? null : 0),
      stdout: '', stderr: scenario === 'nonzero' ? 'secret-value' : '', truncated: { stdout: false, stderr: false },
    }));
    const result = await adapters.build.platformio.execute(p, { redact: ['secret-value'] });
    assert.equal(result.level, 'failed');
    assert.doesNotMatch(JSON.stringify(result), /secret-value/);
  });
});

test('adapter selection and typed fields cannot become commands or option escapes', async (t) => {
  const root = await sandbox();
  const { adapters } = harness();
  assert.equal(Object.hasOwn(adapters.build, 'custom'), false);
  const unsafe = profile(root);
  unsafe.build.environment = '--project-dir=/tmp/escape';
  await assert.rejects(adapters.build.platformio.preflight(unsafe), /environment/);
  const cmakeEscape = profile(root, 'cmake');
  cmakeEscape.build.environment = '../escape';
  await assert.rejects(adapters.build.cmake.preflight(cmakeEscape), /build directory/);
});

test('twin uses test-file contract with selected system and exact artifact', async (t) => {
  const root = await sandbox();
  const p = profile(root);
  await writeFile(p.build.artifact, 'native');
  const nativeHash = await sha256File(p.build.artifact);
  let script;
  const { adapters, calls } = harness(async (descriptor) => {
    script = await readFile(descriptor.args[2], 'utf8');
    const output = descriptor.args[4];
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'pass', firmware_hash: nativeHash, assertions: [{ passed: true }] }));
    return { classification: 'exit', exitCode: 0, stdout: '', stderr: '', truncated: { stdout: false, stderr: false } };
  });
  const result = await adapters.twin['labwired-sim'].execute(p, { nativeArtifactSha256: nativeHash });
  assert.equal(result.level, 'model_observed');
  assert.equal(result.nativeArtifactSha256, nativeHash);
  assert.match(script, new RegExp(`firmware: ${JSON.stringify(p.build.artifact)}`));
  assert.match(script, new RegExp(`system: ${JSON.stringify(p.twin.system)}`));
  assert.deepEqual(calls[0].descriptor.args.slice(0, 2), ['test', '--script']);
  assert.equal(calls[0].descriptor.shell, false);
});

test('different supported artifact is labeled surrogate with both hashes and provenance', async (t) => {
  const root = await sandbox();
  const p = profile(root);
  p.twin.artifactRelation = 'surrogate';
  await writeFile(p.build.artifact, 'native');
  const surrogate = path.join(root, 'build', 'surrogate.elf');
  await writeFile(surrogate, 'surrogate');
  const nativeHash = await sha256File(p.build.artifact);
  const surrogateHash = await sha256File(surrogate);
  const { adapters } = harness(async (descriptor) => {
    const output = descriptor.args[4];
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'pass', firmware_hash: surrogateHash, assertions: [{ passed: true }] }));
    return { classification: 'exit', exitCode: 0, stdout: '', stderr: '', truncated: { stdout: false, stderr: false } };
  });
  const result = await adapters.twin['labwired-sim'].execute(p, {
    nativeArtifactSha256: nativeHash,
    twinArtifact: surrogate,
    sharedSourcePaths: ['src/main.cpp'],
  });
  assert.equal(result.level, 'surrogate_model_observed');
  assert.equal(result.nativeArtifactSha256, nativeHash);
  assert.equal(result.surrogateArtifactSha256, surrogateHash);
  assert.deepEqual(result.sharedSourcePaths, ['src/main.cpp']);
});

test('unsupported native twin execution is blocked and never upgrades compilation', async (t) => {
  const root = await sandbox();
  const p = profile(root);
  await writeFile(p.build.artifact, 'arduino-elf');
  const hash = await sha256File(p.build.artifact);
  const { adapters } = harness(async () => ({ classification: 'exit', exitCode: 2, stdout: '', stderr: 'unsupported firmware format', truncated: { stdout: false, stderr: false } }));
  const result = await adapters.twin['labwired-sim'].execute(p, { nativeArtifactSha256: hash });
  assert.equal(result.level, 'blocked');
  assert.notEqual(result.level, 'model_observed');
  assert.match(result.diagnostics, /unsupported/i);
});

test('a passing exit without genuine simulator result cannot yield model evidence', async (t) => {
  const root = await sandbox();
  const p = profile(root);
  await writeFile(p.build.artifact, 'native');
  const hash = await sha256File(p.build.artifact);
  const { adapters } = harness();
  const result = await adapters.twin['labwired-sim'].execute(p, { nativeArtifactSha256: hash });
  assert.equal(result.level, 'failed');
});
