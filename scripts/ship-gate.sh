#!/usr/bin/env bash
# Ship gate: cold technical path (not only smoke-wave-a).
# login session (if any) → doctor → tools → twin verify green → compose → knowledge heroes
# Optional: OpenCode one-shot if OPENCODE available (does not fail ship if model flaky).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$ROOT/bin:${PATH}"
LABWIRED="${LABWIRED:-$ROOT/bin/labwired-agent}"
OUT="${LABWIRED_SMOKE_OUT:-$ROOT/fixtures/coverage/smoke/ship-gate}"
LABWIRED_SHIP_STAGE_TIMEOUT="${LABWIRED_SHIP_STAGE_TIMEOUT:-90}"
mkdir -p "$OUT"
rm -f "$OUT/result.txt"
fail=0
pass() { echo "ok   $*"; }
bad() { echo "FAIL $*"; fail=1; }

show_diagnostics() {
  local lines="$1" file
  local existing=()
  shift
  for file in "$@"; do
    if [[ -f "$file" ]]; then
      existing[${#existing[@]}]="$file"
    else
      echo "warn diagnostic missing: $file"
    fi
  done
  [[ "${#existing[@]}" -gt 0 ]] || return 0
  if [[ "$lines" == "all" ]]; then
    for file in "${existing[@]}"; do
      cat "$file" || true
    done
  else
    {
      for file in "${existing[@]}"; do
        cat "$file" || true
      done
    } | tail -"$lines" || true
  fi
}

run_stage() {
  local name="$1" log="$2" timeout_override timeout status
  shift 2
  timeout_override="LABWIRED_SHIP_STAGE_TIMEOUT_${name//-/_}"
  timeout="${!timeout_override:-$LABWIRED_SHIP_STAGE_TIMEOUT}"
  set +e
  python3 "$ROOT/scripts/run-bounded.py" --timeout "$timeout" -- "$@" >"$log" 2>&1
  status=$?
  set -e
  if [[ "$status" -eq 124 ]]; then
    printf "ship-gate: stage '%s' timeout after %ss\n" "$name" "$timeout" >>"$log" || true
    bad "$name timeout after ${timeout}s"
  fi
  return "$status"
}

finalize() {
  if [[ "$fail" -ne 0 ]]; then
    printf 'FAIL\n' >"$OUT/result.txt"
    echo "ship-gate FAILED"
    return 1
  fi
  printf 'PASS\n' >"$OUT/result.txt"
  echo "ok   ship-gate PASS (doctor + assert + live twin + compose + knowledge + packs)"
  return 0
}

echo "==> ship-gate (start-here path)"

# Contract-only fixture mode exercises timeout and continuation without live dependencies.
if [[ -n "${LABWIRED_SHIP_FIXTURE_DIR:-}" ]]; then
  fixture_count=0
  for fixture in "$LABWIRED_SHIP_FIXTURE_DIR"/*.sh; do
    [[ -f "$fixture" ]] || continue
    fixture_count=$((fixture_count + 1))
    stage="${fixture##*/}"
    stage="${stage%.sh}"
    if run_stage "$stage" "$OUT/$stage.txt" bash "$fixture"; then
      artifact_contract="$fixture.artifact"
      if [[ -f "$artifact_contract" ]]; then
        expected_artifact=""
        IFS= read -r expected_artifact <"$artifact_contract" || true
        if [[ -z "$expected_artifact" || ! -f "$expected_artifact" ]]; then
          bad "$stage fixture missing artifact: ${expected_artifact:-not specified}"
          show_diagnostics all "${expected_artifact:-$artifact_contract}"
        else
          pass "$stage fixture"
        fi
      else
        pass "$stage fixture"
      fi
    else
      status=$?
      if [[ "$status" -ne 124 ]]; then
        bad "$stage fixture exit non-zero"
      fi
    fi
  done
  if [[ "$fixture_count" -eq 0 ]]; then
    bad "fixture mode has no .sh stages"
  fi
  finalize
  exit $?
fi

# 0a auth honesty (dead token cannot probe green)
if run_stage "hosted-auth-probe" "$OUT/hosted-auth-probe.txt" \
  bash "$ROOT/tests/hosted-auth-probe.sh"; then
  pass "hosted-auth-probe"
else
  status=$?
  if [[ "$status" -ne 124 ]]; then
    bad "hosted-auth-probe"
  fi
  show_diagnostics 20 "$OUT/hosted-auth-probe.txt"
fi

# 1 doctor
if run_stage "doctor" "$OUT/doctor.txt" "$LABWIRED" doctor; then
  if grep -qiE '(^|[^a-z])not ready' "$OUT/doctor.txt"; then
    bad "doctor not ready"; show_diagnostics 8 "$OUT/doctor.txt"
  else
    pass "doctor exit 0"
  fi
else
  status=$?
  if [[ "$status" -ne 124 ]]; then
    bad "doctor exit non-zero"
  fi
  show_diagnostics 8 "$OUT/doctor.txt"
fi

# 2 whoami / session (optional but recorded)
if run_stage "whoami" "$OUT/whoami.txt" "$LABWIRED" whoami; then
  pass "whoami ran"
  if grep -qiE 'project:|not signed' "$OUT/whoami.txt"; then
    pass "whoami: $(head -3 "$OUT/whoami.txt" | tr '\n' ' ')"
  fi
else
  status=$?
  if [[ "$status" -ne 124 ]]; then
    echo "warn whoami failed (continue with local twin)"
  fi
fi

# 3 offline claim gate
if run_stage "assert-fixed" "$OUT/assert-fixed.txt" "$LABWIRED" assert-status model_verified \
  "$ROOT/fixtures/gate1/artifacts/fixed.verify.json"; then
  pass "assert-status offline green"
else
  status=$?
  if [[ "$status" -ne 124 ]]; then
    bad "assert-status offline green"
  fi
fi
if run_stage "assert-broken" "$OUT/assert-broken.txt" "$LABWIRED" assert-status model_verified \
  "$ROOT/fixtures/gate1/artifacts/broken.verify.json"; then
  bad "assert-status accepted broken as green"
else
  status=$?
  if [[ "$status" -ne 124 ]]; then
    pass "assert-status rejects broken"
  fi
fi

# 4 live twin prove
if run_stage "live-gate1" "$OUT/live-gate1.txt" "$ROOT/scripts/live-gate1.sh"; then
  pass "live-gate1 twin red→green"
else
  status=$?
  if [[ "$status" -ne 124 ]]; then
    bad "live-gate1"
  fi
  show_diagnostics 12 "$OUT/live-gate1.txt"
fi

# 5 compose CLI (agent-callable surface) + job path (need → recipe → view)
if run_stage "compose-uart" "$OUT/compose.txt" "$LABWIRED" compose uart \
  --file "$ROOT/fixtures/gate1-live/evidence/fixed/uart.log" --out "$OUT/compose.json"; then
  pass "labwired compose uart"
else
  status=$?
  if [[ "$status" -ne 124 ]]; then
    bad "labwired compose"
  fi
  show_diagnostics all "$OUT/compose.txt"
fi
if run_stage "compose-job" "$OUT/compose-job.txt" "$LABWIRED" compose job \
  --ask "plot LED vs UART" \
  --uart "$ROOT/fixtures/gate1-live/evidence/fixed/uart.log" \
  --out "$OUT/compose-job.json"; then
  if run_stage "compose-job-validate" "$OUT/compose-job-validate.txt" python3 -c \
    "import json;d=json.load(open('$OUT/compose-job.json')); assert d.get('ok') and (d.get('series') or d.get('markers'))"; then
    pass "labwired compose job (need→view)"
  else
    status=$?
    if [[ "$status" -ne 124 ]]; then
      bad "compose job empty json"
    fi
    show_diagnostics all "$OUT/compose-job.json"
  fi
else
  status=$?
  if [[ "$status" -ne 124 ]]; then
    bad "compose job"
  fi
  show_diagnostics all "$OUT/compose-job.txt"
fi

# 6 knowledge heroes
if run_stage "knowledge-top-parts" "$OUT/knowledge.txt" python3 \
  "$ROOT/scripts/knowledge-top-parts.py" --out "$OUT/knowledge-heroes.json"; then
  pass "knowledge-top-parts $(tail -1 "$OUT/knowledge.txt")"
else
  knowledge_status=$?
  # local-only fallback still must pass usefulness gate
  if run_stage "knowledge-top-parts-local" "$OUT/knowledge-local.txt" python3 \
    "$ROOT/scripts/knowledge-top-parts.py" --local-only --out "$OUT/knowledge-heroes.json"; then
    pass "knowledge-top-parts local-only $(tail -1 "$OUT/knowledge-local.txt")"
  else
    local_status=$?
    if [[ "$knowledge_status" -ne 124 && "$local_status" -ne 124 ]]; then
      bad "knowledge-top-parts"
    fi
    show_diagnostics 20 "$OUT/knowledge.txt" "$OUT/knowledge-local.txt"
  fi
fi

# 7 packs present
for s in golden-path bringup prove observe desk-hw; do
  if [[ -f "$ROOT/skills/$s/SKILL.md" ]]; then
    pass "pack $s"
  else
    bad "pack $s"
  fi
done

# 8 OpenCode present + golden-path pack (interactive chat is human; twin is automated prove)
if command -v opencode >/dev/null 2>&1; then
  pass "opencode on PATH"
else
  bad "opencode missing"
fi
if [[ -f "$ROOT/skills/golden-path/SKILL.md" ]] \
  && run_stage "golden-path-entry" "$OUT/golden-path-entry.txt" grep -qi \
    'bringup' "$ROOT/skills/golden-path/SKILL.md"; then
  pass "golden-path is default firmware entry"
else
  status=$?
  if [[ "$status" -ne 124 ]]; then
    bad "golden-path pack"
  fi
fi
if run_stage "golden-path-default" "$OUT/golden-path-default.txt" grep -qi \
  'golden-path first\|load \`golden-path\` first\|START with skill golden-path' \
  "$ROOT/config/AGENTS.md" "$ROOT/config/opencode.hosted.json"; then
  pass "AGENTS/opencode default golden-path first"
else
  status=$?
  if [[ "$status" -ne 124 ]]; then
    bad "missing golden-path-first default in AGENTS/opencode"
  fi
fi
echo "note: full NL chat prove is interactive; automated prove = live-gate1 + assert-status" \
  >"$OUT/opencode-note.txt"

# 9 skills inventory quick
if run_stage "skills-verify-all" "$OUT/skills-verify.txt" \
  bash "$ROOT/tests/skills-verify-all.sh"; then
  pass "skills-verify-all"
else
  status=$?
  if [[ "$status" -ne 124 ]]; then
    bad "skills-verify-all"
  fi
  show_diagnostics 10 "$OUT/skills-verify.txt"
fi

# 10 import diagram (catalog-honest twin_buildable)
if run_stage "import-diagram" "$OUT/import-smoke.txt" \
  bash "$ROOT/scripts/import-diagram-smoke.sh"; then
  pass "import-diagram twin_buildable"
else
  status=$?
  if [[ "$status" -ne 124 ]]; then
    bad "import-diagram"
  fi
  show_diagnostics 15 "$OUT/import-smoke.txt"
fi

# 10b multi-source import (live MCP when signed in — product depth Task 6)
if [[ -f "$HOME/.labwired/session/cloud.json" ]]; then
  if run_stage "import-multi" "$OUT/import-multi-smoke.txt" \
    bash "$ROOT/scripts/import-multi-smoke.sh"; then
    pass "import-multi (bom/text/kicad + diagram)"
  else
    status=$?
    if [[ "$status" -ne 124 ]]; then
      bad "import-multi"
    fi
    show_diagnostics 20 "$OUT/import-multi-smoke.txt"
  fi
else
  bad "import-multi skipped — not signed in"
fi

# 11 desk-hw polish
if run_stage "desk-hw" "$OUT/desk-hw-smoke.txt" bash "$ROOT/scripts/desk-hw-smoke.sh"; then
  pass "desk-hw polish"
else
  status=$?
  if [[ "$status" -ne 124 ]]; then
    bad "desk-hw polish"
  fi
  show_diagnostics 20 "$OUT/desk-hw-smoke.txt"
fi

# 12 hosted knowledge (required when session file exists; skip only if unsigned)
if [[ -f "$HOME/.labwired/session/cloud.json" ]]; then
  if run_stage "knowledge-mcp" "$OUT/knowledge-mcp.txt" \
    bash "$ROOT/scripts/knowledge-mcp-smoke.sh"; then
    pass "knowledge MCP list+part+datasheet+import"
  else
    status=$?
    if [[ "$status" -ne 124 ]]; then
      bad "knowledge MCP"
    fi
    show_diagnostics 30 "$OUT/knowledge-mcp.txt"
  fi
else
  bad "knowledge MCP skipped — not signed in (golden path requires login)"
fi

finalize
exit $?
