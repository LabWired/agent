#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$ROOT/fixtures/hardware-profiles/esp32c3-acceptance.template.json"

[[ -f "$TEMPLATE" ]]
[[ -f "$ROOT/fixtures/hardware-profiles/logic/led-pass.csv" ]]
[[ -f "$ROOT/fixtures/hardware-profiles/logic/led-flat.csv" ]]

blocked() { printf 'BLOCKED hardware-release: %s\n' "$1"; exit 2; }

# Strict is the only lane allowed to address a real lab. Planning is safe and
# useful, but execution additionally requires the operator-confirmed digest.
if [[ "${LABWIRED_ACCEPTANCE_REQUIRE_COMPLETE:-0}" == "1" ]]; then
  [[ -n "${LABWIRED_HW_PROFILE:-}" ]] || blocked 'LABWIRED_HW_PROFILE is required'
  [[ -f "$LABWIRED_HW_PROFILE" ]] || blocked 'LABWIRED_HW_PROFILE is not a readable file'
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
mkdir -p "$WORK/bin" "$WORK/project/dist"

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
    mkdir -p dist
    printf 'deterministic esp32-c3 acceptance artifact\n' >dist/firmware.bin
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
chmod +x "$WORK/bin/pio" "$WORK/bin/labwired-sim" "$WORK/bin/python3"

cat >"$WORK/server.py" <<'PY'
import http.server, os, pathlib, socketserver
root = pathlib.Path(os.environ['TMP'])
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
for _ in {1..50}; do [[ -s "$WORK/labwired-acceptance-port" ]] && break; sleep 0.02; done
[[ -s "$WORK/labwired-acceptance-port" ]]

instantiate() {
  local logic="$1"
  if [[ "$logic" == malformed ]]; then
    printf 'time_s,gpio8\n0,nope\n' >"$WORK/project/logic.csv"
  else
    cp "$ROOT/fixtures/hardware-profiles/logic/$logic" "$WORK/project/logic.csv"
  fi
  cp "$TEMPLATE" "$WORK/project/hardware.json"
  sed -i.bak -e 's/${TARGET_ID}/acceptance-c3/g' -e 's/${PROBE_SERIAL}/acceptance-probe/g' -e 's/${SERIAL_PORT}/acceptance-port/g' "$WORK/project/hardware.json"
  rm -f "$WORK/project/hardware.json.bak"
  printf '[env:esp32-c3-devkitm-1]\nplatform = espressif32\nboard = esp32-c3-devkitm-1\nframework = arduino\n' >"$WORK/project/platformio.ini"
  printf 'board: esp32c3\n' >"$WORK/project/system.yaml"
}

run_case() {
  local name="$1" expected="$2" logic="$3" mode="${4:-pass}" expected_failure="${5:-}"
  rm -rf "$WORK/evidence-$name" "$WORK/project/dist" "$WORK/project/.pio"
  mkdir -p "$WORK/project/dist"
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
}

run_case positive PASS led-pass.csv
run_case flat-led FAIL led-flat.csv pass led-blink
run_case malformed-led FAIL malformed pass led-blink
run_case bad-nonce FAIL led-pass.csv nonce wifi-health
run_case bad-address FAIL led-pass.csv address wifi-health
run_case bad-status FAIL led-pass.csv status wifi-health

# Serial output alone must never satisfy the independently required LED claim.
run_case serial-only FAIL led-flat.csv pass led-blink
echo 'PASS hardware-release-contract deterministic behavior evidence and negative boundaries'
