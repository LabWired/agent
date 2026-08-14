#!/usr/bin/env bash
# rpc-tool-stream.sh — tool output must reach the client WHILE the tool runs.
# The fake CLI prints, sleeps 2s, then prints again. A buffering server delivers
# nothing until close; a streaming server delivers line 1 immediately. The gate
# is the GAP between the first delta and the final result, not merely its presence.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/server" "$TMP/share"
cp "$ROOT/server/rpc-server.mjs" "$TMP/server/rpc-server.mjs"
# rpc-server.mjs imports ./agent-launcher.mjs — without the sibling the copied
# server dies on ERR_MODULE_NOT_FOUND and this test just times out.
cp "$ROOT/server/agent-launcher.mjs" "$TMP/server/agent-launcher.mjs"
# share/tools.json is the server's tool table and mode policy, not an optional
# extra: without it the server exits loudly instead of serving an empty tool list.
# A copied server therefore has to bring the manifest with it.
cp "$ROOT/share/tools.json" "$TMP/share/tools.json"

cat >"$TMP/fake-agent" <<'SH'
#!/usr/bin/env bash
echo "STREAM_LINE_1"
sleep 2
echo "STREAM_LINE_2"
SH
chmod +x "$TMP/fake-agent"

NODE_BIN="$(command -v node)"
python3 - "$TMP/server/rpc-server.mjs" "$NODE_BIN" "$TMP/fake-agent" <<'PY'
import json, os, select, subprocess, sys, time

server, node, fake = sys.argv[1:4]
env = dict(os.environ)
env["LABWIRED_AGENT_CLI_PATH"] = fake

p = subprocess.Popen([node, server], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.PIPE, env=env)
body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tool/run",
                   "params": {"name": "version"}}).encode()
p.stdin.write(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
p.stdin.flush()

started = time.time()
first_delta_at = None
first_delta_text = ""
result_at = None
result = None
tool_result = None
buf = b""
deadline = started + 15

while time.time() < deadline and result is None:
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
        msg = json.loads(buf[split + 4:end])
        buf = buf[end:]
        now = time.time()
        if msg.get("method") == "chat/toolDelta" and first_delta_at is None:
            first_delta_at = now
            first_delta_text = msg.get("params", {}).get("text", "")
        if msg.get("method") == "chat/toolResult":
            tool_result = msg.get("params", {})
        if msg.get("id") == 1:
            result_at, result = now, msg
            break

p.terminate()

def die(why):
    print(f"FAIL {why}")
    print(f"  first_delta_at={first_delta_at} result_at={result_at}")
    print(f"  result={json.dumps(result or {})[:400]}")
    raise SystemExit(1)

if result is None:
    die("no tool/run response within 15s")
if first_delta_at is None:
    die("no chat/toolDelta emitted — server buffered the whole run")
if "STREAM_LINE_1" not in first_delta_text:
    die(f"first delta was not line 1: {first_delta_text!r}")

gap = result_at - first_delta_at
if gap < 1.0:
    die(f"delta arrived only {gap:.2f}s before the result — not streaming live")

res = (result.get("result") or {})
if res.get("code") != 0:
    die(f"tool exited {res.get('code')}")

# The client reads `streamed` on chat/toolResult to avoid rendering the body twice.
if tool_result is None:
    die("no chat/toolResult notification")
if tool_result.get("streamed") is not True:
    die(f"chat/toolResult.streamed={tool_result.get('streamed')!r}, expected True")

print(f"ok   first delta {gap:.2f}s before result (line 1 live, line 2 after sleep)")
PY

echo "ok   RPC tool output streams while the tool runs"
