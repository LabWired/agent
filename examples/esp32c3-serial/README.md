# Example: ESP32-C3 serial hello

**Optional canary** — one board profile for the generic `scripts/dev-cycle.sh`.
The product is board-agnostic; use any PlatformIO project + `LABWIRED_HW_*`.

```bash
export LABWIRED_HW_PORT=/dev/cu.usbmodemXXXX   # or ttyACM0 / ttyUSB0
scripts/profiles/esp32c3-serial.sh
# equivalent:
# LABWIRED_HW_WS=$PWD/examples/esp32c3-serial \
# LABWIRED_HW_CHIP=esp32c3 \
# LABWIRED_HW_SYSTEM=$LABWIRED_CORE_SRC/validation/arduino-matrix/systems/esp32c3.yaml \
# scripts/dev-cycle.sh
```

Marker: `LABWIRED_OK` (override with `LABWIRED_HW_MARKER`).
