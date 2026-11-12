---
name: prove
description: >-
  Twin dispose: labwired_verify with oracle, three total attempts, dual-claim
  evidence report. model_verified ONLY from labwired_verify. On red fail-first
  then repair; never soft-pass or invent green.
license: MIT
metadata:
  gate: "1"
  labwired: "true"
  pack: "prove"
---

# Prove (verify · repair · evidence)

Twin dispose: oracle verify, budgeted repair, dual-claim evidence.

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
| `hardware_observed` | Desk only — use **desk-hw** pack |

## A. Verify (dispose)

1. `firmware_ref` + valid diagram + oracle (≥1 behavioral clause).  
2. Call `labwired_verify`.  
3. Report `status`, `gaps`, `evidence_ref`.  
4. **On green** → section C (report-evidence).  
5. **On red** → section B (diagnose + repair within three total attempts).

## B. Diagnose + repair (three total attempts)

1. **Fail-first:** the initial implementation and failing verify are attempt one; capture that failure **before** repairing.
2. Freeze oracle identity; never rewrite clauses.  
3. Make at most two repair patches after the initial red, stopping after three total edit-and-test attempts:
   - localize (serial, diagnosis, gaps)  
   - minimal single-concern patch  
   - compile → new `firmware_ref`  
   - `labwired_verify` same oracle  
4. Stop: green → report; otherwise preserve the tool status and gaps (do not spin). In a user-facing `develop` report, map exhausted repair with no green to `failed`, or to `blocked` only for an actual external blocker.

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
