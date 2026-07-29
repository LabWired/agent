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
  verify-firmware diagnose-firmware inspect-evidence \
  board-bringup scaffold-firmware report-evidence flash-firmware \
  firmware-repair-loop hw-promote
do
  need_skill "$s"
done

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

# hw-promote board-agnostic (not C3 product)
if grep -qi 'board-agnostic\|BOARD-AGNOSTIC\|not a single-MCU' "$ROOT/skills/hw-promote/SKILL.md"; then
  echo "ok   hw-promote board-agnostic"
else
  # softer check
  if grep -qi 'ESP32-C3 beachhead' "$ROOT/skills/hw-promote/SKILL.md"; then
    echo "FAIL hw-promote still C3-centric beachhead"
    fail=1
  else
    echo "ok   hw-promote (no C3 beachhead title)"
  fi
fi

if [[ "$fail" -ne 0 ]]; then
  echo "skills-inventory FAILED"
  exit 1
fi
echo "ok   skills-inventory PASS"
