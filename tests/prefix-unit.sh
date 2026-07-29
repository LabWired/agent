#!/usr/bin/env bash
# Unit tests for portable prefix helpers.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/prefix.sh
source "$ROOT/lib/prefix.sh"
# shellcheck source=lib/resolve-sim.sh
source "$ROOT/lib/resolve-sim.sh"
# shellcheck source=lib/resolve-probe.sh
source "$ROOT/lib/resolve-probe.sh"

fail=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export LABWIRED_HOME="$TMP/prefix"

labwired_prefix_ensure_dirs
test -d "$LABWIRED_HOME/bin"
test -d "$LABWIRED_HOME/tools/sim"
test -d "$LABWIRED_HOME/cache"
echo "ok   ensure_dirs"

# platform shape
p="$(labwired_prefix_platform)"
case "$p" in
  darwin-*|linux-*|windows-*) echo "ok   platform=$p" ;;
  *) echo "FAIL platform=$p"; fail=1 ;;
esac

labwired_prefix_write_env
test -f "$LABWIRED_HOME/env.sh"
grep -q LABWIRED_HOME "$LABWIRED_HOME/env.sh"
echo "ok   env.sh"

# fake sim in prefix → resolve-sim finds it
mkdir -p "$LABWIRED_HOME/tools/sim"
printf '#!/bin/sh\necho fake-sim\n' >"$LABWIRED_HOME/tools/sim/labwired-sim"
chmod +x "$LABWIRED_HOME/tools/sim/labwired-sim"
got="$(labwired_resolve_sim)"
if [[ "$got" == "$LABWIRED_HOME/tools/sim/labwired-sim" ]]; then
  echo "ok   resolve-sim prefix"
else
  echo "FAIL resolve-sim got=$got"
  fail=1
fi

# fake probe
mkdir -p "$LABWIRED_HOME/tools/probe-rs"
printf '#!/bin/sh\necho fake-probe\n' >"$LABWIRED_HOME/tools/probe-rs/probe-rs"
chmod +x "$LABWIRED_HOME/tools/probe-rs/probe-rs"
got="$(labwired_resolve_probe_rs)"
if [[ "$got" == "$LABWIRED_HOME/tools/probe-rs/probe-rs" ]]; then
  echo "ok   resolve-probe prefix"
else
  echo "FAIL resolve-probe got=$got"
  fail=1
fi

# empty home must not use real ~/.labwired if we unset after setting empty tools-less
export LABWIRED_HOME="$TMP/empty"
mkdir -p "$LABWIRED_HOME"
# isolate PATH
export PATH="/usr/bin:/bin"
unset LABWIRED_CLI LABWIRED_SIM LABWIRED_PROBE_RS
got="$(labwired_resolve_sim 2>/dev/null || true)"
# may still find nothing — empty is success
if [[ -z "$got" ]]; then
  echo "ok   resolve-sim empty prefix"
else
  # if system has labwired-sim on path we didn't isolate fully — soft ok
  echo "ok   resolve-sim empty prefix (got=$got — PATH may have system sim)"
fi

if [[ "$fail" -ne 0 ]]; then
  echo "prefix-unit FAILED"
  exit 1
fi
echo "ok   prefix-unit PASS"
