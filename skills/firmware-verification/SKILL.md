---
name: firmware-verification
description: >-
  Verify firmware behavior against LabWired's deterministic model oracle before
  claiming it works on the digital twin. Use whenever you are about to report that
  firmware compiles, runs, boots, blinks, prints, or passes. Never assert firmware
  success from reading the code or from an observational run alone; only
  labwired_verify with status model_verified is a model-verification pass.
license: MIT
compatibility: opencode
metadata:
  gate: "1"
  labwired: "true"
---

# Firmware verification

## Hard rule

> **You may not tell the user the firmware is model-verified until `labwired_verify`
> returns `status: model_verified`.** Not because the code looks right. Not because
> it compiled. Not because a plain run printed something.

The agent proposes; the deterministic oracle classifies. That is **model verification** —
not signed hardware confirmation.

## Claim vocabulary

- Say **model-verified** only when `labwired_verify.status` is `model_verified`.
- Say **failed** when the requested observation contradicts the oracle.
- Say **inconclusive** when required evidence was not collected or the runner failed.
- Say **unsupported** when execution reaches an unmodeled instruction, MMIO range, peripheral, or clause capability.
- Never turn `proven: true` alone into a broader hardware claim; it is a deprecated compatibility alias for `status: model_verified`.
- Say **hardware-confirmed** only when a later hardware worker returns a signed hardware evidence record.
- Say **parity-verified** only when model and hardware evidence are linked to the same firmware digest and acceptance oracle.

When `gaps` is non-empty, show the blocking gap and recommend the narrowest next action. Do not silently weaken or remove the oracle to obtain a pass.

## Tools

| Tool | What it does | Model-verifies? |
|---|---|---|
| compile path | source → ELF | ❌ |
| `labwired_run` | observational serial / registers / diagnosis | ❌ |
| `labwired_verify` | run + classify against required oracle | ✅ typed `status` |

## Procedure

1. Write firmware and obtain `firmware_ref`.
2. Call `labwired_verify` with diagram + non-empty oracle.
3. Report `status`, gaps, diagnosis; only `model_verified` allows a success claim.
4. On non-pass: fix firmware (or report unsupported), re-verify. Never lower the oracle.
