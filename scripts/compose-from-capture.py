#!/usr/bin/env python3
"""Compose multi-series JSON from a logic-analyzer style capture (agent element path).

Accepts:
  - LabWired CaptureObject JSON (edges + samples + meta) from playground export
  - Simple edge CSV: cycle,channel,value
  - Optional UART log merged via compose-elements

Does not invent points; empty input → exit 2.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def from_capture_object(data: dict[str, Any]) -> dict[str, Any]:
    series: list[dict[str, Any]] = []
    edges = data.get("edges") or []
    by_ch: dict[str, list] = {}
    for e in edges:
        ch = str(e.get("channel") or e.get("pin") or "CH")
        by_ch.setdefault(ch, []).append(
            {"t": e.get("cycle", e.get("t")), "level": e.get("value", e.get("level"))}
        )
    for ch, pts in by_ch.items():
        series.append({
            "id": f"edge.{ch}",
            "kind": "digital",
            "provenance": "logic_capture_edges",
            "points": pts,
        })
    samples = data.get("samples") or []
    if samples and not series:
        # fallback sample table
        chans = set()
        for s in samples:
            for c in s.get("channels") or []:
                chans.add(c.get("channel"))
        for ch in sorted(x for x in chans if x):
            pts = []
            for s in samples:
                for c in s.get("channels") or []:
                    if c.get("channel") == ch and c.get("value") is not None:
                        pts.append({"t": s.get("t"), "level": c.get("value")})
            if pts:
                series.append({
                    "id": f"sample.{ch}",
                    "kind": "digital",
                    "provenance": "logic_capture_samples",
                    "points": pts,
                })
    return {
        "title": data.get("meta", {}).get("analyzerId") or "logic capture",
        "x": {"unit": "cycle"},
        "series": series,
        "markers": [],
        "elements_used": ["logic_capture", "gpio_edges"] if series else [],
        "source_run": data.get("meta"),
        "note": "Observation only — not model_verified",
    }


def from_edge_csv(text: str) -> dict[str, Any]:
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if not lines:
        return {"series": [], "elements_used": []}
    start = 1 if ("," in lines[0] and not lines[0][0].isdigit()) else 0
    by_ch: dict[str, list] = {}
    for ln in lines[start:]:
        parts = [p.strip() for p in ln.split(",")]
        if len(parts) < 3:
            continue
        try:
            t = float(parts[0])
            val = int(float(parts[-1]))
        except ValueError:
            continue
        ch = parts[1]
        by_ch.setdefault(ch, []).append({"t": t, "level": val})
    series = [
        {"id": f"edge.{ch}", "kind": "digital", "provenance": "edge_csv", "points": pts}
        for ch, pts in by_ch.items()
    ]
    return {
        "title": "edges from CSV",
        "x": {"unit": "cycle"},
        "series": series,
        "markers": [],
        "elements_used": ["gpio_edges"] if series else [],
        "note": "Observation only — not model_verified",
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--capture", help="CaptureObject JSON path")
    ap.add_argument("--edges-csv", help="cycle,channel,value CSV")
    ap.add_argument("--uart", help="Optional UART log to merge markers/series")
    ap.add_argument("--out", help="Write composed JSON")
    args = ap.parse_args()
    if not args.capture and not args.edges_csv:
        ap.error("need --capture and/or --edges-csv")

    composed: dict[str, Any] = {
        "title": "composed capture",
        "x": {"unit": "cycle"},
        "series": [],
        "markers": [],
        "elements_used": [],
        "note": "Observation only — not model_verified",
    }
    if args.capture:
        data = json.loads(Path(args.capture).read_text())
        composed = from_capture_object(data)
    if args.edges_csv:
        edge = from_edge_csv(Path(args.edges_csv).read_text())
        composed["series"].extend(edge.get("series") or [])
        for e in edge.get("elements_used") or []:
            if e not in composed["elements_used"]:
                composed["elements_used"].append(e)
    if args.uart:
        # merge via compose-elements module logic
        root = Path(__file__).resolve().parent
        sys.path.insert(0, str(root))
        from importlib.util import spec_from_loader, module_from_spec
        # simpler: subprocess-style import by path
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "compose_elements", root / "compose-elements.py"
        )
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader
        spec.loader.exec_module(mod)
        uart_comp = mod.series_from_uart(Path(args.uart).read_text().splitlines())
        composed["series"].extend(uart_comp.get("series") or [])
        composed["markers"].extend(uart_comp.get("markers") or [])
        for e in uart_comp.get("elements_used") or []:
            if e not in composed["elements_used"]:
                composed["elements_used"].append(e)

    if not composed.get("series") and not composed.get("markers"):
        print("compose-from-capture: no elements", file=sys.stderr)
        return 2
    text = json.dumps(composed, indent=2) + "\n"
    if args.out:
        Path(args.out).write_text(text)
        print(args.out, file=sys.stderr)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
