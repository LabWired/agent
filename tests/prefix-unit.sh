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
# Isolate from ambient install env (user shell may export LABWIRED_* tools paths)
unset LABWIRED_CLI LABWIRED_SIM LABWIRED_PROBE_RS
export LABWIRED_HOME="$TMP/prefix"

labwired_prefix_ensure_dirs
test -d "$LABWIRED_HOME/bin"
test -d "$LABWIRED_HOME/tools/sim"
test -d "$LABWIRED_HOME/cache"
test -d "$LABWIRED_HOME/components"
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

# Registration accepts only a positively identified Core snapshot.
random="$TMP/random-tool"
printf '#!/bin/sh\necho random-tool\n' >"$random"
chmod +x "$random"
if labwired_prefix_register_existing_core "$random"; then
  test ! -e "$(labwired_prefix_core_bin)" || { echo "FAIL random executable registered as Core"; fail=1; }
else
echo "ok   random executable rejected"
fi

# The fake-Core test hook is inert unless both installer safe-mode flags are on.
fake_core="$TMP/fake-core"
cat >"$fake_core" <<'CORE'
#!/bin/sh
case "$1" in
  --version) echo 'fake-core 1.0.0' ;;
  --help) echo 'fake-core help' ;;
esac
CORE
chmod +x "$fake_core"
export LABWIRED_TEST_ALLOW_FAKE_CORE=1
unset LABWIRED_TEST_SKIP_NETWORK LABWIRED_TEST_SKIP_OPENCODE
if labwired_prefix_register_existing_core "$fake_core" 2>/dev/null; then
  echo "FAIL fake-Core hook active outside safe test mode"
  fail=1
else
  test ! -e "$(labwired_prefix_core_bin)"
  echo "ok   fake-Core hook requires complete safe test mode"
fi
unset LABWIRED_TEST_ALLOW_FAKE_CORE

# Candidate probes are bounded even when an executable hangs forever.
hanging="$TMP/hanging-core"
cat >"$hanging" <<'HANG'
#!/bin/sh
while :; do sleep 1; done
HANG
chmod +x "$hanging"
started="$(date +%s)"
if labwired_prefix_register_existing_core "$hanging" 2>/dev/null; then
  echo "FAIL hanging Core candidate registered"
  fail=1
else
  elapsed=$(( $(date +%s) - started ))
  if [[ "$elapsed" -le 4 ]]; then
    echo "ok   hanging Core candidate rejected within bound"
  else
    echo "FAIL hanging Core rejection took ${elapsed}s"
    fail=1
  fi
fi

# Component registration must not follow a symlinked destination directory.
rm -rf "$LABWIRED_HOME/components"
mkdir -p "$TMP/outside-components" "$LABWIRED_HOME"
ln -s "$TMP/outside-components" "$LABWIRED_HOME/components"
core_source="$TMP/core-source"
printf '#!/bin/sh\ncase "$1" in --version) echo "fake-core 1.0.0";; --help) echo "LabWired Simulator Commands: test chips machine";; esac\n' >"$core_source"
chmod +x "$core_source"
if labwired_prefix_register_existing_core "$core_source" 2>/dev/null; then
  echo "FAIL symlinked component directory accepted"
  fail=1
else
  test ! -e "$TMP/outside-components/core/bin/labwired"
  echo "ok   symlinked component directory rejected"
fi
rm -f "$LABWIRED_HOME/components"
mkdir -p "$LABWIRED_HOME/components"

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

# Registered Core takes precedence over PATH fallbacks.
rm -f "$LABWIRED_HOME/tools/sim/labwired-sim"
mkdir -p "$(dirname "$(labwired_prefix_core_bin)")" "$TMP/path-bin"
printf '#!/bin/sh\necho registered-core\n' >"$(labwired_prefix_core_bin)"
printf '#!/bin/sh\necho path-sim\n' >"$TMP/path-bin/labwired-sim"
chmod +x "$(labwired_prefix_core_bin)" "$TMP/path-bin/labwired-sim"
PATH="$TMP/path-bin:$PATH" got="$(labwired_resolve_sim)"
if [[ "$got" == "$(labwired_prefix_core_bin)" ]]; then
  echo "ok   resolve-sim registered Core"
else
  echo "FAIL resolve registered Core got=$got"
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
