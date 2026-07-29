#!/usr/bin/env bash
# Example board profile — ESP32-C3 USB-CDC serial hello.
# Not the product: one optional canary among many. Prefer scripts/dev-cycle.sh
# with your own LABWIRED_HW_* for any board.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CORE="${LABWIRED_CORE_SRC:-$HOME/Projects/labwired/core}"

export LABWIRED_HW_WS="${LABWIRED_HW_WS:-$ROOT/examples/esp32c3-serial}"
export LABWIRED_HW_MARKER="${LABWIRED_HW_MARKER:-LABWIRED_OK}"
export LABWIRED_HW_CHIP="${LABWIRED_HW_CHIP:-esp32c3}"
export LABWIRED_HW_SYSTEM="${LABWIRED_HW_SYSTEM:-$CORE/validation/arduino-matrix/systems/esp32c3.yaml}"
# Port: LABWIRED_HW_PORT or auto-detect inside dev-cycle

exec "$ROOT/scripts/dev-cycle.sh" "$@"
