---
name: desk-hw
description: >-
  Flash via probe-rs (or virtual) and optional promote to hardware_observed
  (flash + serial/RTT marker). Never upgrade hardware_observed to model_verified.
  Prefer twin prove first.
license: MIT
compatibility: opencode
metadata:
  gate: "workflow"
  labwired: "true"
  pack: "desk-hw"
---

# Desk hardware (flash · promote)

## Hard rules

1. **`model_verified` is twin-only** — never from flash or serial alone.  
2. **`hardware_observed`** requires flash **and** marker in a captured window.  
3. **Never upgrade** HW → twin green (or reverse).  
4. Target from env/task: `LABWIRED_HW_PORT`, `LABWIRED_HW_MARKER`, `LABWIRED_HW_CHIP`  
   — not a fixed product MCU.  
5. Prefer **`prove`** (twin) first when twin path exists.
6. Run `hardware plan` first. Stop on missing or ambiguous target, probe, or
   port identity; missing confirmation; unsafe or unspecified wiring; or a
   changed digest. Never choose the first detected device.
7. Serial output is not GPIO proof. LED behavior requires an independent logic
   capture, and Wi-Fi behavior requires a correlated device/host challenge.
8. Record the plan, provider versions, artifact hashes, exact identities, raw
   physical captures, behavior receipts, and the final result as evidence.

## A. Flash

```bash
labwired probe list
labwired probe chips stm32
# virtual
labwired probe flash build/app.elf --target virtual --chip <id>
# physical
labwired probe flash build/app.elf --chip STM32L476RGTx
```

Flash alone is **not** `hardware_observed`.

## B. Promote → hardware_observed

1. Flash OK.  
2. `labwired serial-capture` (or equivalent) window contains marker
   (default `LABWIRED_OK` / `LABWIRED_HW_MARKER`).  
3. Emit **`hardware_observed`** with chip, tool path, marker, capture excerpt.  
4. Report via dual-claim footer (twin status separate).

```text
twin_status:       <from prove or not_run>
hardware_status:   hardware_observed
marker:            <string>
```

## USB-CDC notes

ESP32/RP2040 may re-enumerate after reset; re-resolve port. Baud must match firmware.

## Handoff

| Need | Pack |
|------|------|
| Twin green first | `prove` |
| Dual-claim write-up | `prove` (report section) or `scripts/report-evidence.py` |


## C. UART or RTT for the marker (same claim JSON)

Either path can mint **`hardware_observed`** when a marker is captured:

```bash
# UART (product default)
labwired serial-capture <port> <baud> <marker> <timeout>

# RTT (same claim shape: status, marker, excerpt, matched)
labwired probe rtt-capture --chip <id> --marker LABWIRED_OK
# CI / no RTT hardware:
LABWIRED_RTT_FIXTURE=uart.log labwired probe rtt-capture --chip <id>
# exit 2 NEED_RTT when probe-rs cannot RTT on this target — not a soft pass
```

Physical full path (hard fail without probe):

```bash
# exit 2 NEED_PROBE if probe-rs list is empty
LABWIRED_HW_ELF=… LABWIRED_HW_CHIP=… LABWIRED_HW_PORT=… bash scripts/desk-hw-physical.sh
```

If RTT is unavailable, fall back to UART `serial-capture` and say so.  
Never invent RTT or serial data.
