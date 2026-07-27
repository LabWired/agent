#!/usr/bin/env bash
# LabWired agent installer — wires stock OpenCode to the LabWired MCP harness.
# No source fork: pure distribution layer under github.com/LabWired/agent.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
CFG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
BIN_DIR="${LABWIRED_BIN_DIR:-$HOME/.local/bin}"
OPENCODE_PIN="${OPENCODE_PIN:-1.18.7}"

# shellcheck source=lib/resolve-mcp.sh
source "$SRC/lib/resolve-mcp.sh"
# shellcheck source=lib/resolve-sim.sh
source "$SRC/lib/resolve-sim.sh"

say() { printf '\033[36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[33mwarn:\033[0m %s\n' "$1" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

# Optional: ./install.sh --airgap  (fail closed without vendored MCP / LABWIRED_MCP_ENTRY)
PROFILE="${LABWIRED_PROFILE:-online}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --airgap)
      PROFILE=airgap
      shift
      ;;
    -h|--help)
      cat <<'USAGE'
Usage: ./install.sh [--airgap]

  --airgap   Set LABWIRED_PROFILE=airgap: require LABWIRED_MCP_ENTRY or
             mcp/vendor/index.js (no naked npx). See mcp/README.md.
USAGE
      exit 0
      ;;
    *)
      die "unknown argument: $1 (try --help)"
      ;;
  esac
done
export LABWIRED_PROFILE="$PROFILE"

parse_opencode_version() {
  echo "$1" | sed -n 's/.*\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -1
}

# 1. pinned opencode ----------------------------------------------------------
if command -v opencode >/dev/null 2>&1; then
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

# 2. simulator CLI (oracle binary the MCP shells out to) ----------------------
# Prefer LABWIRED_CLI / LABWIRED_SIM when set; do not invent a missing binary name.
if [[ -n "${LABWIRED_CLI:-}" ]] && command -v "$LABWIRED_CLI" >/dev/null 2>&1; then
  say "simulator already installed (LABWIRED_CLI=$LABWIRED_CLI → $(command -v "$LABWIRED_CLI"))"
elif command -v labwired-sim >/dev/null 2>&1; then
  say "simulator candidate: labwired-sim → $(command -v labwired-sim)"
elif command -v labwired-cli >/dev/null 2>&1; then
  say "simulator candidate: labwired-cli → $(command -v labwired-cli)"
elif command -v labwired >/dev/null 2>&1 && [[ "$(command -v labwired)" != "$BIN_DIR/labwired" ]]; then
  say "found simulator candidate at $(command -v labwired) — set LABWIRED_CLI if needed"
else
  warn "LabWired simulator not found. Install it (needed for run/verify/inspect):"
  warn "  curl -fsSL https://labwired.com/install.sh | sh"
  warn "  export LABWIRED_CLI=/path/to/sim   # real path; never a fictional name"
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
else
  cp "$SRC/config/opencode.json" "$CFG_DIR/opencode.json"
fi
cp "$SRC/config/AGENTS.md"     "$CFG_DIR/AGENTS.md"
cp -R "$SRC/skills/." "$CFG_DIR/skills/"
say "skills installed: $(ls -1 "$CFG_DIR/skills" | tr '\n' ' ')"

# Rewrite mcp.labwired.command with resolved argv (never leave naked npx on airgap)
python3 - <<'PY'
import json, os, pathlib
cfg_path = pathlib.Path(os.environ["CFG_DIR"]) / "opencode.json"
cfg = json.loads(cfg_path.read_text())
cfg.setdefault("mcp", {}).setdefault("labwired", {})
cfg["mcp"]["labwired"]["command"] = json.loads(os.environ["MCP_JSON"])
cfg_path.write_text(json.dumps(cfg, indent=2) + "\n")
PY
say "wrote MCP command into $CFG_DIR/opencode.json"

# 5. branded entrypoint -------------------------------------------------------
mkdir -p "$BIN_DIR"
install -m 0755 "$SRC/bin/labwired" "$BIN_DIR/labwired"
say "installed agent launcher → $BIN_DIR/labwired"
case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *) warn "$BIN_DIR is not on PATH — add:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

# Resolved paths summary (sim may still be missing — doctor will say so)
RESOLVED_SIM=""
if RESOLVED_SIM="$(labwired_resolve_sim "$BIN_DIR/labwired" 2>/dev/null)"; then
  :
else
  RESOLVED_SIM="(not found — set LABWIRED_CLI or install simulator)"
fi

cat <<EOF

$(say "done")
Resolved:
  profile:  $PROFILE
  MCP:      $MCP_JSON
  sim:      $RESOLVED_SIM
  launcher: $BIN_DIR/labwired
  config:   $CFG_DIR/opencode.json

Next:
  1. labwired doctor
  2. ./demo.sh          # offline unit smoke (this repo)
  3. Start a local model (default Ollama + Qwen2.5-Coder):
       ollama pull qwen2.5-coder && ollama serve
     …or:  export LABWIRED_MODEL_URL=http://<host>:<port>/v1
  4. (optional full loop) export LABWIRED_BUILDER_URL=http://<builder>:<port>
  5. Launch:   labwired
     Check:    opencode mcp list   (expect server 'labwired' + labwired_* tools)

Air-gapped / ITAR:
  ./install.sh --airgap
  Requires LABWIRED_MCP_ENTRY or mcp/vendor/index.js (see mcp/README.md).
  Point LABWIRED_MODEL_URL / LABWIRED_BUILDER_URL at in-vault services.
EOF
