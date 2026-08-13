#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNNER="$ROOT/scripts/run-bounded.py"

fail=0
assert_eq() {
  local name="$1" got="$2" want="$3"
  if [[ "$got" != "$want" ]]; then
    echo "FAIL $name: got='$got' want='$want'"
    fail=1
  else
    echo "ok   $name"
  fi
}

assert_contains() {
  local name="$1" needle="$2" file="$3"
  if ! grep -Fq -- "$needle" "$file"; then
    echo "FAIL $name: missing '$needle'"
    fail=1
  else
    echo "ok   $name"
  fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

set +e
python3 "$RUNNER" --timeout 1 -- python3 -c 'print("bounded ok")' >"$TMP/success.out" 2>"$TMP/success.err"
status=$?
set -e
assert_eq "successful command exit" "$status" "0"
assert_eq "successful command stdout" "$(<"$TMP/success.out")" "bounded ok"

set +e
python3 "$RUNNER" --timeout 1 -- sh -c 'printf "child stderr\\n" >&2; exit 37' >"$TMP/nonzero.out" 2>"$TMP/nonzero.err"
status=$?
set -e
assert_eq "child exit propagates" "$status" "37"
assert_contains "child stderr forwards" "child stderr" "$TMP/nonzero.err"

set +e
python3 "$RUNNER" --timeout 0.1 -- python3 -c 'import time; time.sleep(1)' >"$TMP/timeout.out" 2>"$TMP/timeout.err"
status=$?
set -e
assert_eq "timed out command exit" "$status" "124"
assert_contains "timeout names command" "python3" "$TMP/timeout.err"
assert_contains "timeout names duration" "0.1" "$TMP/timeout.err"

set +e
python3 "$RUNNER" --timeout nan -- true >"$TMP/invalid-timeout.out" 2>"$TMP/invalid-timeout.err"
status=$?
set -e
assert_eq "invalid timeout exit" "$status" "2"
assert_contains "invalid timeout message" "timeout must be a finite positive number of seconds" "$TMP/invalid-timeout.err"

set +e
python3 "$RUNNER" --timeout 1 -- >"$TMP/empty-command.out" 2>"$TMP/empty-command.err"
status=$?
set -e
assert_eq "empty command exit" "$status" "2"
assert_contains "empty command message" "command must not be empty" "$TMP/empty-command.err"

if [[ "$fail" -ne 0 ]]; then
  echo "run-bounded tests FAILED"
  exit 1
fi
echo "run-bounded tests passed"
