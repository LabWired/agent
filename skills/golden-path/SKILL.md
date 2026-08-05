---
name: golden-path
description: >-
  Default stranger path: pick target → part knowledge → scaffold → compile/run
  → verify → optional compose plot → report. Use for "blink LED and prove it",
  first session, or any end-to-end prove-before-silicon request.
license: MIT
compatibility: opencode
metadata:
  gate: "1"
  labwired: "true"
  product: "wave-a-stranger-path"
---

# Golden path (prove before silicon)

This is the **default LabWired loop** — better SOTA than bench-only agent loops.

```text
part knowledge → board bring-up → scaffold → compile
  → labwired_run (observe) → labwired_verify (oracle)
  → repair loop if red (max 3) → report-evidence
  → optional compose-observability (plot from elements)
```

## Hard rules

1. **Do not force sim.** If twin tools are missing, use the **debugger** (F5 /
   DAP / probe-rs GDB) or desk flash — that is supported, not an error.  
2. **`model_verified` only** from `labwired_verify` when twin path is available.  
   Debugger success is never renamed to `model_verified`.  
3. **No invent** pins / addresses — `part-knowledge` / describe first.  
4. **Repair budget** max 3 after first red on twin — same oracle.  
5. **Plots** = compose **elements**, never a ready-made plot product.  
6. **HW flash** is optional and never upgrades twin green (`hw-promote`).

## Choose a run path

| Available | Do this |
|-----------|---------|
| Hosted MCP or local sim (`labwired_run` / `labwired_verify`) | Twin observe → verify → repair (below) |
| No sim, debugger / probe available | Compile → **debugger** step/run on target; serial via monitor/capture; honest claims |
| Both | Prefer twin for prove-before-silicon; debugger for silicon insight |

Never block the session with “install sim first” if the user can debug.

## Procedure (do in order)

### 1. Target + knowledge

1. Clarify board/MCU and behavior (default: blink + optional UART marker).  
2. Load **`part-knowledge`** / `labwired_list` + `labwired_describe` (and part/datasheet tools when present).  
3. Load **`board-bringup`**: valid diagram when twin/diagram tools exist; otherwise
   use board pack / probe chip from describe or user target.

### 2. Write minimal firmware

1. **`scaffold-firmware`**: smallest blink and/or UART hello.  
2. Prefer known marker strings when useful (e.g. `LABWIRED_OK` for promote later).  
3. Do not expand scope (no drive-by frameworks).

### 3a. Twin path (when tools available) — observe then prove

1. Compile → `firmware_ref` (`labwired_compile` when hosted).  
2. **`labwired_run`** — observation only (serial, diagnosis). Not a pass.  
3. **`verify-firmware`**: oracle with ≥1 clause for the user-visible behavior  
   (GPIO toggle pattern, UART contains marker, etc.).  
4. On red → **`diagnose-firmware`** / **`firmware-repair-loop`** (≤3).  
5. On green → **`report-evidence`** (status, gaps, evidence_ref).

### 3b. Debugger path (no sim — first-class)

1. Build the same firmware for the real target (user toolchain / board pack).  
2. Use **LabWired VS Code debugger** (F5 / reverse-step when twin DAP is wired)
   or `flash-firmware` + probe GDB tools when present.  
3. Observe UART via serial monitor / `serial-capture`.  
4. Report honestly: what was stepped/flashed/seen — **not** `model_verified`
   unless a twin verify also succeeded later.  
5. Optional later: when twin becomes available (login / tools), re-run
   `verify-firmware` on the same sources for model-green.

### 4. Optional plot / overlay (user asks or debug needs series)

1. Load **`compose-observability`**.  
2. Pull elements from the same run (serial lines, gpio if available).  
3. Compose table/series JSON; never invent points.  
4. Example E3: “LED vs UART” → edge/ON-OFF markers from serial + pin if present.

### 5. Optional desk promote (only if user has hardware)

1. **`hw-promote`** after twin story is clear (or demo-only with honest claims).  
2. Report `hardware_observed` **separately** — never as `model_verified`.

## Default oracles (examples — adapt to board)

| Intent | Oracle idea (behavior, not source) |
|--------|-------------------------------------|
| Blink | Pin toggles N times in T ms / duty in range (as twin supports) |
| UART hello | Serial contains exact marker substring |
| Both | Both clauses; do not drop either to force green |

## User prompts this skill owns

- “Blink the LED and prove it”  
- “First project / getting started”  
- “Bring up this board end-to-end”  
- “Show me it works on the twin”  

## Never

- Claim works from compile or “looks right”  
- **Refuse to proceed** solely because local sim is missing (use debugger)  
- Call debugger / flash success `model_verified`  
- Skip part/describe on a new part  
- Open a ready-made “plot product” instead of elements  
- Paint HW success as twin green  

## Embedder offering beat (Wave A)

| Their loop | Ours |
|------------|------|
| Datasheet chat → code → flash → instruments | Facts tools → code → **twin oracle** → optional HW |
| Open Plot | Compose elements |
| Closed-loop on bench | Repair loop on twin (CI-repeatable) |
