---
name: hw-promote
description: >-
  Promote twin-green (or demo) firmware to attached physical hardware. Flash +
  serial/RTT marker → hardware_observed only. Never upgrade hardware_observed to
  model_verified. Prefer sim verify first. Board/chip/port from args/env — not a
  single-MCU product path.
license: MIT
compatibility: opencode
metadata:
  gate: "workflow"
  labwired: "true"
---

# Hardware promote (board-agnostic)

Physical targets are **optional validation canaries** for tooling and demos.
They are **not** the product focus. The product is twin dispose + evidence for
FW engineers. Any chip on the desk (STM32, nRF, ESP32-C3, …) is just a way to
exercise flash/serial when available.

## Hard rules

1. **`model_verified` is twin-only.** It comes only from `labwired_verify` →
   `status: model_verified`. This skill never emits or upgrades to it.
2. **`hardware_observed` is physical-only.** It requires a successful flash **and**
   a **captured** serial (or RTT) match of the oracle marker within the capture
   window. Flash success alone is never enough.
3. **Never upgrade** `hardware_observed` → `model_verified` (or the reverse).
   Report twin status and HW status as **separate fields**.
4. **Prefer sim/model verify first** when the twin path is available.
5. Do not weaken the serial marker or oracle to force a pass.
6. **Do not hardcode a product MCU.** Chip, board, port, and flash backend come
   from the task, env (`LABWIRED_HW_PORT`, `LABWIRED_HW_CHIP`), or probe list.

## Status separation

| Status | Source | Allowed claim |
|--------|--------|---------------|
| `model_verified` | `labwired_verify` only | model-verified on the twin |
| `hardware_observed` | flash **and** serial/RTT marker match | hardware-observed on attached target |
| `failed` | twin or HW contradiction / fault | failed — do not soft-pass |
| `inconclusive` | missing capture, port, or runner | inconclusive — insufficient evidence |
| `unsupported` | unmodeled surface (twin) | unsupported — twin can’t check this |

Forbidden: “works on hardware” from sim alone; “model-verified” from flash/serial.

## Preconditions

1. When possible: same behavior already green on twin for the shared marker.
2. Firmware image/ELF for the physical target.
3. Chip id, serial port (or auto-detect), and marker string agreed with the oracle.

## Flash backends (pick what matches the target)

Prefer **probe-rs** via LabWired when installed (STM32, nRF, many ARM targets):

```bash
labwired probe list
labwired probe doctor
labwired probe flash <elf> --chip <chip-id>
```

**ESP32-C3 / ESP USB-Serial/JTAG:** use PlatformIO or esptool (probe-rs path is
secondary). From a PlatformIO project:

```bash
pio run -t upload
# or
labwired probe flash build/app.elf --chip esp32c3   # routes to PIO/esptool when possible
```

USB-CDC builds must set:

```
-DARDUINO_USB_MODE=1 -DARDUINO_USB_CDC_ON_BOOT=1
```

Without those flags, flash succeeds but serial capture is empty.

Virtual twin path (not hardware_observed):

```bash
labwired probe flash <elf> --target virtual --chip <board-or-system>
# or MCP: labwired_verify
```

Still require serial/RTT marker capture after flash — the flash tool alone does
not grant `hardware_observed`.

See `flash-firmware` for probe/virtual rules.

## Serial / RTT oracle marker

1. Choose the marker string (fixture/oracle constant).
2. After reset/flash, capture for window **T** seconds:
   `labwired serial-capture` / `lib/serial-capture.sh` when available.
3. Pass only if the marker appears in the **captured** stream.
4. On pass, emit **`hardware_observed`** with: chip, tool path, ELF/digest if
   known, marker, capture excerpt/`evidence_ref`.
5. On no marker / flash fail: `failed` or `inconclusive`.

## Procedure

1. Prefer twin verify first (`verify-firmware`) when possible.
2. Discover attach: `labwired probe list` / port env.
3. Flash with the appropriate backend for **this** chip.
4. Capture serial/RTT; match marker.
5. Record **twin status** (if any) and **HW status** separately.
6. Hand off to `report-evidence` — dual claim; never invent green.

## Claim vocabulary

- **hardware-observed** — flash + marker in capture window on real silicon
- **model-verified** — out of scope for this skill’s pass path (twin only)
- Flash OK without marker → **not** hardware-observed
- Twin green without physical path → **not** hardware-observed

## Related skills

- `verify-firmware` — twin oracle dispose (`model_verified`)
- `flash-firmware` — flash backends and virtual target
- `report-evidence` — dual-claim report + verification matrix
- `firmware-repair-loop` / `diagnose-firmware` — fix twin red before promote
