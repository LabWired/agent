#!/usr/bin/env bash
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIX="$ROOT/fixtures/develop-acceptance"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
pass=0 skip=0 fail=0

result() {
  local status="$1" scenario="$2" detail="$3"
  case "$status" in
    PASS) pass=$((pass + 1)) ;;
    SKIP) skip=$((skip + 1)) ;;
    FAIL) fail=$((fail + 1)) ;;
  esac
  printf '%-4s  %-28s %s\n' "$status" "$scenario" "$detail"
}

compile_pio() {
  pio run -d "$1" >"$2" 2>&1
}

# 1. Greenfield ESP32-C3: a real PlatformIO compile is mandatory.
if ! command -v pio >/dev/null 2>&1; then
  result SKIP greenfield-esp32c3 "PlatformIO unavailable"
else
  cp -R "$FIX/esp32c3" "$WORK/greenfield"
  if compile_pio "$WORK/greenfield" "$WORK/greenfield.log" \
    && test -f "$WORK/greenfield/.pio/build/esp32-c3-devkitm-1/firmware.elf" \
    && [[ "$(strings "$WORK/greenfield/.pio/build/esp32-c3-devkitm-1/firmware.elf" | grep -c '^alive$')" -ge 1 ]]; then
    result PASS greenfield-esp32c3 "compile + built serial marker checked; LED gap; attempts=1; overall=compiled_only"
  else
    result FAIL greenfield-esp32c3 "pio compile failed (attempts=1); see $WORK/greenfield.log"
  fi
fi

# 2. Existing STM32F103: edit in place, compile, and measure layout/config preservation.
if ! command -v pio >/dev/null 2>&1; then
  result SKIP existing-stm32f103 "PlatformIO unavailable"
else
  cp -R "$FIX/stm32f103" "$WORK/stm32"
  before_paths="$(cd "$WORK/stm32" && find . -type f ! -path './.pio/*' | sort)"
  before_config="$(shasum "$WORK/stm32/platformio.ini" | awk '{print $1}')"
  before_source="$(shasum "$WORK/stm32/src/main.cpp" | awk '{print $1}')"
  python3 - "$WORK/stm32/src/main.cpp" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
old = p.read_text()
needle = "  // ACCEPTANCE_HEARTBEAT"
assert old.count(needle) == 1
p.write_text(old.replace(needle, "  digitalWrite(PC13, !digitalRead(PC13));\n  delay(1000);"))
PY
  after_paths="$(cd "$WORK/stm32" && find . -type f ! -path './.pio/*' | sort)"
  after_config="$(shasum "$WORK/stm32/platformio.ini" | awk '{print $1}')"
  after_source="$(shasum "$WORK/stm32/src/main.cpp" | awk '{print $1}')"
  if compile_pio "$WORK/stm32" "$WORK/stm32.log" \
    && [[ "$before_paths" == "$after_paths" ]] \
    && [[ "$before_config" == "$after_config" ]] \
    && [[ "$before_source" != "$after_source" ]]; then
    result PASS existing-stm32f103 "layout/config preserved; heartbeat runtime gap; attempts=1; overall=compiled_only"
  else
    result FAIL existing-stm32f103 "compile or measured layout preservation failed"
  fi
fi

# 3. Compile recovery: observe red, make one diagnostic-directed repair, observe green.
if ! command -v pio >/dev/null 2>&1; then
  result SKIP compile-recovery-esp32c3 "PlatformIO unavailable"
else
  cp -R "$FIX/esp32c3" "$WORK/recovery"
  cp "$WORK/recovery/main-broken.cpp" "$WORK/recovery/src/main.cpp"
  if compile_pio "$WORK/recovery" "$WORK/recovery-1.log"; then
    result FAIL compile-recovery-esp32c3 "broken fixture unexpectedly compiled (attempts=1)"
  elif ! grep -q "expected.*;.*before" "$WORK/recovery-1.log"; then
    result FAIL compile-recovery-esp32c3 "first failure lacked expected compiler diagnostic (attempts=1)"
  else
    python3 - "$WORK/recovery/src/main.cpp" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
old = p.read_text()
needle = '  Serial.println("alive")\n'
assert old.count(needle) == 1
p.write_text(old.replace(needle, '  Serial.println("alive");\n'))
PY
    if compile_pio "$WORK/recovery" "$WORK/recovery-2.log"; then
      result PASS compile-recovery-esp32c3 "red then focused repair then green; attempts=2/3; overall=compiled_only"
    else
      result FAIL compile-recovery-esp32c3 "repair compile failed (attempts=2/3)"
    fi
  fi
fi

# 4. Partial LED + Wi-Fi: require a real local twin marker check; Wi-Fi remains uncovered.
SIM=""
if [[ -x "$HOME/.labwired/tools/sim/labwired-sim" ]]; then
  SIM="$HOME/.labwired/tools/sim/labwired-sim"
elif command -v labwired-sim >/dev/null 2>&1; then
  SIM="$(command -v labwired-sim)"
fi
if [[ -z "$SIM" || ! -f "$ROOT/fixtures/gate1-live/firmware/gate1-fixed.elf" ]]; then
  result SKIP partial-led-wifi "local sim or committed ESP32-C3 ELF unavailable"
else
  mkdir -p "$WORK/twin"
  python3 - "$WORK/twin/test.yaml" "$ROOT/fixtures/gate1-live/firmware/gate1-fixed.elf" "$ROOT/share/catalog/systems/esp32c3.yaml" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).write_text(f'''schema_version: "1.0"
inputs:
  firmware: "{sys.argv[2]}"
  system: "{sys.argv[3]}"
limits:
  max_steps: 5000000
  stop_when_assertions_pass: true
assertions:
  - uart_contains: "LABWIRED_OK"
''')
PY
  if "$SIM" test --script "$WORK/twin/test.yaml" --output-dir "$WORK/twin/out" --no-uart-stdout \
      >"$WORK/twin.log" 2>&1 \
    && grep -q '"passed": true' "$WORK/twin/out/result.json" \
    && grep -q 'LABWIRED_OK' "$WORK/twin/out/uart.log" \
    && python3 "$ROOT/scripts/compose-elements.py" --uart "$WORK/twin/out/uart.log" \
         --out "$WORK/twin/led-observation.json" >/dev/null \
    && python3 - "$WORK/twin/out/result.json" "$WORK/twin/led-observation.json" <<'PY'
import json, sys
result = json.load(open(sys.argv[1], encoding="utf-8"))
assert len(result["assertions"]) == 1
assert result["assertions"][0]["assertion"] == {"uart_contains": "LABWIRED_OK"}
assert result["assertions"][0]["passed"] is True
observation = json.load(open(sys.argv[2], encoding="utf-8"))
led = next(s for s in observation["series"] if s["id"] == "led_from_uart")
assert led["provenance"] == "derived_from_uart" and led["points"]
assert "Observation only" in observation["note"]
PY
  then
    result PASS partial-led-wifi "LED observed from live twin UART; Wi-Fi uncovered; overall=partially_verified"
  else
    result FAIL partial-led-wifi "supported local twin check failed"
  fi
fi

# 5. Unsupported board: real host compile, catalog absence, and compiled-only ceiling.
if ! command -v cc >/dev/null 2>&1; then
  result SKIP unsupported-custom-board "host C compiler unavailable"
else
  cp -R "$FIX/custom-board" "$WORK/custom"
  if make -C "$WORK/custom" >"$WORK/custom.log" 2>&1 \
    && test -x "$WORK/custom/firmware" \
    && ! grep -R -q 'acme_custom_mcu_v1' "$ROOT/share/catalog"; then
    result PASS unsupported-custom-board "host compile passed; no catalog/twin target; overall=compiled_only"
  else
    result FAIL unsupported-custom-board "compile failed or custom board unexpectedly cataloged"
  fi
fi

# Claim boundaries use actual generated compile/twin artifacts and negative claim gates.
if [[ ! -f "$WORK/greenfield/.pio/build/esp32-c3-devkitm-1/firmware.elf" \
   || ! -f "$WORK/twin/out/result.json" ]]; then
  result SKIP claim-boundaries "real compile/twin artifacts unavailable"
elif ! "$ROOT/bin/labwired" assert-status model_verified \
       "$WORK/greenfield/.pio/build/esp32-c3-devkitm-1/firmware.elf" >/dev/null 2>&1 \
  && ! "$ROOT/bin/labwired" assert-status hardware_observed \
       "$WORK/twin/out/result.json" >/dev/null 2>&1; then
  result PASS claim-boundaries "compile cannot mint model_verified; twin cannot mint hardware_observed; overall=boundaries_enforced"
else
  result FAIL claim-boundaries "claim boundary rejection failed or prerequisite artifact missing"
fi

printf '\nSUMMARY CHECKS_PASS=%d SKIP=%d FAIL=%d REQUIRED_COMPLETE=%s\n' \
  "$pass" "$skip" "$fail" "$([[ "$skip" -eq 0 && "$fail" -eq 0 ]] && echo true || echo false)"
[[ "$skip" -eq 0 && "$fail" -eq 0 ]]
