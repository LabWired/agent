#!/usr/bin/env bash
# End-to-end: portable install into a temp prefix + smoke.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSION_ROOT="$(mktemp -d)"
PREFIX="$SESSION_ROOT/lw-test-$$"
USERBIN="$PREFIX/userbin"
EVIDENCE_DIR="${LABWIRED_EVIDENCE_DIR:-$SESSION_ROOT/evidence}"
LIFECYCLE_FILE="$EVIDENCE_DIR/lifecycle.txt"
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

lifecycle_phase="not-started"
lifecycle_started=0
lifecycle_begin() {
  lifecycle_phase="$1"
  if [[ "$lifecycle_started" -eq 0 ]]; then
    : >"$LIFECYCLE_FILE"
    lifecycle_started=1
  fi
  printf 'phase=%s\n' "$lifecycle_phase" >>"$LIFECYCLE_FILE"
}
lifecycle_pass() {
  printf '%s=PASS\n' "$1" >>"$LIFECYCLE_FILE"
}
cleanup() {
  local rc=$?
  if [[ "$rc" -ne 0 && "$lifecycle_started" -eq 1 ]]; then
    printf 'failed_phase=%s\nresult=FAIL\n' "$lifecycle_phase" >>"$LIFECYCLE_FILE"
  fi
  rm -rf "$SESSION_ROOT" 2>/dev/null || true
  return "$rc"
}
trap cleanup EXIT

{
  uname -a
  printf 'architecture=%s\n' "$(uname -m)"
} >"$EVIDENCE_DIR/platform.txt"
for evidence_file in install.txt version.txt doctor.txt lifecycle.txt capabilities.txt; do
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
lifecycle_begin initial-install
if ! bash "$ROOT/install.sh" --agent-only >"$EVIDENCE_DIR/install.txt" 2>&1; then
  cat "$EVIDENCE_DIR/install.txt"
  echo FAIL >"$EVIDENCE_DIR/result.txt"
  exit 1
fi
lifecycle_pass initial-install
cat "$EVIDENCE_DIR/install.txt"
test -x "$USERBIN/labwired"
grep -q 'LabWired portable launcher' "$USERBIN/labwired"
grep -q '/agent/bin/labwired' "$PREFIX/bin/labwired"
grep -q 'labwired_product_help' "$PREFIX/agent/bin/labwired"
product_help="$("$USERBIN/labwired" --help)"
lifecycle_begin initial-version
"$USERBIN/labwired" agent version >"$EVIDENCE_DIR/version.txt" 2>&1
agent_version="$(cat "$EVIDENCE_DIR/version.txt")"
lifecycle_pass initial-version
lifecycle_begin initial-doctor
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
lifecycle_pass initial-doctor
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

# Exercise the install ownership contract with data the user added after the
# initial install. Uninstall and reinstall must never consume these sentinels.
lifecycle_begin sentinel-setup
mkdir -p "$PREFIX/user-data"
printf 'keep-prefix-data\n' >"$PREFIX/user-data/lifecycle-sentinel.txt"
printf 'keep-user-config\n' >"$OPENCODE_CONFIG_DIR/lifecycle-sentinel.txt"
test -f "$OPENCODE_CONFIG_DIR/labwired-agent.manifest"
test -f "$OPENCODE_CONFIG_DIR/AGENTS.md"
test -f "$OPENCODE_CONFIG_DIR/opencode.hosted.json"
test -f "$OPENCODE_CONFIG_DIR/skills/brainstorming/SKILL.md"
python3 - "$OPENCODE_CONFIG_DIR/opencode.json" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path) as handle:
    config = json.load(handle)
assert "model" in config
assert "default_agent" in config
assert "agent" in config
assert "autoupdate" in config
assert "share" in config
assert "labwired" in config.get("provider", {})
assert "labwired" in config.get("mcp", {})
config["user_lifecycle"] = {"sentinel": "keep-user-config"}
with open(path, "w") as handle:
    json.dump(config, handle, indent=2)
    handle.write("\n")
PY
lifecycle_pass sentinel-setup

lifecycle_begin uninstall
if ! "$USERBIN/labwired" agent package uninstall --yes >>"$LIFECYCLE_FILE" 2>&1; then
  echo FAIL >"$EVIDENCE_DIR/result.txt"
  exit 1
fi
test ! -e "$PREFIX/agent"
test ! -e "$PREFIX/state/agent"
test ! -e "$PREFIX/bin/labwired"
test ! -e "$USERBIN/labwired"
test ! -e "$OPENCODE_CONFIG_DIR/labwired-agent.manifest"
test ! -e "$OPENCODE_CONFIG_DIR/AGENTS.md"
test ! -e "$OPENCODE_CONFIG_DIR/opencode.hosted.json"
test ! -e "$OPENCODE_CONFIG_DIR/skills/brainstorming/SKILL.md"
grep -qx 'keep-prefix-data' "$PREFIX/user-data/lifecycle-sentinel.txt"
grep -qx 'keep-user-config' "$OPENCODE_CONFIG_DIR/lifecycle-sentinel.txt"
python3 - "$OPENCODE_CONFIG_DIR/opencode.json" >>"$LIFECYCLE_FILE" 2>&1 <<'PY'
import json
import sys

with open(sys.argv[1]) as handle:
    config = json.load(handle)
assert config["user_lifecycle"]["sentinel"] == "keep-user-config"
assert "model" not in config
assert "default_agent" not in config
assert "agent" not in config
assert "autoupdate" not in config
assert "share" not in config
assert "labwired" not in config.get("provider", {})
assert "labwired-local" not in config.get("provider", {})
assert "labwired" not in config.get("mcp", {})
PY
lifecycle_pass uninstall

lifecycle_begin reinstall
if ! bash "$ROOT/install.sh" --agent-only >>"$EVIDENCE_DIR/install.txt" 2>&1; then
  cat "$EVIDENCE_DIR/install.txt"
  echo FAIL >"$EVIDENCE_DIR/result.txt"
  exit 1
fi
test -x "$PREFIX/agent/bin/labwired"
test -x "$USERBIN/labwired"
test -f "$OPENCODE_CONFIG_DIR/labwired-agent.manifest"
grep -qx 'keep-prefix-data' "$PREFIX/user-data/lifecycle-sentinel.txt"
grep -qx 'keep-user-config' "$OPENCODE_CONFIG_DIR/lifecycle-sentinel.txt"
lifecycle_pass reinstall

lifecycle_begin reinstalled-version
"$USERBIN/labwired" agent version >"$SESSION_ROOT/reinstalled-version.txt" 2>&1
cat "$SESSION_ROOT/reinstalled-version.txt" >>"$EVIDENCE_DIR/version.txt"
reinstalled_version="$(cat "$SESSION_ROOT/reinstalled-version.txt")"
grep -q 'LabWired Agent' <<<"$reinstalled_version"
grep -q 'version  ' <<<"$reinstalled_version"
grep -q 'home     ' <<<"$reinstalled_version"
lifecycle_pass reinstalled-version

lifecycle_begin reinstalled-doctor
set +e
"$USERBIN/labwired" agent doctor >"$SESSION_ROOT/reinstalled-doctor.txt" 2>&1
doctor_rc=$?
set -e
cat "$SESSION_ROOT/reinstalled-doctor.txt" >>"$EVIDENCE_DIR/doctor.txt"
test "$doctor_rc" -eq 0
grep -q 'agent-runtime' "$SESSION_ROOT/reinstalled-doctor.txt"
grep -q 'ready' "$SESSION_ROOT/reinstalled-doctor.txt"
if grep -qE 'Failed to change directory|(^|[^[:alpha:]])not ready([^[:alpha:]]|$)' \
  "$EVIDENCE_DIR/version.txt" "$EVIDENCE_DIR/doctor.txt"; then
  echo 'FAIL reinstalled dispatcher or doctor output is not ready' >&2
  echo FAIL >"$EVIDENCE_DIR/result.txt"
  exit 1
fi
grep -qx 'keep-prefix-data' "$PREFIX/user-data/lifecycle-sentinel.txt"
grep -qx 'keep-user-config' "$OPENCODE_CONFIG_DIR/lifecycle-sentinel.txt"
python3 - "$OPENCODE_CONFIG_DIR/opencode.json" >>"$LIFECYCLE_FILE" 2>&1 <<'PY'
import json
import sys

with open(sys.argv[1]) as handle:
    config = json.load(handle)
assert config["user_lifecycle"]["sentinel"] == "keep-user-config"
assert "labwired" in config.get("provider", {})
assert "labwired" in config.get("mcp", {})
PY
lifecycle_pass reinstalled-doctor

lifecycle_begin final-evidence
grep -qx 'keep-prefix-data' "$PREFIX/user-data/lifecycle-sentinel.txt"
grep -qx 'keep-user-config' "$OPENCODE_CONFIG_DIR/lifecycle-sentinel.txt"
for evidence_file in platform.txt install.txt version.txt doctor.txt lifecycle.txt capabilities.txt result.txt; do
  test -s "$EVIDENCE_DIR/$evidence_file"
done
lifecycle_pass final-evidence
printf 'prefix_sentinel=preserved\nconfig_sentinel=preserved\nresult=PASS\n' \
  >>"$LIFECYCLE_FILE"
grep -qx 'result=PASS' "$EVIDENCE_DIR/lifecycle.txt"
echo PASS >"$EVIDENCE_DIR/result.txt"
echo "ok   install-smoke PASS"
