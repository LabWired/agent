# C3 baseline fixture

Minimal ESP32-C3 firmware that prints a fixed serial marker for the hardware
promote path (`hw-promote` skill). Twin verify is optional; desk flash +
serial marker is the HW claim path.

## Marker

```
LABWIRED_C3_BASELINE_OK
```

Printed once at boot and every second on UART0 (115200 baud).

## Serial port

Set the serial device used by capture / monitor tools:

| Env | Purpose |
|-----|---------|
| `LABWIRED_C3_PORT` | UART device path (e.g. `/dev/cu.usbmodem*`, `/dev/ttyACM0`) |

Example:

```bash
export LABWIRED_C3_PORT=/dev/cu.usbmodem14101
# then: labwired serial-capture (or PlatformIO monitor / skill path)
```

If unset, tools may auto-detect; prefer an explicit port for CI and demos.

## Build / flash (PlatformIO)

```bash
# From repo root
pio run -d fixtures/c3-baseline
pio run -d fixtures/c3-baseline -t upload
# Optional: monitor on LABWIRED_C3_PORT
pio device monitor -d fixtures/c3-baseline --port "${LABWIRED_C3_PORT}"
```

Or via agent CLI / probe path (chip id as supported by probe-rs):

```bash
labwired probe list
labwired probe flash .pio/build/esp32-c3-devkitm-1/firmware.elf --chip esp32c3
```

## Claim rules (HW promote)

1. Flash alone is **not** a pass.
2. Marker must appear in a **captured** serial window → status `hardware_observed`.
3. Never upgrade `hardware_observed` to `model_verified`.
4. Prefer twin `model_verified` first when a twin path exists; still report twin and HW as **separate** fields.

## Layout

| Path | Role |
|------|------|
| `platformio.ini` | ESP32-C3 Arduino env |
| `src/main.cpp` | Prints `LABWIRED_C3_BASELINE_OK` |
