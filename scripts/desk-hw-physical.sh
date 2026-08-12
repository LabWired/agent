#!/usr/bin/env bash
# Physical desk E2E (product depth Task 9) — no soft pass without probe.
#
# Exit codes:
#   0  — flash + serial marker → hardware_observed (real probe path)
#   2  — NEED_PROBE (no physical probe listed)
#   1  — probe present but flash/capture/assert failed
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export LABWIRED_AGENT_HOME="${LABWIRED_AGENT_HOME:-$ROOT}"
# shellcheck source=lib/assert-status.sh
source "$ROOT/lib/assert-status.sh"
# shellcheck source=lib/serial-capture.sh
source "$ROOT/lib/serial-capture.sh"
# shellcheck source=lib/probe.sh
source "$ROOT/lib/probe.sh" 2>/dev/null || true

export PATH="${ROOT}/bin:${HOME}/.local/bin:${HOME}/.cargo/bin:${PATH}"

ELF="${LABWIRED_HW_ELF:-}"
CHIP="${LABWIRED_HW_CHIP:-}"
PORT="${LABWIRED_HW_PORT:-}"
MARKER="${LABWIRED_HW_MARKER:-LABWIRED_OK}"
BAUD="${LABWIRED_HW_BAUD:-115200}"
TIMEOUT="${LABWIRED_HW_TIMEOUT:-8}"
OUT="${LABWIRED_HW_OUT:-$ROOT/fixtures/coverage/smoke/desk-hw-physical}"
mkdir -p "$OUT"

# --- probe presence (hard fail closed) ---
PROBE_LIST_OUT="$OUT/probe-list.txt"
if [[ "${LABWIRED_HW_FORCE_NEED_PROBE:-0}" == "1" ]]; then
  echo "NEED_PROBE" >&2
  echo "desk-hw-physical: forced NEED_PROBE (LABWIRED_HW_FORCE_NEED_PROBE=1)" >&2
  exit 2
fi
set +e
if command -v probe-rs >/dev/null 2>&1; then
  probe-rs list >"$PROBE_LIST_OUT" 2>&1
  prs_rc=$?
else
  echo "probe-rs not on PATH" >"$PROBE_LIST_OUT"
  prs_rc=1
fi
set -e

# probe-rs list prints "No probes found" or empty when none attached
if [[ "$prs_rc" -ne 0 ]] \
  || grep -Eiq 'no probes? found|0 probes|none found' "$PROBE_LIST_OUT" \
  || ! grep -Eiq 'probe|cmsis|jlink|stlink|dap|vid:|pid:' "$PROBE_LIST_OUT"; then
  echo "NEED_PROBE" >&2
  echo "desk-hw-physical: no physical probe (probe-rs list empty). Attach a probe or use UART-only serial-capture fixture." >&2
  cat "$PROBE_LIST_OUT" >&2 || true
  exit 2
fi

if [[ -z "$ELF" || -z "$CHIP" || -z "$PORT" ]]; then
  echo "usage: LABWIRED_HW_ELF=… LABWIRED_HW_CHIP=… LABWIRED_HW_PORT=… $0" >&2
  echo "  probe is present but flash env incomplete" >&2
  exit 1
fi
if [[ ! -f "$ELF" ]]; then
  echo "desk-hw-physical: ELF not found: $ELF" >&2
  exit 1
fi

LABWIRED="${LABWIRED:-$ROOT/bin/labwired-agent}"
echo "==> physical flash $ELF chip=$CHIP"
if ! "$LABWIRED" probe flash "$ELF" --chip "$CHIP" >"$OUT/flash.txt" 2>&1; then
  echo "desk-hw-physical: flash failed" >&2
  cat "$OUT/flash.txt" >&2
  exit 1
fi

echo "==> serial-capture port=$PORT marker=$MARKER"
if ! labwired_serial_capture "$PORT" "$BAUD" "$MARKER" "$TIMEOUT" \
  >"$OUT/serial-capture.json" 2>"$OUT/serial-capture.err"; then
  echo "desk-hw-physical: serial-capture failed" >&2
  cat "$OUT/serial-capture.err" >&2 || true
  exit 1
fi

# Dual claim: must be hardware_observed, never model_verified
if ! labwired_assert_status hardware_observed <"$OUT/serial-capture.json"; then
  echo "desk-hw-physical: expected hardware_observed" >&2
  cat "$OUT/serial-capture.json" >&2
  exit 1
fi
if labwired_assert_status model_verified <"$OUT/serial-capture.json" 2>/dev/null; then
  echo "desk-hw-physical: refuse model_verified on desk path" >&2
  exit 1
fi

echo "ok   desk-hw-physical → hardware_observed (not twin green)"
exit 0
