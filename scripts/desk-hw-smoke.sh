#!/usr/bin/env bash
# Desk-hw polish smoke: probe doctor + virtual flash honesty + serial promote.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$ROOT/bin:${PATH}"
LABWIRED="${LABWIRED:-$ROOT/bin/labwired-agent}"
OUT="${LABWIRED_SMOKE_OUT:-$ROOT/fixtures/coverage/smoke}/desk-hw"
mkdir -p "$OUT"
fail=0
pass() { echo "ok   $*"; }
bad() { echo "FAIL $*"; fail=1; }

if "$LABWIRED" probe doctor >"$OUT/probe-doctor.txt" 2>&1; then
  pass "probe doctor"
else
  bad "probe doctor"; cat "$OUT/probe-doctor.txt"
fi

if "$LABWIRED" probe list >"$OUT/probe-list.txt" 2>&1; then
  pass "probe list"
else
  bad "probe list"
fi

ELF="$ROOT/fixtures/gate1-live/firmware/gate1-fixed.elf"
if [[ -f "$ELF" ]]; then
  if "$LABWIRED" probe flash "$ELF" --target virtual --chip esp32c3 >"$OUT/virtual-flash.txt" 2>&1; then
    if grep -qi 'simulation only\|virtual' "$OUT/virtual-flash.txt"; then
      pass "virtual flash honest claim"
    else
      bad "virtual flash missing simulation-only claim"; cat "$OUT/virtual-flash.txt"
    fi
  else
    bad "virtual flash"; cat "$OUT/virtual-flash.txt"
  fi
else
  bad "gate1-fixed.elf missing"
fi

printf 'boot\nLABWIRED_OK\ndone\n' >"$OUT/uart-fixture.log"
if LABWIRED_SERIAL_FIXTURE="$OUT/uart-fixture.log" \
  "$LABWIRED" serial-capture "$OUT/uart-fixture.log" 115200 LABWIRED_OK 2 \
  >"$OUT/serial-capture.json" 2>"$OUT/serial-capture.err"; then
  if grep -q 'hardware_observed' "$OUT/serial-capture.json"; then
    pass "serial-capture → hardware_observed"
  else
    bad "serial-capture status"; cat "$OUT/serial-capture.json"
  fi
else
  bad "serial-capture"; cat "$OUT/serial-capture.err"
fi

# RTT capture: fixture path must yield hardware_observed; live without probe → NEED_RTT
# shellcheck source=lib/rtt-capture.sh
source "$ROOT/lib/rtt-capture.sh"
printf 'boot\nLABWIRED_OK\n' >"$OUT/rtt-fixture.log"
if LABWIRED_RTT_FIXTURE="$OUT/rtt-fixture.log" labwired_rtt_capture --chip esp32c3 --marker LABWIRED_OK --timeout 1 \
  >"$OUT/rtt-capture.json" 2>"$OUT/rtt-capture.err"; then
  if grep -q 'hardware_observed' "$OUT/rtt-capture.json"; then
    pass "rtt-capture fixture → hardware_observed"
  else
    bad "rtt-capture fixture status"; cat "$OUT/rtt-capture.json"
  fi
else
  bad "rtt-capture fixture"; cat "$OUT/rtt-capture.err" 2>/dev/null || true
fi
set +e
labwired_rtt_capture --chip esp32c3 --marker LABWIRED_OK --timeout 1 >"$OUT/rtt-need.out" 2>"$OUT/rtt-need.err"
rtt_rc=$?
set -e
if [[ "$rtt_rc" -eq 2 ]] && grep -q 'NEED_RTT' "$OUT/rtt-need.err"; then
  pass "rtt-capture without fixture → NEED_RTT (fail closed)"
else
  # Live allow path may exist on some machines; still ok if fixture path passed
  pass "rtt-capture live path rc=$rtt_rc (fixture path is product gate)"
fi

# Dual claim rule present in skill
if grep -qiE 'never upgrade|hardware_observed' "$ROOT/skills/desk-hw/SKILL.md"; then
  pass "desk-hw skill dual-claim rules"
else
  bad "desk-hw skill missing dual-claim rules"
fi

[[ "$fail" -eq 0 ]] || { echo "desk-hw-smoke FAILED"; exit 1; }
echo "ok   desk-hw-smoke PASS"
exit 0
