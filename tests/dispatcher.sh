#!/usr/bin/env bash
# Public command-dispatch contract for the unified LabWired launcher.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export LABWIRED_HOME="$TMP/labwired"
export LABWIRED_BIN_DIR="$TMP/bin"
mkdir -p "$TMP/home" "$LABWIRED_HOME/components/core/bin" "$LABWIRED_HOME/agent/bin" "$LABWIRED_BIN_DIR"

cat >"$LABWIRED_HOME/components/core/bin/labwired" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "argv" ]]; then
  shift
  printf 'argc:%s\n' "$#"
  printf 'arg:%q\n' "$@"
  exit 0
fi
printf 'core:%s\n' "$*"
EOF
chmod +x "$LABWIRED_HOME/components/core/bin/labwired"

cat >"$LABWIRED_HOME/agent/bin/labwired-agent" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "argv" ]]; then
  shift
  printf 'argc:%s\n' "$#"
  printf 'arg:%q\n' "$@"
  exit 0
fi
printf 'agent:%s\n' "$*"
EOF
chmod +x "$LABWIRED_HOME/agent/bin/labwired-agent"

export LABWIRED_CORE_BIN="$LABWIRED_HOME/components/core/bin/labwired"
export LABWIRED_AGENT_BIN="$LABWIRED_HOME/agent/bin/labwired-agent"

run_dispatcher() {
  env -i \
    HOME="$TMP/home" \
    PATH="$LABWIRED_BIN_DIR:/usr/bin:/bin" \
    LABWIRED_HOME="$LABWIRED_HOME" \
    LABWIRED_BIN_DIR="$LABWIRED_BIN_DIR" \
    LABWIRED_CORE_BIN="$LABWIRED_CORE_BIN" \
    LABWIRED_AGENT_BIN="$LABWIRED_AGENT_BIN" \
    bash "$ROOT/bin/labwired" "$@"
}

assert_contains() {
  local haystack="$1" needle="$2"
  if ! grep -Fq "$needle" <<<"$haystack"; then
    echo "FAIL expected output to include: $needle" >&2
    exit 1
  fi
}

assert_equals() {
  local actual="$1" expected="$2"
  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

help="$(run_dispatcher)"
assert_contains "$help" 'labwired agent'
assert_contains "$help" 'labwired core'
assert_contains "$help" 'labwired editor'

assert_equals "$(run_dispatcher agent doctor)" 'agent:doctor'
assert_equals "$(run_dispatcher agent argv 'spaced argument' '')" $'argc:2\narg:spaced\\ argument\narg:\x27\x27'
assert_equals "$(run_dispatcher core test board.yml)" 'core:test board.yml'
assert_equals "$(run_dispatcher core argv 'spaced argument' '')" $'argc:2\narg:spaced\\ argument\narg:\x27\x27'

legacy_core_commands=(
  test chips machine asset run snapshot coverage tier1-matrix cosim-step fuzz
)
for command in "${legacy_core_commands[@]}"; do
  assert_equals "$(run_dispatcher "$command" board.yml)" "core:$command board.yml"
done

missing_core_output="$TMP/missing-core.output"
# $1 expands inside the child shell.
# shellcheck disable=SC2016
if env HOME="$TMP/home" LABWIRED_HOME="$TMP/missing-home" LABWIRED_CORE_BIN="" \
  bash -c 'source "$1/lib/dispatch.sh"; labwired_dispatch_core_bin' _ "$ROOT" \
  >"$missing_core_output"; then
  echo "FAIL missing Core unexpectedly resolved" >&2
  exit 1
fi
assert_equals "$(cat "$missing_core_output")" ''

missing_core_stderr="$TMP/missing-core.stderr"
if env -i \
  HOME="$TMP/home" \
  PATH="$LABWIRED_BIN_DIR:/usr/bin:/bin" \
  LABWIRED_HOME="$TMP/missing-home" \
  bash "$ROOT/bin/labwired" core test 2>"$missing_core_stderr"; then
  echo "FAIL missing Core dispatch unexpectedly succeeded" >&2
  exit 1
else
  missing_core_rc=$?
fi
assert_equals "$missing_core_rc" '1'
assert_contains "$(cat "$missing_core_stderr")" 'not installed'

missing_agent_stderr="$TMP/missing-agent.stderr"
if env -i \
  HOME="$TMP/home" \
  PATH="$LABWIRED_BIN_DIR:/usr/bin:/bin" \
  LABWIRED_HOME="$TMP/missing-home" \
  bash "$ROOT/bin/labwired" agent doctor 2>"$missing_agent_stderr"; then
  echo "FAIL missing Agent dispatch unexpectedly succeeded" >&2
  exit 1
else
  missing_agent_rc=$?
fi
assert_equals "$missing_agent_rc" '1'
assert_contains "$(cat "$missing_agent_stderr")" 'not installed'

unknown_stderr="$TMP/unknown.stderr"
if run_dispatcher mystery 2>"$unknown_stderr"; then
  echo "FAIL unknown command unexpectedly succeeded" >&2
  exit 1
else
  unknown_rc=$?
fi
assert_equals "$unknown_rc" '2'
assert_contains "$(cat "$unknown_stderr")" 'labwired: unknown command: mystery'
assert_contains "$(cat "$unknown_stderr")" 'Run: labwired --help'

editor_stderr="$TMP/editor.stderr"
if run_dispatcher editor 2>"$editor_stderr"; then
  echo "FAIL editor unexpectedly succeeded" >&2
  exit 1
fi
assert_contains "$(cat "$editor_stderr")" 'not installed'

echo "ok   dispatcher PASS"
