#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHIP_GATE="$ROOT/scripts/ship-gate.sh"

fail=0
assert_source_contains() {
  local name="$1" pattern="$2"
  if grep -Eq -- "$pattern" "$SHIP_GATE"; then
    echo "ok   $name"
  else
    echo "FAIL $name: missing source pattern '$pattern'"
    fail=1
  fi
}

assert_source_not_contains() {
  local name="$1" pattern="$2"
  if grep -Eq -- "$pattern" "$SHIP_GATE"; then
    echo "FAIL $name: forbidden source pattern '$pattern'"
    fail=1
  else
    echo "ok   $name"
  fi
}

assert_eq() {
  local name="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    echo "ok   $name"
  else
    echo "FAIL $name: got='$got' want='$want'"
    fail=1
  fi
}

assert_source_contains "shared run_stage helper" '^run_stage\(\)'
assert_source_contains "configurable stage timeout" 'LABWIRED_SHIP_STAGE_TIMEOUT'
assert_source_contains "portable bounded runner" 'scripts/run-bounded\.py'
assert_source_contains "final result evidence" '\$OUT/result\.txt'
assert_source_contains "compose artifact diagnostic is guarded" \
  'show_diagnostics all "\$OUT/compose-job\.json"'
assert_source_not_contains "no unguarded output diagnostics" \
  '^[[:space:]]+(cat|tail)[[:space:]]+"\$OUT/'
assert_source_contains "SIGHUP cancellation trap" "trap 'cancel_gate HUP 1' HUP"
assert_source_contains "SIGINT cancellation trap" "trap 'cancel_gate INT 2' INT"
assert_source_contains "SIGQUIT cancellation trap" "trap 'cancel_gate QUIT 3' QUIT"
assert_source_contains "SIGTERM cancellation trap" "trap 'cancel_gate TERM 15' TERM"

expected_stages="$(printf '%s\n' \
  hosted-auth-probe doctor whoami assert-fixed assert-broken live-gate1 \
  compose-uart compose-job compose-job-validate knowledge-top-parts \
  knowledge-top-parts-local golden-path-entry golden-path-default \
  skills-verify-all import-diagram import-multi desk-hw knowledge-mcp \
  develop-agent | sort)"
actual_stages="$(sed -E -n \
  's/^[[:space:]]*(if |&& )?run_stage "([a-z][a-z0-9-]*)".*/\2/p' \
  "$SHIP_GATE" | sort)"
assert_eq "complete production stage inventory uses run_stage" \
  "$actual_stages" "$expected_stages"

if [[ "$fail" -ne 0 ]]; then
  echo "ship-gate bounds contract FAILED"
  exit 1
fi

TMP="$(mktemp -d)"
tracked_pids=()
cleanup() {
  local pid
  for pid in "${tracked_pids[@]}"; do
    kill -KILL "$pid" 2>/dev/null || true
  done
  rm -rf "$TMP"
}
trap cleanup EXIT

wait_for_file() {
  local file="$1" deadline
  deadline=$((SECONDS + 3))
  while [[ ! -s "$file" ]]; do
    if (( SECONDS >= deadline )); then
      return 1
    fi
    sleep 0.05
  done
}

assert_process_gone() {
  local name="$1" pid="$2" deadline
  deadline=$((SECONDS + 3))
  while kill -0 "$pid" 2>/dev/null; do
    if (( SECONDS >= deadline )); then
      echo "FAIL $name: process $pid is still running"
      fail=1
      return
    fi
    sleep 0.05
  done
  echo "ok   $name"
}
FIXTURES="$TMP/fixtures"
OUT="$TMP/out"
mkdir -p "$FIXTURES" "$OUT"

printf '%s\n' '#!/usr/bin/env bash' 'sleep 30' >"$FIXTURES/hang.sh"
printf '%s\n' '#!/usr/bin/env bash' \
  'printf "later fixture ran\n"' \
  'printf "continued\n" >"$LABWIRED_SHIP_FIXTURE_MARKER"' >"$FIXTURES/later.sh"

set +e
LABWIRED_SHIP_FIXTURE_DIR="$FIXTURES" \
LABWIRED_SHIP_FIXTURE_MARKER="$TMP/later.marker" \
LABWIRED_SHIP_STAGE_TIMEOUT=2 \
LABWIRED_SMOKE_OUT="$OUT" \
  bash "$SHIP_GATE" >"$TMP/gate.out" 2>&1
status=$?
set -e

if [[ "$status" -eq 0 ]]; then
  echo "FAIL timed-out fixture makes gate fail: exit=$status"
  fail=1
else
  echo "ok   timed-out fixture makes gate fail"
fi

if grep -qi 'timeout' "$OUT/hang.txt" 2>/dev/null; then
  echo "ok   timeout recorded in stage log"
else
  echo "FAIL timeout recorded in stage log"
  fail=1
fi

if [[ -f "$TMP/later.marker" ]] && grep -Fq 'later fixture ran' "$OUT/later.txt"; then
  echo "ok   later independent fixture ran"
else
  echo "FAIL later independent fixture ran"
  fail=1
fi

if [[ -f "$OUT/result.txt" ]]; then
  assert_eq "final result evidence" "$(<"$OUT/result.txt")" "FAIL"
else
  echo "FAIL final result evidence: missing $OUT/result.txt"
  fail=1
fi

final_count="$(grep -Ec 'ship-gate (PASS|FAILED)$' "$TMP/gate.out" || true)"
assert_eq "exactly one final ship-gate result" "$final_count" "1"
assert_eq "final console result is failure" "$(tail -1 "$TMP/gate.out")" "ship-gate FAILED"

ARTIFACT_FIXTURES="$TMP/artifact-fixtures"
ARTIFACT_OUT="$TMP/artifact-out"
mkdir -p "$ARTIFACT_FIXTURES" "$ARTIFACT_OUT"
printf '%s\n' '#!/usr/bin/env bash' 'printf "stage succeeded without artifact\n"' \
  >"$ARTIFACT_FIXTURES/artifact.sh"
printf '%s\n' "$TMP/expected-artifact.json" \
  >"$ARTIFACT_FIXTURES/artifact.sh.artifact"
printf '%s\n' '#!/usr/bin/env bash' \
  'printf "later artifact fixture ran\n"' \
  'printf "continued\n" >"$LABWIRED_SHIP_FIXTURE_MARKER"' \
  >"$ARTIFACT_FIXTURES/later.sh"

set +e
LABWIRED_SHIP_FIXTURE_DIR="$ARTIFACT_FIXTURES" \
LABWIRED_SHIP_FIXTURE_MARKER="$TMP/artifact-later.marker" \
LABWIRED_SHIP_STAGE_TIMEOUT=2 \
LABWIRED_SMOKE_OUT="$ARTIFACT_OUT" \
  bash "$SHIP_GATE" >"$TMP/artifact-gate.out" 2>&1
artifact_status=$?
set -e

if [[ "$artifact_status" -eq 0 ]]; then
  echo "FAIL missing artifact makes gate fail: exit=$artifact_status"
  fail=1
else
  echo "ok   missing artifact makes gate fail"
fi

if grep -Fq 'missing artifact' "$TMP/artifact-gate.out"; then
  echo "ok   missing artifact reported"
else
  echo "FAIL missing artifact reported"
  fail=1
fi

if [[ -f "$TMP/artifact-later.marker" ]] \
  && grep -Fq 'later artifact fixture ran' "$ARTIFACT_OUT/later.txt"; then
  echo "ok   fixture after missing artifact ran"
else
  echo "FAIL fixture after missing artifact ran"
  fail=1
fi

if [[ -f "$ARTIFACT_OUT/result.txt" ]]; then
  assert_eq "missing artifact final evidence" "$(<"$ARTIFACT_OUT/result.txt")" "FAIL"
else
  echo "FAIL missing artifact final evidence: missing $ARTIFACT_OUT/result.txt"
  fail=1
fi

artifact_final_count="$(grep -Ec 'ship-gate (PASS|FAILED)$' "$TMP/artifact-gate.out" || true)"
assert_eq "missing artifact has one final result" "$artifact_final_count" "1"
assert_eq "missing artifact final console failure" \
  "$(tail -1 "$TMP/artifact-gate.out")" "ship-gate FAILED"

EXIT_124_FIXTURES="$TMP/exit-124-fixtures"
EXIT_124_OUT="$TMP/exit-124-out"
mkdir -p "$EXIT_124_FIXTURES" "$EXIT_124_OUT"
printf '%s\n' '#!/usr/bin/env bash' 'exit 124' >"$EXIT_124_FIXTURES/natural-124.sh"
printf '%s\n' '#!/usr/bin/env bash' \
  'printf "later natural-124 fixture ran\n"' \
  'printf "continued\n" >"$LABWIRED_SHIP_FIXTURE_MARKER"' \
  >"$EXIT_124_FIXTURES/later.sh"

set +e
LABWIRED_SHIP_FIXTURE_DIR="$EXIT_124_FIXTURES" \
LABWIRED_SHIP_FIXTURE_MARKER="$TMP/exit-124-later.marker" \
LABWIRED_SHIP_STAGE_TIMEOUT=2 \
LABWIRED_SMOKE_OUT="$EXIT_124_OUT" \
  bash "$SHIP_GATE" >"$TMP/exit-124-gate.out" 2>&1
exit_124_status=$?
set -e

if [[ "$exit_124_status" -ne 0 ]] \
  && grep -Fq 'natural-124 fixture exit non-zero' "$TMP/exit-124-gate.out" \
  && ! grep -Fq 'natural-124 timeout' "$TMP/exit-124-gate.out"; then
  echo "ok   natural child 124 is an ordinary stage failure"
else
  echo "FAIL natural child 124 is an ordinary stage failure"
  fail=1
fi
if [[ -f "$TMP/exit-124-later.marker" ]]; then
  echo "ok   fixture after natural child 124 ran"
else
  echo "FAIL fixture after natural child 124 ran"
  fail=1
fi
assert_eq "natural child 124 final evidence" \
  "$(<"$EXIT_124_OUT/result.txt")" "FAIL"

CANCEL_FIXTURES="$TMP/cancel-fixtures"
CANCEL_OUT="$TMP/cancel-out"
mkdir -p "$CANCEL_FIXTURES" "$CANCEL_OUT"
printf '%s\n' '#!/usr/bin/env bash' \
  'printf "%s\n" "$PPID" >"$LABWIRED_SHIP_FIXTURE_RUNNER_MARKER"' \
  'exec python3 -c '\''import os, signal, time; [signal.signal(sig, signal.SIG_IGN) for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGQUIT)]; open(os.environ["LABWIRED_SHIP_FIXTURE_CHILD_MARKER"], "w").write(str(os.getpid())); time.sleep(30)'\''' \
  >"$CANCEL_FIXTURES/cancel.sh"

LABWIRED_SHIP_FIXTURE_DIR="$CANCEL_FIXTURES" \
LABWIRED_SHIP_FIXTURE_RUNNER_MARKER="$TMP/cancel-runner.pid" \
LABWIRED_SHIP_FIXTURE_CHILD_MARKER="$TMP/cancel-child.pid" \
LABWIRED_SHIP_STAGE_TIMEOUT=20 \
LABWIRED_SMOKE_OUT="$CANCEL_OUT" \
  bash "$SHIP_GATE" >"$TMP/cancel-gate.out" 2>&1 &
gate_pid=$!
tracked_pids+=("$gate_pid")
if wait_for_file "$TMP/cancel-runner.pid" && wait_for_file "$TMP/cancel-child.pid"; then
  cancel_runner_pid="$(<"$TMP/cancel-runner.pid")"
  cancel_child_pid="$(<"$TMP/cancel-child.pid")"
  tracked_pids+=("$cancel_runner_pid" "$cancel_child_pid")
  kill -TERM "$gate_pid"
  set +e
  wait "$gate_pid"
  cancel_status=$?
  set -e
  assert_eq "cancelled gate exits for SIGTERM" "$cancel_status" "143"
  assert_process_gone "cancelled gate reaps bounded runner" "$cancel_runner_pid"
  assert_process_gone "cancelled gate kills bounded child group" "$cancel_child_pid"
else
  echo "FAIL cancellation fixture starts runner and child"
  fail=1
fi

if [[ "$fail" -ne 0 ]]; then
  echo "ship-gate bounds contract FAILED"
  exit 1
fi
echo "ship-gate bounds contract passed"
