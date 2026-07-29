---
name: diagnose-firmware
description: >-
  Reproduce a firmware defect under a behavioral oracle (fail-first), then hand
  off to firmware-repair-loop for budgeted repair (max 3) and same-oracle
  re-verify. Do not edit until the failure is captured by labwired_verify.
license: MIT
compatibility: opencode
metadata:
  gate: "1"
  labwired: "true"
---

# Diagnose firmware

## Hard rule

A defect is not diagnosed until you have a **failing** `labwired_verify` (or a clear
`unsupported`/`inconclusive` with gaps) **before** editing. A defect is not fixed until
the **same** oracle returns `status: model_verified` after the patch.

Repair is **budgeted**: after the first red, at most **3** repair iterations.
When the budget is exhausted or gaps block progress, **abstain** — do not keep
patching. Prefer the dedicated skill `firmware-repair-loop` for the constrained
patch → compile → re-verify cycle.

## Procedure

1. Restate the user symptom as a behavioral oracle clause.
2. Obtain `firmware_ref` for the current tree (compile if needed).
3. Call `labwired_verify` and capture the red/unsupported/inconclusive result.
4. Inspect serial, diagnosis, oracle_results, and gaps.
5. **Handoff to `firmware-repair-loop`** with: frozen oracle identity, verify
   payload, `firmware_ref`, diagram, and diagnosis. That skill owns:
   - max **3** repairs after first red
   - same-oracle re-verify (never weaken the oracle)
   - deterministic score (never LLM-as-judge)
   - tool allowlist and **abstain** on budget/gaps
6. If the session requires human approval for large edits, obtain it before the
   loop applies non-trivial patches; keep each repair minimal.
7. Summarize: before status, after status (or `abstain`), repairs used (≤ 3),
   evidence_ref if any, remaining risks.

## Claim vocabulary

Same as `verify-firmware`, plus `abstain` when the repair loop stops without a
green oracle (max repairs or blocking gaps). Never claim hardware confirmation
from simulation alone. Never claim `model_verified` without
`labwired_verify` → `status: model_verified`.
