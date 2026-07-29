#!/usr/bin/env bash
# pack-portable.sh — build a relocatable tarball of the LabWired agent kit
# (agent sources only; tools downloaded on target via install.sh --full).
#
# Usage:
#   ./scripts/pack-portable.sh
#   ./scripts/pack-portable.sh /tmp/out
#
# Produces: labwired-agent-<version>-portable.tar.gz
# On any supported host:
#   tar -xzf labwired-agent-*-portable.tar.gz
#   cd labwired-agent-* && ./install.sh --prefix /opt/labwired   # or any path
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-$ROOT/dist}"
VER="$(tr -d '[:space:]' <"$ROOT/VERSION" 2>/dev/null || echo 0.0.0)"
NAME="labwired-agent-${VER}-portable"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/$NAME" "$OUT_DIR"
# Kit only — platform tools resolved at install time for the host arch
rsync -a --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.DS_Store' \
  --exclude '.grok' \
  --exclude 'dist' \
  "$ROOT/" "$STAGE/$NAME/"

# Ensure install is executable
chmod +x "$STAGE/$NAME/install.sh" "$STAGE/$NAME/bin/labwired" 2>/dev/null || true
chmod +x "$STAGE/$NAME/scripts/"*.sh 2>/dev/null || true

# Hint file
cat >"$STAGE/$NAME/PORTABLE.md" <<EOF
# LabWired Agent — portable kit ${VER}

## Install (any supported platform)

\`\`\`bash
./install.sh --prefix "\$HOME/.labwired"   # default
# or project-local / CI / USB:
./install.sh --prefix /opt/labwired
./install.sh --prefix "\$PWD/.labwired"
\`\`\`

Supported prebuilt sim platforms: darwin-x86_64, darwin-aarch64, linux-x86_64, linux-aarch64.

Activate:

\`\`\`bash
source "\$LABWIRED_HOME/env.sh"   # or ~/.labwired/env.sh
labwired doctor --strict
\`\`\`

Uninstall:

\`\`\`bash
labwired package uninstall --yes
\`\`\`
EOF

tar -czf "${OUT_DIR}/${NAME}.tar.gz" -C "$STAGE" "$NAME"
echo "wrote ${OUT_DIR}/${NAME}.tar.gz"
ls -lh "${OUT_DIR}/${NAME}.tar.gz"
