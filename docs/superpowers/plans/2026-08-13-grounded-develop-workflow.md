# Grounded Develop Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one concise `develop` skill that reliably guides greenfield and existing-project firmware work through grounded context, compilation, twin checks, bounded repair, and an honest five-part report.

**Architecture:** Keep the agent as the orchestrator and reuse the existing `labwired_*` MCP tools and claim rules. Add no runtime workflow engine: the implementation is one domain skill, normal kit registration, static contract tests, and five smoke-scenario prompts exercised through the existing firmware QA lane.

**Tech Stack:** Markdown skills, OpenCode JSON configuration, Bash contract tests, existing LabWired MCP tools and firmware QA scripts.

---

## File Map

- Create `skills/develop/SKILL.md`: the complete user-facing firmware development workflow.
- Create `tests/develop-skill.sh`: fast deterministic contract test for the skill and its five smoke scenarios.
- Modify `config/AGENTS.md`: make `develop` the default firmware workflow while retaining the existing specialist packs.
- Modify `skills/golden-path/SKILL.md`: delegate firmware creation and repair to `develop` without duplicating its procedure.
- Modify `skills/README.md`: document the concise public skill surface.
- Modify `config/opencode.json`, `config/opencode.hosted.json`, `config/opencode.deepinfra.json`, and `config/opencode.airgap.json`: allow the new skill.
- Modify `package.json`: include the skill in published packages and expose its contract test.
- Modify `bin/labwired-agent`: include `develop` in doctor/startup visibility.
- Modify `tests/skills-inventory.sh`, `tests/skills-verify-all.sh`, `tests/fw-usecase-qa.sh`, and `tests/all.sh`: register and verify the new primary skill.

### Task 1: Lock the concise skill contract with a failing test

**Files:**
- Create: `tests/develop-skill.sh`
- Modify: `tests/all.sh`

- [ ] **Step 1: Write the failing contract test**

Create `tests/develop-skill.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL="$ROOT/skills/develop/SKILL.md"

fail=0
need() {
  local pattern="$1" label="$2"
  if grep -qiE "$pattern" "$SKILL"; then
    echo "ok   develop $label"
  else
    echo "FAIL develop missing $label"
    fail=1
  fi
}

[[ -f "$SKILL" ]] || { echo "FAIL missing skills/develop/SKILL.md"; exit 1; }

need 'labwired_context' 'context-first'
need 'labwired_(part|datasheet|search)' 'grounding tools'
need 'labwired_compile' 'compile'
need 'labwired_run' 'twin run'
need 'labwired_inspect' 'twin inspect'
need 'labwired_verify' 'oracle verify'
need 'three total|3 total' 'attempt bound'
need 'Changed' 'report changed heading'
need 'Grounded by' 'report grounding heading'
need 'Compiled' 'report compile heading'
need 'Twin checked' 'report twin heading'
need 'Still needs hardware' 'report hardware-gap heading'
need 'ESP32-C3' 'greenfield smoke'
need 'STM32F103' 'existing-project smoke'
need 'Wi-Fi' 'partial-coverage smoke'
need 'custom board' 'unsupported-target smoke'

if grep -qiE 'workflow engine|state machine|database|new persistence' "$SKILL"; then
  echo "FAIL develop grew orchestration infrastructure"
  fail=1
else
  echo "ok   develop stays KISS"
fi

[[ "$fail" -eq 0 ]] || exit 1
echo "ok   develop-skill PASS"
```

Add this line after `run "skills-verify-all"` in `tests/all.sh`:

```bash
run "develop-skill"     "$ROOT/tests/develop-skill.sh"
```

- [ ] **Step 2: Make the test executable and run it to verify failure**

Run:

```bash
chmod +x tests/develop-skill.sh
bash tests/develop-skill.sh
```

Expected: exit 1 with `FAIL missing skills/develop/SKILL.md`.

- [ ] **Step 3: Commit the failing contract**

```bash
git add tests/develop-skill.sh tests/all.sh
git commit -m "test: define develop workflow contract"
```

### Task 2: Add the single KISS develop skill

**Files:**
- Create: `skills/develop/SKILL.md`
- Test: `tests/develop-skill.sh`

- [ ] **Step 1: Create the skill with the complete workflow**

Create `skills/develop/SKILL.md`:

```markdown
---
name: develop
description: >-
  Default firmware workflow for greenfield and existing projects: inspect,
  ground hardware facts, edit, compile, check on the twin, repair, and report.
license: MIT
compatibility: opencode
metadata:
  gate: "workflow"
  labwired: "true"
  pack: "develop"
---

# Develop firmware

Use this loop for firmware creation, changes, and repairs:

```text
inspect or scaffold → ground → edit → compile → twin check → repair → report
```

## Rules

1. Call `labwired_context` before hardware-sensitive work.
2. Use `labwired_part`, `labwired_datasheet`, or `labwired_search` before choosing pins, peripheral instances, addresses, clocks, timing limits, or register fields. Prefer project and SDK symbols over numeric constants. Label unresolved deductions `inferred`.
3. Preserve existing project structure. For greenfield work, scaffold the smallest conventional project for the named board and framework.
4. Run `labwired_compile` or the repository's established build command after edits.
5. After a successful compile, turn each observable requested behavior into `labwired_verify`, or `labwired_run` plus `labwired_inspect`. If unsupported, list the coverage gap. Never say tested when no check ran.
6. Use at most three total edit-and-test attempts, including the initial implementation. Make focused repairs from concrete diagnostics.
7. Only `labwired_verify` may return `model_verified`. Only `desk-hw` may report `hardware_observed`.

## Report

End with exactly these headings:

- **Changed** — files and behavior changed
- **Grounded by** — important values and catalog, document, schematic, SVD, SDK, or project sources; label inferences
- **Compiled** — command and result
- **Twin checked** — observed or `model_verified` behaviors
- **Still needs hardware** — unsupported, unavailable, or non-observable behavior

Finish with one result: `verified`, `partially verified`, `compiled only`, `failed`, or `blocked`.

## Smoke scenarios

- **Greenfield ESP32-C3:** PlatformIO Arduino LED blink plus `alive` serial heartbeat.
- **Existing STM32F103:** add a one-second heartbeat without restructuring the fixture.
- **Compile recovery ESP32-C3:** repair one deliberate compiler error within three total attempts.
- **Partial coverage ESP32-C3:** check LED behavior and report Wi-Fi association as uncovered when the twin cannot observe it.
- **Unsupported custom board:** compile when possible, report `compiled only` at best, and require physical confirmation.
```

- [ ] **Step 2: Run the contract test to verify success**

Run:

```bash
bash tests/develop-skill.sh
```

Expected: exit 0 ending with `ok   develop-skill PASS`.

- [ ] **Step 3: Commit the skill**

```bash
git add skills/develop/SKILL.md
git commit -m "feat: add grounded develop workflow"
```

### Task 3: Register develop across the shipped kit

**Files:**
- Modify: `config/AGENTS.md`
- Modify: `skills/golden-path/SKILL.md`
- Modify: `skills/README.md`
- Modify: `config/opencode.json`
- Modify: `config/opencode.hosted.json`
- Modify: `config/opencode.deepinfra.json`
- Modify: `config/opencode.airgap.json`
- Modify: `package.json`
- Modify: `bin/labwired-agent`
- Modify: `tests/skills-inventory.sh`
- Modify: `tests/skills-verify-all.sh`
- Modify: `tests/fw-usecase-qa.sh`

- [ ] **Step 1: Extend inventory tests first**

Make these exact test changes:

```bash
# tests/skills-inventory.sh
for s in develop golden-path bringup prove observe desk-hw; do
```

Require `develop` in each config allowlist condition:

```bash
if grep -q 'develop' "$cfg" && grep -q 'golden-path' "$cfg" \
```

In `tests/skills-verify-all.sh`, use:

```bash
PRIMARY=(develop golden-path bringup prove observe desk-hw import-circuit)
```

and replace the count block with:

```bash
# 7 domain packs + customize-labwired-agent + 14 superpowers = 22
if [[ "$n" -eq 22 ]]; then
  pass "skill dir count $n (7 packs + customize + 14 superpowers)"
else
  bad "skill dir count $n expected 22"
fi
```

In `tests/fw-usecase-qa.sh`, prepend `develop` to the skills loop:

```bash
for skill in develop golden-path bringup prove observe desk-hw using-superpowers; do
```

- [ ] **Step 2: Run inventory tests to verify registration is incomplete**

Run:

```bash
bash tests/skills-inventory.sh
bash tests/skills-verify-all.sh
```

Expected: failure because `develop` is not yet in `AGENTS.md`, the OpenCode allowlists, doctor output, or package inventory.

- [ ] **Step 3: Make develop the concise default in agent instructions and docs**

In `config/AGENTS.md`, change the default firmware instruction to load `develop` first and show this flow:

```text
develop
  → bringup / import-circuit   (knowledge only when needed)
  → prove                     (labwired_verify → model_verified)
  → optional desk-hw          (hardware_observed only)
```

Add this skills-table row:

```markdown
| **`develop`** | Default inspect → ground → compile → twin-check → repair workflow |
```

In `skills/golden-path/SKILL.md`, replace its duplicated bringup/prove procedure with:

```markdown
## Procedure

1. Load **`develop`** for firmware creation, modification, compilation, twin checks, repair, and reporting.
2. Load **`import-circuit`** only when external circuit input must become `.labwired/lab.yaml`.
3. Load **`observe`** only for requested plots.
4. Load **`desk-hw`** only when a physical board is available and the user wants hardware evidence.
```

In `skills/README.md`, add `develop` as the first domain row and change the typical order to:

```markdown
Typical order: `develop` → optional `import-circuit` / `observe` / `desk-hw`. `golden-path` remains the first-session guide and delegates firmware work to `develop`.
```

- [ ] **Step 4: Add develop to all four OpenCode allowlists**

Add the following property under `permission.skill` in each `config/opencode*.json` file:

```json
"develop": "allow",
```

Run:

```bash
for f in config/opencode*.json; do jq -e '.permission.skill.develop == "allow"' "$f"; done
```

Expected: four `true` results.

- [ ] **Step 5: Add develop to packaging and CLI visibility**

Add this entry beside the other domain skills in `package.json`:

```json
"skills/develop/SKILL.md",
```

Add this npm script:

```json
"test:develop": "bash tests/develop-skill.sh",
```

In `bin/labwired-agent`, prepend `develop` to the doctor pack loop and include it in the help/startup skill lists. Do not change CLI behavior or add a new command.

- [ ] **Step 6: Run focused tests**

Run:

```bash
bash tests/develop-skill.sh
bash tests/skills-inventory.sh
bash tests/skills-verify-all.sh
bash tests/fw-usecase-qa.sh
```

Expected: all four exit 0; firmware QA includes `PASS  FW-SKILL-develop`.

- [ ] **Step 7: Commit kit integration**

```bash
git add config/AGENTS.md config/opencode.json config/opencode.hosted.json \
  config/opencode.deepinfra.json config/opencode.airgap.json \
  skills/golden-path/SKILL.md skills/README.md package.json bin/labwired-agent \
  tests/skills-inventory.sh tests/skills-verify-all.sh tests/fw-usecase-qa.sh
git commit -m "feat: ship develop as default firmware workflow"
```

### Task 4: Verify release packaging and existing gates

**Files:**
- Modify only if a gate reveals a direct omission in the files listed above.

- [ ] **Step 1: Verify the npm package contains the skill**

Run:

```bash
npm pack --dry-run 2>&1 | grep 'skills/develop/SKILL.md'
```

Expected: one line containing `skills/develop/SKILL.md`.

- [ ] **Step 2: Run the fast unit and contract suite**

Run:

```bash
npm run test:unit
npm run test:develop
```

Expected: both commands exit 0.

- [ ] **Step 3: Run the release gate**

Run:

```bash
LABWIRED_TEST_INSTALL_SMOKE=0 bash tests/all.sh
```

Expected: `======== OVERALL PASS ========`. Hardware-dependent checks may report `not run` or `SKIP`; no required check may fail.

- [ ] **Step 4: Inspect the final diff for KISS scope**

Run:

```bash
git diff HEAD~3 --stat
git diff HEAD~3 -- skills/develop/SKILL.md config/AGENTS.md skills/golden-path/SKILL.md
```

Expected: one new skill and registration/test changes only; no workflow runtime, database, state-machine library, or duplicate hardware tool implementation.

- [ ] **Step 5: Confirm no implementation changes remain uncommitted**

Run:

```bash
git status --short
```

Expected: none of `skills/develop`, `config`, `bin/labwired-agent`, `package.json`, or `tests` is modified or untracked. Pre-existing unrelated user files may remain untracked. If a release check failed, return to the task that owns the failing file, make the smallest correction there, rerun its focused test, and commit that task before repeating Task 4.
