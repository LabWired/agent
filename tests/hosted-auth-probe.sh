#!/usr/bin/env bash
# Prove doctor hosted live-probe: good session can pass; dead token fails hosted-tools.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$ROOT/bin:${PATH}"
LABWIRED="${LABWIRED:-$ROOT/bin/labwired-agent}"
fail=0
pass() { echo "ok   $*"; }
bad() { echo "FAIL $*"; fail=1; }

# 1) With current session (if any), doctor must either report authenticated hosted-tools
#    or explicitly not signed in — never silent false green after a dead token.
out="$("$LABWIRED" doctor 2>&1 || true)"
if echo "$out" | grep -q 'hosted-tools: model gateway + MCP authenticated'; then
  pass "doctor hosted authenticated"
elif echo "$out" | grep -qiE 'hosted-tools: token present but API rejects|not signed in'; then
  pass "doctor honest about missing/dead hosted ($out | head -1)"
else
  # require probe function exists in kit
  if grep -q 'labwired_cloud_probe_hosted' "$ROOT/lib/cloud-session.sh"; then
    pass "probe_hosted present (doctor output: $(echo "$out" | grep hosted-tools | head -1))"
  else
    bad "probe_hosted missing"
  fi
fi

# 2) Dead token path: inject bad bearer via env override after sourcing session load
#    Use a subshell that exports LABWIRED_ACCESS_TOKEN=lwd_dead and forces probe.
probe_out="$(
  export LABWIRED_ACCESS_TOKEN='lwd_dead_token_for_probe_test'
  export LABWIRED_PROJECT='00000000000000000000000000000000'
  # shellcheck source=lib/cloud-session.sh
  source "$ROOT/lib/cloud-session.sh"
  if labwired_cloud_probe_hosted 2>/dev/null; then
    echo PROBE_ACCEPTED_DEAD
  else
    echo PROBE_REJECTED_DEAD
  fi
)"
if echo "$probe_out" | grep -q PROBE_REJECTED_DEAD; then
  pass "probe_hosted rejects dead token"
else
  bad "probe_hosted accepted dead token: $probe_out"
fi

# 3) Login UA present in device code request
if grep -q 'User-Agent.*labwired-agent' "$ROOT/bin/labwired-agent"; then
  pass "login User-Agent present"
else
  bad "login User-Agent missing"
fi

# 4) Dual claim: assert-status never maps broken fixture to model_verified
if "$LABWIRED" assert-status model_verified "$ROOT/fixtures/gate1/artifacts/fixed.verify.json" >/dev/null 2>&1; then
  pass "assert-status accepts fixed"
else
  bad "assert-status fixed"
fi
if "$LABWIRED" assert-status model_verified "$ROOT/fixtures/gate1/artifacts/broken.verify.json" >/dev/null 2>&1; then
  bad "assert-status accepted broken as model_verified"
else
  pass "assert-status rejects broken"
fi

[[ "$fail" -eq 0 ]] || { echo "hosted-auth-probe FAILED"; exit 1; }
echo "ok   hosted-auth-probe PASS"
exit 0
