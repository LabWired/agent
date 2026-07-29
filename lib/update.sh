#!/usr/bin/env bash
# update.sh — self-update LabWired Agent (Cursor: `agent update`)
# shellcheck shell=bash
#
# Updates:
#   1) agent kit (git fetch if available, else re-clone)
#   2) runtime tools in prefix (sim, probe-rs, pio)
#   3) OpenCode pin + skills/config via install.sh
#
# Env:
#   LABWIRED_AGENT_REPO   default https://github.com/LabWired/agent.git
#   LABWIRED_AGENT_REF    default main
#   LABWIRED_UPDATE_CHANNEL  stable|main  (reserved)
#   LABWIRED_UPDATE_TOOLS_ONLY=1  skip kit reinstall, only tools

labwired_update_say() { printf '\033[36m==>\033[0m %s\n' "$1"; }
labwired_update_warn() { printf '\033[33mwarn:\033[0m %s\n' "$1" >&2; }
labwired_update_ok() { printf '\033[32mok \033[0m %s\n' "$1"; }

labwired_update_kit_git() {
  local agent_home repo ref
  agent_home="$(labwired_prefix_agent)"
  repo="${LABWIRED_AGENT_REPO:-https://github.com/LabWired/agent.git}"
  ref="${LABWIRED_AGENT_REF:-main}"

  if [[ -d "$agent_home/.git" ]]; then
    labwired_update_say "updating agent kit (git $ref)"
    git -C "$agent_home" remote set-url origin "$repo" 2>/dev/null || true
    git -C "$agent_home" fetch --depth 1 origin "$ref"
    git -C "$agent_home" checkout -q FETCH_HEAD
    labwired_update_ok "kit → $(tr -d '[:space:]' <"$agent_home/VERSION" 2>/dev/null || echo unknown)"
    return 0
  fi

  if ! command -v git >/dev/null 2>&1; then
    labwired_update_warn "git missing — cannot pull kit; re-run curl install"
    return 1
  fi

  labwired_update_say "cloning agent kit (fresh)"
  local parent tmp
  parent="$(dirname "$agent_home")"
  mkdir -p "$parent"
  tmp="${agent_home}.update-tmp.$$"
  rm -rf "$tmp"
  if git clone --depth 1 --branch "$ref" "$repo" "$tmp" \
    || git clone --depth 1 "$repo" "$tmp"; then
    # Preserve tools/ outside agent; only replace agent/
    rm -rf "$agent_home"
    mv "$tmp" "$agent_home"
    labwired_update_ok "kit cloned"
    return 0
  fi
  rm -rf "$tmp"
  return 1
}

# Re-run installer from kit to refresh shims, skills, tools.
labwired_update_reinstall() {
  local agent_home installer
  agent_home="$(labwired_prefix_agent)"
  installer="$agent_home/install.sh"
  if [[ ! -f "$installer" ]]; then
    labwired_update_warn "install.sh missing in $agent_home"
    return 1
  fi
  labwired_update_say "re-running installer (full stack into prefix)"
  export LABWIRED_HOME="$(labwired_prefix_home)"
  export LABWIRED_AGENT_HOME="$agent_home"
  bash "$installer" --full
}

labwired_update_tools_only() {
  # shellcheck source=lib/install-deps.sh
  source "$(labwired_prefix_agent)/lib/install-deps.sh" 2>/dev/null \
    || source "${LABWIRED_AGENT_HOME:-}/lib/install-deps.sh" 2>/dev/null \
    || return 1
  export LABWIRED_MINIMAL=0
  export LABWIRED_INSTALL_SIM=1
  export LABWIRED_INSTALL_PROBE_RS=1
  export LABWIRED_INSTALL_PIO=1
  labwired_prefix_ensure_dirs
  labwired_install_full_deps
  labwired_prefix_write_manifest
  labwired_prefix_link_user_shim
  labwired_prefix_write_env
}

# Main entry used by `labwired update`
labwired_cmd_update() {
  local tools_only=0
  local check_only=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --tools-only) tools_only=1; shift ;;
      --check) check_only=1; shift ;;
      -h|--help)
        cat <<'EOF'
labwired update — self-update (like Cursor `agent update`)

  labwired update              Update kit + tools + config
  labwired update --tools-only Refresh sim/probe/pio only
  labwired update --check      Print versions; no changes

Env:
  LABWIRED_AGENT_REF=main|v0.2.2   pin kit ref
  LABWIRED_CORE_VERSION=v0.21.0    pin sim release
EOF
        return 0
        ;;
      *)
        echo "labwired update: unknown option $1" >&2
        return 2
        ;;
    esac
  done

  labwired_update_say "LabWired self-update"
  labwired_update_say "prefix=$(labwired_prefix_home) platform=$(labwired_prefix_platform)"

  if [[ "$check_only" == "1" ]]; then
    echo "agent:  $(tr -d '[:space:]' <"$(labwired_prefix_agent)/VERSION" 2>/dev/null || echo missing)"
    if [[ -x "$(labwired_prefix_home)/tools/sim/labwired-sim" ]]; then
      echo "sim:    $("$(labwired_prefix_home)/tools/sim/labwired-sim" --version 2>/dev/null | head -1)"
    else
      echo "sim:    (missing)"
    fi
    if [[ -x "$(labwired_prefix_home)/tools/probe-rs/probe-rs" ]]; then
      echo "probe:  $("$(labwired_prefix_home)/tools/probe-rs/probe-rs" --version 2>/dev/null | head -1)"
    else
      echo "probe:  (missing)"
    fi
    [[ -f "$(labwired_prefix_manifest)" ]] && cat "$(labwired_prefix_manifest)"
    return 0
  fi

  if [[ "${LABWIRED_UPDATE_TOOLS_ONLY:-0}" == "1" || "$tools_only" == "1" ]]; then
    labwired_update_tools_only || return 1
    labwired_update_ok "tools updated"
    return 0
  fi

  labwired_update_kit_git || labwired_update_warn "kit git update failed — continuing with reinstall if present"
  labwired_update_reinstall || {
    labwired_update_warn "full reinstall failed — trying tools only"
    labwired_update_tools_only || return 1
  }
  labwired_update_ok "update complete"
  echo
  echo "  labwired doctor --strict"
  echo "  labwired version"
}
