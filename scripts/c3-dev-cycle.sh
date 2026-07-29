#!/usr/bin/env bash
# Universal ESP32-C3 loop: ONE Arduino build → twin (matrix-style) → desk flash.
# No bare-metal demo ELFs. No Serial0 dual-print. Marker is plain Serial.println.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/serial-capture.sh
source "$ROOT/lib/serial-capture.sh"
# shellcheck source=lib/assert-status.sh
source "$ROOT/lib/assert-status.sh"
# shellcheck source=lib/resolve-sim.sh
source "$ROOT/lib/resolve-sim.sh"

WS="${LABWIRED_C3_WS:-$ROOT/workspaces/esp32c3-dev-cycle}"
PORT="${LABWIRED_HW_PORT:-${LABWIRED_C3_PORT:-/dev/cu.usbmodem11301}}"
MARKER="${LABWIRED_C3_MARKER:-LABWIRED_C3_CYCLE_OK}"
TIMEOUT="${LABWIRED_C3_TIMEOUT:-12}"
CORE="${LABWIRED_CORE_SRC:-$HOME/Projects/labwired/core}"
# arduino-matrix C3 budget
MAX_STEPS="${LABWIRED_C3_TWIN_STEPS:-50000000}"

export PATH="${HOME}/.local/bin:${HOME}/.cargo/bin:${PATH}"

[[ -f "$WS/platformio.ini" ]] || { echo "missing $WS" >&2; exit 2; }
command -v pio >/dev/null || { echo "need pio" >&2; exit 2; }

mkdir -p "$WS/evidence"
EV="$WS/evidence"

echo "==> 1/3 build (single universal Arduino image)"
(cd "$WS" && pio run)
ELF="$(find "$WS/.pio/build" -name firmware.elf | head -1)"
test -n "$ELF" && test -f "$ELF"
echo "    elf=$ELF"

# Prefer monorepo labwired binary (matrix path); fall back to labwired-sim
SIM=""
if [[ -x "$CORE/target/release/labwired" ]]; then
  SIM="$CORE/target/release/labwired"
elif SIM="$(labwired_resolve_sim 2>/dev/null)"; then
  :
fi

SYS="${LABWIRED_C3_SYSTEM:-$CORE/validation/arduino-matrix/systems/esp32c3.yaml}"
if [[ ! -f "$SYS" ]]; then
  SYS="$CORE/configs/systems/esp32c3-devkit.yaml"
fi

# Universal twin script — same shape as arduino-matrix (NO --rom-boot, NO custom flash.bin)
SCRIPT="$EV/twin-test.yaml"
cat >"$SCRIPT" <<EOF
schema_version: "1.0"
inputs:
  firmware: "$ELF"
  system: "$(cd "$(dirname "$SYS")" && pwd)/$(basename "$SYS")"
limits:
  max_steps: $MAX_STEPS
assertions:
  - uart_contains: "$MARKER"
EOF
# system path must resolve chip relative to systems/ dir
if [[ -f "$CORE/validation/arduino-matrix/systems/esp32c3.yaml" ]]; then
  cat >"$SCRIPT" <<EOF
schema_version: "1.0"
inputs:
  firmware: "$ELF"
  system: "$CORE/validation/arduino-matrix/systems/esp32c3.yaml"
limits:
  max_steps: $MAX_STEPS
assertions:
  - uart_contains: "$MARKER"
EOF
fi

TWIN_OK=0
if [[ -x "$SIM" && -f "$CORE/validation/arduino-matrix/systems/esp32c3.yaml" ]]; then
  echo "==> 2/3 twin (SAME elf, matrix-style labwired test — universal Serial)"
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
else
  echo "warn twin skipped (need $CORE/target/release/labwired + arduino-matrix system)"
fi

echo "==> 3/3 desk flash + serial (SAME elf)"
(cd "$WS" && pio run -t upload)
set +e
out="$(labwired_serial_capture "$PORT" 115200 "$MARKER" "$TIMEOUT")"
rc=$?
set -e
echo "$out" | tee "$EV/serial-capture.json"
HW_OK=0
[[ "$rc" -eq 0 ]] && HW_OK=1 && echo "ok   hardware_observed"

python3 - <<PY
import json
from pathlib import Path
ev = Path(r"""$EV""")
doc = {
  "firmware_elf": r"""$ELF""",
  "marker": r"""$MARKER""",
  "same_binary": True,
  "universal_sketch": True,
  "twin": {"ok": bool($TWIN_OK), "path": "labwired test (arduino-matrix style)"},
  "hardware": {"ok": bool($HW_OK), "port": r"""$PORT"""},
  "status": "hardware_observed" if $HW_OK else "failed",
}
(ev / "cycle-result.json").write_text(json.dumps(doc, indent=2) + "\n")
if $HW_OK:
    (ev / "hardware_observed.json").write_text(json.dumps({
        "status": "hardware_observed",
        "chip": "esp32c3",
        "port": r"""$PORT""",
        "marker": r"""$MARKER""",
        "same_binary_twin": bool($TWIN_OK),
    }, indent=2) + "\n")
print(json.dumps(doc, indent=2))
PY

[[ "$HW_OK" -eq 1 ]] && labwired_assert_status hardware_observed <"$EV/hardware_observed.json"

if [[ "$TWIN_OK" -eq 1 && "$HW_OK" -eq 1 ]]; then
  echo "ok   UNIVERSAL same-binary: twin + desk"
  exit 0
fi
echo "incomplete twin=$TWIN_OK hw=$HW_OK" >&2
exit 1
