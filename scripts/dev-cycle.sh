#!/usr/bin/env bash
# Generic same-binary cycle: build → optional twin → flash → serial marker.
#
# Board-agnostic. All target specifics come from env (or a thin board profile).
# Product surface: any chip that can build (PIO), twin-test, and serial-capture.
#
# Required:
#   LABWIRED_HW_WS       Path to PlatformIO project (platformio.ini + src/)
#
# Common:
#   LABWIRED_HW_PORT     Serial device (default: first cu.usbmodem*/ttyUSB*/ttyACM*)
#   LABWIRED_HW_MARKER   Serial oracle string (default: LABWIRED_OK)
#   LABWIRED_HW_BAUD     Capture baud (default: 115200)
#   LABWIRED_HW_TIMEOUT  Capture seconds (default: 12)
#   LABWIRED_HW_CHIP     Chip id for evidence (optional)
#   LABWIRED_HW_SYSTEM   Twin system YAML (optional — skips twin if missing)
#   LABWIRED_CORE_SRC    Monorepo core root for twin CLI
#   LABWIRED_HW_TWIN_STEPS  Twin max_steps (default: 50000000)
#   LABWIRED_HW_SKIP_TWIN=1  Desk-only
#   LABWIRED_HW_SKIP_FLASH=1 Twin/build only
#
# Compat aliases (deprecated): LABWIRED_C3_* → same fields.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/serial-capture.sh
source "$ROOT/lib/serial-capture.sh"
# shellcheck source=lib/assert-status.sh
source "$ROOT/lib/assert-status.sh"
# shellcheck source=lib/resolve-sim.sh
source "$ROOT/lib/resolve-sim.sh"

WS="${LABWIRED_HW_WS:-${LABWIRED_C3_WS:-}}"
PORT="${LABWIRED_HW_PORT:-${LABWIRED_C3_PORT:-}}"
MARKER="${LABWIRED_HW_MARKER:-${LABWIRED_C3_MARKER:-LABWIRED_OK}}"
BAUD="${LABWIRED_HW_BAUD:-115200}"
TIMEOUT="${LABWIRED_HW_TIMEOUT:-${LABWIRED_C3_TIMEOUT:-12}}"
CHIP="${LABWIRED_HW_CHIP:-unknown}"
CORE="${LABWIRED_CORE_SRC:-$HOME/Projects/labwired/core}"
MAX_STEPS="${LABWIRED_HW_TWIN_STEPS:-${LABWIRED_C3_TWIN_STEPS:-50000000}}"
SYS="${LABWIRED_HW_SYSTEM:-${LABWIRED_C3_SYSTEM:-}}"
SKIP_TWIN="${LABWIRED_HW_SKIP_TWIN:-0}"
SKIP_FLASH="${LABWIRED_HW_SKIP_FLASH:-0}"

export PATH="${HOME}/.local/bin:${HOME}/.cargo/bin:${PATH}"

# shellcheck source=lib/resolve-catalog.sh
source "$ROOT/lib/resolve-catalog.sh"
export LABWIRED_AGENT_HOME="${LABWIRED_AGENT_HOME:-$ROOT}"
if [[ -z "$SYS" && -n "${CHIP:-}" && "$CHIP" != "unknown" ]]; then
  SYS="$(labwired_catalog_system "$CHIP" 2>/dev/null || true)"
fi

if [[ -z "$WS" ]]; then
  cat >&2 <<'EOF'
dev-cycle: set LABWIRED_HW_WS to a PlatformIO project directory.

Example (ESP32-C3 canary profile):
  LABWIRED_HW_WS=$PWD/examples/esp32c3-serial \
  LABWIRED_HW_SYSTEM=$HOME/Projects/labwired/core/validation/arduino-matrix/systems/esp32c3.yaml \
  LABWIRED_HW_CHIP=esp32c3 \
  scripts/dev-cycle.sh

Or use a thin profile: scripts/profiles/esp32c3-serial.sh
EOF
  exit 2
fi

WS="$(cd "$WS" && pwd)"
[[ -f "$WS/platformio.ini" ]] || { echo "dev-cycle: missing $WS/platformio.ini" >&2; exit 2; }
command -v pio >/dev/null || { echo "dev-cycle: need pio (PlatformIO)" >&2; exit 2; }

if [[ -z "$PORT" ]]; then
  PORT="$(ls /dev/cu.usbmodem* /dev/ttyUSB* /dev/ttyACM* 2>/dev/null | head -1 || true)"
fi

mkdir -p "$WS/evidence"
EV="$WS/evidence"

echo "==> 1/3 build  ws=$WS"
(cd "$WS" && pio run)
ELF="$(find "$WS/.pio/build" -name firmware.elf 2>/dev/null | head -1)"
test -n "$ELF" && test -f "$ELF"
echo "    elf=$ELF  marker=$MARKER  chip=$CHIP"

SIM=""
if [[ -x "$CORE/target/release/labwired" ]]; then
  SIM="$CORE/target/release/labwired"
elif SIM="$(labwired_resolve_sim 2>/dev/null)"; then
  :
fi

TWIN_OK=0
if [[ "$SKIP_TWIN" == "1" ]]; then
  echo "==> 2/3 twin not run (LABWIRED_HW_SKIP_TWIN=1)"
elif [[ -z "$SYS" || ! -f "$SYS" ]]; then
  echo "==> 2/3 twin not run (set LABWIRED_HW_SYSTEM to a twin system YAML)"
elif [[ ! -x "$SIM" ]]; then
  echo "==> 2/3 twin not run (no labwired CLI; set LABWIRED_CORE_SRC or install sim)"
else
  echo "==> 2/3 twin (same ELF, labwired test)"
  SCRIPT="$EV/twin-test.yaml"
  cat >"$SCRIPT" <<EOF
schema_version: "1.0"
inputs:
  firmware: "$ELF"
  system: "$SYS"
limits:
  max_steps: $MAX_STEPS
assertions:
  - uart_contains: "$MARKER"
EOF
  OUT="$EV/twin"
  rm -rf "$OUT" && mkdir -p "$OUT"
  set +e
  (cd "$CORE" && "$SIM" test --script "$SCRIPT" --output-dir "$OUT" --no-uart-stdout) \
    >"$EV/twin-run.log" 2>&1
  set -e
  if [[ -f "$OUT/result.json" ]] && grep -q '"passed": true' "$OUT/result.json" \
    && grep -q "$MARKER" "$OUT/uart.log" 2>/dev/null; then
    TWIN_OK=1
    echo "ok   twin uart_contains $MARKER"
  else
    echo "FAIL twin — see $EV/twin-run.log" >&2
    tail -30 "$EV/twin-run.log" >&2 || true
    cat "$OUT/uart.log" 2>/dev/null | tail -20 >&2 || true
  fi
fi

HW_OK=0
if [[ "$SKIP_FLASH" == "1" ]]; then
  echo "==> 3/3 desk not run (LABWIRED_HW_SKIP_FLASH=1)"
else
  if [[ -z "$PORT" ]]; then
    echo "dev-cycle: set LABWIRED_HW_PORT (no serial device found)" >&2
    exit 2
  fi
  echo "==> 3/3 desk flash + serial  port=$PORT"
  (cd "$WS" && pio run -t upload)
  set +e
  out="$(labwired_serial_capture "$PORT" "$BAUD" "$MARKER" "$TIMEOUT")"
  rc=$?
  set -e
  echo "$out" | tee "$EV/serial-capture.json"
  [[ "$rc" -eq 0 ]] && HW_OK=1 && echo "ok   hardware_observed"
fi

python3 - <<PY
import json
from pathlib import Path
ev = Path(r"""$EV""")
doc = {
  "firmware_elf": r"""$ELF""",
  "marker": r"""$MARKER""",
  "chip": r"""$CHIP""",
  "same_binary": True,
  "generic": True,
  "twin": {"ok": bool($TWIN_OK), "system": r"""$SYS"""},
  "hardware": {"ok": bool($HW_OK), "port": r"""$PORT"""},
  "status": "hardware_observed" if $HW_OK else ("model_path_only" if $TWIN_OK else "failed"),
}
(ev / "cycle-result.json").write_text(json.dumps(doc, indent=2) + "\n")
if $HW_OK:
    (ev / "hardware_observed.json").write_text(json.dumps({
        "status": "hardware_observed",
        "chip": r"""$CHIP""",
        "port": r"""$PORT""",
        "marker": r"""$MARKER""",
        "same_binary_twin": bool($TWIN_OK),
    }, indent=2) + "\n")
print(json.dumps(doc, indent=2))
PY

if [[ "$HW_OK" -eq 1 ]]; then
  labwired_assert_status hardware_observed <"$EV/hardware_observed.json"
fi

if [[ "$TWIN_OK" -eq 1 && "$HW_OK" -eq 1 ]]; then
  echo "ok   same-binary: twin + desk"
  exit 0
fi
if [[ "$SKIP_FLASH" == "1" && "$TWIN_OK" -eq 1 ]]; then
  echo "ok   twin only (desk not run)"
  exit 0
fi
if [[ "$SKIP_TWIN" == "1" && "$HW_OK" -eq 1 ]]; then
  echo "ok   desk only (twin not run)"
  exit 0
fi
echo "incomplete twin=$TWIN_OK hw=$HW_OK" >&2
exit 1
