#!/usr/bin/env bash
# smoke.sh — prove install works (claim gate + sim + doctor bits)
# shellcheck shell=bash

labwired_smoke() {
  local root="${1:-${LABWIRED_AGENT_HOME:-}}"
  local home prefix fail=0
  home="$(labwired_prefix_home 2>/dev/null || echo "${LABWIRED_HOME:-$HOME/.labwired}")"
  prefix="$home"
  if [[ -z "$root" || ! -d "$root" ]]; then
    root="${home}/agent"
  fi

  printf '\033[36m==>\033[0m smoke: proving install works\n'

  # 1) launcher
  if [[ -x "${home}/bin/labwired" ]] || command -v labwired >/dev/null 2>&1; then
    printf '\033[32mok \033[0m launcher\n'
  else
    printf '\033[31mFAIL\033[0m launcher missing\n'
    fail=1
  fi

  # 2) claim gate (offline — no network)
  # shellcheck source=lib/assert-status.sh
  if [[ -f "$root/lib/assert-status.sh" ]]; then
    # shellcheck disable=SC1091
    source "$root/lib/assert-status.sh"
    if [[ -f "$root/share/smoke/status-parser-model-verified.json" ]]; then
      if labwired_assert_status model_verified <"$root/share/smoke/status-parser-model-verified.json" >/dev/null; then
        printf '\033[32mok \033[0m status parser accepts model_verified fixture (not a twin test)\n'
      else
        printf '\033[31mFAIL\033[0m claim-gate fixed\n'
        fail=1
      fi
    fi
    if [[ -f "$root/share/smoke/status-parser-failed.json" ]]; then
      if labwired_assert_status failed <"$root/share/smoke/status-parser-failed.json" >/dev/null; then
        printf '\033[32mok \033[0m status parser accepts failed fixture (not a twin test)\n'
      else
        printf '\033[31mFAIL\033[0m claim-gate broken\n'
        fail=1
      fi
    fi
  else
    printf '\033[33mwarn\033[0m assert-status lib missing\n'
  fi

  # 3) simulator binary
  local sim=""
  sim="$(labwired_resolve_sim 2>/dev/null || true)"
  if [[ -z "$sim" && -x "${home}/tools/sim/labwired-sim" ]]; then
    sim="${home}/tools/sim/labwired-sim"
  fi
  if [[ -n "$sim" && -x "$sim" ]]; then
    if "$sim" chips >/dev/null 2>&1 || "$sim" --version >/dev/null 2>&1; then
      printf '\033[32mok \033[0m simulator (%s)\n' "$("$sim" --version 2>/dev/null | head -1 || echo "$sim")"
    else
      printf '\033[33mwarn\033[0m simulator present but chips/version failed\n'
    fi
  else
    printf '\033[33mwarn\033[0m simulator missing (hosted MCP still works)\n'
  fi

  # 4) skills
  local n=0
  if [[ -d "$root/skills" ]]; then
    n="$(find "$root/skills" -name SKILL.md 2>/dev/null | wc -l | tr -d ' ')"
  fi
  if [[ "${n:-0}" -ge 21 ]]; then
    printf '\033[32mok \033[0m skills (%s)\n' "$n"
  else
    printf '\033[31mFAIL\033[0m skills incomplete (%s)\n' "${n:-0}"
    fail=1
  fi

  # 5) agent runtime (needed to run agent TUI)
  if command -v opencode >/dev/null 2>&1; then
    printf '\033[32mok \033[0m agent-runtime (%s)\n' "$(opencode --version 2>&1 | head -1 | tr -d '\n')"
  else
    printf '\033[33mwarn\033[0m agent-runtime not on PATH — re-run: curl -fsSL https://labwired.com/install | bash\n'
  fi

  if [[ "$fail" -eq 0 ]]; then
    printf '\033[32m==>\033[0m smoke PASS — run:  labwired\n'
    return 0
  fi
  printf '\033[31m==>\033[0m smoke FAIL — fix issues above\n'
  return 1
}
