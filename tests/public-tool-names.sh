#!/usr/bin/env bash
# Resolve the real OpenCode registry through the public LabWired launcher, with
# both MCP and model traffic confined to one stdlib-only localhost fixture.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

PORT_FILE="$TMP/port"
CAPTURE_FILE="$TMP/model-request.json"
python3 - "$PORT_FILE" "$CAPTURE_FILE" <<'PY' &
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

port_file, capture_file = map(Path, sys.argv[1:])
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        if urlparse(self.path).path != "/v1/models":
            self.send_response(404)
            self.end_headers()
            return
        data = json.dumps({"object": "list", "data": [{"id": "labwired-default", "object": "model"}]}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        parsed = urlparse(self.path)
        if parsed.path == "/v1/chat/completions":
            capture_file.write_text(json.dumps(body))
            payload = {
                "id": "offline", "object": "chat.completion", "created": 0, "model": "offline",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "done"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            }
        else:
            self.send_response(404)
            self.end_headers()
            return
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
port_file.write_text(str(server.server_port))
server.serve_forever()
PY
SERVER_PID=$!
for _ in $(seq 1 100); do
  [[ -s "$PORT_FILE" ]] && break
  sleep 0.05
done
[[ -s "$PORT_FILE" ]] || { echo "FAIL offline fixture did not start" >&2; exit 1; }
PORT="$(cat "$PORT_FILE")"

mkdir -p "$TMP/home" "$TMP/labwired" "$TMP/config" "$TMP/project" "$TMP/bin"
PORT="$PORT" TMP="$TMP" python3 - <<'PY'
import json, os
from pathlib import Path

tmp = Path(os.environ["TMP"])
port = os.environ["PORT"]
(tmp / "project/opencode.json").write_text(json.dumps({
    "$schema": "https://opencode.ai/config.json",
    "provider": {"offline": {
        "npm": "@ai-sdk/openai-compatible",
        "name": "Offline",
        "options": {"baseURL": f"http://127.0.0.1:{port}/v1", "apiKey": "offline"},
        "models": {"default": {"name": "Offline"}},
    }},
    "model": "offline/default",
}))
(tmp / "bin/npx").write_text("#!/bin/sh\nexec python3 \"$FAKE_MCP\"\n")
(tmp / "bin/npx").chmod(0o755)
(tmp / "fake-mcp.py").write_text(r'''import json, sys

names = ["context", "compile", "run", "verify"]
for line in sys.stdin:
    try:
        request = json.loads(line)
    except Exception:
        continue
    method = request.get("method")
    if method == "initialize":
        result = {
            "protocolVersion": "2025-06-18",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "offline-labwired", "version": "1"},
        }
    elif method == "tools/list":
        result = {"tools": [
            {"name": name, "description": name, "inputSchema": {"type": "object", "properties": {}}}
            for name in names
        ]}
    elif method == "ping":
        result = {}
    else:
        continue
    print(json.dumps({"jsonrpc": "2.0", "id": request.get("id"), "result": result}), flush=True)
''')
PY

if ! (
  cd "$TMP/project"
  HOME="$TMP/home" \
  LABWIRED_HOME="$TMP/labwired" \
  OPENCODE_CONFIG_DIR="$TMP/config" \
  OPENCODE_CONFIG="$TMP/project/opencode.json" \
  FAKE_MCP="$TMP/fake-mcp.py" \
  PATH="$TMP/bin:$PATH" \
  LABWIRED_SKIP_LOGIN=1 \
  "$ROOT/bin/labwired-agent" agent run --model offline/default --format json "Reply done without calling tools." \
    >"$TMP/run.out" 2>"$TMP/run.err"
); then
  cat "$TMP/run.out" >&2
  cat "$TMP/run.err" >&2
  echo "FAIL public launcher exited before model capture" >&2
  exit 1
fi

[[ -s "$CAPTURE_FILE" ]] || { cat "$TMP/run.err" >&2; echo "FAIL model request not captured" >&2; exit 1; }
CAPTURE_FILE="$CAPTURE_FILE" python3 - <<'PY'
import json, os
body = json.load(open(os.environ["CAPTURE_FILE"]))
names = [tool["function"]["name"] for tool in body.get("tools", []) if tool.get("type") == "function"]
expected = ["labwired_context", "labwired_compile", "labwired_run", "labwired_verify"]
for name in expected:
    assert names.count(name) == 1, (name, names)
assert not any(name.startswith("labwired_labwired_") for name in names), names
print("ok   public launcher sends canonical MCP tool names to the model provider")
PY

echo "public-tool-names PASS"
