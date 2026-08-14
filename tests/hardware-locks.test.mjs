import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { acquireHardwareLocks } from '../lib/hardware/locks.mjs';

const identities = { target: 'esp32-c3 bench A', probe: 'J-Link/1234', serial: '/dev/cu.usbmodem 1' };

async function temporaryRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'labwired-locks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('locks explicit identities in deterministic order without exposing them in paths or records', async (t) => {
  const root = await temporaryRoot(t);
  const handle = await acquireHardwareLocks(identities, { root });
  t.after(() => handle.release());

  assert.deepEqual(handle.records.map(({ type }) => type), ['probe', 'serial', 'target']);
  assert.equal(handle.records.length, 3);
  for (const record of handle.records) {
    assert.equal(record.schema, 'labwired.hardware-lock');
    assert.equal(record.version, 1);
    assert.equal(record.pid, process.pid);
    assert.match(record.processStart, /^.+$/);
    assert.match(record.createdAt, /^\d{4}-/);
    assert.match(record.identityHash, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(record).includes(identities[record.type]), false);
  }
  const names = await readdir(root);
  assert.equal(names.length, 3);
  assert.ok(names.every((name) => /^[a-z]+-[a-f0-9]{64}\.lock$/.test(name)));
  assert.ok(names.every((name) => !Object.values(identities).some((value) => name.includes(value))));
});

test('same-process competing handle refuses an already held identity', async (t) => {
  const root = await temporaryRoot(t);
  const first = await acquireHardwareLocks({ target: 'board-a' }, { root });
  t.after(() => first.release());
  await assert.rejects(acquireHardwareLocks({ target: 'board-a' }, { root }), /live hardware lock/i);
});

test('child-process live lock is not stolen', async (t) => {
  const root = await temporaryRoot(t);
  const moduleUrl = new URL('../lib/hardware/locks.mjs', import.meta.url).href;
  const script = `import { acquireHardwareLocks } from ${JSON.stringify(moduleUrl)};
    const h = await acquireHardwareLocks({target:'child-board'}, {root:process.argv[1]});
    process.stdout.write('LOCKED\\n');
    process.on('SIGTERM', async () => { await h.release(); process.exit(0); });
    setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, root], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`child exited ${code}`)));
    child.stdout.once('data', (chunk) => chunk.toString().includes('LOCKED') ? resolve() : reject(new Error('missing lock signal')));
  });
  await assert.rejects(acquireHardwareLocks({ target: 'child-board' }, { root }), /live hardware lock/i);
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
});

test('recovers a lock only when its recorded process is reliably absent', async (t) => {
  const root = await temporaryRoot(t);
  const handle = await acquireHardwareLocks({ target: 'stale-board' }, { root });
  const [name] = await readdir(root);
  const record = JSON.parse(await readFile(path.join(root, name), 'utf8'));
  await handle.release();
  record.pid = 2147483647;
  record.processStart = 'definitely-absent';
  await writeFile(path.join(root, name), `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });

  const recovered = await acquireHardwareLocks({ target: 'stale-board' }, { root });
  t.after(() => recovered.release());
  assert.equal(recovered.records.length, 1);
});

test('recovers PID-reuse lock when process start identity mismatches', async (t) => {
  const root = await temporaryRoot(t);
  const handle = await acquireHardwareLocks({ target: 'reused-pid' }, { root });
  const [name] = await readdir(root);
  const record = JSON.parse(await readFile(path.join(root, name), 'utf8'));
  await handle.release();
  record.processStart = `${record.processStart}-different`;
  await writeFile(path.join(root, name), `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
  const recovered = await acquireHardwareLocks({ target: 'reused-pid' }, { root });
  t.after(() => recovered.release());
  assert.notEqual(recovered.records[0].token, record.token);
});

test('rolls back earlier acquisitions if a later identity is locked', async (t) => {
  const root = await temporaryRoot(t);
  const blocker = await acquireHardwareLocks({ target: 'taken' }, { root });
  t.after(() => blocker.release());
  await assert.rejects(acquireHardwareLocks({ probe: 'free', target: 'taken' }, { root }), /live hardware lock/i);
  const probeOnly = await acquireHardwareLocks({ probe: 'free' }, { root });
  await probeOnly.release();
});

test('an already-aborted signal acquires nothing', async (t) => {
  const root = await temporaryRoot(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(acquireHardwareLocks({ target: 'board' }, { root, signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(await readdir(root), []);
});

test('abort releases acquired locks and release remains idempotent', async (t) => {
  const root = await temporaryRoot(t);
  const controller = new AbortController();
  const handle = await acquireHardwareLocks({ target: 'board' }, { root, signal: controller.signal });
  controller.abort();
  await handle.release();
  assert.deepEqual(await readdir(root), []);
  await handle.release();
  await handle.release();
});

test('release refuses to remove a replaced lock', async (t) => {
  const root = await temporaryRoot(t);
  const handle = await acquireHardwareLocks({ target: 'board' }, { root });
  const [name] = await readdir(root);
  const lockPath = path.join(root, name);
  await rm(lockPath);
  await writeFile(lockPath, '{}\n', { flag: 'wx' });
  await assert.rejects(handle.release(), /ownership|replace|malformed/i);
  assert.equal((await readdir(root)).length, 1);
});

test('corrupt and symlink lock entries fail closed', async (t) => {
  const root = await temporaryRoot(t);
  const initial = await acquireHardwareLocks({ target: 'board' }, { root });
  const [name] = await readdir(root);
  await initial.release();
  await writeFile(path.join(root, name), '{bad json', { flag: 'wx' });
  await assert.rejects(acquireHardwareLocks({ target: 'board' }, { root }), /malformed|corrupt/i);

  await rm(path.join(root, name));
  const outside = path.join(await temporaryRoot(t), 'outside');
  await writeFile(outside, 'untouched');
  await symlink(outside, path.join(root, name));
  await assert.rejects(acquireHardwareLocks({ target: 'board' }, { root }), /symbolic|symlink|unsafe/i);
  assert.equal(await readFile(outside, 'utf8'), 'untouched');
});

test('rejects missing, ambiguous, or unsafe identity and root inputs', async (t) => {
  const root = await temporaryRoot(t);
  await assert.rejects(acquireHardwareLocks({}, { root }), /identity/i);
  await assert.rejects(acquireHardwareLocks({ target: '   ' }, { root }), /identity/i);
  await assert.rejects(acquireHardwareLocks({ target: 'board' }, { root: `${root}/..` }), /root/i);
});
