import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, readdir, rename, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createTrustedAdapters } from '../lib/hardware/adapters.mjs';
import { createEvidenceBundle, levelSatisfies, sha256File, verifyEvidenceBundle } from '../lib/hardware/evidence.mjs';

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

async function evidenceDirectory(root, p, name = `evidence-${Math.random().toString(16).slice(2)}`) {
  const directory = path.join(root, name);
  await createEvidenceBundle(directory, p);
  return directory;
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

function harness(onRun, dependencyOverrides = {}) {
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
    ...dependencyOverrides,
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

test('tool environments canonicalize Windows runtime key casing and reject conflicting aliases', async () => {
  const root = await sandbox();
  const { adapters } = harness(undefined, { env: { Path: '/trusted', PathExt: '.EXE', SystemRoot: 'C:\\Windows' } });
  const ready = await adapters.build.platformio.preflight(profile(root));
  const descriptor = adapters.build.platformio.plan(profile(root), ready);
  assert.deepEqual(descriptor.env, { PATH: '/trusted', PATHEXT: '.EXE', SystemRoot: 'C:\\Windows' });

  assert.throws(() => harness(undefined, { env: { PATH: '/one', Path: '/two' } }), /conflicting environment aliases/i);
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

test('prebuilt imports an existing exact artifact without launching a compiler', async () => {
  const root = await sandbox();
  const p = profile(root, 'prebuilt');
  await writeFile(p.build.artifact, Buffer.from([0, 1, 2, 255]));
  const { adapters, calls } = harness();
  const evidenceDir = await evidenceDirectory(root, p);
  const prepared = await adapters.build.prebuilt.preflight(p);
  assert.equal(prepared.provider, 'prebuilt');
  assert.equal(adapters.build.prebuilt.plan(p, prepared), null);
  const result = await adapters.build.prebuilt.execute(p, { prepared, evidenceDir });
  assert.equal(result.level, 'imported');
  assert.equal(result.artifactSha256, await sha256File(p.build.artifact));
  assert.deepEqual(result.rawEvidenceRefs, ['observations/import-fixture.json']);
  assert.equal(calls.length, 0);
});

test('prepared build capability refuses a trusted executable identity swap before spawn', async () => {
  const root = await sandbox();
  let identity = { dev: 1, ino: 1, size: 10, mtimeMs: 1 };
  const { adapters, calls } = harness(undefined, { async toolIdentity() { return { ...identity }; } });
  const p = profile(root);
  const prepared = await adapters.build.platformio.preflight(p);
  identity = { ...identity, ino: 2 };
  const result = await adapters.build.platformio.execute(p, { prepared });
  assert.equal(result.level, 'failed');
  assert.match(result.diagnostics, /identity changed/);
  assert.equal(calls.length, 0);
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
    assert.equal(names.some((name) => name.includes('labwired-quarantine')), false);
  });
});

test('repeated failed replacements never overwrite output or leave hidden quarantines', async () => {
  const root = await sandbox();
  const p = profile(root);
  await writeFile(p.build.artifact, 'old');
  let attempt = 0;
  const { adapters } = harness(async () => {
    attempt += 1;
    await writeFile(p.build.artifact, `replacement-${attempt}`);
    return { classification: 'exit', exitCode: 2, stdout: '', stderr: 'failed', truncated: { stdout: false, stderr: false } };
  });
  for (let expected = 1; expected <= 2; expected += 1) {
    const result = await adapters.build.platformio.execute(p);
    assert.equal(result.level, 'failed');
    assert.equal(await readFile(p.build.artifact, 'utf8'), `replacement-${expected}`);
    assert.equal((await readdir(path.dirname(p.build.artifact))).some((name) => name.includes('labwired-quarantine')), false);
  }
});

test('unprovable quarantine cleanup is explicit and includes a bounded recovery path', async () => {
  const root = await sandbox();
  const p = profile(root);
  await writeFile(p.build.artifact, 'old');
  let corrupted = false;
  const { adapters } = harness(async () => {
    await writeFile(p.build.artifact, 'replacement');
    return { classification: 'exit', exitCode: 2, stdout: '', stderr: 'failed', truncated: { stdout: false, stderr: false } };
  }, {
    quarantineHooks: {
      async beforeCleanup(entry) {
        if (!corrupted) {
          corrupted = true;
          await writeFile(entry.quarantine, 'ownership-lost');
        }
      },
    },
  });
  const result = await adapters.build.platformio.execute(p);
  assert.equal(result.level, 'failed');
  assert.equal(await readFile(p.build.artifact, 'utf8'), 'replacement');
  assert.match(result.diagnostics, /quarantine cleanup/i);
  assert.match(result.diagnostics, /recovery path: .*labwired-quarantine-/i);
  assert.ok(result.diagnostics.length < 1024);
});

test('fd snapshot rejects replacement after lstat before open and cannot compile', async () => {
  const root = await sandbox();
  const p = profile(root);
  let attackReady = false;
  let attacked = false;
  const { adapters } = harness(async () => {
    await writeFile(p.build.artifact, 'built');
    attackReady = true;
    return { classification: 'exit', exitCode: 0, stdout: '', stderr: '', truncated: { stdout: false, stderr: false } };
  }, {
    snapshotHooks: {
      async afterLstatBeforeOpen({ file }) {
        if (attackReady && !attacked && file === p.build.artifact) {
          attacked = true;
          await rename(file, `${file}.raced`);
          await writeFile(file, 'replacement');
        }
      },
    },
  });
  const result = await adapters.build.platformio.execute(p);
  assert.equal(result.level, 'failed');
  assert.match(result.diagnostics, /changed|replaced/i);
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
  const result = await adapters.twin['labwired-sim'].execute(p, {
    nativeArtifactSha256: nativeHash,
    evidenceDir: await evidenceDirectory(root, p),
  });
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
    evidenceDir: await evidenceDirectory(root, p),
  });
  assert.equal(result.level, 'surrogate_model_observed');
  assert.equal(result.artifactSha256, nativeHash);
  assert.equal(result.surrogateArtifactSha256, surrogateHash);
  assert.deepEqual(result.sharedSourcePaths, ['src/main.cpp']);
  assert.deepEqual(Object.keys(result).sort(), [
    'artifactSha256', 'level', 'provider', 'rawEvidenceRefs', 'sharedSourcePaths', 'surrogateArtifactSha256', 'toolVersion',
  ]);
});

test('unsupported native twin execution is blocked and never upgrades compilation', async (t) => {
  const root = await sandbox();
  const p = profile(root);
  await writeFile(p.build.artifact, 'arduino-elf');
  const hash = await sha256File(p.build.artifact);
  const { adapters } = harness(async () => ({ classification: 'exit', exitCode: 2, stdout: '', stderr: 'unsupported firmware format', truncated: { stdout: false, stderr: false } }));
  const result = await adapters.twin['labwired-sim'].execute(p, {
    nativeArtifactSha256: hash,
    evidenceDir: await evidenceDirectory(root, p),
  });
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
  const result = await adapters.twin['labwired-sim'].execute(p, {
    nativeArtifactSha256: hash,
    evidenceDir: await evidenceDirectory(root, p),
  });
  assert.equal(result.level, 'failed');
});

test('malformed and oversized simulator results are rejected without raw evidence persistence', async (t) => {
  for (const scenario of ['malformed', 'oversized']) await t.test(scenario, async () => {
    const root = await sandbox();
    const p = profile(root);
    await writeFile(p.build.artifact, 'native');
    const hash = await sha256File(p.build.artifact);
    const evidenceDir = await evidenceDirectory(root, p);
    const { adapters } = harness(async (descriptor) => {
      const body = scenario === 'malformed' ? '{' : JSON.stringify({ padding: 'x'.repeat(140_000) });
      await writeFile(path.join(descriptor.args[4], 'result.json'), body);
      return { classification: 'exit', exitCode: 0, stdout: '', stderr: '', truncated: { stdout: false, stderr: false } };
    });
    const result = await adapters.twin['labwired-sim'].execute(p, { nativeArtifactSha256: hash, evidenceDir });
    assert.equal(result.level, 'failed');
    await assert.rejects(readFile(path.join(evidenceDir, 'twin', 'simulator-output.json')), /ENOENT/);
  });
});

test('simulator result replacement after descriptor read cannot grant or persist replacement claims', async () => {
  const root = await sandbox();
  const p = profile(root);
  await writeFile(p.build.artifact, 'native');
  const hash = await sha256File(p.build.artifact);
  const evidenceDir = await evidenceDirectory(root, p);
  let attacked = false;
  const { adapters } = harness(async (descriptor) => {
    await writeFile(path.join(descriptor.args[4], 'result.json'), JSON.stringify(passingResult(hash)));
    return { classification: 'exit', exitCode: 0, stdout: '', stderr: '', truncated: { stdout: false, stderr: false } };
  }, {
    snapshotHooks: {
      async afterReadBeforePathValidation({ file }) {
        if (!attacked && path.basename(file) === 'result.json' && path.dirname(file).includes('labwired-twin-')) {
          attacked = true;
          await rename(file, `${file}.descriptor-bound-original`);
          await writeFile(file, JSON.stringify({ ...passingResult(hash), replacementClaim: true }));
        }
      },
    },
  });
  const result = await adapters.twin['labwired-sim'].execute(p, { nativeArtifactSha256: hash, evidenceDir });
  assert.equal(result.level, 'failed');
  assert.notEqual(result.level, 'model_observed');
  assert.match(result.diagnostics, /replaced|changed/i);
  await assert.rejects(readFile(path.join(evidenceDir, 'twin', 'simulator-output.json')), /ENOENT/);
});

test('evidence persistence rejects alias, replacement, and overwrite paths', async (t) => {
  for (const scenario of ['symlink-root', 'replaced-root', 'preexisting-capture']) await t.test(scenario, async () => {
    const root = await sandbox();
    const p = profile(root);
    await writeFile(p.build.artifact, 'native');
    const hash = await sha256File(p.build.artifact);
    const bundle = await evidenceDirectory(root, p);
    let evidenceDir = bundle;
    if (scenario === 'symlink-root') {
      evidenceDir = path.join(root, 'evidence-alias');
      await symlink(bundle, evidenceDir, process.platform === 'win32' ? 'junction' : 'dir');
    }
    if (scenario === 'preexisting-capture') {
      await mkdir(path.join(bundle, 'twin'));
      await writeFile(path.join(bundle, 'twin', 'simulator-output.json'), 'sentinel');
    }
    let runs = 0;
    const { adapters } = harness(async (descriptor) => {
      runs += 1;
      await writeFile(path.join(descriptor.args[4], 'result.json'), JSON.stringify(passingResult(hash)));
      if (scenario === 'replaced-root') {
        const moved = `${bundle}.moved`;
        await rename(bundle, moved);
        await symlink(moved, bundle, process.platform === 'win32' ? 'junction' : 'dir');
      }
      return { classification: 'exit', exitCode: 0, stdout: '', stderr: '', truncated: { stdout: false, stderr: false } };
    });
    const result = await adapters.twin['labwired-sim'].execute(p, { nativeArtifactSha256: hash, evidenceDir });
    assert.equal(result.level, 'failed');
    assert.equal(runs, scenario === 'symlink-root' ? 0 : 1);
    if (scenario === 'preexisting-capture') {
      assert.equal(await readFile(path.join(bundle, 'twin', 'simulator-output.json'), 'utf8'), 'sentinel');
    }
  });
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
    const result = await adapters.twin['labwired-sim'].execute(p, {
      nativeArtifactSha256: hash,
      evidenceDir: await evidenceDirectory(root, p),
    });
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
    const result = await adapters.twin['labwired-sim'].execute(p, {
      nativeArtifactSha256: hash,
      evidenceDir: await evidenceDirectory(root, p),
    });
    assert.equal(result.level, 'failed');
  });
});

test('fd snapshot rejects pathname replacement during firmware read and cannot produce model evidence', async () => {
  const root = await sandbox();
  const p = profile(root);
  await writeFile(p.build.artifact, 'n'.repeat(100_000));
  const hash = await sha256File(p.build.artifact);
  let attacked = false;
  let runs = 0;
  const { adapters } = harness(async () => {
    runs += 1;
    return { classification: 'exit', exitCode: 0, stdout: '', stderr: '', truncated: { stdout: false, stderr: false } };
  }, {
    snapshotHooks: {
      async duringRead({ file }) {
        if (!attacked && file === p.build.artifact) {
          attacked = true;
          await rename(file, `${file}.raced`);
          await writeFile(file, 'replacement');
        }
      },
    },
  });
  const result = await adapters.twin['labwired-sim'].execute(p, {
    nativeArtifactSha256: hash,
    evidenceDir: await evidenceDirectory(root, p),
  });
  assert.equal(result.level, 'failed');
  assert.notEqual(result.level, 'model_observed');
  assert.equal(runs, 0);
  assert.match(result.diagnostics, /replaced|changed/i);
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
    const result = await adapters.twin['labwired-sim'].execute(p, {
      nativeArtifactSha256: hash,
      evidenceDir: await evidenceDirectory(root, p),
    });
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
      evidenceDir: await evidenceDirectory(root, p),
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
    await writeFile(path.join(descriptor.args[4], 'result.json'), JSON.stringify({
      ...passingResult(surrogateHash),
      diagnostics: { credential: 'top-secret' },
    }));
    return { classification: 'exit', exitCode: 0, stdout: '', stderr: '', truncated: { stdout: false, stderr: false } };
  });
  const bundleRoot = path.join(root, 'evidence');
  const evidence = await createEvidenceBundle(bundleRoot, p);
  const adapterResult = await adapters.twin['labwired-sim'].execute(p, {
    nativeArtifactSha256: nativeHash,
    twinArtifact: surrogate,
    sharedSourcePaths: ['src/main.cpp'],
    evidenceDir: bundleRoot,
    redact: ['top-secret'],
  });
  assert.deepEqual(Object.keys(adapterResult).sort(), [
    'artifactSha256', 'level', 'provider', 'rawEvidenceRefs', 'sharedSourcePaths', 'surrogateArtifactSha256', 'toolVersion',
  ]);
  assert.deepEqual(adapterResult.rawEvidenceRefs, ['twin/simulator-output.json']);
  const capturePath = path.join(bundleRoot, adapterResult.rawEvidenceRefs[0]);
  const captured = JSON.parse(await readFile(capturePath, 'utf8'));
  assert.equal(captured.firmware_hash, surrogateHash);
  assert.deepEqual(captured.assertions, [{ assertion: { uart_contains: 'ALIVE' }, passed: true }]);
  assert.equal(captured.diagnostics.credential, '[REDACTED]');
  const startedAt = new Date().toISOString();
  const record = await evidence.recordBehavior('alive', {
    ...adapterResult,
    behaviorId: 'alive',
    provider: p.observations[0].provider,
    targetIdentity: { ...p.target },
    startedAt,
    endedAt: new Date().toISOString(),
    diagnostics: { simulator: 'passed exact requested assertion against surrogate' },
  });
  assert.equal(record.level, 'surrogate_model_observed');
  assert.equal(levelSatisfies(record.level, 'model_observed'), false);
  const summary = await evidence.finalize();
  assert.equal(summary.result, 'FAIL');
  assert.equal(summary.reasons[0].actualLevel, 'surrogate_model_observed');
  assert.equal(summary.reasons[0].requiredLevel, 'model_observed');
  await chmod(capturePath, 0o600);
  await writeFile(capturePath, '{"tampered":true}\n');
  const verified = await verifyEvidenceBundle(bundleRoot, {
    expectedManifestSha256: summary.manifestSha256,
  });
  assert.equal(verified.valid, false);
});
