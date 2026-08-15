#!/usr/bin/env bash
set -euo pipefail

ROOT="${LABWIRED_PACKAGE_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
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

# Live GitHub Pages serves flat install endpoints. Nested /install/agent is 404.
reject 'https://labwired\.com/install/agent' 'use https://labwired.com/install (macOS/Linux) or https://labwired.com/install.ps1 (Windows)'
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
  if ! node - "$ROOT" "$PACK_JSON" "${PUBLIC_DOCS[@]}" <<'NODE'
const fs = require('fs');
const path = require('path');
const [root, reportPath, ...publicDocs] = process.argv.slice(2);
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
  'lib/serial-challenge.ps1',
  'lib/serial-capture.ps1', 'lib/rtt-capture.ps1', 'lib/probe-flash.ps1',
  'lib/hardware/adapters.mjs', 'lib/hardware/evidence.mjs',
  'lib/hardware/locks.mjs', 'lib/hardware/process.mjs',
  'lib/hardware/profile.mjs', 'lib/hardware/runner.mjs',
  'scripts/hardware-runner.mjs',
  'fixtures/hardware-profiles/esp32c3-acceptance.template.json',
  'fixtures/hardware-profiles/minimal.json',
  'fixtures/hardware-profiles/logic/led-pass.csv',
  'fixtures/hardware-profiles/logic/led-flat.csv',
  'server/rpc-server.mjs', 'server/agent-launcher.mjs', 'share/smoke/status-parser-model-verified.json',
  'share/smoke/status-parser-failed.json', 'scripts/profiles/esp32c3-serial.sh',
  'examples/esp32c3-serial/platformio.ini', 'examples/esp32c3-serial/src/main.cpp'
];
for (const file of required) {
  if (!files.has(file)) fail(file, 0, 'required public package file is missing');
}
const devCycle = fs.readFileSync(path.join(root, 'scripts/dev-cycle.sh'), 'utf8');
if (!devCycle.includes('scripts/profiles/esp32c3-serial.sh'))
  fail('scripts/dev-cycle.sh', 0, 'public profile reference is missing');

const requiredSkills = [
  'golden-path', 'bringup', 'prove', 'observe', 'desk-hw', 'import-circuit',
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

const allowedFixtures = new Set([
  'fixtures/hardware-profiles/esp32c3-acceptance.template.json',
  'fixtures/hardware-profiles/minimal.json',
  'fixtures/hardware-profiles/logic/led-pass.csv',
  'fixtures/hardware-profiles/logic/led-flat.csv',
]);
const forbiddenPath = /(^|\/)(tests?|fixtures|\.grok|screenshots?|images?|local[-_]?evidence|competitors?)(\/|$)|^docs\/(qa|product|superpowers)\/|(^|\/)(cursor|claude|copilot|windsurf)([._/-]|$)|\.(png|jpe?g|gif|webp|yml)$/i;
const forbiddenSkillArtifact = /skills\/systematic-debugging\/(CREATION-LOG\.md|test-academic\.md|test-pressure-[123]\.md)$/;
for (const file of files) {
  if ((!allowedFixtures.has(file) && forbiddenPath.test(file)) || forbiddenSkillArtifact.test(file)) fail(file, 0, 'forbidden public package path');
  if (/(^|\/)(\.labwired|node_modules|evidence|credentials?|secrets?|machine-profiles?)(\/|$)/i.test(file)) {
    fail(file, 0, 'private, generated, or machine-local path must not be published');
  }
}

const publicSources = new Set([...files, ...publicDocs]);

const { scanBuffer } = require(path.join(root, 'scripts/check-public-text.js'));
for (const file of [...publicSources].sort()) {
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
  scanBuffer(fs.readFileSync(absolute), file, fail);
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
