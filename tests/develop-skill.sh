#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL="$ROOT/skills/develop/SKILL.md"
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

if [[ ! -f "$SKILL" ]]; then
  echo "FAIL missing skills/develop/SKILL.md"
  exit 1
fi

need 'labwired_context' 'context tool'
need 'labwired_(part|datasheet|search)' 'grounding tool'
need 'labwired_compile' 'compile tool'
need 'labwired_run' 'run tool'
need 'labwired_inspect' 'inspect tool'
need 'labwired_verify' 'verify tool'
need 'three total|3 total' 'three-attempt budget'
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
