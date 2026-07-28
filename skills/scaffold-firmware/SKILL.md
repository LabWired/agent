---
name: scaffold-firmware
description: >-
  Produce a minimal blink or UART-hello firmware skeleton for a chosen board
  (Arduino or bare-metal first). Never claim the scaffold works until
  labwired_verify returns model_verified.
license: MIT
compatibility: opencode
metadata:
  gate: "workflow"
  labwired: "true"
---

# Scaffold firmware

## Hard rule

Scaffolded code is a **proposal**. Compile success is not a pass.
You may say the firmware is **model-verified** only when `labwired_verify`
returns `status: model_verified` on that binary with a matching oracle.

## Procedure

1. Confirm board/MCU and framework (Arduino or bare-metal first; Zephyr only
   when the session docs honestly support it).
2. Prefer a target already validated via `board-bringup` / catalog describe.
3. Write the smallest skeleton that exercises one observable behavior:
   - GPIO toggle / blink, or
   - UART print of a known marker (e.g. Gate 1 uses `LABWIRED_OK`)
4. Keep files minimal; no drive-by refactors of unrelated code.
5. Hand off to `verify-firmware` (or `diagnose-firmware` on failure) with an
   oracle clause for that behavior.
6. Do not weaken the oracle to make a green scaffold.

## Claim vocabulary

Same as `verify-firmware`. Scaffolds are draft until `labwired_verify` returns `model_verified`.
