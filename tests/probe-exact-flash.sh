#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/project"
printf '[env:release]\n' >"$TMP/project/platformio.ini"
printf 'exact-bin' >"$TMP/firmware.bin"
printf 'exact-elf' >"$TMP/firmware.elf"
sha_bin="$(shasum -a 256 "$TMP/firmware.bin" | awk '{print $1}')"
sha_elf="$(shasum -a 256 "$TMP/firmware.elf" | awk '{print $1}')"

cat >"$TMP/bin/pio" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$LABWIRED_TEST_LOG"
SH
cat >"$TMP/bin/probe-rs" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$LABWIRED_TEST_LOG"
SH
chmod +x "$TMP/bin/pio" "$TMP/bin/probe-rs"
export PATH="$TMP/bin:$PATH" LABWIRED_TEST_LOG="$TMP/call.log"
labwired_resolve_probe_rs() { printf '%s\n' "$TMP/bin/probe-rs"; }
labwired_resolve_sim() { return 1; }
source "$ROOT/lib/probe.sh"

out="$(labwired_probe_flash "$TMP/firmware.bin" --provider platformio --chip esp32c3 --target probe --probe probe-1 --port /dev/ttyACM0 --expected-sha256 "$sha_bin" --environment release --workspace "$TMP/project")"
grep -q '^LABWIRED_FLASH_RECEIPT ' <<<"$out"
diff -u <(printf '%s\n' run -e release -t nobuild -t upload --upload-port /dev/ttyACM0) "$TMP/call.log"
cmp "$TMP/firmware.bin" "$TMP/project/.pio/build/release/firmware.bin"

out="$(labwired_probe_flash "$TMP/firmware.elf" --provider probe-rs --chip STM32L476RGTx --target probe --probe 0483:374b:SERIAL --port /dev/ttyACM0 --expected-sha256 "$sha_elf" --environment release --workspace "$TMP/project")"
grep -q '^LABWIRED_FLASH_RECEIPT ' <<<"$out"
diff -u <(printf '%s\n' download --chip STM32L476RGTx --probe 0483:374b:SERIAL --binary-format elf "$TMP/firmware.elf") "$TMP/call.log"

if labwired_probe_flash "$TMP/firmware.bin" --provider wrong --chip esp32c3 --target probe --probe probe-1 --port /dev/ttyACM0 --expected-sha256 "$sha_bin" --environment release --workspace "$TMP/project" >/dev/null 2>&1; then exit 1; fi
if labwired_probe_flash "$TMP/firmware.bin" --provider platformio --chip esp32c3 --target probe --probe probe-1 --port /dev/ttyACM0 --expected-sha256 "${sha_bin%?}0" --environment release --workspace "$TMP/project" >/dev/null 2>&1; then exit 1; fi
if labwired_probe_flash "$TMP/firmware.elf" --provider platformio --chip esp32c3 --target probe --probe probe-1 --port /dev/ttyACM0 --expected-sha256 "$sha_elf" --environment release --workspace "$TMP/project" >/dev/null 2>&1; then exit 1; fi
printf 'WIFI_CONNECTED nonce={nonce} DEVICE_IP=127.0.0.1\n' >"$TMP/challenge.txt"
LABWIRED_SERIAL_CHALLENGE_FIXTURE="$TMP/challenge.txt" "$ROOT/bin/labwired-agent" serial-challenge /dev/ttyACM0 115200 0123456789abcdef0123456789abcdef WIFI_CONNECTED DEVICE_IP 1 | grep -q 'nonce=0123456789abcdef0123456789abcdef'
echo "probe exact flash contracts pass"
