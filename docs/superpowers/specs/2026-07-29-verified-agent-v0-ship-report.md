# Ship report: LabWired verified agent v0

**Date:** 2026-07-29  
**Repo:** `/Users/andrii/Projects/labwired-agent`  
**Version:** `0.2.0` (`VERSION`)  
**Design:** [`2026-07-29-verified-firmware-agent-v0-design.md`](./2026-07-29-verified-firmware-agent-v0-design.md)  
**Ship ready:** **yes** (`ship_ready=true`)

---

## Executive summary

Beachhead A — **verified firmware-engineering agent v0** for FW engineers — is implemented across all four planned packages (4/4). Offline claim gates, harness coverage, constrained repair-loop and board-agnostic HW-promote skills, scoring/serial-capture libs, and protocol docs are in place. Live twin verify remains an environment gap; an optional desk canary (ESP32-C3) was used only to exercise flash/serial tooling and is **not** product focus.

**Disposition:** ship the kit. Twin path = product demo (Gate 1 offline; live sim when installed). Physical boards = optional canaries for tooling. Defer FirmwareBench, Zephyr retrieval, QLoRA, MCP expansion.

---

## Package implementation (4/4)

| Package id | Summary | Status |
|------------|---------|--------|
| `skills-repair` | Constrained repair-loop; diagnose/verify fail-first, same-oracle, budgeted re-verify | **ok** |
| `skills-hw` | Board-agnostic promote skill; sim-first; dual claims including `hardware_observed` | **ok** |
| `libs-tests` | Scoring + serial-capture libs; `hardware_observed` in assert-status; harness + CLI | **ok** |
| `fixtures-protocol` | Protocol fixtures + optional HW canary fixture; AGENTS matrix; trajectory schema | **ok** |

### Package 1 — `skills-repair`

| Path | Present |
|------|---------|
| `skills/firmware-repair-loop/SKILL.md` | yes |
| `skills/diagnose-firmware/SKILL.md` | yes (fail-first → handoff to repair-loop) |
| `skills/verify-firmware/SKILL.md` | yes (dispose-only; red → repair-loop) |

Invariants encoded in skills:

- Max **3** repairs after first red; then **abstain**
- **Same oracle** frozen; no weakening
- **Never LLM-as-judge**; deterministic score  
  `score = 100*oracle + 20*build - 5*warnings - 2*lines`
- `model_verified` only from `labwired_verify` → `status: model_verified`

### Package 2 — `skills-hw`

| Path | Present |
|------|---------|
| `skills/hw-promote/SKILL.md` | yes |
| `skills/flash-firmware/SKILL.md` | yes (sim/probe first; no auto HW claim) |
| `skills/report-evidence/SKILL.md` | yes (dual twin + HW fields) |

Invariants:

- Flash + **captured** serial/RTT marker → `hardware_observed` only
- **Never** upgrade `hardware_observed` → `model_verified`
- Prefer twin green before desk promote; demos may HW-only with honest dual claims

### Package 3 — `libs-tests`

| Path | Present |
|------|---------|
| `lib/score-verify.sh` | yes |
| `lib/serial-capture.sh` | yes (fixture mode; no pyserial required) |
| `lib/assert-status.sh` | yes (`hardware_observed` + twin statuses) |
| `tests/harness.sh` | yes |
| `bin/labwired` | yes (`assert-status`, `score-verify`, `serial-capture` subcommands) |

### Package 4 — `fixtures-protocol`

| Path | Present |
|------|---------|
| `fixtures/c3-baseline/*` | yes (`platformio.ini`, `src/main.cpp`, `README.md`) |
| `config/AGENTS.md` | yes (status table, repair budget, hw-promote, tool allowlist) |
| `fixtures/trajectories/README.md` | yes (+ `schema.json`; QLoRA deferred) |

---

## Success criteria

| # | Criterion | Result |
|---|-----------|--------|
| 1 | `model_verified` only from `labwired_verify` status `model_verified` | **pass** — AGENTS + verify/repair/report skills; assert-status rejects HW as twin green |
| 2 | Repair loop: fail-first, same oracle, budgeted attempts, no weakening | **pass** — diagnose + firmware-repair-loop encode budget 3, freeze oracle, abstain |
| 3 | C3 flash+serial marker ⇒ `hardware_observed` only; never upgraded to `model_verified` | **pass** (policy + harness); live C3 marker match **failed** (gap) |
| 4 | New skills `firmware-repair-loop` and `hw-promote` present and harness-asserted | **pass** — skills listed and asserted in `tests/harness.sh` |
| 5 | Gate 1 + c3-baseline offline claim shapes pass assert-status/score-verify | **pass** (Gate 1 offline); C3 live serial not green (gap) |
| 6 | `score-verify` and `serial-capture` (fixture mode) covered by harness | **pass** |
| 7 | No QLoRA/SFT/fine-tune entrypoints in v0 | **pass** — trajectories docs only; AGENTS forbids training tools |
| 8 | Documented dual-path demo: twin green then optional HW observed | **pass** — AGENTS matrix + report-evidence dual-claim footer + design |

---

## Verify results (this ship)

### Harness

| Field | Value |
|-------|--------|
| `harness_pass` | **true** |
| Evidence | `EXIT_CODE=0`, message: `all harness tests passed` |

Covered surfaces (non-exhaustive): skill inventory including `firmware-repair-loop` / `hw-promote`; assert-status accept/reject matrix; Gate 1 fixed/broken artifacts; score-verify matrix and fixtures; serial-capture fixture match/miss/`LABWIRED_SERIAL_FIXTURE`.

### Claim gate (offline)

| Field | Value |
|-------|--------|
| `claim_gate_pass` | **true** |
| Broken | `assert-status: ok (failed)` on `fixtures/gate1/artifacts/broken.verify.json` |
| Fixed | `assert-status: ok (model_verified)` on `fixtures/gate1/artifacts/fixed.verify.json` |

Note: Gate 1 `fixed.verify.json` is a **demo artifact** for offline claim shape — not live twin proof. Payload note field states live `model_verified` requires `labwired_verify` against a healthy twin.

### Skills presence

| Skill | Path | Harness |
|-------|------|---------|
| `firmware-repair-loop` | `skills/firmware-repair-loop/SKILL.md` | asserted |
| `hw-promote` | `skills/hw-promote/SKILL.md` | asserted |

### C3 desk path

| Field | Value |
|-------|--------|
| `c3_status` | **fail** |
| Port | `/dev/cu.usbmodem11301` present |
| Build | `pio run -d fixtures/c3-baseline` → SUCCESS |
| Upload | SUCCESS — `Chip is ESP32-C3 (QFN32) (revision v0.4)` |
| Serial-capture | `matched: false`, marker `LABWIRED_C3_BASELINE_OK`, `bytes_captured: 0`, `status: failed` |
| Post-reset raw | ROM `SPI_FAST_FLASH_BOOT` + entry `0x403cc710`; `HAS_MARKER` False |

**Interpretation:** flash path works; application UART marker was not observed on the captured port (likely Serial not on the USB-CDC endpoint used, or wrong interface). Per policy this is **not** `hardware_observed` and must not be upgraded to any twin green claim.

### Tooling inventory (verify host)

| Tool | Status |
|------|--------|
| PlatformIO (`pio`) | present |
| esptool | present |
| probe-rs | **missing** (labwired probe backend unavailable) |
| west / Zephyr | **missing** |
| labwired-sim / live sim CLI | **missing** (no live `labwired_verify` → `model_verified`) |
| system python3 pyserial | absent (not required by `serial-capture.sh`) |

---

## Gaps (documented; non-blocking for kit ship)

1. **probe-rs not installed** — labwired probe backend unavailable; C3 flash used PlatformIO/esptool fallback (allowed by `hw-promote`).
2. **west / Zephyr toolchain absent** — no Zephyr beachhead wire in this environment.
3. **labwired-sim / live sim CLI absent** — cannot exercise live `labwired_verify` for real `model_verified`; Gate 1 fixed JSON remains offline demo only.
4. **C3 baseline serial marker not observed** — PlatformIO flash OK; `LABWIRED_C3_BASELINE_OK` never seen on `/dev/cu.usbmodem11301` (`bytes_captured: 0`; ROM boot text only). Likely Serial not on USB CDC for this board/USB path — needs CDC enable, correct port, or secondary UART pin map.
5. **Gate 1 `model_verified` is offline claim shape**, not live twin proof.
6. **system python3 has no pyserial** — optional alternate monitors only; `serial-capture.sh` uses termios/select.

---

## Dual-path demo (v0)

Documented and policy-enforced path:

```text
1) Twin path (preferred when sim available)
   diagnose / repair-loop → labwired_verify → model_verified
   Offline substitute: fixtures/gate1/artifacts/fixed.verify.json + assert-status

2) Optional desk promote (ESP32-C3)
   hw-promote → flash + serial-capture(marker) → hardware_observed only
   Never map HW green to model_verified

3) report-evidence
   twin_status:       <...>
   hardware_status:   <...>
   (separate fields; honest divergence)
```

v0 demo that ships green offline: **Gate 1 claim gate** (broken → failed, fixed → model_verified). Live twin green and live C3 `hardware_observed` are environment follow-ups, not kit blockers.

---

## Explicit non-goals (v0 held)

- No QLoRA / SFT / fine-tune / RLHF entrypoints
- No OpenCode fork
- No soft-pass from compile, source review, or `labwired_run`
- No auto sim→hardware status upgrade
- Trajectories are fixtures/schema only, not a training pipeline

---

## ship_ready decision

| Gate | Required | Actual |
|------|----------|--------|
| `harness_pass` | true | **true** |
| New skills exist (`firmware-repair-loop`, `hw-promote`) | true | **true** |
| Claim gate ok | true | **true** (`claim_gate_pass`) |
| C3 live green | not required if gap documented | **fail** — documented |

**`ship_ready = true`**

C3 fail does not block ship of the verified-agent kit; it is an environment/HW-observation gap for the beachhead promote demo.

---

## Next steps

1. **FirmwareBench seed** — offline/online eval tasks aligned with Gate 1 + repair-loop budget.
2. **Zephyr version-aware retrieval + west** — Pro beachhead for FW engineers (not a hobby MCU kit).
3. **QLoRA later** — trajectories under `fixtures/trajectories/`; training post-v0.
4. **MCP tool expansion** — structured search/kconfig/dt tools; dispose remains sole path to `model_verified`.
5. **labwired-sim install** — live twin verify for real (non-fixture) `model_verified`.
6. **probe-rs install** — preferred multi-probe flash path.
7. **Optional canary polish** — serial-observe on whatever board is on the desk (dev-only; not product).

---

## Artifact index

| Artifact | Path |
|----------|------|
| Design | `docs/superpowers/specs/2026-07-29-verified-firmware-agent-v0-design.md` |
| This ship report | `docs/superpowers/specs/2026-07-29-verified-agent-v0-ship-report.md` |
| Agent protocol | `config/AGENTS.md` |
| Harness | `tests/harness.sh` |
| Gate 1 fixtures | `fixtures/gate1/artifacts/{broken,fixed}.verify.json` |
| C3 baseline | `fixtures/c3-baseline/` |
| Trajectory schema | `fixtures/trajectories/schema.json` |

---

## Changelog note (v0 ship)

Implemented packages for verified firmware agent beachhead: constrained `firmware-repair-loop`, `hw-promote` with strict claim split, `score-verify` / `serial-capture` libs and CLI, AGENTS dual-path matrix, C3 baseline fixture, harness coverage for offline claim gates. Live twin and live C3 marker observation tracked as follow-on gaps.
