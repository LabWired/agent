#!/usr/bin/env bash
# End-to-end: portable install into a temp prefix + smoke.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSION_ROOT="$(mktemp -d)"
PREFIX="$SESSION_ROOT/lw-test-$$"
USERBIN="$PREFIX/userbin"
EVIDENCE_DIR="${LABWIRED_EVIDENCE_DIR:-$SESSION_ROOT/evidence}"
mkdir -p "$EVIDENCE_DIR" "$SESSION_ROOT/test-bin"
export LABWIRED_HOME="$PREFIX"
export LABWIRED_BIN_DIR="$USERBIN"
export LABWIRED_FAST=1
export LABWIRED_INSTALL_PIO=0
export LABWIRED_TEST_SKIP_OPENCODE=1
export LABWIRED_TEST_SKIP_NETWORK=1
export HOME="$SESSION_ROOT/home"
export OPENCODE_CONFIG_DIR="$SESSION_ROOT/opencode-config"
mkdir -p "$HOME"
unset LABWIRED_CLI LABWIRED_SIM LABWIRED_PROBE_RS
cat >"$SESSION_ROOT/test-bin/opencode" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then echo 'opencode 1.18.7'; exit 0; fi
exit 0
EOF
cat >"$SESSION_ROOT/test-bin/npx" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$SESSION_ROOT/test-bin/opencode" "$SESSION_ROOT/test-bin/npx"
export PATH="$USERBIN:$SESSION_ROOT/test-bin:/usr/bin:/bin"

cleanup() { rm -rf "$SESSION_ROOT" 2>/dev/null || true; }
trap cleanup EXIT

{
  uname -a
  printf 'architecture=%s\n' "$(uname -m)"
} >"$EVIDENCE_DIR/platform.txt"
for evidence_file in install.txt version.txt doctor.txt capabilities.txt; do
  echo 'not-run' >"$EVIDENCE_DIR/$evidence_file"
done
echo FAIL >"$EVIDENCE_DIR/result.txt"

# Reproduce the obsolete direct-Agent shim observed in an existing user install.
# The current installer must replace it with the product dispatcher.
mkdir -p "$USERBIN"
cat >"$USERBIN/labwired" <<'EOF'
#!/usr/bin/env bash
exec "$LABWIRED_HOME/agent/bin/labwired-agent" "$@"
EOF
chmod +x "$USERBIN/labwired"

echo "==> install-smoke: prefix=$PREFIX"
if ! bash "$ROOT/install.sh" --agent-only >"$EVIDENCE_DIR/install.txt" 2>&1; then
  cat "$EVIDENCE_DIR/install.txt"
  echo FAIL >"$EVIDENCE_DIR/result.txt"
  exit 1
fi
cat "$EVIDENCE_DIR/install.txt"
test -x "$USERBIN/labwired"
grep -q 'LabWired portable launcher' "$USERBIN/labwired"
grep -q '/agent/bin/labwired' "$PREFIX/bin/labwired"
grep -q 'labwired_product_help' "$PREFIX/agent/bin/labwired"
product_help="$("$USERBIN/labwired" --help)"
"$USERBIN/labwired" agent version >"$EVIDENCE_DIR/version.txt" 2>&1
agent_version="$(cat "$EVIDENCE_DIR/version.txt")"
set +e
"$USERBIN/labwired" agent doctor >"$EVIDENCE_DIR/doctor.txt" 2>&1
doctor_rc=$?
set -e
grep -q 'labwired agent' <<<"$product_help"
grep -q 'LabWired Agent' <<<"$agent_version"
grep -q 'version  ' <<<"$agent_version"
grep -q 'home     ' <<<"$agent_version"
test "$doctor_rc" -eq 0
grep -q 'agent-runtime' "$EVIDENCE_DIR/doctor.txt"
grep -q 'ready' "$EVIDENCE_DIR/doctor.txt"
if grep -qE 'Failed to change directory|(^|[^[:alpha:]])not ready([^[:alpha:]]|$)' \
  "$EVIDENCE_DIR/version.txt" "$EVIDENCE_DIR/doctor.txt"; then
  echo 'FAIL installed dispatcher or doctor output is not ready' >&2
  echo FAIL >"$EVIDENCE_DIR/result.txt"
  exit 1
fi
{
  if [[ -x "$PREFIX/tools/sim/labwired-sim" ]]; then echo 'simulator=present'; else echo 'simulator=absent'; fi
  if [[ -x "$PREFIX/tools/probe-rs/probe-rs" ]]; then echo 'probe=present'; else echo 'probe=absent'; fi
  echo 'verification_fallback=hosted'
} >"$EVIDENCE_DIR/capabilities.txt"
# claim gate offline
"$USERBIN/labwired" agent assert-status model_verified \
  <"$PREFIX/agent/share/smoke/status-parser-model-verified.json"
"$USERBIN/labwired" agent assert-status failed \
  <"$PREFIX/agent/share/smoke/status-parser-failed.json"
test ! -e "$PREFIX/tools/sim/labwired-sim"
echo PASS >"$EVIDENCE_DIR/result.txt"
echo "ok   install-smoke PASS"
