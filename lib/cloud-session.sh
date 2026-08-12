#!/usr/bin/env bash
# Cloud session for the hosted LabWired path (shared tools + model gateway).
#
# Tokens from device-code sign-in live under LABWIRED_HOME (default ~/.labwired):
#   $LABWIRED_HOME/session/cloud.json
#
# Env exported for opencode.hosted.json and the OpenAI-compatible gateway:
#   LABWIRED_ACCESS_TOKEN   lwd_… access token (Bearer)
#   LABWIRED_REFRESH_TOKEN  lwr_… refresh token
#   LABWIRED_PROJECT        project id (X-LabWired-Project)
#   LABWIRED_MODEL_URL      https://api.labwired.com/v1
#   LABWIRED_MODEL_KEY      same as access token
#   LABWIRED_MODEL          labwired-default
#   LABWIRED_API_URL        https://api.labwired.com
#
# shellcheck shell=bash

labwired_cloud_api_base() {
  echo "${LABWIRED_API_URL:-https://api.labwired.com}" | sed 's:/*$::'
}

labwired_cloud_session_dir() {
  local h
  if declare -F labwired_prefix_home >/dev/null 2>&1; then
    h="$(labwired_prefix_home)"
  else
    h="${LABWIRED_HOME:-$HOME/.labwired}"
  fi
  echo "${h%/}/session"
}

labwired_cloud_session_path() {
  echo "$(labwired_cloud_session_dir)/cloud.json"
}

# Write session JSON. Args: access refresh expires_in [project] [email]
labwired_cloud_session_save() {
  local access="$1" refresh="${2:-}" expires_in="${3:-3600}" project="${4:-}" email="${5:-}"
  local dir path now exp api
  dir="$(labwired_cloud_session_dir)"
  path="$(labwired_cloud_session_path)"
  api="$(labwired_cloud_api_base)"
  mkdir -p "$dir"
  chmod 700 "$dir" 2>/dev/null || true
  now="$(date +%s)"
  exp=$((now + expires_in))
  if ! command -v python3 >/dev/null 2>&1; then
    printf 'labwired: python3 required to save cloud session\n' >&2
    return 1
  fi
  ACCESS="$access" REFRESH="$refresh" EXP="$exp" PROJ="$project" EMAIL="$email" API_BASE="$api" \
    LABWIRED_SESSION_PATH="$path" python3 - <<'PY'
import json, os, time
from pathlib import Path
path = Path(os.environ["LABWIRED_SESSION_PATH"])
data = {
    "access_token": os.environ["ACCESS"],
    "refresh_token": os.environ.get("REFRESH") or None,
    "expires_at": int(os.environ["EXP"]),
    "project_id": os.environ.get("PROJ") or None,
    "email": os.environ.get("EMAIL") or None,
    "api_base": os.environ.get("API_BASE") or "https://api.labwired.com",
    "updated_at": int(time.time()),
}
path.write_text(json.dumps(data, indent=2) + "\n")
try:
    path.chmod(0o600)
except OSError:
    pass
print(str(path))
PY
}

labwired_cloud_session_clear() {
  rm -f "$(labwired_cloud_session_path)"
}

# Load session into env if present. Returns 0 if access token available.
# Auto-refreshes when expires_at is within 120s (or already past).
labwired_cloud_session_load() {
  local path
  path="$(labwired_cloud_session_path)"
  if [[ ! -f "$path" ]]; then
    return 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    return 1
  fi
  # shellcheck disable=SC1090
  eval "$(
    LABWIRED_SESSION_PATH="$path" python3 - <<'PY'
import json, os, sys, time, urllib.request, urllib.error
from pathlib import Path
path = Path(os.environ["LABWIRED_SESSION_PATH"])
try:
    data = json.loads(path.read_text())
except Exception:
    sys.exit(1)
access = data.get("access_token") or ""
if not access:
    sys.exit(1)

now = int(time.time())
exp = int(data.get("expires_at") or 0)
refresh = data.get("refresh_token") or ""
api = (data.get("api_base") or "https://api.labwired.com").rstrip("/")
# Refresh if expired or within 2 minutes of expiry
if refresh and (exp <= now + 120):
    try:
        body = json.dumps({"refresh_token": refresh, "grant_type": "refresh_token"}).encode()
        req = urllib.request.Request(
            api + "/v1/auth/refresh",
            data=body,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "labwired-agent/0.3.7",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=20) as r:
            j = json.loads(r.read().decode())
        access = j.get("access_token") or access
        if j.get("refresh_token"):
            refresh = j["refresh_token"]
        exp_in = int(j.get("expires_in") or 3600)
        exp = now + exp_in
        if j.get("email"):
            data["email"] = j["email"]
        data["access_token"] = access
        data["refresh_token"] = refresh
        data["expires_at"] = exp
        data["updated_at"] = now
        path.write_text(json.dumps(data, indent=2) + "\n")
        try:
            path.chmod(0o600)
        except OSError:
            pass
    except Exception:
        # If still expired after a failed refresh, force re-login (do not export a dead token).
        if exp <= now:
            sys.exit(1)
        # Else token still has a few minutes — keep it.
        pass

# Expired with no usable refresh outcome → re-login required.
if exp and exp <= now:
    sys.exit(1)

def sh(s):
    return "'" + str(s).replace("'", "'\"'\"'") + "'"

print("export LABWIRED_ACCESS_" + f"TOKEN={sh(access)}")
if refresh:
    print(f"export LABWIRED_REFRESH_TOKEN={sh(refresh)}")
if data.get("project_id"):
    print(f"export LABWIRED_PROJECT={sh(data['project_id'])}")
if data.get("email"):
    print(f"export LABWIRED_EMAIL={sh(data['email'])}")
print(f"export LABWIRED_API_URL={sh(api)}")
print(f"export LABWIRED_MODEL_URL={sh(api.rstrip('/') + '/v1')}")
print(f"export LABWIRED_MODEL_KEY={sh(access)}")
print("export LABWIRED_MODEL=labwired-default")
print(f"export LABWIRED_SESSION_EXPIRES_AT={int(exp or 0)}")
PY
  )" || return 1
  return 0
}

# The LabWired Editor desktop app signs in with the device-code flow and hands
# the agent its access token as LABWIRED_MODEL_KEY — it never runs `labwired
# login`, so there is no session file to find. The api.labwired.com desktop
# prefix (DESKTOP_ACCESS_TOKEN_PREFIX) is what makes this unambiguous: a bare
# LABWIRED_MODEL_KEY is also how local/airgap users point at their own model, so
# only the prefix may be read as "this is our hosted gateway".
labwired_cloud_desktop_token() {
  local key="${LABWIRED_MODEL_KEY:-}"
  [[ "$key" == lwd_* ]] || return 1
  echo "$key"
}


# Live check: token can list models AND initialize hosted MCP.
# Returns 0 only when both succeed (401/403 → re-login required).
labwired_cloud_probe_hosted() {
  local token="${LABWIRED_ACCESS_TOKEN:-}"
  local api proj
  api="$(labwired_cloud_api_base)"
  proj="${LABWIRED_PROJECT:-}"
  if [[ -z "$token" ]]; then
    labwired_cloud_session_load || return 1
    token="${LABWIRED_ACCESS_TOKEN:-}"
    proj="${LABWIRED_PROJECT:-$proj}"
  fi
  [[ -n "$token" ]] || return 1
  TOKEN="$token" API="$api" PROJ="$proj" python3 - <<'PROBE_PY' 2>/dev/null
import json, os, urllib.request
api = os.environ["API"].rstrip("/")
token = os.environ["TOKEN"]
proj = os.environ.get("PROJ") or ""
ua = "labwired-agent/0.3.9"
h = {
    "Authorization": f"Bearer {token}",
    "Accept": "application/json",
    "User-Agent": ua,
}
if proj:
    h["X-LabWired-Project"] = proj

def get(path):
    req = urllib.request.Request(f"{api}{path}", headers=h)
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.status

def post(path, body, extra=None):
    hh = dict(h)
    if extra:
        hh.update(extra)
    req = urllib.request.Request(
        f"{api}{path}",
        data=json.dumps(body).encode(),
        headers={**hh, "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status

try:
    if get("/v1/models") != 200:
        raise SystemExit(1)
    st = post(
        "/mcp",
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "labwired-doctor", "version": "0.3.9"},
            },
        },
        {"Accept": "application/json, text/event-stream"},
    )
    if st != 200:
        raise SystemExit(1)
except Exception:
    raise SystemExit(1)
raise SystemExit(0)
PROBE_PY
}

# True when we have a *usable* hosted credential (not merely a stale session file).
labwired_cloud_hosted_ready() {
  # Desktop lwd_ token is accepted without network (editor path).
  if labwired_cloud_desktop_token >/dev/null; then
    export LABWIRED_ACCESS_TOKEN="$(labwired_cloud_desktop_token)"
    if labwired_cloud_probe_hosted 2>/dev/null; then
      return 0
    fi
    # Offline / network blip with desktop token — allow start.
    return 0
  fi
  if [[ -n "${LABWIRED_ACCESS_TOKEN:-}" ]] || labwired_cloud_session_load; then
    labwired_cloud_probe_hosted && return 0
    return 1
  fi
  return 1
}

# If session has a token but no project_id, pick the first project from the API
# (or create "Desktop") and persist it. Login used to leave project empty when
# bootstrap failed silently — that breaks the model gateway (X-LabWired-Project).
labwired_cloud_ensure_project() {
  if [[ -n "${LABWIRED_PROJECT:-}" ]]; then
    return 0
  fi
  if [[ -z "${LABWIRED_ACCESS_TOKEN:-}" ]]; then
    return 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    return 1
  fi
  local api path proj
  api="$(labwired_cloud_api_base)"
  path="$(labwired_cloud_session_path)"
  proj="$(
    ACCESS="$LABWIRED_ACCESS_TOKEN" API="$api" SESSION_PATH="$path" python3 - <<'PY'
import json, os, urllib.request, urllib.error
from pathlib import Path
api = os.environ["API"].rstrip("/")
token = os.environ["ACCESS"]
h = {"Authorization": f"Bearer {token}", "Accept": "application/json", "User-Agent": "labwired-agent/0.3.1"}

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

proj = ""
try:
    data = get("/v1/projects")
    projects = data.get("projects") or data.get("items") or []
    if projects:
        p0 = projects[0]
        proj = p0.get("id") or p0.get("project_id") or ""
except Exception:
    pass
if not proj:
    try:
        created = post("/v1/projects", {"name": "Desktop"})
        p = created.get("project") or created
        proj = p.get("id") or p.get("project_id") or ""
    except Exception:
        proj = ""
if not proj:
    raise SystemExit(1)
# Persist into session JSON when present
sp = Path(os.environ.get("SESSION_PATH") or "")
if sp.is_file():
    try:
        d = json.loads(sp.read_text())
        d["project_id"] = proj
        sp.write_text(json.dumps(d, indent=2) + "\n")
    except Exception:
        pass
print(proj)
PY
  )" || return 1
  if [[ -z "$proj" ]]; then
    return 1
  fi
  export LABWIRED_PROJECT="$proj"
  return 0
}

# Export model + project env for both opencode and direct OpenAI-compat clients.
labwired_cloud_export_runtime() {
  if [[ -z "${LABWIRED_ACCESS_TOKEN:-}" ]]; then
    # A desktop token already IS the session; adopt it rather than demanding a
    # `labwired login` the editor has no way to perform. opencode.hosted.json
    # substitutes {env:LABWIRED_ACCESS_TOKEN} into the provider apiKey and the
    # remote MCP Authorization header, so leaving it unset sends empty bearers.
    LABWIRED_ACCESS_TOKEN="$(labwired_cloud_desktop_token || true)"
    export LABWIRED_ACCESS_TOKEN
  fi
  if [[ -z "${LABWIRED_ACCESS_TOKEN:-}" ]]; then
    labwired_cloud_session_load || return 1
  fi
  local api
  api="$(labwired_cloud_api_base)"
  export LABWIRED_API_URL="$api"
  export LABWIRED_MODEL_URL="${LABWIRED_MODEL_URL:-$api/v1}"
  export LABWIRED_MODEL_KEY="${LABWIRED_ACCESS_TOKEN}"
  export LABWIRED_MODEL="${LABWIRED_MODEL:-labwired-default}"
  export LABWIRED_PROJECT="${LABWIRED_PROJECT:-}"
  # Auto-heal empty project so gateway + MCP work after older logins
  if [[ -z "${LABWIRED_PROJECT:-}" ]]; then
    labwired_cloud_ensure_project || true
  fi
  return 0
}
