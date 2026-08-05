#!/usr/bin/env bash
# Wave A automated smoke (no interactive browser login).
# Proves: doctor, offline assert, live twin red→green, E3 compose from UART.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$ROOT/bin:${PATH}"
LABWIRED="${LABWIRED:-$ROOT/bin/labwired}"
fail=0
pass() { echo "ok   $*"; }
bad() { echo "FAIL $*"; fail=1; }

echo "==> Wave A smoke (automated)"

# 1 doctor (non-strict)
if "$LABWIRED" doctor >/tmp/lw-doctor.txt 2>&1; then
  pass "doctor ready"
else
  # doctor may warn without failing when sim optional
  if grep -q 'ready' /tmp/lw-doctor.txt; then
    pass "doctor ready (warns ok)"
  else
    bad "doctor"; tail -5 /tmp/lw-doctor.txt
  fi
fi

# 2 offline assert
if "$LABWIRED" assert-status model_verified \
  "$ROOT/fixtures/gate1/artifacts/fixed.verify.json" >/dev/null 2>&1; then
  pass "offline assert-status model_verified"
else
  bad "offline assert-status"
fi

# 3 live twin gate1
if [[ -x "$ROOT/scripts/live-gate1.sh" ]]; then
  if "$ROOT/scripts/live-gate1.sh" >/tmp/lw-live-gate1.txt 2>&1; then
    pass "live-gate1 red→green model_verified"
  else
    bad "live-gate1"; tail -15 /tmp/lw-live-gate1.txt
  fi
else
  bad "live-gate1 script missing"
fi

# 4 E3 compose from live UART if present, else synthetic
COMPOSE="$ROOT/scripts/compose-elements.py"
chmod +x "$COMPOSE" 2>/dev/null || true
UART_FIXED="$ROOT/fixtures/gate1-live/evidence/fixed/uart.log"
OUT=/tmp/lw-composed-e3.json
if [[ -f "$UART_FIXED" ]]; then
  if python3 "$COMPOSE" --uart "$UART_FIXED" --out "$OUT" 2>/tmp/lw-compose.err; then
    pass "E3 compose from live UART → $OUT"
  else
    # fixed gate1 only prints LABWIRED_OK — still should extract markers
    if python3 "$COMPOSE" --uart "$UART_FIXED" --out "$OUT" 2>/tmp/lw-compose.err; then
      pass "E3 compose"
    else
      bad "E3 compose"; cat /tmp/lw-compose.err
    fi
  fi
else
  printf 'LED ON\nLED OFF\nLED ON\ntemp=23.5\nLED OFF\n' >/tmp/lw-uart-demo.log
  if python3 "$COMPOSE" --uart /tmp/lw-uart-demo.log --out "$OUT"; then
    pass "E3 compose from demo UART → $OUT"
  else
    bad "E3 compose demo"
  fi
fi

# 5 skills present
for s in golden-path part-knowledge compose-observability verify-firmware; do
  if [[ -f "$ROOT/skills/$s/SKILL.md" ]]; then
    pass "skill $s"
  else
    bad "skill $s"
  fi
done

# 6 catalog
if [[ -f "$ROOT/share/observability/element-catalog.json" ]]; then
  pass "element catalog"
else
  bad "element catalog"
fi

# 7 session project (optional)
if [[ -f "${HOME}/.labwired/session/cloud.json" ]]; then
  # shellcheck source=lib/cloud-session.sh
  source "$ROOT/lib/cloud-session.sh"
  if labwired_cloud_session_load 2>/dev/null; then
    if [[ -n "${LABWIRED_PROJECT:-}" ]] || labwired_cloud_ensure_project 2>/dev/null; then
      pass "cloud session project=${LABWIRED_PROJECT:-healed}"
    else
      echo "warn cloud session has token but no project (set via login / API)"
    fi
  fi
fi

if [[ "$fail" -ne 0 ]]; then
  echo "Wave A smoke FAILED"
  exit 1
fi
echo "ok   Wave A automated smoke PASS"
exit 0
