#!/usr/bin/env bash
# Upgrade evidence from an explicitly pinned, checksum-verified previous kit.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSION_ROOT="$(mktemp -d)"
EVIDENCE_DIR="${LABWIRED_EVIDENCE_DIR:-$ROOT/evidence/upgrade-posix}"
LIFECYCLE_FILE="$EVIDENCE_DIR/lifecycle.txt"
PREFIX="$SESSION_ROOT/prefix"
USER_BIN="$SESSION_ROOT/user-bin"
CONFIG_DIR="$SESSION_ROOT/config"
OWNERSHIP_SNAPSHOT="$SESSION_ROOT/current-ownership.manifest"
ORIGINAL_PATH="$PATH"
LIFECYCLE_PHASE=not-started
LIFECYCLE_STARTED=0

mkdir -p "$EVIDENCE_DIR"
for evidence_file in platform.txt previous-version.txt current-version.txt upgrade-install.txt doctor.txt lifecycle.txt capabilities.txt result.txt; do
  printf 'not-run\n' >"$EVIDENCE_DIR/$evidence_file"
done

cleanup() {
  local rc=$?
  if [[ "$rc" -ne 0 ]]; then
    printf 'FAIL\n' >"$EVIDENCE_DIR/result.txt"
    if [[ "$LIFECYCLE_STARTED" -eq 1 ]]; then
      printf 'failed_phase=%s\nresult=FAIL\n' "$LIFECYCLE_PHASE" >>"$LIFECYCLE_FILE"
    fi
  fi
  rm -rf "$SESSION_ROOT" 2>/dev/null || true
  return "$rc"
}
trap cleanup EXIT

lifecycle_begin() {
  LIFECYCLE_PHASE="$1"
  if [[ "$LIFECYCLE_STARTED" -eq 0 ]]; then
    : >"$LIFECYCLE_FILE"
    LIFECYCLE_STARTED=1
  fi
  printf 'phase=%s\n' "$LIFECYCLE_PHASE" >>"$LIFECYCLE_FILE"
}

lifecycle_pass() {
  [[ "$1" == "$LIFECYCLE_PHASE" ]] || {
    echo "lifecycle phase mismatch: active=$LIFECYCLE_PHASE passed=$1" >&2
    return 1
  }
  printf '%s=PASS\n' "$1" >>"$LIFECYCLE_FILE"
}

die() {
  echo "upgrade-smoke: $*" >&2
  exit 1
}

assert_exact_version() {
  local evidence_file="$1" expected="$2"
  grep -qx 'LabWired Agent' "$evidence_file" \
    || die "version output does not identify LabWired Agent"
  grep -qx "version  $expected" "$evidence_file" \
    || die "version output does not exactly match $expected"
}

assert_user_sentinels() {
  grep -qx 'keep-prefix-data' "$PREFIX/user-data/upgrade-sentinel.txt" \
    || die "prefix sentinel was not preserved"
  grep -qx 'keep-user-config' "$CONFIG_DIR/upgrade-sentinel.txt" \
    || die "config sentinel was not preserved"
  python3 - "$CONFIG_DIR/opencode.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    config = json.load(handle)
assert config["user_upgrade"]["sentinel"] == "keep-user-config"
PY
}

assert_owned_config_removed() {
  python3 - "$CONFIG_DIR" "$OWNERSHIP_SNAPSHOT" <<'PY'
import json
import os
import sys

config_dir, manifest_path = sys.argv[1:]

def load_json(filename):
    path = os.path.join(config_dir, filename)
    if not os.path.isfile(path) or os.path.islink(path):
        return {}
    with open(path, encoding="utf-8") as handle:
        value = json.load(handle)
    return value if isinstance(value, dict) else {}

def has_path(value, dotted):
    node = value
    for part in dotted.split("."):
        if not isinstance(node, dict) or part not in node:
            return False
        node = node[part]
    return True

failures = []
with open(manifest_path, encoding="utf-8") as handle:
    entries = [line.strip() for line in handle if line.strip()]

for entry in entries:
    if entry == "opencode.json":
        # A legacy whole-file marker is intentionally preserved by uninstall.
        continue
    if entry.startswith("json:"):
        dotted = entry[5:]
        if not dotted or any(not part for part in dotted.split(".")):
            failures.append(f"invalid owned JSON entry: {entry}")
        elif has_path(load_json("opencode.json"), dotted):
            failures.append(f"owned JSON entry remains: {dotted}")
        continue
    if entry.startswith("json-file:"):
        parts = entry.split(":", 2)
        if len(parts) != 3 or not parts[1] or not parts[2]:
            failures.append(f"invalid owned JSON-file entry: {entry}")
        elif has_path(load_json(parts[1]), parts[2]):
            failures.append(f"owned JSON-file entry remains: {parts[1]}:{parts[2]}")
        continue
    if entry.startswith("json-array-value:"):
        parts = entry.split(":", 3)
        if len(parts) != 4:
            failures.append(f"invalid owned JSON-array entry: {entry}")
            continue
        value = load_json(parts[1]).get(parts[2], [])
        if isinstance(value, list) and parts[3] in value:
            failures.append(f"owned JSON-array value remains: {parts[1]}:{parts[2]}:{parts[3]}")
        continue
    if entry.startswith("json-array:"):
        parts = entry.split(":", 2)
        if len(parts) != 3:
            failures.append(f"invalid owned JSON-array entry: {entry}")
            continue
        value = load_json(parts[1]).get(parts[2], [])
        if isinstance(value, list) and any(
            isinstance(item, str) and item.endswith("labwired-brand.tsx") for item in value
        ):
            failures.append(f"owned JSON-array value remains: {parts[1]}:{parts[2]}")
        continue

    normalized = entry.replace("\\", "/")
    path_parts = normalized.split("/")
    if normalized.startswith("/") or any(part in ("", ".", "..") for part in path_parts):
        failures.append(f"invalid owned file entry: {entry}")
        continue
    if os.path.lexists(os.path.join(config_dir, *path_parts)):
        failures.append(f"owned file remains: {entry}")

if failures:
    print("\n".join(failures), file=sys.stderr)
    raise SystemExit(1)
PY
}

{
  uname -a
  printf 'architecture=%s\n' "$(uname -m)"
} >"$EVIDENCE_DIR/platform.txt"

ARCHIVE_INPUT="${LABWIRED_PREVIOUS_AGENT_ARCHIVE:-}"
PREVIOUS_VERSION="${LABWIRED_PREVIOUS_AGENT_VERSION:-}"
EXPECTED_SHA256="${LABWIRED_PREVIOUS_AGENT_SHA256:-}"
if [[ -z "$ARCHIVE_INPUT" && -z "$PREVIOUS_VERSION" && -z "$EXPECTED_SHA256" ]]; then
  echo 'not run'
  exit 0
fi

printf 'FAIL\n' >"$EVIDENCE_DIR/result.txt"
lifecycle_begin validate-inputs
[[ -n "$ARCHIVE_INPUT" ]] || die "LABWIRED_PREVIOUS_AGENT_ARCHIVE is required"
[[ -n "$PREVIOUS_VERSION" ]] || die "LABWIRED_PREVIOUS_AGENT_VERSION is required"
[[ -n "$EXPECTED_SHA256" ]] || die "LABWIRED_PREVIOUS_AGENT_SHA256 is required when LABWIRED_PREVIOUS_AGENT_ARCHIVE is supplied"
[[ "$EXPECTED_SHA256" =~ ^[0-9a-fA-F]{64}$ ]] \
  || die "LABWIRED_PREVIOUS_AGENT_SHA256 must be exactly 64 hexadecimal characters"
[[ -f "$ARCHIVE_INPUT" && ! -L "$ARCHIVE_INPUT" ]] \
  || die "LABWIRED_PREVIOUS_AGENT_ARCHIVE must name a regular, non-symlink file"
[[ "$PREVIOUS_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] \
  || die "LABWIRED_PREVIOUS_AGENT_VERSION is not a valid explicit version"
lifecycle_pass validate-inputs

lifecycle_begin verify-checksum
ARCHIVE_COPY="$SESSION_ROOT/previous-agent.archive"
cp "$ARCHIVE_INPUT" "$ARCHIVE_COPY"
ACTUAL_SHA256="$(python3 - "$ARCHIVE_COPY" <<'PY'
import hashlib
import sys

digest = hashlib.sha256()
with open(sys.argv[1], "rb") as archive:
    for chunk in iter(lambda: archive.read(1024 * 1024), b""):
        digest.update(chunk)
print(digest.hexdigest())
PY
)"
EXPECTED_SHA256_NORMALIZED="$(printf '%s' "$EXPECTED_SHA256" | tr '[:upper:]' '[:lower:]')"
[[ "$ACTUAL_SHA256" == "$EXPECTED_SHA256_NORMALIZED" ]] \
  || die "checksum mismatch for LABWIRED_PREVIOUS_AGENT_ARCHIVE"
lifecycle_pass verify-checksum

lifecycle_begin validate-archive
EXTRACT_ROOT="$SESSION_ROOT/extracted"
mkdir -p "$EXTRACT_ROOT"
python3 - "$ARCHIVE_COPY" "$EXTRACT_ROOT" <<'PY'
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tarfile
import zipfile

archive_path, destination = sys.argv[1:]

def safe_parts(name):
    if not name or any(ord(character) < 32 for character in name):
        raise ValueError(f"unsafe archive member name: {name!r}")
    normalized = name.replace("\\", "/")
    if normalized.startswith("/") or re.match(r"^[A-Za-z]:", normalized):
        raise ValueError(f"unsafe archive member path: {name}")
    trimmed = normalized[:-1] if normalized.endswith("/") else normalized
    parts = trimmed.split("/")
    if not trimmed or any(part in ("", ".", "..") for part in parts):
        raise ValueError(f"unsafe archive member path: {name}")
    return parts

try:
    if zipfile.is_zipfile(archive_path):
        with zipfile.ZipFile(archive_path) as archive:
            checked = []
            for entry in archive.infolist():
                parts = safe_parts(entry.filename)
                unix_type = (entry.external_attr >> 16) & 0xF000
                windows_attributes = entry.external_attr & 0xFFFF
                if unix_type == stat.S_IFLNK or windows_attributes & 0x0400:
                    raise ValueError(f"unsafe archive link/reparse member: {entry.filename}")
                checked.append((entry, parts))
            for entry, parts in checked:
                target = Path(destination).joinpath(*parts)
                if entry.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(entry) as source, open(target, "wb") as output:
                    shutil.copyfileobj(source, output)
                mode = (entry.external_attr >> 16) & 0o777
                if mode:
                    target.chmod(mode)
    elif tarfile.is_tarfile(archive_path):
        with tarfile.open(archive_path, "r:*") as archive:
            members = archive.getmembers()
            for member in members:
                safe_parts(member.name)
                if not (member.isdir() or member.isfile()):
                    raise ValueError(f"unsafe archive link/special member: {member.name}")
            archive.extractall(destination, members=members)
    else:
        raise ValueError("unsupported previous Agent archive format")
except (OSError, tarfile.TarError, ValueError, zipfile.BadZipFile) as error:
    print(f"upgrade-smoke: unsafe archive: {error}", file=sys.stderr)
    raise SystemExit(1)
PY

PREVIOUS_SOURCE="$(python3 - "$EXTRACT_ROOT" <<'PY'
from pathlib import Path
import sys

roots = [path.parent for path in Path(sys.argv[1]).rglob("install.sh") if path.is_file()]
roots = [path for path in roots if (path / "VERSION").is_file()]
if len(roots) != 1:
    print(f"upgrade-smoke: archive must contain exactly one install.sh + VERSION root; found {len(roots)}", file=sys.stderr)
    raise SystemExit(1)
print(roots[0])
PY
)"
ARCHIVED_VERSION="$(tr -d '[:space:]' <"$PREVIOUS_SOURCE/VERSION")"
[[ "$ARCHIVED_VERSION" == "$PREVIOUS_VERSION" ]] \
  || die "archive VERSION $ARCHIVED_VERSION does not match LABWIRED_PREVIOUS_AGENT_VERSION $PREVIOUS_VERSION"
lifecycle_pass validate-archive

mkdir -p "$SESSION_ROOT/test-bin" "$SESSION_ROOT/home" "$CONFIG_DIR"
cat >"$SESSION_ROOT/test-bin/opencode" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then echo 'opencode 1.18.7'; fi
exit 0
EOF
cat >"$SESSION_ROOT/test-bin/npx" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$SESSION_ROOT/test-bin/opencode" "$SESSION_ROOT/test-bin/npx"

export HOME="$SESSION_ROOT/home"
export LABWIRED_HOME="$PREFIX"
export LABWIRED_BIN_DIR="$USER_BIN"
export LABWIRED_AGENT_CONFIG_DIR="$CONFIG_DIR"
export OPENCODE_CONFIG_DIR="$CONFIG_DIR"
export LABWIRED_FAST=1
export LABWIRED_INSTALL_PIO=0
export LABWIRED_TEST_SKIP_OPENCODE=1
export LABWIRED_TEST_SKIP_NETWORK=1
export PATH="$USER_BIN:$SESSION_ROOT/test-bin:$ORIGINAL_PATH"
unset LABWIRED_CLI LABWIRED_SIM LABWIRED_PROBE_RS LABWIRED_ACCESS_TOKEN LABWIRED_PROJECT

lifecycle_begin previous-install
: >"$EVIDENCE_DIR/upgrade-install.txt"
if ! bash "$PREVIOUS_SOURCE/install.sh" --agent-only >>"$EVIDENCE_DIR/upgrade-install.txt" 2>&1; then
  die "previous Agent install failed"
fi
test -x "$USER_BIN/labwired" || die "previous Agent dispatcher was not installed"
lifecycle_pass previous-install

lifecycle_begin previous-version
"$USER_BIN/labwired" agent version >"$EVIDENCE_DIR/previous-version.txt" 2>&1 \
  || die "previous Agent version command failed"
assert_exact_version "$EVIDENCE_DIR/previous-version.txt" "$PREVIOUS_VERSION"
lifecycle_pass previous-version

lifecycle_begin sentinel-setup
mkdir -p "$PREFIX/user-data"
printf 'keep-prefix-data\n' >"$PREFIX/user-data/upgrade-sentinel.txt"
printf 'keep-user-config\n' >"$CONFIG_DIR/upgrade-sentinel.txt"
python3 - "$CONFIG_DIR/opencode.json" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as handle:
    config = json.load(handle)
config["user_upgrade"] = {"sentinel": "keep-user-config"}
with open(path, "w", encoding="utf-8") as handle:
    json.dump(config, handle, indent=2)
    handle.write("\n")
PY
assert_user_sentinels
lifecycle_pass sentinel-setup

CURRENT_VERSION="$(tr -d '[:space:]' <"$ROOT/VERSION")"
[[ -n "$CURRENT_VERSION" && "$CURRENT_VERSION" != "$PREVIOUS_VERSION" ]] \
  || die "current Agent version must differ from pinned previous version"

lifecycle_begin current-upgrade-install
if ! bash "$ROOT/install.sh" --agent-only >>"$EVIDENCE_DIR/upgrade-install.txt" 2>&1; then
  die "current Agent upgrade install failed"
fi
test -x "$USER_BIN/labwired" || die "current Agent dispatcher was not installed"
test -s "$CONFIG_DIR/labwired-agent.manifest" || die "current ownership manifest is missing"
assert_user_sentinels
lifecycle_pass current-upgrade-install

lifecycle_begin current-version
"$USER_BIN/labwired" agent version >"$EVIDENCE_DIR/current-version.txt" 2>&1 \
  || die "current Agent version command failed"
assert_exact_version "$EVIDENCE_DIR/current-version.txt" "$CURRENT_VERSION"
lifecycle_pass current-version

lifecycle_begin current-doctor
if ! "$USER_BIN/labwired" agent doctor >"$EVIDENCE_DIR/doctor.txt" 2>&1; then
  die "current Agent doctor failed"
fi
grep -q 'agent-runtime' "$EVIDENCE_DIR/doctor.txt" || die "doctor omitted agent-runtime"
grep -q 'ready' "$EVIDENCE_DIR/doctor.txt" || die "doctor did not report ready"
if grep -qE 'Failed to change directory|(^|[^[:alpha:]])not ready([^[:alpha:]]|$)' \
  "$EVIDENCE_DIR/current-version.txt" "$EVIDENCE_DIR/doctor.txt"; then
  die "upgraded dispatcher or doctor is not ready"
fi
lifecycle_pass current-doctor

{
  if [[ -x "$PREFIX/tools/sim/labwired-sim" ]]; then echo 'simulator=present'; else echo 'simulator=absent'; fi
  if [[ -x "$PREFIX/tools/probe-rs/probe-rs" ]]; then echo 'probe=present'; else echo 'probe=absent'; fi
  echo 'verification_fallback=hosted'
} >"$EVIDENCE_DIR/capabilities.txt"

lifecycle_begin ownership-snapshot
cp "$CONFIG_DIR/labwired-agent.manifest" "$OWNERSHIP_SNAPSHOT"
grep -q '^json:' "$OWNERSHIP_SNAPSHOT" || die "ownership manifest has no Agent-owned JSON paths"
grep -qv '^json:' "$OWNERSHIP_SNAPSHOT" || die "ownership manifest has no Agent-owned files"
lifecycle_pass ownership-snapshot

lifecycle_begin uninstall-current
if ! "$USER_BIN/labwired" agent package uninstall --yes >>"$LIFECYCLE_FILE" 2>&1; then
  die "current Agent uninstall failed"
fi
test ! -e "$PREFIX/agent" || die "current Agent kit remains after uninstall"
test ! -e "$PREFIX/state/agent" || die "current Agent state remains after uninstall"
test ! -e "$PREFIX/bin/labwired" || die "current prefix dispatcher remains after uninstall"
test ! -e "$USER_BIN/labwired" || die "current user dispatcher remains after uninstall"
assert_owned_config_removed >>"$LIFECYCLE_FILE" 2>&1
test ! -e "$CONFIG_DIR/labwired-agent.manifest" || die "ownership manifest remains after uninstall"
assert_user_sentinels >>"$LIFECYCLE_FILE" 2>&1
lifecycle_pass uninstall-current

lifecycle_begin final-evidence
for evidence_file in platform.txt previous-version.txt current-version.txt upgrade-install.txt doctor.txt lifecycle.txt capabilities.txt result.txt; do
  test -s "$EVIDENCE_DIR/$evidence_file" || die "evidence file is missing or empty: $evidence_file"
done
lifecycle_pass final-evidence
printf 'prefix_sentinel=preserved\nconfig_sentinel=preserved\nownership_cleanup=complete\nresult=PASS\n' \
  >>"$LIFECYCLE_FILE"
printf 'PASS\n' >"$EVIDENCE_DIR/result.txt"
echo 'ok   upgrade-smoke PASS'
