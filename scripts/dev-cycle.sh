#!/usr/bin/env bash
# Legacy LABWIRED_HW_* compatibility translator for the generic hardware runner.
# For a board-specific example, see scripts/profiles/esp32c3-serial.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABWIRED="${LABWIRED:-$ROOT/bin/labwired-agent}"

WS="${LABWIRED_HW_WS:-${LABWIRED_C3_WS:-}}"
PORT="${LABWIRED_HW_PORT:-${LABWIRED_C3_PORT:-}}"
PROBE_SERIAL="${LABWIRED_HW_PROBE_SERIAL:-}"
MARKER="${LABWIRED_HW_MARKER:-${LABWIRED_C3_MARKER:-LABWIRED_OK}}"
BAUD="${LABWIRED_HW_BAUD:-115200}"
TIMEOUT="${LABWIRED_HW_TIMEOUT:-${LABWIRED_C3_TIMEOUT:-12}}"
CHIP="${LABWIRED_HW_CHIP:-unknown}"
ENVIRONMENT="${LABWIRED_HW_ENV:-}"
SYSTEM="${LABWIRED_HW_SYSTEM:-${LABWIRED_C3_SYSTEM:-}}"
TWIN_STEPS="${LABWIRED_HW_TWIN_STEPS:-${LABWIRED_C3_TWIN_STEPS:-50000000}}"
SKIP_TWIN="${LABWIRED_HW_SKIP_TWIN:-0}"
SKIP_FLASH="${LABWIRED_HW_SKIP_FLASH:-0}"
OUT="${LABWIRED_HW_OUT:-}"
CONFIRM="${LABWIRED_HW_CONFIRM:-}"

[[ -n "$WS" ]] || { echo 'dev-cycle: set LABWIRED_HW_WS to a PlatformIO project directory' >&2; exit 2; }
WS="$(cd "$WS" 2>/dev/null && pwd)" || { echo 'dev-cycle: LABWIRED_HW_WS is not a directory' >&2; exit 2; }
[[ -f "$WS/platformio.ini" ]] || { echo "dev-cycle: missing $WS/platformio.ini" >&2; exit 2; }
[[ "$BAUD" == 115200 ]] || { echo 'dev-cycle: generic serial provider currently supports LABWIRED_HW_BAUD=115200 only' >&2; exit 2; }
[[ "$TIMEOUT" =~ ^[1-9][0-9]*$ ]] || { echo 'dev-cycle: LABWIRED_HW_TIMEOUT must be a positive integer' >&2; exit 2; }
[[ "$TWIN_STEPS" == 50000000 ]] || { echo 'dev-cycle: custom LABWIRED_HW_TWIN_STEPS is not representable in hardware profile v1' >&2; exit 2; }
[[ "$SKIP_TWIN" == 0 || "$SKIP_TWIN" == 1 ]] || { echo 'dev-cycle: LABWIRED_HW_SKIP_TWIN must be 0 or 1' >&2; exit 2; }
[[ "$SKIP_FLASH" == 0 || "$SKIP_FLASH" == 1 ]] || { echo 'dev-cycle: LABWIRED_HW_SKIP_FLASH must be 0 or 1' >&2; exit 2; }
if [[ -z "$ENVIRONMENT" ]]; then
  ENVIRONMENT="$(sed -n 's/^\[env:\([^]]*\)\][[:space:]]*$/\1/p' "$WS/platformio.ini" | head -1)"
fi
[[ -n "$ENVIRONMENT" ]] || { echo 'dev-cycle: set LABWIRED_HW_ENV (no PlatformIO environment found)' >&2; exit 2; }
[[ "$ENVIRONMENT" =~ ^[A-Za-z0-9_-]+$ ]] || { echo 'dev-cycle: LABWIRED_HW_ENV must be a safe PlatformIO environment name' >&2; exit 2; }
OUT="${OUT:-$WS/evidence}"

if [[ "$SKIP_FLASH" == 0 ]]; then
  [[ -n "$PORT" && -n "$PROBE_SERIAL" ]] || {
    echo 'dev-cycle: physical run requires explicit LABWIRED_HW_PORT and LABWIRED_HW_PROBE_SERIAL' >&2; exit 2;
  }
fi
if [[ "$SKIP_TWIN" == 1 ]]; then
  echo 'dev-cycle: twin not run (LABWIRED_HW_SKIP_TWIN=1)'
elif [[ -z "$SYSTEM" ]]; then
  echo 'dev-cycle: twin not run (set LABWIRED_HW_SYSTEM)'
fi
[[ "$SKIP_FLASH" == 0 ]] || echo 'dev-cycle: desk not run (LABWIRED_HW_SKIP_FLASH=1)'
if [[ "$SKIP_TWIN" == 0 && -n "$SYSTEM" && ! -f "$SYSTEM" ]]; then
  echo "dev-cycle: twin system not found: $SYSTEM" >&2; exit 2
fi

PROFILE="$(mktemp "$WS/.labwired-legacy-profile.XXXXXX.json")"
PLAN_OUTPUT="$(mktemp "$WS/.labwired-legacy-plan.XXXXXX.json")"
SYSTEM_COPY=""
CHILD_PID=""
cleanup() {
  [[ -z "$CHILD_PID" ]] || kill -TERM "$CHILD_PID" 2>/dev/null || true
  rm -f "$PROFILE" "$PLAN_OUTPUT" ${SYSTEM_COPY:+"$SYSTEM_COPY"}
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ "$SKIP_TWIN" == 0 && -n "$SYSTEM" ]]; then
  SYSTEM_COPY="$(mktemp "$WS/.labwired-legacy-system.XXXXXX.yaml")"
  cp "$SYSTEM" "$SYSTEM_COPY"
fi

python3 - "$PROFILE" "$WS" "$ENVIRONMENT" "$CHIP" "$PORT" "$PROBE_SERIAL" "$MARKER" "$TIMEOUT" "$SKIP_TWIN" "$SKIP_FLASH" "$SYSTEM_COPY" <<'PY'
import json,os,sys
profile,ws,environment,chip,port,probe,marker,timeout,skip_twin,skip_flash,system=sys.argv[1:]
physical=skip_flash == "0"
doc={
  "schema":1,
  "target":{"id":"legacy-target","chip":chip},
  "build":{"provider":"platformio","workspace":".","environment":environment,
           "artifact":f".pio/build/{environment}/firmware.bin"},
  "observations":[],
}
if physical:
  doc["target"].update(probeSerial=probe,serialPort=port)
  doc["flash"]={"provider":"platformio"}
  doc["observations"].append({"id":"legacy-hardware-serial","provider":"serial","contains":marker,
                              "timeoutSeconds":int(timeout),"requiredLevel":"hardware_observed"})
else:
  doc["observations"].append({"id":"legacy-build","provider":"serial","contains":marker,"requiredLevel":"compiled"})
if skip_twin == "0" and system:
  if physical:
    shared=[]
    for base,dirs,files in os.walk(os.path.join(ws,"src")):
      dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(base,d))]
      shared += [os.path.relpath(os.path.join(base,f),ws) for f in files if not os.path.islink(os.path.join(base,f))]
    if not shared: raise SystemExit("dev-cycle: physical twin requires at least one regular shared source under src/")
    doc["twin"]={"provider":"labwired-sim","system":os.path.basename(system),"artifactRelation":"surrogate",
                 "artifact":f".pio/build/{environment}/firmware.elf","sharedSources":shared}
  else:
    doc["build"]["artifact"]=f".pio/build/{environment}/firmware.elf"
    doc["twin"]={"provider":"labwired-sim","system":os.path.basename(system),"artifactRelation":"exact"}
  if not physical:
    doc["observations"]=[{"id":"legacy-twin-serial","provider":"serial","contains":marker,
                          "timeoutSeconds":int(timeout),"requiredLevel":"model_observed"}]
with open(profile,"w",encoding="utf-8") as f: json.dump(doc,f,separators=(",",":")); f.write("\n")
PY

"$LABWIRED" hardware plan --profile "$PROFILE" --out "$OUT" >"$PLAN_OUTPUT" & CHILD_PID=$!
set +e; wait "$CHILD_PID"; PLAN_RC=$?; set -e; CHILD_PID=""
if [[ "$PLAN_RC" -ne 0 ]]; then [[ "$PLAN_RC" -eq 2 ]] && exit 2; exit 1; fi
PLAN="$(<"$PLAN_OUTPUT")"
printf '%s\n' "$PLAN"
DIGEST="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["digest"])' <<<"$PLAN")" || { echo 'dev-cycle: invalid plan response' >&2; exit 1; }
PHYSICAL="$(python3 -c 'import json,sys; p=json.load(sys.stdin)["plan"]["profile"]; print("1" if p.get("flash") or any(x.get("requiredLevel")=="hardware_observed" for x in p.get("observations",[])) else "0")' <<<"$PLAN")" || { echo 'dev-cycle: invalid plan profile' >&2; exit 1; }
if [[ "$PHYSICAL" == 0 && -z "$CONFIRM" ]]; then CONFIRM="$DIGEST"; fi
[[ -n "$CONFIRM" ]] || { echo "dev-cycle: set LABWIRED_HW_CONFIRM=$DIGEST after reviewing the physical plan" >&2; exit 2; }
[[ "$CONFIRM" == "$DIGEST" ]] || { echo 'dev-cycle: LABWIRED_HW_CONFIRM does not match the current plan digest' >&2; exit 2; }
set +e
"$LABWIRED" hardware run --profile "$PROFILE" --out "$OUT" --confirm "$CONFIRM"
RUN_RC=$?
set -e
[[ "$RUN_RC" -eq 0 ]] && exit 0
[[ "$RUN_RC" -eq 2 ]] && exit 2
exit 1
