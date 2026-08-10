#!/usr/bin/env bash
# resolve-sim.sh — resolve LabWired *simulator* binary (not the agent launcher).
# shellcheck shell=bash

# Returns 0 and prints absolute path, or 1 and prints nothing.
# Rules (first match wins):
# 1) $LABWIRED_CLI if set and is a real sim (not agent)
# 2) $LABWIRED_SIM if set and is a real sim
# 3) labwired-sim / labwired-cli on PATH
# 4) labwired on PATH only if it is NOT the Firmware Agent launcher
#
# Never invent a default name that is not found.

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

# True if path is the LabWired *agent* launcher / wrapper (never a sim).
_labwired_is_agent_launcher() {
  local p="$1"
  [[ -z "$p" || ! -e "$p" ]] && return 1
  # Wrapper installed by install.sh
  if head -n 20 "$p" 2>/dev/null | grep -q 'LABWIRED_AGENT_HOME\|Firmware Agent\|opencode-ai\|OpenCode shell'; then
    return 0
  fi
  # Real agent bin under product home
  local rp d
  rp="$(_labwired_realpath "$p")"
  d="$(_labwired_dirname "$rp")"
  if [[ -f "$d/../lib/resolve-sim.sh" ]] || [[ -f "$d/../branding/banner.txt" ]]; then
    # bin/labwired inside agent kit
    if [[ -f "$d/../config/AGENTS.md" ]] || [[ -d "$d/../skills" ]]; then
      return 0
    fi
  fi
  if [[ "$rp" == *'/.labwired/agent/'* ]]; then
    return 0
  fi
  return 1
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
    local p=""

    if [[ "$c" == /* || "$c" == ./* || "$c" == ../* ]] && [[ -x "$c" ]]; then
      p="$c"
    elif [[ -x "$c" && "$c" == */* ]]; then
      p="$c"
    elif command -v "$c" >/dev/null 2>&1; then
      p="$(command -v "$c")"
    elif [[ -x "$c" ]]; then
      p="$c"
    else
      return 1
    fi

    # Reject agent launcher (by path equality or content)
    if [[ -n "$real_agent" && -e "$p" ]]; then
      if [[ "$(_labwired_realpath "$p")" == "$real_agent" ]]; then
        return 1
      fi
    fi
    if _labwired_is_agent_launcher "$p"; then
      return 1
    fi

    echo "$p"
    return 0
  }

  if [[ -n "${LABWIRED_CLI:-}" ]] && try_one "$LABWIRED_CLI"; then return 0; fi
  if [[ -n "${LABWIRED_SIM:-}" ]] && try_one "$LABWIRED_SIM"; then return 0; fi

  # Portable prefix (contained install) — prefer before PATH scatter
  local prefix_home="${LABWIRED_HOME:-$HOME/.labwired}"
  if try_one "${prefix_home}/tools/sim/labwired-sim"; then return 0; fi
  if try_one "${prefix_home}/bin/labwired-sim"; then return 0; fi
  if try_one "${prefix_home}/components/core/bin/labwired"; then return 0; fi

  # Prefer explicit sim names before generic `labwired`
  if try_one labwired-sim; then return 0; fi
  if try_one labwired-cli; then return 0; fi
  if try_one labwired; then return 0; fi
  return 1
}
