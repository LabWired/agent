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
export LABWIRED_TEST_ALLOW_FAKE_CORE=1
USERBIN="$LABWIRED_BIN_DIR"
mkdir -p "$HOME" "$USERBIN" "$LABWIRED_HOME/user-data" "$OPENCODE_CONFIG_DIR/skills/golden-path" "$OPENCODE_CONFIG_DIR/branding"
printf 'keep me\n' >"$LABWIRED_HOME/user-data/keep.txt"
printf 'user agents\n' >"$OPENCODE_CONFIG_DIR/AGENTS.md"
printf 'user branding\n' >"$OPENCODE_CONFIG_DIR/branding/banner.txt"
printf 'user skill\n' >"$OPENCODE_CONFIG_DIR/skills/golden-path/SKILL.md"
cat >"$OPENCODE_CONFIG_DIR/opencode.json" <<'JSON'
{"provider":{"custom":{"name":"keep"}},"mcp":{"custom":{"enabled":true}},"settings":{"theme":"user"}}
JSON
cp "$OPENCODE_CONFIG_DIR/opencode.json" "$TMP/original-config.json"
printf 'existing rc\n' >"$HOME/.zprofile"

CORE_TARGET="$TMP/real-core"
cat >"$CORE_TARGET" <<'CORE'
#!/usr/bin/env bash
case "${1:-}" in
  --version) echo 'fake-core 1.0.0' ;;
  --help) echo 'fake-core help' ;;
  *) printf 'fake-core:%s\n' "$*" ;;
esac
CORE
chmod 0755 "$CORE_TARGET"
cp "$CORE_TARGET" "$TMP/original-core"
ln -s "$CORE_TARGET" "$USERBIN/labwired"
export PATH="$USERBIN:/usr/bin:/bin"

run_install() {
  bash "$ROOT/install.sh" "$@" >/dev/null
}

run_install --agent-only
test -x "$LABWIRED_HOME/agent/bin/labwired-agent"
test -x "$LABWIRED_HOME/bin/labwired"
test -x "$LABWIRED_HOME/components/core/bin/labwired"
test ! -L "$USERBIN/labwired"
cmp "$CORE_TARGET" "$TMP/original-core"
test -x "$CORE_TARGET"
[[ "$("$USERBIN/labwired" core --version)" == 'fake-core 1.0.0' ]]
[[ "$("$USERBIN/labwired" test fixture.yml)" == 'fake-core:test fixture.yml' ]]
test ! -e "$LABWIRED_HOME/tools/sim/labwired-sim"
test ! -d "$LABWIRED_HOME/editor"
grep -qx 'keep me' "$LABWIRED_HOME/user-data/keep.txt"
grep -q '"custom"' "$OPENCODE_CONFIG_DIR/opencode.json"
grep -q '"theme": "user"' "$OPENCODE_CONFIG_DIR/opencode.json"
grep -qx 'user agents' "$OPENCODE_CONFIG_DIR/AGENTS.md"
grep -qx 'user branding' "$OPENCODE_CONFIG_DIR/branding/banner.txt"
grep -qx 'user skill' "$OPENCODE_CONFIG_DIR/skills/golden-path/SKILL.md"
test -f "$OPENCODE_CONFIG_DIR/opencode.json.labwired-backup"
cmp "$TMP/original-config.json" "$OPENCODE_CONFIG_DIR/opencode.json.labwired-backup"
test -f "$OPENCODE_CONFIG_DIR/labwired-agent.manifest"
echo "ok   core coexistence PASS"

# Re-running the installer is an agent update and must keep shared prefix data.
run_install
grep -qx 'keep me' "$LABWIRED_HOME/user-data/keep.txt"
test ! -e "$LABWIRED_HOME/tools/sim/labwired-sim"
test ! -d "$LABWIRED_HOME/editor"
grep -qx 'existing rc' "$HOME/.zprofile"
[[ "$(grep -c 'LabWired Agent (portable prefix)' "$HOME/.zprofile")" -eq 1 ]]
cmp "$CORE_TARGET" "$TMP/original-core"
cmp "$TMP/original-config.json" "$OPENCODE_CONFIG_DIR/opencode.json.labwired-backup"
grep -q '"custom"' "$OPENCODE_CONFIG_DIR/opencode.json"
echo "ok   agent-only PASS"
