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
export PATH="$USERBIN:$PATH"

cleanup() { rm -rf "$(dirname "$PREFIX")" 2>/dev/null || true; }
trap cleanup EXIT

echo "==> install-smoke: prefix=$PREFIX"
bash "$ROOT/install.sh" --full
test -x "$USERBIN/labwired"
"$USERBIN/labwired" version
"$USERBIN/labwired" smoke
"$USERBIN/labwired" doctor
# claim gate offline
"$USERBIN/labwired" assert-status model_verified \
  <"$PREFIX/agent/fixtures/gate1/artifacts/fixed.verify.json"
"$USERBIN/labwired" assert-status failed \
  <"$PREFIX/agent/fixtures/gate1/artifacts/broken.verify.json"
# sim
test -x "$PREFIX/tools/sim/labwired-sim"
"$PREFIX/tools/sim/labwired-sim" --version
echo "ok   install-smoke PASS"
