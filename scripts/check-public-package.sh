#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PUBLIC_DOCS=(README.md docs/INSTALL.md docs/USAGE.md docs/VERIFY.md)
fail=0

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

reject 'https://labwired\.com/install([[:space:]]|`|\||$)' 'use https://labwired.com/install/agent'
reject '/agent-install\.sh' 'use the public /install/agent endpoint'
reject '(^|[^[:alnum:]_-])labwired doctor([^[:alnum:]_-]|$)' 'use labwired agent doctor'
reject '(^|[^[:alnum:]_-])labwired login([^[:alnum:]_-]|$)' 'use labwired agent login'
reject 'Gate 1' 'replace the internal gate name with plain language'
reject 'harness dump' 'replace the internal test term with plain language'
reject 'distribution layer' 'replace the internal architecture term with plain language'

STATUS_PATTERN='(^|[^[:alnum:]_])(model_verified|hardware_observed|failed|inconclusive|unsupported)([^[:alnum:]_]|$)'
for file in README.md docs/INSTALL.md docs/USAGE.md; do
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

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi

echo "ok   public documentation language"
