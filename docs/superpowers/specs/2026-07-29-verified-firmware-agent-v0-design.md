# Design: Verified Firmware-Engineering Agent v0

**Date:** 2026-07-29  
**Status:** Approved beachhead A — design only (packages not yet implemented)  
**Repo:** `LabWired/agent` (`/Users/andrii/Projects/labwired-agent`)  
**Related:**

- `docs/superpowers/specs/2026-07-28-firmware-agent-positioning-design.md` (kit packaging)
- `docs/superpowers/specs/2026-07-28-bundled-probe-design.md` (probe-rs path, claim split)
- `config/AGENTS.md` (standing claim gate)
- `fixtures/gate1/` (offline red→green claim shape)

---

## 1. Product statement

### What we sell (beachhead A)

A **verified firmware-engineering agent**: structured tools + a constrained repair loop + deterministic verification.

| Layer | Who does what |
|-------|----------------|
| Model | Proposes firmware, patches, diagrams, oracles |
| LabWired oracle | Disposes: `labwired_verify` returns typed status |
| Agent kit | Enforces tools, claim vocabulary, repair budget, evidence reports |

### What we do **not** sell in v0

- A fine-tuned Zephyr (or any) model  
- QLoRA / SFT / RLHF training loops  
- “It looks right” or compile-green as success  
- Automatic upgrade of sim green → “works on hardware”

**One-line:** Model proposes; LabWired oracle disposes.

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  User / CI                                                        │
│  “make this UART marker print on ESP32-C3”                        │
└────────────────────────────┬─────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  OpenCode harness (stock; no fork)                                │
│  bin/labwired · config/AGENTS.md · config/opencode*.json          │
│  Skills (allowlisted) · claim gate (assert-status / score-verify) │
└───────────────┬─────────────────────────────┬────────────────────┘
                │                             │
                ▼                             ▼
┌───────────────────────────┐   ┌──────────────────────────────────┐
│  MCP: @labwired/mcp       │   │  CLI helpers (agent home)        │
│  labwired_list/describe   │   │  labwired probe …                │
│  labwired_run (observe)   │   │  labwired assert-status          │
│  labwired_verify (oracle) │   │  score-verify / serial-capture   │
│  labwired_inspect/validate│   │  (libs + optional subcommands)   │
└─────────────┬─────────────┘   └────────────────┬─────────────────┘
              │                                  │
              ▼                                  ▼
┌───────────────────────────┐   ┌──────────────────────────────────┐
│  Digital twin / sim       │   │  Desk HW (ESP32-C3 beachhead)    │
│  → status: model_verified │   │  flash (probe-rs) + serial       │
│    | failed | inconclusive│   │  marker → hardware_observed      │
│    | unsupported          │   │  NEVER → model_verified          │
└───────────────────────────┘   └──────────────────────────────────┘
```

### Control loop (canonical)

```
1. Restate behavior as oracle clause(s)
2. firmware_ref + diagram + oracle
3. labwired_verify  ──►  failed | unsupported | inconclusive
4. Constrained repair (budget N, minimal patch, same oracle)
5. labwired_verify  ──►  model_verified  (only green for twin claims)
6. Optional C3 promote: flash + serial marker ──► hardware_observed
7. report-evidence: mirror statuses; never invent or upgrade
```

### Invariants

1. **`model_verified` only from `labwired_verify` payload with `status: model_verified`.**  
2. **`hardware_observed` only from physical flash + captured serial/RTT marker match.**  
3. **`hardware_observed` is never upgraded to `model_verified`.**  
4. **`labwired_run` is observation only** — never a success claim.  
5. **Compile success is never a pass.**  
6. **Oracle must not be weakened** to force green; fix firmware or report honestly.  
7. **No OpenCode fork.** Pin remains deliberate.

---

## 3. Claim vocabulary (v0)

| Status | Source of truth | Allowed wording | Forbidden |
|--------|-----------------|-----------------|-----------|
| `model_verified` | `labwired_verify` → `status: model_verified` | model-verified on the twin / oracle green | “works on hardware”, “shipped” |
| `failed` | `labwired_verify` or hardware path contradiction | failed — behavior contradicted clause or faulted | soft-pass |
| `inconclusive` | missing evidence / runner failure | inconclusive — insufficient evidence | treat as green |
| `unsupported` | unmodeled surface / clause | unsupported — twin can’t check this | invent coverage |
| `hardware_observed` | C3 (or other) flash **and** serial/RTT marker match | hardware-observed on attached target | upgrade to `model_verified` |

Deprecated: `proven: true` is an alias for twin green only — still not hardware proof.

CI gate examples:

```bash
labwired assert-status model_verified < verify.json
# After package 3 lands, also:
# labwired assert-status hardware_observed < hw-result.json
# labwired score-verify --expect model_verified < verify.json
```

---

## 4. Tool allowlist

### 4.1 MCP tools (agent may call)

| Tool | Role in v0 | Claim impact |
|------|------------|--------------|
| `labwired_list` | Catalog boards / systems | none |
| `labwired_describe` | Pins, defaults, beachhead metadata | none |
| `labwired_validate` | Diagram / setup sanity | none (not a pass) |
| `labwired_run` | Observe twin serial / behavior | observation only |
| `labwired_verify` | Mandatory-oracle dispose | **only** path to `model_verified` |
| `labwired_inspect` | Evidence / result explanation | read-only |

### 4.2 CLI surfaces (agent / human)

| Command | Role |
|---------|------|
| `labwired` | Start OpenCode agent |
| `labwired doctor` | Install health |
| `labwired probe list\|chips\|flash\|reset\|doctor` | Physical + virtual attach |
| `labwired assert-status <expected> [file]` | Hard claim gate |
| `labwired score-verify` *(new, package 3)* | Structured score over verify JSON |
| `labwired serial-capture` *(new or lib-only, package 3)* | Capture UART for HW marker check |

### 4.3 Explicitly disallowed (v0 agent policy)

- Claiming pass from file reads, diffs, or “looks correct”  
- Weakening oracle clauses after a red verify to obtain green  
- Treating `labwired_run` output as `model_verified`  
- Treating probe flash success alone as `hardware_observed` (serial marker required)  
- Treating `hardware_observed` as `model_verified`  
- Invoking training / QLoRA / fine-tune tooling as part of the agent product  
- OpenOCD-first workflows as the primary path (probe-rs remains default backend)

`config/AGENTS.md` is the standing policy surface; package 4 tightens the tool allowlist language and status table to include `hardware_observed`.

---

## 5. Verification matrix

| Path | Preconditions | Inputs | Pass criterion | Status on pass | Status on fail |
|------|---------------|--------|----------------|----------------|----------------|
| **Twin verify** | sim + MCP healthy | `firmware_ref`, diagram, oracle | all clauses pass; no blocking gaps | `model_verified` | `failed` / `inconclusive` / `unsupported` |
| **Twin observe** | sim + MCP | firmware + run params | N/A (not a gate) | *(none — logs only)* | runner error → report inconclusive if used as evidence |
| **Offline claim gate** | checked-in JSON | verify artifact | `assert-status` match | CI green | CI red |
| **Gate 1 fixture** | repo only | `fixtures/gate1/artifacts/*` | broken→`failed`, fixed→`model_verified` | demo / harness | harness fail |
| **C3 HW promote** | model-green preferred; probe attached | ELF, chip id, serial port, marker | flash ok **and** marker in capture window | `hardware_observed` | flash fail / no marker → failed or inconclusive |
| **Score-verify** | any verify JSON | expected status (+ optional clause set) | structured match | exit 0 | exit non-zero |

### Ordering rule

1. Prefer **twin verify** to `model_verified` before desk promote.  
2. Desk promote may still run for demos when twin is unavailable, but claims must say **hardware_observed only**, never twin green.  
3. Reports always list twin status and HW status as **separate fields**.

---

## 6. Skill inventory

### 6.1 Existing (keep; tighten where noted)

| Skill | Gate / role | v0 change |
|-------|-------------|-----------|
| `verify-firmware` | Gate 1 — oracle dispose | Tighten: point to repair-loop skill; restate claim table |
| `diagnose-firmware` | Gate 1 — fail-first patch | Tighten: budget, same-oracle, handoff to repair-loop |
| `inspect-evidence` | Gate 1 — read-only | Unchanged (no package ownership) |
| `board-bringup` | Workflow | Unchanged |
| `scaffold-firmware` | Workflow | Unchanged |
| `report-evidence` | Workflow | Extend for dual claim (twin + HW) |
| `flash-firmware` | Workflow | Prefer sim green; then HW; no auto HW claim |

### 6.2 New skills (v0)

| Skill | Package | Job |
|-------|---------|-----|
| `firmware-repair-loop` | skills-repair | Constrained multi-step repair: capture red → patch ≤ budget → re-verify same oracle → stop conditions |
| `hw-promote` | skills-hw | After (or without) twin green: flash C3, serial-capture marker, emit `hardware_observed` only |

### 6.3 Skill interaction map

```
scaffold-firmware / user patch
        │
        ▼
verify-firmware ──red──► firmware-repair-loop ◄── diagnose-firmware (entry)
        │ green                    │
        ▼                          ▼ green
report-evidence              report-evidence
        │                          │
        └──── optional ──► hw-promote ──► flash-firmware + serial-capture
                                    │
                                    ▼
                           report-evidence (hardware_observed)
```

### 6.4 Repair-loop constraints (product)

| Parameter | v0 default | Notes |
|-----------|------------|-------|
| Max verify attempts after first red | 3 | Stop and report if still red |
| Patch scope | Minimal; single concern | No drive-by refactors |
| Oracle identity | Frozen after first red | Hash/path of oracle must match re-verify |
| Weakening oracle | Forbidden | Explicit skill hard rule |
| Escalation | `unsupported` / `inconclusive` with gaps | Do not spin |

---

## 7. ESP32-C3 promote path

Beachhead hardware for v0 **promote** (not twin beachhead exclusivity):

### Flow

```
[optional] model_verified on twin for same behavior marker
        │
        ▼
labwired probe list / doctor   # ESP USB-JTAG / CMSIS-DAP / etc.
        │
        ▼
labwired probe flash <elf> --chip <esp32c3-id>
        │
        ▼
serial-capture (window T seconds, port auto or explicit)
        │
        ▼
marker match?  e.g. LABWIRED_OK or fixture-defined string
        │
   yes  │  no
        ▼  ▼
hardware_observed   failed / inconclusive
```

### Rules

1. Flash alone ≠ `hardware_observed`.  
2. Marker must appear in **captured** serial (or RTT if later supported) within the window.  
3. Report must include: chip, probe selector (if any), ELF path/digest if known, marker, capture excerpt ref.  
4. **Never** map this path to `model_verified`.  
5. If twin was green and HW is red (or vice versa), report **both** honestly — do not reconcile by upgrading either status.

### Fixture: `fixtures/c3-baseline/`

Offline + protocol shape for C3 promote (package 4):

| Artifact | Purpose |
|----------|---------|
| `README.md` / protocol notes | Human story: sim optional → flash → marker |
| `oracle.json` | Twin oracle for same marker (when twin path used) |
| `diagram.json` | C3-oriented diagram when catalog supports it |
| `artifacts/*.json` | Claim shapes: twin failed/green; HW observed/fail |
| serial marker constant | Shared with Gate 1 style (`LABWIRED_OK` or C3-specific) |

---

## 8. Trajectory / evidence protocol (v0)

For eval and CI honesty (not model training):

| Concept | Definition |
|---------|------------|
| Trajectory | Ordered steps: tool call or skill action + result digest |
| Step kinds | `verify`, `patch`, `flash`, `serial_capture`, `report` |
| Required fields | `ts`, `kind`, `inputs_ref`, `status_or_null`, `notes` |
| Schema home | `fixtures/trajectories/README.md` (+ example JSON in package 4) |

Trajectories are **fixtures for harness and demos**, not a training corpus in v0. No QLoRA pipeline consumes them.

---

## 9. Lib and harness extensions

| Component | Package | Responsibility |
|-----------|---------|----------------|
| `lib/score-verify.sh` | libs-tests | Parse verify JSON; exit 0 iff expected status (and optional required fields) |
| `lib/serial-capture.sh` | libs-tests | Capture UART for duration; grep marker; emit small result JSON |
| `tests/harness.sh` | libs-tests | Extend: skill inventory (+2), assert-status includes `hardware_observed`, score-verify unit tests, serial-capture dry-run / fixture tests |
| `bin/labwired` | libs-tests | Wire `assert-status` to accept `hardware_observed`; optional `score-verify` / `serial-capture` subcommands |
| `lib/assert-status.sh` | libs-tests | Expand allowed status enum with `hardware_observed` |

Non-goals for libs-tests: full RTT stack, multi-board matrix, live ESP-IDF install inside harness (use fixtures / mocks when no hardware).

---

## 10. Implementation packages (exactly four, non-overlapping)

Owned files are exclusive to each package. Do not edit another package’s owned files without a follow-up design change.

### Package 1 — `skills-repair`

**Summary:** Constrained repair-loop skill plus tighten fail-first diagnose/verify skills so the agent cannot soft-pass or weaken oracles.

**Owned files:**

- `skills/firmware-repair-loop/SKILL.md` *(new)*
- `skills/diagnose-firmware/SKILL.md`
- `skills/verify-firmware/SKILL.md`

**Deliverables:**

- Repair budget, same-oracle rule, stop conditions  
- Clear handoff: verify ↔ repair-loop ↔ diagnose  
- Claim vocabulary pointers unchanged in spirit; repair-loop cites them  

**Does not touch:** HW skills, libs, fixtures, AGENTS tool table (beyond what those skill texts already say).

---

### Package 2 — `skills-hw`

**Summary:** Hardware promote skill and dual-claim reporting; flash skill stays sim-first and never auto-upgrades claims.

**Owned files:**

- `skills/hw-promote/SKILL.md` *(new)*
- `skills/flash-firmware/SKILL.md`
- `skills/report-evidence/SKILL.md`

**Deliverables:**

- C3 promote procedure wired to flash + serial marker  
- `hardware_observed` in report vocabulary  
- Explicit ban on upgrading HW → `model_verified`  

**Does not touch:** repair skills, lib implementations, c3 fixtures tree (consumes them once package 4 lands).

---

### Package 3 — `libs-tests`

**Summary:** Deterministic scoring and serial capture libraries, harness coverage, and CLI wiring for new statuses/subcommands.

**Owned files:**

- `lib/score-verify.sh` *(new)*
- `lib/serial-capture.sh` *(new)*
- `lib/assert-status.sh` *(extend enum)*
- `tests/harness.sh`
- `bin/labwired` *(subcommand wiring only as needed)*

**Deliverables:**

- `score-verify` usable offline on fixtures  
- `serial-capture` dry-run / fixture mode for CI without hardware  
- Harness asserts new skills exist once packages 1–2 land (coordinate inventory list)  
- `assert-status` accepts `hardware_observed`  

**Does not touch:** skill markdown bodies, `fixtures/c3-baseline/*`, `config/AGENTS.md` prose.

---

### Package 4 — `fixtures-protocol`

**Summary:** C3 baseline fixtures, AGENTS tool allowlist + status table, trajectory schema documentation.

**Owned files:**

- `fixtures/c3-baseline/*` *(new tree)*
- `config/AGENTS.md`
- `fixtures/trajectories/README.md` *(new; schema + examples)*

**Deliverables:**

- Offline claim shapes for twin + HW paths  
- AGENTS.md: tool allowlist, `hardware_observed`, repair-loop + hw-promote skills  
- Trajectory README with step schema for demos/eval  

**Does not touch:** skill bodies (except listing names in AGENTS), lib shell implementations, harness logic (fixtures only consumed by harness owned by package 3).

---

### Package dependency order (implementation)

```
4 (fixtures + AGENTS)  ──┐
1 (skills-repair)      ──┼──► 3 (libs-tests harness inventory / gates)
2 (skills-hw)          ──┘
```

Packages 1, 2, and 4 can start in parallel. Package 3 should land last or in lockstep so skill inventory and status enums match.

---

## 11. Success criteria

1. **Claim gate:** `model_verified` is asserted only from `labwired_verify` status; harness and AGENTS forbid other paths.  
2. **Repair loop:** Agent path documents fail-first → ≤3 re-verifies → same oracle; no oracle weakening.  
3. **HW honesty:** C3 flash + serial marker yields `hardware_observed` only; never upgraded to `model_verified` in skills, AGENTS, or reports.  
4. **Skill inventory:** `firmware-repair-loop` and `hw-promote` exist; harness inventory list updated; opencode skill allowlist includes both (allowlist file updates may ride package 4 AGENTS + install notes; if `config/opencode.json` needs skill keys, treat as package 4 adjacent follow-up or minimal package 4 edit if required for allowlist consistency — preferred: package 4 owns `config/AGENTS.md` only; opencode skill keys updated in the same PR as skills 1–2 by implementer with design awareness, without expanding package file ownership beyond the four lists).  
5. **Offline proof:** Gate 1 remains green; C3 baseline fixtures gate twin/HW claim shapes via `assert-status` / `score-verify`.  
6. **Libs:** `score-verify` and `serial-capture` (fixture mode) covered by `tests/harness.sh`.  
7. **No training:** Repo v0 has no QLoRA, SFT, or fine-tune entrypoints.  
8. **Demo story:** Documented path: draft → fail → repair → `model_verified` → optional C3 `hardware_observed` → dual report.

*Note on opencode skill permissions:* Adding keys under `config/opencode.json` / `opencode.airgap.json` is required when new skills ship. Implementers should update those keys in the PR that introduces the skill directories (packages 1 and 2), even though those JSON files are not listed as exclusive owned files — they are shared wiring. Do not invent a fifth package.

---

## 12. Out of scope (v0)

| Out | Why |
|-----|-----|
| Fine-tuned Zephyr / domain models | Beachhead is agent + oracle, not weights |
| QLoRA / training data pipelines | Trajectories are fixtures only |
| Full multi-board HW matrix | C3 promote is the HW beachhead |
| OpenOCD-first product path | probe-rs remains default |
| HIL product / time-travel on silicon | Separate product line |
| Forking OpenCode | Harness only |
| Automatic sim→HW claim upgrade | Violates claim rules |
| Enterprise SSO / Helm | Packaging elsewhere |
| Weakening oracle as “fix strategy” | Forbidden |
| RTT-only promote as sole C3 path | Serial marker first; RTT later optional |
| Live hardware required for CI green | Fixtures + mocks for harness |

---

## 13. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Model soft-passes from compile | AGENTS + skills + assert-status fail-closed |
| Agent weakens oracle mid-loop | Repair-loop freezes oracle identity |
| Users confuse HW with twin green | Dual fields in report-evidence; distinct status enum |
| No C3 on CI runners | Fixture mode serial-capture + checked-in HW JSON shapes |
| Skill inventory drift | harness.sh inventory assert |
| Scope creep into training | Explicit out-of-scope; no package owns training code |

---

## 14. Spec self-review

- Exactly **four** packages with **non-overlapping owned files**.  
- Architecture, tool allowlist, verification matrix, skill inventory, C3 promote, success criteria, out-of-scope are all present.  
- Claim rules match product: oracle disposes; HW is `hardware_observed` only.  
- No implementation performed in this design commit beyond this document.  
- Builds on Gate 1 and probe-rs designs without replacing them.

---

## 15. Return plan schema (for implementers)

```json
{
  "design_path": "/Users/andrii/Projects/labwired-agent/docs/superpowers/specs/2026-07-29-verified-firmware-agent-v0-design.md",
  "packages": [
    {
      "id": "skills-repair",
      "files": [
        "skills/firmware-repair-loop/SKILL.md",
        "skills/diagnose-firmware/SKILL.md",
        "skills/verify-firmware/SKILL.md"
      ],
      "summary": "Constrained repair-loop skill; tighten diagnose/verify for fail-first, same-oracle, budgeted re-verify."
    },
    {
      "id": "skills-hw",
      "files": [
        "skills/hw-promote/SKILL.md",
        "skills/flash-firmware/SKILL.md",
        "skills/report-evidence/SKILL.md"
      ],
      "summary": "C3 promote skill; flash stays sim-first; reports dual claims including hardware_observed."
    },
    {
      "id": "libs-tests",
      "files": [
        "lib/score-verify.sh",
        "lib/serial-capture.sh",
        "lib/assert-status.sh",
        "tests/harness.sh",
        "bin/labwired"
      ],
      "summary": "Scoring + serial-capture libs, hardware_observed in assert-status, harness and CLI wiring."
    },
    {
      "id": "fixtures-protocol",
      "files": [
        "fixtures/c3-baseline/*",
        "config/AGENTS.md",
        "fixtures/trajectories/README.md"
      ],
      "summary": "C3 baseline fixtures, AGENTS tool allowlist + status table, trajectory schema docs."
    }
  ],
  "success_criteria": [
    "model_verified only from labwired_verify status model_verified",
    "Repair loop: fail-first, same oracle, budgeted attempts, no weakening",
    "C3 flash+serial marker => hardware_observed only; never upgraded to model_verified",
    "New skills firmware-repair-loop and hw-promote present and harness-asserted",
    "Gate 1 + c3-baseline offline claim shapes pass assert-status/score-verify",
    "score-verify and serial-capture (fixture mode) covered by tests/harness.sh",
    "No QLoRA/SFT/fine-tune entrypoints in v0",
    "Documented dual-path demo: twin green then optional HW observed"
  ]
}
```
