#!/usr/bin/env bash
# assert-status.sh — hard claim gate over labwired_verify JSON payloads.
# shellcheck shell=bash
#
# Usage: labwired_assert_status expected_status < json
# JSON may be a full MCP tool payload, { "status": "..." }, or nested content text.
# Prints the found status on stdout (and a short ok line on match).
# Exit: 0 match, 1 mismatch, 2 missing/unparseable status.

labwired_assert_status() {
  local expected="$1"
  local raw got rc
  raw="$(cat)"
  # Capture status from python; non-zero exits must not abort under set -e.
  set +e
  got="$(printf '%s' "$raw" | python3 -c '
import json,sys,re
raw=sys.stdin.read()
expected=sys.argv[1]
status=None
try:
    data=json.loads(raw)
except Exception:
    data=None
def find_status(obj):
    if isinstance(obj, dict):
        if "status" in obj and obj["status"] in (
            "model_verified","failed","inconclusive","unsupported"):
            return obj["status"]
        for v in obj.values():
            s=find_status(v)
            if s: return s
    elif isinstance(obj, list):
        for v in obj:
            s=find_status(v)
            if s: return s
    elif isinstance(obj, str):
        try:
            return find_status(json.loads(obj))
        except Exception:
            m=re.search(
                r"\"status\"\s*:\s*\"(model_verified|failed|inconclusive|unsupported)\"",
                obj,
            )
            if m: return m.group(1)
    return None
if data is not None:
    status=find_status(data)
if not status:
    m=re.search(
        r"\"status\"\s*:\s*\"(model_verified|failed|inconclusive|unsupported)\"",
        raw,
    )
    status=m.group(1) if m else None
if not status:
    sys.stderr.write("assert-status: no status field found\n")
    sys.exit(2)
print(status)
sys.exit(0 if status == expected else 1)
' "$expected")"
  rc=$?
  set -e
  if [[ $rc -eq 0 ]]; then
    echo "assert-status: ok ($got)"
    return 0
  fi
  echo "assert-status: expected $expected, got ${got:-unknown}" >&2
  return "$rc"
}
