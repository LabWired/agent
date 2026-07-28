#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/resolve-sim.sh
source "$ROOT/lib/resolve-sim.sh"
# shellcheck source=lib/resolve-mcp.sh
source "$ROOT/lib/resolve-mcp.sh"

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
# Realistic agent launcher content (signature used by resolve-sim)
cat >"$ONLY_AGENT/bin/labwired" <<'EOS'
#!/bin/sh
# LabWired Firmware Agent — the easiest way to write firmware.
export LABWIRED_AGENT_HOME=/tmp/fake
echo agent
EOS
chmod +x "$ONLY_AGENT/bin/labwired"
got="$(
  (
    export PATH="$ONLY_AGENT/bin:$SYS_PATH"
    unset LABWIRED_CLI LABWIRED_SIM || true
    labwired_resolve_sim "$ONLY_AGENT/bin/labwired" || true
  )
)"
assert_empty "reject agent-only labwired as sim" "$got"
rm -rf "$ONLY_AGENT"

# Wrapper script pointing at agent home must not count as sim
WRAP="$(mktemp -d)"
mkdir -p "$WRAP/bin"
cat >"$WRAP/bin/labwired" <<EOS
#!/usr/bin/env bash
export LABWIRED_AGENT_HOME="$WRAP"
exec true
EOS
chmod +x "$WRAP/bin/labwired"
got="$(
  (
    export PATH="$WRAP/bin:$SYS_PATH"
    unset LABWIRED_CLI LABWIRED_SIM || true
    labwired_resolve_sim "$WRAP/bin/labwired" || true
  )
)"
assert_empty "reject PATH wrapper as sim" "$got"
rm -rf "$WRAP"

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

# --- MCP resolve -------------------------------------------------------------
# Isolate from developer's monorepo (local packages/mcp would otherwise win).
_mcp_env() {
  export LABWIRED_MONOREPO="/nonexistent"
  export HOME="$FIX/home"
  mkdir -p "$HOME"
}

# vendor path under agent root
mkdir -p "$FIX/mcp/vendor"
echo 'console.log(1)' >"$FIX/mcp/vendor/index.js"
got="$(
  (
    _mcp_env
    export LABWIRED_PROFILE=airgap
    unset LABWIRED_MCP_ENTRY || true
    unset LABWIRED_MCP_ALLOW_NPX || true
    labwired_resolve_mcp_command_json "$FIX"
  )
)"
if echo "$got" | grep -q '"node"'; then
  echo "ok   mcp vendor"
else
  echo "FAIL mcp vendor: got='$got'"
  fail=1
fi

# airgap without vendor fails (no npx fallback)
rm -rf "$FIX/mcp"
if (
  _mcp_env
  export LABWIRED_PROFILE=airgap
  unset LABWIRED_MCP_ENTRY || true
  unset LABWIRED_MCP_ALLOW_NPX || true
  labwired_resolve_mcp_command_json "$FIX" 2>/dev/null
); then
  echo "FAIL airgap should fail without vendor"
  fail=1
else
  echo "ok   airgap refuses npx"
fi

# online default allows npx when no monorepo MCP
got="$(
  (
    _mcp_env
    export LABWIRED_PROFILE=online
    unset LABWIRED_MCP_ENTRY || true
    unset LABWIRED_MCP_ALLOW_NPX || true
    labwired_resolve_mcp_command_json "$FIX"
  )
)"
assert_eq "online default npx" "$got" '["npx","-y","@labwired/mcp"]'

# LABWIRED_MCP_ALLOW_NPX forces npx even under airgap (still after monorepo skip)
got="$(
  (
    _mcp_env
    export LABWIRED_PROFILE=airgap
    export LABWIRED_MCP_ALLOW_NPX=1
    unset LABWIRED_MCP_ENTRY || true
    labwired_resolve_mcp_command_json "$FIX"
  )
)"
assert_eq "ALLOW_NPX forces npx under airgap" "$got" '["npx","-y","@labwired/mcp"]'

# LABWIRED_MCP_ENTRY wins
ENTRY_JS="$FIX/custom-entry.js"
echo 'console.log(2)' >"$ENTRY_JS"
got="$(
  (
    export LABWIRED_PROFILE=airgap
    export LABWIRED_MCP_ENTRY="$ENTRY_JS"
    unset LABWIRED_MCP_ALLOW_NPX || true
    labwired_resolve_mcp_command_json "$FIX"
  )
)"
if echo "$got" | grep -q '"node"' && echo "$got" | grep -q 'custom-entry.js'; then
  echo "ok   LABWIRED_MCP_ENTRY"
else
  echo "FAIL LABWIRED_MCP_ENTRY: got='$got'"
  fail=1
fi

if [[ "$fail" -ne 0 ]]; then
  echo "harness tests FAILED"
  exit 1
fi
echo "resolve-mcp tests passed"

# --- skill inventory ---------------------------------------------------------

want=$'board-bringup\ndiagnose-firmware\ninspect-evidence\nreport-evidence\nscaffold-firmware\nverify-firmware'
got="$(find "$ROOT/skills" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort)"
assert_eq "skill inventory" "$got" "$want"
if [[ -d "$ROOT/skills/firmware-verification" ]]; then
  echo "FAIL duplicate skill: firmware-verification must not exist"
  fail=1
else
  echo "ok   no firmware-verification skill"
fi

if [[ "$fail" -ne 0 ]]; then
  echo "harness tests FAILED"
  exit 1
fi
echo "skill inventory tests passed"

# --- assert-status -----------------------------------------------------------
# shellcheck source=lib/assert-status.sh
source "$ROOT/lib/assert-status.sh"

if echo '{"status":"model_verified","proven":true}' | labwired_assert_status model_verified >/dev/null; then
  echo "ok   assert-status model_verified accepts"
else
  echo "FAIL assert-status model_verified should accept"
  fail=1
fi

if echo '{"status":"failed","proven":false}' | labwired_assert_status model_verified >/dev/null 2>&1; then
  echo "FAIL assert-status failed should reject model_verified"
  fail=1
else
  echo "ok   assert-status failed rejects model_verified"
fi

if echo '{"status":"unsupported"}' | labwired_assert_status unsupported >/dev/null; then
  echo "ok   assert-status unsupported accepts unsupported"
else
  echo "FAIL assert-status unsupported should accept"
  fail=1
fi

# Nested MCP-style content string carrying a status JSON blob
if echo '{"content":"{\"status\":\"model_verified\"}"}' | labwired_assert_status model_verified >/dev/null; then
  echo "ok   assert-status nested content status string"
else
  echo "FAIL assert-status nested content status string"
  fail=1
fi

# Gate 1 public proof artifacts (offline claim shape)
if labwired_assert_status failed <"$ROOT/fixtures/gate1/artifacts/broken.verify.json" >/dev/null; then
  echo "ok   gate1 artifact broken → failed"
else
  echo "FAIL gate1 artifact broken should be status failed"
  fail=1
fi
if labwired_assert_status model_verified <"$ROOT/fixtures/gate1/artifacts/fixed.verify.json" >/dev/null; then
  echo "ok   gate1 artifact fixed → model_verified"
else
  echo "FAIL gate1 artifact fixed should be status model_verified"
  fail=1
fi

if [[ "$fail" -ne 0 ]]; then
  echo "harness tests FAILED"
  exit 1
fi
echo "assert-status tests passed"
echo "all harness tests passed"
