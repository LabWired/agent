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
active_runner_pid=""
stage_timed_out=0
pass() { echo "ok   $*"; }
bad() { echo "FAIL $*"; fail=1; }

cancel_gate() {
  local signal_name="$1" signal_number="$2" runner_pid="$active_runner_pid"
  trap '' HUP INT QUIT TERM
  if [[ -n "$runner_pid" ]]; then
    kill -"$signal_name" "$runner_pid" 2>/dev/null || true
    wait "$runner_pid" 2>/dev/null || true
  fi
  exit $((128 + signal_number))
}
trap 'cancel_gate HUP 1' HUP
trap 'cancel_gate INT 2' INT
trap 'cancel_gate QUIT 3' QUIT
trap 'cancel_gate TERM 15' TERM

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
  local name="$1" log="$2" timeout_override timeout timeout_marker status
  shift 2
  timeout_override="LABWIRED_SHIP_STAGE_TIMEOUT_${name//-/_}"
  timeout="${!timeout_override:-$LABWIRED_SHIP_STAGE_TIMEOUT}"
  timeout_marker="$OUT/.${name}.timeout.$$"
  stage_timed_out=0
  set +e
  python3 "$ROOT/scripts/run-bounded.py" --timeout "$timeout" \
    --timeout-marker "$timeout_marker" -- "$@" >"$log" 2>&1 &
  active_runner_pid=$!
  wait "$active_runner_pid"
  status=$?
  active_runner_pid=""
  set -e
  if [[ -f "$timeout_marker" ]]; then
    stage_timed_out=1
    rm -f "$timeout_marker" || true
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
      if [[ "$stage_timed_out" -eq 0 ]]; then
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
  if [[ "$stage_timed_out" -eq 0 ]]; then
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
  if [[ "$stage_timed_out" -eq 0 ]]; then
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
  if [[ "$stage_timed_out" -eq 0 ]]; then
    echo "warn whoami failed (continue with local twin)"
  fi
fi

# 3 offline claim gate
if run_stage "assert-fixed" "$OUT/assert-fixed.txt" "$LABWIRED" assert-status model_verified \
  "$ROOT/fixtures/gate1/artifacts/fixed.verify.json"; then
  pass "assert-status offline green"
else
  if [[ "$stage_timed_out" -eq 0 ]]; then
    bad "assert-status offline green"
  fi
fi
if run_stage "assert-broken" "$OUT/assert-broken.txt" "$LABWIRED" assert-status model_verified \
  "$ROOT/fixtures/gate1/artifacts/broken.verify.json"; then
  bad "assert-status accepted broken as green"
else
  if [[ "$stage_timed_out" -eq 0 ]]; then
    pass "assert-status rejects broken"
  fi
fi

# 4 live twin prove
if run_stage "live-gate1" "$OUT/live-gate1.txt" "$ROOT/scripts/live-gate1.sh"; then
  pass "live-gate1 twin red→green"
else
  if [[ "$stage_timed_out" -eq 0 ]]; then
    bad "live-gate1"
  fi
  show_diagnostics 12 "$OUT/live-gate1.txt"
fi

# 5 compose CLI (agent-callable surface) + job path (need → recipe → view)
if run_stage "compose-uart" "$OUT/compose.txt" "$LABWIRED" compose uart \
  --file "$ROOT/fixtures/gate1-live/evidence/fixed/uart.log" --out "$OUT/compose.json"; then
  pass "labwired compose uart"
else
  if [[ "$stage_timed_out" -eq 0 ]]; then
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
    if [[ "$stage_timed_out" -eq 0 ]]; then
      bad "compose job empty json"
    fi
    show_diagnostics all "$OUT/compose-job.json"
  fi
else
  if [[ "$stage_timed_out" -eq 0 ]]; then
    bad "compose job"
  fi
  show_diagnostics all "$OUT/compose-job.txt"
fi

# 6 knowledge heroes
if run_stage "knowledge-top-parts" "$OUT/knowledge.txt" python3 \
  "$ROOT/scripts/knowledge-top-parts.py" --out "$OUT/knowledge-heroes.json"; then
  pass "knowledge-top-parts $(tail -1 "$OUT/knowledge.txt")"
else
  knowledge_timed_out="$stage_timed_out"
  # local-only fallback still must pass usefulness gate
  if run_stage "knowledge-top-parts-local" "$OUT/knowledge-local.txt" python3 \
    "$ROOT/scripts/knowledge-top-parts.py" --local-only --out "$OUT/knowledge-heroes.json"; then
    pass "knowledge-top-parts local-only $(tail -1 "$OUT/knowledge-local.txt")"
  else
    local_timed_out="$stage_timed_out"
    if [[ "$knowledge_timed_out" -eq 0 && "$local_timed_out" -eq 0 ]]; then
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
  if [[ "$stage_timed_out" -eq 0 ]]; then
    bad "golden-path pack"
  fi
fi
if run_stage "develop-default" "$OUT/develop-default.txt" bash -c '
  for f in "$@"; do
    grep -qi '"'"'develop first\|load \`develop\` first\|START with skill develop'"'"' "$f" || exit 1
  done
' _ "$ROOT/config/AGENTS.md" "$ROOT/config/opencode.hosted.json"; then
  pass "AGENTS/opencode default develop first"
else
  if [[ "$stage_timed_out" -eq 0 ]]; then
    bad "missing develop-first default in AGENTS/opencode"
  fi
fi
echo "note: full NL chat prove is interactive; automated prove = live-gate1 + assert-status" \
  >"$OUT/opencode-note.txt"

# 9 skills inventory quick
if run_stage "skills-verify-all" "$OUT/skills-verify.txt" \
  bash "$ROOT/tests/skills-verify-all.sh"; then
  pass "skills-verify-all"
else
  if [[ "$stage_timed_out" -eq 0 ]]; then
    bad "skills-verify-all"
  fi
  show_diagnostics 10 "$OUT/skills-verify.txt"
fi

# 10 import diagram (catalog-honest twin_buildable)
if run_stage "import-diagram" "$OUT/import-smoke.txt" \
  bash "$ROOT/scripts/import-diagram-smoke.sh"; then
  pass "import-diagram twin_buildable"
else
  if [[ "$stage_timed_out" -eq 0 ]]; then
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
    if [[ "$stage_timed_out" -eq 0 ]]; then
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
  if [[ "$stage_timed_out" -eq 0 ]]; then
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
    if [[ "$stage_timed_out" -eq 0 ]]; then
      bad "knowledge MCP"
    fi
    show_diagnostics 30 "$OUT/knowledge-mcp.txt"
  fi
else
  bad "knowledge MCP skipped — not signed in (golden path requires login)"
fi

# 13 grounded hosted-agent certification. A normal local gate records an honest
# not-run unless both hosted credentials and explicit knowledge/twin provisioning
# are present. Release intent is strict: the certifier itself identifies every
# missing prerequisite and returns non-zero; there is no SKIP-to-green path.
hosted_release_creds=0
develop_prereqs=0
if [[ -n "${LABWIRED_ACCESS_TOKEN:-}" && -n "${LABWIRED_PROJECT:-}" ]]; then
  hosted_release_creds=1
fi
if [[ "${LABWIRED_DEVELOP_KNOWLEDGE_READY:-0}" == "1" \
   && "${LABWIRED_DEVELOP_TWIN_READY:-0}" == "1" ]]; then
  develop_prereqs=1
fi
if [[ "${LABWIRED_ACCEPTANCE_REQUIRE_COMPLETE:-0}" == "1" \
   || ( "$hosted_release_creds" -eq 1 && "$develop_prereqs" -eq 1 ) ]]; then
  if run_stage "develop-agent" "$OUT/develop-agent.txt" \
    bash "$ROOT/tests/develop-agent-e2e.sh"; then
    pass "grounded hosted-agent certification"
  else
    if [[ "$stage_timed_out" -eq 0 ]]; then
      bad "grounded hosted-agent certification"
    fi
    show_diagnostics 30 "$OUT/develop-agent.txt"
  fi
else
  echo "grounded hosted-agent certification NOT RUN — local gate lacks hosted-release credentials and/or explicitly provisioned knowledge+twin prerequisites" \
    | tee "$OUT/develop-agent.txt"
fi

finalize
exit $?
