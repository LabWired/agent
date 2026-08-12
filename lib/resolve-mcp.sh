#!/usr/bin/env bash
# resolve-mcp.sh — resolve LabWired MCP server command argv as JSON.
# shellcheck shell=bash
#
# Prints JSON array of command strings for LabWired Agent runtime local MCP, e.g.
# ["node","/abs/path/index.js"] or ["npx","-y","@labwired/mcp"]
#
# Priority:
# 1) $LABWIRED_MCP_ENTRY if file exists → ["node", abs path]
# 2) $AGENT_ROOT/mcp/vendor/index.js if exists → ["node", abs]
# 3) LABWIRED_MCP_ALLOW_NPX=1|true → ["npx","-y","@labwired/mcp"]
# 4) LABWIRED_PROFILE=airgap without 1+2 → return 1 (fail closed)
# 5) online default → ["npx","-y","@labwired/mcp"]

labwired_resolve_mcp_command_json() {
  local root="${1:-.}"
  local entry=""

  if [[ -n "${LABWIRED_MCP_ENTRY:-}" && -f "${LABWIRED_MCP_ENTRY}" ]]; then
    entry="$(cd "$(dirname "$LABWIRED_MCP_ENTRY")" && pwd -P)/$(basename "$LABWIRED_MCP_ENTRY")"
    printf '["node","%s"]\n' "$entry"
    return 0
  fi

  if [[ -f "$root/mcp/vendor/index.js" ]]; then
    entry="$(cd "$root/mcp/vendor" && pwd -P)/index.js"
    printf '["node","%s"]\n' "$entry"
    return 0
  fi

  # Prefer a local monorepo build over broken npm file: deps (product install on
  # a LabWired machine with packages/mcp checked out).
  local home="${HOME:-/tmp}"
  local cand
  for cand in \
    "${LABWIRED_MONOREPO:-}/packages/mcp/dist/index.js" \
    "$home/Projects/labwired/packages/mcp/dist/index.js" \
    "$home/Projects/labwired-emit-ts/packages/mcp/dist/index.js"
  do
    if [[ -n "$cand" && -f "$cand" ]]; then
      entry="$(cd "$(dirname "$cand")" && pwd -P)/$(basename "$cand")"
      printf '["node","%s"]\n' "$entry"
      return 0
    fi
  done

  if [[ "${LABWIRED_MCP_ALLOW_NPX:-}" == "1" || "${LABWIRED_MCP_ALLOW_NPX:-}" == "true" ]]; then
    printf '["npx","-y","@labwired/mcp"]\n'
    return 0
  fi

  # Default for normal install: allow npx (dev/online). Airgap profile sets no npx.
  if [[ "${LABWIRED_PROFILE:-online}" == "airgap" ]]; then
    return 1
  fi

  printf '["npx","-y","@labwired/mcp"]\n'
  return 0
}
