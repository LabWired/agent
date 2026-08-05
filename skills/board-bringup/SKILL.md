---
name: board-bringup
description: >-
  Choose a board/MCU, draft a valid LabWired diagram, and validate pins/buses
  before any firmware success claim. Use when starting a new target or when
  labwired_verify rejects the diagram.
license: MIT
compatibility: opencode
metadata:
  gate: "workflow"
  labwired: "true"
---

# Board bring-up

## Hard rule

A diagram and target must be **valid** before you claim firmware behavior.
`labwired_run` / `labwired_verify` on a rejected diagram is not a pass.
## Procedure

1. Clarify the target board or MCU with the user (catalog name if known).
2. Call `labwired_list` / `labwired_describe` for pins, defaults, and beachhead.
3. For sensors / connectors / non-obvious pins or bus addresses, load
   **`part-knowledge`** (`labwired_part*` / `labwired_datasheet` when available).
   **Never invent** pin maps or I²C/SPI addresses from model memory.
4. Draft a `diagram` JSON: MCU part type matching the board, nets, and peripherals
   the firmware will touch — values **only** from tool output.
5. Call `labwired_validate` (or equivalent) when available; fix pin/bus errors.
6. Only then load `scaffold-firmware` or write firmware against that diagram.
7. Hand off success claims to `verify-firmware` / `golden-path` — bring-up alone
   is not model-verified.

## Claim vocabulary

Same as `verify-firmware`. Board choice and wiring are **not** model-verified.
Only `labwired_verify` → `status: model_verified` authorizes a model-verified claim.
