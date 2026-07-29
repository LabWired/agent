# HW serial-marker fixture (ESP32-C3 example)

Minimal firmware that prints a fixed serial marker for **`hardware_observed`**
checks. This is **one example target** — the agent is not an ESP32 product.

| Env | Role |
|-----|------|
| `LABWIRED_HW_PORT` | UART/CDC device (`/dev/cu.usbmodem*`, `/dev/ttyACM0`, …) |
| `LABWIRED_HW_MARKER` | Oracle string (default `LABWIRED_OK`) |

```bash
export LABWIRED_HW_PORT=/dev/cu.usbmodem14101
pio run -d fixtures/hw-serial-esp32c3
pio run -d fixtures/hw-serial-esp32c3 -t upload
labwired serial-capture "$LABWIRED_HW_PORT" 115200 LABWIRED_OK 12
```

For any other chip: same pattern — your project, your port, your marker, then
`hw-promote` / `scripts/dev-cycle.sh`.
