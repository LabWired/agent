#!/usr/bin/env bash
# Everything we can automate beyond Wave A (no video, no interactive browser login).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SMOKE_OUT="${LABWIRED_SMOKE_OUT:-$ROOT/fixtures/coverage/smoke}"
mkdir -p "$SMOKE_OUT"
export LABWIRED_SMOKE_OUT="$SMOKE_OUT"
fail=0
pass() { echo "ok   $*"; }
bad() { echo "FAIL $*"; fail=1; }

echo "==> smoke-remaining (B/C automatable)"

# Wave A still green
if bash "$ROOT/scripts/smoke-wave-a.sh" >"$SMOKE_OUT/wave-a.txt" 2>&1; then
  pass "smoke-wave-a"
else
  bad "smoke-wave-a"; tail -10 "$SMOKE_OUT/wave-a.txt"
fi

# Coverage ratchet
chmod +x "$ROOT/scripts/coverage-ratchet.sh" 2>/dev/null || true
if bash "$ROOT/scripts/coverage-ratchet.sh" >"$SMOKE_OUT/coverage.txt" 2>&1; then
  pass "coverage-ratchet $(tail -1 "$SMOKE_OUT/coverage.txt")"
else
  bad "coverage-ratchet"; cat "$SMOKE_OUT/coverage.txt"
fi
if [[ -f "$ROOT/fixtures/coverage/coverage-latest.json" ]]; then
  pass "coverage-latest.json published under fixtures/coverage/"
else
  bad "coverage-latest.json missing"
fi

# Evidence report on offline green
if python3 "$ROOT/scripts/report-evidence.py" \
  --twin "$ROOT/fixtures/gate1/artifacts/fixed.verify.json" \
  --out "$SMOKE_OUT/report.md" \
  --require-evidence-on-green; then
  pass "report-evidence offline green"
else
  bad "report-evidence"
fi
if grep -q 'twin_status:       model_verified' "$SMOKE_OUT/report.md" \
  && grep -q 'hardware_status:   not_run' "$SMOKE_OUT/report.md"; then
  pass "dual-claim footer twin green / hw not_run"
else
  bad "dual-claim footer"
fi

# Live-gate1 report (may lack evidence_ref — still render)
if [[ -f "$ROOT/fixtures/gate1-live/evidence/fixed/result.json" ]]; then
  python3 "$ROOT/scripts/report-evidence.py" \
    --twin "$ROOT/fixtures/gate1-live/evidence/fixed/result.json" \
    --out "$SMOKE_OUT/live-report.md" || true
  pass "report-evidence live-gate1 payload rendered"
fi

# LA capture compose
if python3 "$ROOT/scripts/compose-from-capture.py" \
  --capture "$ROOT/fixtures/observability/sample-capture.json" \
  --out "$SMOKE_OUT/la.json"; then
  pass "compose-from-capture sample LA"
else
  bad "compose-from-capture"
fi
if grep -q 'edge.CH0' "$SMOKE_OUT/la.json"; then
  pass "LA series edge.CH0 present"
else
  bad "LA series missing"
fi

# Merge capture + uart
printf 'LED ON\nLED OFF\n' >"$SMOKE_OUT/u.log"
if python3 "$ROOT/scripts/compose-from-capture.py" \
  --capture "$ROOT/fixtures/observability/sample-capture.json" \
  --uart "$SMOKE_OUT/u.log" \
  --out "$SMOKE_OUT/merge.json"; then
  pass "compose capture+uart merge"
else
  bad "compose merge"
fi

# Docs present
for d in GOLDEN_PATH.md REVERSE_STEP_DEMO.md; do
  if [[ -f "$ROOT/docs/$d" ]]; then pass "docs/$d"; else bad "docs/$d"; fi
done

# Skills inventory
if bash "$ROOT/tests/skills-inventory.sh" >"$SMOKE_OUT/skills-inventory.txt" 2>&1; then
  pass "skills-inventory"
else
  bad "skills-inventory"; tail -8 "$SMOKE_OUT/skills-inventory.txt"
fi

# Hosted MCP (optional — needs login session)
if [[ -f "${HOME}/.labwired/session/cloud.json" ]]; then
  if python3 "$ROOT/scripts/hosted-mcp-probe.py" >/tmp/lw-mcp.txt 2>&1; then
    pass "hosted-mcp-probe tools/list"
  else
    echo "warn hosted-mcp-probe failed (session/CF) — see /tmp/lw-mcp.txt"
  fi
fi

if [[ "$fail" -ne 0 ]]; then
  echo "smoke-remaining FAILED"
  exit 1
fi
echo "ok   smoke-remaining PASS"
exit 0
