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
run "skills-verify-all" "$ROOT/tests/skills-verify-all.sh"
run "develop-skill"     "$ROOT/tests/develop-skill.sh"
run "develop-acceptance-smoke" "$ROOT/tests/develop-acceptance-smoke.sh"
run "hosted-config"     "$ROOT/tests/hosted-config.sh"
run "hosted-auth-probe" "$ROOT/tests/hosted-auth-probe.sh"
run "agents-tool-search" "$ROOT/tests/agents-tool-search.sh"
run "desktop-session"   "$ROOT/tests/desktop-session.sh"
run "compose-helpers"   "$ROOT/tests/compose-helpers.sh"
run "smoke-doctor-gate" "$ROOT/tests/smoke-doctor-gate.sh"
run "smoke-wave-a"      "$ROOT/scripts/smoke-wave-a.sh"
run "smoke-remaining"   "$ROOT/scripts/smoke-remaining.sh"
run "ship-gate"         "$ROOT/scripts/ship-gate.sh"
run "public-docs"       "$ROOT/scripts/check-public-package.sh"
run "public-install"    "$ROOT/tests/public-install.sh"
run "public-install-safety" "$ROOT/tests/public-install-safety.sh"
run "prefix-unit"       "$ROOT/tests/prefix-unit.sh"
run "dispatcher"        "$ROOT/tests/dispatcher.sh"
run "agent-lifecycle"   "$ROOT/tests/agent-lifecycle.sh"
run "rpc-agent-resolution" "$ROOT/tests/rpc-agent-resolution.sh"
run "rpc-contract"      "$ROOT/tests/rpc-contract.sh"
run "rpc-tool-stream"   "$ROOT/tests/rpc-tool-stream.sh"
run "rpc-probe-resolution" "$ROOT/tests/rpc-probe-resolution.sh"
run "rpc-claim-shape"   "$ROOT/tests/rpc-claim-shape.sh"
run "demo"              "$ROOT/demo.sh"
run "fw-usecase-qa"     "$ROOT/tests/fw-usecase-qa.sh"
editor_root="${LABWIRED_EDITOR_ROOT:-$(cd "$ROOT/../labwired-cursor" 2>/dev/null && pwd || true)}"
probe_list="$(probe-rs list 2>&1 || true)"
if [[ -n "$editor_root" && -d "$editor_root/src/vs/workbench/contrib/void" ]] \
  && grep -qiE 'ESP|EspJtag|303a:' <<<"$probe_list"; then
  run "gap-ready-qa"    "$ROOT/tests/gap-ready-qa.sh"
else
  echo "not run gap-ready-qa: requires LABWIRED_EDITOR_ROOT and a connected ESP debug probe"
fi

# Optional heavier / network lanes
if [[ "${LABWIRED_TEST_INSTALL_SMOKE:-1}" == "1" ]]; then
  run "install-smoke"   "$ROOT/tests/install-smoke.sh"
else
  echo "not run install-smoke: LABWIRED_TEST_INSTALL_SMOKE=0"
fi

if ! bash "$ROOT/tests/run-optional-llm.sh"; then
  fail=1
fi

echo ""
if [[ "$fail" -ne 0 ]]; then
  echo "======== OVERALL FAIL ========"
  exit 1
fi
echo "======== OVERALL PASS ========"
