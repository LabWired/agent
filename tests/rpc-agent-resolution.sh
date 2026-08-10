#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/server" "$TMP/path"
cp "$ROOT/server/rpc-server.mjs" "$TMP/server/rpc-server.mjs"

printf '%s\n' '#!/usr/bin/env bash' 'echo "agent-path-ok"' >"$TMP/path/labwired-agent"
printf '%s\n' '#!/usr/bin/env bash' 'echo "CORE MUST NOT RUN" >&2' 'exit 42' >"$TMP/path/labwired"
chmod +x "$TMP/path/labwired-agent" "$TMP/path/labwired"

NODE_BIN="$(command -v node)"
PATH="$TMP/path:/usr/bin:/bin" python3 - "$TMP/server/rpc-server.mjs" "$NODE_BIN" <<'PY'
import json, select, subprocess, sys, time
server, node = sys.argv[1:3]
p = subprocess.Popen([node, server], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
body = json.dumps({"jsonrpc":"2.0","id":1,"method":"tool/run","params":{"name":"version"}}).encode()
p.stdin.write(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
p.stdin.flush()
buf = b""
end = time.time() + 5
message = None
while time.time() < end:
    ready, _, _ = select.select([p.stdout], [], [], 0.2)
    if not ready:
        continue
    buf += p.stdout.read1(65536)
    while True:
        split = buf.find(b"\r\n\r\n")
        if split < 0:
            break
        length = int(buf[:split].decode().split(":", 1)[1].strip())
        end_frame = split + 4 + length
        if len(buf) < end_frame:
            break
        candidate = json.loads(buf[split + 4:end_frame])
        buf = buf[end_frame:]
        if candidate.get("id") == 1:
            message = candidate
            break
    if message is not None:
        break
p.terminate()
result = (message or {}).get("result") or {}
if result.get("code") != 0 or "agent-path-ok" not in result.get("stdout", ""):
    print(json.dumps(message or {}))
    raise SystemExit(1)
if "CORE MUST NOT RUN" in result.get("stderr", ""):
    raise SystemExit(1)
PY

echo "ok   RPC uses PATH labwired-agent and not Core"
