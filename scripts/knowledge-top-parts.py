#!/usr/bin/env python3
"""Probe knowledge usefulness for kit heroes (list/describe/part/datasheet + local catalog).

Does not invent answers. Reports fact/list hits vs missing so we can improve coverage.

Usage:
  python3 scripts/knowledge-top-parts.py
  python3 scripts/knowledge-top-parts.py --local-only
  python3 scripts/knowledge-top-parts.py --out share/catalog/knowledge-heroes-latest.json
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_session():
    p = Path.home() / ".labwired/session/cloud.json"
    if not p.is_file():
        return None
    return json.loads(p.read_text())


def mcp_call(session: dict, name: str, arguments: dict, req_id: int = 1):
    api = (session.get("api_base") or "https://api.labwired.com").rstrip("/")
    url = f"{api}/mcp"
    token = session.get("access_token") or ""
    proj = session.get("project_id") or ""
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        ),
        "X-LabWired-Project": proj,
    }

    def post(body):
        req = urllib.request.Request(
            url, data=json.dumps(body).encode(), headers=headers, method="POST"
        )
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read().decode()
        raw = raw.strip()
        if raw.startswith("{"):
            return json.loads(raw)
        for line in raw.splitlines():
            if line.startswith("data:"):
                payload = line[5:].strip()
                if payload and payload != "[DONE]":
                    return json.loads(payload)
        return {"raw": raw[:300]}

    post(
        {
            "jsonrpc": "2.0",
            "id": 0,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "knowledge-top-parts", "version": "0.3.7"},
            },
        }
    )
    return post(
        {
            "jsonrpc": "2.0",
            "id": req_id,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        }
    )


def extract_payload(resp: dict):
    if not isinstance(resp, dict):
        return resp
    result = resp.get("result") or {}
    if "structuredContent" in result:
        return result["structuredContent"]
    content = result.get("content") or []
    for c in content:
        if isinstance(c, dict) and c.get("type") == "text":
            try:
                return json.loads(c["text"])
            except Exception:
                return {"text": c.get("text", "")[:200]}
    if "error" in resp:
        return {"error": resp["error"]}
    return result


def local_lookup(hero_id: str, facts: dict, systems: set[str]) -> dict:
    hid = hero_id.lower()
    out = {"local_catalog": False, "local_system": False, "detail": {}}
    parts = facts.get("parts") or []
    if isinstance(parts, list):
        for p in parts:
            if not isinstance(p, dict):
                continue
            t = (p.get("type") or p.get("id") or "").lower()
            if t == hid or hid in t:
                out["local_catalog"] = True
                out["detail"] = {
                    "type": p.get("type"),
                    "pin_count": len(p.get("pins") or {}) if isinstance(p.get("pins"), dict) else p.get("pin_count"),
                    "transport": p.get("transport"),
                    "has_pins": bool(p.get("pins")),
                }
                break
    if hid in systems or hid.replace("-", "") in {s.replace("-", "") for s in systems}:
        out["local_system"] = True
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--local-only", action="store_true")
    ap.add_argument(
        "--heroes",
        default=str(ROOT / "share/catalog/kit-heroes.json"),
    )
    ap.add_argument(
        "--out",
        default=str(ROOT / "share/catalog/knowledge-heroes-latest.json"),
    )
    args = ap.parse_args()

    heroes_doc = json.loads(Path(args.heroes).read_text())
    heroes = heroes_doc.get("heroes") or []
    facts_path = ROOT / "server/catalog-facts.json"
    facts = json.loads(facts_path.read_text()) if facts_path.is_file() else {}
    systems = {p.stem.lower() for p in (ROOT / "share/catalog/systems").glob("*.yaml")}

    session = None if args.local_only else load_session()
    rows = []
    list_hits = part_hits = ds_hits = local_hits = 0

    for i, h in enumerate(heroes, start=1):
        hid = h["id"]
        row = {
            "id": hid,
            "kind": h.get("kind"),
            "local": local_lookup(hid, facts, systems),
            "mcp": {},
        }
        if row["local"].get("local_catalog") or row["local"].get("local_system"):
            local_hits += 1

        if session:
            try:
                # list component/board
                kind = h.get("kind") or "part"
                list_kind = "component" if kind == "part" else ("board" if kind == "board" else "mcu")
                # try component filter for parts
                lr = extract_payload(
                    mcp_call(session, "labwired_list", {"kind": list_kind if list_kind != "mcu" else "component", "filter": hid}, req_id=10 + i)
                )
                # also try without kind if empty
                listed = False
                if isinstance(lr, dict):
                    for key in ("components", "boards", "items", "mcus"):
                        arr = lr.get(key)
                        if isinstance(arr, list) and arr:
                            listed = True
                            break
                    if not listed and lr.get("type") or lr.get("id"):
                        listed = True
                row["mcp"]["list"] = {"hit": listed, "sample": str(lr)[:240]}
                if listed:
                    list_hits += 1

                pr = extract_payload(
                    mcp_call(session, "labwired_part", {"query": hid}, req_id=100 + i)
                )
                part_ok = isinstance(pr, dict) and pr.get("outcome") not in (
                    "NOT_FOUND",
                    None,
                ) and "error" not in pr
                # NOT_FOUND is explicit miss
                if isinstance(pr, dict) and pr.get("outcome") == "NOT_FOUND":
                    part_ok = False
                elif isinstance(pr, dict) and pr and pr.get("outcome") != "NOT_FOUND":
                    # any non-empty structured answer without NOT_FOUND
                    part_ok = pr.get("outcome") not in (None, "NOT_FOUND") or any(
                        k in pr for k in ("facts", "configurationId", "items", "value")
                    )
                row["mcp"]["part"] = {"hit": bool(part_ok), "sample": str(pr)[:240]}
                if part_ok:
                    part_hits += 1

                # datasheet — try common arg shapes
                ds = None
                for args_try in (
                    {"query": hid},
                    {"q": hid},
                    {"part": hid},
                    {"search": hid},
                ):
                    try:
                        ds = extract_payload(
                            mcp_call(session, "labwired_datasheet", args_try, req_id=200 + i)
                        )
                        if isinstance(ds, dict) and ds.get("error") == "INVALID_ARGS":
                            continue
                        break
                    except Exception:
                        continue
                ds_ok = False
                if isinstance(ds, dict):
                    if ds.get("error") and ds.get("error") != "NOT_FOUND":
                        # invalid still counts as tool alive
                        ds_ok = "hits" in ds or "pages" in ds or "results" in ds
                    else:
                        ds_ok = bool(
                            ds.get("hits")
                            or ds.get("pages")
                            or ds.get("results")
                            or ds.get("text")
                            or (ds.get("outcome") and ds.get("outcome") != "NOT_FOUND")
                        )
                row["mcp"]["datasheet"] = {"hit": ds_ok, "sample": str(ds)[:240] if ds else None}
                if ds_ok:
                    ds_hits += 1
            except Exception as e:
                row["mcp"]["error"] = str(e)[:200]

        # Usefulness: local catalog OR list hit is minimum; part hit is strong
        useful = bool(
            row["local"].get("local_catalog")
            or row["local"].get("local_system")
            or (row.get("mcp") or {}).get("list", {}).get("hit")
            or (row.get("mcp") or {}).get("part", {}).get("hit")
        )
        row["useful"] = useful
        rows.append(row)

    n = len(heroes)
    summary = {
        "heroes": n,
        "local_hits": local_hits,
        "mcp_list_hits": list_hits if session else None,
        "mcp_part_hits": part_hits if session else None,
        "mcp_datasheet_hits": ds_hits if session else None,
        "useful_count": sum(1 for r in rows if r.get("useful")),
        "session": bool(session),
        "rows": rows,
        "note": "useful = local catalog/system OR mcp list/part hit. Prefer growing part facts + datasheet retrieval.",
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(summary, indent=2) + "\n")
    print(
        f"ok   knowledge heroes useful={summary['useful_count']}/{n} "
        f"local={local_hits} list={list_hits} part={part_hits} datasheet={ds_hits} → {out}"
    )
    # Gate: at least half of heroes useful locally or via MCP
    if summary["useful_count"] < max(1, n // 2):
        print("FAIL knowledge usefulness below 50%", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
