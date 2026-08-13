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
tracked_pids=()
cleanup() {
  local pid
  for pid in "${tracked_pids[@]}"; do
    kill -KILL "$pid" 2>/dev/null || true
  done
  rm -rf "$TMP"
}
trap cleanup EXIT

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
python3 "$RUNNER" --timeout 0.1 -- python3 -c 'import signal, subprocess, sys, time; descendant = subprocess.Popen([sys.executable, "-c", "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)"]); print(descendant.pid, flush=True); time.sleep(30)' >"$TMP/descendant.out" 2>"$TMP/descendant.err"
status=$?
set -e
descendant_pid="$(<"$TMP/descendant.out")"
tracked_pids+=("$descendant_pid")
assert_eq "stubborn descendant timeout exit" "$status" "124"
assert_process_gone "stubborn descendant terminates with group" "$descendant_pid"

interrupt_pid_file="$TMP/interrupt.pid"
PID_FILE="$interrupt_pid_file" python3 "$RUNNER" --timeout 10 -- python3 -c 'import os, time; open(os.environ["PID_FILE"], "w").write(str(os.getpid())); time.sleep(30)' >"$TMP/interrupt.out" 2>"$TMP/interrupt.err" &
interrupt_runner_pid=$!
tracked_pids+=("$interrupt_runner_pid")
if wait_for_file "$interrupt_pid_file"; then
  interrupt_child_pid="$(<"$interrupt_pid_file")"
  tracked_pids+=("$interrupt_child_pid")
  kill -TERM "$interrupt_runner_pid"
  set +e
  wait "$interrupt_runner_pid"
  status=$?
  set -e
  assert_eq "interrupted wrapper exit" "$status" "143"
  assert_process_gone "interrupted wrapper terminates child" "$interrupt_child_pid"
else
  echo "FAIL interrupted wrapper starts child"
  fail=1
fi

if python3 -c 'import signal, sys; sys.exit(0 if hasattr(signal, "SIGHUP") else 1)'; then
  hup_pid_file="$TMP/hup.pid"
  PID_FILE="$hup_pid_file" python3 "$RUNNER" --timeout 10 -- python3 -c 'import os, time; open(os.environ["PID_FILE"], "w").write(str(os.getpid())); time.sleep(30)' >"$TMP/hup.out" 2>"$TMP/hup.err" &
  hup_runner_pid=$!
  tracked_pids+=("$hup_runner_pid")
  if wait_for_file "$hup_pid_file"; then
    hup_child_pid="$(<"$hup_pid_file")"
    tracked_pids+=("$hup_child_pid")
    kill -HUP "$hup_runner_pid"
    set +e
    wait "$hup_runner_pid"
    status=$?
    set -e
    assert_eq "SIGHUP wrapper exit" "$status" "129"
    assert_process_gone "SIGHUP wrapper terminates child" "$hup_child_pid"
  else
    echo "FAIL SIGHUP wrapper starts child"
    fail=1
  fi
else
  echo "skip SIGHUP cleanup: signal unavailable"
fi

set +e
python3 "$RUNNER" --timeout 1 -- python3 -c 'import os, signal; os.kill(os.getpid(), signal.SIGTERM)' >"$TMP/signaled.out" 2>"$TMP/signaled.err"
status=$?
set -e
assert_eq "signaled child maps to shell status" "$status" "143"

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
