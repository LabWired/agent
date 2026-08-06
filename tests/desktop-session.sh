#!/usr/bin/env bash
# The LabWired Editor desktop app is a *first-class hosted client*, but it never
# runs `labwired login`, so it has no ~/.labwired session file.
#
# The contract asserted here is derived from the two systems OUTSIDE this repo:
#
#   1. labwired-editor: src/vs/workbench/contrib/void/common/labwiredAgentRuntimePolicy.ts
#      spawns the agent with exactly {LABWIRED_MODEL_KEY, LABWIRED_PROJECT,
#      LABWIRED_MODEL, LABWIRED_MODEL_URL, LABWIRED_EDITOR, LABWIRED_MODE} and
#      deliberately strips everything else. LABWIRED_ACCESS_TOKEN is NOT in that set.
#   2. labwired/packages/api: DESKTOP_ACCESS_TOKEN_PREFIX = 'lwd_' — a key with
#      that prefix is, by construction, an api.labwired.com desktop access token.
#
# If hosted mode does not light up under that env, the desktop app silently runs
# the LOCAL profile: no LabWired Agent persona, no skill permission allowlist, no
# labwired-fast, and opencode.hosted.json never applied. The app still "works",
# which is why this went unnoticed — hence a test rather than a doc note.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

fail=0
bad() { echo "FAIL $1"; fail=1; }
ok() { echo "ok   $1"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Every case runs in its own shell so exported state cannot leak between them,
# and with LABWIRED_HOME isolated so a real developer session is never consulted.
probe() {
	env -i PATH="$PATH" HOME="$TMP/home" LABWIRED_HOME="$TMP/home/.labwired" \
		ROOT="$ROOT" "$@" bash -c '
		source "$ROOT/lib/cloud-session.sh"
		if labwired_cloud_hosted_ready; then mode=hosted; else mode=local; fi
		echo "mode=$mode"
		if [[ "$mode" == "hosted" ]]; then
			if labwired_cloud_export_runtime; then
				echo "runtime=ok"
				echo "access=${LABWIRED_ACCESS_TOKEN:-}"
				echo "modelurl=${LABWIRED_MODEL_URL:-}"
				echo "project=${LABWIRED_PROJECT:-}"
			else
				echo "runtime=failed"
			fi
		fi
	'
}

# ── 1. The desktop app, signed in via device code ────────────────────────────
out="$(probe \
	LABWIRED_MODEL_KEY="lwd_desktoptoken" \
	LABWIRED_PROJECT="proj_desktop" \
	LABWIRED_MODEL="labwired-default" \
	LABWIRED_MODEL_URL="https://api.labwired.com/v1" \
	LABWIRED_EDITOR=1 \
	LABWIRED_MODE=agent)"

grep -q '^mode=hosted$' <<<"$out" \
	&& ok "desktop device token selects the hosted profile" \
	|| bad "desktop device token fell through to the LOCAL profile: $out"

grep -q '^runtime=ok$' <<<"$out" \
	&& ok "hosted runtime exports without a login session" \
	|| bad "hosted runtime refused a desktop-only session: $out"

# opencode.hosted.json substitutes {env:LABWIRED_ACCESS_TOKEN} into BOTH the
# provider apiKey and the remote MCP Authorization header. Unset means opencode
# writes an empty bearer and every call 401s.
grep -q '^access=lwd_desktoptoken$' <<<"$out" \
	&& ok "LABWIRED_ACCESS_TOKEN resolved for {env:} substitution" \
	|| bad "LABWIRED_ACCESS_TOKEN empty — hosted config would send an empty bearer: $out"

# The editor pins its own gateway origin; the agent must not overwrite it.
grep -q '^modelurl=https://api.labwired.com/v1$' <<<"$out" \
	&& ok "editor-pinned model URL preserved" \
	|| bad "model URL was rewritten: $out"

grep -q '^project=proj_desktop$' <<<"$out" \
	&& ok "editor-supplied project preserved" \
	|| bad "project was lost — the gateway rejects chat without it: $out"

# ── 2. A local/airgap model key must NOT be hijacked into hosted mode ────────
# config/opencode.json (local flavour) also reads {env:LABWIRED_MODEL_KEY}, so
# "any model key means hosted" would silently repoint self-hosted users at us.
out="$(probe \
	LABWIRED_MODEL_KEY="sk-local-deadbeef" \
	LABWIRED_MODEL_URL="http://127.0.0.1:8080/v1")"

grep -q '^mode=local$' <<<"$out" \
	&& ok "non-LabWired model key stays on the local profile" \
	|| bad "a local model key was hijacked into hosted mode: $out"

# ── 3. No credentials at all stays local ─────────────────────────────────────
out="$(probe)"
grep -q '^mode=local$' <<<"$out" \
	&& ok "no credentials stays on the local profile" \
	|| bad "hosted mode claimed without any credential: $out"

# ── 4. End to end: the config the desktop app actually ends up running ───────
# The flags above are means, not the end. Drive the real CLI with a stub
# `opencode` and assert what landed in OPENCODE_CONFIG_DIR — persona, skill
# permissions and both SKUs are exactly what the LOCAL profile silently drops.
SB="$TMP/e2e"
mkdir -p "$SB/bin" "$SB/home/.config/opencode"
printf '#!/bin/sh\nexit 0\n' >"$SB/bin/opencode"
chmod +x "$SB/bin/opencode"

if env -i PATH="$SB/bin:/usr/bin:/bin" HOME="$SB/home" \
	LABWIRED_HOME="$SB/home/.labwired" \
	OPENCODE_CONFIG_DIR="$SB/home/.config/opencode" \
	LABWIRED_MODEL_KEY="lwd_desktoptoken" \
	LABWIRED_PROJECT="proj_desktop" \
	LABWIRED_MODEL="labwired-default" \
	LABWIRED_MODEL_URL="https://api.labwired.com/v1" \
	LABWIRED_EDITOR=1 LABWIRED_MODE=agent \
	bash "$ROOT/bin/labwired" agent >/dev/null 2>&1; then
	CONFIG="$SB/home/.config/opencode/opencode.json" python3 - <<'PY' && ok "desktop app lands on the full hosted config" || bad "desktop app landed on a degraded config"
import json, os, sys
cfg = json.load(open(os.environ["CONFIG"]))
provider = cfg.get("provider", {}).get("labwired", {})
problems = []
if sorted(provider.get("models", {})) != ["labwired-default", "labwired-fast"]:
    problems.append(f"models={sorted(provider.get('models', {}))}")
if cfg.get("default_agent") != "labwired":
    problems.append(f"default_agent={cfg.get('default_agent')}")
if "labwired" not in cfg.get("agent", {}):
    problems.append("no LabWired Agent persona")
if not cfg.get("permission", {}).get("skill"):
    problems.append("no skill permission allowlist")
if cfg.get("mcp", {}).get("labwired", {}).get("type") != "remote":
    problems.append("MCP is not the hosted remote endpoint")
if problems:
    print("  " + "; ".join(problems), file=sys.stderr)
    sys.exit(1)
PY
else
	bad "the real CLI failed to start under desktop env"
fi

if [[ "$fail" -ne 0 ]]; then
	echo "desktop-session: FAILED"
	exit 1
fi
echo "desktop-session: PASS"
