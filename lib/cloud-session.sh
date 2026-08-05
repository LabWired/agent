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
import json, os, sys
from pathlib import Path
path = Path(os.environ["LABWIRED_SESSION_PATH"])
try:
    data = json.loads(path.read_text())
except Exception:
    sys.exit(1)
access = data.get("access_token") or ""
if not access:
    sys.exit(1)

def sh(s):
    return "'" + str(s).replace("'", "'\"'\"'") + "'"

print(f"export LABWIRED_ACCESS_TOKEN={sh(access)}")
if data.get("refresh_token"):
    print(f"export LABWIRED_REFRESH_TOKEN={sh(data['refresh_token'])}")
if data.get("project_id"):
    print(f"export LABWIRED_PROJECT={sh(data['project_id'])}")
if data.get("email"):
    print(f"export LABWIRED_EMAIL={sh(data['email'])}")
api = data.get("api_base") or "https://api.labwired.com"
print(f"export LABWIRED_API_URL={sh(api)}")
print(f"export LABWIRED_MODEL_URL={sh(api.rstrip('/') + '/v1')}")
print(f"export LABWIRED_MODEL_KEY={sh(access)}")
print("export LABWIRED_MODEL=labwired-default")
print(f"export LABWIRED_SESSION_EXPIRES_AT={int(data.get('expires_at') or 0)}")
PY
  )" || return 1
  return 0
}

# True when we should run the hosted opencode profile (shared remote MCP tools).
labwired_cloud_hosted_ready() {
  if [[ "${LABWIRED_PROFILE:-}" == "hosted" ]]; then
    return 0
  fi
  if [[ -n "${LABWIRED_ACCESS_TOKEN:-}" ]]; then
    return 0
  fi
  if [[ -f "$(labwired_cloud_session_path)" ]]; then
    return 0
  fi
  return 1
}

# Export model + project env for both opencode and direct OpenAI-compat clients.
labwired_cloud_export_runtime() {
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
  return 0
}
