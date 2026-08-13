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

if [[ "$fail" -ne 0 ]]; then
  echo "ship-gate bounds contract FAILED"
  exit 1
fi
echo "ship-gate bounds contract passed"
