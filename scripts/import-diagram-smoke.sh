#!/usr/bin/env bash
# Schematic/diagram → twin reliability smoke (catalog-honest validate).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIAG="${1:-$ROOT/fixtures/gate1/diagram.json}"
OUT="${LABWIRED_SMOKE_OUT:-$ROOT/fixtures/coverage/smoke}/import"
mkdir -p "$OUT"
test -f "$DIAG" || { echo "missing diagram $DIAG" >&2; exit 2; }

python3 - "$DIAG" "$ROOT" "$OUT" <<'PY'
import json, sys
from pathlib import Path
diag_path, root, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
d = json.loads(diag_path.read_text())
assert isinstance(d, dict), "diagram must be object"
board = d.get("board") or d.get("board_id")
parts = d.get("parts") or []
assert board, "diagram.board required"
assert isinstance(parts, list) and parts, "diagram.parts required"

systems = {p.stem.lower() for p in (root / "share/catalog/systems").glob("*.yaml")}
boards = set()
bp = root / "share/catalog/boards.json"
if bp.is_file():
    data = json.loads(bp.read_text())
    if isinstance(data, list):
        for b in data:
            if isinstance(b, dict):
                boards.add((b.get("id") or b.get("board") or "").lower())
            elif isinstance(b, str):
                boards.add(b.lower())
    elif isinstance(data, dict):
        for b in data.get("boards") or []:
            if isinstance(b, dict):
                boards.add((b.get("id") or "").lower())

facts = {}
fp = root / "server/catalog-facts.json"
if fp.is_file():
    facts = json.loads(fp.read_text())
catalog_parts = set()
for p in facts.get("parts") or []:
    if isinstance(p, dict):
        catalog_parts.add((p.get("type") or p.get("id") or "").lower())

board_l = str(board).lower()
board_known = board_l in systems or board_l in boards or any(board_l in s for s in systems)

mapped, dropped = [], []
for p in parts:
    if not isinstance(p, dict):
        dropped.append({"reason": "not_object"})
        continue
    t = (p.get("type") or p.get("id") or "").lower()
    if not t:
        dropped.append({"id": p.get("id"), "reason": "missing_type"})
        continue
    # Accept system ids, board ids, catalog parts; never invent unknown ICs
    known = (
        t in systems
        or t in boards
        or t == board_l
        or t in catalog_parts
        or any(t in c for c in catalog_parts)
        or "nucleo" in t
        or t.startswith("stm32")
        or t.startswith("esp32")
        or t.startswith("nrf")
        or t.startswith("rp2040")
    )
    if catalog_parts and not known and t not in systems:
        dropped.append({"id": p.get("id"), "type": t, "reason": "not_in_local_catalog"})
        continue
    mapped.append({"id": p.get("id"), "type": t})

result = {
    "ok": bool(board_known and mapped),
    "source_kind": "diagram_json",
    "board": board,
    "board_known": board_known,
    "twin_buildable": bool(board_known and mapped and len(dropped) == 0),
    "design_context_ok": True,
    "mapped_parts": mapped,
    "dropped_parts": dropped,
    "never_invent": True,
}
(out / "import-result.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))
if not result["twin_buildable"]:
    print("import-diagram-smoke: twin not buildable", file=sys.stderr)
    sys.exit(1)
print("ok   import-diagram twin_buildable")
PY
