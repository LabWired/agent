#!/usr/bin/env bash
# LabWired Agent installer
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
CFG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
BIN_DIR="${LABWIRED_BIN_DIR:-$HOME/.local/bin}"
OPENCODE_PIN="${OPENCODE_PIN:-1.18.7}"

# shellcheck source=lib/prefix.sh
source "$SRC/lib/prefix.sh"
# shellcheck source=lib/resolve-mcp.sh
source "$SRC/lib/resolve-mcp.sh"
# shellcheck source=lib/resolve-sim.sh
source "$SRC/lib/resolve-sim.sh"
# shellcheck source=lib/resolve-probe.sh
source "$SRC/lib/resolve-probe.sh"
# shellcheck source=lib/install-deps.sh
source "$SRC/lib/install-deps.sh"

say() { printf '\033[36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[33mwarn:\033[0m %s\n' "$1" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

# Default: hosted Agent only under LABWIRED_HOME (default ~/.labwired).
PROFILE="${LABWIRED_PROFILE:-hosted}"
export LABWIRED_INSTALL_SIM="${LABWIRED_INSTALL_SIM:-0}"
export LABWIRED_INSTALL_PROBE_RS="${LABWIRED_INSTALL_PROBE_RS:-0}"
export LABWIRED_INSTALL_PIO="${LABWIRED_INSTALL_PIO:-0}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --airgap)
      PROFILE=airgap
      shift
      ;;
    --hosted)
      PROFILE=hosted
      shift
      ;;
    --agent-only|--minimal)
      export LABWIRED_MINIMAL=1
      export LABWIRED_INSTALL_SIM=0
      export LABWIRED_INSTALL_PROBE_RS=0
      export LABWIRED_INSTALL_PIO=0
      shift
      ;;
    --with-core-tools|--full)
      export LABWIRED_MINIMAL=0
      export LABWIRED_INSTALL_SIM=1
      export LABWIRED_INSTALL_PROBE_RS=1
      # PIO stays off unless --with-pio (keeps one-liner fast)
      export LABWIRED_INSTALL_PIO="${LABWIRED_INSTALL_PIO:-0}"
      shift
      ;;
    --with-pio|--pio)
      export LABWIRED_INSTALL_PIO=1
      shift
      ;;
    --quick|--fast)
      export LABWIRED_FAST=1
      export LABWIRED_INSTALL_PIO=0
      shift
      ;;
    --prefix)
      export LABWIRED_HOME="${2:?--prefix requires a path}"
      shift 2
      ;;
    --prefix=*)
      export LABWIRED_HOME="${1#--prefix=}"
      shift
      ;;
    -h|--help)
      cat <<'USAGE'
Usage: ./install.sh [--agent-only] [--with-core-tools] [--airgap] [--prefix DIR]

Portable, contained install (multi-platform):

  Everything lives under one prefix (LABWIRED_HOME, default ~/.labwired):

    $LABWIRED_HOME/
      agent/          kit (skills, lib, launcher)
      components/core/ preserved LabWired Core (when already installed)
      tools/pio/      optional PlatformIO venv
      bin/            shims (put this OR the thin user shim on PATH)
      env.sh          source to activate
      MANIFEST.json   versions + platform

  Default / --agent-only  Hosted LabWired Agent only
  --with-core-tools  Development install with simulator + probe-rs
  --with-pio         Also install PlatformIO (slower)
  --minimal          Agent kit only
  --airgap           Vendored MCP / LABWIRED_MCP_ENTRY
  --hosted           Remote MCP + api.labwired.com model (labwired login)
  --prefix DIR       Portable root (USB, CI, /opt/labwired)

  curl -fsSL https://labwired.com/install/agent | bash
  irm 'https://labwired.com/install?win32=true' | iex   # Windows
  npx @labwired/agent

  After install:  labwired smoke && labwired

Env:
  LABWIRED_HOME  LABWIRED_BIN_DIR  LABWIRED_INSTALL_PIO=1  LABWIRED_FAST=0
  LABWIRED_CORE_VERSION=vX.Y
USAGE
      exit 0
      ;;
    *)
      die "unknown argument: $1 (try --help)"
      ;;
  esac
done
export LABWIRED_PROFILE="$PROFILE"
export LABWIRED_HOME="$(labwired_prefix_home)"
export LABWIRED_AGENT_HOME="$(labwired_prefix_agent)"
BIN_DIR="$(labwired_user_bin)"
EXISTING_LABWIRED="$(command -v labwired 2>/dev/null || true)"
say "portable prefix: $LABWIRED_HOME (platform $(labwired_prefix_platform)$(labwired_prefix_is_wsl && echo '+wsl' || true))"
if labwired_prefix_is_wsl; then
  say "WSL detected — using Linux prebuilts (same as native Linux)"
  say "USB boards: attach from Windows with usbipd, then labwired probe list"
fi
labwired_prefix_ensure_dirs
labwired_prefix_register_existing_core "$EXISTING_LABWIRED" \
  || die "existing LabWired Core failed verification; refusing to replace $EXISTING_LABWIRED"

parse_opencode_version() {
  echo "$1" | sed -n 's/.*\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -1
}

# 1. pinned opencode ----------------------------------------------------------
if [[ "${LABWIRED_TEST_SKIP_OPENCODE:-0}" == "1" ]]; then
  say "skipping OpenCode setup (test mode)"
elif command -v opencode >/dev/null 2>&1; then
  raw="$(opencode --version 2>&1 || true)"
  ver="$(parse_opencode_version "$raw")"
  if [[ "$ver" == "$OPENCODE_PIN" ]]; then
    say "opencode ${ver} already installed ($(command -v opencode))"
  elif command -v npm >/dev/null 2>&1; then
    warn "opencode ${ver:-unknown} != pin ${OPENCODE_PIN}; installing opencode-ai@${OPENCODE_PIN}"
    npm install -g "opencode-ai@${OPENCODE_PIN}"
  else
    warn "opencode version ${ver:-unknown} does not match pin ${OPENCODE_PIN}"
    warn "install pin: npm install -g opencode-ai@${OPENCODE_PIN}"
  fi
elif command -v npm >/dev/null 2>&1; then
  say "installing opencode-ai@${OPENCODE_PIN}"
  npm install -g "opencode-ai@${OPENCODE_PIN}"
else
  warn "npm not found — install OpenCode pin ${OPENCODE_PIN} yourself:"
  warn "  npm install -g opencode-ai@${OPENCODE_PIN}"
  warn "  or https://opencode.ai"
fi

# Ensure `opencode` is on a PATH location users actually use (~/.local/bin)
_labwired_link_opencode() {
  mkdir -p "$BIN_DIR"
  if command -v opencode >/dev/null 2>&1; then
    local oc
    oc="$(command -v opencode)"
    # If already on BIN_DIR, done
    if [[ "$oc" == "$BIN_DIR/opencode" ]]; then
      return 0
    fi
  fi
  local npm_bin=""
  if command -v npm >/dev/null 2>&1; then
    npm_bin="$(npm prefix -g 2>/dev/null)/bin/opencode"
  fi
  if [[ -n "$npm_bin" && -e "$npm_bin" ]]; then
    ln -sfn "$npm_bin" "$BIN_DIR/opencode"
    say "linked opencode → $BIN_DIR/opencode"
    return 0
  fi
  # Fallback: walk npm root
  if command -v npm >/dev/null 2>&1; then
    local pkg
    pkg="$(npm root -g 2>/dev/null)/opencode-ai/bin/opencode.exe"
    if [[ -e "$pkg" ]]; then
      ln -sfn "$pkg" "$BIN_DIR/opencode"
      say "linked opencode → $BIN_DIR/opencode (from package)"
      return 0
    fi
  fi
  warn "could not place opencode on $BIN_DIR — ensure npm global bin is on PATH"
}
if [[ "${LABWIRED_TEST_SKIP_OPENCODE:-0}" != "1" ]]; then
  _labwired_link_opencode
fi

# 2. Runtime tools into portable prefix (sim required for local twin; PIO optional)
export LABWIRED_FAST="${LABWIRED_FAST:-1}"
export LABWIRED_INSTALL_PIO="${LABWIRED_INSTALL_PIO:-0}"
say "installing optional tools (sim=${LABWIRED_INSTALL_SIM}; probe=${LABWIRED_INSTALL_PROBE_RS}; PIO=${LABWIRED_INSTALL_PIO})"
if [[ "${LABWIRED_TEST_SKIP_NETWORK:-0}" == "1" ]]; then
  say "skipping network dependency setup (test mode)"
elif ! labwired_install_full_deps; then
  warn "some tools missing — agent still usable; later: labwired update --tools-only"
fi
if sim_path="$(labwired_resolve_sim 2>/dev/null)"; then
  export LABWIRED_CLI="$sim_path"
  say "simulator ready: $sim_path"
else
  warn "simulator missing — hosted MCP verify still works"
fi

# 3. resolve MCP command (airgap fails without vendor / LABWIRED_MCP_ENTRY) ---
MCP_JSON="$(labwired_resolve_mcp_command_json "$SRC")" || {
  die "airgap install requires LABWIRED_MCP_ENTRY or mcp/vendor/index.js — see mcp/README.md"
}
export MCP_JSON
export CFG_DIR
say "MCP command: $MCP_JSON (profile=$PROFILE)"

# 4. drop config, AGENTS.md, and skills into OpenCode discovery paths ---------
say "installing LabWired config into $CFG_DIR"
mkdir -p "$CFG_DIR/skills"
if [[ "$PROFILE" == "airgap" && -f "$SRC/config/opencode.airgap.json" ]]; then
  cp "$SRC/config/opencode.airgap.json" "$CFG_DIR/opencode.json"
elif [[ "$PROFILE" == "hosted" && -f "$SRC/config/opencode.hosted.json" ]]; then
  cp "$SRC/config/opencode.hosted.json" "$CFG_DIR/opencode.json"
  say "OpenCode provider: LabWired hosted (api.labwired.com) — run labwired login"
elif [[ -n "${DEEPINFRA_API_KEY:-}" && -f "$SRC/config/opencode.deepinfra.json" ]]; then
  cp "$SRC/config/opencode.deepinfra.json" "$CFG_DIR/opencode.json"
  say "OpenCode provider: DeepInfra (Kimi K2.5) — DEEPINFRA_API_KEY set"
else
  cp "$SRC/config/opencode.json" "$CFG_DIR/opencode.json"
fi
if [[ -f "$SRC/config/opencode.hosted.json" ]]; then
  cp "$SRC/config/opencode.hosted.json" "$CFG_DIR/opencode.hosted.json"
fi
cp "$SRC/config/AGENTS.md"     "$CFG_DIR/AGENTS.md"
cp -R "$SRC/skills/." "$CFG_DIR/skills/"
# Ensure new skills allowed in permission block if using stock config
if [[ -f "$CFG_DIR/opencode.json" ]] && command -v python3 >/dev/null 2>&1; then
  python3 - <<'PY'
import json, os
from pathlib import Path
p = Path(os.environ["CFG_DIR"]) / "opencode.json"
cfg = json.loads(p.read_text())
perm = cfg.setdefault("permission", {}).setdefault("skill", {})
for s in (
    "golden-path",
    "bringup",
    "prove",
    "observe",
    "desk-hw",
    "using-superpowers",
):
    perm.setdefault(s, "allow")
p.write_text(json.dumps(cfg, indent=2) + "\n")
PY
fi
say "skills installed: $(ls -1 "$CFG_DIR/skills" | tr '\n' ' ')"

# Rewrite mcp.labwired.command with resolved argv (never leave naked npx on airgap)
python3 - <<'PY'
import json, os, pathlib
cfg_path = pathlib.Path(os.environ["CFG_DIR"]) / "opencode.json"
cfg = json.loads(cfg_path.read_text())
lw = cfg.setdefault("mcp", {}).setdefault("labwired", {})
# Hosted profile uses remote Streamable HTTP — do not inject a local command.
if lw.get("type") != "remote":
    lw["command"] = json.loads(os.environ["MCP_JSON"])
cfg_path.write_text(json.dumps(cfg, indent=2) + "\n")
PY
say "wrote MCP command into $CFG_DIR/opencode.json"

# 5. product kit into portable prefix ----------------------------------------
AGENT_HOME="$(labwired_prefix_agent)"
PREFIX_BIN="$(labwired_prefix_bin)"
say "installing agent kit → $AGENT_HOME"
mkdir -p "$AGENT_HOME"
rsync -a --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.DS_Store' \
  --exclude '.grok' \
  "$SRC/" "$AGENT_HOME/" 2>/dev/null || {
  for d in bin lib config skills branding fixtures mcp scripts docs tests share examples; do
    if [[ -d "$SRC/$d" ]]; then
      mkdir -p "$AGENT_HOME/$d"
      cp -R "$SRC/$d/." "$AGENT_HOME/$d/"
    fi
  done
  for f in install.sh demo.sh VERSION LICENSE README.md package.json CHANGELOG.md; do
    [[ -f "$SRC/$f" ]] && cp "$SRC/$f" "$AGENT_HOME/$f"
  done
}

# Prefix bin/labwired → product dispatcher in the agent kit (contained, portable)
mkdir -p "$PREFIX_BIN"
_PH="$(labwired_prefix_home)"
cat >"${PREFIX_BIN}/labwired" <<WRAP
#!/usr/bin/env bash
export LABWIRED_HOME="${_PH}"
export LABWIRED_AGENT_HOME="\${LABWIRED_HOME}/agent"
export PATH="\${LABWIRED_HOME}/bin:\${PATH}"
# shellcheck disable=SC1090
[[ -f "\${LABWIRED_HOME}/env.sh" ]] && source "\${LABWIRED_HOME}/env.sh"
if [[ -x "\${LABWIRED_HOME}/tools/sim/labwired-sim" ]]; then
  export LABWIRED_CLI="\${LABWIRED_HOME}/tools/sim/labwired-sim"
  export LABWIRED_SIM="\${LABWIRED_CLI}"
fi
if [[ -x "\${LABWIRED_HOME}/tools/probe-rs/probe-rs" ]]; then
  export LABWIRED_PROBE_RS="\${LABWIRED_HOME}/tools/probe-rs/probe-rs"
fi
exec "\${LABWIRED_HOME}/agent/bin/labwired" "\$@"
WRAP
chmod 0755 "${PREFIX_BIN}/labwired"

# Branding into OpenCode config (product identity)
mkdir -p "$CFG_DIR/branding"
cp -R "$AGENT_HOME/branding/." "$CFG_DIR/branding/" 2>/dev/null || true
if [[ -f "$AGENT_HOME/config/tui.json" ]]; then
  cp "$AGENT_HOME/config/tui.json" "$CFG_DIR/tui.json"
fi
if [[ -f "$AGENT_HOME/config/AGENTS.md" ]]; then
  cp "$AGENT_HOME/config/AGENTS.md" "$CFG_DIR/AGENTS.md"
fi

# Thin user PATH shim — self-contained (no need to source env.sh first)
labwired_prefix_write_env
labwired_prefix_write_manifest
labwired_prefix_link_user_shim
# Also put prefix bin on PATH for this shell
export PATH="$(labwired_prefix_bin):$(labwired_user_bin):$PATH"
# shellcheck disable=SC1090
source "$(labwired_prefix_home)/env.sh" 2>/dev/null || true

# Soft PATH persistence (portable — only if missing)
_user_bin="$(labwired_user_bin)"
_prefix="$(labwired_prefix_home)"
for _rc in "${HOME}/.zprofile" "${HOME}/.zshrc" "${HOME}/.bashrc" "${HOME}/.profile"; do
  if [[ -f "$_rc" ]] || [[ "$_rc" == "${HOME}/.zprofile" ]]; then
    if [[ ! -f "$_rc" ]]; then touch "$_rc"; fi
    if ! grep -q 'LABWIRED_HOME\|labwired/env.sh\|\.labwired/bin' "$_rc" 2>/dev/null; then
      {
        echo ""
        echo "# LabWired Agent (portable prefix)"
        echo "[ -f \"${_prefix}/env.sh\" ] && . \"${_prefix}/env.sh\""
        echo "export PATH=\"${_user_bin}:\$PATH\""
      } >>"$_rc"
      say "PATH hook → $_rc"
      break
    fi
  fi
done

say "installed user shim → $(labwired_user_bin)/labwired"

RESOLVED_SIM=""
if RESOLVED_SIM="$(labwired_resolve_sim "$AGENT_HOME/bin/labwired" 2>/dev/null)"; then
  :
else
  RESOLVED_SIM="(hosted MCP / install later)"
fi

# Prove the loop
# shellcheck source=lib/smoke.sh
source "$SRC/lib/smoke.sh"
SMOKE_OK=0
if labwired_smoke "$AGENT_HOME"; then
  SMOKE_OK=1
fi

# Make labwired available in *this* shell immediately
export PATH="$(labwired_user_bin):$(labwired_prefix_bin):${PATH}"

cat <<EOF

$(printf '\033[32m✓\033[0m') LabWired Agent installed

  Run:     labwired
  Check:   labwired doctor
  Update:  curl -fsSL https://labwired.com/install/agent | bash

EOF

if [[ "$SMOKE_OK" -ne 1 ]]; then
  warn "smoke partial — kit is installed; run: labwired doctor"
  exit 0
fi
