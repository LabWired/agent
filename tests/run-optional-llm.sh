#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ "${LABWIRED_TEST_LLM:-1}" != "1" ]]; then
  echo "not run llm-deepinfra: LABWIRED_TEST_LLM=0"
  exit 0
fi

if ! bash "$ROOT/tests/llm-deepinfra.sh" --check; then
  echo "not run llm-deepinfra: DEEPINFRA_API_KEY not set"
  exit 0
fi

echo ""
echo "======== llm-deepinfra ========"
if bash "$ROOT/tests/llm-deepinfra.sh"; then
  echo "PASS llm-deepinfra"
else
  echo "FAIL llm-deepinfra"
  exit 1
fi
