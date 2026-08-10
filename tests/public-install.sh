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

if bash "$ROOT/scripts/check-public-package.sh"; then
  echo "ok   public package release check"
else
  echo "FAIL public package release check"
  fail=1
fi

pack_dir="$(mktemp -d "${TMPDIR:-/tmp}/labwired-public-install.XXXXXX")"
trap 'rm -rf "$pack_dir" "${llm_home:-}"' EXIT
if (cd "$ROOT" && npm pack --json --pack-destination "$pack_dir" >"$pack_dir/report.json"); then
  tarball="$(node -e 'const r=require(process.argv[1]); process.stdout.write(r[0].filename)' "$pack_dir/report.json")"
  tar -xzf "$pack_dir/$tarball" -C "$pack_dir"
  if HOME="$pack_dir/home" bash "$pack_dir/package/bin/labwired-agent" --help >/dev/null; then
    echo "ok   packed agent launcher starts"
  else
    echo "FAIL packed agent launcher"
    fail=1
  fi
else
  echo "FAIL npm package tarball"
  fail=1
fi

for doc in INSTALL USAGE VERIFY DEVELOPMENT TESTING; do
  if node -e 'const p=require(process.argv[1]); process.exit(p.files.includes(`docs/${process.argv[2]}.md`) ? 0 : 1)' \
    "$ROOT/package.json" "$doc"; then
    echo "ok   package includes docs/$doc.md"
  else
    echo "FAIL package missing docs/$doc.md"
    fail=1
  fi
done

# Public install must mention windows redirect and tarball/codeload
if grep -q 'win32\|Windows' "$ROOT/scripts/public/install"; then
  echo "ok   public/install mentions Windows path"
else
  echo "FAIL public/install missing Windows note"
  fail=1
fi

llm_home="$(mktemp -d)"
llm_missing="$(HOME="$llm_home" env -u DEEPINFRA_API_KEY bash "$ROOT/tests/llm-deepinfra.sh")"
if grep -q '^not run llm-deepinfra:' <<<"$llm_missing" \
  && ! grep -q 'PASS llm-deepinfra' <<<"$llm_missing"; then
  echo "ok   missing model key is not run"
else
  echo "FAIL missing model key result is dishonest"
  fail=1
fi

llm_matrix="$(HOME="$llm_home" env -u DEEPINFRA_API_KEY bash "$ROOT/tests/run-optional-llm.sh")"
if grep -q '^not run llm-deepinfra:' <<<"$llm_matrix" \
  && ! grep -q 'PASS llm-deepinfra' <<<"$llm_matrix"; then
  echo "ok   default matrix model lane is not run"
else
  echo "FAIL default matrix model lane result is dishonest"
  fail=1
fi

llm_fixture="$llm_home/response.json"
printf '%s\n' '{"choices":[{"message":{"content":"Twin verification requires matching the fixed expected behavior."}}]}' >"$llm_fixture"
if HOME="$llm_home" DEEPINFRA_API_KEY=fixture \
  LABWIRED_LLM_RESPONSE_FILE="$llm_fixture" bash "$ROOT/tests/llm-deepinfra.sh" \
  | grep -q 'ok   llm-deepinfra PASS'; then
  echo "ok   model response fixture parses without network"
else
  echo "FAIL model response fixture parser"
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

if grep -Eq 'echo .*\bskip(ped)?\b' \
  "$ROOT/tests/llm-deepinfra.sh" "$ROOT/tests/run-optional-llm.sh" "$ROOT/tests/all.sh" "$ROOT/scripts/dev-cycle.sh"; then
  echo "FAIL optional lanes must report not run"
  fail=1
elif grep -q 'not run llm-deepinfra' "$ROOT/tests/llm-deepinfra.sh" \
  && grep -q 'not run install-smoke' "$ROOT/tests/all.sh" \
  && grep -q 'not run llm-deepinfra' "$ROOT/tests/run-optional-llm.sh" \
  && grep -q 'twin not run' "$ROOT/scripts/dev-cycle.sh" \
  && grep -q 'desk not run' "$ROOT/scripts/dev-cycle.sh"; then
  echo "ok   optional lanes report not run"
else
  echo "FAIL optional lanes missing not run output"
  fail=1
fi

# Windows scripts exist
for f in scripts/public/install.ps1 scripts/install.ps1 bin/labwired.ps1 bin/labwired-agent.ps1 bin/labwired.cmd tests/windows-contract.ps1; do
  if [[ -f "$ROOT/$f" ]]; then
    echo "ok   $f"
  else
    echo "FAIL missing $f"
    fail=1
  fi
done

if grep -q '\[switch\]\$AgentOnly' "$ROOT/scripts/install.ps1" \
  && grep -q -- '-AgentOnly' "$ROOT/scripts/public/install.ps1" \
  && grep -Fq 'components\core\bin' "$ROOT/scripts/install.ps1" \
  && grep -Fq 'Join-Path $UserBin "labwired.exe"' "$ROOT/scripts/install.ps1" \
  && grep -q 'Assert-NoReparseAncestors' "$ROOT/scripts/install.ps1" \
  && grep -q 'Stage-AgentKit' "$ROOT/scripts/install.ps1" \
  && grep -q 'Restore-AgentKit' "$ROOT/scripts/install.ps1" \
  && grep -q 'LABWIRED_CORE_COMMAND_CONTRACT=argv-v1' "$ROOT/scripts/install.ps1" \
  && grep -q 'ConvertTo-WindowsNativeArgument' "$ROOT/bin/labwired.ps1" \
  && grep -q 'Diagnostics.ProcessStartInfo' "$ROOT/bin/labwired.ps1" \
  && grep -q 'native-argv-echo.cs' "$ROOT/tests/windows-contract.ps1" \
  && ! grep -q '& \$Path --version' "$ROOT/scripts/install.ps1"; then
  echo "ok   Windows installer/dispatcher static checks"
else
  echo "FAIL Windows installer/dispatcher static checks incomplete"
  fail=1
fi

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
