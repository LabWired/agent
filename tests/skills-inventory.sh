#!/usr/bin/env bash
# Skills + protocol inventory for sellable agent pack.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail=0

need_skill() {
  local s="$1"
  if [[ -f "$ROOT/skills/$s/SKILL.md" ]]; then
    echo "ok   skill $s"
  else
    echo "FAIL skill missing: $s"
    fail=1
  fi
}

for s in \
  verify-firmware diagnose-firmware inspect-evidence compose-observability \
  part-knowledge golden-path \
  board-bringup scaffold-firmware report-evidence flash-firmware \
  firmware-repair-loop hw-promote
do
  need_skill "$s"
done

# Plots = elements (not ready-made Open Plot product)
if grep -qi 'elements\|compose.*plot\|not.*ready-made\|ready-made plot' \
  "$ROOT/skills/compose-observability/SKILL.md"; then
  echo "ok   compose-observability elements rule"
else
  echo "FAIL compose-observability missing elements product rule"
  fail=1
fi
if grep -q 'compose-observability' "$ROOT/config/AGENTS.md" \
  && grep -qi 'Plots = elements\|observability \*\*elements\*\*\|ready-made' \
  "$ROOT/config/AGENTS.md"; then
  echo "ok   AGENTS plots=elements rule"
else
  echo "FAIL AGENTS.md missing compose-observability / plots=elements"
  fail=1
fi

# Wave A/B: golden path + part knowledge
if grep -qi 'never invent\|tools first\|part-knowledge' \
  "$ROOT/skills/part-knowledge/SKILL.md"; then
  echo "ok   part-knowledge refuse-invent"
else
  echo "FAIL part-knowledge missing refuse-invent rule"
  fail=1
fi
if grep -q 'golden-path' "$ROOT/config/AGENTS.md" \
  && grep -qi 'labwired_verify\|model_verified' "$ROOT/skills/golden-path/SKILL.md"; then
  echo "ok   golden-path + AGENTS default loop"
else
  echo "FAIL golden-path missing from AGENTS or verify rule"
  fail=1
fi
if grep -qi 'do not force sim\|Do not force sim\|sim is not required\|debugger' \
  "$ROOT/config/AGENTS.md" \
  && grep -qi 'Do not force sim\|debugger path\|no sim' \
  "$ROOT/skills/golden-path/SKILL.md"; then
  echo "ok   sim optional / debugger first-class"
else
  echo "FAIL missing sim-optional / debugger path rule"
  fail=1
fi
if grep -q 'E3 recipe' "$ROOT/skills/compose-observability/SKILL.md"; then
  echo "ok   compose E3 LED vs UART recipe"
else
  echo "FAIL compose-observability missing E3 recipe"
  fail=1
fi
if [[ -f "$ROOT/docs/GOLDEN_PATH.md" ]]; then
  echo "ok   docs/GOLDEN_PATH.md"
else
  echo "FAIL missing docs/GOLDEN_PATH.md"
  fail=1
fi
if [[ -f "$ROOT/share/observability/element-catalog.json" ]] \
  && [[ -f "$ROOT/scripts/compose-elements.py" ]]; then
  echo "ok   element catalog + compose-elements.py"
else
  echo "FAIL missing element catalog or compose-elements.py"
  fail=1
fi
if [[ -f "$ROOT/share/catalog/coverage-top20.json" ]]; then
  echo "ok   coverage-top20 ratchet list"
else
  echo "FAIL missing share/catalog/coverage-top20.json"
  fail=1
fi
# compose smoke
if printf 'LED ON\nLED OFF\n' | python3 "$ROOT/scripts/compose-elements.py" --uart - >/tmp/lw-compose-test.json 2>/dev/null \
  && grep -q 'led_from_uart' /tmp/lw-compose-test.json; then
  echo "ok   compose-elements extracts LED series"
else
  echo "FAIL compose-elements smoke"
  fail=1
fi
if [[ -x "$ROOT/scripts/smoke-wave-a.sh" ]] || [[ -f "$ROOT/scripts/smoke-wave-a.sh" ]]; then
  echo "ok   smoke-wave-a.sh present"
else
  echo "FAIL smoke-wave-a.sh missing"
  fail=1
fi
if [[ -f "$ROOT/scripts/coverage-ratchet.sh" ]] \
  && [[ -f "$ROOT/scripts/report-evidence.py" ]] \
  && [[ -f "$ROOT/scripts/compose-from-capture.py" ]]; then
  echo "ok   coverage + report-evidence + compose-from-capture scripts"
else
  echo "FAIL missing B/C helper scripts"
  fail=1
fi
if [[ -f "$ROOT/docs/REVERSE_STEP_DEMO.md" ]]; then
  echo "ok   REVERSE_STEP_DEMO.md"
else
  echo "FAIL missing REVERSE_STEP_DEMO.md"
  fail=1
fi
if [[ -f "$ROOT/share/catalog/coverage-latest.json" ]]; then
  echo "ok   coverage-latest published"
else
  echo "FAIL share/catalog/coverage-latest.json missing — run scripts/coverage-ratchet.sh"
  fail=1
fi
# OpenCode skill allowlist includes new skills
for cfg in "$ROOT/config/opencode.json" "$ROOT/config/opencode.hosted.json" \
  "$ROOT/config/opencode.deepinfra.json" "$ROOT/config/opencode.airgap.json"; do
  if grep -q 'golden-path' "$cfg" && grep -q 'part-knowledge' "$cfg" \
    && grep -q 'compose-observability' "$cfg" \
    && grep -q 'firmware-repair-loop' "$cfg" \
    && grep -q 'hw-promote' "$cfg"; then
    echo "ok   $(basename "$cfg") skill allowlist"
  else
    echo "FAIL $cfg incomplete skill allowlist"
    fail=1
  fi
done

# Exhaustive per-skill structural + claim verification
if bash "$ROOT/tests/skills-verify-all.sh"; then
  echo "ok   skills-verify-all"
else
  echo "FAIL skills-verify-all"
  fail=1
fi

# Must not ship duplicate/ confusable skill name
if [[ -d "$ROOT/skills/firmware-verification" ]]; then
  echo "FAIL legacy firmware-verification skill present"
  fail=1
else
  echo "ok   no legacy firmware-verification skill"
fi

# AGENTS claim rules
if grep -q 'model_verified' "$ROOT/config/AGENTS.md" \
  && grep -q 'hardware_observed' "$ROOT/config/AGENTS.md"; then
  echo "ok   AGENTS claim vocabulary"
else
  echo "FAIL AGENTS.md missing claim vocabulary"
  fail=1
fi

# Repair loop max 3
if grep -qE '3|three' "$ROOT/skills/firmware-repair-loop/SKILL.md"; then
  echo "ok   repair-loop budget documented"
else
  echo "FAIL repair-loop budget not documented"
  fail=1
fi

# Product is board-agnostic (not a single-MCU tool)
if grep -qi 'board-agnostic\|not a single-MCU\|not the product focus' "$ROOT/skills/hw-promote/SKILL.md"; then
  echo "ok   hw-promote board-agnostic"
else
  echo "FAIL hw-promote missing board-agnostic wording"
  fail=1
fi
if grep -qi 'ESP32-C3 beachhead\|C3 baseline marker' "$ROOT/config/AGENTS.md"; then
  echo "FAIL AGENTS.md still C3-product centric"
  fail=1
else
  echo "ok   AGENTS.md generic HW env"
fi
if grep -q 'LABWIRED_HW_PORT' "$ROOT/config/AGENTS.md" \
  && grep -q 'LABWIRED_HW_MARKER' "$ROOT/config/AGENTS.md"; then
  echo "ok   AGENTS generic LABWIRED_HW_* env"
else
  echo "FAIL AGENTS.md missing LABWIRED_HW_* env"
  fail=1
fi
if [[ -x "$ROOT/scripts/dev-cycle.sh" ]]; then
  echo "ok   generic scripts/dev-cycle.sh"
else
  echo "FAIL missing scripts/dev-cycle.sh"
  fail=1
fi
if [[ -x "$ROOT/scripts/live-gate1.sh" ]] \
  && [[ -f "$ROOT/share/catalog/boards.json" ]] \
  && [[ -f "$ROOT/share/catalog/systems/esp32c3.yaml" ]]; then
  echo "ok   catalog + live-gate1"
else
  echo "FAIL catalog or live-gate1 missing"
  fail=1
fi
if [[ -f "$ROOT/fixtures/gate1-live/firmware/gate1-fixed.elf" ]] \
  && [[ -f "$ROOT/fixtures/gate1-live/firmware/gate1-broken.elf" ]]; then
  echo "ok   gate1-live prebuilt ELFs"
else
  echo "FAIL gate1-live ELFs missing"
  fail=1
fi
# examples are canaries, not product roots
if [[ -d "$ROOT/workspaces" ]]; then
  echo "FAIL workspaces/ should not ship (use examples/ profiles)"
  fail=1
else
  echo "ok   no product workspaces/ dump"
fi

if [[ "$fail" -ne 0 ]]; then
  echo "skills-inventory FAILED"
  exit 1
fi
echo "ok   skills-inventory PASS"
