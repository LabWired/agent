#!/usr/bin/env bash
# resolve-probe.sh — find probe-rs (multi-probe backend). Never require OpenOCD.
# shellcheck shell=bash

labwired_resolve_probe_rs() {
  if [[ -n "${LABWIRED_PROBE_RS:-}" && -x "${LABWIRED_PROBE_RS}" ]]; then
    echo "${LABWIRED_PROBE_RS}"
    return 0
  fi
  if command -v probe-rs >/dev/null 2>&1; then
    command -v probe-rs
    return 0
  fi
  # Common cargo install location
  if [[ -x "${HOME}/.cargo/bin/probe-rs" ]]; then
    echo "${HOME}/.cargo/bin/probe-rs"
    return 0
  fi
  return 1
}
