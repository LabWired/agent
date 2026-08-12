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

## Elements agent may compose (catalog)

| Element | Source | Compose helper |
|---------|--------|----------------|
| Serial / UART markers | run / monitor / fixture log | `labwired compose uart` |
| LED digital series | `LED ON`/`OFF` / marker lines | same (derived_from_uart) |
| Numeric series from UART | `key=value` / CSV lines | same |
| GPIO edges | inspect / LA export | `labwired compose capture` |
| Bus samples | peripherals / traces | capture / inspect |
| Registers | `labwired_inspect` | inspect JSON |
| Faults | run diagnosis | evidence only |
| Evidence | verify JSON (illustrate only) | never mint claims |

Catalog: `share/observability/element-catalog.json`

### “Show me X” one path (Task 11)

```bash
# Fixed recipe: UART log with LED/marker lines → non-empty series or markers
python3 scripts/compose-elements.py \
  --uart fixtures/gate1-live/evidence/fixed/uart.log \
  --out /tmp/composed.json
# require: series or markers non-empty
```

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

## VS Code glass (E4)

Workbench panel **Plot** (`labwired.plot`) is dumb multi-series glass:

- Command **LabWired: Open Plot** — show panel  
- **LabWired: Open Composed Plot JSON…** — load `composed.json` from `labwired compose`  
- Paste composed JSON into the panel, or stream live serial numbers  

Do **not** claim a ready-made plot product; point users at compose + glass.

## Never

- “Opening the SPI plot product…”  
- Invent sample points  
- Claim plot = model-verified  
