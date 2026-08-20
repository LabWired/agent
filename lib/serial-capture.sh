#!/usr/bin/env bash
# serial-capture.sh — capture UART for N seconds looking for MARKER.
# shellcheck shell=bash
#
# Usage:
#   labwired_serial_capture <port> <baud> <marker> <timeout_seconds>
#
# Exit: 0 marker observed, 1 timeout / no match, 2 usage / open error.
#
# Backend: python3 + termios/select (no pyserial required).
# Fixture / dry-run modes (CI without hardware):
#   - port is a regular file → read that file as capture stream
#   - port is "-" → read stdin
#   - LABWIRED_SERIAL_FIXTURE=<path> → override port with fixture file
# On match, prints a small JSON result to stdout.

labwired_serial_capture() {
  local port="${1:-}"
  local baud="${2:-}"
  local marker="${3:-}"
  local timeout="${4:-}"
  shift 4 2>/dev/null || true
  # Optional: boot the target AFTER the port is open. A banner printed once at
  # startup is invisible otherwise — the flash stage resets, the board prints,
  # and only then does this capture open the port. Not an arbitrary command:
  # the only thing we will run is `probe-rs reset` for an explicit chip+probe.
  local reset_chip="" reset_probe=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --reset-chip) reset_chip="${2:-}"; shift 2 ;;
      --reset-probe) reset_probe="${2:-}"; shift 2 ;;
      *) echo "serial-capture: unknown option $1" >&2; return 2 ;;
    esac
  done

  if [[ -z "$port" || -z "$baud" || -z "$marker" || -z "$timeout" ]]; then
    echo "usage: labwired_serial_capture <port> <baud> <marker> <timeout_seconds>" >&2
    echo "  fixture: port may be a file path, or set LABWIRED_SERIAL_FIXTURE" >&2
    return 2
  fi

  if [[ -n "${LABWIRED_SERIAL_FIXTURE:-}" ]]; then
    port="$LABWIRED_SERIAL_FIXTURE"
  fi

  if ! command -v python3 >/dev/null 2>&1; then
    echo "serial-capture: python3 required" >&2
    return 2
  fi

  # Export for python child (avoid fragile shell quoting of marker)
  if [[ -n "$reset_chip" || -n "$reset_probe" ]]; then
    [[ -n "$reset_chip" && -n "$reset_probe" ]] \
      || { echo "serial-capture: --reset-chip and --reset-probe are required together" >&2; return 2; }
    local sc_prs=""
    if declare -F labwired_resolve_probe_rs >/dev/null 2>&1; then
      sc_prs="$(labwired_resolve_probe_rs 2>/dev/null || true)"
    fi
    [[ -n "$sc_prs" ]] || sc_prs="$(command -v probe-rs 2>/dev/null || true)"
    [[ -n "$sc_prs" ]] || { echo "serial-capture: probe-rs not found for --reset-chip" >&2; return 2; }
    export LABWIRED_SC_RESET_EXE="$sc_prs"
    export LABWIRED_SC_RESET_CHIP="$reset_chip"
    export LABWIRED_SC_RESET_PROBE="$reset_probe"
  else
    unset LABWIRED_SC_RESET_EXE LABWIRED_SC_RESET_CHIP LABWIRED_SC_RESET_PROBE
  fi

  export LABWIRED_SC_PORT="$port"
  export LABWIRED_SC_BAUD="$baud"
  export LABWIRED_SC_MARKER="$marker"
  export LABWIRED_SC_TIMEOUT="$timeout"

  set +e
  python3 - <<'PY'
import json
import os
import select
import sys
import time

port = os.environ["LABWIRED_SC_PORT"]
baud_s = os.environ["LABWIRED_SC_BAUD"]
marker = os.environ["LABWIRED_SC_MARKER"]
timeout_s = float(os.environ["LABWIRED_SC_TIMEOUT"])

try:
    baud = int(baud_s)
except ValueError:
    sys.stderr.write("serial-capture: baud must be integer\n")
    sys.exit(2)

if timeout_s < 0:
    sys.stderr.write("serial-capture: timeout must be >= 0\n")
    sys.exit(2)

# Map common baud rates for termios (when opening a real TTY)
BAUD_MAP = {}
try:
    import termios

    for name, val in (
        ("B9600", 9600),
        ("B19200", 19200),
        ("B38400", 38400),
        ("B57600", 57600),
        ("B115200", 115200),
        ("B230400", 230400),
        ("B460800", 460800),
        ("B921600", 921600),
    ):
        if hasattr(termios, name):
            BAUD_MAP[val] = getattr(termios, name)
except ImportError:
    termios = None  # type: ignore


def open_stream(path: str, baudrate: int):
    """Open serial TTY or fixture file. Returns (fd_or_file, is_tty, closer)."""
    if path == "-":
        return sys.stdin.buffer, False, (lambda: None)

    # Regular file or named pipe → fixture mode (no termios)
    if os.path.isfile(path) or (os.path.exists(path) and not _is_char_device(path)):
        f = open(path, "rb")
        return f, False, f.close

    # Character device (UART / USB-CDC). RDWR so we can toggle DTR/RTS for reset
    # (many native-USB chips need a pulse after flash or capture is empty).
    try:
        fd = os.open(path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    except OSError:
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOCTTY | os.O_NONBLOCK)
        except OSError as e:
            sys.stderr.write(f"serial-capture: open failed: {path}: {e}\n")
            sys.exit(2)

    if termios is not None:
        try:
            attrs = termios.tcgetattr(fd)
            # iflag, oflag, cflag, lflag, ispeed, ospeed, cc
            attrs[0] = 0  # iflag
            attrs[1] = 0  # oflag
            cflag = getattr(termios, "CS8", 0)
            if hasattr(termios, "CREAD"):
                cflag |= termios.CREAD
            if hasattr(termios, "CLOCAL"):
                cflag |= termios.CLOCAL
            # HUPCL can hang USB-CDC; leave default unless set
            attrs[2] = cflag
            attrs[3] = 0  # lflag raw
            speed = BAUD_MAP.get(baudrate)
            if speed is not None:
                attrs[4] = speed
                attrs[5] = speed
            # VMIN=0 VTIME=0 → non-blocking with select
            cc = list(attrs[6])
            if hasattr(termios, "VMIN"):
                cc[termios.VMIN] = 0
            if hasattr(termios, "VTIME"):
                cc[termios.VTIME] = 0
            attrs[6] = cc
            termios.tcsetattr(fd, termios.TCSANOW, attrs)
            try:
                termios.tcflush(fd, termios.TCIFLUSH)
            except termios.error:
                pass
            # Best-effort board reset via DTR/RTS (macOS TIOCM* when available)
            if os.environ.get("LABWIRED_SERIAL_NO_RESET", "") != "1":
                try:
                    import fcntl
                    import struct

                    TIOCMGET = getattr(termios, "TIOCMGET", 0x5415)
                    TIOCMSET = getattr(termios, "TIOCMSET", 0x5418)
                    TIOCM_DTR = 0x002
                    TIOCM_RTS = 0x004
                    status = struct.unpack(
                        "I", fcntl.ioctl(fd, TIOCMGET, struct.pack("I", 0))
                    )[0]
                    fcntl.ioctl(
                        fd,
                        TIOCMSET,
                        struct.pack("I", status | TIOCM_DTR | TIOCM_RTS),
                    )
                    time.sleep(0.05)
                    fcntl.ioctl(
                        fd,
                        TIOCMSET,
                        struct.pack("I", status & ~(TIOCM_DTR | TIOCM_RTS)),
                    )
                    time.sleep(0.25)
                except Exception:
                    pass
        except termios.error as e:
            sys.stderr.write(f"serial-capture: termios configure failed: {e}\n")
            # continue with best-effort read

    class FDFile:
        def __init__(self, fd):
            self.fd = fd

        def fileno(self):
            return self.fd

        def read(self, n):
            try:
                return os.read(self.fd, n)
            except BlockingIOError:
                return b""
            except OSError:
                return b""

    def closer():
        try:
            os.close(fd)
        except OSError:
            pass

    return FDFile(fd), True, closer


def _is_char_device(path: str) -> bool:
    try:
        st = os.stat(path)
        import stat as statmod

        return statmod.S_ISCHR(st.st_mode)
    except OSError:
        return False


stream, is_tty, closer = open_stream(port, baud)

# The port is open and flushed before the target is started, so a banner emitted
# once at boot lands in this buffer instead of being printed to nobody.
reset_exe = os.environ.get("LABWIRED_SC_RESET_EXE")
reset_error = None
if reset_exe:
    import subprocess
    try:
        completed = subprocess.run(
            [reset_exe, "reset",
             "--chip", os.environ["LABWIRED_SC_RESET_CHIP"],
             "--probe", os.environ["LABWIRED_SC_RESET_PROBE"]],
            capture_output=True, timeout=max(5.0, timeout_s),
        )
        if completed.returncode != 0:
            reset_error = (completed.stderr or b"").decode("utf-8", "replace").strip()[:200] or "reset failed"
    except Exception as error:  # never let a start failure masquerade as silence
        reset_error = f"{type(error).__name__}: {error}"[:200]

buf = bytearray()
matched = False
excerpt = ""
deadline = time.monotonic() + timeout_s
marker_b = marker.encode("utf-8", errors="replace")

try:
    # Zero timeout: one non-blocking pass (useful for fixtures that are already complete)
    while True:
        remaining = deadline - time.monotonic()
        if remaining < 0 and timeout_s > 0:
            break
        if timeout_s == 0 and len(buf) > 0 and not matched:
            # after first read cycle with timeout 0, stop
            pass

        try:
            r, _, _ = select.select([stream], [], [], max(0.0, min(0.2, remaining if timeout_s > 0 else 0.0)))
        except (ValueError, OSError):
            r = [stream]

        if r:
            chunk = stream.read(4096)
            if chunk:
                buf.extend(chunk)
                if marker_b in buf:
                    matched = True
                    # excerpt around marker
                    text = buf.decode("utf-8", errors="replace")
                    idx = text.find(marker)
                    start = max(0, idx - 40)
                    end = min(len(text), idx + len(marker) + 40)
                    excerpt = text[start:end]
                    break
            elif not is_tty:
                # EOF on fixture file
                break

        if timeout_s == 0:
            # single poll done
            if not r:
                # try one blocking-less read of full remaining file
                if not is_tty:
                    rest = stream.read()
                    if rest:
                        buf.extend(rest)
                        if marker_b in buf:
                            matched = True
                            text = buf.decode("utf-8", errors="replace")
                            idx = text.find(marker)
                            start = max(0, idx - 40)
                            end = min(len(text), idx + len(marker) + 40)
                            excerpt = text[start:end]
                break
            # if we got data but no marker and EOF next loop will break
            if not is_tty:
                continue
            break

        if remaining <= 0:
            break
finally:
    try:
        closer()
    except Exception:
        pass

text_all = buf.decode("utf-8", errors="replace")
if not excerpt and text_all:
    excerpt = text_all[-120:]

result = {
    "matched": matched,
    "marker": marker,
    "port": port,
    "baud": baud,
    "timeout_s": timeout_s,
    "bytes_captured": len(buf),
    "excerpt": excerpt,
    "status": "hardware_observed" if matched else "failed",
    "fixture": (not is_tty) or bool(os.environ.get("LABWIRED_SERIAL_FIXTURE")),
}
# A target we failed to start must never be reported as a target that said
# nothing: zero bytes then reads as broken firmware rather than a broken launch.
if reset_exe:
    result["started_target"] = reset_error is None
    if reset_error is not None:
        result["start_error"] = reset_error
        result["status"] = "blocked"

print(json.dumps(result, separators=(",", ":")))
sys.exit(0 if matched else 1)
PY
  rc=$?
  set -e
  unset LABWIRED_SC_PORT LABWIRED_SC_BAUD LABWIRED_SC_MARKER LABWIRED_SC_TIMEOUT
  return "$rc"
}

# Send a per-run challenge and capture the device's nonce/address response.
labwired_serial_challenge() {
  local port="${1:-}" baud="${2:-}" nonce="${3:-}" marker="${4:-}" address_key="${5:-}" timeout="${6:-8}"
  [[ -n "$port" && "$baud" =~ ^[0-9]+$ && "$nonce" =~ ^[0-9a-f]{32}$ && -n "$marker" && -n "$address_key" && "$timeout" =~ ^[0-9]+$ ]] || {
    echo "usage: labwired serial-challenge <port> <baud> <32-hex-nonce> <marker> <address-key> <timeout>" >&2; return 2;
  }
  local selected_platform="${LABWIRED_SERIAL_CHALLENGE_PLATFORM:-}"
  [[ -n "$selected_platform" ]] || { [[ "${OS:-}" == "Windows_NT" ]] && selected_platform="win32" || selected_platform="posix"; }
  if [[ "$selected_platform" == "win32" ]]; then
    local powershell="${LABWIRED_SERIAL_CHALLENGE_POWERSHELL:-powershell.exe}"
    local helper="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/serial-challenge.ps1"
    "$powershell" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$helper" \
      -Port "$port" -Baud "$baud" -Nonce "$nonce" -Marker "$marker" -AddressKey "$address_key" \
      -TimeoutSeconds "$timeout" -Terminator "${LABWIRED_SERIAL_CHALLENGE_TERMINATOR:-LF}" -MaxBytes 65536
    return $?
  fi
  [[ "$selected_platform" == "posix" ]] || { echo "serial-challenge: unsupported platform selector" >&2; return 3; }
  LABWIRED_SC_PORT="$port" LABWIRED_SC_BAUD="$baud" LABWIRED_SC_NONCE="$nonce" LABWIRED_SC_MARKER="$marker" LABWIRED_SC_ADDRESS="$address_key" LABWIRED_SC_TIMEOUT="$timeout" python3 - <<'PY'
import os, sys, time, select, termios
port=os.environ['LABWIRED_SC_PORT']; baud=int(os.environ['LABWIRED_SC_BAUD']); nonce=os.environ['LABWIRED_SC_NONCE']
marker=os.environ['LABWIRED_SC_MARKER']; address=os.environ['LABWIRED_SC_ADDRESS']; timeout=int(os.environ['LABWIRED_SC_TIMEOUT'])
fixture=os.environ.get('LABWIRED_SERIAL_CHALLENGE_FIXTURE')
if fixture:
    text=open(fixture, encoding='utf-8').read().replace('{nonce}', nonce)
    sys.stdout.write(text[:65536]); sys.exit(0 if marker in text and ('nonce='+nonce) in text and (address+'=') in text else 1)
speeds={9600:termios.B9600,19200:termios.B19200,38400:termios.B38400,57600:termios.B57600,115200:termios.B115200}
if baud not in speeds: sys.stderr.write('serial-challenge: unsupported baud\n'); sys.exit(2)
fd=None
try:
    fd=os.open(port, os.O_RDWR|os.O_NOCTTY|os.O_NONBLOCK)
    attrs=termios.tcgetattr(fd); attrs[0]=0; attrs[1]=0; attrs[2]=termios.CS8|termios.CREAD|termios.CLOCAL; attrs[3]=0
    attrs[4]=speeds[baud]; attrs[5]=speeds[baud]; termios.tcsetattr(fd, termios.TCSANOW, attrs)
    os.write(fd, (nonce+'\n').encode())
    end=time.monotonic()+timeout; data=bytearray()
    while time.monotonic()<end and len(data)<65536:
        ready,_,_=select.select([fd],[],[],min(.25,max(0,end-time.monotonic())))
        if ready:
            try: data.extend(os.read(fd,4096))
            except BlockingIOError: pass
            text=data.decode('utf-8','replace')
            if marker in text and ('nonce='+nonce) in text and (address+'=') in text: sys.stdout.write(text); sys.exit(0)
    sys.stdout.write(data.decode('utf-8','replace')); sys.stderr.write('serial-challenge: correlated response not observed\n'); sys.exit(1)
except OSError as error:
    sys.stderr.write('serial-challenge: '+str(error)+'\n'); sys.exit(1)
finally:
    if fd is not None: os.close(fd)
PY
}

if [[ "${BASH_SOURCE[0]:-}" == "${0}" ]]; then
  labwired_serial_capture "$@"
fi
