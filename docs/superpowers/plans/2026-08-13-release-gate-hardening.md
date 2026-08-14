# Release Gate Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make LabWired Agent release gates bounded, upgrade-aware, lifecycle-complete, credentialed for hosted release evidence, and free of deprecated GitHub Actions runtime warnings.

**Architecture:** Introduce one portable command timeout utility and route potentially blocking ship-gate stages through it. Extend platform-native evidence scripts with uninstall/reinstall lifecycle checks, add pinned previous-release upgrade scripts, and keep credentialed hosted verification in a dedicated release workflow. Structured contract tests enforce workflow, artifact, and action-version requirements.

**Tech Stack:** Bash, Python 3, PowerShell 5.1/7, Node.js, GitHub Actions.

---

### Task 1: Portable Bounded Command Runner

**Files:**
- Create: `scripts/run-bounded.py`
- Create: `tests/run-bounded.sh`
- Modify: `tests/all.sh`

- [ ] Write a failing shell test that runs a successful command, a failing command, and a Python sleep longer than a 100 ms bound. Require exit codes 0, the child failure code, and 124 respectively; require timeout stderr to name the command and duration.
- [ ] Run `bash tests/run-bounded.sh` and verify RED because the utility is absent.
- [ ] Implement `run-bounded.py` with `subprocess.Popen`, a positive `--timeout` value, process-group termination on POSIX, normal stdout/stderr forwarding, child exit propagation, and exit 124 on timeout.
- [ ] Run `bash tests/run-bounded.sh` and verify GREEN.
- [ ] Add `run "run-bounded" "$ROOT/tests/run-bounded.sh"` to `tests/all.sh`.
- [ ] Commit with `git commit -m "test: add portable bounded command runner"`.

### Task 2: Bound Every Blocking Ship-Gate Stage

**Files:**
- Create: `tests/ship-gate-bounds.sh`
- Modify: `scripts/ship-gate.sh`
- Modify: `tests/all.sh`

- [ ] Write a failing contract test requiring a `run_stage` helper, `LABWIRED_SHIP_STAGE_TIMEOUT`, `scripts/run-bounded.py`, a result file, and one final `ship-gate PASS` or `ship-gate FAILED` line.
- [ ] Add a fixture command that hangs and assert a two-second test gate exits nonzero, records `timeout`, continues to one later independent fixture, and prints exactly one final result.
- [ ] Run `bash tests/ship-gate-bounds.sh` and verify RED.
- [ ] Refactor `ship-gate.sh` so each external stage runs through `run_stage <name> <log> <command...>`. Default each stage to 90 seconds, allow stage-specific overrides, map 124 to a named timeout failure, and continue independent stages.
- [ ] Write `PASS` or `FAIL` to `$OUT/result.txt` only at the end.
- [ ] Verify `bash tests/ship-gate-bounds.sh`, then run `LABWIRED_SHIP_STAGE_TIMEOUT=180 bash scripts/ship-gate.sh` and confirm an authoritative final result.
- [ ] Add the contract to `tests/all.sh` and commit with `git commit -m "fix: bound ship gate stages"`.

### Task 3: Extend POSIX Lifecycle Evidence

**Files:**
- Modify: `tests/install-smoke.sh`

- [ ] Add a failing evidence assertion requiring `lifecycle.txt` and a preserved user sentinel after uninstall/reinstall.
- [ ] Precreate `lifecycle.txt` as `not-run` with the other evidence files.
- [ ] After the initial doctor, create sentinels in the prefix data directory and config, uninstall with `agent package uninstall --yes`, assert Agent-owned files/config entries disappear and sentinels survive, reinstall from the checkout, and re-run version/doctor.
- [ ] Record each lifecycle phase and final state in `lifecycle.txt`; leave `result.txt=FAIL` until all phases pass.
- [ ] Run `LABWIRED_EVIDENCE_DIR=$(mktemp -d) bash tests/install-smoke.sh` and verify all seven evidence files are nonempty and result is PASS.
- [ ] Commit with `git commit -m "test: prove POSIX uninstall and reinstall lifecycle"`.

### Task 4: Extend Windows Lifecycle Evidence

**Files:**
- Modify: `tests/windows-install-smoke.ps1`
- Modify: `tests/windows-contract.ps1`

- [ ] Extend the Windows contract to require `lifecycle.txt`, uninstall, reinstall, and sentinel markers; run on Windows and verify RED.
- [ ] Precreate `lifecycle.txt`, add prefix/config sentinels, run uninstall in a nested matching PowerShell process, assert Agent-owned files/config entries are removed and sentinels survive, reinstall, and rerun version/doctor.
- [ ] Ensure both Windows PowerShell and PowerShell Core write independent lifecycle evidence.
- [ ] Run `tests/windows-contract.ps1` and `tests/windows-install-smoke.ps1` under both engines in GitHub CI; commit with `git commit -m "test: prove Windows uninstall and reinstall lifecycle"`.

### Task 5: Previous-Release Upgrade Fixtures

**Files:**
- Create: `tests/upgrade-smoke.sh`
- Create: `tests/windows-upgrade-smoke.ps1`
- Create: `tests/upgrade-contract.sh`
- Modify: `tests/all.sh`

- [ ] Write a contract test requiring explicit `LABWIRED_PREVIOUS_AGENT_ARCHIVE`, `LABWIRED_PREVIOUS_AGENT_VERSION`, checksum validation, complete evidence files, and `not run` when optional inputs are absent.
- [ ] Create local previous-install fixtures from a temporary archived checkout at a known earlier tag or supplied archive; do not discover “latest” during the test.
- [ ] POSIX: install the previous archive into an isolated home, confirm its exact version, add user sentinels, install the current checkout, confirm current version/doctor, uninstall, and verify ownership cleanup plus sentinel survival.
- [ ] Windows: perform the same sequence with nested PowerShell processes and a supplied zip/archive.
- [ ] Evidence must contain `platform.txt`, `previous-version.txt`, `current-version.txt`, `upgrade-install.txt`, `doctor.txt`, `lifecycle.txt`, `capabilities.txt`, and `result.txt`.
- [ ] Run absent-input tests locally and fixture-backed POSIX tests; run Windows runtime authoritatively in CI.
- [ ] Add contracts to `tests/all.sh` and commit with `git commit -m "test: add pinned previous-release upgrade evidence"`.

### Task 6: Release Hosted Evidence Workflow

**Files:**
- Create: `.github/workflows/release-readiness.yml`
- Create: `tests/hosted-release-contract.js`
- Modify: `tests/release-evidence-contract.js`
- Modify: `docs/TESTING.md`

- [ ] Write failing structured assertions requiring `workflow_dispatch`, candidate version and previous-release inputs, Ubuntu/macOS/Windows jobs, required hosted secrets, upgrade scripts, authenticated doctor, real hosted MCP probe, artifact upload with `if: always()`, and no secret-bearing files in artifact paths.
- [ ] Add a release workflow that fails immediately when hosted token/project or previous-release inputs are missing.
- [ ] Install the candidate on each OS, export credentials only to the process, run authenticated doctor and a real hosted MCP request, sanitize logs, then run platform upgrade evidence.
- [ ] Upload hosted status, MCP result, upgrade evidence, platform, capabilities, and final result; never upload session/config/token files.
- [ ] Document that ordinary PR hosted checks may be `not run`, while this release workflow is mandatory.
- [ ] Run both structured contracts and commit with `git commit -m "ci: require hosted and upgrade release evidence"`.

### Task 7: Upgrade GitHub Actions Runtime Versions

**Files:**
- Modify: `.github/workflows/harness.yml`
- Modify: `.github/workflows/deployed-install.yml`
- Modify: `.github/workflows/release-readiness.yml`
- Modify: `tests/release-evidence-contract.js`

- [ ] Add failing assertions rejecting `actions/checkout@v4` and `actions/upload-artifact@v4` and requiring the repository-selected current major versions.
- [ ] Confirm from official action release metadata which majors use the supported Node runtime; update all workflow references consistently.
- [ ] Run structured contracts and `actionlint` if installed.
- [ ] Commit with `git commit -m "ci: update actions runtime versions"`.

### Task 8: Cross-Platform Verification

**Files:**
- No expected implementation changes

- [ ] Run focused local tests: bounded runner, ship-gate contract, POSIX lifecycle, upgrade contract, workflow contracts, package gate, lifecycle suite.
- [ ] Run the deterministic local matrix with an isolated npm cache. If the live ship gate is credentialed, run it separately with explicit stage bounds.
- [ ] Run `git diff --check` and confirm a clean worktree.
- [ ] Push the branch only with existing user authorization, watch the exact SHA, and require all source evidence and Windows contract jobs to pass.
- [ ] Download Ubuntu, macOS, and Windows artifacts and audit lifecycle/result records.
- [ ] Do not call the release public-ready until publication and deployed-endpoint verification pass for the same version.
