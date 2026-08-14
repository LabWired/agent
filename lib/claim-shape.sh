#!/usr/bin/env bash
# claim-shape.sh — hardware claim shape. The ONLY place that decides whether a
# flash + serial marker adds up to hardware_observed.
# shellcheck shell=bash
#
# Usage: labwired_claim_shape [--flashed 0|1] [--marker-matched 0|1] [--status S]
#
# Rules (unchanged from the RPC server implementation this replaces):
#   --status model_verified  → REFUSED. model_verified is twin-only and is never
#                              upgraded from hardware evidence.
#   flashed AND marker       → hardware_observed  (exit 0)
#   anything else            → failed             (exit 1)
#
# Prints the claim payload as JSON on stdout. Refusal prints to stderr, exit 1.

labwired_claim_shape() {
  local flashed=0 marker=0 status=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --flashed) flashed="${2:-0}"; shift 2 ;;
      --marker-matched) marker="${2:-0}"; shift 2 ;;
      --status) status="${2:-}"; shift 2 ;;
      *) shift ;;
    esac
  done

  if [[ "$status" == "model_verified" ]]; then
    echo "claim-shape: refused — cannot claim model_verified from flash/serial. Use twin labwired_verify only." >&2
    return 1
  fi

  # Accept 1/yes/true as set; everything else (including empty) is unset.
  # tr, not ${x,,} — macOS ships bash 3.2 and would fail with "bad substitution".
  local f=0 m=0
  case "$(printf '%s' "$flashed" | tr '[:upper:]' '[:lower:]')" in 1|yes|true) f=1 ;; esac
  case "$(printf '%s' "$marker" | tr '[:upper:]' '[:lower:]')" in 1|yes|true) m=1 ;; esac

  local out
  out="$(FLASHED="$f" MARKER="$m" python3 -c '
import json, os
flashed = os.environ["FLASHED"] == "1"
marker = os.environ["MARKER"] == "1"
status = "hardware_observed" if (flashed and marker) else "failed"
print(json.dumps({
    "status": status,
    "path": "hardware",
    "flashed": flashed,
    "marker_matched": marker,
    "claim": status if status == "hardware_observed" else "no_hardware_claim",
    "note": "model_verified is twin-only; never upgraded from hardware_observed",
}, indent=2))
')" || return 1
  printf '%s\n' "$out"

  [[ "$f" == "1" && "$m" == "1" ]]
}
