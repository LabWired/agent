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

# compose-job: ask → recipe → non-empty (ties D5 without invent)
run "compose-job LED vs UART" \
  python3 "$ROOT/scripts/compose-job.py" \
    --ask "plot LED vs UART" \
    --uart "$OUT/demo-uart.log" \
    --out "$OUT/job-led.json"

python3 - <<PY
import json, subprocess, sys
from pathlib import Path
out = Path("$OUT")
root = Path("$ROOT")
fail = 0
job = json.loads((out / "job-led.json").read_text())
if not job.get("ok") or not (job.get("series") or job.get("markers")):
    print("FAIL compose-job empty")
    fail = 1
else:
    print("ok   compose-job non-empty")
if job.get("recipe_id") != "e3_led_vs_uart":
    print(f"FAIL recipe_id={job.get('recipe_id')}")
    fail = 1
else:
    print("ok   compose-job recipe e3_led_vs_uart")
if job.get("status") == "model_verified":
    print("FAIL job must not set status=model_verified")
    fail = 1
else:
    print("ok   compose-job is observation")
(out / "empty-src.log").write_text("")
r = subprocess.run(
    [sys.executable, str(root / "scripts/compose-job.py"),
     "--ask", "plot LED vs UART", "--uart", str(out / "empty-src.log"),
     "--out", str(out / "job-empty.json")],
    capture_output=True, text=True,
)
if r.returncode == 0:
    print("FAIL compose-job empty uart should fail")
    fail = 1
else:
    print("ok   compose-job empty uart fails closed")
sys.exit(fail)
PY
ec=$?
if [[ "$ec" -ne 0 ]]; then fail=1; fi

if [[ "$fail" -ne 0 ]]; then
  echo "compose-helpers FAILED"
  exit 1
fi
echo "ok   compose-helpers PASS"
exit 0
