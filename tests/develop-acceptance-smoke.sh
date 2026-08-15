#!/usr/bin/env bash
# Develop prompt mechanics acceptance.
# Default: bash tests/develop-acceptance-smoke.sh
# Strict release gate: LABWIRED_ACCEPTANCE_REQUIRE_COMPLETE=1 bash tests/develop-acceptance-smoke.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIX="$ROOT/fixtures/develop-acceptance"

# Release mode is a physical, behavior-level gate. It deliberately exits 2 as
# BLOCKED until a concrete profile resolves one target/probe/port and the exact
# plan digest is confirmed; it never turns an absent lab into PASS.
if [[ "${LABWIRED_ACCEPTANCE_REQUIRE_COMPLETE:-0}" == "1" ]]; then
  exec "$ROOT/tests/hardware-release-contract.sh"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
pass=0 skip=0 fail=0

# These tests execute mechanics for the checked-in prompts. They do not test
# model interpretation because no agent/model is invoked in this lane.
python3 - "$FIX/prompts.json" "$WORK/prompts.env" <<'PY'
import json, shlex, sys
prompts = json.load(open(sys.argv[1], encoding="utf-8"))
expected = {
  "greenfield-esp32c3": "Create PlatformIO Arduino firmware for ESP32-C3 DevKitM-1 that blinks the configured LED once per second and prints `alive` over serial.",
  "existing-stm32f103": "Add a one-second heartbeat without restructuring the project.",
  "compile-recovery-esp32c3": "Create PlatformIO Arduino firmware for ESP32-C3 DevKitM-1 that blinks the configured LED once per second and prints `alive` over serial, then recover from the deliberate compiler error.",
  "partial-led-wifi": "Create ESP32-C3 firmware that blinks the LED once per second and associates with Wi-Fi; report each behavior separately.",
  "unsupported-custom-board": "Build this custom board firmware and report only what the available evidence supports.",
}
assert prompts == expected
with open(sys.argv[2], "w", encoding="utf-8") as out:
    for key, value in prompts.items():
        out.write(f"PROMPT_{key.upper().replace('-', '_')}={shlex.quote(value)}\n")
PY
# shellcheck disable=SC1090
source "$WORK/prompts.env"
echo "INFO  mechanics-acceptance prompts=5 agent_invoked=false"

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

hash_file() {
  python3 - "$1" <<'PY'
import hashlib, sys
print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())
PY
}

scaffold_esp32c3() {
  python3 - "$1" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1])
(root / "src").mkdir(parents=True)
(root / "platformio.ini").write_text('''[env:esp32-c3-devkitm-1]
platform = espressif32
board = esp32-c3-devkitm-1
framework = arduino
build_flags =
\t-DARDUINO_USB_MODE=1
\t-DARDUINO_USB_CDC_ON_BOOT=1
''')
(root / "src/main.cpp").write_text('''#include <Arduino.h>

void setup() {
  Serial.begin(115200);
  pinMode(8, OUTPUT);
}

void loop() {
  digitalWrite(8, !digitalRead(8));
  Serial.println("alive");
  delay(1000);
}
''')
PY
}

run_c3_twin_uart() {
  local elf="$1" marker="$2" out="$3"
  [[ -n "$SIM" ]] || return 2
  mkdir -p "$out"
  python3 - "$out/test.yaml" "$elf" "$ROOT/share/catalog/systems/esp32c3.yaml" "$marker" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).write_text(f'''schema_version: "1.0"
inputs:
  firmware: "{sys.argv[2]}"
  system: "{sys.argv[3]}"
limits:
  max_steps: 10000000
assertions:
  - uart_contains: "{sys.argv[4]}"
''')
PY
  "$SIM" test --script "$out/test.yaml" --output-dir "$out/evidence" --no-uart-stdout \
    >"$out/run.log" 2>&1
}

SIM=""
if [[ -n "${HOME:-}" && -x "${HOME}/.labwired/tools/sim/labwired-sim" ]]; then
  SIM="${HOME}/.labwired/tools/sim/labwired-sim"
elif command -v labwired-sim >/dev/null 2>&1; then
  SIM="$(command -v labwired-sim)"
fi

hardware_contract=0
if "$ROOT/tests/hardware-release-contract.sh" >"$WORK/hardware-release.log" 2>&1; then
  hardware_contract=1
else
  printf '%s\n' 'hardware contract diagnostics (last 40 redacted lines):' >&2
  tail -n 40 "$WORK/hardware-release.log" \
    | sed -E 's/(api[_-]?key|token|password|secret)([=:][^[:space:]]*)?/\1=[REDACTED]/Ig' >&2
fi

# 1. Greenfield ESP32-C3: a real PlatformIO compile is mandatory.
if ! command -v pio >/dev/null 2>&1; then
  result SKIP greenfield-esp32c3 "PlatformIO unavailable; attempts=1; overall=blocked"
else
  : "$PROMPT_GREENFIELD_ESP32C3"
  scaffold_esp32c3 "$WORK/greenfield"
  if compile_pio "$WORK/greenfield" "$WORK/greenfield.log" \
    && test -f "$WORK/greenfield/.pio/build/esp32-c3-devkitm-1/firmware.elf"; then
    if run_c3_twin_uart "$WORK/greenfield/.pio/build/esp32-c3-devkitm-1/firmware.elf" \
         alive "$WORK/greenfield-twin" \
      && grep -q alive "$WORK/greenfield-twin/evidence/uart.log"; then
      result PASS greenfield-esp32c3 "scaffolded + compiled + serial observed; LED gap; attempts=1; overall=partially_verified"
    else
      if [[ "$hardware_contract" -eq 1 ]]; then
        result PASS greenfield-esp32c3 "scaffold+compile passed; exact twin unsupported; authenticated build/flash/serial/logic/Wi-Fi mechanics passed; attempts=1; overall=hardware_evidence_contract"
      else
        result FAIL greenfield-esp32c3 "scaffold+compile passed but behavior evidence contract failed; attempts=1; overall=failed"
      fi
    fi
  else
    result FAIL greenfield-esp32c3 "scaffold/compile failed; attempts=1; overall=failed"
  fi
fi

# 2. Existing STM32F103: edit in place, compile, and measure layout/config preservation.
if ! command -v pio >/dev/null 2>&1; then
  result SKIP existing-stm32f103 "PlatformIO unavailable; attempts=1; overall=blocked"
else
  : "$PROMPT_EXISTING_STM32F103"
  cp -R "$FIX/stm32f103" "$WORK/stm32"
  before_paths="$(cd "$WORK/stm32" && find . -type f ! -path './.pio/*' | sort)"
  before_config="$(hash_file "$WORK/stm32/platformio.ini")"
  before_source="$(hash_file "$WORK/stm32/src/main.cpp")"
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
  after_config="$(hash_file "$WORK/stm32/platformio.ini")"
  after_source="$(hash_file "$WORK/stm32/src/main.cpp")"
  if compile_pio "$WORK/stm32" "$WORK/stm32.log" \
    && [[ "$before_paths" == "$after_paths" ]] \
    && [[ "$before_config" == "$after_config" ]] \
    && [[ "$before_source" != "$after_source" ]]; then
    result PASS existing-stm32f103 "layout/config preserved; heartbeat runtime gap; attempts=1; overall=compiled_only"
  else
    result FAIL existing-stm32f103 "compile or measured layout preservation failed; attempts=1; overall=failed"
  fi
fi

# 3. Compile recovery: observe red, make one diagnostic-directed repair, observe green.
if ! command -v pio >/dev/null 2>&1; then
  result SKIP compile-recovery-esp32c3 "PlatformIO unavailable; attempts=1; overall=blocked"
else
  : "$PROMPT_COMPILE_RECOVERY_ESP32C3"
  scaffold_esp32c3 "$WORK/recovery"
  cp "$FIX/esp32c3/main-broken.cpp" "$WORK/recovery/src/main.cpp"
  if compile_pio "$WORK/recovery" "$WORK/recovery-1.log"; then
    result FAIL compile-recovery-esp32c3 "broken fixture unexpectedly compiled; attempts=1; overall=failed"
  elif ! grep -q "expected.*;.*before" "$WORK/recovery-1.log"; then
    result FAIL compile-recovery-esp32c3 "first failure lacked expected compiler diagnostic; attempts=1; overall=failed"
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
      result FAIL compile-recovery-esp32c3 "repair compile failed; attempts=2/3; overall=failed"
    fi
  fi
fi

# 4. LED + Wi-Fi: the hardware contract reads independent logic transitions
# and a nonce-correlated device/host exchange. UART is never relabeled as GPIO.
: "$PROMPT_PARTIAL_LED_WIFI"
if [[ "$hardware_contract" -eq 1 ]]; then
  result PASS partial-led-wifi "authenticated serial + logic transitions + nonce-correlated Wi-Fi mechanics; attempts=1; overall=hardware_evidence_contract"
else
  result FAIL partial-led-wifi "behavior evidence contract failed; attempts=1; overall=failed"
fi

# 5. Unsupported board: real host compile, catalog absence, and compiled-only ceiling.
if ! command -v cc >/dev/null 2>&1; then
  result SKIP unsupported-custom-board "host C compiler unavailable; attempts=1; overall=blocked; needs_physical_confirmation=true"
else
  : "$PROMPT_UNSUPPORTED_CUSTOM_BOARD"
  cp -R "$FIX/custom-board" "$WORK/custom"
  if make -C "$WORK/custom" >"$WORK/custom.log" 2>&1 \
    && test -x "$WORK/custom/firmware" \
    && ! grep -R -q 'acme_custom_mcu_v1' "$ROOT/share/catalog"; then
    printf '%s\n' '{"overall":"compiled_only","attempts":1,"needs_physical_confirmation":true}' >"$WORK/custom/report.json"
    python3 - "$WORK/custom/report.json" <<'PY'
import json, sys
report = json.load(open(sys.argv[1], encoding="utf-8"))
assert report == {"overall": "compiled_only", "attempts": 1, "needs_physical_confirmation": True}
PY
    result PASS unsupported-custom-board "host compile passed; no catalog/twin target; attempts=1; overall=compiled_only; needs_physical_confirmation=true"
  else
    result FAIL unsupported-custom-board "compile failed or custom board unexpectedly cataloged; attempts=1; overall=failed; needs_physical_confirmation=true"
  fi
fi

# Claim boundaries use actual generated compile/twin artifacts and negative claim gates.
if [[ -n "$SIM" && -f "$ROOT/fixtures/gate1-live/firmware/gate1-fixed.elf" ]]; then
  run_c3_twin_uart "$ROOT/fixtures/gate1-live/firmware/gate1-fixed.elf" \
    LABWIRED_OK "$WORK/claim-twin" || true
fi
if [[ ! -f "$WORK/greenfield/.pio/build/esp32-c3-devkitm-1/firmware.elf" \
   || ! -f "$WORK/claim-twin/evidence/result.json" ]]; then
  result SKIP claim-boundaries "real compile artifact unavailable; attempts=1; overall=blocked"
elif ! "$ROOT/bin/labwired" assert-status model_verified \
       "$WORK/greenfield/.pio/build/esp32-c3-devkitm-1/firmware.elf" >/dev/null 2>&1 \
  && ! "$ROOT/bin/labwired" assert-status hardware_observed \
       "$WORK/claim-twin/evidence/result.json" >/dev/null 2>&1; then
  result PASS claim-boundaries "compile cannot mint model_verified; twin cannot mint hardware_observed; attempts=1; overall=boundaries_enforced"
else
  result FAIL claim-boundaries "claim boundary rejection failed; attempts=1; overall=failed"
fi

printf '\nSUMMARY CHECKS_PASS=%d SKIP=%d FAIL=%d REQUIRED_COMPLETE=%s\n' \
  "$pass" "$skip" "$fail" "$([[ "$skip" -eq 0 && "$fail" -eq 0 ]] && echo true || echo false)"
if [[ "$fail" -ne 0 ]]; then
  echo "acceptance failed: one or more mechanics checks failed"
  exit 1
fi
if [[ "$skip" -ne 0 ]]; then
  echo "acceptance incomplete: one or more required scenarios were skipped"
  [[ "${LABWIRED_ACCEPTANCE_REQUIRE_COMPLETE:-0}" != "1" ]] || exit 1
fi
exit 0
