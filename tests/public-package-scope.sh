#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FIXTURE="$TMP/repo"
mkdir -p "$FIXTURE"
git -C "$ROOT" archive HEAD | tar -x -C "$FIXTURE"

git -C "$FIXTURE" init -q
git -C "$FIXTURE" config user.email test@example.com
git -C "$FIXTURE" config user.name 'Package Scope Test'

mkdir -p "$FIXTURE/docs/superpowers/plans" "$FIXTURE/extensions/example"
private_path="/"'Users/example/private'
printf 'developer checkout: %s\n' "$private_path" >"$FIXTURE/docs/superpowers/plans/dev.md"
printf '{"maintainer":"maintainer@invalid.test"}\n' >"$FIXTURE/extensions/example/package-lock.json"
git -C "$FIXTURE" add .
git -C "$FIXTURE" commit -qm fixture

run_check() {
  LABWIRED_PACKAGE_ROOT="$FIXTURE" \
    NPM_CONFIG_CACHE="$TMP/npm-cache" \
    bash "$ROOT/scripts/check-public-package.sh"
}

if ! run_check >"$TMP/dev-only.out" 2>&1; then
  echo 'FAIL non-published development files failed the public package gate' >&2
  cat "$TMP/dev-only.out" >&2
  exit 1
fi

printf '\npublished leak: %s\n' "$private_path" >>"$FIXTURE/README.md"
if run_check >"$TMP/packed.out" 2>&1; then
  echo 'FAIL private path in packed README passed the public package gate' >&2
  exit 1
fi
grep -q 'README.md:.*private local path' "$TMP/packed.out"

echo 'ok   public-package-scope PASS'
