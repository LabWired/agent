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

# Observe — compose a view from user need

**Product rule:** We do **not** ship ready-made Open Plot products. We **do** build the graph the user asked for from **elements** in real logs/captures.

**One command (prefer this):**

```bash
labwired agent compose job --ask "<user words>" --uart <path> --out composed.json
# or after a twin run that left uart.log under evidence:
labwired agent compose job --ask "plot LED vs UART" --from last-run --out composed.json
```

## When to load

User says show / plot / graph / overlay / “what did the bus/LED do” / “LED vs UART”.

## Hard rules

1. **Never invent** series, edges, or sample points.  
2. A composed view is **observation only** — not `model_verified`, not `hardware_observed`.  
3. If source missing or empty match → say **missing** / empty; stop.  
4. Prefer **`compose job`** over freeform Plotly/HTML/React generation.

## Ordered job (do this every time)

| Step | Action |
|------|--------|
| 1 | Restate the need in one line (LED vs UART, logic edges, temp series, …). |
| 2 | Resolve source: user path, or last twin `uart.log`, or capture JSON. |
| 3 | Run `labwired agent compose job --ask "…" --uart …` (or `--capture …`). |
| 4 | If exit ≠ 0 or empty series/markers → report cannot compose (no invent). |
| 5 | Present: path to `composed.json` + short narrative of `series` / `markers` ids. In VS Code: **LabWired: Open Composed Plot JSON…** and pick that file (observation glass only). |

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
