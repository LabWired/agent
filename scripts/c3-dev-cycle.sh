#!/usr/bin/env bash
# ESP32-C3 same-binary loop: build once → twin oracle → flash desk → serial oracle.
# Produces hardware_observed + model-side uart_contains for THE SAME firmware.elf.
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
MAX_STEPS="${LABWIRED_C3_TWIN_STEPS:-200000000}"

export PATH="${HOME}/.local/bin:${HOME}/.cargo/bin:${PATH}"

if [[ ! -f "$WS/platformio.ini" ]]; then
  echo "c3-dev-cycle: missing $WS" >&2
  exit 2
fi
command -v pio >/dev/null || { echo "need pio" >&2; exit 2; }

mkdir -p "$WS/evidence"
EV="$WS/evidence"

echo "==> 1/4 build (single Arduino image)"
(cd "$WS" && pio run)
ELF="$WS/.pio/build/esp32-c3-devkitm-1/firmware.elf"
BIN="$WS/.pio/build/esp32-c3-devkitm-1/firmware.bin"
test -f "$ELF" && test -f "$BIN"

# 4MB flash image (bootloader + partitions + app) — required for --rom-boot twin
FLASH_IMG="$EV/flash.bin"
python3 - <<PY
from pathlib import Path
build = Path(r"""$WS""") / ".pio/build/esp32-c3-devkitm-1"
flash = bytearray(b"\xff" * (4 * 1024 * 1024))
for name, off in [("bootloader.bin", 0), ("partitions.bin", 0x8000), ("firmware.bin", 0x10000)]:
    data = (build / name).read_bytes()
    flash[off : off + len(data)] = data
Path(r"""$FLASH_IMG""").write_bytes(flash)
print("flash image", len(flash), "bytes")
PY

# system + stimuli for twin (same ELF)
CORE_CHIP="$CORE/configs/chips/esp32c3.yaml"
cat >"$WS/system.yaml" <<EOF
name: "esp32c3-dev-cycle"
chip: "$CORE_CHIP"
cpu_hz: 160_000_000
external_devices: []
board_io:
  - id: "status_led"
    kind: "led"
    peripheral: "gpio"
    pin: 8
    signal: "output"
    active_high: true
EOF

cat >"$WS/stimuli-smoke.yaml" <<EOF
schema_version: "1.2"
inputs:
  system: "$WS/system.yaml"
  firmware: "$ELF"
limits:
  max_steps: $MAX_STEPS
assertions:
  - uart_contains: "$MARKER"
  - expected_stop_reason: max_steps
EOF

TWIN_OK=0
SIM=""
if SIM="$(labwired_resolve_sim 2>/dev/null)"; then
  :
fi
ROM="$CORE/crates/core/roms/esp32c3/esp32c3_rom.bin"
DROM="$CORE/crates/core/roms/esp32c3/esp32c3_drom.bin"

if [[ -x "$SIM" && -f "$ROM" && -f "$DROM" && -f "$CORE_CHIP" ]]; then
  echo "==> 2/4 twin (SAME elf+flash, rom-boot, uart_contains $MARKER)"
  export LABWIRED_ESP32C3_ROM="$ROM"
  export LABWIRED_ESP32C3_ROM_DATA="$DROM"
  export LABWIRED_ESP32C3_FLASH="$FLASH_IMG"
  OUT="$EV/twin"
  rm -rf "$OUT" && mkdir -p "$OUT"
  set +e
  (cd "$CORE" && "$SIM" test --script "$WS/stimuli-smoke.yaml" --rom-boot --output-dir "$OUT") \
    >"$EV/twin-run.log" 2>&1
  trc=$?
  set -e
  if [[ -f "$OUT/result.json" ]] && grep -q "\"passed\": true" "$OUT/result.json" \
    && grep -q "$MARKER" "$OUT/uart.log" 2>/dev/null; then
    TWIN_OK=1
    echo "ok   twin uart_contains $MARKER (same binary)"
  else
    echo "FAIL twin (see $EV/twin-run.log uart.log)" >&2
    tail -20 "$EV/twin-run.log" >&2 || true
    cat "$OUT/uart.log" 2>/dev/null | tail -20 >&2 || true
  fi
else
  echo "warn twin skipped — need monorepo sim + ROM bins at $CORE"
fi

echo "==> 3/4 flash desk $PORT"
(cd "$WS" && pio run -t upload)

echo "==> 4/4 serial-capture (USB-CDC Serial)"
set +e
out="$(labwired_serial_capture "$PORT" 115200 "$MARKER" "$TIMEOUT")"
rc=$?
set -e
echo "$out" | tee "$EV/serial-capture.json"
HW_OK=0
if [[ "$rc" -eq 0 ]]; then
  HW_OK=1
  echo "ok   hardware_observed"
else
  echo "FAIL hardware_observed" >&2
fi

python3 - <<PY
import json
from pathlib import Path
ev = Path(r"""$EV""")
doc = {
  "firmware_elf": r"""$ELF""",
  "flash_image": r"""$FLASH_IMG""",
  "marker": r"""$MARKER""",
  "same_binary": True,
  "twin": {
    "ok": bool($TWIN_OK),
    "status": "uart_contains_pass" if $TWIN_OK else "failed_or_skipped",
    "note": "labwired-sim test --rom-boot on the same flash image + ELF",
  },
  "hardware": {
    "ok": bool($HW_OK),
    "status": "hardware_observed" if $HW_OK else "failed",
    "port": r"""$PORT""",
  },
  "model_verified": False,
  "model_verified_note": "labwired_verify MCP not invoked; twin used labwired-sim test uart_contains",
}
if $HW_OK:
    doc["status"] = "hardware_observed"
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

if [[ "$HW_OK" -eq 1 ]]; then
  labwired_assert_status hardware_observed <"$EV/hardware_observed.json"
fi

if [[ "$TWIN_OK" -eq 1 && "$HW_OK" -eq 1 ]]; then
  echo "ok   SAME BINARY: twin uart_contains + desk hardware_observed"
  exit 0
fi
echo "c3-dev-cycle incomplete twin=$TWIN_OK hw=$HW_OK" >&2
exit 1
