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
