#!/usr/bin/env bash
# Compat shim → generic scripts/profiles/esp32c3-serial.sh
# Prefer: scripts/dev-cycle.sh with LABWIRED_HW_* env.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "$ROOT/scripts/profiles/esp32c3-serial.sh" "$@"
