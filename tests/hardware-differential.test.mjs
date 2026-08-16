import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { diffTwinDesk, exitCodeForVerdict, loadEvidenceSide, runDifferential } from '../lib/hardware/differential.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'fixtures/twin-desk-diff');
const RUNNER = path.join(ROOT, 'scripts/hardware-runner.mjs');
const ARTIFACT_A = path.join(FIXTURES, 'firmware-a.bin');
const ARTIFACT_B = path.join(FIXTURES, 'firmware-b.bin');

async function receipt(name) {
  const data = JSON.parse(await readFile(path.join(FIXTURES, `${name}.receipt.json`), 'utf8'));
  return data.manifestSha256;
}

function bundle(name) {
  return path.join(FIXTURES, name);
}

async function diff(twinName, deskName, { artifact = ARTIFACT_A } = {}) {
  return runDifferential({
    artifactPath: artifact,
    twin: twinName ? { evidenceDir: bundle(twinName), receipt: await receipt(twinName) } : {},
    desk: deskName ? { evidenceDir: bundle(deskName), receipt: await receipt(deskName) } : {},
  });
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('recorded twin and desk bundles that both observed the firmware agree', async () => {
  const result = await diff('agree/twin', 'agree/desk');
  assert.equal(result.verdict, 'agree');
  assert.equal(result.exitCode, 0);
  assert.equal(result.comparison.comparablePairs, 2);
  assert.equal(result.comparison.disagreed, 0);
  assert.equal(result.disagreements.length, 0);
});

test('each side keeps its own evidence grade and neither is upgraded from the other', async () => {
  const result = await diff('agree/twin', 'agree/desk');
  assert.equal(result.twin.claim, 'model_verified');
  assert.equal(result.twin.grade, 'model_observed');
  assert.equal(result.desk.claim, 'hardware_observed');
  assert.equal(result.desk.grade, 'hardware_observed');
  assert.equal(result.artifact.sha256, result.twin.behaviors.length ? result.artifact.sha256 : null);
  for (const item of result.twin.behaviors) assert.notEqual(item.level, 'hardware_observed');
  for (const item of result.desk.behaviors) assert.equal(item.level, 'hardware_observed');
});

test('a twin green and a desk red on the same behavior is published as a disagreement', async () => {
  const result = await diff('agree/twin', 'disagree/desk');
  assert.equal(result.verdict, 'disagree');
  assert.equal(result.exitCode, 3);
  assert.deepEqual(result.disagreements.map((item) => item.behaviorId), ['led-blink']);
  const led = result.disagreements[0];
  assert.equal(led.twin.outcome, 'pass');
  assert.equal(led.desk.outcome, 'fail');
  // The twin still publishes its own honest claim; the desk still publishes its own.
  assert.equal(result.twin.claim, 'model_verified');
  assert.equal(result.desk.claim, null);
  assert.equal(result.desk.result, 'FAIL');
});

test('no desk bundle at all degrades to desk-unavailable, never to a pass', async () => {
  const result = await diff('agree/twin', null);
  assert.equal(result.verdict, 'desk-unavailable');
  assert.equal(result.exitCode, 4);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.desk.available, false);
  assert.equal(result.desk.claim, null);
  assert.ok(result.reasons.some((item) => item.code === 'evidence_absent'));
});

test('a desk bundle with no probe records no physical evidence and stays desk-unavailable', async () => {
  const result = await diff('agree/twin', 'no-probe/desk');
  assert.equal(result.verdict, 'desk-unavailable');
  assert.equal(result.exitCode, 4);
  assert.equal(result.desk.result, 'INCONCLUSIVE');
  assert.equal(result.desk.claim, null);
  assert.ok(result.reasons.some((item) => item.code === 'desk_inconclusive'));
});

test('a twin bundle that claims hardware evidence is rejected, not accepted as desk green', async () => {
  const result = await diff('contaminated/twin', 'agree/desk');
  assert.equal(result.verdict, 'invalid');
  assert.equal(result.exitCode, 2);
  assert.ok(result.reasons.some((item) => item.code === 'level_partition_violated'));
  assert.equal(result.twin.claim, null);
});

test('a desk bundle bound to different firmware is invalid, never agreement', async () => {
  const result = await diff('agree/twin', 'mismatch/desk');
  assert.equal(result.verdict, 'invalid');
  assert.equal(result.exitCode, 2);
  assert.ok(result.reasons.some((item) => item.code === 'artifact_mismatch'));
});

test('a bundle without its out-of-bundle receipt does not authenticate', async () => {
  const side = await loadEvidenceSide(bundle('agree/desk'), { side: 'desk' });
  assert.equal(side.available, false);
  assert.ok(side.reasons.some((item) => item.code === 'receipt_required' || item.code === 'evidence_unverified'));
  const result = await runDifferential({
    artifactPath: ARTIFACT_A,
    twin: { evidenceDir: bundle('agree/twin'), receipt: await receipt('agree/twin') },
    desk: { evidenceDir: bundle('agree/desk') },
  });
  assert.equal(result.verdict, 'desk-unavailable');
  assert.equal(result.exitCode, 4);
});

test('a tampered receipt does not authenticate the bundle', async () => {
  const wrong = 'f'.repeat(64);
  const result = await runDifferential({
    artifactPath: ARTIFACT_A,
    twin: { evidenceDir: bundle('agree/twin'), receipt: await receipt('agree/twin') },
    desk: { evidenceDir: bundle('agree/desk'), receipt: wrong },
  });
  assert.equal(result.verdict, 'desk-unavailable');
  assert.ok(result.desk.reasons.some((item) => item.code === 'receipt_mismatch'));
});

test('the whole diff refuses the wrong artifact instead of comparing anyway', async () => {
  const result = await diff('agree/twin', 'agree/desk', { artifact: ARTIFACT_B });
  assert.equal(result.verdict, 'invalid');
  assert.ok(result.reasons.every((item) => item.code !== 'behavior_disagreement'));
});

test('agreement requires at least one behavior both sides decided', () => {
  const empty = { side: 'twin', available: true, authenticity: 'verified', records: [] };
  const desk = { side: 'desk', available: true, authenticity: 'verified', records: [] };
  const result = diffTwinDesk({ artifactSha256: 'a'.repeat(64), twin: empty, desk });
  assert.notEqual(result.verdict, 'agree');
  assert.equal(result.verdict, 'twin-unavailable');
  assert.equal(result.exitCode, 5);
});

test('exit codes are distinct and only agreement is zero', () => {
  const codes = ['agree', 'disagree', 'desk-unavailable', 'twin-unavailable', 'invalid'].map(exitCodeForVerdict);
  assert.equal(new Set(codes).size, codes.length);
  assert.equal(exitCodeForVerdict('agree'), 0);
  for (const verdict of ['disagree', 'desk-unavailable', 'twin-unavailable', 'invalid']) {
    assert.notEqual(exitCodeForVerdict(verdict), 0);
  }
});

test('CLI exits 0 on agreement and writes the structured diff', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'labwired-diff-'));
  try {
    const out = path.join(scratch, 'diff.json');
    const result = await runCli([
      'diff', '--artifact', ARTIFACT_A,
      '--twin-evidence', bundle('agree/twin'), '--twin-receipt', await receipt('agree/twin'),
      '--desk-evidence', bundle('agree/desk'), '--desk-receipt', await receipt('agree/desk'),
      '--out', out,
    ]);
    assert.equal(result.code, 0);
    const written = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(written.command, 'hardware diff');
    assert.equal(written.verdict, 'agree');
    assert.equal(written.artifact.sha256.length, 64);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('CLI exits 3 on a published disagreement', async () => {
  const result = await runCli([
    'diff', '--artifact', ARTIFACT_A,
    '--twin-evidence', bundle('agree/twin'), '--twin-receipt', await receipt('agree/twin'),
    '--desk-evidence', bundle('disagree/desk'), '--desk-receipt', await receipt('disagree/desk'),
  ]);
  assert.equal(result.code, 3);
  assert.equal(JSON.parse(result.stdout).verdict, 'disagree');
});

test('CLI exits 4 when no board is attached', async () => {
  const result = await runCli([
    'diff', '--artifact', ARTIFACT_A,
    '--twin-evidence', bundle('agree/twin'), '--twin-receipt', await receipt('agree/twin'),
  ]);
  assert.equal(result.code, 4);
  assert.equal(JSON.parse(result.stdout).verdict, 'desk-unavailable');
});

test('CLI refuses a desk bundle supplied without its receipt', async () => {
  const result = await runCli([
    'diff', '--artifact', ARTIFACT_A,
    '--twin-evidence', bundle('agree/twin'), '--twin-receipt', await receipt('agree/twin'),
    '--desk-evidence', bundle('agree/desk'),
  ]);
  assert.equal(result.code, 2);
  assert.equal(JSON.parse(result.stdout).verdict, 'invalid');
});

test('CLI exits 2, never 3, when the artifact is missing', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'labwired-diff-'));
  try {
    const result = await runCli([
      'diff', '--artifact', path.join(scratch, 'absent.bin'),
      '--twin-evidence', bundle('agree/twin'), '--twin-receipt', await receipt('agree/twin'),
    ]);
    assert.equal(result.code, 2);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('an edited desk record breaks bundle authentication instead of changing the verdict', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'labwired-diff-'));
  try {
    const copy = path.join(scratch, 'desk');
    await import('node:fs/promises').then(({ cp }) => cp(bundle('disagree/desk'), copy, { recursive: true }));
    const recordPath = path.join(copy, 'observations/led-blink/result.json');
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    record.diagnostics = { detail: 'hand edited' };
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    const result = await runDifferential({
      artifactPath: ARTIFACT_A,
      twin: { evidenceDir: bundle('agree/twin'), receipt: await receipt('agree/twin') },
      desk: { evidenceDir: copy, receipt: await receipt('disagree/desk') },
    });
    assert.equal(result.verdict, 'desk-unavailable');
    assert.equal(result.desk.available, false);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
