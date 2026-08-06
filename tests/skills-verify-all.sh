#!/usr/bin/env bash
# Verify EVERY ship skill: disk, frontmatter, claims, allowlists, AGENTS, doctor list.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail=0
pass() { echo "ok   $*"; }
bad() { echo "FAIL $*"; fail=1; }

# Canonical skill set (sorted) — must match harness inventory
REQUIRED=(
  board-bringup
  compose-observability
  diagnose-firmware
  firmware-repair-loop
  flash-firmware
  golden-path
  hw-promote
  inspect-evidence
  part-knowledge
  report-evidence
  scaffold-firmware
  verify-firmware
)

echo "==> skills-verify-all ($((${#REQUIRED[@]})) skills)"

# --- 1 disk presence ---
for s in "${REQUIRED[@]}"; do
  if [[ -f "$ROOT/skills/$s/SKILL.md" ]]; then
    pass "disk $s/SKILL.md"
  else
    bad "missing skills/$s/SKILL.md"
  fi
done

# No extras that aren't in required (except we allow only required)
got="$(find "$ROOT/skills" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort | tr '\n' ' ')"
want="$(printf '%s\n' "${REQUIRED[@]}" | sort | tr '\n' ' ')"
if [[ "$(printf '%s\n' "${REQUIRED[@]}" | sort)" == "$(find "$ROOT/skills" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort)" ]]; then
  pass "skill dirs exactly match required set"
else
  bad "skill dir mismatch want=[$want] got=[$got]"
fi

# --- 2 frontmatter name == directory ---
for s in "${REQUIRED[@]}"; do
  f="$ROOT/skills/$s/SKILL.md"
  # extract name: line after --- block
  name="$(awk 'BEGIN{in_fm=0} /^---$/{in_fm++; next} in_fm==1 && /^name:/{sub(/^name:[[:space:]]*/,""); print; exit}' "$f")"
  if [[ "$name" == "$s" ]]; then
    pass "frontmatter name=$s"
  else
    bad "frontmatter name='$name' != dir $s"
  fi
  if grep -qE '^description:' "$f"; then
    pass "frontmatter description $s"
  else
    bad "no description $s"
  fi
done

# --- 3 claim rules by skill role ---
# verify-firmware: only path to model_verified
if grep -qi 'labwired_verify' "$ROOT/skills/verify-firmware/SKILL.md" \
  && grep -qi 'model_verified' "$ROOT/skills/verify-firmware/SKILL.md" \
  && grep -qiE 'never|only when|only from' "$ROOT/skills/verify-firmware/SKILL.md"; then
  pass "verify-firmware claim gate language"
else
  bad "verify-firmware missing claim gate language"
fi

# repair loop: max 3
if grep -qE '3|three' "$ROOT/skills/firmware-repair-loop/SKILL.md"; then
  pass "firmware-repair-loop budget 3"
else
  bad "firmware-repair-loop missing max 3"
fi

# hw-promote: never upgrade to model_verified
if grep -qi 'never upgrade' "$ROOT/skills/hw-promote/SKILL.md" \
  && grep -qi 'hardware_observed' "$ROOT/skills/hw-promote/SKILL.md"; then
  pass "hw-promote dual-claim / no upgrade"
else
  bad "hw-promote missing dual-claim rules"
fi

# flash-firmware: flash alone not proof
if grep -qiE 'not.*hardware|flash alone|never claim hardware' "$ROOT/skills/flash-firmware/SKILL.md"; then
  pass "flash-firmware no false HW claim"
else
  bad "flash-firmware weak HW language"
fi

# part-knowledge: never invent
if grep -qi 'never invent' "$ROOT/skills/part-knowledge/SKILL.md"; then
  pass "part-knowledge never invent"
else
  bad "part-knowledge missing never invent"
fi

# compose-observability: elements not ready plots
if grep -qiE 'element|not.*ready-made|ready-made' "$ROOT/skills/compose-observability/SKILL.md"; then
  pass "compose-observability elements rule"
else
  bad "compose-observability missing elements rule"
fi

# golden-path: default loop + sim not forced
if grep -qi 'do not force sim\|Do not force sim' "$ROOT/skills/golden-path/SKILL.md" \
  && grep -qi 'labwired_verify\|model_verified' "$ROOT/skills/golden-path/SKILL.md"; then
  pass "golden-path sim optional + verify"
else
  bad "golden-path missing sim optional or verify"
fi

# report-evidence: dual claim
if grep -qi 'hardware_observed' "$ROOT/skills/report-evidence/SKILL.md" \
  && grep -qi 'model_verified' "$ROOT/skills/report-evidence/SKILL.md" \
  && grep -qi 'never upgrade\|dual' "$ROOT/skills/report-evidence/SKILL.md"; then
  pass "report-evidence dual claim"
else
  bad "report-evidence dual claim incomplete"
fi

# scaffold: not proven until verify
if grep -qi 'model_verified\|labwired_verify' "$ROOT/skills/scaffold-firmware/SKILL.md"; then
  pass "scaffold-firmware verify gate"
else
  bad "scaffold-firmware missing verify gate"
fi

# board-bringup: never invent pins / tools first
if grep -qiE 'never invent|part-knowledge|labwired_describe|labwired_list' "$ROOT/skills/board-bringup/SKILL.md"; then
  pass "board-bringup tools-first"
else
  bad "board-bringup weak pin authority"
fi

# diagnose: fail first then repair
if grep -qi 'failing' "$ROOT/skills/diagnose-firmware/SKILL.md" \
  && grep -qi 'firmware-repair-loop' "$ROOT/skills/diagnose-firmware/SKILL.md"; then
  pass "diagnose-firmware fail-first + repair handoff"
else
  bad "diagnose-firmware handoff incomplete"
fi

# inspect-evidence: read-only never invent
if grep -qiE 'read-only|never invent' "$ROOT/skills/inspect-evidence/SKILL.md"; then
  pass "inspect-evidence read-only"
else
  bad "inspect-evidence missing read-only"
fi

# --- 4 every skill must forbid inventing model_verified without tool (where applicable) ---
# Skills that could mint green incorrectly
for s in scaffold-firmware board-bringup flash-firmware compose-observability part-knowledge golden-path; do
  if grep -qiE 'model.verified|model_verified|labwired_verify' "$ROOT/skills/$s/SKILL.md"; then
    pass "anti-false-green language present: $s"
  else
    bad "skill $s lacks model_verified/verify mention (risk of soft pass)"
  fi
done

# --- 5 OpenCode allowlists (all configs that ship skill permissions) ---
ALL_CFGS=(
  "$ROOT/config/opencode.json"
  "$ROOT/config/opencode.hosted.json"
  "$ROOT/config/opencode.deepinfra.json"
  "$ROOT/config/opencode.airgap.json"
)
for cfg in "${ALL_CFGS[@]}"; do
  [[ -f "$cfg" ]] || { bad "missing $cfg"; continue; }
  base="$(basename "$cfg")"
  for s in "${REQUIRED[@]}"; do
    if grep -q "\"$s\"" "$cfg"; then
      pass "allowlist $base has $s"
    else
      bad "allowlist $base MISSING $s"
    fi
  done
done

# --- 6 AGENTS.md lists every skill ---
for s in "${REQUIRED[@]}"; do
  if grep -q "\`$s\`" "$ROOT/config/AGENTS.md" || grep -q "$s" "$ROOT/config/AGENTS.md"; then
    pass "AGENTS.md mentions $s"
  else
    bad "AGENTS.md missing $s"
  fi
done

# --- 7 doctor skill list includes all 12 ---
for s in "${REQUIRED[@]}"; do
  if grep -q "$s" "$ROOT/bin/labwired"; then
    pass "doctor/bin lists $s"
  else
    bad "bin/labwired doctor list missing $s"
  fi
done

# --- 8 install prepare copies skills (structural) ---
if grep -q 'skills' "$ROOT/bin/labwired" && grep -q 'cp -R' "$ROOT/bin/labwired"; then
  pass "prepare copies skills into OpenCode dir"
else
  bad "prepare may not copy skills"
fi

if [[ "$fail" -ne 0 ]]; then
  echo "skills-verify-all FAILED ($fail checks)"
  exit 1
fi
echo "ok   skills-verify-all PASS ($((${#REQUIRED[@]})) skills)"
exit 0
