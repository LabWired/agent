#!/usr/bin/env bash
# LabWired Firmware Agent — one-command install (legacy URL)
# Prefer:  curl -fsSL https://labwired.com/install | bash
# Legacy:  curl -fsSL https://labwired.com/agent-install.sh | sh
#
# Thin wrapper around scripts/public/install (Cursor-style entry).
set -euo pipefail

HERE="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
PUBLIC="$HERE/public/install"
if [[ -f "$PUBLIC" ]]; then
  exec bash "$PUBLIC" "$@"
fi
# Fallback when only this file is published alone
export LABWIRED_HOME="${LABWIRED_HOME:-$HOME/.labwired}"
export LABWIRED_AGENT_HOME="${LABWIRED_AGENT_HOME:-$LABWIRED_HOME/agent}"
REPO_URL="${LABWIRED_AGENT_REPO:-https://github.com/LabWired/agent.git}"
REPO_REF="${LABWIRED_AGENT_REF:-main}"
say() { printf '\033[36m==>\033[0m %s\n' "$1"; }
die() { printf 'labwired-agent-install: %s\n' "$1" >&2; exit 1; }
command -v git >/dev/null || die "need git"
command -v bash >/dev/null || die "need bash"
AGENT_HOME="$LABWIRED_AGENT_HOME"
say "install home: $AGENT_HOME (ref $REPO_REF)"
if [[ -d "$AGENT_HOME/.git" ]]; then
  git -C "$AGENT_HOME" fetch --depth 1 origin "$REPO_REF"
  git -C "$AGENT_HOME" checkout -q FETCH_HEAD
else
  mkdir -p "$(dirname "$AGENT_HOME")"
  rm -rf "$AGENT_HOME"
  git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$AGENT_HOME" \
    || git clone --depth 1 "$REPO_URL" "$AGENT_HOME"
fi
[[ -f "$AGENT_HOME/install.sh" ]] || die "install.sh missing"
exec bash "$AGENT_HOME/install.sh" --full "$@"