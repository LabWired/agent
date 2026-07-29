#!/usr/bin/env bash
# Full local test matrix for LabWired Agent.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export LABWIRED_FAST="${LABWIRED_FAST:-1}"
export LABWIRED_INSTALL_PIO="${LABWIRED_INSTALL_PIO:-0}"

fail=0
run() {
  local name="$1" script="$2"
  echo ""
  echo "======== $name ========"
  if bash "$script"; then
    echo "PASS $name"
  else
    echo "FAIL $name"
    fail=1
  fi
}

run "harness"           "$ROOT/tests/harness.sh"
run "skills-inventory"  "$ROOT/tests/skills-inventory.sh"
run "public-install"    "$ROOT/tests/public-install.sh"
run "prefix-unit"       "$ROOT/tests/prefix-unit.sh"
run "demo"              "$ROOT/demo.sh"

# Optional heavier / network lanes
if [[ "${LABWIRED_TEST_INSTALL_SMOKE:-1}" == "1" ]]; then
  run "install-smoke"   "$ROOT/tests/install-smoke.sh"
else
  echo "skip install-smoke (LABWIRED_TEST_INSTALL_SMOKE=0)"
fi

if [[ "${LABWIRED_TEST_LLM:-1}" == "1" ]]; then
  run "llm-deepinfra"   "$ROOT/tests/llm-deepinfra.sh"
else
  echo "skip llm-deepinfra (LABWIRED_TEST_LLM=0)"
fi

echo ""
if [[ "$fail" -ne 0 ]]; then
  echo "======== OVERALL FAIL ========"
  exit 1
fi
echo "======== OVERALL PASS ========"
