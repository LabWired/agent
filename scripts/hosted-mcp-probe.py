#!/usr/bin/env python3
"""Probe hosted MCP (tools/list + optional tool call) with browser User-Agent.

Cloudflare may ban bare Python UA; OpenCode uses a normal client. This script
uses a Chrome-like UA so CI/dev can smoke hosted tools without video.

Usage:
  python3 scripts/hosted-mcp-probe.py
  python3 scripts/hosted-mcp-probe.py --call labwired_list '{"kind":"board","filter":"esp32"}'
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path


def session():
    p = Path.home() / ".labwired/session/cloud.json"
    if not p.is_file():
        raise SystemExit("no ~/.labwired/session/cloud.json — run labwired login")
    return json.loads(p.read_text())


def post_json(url: str, headers: dict, body: dict) -> tuple[int, str]:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def parse_body(raw: str):
    raw = raw.strip()
    if not raw:
        return None
    if raw.startswith("{"):
        return json.loads(raw)
    # SSE: data: {...}
    for line in raw.splitlines():
        if line.startswith("data:"):
            payload = line[5:].strip()
            if payload and payload != "[DONE]":
                try:
                    return json.loads(payload)
                except json.JSONDecodeError:
                    continue
    return {"raw": raw[:500]}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--call", nargs=2, metavar=("TOOL", "JSON_ARGS"), help="tools/call name args-json")
    args = ap.parse_args()
    s = session()
    token = s.get("access_token") or ""
    proj = s.get("project_id") or ""
    api = (s.get("api_base") or "https://api.labwired.com").rstrip("/")
    url = f"{api}/mcp"
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

    st, raw = post_json(
        url,
        headers,
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "labwired-hosted-mcp-probe", "version": "0.3.3"},
            },
        },
    )
    print("initialize", st, parse_body(raw))
    if st != 200:
        return 1

    st, raw = post_json(
        url,
        headers,
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
    )
    body = parse_body(raw)
    print("tools/list", st)
    tools = []
    if isinstance(body, dict):
        tools = (body.get("result") or {}).get("tools") or []
        names = [t.get("name") for t in tools]
        print("count", len(names))
        for n in names[:20]:
            print(" ", n)
        if "labwired_list" not in names and names:
            print("warn: labwired_list not in first tools — full list may be truncated print")
    if st != 200 or not tools:
        print("FAIL tools/list", raw[:400], file=sys.stderr)
        return 1

    if args.call:
        name, arg_s = args.call
        args_obj = json.loads(arg_s)
        st, raw = post_json(
            url,
            headers,
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": name, "arguments": args_obj},
            },
        )
        print("tools/call", name, st, json.dumps(parse_body(raw))[:600])
        if st != 200:
            return 1
    print("ok   hosted-mcp-probe PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
