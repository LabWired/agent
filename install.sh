#!/usr/bin/env bash
# LabWired agent installer — wires stock OpenCode to the LabWired MCP harness.
# No source fork: pure distribution layer under github.com/LabWired/agent.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
CFG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
BIN_DIR="${LABWIRED_BIN_DIR:-$HOME/.local/bin}"
OPENCODE_PIN="${OPENCODE_PIN:-1.18.7}"

say() { printf '\033[36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[33mwarn:\033[0m %s\n' "$1" >&2; }

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
# Default name is labwired-cli so this agent launcher (also named labwired) does
# not shadow the simulator on PATH. Override with LABWIRED_CLI.
if command -v "${LABWIRED_CLI:-labwired-cli}" >/dev/null 2>&1; then
  say "simulator already installed (${LABWIRED_CLI:-labwired-cli} → $(command -v "${LABWIRED_CLI:-labwired-cli}"))"
elif command -v labwired >/dev/null 2>&1 && [[ "$(command -v labwired)" != "$BIN_DIR/labwired" ]]; then
  say "found simulator candidate at $(command -v labwired) — set LABWIRED_CLI if needed"
else
  warn "LabWired simulator not found. Install it (needed for run/verify/inspect):"
  warn "  curl -fsSL https://labwired.com/install.sh | sh"
  warn "  export LABWIRED_CLI=labwired   # if the installer names the binary 'labwired'"
fi

# 3. drop config, AGENTS.md, and skills into OpenCode discovery paths ---------
say "installing LabWired config into $CFG_DIR"
mkdir -p "$CFG_DIR/skills"
cp "$SRC/config/opencode.json" "$CFG_DIR/opencode.json"
cp "$SRC/config/AGENTS.md"     "$CFG_DIR/AGENTS.md"
cp -R "$SRC/skills/." "$CFG_DIR/skills/"
say "skills installed: $(ls -1 "$CFG_DIR/skills" | tr '\n' ' ')"

# 4. branded entrypoint -------------------------------------------------------
mkdir -p "$BIN_DIR"
install -m 0755 "$SRC/bin/labwired" "$BIN_DIR/labwired"
say "installed agent launcher → $BIN_DIR/labwired"
case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *) warn "$BIN_DIR is not on PATH — add:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

cat <<EOF

$(say "done")
Next:
  1. labwired doctor
  2. Start a local model (default Ollama + Qwen2.5-Coder):
       ollama pull qwen2.5-coder && ollama serve
     …or:  export LABWIRED_MODEL_URL=http://<host>:<port>/v1
  3. (optional full loop) export LABWIRED_BUILDER_URL=http://<builder>:<port>
  4. Launch:   labwired
     Check:    opencode mcp list   (expect server 'labwired' + labwired_* tools)

Air-gapped / ITAR: place config/opencode.airgap.json at a managed path
(/etc/opencode/opencode.json or macOS Application Support) and point
LABWIRED_MODEL_URL / LABWIRED_BUILDER_URL at in-vault services.
EOF
