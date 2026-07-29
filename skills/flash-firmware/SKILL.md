---
name: flash-firmware
description: >-
  Flash firmware to a physical debug probe (probe-rs: ST-Link, J-Link, CMSIS-DAP, …)
  or to a virtual LabWired validation device (simulator). Prefer sim green before
  hardware. Never claim hardware success from simulation alone.
license: MIT
compatibility: opencode
metadata:
  gate: "workflow"
  labwired: "true"
---

# Flash firmware

## Hard rules

1. Prefer **virtual LabWired** (`labwired_verify` / `labwired probe flash --target virtual`) until green.
2. Physical flash uses **probe-rs** (bundled path) when available — not OpenOCD configs.
3. **model_verified** = sim only. Flashing is not automatic hardware proof.
4. After physical flash, observe UART/RTT before any hardware claim.
5. For desk promote (flash + serial marker → `hardware_observed`), load **`hw-promote`**.
   Flash alone never yields `hardware_observed` or `model_verified`.

## Discover

```bash
labwired probe list
labwired probe chips stm32
labwired probe doctor
```

## Virtual LabWired validation device

Any catalog/sim board LabWired supports:

```bash
labwired probe flash build/app.elf --target virtual --chip <board-or-system>
# or MCP: labwired_run / labwired_verify
```

## Physical (any popular probe probe-rs supports)

```bash
labwired probe flash build/app.elf --chip STM32L476RGTx
labwired probe reset --chip STM32L476RGTx
```

Optional: `--probe <selector>` from `labwired probe list`.

## ESP32-C3 and USB-CDC

ESP32-C3 boards often expose **USB-CDC** (and/or USB-JTAG) as the serial console
and sometimes as the flash path:

- After flash, open the **CDC ACM** (or board UART) port for the marker window —
  not only the probe-rs session.
- USB-CDC may re-enumerate on reset; re-resolve the port if capture fails mid-window.
- Baud and line endings must match the firmware (common: 115200 8N1).
- If **probe-rs is missing**, prefer **PlatformIO** or **esptool** for C3 flash
  (see `hw-promote`); still require serial marker capture for any
  `hardware_observed` claim.

Promote path (marker + dual status): **`hw-promote`**.

## Procedure

1. Obtain ELF (builder or local toolchain).
2. Sim verify when possible (`verify-firmware` / `labwired_verify`).
3. `labwired probe list` — pick virtual or physical.
4. Flash with explicit `--chip` (or PlatformIO/esptool for C3 when probe-rs absent).
5. Report paths separately: sim status vs flash vs observed serial.
6. For hardware-observed claims, continue with `hw-promote` (serial oracle marker).
