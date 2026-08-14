#!/usr/bin/env bash
# rpc-probe-resolution.sh — the RPC server must resolve probe-rs through
# lib/resolve-probe.sh, not its own candidate list.
#
# The gate is a location the shell lib accepts and the old JS did not:
# $HOME/.cargo/bin/probe-rs. A server with a private list reports the tool as
# missing there, so the editor disagrees with the terminal on the same machine.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Sandbox HOME: no ~/.labwired prefix, probe-rs ONLY under .cargo/bin.
mkdir -p "$TMP/home/.cargo/bin"
printf '%s\n' '#!/usr/bin/env bash' 'echo "probe-rs 0.24.0"' >"$TMP/home/.cargo/bin/probe-rs"
chmod +x "$TMP/home/.cargo/bin/probe-rs"

NODE_BIN="$(command -v node)"
# PATH deliberately excludes .cargo/bin — only the lib's cargo fallback can find it.
out="$(HOME="$TMP/home" PATH="/usr/bin:/bin" python3 - "$ROOT/server/rpc-server.mjs" "$NODE_BIN" <<'PY'
import json, os, select, subprocess, sys, time

server, node = sys.argv[1:3]
env = dict(os.environ)
env.pop("LABWIRED_PROBE_RS", None)
env.pop("LABWIRED_HOME", None)

p = subprocess.Popen([node, server], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.PIPE, env=env)
body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tool/run",
                   "params": {"name": "debug_info"}}).encode()
p.stdin.write(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
p.stdin.flush()

buf, msg, deadline = b"", None, time.time() + 10
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
print(json.dumps((msg or {}).get("result") or {}))
PY
)"

if ! grep -q '.cargo/bin/probe-rs' <<<"$out"; then
  echo "FAIL debug_info did not resolve probe-rs from ~/.cargo/bin"
  echo "  server said: $out"
  echo "  lib/resolve-probe.sh accepts that location; a private JS list does not."
  exit 1
fi

echo "ok   RPC probe-rs resolution defers to lib/resolve-probe.sh (~/.cargo/bin honoured)"
