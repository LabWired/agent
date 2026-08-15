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
from urllib.parse import parse_qs, urlparse
cfg = json.loads(Path("$cfg").read_text())
mcp = cfg.get("mcp", {}).get("labwired", {})
assert mcp.get("type") == "remote", mcp
url = urlparse(mcp.get("url", ""))
assert f"{url.scheme}://{url.netloc}{url.path}" == "https://api.labwired.com/mcp", mcp
assert parse_qs(url.query).get("toolNames") == ["unprefixed"], mcp
# OpenCode exposes MCP names as <configured-server-key>_<wire-name>. The
# hosted profile strips the raw server prefix, so model-facing names remain
# canonical instead of becoming labwired_labwired_*.
raw_name = "labwired_context"
wire_name = raw_name.removeprefix("labwired_")
model_name = f"labwired_{wire_name}"
assert model_name == raw_name, model_name
assert not model_name.startswith("labwired_labwired_"), model_name
# Bearer header is the product auth path — do not open OpenCode MCP OAuth /connect.
assert mcp.get("oauth") is False, mcp
auth = (mcp.get("headers") or {}).get("Authorization", "")
assert "{env:LABWIRED_ACCESS_TOKEN}" in auth, auth
prov = cfg.get("provider", {}).get("labwired", {})
opts = prov.get("options") or {}
assert opts.get("baseURL") == "https://api.labwired.com/v1", opts
assert "{env:LABWIRED_ACCESS_TOKEN}" in str(opts.get("apiKey")), opts
headers = opts.get("headers") or {}
assert "{env:LABWIRED_PROJECT}" in str(headers.get("X-LabWired-Project", "")), headers
models = prov.get("models") or {}
assert sorted(models) == ["labwired-default"], models
assert cfg.get("model") == "labwired/labwired-default", cfg.get("model")
# Skills allowlist must include primary LabWired packs (legacy verify-firmware → prove)
skills = (cfg.get("permission") or {}).get("skill") or {}
for required in ("golden-path", "bringup", "prove", "observe", "desk-hw"):
    assert skills.get(required) == "allow", (required, skills)
# Agent description must point at golden-path / prove (oracle dispose)
desc = ((cfg.get("agent") or {}).get("build") or {}).get("description") or ""
assert cfg.get("default_agent") == "build", cfg.get("default_agent")
assert "golden-path" in desc.lower() or "prove" in desc.lower(), desc
assert "model_verified" in desc or "labwired_verify" in desc or "never invent" in desc.lower(), desc
print("ok   hosted config schema")
PY

# Hosted product surfaces expose one stable public model name. Provider/model
# implementation names must not leak back into hosted config or customization.
if rg -n -i 'labwired-fast|glm[ -]?5\.1' \
  "$ROOT/config/opencode.hosted.json" \
  "$ROOT/skills/customize-labwired-agent/SKILL.md" \
  "$ROOT/lib/cloud-session.sh" \
  "$ROOT/bin/labwired-agent" \
  "$ROOT/extensions/labwired-vscode/src/cli/cloudSession.ts"; then
  bad "removed hosted model names remain"
else
  ok "one hosted model vocabulary"
fi

# Session save/load round-trip
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export LABWIRED_HOME="$TMP"
labwired_cloud_session_save "lwd_test_access" "lwr_test_refresh" 7200 "proj_abc" "example@example.com" >/dev/null
labwired_cloud_session_load
[[ "$LABWIRED_ACCESS_TOKEN" == "lwd_test_access" ]] && ok "session load access" || bad "session load access"
[[ "$LABWIRED_PROJECT" == "proj_abc" ]] && ok "session load project" || bad "session load project"
[[ "$LABWIRED_MODEL_URL" == "https://api.labwired.com/v1" ]] && ok "model url" || bad "model url got $LABWIRED_MODEL_URL"
[[ "$LABWIRED_MODEL" == "labwired-default" ]] && ok "sole model export" || bad "model export got $LABWIRED_MODEL"
labwired_cloud_hosted_ready && ok "hosted ready" || bad "hosted ready"
labwired_cloud_session_clear
if [[ -f "$(labwired_cloud_session_path)" ]]; then bad "session clear"; else ok "session clear"; fi

# Hosted disclosure is stored under user state, shown once per version, and a
# failed acknowledgement write never blocks a hosted session.
export LABWIRED_HOSTED_DISCLOSURE_VERSION=1
export LABWIRED_AGENT_CONFIG_DIR="$TMP/agent-config"
first="$(labwired_cloud_hosted_disclosure)"
second="$(labwired_cloud_hosted_disclosure)"
[[ "$first" == *"Hosted conversations are stored by LabWired under the Privacy Policy."* \
  && "$first" == *"Customer content is not used for training by default."* ]] \
  && ok "first hosted disclosure" || bad "first hosted disclosure: $first"
marker_v1="$LABWIRED_AGENT_CONFIG_DIR/state/hosted-disclosure-v1"
[[ -f "$marker_v1" && ! -L "$marker_v1" ]] \
  && ok "trusted acknowledgement is a regular file" \
  || bad "acknowledgement is not a trusted regular file"
[[ -z "$second" ]] && ok "same disclosure version suppressed" || bad "same disclosure repeated: $second"
export LABWIRED_HOSTED_DISCLOSURE_VERSION=2
third="$(labwired_cloud_hosted_disclosure)"
[[ -n "$third" ]] && ok "new disclosure version shown" || bad "new disclosure version suppressed"
export LABWIRED_HOSTED_DISCLOSURE_VERSION=concurrent
for n in 1 2 3 4 5 6; do
  (labwired_cloud_hosted_disclosure >"$TMP/disclosure-$n") &
done
wait
shown="$(cat "$TMP"/disclosure-* | grep -c '^Hosted conversations' || true)"
[[ "$shown" -eq 1 ]] && ok "concurrent launches disclose once" || bad "concurrent launches disclosed $shown times"
mkdir -p "$LABWIRED_AGENT_CONFIG_DIR/state"
printf 'corrupt\n' >"$LABWIRED_AGENT_CONFIG_DIR/state/hosted-disclosure-vregular"
regular="$(LABWIRED_HOSTED_DISCLOSURE_VERSION=regular labwired_cloud_hosted_disclosure)"
[[ -n "$regular" ]] && ok "regular untrusted marker fails open" || bad "regular untrusted marker suppressed disclosure"
ln -s "hosted-disclosure-vregular" "$LABWIRED_AGENT_CONFIG_DIR/state/hosted-disclosure-vsymlink"
linked="$(LABWIRED_HOSTED_DISCLOSURE_VERSION=symlink labwired_cloud_hosted_disclosure)"
[[ -n "$linked" ]] && ok "symlink marker fails open" || bad "symlink marker suppressed disclosure"
symlink_config="$TMP/symlink-config"
mkdir -p "$symlink_config"
printf 'labwired-hosted-disclosure:state-link\n' >"$LABWIRED_AGENT_CONFIG_DIR/state/hosted-disclosure-vstate-link"
chmod 600 "$LABWIRED_AGENT_CONFIG_DIR/state/hosted-disclosure-vstate-link"
ln -s "$LABWIRED_AGENT_CONFIG_DIR/state" "$symlink_config/state"
linked_state="$(
  LABWIRED_AGENT_CONFIG_DIR="$symlink_config" \
  LABWIRED_HOSTED_DISCLOSURE_VERSION=state-link \
  labwired_cloud_hosted_disclosure
)"
[[ -n "$linked_state" ]] && ok "symlink state directory fails open" || bad "symlink state directory suppressed disclosure"
[[ -f "$LABWIRED_AGENT_CONFIG_DIR/state/hosted-disclosure-vstate-link" ]] \
  && ok "hostile valid marker left untouched" \
  || bad "hostile valid marker was overwritten"
ack="$(labwired_cloud_disclosure_ack_dir)"
[[ "$ack" == "$LABWIRED_AGENT_CONFIG_DIR/state" ]] \
  && ok "disclosure acknowledgement uses agent config" \
  || bad "disclosure acknowledgement path mismatch: $ack"
override_ack="$(OPENCODE_CONFIG_DIR="$TMP/opencode-override" labwired_cloud_disclosure_ack_dir)"
[[ "$override_ack" == "$TMP/opencode-override/state" ]] \
  && ok "explicit OpenCode config override accepted" \
  || bad "OpenCode config override ignored: $override_ack"
default_ack="$(
  unset OPENCODE_CONFIG_DIR LABWIRED_AGENT_CONFIG_DIR
  HOME="$TMP/default-home" XDG_CONFIG_HOME="$TMP/xdg" labwired_cloud_disclosure_ack_dir
)"
[[ "$default_ack" == "$TMP/xdg/labwired-agent/state" ]] \
  && ok "XDG agent config default" \
  || bad "XDG agent config path mismatch: $default_ack"

readonly_home="$TMP/read-only-home"
mkdir -p "$readonly_home"
chmod 500 "$readonly_home"
fallback="$(
  LABWIRED_AGENT_CONFIG_DIR="$readonly_home/missing" \
  LABWIRED_HOSTED_DISCLOSURE_VERSION=3 \
  labwired_cloud_hosted_disclosure
)"
[[ -n "$fallback" ]] && ok "acknowledgement failure does not block disclosure" || bad "acknowledgement failure hid disclosure"
chmod 700 "$readonly_home"

# CLI surfaces
if grep -q 'cmd_login' "$ROOT/bin/labwired-agent" && grep -q 'labwired_prepare_agent_start' "$ROOT/bin/labwired-agent"; then
  ok "bin/labwired-agent login + prepare"
else
  bad "bin/labwired-agent missing hosted commands"
fi
if grep -q 'labwired_ensure_account' "$ROOT/bin/labwired-agent" \
  && grep -q 'cmd_auth' "$ROOT/bin/labwired-agent" \
  && ! grep -q 'labwired_sync_opencode_auth' "$ROOT/bin/labwired-agent"; then
  ok "bin/labwired-agent first-start account login (no engine auth seed)"
else
  bad "bin/labwired-agent missing LabWired account-first auth path"
fi
bash -n "$ROOT/bin/labwired"
bash -n "$ROOT/bin/labwired-agent"
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
