#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/project"

cat >"$TMP/bin/pio" <<'SH'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then echo 'PlatformIO Core 6.1.0'; exit 0; fi
if [[ "${1:-} ${2:-} ${3:-}" == 'device list --json-output' ]]; then
  if [[ "${LABWIRED_HANG_ENUM:-}" == 1 ]]; then sleep 30 & echo $! >"$LABWIRED_HANG_PID"; wait; fi
  if [[ -n "${LABWIRED_TEST_DEVICE_JSON:-}" ]]; then printf '%s\n' "$LABWIRED_TEST_DEVICE_JSON"
  elif [[ -f "$PWD/device.json" ]]; then cat "$PWD/device.json"
  else printf '[]\n'; fi
  exit 0
fi
printf '%s\n' "$*" >>"${LABWIRED_TEST_MUTATIONS:-$PWD/mutations.log}"
if [[ " $* " == *' -t upload '* ]]; then exit 0; fi
printf 'fresh firmware' >"$PWD/firmware.bin"
SH
chmod +x "$TMP/bin/pio"
cat >"$TMP/bin/cmake" <<'SH'
#!/usr/bin/env bash
[[ "${1:-}" == '--version' ]] && { echo 'cmake version 3.30'; exit 0; }
exit 0
SH
cat >"$TMP/bin/probe-rs" <<'SH'
#!/usr/bin/env bash
[[ "${1:-}" == '--version' ]] && { echo 'probe-rs 0.29'; exit 0; }
[[ "${1:-}" == 'list' ]] && { printf '%s\n' "${LABWIRED_TEST_PROBE_LIST:-No probes found}"; exit 0; }
exit 0
SH
chmod +x "$TMP/bin/cmake" "$TMP/bin/probe-rs"
printf '[env:release]\n' >"$TMP/project/platformio.ini"

cat >"$TMP/project/compiled.json" <<JSON
{"schema":1,"target":{"id":"compile-c3","chip":"esp32c3"},"build":{"provider":"platformio","workspace":".","environment":"release","artifact":"firmware.bin"},"observations":[{"id":"firmware","provider":"serial","contains":"unused","requiredLevel":"compiled"}]}
JSON

export PATH="$TMP/bin:$PATH" LABWIRED_TEST_MUTATIONS="$TMP/mutations.log"
CLI=("$ROOT/bin/labwired-agent" hardware)

# Credential-shaped paths are refused before output, mutation, or directory creation.
secret='sk-EXPOSED1234'
set +e
secret_output="$("${CLI[@]}" plan --profile "/tmp/$secret/profile.json" --out "$TMP/$secret" 2>&1)"; secret_code=$?
set -e
[[ "$secret_code" -eq 2 && "$secret_output" != *"$secret"* && ! -e "$TMP/$secret" ]]

# Native dispatch refuses an obsolete Node before it can execute the runner.
mkdir -p "$TMP/old-node"
cat >"$TMP/old-node/node" <<'SH'
#!/usr/bin/env bash
if [[ "${1:-}" == '--version' ]]; then echo v16.20.2; exit 0; fi
touch "$LABWIRED_OLD_NODE_RAN"
SH
chmod +x "$TMP/old-node/node"
set +e
old_output="$(PATH="$TMP/old-node:/usr/bin:/bin" LABWIRED_OLD_NODE_RAN="$TMP/old-ran" "$ROOT/bin/labwired-agent" hardware plan --profile x --out y 2>&1)"; old_code=$?
set -e
[[ "$old_code" -eq 2 && "$old_output" == *'Node.js 18+'* && ! -e "$TMP/old-ran" ]]

plan="$("${CLI[@]}" plan --profile "$TMP/project/compiled.json" --out "$TMP/evidence")"
python3 - "$plan" <<'PY'
import json,re,sys
doc=json.loads(sys.argv[1])
assert doc["command"] == "hardware plan"
assert re.fullmatch(r"[0-9a-f]{64}", doc["digest"])
assert doc["plan"]["profile"]["target"]["id"] == "compile-c3"
PY
digest="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["digest"])' <<<"$plan")"
[[ ! -e "$TMP/evidence" && ! -e "$TMP/mutations.log" && ! -e "$TMP/project/firmware.bin" ]]

rpc_run() {
  local tool="$1" params="$2"
  LABWIRED_AGENT_CLI_PATH="$ROOT/bin/labwired-agent" python3 - "$ROOT/server/rpc-server.mjs" "$(command -v node)" "$TMP/project" "$tool" "$params" <<'PY'
import json,os,select,subprocess,sys,time
server,node,cwd,tool,params=sys.argv[1:]
p=subprocess.Popen([node,server],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=dict(os.environ))
requests=[
 {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"workspacePath":cwd}},
 {"jsonrpc":"2.0","id":2,"method":"tool/run","params":{"name":tool,"params":json.loads(params)}},
]
for request in requests:
 body=json.dumps(request).encode(); p.stdin.write(f"Content-Length: {len(body)}\r\n\r\n".encode()+body)
p.stdin.flush(); buf=b""; result=None; deadline=time.time()+30
while time.time()<deadline and result is None:
 ready,_,_=select.select([p.stdout],[],[],0.2)
 if not ready: continue
 buf += p.stdout.read1(1<<20)
 while True:
  end=buf.find(b"\r\n\r\n")
  if end<0: break
  length=int(buf[:end].decode().split(":",1)[1]); stop=end+4+length
  if len(buf)<stop: break
  message=json.loads(buf[end+4:stop]); buf=buf[stop:]
  if message.get("id")==2: result=message
p.terminate()
if result is None: raise SystemExit("RPC did not respond")
print(json.dumps(result))
PY
}

# RPC is a byte-preserving thin transport over the same CLI and exit meanings.
rpc_out="$TMP/rpc-evidence"
cli_rpc_plan="$("${CLI[@]}" plan --profile "$TMP/project/compiled.json" --out "$rpc_out")"
rpc_plan="$(rpc_run hardware_plan "{\"profile\":\"$TMP/project/compiled.json\",\"out\":\"$rpc_out\"}")"
python3 - "$cli_rpc_plan" "$rpc_plan" <<'PY'
import json,sys
reply=json.loads(sys.argv[2]); assert reply["result"]["code"] == 0
assert reply["result"]["stdout"].strip() == sys.argv[1]
PY
wrong_digest="$(printf '0%.0s' {1..64})"
set +e
cli_wrong="$("${CLI[@]}" run --profile "$TMP/project/compiled.json" --out "$TMP/rpc-wrong" --confirm "$wrong_digest")"; cli_wrong_code=$?
set -e
rpc_wrong="$(rpc_run hardware_run "{\"profile\":\"$TMP/project/compiled.json\",\"out\":\"$TMP/rpc-wrong\",\"confirm\":\"$wrong_digest\"}")"
python3 - "$cli_wrong" "$cli_wrong_code" "$rpc_wrong" <<'PY'
import json,sys
reply=json.loads(sys.argv[3]); assert int(sys.argv[2]) == reply["result"]["code"] == 2
assert reply["result"]["stdout"].strip() == sys.argv[1]
PY

for bad in '' wrong "$wrong_digest"; do
  args=(run --profile "$TMP/project/compiled.json" --out "$TMP/evidence")
  [[ -z "$bad" ]] || args+=(--confirm "$bad")
  set +e
  output="$("${CLI[@]}" "${args[@]}" 2>&1)"; code=$?
  set -e
  [[ "$code" -eq 2 ]] || { echo "expected usage/confirmation exit 2, got $code: $output" >&2; exit 1; }
  [[ ! -e "$TMP/evidence" && ! -e "$TMP/mutations.log" && ! -e "$TMP/project/firmware.bin" ]]
done

run="$("${CLI[@]}" run --profile "$TMP/project/compiled.json" --out "$TMP/evidence" --confirm "$digest")"
python3 - "$run" <<'PY'
import json,sys
doc=json.loads(sys.argv[1]); assert doc["command"] == "hardware run"; assert doc["result"] == "PASS"
PY
[[ -f "$TMP/evidence/result.json" && -f "$TMP/mutations.log" ]]

# Physical planning uses structured provider enumeration and refuses non-unique identities.
printf 'READY\n' >"$TMP/serial.txt"
cat >"$TMP/project/physical.json" <<JSON
{"schema":1,"target":{"id":"desk-c3","chip":"esp32c3","probeSerial":"probe-1","serialPort":"$TMP/serial.txt"},"build":{"provider":"platformio","workspace":".","environment":"release","artifact":"firmware.bin"},"flash":{"provider":"platformio"},"observations":[{"id":"heartbeat","provider":"serial","contains":"READY","requiredLevel":"hardware_observed"}]}
JSON
one="[{\"port\":\"$TMP/serial.txt\",\"serialNumber\":\"probe-1\",\"hwid\":\"USB VID:PID=303a:1001 SER=probe-1 LOCATION=1-2\"}]"
printf '%s\n' "$one" >"$TMP/project/device.json"
physical="$(LABWIRED_TEST_DEVICE_JSON="$one" "${CLI[@]}" plan --profile "$TMP/project/physical.json" --out "$TMP/physical-evidence")"
python3 - "$physical" <<'PY'
import json,sys
doc=json.loads(sys.argv[1]); ids=doc["plan"]["identities"]
assert ids["probe"] == "probe-1" and ids["target"] == "desk-c3"
PY
physical_digest="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["digest"])' <<<"$physical")"
physical_run="$(LABWIRED_TEST_DEVICE_JSON="$one" "${CLI[@]}" run --profile "$TMP/project/physical.json" --out "$TMP/physical-evidence" --confirm "$physical_digest")"
python3 - "$physical_run" <<'PY'
import json,sys
doc=json.loads(sys.argv[1]); assert doc["result"] == "PASS"
assert doc["receipt"]["result"] == "PASS"
PY
two="[$(printf '%s' "$one" | cut -c2- | rev | cut -c2- | rev),$(printf '%s' "$one" | cut -c2- | rev | cut -c2- | rev)]"
if LABWIRED_TEST_DEVICE_JSON="$two" "${CLI[@]}" plan --profile "$TMP/project/physical.json" --out "$TMP/nope" >"$TMP/ambiguous.out" 2>&1; then
  echo 'ambiguous physical identity was accepted' >&2; exit 1
fi
grep -qi 'BLOCKED\|unique' "$TMP/ambiguous.out"
python3 - "$TMP/ambiguous.out" <<'PY'
import json,sys
assert json.load(open(sys.argv[1]))["result"] == "BLOCKED"
PY
[[ ! -e "$TMP/nope" ]]

# A probe-rs target may use a distinct debugger and serial adapter, but each
# provider identity must still resolve exactly once.
mkdir -p "$TMP/project/release"
cat >"$TMP/project/probe-rs.json" <<JSON
{"schema":1,"target":{"id":"stm-desk","chip":"STM32L476RGTx","probeSerial":"1366:0101:DEBUG123","serialPort":"/dev/ttyUSB9"},"build":{"provider":"cmake","workspace":".","environment":"release","artifact":"release/firmware.elf"},"flash":{"provider":"probe-rs"},"observations":[{"id":"heartbeat","provider":"rtt","contains":"READY","requiredLevel":"hardware_observed"}]}
JSON
serial_only='[{"port":"/dev/ttyUSB9","serialNumber":"UART999","hwid":"USB VID:PID=10c4:ea60 SER=UART999 LOCATION=1-4"}]'
probe_list='[0]: J-Link -- 1366:0101:DEBUG123 (J-Link)'
probe_plan="$(LABWIRED_TEST_DEVICE_JSON="$serial_only" LABWIRED_TEST_PROBE_LIST="$probe_list" "${CLI[@]}" plan --profile "$TMP/project/probe-rs.json" --out "$TMP/probe-evidence")"
python3 - "$probe_plan" <<'PY'
import json,sys
doc=json.loads(sys.argv[1]); assert doc["plan"]["identities"]["probe"] == "1366:0101:DEBUG123"
assert doc["plan"]["identities"]["serial"] == "/dev/ttyUSB9"
PY

# SIGTERM reaches bounded provider enumeration and kills its process tree.
LABWIRED_HANG_ENUM=1 LABWIRED_HANG_PID="$TMP/hang.pid" "${CLI[@]}" plan --profile "$TMP/project/physical.json" --out "$TMP/cancelled-evidence" >"$TMP/cancelled.json" & cli_pid=$!
for _ in {1..100}; do [[ -s "$TMP/hang.pid" ]] && break; sleep 0.02; done
[[ -s "$TMP/hang.pid" ]]
child_pid="$(cat "$TMP/hang.pid")"
kill -TERM "$cli_pid"
set +e; wait "$cli_pid"; cancelled_code=$?; set -e
[[ "$cancelled_code" -ne 0 && ! -e "$TMP/cancelled-evidence" ]]
if kill -0 "$child_pid" 2>/dev/null; then echo 'cancelled provider descendant leaked' >&2; exit 1; fi

# The transport is closed: no arbitrary command/adapter options are accepted.
if "${CLI[@]}" plan --profile "$TMP/project/compiled.json" --out "$TMP/nope" --command 'rm -rf /' >/dev/null 2>&1; then
  echo 'arbitrary CLI option was accepted' >&2; exit 1
fi

grep -q 'hardware)' "$ROOT/bin/labwired-agent"
grep -q '"hardware" { Cmd-Hardware }' "$ROOT/bin/labwired-agent.ps1"
echo 'hardware-cli: PASS'
