#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TASK="$ROOT/benchmarks/twin2silicon/tasks/f103-gpio-clock-001"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cp -R "$TASK/public/." "$TMP/"
make -C "$TMP/firmware"
python3 "$ROOT/benchmarks/twin2silicon/prepare-oracle.py" \
  "$TASK/hidden/oracle.yaml" "$TASK/hidden/system.yaml" \
  "$TMP/firmware/build/firmware.elf" "$TMP/oracle.yaml"

if "${LABWIRED_CLI:?set LABWIRED_CLI}" test \
  --script "$TMP/oracle.yaml" --output-dir "$TMP/result"; then
  echo "FAIL: buggy fixture unexpectedly passed"
  exit 1
fi

grep -q '"status": "fail"' "$TMP/result/result.json"
echo "ok twin2silicon fixture starts red"
