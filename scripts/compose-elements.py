#!/usr/bin/env python3
"""Compose observability elements from run artifacts (no ready-made plot types).

E3 recipe: LED vs UART from a UART log (and optional edge CSV).

Usage:
  compose-elements.py --uart path/to/uart.log [--out composed.json]
  compose-elements.py --uart uart.log --edges edges.csv
  cat uart.log | compose-elements.py --uart -

Does not invent series: only lines/edges present in inputs.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

ON_RE = re.compile(r"LED\s*ON|HIGH|LABWIRED_OK", re.I)
OFF_RE = re.compile(r"LED\s*OFF|LOW", re.I)
KV_RE = re.compile(r"([A-Za-z_][\w]*)\s*[=:]\s*(-?\d+(?:\.\d+)?)")


def read_lines(path: str) -> list[str]:
    if path == "-":
        return sys.stdin.read().splitlines()
    return Path(path).read_text(errors="replace").splitlines()


def series_from_uart(lines: list[str]) -> dict[str, Any]:
    markers: list[dict[str, Any]] = []
    digital: list[dict[str, Any]] = []
    numeric: dict[str, list[float]] = {}
    level: int | None = None
    for i, line in enumerate(lines):
        text = line.strip()
        if not text:
            continue
        if ON_RE.search(text):
            level = 1
            markers.append({"t": i, "label": text[:80], "source": "serial"})
            digital.append({"t": i, "level": 1})
        elif OFF_RE.search(text):
            level = 0
            markers.append({"t": i, "label": text[:80], "source": "serial"})
            digital.append({"t": i, "level": 0})
        for m in KV_RE.finditer(text):
            key, val = m.group(1), float(m.group(2))
            numeric.setdefault(key, []).append(val)
        # pure CSV numbers → s0,s1
        if not KV_RE.search(text) and re.match(r"^-?\d", text):
            parts = re.split(r"[\s,;]+", text)
            nums = []
            for p in parts:
                try:
                    nums.append(float(p))
                except ValueError:
                    nums = []
                    break
            for j, n in enumerate(nums):
                numeric.setdefault(f"s{j}", []).append(n)

    series: list[dict[str, Any]] = []
    if digital:
        series.append(
            {
                "id": "led_from_uart",
                "kind": "digital",
                "provenance": "derived_from_uart",
                "points": digital,
            }
        )
    for k, pts in numeric.items():
        series.append(
            {
                "id": k,
                "kind": "analog",
                "provenance": "uart_key_value",
                "points": [{"t": i, "v": v} for i, v in enumerate(pts)],
            }
        )
    return {
        "title": "composed from UART elements",
        "x": {"unit": "index"},
        "series": series,
        "markers": markers,
        "elements_used": ["serial_stream"]
        + (["uart_numeric_series"] if numeric else [])
        + (["led_derived_from_uart"] if digital else []),
        "note": "Observation only — not model_verified. led_from_uart is derived from log markers, not pad edges.",
    }


def merge_edges(composed: dict[str, Any], edges_path: str) -> None:
    """Optional CSV: cycle,channel,value or t,pin,level"""
    rows = Path(edges_path).read_text(errors="replace").splitlines()
    if not rows:
        return
    points: list[dict[str, Any]] = []
    for line in rows[1:] if "," in rows[0] and not rows[0][0].isdigit() else rows:
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 3:
            continue
        try:
            t = float(parts[0])
            val = int(float(parts[-1]))
        except ValueError:
            continue
        points.append({"t": t, "level": val, "channel": parts[1]})
    if points:
        composed["series"].append(
            {
                "id": "gpio_edges",
                "kind": "digital",
                "provenance": "edge_csv",
                "points": points,
            }
        )
        if "gpio_edges" not in composed["elements_used"]:
            composed["elements_used"].append("gpio_edges")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--uart", required=True, help="UART log path or - for stdin")
    ap.add_argument("--edges", help="Optional edge CSV")
    ap.add_argument("--out", help="Write JSON here (default stdout)")
    ap.add_argument(
        "--catalog",
        default=str(Path(__file__).resolve().parents[1] / "share/observability/element-catalog.json"),
        help="Element catalog path",
    )
    args = ap.parse_args()
    lines = read_lines(args.uart)
    composed = series_from_uart(lines)
    if args.edges:
        merge_edges(composed, args.edges)
    cat = Path(args.catalog)
    if cat.is_file():
        composed["catalog_version"] = json.loads(cat.read_text()).get("version")
    text = json.dumps(composed, indent=2) + "\n"
    if args.out:
        Path(args.out).write_text(text)
        print(args.out, file=sys.stderr)
    else:
        sys.stdout.write(text)
    if not composed["series"] and not composed["markers"]:
        print("compose-elements: no elements extracted (empty or unmatched log)", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
