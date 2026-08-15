#!/usr/bin/env bash
# Full local test matrix for LabWired Agent.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
HOST_HOME="${HOME:?HOME is required for the shared PlatformIO tool cache}"
SUITE_TMP="$(mktemp -d "$ROOT/.labwired-suite.XXXXXX")"
trap 'rm -rf "$SUITE_TMP"' EXIT INT TERM HUP
mkdir -p "$SUITE_TMP/tmp"
export TMPDIR="$SUITE_TMP/tmp"
export TMP="$SUITE_TMP/tmp"
export TEMP="$SUITE_TMP/tmp"

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

run_command() {
  local name="$1"
  shift
  echo ""
  echo "======== $name ========"
  if "$@"; then
    echo "PASS $name"
  else
    echo "FAIL $name"
    fail=1
  fi
}

run_hermetic() {
  local name="$1"
  shift
  local lane_root
  # Keep heavyweight firmware builds on the checkout volume. Developer system
  # temp partitions can be small even when the workspace volume has room.
  lane_root="$(mktemp -d "$ROOT/.labwired-test.XXXXXX")"
  mkdir -p "$lane_root/home" "$lane_root/tmp" "$lane_root/runtime"
  echo ""
  echo "======== $name ========"
  if env HOME="$lane_root/home" TMPDIR="$lane_root/tmp" TMP="$lane_root/tmp" \
      TEMP="$lane_root/tmp" XDG_RUNTIME_DIR="$lane_root/runtime" \
      PLATFORMIO_CORE_DIR="${PLATFORMIO_CORE_DIR:-$HOST_HOME/.platformio}" "$@"; then
    echo "PASS $name"
  else
    echo "FAIL $name"
    fail=1
  fi
  rm -rf "$lane_root"
}

run "harness"           "$ROOT/tests/harness.sh"
run "run-bounded"       "$ROOT/tests/run-bounded.sh"
run "skills-inventory"  "$ROOT/tests/skills-inventory.sh"
run "skills-verify-all" "$ROOT/tests/skills-verify-all.sh"
run "develop-skill"     "$ROOT/tests/develop-skill.sh"
run_hermetic "develop-acceptance-smoke" bash "$ROOT/tests/develop-acceptance-smoke.sh"
run "hosted-config"     "$ROOT/tests/hosted-config.sh"
run "public-tool-names" "$ROOT/tests/public-tool-names.sh"
run "hosted-auth-probe" "$ROOT/tests/hosted-auth-probe.sh"
run "agents-tool-search" "$ROOT/tests/agents-tool-search.sh"
run "desktop-session"   "$ROOT/tests/desktop-session.sh"
run "compose-helpers"   "$ROOT/tests/compose-helpers.sh"
run "smoke-doctor-gate" "$ROOT/tests/smoke-doctor-gate.sh"
run "smoke-wave-a"      "$ROOT/scripts/smoke-wave-a.sh"
run "smoke-remaining"   "$ROOT/scripts/smoke-remaining.sh"
run "ship-gate-bounds"  "$ROOT/tests/ship-gate-bounds.sh"
run "ship-gate"         "$ROOT/scripts/ship-gate.sh"
run "public-docs"       "$ROOT/scripts/check-public-package.sh"
run "public-package-scope" "$ROOT/tests/public-package-scope.sh"
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
run "rpc-promote"       "$ROOT/tests/rpc-promote.sh"
run "tools-manifest"    "$ROOT/tests/tools-manifest.sh"
run_hermetic "hardware-node" node --test tests/hardware-*.test.mjs
run_hermetic "hardware-cli" bash "$ROOT/tests/hardware-cli.sh"
run_hermetic "hardware-legacy-compat" bash "$ROOT/tests/hardware-legacy-compat.sh"
run_hermetic "hardware-release-contract" bash "$ROOT/tests/hardware-release-contract.sh"
run_hermetic "probe-exact-flash" bash "$ROOT/tests/probe-exact-flash.sh"
run "hardware-public-docs" "$ROOT/tests/hardware-public-docs.sh"
run "hardware-matrix-order" "$ROOT/tests/hardware-matrix-order.sh"
run_command "hardware-node18-min" npm run test:node18-min
if command -v pwsh >/dev/null 2>&1; then
  run_command "windows-hardware-contract" pwsh -NoProfile -File "$ROOT/tests/windows-hardware-contract.ps1"
elif command -v powershell.exe >/dev/null 2>&1; then
  run_command "windows-hardware-contract" powershell.exe -NoProfile -File "$ROOT/tests/windows-hardware-contract.ps1"
else
  echo "not run windows-hardware-contract: PowerShell is unavailable on this lane"
fi
run "upgrade-contract"   "$ROOT/tests/upgrade-contract.sh"
echo ""
echo "======== release-evidence-contract ========"
if node "$ROOT/tests/release-evidence-contract.js"; then
  echo "PASS release-evidence-contract"
else
  echo "FAIL release-evidence-contract"
  fail=1
fi
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
