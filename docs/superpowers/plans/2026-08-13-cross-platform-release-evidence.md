# Cross-Platform Release Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one commit produce retained clean-install evidence for LabWired Agent on GitHub-hosted Ubuntu, macOS, and Windows runners, with all reproduced local release blockers resolved.

**Architecture:** Keep `bin/labwired` and `bin/labwired.ps1` as the product dispatch boundary and test the installed command rather than a checkout-only launcher. Split safety checking into the npm-published file set and a deliberately scoped public-source set. Add an OS matrix whose platform scripts install into isolated homes, exercise advertised commands, and write stable evidence files uploaded even when a check fails.

**Tech Stack:** Bash, PowerShell 5.1/7, Node.js 18+, Python 3, npm package manifests, GitHub Actions.

---

## File Map

- `tests/install-smoke.sh`: POSIX installed-dispatch and doctor regression coverage.
- `tests/windows-install-smoke.ps1`: Windows isolated installer and installed-command evidence.
- `tests/agent-lifecycle.sh`: isolated configuration ownership assertions with actionable failures.
- `scripts/check-public-package.sh`: published-file and public-source safety scan boundaries.
- `tests/public-package-scope.sh`: regression coverage for included and excluded scan paths.
- `tests/release-evidence-contract.sh`: static contract for the three-OS workflow and artifacts.
- `.github/workflows/harness.yml`: three-OS clean-install evidence jobs and artifact retention.
- `docs/INSTALL.md`, `docs/TESTING.md`: exact platform support and evidence semantics.

### Task 1: Installed POSIX Dispatcher Regression

**Files:**
- Modify: `tests/install-smoke.sh`
- Modify only if the regression fails: `install.sh`

- [ ] **Step 1: Extend the installed-command test before changing production code**

Add assertions immediately after `agent_version` is captured:

```bash
agent_doctor="$($USERBIN/labwired agent doctor 2>&1)"
grep -q 'version  ' <<<"$agent_version"
grep -q 'home     ' <<<"$agent_version"
grep -q 'agent-runtime' <<<"$agent_doctor"
if grep -q 'Failed to change directory' <<<"$agent_version$agent_doctor"; then
  echo 'FAIL installed dispatcher forwarded an Agent subcommand as a directory' >&2
  exit 1
fi
```

- [ ] **Step 2: Run the test and verify the current installer behavior**

Run: `bash tests/install-smoke.sh`

Expected: PASS for the repository installer. Then reproduce the stale local shim separately with `labwired agent version`; this establishes that the defect is an obsolete user shim, not the current installer output.

- [ ] **Step 3: Add a reinstall-upgrades-stale-shim fixture**

Before invoking `install.sh`, create `$USERBIN/labwired` with the legacy direct-Agent launcher shape and assert installation replaces it:

```bash
mkdir -p "$USERBIN"
printf '#!/usr/bin/env bash\nexec "$LABWIRED_HOME/agent/bin/labwired-agent" "$@"\n' >"$USERBIN/labwired"
chmod +x "$USERBIN/labwired"
```

After installation, require `grep -q 'labwired_product_help' "$USERBIN/labwired"`.

- [ ] **Step 4: Run the regression test red, then make the smallest installer change if needed**

Run: `bash tests/install-smoke.sh`

Expected before a necessary fix: FAIL because the legacy shim survives or dispatch is wrong. If it fails, update the existing user-shim installation branch in `install.sh` to atomically replace the legacy file with `bin/labwired`; do not change direct Agent launcher semantics.

- [ ] **Step 5: Verify the focused tests**

Run: `bash tests/install-smoke.sh && bash tests/dispatcher.sh && bash tests/agent-lifecycle.sh`

Expected: all three scripts exit 0.

- [ ] **Step 6: Commit**

```bash
git add tests/install-smoke.sh install.sh
git commit -m "fix: upgrade legacy agent shims during install"
```

### Task 2: Public Package Safety Boundary

**Files:**
- Create: `tests/public-package-scope.sh`
- Modify: `scripts/check-public-package.sh`
- Modify: `tests/all.sh`

- [ ] **Step 1: Write a failing scope regression**

Create a temporary git repository containing a publishable file, a development plan with a workstation path, and an extension lockfile with a maintainer email. Invoke the checker through a new `LABWIRED_PACKAGE_ROOT` override. Assert that publishable secrets fail, while non-published development files do not fail the package gate:

```bash
run_check() {
  LABWIRED_PACKAGE_ROOT="$FIXTURE" NPM_CONFIG_CACHE="$TMP/npm-cache" \
    bash "$ROOT/scripts/check-public-package.sh"
}
```

The fixture copies the real `package.json`, scanner, required public files, and package files, then uses `git init && git add .` so the test exercises tracked-file behavior.

- [ ] **Step 2: Run it and confirm the existing over-broad scan fails**

Run: `bash tests/public-package-scope.sh`

Expected: FAIL because tracked development-only files are included in `publicSources`.

- [ ] **Step 3: Restrict strict scanning to shipped and explicitly public source files**

In `scripts/check-public-package.sh`, allow `ROOT` to use `${LABWIRED_PACKAGE_ROOT:-...}`. In the Node block, replace `new Set([...tracked, ...files])` with the union of npm-packed files and `PUBLIC_DOCS`; retain the tracked list only for detecting required files and repository metadata. Do not weaken `scanBuffer`, secret patterns, or required-package checks.

- [ ] **Step 4: Verify both positive and negative fixtures**

Run: `bash tests/public-package-scope.sh && NPM_CONFIG_CACHE=/tmp/labwired-agent-npm-cache bash scripts/check-public-package.sh`

Expected: the development-only fixture passes, the intentionally tainted packed-file fixture fails inside its test harness, and the real repository check exits 0.

- [ ] **Step 5: Add the regression to the full suite and commit**

Add:

```bash
run "public-package-scope" "$ROOT/tests/public-package-scope.sh"
```

Then commit:

```bash
git add scripts/check-public-package.sh tests/public-package-scope.sh tests/all.sh
git commit -m "test: scope public safety checks to shipped content"
```

### Task 3: Lifecycle Configuration Isolation

**Files:**
- Modify: `tests/agent-lifecycle.sh`
- Modify only if ownership is wrong: `install.sh`

- [ ] **Step 1: Replace opaque Python assertions with diagnostic assertions**

In the new-config section, use:

```python
for key in ("model", "default_agent", "autoupdate", "share", "$schema", "agent"):
    if key in data:
        raise AssertionError(f"fresh user config unexpectedly owns {key}={data[key]!r}")
```

Also invoke the new-config install with an explicit clean environment:

```bash
unset LABWIRED_MODEL_URL LABWIRED_MODEL_KEY LABWIRED_ACCESS_TOKEN LABWIRED_PROJECT
export LABWIRED_AGENT_PROFILE=hosted
```

- [ ] **Step 2: Verify the failure and trace the written key**

Run: `bash -x tests/agent-lifecycle.sh`

Expected before the fix: FAIL naming the exact inherited or installed key. Compare that value with `config/opencode.hosted.json` and the merge ownership list in `install.sh`.

- [ ] **Step 3: Correct the test contract or installer ownership at the source**

If the key is intentionally part of a fresh hosted configuration, change the test to assert its expected hosted value and confirm uninstall removes only the manifest-recorded LabWired key. If it is inherited state, clear it at the test boundary. Change `install.sh` only if it writes an unrecorded product-owned key or removes a user-owned key.

- [ ] **Step 4: Verify lifecycle and configuration tests**

Run: `bash tests/agent-lifecycle.sh && bash tests/hosted-config.sh && bash tests/public-install.sh`

Expected: all scripts exit 0 with the npm cache set to an isolated writable directory where necessary.

- [ ] **Step 5: Commit**

```bash
git add tests/agent-lifecycle.sh install.sh
git commit -m "test: isolate agent lifecycle configuration state"
```

### Task 4: Three-OS Evidence Contract

**Files:**
- Create: `tests/release-evidence-contract.sh`
- Create: `tests/windows-install-smoke.ps1`
- Modify: `.github/workflows/harness.yml`
- Modify: `tests/all.sh`

- [ ] **Step 1: Write the workflow contract first**

Create a shell test that parses `.github/workflows/harness.yml` as text and requires:

```bash
for runner in ubuntu-latest macos-latest windows-latest; do
  grep -q "$runner" "$WORKFLOW" || fail "missing runner $runner"
done
grep -q 'actions/upload-artifact@v4' "$WORKFLOW" || fail 'missing evidence upload'
grep -q 'if: always()' "$WORKFLOW" || fail 'evidence is not retained on failure'
grep -q 'labwired-agent-evidence-' "$WORKFLOW" || fail 'missing stable artifact prefix'
grep -q 'tests/windows-install-smoke.ps1' "$WORKFLOW" || fail 'missing Windows clean install'
grep -q 'tests/install-smoke.sh' "$WORKFLOW" || fail 'missing POSIX clean install'
```

- [ ] **Step 2: Run the contract and confirm it fails**

Run: `bash tests/release-evidence-contract.sh`

Expected: FAIL because macOS clean-install evidence and artifact upload are absent.

- [ ] **Step 3: Add the Windows isolated install smoke**

The PowerShell script creates a GUID-named temp root, sets `USERPROFILE`, `LABWIRED_HOME`, `LABWIRED_BIN_DIR`, `OPENCODE_CONFIG_DIR`, and test-mode environment variables, invokes `scripts/install.ps1 -AgentOnly`, then captures:

```powershell
& $Labwired agent version *>&1 | Tee-Object "$EvidenceDir\version.txt"
& $Labwired agent doctor *>&1 | Tee-Object "$EvidenceDir\doctor.txt"
if ($LASTEXITCODE -ne 0) { throw "installed Agent doctor failed" }
```

It must run through both `bin/labwired.cmd` and `bin/labwired.ps1`, reject `Failed to change directory`, record `$PSVersionTable`, and clean up in `finally` while preserving the requested evidence directory.

- [ ] **Step 4: Add the clean-install matrix and artifact upload**

Add a `release-evidence` matrix with explicit includes for Ubuntu, macOS, and Windows. POSIX entries run `tests/install-smoke.sh`; Windows runs `tests/windows-install-smoke.ps1` under both `powershell` and `pwsh`. Each writes into `artifacts/release-evidence/<os>` and uploads with:

```yaml
- name: Upload release evidence
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: labwired-agent-evidence-${{ matrix.platform }}
    path: artifacts/release-evidence/${{ matrix.platform }}
    if-no-files-found: error
```

- [ ] **Step 5: Keep the workflow testable without network credentials**

Set `LABWIRED_TEST_SKIP_NETWORK=1`, `LABWIRED_TEST_SKIP_OPENCODE=1`, and an isolated npm cache for clean-install contract jobs. Keep hosted model/twin smoke in its existing optional credentialed lane; absence of credentials must print `not run`, never `PASS`.

- [ ] **Step 6: Verify workflow and platform contracts locally**

Run: `bash tests/release-evidence-contract.sh && bash tests/install-smoke.sh && bash tests/windows-contract.ps1 2>/dev/null || test "$(uname -s)" != Linux`

Expected: the static evidence contract and POSIX smoke pass. The Windows script is executed authoritatively by the Windows runner, not emulated on POSIX.

- [ ] **Step 7: Add the contract to `tests/all.sh` and commit**

```bash
git add .github/workflows/harness.yml tests/release-evidence-contract.sh tests/windows-install-smoke.ps1 tests/all.sh
git commit -m "ci: retain clean-install evidence on three operating systems"
```

### Task 5: Documentation and Release Semantics

**Files:**
- Modify: `docs/INSTALL.md`
- Modify: `docs/TESTING.md`

- [ ] **Step 1: Add a failing documentation assertion to the evidence contract**

Require `docs/INSTALL.md` to contain `native Agent` and `hosted verification or WSL`, and require `docs/TESTING.md` to name `labwired-agent-evidence-macos`, `labwired-agent-evidence-ubuntu`, and `labwired-agent-evidence-windows`.

- [ ] **Step 2: Run the contract and observe the documentation failure**

Run: `bash tests/release-evidence-contract.sh`

Expected: FAIL for missing release-evidence language.

- [ ] **Step 3: Document the precise support claim**

State that the Agent launcher and hosted workflow are native on Windows 10+, while local twin simulation uses hosted verification or WSL until a matching native simulator release asset exists. Document how to download and interpret the three evidence artifacts and that all must come from the same commit.

- [ ] **Step 4: Verify public language and commit**

Run: `bash tests/release-evidence-contract.sh && NPM_CONFIG_CACHE=/tmp/labwired-agent-npm-cache bash scripts/check-public-package.sh`

Expected: both exit 0.

```bash
git add docs/INSTALL.md docs/TESTING.md tests/release-evidence-contract.sh
git commit -m "docs: define cross-platform release evidence"
```

### Task 6: Full Verification and Hosted Evidence

**Files:**
- No expected production changes

- [ ] **Step 1: Run the complete local suite with isolated caches**

Run:

```bash
NPM_CONFIG_CACHE=/tmp/labwired-agent-npm-cache \
LABWIRED_FAST=1 LABWIRED_INSTALL_PIO=0 bash tests/all.sh
```

Expected: `======== OVERALL PASS ========`; optional hardware and credentialed lanes may say `not run` with their requirements.

- [ ] **Step 2: Confirm a clean working tree except intentional commits**

Run: `git status --short && git diff --check`

Expected: no uncommitted output and `git diff --check` exits 0.

- [ ] **Step 3: Push the implementation branch and wait for the matrix**

Run: `git push -u origin ext/thin-client`

Then inspect the workflow for the pushed commit:

```bash
gh run list --repo LabWired/agent --workflow harness.yml --branch ext/thin-client --limit 5
gh run watch --repo LabWired/agent <run-id> --exit-status
```

Expected: unit, Ubuntu evidence, macOS evidence, Windows evidence, and Windows contract jobs all pass for the same SHA.

- [ ] **Step 4: Verify retained evidence artifacts**

Run:

```bash
gh run download --repo LabWired/agent <run-id> --pattern 'labwired-agent-evidence-*' --dir /tmp/labwired-agent-evidence
find /tmp/labwired-agent-evidence -type f -maxdepth 3 -print
```

Expected: separate Ubuntu, macOS, and Windows directories containing platform, installer, version, and doctor logs. Read each log and reject false-ready text or wrong command dispatch.

- [ ] **Step 5: Report the evidence-qualified release status**

Only call the Agent cross-platform release-ready when all required jobs and artifacts exist for the same commit. Report native Windows Agent support and its hosted/WSL simulation boundary explicitly.
