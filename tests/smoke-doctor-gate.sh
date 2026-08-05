#!/usr/bin/env bash
# Prove smoke-wave-a does NOT treat doctor "not ready" as pass (substring bug).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH="${LABWIRED_SMOKE_OUT:-$ROOT/fixtures/coverage/smoke}/doctor-gate"
mkdir -p "$SCRATCH/fakebin"

# Fake labwired: doctor fails with "not ready" (real fail path text)
cat >"$SCRATCH/fakebin/labwired" <<'EOF'
#!/usr/bin/env bash
cmd="${1:-}"
if [[ "$cmd" == "doctor" ]]; then
  echo "==> ok  opencode-binary: fake"
  printf '\033[31mFAIL\033[0m skill: missing\n'
  echo "not ready — fix FAILs above (./install.sh --full)"
  exit 1
fi
# Allow assert-status to delegate if smoke continues past doctor (must not)
if [[ "$cmd" == "assert-status" ]]; then
  echo "assert-status should not run after doctor fail" >&2
  exit 99
fi
exit 0
EOF
chmod +x "$SCRATCH/fakebin/labwired"

export LABWIRED="$SCRATCH/fakebin/labwired"
export LABWIRED_SMOKE_OUT="$SCRATCH/out"
mkdir -p "$LABWIRED_SMOKE_OUT"

set +e
bash "$ROOT/scripts/smoke-wave-a.sh" >"$SCRATCH/smoke.log" 2>&1
ec=$?
set -e

if [[ "$ec" -eq 0 ]]; then
  echo "FAIL smoke-wave-a exited 0 when doctor not ready"
  cat "$SCRATCH/smoke.log"
  exit 1
fi

if grep -q 'doctor ready (warns ok)' "$SCRATCH/smoke.log"; then
  echo "FAIL still accepts doctor via warns-ok false positive"
  cat "$SCRATCH/smoke.log"
  exit 1
fi

if ! grep -qE 'FAIL doctor' "$SCRATCH/smoke.log"; then
  echo "FAIL expected FAIL doctor line"
  cat "$SCRATCH/smoke.log"
  exit 1
fi

if grep -q 'Wave A automated smoke PASS' "$SCRATCH/smoke.log"; then
  echo "FAIL smoke reported PASS with doctor fail"
  exit 1
fi

echo "ok   smoke-wave-a fails when doctor not ready (no ready substring FO)"
exit 0
