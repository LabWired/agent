# Extension Thin-Client (Part 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Cursor/VS Code extension (`extensions/labwired-vscode`) a true thin client over the agent's `server/rpc-server.mjs` — one JSON-RPC protocol for everything, with a contract test that makes client↔server drift impossible to reintroduce.

**Architecture:** The single existing `RpcClient` (`extensions/labwired-vscode/src/cli/rpcClient.ts`) owns the server child process and is the ONLY path to agent capabilities. `ToolRunner` routes tool execution through RPC `tool/run` (with an explicit CLI fallback when the server is down). All server notifications are parsed through one pure, unit-tested module (`src/rpc/messages.ts`). RPC calls to methods the server does not implement are removed or degrade honestly. A contract checker (`scripts/rpc-contract-check.mjs`) diffs client-called methods against the server dispatch table and gates CI. The server itself is **not modified** — protocol `0.5.0` is the QA'd stable surface (see `tests/gap-ready-qa.sh`).

**Tech Stack:** TypeScript (plain `tsc`, no bundler), Node ESM server (`server/rpc-server.mjs`), JSON-RPC 2.0 over stdio with LSP-style `Content-Length` framing, Mocha for unit tests.

**Repos/paths:** All work happens in `/Users/andrii/projects/labwired-agent`. Extension root: `extensions/labwired-vscode` (referred to below as `ext/`).

---

## Background: the drift this plan eliminates

Verified client↔server mismatches as of 2026-08-12 (server dispatch: `server/rpc-server.mjs:336-371`):

| Problem | Where |
|---|---|
| Client calls nonexistent methods: `trace/sessionStart`, `trace/sessionStop`, `instrument/list`, `instrument/open`, `instrument/scpi`, `instrument/capture`, `twin/run`, `twin/evidence`, `plot/start`, `serial/getState`, `auth/logout`, `auth/loginWithToken`, `auth/startDeviceCode`, `auth/completeDeviceCode`, `auth/status`, `entitlement/status`, `project/list`, `project/create`, `project/select` | `ext/src/extension.ts:497-610`, `ext/src/providers/evidenceProvider.ts:36-201`, `ext/src/providers/serialProvider.ts`, `ext/src/pro/billing.ts:108-296` |
| Notification payload mismatches: server sends `chat/textDelta {text}` (client reads `params.delta`), `chat/toolCall {name,title,params}` (client reads `toolName`/`args`), `chat/toolResult {name,code,detail}` (client reads `result.summary`), `serial/connectionState {open}` (client reads `connected`); server emits `plot/update` (client listens for `plot/data`); client listens for `serial/portsChanged` (server never emits) | `ext/src/providers/chatProvider.ts:49-65`, `ext/src/providers/serialProvider.ts:58`, `ext/src/extension.ts:65-75` |
| Tools executed by spawning the CLI per call (`ToolRunner` → `bridge.run(argv)`), bypassing the server's plan/verify-mode gates and confirm gates | `ext/src/tools/runner.ts:197`, `ext/src/cli/bridge.ts:139` |
| `rpc-server.mjs` is NOT bundled into the VSIX — packaged installs depend on a separately installed `labwired` CLI | `ext/package.json:382`, `.vscodeignore` |
| `npm run compile` is broken: `ext/src/board/multiImport.ts` imports 5 modules that exist only in stale `out/` (13 errors, verified) | `ext/src/board/multiImport.ts` |
| Server tools never used by the client: `tool/list`, `tool/run`, `chat/stop`, `serial/listPorts`, `mode/get`, `ping` | — |

**Scope boundary (do NOT expand):** the server gains no new methods in this plan. RTT (`trace/*`), SCPI instruments (`instrument/*`), and cloud `auth/*`/`project/*` remain server-side future work; the client must degrade honestly when they are absent. The standalone `~/projects/labwired-vscode` repo (publisher `w1ne`, DAP-based, v0.13.0) is a different product and is out of scope.

---

## File Structure

| File | Responsibility |
|---|---|
| `ext/src/rpc/messages.ts` (new) | Pure payload parsers for every server notification + `onNotification` typed subscription helper + `tryRpc` graceful-degradation wrapper. No `vscode` import — unit-testable. |
| `ext/src/test/unit/messages.test.ts` (new) | Mocha unit tests for the parsers (server-shape fixtures). |
| `ext/src/test/unit/toolRunnerRpc.test.ts` (new) | Mocha unit tests for ToolRunner RPC routing with a fake RpcClient. |
| `ext/scripts/rpc-contract-check.mjs` (new) | Contract checker: client-called methods ⊆ server dispatch; client notification subs ⊆ server `notify()` emissions. |
| `ext/scripts/rpc-contract-baseline.txt` (new, deleted in Task 5) | Known-drift allowlist, shrunk per task. |
| `ext/scripts/sync-server.mjs` (new) | Copies `server/rpc-server.mjs` + `VERSION` into `ext/server/` before packaging. |
| `ext/src/tools/runner.ts` (modify) | Route tool execution through RPC `tool/run` when the server is running and exposes the tool; CLI fallback otherwise. |
| `ext/src/providers/chatProvider.ts` (modify) | Use `messages.ts` parsers; wire Stop button to RPC `chat/stop`. |
| `ext/src/providers/serialProvider.ts` (modify) | `serial/status` (not `getState`), `connectionState.open`, drop `plot/start` + `serial/portsChanged`. |
| `ext/src/extension.ts` (modify) | `plot/update` listener via `onNotification`; delete RTT/instrument dead-RPC commands. |
| `ext/src/providers/evidenceProvider.ts` (modify) | Wrap `twin/*` RPC in `tryRpc` → CLI fallback. |
| `ext/src/pro/billing.ts` (modify) | Wrap cloud RPC calls in `tryRpc` → honest signed-out state. |
| `ext/src/board/multiImport.ts` (delete) | Dead code breaking `tsc`. |
| `ext/package.json` (modify) | `test:unit` + `contract` scripts, mocha devDeps, `vscode:prepublish` sync hook. |
| `tests/rpc-contract.sh` (new, agent repo) | Repo-level test entry that runs the contract checker. |

---

### Task 1: Unbreak the build

`npm run compile` currently fails with 13 errors from dead code. Nothing else in this plan can be verified until this is fixed.

**Files:**
- Delete: `ext/src/board/multiImport.ts`

- [ ] **Step 1: Verify the file is dead**

Run:
```bash
cd /Users/andrii/projects/labwired-agent/extensions/labwired-vscode
grep -rn "multiImport" src/ --include="*.ts" | grep -v "src/board/multiImport.ts"
```
Expected: no output (no importer in `src/`).

- [ ] **Step 2: Confirm current breakage**

Run: `npx tsc -p . --noEmit`
Expected: 13 errors, all rooted in `src/board/multiImport.ts` missing `./pdfImport`, `./catalogBoards`, `./netlistGraph`, `./bomMapper`, `./graphToDiagram`.

- [ ] **Step 3: Delete the dead file**

```bash
rm src/board/multiImport.ts
```

- [ ] **Step 4: Verify compile is clean**

Run: `npx tsc -p . --noEmit`
Expected: exit 0, no output. If other pre-existing errors surface, fix only what blocks compilation — no drive-by refactors.

- [ ] **Step 5: Commit**

```bash
cd /Users/andrii/projects/labwired-agent
git add extensions/labwired-vscode/src/board/multiImport.ts
git commit -m "fix(ext): delete dead multiImport.ts breaking tsc (imports only exist in stale out/)"
```

---

### Task 2: Contract checker (the guardrail, written red)

A script that extracts every RPC method the client calls and every notification it subscribes to, and fails if either is not in the server's dispatch/notify set. Written FIRST, currently red — Tasks 3–5 turn it green.

**Files:**
- Create: `ext/scripts/rpc-contract-check.mjs`
- Create: `ext/scripts/rpc-contract-baseline.txt`

Conventions this script enforces (Tasks 3–5 make the client conform):
- Client requests are always `rpc.request('<method>', ...)` — literal first arg — and are hard-gated against the server dispatch table.
- Client notification subscriptions are always `onNotification(rpc, '<method>', handler)` — literal second arg — and are hard-gated against server `notify()` emissions.
- `tryRpc(rpc, '<method>', ...)` is the documented escape hatch for **optional** capabilities (it resolves `null` when the server lacks the method) and is deliberately **exempt** from the gate.
- Server methods are `case '<method>':` in the dispatch switch of `server/rpc-server.mjs`; server notifications are `notify('<method>', ...)`.

- [ ] **Step 1: Write the contract checker**

Create `ext/scripts/rpc-contract-check.mjs`:

```javascript
#!/usr/bin/env node
// rpc-contract-check.mjs — fail if the extension calls/subscribes RPC methods
// the server does not implement. Zero-dep; regex-based by convention.
// Conventions enforced (literal string args only — template literals / computed
// names evade this check):
//   hard-gated:  rpc.request('x/y', ...)          client -> server request
//                onNotification(rpc, 'x/y', ...)   client subscription
//   exempt:       tryRpc(rpc, 'x/y', ...)          optional capability; tolerates absence
// Server surface: case "x/y": in the dispatch switch, notify("x/y", ...) emissions.
// Note: clientCalls/clientSubs are keyed by method; DRIFT messages report one file per method.
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
for (const m of serverSrc.matchAll(/case ['"]([\w]+\/[\w]+)['"]:/g)) serverMethods.add(m[1]);
for (const m of serverSrc.matchAll(/case ['"](initialize|ping)['"]:/g)) serverMethods.add(m[1]);
const serverNotifications = new Set();
for (const m of serverSrc.matchAll(/notify\(['"]([\w]+\/[\w]+)['"]/g)) serverNotifications.add(m[1]);

// --- client surface ---
const clientCalls = new Map();   // method -> file
const clientSubs = new Map();    // notification -> file
for (const f of walk(join(extRoot, 'src'))) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\.request\(\s*['"]([\w]+\/[\w]+)['"]/g))
    clientCalls.set(m[1], f);
  for (const m of src.matchAll(/onNotification\(\s*[\w.]+\s*,\s*['"]([\w]+\/[\w]+)['"]/g))
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
```

- [ ] **Step 2: Write the baseline of known drift**

Create `ext/scripts/rpc-contract-baseline.txt`:

```text
# Known client->server drift as of 2026-08-12. Delete lines as tasks fix them.
# This file is deleted in Task 5 when it reaches empty.
call trace/sessionStart
call trace/sessionStop
call instrument/list
call instrument/open
call instrument/scpi
call instrument/capture
call twin/run
call twin/evidence
call plot/start
call serial/getState
call auth/logout
call auth/loginWithToken
call auth/startDeviceCode
call auth/completeDeviceCode
call auth/status
call entitlement/status
call project/list
call project/create
call project/select
```

Note: `onNotification` subs don't exist yet (Task 3 introduces them), so there are no `sub` baseline lines — current bad subs are raw `rpc.on('notification')` switches the checker deliberately does NOT grandfather; Task 3 rewrites them.

- [ ] **Step 3: Run it — verify it passes WITH baseline and catches drift without**

Run:
```bash
cd /Users/andrii/projects/labwired-agent/extensions/labwired-vscode
node scripts/rpc-contract-check.mjs
```
Expected: `rpc-contract-check: OK (... baseline 19)` exit 0.

Then verify it actually fails on unlisted drift:
```bash
printf 'call fake/method\n' >> scripts/rpc-contract-baseline.txt && node scripts/rpc-contract-check.mjs; echo "exit=$?"
```
Expected: `STALE baseline: call fake/method no longer in client — remove line`, `exit=1`. Restore the file:
```bash
git checkout scripts/rpc-contract-baseline.txt 2>/dev/null || sed -i '' '/fake\/method/d' scripts/rpc-contract-baseline.txt
```

- [ ] **Step 4: Commit**

```bash
cd /Users/andrii/projects/labwired-agent
git add extensions/labwired-vscode/scripts/rpc-contract-check.mjs extensions/labwired-vscode/scripts/rpc-contract-baseline.txt
git commit -m "test(ext): RPC contract checker with known-drift baseline (19 entries)"
```

---

### Task 3: Notification contract — pure parsers + rewrite all subscriptions

Every server notification gets a parser in a pure module; every client subscription goes through `onNotification`. Unit tests pin the server's actual payload shapes (fixtures copied from `server/rpc-server.mjs` `notify()` call sites).

**Files:**
- Create: `ext/src/rpc/messages.ts`
- Create: `ext/src/test/unit/messages.test.ts`
- Modify: `ext/src/providers/chatProvider.ts:44-75` (notification subscription)
- Modify: `ext/src/providers/chatProvider.ts:155-159` (Stop button)
- Modify: `ext/src/providers/serialProvider.ts:52-70,222,255,280` (subscriptions, `serial/getState`, `plot/start`)
- Modify: `ext/src/extension.ts:65-75` (`plot/data` listener), `:476-620` (trace/instrument handlers — see Task 5)

- [ ] **Step 1: Write the failing unit tests**

Create `ext/src/test/unit/messages.test.ts` (TDD ui, plain `assert`, no `vscode` import):

```typescript
import * as assert from 'assert';
import {
  parseChatTextDelta, parseChatToolCall, parseChatToolResult,
  parseSerialConnectionState, parseSerialData, parsePlotUpdate,
  parseGdbState, onNotification, tryRpc,
} from '../../rpc/messages';

// Fixtures mirror notify() payloads in server/rpc-server.mjs exactly.
suite('rpc messages (server payload shapes)', () => {
  test('chat/textDelta uses {text}', () => {
    assert.strictEqual(parseChatTextDelta({ text: 'hello' }), 'hello');
    assert.strictEqual(parseChatTextDelta({}), '');
  });
  test('chat/toolCall uses {name,title,params}', () => {
    assert.deepStrictEqual(
      parseChatToolCall({ name: 'doctor', title: 'Doctor', params: { verbose: 1 } }),
      { name: 'doctor', title: 'Doctor', params: { verbose: 1 } });
  });
  test('chat/toolResult uses {name,code,detail}', () => {
    assert.deepStrictEqual(
      parseChatToolResult({ name: 'doctor', code: 0, detail: 'ok' }),
      { name: 'doctor', code: 0, detail: 'ok' });
  });
  test('serial/connectionState uses {open}', () => {
    assert.strictEqual(parseSerialConnectionState({ open: true, port: '/dev/cu.usb1' }), true);
    assert.strictEqual(parseSerialConnectionState({ open: false }), false);
  });
  test('serial/data uses {data,port}', () => {
    assert.strictEqual(parseSerialData({ data: 'temp=23.5\n', port: 'x' }), 'temp=23.5\n');
  });
  test('plot/update uses {series: Record<string, number[]>}', () => {
    assert.deepStrictEqual(parsePlotUpdate({ series: { temp: [1, 2] } }), { temp: [1, 2] });
    assert.deepStrictEqual(parsePlotUpdate({}), {});
  });
  test('debug/gdbState uses {running,chip,port}', () => {
    assert.deepStrictEqual(
      parseGdbState({ running: true, chip: 'esp32c3', port: 1337 }),
      { running: true, chip: 'esp32c3', port: 1337 });
  });
  test('onNotification routes only the named method', () => {
    const seen: string[] = [];
    const fake = { on(_ev: string, cb: (m: string, p: unknown) => void) {
      cb('plot/update', { series: {} }); cb('serial/data', { data: 'x' });
    } };
    onNotification(fake, 'serial/data', p => seen.push(parseSerialData(p)));
    assert.deepStrictEqual(seen, ['x']);
  });
  test('tryRpc resolves null on Method-not-found, rethrows transport errors', async () => {
    const methodNotFound = { request: () => Promise.reject(Object.assign(new Error('Method not found'), { code: -32601 })) };
    assert.strictEqual(await tryRpc(methodNotFound as any, 'twin/run', {}), null);
    const appError = { request: () => Promise.reject(Object.assign(new Error('mode gate'), { code: -32000 })) };
    await assert.rejects(() => tryRpc(appError as any, 'tool/run', {}), /mode gate/);
  });
});
```

Wire up the runner — edit `ext/package.json`:
- In `"scripts"` add: `"test:unit": "npm run compile && mocha out/test/unit/**/*.test.js",` and `"contract": "node scripts/rpc-contract-check.mjs",`
- In `"devDependencies"` add: `"mocha": "^10.7.3",` and `"@types/mocha": "^10.0.7",`

Run:
```bash
cd /Users/andrii/projects/labwired-agent/extensions/labwired-vscode
npm install && npm run test:unit
```
Expected: FAIL — `Cannot find module '../../rpc/messages'`.

- [ ] **Step 2: Implement `src/rpc/messages.ts`**

Create `ext/src/rpc/messages.ts`:

```typescript
// Pure parsers for labwired-agent RPC server notifications.
// Shapes pinned to server/rpc-server.mjs notify() call sites (protocol 0.5.0).
// NO vscode import — this module is unit-testable under plain mocha.

export interface NotificationSource {
  on(event: 'notification', cb: (method: string, params: unknown) => void): void;
}
export interface Requester {
  request(method: string, params?: unknown): Promise<unknown>;
}

/** Subscribe to one server notification with a typed handler. */
export function onNotification(
  rpc: NotificationSource, method: string, handler: (params: any) => void,
): void {
  rpc.on('notification', (m, params) => { if (m === method) handler(params); });
}

/** Call an optional server method; resolve null when the server lacks it.
 *  NOTE: tryRpc is exempt from scripts/rpc-contract-check.mjs by design — it is
 *  the escape hatch for optional capabilities that tolerate server absence. */
export async function tryRpc(rpc: Requester, method: string, params: unknown): Promise<any | null> {
  try {
    return await rpc.request(method, params);
  } catch (err: any) {
    if (err && (err.code === -32601 || /method not found/i.test(String(err.message)))) return null;
    throw err;
  }
}

export function parseChatTextDelta(p: any): string { return typeof p?.text === 'string' ? p.text : ''; }

export interface ChatToolCall { name: string; title: string; params: unknown; }
export function parseChatToolCall(p: any): ChatToolCall {
  return { name: String(p?.name ?? ''), title: String(p?.title ?? p?.name ?? ''), params: p?.params ?? {} };
}

export interface ChatToolResult { name: string; code: number; detail: string; }
export function parseChatToolResult(p: any): ChatToolResult {
  return { name: String(p?.name ?? ''), code: Number(p?.code ?? -1), detail: String(p?.detail ?? '') };
}

export function parseSerialConnectionState(p: any): boolean { return p?.open === true; }
export function parseSerialData(p: any): string { return typeof p?.data === 'string' ? p.data : ''; }
export function parsePlotUpdate(p: any): Record<string, number[]> {
  return (p && typeof p.series === 'object' && p.series) ? p.series : {};
}

export interface GdbState { running: boolean; chip: string; port: number; }
export function parseGdbState(p: any): GdbState {
  return { running: p?.running === true, chip: String(p?.chip ?? ''), port: Number(p?.port ?? 0) };
}
```

Run: `npm run test:unit`
Expected: PASS — 9 tests.

- [ ] **Step 3: Rewrite chatProvider subscriptions + Stop button**

In `ext/src/providers/chatProvider.ts`, replace the raw `rpc.on('notification', ...)` block (currently ~lines 44-75, reading `params.delta`, `params.toolName`, `params.args`, `params.result.summary`) with:

```typescript
import { onNotification, parseChatTextDelta, parseChatToolCall, parseChatToolResult } from '../rpc/messages';
// ...inside the RPC wiring section:
onNotification(this.rpc, 'chat/textDelta', p => this.appendText(parseChatTextDelta(p)));
onNotification(this.rpc, 'chat/toolCall', p => {
  const t = parseChatToolCall(p);
  this.postMessage({ type: 'toolCall', toolName: t.name, title: t.title, args: t.params });
});
onNotification(this.rpc, 'chat/toolResult', p => {
  const r = parseChatToolResult(p);
  this.postMessage({ type: 'toolResult', toolName: r.name, code: r.code, summary: r.detail });
});
onNotification(this.rpc, 'chat/done', p => this.finishTurn(p));
```

Keep the webview-facing message field names (`toolName`, `args`, `summary`) unchanged so the webview JS needs no edits — only the wire parsing changes. Adjust `appendText`/`postMessage`/`finishTurn` to the provider's actual existing method names (read the file; they exist today under the raw listener).

In the Stop-button handler (currently ~lines 155-159, kills only the local agent), add the RPC stop:

```typescript
if (this.rpc?.isRunning()) {
  this.rpc.request('chat/stop').catch(() => { /* server already gone */ });
}
```

- [ ] **Step 4: Rewrite serialProvider subscriptions and status call**

In `ext/src/providers/serialProvider.ts`:
- Replace the `serial/getState` request (~line 222) with `serial/status` and read `{port, baud, open, bytesIn, bytesOut}`.
- Delete the `plot/start` request (~line 255) — plot ingest is automatic server-side; use `plot_status`/`plot_clear` via `tool/run` if the view needs them.
- Replace the connection-state listener (~line 58, reading `params.connected`) with:

```typescript
import { onNotification, parseSerialConnectionState, parseSerialData } from '../rpc/messages';
onNotification(this.rpc, 'serial/connectionState', p => this.setConnected(parseSerialConnectionState(p)));
onNotification(this.rpc, 'serial/data', p => this.appendData(parseSerialData(p)));
```

- Delete any `serial/portsChanged` listener — the server never emits it; keep the existing manual Refresh.

(Again: adapt `setConnected`/`appendData` to the actual existing method names in the file.)

Then remove the two now-fixed lines from the drift baseline so the checker doesn't flag them as stale:

```bash
sed -i '' -e '/^call serial\/getState$/d' -e '/^call plot\/start$/d' scripts/rpc-contract-baseline.txt
```

- [ ] **Step 5: Fix the plot listener in extension.ts**

In `ext/src/extension.ts:65-75`, replace the `plot/data` listener with:

```typescript
import { onNotification, parsePlotUpdate } from './rpc/messages';
onNotification(this.rpc, 'plot/update', p => {
  this.plotProvider?.updateSeries(parsePlotUpdate(p));
});
```

If `plotProvider` has no `updateSeries(series: Record<string, number[]>)` method, add one that replaces the current series map and re-renders — it currently only parses serial text, so give it the direct-series path.

- [ ] **Step 6: Run tests + contract checker**

```bash
npm run test:unit && npm run contract
```
Expected: tests PASS; contract `OK` with baseline **17** (the `serial/getState` and `plot/start` lines were removed in Step 4; trace/instrument call sites remain until Task 5).

- [ ] **Step 7: Commit**

```bash
cd /Users/andrii/projects/labwired-agent
git add extensions/labwired-vscode/src extensions/labwired-vscode/package.json extensions/labwired-vscode/package-lock.json
git commit -m "fix(ext): align all RPC notification parsing with server protocol 0.5.0"
```

---

### Task 4: Route ToolRunner through RPC `tool/run`

Today every tool spawns the CLI per call (`bridge.run(argv)`), bypassing the server's plan/verify-mode gates and flash confirm gate. Route through the server when it's running and exposes the tool; fall back to CLI explicitly when not.

**Files:**
- Modify: `ext/src/tools/runner.ts` (constructor ~line 23, `runNamed` ~line 36, `exec` ~line 197)
- Modify: `ext/src/extension.ts` (ToolRunner construction site — pass the RpcClient)
- Create: `ext/src/test/unit/toolRunnerRpc.test.ts`

Server tool names (`server/rpc-server.mjs:135-257`) for reference: `doctor`, `doctor_strict`, `version`, `smoke`, `install_deps`, `help`, `probe_list`, `probe_doctor`, `probe_chips`, `probe_flash`, `serial_capture`, `score_verify`, `assert_status`, `debug_info`, `debug_gdb_start`, `debug_gdb_stop`, `debug_read`, `plot_status`, `plot_clear`, `hw_claim_shape`, `hw_promote`.

- [ ] **Step 1: Write the failing unit test**

Create `ext/src/test/unit/toolRunnerRpc.test.ts`:

```typescript
import * as assert from 'assert';
import { ToolRunner } from '../../tools/runner';

function fakeRpc(tools: string[], runResult?: any) {
  const calls: { name: string; params: unknown }[] = [];
  return {
    calls,
    isRunning: () => true,
    request: async (method: string, params: any) => {
      if (method === 'tool/list') return { tools: tools.map(name => ({ name })) };
      if (method === 'tool/run') { calls.push({ name: params.name, params: params.params }); return runResult ?? { name: params.name, code: 0, stdout: 'ok', stderr: '', timedOut: false }; }
      throw new Error(`unexpected ${method}`);
    },
  };
}

suite('ToolRunner RPC routing', () => {
  test('routes a server-known tool through tool/run', async () => {
    const rpc = fakeRpc(['doctor']);
    const bridge = { run: async () => { throw new Error('CLI must not be used'); } };
    const runner = new ToolRunner(bridge as any, {} as any, rpc as any);
    const res = await runner.runNamed('doctor', {});
    assert.strictEqual(res.code, 0);
    assert.deepStrictEqual(rpc.calls, [{ name: 'doctor', params: {} }]);
  });
  test('falls back to CLI for server-unknown tool', async () => {
    const rpc = fakeRpc(['doctor']);
    let cliArgv: string[] = [];
    const bridge = { run: async (argv: string[]) => { cliArgv = argv; return { code: 0, stdout: 'cli', stderr: '' }; } };
    const runner = new ToolRunner(bridge as any, {} as any, rpc as any);
    await runner.runNamed('update', {});
    assert.deepStrictEqual(cliArgv, ['update']);
  });
  test('falls back to CLI when server is down', async () => {
    const rpc = { ...fakeRpc(['doctor']), isRunning: () => false };
    let used = false;
    const bridge = { run: async () => { used = true; return { code: 0, stdout: 'cli', stderr: '' }; } };
    const runner = new ToolRunner(bridge as any, {} as any, rpc as any);
    await runner.runNamed('doctor', {});
    assert.strictEqual(used, true);
  });
  test('mode-gate error surfaces as message, not crash', async () => {
    const rpc = fakeRpc(['probe_flash']);
    rpc.request = async (m: string) => { if (m === 'tool/list') return { tools: [{ name: 'probe_flash' }] }; throw Object.assign(new Error('plan mode: destructive tool denied'), { code: -32000 }); };
    const runner = new ToolRunner({ run: async () => { throw new Error('no CLI'); } } as any, {} as any, rpc as any);
    const res = await runner.runNamed('probe_flash', { elf: 'a.elf' });
    assert.strictEqual(res.code, -32000);
    assert.match(res.stderr, /plan mode/);
  });
});
```

If the current `ToolRunner` constructor signature differs from `(bridge, services, rpc?)`, adapt the test to it after reading `src/tools/runner.ts` — the assertions are the contract, the wiring is flexible.

Run: `npm run test:unit` → Expected: FAIL (constructor takes 2 args / no RPC path).

- [ ] **Step 2: Implement RPC routing in runner.ts**

In `ext/src/tools/runner.ts`, add:

```typescript
import type { RpcClient } from '../cli/rpcClient';

// ...in class ToolRunner:
private serverTools: Set<string> | null = null;

constructor(
  private bridge: LabWiredBridge,
  private services: ToolServices,        // keep the existing second param as-is
  private rpc?: RpcClient,
) { super?.(); /* keep existing constructor body; only add rpc storage */ }

private async rpcSupports(tool: string): Promise<boolean> {
  if (!this.rpc || !this.rpc.isRunning()) return false;
  if (!this.serverTools) {
    try {
      const res = await this.rpc.request('tool/list') as { tools: { name: string }[] };
      this.serverTools = new Set(res.tools.map(t => t.name));
    } catch { return false; }
  }
  return this.serverTools.has(tool);
}
```

At the top of the existing `exec`-equivalent path in `runNamed` (after the catalog/datasheet/debug/billing pseudo-tool special-cases, before `bridge.run`), insert:

```typescript
if (await this.rpcSupports(name)) {
  try {
    const r = await this.rpc!.request('tool/run', { name, params }) as
      { name: string; code: number; stdout: string; stderr: string; timedOut: boolean; extra?: unknown };
    return { name: r.name, code: r.code, stdout: r.stdout, stderr: r.stderr, extra: r.extra };
  } catch (err: any) {
    // Mode gates / confirm gates arrive as JSON-RPC errors — surface honestly.
    return { name, code: err?.code ?? -1, stdout: '', stderr: String(err?.message ?? err) };
  }
}
// existing CLI fallback via this.bridge.run(argv) stays unchanged below
```

Match the return shape to the type `runNamed` already returns (read the file and reuse its result type; the fields above are the superset the UI consumes).

- [ ] **Step 3: Pass the RpcClient at construction**

In `ext/src/extension.ts`, find `new ToolRunner(...)` and pass the existing `rpc` instance as the third argument.

- [ ] **Step 4: Run tests + contract**

Run: `npm run test:unit && npm run contract`
Expected: all PASS (14 tests — 9 messages + 5 runner); contract OK baseline 17.

- [ ] **Step 5: Commit**

```bash
cd /Users/andrii/projects/labwired-agent
git add extensions/labwired-vscode/src
git commit -m "feat(ext): route tool execution through RPC tool/run with CLI fallback"
```

---

### Task 5: Eliminate dead RPC calls — baseline to zero

Remove or gracefully degrade every baseline entry, then delete the baseline file so drift becomes a hard failure.

**Mechanics note:** `tryRpc` is exempt from the contract checker. So when a step below wraps a `.request(...)` call in `tryRpc(...)` (or deletes it outright), that method drops out of the checker's client-call set and its baseline line goes STALE — **delete the corresponding baseline line in the same step/commit** so `npm run contract` stays green throughout.

**Files:**
- Modify: `ext/src/extension.ts:454-620` (delete `labwired.runTwin`? No — keep `runTwin`, fix its path in evidenceProvider; delete `startRtt`/`stopRtt`/`instruments` handlers and their `trace/*` listeners at 516-523)
- Modify: `ext/src/providers/evidenceProvider.ts:36-201`
- Modify: `ext/src/pro/billing.ts:108-296`
- Delete: `ext/scripts/rpc-contract-baseline.txt`

- [ ] **Step 1: Remove RTT and instrument commands**

`labwired.startRtt`, `labwired.stopRtt`, `labwired.instruments` are registered in `ext/src/extension.ts` (~lines 476-620) but NOT contributed in `package.json` — invisible dead UI calling nonexistent server methods. Delete:
- the three `vscode.commands.registerCommand` blocks for `labwired.startRtt`, `labwired.stopRtt`, `labwired.instruments`
- the `trace/eventBatch` and `trace/streamStatus` notification listeners (~lines 516-523)
- `labwired.runTwin` stays — it is fixed via evidenceProvider below.

Run: `npx tsc -p . --noEmit` → Expected: clean (remove now-unused imports if flagged).

- [ ] **Step 2: evidenceProvider — `twin/*` via tryRpc with CLI fallback**

In `ext/src/providers/evidenceProvider.ts`, wrap the `twin/run` and `twin/evidence` calls (~lines 36-38, 126, 140, 201):

```typescript
import { tryRpc } from '../rpc/messages';
// ...
const res = await tryRpc(this.rpc, 'twin/run', params);
if (res === null) {
  // Server protocol 0.5.0 has no twin/* — existing CLI `smoke` fallback path:
  return this.runViaCli(params);   // use the fallback that already exists in this file
}
```

Read the file and reuse its existing CLI-fallback method name; the change is only "RPC failure / absence → fallback" instead of "RPC error → broken view".

- [ ] **Step 3: billing — cloud RPC via tryRpc, honest signed-out state**

In `ext/src/pro/billing.ts`, the primary session source is already `cloud.json` (`src/cli/cloudSession.ts`). For each of the 9 RPC calls (`auth/logout`, `auth/loginWithToken`, `auth/startDeviceCode`, `auth/completeDeviceCode`, `auth/status`, `entitlement/status`, `project/list`, `project/create`, `project/select` at lines 108-296), route through `tryRpc` and treat `null` as "server has no cloud API": behave as signed-out/local-only and log once to the OutputChannel — never throw into the UI. Example for status:

```typescript
import { tryRpc } from '../rpc/messages';
const st = await tryRpc(this.rpc, 'auth/status', {});
if (st === null) { this.output.appendLine('billing: agent has no cloud API (protocol 0.5.0) — local mode'); return { signedIn: false }; }
```

- [ ] **Step 4: serial/getState + plot/start baseline lines**

These were fixed in Task 3 Step 4 — just confirm the calls are gone:
```bash
grep -rn "serial/getState\|plot/start" src/ --include="*.ts"
```
Expected: no output.

- [ ] **Step 5: Delete the baseline, verify contract is a hard gate**

```bash
rm scripts/rpc-contract-baseline.txt
npm run contract
```
Expected: `rpc-contract-check: OK (N calls, M subs, baseline 0)` exit 0.

Negative test — reintroduce drift and watch it fail:
```bash
echo "  await rpc.request('fake/method');" >> src/extension.ts
npm run contract; echo "exit=$?"
```
Expected: `DRIFT call: fake/method`, `exit=1`. Then revert:
```bash
cd /Users/andrii/projects/labwired-agent && git checkout extensions/labwired-vscode/src/extension.ts
```

- [ ] **Step 6: Full check + commit**

```bash
cd extensions/labwired-vscode && npm run compile && npm run test:unit && npm run contract
cd /Users/andrii/projects/labwired-agent
git add extensions/labwired-vscode
git commit -m "feat(ext): remove dead RPC calls; contract baseline now zero (hard gate)"
```

---

### Task 6: Bundle the server into the VSIX

Packaged installs currently depend on a system `labwired` install. Bundle `rpc-server.mjs` so the VSIX is self-contained (rpcClient already prefers `<extensionRoot>/server/rpc-server.mjs` — `rpcClient.ts:51-56`).

**Files:**
- Create: `ext/scripts/sync-server.mjs`
- Modify: `ext/package.json` (`vscode:prepublish`, add `files`-relevant check), `ext/.vscodeignore` (ensure `server/` is NOT ignored)
- Modify: `ext/src/extension.ts` (protocol version check after `rpc.start`)

- [ ] **Step 1: Write the sync script**

Create `ext/scripts/sync-server.mjs`:

```javascript
#!/usr/bin/env node
// Copy the agent RPC server into the extension so the VSIX is self-contained.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const extRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const agentRoot = join(extRoot, '..', '..');
const outDir = join(extRoot, 'server');
mkdirSync(outDir, { recursive: true });
copyFileSync(join(agentRoot, 'server', 'rpc-server.mjs'), join(outDir, 'rpc-server.mjs'));
const version = readFileSync(join(agentRoot, 'VERSION'), 'utf8').trim();
writeFileSync(join(outDir, 'AGENT_VERSION'), version + '\n');
console.log(`sync-server: bundled rpc-server.mjs (agent ${version})`);
```

- [ ] **Step 2: Hook it into packaging**

In `ext/package.json` change:
```json
"vscode:prepublish": "npm run compile && node scripts/sync-server.mjs",
```
In `ext/.vscodeignore`, verify there is NO line excluding `server/` (read the file; add `!server/**` only if a broad pattern would catch it).

- [ ] **Step 3: Protocol version check on activation**

In `ext/src/extension.ts`, immediately after `await rpc.start(ws)` (~line 102), the client's `start()` already stores nothing from `initialize` — so add the check inside `rpcClient.ts:95-109` where the `initialize` result is available:

```typescript
// after const init = await this.request('initialize', {...}):
const proto = (init as any)?.protocolVersion;
if (proto !== '0.5.0') {
  output.appendLine(`[rpc] WARNING: server protocol ${proto} != client 0.5.0 — some features may degrade`);
}
```

- [ ] **Step 4: Build the VSIX and verify contents**

```bash
cd /Users/andrii/projects/labwired-agent/extensions/labwired-vscode
npm run package
unzip -l labwired-vscode.vsix | grep -E "server/rpc-server.mjs|server/AGENT_VERSION"
```
Expected: both files listed.

- [ ] **Step 5: Commit**

```bash
cd /Users/andrii/projects/labwired-agent
git add extensions/labwired-vscode/scripts/sync-server.mjs extensions/labwired-vscode/package.json extensions/labwired-vscode/.vscodeignore extensions/labwired-vscode/src/cli/rpcClient.ts
git commit -m "feat(ext): bundle rpc-server.mjs in VSIX; warn on protocol mismatch"
```

---

### Task 7: Wire verification into repo CI + final proof

**Files:**
- Create: `tests/rpc-contract.sh` (agent repo root tests, next to `harness.sh`)

- [ ] **Step 1: Repo-level test entry**

Create `tests/rpc-contract.sh`:

```bash
#!/usr/bin/env bash
# rpc-contract.sh — extension <-> server RPC contract gate
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/extensions/labwired-vscode"
node scripts/rpc-contract-check.mjs
echo "rpc-contract: PASS"
```

```bash
chmod +x tests/rpc-contract.sh
```

- [ ] **Step 2: Wire into the test suite**

Add a call to `tests/rpc-contract.sh` inside `tests/all.sh` (read it first; follow its existing pattern of `run_test`/`echo` lines). Do NOT wire into `gap-ready-qa.sh` — that gate documents the AGENT_PRODUCT_READY baseline and stays frozen.

- [ ] **Step 3: Full verification run**

```bash
cd /Users/andrii/projects/labwired-agent
./tests/rpc-contract.sh                       # PASS
cd extensions/labwired-vscode
npm run compile                               # clean
npm run test:unit                             # 14 tests pass
npm run contract                              # baseline 0, OK
npm run package                               # VSIX built
unzip -l labwired-vscode.vsix | grep rpc-server.mjs
```

- [ ] **Step 4: Manual smoke (human, desk)**

Sideload the VSIX into Cursor (`cursor --install-extension labwired-vscode.vsix`), then:
1. Agent view loads; `/doctor` returns a tool row (proves `tool/run` path).
2. Chat freeform streams text (proves `chat/textDelta` parsing).
3. Stop button during a long reply (proves `chat/stop`).
4. Switch to Plan mode, ask to "flash the firmware" — refusal surfaces as an honest error row, not a crash (proves server-side gate through the extension).

- [ ] **Step 5: Commit + update the gap worklist**

```bash
cd /Users/andrii/projects/labwired-agent
git add tests/rpc-contract.sh tests/all.sh
git commit -m "test: wire ext RPC contract gate into tests/all.sh"
```

In `/Users/andrii/projects/labwired-cursor/docs/superpowers/plans/2026-07-31-gap-worklist.md`, flip Part 6 to DONE with a one-line evidence note linking this plan and `tests/rpc-contract.sh`.

---

## Caveats

1. **Server untouched.** If execution reveals a genuinely needed server method (e.g. `twin/run` turns out to be load-bearing for Evidence), that becomes a SEPARATE server-side change with its own `tests/` coverage — never bolted on mid-task.
2. **CLI fallback is deliberate, not drift.** Tools the server doesn't expose (`update`, `package_info`, `package_path`, `probe_reset`, `probe_install_backend`) keep the per-call CLI path. The contract checker only governs the RPC surface.
3. **`chat/send` freeform quality is server-side.** The extension only renders; model/opencode fallback behavior lives in the agent repo.
4. **Version skew:** extension `package.json` says 0.6.3 while VSIXes up to 0.9.0/0.10.0 are installed — bump `version` and `compatibleCliVersion` in a separate release task, not here.
5. **Windows:** `serial/*` and live UART are macOS/Linux-only server-side; the extension already degrades via empty port lists.
6. **`out/` is stale** (contains 0.9.0-era files with no `src/` counterpart). `npm run compile` overwrites it; never trust `out/` as a source of truth.
7. **Known leftovers (post-Task-3 review, not in scope):** `PlotViewProvider.pushSample` and `OverviewViewProvider.pushSample` are now dead (their `plot/data` call sites were removed); the client does not subscribe to server `serial/error` or `plot/clear`. Candidates for a later cleanup pass, not this plan.

## Definition of Done (Part 6)

- [ ] `npm run compile`, `npm run test:unit` (14 tests), `npm run contract` (baseline 0) all green
- [ ] `tests/rpc-contract.sh` wired into `tests/all.sh`, green
- [ ] VSIX contains `server/rpc-server.mjs` + `server/AGENT_VERSION`
- [ ] Manual smoke: `/doctor`, chat stream, chat stop, plan-mode flash refusal — all honest
- [ ] Gap worklist Part 6 marked DONE
