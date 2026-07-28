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
2. Physical flash uses **probe-rs** (bundled path) — not OpenOCD configs.
3. **model_verified** = sim only. Flashing is not automatic hardware proof.
4. After physical flash, observe UART/RTT before any hardware claim.

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

## Procedure

1. Obtain ELF (builder or local toolchain).
2. Sim verify when possible.
3. `labwired probe list` — pick virtual or physical.
4. Flash with explicit `--chip`.
5. Report paths separately: sim status vs flash vs observed serial.
