#!/usr/bin/env node
// rpc-contract-check.mjs — fail if the extension calls/subscribes RPC methods
// the server does not implement. Zero-dep; regex-based by convention.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const extRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const agentRoot = join(extRoot, '..', '..');
const serverFile = join(agentRoot, 'server', 'rpc-server.mjs');

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (e === 'node_modules' || e === 'out' || e.startsWith('.')) continue;
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith('.ts')) yield p;
  }
}

// --- server surface ---
const serverSrc = readFileSync(serverFile, 'utf8');
const serverMethods = new Set();
for (const m of serverSrc.matchAll(/case ['"]([a-z]+\/[a-zA-Z]+)['"]:/g)) serverMethods.add(m[1]);
for (const m of serverSrc.matchAll(/case ['"](initialize|ping)['"]:/g)) serverMethods.add(m[1]);
const serverNotifications = new Set();
for (const m of serverSrc.matchAll(/notify\(['"]([a-z]+\/[a-zA-Z]+)['"]/g)) serverNotifications.add(m[1]);

// --- client surface ---
const clientCalls = new Map();   // method -> file
const clientSubs = new Map();    // notification -> file
for (const f of walk(join(extRoot, 'src'))) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\.request\(\s*['"]([a-z]+\/[a-zA-Z]+)['"]/g))
    clientCalls.set(m[1], f);
  for (const m of src.matchAll(/tryRpc\(\s*[\w.]+\s*,\s*['"]([a-z]+\/[a-zA-Z]+)['"]/g))
    clientCalls.set(m[1], f);
  for (const m of src.matchAll(/onNotification\(\s*[\w.]+\s*,\s*['"]([a-z]+\/[a-zA-Z]+)['"]/g))
    clientSubs.set(m[1], f);
}

// --- baseline (known drift, deleted as tasks fix it) ---
const baselineFile = join(extRoot, 'scripts', 'rpc-contract-baseline.txt');
const baseline = new Set(
  existsSync(baselineFile)
    ? readFileSync(baselineFile, 'utf8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'))
    : []
);

let fail = 0;
for (const [method, file] of clientCalls) {
  if (!serverMethods.has(method)) {
    if (baseline.has(`call ${method}`)) continue;
    console.error(`DRIFT call:  ${method}  (${file}) not in server dispatch`); fail++;
  } else if (baseline.has(`call ${method}`)) {
    console.error(`STALE baseline: call ${method} now exists on server — remove line`); fail++;
  }
}
for (const [method, file] of clientSubs) {
  if (!serverNotifications.has(method)) {
    if (baseline.has(`sub ${method}`)) continue;
    console.error(`DRIFT sub:   ${method}  (${file}) never emitted by server`); fail++;
  } else if (baseline.has(`sub ${method}`)) {
    console.error(`STALE baseline: sub ${method} now emitted by server — remove line`); fail++;
  }
}
for (const b of baseline) {
  const [kind, method] = b.split(' ');
  const seen = kind === 'call' ? clientCalls.has(method) : clientSubs.has(method);
  if (!seen) { console.error(`STALE baseline: ${b} no longer in client — remove line`); fail++; }
}

if (fail) { console.error(`\nrpc-contract-check: ${fail} violation(s)`); process.exit(1); }
console.log(`rpc-contract-check: OK (${clientCalls.size} calls, ${clientSubs.size} subs, baseline ${baseline.size})`);
