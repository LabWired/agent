#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/tests/helpers/hardware-err-trap.sh"
trap 'hardware_test_err_trace "$?" "$LINENO" "$BASH_COMMAND" hardware-release-contract' ERR
TEMPLATE="$ROOT/fixtures/hardware-profiles/esp32c3-acceptance.template.json"

[[ -f "$TEMPLATE" ]]
[[ -f "$ROOT/fixtures/hardware-profiles/logic/led-pass.csv" ]]
[[ -f "$ROOT/fixtures/hardware-profiles/logic/led-flat.csv" ]]

blocked() { printf 'BLOCKED hardware-release: %s\n' "$1"; exit 2; }

validate_acceptance_profile() {
  node - "$1" <<'NODE'
const fs = require('node:fs');
try {
  const p = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const ambiguous = new Set(['auto', 'first', 'any', 'default']);
  const explicit = v => typeof v === 'string' && v.trim() && !ambiguous.has(v.trim().toLowerCase());
  if (!explicit(p?.target?.id) || !explicit(p?.target?.probeSerial) || !explicit(p?.target?.serialPort)) throw 'explicit target, probeSerial, and serialPort are required';
  if (p?.build?.provider !== 'platformio' || !explicit(p?.build?.environment)) throw 'exact PlatformIO build is required';
  if (p.build.artifact !== `.pio/build/${p.build.environment}/firmware.bin`) throw 'native PlatformIO firmware.bin artifact is required';
  if (p?.flash?.provider !== 'platformio') throw 'exact PlatformIO flash is required';
  if (!Array.isArray(p.observations)) throw 'required hardware behaviors are missing';
  const ids = p.observations.map(o => o?.id);
  if (new Set(ids).size !== ids.length) throw 'duplicate behavior IDs are forbidden';
  const heartbeat = p.observations.find(o => o?.id === 'heartbeat');
  if (heartbeat?.provider !== 'serial' || heartbeat.requiredLevel !== 'hardware_observed' || !explicit(heartbeat.contains)) throw 'hardware heartbeat behavior is required';
  const led = p.observations.find(o => o?.id === 'led');
  if (led?.provider !== 'logic-csv' || led.requiredLevel !== 'hardware_observed'
      || !Number.isInteger(led.channel) || led.channel < 0 || !explicit(led.timeColumn) || !explicit(led.valueColumn)
      || led.captureProvider !== 'sigrok-cli' || !explicit(led.instrumentId) || !explicit(led.driver) || !explicit(led.sourceChannel)
      || !Number.isInteger(led.sampleRateHz) || led.sampleRateHz < 1 || !Number.isFinite(led.durationSeconds) || led.durationSeconds <= 0
      || !Number.isInteger(led.edgeCountAtLeast) || led.edgeCountAtLeast < 1
      || !Number.isFinite(led.frequencyMinHz) || led.frequencyMinHz <= 0
      || !Number.isFinite(led.frequencyMaxHz) || led.frequencyMaxHz < led.frequencyMinHz) throw 'hardware LED logic behavior with frequency bounds is required';
  const wifi = p.observations.find(o => o?.id === 'wifi');
  if (wifi?.provider !== 'network' || wifi.requiredLevel !== 'hardware_observed'
      || !explicit(wifi.deviceMarker) || !explicit(wifi.hostProbeUrlFromMarker) || !explicit(wifi.hostProbePath)) throw 'hardware Wi-Fi challenge behavior is required';
} catch (error) {
  process.stdout.write(typeof error === 'string' ? error : 'profile is not valid acceptance JSON');
  process.exit(1);
}
NODE
}

# Strict is the only lane allowed to address a real lab. Planning is safe and
# useful, but execution additionally requires the operator-confirmed digest.
if [[ "${LABWIRED_ACCEPTANCE_REQUIRE_COMPLETE:-0}" == "1" ]]; then
  [[ -n "${LABWIRED_HW_PROFILE:-}" ]] || blocked 'LABWIRED_HW_PROFILE is required'
  [[ -f "$LABWIRED_HW_PROFILE" ]] || blocked 'LABWIRED_HW_PROFILE is not a readable file'
  semantic_error=''
  semantic_error="$(validate_acceptance_profile "$LABWIRED_HW_PROFILE")" || blocked "$semantic_error"
  strict_out="${LABWIRED_HW_EVIDENCE_DIR:-$(mktemp -d)/evidence}"
  set +e
  plan_json="$($ROOT/bin/labwired-agent hardware plan --profile "$LABWIRED_HW_PROFILE" --out "$strict_out" 2>&1)"
  plan_rc=$?
  set -e
  [[ "$plan_rc" -eq 0 ]] || { printf '%s\n' "$plan_json"; blocked 'profile or exact provider identities are incomplete'; }
  digest="$(printf '%s' "$plan_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).digest||"")}catch{}})')"
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || blocked 'provider did not produce an exact plan digest'
  if [[ -z "${LABWIRED_HW_CONFIRM:-}" ]]; then
    printf 'PLAN digest=%s profile=%s evidence=%s\n' "$digest" "$LABWIRED_HW_PROFILE" "$strict_out"
    blocked 'set LABWIRED_HW_CONFIRM to this exact digest after reviewing the physical plan'
  fi
  [[ "$LABWIRED_HW_CONFIRM" == "$digest" ]] || blocked 'LABWIRED_HW_CONFIRM does not match the current plan'
  exec "$ROOT/bin/labwired-agent" hardware run --profile "$LABWIRED_HW_PROFILE" --out "$strict_out" --confirm "$digest"
fi

WORK="$(mktemp -d)"
SERVER_PID=''
cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
REAL_PYTHON="$(command -v python3)"
mkdir -p "$WORK/bin" "$WORK/project"

# A deterministic provider double. It has the same argv contracts as PIO but
# never touches a USB device. This proves orchestration mechanics, not hardware.
cat >"$WORK/bin/pio" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  --version) echo 'PlatformIO Core, version acceptance-fake-1' ;;
  device) printf '[{"port":"acceptance-port","serialNumber":"acceptance-probe","hwid":"USB VID:PID=303A:1001"}]\n' ;;
  run)
    if [[ " $* " == *' -t upload '* ]]; then exit 0; fi
    env_name=''
    while [[ $# -gt 0 ]]; do [[ "$1" == '-e' ]] && { env_name="$2"; break; }; shift; done
    [[ -n "$env_name" ]]
    mkdir -p ".pio/build/$env_name"
    printf 'deterministic esp32-c3 acceptance artifact\n' >".pio/build/$env_name/firmware.bin"
    ;;
  *) exit 64 ;;
esac
SH
cat >"$WORK/bin/labwired-sim" <<'SH'
#!/usr/bin/env bash
if [[ "${1:-}" == '--version' ]]; then echo 'labwired-sim acceptance-fake-1'; exit 0; fi
echo 'exact ESP32-C3 Arduino execution unsupported by this twin' >&2
exit 1
SH
cat >"$WORK/bin/sigrok-cli" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == '--version' ]]; then echo 'sigrok-cli acceptance-fake-1'; exit 0; fi
if [[ "${1:-}" == '--scan' ]]; then printf 'demo - acceptance-logic\n'; exit 0; fi
out=''
while [[ $# -gt 0 ]]; do [[ "$1" == '--output-file' ]] && { out="$2"; shift 2; continue; }; shift; done
[[ -n "$out" && ! -e "$out" ]]
case "$(cat "${TMP}/labwired-logic-mode")" in
  flat) printf 'time_s,gpio8\n0,1\n1,1\n2,1\n' >"$out" ;;
  malformed) printf 'time_s,gpio8\n0,nope\n' >"$out" ;;
  *) printf 'time_s,gpio8\n0,0\n0.5,1\n1,0\n1.5,1\n2,0\n' >"$out" ;;
esac
SH
# The serial helpers invoke python3 with explicit LABWIRED_SC_* fields. This
# double returns only data correlated to the current invocation and shares the
# Wi-Fi nonce with the bounded local HTTP fixture.
cat >"$WORK/bin/python3" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ -n "${LABWIRED_SC_NONCE:-}" ]]; then
  printf '%s' "$LABWIRED_SC_NONCE" >"${TMP}/labwired-acceptance-nonce"
  case "$(cat "${TMP}/labwired-acceptance-case" 2>/dev/null || true)" in
    nonce) nonce=00000000000000000000000000000000 ;;
    address) printf 'WIFI_READY nonce=%s DEVICE_ADDR=203.0.113.1:9\n' "$LABWIRED_SC_NONCE"; exit 0 ;;
    *) nonce="$LABWIRED_SC_NONCE" ;;
  esac
  printf 'WIFI_READY nonce=%s DEVICE_ADDR=127.0.0.1:%s\n' "$nonce" "$(cat "${TMP}/labwired-acceptance-port")"
else
  printf '{"status":"hardware_observed","output":"alive"}\n'
fi
SH
chmod +x "$WORK/bin/pio" "$WORK/bin/labwired-sim" "$WORK/bin/sigrok-cli" "$WORK/bin/python3"

cat >"$WORK/server.py" <<'PY'
import http.server, os, pathlib, socketserver
import time
root = pathlib.Path(os.environ['TMP'])
time.sleep(float(os.environ.get('LABWIRED_TEST_FIXTURE_DELAY', '0')))
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        nonce = (root / 'labwired-acceptance-nonce').read_text() if (root / 'labwired-acceptance-nonce').exists() else 'missing'
        status = 503 if (root / 'labwired-acceptance-case').read_text().strip() == 'status' else 200
        body = ('nonce=' + nonce).encode()
        self.send_response(status); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *_): pass
with socketserver.TCPServer(('127.0.0.1', 0), Handler) as server:
    (root / 'labwired-acceptance-port').write_text(str(server.server_address[1]))
    server.serve_forever()
PY
TMP="$WORK" "$REAL_PYTHON" "$WORK/server.py" & SERVER_PID=$!
for _ in {1..500}; do [[ -s "$WORK/labwired-acceptance-port" ]] && break; sleep 0.02; done
if [[ ! -s "$WORK/labwired-acceptance-port" ]]; then
  echo 'BLOCKED hardware-release: local evidence fixture did not become ready within 10 seconds' >&2
  exit 1
fi

instantiate() {
  local logic="$1"
  case "$logic" in flat) printf flat >"$WORK/labwired-logic-mode" ;; malformed) printf malformed >"$WORK/labwired-logic-mode" ;; pass) printf pass >"$WORK/labwired-logic-mode" ;; *) return 64 ;; esac
  rm -f "$WORK/project/logic.csv"
  cp "$TEMPLATE" "$WORK/project/hardware.json"
  sed -i.bak -e 's/${TARGET_ID}/acceptance-c3/g' -e 's/${PROBE_SERIAL}/acceptance-probe/g' -e 's/${SERIAL_PORT}/acceptance-port/g' -e 's/${LOGIC_INSTRUMENT_ID}/acceptance-logic/g' "$WORK/project/hardware.json"
  rm -f "$WORK/project/hardware.json.bak"
  printf '[env:esp32-c3-devkitm-1]\nplatform = espressif32\nboard = esp32-c3-devkitm-1\nframework = arduino\n' >"$WORK/project/platformio.ini"
  printf 'board: esp32c3\n' >"$WORK/project/system.yaml"
}

strict_semantic_block() {
  local name="$1" edit="$2" expected="$3" candidate
  candidate="$WORK/project/incomplete-$name.json"
  cp "$WORK/project/hardware.json" "$candidate"
  node -e 'const fs=require("node:fs");const file=process.argv[1];const p=JSON.parse(fs.readFileSync(file));Function("p",process.argv[2])(p);fs.writeFileSync(file,JSON.stringify(p))' "$candidate" "$edit"
  local output rc
  set +e
  output="$(LABWIRED_ACCEPTANCE_REQUIRE_COMPLETE=1 LABWIRED_HW_PROFILE="$candidate" PATH="$WORK/bin:$PATH" TMP="$WORK" bash "$0" 2>&1)"
  rc=$?
  set -e
  [[ "$rc" -eq 2 && "$output" == "BLOCKED hardware-release: $expected" ]]
  [[ "$output" != *'hardware plan'* ]]
}

instantiate pass
strict_semantic_block no-heartbeat 'p.observations=p.observations.filter(o=>o.id!=="heartbeat")' 'hardware heartbeat behavior is required'
strict_semantic_block weak-heartbeat 'p.observations.find(o=>o.id==="heartbeat").requiredLevel="compiled"' 'hardware heartbeat behavior is required'
strict_semantic_block no-led 'p.observations=p.observations.filter(o=>o.id!=="led")' 'hardware LED logic behavior with frequency bounds is required'
strict_semantic_block weak-led 'delete p.observations.find(o=>o.id==="led").frequencyMaxHz' 'hardware LED logic behavior with frequency bounds is required'
strict_semantic_block replay-led 'const o=p.observations.find(o=>o.id==="led");delete o.captureProvider;delete o.instrumentId;delete o.driver;delete o.sourceChannel;delete o.sampleRateHz;delete o.durationSeconds;o.file="logic/led-pass.csv"' 'hardware LED logic behavior with frequency bounds is required'
strict_semantic_block no-wifi 'p.observations=p.observations.filter(o=>o.id!=="wifi")' 'hardware Wi-Fi challenge behavior is required'
strict_semantic_block substituted-wifi 'p.observations.find(o=>o.id==="wifi").id="network-ok"' 'hardware Wi-Fi challenge behavior is required'

# A complete profile crosses semantic preflight and reaches read-only planning,
# then blocks because no exact digest was operator-confirmed.
set +e
complete_gate="$(LABWIRED_ACCEPTANCE_REQUIRE_COMPLETE=1 LABWIRED_HW_PROFILE="$WORK/project/hardware.json" PATH="$WORK/bin:$PATH" TMP="$WORK" XDG_RUNTIME_DIR="$WORK/runtime-strict" bash "$0" 2>&1)"
complete_rc=$?
set -e
[[ "$complete_rc" -eq 2 ]]
[[ "$complete_gate" == *'PLAN digest='* ]]
[[ "$complete_gate" == *'set LABWIRED_HW_CONFIRM to this exact digest'* ]]

run_case() {
  local name="$1" expected="$2" logic="$3" mode="${4:-pass}" expected_failure="${5:-}"
  rm -rf "$WORK/evidence-$name" "$WORK/project/.pio"
  printf '%s' "$mode" >"$WORK/labwired-acceptance-case"
  rm -f "$WORK/labwired-acceptance-nonce"
  instantiate "$logic"
  local plan digest output rc
  plan="$(PATH="$WORK/bin:$PATH" TMP="$WORK" XDG_RUNTIME_DIR="$WORK/runtime-$name" "$ROOT/bin/labwired-agent" hardware plan --profile "$WORK/project/hardware.json" --out "$WORK/evidence-$name")"
  digest="$(printf '%s' "$plan" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).digest))')"
  set +e
  output="$(PATH="$WORK/bin:$PATH" TMP="$WORK" XDG_RUNTIME_DIR="$WORK/runtime-$name" "$ROOT/bin/labwired-agent" hardware run --profile "$WORK/project/hardware.json" --out "$WORK/evidence-$name" --confirm "$digest" 2>&1)"
  rc=$?
  set -e
  printf '%s\n' "$output" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{let v=JSON.parse(s);if(v.result!=='$expected')process.exit(1);if('$expected_failure' && !v.receipt.reasons.some(r=>r.behaviorId==='$expected_failure'))process.exit(2)})"
  if [[ "$expected" == PASS ]]; then [[ "$rc" -eq 0 ]]; else [[ "$rc" -eq 3 ]]; fi
  if [[ "$name" == positive ]]; then
    [[ -f "$WORK/project/.pio/build/esp32-c3-devkitm-1/firmware.bin" ]]
    [[ ! -e "$WORK/project/dist/firmware.bin" ]]
    printf '%s\n' "$output" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);if(!v.plan.plan.profile.build.artifact.endsWith("/.pio/build/esp32-c3-devkitm-1/firmware.bin"))process.exit(1)})'
    node - "$WORK/evidence-$name" <<'NODE'
const fs = require('node:fs'), path = require('node:path');
const files = [];
const walk = d => { for (const e of fs.readdirSync(d, {withFileTypes:true})) { const p=path.join(d,e.name); e.isDirectory()?walk(p):files.push(p); } };
walk(process.argv[2]);
const records = files.filter(f=>f.endsWith('.json')).flatMap(f=>{try{return [JSON.parse(fs.readFileSync(f))]}catch{return []}});
if (!records.some(r => r?.command?.args?.join(' ') === 'run -e esp32-c3-devkitm-1')) process.exit(1);
NODE
  fi
}

run_case positive PASS pass
run_case flat-led FAIL flat pass led
run_case malformed-led FAIL malformed pass led
run_case bad-nonce FAIL pass nonce wifi
run_case bad-address FAIL pass address wifi
run_case bad-status FAIL pass status wifi

# Serial output alone must never satisfy the independently required LED claim.
run_case serial-only FAIL flat pass led
echo 'PASS hardware-release-contract deterministic behavior evidence and negative boundaries'
