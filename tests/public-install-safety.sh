#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/home"

# Unsafe overrides must be rejected before download or filesystem mutation.
if HOME="$TMP/home" LABWIRED_HOME="$TMP/prefix" LABWIRED_AGENT_HOME="$TMP/outside" \
  bash "$ROOT/scripts/public/install" >"$TMP/unsafe.out" 2>&1; then
  echo "FAIL unsafe AGENT_HOME accepted"
  exit 1
fi
grep -qi 'agent.*must.*prefix\|unsafe.*agent' "$TMP/unsafe.out"
test ! -e "$TMP/outside"
echo "ok   unsafe AGENT_HOME rejected"

# A downloaded replacement whose installer fails must restore every shared path
# owned by the public Agent installer, including prior symlink and absence state.
mkdir -p "$TMP/archive/new-agent" "$TMP/prefix/agent"
printf 'old agent\n' >"$TMP/prefix/agent/marker"
cat >"$TMP/archive/new-agent/install.sh" <<'INSTALL'
#!/usr/bin/env bash
set -eu
cfg="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
userbin="${LABWIRED_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$cfg" "$LABWIRED_HOME/bin" "$userbin"
printf 'mutated config\n' >"$cfg/opencode.json"
printf 'new manifest\n' >"$cfg/labwired-agent.manifest"
printf 'mutated dispatcher\n' >"$LABWIRED_HOME/bin/labwired"
printf 'new env\n' >"$LABWIRED_HOME/env.sh"
printf 'new prefix manifest\n' >"$LABWIRED_HOME/MANIFEST.json"
rm -f "$userbin/labwired"
printf 'mutated shim\n' >"$userbin/labwired"
printf 'mutated rc\n' >"$HOME/.zprofile"
exit 42
INSTALL
chmod +x "$TMP/archive/new-agent/install.sh"
tar -czf "$TMP/agent.tar.gz" -C "$TMP/archive" new-agent
cat >"$TMP/bin/curl" <<'CURL'
#!/usr/bin/env bash
exec /bin/cat "$LABWIRED_TEST_TARBALL"
CURL
chmod +x "$TMP/bin/curl"

export OPENCODE_CONFIG_DIR="$TMP/opencode"
export LABWIRED_BIN_DIR="$TMP/user-bin"
mkdir -p "$OPENCODE_CONFIG_DIR" "$LABWIRED_BIN_DIR" "$TMP/prefix/bin"
printf 'old config\n' >"$OPENCODE_CONFIG_DIR/opencode.json"
printf 'old dispatcher\n' >"$TMP/prefix/bin/labwired"
printf 'shim target\n' >"$TMP/original-shim-target"
ln -s "$TMP/original-shim-target" "$LABWIRED_BIN_DIR/labwired"
printf 'old rc\n' >"$TMP/home/.zprofile"

if HOME="$TMP/home" PATH="$TMP/bin:/usr/bin:/bin" LABWIRED_HOME="$TMP/prefix" LABWIRED_AGENT_HOME="$TMP/prefix/agent" \
  LABWIRED_TEST_TARBALL="$TMP/agent.tar.gz" bash "$ROOT/scripts/public/install" \
  >"$TMP/failure.out" 2>&1; then
  echo "FAIL broken replacement unexpectedly installed"
  exit 1
else
  failure_status=$?
fi
[[ "$failure_status" -eq 42 ]]
if ! grep -Eq 'previous Agent.*restored' "$TMP/failure.out"; then
  cat "$TMP/failure.out" >&2
  echo "FAIL replacement installer was not reached" >&2
  exit 1
fi
grep -qx 'old agent' "$TMP/prefix/agent/marker"
test ! -e "$TMP/prefix/agent/install.sh"
grep -qx 'old config' "$OPENCODE_CONFIG_DIR/opencode.json"
grep -qx 'old dispatcher' "$TMP/prefix/bin/labwired"
test -L "$LABWIRED_BIN_DIR/labwired"
[[ "$(readlink "$LABWIRED_BIN_DIR/labwired")" == "$TMP/original-shim-target" ]]
grep -qx 'shim target' "$TMP/original-shim-target"
grep -qx 'old rc' "$TMP/home/.zprofile"
test ! -e "$OPENCODE_CONFIG_DIR/labwired-agent.manifest"
test ! -e "$TMP/prefix/env.sh"
test ! -e "$TMP/prefix/MANIFEST.json"
echo "ok   failed install rolled back Agent and shared state"

assert_no_transaction_dirs() {
  if find "$TMP/prefix" -maxdepth 1 -type d \( -name '.agent-stage.*' -o -name '.agent-backup.*' -o -name '.agent-rollback.*' \) | grep -q .; then
    echo "FAIL transaction temporary data remains" >&2
    return 1
  fi
}
assert_no_transaction_dirs

# A signal delivered while the replacement child runs must take the same
# rollback path and preserve the signal-derived exit status.
mkdir -p "$TMP/archive-term/new-agent"
cat >"$TMP/archive-term/new-agent/install.sh" <<'TERM_INSTALL'
#!/usr/bin/env bash
printf 'term mutation\n' >"$OPENCODE_CONFIG_DIR/opencode.json"
printf 'term env\n' >"$LABWIRED_HOME/env.sh"
kill -TERM "$PPID"
sleep 2
TERM_INSTALL
chmod +x "$TMP/archive-term/new-agent/install.sh"
tar -czf "$TMP/agent-term.tar.gz" -C "$TMP/archive-term" new-agent
if HOME="$TMP/home" PATH="$TMP/bin:/usr/bin:/bin" LABWIRED_HOME="$TMP/prefix" LABWIRED_AGENT_HOME="$TMP/prefix/agent" \
  LABWIRED_TEST_TARBALL="$TMP/agent-term.tar.gz" bash "$ROOT/scripts/public/install" \
  >"$TMP/term.out" 2>&1; then
  echo "FAIL interrupted replacement unexpectedly succeeded"
  exit 1
else
  term_status=$?
fi
[[ "$term_status" -eq 143 ]]
grep -qx 'old agent' "$TMP/prefix/agent/marker"
grep -qx 'old config' "$OPENCODE_CONFIG_DIR/opencode.json"
test ! -e "$TMP/prefix/env.sh"
assert_no_transaction_dirs
echo "ok   interrupted install rolled back transaction"

# Failure of the replacement rename after the old Agent moved must also roll
# back. The wrapper delegates every mv except the one into the live Agent path.
cat >"$TMP/bin/mv" <<'MV'
#!/usr/bin/env bash
for arg in "$@"; do
  if [[ "$arg" == "$LABWIRED_HOME/agent" ]]; then exit 73; fi
done
exec /bin/mv "$@"
MV
chmod +x "$TMP/bin/mv"
if HOME="$TMP/home" PATH="$TMP/bin:/usr/bin:/bin" LABWIRED_HOME="$TMP/prefix" LABWIRED_AGENT_HOME="$TMP/prefix/agent" \
  LABWIRED_TEST_TARBALL="$TMP/agent.tar.gz" bash "$ROOT/scripts/public/install" \
  >"$TMP/move.out" 2>&1; then
  echo "FAIL forced replacement move unexpectedly succeeded"
  exit 1
else
  move_status=$?
fi
[[ "$move_status" -eq 73 ]]
grep -qx 'old agent' "$TMP/prefix/agent/marker"
grep -qx 'old config' "$OPENCODE_CONFIG_DIR/opencode.json"
assert_no_transaction_dirs
rm -f "$TMP/bin/mv"
echo "ok   replacement move failure rolled back transaction"

# A symlinked agent target must never be followed or replaced.
rm -rf "$TMP/prefix/agent"
mkdir -p "$TMP/outside-agent"
printf 'outside\n' >"$TMP/outside-agent/marker"
ln -s "$TMP/outside-agent" "$TMP/prefix/agent"
if HOME="$TMP/home" PATH="$TMP/bin:/usr/bin:/bin" LABWIRED_HOME="$TMP/prefix" LABWIRED_AGENT_HOME="$TMP/prefix/agent" \
  LABWIRED_TEST_TARBALL="$TMP/agent.tar.gz" bash "$ROOT/scripts/public/install" \
  >"$TMP/symlink.out" 2>&1; then
  echo "FAIL symlinked agent target accepted"
  exit 1
fi
grep -qx 'outside' "$TMP/outside-agent/marker"
echo "ok   symlinked agent target rejected"
