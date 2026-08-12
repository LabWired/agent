#!/usr/bin/env bash
# Ship gate: cold technical path (not only smoke-wave-a).
# login session (if any) → doctor → tools → twin verify green → compose → knowledge heroes
# Optional: OpenCode one-shot if OPENCODE available (does not fail ship if model flaky).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$ROOT/bin:${PATH}"
LABWIRED="${LABWIRED:-$ROOT/bin/labwired-agent}"
OUT="${LABWIRED_SMOKE_OUT:-$ROOT/fixtures/coverage/smoke/ship-gate}"
mkdir -p "$OUT"
fail=0
pass() { echo "ok   $*"; }
bad() { echo "FAIL $*"; fail=1; }

echo "==> ship-gate (start-here path)"

# 0a auth honesty (dead token cannot probe green)
if bash "$ROOT/tests/hosted-auth-probe.sh" >"$OUT/hosted-auth-probe.txt" 2>&1; then
  pass "hosted-auth-probe"
else
  bad "hosted-auth-probe"; tail -20 "$OUT/hosted-auth-probe.txt"
fi


# 1 doctor
if "$LABWIRED" doctor >"$OUT/doctor.txt" 2>&1; then
  if grep -qiE '(^|[^a-z])not ready' "$OUT/doctor.txt"; then
    bad "doctor not ready"; tail -8 "$OUT/doctor.txt"
  else
    pass "doctor exit 0"
  fi
else
  bad "doctor exit non-zero"; tail -8 "$OUT/doctor.txt"
fi

# 2 whoami / session (optional but recorded)
if "$LABWIRED" whoami >"$OUT/whoami.txt" 2>&1; then
  pass "whoami ran"
  if grep -qiE 'project:|not signed' "$OUT/whoami.txt"; then
    pass "whoami: $(head -3 "$OUT/whoami.txt" | tr '\n' ' ')"
  fi
else
  echo "warn whoami failed (continue with local twin)"
fi

# 3 offline claim gate
if "$LABWIRED" assert-status model_verified \
  "$ROOT/fixtures/gate1/artifacts/fixed.verify.json" >"$OUT/assert-fixed.txt" 2>&1; then
  pass "assert-status offline green"
else
  bad "assert-status offline green"
fi
if "$LABWIRED" assert-status model_verified \
  "$ROOT/fixtures/gate1/artifacts/broken.verify.json" >"$OUT/assert-broken.txt" 2>&1; then
  bad "assert-status accepted broken as green"
else
  pass "assert-status rejects broken"
fi

# 4 live twin prove
if "$ROOT/scripts/live-gate1.sh" >"$OUT/live-gate1.txt" 2>&1; then
  pass "live-gate1 twin red→green"
else
  bad "live-gate1"; tail -12 "$OUT/live-gate1.txt"
fi

# 5 compose CLI (agent-callable surface)
if "$LABWIRED" compose uart --file "$ROOT/fixtures/gate1-live/evidence/fixed/uart.log" \
  --out "$OUT/compose.json" >"$OUT/compose.txt" 2>&1; then
  pass "labwired compose uart"
else
  bad "labwired compose"; cat "$OUT/compose.txt"
fi

# 6 knowledge heroes
if python3 "$ROOT/scripts/knowledge-top-parts.py" --out "$OUT/knowledge-heroes.json" \
  >"$OUT/knowledge.txt" 2>&1; then
  pass "knowledge-top-parts $(tail -1 "$OUT/knowledge.txt")"
else
  # local-only fallback still must pass usefulness gate
  if python3 "$ROOT/scripts/knowledge-top-parts.py" --local-only \
    --out "$OUT/knowledge-heroes.json" >"$OUT/knowledge-local.txt" 2>&1; then
    pass "knowledge-top-parts local-only $(tail -1 "$OUT/knowledge-local.txt")"
  else
    bad "knowledge-top-parts"; cat "$OUT/knowledge.txt" "$OUT/knowledge-local.txt" 2>/dev/null | tail -20
  fi
fi

# 7 packs present
for s in golden-path bringup prove observe desk-hw; do
  [[ -f "$ROOT/skills/$s/SKILL.md" ]] && pass "pack $s" || bad "pack $s"
done

# 8 OpenCode present + golden-path pack (interactive chat is human; twin is automated prove)
if command -v opencode >/dev/null 2>&1; then
  pass "opencode on PATH"
else
  bad "opencode missing"
fi
if [[ -f "$ROOT/skills/golden-path/SKILL.md" ]] \
  && grep -qi 'bringup' "$ROOT/skills/golden-path/SKILL.md"; then
  pass "golden-path is default firmware entry"
else
  bad "golden-path pack"
fi
if grep -qi 'golden-path first\|load \`golden-path\` first\|START with skill golden-path' \
  "$ROOT/config/AGENTS.md" "$ROOT/config/opencode.hosted.json" 2>/dev/null; then
  pass "AGENTS/opencode default golden-path first"
else
  bad "missing golden-path-first default in AGENTS/opencode"
fi
echo "note: full NL chat prove is interactive; automated prove = live-gate1 + assert-status" \
  >"$OUT/opencode-note.txt"

# 9 skills inventory quick
if bash "$ROOT/tests/skills-verify-all.sh" >"$OUT/skills-verify.txt" 2>&1; then
  pass "skills-verify-all"
else
  bad "skills-verify-all"; tail -10 "$OUT/skills-verify.txt"
fi


# 10 import diagram (catalog-honest twin_buildable)
if bash "$ROOT/scripts/import-diagram-smoke.sh" >"$OUT/import-smoke.txt" 2>&1; then
  pass "import-diagram twin_buildable"
else
  bad "import-diagram"; tail -15 "$OUT/import-smoke.txt"
fi

# 10b multi-source import (live MCP when signed in — product depth Task 6)
if [[ -f "$HOME/.labwired/session/cloud.json" ]]; then
  if bash "$ROOT/scripts/import-multi-smoke.sh" >"$OUT/import-multi-smoke.txt" 2>&1; then
    pass "import-multi (bom/text/kicad + diagram)"
  else
    bad "import-multi"; tail -20 "$OUT/import-multi-smoke.txt"
  fi
else
  bad "import-multi skipped — not signed in"
fi

# 11 desk-hw polish
if bash "$ROOT/scripts/desk-hw-smoke.sh" >"$OUT/desk-hw-smoke.txt" 2>&1; then
  pass "desk-hw polish"
else
  bad "desk-hw polish"; tail -20 "$OUT/desk-hw-smoke.txt"
fi

# 12 hosted knowledge (required when session file exists; skip only if unsigned)
if [[ -f "$HOME/.labwired/session/cloud.json" ]]; then
  if bash "$ROOT/scripts/knowledge-mcp-smoke.sh" >"$OUT/knowledge-mcp.txt" 2>&1; then
    pass "knowledge MCP list+part+datasheet+import"
  else
    bad "knowledge MCP"; tail -30 "$OUT/knowledge-mcp.txt"
  fi
else
  bad "knowledge MCP skipped — not signed in (golden path requires login)"
fi

if [[ "$fail" -ne 0 ]]; then
  echo "ship-gate FAILED"
  exit 1
fi
echo "ok   ship-gate PASS (doctor + assert + live twin + compose + knowledge + packs)"
exit 0
