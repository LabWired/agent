#!/usr/bin/env bash
# Hosted agent path: shared remote MCP tools + model gateway config.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/prefix.sh
source "$ROOT/lib/prefix.sh"
# shellcheck source=lib/cloud-session.sh
source "$ROOT/lib/cloud-session.sh"

fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }

cfg="$ROOT/config/opencode.hosted.json"
test -f "$cfg" || bad "missing opencode.hosted.json"
test -f "$ROOT/config/opencode.json" || bad "missing opencode.json"

python3 - <<PY
import json, sys
from pathlib import Path
cfg = json.loads(Path("$cfg").read_text())
mcp = cfg.get("mcp", {}).get("labwired", {})
assert mcp.get("type") == "remote", mcp
assert mcp.get("url") == "https://api.labwired.com/mcp", mcp
auth = (mcp.get("headers") or {}).get("Authorization", "")
assert "{env:LABWIRED_ACCESS_TOKEN}" in auth, auth
prov = cfg.get("provider", {}).get("labwired", {})
opts = prov.get("options") or {}
assert opts.get("baseURL") == "https://api.labwired.com/v1", opts
assert "{env:LABWIRED_ACCESS_TOKEN}" in str(opts.get("apiKey")), opts
headers = opts.get("headers") or {}
assert "{env:LABWIRED_PROJECT}" in str(headers.get("X-LabWired-Project", "")), headers
models = prov.get("models") or {}
assert "labwired-default" in models, prov
assert "labwired-fast" in models, prov
assert cfg.get("model") == "labwired/labwired-default", cfg.get("model")
# Skills allowlist must include primary LabWired packs (legacy verify-firmware → prove)
skills = (cfg.get("permission") or {}).get("skill") or {}
for required in ("golden-path", "bringup", "prove", "observe", "desk-hw"):
    assert skills.get(required) == "allow", (required, skills)
# Agent description must point at golden-path / prove (oracle dispose)
desc = ((cfg.get("agent") or {}).get("labwired") or {}).get("description") or ""
assert "golden-path" in desc.lower() or "prove" in desc.lower(), desc
assert "model_verified" in desc or "labwired_verify" in desc or "never invent" in desc.lower(), desc
print("ok   hosted config schema")
PY

# Session save/load round-trip
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export LABWIRED_HOME="$TMP"
labwired_cloud_session_save "lwd_test_access" "lwr_test_refresh" 7200 "proj_abc" "dev@labwired.test" >/dev/null
labwired_cloud_session_load
[[ "$LABWIRED_ACCESS_TOKEN" == "lwd_test_access" ]] && ok "session load access" || bad "session load access"
[[ "$LABWIRED_PROJECT" == "proj_abc" ]] && ok "session load project" || bad "session load project"
[[ "$LABWIRED_MODEL_URL" == "https://api.labwired.com/v1" ]] && ok "model url" || bad "model url got $LABWIRED_MODEL_URL"
labwired_cloud_hosted_ready && ok "hosted ready" || bad "hosted ready"
labwired_cloud_session_clear
if [[ -f "$(labwired_cloud_session_path)" ]]; then bad "session clear"; else ok "session clear"; fi

# CLI surfaces
if grep -q 'cmd_login' "$ROOT/bin/labwired" && grep -q 'labwired_prepare_agent_start' "$ROOT/bin/labwired"; then
  ok "bin/labwired login + prepare"
else
  bad "bin/labwired missing hosted commands"
fi
bash -n "$ROOT/bin/labwired"
bash -n "$ROOT/lib/cloud-session.sh"
ok "bash -n"

# AGENTS.md still forbids self-grading
if grep -q 'model_verified' "$ROOT/config/AGENTS.md" && grep -q 'labwired_verify' "$ROOT/config/AGENTS.md"; then
  ok "AGENTS.md oracle vocabulary"
else
  bad "AGENTS.md oracle vocabulary"
fi

if grep -q 'labwired_cloud_ensure_project' "$ROOT/lib/cloud-session.sh"; then
  ok "ensure_project helper"
else
  bad "missing labwired_cloud_ensure_project"
fi

if [[ "$fail" -ne 0 ]]; then
  echo "hosted-config FAIL"
  exit 1
fi
echo "hosted-config PASS"
