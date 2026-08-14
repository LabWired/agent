#!/usr/bin/env bash
# End-to-end: portable install into a temp prefix + smoke.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSION_ROOT="$(mktemp -d)"
PREFIX="$SESSION_ROOT/lw-test-$$"
USERBIN="$PREFIX/userbin"
EVIDENCE_DIR="${LABWIRED_EVIDENCE_DIR:-$SESSION_ROOT/evidence}"
LIFECYCLE_FILE="$EVIDENCE_DIR/lifecycle.txt"
OWNERSHIP_SNAPSHOT="$SESSION_ROOT/installed-ownership.manifest"
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
  if [[ "$1" != "$lifecycle_phase" ]]; then
    printf 'lifecycle phase mismatch: active=%s passed=%s\n' "$lifecycle_phase" "$1" >&2
    return 1
  fi
  if [[ "${LABWIRED_TEST_FAIL_PHASE:-}" == "$1" ]]; then
    return 1
  fi
  printf '%s=PASS\n' "$1" >>"$LIFECYCLE_FILE"
}
assert_owned_config_removed() {
  local config_dir="$1" ownership_manifest="$2"
  python3 - "$config_dir" "$ownership_manifest" <<'PY'
import json
import os
import sys

config_dir, ownership_manifest = sys.argv[1:]
config_path = os.path.join(config_dir, "opencode.json")
if os.path.isfile(config_path) and not os.path.islink(config_path):
    with open(config_path) as handle:
        config = json.load(handle)
else:
    config = {}

failures = []
with open(ownership_manifest) as handle:
    entries = [line.strip() for line in handle if line.strip()]

for entry in entries:
    if entry == "opencode.json":
        # Legacy manifests recorded the whole config. The uninstaller now
        # preserves that file and removes only explicit json: paths.
        continue
    if entry.startswith("json:"):
        json_path = entry[5:]
        parts = json_path.split(".")
        if not json_path or any(not part for part in parts):
            failures.append(f"invalid owned JSON entry: {entry}")
            continue
        node = config
        for part in parts:
            if not isinstance(node, dict) or part not in node:
                break
            node = node[part]
        else:
            failures.append(f"owned JSON entry remains: {json_path}")
        continue

    parts = entry.split("/")
    if entry.startswith("/") or any(part in ("", ".", "..") for part in parts):
        failures.append(f"invalid owned file entry: {entry}")
        continue
    owned_path = os.path.join(config_dir, *parts)
    if os.path.lexists(owned_path):
        failures.append(f"owned file remains: {entry}")

if failures:
    print("\n".join(failures), file=sys.stderr)
    sys.exit(1)
PY
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
cat "$EVIDENCE_DIR/install.txt"
test -x "$USERBIN/labwired"
grep -q 'LabWired portable launcher' "$USERBIN/labwired"
grep -q '/agent/bin/labwired' "$PREFIX/bin/labwired"
grep -q 'labwired_product_help' "$PREFIX/agent/bin/labwired"
product_help="$("$USERBIN/labwired" --help)"
grep -q 'labwired agent' <<<"$product_help"
lifecycle_pass initial-install

lifecycle_begin initial-version
"$USERBIN/labwired" agent version >"$EVIDENCE_DIR/version.txt" 2>&1
agent_version="$(cat "$EVIDENCE_DIR/version.txt")"
grep -q 'LabWired Agent' <<<"$agent_version"
grep -q 'version  ' <<<"$agent_version"
grep -q 'home     ' <<<"$agent_version"
lifecycle_pass initial-version

lifecycle_begin initial-doctor
set +e
"$USERBIN/labwired" agent doctor >"$EVIDENCE_DIR/doctor.txt" 2>&1
doctor_rc=$?
set -e
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

lifecycle_begin initial-offline-claims
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
lifecycle_pass initial-offline-claims

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

lifecycle_begin ownership-snapshot
if [[ "${LABWIRED_TEST_RESTORE_OWNED_ENTRY:-0}" == "1" ]]; then
  printf 'owned-by-agent\n' >"$OPENCODE_CONFIG_DIR/review-regression-owned.txt"
  printf 'review-regression-owned.txt\n' >>"$OPENCODE_CONFIG_DIR/labwired-agent.manifest"
fi
cp "$OPENCODE_CONFIG_DIR/labwired-agent.manifest" "$OWNERSHIP_SNAPSHOT"
printf 'opencode.json\nAGENTS.md\n' >"$SESSION_ROOT/ownership-check-regression.manifest"
if assert_owned_config_removed \
  "$OPENCODE_CONFIG_DIR" "$SESSION_ROOT/ownership-check-regression.manifest" \
  >"$SESSION_ROOT/ownership-check-regression.out" 2>&1; then
  echo 'FAIL ownership checker accepted an unremoved manifest-owned entry' >&2
  exit 1
fi
grep -qx 'owned file remains: AGENTS.md' "$SESSION_ROOT/ownership-check-regression.out"
if grep -q 'opencode.json' "$SESSION_ROOT/ownership-check-regression.out"; then
  echo 'FAIL ownership checker treated legacy opencode.json as removable' >&2
  exit 1
fi
lifecycle_pass ownership-snapshot

lifecycle_begin uninstall
if ! "$USERBIN/labwired" agent package uninstall --yes >>"$LIFECYCLE_FILE" 2>&1; then
  echo FAIL >"$EVIDENCE_DIR/result.txt"
  exit 1
fi
if [[ "${LABWIRED_TEST_RESTORE_OWNED_ENTRY:-0}" == "1" ]]; then
  printf 'left-behind-owned-entry\n' >"$OPENCODE_CONFIG_DIR/review-regression-owned.txt"
fi
test ! -e "$PREFIX/agent"
test ! -e "$PREFIX/state/agent"
test ! -e "$PREFIX/bin/labwired"
test ! -e "$USERBIN/labwired"
assert_owned_config_removed "$OPENCODE_CONFIG_DIR" "$OWNERSHIP_SNAPSHOT" \
  >>"$LIFECYCLE_FILE" 2>&1
test ! -e "$OPENCODE_CONFIG_DIR/labwired-agent.manifest"
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
echo PASS >"$EVIDENCE_DIR/result.txt"
echo "ok   install-smoke PASS"
