#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

require_text() {
  local file="$1" pattern="$2" message="$3"
  if ! grep -Eq "$pattern" "$ROOT/$file"; then
    printf 'FAIL %s: %s\n' "$file" "$message" >&2
    exit 1
  fi
}

for file in docs/USAGE.md docs/VERIFY.md docs/TESTING.md skills/develop/SKILL.md skills/desk-hw/SKILL.md; do
  [[ -f "$ROOT/$file" ]] || { echo "FAIL missing $file" >&2; exit 1; }
done

require_text docs/USAGE.md '\.labwired/hardware\.json' 'profile location is undocumented'
require_text docs/USAGE.md 'hardware plan --profile' 'read-only planning command is undocumented'
require_text docs/USAGE.md 'hardware run --profile' 'digest-confirmed execution is undocumented'
require_text docs/USAGE.md '\-\-confirm' 'digest confirmation flag is undocumented'
for provider in platformio make cmake prebuilt; do
  require_text docs/USAGE.md "$provider" "build provider $provider is undocumented"
done
require_text docs/USAGE.md 'labwired-sim' 'twin provider is undocumented'
for provider in serial RTT logic-csv network; do
  require_text docs/USAGE.md "$provider" "observation provider $provider is undocumented"
done
require_text docs/USAGE.md 'Windows' 'Windows invocation is undocumented'
require_text docs/USAGE.md 'macOS.*Linux' 'macOS/Linux invocation is undocumented'

for level in imported compiled model_observed surrogate_model_observed hardware_observed untrusted_observation blocked failed; do
  require_text docs/VERIFY.md "${level}" "claim level ${level} is undocumented"
done
require_text docs/VERIFY.md '[Ss]erial.*(not|never).*GPIO|GPIO.*(not|never).*[Ss]erial' 'serial/GPIO evidence boundary is undocumented'
require_text docs/VERIFY.md 'nonce' 'Wi-Fi challenge correlation is undocumented'
require_text docs/VERIFY.md 'external.*receipt|receipt.*external' 'external receipt verification is undocumented'
require_text docs/VERIFY.md 'Arduino' 'Arduino twin format limitation is undocumented'
require_text docs/VERIFY.md 'exact physical flash' 'unsupported twin physical fallback is undocumented'
require_text docs/VERIFY.md 'BLOCKED' 'strict physical lane missing-profile behavior is undocumented'
require_text docs/VERIFY.md 'reserved.*untrusted_observation|untrusted_observation.*reserved' 'reserved untrusted level is undocumented'
require_text docs/USAGE.md 'Ordinary.*BLOCKED' 'ordinary blocked exit behavior is undocumented'
require_text docs/USAGE.md 'results.*exit `3`' 'ordinary blocked/fail exit code is undocumented'
require_text scripts/hardware-runner.mjs "return parsed\?\.command === 'run'.*\? 2.*: 3" 'documented exit meanings are not tied to runner constants'

require_text docs/TESTING.md 'hardware-release-contract' 'release hardware lane is undocumented'
require_text docs/TESTING.md 'windows-hardware-contract' 'Windows hardware lane is undocumented'
require_text docs/TESTING.md 'probe-exact-flash' 'exact flash lane is undocumented'
require_text skills/develop/SKILL.md 'checked-in.*hardware profile|checked-in.*\.labwired/hardware\.json' 'develop does not prefer a checked-in profile'
require_text skills/develop/SKILL.md 'never.*auto-confirm|must not.*auto-confirm' 'develop does not forbid automatic physical confirmation'
require_text skills/desk-hw/SKILL.md 'ambiguous' 'desk-hw does not stop on ambiguous identity'
require_text skills/desk-hw/SKILL.md '[Ss]erial.*(not|never).*GPIO|GPIO.*(not|never).*[Ss]erial' 'desk-hw confuses serial with GPIO evidence'
require_text skills/desk-hw/SKILL.md 'plan.*first|plan before' 'desk-hw does not plan first'
require_text skills/desk-hw/SKILL.md 'probeSerial' 'desk-hw omits explicit probe identity'
require_text skills/desk-hw/SKILL.md 'serialPort' 'desk-hw omits explicit port identity'
if grep -Eq -- '--target virtual|LABWIRED_RTT_FIXTURE|serial-capture.*mint.*hardware_observed|Either path can mint' "$ROOT/skills/desk-hw/SKILL.md"; then
  echo 'FAIL skills/desk-hw/SKILL.md: nonphysical shortcut remains in physical promotion guidance' >&2
  exit 1
fi

for lane in \
  'node --test tests/hardware-\*\.test\.mjs' \
  'tests/hardware-cli\.sh' \
  'tests/hardware-legacy-compat\.sh' \
  'tests/hardware-release-contract\.sh' \
  'tests/hardware-matrix-order\.sh' \
  'tests/probe-exact-flash\.sh' \
  'tests/windows-hardware-contract\.ps1'; do
require_text tests/all.sh "$lane" "hardware matrix lane $lane is not registered"
done
require_text tests/all.sh 'mktemp -d.*\$ROOT/\.labwired-test' 'hardware lanes do not use workspace-volume temp isolation'
require_text tests/hardware-matrix-order.sh 'mktemp -d.*\$ROOT/\.labwired-matrix' 'matrix regression does not use workspace-volume temp isolation'

if grep -Eq 'skip.*(hardware|Windows)|not run.*hardware-(cli|legacy|release)|not run.*probe-exact-flash' "$ROOT/tests/all.sh"; then
  echo 'FAIL tests/all.sh: stale hard-coded hardware skip' >&2
  exit 1
fi

echo 'PASS generic hardware public documentation contract'
