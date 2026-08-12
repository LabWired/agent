#!/usr/bin/env bash
# Hosted knowledge smoke:
# 1) Required heroes from share/catalog/knowledge-required.json (100% hard fail)
# 2) Canaries: list boards, ADXL345 part+datasheet, labwired_import diagram_json
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export ROOT
python3 - <<'PY'
import json, urllib.request, sys, os
from pathlib import Path

root = Path(os.environ["ROOT"])

session_path = Path.home() / ".labwired/session/cloud.json"
if not session_path.is_file():
    print("need cloud.json — run: labwired agent login", file=sys.stderr)
    sys.exit(2)

req_path = root / "share/catalog/knowledge-required.json"
if not req_path.is_file():
    print(f"FAIL missing {req_path}", file=sys.stderr)
    sys.exit(1)

required_doc = json.loads(req_path.read_text())
required = required_doc.get("required") or []
if len(required) < 1:
    print("FAIL knowledge-required.json empty", file=sys.stderr)
    sys.exit(1)

s = json.loads(session_path.read_text())
api = (s.get("api_base") or "https://api.labwired.com").rstrip("/")
headers = {
    "Authorization": f"Bearer {s['access_token']}",
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": "labwired-agent/0.3.11",
    "X-LabWired-Project": s.get("project_id") or "",
}

def call(name, args, timeout=30):
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
        print(f"FAIL {label} {str(sample)[:200]}")
        fail = 1

def list_hit(pl, hid):
    if not isinstance(pl, dict) or pl.get("error"):
        return False
    for key in ("components", "boards", "items", "mcus", "labs"):
        arr = pl.get(key)
        if isinstance(arr, list) and len(arr) > 0:
            return True
    # single object
    if pl.get("id") or pl.get("type") or pl.get("board"):
        return True
    text = str(pl).lower()
    return hid.lower() in text and "not_found" not in text

def part_ok(pl):
    if not isinstance(pl, dict) or pl.get("error"):
        return False
    return pl.get("outcome") == "OK"

def datasheet_ok(pl):
    if not isinstance(pl, dict) or pl.get("error"):
        return False
    if pl.get("outcome") != "OK":
        return False
    # OK with document is enough; hits optional for list-only parts
    return bool(pl.get("document") or pl.get("hits") is not None or pl.get("pages"))

# --- required heroes (hard floor) ---
for row in required:
    hid = row["id"]
    needs = row.get("need") or ["list"]
    for need in needs:
        if need == "part":
            pl = payload(call("labwired_part", {"query": hid}))
            check(f"required part {hid}", part_ok(pl), pl)
        elif need == "list":
            # try board then component then mcu-ish via component filter
            hit = False
            sample = {}
            for kind in ("board", "component", "lab", "mcu"):
                args = {"filter": hid}
                if kind != "mcu":
                    args["kind"] = kind
                else:
                    args["kind"] = "component"
                pl = payload(call("labwired_list", args))
                sample = pl
                if list_hit(pl, hid):
                    hit = True
                    break
            # also try without kind
            if not hit:
                pl = payload(call("labwired_list", {"filter": hid}))
                sample = pl
                hit = list_hit(pl, hid)
            check(f"required list {hid}", hit, sample)
        elif need == "datasheet":
            pl = payload(call("labwired_datasheet", {"part": hid.lower()}))
            check(f"required datasheet {hid}", datasheet_ok(pl), pl)
        else:
            check(f"required unknown need {need} for {hid}", False, need)

# --- canaries (still required for ship-gate) ---
lr = payload(call("labwired_list", {"kind": "board", "filter": "esp32"}))
check(
    "canary labwired_list boards esp32",
    list_hit(lr, "esp32") or "esp32" in str(lr).lower(),
    lr,
)

pr = payload(call("labwired_part", {"query": "ADXL345"}))
check("canary labwired_part ADXL345", part_ok(pr), pr)

dr = payload(call("labwired_datasheet", {"part": "adxl345", "search": "POWER_CTL"}))
hits = dr.get("hits") or []
check(
    "canary labwired_datasheet ADXL345 POWER_CTL",
    dr.get("outcome") == "OK" and bool(hits),
    dr,
)

ir = payload(
    call(
        "labwired_import",
        {
            "source_kind": "diagram_json",
            "content": json.dumps(
                {
                    "board": "stm32l476",
                    "parts": [{"id": "mcu", "type": "nucleo-l476rg"}],
                    "wires": [],
                }
            ),
            "user_context": "ship-gate knowledge-mcp-smoke",
        },
    )
)
check("canary labwired_import diagram_json", ir.get("ok") is True, ir)

if fail:
    print("knowledge-mcp-smoke FAILED", file=sys.stderr)
    sys.exit(1)
print("ok   knowledge-mcp-smoke PASS (required heroes + canaries)")
sys.exit(0)
PY
