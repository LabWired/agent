#!/usr/bin/env bash
# Drive shipped compose-elements.py and compose-from-capture.py (real entry points).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${LABWIRED_SMOKE_OUT:-$ROOT/fixtures/coverage/smoke}/compose-tests"
mkdir -p "$OUT"
fail=0

run() {
  local name="$1"; shift
  if "$@"; then
    echo "ok   $name"
  else
    echo "FAIL $name"
    fail=1
  fi
}

# UART: gate1 marker must yield markers/series
printf 'LABWIRED_OK\n' >"$OUT/gate1-uart.log"
run "compose-elements gate1 uart" \
  python3 "$ROOT/scripts/compose-elements.py" \
    --uart "$OUT/gate1-uart.log" \
    --out "$OUT/uart.json"

# Demo LED lines
printf 'LED ON\nLED OFF\ntemp=12.5\n' >"$OUT/demo-uart.log"
run "compose-elements demo LED" \
  python3 "$ROOT/scripts/compose-elements.py" \
    --uart "$OUT/demo-uart.log" \
    --out "$OUT/demo.json"

# Capture fixture
run "compose-from-capture sample" \
  python3 "$ROOT/scripts/compose-from-capture.py" \
    --capture "$ROOT/fixtures/observability/sample-capture.json" \
    --out "$OUT/cap.json"

# Structural assertions on real script output
python3 - <<PY
import json, sys
from pathlib import Path
out = Path("$OUT")
fail = 0

def check(path, pred, msg):
    global fail
    d = json.loads(Path(path).read_text())
    if not pred(d):
        print(f"FAIL {msg}: {path}")
        fail = 1
    else:
        print(f"ok   {msg}")

uart = out / "uart.json"
check(uart, lambda d: bool(d.get("markers") or d.get("series")), "uart non-empty elements")
check(uart, lambda d: d.get("note") and "model_verified" not in (d.get("note") or "").lower().replace("not model", ""), "uart note present")
# must not claim model_verified as a status field
check(uart, lambda d: d.get("status") != "model_verified", "uart is observation not claim")

demo = out / "demo.json"
check(demo, lambda d: any(s.get("id") == "led_from_uart" for s in (d.get("series") or [])), "demo has led_from_uart series")
check(demo, lambda d: any(s.get("id") == "temp" for s in (d.get("series") or [])), "demo has temp series")

cap = out / "cap.json"
check(cap, lambda d: any("CH0" in (s.get("id") or "") for s in (d.get("series") or [])), "capture has CH0 series")
# empty input should fail
sys.exit(fail)
PY
ec=$?
if [[ "$ec" -ne 0 ]]; then fail=1; fi

# empty uart must not invent series with exit 0 empty success claiming data
if python3 "$ROOT/scripts/compose-elements.py" --uart <(echo "") --out "$OUT/empty.json" 2>"$OUT/empty.err"; then
  # exit 0 with empty is only ok if script returned 2 for no elements
  echo "FAIL empty uart should exit non-zero"
  fail=1
else
  echo "ok   empty uart rejects (no invent)"
fi

if [[ "$fail" -ne 0 ]]; then
  echo "compose-helpers FAILED"
  exit 1
fi
echo "ok   compose-helpers PASS"
exit 0
