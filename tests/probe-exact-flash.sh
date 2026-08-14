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
cat >"$TMP/bin/fake-powershell" <<'SH'
#!/usr/bin/env bash
printf '<%s>\n' "$@" >"$LABWIRED_TEST_LOG"
nonce="" marker="" key=""
while [[ $# -gt 0 ]]; do
  case "$1" in -Nonce) nonce="$2"; shift 2;; -Marker) marker="$2"; shift 2;; -AddressKey) key="$2"; shift 2;; *) shift;; esac
done
printf 'WRITE:%s\n' "$nonce" >>"$LABWIRED_TEST_LOG"
[[ "${LABWIRED_TEST_PS_RESULT:-pass}" == pass ]] || exit 1
printf '%s nonce=%s %s=127.0.0.1\n' "$marker" "$nonce" "$key"
SH
chmod +x "$TMP/bin/pio" "$TMP/bin/probe-rs"
chmod +x "$TMP/bin/fake-powershell"
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
LABWIRED_SERIAL_CHALLENGE_PLATFORM=win32 LABWIRED_SERIAL_CHALLENGE_POWERSHELL="$TMP/bin/fake-powershell" \
  "$ROOT/bin/labwired-agent" serial-challenge 'COM 7' 115200 0123456789abcdef0123456789abcdef WIFI_CONNECTED DEVICE_IP 2 | grep -q 'nonce=0123456789abcdef0123456789abcdef'
grep -q '^<-NoProfile>$' "$TMP/call.log"
grep -q '^<-File>$' "$TMP/call.log"
grep -q '^<COM 7>$' "$TMP/call.log"
grep -q '^<0123456789abcdef0123456789abcdef>$' "$TMP/call.log"
grep -q '^WRITE:0123456789abcdef0123456789abcdef$' "$TMP/call.log"
if LABWIRED_TEST_PS_RESULT=timeout LABWIRED_SERIAL_CHALLENGE_PLATFORM=win32 LABWIRED_SERIAL_CHALLENGE_POWERSHELL="$TMP/bin/fake-powershell" \
  "$ROOT/bin/labwired-agent" serial-challenge COM7 115200 0123456789abcdef0123456789abcdef WIFI_CONNECTED DEVICE_IP 1 >/dev/null 2>&1; then exit 1; fi
grep -q 'System.IO.Ports.SerialPort' "$ROOT/lib/serial-challenge.ps1"
grep -q '\$serial.Dispose()' "$ROOT/lib/serial-challenge.ps1"
grep -q '\$MaxBytes' "$ROOT/lib/serial-challenge.ps1"
grep -q '"serial-challenge" { Cmd-SerialChallenge }' "$ROOT/bin/labwired-agent.ps1"
if LC_ALL=C grep -n '[^ -~	]' "$ROOT/lib/serial-challenge.ps1" >/dev/null; then echo 'PowerShell helper must remain ASCII' >&2; exit 1; fi
echo "probe exact flash contracts pass"
