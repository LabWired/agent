#!/usr/bin/env bash
# rpc-promote.sh — ONE promote engine.
#
# `labwired agent promote` (lib/promote.sh) and the RPC server's hw_promote must
# produce the same stdout, the same stderr and the same exit code for the same
# inputs, because hw_promote is nothing but an argv row onto that subcommand.
# A JS re-implementation in the server would drift, and the drift that matters is
# always the same one: the editor promoting on evidence the terminal refuses.
#
# Two kinds of check here, and both are needed:
#   compare()  — CLI vs RPC. Catches drift in the argv row / param plumbing
#                (a dropped flag, an editor default leaking into promote).
#   assert_*() — absolute expectations on the payload. Catches drift inside
#                lib/promote.sh, which compare() alone would call "identical".
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/bin/labwired-agent"
NODE_BIN="$(command -v node)"
TMP="$(mktemp -d -t labwired-rpc-promote)"
trap 'rm -rf "$TMP"' EXIT

# The confirm gate reads LABWIRED_FLASH_AUTO. Pin it off so both surfaces gate,
# and turn it on explicitly in the one case that tests the override.
export LABWIRED_FLASH_AUTO=0

# Drive hw_promote over JSON-RPC and print stdout / stderr / exit in a shape the
# CLI side can reproduce byte for byte.
rpc_promote() {
  python3 - "$ROOT/server/rpc-server.mjs" "$NODE_BIN" "$1" <<'PY'
import json, os, select, subprocess, sys, time
server, node, raw = sys.argv[1:4]
p = subprocess.Popen([node, server], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.PIPE, env=dict(os.environ))
body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tool/run", "params": {
    "name": "hw_promote",
    "params": json.loads(raw),
}}).encode()
p.stdin.write(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
p.stdin.flush()
buf, msg, deadline = b"", None, time.time() + 60
while time.time() < deadline and msg is None:
    ready, _, _ = select.select([p.stdout], [], [], 0.2)
    if not ready:
        continue
    buf += p.stdout.read1(65536)
    while True:
        split = buf.find(b"\r\n\r\n")
        if split < 0:
            break
        length = int(buf[:split].decode().split(":", 1)[1].strip())
        end = split + 4 + length
        if len(buf) < end:
            break
        cand = json.loads(buf[split + 4:end])
        buf = buf[end:]
        if cand.get("id") == 1:
            msg = cand
            break
p.terminate()
res = (msg or {}).get("result") or {}
# Trailing newlines stripped on both streams: bash $() strips them too, so the
# CLI side compares like for like.
sys.stdout.write(res.get("stdout", "").rstrip("\n"))
sys.stdout.write("\n--- stderr ---\n")
sys.stdout.write(res.get("stderr", "").rstrip("\n"))
sys.stdout.write(f"\nEXIT={res.get('code')}\n")
PY
}

cli_promote() {
  local out rc err_f="$TMP/cli.err"
  set +e
  out="$("$CLI" promote "$@" 2>"$err_f")"
  rc=$?
  set -e
  printf '%s\n--- stderr ---\n%s\nEXIT=%s\n' "$out" "$(cat "$err_f")" "$rc"
}

fail=0
LAST=""

# CLI vs RPC for one input, then keep the agreed payload for the assertions.
compare() {
  local label="$1" json="$2"
  shift 2
  local a b
  a="$(cli_promote "$@")"
  b="$(rpc_promote "$json")"
  LAST="$a"
  if [[ "$a" != "$b" ]]; then
    echo "FAIL $label — CLI and RPC disagree"
    echo "--- CLI ---"; printf '%s\n' "$a"
    echo "--- RPC ---"; printf '%s\n' "$b"
    fail=1
    return 0
  fi
  echo "ok   $label — CLI == RPC ($(grep -o 'EXIT=[0-9]*' <<<"$a" | tail -1))"
  return 0
}

# The claim section only. serial-capture prints its own "hardware_observed" into
# the capture section, so a whole-payload grep would pass on a broken claim.
claim_section() {
  printf '%s\n' "$LAST" | sed -n '/^=== claim ===$/,/^--- stderr ---$/p'
}

assert_claim_has() {
  if ! claim_section | grep -q -- "$1"; then
    echo "FAIL   claim section missing: $1"
    claim_section
    fail=1
  fi
}
assert_claim_lacks() {
  if claim_section | grep -q -- "$1"; then
    echo "FAIL   claim section must NOT contain: $1"
    claim_section
    fail=1
  fi
}
assert_has() {
  if ! printf '%s\n' "$LAST" | grep -q -- "$1"; then
    echo "FAIL   payload missing: $1"
    printf '%s\n' "$LAST"
    fail=1
  fi
}
assert_exit() {
  local want="$1" got
  got="$(printf '%s\n' "$LAST" | grep -o 'EXIT=[0-9]*' | tail -1)"
  if [[ "$got" != "EXIT=$want" ]]; then
    echo "FAIL   expected EXIT=$want, got $got"
    printf '%s\n' "$LAST"
    fail=1
  fi
}

# 1. Both signals present: the only shape that may claim hardware.
compare "dry-run flashed+marker" \
  '{"dry_run":"1","flashed":"1","marker_matched":"1","target":"virtual"}' \
  --dry-run 1 --flashed 1 --marker-matched 1 --target virtual
assert_claim_has '"status": "hardware_observed"'
assert_exit 0

# 2. THE case this gate exists for: flashed, marker never observed.
#    A promote that cannot show the marker must never claim hardware.
compare "dry-run flashed, NO marker" \
  '{"dry_run":"1","flashed":"1","marker_matched":"0","target":"virtual"}' \
  --dry-run 1 --flashed 1 --marker-matched 0 --target virtual
assert_claim_has '"status": "failed"'
assert_claim_has '"claim": "no_hardware_claim"'
# Not a bare grep for hardware_observed: the payload's own note ends with that
# word. Only the two load-bearing fields may never carry it.
assert_claim_lacks '"status": "hardware_observed"'
assert_claim_lacks '"claim": "hardware_observed"'
assert_exit 1

# 3. Neither signal.
compare "dry-run nothing" \
  '{"dry_run":"1","flashed":"0","marker_matched":"0","target":"virtual"}' \
  --dry-run 1 --flashed 0 --marker-matched 0 --target virtual
assert_claim_has '"status": "failed"'
assert_exit 1

# 4. Confirm gate: a physical target without confirm=1 runs nothing at all.
compare "physical target without confirm" \
  '{"dry_run":"1","target":"probe"}' \
  --dry-run 1 --target probe
assert_has 'physical target requires confirm=1'
assert_exit 2

# 5. Confirm gate honoured.
compare "physical target with confirm=1" \
  '{"dry_run":"1","target":"probe","confirm":"1"}' \
  --dry-run 1 --target probe --confirm 1
assert_claim_has '"status": "hardware_observed"'
assert_exit 0

# 6. No target given at all must mean virtual, not the editor's "auto" default —
#    otherwise an unqualified promote silently becomes a physical one and gates.
compare "no target defaults to virtual" \
  '{"dry_run":"1","flashed":"1","marker_matched":"1"}' \
  --dry-run 1 --flashed 1 --marker-matched 1
assert_claim_has '"status": "hardware_observed"'
assert_exit 0

# 7. Not a dry run and no elf: refuse before flashing.
compare "no elf, no dry run" \
  '{"target":"virtual"}' \
  --target virtual
assert_has 'elf path required'
assert_exit 2

# 8. Virtual flash is NEVER hardware evidence, however the flash went.
compare "virtual flash yields no hardware claim" \
  '{"target":"virtual","elf":"'"$TMP"'/missing.elf"}' \
  --target virtual --elf "$TMP/missing.elf"
assert_has 'flash does not yield hardware_observed'
assert_claim_has '"status": "failed"'
assert_claim_lacks '"status": "hardware_observed"'
assert_claim_lacks '"claim": "hardware_observed"'
assert_exit 1

# 9. Real nested serial-capture (fixture file stands in for the port). The marker
#    IS observed here and serial-capture says "hardware_observed" in its own
#    payload — the claim must still be failed, because the flash failed.
printf 'boot ok\nLABWIRED_OK\n' >"$TMP/uart.log"
compare "marker observed but flash failed" \
  '{"target":"probe","confirm":"1","elf":"'"$TMP"'/missing.elf","port":"'"$TMP"'/uart.log","timeout":"3"}' \
  --target probe --confirm 1 --elf "$TMP/missing.elf" --port "$TMP/uart.log" --timeout 3
assert_has '"matched":true'
assert_claim_has '"marker_matched": true'
assert_claim_has '"flashed": false'
assert_claim_has '"status": "failed"'
assert_exit 1

# 10. LABWIRED_FLASH_AUTO=1 overrides the confirm gate on both surfaces.
export LABWIRED_FLASH_AUTO=1
compare "LABWIRED_FLASH_AUTO=1 overrides confirm" \
  '{"dry_run":"1","target":"probe"}' \
  --dry-run 1 --target probe
assert_claim_has '"status": "hardware_observed"'
assert_exit 0
export LABWIRED_FLASH_AUTO=0

[[ "$fail" -eq 0 ]] || exit 1
echo "ok   promote has ONE engine (lib/promote.sh); hw_promote is only transport"
