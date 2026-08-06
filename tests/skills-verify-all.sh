#!/usr/bin/env bash
# Verify skill packs (5 primary) + alias stubs (compat).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail=0
pass() { echo "ok   $*"; }
bad() { echo "FAIL $*"; fail=1; }

PRIMARY=(golden-path bringup prove observe desk-hw)
ALIASES=(
  board-bringup compose-observability diagnose-firmware firmware-repair-loop
  flash-firmware hw-promote inspect-evidence part-knowledge report-evidence
  scaffold-firmware verify-firmware
)

echo "==> skills-verify-all (${#PRIMARY[@]} packs + ${#ALIASES[@]} aliases)"

for s in "${PRIMARY[@]}"; do
  if [[ -f "$ROOT/skills/$s/SKILL.md" ]]; then
    pass "primary disk $s"
  else
    bad "missing primary skills/$s/SKILL.md"
  fi
  name="$(awk 'BEGIN{in_fm=0} /^---$/{in_fm++; next} in_fm==1 && /^name:/{sub(/^name:[[:space:]]*/,""); print; exit}' "$ROOT/skills/$s/SKILL.md")"
  if [[ "$name" == "$s" ]]; then pass "primary name $s"; else bad "name $name != $s"; fi
  # Primary packs must not be thin aliases
  if grep -qi 'Alias →' "$ROOT/skills/$s/SKILL.md" || grep -q 'alias_of' "$ROOT/skills/$s/SKILL.md"; then
    bad "primary $s looks like an alias stub"
  else
    pass "primary $s is full pack"
  fi
  lines=$(wc -l <"$ROOT/skills/$s/SKILL.md")
  if [[ "$lines" -lt 40 ]]; then
    bad "primary $s too thin ($lines lines)"
  else
    pass "primary $s depth $lines lines"
  fi
done

for s in "${ALIASES[@]}"; do
  if [[ -f "$ROOT/skills/$s/SKILL.md" ]]; then
    pass "alias disk $s"
  else
    bad "missing alias skills/$s/SKILL.md"
  fi
  if grep -qiE 'Alias|alias_of|folded into|use skill pack' "$ROOT/skills/$s/SKILL.md"; then
    pass "alias $s redirects"
  else
    bad "alias $s missing redirect language"
  fi
done

# Pack claim rules
grep -qi 'labwired_verify' "$ROOT/skills/prove/SKILL.md" && grep -qi 'model_verified' "$ROOT/skills/prove/SKILL.md" \
  && pass "prove claim gate" || bad "prove claim gate"
grep -qE '3|three' "$ROOT/skills/prove/SKILL.md" && pass "prove repair budget" || bad "prove repair budget"
grep -qi 'never invent' "$ROOT/skills/bringup/SKILL.md" && pass "bringup never invent" || bad "bringup never invent"
grep -qiE 'element|ready-made' "$ROOT/skills/observe/SKILL.md" && pass "observe elements" || bad "observe elements"
grep -qi 'hardware_observed' "$ROOT/skills/desk-hw/SKILL.md" && grep -qi 'never upgrade\|Never upgrade' "$ROOT/skills/desk-hw/SKILL.md" \
  && pass "desk-hw dual claim" || bad "desk-hw dual claim"
grep -qi 'Do not force sim\|do not force sim' "$ROOT/skills/golden-path/SKILL.md" \
  && pass "golden-path sim optional" || bad "golden-path sim optional"

# README map
[[ -f "$ROOT/skills/README.md" ]] && pass "skills/README.md" || bad "skills/README.md"

# AGENTS packs
for s in "${PRIMARY[@]}"; do
  grep -q "$s" "$ROOT/config/AGENTS.md" && pass "AGENTS $s" || bad "AGENTS missing $s"
done

# Doctor lists primary packs
for s in "${PRIMARY[@]}"; do
  grep -q "$s" "$ROOT/bin/labwired" && pass "doctor lists $s" || bad "doctor missing $s"
done

# All configs allow primary + key aliases
for cfg in "$ROOT/config/opencode.json" "$ROOT/config/opencode.hosted.json" \
  "$ROOT/config/opencode.deepinfra.json" "$ROOT/config/opencode.airgap.json"; do
  base=$(basename "$cfg")
  for s in "${PRIMARY[@]}" verify-firmware part-knowledge compose-observability hw-promote; do
    grep -q "\"$s\"" "$cfg" && pass "allow $base $s" || bad "allow $base missing $s"
  done
done

if [[ "$fail" -ne 0 ]]; then
  echo "skills-verify-all FAILED"
  exit 1
fi
echo "ok   skills-verify-all PASS (5 packs + ${#ALIASES[@]} aliases)"
exit 0
