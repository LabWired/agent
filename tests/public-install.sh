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

if grep -q 'https://labwired.com/install/agent' "$ROOT/scripts/public/install" \
  && grep -q 'https://labwired.com/install/agent' "$ROOT/scripts/agent-install.sh"; then
  echo "ok   public agent install URL"
else
  echo "FAIL public scripts missing /install/agent URL"
  fail=1
fi
if grep -REq "https://labwired\\.com/install([[:space:]]|\"|'|$)" \
  "$ROOT/scripts/public/install" "$ROOT/scripts/agent-install.sh"; then
  echo "FAIL stale bare /install URL in public agent examples"
  fail=1
else
  echo "ok   no stale bare /install URL"
fi

if grep -q '\["--agent-only", \.\.\.args\]' "$ROOT/scripts/npm-install.js" \
  && grep -q 'psArgs.push("-AgentOnly")' "$ROOT/scripts/npm-install.js"; then
  echo "ok   npm installer defaults to Agent-only"
else
  echo "FAIL npm installer missing Agent-only defaults"
  fail=1
fi
if grep -q 'if (isPost) process.exit(0)' "$ROOT/scripts/npm-install.js"; then
  echo "ok   npm postinstall is non-mutating"
else
  echo "FAIL npm postinstall may install the product"
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
