#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/project/.pio/build/env-one" "$TMP/desk/build dir"
printf '[env:env-one]\n' >"$TMP/project/platformio.ini"
printf firmware >"$TMP/desk/build dir/firm ware.elf"

cat >"$TMP/bin/labwired-agent" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\0' "$@" >>"$LEGACY_ARGV"
printf '\n' >>"$LEGACY_ARGV"
if [[ "$1 $2" == 'hardware plan' ]]; then
  while (($#)); do
    [[ "$1" == --profile ]] && { cp "$2" "$LEGACY_PROFILE"; break; }
    shift
  done
  if [[ "${LEGACY_PLAN_BLOCK:-0}" == 1 ]]; then
    printf '%s\n' "$2" >"$LEGACY_BLOCK_PROFILE"
    sleep 30
  fi
  printf '{"command":"hardware plan","digest":"%064d","plan":{"ok":true}}\n' 0
  exit "${LEGACY_PLAN_EXIT:-0}"
fi
exit "${LEGACY_RUN_EXIT:-0}"
SH
chmod +x "$TMP/bin/labwired-agent"

assert_profile() {
  python3 - "$1" "$2" "$3" "$4" "$5" <<'PY'
import json,sys
p=json.load(open(sys.argv[1]))
kind,workspace,chip,marker=sys.argv[2:]
assert p["schema"] == 1 and p["target"]["chip"] == chip, p
assert p["build"]["workspace"] == ".", p
assert p["observations"][0].get("contains") == marker, p
if kind == "dev":
    assert p["build"]["provider"] == "platformio"
    assert p["build"]["environment"] == "env-one"
    assert p["build"]["artifact"] == ".pio/build/env-one/firmware.bin"
else:
    assert p["build"]["provider"] == "cmake"
    assert p["build"]["artifact"] == "firm ware.elf"
PY
}

export LABWIRED="$TMP/bin/labwired-agent" LEGACY_ARGV="$TMP/argv" LEGACY_PROFILE="$TMP/profile.json"
# shellcheck disable=SC2016 # Literal command substitutions are injection fixtures.
export LABWIRED_HW_WS="$TMP/project" LABWIRED_HW_ENV='env-one' LABWIRED_HW_CHIP='chip with punctuation;$(touch nope)'
# shellcheck disable=SC2016
export LABWIRED_HW_PORT='/dev/tty weird;$(touch nope)' LABWIRED_HW_PROBE_SERIAL='probe ; $(touch nope)'
# shellcheck disable=SC2016
export LABWIRED_HW_MARKER='READY "quoted" ; $(touch nope)' LABWIRED_HW_SKIP_FLASH=1 LABWIRED_HW_SKIP_TWIN=1
DIGEST_ZERO="$(printf '%064d' 0)"
DIGEST_A="$(printf 'a%.0s' {1..64})"
export LABWIRED_HW_OUT="$TMP/out with spaces" LABWIRED_HW_CONFIRM="$DIGEST_ZERO"
bash "$ROOT/scripts/dev-cycle.sh"
assert_profile "$LEGACY_PROFILE" dev "$TMP/project" "$LABWIRED_HW_CHIP" "$LABWIRED_HW_MARKER"
[[ ! -e "$TMP/project/nope" && ! -e "$TMP/nope" ]]
python3 - "$LEGACY_ARGV" "$LABWIRED_HW_CONFIRM" <<'PY'
import sys
calls=[[a for a in x.split('\0') if a] for x in open(sys.argv[1]).read().splitlines()]
assert calls[0][0:2] == ['hardware','plan']
assert calls[1][0:2] == ['hardware','run']
assert calls[1][-2:] == ['--confirm',sys.argv[2]]
PY
[[ ! -e "$LEGACY_PROFILE" || -s "$LEGACY_PROFILE" ]] # fake CLI copy survives; wrapper temp does not

: >"$LEGACY_ARGV"
export LABWIRED_HW_ELF="$TMP/desk/build dir/firm ware.elf" LABWIRED_HW_CHIP='esp test' LABWIRED_HW_PORT='/dev/tty test'
export LABWIRED_HW_PROBE_SERIAL='probe test' LABWIRED_HW_MARKER='DESK READY'
export LABWIRED_HW_OUT="$TMP/desk evidence" LABWIRED_HW_CONFIRM="$DIGEST_ZERO"
unset LABWIRED_HW_FORCE_NEED_PROBE
bash "$ROOT/scripts/desk-hw-physical.sh"
assert_profile "$LEGACY_PROFILE" desk "$TMP/desk" "$LABWIRED_HW_CHIP" "$LABWIRED_HW_MARKER"

# Missing or wrong confirmation cannot reach hardware run.
: >"$LEGACY_ARGV"; unset LABWIRED_HW_CONFIRM
set +e
bash "$ROOT/scripts/desk-hw-physical.sh" >"$TMP/missing.out" 2>&1; rc=$?
set -e
[[ "$rc" -eq 2 ]]
[[ "$(tr '\0' ' ' <"$LEGACY_ARGV" | grep -c 'hardware run' || true)" -eq 0 ]]
grep -qi 'confirm' "$TMP/missing.out"
export LABWIRED_HW_CONFIRM="$DIGEST_A"
set +e; bash "$ROOT/scripts/desk-hw-physical.sh" >/dev/null 2>&1; rc=$?; set -e
[[ "$rc" -eq 2 ]]

export LABWIRED_HW_FORCE_NEED_PROBE=1
set +e
bash "$ROOT/scripts/desk-hw-physical.sh" >/dev/null 2>"$TMP/probe.err"; rc=$?
set -e
[[ "$rc" -eq 2 ]] && grep -q NEED_PROBE "$TMP/probe.err"

# Public CLI failures preserve their documented meanings.
unset LABWIRED_HW_FORCE_NEED_PROBE
export LABWIRED_HW_CONFIRM="$DIGEST_ZERO" LEGACY_RUN_EXIT=1
set +e; bash "$ROOT/scripts/desk-hw-physical.sh" >/dev/null 2>&1; rc=$?; set -e
[[ "$rc" -eq 1 ]]

# Termination cleans the generated profile and never advances to run.
unset LEGACY_RUN_EXIT
export LABWIRED_HW_WS="$TMP/project" LABWIRED_HW_SKIP_FLASH=1 LABWIRED_HW_SKIP_TWIN=1
export LABWIRED_HW_CONFIRM="$DIGEST_ZERO" LEGACY_PLAN_BLOCK=1 LEGACY_BLOCK_PROFILE="$TMP/block-profile"
: >"$LEGACY_ARGV"
bash "$ROOT/scripts/dev-cycle.sh" >"$TMP/block.out" 2>&1 & wrapper_pid=$!
for _ in {1..100}; do [[ -s "$LEGACY_BLOCK_PROFILE" ]] && break; sleep 0.02; done
[[ -s "$LEGACY_BLOCK_PROFILE" ]]
generated_profile="$(cat "$LEGACY_BLOCK_PROFILE")"
[[ -f "$generated_profile" ]]
kill -TERM "$wrapper_pid"
set +e; wait "$wrapper_pid"; rc=$?; set -e
[[ "$rc" -eq 143 && ! -e "$generated_profile" ]]
[[ "$(tr '\0' ' ' <"$LEGACY_ARGV" | grep -c 'hardware run' || true)" -eq 0 ]]
unset LEGACY_PLAN_BLOCK

# Compatibility scripts contain no second orchestration engine.
if rg -n 'pio[[:space:]]+run|labwired_serial_capture|probe[[:space:]]+flash|labwired.*test.*--script' \
  "$ROOT/scripts/dev-cycle.sh" "$ROOT/scripts/desk-hw-physical.sh"; then
  echo 'legacy wrapper still directly orchestrates hardware' >&2; exit 1
fi
grep -q 'exec .*scripts/dev-cycle.sh' "$ROOT/scripts/profiles/esp32c3-serial.sh"

echo 'hardware-legacy-compat: PASS'
