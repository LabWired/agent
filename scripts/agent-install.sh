#!/usr/bin/env sh
# LabWired Firmware Agent — one-command install
# https://labwired.com/agent-install.sh
# https://github.com/LabWired/agent
#
# Usage:
#   curl -fsSL https://labwired.com/agent-install.sh | sh
#   curl -fsSL https://labwired.com/agent-install.sh | sh -s -- --airgap
#
# Clones/updates the agent kit into ~/.labwired/agent and runs install.sh.

set -eu

REPO_URL="${LABWIRED_AGENT_REPO:-https://github.com/LabWired/agent.git}"
REPO_REF="${LABWIRED_AGENT_REF:-main}"
AGENT_HOME="${LABWIRED_AGENT_HOME:-$HOME/.labwired/agent}"

say() { printf '\033[36m==>\033[0m %s\n' "$1"; }
die() { printf 'labwired-agent-install: %s\n' "$1" >&2; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "need '$1' on PATH"
}

need git
need curl

say "LabWired Firmware Agent — the easiest way to write firmware"
say "install home: $AGENT_HOME (ref $REPO_REF)"

if [ -d "$AGENT_HOME/.git" ]; then
  say "updating existing install"
  git -C "$AGENT_HOME" fetch --depth 1 origin "$REPO_REF"
  git -C "$AGENT_HOME" checkout -q FETCH_HEAD
else
  say "cloning $REPO_URL"
  mkdir -p "$(dirname "$AGENT_HOME")"
  rm -rf "$AGENT_HOME"
  git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$AGENT_HOME" \
    || git clone --depth 1 "$REPO_URL" "$AGENT_HOME"
fi

if [ ! -x "$AGENT_HOME/install.sh" ]; then
  die "install.sh missing in $AGENT_HOME"
fi

say "running installer"
exec sh "$AGENT_HOME/install.sh" "$@"
