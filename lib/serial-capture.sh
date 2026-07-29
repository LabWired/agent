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

print(json.dumps(result, separators=(",", ":")))
sys.exit(0 if matched else 1)
PY
  rc=$?
  set -e
  unset LABWIRED_SC_PORT LABWIRED_SC_BAUD LABWIRED_SC_MARKER LABWIRED_SC_TIMEOUT
  return "$rc"
}

if [[ "${BASH_SOURCE[0]:-}" == "${0}" ]]; then
  labwired_serial_capture "$@"
fi
