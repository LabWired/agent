#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL="$ROOT/skills/develop/SKILL.md"
PROVE="$ROOT/skills/prove/SKILL.md"
AGENTS="$ROOT/config/AGENTS.md"
fail=0

need() {
  local pattern="$1" label="$2"
  if grep -qiE "$pattern" "$SKILL"; then
    echo "ok   $label"
  else
    echo "FAIL $label"
    fail=1
  fi
}

need_in() {
  local file="$1" pattern="$2" label="$3"
  if grep -qiE "$pattern" "$file"; then
    echo "ok   $label"
  else
    echo "FAIL $label"
    fail=1
  fi
}

reject_in() {
  local file="$1" pattern="$2" label="$3"
  if grep -qiE "$pattern" "$file"; then
    echo "FAIL $label"
    fail=1
  else
    echo "ok   $label"
  fi
}

if [[ ! -f "$SKILL" ]]; then
  echo "FAIL missing skills/develop/SKILL.md"
  exit 1
fi

need 'labwired_context' 'context tool'
need 'empty[_ -]?context.*(resolve|import|select|labwired_list|labwired_describe).*(labwired_context.*(again|re-run)|re-run.*labwired_context).*before.*compil' 'empty context must be resolved and refreshed before compile'
need 'labwired_context.*pack.*board.*mcu' 'catalog board context is refreshed with an explicit pack'
need '(second|refreshed).*(labwired_context|context).*(must|mandatory).*(succeed|ok|design_context_ok).*before.*compil' 'refreshed context success is a hard compile gate'
need '(ok.*false|design_context_ok.*false).*(do not|never|must not).*compil' 'failed context blocks compile'
need 'catalog:board:.*returned.*board|returned.*board.*catalog:board:' 'catalog board citations use the canonical returned id'
need 'labwired_(part|datasheet|search)' 'grounding tool'
need 'labwired_compile' 'compile tool'
need 'labwired_run' 'run tool'
need 'labwired_inspect' 'inspect tool'
need 'labwired_verify' 'verify tool'
need '(serial).*(does not|cannot|never).*(GPIO|LED)|(GPIO|LED).*(requires|use).*(gpio|inspect)' 'serial evidence cannot substitute for GPIO or LED evidence'
need 'three total|3 total' 'three-attempt budget'
need_in "$PROVE" 'three total|3 total' 'prove uses three total attempts'
need_in "$AGENTS" 'three total|3 total' 'agent contract uses three total attempts'
need_in "$PROVE" '(at most|maximum|max).*two.*(repair|patch)|(repair|patch).*(at most|maximum|max).*two' 'prove permits at most two repairs after initial red'
need_in "$AGENTS" '(at most|maximum|max).*two.*(repair|patch)|(repair|patch).*(at most|maximum|max).*two' 'agent contract permits at most two repairs after initial red'
reject_in "$PROVE" '(3|three)[[:space:]-]+repairs?|repairs?.*(<|≤|max(imum)?|at most).*(3|three)' 'prove does not allow three repairs after initial red'
reject_in "$AGENTS" '(3|three)[[:space:]-]+repairs?|repairs?.*(<|≤|max(imum)?|at most).*(3|three)|after.*first red.*(3|three)' 'agent contract does not allow three repairs after initial red'
need_in "$SKILL" 'project.*(SDK|SVD|schematic)|(SDK|SVD|schematic).*project' 'develop allows grounded project evidence fallback'
need_in "$AGENTS" 'project.*(SDK|SVD|schematic)|(SDK|SVD|schematic).*project' 'agent contract allows grounded project evidence fallback'
need_in "$SKILL" '(unavailable|missing).*(project|SDK|SVD|schematic)|(project|SDK|SVD|schematic).*(fallback|unavailable)' 'develop states fallback condition'
need_in "$AGENTS" '(unavailable|missing).*(project|SDK|SVD|schematic)|(project|SDK|SVD|schematic).*(fallback|unavailable)' 'agent contract states fallback condition'
reject_in "$PROVE" '\babstain\b' 'prove excludes abstain from result vocabulary'
reject_in "$SKILL" '\babstain\b' 'develop excludes abstain from user-facing result'
need '^#+[[:space:]]+Changed' 'Changed heading'
need '^#+[[:space:]]+Grounded by' 'Grounded by heading'
need '^#+[[:space:]]+Compiled' 'Compiled heading'
need '^#+[[:space:]]+Twin checked' 'Twin checked heading'
need '^#+[[:space:]]+Still needs hardware' 'Still needs hardware heading'
need 'ESP32-C3' 'ESP32-C3 smoke target'
need 'STM32F103' 'STM32F103 smoke target'
need 'Wi-Fi' 'Wi-Fi smoke target'
need 'custom board' 'custom board smoke target'

need 'no new orchestrator|reuse existing.*tools' 'KISS reuses existing tools'

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi
echo "ok   develop-skill PASS"
