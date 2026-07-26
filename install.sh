#!/usr/bin/env bash
# LabWired agent installer — wires opencode (MIT) to the LabWired MCP server,
# skills, and a local/on-prem model. No source fork; pure distribution layer.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
CFG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
BIN_DIR="${LABWIRED_BIN_DIR:-$HOME/.local/bin}"

say() { printf '\033[36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[33mwarn:\033[0m %s\n' "$1" >&2; }

# 1. opencode -----------------------------------------------------------------
if command -v opencode >/dev/null 2>&1; then
  say "opencode already installed ($(command -v opencode))"
elif command -v npm >/dev/null 2>&1; then
  say "installing opencode via npm (opencode-ai)"
  npm install -g opencode-ai
else
  warn "npm not found — install opencode yourself: https://opencode.ai (curl -fsSL https://opencode.ai/install | bash)"
fi

# 2. labwired CLI (local simulator the MCP shells out to) ---------------------
if command -v labwired >/dev/null 2>&1; then
  say "labwired CLI already installed ($(command -v labwired))"
else
  warn "labwired CLI not found. Install it (needed for run/verify/inspect):"
  warn "  curl -fsSL https://labwired.com/install.sh | sh"
fi

# 3. drop config, AGENTS.md, and skills into opencode's discovery locations ----
say "installing LabWired config into $CFG_DIR"
mkdir -p "$CFG_DIR/skills"
cp "$SRC/config/opencode.json" "$CFG_DIR/opencode.json"
cp "$SRC/config/AGENTS.md"     "$CFG_DIR/AGENTS.md"
cp -R "$SRC/skills/." "$CFG_DIR/skills/"
say "skills installed: $(ls -1 "$CFG_DIR/skills" | tr '\n' ' ')"

# 4. branded entrypoint -------------------------------------------------------
mkdir -p "$BIN_DIR"
install -m 0755 "$SRC/bin/labwired" "$BIN_DIR/labwired"
say "installed 'labwired' launcher → $BIN_DIR/labwired"
case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *) warn "$BIN_DIR is not on PATH — add it:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

cat <<EOF

$(say "done")
Next:
  1. Start a local model (default expects Ollama + Qwen2.5-Coder):
       ollama pull qwen2.5-coder && ollama serve
     …or point elsewhere:  export LABWIRED_MODEL_URL=http://<host>:<port>/v1
  2. (optional, full offline loop) run a LabWired builder and:
       export LABWIRED_BUILDER_URL=http://<builder-host>:<port>
  3. Launch:   labwired
     Check wiring:   opencode mcp list      (expect the 'labwired' server + labwired_* tools)

Air-gapped / ITAR: use config/opencode.airgap.json instead — place it at
/etc/opencode/opencode.json (managed, non-overridable) and set LABWIRED_MODEL_URL /
LABWIRED_BUILDER_URL to in-vault services. See README.md.
EOF
