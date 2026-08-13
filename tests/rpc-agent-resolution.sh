#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
node "$ROOT/tests/rpc-agent-launcher.mjs"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/server" "$TMP/path" "$TMP/home/.labwired/agent/bin"
cp "$ROOT/server/rpc-server.mjs" "$TMP/server/rpc-server.mjs"
cp "$ROOT/server/agent-launcher.mjs" "$TMP/server/agent-launcher.mjs"

printf '%s\n' '#!/usr/bin/env bash' 'echo "agent-path-ok"' >"$TMP/path/labwired-agent"
printf '%s\n' '#!/usr/bin/env bash' 'echo "CORE MUST NOT RUN" >&2' 'exit 42' >"$TMP/path/labwired"
printf '%s\n' '#!/usr/bin/env bash' 'echo "explicit-agent-ok"' >"$TMP/explicit-agent"
printf '%s\n' '#!/usr/bin/env bash' 'echo "STALE HOME AGENT MUST NOT RUN" >&2' 'exit 43' >"$TMP/home/.labwired/agent/bin/labwired-agent"
chmod +x "$TMP/path/labwired-agent" "$TMP/path/labwired" "$TMP/explicit-agent" "$TMP/home/.labwired/agent/bin/labwired-agent"

NODE_BIN="$(command -v node)"
HOME="$TMP/home" PATH="$TMP/path:/usr/bin:/bin" python3 - "$TMP/server/rpc-server.mjs" "$NODE_BIN" "$TMP/path/labwired" "$TMP/explicit-agent" <<'PY'
import json, os, select, subprocess, sys, time
server, node, core, explicit = sys.argv[1:5]

def run(expected, extra):
    env = dict(os.environ)
    env.update(extra)
    p = subprocess.Popen([node, server], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    body = json.dumps({"jsonrpc":"2.0","id":1,"method":"tool/run","params":{"name":"version"}}).encode()
    p.stdin.write(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
    p.stdin.flush()
    buf, message, deadline = b"", None, time.time() + 5
    while time.time() < deadline and message is None:
        ready, _, _ = select.select([p.stdout], [], [], 0.2)
        if not ready: continue
        buf += p.stdout.read1(65536)
        while True:
            split = buf.find(b"\r\n\r\n")
            if split < 0: break
            length = int(buf[:split].decode().split(":", 1)[1].strip())
            end_frame = split + 4 + length
            if len(buf) < end_frame: break
            candidate = json.loads(buf[split + 4:end_frame])
            buf = buf[end_frame:]
            if candidate.get("id") == 1:
                message = candidate
                break
    p.terminate()
    result = (message or {}).get("result") or {}
    if result.get("code") != 0 or expected not in result.get("stdout", "") or "MUST NOT RUN" in result.get("stderr", ""):
        print(json.dumps(message or {}))
        raise SystemExit(1)

run("agent-path-ok", {"LABWIRED_CLI_PATH": core})
run("explicit-agent-ok", {"LABWIRED_CLI_PATH": core, "LABWIRED_AGENT_CLI_PATH": explicit})
os.remove(os.path.join(os.environ["PATH"].split(os.pathsep)[0], "labwired-agent"))
with open(os.path.join(os.environ["HOME"], ".labwired", "agent", "bin", "labwired-agent"), "w") as f:
    f.write("#!/bin/sh\necho legacy-home-ok\n")
os.chmod(os.path.join(os.environ["HOME"], ".labwired", "agent", "bin", "labwired-agent"), 0o755)
run("legacy-home-ok", {"LABWIRED_CLI_PATH": core})
PY

echo "ok   RPC Agent override/PATH ignore legacy Core override"
