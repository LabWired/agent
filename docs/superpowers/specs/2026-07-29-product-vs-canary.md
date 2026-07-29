# Product focus vs verification canary

**Rule for agents and humans working on LabWired Agent:**

## Product (sell this)

> **Verified firmware-engineering agent** for FW engineers: structured tools, constrained repair loops, deterministic LabWired oracle, evidence reports.  
> Beachhead: skills + harness + propose/dispose. Zephyr multi-file / nRF / catalog boards as the Pro story.  
> Local model / QLoRA later — not the v0 SKU.

**Do not** market or design the agent pack around a single hobby MCU.

## Canary (use this to test tooling)

Any board currently on the desk (e.g. ESP32-C3 on USB) is only a **way for implementers/testers to prove**:

- flash path works  
- serial capture works  
- claim vocabulary doesn’t lie (`hardware_observed` ≠ `model_verified`)  
- doctor / harness / skills invoke real commands  

If the canary board changes tomorrow, **product docs and skills must not need a rewrite**.

## Skill rules

| Skill / surface | Must be |
|-----------------|--------|
| `verify-firmware` | Board-agnostic; diagram + oracle |
| `firmware-repair-loop` | Board-agnostic |
| `hw-promote` | Generic: sim green → flash → observe; chip/port from args/env |
| fixtures named `c3-baseline` | Optional **test fixture**, not product positioning |
| README / marketing | Oracle + agent, not “the C3 agent” |

## Status words

- `model_verified` — LabWired twin oracle only  
- `hardware_observed` — physical path ran and matched a marker  
- Never imply the product is “for C3” because a canary passed  

## Cursor research alignment

Cursor doesn’t sell “Chrome agent” because the browser tool exists.  
We don’t sell “C3 agent” because a C3 was plugged in during development.
