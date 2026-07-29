---
name: firmware-repair-loop
description: >-
  Constrained multi-step firmware repair: capture a failing oracle, apply
  minimal patches, re-verify with the same oracle, stop at max 3 repairs or
  abstain. Deterministic scoring only — never LLM-as-judge.
license: MIT
compatibility: opencode
metadata:
  gate: "oracle"
  labwired: "true"
---

# Firmware repair loop

## Hard rules

1. **Max 3 repair iterations.** After the first failing (red) verify, you may
   patch and re-verify at most **3** times. On the 4th still-red outcome, or when
   the budget is exhausted, **abstain** — do not keep patching.
2. **Same oracle.** Freeze the oracle (clauses, path, or content hash) after the
   first red. Re-verify with that exact oracle. Never weaken, drop, or rewrite
   clauses to force a green.
3. **Never LLM-as-judge.** Pass/fail and ranking come only from `labwired_verify`
   status, compile/build results, and the deterministic score below. Do not use
   model prose, “looks correct,” or a second agent to mint status.
4. **`model_verified` only from the tool.** You may claim model-verified only when
   `labwired_verify` returns `status: model_verified`. Compile success, source
   review, and `labwired_run` observation are never enough.

## Tool allowlist

During this loop use **only** these action classes:

| Action | Purpose |
|--------|---------|
| `search` | Locate symbols, call sites, configs related to the failure |
| `read` | Read source, logs, verify payload, gaps, diagnosis |
| `patch` | Minimal single-concern edit; no drive-by refactors |
| `compile` | Rebuild to obtain a fresh `firmware_ref` |
| `verify` | `labwired_verify` with the **frozen** oracle |
| `inspect` | Inspect evidence / gaps / verify payload (read-only) |
| `finish` | Exit loop on `model_verified` (or clear terminal status + handoff) |
| `abstain` | Stop when max repairs reached, blocking gaps, or unsupported surface |

Do not invent tools outside this allowlist. Prefer LabWired MCP verify/inspect
over free-form shell claims of success.

## Scoring (deterministic; never LLM-as-judge)

When choosing among candidate patches or reporting progress, rank by:

```text
score = 100 * oracle + 20 * build - 5 * warnings - 2 * lines
```

| Term | Definition |
|------|------------|
| `oracle` | `1` if `labwired_verify` → `status: model_verified`, else `0` |
| `build` | `1` if compile succeeds and yields a `firmware_ref`, else `0` |
| `warnings` | Non-fatal compiler/tool warning count (integer ≥ 0) |
| `lines` | Net lines changed in the repair (absolute churn; prefer smaller) |

Higher score is better. **Oracle dominates.** A green oracle always outranks a
clean build with a red oracle. Do not substitute subjective quality for this
formula.

## Claim vocabulary

Use exactly these statuses (same spirit as `verify-firmware`, plus abstain):

| Status | Meaning |
|--------|---------|
| `model_verified` | `labwired_verify` returned `status: model_verified` |
| `failed` | Behavior contradicted the oracle or the firmware faulted |
| `inconclusive` | Required evidence missing or runner failed |
| `unsupported` | Unmodeled instruction / MMIO / peripheral / clause |
| `abstain` | Loop stopped: max repairs, blocking gaps, or cannot proceed honestly |

Never upgrade simulation to hardware confirmation. Never mint `model_verified`
from compile, `labwired_run`, or LLM judgment.

## Procedure

1. **Capture red (or gap).** Enter only with a failing / non-green
   `labwired_verify` (or clear `unsupported` / `inconclusive` with gaps) under a
   stated behavioral oracle. Record `firmware_ref`, diagram, oracle identity,
   `status`, clause results, diagnosis, and `gaps`.
2. **Freeze oracle.** Note oracle path or hash; all re-verifies use it unchanged.
3. **Budget.** Set `repairs_used = 0`. Max repairs = **3**.
4. **Loop** while `repairs_used < 3` and status is not `model_verified`:
   1. `search` / `read` / `inspect` to localize the defect (serial, diagnosis,
      failing clauses, gaps).
   2. If status is `unsupported` or `inconclusive` with **blocking gaps** that a
      patch cannot close → **`abstain`** (do not burn the budget spinning).
   3. Propose a **minimal** `patch` (single concern). Prefer higher score among
      candidates using the formula above (build/warnings/lines until oracle is green).
   4. `compile` → new `firmware_ref`.
   5. `verify` with the **same** oracle.
   6. Increment `repairs_used`. Record before/after status and score inputs.
5. **Stop conditions**
   - **`finish`** when `status: model_verified` — report evidence_ref if present,
     score, repairs_used, remaining risks.
   - **`abstain`** when `repairs_used == 3` and still not green.
   - **`abstain`** (or report terminal `unsupported` / `inconclusive`) when gaps
     or unmodeled surface block progress before budget is usefully spent.
6. **Handoff.** On green → `report-evidence` / user summary. On abstain or
   terminal red → summarize attempts, last status, gaps, and do **not** claim
   model-verified.

## Handoffs

| From | When | To |
|------|------|-----|
| `verify-firmware` | Red / failed after dispose | this skill |
| `diagnose-firmware` | Fail-first capture done; enter budgeted repair | this skill |
| this skill | Green | `report-evidence` (optional later HW promote is out of scope here) |
| this skill | Abstain / exhausted | user + gaps; optional re-diagnose with new evidence only |

## Never

- Exceed **3** repair iterations after the first red.
- Weaken or swap the oracle to obtain a pass.
- Use LLM-as-judge or prose confidence as verification.
- Claim `model_verified` without `labwired_verify` → `status: model_verified`.
- Continue patching through blocking `unsupported` / gap walls — **abstain**.
