#!/usr/bin/env bash
# rpc-claim-shape.sh — ONE claim engine.
#
# The CLI (`labwired agent claim-shape`) and the RPC server (hw_claim_shape) must
# return byte-identical payloads and identical exit codes for the same inputs,
# because both must be lib/claim-shape.sh. A JS re-implementation in the server
# would drift and let the editor claim hardware_observed where the terminal
# refuses — the whole point of the claim gate.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/bin/labwired-agent"
NODE_BIN="$(command -v node)"

rpc_claim() {
  python3 - "$ROOT/server/rpc-server.mjs" "$NODE_BIN" "$1" "$2" "$3" <<'PY'
import json, os, select, subprocess, sys, time
server, node, status, marker, flashed = sys.argv[1:6]
p = subprocess.Popen([node, server], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.PIPE, env=dict(os.environ))
body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tool/run", "params": {
    "name": "hw_claim_shape",
    "params": {"status": status, "marker_matched": marker, "flashed": flashed},
}}).encode()
p.stdin.write(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
p.stdin.flush()
buf, msg, deadline = b"", None, time.time() + 20
while time.time() < deadline and msg is None:
    ready, _, _ = select.select([p.stdout], [], [], 0.2)
    if not ready:
        continue
    buf += p.stdout.read1(65536)
    while True:
        split = buf.find(b"\r\n\r\n")
        if split < 0:
            break
        length = int(buf[:split].decode().split(":", 1)[1].strip())
        end = split + 4 + length
        if len(buf) < end:
            break
        cand = json.loads(buf[split + 4:end])
        buf = buf[end:]
        if cand.get("id") == 1:
            msg = cand
            break
p.terminate()
res = (msg or {}).get("result") or {}
# Normalised shape: stdout with trailing newlines stripped, then EXIT= on its own
# line. Bash $() strips trailing newlines too, so both sides compare like for like.
sys.stdout.write(res.get("stdout", "").rstrip("\n"))
sys.stdout.write(f"\nEXIT={res.get('code')}\n")
PY
}

cli_claim() {
  local out rc
  set +e
  out="$("$CLI" claim-shape --status "$1" --marker-matched "$2" --flashed "$3" 2>/dev/null)"
  rc=$?
  set -e
  printf '%s\nEXIT=%s\n' "$out" "$rc"
}

# hw_promote reaches the claim engine through a JS wrapper rather than the argv
# row, so it needs its own coverage — a drift there is invisible to the checks above.
rpc_promote_claim() {
  python3 - "$ROOT/server/rpc-server.mjs" "$NODE_BIN" "$1" "$2" <<'PY'
import json, os, select, subprocess, sys, time
server, node, marker, flashed = sys.argv[1:5]
p = subprocess.Popen([node, server], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.PIPE, env=dict(os.environ))
body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tool/run", "params": {
    "name": "hw_promote",
    "params": {"dry_run": "1", "target": "virtual",
               "flashed": flashed, "marker_matched": marker},
}}).encode()
p.stdin.write(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
p.stdin.flush()
buf, msg, deadline = b"", None, time.time() + 30
while time.time() < deadline and msg is None:
    ready, _, _ = select.select([p.stdout], [], [], 0.2)
    if not ready:
        continue
    buf += p.stdout.read1(65536)
    while True:
        split = buf.find(b"\r\n\r\n")
        if split < 0:
            break
        length = int(buf[:split].decode().split(":", 1)[1].strip())
        end = split + 4 + length
        if len(buf) < end:
            break
        cand = json.loads(buf[split + 4:end])
        buf = buf[end:]
        if cand.get("id") == 1:
            msg = cand
            break
p.terminate()
res = (msg or {}).get("result") or {}
out = res.get("stdout", "")
tail = out.split("=== claim ===", 1)[1] if "=== claim ===" in out else ""
sys.stdout.write(tail.strip())
sys.stdout.write(f"\nEXIT={res.get('code')}\n")
PY
}

fail=0
check() {
  local label="$1" status="$2" marker="$3" flashed="$4"
  local a b
  a="$(cli_claim "$status" "$marker" "$flashed")"
  b="$(rpc_claim "$status" "$marker" "$flashed")"
  if [[ "$a" != "$b" ]]; then
    echo "FAIL $label — CLI and RPC disagree"
    echo "--- CLI ---"; printf '%s\n' "$a"
    echo "--- RPC ---"; printf '%s\n' "$b"
    fail=1
  else
    echo "ok   $label — identical ($(grep -o 'EXIT=[0-9]*' <<<"$a"))"
  fi
}

check "flashed+marker -> hardware_observed" "" 1 1
check "marker missing  -> failed"           "" 0 1
check "nothing         -> failed"           "" 0 0
check "model_verified  -> refused"          model_verified 1 1

check_promote() {
  local label="$1" marker="$2" flashed="$3"
  local a b
  a="$(cli_claim "" "$marker" "$flashed")"
  b="$(rpc_promote_claim "$marker" "$flashed")"
  if [[ "$a" != "$b" ]]; then
    echo "FAIL $label — hw_promote claim differs from the CLI"
    echo "--- CLI ---"; printf '%s\n' "$a"
    echo "--- hw_promote ---"; printf '%s\n' "$b"
    fail=1
  else
    echo "ok   $label — identical ($(grep -o 'EXIT=[0-9]*' <<<"$a"))"
  fi
}

check_promote "hw_promote both set  -> hardware_observed" 1 1
check_promote "hw_promote no marker -> failed"            0 1

# The refusal must never yield a hardware_observed payload on either surface.
if cli_claim model_verified 1 1 | grep -q 'hardware_observed'; then
  echo "FAIL CLI leaked hardware_observed on a model_verified request"; fail=1
fi
if rpc_claim model_verified 1 1 | grep -q 'hardware_observed'; then
  echo "FAIL RPC leaked hardware_observed on a model_verified request"; fail=1
fi

[[ "$fail" -eq 0 ]] || exit 1
echo "ok   claim shape has ONE engine (lib/claim-shape.sh)"
