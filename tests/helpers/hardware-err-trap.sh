#!/usr/bin/env bash

hardware_test_err_trace() {
  local rc="$1" line="$2" command="$3" label="$4" safe
  if [[ "${LABWIRED_TEST_DEBUG:-0}" == 1 || -n "${LABWIRED_TEST_TRACE_FILE:-}" ]]; then
    command="${command//$'\n'/ }"
    command="${command:0:320}"
    safe="$(printf '%s' "$command" | sed -E \
      -e 's/(api[_-]?key|token|password|secret)([=:][^[:space:]]*)?/\1=[REDACTED]/Ig' \
      -e 's/sk-[A-Za-z0-9_-]+/[REDACTED]/g')"
    if [[ -n "${LABWIRED_TEST_TRACE_FILE:-}" ]]; then
      printf '%s: TRACE line=%s rc=%s command=%s\n' "$label" "$line" "$rc" "$safe" \
        >>"$LABWIRED_TEST_TRACE_FILE"
    fi
    if [[ "${LABWIRED_TEST_DEBUG:-0}" == 1 ]]; then
      printf '%s: TRACE line=%s rc=%s command=%s\n' "$label" "$line" "$rc" "$safe" >&2
    fi
  fi
  return "$rc"
}
