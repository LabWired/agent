#!/usr/bin/env bash
# rpc-contract.sh — extension <-> server RPC contract gate.
# Fails when the VS Code client calls an RPC method the server does not dispatch,
# or subscribes to a notification the server never emits.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/extensions/labwired-vscode"
node scripts/rpc-contract-check.mjs
echo "rpc-contract: PASS"
