#!/usr/bin/env bash
# AGENTS.md must instruct the agent to use the MCP tool-search escape hatch.
# Hosted tool descriptions are kept terse on purpose (tools/list is resent every
# request); the long notes live in McpToolDef.detail and are only reachable by
# calling the search tool. If AGENTS.md stops saying so, that detail is lost.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS="$ROOT/config/AGENTS.md"
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }

test -f "$AGENTS" || { bad "missing config/AGENTS.md"; exit 1; }

# Derive the tool name from the server that actually exposes it, so a
# server-side rename cannot leave AGENTS.md pointing at a dead tool.
# Fallback: the agent harness ships standalone (CI checks out this repo only),
# so hardcode when the monorepo is not on disk.
SEARCH_TOOL=""
src="${LABWIRED_MONOREPO:-$ROOT/../labwired}/packages/api/src/mcp/search-tools.ts"
if [[ -f "$src" ]]; then
  SEARCH_TOOL="$(sed -n "s/.*SEARCH_TOOL_NAME[[:space:]]*=[[:space:]]*'\([^']*\)'.*/\1/p" "$src" | head -1)"
fi
if [[ -n "$SEARCH_TOOL" ]]; then
  ok "search tool name from server source: $SEARCH_TOOL"
else
  SEARCH_TOOL="labwired_search"
  ok "server source not on disk; using pinned name: $SEARCH_TOOL"
fi

# 1. AGENTS.md must name the tool the server actually exposes.
if grep -q "$SEARCH_TOOL" "$AGENTS"; then
  ok "AGENTS.md names $SEARCH_TOOL"
else
  bad "AGENTS.md never mentions $SEARCH_TOOL (agents will not find McpToolDef.detail)"
fi

# 2. It must say descriptions are terse / abbreviated, so search is not optional.
if grep -qiE 'terse|abbreviat|short on purpose|trimmed' "$AGENTS"; then
  ok "AGENTS.md says tool descriptions are terse"
else
  bad "AGENTS.md does not explain that tool descriptions are deliberately terse"
fi

# 3. It must give a trigger: first use of an unfamiliar tool.
if grep -qiE 'unfamiliar|first use|before using|first time' "$AGENTS"; then
  ok "AGENTS.md gives the unfamiliar-tool trigger"
else
  bad "AGENTS.md does not say when to search (before first use of an unfamiliar tool)"
fi

# 4. It must say to follow pointers embedded in tool descriptions.
if grep -qiE 'points at it|description points|that pointer' "$AGENTS"; then
  ok "AGENTS.md says to follow in-description pointers"
else
  bad "AGENTS.md does not tell the agent to follow $SEARCH_TOOL pointers in tool descriptions"
fi

# 5. Guard the bargain: the instruction must stay small. AGENTS.md ships on
#    every request, so a verbose fix would cost more than the detail it saves.
size="$(wc -c <"$AGENTS" | tr -d ' ')"
if [[ "$size" -le 11000 ]]; then
  ok "AGENTS.md size $size bytes within budget"
else
  bad "AGENTS.md grew to $size bytes (>11000); it is resent every request"
fi

if [[ "$fail" -ne 0 ]]; then
  echo "agents-tool-search FAIL"
  exit 1
fi
echo "agents-tool-search PASS"
