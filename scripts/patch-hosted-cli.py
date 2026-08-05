#!/usr/bin/env python3
"""One-shot patch: wire hosted login into bin/labwired."""
from pathlib import Path

p = Path(__file__).resolve().parents[1] / "bin" / "labwired"
text = p.read_text()

old = """# shellcheck source=lib/probe.sh
source \"$ROOT/lib/probe.sh\"
"""
new = """# shellcheck source=lib/probe.sh
source \"$ROOT/lib/probe.sh\"
# shellcheck source=lib/cloud-session.sh
source \"$ROOT/lib/cloud-session.sh\"
"""
if old not in text:
    raise SystemExit("anchor for cloud-session missing")
text = text.replace(old, new, 1)

login_block = r'''
# ── Hosted path: shared MCP tools + model gateway ───────────────────────────

cmd_login() {
  local api code_json device_code user_code uri interval expires_in
  local poll_status access refresh expires project email path
  local status err_msg
  api="$(labwired_cloud_api_base)"
  say "starting device sign-in against $api"
  if ! command -v python3 >/dev/null 2>&1; then
    fail "python3 required for labwired login"
  fi
  code_json="$(
    python3 - <<PY
import json, urllib.request
req = urllib.request.Request(
    "$api/v1/auth/device/code",
    data=b"{}",
    headers={"Content-Type": "application/json", "Accept": "application/json"},
    method="POST",
)
with urllib.request.urlopen(req, timeout=30) as r:
    print(r.read().decode())
PY
  )" || fail "device/code request failed — is $api reachable?"
  eval "$(
    CODE_JSON="$code_json" python3 - <<'PY'
import json, os
d = json.loads(os.environ["CODE_JSON"])
def sh(s):
    return "'" + str(s).replace("'", "'\"'\"'") + "'"
print(f"device_code={sh(d['deviceCode'])}")
print(f"user_code={sh(d['userCode'])}")
print(f"uri={sh(d.get('verificationUriComplete') or d.get('verificationUri') or '')}")
print(f"interval={int(d.get('interval') or 2)}")
print(f"expires_in={int(d.get('expiresIn') or 900)}")
PY
  )"
  brand ""
  brand "  Open:  $uri"
  brand "  Code:  $user_code"
  brand ""
  say "waiting for approval (poll every ${interval}s)…"
  if command -v open >/dev/null 2>&1 && [[ -n "$uri" ]]; then
    open "$uri" 2>/dev/null || true
  fi
  local deadline now
  now="$(date +%s)"
  deadline=$((now + expires_in))
  while true; do
    now="$(date +%s)"
    if (( now > deadline )); then
      fail "device code expired — run labwired login again"
    fi
    poll_status="$(
      DEVICE_CODE="$device_code" API="$api" python3 - <<'PY'
import json, os, urllib.request, urllib.error
api = os.environ["API"]
body = json.dumps({
    "deviceCode": os.environ["DEVICE_CODE"],
    "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
}).encode()
req = urllib.request.Request(
    f"{api}/v1/auth/device/token",
    data=body,
    headers={"Content-Type": "application/json", "Accept": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        print(r.read().decode())
except urllib.error.HTTPError as e:
    print(e.read().decode())
PY
    )"
    eval "$(
      POLL_JSON="$poll_status" python3 - <<'PY'
import json, os, sys
raw = os.environ["POLL_JSON"]
try:
    d = json.loads(raw)
except Exception:
    print("status=error")
    sys.exit(0)
def sh(s):
    return "'" + str(s).replace("'", "'\"'\"'") + "'"
err = d.get("error")
if err == "authorization_pending" or (isinstance(err, dict) and err.get("code") == "authorization_pending"):
    print("status=pending")
elif err in ("expired_token", "access_denied") or (isinstance(err, dict) and err.get("code") in ("expired_token", "access_denied")):
    code = err if isinstance(err, str) else err.get("code")
    print(f"status={code}")
elif d.get("access_token"):
    print("status=approved")
    print(f"access={sh(d['access_token'])}")
    print(f"refresh={sh(d.get('refresh_token') or '')}")
    print(f"expires={int(d.get('expires_in') or 3600)}")
    print(f"email={sh(d.get('email') or '')}")
else:
    print("status=error")
    msg = d.get("error_description") or d.get("error") or raw[:200]
    print(f"err_msg={sh(msg)}")
PY
    )"
    case "${status:-}" in
      pending)
        sleep "$interval"
        continue
        ;;
      approved)
        break
        ;;
      expired|expired_token)
        fail "device code expired — run labwired login again"
        ;;
      denied|access_denied)
        fail "sign-in denied in browser"
        ;;
      *)
        fail "token poll failed: ${err_msg:-unknown}"
        ;;
    esac
  done

  project="$(
    ACCESS="$access" API="$api" python3 - <<'PY'
import json, os, urllib.request, urllib.error
api = os.environ["API"]
token = os.environ["ACCESS"]
h = {"Authorization": f"Bearer {token}", "Accept": "application/json"}

def get(path):
    req = urllib.request.Request(f"{api}{path}", headers=h)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())

def post(path, body):
    req = urllib.request.Request(
        f"{api}{path}",
        data=json.dumps(body).encode(),
        headers={**h, "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())

try:
    data = get("/v1/projects")
    projects = data.get("projects") or data.get("items") or []
    if projects:
        p0 = projects[0]
        print(p0.get("id") or p0.get("project_id") or "")
        raise SystemExit(0)
except Exception:
    pass
try:
    created = post("/v1/projects", {"name": "Desktop"})
    p = created.get("project") or created
    print(p.get("id") or p.get("project_id") or "")
except Exception:
    print("", end="")
PY
  )"

  path="$(labwired_cloud_session_save "$access" "$refresh" "$expires" "$project" "$email")"
  say "signed in${email:+ as $email}"
  if [[ -n "$project" ]]; then
    say "project: $project"
  else
    echo "labwired: warning — no project id yet; set LABWIRED_PROJECT before chatting" >&2
  fi
  say "session: $path"
  say "start with: labwired"
  labwired_install_hosted_opencode_config || true
}

labwired_install_hosted_opencode_config() {
  local cfg_dir src
  cfg_dir="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
  src="$ROOT/config/opencode.hosted.json"
  if [[ ! -f "$src" ]]; then
    return 1
  fi
  mkdir -p "$cfg_dir/skills"
  cp "$src" "$cfg_dir/opencode.json"
  if [[ -f "$ROOT/config/AGENTS.md" ]]; then
    cp "$ROOT/config/AGENTS.md" "$cfg_dir/AGENTS.md"
  fi
  if [[ -d "$ROOT/skills" ]]; then
    cp -R "$ROOT/skills/." "$cfg_dir/skills/"
  fi
  say "OpenCode config: hosted (remote MCP + api.labwired.com/v1) → $cfg_dir/opencode.json"
}

cmd_logout() {
  if [[ -z "${LABWIRED_ACCESS_TOKEN:-}" ]]; then
    labwired_cloud_session_load 2>/dev/null || true
  fi
  if [[ -n "${LABWIRED_ACCESS_TOKEN:-}" ]]; then
    API="$(labwired_cloud_api_base)" ACCESS="${LABWIRED_ACCESS_TOKEN}" REFRESH="${LABWIRED_REFRESH_TOKEN:-}" python3 - <<'PY' 2>/dev/null || true
import json, os, urllib.request
api = os.environ["API"]
token = os.environ["ACCESS"]
body = {}
if os.environ.get("REFRESH"):
    body["refresh_token"] = os.environ["REFRESH"]
req = urllib.request.Request(
    f"{api}/v1/auth/revoke",
    data=json.dumps(body).encode(),
    headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    },
    method="POST",
)
try:
    urllib.request.urlopen(req, timeout=15)
except Exception:
    pass
PY
  fi
  labwired_cloud_session_clear
  say "signed out (local session cleared)"
}

cmd_whoami() {
  if ! labwired_cloud_session_load && [[ -z "${LABWIRED_ACCESS_TOKEN:-}" ]]; then
    echo "not signed in — run: labwired login"
    return 1
  fi
  echo "api:      $(labwired_cloud_api_base)"
  echo "email:    ${LABWIRED_EMAIL:-(unknown)}"
  echo "project:  ${LABWIRED_PROJECT:-(none — set LABWIRED_PROJECT)}"
  echo "token:    ${LABWIRED_ACCESS_TOKEN:0:8}…"
  echo "model:    ${LABWIRED_MODEL_URL:-}/  model=${LABWIRED_MODEL:-labwired-default}"
  echo "mcp:      remote https://api.labwired.com/mcp (shared labwired_* tools)"
}

labwired_prepare_agent_start() {
  if labwired_cloud_hosted_ready; then
    labwired_cloud_export_runtime || fail "hosted session incomplete — run: labwired login"
    if [[ -z "${LABWIRED_PROJECT:-}" ]]; then
      echo "labwired: warning — LABWIRED_PROJECT empty; model gateway will reject chat" >&2
    fi
    local cfg_dir cfg_file
    cfg_dir="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
    cfg_file="$cfg_dir/opencode.json"
    if [[ -f "$ROOT/config/opencode.hosted.json" ]]; then
      if [[ ! -f "$cfg_file" ]] || ! grep -q 'api.labwired.com/mcp' "$cfg_file" 2>/dev/null; then
        labwired_install_hosted_opencode_config || true
      fi
    fi
    export LABWIRED_PROFILE=hosted
    say "mode: hosted (shared tools + knowledge at api.labwired.com)"
  else
    labwired_export_sim || true
  fi
}

'''

anchor = "cmd_help() {"
if anchor not in text:
    raise SystemExit("cmd_help missing")
text = text.replace(anchor, login_block + anchor, 1)

# help text
if "labwired login" not in text:
    text = text.replace(
        "  labwired doctor          Check install\n",
        "  labwired login           Device-code sign-in (hosted tools + model)\n"
        "  labwired logout          Clear local cloud session\n"
        "  labwired whoami          Show signed-in identity\n"
        "  labwired doctor          Check install\n",
        1,
    )
    text = text.replace(
        "  LABWIRED_MODEL_URL       Model base URL (default Ollama)\n",
        "  LABWIRED_ACCESS_TOKEN    Hosted Bearer (from labwired login)\n"
        "  LABWIRED_PROJECT         Project id (X-LabWired-Project)\n"
        "  LABWIRED_MODEL_URL       Model base URL (hosted: api.labwired.com/v1)\n",
        1,
    )

case_old = '  doctor)  shift; cmd_doctor "$@" ;;'
case_new = '''  login)   shift; cmd_login "$@" ;;
  logout)  shift; cmd_logout "$@" ;;
  whoami)  shift; cmd_whoami "$@" ;;
  doctor)  shift; cmd_doctor "$@" ;;'''
if case_old not in text:
    raise SystemExit("doctor case missing")
text = text.replace(case_old, case_new, 1)

old_start = '''  "")
    # Ensure prefix tools visible for this session
    if [[ -n "${LABWIRED_HOME:-}" && -d "${LABWIRED_HOME}/bin" ]]; then
      export PATH="${LABWIRED_HOME}/bin:${PATH}"
    fi
    if ! command -v opencode >/dev/null 2>&1; then
      fail "'opencode' not found. Install Node 18+, then re-run: curl -fsSL https://labwired.com/install | bash"
    fi
    if labwired_export_sim; then
      :
    else
      echo "labwired: note — no local sim; hosted MCP verify still works." >&2
      echo "         fix: labwired update --tools-only" >&2
    fi
    echo "labwired: starting agent (skills + MCP)…" >&2
    exec opencode "$@"
    ;;
'''
new_start = '''  "")
    # Ensure prefix tools visible for this session
    if [[ -n "${LABWIRED_HOME:-}" && -d "${LABWIRED_HOME}/bin" ]]; then
      export PATH="${LABWIRED_HOME}/bin:${PATH}"
    fi
    if ! command -v opencode >/dev/null 2>&1; then
      fail "'opencode' not found. Install Node 18+, then re-run: curl -fsSL https://labwired.com/install | bash"
    fi
    labwired_prepare_agent_start
    if [[ "${LABWIRED_PROFILE:-}" != "hosted" ]]; then
      if labwired_export_sim; then
        :
      else
        echo "labwired: note — no local sim; run labwired login for hosted twin tools," >&2
        echo "         or: labwired update --tools-only" >&2
      fi
    fi
    echo "labwired: starting agent (skills + shared labwired_* tools)…" >&2
    exec opencode "$@"
    ;;
'''
if old_start not in text:
    raise SystemExit("empty start block missing")
text = text.replace(old_start, new_start, 1)

old_doc = """cmd_doctor() {
  local ok=0
"""
new_doc = """cmd_doctor() {
  local ok=0
  if labwired_cloud_session_load 2>/dev/null || [[ -n \"${LABWIRED_ACCESS_TOKEN:-}\" ]]; then
    say \"ok  cloud-session: signed in (${LABWIRED_EMAIL:-token present})\"
    if [[ -n \"${LABWIRED_PROJECT:-}\" ]]; then
      say \"ok  project: $LABWIRED_PROJECT\"
    else
      printf '\\033[33mwarn\\033[0m project: unset — model gateway needs LABWIRED_PROJECT\\n'
    fi
    say \"ok  hosted-tools: api.labwired.com/mcp (shared labwired_*)\"
  else
    say \"ok  cloud-session: not signed in (local tools only — labwired login for hosted)\"
  fi
"""
if old_doc in text:
    text = text.replace(old_doc, new_doc, 1)

p.write_text(text)
print("patched", p, "lines", text.count("\n") + 1)
