#!/usr/bin/env bash
# Multi-source import smoke (product depth Task 6).
# Live MCP when cloud session present; exit 2 if not signed in.
# Every fixture must yield design_context_ok true.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export ROOT
FIX="$ROOT/fixtures/import"

if [[ ! -f "$HOME/.labwired/session/cloud.json" ]]; then
  echo "need cloud.json — run: labwired agent login" >&2
  exit 2
fi

for f in sample.bom.csv sample.pdf.txt sample.kicad_sch; do
  if [[ ! -f "$FIX/$f" ]]; then
    echo "FAIL missing fixture $FIX/$f" >&2
    exit 1
  fi
done

python3 - <<'PY'
import json, os, sys, urllib.request
from pathlib import Path

root = Path(os.environ["ROOT"])
fix = root / "fixtures/import"
session_path = Path.home() / ".labwired/session/cloud.json"
s = json.loads(session_path.read_text())
api = (s.get("api_base") or "https://api.labwired.com").rstrip("/")
headers = {
    "Authorization": f"Bearer {s['access_token']}",
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": "labwired-agent/0.3.11",
    "X-LabWired-Project": s.get("project_id") or "",
}

def call(name, args, timeout=45):
    body = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": name, "arguments": args},
    }
    req = urllib.request.Request(
        api + "/mcp", data=json.dumps(body).encode(), headers=headers, method="POST"
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())

def payload(resp):
    if not isinstance(resp, dict):
        return {}
    if resp.get("error"):
        return {"error": resp["error"]}
    result = resp.get("result") or {}
    sc = result.get("structuredContent")
    if isinstance(sc, dict):
        return sc
    for c in result.get("content") or []:
        if isinstance(c, dict) and c.get("type") == "text":
            try:
                return json.loads(c.get("text") or "{}")
            except Exception:
                return {"text": (c.get("text") or "")[:300]}
    return result if isinstance(result, dict) else {}

fail = 0

def check(label, cond, sample=""):
    global fail
    if cond:
        print(f"ok   {label}")
    else:
        print(f"FAIL {label} {str(sample)[:220]}")
        fail = 1

# --- multi-source fixtures ---
cases = [
    ("bom_csv", fix / "sample.bom.csv", True),
    ("pdf_text", fix / "sample.pdf.txt", True),
    ("text", fix / "sample.pdf.txt", True),  # same prose path
    ("kicad_sch", fix / "sample.kicad_sch", True),
]

for kind, path, with_hint in cases:
    content = path.read_text()
    args = {
        "source_kind": kind,
        "content": content,
        "user_context": "import-multi-smoke",
    }
    if with_hint:
        args["board_hint"] = "esp32-c3-supermini"
    pl = payload(call("labwired_import", args))
    check(
        f"import {kind} design_context_ok ({path.name})",
        pl.get("design_context_ok") is True and pl.get("error") not in ("not_implemented",),
        pl,
    )

# --- diagram_json twin path (keep twin honesty) ---
diagram = {
    "board": "stm32l476",
    "parts": [{"id": "mcu", "type": "nucleo-l476rg"}],
    "wires": [],
}
pl = payload(
    call(
        "labwired_import",
        {
            "source_kind": "diagram_json",
            "content": json.dumps(diagram),
            "user_context": "import-multi-smoke diagram",
        },
    )
)
check(
    "import diagram_json design_context_ok",
    pl.get("design_context_ok") is True,
    pl,
)
check(
    "import diagram_json twin_buildable",
    pl.get("twin_buildable") is True or pl.get("ok") is True,
    pl,
)

if fail:
    print("import-multi-smoke FAILED", file=sys.stderr)
    sys.exit(1)
print("ok   import-multi-smoke PASS (bom_csv + text + pdf_text + kicad_sch + diagram_json)")
sys.exit(0)
PY
