#!/usr/bin/env bash
# Verify domain packs + Superpowers prepack + aliases + allowlists.
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
# Core Superpowers set we ship
SUPERPOWERS=(
  using-superpowers
  brainstorming
  test-driven-development
  systematic-debugging
  verification-before-completion
  writing-plans
  executing-plans
  writing-skills
  dispatching-parallel-agents
  subagent-driven-development
  requesting-code-review
  receiving-code-review
  finishing-a-development-branch
  using-git-worktrees
)

echo "==> skills-verify-all (packs + superpowers + aliases)"

for s in "${PRIMARY[@]}"; do
  [[ -f "$ROOT/skills/$s/SKILL.md" ]] && pass "primary $s" || bad "missing primary $s"
  if grep -q 'alias_of' "$ROOT/skills/$s/SKILL.md"; then
    bad "primary $s is alias"
  else
    pass "primary $s full pack"
  fi
done

for s in "${ALIASES[@]}"; do
  [[ -f "$ROOT/skills/$s/SKILL.md" ]] && pass "alias $s" || bad "missing alias $s"
  grep -qiE 'Alias|alias_of|folded into|use skill pack' "$ROOT/skills/$s/SKILL.md" \
    && pass "alias $s redirects" || bad "alias $s no redirect"
done

for s in "${SUPERPOWERS[@]}"; do
  if [[ -f "$ROOT/skills/$s/SKILL.md" ]]; then
    pass "superpowers $s"
  else
    bad "missing superpowers skill $s"
  fi
done

# using-superpowers must mention LabWired priority + datasheet/MCP
if grep -qi 'labwired_verify\|model_verified' "$ROOT/skills/using-superpowers/SKILL.md" \
  && grep -qi 'labwired_datasheet\|labwired_part' "$ROOT/skills/using-superpowers/SKILL.md"; then
  pass "using-superpowers LabWired+MCP priority"
else
  bad "using-superpowers missing LabWired/MCP priority"
fi

# Domain claim rules
grep -qi 'labwired_verify' "$ROOT/skills/prove/SKILL.md" && pass "prove verify" || bad "prove"
grep -qi 'never invent' "$ROOT/skills/bringup/SKILL.md" && pass "bringup invent" || bad "bringup"
grep -qiE 'element|ready-made' "$ROOT/skills/observe/SKILL.md" && pass "observe" || bad "observe"
grep -qi 'hardware_observed' "$ROOT/skills/desk-hw/SKILL.md" && pass "desk-hw" || bad "desk-hw"

[[ -f "$ROOT/skills/README.md" ]] && grep -qi 'Superpowers' "$ROOT/skills/README.md" \
  && pass "README superpowers section" || bad "README superpowers"

for s in "${PRIMARY[@]}"; do
  grep -q "$s" "$ROOT/config/AGENTS.md" && pass "AGENTS $s" || bad "AGENTS $s"
done
grep -qi 'Superpowers\|superpowers' "$ROOT/config/AGENTS.md" && pass "AGENTS superpowers" || bad "AGENTS superpowers"
grep -qi 'labwired_datasheet' "$ROOT/config/AGENTS.md" && pass "AGENTS datasheet tool" || bad "AGENTS datasheet"

for s in "${PRIMARY[@]}"; do
  grep -q "$s" "$ROOT/bin/labwired" && pass "doctor $s" || bad "doctor $s"
done

for cfg in "$ROOT/config/opencode.json" "$ROOT/config/opencode.hosted.json" \
  "$ROOT/config/opencode.deepinfra.json" "$ROOT/config/opencode.airgap.json"; do
  base=$(basename "$cfg")
  for s in golden-path bringup prove observe desk-hw using-superpowers \
    test-driven-development verification-before-completion systematic-debugging; do
    grep -q "\"$s\"" "$cfg" && pass "allow $base $s" || bad "allow $base missing $s"
  done
done

# Count: primary + aliases + superpowers should be present
n=$(find "$ROOT/skills" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
if [[ "$n" -ge 25 ]]; then
  pass "skill dir count $n (>=25 packs+aliases+superpowers)"
else
  bad "skill dir count $n too low"
fi

if [[ "$fail" -ne 0 ]]; then
  echo "skills-verify-all FAILED"
  exit 1
fi
echo "ok   skills-verify-all PASS (domain packs + Superpowers prepacked)"
exit 0
