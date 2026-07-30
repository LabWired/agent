#!/usr/bin/env bash
# resolve-catalog.sh — locate twin catalog + system YAML for a chip id.
# shellcheck shell=bash

labwired_catalog_root() {
  local root="${LABWIRED_CATALOG:-}"
  if [[ -n "$root" && -f "$root/boards.json" ]]; then
    echo "$root"
    return 0
  fi
  # Agent home / repo
  local agent="${LABWIRED_AGENT_HOME:-}"
  if [[ -n "$agent" && -f "$agent/share/catalog/boards.json" ]]; then
    echo "$agent/share/catalog"
    return 0
  fi
  if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
    local here
    here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    if [[ -f "$here/share/catalog/boards.json" ]]; then
      echo "$here/share/catalog"
      return 0
    fi
  fi
  # Portable install prefix
  local home="${LABWIRED_HOME:-$HOME/.labwired}"
  if [[ -f "$home/agent/share/catalog/boards.json" ]]; then
    echo "$home/agent/share/catalog"
    return 0
  fi
  return 1
}

# Print absolute path to systems/<chip>.yaml, or fail.
labwired_catalog_system() {
  local chip="${1:-}"
  if [[ -z "$chip" ]]; then
    echo "usage: labwired_catalog_system <chip-id>" >&2
    return 2
  fi
  # Explicit override always wins
  if [[ -n "${LABWIRED_HW_SYSTEM:-}" && -f "${LABWIRED_HW_SYSTEM}" ]]; then
    echo "${LABWIRED_HW_SYSTEM}"
    return 0
  fi
  local cat sys
  cat="$(labwired_catalog_root)" || {
    echo "labwired_catalog_system: catalog not found (share/catalog)" >&2
    return 1
  }
  sys="$cat/systems/${chip}.yaml"
  if [[ -f "$sys" ]]; then
    echo "$sys"
    return 0
  fi
  # Dev fallback: monorepo arduino-matrix
  local core="${LABWIRED_CORE_SRC:-$HOME/Projects/labwired/core}"
  if [[ -f "$core/validation/arduino-matrix/systems/${chip}.yaml" ]]; then
    echo "$core/validation/arduino-matrix/systems/${chip}.yaml"
    return 0
  fi
  echo "labwired_catalog_system: no system for chip '$chip'" >&2
  return 1
}

labwired_catalog_list() {
  local cat
  cat="$(labwired_catalog_root)" || return 1
  if command -v python3 >/dev/null 2>&1 && [[ -f "$cat/boards.json" ]]; then
    python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print('\n'.join(b['id'] for b in d.get('boards',[])))" "$cat/boards.json"
  else
    ls -1 "$cat/systems"/*.yaml 2>/dev/null | xargs -n1 basename | sed 's/\.yaml$//'
  fi
}
