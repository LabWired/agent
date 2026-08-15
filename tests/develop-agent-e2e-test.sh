#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
E2E="$ROOT/tests/develop-agent-e2e.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if env -i HOME="$TMP/home" PATH="$PATH" bash "$E2E" --check-prerequisites >"$TMP/out" 2>"$TMP/err"; then
  echo "FAIL prerequisite check passed without credentials" >&2
  exit 1
fi
grep -q 'missing prerequisite: hosted authentication' "$TMP/err"

command_line="$(bash "$E2E" --print-command /tmp/project 'fixed prompt')"
[[ "$command_line" == *" agent run --model labwired/labwired-default --format json "* ]]
[[ "$command_line" != *"labwired-fast"* ]]
grep -q 'LABWIRED_DEVELOP_SCENARIO_TIMEOUT_SECONDS' "$E2E"
grep -q 'subprocess.run' "$E2E"
grep -q "printf -v cleanup_cmd" "$E2E"
if grep -q "trap 'rm -rf \"\$work\"'" "$E2E"; then
  echo "FAIL cleanup trap references expired local work variable" >&2
  exit 1
fi

echo "ok   develop-agent-e2e contract"
