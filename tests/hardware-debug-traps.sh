#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HELPER="$ROOT/tests/helpers/hardware-err-trap.sh"
[[ -r "$HELPER" ]] || { echo 'missing hardware ERR trap helper' >&2; exit 1; }

run_probe() {
  local debug="$1" rc output
  set +e
  output="$(LABWIRED_TEST_DEBUG="$debug" bash -c '
    set -uo pipefail
    source "$1"
    trap '\''hardware_test_err_trace "$?" "$LINENO" "$BASH_COMMAND" probe'\'' ERR
    bash -c "exit $2"
    rc=$?
    printf "RESULT_RC=%s\n" "$rc"
    exit "$rc"
  ' _ "$HELPER" "$2" 2>&1)"
  rc=$?
  set -e
  [[ "$rc" -eq "$2" ]]
  [[ "$output" == *"RESULT_RC=$2"* ]]
  if [[ "$debug" == 1 ]]; then
    [[ "$output" == *"probe: TRACE"*"rc=$2"* ]]
    [[ "${#output}" -le 700 ]]
  else
    [[ "$output" != *TRACE* ]]
  fi
}

for expected in 2 3; do
  run_probe 0 "$expected"
  run_probe 1 "$expected"
done

set +e
redacted="$(LABWIRED_TEST_DEBUG=1 bash -c '
  source "$1"
  hardware_test_err_trace 3 9 "token=fixture-value sk-FAKE123" probe
' _ "$HELPER" 2>&1)"
redacted_rc=$?
set -e
[[ "$redacted_rc" -eq 3 ]]
[[ "$redacted" == *'[REDACTED]'* ]]
[[ "$redacted" != *fixture-value* && "$redacted" != *sk-FAKE123* ]]

trace_file="${TMPDIR:-/tmp}/hardware-trap-file.log"
: >"$trace_file"
set +e
LABWIRED_TEST_DEBUG=0 LABWIRED_TEST_TRACE_FILE="$trace_file" bash -c '
  source "$1"
  hardware_test_err_trace 3 10 "password=fixture-value" probe
' _ "$HELPER" >/dev/null 2>&1
trace_rc=$?
set -e
[[ "$trace_rc" -eq 3 ]]
grep -q 'probe: TRACE line=10 rc=3' "$trace_file"
! grep -q fixture-value "$trace_file"

for debug in 0 1; do
  LABWIRED_TEST_DEBUG="$debug" bash "$ROOT/tests/hardware-cli.sh" >"${TMPDIR:-/tmp}/hardware-cli-debug-$debug.log" 2>&1
  LABWIRED_TEST_DEBUG="$debug" bash "$ROOT/tests/hardware-release-contract.sh" >"${TMPDIR:-/tmp}/hardware-release-debug-$debug.log" 2>&1
done
grep -q TRACE "${TMPDIR:-/tmp}/hardware-cli-debug-1.log"
grep -q TRACE "${TMPDIR:-/tmp}/hardware-release-debug-1.log"
! grep -q TRACE "${TMPDIR:-/tmp}/hardware-cli-debug-0.log"
! grep -q TRACE "${TMPDIR:-/tmp}/hardware-release-debug-0.log"

# Loaded runners must not turn a briefly delayed local fixture into a silent
# contract failure. Three seconds exceeds the historical one/two-second polls.
LABWIRED_TEST_FIXTURE_DELAY=3 bash "$ROOT/tests/hardware-cli.sh" \
  >"${TMPDIR:-/tmp}/hardware-cli-delayed.log" 2>&1
LABWIRED_TEST_FIXTURE_DELAY=3 bash "$ROOT/tests/hardware-release-contract.sh" \
  >"${TMPDIR:-/tmp}/hardware-release-delayed.log" 2>&1

echo 'PASS hardware debug traps preserve rc and gate diagnostics'
