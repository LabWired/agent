#!/usr/bin/env bash
# Syntax + dry checks for public install entrypoints (Cursor-style).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail=0

bash -n "$ROOT/scripts/public/install" || fail=1
bash -n "$ROOT/scripts/agent-install.sh" || fail=1
bash -n "$ROOT/install.sh" || fail=1
bash -n "$ROOT/lib/update.sh" || fail=1
bash -n "$ROOT/lib/smoke.sh" || fail=1
bash -n "$ROOT/lib/prefix.sh" || fail=1
bash -n "$ROOT/lib/install-deps.sh" || fail=1
bash -n "$ROOT/bin/labwired" || fail=1
bash -n "$ROOT/bin/labwired-agent" || fail=1

# Public install must mention windows redirect and tarball/codeload
if grep -q 'win32\|Windows' "$ROOT/scripts/public/install"; then
  echo "ok   public/install mentions Windows path"
else
  echo "FAIL public/install missing Windows note"
  fail=1
fi
if grep -q 'codeload\|tar.gz\|tarball' "$ROOT/scripts/public/install"; then
  echo "ok   public/install uses fast tarball path"
else
  echo "FAIL public/install missing tarball path"
  fail=1
fi

# Windows scripts exist
for f in scripts/public/install.ps1 scripts/install.ps1 bin/labwired.ps1 bin/labwired.cmd; do
  if [[ -f "$ROOT/$f" ]]; then
    echo "ok   $f"
  else
    echo "FAIL missing $f"
    fail=1
  fi
done

# Deploy notes
if [[ -f "$ROOT/scripts/public/DEPLOY.md" ]]; then
  echo "ok   DEPLOY.md"
else
  echo "FAIL DEPLOY.md missing"
  fail=1
fi

if [[ "$fail" -ne 0 ]]; then
  echo "public-install FAILED"
  exit 1
fi
echo "ok   public-install PASS"
