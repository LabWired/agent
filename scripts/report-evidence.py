#!/usr/bin/env python3
"""Dual-claim evidence report from verify / HW JSON (never invents green).

Usage:
  report-evidence.py --twin fixtures/gate1/artifacts/fixed.verify.json
  report-evidence.py --twin verify.json --hw hw-result.json --out report.md
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def load(path: str | None) -> dict[str, Any] | None:
    if not path:
        return None
    p = Path(path)
    if not p.is_file():
        raise SystemExit(f"missing file: {path}")
    return json.loads(p.read_text())


def status_of(payload: dict[str, Any] | None) -> str:
    if not payload:
        return "not_run"
    return str(payload.get("status") or "unknown")


def evidence_ref(payload: dict[str, Any] | None) -> str:
    if not payload:
        return "n/a"
    return str(payload.get("evidence_ref") or payload.get("capture_ref") or "missing")


def allowed_claim(twin: str, hw: str) -> str:
    lines = []
    if twin == "model_verified":
        lines.append("Twin: may say model-verified (oracle only).")
    elif twin == "not_run":
        lines.append("Twin: not run — do not claim model-verified.")
    else:
        lines.append(f"Twin: status={twin} — do not claim model-verified.")
    if hw == "hardware_observed":
        lines.append("HW: may say hardware-observed (flash+marker only).")
    elif hw == "not_run":
        lines.append("HW: not run — do not claim hardware-observed.")
    else:
        lines.append(f"HW: status={hw} — do not claim hardware-observed.")
    lines.append("Never upgrade hardware_observed → model_verified.")
    return " ".join(lines)


def render(twin: dict[str, Any] | None, hw: dict[str, Any] | None) -> str:
    ts, hs = status_of(twin), status_of(hw)
    gaps = []
    if twin and isinstance(twin.get("gaps"), list):
        gaps = twin["gaps"]
    lines = [
        "# LabWired evidence report",
        "",
        "## Dual-claim footer",
        "",
        "```text",
        f"twin_status:       {ts}",
        f"hardware_status:   {hs}",
        f"twin_evidence:     {evidence_ref(twin)}",
        f"hw_evidence:       {evidence_ref(hw)}",
        f"marker:            {(hw or {}).get('marker') or (twin or {}).get('marker') or 'n/a'}",
        "```",
        "",
        "## Allowed claims",
        "",
        allowed_claim(ts, hs),
        "",
        "## Gaps",
        "",
    ]
    if gaps:
        for g in gaps:
            lines.append(f"- {g}")
    else:
        lines.append("- (none listed)" if twin else "- (twin not run)")
    if twin:
        lines += ["", "## Twin payload (excerpt)", "", "```json", json.dumps({
            "status": twin.get("status"),
            "evidence_ref": twin.get("evidence_ref"),
            "oracle_results": twin.get("oracle_results"),
            "gaps": twin.get("gaps"),
            "firmware_ref": twin.get("firmware_ref"),
            "board": twin.get("board"),
        }, indent=2), "```"]
    if hw:
        lines += ["", "## Hardware payload (excerpt)", "", "```json", json.dumps({
            "status": hw.get("status"),
            "marker": hw.get("marker"),
            "chip": hw.get("chip"),
            "evidence_ref": hw.get("evidence_ref") or hw.get("capture_ref"),
        }, indent=2), "```"]
    # Green requires evidence_ref when twin model_verified
    if ts == "model_verified" and evidence_ref(twin) in ("missing", "n/a", ""):
        lines += [
            "",
            "## Warning",
            "",
            "status is model_verified but evidence_ref is missing — treat as incomplete report.",
        ]
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--twin", help="labwired_verify / assert JSON")
    ap.add_argument("--hw", help="hardware_observed result JSON")
    ap.add_argument("--out", help="Write markdown report path")
    ap.add_argument("--require-evidence-on-green", action="store_true",
                    help="Exit 2 if twin model_verified without evidence_ref")
    args = ap.parse_args()
    if not args.twin and not args.hw:
        ap.error("need --twin and/or --hw")
    twin, hw = load(args.twin), load(args.hw)
    text = render(twin, hw)
    if args.out:
        Path(args.out).write_text(text)
        print(args.out, file=sys.stderr)
    else:
        sys.stdout.write(text)
    if args.require_evidence_on_green and twin and status_of(twin) == "model_verified":
        if evidence_ref(twin) in ("missing", "n/a", ""):
            print("FAIL: model_verified without evidence_ref", file=sys.stderr)
            return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
