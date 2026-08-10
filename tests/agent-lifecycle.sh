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
{"provider":{"custom":{"name":"keep"}},"mcp":{"custom":{"enabled":true}},"settings":{"theme":"user"},"permission":{"skill":{"golden-path":"user-choice","unrelated":"keep"}}}
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
grep -q '"golden-path": "user-choice"' "$OPENCODE_CONFIG_DIR/opencode.json"
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

# Checking for an update is read-only and the legacy tools update surfaces are
# rejected because Core owns those dependencies.
before_check="$(find "$LABWIRED_HOME" "$OPENCODE_CONFIG_DIR" -type f -exec shasum {} + | sort)"
"$USERBIN/labwired" agent update --check >/dev/null
after_check="$(find "$LABWIRED_HOME" "$OPENCODE_CONFIG_DIR" -type f -exec shasum {} + | sort)"
[[ "$before_check" == "$after_check" ]]
if "$USERBIN/labwired" agent update --tools-only >"$TMP/tools-only.out" 2>&1; then
  echo "FAIL --tools-only unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq 'Core tools are managed by `labwired core`.' "$TMP/tools-only.out"
if LABWIRED_UPDATE_TOOLS_ONLY=1 "$USERBIN/labwired" agent update --check >"$TMP/tools-env.out" 2>&1; then
  echo "FAIL LABWIRED_UPDATE_TOOLS_ONLY unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq 'Core tools are managed by `labwired core`.' "$TMP/tools-env.out"

# Agent removal is manifest-driven. Shared components/data and user-owned
# OpenCode settings/discovery files survive, including the one-time backup.
mkdir -p "$LABWIRED_HOME/state/agent" "$LABWIRED_HOME/state/core" "$LABWIRED_HOME/tools/unknown" "$LABWIRED_HOME/cache" "$LABWIRED_HOME/share"
printf 'agent state\n' >"$LABWIRED_HOME/state/agent/session"
printf 'core state\n' >"$LABWIRED_HOME/state/core/session"
printf 'unknown tool\n' >"$LABWIRED_HOME/tools/unknown/keep"
printf 'cache\n' >"$LABWIRED_HOME/cache/keep"
printf 'share\n' >"$LABWIRED_HOME/share/keep"
"$USERBIN/labwired" agent package uninstall --yes >/dev/null
test ! -e "$LABWIRED_HOME/agent"
test ! -e "$LABWIRED_HOME/state/agent"
test -x "$LABWIRED_HOME/components/core/bin/labwired"
grep -qx 'keep me' "$LABWIRED_HOME/user-data/keep.txt"
grep -qx 'core state' "$LABWIRED_HOME/state/core/session"
grep -qx 'unknown tool' "$LABWIRED_HOME/tools/unknown/keep"
grep -qx 'cache' "$LABWIRED_HOME/cache/keep"
grep -qx 'share' "$LABWIRED_HOME/share/keep"
test -x "$LABWIRED_HOME/bin/labwired"
test -x "$USERBIN/labwired"
[[ "$("$USERBIN/labwired" core --version)" == 'fake-core 1.0.0' ]]
[[ "$("$USERBIN/labwired" test fixture.yml)" == 'fake-core:test fixture.yml' ]]
grep -q '"custom"' "$OPENCODE_CONFIG_DIR/opencode.json"
grep -q '"theme": "user"' "$OPENCODE_CONFIG_DIR/opencode.json"
grep -q '"golden-path": "user-choice"' "$OPENCODE_CONFIG_DIR/opencode.json"
grep -q '"unrelated": "keep"' "$OPENCODE_CONFIG_DIR/opencode.json"
! grep -q '"labwired"' "$OPENCODE_CONFIG_DIR/opencode.json"
grep -qx 'user agents' "$OPENCODE_CONFIG_DIR/AGENTS.md"
grep -qx 'user branding' "$OPENCODE_CONFIG_DIR/branding/banner.txt"
grep -qx 'user skill' "$OPENCODE_CONFIG_DIR/skills/golden-path/SKILL.md"
cmp "$TMP/original-config.json" "$OPENCODE_CONFIG_DIR/opencode.json.labwired-backup"
test ! -e "$OPENCODE_CONFIG_DIR/labwired-agent.manifest"

# Repeated removal is a successful no-op through the retained dispatcher.
"$USERBIN/labwired" agent package uninstall --yes >/dev/null
[[ "$("$USERBIN/labwired" core --version)" == 'fake-core 1.0.0' ]]
echo "ok   agent uninstall isolation PASS"
