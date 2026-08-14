#!/usr/bin/env bash
# Legacy physical-desk translator. Exit 0=observed, 2=NEED_PROBE/confirmation, 1=failure.
set -euo pipefail
# Give each asynchronous CLI invocation its own process group so cancellation
# reaches provider descendants as well as the CLI leader.
set -m
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABWIRED="${LABWIRED:-$ROOT/bin/labwired-agent}"
ELF="${LABWIRED_HW_ELF:-}"
CHIP="${LABWIRED_HW_CHIP:-}"
PORT="${LABWIRED_HW_PORT:-}"
PROBE_SERIAL="${LABWIRED_HW_PROBE_SERIAL:-}"
MARKER="${LABWIRED_HW_MARKER:-LABWIRED_OK}"
BAUD="${LABWIRED_HW_BAUD:-115200}"
TIMEOUT="${LABWIRED_HW_TIMEOUT:-8}"
OUT="${LABWIRED_HW_OUT:-$ROOT/fixtures/coverage/smoke/desk-hw-physical}"
CONFIRM="${LABWIRED_HW_CONFIRM:-}"

if [[ "${LABWIRED_HW_FORCE_NEED_PROBE:-0}" == 1 ]]; then
  echo 'NEED_PROBE' >&2; echo 'desk-hw-physical: forced NEED_PROBE' >&2; exit 2
fi
[[ -n "$ELF" && -n "$CHIP" && -n "$PORT" && -n "$PROBE_SERIAL" ]] || {
  echo 'desk-hw-physical: set LABWIRED_HW_ELF, LABWIRED_HW_CHIP, LABWIRED_HW_PORT, and LABWIRED_HW_PROBE_SERIAL' >&2; exit 1;
}
[[ -f "$ELF" ]] || { echo "desk-hw-physical: ELF not found: $ELF" >&2; exit 1; }
[[ "$BAUD" == 115200 ]] || { echo 'desk-hw-physical: generic serial provider currently supports LABWIRED_HW_BAUD=115200 only' >&2; exit 1; }
[[ "$TIMEOUT" =~ ^[1-9][0-9]*$ ]] || { echo 'desk-hw-physical: LABWIRED_HW_TIMEOUT must be a positive integer' >&2; exit 1; }

WORKSPACE="$(cd "$(dirname "$ELF")" && pwd)"
ARTIFACT="$(python3 -c 'import os,sys; print(os.path.relpath(sys.argv[1],sys.argv[2]))' "$ELF" "$WORKSPACE")"
PROFILE="$(mktemp "$WORKSPACE/.labwired-legacy-profile.XXXXXX.json")"
PLAN_OUTPUT="$(mktemp "$WORKSPACE/.labwired-legacy-plan.XXXXXX.json")"
CHILD_PID=""
reap_child() {
  local signal="${1:-TERM}" pid="$CHILD_PID"
  [[ -n "$pid" ]] || return 0
  kill -"$signal" -- "-$pid" 2>/dev/null || kill -"$signal" "$pid" 2>/dev/null || true
  set +e; wait "$pid" 2>/dev/null; set -e
  [[ "$CHILD_PID" == "$pid" ]] && CHILD_PID=""
}
handle_signal() { local signal="$1" code="$2"; reap_child "$signal"; exit "$code"; }
cleanup() {
  [[ -z "$CHILD_PID" ]] || reap_child TERM
  rm -f "$PROFILE" "$PLAN_OUTPUT"
}
trap cleanup EXIT
trap 'handle_signal INT 130' INT
trap 'handle_signal TERM 143' TERM
python3 - "$PROFILE" "$CHIP" "$PORT" "$PROBE_SERIAL" "$MARKER" "$TIMEOUT" "$ARTIFACT" <<'PY'
import json,sys
profile,chip,port,probe,marker,timeout,artifact=sys.argv[1:]
doc={"schema":1,"target":{"id":"legacy-desk","chip":chip,"probeSerial":probe,"serialPort":port},
 "build":{"provider":"prebuilt","workspace":".","environment":"imported","artifact":artifact},
 "flash":{"provider":"probe-rs"},
 "observations":[{"id":"legacy-hardware-serial","provider":"serial","contains":marker,
                  "timeoutSeconds":int(timeout),"requiredLevel":"hardware_observed"}]}
with open(profile,"w",encoding="utf-8") as f: json.dump(doc,f,separators=(",",":")); f.write("\n")
PY

"$LABWIRED" hardware plan --profile "$PROFILE" --out "$OUT" >"$PLAN_OUTPUT" & CHILD_PID=$!
set +e; wait "$CHILD_PID"; PLAN_RC=$?; set -e; CHILD_PID=""
if [[ "$PLAN_RC" -ne 0 ]]; then [[ "$PLAN_RC" -eq 2 || "$PLAN_RC" -eq 3 ]] && exit 2; exit 1; fi
PLAN="$(<"$PLAN_OUTPUT")"
printf '%s\n' "$PLAN"
DIGEST="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["digest"])' <<<"$PLAN")" || { echo 'desk-hw-physical: invalid plan response' >&2; exit 1; }
[[ -n "$CONFIRM" ]] || { echo "desk-hw-physical: set LABWIRED_HW_CONFIRM=$DIGEST after reviewing the plan" >&2; exit 2; }
[[ "$CONFIRM" == "$DIGEST" ]] || { echo 'desk-hw-physical: LABWIRED_HW_CONFIRM does not match the current plan digest' >&2; exit 2; }
"$LABWIRED" hardware run --profile "$PROFILE" --out "$OUT" --confirm "$CONFIRM" >"$PLAN_OUTPUT" & CHILD_PID=$!
set +e; wait "$CHILD_PID"; RUN_RC=$?; set -e; CHILD_PID=""
cat "$PLAN_OUTPUT"
if [[ "$RUN_RC" -eq 0 ]]; then exit 0; fi
if [[ "$RUN_RC" -eq 2 ]] || { [[ "$RUN_RC" -eq 3 ]] && grep -q '"result":"BLOCKED"' "$PLAN_OUTPUT"; }; then exit 2; fi
exit 1
