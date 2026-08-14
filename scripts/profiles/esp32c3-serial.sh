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
export LABWIRED_HW_ENV="${LABWIRED_HW_ENV:-esp32-c3-devkitm-1}"
# Prefer agent catalog (no monorepo); fall back to core arduino-matrix
if [[ -z "${LABWIRED_HW_SYSTEM:-}" ]]; then
  # shellcheck source=lib/resolve-catalog.sh
  source "$ROOT/lib/resolve-catalog.sh"
  export LABWIRED_AGENT_HOME="${LABWIRED_AGENT_HOME:-$ROOT}"
  if SYS="$(labwired_catalog_system esp32c3 2>/dev/null)"; then
    export LABWIRED_HW_SYSTEM="$SYS"
  elif [[ -f "$CORE/validation/arduino-matrix/systems/esp32c3.yaml" ]]; then
    export LABWIRED_HW_SYSTEM="$CORE/validation/arduino-matrix/systems/esp32c3.yaml"
  fi
fi

exec "$ROOT/scripts/dev-cycle.sh" "$@"
