#!/usr/bin/env bash
# Live Gate 1: real twin red → green (not offline JSON shapes).
#
# Requires: labwired-sim (or monorepo labwired). Optional: riscv toolchain to rebuild ELFs.
# Chip default: esp32c3 (bare-metal UART0 beachhead that the sim boots reliably).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export LABWIRED_AGENT_HOME="${LABWIRED_AGENT_HOME:-$ROOT}"
# shellcheck source=lib/resolve-sim.sh
source "$ROOT/lib/resolve-sim.sh"
# shellcheck source=lib/resolve-catalog.sh
source "$ROOT/lib/resolve-catalog.sh"
# shellcheck source=lib/assert-status.sh
source "$ROOT/lib/assert-status.sh"

CHIP="${LABWIRED_GATE1_CHIP:-esp32c3}"
MARKER="${LABWIRED_HW_MARKER:-LABWIRED_OK}"
MAX_STEPS="${LABWIRED_GATE1_TWIN_STEPS:-5000000}"
FW_DIR="$ROOT/fixtures/gate1-live/firmware"
EV="$ROOT/fixtures/gate1-live/evidence"
CORE="${LABWIRED_CORE_SRC:-$HOME/Projects/labwired/core}"

export PATH="${HOME}/.local/bin:${HOME}/.cargo/bin:${HOME}/.labwired/bin:${PATH}"

SIM=""
if [[ -x "$CORE/target/release/labwired" ]]; then
  SIM="$CORE/target/release/labwired"
elif SIM="$(labwired_resolve_sim 2>/dev/null)"; then
  :
fi
[[ -x "${SIM:-}" ]] || {
  echo "live-gate1: need labwired-sim (install tools or set LABWIRED_CLI)" >&2
  exit 2
}

SYS="$(labwired_catalog_system "$CHIP")" || exit 2

mkdir -p "$EV"
echo "==> live-gate1  chip=$CHIP  sim=$SIM"
echo "    system=$SYS"

# Rebuild ELFs if toolchain present; else use committed prebuilts
if [[ ! -f "$FW_DIR/gate1-fixed.elf" || ! -f "$FW_DIR/gate1-broken.elf" ]] \
  || [[ "${LABWIRED_GATE1_REBUILD:-0}" == "1" ]]; then
  echo "==> build gate1 ELFs"
  make -C "$FW_DIR" all
fi
test -f "$FW_DIR/gate1-fixed.elf" && test -f "$FW_DIR/gate1-broken.elf"

run_one() {
  local label="$1" elf="$2" expect_pass="$3" # expect_pass: 1 marker present, 0 absent
  local out="$EV/$label"
  rm -rf "$out" && mkdir -p "$out"
  local script="$out/test.yaml"
  cat >"$script" <<EOF
schema_version: "1.0"
inputs:
  firmware: "$elf"
  system: "$SYS"
limits:
  max_steps: $MAX_STEPS
  stop_when_assertions_pass: true
assertions:
  - uart_contains: "$MARKER"
EOF
  set +e
  # Prefer core cwd when monorepo sim needs ROMs; catalog systems use chip names so any cwd works
  local cwd="$ROOT"
  [[ -d "$CORE" && "$SIM" == "$CORE"* ]] && cwd="$CORE"
  (cd "$cwd" && "$SIM" test --script "$script" --output-dir "$out" --no-uart-stdout) \
    >"$out/run.log" 2>&1
  local rc=$?
  set -e

  local twin_pass=0
  if [[ -f "$out/result.json" ]] && grep -q '"passed": true' "$out/result.json" 2>/dev/null \
    && grep -q "$MARKER" "$out/uart.log" 2>/dev/null; then
    twin_pass=1
  fi

  # Map twin result → claim shape for assert-status
  local status
  if [[ "$twin_pass" -eq 1 ]]; then
    status="model_verified"
  else
    status="failed"
  fi
  python3 - <<PY
import json
from pathlib import Path
out = Path(r"""$out""")
uart = ""
up = out / "uart.log"
if up.exists():
    uart = up.read_text(errors="replace")[:500]
doc = {
  "status": r"""$status""",
  "path": "twin",
  "chip": r"""$CHIP""",
  "marker": r"""$MARKER""",
  "label": r"""$label""",
  "firmware": r"""$elf""",
  "uart_excerpt": uart,
  "live": True,
  "sim": r"""$SIM""",
}
(out / "verify.json").write_text(json.dumps(doc, indent=2) + "\n")
print(json.dumps({"label": r"""$label""", "status": r"""$status""", "twin_pass": bool($twin_pass)}, indent=2))
PY

  if [[ "$expect_pass" -eq 1 ]]; then
    [[ "$twin_pass" -eq 1 ]] || {
      echo "FAIL $label expected marker $MARKER" >&2
      tail -20 "$out/run.log" >&2 || true
      cat "$out/uart.log" 2>/dev/null | head -20 >&2 || true
      return 1
    }
    labwired_assert_status model_verified <"$out/verify.json"
    echo "ok   $label → model_verified"
  else
    [[ "$twin_pass" -eq 0 ]] || {
      echo "FAIL $label unexpectedly passed twin" >&2
      return 1
    }
    labwired_assert_status failed <"$out/verify.json"
    echo "ok   $label → failed (red)"
  fi
}

echo "==> 1/2 broken (must be red)"
run_one broken "$FW_DIR/gate1-broken.elf" 0

echo "==> 2/2 fixed (must be green)"
run_one fixed "$FW_DIR/gate1-fixed.elf" 1

python3 - <<PY
import json
from pathlib import Path
ev = Path(r"""$EV""")
doc = {
  "gate": "gate1-live",
  "chip": r"""$CHIP""",
  "marker": r"""$MARKER""",
  "broken": json.loads((ev / "broken" / "verify.json").read_text()),
  "fixed": json.loads((ev / "fixed" / "verify.json").read_text()),
  "same_oracle": True,
  "status": "live_pass",
}
(ev / "gate1-live-result.json").write_text(json.dumps(doc, indent=2) + "\n")
print(json.dumps(doc, indent=2))
PY

echo "ok   LIVE Gate 1: broken=failed, fixed=model_verified"
exit 0
