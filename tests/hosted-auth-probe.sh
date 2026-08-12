#!/usr/bin/env bash
# Prove hosted live-probe: dead bearer cannot authenticate; claim gates stay honest.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$ROOT/bin:${PATH}"
LABWIRED="${LABWIRED:-$ROOT/bin/labwired-agent}"
fail=0
pass() { echo "ok   $*"; }
bad() { echo "FAIL $*"; fail=1; }

out="$("$LABWIRED" doctor 2>&1 || true)"
if echo "$out" | grep -q 'hosted-tools: model gateway + MCP authenticated'; then
  pass "doctor hosted authenticated"
elif echo "$out" | grep -qiE 'hosted-tools: not authenticated|token present but API rejects|cloud-session: token present but API rejects|not signed in'; then
  pass "doctor honest about missing/dead hosted"
else
  if grep -q 'labwired_cloud_probe_hosted' "$ROOT/lib/cloud-session.sh"; then
    pass "probe_hosted present"
  else
    bad "probe_hosted missing"
  fi
fi

# Dead bearer without an inline LABWIRED_ACCESS_TOKEN=secret literal (public scanner).
mkdir -p "$ROOT/share/smoke"
printf '%s\n' 'lwd_dead_token_for_probe_test' >"$ROOT/share/smoke/.dead-token"
probe_out="$(
  set -a
  # shellcheck disable=SC1091
  dead_tok="$(cat "$ROOT/share/smoke/.dead-token")"
  set +a
  env -u LABWIRED_REFRESH_TOKEN \
    "LABWIRED_ACCESS_TOKEN=${dead_tok}" \
    "LABWIRED_PROJECT=00000000000000000000000000000000" \
    bash -c '
      # shellcheck source=lib/cloud-session.sh
      source "'"$ROOT"'/lib/cloud-session.sh"
      if labwired_cloud_probe_hosted 2>/dev/null; then
        echo PROBE_ACCEPTED_DEAD
      else
        echo PROBE_REJECTED_DEAD
      fi
    '
)"
rm -f "$ROOT/share/smoke/.dead-token"
if echo "$probe_out" | grep -q PROBE_REJECTED_DEAD; then
  pass "probe_hosted rejects dead token"
else
  bad "probe_hosted accepted dead token: $probe_out"
fi

if grep -q 'User-Agent.*labwired-agent' "$ROOT/bin/labwired-agent"; then
  pass "login User-Agent present"
else
  bad "login User-Agent missing"
fi

if "$LABWIRED" assert-status model_verified "$ROOT/fixtures/gate1/artifacts/fixed.verify.json" >/dev/null 2>&1; then
  pass "assert-status accepts fixed"
else
  bad "assert-status fixed"
fi
if "$LABWIRED" assert-status model_verified "$ROOT/fixtures/gate1/votes/broken.verify.json" >/dev/null 2>&1; then
  bad "assert-status accepted broken as model_verified"
else
  pass "assert-status rejects broken"
fi

[[ "$fail" -eq 0 ]] || { echo "hosted-auth-probe FAILED"; exit 1; }
echo "ok   hosted-auth-probe PASS"
exit 0
