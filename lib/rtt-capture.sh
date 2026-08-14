#!/usr/bin/env bash
# rtt-capture.sh — RTT marker capture → same claim JSON shape as serial-capture.
# shellcheck shell=bash
#
# Usage:
#   labwired_rtt_capture --chip <id> --probe <selector> [--elf path] [--marker M] [--timeout S]
#
# Exit:
#   0  marker observed → prints hardware_observed JSON
#   2  NEED_RTT (probe-rs missing, no RTT, or fixture not provided)
#   1  RTT available but marker not seen
#
# Fixture (CI / no hardware):
#   LABWIRED_RTT_FIXTURE=<file of RTT log text>

labwired_rtt_capture() {
  local chip=""
  local elf=""
  local probe_sel=""
  local marker="${LABWIRED_HW_MARKER:-LABWIRED_OK}"
  local timeout="${LABWIRED_RTT_TIMEOUT:-8}"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --chip) chip="${2:-}"; shift 2 || true ;;
      --elf) elf="${2:-}"; shift 2 || true ;;
      --probe) probe_sel="${2:-}"; shift 2 || true ;;
      --marker) marker="${2:-}"; shift 2 || true ;;
      --timeout) timeout="${2:-}"; shift 2 || true ;;
      -h|--help)
        echo "usage: labwired_rtt_capture --chip <id> --probe <selector> [--elf path] [--marker M] [--timeout S]"
        return 0
        ;;
      *) echo "rtt-capture: unknown argument $1" >&2; return 2 ;;
    esac
  done
  [[ -n "$probe_sel" ]] || { echo "rtt-capture: --probe is required" >&2; return 2; }

  # Fixture path: same JSON contract as UART without inventing hardware
  if [[ -n "${LABWIRED_RTT_FIXTURE:-}" && -f "${LABWIRED_RTT_FIXTURE}" ]]; then
    export LABWIRED_SERIAL_FIXTURE="$LABWIRED_RTT_FIXTURE"
    # shellcheck source=lib/serial-capture.sh
    source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/serial-capture.sh"
    local fixture_result="" fixture_rc=0
    fixture_result="$(labwired_serial_capture "-" 115200 "$marker" "$timeout")" || fixture_rc=$?
    [[ "$fixture_rc" -eq 0 ]] || { printf '%s\n' "$fixture_result"; return "$fixture_rc"; }
    LABWIRED_RTT_RESULT="$fixture_result" LABWIRED_RTT_PROBE="$probe_sel" node -e 'const v=JSON.parse(process.env.LABWIRED_RTT_RESULT);v.path="rtt";v.probeSerial=process.env.LABWIRED_RTT_PROBE;console.log(JSON.stringify(v))'
    return 0
  fi

  local prs
  if ! command -v probe-rs >/dev/null 2>&1; then
    echo "NEED_RTT" >&2
    echo "rtt-capture: probe-rs not installed" >&2
    return 2
  fi
  prs="$(command -v probe-rs)"

  # probe-rs rtt is not universally available / chip-support varies
  if ! "$prs" rtt --help >/dev/null 2>&1 && ! "$prs" attach --help >/dev/null 2>&1; then
    echo "NEED_RTT" >&2
    echo "rtt-capture: probe-rs has no rtt/attach; use UART serial-capture" >&2
    return 2
  fi

  # Without a live attach recipe + known working chip, refuse soft success.
  # Callers must set LABWIRED_RTT_FIXTURE for CI or implement chip-specific attach.
  if [[ -z "${LABWIRED_RTT_ALLOW_LIVE:-}" ]]; then
    echo "NEED_RTT" >&2
    echo "rtt-capture: live RTT attach not enabled (set LABWIRED_RTT_ALLOW_LIVE=1 + probe + elf for experimental path)" >&2
    echo "  or LABWIRED_RTT_FIXTURE=path for the same claim JSON as UART" >&2
    return 2
  fi

  if [[ -z "$chip" ]]; then
    echo "rtt-capture: --chip required for live path" >&2
    return 2
  fi

  # Experimental: run attach with timeout and scan stdout for marker (best-effort).
  local out
  out="$(mktemp)"
  set +e
  local args=(attach --chip "$chip" --probe "$probe_sel")
  [[ -n "$elf" ]] && args+=(--elf "$elf")
  timeout "${timeout}" "$prs" "${args[@]}" >"$out" 2>&1
  set -e
  if grep -Fq "$marker" "$out"; then
    python3 - <<PY
import json
from pathlib import Path
text = Path(r"""$out""").read_text(errors="replace")
print(json.dumps({
  "status": "hardware_observed",
  "path": "rtt",
  "marker": r"""$marker""",
  "matched": True,
  "excerpt": text[:500],
  "chip": r"""$chip""",
  "probeSerial": r"""$probe_sel""",
}, indent=2))
PY
    rm -f "$out"
    return 0
  fi
  echo "rtt-capture: marker not observed within ${timeout}s" >&2
  head -40 "$out" >&2 || true
  rm -f "$out"
  return 1
}
