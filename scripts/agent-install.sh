#!/usr/bin/env bash
# Legacy URL entry → same as scripts/public/install
# Prefer: curl -fsSL https://labwired.com/install/agent | bash
set -euo pipefail
HERE="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
if [[ -f "$HERE/public/install" ]]; then
  exec bash "$HERE/public/install" "$@"
fi
# Alone on CDN: bootstrap from GitHub
exec bash -c "$(curl -fsSL https://raw.githubusercontent.com/LabWired/agent/main/scripts/public/install)" -- "$@"
