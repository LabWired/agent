# Generic Hardware Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a board-agnostic, profile-driven build/twin/flash/observation pipeline with honest behavior-level evidence, remove the extension's vulnerable Mocha dependency, and prove one exact native artifact on configured physical hardware.

**Architecture:** A Node 18+ runner parses a strict JSON profile, resolves kit-owned adapters, generates a confirmation-bound plan, and orchestrates the existing LabWired flash/capture/claim engines. Focused modules own profile validation, safe child execution, evidence persistence, adapters, locks, and orchestration; the Bash CLI and RPC manifest remain thin transports over that one engine.

**Tech Stack:** Node.js built-ins (`node:test`, `node:assert/strict`, `child_process`, `crypto`, `fs`, `http`/`https`), existing Bash engines, JSON evidence, TypeScript extension, PlatformIO, probe-rs, LabWired simulator.

---

## File Structure

- Create `lib/hardware/profile.mjs`: strict schema parser, path containment, trusted-provider validation, and canonical redacted profile.
- Create `lib/hardware/process.mjs`: cross-platform launch descriptors, bounded `shell:false` execution, streaming, cancellation, and process-tree termination.
- Create `lib/hardware/evidence.mjs`: fail-first evidence tree, atomic JSON writes, redaction, artifact hashes, and behavior-level aggregation.
- Create `lib/hardware/locks.mjs`: exclusive target/probe/port locks with stale-owner validation.
- Create `lib/hardware/adapters.mjs`: trusted build, twin, flash, serial, RTT, logic-CSV, and network adapters.
- Create `lib/hardware/runner.mjs`: plan generation, confirmation digest, orchestration, continuation rules, and finalization.
- Create `scripts/hardware-runner.mjs`: CLI argument parsing for `plan` and `run`.
- Modify `bin/labwired-agent`: expose `hardware plan|run` and dispatch only to `scripts/hardware-runner.mjs`.
- Modify `share/tools.json`: expose `hardware_plan` and gated `hardware_run` through the existing RPC transport.
- Modify `scripts/dev-cycle.sh` and `scripts/desk-hw-physical.sh`: compatibility wrappers that translate legacy environment variables into temporary profiles.
- Modify `tests/develop-acceptance-smoke.sh`: require exact behavior evidence from a configured physical profile instead of treating unsupported native twin execution as a release failure.
- Create `tests/hardware-*.test.mjs` and `tests/hardware-cli.sh`: focused unit and transport contracts.
- Create `fixtures/hardware-profiles/`: portable fake-provider fixtures and non-secret ESP32-C3 acceptance template.
- Modify `extensions/labwired-vscode/package.json`, lockfile, TypeScript config, and unit tests: migrate Mocha tests to `node:test`.
- Modify `tests/all.sh`, `scripts/check-public-package.sh`, documentation, and release contracts to include the new public surface and gates.

## Track A: Remove the Vulnerable Extension Test Dependency

### Task 1: Convert Extension Unit Tests to `node:test`

**Files:**
- Modify: `extensions/labwired-vscode/src/test/unit/messages.test.ts`
- Modify: `extensions/labwired-vscode/src/test/unit/toolRunnerRpc.test.ts`
- Modify: `extensions/labwired-vscode/tsconfig.json`
- Modify: `extensions/labwired-vscode/package.json`
- Modify: `extensions/labwired-vscode/package-lock.json`
- Test: `extensions/labwired-vscode/src/test/unit/*.test.ts`

- [ ] **Step 1: Write the failing dependency contract**

Create `extensions/labwired-vscode/scripts/test-runtime-contract.mjs`:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
assert.equal(pkg.scripts['test:unit'], 'npm run compile && node --test "out/test/unit/**/*.test.js"');
assert.equal(pkg.devDependencies?.mocha, undefined);
assert.equal(pkg.devDependencies?.['@types/mocha'], undefined);
console.log('test-runtime-contract: PASS');
```

- [ ] **Step 2: Verify RED**

Run: `node extensions/labwired-vscode/scripts/test-runtime-contract.mjs`
Expected: FAIL because the test script and Mocha dependencies still exist.

- [ ] **Step 3: Convert the test API**

In both test files, replace suite globals with explicit imports:

```ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
```

Replace `suite(` with `describe(` and retain existing assertions. In `tsconfig.json`, change `types` to `['node', 'vscode']`. Change `test:unit` to the exact command asserted above and add `test:runtime-contract` for the new contract.

- [ ] **Step 4: Remove dependencies deterministically**

Run: `npm uninstall --save-dev mocha @types/mocha` from `extensions/labwired-vscode`.
Expected: package and lock files no longer contain either dependency or `serialize-javascript`.

- [ ] **Step 5: Verify GREEN and audit**

Run:

```bash
npm --prefix extensions/labwired-vscode run test:runtime-contract
npm --prefix extensions/labwired-vscode run test:unit
npm --prefix extensions/labwired-vscode run contract
npm --prefix extensions/labwired-vscode audit --audit-level=high
```

Expected: contracts pass, 18 unit tests pass, RPC contract passes, audit reports zero high/critical vulnerabilities.

- [ ] **Step 6: Commit**

```bash
git add extensions/labwired-vscode
git commit -m "test(ext): replace mocha with node test"
```

## Track B: Generic Hardware Evidence

### Task 2: Parse and Validate Strict Hardware Profiles

**Files:**
- Create: `lib/hardware/profile.mjs`
- Create: `tests/hardware-profile.test.mjs`
- Create: `fixtures/hardware-profiles/minimal.json`

- [ ] **Step 1: Write failing profile tests**

Cover: schema must equal `1`; root and nested unknown keys reject; provider IDs are allowlisted; workspace/artifact/system paths cannot escape the workspace through `..` or symlinks; observations have unique safe IDs; timeouts are bounded integers; profiles reject `command`, `shell`, inline credential values, and ambiguous missing physical identities.

Use this public API in the tests:

```js
import { loadHardwareProfile, canonicalProfile } from '../lib/hardware/profile.mjs';
const profile = await loadHardwareProfile(path, { realpath: true });
assert.equal(profile.build.provider, 'platformio');
assert.deepEqual(canonicalProfile(profile), expectedRedactedObject);
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/hardware-profile.test.mjs`
Expected: FAIL with module-not-found for `lib/hardware/profile.mjs`.

- [ ] **Step 3: Implement strict parsing**

Export:

```js
export async function loadHardwareProfile(path, options = {})
export function validateHardwareProfile(value, sourcePath)
export function canonicalProfile(profile)
export const TRUSTED_PROVIDERS = Object.freeze({
  build: ['platformio', 'make', 'cmake'],
  twin: ['labwired-sim'],
  flash: ['platformio', 'probe-rs'],
  observation: ['serial', 'rtt', 'logic-csv', 'network'],
});
```

Use explicit key sets at every object level. Return a deeply frozen normalized object. Resolve filesystem paths relative to the profile and reject containment or reparse violations before execution.

- [ ] **Step 4: Verify GREEN**

Run: `node --test tests/hardware-profile.test.mjs`
Expected: all valid, mutation, secret, traversal, duplicate-ID, and provider tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/hardware/profile.mjs tests/hardware-profile.test.mjs fixtures/hardware-profiles/minimal.json
git commit -m "feat(hw): validate generic hardware profiles"
```

### Task 3: Add Safe Cross-Platform Process Execution

**Files:**
- Create: `lib/hardware/process.mjs`
- Create: `tests/hardware-process.test.mjs`

- [ ] **Step 1: Write failing process tests**

Test successful stdout/stderr capture, child exit propagation, timeout classification, descendant termination, abort-signal cancellation, environment allowlisting, secret redaction, and `shell === false`. Inject `platform: 'win32'` to prove `.ps1` resolves to a PowerShell launch descriptor and `.cmd` is rejected unless wrapped by a kit-owned adapter.

Expected interface:

```js
const descriptor = resolveLaunch({ executable, args, cwd, env }, { platform, pathEnv });
const result = await runLaunch(descriptor, { timeoutMs, signal, onDelta, redact });
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/hardware-process.test.mjs`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement launch descriptors and runner**

Export `resolveLaunch`, `runLaunch`, and `terminateProcessTree`. Use `spawn(command, args, { shell: false, detached: process.platform !== 'win32' })`; wrap `.ps1` with a resolved PowerShell host and fixed safe prefix; stream deltas while retaining bounded evidence; classify `exit`, `timeout`, `cancelled`, and `spawn_error` separately.

- [ ] **Step 4: Verify GREEN on the host and Windows contract fixtures**

Run: `node --test tests/hardware-process.test.mjs`
Expected: all process, timeout, cancellation, redaction, and Windows descriptor cases pass.

- [ ] **Step 5: Commit**

```bash
git add lib/hardware/process.mjs tests/hardware-process.test.mjs
git commit -m "feat(hw): execute provider processes safely"
```

### Task 4: Create Fail-First Evidence and Behavior Aggregation

**Files:**
- Create: `lib/hardware/evidence.mjs`
- Create: `tests/hardware-evidence.test.mjs`

- [ ] **Step 1: Write failing evidence tests**

Assert initialization creates every required `not-run` record plus top-level `FAIL`; atomic writes never leave truncated JSON; secret values redact from all strings; artifact hashes match bytes; unrelated behavior evidence cannot satisfy another behavior; surrogate model evidence cannot satisfy `model_observed`; only every required observation meeting its level yields PASS.

```js
const evidence = await createEvidenceBundle(dir, profile, { redactValues });
await evidence.recordBehavior('led', result);
const summary = await evidence.finalize();
assert.equal(summary.result, 'FAIL');
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/hardware-evidence.test.mjs`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement evidence writer and lattice**

Export `createEvidenceBundle`, `sha256File`, `redactDeep`, and `levelSatisfies`. Treat levels as explicit allowed pairs rather than ordinal numbers so `untrusted_observation` can never accidentally compare above a verified level.

- [ ] **Step 4: Verify GREEN**

Run: `node --test tests/hardware-evidence.test.mjs`
Expected: fail-first, atomicity, redaction, hash, and claim-boundary cases pass.

- [ ] **Step 5: Commit**

```bash
git add lib/hardware/evidence.mjs tests/hardware-evidence.test.mjs
git commit -m "feat(hw): persist behavior-level evidence"
```

### Task 5: Lock Explicit Physical Identities

**Files:**
- Create: `lib/hardware/locks.mjs`
- Create: `tests/hardware-locks.test.mjs`

- [ ] **Step 1: Write failing lock tests**

Test exclusive target/probe/port acquisition, competing-process refusal, safe stale-lock recovery only when the recorded PID is absent, rollback of partially acquired locks, and release under `finally` and abort.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/hardware-locks.test.mjs`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement lock manager**

Export:

```js
export async function acquireHardwareLocks(identities, { root, pid = process.pid })
// returns { records, release() }
```

Hash identity strings into filenames, create with exclusive mode, record PID/start time/identity, and validate exact ownership before removal.

- [ ] **Step 4: Verify GREEN and commit**

Run: `node --test tests/hardware-locks.test.mjs`
Expected: all lock lifecycle cases pass.

```bash
git add lib/hardware/locks.mjs tests/hardware-locks.test.mjs
git commit -m "feat(hw): serialize physical hardware access"
```

### Task 6: Implement Trusted Build and Twin Adapters

**Files:**
- Create: `lib/hardware/adapters.mjs`
- Create: `tests/hardware-build-twin.test.mjs`
- Create: `fixtures/hardware-profiles/projects/` fixture projects

- [ ] **Step 1: Write failing adapter tests**

Inject fake executables to assert exact launch descriptors for PlatformIO, Make, and CMake; artifact existence and SHA are mandatory; LabWired sim receives the selected system and exact artifact; different twin artifact hashes produce `surrogate_model_observed`; unsupported native execution records `blocked` without relabeling compilation as model evidence.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/hardware-build-twin.test.mjs`
Expected: FAIL because adapter registry is absent.

- [ ] **Step 3: Implement the registry**

Export `createTrustedAdapters(dependencies)` returning adapter objects with `preflight`, `plan`, and `execute`. PlatformIO uses `pio run -e ENV`; Make uses `make -C WORKSPACE`; CMake uses `cmake --build BUILD_DIR`; twin uses the existing simulator test-file contract. All paths and args come from validated typed fields.

- [ ] **Step 4: Verify GREEN and commit**

Run: `node --test tests/hardware-build-twin.test.mjs`
Expected: all build descriptors, artifacts, hashes, twin exact/surrogate, and unsupported cases pass.

```bash
git add lib/hardware/adapters.mjs tests/hardware-build-twin.test.mjs fixtures/hardware-profiles/projects
git commit -m "feat(hw): add trusted build and twin adapters"
```

### Task 7: Implement Physical Flash and Observation Adapters

**Files:**
- Modify: `lib/hardware/adapters.mjs`
- Create: `tests/hardware-observations.test.mjs`

- [ ] **Step 1: Write failing flash and observation tests**

Prove PlatformIO and probe-rs flash call the existing LabWired CLI rather than reimplementing it. Prove serial and RTT call existing capture commands. Prove logic CSV requires real transitions and optional frequency bounds. Prove a serial `LED ON` line alone cannot satisfy a `logic-csv` observation. Prove network evidence requires a device nonce/address marker plus a host response containing the same nonce. Prove credential values redact from stdout, stderr, plans, and results.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/hardware-observations.test.mjs`
Expected: FAIL because physical adapters are not registered.

- [ ] **Step 3: Implement physical adapters**

Flash adapters emit descriptors for `labwired-agent probe flash ...`. Serial and RTT emit descriptors for the existing CLI. Logic CSV parses configured time/value columns and calculates transitions/frequency without vendor SDK dependencies. Network consumes the device marker, validates a private/link-local address unless explicitly permitted, makes a bounded HTTP request with Node built-ins, and compares a cryptographically random run nonce.

- [ ] **Step 4: Verify GREEN and commit**

Run: `node --test tests/hardware-observations.test.mjs`
Expected: flash delegation, independent evidence, nonce correlation, negative fakes, and redaction pass.

```bash
git add lib/hardware/adapters.mjs tests/hardware-observations.test.mjs
git commit -m "feat(hw): observe physical behavior independently"
```

### Task 8: Orchestrate Plan, Confirmation, Run, and Cancellation

**Files:**
- Create: `lib/hardware/runner.mjs`
- Create: `tests/hardware-runner.test.mjs`

- [ ] **Step 1: Write failing orchestration tests**

Test read-only plan generation; canonical SHA-256 digest stability; wrong/missing digest prevents locks and flash; ambiguous identities fail preflight; build failure prevents flash; twin failure may continue only when policy permits; flash failure blocks dependent observations; independent observations continue after one failure; cancellation terminates children/releases locks/preserves FAIL; full fixture yields PASS only when every required behavior passes.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/hardware-runner.test.mjs`
Expected: FAIL because the runner does not exist.

- [ ] **Step 3: Implement orchestration**

Export:

```js
export async function planHardwareRun({ profilePath, evidenceDir, dependencies })
export async function executeHardwareRun({ profilePath, evidenceDir, confirmDigest, dependencies, signal })
```

Plan validates and preflights without mutation. Run regenerates the plan, compares the digest with constant-time equality, initializes evidence, acquires locks, builds, twins, flashes, re-resolves stable ports, runs observations, finalizes, and releases resources in `finally`.

- [ ] **Step 4: Verify GREEN and commit**

Run: `node --test tests/hardware-runner.test.mjs`
Expected: all sequencing, confirmation, continuation, cancellation, and finalization cases pass.

```bash
git add lib/hardware/runner.mjs tests/hardware-runner.test.mjs
git commit -m "feat(hw): orchestrate confirmed hardware runs"
```

### Task 9: Expose One CLI and RPC Surface

**Files:**
- Create: `scripts/hardware-runner.mjs`
- Modify: `bin/labwired-agent`
- Modify: `share/tools.json`
- Modify: `tests/tools-manifest.sh`
- Create: `tests/hardware-cli.sh`

- [ ] **Step 1: Write failing CLI/RPC contracts**

Assert `hardware plan --profile P --out D` exits zero and prints a digest; `hardware run` without the digest exits 2 before fake flash; matching digest runs; Plan and Verify modes reject `hardware_run`; Act/Debug permit it; CLI and RPC outputs and exit codes match.

- [ ] **Step 2: Verify RED**

Run: `bash tests/hardware-cli.sh && bash tests/tools-manifest.sh`
Expected: FAIL because the command and manifest rows do not exist.

- [ ] **Step 3: Implement thin transports**

The script parses only `plan|run`, `--profile`, `--out`, and `--confirm`, then calls `lib/hardware/runner.mjs`. Add `cmd_hardware` to the Bash dispatcher. Add manifest rows:

```json
{
  "name": "hardware_plan",
  "argv": ["hardware", "plan", "--profile", "${profile}", "--out", "${out}"],
  "modes": ["act", "debug", "plan", "verify"]
}
```

and `hardware_run` restricted to Act/Debug with the confirmation parameter.

- [ ] **Step 4: Verify GREEN and commit**

Run: `bash tests/hardware-cli.sh && bash tests/tools-manifest.sh && bash tests/rpc-contract.sh`
Expected: transport parity and mode gates pass.

```bash
git add scripts/hardware-runner.mjs bin/labwired-agent share/tools.json tests/hardware-cli.sh tests/tools-manifest.sh
git commit -m "feat(hw): expose profile-driven hardware commands"
```

### Task 10: Migrate Legacy Cycles Without a Second Engine

**Files:**
- Modify: `scripts/dev-cycle.sh`
- Modify: `scripts/desk-hw-physical.sh`
- Modify: `scripts/profiles/esp32c3-serial.sh`
- Create: `tests/hardware-legacy-compat.sh`

- [ ] **Step 1: Write failing compatibility tests**

Provide fake legacy `LABWIRED_HW_*` values and assert both scripts generate equivalent version 1 profiles, call `hardware plan/run`, preserve exit meanings, and contain no direct `pio run`, simulator, flash, or serial orchestration after migration.

- [ ] **Step 2: Verify RED**

Run: `bash tests/hardware-legacy-compat.sh`
Expected: FAIL because both scripts still orchestrate independently.

- [ ] **Step 3: Replace orchestration with profile translation**

Keep the existing environment names, generate a temporary JSON profile with Python's standard `json` module to avoid quoting injection, invoke the new CLI, and delete the temporary profile through a trap. The ESP32-C3 script remains only a fixture profile selector.

- [ ] **Step 4: Verify GREEN and commit**

Run: `bash tests/hardware-legacy-compat.sh tests/dispatcher.sh tests/rpc-promote.sh`
Expected: compatibility, dispatcher, and existing promote behavior pass.

```bash
git add scripts/dev-cycle.sh scripts/desk-hw-physical.sh scripts/profiles/esp32c3-serial.sh tests/hardware-legacy-compat.sh
git commit -m "refactor(hw): route legacy cycles through profiles"
```

### Task 11: Close ESP32-C3, LED, Wi-Fi, and Physical Acceptance Gaps

**Files:**
- Create: `fixtures/hardware-profiles/esp32c3-acceptance.template.json`
- Create: `fixtures/hardware-profiles/logic/led-pass.csv`
- Create: `fixtures/hardware-profiles/logic/led-flat.csv`
- Modify: `tests/develop-acceptance-smoke.sh`
- Create: `tests/hardware-release-contract.sh`

- [ ] **Step 1: Write failing release contracts**

Require the acceptance script to consume behavior evidence, reject serial-only LED claims, reject mismatched Wi-Fi nonces, accept unsupported exact twin execution only when the exact artifact has adequate physical evidence, and fail strict mode when the configured lab profile omits any required behavior.

- [ ] **Step 2: Verify RED**

Run: `bash tests/hardware-release-contract.sh`
Expected: FAIL because the acceptance script still hard-codes two skips.

- [ ] **Step 3: Replace hard-coded skip scenarios**

Drive the greenfield and LED/Wi-Fi scenarios through fixture profiles and normalized evidence. Default mechanics mode uses deterministic fake adapters and remains portable. Strict physical mode requires `LABWIRED_HW_PROFILE`, exact target identities, and real provider outputs; absent lab configuration exits 2 with `BLOCKED`, never PASS.

- [ ] **Step 4: Verify deterministic GREEN**

Run:

```bash
bash tests/hardware-release-contract.sh
bash tests/develop-acceptance-smoke.sh
```

Expected: deterministic contracts pass with negative fake cases proven; ordinary acceptance has zero hard-coded skips.

- [ ] **Step 5: Run the physical desk gate only after inspecting the plan**

Run:

```bash
labwired agent hardware plan --profile "$LABWIRED_HW_PROFILE" --out "$LABWIRED_HW_OUT"
labwired agent hardware run --profile "$LABWIRED_HW_PROFILE" --out "$LABWIRED_HW_OUT" --confirm "$APPROVED_DIGEST"
```

Expected: exact native artifact hash appears in build and flash evidence; serial heartbeat, independent LED edges, and correlated Wi-Fi nonce pass; top-level result is PASS. If the required external LED wiring/capture or Wi-Fi lab configuration is absent, stop with BLOCKED and do not weaken the test.

- [ ] **Step 6: Commit deterministic acceptance changes**

```bash
git add fixtures/hardware-profiles tests/develop-acceptance-smoke.sh tests/hardware-release-contract.sh
git commit -m "test(hw): require behavior-level release evidence"
```

Do not commit machine-specific physical profiles, credentials, ports, probe serials, or generated desk evidence.

### Task 12: Package, Document, and Gate the Public Surface

**Files:**
- Modify: `package.json`
- Modify: `tests/all.sh`
- Modify: `scripts/check-public-package.sh`
- Modify: `docs/USAGE.md`
- Modify: `docs/VERIFY.md`
- Modify: `docs/TESTING.md`
- Modify: `skills/develop/SKILL.md`
- Modify: `skills/desk-hw/SKILL.md`

- [ ] **Step 1: Write failing package/document contracts**

Extend public-package checks to require every `lib/hardware/*.mjs` file, the runner, profile documentation, claim vocabulary, confirmation flow, secret rules, and exact-versus-surrogate explanation. Add the focused Node tests and shell contracts to `tests/all.sh`.

- [ ] **Step 2: Verify RED**

Run: `bash scripts/check-public-package.sh && npm test`
Expected: public package or matrix fails until new files/tests/docs are registered.

- [ ] **Step 3: Update package and documentation**

Document `hardware plan`, digest confirmation, `hardware run`, profile creation, provider support, behavior evidence, physical lab requirements, and legacy environment migration. Teach `develop` to prefer a checked-in safe profile and `desk-hw` to stop on ambiguous identities or missing confirmation.

- [ ] **Step 4: Run focused verification**

```bash
node --test tests/hardware-*.test.mjs
bash tests/hardware-cli.sh
bash tests/hardware-legacy-compat.sh
bash tests/hardware-release-contract.sh
bash tests/tools-manifest.sh
bash scripts/check-public-package.sh
npm --prefix extensions/labwired-vscode run test:unit
npm --prefix extensions/labwired-vscode run contract
npm --prefix extensions/labwired-vscode audit --audit-level=high
```

Expected: all pass; audit has zero high/critical findings.

- [ ] **Step 5: Commit**

```bash
git add package.json tests/all.sh scripts/check-public-package.sh docs skills
git commit -m "docs(hw): publish generic hardware workflow"
```

## Final Verification and Integration

### Task 13: Run Release-Grade Verification

**Files:** No intended source edits.

- [ ] **Step 1: Install pinned dependencies cleanly**

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm --prefix extensions/labwired-vscode ci --ignore-scripts --no-audit --no-fund
```

Expected: clean installs; `git status --short` contains no generated tracked changes.

- [ ] **Step 2: Run full local matrices**

```bash
LABWIRED_SHIP_STAGE_TIMEOUT=180 npm test
npm --prefix extensions/labwired-vscode run test:unit
npm --prefix extensions/labwired-vscode run contract
npm audit --audit-level=high
npm --prefix extensions/labwired-vscode audit --audit-level=high
actionlint -color .github/workflows/*.yml
git diff --check
```

Expected: every command exits zero. Restore test-generated coverage snapshots through an explicit patch before the clean-worktree assertion.

- [ ] **Step 3: Run strict configured hardware acceptance**

```bash
LABWIRED_ACCEPTANCE_REQUIRE_COMPLETE=1 \
LABWIRED_HW_PROFILE="$LABWIRED_HW_PROFILE" \
bash tests/develop-acceptance-smoke.sh
```

Expected: zero FAIL and zero SKIP for required configured behaviors. If the lab lacks independent LED capture or Wi-Fi configuration, report BLOCKED; do not claim completion.

- [ ] **Step 4: Verify clean scope**

```bash
git status --short --branch
git diff --check origin/main..HEAD
git log --oneline origin/main..HEAD
```

Expected: only intentional commits and no uncommitted files.

- [ ] **Step 5: Request code review, push, and merge only after green evidence**

Use the repository's normal PR flow. Require hosted Windows, macOS, Ubuntu, install-smoke, unit, and Windows-contract checks. Download release evidence artifacts before making a readiness claim.

## Plan Self-Review

- Spec coverage: all profile, trust, evidence, safety, compatibility, extension-security, physical-gate, and release requirements map to Tasks 1–13.
- Scope separation: extension migration is independently committable; hardware modules are separated by responsibility and introduced through focused TDD cycles.
- Type consistency: `loadHardwareProfile`, `resolveLaunch`, `runLaunch`, `createEvidenceBundle`, `acquireHardwareLocks`, `createTrustedAdapters`, `planHardwareRun`, and `executeHardwareRun` are defined once and used consistently.
- Claim consistency: exact model, surrogate model, physical, untrusted, blocked, and failed remain distinct throughout the plan.
- Safety consistency: no task permits implicit device selection, shell strings, unbound confirmation, committed secrets, or serial-as-GPIO evidence.
