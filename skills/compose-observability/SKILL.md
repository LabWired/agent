---
name: compose-observability
description: >-
  When the user wants a plot, chart, scope, overlay, or "show X over time",
  assemble a view from observability elements (serial, gpio edges, bus samples,
  registers, faults, evidence). Never invent a fixed plot type or open a
  ready-made dashboard. Reuse labwired_run / inspect / verify outputs and
  existing plot/capture surfaces.
license: MIT
compatibility: opencode
metadata:
  gate: "1"
  labwired: "true"
  product: "elements-not-ready-plots"
---

# Compose observability (plots = elements)

## Product rule (binding)

We do **not** provide ready-made plots.

We provide a **collection of elements** — machine-readable observables — that
you **assemble** into whatever plot or panel the user wants.

| Say / do | Do not |
|----------|--------|
| “I’ll pull GPIO edges + UART and compose an overlay.” | “Opening the I²C plot / scope product…” |
| Use tools; quote real series | Invent waveforms or numbers |
| Reuse existing capture/plot series shapes | Invent a new plot-type product |

Canonical product doc (monorepo):  
`docs/strategy/2026-08-05-composable-observability-elements.md`

## When to use

User asks for any of: plot, chart, graph, scope, waveform, overlay, “show pin
over time”, “compare UART to LED”, “did it toggle?”, multi-series view.

Also use when diagnosing and a **visual or structured series** would answer
faster than prose alone.

## Element catalog (compose from these)

| Element | Prefer tools / surfaces | Shape (conceptual) |
|---------|-------------------------|--------------------|
| **Serial / UART stream** | `labwired_run` serial; monitor; optional UART trace | Timed or sequential lines |
| **Numeric series from UART** | Same serial; agent plot RPC `plot_status` / live `plot/update`; patterns `key=val` or CSV numbers | Named series → number[] |
| **GPIO / pad edges** | `labwired_run` / `labwired_inspect` gpio; playground LA edge export when available | `{ pin, t/cycle, level }[]` |
| **Bus samples** | Run peripherals / bus traces; I²C/SPI/UART transaction lists | Events or wire samples |
| **Registers / peripheral slice** | `labwired_inspect`, run `output: peripherals` | Named fields at t or end of run |
| **Faults / diagnosis** | `labwired_run` diagnosis / faults | Markers on a timeline |
| **Evidence / oracle** | `labwired_verify` → status + evidence_ref | Proof is verify; series only illustrate |
| **Logic capture dump** | Evidence `waveform.csv` / capture object; twin VCD export when present | Multi-lane edges + meta |

**Green claims still require `verify-firmware`.** A pretty series is never
`model_verified`.

## Procedure

1. **Parse the ask into elements**  
   Which pins, buses, serial channels, registers, time window?  
   If vague (“show me a plot”), ask once *or* default to the last run’s LED pin
   + UART when the task is blinky/serial.

2. **Ensure a run exists**  
   - Need behavior: `labwired_run` (observe) with outputs that include serial /
     peripherals as needed.  
   - Need proof: hand off to `verify-firmware` first; then compose illustration
     from the same binary’s run/evidence.

3. **Pull elements via tools**  
   Do not invent series. Prefer:
   - serial text → extract `name=number` / CSV as series when useful  
   - inspect/gpio/peripherals for structural state  
   - evidence files under `~/.labwired/evidence/` when `evidence_ref` exists  
   - if plot RPC / `plot_status` is available in this surface, use it for live
     UART series (same ingest as SerialPlotStrip / plotParse)

4. **Compose a view** (pick the cheapest that answers the question)  
   - Markdown table of edges / key samples  
   - Multi-series list: `{ id, points[] }` for thin glass (workbench Plot panel)  
   - Markers: UART lines or faults at t  
   - Short narrative: what the series show (e.g. “GPIO4 toggled 4 times in 2 s”)  
   Optional: point the user at **Open Plot** only as **dumb glass** for series
   already pulled — never as a fixed product plot type.

5. **Honesty**  
   - Missing element → say which tool/twin path lacks it; do not fake data.  
   - Observation ≠ proof.  
   - Desk serial plot ≠ twin edges unless the same run produced both.

## Reuse first (do not rebuild)

Prefer existing LabWired surfaces:

| Surface | Role |
|---------|------|
| Playground logic analyzer export (`buildCaptureObject` / CSV) | Digital edges + bus traces envelope |
| `busWaveform` / waveform strips | Structural I²C/SPI lanes |
| Agent plot RPC + workbench Plot panel | Live UART numeric glass |
| Editor SerialPlotStrip + plotParse | Same UART→series ingest as RPC |
| CLI VCD / evidence waveform.csv | Offline wave; external GTKWave/PulseView OK |

Do **not** invent a second logic analyzer or a third UART series parser.

## Example compositions

| User asks | Elements | Compose |
|-----------|----------|---------|
| “Did the LED blink?” | GPIO edges on LED pin (or serial ON/OFF markers) | Edge count / duty; optional series |
| “Plot temp from UART” | Numeric series from `temp=` lines | Single series + source lines |
| “Overlay UART on GPIO4” | Serial markers + pin edges | Shared timeline, two layers |
| “Is 0x76 on the bus?” | Bus/I²C events | Transaction list filtered by address |
| “Prove blinky” | `labwired_verify` first; series optional | Status from verify only |

## E3 recipe — LED vs UART (must work end-to-end)

Canonical composed path for golden-path / blinky demos:

1. Ensure firmware prints distinct lines on LED on/off (e.g. `LED ON` / `LED OFF`)
   **or** twin exposes the LED pin via run/inspect.
2. `labwired_run` (or use last run serial + gpio if still available).
3. Build elements:
   - **Serial markers:** timestamps or line index for each `LED ON`/`OFF` (or user marker).
   - **GPIO series** (if available): edge list for the LED pin.
   - If only serial exists: compose a **digital-from-log** series
     (`1` on ON lines, `0` on OFF) and label it `derived_from_uart` (honest provenance).
4. **Helper (reuse, do not reimplement):** from the agent kit root:
   ```bash
   python3 scripts/compose-elements.py --uart path/to/uart.log --out composed.json
   ```
   Catalog: `share/observability/element-catalog.json`
5. Present:
   - Short narrative (“4 toggles in window; UART markers align with ON/OFF”).
   - Table or multi-series JSON for thin Plot glass / markdown.
6. If user also asked to **prove** blink: run **`verify-firmware` first**; plot only
   illustrates — never replaces oracle green.

## Never

- Claim a fixed plot product (“the SPI plot”, “scope view #3”) exists as the answer  
- Invent sample points  
- Treat composed plots as `model_verified` or `hardware_observed`  
- Open Embedder-style ready-made dashboards as product parity  
- Block on a fancy chart library when a table + series JSON answers the user  
