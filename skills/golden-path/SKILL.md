---
name: golden-path
description: >-
  First-session guide that delegates firmware development to develop, with
  optional circuit import, requested plots, and physical-board evidence.
license: MIT
compatibility: opencode
metadata:
  gate: "1"
  labwired: "true"
  pack: "entry"
---

# Golden path (entry)

First-session guide. Delegate firmware work to **`develop`**.

```text
develop → optional import-circuit / observe / desk-hw
```

## Hard rules

1. **Do not force sim.** No twin → **debugger** (F5 / probe) is first-class.  
2. **`model_verified` only** from `labwired_verify`.
3. Debugger / flash success is **never** renamed to `model_verified`.  
4. Plots = **observe** pack (elements), not ready-made Open Plot.  
5. HW claims only via **desk-hw** (`hardware_observed`).

## Routing

- Load **`develop`** for firmware creation or modification, compilation, twin checks, repair, and reporting.
- Load **`import-circuit`** only when an external schematic or diagram must become circuit input.
- Load **`bringup`** only when extra board or part knowledge is needed.
- Load **`prove`** when the development workflow needs its focused verification guidance.
- Load **`observe`** only when the user requests plots or graphs.
- Load **`desk-hw`** only when a physical board is available and hardware evidence is requested.

Keep twin and hardware claims separate. If no twin is available, use the
debugger/probe path and report only the evidence actually observed.

See `skills/README.md`.
