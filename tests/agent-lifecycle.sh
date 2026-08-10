#!/usr/bin/env bash
# Agent-only install preserves an existing Core command and shared prefix data.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export HOME="$TMP/home"
export LABWIRED_HOME="$TMP/prefix"
export LABWIRED_BIN_DIR="$TMP/user-bin"
export OPENCODE_CONFIG_DIR="$TMP/opencode-config"
export LABWIRED_TEST_SKIP_OPENCODE=1
export LABWIRED_TEST_SKIP_NETWORK=1
USERBIN="$LABWIRED_BIN_DIR"
mkdir -p "$HOME" "$USERBIN" "$LABWIRED_HOME/user-data"
printf 'keep me\n' >"$LABWIRED_HOME/user-data/keep.txt"

cat >"$USERBIN/labwired" <<'CORE'
#!/usr/bin/env bash
case "${1:-}" in
  --version) echo 'fake-core 1.0.0' ;;
  --help) echo 'fake-core help' ;;
  *) printf 'fake-core:%s\n' "$*" ;;
esac
CORE
chmod 0755 "$USERBIN/labwired"
export PATH="$USERBIN:/usr/bin:/bin"

run_install() {
  bash "$ROOT/install.sh" "$@" >/dev/null
}

run_install --agent-only
test -x "$LABWIRED_HOME/agent/bin/labwired-agent"
test -x "$LABWIRED_HOME/bin/labwired"
test -x "$LABWIRED_HOME/components/core/bin/labwired"
[[ "$("$USERBIN/labwired" core --version)" == 'fake-core 1.0.0' ]]
[[ "$("$USERBIN/labwired" test fixture.yml)" == 'fake-core:test fixture.yml' ]]
test ! -e "$LABWIRED_HOME/tools/sim/labwired-sim"
test ! -d "$LABWIRED_HOME/editor"
grep -qx 'keep me' "$LABWIRED_HOME/user-data/keep.txt"
echo "ok   core coexistence PASS"

# Re-running the installer is an agent update and must keep shared prefix data.
run_install
grep -qx 'keep me' "$LABWIRED_HOME/user-data/keep.txt"
test ! -e "$LABWIRED_HOME/tools/sim/labwired-sim"
test ! -d "$LABWIRED_HOME/editor"
echo "ok   agent-only PASS"
