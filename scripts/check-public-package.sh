#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PUBLIC_DOCS=(README.md docs/INSTALL.md docs/USAGE.md docs/VERIFY.md docs/DEVELOPMENT.md docs/TESTING.md scripts/public/DEPLOY.md)
fail=0
PACK_JSON="$(mktemp "${TMPDIR:-/tmp}/labwired-pack.XXXXXX")"
trap 'rm -f "$PACK_JSON"' EXIT

for file in "${PUBLIC_DOCS[@]}"; do
  if [[ ! -f "$ROOT/$file" ]]; then
    printf 'FAIL %s: required public document is missing\n' "$file" >&2
    fail=1
  fi
done

reject() {
  local pattern="$1" message="$2" file matches
  for file in "${PUBLIC_DOCS[@]}"; do
    [[ -f "$ROOT/$file" ]] || continue
    matches="$(grep -nE "$pattern" "$ROOT/$file" || true)"
    if [[ -n "$matches" ]]; then
      while IFS= read -r match; do
        printf 'FAIL %s:%s: %s\n' "$file" "${match%%:*}" "$message" >&2
      done <<<"$matches"
      fail=1
    fi
  done
}

reject 'https://labwired\.com/install([^/[:alnum:]]|$)' 'use https://labwired.com/install/agent'
reject '/agent-install\.sh' 'use the public /install/agent endpoint'
reject '(^|[^[:alnum:]_-])labwired doctor([^[:alnum:]_-]|$)' 'use labwired agent doctor'
reject '(^|[^[:alnum:]_-])labwired login([^[:alnum:]_-]|$)' 'use labwired agent login'
reject 'Gate 1' 'replace the internal gate name with plain language'
reject 'harness dump' 'replace the internal test term with plain language'
reject 'distribution layer' 'replace the internal architecture term with plain language'

STATUS_PATTERN='(^|[^[:alnum:]_])(model_verified|hardware_observed|failed|inconclusive|unsupported)([^[:alnum:]_]|$)'
for file in README.md docs/INSTALL.md docs/USAGE.md docs/DEVELOPMENT.md docs/TESTING.md scripts/public/DEPLOY.md; do
  [[ -f "$ROOT/$file" ]] || continue
  matches="$(grep -nE "$STATUS_PATTERN" "$ROOT/$file" || true)"
  if [[ -n "$matches" ]]; then
    while IFS= read -r match; do
      printf 'FAIL %s:%s: exact evidence statuses belong only in docs/VERIFY.md or config/AGENTS.md\n' \
        "$file" "${match%%:*}" >&2
    done <<<"$matches"
    fail=1
  fi
done

if ! (cd "$ROOT" && npm pack --dry-run --json >"$PACK_JSON"); then
  printf 'FAIL package.json: npm pack --dry-run failed\n' >&2
  fail=1
else
  if ! node - "$ROOT" "$PACK_JSON" <<'NODE'
const fs = require('fs');
const path = require('path');
const [root, reportPath] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const files = new Set((report[0]?.files || []).map(entry => entry.path));
let failed = false;

function fail(file, line, message) {
  process.stderr.write(`FAIL ${file}:${line}: ${message}\n`);
  failed = true;
}

const required = [
  'README.md', 'LICENSE', 'CHANGELOG.md', 'VERSION',
  'bin/labwired', 'bin/labwired-agent', 'bin/labwired.cmd',
  'bin/labwired.ps1', 'bin/labwired-agent.ps1',
  'config/AGENTS.md',
  'docs/INSTALL.md', 'docs/USAGE.md', 'docs/VERIFY.md',
  'docs/DEVELOPMENT.md', 'docs/TESTING.md',
  'install.sh', 'scripts/npm-install.js', 'scripts/agent-install.sh',
  'scripts/agent-install.ps1', 'scripts/install.ps1',
  'scripts/public/install', 'scripts/public/install.ps1',
  'lib/dispatch.sh', 'lib/prefix.sh', 'lib/resolve-sim.sh',
  'server/rpc-server.mjs'
];
for (const file of required) {
  if (!files.has(file)) fail(file, 0, 'required public package file is missing');
}

const requiredSkills = [
  'golden-path', 'bringup', 'prove', 'observe', 'desk-hw',
  'using-superpowers', 'brainstorming', 'writing-plans',
  'test-driven-development', 'systematic-debugging',
  'verification-before-completion', 'dispatching-parallel-agents',
  'executing-plans', 'subagent-driven-development',
  'requesting-code-review', 'receiving-code-review',
  'finishing-a-development-branch', 'using-git-worktrees', 'writing-skills'
];
for (const skill of requiredSkills) {
  const file = `skills/${skill}/SKILL.md`;
  if (!files.has(file)) fail(file, 0, 'required runtime skill is missing');
}

const forbiddenPath = /(^|\/)(tests?|\.grok|screenshots?|images?|local[-_]?evidence|competitors?)(\/|$)|^docs\/(qa|product|superpowers)\/|^fixtures\/(coverage|smoke)\/|(^|\/)(cursor|claude|copilot|windsurf)([._/-]|$)|\.(png|jpe?g|gif|webp|yml)$/i;
for (const file of files) {
  if (forbiddenPath.test(file)) fail(file, 0, 'forbidden public package path');
}

const publicSources = new Set(files);
for (const file of [
  'install.sh', 'scripts/npm-install.js', 'scripts/agent-install.sh',
  'scripts/agent-install.ps1', 'scripts/install.ps1',
  'scripts/public/install', 'scripts/public/install.ps1',
  'config/AGENTS.md', 'config/opencode.json', 'config/opencode.hosted.json',
  'config/opencode.deepinfra.json', 'config/opencode.airgap.json', 'config/tui.json'
]) publicSources.add(file);

const email = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const assignments = /\b(DEEPINFRA_API_KEY|LABWIRED_ACCESS_TOKEN)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s;#]+))/g;
for (const file of [...publicSources].sort()) {
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
  const data = fs.readFileSync(absolute);
  if (data.includes(0)) continue;
  const lines = data.toString('utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    const number = index + 1;
    if (line.includes('/Users/')) fail(file, number, 'private local path');
    if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(line)) fail(file, number, 'private key header');
    for (const match of line.matchAll(email)) {
      if (match[0].toLowerCase() !== 'example@example.com') fail(file, number, 'real email address');
    }
    for (const match of line.matchAll(assignments)) {
      const value = match[2] ?? match[3] ?? match[4];
      const dynamic = /[$({\[]/.test(value);
      if (!dynamic && value !== 'test-token' && !(match[1] === 'DEEPINFRA_API_KEY' && value === '…')) {
        fail(file, number, `assigned ${match[1]} secret value`);
      }
    }
  });
}

if (failed) process.exit(1);
process.stdout.write(`ok   public package contents (${files.size} files)\n`);
NODE
  then
    fail=1
  fi
fi

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi

echo "ok   public documentation language"
