#!/usr/bin/env bash
# Verify domain packs + Superpowers only (no legacy skill dirs).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail=0
pass() { echo "ok   $*"; }
bad() { echo "FAIL $*"; fail=1; }

PRIMARY=(golden-path develop bringup prove observe desk-hw import-circuit)
SUPERPOWERS=(
  using-superpowers brainstorming test-driven-development systematic-debugging
  verification-before-completion writing-plans executing-plans writing-skills
  dispatching-parallel-agents subagent-driven-development requesting-code-review
  receiving-code-review finishing-a-development-branch using-git-worktrees
)
LEGACY=(
  board-bringup compose-observability diagnose-firmware firmware-repair-loop
  flash-firmware hw-promote inspect-evidence part-knowledge report-evidence
  scaffold-firmware verify-firmware
)

echo "==> skills-verify-all (packs + Superpowers; legacy forbidden)"

for s in "${PRIMARY[@]}"; do
  [[ -f "$ROOT/skills/$s/SKILL.md" ]] && pass "primary $s" || bad "missing primary $s"
  grep -q 'alias_of' "$ROOT/skills/$s/SKILL.md" && bad "primary $s is alias" || pass "primary $s full"
done

for s in "${SUPERPOWERS[@]}"; do
  [[ -f "$ROOT/skills/$s/SKILL.md" ]] && pass "superpowers $s" || bad "missing superpowers $s"
done

for s in "${LEGACY[@]}"; do
  if [[ -d "$ROOT/skills/$s" ]]; then
    bad "legacy skill dir still present: $s"
  else
    pass "legacy dropped: $s"
  fi
done

grep -qi 'labwired_verify' "$ROOT/skills/prove/SKILL.md" && pass "prove" || bad "prove"
grep -qi 'never invent' "$ROOT/skills/bringup/SKILL.md" && pass "bringup" || bad "bringup"
grep -qiE 'element|ready-made' "$ROOT/skills/observe/SKILL.md" && pass "observe" || bad "observe"
grep -qi 'hardware_observed' "$ROOT/skills/desk-hw/SKILL.md" && pass "desk-hw" || bad "desk-hw"
grep -qi 'labwired_part\|labwired_datasheet' "$ROOT/skills/using-superpowers/SKILL.md" \
  && pass "using-superpowers MCP" || bad "using-superpowers MCP"

[[ -f "$ROOT/docs/KNOWLEDGE.md" ]] && pass "docs/KNOWLEDGE.md" || bad "docs/KNOWLEDGE.md"
[[ -f "$ROOT/skills/README.md" ]] && ! grep -qi 'thin stubs\|Aliases' "$ROOT/skills/README.md" \
  && pass "README no alias promise" || pass "README present"

for s in "${PRIMARY[@]}"; do
  grep -q "$s" "$ROOT/config/AGENTS.md" && pass "AGENTS $s" || bad "AGENTS $s"
  grep -q "$s" "$ROOT/bin/labwired-agent" && pass "doctor $s" || bad "doctor $s"
done

for cfg in "$ROOT/config/opencode.json" "$ROOT/config/opencode.hosted.json" \
  "$ROOT/config/opencode.deepinfra.json" "$ROOT/config/opencode.airgap.json"; do
  base=$(basename "$cfg")
  for s in "${PRIMARY[@]}" using-superpowers test-driven-development; do
    grep -q "\"$s\"" "$cfg" && pass "allow $base $s" || bad "allow $base $s"
  done
  # legacy must not be required in allowlist (ok if absent)
  for s in verify-firmware part-knowledge; do
    if grep -q "\"$s\"" "$cfg"; then
      bad "allow $base still lists legacy $s"
    else
      pass "allow $base no legacy $s"
    fi
  done
done

n=$(find "$ROOT/skills" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
# 7 domain packs + customize-labwired-agent + 14 superpowers = 22
# golden-path is the entry router; develop is the firmware workflow it delegates
# to. Both ship — see config/AGENTS.md "Default loop".
if [[ "$n" -eq 22 ]]; then
  pass "skill dir count $n (6 packs + customize + 14 superpowers)"
else
  bad "skill dir count $n expected 22"
fi

if [[ "$fail" -ne 0 ]]; then
  echo "skills-verify-all FAILED"
  exit 1
fi
echo "ok   skills-verify-all PASS (legacy interfaces dropped)"
exit 0
