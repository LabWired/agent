#!/usr/bin/env bash
# Real hosted-agent certification. This lane never treats an unavailable prerequisite as green.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIX="$ROOT/tests/fixtures/develop-agent"
AGENT="${LABWIRED_DEVELOP_AGENT_BIN:-$ROOT/bin/labwired}"
MODEL="labwired/labwired-default"

fail_prereq() { echo "missing prerequisite: $*" >&2; exit 2; }

has_auth() {
  if [[ -n "${LABWIRED_ACCESS_TOKEN:-}" && -n "${LABWIRED_PROJECT:-}" ]]; then
    return 0
  fi
  local state_root="${LABWIRED_HOME:-${HOME:-}/.labwired}"
  [[ -s "$state_root/session/cloud.json" ]]
}

check_prerequisites() {
  has_auth || fail_prereq "hosted authentication; run 'labwired agent login' or provide LABWIRED_ACCESS_TOKEN and LABWIRED_PROJECT"
  [[ -x "$AGENT" ]] || fail_prereq "LabWired CLI executable at $AGENT"
  command -v opencode >/dev/null 2>&1 || fail_prereq "agent runtime 'opencode'"
  command -v curl >/dev/null 2>&1 || fail_prereq "curl for hosted proxy probe"
  [[ "${LABWIRED_DEVELOP_KNOWLEDGE_READY:-0}" == "1" ]] || fail_prereq "hosted knowledge tools; set LABWIRED_DEVELOP_KNOWLEDGE_READY=1 only after provisioning"
  [[ "${LABWIRED_DEVELOP_TWIN_READY:-0}" == "1" ]] || fail_prereq "explicit twin targets; set LABWIRED_DEVELOP_TWIN_READY=1 only after ESP32-C3 and STM32F103 twins are provisioned"

  local access="${LABWIRED_ACCESS_TOKEN:-}" project="${LABWIRED_PROJECT:-}"
  if [[ -z "$access" || -z "$project" ]]; then
    read -r access project < <(python3 - "${LABWIRED_HOME:-${HOME}/.labwired}/session/cloud.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
print(d.get("access_token", d.get("accessToken", "")), d.get("project", d.get("project_id", "")))
PY
)
  fi
  [[ -n "$access" && -n "$project" ]] || fail_prereq "hosted authentication session lacks access token or project"
  local status
  status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
    -H "Authorization: Bearer $access" -H "X-LabWired-Project: $project" \
    "${LABWIRED_API_URL:-https://api.labwired.com}/v1/models" || true)"
  [[ "$status" == "200" ]] || fail_prereq "hosted proxy authentication probe returned HTTP ${status:-unreachable}"
}

print_command() {
  local project="$1" prompt="$2"
  printf 'cd %q && %q agent run --model %q --format json %q\n' "$project" "$AGENT" "$MODEL" "$prompt"
}

extract_events() {
  python3 "$ROOT/tests/develop-agent-jsonl.py" "$1" "$2"
}

run_agent() {
  local project="$1" prompt="$2" raw="$3" stderr_file="$4"
  local timeout_seconds="${LABWIRED_DEVELOP_SCENARIO_TIMEOUT_SECONDS:-900}"
  python3 - "$project" "$AGENT" "$MODEL" "$prompt" "$raw" "$stderr_file" "$timeout_seconds" <<'PY'
import os, subprocess, sys
project, agent, model, prompt, stdout_path, stderr_path, timeout_text = sys.argv[1:]
try:
    timeout = int(timeout_text)
    if timeout < 1:
        raise ValueError
except ValueError:
    print("invalid LABWIRED_DEVELOP_SCENARIO_TIMEOUT_SECONDS", file=sys.stderr)
    raise SystemExit(2)
with open(stdout_path, "wb") as stdout, open(stderr_path, "wb") as stderr:
    try:
        completed = subprocess.run(
            [agent, "agent", "run", "--model", model, "--format", "json", prompt],
            cwd=project,
            env={**os.environ, "LABWIRED_CERTIFICATION_JSON_ONLY": "1"},
            stdout=stdout,
            stderr=stderr,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        print(f"agent scenario timed out after {timeout}s", file=stderr)
        raise SystemExit(124)
raise SystemExit(completed.returncode)
PY
}

prepare_project() {
  local scenario="$1" project="$2"
  mkdir -p "$project"
  case "$scenario" in
    existing-stm32f103) cp -R "$ROOT/fixtures/develop-acceptance/stm32f103/." "$project/" ;;
    compile-recovery-esp32c3)
      mkdir -p "$project/src"
      cp "$ROOT/fixtures/develop-acceptance/esp32c3/main-broken.cpp" "$project/src/main.cpp"
      ;;
    unsupported-custom-board) cp -R "$ROOT/fixtures/develop-acceptance/custom-board/." "$project/" ;;
  esac
}

run_all() {
  check_prerequisites
  local work evidence cleanup_cmd
  work="$(mktemp -d "${TMPDIR:-/tmp}/labwired-develop-agent.XXXXXX")"
  evidence="${LABWIRED_DEVELOP_EVIDENCE_DIR:-$work/evidence}"
  mkdir -p "$evidence"
  chmod 700 "$evidence"
  printf -v cleanup_cmd 'rm -rf -- %q' "$work"
  trap "$cleanup_cmd" EXIT

  python3 - "$FIX/prompts.json" "$work/prompts.tsv" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
with open(sys.argv[2], "w", encoding="utf-8") as out:
    for key, prompt in d.items():
        assert "\n" not in key and "\t" not in key and "\n" not in prompt and "\t" not in prompt
        out.write(key + "\t" + prompt + "\n")
PY

  local scenario prompt project raw events stderr_file before_layout before_config
  while IFS=$'\t' read -r scenario prompt; do
    project="$work/projects/$scenario"
    prepare_project "$scenario" "$project"
    before_layout="" before_config=""
    if [[ "$scenario" == "existing-stm32f103" ]]; then
      before_layout="$(cd "$project" && find . -type f | sort)"
      before_config="$(shasum -a 256 "$project/platformio.ini" | awk '{print $1}')"
    fi
    raw="$work/$scenario.raw"
    stderr_file="$work/$scenario.stderr"
    events="$work/$scenario.events.jsonl"
    echo "INFO real-agent scenario=$scenario model=$MODEL" >&2
    set +e
    run_agent "$project" "$prompt" "$raw" "$stderr_file"
    agent_status=$?
    set -e
    python3 "$ROOT/tests/develop-agent-jsonl.py" sanitize-stderr "$stderr_file" "$work/$scenario.stderr.sanitized"
    if [[ "$agent_status" -ne 0 ]]; then
      echo "certification failed: scenario $scenario agent exit $agent_status" >&2
      tail -20 "$work/$scenario.stderr.sanitized" >&2 || true
      exit 1
    fi
    extract_events "$raw" "$events" || { echo "certification failed: scenario $scenario emitted no structured tool events" >&2; exit 1; }
    python3 "$ROOT/tests/develop-agent-oracle.py" validate "$events" "$scenario" >"$evidence/$scenario.json"
    chmod 600 "$evidence/$scenario.json"
    if [[ "$scenario" == "existing-stm32f103" ]]; then
      after_layout="$(cd "$project" && find . -type f ! -path './.pio/*' | sort)"
      after_config="$(shasum -a 256 "$project/platformio.ini" | awk '{print $1}')"
      [[ "$before_layout" == "$after_layout" && "$before_config" == "$after_config" ]] || {
        echo "certification failed: existing-stm32f103 changed project layout or platformio.ini" >&2
        exit 1
      }
    fi
  done <"$work/prompts.tsv"

  python3 - "$evidence" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
expected = {"greenfield-esp32c3", "existing-stm32f103", "compile-recovery-esp32c3", "partial-led-wifi", "unsupported-custom-board"}
seen = {p.stem for p in root.glob("*.json")}
assert seen == expected, (seen, expected)
print("CERTIFIED grounded_hosted_agent_loop scenarios=5 evidence=" + str(root))
PY
}

case "${1:-}" in
  --check-prerequisites) check_prerequisites ;;
  --print-command) [[ $# -eq 3 ]] || { echo "usage: $0 --print-command <project> <prompt>" >&2; exit 2; }; print_command "$2" "$3" ;;
  "") run_all ;;
  *) echo "usage: $0 [--check-prerequisites|--print-command <project> <prompt>]" >&2; exit 2 ;;
esac
