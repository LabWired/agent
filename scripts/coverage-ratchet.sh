#!/usr/bin/env bash
# Knowledge coverage ratchet: top-20 kit list vs local catalog facts + twin systems.
# Publishes a machine-readable count under fixtures/coverage/ (gitignored evidence ok;
# also prints summary for CI / weekly owner check).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOP20="$ROOT/share/catalog/coverage-top20.json"
FACTS="$ROOT/server/catalog-facts.json"
SYS_DIR="$ROOT/share/catalog/systems"
OUT_DIR="${LABWIRED_COVERAGE_OUT:-$ROOT/fixtures/coverage}"
mkdir -p "$OUT_DIR"

python3 - "$TOP20" "$FACTS" "$SYS_DIR" "$OUT_DIR" <<'PY'
import json, sys
from pathlib import Path
from datetime import datetime, timezone

top20_path, facts_path, sys_dir, out_dir = map(Path, sys.argv[1:5])
top = json.loads(top20_path.read_text())
targets = top.get("targets") or []

facts = {}
if facts_path.is_file():
    facts = json.loads(facts_path.read_text())

parts = facts.get("parts") or []
part_types = set()
part_by_type = {}
if isinstance(parts, list):
    for p in parts:
        if isinstance(p, dict):
            t = (p.get("type") or p.get("id") or "").lower()
            if t:
                part_types.add(t)
                part_by_type[t] = p
elif isinstance(parts, dict):
    part_types = {k.lower() for k in parts}
    part_by_type = {k.lower(): v for k, v in parts.items()}

chips = facts.get("chips") or []
chip_ids = set()
if isinstance(chips, list):
    for c in chips:
        if isinstance(c, dict):
            chip_ids.add((c.get("id") or c.get("name") or c.get("chip") or "").lower())
        elif isinstance(c, str):
            chip_ids.add(c.lower())
elif isinstance(chips, dict):
    chip_ids = {k.lower() for k in chips}

device_types = facts.get("device_types") or []
dev_ids = set()
if isinstance(device_types, list):
    for d in device_types:
        if isinstance(d, dict):
            dev_ids.add((d.get("id") or d.get("type") or d.get("name") or "").lower())
        elif isinstance(d, str):
            dev_ids.add(d.lower())

systems = {}
if sys_dir.is_dir():
    for y in sys_dir.glob("*.yaml"):
        systems[y.stem.lower()] = y.name

def has_pins(obj) -> bool:
    if not isinstance(obj, dict):
        return False
    pins = obj.get("pins") or obj.get("pinout") or obj.get("boardIo") or obj.get("board_io")
    if pins:
        return True
    # nested attrs
    return bool(obj.get("pin_map") or obj.get("gpio"))

rows = []
hit = 0
pinout_hit = 0
for t in targets:
    tid = (t.get("id") or "").lower()
    kind = t.get("kind") or "part"
    need = t.get("need") or []
    found = False
    pinout = False
    sources = []
    if tid in part_types:
        found = True
        sources.append("catalog-facts.parts")
        pinout = has_pins(part_by_type.get(tid) or {})
    if tid in chip_ids or tid.replace("-", "") in {c.replace("-", "") for c in chip_ids}:
        found = True
        sources.append("catalog-facts.chips")
    if tid in dev_ids:
        found = True
        sources.append("catalog-facts.device_types")
    # systems / board aliases
    aliases = {
        "esp32-c3-supermini": ["esp32c3", "esp32-c3"],
        "esp32c3": ["esp32c3"],
        "nucleo-l476rg": ["stm32l476"],
        "stm32l476": ["stm32l476"],
        "stm32f103-blinky": ["stm32f103"],
        "stm32h563": ["stm32h563"],
        "esp32-s3": ["esp32s3", "esp32s3-zero"],
        "rp2040": ["rp2040"],
        "nrf52840": ["nrf52840"],
    }
    for a in [tid] + aliases.get(tid, []):
        if a in systems:
            found = True
            sources.append(f"systems/{systems[a]}")
            pinout = True  # twin system implies beachhead pin story for MCU/board
    # loose contains
    if not found:
        for p in part_types:
            if tid in p or p in tid:
                found = True
                sources.append(f"catalog-facts.parts~{p}")
                pinout = has_pins(part_by_type.get(p) or {})
                break
    if found:
        hit += 1
    if pinout or (found and "pinout" not in need):
        if "pinout" in need and pinout:
            pinout_hit += 1
        elif "pinout" not in need and found:
            pinout_hit += 1
    rows.append({
        "id": t.get("id"),
        "kind": kind,
        "need": need,
        "found_local": found,
        "pinout_local": pinout,
        "sources": sources,
    })

total = len(targets)
summary = {
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "total_targets": total,
    "found_local": hit,
    "found_pct": round(100.0 * hit / total, 1) if total else 0,
    "pinout_or_ok": pinout_hit,
    "catalog_parts_count": len(part_types),
    "twin_systems_count": len(systems),
    "note": "Local agent kit coverage (catalog-facts + twin systems). Hosted labwired_part/datasheet is separate.",
    "rows": rows,
}
out = out_dir / "coverage-latest.json"
out.write_text(json.dumps(summary, indent=2) + "\n")
# also write markdown table for humans
md = out_dir / "coverage-latest.md"
lines = [
    f"# Coverage ratchet",
    f"",
    f"Generated: {summary['generated_at']}",
    f"",
    f"**{hit}/{total}** top-20 targets found in local kit ({summary['found_pct']}%).",
    f"Catalog parts: {summary['catalog_parts_count']}. Twin systems: {summary['twin_systems_count']}.",
    f"",
    f"| id | kind | found | pinout | sources |",
    f"|----|------|-------|--------|---------|",
]
for r in rows:
    lines.append(
        f"| {r['id']} | {r['kind']} | {'✅' if r['found_local'] else '⬜'} | "
        f"{'✅' if r['pinout_local'] else '⬜'} | {', '.join(r['sources']) or '—'} |"
    )
md.write_text("\n".join(lines) + "\n")
print(f"ok   coverage {hit}/{total} ({summary['found_pct']}%) → {out}")
print(f"     markdown → {md}")
# fail only if catastrophic
if hit < max(1, total // 4):
    print("FAIL coverage below 25% of top-20", file=sys.stderr)
    sys.exit(1)
sys.exit(0)
PY
