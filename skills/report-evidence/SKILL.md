---
name: report-evidence
description: >-
  Turn labwired_verify JSON and gaps into a human or CI report. Never invent a
  pass; quote status, gaps, and evidence_ref only as returned. Supports dual
  claims: model_verified (twin) and hardware_observed (desk HW).
license: MIT
compatibility: opencode
metadata:
  gate: "workflow"
  labwired: "true"
---

# Report evidence

## Hard rule

The report **mirrors the oracle** (and, when present, the hardware capture).
You do not upgrade status.

- If twin `status` is not `model_verified`, the report must not say the firmware is
  model-verified.
- If HW path did not flash **and** match a serial/RTT marker, do not claim
  `hardware_observed`.
- Never upgrade `hardware_observed` → `model_verified` (or invent twin green
  from desk HW). Quote payloads only as returned.

## Procedure

1. Take saved verify and/or HW result payloads (file or last tool result):
   `status`, `gaps`, `evidence_ref`, clause results, diagnosis; for HW: chip,
   tool path, marker, capture excerpt.
2. Structure the report:
   - **Twin status** — exact enum value from `labwired_verify` (if run)
   - **Hardware status** — exact enum from promote path (if run); omit if not run
   - **Firmware / diagram / oracle refs** when present
   - **Gaps** — list blocking items; do not omit
   - **Evidence** — `evidence_ref` / capture excerpt only if present; say if missing
   - **Allowed claim** — one sentence per path from claim vocabulary
3. For CI, prefer machine-checkable form:
   ```bash
   labwired assert-status model_verified < verify.json
   # when HW result JSON is available (assert-status supports hardware_observed):
   # labwired assert-status hardware_observed < hw-result.json
   ```
4. Optional: load `inspect-evidence` when explaining digests/signatures.
5. Never invent signatures, digests, or a green status.

## Claim vocabulary

| Status | Allowed wording |
|--------|-----------------|
| `model_verified` | model-verified (sim/oracle only) |
| `hardware_observed` | hardware-observed on attached target (flash + serial/RTT marker) |
| `failed` | failed — behavior contradicted oracle or faulted |
| `inconclusive` | inconclusive — missing evidence or runner failure |
| `unsupported` | unsupported — unmodeled surface |

Deprecated: `proven: true` is twin-green alias only — never hardware proof.

## Verification matrix (template)

Fill one row per path that actually ran. Leave cells blank or `n/a` if not run.
Do not mark pass without the matching payload.

| Path | Preconditions | Inputs | Pass criterion | Status on pass | Status on fail / gap | Evidence refs |
|------|---------------|--------|----------------|----------------|----------------------|---------------|
| Twin verify | sim + MCP healthy | `firmware_ref`, diagram, oracle | all clauses pass; no blocking gaps | `model_verified` | `failed` / `inconclusive` / `unsupported` | |
| Twin observe | sim + MCP | firmware + run params | *(not a gate — logs only)* | *(none)* | runner error → inconclusive if used as evidence | |
| Offline claim gate | checked-in JSON | verify / HW artifact | `assert-status` match | CI green | CI red | |
| C3 / desk HW promote | model-green preferred; target attached | ELF, chip id, serial port, marker | flash ok **and** marker in capture window | `hardware_observed` | flash fail / no marker → failed or inconclusive | |
| Score-verify (optional) | any verify JSON | expected status (+ clauses) | structured match | exit 0 | exit non-zero | |

### Dual-claim footer (copy when both paths ran)

```text
twin_status:       <model_verified|failed|inconclusive|unsupported|not_run>
hardware_status:   <hardware_observed|failed|inconclusive|not_run>
marker:            <string or n/a>
notes:             <honest divergence; never reconcile by upgrading either status>
```

## Related skills

- `verify-firmware` — twin dispose
- `hw-promote` — desk flash + serial marker → `hardware_observed`
- `flash-firmware` — flash backends only (no auto HW claim)
- `inspect-evidence` — read-only evidence explanation
