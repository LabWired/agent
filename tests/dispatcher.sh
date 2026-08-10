#!/usr/bin/env bash
# Public command-dispatch contract for the unified LabWired launcher.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export LABWIRED_HOME="$TMP/labwired"
export LABWIRED_BIN_DIR="$TMP/bin"
mkdir -p "$LABWIRED_HOME/components/core/bin" "$LABWIRED_HOME/agent/bin" "$LABWIRED_BIN_DIR"
export PATH="$LABWIRED_BIN_DIR:/usr/bin:/bin"

cat >"$LABWIRED_HOME/components/core/bin/labwired" <<'EOF'
#!/usr/bin/env bash
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

help="$(bash "$ROOT/bin/labwired")"
assert_contains "$help" 'labwired agent'
assert_contains "$help" 'labwired core'
assert_contains "$help" 'labwired editor'

assert_equals "$(bash "$ROOT/bin/labwired" agent doctor)" 'agent:doctor'
assert_equals "$(bash "$ROOT/bin/labwired" core test board.yml)" 'core:test board.yml'
assert_equals "$(bash "$ROOT/bin/labwired" test board.yml)" 'core:test board.yml'

editor_stderr="$TMP/editor.stderr"
if bash "$ROOT/bin/labwired" editor 2>"$editor_stderr"; then
  echo "FAIL editor unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq 'not installed' "$editor_stderr"

echo "ok   dispatcher PASS"
