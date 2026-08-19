---
name: desk-hw
description: >-
  Plan and execute confirmed physical hardware runs with explicit identities,
  safe wiring, exact flash, and behavior-specific evidence. Prefer twin prove first.
license: MIT
metadata:
  gate: "workflow"
  labwired: "true"
  pack: "desk-hw"
---

# Desk hardware (flash · promote)

## Hard rules

1. **`model_verified` is twin-only** — never from flash or serial alone.  
2. **`hardware_observed`** requires exact flash and independent evidence for the
   configured behavior. A UART/RTT marker proves only that UART/RTT behavior.
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

## A. Simulation is nonphysical

Twin or virtual-device results are model evidence only. Keep them separate from
physical results; simulation never proves flashing, wiring, GPIO, RF, or a real
instrument capture.

## B. Plan the exact physical run

Use a reviewed `.labwired/hardware.json` with an explicit target `id`, `chip`,
`probeSerial`, and `serialPort`. Confirm the real board voltage, common ground,
probe connections, UART levels, and any logic-analyzer channel before planning.
Never place credentials or machine-specific identities in a committed template.

```json
{
  "schema": 1,
  "target": {
    "id": "reviewed-board-id",
    "chip": "reviewed-chip-id",
    "probeSerial": "exact-probe-serial",
    "serialPort": "exact-serial-port"
  }
}
```

The real profile also declares the trusted build, exact artifact, flash
provider, and behavior observations. Generate a read-only plan:

```bash
labwired agent hardware plan --profile .labwired/hardware.json --out .labwired/evidence
```

Stop if enumeration is missing or ambiguous, if wiring is not confirmed, or if
the plan names any unexpected identity, tool, artifact, or action.

## C. Confirm and execute

After the operator reviews the plan, run only its exact digest:

```bash
labwired agent hardware run --profile .labwired/hardware.json \
  --out .labwired/evidence --confirm <exact-plan-digest>
```

A changed profile, provider version, artifact, probe, port, or plan requires a
new review and confirmation. Flash alone is not behavior evidence.

For UART or RTT observations, retain the strict raw capture and receipt. Those
captures may prove only the configured UART/RTT assertion; they never prove a
GPIO transition or LED frequency. An LED requires an independently wired logic
capture. Wi-Fi requires the fresh nonce-correlated device/host challenge.

Record the fail-first bundle even when a provider blocks or an assertion fails.
Never invent, substitute, or hand-edit raw evidence.

## D. Report separate claims

```text
twin_status:       <from prove or not_run>
hardware_status:   <from authenticated physical receipt>
evidence_receipt:  <external receipt path and hash>
```

## USB-CDC notes

ESP32/RP2040 may re-enumerate after reset; re-resolve port. Baud must match firmware.

## Handoff

| Need | Pack |
|------|------|
| Twin green first | `prove` |
| Dual-claim write-up | `prove` (report section) or `scripts/report-evidence.py` |
