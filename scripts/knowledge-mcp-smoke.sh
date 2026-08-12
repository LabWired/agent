#!/usr/bin/env bash
# Hosted knowledge smoke: list + part + datasheet must all return useful payloads.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 - <<'PY'
import json, urllib.request, sys
from pathlib import Path
s = json.loads(Path.home().joinpath(".labwired/session/cloud.json").read_text())
api = (s.get("api_base") or "https://api.labwired.com").rstrip("/")
headers = {
    "Authorization": f"Bearer {s['access_token']}",
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": "labwired-agent/0.3.9",
    "X-LabWired-Project": s.get("project_id") or "",
}

def call(name, args, timeout=30):
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}}
    req = urllib.request.Request(api + "/mcp", data=json.dumps(body).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode()
    return json.loads(raw)

fail = 0
def check(label, cond, sample=""):
    global fail
    if cond:
        print(f"ok   {label}")
    else:
        print(f"FAIL {label} {sample[:160]}")
        fail = 1

# list boards
lr = call("labwired_list", {"kind": "board", "filter": "esp32"})
text = (((lr.get("result") or {}).get("content") or [{}])[0]).get("text") or ""
check("labwired_list boards", "esp32" in text.lower() or "boards" in text.lower(), text)

# part fact
pr = call("labwired_part", {"query": "ADXL345"})
sc = (pr.get("result") or {}).get("structuredContent") or {}
if not sc:
    try:
        sc = json.loads((((pr.get("result") or {}).get("content") or [{}])[0]).get("text") or "{}")
    except Exception:
        sc = {}
check("labwired_part ADXL345", sc.get("outcome") == "OK", str(sc)[:200])

# datasheet grounded
dr = call("labwired_datasheet", {"part": "adxl345", "search": "POWER_CTL"})
sc = (dr.get("result") or {}).get("structuredContent") or {}
if not sc:
    try:
        sc = json.loads((((dr.get("result") or {}).get("content") or [{}])[0]).get("text") or "{}")
    except Exception:
        sc = {}
hits = sc.get("hits") or []
check("labwired_datasheet ADXL345 POWER_CTL", sc.get("outcome") == "OK" and bool(hits), str(sc)[:200])

# import diagram_json
ir = call(
    "labwired_import",
    {
        "source_kind": "diagram_json",
        "content": json.dumps({"board": "stm32l476", "parts": [{"id": "mcu", "type": "nucleo-l476rg"}], "wires": []}),
        "user_context": "ship-gate knowledge-mcp-smoke",
    },
)
sc = (ir.get("result") or {}).get("structuredContent") or {}
if not sc:
    try:
        sc = json.loads((((ir.get("result") or {}).get("content") or [{}])[0]).get("text") or "{}")
    except Exception:
        sc = {}
check("labwired_import diagram_json", sc.get("ok") is True, str(sc)[:200])

sys.exit(fail)
PY
