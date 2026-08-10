#!/usr/bin/env bash

labwired_dispatch_home() {
  printf '%s\n' "${LABWIRED_HOME:-${HOME}/.labwired}"
}

labwired_dispatch_agent_bin() {
  local home
  home="$(labwired_dispatch_home)"
  printf '%s\n' "${LABWIRED_AGENT_BIN:-$home/agent/bin/labwired-agent}"
}

labwired_dispatch_core_bin() {
  local home registered
  home="$(labwired_dispatch_home)"
  if [[ -n "${LABWIRED_CORE_BIN:-}" ]]; then
    printf '%s\n' "$LABWIRED_CORE_BIN"
    return 0
  fi
  registered="$home/components/core/bin/labwired"
  if [[ -x "$registered" ]]; then
    printf '%s\n' "$registered"
  elif [[ -x "$home/tools/sim/labwired-sim" ]]; then
    printf '%s\n' "$home/tools/sim/labwired-sim"
  else
    return 1
  fi
}

labwired_dispatch_is_legacy_core_command() {
  case "${1:-}" in
    test|chips|machine|asset|run|snapshot|coverage|tier1-matrix|cosim-step|fuzz)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

labwired_dispatch_exec_agent() {
  local agent_bin
  agent_bin="$(labwired_dispatch_agent_bin)"
  if [[ ! -x "$agent_bin" ]]; then
    printf 'labwired: LabWired Agent is not installed.\n' >&2
    printf 'Install it, or set LABWIRED_AGENT_BIN to its executable.\n' >&2
    return 1
  fi
  exec "$agent_bin" "$@"
}

labwired_dispatch_exec_core() {
  local core_bin
  core_bin="$(labwired_dispatch_core_bin)"
  if [[ ! -x "$core_bin" ]]; then
    printf 'labwired: LabWired Core is not installed.\n' >&2
    printf 'Install it, or set LABWIRED_CORE_BIN to its executable.\n' >&2
    return 1
  fi
  exec "$core_bin" "$@"
}
