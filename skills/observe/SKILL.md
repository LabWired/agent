---
name: observe
description: >-
  Plots and overlays from observability elements (serial, gpio edges, bus,
  registers, evidence) — not ready-made plot products. Assemble any view the
  user wants; never invent waveforms.
license: MIT
compatibility: opencode
metadata:
  gate: "1"
  labwired: "true"
  pack: "observe"
---

# Observe (compose elements → any plot)

**Rule:** We do **not** ship ready-made plots. We ship **elements** you assemble.

## Hard rules

1. Parse the user ask into **elements** (pins, UART, bus, time window).  
2. Pull via tools / run artifacts — **never invent** series.  
3. A composed plot is **observation**, never `model_verified` or `hardware_observed`.  
4. Prefer helpers over reinventing parsers.

## Elements (catalog)

| Element | Source |
|---------|--------|
| Serial / UART | `labwired_run`, monitor |
| Numeric series from UART | `key=value` / CSV lines |
| GPIO edges | inspect / LA export |
| Bus samples | peripherals / traces |
| Registers | `labwired_inspect` |
| Faults | run diagnosis |
| Evidence | verify JSON (illustrate only) |
| Logic capture | CaptureObject / VCD / CSV |

Catalog: `share/observability/element-catalog.json`

## Agent-callable helpers (prefer CLI)

```bash
labwired compose uart --file uart.log --out composed.json
labwired compose capture --capture capture.json --out composed.json
labwired compose capture --capture capture.json --uart uart.log --out composed.json
```

(Scripts under `scripts/compose-*.py` are the implementation; call via **`labwired compose`**.)

## E3 recipe — LED vs UART

1. Run (or use last run) with `LED ON`/`LED OFF` or marker lines.  
2. Compose UART markers + optional gpio; if only serial, digital-from-log with
   provenance `derived_from_uart`.  
3. Narrative + series JSON; prove path stays **`prove`** pack if user asked green.

## Never

- “Opening the SPI plot product…”  
- Invent sample points  
- Claim plot = model-verified  
