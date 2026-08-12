# Skills

**Product:** [docs/PRODUCT.md](../docs/PRODUCT.md)

Local dev suite: **same `labwired_*` tools as cloud agent/Architect** (parity goal).  
Skills = how the desk agent works. Engine = **`labwired agent`**. UI does not replace skills with panels.

## Domain (firmware)

| Skill | Job |
|-------|-----|
| **golden-path** | Entry loop for a new user |
| **bringup** | Knowledge + diagram + scaffold |
| **import-circuit** | External sources → twin pack |
| **prove** | `labwired_verify` → `model_verified` |
| **observe** | Plots from elements (not Open Plot) |
| **desk-hw** | **Physical boards**: flash, serial/RTT → `hardware_observed` |

Typical order: `golden-path` → `bringup` \| `import-circuit` → `prove` → optional `observe` / `desk-hw`.

## Claims

| Claim | Only via |
|-------|----------|
| `model_verified` | **prove** + `labwired_verify` |
| `hardware_observed` | **desk-hw** |

## Process

Superpowers (`using-superpowers`, TDD, plans, …) = process only. Never mint green.

## Knowledge

**bringup** + `labwired_part` / `labwired_datasheet` / list / describe. Never invent pins.

| `customize-labwired-agent` | Edit LabWired Agent config (not LabWired Agent runtime product naming) |
