#!/usr/bin/env bash
# Skills inventory for ship: domain packs + Superpowers only.
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

for s in golden-path bringup prove observe desk-hw; do
  need_skill "$s"
done
for s in using-superpowers test-driven-development systematic-debugging \
  verification-before-completion writing-plans brainstorming; do
  need_skill "$s"
done

# Legacy must be gone
for s in verify-firmware part-knowledge board-bringup compose-observability \
  diagnose-firmware firmware-repair-loop report-evidence inspect-evidence \
  scaffold-firmware flash-firmware hw-promote; do
  if [[ -d "$ROOT/skills/$s" ]]; then
    echo "FAIL legacy skill still present: $s"
    fail=1
  else
    echo "ok   legacy dropped: $s"
  fi
done

if grep -qiE 'element|ready-made' "$ROOT/skills/observe/SKILL.md"; then
  echo "ok   observe elements rule"
else
  echo "FAIL observe missing elements rule"
  fail=1
fi
if grep -qi 'never invent' "$ROOT/skills/bringup/SKILL.md"; then
  echo "ok   bringup refuse-invent"
else
  echo "FAIL bringup missing never invent"
  fail=1
fi
if grep -q 'golden-path' "$ROOT/config/AGENTS.md" && grep -q 'prove' "$ROOT/config/AGENTS.md"; then
  echo "ok   AGENTS packs"
else
  echo "FAIL AGENTS packs"
  fail=1
fi
if grep -qi 'Do not force sim\|do not force sim' "$ROOT/skills/golden-path/SKILL.md"; then
  echo "ok   sim optional"
else
  echo "FAIL golden-path sim optional"
  fail=1
fi
if [[ -f "$ROOT/docs/KNOWLEDGE.md" ]]; then
  echo "ok   docs/KNOWLEDGE.md"
else
  echo "FAIL docs/KNOWLEDGE.md"
  fail=1
fi
if grep -qE '3|three' "$ROOT/skills/prove/SKILL.md"; then
  echo "ok   prove repair budget"
else
  echo "FAIL prove repair budget"
  fail=1
fi
if grep -qi 'LABWIRED_HW_\|not a fixed product MCU\|env/task' "$ROOT/skills/desk-hw/SKILL.md"; then
  echo "ok   desk-hw board-agnostic"
else
  echo "FAIL desk-hw board-agnostic"
  fail=1
fi

if grep -q 'model_verified' "$ROOT/config/AGENTS.md" \
  && grep -q 'hardware_observed' "$ROOT/config/AGENTS.md"; then
  echo "ok   AGENTS claim vocabulary"
else
  echo "FAIL AGENTS.md missing claim vocabulary"
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

for cfg in "$ROOT/config/opencode.json" "$ROOT/config/opencode.hosted.json" \
  "$ROOT/config/opencode.deepinfra.json" "$ROOT/config/opencode.airgap.json"; do
  if grep -q 'golden-path' "$cfg" && grep -q 'bringup' "$cfg" \
    && grep -q 'prove' "$cfg" && grep -q 'observe' "$cfg" \
    && grep -q 'desk-hw' "$cfg" && grep -q 'using-superpowers' "$cfg"; then
    echo "ok   $(basename "$cfg") allowlist"
  else
    echo "FAIL $(basename "$cfg") allowlist"
    fail=1
  fi
done

if bash "$ROOT/tests/skills-verify-all.sh"; then
  echo "ok   skills-verify-all"
else
  echo "FAIL skills-verify-all"
  fail=1
fi

if [[ -d "$ROOT/skills/firmware-verification" ]]; then
  echo "FAIL legacy firmware-verification skill present"
  fail=1
else
  echo "ok   no legacy firmware-verification skill"
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
if [[ -d "$ROOT/workspaces" ]]; then
  echo "FAIL workspaces/ should not ship"
  fail=1
else
  echo "ok   no product workspaces/ dump"
fi

if [[ "$fail" -ne 0 ]]; then
  echo "skills-inventory FAILED"
  exit 1
fi
echo "ok   skills-inventory PASS"
exit 0
