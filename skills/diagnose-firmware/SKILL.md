---
name: diagnose-firmware
description: >-
  Reproduce a firmware defect under a behavioral oracle, propose a minimal
  repair, and re-run model verification. Do not edit until the failure is
  captured by labwired_verify.
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

## Procedure

1. Restate the user symptom as a behavioral oracle clause.
2. Obtain `firmware_ref` for the current tree (compile if needed).
3. Call `labwired_verify` and capture the red/unsupported/inconclusive result.
4. Inspect serial, diagnosis, oracle_results, and gaps.
5. Propose a **minimal** repair plan; wait for human approval before large edits when the session supports approvals.
6. Apply the patch, recompile, re-verify with the **same** oracle.
7. Summarize: before status, after status, evidence_ref if any, remaining risks.

## Claim vocabulary

Same as verify-firmware. Never claim hardware confirmation from simulation alone.
