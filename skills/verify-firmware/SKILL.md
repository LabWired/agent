---
name: verify-firmware
description: >-
  Model-verify firmware on LabWired's digital twin with a mandatory oracle.
  Use before claiming boots, blinks, prints, or passes. Returns typed status
  model_verified|failed|inconclusive|unsupported via labwired_verify.
  On red, hand off to firmware-repair-loop (max 3 repairs); never soft-pass.
license: MIT
compatibility: opencode
metadata:
  gate: "1"
  labwired: "true"
---

# Verify firmware

## Hard rule

You may tell the user firmware is **model-verified** only when `labwired_verify`
returns `status: model_verified`. Compile success, `labwired_run` output, or reading
the source is never enough. LLM judgment is never enough.

## Claim vocabulary

- **model-verified** — `status: model_verified`
- **failed** — observed behavior contradicted the oracle or the firmware faulted
- **inconclusive** — required evidence missing or runner failed
- **unsupported** — unmodeled instruction/MMIO/peripheral/clause
- `proven: true` is a deprecated alias for model_verified — never upgrade it to a hardware claim
- **hardware-confirmed** is out of scope until a hardware worker exists
- On budgeted repair stop without green, the repair loop may report **abstain**
  (not a soft pass and not `model_verified`)

## Procedure

1. Ensure a content-addressed `firmware_ref` (builder compile path, or prebuilt artifact).
2. Build a valid `diagram` with MCU part type matching the target board.
3. Write an `oracle` with at least one clause for the behavior the user cares about.
4. Call `labwired_verify` with `firmware_ref`, board/target, `diagram`, `oracle`.
5. Report `status`, `gaps`, and (when present) `evidence_ref`. Quote failing clauses and diagnosis on non-pass.
6. Never weaken the oracle to obtain a pass. Fix firmware or report unsupported honestly.
7. **On red / non-green:** hand off to `firmware-repair-loop` (entry also via
   `diagnose-firmware`). That loop freezes this oracle, allows at most **3**
   repair iterations, scores deterministically, and **abstains** when the budget
   or gaps block progress. Re-entry here is only for dispose; status minting
   remains solely `labwired_verify`.

## Tools

Prefer `labwired_verify`. Use `labwired_run` only for observation. Use `labwired_validate` if the diagram is rejected.
