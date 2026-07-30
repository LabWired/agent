#!/usr/bin/env bash
# Refresh share/catalog system stubs from labwired-sim chips (or curated list).
# Compatible with macOS Bash 3.2 (no associative arrays).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/resolve-sim.sh
source "$ROOT/lib/resolve-sim.sh"

CAT="$ROOT/share/catalog"
SYS="$CAT/systems"
mkdir -p "$SYS"

CURATED="esp32c3 esp32s3 esp32 rp2040 nrf52840 nrf52832 stm32l476 stm32f401 stm32f407 stm32f103"

chips=""
if sim="$(labwired_resolve_sim 2>/dev/null)"; then
  while IFS= read -r line; do
    line="$(printf '%s' "$line" | tr -d '[:space:]')"
    case "$line" in
      ''|*[!a-zA-Z0-9_-]*) continue ;;
    esac
    chips="$chips $line"
  done < <("$sim" chips 2>/dev/null | head -80)
fi

if [[ -z "${chips// /}" ]]; then
  chips="$CURATED"
  echo "sync-catalog: using curated list (sim chips unavailable)"
else
  echo "sync-catalog: from sim"
fi

# unique preserve order: curated first, then sim extras
all="$CURATED $chips"
written=""
for c in $all; do
  case " $written " in
    *" $c "*) continue ;;
  esac
  case "$c" in
    ''|*[!a-zA-Z0-9_-]*) continue ;;
  esac
  cat >"$SYS/${c}.yaml" <<YML
# LabWired agent twin system — thin wrapper around sim-bundled chip "$c".
name: "agent-$c"
chip: "$c"
external_devices: []
board_io: []
YML
  written="$written $c"
done

python3 - <<PY
import json
from pathlib import Path
root = Path(r"""$CAT""")
systems = sorted(p.stem for p in (root / "systems").glob("*.yaml"))
doc = {
  "schema_version": "1.0",
  "description": "Twin board catalog for LabWired Agent (chip ids bundled in labwired-sim)",
  "boards": [
    {"id": s, "system": f"systems/{s}.yaml", "chip": s, "role": "twin"}
    for s in systems
  ],
}
(root / "boards.json").write_text(json.dumps(doc, indent=2) + "\n")
print(f"sync-catalog: wrote {len(systems)} boards → {root / 'boards.json'}")
PY
