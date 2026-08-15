"""Offline-testable ESP32-S3 HIL evidence collection primitives."""

from dataclasses import dataclass
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import select
import termios
import time
import tty
from typing import Callable, Mapping, Optional, Sequence

from .process import run_command
from .results import CommandResult, PathLike


_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_SERIAL = re.compile(r"^[A-Za-z0-9_.:/+-]+$")
_MARKER = re.compile(r"^@@REG ([A-Za-z_][A-Za-z0-9_]*) (0x[0-9A-Fa-f]{8})$")
_VALUE = re.compile(r"^(0x[0-9A-Fa-f]{8}): (0x[0-9A-Fa-f]{8})$")


def _uint32(value: object, field: str) -> int:
    if isinstance(value, bool):
        raise TypeError(f"{field} must be an integer or hexadecimal string")
    if isinstance(value, str):
        if re.fullmatch(r"0x[0-9A-Fa-f]+", value) is None:
            raise ValueError(f"invalid hexadecimal {field}")
        parsed = int(value, 16)
    elif isinstance(value, int):
        parsed = value
    else:
        raise TypeError(f"{field} must be an integer or hexadecimal string")
    if parsed < 0 or parsed > 0xFFFFFFFF:
        raise ValueError(f"{field} is outside uint32 bounds")
    return parsed


@dataclass(frozen=True)
class RegisterAssertion:
    name: str
    address: int
    mask: int
    expected: int

    def __post_init__(self) -> None:
        if not _NAME.fullmatch(self.name):
            raise ValueError("register assertion name is unsafe")
        for field in ("address", "mask", "expected"):
            value = getattr(self, field)
            if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 0xFFFFFFFF:
                raise ValueError(f"{field} is outside uint32 bounds")
        if self.address % 4:
            raise ValueError("register address must be 32-bit aligned")
        if self.expected & ~self.mask:
            raise ValueError("expected value contains bits outside mask")

    @classmethod
    def from_json(cls, record: Mapping[str, object]) -> "RegisterAssertion":
        name = record.get("name")
        if not isinstance(name, str):
            raise TypeError("register assertion name must be a string")
        return cls(name, _uint32(record.get("address"), "address"),
                   _uint32(record.get("mask"), "mask"),
                   _uint32(record.get("expected"), "expected"))


@dataclass(frozen=True)
class Esp32S3Config:
    uart_device: str
    uart_baud: int
    uart_timeout_seconds: float
    jtag_serial: str
    openocd_config: str
    assertions: tuple[RegisterAssertion, ...]

    @classmethod
    def from_oracle(cls, oracle: Mapping[str, object]) -> "Esp32S3Config":
        uart = oracle.get("uart")
        jtag = oracle.get("jtag", oracle.get("openocd"))
        records = oracle.get("register_assertions")
        if not isinstance(uart, Mapping) or not isinstance(jtag, Mapping) or not isinstance(records, list):
            raise TypeError("oracle uart, jtag/openocd, and register_assertions are required")
        assertions = tuple(RegisterAssertion.from_json(record) for record in records)
        if not assertions:
            raise ValueError("at least one register assertion is required")
        names = [item.name for item in assertions]
        addresses = [item.address for item in assertions]
        if len(names) != len(set(names)) or len(addresses) != len(set(addresses)):
            raise ValueError("register assertion names and addresses must be unique")
        baud = _positive_int(uart.get("baud"), "uart baud")
        timeout = _positive_float(uart.get("timeout_seconds"), "uart timeout")
        device = uart.get("device", "")
        serial = jtag.get("serial", "")
        config = jtag.get("config", jtag.get("board_config", ""))
        if not all(isinstance(value, str) for value in (device, serial, config)):
            raise TypeError("device, serial, and config must be strings")
        if not device or not serial or not config:
            raise ValueError("device, serial, and config must not be empty")
        return cls(device, baud, timeout, serial, config, assertions)


def _positive_int(value: object, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{field} must be positive")
    return value


def _positive_float(value: object, field: str) -> float:
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not math.isfinite(value) or value <= 0):
        raise ValueError(f"{field} must be positive")
    return float(value)


class BoardLockTimeout(TimeoutError):
    pass


class BoardLock:
    def __init__(self, directory: PathLike, identity: str, *, timeout_seconds: float,
                 poll_interval_seconds: float = 0.01) -> None:
        if (not identity or not math.isfinite(timeout_seconds) or timeout_seconds < 0
                or not math.isfinite(poll_interval_seconds) or poll_interval_seconds <= 0):
            raise ValueError("invalid board lock parameters")
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", identity)[:48] or "board"
        digest = hashlib.sha256(identity.encode()).hexdigest()[:12]
        self.path = Path(directory) / f"{safe}-{digest}.lock"
        self.identity = identity
        self.timeout_seconds = timeout_seconds
        self.poll_interval_seconds = poll_interval_seconds
        self._file = None

    def acquire(self) -> "BoardLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        held = open(self.path, "a+", encoding="utf-8")
        deadline = time.monotonic() + self.timeout_seconds
        while True:
            try:
                fcntl.flock(held.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    held.close()
                    raise BoardLockTimeout(f"board {self.identity!r} is locked")
                time.sleep(min(self.poll_interval_seconds, remaining))
        self._file = held
        try:
            held.seek(0)
            held.truncate()
            json.dump({"identity": self.identity, "pid": os.getpid(), "acquired_monotonic": time.monotonic()}, held)
            held.flush()
            os.fsync(held.fileno())
        except BaseException:
            self.release()
            raise
        return self

    def release(self) -> None:
        if self._file is not None:
            held, self._file = self._file, None
            try:
                fcntl.flock(held.fileno(), fcntl.LOCK_UN)
            finally:
                held.close()

    def __enter__(self) -> "BoardLock":
        return self.acquire()

    def __exit__(self, exc_type, exc, traceback) -> None:
        self.release()


@dataclass(frozen=True)
class PhaseResult:
    status: str
    category: Optional[str] = None
    detail: Optional[str] = None
    command_result: Optional[CommandResult] = None


Runner = Callable[..., CommandResult]


def validate_identity(command: Sequence[os.PathLike[str] | str], expected_serial: str, *,
                      cwd: PathLike, evidence_dir: PathLike, timeout_seconds: float,
                      runner: Runner = run_command) -> PhaseResult:
    evidence = Path(evidence_dir)
    try:
        result = runner(command, cwd=cwd, stdout_path=evidence / "identity.stdout.log",
                        stderr_path=evidence / "identity.stderr.log", timeout_seconds=timeout_seconds)
    except OSError as error:
        return PhaseResult("infrastructure_error", "board_identity", str(error))
    if result.cleanup_error or result.timed_out or result.returncode != 0:
        return PhaseResult("infrastructure_error", "board_identity", "identity command failed", result)
    try:
        lines = [line.strip() for line in Path(result.stdout_path).read_text(encoding="utf-8").splitlines()
                 if line.strip()]
    except OSError as error:
        return PhaseResult("infrastructure_error", "board_identity", str(error), result)
    if lines != [expected_serial]:
        return PhaseResult("infrastructure_error", "board_identity",
                           f"expected exactly [{expected_serial!r}], observed {lines!r}", result)
    return PhaseResult("pass", command_result=result)


def flash_firmware(command: Sequence[os.PathLike[str] | str], *, cwd: PathLike,
                   evidence_dir: PathLike, timeout_seconds: float, identity_validated: bool,
                   runner: Runner = run_command) -> PhaseResult:
    if not identity_validated:
        raise ValueError("board identity must be validated before flashing")
    evidence = Path(evidence_dir)
    try:
        result = runner(command, cwd=cwd, stdout_path=evidence / "flash.stdout.log",
                        stderr_path=evidence / "flash.stderr.log", timeout_seconds=timeout_seconds)
    except OSError as error:
        return PhaseResult("infrastructure_error", "flash_infrastructure", str(error))
    if result.cleanup_error or result.timed_out:
        return PhaseResult("infrastructure_error", "flash_infrastructure", "flash did not exit cleanly", result)
    if result.returncode:
        return PhaseResult("hardware_fail", "flash", "candidate firmware flash failed", result)
    return PhaseResult("pass", command_result=result)


@dataclass(frozen=True)
class UartResult:
    matched: bool
    bytes_captured: int
    timed_out: bool


def capture_uart_nonce(device: PathLike, baud: int, nonce: str, timeout_seconds: float,
                       log: PathLike, *, max_bytes: int = 65536) -> UartResult:
    fd = os.open(device, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    try:
        speeds = {9600: termios.B9600, 115200: termios.B115200}
        if baud not in speeds:
            raise ValueError(f"unsupported UART baud: {baud}")
        if not math.isfinite(timeout_seconds) or timeout_seconds < 0 or max_bytes <= 0:
            raise ValueError("invalid UART bounds")
        attrs = termios.tcgetattr(fd)
        tty.setraw(fd, termios.TCSANOW)
        attrs = termios.tcgetattr(fd)
        attrs[4] = attrs[5] = speeds[baud]
        attrs[2] = (attrs[2] & ~(termios.CSIZE | termios.PARENB | termios.CSTOPB)) | termios.CS8 | termios.CLOCAL | termios.CREAD
        termios.tcsetattr(fd, termios.TCSANOW, attrs)
        deadline = time.monotonic() + timeout_seconds
        captured = bytearray()
        pending = bytearray()
        matched = False
        expected = f"LABWIRED_READY:{nonce}".encode()
        while not matched and len(captured) < max_bytes:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            readable, _, _ = select.select([fd], [], [], remaining)
            if not readable:
                break
            try:
                chunk = os.read(fd, min(4096, max_bytes - len(captured)))
            except BlockingIOError:
                continue
            if not chunk:
                continue
            captured.extend(chunk)
            pending.extend(chunk)
            while b"\n" in pending:
                line, _, remainder = pending.partition(b"\n")
                pending = bytearray(remainder)
                if line.endswith(b"\r"):
                    line = line[:-1]
                if line == expected:
                    matched = True
                    break
        Path(log).parent.mkdir(parents=True, exist_ok=True)
        Path(log).write_bytes(captured)
        return UartResult(matched, len(captured), not matched)
    finally:
        os.close(fd)


def build_openocd_command(executable: str, config: str, adapter_serial: str,
                          assertions: Sequence[RegisterAssertion]) -> list[str]:
    if not _SERIAL.fullmatch(adapter_serial):
        raise ValueError("unsafe adapter serial")
    if any(character in config for character in "\r\n\x00"):
        raise ValueError("unsafe OpenOCD config")
    commands = [f"adapter serial {adapter_serial}", "adapter speed 4000", "init", "reset run",
                "sleep 750", "halt"]
    for assertion in assertions:
        commands.extend((f"echo @@REG {assertion.name} 0x{assertion.address:08x}",
                         f"mdw 0x{assertion.address:08x}"))
    commands.append("exit")
    return [executable, "-f", config, "-c", "; ".join(commands)]


def parse_openocd_registers(text: str, requested: Sequence[RegisterAssertion]) -> dict[str, int]:
    by_name = {item.name: item for item in requested}
    if len(by_name) != len(requested):
        raise ValueError("requested assertion names are not unique")
    observed: dict[str, int] = {}
    lines = text.splitlines()
    index = 0
    while index < len(lines):
        stripped = lines[index].strip()
        marker = _MARKER.fullmatch(stripped)
        if marker is None:
            if (stripped.startswith("@@REG") or _VALUE.fullmatch(stripped)
                    or stripped.lower().startswith("error:")):
                raise ValueError("unpaired or malformed register observation")
            index += 1
            continue
        name, address_text = marker.groups()
        assertion = by_name.get(name)
        if assertion is None or name in observed or int(address_text, 16) != assertion.address:
            raise ValueError("invalid or duplicate register marker")
        if index + 1 >= len(lines):
            raise ValueError("register marker has no observation")
        value_line = _VALUE.fullmatch(lines[index + 1].strip())
        if value_line is None or int(value_line.group(1), 16) != assertion.address:
            raise ValueError("register observation is malformed or has wrong address")
        observed[name] = int(value_line.group(2), 16)
        index += 2
    if set(observed) != set(by_name):
        raise ValueError("missing requested register observations")
    return observed


@dataclass(frozen=True)
class RegisterObservation:
    name: str
    address: int
    value: int
    mask: int
    expected: int
    passed: bool


@dataclass(frozen=True)
class RegisterEvaluation:
    status: str
    observations: tuple[RegisterObservation, ...]


def evaluate_registers(observed: Mapping[str, int], assertions: Sequence[RegisterAssertion]) -> RegisterEvaluation:
    if set(observed) != {item.name for item in assertions}:
        raise ValueError("observed registers do not exactly match assertions")
    results = tuple(RegisterObservation(item.name, item.address, observed[item.name], item.mask,
                                        item.expected, (observed[item.name] & item.mask) == item.expected)
                    for item in assertions)
    return RegisterEvaluation("pass" if all(item.passed for item in results) else "hardware_fail", results)
