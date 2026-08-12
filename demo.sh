#!/usr/bin/env bash
# One-command smoke path for the LabWired agent harness.
# Unit level always runs offline; doctor is soft-fail unless DEMO_REQUIRE_DOCTOR=1.
# Optional live claim check: DEMO_LIVE_VERIFY=1 DEMO_VERIFY_JSON=path/to/payload.json
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "==> harness unit tests"
bash tests/harness.sh

echo "==> skill + fixture shape"
for skill in \
  golden-path bringup prove observe desk-hw \
  using-superpowers test-driven-development
do
  test -f "skills/$skill/SKILL.md"
done
# probe help must work without hardware
bin/labwired-agent probe help >/dev/null
test -f share/smoke/status-parser-failed.json
test -f share/smoke/status-parser-model-verified.json

echo "==> Status parser contract fixtures (not a twin test)"
bin/labwired-agent assert-status failed share/smoke/status-parser-failed.json
bin/labwired-agent assert-status model_verified share/smoke/status-parser-model-verified.json

if [[ "${DEMO_LIVE_GATE1:-0}" == "1" ]]; then
  echo "==> Gate 1 live twin"
  bash scripts/live-gate1.sh
fi

echo "==> doctor (may warn if agent runtime / sim not installed)"
if bin/labwired-agent doctor; then
  echo "doctor: clean"
else
  echo "doctor: incomplete environment (unit tests still passed)"
  echo "Install pin + sim, then re-run for full green."
  # Exit 0 for unit-level demo success; use DEMO_REQUIRE_DOCTOR=1 for strict
  if [[ "${DEMO_REQUIRE_DOCTOR:-0}" == "1" ]]; then
    exit 1
  fi
fi

echo "==> optional live verify"
if [[ "${DEMO_LIVE_VERIFY:-0}" == "1" ]]; then
  : "${DEMO_VERIFY_JSON:?set DEMO_VERIFY_JSON to a labwired_verify payload file}"
  bin/labwired assert-status model_verified "$DEMO_VERIFY_JSON"
fi

echo "demo.sh: OK"
