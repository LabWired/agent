#!/usr/bin/env bash
# Contract and fixture-backed test for pinned previous-release upgrade evidence.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "FAIL upgrade-contract: $*" >&2
  exit 1
}

require_text() {
  local file="$1" text="$2"
  grep -Fq "$text" "$file" || fail "$file is missing required contract text: $text"
}

assert_evidence_complete() {
  local evidence_dir="$1" context="$2"
  for file in platform.txt previous-version.txt current-version.txt upgrade-install.txt doctor.txt lifecycle.txt capabilities.txt result.txt; do
    test -s "$evidence_dir/$file" || fail "$context evidence is incomplete: $file"
  done
}

archive_sha256() {
  python3 - "$1" <<'PY'
import hashlib
import sys
print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())
PY
}

make_version_fixture() {
  local archive="$1" version="$2" installer_body="$3"
  python3 - "$archive" "$version" "$installer_body" <<'PY'
import io
import tarfile
import sys

archive_path, version, installer_body = sys.argv[1:]
with tarfile.open(archive_path, "w") as archive:
    for name, payload, mode in (
        ("previous/VERSION", (version + "\n").encode(), 0o644),
        ("previous/install.sh", installer_body.encode(), 0o755),
    ):
        entry = tarfile.TarInfo(name)
        entry.size = len(payload)
        entry.mode = mode
        archive.addfile(entry, io.BytesIO(payload))
PY
}

POSIX_SCRIPT="$ROOT/tests/upgrade-smoke.sh"
WINDOWS_SCRIPT="$ROOT/tests/windows-upgrade-smoke.ps1"
WINDOWS_CONTRACT="$ROOT/tests/windows-contract.ps1"
HARNESS_WORKFLOW="$ROOT/.github/workflows/harness.yml"
for script in "$POSIX_SCRIPT" "$WINDOWS_SCRIPT"; do
  test -f "$script" || fail "missing ${script#"$ROOT"/}"
  require_text "$script" "LABWIRED_PREVIOUS_AGENT_ARCHIVE"
  require_text "$script" "LABWIRED_PREVIOUS_AGENT_VERSION"
  require_text "$script" "LABWIRED_PREVIOUS_AGENT_SHA256"
  for evidence in platform.txt previous-version.txt current-version.txt upgrade-install.txt doctor.txt lifecycle.txt capabilities.txt result.txt; do
    require_text "$script" "$evidence"
  done
done

python3 - "$HARNESS_WORKFLOW" <<'PY'
from pathlib import Path
import re
import sys

text = Path(sys.argv[1]).read_text(encoding="utf-8")

def step(name):
    match = re.search(
        rf"(?ms)^\s+- name: {re.escape(name)}\n(?P<body>.*?)(?=^\s+- name:|\Z)",
        text,
    )
    if not match:
        raise SystemExit(f"missing workflow step: {name}")
    return match.group("body")

for name, shell in (
    ("Previous-release upgrade evidence (Windows PowerShell)", "powershell"),
    ("Previous-release upgrade evidence (PowerShell Core)", "pwsh"),
):
    body = step(name)
    required = (
        f"shell: {shell}",
        "vars.LABWIRED_PREVIOUS_AGENT_ARCHIVE_URL",
        "vars.LABWIRED_PREVIOUS_AGENT_VERSION",
        "vars.LABWIRED_PREVIOUS_AGENT_SHA256",
        "LABWIRED_PREVIOUS_AGENT_ARCHIVE_URL:",
        "LABWIRED_PREVIOUS_AGENT_VERSION:",
        "LABWIRED_PREVIOUS_AGENT_SHA256:",
        "LABWIRED_EVIDENCE_DIR:",
        "Invoke-WebRequest",
        "$env:LABWIRED_PREVIOUS_AGENT_ARCHIVE",
        "windows-upgrade-smoke.ps1",
        "archive download failed before install",
    )
    required += (
        "platform.txt",
        "previous-version.txt",
        "current-version.txt",
        "upgrade-install.txt",
        "doctor.txt",
        "lifecycle.txt",
        "capabilities.txt",
        "result.txt",
    )
    for marker in required:
        if marker not in body:
            raise SystemExit(f"workflow step {name!r} is missing {marker!r}")

validation = step("Validate previous-release upgrade configuration")
for marker in (
    "shell: pwsh",
    "vars.LABWIRED_PREVIOUS_AGENT_ARCHIVE_URL",
    "vars.LABWIRED_PREVIOUS_AGENT_VERSION",
    "vars.LABWIRED_PREVIOUS_AGENT_SHA256",
    "throw",
    "windows\\upgrade\\powershell",
    "windows\\upgrade\\pwsh",
    "platform.txt",
    "result.txt",
):
    if marker not in validation:
        raise SystemExit(f"upgrade configuration validation is missing {marker!r}")

for name, shell in (
    ("Previous-release upgrade not configured (Windows PowerShell)", "powershell"),
    ("Previous-release upgrade not configured (PowerShell Core)", "pwsh"),
):
    body = step(name)
    for marker in (
        f"shell: {shell}",
        "vars.LABWIRED_PREVIOUS_AGENT_ARCHIVE_URL",
        "vars.LABWIRED_PREVIOUS_AGENT_VERSION",
        "vars.LABWIRED_PREVIOUS_AGENT_SHA256",
        "LABWIRED_EVIDENCE_DIR:",
        "windows-upgrade-smoke.ps1",
    ):
        if marker not in body:
            raise SystemExit(f"workflow step {name!r} is missing {marker!r}")
    condition = body.split("shell:", 1)[0]
    if condition.count("== ''") != 3 or "||" in condition:
        raise SystemExit(f"workflow step {name!r} must run only when all baseline variables are absent")
PY

require_text "$WINDOWS_CONTRACT" 'Assert-UnsafeUpgradeZip "traversal"'
require_text "$WINDOWS_CONTRACT" 'Assert-UnsafeUpgradeZip "reparse"'
require_text "$WINDOWS_CONTRACT" 'Assert-UnsafeUpgradeZip "symlink"'
require_text "$WINDOWS_CONTRACT" 'windows-upgrade-smoke.ps1'
require_text "$WINDOWS_CONTRACT" "Assert-InvalidUpgradeVersion \$currentAgentVersion"
require_text "$WINDOWS_CONTRACT" "Assert-InvalidUpgradeVersion \$futureAgentVersion"
require_text "$WINDOWS_CONTRACT" "\$futureAgentVersion = \"{0}.{1}.{2}\" -f"
require_text "$WINDOWS_CONTRACT" 'Assert-InvalidUpgradeVersion "0.3.10-rc.1"'
require_text "$WINDOWS_CONTRACT" 'Assert-InvalidUpgradeVersion "0.3.10+build.1"'

require_text "$WINDOWS_SCRIPT" 'Get-FileHash'
require_text "$WINDOWS_SCRIPT" 'ZipArchive'
require_text "$WINDOWS_SCRIPT" 'ReparsePoint'
require_text "$WINDOWS_SCRIPT" "\$PowerShellExe"
require_text "$WINDOWS_SCRIPT" 'package uninstall --yes'
if grep -Eq 'Invoke-WebRequest|Invoke-RestMethod|git (fetch|clone)|\blatest\b' "$WINDOWS_SCRIPT"; then
  fail "Windows upgrade evidence must not discover or download a release"
fi
if grep -Eq 'curl|wget|git (fetch|clone)|\blatest\b' "$POSIX_SCRIPT"; then
  fail "POSIX upgrade evidence must not discover or download a release"
fi

for mode in posix windows; do
  evidence="$TMP/missing-$mode"
  mkdir -p "$evidence"
  if [[ "$mode" == posix ]]; then
    output="$(env -u LABWIRED_PREVIOUS_AGENT_ARCHIVE \
      -u LABWIRED_PREVIOUS_AGENT_VERSION \
      -u LABWIRED_PREVIOUS_AGENT_SHA256 \
      LABWIRED_EVIDENCE_DIR="$evidence" bash "$POSIX_SCRIPT")" \
      || fail "POSIX missing-input lane did not return success"
  elif command -v pwsh >/dev/null 2>&1; then
    output="$(env -u LABWIRED_PREVIOUS_AGENT_ARCHIVE \
      -u LABWIRED_PREVIOUS_AGENT_VERSION \
      -u LABWIRED_PREVIOUS_AGENT_SHA256 \
      LABWIRED_EVIDENCE_DIR="$evidence" pwsh -NoProfile -File "$WINDOWS_SCRIPT")" \
      || fail "Windows missing-input lane did not return success"
  else
    continue
  fi
  [[ "$output" == "not run" ]] || fail "$mode missing-input output was not exactly 'not run': $output"
  if grep -q 'PASS' <<<"$output"; then
    fail "$mode missing-input lane made a PASS claim"
  fi
  assert_evidence_complete "$evidence" "$mode missing-input"
  grep -qx 'not-run' "$evidence/result.txt" || fail "$mode missing-input result must be not-run"
done

default_output="$(env -u LABWIRED_EVIDENCE_DIR \
  -u LABWIRED_PREVIOUS_AGENT_ARCHIVE \
  -u LABWIRED_PREVIOUS_AGENT_VERSION \
  -u LABWIRED_PREVIOUS_AGENT_SHA256 \
  bash "$POSIX_SCRIPT")" || fail "default missing-input lane did not return success"
[[ "$default_output" == "not run" ]] || fail "default missing-input output was not exactly 'not run'"
assert_evidence_complete "$ROOT/evidence/upgrade-posix" "default retained"
grep -qx 'not-run' "$ROOT/evidence/upgrade-posix/result.txt" \
  || fail "default retained result must be not-run"

PARTIAL_ARCHIVE="$TMP/partial.tar"
: >"$PARTIAL_ARCHIVE"
PARTIAL_SHA256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
partial_case=0
expect_partial_failure() {
  partial_case=$((partial_case + 1))
  local evidence="$TMP/partial-$partial_case"
  mkdir -p "$evidence"
  if env -u LABWIRED_PREVIOUS_AGENT_ARCHIVE \
    -u LABWIRED_PREVIOUS_AGENT_VERSION \
    -u LABWIRED_PREVIOUS_AGENT_SHA256 \
    LABWIRED_EVIDENCE_DIR="$evidence" "$@" bash "$POSIX_SCRIPT" \
    >"$TMP/partial-$partial_case.out" 2>"$TMP/partial-$partial_case.err"; then
    fail "partial input combination $partial_case was accepted"
  fi
  assert_evidence_complete "$evidence" "partial input $partial_case"
  grep -qx 'FAIL' "$evidence/result.txt" \
    || fail "partial input $partial_case did not leave result FAIL"
}
expect_partial_failure LABWIRED_PREVIOUS_AGENT_ARCHIVE="$PARTIAL_ARCHIVE"
expect_partial_failure LABWIRED_PREVIOUS_AGENT_VERSION=0.3.10
expect_partial_failure LABWIRED_PREVIOUS_AGENT_SHA256="$PARTIAL_SHA256"
expect_partial_failure LABWIRED_PREVIOUS_AGENT_ARCHIVE="$PARTIAL_ARCHIVE" \
  LABWIRED_PREVIOUS_AGENT_VERSION=0.3.10
grep -q 'LABWIRED_PREVIOUS_AGENT_SHA256' "$TMP/partial-4.err" \
  || fail "missing-checksum error did not name LABWIRED_PREVIOUS_AGENT_SHA256"
expect_partial_failure LABWIRED_PREVIOUS_AGENT_ARCHIVE="$PARTIAL_ARCHIVE" \
  LABWIRED_PREVIOUS_AGENT_SHA256="$PARTIAL_SHA256"
expect_partial_failure LABWIRED_PREVIOUS_AGENT_VERSION=0.3.10 \
  LABWIRED_PREVIOUS_AGENT_SHA256="$PARTIAL_SHA256"

CURRENT_VERSION="$(tr -d '[:space:]' <"$ROOT/VERSION")"
FUTURE_VERSION="$(python3 - "$CURRENT_VERSION" <<'PY'
import sys

parts = sys.argv[1].split(".")
if len(parts) != 3 or any(not part.isdigit() for part in parts):
    raise SystemExit("current VERSION must be numeric X.Y.Z")
major, minor, patch = (int(part) for part in parts)
print(f"{major}.{minor}.{patch + 1}")
PY
)"
for invalid_version in "$CURRENT_VERSION" "$FUTURE_VERSION" 0.3.10-rc.1 0.3.10+build.1; do
  invalid_archive="$TMP/invalid-version-${invalid_version//[^A-Za-z0-9]/_}.tar"
  make_version_fixture "$invalid_archive" "$invalid_version" $'#!/usr/bin/env bash\nexit 47\n'
  invalid_sha256="$(archive_sha256 "$invalid_archive")"
  invalid_evidence="$TMP/invalid-version-${invalid_version//[^A-Za-z0-9]/_}-evidence"
  mkdir -p "$invalid_evidence"
  if LABWIRED_EVIDENCE_DIR="$invalid_evidence" \
    LABWIRED_PREVIOUS_AGENT_ARCHIVE="$invalid_archive" \
    LABWIRED_PREVIOUS_AGENT_VERSION="$invalid_version" \
    LABWIRED_PREVIOUS_AGENT_SHA256="$invalid_sha256" \
    bash "$POSIX_SCRIPT" >"$TMP/invalid-version.out" 2>"$TMP/invalid-version.err"; then
    fail "invalid upgrade baseline $invalid_version was accepted"
  fi
  assert_evidence_complete "$invalid_evidence" "invalid upgrade baseline $invalid_version"
  grep -qx 'FAIL' "$invalid_evidence/result.txt" \
    || fail "invalid upgrade baseline $invalid_version did not leave result FAIL"
  grep -qx 'not-run' "$invalid_evidence/previous-version.txt" \
    || fail "invalid upgrade baseline $invalid_version reached previous version execution"
  if grep -q 'phase=previous-install' "$invalid_evidence/lifecycle.txt"; then
    fail "invalid upgrade baseline $invalid_version reached previous install"
  fi
  if [[ "$invalid_version" == "$CURRENT_VERSION" || "$invalid_version" == "$FUTURE_VERSION" ]]; then
    grep -Fq "must be older than current version $CURRENT_VERSION" "$TMP/invalid-version.err" \
      || fail "ordered baseline $invalid_version did not fail for ordering"
  fi
done

near_match_archive="$TMP/near-match.tar"
make_version_fixture "$near_match_archive" 0.3.10 $'#!/usr/bin/env bash\nmkdir -p "$LABWIRED_BIN_DIR"\ncat >"$LABWIRED_BIN_DIR/labwired" <<\'EOF\'\n#!/usr/bin/env bash\nprintf \'LabWired Agent\\nversion  0x3x10\\nhome     fixture\\n\'\nEOF\nchmod +x "$LABWIRED_BIN_DIR/labwired"\n'
near_match_sha256="$(archive_sha256 "$near_match_archive")"
near_match_evidence="$TMP/near-match-evidence"
mkdir -p "$near_match_evidence"
if LABWIRED_EVIDENCE_DIR="$near_match_evidence" \
  LABWIRED_PREVIOUS_AGENT_ARCHIVE="$near_match_archive" \
  LABWIRED_PREVIOUS_AGENT_VERSION=0.3.10 \
  LABWIRED_PREVIOUS_AGENT_SHA256="$near_match_sha256" \
  bash "$POSIX_SCRIPT" >"$TMP/near-match.out" 2>"$TMP/near-match.err"; then
  fail "regex near-match version output was accepted"
fi
assert_evidence_complete "$near_match_evidence" "near-match version"
grep -qx 'FAIL' "$near_match_evidence/result.txt" || fail "near-match version did not leave result FAIL"

optimized_archive="$TMP/optimized-sentinel.tar"
git -C "$ROOT" archive --format=tar --prefix=previous/ -o "$optimized_archive" v0.3.10
optimized_sha256="$(archive_sha256 "$optimized_archive")"
optimized_evidence="$TMP/optimized-sentinel-evidence"
mkdir -p "$optimized_evidence"
if PYTHONOPTIMIZE=1 LABWIRED_TEST_REMOVE_SENTINEL_BEFORE_CHECK=1 \
  LABWIRED_EVIDENCE_DIR="$optimized_evidence" \
  LABWIRED_PREVIOUS_AGENT_ARCHIVE="$optimized_archive" \
  LABWIRED_PREVIOUS_AGENT_VERSION=0.3.10 \
  LABWIRED_PREVIOUS_AGENT_SHA256="$optimized_sha256" \
  bash "$POSIX_SCRIPT" >"$TMP/optimized.out" 2>"$TMP/optimized.err"; then
  fail "missing sentinel was accepted under PYTHONOPTIMIZE=1"
fi
assert_evidence_complete "$optimized_evidence" "optimized missing sentinel"
grep -qx 'FAIL' "$optimized_evidence/result.txt" \
  || fail "optimized missing sentinel did not leave result FAIL"

silent_archive="$TMP/silent-installer.tar"
python3 - "$silent_archive" <<'PY'
import io
import tarfile
import sys

with tarfile.open(sys.argv[1], "w") as archive:
    for name, payload, mode in (
        ("silent-previous/VERSION", b"0.3.9\n", 0o644),
        ("silent-previous/install.sh", b"#!/usr/bin/env bash\nexit 47\n", 0o755),
    ):
        entry = tarfile.TarInfo(name)
        entry.size = len(payload)
        entry.mode = mode
        archive.addfile(entry, io.BytesIO(payload))
PY
SILENT_SHA256="$(python3 - "$silent_archive" <<'PY'
import hashlib
import sys
print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())
PY
)"
silent_evidence="$TMP/silent-evidence"
mkdir -p "$silent_evidence"
if LABWIRED_EVIDENCE_DIR="$silent_evidence" \
  LABWIRED_PREVIOUS_AGENT_ARCHIVE="$silent_archive" \
  LABWIRED_PREVIOUS_AGENT_VERSION=0.3.9 \
  LABWIRED_PREVIOUS_AGENT_SHA256="$SILENT_SHA256" \
  bash "$POSIX_SCRIPT" >"$TMP/silent.out" 2>"$TMP/silent.err"; then
  fail "silent failing previous installer was accepted"
fi
assert_evidence_complete "$silent_evidence" "silent previous-installer failure"
grep -qx 'FAIL' "$silent_evidence/result.txt" \
  || fail "silent previous-installer failure did not leave result FAIL"

# The fixture is generated solely from a known local tag. No network or release
# discovery is part of this contract.
PREVIOUS_TAG=v0.3.10
PREVIOUS_VERSION=0.3.10
ARCHIVE="$TMP/labwired-agent-$PREVIOUS_TAG.tar.gz"
git -C "$ROOT" archive --format=tar.gz --prefix=labwired-agent-previous/ \
  -o "$ARCHIVE" "$PREVIOUS_TAG"
ARCHIVE_SHA256="$(python3 - "$ARCHIVE" <<'PY'
import hashlib
import sys

digest = hashlib.sha256()
with open(sys.argv[1], "rb") as archive:
    for chunk in iter(lambda: archive.read(1024 * 1024), b""):
        digest.update(chunk)
print(digest.hexdigest())
PY
)"

bad_checksum_evidence="$TMP/bad-checksum"
mkdir -p "$bad_checksum_evidence"
if LABWIRED_EVIDENCE_DIR="$bad_checksum_evidence" \
  LABWIRED_PREVIOUS_AGENT_ARCHIVE="$ARCHIVE" \
  LABWIRED_PREVIOUS_AGENT_VERSION="$PREVIOUS_VERSION" \
  LABWIRED_PREVIOUS_AGENT_SHA256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  bash "$POSIX_SCRIPT" >"$TMP/bad-checksum.out" 2>"$TMP/bad-checksum.err"; then
  fail "checksum mismatch was accepted"
fi
grep -qi 'checksum' "$TMP/bad-checksum.err" || fail "checksum mismatch was not diagnosed"
assert_evidence_complete "$bad_checksum_evidence" "checksum mismatch"
grep -qx 'FAIL' "$bad_checksum_evidence/result.txt" || fail "checksum mismatch did not leave result FAIL"
grep -qx 'not-run' "$bad_checksum_evidence/previous-version.txt" \
  || fail "checksum mismatch mutated the previous-install evidence"

unsafe_archive="$TMP/unsafe.tar"
python3 - "$unsafe_archive" <<'PY'
import io
import tarfile
import sys

with tarfile.open(sys.argv[1], "w") as archive:
    entry = tarfile.TarInfo("../outside.txt")
    payload = b"unsafe\n"
    entry.size = len(payload)
    archive.addfile(entry, io.BytesIO(payload))
PY
UNSAFE_SHA256="$(python3 - "$unsafe_archive" <<'PY'
import hashlib
import sys
print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())
PY
)"
unsafe_evidence="$TMP/unsafe-evidence"
mkdir -p "$unsafe_evidence"
if LABWIRED_EVIDENCE_DIR="$unsafe_evidence" \
  LABWIRED_PREVIOUS_AGENT_ARCHIVE="$unsafe_archive" \
  LABWIRED_PREVIOUS_AGENT_VERSION="$PREVIOUS_VERSION" \
  LABWIRED_PREVIOUS_AGENT_SHA256="$UNSAFE_SHA256" \
  bash "$POSIX_SCRIPT" >"$TMP/unsafe.out" 2>"$TMP/unsafe.err"; then
  fail "path-traversal archive was accepted"
fi
grep -qi 'unsafe archive' "$TMP/unsafe.err" || fail "unsafe archive was not diagnosed"
test ! -e "$TMP/outside.txt" || fail "unsafe archive escaped its extraction root"
assert_evidence_complete "$unsafe_evidence" "unsafe archive"
grep -qx 'not-run' "$unsafe_evidence/previous-version.txt" \
  || fail "unsafe archive reached the previous install"

link_archive="$TMP/link.tar"
python3 - "$link_archive" <<'PY'
import tarfile
import sys

with tarfile.open(sys.argv[1], "w") as archive:
    entry = tarfile.TarInfo("labwired-agent-previous/unsafe-link")
    entry.type = tarfile.SYMTYPE
    entry.linkname = "../outside.txt"
    archive.addfile(entry)
PY
LINK_SHA256="$(python3 - "$link_archive" <<'PY'
import hashlib
import sys
print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())
PY
)"
link_evidence="$TMP/link-evidence"
mkdir -p "$link_evidence"
if LABWIRED_EVIDENCE_DIR="$link_evidence" \
  LABWIRED_PREVIOUS_AGENT_ARCHIVE="$link_archive" \
  LABWIRED_PREVIOUS_AGENT_VERSION="$PREVIOUS_VERSION" \
  LABWIRED_PREVIOUS_AGENT_SHA256="$LINK_SHA256" \
  bash "$POSIX_SCRIPT" >"$TMP/link.out" 2>"$TMP/link.err"; then
  fail "symlink archive was accepted"
fi
grep -qi 'unsafe archive' "$TMP/link.err" || fail "symlink archive was not diagnosed"
assert_evidence_complete "$link_evidence" "symlink archive"
grep -qx 'not-run' "$link_evidence/previous-version.txt" \
  || fail "symlink archive reached the previous install"

hardlink_archive="$TMP/hardlink.tar"
python3 - "$hardlink_archive" <<'PY'
import tarfile
import sys

with tarfile.open(sys.argv[1], "w") as archive:
    entry = tarfile.TarInfo("labwired-agent-previous/unsafe-hardlink")
    entry.type = tarfile.LNKTYPE
    entry.linkname = "../outside.txt"
    archive.addfile(entry)
PY
HARDLINK_SHA256="$(python3 - "$hardlink_archive" <<'PY'
import hashlib
import sys
print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())
PY
)"
hardlink_evidence="$TMP/hardlink-evidence"
mkdir -p "$hardlink_evidence"
if LABWIRED_EVIDENCE_DIR="$hardlink_evidence" \
  LABWIRED_PREVIOUS_AGENT_ARCHIVE="$hardlink_archive" \
  LABWIRED_PREVIOUS_AGENT_VERSION="$PREVIOUS_VERSION" \
  LABWIRED_PREVIOUS_AGENT_SHA256="$HARDLINK_SHA256" \
  bash "$POSIX_SCRIPT" >"$TMP/hardlink.out" 2>"$TMP/hardlink.err"; then
  fail "hardlink archive was accepted"
fi
grep -qi 'unsafe archive' "$TMP/hardlink.err" || fail "hardlink archive was not diagnosed"
assert_evidence_complete "$hardlink_evidence" "hardlink archive"
grep -qx 'not-run' "$hardlink_evidence/previous-version.txt" \
  || fail "hardlink archive reached the previous install"

fixture_evidence="$TMP/fixture-evidence"
mkdir -p "$fixture_evidence"
LABWIRED_EVIDENCE_DIR="$fixture_evidence" \
LABWIRED_PREVIOUS_AGENT_ARCHIVE="$ARCHIVE" \
LABWIRED_PREVIOUS_AGENT_VERSION="$PREVIOUS_VERSION" \
LABWIRED_PREVIOUS_AGENT_SHA256="$ARCHIVE_SHA256" \
  bash "$POSIX_SCRIPT"

grep -qx 'PASS' "$fixture_evidence/result.txt" || fail "fixture-backed upgrade did not pass"
grep -qx "version  $PREVIOUS_VERSION" "$fixture_evidence/previous-version.txt" \
  || fail "previous version evidence is not exact"
grep -qx "version  $CURRENT_VERSION" "$fixture_evidence/current-version.txt" \
  || fail "current version evidence is not exact"
grep -qx 'prefix_sentinel=preserved' "$fixture_evidence/lifecycle.txt" \
  || fail "prefix sentinel preservation is not evidenced"
grep -qx 'config_sentinel=preserved' "$fixture_evidence/lifecycle.txt" \
  || fail "config sentinel preservation is not evidenced"
grep -qx 'ownership_cleanup=complete' "$fixture_evidence/lifecycle.txt" \
  || fail "ownership cleanup is not evidenced"

echo "ok   upgrade-contract PASS"
