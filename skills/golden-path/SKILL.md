---
name: golden-path
description: >-
  Default stranger path: bringup → prove on twin (or debugger if no sim) →
  optional observe plot → optional desk-hw. Use for "blink and prove it" or
  first session. Loads the four packs: bringup, prove, observe, desk-hw.
license: MIT
compatibility: opencode
metadata:
  gate: "1"
  labwired: "true"
  pack: "entry"
---

# Golden path (entry)

Default LabWired loop. Prefer this over loading many micro-skills.

```text
bringup → write/scaffold → prove → optional observe → optional desk-hw
```

## Hard rules

1. **Do not force sim.** No twin → **debugger** (F5 / probe) is first-class.  
2. **`model_verified` only** from `labwired_verify` (prove pack).  
3. Debugger / flash success is **never** renamed to `model_verified`.  
4. Plots = **observe** pack (elements), not ready-made Open Plot.  
5. HW claims only via **desk-hw** (`hardware_observed`).

## Procedure

### 1. Bringup
Load **`bringup`**: part tools → diagram → minimal blink/UART scaffold.

### 2. Prove (when twin tools available)
Load **`prove`**: run observe → `labwired_verify` → repair ≤3 if red → evidence report.

### 3. Debugger path (no sim)
Build for target → LabWired VS Code F5 / probe-rs → serial observe → honest report.
Optional later: when twin available, re-run **prove**.

### 4. Observe (optional)
Load **`observe`** if user wants a plot/overlay from run elements.

### 5. Desk-hw (optional)
Load **`desk-hw`** only if user has hardware and wants promote.

## Pack map

| Pack | Job |
|------|-----|
| `bringup` | Pins, diagram, scaffold |
| `prove` | Verify, repair, evidence |
| `observe` | Compose plots from elements |
| `desk-hw` | Flash + hardware_observed |

See `skills/README.md`.
