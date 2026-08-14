#!/usr/bin/env bash
# promote.sh — desk promote pipeline: flash → serial marker → claim.
# shellcheck shell=bash
#
# Usage:
#   labwired agent promote [--elf PATH] [--chip NAME] [--target virtual|probe|auto]
#                          [--port PORT] [--marker TEXT] [--baud N] [--timeout SEC]
#                          [--confirm 1] [--dry-run 1]
#                          [--flashed 0|1] [--marker-matched 0|1]
#
# This is the ONLY promote orchestrator. The RPC server's hw_promote is a plain
# argv row onto this subcommand — a second orchestrator in JS is how the editor
# ends up promoting on evidence the terminal would refuse.
#
# Order of work (unchanged from the JS this replaces):
#   1. gate    — a physical target needs --confirm 1 (or LABWIRED_FLASH_AUTO=1)
#   2. flash   — `labwired probe flash`; skipped under --dry-run 1
#   3. capture — `labwired serial-capture`; only with a --port on a physical
#                target. A virtual target NEVER produces a marker match.
#   4. claim   — lib/claim-shape.sh decides; its exit code is this command's.
#
# Empty flag values mean "not supplied" so the RPC argv row can pass every flag
# unconditionally, exactly like the JS `String(params.x || default)` it replaces.
#
# Output: three sections on stdout — `=== flash ===`, `=== capture ===`,
# `=== claim ===`. Exit: claim-shape's code (0 only on hardware_observed),
# or 2 when the confirm/elf gates refuse before anything ran.

_LABWIRED_PROMOTE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# JS String.prototype.trim() in bash 3.2 — no ${x,,}, no mapfile, no subprocess.
_labwired_promote_trim() {
  local s="$1"
  while [[ -n "$s" && "$s" == [[:space:]]* ]]; do s="${s#?}"; done
  while [[ -n "$s" && "$s" == *[[:space:]] ]]; do s="${s%?}"; done
  printf '%s' "$s"
}

_labwired_promote_lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

# The CLI used for the nested flash / capture steps. Same kit as this lib.
_labwired_promote_cli() {
  if [[ -n "${LABWIRED_AGENT_BIN:-}" ]]; then
    printf '%s' "$LABWIRED_AGENT_BIN"
    return 0
  fi
  printf '%s' "$(cd "$_LABWIRED_PROMOTE_LIB_DIR/.." && pwd)/bin/labwired-agent"
}

labwired_promote() {
  local elf="" chip="" target="" port="" marker="" baud="" timeout="" confirm=""
  local dry_run="" flashed_in="" marker_in=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --elf) elf="${2:-}"; shift 2 ;;
      --chip) chip="${2:-}"; shift 2 ;;
      --target) target="${2:-}"; shift 2 ;;
      --port) port="${2:-}"; shift 2 ;;
      --marker) marker="${2:-}"; shift 2 ;;
      --baud) baud="${2:-}"; shift 2 ;;
      --timeout) timeout="${2:-}"; shift 2 ;;
      --confirm) confirm="${2:-}"; shift 2 ;;
      --flashed) flashed_in="${2:-}"; shift 2 ;;
      --marker-matched) marker_in="${2:-}"; shift 2 ;;
      --dry-run)
        # Bare `--dry-run` from a terminal means 1; the RPC row always passes a
        # value, which may be the empty string (= not a dry run).
        if [[ $# -ge 2 && "$2" != --* ]]; then
          dry_run="$2"; shift 2
        else
          dry_run="1"; shift
        fi
        ;;
      *) shift ;;
    esac
  done

  # Empty means unset — same defaults the RPC server applied before.
  [[ -n "$chip" ]] || chip="esp32c3"
  [[ -n "$target" ]] || target="virtual"
  [[ -n "$marker" ]] || marker="LABWIRED_OK"
  [[ -n "$baud" ]] || baud="115200"
  [[ -n "$timeout" ]] || timeout="8"
  target="$(_labwired_promote_lower "$target")"
  confirm="$(_labwired_promote_lower "$confirm")"

  local confirmed=0
  case "$confirm" in 1|yes|true) confirmed=1 ;; esac
  local is_virtual=0
  case "$target" in virtual|sim|twin) is_virtual=1 ;; esac

  if [[ "$is_virtual" -eq 0 && "$confirmed" -eq 0 && "${LABWIRED_FLASH_AUTO:-}" != "1" ]]; then
    echo "promote: physical target requires confirm=1 after user approval (or target=virtual)." >&2
    return 2
  fi
  if [[ -z "$elf" && -z "$dry_run" ]]; then
    echo "promote: elf path required (or dry_run=1 for claim-shape dry run)" >&2
    return 2
  fi

  local out_f err_f
  out_f="$(mktemp -t labwired-promote-out)"
  err_f="$(mktemp -t labwired-promote-err)"

  local cli rc
  cli="$(_labwired_promote_cli)"

  # ---- flash ----------------------------------------------------------------
  local flashed=0 flash_out=""
  if [[ "$dry_run" == "1" ]]; then
    [[ -n "$flashed_in" ]] || flashed_in="1"
    if [[ "$flashed_in" == "0" ]]; then flashed=0; else flashed=1; fi
    flash_out="[dry_run] flash skipped"
  else
    local flash_target="$target"
    [[ "$is_virtual" -eq 1 ]] && flash_target="virtual"
    rc=0
    "$cli" probe flash "$elf" --chip "$chip" --target "$flash_target" \
      >"$out_f" 2>"$err_f" || rc=$?
    flash_out="$(cat "$out_f" "$err_f")"
    [[ "$rc" -eq 0 ]] && flashed=1
  fi

  # ---- capture --------------------------------------------------------------
  local marker_matched=0 capture_out=""
  if [[ "$dry_run" == "1" ]]; then
    [[ -n "$marker_in" ]] || marker_in="1"
    local mm_word="true"
    if [[ "$marker_in" == "0" ]]; then marker_matched=0; mm_word="false"; else marker_matched=1; fi
    capture_out="[dry_run] marker $marker assumed matched=$mm_word"
  elif [[ -n "$port" && "$is_virtual" -eq 0 ]]; then
    rc=0
    "$cli" serial-capture "$port" "$baud" "$marker" "$timeout" \
      >"$out_f" 2>"$err_f" || rc=$?
    capture_out="$(cat "$out_f" "$err_f")"
    if [[ "$rc" -eq 0 ]]; then
      marker_matched=1
    elif printf '%s' "$capture_out" | grep -qF -- "$marker"; then
      marker_matched=1
    elif printf '%s' "$capture_out" | grep -qiE 'observed|matched|found'; then
      marker_matched=1
    fi
  elif [[ "$is_virtual" -eq 1 ]]; then
    # A virtual flash is never hardware evidence — the twin path claims
    # model_verified through labwired_verify, not through here.
    marker_matched=0
    capture_out="[virtual] flash does not yield hardware_observed; use twin verify for model_verified."
  fi

  rm -f "$out_f" "$err_f"

  # ---- claim ----------------------------------------------------------------
  if ! type labwired_claim_shape >/dev/null 2>&1; then
    # shellcheck source=lib/claim-shape.sh
    source "$_LABWIRED_PROMOTE_LIB_DIR/claim-shape.sh"
  fi
  local claim_out="" claim_rc=0
  claim_out="$(labwired_claim_shape --flashed "$flashed" --marker-matched "$marker_matched")" \
    || claim_rc=$?

  printf '=== flash ===\n%s\n=== capture ===\n%s\n=== claim ===\n%s\n' \
    "$(_labwired_promote_trim "$flash_out")" \
    "$(_labwired_promote_trim "$capture_out")" \
    "$(_labwired_promote_trim "$claim_out")"

  return "$claim_rc"
}
