#!/usr/bin/env bash
# End-to-end: portable install into a temp prefix + smoke.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="$(mktemp -d)/lw-test-$$"
USERBIN="$PREFIX/userbin"
export LABWIRED_HOME="$PREFIX"
export LABWIRED_BIN_DIR="$USERBIN"
export LABWIRED_FAST=1
export LABWIRED_INSTALL_PIO=0
export LABWIRED_TEST_SKIP_OPENCODE=1
export LABWIRED_TEST_SKIP_NETWORK=1
export HOME="$(dirname "$PREFIX")/home"
export OPENCODE_CONFIG_DIR="$(dirname "$PREFIX")/opencode-config"
mkdir -p "$HOME"
unset LABWIRED_CLI LABWIRED_SIM LABWIRED_PROBE_RS
export PATH="$USERBIN:/usr/bin:/bin"

cleanup() { rm -rf "$(dirname "$PREFIX")" 2>/dev/null || true; }
trap cleanup EXIT

echo "==> install-smoke: prefix=$PREFIX"
bash "$ROOT/install.sh" --agent-only
test -x "$USERBIN/labwired"
product_help="$("$USERBIN/labwired" --help)"
agent_version="$("$USERBIN/labwired" agent version)"
grep -q 'labwired agent' <<<"$product_help"
grep -q 'LabWired Agent' <<<"$agent_version"
# claim gate offline
"$USERBIN/labwired" agent assert-status model_verified \
  <"$PREFIX/agent/share/smoke/model-verified.json"
"$USERBIN/labwired" agent assert-status failed \
  <"$PREFIX/agent/share/smoke/failed.json"
test ! -e "$PREFIX/tools/sim/labwired-sim"
echo "ok   install-smoke PASS"
