---
name: observe
description: >-
  Construct a graph/view from the user's need using real run data only.
  One job: ask → recipe → compose → present. Never invent series; never claim
  twin or desk green from a plot.
license: MIT
compatibility: opencode
metadata:
  gate: "1"
  labwired: "true"
  pack: "observe"
---

# Observe — tools for views (agent does the work)

**Product stance (keep simple):** LabWired ships **tools**. The agent decides when to call them and how to explain results. We do **not** ship a ready-made Open Plot product or invent waveforms.

**Tools (that is all):**

```bash
# Need → composed JSON (preferred)
labwired agent compose job --ask "<user words>" --uart <log> --out composed.json
labwired agent compose job --ask "plot LED vs UART" --from last-run --out composed.json
labwired agent compose job --ask "show logic capture" --capture <json> --out composed.json

# Low-level
labwired agent compose uart --file <uart.log> [--out composed.json]
labwired agent compose capture --capture <json> [--uart log] [--out out.json]
```

Workbench (optional viewer): **LabWired: Open Composed Plot JSON…**

## When to load

User says show / plot / graph / overlay / LED vs UART / pin edges.

## Hard rules

1. **Never invent** series or edges — only tool output.  
2. Composed view = **observation** — not `model_verified` / `hardware_observed`.  
3. Tool exit non-zero or empty → tell the user **missing**; stop.  
4. Do **not** freestyle Plotly/HTML/React charts when these tools exist.

## Agent loop (you do this)

1. Pick source (path user gave, last-run uart, or capture).  
2. Call **`compose job`** with their ask.  
3. Summarize `series` / `markers` from the JSON (or report fail).  
4. Optionally open the JSON in Plot glass — still just viewing tool output.

## Recipes (catalog)

Defined in `share/observability/element-catalog.json` → `compose_examples`:

| Ask (examples) | Recipe | Source |
|----------------|--------|--------|
| plot LED vs UART / show serial markers | `e3_led_vs_uart` | UART log |
| show logic capture / pin edges | `la_capture` | capture JSON |

## Low-level (only if job cannot express it)

```bash
labwired agent compose uart --file uart.log --out composed.json
labwired agent compose capture --capture capture.json [--uart log] --out composed.json
```

## Never

- “Opening the SPI plot product…”  
- Generating charts from imagined data  
- Claiming plot success = twin green or desk green  

## Handoff

| Need | Pack |
|------|------|
| Twin green first | `prove` |
| Desk marker | `desk-hw` |
| Dual-claim write-up | `prove` / `report-evidence` |
