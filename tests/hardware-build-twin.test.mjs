import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, readdir, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createTrustedAdapters } from '../lib/hardware/adapters.mjs';
import { createEvidenceBundle, levelSatisfies, sha256File } from '../lib/hardware/evidence.mjs';

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

function passingResult(firmwareHash, marker = 'ALIVE', extraAssertions = []) {
  return {
    status: 'pass',
    firmware_hash: firmwareHash,
    assertions: [{ assertion: { uart_contains: marker }, passed: true }, ...extraAssertions],
  };
}

function firmwareFromScript(script) {
  const line = script.split('\n').find((entry) => entry.startsWith('  firmware: '));
  return JSON.parse(line.slice('  firmware: '.length));
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

test('build quarantines old output: no-op, touch, and chmod fail while genuine recreate passes', async (t) => {
  for (const scenario of ['noop', 'touch', 'chmod', 'recreate']) await t.test(scenario, async () => {
    const root = await sandbox();
    const p = profile(root);
    await writeFile(p.build.artifact, 'identical');
    const { adapters } = harness(async () => {
      if (scenario === 'touch') await utimes(p.build.artifact, new Date(), new Date()).catch(() => {});
      if (scenario === 'chmod') await chmod(p.build.artifact, 0o600).catch(() => {});
      if (scenario === 'recreate') await writeFile(p.build.artifact, 'identical');
      return { classification: 'exit', exitCode: 0, stdout: '', stderr: '', truncated: { stdout: false, stderr: false } };
    });
    const result = await adapters.build.platformio.execute(p);
    assert.equal(result.level, scenario === 'recreate' ? 'compiled' : 'failed');
    assert.equal(await readFile(p.build.artifact, 'utf8'), 'identical');
  });
});

test('failed build restores quarantine only when destination is absent and never overwrites replacement', async (t) => {
  for (const replacement of [false, true]) await t.test(replacement ? 'replacement preserved' : 'old artifact restored', async () => {
    const root = await sandbox();
    const p = profile(root);
    await writeFile(p.build.artifact, 'old');
    const { adapters } = harness(async () => {
      if (replacement) await writeFile(p.build.artifact, 'new-partial');
      return { classification: 'exit', exitCode: 2, stdout: '', stderr: 'failed', truncated: { stdout: false, stderr: false } };
    });
    const result = await adapters.build.platformio.execute(p);
    assert.equal(result.level, 'failed');
    assert.equal(await readFile(p.build.artifact, 'utf8'), replacement ? 'new-partial' : 'old');
    const names = await readdir(path.dirname(p.build.artifact));
    assert.equal(names.some((name) => name.includes('labwired-quarantine')), replacement);
  });
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

test('plans accept only adapter-owned preflight capabilities bound to unchanged inputs', async () => {
  const root = await sandbox();
  const { adapters } = harness();
  const pioProfile = profile(root);
  const pioReady = await adapters.build.platformio.preflight(pioProfile);
  assert.throws(() => { pioReady.executable = '/bin/sh'; }, /read only|Cannot assign/);
  assert.throws(() => adapters.build.platformio.plan(pioProfile, { executable: '/bin/sh', toolVersion: 'forged' }), /capability/);

  const makeProfile = profile(root, 'make');
  assert.throws(() => adapters.build.make.plan(makeProfile, pioReady), /capability/);
  pioProfile.build.environment = 'changed';
  assert.throws(() => adapters.build.platformio.plan(pioProfile, pioReady), /changed/);

  const twinProfile = profile(root);
  const twinReady = await adapters.twin['labwired-sim'].preflight(twinProfile);
  assert.throws(
    () => adapters.twin['labwired-sim'].plan(twinProfile, twinReady, { script: '/tmp/forged', output: '/tmp/forged-output' }),
    /runtime capability/,
  );
});

test('twin uses test-file contract with selected system and exact artifact', async (t) => {
  const root = await sandbox();
  const p = profile(root);
  await writeFile(p.build.artifact, 'native');
  const nativeHash = await sha256File(p.build.artifact);
  let script;
  let stagedArtifact;
  let stagedSystem;
  let stagedSystemHash;
  let stagedHash;
  const { adapters, calls } = harness(async (descriptor) => {
    script = await readFile(descriptor.args[2], 'utf8');
    stagedArtifact = firmwareFromScript(script);
    stagedSystem = JSON.parse(script.split('\n').find((entry) => entry.startsWith('  system: ')).slice('  system: '.length));
    stagedSystemHash = await sha256File(stagedSystem);
    stagedHash = await sha256File(stagedArtifact);
    const output = descriptor.args[4];
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, 'result.json'), JSON.stringify(passingResult(nativeHash)));
    return { classification: 'exit', exitCode: 0, stdout: '', stderr: '', truncated: { stdout: false, stderr: false } };
  });
  const result = await adapters.twin['labwired-sim'].execute(p, { nativeArtifactSha256: nativeHash });
  assert.equal(result.level, 'model_observed');
  assert.equal(result.nativeArtifactSha256, nativeHash);
  assert.notEqual(stagedArtifact, p.build.artifact);
  assert.notEqual(stagedSystem, p.twin.system);
  assert.equal(stagedHash, nativeHash);
  assert.equal(stagedSystemHash, await sha256File(p.twin.system));
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
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'main.cpp'), 'shared source');
  const nativeHash = await sha256File(p.build.artifact);
  const surrogateHash = await sha256File(surrogate);
  const { adapters } = harness(async (descriptor) => {
    const output = descriptor.args[4];
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, 'result.json'), JSON.stringify(passingResult(surrogateHash)));
    return { classification: 'exit', exitCode: 0, stdout: '', stderr: '', truncated: { stdout: false, stderr: false } };
  });
  const result = await adapters.twin['labwired-sim'].execute(p, {
    nativeArtifactSha256: nativeHash,
    twinArtifact: surrogate,
    sharedSourcePaths: ['src/main.cpp'],
  });
  assert.equal(result.level, 'surrogate_model_observed');
  assert.equal(result.artifactSha256, nativeHash);
  assert.equal(result.surrogateArtifactSha256, surrogateHash);
  assert.deepEqual(result.sharedSourcePaths, ['src/main.cpp']);
  assert.deepEqual(Object.keys(result).sort(), [
    'artifactSha256', 'level', 'provider', 'sharedSourcePaths', 'surrogateArtifactSha256', 'toolVersion',
  ]);
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

test('twin requires an exact well-formed native build hash before launching', async (t) => {
  for (const supplied of [undefined, 'bad', '0'.repeat(64)]) await t.test(String(supplied), async () => {
    const root = await sandbox();
    const p = profile(root);
    await writeFile(p.build.artifact, 'native');
    let runs = 0;
    const { adapters } = harness(async () => { runs += 1; return { classification: 'exit', exitCode: 0, stdout: '', stderr: '', truncated: { stdout: false, stderr: false } }; });
    const result = await adapters.twin['labwired-sim'].execute(p, { nativeArtifactSha256: supplied });
    assert.equal(result.level, 'failed');
    assert.equal(runs, 0);
  });
});

test('twin result assertions must exactly match requested kind, value, count, and pass state', async (t) => {
  for (const [name, assertions] of [
    ['wrong marker', [{ assertion: { uart_contains: 'WRONG' }, passed: true }]],
    ['missing assertion', []],
    ['duplicate assertion', [
      { assertion: { uart_contains: 'ALIVE' }, passed: true },
      { assertion: { uart_contains: 'ALIVE' }, passed: true },
    ]],
    ['extra assertion', [
      { assertion: { uart_contains: 'ALIVE' }, passed: true },
      { assertion: { uart_contains: 'EXTRA' }, passed: true },
    ]],
    ['failed assertion', [{ assertion: { uart_contains: 'ALIVE' }, passed: false }]],
  ]) await t.test(name, async () => {
    const root = await sandbox();
    const p = profile(root);
    await writeFile(p.build.artifact, 'native');
    const hash = await sha256File(p.build.artifact);
    const { adapters } = harness(async (descriptor) => {
      const output = descriptor.args[4];
      await writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'pass', firmware_hash: hash, assertions }));
      return { classification: 'exit', exitCode: 0, stdout: '', stderr: '', truncated: { stdout: false, stderr: false } };
    });
    const result = await adapters.twin['labwired-sim'].execute(p, { nativeArtifactSha256: hash });
    assert.equal(result.level, 'failed');
  });
});

test('mutation or replacement of original or staged firmware invalidates model evidence', async (t) => {
  for (const scenario of ['original-mutate', 'original-replace', 'staged-mutate', 'staged-replace']) await t.test(scenario, async () => {
    const root = await sandbox();
    const p = profile(root);
    await writeFile(p.build.artifact, 'native');
    const hash = await sha256File(p.build.artifact);
    const { adapters } = harness(async (descriptor) => {
      const script = await readFile(descriptor.args[2], 'utf8');
      const staged = firmwareFromScript(script);
      const target = scenario.startsWith('original') ? p.build.artifact : staged;
      if (scenario.endsWith('replace')) await unlink(target);
      await writeFile(target, 'mutated');
      const output = descriptor.args[4];
      await writeFile(path.join(output, 'result.json'), JSON.stringify(passingResult(hash)));
      return { classification: 'exit', exitCode: 0, stdout: '', stderr: '', truncated: { stdout: false, stderr: false } };
    });
    const result = await adapters.twin['labwired-sim'].execute(p, { nativeArtifactSha256: hash });
    assert.equal(result.level, 'failed');
  });
});

test('mutation or replacement of original or staged twin system invalidates model evidence', async (t) => {
  for (const scenario of ['original-mutate', 'original-replace', 'staged-mutate', 'staged-replace']) await t.test(scenario, async () => {
    const root = await sandbox();
    const p = profile(root);
    await writeFile(p.build.artifact, 'native');
    const hash = await sha256File(p.build.artifact);
    const { adapters } = harness(async (descriptor) => {
      const script = await readFile(descriptor.args[2], 'utf8');
      const staged = JSON.parse(script.split('\n').find((entry) => entry.startsWith('  system: ')).slice('  system: '.length));
      const target = scenario.startsWith('original') ? p.twin.system : staged;
      if (scenario.endsWith('replace')) await unlink(target);
      await writeFile(target, 'mutated system');
      await writeFile(path.join(descriptor.args[4], 'result.json'), JSON.stringify(passingResult(hash)));
      return { classification: 'exit', exitCode: 0, stdout: '', stderr: '', truncated: { stdout: false, stderr: false } };
    });
    const result = await adapters.twin['labwired-sim'].execute(p, { nativeArtifactSha256: hash });
    assert.equal(result.level, 'failed');
  });
});

test('surrogate shared sources must be unique existing contained regular files and remain unchanged', async (t) => {
  for (const scenario of ['missing', 'symlink', 'duplicate', 'alias', 'mutate', 'replace']) await t.test(scenario, async () => {
    const root = await sandbox();
    const p = profile(root);
    p.twin.artifactRelation = 'surrogate';
    await writeFile(p.build.artifact, 'native');
    const surrogate = path.join(root, 'build', 'surrogate.elf');
    await writeFile(surrogate, 'surrogate');
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src', 'main.cpp'), 'shared');
    if (scenario === 'symlink') {
      await writeFile(path.join(root, 'outside.cpp'), 'outside');
      await symlink(path.join(root, 'outside.cpp'), path.join(root, 'src', 'link.cpp'));
    }
    const sources = scenario === 'missing' ? ['src/missing.cpp']
      : scenario === 'symlink' ? ['src/link.cpp']
        : scenario === 'duplicate' ? ['src/main.cpp', 'src/main.cpp']
          : scenario === 'alias' ? ['src/main.cpp', 'SRC/MAIN.CPP']
            : ['src/main.cpp'];
    let runs = 0;
    const nativeHash = await sha256File(p.build.artifact);
    const surrogateHash = await sha256File(surrogate);
    const { adapters } = harness(async (descriptor) => {
      runs += 1;
      if (scenario === 'mutate' || scenario === 'replace') {
        const source = path.join(root, 'src', 'main.cpp');
        if (scenario === 'replace') await unlink(source);
        await writeFile(source, 'changed');
      }
      await writeFile(path.join(descriptor.args[4], 'result.json'), JSON.stringify(passingResult(surrogateHash)));
      return { classification: 'exit', exitCode: 0, stdout: '', stderr: '', truncated: { stdout: false, stderr: false } };
    });
    const result = await adapters.twin['labwired-sim'].execute(p, {
      nativeArtifactSha256: nativeHash,
      twinArtifact: surrogate,
      sharedSourcePaths: sources,
    });
    assert.equal(result.level, 'failed');
    assert.equal(runs, ['mutate', 'replace'].includes(scenario) ? 1 : 0);
  });
});

test('surrogate adapter output normalizes into the real evidence contract without upgrading model requirements', async () => {
  const root = await sandbox();
  const p = profile(root);
  p.twin.artifactRelation = 'surrogate';
  await writeFile(p.build.artifact, 'native');
  const surrogate = path.join(root, 'build', 'surrogate.elf');
  await writeFile(surrogate, 'surrogate');
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'main.cpp'), 'shared');
  const nativeHash = await sha256File(p.build.artifact);
  const surrogateHash = await sha256File(surrogate);
  const { adapters } = harness(async (descriptor) => {
    await writeFile(path.join(descriptor.args[4], 'result.json'), JSON.stringify(passingResult(surrogateHash)));
    return { classification: 'exit', exitCode: 0, stdout: '', stderr: '', truncated: { stdout: false, stderr: false } };
  });
  const adapterResult = await adapters.twin['labwired-sim'].execute(p, {
    nativeArtifactSha256: nativeHash,
    twinArtifact: surrogate,
    sharedSourcePaths: ['src/main.cpp'],
  });
  assert.deepEqual(Object.keys(adapterResult).sort(), [
    'artifactSha256', 'level', 'provider', 'sharedSourcePaths', 'surrogateArtifactSha256', 'toolVersion',
  ]);

  const bundleRoot = path.join(root, 'evidence');
  const evidence = await createEvidenceBundle(bundleRoot, p);
  await mkdir(path.join(bundleRoot, 'captures'));
  await writeFile(path.join(bundleRoot, 'captures', 'alive.txt'), 'surrogate simulator assertion evidence\n');
  const startedAt = new Date().toISOString();
  const record = await evidence.recordBehavior('alive', {
    ...adapterResult,
    behaviorId: 'alive',
    provider: p.observations[0].provider,
    targetIdentity: { ...p.target },
    startedAt,
    endedAt: new Date().toISOString(),
    rawEvidenceRefs: ['captures/alive.txt'],
    diagnostics: { simulator: 'passed exact requested assertion against surrogate' },
  });
  assert.equal(record.level, 'surrogate_model_observed');
  assert.equal(levelSatisfies(record.level, 'model_observed'), false);
  const summary = await evidence.finalize();
  assert.equal(summary.result, 'FAIL');
  assert.equal(summary.reasons[0].actualLevel, 'surrogate_model_observed');
  assert.equal(summary.reasons[0].requiredLevel, 'model_observed');
});
