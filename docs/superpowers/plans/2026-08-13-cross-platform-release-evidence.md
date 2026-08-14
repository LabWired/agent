# Cross-Platform Release Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce honest, retained clean-install evidence for LabWired Agent on GitHub-hosted Ubuntu, macOS, and Windows while fixing the two reproduced local release-gate failures.

**Architecture:** Separate deterministic source-install evidence, which proves a commit before deployment, from public-endpoint evidence, which proves the deployed installer afterward. POSIX and Windows use separate CI jobs and platform-native smoke scripts. Both scripts accept a persistent evidence directory containing platform, installer, version, doctor, and capability records that CI uploads even on failure.

**Tech Stack:** Bash, PowerShell 5.1/7, Node.js 18+, Python 3, npm, GitHub Actions.

---

## Support Claim

This plan proves native Agent installation and command dispatch on the runner operating systems. It does not claim native simulator parity where a simulator artifact is absent. Architecture claims remain limited to the architectures shown in each evidence artifact; adding ARM64 Linux or Windows requires an actual ARM64 runner, not static path tests.

## File Map

- `tests/install-smoke.sh`: isolated POSIX source install with persistent evidence output.
- `tests/windows-install-smoke.ps1`: isolated Windows source install with persistent evidence output.
- `tests/agent-lifecycle.sh`: hosted configuration ownership and uninstall contract.
- `scripts/check-public-package.sh`: safety scan of shipped and explicitly public content.
- `tests/public-package-scope.sh`: negative and positive package-scope fixtures.
- `tests/release-evidence-contract.js`: structured workflow contract.
- `.github/workflows/harness.yml`: separate Ubuntu, macOS, and Windows evidence jobs.
- `.github/workflows/deployed-install.yml`: manual/post-deploy public endpoint probe.
- `docs/INSTALL.md`, `docs/TESTING.md`: precise support and evidence interpretation.

### Task 1: Fix the Package Safety Scope

**Files:**
- Create: `tests/public-package-scope.sh`
- Modify: `scripts/check-public-package.sh`
- Modify: `tests/all.sh`

- [ ] **Step 1: Add a root override for fixture testing**

Write the test first against `LABWIRED_PACKAGE_ROOT`. The fixture must contain a minimal npm package whose `files` list includes `README.md` and `bin/labwired`, plus:

- a non-published `docs/superpowers/plans/dev.md` containing a synthetic macOS
  home path assembled as `"/" + "Users/example/private"` inside the fixture;
- a non-published `extensions/example/package-lock.json` containing `maintainer@invalid.test`;
- a packed `README.md` variant containing the same private path.

The first fixture run expects success with only development files tainted. The second expects failure after tainting the packed README.

- [ ] **Step 2: Run the regression and verify RED**

Run: `NPM_CONFIG_CACHE=/private/tmp/labwired-agent-npm-cache bash tests/public-package-scope.sh`

Expected: the development-only fixture fails because the checker currently scans every tracked file.

- [ ] **Step 3: Restrict the scan without weakening secret detection**

Set:

```bash
ROOT="${LABWIRED_PACKAGE_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
```

Pass `PUBLIC_DOCS` into the Node block as a newline-delimited temporary file. Replace the tracked-file union with the npm-packed files plus those explicit public documents. Keep required-file checks, forbidden package paths, `scanBuffer`, and all secret patterns unchanged.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
NPM_CONFIG_CACHE=/private/tmp/labwired-agent-npm-cache bash tests/public-package-scope.sh
NPM_CONFIG_CACHE=/private/tmp/labwired-agent-npm-cache bash scripts/check-public-package.sh
```

Expected: both exit 0; the nested negative fixture confirms a tainted packed file is still rejected.

- [ ] **Step 5: Add the test to `tests/all.sh` and commit**

```bash
git add scripts/check-public-package.sh tests/public-package-scope.sh tests/all.sh
git commit -m "fix: scope package safety scan to public content"
```

### Task 2: Correct Hosted Configuration Lifecycle Expectations

**Files:**
- Modify: `tests/agent-lifecycle.sh`
- Modify only if ownership is not recorded correctly: `install.sh`

- [ ] **Step 1: Make the failing assertion diagnostic**

Replace the opaque fresh-config loop with assertions for the intended hosted contract:

```python
assert data.get("model") == "labwired/labwired-default", data.get("model")
assert data.get("default_agent") == "build", data.get("default_agent")
assert "labwired" in data.get("provider", {}), data.get("provider")
assert "labwired" in data.get("mcp", {}), data.get("mcp")
```

Before this install phase, clear `LABWIRED_MODEL_URL`, `LABWIRED_MODEL_KEY`, `LABWIRED_ACCESS_TOKEN`, and `LABWIRED_PROJECT`, then set `LABWIRED_AGENT_PROFILE=hosted` explicitly.

- [ ] **Step 2: Verify the ownership test fails at the next incorrect assumption**

Run: `bash tests/agent-lifecycle.sh`

Expected RED: if uninstall does not remove a manifest-owned hosted key or preserve later user fields, the diagnostic assertion names that exact field. A pass here is acceptable because the original failure itself demonstrates the stale test expectation.

- [ ] **Step 3: Complete the uninstall contract**

After adding later user settings and uninstalling, assert:

```python
assert "model" not in data
assert "default_agent" not in data
assert "labwired" not in data.get("provider", {})
assert "labwired" not in data.get("mcp", {})
assert data["provider"]["added-later"]["name"] == "keep"
assert data["settings"]["theme"] == "later-user"
```

Change `install.sh` only if this exposes a real ownership/removal bug.

- [ ] **Step 4: Verify GREEN and commit**

Run: `bash tests/agent-lifecycle.sh && bash tests/hosted-config.sh`

```bash
git add tests/agent-lifecycle.sh install.sh
git commit -m "test: align lifecycle checks with hosted config ownership"
```

### Task 3: Add Persistent POSIX Evidence

**Files:**
- Modify: `tests/install-smoke.sh`

- [ ] **Step 1: Write the evidence contract first**

Add a calling test mode using `LABWIRED_EVIDENCE_DIR`. When set, require the script to preserve these files outside its disposable install root:

```text
platform.txt
install.txt
version.txt
doctor.txt
capabilities.txt
result.txt
```

Run once before implementation and verify at least one required file is missing.

- [ ] **Step 2: Capture install and command evidence**

Create the evidence directory before the temporary prefix. Capture `uname -a`, `uname -m`, installer output, and `labwired agent version` output. Install test-local executable stubs for `opencode`, `npx`, and `node` so `doctor` can exercise dispatch without failing merely because test mode intentionally skipped runtime installation.

- [ ] **Step 3: Validate doctor honestly**

Capture its exit code without `set -e` aborting:

```bash
set +e
"$USERBIN/labwired" agent doctor >"$EVIDENCE_DIR/doctor.txt" 2>&1
doctor_rc=$?
set -e
```

Require exit 0 with the test stubs, require Agent doctor markers, and reject `Failed to change directory` and standalone `not ready`. Record whether a simulator and probe were present in `capabilities.txt`; absence remains a recorded capability gap, not a fake pass.

- [ ] **Step 4: Verify the installed dispatcher and legacy replacement**

Before installation, seed the exact old direct-Agent shim already observed locally. After installation, require the installed file to match the product-dispatch shape and prove `agent version` and `agent doctor` reach Agent subcommands. This tests upgrade replacement without claiming the old shim came from the current installer.

- [ ] **Step 5: Verify and commit**

Run:

```bash
evidence="$(mktemp -d)"
LABWIRED_EVIDENCE_DIR="$evidence" bash tests/install-smoke.sh
find "$evidence" -maxdepth 1 -type f -print
grep -q '^PASS$' "$evidence/result.txt"
bash tests/dispatcher.sh
```

```bash
git add tests/install-smoke.sh
git commit -m "test: retain POSIX clean-install evidence"
```

### Task 4: Add Native Windows Evidence

**Files:**
- Create: `tests/windows-install-smoke.ps1`
- Modify: `tests/windows-contract.ps1`

- [ ] **Step 1: Extend the Windows contract with evidence assertions**

Before creating the new script, make `tests/windows-contract.ps1` require that it exists and contains `LABWIRED_EVIDENCE_DIR`, `agent version`, `agent doctor`, `capabilities.txt`, and `result.txt`.

- [ ] **Step 2: Run on Windows and verify RED**

Run: `powershell -NoProfile -File .\tests\windows-contract.ps1`

Expected: FAIL because `tests/windows-install-smoke.ps1` is absent. This RED step occurs on the Windows CI runner or a native Windows development environment.

- [ ] **Step 3: Implement isolated Windows installation evidence**

The script creates a GUID-named temporary home and sets `USERPROFILE`, `LABWIRED_HOME`, `LABWIRED_BIN_DIR`, `LABWIRED_AGENT_CONFIG_DIR`, and test-mode variables. It invokes the checkout's `scripts/install.ps1 -AgentOnly`, captures installer output, then exercises the installed product dispatcher through both the generated `.cmd` entry and PowerShell entry.

It writes the same six evidence files as POSIX, records `$PSVersionTable`, OS architecture, process architecture, simulator presence, and probe presence, and preserves the evidence directory in `finally`. It rejects directory-dispatch errors and false-ready output.

- [ ] **Step 4: Verify under both PowerShell engines**

Run on Windows:

```powershell
powershell -NoProfile -File .\tests\windows-install-smoke.ps1
pwsh -NoProfile -File .\tests\windows-install-smoke.ps1
```

Expected: both exit 0 and write `PASS` to their result files.

- [ ] **Step 5: Commit**

```bash
git add tests/windows-contract.ps1 tests/windows-install-smoke.ps1
git commit -m "test: retain native Windows install evidence"
```

### Task 5: Add Structured Workflow Contracts and CI Jobs

**Files:**
- Create: `tests/release-evidence-contract.js`
- Modify: `.github/workflows/harness.yml`
- Modify: `tests/all.sh`

- [ ] **Step 1: Write the structured contract before workflow changes**

Use a small dependency-free Node parser limited to the known workflow shape. It must locate jobs by exact keys and validate:

- `release-evidence-ubuntu` uses `ubuntu-latest` and `tests/install-smoke.sh`;
- `release-evidence-macos` uses an explicitly documented macOS runner and `tests/install-smoke.sh`;
- `release-evidence-windows` uses `windows-latest` and `tests/windows-install-smoke.ps1` under both `powershell` and `pwsh`;
- every evidence job has an `actions/upload-artifact@v4` step with `if: always()` and a stable OS-specific artifact name.

The parser must ignore comments and reject duplicate job keys.

- [ ] **Step 2: Run and verify RED**

Run: `node tests/release-evidence-contract.js`

Expected: FAIL naming the first missing job.

- [ ] **Step 3: Add separate platform jobs**

Add three explicit jobs rather than a cross-shell matrix. Ubuntu and macOS create `artifacts/release-evidence/<os>` and pass that path to `tests/install-smoke.sh`. Windows passes an equivalent path to the PowerShell smoke. Each upload step uses `if: always()` and `if-no-files-found: error`.

- [ ] **Step 4: Keep source evidence deterministic**

Source-install jobs use checkout files, isolated homes/caches, and test-local runtime stubs. They do not require hosted credentials or public installer availability. Existing optional hosted checks continue to report `not run` when secrets are absent.

- [ ] **Step 5: Verify and commit**

Run: `node tests/release-evidence-contract.js && bash tests/install-smoke.sh`

Add `node "$ROOT/tests/release-evidence-contract.js"` to `tests/all.sh`, then commit:

```bash
git add .github/workflows/harness.yml tests/release-evidence-contract.js tests/all.sh
git commit -m "ci: collect source-install evidence on three systems"
```

### Task 6: Add a Separate Deployed-Endpoint Probe

**Files:**
- Create: `.github/workflows/deployed-install.yml`
- Modify: `tests/release-evidence-contract.js`

- [ ] **Step 1: Add failing deployed-workflow assertions**

Require a `workflow_dispatch` workflow with Ubuntu, macOS, and Windows jobs. POSIX jobs must download `https://labwired.com/install`; Windows must download `https://labwired.com/install.ps1`. Require the workflow input `expected_version` and require installed `labwired agent version` output to match it.

- [ ] **Step 2: Run and verify RED**

Run: `node tests/release-evidence-contract.js`

Expected: FAIL because the deployed workflow does not exist.

- [ ] **Step 3: Implement post-deploy endpoint checks**

Each job downloads the public installer to a temporary file, records its SHA-256, installs into an isolated temporary home, captures version/doctor/capabilities, and uploads evidence even on failure. This workflow is manual or invoked by the deployment pipeline after the endpoint is updated; it is not a pull-request gate because a PR commit is not deployed yet.

- [ ] **Step 4: Verify static contracts and commit**

Run: `node tests/release-evidence-contract.js`

```bash
git add .github/workflows/deployed-install.yml tests/release-evidence-contract.js
git commit -m "ci: verify deployed installers after publication"
```

### Task 7: Document Evidence and Narrow Claims

**Files:**
- Modify: `docs/INSTALL.md`
- Modify: `docs/TESTING.md`
- Modify: `tests/release-evidence-contract.js`

- [ ] **Step 1: Add documentation checks first**

Require the install guide to distinguish native Agent support from local simulator availability. Require the testing guide to distinguish source evidence from deployed-endpoint evidence and explain that artifact architecture values—not installer branches—determine proven architectures.

- [ ] **Step 2: Run and verify RED**

Run: `node tests/release-evidence-contract.js`

Expected: FAIL naming missing documentation language.

- [ ] **Step 3: Update the documentation**

Document:

- native Agent support on tested macOS, Ubuntu, and Windows runners;
- hosted verification or WSL when no native Windows simulator artifact exists;
- exact artifact names and required files;
- same-commit requirement for the three source artifacts;
- separate post-deploy endpoint evidence;
- architecture support only where `platform.txt` provides actual runner evidence.

- [ ] **Step 4: Verify and commit**

Run:

```bash
node tests/release-evidence-contract.js
NPM_CONFIG_CACHE=/private/tmp/labwired-agent-npm-cache bash scripts/check-public-package.sh
```

```bash
git add docs/INSTALL.md docs/TESTING.md tests/release-evidence-contract.js
git commit -m "docs: define evidence-qualified platform support"
```

### Task 8: Local and Hosted Verification

**Files:**
- No expected production changes

- [ ] **Step 1: Run the complete local suite**

Run:

```bash
NPM_CONFIG_CACHE=/private/tmp/labwired-agent-npm-cache \
LABWIRED_FAST=1 LABWIRED_INSTALL_PIO=0 bash tests/all.sh
```

Expected: `======== OVERALL PASS ========`; hardware and credentialed lanes may explicitly report `not run`.

- [ ] **Step 2: Inspect repository state**

Run: `git status --short && git diff --check && git log --oneline --decorate -8`

Expected: no uncommitted files and no whitespace errors.

- [ ] **Step 3: Request approval before pushing**

Report local results and ask the user to approve pushing `fix/cross-platform-release-evidence`. Do not push merely because implementation was authorized.

- [ ] **Step 4: After approval, push and watch the exact commit**

```bash
git push -u origin fix/cross-platform-release-evidence
gh run list --repo LabWired/agent --workflow harness.yml --branch fix/cross-platform-release-evidence --limit 5
gh run watch --repo LabWired/agent <run-id> --exit-status
```

- [ ] **Step 5: Download and audit evidence**

Download `labwired-agent-source-ubuntu`, `labwired-agent-source-macos`, and `labwired-agent-source-windows` for the same SHA. Confirm each has all six files, `result.txt` is `PASS`, command output belongs to LabWired Agent, and `capabilities.txt` states rather than conceals missing simulator/probe support.

- [ ] **Step 6: Run deployed evidence after publication**

Invoke `deployed-install.yml` with the published version. Only call the public release cross-platform ready when the deployed endpoint jobs pass in addition to the same-commit source jobs.
