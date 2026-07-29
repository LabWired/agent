#!/usr/bin/env bash
# One-shot ESP32-C3 desk loop: build → flash → serial oracle → claim JSON.
# No twin claim unless LABWIRED_TWIN=1 and sim path succeeds.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/serial-capture.sh
source "$ROOT/lib/serial-capture.sh"
# shellcheck source=lib/assert-status.sh
source "$ROOT/lib/assert-status.sh"

WS="${LABWIRED_C3_WS:-$ROOT/workspaces/esp32c3-dev-cycle}"
PORT="${LABWIRED_HW_PORT:-${LABWIRED_C3_PORT:-/dev/cu.usbmodem11301}}"
MARKER="${LABWIRED_C3_MARKER:-LABWIRED_C3_CYCLE_OK}"
TIMEOUT="${LABWIRED_C3_TIMEOUT:-12}"

if [[ ! -f "$WS/platformio.ini" ]]; then
  echo "c3-dev-cycle: missing $WS/platformio.ini — create project first" >&2
  exit 2
fi

export PATH="${HOME}/.local/bin:${PATH}"
command -v pio >/dev/null || { echo "need pio on PATH" >&2; exit 2; }

echo "==> build $WS"
(cd "$WS" && pio run)

echo "==> flash $PORT"
(cd "$WS" && pio run -t upload)

echo "==> serial-capture marker=$MARKER"
mkdir -p "$WS/evidence"
set +e
out="$(labwired_serial_capture "$PORT" 115200 "$MARKER" "$TIMEOUT")"
rc=$?
set -e
echo "$out" | tee "$WS/evidence/serial-capture.json"

if [[ "$rc" -ne 0 ]]; then
  echo "FAIL hardware_observed (serial marker not seen)" >&2
  exit 1
fi

python3 - <<PY
import json
from pathlib import Path
ws = Path(r"""$WS""") / "evidence"
doc = {
  "status": "hardware_observed",
  "chip": "esp32c3",
  "port": r"""$PORT""",
  "marker": r"""$MARKER""",
  "flash": "pio upload",
  "model_verified": False,
  "capture": json.loads(r'''$out'''),
}
(ws / "hardware_observed.json").write_text(json.dumps(doc, indent=2) + "\n")
print("wrote", ws / "hardware_observed.json")
PY

labwired_assert_status hardware_observed <"$WS/evidence/hardware_observed.json"
echo "ok   c3-dev-cycle: hardware_observed"

# Optional twin smoke (bare-metal demo ELF — not the Arduino app binary)
if [[ "${LABWIRED_C3_TWIN:-0}" == "1" ]]; then
  CORE="${LABWIRED_CORE_SRC:-$HOME/Projects/labwired/core}"
  SIM="$(command -v labwired-sim || true)"
  if [[ -x "$SIM" && -f "$CORE/tests/fixtures/esp32c3-demo.elf" ]]; then
    echo "==> twin smoke (demo ELF, not Arduino image)"
    (cd "$CORE" && "$SIM" --firmware tests/fixtures/esp32c3-demo.elf \
      --system configs/systems/esp32c3-devkit.yaml --max-steps 50000) \
      | tee "$WS/evidence/twin-demo.txt" || true
    if grep -q ESP "$WS/evidence/twin-demo.txt" 2>/dev/null; then
      echo "ok   twin demo printed ESP (still not model_verified for Arduino app)"
    fi
  fi
fi
