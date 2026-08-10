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
assert_equals "$(run_dispatcher core test board.yml)" 'core:test board.yml'
assert_equals "$(run_dispatcher test board.yml)" 'core:test board.yml'
assert_equals "$(run_dispatcher core argv 'spaced argument' '')" $'argc:2\narg:spaced\\ argument\narg:\x27\x27'

editor_stderr="$TMP/editor.stderr"
if run_dispatcher editor 2>"$editor_stderr"; then
  echo "FAIL editor unexpectedly succeeded" >&2
  exit 1
fi
assert_contains "$(cat "$editor_stderr")" 'not installed'

echo "ok   dispatcher PASS"
