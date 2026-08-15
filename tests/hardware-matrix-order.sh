#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST_HOME="${HOME:?HOME is required for the shared PlatformIO tool cache}"
MATRIX_TMP="$(mktemp -d)"
trap 'rm -rf "$MATRIX_TMP"' EXIT INT TERM HUP

run_lane() {
  local iteration="$1" name="$2"
  shift 2
  local lane="$MATRIX_TMP/$iteration-$name"
  mkdir -p "$lane/home" "$lane/tmp" "$lane/runtime"
  echo "matrix iteration=$iteration lane=$name"
  env HOME="$lane/home" TMPDIR="$lane/tmp" TMP="$lane/tmp" TEMP="$lane/tmp" \
    XDG_RUNTIME_DIR="$lane/runtime" PLATFORMIO_CORE_DIR="${PLATFORMIO_CORE_DIR:-$HOST_HOME/.platformio}" "$@"
}

for iteration in 1 2; do
  run_lane "$iteration" develop bash "$ROOT/tests/develop-acceptance-smoke.sh"
  run_lane "$iteration" hardware-node node --test "$ROOT"/tests/hardware-*.test.mjs
  run_lane "$iteration" hardware-cli bash "$ROOT/tests/hardware-cli.sh"
  run_lane "$iteration" hardware-legacy bash "$ROOT/tests/hardware-legacy-compat.sh"
  run_lane "$iteration" hardware-release bash "$ROOT/tests/hardware-release-contract.sh"
done

echo 'PASS hardware matrix order is hermetic across repeated runs'
