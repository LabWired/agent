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

# A downloaded replacement whose installer fails must leave the live agent intact.
mkdir -p "$TMP/archive/new-agent" "$TMP/prefix/agent"
printf 'old agent\n' >"$TMP/prefix/agent/marker"
cat >"$TMP/archive/new-agent/install.sh" <<'INSTALL'
#!/usr/bin/env bash
exit 42
INSTALL
chmod +x "$TMP/archive/new-agent/install.sh"
tar -czf "$TMP/agent.tar.gz" -C "$TMP/archive" new-agent
cat >"$TMP/bin/curl" <<'CURL'
#!/usr/bin/env bash
exec /bin/cat "$LABWIRED_TEST_TARBALL"
CURL
chmod +x "$TMP/bin/curl"

if HOME="$TMP/home" PATH="$TMP/bin:/usr/bin:/bin" LABWIRED_HOME="$TMP/prefix" \
  LABWIRED_TEST_TARBALL="$TMP/agent.tar.gz" bash "$ROOT/scripts/public/install" \
  >"$TMP/failure.out" 2>&1; then
  echo "FAIL broken replacement unexpectedly installed"
  exit 1
fi
grep -qx 'old agent' "$TMP/prefix/agent/marker"
test ! -e "$TMP/prefix/agent/install.sh"
echo "ok   failed install rolled back live agent"

# A symlinked agent target must never be followed or replaced.
rm -rf "$TMP/prefix/agent"
mkdir -p "$TMP/outside-agent"
printf 'outside\n' >"$TMP/outside-agent/marker"
ln -s "$TMP/outside-agent" "$TMP/prefix/agent"
if HOME="$TMP/home" PATH="$TMP/bin:/usr/bin:/bin" LABWIRED_HOME="$TMP/prefix" \
  LABWIRED_TEST_TARBALL="$TMP/agent.tar.gz" bash "$ROOT/scripts/public/install" \
  >"$TMP/symlink.out" 2>&1; then
  echo "FAIL symlinked agent target accepted"
  exit 1
fi
grep -qx 'outside' "$TMP/outside-agent/marker"
echo "ok   symlinked agent target rejected"
