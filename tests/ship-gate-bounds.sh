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

if [[ "$fail" -ne 0 ]]; then
  echo "ship-gate bounds contract FAILED"
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
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

if [[ "$fail" -ne 0 ]]; then
  echo "ship-gate bounds contract FAILED"
  exit 1
fi
echo "ship-gate bounds contract passed"
