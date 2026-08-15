"""Bounded subprocess execution with persistent evidence."""

from datetime import datetime, timezone
import os
from pathlib import Path
import signal
import subprocess
import stat
import tempfile
import time
from typing import Mapping, Optional, Sequence, Union

from .results import CommandResult, PathLike


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _process_group_exists(process_group_id: int) -> bool:
    try:
        os.killpg(process_group_id, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _wait_for_process_group_exit(process_group_id: int, timeout_seconds: float) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while _process_group_exists(process_group_id):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        time.sleep(min(0.01, remaining))
    return True


def run_command(
    command: Sequence[Union[str, os.PathLike[str]]],
    *,
    cwd: PathLike,
    stdout_path: PathLike,
    stderr_path: PathLike,
    timeout_seconds: float,
    env: Optional[Mapping[str, str]] = None,
    redact_values: Sequence[Union[str, bytes]] = (),
) -> CommandResult:
    normalized_command = tuple(os.fspath(part) for part in command)
    normalized_cwd = str(Path(cwd).resolve())
    normalized_stdout = str(Path(stdout_path).resolve())
    normalized_stderr = str(Path(stderr_path).resolve())
    Path(normalized_stdout).parent.mkdir(parents=True, exist_ok=True)
    Path(normalized_stderr).parent.mkdir(parents=True, exist_ok=True)

    started_at = _utc_now()
    started_monotonic = time.monotonic()
    timed_out = False
    cleanup_error = None
    with open(normalized_stdout, "wb") as stdout, open(normalized_stderr, "wb") as stderr:
        process = subprocess.Popen(
            normalized_command,
            cwd=normalized_cwd,
            stdout=stdout,
            stderr=stderr,
            start_new_session=True,
            env=env,
        )
        try:
            process.communicate(timeout=timeout_seconds)
        except (KeyboardInterrupt, SystemExit) as interruption:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except (PermissionError, ProcessLookupError):
                pass
            try:
                process.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                pass
            if _process_group_exists(process.pid):
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except (PermissionError, ProcessLookupError):
                    pass
            try:
                process.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                pass
            _wait_for_process_group_exit(process.pid, 1.0)
            _redact_logs((normalized_stdout, normalized_stderr), redact_values)
            raise interruption
        except subprocess.TimeoutExpired:
            timed_out = True
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except (PermissionError, ProcessLookupError):
                pass
            if not _wait_for_process_group_exit(process.pid, 0.5):
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except (PermissionError, ProcessLookupError):
                    pass
            try:
                process.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except (PermissionError, ProcessLookupError):
                    pass
                try:
                    process.wait(timeout=0.5)
                except subprocess.TimeoutExpired:
                    cleanup_error = "process_group_did_not_exit"
            group_exited = _wait_for_process_group_exit(process.pid, 0.5)
            if not group_exited and cleanup_error is None:
                cleanup_error = "process_group_did_not_exit"
        else:
            if _process_group_exists(process.pid):
                cleanup_error = "unexpected_descendant_processes"
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except (PermissionError, ProcessLookupError):
                    pass
                if not _wait_for_process_group_exit(process.pid, 0.5):
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except (PermissionError, ProcessLookupError):
                        pass
                    if not _wait_for_process_group_exit(process.pid, 1.0):
                        cleanup_error = "process_group_did_not_exit"

    redaction_error = _redact_logs((normalized_stdout, normalized_stderr), redact_values)
    if redaction_error is not None and cleanup_error is None:
        cleanup_error = redaction_error
    ended_at = _utc_now()
    return CommandResult(
        command=normalized_command,
        cwd=normalized_cwd,
        returncode=process.returncode if process.returncode is not None else -signal.SIGKILL,
        timed_out=timed_out,
        started_at_utc=started_at,
        ended_at_utc=ended_at,
        duration_seconds=time.monotonic() - started_monotonic,
        stdout_path=normalized_stdout,
        stderr_path=normalized_stderr,
        cleanup_error=cleanup_error,
    )


def _redact_logs(paths: Sequence[str], values: Sequence[Union[str, bytes]]) -> Optional[str]:
    needles = tuple(value.encode() if isinstance(value, str) else value for value in values if value)
    if not needles:
        for path in paths:
            try:
                if os.lstat(path).st_size > 16 * 1024 * 1024:
                    temporary_fd, temporary = tempfile.mkstemp(prefix=".redacted-", dir=str(Path(path).parent))
                    try: os.write(temporary_fd, b"[EVIDENCE LOG TOO LARGE]\n"); os.fsync(temporary_fd)
                    finally: os.close(temporary_fd)
                    os.replace(temporary, path)
                    return "evidence_log_too_large"
            except FileNotFoundError: pass
        return None
    error = None
    for path in paths:
        temporary = None
        try:
            if os.lstat(path).st_size > 16 * 1024 * 1024:
                temporary_fd, temporary = tempfile.mkstemp(prefix=".redacted-", dir=str(Path(path).parent))
                try:
                    os.write(temporary_fd, b"[EVIDENCE LOG TOO LARGE]\n"); os.fsync(temporary_fd)
                finally: os.close(temporary_fd)
                os.replace(temporary, path); temporary = None
                error = "evidence_log_too_large"
                continue
            fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            temporary_fd, temporary = tempfile.mkstemp(prefix=".redacted-", dir=str(Path(path).parent))
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode):
                    raise OSError("evidence log is not a regular file")
                overlap = b""; maximum = max(map(len, needles))
                while chunk := os.read(fd, 1024 * 1024):
                    data = overlap + chunk
                    limit = max(0, len(data) - maximum + 1)
                    overlap = _write_redacted_prefix(temporary_fd, data, limit, needles)
                _write_redacted_prefix(temporary_fd, overlap, len(overlap), needles)
                os.fsync(temporary_fd)
            finally:
                os.close(fd)
                os.close(temporary_fd)
            os.replace(temporary, path); temporary = None
        except FileNotFoundError:
            pass
        finally:
            if temporary is not None:
                try: os.unlink(temporary)
                except FileNotFoundError: pass
    return error


def _write_redacted_prefix(output_fd: int, data: bytes, limit: int,
                           needles: Sequence[bytes]) -> bytes:
    cursor = 0
    while cursor < limit:
        matches = [(position, needle) for needle in needles
                   if (position := data.find(needle, cursor)) != -1 and position < limit]
        if not matches:
            os.write(output_fd, data[cursor:limit])
            cursor = limit
            break
        position, needle = min(matches, key=lambda item: item[0])
        os.write(output_fd, data[cursor:position])
        os.write(output_fd, b"[REDACTED]")
        cursor = position + len(needle)
    return data[max(cursor, limit):]
