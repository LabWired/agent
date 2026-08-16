#!/usr/bin/env bash
# Run the connected-board runtime smoke matrix only after an explicit opt-in.
set -euo pipefail

if [[ "${LABWIRED_HIL:-}" != "1" ]]; then
  echo "LABWIRED_HIL=1 required; this command flashes connected hardware." >&2
  exit 2
fi

require_variable() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "$name required" >&2
    exit 2
  fi
}

require_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "$name is required but was not found on PATH" >&2
    exit 2
  fi
}

print_version() {
  local label="$1"
  shift
  local version
  if ! version="$("$@" 2>&1)"; then
    echo "unable to determine $label version" >&2
    exit 2
  fi
  printf '%s version: %s\n' "$label" "${version%%$'\n'*}"
}

require_variable LABWIRED_UART_DEVICE
require_variable LABWIRED_JTAG_SERIAL
require_variable LABWIRED_OPENOCD
require_variable LABWIRED_MATRIX_OUTPUT
require_command opencode
require_command codex
require_command claude
require_command pio

if [[ ! -x "$LABWIRED_OPENOCD" ]]; then
  echo "LABWIRED_OPENOCD must name an executable OpenOCD binary" >&2
  exit 2
fi

if [[ -d /Volumes/LabWired && -w /Volumes/LabWired ]]; then
  temporary_root="$(mktemp -d /Volumes/LabWired/twin2silicon-runtime-smoke.XXXXXX)"
else
  temporary_root="$(mktemp -d)"
fi
trap 'rm -rf "$temporary_root"' EXIT
export TMPDIR="$temporary_root"

print_version opencode opencode --version
print_version codex codex --version
print_version claude claude --version
print_version pio pio --version
print_version openocd "$LABWIRED_OPENOCD" --version

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
task="${LABWIRED_TASK:-esp32s3-gpio-hil-001}"
identity_command_json="$(python3 - "$repository_root/benchmarks/twin2silicon/identify_pio_device.py" "$LABWIRED_UART_DEVICE" "$LABWIRED_JTAG_SERIAL" <<'PY'
import json
import sys

print(json.dumps([sys.executable, sys.argv[1], "--uart-device", sys.argv[2],
                  "--jtag-serial", sys.argv[3]]))
PY
)"

python3 "$repository_root/benchmarks/twin2silicon/run_matrix.py" \
  --task "$task" \
  --output "$LABWIRED_MATRIX_OUTPUT" \
  --jtag-serial "$LABWIRED_JTAG_SERIAL" \
  --uart-device "$LABWIRED_UART_DEVICE" \
  --openocd "$LABWIRED_OPENOCD" \
  --identity-command-json "$identity_command_json"
