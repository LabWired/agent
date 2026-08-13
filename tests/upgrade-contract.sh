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

POSIX_SCRIPT="$ROOT/tests/upgrade-smoke.sh"
WINDOWS_SCRIPT="$ROOT/tests/windows-upgrade-smoke.ps1"
for script in "$POSIX_SCRIPT" "$WINDOWS_SCRIPT"; do
  test -f "$script" || fail "missing ${script#"$ROOT"/}"
  require_text "$script" "LABWIRED_PREVIOUS_AGENT_ARCHIVE"
  require_text "$script" "LABWIRED_PREVIOUS_AGENT_VERSION"
  require_text "$script" "LABWIRED_PREVIOUS_AGENT_SHA256"
  for evidence in platform.txt previous-version.txt current-version.txt upgrade-install.txt doctor.txt lifecycle.txt capabilities.txt result.txt; do
    require_text "$script" "$evidence"
  done
done

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
CURRENT_VERSION="$(tr -d '[:space:]' <"$ROOT/VERSION")"
grep -qx "version  $CURRENT_VERSION" "$fixture_evidence/current-version.txt" \
  || fail "current version evidence is not exact"
grep -qx 'prefix_sentinel=preserved' "$fixture_evidence/lifecycle.txt" \
  || fail "prefix sentinel preservation is not evidenced"
grep -qx 'config_sentinel=preserved' "$fixture_evidence/lifecycle.txt" \
  || fail "config sentinel preservation is not evidenced"
grep -qx 'ownership_cleanup=complete' "$fixture_evidence/lifecycle.txt" \
  || fail "ownership cleanup is not evidenced"

echo "ok   upgrade-contract PASS"
