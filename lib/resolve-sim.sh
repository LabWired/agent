#!/usr/bin/env bash
# resolve-sim.sh — resolve LabWired *simulator* binary (not the agent launcher).
# shellcheck shell=bash

# Returns 0 and prints absolute path (or resolved PATH path), or 1 and prints nothing.
# Rules (first match wins):
# 1) $LABWIRED_CLI if set and executable (file or on PATH)
# 2) $LABWIRED_SIM if set and executable
# 3) command -v labwired that is NOT this agent launcher (argv0 realpath)
# 4) common names on PATH: labwired-sim, labwired-cli (only if they exist)
#
# Never invent a default name that is not found.

# Pure-bash dirname/basename so resolution works even if PATH is fixture-only.
_labwired_dirname() {
  local p="${1:-.}"
  [[ "$p" == */* ]] || { echo "."; return; }
  p="${p%/*}"
  [[ -n "$p" ]] || p="/"
  echo "$p"
}

_labwired_basename() {
  local p="${1:-}"
  echo "${p##*/}"
}

_labwired_realpath() {
  local p="$1"
  local d b
  d="$(_labwired_dirname "$p")"
  b="$(_labwired_basename "$p")"
  if [[ -d "$d" ]]; then
    echo "$(cd "$d" && pwd -P)/$b"
  else
    echo "$p"
  fi
}

labwired_agent_self_path() {
  # caller should pass launcher path as $1 when available
  if [[ -n "${1:-}" ]]; then
    _labwired_realpath "$1"
    return 0
  fi
  echo ""
}

labwired_resolve_sim() {
  local agent_path="${1:-}"
  local real_agent=""

  if [[ -n "$agent_path" && -e "$agent_path" ]]; then
    real_agent="$(_labwired_realpath "$agent_path")"
  fi

  try_one() {
    local c="$1"
    [[ -z "$c" ]] && return 1
    # Absolute or relative filesystem path that is executable
    if [[ "$c" == /* || "$c" == ./* || "$c" == ../* ]] && [[ -x "$c" ]]; then
      echo "$c"
      return 0
    fi
    if [[ -x "$c" && "$c" == */* ]]; then
      echo "$c"
      return 0
    fi
    if command -v "$c" >/dev/null 2>&1; then
      local p rp
      p="$(command -v "$c")"
      # command -v may return a relative path; reject agent self by realpath
      if [[ -n "$real_agent" && -e "$p" ]]; then
        rp="$(_labwired_realpath "$p")"
        if [[ "$rp" == "$real_agent" ]]; then
          return 1
        fi
      fi
      echo "$p"
      return 0
    fi
    # Bare path that exists as executable file (not via PATH)
    if [[ -x "$c" ]]; then
      echo "$c"
      return 0
    fi
    return 1
  }

  if [[ -n "${LABWIRED_CLI:-}" ]] && try_one "$LABWIRED_CLI"; then return 0; fi
  if [[ -n "${LABWIRED_SIM:-}" ]] && try_one "$LABWIRED_SIM"; then return 0; fi
  if try_one labwired; then return 0; fi
  if try_one labwired-sim; then return 0; fi
  if try_one labwired-cli; then return 0; fi
  return 1
}
