#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/resolve-sim.sh
source "$ROOT/lib/resolve-sim.sh"

fail=0
assert_eq() {
  local name="$1" got="$2" want="$3"
  if [[ "$got" != "$want" ]]; then
    echo "FAIL $name: got='$got' want='$want'"
    fail=1
  else
    echo "ok   $name"
  fi
}

assert_empty() {
  local name="$1" got="$2"
  if [[ -n "$got" ]]; then
    echo "FAIL $name: expected empty, got='$got'"
    fail=1
  else
    echo "ok   $name"
  fi
}

# Isolated PATH fixture (fixture bin first; keep system bins for builtins)
FIX="$(mktemp -d)"
trap 'rm -rf "$FIX"' EXIT
mkdir -p "$FIX/bin"
SYS_PATH="/usr/bin:/bin"
FIX_PATH="$FIX/bin:$SYS_PATH"

# fake agent launcher
cat >"$FIX/bin/labwired" <<'EOS'
#!/bin/sh
echo agent
EOS
chmod +x "$FIX/bin/labwired"

# fake simulator with different name
cat >"$FIX/bin/labwired-sim" <<'EOS'
#!/bin/sh
echo sim
EOS
chmod +x "$FIX/bin/labwired-sim"

# When LABWIRED_CLI points at sim path, use it (explicit path wins)
got="$(
  (
    export PATH="$FIX_PATH"
    export LABWIRED_CLI="$FIX/bin/labwired-sim"
    unset LABWIRED_SIM || true
    labwired_resolve_sim "$FIX/bin/labwired" || true
  )
)"
assert_eq "explicit LABWIRED_CLI path" "$got" "$FIX/bin/labwired-sim"

# LABWIRED_SIM also accepted when LABWIRED_CLI unset
got="$(
  (
    export PATH="$FIX_PATH"
    unset LABWIRED_CLI || true
    export LABWIRED_SIM="$FIX/bin/labwired-sim"
    labwired_resolve_sim "$FIX/bin/labwired" || true
  )
)"
assert_eq "explicit LABWIRED_SIM path" "$got" "$FIX/bin/labwired-sim"

# When only agent is named labwired, do not pick agent as sim — prefer labwired-sim
got="$(
  (
    export PATH="$FIX_PATH"
    unset LABWIRED_CLI LABWIRED_SIM || true
    labwired_resolve_sim "$FIX/bin/labwired" || true
  )
)"
assert_eq "prefer labwired-sim over agent labwired" "$got" "$FIX/bin/labwired-sim"

# Only agent on PATH (no sim names): must not resolve agent as simulator
ONLY_AGENT="$(mktemp -d)"
mkdir -p "$ONLY_AGENT/bin"
cp "$FIX/bin/labwired" "$ONLY_AGENT/bin/labwired"
got="$(
  (
    export PATH="$ONLY_AGENT/bin:$SYS_PATH"
    unset LABWIRED_CLI LABWIRED_SIM || true
    labwired_resolve_sim "$ONLY_AGENT/bin/labwired" || true
  )
)"
assert_empty "reject agent-only labwired as sim" "$got"
rm -rf "$ONLY_AGENT"

# Empty when nothing usable on a clean PATH (system may still have real bins)
got="$(
  (
    export PATH="$SYS_PATH"
    unset LABWIRED_CLI LABWIRED_SIM || true
    labwired_resolve_sim "$FIX/bin/labwired" || true
  )
)"
sys_has=0
if (export PATH="$SYS_PATH"; command -v labwired >/dev/null 2>&1); then sys_has=1; fi
if (export PATH="$SYS_PATH"; command -v labwired-sim >/dev/null 2>&1); then sys_has=1; fi
if (export PATH="$SYS_PATH"; command -v labwired-cli >/dev/null 2>&1); then sys_has=1; fi
if [[ "$sys_has" -eq 0 ]]; then
  assert_empty "none found on clean PATH" "$got"
else
  echo "skip none-found (system has a labwired* binary on $SYS_PATH)"
fi

if [[ "$fail" -ne 0 ]]; then
  echo "resolve-sim tests FAILED"
  exit 1
fi
echo "resolve-sim tests passed"
