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
bin/labwired probe help >/dev/null
test -f fixtures/gate1/oracle.json
test -f fixtures/gate1/artifacts/broken.verify.json
test -f fixtures/gate1/artifacts/fixed.verify.json
grep -q LABWIRED_OK fixtures/gate1/fixed/main.c
! grep -q LABWIRED_OK fixtures/gate1/broken/main.c

echo "==> Gate 1 claim artifacts (offline shapes)"
bin/labwired assert-status failed fixtures/gate1/artifacts/broken.verify.json
bin/labwired assert-status model_verified fixtures/gate1/artifacts/fixed.verify.json

if [[ "${DEMO_LIVE_GATE1:-0}" == "1" ]]; then
  echo "==> Gate 1 live twin"
  bash scripts/live-gate1.sh
fi

echo "==> doctor (may warn if OpenCode/sim not installed)"
if bin/labwired doctor; then
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
