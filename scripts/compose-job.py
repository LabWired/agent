#!/usr/bin/env python3
"""One job: user need → elements → composed view (no invent, no Open Plot).

Thin orchestrator on top of compose-elements.py / compose-from-capture.py.

Usage:
  compose-job.py --ask "plot LED vs UART" --uart path/to/uart.log [--out composed.json]
  compose-job.py --ask "show logic capture" --capture path.json [--out composed.json]
  compose-job.py --ask "plot LED vs UART" --from last-run [--out composed.json]

Exit: 0 non-empty observation, 2 missing source / empty elements / unknown need.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "share/observability/element-catalog.json"
COMPOSE_UART = ROOT / "scripts/compose-elements.py"
COMPOSE_CAP = ROOT / "scripts/compose-from-capture.py"

# Cheap NL → recipe id (catalog compose_examples). Keep dumb on purpose.
ASK_TO_RECIPE: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"logic|capture|gpio|edges?|pins?|la\b|waveform", re.I), "la_capture"),
    (re.compile(r"led|uart|serial|marker|labwired_ok|plot|graph|show|overlay", re.I), "e3_led_vs_uart"),
]


def load_catalog() -> dict[str, Any]:
    if not CATALOG.is_file():
        return {"compose_examples": [], "version": 0}
    return json.loads(CATALOG.read_text())


def pick_recipe(ask: str, catalog: dict[str, Any]) -> dict[str, Any] | None:
    examples = {e["id"]: e for e in (catalog.get("compose_examples") or []) if isinstance(e, dict)}
    # Prefer explicit catalog ask substring match
    ask_l = ask.lower().strip()
    for ex in examples.values():
        cat_ask = (ex.get("ask") or "").lower()
        if cat_ask and (cat_ask in ask_l or ask_l in cat_ask):
            return ex
    for pat, rid in ASK_TO_RECIPE:
        if pat.search(ask) and rid in examples:
            return examples[rid]
    # default serial plot if any words look observational
    if examples.get("e3_led_vs_uart") and re.search(r"plot|show|graph|uart|led", ask, re.I):
        return examples["e3_led_vs_uart"]
    return None


def find_last_uart() -> Path | None:
    """Prefer newest uart.log under kit evidence / coverage smoke dirs."""
    candidates: list[Path] = []
    roots = [
        ROOT / "fixtures/gate1-live/evidence",
        ROOT / "fixtures/coverage/smoke",
        Path.home() / ".labwired/evidence",
        Path.cwd() / ".labwired/evidence",
    ]
    for r in roots:
        if not r.is_dir():
            continue
        candidates.extend(r.rglob("uart.log"))
    if not candidates:
        # gate1 fixed is the kit canary
        fixed = ROOT / "fixtures/gate1-live/evidence/fixed/uart.log"
        return fixed if fixed.is_file() else None
    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates[0]


def run_compose(cmd: list[str]) -> tuple[int, str]:
    p = subprocess.run(cmd, capture_output=True, text=True)
    err = (p.stderr or "") + (p.stdout or "")
    return p.returncode, err


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--ask", required=True, help="User need, e.g. plot LED vs UART")
    ap.add_argument("--uart", help="UART log path")
    ap.add_argument("--capture", help="Logic capture JSON")
    ap.add_argument("--from", dest="from_src", choices=["last-run"], help="Resolve uart from last-run evidence")
    ap.add_argument("--out", default="composed.json", help="Output composed JSON path")
    args = ap.parse_args()

    catalog = load_catalog()
    recipe = pick_recipe(args.ask, catalog)
    if recipe is None:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "unknown_need",
                    "detail": "Could not map ask to a compose recipe. Try: plot LED vs UART | show logic capture",
                    "ask": args.ask,
                    "note": "observation only — not model_verified / hardware_observed",
                },
                indent=2,
            ),
            file=sys.stderr,
        )
        return 2

    out = Path(args.out)
    rid = recipe.get("id") or ""
    uart = Path(args.uart) if args.uart else None
    capture = Path(args.capture) if args.capture else None

    if args.from_src == "last-run" and uart is None:
        uart = find_last_uart()

    # Route by recipe script
    script = recipe.get("script") or "scripts/compose-elements.py"
    if "capture" in script or rid == "la_capture":
        if capture is None or not capture.is_file():
            sample = ROOT / "fixtures/observability/sample-capture.json"
            if sample.is_file() and args.from_src == "last-run":
                capture = sample
            else:
                print("compose-job: NEED_CAPTURE — pass --capture <json>", file=sys.stderr)
                return 2
        cmd = [sys.executable, str(COMPOSE_CAP), "--capture", str(capture), "--out", str(out)]
        if uart and uart.is_file():
            cmd.extend(["--uart", str(uart)])
    else:
        if uart is None or not uart.is_file():
            print(
                "compose-job: NEED_UART — pass --uart <log> or --from last-run (no uart.log found)",
                file=sys.stderr,
            )
            return 2
        cmd = [sys.executable, str(COMPOSE_UART), "--uart", str(uart), "--out", str(out)]

    rc, err = run_compose(cmd)
    if rc != 0 or not out.is_file():
        print(f"compose-job: compose failed rc={rc}", file=sys.stderr)
        if err.strip():
            print(err.strip()[:500], file=sys.stderr)
        return 2

    doc = json.loads(out.read_text())
    # Tie job metadata without inventing series
    doc["ok"] = bool(doc.get("series") or doc.get("markers"))
    doc["ask"] = args.ask
    doc["recipe_id"] = rid
    doc["elements_planned"] = recipe.get("elements") or []
    doc["note"] = (
        (doc.get("note") or "")
        + " | compose-job: observation only — never invent; not model_verified or hardware_observed"
    ).strip(" |")
    if not doc["ok"]:
        doc["error"] = "empty_elements"
        doc["detail"] = "No matching lines/edges in source — refuse to invent a graph"
        out.write_text(json.dumps(doc, indent=2) + "\n")
        print(str(out), file=sys.stderr)
        print("compose-job: empty — no invent", file=sys.stderr)
        return 2

    out.write_text(json.dumps(doc, indent=2) + "\n")
    # Human one-liner for agent
    n_s = len(doc.get("series") or [])
    n_m = len(doc.get("markers") or [])
    print(json.dumps({"ok": True, "out": str(out), "recipe_id": rid, "series": n_s, "markers": n_m}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
