---
name: prove
description: >-
  Twin dispose: labwired_verify with oracle, budgeted repair (max 3), dual-claim
  evidence report. model_verified ONLY from labwired_verify. On red fail-first
  then repair; never soft-pass or invent green.
license: MIT
compatibility: opencode
metadata:
  gate: "1"
  labwired: "true"
  pack: "prove"
  aliases: "verify-firmware,diagnose-firmware,firmware-repair-loop,report-evidence,inspect-evidence"
---

# Prove (verify · repair · evidence)

**Pack** of: verify-firmware · diagnose-firmware · firmware-repair-loop ·
report-evidence · inspect-evidence.

## Hard rules

1. **`model_verified` only** when `labwired_verify` returns `status: model_verified`.  
   Compile, `labwired_run`, source review, debugger, flash — **never** enough.  
2. **Sim not forced.** If twin tools missing, use debugger/probe and report
   observations **without** the `model_verified` label.  
3. **Never LLM-as-judge.** Never weaken the oracle to force green.  
4. **Never upgrade** `hardware_observed` → `model_verified`.

## Claim vocabulary

| Status | Meaning |
|--------|---------|
| `model_verified` | Twin oracle pass (`labwired_verify` only) |
| `failed` | Behavior wrong or fault |
| `inconclusive` | Missing evidence / runner fail |
| `unsupported` | Unmodeled surface |
| `abstain` | Repair budget exhausted or blocking gaps |
| `hardware_observed` | Desk only — use **desk-hw** pack |

## A. Verify (dispose)

1. `firmware_ref` + valid diagram + oracle (≥1 behavioral clause).  
2. Call `labwired_verify`.  
3. Report `status`, `gaps`, `evidence_ref`.  
4. **On green** → section C (report-evidence).  
5. **On red** → section B (diagnose + repair ≤3).

## B. Diagnose + repair (max 3)

1. **Fail-first:** capture failing verify **before** editing.  
2. Freeze oracle identity; never rewrite clauses.  
3. Loop while `repairs_used < 3` and not green:  
   - localize (serial, diagnosis, gaps)  
   - minimal single-concern patch  
   - compile → new `firmware_ref`  
   - `labwired_verify` same oracle  
   - increment repairs  
4. Stop: green → report; or **abstain** with gaps (do not spin).

**Score (deterministic):**  
`score = 100 * oracle + 20 * build - 5 * warnings - 2 * lines`  
Oracle dominates.

## C. Report evidence (dual claim)

Structure every report:

```text
twin_status:       <model_verified|failed|inconclusive|unsupported|not_run>
hardware_status:   <hardware_observed|failed|inconclusive|not_run>
twin_evidence:     <evidence_ref or missing>
```

- Do not invent green. Quote tool payloads only.  
- Helper: `python3 scripts/report-evidence.py --twin verify.json --out report.md`  
- CI: `labwired assert-status model_verified < verify.json`

## D. Inspect evidence (read-only)

Explain `evidence_ref` / digests / allowed claims from payload only.  
Never invent signatures. Missing file → say missing.

## Tools

`labwired_verify` (dispose) · `labwired_run` (observe only) · `labwired_inspect` ·
`labwired_validate` · `scripts/report-evidence.py`
