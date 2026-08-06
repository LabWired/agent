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

# Primary packs (required full content)
for s in golden-path bringup prove observe desk-hw; do
  need_skill "$s"
done
# Compat aliases (thin stubs)
for s in \
  verify-firmware diagnose-firmware inspect-evidence compose-observability \
  part-knowledge board-bringup scaffold-firmware report-evidence flash-firmware \
  firmware-repair-loop hw-promote
do
  need_skill "$s"
done

# Pack rules
if grep -qiE 'element|ready-made' "$ROOT/skills/observe/SKILL.md"; then
  echo "ok   observe elements rule"
else
  echo "FAIL observe missing elements product rule"
  fail=1
fi
if grep -q 'observe' "$ROOT/config/AGENTS.md" \
  && grep -qi 'Plots = elements\|elements\|ready-made' \
  "$ROOT/config/AGENTS.md"; then
  echo "ok   AGENTS plots=elements rule"
else
  echo "FAIL AGENTS.md missing observe / plots=elements"
  fail=1
fi
if grep -qi 'never invent' "$ROOT/skills/bringup/SKILL.md"; then
  echo "ok   bringup refuse-invent"
else
  echo "FAIL bringup missing never invent"
  fail=1
fi
if grep -q 'golden-path' "$ROOT/config/AGENTS.md" \
  && grep -qi 'labwired_verify\|model_verified\|prove' "$ROOT/skills/golden-path/SKILL.md"; then
  echo "ok   golden-path + AGENTS default loop"
else
  echo "FAIL golden-path missing from AGENTS or loop"
  fail=1
fi
if grep -qi 'do not force sim\|Do not force sim\|sim is not required\|debugger' \
  "$ROOT/config/AGENTS.md" \
  && grep -qi 'Do not force sim\|debugger\|no sim' \
  "$ROOT/skills/golden-path/SKILL.md"; then
  echo "ok   sim optional / debugger first-class"
else
  echo "FAIL missing sim-optional / debugger path rule"
  fail=1
fi
if grep -q 'E3 recipe' "$ROOT/skills/observe/SKILL.md"; then
  echo "ok   observe E3 LED vs UART recipe"
else
  echo "FAIL observe missing E3 recipe"
  fail=1
fi
if [[ -f "$ROOT/skills/README.md" ]] && grep -q 'Primary packs' "$ROOT/skills/README.md"; then
  echo "ok   skills/README.md pack map"
else
  echo "FAIL skills/README.md pack map"
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
# OpenCode skill allowlist: primary packs + key aliases
for cfg in "$ROOT/config/opencode.json" "$ROOT/config/opencode.hosted.json" \
  "$ROOT/config/opencode.deepinfra.json" "$ROOT/config/opencode.airgap.json"; do
  if grep -q 'golden-path' "$cfg" && grep -q 'bringup' "$cfg" \
    && grep -q 'prove' "$cfg" && grep -q 'observe' "$cfg" \
    && grep -q 'desk-hw' "$cfg" && grep -q 'verify-firmware' "$cfg"; then
    echo "ok   $(basename "$cfg") skill allowlist (packs+aliases)"
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

# Repair loop max 3 (lives in prove pack after skill reorganization)
if grep -qE '3|three' "$ROOT/skills/prove/SKILL.md"; then
  echo "ok   prove pack repair budget documented"
else
  echo "FAIL prove pack repair budget not documented"
  fail=1
fi

# Product is board-agnostic (desk-hw pack; not a single-MCU tool)
if grep -qi 'LABWIRED_HW_\|not a fixed product MCU\|board-agnostic\|any chip\|env/task' \
  "$ROOT/skills/desk-hw/SKILL.md"; then
  echo "ok   desk-hw board-agnostic"
else
  echo "FAIL desk-hw missing board-agnostic / env target wording"
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
